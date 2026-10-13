import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSetup } from '../scripts/setup/steps.mjs'
import { readString, setString } from '../scripts/setup/config-files.mjs'
import { readPristineWrangler } from './helpers/template.js'

const REPO = new URL('..', import.meta.url).pathname
const URL_ = 'https://meet-kit.jane.workers.dev'
const TEAM = 'https://acme.cloudflareaccess.com'
const AUD = 'a'.repeat(64)
const DB_ID = '22222222-2222-2222-2222-222222222222'
const TABLES = JSON.stringify([{ results: ['calendar_config', 'calendar_connections', 'calendar_selections',
  'public_bookings', 'public_bookings_cancelled', 'rate_counters'].map((name) => ({ name })) }])

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'meetkit-setup-'))
  writeFileSync(join(root, 'wrangler.jsonc'), readPristineWrangler())
  copyFileSync(join(REPO, 'meet.config.json'), join(root, 'meet.config.json'))
  return root
}

// A fake wrangler: `replies` maps the joined first two args to a reply.
function fakeRun(replies = {}) {
  const calls = []
  const run = async (args, opts = {}) => {
    calls.push({ args, ...opts })
    const key = args.slice(0, 2).join(' ')
    const r = replies[key] ?? replies[args[0]]
    const v = typeof r === 'function' ? r(args, opts) : r
    return v ?? { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

// fetch fake keyed by URL; values are { status, location?, json? }.
function fakeFetch(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const r = typeof routes === 'function' ? routes(String(url), init) : routes[String(url)]
    if (!r) throw new Error(`unexpected fetch ${url}`)
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: new Headers(r.location ? { location: r.location } : {}),
      json: async () => r.json,
    }
  }
  return { fetch, calls }
}

const passingTests = async () => ({ ok: true, summary: { tests: 10, pass: 10, fail: 0 }, output: '' })

function make(root, opts = {}) {
  return createSetup({
    root,
    run: opts.run ?? fakeRun().run,
    fetch: opts.fetch ?? fakeFetch({}).fetch,
    runTests: opts.runTests ?? passingTests,
    sleep: async () => {},
  })
}

// Puts a temp repo into the state reached after steps 1..n.
function advance(root, n) {
  const state = { accountId: 'acct', email: 'jane@example.com', checks: {}, manual: {} }
  let w = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
  if (n >= 2) { w = setString(w, 'OWNER_EMAIL', 'jane@example.com'); state.accountType = 'gmail' }
  if (n >= 3) { w = setString(w, 'database_id', DB_ID); state.checks.database = true }
  if (n >= 4) { state.url = URL_; state.checks.deploy = true }
  if (n >= 5) { w = setString(w, 'GOOGLE_CLIENT_ID', '1-abc.apps.googleusercontent.com'); state.checks.google = true }
  if (n >= 6) { w = setString(w, 'TURNSTILE_SITE_KEY', '0x4AAAAAAABkMYinukE8nzYS'); state.checks.turnstile = true }
  if (n >= 7) { w = setString(w, 'ACCESS_TEAM_DOMAIN', TEAM); w = setString(w, 'ACCESS_AUD', AUD); state.checks.access = true }
  if (n >= 8) state.checks.lock = true
  writeFileSync(join(root, 'wrangler.jsonc'), w)
  writeFileSync(join(root, '.setup-state.json'), JSON.stringify(state))
}

const stepStates = (s) => Object.fromEntries(s.steps.map((x) => [x.id, x.state]))

test('fresh copy: login is next, everything else waits', () => {
  const s = make(tempRepo()).status()
  assert.equal(s.steps.length, 10)
  assert.equal(stepStates(s).login, 'todo')
  assert.ok(s.steps.slice(1).every((x) => x.state === 'blocked'))
})

test('login with one account picks it', async () => {
  const root = tempRepo()
  const who = JSON.stringify({ loggedIn: true, email: 'jane@example.com', accounts: [{ id: 'acct', name: 'Jane' }] })
  let logged = false
  const { run, calls } = fakeRun({
    'whoami --json': () => (logged ? { code: 0, stdout: who } : { code: 1, stdout: '{"loggedIn":false}' }),
    login: () => { logged = true; return { code: 0 } },
  })
  const r = await make(root, { run }).login()
  assert.equal(r.ok, true)
  assert.ok(calls.some((c) => c.args[0] === 'login'))
  const s = make(root).status()
  assert.equal(stepStates(s).login, 'done')
  assert.equal(stepStates(s).profile, 'todo')
})

test('login with several accounts asks which; an unknown id is refused', async () => {
  const root = tempRepo()
  const who = JSON.stringify({ loggedIn: true, email: 'j@x.co', accounts: [{ id: 'a1', name: 'Personal' }, { id: 'a2', name: 'Work' }] })
  const { run } = fakeRun({ 'whoami --json': { code: 0, stdout: who } })
  const setup = make(root, { run })
  const r = await setup.login()
  assert.deepEqual(r.chooseAccount, [{ id: 'a1', name: 'Personal' }, { id: 'a2', name: 'Work' }])
  assert.equal(stepStates(setup.status()).login, 'todo')
  assert.equal((await setup.chooseAccount({ accountId: 'zzz' })).ok, false)
  assert.equal((await setup.chooseAccount({ accountId: 'a2' })).ok, true)
  assert.equal(stepStates(setup.status()).login, 'done')
})

test('actions refuse to run out of order', async () => {
  const root = tempRepo()
  const r = await make(root).setupDatabase()
  assert.equal(r.ok, false)
  assert.match(r.message, /Cloudflare login/)
})

test('saveProfile validates, then writes meet.config.json and OWNER_EMAIL', async () => {
  const root = tempRepo()
  advance(root, 1)
  const setup = make(root)
  const good = {
    ownerEmail: 'jane@example.com', accountType: 'workspace', displayName: 'Jane Doe', pageTitle: 'Book a call',
    pageSubtitle: 'Pick a time', eventTitle: 'Intro call', privacyUrl: '', termsUrl: '', accentColor: '#112233',
  }
  const bad = await setup.saveProfile({ ...good, ownerEmail: 'nope', accentColor: 'red' })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.ownerEmail && bad.errors.accentColor)
  assert.equal((await setup.saveProfile({ ...good, privacyUrl: 'http://x.com' })).ok, false)
  assert.equal((await setup.saveProfile({ ...good, accountType: 'other' })).ok, false)
  assert.equal(readString(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'), 'OWNER_EMAIL'), '')

  assert.equal((await setup.saveProfile(good)).ok, true)
  assert.equal(readString(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'), 'OWNER_EMAIL'), 'jane@example.com')
  assert.equal(JSON.parse(readFileSync(join(root, 'meet.config.json'), 'utf8')).displayName, 'Jane Doe')
  const s = setup.status()
  assert.equal(stepStates(s).profile, 'done')
  assert.equal(s.info.accountType, 'workspace')
})

test('setupDatabase creates the database when missing, writes its id, checks the tables', async () => {
  const root = tempRepo()
  advance(root, 2)
  let created = false
  const { run, calls } = fakeRun({
    'd1 list': () => ({ code: 0, stdout: JSON.stringify(created ? [{ name: 'meet-kit', uuid: DB_ID }] : []) }),
    'd1 create': () => { created = true; return { code: 0 } },
    'd1 execute': (args) => (args.includes('--json') ? { code: 0, stdout: TABLES } : { code: 0 }),
  })
  const r = await make(root, { run }).setupDatabase()
  assert.equal(r.ok, true, r.message)
  assert.doesNotMatch(r.message, /reused/)
  assert.ok(calls.some((c) => c.args[1] === 'create'))
  assert.equal(readString(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'), 'database_id'), DB_ID)
  assert.equal(stepStates(make(root).status()).database, 'done')
})

test('setupDatabase reuses an existing database and fails if tables are missing', async () => {
  const root = tempRepo()
  advance(root, 2)
  const { run, calls } = fakeRun({
    'd1 list': { code: 0, stdout: JSON.stringify([{ name: 'meet-kit', uuid: DB_ID }]) },
    'd1 execute': (args) => (args.includes('--json') ? { code: 0, stdout: '[{"results":[{"name":"rate_counters"}]}]' } : { code: 0 }),
  })
  const r = await make(root, { run }).setupDatabase()
  assert.equal(r.ok, false)
  assert.match(r.message, /calendar_config/)
  assert.equal(calls.some((c) => c.args[1] === 'create'), false)
  assert.equal(stepStates(make(root).status()).database, 'todo')
})

test('setupDatabase says so when it reuses an existing database', async () => {
  const root = tempRepo()
  advance(root, 2)
  const { run } = fakeRun({
    'd1 list': { code: 0, stdout: JSON.stringify([{ name: 'meet-kit', uuid: DB_ID }]) },
    'd1 execute': (args) => (args.includes('--json') ? { code: 0, stdout: TABLES } : { code: 0 }),
  })
  const r = await make(root, { run }).setupDatabase()
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /reused the meet-kit database already in this Cloudflare account/)
})

test('firstDeploy stops before deploying when a test fails', async () => {
  const root = tempRepo()
  advance(root, 3)
  const { run, calls } = fakeRun()
  const r = await make(root, { run, runTests: async () => ({ ok: false, summary: { tests: 3, pass: 2, fail: 1 }, output: 'not ok 2' }) }).firstDeploy()
  assert.equal(r.ok, false)
  assert.match(r.message, /1 of 3 tests failed/)
  assert.equal(calls.some((c) => c.args[0] === 'deploy'), false)
})

test('firstDeploy sends her to register a workers.dev subdomain when wrangler asks', async () => {
  const root = tempRepo()
  advance(root, 3)
  const { run } = fakeRun({ deploy: { code: 1, stderr: 'register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/abc/workers/onboarding' } })
  const r = await make(root, { run }).firstDeploy()
  assert.equal(r.ok, false)
  assert.equal(r.link, 'https://dash.cloudflare.com/abc/workers/onboarding')
})

test('firstDeploy records the URL once /meet is 200 and admin is 403', async () => {
  const root = tempRepo()
  advance(root, 3)
  const { run } = fakeRun({ deploy: { code: 0, stdout: `Deployed\n ${URL_}\n` } })
  let tries = 0
  const { fetch } = fakeFetch((url) => {
    if (url === `${URL_}/meet`) return ++tries < 3 ? { status: 404 } : { status: 200 }
    if (url === `${URL_}/api/admin/config`) return { status: 403 }
  })
  const r = await make(root, { run, fetch }).firstDeploy()
  assert.equal(r.ok, true, r.message)
  const s = make(root).status()
  assert.equal(s.info.url, URL_)
  assert.equal(s.info.redirectUri, `${URL_}/admin/oauth/google/callback`)
  assert.equal(stepStates(s).deploy, 'done')
})

test('firstDeploy fails if admin answers 200', async () => {
  const root = tempRepo()
  advance(root, 3)
  const { run } = fakeRun({ deploy: { code: 0, stdout: URL_ } })
  const { fetch } = fakeFetch(() => ({ status: 200 }))
  const r = await make(root, { run, fetch }).firstDeploy()
  assert.equal(r.ok, false)
  assert.match(r.message, /admin/)
})

test('saveGoogle checks the client id and sends the secret on stdin only', async () => {
  const root = tempRepo()
  advance(root, 4)
  const { run, calls } = fakeRun({ 'secret list': { code: 0, stdout: '[{"name":"GOOGLE_CLIENT_SECRET"}]' } })
  const setup = make(root, { run })
  assert.equal((await setup.saveGoogle({ clientId: 'GOCSPX-xyz', clientSecret: 'GOCSPX-abcdefgh' })).ok, false)
  const r = await setup.saveGoogle({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-abcdefgh' })
  assert.equal(r.ok, true, r.message)
  const put = calls.find((c) => c.args[1] === 'put')
  assert.equal(put.stdin, 'GOCSPX-abcdefgh')
  assert.equal(JSON.stringify(r).includes('GOCSPX-abcdefgh'), false)
  assert.equal(readFileSync(join(root, '.setup-state.json'), 'utf8').includes('GOCSPX-abcdefgh'), false)
  assert.equal(readString(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'), 'GOOGLE_CLIENT_ID'), '123-abc.apps.googleusercontent.com')
})

test('saveGoogle without a secret is fine only if one is already stored', async () => {
  const root = tempRepo()
  advance(root, 4)
  const none = fakeRun({ 'secret list': { code: 0, stdout: '[]' } })
  assert.equal((await make(root, { run: none.run }).saveGoogle({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: '' })).ok, false)
  const some = fakeRun({ 'secret list': { code: 0, stdout: '[{"name":"GOOGLE_CLIENT_SECRET"}]' } })
  assert.equal((await make(root, { run: some.run }).saveGoogle({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: '' })).ok, true)
  assert.equal(some.calls.some((c) => c.args[1] === 'put'), false)
})

test('saveTurnstile refuses a secret Cloudflare says is invalid', async () => {
  const root = tempRepo()
  advance(root, 5)
  const { run, calls } = fakeRun({ 'secret list': { code: 0, stdout: '[{"name":"TURNSTILE_SECRET_KEY"}]' } })
  const siteverify = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
  const bad = fakeFetch({ [siteverify]: { status: 200, json: { success: false, 'error-codes': ['invalid-input-secret'] } } })
  const r = await make(root, { run, fetch: bad.fetch }).saveTurnstile({ siteKey: '0x4AAAAAAABkMYinukE8nzYS', secretKey: '0x4AAAAAAAwrongwrongwrong' })
  assert.equal(r.ok, false)
  assert.equal(calls.some((c) => c.args[1] === 'put'), false)

  const good = fakeFetch({ [siteverify]: { status: 200, json: { success: false, 'error-codes': ['invalid-input-response'] } } })
  const ok = await make(root, { run, fetch: good.fetch }).saveTurnstile({ siteKey: '0x4AAAAAAABkMYinukE8nzYS', secretKey: '0x4AAAAAAArightrightright' })
  assert.equal(ok.ok, true, ok.message)
  assert.equal(good.calls[0].init.method, 'POST')
  assert.equal(calls.find((c) => c.args[1] === 'put').stdin, '0x4AAAAAAArightrightright')
})

test('saveAccess checks the team domain really serves Access keys', async () => {
  const root = tempRepo()
  advance(root, 6)
  const missing = fakeFetch(() => ({ status: 404 }))
  assert.equal((await make(root, { fetch: missing.fetch }).saveAccess({ teamDomain: 'acme', aud: AUD })).ok, false)
  assert.equal((await make(root).saveAccess({ teamDomain: 'acme', aud: 'short' })).ok, false)
  const { fetch, calls } = fakeFetch({ [`${TEAM}/cdn-cgi/access/certs`]: { status: 200, json: { keys: [{ kid: 'k' }] } } })
  const r = await make(root, { fetch }).saveAccess({ teamDomain: 'acme', aud: AUD })
  assert.equal(r.ok, true, r.message)
  assert.equal(calls[0].url, `${TEAM}/cdn-cgi/access/certs`)
  const w = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
  assert.equal(readString(w, 'ACCESS_TEAM_DOMAIN'), TEAM)
  assert.equal(readString(w, 'ACCESS_AUD'), AUD)
})

const lockedSite = (overrides = {}) => (url) => overrides[url] ?? ({
  [`${URL_}/meet`]: { status: 200 },
  [`${URL_}/admin/`]: { status: 302, location: `${TEAM}/cdn-cgi/access/login/meet-kit.jane.workers.dev?x=1` },
  [`${URL_}/api/admin/config`]: { status: 403 },
  [`${URL_}/%61dmin/`]: { status: 307, location: `${URL_}/admin/` },
  [`${URL_}//admin/`]: { status: 307, location: `${URL_}/admin/` },
})[url]

test('lockCheck redeploys and passes when admin goes to Access and /meet stays public', async () => {
  const root = tempRepo()
  advance(root, 7)
  const { run, calls } = fakeRun({ deploy: { code: 0, stdout: URL_ } })
  const { fetch } = fakeFetch(lockedSite())
  const r = await make(root, { run, fetch }).lockCheck()
  assert.equal(r.ok, true, r.message)
  assert.ok(calls.some((c) => c.args[0] === 'deploy'))
  assert.equal(stepStates(make(root).status()).lock, 'done')
})

test('lockCheck: any admin path answering 200 is a hard failure', async () => {
  for (const path of ['/admin/', '/api/admin/config', '/%61dmin/', '//admin/']) {
    const root = tempRepo()
    advance(root, 7)
    const { run } = fakeRun({ deploy: { code: 0, stdout: URL_ } })
    const { fetch } = fakeFetch(lockedSite({ [`${URL_}${path}`]: { status: 200 } }))
    const r = await make(root, { run, fetch }).lockCheck()
    assert.equal(r.ok, false, path)
    assert.match(r.message, /200/)
    assert.equal(stepStates(make(root).status()).lock, 'todo')
  }
})

test('lockCheck fails when Access also covers /meet (the whole-Worker switch)', async () => {
  const root = tempRepo()
  advance(root, 7)
  const { run } = fakeRun({ deploy: { code: 0, stdout: URL_ } })
  const { fetch } = fakeFetch(lockedSite({ [`${URL_}/meet`]: { status: 302, location: `${TEAM}/cdn-cgi/access/login` } }))
  const r = await make(root, { run, fetch }).lockCheck()
  assert.equal(r.ok, false)
  assert.match(r.message, /\/meet/)
})

test('lockCheck fails when /admin/ is not sent to the Access login', async () => {
  const root = tempRepo()
  advance(root, 7)
  const { run } = fakeRun({ deploy: { code: 0, stdout: URL_ } })
  const { fetch } = fakeFetch(lockedSite({ [`${URL_}/admin/`]: { status: 403 } }))
  const r = await make(root, { run, fetch }).lockCheck()
  assert.equal(r.ok, false)
  assert.match(r.message, /Access/)
})

test('changing a setting after the lock check means it must be re-run', async () => {
  const root = tempRepo()
  advance(root, 8)
  const { fetch } = fakeFetch({ [`${TEAM}/cdn-cgi/access/certs`]: { status: 200, json: { keys: [{}] } } })
  const setup = make(root, { fetch })
  assert.equal(stepStates(setup.status()).lock, 'done')
  await setup.saveAccess({ teamDomain: 'acme', aud: AUD })
  assert.equal(stepStates(setup.status()).lock, 'todo')
})

test('manual steps are ticked in order', async () => {
  const root = tempRepo()
  advance(root, 7)
  const setup = make(root)
  assert.equal((await setup.tick({ step: 'calendar', done: true })).ok, false)
  advance(root, 8)
  assert.equal((await setup.tick({ step: 'calendar', done: true })).ok, true)
  assert.equal((await setup.tick({ step: 'nope', done: true })).ok, false)
  assert.equal(stepStates(setup.status()).calendar, 'done')
  assert.equal(stepStates(setup.status()).e2e, 'todo')
})
