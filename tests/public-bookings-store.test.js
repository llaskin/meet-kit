import assert from 'node:assert/strict'
import test from 'node:test'
import { savePublicBooking, countRecentByEmail, countRecentByIp, purgeExpired } from '../src/core/public-bookings.js'
import { realDB, SCHEMA } from './helpers/d1.js'

const base = (over = {}) => ({
  email: 'a@b.co', name: 'A B', company: '', notes: '',
  durationMinutes: 30, startUtc: '2026-10-12T13:00:00.000Z', endUtc: '2026-10-12T13:30:00.000Z',
  eventId: 'evt1', meetUrl: 'https://meet.google.com/x', clientIp: '1.2.3.4', ...over,
})

test('the rate-limit indexes exist, or every booking table-scans', () => {
  // Repointed at meet-kit's combined schema.sql: the source asserted this
  // against the standalone migrations/004_public_bookings.sql, which doesn't
  // exist here. Task 2 renamed the email-cap index from idx_public_bookings_email
  // to idx_public_bookings_cap when consolidating migrations (it indexes
  // cap_identity, not the raw attendee email); idx_public_bookings_ip is unchanged.
  assert.match(SCHEMA, /CREATE INDEX IF NOT EXISTS idx_public_bookings_cap/i)
  assert.match(SCHEMA, /CREATE INDEX IF NOT EXISTS idx_public_bookings_ip/i)
})

test('a saved booking is counted for its email and its IP', async () => {
  const db = realDB()
  await savePublicBooking(db, base())
  assert.equal(await countRecentByEmail(db, 'a@b.co', 24), 1)
  assert.equal(await countRecentByIp(db, '1.2.3.4', 24), 1)
})

test('counts are scoped to the identifier', async () => {
  const db = realDB()
  await savePublicBooking(db, base())
  assert.equal(await countRecentByEmail(db, 'other@b.co', 24), 0)
  assert.equal(await countRecentByIp(db, '9.9.9.9', 24), 0)
})

test('email matching is case-insensitive', async () => {
  // Otherwise A@B.co trivially defeats the per-email cap.
  const db = realDB()
  await savePublicBooking(db, base({ email: 'A@B.co' }))
  assert.equal(await countRecentByEmail(db, 'a@b.co', 24), 1)
  assert.equal(await countRecentByEmail(db, 'A@B.CO', 24), 1)
})

test('bookings outside the window are not counted', async () => {
  const db = realDB()
  await savePublicBooking(db, base({ createdAt: '2020-01-01T00:00:00.000Z' }))
  assert.equal(await countRecentByEmail(db, 'a@b.co', 24), 0)
  assert.equal(await countRecentByIp(db, '1.2.3.4', 24), 0)
})

test('an absent IP counts as zero rather than matching every NULL row', async () => {
  const db = realDB()
  await savePublicBooking(db, base({ clientIp: null }))
  assert.equal(await countRecentByIp(db, '', 24), 0)
  assert.equal(await countRecentByIp(db, null, 24), 0)
})

test('savePublicBooking returns an id and stores every field', async () => {
  const db = realDB()
  const id = await savePublicBooking(db, base({ company: 'Northside', notes: 'expo' }))
  assert.ok(id)
  const row = db.raw.prepare('SELECT * FROM public_bookings WHERE id = ?').get(id)
  assert.equal(row.attendee_email, 'a@b.co')
  assert.equal(row.attendee_name, 'A B')
  assert.equal(row.company, 'Northside')
  assert.equal(row.notes, 'expo')
  assert.equal(row.duration_min, 30)
  assert.equal(row.event_id, 'evt1')
  assert.equal(row.client_ip, '1.2.3.4')
})

// --- Retention: the policy promises deletion, this enforces it -------------

test('IP is nulled 30 days after SUBMISSION, and the row survives', async () => {
  // Privacy Policy 6.1: "Scheduling abuse-prevention data (IP address) --
  // 30 days from submission". The IP only backs a 24h rate cap, so keeping it
  // longer serves nothing defensible. The booking record itself stays.
  const db = realDB()
  const now = Date.parse('2026-09-14T12:00:00.000Z')
  const old = new Date(now - 31 * 86_400_000).toISOString()
  const recent = new Date(now - 29 * 86_400_000).toISOString()
  await savePublicBooking(db, base({ id: 'old', createdAt: old, clientIp: '1.1.1.1' }))
  await savePublicBooking(db, base({ id: 'new', createdAt: recent, clientIp: '2.2.2.2', startUtc: '2026-10-01T13:00:00.000Z' }))

  await purgeExpired(db, { now })

  const rows = db.raw.prepare('SELECT id, client_ip FROM public_bookings ORDER BY id').all()
  assert.equal(rows.length, 2, 'neither row should be deleted yet')
  assert.equal(rows.find((r) => r.id === 'old').client_ip, null, 'IP past 30 days must be nulled')
  assert.equal(rows.find((r) => r.id === 'new').client_ip, '2.2.2.2', 'a recent IP must survive')
})

test('the row is deleted 24 months after the MEETING DATE, not the submission', async () => {
  // Privacy Policy 6.1: "24 months from the meeting date". A booking submitted
  // long ago for a meeting still in the future must NOT be deleted.
  const db = realDB()
  const now = Date.parse('2026-09-14T12:00:00.000Z')
  const monthsAgo = (n) => new Date(now - n * 30.44 * 86_400_000).toISOString()

  await savePublicBooking(db, base({ id: 'ancient-meeting', createdAt: monthsAgo(30), startUtc: monthsAgo(25), endUtc: monthsAgo(25) }))
  await savePublicBooking(db, base({ id: 'recent-meeting', createdAt: monthsAgo(30), startUtc: monthsAgo(3), endUtc: monthsAgo(3) }))
  await savePublicBooking(db, base({ id: 'future-meeting', createdAt: monthsAgo(30), startUtc: '2027-01-05T13:00:00.000Z', endUtc: '2027-01-05T13:30:00.000Z' }))

  await purgeExpired(db, { now })

  const ids = db.raw.prepare('SELECT id FROM public_bookings ORDER BY id').all().map((r) => r.id)
  assert.ok(!ids.includes('ancient-meeting'), 'a meeting 25 months past must be deleted')
  assert.ok(ids.includes('recent-meeting'), 'a meeting 3 months past must survive')
  assert.ok(ids.includes('future-meeting'),
    'a booking submitted 30 months ago for a FUTURE meeting must survive -- the clock is the meeting date')
})

test('purge reports what it did', async () => {
  const db = realDB()
  const now = Date.parse('2026-09-14T12:00:00.000Z')
  await savePublicBooking(db, base({ id: 'a', createdAt: new Date(now - 40 * 86_400_000).toISOString() }))
  const r = await purgeExpired(db, { now })
  assert.equal(typeof r.ipsCleared, 'number')
  assert.equal(typeof r.rowsDeleted, 'number')
})

test('purge is idempotent and a no-op on fresh data', async () => {
  const db = realDB()
  const now = Date.parse('2026-09-14T12:00:00.000Z')
  await savePublicBooking(db, base({ createdAt: new Date(now - 86_400_000).toISOString(), startUtc: '2026-10-01T13:00:00.000Z' }))
  await purgeExpired(db, { now })
  await purgeExpired(db, { now })
  const row = db.raw.prepare('SELECT client_ip FROM public_bookings').get()
  assert.equal(row.client_ip, '1.2.3.4', 'fresh data must be untouched by repeated purges')
})

test('a purge failure never propagates', async () => {
  // It runs in waitUntil on a live request path. A broken purge must not take
  // a booking or a slot lookup down with it.
  const broken = { prepare() { throw new Error('D1 unavailable') } }
  await assert.doesNotReject(() => purgeExpired(broken, { now: Date.now() }))
})
