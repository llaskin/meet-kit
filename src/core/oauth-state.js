// HMAC-SHA256 signed, expiring OAuth `state`. WebCrypto is available on Workers
// and in Node 18+, so the same code runs in tests and in production.

function b64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

async function hmac(message, key) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
  return b64urlEncode(String.fromCharCode(...new Uint8Array(sig)))
}

/** Constant-time-ish comparison. Avoids leaking where two signatures diverge. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function signState(payload, key, { now = Date.now(), ttlSeconds = 600 } = {}) {
  const body = { ...payload, exp: Math.floor(now / 1000) + ttlSeconds }
  const encoded = b64urlEncode(JSON.stringify(body))
  return `${encoded}.${await hmac(encoded, key)}`
}

export async function verifyState(state, key, { now = Date.now() } = {}) {
  const parts = String(state || '').split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'malformed' }

  const [encoded, sig] = parts
  let expected
  try {
    expected = await hmac(encoded, key)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (!safeEqual(sig, expected)) return { ok: false, error: 'bad signature' }

  let payload
  try {
    payload = JSON.parse(b64urlDecode(encoded))
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (!payload.exp || Math.floor(now / 1000) > payload.exp) return { ok: false, error: 'expired' }

  return { ok: true, payload }
}

/**
 * Read the state signing key from config, generating and persisting one on
 * first use. Keeps the operator from having to run a wrangler secret command.
 */
export async function getOrCreateStateKey(db, store) {
  const cfg = await store.getConfig(db)
  if (cfg.state_signing_key) return cfg.state_signing_key
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const key = b64urlEncode(String.fromCharCode(...bytes))
  await store.setConfig(db, 'state_signing_key', key)
  return key
}
