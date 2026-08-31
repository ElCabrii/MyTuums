ALTER TABLE "link_card" ADD COLUMN "purged_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "link_card" ADD COLUMN "purged_by" text;--> statement-breakpoint
ALTER TABLE "link_card" ADD COLUMN "purged_reason" text;--> statement-breakpoint
ALTER TABLE "link_card" ADD CONSTRAINT "link_card_purged_by_user_id_fk" FOREIGN KEY ("purged_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;