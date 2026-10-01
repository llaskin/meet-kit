import assert from 'node:assert/strict'
import test from 'node:test'
import { consume, sweep } from '../src/core/rate-limit.js'
import { realDB, SCHEMA } from './helpers/d1.js'

// A db double whose prepare() throws synchronously, the way a broken D1
// binding or a malformed statement would blow up before any bind/run call.
function throwingDB() {
  return {
    prepare() {
      throw new Error('boom: db unavailable')
    },
  }
}

test('the window index exists, or a sweep table-scans', () => {
  // Repointed at meet-kit's combined schema.sql: the source asserted this
  // against the standalone migrations/005_rate_limit.sql, which doesn't
  // exist here (everything is folded into one schema.sql). The index name
  // itself is unchanged from the source migration.
  assert.match(SCHEMA, /CREATE INDEX IF NOT EXISTS idx_rate_counters_window/i)
})

test('the first call in a window is allowed with count 1', async () => {
  const db = realDB()
  const result = await consume(db, { bucket: 'slots:1.2.3.4', limit: 5, windowSeconds: 60, now: 1_000_000_000 })
  assert.equal(result.allowed, true)
  assert.equal(result.count, 1)
})

test('exactly `limit` calls are allowed; the limit+1th is not', async () => {
  const db = realDB()
  const opts = { bucket: 'slots:1.2.3.4', limit: 3, windowSeconds: 60, now: 1_000_000_000 }
  const results = []
  for (let i = 0; i < 4; i++) {
    results.push(await consume(db, opts))
  }
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false])
  assert.deepEqual(results.map((r) => r.count), [1, 2, 3, 4])
})

test('two different buckets do not interfere', async () => {
  const db = realDB()
  const now = 1_000_000_000
  await consume(db, { bucket: 'slots:1.1.1.1', limit: 1, windowSeconds: 60, now })
  const other = await consume(db, { bucket: 'slots:2.2.2.2', limit: 1, windowSeconds: 60, now })
  assert.equal(other.allowed, true)
  assert.equal(other.count, 1)
})

test('a call in a new window resets the count', async () => {
  const db = realDB()
  const opts = { bucket: 'book:9.9.9.9', limit: 2, windowSeconds: 60, now: 1_000_000_000 }
  await consume(db, opts)
  await consume(db, opts)
  const third = await consume(db, opts)
  assert.equal(third.allowed, false)

  // advance well past the window boundary
  const nextWindow = await consume(db, { ...opts, now: opts.now + 61_000 })
  assert.equal(nextWindow.allowed, true)
  assert.equal(nextWindow.count, 1)
})

test('a call late in the same window still counts against it', async () => {
  const db = realDB()
  // now: 0 aligns exactly on a window boundary, so the window spans
  // [0, 60_000) ms and 59_000ms later is still inside it.
  const base = { bucket: 'book:5.5.5.5', limit: 2, windowSeconds: 60, now: 0 }
  await consume(db, base)
  // still inside the same 60s window (59s later), should be the 2nd hit
  const second = await consume(db, { ...base, now: base.now + 59_000 })
  assert.equal(second.allowed, true)
  assert.equal(second.count, 2)
})

test('a database error fails OPEN', async () => {
  const db = throwingDB()
  const result = await consume(db, { bucket: 'slots:0.0.0.0', limit: 1, windowSeconds: 60 })
  assert.equal(result.allowed, true)
  assert.equal(result.count, 0)
})

test('sweep deletes old windows and keeps recent ones', async () => {
  const db = realDB()
  const windowSeconds = 60
  // window boundaries: 0, 60_000, 120_000, 180_000 ms
  await consume(db, { bucket: 'a', limit: 100, windowSeconds, now: 0 })
  await consume(db, { bucket: 'a', limit: 100, windowSeconds, now: 60_000 })
  await consume(db, { bucket: 'a', limit: 100, windowSeconds, now: 120_000 })
  await consume(db, { bucket: 'a', limit: 100, windowSeconds, now: 180_000 })

  // sweep as of now=180_000 keeping 3 windows: windows starting at
  // 0, 60, 120, 180 (in seconds). keepWindows=3 should keep 60,120,180 and drop 0.
  await sweep(db, { windowSeconds, keepWindows: 3, now: 180_000 })

  const rows = db.raw.prepare('SELECT window_start FROM rate_counters WHERE bucket = ? ORDER BY window_start').all('a')
  const starts = rows.map((r) => r.window_start)
  assert.ok(!starts.includes(0), `expected window 0 to be swept, got ${JSON.stringify(starts)}`)
  assert.ok(starts.includes(180), `expected the current window to survive, got ${JSON.stringify(starts)}`)
})

test('a successful sweep reports ok:true', async () => {
  const db = realDB()
  const r = await sweep(db, { windowSeconds: 60, now: 0 })
  assert.equal(r.ok, true)
})

test('sweep reports failure via ok:false/error instead of swallowing it silently', async () => {
  const db = throwingDB()
  const r = await sweep(db, { windowSeconds: 60, now: 0 })
  assert.equal(r.ok, false)
  assert.ok(r.error instanceof Error)
  assert.match(r.error.message, /boom: db unavailable/)
})
