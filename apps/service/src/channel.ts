import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { and, eq, gt, gte, asc, desc } from "drizzle-orm";
import migrations from "../db/channel/migrations/migrations";
import { channelConfig, channelMessage, channelInvitation, channelGuest, channelAgent, channelWork } from "../db/channel/schema";
import type { WorkRequest, WorkResult } from "../../../packages/contracts/work";

export type ChannelIdentity = { channelId: string; organizationId: string; name: string; creatorId: string; creatorType: "human" | "agent"; createdAt: string };
export type ChannelActor = { id: string; type: "human" | "agent"; organizationId: string; historyFrom: string; historyAfter?: number };
export class Channel extends DurableObject<Env> {
  private readonly db;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => { await migrate(this.db, migrations); });
  }
  schemaStatus() { this.db.select().from(channelConfig).limit(1).all(); return { schemaVersion: 5 }; }
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
    return this.writeMessage(channelId, actor, operationId, text, "text", null);
  }
  private writeMessage(channelId: string, actor: ChannelActor, operationId: string, text: string, kind: "text" | "work_request" | "work_result", payload: WorkRequest | WorkResult | null) {
    this.authorize(channelId, actor);
    const old = this.db.select().from(channelMessage).where(and(eq(channelMessage.authorId, actor.id), eq(channelMessage.authorType, actor.type), eq(channelMessage.operationId, operationId))).get();
    if (old) return old.text === text && old.kind === kind && JSON.stringify(old.payload) === JSON.stringify(payload) && old.createdAt >= actor.historyFrom && old.sequence > (actor.historyAfter ?? 0) ? { message: old, replayed: true } : null;
    const message = this.db.insert(channelMessage).values({ authorId: actor.id, authorType: actor.type, operationId, text, kind, payload, createdAt: new Date().toISOString() }).returning().get();
    return { message, replayed: false };
  }
  history(channelId: string, actor: ChannelActor, after: number) {
    this.authorize(channelId, actor);
    const latest = this.db.select({ sequence: channelMessage.sequence }).from(channelMessage).orderBy(desc(channelMessage.sequence)).limit(1).get()?.sequence ?? 0;
    if (after > latest) return null;
    const rows = this.db.select().from(channelMessage).where(and(gt(channelMessage.sequence, Math.max(after, actor.historyAfter ?? 0)), gte(channelMessage.createdAt, actor.historyFrom))).orderBy(asc(channelMessage.sequence)).limit(51).all();
    const messages = rows.slice(0, 50);
    return { messages, nextCursor: messages.at(-1)?.sequence ?? Math.max(after, actor.historyAfter ?? 0), hasMore: rows.length > 50 };
  }
  private invitationView(row: typeof channelInvitation.$inferSelect) {
    const config = this.db.select().from(channelConfig).get()!;
    return { invitationId: row.invitationId, channelId: config.channelId, channelName: config.name, organizationId: config.organizationId, email: row.recipientEmail, role: "guest" as const, state: row.state === "pending" && Date.parse(row.expiresAt) <= Date.now() ? "expired" as const : row.state, expiresAt: row.expiresAt, acceptedUserId: row.acceptedUserId };
  }
  issueGuest(channelId: string, actor: ChannelActor, invitationId: string, email: string) {
    this.authorize(channelId, actor);
    const old = this.db.select().from(channelInvitation).where(eq(channelInvitation.invitationId, invitationId)).get();
    if (old) return old.inviterId === actor.id && old.recipientEmail === email ? this.invitationView(old) : null;
    const row = this.db.insert(channelInvitation).values({ invitationId, inviterId: actor.id, recipientEmail: email, state: "pending", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }).returning().get();
    return this.invitationView(row);
  }
  listGuestInvitations(channelId: string, actor: ChannelActor, after = "") {
    this.authorize(channelId, actor);
    const rows = this.db.select().from(channelInvitation).where(gt(channelInvitation.invitationId, after)).orderBy(asc(channelInvitation.invitationId)).limit(51).all();
    return { invitations: rows.slice(0, 50).map(row => this.invitationView(row)), nextCursor: rows.length > 50 ? rows[49].invitationId : null };
  }
  recipientGuestInvitation(invitationId: string, userId: string, email: string) {
    const row = this.db.select().from(channelInvitation).where(eq(channelInvitation.invitationId, invitationId)).get();
    return row && (row.acceptedUserId ? row.acceptedUserId === userId : row.recipientEmail === email) ? this.invitationView(row) : null;
  }
  acceptGuest(invitationId: string, userId: string, email: string) {
    const row = this.db.select().from(channelInvitation).where(eq(channelInvitation.invitationId, invitationId)).get();
    if (!row || (row.acceptedUserId ? row.acceptedUserId !== userId : row.recipientEmail !== email)) return { error: "CHANNEL_INVITATION_ACCESS_DENIED" as const };
    const grant = this.db.select().from(channelGuest).where(eq(channelGuest.userId, userId)).get();
    if (row.state === "accepted" && grant?.active && grant.invitationId === invitationId) return { invitation: this.invitationView(row), accepted: true as const };
    if (row.state !== "pending" || Date.parse(row.expiresAt) <= Date.now()) return { error: "CHANNEL_INVITATION_NOT_ACCEPTABLE" as const };
    if (grant?.active) return { error: "CHANNEL_GUEST_ALREADY_ACTIVE" as const };
    const historyAfter = this.db.select({ sequence: channelMessage.sequence }).from(channelMessage).orderBy(desc(channelMessage.sequence)).limit(1).get()?.sequence ?? 0;
    const updated = this.ctx.storage.transactionSync(() => {
      const accepted = this.db.update(channelInvitation).set({ state: "accepted", acceptedUserId: userId }).where(eq(channelInvitation.invitationId, invitationId)).returning().get()!;
      this.db.insert(channelGuest).values({ userId, invitationId, active: true, historyAfter }).onConflictDoUpdate({ target: channelGuest.userId, set: { invitationId, active: true, historyAfter } }).run();
      return accepted;
    });
    return { invitation: this.invitationView(updated), accepted: true as const };
  }
  revokeGuest(channelId: string, actor: ChannelActor, invitationId: string) {
    this.authorize(channelId, actor);
    const row = this.db.select().from(channelInvitation).where(eq(channelInvitation.invitationId, invitationId)).get();
    if (!row) return null;
    return this.ctx.storage.transactionSync(() => {
      this.db.update(channelGuest).set({ active: false }).where(eq(channelGuest.invitationId, invitationId)).run();
      const revoked = this.db.update(channelInvitation).set({ state: "revoked" }).where(eq(channelInvitation.invitationId, invitationId)).returning().get()!;
      return this.invitationView(revoked);
    });
  }
  private guestActor(channelId: string, userId: string) {
    const config = this.db.select().from(channelConfig).get();
    const grant = this.db.select().from(channelGuest).where(eq(channelGuest.userId, userId)).get();
    if (!config || config.channelId !== channelId || !grant?.active) return null;
    return { config, grant, actor: { id: userId, type: "human" as const, organizationId: config.organizationId, historyFrom: new Date(0).toISOString(), historyAfter: grant.historyAfter } };
  }
  guestView(channelId: string, userId: string) {
    const value = this.guestActor(channelId, userId);
    return value ? { ...value.config, access: "guest" as const, invitationId: value.grant.invitationId, historyAfter: value.grant.historyAfter } : null;
  }
  guestSend(channelId: string, userId: string, operationId: string, text: string) {
    const value = this.guestActor(channelId, userId);
    return value ? { allowed: true as const, result: this.send(channelId, value.actor, operationId, text) } : { allowed: false as const };
  }
  guestHistory(channelId: string, userId: string, after: number) {
    const value = this.guestActor(channelId, userId);
    return value ? { allowed: true as const, result: this.history(channelId, value.actor, after) } : { allowed: false as const };
  }

  private agentView(row: typeof channelAgent.$inferSelect) {
    return { actorId: row.actorId, kind: "agent" as const, name: row.name, ownerUserId: row.ownerUserId, scopes: ["messages:read", "messages:send"], state: !row.active ? "revoked" : Date.parse(row.expiresAt) <= Date.now() ? "expired" : "active", historyAfter: row.historyAfter, expiresAt: row.expiresAt };
  }
  issueAgent(channelId: string, actor: ChannelActor, ownerMembershipId: string, actorId: string, name: string, secretHash: string) {
    this.authorize(channelId, actor);
    const old = this.db.select().from(channelAgent).where(eq(channelAgent.actorId, actorId)).get();
    if (old) return old.ownerUserId === actor.id && old.ownerMembershipId === ownerMembershipId && old.name === name && old.secretHash === secretHash ? this.agentView(old) : null;
    const historyAfter = this.db.select({ sequence: channelMessage.sequence }).from(channelMessage).orderBy(desc(channelMessage.sequence)).limit(1).get()?.sequence ?? 0;
    const row = this.db.insert(channelAgent).values({ actorId, ownerUserId: actor.id, ownerMembershipId, name, secretHash, active: true, historyAfter, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }).returning().get();
    return this.agentView(row);
  }
  agents(channelId: string, actor: ChannelActor, after: string) {
    this.authorize(channelId, actor);
    const rows = this.db.select().from(channelAgent).where(gt(channelAgent.actorId, after)).orderBy(asc(channelAgent.actorId)).limit(51).all();
    return { agents: rows.slice(0, 50).map(row => this.agentView(row)), nextCursor: rows.length > 50 ? rows[49].actorId : null };
  }
  revokeAgent(channelId: string, actor: ChannelActor, actorId: string) {
    this.authorize(channelId, actor);
    const row = this.db.update(channelAgent).set({ active: false }).where(eq(channelAgent.actorId, actorId)).returning().get();
    return row ? this.agentView(row) : null;
  }
  private agentActor(channelId: string, actorId: string, secretHash: string) {
    const config = this.db.select().from(channelConfig).get();
    const grant = this.db.select().from(channelAgent).where(eq(channelAgent.actorId, actorId)).get();
    if (!config || config.channelId !== channelId || !grant?.active || Date.parse(grant.expiresAt) <= Date.now() || grant.secretHash.length !== secretHash.length) return null;
    let different = 0;
    for (let n = 0; n < secretHash.length; n++) different |= secretHash.charCodeAt(n) ^ grant.secretHash.charCodeAt(n);
    if (different) return null;
    return { config, grant, actor: { id: actorId, type: "agent" as const, organizationId: config.organizationId, historyFrom: new Date(0).toISOString(), historyAfter: grant.historyAfter } };
  }
  agentContext(channelId: string, actorId: string, secretHash: string) {
    const value = this.agentActor(channelId, actorId, secretHash);
    return value ? { organizationId: value.config.organizationId, ownerUserId: value.grant.ownerUserId, ownerMembershipId: value.grant.ownerMembershipId, agent: this.agentView(value.grant) } : null;
  }
  agentHistory(channelId: string, actorId: string, secretHash: string, after: number) {
    const value = this.agentActor(channelId, actorId, secretHash);
    return value ? { allowed: true as const, result: this.history(channelId, value.actor, after) } : { allowed: false as const };
  }
  agentSend(channelId: string, actorId: string, secretHash: string, operationId: string, text: string) {
    const value = this.agentActor(channelId, actorId, secretHash);
    return value ? { allowed: true as const, result: this.send(channelId, value.actor, operationId, text) } : { allowed: false as const };
  }

  requestWork(
    channelId: string,
    actor: ChannelActor,
    membershipId: string,
    operationId: string,
    requestId: string,
    targetActorId: string,
    expiresAt: string,
  ) {
    this.authorize(channelId, actor);
    if (actor.type !== 'human') return { error: 'WORK_ACCESS_DENIED' as const };
    const existing = this.db
      .select()
      .from(channelWork)
      .where(eq(channelWork.requestId, requestId))
      .get();
    if (existing) {
      const message = this.db
        .select()
        .from(channelMessage)
        .where(eq(channelMessage.sequence, existing.sequence))
        .get();
      return message &&
        message.operationId === operationId &&
        message.authorId === actor.id &&
        message.createdAt >= actor.historyFrom &&
        existing.requesterMembershipId === membershipId &&
        existing.targetActorId === targetActorId &&
        existing.expiresAt === expiresAt
        ? { message, replayed: true }
        : { error: 'OPERATION_CONFLICT' as const };
    }
    const agent = this.db
      .select()
      .from(channelAgent)
      .where(eq(channelAgent.actorId, targetActorId))
      .get();
    if (!agent?.active || Date.parse(agent.expiresAt) <= Date.now())
      return { error: 'AGENT_ACCESS_DENIED' as const };
    const now = Date.now();
    if (Date.parse(expiresAt) <= now || Date.parse(expiresAt) - now > 600000)
      return { error: 'INVALID_WORK_EXPIRY' as const };
    const payload: WorkRequest = {
      version: 1,
      requestId,
      channelId,
      requesterUserId: actor.id,
      targetActorId,
      capability: 'health-check',
      createdAt: new Date(now).toISOString(),
      expiresAt,
    };
    return this.ctx.storage.transactionSync(() => {
      const result = this.writeMessage(
        channelId,
        actor,
        operationId,
        'Health check requested for ' + agent.name + '. Expires ' + expiresAt,
        'work_request',
        payload,
      );
      if (!result) return { error: 'OPERATION_CONFLICT' as const };
      this.db
        .insert(channelWork)
        .values({
          requestId,
          sequence: result.message.sequence,
          requesterMembershipId: membershipId,
          requesterUserId: actor.id,
          targetActorId,
          expiresAt,
        })
        .run();
      return result;
    });
  }
  agentWorkContext(channelId: string, actorId: string, secretHash: string, requestId: string) {
    const value = this.agentActor(channelId, actorId, secretHash);
    const work = this.db
      .select()
      .from(channelWork)
      .where(eq(channelWork.requestId, requestId))
      .get();
    if (
      !value ||
      !work ||
      work.targetActorId !== actorId ||
      work.sequence <= value.grant.historyAfter
    )
      return null;
    const message = this.db
      .select()
      .from(channelMessage)
      .where(eq(channelMessage.sequence, work.sequence))
      .get();
    let forwarder: { ownerUserId: string; ownerMembershipId: string } | undefined;
    if (work.parentRequestId) {
      const parent = this.db
        .select()
        .from(channelWork)
        .where(eq(channelWork.requestId, work.parentRequestId))
        .get();
      const grant =
        parent &&
        this.db
          .select()
          .from(channelAgent)
          .where(eq(channelAgent.actorId, parent.targetActorId))
          .get();
      if (!grant?.active || Date.parse(grant.expiresAt) <= Date.now()) return null;
      forwarder = { ownerUserId: grant.ownerUserId, ownerMembershipId: grant.ownerMembershipId };
    }
    return message?.kind === 'work_request'
      ? {
          request: message.payload as WorkRequest,
          requesterMembershipId: work.requesterMembershipId,
          organizationId: value.config.organizationId,
          ...(forwarder ? { forwarder } : {}),
        }
      : null;
  }
  authorizeWork(channelId: string, actorId: string, secretHash: string, requestId: string) {
    const ctx = this.agentWorkContext(channelId, actorId, secretHash, requestId);
    if (!ctx) return { error: 'WORK_ACCESS_DENIED' as const };
    if (Date.parse(ctx.request.expiresAt) <= Date.now())
      return { error: 'REQUEST_EXPIRED' as const };
    if (this.db.select().from(channelWork).where(eq(channelWork.parentRequestId, requestId)).get())
      return { error: 'WORK_ALREADY_FORWARDED' as const };
    if (
      this.db
        .select()
        .from(channelMessage)
        .where(
          and(
            eq(channelMessage.authorId, actorId),
            eq(channelMessage.authorType, 'agent'),
            eq(channelMessage.operationId, 'result-' + requestId),
          ),
        )
        .get()
    )
      return { error: 'WORK_ALREADY_FINISHED' as const };
    // Persist the execution/forwarding choice before returning permission to start.
    this.db
      .update(channelWork)
      .set({ executionAuthorized: true })
      .where(eq(channelWork.requestId, requestId))
      .run();
    return { request: ctx.request };
  }
  forwardWork(
    channelId: string,
    actorId: string,
    secretHash: string,
    parentRequestId: string,
    requestId: string,
    targetActorId: string,
  ) {
    const value = this.agentActor(channelId, actorId, secretHash);
    const context = this.agentWorkContext(channelId, actorId, secretHash, parentRequestId);
    if (!value || !context) return { error: 'WORK_ACCESS_DENIED' as const };
    const parent = this.db
      .select()
      .from(channelWork)
      .where(eq(channelWork.requestId, parentRequestId))
      .get()!;
    if (parent.parentRequestId || actorId === targetActorId)
      return { error: 'FORWARD_LIMIT' as const };
    const existing = this.db
      .select()
      .from(channelWork)
      .where(eq(channelWork.parentRequestId, parentRequestId))
      .get();
    if (existing) {
      const message = this.db
        .select()
        .from(channelMessage)
        .where(eq(channelMessage.sequence, existing.sequence))
        .get();
      return message && existing.targetActorId === targetActorId
        ? { message, replayed: true }
        : { error: 'OPERATION_CONFLICT' as const };
    }
    if (
      parent.executionAuthorized ||
      this.db
        .select()
        .from(channelMessage)
        .where(
          and(
            eq(channelMessage.authorId, actorId),
            eq(channelMessage.authorType, 'agent'),
            eq(channelMessage.operationId, 'result-' + parentRequestId),
          ),
        )
        .get()
    )
      return { error: 'WORK_ALREADY_STARTED' as const };
    if (Date.parse(context.request.expiresAt) <= Date.now())
      return { error: 'REQUEST_EXPIRED' as const };
    const target = this.db
      .select()
      .from(channelAgent)
      .where(eq(channelAgent.actorId, targetActorId))
      .get();
    if (!target?.active || Date.parse(target.expiresAt) <= Date.now())
      return { error: 'AGENT_ACCESS_DENIED' as const };
    const payload: WorkRequest = {
      ...context.request,
      requestId,
      targetActorId,
      delegation: { parentRequestId, actorId, hops: 1 },
    };
    return this.ctx.storage.transactionSync(() => {
      const result = this.writeMessage(
        channelId,
        value.actor,
        'forward-' + parentRequestId,
        'Health check forwarded to ' +
          target.name +
          '. Original requester ' +
          payload.requesterUserId +
          '. Expires ' +
          payload.expiresAt,
        'work_request',
        payload,
      );
      if (!result) return { error: 'OPERATION_CONFLICT' as const };
      this.db
        .insert(channelWork)
        .values({
          requestId,
          parentRequestId,
          sequence: result.message.sequence,
          requesterMembershipId: parent.requesterMembershipId,
          requesterUserId: parent.requesterUserId,
          targetActorId,
          expiresAt: parent.expiresAt,
        })
        .run();
      return result;
    });
  }

  agentWorkResult(channelId: string, actorId: string, secretHash: string, result: WorkResult) {
    const value = this.agentActor(channelId, actorId, secretHash);
    const ctx = this.agentWorkContext(channelId, actorId, secretHash, result.requestId);
    if (!value || !ctx) return { error: 'WORK_ACCESS_DENIED' as const };
    if (
      this.db
        .select()
        .from(channelWork)
        .where(eq(channelWork.parentRequestId, result.requestId))
        .get()
    )
      return { error: 'WORK_ALREADY_FORWARDED' as const };
    const work = this.db
      .select()
      .from(channelWork)
      .where(eq(channelWork.requestId, result.requestId))
      .get();
    if (result.state === 'completed' && !work?.executionAuthorized)
      return { error: 'WORK_NOT_AUTHORIZED' as const };
    const text =
      'Health check ' +
      result.state +
      ' · ' +
      result.environment +
      ' · ' +
      result.reason +
      ' · execution count ' +
      result.executionCount +
      (result.diagnostics
        ? ' · ' +
          result.diagnostics.platform +
          '/' +
          result.diagnostics.architecture +
          ' · ' +
          result.diagnostics.runtime
        : '');
    const written = this.writeMessage(
      channelId,
      value.actor,
      'result-' + result.requestId,
      text,
      'work_result',
      result,
    );
    return written ?? { error: 'OPERATION_CONFLICT' as const };
  }
}
