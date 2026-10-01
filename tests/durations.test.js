import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_DURATIONS, PUBLIC_DURATIONS, DEFAULT_DURATION, coerceDuration, isAllowedSpan } from '../src/core/durations.js'

test('the internal allowlist is 30, 60, 120 and the default is 30', () => {
  assert.deepEqual(ALLOWED_DURATIONS, [30, 60, 120])
  assert.equal(DEFAULT_DURATION, 30)
})

test('the public allowlist excludes the longest internal option', () => {
  // Anyone past Turnstile can consume availability, so the largest block a
  // stranger may take is an hour.
  assert.deepEqual(PUBLIC_DURATIONS, [30, 60])
  assert.ok(!PUBLIC_DURATIONS.includes(120))
  assert.ok(!PUBLIC_DURATIONS.includes(240), '240 is no longer offered anywhere')
})

test('coerceDuration accepts an allowed value as number or string', () => {
  assert.equal(coerceDuration(60, ALLOWED_DURATIONS), 60)
  assert.equal(coerceDuration('120', ALLOWED_DURATIONS), 120)
})

test('coerceDuration falls back to the default on anything else', () => {
  // Falling back rather than erroring keeps a stale client bookable.
  for (const bad of [undefined, null, '', 'abc', 0, -30, 45, 999, 1e9, NaN, {}, []]) {
    assert.equal(coerceDuration(bad, ALLOWED_DURATIONS), 30, `${String(bad)} must fall back`)
  }
})

test('coerceDuration respects a narrower list', () => {
  assert.equal(coerceDuration(120, PUBLIC_DURATIONS), 30, '120 is not public; fall back')
  assert.equal(coerceDuration(240, ALLOWED_DURATIONS), 30, '240 is retired; fall back')
  assert.equal(coerceDuration(60, PUBLIC_DURATIONS), 60)
})

test('isAllowedSpan matches exact millisecond spans only', () => {
  const s = '2026-10-12T13:00:00.000Z'
  assert.equal(isAllowedSpan(s, '2026-10-12T13:30:00.000Z', ALLOWED_DURATIONS), true)   // 30
  assert.equal(isAllowedSpan(s, '2026-10-12T14:00:00.000Z', ALLOWED_DURATIONS), true)   // 60
  assert.equal(isAllowedSpan(s, '2026-10-12T15:00:00.000Z', ALLOWED_DURATIONS), true)   // 120
  assert.equal(isAllowedSpan(s, '2026-10-12T17:00:00.000Z', ALLOWED_DURATIONS), false)  // 240, retired
  assert.equal(isAllowedSpan(s, '2026-10-12T13:45:00.000Z', ALLOWED_DURATIONS), false)  // 45
  assert.equal(isAllowedSpan(s, '2026-10-12T21:00:00.000Z', ALLOWED_DURATIONS), false)
  assert.equal(isAllowedSpan(s, s, ALLOWED_DURATIONS), false)
  assert.equal(isAllowedSpan('nonsense', 'also-nonsense', ALLOWED_DURATIONS), false)
  assert.equal(isAllowedSpan('2026-10-12T17:00:00.000Z', s, ALLOWED_DURATIONS), false)
})

test('isAllowedSpan honours a single-element list', () => {
  const s = '2026-10-12T13:00:00.000Z'
  assert.equal(isAllowedSpan(s, '2026-10-12T13:30:00.000Z', [30]), true)
  assert.equal(isAllowedSpan(s, '2026-10-12T14:00:00.000Z', [30]), false)
})
