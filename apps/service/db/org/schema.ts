import { sqliteTable, text, integer, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const orgConfig = sqliteTable("org_config", {
  orgId: text("org_id").primaryKey(),
  status: text("status", { enum: ["creating", "active", "disabled"] }).notNull(),
  policyJson: text("policy_json").notNull(),
  version: integer("version").notNull(),
}, (t) => [check("org_status", sql`${t.status} IN ('creating', 'active', 'disabled')`)]);
