import { listUpcomingPublic } from '../core/public-bookings.js'

export async function onRequestGet({ env }) {
  const rows = await listUpcomingPublic(env.DB, new Date().toISOString())
  return Response.json({
    bookings: rows.map((r) => ({
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
    })),
  })
}
