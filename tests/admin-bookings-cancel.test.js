import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { savePublicBooking, markNoShow } from '../src/core/public-bookings.js'
import { onRequestGet } from '../src/handlers/admin-bookings.js'
import { onRequestPost } from '../src/handlers/admin-cancel.js'

const OWNER = 'owner@example.com'
const ENV = (db) => ({ DB: db, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec' })

async function seed() {
  const db = realDB()
  await store.saveConnection(db, { provider: 'google', role: 'write', refreshToken: 'rt', accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: OWNER })
  const id = await savePublicBooking(db, { email: 'v@example.org', capIdentity: 'v@example.org', durationMinutes: 30,
    startUtc: '2099-01-01T15:00:00.000Z', endUtc: '2099-01-01T15:30:00.000Z', eventId: 'e1',
    meetUrl: 'https://meet.google.com/u', meetUrlSource: 'unique', calendarId: OWNER, topic: 'Audit review' })
  return { db, id }
}

test('lists upcoming bookings with link source', async () => {
  const { db } = await seed()
  const { bookings } = await (await onRequestGet({ env: ENV(db) })).json()
  assert.equal(bookings.length, 1)
  assert.equal(bookings[0].meetUrlSource, 'unique')
  assert.equal(bookings[0].topic, 'Audit review')
})

test('cancel deletes the event on the pinned calendar, then moves the row', async () => {
  const { db, id } = await seed()
  const calls = []
  googleApi.fetch = async (url, opts) => { calls.push({ url, method: opts?.method }); return new Response(null, { status: 204 }) }
  const res = await onRequestPost({ request: new Request('https://x.test', { method: 'POST', body: JSON.stringify({ id }) }), env: ENV(db), owner: OWNER })
  assert.equal(res.status, 200)
  assert.match(calls[0].url, new RegExp(`calendars/${encodeURIComponent(OWNER)}/events/e1\\?sendUpdates=all`))
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM public_bookings').get().n, 0)
  assert.equal(db.raw.prepare('SELECT cancelled_by FROM public_bookings_cancelled').get().cancelled_by, OWNER)
})

test('Google failure: nothing recorded', async () => {
  const { db, id } = await seed()
  googleApi.fetch = async () => new Response('{}', { status: 500 })
  const res = await onRequestPost({ request: new Request('https://x.test', { method: 'POST', body: JSON.stringify({ id }) }), env: ENV(db), owner: OWNER })
  assert.equal(res.status, 502)
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM public_bookings').get().n, 1)
})

// ---------------------------------------------------------------------------
// Finding 6: id is validated before any DB call, and the "meeting was
// cancelled" message is only ever sent when the Google delete succeeded.
// ---------------------------------------------------------------------------

const noTouchDB = () => ({
  prepare() { throw new Error('DB touched before id validation') },
  batch() { throw new Error('DB touched before id validation') },
})
const cancelReq = (body) => new Request('https://x.test', { method: 'POST', body: JSON.stringify(body) })

for (const id of ['', 'a'.repeat(65), 'abc def', "x' OR 1=1--", '../etc', 42, ['a'], { a: 1 }, null]) {
  test(`cancel rejects id ${JSON.stringify(id)} with 400 before touching the DB`, async () => {
    const res = await onRequestPost({ request: cancelReq({ id }), env: ENV(noTouchDB()), owner: OWNER })
    assert.equal(res.status, 400)
  })
}

test('a 64-char hyphenated id passes validation (reaches the lookup, 404)', async () => {
  const db = realDB()
  const res = await onRequestPost({ request: cancelReq({ id: 'a-'.repeat(32) }), env: ENV(db), owner: OWNER })
  assert.equal(res.status, 404)
})

test('record update fails AFTER the Google delete: 500 says the meeting was cancelled', async () => {
  const { db, id } = await seed()
  const calls = []
  googleApi.fetch = async (url, opts) => { calls.push(opts?.method); return new Response(null, { status: 204 }) }
  db.raw.exec('DROP TABLE public_bookings_cancelled')
  const res = await onRequestPost({ request: cancelReq({ id }), env: ENV(db), owner: OWNER })
  assert.equal(res.status, 500)
  assert.deepEqual(calls, ['DELETE'])
  assert.match((await res.json()).error, /meeting was cancelled/)
})

test('a failure BEFORE any Google delete: plain 500 that does not claim the meeting was cancelled', async () => {
  const { db, id } = await seed()
  let called = false
  googleApi.fetch = async () => { called = true; return new Response(null, { status: 204 }) }
  const broken = { ...db, prepare(sql) { if (sql.includes('FROM public_bookings')) throw new Error('D1 down'); return db.prepare(sql) } }
  const res = await onRequestPost({ request: cancelReq({ id }), env: ENV(broken), owner: OWNER })
  assert.equal(res.status, 500)
  assert.equal(called, false)
  const { error } = await res.json()
  assert.equal(error, 'Could not cancel the booking')
})

// ---------------------------------------------------------------------------
// Outbound webhook: booking.cancelled is emitted once, through waitUntil,
// only after the row moved -- never on 404 / 502 / 500.
// ---------------------------------------------------------------------------

import { createHmac } from 'node:crypto'
import { webhookApi } from '../src/core/booking-webhook.js'

const HOOK = { BOOKING_WEBHOOK_URL: 'https://example.com/hooks/meet', BOOKING_WEBHOOK_SECRET: 'shh' }
const HOOK_ENV = (db) => ({ ...ENV(db), ...HOOK })
const quiet = () => { const o = console.log; console.log = () => {}; return () => { console.log = o } }
function hookStub() {
  const hooks = []
  webhookApi.fetch = async (url, opts) => { hooks.push({ url, opts }); return new Response(null, { status: 204 }) }
  return hooks
}
async function cancelWith(db, id, env = HOOK_ENV(db)) {
  const pending = []
  const res = await onRequestPost({ request: cancelReq({ id }), env, owner: OWNER, waitUntil: (p) => pending.push(p) })
  await Promise.all(pending)
  return { res, pending }
}

test('cancel emits booking.cancelled once, after the row moved, with cancelled_at/by matching the ledger', async () => {
  const { db, id } = await seed()
  googleApi.fetch = async () => new Response(null, { status: 204 })
  const hooks = hookStub()
  const restore = quiet()
  try {
    const { res, pending } = await cancelWith(db, id)
    assert.equal(res.status, 200)
    assert.equal(pending.length, 1)
    assert.equal(hooks.length, 1)
    const { opts } = hooks[0]
    assert.equal(opts.headers['X-Meet-Event'], 'booking.cancelled')
    assert.equal(opts.headers['X-Meet-Signature-256'],
      createHmac('sha256', HOOK.BOOKING_WEBHOOK_SECRET).update(opts.body, 'utf8').digest('hex'))
    const body = JSON.parse(opts.body)
    const led = db.raw.prepare('SELECT * FROM public_bookings_cancelled WHERE id = ?').get(id)
    assert.equal(body.type, 'booking.cancelled')
    assert.equal(body.id, id)
    assert.equal(body.booking.id, id)
    assert.equal(body.booking.attendee_email, 'v@example.org')
    assert.equal(body.booking.topic, 'Audit review')
    assert.equal(body.booking.cancelled_at, led.cancelled_at)
    assert.equal(body.booking.cancelled_by, OWNER)
    assert.equal('notes' in body.booking, false)
    assert.equal('client_ip' in body.booking, false)
  } finally { restore() }
})

test('cancel 404 (unknown id): no event', async () => {
  const db = realDB()
  const hooks = hookStub()
  const { res } = await cancelWith(db, 'a-'.repeat(32))
  assert.equal(res.status, 404)
  assert.equal(hooks.length, 0)
})

test('cancel 502 (Google failure): no event', async () => {
  const { db, id } = await seed()
  googleApi.fetch = async () => new Response('{}', { status: 500 })
  const hooks = hookStub()
  const { res } = await cancelWith(db, id)
  assert.equal(res.status, 502)
  assert.equal(hooks.length, 0)
})

test('cancel 500 (record update failed after the Google delete): no event', async () => {
  const { db, id } = await seed()
  googleApi.fetch = async () => new Response(null, { status: 204 })
  const hooks = hookStub()
  db.raw.exec('DROP TABLE public_bookings_cancelled')
  const { res } = await cancelWith(db, id)
  assert.equal(res.status, 500)
  assert.equal(hooks.length, 0)
})

test('cancel with the webhook unconfigured sends nothing', async () => {
  const { db, id } = await seed()
  googleApi.fetch = async () => new Response(null, { status: 204 })
  const hooks = hookStub()
  const { res } = await cancelWith(db, id, ENV(db))
  assert.equal(res.status, 200)
  assert.equal(hooks.length, 0)
})

// ---------------------------------------------------------------------------
// Recent (past 14 days) list for the no-show action.
// ---------------------------------------------------------------------------

test('the list also returns recent (ended within 14 days) bookings, newest first, with noShowAt', async () => {
  const { db } = await seed()   // one upcoming row (2099)
  const day = 86_400_000
  const iso = (ms) => new Date(ms).toISOString()
  const now = Date.now()
  const past = (name, startMs, over = {}) => savePublicBooking(db, { email: `${name}@example.org`, capIdentity: `${name}@example.org`,
    durationMinutes: 30, startUtc: iso(startMs), endUtc: iso(startMs + 1_800_000), eventId: name, meetUrlSource: 'fixed',
    calendarId: OWNER, topic: 'Audit review', notes: 'private stuff', clientIp: '203.0.113.9', ...over })
  const a = await past('a', now - 2 * day)
  const b = await past('b', now - 10 * day)
  await past('old', now - 20 * day)
  await markNoShow(db, { id: b, at: '2026-10-07T00:00:00.000Z', by: OWNER })

  const { bookings, recent } = await (await onRequestGet({ env: ENV(db) })).json()
  assert.equal(bookings.length, 1, 'upcoming list is unchanged')
  assert.deepEqual(recent.map((r) => r.id), [a, b])
  assert.deepEqual(Object.keys(recent[0]).sort(), [
    'attendeeEmail', 'attendeeName', 'company', 'durationMin', 'end', 'id', 'meetUrl', 'meetUrlSource', 'noShowAt', 'notes', 'start', 'topic',
  ])
  assert.equal(recent[0].noShowAt, '')
  assert.equal(recent[1].noShowAt, '2026-10-07T00:00:00.000Z')
  assert.equal(recent[0].attendeeEmail, 'a@example.org')
  assert.equal(recent[0].topic, 'Audit review')
})
