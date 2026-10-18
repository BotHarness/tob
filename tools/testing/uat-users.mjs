import assert from 'node:assert/strict';
import { authenticateUser } from './authenticate-user.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { privateProfile, jsonRequest } from '../auth/private-profile.mjs';
import { parseInstance, connectionKey } from '../../packages/contracts/instance.ts';
import { checkDiscovery } from '../../packages/client/connection.ts';
import { verifyHumanToken } from '../../packages/client/workos.ts';
import { Store, digest } from '../../apps/cli/lib/store.ts';

// Dedicated synthetic UAT fixtures. Not a product login or a Hosted UI test.
let phase = 'inputs';
try {
  const [profilePath, directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 4); assert.ok(isAbsolute(directory));
  for (let path = directory;; path = dirname(path)) {
    if (existsSync(path)) assert.equal(lstatSync(path).isSymbolicLink(), false);
    if (dirname(path) === path) break;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const privateCheck = path => { const s = lstatSync(path); assert.equal(s.uid, process.getuid()); assert.equal(s.mode & 0o077, 0); assert.equal(s.isSymbolicLink(), false); };
  privateCheck(directory);
  const p = privateProfile(profilePath), t = p.json('uat-target.json');
  const config = parseInstance(p.json('tob-instance.json'));
  assert.equal(config.environment, 'uat'); assert.equal(t.INSTANCE_ID, 'tob-instance-uat');
  assert.equal(t.WORKER_NAME, 'tob-service-uat');
  assert.equal(config.server, t.PUBLIC_BASE_URL); assert.equal(config.instanceId, t.INSTANCE_ID); assert.equal(config.auth.clientId, t.WORKOS_CLIENT_ID);
  const bootstrap = p.json('bootstrap-target.json');
  assert.equal(bootstrap.environmentId, t.WORKOS_ENVIRONMENT_ID); assert.equal(bootstrap.clientId, t.WORKOS_CLIENT_ID);
  const health = await jsonRequest(config.server + '/healthz');
  assert.equal(health.environment, 'uat'); assert.equal(health.instanceId, config.instanceId);
  await checkDiscovery(config);
  const key = p.env('secrets.env').WORKOS_API_KEY;
  const api = (path, body) => jsonRequest('https://api.workos.com' + path, { headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const save = (path, value) => { if (existsSync(path)) privateCheck(path); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };
  const recordPath = join(directory, 'fixtures.json');
  let record;
  if (existsSync(recordPath)) { privateCheck(recordPath); record = JSON.parse(readFileSync(recordPath, 'utf8')); }
  else {
    const run = randomUUID();
    record = { instanceId: config.instanceId, run, users: ['a', 'b'].map(label => ({ label, email: `tob-uat-${run}-${label}@example.test`, password: randomUUID() + 'Aa9!' })) };
    save(recordPath, record); // Lost create response is resolved by exact email lookup.
  }
  assert.equal(record.instanceId, config.instanceId);
  for (const user of record.users) {
    assert.ok(['a', 'b'].includes(user.label));
    assert.equal(user.email, `tob-uat-${record.run}-${user.label}@example.test`);
    phase = 'user-' + user.label;
    const found = await api('/user_management/users?' + new URLSearchParams({ email: user.email }));
    assert.ok(Array.isArray(found.data) && found.data.length <= 1 && !found.list_metadata?.after);
    const actual = found.data[0] ?? await api('/user_management/users', { email: user.email, password: user.password, email_verified: true, first_name: 'TOB UAT ' + user.label.toUpperCase(), external_id: record.run + '-' + user.label });
    assert.equal(actual.email, user.email); assert.equal(actual.email_verified, true); assert.equal(actual.external_id, record.run + '-' + user.label);
    user.userId = actual.id; save(recordPath, record);
    const store = new Store(join(directory, 'cli-' + user.label)); store.putConfig(config);
    if (!store.session(config.instanceId)) {
      phase = 'session-' + user.label;
      const login = await authenticateUser({ clientId: config.auth.clientId, key, email: user.email, password: user.password });
      const identity = await verifyHumanToken('Bearer ' + login.access_token, config.auth.clientId, config.auth.issuer);
      assert.equal(identity.userId, user.userId); assert.ok(login.refresh_token);
      store.putSession(config.instanceId, { version: 1, binding: digest(connectionKey(config)), userId: identity.userId, accessToken: login.access_token, refreshToken: login.refresh_token });
    }
  }
  console.log(JSON.stringify({ prepared: true, users: record.users.length, environment: 'uat', authentication: 'dedicated-synthetic-password-sessions', hostedUiTest: false, secretsPrinted: false }));
} catch {
  console.error(JSON.stringify({ prepared: false, phase, code: 'UAT_FIXTURE_UNCONFIRMED' })); process.exitCode = 1;
}
