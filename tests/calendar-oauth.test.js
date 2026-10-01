import assert from 'node:assert/strict'
import test from 'node:test'
import { start, callback, redirectUriFor } from '../src/handlers/oauth.js'
import { googleApi } from '../src/core/google-calendar.js'
import * as store from '../src/core/calendar-store.js'
import { signState, verifyState, getOrCreateStateKey } from '../src/core/oauth-state.js'

/**
 * D1 double covering config kv, connections and selections.
 * Enforces the same one-write-target rule the partial unique index does, so the
 * tests fail the same way production would.
 */
function fakeDB(seed = {}, conns = []) {
  const kv = new Map(Object.entries(seed))
  const connections = new Map(conns.map((c) => [c.connection_id, c]))
  const selections = []
  return {
    kv, connections, selections,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this },
        async all() {
          if (this.sql.includes('FROM calendar_connections')) {
            return { results: [...connections.values()] }
          }
          if (this.sql.includes('FROM calendar_selections')) {
            return { results: selections.filter((r) => r.connection_id === this.args[0]) }
          }
          return { results: [...kv.entries()].map(([key, value]) => ({ key, value })) }
        },
        async first() {
          if (this.sql.includes("role = 'write'")) {
            return [...connections.values()].find((c) => c.role === 'write') || null
          }
          if (this.sql.includes('FROM calendar_connections')) {
            return connections.get(this.args[0]) || null
          }
          return null
        },
        async run() {
          if (this.sql.includes('INSERT INTO calendar_connections')) {
            const [connection_id, provider, role, refresh_token, , , account_email] = this.args
            if (role === 'write' && [...connections.values()].some((c) => c.role === 'write' && c.connection_id !== connection_id)) {
              throw new Error('UNIQUE constraint failed: calendar_connections.role')
            }
            connections.set(connection_id, { connection_id, provider, role, refresh_token, account_email })
          } else if (this.sql.includes('INSERT INTO calendar_selections')) {
            selections.push({ connection_id: this.args[0], calendar_id: this.args[1], name: this.args[2], busy: 1 })
          } else {
            kv.set(this.args[0], this.args[1])
          }
          return { success: true }
        },
      }
    },
  }
}

// Client credentials are Worker vars/secrets (loadCfg overlays them onto cfg
// from env, discarding any D1 copy) -- never seeded into fakeDB's kv any more.
const GOOGLE_ENV = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec' }
const ZOHO_ENV = { ZOHO_CLIENT_ID: 'z', ZOHO_CLIENT_SECRET: 'zs' }

const OWNER = 'owner@example.com'

const WRITE_CONN = {
  connection_id: `google:${OWNER}`,
  provider: 'google', role: 'write', account_email: OWNER, refresh_token: 'rt',
}

test('connect redirects to Google with the documented params', async () => {
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=write'),
    env: { DB: fakeDB(), ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  assert.equal(res.status, 302)
  const target = new URL(res.headers.get('location'))
  assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(target.searchParams.get('access_type'), 'offline')
  assert.equal(target.searchParams.get('prompt'), 'consent')
  assert.equal(
    target.searchParams.get('redirect_uri'),
    redirectUriFor('https://calls.example.com', 'google'),
  )
  assert.ok(target.searchParams.get('state'))
})

test('connect refuses when the client id is not configured yet', async () => {
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=busy'),
    env: { DB: fakeDB() },
    params: { provider: 'google' },
  })
  assert.equal(res.status, 400)
})

test('connect rejects an unknown provider', async () => {
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/outlook/start'),
    env: { DB: fakeDB(), ...GOOGLE_ENV },
    params: { provider: 'outlook' },
  })
  assert.equal(res.status, 400)
})

test('the state issued by connect carries the signed provider AND role', async () => {
  const db = fakeDB()
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=write'),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  const state = new URL(res.headers.get('location')).searchParams.get('state')
  const result = await verifyState(state, db.kv.get('state_signing_key'))
  assert.equal(result.ok, true)
  assert.equal(result.payload.provider, 'google')
  assert.equal(result.payload.role, 'write')
})

test('connect defaults to the read-only busy role', async () => {
  const db = fakeDB()
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start'),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  const state = new URL(res.headers.get('location')).searchParams.get('state')
  const { payload } = await verifyState(state, db.kv.get('state_signing_key'))
  assert.equal(payload.role, 'busy')
})

test('connect REFUSES a second write account with 409', async () => {
  // Enforcement layer 3 of the one-write-connection guarantee (see
  // calendar-store.js's getWriteConnection doc comment). Refused before the
  // operator is sent through a consent screen that could only fail later.
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=write'),
    env: { DB: fakeDB({}, [WRITE_CONN]), ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /already the booking account/)
})

test('a second BUSY account is allowed alongside the write account', async () => {
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=busy'),
    env: { DB: fakeDB({}, [WRITE_CONN]), ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  assert.equal(res.status, 302)
})

test('connect/zoho is refused when no Zoho account email is configured', async () => {
  // Zoho reports the account address nowhere, but its free/busy endpoint
  // requires it. Refuse before the consent screen rather than after, so the
  // operator is not sent through an OAuth round trip that can only fail.
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/zoho/start?role=busy'),
    env: { DB: fakeDB(), ...ZOHO_ENV },
    params: { provider: 'zoho' },
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /Zoho account email/i)
})

test('connect/zoho proceeds once the account email is configured', async () => {
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/zoho/start?role=busy'),
    env: { DB: fakeDB({ zoho_account_email: 'owner-work@example.com' }), ...ZOHO_ENV },
    params: { provider: 'zoho' },
  })
  assert.equal(res.status, 302)
  assert.match(res.headers.get('location'), /accounts\.zoho\.com/)
})

test('Zoho can never hold the write role', async () => {
  const res = await start({
    request: new Request('https://calls.example.com/admin/oauth/zoho/start?role=write'),
    env: { DB: fakeDB(), ...ZOHO_ENV },
    params: { provider: 'zoho' },
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /cannot create events/)
})

test('Zoho can never become the write connection, even via a forged-but-valid callback state', async () => {
  // Layer 1: start() refuses role=write for zoho before any state is issued.
  const startRes = await start({
    request: new Request('https://calls.example.com/admin/oauth/zoho/start?role=write'),
    env: { DB: fakeDB({ zoho_account_email: 'owner-work@example.com' }), ...ZOHO_ENV },
    params: { provider: 'zoho' },
  })
  assert.equal(startRes.status, 400)

  // Layer 2: even a validly signed state naming { provider: 'zoho', role:
  // 'write' } (which start() itself would never issue) must be refused at the
  // callback, and nothing may be saved.
  const db = fakeDB({ zoho_account_email: 'owner-work@example.com' })
  const key = await getOrCreateStateKey(db, store)
  const state = await signState({ provider: 'zoho', role: 'write' }, key, { ttlSeconds: 600 })
  let called = false
  googleApi.fetch = async () => { called = true; return new Response('{}') }
  const cbRes = await callback({
    request: new Request(`https://calls.example.com/admin/oauth/zoho/callback?code=abc&state=${encodeURIComponent(state)}`),
    env: { DB: db, ...ZOHO_ENV },
    params: { provider: 'zoho' },
    owner: OWNER,
  })
  assert.equal(cbRes.status, 400)
  assert.equal(called, false)
  assert.equal(db.connections.size, 0)
})

test('callback refuses a write role that was claimed after a write account appeared', async () => {
  // Race: connect passed the check, another write connection landed, then the
  // callback returned. Re-checked before the token exchange, so losing costs nothing.
  const db = fakeDB()
  const connectRes = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=write'),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  const state = new URL(connectRes.headers.get('location')).searchParams.get('state')
  db.connections.set(WRITE_CONN.connection_id, WRITE_CONN)

  let called = false
  googleApi.fetch = async () => { called = true; return new Response('{}') }

  const res = await callback({
    request: new Request(`https://calls.example.com/admin/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  assert.equal(res.status, 409)
  assert.equal(called, false)
})

test('callback refuses to save when the account email cannot be determined', async () => {
  const db = fakeDB()
  const connectRes = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=busy'),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  const state = new URL(connectRes.headers.get('location')).searchParams.get('state')
  googleApi.fetch = async (url) => {
    if (url.includes('/token')) return new Response(JSON.stringify({ refresh_token: 'rt', access_token: 'at', expires_in: 3600 }))
    return new Response(JSON.stringify({ items: [{ id: 'x@y.com', summary: 'No primary flag' }] }))
  }
  const res = await callback({
    request: new Request(`https://calls.example.com/admin/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  // Redirects back to the admin page with the reason, rather than returning a
  // 5xx: Cloudflare replaces a 502 from the origin with its own Bad Gateway
  // page and the operator never sees why the connection failed.
  assert.equal(res.status, 302)
  const loc = new URL(res.headers.get('location'))
  assert.equal(loc.pathname, '/admin/')
  // searchParams, not decodeURIComponent: URLSearchParams encodes spaces as
  // '+', which decodeURIComponent does not turn back into spaces.
  assert.match(loc.searchParams.get('error'), /account email/i)
  assert.equal(db.connections.size, 0)
})

test('a provider failure redirects the reason back to the admin page', async () => {
  // The 502-swallowed-by-Cloudflare trap, caught live during the runbook: a
  // failing token exchange must surface the provider's own message on screen.
  const db = fakeDB()
  const connectRes = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=busy'),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  const state = new URL(connectRes.headers.get('location')).searchParams.get('state')

  googleApi.fetch = async () =>
    new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })

  const res = await callback({
    request: new Request(`https://calls.example.com/admin/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  assert.equal(res.status, 302)
  const target = new URL(res.headers.get('location'))
  assert.equal(target.pathname, '/admin/')
  assert.match(target.searchParams.get('error'), /invalid_client/)
  assert.equal(db.connections.size, 0)
})

test('callback rejects a forged state without calling the token endpoint', async () => {
  let called = false
  googleApi.fetch = async () => { called = true; return new Response('{}') }
  const res = await callback({
    request: new Request('https://calls.example.com/admin/oauth/google/callback?code=x&state=forged.sig'),
    env: { DB: fakeDB(), ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  assert.equal(res.status, 400)
  assert.equal(called, false)
})

test('callback exchanges a valid code and persists the refresh token', async () => {
  const db = fakeDB()
  const connectRes = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=busy'),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  const state = new URL(connectRes.headers.get('location')).searchParams.get('state')

  googleApi.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ refresh_token: 'rt-new', access_token: 'at', expires_in: 3600 }))
    }
    return new Response(JSON.stringify({ items: [{ id: 'work@example.com', summary: 'Primary', primary: true }] }))
  }

  const res = await callback({
    request: new Request(`https://calls.example.com/admin/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
    owner: OWNER,
  })
  assert.equal(res.status, 302)
  assert.equal(db.connections.get('google:work@example.com').refresh_token, 'rt-new')
  assert.equal(db.connections.get('google:work@example.com').role, 'busy')
})

test('callback fails loudly when Google returns no refresh token', async () => {
  // Happens when access_type/prompt are wrong or the user had already consented.
  // Persisting a connection with no refresh token creates one that silently
  // stops working in an hour.
  const db = fakeDB()
  const connectRes = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=busy'),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  const state = new URL(connectRes.headers.get('location')).searchParams.get('state')

  googleApi.fetch = async () => new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }))

  const res = await callback({
    request: new Request(`https://calls.example.com/admin/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  assert.equal(res.status, 302)
  assert.equal(db.connections.size, 0)
})

test('a Google write callback records the booking calendar and its Meet capability', async () => {
  const db = fakeDB()
  const connectRes = await start({
    request: new Request('https://calls.example.com/admin/oauth/google/start?role=write'),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
  })
  const state = new URL(connectRes.headers.get('location')).searchParams.get('state')

  googleApi.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ refresh_token: 'rt-new', access_token: 'at', expires_in: 3600 }))
    }
    return new Response(JSON.stringify({ items: [
      { id: OWNER, summary: 'Primary', primary: true, conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } },
    ] }))
  }

  const res = await callback({
    request: new Request(`https://calls.example.com/admin/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`),
    env: { DB: db, ...GOOGLE_ENV },
    params: { provider: 'google' },
    owner: OWNER,
  })
  assert.equal(res.status, 302)
  assert.equal(db.connections.get(`google:${OWNER}`).role, 'write')
  assert.equal(db.kv.get('write_calendar_id'), OWNER)
  assert.equal(db.kv.get('write_calendar_meet'), '1')
})
