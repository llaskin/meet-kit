import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { app, ADMIN_PREFIXES, handleWorkerError } from '../src/worker.js'
import { realDB } from './helpers/d1.js'
import { savePublicBooking } from '../src/core/public-bookings.js'

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = (db) => ({
  DB: db,
  // Mirrors real assets: admin pages and /meet exist, anything else 404s.
  ASSETS: { fetch: async (r) => ((p) => (p === '/meet' || p === '/admin' || p.startsWith('/admin/')) ? new Response('asset') : new Response('nf', { status: 404 }))(new URL(r.url).pathname) },
  ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud', OWNER_EMAIL: 'owner@example.com',
})

const adminRoutes = () => app.routes
  .filter((r) => ADMIN_PREFIXES.some((p) => r.path.startsWith(p)))
  .map((r) => ({ method: r.method === 'ALL' ? 'GET' : r.method, path: r.path.replace(':provider', 'google').replace(':id', 'google%3Aowner%40example.com') }))

test('there are admin routes to check', () => {
  assert.ok(adminRoutes().length >= 7)
})

test('every admin route refuses a request with no Access token', async () => {
  const db = realDB()
  for (const { method, path } of adminRoutes()) {
    const res = await app.request(path, { method }, ENV(db), ctx)
    assert.equal(res.status, 403, `${method} ${path} must be 403 without a token`)
  }
})

test('every admin route refuses a forged token', async () => {
  const db = realDB()
  for (const { method, path } of adminRoutes()) {
    const res = await app.request(path, { method, headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } }, ENV(db), ctx)
    assert.equal(res.status, 403, `${method} ${path}`)
  }
})

test('admin routes refuse everything when Access is not configured yet', async () => {
  const db = realDB()
  const res = await app.request('/api/admin/config', {}, { DB: db, ASSETS: ENV(db).ASSETS }, ctx)
  assert.equal(res.status, 403)
})

test('public routes are reachable without a token', async () => {
  const db = realDB()
  const res = await app.request('/api/public/site', {}, ENV(db), ctx)
  assert.equal(res.status, 200)
})

// These are near-misses by STRING -- they merely contain "admin" as a
// substring -- and must stay non-admin: the gate's canonical form never
// equals '/admin'/'/api/admin' nor starts with '/admin/'/'/api/admin/' for
// any of them, so the Access-token check never even runs. Asserted as a
// strict 404 (not just notEqual 200) specifically to distinguish "the gate
// did not fire, and no route matched either" from a gated 403.
test('near-miss paths are not admin (gate does not fire) and 404, not public API', async () => {
  const db = realDB()
  for (const p of ['/administrator', '/api/adminx', '/api/publicity']) {
    const res = await app.request(p, {}, ENV(db), ctx)
    assert.equal(res.status, 404, p)
  }
})

// --- Path-normalisation bypass variants ------------------------------------
//
// Every variant below is a genuine admin path once canonicalised (decoded,
// slash-collapsed, lower-cased -- see src/worker.js's isAdminPath comment),
// or is unparseable and therefore fail-closed, so EVERY one of them must be
// 403 from the owner gate itself -- never 404 (which would mean the gate
// missed it and some other, unauthenticated, path took over) and never 200.
//
// We cannot verify how Cloudflare's own static-asset server would normalise
// '//admin/' or '/admin%2F' in production (it may collapse slashes or decode
// %2F before serving a file from disk), so the gate does not rely on Hono's
// routing to agree with that normalisation -- it computes its own canonical
// form and gates on it directly, independent of what (if anything) the
// router would have matched.
const PATH_VARIANTS = [
  '/Admin/', '/ADMIN', '/api/Admin/config', '//admin/', '/admin//',
  '/%61dmin/', '/admin%2F', '/api/admin%2Fconfig', '/api/public/../admin/config',
  '/admin/./', '/admin/index.html', '/api/admin/config/', '/api/admin/config?x=1',
  '/admin%E0%A4%A', // malformed/truncated percent-encoding -> fail closed
]

test('path-normalisation bypass variants are all 403 from the gate itself', async () => {
  const db = realDB()
  for (const p of PATH_VARIANTS) {
    const res = await app.request(p, {}, ENV(db), ctx)
    assert.equal(res.status, 403, `${p} -> ${res.status} (must be 403)`)
  }
})

// --- Generic-error wrapping (item 3) ---------------------------------------
//
// Public handlers already catch their own known failure modes and return
// their own JSON error bodies (untouched by onError). This proves the
// BACKSTOP: an uncaught exception anywhere under /api/public/* still reaches
// the visitor as the booking-specific generic message, never raw error text;
// anywhere else it is the generic 'Internal error'.
//
// `app.all('/api/*', ...)` and `app.all('*', ...)` in worker.js are
// registered BEFORE this test file loads, and Hono matches routes in
// REGISTRATION ORDER (verified directly against this Hono version: a
// wildcard `app.all` registered first wins over a more specific route added
// afterward, even though the later route is the better match) -- so a route
// added here to the real `app` singleton would never be reached; it would
// always hit worker.js's own catch-alls first. Testing `handleWorkerError`
// (the exact function wired into the real app's `onError`) through a small
// probe app with a genuinely throwing route exercises the real Hono
// throw/onError cycle -- same `c` shape, same function reference -- without
// fighting that ordering rule.
function probeApp(throwingPath) {
  const probe = new Hono()
  probe.get(throwingPath, () => { throw new Error('leak: upstream said something sensitive') })
  probe.onError(handleWorkerError)
  return probe
}

test('an uncaught exception under /api/public/* returns the generic booking message', async () => {
  const res = await probeApp('/api/public/__throws').request('/api/public/__throws')
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.deepEqual(body, { error: 'Unable to book that time. Please try again later.' })
})

test('an uncaught exception outside /api/public/* returns a generic internal-error message', async () => {
  const res = await probeApp('/__throws').request('/__throws')
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.deepEqual(body, { error: 'Internal error' })
  // Never the thrown error's own text.
  assert.doesNotMatch(JSON.stringify(body), /leak:/)
})

// --- Cron (item 6) -----------------------------------------------------------

test('scheduled() runs both purgeExpired and the rate-limit sweep', async () => {
  const db = realDB()
  const worker = (await import('../src/worker.js')).default

  // Seed one row old enough that purgeExpired's 24-month record-retention
  // boundary deletes it, and one rate_counters row old enough that sweep's
  // default 3-window retention deletes it. If scheduled() did not actually
  // call purgeExpired/sweep, both would still be present after the call.
  const old = new Date(Date.now() - 25 * 30 * 86_400_000).toISOString() // ~25 months ago
  await savePublicBooking(db, {
    email: 'old@example.com', name: 'Old', durationMinutes: 30,
    startUtc: old, endUtc: old, createdAt: old,
  })
  db.raw.prepare('INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, ?)')
    .run('slots:30', 0, 1) // window_start=0 is far older than any `keepWindows` cutoff

  const waits = []
  const fakeCtx = { waitUntil: (p) => waits.push(p) }
  await worker.scheduled({}, { DB: db }, fakeCtx)
  await Promise.all(waits)

  const remainingBooking = await db.prepare('SELECT COUNT(*) AS n FROM public_bookings WHERE start_utc = ?').bind(old).first()
  assert.equal(remainingBooking.n, 0, 'purgeExpired should have deleted the old booking')

  const remainingCounter = await db.prepare('SELECT COUNT(*) AS n FROM rate_counters WHERE bucket = ?').bind('slots:30').first()
  assert.equal(remainingCounter.n, 0, 'sweep should have deleted the old rate counter')
})
