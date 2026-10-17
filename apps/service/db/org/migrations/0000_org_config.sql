CREATE TABLE `org_config` (
	`org_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`policy_json` text NOT NULL,
	`version` integer NOT NULL,
	CONSTRAINT "org_status" CHECK("org_config"."status" IN ('creating', 'active', 'disabled'))
);
