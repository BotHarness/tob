import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { beforeEach, expect, it } from "vitest";

declare global { namespace Cloudflare { interface Env { TEST_MIGRATIONS: D1Migration[] } } }
const request = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://example.test${path}`, init));
beforeEach(async () => { await reset(); });

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
  expect(await ready.json()).toMatchObject({ ready: true, d1SchemaVersion: 1, orgSchemaVersion: 1, businessEnabled: false });
  expect(await env.INSTANCE_DB.prepare("SELECT config_version FROM instance_config").first("config_version")).toBe(7);
  await expect(env.INSTANCE_DB.prepare("INSERT INTO instance_config VALUES (2,'admin_only','admin_only',1)").run()).rejects.toThrow();
});

it("refuses uninitialized business and never trusts tokens or supplied owner identity", async () => {
  await applyD1Migrations(env.INSTANCE_DB, env.TEST_MIGRATIONS);
  for (const path of ["/api/me", "/api/organizations", "/api/admin/initialize"]) {
    const response = await request(path, { method: "POST", headers: { Authorization: "Bearer public-test-fixture", "X-User-Id": "user_fixture", "X-Role": "owner" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "INSTANCE_NOT_INITIALIZED" } });
  }
  expect(await env.INSTANCE_DB.prepare("SELECT count(*) AS n FROM instance_admin").first("n")).toBe(0);
  await env.INSTANCE_DB.prepare("INSERT INTO instance_config VALUES (1,'admin_only','admin_only',1)").run();
  await env.INSTANCE_DB.prepare("INSERT INTO instance_admin VALUES ('user_fixture','test','2026-10-17T00:00:00Z','active')").run();
  const response = await request("/api/me");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "AUTH_NOT_IMPLEMENTED" } });
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
