CREATE TABLE `game_summary_translation` (
	`game_id` integer NOT NULL,
	`locale` text NOT NULL,
	`source_summary` text NOT NULL,
	`summary` text NOT NULL,
	PRIMARY KEY(`game_id`, `locale`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`igdb_id`) ON UPDATE no action ON DELETE cascade
);
