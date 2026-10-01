# meet-kit

## What it is

meet-kit is a personal booking page that runs on your own Cloudflare account.
Visitors open `/meet`, pick a time, and an invite with a video link lands on
your Google calendar and in their inbox. Busy time is read from any number of
Google calendars, and optionally from a Zoho calendar, so nobody can book over
something you already have.

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
address. The IP is kept only to enforce abuse limits on the booking form.

A nightly job (07:17 UTC) clears stored IP addresses 30 days after the booking
was made and deletes booking records 24 months after the meeting date. To change
those periods, edit `IP_RETENTION_DAYS` and `RECORD_RETENTION_MONTHS` in
`src/core/public-bookings.js`.

Calendar connection tokens and your settings live in the same D1 database in
your Cloudflare account. OAuth client secrets and the Turnstile secret are
Worker secrets, never stored in the database or in this repo.

## Updating

Copies made with "Use this template" do not receive updates on their own. To
pull in fixes:

```bash
git remote add upstream <URL of the meet-kit repo you were invited to>   # once
git pull upstream main
npm install && npm test && npx wrangler deploy
```

There is no `migrations/` directory yet -- `schema.sql` is the whole schema,
applied once. Later schema changes will ship as numbered files in
`migrations/` (`migrations/NNN_*.sql`), each with its apply command in the
file header; run any new ones before you deploy.

## Support

Shared as-is under the MIT license. No support, no hosting, no warranty. You own
your Cloudflare account, your calendar data and your keys.
