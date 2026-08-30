CREATE TABLE "link_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"domain" text,
	"title" text,
	"description" text,
	"image_media_path" text,
	"fetched_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_card_title" CHECK (("link_card"."title" is null and "link_card"."domain" is null) or ("link_card"."title" is not null and "link_card"."domain" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "link_card_url_key" ON "link_card" USING btree ("url");