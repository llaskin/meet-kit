import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('wrangler.jsonc routes admin and api through the Worker first', () => {
  const w = read('wrangler.jsonc')
  assert.match(w, /"run_worker_first":\s*\["\/admin\/\*",\s*"\/api\/\*"\]/)
})

test('wrangler.jsonc declares no secret values', () => {
  const w = read('wrangler.jsonc')
  for (const k of ['GOOGLE_CLIENT_SECRET', 'ZOHO_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY']) {
    assert.doesNotMatch(w, new RegExp(`"${k}"\\s*:`), `${k} must be a wrangler secret, not a var`)
  }
})

test('meet.config.json has every display key', () => {
  const c = JSON.parse(read('meet.config.json'))
  for (const k of ['displayName', 'pageTitle', 'pageSubtitle', 'eventTitle', 'privacyUrl', 'termsUrl', 'accentColor']) {
    assert.ok(k in c, `missing ${k}`)
  }
})
