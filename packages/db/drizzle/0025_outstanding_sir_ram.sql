CREATE TABLE "post_edit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "edited_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "snapshot_content" text;--> statement-breakpoint
ALTER TABLE "post_edit" ADD CONSTRAINT "post_edit_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_edit_post_created_idx" ON "post_edit" USING btree ("post_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);