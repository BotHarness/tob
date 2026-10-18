import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../../apps/cli/lib/store.ts';
import { readAgentFile, readPrivateJson } from '../../apps/cli/lib/agent.ts';
import { ClientError, connectionKey } from '../contracts/instance.ts';
import {
  parseWorkRequest,
  parseWorkMessage,
  parseWorkResult,
  type WorkRequest,
  type WorkResult,
} from '../contracts/work.ts';
import { checkDiscovery, request, responseJson } from '../client/connection.ts';

export type HealthPolicy = {
  version: 1;
  binding: string;
  actorId: string;
  channelId: string;
  environment: string;
  allowedUsers: string[];
};
function parsePolicy(value: unknown): HealthPolicy {
  const p = value as HealthPolicy;
  if (
    !p ||
    p.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(p.binding) ||
    !/^ag_[a-f0-9]{64}$/.test(p.actorId) ||
    !/^ch_[a-f0-9]{64}$/.test(p.channelId) ||
    !/^[A-Za-z0-9_. -]{1,64}$/.test(p.environment) ||
    !Array.isArray(p.allowedUsers) ||
    p.allowedUsers.length > 100 ||
    p.allowedUsers.some((u) => typeof u !== 'string' || !/^user_[A-Za-z0-9]+$/.test(u)) ||
    new Set(p.allowedUsers).size !== p.allowedUsers.length ||
    Object.keys(p).some(
      (k) =>
        !['version', 'binding', 'actorId', 'channelId', 'environment', 'allowedUsers'].includes(k),
    )
  )
    throw new ClientError('INVALID_LOCAL_POLICY');
  return p;
}
export class HealthLedger {
  readonly store: Store;
  readonly db: DatabaseSync;
  constructor(directory: string, binding: string) {
    this.store = new Store(directory);
    const path = join(this.store.root, 'health.sqlite');
    if (!existsSync(path)) {
      const fd = openSync(path, 'wx', 0o600);
      closeSync(fd);
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.uid !== process.getuid!() || s.mode & 0o077)
        throw new ClientError('PRIVATE_LEDGER_REQUIRED');
    } finally {
      closeSync(fd);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL); CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,execution_count INTEGER NOT NULL DEFAULT 0,result TEXT);',
    );
    this.db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?)').run(binding);
    if (this.db.prepare('SELECT binding FROM identity WHERE id=1').get()?.binding !== binding) {
      this.db.close();
      throw new ClientError('LEDGER_TARGET_MISMATCH');
    }
  }
  row(id: string) {
    const r = this.db.prepare('SELECT * FROM work WHERE id=?').get(id);
    return r as
      | {
          id: string;
          payload: string;
          state: string;
          execution_count: number;
          result: string | null;
        }
      | undefined;
  }
  claim(r: WorkRequest) {
    this.db
      .prepare("INSERT INTO work (id,payload,state) VALUES (?,?,'started')")
      .run(r.requestId, JSON.stringify(r));
  }
  executed(id: string) {
    const update = this.db
      .prepare(
        "UPDATE work SET execution_count=execution_count+1 WHERE id=? AND state='started' AND execution_count=0",
      )
      .run(id);
    if (update.changes !== 1) throw new ClientError('WORK_ALREADY_STARTED');
  }
  save(r: WorkRequest, result: WorkResult) {
    this.db
      .prepare(
        "INSERT INTO work (id,payload,state,execution_count,result) VALUES (?,?,'outbox',?,?) ON CONFLICT(id) DO UPDATE SET state='outbox',result=excluded.result",
      )
      .run(r.requestId, JSON.stringify(r), result.executionCount, JSON.stringify(result));
  }
  finish(id: string) {
    this.db.prepare("UPDATE work SET state='finished' WHERE id=? AND state='outbox'").run(id);
  }
  close() {
    this.db.close();
  }
}
export type HealthTransport = {
  authorize: (r: WorkRequest) => Promise<WorkRequest>;
  send: (r: WorkResult) => Promise<void>;
};
export async function processHealthRequest(
  ledger: HealthLedger,
  requestValue: WorkRequest,
  policy: () => HealthPolicy,
  transport: HealthTransport,
  hooks: { afterClaim?: () => void; afterExecute?: () => void; now?: () => number } = {},
) {
  const r = parseWorkRequest(requestValue),
    now = hooks.now ?? Date.now;
  const initial = policy();
  if (r.targetActorId !== initial.actorId || r.channelId !== initial.channelId)
    throw new ClientError('WORK_TARGET_MISMATCH');
  const old = ledger.row(r.requestId);
  if (old && old.payload !== JSON.stringify(r)) throw new ClientError('WORK_REQUEST_CONFLICT');
  if (old?.state === 'finished')
    return { executed: 0, replayed: true, state: parseWorkResult(JSON.parse(old.result!)).state };
  let result: WorkResult;
  const rejection = (reason: WorkResult['reason']): WorkResult => ({
    version: 1,
    requestId: r.requestId,
    state: 'rejected',
    environment: initial.environment,
    executionCount: 0,
    reason,
  });
  if (old?.state === 'outbox') result = parseWorkResult(JSON.parse(old.result!));
  else if (old?.state === 'started')
    result = {
      version: 1,
      requestId: r.requestId,
      state: 'needs-review',
      environment: initial.environment,
      executionCount: old.execution_count,
      reason: 'INTERRUPTED_EXECUTION',
    };
  else {
    let denied: WorkResult | undefined;
    if (!initial.allowedUsers.includes(r.requesterUserId))
      denied = rejection('LOCAL_POLICY_DENIED');
    else if (Date.parse(r.expiresAt) <= now()) denied = rejection('REQUEST_EXPIRED');
    else {
      try {
        if (JSON.stringify(parseWorkRequest(await transport.authorize(r))) !== JSON.stringify(r))
          throw new ClientError('WORK_REQUEST_CONFLICT');
      } catch (e) {
        if (
          e instanceof ClientError &&
          ['REQUEST_EXPIRED', 'REQUESTER_ACCESS_DENIED'].includes(e.code)
        )
          denied = rejection(e.code as WorkResult['reason']);
        else throw e;
      }
    }
    const current = policy();
    if (
      current.actorId !== initial.actorId ||
      current.channelId !== initial.channelId ||
      current.binding !== initial.binding ||
      current.environment !== initial.environment
    )
      throw new ClientError('LOCAL_POLICY_CHANGED');
    if (!current.allowedUsers.includes(r.requesterUserId))
      denied = rejection('LOCAL_POLICY_DENIED');
    if (!denied && Date.parse(r.expiresAt) <= now()) denied = rejection('REQUEST_EXPIRED');
    if (denied) result = denied;
    else {
      ledger.claim(r);
      hooks.afterClaim?.();
      ledger.executed(r.requestId);
      result = {
        version: 1,
        requestId: r.requestId,
        state: 'completed',
        environment: current.environment,
        executionCount: 1,
        reason: 'OK',
        diagnostics: {
          platform: process.platform,
          architecture: process.arch,
          runtime: process.version,
        },
      };
      hooks.afterExecute?.();
    }
  }
  parseWorkResult(result);
  ledger.save(r, result);
  await transport.send(result);
  ledger.finish(r.requestId);
  return { executed: old ? 0 : result.executionCount, replayed: !!old, state: result.state };
}
function bindingFor(c: ReturnType<typeof readAgentFile>) {
  return digest(JSON.stringify([connectionKey(c.config), c.actorId, c.channelId]));
}
export async function configureHealth(
  credentialFile: string,
  directory: string,
  environment: string,
  allowedUsers: string[],
) {
  const c = readAgentFile(credentialFile),
    binding = bindingFor(c);
  const store = new Store(directory);
  const value = parsePolicy({
    version: 1,
    binding,
    actorId: c.actorId,
    channelId: c.channelId,
    environment,
    allowedUsers,
  });
  await store.locked('health-run', async () => {
    const file = join(store.root, 'policy.json');
    if (existsSync(file)) {
      const old = parsePolicy(readPrivateJson(file));
      if (old.binding !== binding) throw new ClientError('LOCAL_POLICY_TARGET_MISMATCH');
    }
    const temp = file + '.' + randomUUID();
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, file);
      const dir = openSync(store.root, 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  });
  return {
    configured: true,
    actorId: c.actorId,
    channelId: c.channelId,
    environment,
    allowedUsers,
    capability: 'health-check',
  };
}
export async function runHealthOnce(credentialFile: string, directory: string, after = 0) {
  if (!Number.isSafeInteger(after) || after < 0) throw new ClientError('INVALID_CURSOR');
  const c = readAgentFile(credentialFile),
    binding = bindingFor(c),
    store = new Store(directory);
  return store.locked('health-run', async () => {
    const policy = () => {
      const p = parsePolicy(readPrivateJson(join(store.root, 'policy.json')));
      if (p.binding !== binding || p.actorId !== c.actorId || p.channelId !== c.channelId)
        throw new ClientError('LOCAL_POLICY_TARGET_MISMATCH');
      return p;
    };
    policy();
    const ledger = new HealthLedger(directory, binding);
    const base = c.config.server + '/api/agent-channels/' + c.channelId;
    const call = async (path: string, body?: unknown) => {
      await checkDiscovery(c.config);
      const res = await request(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer tob_agent_' + c.actorId + '.' + c.secret,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await responseJson(res);
      if (!res.ok) {
        const code = (value.error as { code?: unknown })?.code;
        throw new ClientError(
          typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'WORK_UNAVAILABLE',
        );
      }
      return value;
    };
    try {
      const page = await call('/messages?after=' + after);
      if (
        !Array.isArray(page.messages) ||
        page.messages.length > 50 ||
        !Number.isSafeInteger(page.nextCursor) ||
        Number(page.nextCursor) < after ||
        typeof page.hasMore !== 'boolean'
      )
        throw new ClientError('INVALID_RESPONSE');
      let executed = 0,
        processed = 0;
      for (const m of page.messages) {
        if (m.kind !== 'work_request') continue;
        const r = parseWorkMessage(m);
        if (r.channelId !== c.channelId) throw new ClientError('INVALID_WORK_MESSAGE');
        if (r.targetActorId !== c.actorId) continue;
        const result = await processHealthRequest(ledger, r, policy, {
          authorize: async (req) =>
            parseWorkRequest(
              (await call('/work-requests/' + req.requestId + '/authorize', {})).request,
            ),
          send: async (result) => {
            const sent = await call('/work-requests/' + result.requestId + '/result', result);
            const message = sent.message as {
              authorId?: unknown;
              kind?: unknown;
              payload?: unknown;
            };
            if (
              message?.authorId !== c.actorId ||
              message.kind !== 'work_result' ||
              JSON.stringify(parseWorkResult(message.payload)) !== JSON.stringify(result)
            )
              throw new ClientError('INVALID_WORK_RESULT');
          },
        });
        executed += result.executed;
        processed++;
      }
      return {
        actorId: c.actorId,
        processed,
        executed,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    } finally {
      ledger.close();
    }
  });
}
export async function healthCommand(args: string[]) {
  const command = args[1],
    options: Record<string, string> = {};
  let confirm = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--confirm') {
      if (confirm) throw new ClientError('USAGE');
      confirm = true;
      continue;
    }
    if (
      !['--credential-file', '--state-dir', '--environment', '--allow-users', '--after'].includes(
        args[i],
      ) ||
      options[args[i]] !== undefined ||
      args[i + 1] === undefined
    )
      throw new ClientError('USAGE');
    const name = args[i];
    options[name] = args[++i];
  }
  if (!options['--credential-file'] || !options['--state-dir']) throw new ClientError('USAGE');
  if (command === 'configure') {
    if (options['--after'] !== undefined) throw new ClientError('USAGE');
    if (!confirm || !options['--environment'] || options['--allow-users'] === undefined)
      throw new ClientError('CONFIRM_LOCAL_POLICY_REQUIRED');
    return configureHealth(
      options['--credential-file'],
      options['--state-dir'],
      options['--environment'],
      options['--allow-users'] ? options['--allow-users'].split(',') : [],
    );
  }
  if (
    command !== 'run' ||
    confirm ||
    options['--environment'] ||
    options['--allow-users'] !== undefined ||
    !/^(0|[1-9][0-9]*)$/.test(options['--after'] ?? '0')
  )
    throw new ClientError('USAGE');
  return runHealthOnce(
    options['--credential-file'],
    options['--state-dir'],
    Number(options['--after'] ?? 0),
  );
}
