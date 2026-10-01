// Shared token-refresh logic for booking an event.
//
// A single implementation that every booking path imports from, rather than
// each one refreshing provider tokens its own way -- a second copy is exactly
// how a safety property (token freshness, provider-specific refresh errors)
// silently rots.
import * as store from './calendar-store.js'
import * as google from './google-calendar.js'
import * as zoho from './zoho-calendar.js'

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
