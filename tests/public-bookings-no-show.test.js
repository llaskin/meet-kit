import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { realDB } from './helpers/d1.js'
import {
  savePublicBooking, getPublicBooking, cancelPublicBooking, listRecentPublic, markNoShow,
} from '../src/core/public-bookings.js'

const NOW = '2026-10-16T12:00:00.000Z'
const FROM = '2026-10-02T12:00:00.000Z'  // 14 days before NOW

const booking = (over = {}) => ({
  email: 'v@example.org', capIdentity: 'v@example.org', durationMinutes: 30,
  startUtc: '2026-10-10T15:00:00.000Z', endUtc: '2026-10-10T15:30:00.000Z', eventId: 'e1', ...over,
})

const cols = (db, t) => db.raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)

// --- Schema + migration ----------------------------------------------------

test('schema.sql carries no_show_at / no_show_by on BOTH booking tables', () => {
  const db = realDB()
  for (const t of ['public_bookings', 'public_bookings_cancelled']) {
    assert.ok(cols(db, t).includes('no_show_at'), `${t}.no_show_at`)
    assert.ok(cols(db, t).includes('no_show_by'), `${t}.no_show_by`)
  }
})

test('migration 002 adds the no-show columns to an existing pre-002 database', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE public_bookings (id TEXT PRIMARY KEY, topic TEXT);
           CREATE TABLE public_bookings_cancelled (id TEXT PRIMARY KEY, topic TEXT);`)
  db.exec(readFileSync(new URL('../migrations/002_booking_no_show.sql', import.meta.url), 'utf8'))
  for (const t of ['public_bookings', 'public_bookings_cancelled']) {
    const names = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    assert.ok(names.includes('no_show_at'), `${t}.no_show_at`)
    assert.ok(names.includes('no_show_by'), `${t}.no_show_by`)
  }
})

test('a cancelled no-show keeps its stamp in the ledger', async () => {
  const db = realDB()
  const id = await savePublicBooking(db, booking())
  await markNoShow(db, { id, at: NOW, by: 'owner@example.com' })
  const row = await getPublicBooking(db, id)
  await cancelPublicBooking(db, { row, cancelledAt: NOW, cancelledBy: 'owner@example.com' })
  const led = db.raw.prepare('SELECT no_show_at, no_show_by FROM public_bookings_cancelled WHERE id = ?').get(id)
  assert.equal(led.no_show_at, NOW)
  assert.equal(led.no_show_by, 'owner@example.com')
})

// --- listRecentPublic -------------------------------------------------------

test('listRecentPublic: started within the window (in progress included), newest start first; future and older rows excluded', async () => {
  const db = realDB()
  await savePublicBooking(db, booking({ id: 'old', startUtc: '2026-09-01T15:00:00.000Z', endUtc: '2026-09-01T15:30:00.000Z' }))
  await savePublicBooking(db, booking({ id: 'a', startUtc: '2026-10-05T15:00:00.000Z', endUtc: '2026-10-05T15:30:00.000Z' }))
  await savePublicBooking(db, booking({ id: 'b', startUtc: '2026-10-12T15:00:00.000Z', endUtc: '2026-10-12T15:30:00.000Z' }))
  // Started before the window start (ended inside it): EXCLUDED, the window is on start_utc.
  await savePublicBooking(db, booking({ id: 'edge', startUtc: '2026-10-02T11:30:00.000Z', endUtc: FROM }))
  // In progress right now (started, not ended): recent, so it can be marked a no-show.
  await savePublicBooking(db, booking({ id: 'live', startUtc: '2026-10-16T11:30:00.000Z', endUtc: NOW }))
  await savePublicBooking(db, booking({ id: 'future', startUtc: '2026-10-20T15:00:00.000Z', endUtc: '2026-10-20T15:30:00.000Z' }))

  const rows = await listRecentPublic(db, FROM, NOW)
  assert.deepEqual(rows.map((r) => r.id), ['live', 'b', 'a'])
  assert.equal(rows[0].no_show_at, null)
})

// --- markNoShow ---------------------------------------------------------------

test('markNoShow: unknown id -> {row:null}, nothing written', async () => {
  const db = realDB()
  const r = await markNoShow(db, { id: 'nope', at: NOW, by: 'o' })
  assert.deepEqual(r, { row: null })
})

test('markNoShow stamps the row once; a second call is already:true and does not overwrite', async () => {
  const db = realDB()
  const id = await savePublicBooking(db, booking())
  const first = await markNoShow(db, { id, at: NOW, by: 'owner@example.com' })
  assert.equal(first.already, false)
  assert.equal(first.row.no_show_at, NOW)
  assert.equal(first.row.no_show_by, 'owner@example.com')

  const second = await markNoShow(db, { id, at: '2026-10-17T00:00:00.000Z', by: 'other@example.com' })
  assert.equal(second.already, true)
  assert.equal(second.row.no_show_at, NOW, 'the original stamp must survive')
  assert.equal(second.row.no_show_by, 'owner@example.com')
  const stored = db.raw.prepare('SELECT no_show_at, no_show_by FROM public_bookings WHERE id = ?').get(id)
  assert.equal(stored.no_show_at, NOW)
  assert.equal(stored.no_show_by, 'owner@example.com')
})
