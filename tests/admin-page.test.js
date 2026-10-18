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
  rules: { timezone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', intervalMinutes: 30, minNoticeMinutes: 60, bufferMinutes: 10, horizonDays: 14 },
}

// An attacker-shaped calendar name (round-tripped from Google through our own
// DB, not something this page can sanitise on the way in) and an
// attacker-shaped `?error=` query string (round-tripped from the OAuth
// callback's redirect). Neither must ever become a live DOM element.
const EVIL_CALENDAR_NAME = '<img src=x onerror=alert(1)>'
const EVIL_ERROR = '<script>x</script>'

// Like boot(), but lets a test override the config and the save/PUT response
// so the Connect-link gating can be exercised through a full load() cycle
// (including the re-entrant one load() runs after a Save).
async function bootWith(configOverrides, { connections = [] } = {}) {
  let cfg = { ...CONFIG, ...configOverrides }
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input, init = {}) => {
    const u = String(input)
    const method = init.method || 'GET'
    if (method === 'PUT' && u.includes('/api/admin/config')) {
      cfg = { ...cfg, ...JSON.parse(init.body) }
      return new Response(JSON.stringify({ ok: true }))
    }
    if (u.includes('/api/admin/config')) return new Response(JSON.stringify(cfg))
    if (u.includes('/api/admin/calendars')) return new Response(JSON.stringify({ connections }))
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

test('the two-click Disconnect confirm reverts to "Disconnect" after 5s with no second click', async () => {
  // Fake timer injected onto the jsdom window (admin.js calls
  // window.setTimeout/window.clearTimeout, not the bare Node globals), so
  // this never actually waits 5 real seconds.
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/', pretendToBeVisual: true })
  const { window } = dom
  let scheduled = null
  let cleared = 0
  window.setTimeout = (fn, ms) => { scheduled = { fn, ms }; return 1 }
  window.clearTimeout = () => { cleared++; scheduled = null }
  let deletes = 0
  window.fetch = async (input, init) => {
    const u = String(input)
    if (init?.method === 'DELETE' && u.includes('/api/admin/connections/')) { deletes++; return new Response(JSON.stringify({ ok: true })) }
    if (u.includes('/api/admin/config')) return new Response(JSON.stringify({ ...CONFIG, writeAccount: 'owner@example.com' }))
    if (u.includes('/api/admin/calendars')) {
      return new Response(JSON.stringify({
        connections: [{
          connectionId: 'google:owner@example.com', provider: 'google', role: 'write',
          accountEmail: 'owner@example.com', writesEvents: true, calendars: [],
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

  const doc = window.document
  const btn = [...doc.getElementById('busy-list').querySelectorAll('button')].find((b) => b.textContent === 'Disconnect')
  assert.ok(btn, 'expected a Disconnect button')

  btn.dispatchEvent(new window.Event('click', { bubbles: true }))
  assert.equal(btn.textContent, 'Click again to disconnect')
  assert.ok(scheduled, 'the 5s revert must be scheduled on window.setTimeout')
  assert.equal(scheduled.ms, 5000)

  // Simulate the 5s elapsing with no second click, by firing the scheduled
  // callback directly -- no real wait.
  scheduled.fn()

  assert.equal(btn.textContent, 'Disconnect', 'must revert after the window with no second click')
  assert.equal(deletes, 0, 'no disconnect must have happened')

  // A fresh click after the revert must re-arm the two-click flow from
  // scratch, proving `pending` itself was reset, not just the label.
  btn.dispatchEvent(new window.Event('click', { bubbles: true }))
  assert.equal(btn.textContent, 'Click again to disconnect')
  assert.equal(deletes, 0, 'the first click of a fresh round must not disconnect')
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

// ---------------------------------------------------------------------------
// Connect links must not hand the visitor a raw OAuth-start 400/409 when a
// precondition the server checks (GOOGLE_CLIENT_ID/SECRET, ZOHO_CLIENT_ID/
// SECRET, a saved Zoho account email) is not yet met. admin.js gates both
// Google connect links on cfg.googleConfigured and the Zoho connect link on
// cfg.zohoConfigured + a saved cfg.zohoAccountEmail, from the SAME
// /api/admin/config response the rest of the page already reads.
// ---------------------------------------------------------------------------

test('both Google connect links are disabled with explanatory text when Google OAuth is not configured', async () => {
  const window = await bootWith({ googleConfigured: false })
  const doc = window.document

  const writeLink = doc.getElementById('connect-write')
  const busyLink = doc.getElementById('connect-busy')
  assert.equal(writeLink.style.display, 'none', 'the write-role anchor must be hidden')
  assert.equal(busyLink.style.display, 'none', 'the busy-role anchor must be hidden')

  const writeDisabled = doc.getElementById('connect-write-disabled')
  const busyDisabled = doc.getElementById('connect-busy-disabled')
  assert.notEqual(writeDisabled.style.display, 'none')
  assert.notEqual(busyDisabled.style.display, 'none')
  assert.match(writeDisabled.textContent, /GOOGLE_CLIENT_ID/)
  assert.match(writeDisabled.textContent, /GOOGLE_CLIENT_SECRET/)
  assert.match(writeDisabled.textContent, /DEPLOY-AGENT\.md step 5/)
  assert.match(busyDisabled.textContent, /GOOGLE_CLIENT_ID/)

  // Disabled-looking, not a working link: no href, so it can never navigate
  // to the OAuth start route and surface a raw 400.
  assert.equal(writeDisabled.tagName, 'SPAN')
  assert.equal(writeDisabled.hasAttribute('href'), false)
})

test('the Google connect links are live when Google OAuth is configured and no write account exists', async () => {
  const window = await bootWith({ googleConfigured: true })
  const doc = window.document
  assert.equal(doc.getElementById('connect-write').style.display, 'inline-block')
  assert.equal(doc.getElementById('connect-busy').style.display, 'inline-block')
  assert.equal(doc.getElementById('connect-write-disabled').style.display, 'none')
  assert.equal(doc.getElementById('connect-busy-disabled').style.display, 'none')
})

test('the Zoho connect link is disabled with explanatory text when Zoho OAuth is not configured', async () => {
  const window = await bootWith({ zohoConfigured: false, zohoAccountEmail: '' })
  const doc = window.document
  assert.equal(doc.getElementById('connect-zoho').style.display, 'none')
  const disabled = doc.getElementById('connect-zoho-disabled')
  assert.notEqual(disabled.style.display, 'none')
  assert.match(disabled.textContent, /ZOHO_CLIENT_ID/)
  assert.match(disabled.textContent, /ZOHO_CLIENT_SECRET/)
})

test('the Zoho connect link is disabled with explanatory text when configured but no account email is saved', async () => {
  const window = await bootWith({ zohoConfigured: true, zohoAccountEmail: '' })
  const doc = window.document
  assert.equal(doc.getElementById('connect-zoho').style.display, 'none')
  const disabled = doc.getElementById('connect-zoho-disabled')
  assert.notEqual(disabled.style.display, 'none')
  assert.match(disabled.textContent, /account email/i)
})

test('the Zoho connect link is live once configured with a saved account email', async () => {
  const window = await bootWith({ zohoConfigured: true, zohoAccountEmail: 'owner@example.com' })
  const doc = window.document
  assert.equal(doc.getElementById('connect-zoho').style.display, 'inline-block')
  assert.equal(doc.getElementById('connect-zoho-disabled').style.display, 'none')
})

// ---------------------------------------------------------------------------
// M-3: the weekdays <input> is a comma-separated list the operator can leave
// with a trailing comma, a stray double comma, or empty entirely. split(',')
// on any of those produces an empty-string token, and Number('') is 0 (a
// finite number) -- so without dropping empty tokens FIRST, '1,2,' or '' would
// silently add Sunday (weekday 0) to the saved rules.
// ---------------------------------------------------------------------------

async function bootForSave({ configOverrides = {}, connections = [] } = {}) {
  let cfg = { ...CONFIG, ...configOverrides }
  const puts = []
  const dom = new JSDOM(PAGE, { url: 'https://x.test/admin/', pretendToBeVisual: true })
  const { window } = dom
  window.fetch = async (input, init = {}) => {
    const u = String(input)
    const method = init.method || 'GET'
    if (method === 'PUT' && u.includes('/api/admin/config')) {
      const body = JSON.parse(init.body)
      puts.push(body)
      cfg = { ...cfg, ...body }
      return new Response(JSON.stringify({ ok: true }))
    }
    if (u.includes('/api/admin/config')) return new Response(JSON.stringify(cfg))
    if (u.includes('/api/admin/calendars')) return new Response(JSON.stringify({ connections }))
    return new Response('{}')
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.location = window.location
  globalThis.fetch = window.fetch
  globalThis.URLSearchParams = window.URLSearchParams
  await import(`../public/admin/admin.js?t=${Date.now()}${Math.random()}`)
  await settle()
  return { window, puts }
}

test('a trailing comma in the weekdays field does not add Sunday', async () => {
  const { window, puts } = await bootForSave()
  const doc = window.document
  doc.getElementById('days').value = '1,2,'
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  assert.equal(puts.length, 1)
  assert.deepEqual(puts[0].rules.weekdays, [1, 2], 'the trailing empty token must be dropped, not become 0 (Sunday)')
})

test('an empty weekdays field saves an empty list, not [0] (Sunday)', async () => {
  const { window, puts } = await bootForSave()
  const doc = window.document
  doc.getElementById('days').value = ''
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  assert.equal(puts.length, 1)
  assert.deepEqual(puts[0].rules.weekdays, [])
})

// ---------------------------------------------------------------------------
// M-6: writeCalendarId must only be sent when the operator actually changed
// the <select>. admin-config.js's PUT handler re-validates writeCalendarId
// against Google (a live listCalendars call) whenever the field is present --
// sending the unchanged, already-saved value on every Save (e.g. just
// updating hours) would redo that round trip for nothing, and would fail the
// whole save if Google happened to be briefly unreachable.
// ---------------------------------------------------------------------------

test('changing only hours (not the booking calendar) sends no writeCalendarId', async () => {
  const { window, puts } = await bootForSave({
    configOverrides: { writeAccount: 'owner@example.com', writeCalendarId: 'cal1', bookingCalendars: [{ id: 'cal1', name: 'Main' }] },
  })
  const doc = window.document
  assert.equal(doc.getElementById('write-cal').value, 'cal1', 'the select must load with the saved calendar chosen')

  doc.getElementById('start').value = '08:00'
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()

  assert.equal(puts.length, 1)
  assert.equal('writeCalendarId' in puts[0] && puts[0].writeCalendarId !== undefined, false,
    'writeCalendarId must be absent (or undefined) when the select was never touched')
})

test('actually changing the booking calendar DOES send the new writeCalendarId', async () => {
  const { window, puts } = await bootForSave({
    configOverrides: {
      writeAccount: 'owner@example.com', writeCalendarId: 'cal1',
      bookingCalendars: [{ id: 'cal1', name: 'Main' }, { id: 'cal2', name: 'Other' }],
    },
  })
  const doc = window.document
  doc.getElementById('write-cal').value = 'cal2'
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()

  assert.equal(puts.length, 1)
  assert.equal(puts[0].writeCalendarId, 'cal2', 'the new selection must be sent when it differs from what was loaded')
})

test('meeting topics and the Other checkbox render literally and round-trip on Save', async () => {
  const EVIL_TOPIC = '<img src=x onerror=alert(1)>'
  const window = await bootWith({ meetingTopics: ['Audit review', EVIL_TOPIC], allowOtherTopic: true })
  const doc = window.document

  const textarea = doc.getElementById('topics')
  assert.equal(textarea.value, `Audit review\n${EVIL_TOPIC}`)
  assert.equal(doc.getElementById('allow-other').checked, true)
  assert.equal(doc.querySelectorAll('img').length, 0, 'the evil topic must never become a live <img>')
})

test('Save sends the trimmed, non-empty topic lines and the Other checkbox state', async () => {
  const { window, puts } = await bootForSave()
  const doc = window.document
  doc.getElementById('topics').value = '  Audit review  \n\nPricing\n'
  doc.getElementById('allow-other').checked = true
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()

  assert.equal(puts.length, 1)
  assert.deepEqual(puts[0].meetingTopics, ['Audit review', 'Pricing'])
  assert.equal(puts[0].allowOtherTopic, true)
})

test('saving a Zoho account email re-enables the Zoho link on the SAME anchor, without reload', async () => {
  // load() reruns after Save. A one-way replaceWith(span) would destroy the
  // anchor on the first disabled render and leave it unable to come back.
  const window = await bootWith({ zohoConfigured: true, zohoAccountEmail: '' })
  const doc = window.document
  assert.equal(doc.getElementById('connect-zoho').style.display, 'none')
  const anchorBefore = doc.getElementById('connect-zoho')

  doc.getElementById('zoho-email').value = 'owner@example.com'
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()

  assert.equal(doc.getElementById('connect-zoho'), anchorBefore, 'the anchor must still be the same element, not replaced')
  assert.equal(doc.getElementById('connect-zoho').style.display, 'inline-block')
  assert.equal(doc.getElementById('connect-zoho-disabled').style.display, 'none')
})

test('the buffer field loads from config and is sent back as a number on save', async () => {
  const { window, puts } = await bootForSave()
  const doc = window.document
  assert.equal(doc.getElementById('buffer').value, '10')
  doc.getElementById('buffer').value = '15'
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  assert.equal(puts.length, 1)
  assert.equal(puts[0].rules.bufferMinutes, 15)
})

test('the slot-interval field loads from config and is sent back as a number on save', async () => {
  // The API validated intervalMinutes all along, and DEPLOY-AGENT step 5 tells
  // the operator to set it to 15 next to the buffer, but the page had no field
  // for it: the only way to change the interval was to edit D1 by hand.
  const { window, puts } = await bootForSave()
  const doc = window.document
  assert.equal(doc.getElementById('interval').value, '30')
  doc.getElementById('interval').value = '15'
  doc.getElementById('save').dispatchEvent(new window.Event('click', { bubbles: true }))
  await settle()
  assert.equal(puts.length, 1)
  assert.equal(puts[0].rules.intervalMinutes, 15)
})
