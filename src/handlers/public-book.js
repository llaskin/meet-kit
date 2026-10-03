import * as store from '../core/calendar-store.js'
import { PUBLIC_DURATIONS, coerceDuration, isAllowedSpan } from '../core/durations.js'
import { accessTokenFor } from '../core/booking-core.js'
import { verifyTurnstile } from '../core/turnstile.js'
import { savePublicBooking, countRecentByEmail, countRecentByIp, countRecentTotal } from '../core/public-bookings.js'
import { validateCustomTopic, resolveTopic, eventTitle, topicsFromConfig, OTHER_CHOICE } from '../../public/topics.js'
import { gatherBusy } from '../core/busy.js'
import { computeSlots } from '../core/slots.js'
import { utcToZonedParts } from '../core/tz.js'
import { loadCfg } from './context.js'
import { createBookingEvent } from '../core/video-link.js'
import * as google from '../core/google-calendar.js'

const json = (status, body) => Response.json(body, { status })

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The identity the per-email cap counts.
 *
 * Lower-casing alone is not enough: victim@gmail.com, victim+1@gmail.com and
 * v.ictim@gmail.com are one inbox but three distinct strings, so an attacker
 * could send unlimited invites to a single victim. Strip the +tag everywhere,
 * and strip dots on the providers that ignore them.
 */
const DOTLESS = new Set(['gmail.com', 'googlemail.com'])
export function capIdentity(email) {
  const [local = '', domain = ''] = String(email || '').toLowerCase().split('@')
  const untagged = local.split('+')[0]
  const bare = DOTLESS.has(domain) ? untagged.replace(/\./g, '') : untagged
  return `${bare}@${domain}`
}

// One message for every refusal that is not a plain typo. An attacker probing
// this endpoint from the open internet must learn nothing about WHY a
// request failed -- honeypot tripped, bad Turnstile token, rate limit,
// unreadable calendar, misconfigured backend -- beyond "try later". The one
// exception is a malformed email address: that is a genuine mistake a real
// visitor needs to see and fix, not an abuse signal.
const GENERIC = 'Unable to book that time. Please try again later.'

const EMAIL_CAP = 3
const IP_CAP = 5
// Backstop across every visitor. Per-actor caps bound one attacker; this
// bounds the damage when they rotate addresses and IPs.
const TOTAL_CAP = 12
const CAP_HOURS = 24

/**
 * Unauthenticated booking, posted from the public /meet page.
 *
 * The most security-sensitive file in the project: anyone on the internet can
 * reach this with no session and no authentication of any kind. The ORDER of
 * the checks below is the design, not an accident:
 *
 *   1. honeypot   -- costs a bot nothing of ours: no Turnstile round-trip, no
 *                    DB read.
 *   2. fields     -- a Turnstile token is single-use and expires in 300s; a
 *                    typo in the form must not spend one. A malformed custom
 *                    "Other" topic is checked here too, same reason: it is a
 *                    visitor typo, not abuse, so fixing it must not cost a
 *                    new token.
 *   3. Turnstile  -- only real, human-passed requests reach the DB at all.
 *   4. rate caps  -- per-email and per-IP, keyed off public_bookings, the
 *                    only storage this endpoint is allowed to touch besides
 *                    the calendar itself.
 *   5. topic      -- resolve the choice against the CURRENT owner config
 *                    (public/topics.js's resolveTopic); a topic removed since
 *                    the page loaded refuses with "stale", before any
 *                    calendar read happens on its behalf.
 *   6. freeness   -- gatherBusy (busy.js) + computeSlots (slots.js), the
 *                    same fail-closed conflict logic /api/public/slots uses.
 *   7. create     -- the calendar event.
 *   8. record     -- ONE row in public_bookings, and nothing else -- this
 *                    path must never write to any other table in schema.sql.
 */
export async function onRequestPost({ request, env, site }) {
  let b
  try {
    b = await request.json()
  } catch {
    return json(400, { error: GENERIC })
  }

  // Honeypot FIRST. Real visitors never see or fill this field
  // (public/meet.html hides it off-screen). The response must not say why.
  if (b?.website) return json(400, { error: GENERIC })

  // --- Field validation, before Turnstile is ever consulted ----------------
  const email = typeof b?.attendee_email === 'string' ? b.attendee_email : ''
  if (!EMAIL.test(email)) {
    return json(400, { error: 'Enter a valid email address.' })
  }
  if (!b?.start || !b?.end) return json(400, { error: GENERIC })

  const duration = coerceDuration(b.duration_minutes, PUBLIC_DURATIONS)
  if (!isAllowedSpan(b.start, b.end, [duration])) {
    return json(400, { error: GENERIC })
  }

  // A malformed custom topic is a visitor typo, not abuse: say so, and check
  // it BEFORE Turnstile so fixing it does not need a new token.
  if (b?.topic_choice === OTHER_CHOICE) {
    const c = validateCustomTopic(b.topic_custom)
    if (!c.ok) return json(400, { error: c.error })
  }

  const remoteIp = request.headers.get('CF-Connecting-IP') || ''

  // --- Turnstile -------------------------------------------------------------
  const verified = await verifyTurnstile({
    token: b.turnstileToken,
    secret: env.TURNSTILE_SECRET_KEY,
    remoteIp,
  })
  if (!verified) return json(400, { error: GENERIC })

  const db = env.DB

  // --- Rate caps ---------------------------------------------------------
  if ((await countRecentByEmail(db, capIdentity(email), CAP_HOURS)) >= EMAIL_CAP) {
    return json(429, { error: GENERIC })
  }
  if ((await countRecentByIp(db, remoteIp, CAP_HOURS)) >= IP_CAP) {
    return json(429, { error: GENERIC })
  }
  if ((await countRecentTotal(db, CAP_HOURS)) >= TOTAL_CAP) {
    return json(429, { error: GENERIC })
  }

  const cfg = await loadCfg(db, env)
  const rules = await store.getRules(db)
  const conn = await store.getWriteConnection(db)
  const fixedLink = cfg.meet_link || ''
  const uniqueMeet = cfg.write_calendar_meet === '1'
  // No booking account, or no possible video link, is an ops misconfiguration.
  if (!conn || (!uniqueMeet && !fixedLink)) return json(400, { error: GENERIC })

  // Resolve against the CURRENT topic config -- a page loaded before the
  // owner removed a topic, or toggled "Offer Other" off, must refuse rather
  // than silently book under a choice that no longer exists.
  const resolved = resolveTopic({ ...topicsFromConfig(cfg), choice: b.topic_choice, custom: b.topic_custom })
  if (!resolved.ok) {
    if (resolved.code === 'stale') return json(400, { error: 'That topic is no longer offered. Please reload the page.' })
    if (resolved.code === 'required') return json(400, { error: "Please choose what the call is about. If you don't see that question, reload the page." })
    return json(400, { error: resolved.error })
  }

  // --- The window must be one we actually OFFER ----------------------------
  //
  // Validating only the SPAN was not enough. isAllowedSpan proves the meeting
  // is 30 or 60 minutes; it says nothing about WHERE. An anonymous caller could
  // post 03:00 on a Sunday in 2031, or a date in 2019, and a conflict check
  // alone would happily query the operator's personal, work and Zoho
  // calendars for that window -- a free/busy oracle over arbitrary time, and
  // a way to write events outside business hours entirely.
  //
  // So recompute the public grid from TODAY and require exact membership. That
  // subsumes freeness, business hours, weekday, minimum notice, the horizon and
  // interval alignment in one check, and guarantees /book can only ever accept
  // something /slots would have shown.
  const nowMs = Date.now()
  const tp = utcToZonedParts(nowMs, rules.timezone)
  const today = `${tp.year}-${String(tp.month).padStart(2, '0')}-${String(tp.day).padStart(2, '0')}`
  let offered
  try {
    const { busy, errors } = await gatherBusy({ db, cfg, fromDay: today, rules })
    if (errors.length > 0) return json(409, { error: GENERIC })
    offered = computeSlots({ busy, rules: { ...rules, durationMinutes: duration }, now: nowMs, fromDay: today })
  } catch {
    return json(409, { error: GENERIC })
  }
  if (!offered.some((sl) => sl.start === b.start && sl.end === b.end)) {
    return json(409, { error: GENERIC })
  }

  // --- Everything below is attacker-controlled text. Treat it as hostile. ---
  //
  // google.createEvent posts with sendUpdates=all, so whatever lands here is
  // MAILED from the operator's own Google account. Unbounded, that is an
  // anonymous phishing relay: a 50KB body and a chosen subject, delivered as a
  // real invite from a real business.
  //
  // The summary is therefore FIXED for public bookings -- the ONLY caller text
  // ever appended to the subject line is the topic, and only after it passed
  // resolveTopic above (a listed topic verbatim, or "Other – " plus text that
  // already passed validateCustomTopic's link/contact-detail filter). No other
  // visitor field reaches the subject; the notes are stored in D1 for the
  // operator to read rather than echoed into the invite body.
  const clamp = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '')
  const attendeeName = clamp(b.attendee_name, 80)
  const company = clamp(b.company, 80)
  const notes = clamp(b.notes, 500)

  const writeCalendarId = cfg.write_calendar_id || 'primary'

  let created
  let token
  try {
    token = await accessTokenFor(db, cfg, conn)
    created = await createBookingEvent(token, {
      calendarId: writeCalendarId,
      uniqueMeet,
      fixedLink,
      event: {
        // Fixed title from meet.config.json, plus the resolved topic (if
        // any) -- see the "attacker-controlled text" note above.
        summary: eventTitle(site?.eventTitle || 'Intro call', resolved.topic),
        startIso: b.start,
        endIso: b.end,
        timeZone: rules.timezone,
        attendeeEmail: email,
        attendeeName,
        internalEmail: cfg.internal_attendee_email || '',
      },
    })
  } catch {
    // NoLinkError or any Google failure: nothing is recorded, and
    // createBookingEvent has already removed any event it made.
    return json(502, { error: GENERIC })
  }

  // A UNIQUE(start_utc) violation means a concurrent request won this slot
  // between our membership check and this insert. The event we just created is
  // a duplicate; report it as taken rather than confirming a booking we did not
  // record.
  try {
    await savePublicBooking(db, {
      email,
      capIdentity: capIdentity(email),
      name: attendeeName,
      company,
      notes,
      durationMinutes: duration,
      startUtc: b.start,
      endUtc: b.end,
      topic: resolved.topic,
      eventId: created.eventId,
      meetUrl: created.meetUrl,
      meetUrlSource: created.source,
      clientIp: remoteIp,
      calendarId: writeCalendarId,
    })
  } catch {
    // UNIQUE(start_utc): a concurrent request won this slot. The event we just
    // created is a duplicate -- remove it so the attendee is not double-invited.
    await google.deleteEvent(token, { calendarId: writeCalendarId, eventId: created.eventId }).catch(() => {})
    return json(409, { error: GENERIC })
  }

  // Deliberately minimal. No eventId, no connection details, nothing about
  // this endpoint's internals -- just enough for the confirmation screen.
  return json(200, { ok: true, start: b.start, end: b.end, meetUrl: created.meetUrl })
}
