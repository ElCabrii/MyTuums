-- Narrows the app tables' timestamps from Postgres' default microsecond
-- precision to milliseconds, which is what a JS `Date` — and therefore a
-- JSON keyset cursor — can actually represent. See the comment on
-- post.created_at in packages/db/src/schema/app.ts for the row-skipping bug
-- this fixes.
--
-- No `USING` clause is needed here, unlike 0002_cold_blur.sql: these columns
-- are already `timestamptz`, so this only rounds the stored instants. 0002
-- was changing a naive `timestamp` into a zoned one, where Postgres would
-- otherwise have reinterpreted each value in the session's time zone.
--
-- Rounding is lossless for every consumer: all of them read these columns
-- through Drizzle into a JS Date, which discards sub-millisecond digits
-- anyway.

ALTER TABLE "follow" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "follow" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "post" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "post" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "post_like" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "post_like" ALTER COLUMN "created_at" SET DEFAULT now();