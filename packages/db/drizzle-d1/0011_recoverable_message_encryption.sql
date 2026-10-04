CREATE TABLE `message_identity` (
	`user_id` text PRIMARY KEY NOT NULL,
	`public_identity` text NOT NULL,
	`backup` text NOT NULL,
	`recovery_key_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_recovery` (
	`user_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`session_id` text NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`transport_key` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `message` ADD `envelope` text;