import * as store from '../core/calendar-store.js'
import * as google from '../core/google-calendar.js'
import { accessTokenFor } from '../core/booking-core.js'
import { loadCfg } from './context.js'

const json = (status, body) => Response.json(body, { status })
const HTTPS = /^https:\/\/[^\s]+$/

export async function onRequestGet({ env }) {
  const db = env.DB
  const cfg = await loadCfg(db, env)
  const rules = await store.getRules(db)
  const connections = await store.getAllConnections(db)
  const writeConn = connections.find((c) => c.role === 'write') || null
  const bookingCalendars = writeConn
    ? (await store.getSelections(db, writeConn.connection_id)).map((s) => ({ id: s.calendar_id, name: s.name || s.calendar_id }))
    : []

  // Booleans only for credentials. Never a value.
  return json(200, {
    googleConfigured: Boolean(cfg.google_client_id && cfg.google_client_secret),
    zohoConfigured: Boolean(cfg.zoho_client_id && cfg.zoho_client_secret),
    turnstileConfigured: Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY),
    zohoAccountEmail: cfg.zoho_account_email || '',
    connections: connections.map((c) => ({ connectionId: c.connection_id, provider: c.provider, role: c.role, accountEmail: c.account_email })),
    writeAccount: writeConn ? writeConn.account_email : null,
    writeCalendarId: cfg.write_calendar_id || '',
    bookingCalendars,
    uniqueMeet: cfg.write_calendar_meet === '1',
    meetLink: cfg.meet_link || '',
    internalAttendeeEmail: cfg.internal_attendee_email || '',
    rules,
  })
}

export async function onRequestPut({ request, env }) {
  let body
  try { body = await request.json() } catch { return json(400, { error: 'invalid json' }) }
  const db = env.DB

  // Client ids/secrets are deliberately NOT accepted here: they are Worker
  // vars/secrets. Any google/zoho credential fields in the body are ignored.

  if (typeof body?.meetLink === 'string') {
    const v = body.meetLink.trim()
    if (v && !HTTPS.test(v)) return json(400, { error: 'The meeting link must start with https://' })
    await store.setConfig(db, 'meet_link', v)
  }
  if (typeof body?.internalAttendeeEmail === 'string') {
    await store.setConfig(db, 'internal_attendee_email', body.internalAttendeeEmail.trim())
  }
  if (typeof body?.zohoAccountEmail === 'string') {
    await store.setConfig(db, 'zoho_account_email', body.zohoAccountEmail.trim())
  }

  if (typeof body?.writeCalendarId === 'string' && body.writeCalendarId) {
    const writeConn = await store.getWriteConnection(db)
    if (!writeConn) return json(400, { error: 'Connect a booking account first.' })
    const sel = await store.getSelections(db, writeConn.connection_id)
    if (!sel.some((s) => s.calendar_id === body.writeCalendarId)) {
      return json(400, { error: 'That calendar does not belong to the booking account.' })
    }
    const cfg = await loadCfg(db, env)
    const token = await accessTokenFor(db, cfg, writeConn)
    const cal = (await google.listCalendars(token)).find((c) => c.id === body.writeCalendarId)
    await store.setConfig(db, 'write_calendar_id', body.writeCalendarId)
    await store.setConfig(db, 'write_calendar_meet', cal?.meet ? '1' : '0')
  }

  const r = body?.rules
  if (r) {
    if (r.timezone) await store.setConfig(db, 'rules_timezone', String(r.timezone))
    if (Array.isArray(r.weekdays)) await store.setConfig(db, 'rules_weekdays', r.weekdays.join(','))
    if (r.startTime) await store.setConfig(db, 'rules_start_time', String(r.startTime))
    if (r.endTime) await store.setConfig(db, 'rules_end_time', String(r.endTime))
    for (const [field, key] of [
      ['intervalMinutes', 'rules_interval_minutes'],
      ['minNoticeMinutes', 'rules_min_notice_minutes'],
      ['horizonDays', 'rules_horizon_days'],
    ]) {
      if (r[field] != null && r[field] !== '') await store.setConfig(db, key, String(r[field]))
    }
  }
  return json(200, { ok: true })
}
