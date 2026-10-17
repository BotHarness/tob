import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { and, eq, gt, gte, asc, desc } from "drizzle-orm";
import migrations from "../db/channel/migrations/migrations";
import { channelConfig, channelMessage } from "../db/channel/schema";

export type ChannelIdentity = { channelId: string; organizationId: string; name: string; creatorId: string; creatorType: "human" | "agent"; createdAt: string };
export type ChannelActor = { id: string; type: "human" | "agent"; organizationId: string; historyFrom: string };
export class Channel extends DurableObject<Env> {
  private readonly db;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => { await migrate(this.db, migrations); });
  }
  schemaStatus() { this.db.select().from(channelConfig).limit(1).all(); return { schemaVersion: 1 }; }
  initialize(value: ChannelIdentity) {
    const old = this.db.select().from(channelConfig).get();
    if (old && Object.keys(value).some(k => old[k as keyof ChannelIdentity] !== value[k as keyof ChannelIdentity])) throw new Error("CHANNEL_STATE_CONFLICT");
    this.db.insert(channelConfig).values(value).onConflictDoNothing().run();
    return value;
  }
  private authorize(channelId: string, actor: ChannelActor) {
    const row = this.db.select().from(channelConfig).get();
    if (!row || row.channelId !== channelId || row.organizationId !== actor.organizationId || !actor.id || !["human", "agent"].includes(actor.type) || !Number.isFinite(Date.parse(actor.historyFrom))) throw new Error("CHANNEL_ACCESS_DENIED");
    return row;
  }
  read(channelId: string, actor: ChannelActor) { return this.authorize(channelId, actor); }
  send(channelId: string, actor: ChannelActor, operationId: string, text: string) {
    this.authorize(channelId, actor);
    const old = this.db.select().from(channelMessage).where(and(eq(channelMessage.authorId, actor.id), eq(channelMessage.authorType, actor.type), eq(channelMessage.operationId, operationId))).get();
    if (old) return old.text === text && old.createdAt >= actor.historyFrom ? { message: old, replayed: true } : null;
    const message = this.db.insert(channelMessage).values({ authorId: actor.id, authorType: actor.type, operationId, text, createdAt: new Date().toISOString() }).returning().get();
    return { message, replayed: false };
  }
  history(channelId: string, actor: ChannelActor, after: number) {
    this.authorize(channelId, actor);
    const latest = this.db.select({ sequence: channelMessage.sequence }).from(channelMessage).orderBy(desc(channelMessage.sequence)).limit(1).get()?.sequence ?? 0;
    if (after > latest) return null;
    const rows = this.db.select().from(channelMessage).where(and(gt(channelMessage.sequence, after), gte(channelMessage.createdAt, actor.historyFrom))).orderBy(asc(channelMessage.sequence)).limit(51).all();
    const messages = rows.slice(0, 50);
    return { messages, nextCursor: messages.at(-1)?.sequence ?? after, hasMore: rows.length > 50 };
  }
}
