// Verifies the Cf-Access-Jwt-Assertion header Cloudflare Access adds to every
// request it lets through. This is the actual admin guarantee: Access alone
// does not protect the *.workers.dev hostname or a misconfigured path, so the
// Worker re-checks signature, issuer, audience, expiry and owner email itself.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
import { jwtVerify, createRemoteJWKSet } from 'jose'

const remoteSets = new Map()

// Only ASCII A-Z is folded to lowercase here — never String.prototype.toLowerCase(),
// whose Unicode case-folding maps lookalike characters (e.g. U+212A KELVIN SIGN) onto
// ASCII letters, which would let a visually-identical email spoof the owner check.
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
// The token's email must be plain, unambiguous ASCII before we compare it at all —
// printable ASCII excludes space, so this also rejects leading/trailing whitespace.
const ASCII_PRINTABLE = /^[\x21-\x7e]+$/

export function normaliseTeamDomain(raw) {
  if (typeof raw !== 'string') return ''
  const host = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase()
  return host ? `https://${host}` : ''
}

function remoteKeySet(team) {
  if (!remoteSets.has(team)) remoteSets.set(team, createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`)))
  return remoteSets.get(team)
}

export async function verifyAccess(request, env, { getKey } = {}) {
  // Env values must be actual strings — not arrays/numbers/objects that would
  // otherwise coerce (via String()) into something that happens to compare equal.
  if (typeof env?.ACCESS_TEAM_DOMAIN !== 'string' || typeof env?.ACCESS_AUD !== 'string' || typeof env?.OWNER_EMAIL !== 'string') {
    return { ok: false, reason: 'not_configured' }
  }
  const team = normaliseTeamDomain(env.ACCESS_TEAM_DOMAIN)
  const aud = env.ACCESS_AUD.trim()
  const owner = asciiLower(env.OWNER_EMAIL.trim())
  if (!team || !aud || !owner) return { ok: false, reason: 'not_configured' }

  try {
    const token = request.headers.get('Cf-Access-Jwt-Assertion')
    if (!token) return { ok: false, reason: 'missing' }

    const { payload } = await jwtVerify(token, getKey || remoteKeySet(team), {
      issuer: team,
      audience: aud,
      algorithms: ['RS256'],
      // 'exp' is required: without this, a token that simply omits the claim
      // is never treated as expired. clockTolerance is left at its 0 default
      // intentionally — an expired or not-yet-valid (nbf) token fails closed,
      // never sliding by any leeway.
      requiredClaims: ['exp', 'email'],
    })

    const email = payload.email
    if (typeof email !== 'string' || !ASCII_PRINTABLE.test(email)) return { ok: false, reason: 'wrong_email' }
    const normalisedEmail = asciiLower(email)
    if (normalisedEmail !== owner) return { ok: false, reason: 'wrong_email' }
    return { ok: true, email: normalisedEmail }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
