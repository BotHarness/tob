import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { instanceAdmin, instanceConfig, managementOperation } from "../db/d1/schema";
import { AuthenticationError, verifyHumanToken } from "./auth/workos";
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
    await db.select({ id: managementOperation.operationId }).from(managementOperation).limit(1);
    // One reserved, schema-only object; this does not create a business organization.
    const org = await c.env.ORGS.getByName("__tob_deployment_probe__").schemaStatus();
    return c.json({ ready: true, releaseSha: c.env.RELEASE_SHA, d1SchemaVersion: 2, orgSchemaVersion: org.schemaVersion, businessEnabled: false });
  });
const withIdentity = api.get("/api/me", async (c) => {
  let identity;
  try { identity = await verifyHumanToken(c.req.header("Authorization"), c.env.WORKOS_CLIENT_ID, c.env.WORKOS_ISSUER); }
  catch (error) {
    if (error instanceof AuthenticationError) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);
    return c.json({ error: { code: "IDENTITY_UNAVAILABLE" } }, 503);
  }
  const db = drizzle(c.env.INSTANCE_DB);
  const policy = await db.select().from(instanceConfig).where(eq(instanceConfig.singletonId, 1)).get();
  const receipt = await db.select().from(managementOperation).where(eq(managementOperation.operationId, "instance.initialize")).get();
  if (policy?.registrationMode !== "admin_only" || policy.orgCreationMode !== "admin_only" || receipt?.state !== "succeeded" || receipt.kind !== "instance.initialize") return c.json({ error: { code: "INSTANCE_NOT_INITIALIZED" } }, 503);
  const admin = await db.select().from(instanceAdmin).where(eq(instanceAdmin.workosUserId, identity.userId)).get();
  if (admin?.status !== "active" || receipt.targetId !== identity.userId) return c.json({ error: { code: "INSTANCE_ACCESS_DENIED" } }, 403);
  return c.json({ userId: identity.userId, instanceId: c.env.INSTANCE_ID, instanceRole: "admin", capabilities: ["instance:read-self"] });
});
// No public bootstrap route. Organization and other business commands stay closed.
app.all("/api/*", (c) => c.json({ error: { code: "FEATURE_NOT_AVAILABLE" } }, 503));
app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));
export type AppType = typeof withIdentity;
export default app;
