CREATE TABLE "follow_request" (
	"requester_id" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_request_requester_id_target_id_pk" PRIMARY KEY("requester_id","target_id"),
	CONSTRAINT "follow_request_not_self" CHECK ("follow_request"."requester_id" <> "follow_request"."target_id")
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_type";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_private" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_request" ADD CONSTRAINT "follow_request_requester_id_user_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_request" ADD CONSTRAINT "follow_request_target_id_user_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_request_target_created_idx" ON "follow_request" USING btree ("target_id","created_at" DESC NULLS LAST,"requester_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "follow_request_requester_created_idx" ON "follow_request" USING btree ("requester_id","created_at" DESC NULLS LAST,"target_id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_type" CHECK ("notification"."type" in ('like', 'reply', 'repost', 'quote', 'follow', 'follow_request', 'moderation'));