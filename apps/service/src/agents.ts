import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AccessError, admitUser } from "./auth/admission";
import { channelContext, body, operation } from "./channels";
import { access } from "./organizations";

const validActor = (value: string) => /^ag_[a-f0-9]{64}$/.test(value);
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
const limit = bodyLimit({ maxSize: 20000, onError: c => c.json({ error: { code: "INVALID_AGENT_INPUT" } }, 413) });
export const ownerAgents = new Hono<{ Bindings: Env }>()
  .use("*", limit)
  .get("/:orgId/channels/:channelId/agents", async c => {
    const { actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    const after = c.req.query("after") ?? "";
    if (after && !validActor(after)) throw new AccessError("INVALID_CURSOR", 400);
    return c.json(await channel.agents(c.req.param("channelId"), actor, after));
  })
  .post("/:orgId/channels/:channelId/agents", async c => {
    const { member, actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    if (member.role.slug !== "owner") throw new AccessError("ORGANIZATION_OWNER_REQUIRED", 403);
    const key = operation(c.req.header("Idempotency-Key"));
    let input;
    try { input = await c.req.json(); } catch { throw new AccessError("INVALID_AGENT_INPUT", 400); }
    // Client saves its random secret before issuing. Only its digest crosses this
    // endpoint, so a lost response is safely retried without recovering a secret.
    if (!input || Object.keys(input).some(k => !["name", "secretHash"].includes(k)) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 || /[\u0000-\u001f]/.test(input.name) || typeof input.secretHash !== "string" || !/^[a-f0-9]{64}$/.test(input.secretHash)) throw new AccessError("INVALID_AGENT_INPUT", 400);
    const actorId = "ag_" + await hash(JSON.stringify([c.req.param("channelId"), actor.id, key]));
    const result = await channel.issueAgent(c.req.param("channelId"), actor, member.id, actorId, input.name.trim(), input.secretHash);
    if (!result) throw new AccessError("OPERATION_CONFLICT", 409);
    return c.json(result);
  })
  .post("/:orgId/channels/:channelId/agents/:actorId/revoke", async c => {
    const { member, actor, channel } = await channelContext(c.env, c.req.header("Authorization"), c.req.param("orgId"), c.req.param("channelId"));
    if (member.role.slug !== "owner") throw new AccessError("ORGANIZATION_OWNER_REQUIRED", 403);
    if (!validActor(c.req.param("actorId"))) throw new AccessError("INVALID_AGENT_INPUT", 400);
    const result = await channel.revokeAgent(c.req.param("channelId"), actor, c.req.param("actorId"));
    if (!result) throw new AccessError("AGENT_ACCESS_DENIED", 403);
    return c.json(result);
  });

export async function authenticatedAgent(env: Env, header: string | undefined, channelId: string) {
  const parsed = /^Bearer tob_agent_(ag_[a-f0-9]{64})\.([a-f0-9]{64})$/.exec(header ?? "");
  if (!parsed || !/^ch_[a-f0-9]{64}$/.test(channelId)) throw new AccessError("AGENT_ACCESS_DENIED", 403);
  const [, actorId, secret] = parsed;
  const secretHash = await hash(secret);
  const channel = env.CHANNELS.getByName(channelId);
  const ctx = await channel.agentContext(channelId, actorId, secretHash);
  if (!ctx) throw new AccessError("AGENT_ACCESS_DENIED", 403);
  await admitUser(ctx.ownerUserId, env);
  const member = await access(env, ctx.ownerUserId, ctx.organizationId);
  if (member.id !== ctx.ownerMembershipId || member.role.slug !== "owner") throw new AccessError("AGENT_OWNER_ACCESS_DENIED", 403);
  return { channel, actorId, secretHash };
}
export const agentMessages = new Hono<{ Bindings: Env }>()
  .use("*", limit)
  .get("/:channelId/messages", async c => {
    const raw = c.req.query("after") ?? "0";
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new AccessError("INVALID_CURSOR", 400);
    const { channel, actorId, secretHash } = await authenticatedAgent(c.env, c.req.header("Authorization"), c.req.param("channelId"));
    const result = await channel.agentHistory(c.req.param("channelId"), actorId, secretHash, Number(raw));
    if (!result.allowed) throw new AccessError("AGENT_ACCESS_DENIED", 403);
    if (!result.result) throw new AccessError("INVALID_CURSOR", 400);
    return c.json(result.result);
  })
  .post("/:channelId/messages", async c => {
    const text = await body(c.req.raw, "text", 4000);
    const key = operation(c.req.header("Idempotency-Key"));
    const { channel, actorId, secretHash } = await authenticatedAgent(c.env, c.req.header("Authorization"), c.req.param("channelId"));
    // External membership verification can yield; local grant is rechecked here.
    const result = await channel.agentSend(c.req.param("channelId"), actorId, secretHash, key, text);
    if (!result.allowed) throw new AccessError("AGENT_ACCESS_DENIED", 403);
    if (!result.result) throw new AccessError("OPERATION_CONFLICT", 409);
    return c.json(result.result);
  });
