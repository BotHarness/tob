DROP TRIGGER initialize_first_admin;--> statement-breakpoint
CREATE TABLE `__new_instance_config` (
	`singleton_id` integer PRIMARY KEY NOT NULL,
	`registration_mode` text NOT NULL,
	`org_creation_mode` text NOT NULL,
	`config_version` integer NOT NULL,
	CONSTRAINT "singleton" CHECK("__new_instance_config"."singleton_id" = 1),
	CONSTRAINT "admission_modes" CHECK("__new_instance_config"."registration_mode" IN ('admin_only', 'authenticated') AND "__new_instance_config"."org_creation_mode" IN ('admin_only', 'all_users'))
);
--> statement-breakpoint
INSERT INTO `__new_instance_config`("singleton_id", "registration_mode", "org_creation_mode", "config_version") SELECT "singleton_id", "registration_mode", "org_creation_mode", "config_version" FROM `instance_config`;--> statement-breakpoint
DROP TABLE `instance_config`;--> statement-breakpoint
ALTER TABLE `__new_instance_config` RENAME TO `instance_config`;--> statement-breakpoint
CREATE TRIGGER initialize_first_admin
BEFORE INSERT ON management_operation
WHEN NEW.kind = 'instance.initialize'
BEGIN
  SELECT CASE WHEN NEW.operation_id != 'instance.initialize'
    OR NEW.state != 'succeeded' OR NEW.target_id NOT LIKE 'user_%'
    OR length(NEW.payload_hash) != 64
    THEN RAISE(ABORT, 'INVALID_BOOTSTRAP_RECEIPT') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM instance_admin)
    OR EXISTS (SELECT 1 FROM instance_config)
    OR EXISTS (SELECT 1 FROM management_operation WHERE kind = 'instance.initialize')
    THEN RAISE(ABORT, 'BOOTSTRAP_STATE_CONFLICT') END;
  INSERT INTO instance_config VALUES (1, 'admin_only', 'admin_only', 1);
  INSERT INTO instance_admin VALUES (NEW.target_id, NEW.actor_id, NEW.updated_at, 'active');
END;
