import assert from 'node:assert/strict'
import { zonedWallTimeToUtc } from '../src/core/tz.js'
import test from 'node:test'
import { onRequestPost } from '../src/handlers/public-book.js'
import { googleApi } from '../src/core/google-calendar.js'
import { turnstileApi } from '../src/core/turnstile.js'
import * as store from '../src/core/calendar-store.js'
import { realDB } from './helpers/d1.js'

// The fixed event title injected by the router from meet.config.json. Every
// onRequestPost call below passes it, matching the real worker wiring.
const SITE = { eventTitle: 'Intro call' }

const WRITE_ACCOUNT_EMAIL = 'owner@example.com'
const CONN_ID = `google:${WRITE_ACCOUNT_EMAIL}`
const MEET_URL = 'https://meet.google.com/abc-defg-hij'

/** Seed a working booking account + config, using the real store functions. */
async function seed(db, { meetLink = MEET_URL } = {}) {
  await store.setConfig(db, 'meet_link', meetLink)
  await store.saveConnection(db, {
    provider: 'google', role: 'write', refreshToken: 'rt',
    accountEmail: WRITE_ACCOUNT_EMAIL,
  })
  await store.upsertSelection(db, CONN_ID, WRITE_ACCOUNT_EMAIL, 'Owner calendar')
  return db
}

// --- Network stubs -----------------------------------------------------

function googleStub({ busy = [], onInsert } = {}) {
  const calls = []
  googleApi.fetch = async (url, opts) => {
    calls.push({ url, opts })
    if (url.includes('/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }))
    if (url.includes('/freeBusy')) {
      return new Response(JSON.stringify({ calendars: { [WRITE_ACCOUNT_EMAIL]: { busy } } }))
    }
    if (onInsert) return onInsert(url, opts)
    return new Response(JSON.stringify({ id: 'evt-1', htmlLink: 'https://cal/evt-1' }))
  }
  return calls
}

function turnstileStub({ success = true, throwErr = false } = {}) {
  const calls = []
  turnstileApi.fetch = async (url, opts) => {
    calls.push({ url, opts })
    if (throwErr) throw new Error('Cloudflare unreachable')
    return new Response(JSON.stringify({ success }))
  }
  return calls
}

// --- Request builders ----------------------------------------------------

// A hardcoded date rots, and now also fails outright: /api/public/book requires
// the window to be a slot the public grid actually OFFERS, so it must fall on a
// weekday inside business hours and inside the horizon measured from today.
function bookableDay(daysAhead = 3) {
  const d = new Date(Date.now() + daysAhead * 86_400_000)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}
const DAY = bookableDay()
const at = (hour, minute = 0) =>
  new Date(zonedWallTimeToUtc({ ...DAY, hour, minute }, 'America/New_York')).toISOString()

const body = (over = {}) => ({
  start: at(10), end: at(10, 30),
  duration_minutes: 30,
  attendee_email: 'visitor@example.com', attendee_name: 'Jane Visitor',
  practice: 'Northside Roofing', company: 'Northside Roofing', notes: '',
  website: '', turnstileToken: 'tok-good',
  ...over,
})

const req = (b, headers = {}) => new Request('https://x/api/public/book', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', ...headers },
  body: JSON.stringify(b),
})

const envWith = (db, extra = {}) => ({
  DB: db, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', TURNSTILE_SECRET_KEY: 'ts-secret', ...extra,
})

// --- Honeypot ------------------------------------------------------------

test('honeypot filled -> 400, and Turnstile is never called', async () => {
  const calls = turnstileStub()
  googleStub()
  const db = await seed(realDB())
  const res = await onRequestPost({ request: req(body({ website: 'http://spam.example' })), env: envWith(db), site: SITE })
  assert.equal(res.status, 400)
  assert.equal(calls.length, 0, 'Turnstile must not be spent on a honeypot hit')
})

test('the honeypot refusal reveals nothing about why', async () => {
  turnstileStub()
  const db = await seed(realDB())
  const res = await onRequestPost({ request: req(body({ website: 'x' })), env: envWith(db), site: SITE })
  // Assert the STATUS too. Without it, deleting the honeypot check makes this
  // test fail only by accident -- out.error is undefined on a 200 and
  // .toLowerCase() throws -- which is not a check, it is luck.
  assert.equal(res.status, 400)
  const out = await res.json()
  const lower = out.error.toLowerCase()
  for (const word of ['honeypot', 'bot', 'spam']) {
    assert.equal(lower.includes(word), false, `error text must not contain "${word}"`)
  }
})

// --- Turnstile -------------------------------------------------------------

test('an invalid Turnstile token -> 400', async () => {
  turnstileStub({ success: false })
  googleStub()
  const db = await seed(realDB())
  const res = await onRequestPost({ request: req(body()), env: envWith(db), site: SITE })
  assert.equal(res.status, 400)
})

test('a Turnstile network failure fails closed -> 400', async () => {
  turnstileStub({ throwErr: true })
  const db = await seed(realDB())
  const res = await onRequestPost({ request: req(body()), env: envWith(db), site: SITE })
  assert.equal(res.status, 400)
})

test('a missing TURNSTILE_SECRET_KEY refuses even a token that would otherwise verify', async () => {
  const calls = turnstileStub({ success: true })
  const db = await seed(realDB())
  const res = await onRequestPost({ request: req(body()), env: { DB: db }, site: SITE })
  assert.equal(res.status, 400)
  assert.equal(calls.length, 0, 'no secret means verifyTurnstile must short-circuit before any fetch')
})

test('Turnstile is called only AFTER field validation -- a bad email must not spend the token', async () => {
  const calls = turnstileStub()
  const db = await seed(realDB())
  const res = await onRequestPost({
    request: req(body({ attendee_email: 'not-an-email' })), env: envWith(db), site: SITE,
  })
  assert.equal(res.status, 400)
  assert.equal(calls.length, 0)
})

// --- Duration / span ---------------------------------------------------

test('240 minutes is refused publicly, even when start/end agree with it', async () => {
  turnstileStub()
  const db = await seed(realDB())
  const res = await onRequestPost({
    request: req(body({ duration_minutes: 240, end: at(14) })),
    env: envWith(db), site: SITE,
  })
  assert.equal(res.status, 400)
})

test('a span that disagrees with duration_minutes is refused', async () => {
  turnstileStub()
  const db = await seed(realDB())
  const res = await onRequestPost({
    // duration_minutes says 30, but the actual window is 60 minutes.
    request: req(body({ duration_minutes: 30, end: at(11) })),
    env: envWith(db), site: SITE,
  })
  assert.equal(res.status, 400)
})

// --- Rate caps -----------------------------------------------------------

test('a 4th booking for one email within 24h is refused with 429', async () => {
  googleStub()
  const db = await seed(realDB())
  const email = 'capped@example.com'
  for (let i = 0; i < EMAIL_CAP(); i++) {
    turnstileStub()
    const res = await onRequestPost({
      request: req(body({
        attendee_email: email,
        start: at(9 + i), end: at(9 + i, 30),
      })),
      env: envWith(db), site: SITE,
    })
    assert.equal(res.status, 200, `booking ${i + 1} should succeed`)
  }
  turnstileStub()
  const res = await onRequestPost({
    request: req(body({ attendee_email: email, start: at(15), end: at(15, 30) })),
    env: envWith(db), site: SITE,
  })
  assert.equal(res.status, 429)
})

test('the 429 body reveals nothing about the cap', async () => {
  googleStub()
  const db = await seed(realDB())
  const email = 'capped2@example.com'
  for (let i = 0; i < EMAIL_CAP(); i++) {
    turnstileStub()
    await onRequestPost({
      request: req(body({
        attendee_email: email,
        start: at(9 + i), end: at(9 + i, 30),
      })),
      env: envWith(db), site: SITE,
    })
  }
  turnstileStub()
  const res = await onRequestPost({
    request: req(body({ attendee_email: email, start: at(15), end: at(15, 30) })),
    env: envWith(db), site: SITE,
  })
  assert.equal(res.status, 429)
  const out = await res.json()
  assert.ok(!/3/.test(out.error), 'must not reveal the cap value')
  const lower = out.error.toLowerCase()
  for (const phrase of ['limit', 'too many', 'already']) {
    assert.equal(lower.includes(phrase), false, `error text must not contain "${phrase}"`)
  }
})

test('a 6th booking from one IP within 24h is refused with 429', async () => {
  googleStub()
  const db = await seed(realDB())
  for (let i = 0; i < IP_CAP(); i++) {
    turnstileStub()
    const res = await onRequestPost({
      request: req(body({
        attendee_email: `ip-test-${i}@example.com`,
        start: at(9 + i), end: at(9 + i, 30),
      })),
      env: envWith(db), site: SITE,
    })
    assert.equal(res.status, 200, `booking ${i + 1} should succeed`)
  }
  turnstileStub()
  const res = await onRequestPost({
    request: req(body({
      attendee_email: 'ip-test-final@example.com',
      start: at(15), end: at(15, 30),
    })),
    env: envWith(db), site: SITE,
  })
  assert.equal(res.status, 429)
})

function EMAIL_CAP() { return 3 }
function IP_CAP() { return 5 }

// --- Conflict check ------------------------------------------------------

test('a calendar conflict -> 409 and nothing written', async () => {
  googleStub({ busy: [{ start: at(10, 15), end: at(11) }] })
  turnstileStub()
  const db = await seed(realDB())
  const res = await onRequestPost({ request: req(body()), env: envWith(db), site: SITE })
  assert.equal(res.status, 409)
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM public_bookings').get().n, 0)
})

// --- Success ---------------------------------------------------------------

test('a successful booking writes exactly one public_bookings row and nothing else', async () => {
  googleStub()
  turnstileStub()
  const db = await seed(realDB())
  const res = await onRequestPost({ request: req(body()), env: envWith(db), site: SITE })
  assert.equal(res.status, 200)
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM public_bookings').get().n, 1)
  // No assertions against any other table here: schema.sql defines no other
  // booking-shaped table this path could have written to instead.
})

test('the success response carries EXACTLY four keys and nothing else', async () => {
  // A substring denylist is vacuous: it only catches leaks whose names someone
  // already guessed. A mutant returning eventId, htmlLink, calendarId and the
  // write account's address passed the old version of this test. Pin the whole
  // shape instead -- anything new has to be added here deliberately.
  googleStub()
  turnstileStub()
  const db = await seed(realDB())
  const res = await onRequestPost({ request: req(body()), env: envWith(db), site: SITE })
  const out = await res.json()
  assert.deepEqual(Object.keys(out).sort(), ['end', 'meetUrl', 'ok', 'start'])
  assert.equal(out.ok, true)
})

test('notes are STORED but never mailed into the invite', async () => {
  // createEvent posts with sendUpdates=all, so anything in the description is
  // mailed from the operator's own Google account. Unbounded attacker text
  // there is a phishing relay. Notes go to D1 for the operator to read; the
  // invite body carries the Meet link and nothing else.
  const db = await seed(realDB())
  let sent = null
  turnstileStub()
  googleStub({ onInsert: (url, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({ id: 'e1' })) } })
  const res = await onRequestPost({
    request: req(body({ notes: 'Verify at https://evil.example' })), env: envWith(db), site: SITE,
  })
  assert.equal(res.status, 200)
  assert.equal(sent.description, `Join the meeting: ${MEET_URL}`)
  assert.ok(!sent.description.includes('evil.example'))
  assert.equal(db.raw.prepare('SELECT notes FROM public_bookings').get().notes,
    'Verify at https://evil.example', 'the operator still sees it in D1')
})

// --- Hardening from the adversarial review --------------------------------

test('the invite summary is FIXED and carries no caller text', async () => {
  // createEvent posts sendUpdates=all, so the summary is the subject line of
  // mail sent FROM the operator's Google account. Caller-controlled text there
  // is a phishing relay: "intro call with URGENT: password reset required".
  let sent = null
  googleStub({ onInsert: (u, o) => { sent = JSON.parse(o.body); return new Response(JSON.stringify({ id: 'e' })) } })
  turnstileStub()
  const db = await seed(realDB())
  await onRequestPost({
    request: req(body({ practice: 'URGENT: password reset required', company: 'URGENT' })),
    env: envWith(db), site: SITE,
  })
  assert.equal(sent.summary, 'Intro call')
  assert.ok(!sent.summary.includes('URGENT'))
})

test('caller text is length-capped before it reaches the invite or the database', async () => {
  let sent = null
  googleStub({ onInsert: (u, o) => { sent = JSON.parse(o.body); return new Response(JSON.stringify({ id: 'e' })) } })
  turnstileStub()
  const db = await seed(realDB())
  await onRequestPost({
    request: req(body({ attendee_name: 'N'.repeat(5000), company: 'C'.repeat(5000), notes: 'X'.repeat(50000) })),
    env: envWith(db), site: SITE,
  })
  const row = db.raw.prepare('SELECT attendee_name, company, notes FROM public_bookings').get()
  assert.equal(row.attendee_name.length, 80)
  assert.equal(row.company.length, 80)
  assert.equal(row.notes.length, 500)
  assert.ok(JSON.stringify(sent).length < 4000, 'the invite payload must not carry a 50KB body')
})

test('a window OFF the offered grid is refused', async () => {
  // Validating only the SPAN left the position unchecked: 03:00 on a Sunday in
  // 2031, or a date in 2019, would still reach the conflict check and query
  // the operator's personal, work and Zoho calendars -- a free/busy oracle
  // over arbitrary time.
  turnstileStub()
  googleStub()
  const db = await seed(realDB())
  for (const [start, end, why] of [
    ['2031-06-01T07:00:00.000Z', '2031-06-01T07:30:00.000Z', 'far future, 3am, a Sunday'],
    ['2019-01-07T14:00:00.000Z', '2019-01-07T14:30:00.000Z', 'in the past'],
    [at(3), at(3, 30), 'today but outside business hours'],
    [at(10, 7), at(10, 37), 'not aligned to the interval'],
  ]) {
    turnstileStub()
    const res = await onRequestPost({ request: req(body({ start, end })), env: envWith(db), site: SITE })
    assert.equal(res.status, 409, `${why} must be refused`)
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM public_bookings').get().n, 0)
  }
})

test('gmail aliases and dots collapse to ONE cap identity', async () => {
  // victim@, victim+1@ and v.ictim@gmail.com are one inbox. Counting the raw
  // address let an attacker send unlimited invites to a single victim.
  const { capIdentity } = await import('../src/handlers/public-book.js')
  const want = 'victim@gmail.com'
  for (const v of ['victim@gmail.com', 'Victim+1@gmail.com', 'v.ictim@gmail.com', 'VI.CTIM+spam@googlemail.com']) {
    assert.equal(capIdentity(v).replace('googlemail', 'gmail'), want, `${v} must collapse`)
  }
  // Dots are significant outside gmail; only the +tag is stripped there.
  assert.equal(capIdentity('a.b+tag@fastmail.com'), 'a.b@fastmail.com')
})

test('the per-email cap counts the identity, not the typed address', async () => {
  googleStub()
  const db = await seed(realDB())
  for (let i = 0; i < 3; i++) {
    turnstileStub()
    const res = await onRequestPost({
      request: req(body({ attendee_email: `victim+${i}@gmail.com`, start: at(9 + i), end: at(9 + i, 30) })),
      env: envWith(db), site: SITE,
    })
    assert.equal(res.status, 200, `alias ${i} should still book`)
  }
  turnstileStub()
  const res = await onRequestPost({
    request: req(body({ attendee_email: 'v.ictim@gmail.com', start: at(15), end: at(15, 30) })),
    env: envWith(db), site: SITE,
  })
  assert.equal(res.status, 429, 'a 4th alias of the same inbox must be capped')
  // The address the visitor typed is still what the operator sees.
  const rows = db.raw.prepare('SELECT attendee_email, cap_identity FROM public_bookings').all()
  assert.equal(rows[0].attendee_email, 'victim+0@gmail.com')
  assert.equal(rows[0].cap_identity, 'victim@gmail.com')
})

test('the same slot cannot be booked twice, even if both requests pass every check', async () => {
  // The cap and freeness checks both run BEFORE createEvent, so two concurrent
  // requests can pass them and both book the same window. A stateless Worker
  // cannot serialise that; UNIQUE(start_utc) can. Simulated here by booking the
  // same slot twice in sequence, which the membership check alone would allow
  // because the stub's busy list never changes.
  googleStub()
  const db = await seed(realDB())
  turnstileStub()
  assert.equal((await onRequestPost({ request: req(body()), env: envWith(db), site: SITE })).status, 200)
  turnstileStub()
  const second = await onRequestPost({
    request: req(body({ attendee_email: 'other@example.com' })), env: envWith(db), site: SITE,
  })
  assert.equal(second.status, 409, 'the second booking of one slot must lose')
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM public_bookings').get().n, 1)
})

test('a global cap bounds total calendar consumption across all visitors', async () => {
  // Per-email and per-IP caps bound ONE actor. Nothing bounded the sum: a
  // handful of addresses across a /64 could still take the operator's week.
  // 16 distinct half-hour slots exist in a 9-5 day, so slot scarcity cannot be
  // what stops this -- only the cap can.
  googleStub()
  const db = await seed(realDB())
  const slots = []
  for (let h = 9; h < 17; h++) { slots.push([at(h), at(h, 30)]); slots.push([at(h, 30), at(h + 1)]) }
  let booked = 0
  for (let i = 0; i < 14; i++) {
    turnstileStub()
    const [start, end] = slots[i]
    const res = await onRequestPost({
      request: req({ ...body(), attendee_email: `u${i}@example.com`, start, end },
                   { 'CF-Connecting-IP': `10.0.0.${i}` }),
      env: envWith(db), site: SITE,
    })
    if (res.status === 200) booked++
  }
  assert.equal(booked, 12, 'exactly the global cap should get through, then refusals')
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM public_bookings').get().n, 12)
})
