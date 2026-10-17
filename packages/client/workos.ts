import { createRemoteJWKSet, jwtVerify } from "jose";

export class AuthenticationError extends Error {}
export async function verifyHumanToken(header: string | undefined, clientId: string, issuer: string) {
  if (!header || !/^Bearer [^\s]+$/.test(header) || header.length > 16384) throw new AuthenticationError("INVALID_TOKEN");
  // T1 supports the client-specific WorkOS issuer only. Neither headers nor JWT fields
  // can choose the issuer, JWKS URL or client ID.
  if (!/^client_[a-zA-Z0-9]+$/.test(clientId) || issuer !== `https://api.workos.com/user_management/${clientId}`) throw new Error("INVALID_AUTH_CONFIGURATION");
  const keySet = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`), { timeoutDuration: 5000 });
  try {
    const { payload } = await jwtVerify(header.slice(7), keySet, { issuer, algorithms: ["RS256"], requiredClaims: ["sub", "sid", "exp", "iat"] });
    if (typeof payload.sub !== "string" || !payload.sub.startsWith("user_") || typeof payload.sid !== "string" || !payload.sid.startsWith("session_")) throw new AuthenticationError("INVALID_TOKEN");
    // WorkOS AuthKit tokens may omit aud. When present, never ignore it.
    if (payload.aud !== undefined && !(typeof payload.aud === "string" ? payload.aud === clientId : Array.isArray(payload.aud) && payload.aud.includes(clientId))) throw new AuthenticationError("INVALID_TOKEN");
    if (payload.azp !== undefined && payload.azp !== clientId) throw new AuthenticationError("INVALID_TOKEN");
    if (payload.org_id !== undefined && (typeof payload.org_id !== "string" || !/^org_[A-Za-z0-9]+$/.test(payload.org_id))) throw new AuthenticationError("INVALID_TOKEN");
    return { userId: payload.sub, sessionId: payload.sid, expiresAt: payload.exp!, organizationId: payload.org_id as string | undefined };
  } catch (error) {
    // Provider failures are unavailable, not an invitation to bypass auth.
    if (error instanceof TypeError || (error instanceof Error && ["ERR_JWKS_TIMEOUT", "ERR_JOSE_GENERIC"].includes((error as { code?: string }).code ?? ""))) throw new Error("IDENTITY_PROVIDER_UNAVAILABLE");
    throw new AuthenticationError("INVALID_TOKEN", { cause: error });
  }
}
