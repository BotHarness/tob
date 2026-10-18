ALTER TABLE `channel_work` ADD `parent_request_id` text;--> statement-breakpoint
ALTER TABLE `channel_work` ADD `execution_authorized` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `channel_work_parent_request_id_unique` ON `channel_work` (`parent_request_id`);