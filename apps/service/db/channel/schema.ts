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
  createdAt: text("created_at").notNull(),
}, t => [uniqueIndex("message_author_operation").on(t.authorType, t.authorId, t.operationId)]);
