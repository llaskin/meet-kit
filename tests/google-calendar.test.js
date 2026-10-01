import assert from 'node:assert/strict'
import test from 'node:test'
import { googleApi, listCalendars, freeBusy, refreshAccessToken, createEvent } from '../src/core/google-calendar.js'

function stubFetch(handler) {
  const calls = []
  googleApi.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts, calls.length)
  }
  return calls
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('refreshAccessToken posts the documented form body and returns the token', async () => {
  const calls = stubFetch(() => jsonResponse({ access_token: 'at-1', expires_in: 3600 }))
  const result = await refreshAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt' })

  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token')
  const sent = new URLSearchParams(calls[0].opts.body)
  assert.equal(sent.get('grant_type'), 'refresh_token')
  assert.equal(sent.get('refresh_token'), 'rt')
  assert.equal(sent.get('client_id'), 'cid')
  assert.equal(result.accessToken, 'at-1')
  assert.ok(result.expiresAt > Date.now())
})

test('refreshAccessToken surfaces invalid_grant as needing reconnection', async () => {
  stubFetch(() => jsonResponse({ error: 'invalid_grant' }, 400))
  await assert.rejects(
    () => refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'dead' }),
    /reconnect/i,
  )
})

test('listCalendars returns id, name and primary flag', async () => {
  stubFetch(() =>
    jsonResponse({
      items: [
        { id: 'owner@example.com', summary: 'owner@example.com', primary: true },
        { id: 'fam@group.calendar.google.com', summary: 'Family', summaryOverride: 'Family Stuff' },
      ],
    }),
  )
  const cals = await listCalendars('at-1')
  assert.equal(cals.length, 2)
  assert.deepEqual(cals[0], { id: 'owner@example.com', name: 'owner@example.com', primary: true })
  // summaryOverride is the user's own rename and wins over summary.
  assert.equal(cals[1].name, 'Family Stuff')
  assert.equal(cals[1].primary, false)
})

test('freeBusy sends every calendar in one request', async () => {
  const calls = stubFetch(() => jsonResponse({ calendars: { a: { busy: [] }, b: { busy: [] } } }))
  await freeBusy('at-1', ['a', 'b'], '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z')
  assert.equal(calls.length, 1)
  const sent = JSON.parse(calls[0].opts.body)
  assert.deepEqual(sent.items, [{ id: 'a' }, { id: 'b' }])
})

test('freeBusy flattens busy blocks across calendars', async () => {
  stubFetch(() =>
    jsonResponse({
      calendars: {
        a: { busy: [{ start: '2026-09-14T14:00:00Z', end: '2026-09-14T15:00:00Z' }] },
        b: { busy: [{ start: '2026-09-14T16:00:00Z', end: '2026-09-14T17:00:00Z' }] },
      },
    }),
  )
  const result = await freeBusy('at-1', ['a', 'b'], '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z')
  assert.equal(result.busy.length, 2)
  assert.deepEqual(result.errors, [])
})

test('freeBusy reports a per-calendar error instead of treating it as free', async () => {
  // Google returns HTTP 200 with a per-calendar errors array. Trusting the
  // status code alone would silently offer a slot during a real conflict.
  stubFetch(() =>
    jsonResponse({
      calendars: {
        'ok@x': { busy: [] },
        'work@example.com': { errors: [{ domain: 'calendar', reason: 'notFound' }] },
      },
    }),
  )
  const result = await freeBusy('at-1', ['ok@x', 'work@example.com'], '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].calendarId, 'work@example.com')
  assert.equal(result.errors[0].reason, 'notFound')
})

test('freeBusy chunks requests above the 50-calendar API limit', async () => {
  const calls = stubFetch(() => jsonResponse({ calendars: {} }))
  await freeBusy('at-1', Array.from({ length: 51 }, (_, i) => `c${i}`), '2026-09-14T00:00:00Z', '2026-09-15T00:00:00Z')
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[0].opts.body).items.length, 50)
  assert.equal(JSON.parse(calls[1].opts.body).items.length, 1)
})

test('listCalendars omits Google holiday feeds', async () => {
  // Holiday calendars are auto-checked by the fail-safe default but freeBusy
  // returns notFound for them, so a newly connected account blanks availability
  // entirely until someone unchecks them. Hit live on 2026-09-12. They carry no
  // real conflicts, so they never become selections in the first place.
  stubFetch(() =>
    jsonResponse({
      items: [
        { id: 'owner@example.com', summary: 'Primary', primary: true },
        { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in United States' },
        { id: 'en.uk#holiday@group.v.calendar.google.com', summary: 'Holidays in United Kingdom' },
        { id: 'fam@group.calendar.google.com', summary: 'Family' },
      ],
    }),
  )
  const cals = await listCalendars('at-1')
  assert.deepEqual(cals.map((c) => c.id), ['owner@example.com', 'fam@group.calendar.google.com'])
})

test('listCalendars keeps a calendar that merely has "holiday" in its name', async () => {
  // The filter must key on the id pattern, not the display name. A user's own
  // "Holiday Planning" calendar is a real calendar with real conflicts.
  stubFetch(() =>
    jsonResponse({
      items: [{ id: 'holidays@group.calendar.google.com', summary: 'Holiday Planning' }],
    }),
  )
  const cals = await listCalendars('at-1')
  assert.equal(cals.length, 1)
})

test('createEvent posts the event and returns its id and link', async () => {
  const calls = stubFetch(() => jsonResponse({ id: 'evt-1', htmlLink: 'https://cal/evt-1' }))
  const result = await createEvent('at-1', {
    calendarId: 'primary',
    summary: 'Example Co intro call',
    description: 'Join: https://meet.google.com/abc-defg-hij',
    startIso: '2026-09-14T18:00:00.000Z',
    endIso: '2026-09-14T18:30:00.000Z',
    timeZone: 'America/New_York',
    attendeeEmail: 'prospect@example.com',
    attendeeName: 'Dr Smith',
    location: 'https://meet.google.com/abc-defg-hij',
  })
  assert.equal(result.eventId, 'evt-1')

  const url = calls[0].url
  assert.match(url, /calendars\/primary\/events/)
  // Without sendUpdates=all Google creates the event but emails nobody -- the
  // single most common "why didn't they get the invite" bug.
  assert.match(url, /sendUpdates=all/)
  // No conferenceData is requested: v1 carries a fixed link instead.
  assert.equal(url.includes('conferenceDataVersion'), false)

  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.summary, 'Example Co intro call')
  assert.deepEqual(body.attendees, [{ email: 'prospect@example.com', displayName: 'Dr Smith' }])
  assert.equal(body.start.dateTime, '2026-09-14T18:00:00.000Z')
  assert.equal(body.start.timeZone, 'America/New_York')
  assert.equal(body.location, 'https://meet.google.com/abc-defg-hij')
  assert.equal('conferenceData' in body, false)
})

test('createEvent omits displayName when no attendee name is given', async () => {
  const calls = stubFetch(() => jsonResponse({ id: 'evt-2' }))
  await createEvent('at-1', {
    calendarId: 'primary', summary: 'x', description: '', location: '',
    startIso: '2026-09-14T18:00:00.000Z', endIso: '2026-09-14T18:30:00.000Z',
    timeZone: 'America/New_York', attendeeEmail: 'p@example.com', attendeeName: '',
  })
  assert.deepEqual(JSON.parse(calls[0].opts.body).attendees, [{ email: 'p@example.com' }])
})

test('createEvent throws with Google\'s message when the insert fails', async () => {
  stubFetch(() => jsonResponse({ error: { message: 'Invalid attendee email' } }, 400))
  await assert.rejects(
    () => createEvent('at-1', {
      calendarId: 'primary', summary: 'x', description: '', location: '',
      startIso: '2026-09-14T18:00:00.000Z', endIso: '2026-09-14T18:30:00.000Z',
      timeZone: 'America/New_York', attendeeEmail: 'bad', attendeeName: '',
    }),
    /Invalid attendee email/,
  )
})

test('freeBusy chunks a long range into abutting windows with no gaps', async () => {
  // Neither Google nor Zoho documents a maximum span, but neither documents the
  // range as unbounded either, and an undocumented cap would fail the whole
  // query -- reporting zero availability rather than an error a rep can act on.
  const calls = stubFetch(() => jsonResponse({ calendars: { a: { busy: [] } } }))
  await freeBusy('at-1', ['a'], '2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')

  const windows = calls.map((c) => JSON.parse(c.opts.body)).map((b) => [b.timeMin, b.timeMax])
  assert.ok(windows.length > 1, 'a 91-day range must be chunked')
  // Each window starts exactly where the previous ended: no gap, no overlap.
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i][0], windows[i - 1][1], `window ${i} must abut window ${i - 1}`)
  }
  assert.equal(windows[0][0], '2026-09-01T00:00:00.000Z')
  assert.equal(windows[windows.length - 1][1], '2026-12-01T00:00:00.000Z')
})

test('freeBusy does not chunk a range that already fits', async () => {
  const calls = stubFetch(() => jsonResponse({ calendars: { a: { busy: [] } } }))
  await freeBusy('at-1', ['a'], '2026-09-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z')
  assert.equal(calls.length, 1)
})

test('freeBusy merges busy blocks across chunk boundaries', async () => {
  // A meeting straddling a boundary comes back as two abutting halves, because
  // freeBusy clips to the query window. mergeBusy() coalesces them later.
  let n = 0
  stubFetch(() => {
    n += 1
    return jsonResponse({
      calendars: { a: { busy: [{ start: `2026-1${n}-01T10:00:00Z`, end: `2026-1${n}-01T11:00:00Z` }] } },
    })
  })
  const r = await freeBusy('at-1', ['a'], '2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')
  assert.equal(r.busy.length, n, 'busy from every window must be collected')
})

test('a per-calendar error is reported once, not once per time window', async () => {
  // Without dedup a single unreadable calendar produces one error per chunk,
  // turning one fault into a wall of identical messages in the UI.
  stubFetch(() =>
    jsonResponse({ calendars: { bad: { errors: [{ reason: 'notFound' }] } } }),
  )
  const r = await freeBusy('at-1', ['bad'], '2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0].calendarId, 'bad')
})

test('createEvent invites the internal address alongside the prospect', async () => {
  // The write account is the ORGANIZER and is already on the event, so it is
  // deliberately not added as its own guest. This is for the operator's real
  // working address, which is usually a different account entirely -- without
  // it a booked meeting lands only where the tool writes, not where they read.
  const calls = stubFetch(() => jsonResponse({ id: 'evt-1' }))
  await createEvent('at-1', {
    calendarId: 'primary', summary: 's', description: '', location: '',
    startIso: '2026-09-14T18:00:00.000Z', endIso: '2026-09-14T18:30:00.000Z',
    timeZone: 'America/New_York',
    attendeeEmail: 'prospect@example.com', attendeeName: 'Dr Smith',
    internalEmail: 'owner@example.com',
  })
  assert.deepEqual(JSON.parse(calls[0].opts.body).attendees, [
    { email: 'prospect@example.com', displayName: 'Dr Smith' },
    { email: 'owner@example.com' },
  ])
})

test('createEvent does not invite the internal address twice', async () => {
  // Booking a meeting with yourself as the prospect must not produce a
  // duplicate attendee, which Google rejects.
  const calls = stubFetch(() => jsonResponse({ id: 'evt-1' }))
  await createEvent('at-1', {
    calendarId: 'primary', summary: 's', description: '', location: '',
    startIso: '2026-09-14T18:00:00.000Z', endIso: '2026-09-14T18:30:00.000Z',
    timeZone: 'America/New_York',
    attendeeEmail: 'Owner@Example.com', attendeeName: '',
    internalEmail: 'owner@example.com',
  })
  assert.equal(JSON.parse(calls[0].opts.body).attendees.length, 1)
})

test('createEvent omits the internal attendee when none is configured', async () => {
  const calls = stubFetch(() => jsonResponse({ id: 'evt-1' }))
  await createEvent('at-1', {
    calendarId: 'primary', summary: 's', description: '', location: '',
    startIso: '2026-09-14T18:00:00.000Z', endIso: '2026-09-14T18:30:00.000Z',
    timeZone: 'America/New_York',
    attendeeEmail: 'p@example.com', attendeeName: '', internalEmail: '',
  })
  assert.equal(JSON.parse(calls[0].opts.body).attendees.length, 1)
})
