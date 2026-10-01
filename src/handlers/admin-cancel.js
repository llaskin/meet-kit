import { cancelBooking } from '../core/cancel-booking.js'
import { loadCfg } from './context.js'

export async function onRequestPost({ request, env, owner }) {
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  if (!body?.id) return Response.json({ error: 'id required' }, { status: 400 })

  // Always JSON: an HTML 500 would make the page report "could not cancel"
  // when the meeting may already be gone.
  try {
    const cfg = await loadCfg(env.DB, env)
    const r = await cancelBooking(env.DB, cfg, { id: body.id, cancelledBy: owner || '', nowIso: new Date().toISOString() })
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status })
    return Response.json({ ok: true, alreadyGone: r.alreadyGone })
  } catch {
    return Response.json({
      error: 'The meeting was cancelled and the guests were notified, but the record could not be updated. Retrying is safe.',
    }, { status: 500 })
  }
}
