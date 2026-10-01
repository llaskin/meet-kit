// Edge caching for the public endpoints.
//
// Every uncached /api/public/slots request fans out to Google Calendar and Zoho
// free/busy. Unauthenticated and unbounded, that is a way for a stranger to
// exhaust the operator's API quota -- and when the quota trips, gatherBusy
// returns errors, so BOTH the public endpoint and the authenticated
// /api/calendar/slots fail closed. Anonymous traffic could deny the operator
// their own tool. Caching is the direct fix: a flood collapses to at most one
// upstream fan-out per TTL per Cloudflare location.
//
// The Cache API is available in Pages Functions, on custom domains as well as
// *.pages.dev. The native Rate Limiting BINDING is not -- it is Workers-only --
// which is why rate limiting here is application-level instead.
//
// `cacheImpl` is injectable for the same reason googleApi.fetch is: `caches` is
// a runtime global that does not exist under node:test.
export const cacheImpl = {
  open: () => (typeof caches !== 'undefined' ? caches.default : null),
}

/** 60 seconds. Long enough to absorb a flood, short enough that a booking made
 *  now disappears from the grid within a minute. */
export const PUBLIC_TTL_SECONDS = 60

/**
 * The cache key. Deliberately NOT the raw request URL.
 *
 * `from` is ignored by the public handler, and an arbitrary query string would
 * otherwise let anyone bust the cache with `?x=1`, `?x=2`, ... which turns the
 * cache into a no-op and hands back the exact fan-out it prevents. Only the
 * duration varies, and it is already clamped to the public allowlist.
 */
export function cacheKeyFor(request, durationMinutes) {
  const url = new URL(request.url)
  return new Request(`${url.origin}/api/public/slots?duration=${durationMinutes}`, { method: 'GET' })
}

/** A cached Response, or null. Never throws: a cache fault must not 500 the page. */
export async function readCache(request, durationMinutes) {
  try {
    const cache = cacheImpl.open()
    if (!cache) return null
    return (await cache.match(cacheKeyFor(request, durationMinutes))) || null
  } catch {
    return null
  }
}

/**
 * Store a response. Returns the body-readable clone to send on.
 *
 * cache.put consumes the body, so the response must be cloned before storing.
 * Getting that wrong yields an empty body to the visitor -- a bug that only
 * shows up on a cache MISS, which is exactly the path least exercised by hand.
 */
export async function writeCache(request, durationMinutes, response, ctx) {
  const toStore = response.clone()
  toStore.headers.set('Cache-Control', `public, max-age=${PUBLIC_TTL_SECONDS}`)
  try {
    const cache = cacheImpl.open()
    if (!cache) return response
    const put = cache.put(cacheKeyFor(request, durationMinutes), toStore)
    // Don't make the visitor wait on the write.
    if (ctx?.waitUntil) ctx.waitUntil(put)
    else await put
  } catch {
    // A cache write failure is not worth failing the request over.
  }
  return response
}
