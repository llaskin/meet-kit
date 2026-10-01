import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { onRequestDelete } from '../src/handlers/admin-connections.js'

const OWNER = 'owner@example.com'
const ENV = (db) => ({ DB: db })
const del = (db, id) => onRequestDelete({ request: new Request('https://x.test', { method: 'DELETE' }), env: ENV(db), params: { id } })
const conn = (role, email) => ({ provider: 'google', role, refreshToken: 'rt', accessToken: 'at',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: email })

async function seeded() {
  const db = realDB()
  await store.saveConnection(db, conn('write', OWNER))
  await store.upsertSelection(db, `google:${OWNER}`, OWNER, 'Main')
  await store.saveConnection(db, conn('busy', 'side@example.com'))
  await store.upsertSelection(db, 'google:side@example.com', 'side@example.com', 'Side')
  await store.setConfig(db, 'write_calendar_id', OWNER)
  await store.setConfig(db, 'write_calendar_meet', '1')
  await store.setConfig(db, 'meet_link', 'https://zoom.example/j/1')
  return db
}

test('deleting the write connection also clears the booking calendar config', async () => {
  const db = await seeded()
  const res = await del(db, `google:${OWNER}`)
  assert.equal(res.status, 200)
  assert.equal(await store.getConnectionById(db, `google:${OWNER}`), null)
  assert.deepEqual(await store.getSelections(db, `google:${OWNER}`), [])
  const cfg = await store.getConfig(db)
  assert.equal(cfg.write_calendar_id, undefined)
  assert.equal(cfg.write_calendar_meet, undefined)
  assert.equal(cfg.meet_link, 'https://zoom.example/j/1')
  assert.ok(await store.getConnectionById(db, 'google:side@example.com'), 'busy connection was removed too')
})

test('deleting a busy connection leaves the booking calendar config alone', async () => {
  const db = await seeded()
  const res = await del(db, 'google:side@example.com')
  assert.equal(res.status, 200)
  assert.equal(await store.getConnectionById(db, 'google:side@example.com'), null)
  const cfg = await store.getConfig(db)
  assert.equal(cfg.write_calendar_id, OWNER)
  assert.equal(cfg.write_calendar_meet, '1')
  assert.ok(await store.getWriteConnection(db))
})

test('a URL-encoded connection id is decoded', async () => {
  const db = await seeded()
  const res = await del(db, encodeURIComponent('google:side@example.com'))
  assert.equal(res.status, 200)
  assert.equal(await store.getConnectionById(db, 'google:side@example.com'), null)
})

test('an unknown connection id is 404 and deletes nothing', async () => {
  const db = await seeded()
  const res = await del(db, 'google:nobody@example.com')
  assert.equal(res.status, 404)
  assert.equal((await store.getAllConnections(db)).length, 2)
  assert.equal((await store.getConfig(db)).write_calendar_id, OWNER)
})

test('a missing or malformed id is refused without deleting anything', async () => {
  const db = await seeded()
  for (const id of [undefined, '', '%E0%A4%A']) {
    const res = await del(db, id)
    assert.ok([400, 404].includes(res.status), `${id} -> ${res.status}`)
  }
  assert.equal((await store.getAllConnections(db)).length, 2)
})
