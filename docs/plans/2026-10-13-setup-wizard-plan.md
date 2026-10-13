# Setup wizard — implementation plan

Spec: `docs/specs/2026-10-13-setup-wizard-design.md`. TDD per task; full suite
after each.

0. Housekeeping: `tests/leak-check.test.js` skips `graphify-out` (a local tool
   cache, never shipped) and `.gitignore` lists it plus `.setup-state.json`.
1. `scripts/setup/checks.mjs` — validators (email, https URL, hex colour,
   Google client ID, Turnstile site key, Access team domain normaliser, AUD) and
   wrangler output parsers (whoami JSON, d1 list JSON, d1 execute table names,
   secret list JSON, deploy URL, missing-subdomain detection, test summary).
   Tests: `tests/setup-checks.test.js`.
2. `scripts/setup/config-files.mjs` — `readVar`, `setVar`, `readDatabaseId`,
   `setDatabaseId` on `wrangler.jsonc` text; `updateMeetConfig` on
   `meet.config.json`. Comments survive; unknown key throws.
   Tests: `tests/setup-config-files.test.js`.
3. `scripts/setup/wrangler.mjs` — `createWrangler({ run, accountId })`: whoami,
   login, d1List, d1Create, applySchema, tables, deploy, secretNames,
   secretPut (stdin). Default runner spawns wrangler without a shell.
   Tests: `tests/setup-wrangler.test.js` (fake runner records argv/stdin/env).
4. `scripts/setup/steps.mjs` — `createSetup({ root, wrangler, fetch, runTests,
   stateFile })` with `status()` and one action per step; probes with retry.
   Tests: `tests/setup-steps.test.js` (temp dir copy of the two config files).
5. `scripts/setup/server.mjs` + `page.html` + `page.js` — HTTP server with
   token/Host/Origin checks, JSON API mapping to step actions, opens browser;
   `npm run setup`. Tests: `tests/setup-server.test.js`.
6. Docs: README "Set it up" gets the wizard as the first option;
   `DEPLOY-AGENT.md` mentions it; render the page with fake status and inspect.
7. Interactive test runbook for the real run (needs a Cloudflare + Google
   account).
