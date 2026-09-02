CREATE TABLE "post_repost" (
	"post_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_repost_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quoted_post_id" uuid;--> statement-breakpoint
ALTER TABLE "post_repost" ADD CONSTRAINT "post_repost_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_repost" ADD CONSTRAINT "post_repost_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_repost_created_idx" ON "post_repost" USING btree ("created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST,"user_id" DESC NULLS LAST);