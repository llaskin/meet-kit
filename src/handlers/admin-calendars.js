import { getAllConnections, getSelections, setSelectionBusy } from '../core/calendar-store.js'

const json = (status, body) => Response.json(body, { status })

// Grouped by connection, because several Google accounts can be connected at
// once (one 'write', any number of 'busy'). Zoho connections appear with no
// calendars: its free/busy endpoint has no per-calendar filter, so there is
// nothing to toggle there.
export async function onRequestGet({ env }) {
  const db = env.DB
  const conns = await getAllConnections(db)
  const out = []
  for (const conn of conns) {
    const rows = await getSelections(db, conn.connection_id)
    out.push({
      connectionId: conn.connection_id,
      provider: conn.provider,
      role: conn.role,
      accountEmail: conn.account_email,
      // Surfaced so the UI can label which account actually sends invites.
      writesEvents: conn.role === 'write',
      calendars: rows.map((r) => ({
        calendarId: r.calendar_id,
        name: r.name || r.calendar_id,
        busy: r.busy === 1,
      })),
    })
  }
  return json(200, { connections: out })
}

export async function onRequestPut({ request, env }) {
  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'invalid json' })
  }
  if (!Array.isArray(body?.calendars)) return json(400, { error: 'calendars array required' })

  for (const c of body.calendars) {
    // connectionId is required: the same calendar id can legitimately appear
    // under two accounts, and updating the wrong one would silently unblock a
    // calendar the operator meant to keep.
    if (!c?.calendarId || !c?.connectionId) continue
    await setSelectionBusy(env.DB, c.connectionId, c.calendarId, Boolean(c.busy))
  }
  return json(200, { ok: true })
}
