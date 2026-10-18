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

// ---------------------------------------------------------------------------
// Recent (past 14 days) list + "Mark no-show".
// ---------------------------------------------------------------------------

const RECENT = {
  id: 'r1', start: '2026-10-10T17:00:00.000Z', end: '2026-10-10T17:30:00.000Z',
  durationMin: 30, attendeeName: 'Pat Lee', attendeeEmail: 'pat@example.com',
  company: 'Westside', notes: '', meetUrl: 'https://meet.google.com/y', meetUrlSource: 'fixed',
  topic: 'Audit review', noShowAt: '',
}

async function mount({ bookings = [BOOKING], recent = [] }, onPost = () => new Response(JSON.stringify({ ok: true }))) {
  const calls = []
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/bookings.html', pretendToBeVisual: true })
  const { window } = dom
  let loads = 0
  window.fetch = async (input, init = {}) => {
    const u = String(input)
    const method = init.method || 'GET'
    if (method !== 'GET') { calls.push({ url: u, method, headers: init.headers || {}, body: init.body }); return onPost(u, init) }
    if (u.includes('/api/admin/bookings')) { loads++; return new Response(JSON.stringify({ bookings, recent })) }
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/admin/bookings.js?t=${Date.now()}${Math.random()}`)
  await settle()
  return { doc: window.document, window, calls, loads: () => loads }
}

test('a recent row shows date, attendee and topic, a Mark no-show button, and NO cancel UI', async () => {
  const { doc } = await mount({ recent: [RECENT] })
  const heading = [...doc.querySelectorAll('h2')].find((h) => h.textContent === 'Recent (past 14 days)')
  assert.ok(heading, 'expected a "Recent (past 14 days)" heading')
  const row = doc.querySelector('#bk-recent .bk-row')
  assert.ok(row, 'expected a recent row')
  // Shape only: fmt() renders in the host's time zone, so the calendar day
  // is not pinned (the existing tests in this file never assert a date either).
  assert.match(row.querySelector('.bk-when').textContent, /^\w{3}, \w{3} \d{1,2}, .*· 30 min$/)
  assert.match(row.querySelector('.bk-who').textContent, /Pat Lee · Westside — pat@example\.com/)
  assert.equal(row.querySelector('.bk-topic').textContent, 'Topic: Audit review')
  assert.equal(row.querySelector('.bk-cancel'), null, 'recent rows must not offer cancel')
  assert.equal(row.querySelector('.bk-noshow').textContent, 'Mark no-show')
  // The upcoming list is untouched: still exactly one cancel button on the page.
  assert.equal(doc.querySelectorAll('.bk-cancel').length, 1)
})

test('Mark no-show POSTs JSON {id} to /api/admin/no-show and reloads the lists', async () => {
  const { doc, window, calls, loads } = await mount({ recent: [RECENT] })
  assert.equal(loads(), 1)
  doc.querySelector('.bk-noshow').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  const call = calls.find((c) => c.url.includes('/api/admin/no-show'))
  assert.ok(call, 'expected a POST to /api/admin/no-show')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(call.body), { id: 'r1' })
  assert.equal(loads(), 2, 'the page reloads after marking')
})

test('a marked row shows the stamp instead of the button', async () => {
  const { doc } = await mount({ recent: [{ ...RECENT, noShowAt: '2026-10-11T09:00:00.000Z' }] })
  const row = doc.querySelector('#bk-recent .bk-row')
  assert.equal(row.querySelector('.bk-noshow'), null)
  assert.match(row.querySelector('.bk-noshow-stamp').textContent, /^No-show · \w{3}, \w{3} \d{1,2}, /)
})

test('a server error on Mark no-show is shown and the button stays usable', async () => {
  const { doc, window } = await mount({ recent: [RECENT] },
    () => new Response(JSON.stringify({ error: 'That call has not started yet' }), { status: 409 }))
  const btn = doc.querySelector('.bk-noshow')
  btn.dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  assert.equal(doc.getElementById('bk-error').hidden, false)
  assert.equal(doc.getElementById('bk-error').textContent, 'That call has not started yet')
  assert.equal(btn.disabled, false)
})

test('recent names are rendered as text, never markup', async () => {
  const { doc } = await mount({ recent: [{ ...RECENT, attendeeName: '<img src=x onerror=1>' }] })
  assert.equal(doc.querySelector('img'), null)
  assert.match(doc.querySelector('#bk-recent .bk-who').textContent, /<img src=x onerror=1>/)
})

test('no recent rows: the section says so', async () => {
  const { doc } = await mount({ recent: [] })
  assert.equal(doc.getElementById('bk-recent-empty').hidden, false)
})
