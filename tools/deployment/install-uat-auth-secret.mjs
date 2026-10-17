import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { privateProfile, jsonRequest } from '../auth/private-profile.mjs';
let phase='inputs';
try {
  const p=privateProfile(process.argv[2]),c=p.json('uat-target.json'),b=p.json('bootstrap-target.json');
  assert.equal(c.WORKER_NAME,'tob-service-uat');assert.equal(c.INSTANCE_ID,'tob-instance-uat');
  assert.equal(c.WORKOS_ENVIRONMENT_ID,b.environmentId);assert.equal(c.WORKOS_CLIENT_ID,b.clientId);
  const key=p.env('secrets.env').WORKOS_API_KEY,cfKey=p.env('ci-secrets.env').CLOUDFLARE_API_TOKEN;
  assert.ok(key);assert.ok(cfKey);
  const cf=path=>jsonRequest(`https://api.cloudflare.com/client/v4/accounts/${c.CLOUDFLARE_ACCOUNT_ID}${path}`,{headers:{Authorization:'Bearer '+cfKey}});
  phase='target-readback';
  const settings=await cf(`/workers/scripts/${c.WORKER_NAME}/settings`);assert.equal(settings.success,true);
  for(const name of ['INSTANCE_ID','WORKOS_CLIENT_ID','WORKOS_ENVIRONMENT_ID'])assert.equal(settings.result.bindings.find(v=>v.name===name)?.text,c[name]);
  assert.equal(settings.result.bindings.find(v=>v.name==='INSTANCE_DB')?.id,c.INSTANCE_DB_ID);
  const invitation=await jsonRequest(`https://api.workos.com/user_management/invitations/${b.invitationId}`,{headers:{Authorization:'Bearer '+key}});
  assert.equal(invitation.state,'accepted');assert.ok(invitation.accepted_user_id);
  phase='inject-worker-secret';
  // Values go only over stdin; cf output/errors are captured, never echoed.
  execFileSync('./node_modules/.bin/cf',['workers','secrets','bulk','--worker',c.WORKER_NAME,'--file','/dev/stdin'],{input:JSON.stringify({secrets:{WORKOS_API_KEY:{type:'secret_text',text:key}}}),env:{...process.env,CLOUDFLARE_ACCOUNT_ID:c.CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_API_TOKEN:cfKey,CF_SEND_TELEMETRY:'false'},stdio:['pipe','pipe','pipe']});
  phase='secret-metadata-readback';
  const after=await cf(`/workers/scripts/${c.WORKER_NAME}/settings`);
  assert.equal(after.result.bindings.find(v=>v.name==='WORKOS_API_KEY')?.type,'secret_text');
  console.log(JSON.stringify({event:'uat_auth_secret_installed',secretMetadataVerified:true,valueNotReadBack:true,runtimeRevocationStillRequiresProof:true}));
}catch{console.error(JSON.stringify({event:'uat_auth_secret_install_unconfirmed',phase,action:'read back before retry'}));process.exitCode=1;}
