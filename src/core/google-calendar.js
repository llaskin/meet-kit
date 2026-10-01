// Raw REST against Google Calendar API v3. The googleapis SDK does not run on
// Workers, and none of this needs it.
//
// `googleApi` is an injectable indirection over fetch, following the pattern in
// lib/zoho-client.js: ESM namespace bindings are read-only, so tests stub the
// network by reassigning googleApi.fetch.
export const googleApi = {
  fetch: (...args) => fetch(...args),
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/calendar/v3'

// freeBusy accepts at most 50 calendars per request (calendarExpansionMax).
const FREEBUSY_MAX_CALENDARS = 50

// Google documents no maximum span between timeMin and timeMax -- but it does
// not document the range as unbounded either, and the failure mode if an
// undocumented cap exists is that the whole query fails and the tool reports
// zero availability. Chunked defensively.
//
// Safe to chunk because freeBusy returns busy windows CLIPPED to the query
// range rather than events-that-start-in-range, so a meeting straddling a
// boundary comes back as two abutting halves -- which mergeBusy() coalesces
// back into one, since it merges exactly-adjacent intervals.
const FREEBUSY_MAX_DAYS = 30

function timeWindows(timeMin, timeMax, maxDays = FREEBUSY_MAX_DAYS) {
  const span = maxDays * 86_400_000
  const end = Date.parse(timeMax)
  const out = []
  for (let s = Date.parse(timeMin); s < end; s += span) {
    out.push([new Date(s).toISOString(), new Date(Math.min(s + span, end)).toISOString()])
  }
  return out.length ? out : [[timeMin, timeMax]]
}

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  // Needed in Phase 2 to create the booking event. v1 pastes a fixed Meet link
  // rather than requesting conferenceData, so the scope question that would
  // arise with auto-generated conferences does not apply here.
  'https://www.googleapis.com/auth/calendar.events',
].join(' ')

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    // offline returns a refresh token, but only on a FIRST grant. prompt=consent
    // forces a fresh consent so a re-connect also yields one; without it a
    // reconnect silently returns no refresh_token and the connection is dead.
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function tokenRequest(form) {
  const res = await googleApi.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // invalid_grant means the refresh token is revoked, expired or was issued
    // by a consent screen still in Testing. Retrying never helps.
    if (body.error === 'invalid_grant') {
      throw new Error('Google refresh token is no longer valid — reconnect Google Calendar in config')
    }
    throw new Error(`Google token request failed: ${body.error || res.status}`)
  }
  return body
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const body = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  }
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  // Google does not rotate the refresh token on refresh; keep the original.
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  }
}

// Google's holiday feeds are readable as calendars but freeBusy returns
// notFound for them, so including one blanks availability for the whole account
// until an operator unchecks it. They contain no conflicts worth honouring.
//
// Keyed on the id pattern, deliberately not the display name: a user's own
// "Holiday Planning" calendar is a real calendar with real conflicts.
const HOLIDAY_FEED = /#holiday@group\.v\.calendar\.google\.com$/

export function isHolidayFeed(calendarId) {
  return HOLIDAY_FEED.test(String(calendarId || ''))
}

export async function listCalendars(accessToken) {
  const res = await googleApi.fetch(`${API}/users/me/calendarList?maxResults=250`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Google calendarList failed: ${res.status}`)
  const body = await res.json()
  return (body.items || [])
    .filter((c) => !isHolidayFeed(c.id))
    .map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      primary: Boolean(c.primary),
    }))
}

/**
 * Busy blocks across `calendarIds`, plus any per-calendar failures.
 *
 * Google reports per-calendar failures inside an HTTP 200 body. The caller MUST
 * treat a non-empty `errors` array as unknown availability and fail closed —
 * see functions/api/calendar/slots.js.
 */
export async function freeBusy(accessToken, calendarIds, timeMin, timeMax) {
  const busy = []
  const errors = []

  const seenErrors = new Set()
  for (const [winMin, winMax] of timeWindows(timeMin, timeMax)) {
    for (let i = 0; i < calendarIds.length; i += FREEBUSY_MAX_CALENDARS) {
      const chunk = calendarIds.slice(i, i + FREEBUSY_MAX_CALENDARS)
      const res = await googleApi.fetch(`${API}/freeBusy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: winMin, timeMax: winMax, items: chunk.map((id) => ({ id })) }),
      })
      if (!res.ok) {
        // Deduplicated: one unreadable calendar would otherwise report once per
        // time window, turning a single fault into a wall of identical errors.
        for (const id of chunk) {
          if (!seenErrors.has(id)) { seenErrors.add(id); errors.push({ calendarId: id, reason: `http_${res.status}` }) }
        }
        continue
      }
      const body = await res.json()
      for (const [calendarId, entry] of Object.entries(body.calendars || {})) {
        if (entry.errors?.length) {
          if (!seenErrors.has(calendarId)) {
            seenErrors.add(calendarId)
            errors.push({ calendarId, reason: entry.errors[0].reason || 'unknown' })
          }
          continue
        }
        for (const b of entry.busy || []) busy.push({ start: b.start, end: b.end })
      }
    }
  }

  return { busy, errors }
}

/**
 * Create a calendar event carrying a pre-existing meeting link.
 *
 * No conferenceData is requested: v1 reuses one fixed Meet link from config
 * rather than minting a code per event (see the spec's "Why a single fixed Meet
 * link"). Switching to per-meeting codes later means adding a createRequest
 * here plus polling until the conference reports success -- contained to this
 * function.
 *
 * sendUpdates=all is not optional. Without it Google creates the event and
 * emails nobody, which is the single most common "why didn't they get the
 * invite" failure.
 */
export async function createEvent(accessToken, {
  calendarId, summary, description, location,
  startIso, endIso, timeZone, attendeeEmail, attendeeName, internalEmail,
}) {
  const attendee = { email: attendeeEmail }
  if (attendeeName) attendee.displayName = attendeeName
  const attendees = [attendee]

  // The account that owns this calendar is the ORGANIZER and is already on the
  // event; adding it as its own guest is redundant. internalEmail is for a
  // different address -- typically the operator's real working inbox, which is
  // not the Google account the tool writes to. Without it a booked meeting
  // lands only on an account they may never open.
  if (internalEmail && internalEmail.toLowerCase() !== attendeeEmail.toLowerCase()) {
    attendees.push({ email: internalEmail })
  }

  const res = await googleApi.fetch(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description,
        location,
        start: { dateTime: startIso, timeZone },
        end: { dateTime: endIso, timeZone },
        attendees,
      }),
    },
  )
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Google event creation failed: ${body?.error?.message || res.status}`)
  }
  return { eventId: body.id, htmlLink: body.htmlLink || '' }
}

/**
 * Delete an event and notify its guests.
 *
 * sendUpdates=all is the mirror of the rule on createEvent above: without it
 * Google removes the event from the organiser's calendar, emails nobody, and
 * every guest keeps a dead entry. The event carries two guests -- the attendee
 * and the internalEmail operator inbox -- and both must be told.
 *
 * Returns { deleted, alreadyGone } rather than throwing on 404/410: an event a
 * human already deleted in Google is the end state we want, so the caller
 * should still record the cancellation. Every OTHER failure throws, because the
 * event may still exist and we must never record a cancellation we cannot prove.
 */
export async function deleteEvent(accessToken, { calendarId, eventId }) {
  const res = await googleApi.fetch(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  )

  if (res.status === 404 || res.status === 410) return { deleted: false, alreadyGone: true }
  if (!res.ok) throw new Error(`calendar delete failed: ${res.status}`)
  return { deleted: true, alreadyGone: false }
}
