import assert from 'node:assert/strict';
import { writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { privateProfile, jsonRequest } from '../auth/private-profile.mjs';
import { publicInstance, connectionKey, parseInstance } from '../../packages/contracts/instance.ts';
let phase='inputs';
try {
  const dir=process.argv[2],p=privateProfile(dir),c=p.json('uat-target.json');
  // Explicit operator confirmation of a fresh authenticated WorkOS MCP read.
  // This is not a credential or a proof trusted by importing clients.
  assert.equal(process.argv[3],'--confirmed-workos-environment');
  assert.equal(process.argv[4],c.WORKOS_ENVIRONMENT_ID);
  assert.equal(c.WORKER_NAME,'tob-service-uat');assert.equal(c.INSTANCE_ID,'tob-instance-uat');
  const cf=path=>jsonRequest(`https://api.cloudflare.com/client/v4/accounts/${c.CLOUDFLARE_ACCOUNT_ID}${path}`,{headers:{Authorization:'Bearer '+p.env('ci-secrets.env').CLOUDFLARE_API_TOKEN}});
  phase='cloudflare-control-plane';
  const settings=await cf(`/workers/scripts/${c.WORKER_NAME}/settings`);
  assert.equal(settings.success,true);
  for(const name of ['INSTANCE_ID','PUBLIC_BASE_URL','WORKOS_CLIENT_ID','WORKOS_ISSUER','WORKOS_AUTH_DOMAIN','WORKOS_ENVIRONMENT_ID']) assert.equal(settings.result.bindings.find(b=>b.name===name)?.text,c[name]);
  const subdomain=await cf('/workers/subdomain');
  assert.equal(c.PUBLIC_BASE_URL,`https://${c.WORKER_NAME}.${subdomain.result.subdomain}.workers.dev`);
  phase='workos-discovery';
  const oidc=await jsonRequest(`https://api.workos.com/user_management/${c.WORKOS_CLIENT_ID}/.well-known/openid-configuration`);
  assert.equal(oidc.issuer,c.WORKOS_ISSUER);assert.equal(oidc.jwks_uri,`https://api.workos.com/sso/jwks/${c.WORKOS_CLIENT_ID}`);
  const document=publicInstance({instanceId:c.INSTANCE_ID,environment:'uat',server:c.PUBLIC_BASE_URL,clientId:c.WORKOS_CLIENT_ID,issuer:c.WORKOS_ISSUER,authkitDomain:c.WORKOS_AUTH_DOMAIN});
  phase='service-discovery';
  assert.equal(connectionKey(parseInstance(await jsonRequest(c.PUBLIC_BASE_URL+'/.well-known/open-cloud-groups'))),connectionKey(document));
  // Only explicit public fields are exported. No key, user identity or cloud resource IDs.
  phase='write-public-file';
  const temp=join(dir,'tob-instance.next.json');
  try { writeFileSync(temp,JSON.stringify(document,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,join(dir,'tob-instance.json')); }
  finally {if(existsSync(temp)) unlinkSync(temp);}
  console.log(JSON.stringify({exported:true,file:join(dir,'tob-instance.json'),environment:'uat',workosControlPlaneConfirmationRequired:true}));
}catch{console.error(JSON.stringify({event:'instance_export_failed',phase}));process.exitCode=1;}
