CREATE TABLE `management_operation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_hash` text NOT NULL,
	`target_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);

--> statement-breakpoint
-- D1 REST exposes a single query, not a Worker binding transaction. This trigger
-- keeps the receipt, policy and admin in that one SQLite statement/transaction.
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
