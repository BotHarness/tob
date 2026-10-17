CREATE TABLE `organization_invitation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`inviter_id` text NOT NULL,
	`email` text NOT NULL,
	`invitation_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitation_invitation_id_unique` ON `organization_invitation` (`invitation_id`);--> statement-breakpoint
ALTER TABLE `member_access_projection` ADD `history_from` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;