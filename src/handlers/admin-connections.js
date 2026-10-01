import * as store from '../core/calendar-store.js'

const json = (status, body) => Response.json(body, { status })

/**
 * DELETE /api/admin/connections/:id -- disconnect one calendar account.
 *
 * `params.id` is the connection_id ('google:a@x.com'). Routers normally decode
 * path params already; decoding again is harmless for these ids (no literal
 * '%'), and a malformed escape falls back to the raw value.
 *
 * Removing the write connection also removes write_calendar_id and
 * write_calendar_meet, so no config is left pointing at an account that can no
 * longer create events. Disconnecting is also how an operator turns a
 * busy-only account into the booking account (the upsert never changes role).
 */
export async function onRequestDelete({ env, params }) {
  const raw = params?.id
  if (typeof raw !== 'string' || !raw) return json(400, { error: 'connection id required' })
  let id = raw
  try { id = decodeURIComponent(raw) } catch { /* keep the raw value */ }

  const db = env.DB
  const conn = await store.getConnectionById(db, id)
  if (!conn) return json(404, { error: 'No such connection' })

  await store.deleteConnection(db, id)
  if (conn.role === store.ROLE_WRITE) {
    await store.deleteConfig(db, 'write_calendar_id')
    await store.deleteConfig(db, 'write_calendar_meet')
  }
  return json(200, { ok: true, deleted: id, wasWrite: conn.role === store.ROLE_WRITE })
}
