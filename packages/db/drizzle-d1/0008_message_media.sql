CREATE TABLE `message_attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	`media_path` text NOT NULL,
	`content_type` text NOT NULL,
	`video_id` text,
	`byte_size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `video`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_attachment_kind" CHECK("message_attachment"."kind" in ('image', 'voice', 'video')),
	CONSTRAINT "message_attachment_media_size" CHECK("message_attachment"."byte_size" > 0)
);
--> statement-breakpoint
CREATE INDEX `message_attachment_message_idx` ON `message_attachment` (`message_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_body_length" CHECK(length(trim("__new_message"."body")) <= 2000)
);
--> statement-breakpoint
INSERT INTO `__new_message`("id", "conversation_id", "sender_id", "body", "created_at", "deleted_at") SELECT "id", "conversation_id", "sender_id", "body", "created_at", "deleted_at" FROM `message`;--> statement-breakpoint
DROP TABLE `message`;--> statement-breakpoint
ALTER TABLE `__new_message` RENAME TO `message`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- Drizzle Kit quotes the whole `expr desc` term when emitting a rebuilt
-- table's indexes, which SQLite reads as one identifier. Corrected to the
-- plain form migration 0007 uses for the same index.
CREATE INDEX `message_conversation_created_idx` ON `message` (`conversation_id`,"created_at" desc,"id" desc);