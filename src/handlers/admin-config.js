import * as store from '../core/calendar-store.js'
import * as google from '../core/google-calendar.js'
import { accessTokenFor } from '../core/booking-core.js'
import { loadCfg } from './context.js'
import { validateTopicList, topicsFromConfig } from '../../public/topics.js'

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
    ...(({ topics, allowOther }) => ({ meetingTopics: topics, allowOtherTopic: allowOther }))(topicsFromConfig(cfg)),
  })
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const WRITABLE = ['owner', 'writer']
const present = (v) => v != null && v !== ''

/** A whole number, from a number or an integer-shaped string ("20"). NaN otherwise. */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return NaN
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const INT_RULES = [
  ['intervalMinutes', 'rules_interval_minutes', 5, 240],
  ['minNoticeMinutes', 'rules_min_notice_minutes', 0, 10080],
  ['horizonDays', 'rules_horizon_days', 1, 365],
]

/**
 * Validate the whole body and return the config writes it implies, or an
 * error. Pure apart from reading stored rules and (for writeCalendarId) asking
 * Google: NOTHING is written until every field has passed.
 */
async function plan(db, env, body) {
  const writes = []
  const bad = (error, status = 400) => ({ error, status })

  if (typeof body?.meetLink === 'string') {
    const v = body.meetLink.trim()
    if (v && !HTTPS.test(v)) return bad('meetLink: the meeting link must start with https://')
    writes.push(['meet_link', v])
  }
  for (const [field, key] of [['internalAttendeeEmail', 'internal_attendee_email'], ['zohoAccountEmail', 'zoho_account_email']]) {
    if (typeof body?.[field] !== 'string') continue
    const v = body[field].trim()
    if (v && !EMAIL.test(v)) return bad(`${field} must be empty or an email address`)
    writes.push([key, v])
  }

  const r = body?.rules
  if (r != null) {
    if (typeof r !== 'object' || Array.isArray(r)) return bad('rules must be an object')
    if (present(r.timezone)) {
      if (typeof r.timezone !== 'string' || !validTimeZone(r.timezone)) return bad('rules.timezone is not a known time zone')
      writes.push(['rules_timezone', r.timezone])
    }
    if (r.weekdays != null) {
      const w = r.weekdays
      if (!Array.isArray(w) || w.length === 0 || !w.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) || new Set(w).size !== w.length) {
        // ISO numbering, the same convention tz.js and computeSlots use
        // (Mon=1 .. Sun=7). Accepting 0-6 here once made Sunday unbookable.
        return bad('rules.weekdays must be a non-empty list of distinct days 1-7 (1=Mon … 7=Sun)')
      }
      writes.push(['rules_weekdays', w.join(',')])
    }
    for (const field of ['startTime', 'endTime']) {
      if (!present(r[field])) continue
      if (typeof r[field] !== 'string' || !TIME.test(r[field])) return bad(`rules.${field} must be HH:MM (24-hour)`)
    }
    if (present(r.startTime) || present(r.endTime)) {
      const stored = await store.getRules(db)
      const startTime = present(r.startTime) ? r.startTime : stored.startTime
      const endTime = present(r.endTime) ? r.endTime : stored.endTime
      // Zero-padded HH:MM compares correctly as a string.
      if (!(startTime < endTime)) return bad('rules.endTime must be later than rules.startTime')
      if (present(r.startTime)) writes.push(['rules_start_time', r.startTime])
      if (present(r.endTime)) writes.push(['rules_end_time', r.endTime])
    }
    for (const [field, key, min, max] of INT_RULES) {
      if (!present(r[field])) continue
      const n = toInt(r[field])
      if (!(n >= min && n <= max)) return bad(`rules.${field} must be a whole number from ${min} to ${max}`)
      writes.push([key, String(n)])
    }
  }

  if (body?.meetingTopics !== undefined) {
    const v = validateTopicList(body.meetingTopics)
    if (!v.ok) return bad(`meetingTopics: ${v.error}`)
    writes.push(['meeting_topics', JSON.stringify(v.topics)])
  }
  if (body?.allowOtherTopic !== undefined) {
    if (typeof body.allowOtherTopic !== 'boolean') return bad('allowOtherTopic must be true or false')
    writes.push(['allow_other_topic', body.allowOtherTopic ? '1' : '0'])
  }

  // Last, because it is the only check that leaves the Worker.
  if (typeof body?.writeCalendarId === 'string' && body.writeCalendarId) {
    const id = body.writeCalendarId
    const writeConn = await store.getWriteConnection(db)
    if (!writeConn) return bad('Connect a booking account first.')
    const sel = await store.getSelections(db, writeConn.connection_id)
    if (!sel.some((s) => s.calendar_id === id)) return bad('writeCalendarId: that calendar does not belong to the booking account.')
    let live
    try {
      const cfg = await loadCfg(db, env)
      const token = await accessTokenFor(db, cfg, writeConn)
      live = await google.listCalendars(token)
    } catch {
      return bad('Could not reach Google to check that calendar', 502)
    }
    const cal = live.find((c) => c.id === id)
    if (!cal) return bad('writeCalendarId: Google no longer lists that calendar for the booking account.')
    if (!WRITABLE.includes(cal.accessRole)) {
      return bad('writeCalendarId: the booking account cannot write to that calendar (needs owner or writer access).')
    }
    writes.push(['write_calendar_id', id], ['write_calendar_meet', cal.meet ? '1' : '0'])
  }
  return { writes }
}

export async function onRequestPut({ request, env }) {
  let body
  try { body = await request.json() } catch { return json(400, { error: 'invalid json' }) }
  const db = env.DB

  // Client ids/secrets are deliberately NOT accepted here: they are Worker
  // vars/secrets. Any google/zoho credential fields in the body are ignored.
  const result = await plan(db, env, body)
  if (result.error) return json(result.status, { error: result.error })
  for (const [key, value] of result.writes) await store.setConfig(db, key, value)
  return json(200, { ok: true })
}
