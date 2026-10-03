// Public booking page (/meet): fills itself from /api/public/site, then drives picker.js.
//
// Drives the SAME picker the admin pages would use (if any existed), pointed
// at /api/public/*. /api/public/slots and /api/public/book are separate
// handlers precisely because they return a deliberately sanitised shape -- no
// calendar names, no account emails, no upstream error text.

import { validateCustomTopic, OTHER_CHOICE } from './topics.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Validate the form. Returns { ok, error, values } and never throws. */
export function readForm(doc) {
  const val = (id) => (doc.getElementById(id)?.value || '').trim()
  const values = {
    duration: Number(doc.getElementById('meet-duration')?.value || 30),
    name: val('meet-name'),
    email: val('meet-email'),
    company: val('meet-company'),
    notes: val('meet-notes'),
    // The honeypot. Read but never sent as a normal field -- the server
    // rejects on its presence.
    website: val('meet-website'),
  }
  if (!values.name) return { ok: false, error: 'Enter your name.', values }
  if (!values.email) return { ok: false, error: 'Enter your email address.', values }
  if (!EMAIL.test(values.email)) return { ok: false, error: 'That email address does not look right.', values }
  return { ok: true, error: '', values }
}

export function formatWhen(startIso, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(startIso))
}

export function showConfirmation(doc, booking) {
  doc.getElementById('meet-form').hidden = true
  doc.getElementById('meet-done-when').textContent = formatWhen(booking.start, booking.hostTz)
  doc.getElementById('meet-done-who').textContent = booking.attendeeEmail
  const meet = doc.getElementById('meet-done-meet')
  meet.href = booking.meetUrl || '#'
  meet.textContent = booking.meetUrl || '(link will arrive by email)'
  doc.getElementById('meet-done').hidden = false
}

/**
 * Build the detached card the picker reads. Never appended to the document --
 * a stray .card is what the picker's own lookups scan for.
 */
export function buildCard(doc, values) {
  const card = doc.createElement('section')
  card.className = 'card'
  card.dataset.practice = values.company || values.name
  card.dataset.notes = values.notes || ''
  return card
}

export function renderTopics(doc, { topics = [], allowOther = false } = {}) {
  const wrap = doc.getElementById('meet-topic-wrap')
  const sel = doc.getElementById('meet-topic')
  const customWrap = doc.getElementById('meet-topic-custom-wrap')
  if (!wrap || !sel) return
  sel.replaceChildren()
  const add = (value, text) => { const o = doc.createElement('option'); o.value = value; o.textContent = text; sel.appendChild(o) }
  add('', 'Choose a topic…')
  for (const t of topics) add(t, t)
  if (allowOther) add(OTHER_CHOICE, 'Other')
  wrap.hidden = topics.length === 0 && !allowOther
  const sync = () => { customWrap.hidden = sel.value !== OTHER_CHOICE }
  sel.addEventListener('change', sync)
  sync()
}

export function readTopic(doc) {
  const wrap = doc.getElementById('meet-topic-wrap')
  if (!wrap || wrap.hidden) return { ok: true, topic_choice: '', topic_custom: '' }
  const choice = doc.getElementById('meet-topic').value
  if (!choice) return { ok: false, error: 'Please choose what the call is about.' }
  if (choice !== OTHER_CHOICE) return { ok: true, topic_choice: choice, topic_custom: '' }
  const c = validateCustomTopic(doc.getElementById('meet-topic-custom').value)
  if (!c.ok) return { ok: false, error: c.error }
  return { ok: true, topic_choice: choice, topic_custom: c.value }
}

export async function loadTopics(doc) {
  try {
    const data = await (await doc.defaultView.fetch('/api/public/topics')).json()
    renderTopics(doc, data)
  } catch {
    renderTopics(doc, { topics: [], allowOther: false })
  }
}

export function initMeet(doc) {
  const form = doc.getElementById('meet-form')
  if (!form) return false
  const errBox = doc.getElementById('meet-error')
  const win = doc.defaultView

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const res = readForm(doc)
    if (!res.ok) {
      errBox.hidden = false
      errBox.textContent = res.error
      return
    }
    errBox.hidden = true

    const topic = readTopic(doc)
    if (!topic.ok) { errBox.hidden = false; errBox.textContent = topic.error; return }

    win.MEETKIT_PICKER.openModal(buildCard(doc, res.values), {
      slotsUrl: '/api/public/slots',
      bookUrl: '/api/public/book',
      // The public page offers 30 and 60 only. The server enforces the same
      // list; this just keeps 240 out of the dropdown.
      durations: [30, 60],
      // Must ride in as an option: openModal loads the grid on the way in, so
      // setting the dropdown afterwards would render the wrong-length grid.
      initialDuration: res.values.duration,
      // Read at submit time, not captured once: Turnstile tokens are
      // single-use, so a retry after an error needs the current one.
      extraBody: () => ({
        company: res.values.company,
        website: res.values.website,
        topic_choice: topic.topic_choice,
        topic_custom: topic.topic_custom,
        turnstileToken: win.turnstile?.getResponse?.(win.__meetTurnstileId) || '',
      }),
      onBooked: (booking) => showConfirmation(doc, booking),
    })

    // Carry the details across so the visitor does not type them twice. Safe
    // after the call because openModal builds the modal synchronously, before
    // its first await; the duration is NOT safe here, hence initialDuration.
    const n = doc.getElementById('bk-name')
    const em = doc.getElementById('bk-email')
    if (n) n.value = res.values.name
    if (em) em.value = res.values.email
  })
  return true
}

/** Apply the owner's display settings (from /api/public/site) to the page. */
export function applySite(doc, site) {
  const set = (id, text) => { const el = doc.getElementById(id); if (el && text) el.textContent = text }
  doc.title = site.displayName ? `${site.pageTitle} · ${site.displayName}` : site.pageTitle
  set('meet-title', site.pageTitle)
  set('meet-subtitle', site.pageSubtitle)
  doc.documentElement.style.setProperty('--accent', site.accentColor)
  const foot = doc.getElementById('meet-foot')
  const notice = doc.getElementById('meet-notice')
  const link = (href, label) => {
    const a = doc.createElement('a')
    a.href = href; a.textContent = label; a.target = '_blank'; a.rel = 'noopener'
    return a
  }
  if (foot) {
    foot.textContent = site.displayName || ''
    for (const [href, label] of [[site.privacyUrl, 'Privacy Policy'], [site.termsUrl, 'Terms']]) {
      if (href) { foot.append(' · '); foot.append(link(href, label)) }
    }
  }
  if (notice && site.privacyUrl) { notice.append(' See the '); notice.append(link(site.privacyUrl, 'Privacy Policy')); notice.append('.') }
}

export async function loadSite(doc) {
  const win = doc.defaultView
  const site = await (await win.fetch('/api/public/site')).json()
  applySite(doc, site)
  // No site key at all means Turnstile is not configured for this deployment
  // -- polling forever for a global that will never appear would leak a timer.
  if (!site.turnstileSiteKey) return site
  const mount = () => {
    if (!win.turnstile) return false
    win.__meetTurnstileId = win.turnstile.render('#meet-turnstile', { sitekey: site.turnstileSiteKey })
    return true
  }
  if (!mount()) {
    const t = win.setInterval(() => { if (mount()) win.clearInterval(t) }, 200)
  }
  return site
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initMeet(document); loadSite(document); loadTopics(document) }, { once: true })
  } else {
    initMeet(document)
    loadSite(document)
    loadTopics(document)
  }
}
