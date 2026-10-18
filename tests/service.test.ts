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
  expect(await ready.json()).toMatchObject({ ready: true, d1SchemaVersion: 3, orgSchemaVersion: 2, businessEnabled: true });
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
  expect(await first.schemaStatus()).toEqual({ schemaVersion: 2 });
  expect(await runInDurableObject(first, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM org_config").one().n)).toBe(1);
  expect(await runInDurableObject(first, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations").one().n)).toBe(2);
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

function organizationProvider(options: { loseCreate?: boolean; loseMembership?: boolean; missingRole?: boolean } = {}) {
  let org: { id: string; name: string; external_id: string } | undefined;
  let member: { id: string; user_id: string; organization_id: string; status: string; role: { slug: string }; roles?: { slug: string }[] } | undefined;
  const calls = { creates: 0, members: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/jwks/")) return Response.json({ keys: [publicKey] });
    expect(new Request(String(input), init).redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer local-test-secret");
    const data = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname === "/authorization/roles") return Response.json({ data: [{ slug: "member" }, ...options.missingRole ? [] : [{ slug: "owner" }]] });
    if (url.pathname.startsWith("/organizations/external_id/")) return org ? Response.json(org) : new Response(null, { status: 404 });
    if (url.pathname === "/organizations") { calls.creates++; org = { id: "org_test", name: data.name, external_id: data.external_id }; if (options.loseCreate) { options.loseCreate = false; throw new TypeError("lost response"); } return Response.json(org); }
    if (url.pathname === "/user_management/organization_memberships") {
      if (init?.method === "POST") {
        calls.members++; member = { id: "om_test", user_id: data.user_id, organization_id: data.organization_id, status: "active", role: { slug: data.role_slug } };
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
