import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveTarget } from './target.ts';

// Every cloud mutation uses the same explicit target; provisioning is separate.
const target = resolveTarget('uat', process.env);
assert.ok(process.env.CLOUDFLARE_API_TOKEN, 'MISSING_CLOUDFLARE_API_TOKEN');
const origin = new URL(process.env.PUBLIC_BASE_URL ?? '');
assert.equal(origin.protocol, 'https:');
assert.equal(origin.origin, process.env.PUBLIC_BASE_URL);
assert.equal(origin.username + origin.password, '');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), target.releaseSha, 'CHECKOUT_MISMATCH');
execFileSync('git', ['diff', '--exit-code', 'HEAD'], { stdio: 'pipe' });
const cf = './node_modules/.bin/cf';
function read(args) { return JSON.parse(execFileSync(cf, [...args, '--mode', 'uat'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
try {
  // Independently confirm the configured issuer and key source before mutations.
  const discoveryResponse = await fetch(`https://api.workos.com/user_management/${target.workosClientId}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.ok(discoveryResponse.ok, 'WORKOS_DISCOVERY_FAILED');
  const discovery = await discoveryResponse.json();
  assert.equal(discovery.issuer, target.workosIssuer, 'WORKOS_ISSUER_MISMATCH');
  assert.equal(discovery.jwks_uri, `https://api.workos.com/sso/jwks/${target.workosClientId}`, 'WORKOS_JWKS_MISMATCH');
  const account = read(['accounts', 'get']);
  assert.equal(account.id, target.accountId, 'ACCOUNT_MISMATCH');
  const db = read(['d1', 'get', target.databaseId]);
  assert.equal(db.uuid, target.databaseId, 'DATABASE_MISMATCH');
  assert.equal(db.name, 'tob-instance-uat', 'DATABASE_NAME_MISMATCH');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, 'SUBDOMAIN_READ_FAILED');
  const subdomain = await response.json();
  assert.equal(subdomain.success, true, 'SUBDOMAIN_READ_FAILED');
  assert.equal(origin.origin, `https://${target.workerName}.${subdomain.result.subdomain}.workers.dev`, 'ORIGIN_MISMATCH');
  // Build before the first mutation. Do not let cf provision an unresolved D1.
  execFileSync(cf, ['build', '--mode', 'uat'], { stdio: 'inherit' });
  const built = JSON.parse(readFileSync('.cloudflare/output/v0/workers/default/worker.config.json', 'utf8'));
  assert.equal(built.name, target.workerName);
  assert.equal(built.env.INSTANCE_DB.id, target.databaseId);
  assert.equal(built.env.RELEASE_SHA.value, target.releaseSha);
  execFileSync(cf, ['d1', 'migrations', 'apply', target.databaseId, '--dir', 'apps/service/db/d1/migrations', '--mode', 'uat'], { stdio: 'inherit' });
  execFileSync(cf, ['deploy', '--prebuilt', '--mode', 'uat', '--no-provision', '--tag', target.releaseSha], { stdio: 'inherit' });
} catch {
  // cf output is permitted only for build/deploy commands with no runtime secrets.
  // Preflight reads and errors are kept bounded; never dump environment objects.
  console.error('UAT_DEPLOY_FAILED: inspect completed phase; read back before retrying');
  process.exitCode = 1;
}
