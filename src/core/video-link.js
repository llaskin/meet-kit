// Create the booking event with a working video link, or create nothing.
//
// Preference: a unique Google Meet room (when the calendar allows it), then
// the owner's fixed link. A booking is never confirmed without a link: every
// path that ends without one deletes the event and throws NoLinkError.
import * as google from './google-calendar.js'

export class NoLinkError extends Error {}

// Total ~5s of waiting: well inside a Worker request, long enough for Google's
// usual async conference creation.
export const POLL_DELAYS_MS = [500, 1000, 1500, 2000]
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fixedDescription = (link) => `Join the meeting: ${link}`

export async function createBookingEvent(token, { calendarId, uniqueMeet, fixedLink, event, sleep = realSleep, pollDelays = POLL_DELAYS_MS }) {
  if (!uniqueMeet && !fixedLink) throw new NoLinkError('no video link available')

  if (!uniqueMeet) {
    const created = await google.createEvent(token, {
      ...event, calendarId, location: fixedLink, description: fixedDescription(fixedLink),
    })
    return { eventId: created.eventId, meetUrl: fixedLink, source: 'fixed' }
  }

  const created = await google.createEvent(token, { ...event, calendarId, conference: true })
  let { meetUrl, conferenceStatus } = created

  for (const ms of pollDelays) {
    if (conferenceStatus !== 'pending') break
    await sleep(ms)
    try {
      ;({ meetUrl, conferenceStatus } = await google.getEvent(token, { calendarId, eventId: created.eventId }))
    } catch {
      // A poll failure is not proof the conference never confirmed, but we have
      // no way to find out short of retrying indefinitely. Treat it the same as
      // an explicit 'failure' status: stop polling and fall into the existing
      // fixed-link -> delete -> NoLinkError path below.
      conferenceStatus = 'failure'
      break
    }
  }

  if (conferenceStatus === 'success' && meetUrl) {
    return { eventId: created.eventId, meetUrl, source: 'unique' }
  }

  if (fixedLink) {
    try {
      await google.patchEventLink(token, { calendarId, eventId: created.eventId, link: fixedLink })
      return { eventId: created.eventId, meetUrl: fixedLink, source: 'fixed' }
    } catch {
      // fall through to cleanup
    }
  }

  try {
    await google.deleteEvent(token, { calendarId, eventId: created.eventId })
  } catch (err) {
    // The visitor-facing outcome does not change -- we still throw NoLinkError
    // below -- but a failed cleanup delete leaves an invited, linkless event on
    // the owner's calendar, which needs to show up in Worker logs.
    console.error('meet-kit: could not delete event after link failure', {
      eventId: created.eventId, calendarId, error: String(err?.message || err),
    })
  }
  throw new NoLinkError('could not attach a video link')
}
