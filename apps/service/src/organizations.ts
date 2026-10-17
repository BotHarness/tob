import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import { organizationLink, managementOperation } from "../db/d1/schema";
import { admit, requireOrganizationCreation, AccessError } from "./auth/admission";

type Membership = { created_at?: string; id: string; user_id: string; organization_id: string; status: string; role: { slug: string }; roles?: { slug: string }[] };
type ProviderOrg = { id: string; name: string; external_id: string };
export async function workos<T>(env: Env, path: string, body?: unknown): Promise<T | null> {
  if (!env.WORKOS_API_KEY) throw new AccessError("IDENTITY_UNAVAILABLE", 503);
  let r: Response;
  try { r = await fetch("https://api.workos.com" + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(10000) }); }
  catch { throw new AccessError("IDENTITY_UNAVAILABLE", 503); }
  if (r.status === 404 && body === undefined) return null;
  if (!r.ok) throw new AccessError("IDENTITY_UNAVAILABLE", 503);
  try { return await r.json() as T; } catch { throw new AccessError("IDENTITY_UNAVAILABLE", 503); }
}
export async function memberships(env: Env, userId: string, orgId?: string, after?: string) {
  const query = new URLSearchParams({ user_id: userId, limit: "100", ...(orgId ? { organization_id: orgId } : {}), ...(after ? { after } : {}) });
  const result = await workos<{ data: Membership[]; list_metadata: { after: string | null } }>(env, "/user_management/organization_memberships?" + query);
  if (!result || !Array.isArray(result.data) || !result.list_metadata) throw new AccessError("IDENTITY_UNAVAILABLE", 503);
  return result;
}
function allowed(m: Membership) {
  return m.status === "active" && ["owner", "member"].includes(m.role?.slug) && (!m.roles || (m.roles.length === 1 && m.roles[0].slug === m.role.slug));
}
function validId(id: string) { if (!/^org_[A-Za-z0-9]+$/.test(id)) throw new AccessError("INVALID_ORGANIZATION", 400); }
export async function access(env: Env, userId: string, orgId: string) {
  validId(orgId);
  const link = await drizzle(env.INSTANCE_DB).select().from(organizationLink).where(and(eq(organizationLink.orgId, orgId), eq(organizationLink.lifecycle, "active"))).get();
  if (!link) throw new AccessError("ORGANIZATION_ACCESS_DENIED", 403);
  const data = (await memberships(env, userId, link.workosOrgId)).data.filter(m => m.user_id === userId && m.organization_id === link.workosOrgId);
  if (data.length !== 1 || !allowed(data[0])) throw new AccessError("ORGANIZATION_ACCESS_DENIED", 403);
  return data[0];
}
async function hash(text: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join(""); }
export async function createOrganization(env: Env, actorId: string, key: string, name: string, kind = "organization.create") {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(key) || !name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new AccessError("INVALID_ORGANIZATION_INPUT", 400);
  name = name.trim();
  const roles = await workos<{ data: { slug: string; resource_type_slug?: string }[] }>(env, "/authorization/roles");
  if (!["owner", "member"].every(slug => roles?.data.some(r => r.slug === slug && (!r.resource_type_slug || r.resource_type_slug === "organization")))) throw new AccessError("ROLE_CONFIGURATION_INVALID", 503);
  const db = drizzle(env.INSTANCE_DB);
  const operationId = kind + ":" + await hash(actorId + ":" + key);
  const payloadHash = await hash(JSON.stringify({ name }));
  const externalId = env.INSTANCE_ID + ":" + operationId;
  // One D1 insert wins. Replays may reconcile this operation but never create another external resource.
  const inserted = await db.insert(managementOperation).values({ operationId, actorId, kind, payloadHash, targetId: externalId, state: "requested", updatedAt: new Date().toISOString() }).onConflictDoNothing().returning();
  let op = (await db.select().from(managementOperation).where(eq(managementOperation.operationId, operationId)).get())!;
  if (op.actorId !== actorId || op.payloadHash !== payloadHash || op.kind !== kind) throw new AccessError("OPERATION_CONFLICT", 409);
  if (op.state === "succeeded") { await access(env, actorId, op.targetId); return { organizationId: op.targetId, operationId, created: true }; }
  let org = await workos<ProviderOrg>(env, "/organizations/external_id/" + encodeURIComponent(externalId));
  if (!org) {
    if (!inserted.length) throw new AccessError("OPERATION_RECONCILIATION_REQUIRED", 409);
    org = await workos<ProviderOrg>(env, "/organizations", { name, external_id: externalId });
  }
  if (!org || org.external_id !== externalId || !/^org_[A-Za-z0-9]+$/.test(org.id)) throw new AccessError("OPERATION_RECONCILIATION_REQUIRED", 409);
  const now = new Date().toISOString();
  await db.insert(organizationLink).values({ orgId: org.id, workosOrgId: org.id, lifecycle: "creating", createdAt: now }).onConflictDoNothing();
  await db.update(managementOperation).set({ targetId: org.id, state: "organization_created", updatedAt: now }).where(and(eq(managementOperation.operationId, operationId), eq(managementOperation.state, "requested")));
  let all = (await memberships(env, actorId, org.id)).data;
  if (!all.length) {
    const won = await db.update(managementOperation).set({ state: "membership_requested", updatedAt: now }).where(and(eq(managementOperation.operationId, operationId), eq(managementOperation.state, "organization_created"))).returning();
    if (!won.length) throw new AccessError("OPERATION_RECONCILIATION_REQUIRED", 409);
    await workos(env, "/user_management/organization_memberships", { user_id: actorId, organization_id: org.id, role_slug: "owner" });
    all = (await memberships(env, actorId, org.id)).data;
  }
  if (all.length !== 1 || all[0].user_id !== actorId || all[0].organization_id !== org.id || !allowed(all[0]) || all[0].role.slug !== "owner") throw new AccessError("OWNER_MEMBERSHIP_REQUIRED", 409);
  const link = await db.select().from(organizationLink).where(eq(organizationLink.orgId, org.id)).get();
  if (!link || link.lifecycle === "disabled") throw new AccessError("ORGANIZATION_ACCESS_DENIED", 403);
  await env.ORGS.getByName(org.id).initialize(org.id, org.name);
  await db.batch([
    db.update(organizationLink).set({ lifecycle: "active" }).where(and(eq(organizationLink.orgId, org.id), eq(organizationLink.lifecycle, "creating"))),
    db.update(managementOperation).set({ state: "succeeded", targetId: org.id, updatedAt: now }).where(eq(managementOperation.operationId, operationId)),
  ]);
  return { organizationId: org.id, operationId, created: true };
}
const organizationBody = bodyLimit({ maxSize: 4096, onError: c => c.json({ error: { code: "INVALID_ORGANIZATION_INPUT" } }, 400) });
export const organizations = new Hono<{ Bindings: Env }>()
  .get("/", async c => {
    const identity = await admit(c.req.header("Authorization"), c.env);
    const after = c.req.query("after");
    if (after && !/^om_[A-Za-z0-9]+$/.test(after)) throw new AccessError("INVALID_CURSOR", 400);
    const page = await memberships(c.env, identity.userId, undefined, after);
    const active = page.data.filter(m => m.user_id === identity.userId && allowed(m));
    const links = active.length ? await drizzle(c.env.INSTANCE_DB).select().from(organizationLink).where(and(inArray(organizationLink.workosOrgId, active.map(m => m.organization_id)), eq(organizationLink.lifecycle, "active"))) : [];
    const data = await Promise.all(links.map(async link => {
      const m = active.find(m => m.organization_id === link.workosOrgId)!;
      const view = await c.env.ORGS.getByName(link.orgId).read(link.orgId);
      return { ...view, role: m.role.slug };
    }));
    return c.json({ organizations: data, nextCursor: page.list_metadata.after });
  })
  .post("/", organizationBody, async c => {
    const identity = await admit(c.req.header("Authorization"), c.env);
    await requireOrganizationCreation(identity, c.env);
    let body; try { body = await c.req.json(); } catch { throw new AccessError("INVALID_ORGANIZATION_INPUT", 400); }
    if (!body || typeof body.name !== "string" || Object.keys(body).some(k => k !== "name")) throw new AccessError("INVALID_ORGANIZATION_INPUT", 400);
    return c.json(await createOrganization(c.env, identity.userId, c.req.header("Idempotency-Key") ?? "", body.name));
  })
  .get("/:id/access", async c => {
    const i = await admit(c.req.header("Authorization"), c.env);
    const m = await access(c.env, i.userId, c.req.param("id"));
    return c.json({ organizationId: m.organization_id, role: m.role.slug });
  })
  .get("/:id", async c => {
    const i = await admit(c.req.header("Authorization"), c.env);
    if (i.organizationId !== c.req.param("id")) throw new AccessError("ORGANIZATION_TOKEN_REQUIRED", 403);
    const m = await access(c.env, i.userId, c.req.param("id"));
    return c.json({ ...await c.env.ORGS.getByName(m.organization_id).view(m.organization_id, m), role: m.role.slug });
  })
  .patch("/:id", organizationBody, async c => {
    const i = await admit(c.req.header("Authorization"), c.env);
    if (i.organizationId !== c.req.param("id")) throw new AccessError("ORGANIZATION_TOKEN_REQUIRED", 403);
    const m = await access(c.env, i.userId, c.req.param("id"));
    if (m.role.slug !== "owner") throw new AccessError("ORGANIZATION_OWNER_REQUIRED", 403);
    let body; try { body = await c.req.json(); } catch { throw new AccessError("INVALID_ORGANIZATION_INPUT", 400); }
    if (!body || typeof body.description !== "string" || body.description.length > 500 || !Number.isSafeInteger(body.version) || body.version < 1 || Object.keys(body).some(k => !["description", "version"].includes(k))) throw new AccessError("INVALID_ORGANIZATION_INPUT", 400);
    const result = await c.env.ORGS.getByName(m.organization_id).update(m.organization_id, m, body.description, body.version);
    if (!result) throw new AccessError("ORGANIZATION_VERSION_CONFLICT", 409);
    return c.json({ ...result, role: m.role.slug });
  });
