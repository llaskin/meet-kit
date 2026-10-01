import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'

const tables = (db) => db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)

test('schema creates exactly the meet-kit tables', () => {
  assert.deepEqual(tables(realDB()), [
    'calendar_config', 'calendar_connections', 'calendar_selections',
    'public_bookings', 'public_bookings_cancelled', 'rate_counters',
  ])
})

test('only one write connection can ever exist', () => {
  const db = realDB().raw
  const ins = "INSERT INTO calendar_connections (connection_id, provider, role, refresh_token, account_email, connected_at) VALUES (?, 'google', ?, 'rt', ?, 'now')"
  db.prepare(ins).run('google:a@x.test', 'write', 'a@x.test')
  db.prepare(ins).run('google:b@x.test', 'busy', 'b@x.test')
  assert.throws(() => db.prepare(ins).run('google:c@x.test', 'write', 'c@x.test'), /UNIQUE/)
})

test('two live public bookings cannot share a start time', () => {
  const db = realDB().raw
  const ins = "INSERT INTO public_bookings (id, created_at, attendee_email, cap_identity, duration_min, start_utc, end_utc) VALUES (?, 'now', 'v@x.test', 'v@x.test', 30, '2030-01-01T15:00:00.000Z', '2030-01-01T15:30:00.000Z')"
  db.prepare(ins).run('a')
  assert.throws(() => db.prepare(ins).run('b'), /UNIQUE/)
})

test('meet_url_source accepts only unique or fixed', () => {
  const db = realDB().raw
  const ins = "INSERT INTO public_bookings (id, created_at, attendee_email, cap_identity, duration_min, start_utc, end_utc, meet_url_source) VALUES (?, 'now', 'v@x.test', 'v@x.test', 30, ?, ?, ?)"
  db.prepare(ins).run('a', '2030-01-01T15:00:00Z', '2030-01-01T15:30:00Z', 'unique')
  db.prepare(ins).run('b', '2030-01-02T15:00:00Z', '2030-01-02T15:30:00Z', 'fixed')
  assert.throws(() => db.prepare(ins).run('c', '2030-01-03T15:00:00Z', '2030-01-03T15:30:00Z', 'zoom'), /CHECK/)
})
