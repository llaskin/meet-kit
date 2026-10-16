-- 002: no-show stamp on bookings. Additive and nullable; old rows read NULL.
-- Both tables, so a cancelled no-show keeps its stamp in the ledger.
-- Apply once to an EXISTING deployment (fresh installs get it from schema.sql):
--   npx wrangler d1 execute meet-kit --remote --file=migrations/002_booking_no_show.sql
ALTER TABLE public_bookings ADD COLUMN no_show_at TEXT;
ALTER TABLE public_bookings ADD COLUMN no_show_by TEXT;
ALTER TABLE public_bookings_cancelled ADD COLUMN no_show_at TEXT;
ALTER TABLE public_bookings_cancelled ADD COLUMN no_show_by TEXT;
