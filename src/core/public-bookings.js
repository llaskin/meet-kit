// Store + rate-limit queries for the public /meet booking table
// (migrations/004_public_bookings.sql). See that file's header for why
// this table exists separately from call_state/bookings.
//
// Emails are lower-cased on write and on every read here. Without that,
// "A@B.co" and "a@b.co" would count as different attendees, and the
// per-email booking cap would be trivially defeated by re-casing the same
// address.

function isoHoursAgo(hours, now = Date.now()) {
  return new Date(now - hours * 3600_000).toISOString()
}

export async function savePublicBooking(db, b) {
  const id = b.id || crypto.randomUUID()
  const createdAt = b.createdAt || new Date().toISOString()
  await db.prepare(
    `INSERT INTO public_bookings
       (id, created_at, attendee_email, cap_identity, attendee_name, company, notes,
        duration_min, start_utc, end_utc, event_id, meet_url, client_ip, calendar_id, meet_url_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, createdAt, String(b.email || '').toLowerCase(),
    String(b.capIdentity || b.email || '').toLowerCase(), b.name || '', b.company || '',
    b.notes || '', b.durationMinutes, b.startUtc, b.endUtc,
    b.eventId || null, b.meetUrl || null, b.clientIp || null, b.calendarId || null,
    b.meetUrlSource || null,
  ).run()
  return id
}

export async function getPublicBooking(db, id) {
  return db.prepare(`SELECT * FROM public_bookings WHERE id = ?`).bind(id).first()
}

/** Live public bookings whose end is still in the future, soonest first. */
export async function listUpcomingPublic(db, nowIso) {
  const { results } = await db
    .prepare(
      `SELECT * FROM public_bookings WHERE end_utc >= ? ORDER BY start_utc`,
    )
    .bind(nowIso)
    .all()
  return results || []
}

/**
 * MOVE a public booking into the cancellation ledger.
 *
 * Not a status flag. public_bookings declares UNIQUE (start_utc) as an inline
 * table constraint, so a cancelled row left in place would reserve its time
 * forever -- computeSlots would offer the slot (the Google event is gone) and
 * the INSERT would then fail, telling the visitor "Unable to book that time"
 * for a slot we had just shown them. SQLite cannot drop a table constraint
 * without a full table rebuild, which migrations here are forbidden from doing.
 *
 * INSERT is ordered before DELETE deliberately: if the batch ever degrades to
 * sequential execution, a failure between them leaves a recoverable duplicate
 * rather than destroying the only copy of the record.
 */
export async function cancelPublicBooking(db, { row, cancelledAt, cancelledBy }) {
  const insert = db
    .prepare(
      // OR IGNORE: two concurrent cancels of one booking -- a stale tab, or two
      // admins -- otherwise leave correct data but 500 the loser on the primary
      // key. The row is addressed by its own id, so ignoring a duplicate can
      // only ever re-assert what is already there.
      `INSERT OR IGNORE INTO public_bookings_cancelled
         (id, created_at, attendee_email, cap_identity, attendee_name, company, notes,
          duration_min, start_utc, end_utc, event_id, meet_url, client_ip, calendar_id,
          meet_url_source, cancelled_at, cancelled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.created_at, row.attendee_email, row.cap_identity,
      row.attendee_name ?? null, row.company ?? null, row.notes ?? null,
      row.duration_min, row.start_utc, row.end_utc,
      row.event_id ?? null, row.meet_url ?? null, row.client_ip ?? null,
      row.calendar_id ?? null, row.meet_url_source ?? null, cancelledAt, cancelledBy ?? null,
    )

  const del = db.prepare(`DELETE FROM public_bookings WHERE id = ?`).bind(row.id)

  await db.batch([insert, del])
}

// The abuse caps count BOTH tables.
//
// Cancelling a public booking MOVES its row out of public_bookings and into
// public_bookings_cancelled. Counting only the live table would mean the
// operator's one remediation action -- cancelling an abusive booking -- is also
// what refunds the abuser's 24h quota, which is the opposite of what it should
// do. /api/public/book has no request-rate limiter of its own, so these row
// counts are the ONLY bound on that endpoint; the total cap in particular is
// documented there as "the backstop when they rotate addresses and IPs".
//
// Verified before this was changed: three bookings hit the per-email cap, and
// after an admin cancelled them all three counters read zero.
const RECENT_ROWS = `(SELECT created_at, cap_identity, client_ip FROM public_bookings
                      UNION ALL
                      SELECT created_at, cap_identity, client_ip FROM public_bookings_cancelled)`

export async function countRecentByEmail(db, email, hours, now = Date.now()) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM ${RECENT_ROWS} WHERE cap_identity = ? AND created_at >= ?`
  ).bind(String(email || '').toLowerCase(), isoHoursAgo(hours, now)).first()
  return row?.n ?? 0
}

export async function countRecentByIp(db, ip, hours, now = Date.now()) {
  if (!ip) return 0
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM ${RECENT_ROWS} WHERE client_ip = ? AND created_at >= ?`
  ).bind(ip, isoHoursAgo(hours, now)).first()
  return row?.n ?? 0
}

/**
 * Every public booking in the window, regardless of who made it.
 *
 * The per-email and per-IP caps bound a single actor. Nothing bounded the SUM:
 * a handful of addresses across a /64 could still consume the operator's whole
 * week. This is the backstop.
 */
export async function countRecentTotal(db, hours, now = Date.now()) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM ${RECENT_ROWS} WHERE created_at >= ?`
  ).bind(isoHoursAgo(hours, now)).first()
  return row?.n ?? 0
}

/**
 * Enforce the retention periods the Privacy Policy actually promises.
 *
 * Section 6.1 states two different clocks, because the data serves two
 * different purposes:
 *
 *   - IP address: 30 days from SUBMISSION. It exists only to back a 24-hour
 *     rate cap, so keeping it beyond a month serves nothing that could be
 *     explained to someone who asked. The column is nulled; the booking record
 *     itself is a business record and survives.
 *   - Booking record: 24 months from the MEETING DATE, not the submission date.
 *     A booking made long ago for a meeting still in the future must not be
 *     deleted, which is why this keys on start_utc rather than created_at.
 *
 * A policy that promises deletion while nothing deletes is worse than no
 * policy, so this is called opportunistically from the public slots handler --
 * gated behind a cache miss, so it runs roughly once a minute per location
 * rather than once per request, and keeps running even in a week with no
 * bookings.
 *
 * NEVER throws: it runs inside waitUntil on a live request path, and a broken
 * purge must not take a booking or a slot lookup down with it. A failure is
 * still reported, not swallowed -- the returned `ok` flag is false and
 * `error` carries the cause, so a caller that DOES care (the nightly cron in
 * worker.js's scheduled()) can notice and surface it instead of a retention
 * promise that silently stopped being kept.
 */
export const IP_RETENTION_DAYS = 30
export const RECORD_RETENTION_MONTHS = 24

export async function purgeExpired(db, { now = Date.now() } = {}) {
  const result = { ok: true, ipsCleared: 0, rowsDeleted: 0 }
  try {
    const ipCutoff = new Date(now - IP_RETENTION_DAYS * 86_400_000).toISOString()
    // Both tables. A cancelled booking is still a record of a real person, and
    // the privacy policy's promise (IP nulled at 30 days, record deleted 24
    // months after the meeting) does not stop applying because it was cancelled.
    const ip = await db.prepare(
      'UPDATE public_bookings SET client_ip = NULL WHERE client_ip IS NOT NULL AND created_at < ?'
    ).bind(ipCutoff).run()
    const ipCancelled = await db.prepare(
      'UPDATE public_bookings_cancelled SET client_ip = NULL WHERE client_ip IS NOT NULL AND created_at < ?'
    ).bind(ipCutoff).run()
    result.ipsCleared = (ip?.meta?.changes ?? 0) + (ipCancelled?.meta?.changes ?? 0)

    // Months, computed on a real date rather than as 30-day units, so the
    // boundary does not drift by a fortnight over two years.
    const cutoff = new Date(now)
    cutoff.setUTCMonth(cutoff.getUTCMonth() - RECORD_RETENTION_MONTHS)
    const del = await db.prepare(
      'DELETE FROM public_bookings WHERE start_utc < ?'
    ).bind(cutoff.toISOString()).run()
    const delCancelled = await db.prepare(
      'DELETE FROM public_bookings_cancelled WHERE start_utc < ?'
    ).bind(cutoff.toISOString()).run()
    result.rowsDeleted = (del?.meta?.changes ?? 0) + (delCancelled?.meta?.changes ?? 0)
  } catch (error) {
    // Still never throw: see the header. Retention is best-effort on a live
    // path -- but the failure is now visible on the return value.
    result.ok = false
    result.error = error
  }
  return result
}
