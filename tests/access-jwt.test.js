import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose'
import { verifyAccess } from '../src/core/access-jwt.js'

const TEAM = 'https://team.cloudflareaccess.com'
const AUD = 'aud-tag-123'
const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: 'Owner@Example.com' }

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
const getKey = createLocalJWKSet({ keys: [jwk] })

async function token({ email = 'owner@example.com', aud = AUD, iss = TEAM, exp = '5m', kid = 'k1', key = privateKey } = {}) {
  return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key)
}
const req = (t) => new Request('https://x.test/api/admin/config', t ? { headers: { 'Cf-Access-Jwt-Assertion': t } } : {})

test('valid owner token is accepted (email compared case-insensitively)', async () => {
  const r = await verifyAccess(req(await token()), ENV, { getKey })
  assert.deepEqual(r, { ok: true, email: 'owner@example.com' })
})

// Each case asserts the specific `reason` the implementation reports, not just
// `ok === false` — a case must fail for ITS named cause, not an unrelated one.
// `verifyAccess` distinguishes `wrong_email` (signature/claims verified, email
// mismatched) from `invalid` (jose's jwtVerify threw: bad signature, wrong
// aud/iss, expired, or no matching JWKS key) — every other case below collapses
// into `invalid` because jose's single jwtVerify call rejects all of them the
// same way; `wrong_email` is the one case the implementation checks itself.
for (const [name, opts, reason] of [
  ['wrong audience', { aud: 'other' }, 'invalid'],
  ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }, 'invalid'],
  ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }, 'invalid'],
  ['wrong email', { email: 'someone@example.com' }, 'wrong_email'],
  ['unknown kid', { kid: 'k2' }, 'invalid'],
]) {
  test(`rejected: ${name}`, async () => {
    const r = await verifyAccess(req(await token(opts)), ENV, { getKey })
    assert.equal(r.ok, false)
    assert.equal(r.reason, reason)
  })
}

test('rejected: signed by a different key', async () => {
  const other = await generateKeyPair('RS256')
  const r = await verifyAccess(req(await token({ key: other.privateKey })), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('rejected: alg none', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const t = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ email: 'owner@example.com', aud: AUD, iss: TEAM, exp: 9999999999 })}.`
  const r = await verifyAccess(req(t), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('rejected: HS256', async () => {
  const t = await new SignJWT({ email: 'owner@example.com' }).setProtectedHeader({ alg: 'HS256', kid: 'k1' })
    .setIssuer(TEAM).setAudience(AUD).setExpirationTime('5m').sign(new TextEncoder().encode('x'.repeat(32)))
  const r = await verifyAccess(req(t), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('rejected: missing header', async () => {
  assert.deepEqual(await verifyAccess(req(), ENV, { getKey }), { ok: false, reason: 'missing' })
})

for (const k of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'OWNER_EMAIL']) {
  test(`fails closed when ${k} is unset`, async () => {
    const r = await verifyAccess(req(await token()), { ...ENV, [k]: '' }, { getKey })
    assert.deepEqual(r, { ok: false, reason: 'not_configured' })
  })
}

test('team domain without scheme is normalised', async () => {
  const r = await verifyAccess(req(await token()), { ...ENV, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com/' }, { getKey })
  assert.equal(r.ok, true)
})
