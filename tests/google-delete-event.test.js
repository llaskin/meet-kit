import assert from 'node:assert/strict'
import test from 'node:test'
import { deleteEvent, googleApi } from '../src/core/google-calendar.js'

// body defaults to null, not '': 204/205/304 are "null body status" codes and
// `new Response('', { status: 204 })` is a spec TypeError in current Node.
function stub(status, body = null) {
  const calls = []
  googleApi.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return new Response(body, { status })
  }
  return calls
}

test('it DELETEs the event and notifies every guest', async () => {
  const calls = stub(204)
  await deleteEvent('tok', { calendarId: 'primary', eventId: 'evt123' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.method, 'DELETE')
  assert.match(calls[0].url, /\/calendars\/primary\/events\/evt123/)
  // Without this Google drops the event from the organiser's calendar, mails
  // nobody, and every guest keeps a dead entry they will still show up for.
  assert.match(calls[0].url, /sendUpdates=all/)
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok')
})

test('it url-encodes a calendar id that is an email address', async () => {
  const calls = stub(204)
  await deleteEvent('tok', { calendarId: 'a b@example.com', eventId: 'e/1' })
  assert.match(calls[0].url, /calendars\/a%20b%40example\.com/)
  assert.match(calls[0].url, /events\/e%2F1/)
})

test('404 and 410 report alreadyGone rather than throwing', async () => {
  // The event was deleted by hand in Google Calendar. That is the desired end
  // state, so cancellation must be able to record it and move on.
  for (const status of [404, 410]) {
    stub(status)
    const r = await deleteEvent('tok', { calendarId: 'primary', eventId: 'gone' })
    assert.equal(r.alreadyGone, true, `status ${status}`)
    assert.equal(r.deleted, false)
  }
})

test('a 2xx reports deleted', async () => {
  stub(204)
  const r = await deleteEvent('tok', { calendarId: 'primary', eventId: 'e' })
  assert.deepEqual(r, { deleted: true, alreadyGone: false })
})

test('any other failure throws, so the caller cannot record a cancellation', async () => {
  for (const status of [401, 403, 500, 503]) {
    stub(status, 'upstream boom')
    await assert.rejects(
      () => deleteEvent('tok', { calendarId: 'primary', eventId: 'e' }),
      /calendar delete failed/i,
      `status ${status} must throw`,
    )
  }
})
