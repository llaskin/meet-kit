# meet-kit

## What it is

meet-kit is a personal booking page that runs on your own Cloudflare account.
Visitors open `/meet`, pick a time, and an invite with a video link lands on
your Google calendar and in their inbox. Busy time is read from any number of
Google calendars, and optionally from a Zoho calendar, so nobody can book over
something you already have.

You can also offer a short list of meeting topics ("What's the call about?");
the chosen topic goes into the event title.

You manage it from `/admin/`, which is locked behind Cloudflare Access so only
your email can sign in. From there you connect calendars, set your working
hours and time zone, and see or cancel bookings.

It is one Cloudflare Worker with a small D1 database. There is no server for
you to run and no third-party booking service in the middle.

## What you need

- A Cloudflare account (the free plan is enough).
- A Google account that owns the calendar you want bookings to land on. A
  personal Gmail account or a Google Workspace account both work.
- Node.js, a current, active or maintenance LTS release (22.13 or newer).

## Set it up

Open this folder in your AI coding agent and say *deploy meet-kit for me*. It
follows `DEPLOY-AGENT.md`, one step at a time, and asks you to do the parts that
need a browser (Google Cloud, Turnstile, Cloudflare Access).

Or follow `DEPLOY-AGENT.md` by hand. Every command and every expected result is
written out there.

You never paste a secret into a chat. Each one is typed straight into Wrangler
with `npx wrangler secret put <NAME>`.

## Costs

For personal use it fits inside Cloudflare's free tier. Limits change, so check
the current numbers yourself:

- Workers: https://developers.cloudflare.com/workers/platform/pricing/
- D1: https://developers.cloudflare.com/d1/platform/pricing/

Google Calendar API use for a personal booking page stays well inside Google's
free quota.

## What it stores

For each booking: the visitor's name, email, company and notes, and their IP
address. The IP is kept only to enforce abuse limits on the booking form. If
you mark a past meeting as a no-show on `/admin/bookings.html`, the time of
that click and your email are stored on the booking too.

A nightly job (07:17 UTC) clears stored IP addresses 30 days after the booking
was made and deletes booking records 24 months after the meeting date. To change
those periods, edit `IP_RETENTION_DAYS` and `RECORD_RETENTION_MONTHS` in
`src/core/public-bookings.js`.

Calendar connection tokens and your settings live in the same D1 database in
your Cloudflare account. OAuth client secrets and the Turnstile secret are
Worker secrets, never stored in the database or in this repo.

## Webhook (optional)

meet-kit can tell another system about bookings as they happen. It is off
unless you set it up; nothing else changes when it is on.

**What it sends.** One HTTPS `POST` per event, with a JSON body:

```json
{
  "type": "booking.created",
  "id": "<booking id>",
  "occurred_at": "<ISO 8601 UTC>",
  "booking": {
    "id": "…", "created_at": "…", "attendee_email": "…", "attendee_name": "…",
    "company": "…", "duration_min": 30, "start_utc": "…", "end_utc": "…",
    "topic": "…", "meet_url": "…", "event_id": "…", "calendar_id": "…"
  }
}
```

**The three events.**

| `type` | When | Extra fields in `booking` |
|---|---|---|
| `booking.created` | a visitor booked on `/meet` and the record was saved | — |
| `booking.cancelled` | you cancelled it from `/admin/bookings.html` and the record moved | `cancelled_at`, `cancelled_by` |
| `booking.no_show` | you clicked **Mark no-show** on a past meeting (once per booking) | `no_show_at`, `no_show_by` |

The visitor's **notes** and **IP address are never sent.**

**Headers.** `X-Meet-Event` is the `type`, `X-Meet-Delivery` is a unique id
per attempt, and `X-Meet-Signature-256` is the lowercase hex HMAC-SHA256 of
the raw request body, keyed with your `BOOKING_WEBHOOK_SECRET`. Verify it
before trusting anything in the body:

```
raw      = the request body, exactly as received (bytes, not re-serialised JSON)
expected = hex( HMAC_SHA256( key = BOOKING_WEBHOOK_SECRET, message = raw ) )
given    = request.header("X-Meet-Signature-256")
if not constant_time_equal(given, expected): reject with 400
event    = json_parse(raw)
handle(event)   # make it idempotent on event.id: a redelivery must be harmless
```

**Delivery.** Best-effort: one attempt, a 10-second timeout, fired after the
booking record is written and after the visitor's (or your) response is on its
way. A slow or failing receiver never delays or fails a booking. There are no
retries; the result of each attempt is in the Worker logs as
`[booking-webhook] <type> <id> -> <status|error>`. Treat the admin page as the
source of truth and the webhook as a notification.

**Turn it on.**

1. Set `vars.BOOKING_WEBHOOK_URL` in `wrangler.jsonc` to your receiver's
   `https://` URL (plain `http://` is ignored).
2. Run `npx wrangler secret put BOOKING_WEBHOOK_SECRET` and enter a long
   random string. Give the same string to the receiver.
3. If this deployment predates the no-show action, apply
   `migrations/002_booking_no_show.sql` (see "Updating").
4. `npx wrangler deploy`.

To turn it off, empty `BOOKING_WEBHOOK_URL` and deploy again.

## Updating

Copies made with "Use this template" do not receive updates on their own. To
pull in fixes:

```bash
git remote add upstream <URL of the meet-kit repo you were invited to>   # once
git pull upstream main
npm install && npm test
# then apply any NEW migrations/NNN_*.sql files, oldest first -- BEFORE deploying:
#   npx wrangler d1 execute meet-kit --remote --file=migrations/NNN_name.sql
# e.g. the no-show columns: migrations/002_booking_no_show.sql
npx wrangler deploy
```

Schema changes ship as numbered files in `migrations/` (`migrations/NNN_*.sql`),
each with its apply command in the file header. Run any new ones, oldest first,
before you deploy -- see "Updating an existing deployment" in `DEPLOY-AGENT.md`.
Fresh installs only need `schema.sql`.

## Support

Shared as-is under the MIT license. No support, no hosting, no warranty. You own
your Cloudflare account, your calendar data and your keys.
