# Deploying meet-kit (runbook for an AI agent, or for you by hand)

Each step is tagged **[agent]** (the agent runs commands) or **[you, in a browser]**
(the person deploying does it and reports back). Every step ends with a check and
the result it should produce.

## Rules for the agent

- **Never ask for a secret in chat.** The person types each secret straight into
  Wrangler with `! npx wrangler secret put NAME` (the `!` runs it in their own
  shell from the agent prompt). Client IDs, the Turnstile site key, the Access
  team domain and the Access AUD tag are not secrets and may be pasted in chat.
- One step at a time. Run the check. If it fails, stop, say exactly what failed,
  and give the fix. Do not move on.
- Admin is locked from the first deploy: until `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`
  and `ACCESS_AUD` are all set, every `/admin` and `/api/admin` request gets 403.
  A half-finished setup is safe to leave overnight.
- Do not deploy with failing tests.

Throughout, `<host>` is the hostname the site is served on (a custom domain, or
`meet-kit.<subdomain>.workers.dev`) and `<url>` is `https://<host>`.

---

## 0. Prerequisites [agent, conversation only]

Ask these before running any command. Continue only when every answer is yes
(or known).

1. Do you have a Cloudflare account with a verified email? If not: sign up free at
   https://dash.cloudflare.com/sign-up and click the verification email.
2. Have you chosen a `workers.dev` subdomain? (Dashboard, Workers & Pages. It is a
   one-time choice per account.) If not, the first deploy stops to ask for one.
3. Will you use a custom domain? Only if that domain is already on Cloudflare DNS.
   Otherwise use the `workers.dev` hostname for now.
4. Is the Google account that owns your booking calendar a personal Gmail account
   or a Google Workspace account? Remember the answer for step 5.
5. Run `node -v`. Wrangler supports Node's Current, Active and Maintenance releases
   (https://developers.cloudflare.com/workers/wrangler/install-and-update/), and
   `package.json` requires 22.13 or newer. If it is older, ask the person to
   install a current LTS release first.
6. Did you create your own copy of the repo with "Use this template", and is it
   cloned locally? The agent should be running inside that clone.

## 1. Cloudflare login [agent]

```bash
npx wrangler whoami
```

If it says you are not logged in, ask the person to run `! npx wrangler login` and
approve in the browser, then run `npx wrangler whoami` again.

**Check:** show the account name and account ID it prints and ask the person to
confirm it is the right account. Wrangler users often have more than one.

## 2. Owner settings [agent]

Ask for:

- owner email (the address that will sign in to `/admin`; it must be the exact
  email they will use with Cloudflare Access in step 7)
- display name
- event title (the calendar event's title, e.g. "Intro call")
- page title and page subtitle for `/meet`
- privacy policy URL and terms URL (optional; must start with `https://`)
- accent colour (hex, e.g. `#0b6cff`)
- hostname: custom domain or `workers.dev`

Edit `meet.config.json` (keys `displayName`, `pageTitle`, `pageSubtitle`,
`eventTitle`, `privacyUrl`, `termsUrl`, `accentColor`) and set
`vars.OWNER_EMAIL` in `wrangler.jsonc`.

If a custom domain was chosen, add it to `wrangler.jsonc` as a route:

```jsonc
"routes": [{ "pattern": "<host>", "custom_domain": true }]
```

The time zone and working hours are not set here. They are set on the admin page
in step 9.

**Check:** print `meet.config.json` and the `vars` block of `wrangler.jsonc`, and
have the person confirm each value.

## 3. Database [agent]

```bash
npx wrangler d1 create meet-kit
```

Copy the `database_id` it prints into `wrangler.jsonc`, replacing
`REPLACE_WITH_D1_ID`. Then apply the schema:

```bash
npm run db:apply
```

(`db:apply` runs `wrangler d1 execute meet-kit --remote --file=schema.sql`.)

**Check:**

```bash
npx wrangler d1 execute meet-kit --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected: exactly these 6 tables (the same list `tests/schema.test.js` asserts):
`calendar_config`, `calendar_connections`, `calendar_selections`,
`public_bookings`, `public_bookings_cancelled`, `rate_counters`. Cloudflare may
also list its own internal `_cf_KV` table; ignore it.

## 4. First deploy [agent]

```bash
npm install && npm test
```

Expected: every test passes (`fail 0`). Stop if anything fails.

```bash
npx wrangler deploy
```

Note the URL it prints. This deploy also registers the nightly retention cron
(`17 7 * * *`, 07:17 UTC: IP addresses are cleared 30 days after a booking is
made, booking records are deleted 24 months after the meeting date) and turns on
Workers observability (logs in the dashboard).

**Check:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" <url>/meet
curl -s -o /dev/null -w "%{http_code}\n" <url>/api/admin/config
```

Expected: `200`, then `403`. The 403 is correct: admin is locked until step 8.

## 5. Google Cloud [you, in a browser]

Give the person these steps one at a time.

1. Open https://console.cloud.google.com, click the project picker, then **New
   project**. Name it (e.g. `meet-kit`) and create it. Make sure it is selected.
2. **APIs & Services → Library**, search **Google Calendar API**, click it, then
   **Enable**.
3. **OAuth consent screen** (Google Auth Platform):
   - **Personal Gmail:** user type **External**. Fill in the app name and your
     email. Add the scopes `https://www.googleapis.com/auth/calendar.freebusy`,
     `https://www.googleapis.com/auth/calendar.calendarlist.readonly` and
     `https://www.googleapis.com/auth/calendar.events`. Add yourself as a test
     user. Then **Publish app → In production**. This matters: Google states that
     an External app in Testing status "is issued a refresh token expiring in 7
     days" (https://developers.google.com/identity/protocols/oauth2). Left in
     Testing, the calendar connection silently stops working after a week. Once
     in production you will click through an "unverified app" warning once when
     you connect; that is expected for a private app.
   - **Google Workspace:** user type **Internal**. Add the same three scopes. No
     publishing step, no expiry, no warning.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Under **Authorized redirect URIs** add exactly:

   ```
   <url>/admin/oauth/google/callback
   ```

   It must be the host you will open `/admin/` on in step 9. If you use a custom
   domain, use the custom domain here, not `workers.dev`.
5. Copy the **Client ID** and give it to the agent. Do not paste the client
   secret into chat.

[agent] Set `vars.GOOGLE_CLIENT_ID` in `wrangler.jsonc` to that value. Then ask
the person to run:

```bash
! npx wrangler secret put GOOGLE_CLIENT_SECRET
```

and paste the client secret at Wrangler's prompt.

**Check:** `npx wrangler secret list` includes `GOOGLE_CLIENT_SECRET`.

### Optional: Zoho (busy time only)

Zoho is read for busy time only; bookings are never written to it. To use it:

1. In the Zoho API Console (https://api-console.zoho.com), add a **Server-based
   Application** with redirect URI exactly `<url>/admin/oauth/zoho/callback`.
2. Give the agent the Client ID; the agent sets `vars.ZOHO_CLIENT_ID`.
3. The person runs `! npx wrangler secret put ZOHO_CLIENT_SECRET`.
4. The Zoho account must live in one of the data centres meet-kit accepts:
   `accounts.zoho.com`, `accounts.zoho.eu`, `accounts.zoho.in`,
   `accounts.zoho.com.au`, `accounts.zoho.jp`, `accounts.zoho.ca`,
   `accounts.zoho.sa`, `accounts.zoho.uk`, `accounts.zoho.com.cn`. Any other
   region is refused with "Unknown Zoho region".

The connection itself is made in step 9.

## 6. Turnstile [you, in a browser]

1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Hostname: `<host>`. If `/meet` will also be used on the `workers.dev`
   hostname, add that too.
3. Widget mode: **Managed**. Create it.
4. Give the agent the **site key**. Do not paste the secret key into chat.

[agent] Set `vars.TURNSTILE_SITE_KEY`. Then ask the person to run:

```bash
! npx wrangler secret put TURNSTILE_SECRET_KEY
```

**Check:** `npx wrangler secret list` includes `TURNSTILE_SECRET_KEY`.

## 7. Cloudflare Access [you, in a browser]

1. Cloudflare dashboard → **Zero Trust**. The first time, choose a team name and
   the **Free** plan.
2. **Access → Applications → Add an application → Self-hosted.**
3. Add two public hostnames, both with domain `<host>`: one with path `admin`
   and one with path `api/admin`.
4. Policy: action **Allow**, Include → **Emails** → the owner email from step 2.
5. Save. Then copy:
   - the team domain, `https://<team>.cloudflareaccess.com` (Zero Trust →
     Settings → Custom Pages / team domain)
   - the application's **Application Audience (AUD) Tag** (application →
     Overview / Basic information)
6. Recommended hardening: in the application's **Advanced settings → Cookie
   settings**, set the **SameSite Attribute** to **Lax**. Cloudflare's docs list
   the default for the `CF_Authorization` cookie as None and describe Lax as
   allowing the cookie "with top-level navigations"
   (https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/).
   meet-kit already refuses cross-site admin writes on its own (every admin write
   must be a same-origin JSON request), so this is a second layer, not a
   requirement. Do not choose Strict: Cloudflare warns it "can result in too many
   redirects", and the Google/Zoho OAuth callback is a cross-site top-level
   navigation that Lax still allows.

[agent] Set `vars.ACCESS_TEAM_DOMAIN` (e.g. `https://<team>.cloudflareaccess.com`)
and `vars.ACCESS_AUD` in `wrangler.jsonc`.

Why both layers: Access protects the hostname you configured. The Worker also
checks the Access token itself (signature, issuer, audience, expiry, and that the
email equals `OWNER_EMAIL`), which is what protects the `workers.dev` hostname and
any path Access does not cover.

## 8. Redeploy and prove admin is locked [agent]

```bash
npx wrangler deploy
```

**Check on `<host>`:**

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" <url>/admin/
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" <url>/api/admin/config
```

Expected: `302 https://<team>.cloudflareaccess.com/...` for `/admin/`, and `403`
(or a 302 to Access) for `/api/admin/config`.

Path-bypass probes. `--path-as-is` stops curl from cleaning the path first:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" --path-as-is "<url>/%61dmin/"
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" --path-as-is "<url>//admin/"
```

Expected: each returns `307` with a redirect to `<url>/admin/` (which then 302s
to Access, as above). **Unverified on a real deployed host**: the `307` was
only observed locally under `wrangler dev` (Cloudflare's local asset layer
normalising the path before the Worker's own gate ever runs), not yet against
an actual deployed Pages/Workers asset host -- the production asset layer
may normalise these paths differently (collapsing slashes, decoding `%61`) and
return something other than `307`. That's fine either way: the gate in
`src/worker.js` computes its own canonical form and does not rely on this
redirect, so the only thing that matters here is the pass criterion below.

**Check on the `workers.dev` hostname** (only if you use a custom domain;
`<wd>` = `https://meet-kit.<subdomain>.workers.dev`):

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" <wd>/admin/
curl -s -o /dev/null -w "%{http_code}\n" <wd>/api/admin/config
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" --path-as-is "<wd>/%61dmin/"
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" --path-as-is "<wd>//admin/"
```

Expected: `403` for `/admin/` and `/api/admin/config`. The two bypass forms are
expected to end at a `403` (whether directly, or via a `307` first) -- same
caveat as above: which of those two you actually see on a deployed host is
unverified, so don't treat a `403` with no `307` first as a failure.

**The pass criterion, regardless of whether you see a `307` first: any `200`
from an admin path in this step is a failure.** Stop and report it; do not
continue to step 9.

## 9. Connect calendars and set hours [you, in a browser]

The OAuth flow must be done on the deployed HTTPS host. It uses a
`__Host-meetkit_oauth` cookie that binds the sign-in to the browser that started
it, and browsers only set `__Host-` cookies over HTTPS. It will fail on a
plain-http host such as a local `wrangler dev`.

1. Open `<url>/admin/` and sign in through Access with the emailed code.
2. Click **Connect booking account** and approve. Expected: the Status list shows
   "Booking account connected" and the page shows `Connected: <account>`.
3. Under **Calendar that receives bookings**, pick the calendar. It must be one
   the booking account owns or can write to (Google `accessRole` owner or
   writer); others are refused when you save.
4. Read the **Unique Meet links** line and tell the agent what it says.
   - "available on this calendar": each booking gets its own Meet room.
   - "not available on this calendar": enter a **Fixed meeting link**
     (`https://...`). Setting one is also worth doing when Meet is available, as
     a fallback. A booking is never confirmed without a video link.
5. **Availability rules:** set **Time zone**, **Weekdays** (1=Mon … 7=Sun,
   comma separated) and **Day starts / Day ends**. The defaults are
   `America/New_York`, Mon–Fri (`1,2,3,4,5`), `09:00`–`17:00`. Leaving them means
   offering Eastern business hours. Adjust minimum notice and booking horizon if
   wanted.
6. Optional: **Meeting topics.** One topic per line (up to 12, each up to 40
   characters), and tick **Offer "Other" with a short custom topic** if you
   want visitors to describe their own. Leave the list empty and unticked to
   hide the question on `/meet`. The chosen topic is added to the event title,
   e.g. `Intro call: Audit review`; custom ones read `Other – <their words>` and
   may not contain links, email addresses, domains or phone numbers.
7. Click **Save settings**. Expected: "Saved." An invalid value (for example a
   topic named "Other", or more than 12) shows the problem and saves nothing.
8. Optional: **Add a Google account (busy only)** for each other calendar whose
   events should block time. Every discovered calendar starts TICKED (counted
   as busy) by default -- untick any calendar that shouldn't block time, such
   as a holiday or birthday calendar, which would otherwise block whole days.
9. Optional Zoho: enter the **Zoho account email**, click **Save settings**, then
   **Connect Zoho**.

Each account has a **Disconnect** button (click it twice to confirm).
Disconnecting the booking account also clears the chosen booking calendar. An
account already connected as busy-only cannot be reconnected as the booking
account: disconnect it first, then use **Connect booking account**.

## 10. End-to-end test [you, agent guiding]

1. From a **different** email address than the owner's, book a slot on
   `<url>/meet`.
   Expected: an invite arrives at that address with a video link, and the event
   appears on the booking calendar.
2. Open `<url>/admin/bookings.html` and cancel that booking.
   Expected: a cancellation email arrives and the event disappears from the
   calendar.

The agent reports each result as pass or fail.

## 11. Optional: outbound webhook [agent, then you]

Skip this unless another system should be told about bookings. What it sends,
and how to verify the signature, is in `README.md` under "Webhook (optional)".

1. Ask for the receiver's URL. It must start with `https://`. The agent sets
   `vars.BOOKING_WEBHOOK_URL` in `wrangler.jsonc` to it.
2. The person runs:

   ```bash
   ! npx wrangler secret put BOOKING_WEBHOOK_SECRET
   ```

   and enters a long random string (32 or more characters). The receiver needs
   the same string; the agent never sees it.
3. **Existing deployments only** (set up before the no-show action existed):
   apply the migration first, or marking a no-show fails:

   ```bash
   npx wrangler d1 execute meet-kit --remote --file=migrations/002_booking_no_show.sql
   ```

   Fresh installs already have these columns from `schema.sql`.
4. ```bash
   npx wrangler deploy
   ```

**Check:** `npx wrangler secret list` includes `BOOKING_WEBHOOK_SECRET`. Then
book a test slot on `<url>/meet`: the receiver gets one `booking.created` POST
with a valid `X-Meet-Signature-256`, and `npx wrangler tail` shows
`[booking-webhook] booking.created <id> -> <status>`. Cancel it from
`<url>/admin/bookings.html` for a `booking.cancelled`. A `-> error` or non-2xx
status in the log is the receiver's problem, not a failed booking: the booking
itself always goes through.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `invalid_grant` after about a week | The Google consent screen is still in Testing. Publish it to In production (step 5), then disconnect and reconnect. |
| `/meet` says no times are available | No booking account connected, a busy calendar can't be read, a holiday calendar is ticked as busy, or the hours/weekdays exclude everything. Check `/admin/`. |
| Turnstile widget missing on `/meet` | `TURNSTILE_SITE_KEY` is unset, or the hostname isn't on the widget (step 6). |
| Admin always 403 | `OWNER_EMAIL` doesn't match the email you sign in to Access with, the AUD tag is wrong, or `ACCESS_TEAM_DOMAIN` is wrong (step 7). |
| OAuth callback: "this sign-in was not started in this browser" | The flow was not done over HTTPS on the deployed host, or cookies were blocked. Start again from `<url>/admin/`. |
| Google `redirect_uri_mismatch` | The redirect URI in Google Cloud must be exactly `<url>/admin/oauth/google/callback` for the host you opened `/admin/` on. |
| Admin save returns 403 or 415 | Admin writes must be same-origin JSON. Use the admin page itself, not a script or another site. |
| "Unknown Zoho region" | The Zoho account is in a data centre not on the list in step 5. |

## Updating an existing deployment

Pull the changes, test, apply any NEW migration files in order, then deploy:

```bash
git pull upstream main
npm install && npm test
# one line per NEW migration since your last update, oldest first, e.g. for 001 and 002:
npx wrangler d1 execute meet-kit --remote --file=migrations/001_booking_topic.sql
npx wrangler d1 execute meet-kit --remote --file=migrations/002_booking_no_show.sql
npx wrangler deploy
```

Run each `migrations/NNN_*.sql` file exactly once, oldest first, and only the
ones added since your last update (the file header says what it changes).
Fresh installs don't need them: `schema.sql` already includes every column.
Deploying new code before its migration breaks booking: every attempt creates
the calendar event, fails to save it, deletes it again and shows the visitor an
error. Migrate first. Re-running a migration that was already applied fails with
"duplicate column" and changes nothing.

## Known unverified (first deployer, please check and report)

These behaviours are covered by unit tests against mocked Google responses but
have not yet been confirmed against the live Google Calendar API:

1. Whether the `calendar.events` scope alone is enough for Google to create a
   unique Meet room per booking (`conferenceData.createRequest`). If step 9 shows
   Meet as available but bookings fall back to the fixed link, report it.
2. Whether a PATCH with `conferenceData: null` actually removes a failed
   conference from the event when meet-kit falls back to the fixed link.
3. Whether the original invite email includes the Meet link when the room was
   still pending at the moment the event was created. Check the invite in
   step 10 for a working link.
