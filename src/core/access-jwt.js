// Verifies the Cf-Access-Jwt-Assertion header Cloudflare Access adds to every
// request it lets through. This is the actual admin guarantee: Access alone
// does not protect the *.workers.dev hostname or a misconfigured path, so the
// Worker re-checks signature, issuer, audience, expiry and owner email itself.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
import { jwtVerify, createRemoteJWKSet } from 'jose'

const remoteSets = new Map()

export function normaliseTeamDomain(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  return /^https?:\/\//.test(s) ? s : `https://${s}`
}

function remoteKeySet(team) {
  if (!remoteSets.has(team)) remoteSets.set(team, createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`)))
  return remoteSets.get(team)
}

export async function verifyAccess(request, env, { getKey } = {}) {
  const team = normaliseTeamDomain(env?.ACCESS_TEAM_DOMAIN)
  const aud = String(env?.ACCESS_AUD || '').trim()
  const owner = String(env?.OWNER_EMAIL || '').trim().toLowerCase()
  if (!team || !aud || !owner) return { ok: false, reason: 'not_configured' }

  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return { ok: false, reason: 'missing' }

  try {
    const { payload } = await jwtVerify(token, getKey || remoteKeySet(team), {
      issuer: team,
      audience: aud,
      algorithms: ['RS256'],
    })
    const email = String(payload.email || '').toLowerCase()
    if (email !== owner) return { ok: false, reason: 'wrong_email' }
    return { ok: true, email }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
