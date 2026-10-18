import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const channelConfig = sqliteTable("channel_config", {
  channelId: text("channel_id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  creatorId: text("creator_id").notNull(),
  creatorType: text("creator_type", { enum: ["human", "agent"] }).notNull(),
  createdAt: text("created_at").notNull(),
});
export const channelMessage = sqliteTable("channel_message", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  authorId: text("author_id").notNull(),
  authorType: text("author_type", { enum: ["human", "agent"] }).notNull(),
  operationId: text("operation_id").notNull(),
  text: text("text").notNull(),
  kind: text("kind", { enum: ["text", "work_request", "work_result"] }).notNull().default("text"),
  payload: text("payload", { mode: "json" }).$type<import("../../../../packages/contracts/work").WorkRequest | import("../../../../packages/contracts/work").WorkResult>(),
  createdAt: text("created_at").notNull(),
}, t => [uniqueIndex("message_author_operation").on(t.authorType, t.authorId, t.operationId)]);

export const channelWork = sqliteTable("channel_work", {
  requestId: text("request_id").primaryKey(),
  sequence: integer("sequence").notNull().unique(),
  requesterMembershipId: text("requester_membership_id").notNull(),
  parentRequestId: text("parent_request_id").unique(),
  executionAuthorized: integer("execution_authorized", { mode: "boolean" }).notNull().default(false),
  requesterUserId: text("requester_user_id").notNull(),
  targetActorId: text("target_actor_id").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const channelInvitation = sqliteTable("channel_invitation", {
  invitationId: text("invitation_id").primaryKey(),
  inviterId: text("inviter_id").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  state: text("state", { enum: ["pending", "accepted", "revoked"] }).notNull(),
  acceptedUserId: text("accepted_user_id"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
});
export const channelGuest = sqliteTable("channel_guest", {
  userId: text("user_id").primaryKey(),
  invitationId: text("invitation_id").notNull(),
  active: integer("active", { mode: "boolean" }).notNull(),
  historyAfter: integer("history_after").notNull(),
});

export const channelAgent = sqliteTable("channel_agent", {
  actorId: text("actor_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  ownerMembershipId: text("owner_membership_id").notNull(),
  name: text("name").notNull(),
  secretHash: text("secret_hash").notNull(),
  active: integer("active", { mode: "boolean" }).notNull(),
  historyAfter: integer("history_after").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});
