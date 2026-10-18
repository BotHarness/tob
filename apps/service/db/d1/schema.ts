import { sqliteTable, text, integer, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const instanceConfig = sqliteTable("instance_config", {
  singletonId: integer("singleton_id").primaryKey(),
  registrationMode: text("registration_mode").notNull(),
  orgCreationMode: text("org_creation_mode").notNull(),
  configVersion: integer("config_version").notNull(),
}, (t) => [check("singleton", sql`${t.singletonId} = 1`), check("admission_modes", sql`${t.registrationMode} IN ('admin_only', 'authenticated') AND ${t.orgCreationMode} IN ('admin_only', 'all_users')`)]);

export const instanceAdmin = sqliteTable("instance_admin", {
  workosUserId: text("workos_user_id").primaryKey(),
  grantedBy: text("granted_by").notNull(),
  grantedAt: text("granted_at").notNull(),
  status: text("status", { enum: ["active", "inactive", "revoked"] }).notNull(),
}, (t) => [check("admin_status", sql`${t.status} IN ('active', 'inactive', 'revoked')`)]);

export const managementOperation = sqliteTable("management_operation", {
  operationId: text("operation_id").primaryKey(),
  actorId: text("actor_id").notNull(),
  kind: text("kind").notNull(),
  payloadHash: text("payload_hash").notNull(),
  targetId: text("target_id").notNull(),
  state: text("state").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const organizationLink = sqliteTable("organization_link", {
  orgId: text("org_id").primaryKey(),
  workosOrgId: text("workos_org_id").notNull().unique(),
  lifecycle: text("lifecycle", { enum: ["creating", "active", "disabled"] }).notNull(),
  createdAt: text("created_at").notNull(),
}, t => [check("organization_lifecycle", sql`${t.lifecycle} IN ('creating', 'active', 'disabled')`)]);
