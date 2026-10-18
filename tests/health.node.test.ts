import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HealthLedger,
  processHealthRequest,
  type HealthPolicy,
} from '../packages/reference/health.ts';
import { ClientError } from '../packages/contracts/instance.ts';
import type { WorkRequest, WorkResult } from '../packages/contracts/work.ts';
const binding = 'a'.repeat(64);
const policy: HealthPolicy = {
  version: 1,
  binding,
  actorId: 'ag_' + 'b'.repeat(64),
  channelId: 'ch_' + 'c'.repeat(64),
  environment: 'test-process',
  allowedUsers: ['user_test'],
};
const request: WorkRequest = {
  version: 1,
  requestId: 'wr_' + 'd'.repeat(64),
  channelId: policy.channelId,
  targetActorId: policy.actorId,
  requesterUserId: 'user_test',
  capability: 'health-check',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300000).toISOString(),
};
async function fixture(
  fn: (value: {
    ledger: HealthLedger;
    dir: string;
    sent: WorkResult[];
    transport: {
      authorize: (r: WorkRequest) => Promise<WorkRequest>;
      send: (r: WorkResult) => Promise<void>;
    };
  }) => Promise<void>,
) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tob-health-'));
  const ledger = new HealthLedger(dir, binding);
  const sent: WorkResult[] = [];
  try {
    await fn({
      ledger,
      dir,
      sent,
      transport: {
        authorize: async (r) => r,
        send: async (r) => {
          sent.push(r);
        },
      },
    });
  } finally {
    try {
      ledger.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}
test('fixed check executes once, persists result, and duplicate replay survives ledger reopen', () =>
  fixture(async ({ ledger, dir, sent, transport }) => {
    assert.deepEqual(await processHealthRequest(ledger, request, () => policy, transport), {
      executed: 1,
      replayed: false,
      state: 'completed',
    });
    assert.equal(ledger.row(request.requestId)?.execution_count, 1);
    assert.equal(sent[0].diagnostics?.platform, process.platform);
    ledger.close();
    const reopened = new HealthLedger(dir, binding);
    try {
      assert.deepEqual(await processHealthRequest(reopened, request, () => policy, transport), {
        executed: 0,
        replayed: true,
        state: 'completed',
      });
      assert.equal(sent.length, 1);
      assert.equal(reopened.row(request.requestId)?.execution_count, 1);
    } finally {
      reopened.close();
    }
  }));
test('lost result acknowledgement retries identical durable result without re-executing', () =>
  fixture(async ({ ledger, sent, transport }) => {
    let fail = true;
    transport.send = async (r) => {
      sent.push(r);
      if (fail) throw new ClientError('NETWORK_UNAVAILABLE');
    };
    await assert.rejects(processHealthRequest(ledger, request, () => policy, transport));
    assert.equal(ledger.row(request.requestId)?.state, 'outbox');
    fail = false;
    const r = await processHealthRequest(ledger, request, () => policy, transport);
    assert.equal(r.executed, 0);
    assert.deepEqual(sent[0], sent[1]);
    assert.equal(ledger.row(request.requestId)?.execution_count, 1);
  }));
for (const phase of ['afterClaim', 'afterExecute'] as const)
  test('interruption ' + phase + ' reports needs-review instead of re-running', () =>
    fixture(async ({ ledger, sent, transport }) => {
      await assert.rejects(
        processHealthRequest(ledger, request, () => policy, transport, {
          [phase]: () => {
            throw Error('injected crash');
          },
        }),
      );
      assert.equal(ledger.row(request.requestId)?.state, 'started');
      const r = await processHealthRequest(ledger, request, () => policy, transport);
      assert.equal(r.state, 'needs-review');
      assert.equal(r.executed, 0);
      assert.equal(sent[0].reason, 'INTERRUPTED_EXECUTION');
      assert.equal(sent[0].executionCount, phase === 'afterClaim' ? 0 : 1);
    }),
  );
test('local policy is separate from cloud authorization and reread after network waits', () =>
  fixture(async ({ ledger, sent, transport }) => {
    let current = policy;
    transport.authorize = async (r) => {
      current = { ...policy, allowedUsers: [] };
      return r;
    };
    await processHealthRequest(ledger, request, () => current, transport);
    assert.equal(sent[0].reason, 'LOCAL_POLICY_DENIED');
    assert.equal(ledger.row(request.requestId)?.execution_count, 0);
  }));
test('expired work is reported without attempting cloud authorization or executing', () =>
  fixture(async ({ ledger, sent, transport }) => {
    transport.authorize = async () => {
      throw Error('must not authorize');
    };
    await processHealthRequest(ledger, request, () => policy, transport, {
      now: () => Date.parse(request.expiresAt) + 1,
    });
    assert.equal(sent[0].reason, 'REQUEST_EXPIRED');
    assert.equal(ledger.row(request.requestId)?.execution_count, 0);
  }));
test('expiry reached while checking current access still refuses work', () =>
  fixture(async ({ ledger, sent, transport }) => {
    let now = Date.parse(request.createdAt);
    transport.authorize = async (r) => {
      now = Date.parse(r.expiresAt) + 1;
      return r;
    };
    await processHealthRequest(ledger, request, () => policy, transport, { now: () => now });
    assert.equal(sent[0].reason, 'REQUEST_EXPIRED');
    assert.equal(ledger.row(request.requestId)?.execution_count, 0);
  }));
test('temporary authorization failure keeps request retryable, known requester removal rejects without execution', () =>
  fixture(async ({ ledger, sent, transport }) => {
    transport.authorize = async () => {
      throw new ClientError('IDENTITY_UNAVAILABLE');
    };
    await assert.rejects(processHealthRequest(ledger, request, () => policy, transport));
    assert.equal(ledger.row(request.requestId), undefined);
    transport.authorize = async () => {
      throw new ClientError('REQUESTER_ACCESS_DENIED');
    };
    await processHealthRequest(ledger, request, () => policy, transport);
    assert.equal(sent[0].reason, 'REQUESTER_ACCESS_DENIED');
    assert.equal(ledger.row(request.requestId)?.execution_count, 0);
  }));
test('request identity/content and target changes fail closed without execution', () =>
  fixture(async ({ ledger, transport }) => {
    await assert.rejects(
      processHealthRequest(
        ledger,
        { ...request, targetActorId: 'ag_' + 'e'.repeat(64) },
        () => policy,
        transport,
      ),
      (e) => e instanceof ClientError && e.code === 'WORK_TARGET_MISMATCH',
    );
    await processHealthRequest(ledger, request, () => policy, transport);
    await assert.rejects(
      processHealthRequest(
        ledger,
        { ...request, requesterUserId: 'user_other' },
        () => policy,
        transport,
      ),
      (e) => e instanceof ClientError && e.code === 'WORK_REQUEST_CONFLICT',
    );
    assert.equal(ledger.row(request.requestId)?.execution_count, 1);
  }));

test('private policy setup requires confirmation, rejects target drift and rejects permissive credential files', async () => {
  const { healthCommand, configureHealth } = await import('../packages/reference/health.ts');
  const { publicInstance } = await import('../packages/contracts/instance.ts');
  const { writeFileSync, statSync, chmodSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tob-health-config-'));
  try {
    const config = publicInstance({
      instanceId: 'test-health',
      environment: 'uat',
      server: 'https://health.example',
      clientId: 'client_health',
      issuer: 'https://api.workos.com/user_management/client_health',
      authkitDomain: 'health.authkit.app',
    });
    const credential = {
      version: 1,
      config,
      organizationId: 'org_test',
      channelId: policy.channelId,
      actorId: policy.actorId,
      ownerUserId: 'user_test',
      name: 'Health check',
      operationId: 'op-health-123456789',
      secret: 'e'.repeat(64),
    };
    const file = join(dir, 'credential.json'),
      state = join(dir, 'state');
    writeFileSync(file, JSON.stringify(credential), { mode: 0o600 });
    await assert.rejects(
      healthCommand([
        'agent-health',
        'configure',
        '--credential-file',
        file,
        '--state-dir',
        state,
        '--environment',
        'test',
        '--allow-users',
        'user_test',
      ]),
      (e) => e instanceof ClientError && e.code === 'CONFIRM_LOCAL_POLICY_REQUIRED',
    );
    const output = await healthCommand([
      'agent-health',
      'configure',
      '--credential-file',
      file,
      '--state-dir',
      state,
      '--environment',
      'test',
      '--allow-users',
      'user_test',
      '--confirm',
    ]);
    assert.equal(JSON.stringify(output).includes(credential.secret), false);
    assert.equal(statSync(join(state, 'policy.json')).mode & 0o777, 0o600);
    assert.equal(statSync(state).mode & 0o777, 0o700);
    await configureHealth(file, state, 'test', []);
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'policy.json'), 'utf8')).allowedUsers, []);
    writeFileSync(file, JSON.stringify({ ...credential, actorId: 'ag_' + 'f'.repeat(64) }));
    await assert.rejects(
      configureHealth(file, state, 'test', ['user_test']),
      (e) => e instanceof ClientError && e.code === 'LOCAL_POLICY_TARGET_MISMATCH',
    );
    chmodSync(file, 0o644);
    await assert.rejects(
      configureHealth(file, state, 'test', []),
      (e) => e instanceof ClientError && e.code === 'PRIVATE_CREDENTIAL_FILE_REQUIRED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
