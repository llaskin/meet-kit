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
  googleApi.fetch = async () => Response.json({ items: [
    { id: OWNER, primary: true, conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } },
    { id: 'team@group.calendar.google.com', conferenceProperties: { allowedConferenceSolutionTypes: [] } },
  ] })
  assert.equal((await put(db, { writeCalendarId: 'stranger@group.calendar.google.com' })).status, 400)
  assert.equal((await put(db, { writeCalendarId: 'team@group.calendar.google.com' })).status, 200)
  const cfg = await store.getConfig(db)
  assert.equal(cfg.write_calendar_id, 'team@group.calendar.google.com')
  assert.equal(cfg.write_calendar_meet, '0')
})
