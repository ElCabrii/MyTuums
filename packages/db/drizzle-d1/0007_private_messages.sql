CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`user_a_id` text NOT NULL,
	`user_b_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_message_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_a_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_b_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_pair_ordered" CHECK("conversation"."user_a_id" < "conversation"."user_b_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_pair_unique` ON `conversation` (`user_a_id`,`user_b_id`);--> statement-breakpoint
CREATE TABLE `conversation_participant` (
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`last_read_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`conversation_id`, `user_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_participant_status" CHECK("conversation_participant"."status" in ('pending', 'active', 'hidden'))
);
--> statement-breakpoint
CREATE INDEX `conversation_participant_user_idx` ON `conversation_participant` (`user_id`,`status`,`conversation_id`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_body_length" CHECK(length(trim("message"."body")) between 1 and 2000)
);
--> statement-breakpoint
CREATE INDEX `message_conversation_created_idx` ON `message` (`conversation_id`,"created_at" desc,"id" desc);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_report` (
	`reporter_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`snapshot_content` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`resolved_outcome` text,
	`resolution_note` text,
	PRIMARY KEY(`reporter_id`, `target_type`, `target_id`),
	FOREIGN KEY (`reporter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "report_target_type" CHECK("__new_report"."target_type" in ('post', 'user', 'message')),
	CONSTRAINT "report_reason" CHECK("__new_report"."reason" in ('spam', 'harassment', 'hate_speech', 'misinformation', 'self_harm', 'illegal_content', 'nsfw', 'impersonation', 'underage')),
	CONSTRAINT "report_not_self" CHECK("__new_report"."reporter_id" <> "__new_report"."target_id")
);
--> statement-breakpoint
INSERT INTO `__new_report`("reporter_id", "target_type", "target_id", "reason", "snapshot_content", "created_at", "resolved_at", "resolved_by", "resolved_outcome", "resolution_note") SELECT "reporter_id", "target_type", "target_id", "reason", "snapshot_content", "created_at", "resolved_at", "resolved_by", "resolved_outcome", "resolution_note" FROM `report`;--> statement-breakpoint
DROP TABLE `report`;--> statement-breakpoint
ALTER TABLE `__new_report` RENAME TO `report`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `report_open_idx` ON `report` ("created_at" desc,`target_type`,`target_id`) WHERE "report"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX `report_target_idx` ON `report` (`target_type`,`target_id`,"created_at" desc);