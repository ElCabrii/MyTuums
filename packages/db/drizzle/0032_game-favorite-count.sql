ALTER TABLE "game" ADD COLUMN "favorite_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "game_favorite_count_idx" ON "game" USING btree ("favorite_count","igdb_id");