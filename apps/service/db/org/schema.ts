import { sqliteTable, text, integer, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const orgConfig = sqliteTable("org_config", {
  orgId: text("org_id").primaryKey(),
  status: text("status", { enum: ["creating", "active", "disabled"] }).notNull(),
  policyJson: text("policy_json").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull().default(""),
  description: text("description").notNull().default(""),
}, (t) => [check("org_status", sql`${t.status} IN ('creating', 'active', 'disabled')`)]);

export const memberAccessProjection = sqliteTable("member_access_projection", {
  workosUserId: text("workos_user_id").primaryKey(),
  membershipId: text("membership_id").notNull(),
  status: text("status").notNull(),
  role: text("role").notNull(),
  verifiedAt: text("verified_at").notNull(),
});
