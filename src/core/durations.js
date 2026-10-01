// Meeting lengths, in one place. The slots endpoint, the book endpoint, both
// public handlers and the page dropdown all read from here, so a length can
// never be offered by one layer and rejected by another.

/** What an authenticated operator may book. */
export const ALLOWED_DURATIONS = [30, 60, 120]

/**
 * What an anonymous visitor may book. 120 is deliberately absent: anyone past
 * Turnstile can consume availability, so the largest block a stranger may take
 * is an hour.
 */
export const PUBLIC_DURATIONS = [30, 60]

export const DEFAULT_DURATION = 30

/**
 * Coerce a request value to an allowed duration.
 *
 * Falls back to the default rather than erroring: a stale client sending a
 * duration we no longer offer should still be able to book, not hard-fail.
 */
export function coerceDuration(value, allowed) {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_DURATION
  return allowed.includes(n) ? n : DEFAULT_DURATION
}

/**
 * Does [startIso, endIso) span exactly one allowed duration?
 *
 * The booking endpoint takes start and end from the client and only ever
 * checked that the window was FREE, never how long it was. Unauthenticated
 * callers make that an abuse vector, so the span is validated explicitly.
 */
export function isAllowedSpan(startIso, endIso, allowed) {
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  const minutes = (end - start) / 60000
  return allowed.includes(minutes)
}
