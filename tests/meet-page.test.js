import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readForm, buildCard, formatWhen, showConfirmation, initMeet, applySite } from '../public/meet.js'

// Drive the REAL page, not a fixture, so this cannot drift from what ships.
const PAGE = readFileSync(fileURLToPath(new URL('../public/meet.html', import.meta.url)), 'utf8')

const doc = () => new JSDOM(PAGE, { url: 'https://calls.example.com/meet' }).window.document

function fill(d, o = {}) {
  const v = { name: 'Dana Reed', email: 'dana@northside.example', company: 'Northside', notes: '', website: '', duration: '30', ...o }
  d.getElementById('meet-name').value = v.name
  d.getElementById('meet-email').value = v.email
  d.getElementById('meet-company').value = v.company
  d.getElementById('meet-notes').value = v.notes
  d.getElementById('meet-website').value = v.website
  d.getElementById('meet-duration').value = v.duration
  return v
}

test('the page ships every element the module reaches for', () => {
  const d = doc()
  for (const id of ['meet-form', 'meet-duration', 'meet-name', 'meet-email', 'meet-company',
                    'meet-notes', 'meet-website', 'meet-error', 'meet-done',
                    'meet-done-when', 'meet-done-who', 'meet-done-meet']) {
    assert.ok(d.getElementById(id), `page is missing #${id}`)
  }
})

test('the page loads the Turnstile script explicitly and ships no hardcoded site key', () => {
  // meet-kit has no built-in site key: the widget is rendered explicitly by
  // meet.js once /api/public/site returns the owner's turnstileSiteKey.
  assert.match(PAGE, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/)
  assert.match(PAGE, /<div class="turnstile" id="meet-turnstile">/)
  // Patterns built from split strings so this file never contains the literals
  // the leak check (tests/leak-check.test.js) scans for.
  assert.doesNotMatch(PAGE, new RegExp(['0x4' + 'AAAA', 'data-sitekey'].join('|'), 'i'))
})

test('the honeypot is reachable by bots but not by people', () => {
  const d = doc()
  const hp = d.getElementById('meet-website')
  assert.equal(hp.getAttribute('name'), 'website')
  assert.equal(hp.getAttribute('tabindex'), '-1', 'must be out of the tab order')
  assert.equal(hp.getAttribute('autocomplete'), 'off', 'a password manager must not fill it')
  // Positioned off-screen rather than display:none: some bots skip hidden
  // fields but fill anything present in the DOM.
  assert.match(PAGE, /#meet-form \.hp\{[^}]*left:-9999px/)
  assert.ok(!/#meet-form \.hp\{[^}]*display:none/.test(PAGE))
})

test('the public page offers 30 and 60 only, defaulting to 30', () => {
  const d = doc()
  const sel = d.getElementById('meet-duration')
  assert.deepEqual([...sel.options].map((o) => o.value), ['30', '60'])
  assert.equal(sel.value, '30')
  assert.ok(!PAGE.includes('>4 hours<'), '240 must not be offered publicly')
})

test('the page is noindex', () => {
  assert.match(PAGE, /<meta name="robots" content="noindex/)
})

test('validation requires a name and a plausible email', () => {
  const d = doc()
  fill(d, { name: '' });  assert.match(readForm(d).error, /your name/i)
  fill(d, { email: '' }); assert.match(readForm(d).error, /email/i)
  fill(d, { email: 'nope' }); assert.match(readForm(d).error, /does not look right/i)
  fill(d); assert.equal(readForm(d).ok, true)
})

test('an invalid submit opens nothing', () => {
  const d = doc()
  let opened = false
  d.defaultView.MEETKIT_PICKER = { openModal: () => { opened = true } }
  initMeet(d)
  fill(d, { email: '' })
  d.getElementById('meet-form').dispatchEvent(new d.defaultView.Event('submit', { bubbles: true, cancelable: true }))
  assert.equal(opened, false)
  assert.equal(d.getElementById('meet-error').hidden, false)
})

test('a valid submit drives the picker against the PUBLIC endpoints', () => {
  const d = doc()
  let got = null
  d.defaultView.MEETKIT_PICKER = { openModal: (card, opts) => { got = { card, opts } } }
  initMeet(d)
  fill(d, { notes: 'Met at the expo' })
  d.getElementById('meet-form').dispatchEvent(new d.defaultView.Event('submit', { bubbles: true, cancelable: true }))
  assert.ok(got, 'openModal was not called')
  assert.equal(got.opts.slotsUrl, '/api/public/slots')
  assert.equal(got.opts.bookUrl, '/api/public/book')
  // `direct` was an inert option picker.js never read -- removed as dead code.
  assert.equal('direct' in got.opts, false, 'meet.js must no longer pass the unused direct option')
  assert.deepEqual(got.opts.durations, [30, 60])
  assert.equal(got.card.dataset.practice, 'Northside')
  assert.equal(got.card.dataset.notes, 'Met at the expo')
  assert.equal(got.card.dataset.state, undefined, 'no state means host time only')
})

test('the card falls back to the person when no company is given', () => {
  const d = doc()
  const v = fill(d, { company: '' })
  assert.equal(buildCard(d, { ...v, company: '' }).dataset.practice, 'Dana Reed')
})

test('the synthetic card is never attached to the document', () => {
  const d = doc()
  const before = d.querySelectorAll('.card').length
  buildCard(d, { company: 'X', notes: '' })
  assert.equal(d.querySelectorAll('.card').length, before)
})

test('extraBody carries the Turnstile token and the honeypot, read at submit time', () => {
  const d = doc()
  let got = null
  d.defaultView.MEETKIT_PICKER = { openModal: (card, opts) => { got = opts } }
  d.defaultView.turnstile = { getResponse: () => 'TOKEN-1' }
  initMeet(d)
  fill(d, { website: 'spam' })
  d.getElementById('meet-form').dispatchEvent(new d.defaultView.Event('submit', { bubbles: true, cancelable: true }))
  assert.equal(got.extraBody().turnstileToken, 'TOKEN-1')
  assert.equal(got.extraBody().website, 'spam', 'the honeypot value must reach the server')
  // A token is single-use: a retry must read the CURRENT one, not a captured copy.
  d.defaultView.turnstile.getResponse = () => 'TOKEN-2'
  assert.equal(got.extraBody().turnstileToken, 'TOKEN-2')
})

test('a missing Turnstile global yields an empty token rather than throwing', () => {
  const d = doc()
  let got = null
  d.defaultView.MEETKIT_PICKER = { openModal: (card, opts) => { got = opts } }
  initMeet(d)
  fill(d)
  d.getElementById('meet-form').dispatchEvent(new d.defaultView.Event('submit', { bubbles: true, cancelable: true }))
  assert.doesNotThrow(() => got.extraBody())
  assert.equal(got.extraBody().turnstileToken, '')
})

test('the confirmation shows the time, the attendee and the link', () => {
  const d = doc()
  showConfirmation(d, {
    start: '2026-10-12T17:00:00.000Z', meetUrl: 'https://meet.google.com/hyo-frso-ekt',
    attendeeEmail: 'dana@northside.example', hostTz: 'America/New_York',
  })
  assert.equal(d.getElementById('meet-form').hidden, true)
  assert.equal(d.getElementById('meet-done').hidden, false)
  assert.match(d.getElementById('meet-done-when').textContent, /October 12/)
  assert.match(d.getElementById('meet-done-when').textContent, /1:00/)
  assert.equal(d.getElementById('meet-done-who').textContent, 'dana@northside.example')
  assert.equal(d.getElementById('meet-done-meet').getAttribute('href'), 'https://meet.google.com/hyo-frso-ekt')
})

test('formatWhen renders in the HOST timezone, not the runner default', () => {
  const s = formatWhen('2026-10-12T17:00:00.000Z', 'America/New_York')
  assert.match(s, /1:00/)
  assert.match(s, /EDT|EST/)
})

test('the page CSS is scoped and cannot blank the injected picker', () => {
  // The bug that shipped on /book-a-call: a bare `button{color:#fff}` painted
  // white text on the modal's white slot buttons, month arrows and Cancel.
  const style = PAGE.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = style.split('}').map((r) => r.split('{')[0].trim()).filter(Boolean)
    .flatMap((sel) => sel.split(',').map((x) => x.trim()))
  const LEAKY = ['button', 'input', 'textarea', 'select', 'label', '.card', 'dt', 'dd', 'a']
  assert.deepEqual(selectors.filter((s) => LEAKY.includes(s)), [])
  for (const rule of style.split('}')) {
    const sel = rule.split('{')[0].trim()
    if (!sel || !/\b(button|select|input|textarea)\b/.test(sel)) continue
    assert.ok(/#meet-(form|done)/.test(sel), `rule "${sel}" is not scoped to the page`)
  }
})

test('the company field is unlabelled by industry and carries no placeholder', () => {
  // A placeholder like "Northside Roofing" quietly tells every visitor what
  // kind of business we expect. Prospects are dentists, lawyers, HVAC, solar,
  // vets and more, so the example is wrong for most of them.
  const d = doc()
  const input = d.getElementById('meet-company')
  assert.equal(input.getAttribute('placeholder'), null, 'no placeholder')
  const label = d.querySelector('label[for="meet-company"]')
  assert.match(label.textContent, /Company Name/)
  assert.match(label.textContent, /\(Optional\)/)
  assert.ok(!/Roofing|Dental|HVAC/i.test(PAGE), 'no industry example anywhere on the page')
})

test('the collection notice sits inside the form itself and says why data is collected', () => {
  // A public form collecting name, email and free-text notes must carry a
  // notice at the point of collection, not only a footer link. meet-kit ships
  // no owner branding or legal links baked in -- applySite() adds the Privacy
  // Policy link dynamically from /api/public/site when the owner sets one.
  const d = doc()
  const notice = d.querySelector('#meet-form .notice')
  assert.ok(notice, 'a collection notice must sit inside the form itself')
  assert.match(notice.textContent, /calendar invite/i)
  assert.match(notice.textContent, /abuse/i)
})

test('applySite renders owner branding and drops empty legal links', () => {
  const dom = new JSDOM(PAGE)
  const doc2 = dom.window.document
  applySite(doc2, { displayName: 'Pat Doe', pageTitle: 'Talk to Pat', pageSubtitle: 'Pick a time.',
    accentColor: '#123456', privacyUrl: 'https://pat.example/privacy', termsUrl: '' })
  assert.equal(doc2.title, 'Talk to Pat · Pat Doe')
  assert.equal(doc2.getElementById('meet-title').textContent, 'Talk to Pat')
  assert.equal(doc2.getElementById('meet-subtitle').textContent, 'Pick a time.')
  assert.equal(doc2.documentElement.style.getPropertyValue('--accent'), '#123456')
  const foot = doc2.getElementById('meet-foot')
  assert.match(foot.textContent, /Pat Doe · Privacy Policy/)
  assert.doesNotMatch(foot.textContent, /Terms/)
  assert.ok(foot.querySelector('a[href="https://pat.example/privacy"]'))
})

test('applySite leaves the footer empty when the owner sets no branding or links', () => {
  const dom = new JSDOM(PAGE)
  const doc2 = dom.window.document
  applySite(doc2, { pageTitle: 'Book a call', pageSubtitle: 'Pick a time.', accentColor: '#0b6cff', displayName: '', privacyUrl: '', termsUrl: '' })
  assert.equal(doc2.getElementById('meet-foot').textContent, '')
  assert.equal(doc2.getElementById('meet-foot').childElementCount, 0)
})

test('the page ships no hardcoded site key or owner branding', () => {
  // Split strings: see the note in the site-key test above.
  assert.doesNotMatch(PAGE, new RegExp(['0x4' + 'AAAA', 'aifind' + 'mybusiness', 'AI Find ' + 'My Business'].join('|'), 'i'))
})
