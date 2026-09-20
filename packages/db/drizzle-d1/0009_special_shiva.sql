PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_message_attachment` (
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
	FOREIGN KEY (`video_id`) REFERENCES `video`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "message_attachment_kind" CHECK("__new_message_attachment"."kind" in ('image', 'voice', 'video')),
	CONSTRAINT "message_attachment_media_size" CHECK("__new_message_attachment"."byte_size" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_message_attachment`("id", "message_id", "position", "kind", "media_path", "content_type", "video_id", "byte_size", "width", "height", "duration_ms", "created_at") SELECT "id", "message_id", "position", "kind", "media_path", "content_type", "video_id", "byte_size", "width", "height", "duration_ms", "created_at" FROM `message_attachment`;--> statement-breakpoint
DROP TABLE `message_attachment`;--> statement-breakpoint
ALTER TABLE `__new_message_attachment` RENAME TO `message_attachment`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `message_attachment_message_idx` ON `message_attachment` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_attachment_media_path_idx` ON `message_attachment` (`media_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_attachment_video_idx` ON `message_attachment` (`video_id`);