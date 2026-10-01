import assert from 'node:assert/strict'
import test from 'node:test'
import * as google from '../src/core/google-calendar.js'

const originalFetch = google.googleApi.fetch
test.afterEach(() => {
  google.googleApi.fetch = originalFetch
})

function stub(responses) {
  const calls = []
  google.googleApi.fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    const body = responses.shift()
    return new Response(JSON.stringify(body), { status: body?.__status || 200 })
  }
  return calls
}

test('listCalendars reports whether Meet can be created', async () => {
  stub([{ items: [
    { id: 'a@x.test', summary: 'A', primary: true, conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } },
    { id: 'b@group.calendar.google.com', summary: 'B' },
  ] }])
  const cals = await google.listCalendars('tok')
  assert.deepEqual(cals.map((c) => c.meet), [true, false])
})

test('createEvent without conference keeps the original URL and body', async () => {
  const calls = stub([{ id: 'e1' }])
  await google.createEvent('tok', { calendarId: 'primary', summary: 's', startIso: 'a', endIso: 'b', timeZone: 'UTC', attendeeEmail: 'v@x.test' })
  assert.match(calls[0].url, /events\?sendUpdates=all$/)
  assert.equal(JSON.parse(calls[0].opts.body).conferenceData, undefined)
})

test('createEvent with conference sends a hangoutsMeet createRequest', async () => {
  const calls = stub([{ id: 'e1', hangoutLink: 'https://meet.google.com/abc', conferenceData: { createRequest: { status: { statusCode: 'success' } } } }])
  const out = await google.createEvent('tok', { calendarId: 'primary', summary: 's', startIso: 'a', endIso: 'b', timeZone: 'UTC', attendeeEmail: 'v@x.test', conference: true })
  assert.match(calls[0].url, /sendUpdates=all&conferenceDataVersion=1$/)
  const cr = JSON.parse(calls[0].opts.body).conferenceData.createRequest
  assert.equal(cr.conferenceSolutionKey.type, 'hangoutsMeet')
  assert.ok(cr.requestId)
  assert.deepEqual(out, { eventId: 'e1', htmlLink: '', meetUrl: 'https://meet.google.com/abc', conferenceStatus: 'success' })
})

test('getEvent returns link and status', async () => {
  stub([{ id: 'e1', hangoutLink: 'https://meet.google.com/x', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } }])
  assert.deepEqual(await google.getEvent('tok', { calendarId: 'primary', eventId: 'e1' }),
    { meetUrl: 'https://meet.google.com/x', conferenceStatus: 'pending' })
})

test('patchEventLink replaces the conference with the fixed link and notifies guests', async () => {
  const calls = stub([{ id: 'e1' }])
  await google.patchEventLink('tok', { calendarId: 'primary', eventId: 'e1', link: 'https://zoom.example/j/1' })
  assert.equal(calls[0].opts.method, 'PATCH')
  assert.match(calls[0].url, /events\/e1\?sendUpdates=all&conferenceDataVersion=1$/)
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.location, 'https://zoom.example/j/1')
  assert.equal(body.conferenceData, null)
})
