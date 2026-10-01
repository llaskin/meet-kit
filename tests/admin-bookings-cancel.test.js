import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { savePublicBooking } from '../src/core/public-bookings.js'
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
    meetUrl: 'https://meet.google.com/u', meetUrlSource: 'unique', calendarId: OWNER })
  return { db, id }
}

test('lists upcoming bookings with link source', async () => {
  const { db } = await seed()
  const { bookings } = await (await onRequestGet({ env: ENV(db) })).json()
  assert.equal(bookings.length, 1)
  assert.equal(bookings[0].meetUrlSource, 'unique')
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
