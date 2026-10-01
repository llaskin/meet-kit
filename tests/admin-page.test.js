import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Drive the REAL page, not a fixture, so this cannot drift from what ships.
const PAGE = readFileSync(fileURLToPath(new URL('../public/admin/index.html', import.meta.url)), 'utf8')

const settle = () => new Promise((r) => setTimeout(r, 150))

const CONFIG = {
  googleConfigured: true, turnstileConfigured: true, zohoConfigured: false,
  zohoAccountEmail: '', writeAccount: null, writeCalendarId: '', bookingCalendars: [],
  uniqueMeet: false, meetLink: '', internalAttendeeEmail: '',
  rules: { timezone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', minNoticeMinutes: 60, horizonDays: 14 },
}

// An attacker-shaped calendar name (round-tripped from Google through our own
// DB, not something this page can sanitise on the way in) and an
// attacker-shaped `?error=` query string (round-tripped from the OAuth
// callback's redirect). Neither must ever become a live DOM element.
const EVIL_CALENDAR_NAME = '<img src=x onerror=alert(1)>'
const EVIL_ERROR = '<script>x</script>'

async function boot() {
  const url = `https://x.test/admin/?${new URLSearchParams({ error: EVIL_ERROR })}`
  const dom = new JSDOM(PAGE, { url, pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input) => {
    const u = String(input)
    if (u.includes('/api/admin/config')) return new Response(JSON.stringify(CONFIG))
    if (u.includes('/api/admin/calendars')) {
      return new Response(JSON.stringify({
        connections: [{
          connectionId: 'google:owner@example.com', provider: 'google', role: 'busy',
          accountEmail: 'owner@example.com', writesEvents: false,
          calendars: [{ calendarId: 'cal1', name: EVIL_CALENDAR_NAME, busy: false }],
        }],
      }))
    }
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.location = window.location
  globalThis.fetch = window.fetch
  globalThis.URLSearchParams = window.URLSearchParams
  await import(`../public/admin/admin.js?t=${Date.now()}${Math.random()}`)
  await settle()
  return window
}

test('a malicious calendar name and a malicious ?error= query never become live elements', async () => {
  const window = await boot()
  const doc = window.document

  // Exactly the one static <script type="module"> the page ships with --
  // nothing was added by rendering the error or the calendar name.
  assert.equal(doc.querySelectorAll('script').length, 1)
  assert.equal(doc.querySelectorAll('img').length, 0)

  const flash = doc.getElementById('flash')
  assert.equal(flash.textContent, EVIL_ERROR, 'the error text must appear literally, not be parsed as markup')
  assert.equal(flash.querySelector('script'), null)

  const busyList = doc.getElementById('busy-list')
  assert.match(busyList.textContent, /<img src=x onerror=alert\(1\)>/, 'the calendar name must appear literally as text')
  assert.equal(busyList.querySelector('img'), null)
})

test('disconnecting the booking account needs a second click, then Connect booking account reappears', async () => {
  let connected = true
  let deletes = 0
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input, init) => {
    const u = String(input)
    if (init?.method === 'DELETE' && u.includes('/api/admin/connections/')) {
      deletes++
      connected = false
      return new Response(JSON.stringify({ ok: true }))
    }
    if (u.includes('/api/admin/config')) {
      return new Response(JSON.stringify({ ...CONFIG, writeAccount: connected ? 'owner@example.com' : null }))
    }
    if (u.includes('/api/admin/calendars')) {
      return new Response(JSON.stringify({
        connections: connected ? [{
          connectionId: 'google:owner@example.com', provider: 'google', role: 'write',
          accountEmail: 'owner@example.com', writesEvents: true, calendars: [],
        }] : [],
      }))
    }
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.location = window.location
  globalThis.fetch = window.fetch
  globalThis.URLSearchParams = window.URLSearchParams
  await import(`../public/admin/admin.js?t=${Date.now()}${Math.random()}`)
  await settle()

  const doc = window.document
  assert.equal(doc.getElementById('connect-write').style.display, 'none', 'already connected: the Connect button stays hidden')

  const btn = [...doc.getElementById('busy-list').querySelectorAll('button')].find((b) => b.textContent === 'Disconnect')
  assert.ok(btn, 'expected a Disconnect button for the connected account')

  btn.dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  assert.equal(deletes, 0, 'a single click must not disconnect anything')
  assert.equal(btn.textContent, 'Click again to disconnect')

  btn.dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  assert.equal(deletes, 1, 'a second click within the window disconnects')
  assert.equal(doc.getElementById('connect-write').style.display, 'inline-block', 'Connect booking account must reappear')
})

test('every admin write request carries Content-Type: application/json', async () => {
  // The server's CSRF gate 415s any non-GET /api/admin/* request that does
  // not carry this header and refuses a cross-site Origin -- so the PUT
  // /api/admin/config and PUT /api/admin/calendars calls, and the DELETE
  // /api/admin/connections/:id call, must all set it explicitly.
  let connected = true
  const calls = []
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input, init = {}) => {
    const u = String(input)
    const method = init.method || 'GET'
    if (method !== 'GET') calls.push({ url: u, method, headers: init.headers || {} })
    if (method === 'DELETE' && u.includes('/api/admin/connections/')) {
      connected = false
      return new Response(JSON.stringify({ ok: true }))
    }
    if (u.includes('/api/admin/config')) {
      return new Response(JSON.stringify({
        ...CONFIG, writeAccount: connected ? 'owner@example.com' : null, bookingCalendars: [{ id: 'cal1', name: 'Main' }],
      }))
    }
    if (u.includes('/api/admin/calendars')) {
      return new Response(JSON.stringify({
        connections: connected ? [{
          connectionId: 'google:owner@example.com', provider: 'google', role: 'write',
          accountEmail: 'owner@example.com', writesEvents: true,
          calendars: [{ calendarId: 'cal1', name: 'Main', busy: false }],
        }] : [],
      }))
    }
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.location = window.location
  globalThis.fetch = window.fetch
  globalThis.URLSearchParams = window.URLSearchParams
  await import(`../public/admin/admin.js?t=${Date.now()}${Math.random()}`)
  await settle()

  const doc = window.document

  // 1. Toggle a busy calendar -> PUT /api/admin/calendars.
  const checkbox = doc.querySelector('#busy-list input[type=checkbox]')
  assert.ok(checkbox, 'expected a calendar checkbox')
  checkbox.checked = !checkbox.checked
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }))
  await settle()

  // 2. Save settings -> PUT /api/admin/config.
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()

  // 3. Disconnect, with the required second click -> DELETE /api/admin/connections/:id.
  const disc = [...doc.getElementById('busy-list').querySelectorAll('button')].find((b) => b.textContent === 'Disconnect')
  assert.ok(disc, 'expected a Disconnect button')
  disc.dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  disc.dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()

  assert.ok(calls.some((c) => c.method === 'PUT' && c.url.includes('/api/admin/calendars')), 'expected a calendars PUT')
  assert.ok(calls.some((c) => c.method === 'PUT' && c.url.includes('/api/admin/config')), 'expected a config PUT')
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/api/admin/connections/')), 'expected a connections DELETE')
  for (const c of calls) {
    assert.equal(c.headers['Content-Type'], 'application/json', `${c.method} ${c.url} must carry Content-Type: application/json`)
  }
})
