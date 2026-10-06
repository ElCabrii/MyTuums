-- D1 keeps foreign keys enabled. Preserve descendants across the parent
-- rebuild and suspend attachment cleanup only inside this migration batch.
CREATE TABLE __group_backup_conversation_participant AS SELECT * FROM conversation_participant;
--> statement-breakpoint
CREATE TABLE __group_backup_message AS SELECT * FROM message;
--> statement-breakpoint
CREATE TABLE __group_backup_message_attachment AS SELECT * FROM message_attachment;
--> statement-breakpoint
DROP TRIGGER message_attachment_media_deleted;
--> statement-breakpoint
DROP TRIGGER message_attachment_video_deleted;
--> statement-breakpoint
CREATE TABLE `__new_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`user_a_id` text,
	`user_b_id` text,
	`kind` text DEFAULT 'direct' NOT NULL,
	`name` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_message_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_a_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_b_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_pair_ordered" CHECK(("__new_conversation"."kind" = 'direct' and "__new_conversation"."user_a_id" is not null and "__new_conversation"."user_b_id" is not null and "__new_conversation"."user_a_id" < "__new_conversation"."user_b_id" and "__new_conversation"."name" is null) or ("__new_conversation"."kind" = 'group' and "__new_conversation"."user_a_id" is null and "__new_conversation"."user_b_id" is null and "__new_conversation"."name" is not null and length(trim("__new_conversation"."name")) between 1 and 80))
);
--> statement-breakpoint
INSERT INTO `__new_conversation`("id", "user_a_id", "user_b_id", "kind", "name", "created_at", "last_message_at") SELECT "id", "user_a_id", "user_b_id", 'direct', NULL, "created_at", "last_message_at" FROM `conversation`;--> statement-breakpoint
DROP TABLE `conversation`;--> statement-breakpoint
ALTER TABLE `__new_conversation` RENAME TO `conversation`;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_pair_unique` ON `conversation` (`user_a_id`,`user_b_id`);--> statement-breakpoint
INSERT INTO conversation_participant SELECT * FROM __group_backup_conversation_participant;
--> statement-breakpoint
DROP TABLE __group_backup_conversation_participant;
--> statement-breakpoint
INSERT INTO message SELECT * FROM __group_backup_message;
--> statement-breakpoint
DROP TABLE __group_backup_message;
--> statement-breakpoint
INSERT INTO message_attachment SELECT * FROM __group_backup_message_attachment;
--> statement-breakpoint
DROP TABLE __group_backup_message_attachment;
--> statement-breakpoint
-- A message tombstone retains evidence. Hard deletion (including account
-- cascades) retires its storage through durable, owner-independent cleanup.
CREATE TRIGGER message_attachment_media_deleted BEFORE DELETE ON message_attachment
WHEN OLD.kind IN ('image', 'voice')
BEGIN
  INSERT INTO media_intent (id, scope, kind, paths, ready_at)
  VALUES (lower(hex(randomblob(16))), 'message:' || OLD.message_id, 'cleanup',
    json_array(OLD.media_path), cast(unixepoch('subsec') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER message_attachment_video_deleted BEFORE DELETE ON message_attachment
WHEN OLD.video_id IS NOT NULL
BEGIN
  UPDATE video SET state = 'deleted', upload_url = NULL WHERE id = OLD.video_id;
END;
--> statement-breakpoint
ALTER TABLE `conversation_participant` ADD `membership` text DEFAULT 'joined' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_participant` ADD `invited_by` text;--> statement-breakpoint
ALTER TABLE `conversation_participant` ADD `invited_at` integer;--> statement-breakpoint
ALTER TABLE `conversation_participant` ADD `departed_at` integer;--> statement-breakpoint
CREATE INDEX `conversation_participant_inviter_idx` ON `conversation_participant` (`invited_by`,`invited_at`);