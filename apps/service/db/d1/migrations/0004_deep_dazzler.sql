CREATE TABLE `channel_invitation_directory` (
	`invitation_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`recipient_email` text NOT NULL,
	`accepted_user_id` text
);
--> statement-breakpoint
CREATE INDEX `channel_invitation_recipient` ON `channel_invitation_directory` (`recipient_email`,`invitation_id`);--> statement-breakpoint
CREATE INDEX `channel_invitation_user` ON `channel_invitation_directory` (`accepted_user_id`,`invitation_id`);