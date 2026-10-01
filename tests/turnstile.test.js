import assert from 'node:assert/strict'
import test from 'node:test'
import { turnstileApi, verifyTurnstile } from '../src/core/turnstile.js'

function stub(handler) { turnstileApi.fetch = handler }

test('a valid token passes', async () => {
  stub(async () => new Response(JSON.stringify({ success: true })))
  assert.equal(await verifyTurnstile({ token: 't', secret: 's', remoteIp: '1.2.3.4' }), true)
})

test('an invalid token fails', async () => {
  stub(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] })))
  assert.equal(await verifyTurnstile({ token: 't', secret: 's' }), false)
})

test('a network error FAILS CLOSED', async () => {
  // Never let an outage reaching Cloudflare become an open door.
  stub(async () => { throw new Error('ECONNRESET') })
  assert.equal(await verifyTurnstile({ token: 't', secret: 's' }), false)
})

test('a non-JSON response fails closed', async () => {
  stub(async () => new Response('<html>502 Bad Gateway</html>'))
  assert.equal(await verifyTurnstile({ token: 't', secret: 's' }), false)
})

test('a truthy-but-not-true success value fails closed', async () => {
  stub(async () => new Response(JSON.stringify({ success: 'true' })))
  assert.equal(await verifyTurnstile({ token: 't', secret: 's' }), false)
  stub(async () => new Response(JSON.stringify({ success: 1 })))
  assert.equal(await verifyTurnstile({ token: 't', secret: 's' }), false)
})

test('a missing token or secret fails WITHOUT calling out', async () => {
  let called = false
  stub(async () => { called = true; return new Response(JSON.stringify({ success: true })) })
  assert.equal(await verifyTurnstile({ token: '', secret: 's' }), false)
  assert.equal(await verifyTurnstile({ token: 't', secret: '' }), false)
  assert.equal(await verifyTurnstile({ token: 't', secret: undefined }), false)
  assert.equal(called, false, 'must not spend a request when inputs are missing')
})

test('the remote IP is forwarded when present and omitted when not', async () => {
  let body = ''
  stub(async (_url, opts) => { body = opts.body; return new Response(JSON.stringify({ success: true })) })
  await verifyTurnstile({ token: 't', secret: 's', remoteIp: '5.6.7.8' })
  assert.match(body, /remoteip=5\.6\.7\.8/)
  await verifyTurnstile({ token: 't', secret: 's' })
  assert.ok(!/remoteip/.test(body), 'must omit remoteip rather than send an empty one')
})

test('it posts form-encoded to the documented siteverify URL', async () => {
  let seen = null
  stub(async (url, opts) => { seen = { url, opts }; return new Response(JSON.stringify({ success: true })) })
  await verifyTurnstile({ token: 'tok', secret: 'sek' })
  assert.equal(seen.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  assert.equal(seen.opts.method, 'POST')
  assert.equal(seen.opts.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.match(seen.opts.body, /secret=sek/)
  assert.match(seen.opts.body, /response=tok/)
})
