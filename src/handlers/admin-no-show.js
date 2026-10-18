// Admin "Mark no-show" (POST /api/admin/no-show {id}). Owner-gated by the
// '/api/admin' prefix in worker.js's middleware, like every other admin route.
//
// A no-show is a FACT about a meeting, not a cancellation: the row stays in
// public_bookings, nothing is deleted from any calendar, nobody is emailed.
// Its only effects are the stamp (no_show_at / no_show_by) and, when the
// outbound webhook is on, one booking.no_show event -- once, ever, per booking.
import { markNoShow, getPublicBooking } from '../core/public-bookings.js'
import { sendBookingWebhook } from '../core/booking-webhook.js'

const ID = /^[A-Za-z0-9-]{1,64}$/

export async function onRequestPost({ request, env, owner, waitUntil }) {
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const id = body?.id
  // Same rule as admin-cancel.js: booking ids are crypto.randomUUID(). Refuse
  // anything else BEFORE any DB call.
  if (typeof id !== 'string' || !ID.test(id)) return Response.json({ error: 'A valid booking id is required' }, { status: 400 })

  // Always JSON, never a thrown error's text.
  try {
    const row = await getPublicBooking(env.DB, id)
    if (!row) return Response.json({ error: 'Booking not found' }, { status: 404 })

    // Compared as instants, not strings: start_utc is written by our own
    // code as an ISO string, but a stored value with a different offset
    // form would compare wrongly as text.
    if (Date.parse(row.start_utc) > Date.now()) {
      return Response.json({ error: 'That call has not started yet' }, { status: 409 })
    }

    const nowIso = new Date().toISOString()
    const by = owner || ''
    const r = await markNoShow(env.DB, { id, at: nowIso, by })
    // The row vanished between the read and the write (a concurrent cancel).
    if (!r.row) return Response.json({ error: 'Booking not found' }, { status: 404 })
    // Already stamped (by this click's twin, or long ago): idempotent 200 and
    // NO second event -- markNoShow's guarded UPDATE is what makes "exactly
    // one caller sees already:false" true under concurrency.
    if (r.already) return Response.json({ ok: true, already: true })

    // Stamped just now: best-effort notify through waitUntil (see
    // booking-webhook.js); the admin's response never waits on it.
    const notify = sendBookingWebhook(env, {
      type: 'booking.no_show',
      booking: r.row,
      extra: { no_show_at: nowIso, no_show_by: by },
    })
    if (typeof waitUntil === 'function') waitUntil(notify)

    return Response.json({ ok: true })
  } catch {
    return Response.json({ error: 'Could not mark the booking' }, { status: 500 })
  }
}
