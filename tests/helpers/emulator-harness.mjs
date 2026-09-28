// Real HTTP handlers + static site + Firestore emulator, extracted from the
// tests/dispatch-field.browser.mjs pattern. Only loopback and explicitly
// injected synthetic hosts are reachable; production Firestore never is.
// Handlers run on an injected test clock (HARNESS_NOW unless `now` is given),
// never the real one, wherever their module exports a {now} factory.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashHubCredential} from '../../functions/_lib/hub-session.js';
import {createPagesRouter,nodeRequest,writeNodeResponse} from './pages-router.mjs';

export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const PRODUCTION_PROJECT='egcw-1ec83';
export const SYNTHETIC_PASSWORD='Synthetic emulator harness only!';
export const DEFAULT_USERS=[['ZacB','Synthetic Owner','owner'],['Crew.One','Synthetic Crew One','crew'],['Lead.One','Synthetic Lead One','crew_lead'],['Other.Crew','Synthetic Other Crew','crew']];
const TYPES={'.html':'text/html; charset=utf-8','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']);
// The tests-ci fixed instant. Acceptance tests derive their dates from the
// harness clock instead of the real one (or far-future dates).
export const HARNESS_NOW='2026-09-22T12:00:00.000Z';
// Servers bind 127.0.0.1 because the Playwright guard (tests/e2e/helpers/test.mjs)
// only lets that hostname through; 'localhost' pages would be aborted there.
export const HARNESS_HOST='127.0.0.1';

// A controllable clock: a function returning a fresh Date, plus set/advance so a
// test can move time for every clocked handler at once.
export function testClock(start=HARNESS_NOW){
 const parse=value=>{const time=new Date(value instanceof Date?value.getTime():value).getTime();if(Number.isNaN(time))throw new TypeError(`Invalid test clock time: ${String(value)}`);return time;};
 let current=parse(start);
 const now=()=>new Date(current);
 return Object.assign(now,{now,iso:()=>new Date(current).toISOString(),set(value){current=parse(value);return now();},advance(ms){if(!Number.isFinite(ms))throw new TypeError('advance(ms) needs a number of milliseconds');current+=ms;return now();}});
}
// now: a Date/ISO string/epoch (wrapped in testClock), a clock function (used
// as is), or null/false for the real clock, which acceptance tests must not use.
const harnessClock=now=>now===null||now===false?null:typeof now==='function'?now:testClock(now);

export function loopbackEmulator(host=process.env.FIRESTORE_EMULATOR_HOST){
 assert.match(host||'',/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/,'A loopback Firestore emulator (FIRESTORE_EMULATOR_HOST) is required.');
 return host;
}

// Production Firestore URLs and bodies are rewritten to the demo project with
// the emulator's owner token; everything that is not loopback is refused.
export function emulatorFetch({emulator,projectId,fetch:upstream=globalThis.fetch,hosts={}}){
 loopbackEmulator(emulator);
 assert.match(projectId||'',/^demo-[a-z0-9-]+$/,'Emulator harness projects must use a demo-* id.');
 const production=`projects/${PRODUCTION_PROJECT}/`,demo=`projects/${projectId}/`;
 return async(input,options={})=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.hostname==='firestore.googleapis.com'){
   const headers=new Headers(options.headers);headers.set('Authorization','Bearer owner');
   const body=typeof options.body==='string'?options.body.replaceAll(production,demo):options.body;
   return upstream(`http://${emulator}${url.pathname.replaceAll(production,demo)}${url.search}`,{...options,headers,...(body===undefined?{}:{body})});
  }
  if(Object.hasOwn(hosts,url.hostname))return hosts[url.hostname](input,options);
  if(LOOPBACK.has(url.hostname))return upstream(input,options);
  throw new Error('External network refused by isolated acceptance test: '+url.hostname);
 };
}

export async function hubUsers(entries=DEFAULT_USERS,password=SYNTHETIC_PASSWORD){
 return Object.fromEntries(await Promise.all(entries.map(async entry=>{
  const [user,displayName=user,role='crew']=Array.isArray(entry)?entry:[entry.user,entry.displayName,entry.role];
  return [user,{passwordHash:await hashHubCredential(user,password),displayName,role}];
 })));
}

async function staticFile(root,pathname){
 const base=resolve(root),inside=file=>file===base||file.startsWith(base.endsWith(sep)?base:base+sep);
 let decoded;try{decoded=decodeURIComponent(pathname);}catch{return null;}
 const requested=resolve(base,'.'+decoded);
 if(!inside(requested))return null;
 for(const file of extname(requested)?[requested]:[requested,requested+'.html',resolve(requested,'index.html')]){
  if(!inside(file))continue;
  try{if((await stat(file)).isFile())return {file,body:await readFile(file)};}catch{}
 }
 return null;
}

// A router you pass keeps its own clock; otherwise `now` drives every clocked handler.
export async function createHubServer({env={},router,middleware=true,staticRoot=ROOT,host=HARNESS_HOST,password=SYNTHETIC_PASSWORD,now=HARNESS_NOW}={}){
 const clock=router?router.now:harnessClock(now);
 router||=createPagesRouter({env,middleware,now:clock});
 const apiErrors=[],serverErrors=[];let base='';
 const server=createServer(async(incoming,outgoing)=>{
  try{
   const url=new URL(incoming.url,base);
   if(router.handles(url.pathname)){
    const response=await router.fetch(await nodeRequest(incoming,base),env),body=await writeNodeResponse(outgoing,response);
    if(response.status>=400)apiErrors.push({method:incoming.method,path:url.pathname,status:response.status,body:body.toString().slice(0,1500)});
    return;
   }
   const found=await staticFile(staticRoot,url.pathname);
   if(!found){outgoing.writeHead(404,{'Content-Type':'text/plain'});outgoing.end('Not found');return;}
   outgoing.writeHead(200,{'Content-Type':TYPES[extname(found.file)]||'application/octet-stream','Cache-Control':'no-store'});outgoing.end(found.body);
  }catch(error){serverErrors.push(error?.stack||String(error));if(!outgoing.headersSent)outgoing.writeHead(500);outgoing.end('Synthetic test server failure');}
 });
 await new Promise(done=>server.listen(0,host,done));
 base=`http://${host}:${server.address().port}`;
 const cookies=new Map();
 async function login(user,secret=password){
  const response=await fetch(base+'/api/hub-auth',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({username:user,password:secret})});
  const body=await response.json().catch(()=>({}));
  if(response.status!==200||!body.ok)throw Object.assign(new Error(`Synthetic login failed for ${user}: ${response.status} ${body.error||''}`),{status:response.status,body});
  const cookie=response.headers.getSetCookie().map(line=>line.split(';')[0]).find(line=>line.startsWith('egc_hub_session='));
  cookies.set(user,cookie);return cookie;
 }
 async function api(path,{user,cookie,method,body,headers={}}={}){
  const session=cookie||(user?cookies.get(user)||await login(user):'');
  return fetch(base+path,{method:method||(body===undefined?'GET':'POST'),headers:{...(session?{Cookie:session}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:base}),...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
 }
 // Playwright: sign a browser context in without driving the login form.
 async function authenticate(context,user){
  const [name,value]=(cookies.get(user)||await login(user)).split(/=(.*)/s);
  await context.addCookies([{name,value,url:base,httpOnly:true,sameSite:'Strict'}]);
 }
 // Playwright: the real crew login form, as an employee would use it on a phone.
 async function loginPage(page,user,secret=password){
  await page.goto(base+'/crew/job.html');
  await page.getByLabel('Username',{exact:true}).fill(user);await page.getByLabel('Password',{exact:true}).fill(secret);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByText('Signed in as ',{exact:false}).waitFor();
 }
 async function close(){await router.settle();await new Promise(done=>server.close(done));}
 return {base,server,router,env,clock,apiErrors,serverErrors,login,api,authenticate,loginPage,close};
}

export function rulesUnitTesting(){
 const require=createRequire(resolve(process.env.EGC_FIREBASE_TEST_MODULES||ROOT,'package.json'));
 return require('@firebase/rules-unit-testing');
}

// Hosts the harness answers itself. drive:true adds the tests/helpers/field-fixture.mjs
// Google Drive and OAuth fake for www.googleapis.com and oauth2.googleapis.com and
// synthetic Google credentials; `drive` exposes the fake's stored files and calls.
// Nothing here touches globalThis.fetch.
export async function harnessHosts({drive=false,hosts={}}={}){
 const routes={...hosts},env={};let state=null;
 if(drive){
  const {storage}=await import('./field-fixture.mjs');let fake;
  state=storage({mock:{method(object,key,implementation){fake=implementation;}}});
  for(const name of['www.googleapis.com','oauth2.googleapis.com'])routes[name]||=fake;
  Object.assign(env,{GOOGLE_CLIENT_ID:'synthetic-harness-client',GOOGLE_CLIENT_SECRET:'synthetic-harness-secret',GOOGLE_REFRESH_TOKEN:'synthetic-harness-refresh'});
 }
 return {routes,env,drive:state?{files:state.drive,calls:state.calls}:null};
}

export async function startEmulatorHarness({projectId='demo-egc-harness',users=DEFAULT_USERS,password=SYNTHETIC_PASSWORD,env:extra={},clear=true,drive=false,hosts={},middleware=true,host=HARNESS_HOST,now=HARNESS_NOW}={}){
 const emulator=loopbackEmulator(),[hostname,port]=emulator.split(/:(?=\d+$)/);
 const {initializeTestEnvironment}=rulesUnitTesting();
 const environment=await initializeTestEnvironment({projectId,firestore:{host:hostname,port:Number(port),rules:await readFile(resolve(ROOT,'firestore.rules'),'utf8')}});
 if(clear)await environment.clearFirestore();
 const synthetic=await harnessHosts({drive,hosts});
 const env={HUB_SESSION_SECRET:'synthetic-emulator-harness-session',FIREBASE_API_KEY:'firebase-test-emulator-harness',HUB_AUTH_USERS_JSON:JSON.stringify(await hubUsers(users,password)),...synthetic.env,...extra};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=emulatorFetch({emulator,projectId,fetch:originalFetch,hosts:synthetic.routes});
 let hub;
 try{hub=await createHubServer({env,middleware,host,password,now});}
 catch(error){globalThis.fetch=originalFetch;await environment.cleanup();throw error;}
 const seed=write=>environment.withSecurityRulesDisabled(context=>write(context.firestore()));
 async function readDoc(path){let data;await seed(async db=>{data=(await db.doc(path).get()).data();});return data;}
 async function close(){try{await hub.close();}finally{globalThis.fetch=originalFetch;await environment.cleanup();}}
 return {...hub,projectId,environment,password,drive:synthetic.drive,seed,readDoc,close};
}
