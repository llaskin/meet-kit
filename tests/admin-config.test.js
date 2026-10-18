import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { onRequestGet, onRequestPut } from '../src/handlers/admin-config.js'

const OWNER = 'owner@example.com'
const ENV = (db) => ({ DB: db, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'GSECRET', ZOHO_CLIENT_SECRET: 'ZSECRET', TURNSTILE_SECRET_KEY: 'TSECRET' })
const put = (db, body) => onRequestPut({ request: new Request('https://x.test', { method: 'PUT', body: JSON.stringify(body) }), env: ENV(db) })

async function withWrite(db) {
  await store.saveConnection(db, { provider: 'google', role: 'write', refreshToken: 'rt', accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: OWNER })
  await store.upsertSelection(db, `google:${OWNER}`, OWNER, 'Main')
  await store.upsertSelection(db, `google:${OWNER}`, 'team@group.calendar.google.com', 'Team')
}

test('GET never contains any secret value', async () => {
  const db = realDB()
  const text = await (await onRequestGet({ env: ENV(db) })).text()
  for (const s of ['GSECRET', 'ZSECRET', 'TSECRET']) assert.ok(!text.includes(s), `${s} leaked`)
  const body = JSON.parse(text)
  assert.equal(body.googleConfigured, true)
  assert.equal(body.zohoConfigured, false)
})

test('PUT ignores client secrets sent from the browser', async () => {
  const db = realDB()
  await put(db, { google: { clientSecret: 'FROM-BROWSER' } })
  const rows = db.raw.prepare("SELECT key FROM calendar_config WHERE key LIKE '%secret%'").all()
  assert.deepEqual(rows, [])
})

test('meet link must be https or empty', async () => {
  const db = realDB()
  assert.equal((await put(db, { meetLink: 'javascript:alert(1)' })).status, 400)
  assert.equal((await put(db, { meetLink: 'https://zoom.example/j/1' })).status, 200)
  assert.equal((await put(db, { meetLink: '' })).status, 200)
})

test('writeCalendarId must belong to the booking account, and refreshes the Meet flag', async () => {
  const db = realDB()
  await withWrite(db)
  // accessRole as Google's calendarList returns it: PUT now requires owner/writer.
  googleApi.fetch = async () => Response.json({ items: [
    { id: OWNER, primary: true, accessRole: 'owner', conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } },
    { id: 'team@group.calendar.google.com', accessRole: 'writer', conferenceProperties: { allowedConferenceSolutionTypes: [] } },
  ] })
  assert.equal((await put(db, { writeCalendarId: 'stranger@group.calendar.google.com' })).status, 400)
  assert.equal((await put(db, { writeCalendarId: 'team@group.calendar.google.com' })).status, 200)
  const cfg = await store.getConfig(db)
  assert.equal(cfg.write_calendar_id, 'team@group.calendar.google.com')
  assert.equal(cfg.write_calendar_meet, '0')
})

// ---------------------------------------------------------------------------
// Finding 4: every value is validated BEFORE anything is written.
// ---------------------------------------------------------------------------

const snapshot = (db) => JSON.stringify(db.raw.prepare('SELECT key, value FROM calendar_config ORDER BY key').all())
const LIVE = (items) => async () => Response.json({ items })

test('writeCalendarId refuses a calendar the booking account can only READ', async () => {
  const db = realDB()
  await withWrite(db)
  googleApi.fetch = LIVE([
    { id: OWNER, primary: true, accessRole: 'owner' },
    { id: 'team@group.calendar.google.com', accessRole: 'reader' },
  ])
  const before = snapshot(db)
  const res = await put(db, { writeCalendarId: 'team@group.calendar.google.com' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /write/i)
  assert.equal(snapshot(db), before)
})

test('writeCalendarId refuses a calendar missing from Google\'s live list', async () => {
  const db = realDB()
  await withWrite(db)
  googleApi.fetch = LIVE([{ id: OWNER, primary: true, accessRole: 'owner' }])
  const before = snapshot(db)
  assert.equal((await put(db, { writeCalendarId: 'team@group.calendar.google.com' })).status, 400)
  assert.equal(snapshot(db), before)
})

test('writeCalendarId accepts owner and writer access', async () => {
  for (const accessRole of ['owner', 'writer']) {
    const db = realDB()
    await withWrite(db)
    googleApi.fetch = LIVE([{ id: OWNER, primary: true, accessRole: 'owner' }, { id: 'team@group.calendar.google.com', accessRole }])
    assert.equal((await put(db, { writeCalendarId: 'team@group.calendar.google.com' })).status, 200, accessRole)
    assert.equal((await store.getConfig(db)).write_calendar_id, 'team@group.calendar.google.com')
  }
})

test('Google unreachable while checking the calendar: 502 and nothing written', async () => {
  const db = realDB()
  await withWrite(db)
  googleApi.fetch = async () => { throw new TypeError('fetch failed') }
  const before = snapshot(db)
  const res = await put(db, { meetLink: 'https://zoom.example/j/2', writeCalendarId: 'team@group.calendar.google.com' })
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error, 'Could not reach Google to check that calendar')
  assert.equal(snapshot(db), before)
})

const INVALID = [
  ['timezone', { rules: { timezone: 'Mars/Olympus_Mons' } }],
  ['startTime', { rules: { startTime: '9am' } }],
  ['startTime', { rules: { startTime: '24:00' } }],
  ['endTime', { rules: { endTime: '17:60' } }],
  ['endTime', { rules: { startTime: '17:00', endTime: '09:00' } }],
  ['endTime', { rules: { startTime: '09:00', endTime: '09:00' } }],
  ['weekdays', { rules: { weekdays: [] } }],
  ['weekdays', { rules: { weekdays: [1, 1] } }],
  ['weekdays', { rules: { weekdays: [0] } }],
  ['weekdays', { rules: { weekdays: [8] } }],
  ['weekdays', { rules: { weekdays: [1.5] } }],
  ['weekdays', { rules: { weekdays: '1,2' } }],
  ['intervalMinutes', { rules: { intervalMinutes: -5 } }],
  ['intervalMinutes', { rules: { intervalMinutes: 4 } }],
  ['intervalMinutes', { rules: { intervalMinutes: 241 } }],
  ['intervalMinutes', { rules: { intervalMinutes: 7.5 } }],
  ['intervalMinutes', { rules: { intervalMinutes: 'abc' } }],
  ['minNoticeMinutes', { rules: { minNoticeMinutes: -1 } }],
  ['minNoticeMinutes', { rules: { minNoticeMinutes: 10081 } }],
  ['horizonDays', { rules: { horizonDays: 0 } }],
  ['horizonDays', { rules: { horizonDays: 366 } }],
  ['internalAttendeeEmail', { internalAttendeeEmail: 'not-an-email' }],
  ['zohoAccountEmail', { zohoAccountEmail: 'a@b' }],
  ['meetLink', { meetLink: 'http://zoom.example/j/1' }],
]

for (const [field, bad] of INVALID) {
  test(`PUT refuses invalid ${field} (${JSON.stringify(bad)}) and writes NOTHING`, async () => {
    const db = realDB()
    const before = snapshot(db)
    // A valid field alongside the invalid one: it must not be written either.
    const body = { ...bad, ...(field === 'meetLink' ? { internalAttendeeEmail: 'ok@example.com' } : { meetLink: 'https://zoom.example/j/9' }) }
    const res = await put(db, body)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, new RegExp(field))
    assert.equal(snapshot(db), before)
  })
}

test('a negative interval is refused and the stored interval is unchanged', async () => {
  const db = realDB()
  assert.equal((await put(db, { rules: { intervalMinutes: -15 } })).status, 400)
  assert.equal((await store.getRules(db)).intervalMinutes, store.DEFAULT_RULES.intervalMinutes)
})

// Restored from the source project's admin-config tests.
test('PUT persists availability rules', async () => {
  const db = realDB()
  const res = await put(db, { rules: {
    timezone: 'Europe/London', weekdays: [1, 3, 5], startTime: '08:30', endTime: '16:00',
    intervalMinutes: 15, minNoticeMinutes: 60, horizonDays: 14,
  } })
  assert.equal(res.status, 200)
  const rules = await store.getRules(db)
  assert.equal(rules.timezone, 'Europe/London')
  assert.deepEqual(rules.weekdays, [1, 3, 5])
  assert.equal(rules.startTime, '08:30')
  assert.equal(rules.endTime, '16:00')
  assert.equal(rules.intervalMinutes, 15)
  assert.equal(rules.minNoticeMinutes, 60)
  assert.equal(rules.horizonDays, 14)
})

test('weekdays are ISO numbered: 7 is Sunday and is accepted, 0 is refused', async () => {
  // computeSlots compares against tz.js's ISO weekday (Mon=1..Sun=7). Before
  // this test the admin accepted 0-6, so Sunday could never be offered and a
  // stored 0 matched nothing; every seed of '0,1,2,3,4,5,6' failed on Sundays.
  const db = realDB()
  assert.equal((await put(db, { rules: { weekdays: [6, 7] } })).status, 200)
  assert.deepEqual((await store.getRules(db)).weekdays, [6, 7])
  assert.equal((await put(db, { rules: { weekdays: [0, 1] } })).status, 400)
  assert.deepEqual((await store.getRules(db)).weekdays, [6, 7])
})

test('integer-shaped strings from form inputs are accepted', async () => {
  const db = realDB()
  assert.equal((await put(db, { rules: { intervalMinutes: '20', minNoticeMinutes: '0', horizonDays: '30' } })).status, 200)
  const rules = await store.getRules(db)
  assert.equal(rules.intervalMinutes, 20)
  assert.equal(rules.minNoticeMinutes, 0)
  assert.equal(rules.horizonDays, 30)
})

test('Zoho account email round-trips through PUT and GET', async () => {
  const db = realDB()
  assert.equal((await put(db, { zohoAccountEmail: '  owner-work@example.com ' })).status, 200)
  assert.equal((await (await onRequestGet({ env: ENV(db) })).json()).zohoAccountEmail, 'owner-work@example.com')
  assert.equal((await put(db, { zohoAccountEmail: '' })).status, 200)
  assert.equal((await (await onRequestGet({ env: ENV(db) })).json()).zohoAccountEmail, '')
})

test('internal attendee email round-trips through PUT and GET', async () => {
  const db = realDB()
  assert.equal((await put(db, { internalAttendeeEmail: 'team@example.com' })).status, 200)
  assert.equal((await (await onRequestGet({ env: ENV(db) })).json()).internalAttendeeEmail, 'team@example.com')
})

test('PUT rejects malformed JSON', async () => {
  const db = realDB()
  const res = await onRequestPut({ request: new Request('https://x.test', { method: 'PUT', body: '{not json' }), env: ENV(db) })
  assert.equal(res.status, 400)
})

test('GET reports writeAccount null until a write connection exists', async () => {
  const db = realDB()
  assert.equal((await (await onRequestGet({ env: ENV(db) })).json()).writeAccount, null)
  await withWrite(db)
  assert.equal((await (await onRequestGet({ env: ENV(db) })).json()).writeAccount, OWNER)
})

test('topics: saved, returned by GET, and Other flag round-trips', async () => {
  const db = realDB()
  assert.equal((await put(db, { meetingTopics: [' Audit review ', 'Pricing'], allowOtherTopic: true })).status, 200)
  const body = await (await onRequestGet({ env: ENV(db) })).json()
  assert.deepEqual(body.meetingTopics, ['Audit review', 'Pricing'])
  assert.equal(body.allowOtherTopic, true)
})

test('topics: an invalid list is refused and NOTHING is written', async () => {
  const db = realDB()
  const res = await put(db, { meetLink: 'https://zoom.example/j/1', meetingTopics: ['Other'] })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /reserved/)
  const cfg = await store.getConfig(db)
  assert.equal(cfg.meet_link, undefined)
  assert.equal(cfg.meeting_topics, undefined)
})

test('topics: allowOtherTopic must be boolean', async () => {
  assert.equal((await put(realDB(), { allowOtherTopic: 'yes' })).status, 400)
})
