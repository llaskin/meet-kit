// The setup wizard's steps, mirroring DEPLOY-AGENT.md steps 1-10. Status is
// derived from the files the wizard edits (wrangler.jsonc, meet.config.json)
// plus .setup-state.json, which holds only non-secret facts: chosen account,
// deployed URL, Gmail vs Workspace, live-check results and ticked manual steps.
// Every action re-reads both on entry, so closing the page and coming back
// (or editing a file by hand) never leaves the wizard believing stale state.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REQUIRED_TABLES, isEmail, isHttpsUrlOrEmpty, isHexColor, isGoogleClientId, isTurnstileSiteKey,
  normalizeTeamDomain, isAud, parseTestSummary,
} from './checks.mjs'
import { readString, setString, updateMeetConfig } from './config-files.mjs'
import { createWrangler } from './wrangler.mjs'

export const STEPS = Object.freeze([
  { id: 'login', title: 'Cloudflare login' },
  { id: 'profile', title: 'About you' },
  { id: 'database', title: 'Database' },
  { id: 'deploy', title: 'First deploy' },
  { id: 'google', title: 'Google Cloud' },
  { id: 'turnstile', title: 'Turnstile' },
  { id: 'access', title: 'Cloudflare Access' },
  { id: 'lock', title: 'Redeploy and lock check' },
  { id: 'calendar', title: 'Calendar and hours' },
  { id: 'e2e', title: 'Test booking' },
])

const PLACEHOLDER_DB = 'REPLACE_WITH_D1_ID'
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const ADMIN_PROBES = ['/admin/', '/api/admin/config', '/%61dmin/', '//admin/']
const PROBE_TRIES = 10
const PROBE_WAIT_MS = 3000

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const tail = (s, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s)

/** Runs this repo's test suite the way `npm test` does, without a shell. */
export function runRepoTests(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', 'tests/**/*.test.js'], { cwd: root, windowsHide: true })
    let output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('error', (err) => resolve({ ok: false, summary: null, output: err.message }))
    child.on('close', (code) => {
      const summary = parseTestSummary(output)
      resolve({ ok: code === 0 && summary?.fail === 0, summary, output })
    })
  })
}

export function createSetup({ root, run, fetch = globalThis.fetch, runTests = () => runRepoTests(root), sleep }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const statePath = join(root, '.setup-state.json')
  const wranglerPath = join(root, 'wrangler.jsonc')
  const meetPath = join(root, 'meet.config.json')
  let pendingAccounts = null

  function readState() {
    let s = {}
    try {
      s = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {}
    if (!s || typeof s !== 'object') s = {}
    s.checks = s.checks && typeof s.checks === 'object' ? s.checks : {}
    s.manual = s.manual && typeof s.manual === 'object' ? s.manual : {}
    return s
  }
  const writeState = (s) => writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`)
  const readWrangler = () => readFileSync(wranglerPath, 'utf8')

  // Any change to config after the lock check needs a redeploy to take effect.
  function saveConfig(edits, stateEdit) {
    let w = readWrangler()
    for (const [k, v] of Object.entries(edits)) w = setString(w, k, v)
    writeFileSync(wranglerPath, w)
    const s = readState()
    delete s.checks.lock
    stateEdit?.(s)
    writeState(s)
  }

  const wrangler = createWrangler({ run, accountId: () => readState().accountId || '' })

  function snapshot() {
    const s = readState()
    const w = readWrangler()
    const v = (k) => readString(w, k) || ''
    const dbId = v('database_id')
    const done = {
      login: Boolean(s.accountId),
      profile: Boolean(v('OWNER_EMAIL')) && ['gmail', 'workspace'].includes(s.accountType),
      database: Boolean(dbId) && dbId !== PLACEHOLDER_DB && s.checks.database === true,
      deploy: Boolean(s.url) && s.checks.deploy === true,
      google: Boolean(v('GOOGLE_CLIENT_ID')) && s.checks.google === true,
      turnstile: Boolean(v('TURNSTILE_SITE_KEY')) && s.checks.turnstile === true,
      access: Boolean(v('ACCESS_TEAM_DOMAIN')) && Boolean(v('ACCESS_AUD')) && s.checks.access === true,
      lock: s.checks.lock === true,
      calendar: s.manual.calendar === true,
      e2e: s.manual.e2e === true,
    }
    return { s, v, done }
  }

  function status() {
    const { s, v, done } = snapshot()
    let open = true
    const steps = STEPS.map(({ id, title }) => {
      const state = !open ? 'blocked' : done[id] ? 'done' : 'todo'
      if (!done[id]) open = false
      return { id, title, state }
    })
    let profile = {}
    try {
      profile = JSON.parse(readFileSync(meetPath, 'utf8'))
    } catch {}
    const url = s.url || ''
    return {
      steps,
      info: {
        email: s.email || '',
        accountId: s.accountId || '',
        accountName: s.accountName || '',
        accounts: pendingAccounts,
        accountType: s.accountType || '',
        ownerEmail: v('OWNER_EMAIL'),
        profile,
        url,
        host: url ? new URL(url).host : '',
        redirectUri: url ? `${url}/admin/oauth/google/callback` : '',
        googleClientId: v('GOOGLE_CLIENT_ID'),
        turnstileSiteKey: v('TURNSTILE_SITE_KEY'),
        teamDomain: v('ACCESS_TEAM_DOMAIN'),
        aud: v('ACCESS_AUD'),
      },
    }
  }

  // Steps run in order: an action is refused until every earlier step is done.
  function blockedBy(id) {
    const { done } = snapshot()
    for (const step of STEPS) {
      if (step.id === id) return null
      if (!done[step.id]) return { ok: false, message: `Finish "${step.title}" first.` }
    }
    return { ok: false, message: `Unknown step ${id}.` }
  }

  async function probe(path) {
    const url = `${readState().url}${path}`
    try {
      const res = await fetch(url, { redirect: 'manual' })
      return { status: res.status, location: res.headers.get('location') || '' }
    } catch (err) {
      return { status: 0, location: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function deployNow() {
    const d = await wrangler.deploy()
    if (d.ok && d.url) return { ok: true, url: d.url }
    if (d.onboarding) {
      return {
        ok: false,
        link: d.onboarding,
        message: 'Cloudflare needs a workers.dev subdomain for your account first. Open the link, choose a subdomain, then press the button again.',
      }
    }
    return { ok: false, message: d.ok ? 'Deployed, but wrangler printed no workers.dev URL.' : 'Deploy failed.', output: tail(d.output) }
  }

  async function login() {
    const s = readState()
    delete s.accountId
    delete s.accountName
    writeState(s)
    let who = await wrangler.whoami()
    if (!who.loggedIn) {
      const l = await wrangler.login()
      who = await wrangler.whoami()
      if (!who.loggedIn) {
        return { ok: false, message: 'Cloudflare login did not finish. Approve it in the browser tab that opened, then try again.', output: tail(l.output) }
      }
    }
    const next = readState()
    next.email = who.email
    if (who.accounts.length === 0) {
      writeState(next)
      return { ok: false, message: 'This Cloudflare login has no accounts. Sign up or ask to be added to one, then try again.' }
    }
    if (who.accounts.length > 1) {
      pendingAccounts = who.accounts
      writeState(next)
      return { ok: true, chooseAccount: who.accounts, message: 'Pick the Cloudflare account to use.' }
    }
    next.accountId = who.accounts[0].id
    next.accountName = who.accounts[0].name
    writeState(next)
    pendingAccounts = null
    return { ok: true, message: `Logged in as ${who.email}, account ${who.accounts[0].name}.` }
  }

  async function chooseAccount(input) {
    const who = await wrangler.whoami()
    const account = who.accounts.find((a) => a.id === str(input?.accountId))
    if (!account) return { ok: false, message: 'That account is not on this Cloudflare login.' }
    const s = readState()
    s.accountId = account.id
    s.accountName = account.name
    writeState(s)
    pendingAccounts = null
    return { ok: true, message: `Using account ${account.name}.` }
  }

  async function saveProfile(input) {
    const blocked = blockedBy('profile')
    if (blocked) return blocked
    const f = {
      ownerEmail: str(input?.ownerEmail), accountType: str(input?.accountType),
      displayName: str(input?.displayName), pageTitle: str(input?.pageTitle), pageSubtitle: str(input?.pageSubtitle),
      eventTitle: str(input?.eventTitle), privacyUrl: str(input?.privacyUrl), termsUrl: str(input?.termsUrl),
      accentColor: str(input?.accentColor),
    }
    const errors = {}
    if (!isEmail(f.ownerEmail)) errors.ownerEmail = 'Enter the email you will sign in to admin with.'
    if (!['gmail', 'workspace'].includes(f.accountType)) errors.accountType = 'Choose Gmail or Google Workspace.'
    const len = (k, max, required) => {
      if (required && !f[k]) errors[k] = 'Required.'
      else if (f[k].length > max) errors[k] = `At most ${max} characters.`
    }
    len('displayName', 80, true)
    len('pageTitle', 80, true)
    len('pageSubtitle', 200, false)
    len('eventTitle', 120, true)
    if (!isHttpsUrlOrEmpty(f.privacyUrl)) errors.privacyUrl = 'Must start with https:// (or leave empty).'
    if (!isHttpsUrlOrEmpty(f.termsUrl)) errors.termsUrl = 'Must start with https:// (or leave empty).'
    if (!isHexColor(f.accentColor)) errors.accentColor = 'A colour like #0b6cff.'
    if (Object.keys(errors).length) return { ok: false, errors, message: 'Fix the highlighted fields.' }

    writeFileSync(meetPath, updateMeetConfig(readFileSync(meetPath, 'utf8'), f))
    saveConfig({ OWNER_EMAIL: f.ownerEmail }, (s) => { s.accountType = f.accountType })
    return { ok: true, message: 'Saved.' }
  }

  async function setupDatabase() {
    const blocked = blockedBy('database')
    if (blocked) return blocked
    let list = await wrangler.d1List()
    if (!list.ok) return { ok: false, message: 'Could not list your D1 databases.', output: tail(list.output) }
    const reused = Boolean(list.id)
    if (!list.id) {
      const c = await wrangler.d1Create()
      if (!c.ok) return { ok: false, message: 'Could not create the database.', output: tail(c.output) }
      list = await wrangler.d1List()
      if (!list.id) return { ok: false, message: 'Created the database but could not find it afterwards. Press the button again.' }
    }
    saveConfig({ database_id: list.id }, (s) => { delete s.checks.database })
    const applied = await wrangler.applySchema()
    if (!applied.ok) return { ok: false, message: 'Could not create the tables.', output: tail(applied.output) }
    const t = await wrangler.tables()
    const missing = REQUIRED_TABLES.filter((n) => !t.names.includes(n))
    if (!t.ok || missing.length) {
      return { ok: false, message: `Tables missing after applying the schema: ${missing.join(', ') || 'could not list tables'}.`, output: tail(t.output) }
    }
    const s = readState()
    s.checks.database = true
    writeState(s)
    // Say so when an existing database was picked up: on an account that already
    // runs meet-kit, this deploy now shares that database (and its bookings).
    const note = reused ? ' This reused the meet-kit database already in this Cloudflare account.' : ''
    return { ok: true, message: `Database ready (${REQUIRED_TABLES.length} tables).${note}` }
  }

  async function firstDeploy() {
    const blocked = blockedBy('deploy')
    if (blocked) return blocked
    const t = await runTests()
    if (!t.ok) {
      const msg = t.summary ? `${t.summary.fail} of ${t.summary.tests} tests failed.` : 'The test suite did not finish.'
      return { ok: false, message: `${msg} Nothing was deployed.`, output: tail(t.output) }
    }
    const d = await deployNow()
    if (!d.ok) return d
    const s = readState()
    s.url = d.url
    delete s.checks.deploy
    writeState(s)

    let meet
    for (let i = 0; i < PROBE_TRIES; i++) {
      meet = await probe('/meet')
      if (meet.status === 200) break
      await wait(PROBE_WAIT_MS)
    }
    if (meet.status !== 200) return { ok: false, message: `Deployed to ${d.url}, but /meet answered ${meet.status || meet.error}. Wait a minute and press the button again.` }
    const admin = await probe('/api/admin/config')
    if (admin.status === 200) return { ok: false, message: 'STOP: /api/admin/config answered 200, so admin is not locked. Do not continue; report this.' }
    if (admin.status !== 403) return { ok: false, message: `/api/admin/config answered ${admin.status}, expected 403.` }
    const done = readState()
    done.checks.deploy = true
    writeState(done)
    return { ok: true, message: `Live at ${d.url}. /meet is up and admin is locked.` }
  }

  async function saveGoogle(input) {
    const blocked = blockedBy('google')
    if (blocked) return blocked
    const clientId = str(input?.clientId)
    const secret = str(input?.clientSecret)
    if (!isGoogleClientId(clientId)) return { ok: false, errors: { clientId: 'Should end in .apps.googleusercontent.com.' }, message: 'That is not a Google OAuth client ID.' }
    if (secret) {
      if (secret === clientId || secret.length < 8) return { ok: false, errors: { clientSecret: 'That does not look like the client secret.' }, message: 'Check the client secret.' }
      const put = await wrangler.secretPut('GOOGLE_CLIENT_SECRET', secret)
      if (!put.ok) return { ok: false, message: 'Cloudflare did not accept the client secret. Try again.' }
    }
    const names = await wrangler.secretNames()
    if (!names.names.includes('GOOGLE_CLIENT_SECRET')) return { ok: false, errors: { clientSecret: 'Required.' }, message: 'Paste the client secret.' }
    saveConfig({ GOOGLE_CLIENT_ID: clientId }, (s) => { s.checks.google = true })
    return { ok: true, message: 'Google client saved.' }
  }

  async function saveTurnstile(input) {
    const blocked = blockedBy('turnstile')
    if (blocked) return blocked
    const siteKey = str(input?.siteKey)
    const secret = str(input?.secretKey)
    if (!isTurnstileSiteKey(siteKey)) return { ok: false, errors: { siteKey: 'Starts with 0x.' }, message: 'That is not a Turnstile site key.' }
    if (secret) {
      if (secret === siteKey) return { ok: false, errors: { secretKey: 'This is the site key; paste the secret key.' }, message: 'Check the secret key.' }
      // A dummy token against siteverify tells a bad secret apart from a good
      // one: Cloudflare names which of the two inputs it rejected.
      let codes
      try {
        const res = await fetch(SITEVERIFY, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret, response: 'meet-kit-setup-check' }).toString(),
        })
        codes = (await res.json())?.['error-codes'] || []
      } catch {
        return { ok: false, message: 'Could not reach Cloudflare to check the secret key. Check your connection and try again.' }
      }
      if (codes.includes('invalid-input-secret')) return { ok: false, errors: { secretKey: 'Cloudflare says this secret key is invalid.' }, message: 'Check the secret key.' }
      const put = await wrangler.secretPut('TURNSTILE_SECRET_KEY', secret)
      if (!put.ok) return { ok: false, message: 'Cloudflare did not accept the secret key. Try again.' }
    }
    const names = await wrangler.secretNames()
    if (!names.names.includes('TURNSTILE_SECRET_KEY')) return { ok: false, errors: { secretKey: 'Required.' }, message: 'Paste the secret key.' }
    saveConfig({ TURNSTILE_SITE_KEY: siteKey }, (s) => { s.checks.turnstile = true })
    return { ok: true, message: 'Turnstile saved.' }
  }

  async function saveAccess(input) {
    const blocked = blockedBy('access')
    if (blocked) return blocked
    const team = normalizeTeamDomain(input?.teamDomain)
    const aud = str(input?.aud).toLowerCase()
    const errors = {}
    if (!team) errors.teamDomain = 'Your team name, or https://<team>.cloudflareaccess.com.'
    if (!isAud(aud)) errors.aud = '64 characters, 0-9 and a-f.'
    if (Object.keys(errors).length) return { ok: false, errors, message: 'Fix the highlighted fields.' }
    let keys
    try {
      const res = await fetch(`${team}/cdn-cgi/access/certs`)
      keys = res.ok ? (await res.json())?.keys : null
    } catch {}
    if (!Array.isArray(keys) || keys.length === 0) {
      return { ok: false, errors: { teamDomain: 'No Access team answers at this address.' }, message: `${team} is not an Access team domain. Check the spelling in Zero Trust → Settings.` }
    }
    saveConfig({ ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud }, (s) => { s.checks.access = true })
    return { ok: true, message: 'Access saved.' }
  }

  async function lockCheck() {
    const blocked = blockedBy('lock')
    if (blocked) return blocked
    const d = await deployNow()
    if (!d.ok) return d
    const team = readString(readWrangler(), 'ACCESS_TEAM_DOMAIN')
    let problem = ''
    for (let i = 0; i < PROBE_TRIES; i++) {
      const results = {}
      for (const path of [...ADMIN_PROBES, '/meet']) results[path] = await probe(path)
      // Never retry past an open admin: a 200 here is never a propagation delay.
      const open = ADMIN_PROBES.find((p) => results[p].status === 200)
      if (open) return { ok: false, message: `STOP: ${open} answered 200, so admin is NOT locked. Do not use the site; re-check the Access steps and report this.` }
      const admin = results['/admin/']
      const api = results['/api/admin/config']
      if (!(admin.status >= 300 && admin.status < 400 && admin.location.startsWith(`${team}/`))) {
        problem = `/admin/ is not being sent to your Access login (got ${admin.status || admin.error}). Check the Access application's hostname and paths, then press the button again.`
      } else if (![302, 403].includes(api.status)) {
        problem = `/api/admin/config answered ${api.status}, expected 403 or a redirect to Access.`
      } else if (results['/meet'].status !== 200) {
        problem = `/meet is not public (got ${results['/meet'].status}). Access must cover only the admin paths: if you switched on Access for the whole Worker, switch it off and use the self-hosted application from the Access step.`
      } else {
        const s = readState()
        s.checks.lock = true
        writeState(s)
        return { ok: true, message: 'Admin is locked behind Access and /meet is public.' }
      }
      await wait(PROBE_WAIT_MS)
    }
    return { ok: false, message: problem }
  }

  async function tick(input) {
    const step = str(input?.step)
    if (!['calendar', 'e2e'].includes(step)) return { ok: false, message: 'Unknown step.' }
    const blocked = blockedBy(step)
    if (blocked) return blocked
    const s = readState()
    s.manual[step] = input?.done === true
    writeState(s)
    return { ok: true, message: 'Saved.' }
  }

  return { status, login, chooseAccount, saveProfile, setupDatabase, firstDeploy, saveGoogle, saveTurnstile, saveAccess, lockCheck, tick }
}
