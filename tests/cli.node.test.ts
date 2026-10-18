import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync, chmodSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { execute, type Runtime } from '../apps/cli/lib/commands.ts';
import { Store } from '../apps/cli/lib/store.ts';
import { publicInstance, type InstanceConfig } from '../packages/contracts/instance.ts';
let keys: Awaited<ReturnType<typeof generateKeyPair>>, jwk: Awaited<ReturnType<typeof exportJWK>>;
const originalFetch=globalThis.fetch;
let root: string, input: string, config: InstanceConfig, discovery: InstanceConfig, rt: Runtime, requests: {url:string;init?:RequestInit}[], prompts: unknown[], serial: number;
let orgSelected: string | undefined;
let refreshStatus: number, logoutStatus: number, deny: boolean, pending: string[], exchangePause: Promise<void>|undefined, badIssuer: boolean;
const access=async(exp=300)=>new SignJWT({sub:'user_fixture',sid:'session_fixture',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+exp,iss:badIssuer?'https://api.workos.com/':config.auth.issuer,jti:String(++serial),...(orgSelected ? {org_id:orgSelected} : {})}).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(keys.privateKey);
before(async()=>{keys=await generateKeyPair('RS256');jwk={...await exportJWK(keys.publicKey),kid:'fixture',alg:'RS256'};});
after(()=>{globalThis.fetch=originalFetch;});
beforeEach(()=>{
 root=mkdtempSync(join(realpathSync(tmpdir()),'tob-cli-test-'));input=join(root,'instance.json');
 config=publicInstance({instanceId:'test-instance',environment:'uat',server:'https://groups.example',clientId:'client_fixture',issuer:'https://api.workos.com/user_management/client_fixture',authkitDomain:'fixture.authkit.app'});
 orgSelected=undefined;discovery=structuredClone(config);writeFileSync(input,JSON.stringify(config));requests=[];prompts=[];serial=0;refreshStatus=200;logoutStatus=200;deny=false;pending=[];exchangePause=undefined;badIssuer=false;
 rt={directory:join(root,'private'),prompt:v=>prompts.push(v),wait:async()=>{}};
 globalThis.fetch=async(url,init)=>{
  const u=String(url);requests.push({url:u,init});
  if(u.endsWith('/.well-known/open-cloud-groups'))return Response.json(discovery);
  if(u===config.auth.jwksUri)return Response.json({keys:[jwk]});
  if(u===config.auth.deviceAuthorizationEndpoint)return Response.json({device_code:'private-device-code',user_code:'TEST-CODE',verification_uri:'https://fixture.authkit.app/device',interval:5,expires_in:300});
  if(u===config.auth.tokenEndpoint){
   const form=new URLSearchParams(String(init?.body));
   if(form.get('grant_type')==='refresh_token'){
    if(form.get('organization_id'))orgSelected=form.get('organization_id')!;
    if(exchangePause)await exchangePause;
    if(refreshStatus!==200)return Response.json({error:refreshStatus===400?'invalid_grant':'temporarily_unavailable'},{status:refreshStatus});
   }else if(deny)return Response.json({error:'access_denied'},{status:400});
   else if(pending.length)return Response.json({error:pending.shift()},{status:400});
   return Response.json({access_token:await access(),refresh_token:'private-refresh-'+serial});
  }
  if(u.endsWith('/api/onboarding'))return Response.json({organizationId:'org_default'});
  if(u.endsWith('/api/me'))return Response.json({userId:'user_fixture',instanceId:config.instanceId,instanceRole:'admin'});
  if(u.endsWith('/api/auth/logout'))return Response.json({remoteRevoked:true},{status:logoutStatus});
  throw new Error('unexpected test request');
 };
});
afterEach(()=>{globalThis.fetch=originalFetch;rmSync(root,{recursive:true,force:true});});
const command=(name:string)=>execute([name,'--server',config.server],rt);
const setup=async()=>{await execute(['instance','import',input],rt);await command('login');};
const state=()=>new Store(rt.directory!).session(config.instanceId);
const fails=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>(e as {code?:string}).code===code);

test('public import → real signed device login → identity → refresh → own logout, with no credentials in output',async()=>{
 const imported=await execute(['instance','import',input],rt);assert.equal(state(),undefined);
 const login=await command('login');const first=state()!;
 assert.equal((login as {instanceRole:string}).instanceRole,'admin');
 assert.deepEqual({ ...await command('whoami') as object, defaultOrganizationId: 'org_default' },login);
 assert.equal((await command('refresh') as {refreshed:boolean}).refreshed,true);
 assert.notEqual(state()!.refreshToken,first.refreshToken);
 assert.equal(statSync(rt.directory!).mode&0o777,0o700);
 for(const area of ['sessions','instances'])for(const file of readdirSync(join(rt.directory!,area)))assert.equal(statSync(join(rt.directory!,area,file)).mode&0o777,0o600);
 assert.deepEqual(await command('logout'),{localLoggedOut:true,remoteRevoked:true});assert.equal(state(),undefined);
 for(const r of requests)if(r.url!==config.auth.jwksUri)assert.equal(r.init?.redirect,'error');
 requests=[];await fails(command('whoami'),'NOT_LOGGED_IN');assert.equal(requests.length,0);
 const output=JSON.stringify([imported,login,prompts]);for(const secret of [first.accessToken,first.refreshToken,'private-device-code'])assert.equal(output.includes(secret),false);
});
test('unknown origin and malformed authentication endpoints fail before networking',async()=>{
 await fails(command('login'),'INSTANCE_NOT_IMPORTED');assert.equal(requests.length,0);
 const bad=structuredClone(config);bad.auth.tokenEndpoint='https://attacker.example/token';writeFileSync(input,JSON.stringify(bad));
 await fails(execute(['instance','import',input],rt),'INVALID_INSTANCE_CONFIG');assert.equal(requests.length,0);
});
test('configuration drift blocks login, refresh and bearer transmission without deleting the session',async()=>{
 await setup();const saved=state();discovery.auth.clientId='client_other';discovery.auth.issuer='https://api.workos.com/user_management/client_other';discovery.auth.jwksUri='https://api.workos.com/sso/jwks/client_other';requests=[];
 await fails(command('refresh'),'INSTANCE_CONFIG_CHANGED');assert.deepEqual(state(),saved);
 assert.ok(requests.every(r=>r.url.endsWith('/.well-known/open-cloud-groups')&&!new Headers(r.init?.headers).has('Authorization')));
 assert.deepEqual(await command('logout'),{localLoggedOut:true,remoteRevoked:false,warning:'REMOTE_LOGOUT_UNCONFIRMED'});assert.equal(state(),undefined);
});
test('reimport is idempotent; a verified replacement explicitly clears only its old session',async()=>{
 await setup();const saved=state();await execute(['instance','import',input],rt);assert.deepEqual(state(),saved);
 config.name='Renamed';writeFileSync(input,JSON.stringify(config));await execute(['instance','import',input],rt);assert.deepEqual(state(),saved);
 config.server='https://replacement.example';orgSelected=undefined;discovery=structuredClone(config);writeFileSync(input,JSON.stringify(config));
 await fails(execute(['instance','import',input],rt),'CONFIG_REPLACEMENT_REQUIRED');assert.deepEqual(state(),saved);
 await execute(['instance','import',input,'--replace'],rt);assert.equal(state(),undefined);
 await fails(execute(['whoami','--server','https://groups.example'],rt),'INSTANCE_NOT_IMPORTED');
});
test('transient refresh failures preserve tokens; invalid_grant clears them',async()=>{
 await setup();const saved=state();refreshStatus=503;
 await fails(command('refresh'),'AUTH_RETRY_REQUIRED');assert.deepEqual(state(),saved);
 refreshStatus=429;await fails(command('refresh'),'AUTH_RETRY_REQUIRED');assert.deepEqual(state(),saved);
 refreshStatus=400;await fails(command('refresh'),'LOGIN_REQUIRED');assert.equal(state(),undefined);
});
test('parallel refresh refuses the second process-shaped operation instead of replaying a rotating token',async()=>{
 await setup();let release!:()=>void;exchangePause=new Promise(resolve=>{release=resolve;});
 const first=command('refresh');await fails(command('refresh'),'SESSION_BUSY');release();await first;
 assert.equal(requests.filter(r=>r.url===config.auth.tokenEndpoint&&String(r.init?.body).includes('grant_type=refresh_token')).length,1);
});
test('expired access token refreshes automatically before identity read',async()=>{
 await setup();const saved=state()!;saved.accessToken=await access(-10);new Store(rt.directory!).putSession(config.instanceId,saved);
 assert.equal((await command('whoami') as {instanceRole:string}).instanceRole,'admin');assert.notEqual(state()!.accessToken,saved.accessToken);
});
test('polling respects pending/slow_down and denial releases the lock',async()=>{
 await execute(['instance','import',input],rt);const delays:number[]=[];rt.wait=async ms=>{delays.push(ms);};pending=['authorization_pending','slow_down'];
 await command('login');assert.deepEqual(delays,[5000,5000,10000]);await command('logout');deny=true;
 await fails(command('login'),'LOGIN_DENIED');assert.equal(state(),undefined);assert.equal(readdirSync(join(rt.directory!,'locks')).length,0);
});
test('cancellation and expiry leave no session or live lock',async()=>{
 await execute(['instance','import',input],rt);const controller=new AbortController();rt.signal=controller.signal;rt.wait=async()=>{controller.abort();};
 await fails(command('login'),'CANCELLED');assert.equal(state(),undefined);assert.equal(readdirSync(join(rt.directory!,'locks')).length,0);
 rt.signal=undefined;let now=0;rt.now=()=>now;rt.wait=async ms=>{now+=ms;};pending=Array(100).fill('authorization_pending');
 await fails(command('login'),'LOGIN_EXPIRED');assert.equal(state(),undefined);
});
test('logout clears local state even when remote revocation is unavailable',async()=>{
 await setup();logoutStatus=503;assert.deepEqual(await command('logout'),{localLoggedOut:true,remoteRevoked:false,warning:'REMOTE_LOGOUT_UNCONFIRMED'});assert.equal(state(),undefined);
});
test('unsafe credential stores and symlink imports are refused',async()=>{
 const store=new Store(rt.directory!);chmodSync(rt.directory!,0o755);assert.throws(()=>new Store(rt.directory!),/INSECURE_CLI_STORE/);chmodSync(rt.directory!,0o700);
 const link=join(root,'link.json');symlinkSync(input,link);await assert.rejects(execute(['instance','import',link],rt));assert.deepEqual(store.configs(),[]);
});
test('validly signed wrong issuer is never sent as an instance bearer',async()=>{
 await execute(['instance','import',input],rt);badIssuer=true;await assert.rejects(command('login'));assert.equal(requests.some(r=>r.url.endsWith('/api/me')),false);
});

test('organization selection uses a separate rotated token and carries only public organization results',async()=>{
 await setup();
 const original=globalThis.fetch;
 const organization={organizationId:'org_mobile',name:'Mobile project',description:'',version:1,role:'owner'};
 const seen: unknown[]=[];
 globalThis.fetch=async(url,init)=>{
  const u=String(url); if(!u.includes('/api/organizations'))return original(url,init);
  seen.push({url:u,method:init?.method});
  if(u.endsWith('/access'))return Response.json({organizationId:organization.organizationId,role:'owner'});
  if(u.endsWith('/org_mobile')){assert.equal(orgSelected,'org_mobile');return Response.json(organization);}
  return Response.json({organizations:[organization],nextCursor:null});
 };
 const org=(...a:string[])=>execute(['org',...a,'--server',config.server],rt);
 assert.deepEqual(await org('list'),{organizations:[organization],nextCursor:null});
 const old=state()!.refreshToken;
 assert.deepEqual(await org('use','--id','org_mobile'),{...organization,selected:true});
 assert.notEqual(state()!.refreshToken,old);
 assert.equal((await command('whoami') as {organizationId:string}).organizationId,'org_mobile');
 assert.deepEqual(await org('show'),organization);
 const output=JSON.stringify(seen);assert.equal(output.includes(state()!.accessToken),false);
 globalThis.fetch=async(url,init)=>String(url).includes('/api/organizations')?Response.json({error:{code:'ORGANIZATION_OWNER_REQUIRED'}},{status:403}):original(url,init);
 await fails(org('update','--description','denied','--version','1'),'ORGANIZATION_OWNER_REQUIRED');
});
test('ordinary-user login and explicit onboarding retry preserve the authenticated session',async()=>{
 const base=globalThis.fetch;
 let unavailable=true;
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/api/me'))return Response.json({userId:'user_fixture',instanceId:config.instanceId,instanceRole:'user'});
  if(String(input).endsWith('/api/onboarding')&&unavailable)return Response.json({error:{code:'IDENTITY_UNAVAILABLE'}},{status:503});
  return base(input,init);
 };
 await execute(['instance','import',input],rt);
 await fails(command('login'),'ONBOARDING_INCOMPLETE');assert.ok(state());
 unavailable=false;
 const result=await command('onboard');
 assert.equal((result as {instanceRole:string}).instanceRole,'user');
 assert.equal((result as {defaultOrganizationId:string}).defaultOrganizationId,'org_default');
});

test('channel commands require selected organization and use formal public routes with stable operation keys', async () => {
 await setup();
 await fails(execute(['channel','list','--server',config.server],rt),'ORGANIZATION_TOKEN_REQUIRED');
 orgSelected='org_channels'; await command('refresh');
 const previous=globalThis.fetch; const seen:{path:string;method:string;body:unknown;operation:string|null}[]=[];
 const channelId='ch_'+'a'.repeat(64);
 globalThis.fetch=async(url,init)=>{
  const u=new URL(String(url));
  if(u.pathname.startsWith('/api/organizations/org_channels/channels')) {
   assert.ok(new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '));
   seen.push({path:u.pathname+u.search,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null,operation:new Headers(init?.headers).get('Idempotency-Key')});
   return Response.json({channelId,accepted:true});
  }
  return previous(url,init);
 };
 const run=(...args:string[])=>execute(['channel',...args,'--server',config.server],rt);
 await run('create','--name','general','--operation','channel-operation-0001');
 await run('list'); await run('show','--id',channelId); await run('history','--id',channelId,'--after','2');
 const file=join(root,'message.txt');writeFileSync(file,'Durable text');
 await run('send','--id',channelId,'--text-file',file,'--operation','message-operation-0001');
 assert.equal(seen.length,5);
 assert.deepEqual(seen[0],{path:'/api/organizations/org_channels/channels',method:'POST',body:{name:'general'},operation:'channel-operation-0001'});
 assert.equal(seen[3].path.endsWith('/messages?after=2'),true);
 assert.deepEqual(seen[4].body,{text:'Durable text'});assert.equal(seen[4].operation,'message-operation-0001');
 await fails(run('list','--org','org_other'),'ORGANIZATION_TOKEN_REQUIRED');assert.equal(seen.length,5);
});
test('invitation inbox/accept work before org selection; owner send/list/revoke use selected org and stable operation', async()=>{
 await setup(); const previous=globalThis.fetch;
 const seen:{path:string;method:string;body:unknown;key:string|null}[]=[];
 globalThis.fetch=async(url,init)=>{
  const u=new URL(String(url));
  if(u.pathname.startsWith('/api/invitations') || u.pathname.includes('/invitations')){
   seen.push({path:u.pathname+u.search,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null,key:new Headers(init?.headers).get('Idempotency-Key')});
   return Response.json({invitations:[],accepted:true});
  }
  if(u.pathname.startsWith('/api/organizations/org_invites'))return Response.json({organizationId:'org_invites',role:'owner'});
  return previous(url,init);
 };
 const run=(...args:string[])=>execute(['invite',...args,'--server',config.server],rt);
 await run('inbox'); await run('accept','--id','invitation_test');
 await fails(run('send','--email','b@example.test','--operation','invite-operation-0001'),'ORGANIZATION_TOKEN_REQUIRED');
 await execute(['org','use','--id','org_invites','--server',config.server],rt);
 await run('send','--email','b@example.test','--operation','invite-operation-0001');
 await run('list'); await run('revoke','--id','invitation_test');
 assert.equal(seen.length,5);
 assert.deepEqual(seen[0],{path:'/api/invitations',method:'GET',body:null,key:null});
 assert.equal(seen[1].path,'/api/invitations/invitation_test/accept');
 assert.deepEqual(seen[2],{path:'/api/organizations/org_invites/invitations',method:'POST',body:{email:'b@example.test'},key:'invite-operation-0001'});
 assert.equal(seen[4].path,'/api/organizations/org_invites/invitations/invitation_test/revoke');
 await fails(run('list','--org','org_other'),'ORGANIZATION_TOKEN_REQUIRED');
 await fails(run('accept','--id','not-an-id'),'INVALID_INVITATION');
});

test('channel guests use independent public routes without selecting or joining the host organization', async()=>{
 await setup(); const previous=globalThis.fetch, channel='ch_'+'b'.repeat(64), invitation='ci_'+'c'.repeat(64);
 const seen:{path:string;method:string;body:unknown;key:string|null}[]=[];
 globalThis.fetch=async(url,init)=>{
  const u=new URL(String(url));
  if(u.pathname.startsWith('/api/channel-invitations') || u.pathname.startsWith('/api/guest-channels') || u.pathname.includes('/guest-invitations')){
   seen.push({path:u.pathname+u.search,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null,key:new Headers(init?.headers).get('Idempotency-Key')});
   return Response.json({accepted:true});
  }
  return previous(url,init);
 };
 const run=(...args:string[])=>execute([...args,'--server',config.server],rt);
 await run('channel-invite','inbox'); await run('channel-invite','accept','--id',invitation);
 await run('guest-channel','list'); await run('guest-channel','show','--id',channel);
 await run('guest-channel','history','--id',channel,'--after','7');
 const file=join(root,'guest-message.txt');writeFileSync(file,'Guest reply');
 await run('guest-channel','send','--id',channel,'--text-file',file,'--operation','guest-message-0001');
 assert.equal(orgSelected,undefined);
 assert.deepEqual(seen.map(v=>v.path),['/api/channel-invitations','/api/channel-invitations/'+invitation+'/accept','/api/guest-channels','/api/guest-channels/'+channel,'/api/guest-channels/'+channel+'/messages?after=7','/api/guest-channels/'+channel+'/messages']);
 assert.deepEqual(seen[5],{path:'/api/guest-channels/'+channel+'/messages',method:'POST',body:{text:'Guest reply'},key:'guest-message-0001'});
 await fails(run('channel-invite','send','--channel',channel,'--email','b@example.test','--operation','guest-invite-0001'),'ORGANIZATION_TOKEN_REQUIRED');
 orgSelected='org_owner';await command('refresh');
 await run('channel-invite','send','--channel',channel,'--email','b@example.test','--operation','guest-invite-0001');
 await run('channel-invite','list','--channel',channel);
 await run('channel-invite','revoke','--channel',channel,'--id',invitation);
 assert.deepEqual(seen[6],{path:'/api/organizations/org_owner/channels/'+channel+'/guest-invitations',method:'POST',body:{email:'b@example.test'},key:'guest-invite-0001'});
 assert.equal(seen[8].path,'/api/organizations/org_owner/channels/'+channel+'/guest-invitations/'+invitation+'/revoke');
 await fails(run('channel-invite','accept','--id','invitation_wrong'),'INVALID_CHANNEL_INVITATION');
 await fails(run('guest-channel','show','--id','ch_wrong'),'INVALID_CHANNEL');
 globalThis.fetch=async(url,init)=>String(url).includes('/api/guest-channels')?Response.json({error:{code:'CHANNEL_ACCESS_DENIED'}},{status:403}):previous(url,init);
 await fails(run('guest-channel','history','--id',channel),'CHANNEL_ACCESS_DENIED');
 assert.equal(orgSelected,'org_owner');
});


test('Agent create persists a private stable credential before network and retries without disclosing it', async()=>{
 await setup(); orgSelected='org_fixture'; await command('refresh');
 const original=globalThis.fetch; let lost=true; let hashes:string[]=[];
 const channelId='ch_'+'a'.repeat(64);
 globalThis.fetch=async(url,init)=>{
  if(!String(url).endsWith('/agents'))return original(url,init);
  const files=readdirSync(join(rt.directory!,'agents')); assert.equal(files.length,1);
  const credential=JSON.parse(readFileSync(join(rt.directory!,'agents',files[0]),'utf8'));
  assert.equal(statSync(join(rt.directory!,'agents',files[0])).mode&0o777,0o600);
  const body=JSON.parse(String(init?.body));hashes.push(body.secretHash);assert.notEqual(body.secretHash,credential.secret);
  if(lost){lost=false;throw Error('response lost');}
  return Response.json({actorId:credential.actorId,name:credential.name,ownerUserId:'user_fixture',state:'active',secret:credential.secret});
 };
 const run=(name='Test agent')=>execute(['agent','create','--server',config.server,'--channel',channelId,'--name',name,'--operation','agent-create-stable-0001'],rt);
 await fails(run(),'NETWORK_UNAVAILABLE');
 const result=await run() as {credentialFile:string};
 const credential=JSON.parse(readFileSync(result.credentialFile,'utf8'));
 assert.equal(new Set(hashes).size,1);assert.equal(JSON.stringify(result).includes(credential.secret),false);
 await fails(run('Changed agent'),'OPERATION_CONFLICT');assert.equal(hashes.length,2);
 const before=state();
 globalThis.fetch=async(url,init)=>{
  if(String(url).includes('/api/agent-channels/')){assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer tob_agent_'+credential.actorId+'.'+credential.secret);return Response.json({messages:[],nextCursor:4,hasMore:false});}
  return original(url,init);
 };
 assert.deepEqual(await execute(['agent-channel','history','--credential-file',result.credentialFile],rt),{messages:[],nextCursor:4,hasMore:false});
 assert.deepEqual(state(),before);
 discovery.auth.clientId='client_changed';discovery.auth.issuer='https://api.workos.com/user_management/client_changed';discovery.auth.jwksUri='https://api.workos.com/sso/jwks/client_changed';
 await fails(execute(['agent-channel','history','--credential-file',result.credentialFile],rt),'INSTANCE_CONFIG_CHANGED');
 chmodSync(result.credentialFile,0o644);
 await fails(execute(['agent-channel','history','--credential-file',result.credentialFile],rt),'PRIVATE_CREDENTIAL_FILE_REQUIRED');
 chmodSync(result.credentialFile,0o600);const link=join(root,'agent-link.json');symlinkSync(result.credentialFile,link);
 await fails(execute(['agent-channel','history','--credential-file',link],rt),'SYMLINK_REFUSED');
});

test('work request CLI carries only fixed target/expiry and stable operation through selected organization',async()=>{
 await setup();const channel='ch_'+'a'.repeat(64),agent='ag_'+'b'.repeat(64),expiresAt=new Date(Date.now()+300000).toISOString();
 const run=()=>execute(['work','request','--server',config.server,'--channel',channel,'--agent',agent,'--expires-at',expiresAt,'--operation','fixed-work-cli-0001'],rt);
 await fails(run(),'ORGANIZATION_TOKEN_REQUIRED');orgSelected='org_fixture';await command('refresh');
 const prior=globalThis.fetch;let sent=0;
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/work-requests')){sent++;assert.equal(String(url),config.server+'/api/organizations/org_fixture/channels/'+channel+'/work-requests');assert.deepEqual(JSON.parse(String(init?.body)),{targetActorId:agent,capability:'health-check',expiresAt});assert.equal(new Headers(init?.headers).get('Idempotency-Key'),'fixed-work-cli-0001');return Response.json({replayed:sent>1});}
  return prior(url,init);
 };
 assert.deepEqual(await run(),{replayed:false});assert.deepEqual(await run(),{replayed:true});
});
