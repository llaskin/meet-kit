import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { turnstileApi } from '../src/core/turnstile.js'
import { onRequestGet as getTopics } from '../src/handlers/public-topics.js'
import { onRequestPost } from '../src/handlers/public-book.js'

const OWNER = 'owner@example.com'
const ENV = (db) => ({ DB: db, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', TURNSTILE_SECRET_KEY: 'ts' })
const realGoogle = googleApi.fetch
const realTurnstile = turnstileApi.fetch
test.afterEach(() => { googleApi.fetch = realGoogle; turnstileApi.fetch = realTurnstile })

async function seed({ topics, allowOther = false } = {}) {
  const db = realDB()
  await store.saveConnection(db, { provider: 'google', role: 'write', refreshToken: 'rt', accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: OWNER })
  await store.upsertSelection(db, `google:${OWNER}`, OWNER, 'Owner calendar')
  await store.setConfig(db, 'write_calendar_id', OWNER)
  await store.setConfig(db, 'write_calendar_meet', '0')
  await store.setConfig(db, 'meet_link', 'https://meet.example.com/fixed')
  await store.setConfig(db, 'rules_weekdays', '0,1,2,3,4,5,6')
  await store.setConfig(db, 'rules_start_time', '00:00')
  await store.setConfig(db, 'rules_end_time', '23:30')
  await store.setConfig(db, 'rules_min_notice_minutes', '0')
  await store.setConfig(db, 'rules_timezone', 'UTC')
  if (topics) await store.setConfig(db, 'meeting_topics', JSON.stringify(topics))
  await store.setConfig(db, 'allow_other_topic', allowOther ? '1' : '0')
  return db
}

function nextSlot() {
  let t = Math.ceil(Date.now() / 1_800_000) * 1_800_000 + 7_200_000
  if (new Date(t).getUTCHours() === 23 && new Date(t).getUTCMinutes() === 30) t += 3_600_000
  return { start: new Date(t).toISOString(), end: new Date(t + 1_800_000).toISOString() }
}

function stubs() {
  const calls = { google: [], turnstile: 0 }
  googleApi.fetch = async (url, opts = {}) => {
    calls.google.push({ url, method: opts.method || 'GET', body: opts.body })
    if (url.includes('/freeBusy')) return Response.json({ calendars: { [OWNER]: { busy: [] } } })
    if (opts.method === 'POST') return Response.json({ id: 'e1' })
    return Response.json({})
  }
  turnstileApi.fetch = async () => { calls.turnstile++; return Response.json({ success: true }) }
  return calls
}

const post = (db, extra) => onRequestPost({
  request: new Request('https://x.test/api/public/book', { method: 'POST',
    body: JSON.stringify({ ...nextSlot(), duration_minutes: 30, attendee_email: 'v@example.org', turnstileToken: 't', ...extra }),
    headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
  env: ENV(db), site: { eventTitle: 'Intro call' },
})
const summary = (calls) => JSON.parse(calls.google.find((c) => c.method === 'POST' && c.url.includes('/events')).body).summary

test('GET /api/public/topics returns the list and cache header', async () => {
  const res = await getTopics({ env: { DB: await seed({ topics: ['Audit review'], allowOther: true }) } })
  assert.deepEqual(await res.json(), { topics: ['Audit review'], allowOther: true })
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60')
})

test('GET /api/public/topics fails safe to empty, uncached', async () => {
  const res = await getTopics({ env: { DB: undefined } })
  assert.deepEqual(await res.json(), { topics: [], allowOther: false })
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
})

test('a listed topic goes into the title and the row', async () => {
  const db = await seed({ topics: ['Audit review'] })
  const calls = stubs()
  const res = await post(db, { topic_choice: 'Audit review' })
  assert.equal(res.status, 200)
  assert.equal(summary(calls), 'Intro call: Audit review')
  assert.equal(db.raw.prepare('SELECT topic FROM public_bookings').get().topic, 'Audit review')
})

test('Other with a valid custom topic is labelled', async () => {
  const db = await seed({ topics: ['Audit review'], allowOther: true })
  const calls = stubs()
  const res = await post(db, { topic_choice: '__other__', topic_custom: 'Partnership idea' })
  assert.equal(res.status, 200)
  assert.equal(summary(calls), 'Intro call: Other – Partnership idea')
})

test('a bad custom topic is refused before Turnstile is spent', async () => {
  const db = await seed({ topics: ['Audit review'], allowOther: true })
  const calls = stubs()
  const res = await post(db, { topic_choice: '__other__', topic_custom: 'visit evil.com' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /without links or contact details/)
  assert.equal(calls.turnstile, 0)
})

test('a removed topic gets the reload message; missing choice is required', async () => {
  const db = await seed({ topics: ['Audit review'] })
  stubs()
  const stale = await post(db, { topic_choice: 'Old topic' })
  assert.equal(stale.status, 400)
  assert.equal((await stale.json()).error, 'That topic is no longer offered. Please reload the page.')
  const missing = await post(db, {})
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error, 'Please choose what the call is about.')
})

test('Other when disabled is refused as stale', async () => {
  const db = await seed({ topics: ['Audit review'], allowOther: false })
  stubs()
  const res = await post(db, { topic_choice: '__other__', topic_custom: 'Partnership idea' })
  assert.equal(res.status, 400)
})

test('no topics configured: title unchanged, topic NULL', async () => {
  const db = await seed({})
  const calls = stubs()
  const res = await post(db, { topic_choice: 'ignored' })
  assert.equal(res.status, 200)
  assert.equal(summary(calls), 'Intro call')
  assert.equal(db.raw.prepare('SELECT topic FROM public_bookings').get().topic, null)
})
