import assert from 'node:assert/strict'
import test from 'node:test'
import { onRequestGet } from '../src/handlers/public-slots.js'
import { googleApi } from '../src/core/google-calendar.js'
import { zonedWallTimeToUtc } from '../src/core/tz.js'

// A hardcoded calendar date ROTS -- see tests/calendar-slots-api.test.js for
// the full story. Derive a weekday far enough ahead that neither minNotice
// nor the past-slot filter can ever apply.
function futureWeekday(daysAhead = 28) {
  const d = new Date(Date.now() + daysAhead * 86_400_000)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}
const DAY = futureWeekday()
const pad = (n) => String(n).padStart(2, '0')
const DAY_ISO = `${DAY.year}-${pad(DAY.month)}-${pad(DAY.day)}`

// Wall time in the BOOKING timezone converted to a UTC instant, so these
// expectations survive a DST change rather than assuming a fixed UTC offset.
const at = (hour, minute = 0) =>
  new Date(zonedWallTimeToUtc({ ...DAY, hour, minute }, 'America/New_York')).toISOString()

function fakeDB({ config = {}, connections = [], selections = [] } = {}) {
  const kv = new Map(Object.entries(config))
  return {
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this },
        async all() {
          if (this.sql.includes('FROM calendar_connections')) return { results: connections }
          if (this.sql.includes('FROM calendar_selections')) {
            return { results: selections.filter((sel) => sel.connection_id === this.args[0]) }
          }
          return { results: [...kv.entries()].map(([key, value]) => ({ key, value })) }
        },
        async first() { return null },
        async run() { return { success: true } },
      }
    },
  }
}

const WRITE_CONN = {
  connection_id: 'google:owner@example.com', provider: 'google', role: 'write',
  refresh_token: 'rt', access_token: null, expires_at: null,
  account_email: 'owner@example.com',
}
const BUSY_CONN = {
  connection_id: 'google:other@example.com', provider: 'google', role: 'busy',
  refresh_token: 'rt2', access_token: null, expires_at: null,
  account_email: 'other@example.com',
}

const CONFIG = {
  google_client_id: 'cid', google_client_secret: 'csec',
  zoho_client_id: 'zc', zoho_client_secret: 'zs',
  // 30 days, not 1. The public handler ignores ?from= and always computes from
  // TODAY, so a 1-day horizon makes these tests depend on the wall clock: run
  // them after ~15:00 ET and the 2-hour minimum notice pushes every remaining
  // slot past 17:00, leaving none. A horizon that spans several weekdays keeps
  // the suite deterministic. Production's default is 21.
  rules_horizon_days: '30',
}

const SEL_WRITE = { connection_id: WRITE_CONN.connection_id, calendar_id: 'owner@example.com', name: 'Owner calendar', busy: 1 }
const SEL_WORK = { connection_id: BUSY_CONN.connection_id, calendar_id: 'work@example.com', name: 'Work calendar', busy: 1 }

const req = (qs = '') => new Request(`https://x/api/public/slots${qs}`)

/**
 * byCalendar maps calendar id -> { busy: [...] } | { errors: [...] } | 'fail'.
 * 'fail' returns a non-200 freeBusy response so a calendar can be made
 * unreadable -- the stock googleStub in the authenticated test file only
 * ever returns 200 with an embedded per-calendar `errors` array, never a
 * transport-level failure, so this extends it.
 */
function googleStub(byCalendar) {
  const seen = []
  googleApi.fetch = async (url, opts) => {
    if (url.includes('/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }))
    const ids = JSON.parse(opts.body).items.map((i) => i.id)
    seen.push(ids)
    const calendars = {}
    let anyFail = false
    for (const id of ids) {
      const entry = byCalendar[id]
      if (entry === 'fail') { anyFail = true; continue }
      calendars[id] = entry ?? { busy: [] }
    }
    if (anyFail) return new Response('nope', { status: 500 })
    return new Response(JSON.stringify({ calendars }))
  }
  return seen
}

/** Make the google fetch throw instead of returning a response at all. */
function googleThrowingStub(message) {
  googleApi.fetch = async (url) => {
    if (url.includes('/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }))
    throw new Error(message)
  }
}

test('the slots response carries EXACTLY three keys and nothing else', async () => {
  // Asserting only that four known-bad keys are ABSENT is vacuous: a mutant
  // adding `connections`, `accounts` and the whole cfg -- including
  // google_client_secret -- passed it. Pin the whole shape.
  googleStub({})
  const body = await (await onRequestGet({
    request: new Request(`https://x/api/public/slots?from=${DAY_ISO}&duration=30`),
    env: { DB: fakeDB({ config: CONFIG, connections: [WRITE_CONN], selections: [SEL_WRITE] }) },
  })).json()
  assert.deepEqual(Object.keys(body).sort(), ['durationMinutes', 'slots', 'timezone'])
  assert.ok(Array.isArray(body.slots))
})

test('an unreadable calendar yields zero slots and names NOTHING', async () => {
  googleStub({ 'work@example.com': 'fail' })
  const res = await onRequestGet({
    request: req(`?from=${DAY_ISO}`),
    env: { DB: fakeDB({ config: CONFIG, connections: [WRITE_CONN, BUSY_CONN], selections: [SEL_WRITE, SEL_WORK] }) },
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  const body = JSON.parse(text)
  assert.deepEqual(body.slots, [])
  const forbidden = ['work calendar', 'other@example.com', 'owner@example.com', 'google:', 'zoho:', 'Uncheck', 'reconnect', 'calendar config']
  for (const term of forbidden) {
    assert.equal(text.toLowerCase().includes(term.toLowerCase()), false, `raw response leaked "${term}"`)
  }
})

test('no connected calendar yields zero slots, not a config error', async () => {
  const res = await onRequestGet({
    request: req(`?from=${DAY_ISO}`),
    env: { DB: fakeDB({ config: CONFIG, connections: [], selections: [] }) },
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  const body = JSON.parse(text)
  assert.deepEqual(body.slots, [])
  assert.equal(/connect|config/i.test(text), false)
})

test('a provider throwing yields zero slots and leaks no stack', async () => {
  googleThrowingStub('ECONNRESET at socket.js:42:11 boom')
  const res = await onRequestGet({
    request: req(`?from=${DAY_ISO}`),
    env: { DB: fakeDB({ config: CONFIG, connections: [WRITE_CONN], selections: [SEL_WRITE] }) },
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  const body = JSON.parse(text)
  assert.deepEqual(body.slots, [])
  assert.equal(text.includes('Error'), false)
  assert.equal(text.includes(' at '), false)
})

test('240 is refused publicly and falls back to 30', async () => {
  googleStub({})
  const body = await (await onRequestGet({
    request: req(`?from=${DAY_ISO}&duration=240`),
    env: { DB: fakeDB({ config: CONFIG, connections: [WRITE_CONN], selections: [SEL_WRITE] }) },
  })).json()
  assert.equal(body.durationMinutes, 30)
})

test('60 is allowed publicly', async () => {
  googleStub({})
  const body = await (await onRequestGet({
    request: req(`?from=${DAY_ISO}&duration=60`),
    env: { DB: fakeDB({ config: CONFIG, connections: [WRITE_CONN], selections: [SEL_WRITE] }) },
  })).json()
  assert.equal(body.durationMinutes, 60)
})

test('an absent duration defaults to 30', async () => {
  googleStub({})
  const body = await (await onRequestGet({
    request: req(`?from=${DAY_ISO}`),
    env: { DB: fakeDB({ config: CONFIG, connections: [WRITE_CONN], selections: [SEL_WRITE] }) },
  })).json()
  assert.equal(body.durationMinutes, 30)
})

// Sanity check the happy path actually offers times, so the "zero slots"
// assertions above are proof of fail-closed behavior, not of a broken stub.
test('sanity: a fully readable calendar still offers slots', async () => {
  googleStub({})
  const body = await (await onRequestGet({
    request: req(`?from=${DAY_ISO}`),
    env: { DB: fakeDB({ config: CONFIG, connections: [WRITE_CONN], selections: [SEL_WRITE] }) },
  })).json()
  assert.ok(body.slots.length > 0)
  assert.equal(body.slots.some((sl) => sl.start === at(9)), true)
})

test('a throw OUTSIDE gatherBusy still yields zero slots and no stack', async () => {
  // Closes a gap found by mutation testing: gatherBusy swallows every
  // per-connection error itself, so nothing exercised the handler's outer
  // try/catch. A failure in the config layer -- a D1 outage, a malformed
  // rules row -- must not surface an exception on a PUBLIC page.
  const exploding = {
    prepare() { throw new Error('D1_ERROR: connection lost at internal/store.js:42') },
  }
  const res = await onRequestGet({
    request: new Request('https://x/api/public/slots'),
    env: { DB: exploding },
  })
  const raw = await res.text()
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(raw).slots, [])
  for (const leak of ['D1_ERROR', 'connection lost', 'internal/store', 'Error', ' at ']) {
    assert.ok(!raw.includes(leak), `public response leaked "${leak}"`)
  }
})

test('?from= is IGNORED so the horizon cannot be slid into the future', async () => {
  // computeSlots loops horizonDays forward from fromDay, so honouring `from`
  // turned a 21-day horizon into a window an anonymous caller could place
  // anywhere -- probing the operator's free/busy in 2031. The shipped client
  // never sends it.
  googleStub({})
  const env = { DB: fakeDB({ config: CONFIG, connections: [WRITE_CONN], selections: [SEL_WRITE] }) }
  const far = await (await onRequestGet({ request: req('?from=2031-06-02&duration=30'), env })).json()
  const plain = await (await onRequestGet({ request: req('?duration=30'), env })).json()
  assert.deepEqual(far.slots, plain.slots, 'from must change nothing')
  for (const sl of far.slots) {
    assert.ok(!sl.start.startsWith('2031'), `leaked a 2031 slot: ${sl.start}`)
  }
})

// --- Caching and the miss limiter ------------------------------------------

import { DatabaseSync } from 'node:sqlite'
import { SCHEMA } from './helpers/d1.js'
import { cacheImpl } from '../src/core/public-cache.js'

/** Real SQLite so the rate_counters table genuinely exists -- with the fake DB
 *  the limiter fails OPEN and is never actually exercised. meet-kit folds the
 *  rate_counters table into the one combined schema.sql, so no separate
 *  migration file needs loading here. */
function limiterDb(connections, selections) {
  const raw = new DatabaseSync(':memory:')
  raw.exec(SCHEMA)
  const kv = new Map(Object.entries(CONFIG))
  return {
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this },
        async all() {
          if (this.sql.includes('FROM calendar_connections')) return { results: connections }
          if (this.sql.includes('FROM calendar_selections')) {
            return { results: selections.filter((s) => s.connection_id === this.args[0]) }
          }
          if (this.sql.includes('rate_counters')) return { results: raw.prepare(sql).all(...this.args) }
          return { results: [...kv.entries()].map(([key, value]) => ({ key, value })) }
        },
        async first() {
          if (this.sql.includes('rate_counters')) return raw.prepare(sql).get(...this.args) ?? null
          if (this.sql.includes("role = 'write'")) return connections.find((c) => c.role === 'write') || null
          return null
        },
        async run() {
          if (this.sql.includes('rate_counters')) { raw.prepare(sql).run(...this.args); return { success: true } }
          return { success: true }
        },
      }
    },
  }
}

function memCache() {
  const store = new Map()
  cacheImpl.open = () => ({
    async match(r) { const v = store.get(r.url); return v ? v.clone() : undefined },
    async put(r, res) { const b = await res.text(); store.set(r.url, new Response(b, { headers: res.headers })) },
  })
  return store
}

test('a second identical request is served from cache with NO upstream call', async () => {
  // This is the whole defence: a flood collapses to one fan-out per TTL per
  // location, so anonymous traffic cannot exhaust the operator's Google and
  // Zoho quota -- exhaustion that would fail the INTERNAL tool closed too.
  memCache()
  const calls = googleStub({})
  const env = { DB: limiterDb([WRITE_CONN], [SEL_WRITE]) }
  const first = await (await onRequestGet({ request: req('?duration=30'), env })).json()
  const upstreamAfterFirst = calls.length
  assert.ok(upstreamAfterFirst > 0, 'the first request must actually fetch')

  const second = await (await onRequestGet({ request: req('?duration=30'), env })).json()
  assert.equal(calls.length, upstreamAfterFirst, 'the second request must make NO upstream call')
  assert.deepEqual(second.slots, first.slots)
  cacheImpl.open = () => null
})

test('a query string cannot bust the cache', async () => {
  memCache()
  const calls = googleStub({})
  const env = { DB: limiterDb([WRITE_CONN], [SEL_WRITE]) }
  await onRequestGet({ request: req('?duration=30'), env })
  const after = calls.length
  for (const bust of ['?duration=30&x=1', '?duration=30&x=2', '?from=2031-06-02&duration=30']) {
    await onRequestGet({ request: req(bust), env })
  }
  assert.equal(calls.length, after, 'cache-busting query strings must not reach upstream')
  cacheImpl.open = () => null
})

test('past the miss limit the grid comes back empty instead of fanning out', async () => {
  // No cache, so every request is a miss. The limiter must cap how many reach
  // Google/Zoho. An empty grid rather than a 429: the visitor retries, and a
  // 429 would advertise that a limiter exists.
  cacheImpl.open = () => null
  const calls = googleStub({})
  const env = { DB: limiterDb([WRITE_CONN], [SEL_WRITE]) }
  let empty = 0
  for (let i = 0; i < 30; i++) {
    const b = await (await onRequestGet({ request: req('?duration=30'), env })).json()
    if (b.slots.length === 0) empty++
  }
  assert.ok(empty > 0, 'the limiter must eventually refuse')
  assert.ok(calls.length < 30 * 2, `upstream calls must be bounded, saw ${calls.length}`)
})

test('a limiter refusal still returns the sanitised three-key shape', async () => {
  cacheImpl.open = () => null
  googleStub({})
  const env = { DB: limiterDb([WRITE_CONN], [SEL_WRITE]) }
  let body
  for (let i = 0; i < 30; i++) {
    body = await (await onRequestGet({ request: req('?duration=30'), env })).json()
  }
  assert.deepEqual(Object.keys(body).sort(), ['durationMinutes', 'slots', 'timezone'])
})

test('a fail-closed EMPTY grid is never cached', async () => {
  // Otherwise one transient calendar error pins "no availability" in front of
  // every visitor for the whole TTL. Only a good grid earns a cache entry.
  const store = memCache()
  let failNext = true
  googleApi.fetch = async (url, opts) => {
    if (url.includes('/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }))
    if (url.includes('/freeBusy')) {
      if (failNext) { failNext = false; return new Response('upstream boom', { status: 500 }) }
      return new Response(JSON.stringify({ calendars: { 'owner@example.com': { busy: [] } } }))
    }
    return new Response('{}')
  }
  const env = { DB: limiterDb([WRITE_CONN], [SEL_WRITE]) }

  const first = await (await onRequestGet({ request: req('?duration=30'), env })).json()
  assert.equal(first.slots.length, 0, 'the failing call must fail closed')
  assert.equal(store.size, 0, 'and must NOT be cached')

  const second = await (await onRequestGet({ request: req('?duration=30'), env })).json()
  assert.ok(second.slots.length > 0, 'the next request must recover, not be served a cached empty grid')
  cacheImpl.open = () => null
})

// 'the retention purge rides the cache-miss path' removed: retention moved to
// the nightly cron (Task 10). The public slots handler no longer calls
// purgeExpired at all.
