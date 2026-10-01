import assert from 'node:assert/strict'
import test from 'node:test'
import * as google from '../src/core/google-calendar.js'
import { createBookingEvent, NoLinkError } from '../src/core/video-link.js'

const originalFetch = google.googleApi.fetch
test.afterEach(() => {
  google.googleApi.fetch = originalFetch
})

const EVENT = { summary: 'Intro call', startIso: 'a', endIso: 'b', timeZone: 'UTC', attendeeEmail: 'v@x.test' }
const noSleep = async () => {}

function fake({ create, gets = [], patchFails = false, getFails = false, deleteStatus = 204, createFails = false }) {
  const log = []
  google.googleApi.fetch = async (url, opts = {}) => {
    const m = opts.method || 'GET'
    log.push(`${m} ${url.includes('conferenceDataVersion') ? 'conf' : 'plain'}`)
    if (m === 'POST') {
      if (createFails) throw new Error('network blip')
      return Response.json(create)
    }
    if (m === 'GET') {
      if (getFails) throw new Error('network blip')
      return Response.json(gets.shift() || {})
    }
    if (m === 'PATCH') return new Response('{}', { status: patchFails ? 500 : 200 })
    if (m === 'DELETE') return new Response(null, { status: deleteStatus })
  }
  return log
}

test('unique Meet ready immediately', async () => {
  fake({ create: { id: 'e1', hangoutLink: 'https://meet.google.com/u', conferenceData: { createRequest: { status: { statusCode: 'success' } } } } })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: '', event: EVENT, sleep: noSleep })
  assert.deepEqual(r, { eventId: 'e1', meetUrl: 'https://meet.google.com/u', source: 'unique' })
})

test('pending then success via polling', async () => {
  fake({
    create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } },
    gets: [{ conferenceData: { createRequest: { status: { statusCode: 'pending' } } } },
           { hangoutLink: 'https://meet.google.com/p', conferenceData: { createRequest: { status: { statusCode: 'success' } } } }],
  })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: '', event: EVENT, sleep: noSleep })
  assert.equal(r.meetUrl, 'https://meet.google.com/p')
  assert.equal(r.source, 'unique')
})

test('stays pending, falls back to the fixed link', async () => {
  const log = fake({ create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } } })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: 'https://zoom.example/j/1', event: EVENT, sleep: noSleep })
  assert.deepEqual(r, { eventId: 'e1', meetUrl: 'https://zoom.example/j/1', source: 'fixed' })
  assert.ok(log.some((l) => l.startsWith('PATCH')))
})

test('failure with no fixed link deletes the event and throws', async () => {
  const log = fake({ create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'failure' } } } } })
  await assert.rejects(
    createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: '', event: EVENT, sleep: noSleep }),
    NoLinkError,
  )
  assert.ok(log.some((l) => l.startsWith('DELETE')))
})

test('fixed link only: one plain create, link in location', async () => {
  const log = fake({ create: { id: 'e1' } })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: false, fixedLink: 'https://zoom.example/j/1', event: EVENT, sleep: noSleep })
  assert.deepEqual(r, { eventId: 'e1', meetUrl: 'https://zoom.example/j/1', source: 'fixed' })
  assert.deepEqual(log, ['POST plain'])
})

test('neither available: throws before any calendar call', async () => {
  const log = fake({ create: { id: 'never' } })
  await assert.rejects(
    createBookingEvent('t', { calendarId: 'c', uniqueMeet: false, fixedLink: '', event: EVENT, sleep: noSleep }),
    NoLinkError,
  )
  assert.deepEqual(log, [])
})

test('patch fails during fallback: event deleted, throws', async () => {
  const log = fake({ create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'failure' } } } }, patchFails: true })
  await assert.rejects(
    createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: 'https://zoom.example/j/1', event: EVENT, sleep: noSleep }),
    NoLinkError,
  )
  assert.ok(log.some((l) => l.startsWith('DELETE')))
})

test('getEvent throws mid-poll with a fixed link: falls back to fixed, no raw error escapes', async () => {
  const log = fake({
    create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } },
    getFails: true,
  })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: 'https://zoom.example/j/1', event: EVENT, sleep: noSleep })
  assert.deepEqual(r, { eventId: 'e1', meetUrl: 'https://zoom.example/j/1', source: 'fixed' })
  assert.ok(log.some((l) => l.startsWith('PATCH')))
})

test('getEvent throws mid-poll with no fixed link: deletes the event and throws NoLinkError', async () => {
  const log = fake({
    create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } },
    getFails: true,
  })
  await assert.rejects(
    createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: '', event: EVENT, sleep: noSleep }),
    NoLinkError,
  )
  assert.ok(log.some((l) => l.startsWith('DELETE')))
})

test('cleanup delete fails (500): still throws NoLinkError and logs the failure once', async () => {
  const log = fake({
    create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'failure' } } } },
    deleteStatus: 500,
  })
  const calls = []
  const originalError = console.error
  console.error = (...args) => calls.push(args)
  try {
    await assert.rejects(
      createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: '', event: EVENT, sleep: noSleep }),
      NoLinkError,
    )
  } finally {
    console.error = originalError
  }
  assert.ok(log.some((l) => l.startsWith('DELETE')))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'meet-kit: could not delete event after link failure')
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['calendarId', 'error', 'eventId'])
  assert.equal(calls[0][1].eventId, 'e1')
  assert.equal(calls[0][1].calendarId, 'c')
  assert.doesNotMatch(calls[0][1].error, /@/) // no attendee email or other PII in the log
})

test('createEvent itself throws: nothing was created, the error propagates unchanged', async () => {
  const log = fake({ create: { id: 'never' }, createFails: true })
  await assert.rejects(
    createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: 'https://zoom.example/j/1', event: EVENT, sleep: noSleep }),
    (err) => {
      assert.ok(!(err instanceof NoLinkError), 'should not be wrapped into NoLinkError')
      assert.match(err.message, /network blip/)
      return true
    },
  )
  assert.ok(!log.some((l) => l.startsWith('DELETE')))
})
