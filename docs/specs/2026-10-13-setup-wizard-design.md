# Setup wizard (local web page) — design

Date: 2026-10-13. Branch: `feat/setup-wizard` (off `main`). Target: Cloudflare only.

## Goal

Someone who has just downloaded meet-kit runs `npm install` then `npm run setup`
and is walked through the whole Cloudflare deployment in a browser page, without
an AI agent and without reading `DEPLOY-AGENT.md`. The wizard runs every command
that can be scripted and, for the steps that can only be done in a dashboard,
opens the right page, says what to click with her own values filled in, and
checks what she pastes back.

## Approved shape

- `npm run setup` → `node scripts/setup/server.mjs`: a Node HTTP server (built-ins
  only) on `127.0.0.1`, random port, opens the page in the default browser.
- The page is one HTML file plus one script, step cards that mirror
  `DEPLOY-AGENT.md` steps 1–10, so the two never disagree.
- Quit-and-resume: status is derived from the files the wizard edits
  (`wrangler.jsonc`, `meet.config.json`) plus a gitignored `.setup-state.json`
  holding only non-secret facts (chosen account id, deployed URL, Gmail vs
  Workspace, results of live checks, ticked manual steps). Every step has a
  re-check that runs its live check again.

## Steps

| # | Step | Wizard runs | Person does | Done when |
|---|---|---|---|---|
| 1 | Cloudflare login | `wrangler login`, `wrangler whoami --json`; account picker when >1 | approves login | logged in and one account chosen |
| 2 | About you | writes `meet.config.json` keys and `vars.OWNER_EMAIL` | fills a form | `OWNER_EMAIL` set |
| 3 | Database | `d1 list --json` (reuse) or `d1 create meet-kit`, writes `database_id`, applies `schema.sql`, lists tables | — | the 6 tables exist |
| 4 | First deploy | runs the test suite (any failure stops), `wrangler deploy`, probes `/meet` = 200 and `/api/admin/config` = 403 | registers a workers.dev subdomain only if wrangler reports none | probes pass |
| 5 | Google Cloud | Gmail/Workspace-specific steps with her redirect URI; validates client ID; `secret put GOOGLE_CLIENT_SECRET` | creates project, consent screen, OAuth client | var set + secret listed |
| 6 | Turnstile | her hostname filled in; validates site key; tests the secret against siteverify; `secret put TURNSTILE_SECRET_KEY` | creates widget | var set + secret listed |
| 7 | Access | validates team domain (fetches its `/cdn-cgi/access/certs`) and AUD (64 hex) | creates Zero Trust team + Access app | both vars set |
| 8 | Redeploy + lock check | `wrangler deploy`; `/admin/` must 302 to the team domain; `/api/admin/config` 403 or 302; `/%61dmin/` and `//admin/` must not be 200 | — | no admin path returned 200 |
| 9 | Calendar + hours | links to `<url>/admin/`, checklist from DEPLOY-AGENT step 9 | does it | ticked |
| 10 | End-to-end test | links to `/meet` and `/admin/bookings.html`, checklist from step 10 | books + cancels | ticked |

Each step is enabled only once the previous ones are done.

## Security model

The server can run deploy commands and receives secrets, so:

- Listens on `127.0.0.1` only.
- A 32-byte random token is generated per run and put in the opened URL's
  fragment-free query; every `/api/*` request must carry it in an
  `X-Setup-Token` header (constant-time compare). The page itself is served
  only with the token in the query string.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS
  rebinding); a `POST` with an `Origin` header must have that same origin.
- Only a fixed set of wrangler sub-commands is run, via `spawn` with an
  argument array (no shell). Wrangler is started as
  `node node_modules/wrangler/bin/wrangler.js` so it works the same on macOS,
  Linux and Windows.
- Secrets go to `wrangler secret put NAME` on stdin (wrangler reads stdin when
  not interactive). They are never written to disk, logged, kept in memory
  after the call, or echoed in a response.
- Values written into `wrangler.jsonc` are validated first and JSON-encoded.

## Editing `wrangler.jsonc`

It has comments, so it is never parsed and re-serialised. Edits are targeted
string replacements of a known key's string value (`"OWNER_EMAIL": "..."`,
`"database_id": "..."`), and the edit throws if the key is not found exactly
once.

## Out of scope (v1)

Custom domains (the workers.dev hostname is used), Zoho (linked to the doc),
the Vercel target, migrations for existing deployments.

## Testing

Pure modules (validators, output parsers, `wrangler.jsonc` edits, step status,
step actions with a fake wrangler runner and fake fetch) are unit-tested with
`node:test`. The server is tested by starting it on port 0 with fakes and
checking token, Host and Origin enforcement and that a secret never appears in
a response. Tests never spawn wrangler.
