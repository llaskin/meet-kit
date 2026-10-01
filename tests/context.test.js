import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { loadCfg } from '../src/handlers/context.js'

const ENV = {
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec',
  ZOHO_CLIENT_ID: 'zid', ZOHO_CLIENT_SECRET: 'zsec',
}

test('client ids and secrets come from env', async () => {
  const cfg = await loadCfg(realDB(), ENV)
  assert.equal(cfg.google_client_id, 'gid')
  assert.equal(cfg.google_client_secret, 'gsec')
  assert.equal(cfg.zoho_client_id, 'zid')
  assert.equal(cfg.zoho_client_secret, 'zsec')
})

test('a secret stored in D1 is ignored, never returned', async () => {
  const db = realDB()
  await store.setConfig(db, 'google_client_secret', 'LEAKED-FROM-D1')
  const cfg = await loadCfg(db, {})
  assert.equal(cfg.google_client_secret, '')
})

test('non-secret D1 settings pass through', async () => {
  const db = realDB()
  await store.setConfig(db, 'meet_link', 'https://meet.example.com/x')
  const cfg = await loadCfg(db, ENV)
  assert.equal(cfg.meet_link, 'https://meet.example.com/x')
})
