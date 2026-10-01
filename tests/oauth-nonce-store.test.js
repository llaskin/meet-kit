import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'

test('an issued OAuth nonce can be consumed exactly once (real SQLite)', async () => {
  const db = realDB()
  await store.recordOAuthNonce(db, 'n1', 9_999_999_999)
  assert.equal(await store.consumeOAuthNonce(db, 'n1'), true)
  assert.equal(await store.consumeOAuthNonce(db, 'n1'), false)
  assert.equal(await store.consumeOAuthNonce(db, 'never-issued'), false)
})

test('purge drops only expired OAuth nonces and leaves other config alone', async () => {
  const db = realDB()
  await store.recordOAuthNonce(db, 'old', 100)
  await store.recordOAuthNonce(db, 'live', 300)
  await store.setConfig(db, 'meet_link', 'https://x.example')
  await store.purgeExpiredOAuthNonces(db, 200)
  const cfg = await store.getConfig(db)
  assert.equal(cfg['oauth_nonce:old'], undefined)
  assert.equal(cfg['oauth_nonce:live'], '300')
  assert.equal(cfg.meet_link, 'https://x.example')
})
