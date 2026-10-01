// Timezone math built on Intl, which the Workers runtime ships with full ICU.
// No library: Luxon and date-fns-tz both pull in more than this needs.

const PART_CACHE = new Map()

function formatterFor(timeZone) {
  let f = PART_CACHE.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    })
    PART_CACHE.set(timeZone, f)
  }
  return f
}

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** Decompose a UTC instant into wall-clock parts in `timeZone`. weekday is ISO (Mon=1..Sun=7). */
export function utcToZonedParts(utcMs, timeZone) {
  const parts = {}
  for (const p of formatterFor(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as "24" in some locales/zones; normalise to 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY[parts.weekday],
  }
}

/** Offset of `timeZone` from UTC at instant `utcMs`, in ms. Negative west of Greenwich. */
export function zoneOffsetMs(utcMs, timeZone) {
  const p = utcToZonedParts(utcMs, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asIfUtc - utcMs
}

/**
 * UTC instant for a wall-clock time in `timeZone`.
 *
 * Two passes: guess as if the wall time were UTC, measure the offset there,
 * correct, then re-measure at the corrected instant. The second pass is what
 * makes DST transition days come out right — a single pass picks the offset on
 * the wrong side of the boundary near the cutover.
 */
export function zonedWallTimeToUtc({ year, month, day, hour, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const firstPass = guess - zoneOffsetMs(guess, timeZone)
  return guess - zoneOffsetMs(firstPass, timeZone)
}
