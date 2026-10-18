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
  const db = drizzle(env.INSTANCE_DB);
  const policy = await db.select().from(instanceConfig).where(eq(instanceConfig.singletonId, 1)).get();
  const receipt = await db.select().from(managementOperation).where(eq(managementOperation.operationId, "instance.initialize")).get();
  if (policy?.registrationMode !== "admin_only" || policy.orgCreationMode !== "admin_only" || receipt?.state !== "succeeded" || receipt.kind !== "instance.initialize") throw new AccessError("INSTANCE_NOT_INITIALIZED", 503);
  const admin = await db.select().from(instanceAdmin).where(eq(instanceAdmin.workosUserId, identity.userId)).get();
  if (admin?.status !== "active" || receipt.targetId !== identity.userId) throw new AccessError("INSTANCE_ACCESS_DENIED", 403);
  return identity;
}
