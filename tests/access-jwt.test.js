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

async function token({
  email = 'owner@example.com', aud = AUD, iss = TEAM, exp = '5m', nbf, kid = 'k1', key = privateKey,
  omitEmail = false, omitExp = false,
} = {}) {
  const claims = omitEmail ? {} : { email }
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuer(iss).setAudience(aud).setIssuedAt()
  if (nbf !== undefined) builder = builder.setNotBefore(nbf)
  if (!omitExp) builder = builder.setExpirationTime(exp)
  return builder.sign(key)
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

test('accepted: aud as an array (Cloudflare\'s real token shape)', async () => {
  const r = await verifyAccess(req(await token({ aud: [AUD, 'other'] })), ENV, { getKey })
  assert.equal(r.ok, true)
})

test('rejected: email claim is an array, not a string', async () => {
  const r = await verifyAccess(req(await token({ email: ['owner@example.com'] })), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'wrong_email')
})

test('rejected: Kelvin sign U+212A lowercases to ASCII k, spoofing the owner email', async () => {
  // String.prototype.toLowerCase() Unicode-folds U+212A KELVIN SIGN to ASCII
  // 'k', so a naive `.toLowerCase()` comparison would treat this token's email
  // as equal to 'kate@example.com'. The ASCII-printable guard must reject it
  // outright before any case folding happens.
  const kelvinEmail = 'Kate@example.com'
  const kelvinEnv = { ...ENV, OWNER_EMAIL: 'kate@example.com' }
  const r = await verifyAccess(req(await token({ email: kelvinEmail })), kelvinEnv, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'wrong_email')
})

test('rejected: email claim missing entirely (requiredClaims catches it)', async () => {
  const r = await verifyAccess(req(await token({ omitEmail: true })), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('rejected: email claim is a number', async () => {
  // Not a string, so it fails the same type-check as the array case above.
  // We report 'wrong_email' (not 'invalid') because this is OUR validation
  // rejecting a malformed claim value, the same path every other non-string
  // email takes — jose itself has no opinion on a non-reserved "email" claim's
  // type, so nothing here is a jose-level verification failure.
  const r = await verifyAccess(req(await token({ email: 42 })), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'wrong_email')
})

test('rejected: no exp claim (requiredClaims catches it; jose does not expire a token missing exp)', async () => {
  const r = await verifyAccess(req(await token({ omitExp: true })), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('rejected: nbf 60s in the future (clockTolerance stays 0, fails closed)', async () => {
  const future = Math.floor(Date.now() / 1000) + 60
  const r = await verifyAccess(req(await token({ nbf: future })), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('rejected: iss with a trailing slash does not match the normalised team domain', async () => {
  const r = await verifyAccess(req(await token({ iss: `${TEAM}/` })), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('rejected: iss uppercased does not match the normalised (lowercased) team domain', async () => {
  const r = await verifyAccess(req(await token({ iss: TEAM.toUpperCase() })), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('accepted: OWNER_EMAIL with surrounding whitespace/newline is trimmed', async () => {
  const r = await verifyAccess(req(await token()), { ...ENV, OWNER_EMAIL: '  Owner@Example.com\n' }, { getKey })
  assert.equal(r.ok, true)
})

test('rejected: OWNER_EMAIL set to a comma-joined list does not match any single email', async () => {
  const r = await verifyAccess(req(await token()), { ...ENV, OWNER_EMAIL: 'owner@example.com,other@example.com' }, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'wrong_email')
})

test('env normalisation accepted: ACCESS_TEAM_DOMAIN with uppercase scheme/host and trailing slash', async () => {
  const r = await verifyAccess(req(await token()), { ...ENV, ACCESS_TEAM_DOMAIN: 'HTTPS://Team.CloudflareAccess.com/' }, { getKey })
  assert.equal(r.ok, true)
})

test('env normalisation accepted: ACCESS_TEAM_DOMAIN with http scheme is forced to https', async () => {
  const r = await verifyAccess(req(await token()), { ...ENV, ACCESS_TEAM_DOMAIN: 'http://team.cloudflareaccess.com' }, { getKey })
  assert.equal(r.ok, true)
})

test('fails closed: OWNER_EMAIL is a non-string (array)', async () => {
  const r = await verifyAccess(req(await token()), { ...ENV, OWNER_EMAIL: ['owner@example.com'] }, { getKey })
  assert.deepEqual(r, { ok: false, reason: 'not_configured' })
})

test('remote JWKS path: a 500 from the certs endpoint surfaces as invalid', async () => {
  const originalFetch = globalThis.fetch
  const team = 'https://team-500.example.test'
  let requestedUrl
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    return new Response('', { status: 500 })
  }
  try {
    const r = await verifyAccess(req(await token()), { ...ENV, ACCESS_TEAM_DOMAIN: team })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'invalid')
    assert.equal(requestedUrl, `${team}/cdn-cgi/access/certs`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('remote JWKS path: a thrown fetch error surfaces as invalid', async () => {
  const originalFetch = globalThis.fetch
  const team = 'https://team-throw.example.test'
  let requestedUrl
  globalThis.fetch = async (url) => {
    requestedUrl = String(url)
    throw new Error('network down')
  }
  try {
    const r = await verifyAccess(req(await token()), { ...ENV, ACCESS_TEAM_DOMAIN: team })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'invalid')
    assert.equal(requestedUrl, `${team}/cdn-cgi/access/certs`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejected: two Cf-Access-Jwt-Assertion headers (combined by Headers.get) fail to parse', async () => {
  const headers = new Headers()
  headers.append('Cf-Access-Jwt-Assertion', await token())
  headers.append('Cf-Access-Jwt-Assertion', await token())
  const r = await verifyAccess(new Request('https://x.test/api/admin/config', { headers }), ENV, { getKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('rejected: getKey throws a plain Error', async () => {
  const throwingGetKey = () => { throw new Error('boom') }
  const r = await verifyAccess(req(await token()), ENV, { getKey: throwingGetKey })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid')
})

test('verifyAccess(undefined, env) does not throw', async () => {
  const r = await verifyAccess(undefined, ENV, { getKey })
  assert.equal(r.ok, false)
})
