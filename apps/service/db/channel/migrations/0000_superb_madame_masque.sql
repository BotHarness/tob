CREATE TABLE `channel_config` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`creator_id` text NOT NULL,
	`creator_type` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_message` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` text NOT NULL,
	`author_type` text NOT NULL,
	`operation_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_author_operation` ON `channel_message` (`author_type`,`author_id`,`operation_id`);