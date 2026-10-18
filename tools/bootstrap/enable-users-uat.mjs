import assert from 'node:assert/strict';
import { privateProfile, jsonRequest } from '../auth/private-profile.mjs';

// Protected deployment operator command, not a public administration endpoint.
// Does not change WorkOS signup, grant administrator roles, or touch Prod.
let phase = 'inputs';
try {
  assert.equal(process.argv.length, 4);
  assert.equal(process.argv[3], '--confirm-multi-user');
  const profile = privateProfile(process.argv[2]);
  const t = profile.json('uat-target.json');
  assert.equal(t.WORKER_NAME, 'tob-service-uat');
  assert.equal(t.INSTANCE_ID, 'tob-instance-uat');
  const token = profile.env('ci-secrets.env').CLOUDFLARE_API_TOKEN;
  const cf = (path, body) => jsonRequest(`https://api.cloudflare.com/client/v4/accounts/${t.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  phase = 'target';
  const db = await cf('/d1/database/' + t.INSTANCE_DB_ID);
  assert.equal(db.result.uuid, t.INSTANCE_DB_ID);
  assert.equal(db.result.name, 'tob-instance-uat');
  const settings = await cf(`/workers/scripts/${t.WORKER_NAME}/settings`);
  const binding = name => settings.result.bindings.find(b => b.name === name);
  assert.equal(binding('INSTANCE_DB').id, t.INSTANCE_DB_ID);
  for (const name of ['INSTANCE_ID', 'WORKOS_CLIENT_ID', 'WORKOS_ENVIRONMENT_ID']) assert.equal(binding(name).text, t[name]);
  const subdomain = await cf('/workers/subdomain');
  assert.equal(t.PUBLIC_BASE_URL, `https://${t.WORKER_NAME}.${subdomain.result.subdomain}.workers.dev`);
  const ready = await jsonRequest(t.PUBLIC_BASE_URL + '/readyz');
  assert.equal(ready.d1SchemaVersion, 4);
  const sql = async (query, params = []) => {
    const r = await cf('/d1/database/' + t.INSTANCE_DB_ID + '/query', { sql: query, params });
    assert.equal(r.success, true); assert.equal(r.result[0].success, true);
    return r.result[0].results;
  };
  phase = 'initialization';
  const [initialized] = await sql("SELECT a.status FROM management_operation m JOIN instance_admin a ON a.workos_user_id=m.target_id WHERE m.operation_id='instance.initialize' AND m.kind='instance.initialize' AND m.state='succeeded'");
  assert.equal(initialized?.status, 'active');
  const [before] = await sql('SELECT * FROM instance_config WHERE singleton_id=1');
  assert.ok(before);
  if (before.registration_mode !== 'authenticated' || before.org_creation_mode !== 'all_users') {
    assert.equal(before.registration_mode, 'admin_only'); assert.equal(before.org_creation_mode, 'admin_only');
    phase = 'policy-write';
    await sql("UPDATE instance_config SET registration_mode='authenticated',org_creation_mode='all_users',config_version=config_version+1 WHERE singleton_id=1 AND config_version=? AND registration_mode='admin_only' AND org_creation_mode='admin_only'", [before.config_version]);
  }
  phase = 'readback';
  const [after] = await sql('SELECT * FROM instance_config WHERE singleton_id=1');
  assert.equal(after.registration_mode, 'authenticated'); assert.equal(after.org_creation_mode, 'all_users');
  console.log(JSON.stringify({ event: 'uat_multi_user_enabled', configVersion: after.config_version, registrationProviderUnchanged: true, adminBindingUnchanged: true }));
} catch {
  console.error(JSON.stringify({ event: 'uat_multi_user_unconfirmed', phase, code: 'READ_BACK_BEFORE_RETRY' })); process.exitCode = 1;
}
