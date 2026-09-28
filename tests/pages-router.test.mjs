import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {clockOf,createPagesRouter,discoverRoutes,factoryCalls,matchRoute,nodeRequest,writeNodeResponse} from './helpers/pages-router.mjs';
import {firestoreMemory} from './helpers/firestore-memory.mjs';
import {sourceFiles} from './source-files.mjs';
import {createHubSessionCookie,hashHubCredential} from '../functions/_lib/hub-session.js';

const ORIGIN='https://easygaragecleaning.com';
const request=(path,init={})=>new Request(ORIGIN+path,init);
function tree(t,files){
 const root=mkdtempSync(join(tmpdir(),'egc-pages-router-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'package.json'),'{"type":"module"}');
 for(const [path,source] of Object.entries(files)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),source);}
 return root;
}
const echo=name=>`export async function onRequest(context){return Response.json({file:'${name}',method:context.request.method,params:context.params,functionPath:context.functionPath,data:context.data,env:context.env.MARK||null});}`;
const synthetic={
 'api/plain.js':"export const onRequestGet=()=>new Response('plain get');export const onRequestPost=async({request})=>new Response('plain post '+await request.text());",
 'api/any.js':echo('any'),
 'api/both.js':"export const onRequestGet=()=>new Response('specific get');export const onRequest=({request})=>new Response('generic '+request.method);",
 'api/nested/index.js':echo('nested index'),
 'api/nested/deep.js':echo('nested deep'),
 'api/items/[id].js':echo('item param'),
 'api/items/special.js':"export const onRequestGet=()=>new Response('special static');",
 'api/files/[[path]].js':echo('catch-all'),
 'api/_private.js':"export const onRequest=()=>new Response('must never route');",
 'api/_shared/helper.js':"export const onRequest=()=>new Response('must never route');",
 'api/notes.txt':'not a function',
 'api/background.js':"export const onRequestPost=({waitUntil})=>{waitUntil(new Promise(resolve=>setTimeout(()=>resolve('late work'),5)));waitUntil(Promise.reject(new Error('Synthetic background failure')));return new Response('accepted',{status:202});};",
 'api/throws.js':"export const onRequestGet=()=>{throw new Error('Synthetic handler crash');};",
 'api/not-response.js':"export const onRequestGet=()=>({ok:true});",
 'api/cookies.js':"export const onRequestGet=()=>{const headers=new Headers();headers.append('Set-Cookie','first=1; Path=/');headers.append('Set-Cookie','second=2; Path=/');return new Response('two cookies',{headers});};",
 '_middleware.js':"export async function onRequest(context){context.data.trail=['root'];if(new URL(context.request.url).searchParams.get('block')==='root')return new Response('blocked by root',{status:418});const response=await context.next();const copy=new Response(response.body,response);copy.headers.set('X-Root-Middleware','1');return copy;}",
 'api/_middleware.js':"export const onRequest=[async context=>{context.data.trail.push('api');return context.next();},async context=>{context.data.trail.push('api-second');const response=await context.next();const copy=new Response(response.body,response);copy.headers.set('X-Api-Middleware',context.data.trail.join('>'));return copy;}];",
};

// Independent of discoverRoutes: every functions/api/**/*.js at any depth,
// skipping _-prefixed files and directories, with index.js serving its directory.
function expectedRoutes(functionsDir){
 const api=join(functionsDir,'api');
 return sourceFiles(api).filter(entry=>/\.m?js$/.test(entry.name)).map(entry=>relative(api,join(entry.parentPath,entry.name)).split(sep))
  .filter(parts=>parts.every(part=>!part.startsWith('_')&&!part.startsWith('.')))
  .map(parts=>{const name=parts.pop().replace(/\.m?js$/,'');if(name!=='index')parts.push(name);return '/'+['api',...parts].map(part=>part.replace(/^\[\[(.+)\]\]$/,':$1*').replace(/^\[(.+)\]$/,':$1')).join('/');})
  .sort();
}

test('real functions/api files at any depth map to /api/<path> routes with no harness registration',()=>{
 const functionsDir=fileURLToPath(new URL('../functions/',import.meta.url)),{routes}=discoverRoutes(),expected=expectedRoutes(functionsDir);
 assert.ok(expected.length>=40,`only ${expected.length} API files found`);
 assert.deepEqual(routes.map(route=>route.path).sort(),expected);
 const dispatch=routes.find(route=>route.path==='/api/dispatch');
 assert.equal(dispatch.file,fileURLToPath(new URL('../functions/api/dispatch.js',import.meta.url)));
 assert.ok(routes.every(route=>!route.file.includes('_lib')));
});

test('synthetic tree maps index, nested, [param] and [[catch-all]] files in Pages precedence order',t=>{
 const {routes}=discoverRoutes({functionsDir:tree(t,synthetic)});
 assert.deepEqual(routes.map(route=>route.path),['/api/items/special','/api/nested/deep','/api/items/:id','/api/files/:path*','/api/any','/api/background','/api/both','/api/cookies','/api/nested','/api/not-response','/api/plain','/api/throws']);
 const item=routes.find(route=>route.path==='/api/items/:id'),rest=routes.find(route=>route.path==='/api/files/:path*');
 assert.deepEqual(matchRoute(item,'/api/items/synthetic%20id'),{id:'synthetic id'});
 assert.equal(matchRoute(item,'/api/items/a/b'),null);
 assert.deepEqual(matchRoute(rest,'/api/files/a/b/c.png'),{path:['a','b','c.png']});
 assert.equal(matchRoute(rest,'/api/files'),null);
});

test('the recursive expected-route walk agrees with discovery on nested, index, [param] and [[catch-all]] files',t=>{
 const functionsDir=tree(t,synthetic),expected=expectedRoutes(functionsDir);
 assert.deepEqual(expected,discoverRoutes({functionsDir}).routes.map(route=>route.path).sort());
 for(const path of['/api/nested','/api/nested/deep','/api/items/:id','/api/files/:path*'])assert.ok(expected.includes(path),path);
 assert.ok(!expected.some(path=>path.includes('_')||path.includes('notes')));
});

test('two files claiming one path or a non-final catch-all fail loudly',t=>{
 assert.throws(()=>discoverRoutes({functionsDir:tree(t,{'api/dup.js':echo('a'),'api/dup/index.js':echo('b')})}),/Two files map to \/api\/dup/);
 assert.throws(()=>discoverRoutes({functionsDir:tree(t,{'api/[[all]]/tail.js':echo('a')})}),/Catch-all segments must be last/);
 assert.throws(()=>discoverRoutes({functionsDir:join(tmpdir(),'egc-missing-functions-dir')}),/Pages Functions directory not found/);
});

test('unknown paths answer 404, private files never route and non-API paths are refused',async t=>{
 const router=createPagesRouter({functionsDir:tree(t,synthetic),middleware:false});
 for(const path of['/api/missing','/api/nested/missing','/api/_private','/api/_shared/helper','/api/notes.txt','/api/items','/api']){
  const response=await router.fetch(request(path));assert.equal(response.status,404,path);assert.equal(await response.text(),'Not Found');
 }
 assert.equal(router.handles('/api/x'),true);assert.equal(router.handles('/apiary'),false);assert.equal(router.handles('/index.html'),false);
 await assert.rejects(router.fetch(request('/employee.html')),/only serves \/api\/\*/);
 assert.equal(router.match('/api/items/7').route.path,'/api/items/:id');assert.equal(router.match('/api/unknown'),null);
});

test('method dispatch prefers onRequest<Method>, falls back to onRequest and reports 405 with Allow',async t=>{
 const router=createPagesRouter({functionsDir:tree(t,synthetic),middleware:false,env:{MARK:'default env'}});
 assert.equal(await (await router.fetch(request('/api/plain'))).text(),'plain get');
 assert.equal(await (await router.fetch(request('/api/plain',{method:'POST',body:'synthetic body'}))).text(),'plain post synthetic body');
 const put=await router.fetch(request('/api/plain',{method:'PUT'}));assert.equal(put.status,405);assert.equal(put.headers.get('Allow'),'GET, POST');
 assert.equal(await (await router.fetch(request('/api/both'))).text(),'specific get');
 assert.equal(await (await router.fetch(request('/api/both',{method:'DELETE'}))).text(),'generic DELETE');
 const any=await (await router.fetch(request('/api/any',{method:'PATCH'}),{MARK:'per request env'})).json();
 assert.deepEqual(any,{file:'any',method:'PATCH',params:{},functionPath:'/api/any',data:{},env:'per request env'});
 assert.equal((await (await router.fetch(request('/api/nested'))).json()).file,'nested index');
 assert.equal((await (await router.fetch(request('/api/nested/'))).json()).file,'nested index');
 assert.equal((await (await router.fetch(request('/api/nested/deep'))).json()).env,'default env');
 assert.equal(await (await router.fetch(request('/api/items/special'))).text(),'special static');
 const fallThrough=await (await router.fetch(request('/api/items/special',{method:'POST'}))).json();
 assert.deepEqual([fallThrough.file,fallThrough.params],['item param',{id:'special'}]);
 const files=await (await router.fetch(request('/api/files/2026/09/receipt.png'))).json();
 assert.deepEqual([files.params,files.functionPath],[{path:['2026','09','receipt.png']},'/api/files/:path*']);
});

test('waitUntil work is collected, settled in order and never lost when it rejects',async t=>{
 const router=createPagesRouter({functionsDir:tree(t,synthetic),middleware:false});
 const response=await router.fetch(request('/api/background',{method:'POST'}));
 assert.equal(response.status,202);assert.equal(router.background.length,2);
 const results=await router.settle();
 assert.deepEqual(results.map(result=>result.status),['fulfilled','rejected']);
 assert.equal(results[0].value,'late work');assert.match(results[1].reason.message,/Synthetic background failure/);
 assert.equal(router.background.length,0);assert.deepEqual(await router.settle(),[]);
 const own=[];await router.fetch(request('/api/background',{method:'POST'}),{},{waitUntil:promise=>own.push(promise.catch(error=>error.message))});
 assert.equal(own.length,2);assert.equal(router.background.length,0);assert.deepEqual(await Promise.all(own),['late work','Synthetic background failure']);
});

test('middleware runs outermost first around the handler, shares data and can short-circuit',async t=>{
 const router=createPagesRouter({functionsDir:tree(t,synthetic)});
 const response=await router.fetch(request('/api/any'));
 assert.equal(response.headers.get('X-Root-Middleware'),'1');assert.equal(response.headers.get('X-Api-Middleware'),'root>api>api-second');
 assert.deepEqual((await response.json()).data,{trail:['root','api','api-second']});
 const missing=await router.fetch(request('/api/missing'));assert.equal(missing.status,404);assert.equal(missing.headers.get('X-Api-Middleware'),'root>api>api-second');
 const blocked=await router.fetch(request('/api/any?block=root'));assert.equal(blocked.status,418);assert.equal(await blocked.text(),'blocked by root');
 const bare=await createPagesRouter({functionsDir:tree(t,synthetic),middleware:false}).fetch(request('/api/any'));assert.equal(bare.headers.get('X-Root-Middleware'),null);
});

test('a throwing or non-Response function becomes a recorded 500 instead of crashing the harness',async t=>{
 const router=createPagesRouter({functionsDir:tree(t,synthetic),middleware:false});
 const thrown=await router.fetch(request('/api/throws'));assert.equal(thrown.status,500);
 const invalid=await router.fetch(request('/api/not-response'));assert.equal(invalid.status,500);
 assert.equal(router.errors.length,2);assert.match(router.errors[0].stack,/Synthetic handler crash/);assert.match(router.errors[1].stack,/did not return a Response/);
});

test('real hub-auth runs through the production middleware with a signed session',async()=>{
 const password='Synthetic router password only!';
 const env={HUB_SESSION_SECRET:'synthetic-pages-router-secret',HUB_AUTH_USERS_JSON:JSON.stringify({'Crew.One':{passwordHash:await hashHubCredential('Crew.One',password),displayName:'Synthetic Crew One',role:'crew'}})};
 const router=createPagesRouter({env});
 const anonymous=await router.fetch(request('/api/hub-auth'));
 assert.equal(anonymous.status,401);assert.equal(anonymous.headers.get('Cache-Control'),'no-store');assert.match(anonymous.headers.get('Content-Security-Policy'),/default-src 'self'/);assert.equal(anonymous.headers.get('X-Robots-Tag'),'noindex, nofollow');
 const login=await router.fetch(request('/api/hub-auth',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({username:'crew.one',password})}));
 assert.equal(login.status,200);const cookie=login.headers.getSetCookie()[0].split(';')[0];assert.match(cookie,/^egc_hub_session=/);
 const session=await (await router.fetch(request('/api/hub-auth',{headers:{Cookie:cookie}}))).json();
 assert.deepEqual([session.user,session.displayName,session.role,session.businessAccess],['Crew.One','Synthetic Crew One','crew',false]);
 const minted=(await createHubSessionCookie(env,'Crew.One')).split(';')[0];
 assert.equal((await router.fetch(request('/api/hub-auth',{headers:{Cookie:minted}}))).status,200);
 const wrongMethod=await router.fetch(request('/api/dispatch-openings',{method:'POST'}));assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.get('Allow'),'GET');
 assert.deepEqual(router.errors,[]);
});

test('node http glue preserves method, body, headers and every Set-Cookie line',async t=>{
 const router=createPagesRouter({functionsDir:tree(t,synthetic),middleware:false});
 const server=createServer(async(incoming,outgoing)=>{await writeNodeResponse(outgoing,await router.fetch(await nodeRequest(incoming,'http://127.0.0.1')));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const posted=await fetch(base+'/api/plain',{method:'POST',body:'over real http'});assert.equal(await posted.text(),'plain post over real http');
 const cookies=await fetch(base+'/api/cookies');assert.deepEqual(cookies.headers.getSetCookie(),['first=1; Path=/','second=2; Path=/']);
 const echoed=await (await fetch(base+'/api/items/abc?x=1',{method:'DELETE'})).json();assert.deepEqual([echoed.method,echoed.params],['DELETE',{id:'abc'}]);
});

// Handler modules in the shapes the clock rebinding must get right, or refuse.
const clockModules={
 'api/clock/object.js':"export function objectHandlers({now=()=>new Date(),label='production'}={}){return {get:async()=>Response.json({at:now().toISOString(),label}),post:async({request})=>Response.json({at:now().toISOString(),body:await request.text()})};}\nconst handlers=objectHandlers();\nexport const onRequestGet=handlers.get;\nexport const onRequestPost=handlers.post;",
 // Identical closure text with different captured values: only keys may pair them.
 'api/clock/methods.js':"export function methodHandlers({now=()=>new Date()}={}){const method=name=>async()=>Response.json({method:name,at:now().toISOString()});return {get:method('GET'),post:method('POST'),readOnly:method('READ-ONLY')};}\nconst handlers=methodHandlers();\nexport const onRequestGet=handlers.get;\nexport const onRequestPost=handlers.post;\nexport const onRequestPut=handlers.readOnly;",
 'api/clock/single.js':"export function singleHandler({now=()=>new Date()}={}){return async()=>Response.json({at:now().toISOString()});}\nexport const onRequestGet=singleHandler();",
 // Built with arguments: rebuilding with only {now} would drop them, so it is left alone.
 'api/clock/configured.js':"export function configuredHandlers({now=()=>new Date(),label='default'}={}){return {get:async()=>Response.json({at:now().toISOString(),label})};}\nconst handlers=configuredHandlers({label:'production'});\nexport const onRequestGet=handlers.get;",
 'api/clock/wrapped.js':"export function wrappedHandlers({now=()=>new Date()}={}){return {get:async()=>Response.json({at:now().toISOString()})};}\nconst handlers=wrappedHandlers();\nexport async function onRequestGet(context){return handlers.get(context);}",
 'api/clock/async.js':"let calls=0;\nexport async function refresh({now}={}){calls++;throw new Error('refresh must never run while routing');}\nexport const onRequestGet=()=>Response.json({calls});",
 'api/clock/plain.js':"export const onRequestGet=()=>Response.json({at:new Date().toISOString()});",
};
const FIXED='2001-02-03T04:05:06.000Z';

test('an injected clock drives every handler a {now} factory built, per request, and nothing else',async t=>{
 let current=FIXED;
 const functionsDir=tree(t,clockModules),router=createPagesRouter({functionsDir,middleware:false,now:()=>current});
 const json=async(path,init)=>(await router.fetch(request(path,init))).json();
 assert.deepEqual(await json('/api/clock/object'),{at:FIXED,label:'production'});
 assert.deepEqual(await json('/api/clock/object',{method:'POST',body:'synthetic'}),{at:FIXED,body:'synthetic'});
 current='2001-02-04T00:00:00.000Z';
 assert.equal((await json('/api/clock/object')).at,current);
 assert.deepEqual(await json('/api/clock/methods'),{method:'GET',at:current});
 assert.deepEqual(await json('/api/clock/methods',{method:'POST'}),{method:'POST',at:current});
 const put=await json('/api/clock/methods',{method:'PUT'});
 assert.equal(put.method,'READ-ONLY');assert.notEqual(put.at,current);
 assert.equal((await json('/api/clock/single')).at,current);
 const configured=await json('/api/clock/configured');assert.equal(configured.label,'production');assert.notEqual(configured.at,current);
 assert.notEqual((await json('/api/clock/wrapped')).at,current);
 assert.notEqual((await json('/api/clock/plain')).at,current);
 assert.deepEqual(await json('/api/clock/async'),{calls:0});
 assert.deepEqual(await router.clockedRoutes(),{
  clocked:{
   '/api/clock/methods':{factories:['methodHandlers'],rebound:['onRequestGet','onRequestPost'],plain:['onRequestPut']},
   '/api/clock/object':{factories:['objectHandlers'],rebound:['onRequestGet','onRequestPost'],plain:[]},
   '/api/clock/single':{factories:['singleHandler'],rebound:['onRequestGet'],plain:[]},
  },
  unclocked:['/api/clock/configured','/api/clock/wrapped'],
 });
 assert.deepEqual(router.errors,[]);
 const production=createPagesRouter({functionsDir,middleware:false});
 assert.equal(production.now,null);assert.notEqual((await (await production.fetch(request('/api/clock/object'))).json()).at,current);
 await assert.rejects(production.clockedRoutes(),/no injected clock/);
});

test('clock values are validated and copied, and factory calls with arguments are detected',()=>{
 const date=new Date(FIXED),clock=clockOf(date),first=clock();first.setUTCFullYear(1999);
 assert.equal(clock().toISOString(),FIXED);assert.equal(clockOf(Date.parse(FIXED))().toISOString(),FIXED);assert.equal(clockOf(()=>FIXED)().toISOString(),FIXED);
 assert.throws(()=>clockOf('not a time')(),/invalid time/);
 const source="export function xHandlers({now=()=>new Date()}={}){return {};}\nconst a=xHandlers();\nconst b=xHandlers( );\nconst c=xHandlers({label:'x'});\nconst d=other.xHandlers(1);\nconst e=myxHandlers(2);";
 assert.deepEqual(factoryCalls(source,'xHandlers'),['','',"{label:'x'}"]);
});

test('real Hub APIs run on the router clock: records, date rules and default ranges follow it',async t=>{
 const firestore=firestoreMemory();t.mock.method(globalThis,'fetch',firestore.fetch);
 const env={HUB_SESSION_SECRET:'synthetic-pages-router-clock',FIREBASE_API_KEY:'firebase-test-pages-router-clock',HUB_AUTH_USERS_JSON:JSON.stringify({'Crew.One':{passwordHash:await hashHubCredential('Crew.One','Synthetic router clock only!'),displayName:'Synthetic Crew One',role:'crew'}})};
 let current='2026-09-22T12:00:00.000Z';
 const router=createPagesRouter({env,now:()=>current}),cookie=(await createHubSessionCookie(env,'Crew.One')).split(';')[0];
 const post=body=>router.fetch(request('/api/crew-availability',{method:'POST',headers:{Cookie:cookie,Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(body)}));
 const create=date=>post({action:'create',requestId:randomUUID(),changes:{date,allDay:true,reason:'Synthetic personal time'}});
 const saved=await create('2026-09-23');
 const body=await saved.json();assert.equal(saved.status,200,JSON.stringify(body));
 assert.deepEqual([body.record.createdAt,body.record.date,body.record.employee],[current,'2026-09-23','crew.one']);
 assert.equal(firestore.get('jobs/'+body.record.id).createdAt,current);
 current='2026-09-24T12:00:00.000Z';
 const late=await create('2026-09-23');assert.equal(late.status,400);assert.equal((await late.json()).code,'crew_availability_past_date');
 const overview=await (await router.fetch(request('/api/crew-availability',{headers:{Cookie:cookie}}))).json();
 assert.deepEqual([overview.startDate,overview.coverage.asOf],['2026-09-24',current]);
 const {clocked,unclocked}=await router.clockedRoutes();
 assert.deepEqual(unclocked,[],'These routes export a {now} factory but no handler comes from it. Build the module instance with no arguments and export its methods: const handlers=xHandlers(); export const onRequestGet=handlers.get;');
 for(const path of['/api/crew-availability','/api/dispatch','/api/dispatch-openings'])assert.deepEqual(clocked[path]?.plain,[],path);
 assert.deepEqual(router.errors,[]);
});
