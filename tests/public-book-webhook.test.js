// booking.created is emitted exactly once, only after the D1 row is saved,
// and never on any refusal path. Harness mirrors public-book-meetkit.test.js.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { turnstileApi } from '../src/core/turnstile.js'
import { webhookApi } from '../src/core/booking-webhook.js'
import { onRequestPost } from '../src/handlers/public-book.js'

const OWNER = 'owner@example.com'
const HOOK = { BOOKING_WEBHOOK_URL: 'https://example.com/hooks/meet', BOOKING_WEBHOOK_SECRET: 'shh' }
const ENV = (db, extra = {}) => ({
  DB: db, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', TURNSTILE_SECRET_KEY: 'ts', ...HOOK, ...extra,
})

async function seed() {
  const db = realDB()
  await store.saveConnection(db, { provider: 'google', role: 'write', refreshToken: 'rt', accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: OWNER })
  await store.upsertSelection(db, `google:${OWNER}`, OWNER, 'Owner calendar')
  await store.setConfig(db, 'write_calendar_id', OWNER)
  await store.setConfig(db, 'write_calendar_meet', '1')
  await store.setConfig(db, 'rules_weekdays', '1,2,3,4,5,6,7')
  await store.setConfig(db, 'rules_start_time', '00:00')
  await store.setConfig(db, 'rules_end_time', '23:30')
  await store.setConfig(db, 'rules_min_notice_minutes', '0')
  await store.setConfig(db, 'rules_timezone', 'UTC')
  return db
}

function nextSlot() {
  let t = Math.ceil(Date.now() / 1_800_000) * 1_800_000 + 7_200_000
  if (new Date(t).getUTCHours() === 23 && new Date(t).getUTCMinutes() === 30) t += 3_600_000
  return { start: new Date(t).toISOString(), end: new Date(t + 1_800_000).toISOString() }
}

function stubs({ insertStatus = 200, turnstile = true } = {}) {
  googleApi.fetch = async (url, opts = {}) => {
    if (url.includes('/freeBusy')) return Response.json({ calendars: { [OWNER]: { busy: [] } } })
    if (opts.method === 'POST') {
      if (insertStatus !== 200) return new Response('{}', { status: insertStatus })
      return Response.json({ id: 'e1', hangoutLink: 'https://meet.google.com/u', conferenceData: { createRequest: { status: { statusCode: 'success' } } } })
    }
    if (opts.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({})
  }
  turnstileApi.fetch = async () => Response.json({ success: turnstile })
  const hooks = []
  webhookApi.fetch = async (url, opts) => { hooks.push({ url, opts }); return new Response(null, { status: 204 }) }
  return hooks
}

const quiet = () => { const o = console.log; console.log = () => {}; return () => { console.log = o } }

async function post(db, body, env = ENV(db)) {
  const pending = []
  const res = await onRequestPost({
    request: new Request('https://x.test/api/public/book', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
    env,
    site: { eventTitle: 'Intro call' },
    waitUntil: (p) => pending.push(p),
  })
  await Promise.all(pending)
  return { res, pending }
}

const GOOD = (s) => ({ ...s, duration_minutes: 30, attendee_email: 'V@Example.org', attendee_name: 'V', company: 'Co', notes: 'private stuff', turnstileToken: 't' })

test('a successful booking emits booking.created exactly once, after the save, with the saved row', async () => {
  const db = await seed()
  const hooks = stubs()
  const restore = quiet()
  try {
    const s = nextSlot()
    const { res, pending } = await post(db, GOOD(s))
    assert.equal(res.status, 200)
    assert.equal(pending.length, 1, 'exactly one waitUntil promise')
    assert.equal(hooks.length, 1, 'exactly one webhook request')

    const row = db.raw.prepare('SELECT * FROM public_bookings').get()
    const { url, opts } = hooks[0]
    assert.equal(url, HOOK.BOOKING_WEBHOOK_URL)
    assert.equal(opts.headers['X-Meet-Event'], 'booking.created')
    assert.equal(opts.headers['X-Meet-Signature-256'],
      createHmac('sha256', HOOK.BOOKING_WEBHOOK_SECRET).update(opts.body, 'utf8').digest('hex'))

    const env = JSON.parse(opts.body)
    assert.equal(env.type, 'booking.created')
    assert.equal(env.id, row.id)
    assert.deepEqual(env.booking, {
      id: row.id, created_at: row.created_at, attendee_email: 'v@example.org', attendee_name: 'V',
      company: 'Co', duration_min: 30, start_utc: s.start, end_utc: s.end, topic: null,
      meet_url: 'https://meet.google.com/u', event_id: 'e1', calendar_id: OWNER,
    })
    assert.ok(!opts.body.includes('private stuff'), 'notes must never be sent')
    assert.ok(!opts.body.includes('203.0.113.9'), 'client_ip must never be sent')
  } finally { restore() }
})

test('the booking response does not wait on, and is not changed by, the webhook', async () => {
  const db = await seed()
  stubs()
  // A slow receiver: 50 ms before it answers.
  let delivered = false
  webhookApi.fetch = () => new Promise((r) => setTimeout(() => { delivered = true; r(new Response(null, { status: 204 })) }, 50))
  const pending = []
  const res = await onRequestPost({
    request: new Request('https://x.test/api/public/book', { method: 'POST', body: JSON.stringify(GOOD(nextSlot())), headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
    env: ENV(db), site: { eventTitle: 'Intro call' }, waitUntil: (p) => pending.push(p),
  })
  assert.equal(res.status, 200)
  assert.equal(delivered, false, 'the response must come back before the receiver answers')
  assert.deepEqual(Object.keys(await res.json()).sort(), ['end', 'meetUrl', 'ok', 'start'])
  assert.equal(pending.length, 1)
  const restore = quiet()
  await Promise.all(pending)
  restore()
  assert.equal(delivered, true)
})

test('unconfigured webhook: a successful booking sends nothing', async () => {
  const db = await seed()
  const hooks = stubs()
  const { res } = await post(db, GOOD(nextSlot()), ENV(db, { BOOKING_WEBHOOK_URL: '', BOOKING_WEBHOOK_SECRET: '' }))
  assert.equal(res.status, 200)
  assert.equal(hooks.length, 0)
})

// --- Refusals: no event, ever ----------------------------------------------

test('honeypot: no event', async () => {
  const db = await seed()
  const hooks = stubs()
  const { res } = await post(db, { ...GOOD(nextSlot()), website: 'x' })
  assert.equal(res.status, 400)
  assert.equal(hooks.length, 0)
})

test('field validation (bad email): no event', async () => {
  const db = await seed()
  const hooks = stubs()
  const { res } = await post(db, { ...GOOD(nextSlot()), attendee_email: 'nope' })
  assert.equal(res.status, 400)
  assert.equal(hooks.length, 0)
})

test('Turnstile failure: no event', async () => {
  const db = await seed()
  const hooks = stubs({ turnstile: false })
  const { res } = await post(db, GOOD(nextSlot()))
  assert.equal(res.status, 400)
  assert.equal(hooks.length, 0)
})

test('per-email cap: no event', async () => {
  const db = await seed()
  const hooks = stubs()
  const now = new Date().toISOString()
  for (let i = 0; i < 3; i++) {
    db.raw.prepare("INSERT INTO public_bookings (id, created_at, attendee_email, cap_identity, duration_min, start_utc, end_utc) VALUES (?, ?, 'v@example.org', 'v@example.org', 30, ?, ?)")
      .run(`c${i}`, now, `2099-01-0${i + 1}T15:00:00.000Z`, `2099-01-0${i + 1}T15:30:00.000Z`)
  }
  const { res } = await post(db, GOOD(nextSlot()))
  assert.equal(res.status, 429)
  assert.equal(hooks.length, 0)
})

test('a window off the offered grid: no event', async () => {
  const db = await seed()
  const hooks = stubs()
  const s = nextSlot()
  const off = { start: new Date(Date.parse(s.start) + 600_000).toISOString(), end: new Date(Date.parse(s.end) + 600_000).toISOString() }
  const { res } = await post(db, GOOD(off))
  assert.equal(res.status, 409)
  assert.equal(hooks.length, 0)
})

test('Google failure on create: no event', async () => {
  const db = await seed()
  const hooks = stubs({ insertStatus: 500 })
  const { res } = await post(db, GOOD(nextSlot()))
  assert.equal(res.status, 502)
  assert.equal(hooks.length, 0)
})

test('UNIQUE(start_utc) conflict after create: no event', async () => {
  const db = await seed()
  const hooks = stubs()
  const s = nextSlot()
  db.raw.prepare("INSERT INTO public_bookings (id, created_at, attendee_email, cap_identity, duration_min, start_utc, end_utc) VALUES ('x','2000-01-01T00:00:00Z','o@example.org','o@example.org',30,?,?)").run(s.start, s.end)
  const { res } = await post(db, GOOD(s))
  assert.equal(res.status, 409)
  assert.equal(hooks.length, 0)
})
