import * as store from '../core/calendar-store.js'
import { signState, verifyState, getOrCreateStateKey, randomNonce, safeEqual } from '../core/oauth-state.js'
import * as google from '../core/google-calendar.js'
import * as zoho from '../core/zoho-calendar.js'
import { loadCfg } from './context.js'

const json = (status, body) => Response.json(body, { status })
export const PROVIDERS = ['google', 'zoho']
export const ROLES = ['write', 'busy']
export const redirectUriFor = (origin, provider) => `${origin}/admin/oauth/${provider}/callback`

const notSetUp = (p) => `${p} is not set up: set ${p.toUpperCase()}_CLIENT_ID (var) and ${p.toUpperCase()}_CLIENT_SECRET (wrangler secret).`

// Binds an OAuth state to the browser that started the flow. __Host- forces
// Secure + Path=/ + no Domain, so a sibling subdomain cannot plant one.
export const OAUTH_COOKIE = '__Host-meetkit_oauth'
const STATE_TTL_SECONDS = 600
const COOKIE_ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Lax'
const CLEAR_OAUTH_COOKIE = `${OAUTH_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`

/** A 302 with MUTABLE headers. Response.redirect's headers are immutable. */
function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } })
}

function backToAdmin(origin, provider, message) {
  const q = new URLSearchParams({ error: `${provider}: ${String(message)}` })
  return redirect(`${origin}/admin/?${q}`)
}

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export async function start({ request, env, params }) {
  const provider = params.provider
  if (!PROVIDERS.includes(provider)) return json(400, { error: 'unknown provider' })
  const url = new URL(request.url)
  const role = url.searchParams.get('role') || 'busy'
  if (!ROLES.includes(role)) return json(400, { error: 'unknown role' })
  if (provider === 'zoho' && role === 'write') {
    return json(400, { error: 'Zoho is a busy-time source only and cannot create events' })
  }

  const db = env.DB
  if (role === 'write') {
    const existing = await store.getWriteConnection(db)
    if (existing) {
      return json(409, { error: `${existing.account_email} is already the booking account. Disconnect it first.` })
    }
  }

  const cfg = await loadCfg(db, env)
  const clientId = cfg[`${provider}_client_id`]
  if (!clientId || !cfg[`${provider}_client_secret`]) return json(400, { error: notSetUp(provider) })
  if (provider === 'zoho' && !cfg.zoho_account_email) {
    return json(400, { error: 'Set the Zoho account email on the admin page before connecting Zoho.' })
  }

  const key = await getOrCreateStateKey(db, store)
  // Single-use + browser binding: the nonce rides in the SIGNED state, in an
  // HttpOnly cookie on this browser, and in D1 until the first callback deletes it.
  const nonce = randomNonce()
  const nowSec = Math.floor(Date.now() / 1000)
  await store.purgeExpiredOAuthNonces(db, nowSec)
  await store.recordOAuthNonce(db, nonce, nowSec + STATE_TTL_SECONDS)
  // Role travels inside the SIGNED state, never a callback query param.
  const state = await signState({ provider, role, nonce }, key, { ttlSeconds: STATE_TTL_SECONDS })
  const redirectUri = redirectUriFor(url.origin, provider)
  const target = provider === 'google'
    ? google.buildAuthUrl({ clientId, redirectUri, state })
    : zoho.buildAuthUrl({ clientId, redirectUri, state })
  return redirect(target, {
    'Set-Cookie': `${OAUTH_COOKIE}=${nonce}; ${COOKIE_ATTRS}; Max-Age=${STATE_TTL_SECONDS}`,
  })
}

/** Every callback response, success or failure, clears the binding cookie. */
export async function callback(ctx) {
  const res = await handleCallback(ctx)
  const out = new Response(res.body, res)
  out.headers.append('Set-Cookie', CLEAR_OAUTH_COOKIE)
  return out
}

async function handleCallback({ request, env, params, owner }) {
  const provider = params.provider
  if (!PROVIDERS.includes(provider)) return json(400, { error: 'unknown provider' })
  const url = new URL(request.url)
  const stateParam = url.searchParams.get('state')
  if (!stateParam) return json(400, { error: 'state required' })

  const db = env.DB
  const key = await getOrCreateStateKey(db, store)
  const verified = await verifyState(stateParam, key)
  if (!verified.ok || verified.payload.provider !== provider) {
    return json(400, { error: `invalid state: ${verified.error || 'provider mismatch'}` })
  }
  // Browser binding: the cookie set by start must match the signed nonce.
  // Checked BEFORE consuming, so a cookieless hit cannot burn a live flow.
  const nonce = verified.payload.nonce
  const cookieNonce = readCookie(request, OAUTH_COOKIE)
  if (typeof nonce !== 'string' || !nonce || !safeEqual(cookieNonce, nonce)) {
    return json(400, { error: 'invalid state: this sign-in was not started in this browser' })
  }
  // Single use: only the first callback to delete the issued nonce proceeds.
  if (!(await store.consumeOAuthNonce(db, nonce))) {
    return json(400, { error: 'invalid state: already used or expired' })
  }
  // Provider-reported errors are honoured only AFTER the state verifies, and
  // only an OAuth error CODE is reflected -- never free text from the URL.
  const providerError = url.searchParams.get('error')
  if (providerError) {
    const shown = /^[a-z_]{1,40}$/.test(providerError) ? providerError : 'authorization was cancelled'
    return backToAdmin(url.origin, provider, `denied: ${shown}`)
  }
  const code = url.searchParams.get('code')
  if (!code) return json(400, { error: 'code required' })

  const role = verified.payload.role
  if (!ROLES.includes(role)) return json(400, { error: 'invalid role in state' })
  if (provider === 'zoho' && role === 'write') return json(400, { error: 'Zoho cannot be the booking account' })
  if (role === 'write' && (await store.getWriteConnection(db))) {
    return json(409, { error: 'A booking account is already connected.' })
  }

  const cfg = await loadCfg(db, env)
  const clientId = cfg[`${provider}_client_id`]
  const clientSecret = cfg[`${provider}_client_secret`]
  const redirectUri = redirectUriFor(url.origin, provider)

  try {
    if (provider === 'google') {
      const tokens = await google.exchangeCode({ clientId, clientSecret, code, redirectUri })
      if (!tokens.refreshToken) {
        return backToAdmin(url.origin, provider, 'Google returned no refresh token. Remove this app at myaccount.google.com/permissions and reconnect.')
      }
      const cals = await google.listCalendars(tokens.accessToken)
      const primary = cals.find((c) => c.primary)
      if (!primary?.id) return backToAdmin(url.origin, provider, 'Could not determine the Google account email; nothing was saved.')
      const connId = await store.saveConnection(db, {
        provider: 'google', role, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken,
        expiresAt: new Date(tokens.expiresAt).toISOString(), accountEmail: primary.id, connectedBy: owner || null,
      })
      for (const c of cals) await store.upsertSelection(db, connId, c.id, c.name)
      if (role === 'write') {
        // saveConnection's upsert NEVER changes an existing row's role, so an
        // account already connected as busy-only stays busy-only. Re-read
        // rather than assume, and never point write_calendar_id at it.
        const saved = await store.getConnectionById(db, connId)
        if (saved?.role !== 'write') {
          return backToAdmin(url.origin, provider, 'This account is already connected as busy-only; disconnect it first.')
        }
        await store.setConfig(db, 'write_calendar_id', primary.id)
        await store.setConfig(db, 'write_calendar_meet', primary.meet ? '1' : '0')
      }
    } else {
      const accountsHost = url.searchParams.get('accounts-server') || 'https://accounts.zoho.com'
      // Attacker-controlled query param: the client secret is POSTed to this
      // host. Exact allowlist, checked before ANY network call; never reflected.
      if (!zoho.isZohoAccountsHost(accountsHost)) return backToAdmin(url.origin, provider, zoho.UNKNOWN_ZOHO_REGION)
      const tokens = await zoho.exchangeCode({ clientId, clientSecret, code, redirectUri, accountsHost })
      if (!tokens.refreshToken) return backToAdmin(url.origin, provider, 'Zoho returned no refresh token. Reconnect.')
      const apiHost = zoho.calendarHostFor(accountsHost)
      const accountEmail = cfg.zoho_account_email
      if (!accountEmail) return backToAdmin(url.origin, provider, 'Set the Zoho account email, then reconnect.')
      await zoho.listCalendars({ accessToken: tokens.accessToken, apiHost })
      await store.saveConnection(db, {
        provider: 'zoho', role: 'busy', refreshToken: tokens.refreshToken, accessToken: tokens.accessToken,
        expiresAt: new Date(tokens.expiresAt).toISOString(), accountEmail, apiHost, accountsHost, connectedBy: owner || null,
      })
    }
  } catch (err) {
    return backToAdmin(url.origin, provider, err.message || err)
  }
  return redirect(`${url.origin}/admin/?connected=${provider}`)
}
