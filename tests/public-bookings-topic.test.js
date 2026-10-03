import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { realDB } from './helpers/d1.js'
import { savePublicBooking, getPublicBooking, cancelPublicBooking } from '../src/core/public-bookings.js'

const row = (topic) => ({ email: 'v@example.org', capIdentity: 'v@example.org', durationMinutes: 30,
  startUtc: '2099-01-01T15:00:00.000Z', endUtc: '2099-01-01T15:30:00.000Z', eventId: 'e1', topic })

test('topic is saved and carried into the cancellation ledger', async () => {
  const db = realDB()
  const id = await savePublicBooking(db, row('Other – Partnership idea'))
  const saved = await getPublicBooking(db, id)
  assert.equal(saved.topic, 'Other – Partnership idea')
  await cancelPublicBooking(db, { row: saved, cancelledAt: '2099-01-02T00:00:00Z', cancelledBy: 'owner@example.com' })
  assert.equal(db.raw.prepare('SELECT topic FROM public_bookings_cancelled').get().topic, 'Other – Partnership idea')
})

test('no topic stores NULL', async () => {
  const db = realDB()
  const id = await savePublicBooking(db, row(undefined))
  assert.equal((await getPublicBooking(db, id)).topic, null)
})

test('migration 001 adds topic to an existing pre-topic database', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE public_bookings (id TEXT PRIMARY KEY);
           CREATE TABLE public_bookings_cancelled (id TEXT PRIMARY KEY);`)
  db.exec(readFileSync(new URL('../migrations/001_booking_topic.sql', import.meta.url), 'utf8'))
  for (const t of ['public_bookings', 'public_bookings_cancelled']) {
    assert.ok(db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'topic'), t)
  }
})
