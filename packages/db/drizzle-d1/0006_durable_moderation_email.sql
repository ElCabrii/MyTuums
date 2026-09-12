CREATE TABLE `moderation_email` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`source_id` text NOT NULL,
	`user_id` text NOT NULL,
	`locale` text NOT NULL,
	`content` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`lease_id` text,
	`lease_until` integer,
	`failed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer) + 86400000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "moderation_email_locale" CHECK("moderation_email"."locale" in ('en', 'fr')),
	CONSTRAINT "moderation_email_attempts" CHECK("moderation_email"."attempts" >= 0),
	CONSTRAINT "moderation_email_lease" CHECK(("moderation_email"."lease_id" is null) = ("moderation_email"."lease_until" is null)),
	CONSTRAINT "moderation_email_content" CHECK(json_valid("moderation_email"."content"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `moderation_email_id_unique` ON `moderation_email` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `moderation_email_source_user_unique` ON `moderation_email` (`source_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `moderation_email_due_idx` ON `moderation_email` (`failed_at`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `moderation_email_expiry_idx` ON `moderation_email` (`expires_at`);--> statement-breakpoint
CREATE INDEX `moderation_email_user_sequence_idx` ON `moderation_email` (`user_id`,`sequence`);