import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gt, or, asc, sql } from "drizzle-orm";
import { channelInvitationDirectory } from "../db/d1/schema";
import { admit, AccessError } from "./auth/admission";
import { channelContext, body, operation } from "./channels";
import { recipient, localOrg } from "./invitations";

const validChannel = (id: string) => /^ch_[a-f0-9]{64}$/.test(id);
const validInvitation = (id: string) => /^ci_[a-f0-9]{64}$/.test(id);
function cursor(after?: string) {
  if (after && !validInvitation(after)) throw new AccessError("INVALID_CURSOR", 400);
  return after ?? "";
}
async function indexed(env: Env, id: string) {
  if (!validInvitation(id)) throw new AccessError("INVALID_CHANNEL_INVITATION", 400);
  const row = await drizzle(env.INSTANCE_DB).select().from(channelInvitationDirectory).where(eq(channelInvitationDirectory.invitationId, id)).get();
  if (!row || !validChannel(row.channelId)) throw new AccessError("CHANNEL_INVITATION_ACCESS_DENIED", 403);
  return row;
}
async function indexInvitation(env: Env, value: { invitationId: string; channelId: string; email: string; acceptedUserId: string | null }) {
  const db = drizzle(env.INSTANCE_DB);
  await db.insert(channelInvitationDirectory).values({ invitationId: value.invitationId, channelId: value.channelId, recipientEmail: value.email, acceptedUserId: value.acceptedUserId }).onConflictDoUpdate({ target: channelInvitationDirectory.invitationId, set: { acceptedUserId: sql`COALESCE(${channelInvitationDirectory.acceptedUserId}, ${value.acceptedUserId})` } }).run();
}
const limit = bodyLimit({ maxSize: 20000, onError: c => c.json({ error: { code: "INVALID_CHANNEL_INPUT" } }, 413) });
export const ownerGuestInvitations = new Hono<{ Bindings: Env }>()
  .use("*", limit)
  .post("/:orgId/channels/:channelId/guest-invitations", async c => {
    const { member, actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    if (member.role.slug !== "owner") throw new AccessError("ORGANIZATION_OWNER_REQUIRED", 403);
    const email = (await body(c.req.raw, "email", 254)).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccessError("INVALID_INVITATION_INPUT", 400);
    const key = operation(c.req.header("Idempotency-Key"));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([c.req.param("channelId"), actor.id, key])))), b => b.toString(16).padStart(2, "0")).join("");
    const value = await channel.issueGuest(c.req.param("channelId"), actor, "ci_" + digest, email);
    if (!value) throw new AccessError("OPERATION_CONFLICT", 409);
    await indexInvitation(c.env, value);
    return c.json(value);
  })
  .get("/:orgId/channels/:channelId/guest-invitations", async c => {
    const { member, actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    if (member.role.slug !== "owner") throw new AccessError("ORGANIZATION_OWNER_REQUIRED", 403);
    return c.json(await channel.listGuestInvitations(c.req.param("channelId"), actor, cursor(c.req.query("after"))));
  })
  .post("/:orgId/channels/:channelId/guest-invitations/:id/revoke", async c => {
    const { member, actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    if (member.role.slug !== "owner") throw new AccessError("ORGANIZATION_OWNER_REQUIRED", 403);
    if (!validInvitation(c.req.param("id"))) throw new AccessError("INVALID_CHANNEL_INVITATION", 400);
    const result = await channel.revokeGuest(c.req.param("channelId"), actor, c.req.param("id"));
    if (!result) throw new AccessError("CHANNEL_INVITATION_ACCESS_DENIED", 403);
    return c.json(result);
  });
export const guestInvitations = new Hono<{ Bindings: Env }>()
  .use("*", limit)
  .get("/:id", async c => {
    const user = await recipient(c.env, c.req.header("Authorization"));
    const row = await indexed(c.env, c.req.param("id"));
    const value = await c.env.CHANNELS.getByName(row.channelId).recipientGuestInvitation(row.invitationId, user.userId, user.email);
    if (!value || !await localOrg(c.env, value.organizationId)) throw new AccessError("CHANNEL_INVITATION_ACCESS_DENIED", 403);
    // Recipient verification precedes even the workspace identity projection.
    const org = await c.env.ORGS.getByName(value.organizationId).read(value.organizationId);
    return c.json({ ...value, organizationName: org.name });
  })
  .get("/", async c => {
    const user = await recipient(c.env, c.req.header("Authorization"));
    const rows = await drizzle(c.env.INSTANCE_DB).select().from(channelInvitationDirectory).where(and(or(eq(channelInvitationDirectory.recipientEmail, user.email), eq(channelInvitationDirectory.acceptedUserId, user.userId)), gt(channelInvitationDirectory.invitationId, cursor(c.req.query("after"))))).orderBy(asc(channelInvitationDirectory.invitationId)).limit(51).all();
    const invitations = [];
    for (const row of rows.slice(0, 50)) {
      const value = await c.env.CHANNELS.getByName(row.channelId).recipientGuestInvitation(row.invitationId, user.userId, user.email);
      if (value && await localOrg(c.env, value.organizationId)) invitations.push(value);
    }
    return c.json({ invitations, nextCursor: rows.length > 50 ? rows[49].invitationId : null });
  })
  .post("/:id/accept", async c => {
    const user = await recipient(c.env, c.req.header("Authorization"));
    const row = await indexed(c.env, c.req.param("id"));
    const channel = c.env.CHANNELS.getByName(row.channelId);
    const current = await channel.recipientGuestInvitation(row.invitationId, user.userId, user.email);
    if (!current || !await localOrg(c.env, current.organizationId)) throw new AccessError("CHANNEL_INVITATION_ACCESS_DENIED", 403);
    const value = await channel.acceptGuest(row.invitationId, user.userId, user.email);
    if (value.error) throw new AccessError(value.error, value.error === "CHANNEL_INVITATION_ACCESS_DENIED" ? 403 : 409);
    await indexInvitation(c.env, value.invitation!);
    return c.json({ ...value.invitation, accepted: true });
  });
async function guestContext(env: Env, authorization: string | undefined, channelId: string) {
  const identity = await admit(authorization, env);
  if (!validChannel(channelId)) throw new AccessError("INVALID_CHANNEL", 400);
  const channel = env.CHANNELS.getByName(channelId);
  const view = await channel.guestView(channelId, identity.userId);
  if (!view || !await localOrg(env, view.organizationId)) throw new AccessError("CHANNEL_ACCESS_DENIED", 403);
  return { channel, userId: identity.userId, view };
}
export const guestChannels = new Hono<{ Bindings: Env }>()
  .use("*", limit)
  .get("/", async c => {
    const identity = await admit(c.req.header("Authorization"), c.env);
    const organizationId = c.req.query("organizationId");
    if (organizationId !== undefined && !/^org_[A-Za-z0-9]+$/.test(organizationId)) throw new AccessError("INVALID_ORGANIZATION", 400);
    const rows = await drizzle(c.env.INSTANCE_DB).select().from(channelInvitationDirectory).where(and(eq(channelInvitationDirectory.acceptedUserId, identity.userId), gt(channelInvitationDirectory.invitationId, cursor(c.req.query("after"))))).orderBy(asc(channelInvitationDirectory.invitationId)).limit(51).all();
    const channels = [];
    for (const row of rows.slice(0, 50)) {
      const view = await c.env.CHANNELS.getByName(row.channelId).guestView(row.channelId, identity.userId);
      if (view?.invitationId === row.invitationId && (!organizationId || view.organizationId === organizationId) && await localOrg(c.env, view.organizationId)) {
        const org = await c.env.ORGS.getByName(view.organizationId).read(view.organizationId);
        channels.push({ ...view, organizationName: org.name });
      }
    }
    return c.json({ channels, nextCursor: rows.length > 50 ? rows[49].invitationId : null });
  })
  .get("/:channelId", async c => c.json((await guestContext(c.env, c.req.header("Authorization"), c.req.param("channelId"))).view))
  .get("/:channelId/messages", async c => {
    const { channel, userId } = await guestContext(c.env, c.req.header("Authorization"), c.req.param("channelId"));
    const raw = c.req.query("after") ?? "0";
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new AccessError("INVALID_CURSOR", 400);
    const value = await channel.guestHistory(c.req.param("channelId"), userId, Number(raw));
    if (!value.allowed) throw new AccessError("CHANNEL_ACCESS_DENIED", 403);
    if (!value.result) throw new AccessError("INVALID_CURSOR", 400);
    return c.json(value.result);
  })
  .post("/:channelId/messages", async c => {
    const { channel, userId } = await guestContext(c.env, c.req.header("Authorization"), c.req.param("channelId"));
    const text = await body(c.req.raw, "text", 4000);
    const value = await channel.guestSend(c.req.param("channelId"), userId, operation(c.req.header("Idempotency-Key")), text);
    if (!value.allowed) throw new AccessError("CHANNEL_ACCESS_DENIED", 403);
    if (!value.result) throw new AccessError("OPERATION_CONFLICT", 409);
    return c.json(value.result);
  });
