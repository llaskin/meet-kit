// Outbound booking webhook. OFF unless both BOOKING_WEBHOOK_URL (https only)
// and BOOKING_WEBHOOK_SECRET are set; see README "Webhook (optional)".
//
// Three events -- booking.created, booking.cancelled, booking.no_show -- each
// a signed JSON POST:
//
//   { "type", "id", "occurred_at", "booking": { ...whitelisted fields } }
//
//   X-Meet-Signature-256: <lowercase hex HMAC-SHA256(secret, raw body)>
//   X-Meet-Event:         <type>
//   X-Meet-Delivery:      <uuid, unique per attempt>
//
// Delivery is best-effort BY DESIGN: one attempt, a 10 s timeout, the result
// logged. It is fired through waitUntil AFTER the D1 write succeeded, so the
// booking/cancel/no-show response never waits on it and never fails because
// of it. No retries and no dead-letter queue: the receiver is expected to be
// idempotent on `id`, and a missed event is reconciled from the admin page.
//
// `webhookApi` is the same injectable-fetch seam googleApi/turnstileApi use:
// ESM namespace bindings are read-only, so tests capture the outbound request
// by reassigning webhookApi.fetch.
export const webhookApi = { fetch: (...args) => fetch(...args) }

export const WEBHOOK_TIMEOUT_MS = 10_000

// The ONLY booking fields that ever leave the Worker. `notes` is free text the
// visitor typed for the operator's eyes, and `client_ip` exists solely to back
// the abuse caps (and is nulled after 30 days) -- neither has any business in
// a third-party system, so neither is listed here. Add a field by adding it
// to this list; a spread of the D1 row is deliberately not used.
const BOOKING_FIELDS = [
  'id', 'created_at', 'attendee_email', 'attendee_name', 'company', 'duration_min',
  'start_utc', 'end_utc', 'topic', 'meet_url', 'event_id', 'calendar_id',
]

// Per-event stamps the handlers add. Also a whitelist, for the same reason.
const EXTRA_FIELDS = ['cancelled_at', 'cancelled_by', 'no_show_at', 'no_show_by']

export function isWebhookConfigured(env) {
  const url = env?.BOOKING_WEBHOOK_URL
  const secret = env?.BOOKING_WEBHOOK_SECRET
  return typeof url === 'string' && url.startsWith('https://')
    && typeof secret === 'string' && secret.length > 0
}

/** Lowercase hex HMAC-SHA256 of the exact body string, via WebCrypto. */
export async function signBody(secret, rawBody) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The `booking` object of the envelope: whitelisted row fields + known extras. */
export function bookingPayload(row, extra = {}) {
  const out = {}
  for (const k of BOOKING_FIELDS) out[k] = row?.[k] ?? null
  for (const k of EXTRA_FIELDS) if (extra && extra[k] !== undefined) out[k] = extra[k]
  return out
}

/**
 * POST one event. NEVER throws: this runs inside waitUntil on a live request
 * path, and a slow or broken receiver must not take a booking down with it.
 *
 * @returns {Promise<{sent: boolean, status?: number}>} `sent` is true only on
 *   a 2xx reply. `status` is present whenever the receiver answered at all.
 */
export async function sendBookingWebhook(env, { type, booking, extra }) {
  if (!isWebhookConfigured(env)) return { sent: false }

  const id = booking?.id ?? null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
  try {
    // Stringify ONCE: the signature must be over the exact bytes sent.
    const body = JSON.stringify({
      type,
      id,
      occurred_at: new Date().toISOString(),
      booking: bookingPayload(booking, extra),
    })
    const signature = await signBody(env.BOOKING_WEBHOOK_SECRET, body)
    const res = await webhookApi.fetch(env.BOOKING_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Meet-Signature-256': signature,
        'X-Meet-Event': type,
        'X-Meet-Delivery': crypto.randomUUID(),
      },
      body,
      signal: controller.signal,
    })
    // Never log the body: it carries the attendee's details.
    console.log(`[booking-webhook] ${type} ${id} -> ${res.status}`)
    return { sent: res.ok, status: res.status }
  } catch {
    // Timeout (AbortError), DNS/TLS failure, or anything else: one line, no
    // rethrow. The error object is not logged either -- undici error messages
    // can embed the target URL.
    console.log(`[booking-webhook] ${type} ${id} -> error`)
    return { sent: false }
  } finally {
    // A dangling timer would keep the waitUntil context alive for 10 s.
    clearTimeout(timer)
  }
}
