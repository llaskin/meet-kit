import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// picker.js builds its own modal markup and then repaints parts of it from
// server responses. Any of those repaints that used innerHTML with
// interpolated server data (data.error, data.failedClosed/message, a day
// heading, a fetch-rejection err.message) would turn attacker-shaped text
// into live DOM in the visitor's own browser session. This file proves each
// of those paths now renders literal text via createElement/textContent.
const PAGE = readFileSync(fileURLToPath(new URL('../public/meet.html', import.meta.url)), 'utf8')
const EVIL = '<img src=x onerror=alert(1)>'
const settle = () => new Promise((r) => setTimeout(r, 150))

async function boot(fetchImpl) {
  const dom = new JSDOM(PAGE, { url: 'https://calls.example.com/meet', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = fetchImpl
  for (const k of ['Event', 'Node', 'HTMLElement', 'CustomEvent']) globalThis[k] = window[k]
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/picker.js?t=${Date.now()}${Math.random()}`)
  const card = window.document.createElement('section')
  card.dataset.practice = 'Northside'
  window.MEETKIT_PICKER.openModal(card, {
    slotsUrl: '/api/public/slots', bookUrl: '/api/public/book', durations: [30, 60],
  })
  await settle()
  return window
}

function assertNoLiveMarkup(window, box) {
  assert.equal(box.querySelector('img'), null, 'no <img> must be created from interpolated text')
  assert.match(box.textContent, /<img src=x onerror=alert\(1\)>/, 'the markup must appear literally as text')
}

test('an error field from /api/public/slots renders as literal text, not markup', async () => {
  const window = await boot(async (url) => {
    const u = String(url)
    if (u.includes('/api/public/slots')) return new Response(JSON.stringify({ slots: [], error: EVIL }))
    return new Response('{}')
  })
  const box = window.document.querySelector('#booking-modal .bk-slots')
  assertNoLiveMarkup(window, box)
})

test('a failedClosed message from /api/public/slots renders as literal text, not markup', async () => {
  const window = await boot(async (url) => {
    const u = String(url)
    if (u.includes('/api/public/slots')) {
      return new Response(JSON.stringify({ slots: [], failedClosed: true, message: EVIL }))
    }
    return new Response('{}')
  })
  const box = window.document.querySelector('#booking-modal .bk-slots')
  assertNoLiveMarkup(window, box)
})

test('a rejected slots fetch renders err.message as literal text, not markup', async () => {
  const window = await boot(async (url) => {
    const u = String(url)
    if (u.includes('/api/public/slots')) throw new Error(EVIL)
    return new Response('{}')
  })
  const box = window.document.querySelector('#booking-modal .bk-slots')
  assertNoLiveMarkup(window, box)
})

test('the day heading is rendered literally and the times box is still cleared on repaint', async () => {
  // The day heading itself is built from fixed slot data, not attacker input,
  // but renderTimes() must still use a non-innerHTML repaint so a prior day's
  // buttons do not survive alongside the new ones.
  const window = await boot(async (url) => {
    const u = String(url)
    if (u.includes('/api/public/slots')) {
      return new Response(JSON.stringify({
        timezone: 'America/New_York',
        slots: [
          { start: '2026-09-18T16:00:00.000Z', end: '2026-09-18T16:30:00.000Z' },
          { start: '2026-09-19T16:00:00.000Z', end: '2026-09-19T16:30:00.000Z' },
        ],
      }))
    }
    return new Response('{}')
  })
  const timesBox = window.document.querySelector('#booking-modal .bk-times')
  assert.match(timesBox.querySelector('.bk-day').textContent, /September/)
  const firstDayCount = timesBox.querySelectorAll('.bk-slot').length
  assert.equal(firstDayCount, 1)

  // Click the second day in the grid -> renderTimes() repaints.
  const days = [...window.document.querySelectorAll('#booking-modal .bk-has')]
  assert.equal(days.length, 2)
  days[1].click()
  const afterCount = timesBox.querySelectorAll('.bk-slot').length
  assert.equal(afterCount, 1, 'the previous day\'s slot button must not survive the repaint')
})
