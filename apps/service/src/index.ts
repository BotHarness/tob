import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { instanceAdmin, instanceConfig } from "../db/d1/schema";
export { Org } from "./org";

const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
});
app.onError((_error, c) => {
  // Do not log exception strings, request URLs, headers, bodies, or credentials.
  console.error(JSON.stringify({ event: "request_failed", code: "STORAGE_UNAVAILABLE" }));
  return c.json({ error: { code: "STORAGE_UNAVAILABLE" } }, 503);
});
const api = app
  .get("/healthz", (c) => c.json({ service: "tob", environment: c.env.DEPLOYMENT_ENV, instanceId: c.env.INSTANCE_ID, releaseSha: c.env.RELEASE_SHA, businessEnabled: false }))
  .get("/readyz", async (c) => {
    const db = drizzle(c.env.INSTANCE_DB);
    await db.select({ version: instanceConfig.configVersion }).from(instanceConfig).limit(1);
    await db.select({ status: instanceAdmin.status }).from(instanceAdmin).limit(1);
    // One reserved, schema-only object; this does not create a business organization.
    const org = await c.env.ORGS.getByName("__tob_deployment_probe__").schemaStatus();
    return c.json({ ready: true, releaseSha: c.env.RELEASE_SHA, d1SchemaVersion: 1, orgSchemaVersion: org.schemaVersion, businessEnabled: false });
  });
// This increment implements no authentication or bootstrap. Every business path
// remains closed, including callers presenting arbitrary tokens or owner headers.
app.all("/api/*", async (c) => {
  const db = drizzle(c.env.INSTANCE_DB);
  const policy = await db.select().from(instanceConfig).where(eq(instanceConfig.singletonId, 1)).get();
  const admin = await db.select({ id: instanceAdmin.workosUserId }).from(instanceAdmin).where(eq(instanceAdmin.status, "active")).limit(1).get();
  const configured = policy?.registrationMode === "admin_only" && policy.orgCreationMode === "admin_only" && admin;
  return c.json({ error: { code: configured ? "AUTH_NOT_IMPLEMENTED" : "INSTANCE_NOT_INITIALIZED" } }, 503);
});
app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));
export type AppType = typeof api;
export default app;
