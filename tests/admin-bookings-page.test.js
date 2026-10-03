import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Drive the REAL page, not a fixture, so this cannot drift from what ships.
const PAGE = readFileSync(fileURLToPath(new URL('../public/admin/bookings.html', import.meta.url)), 'utf8')

const settle = () => new Promise((r) => setTimeout(r, 150))

const BOOKING = {
  id: 'b1', start: '2026-10-12T17:00:00.000Z', end: '2026-10-12T17:30:00.000Z',
  durationMin: 30, attendeeName: 'Dana Reed', attendeeEmail: 'dana@example.com',
  company: 'Northside', notes: '', meetUrl: 'https://meet.google.com/x', meetUrlSource: 'unique',
}

test('cancelling a booking POSTs Content-Type: application/json and a bare {id}', async () => {
  // The server's CSRF gate 415s a non-GET /api/admin/* request without this
  // header, and the source project's sheet/cardId discriminator is gone from
  // meet-kit's schema -- the cancel body is just the booking id.
  const calls = []
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/bookings.html', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input, init = {}) => {
    const u = String(input)
    const method = init.method || 'GET'
    if (method !== 'GET') calls.push({ url: u, method, headers: init.headers || {}, body: init.body })
    if (u.includes('/api/admin/cancel')) return new Response(JSON.stringify({ ok: true }))
    if (u.includes('/api/admin/bookings')) return new Response(JSON.stringify({ bookings: [BOOKING] }))
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/admin/bookings.js?t=${Date.now()}${Math.random()}`)
  await settle()

  const doc = window.document
  const tag = doc.querySelector('.bk-tag')
  assert.equal(tag.textContent, 'unique Meet', 'the Meet-link source must be shown next to the booking')

  const cancelBtn = doc.querySelector('.bk-cancel')
  assert.ok(cancelBtn, 'expected a Cancel meeting button')
  cancelBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()

  const confirmBtn = doc.querySelector('.bk-confirm-cancel')
  assert.ok(confirmBtn, 'expected the two-step confirm box to appear')
  confirmBtn.dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()

  const cancelCall = calls.find((c) => c.url.includes('/api/admin/cancel'))
  assert.ok(cancelCall, 'expected a POST to /api/admin/cancel')
  assert.equal(cancelCall.method, 'POST')
  assert.equal(cancelCall.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(cancelCall.body), { id: 'b1' })
})

test('a booking topic is shown literally, never parsed as markup', async () => {
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/bookings.html', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input) => {
    const u = String(input)
    if (u.includes('/api/admin/bookings')) {
      return new Response(JSON.stringify({ bookings: [{ ...BOOKING, topic: '<b>x</b>' }] }))
    }
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/admin/bookings.js?t=${Date.now()}${Math.random()}`)
  await settle()

  const doc = window.document
  const topic = doc.querySelector('.bk-topic')
  assert.ok(topic, 'expected a topic element')
  assert.equal(topic.textContent, 'Topic: <b>x</b>')
  assert.equal(doc.querySelector('b'), null, 'the topic markup must never become a live <b> element')
})

test('a booking with no topic renders no topic element', async () => {
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/bookings.html', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input) => {
    const u = String(input)
    if (u.includes('/api/admin/bookings')) return new Response(JSON.stringify({ bookings: [BOOKING] }))
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/admin/bookings.js?t=${Date.now()}${Math.random()}`)
  await settle()

  assert.equal(window.document.querySelector('.bk-topic'), null)
})

test('a fixed-link booking is labelled accordingly', async () => {
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/bookings.html', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input) => {
    const u = String(input)
    if (u.includes('/api/admin/bookings')) {
      return new Response(JSON.stringify({ bookings: [{ ...BOOKING, meetUrlSource: 'fixed' }] }))
    }
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/admin/bookings.js?t=${Date.now()}${Math.random()}`)
  await settle()

  assert.equal(window.document.querySelector('.bk-tag').textContent, 'fixed link')
})
