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
  historyFrom: text("history_from").notNull().default("1970-01-01T00:00:00.000Z"),
});

export const channelDirectory = sqliteTable("channel_directory", {
  channelId: text("channel_id").primaryKey(),
  operationId: text("operation_id").notNull().unique(),
  name: text("name").notNull(),
  creatorId: text("creator_id").notNull(),
  creatorType: text("creator_type", { enum: ["human", "agent"] }).notNull(),
  status: text("status", { enum: ["creating", "active"] }).notNull(),
  createdAt: text("created_at").notNull(),
});

// Provider invitations own activation; this journal owns TOB issuance/reconciliation.
export const organizationInvitation = sqliteTable("organization_invitation", {
  operationId: text("operation_id").primaryKey(),
  inviterId: text("inviter_id").notNull(),
  email: text("email").notNull(),
  invitationId: text("invitation_id").unique(),
  createdAt: text("created_at").notNull(),
});
