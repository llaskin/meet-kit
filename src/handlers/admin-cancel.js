import { cancelBooking } from '../core/cancel-booking.js'
import { sendBookingWebhook } from '../core/booking-webhook.js'
import { loadCfg } from './context.js'

const ID = /^[A-Za-z0-9-]{1,64}$/

export async function onRequestPost({ request, env, owner, waitUntil }) {
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const id = body?.id
  // Booking ids are crypto.randomUUID(). Refuse anything else before any DB call.
  if (typeof id !== 'string' || !ID.test(id)) return Response.json({ error: 'A valid booking id is required' }, { status: 400 })

  // Always JSON. cancelBooking itself reports the one failure that happens
  // AFTER the Google delete; anything that reaches this catch happened before
  // it, so it must not claim the meeting was cancelled.
  try {
    const cfg = await loadCfg(env.DB, env)
    // One timestamp: the ledger's cancelled_at and the webhook's are the same
    // string, so a receiver can match them.
    const nowIso = new Date().toISOString()
    const cancelledBy = owner || ''
    const r = await cancelBooking(env.DB, cfg, { id, cancelledBy, nowIso })
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status })

    // Only here has the row actually moved. Best-effort, through waitUntil:
    // the admin's response never waits on the receiver (see booking-webhook.js).
    const notify = sendBookingWebhook(env, {
      type: 'booking.cancelled',
      booking: r.row,
      extra: { cancelled_at: nowIso, cancelled_by: cancelledBy },
    })
    if (typeof waitUntil === 'function') waitUntil(notify)

    return Response.json({ ok: true, alreadyGone: r.alreadyGone })
  } catch {
    return Response.json({ error: 'Could not cancel the booking' }, { status: 500 })
  }
}
