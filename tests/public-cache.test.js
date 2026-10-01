import assert from 'node:assert/strict'
import test from 'node:test'
import { cacheImpl, cacheKeyFor, readCache, writeCache, PUBLIC_TTL_SECONDS } from '../src/core/public-cache.js'

/** A minimal stand-in for caches.default, recording what it was asked to do. */
function fakeCache() {
  const store = new Map()
  const calls = { match: [], put: [] }
  return {
    calls, store,
    async match(req) { calls.match.push(req.url); const r = store.get(req.url); return r ? r.clone() : undefined },
    // The REAL Cache API CONSUMES the body on put. A fake that merely stores
    // the object cannot catch a missing .clone(), which is precisely the bug
    // that would serve an empty body on every cache miss. So consume it here.
    async put(req, res) {
      calls.put.push(req.url)
      const body = await res.text()          // consumes res, as Cloudflare does
      store.set(req.url, new Response(body, { headers: res.headers }))
    },
  }
}
const use = (c) => { cacheImpl.open = () => c }
const req = (url = 'https://calls.example.com/api/public/slots') => new Request(url)

test('the TTL is a minute — long enough to absorb a flood, short enough to stay fresh', () => {
  assert.equal(PUBLIC_TTL_SECONDS, 60)
})

test('the key is built from the duration ONLY, so a query string cannot bust the cache', () => {
  // Keying on the raw URL would let anyone request ?x=1, ?x=2, ... and turn the
  // cache into a no-op, handing back the exact fan-out it exists to prevent.
  const a = cacheKeyFor(req('https://x.test/api/public/slots?duration=30&cachebust=1'), 30)
  const b = cacheKeyFor(req('https://x.test/api/public/slots?duration=30&cachebust=99999'), 30)
  const c = cacheKeyFor(req('https://x.test/api/public/slots?from=2031-06-02&duration=30'), 30)
  assert.equal(a.url, b.url)
  assert.equal(a.url, c.url)
  assert.match(a.url, /\/api\/public\/slots\?duration=30$/)
})

test('different durations are cached separately', () => {
  assert.notEqual(cacheKeyFor(req(), 30).url, cacheKeyFor(req(), 60).url)
})

test('a miss returns null and a later read returns what was written', async () => {
  const c = fakeCache(); use(c)
  assert.equal(await readCache(req(), 30), null)
  await writeCache(req(), 30, new Response(JSON.stringify({ slots: [1] })), null)
  const hit = await readCache(req(), 30)
  assert.ok(hit)
  assert.deepEqual(await hit.json(), { slots: [1] })
})

test('writeCache returns a response whose body is still readable', async () => {
  // cache.put CONSUMES the body. Failing to clone yields an empty body to the
  // visitor -- and only on a cache MISS, the path least exercised by hand.
  const c = fakeCache(); use(c)
  const out = await writeCache(req(), 30, new Response(JSON.stringify({ slots: [1, 2, 3] })), null)
  assert.deepEqual(await out.json(), { slots: [1, 2, 3] })
})

test('the stored copy carries a max-age matching the TTL', async () => {
  const c = fakeCache(); use(c)
  await writeCache(req(), 30, new Response('{}'), null)
  const stored = c.store.get(cacheKeyFor(req(), 30).url)
  assert.match(stored.headers.get('Cache-Control'), new RegExp(`max-age=${PUBLIC_TTL_SECONDS}`))
})

test('the cache write is deferred via waitUntil when a context provides it', async () => {
  const c = fakeCache(); use(c)
  const deferred = []
  await writeCache(req(), 30, new Response('{}'), { waitUntil: (p) => deferred.push(p) })
  assert.equal(deferred.length, 1, 'the visitor must not wait on the cache write')
  await Promise.all(deferred)
  assert.equal(c.calls.put.length, 1)
})

test('a cache fault never propagates', async () => {
  // A broken cache must degrade to "no cache", not to a 500 on a public page.
  cacheImpl.open = () => { throw new Error('cache unavailable') }
  assert.equal(await readCache(req(), 30), null)
  const out = await writeCache(req(), 30, new Response('{"ok":true}'), null)
  assert.deepEqual(await out.json(), { ok: true })
})

test('an absent Cache API degrades to no caching rather than throwing', async () => {
  // node:test has no `caches` global; the same path covers a runtime without it.
  cacheImpl.open = () => null
  assert.equal(await readCache(req(), 30), null)
  const out = await writeCache(req(), 30, new Response('{"ok":true}'), null)
  assert.deepEqual(await out.json(), { ok: true })
})
