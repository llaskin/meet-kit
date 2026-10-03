-- 001: meeting topic on bookings. Additive and nullable; old rows read NULL.
-- Apply once to an EXISTING deployment (fresh installs get it from schema.sql):
--   npx wrangler d1 execute meet-kit --remote --file=migrations/001_booking_topic.sql
ALTER TABLE public_bookings ADD COLUMN topic TEXT;
ALTER TABLE public_bookings_cancelled ADD COLUMN topic TEXT;
