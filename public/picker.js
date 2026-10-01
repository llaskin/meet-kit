// Month-grid booking picker used by /meet. Injects its own modal markup and
// drives /api/public/slots and /api/public/book via openModal(card, opts).

const MODAL_ID = 'booking-modal'

/** 'YYYY-MM-DD' for an instant, in a specific timezone. en-CA gives ISO order. */
const dayKeyInTz = (iso, tz) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: tz })

/**
 * Replace a box's contents with a single <p class="cls">text</p>, built with
 * createElement/textContent. Used for any message that interpolates server
 * data (an error string, a failure message, a fetch rejection's err.message)
 * -- none of that text is guaranteed free of markup-shaped characters, and an
 * innerHTML template would turn it into live DOM in the visitor's own
 * browser session.
 */
function showMsg(box, cls, text) {
  const p = document.createElement('p')
  p.className = cls
  p.textContent = text
  box.replaceChildren(p)
}

function ensureModal() {
  let el = document.getElementById(MODAL_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = MODAL_ID
  el.hidden = true
  el.innerHTML = `
    <div class="bk-backdrop" data-bk-close></div>
    <div class="bk-panel" role="dialog" aria-modal="true" aria-labelledby="bk-title">
      <h3 id="bk-title">Book a meeting</h3>
      <p class="bk-practice"></p>
      <label class="bk-durwrap">Meeting length
        <select class="bk-duration">
          <option value="30">30 minutes</option>
          <option value="60">60 minutes</option>
          <option value="120">2 hours</option>
        </select>
      </label>
      <div class="bk-slots"><p class="bk-meta">Loading availability…</p></div>
      <label for="bk-email">Prospect email</label>
      <input type="email" id="bk-email" autocomplete="off" placeholder="name@business.com">
      <label for="bk-name">Prospect name (optional)</label>
      <input type="text" id="bk-name" autocomplete="off">
      <p class="bk-error" hidden></p>
      <div class="bk-actions">
        <button type="button" class="bk-confirm" disabled>Confirm booking</button>
        <button type="button" class="bk-cancel" data-bk-close>Cancel</button>
      </div>
    </div>`
  document.body.appendChild(el)

  const style = document.createElement('style')
  style.textContent = `
    #${MODAL_ID}[hidden]{display:none!important}
    #${MODAL_ID}{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center}
    #${MODAL_ID} .bk-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45)}
    #${MODAL_ID} .bk-panel{position:relative;background:#fff;border-radius:8px;padding:18px;
      max-width:520px;width:92%;max-height:86vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.3)}
    #${MODAL_ID} h3{margin:0 0 4px;font-size:17px}
    #${MODAL_ID} .bk-practice{margin:0 0 12px;color:#5f6368;font-size:13px}
    #${MODAL_ID} .bk-durwrap{display:block;margin:0 0 10px;font-size:13px;color:#5f6368}
    #${MODAL_ID} .bk-duration{margin-left:8px;font:inherit;padding:4px 8px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#1a1a1a}
    #${MODAL_ID} .bk-meta{color:#5f6368;font-size:13px}
    #${MODAL_ID} .bk-slots{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
    #${MODAL_ID} .bk-cal{flex:0 0 224px}
    #${MODAL_ID} .bk-times{flex:1;min-width:150px;max-height:300px;overflow:auto}
    #${MODAL_ID} .bk-calhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
    #${MODAL_ID} .bk-month{font-size:13px;font-weight:600}
    #${MODAL_ID} .bk-nav{padding:2px 9px;border:1px solid #ccc;background:#fff;border-radius:4px;cursor:pointer;font:inherit}
    #${MODAL_ID} .bk-nav:disabled{color:#c0c4c9;cursor:not-allowed;background:#f8f9fa}
    #${MODAL_ID} .bk-dow,#${MODAL_ID} .bk-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
    #${MODAL_ID} .bk-dow span{text-align:center;font-size:11px;color:#5f6368;padding:2px 0}
    #${MODAL_ID} .bk-day-cell{padding:6px 0;border:1px solid transparent;border-radius:4px;
      background:none;font:inherit;font-size:13px;text-align:center;cursor:pointer}
    #${MODAL_ID} .bk-blank{visibility:hidden}
    #${MODAL_ID} .bk-has{background:#e8f0fe;color:#0b6cff;font-weight:600}
    #${MODAL_ID} .bk-has[aria-pressed="true"]{background:#0b6cff;color:#fff}
    #${MODAL_ID} .bk-none{color:#c0c4c9;cursor:default}
    #${MODAL_ID} .bk-slot{display:block;width:100%;margin:0 0 4px}
    #${MODAL_ID} .bk-day{margin:0 0 6px;font-size:13px;font-weight:600}
    #${MODAL_ID} .bk-slot{display:inline-block;margin:2px;padding:6px 9px;border:1px solid #ccc;
      border-radius:4px;background:#fff;cursor:pointer;font:inherit;font-size:13px}
    #${MODAL_ID} .bk-slot[aria-pressed="true"]{background:#0b6cff;color:#fff;border-color:#0b6cff}
    #${MODAL_ID} label{display:block;margin:10px 0 4px;font-weight:600;font-size:13px}
    #${MODAL_ID} input{width:100%;padding:7px;border:1px solid #ccc;border-radius:4px;font:inherit;box-sizing:border-box}
    #${MODAL_ID} .bk-error{color:#b3261e;font-size:13px;margin:10px 0 0}
    #${MODAL_ID} .bk-actions{margin-top:14px;display:flex;gap:8px}
    #${MODAL_ID} .bk-actions button{padding:8px 14px;border-radius:4px;font:inherit;cursor:pointer}
    #${MODAL_ID} .bk-confirm{border:1px solid #0b6cff;background:#0b6cff;color:#fff}
    #${MODAL_ID} .bk-confirm:disabled{background:#f1f3f4;color:#9aa0a6;border-color:#dadce0;cursor:not-allowed}
    #${MODAL_ID} .bk-cancel{border:1px solid #ccc;background:#fff}`
  document.head.appendChild(style)

  el.querySelectorAll('[data-bk-close]').forEach((n) =>
    n.addEventListener('click', () => { el.hidden = true }))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) el.hidden = true
  })
  return el
}

/**
 * Open the booking picker for a card.
 *
 * Always "direct": the server records nothing locally beyond the public
 * booking row it writes itself, and the caller is told the outcome through
 * `opts.onBooked` rather than a card-specific badge or outcome radio.
 */
async function openModal(card, opts = {}) {
  const slotsUrl = opts.slotsUrl || '/api/public/slots'
  const bookUrl = opts.bookUrl || '/api/public/book'
  const el = ensureModal()
  const panel = el.querySelector('.bk-panel')
  const slotsBox = el.querySelector('.bk-slots')
  const errBox = el.querySelector('.bk-error')
  const confirm = el.querySelector('.bk-confirm')
  const durSel = panel.querySelector('.bk-duration')
  let chosen = null
  let hostTz = null

  el.hidden = false
  errBox.hidden = true
  confirm.disabled = true
  panel.querySelector('.bk-practice').textContent =
    `${card.dataset.practice || ''}${card.dataset.city ? ' · ' + card.dataset.city : ''}`

  // A caller may narrow the list (the public page offers only 30 and 60).
  if (opts.durations) {
    for (const o of [...durSel.options]) {
      if (!opts.durations.includes(Number(o.value))) o.remove()
    }
  }

  // Select the caller's duration BEFORE the first loadSlots below, so the grid
  // that renders is the one the visitor asked for. A caller that instead set
  // .value after calling openModal would be too late -- openModal is async and
  // has already fetched by then, and assigning .value fires no change event --
  // leaving a 30-minute grid under a dropdown reading 60.
  // Guarded: assigning a value with no matching option yields '', and Number('')
  // is 0, which would request duration=0.
  if (opts.initialDuration != null) {
    const want = String(opts.initialDuration)
    if ([...durSel.options].some((o) => o.value === want)) durSel.value = want
  }

  // Which load is current. A slot fetch can take seconds on a cache miss, and
  // the duration is changeable throughout, so two can be in flight at once and
  // they can come back out of order. Every load takes a ticket on entry and
  // throws its own result away if a newer load has started since -- otherwise a
  // slow stale response repaints over the newer grid, reintroducing the exact
  // dropdown/grid mismatch this guards against, just from the other direction.
  let loadGen = 0

  async function loadSlots(durationMinutes) {
    const gen = ++loadGen
    const superseded = () => gen !== loadGen
    slotsBox.innerHTML = '<p class="bk-meta">Loading availability…</p>'

    let data
    try {
      const r = await fetch(`${slotsUrl}?duration=${encodeURIComponent(durationMinutes)}`)
      data = await r.json()
    } catch (err) {
      if (superseded()) return
      showMsg(slotsBox, 'bk-error', `Could not load availability: ${err.message}`)
      return
    }

    // Past the awaits: from here on this function paints, so a superseded load
    // must stop before it touches slotsBox or hostTz.
    if (superseded()) return

    if (data.error) { showMsg(slotsBox, 'bk-error', data.error); return }
    if (data.failedClosed) { showMsg(slotsBox, 'bk-error', data.message); return }
    if (!data.slots?.length) { slotsBox.innerHTML = '<p class="bk-meta">No times available in the booking window.</p>'; return }

    hostTz = data.timezone

    // Group slots by calendar day IN THE HOST TIMEZONE, not the browser's.
    const byDay = new Map()
    for (const sl of data.slots) {
      const k = dayKeyInTz(sl.start, hostTz)
      if (!byDay.has(k)) byDay.set(k, [])
      byDay.get(k).push(sl)
    }

    const dayKeys = [...byDay.keys()].sort()
    const firstDay = dayKeys[0]
    const lastDay = dayKeys[dayKeys.length - 1]
    let viewMonth = firstDay.slice(0, 7)   // 'YYYY-MM'
    let selectedDay = firstDay

    slotsBox.innerHTML = `
      <div class="bk-cal">
        <div class="bk-calhead">
          <button type="button" class="bk-nav" data-dir="-1" aria-label="Previous month">‹</button>
          <span class="bk-month"></span>
          <button type="button" class="bk-nav" data-dir="1" aria-label="Next month">›</button>
        </div>
        <div class="bk-dow"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div>
        <div class="bk-grid"></div>
      </div>
      <div class="bk-times"></div>`

    const grid = slotsBox.querySelector('.bk-grid')
    const monthLabel = slotsBox.querySelector('.bk-month')
    const timesBox = slotsBox.querySelector('.bk-times')

    function renderMonth() {
      const [y, m] = viewMonth.split('-').map(Number)
      monthLabel.textContent = new Date(Date.UTC(y, m - 1, 1))
        .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' })

      // Monday-first offset; JS getUTCDay() is Sunday-first.
      const firstOfMonth = new Date(Date.UTC(y, m - 1, 1))
      const lead = (firstOfMonth.getUTCDay() + 6) % 7
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()

      grid.innerHTML = ''
      for (let i = 0; i < lead; i++) {
        const blank = document.createElement('span')
        blank.className = 'bk-day-cell bk-blank'
        grid.appendChild(blank)
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        const has = byDay.has(key)
        const cell = document.createElement('button')
        cell.type = 'button'
        cell.className = 'bk-day-cell' + (has ? ' bk-has' : ' bk-none')
        cell.textContent = String(d)
        cell.disabled = !has
        if (has) {
          cell.title = `${byDay.get(key).length} time${byDay.get(key).length === 1 ? '' : 's'} available`
          cell.setAttribute('aria-pressed', String(key === selectedDay))
          cell.addEventListener('click', () => { selectedDay = key; renderMonth(); renderTimes() })
        }
        grid.appendChild(cell)
      }

      // Only allow navigating within months that actually contain availability.
      slotsBox.querySelector('[data-dir="-1"]').disabled = viewMonth <= firstDay.slice(0, 7)
      slotsBox.querySelector('[data-dir="1"]').disabled = viewMonth >= lastDay.slice(0, 7)
    }

    function renderTimes() {
      const list = byDay.get(selectedDay) || []
      const [y, m, d] = selectedDay.split('-').map(Number)
      const heading = new Date(Date.UTC(y, m - 1, d))
        .toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })

      const dayDiv = document.createElement('div')
      dayDiv.className = 'bk-day'
      dayDiv.textContent = heading
      timesBox.replaceChildren(dayDiv)
      for (const sl of list) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'bk-slot'
        b.setAttribute('aria-pressed', String(chosen?.start === sl.start))
        b.textContent = new Date(sl.start).toLocaleTimeString('en-US', {
          timeZone: hostTz, hour: 'numeric', minute: '2-digit',
        })
        b.addEventListener('click', () => {
          chosen = sl
          timesBox.querySelectorAll('.bk-slot').forEach((n) => n.setAttribute('aria-pressed', 'false'))
          b.setAttribute('aria-pressed', 'true')
          confirm.disabled = false
        })
        timesBox.appendChild(b)
      }
    }

    slotsBox.querySelectorAll('.bk-nav').forEach((btn) =>
      btn.addEventListener('click', () => {
        const [y, m] = viewMonth.split('-').map(Number)
        const nd = new Date(Date.UTC(y, m - 1 + Number(btn.dataset.dir), 1))
        viewMonth = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}`
        renderMonth()
      }))

    renderMonth()
    renderTimes()
  }

  // Attached BEFORE the first load, not after it. A cache-miss load takes
  // seconds, and a visitor who changes the length during it would otherwise be
  // changing a dropdown nothing is listening to -- the grid would finish at the
  // old length under a dropdown showing the new one.
  // ensureModal() REUSES a single element for the life of the page, so durSel
  // survives every open and a plain addEventListener would STACK one handler
  // per open. One change would then fire N loads from N stale closures, all
  // painting the same slots box; if an old closure lands last, its buttons
  // record `chosen` where the newest confirm.onclick cannot see it, and Confirm
  // looks enabled while silently doing nothing. Drop the previous one first.
  // (removeEventListener rather than an AbortController signal: picker.js is
  // also loaded into jsdom, where AbortController is Node's and addEventListener
  // is jsdom's, and the two realms' AbortSignal types do not match.)
  if (el._bkDurChange) durSel.removeEventListener('change', el._bkDurChange)
  const onDurChange = () => {
    // A slot picked at one length is not valid at another. Drop it, or Confirm
    // would post a stale window the server now rejects as a bad span.
    chosen = null
    confirm.disabled = true
    loadSlots(Number(durSel.value))
  }
  el._bkDurChange = onDurChange
  durSel.addEventListener('change', onDurChange)
  await loadSlots(Number(durSel.value))

  confirm.onclick = async () => {
    const email = el.querySelector('#bk-email').value.trim()
    if (!chosen) return
    if (!email) { errBox.hidden = false; errBox.textContent = 'Enter your email.'; return }
    confirm.disabled = true
    confirm.textContent = 'Booking…'
    errBox.hidden = true
    try {
      const r = await fetch(bookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: chosen.start,
          end: chosen.end,
          duration_minutes: Number(durSel.value),
          attendee_email: email,
          attendee_name: el.querySelector('#bk-name').value.trim(),
          notes: card.dataset.notes || '',
          // The public page adds its Turnstile token here. Evaluated per submit
          // rather than captured once: a token is single-use, so a second
          // attempt after an error needs a freshly-read one.
          ...(opts.extraBody ? opts.extraBody() : {}),
        }),
      })
      const out = await r.json()
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`)
      const attendeeName = el.querySelector('#bk-name').value.trim()
      // Nothing was written server-side beyond the booking row itself, so
      // there is no badge to render and no outcome to reflect. The page
      // shows its own confirmation instead.
      el.hidden = true
      opts.onBooked?.({
        start: chosen.start, end: chosen.end, meetUrl: out.meetUrl,
        attendeeEmail: email, attendeeName, hostTz,
      })
    } catch (err) {
      errBox.hidden = false
      errBox.textContent = err.message
    } finally {
      confirm.textContent = 'Confirm booking'
      confirm.disabled = false
    }
  }
}

// The /meet page drives this picker through this global.
window.MEETKIT_PICKER = { openModal }
