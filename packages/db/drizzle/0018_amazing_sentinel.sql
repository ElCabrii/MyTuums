CREATE TABLE "post_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"media_path" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_attachment_position" CHECK ("post_attachment"."position" >= 0),
	CONSTRAINT "post_attachment_byte_size" CHECK ("post_attachment"."byte_size" > 0),
	CONSTRAINT "post_attachment_dimensions" CHECK ("post_attachment"."width" > 0 and "post_attachment"."height" > 0),
	CONSTRAINT "post_attachment_content_type" CHECK ("post_attachment"."content_type" in ('image/png', 'image/jpeg', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "post_attachment" ADD CONSTRAINT "post_attachment_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_attachment_position_idx" ON "post_attachment" USING btree ("post_id","position");