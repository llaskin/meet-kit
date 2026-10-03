// Admin view of upcoming bookings made through the public /meet page.
//
// Cancel is two-step on purpose: it deletes a real event from the attendee's
// calendar and emails them immediately, with no undo. Not a typed
// confirmation -- the action is recoverable by re-booking, and typed
// confirmations on a routine operation train people to type without reading
// -- but never one click.

const fmt = (iso) => new Date(iso).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
})

export function initBookings(doc) {
  const list = doc.getElementById('bk-list')
  const errBox = doc.getElementById('bk-error')
  const empty = doc.getElementById('bk-empty')
  if (!list) return false

  const fail = (msg) => { errBox.hidden = false; errBox.textContent = msg }

  async function load() {
    let data
    try {
      const r = await fetch('/api/admin/bookings')
      data = await r.json()
      if (!r.ok) return fail(data.error || `Could not load meetings (${r.status})`)
    } catch (e) {
      return fail(`Could not load meetings: ${e.message}`)
    }

    list.innerHTML = ''
    const rows = data.bookings || []
    empty.hidden = rows.length > 0
    for (const b of rows) list.appendChild(renderRow(doc, b, load, fail))
    return true
  }

  load()
  return true
}

function renderRow(doc, b, reload, fail) {
  const row = doc.createElement('div')
  row.className = 'bk-row'

  // Built with createElement/textContent, never innerHTML.
  //
  // attendeeName and company are typed by an anonymous visitor on /meet. The
  // write path clamps them to 80 chars but does NOT escape them, and nothing
  // between there and here does either -- so an innerHTML template turns
  // `<img src=x onerror=...>` into live DOM in the session of the admin
  // reading this page, which is the one session that can cancel meetings.
  const who = b.attendeeName || b.attendeeEmail || '(no name)'

  const when = doc.createElement('div')
  when.className = 'bk-when'
  when.textContent = `${fmt(b.start)} · ${b.durationMin} min`
  const tag = doc.createElement('span')
  tag.className = 'bk-tag'
  tag.textContent = b.meetUrlSource === 'unique' ? 'unique Meet' : 'fixed link'
  when.appendChild(tag)

  const line = doc.createElement('div')
  line.className = 'bk-who'
  line.textContent = `${who}${b.company ? ' · ' + b.company : ''} — ${b.attendeeEmail}`

  row.appendChild(when)
  row.appendChild(line)

  if (b.topic) {
    const topic = doc.createElement('div')
    topic.className = 'bk-topic'
    topic.textContent = `Topic: ${b.topic}`
    row.appendChild(topic)
  }

  const cancel = doc.createElement('button')
  cancel.type = 'button'
  cancel.className = 'bk-cancel'
  cancel.textContent = 'Cancel meeting'
  row.appendChild(cancel)

  cancel.addEventListener('click', () => {
    if (row.querySelector('.bk-confirmbox')) return
    cancel.hidden = true

    const box = doc.createElement('div')
    box.className = 'bk-confirmbox'
    // Same rule: the attendee address is attacker-influenced on a public row.
    const msg = doc.createElement('div')
    msg.textContent = `Cancel the ${b.durationMin}-minute meeting on ${fmt(b.start)}? `
    const addr = doc.createElement('strong')
    addr.textContent = b.attendeeEmail
    msg.appendChild(addr)
    msg.appendChild(doc.createTextNode(
      ' will be emailed and it will be removed from their calendar. This cannot be undone.'))
    box.appendChild(msg)

    const go = doc.createElement('button')
    go.type = 'button'
    go.className = 'bk-confirm-cancel'
    go.textContent = 'Cancel meeting and notify'

    const keep = doc.createElement('button')
    keep.type = 'button'
    keep.className = 'bk-keep'
    keep.textContent = 'Keep it'

    box.appendChild(go)
    box.appendChild(keep)
    row.appendChild(box)

    keep.addEventListener('click', () => { box.remove(); cancel.hidden = false })

    go.addEventListener('click', async () => {
      go.disabled = true
      go.textContent = 'Cancelling…'
      try {
        const r = await fetch('/api/admin/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.id }),
        })
        const out = await r.json()
        if (!r.ok) {
          // Leave the row exactly where it is: the meeting is still live.
          fail(out.error || `Could not cancel (${r.status})`)
          go.disabled = false
          go.textContent = 'Cancel meeting and notify'
          return
        }
        await reload()
      } catch (e) {
        fail(`Could not cancel: ${e.message}`)
        go.disabled = false
        go.textContent = 'Cancel meeting and notify'
      }
    })
  })

  return row
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initBookings(document), { once: true })
  } else {
    initBookings(document)
  }
}
