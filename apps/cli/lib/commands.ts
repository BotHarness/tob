import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClientError, connectionKey, serverOrigin, type InstanceConfig } from "../../../packages/contracts/instance.ts";
import { checkDiscovery, form, request, responseJson } from "../../../packages/client/connection.ts";
import { verifyHumanToken } from "../../../packages/client/workos.ts";
import { digest, readImport, Store, type Session } from "./store.ts";
export type Runtime = { directory?: string; prompt: (value: unknown) => void; signal?: AbortSignal; wait?: (ms: number) => Promise<void>; now?: () => number };
const expired = (e: unknown) => (e as { cause?: { code?: string } })?.cause?.code === "ERR_JWT_EXPIRED";
function tokens(value: unknown): { accessToken: string; refreshToken: string } {
  const v = value as { access_token?: unknown; refresh_token?: unknown };
  if (!v || typeof v.access_token !== "string" || !v.access_token || v.access_token.length > 16384 || typeof v.refresh_token !== "string" || !v.refresh_token || v.refresh_token.length > 16384) throw new ClientError("INVALID_TOKEN_RESPONSE");
  return { accessToken: v.access_token, refreshToken: v.refresh_token };
}
async function identity(c: InstanceConfig, s: Session) {
  const i = await verifyHumanToken("Bearer " + s.accessToken, c.auth.clientId, c.auth.issuer);
  if (s.userId && i.userId !== s.userId) throw new ClientError("SESSION_IDENTITY_CHANGED");
  return i;
}
export async function execute(args: string[], rt: Runtime): Promise<unknown> {
  if (args[0] === "health" && args[1] === "--server" && args.length === 3) {
    const url = new URL(args[2]);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new ClientError("INVALID_SERVER_ORIGIN");
    const outputs = [];
    for (const path of ["/healthz", "/readyz"]) { const r = await request(new URL(path, url).href); if (!r.ok) throw new ClientError("HEALTH_CHECK_FAILED"); outputs.push(await responseJson(r)); }
    return { health: outputs[0], readiness: outputs[1] };
  }
  const store = new Store(rt.directory ?? join(homedir(), ".config/tob/cli"));
  if (args[0] === "instance" && args[1] === "import" && (args.length === 3 || (args.length === 4 && args[3] === "--replace"))) {
    const c = readImport(args[2]);
    return store.locked(c.instanceId, async () => {
      const old = store.config(c.instanceId);
      const changed = !!old && connectionKey(old) !== connectionKey(c);
      if (changed && args[3] !== "--replace") {
        rt.prompt({ event: "replacement_requires_confirmation", previous: old, next: c, action: "Reverify the deployment target, then repeat import with --replace." });
        throw new ClientError("CONFIG_REPLACEMENT_REQUIRED");
      }
      if (store.configs().some(o => o.instanceId !== c.instanceId && o.server === c.server)) throw new ClientError("SERVER_ALREADY_IMPORTED");
      await checkDiscovery(c, rt.signal);
      if (changed) store.clearSession(c.instanceId);
      store.putConfig(c);
      return { imported: true, instanceId: c.instanceId, server: c.server, environment: c.environment, sessionCleared: changed };
    });
  }
  const isOrg = args[0] === "org";
  const isChannel = args[0] === "channel";
  const isInvitation = args[0] === "invite";
  const scoped = isOrg || isChannel || isInvitation;
  const orgCommand = scoped ? args[1] : undefined;
  const options: Record<string, string> = {};
  if (scoped) {
    if (!(isOrg ? ["list", "create", "use", "show", "update"] : isInvitation ? ["inbox", "list", "send", "accept", "revoke"] : ["list", "create", "show", "history", "send"]).includes(orgCommand ?? "")) throw new ClientError("USAGE");
    for (let n = 2; n < args.length; n += 2) {
      if (!["--server", "--id", "--name", "--operation", "--description", "--version", "--after", "--org", "--text-file", "--email"].includes(args[n]) || args[n+1] === undefined || options[args[n]] !== undefined) throw new ClientError("USAGE");
      options[args[n]] = args[n+1];
    }
  }
  const command = args[0];
  const server = scoped ? options["--server"] : args[2];
  if ((!scoped && (!["login", "whoami", "refresh", "logout", "onboard"].includes(command) || args[1] !== "--server" || args.length !== 3)) || !server) throw new ClientError("USAGE");
  serverOrigin(server);
  const c = store.configs().find(c => c.server === server);
  if (!c) throw new ClientError("INSTANCE_NOT_IMPORTED");
  return store.locked(c.instanceId, async () => {
    // Re-read under the lock: another process may have replaced this configuration.
    const current = store.config(c.instanceId);
    if (!current || connectionKey(current) !== connectionKey(c)) throw new ClientError("INSTANCE_CONFIG_CHANGED");
    const binding = digest(connectionKey(c));
    let session = store.session(c.instanceId);
    const ensureSession = () => {
      if (!session) throw new ClientError("NOT_LOGGED_IN");
      if (session.binding !== binding) throw new ClientError("SESSION_TARGET_MISMATCH");
      return session;
    };
    const persist = async (value: unknown) => {
      session = { version: 1, binding, userId: session?.userId ?? null, ...tokens(value) };
      // Preserve rotated credentials before verification I/O; no use bypasses verification.
      store.putSession(c.instanceId, session);
      const i = await identity(c, session); session.userId = i.userId;
      store.putSession(c.instanceId, session); return i;
    };
    const refresh = async (organizationId?: string) => {
      const saved = ensureSession();
      await checkDiscovery(c, rt.signal);
      const r = await request(c.auth.tokenEndpoint, form({ client_id: c.auth.clientId, grant_type: "refresh_token", refresh_token: saved.refreshToken, ...(organizationId ? { organization_id: organizationId } : {}) }), rt.signal);
      const value = await responseJson(r);
      if (!r.ok) {
        if (r.status === 400 && value.error === "invalid_grant") { store.clearSession(c.instanceId); session = undefined; throw new ClientError("LOGIN_REQUIRED"); }
        throw new ClientError([408, 429].includes(r.status) || r.status >= 500 ? "AUTH_RETRY_REQUIRED" : "AUTH_REFRESH_FAILED");
      }
      return persist(value);
    };
    const freshIdentity = async () => {
      const s = ensureSession();
      try { return await identity(c, s); }
      catch (e) { if (expired(e)) return refresh(); throw e; }
    };
    if (command === "logout") {
      if (!session) return { localLoggedOut: true, remoteRevoked: null, alreadyLoggedOut: true };
      let remoteRevoked = false;
      try {
        ensureSession(); await checkDiscovery(c, rt.signal); await freshIdentity();
        const r = await request(c.server + "/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + ensureSession().accessToken } }, rt.signal);
        remoteRevoked = r.ok && (await responseJson(r)).remoteRevoked === true;
      } catch { /* Local cleanup must still work offline or after configuration drift. */ }
      store.clearSession(c.instanceId);
      return { localLoggedOut: true, remoteRevoked, ...(remoteRevoked ? {} : { warning: "REMOTE_LOGOUT_UNCONFIRMED" }) };
    }
    if (command !== "login") ensureSession();
    await checkDiscovery(c, rt.signal);
    if (command === "login") {
      if (session) throw new ClientError("ALREADY_LOGGED_IN");
      const r = await request(c.auth.deviceAuthorizationEndpoint, form({ client_id: c.auth.clientId }), rt.signal);
      if (!r.ok) throw new ClientError("DEVICE_AUTH_FAILED");
      const d = await responseJson(r);
      if (d.verification_uri !== `https://${c.auth.authkitDomain}/device` || typeof d.device_code !== "string" || d.device_code.length > 4096 || typeof d.user_code !== "string" || !/^[A-Z0-9-]{4,32}$/.test(d.user_code) || typeof d.interval !== "number" || !Number.isInteger(d.interval) || d.interval < 1 || d.interval > 60 || typeof d.expires_in !== "number" || !Number.isInteger(d.expires_in) || d.expires_in < 1 || d.expires_in > 1800) throw new ClientError("INVALID_DEVICE_RESPONSE");
      rt.prompt({ event: "confirm_login", server: c.server, environment: c.environment, verificationUri: d.verification_uri, userCode: d.user_code });
      const now = rt.now ?? Date.now; const deadline = now() + d.expires_in * 1000; let interval = d.interval * 1000;
      const wait = rt.wait ?? ((ms: number) => sleep(ms, undefined, { signal: rt.signal }));
      while (now() < deadline) {
        if (rt.signal?.aborted) throw new ClientError("CANCELLED");
        await wait(Math.min(interval, deadline - now()));
        if (now() >= deadline) break;
        const tokenResponse = await request(c.auth.tokenEndpoint, form({ client_id: c.auth.clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code }), rt.signal);
        const value = await responseJson(tokenResponse);
        if (tokenResponse.ok) { await persist(value); break; }
        if (value.error === "slow_down") { interval += 5000; continue; }
        if (value.error === "authorization_pending") continue;
        throw new ClientError(value.error === "access_denied" ? "LOGIN_DENIED" : "DEVICE_AUTH_FAILED");
      }
      if (!session) throw new ClientError("LOGIN_EXPIRED");
    }
    if (scoped) {
      let i = await freshIdentity();
      const call = async (path: string, init: RequestInit = {}, prefix = "/api/organizations") => {
        await checkDiscovery(c, rt.signal);
        const r = await request(c.server + prefix + path, { ...init, headers: { ...init.headers, Authorization: "Bearer " + ensureSession().accessToken } }, rt.signal);
        const value = await responseJson(r);
        if (!r.ok) {
          const code = (value.error as { code?: unknown })?.code;
          throw new ClientError(typeof code === "string" && /^[A-Z_]{1,80}$/.test(code) ? code : "ORGANIZATION_UNAVAILABLE");
        }
        return value;
      };
      if (isInvitation) {
        const id = options["--id"];
        if (orgCommand === "inbox") return call(options["--after"] ? "?after=" + encodeURIComponent(options["--after"]) : "", {}, "/api/invitations");
        if (orgCommand === "accept") {
          if (!id || !/^invitation_[A-Za-z0-9]+$/.test(id)) throw new ClientError("INVALID_INVITATION");
          return call("/" + id + "/accept", { method: "POST" }, "/api/invitations");
        }
        const orgId = options["--org"] ?? i.organizationId;
        if (!orgId || !/^org_[A-Za-z0-9]+$/.test(orgId) || orgId !== i.organizationId) throw new ClientError("ORGANIZATION_TOKEN_REQUIRED");
        const base = "/" + orgId + "/invitations";
        if (orgCommand === "list") return call(base + (options["--after"] ? "?after=" + encodeURIComponent(options["--after"]) : ""));
        if (orgCommand === "send") {
          if (!options["--email"] || !options["--operation"]) throw new ClientError("USAGE");
          return call(base, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": options["--operation"] }, body: JSON.stringify({ email: options["--email"] }) });
        }
        if (!id || !/^invitation_[A-Za-z0-9]+$/.test(id)) throw new ClientError("INVALID_INVITATION");
        return call(base + "/" + id + "/revoke", { method: "POST" });
      }
      if (isChannel) {
        const orgId = options["--org"] ?? i.organizationId;
        if (!orgId || !/^org_[A-Za-z0-9]+$/.test(orgId) || i.organizationId !== orgId) throw new ClientError("ORGANIZATION_TOKEN_REQUIRED");
        const base = "/" + orgId + "/channels";
        if (orgCommand === "list") return call(base + (options["--after"] ? "?after=" + encodeURIComponent(options["--after"]) : ""));
        if (orgCommand === "create") {
          if (!options["--name"] || !options["--operation"]) throw new ClientError("USAGE");
          return call(base, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": options["--operation"] }, body: JSON.stringify({ name: options["--name"] }) });
        }
        const id = options["--id"];
        if (!id || !/^ch_[a-f0-9]{64}$/.test(id)) throw new ClientError("INVALID_CHANNEL");
        if (orgCommand === "show") return call(base + "/" + id);
        if (orgCommand === "history") return call(base + "/" + id + "/messages?after=" + encodeURIComponent(options["--after"] ?? "0"));
        if (!options["--text-file"] || !options["--operation"]) throw new ClientError("USAGE");
        let text: string; try { text = readFileSync(options["--text-file"], "utf8"); } catch { throw new ClientError("MESSAGE_FILE_UNREADABLE"); }
        if (!text.trim() || text.length > 4000) throw new ClientError("INVALID_CHANNEL_INPUT");
        return call(base + "/" + id + "/messages", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": options["--operation"] }, body: JSON.stringify({ text }) });
      }
      if (orgCommand === "list") return call(options["--after"] ? "?after=" + encodeURIComponent(options["--after"]) : "");
      if (orgCommand === "create") {
        if (!options["--name"] || !options["--operation"]) throw new ClientError("USAGE");
        return call("", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": options["--operation"] }, body: JSON.stringify({ name: options["--name"] }) });
      }
      const id = options["--id"] ?? i.organizationId;
      if (!id || !/^org_[A-Za-z0-9]+$/.test(id)) throw new ClientError("ORGANIZATION_NOT_SELECTED");
      if (orgCommand === "use") {
        await call("/" + id + "/access");
        i = await refresh(id);
        if (i.organizationId !== id) throw new ClientError("ORGANIZATION_TOKEN_MISMATCH");
        return { ...await call("/" + id), selected: true };
      }
      if (i.organizationId !== id) throw new ClientError("ORGANIZATION_TOKEN_REQUIRED");
      if (orgCommand === "show") return call("/" + id);
      if (options["--description"] === undefined || !/^[1-9][0-9]*$/.test(options["--version"] ?? "")) throw new ClientError("USAGE");
      return call("/" + id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: options["--description"], version: Number(options["--version"]) }) });
    }
    const i = command === "refresh" ? await refresh() : await freshIdentity();
    await checkDiscovery(c, rt.signal);
    const me = await request(c.server + "/api/me", { headers: { Authorization: "Bearer " + ensureSession().accessToken } }, rt.signal);
    if (!me.ok) throw new ClientError(me.status === 403 ? "INSTANCE_ACCESS_DENIED" : me.status === 401 ? "UNAUTHENTICATED" : "INSTANCE_UNAVAILABLE");
    const body = await responseJson(me);
    if (body.userId !== i.userId || body.instanceId !== c.instanceId || !["admin", "user"].includes(String(body.instanceRole))) throw new ClientError("IDENTITY_RESPONSE_MISMATCH");
    let defaultOrganizationId: string | undefined;
    if (command === "login" || command === "onboard") {
      const r = await request(c.server + "/api/onboarding", { method: "POST", headers: { Authorization: "Bearer " + ensureSession().accessToken } }, rt.signal);
      const value = await responseJson(r);
      if (!r.ok || typeof value.organizationId !== "string" || !/^org_[A-Za-z0-9]+$/.test(value.organizationId)) throw new ClientError("ONBOARDING_INCOMPLETE");
      defaultOrganizationId = value.organizationId;
    }
    return { userId: i.userId, instanceId: c.instanceId, server: c.server, instanceRole: body.instanceRole, ...(defaultOrganizationId ? { defaultOrganizationId } : {}), ...(i.organizationId ? { organizationId: i.organizationId } : {}), ...(command === "refresh" ? { refreshed: true } : {}) };
  });
}
