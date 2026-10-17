import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { admit, AccessError } from "./auth/admission";
import { access } from "./organizations";

const channelIdValid = (id: string) => /^ch_[a-f0-9]{64}$/.test(id);
async function memberContext(env: Env, authorization: string | undefined, orgId: string) {
  const identity = await admit(authorization, env);
  if (identity.organizationId !== orgId) throw new AccessError("ORGANIZATION_TOKEN_REQUIRED", 403);
  const member = await access(env, identity.userId, orgId);
  if (!member.created_at || !Number.isFinite(Date.parse(member.created_at))) throw new AccessError("IDENTITY_UNAVAILABLE", 503);
  return { member, actor: { id: identity.userId, type: "human" as const, organizationId: orgId, historyFrom: new Date(member.created_at).toISOString() } };
}
async function channelContext(env: Env, authorization: string | undefined, orgId: string, channelId: string) {
  const ctx = await memberContext(env, authorization, orgId);
  if (!channelIdValid(channelId) || !await env.ORGS.getByName(orgId).channel(orgId, ctx.member, channelId)) throw new AccessError("CHANNEL_ACCESS_DENIED", 403);
  return { ...ctx, channel: env.CHANNELS.getByName(channelId) };
}
function operation(key: string | undefined) {
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new AccessError("INVALID_OPERATION", 400);
  return key;
}
async function body(request: Request, field: string, max: number) {
  let value; try { value = await request.json() as Record<string, unknown>; } catch { throw new AccessError("INVALID_CHANNEL_INPUT", 400); }
  if (!value || typeof value !== "object" || Object.keys(value).some(k => k !== field) || typeof value[field] !== "string" || !value[field].trim() || value[field].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value[field])) throw new AccessError("INVALID_CHANNEL_INPUT", 400);
  return field === "name" ? value[field].trim() : value[field];
}
export const channels = new Hono<{ Bindings: Env }>()
  .use("*", bodyLimit({ maxSize: 20000, onError: c => c.json({ error: { code: "INVALID_CHANNEL_INPUT" } }, 413) }))
  .get("/:orgId/channels", async c => {
    const { member } = await memberContext(c.env, c.req.header("Authorization"), c.req.param("orgId"));
    const after = c.req.query("after");
    if (after && !channelIdValid(after)) throw new AccessError("INVALID_CURSOR", 400);
    return c.json(await c.env.ORGS.getByName(c.req.param("orgId")).channels(c.req.param("orgId"), member, after));
  })
  .post("/:orgId/channels", async c => {
    const orgId = c.req.param("orgId");
    const { member, actor } = await memberContext(c.env, c.req.header("Authorization"), orgId);
    if (member.role.slug !== "owner") throw new AccessError("ORGANIZATION_OWNER_REQUIRED", 403);
    const key = operation(c.req.header("Idempotency-Key"));
    const name = await body(c.req.raw, "name", 80);
    if (/[\r\n\t]/.test(name)) throw new AccessError("INVALID_CHANNEL_INPUT", 400);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([orgId, actor.type, actor.id, key])))), b => b.toString(16).padStart(2, "0")).join("");
    const result = await c.env.ORGS.getByName(orgId).createChannel(orgId, member, digest, "ch_" + digest, name);
    if (!result) throw new AccessError("OPERATION_CONFLICT", 409);
    return c.json(result);
  })
  .get("/:orgId/channels/:channelId", async c => {
    const { actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    return c.json(await channel.read(c.req.param("channelId"), actor));
  })
  .get("/:orgId/channels/:channelId/messages", async c => {
    const { actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    const raw = c.req.query("after") ?? "0";
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new AccessError("INVALID_CURSOR", 400);
    const result = await channel.history(c.req.param("channelId"), actor, Number(raw));
    if (!result) throw new AccessError("INVALID_CURSOR", 400);
    return c.json(result);
  })
  .post("/:orgId/channels/:channelId/messages", async c => {
    const { actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    const text = await body(c.req.raw, "text", 4000);
    const result = await channel.send(c.req.param("channelId"), actor, operation(c.req.header("Idempotency-Key")), text);
    if (!result) throw new AccessError("OPERATION_CONFLICT", 409);
    return c.json(result);
  });
