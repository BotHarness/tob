CREATE TABLE `channel_guest` (
	`user_id` text PRIMARY KEY NOT NULL,
	`invitation_id` text NOT NULL,
	`active` integer NOT NULL,
	`history_after` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_invitation` (
	`invitation_id` text PRIMARY KEY NOT NULL,
	`inviter_id` text NOT NULL,
	`recipient_email` text NOT NULL,
	`state` text NOT NULL,
	`accepted_user_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
