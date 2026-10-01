// Server-side Turnstile validation.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// Mirrors functions/api/blueprint-intake.ts on the main site. The client widget
// alone is worthless -- a token is only meaningful once Cloudflare confirms it.
//
// Injectable fetch, matching googleApi/zohoCalApi: ESM namespace bindings are
// read-only, so tests cannot reassign a plain imported function.
export const turnstileApi = { fetch: (...args) => fetch(...args) }

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * @returns true ONLY when Cloudflare affirmatively confirms the token.
 * Every other outcome -- invalid, malformed, unreachable, unconfigured -- is
 * false. Booking without verification is worse than refusing to book.
 */
export async function verifyTurnstile({ token, secret, remoteIp = '' }) {
  // No token or no configured secret is a refusal, not an exception, and must
  // not spend a request. A missing secret means the project is misconfigured.
  if (!token || !secret) return false

  const form = new URLSearchParams({ secret, response: token })
  if (remoteIp) form.set('remoteip', remoteIp)

  try {
    const res = await turnstileApi.fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const data = await res.json().catch(() => null)
    // Strict === true: a truthy "true" string or 1 must not pass.
    return data?.success === true
  } catch {
    // FAIL CLOSED: an outage reaching Cloudflare must not open the gate.
    return false
  }
}
