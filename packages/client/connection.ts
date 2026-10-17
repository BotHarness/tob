import { ClientError, connectionKey, parseInstance, type InstanceConfig } from "../contracts/instance.ts";
export async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new ClientError("INVALID_RESPONSE");
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) throw new ClientError("INVALID_RESPONSE"); chunks.push(value); } }
  finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let position = 0; for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  try { const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new ClientError("INVALID_RESPONSE"); }
}
export async function request(url: string, init: RequestInit = {}, signal?: AbortSignal) {
  if (signal?.aborted) throw new ClientError("CANCELLED");
  try { return await fetch(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
  catch { if (signal?.aborted) throw new ClientError("CANCELLED"); throw new ClientError("NETWORK_UNAVAILABLE"); }
}
export async function checkDiscovery(config: InstanceConfig, signal?: AbortSignal) {
  const r = await request(config.server + "/.well-known/open-cloud-groups", {}, signal);
  if (!r.ok) throw new ClientError("DISCOVERY_UNAVAILABLE");
  const discovered = parseInstance(await responseJson(r));
  if (connectionKey(config) !== connectionKey(discovered)) throw new ClientError("INSTANCE_CONFIG_CHANGED");
}
export const form = (body: Record<string, string>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
