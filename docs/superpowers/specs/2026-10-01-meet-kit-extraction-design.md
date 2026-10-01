# meet-kit — Self-Hosted Booking Page Template — Design

**Date:** 2026-10-01
**Status:** Draft, awaiting Leo's review
**Source:** `~/Development/AIfindMyBusiness/scripts/cloudflare-cold-call-sheets/` (the `/meet` public booking feature,
spec `2026-09-14-meeting-duration-and-public-booking-design.md`)
**Repo:** private GitHub repo `llaskin/meet-kit` (mark as a template repository once the code lands).

---

## Goal

Extract `/meet` into a standalone repo that a few known people can copy, deploy to **their own**
Cloudflare account, and run as their own booking page against **their own** calendars.

Leo hosts nothing and operates nothing. Each copy is fully independent: its own Cloudflare
account, D1 database, Google OAuth client, Turnstile widget and Cloudflare Access policy.

## Decisions (made during brainstorming)

| Decision | Choice |
|---|---|
| Repo visibility | Private; invited collaborators use GitHub "Use this template" |
| Calendars | Exactly ONE booking (write) calendar, which is always Google; unlimited busy calendars across Google accounts and optional Zoho |
| Zoho | Busy-only, via meet-kit's own client (the existing `lib/zoho-calendar.js`, which already has zero imports; `@aifmb/zoho` is not used) |
| Host | Cloudflare only for v1 |
| Runtime | Cloudflare **Worker with static assets** + Hono router (not Pages) |
| Admin auth | Cloudflare Access **plus** in-Worker JWT verification |
| Video link | Per-booking unique Google Meet when the calendar supports it; owner's own fixed link as fallback/override |
| Who deploys | Each person deploys their own copy, by hand or with their AI coding agent via `DEPLOY-AGENT.md` |
| Call sheets consuming meet-kit | **Deferred** to a follow-on spec (see Out of scope) |

## Why Workers, not Pages

Cloudflare's [Pages → Workers migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
notes Workers have "a distinctly broader set of features available to it, (including Durable
Objects, Cron Triggers, and more comprehensive Observability)". Cron Triggers matter here:
today `purgeExpired` runs opportunistically inside the public slots handler, so retention only
happens when someone loads the page. Workers also support `_headers`/`_redirects` in the asset
directory, so nothing used today is lost. Hono keeps the router portable to Node/Deno/Vercel
if a non-Cloudflare host is ever wanted.

---

## 1. Repository structure

```
meet-kit/
  src/
    core/              no Cloudflare APIs, no env reads
      slots.js  tz.js  busy.js  durations.js
      google-calendar.js  zoho-calendar.js
      booking-core.js  public-bookings.js  cancel-booking.js
      rate-limit.js  turnstile.js  oauth-state.js  calendar-store.js
      access-jwt.js    NEW: Cf-Access-Jwt-Assertion verifier
      config.js        NEW: loads + validates meet.config.json
    worker.js          Hono router: /api/public/*, /api/admin/*, /admin/oauth/*, scheduled()
  public/
    meet.html  meet.js  picker.js (from booking.js, generic)
    admin/  index.html (calendars, rules, video link)  bookings.html
    _headers
  schema.sql           single combined schema (section 2)
  wrangler.jsonc       D1 id placeholder, vars placeholders, cron trigger
  meet.config.json     owner display name, event title, legal links, colours, logo path
  DEPLOY-AGENT.md      the deploy runbook (section 3)
  CLAUDE.md            points agents at DEPLOY-AGENT.md
  README.md            what it is, requirements, update instructions, no-support note
  LICENSE              choice deferred to Leo (open question 1)
  tests/
```

**Boundary rules**

- `src/core/` never touches `env`, `Request` headers, or Cloudflare globals. `worker.js` passes in
  the D1 handle, secrets, config and client IP. `CF-Connecting-IP` is read only in `worker.js`.
- Secrets live **only** in Cloudflare secrets: `GOOGLE_CLIENT_SECRET`, `ZOHO_CLIENT_SECRET`,
  `TURNSTILE_SECRET_KEY`. Today these OAuth client secrets sit in plaintext in `calendar_config`
  and are entered through the config page; that path is removed. No admin endpoint ever returns
  a secret value.
- Non-secret identifiers (`GOOGLE_CLIENT_ID`, `ZOHO_CLIENT_ID`, `TURNSTILE_SITE_KEY`,
  `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`) are `wrangler.jsonc` vars.

## 2. Data and request flow

### Schema (`schema.sql`)

Assembled from current migrations 002, 004, 005, 006, dropping call-sheet tables.

| Table | Source | Change |
|---|---|---|
| `calendar_connections` | 002 | Keep `idx_calendar_one_write` (partial UNIQUE on `role='write'`). Zoho connections may only be `busy` (enforced in the OAuth callback, tested). |
| `calendar_selections` | 002 | Unchanged; `busy` defaults to 1. |
| `calendar_config` | 002 | Holds rules, `write_calendar_id`, `meet_link` (fixed fallback), OAuth state key. **No client secrets.** |
| `public_bookings` | 004 + 006 | Keep inline `UNIQUE (start_utc)` and `calendar_id`. Add `meet_url_source TEXT CHECK (meet_url_source IN ('unique','fixed'))`. |
| `public_bookings_cancelled` | 006 | Unchanged. |
| `rate_counters` | 005 | Unchanged. |

Not carried: `call_state`, `bookings` (internal call-sheet bookings), migrations 001/003.

### Public flow (unauthenticated)

1. `GET /meet` — static page.
2. `GET /api/public/slots?duration=30|60` — `gatherBusy` over every busy calendar; any unreadable
   calendar yields zero slots (fail closed, unchanged). 60s edge cache (unchanged).
3. `POST /api/public/book` — existing order preserved: honeypot → field validation → Turnstile
   (server-side `siteverify`, fail closed) → email/IP/total caps → exact-membership check
   against a freshly computed slot grid → create event → save row.
   - Event title comes from `meet.config.json` (fixed; no visitor text in the subject).
   - Video link (new):
     - If the booking calendar's `conferenceProperties.allowedConferenceSolutionTypes` includes
       `hangoutsMeet`, create the event with `conferenceData.createRequest`
       (`conferenceSolutionKey.type = 'hangoutsMeet'`, unique `requestId`) and
       `conferenceDataVersion=1`.
     - Conference creation is asynchronous ([Google: create events](https://developers.google.com/workspace/calendar/api/guides/create-events)).
       If the status is still `pending`, poll the event a bounded number of times (budget
       defined in the plan, well under the Worker request limit).
     - If it fails or stays pending, and a fixed `meet_link` is set, patch the event to use the
       fixed link; `meet_url_source='fixed'`.
     - If neither is available, delete the event and return the generic error. Nothing is
       recorded. A booking is never confirmed without a working link.
   - UNIQUE `start_utc` violation → delete the just-created event, return "taken" (409).
4. All public errors collapse to the existing generic message; no calendar names, emails,
   upstream status or stack ever reach the visitor (unchanged rule).

### Admin flow (owner only)

Routes: `/admin*`, `/api/admin/*`, `/admin/oauth/{google|zoho}/{start|callback}`.

**Layer 1 — Cloudflare Access** self-hosted application covering `/admin*` and `/api/admin*` on
the owner's hostname, policy: email equals `OWNER_EMAIL`.

**Layer 2 — Worker-side JWT check (the actual guarantee).** Every admin route verifies
`Cf-Access-Jwt-Assertion` per [Cloudflare's validation guide](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/):
JWKS from `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, `issuer = ACCESS_TEAM_DOMAIN`,
`audience = ACCESS_AUD`, RS256 only, not expired, and `email` claim equal to `OWNER_EMAIL`
(case-insensitive). Uses the `jose` library with an injectable JWKS fetcher for tests.

Any missing var (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`) → every admin route returns
403. Admin is therefore locked from the very first deploy, before Access exists. This also
covers the `*.workers.dev` hostname, which Access does not protect unless configured to.
A custom domain is recommended, not required.

The OAuth callback sits under `/admin`, so it is covered by both layers; the owner's browser
carries the Access cookie back from Google.

Admin features (all carried over): connect Google/Zoho accounts; toggle busy calendars; choose
the booking calendar and `write_calendar_id`; edit rules (timezone, weekdays, hours, notice,
horizon, interval); set fixed `meet_link`; see "Unique Meet links: available / not available
on this calendar"; list upcoming bookings; cancel (delete event on the stored `calendar_id`,
move row to the cancelled ledger).

Scope check (to verify during implementation): the existing scopes are `calendar.freebusy`,
`calendar.calendarlist.readonly`, `calendar.events`. Confirm that `calendar.events` permits
`conferenceData.createRequest`, and that `conferenceProperties` is readable via
`calendarList` under `calendarlist.readonly`. If either fails, the scope change is called out
before shipping, not silently widened.

### Cron (nightly, `scheduled()`)

Runs `purgeExpired`: null IPs older than `IP_RETENTION_DAYS` (30), delete records older than
`RECORD_RETENTION_MONTHS` (24), and sweep stale `rate_counters`. The README states both
retention windows. The opportunistic purge in the slots handler is removed.

## 3. Deploy runbook (`DEPLOY-AGENT.md`)

Numbered steps, each tagged **[agent]** or **[you, in a browser]**. Every agent step ends with a
read-back verification. Rules for the agent:

- Never ask for a secret in chat. The person types each one: `! npx wrangler secret put NAME`.
- One step at a time; verify; on failure stop and give the exact fix.
- Admin is locked from first deploy (layer 2 fails closed), so partial setups are safe.

**0. [agent, conversation only] Prerequisites, before any command runs.**
- Cloudflare account exists (free signup at `dash.cloudflare.com/sign-up`) and its email is
  verified.
- A `workers.dev` subdomain is registered (Workers & Pages, one time), or the first deploy
  will stop to ask.
- Custom domain? Only if it is already on Cloudflare DNS; otherwise use `workers.dev` for now.
- Google account that owns the booking calendar, and whether it is personal Gmail or
  Workspace (decides step 5).
- Node.js: Wrangler supports Node's Current, Active and Maintenance releases
  ([Wrangler install docs](https://developers.cloudflare.com/workers/wrangler/install-and-update/));
  agent runs `node -v` and checks against that.
- Their own copy of the repo via "Use this template", cloned locally.

**1. [agent]** `npx wrangler login` if needed, then `npx wrangler whoami`. Show the account name
and ask the person to confirm it is the right account (multi-account trap).

**2. [agent]** Collect owner email, display name, event title, timezone, optional privacy/terms
URLs, hostname choice. Write `meet.config.json` and `OWNER_EMAIL` var.

**3. [agent]** `npx wrangler d1 create meet-kit`, write the id into `wrangler.jsonc`,
`npx wrangler d1 execute meet-kit --remote --file=schema.sql`, then list tables to verify.

**4. [agent]** First `npx wrangler deploy`. Verify with curl: `/meet` → 200,
`/api/admin/config` → 403.

**5. [you, in a browser] Google Cloud.** Create project → enable Google Calendar API → OAuth
consent screen → create a "Web application" OAuth client with the exact redirect URI the agent
prints (`https://<host>/admin/oauth/google/callback`). Client ID → agent sets the var; client
secret → `! npx wrangler secret put GOOGLE_CLIENT_SECRET`.
- **Personal Gmail:** user type External, then **publish the app ("In production")**. Google
  states that an External app in Testing status "is issued a refresh token expiring in 7 days"
  ([Google OAuth 2.0 docs](https://developers.google.com/identity/protocols/oauth2)); left in
  Testing, the calendar connection silently dies after a week. In production, the owner clicks
  through the unverified-app warning once.
- **Workspace:** user type Internal; no expiry issue, no warning.

**6. [you] Turnstile.** Create a widget for the hostname. Site key → agent writes the var;
secret → `! npx wrangler secret put TURNSTILE_SECRET_KEY`.

**7. [you] Cloudflare Access.** Enable Zero Trust (free plan), create a self-hosted application
for `/admin*` and `/api/admin*` on the hostname, policy "email = owner". Give the agent the team
domain and the application AUD tag (not secret); agent writes `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD`.

**8. [agent]** Redeploy. Verify: `/admin` → 302 to `<team>.cloudflareaccess.com`;
`/api/admin/config` with no token → 403; same request on the `workers.dev` hostname → 403.

**9. [you]** Open `/admin`, sign in through Access, connect Google, choose the booking calendar
and busy calendars, read the "Unique Meet links" status. Zoho optional (busy-only; client secret
via `secret put`).

**10. [you, agent guiding]** Book a test slot on `/meet` from a different email; confirm the invite
and link arrive; cancel it from `/admin`; confirm the cancellation email arrives.

**Updating later (README):** template copies do not receive updates. To pull fixes:
`git remote add upstream git@github.com:llaskin/meet-kit.git` then `git pull upstream main`
and redeploy. Schema changes ship as numbered files in `migrations/` with apply commands.

## 4. Testing

**Baseline before the move.** Run the call-sheets `node:test` suite and record pass counts for
every test file whose subject moves (`slots`, `tz`, `durations`, `google-calendar`,
`google-delete-event`, `zoho-calendar`, `calendar-store`, `oauth-state`, `rate-limit`,
`turnstile`, `public-bookings-store`, `public-cache`, `cancel-booking`, `cancellation-store`,
`public-slots-api`, `public-book-api`, `meet-page`, `meet-duration-grid`). In meet-kit the same
tests pass with the same counts; any dropped or changed assertion gets a written reason.
Runner stays `node:test`.

**New tests**

- `access-jwt`: valid token accepted; rejected for wrong audience, wrong issuer, expired, wrong
  email, missing header, bad signature, unknown `kid`, `alg: none`, HS256; missing vars → 403.
  Local key pair, no network.
- Admin route coverage: iterate the router's registered routes; every `/admin*` and
  `/api/admin*` route returns 403 without a valid token. New routes are covered automatically.
- Public non-leak: each internal failure (no write connection, unreadable calendar, expired
  token, Turnstile network error, caps) returns the generic message only.
- Video link: `createRequest` sent only when `hangoutsMeet` is allowed; pending → poll → success;
  pending/failed → fixed-link fallback; neither → event deleted and nothing recorded; UNIQUE
  race → event deleted.
- Secrets: the admin config endpoint never returns any secret value.
- Zoho cannot become the write connection.
- Cron: purge boundaries for both retention windows.
- **Leak check:** fail if the repo contains `aifindmybusiness`, `AIFMB`, `laskin`, `devrev`,
  `7301c7b4-bbb8-4f32-a6ce-ca5b3e3d429b`, `org_3Dthhdve6MC7xfTv0b0NnUCgArr`, or the old
  fixed Meet link. The test's own pattern list is the one allowed occurrence. Runs in CI.

**Manual gate before inviting anyone.** A fresh agent session works through `DEPLOY-AGENT.md`
from step 0 on a **second** Cloudflare account and a **second** Google account, ending with a
booked and cancelled test meeting. Every step that fails is fixed in the runbook first. (A
previous runbook shipped 3 of 11 steps wrong because nothing executed it.) An interactive test
runbook HTML covering this is produced per Leo's CLAUDE.md feature rule.

## Out of scope (v1)

- Switching `scripts/cloudflare-cold-call-sheets` to import meet-kit: **follow-on spec**. Until
  then the call sheets keep their own copies, and the two drift. The follow-on must reconcile
  any fix made on either side.
- Non-Cloudflare hosts.
- Multiple booking calendars.
- Attendee self-cancel/reschedule, multiple meeting types, reminders.
- Leo hosting or supporting anyone's instance.

## Open questions for Leo

1. **License:** MIT, or an "all rights reserved, shared for personal use" notice?
2. **Private template access:** GitHub says "Anyone with access to the template repository can
   create a new repository based on the template"
   ([GitHub docs](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template)).
   It is unconfirmed whether **read** access is enough for a private template; verify with the
   first invitee. Fallback: invite with read access, and they clone and push to a new repo of
   their own.

## Manual steps (Leo)

- Mark `llaskin/meet-kit` as a template repository once the code lands.
- Provide the second Cloudflare and Google accounts (or a willing first invitee) for the
  pre-release run-through.
