import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { instanceAdmin, instanceConfig, managementOperation } from "../../db/d1/schema";
import { AuthenticationError, verifyHumanToken } from "./workos";
export class AccessError extends Error {
  constructor(public code: string, public status: 400 | 401 | 403 | 404 | 409 | 503) { super(code); }
}
export async function admit(header: string | undefined, env: Env) {
  let identity;
  try { identity = await verifyHumanToken(header, env.WORKOS_CLIENT_ID, env.WORKOS_ISSUER); }
  catch (e) { throw new AccessError(e instanceof AuthenticationError ? "UNAUTHENTICATED" : "IDENTITY_UNAVAILABLE", e instanceof AuthenticationError ? 401 : 503); }
  return { ...identity, instanceRole: await admitUser(identity.userId, env) };
}
// Internal canonical user check: callers must first authenticate a Human token
// or obtain the owner ID from a verified, channel-local Agent credential.
export async function admitUser(userId: string, env: Env) {
  const db = drizzle(env.INSTANCE_DB);
  const policy = await db.select().from(instanceConfig).where(eq(instanceConfig.singletonId, 1)).get();
  const receipt = await db.select().from(managementOperation).where(eq(managementOperation.operationId, "instance.initialize")).get();
  if (!policy || !["admin_only", "authenticated"].includes(policy.registrationMode) || !["admin_only", "all_users"].includes(policy.orgCreationMode) || receipt?.state !== "succeeded" || receipt.kind !== "instance.initialize") throw new AccessError("INSTANCE_NOT_INITIALIZED", 503);
  const admin = await db.select().from(instanceAdmin).where(eq(instanceAdmin.workosUserId, userId)).get();
  // A revoked bootstrap administrator must not fall back to ordinary access.
  if (admin && (admin.status !== "active" || receipt.targetId !== userId)) throw new AccessError("INSTANCE_ACCESS_DENIED", 403);
  const instanceRole = admin ? "admin" as const : "user" as const;
  if (instanceRole === "user" && policy.registrationMode !== "authenticated") throw new AccessError("INSTANCE_ACCESS_DENIED", 403);
  if (policy.registrationMode === "authenticated") {
    // Check the current provider user rather than trusting a deleted user's old JWT.
    let response: Response;
    try {
      if (!env.WORKOS_API_KEY) throw new Error();
      response = await fetch("https://api.workos.com/user_management/users/" + encodeURIComponent(userId), { headers: { Authorization: "Bearer " + env.WORKOS_API_KEY }, redirect: "manual", signal: AbortSignal.timeout(10000) });
    } catch { throw new AccessError("IDENTITY_UNAVAILABLE", 503); }
    if (response.status === 404) throw new AccessError("INSTANCE_ACCESS_DENIED", 403);
    if (!response.ok) throw new AccessError("IDENTITY_UNAVAILABLE", 503);
    let user: { id?: string; email_verified?: boolean };
    try { user = await response.json(); } catch { throw new AccessError("IDENTITY_UNAVAILABLE", 503); }
    if (user?.id !== userId || user.email_verified !== true) throw new AccessError("INSTANCE_ACCESS_DENIED", 403);
  }
  return instanceRole;
}

export async function requireOrganizationCreation(identity: { instanceRole: "admin" | "user" }, env: Env) {
  const policy = await drizzle(env.INSTANCE_DB).select().from(instanceConfig).where(eq(instanceConfig.singletonId, 1)).get();
  if (!policy || (identity.instanceRole !== "admin" && policy.orgCreationMode !== "all_users")) throw new AccessError("ORGANIZATION_CREATION_DENIED", 403);
}
