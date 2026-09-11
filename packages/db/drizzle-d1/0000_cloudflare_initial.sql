CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_userId_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentialID_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `twoFactor_secret_idx` ON `two_factor` (`secret`);--> statement-breakpoint
CREATE INDEX `twoFactor_userId_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`username` text,
	`display_username` text,
	`role` text,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer,
	`two_factor_enabled` integer DEFAULT false,
	`last_login_method` text,
	`date_of_birth` integer,
	`bio` text,
	`banner_image` text,
	`image_original` text,
	`banner_image_original` text,
	`theme_preference` text,
	`locale_preference` text,
	`legal_accepted_at` integer,
	`legal_version` text,
	`is_private` integer DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `appeal` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`appellant_id` text NOT NULL,
	`token_nonce` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`reviewed_by` text,
	`review_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`action_id`) REFERENCES `moderation_action`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`appellant_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "appeal_status" CHECK("appeal"."status" in ('open', 'upheld', 'overturned', 'reversed', 'superseded', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appeal_token_nonce_unique` ON `appeal` (`token_nonce`);--> statement-breakpoint
CREATE INDEX `appeal_open_idx` ON `appeal` (`status`,"created_at" desc) WHERE "appeal"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX `appeal_open_action_idx` ON `appeal` (`action_id`) WHERE "appeal"."status" = 'open';--> statement-breakpoint
CREATE TABLE `feed_rank_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`viewer_id` text NOT NULL,
	`scope` text NOT NULL,
	`q` text,
	`game_slug` text,
	`game_hashtag_key` text,
	`items` text DEFAULT '[]' NOT NULL,
	`has_interests` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`viewer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "feed_rank_snapshot_scope" CHECK("feed_rank_snapshot"."scope" in ('global', 'following', 'discover'))
);
--> statement-breakpoint
CREATE INDEX `feed_rank_snapshot_viewer_expires_idx` ON `feed_rank_snapshot` (`viewer_id`,"expires_at" desc);--> statement-breakpoint
CREATE INDEX `feed_rank_snapshot_expires_idx` ON `feed_rank_snapshot` (`expires_at`);--> statement-breakpoint
CREATE TABLE `follow` (
	`follower_id` text NOT NULL,
	`following_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`follower_id`, `following_id`),
	FOREIGN KEY (`follower_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`following_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "follow_not_self" CHECK("follow"."follower_id" <> "follow"."following_id")
);
--> statement-breakpoint
CREATE INDEX `follow_following_created_idx` ON `follow` (`following_id`,"created_at" desc,"follower_id" desc);--> statement-breakpoint
CREATE INDEX `follow_follower_created_idx` ON `follow` (`follower_id`,"created_at" desc,"following_id" desc);--> statement-breakpoint
CREATE TABLE `follow_request` (
	`requester_id` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`requester_id`, `target_id`),
	FOREIGN KEY (`requester_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "follow_request_not_self" CHECK("follow_request"."requester_id" <> "follow_request"."target_id")
);
--> statement-breakpoint
CREATE INDEX `follow_request_target_created_idx` ON `follow_request` (`target_id`,"created_at" desc,"requester_id" desc);--> statement-breakpoint
CREATE INDEX `follow_request_requester_created_idx` ON `follow_request` (`requester_id`,"created_at" desc,"target_id" desc);--> statement-breakpoint
CREATE TABLE `game` (
	`igdb_id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`hashtag_key` text NOT NULL,
	`name` text NOT NULL,
	`summary` text,
	`cover_media_path` text,
	`cover_image_id` text,
	`first_release_year` integer,
	`genres` text DEFAULT '[]' NOT NULL,
	`platforms` text DEFAULT '[]' NOT NULL,
	`popularity_rank` integer,
	`favorite_count` integer DEFAULT 0 NOT NULL,
	`hype_count` integer DEFAULT 0 NOT NULL,
	`first_release_date` integer,
	`last_synced_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_slug_unique` ON `game` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `game_hashtag_key_unique` ON `game` (`hashtag_key`);--> statement-breakpoint
CREATE INDEX `game_name_idx` ON `game` (`name`,`igdb_id`);--> statement-breakpoint
CREATE INDEX `game_favorite_count_idx` ON `game` (`favorite_count`,`igdb_id`);--> statement-breakpoint
CREATE INDEX `game_hype_idx` ON `game` (`hype_count`,`igdb_id`);--> statement-breakpoint
CREATE TABLE `game_catalog_row` (
	`version_id` text NOT NULL,
	`igdb_id` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`version_id`, `igdb_id`),
	FOREIGN KEY (`version_id`) REFERENCES `game_catalog_version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `game_catalog_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`active_version` text,
	`running_version` text,
	`lease_until` integer,
	FOREIGN KEY (`active_version`) REFERENCES `game_catalog_version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`running_version`) REFERENCES `game_catalog_version`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "game_catalog_singleton" CHECK("game_catalog_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `game_catalog_version` (
	`id` text PRIMARY KEY NOT NULL,
	`synced_at` integer NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE TABLE `game_favorite` (
	`game_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`game_id`, `user_id`),
	FOREIGN KEY (`game_id`) REFERENCES `game`(`igdb_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_favorite_user_created_idx` ON `game_favorite` (`user_id`,"created_at" desc,"game_id" desc);--> statement-breakpoint
CREATE TABLE `job_intent` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`dispatched_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	CONSTRAINT "job_intent_kind" CHECK("job_intent"."kind" in ('video', 'game-sync', 'maintenance'))
);
--> statement-breakpoint
CREATE INDEX `job_intent_due_idx` ON `job_intent` (`dispatched_at`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `link_card` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`domain` text,
	`title` text,
	`description` text,
	`image_media_path` text,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`purged_at` integer,
	`purged_by` text,
	`purged_reason` text,
	FOREIGN KEY (`purged_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "link_card_title" CHECK(("link_card"."title" is null and "link_card"."domain" is null) or ("link_card"."title" is not null and "link_card"."domain" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_card_url_key` ON `link_card` (`url`);--> statement-breakpoint
CREATE TABLE `media_intent` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`paths` text NOT NULL,
	`ready_at` integer NOT NULL,
	CONSTRAINT "media_intent_kind" CHECK("media_intent"."kind" in ('upload', 'cleanup'))
);
--> statement-breakpoint
CREATE INDEX `media_intent_ready_idx` ON `media_intent` (`ready_at`);--> statement-breakpoint
CREATE INDEX `media_intent_scope_ready_idx` ON `media_intent` (`scope`,`ready_at`);--> statement-breakpoint
CREATE TABLE `moderation_action` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`actor_id` text,
	`target_type` text NOT NULL,
	`target_post_id` text,
	`target_user_id` text,
	`reason` text,
	`note` text,
	`details` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "moderation_action_action" CHECK("moderation_action"."action" in ('post_removed', 'post_restored', 'user_suspended', 'user_unsuspended', 'user_banned', 'user_unbanned', 'role_changed', 'case_resolved', 'appeal_resolved')),
	CONSTRAINT "moderation_action_target_type" CHECK("moderation_action"."target_type" in ('post', 'user')),
	CONSTRAINT "moderation_action_one_target" CHECK(("moderation_action"."target_post_id" is null) <> ("moderation_action"."target_user_id" is null)),
	CONSTRAINT "moderation_action_target_match" CHECK(("moderation_action"."target_type" = 'post') = ("moderation_action"."target_post_id" is not null))
);
--> statement-breakpoint
CREATE INDEX `moderation_action_created_idx` ON `moderation_action` ("created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `moderation_action_target_idx` ON `moderation_action` (`target_type`,`target_post_id`,`target_user_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_id` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`post_id` text,
	`action_id` text,
	`video_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_id`) REFERENCES `moderation_action`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_type" CHECK("notification"."type" in ('like', 'reply', 'repost', 'quote', 'follow', 'follow_request', 'moderation', 'video_failed')),
	CONSTRAINT "notification_post_ref" CHECK(("notification"."type" in ('like', 'reply', 'repost', 'quote')) = ("notification"."post_id" is not null)),
	CONSTRAINT "notification_action_ref" CHECK(("notification"."type" = 'moderation') = ("notification"."action_id" is not null)),
	CONSTRAINT "notification_video_ref" CHECK(("notification"."type" = 'video_failed') = ("notification"."video_id" is not null)),
	CONSTRAINT "notification_video_actor" CHECK("notification"."type" <> 'video_failed' or "notification"."actor_id" is null),
	CONSTRAINT "notification_not_self" CHECK("notification"."actor_id" is null or "notification"."actor_id" <> "notification"."recipient_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_video_idx` ON `notification` (`video_id`);--> statement-breakpoint
CREATE INDEX `notification_recipient_created_idx` ON `notification` (`recipient_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `notification_last_seen` (
	`recipient_id` text PRIMARY KEY NOT NULL,
	`seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `post` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`parent_id` text,
	`quoted_post_id` text,
	`removed_at` integer,
	`removed_by` text,
	`removed_reason` text,
	`deleted_at` integer,
	`edited_at` integer,
	`is_private` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`removed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `post_created_idx` ON `post` ("created_at" desc,"id" desc) WHERE "post"."parent_id" is null;--> statement-breakpoint
CREATE INDEX `post_author_created_idx` ON `post` (`author_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `post_parent_created_idx` ON `post` (`parent_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `post_attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`position` integer NOT NULL,
	`media_path` text NOT NULL,
	`content_type` text NOT NULL,
	`video_id` text,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `video`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "post_attachment_position" CHECK("post_attachment"."position" >= 0),
	CONSTRAINT "post_attachment_byte_size" CHECK("post_attachment"."byte_size" > 0),
	CONSTRAINT "post_attachment_dimensions" CHECK("post_attachment"."width" > 0 and "post_attachment"."height" > 0),
	CONSTRAINT "post_attachment_content_type" CHECK(("post_attachment"."video_id" is null and "post_attachment"."content_type" in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')) or ("post_attachment"."video_id" is not null and "post_attachment"."content_type" = 'application/vnd.apple.mpegurl' and "post_attachment"."position" = 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_attachment_position_idx` ON `post_attachment` (`post_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `post_attachment_video_idx` ON `post_attachment` (`video_id`);--> statement-breakpoint
CREATE TABLE `post_bookmark` (
	`post_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`post_id`, `user_id`),
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_bookmark_user_created_idx` ON `post_bookmark` (`user_id`,"created_at" desc,"post_id" desc);--> statement-breakpoint
CREATE TABLE `post_edit` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_edit_post_created_idx` ON `post_edit` (`post_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `post_like` (
	`post_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`post_id`, `user_id`),
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_like_user_created_idx` ON `post_like` (`user_id`,"created_at" desc,"post_id" desc);--> statement-breakpoint
CREATE TABLE `post_media_upload` (
	`post_id` text PRIMARY KEY NOT NULL,
	`keys` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `post_media_upload_expiry_idx` ON `post_media_upload` (`expires_at`);--> statement-breakpoint
CREATE TABLE `post_repost` (
	`post_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`post_id`, `user_id`),
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_repost_created_idx` ON `post_repost` ("created_at" desc,"post_id" desc,"user_id" desc);--> statement-breakpoint
CREATE INDEX `post_repost_user_created_idx` ON `post_repost` (`user_id`,"created_at" desc,"post_id" desc);--> statement-breakpoint
CREATE TABLE `report` (
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
	CONSTRAINT "report_target_type" CHECK("report"."target_type" in ('post', 'user')),
	CONSTRAINT "report_reason" CHECK("report"."reason" in ('spam', 'harassment', 'hate_speech', 'misinformation', 'self_harm', 'illegal_content', 'nsfw', 'impersonation', 'underage')),
	CONSTRAINT "report_not_self" CHECK("report"."reporter_id" <> "report"."target_id")
);
--> statement-breakpoint
CREATE INDEX `report_open_idx` ON `report` ("created_at" desc,`target_type`,`target_id`) WHERE "report"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX `report_target_idx` ON `report` (`target_type`,`target_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `user_badge` (
	`user_id` text NOT NULL,
	`badge` text NOT NULL,
	`earned_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`user_id`, `badge`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_badge_badge" CHECK("user_badge"."badge" in ('popular', 'rising_star', 'star', 'superstar', 'supernova', 'noticed', 'trendy', 'big', 'exploding', 'giant', 'founder', 'super_early_access', 'early_access'))
);
--> statement-breakpoint
CREATE TABLE `user_block` (
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`),
	FOREIGN KEY (`blocker_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_block_not_self" CHECK("user_block"."blocker_id" <> "user_block"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE `video` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text,
	`post_id` text,
	`state` text DEFAULT 'uploading' NOT NULL,
	`byte_size` integer NOT NULL,
	`stream_creator_id` text NOT NULL,
	`stream_uid` text,
	`upload_url` text,
	`playback` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "video_state" CHECK("video"."state" in ('uploading', 'uploaded', 'queued', 'processing', 'ready', 'published', 'failed', 'cancelled', 'deleted')),
	CONSTRAINT "video_byte_size" CHECK("video"."byte_size" > 0 and "video"."byte_size" <= 500000000),
	CONSTRAINT "video_ready_metadata" CHECK("video"."state" not in ('ready', 'published') or ("video"."stream_uid" is not null and "video"."playback" is not null
        and coalesce(json_type("video"."playback", '$.width') = 'integer', false) and json_extract("video"."playback", '$.width') > 0
        and coalesce(json_type("video"."playback", '$.height') = 'integer', false) and json_extract("video"."playback", '$.height') > 0
        and coalesce(json_type("video"."playback", '$.duration') in ('integer', 'real'), false)
        and json_extract("video"."playback", '$.duration') > 0 and json_extract("video"."playback", '$.duration') <= 300))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_post_idx` ON `video` (`post_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_stream_uid_idx` ON `video` (`stream_uid`);--> statement-breakpoint
CREATE INDEX `video_state_expiry_idx` ON `video` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `video_author_created_idx` ON `video` (`author_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `video_cleanup` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`prefix` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`stream_uid` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_cleanup_prefix_idx` ON `video_cleanup` (`prefix`);--> statement-breakpoint
CREATE INDEX `video_cleanup_next_attempt_idx` ON `video_cleanup` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `video_submission` (
	`video_id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`post_id` text NOT NULL,
	`content` text NOT NULL,
	`parent_id` text,
	`quoted_post_id` text,
	`is_private` integer NOT NULL,
	`caption` text,
	`caption_language` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `video`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "video_submission_target" CHECK("video_submission"."parent_id" is null or "video_submission"."quoted_post_id" is null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_submission_post_idx` ON `video_submission` (`post_id`);--> statement-breakpoint
CREATE INDEX `video_submission_author_idx` ON `video_submission` (`author_id`,"created_at" desc);