// Shared token-refresh + conflict-check logic for booking an event.
//
// Extracted VERBATIM from functions/api/calendar/book.js so the authenticated
// and public booking endpoints share ONE implementation of the fail-closed
// conflict check -- a second copy is exactly how a safety property silently
// rots. Both handlers import from here; neither defines its own copy.
import * as store from './calendar-store.js'
import * as google from './google-calendar.js'
import * as zoho from './zoho-calendar.js'
import { mergeBusy } from './slots.js'

/** Same token freshness rule as the slots endpoint: 60s skew guard. */
export async function accessTokenFor(db, cfg, conn) {
  const expiresAt = conn.expires_at ? Date.parse(conn.expires_at) : 0
  if (conn.access_token && expiresAt - Date.now() > 60_000) return conn.access_token

  const isGoogle = conn.provider === 'google'
  const fresh = isGoogle
    ? await google.refreshAccessToken({
        clientId: cfg.google_client_id, clientSecret: cfg.google_client_secret,
        refreshToken: conn.refresh_token,
      })
    : await zoho.refreshAccessToken({
        clientId: cfg.zoho_client_id, clientSecret: cfg.zoho_client_secret,
        refreshToken: conn.refresh_token,
        accountsHost: conn.accounts_host || 'https://accounts.zoho.com',
      })
  await store.saveConnection(db, {
    provider: conn.provider, role: conn.role, refreshToken: conn.refresh_token,
    accessToken: fresh.accessToken, expiresAt: new Date(fresh.expiresAt).toISOString(),
    accountEmail: conn.account_email, apiHost: conn.api_host,
    accountsHost: conn.accounts_host, connectedBy: conn.connected_by,
  })
  return fresh.accessToken
}

/**
 * Is this exact window still free across every connected calendar?
 *
 * Runs immediately before the event is created. Slots are computed when the
 * modal opens; a modal left open for ten minutes could otherwise book over a
 * meeting accepted in the meantime. This narrows the window to about a second
 * rather than closing it -- see the spec's Phase 2 decisions.
 */
export async function stillFree(db, cfg, startIso, endIso) {
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  const busy = []

  for (const conn of await store.getAllConnections(db)) {
    const token = await accessTokenFor(db, cfg, conn)
    if (conn.provider === 'google') {
      const sel = await store.getSelections(db, conn.connection_id)
      const ids = sel.filter((s) => s.busy === 1).map((s) => s.calendar_id)
      if (ids.length === 0) continue
      const r = await google.freeBusy(token, ids, startIso, endIso)
      // Fail closed, exactly as the slots endpoint does: an unreadable calendar
      // means unknown availability, and booking anyway is the double-booking
      // this tool exists to prevent.
      if (r.errors.length) return { free: false, reason: 'unreadable' }
      busy.push(...r.busy)
    } else {
      const r = await zoho.freeBusy({
        accessToken: token, apiHost: conn.api_host || 'https://calendar.zoho.com',
        accountEmail: conn.account_email, timeMin: startIso, timeMax: endIso,
      })
      if (r.errors.length) return { free: false, reason: 'unreadable' }
      busy.push(...r.busy)
    }
  }

  // Strict overlap, matching lib/slots.js: a meeting ending exactly when the
  // slot starts is not a conflict.
  const clash = mergeBusy(busy).some((b) => start < b.end && end > b.start)
  return { free: !clash, reason: clash ? 'taken' : '' }
}
