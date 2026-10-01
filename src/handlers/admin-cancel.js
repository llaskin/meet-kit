import { cancelBooking } from '../core/cancel-booking.js'
import { loadCfg } from './context.js'

const ID = /^[A-Za-z0-9-]{1,64}$/

export async function onRequestPost({ request, env, owner }) {
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
    const r = await cancelBooking(env.DB, cfg, { id, cancelledBy: owner || '', nowIso: new Date().toISOString() })
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status })
    return Response.json({ ok: true, alreadyGone: r.alreadyGone })
  } catch {
    return Response.json({ error: 'Could not cancel the booking' }, { status: 500 })
  }
}
