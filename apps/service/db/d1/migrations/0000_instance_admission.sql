CREATE TABLE `instance_admin` (
	`workos_user_id` text PRIMARY KEY NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` text NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT "admin_status" CHECK("instance_admin"."status" IN ('active', 'inactive', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE `instance_config` (
	`singleton_id` integer PRIMARY KEY NOT NULL,
	`registration_mode` text NOT NULL,
	`org_creation_mode` text NOT NULL,
	`config_version` integer NOT NULL,
	CONSTRAINT "singleton" CHECK("instance_config"."singleton_id" = 1),
	CONSTRAINT "admin_only" CHECK("instance_config"."registration_mode" = 'admin_only' AND "instance_config"."org_creation_mode" = 'admin_only')
);
