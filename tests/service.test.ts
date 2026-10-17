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
  expect(await live.json()).toMatchObject({ service: "tob", environment: "local", releaseSha: "local", businessEnabled: false });
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
  expect(await ready.json()).toMatchObject({ ready: true, d1SchemaVersion: 2, orgSchemaVersion: 1, businessEnabled: false });
  expect(await env.INSTANCE_DB.prepare("SELECT config_version FROM instance_config").first("config_version")).toBe(7);
  await expect(env.INSTANCE_DB.prepare("INSERT INTO instance_config VALUES (2,'admin_only','admin_only',1)").run()).rejects.toThrow();
});

it("exposes no public bootstrap or business writes, even with spoofed identity", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS);
  for (const path of ["/api/organizations", "/api/admin/initialize"]) {
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
    state.storage.sql.exec("INSERT INTO org_config VALUES ('org_fixture','active','{}',1)");
  });
  await evictDurableObject(first);
  expect(await first.schemaStatus()).toEqual({ schemaVersion: 1 });
  expect(await runInDurableObject(first, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM org_config").one().n)).toBe(1);
  expect(await runInDurableObject(first, (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations").one().n)).toBe(1);
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
    expect(init?.redirect).toBe("error");
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
  vi.spyOn(globalThis, "fetch").mockImplementation(async url => String(url).includes("/jwks/") ? Response.json({ keys: [publicKey] }) : new Response(null, { status: 503 }));
  const r = await request("/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + await token() } });
  expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: { code: "LOGOUT_UNCONFIRMED" } });
});
