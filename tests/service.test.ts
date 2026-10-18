import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
const request = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://example.test${path}`, init));
beforeEach(async () => { await reset(); });
afterEach(() => { vi.restoreAllMocks(); });

it("reports its release but cannot report ready before D1 migrations", async () => {
  const live = await request("/healthz");
  expect(live.status).toBe(200);
  expect(await live.json()).toMatchObject({ service: "tob", environment: "local", releaseSha: "local", businessEnabled: true });
  const ready = await request("/readyz");
  expect(ready.status).toBe(503);
  expect(await ready.json()).toEqual({ error: { code: "STORAGE_UNAVAILABLE" } });
});

it("migrates both real SQLite bindings and repeated migrations keep data", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS);
  await env.INSTANCE_DB.prepare("INSERT INTO instance_config VALUES (1, 'admin_only', 'admin_only', 7)").run();
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS);
  const ready = await request("/readyz");
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({ ready: true, d1SchemaVersion: 5, orgSchemaVersion: 4, channelSchemaVersion: 5, businessEnabled: true });
  expect(await env.INSTANCE_DB.prepare("SELECT config_version FROM instance_config").first("config_version")).toBe(7);
  await expect(env.INSTANCE_DB.prepare("INSERT INTO instance_config VALUES (2,'admin_only','admin_only',1)").run()).rejects.toThrow();
});

it("exposes no public bootstrap or business writes, even with spoofed identity", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS);
  for (const path of ["/api/admin/initialize"]) {
    const response = await request(path, { method: "POST", headers: { Authorization: "Bearer public-test-fixture", "X-User-Id": "user_fixture", "X-Role": "owner" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "FEATURE_NOT_AVAILABLE" } });
  }
  expect((await request("/api/me")).status).toBe(401);
  expect(await env.INSTANCE_DB.prepare("SELECT count(*) AS n FROM instance_admin").first("n")).toBe(0);
});

it("Org migrations survive eviction without duplicate application and keep objects isolated", async () => {
  const first = env.ORGS.getByName("test-org-a");
  const second = env.ORGS.getByName("test-org-b");
  await first.schemaStatus();
  await second.schemaStatus();
  await runInDurableObject(first, (_instance, state) => {
    state.storage.sql.exec("INSERT INTO org_config (org_id,status,policy_json,version) VALUES ('org_fixture','active','{}',1)");
  });
  await evictDurableObject(first);
  expect(await first.schemaStatus()).toEqual({ schemaVersion: 4 });
  expect(await runInDurableObject(first, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM org_config").one().n)).toBe(1);
  expect(await runInDurableObject(first, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations").one().n)).toBe(4);
  expect(await runInDurableObject(second, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM org_config").one().n)).toBe(0);
});

import { generateKeyPair, exportJWK, SignJWT, type JWTPayload } from "jose";
import { INITIALIZE_SQL, checkReceipt, type Receipt } from "../tools/bootstrap/contract";
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keyPair = await generateKeyPair("RS256");
  publicKey = { ...await exportJWK(keyPair.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
});
function mockKeys() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toBe("https://api.workos.com/sso/jwks/client_local");
    return Response.json({ keys: [publicKey] });
  });
}
const token = (claims: JWTPayload = {}) => new SignJWT({ sub: "user_admin", sid: "session_fixture", iss: "https://api.workos.com/user_management/client_local", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, ...claims }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(keyPair.privateKey);
const authenticated = async (claims: JWTPayload = {}) => request("/api/me", { headers: { Authorization: "Bearer " + await token(claims) } });
const initialize = (userId = "user_admin", hash = "a".repeat(64)) => env.INSTANCE_DB.prepare(INITIALIZE_SQL).bind("test-deployer", hash, userId, "2026-10-18T00:00:00Z").run();

it("requires valid signature and claims, then the durable policy/receipt/active administrator", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); mockKeys();
  expect((await authenticated()).status).toBe(503);
  await initialize();
  const accepted = await authenticated();
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ userId: "user_admin", instanceId: "tob-local", instanceRole: "admin", capabilities: ["instance:read-self"] });
  expect((await authenticated({ sub: "user_other" })).status).toBe(403);
  for (const claims of [{ iss: "https://other.example/" }, { iss: "https://api.workos.com/" }, { iss: "https://api.workos.com/user_management/client_other" }, { exp: 1 }, { sid: undefined }, { aud: "client_other" }, { azp: "client_other" }, { sub: "agent_untrusted" }]) expect((await authenticated(claims)).status).toBe(401);
  const otherKey = await generateKeyPair("RS256");
  const forged = await new SignJWT({ sub: "user_admin", sid: "session_fixture" }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer("https://api.workos.com/user_management/client_local").setIssuedAt().setExpirationTime("5m").sign(otherKey.privateKey);
  expect((await request("/api/me", { headers: { Authorization: "Bearer " + forged } })).status).toBe(401);
  await env.INSTANCE_DB.prepare("UPDATE instance_admin SET status='revoked'").run();
  expect((await authenticated()).status).toBe(403);
  await initialize();
  expect(await env.INSTANCE_DB.prepare("SELECT status FROM instance_admin").first("status")).toBe("revoked");
  await env.INSTANCE_DB.prepare("DELETE FROM instance_config").run();
  expect((await authenticated()).status).toBe(503);
});

it("provider failure cannot grant access or appear as successful authentication", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
  expect((await authenticated()).status).toBe(503);
});

it("first admin is atomic, replayable and single-winner across concurrent different targets", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS);
  await Promise.all([initialize("user_a", "a".repeat(64)), initialize("user_b", "b".repeat(64))]);
  const receipt = await env.INSTANCE_DB.prepare("SELECT * FROM management_operation").first<Receipt>();
  expect(await env.INSTANCE_DB.prepare("SELECT count(*) AS n FROM instance_admin").first("n")).toBe(1);
  const winner = receipt!.target_id;
  const hash = receipt!.payload_hash;
  await initialize(winner, hash); // response-lost replay keeps original state
  const admin = await env.INSTANCE_DB.prepare("SELECT * FROM instance_admin").first<{ status: string; granted_at: string }>();
  expect(() => checkReceipt(receipt, hash, winner, admin!.status, true)).not.toThrow();
  expect(admin!.granted_at).toBe("2026-10-18T00:00:00Z");
  expect(() => checkReceipt(receipt, "c".repeat(64), "user_c", "active", true)).toThrow();
  await env.INSTANCE_DB.prepare("UPDATE instance_admin SET status='inactive'").run();
  await initialize(winner, hash);
  expect(() => checkReceipt(receipt, hash, winner, "inactive", true)).toThrow();
  expect(await env.INSTANCE_DB.prepare("SELECT status FROM instance_admin").first("status")).toBe("inactive");
});

it("failure after policy insertion rolls back policy, administrator and receipt together", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS);
  await env.INSTANCE_DB.prepare("CREATE TRIGGER test_failure BEFORE INSERT ON instance_admin BEGIN SELECT RAISE(ABORT, 'TEST_FAILURE'); END").run();
  await expect(initialize()).rejects.toThrow();
  for (const table of ["instance_admin", "instance_config", "management_operation"]) expect(await env.INSTANCE_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n")).toBe(0);
});

it("publishes configured connection identity, independent of request host or caller input", async () => {
  const r = await request("/.well-known/open-cloud-groups", { headers: { "X-Forwarded-Host": "attacker.example" } });
  expect(r.status).toBe(200);
  const body = await r.json() as { server: string; auth: { clientId: string; mobileRedirectUris: string[] } };
  expect(body.server).toBe("https://example.test");
  expect(body.auth.clientId).toBe("client_local");
  expect(body.auth.mobileRedirectUris).toEqual([]);
  expect(JSON.stringify(body)).not.toContain("local-test-secret");
});

it("logout revokes only the signed current session, even without business admission", async () => {
  const revokeCalls: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "https://api.workos.com/sso/jwks/client_local") return Response.json({ keys: [publicKey] });
    expect(String(url)).toBe("https://api.workos.com/user_management/sessions/revoke");
    // Exercise native workerd option validation; a fetch mock alone hid the runtime failure.
    const outgoing = new Request(String(url), init);
    expect(outgoing.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer local-test-secret");
    revokeCalls.push(JSON.parse(String(init?.body))); return new Response(null, { status: 200 });
  });
  expect((await request("/api/auth/logout", { method: "POST", body: '{"session_id":"session_victim"}' })).status).toBe(401);
  expect(revokeCalls).toEqual([]);
  const r = await request("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + await token() }, body: '{"session_id":"session_victim"}' });
  expect(await r.json()).toEqual({ remoteRevoked: true });
  expect(revokeCalls).toEqual([{ session_id: "session_fixture" }]);
});

it("logout provider failure is never reported as revoked", async () => {
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async url => String(url).includes("/jwks/") ? Response.json({ keys: [publicKey] }) : new Response(null, { status: 503 }));
  const r = await request("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + await token() } });
  expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: { code: "LOGOUT_UNCONFIRMED" } });
  expect(logs).toHaveBeenCalledWith(JSON.stringify({ event: "session_logout_unconfirmed", phase: "provider_response", status: 503 }));
});

it("logout transport diagnostics exclude exception messages and credentials", async () => {
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    if (String(url).includes("/jwks/")) return Response.json({ keys: [publicKey] });
    throw new TypeError("sensitive upstream text");
  });
  const r = await request("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + await token() } });
  expect(r.status).toBe(503);
  expect(logs).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "session_logout_unconfirmed", phase: "provider_transport", kind: "TypeError" }));
});

it("logout refuses provider redirects without following them or reporting revocation", async () => {
  const calls: string[] = [];
  const logs = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/jwks/")) return Response.json({ keys: [publicKey] });
    const outgoing = new Request(String(url), init);
    expect(outgoing.redirect).toBe("manual");
    calls.push(outgoing.url);
    return new Response(null, { status: 302, headers: { Location: "https://untrusted.example/" } });
  });
  const r = await request("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + await token() } });
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: { code: "LOGOUT_UNCONFIRMED" } });
  expect(calls).toEqual(["https://api.workos.com/user_management/sessions/revoke"]);
  expect(logs).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "session_logout_unconfirmed", phase: "provider_response", status: 302 }));
});

function organizationProvider(options: { loseCreate?: boolean; loseMembership?: boolean; missingRole?: boolean; userVerified?: boolean; missingUser?: boolean } = {}) {
  let org: { id: string; name: string; external_id: string } | undefined;
  let member: { created_at: string; id: string; user_id: string; organization_id: string; status: string; role: { slug: string }; roles?: { slug: string }[] } | undefined;
  const calls = { creates: 0, members: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/jwks/")) return Response.json({ keys: [publicKey] });
    expect(new Request(String(input), init).redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer local-test-secret");
    const data = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname.startsWith("/user_management/users/")) return options.missingUser ? new Response(null, { status: 404 }) : Response.json({ id: url.pathname.split("/").at(-1), email_verified: options.userVerified !== false });
    if (url.pathname === "/authorization/roles") return Response.json({ data: [{ slug: "member" }, ...options.missingRole ? [] : [{ slug: "owner" }]] });
    if (url.pathname.startsWith("/organizations/external_id/")) return org ? Response.json(org) : new Response(null, { status: 404 });
    if (url.pathname === "/organizations") { calls.creates++; org = { id: "org_test", name: data.name, external_id: data.external_id }; if (options.loseCreate) { options.loseCreate = false; throw new TypeError("lost response"); } return Response.json(org); }
    if (url.pathname === "/user_management/organization_memberships") {
      if (init?.method === "POST") {
        calls.members++; member = { created_at: "2026-01-01T00:00:00.000Z", id: "om_test", user_id: data.user_id, organization_id: data.organization_id, status: "active", role: { slug: data.role_slug } };
        if (options.loseMembership) { options.loseMembership = false; throw new TypeError("lost response"); }
        return Response.json(member);
      }
      return Response.json({ data: member ? [member] : [], list_metadata: { after: null } });
    }
    throw new Error("unexpected provider route");
  });
  return { calls, get member() { return member; } };
}
async function orgRequest(path = "", method = "GET", body?: unknown, claims: JWTPayload = {}, key = "fixture-operation-0001") {
  return request("/api/organizations" + path, { method, headers: { Authorization: "Bearer " + await token(claims), "Content-Type": "application/json", "Idempotency-Key": key }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
it("creates once across concurrent/replayed requests, persists Org DO settings and lists only mapped memberships", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  const provider = organizationProvider();
  const results = await Promise.all([orgRequest("", "POST", { name: "Mobile workspace" }), orgRequest("", "POST", { name: "Mobile workspace" })]);
  expect(results.some(r => r.status === 200)).toBe(true);
  expect(provider.calls).toEqual({ creates: 1, members: 1 });
  expect((await orgRequest("", "POST", { name: "Mobile workspace" })).status).toBe(200);
  expect((await orgRequest("", "POST", { name: "Changed payload" })).status).toBe(409);
  expect(await (await orgRequest()).json()).toMatchObject({ organizations: [{ organizationId: "org_test", role: "owner", name: "Mobile workspace" }], nextCursor: null });
  expect((await orgRequest("/org_test")).status).toBe(403);
  expect((await orgRequest("/org_test/access")).status).toBe(200);
  const scoped = { org_id: "org_test" };
  expect((await orgRequest("/org_test", "PATCH", { description: "Project notes", version: 1 }, scoped)).status).toBe(200);
  expect((await orgRequest("/org_test", "PATCH", { description: "Old writer", version: 1 }, scoped)).status).toBe(409);
  await evictDurableObject(env.ORGS.getByName("org_test"));
  expect(await (await orgRequest("/org_test", "GET", undefined, scoped)).json()).toMatchObject({ description: "Project notes", version: 2, role: "owner" });
  expect((await orgRequest("/org_other", "GET", undefined, { org_id: "org_other" })).status).toBe(403);
});
it.each(["loseCreate", "loseMembership"] as const)("reconciles %s without creating a duplicate or escalating a changed membership", async kind => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  const provider = organizationProvider({ [kind]: true });
  expect((await orgRequest("", "POST", { name: "Recovery" })).status).toBe(503);
  expect(await env.INSTANCE_DB.prepare("SELECT count(*) AS n FROM organization_link WHERE lifecycle='active'").first("n")).toBe(0);
  expect((await orgRequest("", "POST", { name: "Recovery" })).status).toBe(200);
  expect(provider.calls).toEqual({ creates: 1, members: 1 });
});
it("checks live membership rather than stale owner claims or administrator status, and fails closed on outages", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  const provider = organizationProvider();
  await orgRequest("", "POST", { name: "Permission check" });
  const staleOwner = { org_id: "org_test", role: "owner", permissions: ["*"] };
  provider.member!.role.slug = "member";
  expect((await orgRequest("/org_test", "GET", undefined, staleOwner)).status).toBe(200);
  const denied = await orgRequest("/org_test", "PATCH", { description: "Forbidden", version: 1 }, staleOwner);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: { code: "ORGANIZATION_OWNER_REQUIRED" } });
  expect(await (await orgRequest("/org_test", "GET", undefined, staleOwner)).json()).toMatchObject({ description: "", version: 1, role: "member" });
  provider.member!.status = "inactive";
  expect((await orgRequest("/org_test/access")).status).toBe(403);
  expect(await (await orgRequest()).json()).toMatchObject({ organizations: [] });
  provider.member!.status = "active"; provider.member!.role.slug = "admin";
  expect((await orgRequest("/org_test", "GET", undefined, staleOwner)).status).toBe(403);
  provider.member!.role.slug = "owner"; provider.member!.roles = [{ slug: "owner" }, { slug: "member" }];
  expect((await orgRequest("/org_test", "GET", undefined, staleOwner)).status).toBe(403);
  expect((await orgRequest("", "POST", { name: "Forbidden" }, { sub: "user_other", role: "owner" })).status).toBe(403);
  expect(provider.calls.creates).toBe(1);
});
it("missing owner cannot fall back to default member and caller roles are rejected", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  const provider = organizationProvider({ missingRole: true });
  expect((await orgRequest("", "POST", { name: "Invalid role" })).status).toBe(503);
  expect(provider.calls).toEqual({ creates: 0, members: 0 });
  expect((await orgRequest("", "POST", { name: "Spoof", role: "owner" })).status).toBe(400);
});

it("creation recovery never promotes a membership changed to member after response loss", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  const provider = organizationProvider({ loseMembership: true });
  expect((await orgRequest("", "POST", { name: "Interrupted owner" })).status).toBe(503);
  provider.member!.role.slug = "member";
  const retry = await orgRequest("", "POST", { name: "Interrupted owner" });
  expect(retry.status).toBe(409);
  expect(await retry.json()).toEqual({ error: { code: "OWNER_MEMBERSHIP_REQUIRED" } });
  expect(provider.calls).toEqual({ creates: 1, members: 1 });
  expect(await env.INSTANCE_DB.prepare("SELECT count(*) AS n FROM organization_link WHERE lifecycle='active'").first("n")).toBe(0);
});
it("provider outage after a successful owner read cannot authorize a cached settings write", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  organizationProvider(); await orgRequest("", "POST", { name: "No stale grants" });
  expect((await orgRequest("/org_test", "GET", undefined, { org_id: "org_test" })).status).toBe(200);
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(async url => String(url).includes("/jwks/") ? Response.json({ keys: [publicKey] }) : new Response(null, { status: 503 }));
  expect((await orgRequest("/org_test", "PATCH", { description: "Offline write", version: 1 }, { org_id: "org_test" })).status).toBe(503);
  expect(await env.ORGS.getByName("org_test").read("org_test")).toMatchObject({ version: 1, description: "" });
});

const enableUsers = () => env.INSTANCE_DB.prepare("UPDATE instance_config SET registration_mode='authenticated',org_creation_mode='all_users',config_version=config_version+1 WHERE singleton_id=1").run();
const onboard = async (claims: JWTPayload = {}) => request('/api/onboarding', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(claims) } });
it('admits verified ordinary users without administrator grants and provisions one default workspace across retries', async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  const p = organizationProvider();
  expect((await onboard({ sub: 'user_a' })).status).toBe(403);
  await enableUsers();
  const me = await authenticated({ sub: 'user_a' });
  expect(await me.json()).toMatchObject({ userId: 'user_a', instanceRole: 'user' });
  expect(p.calls.creates).toBe(0); // GET has no provisioning side effect
  const results = await Promise.all([onboard({ sub: 'user_a' }), onboard({ sub: 'user_a' })]);
  expect(results.some(r => r.status === 200)).toBe(true);
  expect((await onboard({ sub: 'user_a' })).status).toBe(200);
  expect(p.calls).toEqual({ creates: 1, members: 1 });
  expect(p.member?.user_id).toBe('user_a');
  expect(p.member?.role.slug).toBe('owner');
  expect(await env.INSTANCE_DB.prepare('SELECT count(*) AS n FROM instance_admin').first('n')).toBe(1);
  expect((await orgRequest('/org_test/access', 'GET', undefined, { sub: 'user_b' })).status).toBe(403);
  await env.INSTANCE_DB.prepare("UPDATE instance_config SET org_creation_mode='admin_only'").run();
  expect((await orgRequest('', 'POST', { name: 'Second workspace' }, { sub: 'user_a' })).status).toBe(403);
  expect((await onboard({ sub: 'user_a' })).status).toBe(200);
});
it.each([{ userVerified: false }, { missingUser: true }])('does not provision an unverified or deleted provider user: %j', async options => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize(); await enableUsers();
  const p = organizationProvider(options);
  expect((await onboard({ sub: 'user_a' })).status).toBe(403);
  expect(p.calls.creates).toBe(0);
});
it('default workspace response loss is recoverable without promoting a changed membership', async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize(); await enableUsers();
  const p = organizationProvider({ loseMembership: true });
  expect((await onboard({ sub: 'user_a' })).status).toBe(503);
  expect((await onboard({ sub: 'user_a' })).status).toBe(200);
  p.member!.role.slug = 'member';
  expect((await onboard({ sub: 'user_a' })).status).toBe(200);
  expect(p.calls).toEqual({ creates: 1, members: 1 });
  expect(p.member!.role.slug).toBe('member');
  await env.INSTANCE_DB.prepare("UPDATE instance_admin SET status='revoked'").run();
  expect((await authenticated()).status).toBe(403);
});
it('two ordinary users receive distinct default organizations, while one user can create a second and switch without cross-user access', async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize(); await enableUsers();
  const orgs = new Map<string, { id: string; external_id: string; name: string }>();
  const members: { id: string; user_id: string; organization_id: string; status: string; role: { slug: string } }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.includes('/jwks/')) return Response.json({ keys: [publicKey] });
    const data = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.pathname.startsWith('/user_management/users/')) return Response.json({ id: u.pathname.split('/').at(-1), email_verified: true });
    if (u.pathname === '/authorization/roles') return Response.json({ data: [{ slug: 'owner' }, { slug: 'member' }] });
    if (u.pathname.startsWith('/organizations/external_id/')) {
      const org = orgs.get(decodeURIComponent(u.pathname.split('/').at(-1)!));
      return org ? Response.json(org) : new Response(null, { status: 404 });
    }
    if (u.pathname === '/organizations') { const org = { id: 'org_' + (orgs.size + 1), ...data }; orgs.set(data.external_id, org); return Response.json(org); }
    if (u.pathname === '/user_management/organization_memberships') {
      if (init?.method === 'POST') {
        const m = { id: 'om_' + (members.length + 1), user_id: data.user_id, organization_id: data.organization_id, status: 'active', role: { slug: data.role_slug } }; members.push(m); return Response.json(m);
      }
      return Response.json({ data: members.filter(m => m.user_id === u.searchParams.get('user_id') && (!u.searchParams.has('organization_id') || m.organization_id === u.searchParams.get('organization_id'))), list_metadata: { after: null } });
    }
    throw Error('unexpected provider request');
  });
  const a = { sub: 'user_a' }, b = { sub: 'user_b' };
  expect((await onboard(a)).status).toBe(200);
  expect((await onboard(b)).status).toBe(200);
  const extra = await orgRequest('', 'POST', { name: 'Another workspace' }, a, 'second-workspace-operation');
  expect(extra.status).toBe(200);
  expect((await onboard(a)).status).toBe(200);
  expect(orgs.size).toBe(3);
  expect(await (await orgRequest('', 'GET', undefined, a)).json()).toMatchObject({ organizations: [{ organizationId: 'org_1' }, { organizationId: 'org_3' }] });
  expect(await (await orgRequest('', 'GET', undefined, b)).json()).toMatchObject({ organizations: [{ organizationId: 'org_2' }] });
  for (const id of ['org_1', 'org_3']) {
    expect((await orgRequest('/' + id, 'GET', undefined, { ...a, org_id: id })).status).toBe(200);
    expect((await orgRequest('/' + id, 'GET', undefined, { ...b, org_id: id })).status).toBe(403);
  }
});
it('upgrades an already initialized instance without changing admin binding or opening admission', async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS.slice(0, 3));
  await initialize();
  await env.INSTANCE_DB.prepare('UPDATE instance_config SET config_version=7').run();
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS);
  expect(await env.INSTANCE_DB.prepare('SELECT * FROM instance_config').first()).toEqual({ singleton_id: 1, registration_mode: 'admin_only', org_creation_mode: 'admin_only', config_version: 7 });
  expect(await env.INSTANCE_DB.prepare('SELECT workos_user_id FROM instance_admin').first('workos_user_id')).toBe('user_admin');
  await initialize('user_other');
  expect(await env.INSTANCE_DB.prepare('SELECT workos_user_id FROM instance_admin').first('workos_user_id')).toBe('user_admin');
});

async function channelFixture() {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize();
  const provider = organizationProvider();
  expect((await orgRequest("", "POST", { name: "Channels workspace" })).status).toBe(200);
  const call = (path = "", method = "GET", body?: unknown, key = "channel-operation-0001", claims: JWTPayload = { org_id: "org_test" }) => orgRequest("/org_test/channels" + path, method, body, claims, key);
  return { provider, call };
}
it("creates multiple channels, replays one operation, persists messages across eviction and rejects changed payload", async () => {
  const { call } = await channelFixture();
  const first = await (await call("", "POST", { name: "general" })).json() as { channelId: string };
  const same = await Promise.all(Array.from({ length: 3 }, () => call("", "POST", { name: "general" })));
  for (const result of same) expect(await result.json()).toMatchObject(first);
  expect((await call("", "POST", { name: "changed" })).status).toBe(409);
  const second = await (await call("", "POST", { name: "research" }, "channel-operation-0002")).json() as { channelId: string };
  expect(first.channelId).not.toBe(second.channelId);
  expect(await (await call()).json()).toMatchObject({ channels: expect.arrayContaining([{ channelId: first.channelId, name: "general", creatorId: "user_admin", creatorType: "human", createdAt: expect.any(String) }]), nextCursor: null });
  const path = "/" + first.channelId + "/messages";
  const sent = await (await call(path, "POST", { text: "First durable text" })).json();
  expect(sent).toMatchObject({ message: { sequence: 1, authorId: "user_admin", text: "First durable text" }, replayed: false });
  expect(await (await call(path, "POST", { text: "First durable text" })).json()).toMatchObject({ replayed: true, message: { sequence: 1 } });
  expect((await call(path, "POST", { text: "Changed text" })).status).toBe(409);
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => call(path, "POST", { text: "Concurrent text" }, "message-operation-0002")));
  for (const r of concurrent) expect(await r.json()).toMatchObject({ message: { sequence: 2 } });
  await evictDurableObject(env.CHANNELS.getByName(first.channelId));
  await evictDurableObject(env.ORGS.getByName("org_test"));
  expect(await (await call(path)).json()).toMatchObject({ messages: [{ sequence: 1 }, { sequence: 2 }], nextCursor: 2, hasMore: false });
  expect(await (await call(path + "?after=1")).json()).toMatchObject({ messages: [{ sequence: 2 }], nextCursor: 2 });
  expect(await (await call("/" + second.channelId + "/messages")).json()).toEqual({ messages: [], nextCursor: 0, hasMore: false });
  for (const cursor of ["-1", "NaN", "3", "9007199254740992"]) expect((await call(path + "?after=" + cursor)).status).toBe(400);
});
it("checks current membership on every channel request, enforces creator policy and ignores spoofed authors", async () => {
  const { call, provider } = await channelFixture();
  const first = await (await call("", "POST", { name: "general" })).json() as { channelId: string };
  const path = "/" + first.channelId + "/messages";
  expect((await call(path, "POST", { text: "spoof", authorId: "user_other" })).status).toBe(400);
  expect((await call("", "GET", undefined, "channel-operation-0001", {})).status).toBe(403);
  expect((await orgRequest("/org_other/channels/" + first.channelId, "GET", undefined, { org_id: "org_other" })).status).toBe(403);
  provider.member!.role.slug = "member";
  expect((await call()).status).toBe(200);
  expect((await call("", "POST", { name: "forbidden" }, "channel-operation-0003")).status).toBe(403);
  expect((await call(path, "POST", { text: "member text" })).status).toBe(200);
  provider.member!.created_at = new Date(Date.now() + 1000).toISOString();
  expect(await (await call(path)).json()).toMatchObject({ messages: [] });
  provider.member!.status = "inactive";
  for (const [route, method, body] of [["", "GET", undefined], [path, "GET", undefined], [path, "POST", { text: "revoked" }]] as const) expect((await call(route, method, body)).status).toBe(403);
});
it("hides incomplete channel initialization and repairs the same durable operation after failure", async () => {
  const { call } = await channelFixture();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["org_test", "human", "user_admin", "channel-operation-0001"])))), b => b.toString(16).padStart(2, "0")).join("");
  const stub = env.CHANNELS.getByName("ch_" + digest);
  await stub.schemaStatus();
  await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("CREATE TRIGGER fail_initialize BEFORE INSERT ON channel_config BEGIN SELECT RAISE(ABORT, 'INJECTED_FAILURE'); END"); });
  expect((await call("", "POST", { name: "general" })).status).toBe(503);
  expect(await (await call()).json()).toEqual({ channels: [], nextCursor: null });
  await evictDurableObject(env.ORGS.getByName("org_test"));
  await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("DROP TRIGGER fail_initialize"); });
  expect(await (await call("", "POST", { name: "general" })).json()).toMatchObject({ channelId: "ch_" + digest });
  expect((await (await call()).json() as { channels: unknown[] }).channels).toHaveLength(1);
});
it("accepts bounded Unicode messages and paginates durable history without skipping rows", async () => {
  const { call } = await channelFixture();
  const channel = await (await call("", "POST", { name: "general" })).json() as { channelId: string };
  const path = "/" + channel.channelId + "/messages";
  expect((await call(path, "POST", { text: "测".repeat(4000) })).status).toBe(200);
  expect((await call(path, "POST", { text: "测".repeat(4001) }, "message-too-long-0001")).status).toBe(400);
  for (let n = 2; n <= 51; n++) expect((await call(path, "POST", { text: "Message " + n }, "page-operation-" + String(n).padStart(4,"0"))).status).toBe(200);
  const first = await (await call(path)).json() as { messages: { sequence: number }[]; hasMore: boolean; nextCursor: number };
  expect(first.messages).toHaveLength(50);expect(first.hasMore).toBe(true);expect(first.nextCursor).toBe(50);
  expect(await (await call(path + "?after=" + first.nextCursor)).json()).toMatchObject({ messages: [{ sequence: 51 }], nextCursor: 51, hasMore: false });
});

async function invitationFixture() {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS); await initialize(); await enableUsers();
  await env.INSTANCE_DB.prepare("INSERT INTO organization_link (org_id,workos_org_id,lifecycle,created_at) VALUES ('org_invites','org_invites','active','2026-01-01T00:00:00Z')").run();
  await env.ORGS.getByName('org_invites').initialize('org_invites', 'Invitation workspace');
  const members = [{ id: 'om_owner', user_id: 'user_a', organization_id: 'org_invites', status: 'active', role: { slug: 'owner' }, created_at: '2026-01-01T00:00:00Z' }];
  type TestInvite = { id: string; email: string; organization_id: string; inviter_user_id: string; role_slug: string; state: string; accepted_user_id: string | null; created_at: string; expires_at: string; token: string; accept_invitation_url: string };
  const invites: TestInvite[] = [];
  const controls = { loseSend: false, loseAccept: false, verified: true, sends: 0, accepts: 0 };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname.includes('/jwks/')) return Response.json({ keys: [publicKey] });
    if (u.pathname.startsWith('/user_management/users/')) { const id = u.pathname.split('/').at(-1)!; return Response.json({ id, email: id + '@example.test', email_verified: controls.verified }); }
    if (u.pathname === '/user_management/organization_memberships') return Response.json({ data: members.filter(m => m.status === 'active' && m.user_id === u.searchParams.get('user_id') && (!u.searchParams.has('organization_id') || m.organization_id === u.searchParams.get('organization_id'))), list_metadata: { after: null } });
    if (u.pathname === '/user_management/invitations') {
      if (init?.method === 'POST') {
        controls.sends++;
        const data = JSON.parse(String(init.body));
        const v = { ...data, id: 'invitation_' + (invites.length + 1), state: 'pending', accepted_user_id: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), token: 'private-invitation-token', accept_invitation_url: 'https://private.example/?invitation_token=secret' };
        invites.push(v);
        if (controls.loseSend) { controls.loseSend = false; return new Response(null, { status: 503 }); }
        return Response.json(v);
      }
      return Response.json({ data: invites.filter(v => (!u.searchParams.has('email') || v.email === u.searchParams.get('email')) && (!u.searchParams.has('organization_id') || v.organization_id === u.searchParams.get('organization_id'))), list_metadata: { after: null } });
    }
    const match = u.pathname.match(/^\/user_management\/invitations\/(invitation_[A-Za-z0-9]+)(?:\/(accept|revoke))?$/);
    if (match) {
      const v = invites.find(v => v.id === match[1]);
      if (!v) return new Response(null, { status: 404 });
      if (match[2] === 'accept') {
        controls.accepts++;
        v.state = 'accepted'; v.accepted_user_id = v.email.split('@')[0];
        members.push({ id: 'om_invited', user_id: v.accepted_user_id, organization_id: v.organization_id, status: 'active', role: { slug: v.role_slug }, created_at: '2026-01-01T00:00:00Z' });
        if (controls.loseAccept) { controls.loseAccept = false; return new Response(null, { status: 503 }); }
      }
      if (match[2] === 'revoke') v.state = 'revoked';
      return Response.json(v);
    }
    throw Error('unexpected invitation provider call');
  });
  const call = async (path: string, user = 'user_a', method = 'GET', body?: unknown, key = 'invitation-operation-0001') => request('/api' + path, { method, headers: { Authorization: 'Bearer ' + await token({ sub: user, org_id: 'org_invites' }), 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const send = (email = 'user_b@example.test', key = 'invitation-operation-0001') => call('/organizations/org_invites/invitations', 'user_a', 'POST', { email }, key);
  return { members, invites, controls, call, send };
}
it('owner invites B, only B can accept, B sees channels as member without old messages or owner rights', async () => {
  const { call, send, controls } = await invitationFixture();
  const channel = await (await call('/organizations/org_invites/channels', 'user_a', 'POST', { name: 'general' }, 'create-channel-invitation')).json() as { channelId: string };
  const messages = '/organizations/org_invites/channels/' + channel.channelId + '/messages';
  expect((await call(messages, 'user_a', 'POST', { text: 'Before B joined' })).status).toBe(200);
  await runInDurableObject(env.CHANNELS.getByName(channel.channelId), (_instance, state) => { state.storage.sql.exec("UPDATE channel_message SET created_at='2026-01-01T00:00:00.000Z'"); });
  const created = await send(); expect(created.status).toBe(200);
  const v = await created.json() as { invitationId: string };
  expect((await call('/organizations/org_invites/channels', 'user_b')).status).toBe(403);
  const inbox = await (await call('/invitations', 'user_b')).json();
  expect(inbox).toMatchObject({ invitations: [{ invitationId: v.invitationId, role: 'member', state: 'pending', organizationName: 'Invitation workspace' }] });
  expect(JSON.stringify(inbox)).not.toMatch(/private-invitation-token|accept_invitation_url|secret/);
  expect(await (await call('/invitations', 'user_c')).json()).toMatchObject({ invitations: [] });
  expect((await call('/invitations/' + v.invitationId + '/accept', 'user_c', 'POST')).status).toBe(403);
  expect(controls.accepts).toBe(0);
  expect(await (await call('/invitations/' + v.invitationId + '/accept', 'user_b', 'POST')).json()).toMatchObject({ accepted: true, role: 'member', organizationId: 'org_invites' });
  expect(await (await call('/organizations', 'user_b')).json()).toMatchObject({ organizations: [{ organizationId: 'org_invites', role: 'member' }] });
  expect(await (await call('/organizations/org_invites/channels', 'user_b')).json()).toMatchObject({ channels: [{ name: 'general' }] });
  expect(await (await call(messages, 'user_b')).json()).toMatchObject({ messages: [] });
  expect((await call(messages, 'user_b', 'POST', { text: 'After joining' }, 'member-message-operation')).status).toBe(200);
  expect(await (await call(messages, 'user_b')).json()).toMatchObject({ messages: [{ authorId: 'user_b', text: 'After joining', sequence: 2 }] });
  expect((await call('/organizations/org_invites/channels', 'user_b', 'POST', { name: 'forbidden' })).status).toBe(403);
  expect((await call('/organizations/org_invites/invitations', 'user_b', 'POST', { email: 'user_c@example.test' })).status).toBe(403);
  expect((await call('/organizations/org_invites', 'user_b', 'PATCH', { description: 'forbidden', version: 1 })).status).toBe(403);
  expect(await env.INSTANCE_DB.prepare('SELECT count(*) AS n FROM instance_admin').first('n')).toBe(1);
});
it('lost send/accept responses reconcile across eviction without duplicate email or activation', async () => {
  const { send, call, controls } = await invitationFixture(); controls.loseSend = true;
  expect((await send()).status).toBe(503);
  await evictDurableObject(env.ORGS.getByName('org_invites'));
  const r = await send(); expect(r.status).toBe(200);
  const v = await r.json() as { invitationId: string };
  expect((await send()).status).toBe(200); expect(controls.sends).toBe(1);
  expect((await send('user_c@example.test')).status).toBe(409);
  controls.loseAccept = true;
  expect((await call('/invitations/' + v.invitationId + '/accept', 'user_b', 'POST')).status).toBe(503);
  expect((await call('/invitations/' + v.invitationId + '/accept', 'user_b', 'POST')).status).toBe(200);
  expect((await call('/invitations/' + v.invitationId + '/accept', 'user_b', 'POST')).status).toBe(200);
  expect(controls.accepts).toBe(1);
});
it('revoked/expired invitations and mismatched accepted identities never grant access', async () => {
  const { send, call, invites, controls } = await invitationFixture();
  await send();
  expect((await call('/organizations/org_invites/invitations/invitation_1/revoke', 'user_b', 'POST')).status).toBe(403);
  expect((await call('/organizations/org_invites/invitations/invitation_1/revoke', 'user_a', 'POST')).status).toBe(200);
  expect((await call('/invitations/invitation_1/accept', 'user_b', 'POST')).status).toBe(409);
  invites[0].state = 'pending'; invites[0].expires_at = '2000-01-01T00:00:00Z';
  expect((await call('/invitations/invitation_1/accept', 'user_b', 'POST')).status).toBe(409);
  invites[0].state = 'accepted'; invites[0].accepted_user_id = 'user_c';
  expect((await call('/invitations/invitation_1/accept', 'user_b', 'POST')).status).toBe(409);
  expect(controls.accepts).toBe(0);
});
it('invitation issuance enforces current owner and rejects forged roles or provider-only invitations', async () => {
  const { call, send, members, invites, controls } = await invitationFixture();
  expect((await call('/organizations/org_invites/invitations', 'user_a', 'POST', { email: 'user_b@example.test', role: 'owner' })).status).toBe(400);
  members[0].role.slug = 'member'; expect((await send()).status).toBe(403);
  members[0].role.slug = 'owner'; await send();
  invites.push({ ...invites[0], id: 'invitation_foreign' });
  expect((await call('/invitations/invitation_foreign/accept', 'user_b', 'POST')).status).toBe(403);
  expect(await (await call('/invitations', 'user_b')).json()).toMatchObject({ invitations: [{ invitationId: 'invitation_1' }] });
  controls.verified = false;
  expect((await call('/invitations/invitation_1/accept', 'user_b', 'POST')).status).toBe(403);
});
it('concurrent invitation retries send once; an unknown outcome with no provider match stays reconciliation-required', async () => {
  const { send, controls, invites } = await invitationFixture();
  const responses = await Promise.all([send(), send(), send()]);
  expect(responses.every(r => [200, 409].includes(r.status))).toBe(true);
  expect(controls.sends).toBe(1);
  expect((await send()).status).toBe(200);
  controls.loseSend = true;
  expect((await send('user_c@example.test', 'invitation-operation-0002')).status).toBe(503);
  invites.splice(1, 1); // simulate a request whose remote outcome cannot be found
  expect((await send('user_c@example.test', 'invitation-operation-0002')).status).toBe(409);
  expect(controls.sends).toBe(2);
});
it('first active membership observation persists a conservative history floor and a new membership resets it', async () => {
  const { members } = await invitationFixture();
  const org = env.ORGS.getByName('org_invites');
  const before = Date.now();
  const first = await org.memberHistory('org_invites', members[0]);
  expect(Date.parse(first)).toBeGreaterThanOrEqual(before);
  await evictDurableObject(org);
  expect(await org.memberHistory('org_invites', members[0])).toBe(first);
  await runInDurableObject(org, (_instance, state) => { state.storage.sql.exec("UPDATE member_access_projection SET history_from='2000-01-01T00:00:00.000Z'"); });
  expect(await org.memberHistory('org_invites', members[0])).toBe('2000-01-01T00:00:00.000Z');
  expect(Date.parse(await org.memberHistory('org_invites', { ...members[0], id: 'om_rejoined' }))).toBeGreaterThanOrEqual(before);
});

async function guestFixture() {
  const fixture = await invitationFixture();
  const ownerBase = '/organizations/org_invites/channels';
  const create = async (name: string, key: string) => (await fixture.call(ownerBase, 'user_a', 'POST', { name }, key)).json() as Promise<{ channelId: string }>;
  const channel = await create('shared-with-guest', 'guest-channel-create-0001');
  const sibling = await create('organization-only', 'guest-channel-create-0002');
  const base = ownerBase + '/' + channel.channelId;
  const guest = async (path: string, user = 'user_b', method = 'GET', data?: unknown, key = 'guest-operation-0001') => request('/api' + path, { method, headers: { Authorization: 'Bearer ' + await token({ sub: user }), 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const issue = (email = 'user_b@example.test', key = 'guest-invitation-0001') => fixture.call(base + '/guest-invitations', 'user_a', 'POST', { email }, key);
  const accept = (id: string, user = 'user_b') => guest('/channel-invitations/' + id + '/accept', user, 'POST');
  return { ...fixture, channel, sibling, base, guest, issue, accept };
}
it('a channel guest joins without organization membership and can only read/write that channel from its join sequence', async () => {
  const f = await guestFixture();
  expect((await f.call(f.base + '/messages', 'user_a', 'POST', { text: 'Before guest' }, 'owner-before-guest')).status).toBe(200);
  const invitation = await (await f.issue()).json() as { invitationId: string };
  expect(await (await f.guest('/channel-invitations')).json()).toMatchObject({ invitations: [{ invitationId: invitation.invitationId, role: 'guest' }] });
  expect(await (await f.guest('/channel-invitations', 'user_c')).json()).toMatchObject({ invitations: [] });
  expect((await f.accept(invitation.invitationId, 'user_c')).status).toBe(403);
  expect((await f.accept(invitation.invitationId)).status).toBe(200);
  expect(f.members.map(m => m.user_id)).toEqual(['user_a']);
  expect(f.controls.sends).toBe(0); expect(f.controls.accepts).toBe(0);
  expect(await (await f.guest('/organizations')).json()).toMatchObject({ organizations: [] });
  for (const path of ['/organizations/org_invites/access', '/organizations/org_invites', '/organizations/org_invites/channels', '/guest-channels/' + f.sibling.channelId, '/guest-channels/' + f.sibling.channelId + '/messages']) expect((await f.guest(path)).status).toBe(403);
  const list = await (await f.guest('/guest-channels')).json();
  expect(list).toMatchObject({ channels: [{ channelId: f.channel.channelId, organizationName: 'Invitation workspace', access: 'guest', historyAfter: 1 }], nextCursor: null });
  expect(await (await f.guest('/guest-channels?organizationId=org_invites')).json()).toMatchObject({ channels: [{ channelId: f.channel.channelId, organizationName: 'Invitation workspace' }] });
  expect(await (await f.guest('/guest-channels?organizationId=org_other')).json()).toMatchObject({ channels: [] });
  expect(await (await f.guest('/guest-channels?organizationId=org_invites', 'user_c')).json()).toMatchObject({ channels: [] });
  expect((await f.guest('/guest-channels?organizationId=invalid')).status).toBe(400);
  const path = '/guest-channels/' + f.channel.channelId + '/messages';
  expect(await (await f.guest(path)).json()).toMatchObject({ messages: [], nextCursor: 1 });
  expect((await f.guest(path, 'user_b', 'POST', { text: 'Guest text', authorId: 'user_a' })).status).toBe(400);
  const send = () => f.guest(path, 'user_b', 'POST', { text: 'Guest text' });
  expect(await (await send()).json()).toMatchObject({ message: { sequence: 2, authorId: 'user_b' }, replayed: false });
  expect(await (await send()).json()).toMatchObject({ message: { sequence: 2 }, replayed: true });
  expect(await (await f.guest(path)).json()).toMatchObject({ messages: [{ sequence: 2, text: 'Guest text' }] });
  expect(await (await f.call(f.base + '/messages')).json()).toMatchObject({ messages: [{ sequence: 1 }, { sequence: 2, authorId: 'user_b' }] });
  expect((await f.guest(path + '?after=999')).status).toBe(400);
  expect((await f.call(f.base + '/guest-invitations', 'user_b')).status).toBe(403);
});
it('guest invite and acceptance recover after indexing failure and eviction without changing the join floor', async () => {
  const f = await guestFixture();
  await env.INSTANCE_DB.exec("CREATE TRIGGER fail_guest_index BEFORE INSERT ON channel_invitation_directory BEGIN SELECT RAISE(ABORT,'INDEX_UNAVAILABLE'); END");
  expect((await f.issue()).status).toBe(503);
  const stub = env.CHANNELS.getByName(f.channel.channelId);
  await evictDurableObject(stub);
  await env.INSTANCE_DB.exec('DROP TRIGGER fail_guest_index');
  const v = await (await f.issue()).json() as { invitationId: string };
  expect(await (await f.issue()).json()).toMatchObject({ invitationId: v.invitationId });
  expect((await f.issue('user_c@example.test')).status).toBe(409);
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM channel_invitation').one().n)).toBe(1);
  await env.INSTANCE_DB.exec("CREATE TRIGGER fail_guest_accept_index BEFORE UPDATE ON channel_invitation_directory BEGIN SELECT RAISE(ABORT,'INDEX_UNAVAILABLE'); END");
  expect((await f.accept(v.invitationId)).status).toBe(503);
  await f.call(f.base + '/messages', 'user_a', 'POST', { text: 'After first acceptance' }, 'after-first-acceptance');
  await evictDurableObject(stub);
  await env.INSTANCE_DB.exec('DROP TRIGGER fail_guest_accept_index');
  expect((await f.accept(v.invitationId)).status).toBe(200);
  expect(await (await f.guest('/guest-channels')).json()).toMatchObject({ channels: [{ historyAfter: 0 }] });
  expect(await (await f.guest('/guest-channels/' + f.channel.channelId + '/messages')).json()).toMatchObject({ messages: [{ text: 'After first acceptance' }] });
});
it('guest revocation immediately denies old sessions and rejoin cannot replay old history or old messages', async () => {
  const f = await guestFixture();
  const v = await (await f.issue()).json() as { invitationId: string };
  await f.accept(v.invitationId);
  const path = '/guest-channels/' + f.channel.channelId + '/messages';
  await f.guest(path, 'user_b', 'POST', { text: 'Old guest message' });
  const revoke = () => f.call(f.base + '/guest-invitations/' + v.invitationId + '/revoke', 'user_a', 'POST');
  expect((await revoke()).status).toBe(200);
  expect((await f.guest(path)).status).toBe(403);
  expect((await f.guest(path, 'user_b', 'POST', { text: 'Old guest message' })).status).toBe(403);
  expect((await f.accept(v.invitationId)).status).toBe(409);
  expect(await (await f.guest('/guest-channels')).json()).toMatchObject({ channels: [] });
  await f.call(f.base + '/messages', 'user_a', 'POST', { text: 'During absence' }, 'owner-during-absence');
  const next = await (await f.issue('user_b@example.test', 'guest-invitation-0002')).json() as { invitationId: string };
  expect((await f.accept(next.invitationId)).status).toBe(200);
  expect((await revoke()).status).toBe(200);
  expect(await (await f.guest('/guest-channels')).json()).toMatchObject({ channels: [{ invitationId: next.invitationId, historyAfter: 2 }] });
  expect(await (await f.guest(path)).json()).toMatchObject({ messages: [], nextCursor: 2 });
  expect((await f.guest(path, 'user_b', 'POST', { text: 'Old guest message' })).status).toBe(409);
  expect((await f.guest(path, 'user_b', 'POST', { text: 'New guest message' }, 'guest-new-generation')).status).toBe(200);
});
it('guest invitations reject expired/unverified recipients, forged roles, current member owners and index-only authority', async () => {
  const f = await guestFixture();
  expect((await f.call(f.base + '/guest-invitations', 'user_a', 'POST', { email: 'user_b@example.test', role: 'owner' })).status).toBe(400);
  f.members[0].role.slug = 'member'; expect((await f.issue()).status).toBe(403); f.members[0].role.slug = 'owner';
  const v = await (await f.issue()).json() as { invitationId: string };
  f.controls.verified = false; expect((await f.accept(v.invitationId)).status).toBe(403); f.controls.verified = true;
  await env.INSTANCE_DB.prepare("UPDATE channel_invitation_directory SET recipient_email='user_c@example.test', accepted_user_id='user_c'").run();
  expect((await f.accept(v.invitationId, 'user_c')).status).toBe(403);
  expect(await (await f.guest('/guest-channels', 'user_c')).json()).toMatchObject({ channels: [] });
  const stub = env.CHANNELS.getByName(f.channel.channelId);
  await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE channel_invitation SET expires_at='2000-01-01T00:00:00Z'"); });
  expect((await f.accept(v.invitationId)).status).toBe(409);
  expect((await f.guest('/guest-channels/' + f.channel.channelId)).status).toBe(403);
});
it('guest grant accepts once under concurrency, survives eviction, and rejects disabled organizations', async () => {
  const f = await guestFixture();
  const issued = await Promise.all([f.issue(), f.issue(), f.issue()]);
  const ids = await Promise.all(issued.map(r => r.json() as Promise<{ invitationId: string }>));
  expect(new Set(ids.map(v => v.invitationId)).size).toBe(1);
  const accepted = await Promise.all(ids.map(v => f.accept(v.invitationId)));
  expect(accepted.map(r => r.status)).toEqual([200, 200, 200]);
  await evictDurableObject(env.CHANNELS.getByName(f.channel.channelId));
  expect((await f.guest('/guest-channels/' + f.channel.channelId)).status).toBe(200);
  const next = await (await f.issue('user_b@example.test', 'guest-invitation-0002')).json() as { invitationId: string };
  expect((await f.accept(next.invitationId)).status).toBe(409);
  await env.INSTANCE_DB.prepare("UPDATE organization_link SET lifecycle='disabled' WHERE org_id='org_invites'").run();
  expect(await (await f.guest('/guest-channels')).json()).toMatchObject({ channels: [] });
  expect((await f.guest('/guest-channels/' + f.channel.channelId + '/messages')).status).toBe(403);
});

async function agentFixture() {
  const f = await guestFixture();
  const secret = 'b'.repeat(64);
  const secretHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))), b => b.toString(16).padStart(2, '0')).join('');
  const issue = (name = 'Independent agent', key = 'agent-issue-operation-0001', hash = secretHash) => f.call(f.base + '/agents', 'user_a', 'POST', { name, secretHash: hash }, key);
  const call = (actorId: string, method = 'GET', data?: unknown, channelId = f.channel.channelId, credential = secret, key = 'agent-message-operation-0001') => request('/api/agent-channels/' + channelId + '/messages', { method, headers: { Authorization: 'Bearer tob_agent_' + actorId + '.' + credential, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { ...f, secret, secretHash, issueAgent: issue, agentCall: call };
}
it('channel Agent has independent identity, post-join history and no organization or cross-channel authority', async () => {
  const f = await agentFixture();
  await f.call(f.base + '/messages', 'user_a', 'POST', { text: 'Before agent joined' }, 'before-agent-message');
  const r = await f.issueAgent(); expect(r.status).toBe(200);
  const a = await r.json() as { actorId: string };
  expect(JSON.stringify(a)).not.toContain(f.secretHash); expect(JSON.stringify(a)).not.toContain(f.secret);
  expect(a).toMatchObject({ kind: 'agent', historyAfter: 1, scopes: ['messages:read', 'messages:send'], state: 'active' });
  expect(await (await f.agentCall(a.actorId)).json()).toMatchObject({ messages: [], nextCursor: 1 });
  expect((await f.agentCall(a.actorId, 'GET', undefined, f.sibling.channelId)).status).toBe(403);
  expect((await f.agentCall(a.actorId, 'GET', undefined, f.channel.channelId, 'c'.repeat(64))).status).toBe(403);
  expect((await f.agentCall(a.actorId, 'POST', { text: 'forged', authorId: 'user_a' })).status).toBe(400);
  const send = () => f.agentCall(a.actorId, 'POST', { text: 'Agent reply' });
  expect(await (await send()).json()).toMatchObject({ replayed: false, message: { authorId: a.actorId, authorType: 'agent', sequence: 2 } });
  expect(await (await send()).json()).toMatchObject({ replayed: true, message: { sequence: 2 } });
  expect((await f.agentCall(a.actorId, 'POST', { text: 'conflict' })).status).toBe(409);
  expect(await (await f.call(f.base + '/messages')).json()).toMatchObject({ messages: [{ text: 'Before agent joined' }, { authorType: 'agent', text: 'Agent reply' }] });
  expect((await request('/api/organizations', { headers: { Authorization: 'Bearer tob_agent_' + a.actorId + '.' + f.secret } })).status).toBe(401);
  expect(f.members).toHaveLength(1);
});
it('Agent issuance recovers after eviction, same-name identities differ, no secret in listings and revoked keys stay revoked', async () => {
  const f = await agentFixture();
  const a = await (await f.issueAgent()).json() as { actorId: string };
  await evictDurableObject(env.CHANNELS.getByName(f.channel.channelId));
  expect(await (await f.issueAgent()).json()).toEqual(a);
  expect((await f.issueAgent('Changed')).status).toBe(409);
  expect((await f.issueAgent('Independent agent', 'agent-issue-operation-0001', 'a'.repeat(64))).status).toBe(409);
  const b = await (await f.issueAgent('Independent agent', 'agent-issue-operation-0002')).json() as { actorId: string };
  expect(a.actorId).not.toBe(b.actorId);
  const list = await (await f.call(f.base + '/agents')).json();
  expect(list).toMatchObject({ agents: expect.arrayContaining([{ ...a }, { ...b }]) });
  expect(JSON.stringify(list)).not.toContain('secretHash');
  await f.call(f.base + '/agents/' + a.actorId + '/revoke', 'user_a', 'POST');
  expect((await f.agentCall(a.actorId)).status).toBe(403);
  expect((await f.agentCall(a.actorId, 'POST', { text: 'blocked' })).status).toBe(403);
  expect(await (await f.issueAgent()).json()).toMatchObject({ state: 'revoked' });
  expect((await f.agentCall(b.actorId)).status).toBe(200);
});
it('current issuer qualification, instance admission and credential expiry gate Agent access', async () => {
  const f = await agentFixture();
  const a = await (await f.issueAgent()).json() as { actorId: string };
  f.members[0].role.slug = 'member';
  expect((await f.issueAgent('Another', 'agent-issue-operation-0003')).status).toBe(403);
  expect((await f.call(f.base + '/agents/' + a.actorId + '/revoke', 'user_a', 'POST')).status).toBe(403);
  expect((await f.agentCall(a.actorId)).status).toBe(403);
  f.members[0].role.slug = 'owner'; f.members[0].id = 'om_rejoined';
  expect((await f.agentCall(a.actorId)).status).toBe(403);
  f.members[0].id = 'om_owner'; f.controls.verified = false;
  expect((await f.agentCall(a.actorId)).status).toBe(403);
  f.controls.verified = true;
  await env.INSTANCE_DB.prepare("UPDATE instance_config SET registration_mode='admin_only'").run();
  expect((await f.agentCall(a.actorId)).status).toBe(403);
  await enableUsers();
  await runInDurableObject(env.CHANNELS.getByName(f.channel.channelId), (_instance, state) => { state.storage.sql.exec("UPDATE channel_agent SET expires_at='2000-01-01T00:00:00Z'"); });
  expect((await f.agentCall(a.actorId)).status).toBe(403);
});
it('credential revoked while issuer verification yields cannot commit a later Agent send', async () => {
  const f = await agentFixture();
  const a = await (await f.issueAgent()).json() as { actorId: string };
  const provider = vi.mocked(globalThis.fetch).getMockImplementation()!;
  let revoked = false;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    if (String(input).includes('/organization_memberships?') && !revoked) {
      revoked = true;
      await env.CHANNELS.getByName(f.channel.channelId).revokeAgent(f.channel.channelId, { id:'user_a',type:'human',organizationId:'org_invites',historyFrom:'1970-01-01T00:00:00.000Z' }, a.actorId);
    }
    return provider(input, init);
  });
  expect((await f.agentCall(a.actorId, 'POST', { text:'Must never commit' })).status).toBe(403);
  expect(await (await f.call(f.base + '/messages')).json()).toMatchObject({messages:[]});
});

async function workFixture() {
  const f=await agentFixture();
  const a=await (await f.issueAgent()).json() as {actorId:string};
  const expiresAt=new Date(Date.now()+300000).toISOString();
  const input={targetActorId:a.actorId,capability:'health-check',expiresAt};
  const create=(data:unknown=input,key='work-request-operation-0001',user='user_a')=>f.call(f.base+'/work-requests',user,'POST',data,key);
  const agent=(id:string,action='authorize',body?:unknown,actorId=a.actorId)=>request('/api/agent-channels/'+f.channel.channelId+'/work-requests/'+id+'/'+action,{method:'POST',headers:{Authorization:'Bearer tob_agent_'+actorId+'.'+f.secret,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {...f,a,input,create,workAgent:agent};
}
it('structured work requests and results commit once with authenticated authors and survive eviction',async()=>{
 const f=await workFixture();const r=await f.create();expect(r.status).toBe(200);
 const v=await r.json() as {message:{payload:{requestId:string}}};const id=v.message.payload.requestId;
 expect(v).toMatchObject({replayed:false,message:{kind:'work_request',authorType:'human',authorId:'user_a',payload:{requesterUserId:'user_a',targetActorId:f.a.actorId,capability:'health-check'}}});
 await evictDurableObject(env.CHANNELS.getByName(f.channel.channelId));
 expect(await (await f.create()).json()).toMatchObject({replayed:true,message:{sequence:1}});
 expect((await f.create({...f.input,expiresAt:new Date(Date.now()+200000).toISOString()})).status).toBe(409);
 expect(await (await f.workAgent(id)).json()).toMatchObject({request:{requestId:id,requesterUserId:'user_a'}});
 const result={version:1,requestId:id,state:'completed',environment:'reference-a',executionCount:1,reason:'OK',diagnostics:{platform:'linux',architecture:'x64',runtime:'v24.21.0'}};
 expect(await (await f.workAgent(id,'result',result)).json()).toMatchObject({replayed:false,message:{sequence:2,kind:'work_result',authorId:f.a.actorId}});
 expect(await (await f.workAgent(id,'result',result)).json()).toMatchObject({replayed:true,message:{sequence:2}});
 expect((await f.workAgent(id,'result',{...result,environment:'changed'})).status).toBe(409);
 expect(await (await f.call(f.base+'/messages')).json()).toMatchObject({messages:[{kind:'work_request'},{kind:'work_result'}]});
});
it('work rejects forged source, unbounded execution input, wrong target and expired authorization',async()=>{
 const f=await workFixture();
 for(const extra of [{requesterUserId:'user_b'},{shell:'echo hi'},{capability:'shell'},{expiresAt:new Date(Date.now()+700000).toISOString()}])expect((await f.create({...f.input,...extra})).status).toBe(400);
 const v=await (await f.create()).json() as {message:{payload:{requestId:string}}};const id=v.message.payload.requestId;
 const other=await (await f.issueAgent('other','another-agent-key-0001')).json() as {actorId:string};
 expect((await f.workAgent(id,'authorize',undefined,other.actorId)).status).toBe(403);
 expect((await f.workAgent('wr_'+'a'.repeat(64))).status).toBe(403);
 await runInDurableObject(env.CHANNELS.getByName(f.channel.channelId),(_i,s)=>{s.storage.sql.exec("UPDATE channel_message SET payload=json_set(payload,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE kind='work_request'");});
 expect(await (await f.workAgent(id)).json()).toEqual({error:{code:'REQUEST_EXPIRED'}});
});
it('member requests do not inherit owner authority and membership removal or rejoin invalidates work',async()=>{
 const f=await workFixture();
 f.members.push({id:'om_member',user_id:'user_b',organization_id:'org_invites',status:'active',role:{slug:'member'},created_at:'2026-01-01T00:00:00Z'});
 const r=await f.create(f.input,'member-work-operation-0001','user_b');expect(r.status).toBe(200);
 const v=await r.json() as {message:{payload:{requestId:string}}};const id=v.message.payload.requestId;
 expect((await f.workAgent(id)).status).toBe(200);
 f.members[1].status='inactive';expect(await (await f.workAgent(id)).json()).toEqual({error:{code:'REQUESTER_ACCESS_DENIED'}});
 f.members[1].status='active';f.members[1].id='om_rejoined';expect((await f.workAgent(id)).status).toBe(403);
});
it('revocation during work authorization yields no new start approval or result',async()=>{
 const f=await workFixture();const v=await(await f.create()).json() as {message:{payload:{requestId:string}}};const id=v.message.payload.requestId;
 const provider=vi.mocked(globalThis.fetch).getMockImplementation()!;let checks=0;
 vi.mocked(globalThis.fetch).mockImplementation(async(input,init)=>{
  if(String(input).includes('/organization_memberships?')&&++checks===2) await env.CHANNELS.getByName(f.channel.channelId).revokeAgent(f.channel.channelId,{id:'user_a',type:'human',organizationId:'org_invites',historyFrom:'1970-01-01T00:00:00.000Z'},f.a.actorId);
  return provider(input,init);
 });
 expect((await f.workAgent(id)).status).toBe(403);
 expect((await f.workAgent(id,'result',{version:1,requestId:id,state:'rejected',environment:'reference',executionCount:0,reason:'LOCAL_POLICY_DENIED'})).status).toBe(403);
});

async function forwardingFixture() {
  const f = await workFixture();
  f.members.push({id:'om_member',user_id:'user_b',organization_id:'org_invites',status:'active',role:{slug:'member'},created_at:'2026-01-01T00:00:00Z'});
  const b = await (await f.issueAgent('Target B','forward-target-agent-0001')).json() as {actorId:string};
  const c = await (await f.issueAgent('Target C','forward-target-agent-0002')).json() as {actorId:string};
  const root = await (await f.create(f.input,'forward-root-operation-0001','user_b')).json() as {message:{payload:import('../packages/contracts/work').WorkRequest}};
  const rootId = root.message.payload.requestId;
  const forward = (targetActorId=b.actorId, id=rootId, actorId=f.a.actorId, extra={})=> f.workAgent(id,'forward',{targetActorId,...extra},actorId);
  return {...f,b,c,rootId,root:root.message.payload,forward};
}
it('forwarding preserves the original member and deadline, survives eviction and commits one correlated child',async()=>{
 const f=await forwardingFixture();
 const response=await f.forward();expect(response.status).toBe(200);
 const value=await response.json() as {message:{payload:import('../packages/contracts/work').WorkRequest}};
 const child=value.message.payload;
 expect(value).toMatchObject({replayed:false,message:{sequence:2,authorType:'agent',authorId:f.a.actorId,kind:'work_request'}});
 expect(child).toEqual({...f.root,requestId:child.requestId,targetActorId:f.b.actorId,delegation:{parentRequestId:f.rootId,actorId:f.a.actorId,hops:1}});
 expect(child.requestId).not.toBe(f.rootId);
 await evictDurableObject(env.CHANNELS.getByName(f.channel.channelId));
 expect(await(await f.forward()).json()).toMatchObject({replayed:true,message:{sequence:2,payload:child}});
 expect((await f.forward(f.c.actorId)).status).toBe(409);
 expect(await(await f.workAgent(f.rootId)).json()).toEqual({error:{code:'WORK_ALREADY_FORWARDED'}});
 expect(await(await f.workAgent(child.requestId,'authorize',undefined,f.b.actorId)).json()).toEqual({request:child});
 expect(await(await f.forward(f.c.actorId,child.requestId,f.b.actorId)).json()).toEqual({error:{code:'FORWARD_LIMIT'}});
 const result={version:1,requestId:child.requestId,state:'completed',environment:'target-b',executionCount:1,reason:'OK',diagnostics:{platform:'linux',architecture:'x64',runtime:'v24.21.0'}};
 expect(await(await f.workAgent(child.requestId,'result',result,f.b.actorId)).json()).toMatchObject({message:{sequence:3,authorId:f.b.actorId,payload:result}});
 expect((await f.workAgent(f.rootId,'result',{...result,requestId:f.rootId})).status).toBe(403);
 expect(await(await f.workAgent(child.requestId,'result',result,f.b.actorId)).json()).toMatchObject({replayed:true,message:{sequence:3}});
});
it('forwarding refuses fabricated source or deadlines, self loops and non-target Agents',async()=>{
 const f=await forwardingFixture();
 for(const extra of [{requesterUserId:'user_admin'},{expiresAt:new Date(Date.now()+600000).toISOString()},{capability:'shell'},{delegation:{hops:0}}])expect((await f.forward(f.b.actorId,f.rootId,f.a.actorId,extra)).status).toBe(400);
 expect((await f.forward(f.b.actorId,f.rootId,f.c.actorId)).status).toBe(403);
 expect(await(await f.forward(f.a.actorId)).json()).toEqual({error:{code:'FORWARD_LIMIT'}});
 expect((await f.forward('ag_'+'f'.repeat(64))).status).toBe(403);
 expect(await(await f.call(f.base+'/messages')).json()).toMatchObject({messages:[{sequence:1}]});
});
it('execution authorization wins against forwarding, while forwarding wins against execution authorization',async()=>{
 const f=await forwardingFixture();
 const [authorization,forward]=await Promise.all([f.workAgent(f.rootId),f.forward()]);
 expect([authorization.status,forward.status].sort()).toEqual([200,403]);
 await evictDurableObject(env.CHANNELS.getByName(f.channel.channelId));
 if(authorization.status===200)expect(await(await f.forward()).json()).toEqual({error:{code:'WORK_ALREADY_STARTED'}});
 else expect(await(await f.workAgent(f.rootId)).json()).toEqual({error:{code:'WORK_ALREADY_FORWARDED'}});
});
it('an Agent rejection is terminal for forwarding even without an execution authorization',async()=>{
 const f=await forwardingFixture();
 expect((await f.workAgent(f.rootId,'result',{version:1,requestId:f.rootId,state:'rejected',environment:'a',executionCount:0,reason:'LOCAL_POLICY_DENIED'})).status).toBe(200);
 expect(await(await f.forward()).json()).toEqual({error:{code:'WORK_ALREADY_STARTED'}});
});
it('the original membership stays authoritative after forwarding and cannot be replaced by a rejoin',async()=>{
 const f=await forwardingFixture();
 const v=await(await f.forward()).json() as {message:{payload:{requestId:string}}};
 f.members[1].status='inactive';
 expect(await(await f.workAgent(v.message.payload.requestId,'authorize',undefined,f.b.actorId)).json()).toEqual({error:{code:'REQUESTER_ACCESS_DENIED'}});
 f.members[1].status='active';f.members[1].id='om_new';
 expect((await f.workAgent(v.message.payload.requestId,'authorize',undefined,f.b.actorId)).status).toBe(403);
});
it('revoking the forwarding Agent while the target checks identity prevents execution authorization',async()=>{
 const f=await forwardingFixture();
 const v=await(await f.forward()).json() as {message:{payload:{requestId:string}}};
 const provider=vi.mocked(globalThis.fetch).getMockImplementation()!;let checks=0;
 vi.mocked(globalThis.fetch).mockImplementation(async(input,init)=>{
  if(String(input).includes('/organization_memberships?')&&++checks===2) await env.CHANNELS.getByName(f.channel.channelId).revokeAgent(f.channel.channelId,{id:'user_a',type:'human',organizationId:'org_invites',historyFrom:'1970-01-01T00:00:00.000Z'},f.a.actorId);
  return provider(input,init);
 });
 expect((await f.workAgent(v.message.payload.requestId,'authorize',undefined,f.b.actorId)).status).toBe(403);
});
it('expiration during forwarding identity checks commits no child',async()=>{
 const f=await forwardingFixture();const provider=vi.mocked(globalThis.fetch).getMockImplementation()!;let checks=0;
 vi.mocked(globalThis.fetch).mockImplementation(async(input,init)=>{
  if(String(input).includes('/organization_memberships?')&&++checks===2)await runInDurableObject(env.CHANNELS.getByName(f.channel.channelId),(_i,s)=>{s.storage.sql.exec("UPDATE channel_message SET payload=json_set(payload,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE kind='work_request'");});
  return provider(input,init);
 });
 expect(await(await f.forward()).json()).toEqual({error:{code:'REQUEST_EXPIRED'}});
 expect(await(await f.call(f.base+'/messages')).json()).toMatchObject({messages:[{sequence:1}]});
});
it('a finished result cannot obtain a later execution authorization',async()=>{
 const f=await workFixture();const v=await(await f.create()).json() as {message:{payload:{requestId:string}}};const id=v.message.payload.requestId;
 expect((await f.workAgent(id,'result',{version:1,requestId:id,state:'rejected',environment:'a',executionCount:0,reason:'LOCAL_POLICY_DENIED'})).status).toBe(200);
 expect(await(await f.workAgent(id)).json()).toEqual({error:{code:'WORK_ALREADY_FINISHED'}});
});
it('competing target selections produce only one child and a failed child write leaves no message',async()=>{
 const f=await forwardingFixture();
 await runInDurableObject(env.CHANNELS.getByName(f.channel.channelId),(_i,s)=>{s.storage.sql.exec("CREATE TRIGGER fail_forward BEFORE INSERT ON channel_work WHEN NEW.parent_request_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'INJECTED_FORWARD_FAILURE'); END");});
 expect((await f.forward()).status).toBe(503);
 expect(await(await f.call(f.base+'/messages')).json()).toMatchObject({messages:[{sequence:1}]});
 await runInDurableObject(env.CHANNELS.getByName(f.channel.channelId),(_i,s)=>{s.storage.sql.exec('DROP TRIGGER fail_forward');});
 const responses=await Promise.all([f.forward(f.b.actorId),f.forward(f.c.actorId)]);
 expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
 const page=await(await f.call(f.base+'/messages')).json() as {messages:unknown[]};expect(page.messages).toHaveLength(2);
});
it('a target owned by another active owner cannot borrow a revoked forwarding owner membership',async()=>{
 const f=await forwardingFixture();
 f.members.push({id:'om_other_owner',user_id:'user_c',organization_id:'org_invites',status:'active',role:{slug:'owner'},created_at:'2026-01-01T00:00:00Z'});
 const other=await(await f.call(f.base+'/agents','user_c','POST',{name:'C owner target',secretHash:f.secretHash},'other-owner-agent-0001')).json() as {actorId:string};
 const v=await(await f.forward(other.actorId)).json() as {message:{payload:{requestId:string}}};
 f.members[0].role.slug='member';
 expect(await(await f.workAgent(v.message.payload.requestId,'authorize',undefined,other.actorId)).json()).toEqual({error:{code:'REQUESTER_ACCESS_DENIED'}});
});

it('Agent identity discovery reports canonical channel and actor without exposing credentials or accepting another channel',async()=>{
 const f=await agentFixture();const a=await(await f.issueAgent()).json() as {actorId:string};
 const call=(channel=f.channel.channelId)=>request('/api/agent-channels/'+channel+'/identity',{headers:{Authorization:'Bearer tob_agent_'+a.actorId+'.'+f.secret}});
 const response=await call();expect(response.status).toBe(200);
 const identity=await response.json();expect(identity).toMatchObject({channelId:f.channel.channelId,organizationId:'org_invites',agent:{actorId:a.actorId,ownerUserId:'user_a',state:'active',kind:'agent'}});
 expect(JSON.stringify(identity)).not.toContain(f.secret);expect(JSON.stringify(identity)).not.toContain(f.secretHash);
 expect((await call(f.sibling.channelId)).status).toBe(403);
 await f.call(f.base+'/agents/'+a.actorId+'/revoke','user_a','POST');
 expect((await call()).status).toBe(403);
});

it('invitation preview discloses the destination only to its verified recipient and never joins', async () => {
  const f = await guestFixture();
  const v = await (await f.issue()).json() as { invitationId: string };
  const path = '/channel-invitations/' + v.invitationId;
  expect((await request('/api' + path)).status).toBe(401);
  expect((await f.guest(path, 'user_c')).status).toBe(403);
  expect(await (await f.guest(path)).json()).toMatchObject({ invitationId: v.invitationId, channelId: f.channel.channelId, organizationName: expect.any(String), state: 'pending', role: 'guest' });
  expect((await f.guest('/guest-channels/' + f.channel.channelId)).status).toBe(403);
  expect(f.members.map(m => m.user_id)).toEqual(['user_a']);
  await f.call(f.base + '/guest-invitations/' + v.invitationId + '/revoke', 'user_a', 'POST');
  expect(await (await f.guest(path)).json()).toMatchObject({ state: 'revoked' });
  expect((await f.accept(v.invitationId)).status).toBe(409);
  expect((await f.guest('/guest-channels/' + f.sibling.channelId)).status).toBe(403);
});
it('invitation landing is metadata-free, escaped, and rejects malformed locators', async () => {
  const response = await request('/join?invitation=ci_' + 'a'.repeat(64));
  expect(response.status).toBe(200);
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  const page = await response.text();
  expect(page).toContain('ai.botharness.deepseekbot.dev:/cloud-join?link=');
  expect(page).not.toContain('organizationId');
  for (const query of ['invitation=<script>', 'invitation=invitation_test&invitation=invitation_other', 'invitation=invitation_test&redirect=https://other.example'])
    expect((await request('/join?' + query)).status).toBe(400);
});
