import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_RULES, getConfig, setConfig, getRules,
  connectionId, saveConnection, getWriteConnection,
} from '../src/core/calendar-store.js'

/** Minimal D1 double backing a key/value table. Mirrors tests/state.test.js in spirit. */
function fakeDB(seed = {}) {
  const kv = new Map(Object.entries(seed))
  return {
    kv,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...a) { this.args = a; return this },
        async all() {
          return { results: [...kv.entries()].map(([key, value]) => ({ key, value })) }
        },
        async first() {
          const v = kv.get(this.args[0])
          return v === undefined ? null : { key: this.args[0], value: v }
        },
        async run() {
          kv.set(this.args[0], this.args[1])
          return { success: true }
        },
      }
    },
  }
}

test('getConfig returns an empty object when nothing is stored', async () => {
  assert.deepEqual(await getConfig(fakeDB()), {})
})

test('setConfig then getConfig round-trips a value', async () => {
  const db = fakeDB()
  await setConfig(db, 'google_client_id', 'abc.apps.googleusercontent.com')
  const cfg = await getConfig(db)
  assert.equal(cfg.google_client_id, 'abc.apps.googleusercontent.com')
})

test('getRules falls back to the documented defaults', async () => {
  const rules = await getRules(fakeDB())
  assert.deepEqual(rules, DEFAULT_RULES)
})

test('getRules overlays only the keys that are stored', async () => {
  const db = fakeDB({ rules_timezone: 'America/Chicago', rules_duration_minutes: '45' })
  const rules = await getRules(db)
  assert.equal(rules.timezone, 'America/Chicago')
  assert.equal(rules.durationMinutes, 45)
  assert.equal(rules.startTime, DEFAULT_RULES.startTime)
})

test('getRules coerces the weekday list from CSV to numbers', async () => {
  const rules = await getRules(fakeDB({ rules_weekdays: '1,2,3' }))
  assert.deepEqual(rules.weekdays, [1, 2, 3])
})

test('connectionId lowercases and joins provider to account', () => {
  assert.equal(connectionId('google', 'Owner@Example.com'), 'google:owner@example.com')
})

test('connectionId refuses an empty account email', () => {
  // An empty email would collapse distinct accounts onto one row and could
  // silently overwrite the write connection.
  assert.throws(() => connectionId('google', ''), /non-empty account email/)
})

test('saveConnection refuses a connection with no account email', async () => {
  await assert.rejects(
    () => saveConnection(fakeDB(), { provider: 'google', role: 'write', refreshToken: 'rt', accountEmail: '' }),
    /accountEmail/,
  )
})

test('saveConnection refuses an unrecognised role', async () => {
  await assert.rejects(
    () => saveConnection(fakeDB(), { provider: 'google', role: 'admin', refreshToken: 'rt', accountEmail: 'a@x.com' }),
    /invalid role/,
  )
})

test('getWriteConnection queries only role=write, whatever the caller passes', async () => {
  // Enforcement layer 2: the write target cannot be selected by the caller,
  // only resolved by role.
  let sql = ''
  const db = {
    prepare(q) { sql = q; return { bind() { return this }, async first() { return null } } },
  }
  await getWriteConnection(db)
  assert.match(sql, /role = 'write'/)
})

test('bufferMinutes defaults to 0 and is read from rules_buffer_minutes', async () => {
  assert.equal(DEFAULT_RULES.bufferMinutes, 0)
  assert.equal((await getRules(fakeDB({}))).bufferMinutes, 0)
  assert.equal((await getRules(fakeDB({ rules_buffer_minutes: '15' }))).bufferMinutes, 15)
})
