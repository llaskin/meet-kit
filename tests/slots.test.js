import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeBusy, computeSlots } from '../src/core/slots.js'

const RULES = {
  timezone: 'America/New_York',
  weekdays: [1, 2, 3, 4, 5],   // ISO: Mon..Fri
  startTime: '09:00',
  endTime: '17:00',
  durationMinutes: 30,
  intervalMinutes: 30,
  minNoticeMinutes: 120,
  horizonDays: 21,
}

const iso = (s) => new Date(s).toISOString()

test('mergeBusy merges overlapping intervals', () => {
  const merged = mergeBusy([
    { start: iso('2026-09-14T13:00:00Z'), end: iso('2026-09-14T14:00:00Z') },
    { start: iso('2026-09-14T13:30:00Z'), end: iso('2026-09-14T15:00:00Z') },
  ])
  assert.deepEqual(merged, [
    { start: Date.parse('2026-09-14T13:00:00Z'), end: Date.parse('2026-09-14T15:00:00Z') },
  ])
})

test('mergeBusy merges exactly-adjacent intervals', () => {
  const merged = mergeBusy([
    { start: iso('2026-09-14T13:00:00Z'), end: iso('2026-09-14T14:00:00Z') },
    { start: iso('2026-09-14T14:00:00Z'), end: iso('2026-09-14T15:00:00Z') },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].end, Date.parse('2026-09-14T15:00:00Z'))
})

test('mergeBusy leaves a gap between non-touching intervals', () => {
  const merged = mergeBusy([
    { start: iso('2026-09-14T13:00:00Z'), end: iso('2026-09-14T14:00:00Z') },
    { start: iso('2026-09-14T14:30:00Z'), end: iso('2026-09-14T15:00:00Z') },
  ])
  assert.equal(merged.length, 2)
})

test('a clear Monday yields 16 half-hour slots between 9am and 5pm', () => {
  // Monday 2026-09-14. "now" is the preceding Friday, so min-notice is irrelevant.
  const slots = computeSlots({
    busy: [],
    rules: { ...RULES, horizonDays: 1 },
    now: Date.parse('2026-09-11T12:00:00Z'),
    fromDay: '2026-09-14',
  })
  assert.equal(slots.length, 16)
  assert.equal(slots[0].start, '2026-09-14T13:00:00.000Z')  // 9:00 EDT
  assert.equal(slots[15].start, '2026-09-14T20:30:00.000Z') // 4:30 EDT, ends 5:00
})

test('a busy block removes exactly the slots it overlaps', () => {
  const slots = computeSlots({
    busy: [{ start: iso('2026-09-14T14:00:00Z'), end: iso('2026-09-14T15:00:00Z') }], // 10:00-11:00 EDT
    rules: { ...RULES, horizonDays: 1 },
    now: Date.parse('2026-09-11T12:00:00Z'),
    fromDay: '2026-09-14',
  })
  assert.equal(slots.length, 14)
  const starts = slots.map((s) => s.start)
  assert.equal(starts.includes('2026-09-14T14:00:00.000Z'), false)
  assert.equal(starts.includes('2026-09-14T14:30:00.000Z'), false)
  assert.equal(starts.includes('2026-09-14T13:30:00.000Z'), true)
  assert.equal(starts.includes('2026-09-14T15:00:00.000Z'), true)
})

test('a busy block that merely touches a slot boundary does not remove it', () => {
  // Busy 09:00-09:30 EDT. The 09:30 slot starts exactly when busy ends.
  const slots = computeSlots({
    busy: [{ start: iso('2026-09-14T13:00:00Z'), end: iso('2026-09-14T13:30:00Z') }],
    rules: { ...RULES, horizonDays: 1 },
    now: Date.parse('2026-09-11T12:00:00Z'),
    fromDay: '2026-09-14',
  })
  const starts = slots.map((s) => s.start)
  assert.equal(starts.includes('2026-09-14T13:00:00.000Z'), false)
  assert.equal(starts.includes('2026-09-14T13:30:00.000Z'), true)
})

test('minimum notice suppresses slots too close to now', () => {
  // now = Monday 09:05 EDT. 120 min notice => nothing before 11:05 => first slot 11:30.
  const slots = computeSlots({
    busy: [],
    rules: { ...RULES, horizonDays: 1 },
    now: Date.parse('2026-09-14T13:05:00Z'),
    fromDay: '2026-09-14',
  })
  assert.equal(slots[0].start, '2026-09-14T15:30:00.000Z') // 11:30 EDT
})

test('weekends are skipped', () => {
  // Saturday 2026-09-12.
  const slots = computeSlots({
    busy: [],
    rules: { ...RULES, horizonDays: 1 },
    now: Date.parse('2026-09-11T12:00:00Z'),
    fromDay: '2026-09-12',
  })
  assert.equal(slots.length, 0)
})

test('the horizon caps how far ahead slots are offered', () => {
  const slots = computeSlots({
    busy: [],
    rules: { ...RULES, horizonDays: 3 },
    now: Date.parse('2026-09-11T12:00:00Z'),
    fromDay: '2026-09-14',
  })
  // Mon 14th, Tue 15th, Wed 16th = 3 weekdays x 16 slots
  assert.equal(slots.length, 48)
  assert.equal(slots.every((s) => s.start < '2026-09-17T00:00:00.000Z'), true)
})

test('slots stay at 9am local across the DST boundary', () => {
  // 2026-11-01 is the US fall-back. Monday 2026-11-02 is EST (UTC-5),
  // so 9am local is 14:00Z, not the 13:00Z it was in EDT.
  const slots = computeSlots({
    busy: [],
    rules: { ...RULES, horizonDays: 1 },
    now: Date.parse('2026-10-30T12:00:00Z'),
    fromDay: '2026-11-02',
  })
  assert.equal(slots[0].start, '2026-11-02T14:00:00.000Z')
})

test('each slot carries its end time and duration', () => {
  const slots = computeSlots({
    busy: [],
    rules: { ...RULES, horizonDays: 1 },
    now: Date.parse('2026-09-11T12:00:00Z'),
    fromDay: '2026-09-14',
  })
  assert.equal(slots[0].end, '2026-09-14T13:30:00.000Z')
})

// --- bufferMinutes: breathing room between meetings --------------------------

test('bufferMinutes pads every busy block on both sides', () => {
  // Busy 11:00-11:30 EDT (15:00-15:30Z). A 15-minute buffer makes the
  // protected window 10:45-11:45 EDT. On a 15-minute grid with 30-minute
  // meetings: 10:15 (ends 10:45) is the last slot before, 11:45 the first after.
  const slots = computeSlots({
    busy: [{ start: iso('2026-09-14T15:00:00Z'), end: iso('2026-09-14T15:30:00Z') }],
    rules: { ...RULES, horizonDays: 1, intervalMinutes: 15, bufferMinutes: 15 },
    now: Date.parse('2026-09-11T12:00:00Z'),
    fromDay: '2026-09-14',
  })
  const starts = slots.map((s) => s.start)
  assert.equal(starts.includes('2026-09-14T14:15:00.000Z'), true)   // 10:15 EDT, ends 10:45
  assert.equal(starts.includes('2026-09-14T14:30:00.000Z'), false)  // 10:30 EDT, ends 11:00
  assert.equal(starts.includes('2026-09-14T14:45:00.000Z'), false)
  assert.equal(starts.includes('2026-09-14T15:00:00.000Z'), false)
  assert.equal(starts.includes('2026-09-14T15:15:00.000Z'), false)
  assert.equal(starts.includes('2026-09-14T15:30:00.000Z'), false)  // 11:30 EDT, inside the trailing buffer
  assert.equal(starts.includes('2026-09-14T15:45:00.000Z'), true)   // 11:45 EDT
})

test('bufferMinutes 0, or absent, keeps back-to-back slots exactly as before', () => {
  const busy = [{ start: iso('2026-09-14T13:00:00Z'), end: iso('2026-09-14T13:30:00Z') }]
  const base = { busy, rules: { ...RULES, horizonDays: 1 }, now: Date.parse('2026-09-11T12:00:00Z'), fromDay: '2026-09-14' }
  const absent = computeSlots(base)
  const zero = computeSlots({ ...base, rules: { ...base.rules, bufferMinutes: 0 } })
  assert.deepEqual(zero, absent)
  assert.equal(absent.map((s) => s.start).includes('2026-09-14T13:30:00.000Z'), true)
})

test('the buffer never reaches before the day opens or past its close', () => {
  // Busy 08:30-09:00 EDT ends exactly at opening. Buffered it covers until
  // 09:15, so the 09:00 slot goes, but the day still opens at 09:00 for the
  // 09:15 slot: the buffer pads busy time, not the business-hours window.
  const slots = computeSlots({
    busy: [{ start: iso('2026-09-14T12:30:00Z'), end: iso('2026-09-14T13:00:00Z') }],
    rules: { ...RULES, horizonDays: 1, intervalMinutes: 15, bufferMinutes: 15 },
    now: Date.parse('2026-09-11T12:00:00Z'),
    fromDay: '2026-09-14',
  })
  assert.equal(slots[0].start, '2026-09-14T13:15:00.000Z')
  assert.equal(slots[slots.length - 1].end, '2026-09-14T21:00:00.000Z') // 17:00 EDT close unchanged
})

test('mergeBusy with padding merges blocks the padding makes adjacent', () => {
  const merged = mergeBusy([
    { start: iso('2026-09-14T13:00:00Z'), end: iso('2026-09-14T13:30:00Z') },
    { start: iso('2026-09-14T13:45:00Z'), end: iso('2026-09-14T14:00:00Z') },
  ], 15 * 60 * 1000)
  assert.deepEqual(merged, [
    { start: Date.parse('2026-09-14T12:45:00Z'), end: Date.parse('2026-09-14T14:15:00Z') },
  ])
})

test('a negative or non-numeric stored buffer is treated as 0, never as shrinkage', () => {
  const busy = [{ start: iso('2026-09-14T13:00:00Z'), end: iso('2026-09-14T13:30:00Z') }]
  const base = { busy, rules: { ...RULES, horizonDays: 1 }, now: Date.parse('2026-09-11T12:00:00Z'), fromDay: '2026-09-14' }
  const plain = computeSlots(base)
  assert.deepEqual(computeSlots({ ...base, rules: { ...base.rules, bufferMinutes: -30 } }), plain)
  assert.deepEqual(computeSlots({ ...base, rules: { ...base.rules, bufferMinutes: 'abc' } }), plain)
  // 09:00 EDT is busy; with a NEGATIVE pad it would wrongly reappear.
  assert.equal(plain.map((s) => s.start).includes('2026-09-14T13:00:00.000Z'), false)
})
