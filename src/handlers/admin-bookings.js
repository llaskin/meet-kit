import { listUpcomingPublic, listRecentPublic } from '../core/public-bookings.js'

// How far back the "Recent" list (the one with "Mark no-show") reaches.
export const RECENT_DAYS = 14

const shape = (r) => ({
  id: r.id,
  start: r.start_utc,
  end: r.end_utc,
  durationMin: r.duration_min,
  attendeeName: r.attendee_name || '',
  attendeeEmail: r.attendee_email || '',
  company: r.company || '',
  notes: r.notes || '',
  meetUrl: r.meet_url || '',
  meetUrlSource: r.meet_url_source || '',
  topic: r.topic || '',
})

export async function onRequestGet({ env }) {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const fromIso = new Date(now - RECENT_DAYS * 86_400_000).toISOString()
  const [upcoming, recent] = await Promise.all([
    listUpcomingPublic(env.DB, nowIso),
    listRecentPublic(env.DB, fromIso, nowIso),
  ])
  return Response.json({
    bookings: upcoming.map(shape),
    // Same shape, plus the no-show stamp ('' when not marked).
    recent: recent.map((r) => ({ ...shape(r), noShowAt: r.no_show_at || '' })),
  })
}
