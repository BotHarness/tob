import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { eq, and, gt, asc } from "drizzle-orm";
import migrations from "../db/org/migrations/migrations";
import { orgConfig, memberAccessProjection, channelDirectory, organizationInvitation } from "../db/org/schema";
type VerifiedMember = { id: string; user_id: string; organization_id: string; status: string; role: { slug: string } };
export class Org extends DurableObject<Env> {
  private readonly db;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => { await migrate(this.db, migrations); });
  }
  schemaStatus() { this.db.select().from(orgConfig).limit(1).all(); return { schemaVersion: 4 }; }
  initialize(orgId: string, name: string) {
    const old = this.db.select().from(orgConfig).get();
    if (old && (old.orgId !== orgId || old.status !== "active")) throw new Error("ORG_STATE_CONFLICT");
    this.db.insert(orgConfig).values({ orgId, name, status: "active", policyJson: "{}", version: 1 }).onConflictDoNothing().run();
  }
  // Internal binding RPC only. The Worker checks current WorkOS membership, never caller role headers.
  read(orgId: string) {
    const row = this.db.select().from(orgConfig).where(and(eq(orgConfig.orgId, orgId), eq(orgConfig.status, "active"))).get();
    if (!row) throw new Error("ORG_NOT_ACTIVE");
    return { organizationId: row.orgId, name: row.name, description: row.description, version: row.version };
  }
  private observe(orgId: string, member: VerifiedMember) {
    if (member.organization_id !== orgId || member.status !== "active" || !["owner", "member"].includes(member.role.slug)) throw new Error("INVALID_MEMBER");
    const previous = this.db.select().from(memberAccessProjection).where(eq(memberAccessProjection.workosUserId, member.user_id)).get();
    const historyFrom = previous?.membershipId === member.id ? previous.historyFrom : new Date().toISOString();
    const row = { historyFrom, workosUserId: member.user_id, membershipId: member.id, status: member.status, role: member.role.slug, verifiedAt: new Date().toISOString() };
    this.db.insert(memberAccessProjection).values(row).onConflictDoUpdate({ target: memberAccessProjection.workosUserId, set: row }).run();
  }
  memberHistory(orgId: string, member: VerifiedMember) {
    this.read(orgId); this.observe(orgId, member);
    return this.db.select().from(memberAccessProjection).where(eq(memberAccessProjection.workosUserId, member.user_id)).get()!.historyFrom;
  }
  reserveInvitation(orgId: string, member: VerifiedMember, operationId: string, email: string) {
    this.read(orgId); this.observe(orgId, member);
    if (member.role.slug !== "owner") throw new Error("OWNER_REQUIRED");
    const inserted = this.db.insert(organizationInvitation).values({ operationId, inviterId: member.user_id, email, createdAt: new Date().toISOString() }).onConflictDoNothing().returning().all();
    const row = this.db.select().from(organizationInvitation).where(eq(organizationInvitation.operationId, operationId)).get()!;
    if (row.email !== email || row.inviterId !== member.user_id) return null;
    return { ...row, fresh: inserted.length === 1 };
  }
  bindInvitation(orgId: string, operationId: string, invitationId: string) {
    this.read(orgId);
    const row = this.db.select().from(organizationInvitation).where(eq(organizationInvitation.operationId, operationId)).get();
    if (!row || (row.invitationId && row.invitationId !== invitationId)) return false;
    this.db.update(organizationInvitation).set({ invitationId }).where(eq(organizationInvitation.operationId, operationId)).run();
    return true;
  }
  managedInvitation(orgId: string, invitationId: string) {
    this.read(orgId);
    return this.db.select().from(organizationInvitation).where(eq(organizationInvitation.invitationId, invitationId)).get() ?? null;
  }
  view(orgId: string, member: VerifiedMember) { const result = this.read(orgId); this.observe(orgId, member); return result; }
  update(orgId: string, member: VerifiedMember, description: string, version: number) {
    if (member.role.slug !== "owner") throw new Error("OWNER_REQUIRED");
    this.read(orgId); this.observe(orgId, member);
    const rows = this.db.update(orgConfig).set({ description, version: version + 1 }).where(and(eq(orgConfig.orgId, orgId), eq(orgConfig.status, "active"), eq(orgConfig.version, version))).returning().all();
    return rows.length ? this.read(orgId) : null;
  }
  async createChannel(orgId: string, member: VerifiedMember, operationId: string, channelId: string, name: string) {
    this.read(orgId); this.observe(orgId, member);
    if (member.role.slug !== "owner") throw new Error("OWNER_REQUIRED");
    this.db.insert(channelDirectory).values({ channelId, operationId, name, creatorId: member.user_id, creatorType: "human", status: "creating", createdAt: new Date().toISOString() }).onConflictDoNothing().run();
    const row = this.db.select().from(channelDirectory).where(eq(channelDirectory.operationId, operationId)).get();
    if (!row || row.channelId !== channelId || row.name !== name || row.creatorId !== member.user_id) return null;
    const value = { channelId: row.channelId, organizationId: orgId, name: row.name, creatorId: row.creatorId, creatorType: row.creatorType, createdAt: row.createdAt };
    // External RPC is outside the local transaction; retry uses the same durable directory row.
    await this.env.CHANNELS.getByName(channelId).initialize(value);
    this.db.update(channelDirectory).set({ status: "active" }).where(eq(channelDirectory.channelId, channelId)).run();
    return value;
  }
  channels(orgId: string, member: VerifiedMember, after?: string) {
    this.read(orgId); this.observe(orgId, member);
    const rows = this.db.select({ channelId: channelDirectory.channelId, name: channelDirectory.name, creatorId: channelDirectory.creatorId, creatorType: channelDirectory.creatorType, createdAt: channelDirectory.createdAt }).from(channelDirectory).where(and(eq(channelDirectory.status, "active"), after ? gt(channelDirectory.channelId, after) : undefined)).orderBy(asc(channelDirectory.channelId)).limit(51).all();
    return { channels: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].channelId : null };
  }
  channel(orgId: string, member: VerifiedMember, channelId: string) {
    this.read(orgId); this.observe(orgId, member);
    const row = this.db.select().from(channelDirectory).where(and(eq(channelDirectory.channelId, channelId), eq(channelDirectory.status, "active"))).get();
    return row ? { channelId: row.channelId, organizationId: orgId } : null;
  }

}
