CREATE TABLE `member_access_projection` (
	`workos_user_id` text PRIMARY KEY NOT NULL,
	`membership_id` text NOT NULL,
	`status` text NOT NULL,
	`role` text NOT NULL,
	`verified_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `org_config` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `org_config` ADD `description` text DEFAULT '' NOT NULL;