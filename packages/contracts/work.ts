import { ClientError } from './instance.ts';

export type WorkRequest = {
  version: 1;
  requestId: string;
  channelId: string;
  requesterUserId: string;
  targetActorId: string;
  capability: 'health-check';
  createdAt: string;
  expiresAt: string;
};
export type WorkResult = {
  version: 1;
  requestId: string;
  state: 'completed' | 'rejected' | 'needs-review';
  environment: string;
  executionCount: number;
  reason:
    | 'OK'
    | 'LOCAL_POLICY_DENIED'
    | 'REQUEST_EXPIRED'
    | 'REQUESTER_ACCESS_DENIED'
    | 'INTERRUPTED_EXECUTION';
  diagnostics?: { platform: string; architecture: string; runtime: string };
};
export const validRequestId = (value: unknown): value is string =>
  typeof value === 'string' && /^wr_[a-f0-9]{64}$/.test(value);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ClientError('INVALID_WORK_INPUT');
  return value as Record<string, unknown>;
}
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
const label = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_. -]{1,64}$/.test(v);
const iso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function parseWorkInput(value: unknown) {
  const v = record(value);
  if (
    !exact(v, ['targetActorId', 'capability', 'expiresAt']) ||
    typeof v.targetActorId !== 'string' ||
    !/^ag_[a-f0-9]{64}$/.test(v.targetActorId) ||
    v.capability !== 'health-check' ||
    !iso(v.expiresAt)
  )
    throw new ClientError('INVALID_WORK_INPUT');
  return {
    targetActorId: v.targetActorId,
    capability: 'health-check' as const,
    expiresAt: v.expiresAt,
  };
}
export function parseWorkRequest(value: unknown): WorkRequest {
  const v = record(value);
  const input = parseWorkInput({
    targetActorId: v.targetActorId,
    capability: v.capability,
    expiresAt: v.expiresAt,
  });
  if (
    !exact(v, [
      'version',
      'requestId',
      'channelId',
      'requesterUserId',
      'targetActorId',
      'capability',
      'createdAt',
      'expiresAt',
    ]) ||
    v.version !== 1 ||
    !validRequestId(v.requestId) ||
    typeof v.channelId !== 'string' ||
    !/^ch_[a-f0-9]{64}$/.test(v.channelId) ||
    typeof v.requesterUserId !== 'string' ||
    !/^user_[A-Za-z0-9]+$/.test(v.requesterUserId) ||
    !iso(v.createdAt) ||
    Date.parse(input.expiresAt) <= Date.parse(v.createdAt) ||
    Date.parse(input.expiresAt) - Date.parse(v.createdAt) > 600000
  )
    throw new ClientError('INVALID_WORK_INPUT');
  return {
    version: 1,
    requestId: v.requestId,
    channelId: v.channelId,
    requesterUserId: v.requesterUserId,
    ...input,
    createdAt: v.createdAt,
  };
}
export function parseWorkResult(value: unknown): WorkResult {
  const v = record(value);
  if (
    !exact(v, [
      'version',
      'requestId',
      'state',
      'environment',
      'executionCount',
      'reason',
      'diagnostics',
    ]) ||
    v.version !== 1 ||
    !validRequestId(v.requestId) ||
    !['completed', 'rejected', 'needs-review'].includes(String(v.state)) ||
    !label(v.environment) ||
    ![0, 1].includes(Number(v.executionCount)) ||
    typeof v.executionCount !== 'number'
  )
    throw new ClientError('INVALID_WORK_INPUT');
  let diagnostics: WorkResult['diagnostics'];
  if (v.state === 'completed') {
    const d = record(v.diagnostics);
    if (
      v.executionCount !== 1 ||
      v.reason !== 'OK' ||
      !exact(d, ['platform', 'architecture', 'runtime']) ||
      !label(d.platform) ||
      !label(d.architecture) ||
      !label(d.runtime)
    )
      throw new ClientError('INVALID_WORK_INPUT');
    diagnostics = { platform: d.platform, architecture: d.architecture, runtime: d.runtime };
  } else if (
    v.diagnostics !== undefined ||
    (v.state === 'rejected'
      ? v.executionCount !== 0 ||
        !['LOCAL_POLICY_DENIED', 'REQUEST_EXPIRED', 'REQUESTER_ACCESS_DENIED'].includes(
          String(v.reason),
        )
      : v.reason !== 'INTERRUPTED_EXECUTION')
  )
    throw new ClientError('INVALID_WORK_INPUT');
  return {
    version: 1,
    requestId: v.requestId,
    state: v.state as WorkResult['state'],
    environment: v.environment,
    executionCount: v.executionCount,
    reason: v.reason as WorkResult['reason'],
    ...(diagnostics ? { diagnostics } : {}),
  };
}
