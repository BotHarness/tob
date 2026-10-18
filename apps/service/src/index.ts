import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { admit, AccessError } from "./auth/admission";
import { organizations, createOrganization } from "./organizations";
import { instanceAdmin, instanceConfig, managementOperation, channelInvitationDirectory } from "../db/d1/schema";
import { AuthenticationError, verifyHumanToken } from "./auth/workos";
import { publicInstance } from "../../../packages/contracts/instance.ts";
export { Org } from "./org";
export { Channel } from "./channel";
import { channels } from "./channels";
import { invitations, organizationInvitations } from "./invitations";

import { ownerAgents, agentMessages } from "./agents";
import { ownerGuestInvitations, guestInvitations, guestChannels } from "./guests";

const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
});
app.onError((_error, c) => {
  if (_error instanceof AccessError) return c.json({ error: { code: _error.code } }, _error.status);
  // Do not log exception strings, request URLs, headers, bodies, or credentials.
  console.error(JSON.stringify({ event: "request_failed", code: "STORAGE_UNAVAILABLE" }));
  return c.json({ error: { code: "STORAGE_UNAVAILABLE" } }, 503);
});
const api = app
  .get("/.well-known/open-cloud-groups", (c) => c.json(publicInstance({ instanceId: c.env.INSTANCE_ID, environment: c.env.DEPLOYMENT_ENV, server: c.env.PUBLIC_BASE_URL, clientId: c.env.WORKOS_CLIENT_ID, issuer: c.env.WORKOS_ISSUER, authkitDomain: c.env.WORKOS_AUTH_DOMAIN, mobileRedirectUri: c.env.MOBILE_REDIRECT_URI })))
  .post("/api/auth/logout", async (c) => {
    let identity;
    try { identity = await verifyHumanToken(c.req.header("Authorization"), c.env.WORKOS_CLIENT_ID, c.env.WORKOS_ISSUER); }
    catch (error) { return c.json({ error: { code: error instanceof AuthenticationError ? "UNAUTHENTICATED" : "IDENTITY_UNAVAILABLE" } }, error instanceof AuthenticationError ? 401 : 503); }
    // Own-session cleanup is available even after business access is withdrawn.
    // Ignore request body/user IDs: only the verified token can select a session.
    if (!c.env.WORKOS_API_KEY) {
      console.error(JSON.stringify({ event: "session_logout_unconfirmed", phase: "secret_binding" }));
      return c.json({ error: { code: "LOGOUT_UNCONFIRMED" } }, 503);
    }
    try {
      // workerd rejects redirect:error. Never follow redirects with the server key.
      const response = await fetch("https://api.workos.com/user_management/sessions/revoke", { method: "POST", headers: { Authorization: `Bearer ${c.env.WORKOS_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ session_id: identity.sessionId }), redirect: "manual", signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        console.error(JSON.stringify({ event: "session_logout_unconfirmed", phase: "provider_response", status: response.status }));
        return c.json({ error: { code: "LOGOUT_UNCONFIRMED" } }, 503);
      }
      return c.json({ remoteRevoked: true });
    } catch (error) {
      const kind = error instanceof Error && ["TypeError", "TimeoutError", "AbortError"].includes(error.name) ? error.name : "unknown";
      console.error(JSON.stringify({ event: "session_logout_unconfirmed", phase: "provider_transport", kind }));
      return c.json({ error: { code: "LOGOUT_UNCONFIRMED" } }, 503);
    }
  })
  .get("/healthz", (c) => c.json({ service: "tob", environment: c.env.DEPLOYMENT_ENV, instanceId: c.env.INSTANCE_ID, releaseSha: c.env.RELEASE_SHA, businessEnabled: true }))
  .get("/readyz", async (c) => {
    const db = drizzle(c.env.INSTANCE_DB);
    await db.select({ version: instanceConfig.configVersion }).from(instanceConfig).limit(1);
    await db.select({ status: instanceAdmin.status }).from(instanceAdmin).limit(1);
    await db.select({ id: managementOperation.operationId }).from(managementOperation).limit(1);
    // One reserved, schema-only object; this does not create a business organization.
    await db.select({ id: channelInvitationDirectory.invitationId }).from(channelInvitationDirectory).limit(1);
    const org = await c.env.ORGS.getByName("__tob_deployment_probe__").schemaStatus();
    const channel = await c.env.CHANNELS.getByName("__tob_deployment_probe__").schemaStatus();
    return c.json({ channelSchemaVersion: channel.schemaVersion, ready: true, releaseSha: c.env.RELEASE_SHA, d1SchemaVersion: 5, orgSchemaVersion: org.schemaVersion, businessEnabled: true });
  });
const withIdentity = api.get("/api/me", async (c) => {
  const identity = await admit(c.req.header("Authorization"), c.env);
  return c.json({ userId: identity.userId, instanceId: c.env.INSTANCE_ID, instanceRole: identity.instanceRole, capabilities: ["instance:read-self"] });
}).post("/api/onboarding", async c => {
  const identity = await admit(c.req.header("Authorization"), c.env);
  // Caller supplies no identity, name or operation key. The operation namespace is
  // reserved so an ordinary organization.create request cannot occupy it.
  return c.json(await createOrganization(c.env, identity.userId, "default-workspace-v1", "My workspace", "user.default-organization"));
});
const withOrganizations = withIdentity.route("/api/organizations", organizations).route("/api/organizations", channels).route("/api/organizations", organizationInvitations).route("/api/invitations", invitations).route("/api/organizations", ownerGuestInvitations).route("/api/channel-invitations", guestInvitations).route("/api/guest-channels", guestChannels).route("/api/organizations", ownerAgents).route("/api/agent-channels", agentMessages);
// No public bootstrap route; unrelated business commands remain closed.
app.all("/api/*", (c) => c.json({ error: { code: "FEATURE_NOT_AVAILABLE" } }, 503));
app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));
export type AppType = typeof withOrganizations;
export default app;
