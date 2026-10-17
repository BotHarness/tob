import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, readdirSync, chmodSync, symlinkSync, realpathSync } from 'node:fs';
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
 assert.deepEqual(await command('whoami'),login);
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
