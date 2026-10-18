import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticateUser } from '../tools/testing/authenticate-user.mjs';
const input={clientId:'client_fixture',key:'private-key',email:'fixture@example.test',password:'private-password'};
test('synthetic UAT login finishes provider organization selection without leaking or inventing a membership',async()=>{
 const calls: Record<string,string>[]=[];
 const request: typeof fetch=async(url,init)=>{
  assert.ok(init);
  assert.equal(String(url),'https://api.workos.com/user_management/authenticate');assert.equal(init.redirect,'error');
  calls.push(JSON.parse(String(init.body)));
  return calls.length===1?Response.json({code:'organization_selection_required',pending_authentication_token:'private-pending',organizations:[{id:'org_b'},{id:'org_a'}]},{status:403}):Response.json({access_token:'private-access',refresh_token:'private-refresh'});
 };
 const result=await authenticateUser(input,request);assert.equal(result.access_token,'private-access');
 assert.equal(calls[1].organization_id,'org_a');assert.equal(calls[1].grant_type,'urn:workos:oauth:grant-type:organization-selection');
 assert.equal(calls[1].pending_authentication_token,'private-pending');assert.equal(calls[1].password,undefined);
});
test('synthetic login never treats another authentication challenge as an organization choice',async()=>{
 let calls=0;await assert.rejects(authenticateUser(input,async()=>{calls++;return Response.json({code:'mfa_challenge'},{status:403});}),/SYNTHETIC_AUTHENTICATION_FAILED/);assert.equal(calls,1);
});
