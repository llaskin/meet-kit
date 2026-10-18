import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA } from './helpers/d1.js'
import { cancelBooking } from '../src/core/cancel-booking.js'
import { googleApi } from '../src/core/google-calendar.js'
import * as store from '../src/core/calendar-store.js'
import { savePublicBooking } from '../src/core/public-bookings.js'

const CFG = { google_client_id: 'cid', google_client_secret: 'csec' }
const FUTURE = '2030-06-03T14:00:00.000Z'
const FUTURE_END = '2030-06-03T14:30:00.000Z'
const NOW = '2026-09-16T12:00:00.000Z'

/** Adapter that COUNTS writes, so "no D1 write happened" is directly provable. */
function countingDB() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  const writes = []
  const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)
  const mk = (sql) => ({
    sql, args: [],
    bind(...a) { this.args = a; return this },
    async run() {
      if (isWrite(sql)) writes.push(sql)
      db.prepare(sql).run(...this.args); return { success: true }
    },
    async first() { return db.prepare(sql).get(...this.args) ?? null },
    async all() { return { results: db.prepare(sql).all(...this.args) } },
  })
  return {
    raw: db, writes, prepare: mk,
    async batch(stmts) {
      db.exec('BEGIN')
      try {
        for (const s of stmts) { if (isWrite(s.sql)) writes.push(s.sql); db.prepare(s.sql).run(...s.args) }
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
      return stmts.map(() => ({ success: true }))
    },
  }
}

async function seedAccount(db) {
  await store.saveConnection(db, {
    provider: 'google', role: 'write', refreshToken: 'rt',
    accountEmail: 'owner@example.com',
    // A LIVE cached token, deliberately. Without it accessTokenFor() refreshes
    // on every call and persists the result via saveConnection -- a real D1
    // write that lands before deleteEvent is even attempted, and which would
    // make the "records NOTHING" assertion below fail on unrelated token
    // bookkeeping rather than on a cancellation actually being recorded.
    accessToken: 'at', expiresAt: '2099-01-01T00:00:00.000Z',
  })
}

function googleStub(deleteStatus) {
  const calls = []
  googleApi.fetch = async (url, opts) => {
    calls.push({ url, opts })
    if (url.includes('/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }))
    // null, not '': 204 is a "null body status" and `new Response('', {status:204})`
    // is a spec TypeError in current Node -- it throws inside the fixture before
    // any assertion runs, which looks like an implementation failure but is not.
    return new Response(null, { status: deleteStatus })
  }
  return calls
}

const seedPublic = (db, over = {}) => savePublicBooking(db, {
  id: 'pb1', email: 'd@x.co', capIdentity: 'd@x.co', name: 'D', company: '', notes: '',
  durationMinutes: 30, startUtc: FUTURE, endUtc: FUTURE_END,
  eventId: 'evt-pub', meetUrl: null, clientIp: null, ...over,
})

test('a public cancel moves the row to the ledger', async () => {
  const db = countingDB(); await seedAccount(db)
  await seedPublic(db)
  googleStub(204)

  const r = await cancelBooking(db, CFG, { id: 'pb1', cancelledBy: 'u', nowIso: NOW })

  assert.equal(r.ok, true)
  assert.equal(db.raw.prepare(`SELECT COUNT(*) c FROM public_bookings`).get().c, 0)
  assert.equal(db.raw.prepare(`SELECT COUNT(*) c FROM public_bookings_cancelled`).get().c, 1)
})

test('an unknown booking is a 404 and touches nothing', async () => {
  const db = countingDB(); await seedAccount(db)
  googleStub(204)
  const before = db.writes.length   // seedAccount() writes; measure from here
  const r = await cancelBooking(db, CFG, { id: 'nope', cancelledBy: 'u', nowIso: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.status, 404)
  assert.deepEqual(db.writes.slice(before), [])
})

test('a Google failure records NOTHING', async () => {
  // The assertion is on the write COUNT, not on re-reading status. The weaker
  // form of this assertion has passed against a broken implementation here.
  // Repointed from the removed internal-source test: the public-only
  // cancelBooking() still deletes the Google event before touching D1, so the
  // guarantee this test protects is unchanged.
  const db = countingDB(); await seedAccount(db)
  await seedPublic(db)
  googleStub(500)
  const before = db.writes.length

  const r = await cancelBooking(db, CFG, { id: 'pb1', cancelledBy: 'u', nowIso: NOW })

  assert.equal(r.ok, false)
  assert.equal(r.status, 502)
  assert.deepEqual(db.writes.slice(before), [], 'no write may reach D1 after a failed delete')
  assert.equal(db.raw.prepare(`SELECT COUNT(*) c FROM public_bookings`).get().c, 1,
    'the booking must still be live, not moved')
})

test('an event already deleted in Google still records the cancellation', async () => {
  // Repointed from the removed internal-source test; same guarantee, public row.
  const db = countingDB(); await seedAccount(db)
  await seedPublic(db)
  googleStub(404)

  const r = await cancelBooking(db, CFG, { id: 'pb1', cancelledBy: 'u', nowIso: NOW })

  assert.equal(r.ok, true)
  assert.equal(r.alreadyGone, true)
  assert.equal(db.raw.prepare(`SELECT COUNT(*) c FROM public_bookings_cancelled`).get().c, 1)
})

test('it deletes from the calendar the event was BOOKED on, not the current one', async () => {
  // The operator repoints write_calendar_id after the meeting was booked.
  // Targeting the CURRENT calendar would 404, and the 404-means-already-gone
  // rule would then record a cancellation while the event survived on the old
  // calendar with nobody emailed -- verbatim the failure this module exists to
  // prevent. Repointed from the removed internal-source test; same guarantee,
  // public row. cfg.write_calendar_id comes from the argument now, not D1.
  const db = countingDB(); await seedAccount(db)
  await seedPublic(db, { calendarId: 'old@group.calendar.google.com' })
  const calls = googleStub(204)

  const r = await cancelBooking(
    db, { ...CFG, write_calendar_id: 'new@group.calendar.google.com' },
    { id: 'pb1', cancelledBy: 'u', nowIso: NOW },
  )

  assert.equal(r.ok, true)
  assert.equal(r.alreadyGone, false, 'the event was really there and really deleted')
  const del = calls.find((c) => c.opts?.method === 'DELETE')
  assert.match(decodeURIComponent(del.url), /calendars\/old@group\.calendar\.google\.com\//,
    'must target the stored calendar')
  assert.ok(!decodeURIComponent(del.url).includes('new@group'), 'must NOT use the current config')
})

test('a booking predating the calendar_id column falls back to config', async () => {
  // Historical rows have calendar_id NULL. Config is what they were booked with.
  // Repointed from the removed internal-source test; same guarantee, public row.
  const db = countingDB(); await seedAccount(db)
  await seedPublic(db)   // no calendarId
  const calls = googleStub(204)

  await cancelBooking(
    db, { ...CFG, write_calendar_id: 'legacy@group.calendar.google.com' },
    { id: 'pb1', cancelledBy: 'u', nowIso: NOW },
  )

  const del = calls.find((c) => c.opts?.method === 'DELETE')
  assert.match(decodeURIComponent(del.url), /calendars\/legacy@group\.calendar\.google\.com\//)
})

test('a successful cancel returns the row it moved, so the caller can describe it', async () => {
  const db = countingDB(); await seedAccount(db)
  await seedPublic(db, { topic: 'Audit review' })
  googleStub(204)

  const r = await cancelBooking(db, CFG, { id: 'pb1', cancelledBy: 'u', nowIso: NOW })

  assert.equal(r.ok, true)
  assert.equal(r.row.id, 'pb1')
  assert.equal(r.row.attendee_email, 'd@x.co')
  assert.equal(r.row.topic, 'Audit review')
  assert.equal(r.row.start_utc, FUTURE)
})
