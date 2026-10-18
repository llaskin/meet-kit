import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import {
  isWebhookConfigured, signBody, bookingPayload, sendBookingWebhook, webhookApi,
} from '../src/core/booking-webhook.js'

const ENV = { BOOKING_WEBHOOK_URL: 'https://example.com/hooks/meet', BOOKING_WEBHOOK_SECRET: 'shh' }

// A full D1 row, including the two columns that must NEVER leave the Worker.
const ROW = {
  id: 'b1', created_at: '2026-10-16T10:00:00.000Z', attendee_email: 'v@example.org',
  cap_identity: 'v@example.org', attendee_name: 'V', company: 'Co', notes: 'private stuff',
  duration_min: 30, start_utc: '2026-10-20T15:00:00.000Z', end_utc: '2026-10-20T15:30:00.000Z',
  event_id: 'e1', meet_url: 'https://meet.google.com/u', client_ip: '203.0.113.9',
  calendar_id: 'owner@example.com', meet_url_source: 'unique', topic: 'Audit review',
}

/** Capture every outbound request; answer with `status` (or throw `err`). */
function capture({ status = 200, err } = {}) {
  const calls = []
  webhookApi.fetch = async (url, opts) => {
    calls.push({ url, opts })
    if (err) throw err
    return new Response(null, { status })
  }
  return calls
}

const silence = () => {
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  return { logs, restore: () => { console.log = orig } }
}

// --- isWebhookConfigured -------------------------------------------------

test('off by default: no URL, no secret, or an http:// URL all mean "not configured"', () => {
  assert.equal(isWebhookConfigured({}), false)
  assert.equal(isWebhookConfigured(undefined), false)
  assert.equal(isWebhookConfigured({ BOOKING_WEBHOOK_URL: 'https://example.com/h' }), false)
  assert.equal(isWebhookConfigured({ BOOKING_WEBHOOK_SECRET: 's' }), false)
  assert.equal(isWebhookConfigured({ BOOKING_WEBHOOK_URL: 'http://example.com/h', BOOKING_WEBHOOK_SECRET: 's' }), false)
  assert.equal(isWebhookConfigured({ BOOKING_WEBHOOK_URL: '', BOOKING_WEBHOOK_SECRET: 's' }), false)
  assert.equal(isWebhookConfigured(ENV), true)
})

// --- signBody ------------------------------------------------------------

test('signBody is lowercase-hex HMAC-SHA256 of the exact bytes', async () => {
  const body = '{"type":"booking.created","x":"é"}'
  const expected = createHmac('sha256', 'shh').update(body, 'utf8').digest('hex')
  assert.equal(await signBody('shh', body), expected)
  assert.match(await signBody('shh', body), /^[0-9a-f]{64}$/)
})

// --- bookingPayload --------------------------------------------------------

test('bookingPayload whitelists fields and never carries notes or client_ip', () => {
  const p = bookingPayload(ROW)
  assert.deepEqual(Object.keys(p).sort(), [
    'attendee_email', 'attendee_name', 'calendar_id', 'company', 'created_at', 'duration_min',
    'end_utc', 'event_id', 'id', 'meet_url', 'start_utc', 'topic',
  ])
  assert.equal(p.id, 'b1')
  assert.equal(p.topic, 'Audit review')
  assert.equal('notes' in p, false)
  assert.equal('client_ip' in p, false)
  assert.equal('cap_identity' in p, false)
})

test('bookingPayload passes through only the known extra fields', () => {
  const p = bookingPayload(ROW, {
    cancelled_at: '2026-10-17T00:00:00.000Z', cancelled_by: 'owner@example.com',
    no_show_at: 'x', no_show_by: 'y',
    notes: 'smuggled', client_ip: 'smuggled', anything: 'smuggled',
  })
  assert.equal(p.cancelled_at, '2026-10-17T00:00:00.000Z')
  assert.equal(p.cancelled_by, 'owner@example.com')
  assert.equal(p.no_show_at, 'x')
  assert.equal(p.no_show_by, 'y')
  assert.equal('notes' in p, false)
  assert.equal('client_ip' in p, false)
  assert.equal('anything' in p, false)
})

// --- sendBookingWebhook ----------------------------------------------------

test('unconfigured: no request, no log, {sent:false}', async () => {
  const calls = capture()
  const { logs, restore } = silence()
  try {
    const r = await sendBookingWebhook({}, { type: 'booking.created', booking: ROW })
    assert.deepEqual(r, { sent: false })
    assert.equal(calls.length, 0)
    assert.deepEqual(logs, [])
  } finally { restore() }
})

test('configured: ONE signed POST with the envelope, the three headers, and a timeout signal', async () => {
  const calls = capture({ status: 204 })
  const { logs, restore } = silence()
  try {
    const r = await sendBookingWebhook(ENV, { type: 'booking.created', booking: ROW })
    assert.deepEqual(r, { sent: true, status: 204 })
    assert.equal(calls.length, 1)
    const { url, opts } = calls[0]
    assert.equal(url, ENV.BOOKING_WEBHOOK_URL)
    assert.equal(opts.method, 'POST')
    assert.equal(opts.headers['Content-Type'], 'application/json')
    assert.equal(opts.headers['X-Meet-Event'], 'booking.created')
    assert.match(opts.headers['X-Meet-Delivery'], /^[0-9a-f-]{36}$/)
    assert.ok(opts.signal instanceof AbortSignal, 'a 10 s AbortController must bound the request')

    // The signature is over the EXACT bytes sent.
    const expected = createHmac('sha256', ENV.BOOKING_WEBHOOK_SECRET).update(opts.body, 'utf8').digest('hex')
    assert.equal(opts.headers['X-Meet-Signature-256'], expected)

    const env = JSON.parse(opts.body)
    assert.deepEqual(Object.keys(env).sort(), ['booking', 'id', 'occurred_at', 'type'])
    assert.equal(env.type, 'booking.created')
    assert.equal(env.id, 'b1')
    assert.ok(!Number.isNaN(Date.parse(env.occurred_at)))
    assert.equal(env.booking.attendee_email, 'v@example.org')
    assert.equal('notes' in env.booking, false)
    assert.equal('client_ip' in env.booking, false)
    assert.ok(!opts.body.includes('private stuff'))
    assert.ok(!opts.body.includes('203.0.113.9'))

    assert.deepEqual(logs, ['[booking-webhook] booking.created b1 -> 204'])
  } finally { restore() }
})

test('extra fields land in the booking object (cancel)', async () => {
  const calls = capture()
  const { restore } = silence()
  try {
    await sendBookingWebhook(ENV, {
      type: 'booking.cancelled', booking: ROW,
      extra: { cancelled_at: '2026-10-17T00:00:00.000Z', cancelled_by: 'owner@example.com' },
    })
    const env = JSON.parse(calls[0].opts.body)
    assert.equal(env.type, 'booking.cancelled')
    assert.equal(calls[0].opts.headers['X-Meet-Event'], 'booking.cancelled')
    assert.equal(env.booking.cancelled_at, '2026-10-17T00:00:00.000Z')
    assert.equal(env.booking.cancelled_by, 'owner@example.com')
  } finally { restore() }
})

test('a non-2xx reply is logged and reported, never thrown, and never retried', async () => {
  const calls = capture({ status: 500 })
  const { logs, restore } = silence()
  try {
    const r = await sendBookingWebhook(ENV, { type: 'booking.created', booking: ROW })
    assert.deepEqual(r, { sent: false, status: 500 })
    assert.equal(calls.length, 1)
    assert.deepEqual(logs, ['[booking-webhook] booking.created b1 -> 500'])
  } finally { restore() }
})

test('a network error (or abort) is logged as error and never thrown', async () => {
  const calls = capture({ err: Object.assign(new Error('aborted'), { name: 'AbortError' }) })
  const { logs, restore } = silence()
  try {
    const r = await sendBookingWebhook(ENV, { type: 'booking.no_show', booking: ROW })
    assert.deepEqual(r, { sent: false })
    assert.equal(calls.length, 1)
    assert.deepEqual(logs, ['[booking-webhook] booking.no_show b1 -> error'])
  } finally { restore() }
})
