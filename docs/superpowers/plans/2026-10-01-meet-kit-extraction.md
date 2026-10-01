# meet-kit Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Subagents must not commit or push**; the orchestrating session verifies and commits.

**Goal:** Turn the AIFMB cold-call sheets' `/meet` booking page into `meet-kit`, a self-hosted Cloudflare Worker template that anyone can deploy against their own calendars.

**Architecture:** One Cloudflare Worker with static assets and a Hono router. Pure booking logic lives in `src/core/` (ported from the source `lib/` with no Cloudflare APIs). Request handlers in `src/handlers/` keep the source's Pages-style `({ request, env, waitUntil, params })` signature, so the ported handler tests carry over almost unchanged. `src/worker.js` adapts Hono to that signature, gates every admin route with a Cloudflare Access JWT check, and runs a nightly retention cron.

**Tech Stack:** Cloudflare Workers + static assets + D1, Hono 4, jose 6, `node:test` + `node:sqlite` + jsdom for tests, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-10-01-meet-kit-extraction-design.md` (approved 2026-10-01).

**Source (read-only, never modified by this plan):**
`SRC=/Users/leolaskin/Development/AIfindMyBusiness/scripts/cloudflare-cold-call-sheets`

**Repo:** `REPO=/Users/leolaskin/Development/meet-kit` (private `llaskin/meet-kit`, branch `main`).

---

## Ground truth established while planning (2026-10-01)

- **Baseline:** 220/220 pass across the 20 source test files that move (run 12:05:41–12:05:46 ET, Node v25.6.1). Task 0 records the per-file counts.
- **Secrets:** OAuth client secrets are in D1 `calendar_config` today. The source reads them as `cfg.google_client_secret` etc. in `lib/busy.js`, `lib/booking-core.js` and the OAuth handlers.
  - meet-kit keeps that `cfg` key shape, but `loadCfg()` (Task 5) overlays the values from `env` and deletes any copy found in D1. Core code stays unchanged.
- **Duplicate code:** `accessTokenFor` is defined twice in the source: privately in `lib/busy.js` and exported from `lib/booking-core.js`. meet-kit keeps one copy (Task 4).
- **Booking-calendar setting:** `write_calendar_id` is read in the source (`functions/api/public/book.js:168`, `lib/cancel-booking.js:45`) but **no UI ever sets it**; it always defaults to `'primary'`.
  - meet-kit sets it in the OAuth callback and lets the admin change it (Tasks 9 and 10).
- **Unique-row race:** in the source, a UNIQUE `start_utc` race at `functions/api/public/book.js` returns 409 but **leaves the duplicate Google event in place**. The spec requires deleting it (Task 8).
- **Pages that can't come over as-is:**
  - `public/meet.html` hardcodes the Turnstile site key `0x4AAAAAAE0VFxAQIP8jtMZM` and AIFMB links. meet-kit loads them from `/api/public/site` instead (Task 11).
  - `public/admin/index.html` is the Clerk login page and is **not** ported.
  - `public/calendar-config.html` becomes the new `public/admin/index.html` (Task 11).
- **Worker routing:** Workers static assets support `run_worker_first` as an array of route patterns ([docs](https://developers.cloudflare.com/workers/static-assets/binding/)). meet-kit uses `["/admin/*", "/api/*"]` so admin HTML is gated by the Worker too.

## File map

| File | Responsibility |
|---|---|
| `package.json` | scripts + deps (`hono`, `jose`; dev: `wrangler`, `jsdom`) |
| `wrangler.jsonc` | Worker config: assets, D1 binding `DB`, vars, nightly cron |
| `meet.config.json` | owner-facing display settings (name, title, legal links, colours) |
| `schema.sql` | single combined D1 schema |
| `src/core/*.js` | pure logic ported from `$SRC/lib` + new `access-jwt.js`, `video-link.js`, `site-config.js` |
| `src/handlers/context.js` | `loadCfg(db, env)`: D1 config with env secrets overlaid |
| `src/handlers/public-slots.js` | `GET /api/public/slots` |
| `src/handlers/public-book.js` | `POST /api/public/book` |
| `src/handlers/public-site.js` | `GET /api/public/site` (display config + Turnstile site key) |
| `src/handlers/admin-config.js` | `GET/PUT /api/admin/config` |
| `src/handlers/admin-calendars.js` | `GET/PUT /api/admin/calendars` |
| `src/handlers/admin-bookings.js` | `GET /api/admin/bookings` |
| `src/handlers/admin-cancel.js` | `POST /api/admin/cancel` |
| `src/handlers/oauth.js` | `GET /admin/oauth/:provider/start` and `/callback` |
| `src/worker.js` | Hono app, owner gate, asset passthrough, `scheduled()` |
| `public/` | `meet.html`, `meet.js`, `picker.js`, `admin/index.html`, `admin/admin.js`, `admin/bookings.html`, `admin/bookings.js`, `_headers` |
| `scripts/port-test.mjs` | one-shot rewriter for ported test files |
| `tests/helpers/d1.js` | real-SQLite D1 adapter loading `schema.sql` |
| `tests/*.test.js` | ported + new tests |
| `README.md`, `DEPLOY-AGENT.md`, `CLAUDE.md`, `LICENSE` | docs |

Throughout: run tests with `npm test` (= `node --test tests/`). Print `date '+%H:%M:%S'` before and after every suite run.

---

### Task 0: Record the per-file baseline

**Files:** Create `docs/baseline-2026-10-01.md`

- [ ] **Step 1: Run each moving source test file on its own and record the pass count**

```bash
SRC=/Users/leolaskin/Development/AIfindMyBusiness/scripts/cloudflare-cold-call-sheets
cd "$SRC"
date '+start %H:%M:%S'
for f in slots tz durations google-calendar google-delete-event zoho-calendar calendar-store \
  oauth-state rate-limit turnstile public-bookings-store public-cache cancel-booking \
  cancellation-store public-slots-api public-book-api meet-page meet-duration-grid \
  calendar-oauth calendar-calendars-api; do
  n=$(node --test "tests/$f.test.js" 2>&1 | awk '/^ℹ pass/{print $3}')
  echo "| $f | $n |"
done
date '+end %H:%M:%S'
```

Expected: 20 rows summing to 220.

- [ ] **Step 2: Save the table**

Write `/Users/leolaskin/Development/meet-kit/docs/baseline-2026-10-01.md`:

```markdown
# Source test baseline (2026-10-01)

Source: AIfindMyBusiness `scripts/cloudflare-cold-call-sheets`, Node v25.6.1. Total 220/220.

| Test file | Pass |
|---|---|
<paste the 20 rows from Step 1>

Each ported file must match its count, or the difference is explained in the "Port notes" column added in Task 3/4/8/9.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/leolaskin/Development/meet-kit
git add docs/baseline-2026-10-01.md
git commit -m "docs: record source test baseline for the port"
```

---

### Task 1: Scaffold the project

**Files:** Create `package.json`, `wrangler.jsonc`, `meet.config.json`, `LICENSE`, `tests/helpers/d1.js`, `tests/scaffold.test.js`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "meet-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22.5" },
  "scripts": {
    "test": "node --test tests/",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "db:apply": "wrangler d1 execute meet-kit --remote --file=schema.sql",
    "db:apply:local": "wrangler d1 execute meet-kit --local --file=schema.sql"
  },
  "dependencies": {
    "hono": "^4.13.12",
    "jose": "^6.2.12"
  },
  "devDependencies": {
    "jsdom": "^26.0.0",
    "wrangler": "^4.145.0"
  }
}
```

`node:sqlite` needs Node 22.5+, hence `engines`.

- [ ] **Step 2: Install**

Run: `cd /Users/leolaskin/Development/meet-kit && npm install`
Expected: `package-lock.json` created, no errors.

- [ ] **Step 3: Write `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "meet-kit",
  "main": "src/worker.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "404-page",
    // Admin pages and every API route go through the Worker first, so the
    // Access JWT check covers admin HTML too, not just admin JSON.
    "run_worker_first": ["/admin/*", "/api/*"]
  },
  "d1_databases": [
    // DEPLOY-AGENT.md step 3 replaces REPLACE_WITH_D1_ID.
    { "binding": "DB", "database_name": "meet-kit", "database_id": "REPLACE_WITH_D1_ID" }
  ],
  "vars": {
    // All non-secret. Secrets (GOOGLE_CLIENT_SECRET, ZOHO_CLIENT_SECRET,
    // TURNSTILE_SECRET_KEY) are set with `wrangler secret put`, never here.
    "OWNER_EMAIL": "",
    "GOOGLE_CLIENT_ID": "",
    "ZOHO_CLIENT_ID": "",
    "TURNSTILE_SITE_KEY": "",
    "ACCESS_TEAM_DOMAIN": "",
    "ACCESS_AUD": ""
  },
  "triggers": { "crons": ["17 7 * * *"] }
}
```

- [ ] **Step 4: Write `meet.config.json`**

```json
{
  "displayName": "Your Name",
  "pageTitle": "Book a call",
  "pageSubtitle": "Pick a time that works for you. You'll get a calendar invite with a video link.",
  "eventTitle": "Intro call",
  "privacyUrl": "",
  "termsUrl": "",
  "accentColor": "#0b6cff"
}
```

- [ ] **Step 5: Write `LICENSE`** (MIT, holder "Leo Laskin", year 2026)

```text
MIT License

Copyright (c) 2026 Leo Laskin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 6: Write `tests/helpers/d1.js`**

```js
// Real-SQLite stand-in for a D1 binding, loading the project's one schema.sql.
// Mirrors the adapter the source tests defined inline, plus batch().
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SCHEMA = readFileSync(fileURLToPath(new URL('../../schema.sql', import.meta.url)), 'utf8')

export function realDB() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  const wrap = (sql) => ({
    args: [],
    bind(...a) { this.args = a; return this },
    async run() {
      const r = db.prepare(sql).run(...this.args)
      return { success: true, meta: { changes: Number(r.changes) } }
    },
    async first() { return db.prepare(sql).get(...this.args) ?? null },
    async all() { return { results: db.prepare(sql).all(...this.args) } },
  })
  return {
    raw: db,
    prepare: wrap,
    async batch(stmts) {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of stmts) out.push(await s.run())
        db.exec('COMMIT')
        return out
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
  }
}
```

- [ ] **Step 7: Write the scaffold test**

`tests/scaffold.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

test('wrangler.jsonc routes admin and api through the Worker first', () => {
  const w = read('wrangler.jsonc')
  assert.match(w, /"run_worker_first":\s*\["\/admin\/\*",\s*"\/api\/\*"\]/)
})

test('wrangler.jsonc declares no secret values', () => {
  const w = read('wrangler.jsonc')
  for (const k of ['GOOGLE_CLIENT_SECRET', 'ZOHO_CLIENT_SECRET', 'TURNSTILE_SECRET_KEY']) {
    assert.doesNotMatch(w, new RegExp(`"${k}"\\s*:`), `${k} must be a wrangler secret, not a var`)
  }
})

test('meet.config.json has every display key', () => {
  const c = JSON.parse(read('meet.config.json'))
  for (const k of ['displayName', 'pageTitle', 'pageSubtitle', 'eventTitle', 'privacyUrl', 'termsUrl', 'accentColor']) {
    assert.ok(k in c, `missing ${k}`)
  }
})
```

- [ ] **Step 8: Run**

Run: `npm test`
Expected: 3 pass. (`tests/helpers/d1.js` isn't exercised yet. It needs `schema.sql`, which arrives in Task 2.)

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc meet.config.json LICENSE tests/helpers/d1.js tests/scaffold.test.js
git commit -m "chore: scaffold meet-kit Worker project"
```

---

### Task 2: Combined schema

**Files:** Create `schema.sql`, `tests/schema.test.js`

- [ ] **Step 1: Write the failing test**

`tests/schema.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'

const tables = (db) => db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name)

test('schema creates exactly the meet-kit tables', () => {
  assert.deepEqual(tables(realDB()), [
    'calendar_config', 'calendar_connections', 'calendar_selections',
    'public_bookings', 'public_bookings_cancelled', 'rate_counters',
  ])
})

test('only one write connection can ever exist', () => {
  const db = realDB().raw
  const ins = "INSERT INTO calendar_connections (connection_id, provider, role, refresh_token, account_email, connected_at) VALUES (?, 'google', ?, 'rt', ?, 'now')"
  db.prepare(ins).run('google:a@x.test', 'write', 'a@x.test')
  db.prepare(ins).run('google:b@x.test', 'busy', 'b@x.test')
  assert.throws(() => db.prepare(ins).run('google:c@x.test', 'write', 'c@x.test'), /UNIQUE/)
})

test('two live public bookings cannot share a start time', () => {
  const db = realDB().raw
  const ins = "INSERT INTO public_bookings (id, created_at, attendee_email, cap_identity, duration_min, start_utc, end_utc) VALUES (?, 'now', 'v@x.test', 'v@x.test', 30, '2030-01-01T15:00:00.000Z', '2030-01-01T15:30:00.000Z')"
  db.prepare(ins).run('a')
  assert.throws(() => db.prepare(ins).run('b'), /UNIQUE/)
})

test('meet_url_source accepts only unique or fixed', () => {
  const db = realDB().raw
  const ins = "INSERT INTO public_bookings (id, created_at, attendee_email, cap_identity, duration_min, start_utc, end_utc, meet_url_source) VALUES (?, 'now', 'v@x.test', 'v@x.test', 30, ?, ?, ?)"
  db.prepare(ins).run('a', '2030-01-01T15:00:00Z', '2030-01-01T15:30:00Z', 'unique')
  db.prepare(ins).run('b', '2030-01-02T15:00:00Z', '2030-01-02T15:30:00Z', 'fixed')
  assert.throws(() => db.prepare(ins).run('c', '2030-01-03T15:00:00Z', '2030-01-03T15:30:00Z', 'zoom'), /CHECK/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/schema.test.js`
Expected: FAIL, `ENOENT ... schema.sql`.

- [ ] **Step 3: Write `schema.sql`**

Built from source migrations 002 (calendar tables only), 004, 005 and 006. The column order of `public_bookings` and `public_bookings_cancelled` must match the source's `INSERT` statements in `lib/public-bookings.js`. Verify by diffing against `$SRC/migrations/004_public_bookings.sql` + `006_cancellations.sql` before committing.

```sql
-- meet-kit D1 schema. Apply once:
--   npx wrangler d1 execute meet-kit --remote --file=schema.sql
-- Later changes ship as numbered files in migrations/.

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
  cancelled_at    TEXT NOT NULL,
  cancelled_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pbc_cap ON public_bookings_cancelled (cap_identity, created_at);
CREATE INDEX IF NOT EXISTS idx_pbc_ip  ON public_bookings_cancelled (client_ip, created_at);

-- Fixed-window request counters for the public slots endpoint.
CREATE TABLE IF NOT EXISTS rate_counters (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_counters_window ON rate_counters (window_start);
```

- [ ] **Step 4: Cross-check against the source migrations**

Run: `grep -n "cap_identity\|UNIQUE\|CREATE INDEX" $SRC/migrations/004_public_bookings.sql $SRC/migrations/006_cancellations.sql`
Expected: every column and index named there appears in `schema.sql`. If the source has an index name or column this schema lacks, add it. Record any intentional differences in the commit body.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/schema.test.js`
Expected: 4 pass.

- [ ] **Step 6: Commit**

```bash
git add schema.sql tests/schema.test.js
git commit -m "feat: combined D1 schema for meet-kit"
```

---

### Task 3: Port the pure core modules and their tests

**Files:**
- Create: `src/core/{slots,tz,durations,google-calendar,zoho-calendar,oauth-state,turnstile,rate-limit,public-cache,public-bookings}.js` (copied)
- Create: `scripts/port-test.mjs`
- Create: ported tests in `tests/`

- [ ] **Step 1: Copy the modules verbatim**

```bash
mkdir -p src/core src/handlers
for f in slots tz durations google-calendar zoho-calendar oauth-state turnstile rate-limit public-cache public-bookings; do
  cp "$SRC/lib/$f.js" "src/core/$f.js"
done
grep -n "^import" src/core/*.js
```

Expected: the only imports are relative, between these files (`slots.js` → `./tz.js`). No `@aifmb/*`, no `authz.js`.

- [ ] **Step 2: Write `scripts/port-test.mjs`**

```js
// One-shot: copy a source test into meet-kit, rewriting paths and scrubbing
// AIFMB-specific values. Usage: node scripts/port-test.mjs <name> [<name>...]
// where <name> is the source test file stem (e.g. public-book-api).
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = '/Users/leolaskin/Development/AIfindMyBusiness/scripts/cloudflare-cold-call-sheets'

const PATHS = [
  [/'\.\.\/lib\/([\w-]+)\.js'/g, "'../src/core/$1.js'"],
  [/'\.\.\/functions\/api\/public\/book\.js'/g, "'../src/handlers/public-book.js'"],
  [/'\.\.\/functions\/api\/public\/slots\.js'/g, "'../src/handlers/public-slots.js'"],
  [/'\.\.\/functions\/api\/calendar\/calendars\.js'/g, "'../src/handlers/admin-calendars.js'"],
  [/'\.\.\/functions\/api\/admin\/bookings\.js'/g, "'../src/handlers/admin-bookings.js'"],
  [/'\.\.\/functions\/api\/admin\/cancel\.js'/g, "'../src/handlers/admin-cancel.js'"],
  [/'\.\.\/public\/booking\.js'/g, "'../public/picker.js'"],
]

// Every migration is folded into schema.sql, so the source's extra
// migration exec lines are dropped; the schema.sql line stays.
const DROP_LINE = /^\s*db\.exec\(readFileSync\(fileURLToPath\(new URL\('\.\.\/migrations\/[^']+'.*\)\)\s*$/

const SCRUB = [
  [/aifindmybusiness@gmail\.com/g, 'owner@example.com'],
  [/leo@aifindmybusiness\.com/g, 'owner@example.com'],
  [/leo\.laskin@devrev\.ai/g, 'work@example.com'],
  [/https:\/\/aifindmybusiness\.com/g, 'https://example.com'],
  [/AI Find My Business/g, 'Example Co'],
  [/AIFMB_BOOKING/g, 'MEETKIT_PICKER'],
  [/'AIFMB'/g, "'Owner calendar'"],
  [/env\.CALL_STATE_DB/g, 'env.DB'],
  [/CALL_STATE_DB/g, 'DB'],
]

for (const name of process.argv.slice(2)) {
  let s = readFileSync(`${SRC}/tests/${name}.test.js`, 'utf8')
  for (const [re, to] of PATHS) s = s.replace(re, to)
  s = s.split('\n').filter((l) => !DROP_LINE.test(l)).join('\n')
  for (const [re, to] of SCRUB) s = s.replace(re, to)
  writeFileSync(`tests/${name}.test.js`, s)
  const left = s.match(/aifmb|aifindmybusiness|laskin|devrev/gi)
  console.log(`${name}: ${left ? `RESIDUE ${[...new Set(left)].join(',')}` : 'clean'}`)
}
```

- [ ] **Step 3: Port the pure-module tests**

```bash
node scripts/port-test.mjs slots tz durations google-calendar google-delete-event zoho-calendar \
  oauth-state turnstile rate-limit public-cache public-bookings-store cancellation-store
```

Expected: every line ends `clean`. For any `RESIDUE` line, open that file, replace the remaining value with a neutral `example.com` value by hand, and note it in the baseline's "Port notes" column.

- [ ] **Step 4: Replace any inline `realDB` that still reads deleted migrations**

Run: `grep -ln "function realDB" tests/*.test.js`

For each listed file, delete its inline `realDB` function and the now-unused `DatabaseSync`/`readFileSync`/`fileURLToPath` imports, and add:

```js
import { realDB } from './helpers/d1.js'
```

Leave any other file reads (fixtures, HTML) alone.

- [ ] **Step 5: Run and compare to baseline**

Run: `date '+%H:%M:%S'; npm test 2>&1 | tail -8; date '+%H:%M:%S'`

Expected: each ported file passes with its Task 0 count. Check per file with `node --test tests/<name>.test.js`.
- A test that asserted something AIFMB-specific may now fail. The likely case is an exact-string check on an AIFMB value that was scrubbed.
- Fix the **test's expected value** to the scrubbed value, never the module.
- Record each such change in the baseline doc's "Port notes" column.

- [ ] **Step 6: Commit**

```bash
git add src/core scripts/port-test.mjs tests docs/baseline-2026-10-01.md
git commit -m "feat(core): port pure booking modules and their tests"
```

---

### Task 4: Port calendar-store, busy, booking-core and cancel-booking (public-only)

**Files:** Create `src/core/{calendar-store,busy,booking-core,cancel-booking}.js`; port `calendar-store`, `cancel-booking` tests.

- [ ] **Step 1: Copy, then trim `calendar-store.js`**

```bash
for f in calendar-store busy booking-core cancel-booking; do cp "$SRC/lib/$f.js" "src/core/$f.js"; done
```

In `src/core/calendar-store.js`, delete these exported functions entirely. They touch the call-sheet `bookings`/`call_state` tables, which meet-kit doesn't have:
`saveBooking`, `getBookings`, `listUpcomingInternal`, `getInternalBooking`, `cancelInternalBooking`, `setOutcomeBooked`.

Also replace the comment block above `getWriteConnection` (it mentions "DevRev isolation") with:

```js
/**
 * THE resolver for "which account may create an event".
 *
 * Event creation must go through this function and nothing else. It hard-codes
 * role = 'write', so a busy-only connection can never become a write target no
 * matter what the caller passes. Layer 1 is the partial unique index in
 * schema.sql; layer 3 is the role check in the OAuth callback.
 */
```

- [ ] **Step 2: Remove the duplicate `accessTokenFor` from `busy.js`**

In `src/core/busy.js`, delete the private `async function accessTokenFor(...) {...}` and its doc comment. Replace the import block with:

```js
import * as store from './calendar-store.js'
import * as google from './google-calendar.js'
import * as zoho from './zoho-calendar.js'
import { accessTokenFor } from './booking-core.js'
```

Check that `booking-core.js` doesn't import `busy.js`, which would make a cycle:
Run: `grep -n "busy" src/core/booking-core.js`
Expected: no import line.

- [ ] **Step 3: Make `cancel-booking.js` public-only**

Replace `src/core/cancel-booking.js` with:

```js
// The one cancellation sequence.
//
// ORDER IS LOAD-BEARING: the Google event is deleted BEFORE the record moves.
// If Google succeeds and the D1 write then fails, the result is a deleted
// meeting still listed as booked -- wrong, but visibly wrong and safe to
// re-run. The reverse order's failure is a record saying "cancelled" while
// the meeting is still live on every attendee's calendar.

import * as store from './calendar-store.js'
import * as google from './google-calendar.js'
import { accessTokenFor } from './booking-core.js'
import { getPublicBooking, cancelPublicBooking } from './public-bookings.js'

export async function cancelBooking(db, cfg, { id, cancelledBy, nowIso }) {
  const row = await getPublicBooking(db, id)
  if (!row) return { ok: false, status: 404, error: 'Booking not found' }

  let alreadyGone = false
  if (row.event_id) {
    try {
      const conn = await store.getWriteConnection(db)
      const token = await accessTokenFor(db, cfg, conn)
      const res = await google.deleteEvent(token, {
        // The calendar the event was CREATED on, pinned at booking time.
        calendarId: row.calendar_id || cfg.write_calendar_id || 'primary',
        eventId: row.event_id,
      })
      alreadyGone = res.alreadyGone
    } catch {
      return { ok: false, status: 502, error: 'Could not cancel the calendar event' }
    }
  }

  await cancelPublicBooking(db, { row, cancelledAt: nowIso, cancelledBy })
  return { ok: true, alreadyGone }
}
```

The signature changes from `cancelBooking(db, {source, ...})` to `cancelBooking(db, cfg, {id, ...})`. `cfg` is passed in so the secrets come from `loadCfg` (Task 5), not D1.

- [ ] **Step 4: Port and adapt the two tests**

```bash
node scripts/port-test.mjs calendar-store cancel-booking
```

Then:
- In `tests/calendar-store.test.js`, delete every `test(...)` block that calls one of the six functions removed in Step 1. Count them and record "N tests removed: call-sheet tables not in meet-kit" in the baseline doc.
- In `tests/cancel-booking.test.js`:
  - delete every `test(...)` with `source: 'internal'`
  - rewrite the remaining calls from `cancelBooking(db, { source: 'public', id, ... })` to `cancelBooking(db, CFG, { id, ... })`
  - add near the top:

```js
const CFG = { google_client_id: 'cid', google_client_secret: 'csec' }
```

  - delete any `store.setConfig(db, 'google_client_secret', ...)` / `google_client_id` seeding lines, since secrets no longer come from D1
  - record the removed-test count.

- [ ] **Step 5: Run**

Run: `date '+%H:%M:%S'; npm test 2>&1 | tail -8; date '+%H:%M:%S'`
Expected: all pass. Per-file counts equal baseline minus the recorded removals.

- [ ] **Step 6: Commit**

```bash
git add src/core tests docs/baseline-2026-10-01.md
git commit -m "feat(core): port store, busy and cancel; drop call-sheet tables and duplicate token refresh"
```

---

### Task 5: Secrets from env, never D1 (`loadCfg`)

**Files:** Create `src/handlers/context.js`, `tests/context.test.js`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { loadCfg } from '../src/handlers/context.js'

const ENV = {
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec',
  ZOHO_CLIENT_ID: 'zid', ZOHO_CLIENT_SECRET: 'zsec',
}

test('client ids and secrets come from env', async () => {
  const cfg = await loadCfg(realDB(), ENV)
  assert.equal(cfg.google_client_id, 'gid')
  assert.equal(cfg.google_client_secret, 'gsec')
  assert.equal(cfg.zoho_client_id, 'zid')
  assert.equal(cfg.zoho_client_secret, 'zsec')
})

test('a secret stored in D1 is ignored, never returned', async () => {
  const db = realDB()
  await store.setConfig(db, 'google_client_secret', 'LEAKED-FROM-D1')
  const cfg = await loadCfg(db, {})
  assert.equal(cfg.google_client_secret, '')
})

test('non-secret D1 settings pass through', async () => {
  const db = realDB()
  await store.setConfig(db, 'meet_link', 'https://meet.example.com/x')
  const cfg = await loadCfg(db, ENV)
  assert.equal(cfg.meet_link, 'https://meet.example.com/x')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/context.test.js`
Expected: FAIL, cannot find module `../src/handlers/context.js`.

- [ ] **Step 3: Implement**

`src/handlers/context.js`:

```js
import * as store from '../core/calendar-store.js'

// cfg key -> Worker env name. Core code reads cfg.google_client_secret etc.;
// this is the ONLY place those values are sourced, and it sources them from
// Worker vars/secrets. Any copy found in D1 is discarded.
export const ENV_KEYS = {
  google_client_id: 'GOOGLE_CLIENT_ID',
  google_client_secret: 'GOOGLE_CLIENT_SECRET',
  zoho_client_id: 'ZOHO_CLIENT_ID',
  zoho_client_secret: 'ZOHO_CLIENT_SECRET',
}

export async function loadCfg(db, env) {
  const cfg = await store.getConfig(db)
  for (const [key, envName] of Object.entries(ENV_KEYS)) cfg[key] = env?.[envName] || ''
  return cfg
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/context.test.js`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/context.js tests/context.test.js
git commit -m "feat: source OAuth client credentials from Worker env only"
```

---

### Task 6: Cloudflare Access JWT verifier

**Files:** Create `src/core/access-jwt.js`, `tests/access-jwt.test.js`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose'
import { verifyAccess } from '../src/core/access-jwt.js'

const TEAM = 'https://team.cloudflareaccess.com'
const AUD = 'aud-tag-123'
const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: 'Owner@Example.com' }

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
const getKey = createLocalJWKSet({ keys: [jwk] })

async function token({ email = 'owner@example.com', aud = AUD, iss = TEAM, exp = '5m', kid = 'k1', key = privateKey } = {}) {
  return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key)
}
const req = (t) => new Request('https://x.test/api/admin/config', t ? { headers: { 'Cf-Access-Jwt-Assertion': t } } : {})

test('valid owner token is accepted (email compared case-insensitively)', async () => {
  const r = await verifyAccess(req(await token()), ENV, { getKey })
  assert.deepEqual(r, { ok: true, email: 'owner@example.com' })
})

for (const [name, opts] of [
  ['wrong audience', { aud: 'other' }],
  ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }],
  ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ['wrong email', { email: 'someone@example.com' }],
  ['unknown kid', { kid: 'k2' }],
]) {
  test(`rejected: ${name}`, async () => {
    const r = await verifyAccess(req(await token(opts)), ENV, { getKey })
    assert.equal(r.ok, false)
  })
}

test('rejected: signed by a different key', async () => {
  const other = await generateKeyPair('RS256')
  const r = await verifyAccess(req(await token({ key: other.privateKey })), ENV, { getKey })
  assert.equal(r.ok, false)
})

test('rejected: alg none', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const t = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ email: 'owner@example.com', aud: AUD, iss: TEAM, exp: 9999999999 })}.`
  assert.equal((await verifyAccess(req(t), ENV, { getKey })).ok, false)
})

test('rejected: HS256', async () => {
  const t = await new SignJWT({ email: 'owner@example.com' }).setProtectedHeader({ alg: 'HS256', kid: 'k1' })
    .setIssuer(TEAM).setAudience(AUD).setExpirationTime('5m').sign(new TextEncoder().encode('x'.repeat(32)))
  assert.equal((await verifyAccess(req(t), ENV, { getKey })).ok, false)
})

test('rejected: missing header', async () => {
  assert.deepEqual(await verifyAccess(req(), ENV, { getKey }), { ok: false, reason: 'missing' })
})

for (const k of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'OWNER_EMAIL']) {
  test(`fails closed when ${k} is unset`, async () => {
    const r = await verifyAccess(req(await token()), { ...ENV, [k]: '' }, { getKey })
    assert.deepEqual(r, { ok: false, reason: 'not_configured' })
  })
}

test('team domain without scheme is normalised', async () => {
  const r = await verifyAccess(req(await token()), { ...ENV, ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com/' }, { getKey })
  assert.equal(r.ok, true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/access-jwt.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/core/access-jwt.js`:

```js
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/access-jwt.test.js`
Expected: 15 pass (1 valid + 5 parameterised + different key + none + HS256 + missing + 3 unset + normalise).

- [ ] **Step 5: Commit**

```bash
git add src/core/access-jwt.js tests/access-jwt.test.js
git commit -m "feat(core): Cloudflare Access JWT verifier"
```

---

### Task 7: Unique Meet links with fixed-link fallback

**Files:**
- Modify: `src/core/google-calendar.js` (`listCalendars`, `createEvent`; add `getEvent`, `patchEventLink`)
- Create: `src/core/video-link.js`, `tests/video-link.test.js`, `tests/google-conference.test.js`

**Verify before relying on it:** the [create-events guide](https://developers.google.com/workspace/calendar/api/guides/create-events) documents `conferenceData.createRequest`, `conferenceDataVersion=1`, asynchronous `pending` status and `conferenceProperties.allowedConferenceSolutionTypes`. Two things are still unconfirmed, and Task 14 confirms them live:
- that the existing `calendar.events` scope allows conference creation
- that a PATCH with `conferenceData: null` removes a failed conference

If either fails live, stop and report. Don't widen scopes without asking Leo.

- [ ] **Step 1: Write the failing Google-client test**

`tests/google-conference.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import * as google from '../src/core/google-calendar.js'

function stub(responses) {
  const calls = []
  google.googleApi.fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    const body = responses.shift()
    return new Response(JSON.stringify(body), { status: body?.__status || 200 })
  }
  return calls
}

test('listCalendars reports whether Meet can be created', async () => {
  stub([{ items: [
    { id: 'a@x.test', summary: 'A', primary: true, conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } },
    { id: 'b@group.calendar.google.com', summary: 'B' },
  ] }])
  const cals = await google.listCalendars('tok')
  assert.deepEqual(cals.map((c) => c.meet), [true, false])
})

test('createEvent without conference keeps the original URL and body', async () => {
  const calls = stub([{ id: 'e1' }])
  await google.createEvent('tok', { calendarId: 'primary', summary: 's', startIso: 'a', endIso: 'b', timeZone: 'UTC', attendeeEmail: 'v@x.test' })
  assert.match(calls[0].url, /events\?sendUpdates=all$/)
  assert.equal(JSON.parse(calls[0].opts.body).conferenceData, undefined)
})

test('createEvent with conference sends a hangoutsMeet createRequest', async () => {
  const calls = stub([{ id: 'e1', hangoutLink: 'https://meet.google.com/abc', conferenceData: { createRequest: { status: { statusCode: 'success' } } } }])
  const out = await google.createEvent('tok', { calendarId: 'primary', summary: 's', startIso: 'a', endIso: 'b', timeZone: 'UTC', attendeeEmail: 'v@x.test', conference: true })
  assert.match(calls[0].url, /sendUpdates=all&conferenceDataVersion=1$/)
  const cr = JSON.parse(calls[0].opts.body).conferenceData.createRequest
  assert.equal(cr.conferenceSolutionKey.type, 'hangoutsMeet')
  assert.ok(cr.requestId)
  assert.deepEqual(out, { eventId: 'e1', htmlLink: '', meetUrl: 'https://meet.google.com/abc', conferenceStatus: 'success' })
})

test('getEvent returns link and status', async () => {
  stub([{ id: 'e1', hangoutLink: 'https://meet.google.com/x', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } }])
  assert.deepEqual(await google.getEvent('tok', { calendarId: 'primary', eventId: 'e1' }),
    { meetUrl: 'https://meet.google.com/x', conferenceStatus: 'pending' })
})

test('patchEventLink replaces the conference with the fixed link and notifies guests', async () => {
  const calls = stub([{ id: 'e1' }])
  await google.patchEventLink('tok', { calendarId: 'primary', eventId: 'e1', link: 'https://zoom.example/j/1' })
  assert.equal(calls[0].opts.method, 'PATCH')
  assert.match(calls[0].url, /events\/e1\?sendUpdates=all&conferenceDataVersion=1$/)
  const body = JSON.parse(calls[0].opts.body)
  assert.equal(body.location, 'https://zoom.example/j/1')
  assert.equal(body.conferenceData, null)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/google-conference.test.js`
Expected: FAIL. `meet` is undefined, and `getEvent`/`patchEventLink` aren't exported.

- [ ] **Step 3: Modify `src/core/google-calendar.js`**

In `listCalendars`, replace the `.map(...)` with:

```js
    .map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      primary: Boolean(c.primary),
      // Whether Google will mint a unique Meet room on this calendar.
      meet: (c.conferenceProperties?.allowedConferenceSolutionTypes || []).includes('hangoutsMeet'),
    }))
```

Replace the `createEvent` doc comment and function with:

```js
/**
 * Create a calendar event.
 *
 * conference: true asks Google to mint a unique Meet room
 * (conferenceData.createRequest + conferenceDataVersion=1). Creation is
 * asynchronous: the response may report status 'pending'; see video-link.js.
 *
 * sendUpdates=all is not optional. Without it Google creates the event and
 * emails nobody.
 */
export async function createEvent(accessToken, {
  calendarId, summary, description, location,
  startIso, endIso, timeZone, attendeeEmail, attendeeName, internalEmail, conference = false,
}) {
  const attendee = { email: attendeeEmail }
  if (attendeeName) attendee.displayName = attendeeName
  const attendees = [attendee]
  if (internalEmail && internalEmail.toLowerCase() !== attendeeEmail.toLowerCase()) {
    attendees.push({ email: internalEmail })
  }

  const payload = {
    summary, description, location,
    start: { dateTime: startIso, timeZone },
    end: { dateTime: endIso, timeZone },
    attendees,
  }
  let qs = 'sendUpdates=all'
  if (conference) {
    payload.conferenceData = {
      createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    }
    qs += '&conferenceDataVersion=1'
  }

  const res = await googleApi.fetch(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events?${qs}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`Google event creation failed: ${body?.error?.message || res.status}`)
  }
  return {
    eventId: body.id,
    htmlLink: body.htmlLink || '',
    meetUrl: body.hangoutLink || '',
    conferenceStatus: body.conferenceData?.createRequest?.status?.statusCode || '',
  }
}

export async function getEvent(accessToken, { calendarId, eventId }) {
  const res = await googleApi.fetch(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Google event read failed: ${res.status}`)
  return {
    meetUrl: body.hangoutLink || '',
    conferenceStatus: body.conferenceData?.createRequest?.status?.statusCode || '',
  }
}

/** Swap a failed/pending conference for the owner's fixed link; guests are re-notified. */
export async function patchEventLink(accessToken, { calendarId, eventId, link }) {
  const res = await googleApi.fetch(
    `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all&conferenceDataVersion=1`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: link, description: `Join the meeting: ${link}`, conferenceData: null }),
    },
  )
  if (!res.ok) throw new Error(`Google event patch failed: ${res.status}`)
}
```

- [ ] **Step 4: Run Google tests (new + ported)**

Run: `node --test tests/google-conference.test.js tests/google-calendar.test.js`
Expected: all pass.
- If a ported `google-calendar` test asserted the exact `createEvent` return object `{ eventId, htmlLink }`, update its expected value to include `meetUrl: ''` and `conferenceStatus: ''`, and record it in Port notes.
- If a ported test asserted the exact `listCalendars` objects, add `meet: false` to its expected value.

- [ ] **Step 5: Write the failing orchestrator test**

`tests/video-link.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import * as google from '../src/core/google-calendar.js'
import { createBookingEvent, NoLinkError } from '../src/core/video-link.js'

const EVENT = { summary: 'Intro call', startIso: 'a', endIso: 'b', timeZone: 'UTC', attendeeEmail: 'v@x.test' }
const noSleep = async () => {}

function fake({ create, gets = [], patchFails = false }) {
  const log = []
  google.googleApi.fetch = async (url, opts = {}) => {
    const m = opts.method || 'GET'
    log.push(`${m} ${url.includes('conferenceDataVersion') ? 'conf' : 'plain'}`)
    if (m === 'POST') return Response.json(create)
    if (m === 'GET') return Response.json(gets.shift() || {})
    if (m === 'PATCH') return new Response('{}', { status: patchFails ? 500 : 200 })
    if (m === 'DELETE') return new Response(null, { status: 204 })
  }
  return log
}

test('unique Meet ready immediately', async () => {
  fake({ create: { id: 'e1', hangoutLink: 'https://meet.google.com/u', conferenceData: { createRequest: { status: { statusCode: 'success' } } } } })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: '', event: EVENT, sleep: noSleep })
  assert.deepEqual(r, { eventId: 'e1', meetUrl: 'https://meet.google.com/u', source: 'unique' })
})

test('pending then success via polling', async () => {
  fake({
    create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } },
    gets: [{ conferenceData: { createRequest: { status: { statusCode: 'pending' } } } },
           { hangoutLink: 'https://meet.google.com/p', conferenceData: { createRequest: { status: { statusCode: 'success' } } } }],
  })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: '', event: EVENT, sleep: noSleep })
  assert.equal(r.meetUrl, 'https://meet.google.com/p')
  assert.equal(r.source, 'unique')
})

test('stays pending, falls back to the fixed link', async () => {
  const log = fake({ create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } } })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: 'https://zoom.example/j/1', event: EVENT, sleep: noSleep })
  assert.deepEqual(r, { eventId: 'e1', meetUrl: 'https://zoom.example/j/1', source: 'fixed' })
  assert.ok(log.some((l) => l.startsWith('PATCH')))
})

test('failure with no fixed link deletes the event and throws', async () => {
  const log = fake({ create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'failure' } } } } })
  await assert.rejects(
    createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: '', event: EVENT, sleep: noSleep }),
    NoLinkError,
  )
  assert.ok(log.some((l) => l.startsWith('DELETE')))
})

test('fixed link only: one plain create, link in location', async () => {
  const log = fake({ create: { id: 'e1' } })
  const r = await createBookingEvent('t', { calendarId: 'c', uniqueMeet: false, fixedLink: 'https://zoom.example/j/1', event: EVENT, sleep: noSleep })
  assert.deepEqual(r, { eventId: 'e1', meetUrl: 'https://zoom.example/j/1', source: 'fixed' })
  assert.deepEqual(log, ['POST plain'])
})

test('neither available: throws before any calendar call', async () => {
  const log = fake({ create: { id: 'never' } })
  await assert.rejects(
    createBookingEvent('t', { calendarId: 'c', uniqueMeet: false, fixedLink: '', event: EVENT, sleep: noSleep }),
    NoLinkError,
  )
  assert.deepEqual(log, [])
})

test('patch fails during fallback: event deleted, throws', async () => {
  const log = fake({ create: { id: 'e1', conferenceData: { createRequest: { status: { statusCode: 'failure' } } } }, patchFails: true })
  await assert.rejects(
    createBookingEvent('t', { calendarId: 'c', uniqueMeet: true, fixedLink: 'https://zoom.example/j/1', event: EVENT, sleep: noSleep }),
    NoLinkError,
  )
  assert.ok(log.some((l) => l.startsWith('DELETE')))
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `node --test tests/video-link.test.js`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `src/core/video-link.js`**

```js
// Create the booking event with a working video link, or create nothing.
//
// Preference: a unique Google Meet room (when the calendar allows it), then
// the owner's fixed link. A booking is never confirmed without a link: every
// path that ends without one deletes the event and throws NoLinkError.
import * as google from './google-calendar.js'

export class NoLinkError extends Error {}

// Total ~5s of waiting: well inside a Worker request, long enough for Google's
// usual async conference creation.
export const POLL_DELAYS_MS = [500, 1000, 1500, 2000]
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fixedDescription = (link) => `Join the meeting: ${link}`

export async function createBookingEvent(token, { calendarId, uniqueMeet, fixedLink, event, sleep = realSleep, pollDelays = POLL_DELAYS_MS }) {
  if (!uniqueMeet && !fixedLink) throw new NoLinkError('no video link available')

  if (!uniqueMeet) {
    const created = await google.createEvent(token, {
      ...event, calendarId, location: fixedLink, description: fixedDescription(fixedLink),
    })
    return { eventId: created.eventId, meetUrl: fixedLink, source: 'fixed' }
  }

  const created = await google.createEvent(token, { ...event, calendarId, conference: true })
  let { meetUrl, conferenceStatus } = created

  for (const ms of pollDelays) {
    if (conferenceStatus !== 'pending') break
    await sleep(ms)
    ;({ meetUrl, conferenceStatus } = await google.getEvent(token, { calendarId, eventId: created.eventId }))
  }

  if (conferenceStatus === 'success' && meetUrl) {
    return { eventId: created.eventId, meetUrl, source: 'unique' }
  }

  if (fixedLink) {
    try {
      await google.patchEventLink(token, { calendarId, eventId: created.eventId, link: fixedLink })
      return { eventId: created.eventId, meetUrl: fixedLink, source: 'fixed' }
    } catch {
      // fall through to cleanup
    }
  }

  await google.deleteEvent(token, { calendarId, eventId: created.eventId }).catch(() => {})
  throw new NoLinkError('could not attach a video link')
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `node --test tests/video-link.test.js tests/google-conference.test.js`
Expected: 12 pass.

- [ ] **Step 9: Commit**

```bash
git add src/core/google-calendar.js src/core/video-link.js tests/video-link.test.js tests/google-conference.test.js tests/google-calendar.test.js docs/baseline-2026-10-01.md
git commit -m "feat(core): unique Meet per booking with fixed-link fallback"
```

---

### Task 8: Public handlers (slots, book, site)

**Files:**
- Create: `src/core/site-config.js`, `src/handlers/public-slots.js`, `src/handlers/public-book.js`, `src/handlers/public-site.js`
- Port: `public-slots-api`, `public-book-api` tests
- Create: `tests/public-book-meetkit.test.js`, `tests/public-site.test.js`

- [ ] **Step 1: Write `src/core/site-config.js`**

```js
// Display settings from meet.config.json, validated with safe fallbacks so a
// typo in the owner's JSON can never break booking.
const DEFAULTS = {
  displayName: '', pageTitle: 'Book a call',
  pageSubtitle: "Pick a time that works for you. You'll get a calendar invite with a video link.",
  eventTitle: 'Intro call', privacyUrl: '', termsUrl: '', accentColor: '#0b6cff',
}
const str = (v, d, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d)
const url = (v) => (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v.trim()) ? v.trim() : '')
const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULTS.accentColor)

export function siteConfig(raw = {}) {
  return {
    displayName: str(raw.displayName, DEFAULTS.displayName, 80),
    pageTitle: str(raw.pageTitle, DEFAULTS.pageTitle, 80),
    pageSubtitle: str(raw.pageSubtitle, DEFAULTS.pageSubtitle, 200),
    eventTitle: str(raw.eventTitle, DEFAULTS.eventTitle, 120),
    privacyUrl: url(raw.privacyUrl),
    termsUrl: url(raw.termsUrl),
    accentColor: color(raw.accentColor),
  }
}
```

- [ ] **Step 2: Write `src/handlers/public-slots.js`**

Copy `$SRC/functions/api/public/slots.js`, then make exactly these changes:
1. Imports: `'../../../lib/X.js'` → `'../core/X.js'`. Replace the `json` import with a local helper at the top:
   ```js
   const json = (status, body) => Response.json(body, { status })
   ```
2. Delete the `purgeExpired` import and the `waitUntil(purgeExpired(db))` line plus its comment. Retention moves to the cron (Task 10).
3. `const db = env.CALL_STATE_DB` → `const db = env.DB`.
4. `const cfg = await store.getConfig(db)` → `const cfg = await loadCfg(db, env)`, and add `import { loadCfg } from './context.js'`.

- [ ] **Step 3: Write `src/handlers/public-book.js`**

Copy `$SRC/functions/api/public/book.js`, then:
1. Imports: `'../../../lib/X.js'` → `'../core/X.js'`. Use the same local `json` helper as Step 2. Remove the `google` import. Add:
   ```js
   import { loadCfg } from './context.js'
   import { createBookingEvent } from '../core/video-link.js'
   import * as google from '../core/google-calendar.js'
   ```
   `google` is kept for the race-cleanup delete.
2. `env.CALL_STATE_DB` → `env.DB`. `store.getConfig(db)` → `loadCfg(db, env)`.
3. Change the signature to `export async function onRequestPost({ request, env, site })`. `site` is the `siteConfig()` object injected by the router.
4. Replace `const meetUrl = cfg.meet_link` and the `if (!conn || !meetUrl)` guard with:
   ```js
   const fixedLink = cfg.meet_link || ''
   const uniqueMeet = cfg.write_calendar_meet === '1'
   // No booking account, or no possible video link, is an ops misconfiguration.
   if (!conn || (!uniqueMeet && !fixedLink)) return json(400, { error: GENERIC })
   ```
5. Replace the whole event-creation block, from `const description = ...` through the `catch` that returns 502, with:
   ```js
   const writeCalendarId = cfg.write_calendar_id || 'primary'

   let created
   let token
   try {
     token = await accessTokenFor(db, cfg, conn)
     created = await createBookingEvent(token, {
       calendarId: writeCalendarId,
       uniqueMeet,
       fixedLink,
       event: {
         // Fixed title from meet.config.json: no visitor text in the subject.
         summary: site?.eventTitle || 'Intro call',
         startIso: b.start,
         endIso: b.end,
         timeZone: rules.timezone,
         attendeeEmail: email,
         attendeeName,
         internalEmail: cfg.internal_attendee_email || '',
       },
     })
   } catch {
     // NoLinkError or any Google failure: nothing is recorded, and
     // createBookingEvent has already removed any event it made.
     return json(502, { error: GENERIC })
   }
   ```
6. In the `savePublicBooking` call, set `eventId: created.eventId`, `meetUrl: created.meetUrl`, and add `meetUrlSource: created.source`. In its `catch`, delete the duplicate event before returning 409:
   ```js
   } catch {
     // UNIQUE(start_utc): a concurrent request won this slot. The event we just
     // created is a duplicate -- remove it so the attendee is not double-invited.
     await google.deleteEvent(token, { calendarId: writeCalendarId, eventId: created.eventId }).catch(() => {})
     return json(409, { error: GENERIC })
   }
   ```
7. Final response: `return json(200, { ok: true, start: b.start, end: b.end, meetUrl: created.meetUrl })`.

Add `meet_url_source` to `savePublicBooking` in `src/core/public-bookings.js`: add the column to the INSERT column list, one more `?`, and `b.meetUrlSource || null` as the last bind value. Add `meet_url_source` the same way to the `cancelPublicBooking` INSERT (`row.meet_url_source ?? null`, before `cancelled_at`).

- [ ] **Step 4: Write `src/handlers/public-site.js`**

```js
// What the public page needs to render itself. Nothing here is secret: the
// Turnstile SITE key is public by design; the secret key never leaves env.
export async function onRequestGet({ env, site }) {
  return Response.json({ ...site, turnstileSiteKey: env.TURNSTILE_SITE_KEY || '' }, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
```

- [ ] **Step 5: Port the two handler tests**

```bash
node scripts/port-test.mjs public-slots-api public-book-api
```

Then fix them for the new contracts, recording each in Port notes:
- In every `seed()`, remove `setConfig(db, 'google_client_id'|'google_client_secret', ...)` lines. Pass `env: { DB: db, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', TURNSTILE_SECRET_KEY: ... }` where the test builds `env`.
- `public-book-api`: pass `site: { eventTitle: 'Intro call' }` in every `onRequestPost({...})` call. Change any assertion on the event `summary` from the scrubbed `'Example Co — intro call'` to `'Intro call'`.
- `public-slots-api`: delete tests that assert `purgeExpired` runs on the slots path (retention moved to cron). Record the count.

- [ ] **Step 6: Write the new behaviour tests**

`tests/public-book-meetkit.test.js`. Build the minimal fixture inline:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { turnstileApi } from '../src/core/turnstile.js'
import { onRequestPost } from '../src/handlers/public-book.js'

const OWNER = 'owner@example.com'
const ENV = (db) => ({ DB: db, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', TURNSTILE_SECRET_KEY: 'ts' })

async function seed({ meetFlag = '1', fixed = '' } = {}) {
  const db = realDB()
  await store.saveConnection(db, { provider: 'google', role: 'write', refreshToken: 'rt', accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: OWNER })
  await store.upsertSelection(db, `google:${OWNER}`, OWNER, 'Owner calendar')
  await store.setConfig(db, 'write_calendar_id', OWNER)
  await store.setConfig(db, 'write_calendar_meet', meetFlag)
  if (fixed) await store.setConfig(db, 'meet_link', fixed)
  // Monday-Sunday all day, so a near-future slot always exists.
  await store.setConfig(db, 'rules_weekdays', '0,1,2,3,4,5,6')
  await store.setConfig(db, 'rules_start_time', '00:00')
  await store.setConfig(db, 'rules_end_time', '23:30')
  await store.setConfig(db, 'rules_min_notice_minutes', '0')
  await store.setConfig(db, 'rules_timezone', 'UTC')
  return db
}

// A slot the grid will offer: next half hour boundary + 2h, in UTC.
function nextSlot() {
  let t = Math.ceil(Date.now() / 1_800_000) * 1_800_000 + 7_200_000
  // The day ends 23:30 UTC, so a 23:30 start never fits; skip to the next hour.
  if (new Date(t).getUTCHours() === 23 && new Date(t).getUTCMinutes() === 30) t += 3_600_000
  return { start: new Date(t).toISOString(), end: new Date(t + 1_800_000).toISOString() }
}

function google({ conf = 'success', link = 'https://meet.google.com/u', insertBody } = {}) {
  const calls = []
  googleApi.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body })
    if (url.includes('/freeBusy')) return Response.json({ calendars: { [OWNER]: { busy: [] } } })
    if (opts.method === 'POST') return Response.json(insertBody || { id: 'e1', hangoutLink: link, conferenceData: { createRequest: { status: { statusCode: conf } } } })
    if (opts.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({})
  }
  turnstileApi.fetch = async () => Response.json({ success: true })
  return calls
}

const post = (db, body) => onRequestPost({
  request: new Request('https://x.test/api/public/book', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
  env: ENV(db),
  site: { eventTitle: 'Intro call' },
})

test('books with a unique Meet link and records its source', async () => {
  const db = await seed()
  const calls = google()
  const s = nextSlot()
  const res = await post(db, { ...s, duration_minutes: 30, attendee_email: 'v@example.org', attendee_name: 'V', turnstileToken: 't' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).meetUrl, 'https://meet.google.com/u')
  const insert = calls.find((c) => c.method === 'POST' && c.url.includes('/events'))
  assert.equal(JSON.parse(insert.body).summary, 'Intro call')
  const row = db.raw.prepare('SELECT meet_url_source FROM public_bookings').get()
  assert.equal(row.meet_url_source, 'unique')
})

test('no unique Meet and no fixed link: refuses without touching Google', async () => {
  const db = await seed({ meetFlag: '0', fixed: '' })
  const calls = google()
  const res = await post(db, { ...nextSlot(), duration_minutes: 30, attendee_email: 'v@example.org', turnstileToken: 't' })
  assert.equal(res.status, 400)
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.includes('/events')).length, 0)
})

test('same-slot race: the losing request deletes its duplicate event', async () => {
  const db = await seed()
  const s = nextSlot()
  db.raw.prepare("INSERT INTO public_bookings (id, created_at, attendee_email, cap_identity, duration_min, start_utc, end_utc) VALUES ('x','2000-01-01T00:00:00Z','o@example.org','o@example.org',30,?,?)").run(s.start, s.end)
  // freeBusy reports free (the race window), so the handler proceeds to insert.
  const calls = google()
  const res = await post(db, { ...s, duration_minutes: 30, attendee_email: 'v@example.org', turnstileToken: 't' })
  assert.equal(res.status, 409)
  assert.ok(calls.some((c) => c.method === 'DELETE'), 'duplicate event must be deleted')
})
```

`tests/public-site.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { siteConfig } from '../src/core/site-config.js'
import { onRequestGet } from '../src/handlers/public-site.js'

test('siteConfig drops non-https links and bad colours', () => {
  const s = siteConfig({ privacyUrl: 'javascript:alert(1)', termsUrl: 'http://x.test', accentColor: 'red' })
  assert.equal(s.privacyUrl, '')
  assert.equal(s.termsUrl, '')
  assert.equal(s.accentColor, '#0b6cff')
})

test('site endpoint exposes the site key but no secret', async () => {
  const res = await onRequestGet({ env: { TURNSTILE_SITE_KEY: 'pub', TURNSTILE_SECRET_KEY: 'SECRET' }, site: siteConfig({}) })
  const text = await res.text()
  assert.match(text, /"turnstileSiteKey":"pub"/)
  assert.doesNotMatch(text, /SECRET/)
})
```

- [ ] **Step 7: Run**

Run: `date '+%H:%M:%S'; npm test 2>&1 | tail -8; date '+%H:%M:%S'`
Expected: all pass. The race test relies on the slot grid being computed from freeBusy only (D1 rows do not remove slots), so the handler reaches the insert and hits UNIQUE. If it returns 409 *without* a DELETE, check whether a POST to `/events` happened at all; if not, the request was refused earlier (caps, Turnstile, grid) and the test setup is wrong. Investigate before changing the handler.

- [ ] **Step 8: Commit**

```bash
git add src tests docs/baseline-2026-10-01.md
git commit -m "feat: public slots/book/site handlers with unique Meet and race cleanup"
```

---

### Task 9: Admin and OAuth handlers

**Files:**
- Create: `src/handlers/{admin-config,admin-calendars,admin-bookings,admin-cancel,oauth}.js`
- Port: `calendar-calendars-api`, `calendar-oauth`
- Create: `tests/admin-config.test.js`, `tests/admin-bookings-cancel.test.js`

- [ ] **Step 1: Write `src/handlers/admin-calendars.js`**

Copy `$SRC/functions/api/calendar/calendars.js`. Change the imports to `'../core/calendar-store.js'`, use the local `json` helper (`const json = (status, body) => Response.json(body, { status })`), and replace `env.CALL_STATE_DB` → `env.DB` (two places). Nothing else changes.

- [ ] **Step 2: Write `src/handlers/admin-bookings.js`**

```js
import { listUpcomingPublic } from '../core/public-bookings.js'

export async function onRequestGet({ env }) {
  const rows = await listUpcomingPublic(env.DB, new Date().toISOString())
  return Response.json({
    bookings: rows.map((r) => ({
      id: r.id,
      start: r.start_utc,
      end: r.end_utc,
      durationMin: r.duration_min,
      attendeeName: r.attendee_name || '',
      attendeeEmail: r.attendee_email || '',
      company: r.company || '',
      notes: r.notes || '',
      meetUrl: r.meet_url || '',
      meetUrlSource: r.meet_url_source || '',
    })),
  })
}
```

- [ ] **Step 3: Write `src/handlers/admin-cancel.js`**

```js
import { cancelBooking } from '../core/cancel-booking.js'
import { loadCfg } from './context.js'

export async function onRequestPost({ request, env, owner }) {
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  if (!body?.id) return Response.json({ error: 'id required' }, { status: 400 })

  // Always JSON: an HTML 500 would make the page report "could not cancel"
  // when the meeting may already be gone.
  try {
    const cfg = await loadCfg(env.DB, env)
    const r = await cancelBooking(env.DB, cfg, { id: body.id, cancelledBy: owner || '', nowIso: new Date().toISOString() })
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status })
    return Response.json({ ok: true, alreadyGone: r.alreadyGone })
  } catch {
    return Response.json({
      error: 'The meeting was cancelled and the guests were notified, but the record could not be updated. Retrying is safe.',
    }, { status: 500 })
  }
}
```

- [ ] **Step 4: Write `src/handlers/oauth.js`**

Port `$SRC/functions/api/calendar/connect/[provider].js` and `callback/[provider].js` into one file with these changes:
- `redirectUriFor(origin, provider)` returns `` `${origin}/admin/oauth/${provider}/callback` ``.
- Client credentials come from `loadCfg(db, env)`.
- The "must be saved in config first" error becomes `` `${provider} is not set up: set ${provider.toUpperCase()}_CLIENT_ID (var) and ${provider.toUpperCase()}_CLIENT_SECRET (wrangler secret).` ``
- Every `/calendar-config.html` redirect becomes `/admin/`.
- `connectedBy` = the `owner` argument.
- **New:** after saving a Google **write** connection, record the booking calendar and its Meet capability:
  ```js
  if (role === 'write') {
    const primary = cals.find((c) => c.primary)
    await store.setConfig(db, 'write_calendar_id', primary.id)
    await store.setConfig(db, 'write_calendar_meet', primary.meet ? '1' : '0')
  }
  ```

Full file:

```js
import * as store from '../core/calendar-store.js'
import { signState, verifyState, getOrCreateStateKey } from '../core/oauth-state.js'
import * as google from '../core/google-calendar.js'
import * as zoho from '../core/zoho-calendar.js'
import { loadCfg } from './context.js'

const json = (status, body) => Response.json(body, { status })
export const PROVIDERS = ['google', 'zoho']
export const ROLES = ['write', 'busy']
export const redirectUriFor = (origin, provider) => `${origin}/admin/oauth/${provider}/callback`

const notSetUp = (p) => `${p} is not set up: set ${p.toUpperCase()}_CLIENT_ID (var) and ${p.toUpperCase()}_CLIENT_SECRET (wrangler secret).`

function backToAdmin(origin, provider, message) {
  const q = new URLSearchParams({ error: `${provider}: ${String(message)}` })
  return Response.redirect(`${origin}/admin/?${q}`, 302)
}

export async function start({ request, env, params }) {
  const provider = params.provider
  if (!PROVIDERS.includes(provider)) return json(400, { error: 'unknown provider' })
  const url = new URL(request.url)
  const role = url.searchParams.get('role') || 'busy'
  if (!ROLES.includes(role)) return json(400, { error: 'unknown role' })
  if (provider === 'zoho' && role === 'write') {
    return json(400, { error: 'Zoho is a busy-time source only and cannot create events' })
  }

  const db = env.DB
  if (role === 'write') {
    const existing = await store.getWriteConnection(db)
    if (existing) {
      return json(409, { error: `${existing.account_email} is already the booking account. Disconnect it first.` })
    }
  }

  const cfg = await loadCfg(db, env)
  const clientId = cfg[`${provider}_client_id`]
  if (!clientId || !cfg[`${provider}_client_secret`]) return json(400, { error: notSetUp(provider) })
  if (provider === 'zoho' && !cfg.zoho_account_email) {
    return json(400, { error: 'Set the Zoho account email on the admin page before connecting Zoho.' })
  }

  const key = await getOrCreateStateKey(db, store)
  // Role travels inside the SIGNED state, never a callback query param.
  const state = await signState({ provider, role }, key, { ttlSeconds: 600 })
  const redirectUri = redirectUriFor(url.origin, provider)
  const target = provider === 'google'
    ? google.buildAuthUrl({ clientId, redirectUri, state })
    : zoho.buildAuthUrl({ clientId, redirectUri, state })
  return Response.redirect(target, 302)
}

export async function callback({ request, env, params, owner }) {
  const provider = params.provider
  if (!PROVIDERS.includes(provider)) return json(400, { error: 'unknown provider' })
  const url = new URL(request.url)
  if (url.searchParams.get('error')) {
    return backToAdmin(url.origin, provider, `denied: ${url.searchParams.get('error')}`)
  }
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  if (!code || !stateParam) return json(400, { error: 'code and state required' })

  const db = env.DB
  const key = await getOrCreateStateKey(db, store)
  const verified = await verifyState(stateParam, key)
  if (!verified.ok || verified.payload.provider !== provider) {
    return json(400, { error: `invalid state: ${verified.error || 'provider mismatch'}` })
  }
  const role = verified.payload.role
  if (!ROLES.includes(role)) return json(400, { error: 'invalid role in state' })
  if (provider === 'zoho' && role === 'write') return json(400, { error: 'Zoho cannot be the booking account' })
  if (role === 'write' && (await store.getWriteConnection(db))) {
    return json(409, { error: 'A booking account is already connected.' })
  }

  const cfg = await loadCfg(db, env)
  const clientId = cfg[`${provider}_client_id`]
  const clientSecret = cfg[`${provider}_client_secret`]
  const redirectUri = redirectUriFor(url.origin, provider)

  try {
    if (provider === 'google') {
      const tokens = await google.exchangeCode({ clientId, clientSecret, code, redirectUri })
      if (!tokens.refreshToken) {
        return backToAdmin(url.origin, provider, 'Google returned no refresh token. Remove this app at myaccount.google.com/permissions and reconnect.')
      }
      const cals = await google.listCalendars(tokens.accessToken)
      const primary = cals.find((c) => c.primary)
      if (!primary?.id) return backToAdmin(url.origin, provider, 'Could not determine the Google account email; nothing was saved.')
      const connId = await store.saveConnection(db, {
        provider: 'google', role, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken,
        expiresAt: new Date(tokens.expiresAt).toISOString(), accountEmail: primary.id, connectedBy: owner || null,
      })
      for (const c of cals) await store.upsertSelection(db, connId, c.id, c.name)
      if (role === 'write') {
        await store.setConfig(db, 'write_calendar_id', primary.id)
        await store.setConfig(db, 'write_calendar_meet', primary.meet ? '1' : '0')
      }
    } else {
      const accountsHost = url.searchParams.get('accounts-server') || 'https://accounts.zoho.com'
      const tokens = await zoho.exchangeCode({ clientId, clientSecret, code, redirectUri, accountsHost })
      if (!tokens.refreshToken) return backToAdmin(url.origin, provider, 'Zoho returned no refresh token. Reconnect.')
      const apiHost = zoho.calendarHostFor(accountsHost)
      const accountEmail = cfg.zoho_account_email
      if (!accountEmail) return backToAdmin(url.origin, provider, 'Set the Zoho account email, then reconnect.')
      await zoho.listCalendars({ accessToken: tokens.accessToken, apiHost })
      await store.saveConnection(db, {
        provider: 'zoho', role: 'busy', refreshToken: tokens.refreshToken, accessToken: tokens.accessToken,
        expiresAt: new Date(tokens.expiresAt).toISOString(), accountEmail, apiHost, accountsHost, connectedBy: owner || null,
      })
    }
  } catch (err) {
    return backToAdmin(url.origin, provider, err.message || err)
  }
  return Response.redirect(`${url.origin}/admin/?connected=${provider}`, 302)
}
```

- [ ] **Step 5: Write the failing admin-config test**

`tests/admin-config.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { onRequestGet, onRequestPut } from '../src/handlers/admin-config.js'

const OWNER = 'owner@example.com'
const ENV = (db) => ({ DB: db, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'GSECRET', ZOHO_CLIENT_SECRET: 'ZSECRET', TURNSTILE_SECRET_KEY: 'TSECRET' })
const put = (db, body) => onRequestPut({ request: new Request('https://x.test', { method: 'PUT', body: JSON.stringify(body) }), env: ENV(db) })

async function withWrite(db) {
  await store.saveConnection(db, { provider: 'google', role: 'write', refreshToken: 'rt', accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: OWNER })
  await store.upsertSelection(db, `google:${OWNER}`, OWNER, 'Main')
  await store.upsertSelection(db, `google:${OWNER}`, 'team@group.calendar.google.com', 'Team')
}

test('GET never contains any secret value', async () => {
  const db = realDB()
  const text = await (await onRequestGet({ env: ENV(db) })).text()
  for (const s of ['GSECRET', 'ZSECRET', 'TSECRET']) assert.ok(!text.includes(s), `${s} leaked`)
  const body = JSON.parse(text)
  assert.equal(body.googleConfigured, true)
  assert.equal(body.zohoConfigured, false)
})

test('PUT ignores client secrets sent from the browser', async () => {
  const db = realDB()
  await put(db, { google: { clientSecret: 'FROM-BROWSER' } })
  const rows = db.raw.prepare("SELECT key FROM calendar_config WHERE key LIKE '%secret%'").all()
  assert.deepEqual(rows, [])
})

test('meet link must be https or empty', async () => {
  const db = realDB()
  assert.equal((await put(db, { meetLink: 'javascript:alert(1)' })).status, 400)
  assert.equal((await put(db, { meetLink: 'https://zoom.example/j/1' })).status, 200)
  assert.equal((await put(db, { meetLink: '' })).status, 200)
})

test('writeCalendarId must belong to the booking account, and refreshes the Meet flag', async () => {
  const db = realDB()
  await withWrite(db)
  googleApi.fetch = async () => Response.json({ items: [
    { id: OWNER, primary: true, conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } },
    { id: 'team@group.calendar.google.com', conferenceProperties: { allowedConferenceSolutionTypes: [] } },
  ] })
  assert.equal((await put(db, { writeCalendarId: 'stranger@group.calendar.google.com' })).status, 400)
  assert.equal((await put(db, { writeCalendarId: 'team@group.calendar.google.com' })).status, 200)
  const cfg = await store.getConfig(db)
  assert.equal(cfg.write_calendar_id, 'team@group.calendar.google.com')
  assert.equal(cfg.write_calendar_meet, '0')
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `node --test tests/admin-config.test.js`
Expected: FAIL, module not found.

- [ ] **Step 7: Implement `src/handlers/admin-config.js`**

```js
import * as store from '../core/calendar-store.js'
import * as google from '../core/google-calendar.js'
import { accessTokenFor } from '../core/booking-core.js'
import { loadCfg } from './context.js'

const json = (status, body) => Response.json(body, { status })
const HTTPS = /^https:\/\/[^\s]+$/

export async function onRequestGet({ env }) {
  const db = env.DB
  const cfg = await loadCfg(db, env)
  const rules = await store.getRules(db)
  const connections = await store.getAllConnections(db)
  const writeConn = connections.find((c) => c.role === 'write') || null
  const bookingCalendars = writeConn
    ? (await store.getSelections(db, writeConn.connection_id)).map((s) => ({ id: s.calendar_id, name: s.name || s.calendar_id }))
    : []

  // Booleans only for credentials. Never a value.
  return json(200, {
    googleConfigured: Boolean(cfg.google_client_id && cfg.google_client_secret),
    zohoConfigured: Boolean(cfg.zoho_client_id && cfg.zoho_client_secret),
    turnstileConfigured: Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY),
    zohoAccountEmail: cfg.zoho_account_email || '',
    connections: connections.map((c) => ({ connectionId: c.connection_id, provider: c.provider, role: c.role, accountEmail: c.account_email })),
    writeAccount: writeConn ? writeConn.account_email : null,
    writeCalendarId: cfg.write_calendar_id || '',
    bookingCalendars,
    uniqueMeet: cfg.write_calendar_meet === '1',
    meetLink: cfg.meet_link || '',
    internalAttendeeEmail: cfg.internal_attendee_email || '',
    rules,
  })
}

export async function onRequestPut({ request, env }) {
  let body
  try { body = await request.json() } catch { return json(400, { error: 'invalid json' }) }
  const db = env.DB

  // Client ids/secrets are deliberately NOT accepted here: they are Worker
  // vars/secrets. Any google/zoho credential fields in the body are ignored.

  if (typeof body?.meetLink === 'string') {
    const v = body.meetLink.trim()
    if (v && !HTTPS.test(v)) return json(400, { error: 'The meeting link must start with https://' })
    await store.setConfig(db, 'meet_link', v)
  }
  if (typeof body?.internalAttendeeEmail === 'string') {
    await store.setConfig(db, 'internal_attendee_email', body.internalAttendeeEmail.trim())
  }
  if (typeof body?.zohoAccountEmail === 'string') {
    await store.setConfig(db, 'zoho_account_email', body.zohoAccountEmail.trim())
  }

  if (typeof body?.writeCalendarId === 'string' && body.writeCalendarId) {
    const writeConn = await store.getWriteConnection(db)
    if (!writeConn) return json(400, { error: 'Connect a booking account first.' })
    const sel = await store.getSelections(db, writeConn.connection_id)
    if (!sel.some((s) => s.calendar_id === body.writeCalendarId)) {
      return json(400, { error: 'That calendar does not belong to the booking account.' })
    }
    const cfg = await loadCfg(db, env)
    const token = await accessTokenFor(db, cfg, writeConn)
    const cal = (await google.listCalendars(token)).find((c) => c.id === body.writeCalendarId)
    await store.setConfig(db, 'write_calendar_id', body.writeCalendarId)
    await store.setConfig(db, 'write_calendar_meet', cal?.meet ? '1' : '0')
  }

  const r = body?.rules
  if (r) {
    if (r.timezone) await store.setConfig(db, 'rules_timezone', String(r.timezone))
    if (Array.isArray(r.weekdays)) await store.setConfig(db, 'rules_weekdays', r.weekdays.join(','))
    if (r.startTime) await store.setConfig(db, 'rules_start_time', String(r.startTime))
    if (r.endTime) await store.setConfig(db, 'rules_end_time', String(r.endTime))
    for (const [field, key] of [
      ['intervalMinutes', 'rules_interval_minutes'],
      ['minNoticeMinutes', 'rules_min_notice_minutes'],
      ['horizonDays', 'rules_horizon_days'],
    ]) {
      if (r[field] != null && r[field] !== '') await store.setConfig(db, key, String(r[field]))
    }
  }
  return json(200, { ok: true })
}
```

- [ ] **Step 8: Write the bookings/cancel test**

`tests/admin-bookings-cancel.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { realDB } from './helpers/d1.js'
import * as store from '../src/core/calendar-store.js'
import { googleApi } from '../src/core/google-calendar.js'
import { savePublicBooking } from '../src/core/public-bookings.js'
import { onRequestGet } from '../src/handlers/admin-bookings.js'
import { onRequestPost } from '../src/handlers/admin-cancel.js'

const OWNER = 'owner@example.com'
const ENV = (db) => ({ DB: db, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec' })

async function seed() {
  const db = realDB()
  await store.saveConnection(db, { provider: 'google', role: 'write', refreshToken: 'rt', accessToken: 'at',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), accountEmail: OWNER })
  const id = await savePublicBooking(db, { email: 'v@example.org', capIdentity: 'v@example.org', durationMinutes: 30,
    startUtc: '2099-01-01T15:00:00.000Z', endUtc: '2099-01-01T15:30:00.000Z', eventId: 'e1',
    meetUrl: 'https://meet.google.com/u', meetUrlSource: 'unique', calendarId: OWNER })
  return { db, id }
}

test('lists upcoming bookings with link source', async () => {
  const { db } = await seed()
  const { bookings } = await (await onRequestGet({ env: ENV(db) })).json()
  assert.equal(bookings.length, 1)
  assert.equal(bookings[0].meetUrlSource, 'unique')
})

test('cancel deletes the event on the pinned calendar, then moves the row', async () => {
  const { db, id } = await seed()
  const calls = []
  googleApi.fetch = async (url, opts) => { calls.push({ url, method: opts?.method }); return new Response(null, { status: 204 }) }
  const res = await onRequestPost({ request: new Request('https://x.test', { method: 'POST', body: JSON.stringify({ id }) }), env: ENV(db), owner: OWNER })
  assert.equal(res.status, 200)
  assert.match(calls[0].url, new RegExp(`calendars/${encodeURIComponent(OWNER)}/events/e1\\?sendUpdates=all`))
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM public_bookings').get().n, 0)
  assert.equal(db.raw.prepare('SELECT cancelled_by FROM public_bookings_cancelled').get().cancelled_by, OWNER)
})

test('Google failure: nothing recorded', async () => {
  const { db, id } = await seed()
  googleApi.fetch = async () => new Response('{}', { status: 500 })
  const res = await onRequestPost({ request: new Request('https://x.test', { method: 'POST', body: JSON.stringify({ id }) }), env: ENV(db), owner: OWNER })
  assert.equal(res.status, 502)
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM public_bookings').get().n, 1)
})
```

- [ ] **Step 9: Port the calendars and OAuth tests**

```bash
node scripts/port-test.mjs calendar-calendars-api calendar-oauth
```

Then fix `tests/calendar-oauth.test.js`, recording each change in Port notes:
- Imports: `../functions/api/calendar/connect/[provider].js` and `callback/[provider].js` → `import { start, callback, redirectUriFor } from '../src/handlers/oauth.js'`. Call sites: `connect.onRequestGet(ctx)` → `start(ctx)`, `cb.onRequestGet(ctx)` → `callback(ctx)`.
- `env` objects: `{ DB: db, GOOGLE_CLIENT_ID: ..., GOOGLE_CLIENT_SECRET: ..., ZOHO_CLIENT_ID: ..., ZOHO_CLIENT_SECRET: ... }`, replacing D1 `setConfig` of ids and secrets.
- Expected redirect URIs: `/api/calendar/callback/` → `/admin/oauth/`, with `/callback` appended after the provider.
- Expected failure redirects: `/calendar-config.html` → `/admin/`.
- A test asserting a denied consent returns JSON 400 now expects a 302 to `/admin/?error=...`.
- Add one test: after a Google `write` callback, `write_calendar_id` equals the primary calendar id and `write_calendar_meet` is `'1'` when the stubbed `calendarList` entry includes `hangoutsMeet`.

- [ ] **Step 10: Run**

Run: `date '+%H:%M:%S'; npm test 2>&1 | tail -8; date '+%H:%M:%S'`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/handlers tests docs/baseline-2026-10-01.md
git commit -m "feat: admin config, calendars, bookings, cancel and OAuth handlers"
```

---

### Task 10: Worker router, owner gate, cron

**Files:** Create `src/worker.js`, `tests/worker-routes.test.js`

- [ ] **Step 1: Write the failing route test**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { app, ADMIN_PREFIXES } from '../src/worker.js'
import { realDB } from './helpers/d1.js'

const ctx = { waitUntil() {}, passThroughOnException() {} }
const ENV = (db) => ({
  DB: db,
  // Mirrors real assets: admin pages and /meet exist, anything else 404s.
  ASSETS: { fetch: async (r) => (/^\/(admin|meet)/.test(new URL(r.url).pathname) ? new Response('asset') : new Response('nf', { status: 404 })) },
  ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud', OWNER_EMAIL: 'owner@example.com',
})

const adminRoutes = () => app.routes
  .filter((r) => ADMIN_PREFIXES.some((p) => r.path.startsWith(p)))
  .map((r) => ({ method: r.method === 'ALL' ? 'GET' : r.method, path: r.path.replace(':provider', 'google') }))

test('there are admin routes to check', () => {
  assert.ok(adminRoutes().length >= 7)
})

test('every admin route refuses a request with no Access token', async () => {
  const db = realDB()
  for (const { method, path } of adminRoutes()) {
    const res = await app.request(path, { method }, ENV(db), ctx)
    assert.equal(res.status, 403, `${method} ${path} must be 403 without a token`)
  }
})

test('every admin route refuses a forged token', async () => {
  const db = realDB()
  for (const { method, path } of adminRoutes()) {
    const res = await app.request(path, { method, headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } }, ENV(db), ctx)
    assert.equal(res.status, 403, `${method} ${path}`)
  }
})

test('admin routes refuse everything when Access is not configured yet', async () => {
  const db = realDB()
  const res = await app.request('/api/admin/config', {}, { DB: db, ASSETS: ENV(db).ASSETS }, ctx)
  assert.equal(res.status, 403)
})

test('public routes are reachable without a token', async () => {
  const db = realDB()
  const res = await app.request('/api/public/site', {}, ENV(db), ctx)
  assert.equal(res.status, 200)
})

test('near-miss paths are not admin and not public API', async () => {
  const db = realDB()
  for (const p of ['/administrator', '/api/adminx', '/api/publicity']) {
    const res = await app.request(p, {}, ENV(db), ctx)
    assert.notEqual(res.status, 200, p)
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/worker-routes.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/worker.js`**

```js
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
import * as oauth from './handlers/oauth.js'

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

// Owner gate. Exact segment match: '/admin' and '/admin/...' only, so
// '/administrator' and '/api/adminx' are NOT treated as admin (and 404).
const isAdminPath = (p) => ADMIN_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`))
app.use('*', async (c, next) => {
  if (!isAdminPath(new URL(c.req.url).pathname)) return next()
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
app.get('/admin/oauth/:provider/start', run(oauth.start))
app.get('/admin/oauth/:provider/callback', run(oauth.callback))

// Admin HTML (gated above), then everything else, from static assets.
app.get('/admin/*', (c) => c.env.ASSETS.fetch(c.req.raw))
app.get('/admin', (c) => c.env.ASSETS.fetch(c.req.raw))
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default {
  fetch: app.fetch,
  // Nightly retention (wrangler.jsonc triggers.crons). purgeExpired never throws.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeExpired(env.DB))
    ctx.waitUntil(sweep(env.DB, { windowSeconds: 60 }).catch(() => {}))
  },
}
```

If the dry-run bundle in Step 5 rejects the `with { type: 'json' }` attribute, stop and report the exact error; do not drop the attribute (Node needs it).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/worker-routes.test.js`
Expected: 6 pass.
- If `app.routes` includes middleware entries (method `ALL`, path `/*`), the `ADMIN_PREFIXES` filter excludes them.

- [ ] **Step 5: Bundle check**

Run: `npx wrangler deploy --dry-run --outdir /tmp/meetkit-dry 2>&1 | tail -5`
Expected: a successful build with a total upload size, and no "Could not resolve" errors. (`--dry-run` builds without deploying.)

- [ ] **Step 6: Full suite**

Run: `date '+%H:%M:%S'; npm test 2>&1 | tail -8; date '+%H:%M:%S'`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/worker.js tests/worker-routes.test.js
git commit -m "feat: Worker router with Access owner gate and nightly retention cron"
```

---

### Task 11: Front end

**Files:** Create `public/picker.js`, `public/meet.html`, `public/meet.js`, `public/admin/index.html`, `public/admin/admin.js`, `public/admin/bookings.html`, `public/admin/bookings.js`, `public/_headers`, `public/404.html`. Port `meet-page`, `meet-duration-grid` tests.

- [ ] **Step 1: Derive `public/picker.js` from the source picker**

```bash
cp "$SRC/public/booking.js" public/picker.js
```

Edit `public/picker.js`:
1. Replace the 6-line header comment with:
   ```js
   // Month-grid booking picker used by /meet. Injects its own modal markup and
   // drives /api/public/slots and /api/public/book via openModal(card, opts).
   ```
2. Delete `STATE_TZ`, `TWO_ZONE` and `tzForState`, plus every use of `tzForState` and `card.dataset.state` inside `openModal`. Prospect-timezone display is a call-sheet feature, and `/meet` shows host time only.
3. Delete `renderBadge`, `hydrateBadges`, the trailing `hydrateBadges()` call, and the `document.addEventListener('click', ...)` block for `button.book-meeting`.
4. In `openModal`, force direct mode and drop the internal defaults:
   ```js
   async function openModal(card, opts = {}) {
     const slotsUrl = opts.slotsUrl || '/api/public/slots'
     const bookUrl = opts.bookUrl || '/api/public/book'
   ```
   Remove `const direct = ...`. In the confirm handler, delete the `...(direct ? {} : { sheet, card_id })` spread and the non-direct branch after `if (direct) {...}`, keeping only the direct branch's body. Replace the `practice: card.dataset.practice || ''` line with nothing.
5. Change the email-missing message `'Enter the prospect’s email.'` → `'Enter your email.'`.
6. Last line: `window.AIFMB_BOOKING = { openModal }` → `window.MEETKIT_PICKER = { openModal }`.

Verify: `grep -n "AIFMB\|sheet\|card_id\|renderBadge\|STATE_TZ\|calendar/" public/picker.js`
Expected: no output.

- [ ] **Step 2: Write `public/meet.html`**

Copy `$SRC/public/meet.html`, then:
- `<title>` → `<title>Book a call</title>`. `meet.js` sets it from `/api/public/site`.
- `<h1>` gets `id="meet-title"`; the `.sub` paragraph gets `id="meet-subtitle"`.
- Replace the Turnstile div with `<div class="turnstile" id="meet-turnstile"></div>`, and change the script tag to `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`.
- Replace the notice paragraph with:
  `<p class="notice" id="meet-notice">We use your details to send the calendar invite and to prevent abuse.</p>`
- Replace the footer with `<p class="foot" id="meet-foot"></p>`.
- Scripts: `/booking.js` → `/picker.js`.
- In the `<style>`, replace both literal `#0b6cff` with `var(--accent)` and add `:root{--accent:#0b6cff}` at the top.

- [ ] **Step 3: Write `public/meet.js`**

Copy `$SRC/public/meet.js`, then:
- Replace the header comment with `// Public booking page (/meet): fills itself from /api/public/site, then drives picker.js.`
- `win.AIFMB_BOOKING.openModal` → `win.MEETKIT_PICKER.openModal`.
- In `extraBody`, read the token with `win.turnstile?.getResponse?.(win.__meetTurnstileId) || ''`.
- Add, and export for tests:

```js
export function applySite(doc, site) {
  const set = (id, text) => { const el = doc.getElementById(id); if (el && text) el.textContent = text }
  doc.title = site.displayName ? `${site.pageTitle} · ${site.displayName}` : site.pageTitle
  set('meet-title', site.pageTitle)
  set('meet-subtitle', site.pageSubtitle)
  doc.documentElement.style.setProperty('--accent', site.accentColor)
  const foot = doc.getElementById('meet-foot')
  const notice = doc.getElementById('meet-notice')
  const link = (href, label) => {
    const a = doc.createElement('a')
    a.href = href; a.textContent = label; a.target = '_blank'; a.rel = 'noopener'
    return a
  }
  if (foot) {
    foot.textContent = site.displayName || ''
    for (const [href, label] of [[site.privacyUrl, 'Privacy Policy'], [site.termsUrl, 'Terms']]) {
      if (href) { foot.append(' · '); foot.append(link(href, label)) }
    }
  }
  if (notice && site.privacyUrl) { notice.append(' See the '); notice.append(link(site.privacyUrl, 'Privacy Policy')); notice.append('.') }
}

export async function loadSite(doc) {
  const win = doc.defaultView
  const site = await (await win.fetch('/api/public/site')).json()
  applySite(doc, site)
  const mount = () => {
    if (!win.turnstile || !site.turnstileSiteKey) return false
    win.__meetTurnstileId = win.turnstile.render('#meet-turnstile', { sitekey: site.turnstileSiteKey })
    return true
  }
  if (!mount()) {
    const t = win.setInterval(() => { if (mount()) win.clearInterval(t) }, 200)
  }
  return site
}
```

- At the bottom, call `loadSite(document)` alongside `initMeet(document)` in both branches.

- [ ] **Step 4: Port and extend the page tests**

```bash
node scripts/port-test.mjs meet-page meet-duration-grid
grep -n "AIFMB\|booking.js\|0x4AAAA\|aifindmybusiness" tests/meet-page.test.js tests/meet-duration-grid.test.js
```

Fix every hit:
- `booking.js` → `picker.js`
- remove assertions on the hardcoded Turnstile site key or AIFMB footer text, recording each in Port notes
- set any `window.AIFMB_BOOKING` stub to `window.MEETKIT_PICKER`.

Append to `tests/meet-page.test.js`:

```js
import { applySite } from '../public/meet.js'

test('applySite renders owner branding and drops empty legal links', () => {
  const dom = new JSDOM(PAGE)
  const doc = dom.window.document
  applySite(doc, { displayName: 'Pat Doe', pageTitle: 'Talk to Pat', pageSubtitle: 'Pick a time.',
    accentColor: '#123456', privacyUrl: 'https://pat.example/privacy', termsUrl: '' })
  assert.equal(doc.title, 'Talk to Pat · Pat Doe')
  assert.equal(doc.getElementById('meet-title').textContent, 'Talk to Pat')
  const foot = doc.getElementById('meet-foot')
  assert.match(foot.textContent, /Pat Doe · Privacy Policy/)
  assert.doesNotMatch(foot.textContent, /Terms/)
})

test('the page ships no hardcoded site key or owner branding', () => {
  assert.doesNotMatch(PAGE, /0x4AAAA|aifindmybusiness|AI Find My Business/i)
})
```

Run: `node --test tests/meet-page.test.js tests/meet-duration-grid.test.js`
Expected: all pass.

- [ ] **Step 5: Write the admin pages**

`public/admin/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>meet-kit admin</title>
<style>
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1a1a1a;background:#fafaf7}
.wrap{max-width:760px;margin:0 auto;padding:32px 16px 80px}
section{background:#fff;border:1px solid #e3e3df;border-radius:12px;padding:18px;margin:16px 0}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:0 0 10px}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 4px}
input,select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:7px;font:inherit}
button,.btn{display:inline-block;margin-top:12px;padding:8px 14px;border-radius:7px;border:1px solid #0b6cff;background:#0b6cff;color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.ok{color:#137333}.bad{color:#b3261e}.muted{color:#5f6368;font-size:13px}
.cal{display:flex;gap:8px;align-items:center;margin:4px 0}.cal input{width:auto}
#flash{padding:10px;border-radius:8px;display:none}
nav a{margin-right:12px}
</style>
</head>
<body>
<div class="wrap">
  <nav><a href="/admin/">Setup</a><a href="/admin/bookings.html">Bookings</a><a href="/meet" target="_blank">Public page ↗</a></nav>
  <h1>meet-kit setup</h1>
  <p id="flash"></p>

  <section id="status"><h2>Status</h2><ul id="status-list"></ul></section>

  <section>
    <h2>Booking account (Google)</h2>
    <p id="write-account" class="muted"></p>
    <a class="btn" id="connect-write" href="/admin/oauth/google/start?role=write">Connect booking account</a>
    <label for="write-cal">Calendar that receives bookings</label>
    <select id="write-cal"></select>
    <p id="meet-status" class="muted"></p>
  </section>

  <section>
    <h2>Busy calendars</h2>
    <p class="muted">Any checked calendar blocks time. Add more Google accounts as busy-only sources.</p>
    <div id="busy-list"></div>
    <a class="btn" href="/admin/oauth/google/start?role=busy">Add a Google account (busy only)</a>
    <label for="zoho-email">Zoho account email (optional, busy only)</label>
    <input id="zoho-email" type="email">
    <a class="btn" href="/admin/oauth/zoho/start?role=busy">Connect Zoho</a>
  </section>

  <section>
    <h2>Video link and invites</h2>
    <label for="meet-link">Fixed meeting link (used when a unique Meet room is not available)</label>
    <input id="meet-link" type="url" placeholder="https://">
    <label for="internal-email">Also invite this address to every booking (optional)</label>
    <input id="internal-email" type="email">
  </section>

  <section>
    <h2>Availability rules</h2>
    <label for="tz">Time zone</label><input id="tz" placeholder="America/New_York">
    <label for="days">Weekdays (0=Sun … 6=Sat, comma separated)</label><input id="days">
    <label for="start">Day starts</label><input id="start" placeholder="09:00">
    <label for="end">Day ends</label><input id="end" placeholder="17:00">
    <label for="notice">Minimum notice (minutes)</label><input id="notice" type="number">
    <label for="horizon">Booking horizon (days)</label><input id="horizon" type="number">
    <button id="save">Save settings</button>
  </section>
</div>
<script type="module" src="/admin/admin.js"></script>
</body>
</html>
```

`public/admin/admin.js`:

```js
const $ = (id) => document.getElementById(id)

function flash(msg, ok) {
  const f = $('flash')
  f.style.display = 'block'
  f.className = ok ? 'ok' : 'bad'
  f.textContent = msg
}

async function api(path, init) {
  const r = await fetch(path, init)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
  return body
}

function statusLine(ok, text) {
  const li = document.createElement('li')
  li.className = ok ? 'ok' : 'bad'
  li.textContent = `${ok ? '✓' : '✗'} ${text}`
  return li
}

async function load() {
  const q = new URLSearchParams(location.search)
  if (q.get('error')) flash(q.get('error'), false)
  if (q.get('connected')) flash(`Connected ${q.get('connected')}.`, true)

  const cfg = await api('/api/admin/config')
  const { connections } = await api('/api/admin/calendars')

  const list = $('status-list')
  list.replaceChildren(
    statusLine(cfg.googleConfigured, 'Google OAuth client set (GOOGLE_CLIENT_ID var + GOOGLE_CLIENT_SECRET secret)'),
    statusLine(cfg.turnstileConfigured, 'Turnstile set (TURNSTILE_SITE_KEY var + TURNSTILE_SECRET_KEY secret)'),
    statusLine(Boolean(cfg.writeAccount), 'Booking account connected'),
    statusLine(cfg.uniqueMeet || Boolean(cfg.meetLink), 'A video link is available for bookings'),
  )

  $('write-account').textContent = cfg.writeAccount ? `Connected: ${cfg.writeAccount}` : 'No booking account yet.'
  $('connect-write').style.display = cfg.writeAccount ? 'none' : 'inline-block'
  const sel = $('write-cal')
  sel.replaceChildren(...cfg.bookingCalendars.map((c) => {
    const o = document.createElement('option')
    o.value = c.id; o.textContent = c.name; o.selected = c.id === cfg.writeCalendarId
    return o
  }))
  $('meet-status').textContent = cfg.uniqueMeet
    ? 'Unique Meet links: available on this calendar.'
    : 'Unique Meet links: not available on this calendar. The fixed link below is used.'

  const busy = $('busy-list')
  busy.replaceChildren()
  for (const conn of connections) {
    const h = document.createElement('p')
    h.innerHTML = '<strong></strong> <span class="muted"></span>'
    h.querySelector('strong').textContent = conn.accountEmail
    h.querySelector('span').textContent = conn.writesEvents ? '(booking account)' : `(${conn.provider}, busy only)`
    busy.append(h)
    for (const cal of conn.calendars) {
      const row = document.createElement('label')
      row.className = 'cal'
      const cb = document.createElement('input')
      cb.type = 'checkbox'; cb.checked = cal.busy
      cb.addEventListener('change', async () => {
        try {
          await api('/api/admin/calendars', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendars: [{ connectionId: conn.connectionId, calendarId: cal.calendarId, busy: cb.checked }] }) })
        } catch (e) { flash(e.message, false); cb.checked = !cb.checked }
      })
      row.append(cb, document.createTextNode(cal.name))
      busy.append(row)
    }
  }

  $('zoho-email').value = cfg.zohoAccountEmail
  $('meet-link').value = cfg.meetLink
  $('internal-email').value = cfg.internalAttendeeEmail
  $('tz').value = cfg.rules.timezone
  $('days').value = cfg.rules.weekdays.join(',')
  $('start').value = cfg.rules.startTime
  $('end').value = cfg.rules.endTime
  $('notice').value = cfg.rules.minNoticeMinutes
  $('horizon').value = cfg.rules.horizonDays
}

$('save').addEventListener('click', async () => {
  try {
    await api('/api/admin/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writeCalendarId: $('write-cal').value || undefined,
        meetLink: $('meet-link').value,
        internalAttendeeEmail: $('internal-email').value,
        zohoAccountEmail: $('zoho-email').value,
        rules: {
          timezone: $('tz').value, weekdays: $('days').value.split(',').map((s) => Number(s.trim())).filter(Number.isFinite),
          startTime: $('start').value, endTime: $('end').value,
          minNoticeMinutes: $('notice').value, horizonDays: $('horizon').value,
        },
      }),
    })
    flash('Saved.', true)
    await load()
  } catch (e) { flash(e.message, false) }
})

load().catch((e) => flash(e.message, false))
```

`public/admin/bookings.html` and `public/admin/bookings.js`: copy `$SRC/public/bookings/index.html` → `public/admin/bookings.html` and `$SRC/public/bookings.js` → `public/admin/bookings.js`, then:
- Title → `Upcoming bookings`. Remove any `AIFMB` text, and any auth-runtime/Clerk script tags (`grep -n "script" public/admin/bookings.html`).
- In the HTML, the script src → `/admin/bookings.js`.
- In `bookings.js`, remove rendering of `source: 'internal'` rows and the `sheet`/`cardId` fields. The cancel POST body becomes `JSON.stringify({ id: b.id })`. Show `b.meetUrlSource` next to the link (`unique Meet` / `fixed link`).

Verify: `grep -rn "AIFMB\|aifindmybusiness\|clerk\|auth-runtime\|sheet" public/`
Expected: no output.

- [ ] **Step 6: `public/_headers` and `public/404.html`**

```text
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
/admin/*
  Cache-Control: no-store
  X-Robots-Tag: noindex, nofollow
```

`public/404.html`: `<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found. <a href="/meet">Book a call</a></p>`

Also add `public/index.html`, which redirects to `/meet`:
`<!doctype html><meta http-equiv="refresh" content="0; url=/meet"><title>Redirecting</title>`

- [ ] **Step 7: Run everything**

Run: `date '+%H:%M:%S'; npm test 2>&1 | tail -8; date '+%H:%M:%S'`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add public tests docs/baseline-2026-10-01.md
git commit -m "feat(ui): public /meet page, picker and admin pages driven by meet.config.json"
```

---

### Task 12: Leak check

**Files:** Create `tests/leak-check.test.js`; delete `scripts/port-test.mjs`

- [ ] **Step 0: Remove the one-shot port script**

`scripts/port-test.mjs` hardcodes the source repo path and the very strings it scrubs. Porting is finished, so delete it (git history keeps it):

```bash
git rm -q scripts/port-test.mjs && git commit -m "chore: remove one-shot test port script"
```

- [ ] **Step 1: Write the test**

```js
// Nothing of the original owner's may ship in the template.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'docs'])
const SELF = 'tests/leak-check.test.js'

// Patterns split so this file does not match itself if SELF is ever removed.
const PATTERNS = [
  ['aifind', 'mybusiness'], ['AI', 'FMB'], ['las', 'kin'], ['dev', 'rev'],
  ['7301c7b4-bbb8', '-4f32-a6ce-ca5b3e3d429b'], ['org_3Dthhdve6', 'MC7xfTv0b0NnUCgArr'],
  ['0x4AAAAAAE0', 'VFxAQIP8jtMZM'], ['cold-call', ''], ['CALL_STATE', '_DB'],
].map(([a, b]) => new RegExp(`${a}${b}`, 'i'))

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(name)) yield* files(p) } else yield p
  }
}

test('no original-owner identifiers anywhere in the shipped tree', () => {
  const hits = []
  for (const f of files(ROOT)) {
    const rel = relative(ROOT, f)
    if (rel === SELF || rel === 'package-lock.json' || rel === 'LICENSE') continue
    const text = readFileSync(f, 'utf8')
    for (const re of PATTERNS) if (re.test(text)) hits.push(`${rel}: ${re}`)
  }
  assert.deepEqual(hits, [])
})
```

`docs/` is skipped because the spec, plan and baseline name the source repo by design. `LICENSE` is skipped because it names the copyright holder. Task 15 decides whether `docs/superpowers/` ships in the template (it shouldn't; see Task 15 Step 2).

- [ ] **Step 2: Run**

Run: `node --test tests/leak-check.test.js`
Expected: PASS. If it lists hits, fix each file (not the pattern list), then re-run.

- [ ] **Step 3: Prove the gate actually fails**

```bash
echo "// aifindmybusiness" >> src/core/tz.js
node --test tests/leak-check.test.js; echo "exit=$?"
git checkout src/core/tz.js
node --test tests/leak-check.test.js; echo "exit=$?"
```

Expected: first run FAIL with `exit=1` naming `src/core/tz.js`. Second run PASS with `exit=0`.

- [ ] **Step 4: Commit**

```bash
git add tests/leak-check.test.js
git commit -m "test: leak check for original-owner identifiers"
```

---

### Task 13: Docs: README, DEPLOY-AGENT, CLAUDE.md

**Files:** Create `README.md`, `DEPLOY-AGENT.md`, `CLAUDE.md`

- [ ] **Step 1: Write `CLAUDE.md`**

```markdown
# meet-kit

If you are an AI agent asked to deploy or set up this project, follow
`DEPLOY-AGENT.md` exactly, one step at a time. Never ask the user to paste a
secret into chat; secrets are entered by the user with
`! npx wrangler secret put <NAME>`.

Run tests with `npm test`. Do not deploy with failing tests.
```

- [ ] **Step 2: Write `README.md`**

Sections, in order (write full prose for each):
1. **What it is.** A personal booking page on your own Cloudflare account. Visitors pick a time, and an invite with a video link lands on your Google calendar. Busy time is read from any number of Google calendars and optionally Zoho.
2. **What you need.** A Cloudflare account (free), a Google account, and Node.js (a current, active or maintenance LTS release).
3. **Set it up.** "Open this folder in your AI coding agent and say *deploy meet-kit for me*. It follows `DEPLOY-AGENT.md`. Or follow that file by hand."
4. **Costs.** Fits Cloudflare's free tier for personal use. Check current limits at developers.cloudflare.com/workers/platform/pricing/ and /d1/platform/pricing/.
5. **What it stores.** Visitor name, email, company, notes, and IP (IP only for abuse limits). IPs are cleared after 30 days, and bookings are deleted 24 months after the meeting date. Adjust in `src/core/public-bookings.js`.
6. **Updating.**
   ```bash
   git remote add upstream <URL of the meet-kit repo you were invited to>   # once
   git pull upstream main
   npm install && npm test && npx wrangler deploy
   ```
   Schema changes ship as `migrations/NNN_*.sql` with the apply command in the file header.
   (Deviation from the spec, which printed the upstream URL: the leak check forbids the owner's handle in the shipped tree, and invitees already know the URL they were invited to.)
7. **Support.** "Shared as-is under the MIT license. No support, no hosting, no warranty. You own your Cloudflare account, calendar data and keys."

- [ ] **Step 3: Write `DEPLOY-AGENT.md`**

Write it from spec section 3 (steps 0–10), with every command exact and every verification stated as expected output. Required content per step:
- **0 Prerequisites** (conversation only, no commands until all are yes):
  - Cloudflare account with a verified email
  - workers.dev subdomain chosen (Workers & Pages page)
  - custom domain on Cloudflare DNS, or `workers.dev` for now
  - Google account type (personal Gmail or Workspace); remember the answer for step 5
  - `node -v` within Node's supported releases
  - repo created with "Use this template" and cloned.
- **1:** `npx wrangler whoami`. If it isn't logged in, ask the user to run `! npx wrangler login`. Show the account name and ask the user to confirm it's the right account.
- **2:** Ask for owner email, display name, event title, page title/subtitle, privacy/terms URLs, accent colour and hostname choice. Edit `meet.config.json` and `wrangler.jsonc` `vars.OWNER_EMAIL`. Verify by printing both files.
- **3:**
  - `npx wrangler d1 create meet-kit`, then copy the `database_id` into `wrangler.jsonc`.
  - `npm run db:apply`.
  - Verify: `npx wrangler d1 execute meet-kit --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"` lists the 6 tables from `tests/schema.test.js`.
- **4:**
  - `npm install && npm test`, all passing.
  - `npx wrangler deploy`, then note the URL.
  - Verify: `curl -s -o /dev/null -w "%{http_code}" <url>/meet` → `200`, and `curl -s -o /dev/null -w "%{http_code}" <url>/api/admin/config` → `403`.
- **5 Google Cloud** (user, in browser): give click-by-click steps:
  - console.cloud.google.com → new project
  - APIs & Services → Library → Google Calendar API → Enable
  - OAuth consent screen: user type External (personal Gmail) or Internal (Workspace). Add the scopes `calendar.freebusy`, `calendar.calendarlist.readonly` and `calendar.events`. For External, add yourself as a test user, then **Publish app → In production**. Quote Google: an External app in Testing "is issued a refresh token expiring in 7 days".
  - Credentials → Create OAuth client ID → Web application → Authorized redirect URI exactly `<url>/admin/oauth/google/callback`.
  - The user gives the agent the Client ID (not secret). The agent sets `vars.GOOGLE_CLIENT_ID`.
  - The user runs `! npx wrangler secret put GOOGLE_CLIENT_SECRET` and pastes the secret into the prompt, not into chat.
  - Verify: `npx wrangler secret list` shows `GOOGLE_CLIENT_SECRET`.
- **6 Turnstile** (user, in browser): Cloudflare dashboard → Turnstile → Add widget, hostname = the deploy host, mode Managed.
  - The agent sets `vars.TURNSTILE_SITE_KEY`.
  - The user runs `! npx wrangler secret put TURNSTILE_SECRET_KEY`.
  - Verify with `secret list`.
- **7 Cloudflare Access** (user, in browser):
  - Zero Trust → choose a team name → Free plan.
  - Access → Applications → Add → Self-hosted. Domain: the deploy host. Paths `/admin` and `/api/admin`; add both as public hostnames with those paths.
  - Policy: Allow, Include → Emails → owner email.
  - Copy the team domain (`https://<team>.cloudflareaccess.com`) and the Application Audience (AUD) tag.
  - The agent sets `vars.ACCESS_TEAM_DOMAIN` and `vars.ACCESS_AUD`.
- **8:** `npx wrangler deploy`, then verify:
  - `curl -s -o /dev/null -w "%{http_code} %{redirect_url}" <url>/admin/` → `302 https://<team>.cloudflareaccess.com/...`
  - `curl -s -o /dev/null -w "%{http_code}" <url>/api/admin/config` → `403` (or 302 to Access)
  - the same two on the `*.workers.dev` hostname if a custom domain is used: `403`.
- **9 Connect calendars** (user): open `<url>/admin/` and sign in with the emailed code.
  - Click "Connect booking account" and approve.
  - The status list should show the booking account connected.
  - Read the "Unique Meet links" line and report it to the agent.
  - If it says not available, set a fixed meeting link and Save.
  - Add busy accounts and Zoho as wanted.
- **10 End-to-end:**
  - The user books `<url>/meet` from a *different* email.
  - Expected: an invite arrives at that email with a video link, and the event appears on the booking calendar.
  - Then cancel it on `<url>/admin/bookings.html`. Expected: the cancellation email arrives and the event disappears.
  - The agent reports each result back as pass or fail.
- **Troubleshooting table:**
  - `invalid_grant` after about a week → the consent screen is still in Testing (step 5).
  - `/meet` shows "No times available" → no booking account, a busy calendar unreadable, or a holiday calendar checked. Check `/admin/`.
  - The Turnstile widget is missing → `TURNSTILE_SITE_KEY` is unset, or the hostname isn't on the widget.
  - Admin always 403 → `OWNER_EMAIL` doesn't match the Access login email, or the AUD tag is wrong.

- [ ] **Step 4: Verify docs reference real names**

Run: `grep -on "GOOGLE_CLIENT_ID\|GOOGLE_CLIENT_SECRET\|TURNSTILE_SITE_KEY\|TURNSTILE_SECRET_KEY\|ACCESS_TEAM_DOMAIN\|ACCESS_AUD\|OWNER_EMAIL\|db:apply\|/admin/oauth/google/callback" DEPLOY-AGENT.md | sort -t: -k2 -u`
Expected: every name appears, and each matches `wrangler.jsonc`, `package.json` and `src/handlers/oauth.js` exactly.

Run: `npm test` (the leak check covers the new docs).

- [ ] **Step 5: Commit**

```bash
git add README.md DEPLOY-AGENT.md CLAUDE.md
git commit -m "docs: README, agent deploy runbook and CLAUDE.md"
```

---

### Task 14: Local smoke test with `wrangler dev`

**Files:** none (verification only). Use `.dev.vars`, which is gitignored, for local secrets.

- [ ] **Step 1: Local D1 and vars**

```bash
npm run db:apply:local
printf 'TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA\nGOOGLE_CLIENT_SECRET=dummy\n' > .dev.vars
```

(`1x0000000000000000000000000000000AA` is Cloudflare's documented always-pass Turnstile **test** secret. Confirm it on Cloudflare's Turnstile testing docs before relying on it.)

- [ ] **Step 2: Run and probe**

```bash
npx wrangler dev --port 8788 &
sleep 6
for p in /meet /picker.js /api/public/site /api/public/slots?duration=30 /api/admin/config /admin/ /administrator; do
  printf "%-28s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8788$p)"
done
kill %1
```

Expected:

| Path | Code |
|---|---|
| `/meet` | 200 |
| `/picker.js` | 200 |
| `/api/public/site` | 200 |
| `/api/public/slots?duration=30` | 200 (body `{"slots":[]...}`, no connection yet) |
| `/api/admin/config` | 403 |
| `/admin/` | 403 |
| `/administrator` | 404 |

Report the actual table. Any deviation is a bug: fix it with a test first.

- [ ] **Step 3: Record**

Append the observed table to `docs/baseline-2026-10-01.md` under "Local smoke (wrangler dev)" and commit:

```bash
git add docs/baseline-2026-10-01.md
git commit -m "docs: record local wrangler dev smoke results"
```

---

### Task 15: Template release prep (stop for Leo before the manual gate)

- [ ] **Step 1: Full suite + bundle**

```bash
date '+%H:%M:%S'; npm test 2>&1 | tail -8; date '+%H:%M:%S'
npx wrangler deploy --dry-run --outdir /tmp/meetkit-dry 2>&1 | tail -3
```

Expected: all pass, and the build succeeds. Report exact counts.

- [ ] **Step 2: Keep internal docs out of copies**

Template copies get the whole tree, and `docs/superpowers/` and `docs/baseline-*.md` name the source repo. Move them out of the template before marking it:

```bash
mkdir -p ~/Documents/MyApps/meet-kit/history
cp -R docs/superpowers docs/baseline-2026-10-01.md ~/Documents/MyApps/meet-kit/history/
git rm -r -q docs/superpowers docs/baseline-2026-10-01.md
git commit -m "chore: move build history out of the template tree"
```

Then remove `'docs'` from `SKIP_DIRS` in `tests/leak-check.test.js` and re-run `npm test`. It must still pass. Commit.

- [ ] **Step 3: Push and mark as template**

The orchestrator does this after reviewing the full diff, and **only after asking Leo to approve the push** (commits are session-approved; pushes are not).

```bash
git push origin main
gh repo edit llaskin/meet-kit --template
gh repo view llaskin/meet-kit --json isTemplate,visibility
```

Expected: `{"isTemplate":true,"visibility":"PRIVATE"}`.

- [ ] **Step 4: Live checks that tests can't cover (needs Leo)**

Stop and ask Leo to provide a **second** Cloudflare account and a **second** Google account, or a willing first invitee.

Then a fresh agent session follows `DEPLOY-AGENT.md` from step 0 to a booked and cancelled meeting. During the run, confirm and record:
1. the `calendar.events` scope created a unique Meet (`meet_url_source = 'unique'`), or report the scope error verbatim
2. if the fixed-link fallback was exercised, the PATCH with `conferenceData: null` removed the conference
3. whether a collaborator with **read** access could use "Use this template" (spec open question 2).

Every runbook step that's wrong gets fixed in `DEPLOY-AGENT.md` and committed before anyone else is invited.

- [ ] **Step 5: Interactive test runbook**

Per Leo's CLAUDE.md, invoke the `interactive-test-runbook` skill to produce the HTML checklist for Step 4. Save it in `~/Documents/MyApps/meet-kit/` (outside the template tree), hand Leo the absolute path, and wait for his results before starting any next spec.

---

## Self-review (completed while writing)

- **Spec coverage:**

  | Spec section | Task(s) |
  |---|---|
  | 1 Structure | 1, 3–5, 10, 11 |
  | 2 Schema | 2 |
  | Public flow | 8 |
  | Video link | 7, 8 |
  | Admin flow, layer 1 | 13 step 7 |
  | Admin flow, layer 2 | 6, 10 |
  | Admin features | 9, 11 |
  | Scope check | 7 (note), 15 step 4 |
  | Cron | 10 |
  | Section 3 runbook | 13 |
  | Updating | 13 README |
  | Section 4 baseline | 0, 3, 4 |
  | New tests | 6, 7, 8, 9, 10, 12 |
  | Leak check | 12 |
  | Manual gate | 15 |
  | Out of scope | not implemented |
  | Open Q1 (license) | 1 |
  | Open Q2 (template access) | 15 |
- **Placeholders:** Ported files are specified as "copy + exact listed edits", because the full source is long and stays the reference. Every new file is given in full.
- **Name consistency:**
  - Handlers: `loadCfg`, `createBookingEvent`/`NoLinkError`, `verifyAccess`, `siteConfig`, `cancelBooking(db, cfg, {id,...})`, handler signature `{request, env, params, waitUntil, owner, site}`.
  - Config keys: `write_calendar_id`, `write_calendar_meet` (`'1'`/`'0'`), `meet_link`.
  - Env: `DB` binding.
  - Browser global: `window.MEETKIT_PICKER`.
