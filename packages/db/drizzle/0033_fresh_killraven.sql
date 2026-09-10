ALTER TABLE "game" ADD COLUMN "hype_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game" ADD COLUMN "first_release_date" integer;--> statement-breakpoint
CREATE INDEX "game_hype_idx" ON "game" USING btree ("hype_count","igdb_id");