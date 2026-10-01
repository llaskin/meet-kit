import { utcToZonedParts, zonedWallTimeToUtc } from './tz.js'

/**
 * Normalise busy intervals to sorted, non-overlapping {start,end} epoch-ms pairs.
 * Adjacent intervals (one ends exactly where the next begins) are merged too:
 * they represent one continuous block of unavailability.
 */
export function mergeBusy(intervals) {
  const parsed = (intervals || [])
    .map((i) => ({ start: Date.parse(i.start), end: Date.parse(i.end) }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start)

  const out = []
  for (const cur of parsed) {
    const last = out[out.length - 1]
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

function parseHhMm(value) {
  const [h, m] = String(value).split(':').map(Number)
  return { hour: h, minute: m || 0 }
}

/** Advance a Y/M/D by one calendar day. */
function nextDay({ year, month, day }) {
  const d = new Date(Date.UTC(year, month - 1, day + 1))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/**
 * Compute bookable slots.
 *
 * Pure: no network, no ambient clock. `now` and `fromDay` are always supplied.
 *
 * @param busy     Array of {start,end} ISO strings — the UNION of busy time from
 *                 every connected provider. Overlaps are fine; they get merged.
 * @param rules    { timezone, weekdays[ISO 1-7], startTime 'HH:MM', endTime 'HH:MM',
 *                   durationMinutes, intervalMinutes, minNoticeMinutes, horizonDays }
 * @param now      Epoch ms. Slots earlier than now + minNotice are suppressed.
 * @param fromDay  'YYYY-MM-DD' — first calendar day to consider, in rules.timezone.
 * @returns        Array of { start, end } ISO strings, ascending.
 */
export function computeSlots({ busy, rules, now, fromDay }) {
  const merged = mergeBusy(busy)
  const startWall = parseHhMm(rules.startTime)
  const endWall = parseHhMm(rules.endTime)
  const durationMs = rules.durationMinutes * 60 * 1000
  const intervalMs = (rules.intervalMinutes || rules.durationMinutes) * 60 * 1000
  const earliest = now + rules.minNoticeMinutes * 60 * 1000
  const weekdays = new Set(rules.weekdays)

  const [y, m, d] = fromDay.split('-').map(Number)
  let cursor = { year: y, month: m, day: d }
  const slots = []

  for (let i = 0; i < rules.horizonDays; i++) {
    // Which weekday is this calendar day in the business timezone? Ask at local
    // noon, which is never near a DST boundary.
    const noon = zonedWallTimeToUtc({ ...cursor, hour: 12, minute: 0 }, rules.timezone)
    const weekday = utcToZonedParts(noon, rules.timezone).weekday

    if (weekdays.has(weekday)) {
      // Recomputed per day, so the window tracks local wall-clock across DST.
      const dayOpen = zonedWallTimeToUtc({ ...cursor, ...startWall }, rules.timezone)
      const dayClose = zonedWallTimeToUtc({ ...cursor, ...endWall }, rules.timezone)

      for (let s = dayOpen; s + durationMs <= dayClose; s += intervalMs) {
        const e = s + durationMs
        if (s < earliest) continue
        // Strict overlap: a busy block ending exactly when a slot starts does
        // not conflict with it.
        const conflicts = merged.some((b) => s < b.end && e > b.start)
        if (!conflicts) {
          slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })
        }
      }
    }
    cursor = nextDay(cursor)
  }

  return slots
}
