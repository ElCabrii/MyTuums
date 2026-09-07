DROP INDEX "post_like_user_idx";--> statement-breakpoint
CREATE INDEX "post_like_user_created_idx" ON "post_like" USING btree ("user_id","created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST);