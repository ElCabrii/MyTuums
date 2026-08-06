ALTER TABLE "moderation_action" DROP CONSTRAINT "moderation_action_target_post_id_post_id_fk";
--> statement-breakpoint
ALTER TABLE "moderation_action" DROP CONSTRAINT "moderation_action_target_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "appeal_open_idx";--> statement-breakpoint
CREATE INDEX "report_target_idx" ON "report" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "appeal_open_idx" ON "appeal" USING btree ("status","created_at" DESC NULLS LAST) WHERE "appeal"."status" = 'open';