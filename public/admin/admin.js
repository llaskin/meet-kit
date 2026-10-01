const $ = (id) => document.getElementById(id)

// Set by load(), read by the Save handler below -- so Save can tell whether
// the <select> actually changed and only then include writeCalendarId in the
// PUT body (see M-6 comment at the Save handler for why that matters).
let loadedWriteCalendarId = ''

const GOOGLE_MISSING = 'Set GOOGLE_CLIENT_ID and the GOOGLE_CLIENT_SECRET secret first (see DEPLOY-AGENT.md step 5).'
const ZOHO_MISSING = 'Set ZOHO_CLIENT_ID and the ZOHO_CLIENT_SECRET secret first (see DEPLOY-AGENT.md step 5).'
const ZOHO_NO_EMAIL = 'Set the Zoho account email above and save before connecting Zoho.'

/** Toggle a live anchor and its disabled-looking sibling span without ever removing either from the DOM. */
function setConnectState(anchorId, disabledId, enabled, reason) {
  $(anchorId).style.display = enabled ? 'inline-block' : 'none'
  const disabled = $(disabledId)
  disabled.style.display = enabled ? 'none' : 'inline-block'
  disabled.textContent = reason
}

function flash(msg, ok) {
  const f = $('flash')
  f.style.display = 'block'
  f.className = ok ? 'ok' : 'bad'
  f.textContent = msg
}

async function api(path, init) {
  const r = await fetch(path, init)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
  return body
}

function statusLine(ok, text) {
  const li = document.createElement('li')
  li.className = ok ? 'ok' : 'bad'
  li.textContent = `${ok ? '✓' : '✗'} ${text}`
  return li
}

// Disconnecting an account is destructive (it revokes a connected calendar
// and, for the booking account, removes the config pointing at it), so it is
// confirmed -- but with a second click on the SAME button within a short
// window, never window.confirm/alert. Those block the whole page on a native
// dialog and are trivially blown through by an impatient double-click; this
// page also never wants to put an account email through a confirm() prompt.
const CONFIRM_WINDOW_MS = 5000

function makeDisconnectButton(connectionId, onDone) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn btn-secondary'
  btn.textContent = 'Disconnect'
  let pending = false
  let timer = null
  const reset = () => {
    pending = false
    if (timer) { window.clearTimeout(timer); timer = null }
    btn.textContent = 'Disconnect'
  }
  btn.addEventListener('click', async () => {
    if (!pending) {
      pending = true
      btn.textContent = 'Click again to disconnect'
      timer = window.setTimeout(reset, CONFIRM_WINDOW_MS)
      return
    }
    reset()
    btn.disabled = true
    try {
      // Every /api/admin/* write (including a bodyless DELETE) must carry
      // Content-Type: application/json -- the server's CSRF gate 415s a
      // non-GET admin request without it and refuses a cross-site Origin.
      await api(`/api/admin/connections/${encodeURIComponent(connectionId)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      await onDone()
    } catch (e) {
      flash(e.message, false)
      btn.disabled = false
    }
  })
  return btn
}

async function load() {
  const q = new URLSearchParams(location.search)
  if (q.get('error')) flash(q.get('error'), false)
  if (q.get('connected')) flash(`Connected ${q.get('connected')}.`, true)

  const cfg = await api('/api/admin/config')
  const { connections } = await api('/api/admin/calendars')

  const list = $('status-list')
  list.replaceChildren(
    statusLine(cfg.googleConfigured, 'Google OAuth client set (GOOGLE_CLIENT_ID var + GOOGLE_CLIENT_SECRET secret)'),
    statusLine(cfg.turnstileConfigured, 'Turnstile set (TURNSTILE_SITE_KEY var + TURNSTILE_SECRET_KEY secret)'),
    statusLine(Boolean(cfg.writeAccount), 'Booking account connected'),
    statusLine(cfg.uniqueMeet || Boolean(cfg.meetLink), 'A video link is available for bookings'),
  )

  $('write-account').textContent = cfg.writeAccount ? `Connected: ${cfg.writeAccount}` : 'No booking account yet.'

  // Every link below hits an /admin/oauth/{provider}/start route that 400s
  // with a raw JSON body the visitor cannot act on when a server-side
  // precondition is unmet (GOOGLE_CLIENT_ID/SECRET, ZOHO_CLIENT_ID/SECRET, or
  // -- for Zoho -- a saved account email). Gate on the same cfg fields the
  // Status list already reads, and show an explanation instead of a dead
  // link. Never destroy the anchor (no replaceWith): load() reruns after
  // every Save and Disconnect, and the link must be able to come back live
  // on the SAME element without a page reload.
  //
  // connect-write is already hidden once a booking account exists (nothing
  // useful to show either way), so it alone has a third state.
  $('connect-write').style.display = (!cfg.writeAccount && cfg.googleConfigured) ? 'inline-block' : 'none'
  $('connect-write-disabled').style.display = (!cfg.writeAccount && !cfg.googleConfigured) ? 'inline-block' : 'none'
  $('connect-write-disabled').textContent = GOOGLE_MISSING

  setConnectState('connect-busy', 'connect-busy-disabled', cfg.googleConfigured, GOOGLE_MISSING)

  const zohoEmailSaved = Boolean((cfg.zohoAccountEmail || '').trim())
  setConnectState('connect-zoho', 'connect-zoho-disabled', cfg.zohoConfigured && zohoEmailSaved,
    cfg.zohoConfigured ? ZOHO_NO_EMAIL : ZOHO_MISSING)

  const sel = $('write-cal')
  sel.replaceChildren(...cfg.bookingCalendars.map((c) => {
    const o = document.createElement('option')
    o.value = c.id; o.textContent = c.name; o.selected = c.id === cfg.writeCalendarId
    return o
  }))
  loadedWriteCalendarId = cfg.writeCalendarId || ''
  $('meet-status').textContent = cfg.uniqueMeet
    ? 'Unique Meet links: available on this calendar.'
    : 'Unique Meet links: not available on this calendar. The fixed link below is used.'

  const busy = $('busy-list')
  busy.replaceChildren()
  for (const conn of connections) {
    // Built with createElement/textContent, never innerHTML: accountEmail and
    // calendar names came back through OAuth/Google and are not guaranteed
    // free of markup-shaped characters by anything upstream of this page.
    const h = document.createElement('p')
    h.className = 'conn-row'
    const strong = document.createElement('strong')
    strong.textContent = conn.accountEmail
    const span = document.createElement('span')
    span.className = 'muted'
    span.textContent = conn.writesEvents ? '(booking account)' : `(${conn.provider}, busy only)`
    h.append(strong, span, makeDisconnectButton(conn.connectionId, load))
    busy.append(h)
    for (const cal of conn.calendars) {
      const row = document.createElement('label')
      row.className = 'cal'
      const cb = document.createElement('input')
      cb.type = 'checkbox'; cb.checked = cal.busy
      cb.addEventListener('change', async () => {
        try {
          await api('/api/admin/calendars', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendars: [{ connectionId: conn.connectionId, calendarId: cal.calendarId, busy: cb.checked }] }) })
        } catch (e) { flash(e.message, false); cb.checked = !cb.checked }
      })
      row.append(cb, document.createTextNode(cal.name))
      busy.append(row)
    }
  }

  $('zoho-email').value = cfg.zohoAccountEmail
  $('meet-link').value = cfg.meetLink
  $('internal-email').value = cfg.internalAttendeeEmail
  $('tz').value = cfg.rules.timezone
  $('days').value = cfg.rules.weekdays.join(',')
  $('start').value = cfg.rules.startTime
  $('end').value = cfg.rules.endTime
  $('notice').value = cfg.rules.minNoticeMinutes
  $('horizon').value = cfg.rules.horizonDays
}

$('save').addEventListener('click', async () => {
  try {
    const selectedWriteCalendarId = $('write-cal').value || ''
    // Only send writeCalendarId when it actually CHANGED from what load()
    // last fetched. admin-config.js's PUT handler re-validates writeCalendarId
    // against Google on every save that includes it (a live listCalendars
    // call) -- sending the unchanged, already-saved value on every single
    // Save (e.g. just updating hours) would re-run that round trip for no
    // reason, and fail the whole save if Google is briefly unreachable.
    const writeCalendarId = selectedWriteCalendarId && selectedWriteCalendarId !== loadedWriteCalendarId
      ? selectedWriteCalendarId
      : undefined
    await api('/api/admin/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writeCalendarId,
        meetLink: $('meet-link').value,
        internalAttendeeEmail: $('internal-email').value,
        zohoAccountEmail: $('zoho-email').value,
        rules: {
          timezone: $('tz').value,
          // Drop empty tokens BEFORE Number(): split(',') on '' or a
          // trailing/doubled comma ('1,2,') produces an empty-string token,
          // and Number('') is 0 -- a finite number -- so it would silently
          // add Sunday (weekday 0) to the saved set instead of being dropped.
          weekdays: $('days').value.split(',').map((s) => s.trim()).filter((s) => s !== '')
            .map(Number).filter(Number.isFinite),
          startTime: $('start').value,
          endTime: $('end').value,
          // Numbers, not the raw input strings: the handler accepts either,
          // but a number is unambiguous and cannot pick up stray whitespace.
          minNoticeMinutes: $('notice').value === '' ? undefined : Number($('notice').value),
          horizonDays: $('horizon').value === '' ? undefined : Number($('horizon').value),
        },
      }),
    })
    flash('Saved.', true)
    await load()
  } catch (e) { flash(e.message, false) }
})

load().catch((e) => flash(e.message, false))
