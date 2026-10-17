CREATE TABLE `channel_directory` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`name` text NOT NULL,
	`creator_id` text NOT NULL,
	`creator_type` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_directory_operation_id_unique` ON `channel_directory` (`operation_id`);