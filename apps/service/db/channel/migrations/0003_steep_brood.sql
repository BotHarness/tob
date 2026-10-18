CREATE TABLE `channel_work` (
	`request_id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`requester_membership_id` text NOT NULL,
	`requester_user_id` text NOT NULL,
	`target_actor_id` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_work_sequence_unique` ON `channel_work` (`sequence`);--> statement-breakpoint
ALTER TABLE `channel_message` ADD `kind` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `channel_message` ADD `payload` text;