CREATE INDEX "game_name_idx" ON "game" USING btree ("name","igdb_id");--> statement-breakpoint
CREATE INDEX "game_popularity_idx" ON "game" USING btree (coalesce("popularity_rank", 2147483647),"igdb_id");--> statement-breakpoint
CREATE INDEX "game_year_idx" ON "game" USING btree (coalesce("first_release_year", 0),"igdb_id");