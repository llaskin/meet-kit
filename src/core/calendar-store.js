// Every D1 read/write for calendar config, connections and selections.
// Endpoints call these; no endpoint writes SQL inline.

export const DEFAULT_RULES = {
  timezone: 'America/New_York',
  weekdays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  durationMinutes: 30,
  intervalMinutes: 30,
  minNoticeMinutes: 120,
  horizonDays: 21,
  // Free minutes kept on both sides of every existing meeting. 0 keeps the
  // historical back-to-back behaviour; existing deployments change nothing.
  bufferMinutes: 0,
}

export async function getConfig(db) {
  const { results } = await db.prepare('SELECT key, value FROM calendar_config').all()
  const out = {}
  for (const r of results || []) out[r.key] = r.value
  return out
}

export async function setConfig(db, key, value) {
  await db
    .prepare(
      `INSERT INTO calendar_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run()
}

/** Delete one config key. Returns how many rows went (0 or 1). */
export async function deleteConfig(db, key) {
  const r = await db.prepare('DELETE FROM calendar_config WHERE key = ?').bind(key).run()
  return Number(r?.meta?.changes ?? 0)
}

// OAuth state nonces. One row per in-flight consent flow, issued by start and
// DELETED by the first callback that presents it, so a state is single-use.
// The value is the expiry in epoch seconds, used only to sweep abandoned flows.
export const OAUTH_NONCE_PREFIX = 'oauth_nonce:'

export async function recordOAuthNonce(db, nonce, expiresAtSec) {
  await setConfig(db, `${OAUTH_NONCE_PREFIX}${nonce}`, String(expiresAtSec))
}

/**
 * Atomically consume an issued nonce. True only for the ONE caller whose
 * DELETE removed the row: a replay, or a nonce that was never issued, is false.
 */
export async function consumeOAuthNonce(db, nonce) {
  return (await deleteConfig(db, `${OAUTH_NONCE_PREFIX}${nonce}`)) === 1
}

/** Drop nonces for consent flows that were started and never finished. */
export async function purgeExpiredOAuthNonces(db, nowSec) {
  await db
    .prepare(`DELETE FROM calendar_config WHERE key LIKE '${OAUTH_NONCE_PREFIX}%' AND CAST(value AS INTEGER) < ?`)
    .bind(nowSec)
    .run()
}

/** Stored rules overlaid on DEFAULT_RULES. Absent keys keep their default. */
export async function getRules(db) {
  const cfg = await getConfig(db)
  const num = (k, fallback) => (cfg[k] == null || cfg[k] === '' ? fallback : Number(cfg[k]))
  return {
    timezone: cfg.rules_timezone || DEFAULT_RULES.timezone,
    weekdays: cfg.rules_weekdays
      ? cfg.rules_weekdays.split(',').map(Number).filter(Number.isFinite)
      : DEFAULT_RULES.weekdays,
    startTime: cfg.rules_start_time || DEFAULT_RULES.startTime,
    endTime: cfg.rules_end_time || DEFAULT_RULES.endTime,
    durationMinutes: num('rules_duration_minutes', DEFAULT_RULES.durationMinutes),
    intervalMinutes: num('rules_interval_minutes', DEFAULT_RULES.intervalMinutes),
    minNoticeMinutes: num('rules_min_notice_minutes', DEFAULT_RULES.minNoticeMinutes),
    horizonDays: num('rules_horizon_days', DEFAULT_RULES.horizonDays),
    bufferMinutes: num('rules_buffer_minutes', DEFAULT_RULES.bufferMinutes),
  }
}

export const ROLE_WRITE = 'write'
export const ROLE_BUSY = 'busy'

export function connectionId(provider, accountEmail) {
  if (!provider || !accountEmail) {
    // An empty account email would collapse distinct accounts onto one row and
    // could silently overwrite the write connection. Refuse to build the key.
    throw new Error('connectionId requires a provider and a non-empty account email')
  }
  return `${provider}:${accountEmail.toLowerCase()}`
}

export async function getConnectionById(db, id) {
  return db.prepare('SELECT * FROM calendar_connections WHERE connection_id = ?').bind(id).first()
}

/**
 * THE resolver for "which account may create an event".
 *
 * Event creation must go through this function and nothing else. It hard-codes
 * role = 'write', so a busy-only connection can never become a write target no
 * matter what the caller passes. Layer 1 is the partial unique index in
 * schema.sql; layer 3 is the role check in the OAuth callback.
 */
export async function getWriteConnection(db) {
  return db
    .prepare(`SELECT * FROM calendar_connections WHERE role = '${ROLE_WRITE}'`)
    .bind()
    .first()
}

export async function getConnectionsByProvider(db, provider) {
  const { results } = await db
    .prepare('SELECT * FROM calendar_connections WHERE provider = ? ORDER BY connection_id')
    .bind(provider)
    .all()
  return results || []
}

export async function getAllConnections(db) {
  const { results } = await db
    .prepare('SELECT * FROM calendar_connections ORDER BY connection_id')
    .bind()
    .all()
  return results || []
}

export async function saveConnection(db, fields) {
  if (!fields.accountEmail) {
    // Fail closed rather than writing a row with an empty key.
    throw new Error('saveConnection requires accountEmail')
  }
  if (fields.role !== ROLE_WRITE && fields.role !== ROLE_BUSY) {
    throw new Error(`saveConnection: invalid role ${fields.role}`)
  }
  const id = connectionId(fields.provider, fields.accountEmail)
  await db
    .prepare(
      `INSERT INTO calendar_connections
         (connection_id, provider, role, refresh_token, access_token, expires_at,
          account_email, api_host, accounts_host, connected_at, connected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         refresh_token = excluded.refresh_token,
         access_token  = excluded.access_token,
         expires_at    = excluded.expires_at,
         api_host      = excluded.api_host,
         accounts_host = excluded.accounts_host,
         connected_at  = excluded.connected_at,
         connected_by  = excluded.connected_by`,
      // NOTE: role is deliberately absent from the UPDATE clause. Re-connecting
      // an existing account refreshes its tokens but can never change its role.
    )
    .bind(
      id,
      fields.provider,
      fields.role,
      fields.refreshToken,
      fields.accessToken ?? null,
      fields.expiresAt ?? null,
      fields.accountEmail,
      fields.apiHost ?? null,
      fields.accountsHost ?? null,
      new Date().toISOString(),
      fields.connectedBy ?? null,
    )
    .run()
  return id
}

export async function deleteConnection(db, id) {
  await db.prepare('DELETE FROM calendar_connections WHERE connection_id = ?').bind(id).run()
  await db.prepare('DELETE FROM calendar_selections WHERE connection_id = ?').bind(id).run()
}

export async function getSelections(db, connId) {
  const { results } = await db
    .prepare('SELECT calendar_id, name, busy FROM calendar_selections WHERE connection_id = ?')
    .bind(connId)
    .all()
  return results || []
}

/** Upsert a discovered calendar. New calendars default to busy=1 (fail safe). */
export async function upsertSelection(db, connId, calendarId, name) {
  await db
    .prepare(
      `INSERT INTO calendar_selections (connection_id, calendar_id, name, busy)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(connection_id, calendar_id) DO UPDATE SET name = excluded.name`,
    )
    .bind(connId, calendarId, name)
    .run()
}

export async function setSelectionBusy(db, connId, calendarId, busy) {
  await db
    .prepare('UPDATE calendar_selections SET busy = ? WHERE connection_id = ? AND calendar_id = ?')
    .bind(busy ? 1 : 0, connId, calendarId)
    .run()
}

