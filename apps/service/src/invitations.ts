import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { organizationLink } from "../db/d1/schema";
import { admit, AccessError } from "./auth/admission";
import { access, workos } from "./organizations";

type Invitation = { id: string; email: string; organization_id: string; inviter_user_id: string; role_slug: string; state: "pending" | "accepted" | "revoked" | "expired"; accepted_user_id: string | null; expires_at: string; created_at: string };
const validId = (id: string) => /^invitation_[A-Za-z0-9]+$/.test(id);
function invitation(value: unknown): Invitation {
  const v = value as Invitation;
  if (!v || !validId(v.id) || typeof v.email !== "string" || !/^org_[A-Za-z0-9]+$/.test(v.organization_id) || !/^user_[A-Za-z0-9]+$/.test(v.inviter_user_id) || v.role_slug !== "member" || !["pending", "accepted", "revoked", "expired"].includes(v.state) || !Number.isFinite(Date.parse(v.expires_at)) || !Number.isFinite(Date.parse(v.created_at)) || (v.accepted_user_id !== null && !/^user_[A-Za-z0-9]+$/.test(v.accepted_user_id))) throw new AccessError("INVITATION_UNAVAILABLE", 503);
  return v;
}
// Never return provider tokens or acceptance URLs to clients/logs.
function view(v: Invitation) {
  return { invitationId: v.id, organizationId: v.organization_id, email: v.email, role: "member", state: v.state === "pending" && Date.parse(v.expires_at) <= Date.now() ? "expired" : v.state, expiresAt: v.expires_at };
}
async function localOrg(env: Env, orgId: string) {
  if (!/^org_[A-Za-z0-9]+$/.test(orgId)) return false;
  return !!await drizzle(env.INSTANCE_DB).select().from(organizationLink).where(and(eq(organizationLink.orgId, orgId), eq(organizationLink.lifecycle, "active"))).get();
}
async function managed(env: Env, v: Invitation) {
  if (!await localOrg(env, v.organization_id)) return false;
  const row = await env.ORGS.getByName(v.organization_id).managedInvitation(v.organization_id, v.id);
  return !!row && row.email === v.email.toLowerCase() && row.inviterId === v.inviter_user_id;
}
async function get(env: Env, id: string) {
  if (!validId(id)) throw new AccessError("INVALID_INVITATION", 400);
  const raw = await workos(env, "/user_management/invitations/" + id);
  if (!raw) throw new AccessError("INVITATION_ACCESS_DENIED", 403);
  const v = invitation(raw);
  if (v.id !== id || !await managed(env, v)) throw new AccessError("INVITATION_ACCESS_DENIED", 403);
  return v;
}
async function owner(env: Env, authorization: string | undefined, orgId: string) {
  const identity = await admit(authorization, env);
  if (identity.organizationId !== orgId) throw new AccessError("ORGANIZATION_TOKEN_REQUIRED", 403);
  const member = await access(env, identity.userId, orgId);
  if (member.role.slug !== "owner") throw new AccessError("ORGANIZATION_OWNER_REQUIRED", 403);
  return member;
}
async function recipient(env: Env, authorization: string | undefined) {
  const identity = await admit(authorization, env);
  const user = await workos<{ id: string; email: string; email_verified: boolean }>(env, "/user_management/users/" + identity.userId);
  if (user?.id !== identity.userId || user.email_verified !== true || typeof user.email !== "string") throw new AccessError("INVITATION_ACCESS_DENIED", 403);
  return { userId: identity.userId, email: user.email.toLowerCase() };
}
async function page(env: Env, query: URLSearchParams) {
  const result = await workos<{ data: unknown[]; list_metadata: { after: string | null } }>(env, "/user_management/invitations?" + query);
  if (!result || !Array.isArray(result.data) || !result.list_metadata || (result.list_metadata.after !== null && !validId(result.list_metadata.after))) throw new AccessError("INVITATION_UNAVAILABLE", 503);
  return result;
}
function cursor(value?: string): Record<string, string> {
  if (value && !validId(value)) throw new AccessError("INVALID_CURSOR", 400);
  return value ? { after: value } : {};
}
const limit = bodyLimit({ maxSize: 4096, onError: c => c.json({ error: { code: "INVALID_INVITATION_INPUT" } }, 413) });
export const organizationInvitations = new Hono<{ Bindings: Env }>()
  .use("*", limit)
  .post("/:orgId/invitations", async c => {
    const orgId = c.req.param("orgId");
    const member = await owner(c.env, c.req.header("Authorization"), orgId);
    let body; try { body = await c.req.json(); } catch { throw new AccessError("INVALID_INVITATION_INPUT", 400); }
    if (!body || typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || Object.keys(body).some(k => k !== "email")) throw new AccessError("INVALID_INVITATION_INPUT", 400);
    const email = body.email.toLowerCase();
    const key = c.req.header("Idempotency-Key") ?? "";
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new AccessError("INVALID_OPERATION", 400);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([member.user_id, key])))), b => b.toString(16).padStart(2, "0")).join("");
    const org = c.env.ORGS.getByName(orgId);
    const operation = await org.reserveInvitation(orgId, member, digest, email);
    if (!operation) throw new AccessError("OPERATION_CONFLICT", 409);
    let value: Invitation;
    if (operation.invitationId) value = await get(c.env, operation.invitationId);
    else if (operation.fresh) {
      value = invitation(await workos(c.env, "/user_management/invitations", { email, organization_id: orgId, inviter_user_id: member.user_id, role_slug: "member", expires_in_days: 7, locale: "en" }));
    } else {
      // No documented upstream idempotency key. Never resend an uncertain operation.
      const candidates = await page(c.env, new URLSearchParams({ email, organization_id: orgId, limit: "100" }));
      const matches = candidates.data.map(x => x as Invitation).filter(v => v.email?.toLowerCase() === email && v.organization_id === orgId && v.inviter_user_id === member.user_id && v.role_slug === "member" && Date.parse(v.created_at) >= Date.parse(operation.createdAt));
      if (candidates.list_metadata.after || matches.length !== 1) throw new AccessError("OPERATION_RECONCILIATION_REQUIRED", 409);
      value = invitation(matches[0]);
    }
    if (value.organization_id !== orgId || value.email.toLowerCase() !== email || value.inviter_user_id !== member.user_id) throw new AccessError("INVITATION_UNAVAILABLE", 503);
    if (!await org.bindInvitation(orgId, digest, value.id)) throw new AccessError("OPERATION_CONFLICT", 409);
    return c.json(view(value));
  })
  .get("/:orgId/invitations", async c => {
    const orgId = c.req.param("orgId");
    await owner(c.env, c.req.header("Authorization"), orgId);
    const result = await page(c.env, new URLSearchParams({ organization_id: orgId, limit: "50", ...cursor(c.req.query("after")) }));
    const data = [];
    for (const raw of result.data) {
      const v = raw as Invitation;
      if (v.organization_id === orgId && v.role_slug === "member" && await managed(c.env, invitation(v))) data.push(view(v));
    }
    return c.json({ invitations: data, nextCursor: result.list_metadata.after });
  })
  .post("/:orgId/invitations/:id/revoke", async c => {
    const orgId = c.req.param("orgId");
    await owner(c.env, c.req.header("Authorization"), orgId);
    const v = await get(c.env, c.req.param("id"));
    if (v.organization_id !== orgId) throw new AccessError("INVITATION_ACCESS_DENIED", 403);
    if (v.state === "accepted") throw new AccessError("INVITATION_ALREADY_ACCEPTED", 409);
    if (v.state === "revoked" || view(v).state === "expired") return c.json(view(v));
    const result = invitation(await workos(c.env, "/user_management/invitations/" + v.id + "/revoke", {}));
    if (result.id !== v.id || result.state !== "revoked" || !await managed(c.env, result)) throw new AccessError("INVITATION_UNAVAILABLE", 503);
    return c.json(view(result));
  });
export const invitations = new Hono<{ Bindings: Env }>()
  .use("*", limit)
  .get("/", async c => {
    const user = await recipient(c.env, c.req.header("Authorization"));
    const result = await page(c.env, new URLSearchParams({ email: user.email, limit: "50", ...cursor(c.req.query("after")) }));
    const data = [];
    for (const raw of result.data) {
      const v = raw as Invitation;
      if (v.email?.toLowerCase() === user.email && v.role_slug === "member" && /^org_[A-Za-z0-9]+$/.test(v.organization_id) && await managed(c.env, invitation(v))) {
        const org = await c.env.ORGS.getByName(v.organization_id).read(v.organization_id);
        data.push({ ...view(v), organizationName: org.name });
      }
    }
    return c.json({ invitations: data, nextCursor: result.list_metadata.after });
  })
  .post("/:id/accept", async c => {
    const user = await recipient(c.env, c.req.header("Authorization"));
    let v = await get(c.env, c.req.param("id"));
    if (v.email.toLowerCase() !== user.email) throw new AccessError("INVITATION_ACCESS_DENIED", 403);
    if (v.state === "pending" && Date.parse(v.expires_at) > Date.now()) v = invitation(await workos(c.env, "/user_management/invitations/" + v.id + "/accept", {}));
    if (v.id !== c.req.param("id") || v.state !== "accepted" || v.accepted_user_id !== user.userId || v.email.toLowerCase() !== user.email || !await managed(c.env, v)) throw new AccessError("INVITATION_NOT_ACCEPTABLE", 409);
    const member = await access(c.env, user.userId, v.organization_id);
    const org = await c.env.ORGS.getByName(v.organization_id).view(v.organization_id, member);
    return c.json({ ...view(v), organizationName: org.name, role: member.role.slug, accepted: true });
  });
