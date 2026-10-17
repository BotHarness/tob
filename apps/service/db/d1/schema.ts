import { sqliteTable, text, integer, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const instanceConfig = sqliteTable("instance_config", {
  singletonId: integer("singleton_id").primaryKey(),
  registrationMode: text("registration_mode").notNull(),
  orgCreationMode: text("org_creation_mode").notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [check("singleton", sql`${t.singletonId} = 1`), check("admin_only", sql`${t.registrationMode} = 'admin_only' AND ${t.orgCreationMode} = 'admin_only'`)]);

export const instanceAdmin = sqliteTable("instance_admin", {
  workosUserId: text("workos_user_id").primaryKey(),
  grantedBy: text("granted_by").notNull(),
  grantedAt: text("granted_at").notNull(),
  status: text("status", { enum: ["active", "inactive", "revoked"] }).notNull(),
}, (t) => [check("admin_status", sql`${t.status} IN ('active', 'inactive', 'revoked')`)]);
