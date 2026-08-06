CREATE TABLE "appeal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"appellant_id" text NOT NULL,
	"token_nonce" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reviewed_by" text,
	"review_note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp (3) with time zone,
	CONSTRAINT "appeal_token_nonce_unique" UNIQUE("token_nonce"),
	CONSTRAINT "appeal_status" CHECK ("appeal"."status" in ('open', 'upheld', 'overturned'))
);
--> statement-breakpoint
CREATE TABLE "moderation_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"target_type" text NOT NULL,
	"target_post_id" uuid,
	"target_user_id" text,
	"reason" text,
	"note" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_action_action" CHECK ("moderation_action"."action" in ('post_removed', 'post_restored', 'user_suspended', 'user_unsuspended', 'user_banned', 'user_unbanned', 'role_changed', 'case_resolved', 'appeal_resolved')),
	CONSTRAINT "moderation_action_target_type" CHECK ("moderation_action"."target_type" in ('post', 'user')),
	CONSTRAINT "moderation_action_one_target" CHECK (("moderation_action"."target_post_id" is null) <> ("moderation_action"."target_user_id" is null)),
	CONSTRAINT "moderation_action_target_match" CHECK (("moderation_action"."target_type" = 'post') = ("moderation_action"."target_post_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "report" (
	"reporter_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp (3) with time zone,
	"resolved_by" text,
	"resolved_outcome" text,
	"resolution_note" text,
	CONSTRAINT "report_reporter_id_target_type_target_id_pk" PRIMARY KEY("reporter_id","target_type","target_id"),
	CONSTRAINT "report_target_type" CHECK ("report"."target_type" in ('post', 'user')),
	CONSTRAINT "report_reason" CHECK ("report"."reason" in ('spam', 'harassment', 'hate_speech', 'misinformation', 'self_harm', 'illegal_content', 'nsfw', 'impersonation', 'underage')),
	CONSTRAINT "report_not_self" CHECK ("report"."reporter_id" <> "report"."target_id")
);
--> statement-breakpoint
CREATE TABLE "user_block" (
	"blocker_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_block_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "user_block_not_self" CHECK ("user_block"."blocker_id" <> "user_block"."blocked_id")
);
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "removed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "removed_by" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "removed_reason" text;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_action_id_moderation_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_appellant_id_user_id_fk" FOREIGN KEY ("appellant_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_action" ADD CONSTRAINT "moderation_action_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_action" ADD CONSTRAINT "moderation_action_target_post_id_post_id_fk" FOREIGN KEY ("target_post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_action" ADD CONSTRAINT "moderation_action_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_blocker_id_user_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_blocked_id_user_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appeal_open_idx" ON "appeal" USING btree ("status") WHERE "appeal"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "appeal_open_action_idx" ON "appeal" USING btree ("action_id") WHERE "appeal"."status" = 'open';--> statement-breakpoint
CREATE INDEX "moderation_action_created_idx" ON "moderation_action" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "moderation_action_target_idx" ON "moderation_action" USING btree ("target_type","target_post_id","target_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "report_open_idx" ON "report" USING btree ("created_at" DESC NULLS LAST,"target_type","target_id") WHERE "report"."resolved_at" is null;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;