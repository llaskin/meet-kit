-- meet-kit D1 schema. Apply once:
--   npx wrangler d1 execute meet-kit --remote --file=schema.sql
-- It already includes every migration in migrations/; existing deployments
-- apply new migrations/NNN_*.sql files instead (see DEPLOY-AGENT.md).

-- Key/value settings: rules_*, write_calendar_id, write_calendar_meet,
-- meet_link, internal_attendee_email, zoho_account_email, state_signing_key.
-- NEVER client secrets: those are Worker secrets (see src/handlers/context.js).
CREATE TABLE IF NOT EXISTS calendar_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per connected ACCOUNT. connection_id is '<provider>:<email>'.
-- role 'write' may create events (AT MOST ONE, EVER); 'busy' is read-only.
CREATE TABLE IF NOT EXISTS calendar_connections (
  connection_id TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('write', 'busy')),
  refresh_token TEXT NOT NULL,
  access_token  TEXT,
  expires_at    TEXT,
  account_email TEXT NOT NULL,
  api_host      TEXT,
  accounts_host TEXT,
  connected_at  TEXT NOT NULL,
  connected_by  TEXT
);

-- A second write row is physically impossible, whatever the code does.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_one_write
  ON calendar_connections (role) WHERE role = 'write';

-- Which calendars count as busy, per Google connection. busy defaults to 1:
-- a forgotten checkbox costs a slot, never causes a double-booking.
-- Zoho connections have zero rows by design (merged free/busy endpoint).
CREATE TABLE IF NOT EXISTS calendar_selections (
  connection_id TEXT NOT NULL,
  calendar_id   TEXT NOT NULL,
  name          TEXT,
  busy          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (connection_id, calendar_id)
);

-- Live bookings. UNIQUE (start_utc) makes the same-slot race lose in SQLite.
-- Cancelled rows MOVE to public_bookings_cancelled; never flag them in place,
-- or the slot stays reserved forever.
CREATE TABLE IF NOT EXISTS public_bookings (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  attendee_email  TEXT NOT NULL,
  cap_identity    TEXT NOT NULL,
  attendee_name   TEXT,
  company         TEXT,
  notes           TEXT,
  duration_min    INTEGER NOT NULL,
  start_utc       TEXT NOT NULL,
  end_utc         TEXT NOT NULL,
  event_id        TEXT,
  meet_url        TEXT,
  client_ip       TEXT,
  calendar_id     TEXT,
  meet_url_source TEXT CHECK (meet_url_source IN ('unique', 'fixed')),
  topic           TEXT,
  -- Set by the admin "Mark no-show" action (POST /api/admin/no-show). Rows
  -- stay live: a no-show is a fact about a meeting, not a cancellation.
  no_show_at      TEXT,
  no_show_by      TEXT,
  UNIQUE (start_utc)
);
CREATE INDEX IF NOT EXISTS idx_public_bookings_cap ON public_bookings (cap_identity, created_at);
CREATE INDEX IF NOT EXISTS idx_public_bookings_ip  ON public_bookings (client_ip, created_at);

CREATE TABLE IF NOT EXISTS public_bookings_cancelled (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  attendee_email  TEXT NOT NULL,
  cap_identity    TEXT NOT NULL,
  attendee_name   TEXT,
  company         TEXT,
  notes           TEXT,
  duration_min    INTEGER NOT NULL,
  start_utc       TEXT NOT NULL,
  end_utc         TEXT NOT NULL,
  event_id        TEXT,
  meet_url        TEXT,
  client_ip       TEXT,
  calendar_id     TEXT,
  meet_url_source TEXT,
  topic           TEXT,
  no_show_at      TEXT,
  no_show_by      TEXT,
  cancelled_at    TEXT NOT NULL,
  cancelled_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pbc_cap ON public_bookings_cancelled (cap_identity, created_at);
CREATE INDEX IF NOT EXISTS idx_pbc_ip  ON public_bookings_cancelled (client_ip, created_at);
-- start_utc also needs its own index: the nightly retention sweep
-- (src/core/public-bookings.js: `DELETE FROM public_bookings_cancelled
-- WHERE start_utc < ?`) filters on it alone, with no cap_identity/client_ip
-- in the predicate, so idx_pbc_cap/idx_pbc_ip don't serve that scan.
CREATE INDEX IF NOT EXISTS idx_pbc_start ON public_bookings_cancelled (start_utc);

-- Fixed-window request counters for the public slots endpoint.
CREATE TABLE IF NOT EXISTS rate_counters (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_counters_window ON rate_counters (window_start);
