import assert from 'node:assert/strict'
import test from 'node:test'
import { signState, verifyState } from '../src/core/oauth-state.js'

const KEY = 'test-signing-key-0123456789'

test('a freshly signed state verifies and returns its payload', async () => {
  const state = await signState({ provider: 'google', role: 'write' }, KEY, { now: 1_000_000, ttlSeconds: 600 })
  const result = await verifyState(state, KEY, { now: 1_000_000 })
  assert.equal(result.ok, true)
  assert.equal(result.payload.provider, 'google')
  // The role must ride inside the SIGNED payload. If the callback read it from
  // a query param instead, anyone could turn a busy connection into the write
  // target by editing the URL.
  assert.equal(result.payload.role, 'write')
})

test('a tampered payload fails verification', async () => {
  const state = await signState({ provider: 'google' }, KEY, { now: 1_000_000, ttlSeconds: 600 })
  const [body, sig] = state.split('.')
  const forged = `${btoa(JSON.stringify({ provider: 'zoho', exp: 9e12 })).replace(/=+$/, '')}.${sig}`
  assert.notEqual(forged, state)
  const result = await verifyState(forged, KEY, { now: 1_000_000 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bad signature')
})

test('a state signed with a different key is rejected', async () => {
  const state = await signState({ provider: 'google' }, KEY, { now: 1_000_000, ttlSeconds: 600 })
  const result = await verifyState(state, 'some-other-key', { now: 1_000_000 })
  assert.equal(result.ok, false)
})

test('an expired state is rejected', async () => {
  const state = await signState({ provider: 'google' }, KEY, { now: 1_000_000, ttlSeconds: 600 })
  const result = await verifyState(state, KEY, { now: 1_000_000 + 601_000 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'expired')
})

test('malformed input is rejected without throwing', async () => {
  for (const bad of ['', 'nodot', 'a.b.c', '!!!.!!!']) {
    const result = await verifyState(bad, KEY, { now: 1_000_000 })
    assert.equal(result.ok, false)
  }
})
