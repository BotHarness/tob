/** Public, portable connection contract. Possessing this document is not authorization. */
export const MOBILE_REDIRECT_URI = "ai.botharness.deepseekbot.dev:/oauth2redirect";
export type InstanceConfig = {
  formatVersion: 1; protocolVersion: 1; instanceId: string; name: string;
  environment: "local" | "uat"; server: string;
  auth: { provider: "workos"; clientId: string; issuer: string; authkitDomain: string;
    deviceAuthorizationEndpoint: string; tokenEndpoint: string; jwksUri: string; mobileRedirectUris: string[] };
};
export class ClientError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const reject = () => { throw new ClientError("INVALID_INSTANCE_CONFIG"); };
export function serverOrigin(value: unknown): string {
  if (typeof value !== "string") return reject();
  let url: URL; try { url = new URL(value); } catch { return reject(); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) return reject();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject();
  return value as Record<string, unknown>;
}
function exact(o: Record<string, unknown>, keys: string[]) {
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) reject();
}
export function parseInstance(value: unknown): InstanceConfig {
  const v = object(value);
  exact(v, ["formatVersion", "protocolVersion", "instanceId", "name", "environment", "server", "auth"]);
  if (v.formatVersion !== 1 || v.protocolVersion !== 1 || typeof v.instanceId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.instanceId) || typeof v.name !== "string" || !v.name.trim() || v.name.length > 100 || /[\x00-\x1f\x7f]/.test(v.name) || !["uat", "local"].includes(String(v.environment))) reject();
  serverOrigin(v.server);
  const a = object(v.auth);
  exact(a, ["provider", "clientId", "issuer", "authkitDomain", "deviceAuthorizationEndpoint", "tokenEndpoint", "jwksUri", "mobileRedirectUris"]);
  if (a.provider !== "workos" || typeof a.clientId !== "string" || !/^client_[A-Za-z0-9]+$/.test(a.clientId) || a.issuer !== `https://api.workos.com/user_management/${a.clientId}` || a.deviceAuthorizationEndpoint !== "https://api.workos.com/user_management/authorize/device" || a.tokenEndpoint !== "https://api.workos.com/user_management/authenticate" || a.jwksUri !== `https://api.workos.com/sso/jwks/${a.clientId}` || typeof a.authkitDomain !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.authkit\.app$/.test(a.authkitDomain) || !Array.isArray(a.mobileRedirectUris) || (a.mobileRedirectUris.length > 1 || a.mobileRedirectUris.some(uri => uri !== MOBILE_REDIRECT_URI))) reject();
  // Only the explicitly registered development callback is supported in this UAT slice.
  return { formatVersion: 1, protocolVersion: 1, instanceId: v.instanceId as string, name: v.name as string, environment: v.environment as InstanceConfig["environment"], server: v.server as string, auth: { provider: "workos", clientId: a.clientId as string, issuer: a.issuer as string, authkitDomain: a.authkitDomain as string, deviceAuthorizationEndpoint: a.deviceAuthorizationEndpoint as string, tokenEndpoint: a.tokenEndpoint as string, jwksUri: a.jwksUri as string, mobileRedirectUris: [...a.mobileRedirectUris as string[]] } };
}
export function connectionKey(config: InstanceConfig) {
  const { name: _name, ...connection } = parseInstance(config);
  return JSON.stringify(connection);
}
export function publicInstance(input: { instanceId: string; environment: string; server: string; clientId: string; issuer: string; authkitDomain: string; mobileRedirectUri?: string }) {
  return parseInstance({ formatVersion: 1, protocolVersion: 1, instanceId: input.instanceId, name: input.instanceId, environment: input.environment, server: input.server, auth: { provider: "workos", clientId: input.clientId, issuer: input.issuer, authkitDomain: input.authkitDomain, deviceAuthorizationEndpoint: "https://api.workos.com/user_management/authorize/device", tokenEndpoint: "https://api.workos.com/user_management/authenticate", jwksUri: `https://api.workos.com/sso/jwks/${input.clientId}`, mobileRedirectUris: input.mobileRedirectUri ? [input.mobileRedirectUri] : [] } });
}
