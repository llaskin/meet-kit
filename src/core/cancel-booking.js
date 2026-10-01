// The one cancellation sequence.
//
// ORDER IS LOAD-BEARING: the Google event is deleted BEFORE the record moves.
// If Google succeeds and the D1 write then fails, the result is a deleted
// meeting still listed as booked -- wrong, but visibly wrong and safe to
// re-run. The reverse order's failure is a record saying "cancelled" while
// the meeting is still live on every attendee's calendar.

import * as store from './calendar-store.js'
import * as google from './google-calendar.js'
import { accessTokenFor } from './booking-core.js'
import { getPublicBooking, cancelPublicBooking } from './public-bookings.js'

export async function cancelBooking(db, cfg, { id, cancelledBy, nowIso }) {
  const row = await getPublicBooking(db, id)
  if (!row) return { ok: false, status: 404, error: 'Booking not found' }

  let alreadyGone = false
  if (row.event_id) {
    try {
      const conn = await store.getWriteConnection(db)
      const token = await accessTokenFor(db, cfg, conn)
      const res = await google.deleteEvent(token, {
        // The calendar the event was CREATED on, pinned at booking time.
        calendarId: row.calendar_id || cfg.write_calendar_id || 'primary',
        eventId: row.event_id,
      })
      alreadyGone = res.alreadyGone
    } catch {
      return { ok: false, status: 502, error: 'Could not cancel the calendar event' }
    }
  }

  try {
    await cancelPublicBooking(db, { row, cancelledAt: nowIso, cancelledBy })
  } catch {
    // Only here has a Google delete (if any) already succeeded, so only here
    // may the caller be told the meeting itself is gone.
    return {
      ok: false,
      status: 500,
      error: row.event_id
        ? 'The meeting was cancelled and the guests were notified, but the record could not be updated. Retrying is safe.'
        : 'Could not cancel the booking',
    }
  }
  return { ok: true, alreadyGone }
}
