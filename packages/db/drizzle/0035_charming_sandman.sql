CREATE TABLE "feed_rank_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viewer_id" text NOT NULL,
	"scope" text NOT NULL,
	"q" text,
	"game_slug" text,
	"game_hashtag_key" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_interests" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "feed_rank_snapshot_scope" CHECK ("feed_rank_snapshot"."scope" in ('global', 'following', 'discover'))
);
--> statement-breakpoint
ALTER TABLE "feed_rank_snapshot" ADD CONSTRAINT "feed_rank_snapshot_viewer_id_user_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feed_rank_snapshot_viewer_expires_idx" ON "feed_rank_snapshot" USING btree ("viewer_id","expires_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feed_rank_snapshot_expires_idx" ON "feed_rank_snapshot" USING btree ("expires_at");