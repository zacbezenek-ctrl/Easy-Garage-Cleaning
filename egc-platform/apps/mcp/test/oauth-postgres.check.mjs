/** OAuth store SQL and the real MCP OAuth boundary against isolated loopback PostgreSQL with synthetic fixtures only; never point this at production. */
import test,{after,before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {getDb,schema} from '@egc/database';
import {sql} from 'drizzle-orm';
import {postgresOAuthStore} from '../dist/oauth/store.js';
import {beginAttempt,discardAttempt,hubStartRules,HUB_START_MAX,HUB_START_WINDOW_MS} from '../dist/oauth/rate-limit.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const db=getDb(),store=postgresOAuthStore(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const NOW=new Date('2026-09-22T12:00:00.000Z'),at=ms=>new Date(NOW.valueOf()+ms);
const hash=value=>createHash('sha256').update(value).digest('hex');
const user='isolated-oauth-check-user',password='isolated-oauth-check-password-0123456789';
const servers=[];
async function start(extraEnv={}) {
  const probe=createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/server.js',import.meta.url))],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH??'',NODE_ENV:'test',PORT:String(port),
    MCP_PUBLIC_ORIGIN:origin,MCP_ALLOWED_HOSTS:'127.0.0.1',MCP_OAUTH_USER:user,MCP_OAUTH_PASSWORD:password,MCP_OAUTH_DCR_ENABLED:'true',GHL_WRITEBACK_ENABLED:'false',EGC_OPERATIONS_ENABLED:'true',DATABASE_URL:process.env.DATABASE_URL,...extraEnv}});
  let output='';child.stdout.on('data',b=>{output=(output+b).slice(-16000);});child.stderr.on('data',b=>{output=(output+b).slice(-16000);});
  const stop=async()=>{if(child.exitCode!==null)return;child.kill('SIGTERM');for(let i=0;i<40&&child.exitCode===null&&child.signalCode===null;i++)await sleep(25);if(child.exitCode===null)child.kill('SIGKILL');};
  servers.push(stop);
  for(let i=0;i<300&&!output.includes('EGC MCP listening');i++){if(child.exitCode!==null)break;await sleep(30);}
  if(!output.includes('EGC MCP listening')){await stop();throw new Error(`MCP startup failed: ${output}`);}
  const form=(path,fields)=>fetch(origin+path,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields).toString()});
  return {origin,form,output:()=>output};
}
let mcp;
before(async()=>{mcp=await start();});
after(async()=>{for(const stop of servers)await stop();await db.$client.end({timeout:5});});
beforeEach(async()=>{
  await db.execute(sql`set client_min_messages to warning`);
  await db.execute(sql`truncate oauth_clients,oauth_authorization_codes,oauth_tokens,oauth_grant_requests,oauth_rate_limit_events`);
});
const token=(overrides={})=>({accessTokenHash:hash(randomBytes(16).toString('hex')),refreshTokenHash:hash(randomBytes(16).toString('hex')),clientId:'https://chatgpt.com/oauth/client.json',resource:'https://mcp.example.invalid',scopes:['egc:read'],accessExpiresAt:at(3600_000),refreshExpiresAt:at(86400_000),principalId:null,principalRole:null,principalAssertion:null,...overrides});

test('codes, grant requests and refresh claims are single use under concurrency',async()=>{
  await store.insertCode({codeHash:hash('code'),clientId:'c',redirectUri:'https://claude.ai/api/mcp/auth_callback',codeChallenge:'x',resource:'r',scopes:['egc:read'],expiresAt:at(300_000),principalId:'zacb',principalRole:'owner',principalAssertion:'synthetic.assertion'},NOW);
  const code=await store.code(hash('code'));
  assert.deepEqual({principalId:code.principalId,principalRole:code.principalRole,principalAssertion:code.principalAssertion},{principalId:'zacb',principalRole:'owner',principalAssertion:'synthetic.assertion'});
  assert.deepEqual((await Promise.all(Array.from({length:6},()=>store.consumeCode(code.id,NOW)))).filter(Boolean).length,1);
  await store.insertGrantRequest({nonceHash:hash('nonce'),clientId:'c',redirectUri:'r',codeChallenge:'x',resource:'r',scopes:['egc:read','egc:write'],state:'s',clientLabel:'Claude (claude.ai)',bindingHash:hash('binding'),expiresAt:at(600_000)},NOW);
  const consumed=(await Promise.all(Array.from({length:6},()=>store.consumeGrantRequest(hash('nonce'),at(1000))))).filter(Boolean);
  assert.equal(consumed.length,1);assert.deepEqual(consumed[0].scopes,['egc:read','egc:write']);assert.equal(consumed[0].state,'s');
  assert.equal(consumed[0].clientLabel,'Claude (claude.ai)');assert.equal(consumed[0].bindingHash,hash('binding'));
  await store.insertGrantRequest({nonceHash:hash('late'),clientId:'c',redirectUri:'r',codeChallenge:'x',resource:'r',scopes:[],state:null,clientLabel:'',bindingHash:hash('late-binding'),expiresAt:at(600_000)},NOW);
  assert.equal(await store.consumeGrantRequest(hash('late'),at(600_000)),null,'expiry is exclusive');
  // Requests expired for over a day are removed when a new one is stored.
  await store.insertGrantRequest({nonceHash:hash('next-day'),clientId:'c',redirectUri:'r',codeChallenge:'x',resource:'r',scopes:[],state:null,clientLabel:'',bindingHash:hash('next-binding'),expiresAt:at(3*86400_000)},at(2*86400_000));
  assert.deepEqual((await db.select({nonceHash:schema.oauthGrantRequests.nonceHash}).from(schema.oauthGrantRequests)).map(r=>r.nonceHash),[hash('next-day')]);
  const id=await store.insertToken(token({principalId:'tylerg',principalRole:'manager',principalAssertion:'synthetic.manager'}),NOW);
  const row=await store.tokenByAccess((await db.select().from(schema.oauthTokens))[0].accessTokenHash);
  assert.equal(row.id,id);assert.equal(row.principalRole,'manager');assert.equal(row.createdAt.toISOString(),NOW.toISOString());
  const claims=await Promise.all(Array.from({length:6},(_,i)=>store.claimRefresh(id,row.refreshTokenHash,hash(`claim-${i}`),NOW)));
  assert.equal(claims.filter(Boolean).length,1);
  const winner=hash(`claim-${claims.indexOf(true)}`);
  assert.equal(await store.rotateToken(id,hash('claim-not-held'),{accessTokenHash:'a',refreshTokenHash:'b',accessExpiresAt:NOW,refreshExpiresAt:NOW},NOW),false);
  await store.revokeToken(id,at(5));await store.revokeToken(id,at(9));
  assert.equal(await store.rotateToken(id,winner,{accessTokenHash:hash('a'),refreshTokenHash:hash('b'),accessExpiresAt:NOW,refreshExpiresAt:NOW},NOW),false,'a revoked grant is never rotated back to life');
  assert.equal((await store.tokenByRefresh(winner)).revokedAt.toISOString(),at(5).toISOString());
});

test('attempt windows count only the bucket inside the window and old rows are pruned',async()=>{
  const first=await store.recordAttempts(['login:all','login:account:a'],NOW);
  await store.recordAttempts(['login:all'],at(10*60_000));
  assert.equal(first.length,2);
  assert.equal(await store.countAttempts('login:all',at(-1)),2);
  assert.equal(await store.countAttempts('login:all',NOW),1,'the window start is exclusive');
  assert.equal(await store.countAttempts('login:account:a',at(-1)),1);
  await store.deleteAttempts(first);
  assert.equal(await store.countAttempts('login:all',at(-1)),1);
  await store.recordAttempts(['register:all'],at(2*86400_000));
  assert.deepEqual((await db.select({bucket:schema.oauthRateLimitEvents.bucket}).from(schema.oauthRateLimitEvents)).map(r=>r.bucket),['register:all']);
  await assert.rejects(store.insertClient({clientId:'egc_client_duplicate',clientName:'A',redirectUris:[],createdAt:NOW}).then(()=>store.insertClient({clientId:'egc_client_duplicate',clientName:'B',redirectUris:[],createdAt:NOW})));
});

test('Employee Hub starts are capped in Postgres; a refused start leaves no row and the cap lifts with the window',async()=>{
  for(let i=0;i<HUB_START_MAX;i++)assert.equal((await beginAttempt(store,hubStartRules(),at(i<50?0:60_000))).allowed,true);
  const refused=await beginAttempt(store,hubStartRules(),at(120_000));
  assert.deepEqual({allowed:refused.allowed,refused:refused.refused,retryAfterSeconds:refused.retryAfterSeconds},{allowed:false,refused:['hub:start:all'],retryAfterSeconds:900});
  await discardAttempt(store,refused.ids);
  assert.equal(await store.countAttempts('hub:start:all',at(-1)),HUB_START_MAX);
  // Fifteen minutes after the first 50, exactly 50 more fit.
  for(let i=0;i<50;i++)assert.equal((await beginAttempt(store,hubStartRules(),at(HUB_START_WINDOW_MS))).allowed,true,String(i));
  assert.equal((await beginAttempt(store,hubStartRules(),at(HUB_START_WINDOW_MS))).allowed,false);
});

test("real server: Claude's metadata-document client_id connects without registration, and a Hub start is stored and counted",async()=>{
  const server=await start({MCP_OAUTH_DCR_ENABLED:'false',MCP_OAUTH_HUB_IDENTITY_ENABLED:'true'});
  const metadata=await (await fetch(`${server.origin}/.well-known/oauth-authorization-server`,{signal:AbortSignal.timeout(10000)})).json();
  assert.equal(metadata.client_id_metadata_document_supported,true);assert.equal(metadata.registration_endpoint,undefined);
  const claude='https://claude.ai/oauth/mcp-oauth-client-metadata',redirect='https://claude.ai/api/mcp/auth_callback';
  const verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  const fields={client_id:claude,redirect_uri:redirect,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',resource:`${server.origin}/mcp/oauth`,scope:'egc:read egc:write',state:'isolated-cimd'};
  const page=await fetch(`${server.origin}/oauth/authorize?${new URLSearchParams(fields)}`,{signal:AbortSignal.timeout(10000)});
  assert.equal(page.status,200);assert.match(await page.text(),/Claude \(claude\.ai\) is asking to connect/);
  // Continue with Employee Hub stores the request and one hub:start:all attempt, and sends the browser to the pinned Hub.
  const hub=await fetch(`${server.origin}/oauth/authorize`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded','Sec-Fetch-Site':'same-origin'},body:new URLSearchParams({...fields,login:'hub'}).toString()});
  assert.equal(hub.status,303);assert.match(hub.headers.get('location'),/^https:\/\/easygaragecleaning\.com\/api\/mcp-grant\?grant=/);
  const [request]=await db.select().from(schema.oauthGrantRequests);
  assert.deepEqual({clientId:request.clientId,redirectUri:request.redirectUri,clientLabel:request.clientLabel,resource:request.resource},{clientId:claude,redirectUri:redirect,clientLabel:'Claude (claude.ai)',resource:server.origin});
  assert.deepEqual((await db.select({bucket:schema.oauthRateLimitEvents.bucket}).from(schema.oauthRateLimitEvents)).map(r=>r.bucket),['hub:start:all']);
  // The same client completes PKCE with the shared login and calls a tool on /mcp/oauth.
  const authorized=await server.form('/oauth/authorize',{...fields,username:user,password});
  assert.equal(authorized.status,302);assert.ok(authorized.headers.get('location').startsWith(`${redirect}?code=egc_ac_`));
  const code=new URL(authorized.headers.get('location')).searchParams.get('code');
  const issued=await server.form('/oauth/token',{grant_type:'authorization_code',client_id:claude,redirect_uri:redirect,code,code_verifier:verifier,resource:`${server.origin}/mcp/oauth`});
  assert.equal(issued.status,200);
  const tokens=await issued.json();
  assert.equal((await db.select().from(schema.oauthTokens))[0].clientId,claude);
  assert.equal((await db.select().from(schema.oauthClients)).length,0,'nothing was registered');
  const call=await fetch(`${server.origin}/mcp/oauth`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Accept:'application/json,text/event-stream',Authorization:`Bearer ${tokens.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'egc.safety_policy',arguments:{}}})});
  assert.equal(call.status,200);
  // Another metadata-document URL is refused.
  assert.equal((await fetch(`${server.origin}/oauth/authorize?${new URLSearchParams({...fields,client_id:'https://evil.example.invalid/oauth/mcp-oauth-client-metadata'})}`,{signal:AbortSignal.timeout(10000)})).status,400);
});

test('a registered client is found only by its exact name and redirect list, earliest first',async()=>{
  const uris=['https://claude.ai/api/mcp/auth_callback','https://claude.com/api/mcp/auth_callback'];
  await store.insertClient({clientId:'egc_client_later',clientName:'Claude',redirectUris:uris,createdAt:at(60_000)});
  await store.insertClient({clientId:'egc_client_first',clientName:'Claude',redirectUris:uris,createdAt:NOW});
  await store.insertClient({clientId:'egc_client_one_uri',clientName:'Claude',redirectUris:[uris[0]],createdAt:NOW});
  assert.equal((await store.clientByMetadata('Claude',uris)).clientId,'egc_client_first');
  assert.deepEqual((await store.clientByMetadata('Claude',[uris[0]])).redirectUris,[uris[0]]);
  for(const [name,list] of [['Claude',[...uris].reverse()],['claude',uris],['Claude',[]],["Claude' or '1'='1",uris]])assert.equal(await store.clientByMetadata(name,list),null,JSON.stringify([name,list]));
});

test('real server: DCR client, PKCE, /mcp/oauth tool call, revocation and lockout persist in Postgres',async()=>{
  const register=()=>fetch(`${mcp.origin}/oauth/register`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Claude',redirect_uris:['https://claude.ai/api/mcp/auth_callback'],token_endpoint_auth_method:'client_secret_post'})});
  const registered=await register();
  assert.equal(registered.status,201);
  const {client_id:client,token_endpoint_auth_method:method}=await registered.json();
  assert.equal(method,'none');
  assert.equal((await db.select().from(schema.oauthClients))[0].clientId,client);
  // A repeat registration reuses the public client and is not counted against the limit.
  assert.equal((await (await register()).json()).client_id,client);
  assert.equal((await db.select().from(schema.oauthClients)).length,1);
  const verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  const fields={client_id:client,redirect_uri:'https://claude.ai/api/mcp/auth_callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',resource:`${mcp.origin}/mcp/oauth`,scope:'egc:read egc:write',state:'isolated'};
  const authorized=await mcp.form('/oauth/authorize',{...fields,username:user,password});
  assert.equal(authorized.status,302);
  const code=new URL(authorized.headers.get('location')).searchParams.get('code');
  const issued=await mcp.form('/oauth/token',{grant_type:'authorization_code',client_id:client,redirect_uri:fields.redirect_uri,code,code_verifier:verifier,resource:`${mcp.origin}/mcp/oauth`});
  assert.equal(issued.status,200);
  const tokens=await issued.json();
  const [row]=await db.select().from(schema.oauthTokens);
  assert.equal(row.accessTokenHash,hash(tokens.access_token));assert.equal(row.resource,mcp.origin);assert.equal(row.principalId,null);
  assert.equal((await mcp.form('/oauth/token',{grant_type:'authorization_code',client_id:client,redirect_uri:fields.redirect_uri,code,code_verifier:verifier})).status,400);
  const call=(bearer)=>fetch(`${mcp.origin}/mcp/oauth`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Accept:'application/json,text/event-stream',Authorization:`Bearer ${bearer}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'egc.safety_policy',arguments:{}}})});
  const allowed=await call(tokens.access_token);
  assert.equal(allowed.status,200);
  const text=await allowed.text();
  const data=allowed.headers.get('content-type')?.includes('text/event-stream')?JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)):JSON.parse(text);
  assert.equal(data.result.structuredContent.result.mode,'action_center');
  assert.equal((await mcp.form('/oauth/revoke',{token:tokens.refresh_token,client_id:client})).status,200);
  assert.ok((await db.select().from(schema.oauthTokens))[0].revokedAt);
  assert.equal((await call(tokens.access_token)).status,401);
  assert.equal((await mcp.form('/oauth/token',{grant_type:'refresh_token',client_id:client,refresh_token:tokens.refresh_token})).status,400);
  const statuses=[];
  for(let i=0;i<6;i++)statuses.push((await mcp.form('/oauth/authorize',{...fields,username:user,password:`wrong-${i}`})).status);
  statuses.push((await mcp.form('/oauth/authorize',{...fields,username:user,password})).status);
  assert.deepEqual(statuses,[401,401,401,401,401,429,429]);
  // Only the checks that ran are stored: one registration and five failures (per account and server-wide).
  const buckets=(await db.select({bucket:schema.oauthRateLimitEvents.bucket}).from(schema.oauthRateLimitEvents)).map(r=>r.bucket.replace(/^login:account:[a-f0-9]{32}$/,'login:account')).sort();
  assert.deepEqual(buckets,['login:account','login:account','login:account','login:account','login:account','login:all','login:all','login:all','login:all','login:all','register:all']);
  assert.ok(!mcp.output().includes(password)&&!mcp.output().includes(tokens.access_token),'credentials never reach logs');
});
