CREATE TABLE "link_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"domain" text,
	"title" text,
	"description" text,
	"image_media_path" text,
	"fetched_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp (3) with time zone,
	"purged_by" text,
	"purged_reason" text,
	CONSTRAINT "link_card_title" CHECK (("link_card"."title" is null and "link_card"."domain" is null) or ("link_card"."title" is not null and "link_card"."domain" is not null))
);
--> statement-breakpoint
ALTER TABLE "link_card" ADD CONSTRAINT "link_card_purged_by_user_id_fk" FOREIGN KEY ("purged_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "link_card_url_key" ON "link_card" USING btree ("url");