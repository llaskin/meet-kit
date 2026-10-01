import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { turnstileApi } from '../src/core/turnstile.js'
import { onRequestPost } from '../src/handlers/public-book.js'

const OWNER = 'owner@example.com'
const ENV = (db) => ({ DB: db, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', TURNSTILE_SECRET_KEY: 'ts' })

async function seed({ meetFlag = '1', fixed = '' } = {}) {
  const db = realDB()
  await store.saveConnection(db, { provider: 'google', role: 'write', refreshToken: 'rt', accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: OWNER })
  await store.upsertSelection(db, `google:${OWNER}`, OWNER, 'Owner calendar')
  await store.setConfig(db, 'write_calendar_id', OWNER)
  await store.setConfig(db, 'write_calendar_meet', meetFlag)
  if (fixed) await store.setConfig(db, 'meet_link', fixed)
  // Monday-Sunday all day, so a near-future slot always exists.
  await store.setConfig(db, 'rules_weekdays', '0,1,2,3,4,5,6')
  await store.setConfig(db, 'rules_start_time', '00:00')
  await store.setConfig(db, 'rules_end_time', '23:30')
  await store.setConfig(db, 'rules_min_notice_minutes', '0')
  await store.setConfig(db, 'rules_timezone', 'UTC')
  return db
}

// A slot the grid will offer: next half hour boundary + 2h, in UTC.
function nextSlot() {
  let t = Math.ceil(Date.now() / 1_800_000) * 1_800_000 + 7_200_000
  // The day ends 23:30 UTC, so a 23:30 start never fits; skip to the next hour.
  if (new Date(t).getUTCHours() === 23 && new Date(t).getUTCMinutes() === 30) t += 3_600_000
  return { start: new Date(t).toISOString(), end: new Date(t + 1_800_000).toISOString() }
}

function google({ conf = 'success', link = 'https://meet.google.com/u', insertBody } = {}) {
  const calls = []
  googleApi.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body })
    if (url.includes('/freeBusy')) return Response.json({ calendars: { [OWNER]: { busy: [] } } })
    if (opts.method === 'POST') return Response.json(insertBody || { id: 'e1', hangoutLink: link, conferenceData: { createRequest: { status: { statusCode: conf } } } })
    if (opts.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({})
  }
  turnstileApi.fetch = async () => Response.json({ success: true })
  return calls
}

const post = (db, body) => onRequestPost({
  request: new Request('https://x.test/api/public/book', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
  env: ENV(db),
  site: { eventTitle: 'Intro call' },
})

test('books with a unique Meet link and records its source', async () => {
  const db = await seed()
  const calls = google()
  const s = nextSlot()
  const res = await post(db, { ...s, duration_minutes: 30, attendee_email: 'v@example.org', attendee_name: 'V', turnstileToken: 't' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).meetUrl, 'https://meet.google.com/u')
  const insert = calls.find((c) => c.method === 'POST' && c.url.includes('/events'))
  assert.equal(JSON.parse(insert.body).summary, 'Intro call')
  const row = db.raw.prepare('SELECT meet_url_source FROM public_bookings').get()
  assert.equal(row.meet_url_source, 'unique')
})

test('no unique Meet and no fixed link: refuses without touching Google', async () => {
  const db = await seed({ meetFlag: '0', fixed: '' })
  const calls = google()
  const res = await post(db, { ...nextSlot(), duration_minutes: 30, attendee_email: 'v@example.org', turnstileToken: 't' })
  assert.equal(res.status, 400)
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/events')).length, 0)
})

test('same-slot race: the losing request deletes its duplicate event', async () => {
  const db = await seed()
  const s = nextSlot()
  db.raw.prepare("INSERT INTO public_bookings (id, created_at, attendee_email, cap_identity, duration_min, start_utc, end_utc) VALUES ('x','2000-01-01T00:00:00Z','o@example.org','o@example.org',30,?,?)").run(s.start, s.end)
  // freeBusy reports free (the race window), so the handler proceeds to insert.
  const calls = google()
  const res = await post(db, { ...s, duration_minutes: 30, attendee_email: 'v@example.org', turnstileToken: 't' })
  assert.equal(res.status, 409)
  assert.ok(calls.some((c) => c.method === 'DELETE'), 'duplicate event must be deleted')
})
