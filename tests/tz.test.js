import assert from 'node:assert/strict'
import test from 'node:test'
import { zoneOffsetMs, zonedWallTimeToUtc, utcToZonedParts } from '../src/core/tz.js'

const NY = 'America/New_York'

test('zoneOffsetMs returns -4h during EDT and -5h during EST', () => {
  const july = Date.UTC(2026, 6, 15, 16, 0, 0)
  const january = Date.UTC(2026, 0, 15, 16, 0, 0)
  assert.equal(zoneOffsetMs(july, NY), -4 * 3600 * 1000)
  assert.equal(zoneOffsetMs(january, NY), -5 * 3600 * 1000)
})

test('zonedWallTimeToUtc maps 9am New York to the right UTC instant in both DST states', () => {
  // 2026-07-15 09:00 EDT === 13:00Z
  assert.equal(
    zonedWallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, NY),
    Date.UTC(2026, 6, 15, 13, 0, 0),
  )
  // 2026-01-15 09:00 EST === 14:00Z
  assert.equal(
    zonedWallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, NY),
    Date.UTC(2026, 0, 15, 14, 0, 0),
  )
})

test('zonedWallTimeToUtc survives the spring-forward discontinuity', () => {
  // 2026-03-08 02:30 New York does not exist; DST jumps 02:00 -> 03:00.
  // We require a stable, in-range answer rather than NaN or a wild value.
  const ms = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY)
  assert.equal(Number.isFinite(ms), true)
  const back = utcToZonedParts(ms, NY)
  assert.equal(back.year, 2026)
  assert.equal(back.month, 3)
  assert.equal(back.day, 8)
})

test('utcToZonedParts decomposes an instant into zoned wall-clock parts', () => {
  const parts = utcToZonedParts(Date.UTC(2026, 6, 15, 13, 0, 0), NY)
  assert.deepEqual(
    { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute },
    { year: 2026, month: 7, day: 15, hour: 9, minute: 0 },
  )
  assert.equal(parts.weekday, 3) // Wednesday, ISO numbering (Mon=1)
})
