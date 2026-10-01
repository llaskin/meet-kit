// Worker entry: Hono router, the owner gate, and the nightly retention cron.
//
// Security-critical integration point: EVERY admin route must go through the
// Cloudflare Access JWT check in access-jwt.js before it reaches a handler.
import { Hono } from 'hono'
// Import attribute form: works in both Node (tests) and Wrangler's esbuild.
import rawSite from '../meet.config.json' with { type: 'json' }
import { siteConfig } from './core/site-config.js'
import { verifyAccess } from './core/access-jwt.js'
import { purgeExpired } from './core/public-bookings.js'
import { sweep } from './core/rate-limit.js'
import * as publicSlots from './handlers/public-slots.js'
import * as publicBook from './handlers/public-book.js'
import * as publicSite from './handlers/public-site.js'
import * as adminConfig from './handlers/admin-config.js'
import * as adminCalendars from './handlers/admin-calendars.js'
import * as adminBookings from './handlers/admin-bookings.js'
import * as adminCancel from './handlers/admin-cancel.js'
import * as adminConnections from './handlers/admin-connections.js'
import * as oauth from './handlers/oauth.js'

// SITE is the VALIDATED display config (siteConfig(rawSite)), never the raw
// JSON -- a typo'd meet.config.json must never leak un-sanitised strings
// (e.g. a non-https privacyUrl, or an oversized field) to /api/public/site.
const SITE = siteConfig(rawSite)
export const ADMIN_PREFIXES = ['/admin', '/api/admin']

export const app = new Hono()

// Adapt Hono to the Pages-style handler signature the handlers (and their
// ported tests) use.
const run = (handler) => (c) => handler({
  request: c.req.raw,
  env: c.env,
  params: c.req.param(),
  waitUntil: (p) => c.executionCtx.waitUntil(p),
  owner: c.get('owner'),
  site: SITE,
})

// Only ASCII A-Z is folded to lowercase -- never String.prototype.toLowerCase(),
// whose Unicode case-folding maps lookalike characters onto ASCII letters.
// Mirrors access-jwt.js's own asciiLower for the same reason.
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

// Owner gate. Exact segment match: '/admin' and '/admin/...' (same for
// '/api/admin') only, so '/administrator' and '/api/adminx' are NOT treated
// as admin -- they simply fall through to the normal 404 paths, same as any
// other near-miss.
//
// Starts from `c.req.path`, the path Hono's own router matches routes
// against (see node_modules/hono/dist/utils/url.js getPath): the underlying
// Request/URL parser already collapsed dot-segments and stripped the query
// string before Hono ever sees it, and Hono's own decoding percent-decodes
// UNRESERVED octets (e.g. %61 -> 'a') via decodeURI. But `c.req.path` is not
// yet safe to prefix-match directly: Hono's decoder deliberately leaves
// RESERVED octets encoded (%2F stays "%2F", never becomes '/'), and does
// nothing about a doubled '/' from '//admin/' or '/admin//'. Both defeat a
// naive `startsWith('/admin/')` check (confirmed empirically against this
// Hono version -- see tests/worker-routes.test.js's PATH_VARIANTS), and we
// cannot rely on how Cloudflare's own static-asset server will normalise
// such a path in production (it may collapse slashes or decode %2F before
// serving a file) -- so the gate computes its OWN canonical form on top of
// `c.req.path`, deliberately more aggressive than Hono's own decoding:
//
//   1. decodeURIComponent -- unlike decodeURI, this ALSO decodes reserved
//      octets (%2F -> '/', %3F -> '?', ...). A string with malformed or
//      truncated percent-encoding throws here; that is treated as admin
//      (fail CLOSED) rather than let an unparseable path slip through
//      un-gated just because it couldn't be classified.
//   2. collapse runs of '/' to one -- defeats '//admin/' and '/admin///x'.
//   3. ASCII-lowercase -- defeats '/Admin/', '/ADMIN', and other case forms.
//
// decodeURIComponent is a single, non-recursive pass, so a DOUBLE-encoded
// segment (e.g. '/admin%2561/', i.e. '%61' re-escaped as '%2561') decodes
// only one layer, to the literal text '/admin%61/' -- which does NOT match
// '/admin' or '/admin/' -- rather than being decoded all the way through to
// '/admin/a/'. That is intentional: this gate must not itself become a
// double-decode vector in the other direction.
export const isAdminPath = (p) => {
  let decoded
  try {
    decoded = decodeURIComponent(p)
  } catch {
    return true // Malformed percent-encoding: fail closed, treat as admin.
  }
  const canon = asciiLower(decoded.replace(/\/+/g, '/'))
  return ADMIN_PREFIXES.some((pre) => canon === pre || canon.startsWith(`${pre}/`))
}

app.use('*', async (c, next) => {
  if (!isAdminPath(c.req.path)) return next()
  const v = await verifyAccess(c.req.raw, c.env)
  if (!v.ok) return c.json({ error: 'Forbidden' }, 403)
  c.set('owner', v.email)
  return next()
})

app.get('/api/public/site', run(publicSite.onRequestGet))
app.get('/api/public/slots', run(publicSlots.onRequestGet))
app.post('/api/public/book', run(publicBook.onRequestPost))

app.get('/api/admin/config', run(adminConfig.onRequestGet))
app.put('/api/admin/config', run(adminConfig.onRequestPut))
app.get('/api/admin/calendars', run(adminCalendars.onRequestGet))
app.put('/api/admin/calendars', run(adminCalendars.onRequestPut))
app.get('/api/admin/bookings', run(adminBookings.onRequestGet))
app.post('/api/admin/cancel', run(adminCancel.onRequestPost))
app.delete('/api/admin/connections/:id', run(adminConnections.onRequestDelete))
app.get('/admin/oauth/:provider/start', run(oauth.start))
app.get('/admin/oauth/:provider/callback', run(oauth.callback))

// Admin HTML (gated above by the '*' middleware), then everything else, from
// static assets. In production, wrangler.jsonc's `run_worker_first` sends
// '/admin/*' and '/api/*' through this Worker first, so the gate covers the
// admin HTML bundle too, not just admin JSON.
app.get('/admin/*', (c) => c.env.ASSETS.fetch(c.req.raw))
app.get('/admin', (c) => c.env.ASSETS.fetch(c.req.raw))
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

// Generic-error net: a public handler must never let an uncaught exception's
// text reach the visitor (stack traces, DB error strings, upstream Google/
// Zoho error bodies). Returned JSON error Responses from the handlers
// themselves are untouched by this -- onError only fires on a THROW, which
// every handler already guards against for its own known failure modes; this
// is the backstop for the unknown ones.
const PUBLIC_BOOKING_ERROR = 'Unable to book that time. Please try again later.'
// Exported (not just inlined into app.onError) so tests can exercise the
// exact wired handler through a real Hono throw/catch cycle without fighting
// the registration-order rule that makes '/api/*' and '*' below match before
// anything a test could register on the `app` singleton afterward.
export const handleWorkerError = (err, c) => {
  // Never log the request body -- only the error itself (message/stack never
  // contain visitor-submitted data unless a handler deliberately put it
  // there, which none here do).
  console.error('[meet-kit] unhandled error:', err instanceof Error ? (err.stack || err.message) : err)
  const path = c.req.path
  if (path === '/api/public' || path.startsWith('/api/public/')) {
    return c.json({ error: PUBLIC_BOOKING_ERROR }, 500)
  }
  return c.json({ error: 'Internal error' }, 500)
}
app.onError(handleWorkerError)

export default {
  fetch: app.fetch,
  // Nightly retention (wrangler.jsonc triggers.crons). purgeExpired and sweep
  // never throw -- see their own header comments -- but scheduled() must not
  // depend on that to stay safe, so each is also wrapped here.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeExpired(env.DB).catch(() => {}))
    ctx.waitUntil(sweep(env.DB, { windowSeconds: 60 }).catch(() => {}))
  },
}
