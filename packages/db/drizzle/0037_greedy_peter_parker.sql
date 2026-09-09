CREATE TABLE "video" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" text,
	"post_id" uuid,
	"state" text DEFAULT 'uploading' NOT NULL,
	"byte_size" integer NOT NULL,
	"source_key" text NOT NULL,
	"multipart_id" text,
	"attempt_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp (3) with time zone,
	"source_deleted_at" timestamp (3) with time zone,
	"playback" jsonb,
	"assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_state" CHECK ("video"."state" in ('uploading', 'uploaded', 'queued', 'processing', 'ready', 'published', 'failed', 'cancelled', 'deleted')),
	CONSTRAINT "video_byte_size" CHECK ("video"."byte_size" > 0 and "video"."byte_size" <= 500000000),
	CONSTRAINT "video_attempts" CHECK ("video"."attempts" >= 0),
	CONSTRAINT "video_ready_assets" CHECK ("video"."state" not in ('ready', 'published') or ("video"."playback" is not null and "video"."attempt_id" is not null and jsonb_array_length("video"."assets") > 0)),
	CONSTRAINT "video_published_source" CHECK ("video"."state" <> 'published' or "video"."source_deleted_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "video_cleanup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"source_key" text,
	"multipart_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_submission" (
	"video_id" uuid PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL,
	"post_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"parent_id" uuid,
	"quoted_post_id" uuid,
	"is_private" boolean NOT NULL,
	"caption" text,
	"caption_language" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_submission_target" CHECK ("video_submission"."parent_id" is null or "video_submission"."quoted_post_id" is null)
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_type";--> statement-breakpoint
ALTER TABLE "post_attachment" DROP CONSTRAINT "post_attachment_content_type";--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "video_id" uuid;--> statement-breakpoint
ALTER TABLE "post_attachment" ADD COLUMN "video_id" uuid;--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_submission" ADD CONSTRAINT "video_submission_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_submission" ADD CONSTRAINT "video_submission_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_post_idx" ON "video" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_source_idx" ON "video" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "video_state_expiry_idx" ON "video" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "video_author_created_idx" ON "video" USING btree ("author_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "video_cleanup_prefix_idx" ON "video_cleanup" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "video_cleanup_next_attempt_idx" ON "video_cleanup" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "video_submission_post_idx" ON "video_submission" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "video_submission_author_idx" ON "video_submission" USING btree ("author_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "post_attachment" ADD CONSTRAINT "post_attachment_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_video_idx" ON "notification" USING btree ("video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_attachment_video_idx" ON "post_attachment" USING btree ("video_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_video_ref" CHECK (("notification"."type" = 'video_failed') = ("notification"."video_id" is not null));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_video_actor" CHECK ("notification"."type" <> 'video_failed' or "notification"."actor_id" is null);--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_type" CHECK ("notification"."type" in ('like', 'reply', 'repost', 'quote', 'follow', 'follow_request', 'moderation', 'video_failed'));--> statement-breakpoint
ALTER TABLE "post_attachment" ADD CONSTRAINT "post_attachment_content_type" CHECK (("post_attachment"."video_id" is null and "post_attachment"."content_type" in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')) or ("post_attachment"."video_id" is not null and "post_attachment"."content_type" = 'application/vnd.apple.mpegurl' and "post_attachment"."position" = 0));