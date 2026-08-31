CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" text NOT NULL,
	"actor_id" text,
	"type" text NOT NULL,
	"post_id" uuid,
	"action_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_type" CHECK ("notification"."type" in ('like', 'reply', 'follow', 'moderation')),
	CONSTRAINT "notification_post_ref" CHECK (("notification"."type" in ('like', 'reply')) = ("notification"."post_id" is not null)),
	CONSTRAINT "notification_action_ref" CHECK (("notification"."type" = 'moderation') = ("notification"."action_id" is not null)),
	CONSTRAINT "notification_not_self" CHECK ("notification"."actor_id" is null or "notification"."actor_id" <> "notification"."recipient_id")
);
--> statement-breakpoint
CREATE TABLE "notification_last_seen" (
	"recipient_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_action_id_moderation_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."moderation_action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_last_seen" ADD CONSTRAINT "notification_last_seen_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_recipient_created_idx" ON "notification" USING btree ("recipient_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);