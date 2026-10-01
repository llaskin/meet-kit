import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The REAL page and the REAL picker, wired together. The defect this covers
// lived precisely in the seam between meet.js and picker.js, so a test that
// stubbed openModal (as tests/meet-page.test.js does) could not have caught it.
const PAGE = readFileSync(fileURLToPath(new URL('../public/meet.html', import.meta.url)), 'utf8')

const slotsBody = (durationMinutes) => JSON.stringify({
  timezone: 'America/New_York',
  durationMinutes,
  slots: [{ start: '2026-09-18T16:30:00.000Z', end: '2026-09-18T17:00:00.000Z' }],
})

async function boot() {
  const dom = new JSDOM(PAGE, { url: 'https://calls.example.com/meet', pretendToBeVisual: true })
  const { window } = dom
  const slotsUrls = []
  window.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/api/public/slots')) {
      slotsUrls.push(u)
      return new Response(slotsBody(Number(new URL(u, 'https://x.co').searchParams.get('duration'))))
    }
    return new Response('{}')
  }
  for (const k of ['Event', 'Node', 'HTMLElement', 'CustomEvent']) globalThis[k] = window[k]
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/picker.js?t=${Date.now()}${Math.random()}`)
  // meet.js self-initialises against the global document on import. Do NOT also
  // call initMeet() -- that attaches a SECOND submit handler, which fires a
  // second openModal whose dropdown already carries the first one's value and
  // masks this exact bug behind a phantom second fetch.
  await import(`../public/meet.js?t=${Date.now()}${Math.random()}`)
  return { window, slotsUrls }
}

const settle = () => new Promise((r) => setTimeout(r, 150))

function submit(window, duration) {
  const d = window.document
  d.getElementById('meet-name').value = 'Dana Reed'
  d.getElementById('meet-email').value = 'dana@northside.example'
  d.getElementById('meet-duration').value = String(duration)
  d.getElementById('meet-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
}

const durationsOf = (urls) => urls.map((u) => new URL(u, 'https://x.co').searchParams.get('duration'))

test('the grid is fetched at the duration the visitor picked', async () => {
  // The regression: openModal is async and loads the grid on the way in, so
  // meet.js setting .bk-duration AFTERWARDS was too late -- and assigning
  // .value fires no change event. The visitor got a 30-minute grid under a
  // dropdown reading 60, which offered 12:30 against a 1pm meeting and then
  // failed at Confirm because the 30-minute span is not a legal 60-minute one.
  const { window, slotsUrls } = await boot()
  submit(window, 60)
  await settle()

  assert.deepEqual(durationsOf(slotsUrls), ['60'],
    'the FIRST (and only) slots request must carry the chosen duration')
})

test('the dropdown and the loaded grid never disagree', async () => {
  const { window, slotsUrls } = await boot()
  submit(window, 60)
  await settle()

  const shown = window.document.querySelector('#booking-modal .bk-duration').value
  assert.equal(shown, '60', 'the modal must display the chosen duration')
  // The heart of it: what is displayed and what was fetched must be the same
  // number. Asserting either alone still passes with the bug present.
  assert.equal(durationsOf(slotsUrls).at(-1), shown,
    'the rendered grid and the dropdown must describe the same meeting length')
})

test('the default 30 still loads a 30-minute grid', async () => {
  const { window, slotsUrls } = await boot()
  submit(window, 30)
  await settle()
  assert.deepEqual(durationsOf(slotsUrls), ['30'])
})

test('an initialDuration outside the offered list never requests duration=0', async () => {
  // select.value = '120' with no such option yields '', and Number('') is 0.
  // Without the option guard this silently requests a zero-length grid.
  const { window, slotsUrls } = await boot()
  const card = window.document.createElement('section')
  card.dataset.practice = 'Northside'
  window.MEETKIT_PICKER.openModal(card, {
    direct: true,
    slotsUrl: '/api/public/slots',
    bookUrl: '/api/public/book',
    durations: [30, 60],
    initialDuration: 120,
  })
  await settle()

  assert.deepEqual(durationsOf(slotsUrls), ['30'], 'must fall back to a real option')
  assert.equal(window.document.querySelector('#booking-modal .bk-duration').value, '30')
})

// ---------------------------------------------------------------------------
// The dropdown is live DURING the load, and a stale response cannot repaint.
//
// Same failure class as above -- grid and dropdown describing different meeting
// lengths -- but reached through timing rather than ordering. A cache-miss slot
// fetch takes seconds, and the duration is changeable that whole time.
// ---------------------------------------------------------------------------

// Distinct slot COUNTS per duration, so the rendered grid says unambiguously
// which response painted it.
const SLOTS_FOR = {
  30: ['2026-09-18T16:00:00.000Z', '2026-09-18T16:30:00.000Z', '2026-09-18T17:00:00.000Z'],
  60: ['2026-09-18T18:00:00.000Z'],
}

async function bootPicker() {
  const dom = new JSDOM(PAGE, { url: 'https://calls.example.com/meet', pretendToBeVisual: true })
  const { window } = dom
  const pending = []
  window.fetch = async (url) => {
    const u = String(url)
    if (!u.includes('/api/public/slots')) return new Response('{}')
    const duration = Number(new URL(u, 'https://x.co').searchParams.get('duration'))
    // Held open until the test releases it, so two loads can be in flight at
    // once and be completed in either order.
    return new Promise((resolve) => {
      pending.push({
        duration,
        release: () => resolve(new Response(JSON.stringify({
          timezone: 'America/New_York',
          durationMinutes: duration,
          slots: (SLOTS_FOR[duration] || []).map((start) => ({ start, end: start })),
        }))),
      })
    })
  }
  for (const k of ['Event', 'Node', 'HTMLElement', 'CustomEvent']) globalThis[k] = window[k]
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/picker.js?t=${Date.now()}${Math.random()}`)

  const card = window.document.createElement('section')
  card.dataset.practice = 'Northside'
  window.MEETKIT_PICKER.openModal(card, {
    direct: true, slotsUrl: '/api/public/slots', bookUrl: '/api/public/book',
    durations: [30, 60], initialDuration: 30,
  })
  await settle()

  const durSel = window.document.querySelector('#booking-modal .bk-duration')
  return {
    window, pending, durSel,
    change: async (v) => {
      durSel.value = String(v)
      durSel.dispatchEvent(new window.Event('change', { bubbles: true }))
      await settle()
    },
    release: async (duration) => {
      const p = pending.find((x) => x.duration === duration && !x.done)
      assert.ok(p, `no in-flight request for duration=${duration}`)
      p.done = true
      p.release()
      await settle()
    },
    slotCount: () => window.document.querySelectorAll('#booking-modal .bk-slot').length,
  }
}

test('changing the duration while availability is still loading is honoured', async () => {
  const p = await bootPicker()
  assert.deepEqual(p.pending.map((x) => x.duration), [30], 'the initial load must be in flight')

  // The visitor flips to 60 while "Loading availability…" is still on screen.
  await p.change(60)
  assert.deepEqual(p.pending.map((x) => x.duration), [30, 60],
    'the change must start a second load -- the listener cannot be attached after the first await')

  await p.release(30)
  await p.release(60)

  assert.equal(p.slotCount(), SLOTS_FOR[60].length, 'the 60-minute grid must be the one rendered')
  assert.equal(p.durSel.value, '60')
})

test('a slow stale response cannot repaint over the newer grid', async () => {
  const p = await bootPicker()
  await p.change(60)

  // Out of order on purpose: the newer 60 lands first, the older 30 straggles
  // in afterwards. Without the generation guard the straggler repaints, and the
  // visitor is back to a 30-minute grid under a dropdown reading 60.
  await p.release(60)
  assert.equal(p.slotCount(), SLOTS_FOR[60].length, 'the 60 response should have painted')

  await p.release(30)
  assert.equal(p.slotCount(), SLOTS_FOR[60].length, 'the stale 30 response must be discarded')
  assert.equal(p.durSel.value, '60')
})

test('a stale FAILED request cannot replace a good newer grid with an error', async () => {
  const dom = new JSDOM(PAGE, { url: 'https://calls.example.com/meet', pretendToBeVisual: true })
  const { window } = dom
  const pending = []
  window.fetch = async (url) => {
    const u = String(url)
    if (!u.includes('/api/public/slots')) return new Response('{}')
    const duration = Number(new URL(u, 'https://x.co').searchParams.get('duration'))
    return new Promise((resolve, reject) => pending.push({ duration, resolve, reject }))
  }
  for (const k of ['Event', 'Node', 'HTMLElement', 'CustomEvent']) globalThis[k] = window[k]
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/picker.js?t=${Date.now()}${Math.random()}`)

  const card = window.document.createElement('section')
  card.dataset.practice = 'Northside'
  window.MEETKIT_PICKER.openModal(card, {
    direct: true, slotsUrl: '/api/public/slots', bookUrl: '/api/public/book',
    durations: [30, 60], initialDuration: 30,
  })
  await settle()

  const durSel = window.document.querySelector('#booking-modal .bk-duration')
  durSel.value = '60'
  durSel.dispatchEvent(new window.Event('change', { bubbles: true }))
  await settle()

  // The newer 60 succeeds; the older 30 then fails.
  pending.find((x) => x.duration === 60).resolve(new Response(JSON.stringify({
    timezone: 'America/New_York', durationMinutes: 60,
    slots: SLOTS_FOR[60].map((start) => ({ start, end: start })),
  })))
  await settle()
  pending.find((x) => x.duration === 30).reject(new Error('network gone'))
  await settle()

  assert.equal(window.document.querySelectorAll('#booking-modal .bk-slot').length, SLOTS_FOR[60].length,
    'a stale network failure must not wipe the grid the visitor is looking at')
  // Scoped INSIDE .bk-slots: the modal carries its own permanent (hidden)
  // .bk-error box for booking failures, which is not a repaint of the grid.
  assert.equal(window.document.querySelectorAll('#booking-modal .bk-slots .bk-error').length, 0,
    'and must not show an error over a working grid')
})

// ---------------------------------------------------------------------------
// Reopening the modal must not stack listeners on the reused dropdown.
//
// ensureModal() returns ONE element for the life of the page, so every open
// shares durSel. Reachable on /meet by submitting, closing the picker, and
// submitting again -- exactly what a visitor does after a failed booking.
// ---------------------------------------------------------------------------

async function bootReopenable() {
  const dom = new JSDOM(PAGE, { url: 'https://calls.example.com/meet', pretendToBeVisual: true })
  const { window } = dom
  const slotsUrls = []
  const held = []
  let booked = 0
  window.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/api/public/book')) { booked++; return new Response(JSON.stringify({ ok: true, start: 'x' })) }
    if (!u.includes('/api/public/slots')) return new Response('{}')
    slotsUrls.push(u)
    const duration = Number(new URL(u, 'https://x.co').searchParams.get('duration'))
    return new Promise((resolve) => held.push(() => resolve(new Response(JSON.stringify({
      timezone: 'America/New_York', durationMinutes: duration,
      slots: [{ start: '2026-09-18T16:00:00.000Z', end: '2026-09-18T16:30:00.000Z' }],
    })))))
  }
  for (const k of ['Event', 'Node', 'HTMLElement', 'CustomEvent']) globalThis[k] = window[k]
  globalThis.window = window
  globalThis.document = window.document
  globalThis.fetch = window.fetch
  await import(`../public/picker.js?t=${Date.now()}${Math.random()}`)

  const opts = { direct: true, slotsUrl: '/api/public/slots', bookUrl: '/api/public/book', durations: [30, 60] }
  const open = async (name) => {
    const c = window.document.createElement('section')
    c.dataset.practice = name
    window.MEETKIT_PICKER.openModal(c, opts)
    await settle()
    held.shift()()          // let that open's initial load finish
    await settle()
  }
  return {
    window, slotsUrls, held, open,
    booked: () => booked,
    durSel: () => window.document.querySelector('#booking-modal .bk-duration'),
  }
}

test('reopening the modal does not stack duration listeners', async () => {
  const p = await bootReopenable()
  await p.open('Prospect A')
  await p.open('Prospect B')

  p.slotsUrls.length = 0
  const sel = p.durSel()
  sel.value = '60'
  sel.dispatchEvent(new p.window.Event('change', { bubbles: true }))
  await settle()

  assert.equal(p.slotsUrls.length, 1,
    'one change must trigger exactly ONE load, not one per previous open')
})

test('after reopening, picking a time still arms Confirm for real', async () => {
  // The stacked-listener payoff: a stale closure painted the slot buttons, so
  // clicking one set ITS `chosen` while confirm.onclick read the newest
  // closure's null -- Confirm looked enabled and silently did nothing.
  const p = await bootReopenable()
  await p.open('Prospect A')
  await p.open('Prospect B')

  const sel = p.durSel()
  sel.value = '60'
  sel.dispatchEvent(new p.window.Event('change', { bubbles: true }))
  await settle()
  // Drain every in-flight load, newest first, so a stale closure would be the
  // last to paint if any were still listening.
  while (p.held.length) { p.held.pop()(); await settle() }

  p.window.document.querySelector('#booking-modal #bk-email').value = 'x@y.co'
  p.window.document.querySelector('#booking-modal .bk-slot').click()
  await settle()

  const confirm = p.window.document.querySelector('#booking-modal .bk-confirm')
  assert.equal(confirm.disabled, false, 'picking a time must arm Confirm')
  confirm.click()
  await settle()
  assert.equal(p.booked(), 1, 'Confirm must actually send the booking, not silently no-op')
})
