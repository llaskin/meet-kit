import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import {
  savePublicBooking, getPublicBooking, listUpcomingPublic, cancelPublicBooking,
  countRecentByEmail, countRecentByIp, countRecentTotal, purgeExpired,
} from '../src/core/public-bookings.js'

const FUTURE = '2030-06-03T14:00:00.000Z'
const FUTURE_END = '2030-06-03T14:30:00.000Z'
const PAST = '2020-01-01T14:00:00.000Z'
const NOW = '2026-09-16T12:00:00.000Z'

const seedPublic = (db, over = {}) => savePublicBooking(db, {
  id: 'pb1', email: 'dana@x.co', capIdentity: 'dana@x.co', name: 'Dana', company: 'Northside',
  notes: 'n', durationMinutes: 30, startUtc: FUTURE, endUtc: FUTURE_END,
  eventId: 'evt-pub', meetUrl: 'https://meet.google.com/a', clientIp: '1.2.3.4', ...over,
})

test('cancelPublicBooking MOVES the row to the ledger', async () => {
  const db = realDB()
  await seedPublic(db)
  const row = await getPublicBooking(db, 'pb1')

  await cancelPublicBooking(db, { row, cancelledAt: NOW, cancelledBy: 'user_1' })

  assert.equal(await getPublicBooking(db, 'pb1'), null, 'live row must be gone')
  const led = db.raw.prepare(`SELECT * FROM public_bookings_cancelled WHERE id='pb1'`).get()
  assert.ok(led, 'ledger row must exist')
  assert.equal(led.attendee_email, 'dana@x.co')
  assert.equal(led.event_id, 'evt-pub')
  assert.equal(led.cancelled_at, NOW)
  assert.equal(led.cancelled_by, 'user_1')
})

test('KEYSTONE: after cancelling, that exact slot can be booked again', async () => {
  // This is the whole reason the ledger exists instead of a status flag.
  // public_bookings has an inline UNIQUE (start_utc); a row left in place would
  // make the slot permanently unbookable while computeSlots kept offering it.
  // This test FAILS against a status-flag implementation.
  const db = realDB()
  await seedPublic(db)
  const row = await getPublicBooking(db, 'pb1')
  await cancelPublicBooking(db, { row, cancelledAt: NOW, cancelledBy: 'u' })

  await seedPublic(db, { id: 'pb2', email: 'someone@else.co', capIdentity: 'someone@else.co' })

  const again = await getPublicBooking(db, 'pb2')
  assert.equal(again.start_utc, FUTURE, 'the freed slot must accept a new booking')
})

test('listUpcomingPublic excludes past bookings and cancelled ones', async () => {
  const db = realDB()
  await seedPublic(db)                                                   // future, live -> shown
  await seedPublic(db, { id: 'old', startUtc: PAST, endUtc: PAST })      // past, live   -> hidden
  await seedPublic(db, { id: 'pb3', startUtc: '2030-06-05T14:00:00.000Z',
                         endUtc: '2030-06-05T14:30:00.000Z' })           // future, then cancelled
  const doomed = await getPublicBooking(db, 'pb3')
  await cancelPublicBooking(db, { row: doomed, cancelledAt: NOW, cancelledBy: 'u' })

  const rows = await listUpcomingPublic(db, NOW)
  // 'old' is excluded by the date filter; 'pb3' because cancelling MOVED it out.
  assert.deepEqual(rows.map((r) => r.id), ['pb1'])
})

test('cancelling does NOT refund the abuser\'s 24h quota', async () => {
  // The caps (3/email, 5/IP, 12 total per 24h) are row counts, and /api/public/book
  // has no request-rate limiter of its own -- they are the only bound on it. Since
  // cancelling MOVES the row out of public_bookings, counting just the live table
  // would make the operator's one remediation action the thing that un-blocks the
  // abuser. Confirmed refundable before this was fixed.
  const db = realDB()
  const mk = (i) => savePublicBooking(db, {
    id: 'ab' + i, email: 'abuser@x.co', capIdentity: 'abuser@x.co', name: 'A', company: '',
    notes: '', durationMinutes: 30,
    startUtc: `2030-07-0${i + 1}T14:00:00.000Z`, endUtc: `2030-07-0${i + 1}T14:30:00.000Z`,
    eventId: 'e' + i, meetUrl: null, clientIp: '9.9.9.9',
  })
  for (let i = 0; i < 3; i++) await mk(i)
  assert.equal(await countRecentByEmail(db, 'abuser@x.co', 24), 3, 'at the per-email cap')

  for (let i = 0; i < 3; i++) {
    await cancelPublicBooking(db, { row: await getPublicBooking(db, 'ab' + i), cancelledAt: NOW, cancelledBy: 'admin' })
  }

  assert.equal(await countRecentByEmail(db, 'abuser@x.co', 24), 3, 'still capped by email')
  assert.equal(await countRecentByIp(db, '9.9.9.9', 24), 3, 'still counted by IP')
  assert.equal(await countRecentTotal(db, 24), 3, 'still counted in the global backstop')
})

test('retention purges the cancellation ledger too', async () => {
  // A cancelled booking is still a record of a real person. The privacy policy's
  // promise -- IP nulled at 30 days, record deleted 24 months after the meeting --
  // does not stop applying because the meeting was cancelled.
  const db = realDB()
  await seedPublic(db, { id: 'old', startUtc: PAST, endUtc: PAST })
  await cancelPublicBooking(db, { row: await getPublicBooking(db, 'old'), cancelledAt: NOW, cancelledBy: 'a' })
  db.raw.exec(`UPDATE public_bookings_cancelled SET created_at = '2020-01-01T00:00:00.000Z'`)
  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM public_bookings_cancelled').get().c, 1)

  await purgeExpired(db)

  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM public_bookings_cancelled').get().c, 0,
    'a ledger row older than the retention window must be deleted')
})

test('retention clears old IPs from the ledger even when the record is kept', async () => {
  const db = realDB()
  await seedPublic(db, { id: 'recent' })   // start_utc is in 2030: far inside retention
  await cancelPublicBooking(db, { row: await getPublicBooking(db, 'recent'), cancelledAt: NOW, cancelledBy: 'a' })
  db.raw.exec(`UPDATE public_bookings_cancelled SET created_at = '2020-01-01T00:00:00.000Z'`)

  await purgeExpired(db)

  const row = db.raw.prepare(`SELECT * FROM public_bookings_cancelled WHERE id='recent'`).get()
  assert.ok(row, 'the record itself is still inside the 24-month window')
  assert.equal(row.client_ip, null, 'but its IP is past the 30-day window')
})

test('two concurrent cancels of one booking do not blow up', async () => {
  // A stale tab, or two admins. Previously the loser hit a PRIMARY KEY
  // violation on the ledger and 500'd, even though the durable outcome was
  // already correct. The move is idempotent now.
  const db = realDB()
  await seedPublic(db)
  const row = await getPublicBooking(db, 'pb1')

  const results = await Promise.allSettled([
    cancelPublicBooking(db, { row, cancelledAt: NOW, cancelledBy: 'admin1' }),
    cancelPublicBooking(db, { row, cancelledAt: NOW, cancelledBy: 'admin2' }),
  ])

  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'])
  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM public_bookings').get().c, 0)
  assert.equal(db.raw.prepare('SELECT COUNT(*) c FROM public_bookings_cancelled').get().c, 1,
    'exactly one ledger row, not two and not zero')
})

test('the ledger keeps the calendar the booking was made on', async () => {
  const db = realDB()
  await seedPublic(db, { calendarId: 'old@group.calendar.google.com' })
  await cancelPublicBooking(db, { row: await getPublicBooking(db, 'pb1'), cancelledAt: NOW, cancelledBy: 'u' })
  assert.equal(
    db.raw.prepare(`SELECT calendar_id FROM public_bookings_cancelled WHERE id='pb1'`).get().calendar_id,
    'old@group.calendar.google.com')
})
