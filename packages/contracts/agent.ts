import { ClientError, parseInstance, type InstanceConfig } from "./instance.ts";
export type AgentCredential = { version: 1; config: InstanceConfig; organizationId: string; channelId: string; actorId: string; ownerUserId: string; name: string; operationId: string; secret: string };
export function parseAgentCredential(value: unknown): AgentCredential {
  const v = value as AgentCredential;
  if (!v || v.version !== 1 || [v.organizationId, v.channelId, v.actorId, v.ownerUserId, v.name, v.operationId, v.secret].some(s => typeof s !== "string") || !/^org_[A-Za-z0-9]+$/.test(v.organizationId) || !/^ch_[a-f0-9]{64}$/.test(v.channelId) || !/^ag_[a-f0-9]{64}$/.test(v.actorId) || !/^user_[A-Za-z0-9]+$/.test(v.ownerUserId) || !v.name.trim() || v.name.length > 80 || !/^[A-Za-z0-9_-]{16,100}$/.test(v.operationId) || !/^[a-f0-9]{64}$/.test(v.secret)) throw new ClientError("INVALID_AGENT_CREDENTIAL");
  return { ...v, config: parseInstance(v.config) };
}
