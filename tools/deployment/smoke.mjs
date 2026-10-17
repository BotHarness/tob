import assert from 'node:assert/strict';
import { resolveTarget } from './target.ts';

const target = resolveTarget('uat', process.env);
const origin = new URL(process.env.PUBLIC_BASE_URL ?? '');
assert.equal(origin.protocol, 'https:');
assert.equal(origin.origin, process.env.PUBLIC_BASE_URL);
assert.equal(origin.username + origin.password, '');
const attempts = 6;
for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    const get = async (path, method = 'GET') => {
      const r = await fetch(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(10000) });
      return { status: r.status, body: await r.json() };
    };
    const health = await get('/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { service: 'tob', environment: 'uat', instanceId: target.instanceId, releaseSha: target.releaseSha, businessEnabled: false });
    const ready = await get('/readyz');
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body, { ready: true, releaseSha: target.releaseSha, d1SchemaVersion: 2, orgSchemaVersion: 1, businessEnabled: false });
    const refusal = await get('/api/organizations', 'POST');
    assert.equal(refusal.status, 503);
    assert.equal(refusal.body.error.code, 'FEATURE_NOT_AVAILABLE');
    const anonymous = await get('/api/me');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, 'UNAUTHENTICATED');
    console.log(JSON.stringify({ event: 'uat_smoke_passed', releaseSha: target.releaseSha, health: true, d1: true, orgDo: true, businessCommandsClosed: true }));
    break;
  } catch {
    if (attempt === attempts) { console.error('UAT_SMOKE_FAILED'); process.exitCode = 1; break; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
