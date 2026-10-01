// Application-level rate limiting for the unauthenticated public booking
// endpoints (/api/public/slots, /api/public/book). See migrations/005_rate_limit.sql
// for the full "why" -- Cloudflare's native Rate Limiting binding is
// Workers-only and unavailable to Pages Functions, and there is no KV
// binding on this project, so D1 doubles as the limiter's storage.
//
// FIXED WINDOW, not sliding. One row per (bucket, window_start), incremented
// by upsert. This is approximate at window edges -- a burst spanning two
// windows can briefly exceed `limit` -- and that is an ACCEPTED tradeoff:
// the alternative (a row per request, for a true sliding window) means
// unbounded writes under exactly the flood this exists to defend against.
// A fixed window keeps writes bounded regardless of request volume.
//
// RETURNING support: real SQLite (node:sqlite, used in tests/rate-limit.test.js)
// supports `... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count`
// as a single atomic statement -- verified directly against node:sqlite while
// building this file. Cloudflare D1 is also SQLite-based and documents
// RETURNING support, so `consume` below uses the single-statement upsert
// rather than an UPDATE-then-SELECT.

function windowStartFor(now, windowSeconds) {
  return Math.floor(now / 1000 / windowSeconds) * windowSeconds
}

/**
 * Consume one unit from a fixed window.
 *
 * Fails OPEN on any database error: a limiter that hard-fails takes the
 * whole endpoint down with it, which is the exact outage this exists to
 * prevent. Returning `{ allowed: true, count: 0 }` on error is deliberate
 * and is the opposite of the fail-CLOSED posture used for calendar reads
 * elsewhere in this project (see busy.js) -- refusing to book on unknown
 * availability is safe, refusing ALL traffic because a counter broke is not.
 *
 * @returns {Promise<{ allowed: boolean, count: number }>}
 */
export async function consume(db, { bucket, limit, windowSeconds, now = Date.now() }) {
  try {
    const windowStart = windowStartFor(now, windowSeconds)
    const row = await db.prepare(
      `INSERT INTO rate_counters (bucket, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    ).bind(bucket, windowStart).first()
    const count = row?.count ?? 1
    return { allowed: count <= limit, count }
  } catch {
    // Fail open -- see header comment. Never let a broken counter take the
    // endpoint down with it.
    return { allowed: true, count: 0 }
  }
}

/**
 * Delete counters older than `keepWindows` windows. Called opportunistically
 * (not on a schedule) so the table doesn't grow unbounded; safe to skip a
 * run or call redundantly.
 */
export async function sweep(db, { windowSeconds, keepWindows = 3, now = Date.now() }) {
  try {
    const currentWindow = windowStartFor(now, windowSeconds)
    const cutoff = currentWindow - (keepWindows - 1) * windowSeconds
    await db.prepare('DELETE FROM rate_counters WHERE window_start < ?').bind(cutoff).run()
  } catch {
    // Sweeping is best-effort housekeeping, not correctness-critical --
    // never let it take the caller down either.
  }
}
