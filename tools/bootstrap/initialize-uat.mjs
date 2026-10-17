import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateProfile, jsonRequest } from '../auth/private-profile.mjs';
import { INITIALIZE_SQL, checkReceipt, checkInvitee } from './contract.ts';
let phase = "inputs";
try {
  const profile = privateProfile(process.argv[2]);
  // Explicit control-plane eligibility check: WorkOS GET user does not expose
  // banned status. The deployment operator must first read it through MCP.
  assert.equal(process.argv[3], '--confirmed-active-user');
  const confirmedUser = process.argv[4];
  const target = profile.json('uat-target.json');
  const bootstrap = profile.json('bootstrap-target.json');
  assert.equal(target.WORKER_NAME, 'tob-service-uat');
  assert.equal(target.INSTANCE_ID, 'tob-instance-uat');
  assert.equal(target.WORKOS_ENVIRONMENT_ID, bootstrap.environmentId);
  assert.equal(target.WORKOS_CLIENT_ID, bootstrap.clientId);
  const cfToken = profile.env('ci-secrets.env').CLOUDFLARE_API_TOKEN;
  const workosKey = profile.env('secrets.env').WORKOS_API_KEY;
  const workos = path => jsonRequest('https://api.workos.com/user_management/' + path, { headers: { Authorization: 'Bearer ' + workosKey } });
  const cf = (path, body) => jsonRequest('https://api.cloudflare.com/client/v4/accounts/' + target.CLOUDFLARE_ACCOUNT_ID + path, { headers: { Authorization: 'Bearer ' + cfToken, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  phase = 'workos-invitee';
  const invitation = await workos('invitations/' + encodeURIComponent(bootstrap.invitationId));
  assert.equal(invitation.state, 'accepted');
  assert.equal(invitation.organization_id, null);
  assert.ok(invitation.accepted_user_id);
  const user = await workos('users/' + encodeURIComponent(invitation.accepted_user_id));
  checkInvitee(invitation, user, bootstrap.expectedEmail, confirmedUser);
  phase = 'cloudflare-target';
  const database = await cf('/d1/database/' + target.INSTANCE_DB_ID);
  assert.equal(database.result.uuid, target.INSTANCE_DB_ID);
  assert.equal(database.result.name, 'tob-instance-uat');
  const settings = await cf('/workers/scripts/' + target.WORKER_NAME + '/settings');
  const binding = name => settings.result.bindings.find(b => b.name === name);
  assert.equal(binding('INSTANCE_DB').id, target.INSTANCE_DB_ID);
  for (const name of ['INSTANCE_ID', 'WORKOS_CLIENT_ID', 'WORKOS_ENVIRONMENT_ID', 'WORKOS_ISSUER']) assert.equal(binding(name).text, target[name]);
  const subdomain = await cf('/workers/subdomain');
  assert.equal(target.PUBLIC_BASE_URL, `https://${target.WORKER_NAME}.${subdomain.result.subdomain}.workers.dev`);
  const ready = await jsonRequest(target.PUBLIC_BASE_URL + '/readyz');
  assert.equal(ready.d1SchemaVersion, 2);
  const payloadHash = createHash('sha256').update(JSON.stringify([target.CLOUDFLARE_ACCOUNT_ID, target.INSTANCE_DB_ID, target.INSTANCE_ID, bootstrap.environmentId, bootstrap.clientId, user.id])).digest('hex');
  const sql = async (query, params = []) => {
    const result = await cf('/d1/database/' + target.INSTANCE_DB_ID + '/query', { sql: query, params });
    assert.equal(result.success, true);
    assert.equal(result.result[0].success, true);
    return result.result[0].results;
  };
  // One SQL statement + trigger: all checks/writes are atomic in D1.
  // A lost response is resolved by rerunning and reading the same fixed receipt.
  phase = 'atomic-initialization';
  await sql(INITIALIZE_SQL, ['cloudflare-deployer', payloadHash, user.id, new Date().toISOString()]);
  phase = 'receipt-readback';
  const [receipt] = await sql("SELECT * FROM management_operation WHERE operation_id = 'instance.initialize'");
  const [admin] = await sql('SELECT status FROM instance_admin WHERE workos_user_id = ?', [user.id]);
  const [policy] = await sql('SELECT * FROM instance_config WHERE singleton_id = 1');
  checkReceipt(receipt, payloadHash, user.id, admin?.status ?? null, policy?.registration_mode === 'admin_only' && policy?.org_creation_mode === 'admin_only');
  console.log(JSON.stringify({ event: 'first_admin_initialized', sameTargetReplaySafe: true, invitationAccepted: true, verifiedEmailMatches: true }));
} catch { console.error(JSON.stringify({ event: 'admin_initialization_unconfirmed', phase, code: 'READ_BACK_BEFORE_RETRY' })); process.exitCode = 1; }
