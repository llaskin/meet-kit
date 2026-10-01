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

function fake({ create, gets = [], patchFails = false }) {
  const log = []
  google.googleApi.fetch = async (url, opts = {}) => {
    const m = opts.method || 'GET'
    log.push(`${m} ${url.includes('conferenceDataVersion') ? 'conf' : 'plain'}`)
    if (m === 'POST') return Response.json(create)
    if (m === 'GET') return Response.json(gets.shift() || {})
    if (m === 'PATCH') return new Response('{}', { status: patchFails ? 500 : 200 })
    if (m === 'DELETE') return new Response(null, { status: 204 })
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
