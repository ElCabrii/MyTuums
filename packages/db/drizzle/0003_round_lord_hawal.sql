CREATE TABLE "follow" (
	"follower_id" text NOT NULL,
	"following_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_follower_id_following_id_pk" PRIMARY KEY("follower_id","following_id"),
	CONSTRAINT "follow_not_self" CHECK ("follow"."follower_id" <> "follow"."following_id")
);
--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_follower_id_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_following_id_user_id_fk" FOREIGN KEY ("following_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_following_created_idx" ON "follow" USING btree ("following_id","created_at" DESC NULLS LAST,"follower_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "follow_follower_created_idx" ON "follow" USING btree ("follower_id","created_at" DESC NULLS LAST,"following_id" DESC NULLS LAST);