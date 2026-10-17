CREATE TABLE `organization_link` (
	`org_id` text PRIMARY KEY NOT NULL,
	`workos_org_id` text NOT NULL,
	`lifecycle` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "organization_lifecycle" CHECK("organization_link"."lifecycle" IN ('creating', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_link_workos_org_id_unique` ON `organization_link` (`workos_org_id`);