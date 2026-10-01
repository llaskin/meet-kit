import * as store from '../core/calendar-store.js'
import { computeSlots } from '../core/slots.js'
import { utcToZonedParts } from '../core/tz.js'
import { PUBLIC_DURATIONS, coerceDuration } from '../core/durations.js'
import { gatherBusy } from '../core/busy.js'
import { readCache, writeCache } from '../core/public-cache.js'
import { consume, sweep } from '../core/rate-limit.js'
import { loadCfg } from './context.js'

const json = (status, body) => Response.json(body, { status })

// Per Cloudflare LOCATION, not globally -- both the cache and the counter are
// edge-local. These bound the fan-out reaching Google and Zoho, not the number
// of humans served: a cache HIT costs neither.
const MISS_LIMIT = 20
const MISS_WINDOW_SECONDS = 60

/**
 * Public availability.
 *
 * Deliberately NOT the authenticated handler with a flag: that one returns
 * connection ids, account emails and raw upstream error text, plus operator
 * remediation advice. This returns exactly three keys and never explains a
 * failure. Any internal problem -- no connection, unreadable calendar, expired
 * token, missing config, an exception -- collapses into an empty slot list.
 */
export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url)
  const durationMinutes = coerceDuration(url.searchParams.get('duration'), PUBLIC_DURATIONS)

  // A cache HIT costs a lookup and nothing else: no D1, no rate limiter, no
  // upstream call. That is what makes this affordable to serve publicly.
  const cached = await readCache(request, durationMinutes)
  if (cached) return cached

  try {
    const db = env.DB

    // The limiter guards the EXPENSIVE path only, which is why it sits after
    // the cache read rather than at the top. In steady state that is roughly
    // one counter write per TTL per location instead of one per request.
    //
    // Over the limit we serve an empty grid rather than a 429: the visitor sees
    // "no times available" and retries, while the operator's Google and Zoho
    // quota -- whose exhaustion would fail the INTERNAL tool closed too -- is
    // protected. Refusing loudly would tell an attacker the limiter exists.
    const gate = await consume(db, {
      bucket: `slots:${durationMinutes}`,
      limit: MISS_LIMIT,
      windowSeconds: MISS_WINDOW_SECONDS,
    })
    if (!gate.allowed) return json(200, { slots: [], timezone: store.DEFAULT_RULES.timezone, durationMinutes })
    if (waitUntil) {
      waitUntil(sweep(db, { windowSeconds: MISS_WINDOW_SECONDS }))
    }
    const cfg = await loadCfg(db, env)
    const rules = await store.getRules(db)
    const now = Date.now()
    const p = utcToZonedParts(now, rules.timezone)
    const today = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
    // `from` is deliberately IGNORED on the public endpoint. computeSlots
    // loops horizonDays forward from fromDay, so honouring it turns the 21-day
    // horizon into a window an anonymous caller can slide anywhere -- probing
    // the operator's free/busy in 2031. The shipped client never sends it.
    const fromDay = today

    // No connection at all is unknown availability too -- the authenticated
    // handler surfaces this as a 400 telling the operator to connect one; the
    // public handler must fail closed on it exactly like any other failure,
    // silently.
    const connections = await store.getAllConnections(db)
    if (connections.length === 0) return json(200, { slots: [], timezone: rules.timezone, durationMinutes })

    const { busy, errors } = await gatherBusy({ db, cfg, fromDay, rules })
    // Fail closed, SILENTLY. Unknown availability must never be offered, and
    // the visitor is told nothing about why.
    if (errors.length > 0) return json(200, { slots: [], timezone: rules.timezone, durationMinutes })

    const body = json(200, {
      slots: computeSlots({ busy, rules: { ...rules, durationMinutes }, now, fromDay }),
      timezone: rules.timezone,
      durationMinutes,
    })
    // Only a GOOD grid is cached. Caching a fail-closed empty list would pin
    // "no availability" in front of every visitor for the whole TTL because one
    // transient calendar error happened to land first.
    return await writeCache(request, durationMinutes, body, { waitUntil })
  } catch {
    return json(200, { slots: [], timezone: store.DEFAULT_RULES.timezone, durationMinutes })
  }
}
