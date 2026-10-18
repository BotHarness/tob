CREATE TABLE `channel_agent` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner_membership_id` text NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`active` integer NOT NULL,
	`history_after` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
