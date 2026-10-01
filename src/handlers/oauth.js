import * as store from '../core/calendar-store.js'
import { signState, verifyState, getOrCreateStateKey } from '../core/oauth-state.js'
import * as google from '../core/google-calendar.js'
import * as zoho from '../core/zoho-calendar.js'
import { loadCfg } from './context.js'

const json = (status, body) => Response.json(body, { status })
export const PROVIDERS = ['google', 'zoho']
export const ROLES = ['write', 'busy']
export const redirectUriFor = (origin, provider) => `${origin}/admin/oauth/${provider}/callback`

const notSetUp = (p) => `${p} is not set up: set ${p.toUpperCase()}_CLIENT_ID (var) and ${p.toUpperCase()}_CLIENT_SECRET (wrangler secret).`

function backToAdmin(origin, provider, message) {
  const q = new URLSearchParams({ error: `${provider}: ${String(message)}` })
  return Response.redirect(`${origin}/admin/?${q}`, 302)
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
  // Role travels inside the SIGNED state, never a callback query param.
  const state = await signState({ provider, role }, key, { ttlSeconds: 600 })
  const redirectUri = redirectUriFor(url.origin, provider)
  const target = provider === 'google'
    ? google.buildAuthUrl({ clientId, redirectUri, state })
    : zoho.buildAuthUrl({ clientId, redirectUri, state })
  return Response.redirect(target, 302)
}

export async function callback({ request, env, params, owner }) {
  const provider = params.provider
  if (!PROVIDERS.includes(provider)) return json(400, { error: 'unknown provider' })
  const url = new URL(request.url)
  if (url.searchParams.get('error')) {
    return backToAdmin(url.origin, provider, `denied: ${url.searchParams.get('error')}`)
  }
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  if (!code || !stateParam) return json(400, { error: 'code and state required' })

  const db = env.DB
  const key = await getOrCreateStateKey(db, store)
  const verified = await verifyState(stateParam, key)
  if (!verified.ok || verified.payload.provider !== provider) {
    return json(400, { error: `invalid state: ${verified.error || 'provider mismatch'}` })
  }
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
        await store.setConfig(db, 'write_calendar_id', primary.id)
        await store.setConfig(db, 'write_calendar_meet', primary.meet ? '1' : '0')
      }
    } else {
      const accountsHost = url.searchParams.get('accounts-server') || 'https://accounts.zoho.com'
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
  return Response.redirect(`${url.origin}/admin/?connected=${provider}`, 302)
}
