import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicInstance } from '../packages/contracts/instance.ts';
import {
  parseWorkMessage,
  parseWorkRequest,
  type WorkRequest,
} from '../packages/contracts/work.ts';
import { agentCommand } from '../apps/cli/lib/agent.ts';
import { HealthLedger, processHealthRequest } from '../packages/reference/health.ts';
const a = 'ag_' + 'a'.repeat(64),
  b = 'ag_' + 'b'.repeat(64),
  channel = 'ch_' + 'c'.repeat(64),
  parent = 'wr_' + 'd'.repeat(64);
const request: WorkRequest = {
  version: 1,
  requestId: 'wr_' + 'e'.repeat(64),
  channelId: channel,
  requesterUserId: 'user_original',
  targetActorId: b,
  capability: 'health-check',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  delegation: { parentRequestId: parent, actorId: a, hops: 1 },
};
const message = { kind: 'work_request', authorType: 'agent', authorId: a, payload: request };
test('forwarded work distinguishes remote Agent authorship from the original Human', () => {
  assert.deepEqual(parseWorkMessage(message), request);
  for (const m of [
    { ...message, authorType: 'human' },
    { ...message, authorId: b },
    { ...message, kind: 'text' },
    { ...message, payload: { ...request, delegation: undefined } },
  ])
    assert.throws(() => parseWorkMessage(m));
  for (const d of [
    { ...request.delegation, hops: 2 },
    { ...request.delegation, parentRequestId: request.requestId },
    { ...request.delegation, actorId: b },
    { ...request.delegation, scope: 'shell' },
  ])
    assert.throws(() => parseWorkRequest({ ...request, delegation: d }));
});
test('local health policy checks the original user, not the forwarding Agent owner', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tob-forward-policy-'));
  const ledger = new HealthLedger(dir, 'a'.repeat(64));
  let auth = 0;
  const sent: unknown[] = [];
  try {
    const policy = {
      version: 1 as const,
      binding: 'a'.repeat(64),
      actorId: b,
      channelId: channel,
      environment: 'b',
      allowedUsers: ['user_forwarderOwner'],
    };
    const result = await processHealthRequest(ledger, request, () => policy, {
      authorize: async (r) => {
        auth++;
        return r;
      },
      send: async (r) => {
        sent.push(r);
      },
    });
    assert.equal(result.executed, 0);
    assert.equal(auth, 0);
    assert.deepEqual(sent, [
      {
        version: 1,
        requestId: request.requestId,
        state: 'rejected',
        environment: 'b',
        executionCount: 0,
        reason: 'LOCAL_POLICY_DENIED',
      },
    ]);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('forwarded work authorized for its original user executes once across a fresh local ledger process', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tob-forward-execute-'));
  let ledger = new HealthLedger(dir, 'a'.repeat(64));
  let authorizations = 0,
    sends = 0;
  const policy = {
    version: 1 as const,
    binding: 'a'.repeat(64),
    actorId: b,
    channelId: channel,
    environment: 'b',
    allowedUsers: ['user_original'],
  };
  const transport = {
    authorize: async (r: WorkRequest) => {
      authorizations++;
      return r;
    },
    send: async () => {
      sends++;
    },
  };
  try {
    assert.equal(
      (await processHealthRequest(ledger, request, () => policy, transport)).executed,
      1,
    );
    ledger.close();
    ledger = new HealthLedger(dir, 'a'.repeat(64));
    assert.equal(
      (await processHealthRequest(ledger, request, () => policy, transport)).executed,
      0,
    );
    assert.equal(authorizations, 1);
    assert.equal(sends, 1);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('CLI forwards only target and parent through trusted discovery and validates the returned author', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tob-forward-cli-'));
  const file = join(dir, 'credential.json');
  const original = globalThis.fetch;
  const config = publicInstance({
    instanceId: 'test-instance',
    environment: 'uat',
    server: 'https://groups.example',
    clientId: 'client_fixture',
    issuer: 'https://api.workos.com/user_management/client_fixture',
    authkitDomain: 'fixture.authkit.app',
  });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      config,
      organizationId: 'org_fixture',
      channelId: channel,
      actorId: a,
      ownerUserId: 'user_owner',
      name: 'A',
      operationId: 'agent-operation-0001',
      secret: 'f'.repeat(64),
    }),
    { mode: 0o600 },
  );
  const args = [
    'agent-channel',
    'forward',
    '--credential-file',
    file,
    '--request',
    parent,
    '--target',
    b,
  ];
  let calls = 0,
    badAuthor = false,
    changedDiscovery = false;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(init?.redirect, 'error');
    if (String(input).endsWith('/.well-known/open-cloud-groups')) {
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return Response.json({
        ...config,
        ...(changedDiscovery ? { instanceId: 'changed-instance' } : {}),
      });
    }
    assert.equal(
      String(input),
      config.server + '/api/agent-channels/' + channel + '/work-requests/' + parent + '/forward',
    );
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { targetActorId: b });
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer tob_agent_' + a + '.' + 'f'.repeat(64),
    );
    return Response.json({
      message: badAuthor ? { ...message, authorId: b } : message,
      replayed: false,
    });
  };
  try {
    assert.deepEqual(await agentCommand(args), { message, replayed: false });
    assert.equal(calls, 2);
    badAuthor = true;
    await assert.rejects(agentCommand(args), { code: 'INVALID_WORK_MESSAGE' });
    calls = 0;
    changedDiscovery = true;
    await assert.rejects(agentCommand(args), { code: 'INSTANCE_CONFIG_CHANGED' });
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(agentCommand([...args, '--expires-at', request.expiresAt]), {
      code: 'USAGE',
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
