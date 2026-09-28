// Cloudflare Pages Functions routing for tests: every functions/api/**/*.js file
// becomes a route with no harness edits, dispatched with a Pages-shaped context.
// Pass `now` to run every handler that comes from a clock-injectable factory on
// that clock instead of the real one (see clockedModule below).
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const FUNCTIONS=fileURLToPath(new URL('../../functions/',import.meta.url));
const METHODS=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'];
const handlerName=method=>'onRequest'+method[0]+method.slice(1).toLowerCase();
const segmentOf=name=>/^\[\[([A-Za-z_$][\w$]*)\]\]$/.test(name)?{kind:'rest',name:name.slice(2,-2)}:/^\[([A-Za-z_$][\w$]*)\]$/.test(name)?{kind:'param',name:name.slice(1,-1)}:{kind:'static',name};
const label=segment=>segment.kind==='rest'?`:${segment.name}*`:segment.kind==='param'?`:${segment.name}`:segment.name;

// Pages order: more segments first, static before [param] before [[rest]], then by path.
export function compareRoutes(a,b){
 if(a.segments.length!==b.segments.length)return b.segments.length-a.segments.length;
 const rank={static:0,param:1,rest:2};
 for(let index=0;index<a.segments.length;index++){const difference=rank[a.segments[index].kind]-rank[b.segments[index].kind];if(difference)return difference;}
 return a.path.localeCompare(b.path);
}

export function discoverRoutes({functionsDir=FUNCTIONS,mount='api'}={}){
 const base=join(functionsDir,mount),routes=[],middleware=new Map();
 const walk=directory=>{
  for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   const file=join(directory,entry.name);
   if(entry.isDirectory()){if(!entry.name.startsWith('_')&&!entry.name.startsWith('.'))walk(file);continue;}
   if(!entry.isFile()||!/\.m?js$/.test(entry.name))continue;
   const name=entry.name.replace(/\.m?js$/,'');
   if(name==='_middleware'){middleware.set(directory,file);continue;}
   if(name.startsWith('_')||name.startsWith('.'))continue;
   const parts=relative(functionsDir,file).split(sep).slice(0,-1).concat(name==='index'?[]:[name]),segments=parts.map(segmentOf);
   if(segments.slice(0,-1).some(segment=>segment.kind==='rest'))throw new Error(`Catch-all segments must be last: ${file}`);
   routes.push({path:'/'+segments.map(label).join('/'),segments,file});
  }
 };
 try{if(!statSync(base).isDirectory())throw new Error();}catch{throw new Error(`Pages Functions directory not found: ${base}`);}
 walk(base);
 const paths=new Set();
 for(const route of routes){if(paths.has(route.path))throw new Error(`Two files map to ${route.path}`);paths.add(route.path);}
 const above=relative(functionsDir,base).split(sep).slice(0,-1);
 for(const directory of[functionsDir,...above.map((_,index)=>join(functionsDir,...above.slice(0,index+1)))]){
  for(const candidate of['_middleware.js','_middleware.mjs']){try{if(statSync(join(directory,candidate)).isFile())middleware.set(directory,join(directory,candidate));}catch{}}
 }
 return {routes:routes.sort(compareRoutes),middleware};
}

// A fixed instant (Date, ISO string or epoch ms) or a function returning one
// becomes a function that returns a fresh Date on every call.
export function clockOf(now){
 const read=typeof now==='function'?now:()=>now;
 return ()=>{const value=read(),date=value instanceof Date?new Date(value.getTime()):new Date(value);if(Number.isNaN(date.getTime()))throw new TypeError(`The injected clock returned an invalid time: ${String(value)}`);return date;};
}

// Text between a function's first "(" and its matching ")": the parameter list.
export function parameterSource(fn){
 const source=Function.prototype.toString.call(fn),open=source.indexOf('(');
 if(open<0)return '';
 let depth=0,quote='';
 for(let index=open;index<source.length;index++){
  const char=source[index];
  if(quote){if(char==='\\')index++;else if(char===quote)quote='';continue;}
  if(char==='"'||char==="'"||char==='`'){quote=char;continue;}
  if('([{'.includes(char))depth++;
  else if(')]}'.includes(char)&&--depth===0)return source.slice(open+1,index);
 }
 return '';
}

// A handler factory is any exported, synchronous, non-handler function whose
// first parameter destructures `now`, the tests-ci convention:
// dispatchHandlers({session,storage,now}), createCustomerPortalHandlers({now,read}),
// jobPaymentVerifier({now}). Async functions are never called.
export const clockFactory=(name,value)=>typeof value==='function'&&!/^onRequest/.test(name)&&!/^(?:Async)?GeneratorFunction$|^AsyncFunction$/.test(value.constructor?.name)&&/^\s*\{(?:[^]*?[{,])?\s*now\s*(?:[=,}:]|$)/.test(parameterSource(value));
const HANDLER_EXPORT=/^onRequest(?:Get|Head|Post|Put|Patch|Delete|Options)?$/;
const textOf=fn=>Function.prototype.toString.call(fn);
// Names a factory result may use for the handler behind an export.
const twinKeys=name=>{const method=name.slice(9);return method?[name,method.toLowerCase(),method.toUpperCase(),'handle'+method]:[name,'handler','handle','fetch'];};

// Every call of `name(` in the module source outside its own declaration.
// Rebuilding a factory with only {now} is faithful when the production instance
// was built with no arguments (`const handlers=xHandlers();`), so any call with
// arguments leaves that factory's handlers on production behavior.
export function factoryCalls(source,name){
 const escaped=name.replace(/[$]/g,'\\$&');
 return [...source.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\s*\\(([^)]*)\\)`,'g'))].filter(match=>!/\bfunction\s*\*?\s*$/.test(source.slice(Math.max(0,match.index-40),match.index))).map(match=>match[1].trim());
}

// The clocked instance's function that is the same closure as a production
// export: first under a matching key (onRequestGet/get/GET, a single-function
// factory result) with identical source text, else the only function with that
// text across every instance. Two closures with the same text but different
// captured values (a method-maker like m=>ctx=>run(ctx,m)) are never guessed.
function twinOf(name,value,instances){
 const text=textOf(value),same=candidate=>typeof candidate==='function'&&textOf(candidate)===text;
 for(const instance of instances){
  if(typeof instance==='function'){if(same(instance))return instance;continue;}
  for(const key of twinKeys(name))if(same(instance[key]))return instance[key];
 }
 const matches=new Set(instances.flatMap(instance=>typeof instance==='function'?[instance]:Object.values(instance)).filter(same));
 return matches.size===1?[...matches][0]:null;
}

// Rebuild each clock factory with {now:clock} and swap every exported onRequest*
// for its twin from the clocked instance. Only `now` is injected; session,
// storage and other dependencies keep their production defaults. Exports no
// factory made (plain module functions) stay as they are and are listed in
// `plain`, so a test can see exactly which handlers read the injected clock.
export function clockedModule(module,clock,{source=''}={}){
 const found=Object.entries(module).filter(([name,value])=>clockFactory(name,value)).map(([name])=>name);
 const skipped=source?found.filter(name=>factoryCalls(source,name).some(args=>args!=='')):[];
 const factories=found.filter(name=>!skipped.includes(name)),instances=[];
 for(const name of factories){
  let instance;
  try{instance=module[name]({now:clock});}catch(error){throw new Error(`${name}({now}) threw while building clocked handlers: ${error?.message||error}`);}
  if(typeof instance?.then==='function'){Promise.resolve(instance).catch(()=>{});continue;}
  if(typeof instance==='function'||instance&&typeof instance==='object')instances.push(instance);
 }
 const clocked={...module},rebound=[],plain=[];
 for(const [name,value] of Object.entries(module)){
  if(!HANDLER_EXPORT.test(name)||typeof value!=='function')continue;
  const twin=instances.length?twinOf(name,value,instances):null;
  if(twin&&twin!==value){clocked[name]=twin;rebound.push(name);}else plain.push(name);
 }
 return {module:rebound.length?clocked:module,factories:found,skipped,rebound:rebound.sort(),plain:plain.sort()};
}

export function matchRoute(route,pathname){
 const parts=pathname.replace(/^\/+/,'').split('/');
 if(parts.at(-1)==='')parts.pop();
 const params={};
 for(let index=0;index<route.segments.length;index++){
  const segment=route.segments[index];
  if(segment.kind==='rest'){const rest=parts.slice(index);if(!rest.length||rest.some(part=>!part))return null;params[segment.name]=rest.map(decodeURIComponent);return params;}
  const part=parts[index];
  if(part===undefined||!part)return null;
  if(segment.kind==='static'){if(part!==segment.name)return null;}
  else params[segment.name]=decodeURIComponent(part);
 }
 return parts.length===route.segments.length?params:null;
}

// middleware: true runs functions/_middleware.js (and nested ones) around every
// /<mount>/ request exactly as Pages would; pass false to call handlers bare.
// now: a Date, ISO string, epoch ms or a function returning one. Handlers built
// by a clock-injectable factory then read it instead of the real clock; omit it
// (or pass null/false) to run the module exports exactly as production does.
export function createPagesRouter({functionsDir=FUNCTIONS,mount='api',middleware=true,env:defaultEnv={},now=null,importer=file=>import(pathToFileURL(file).href)}={}){
 const {routes,middleware:middlewareFiles}=discoverRoutes({functionsDir,mount}),modules=new Map(),background=[],errors=[],clocks=new Map();
 const clock=now===null||now===undefined||now===false?null:clockOf(now);
 const load=file=>{
  if(!modules.has(file))modules.set(file,Promise.resolve(importer(file)).then(module=>{
   if(!clock)return module;
   let source='';try{source=readFileSync(file,'utf8');}catch{}
   const result=clockedModule(module,clock,{source});clocks.set(file,result);return result.module;
  }));
  return modules.get(file);
 };
 // Which routes run on the injected clock. clocked: {path:{factories,rebound,plain}}
 // where plain lists handler exports that still run as production does.
 // unclocked: routes that export a factory taking `now` but none of whose
 // handlers came from it (or whose factory is built with arguments), so an
 // acceptance test through them would silently read the real clock.
 async function clockedRoutes(){
  if(!clock)throw new Error('This router has no injected clock; pass createPagesRouter({now}).');
  const clocked={},unclocked=[];
  for(const route of routes){
   await load(route.file);const {factories=[],rebound=[],plain=[]}=clocks.get(route.file)||{};
   if(rebound.length)clocked[route.path]={factories,rebound,plain};else if(factories.length)unclocked.push(route.path);
  }
  return {clocked,unclocked};
 }
 const prefix='/'+mount;
 const handles=pathname=>pathname===prefix||pathname.startsWith(prefix+'/');
 const chain=route=>{
  if(!middleware)return [];
  const parts=route?relative(functionsDir,route.file).split(sep).slice(0,-1):mount.split('/');
  return [functionsDir,...parts.map((_,index)=>join(functionsDir,...parts.slice(0,index+1)))].map(directory=>middlewareFiles.get(directory)).filter(Boolean);
 };
 const pick=(module,method)=>module[handlerName(method)]||module.onRequest;
 async function resolve(pathname,method){
  let pathMatched=null;const allowed=new Set();
  for(const route of routes){
   const params=matchRoute(route,pathname);if(!params)continue;
   const module=await load(route.file),handler=pick(module,method);
   pathMatched||={route,params};
   if(handler)return {route,params,handler:[].concat(handler)};
   for(const candidate of METHODS)if(module[handlerName(candidate)]||module.onRequest)allowed.add(candidate);
  }
  return pathMatched?{...pathMatched,allowed:[...allowed]}:null;
 }
 async function dispatch(input,env=defaultEnv,{waitUntil}={}){
  const request=input instanceof Request?input:new Request(input);
  const {pathname}=new URL(request.url);
  if(!handles(pathname))throw new Error(`The Pages router only serves ${prefix}/*, not ${pathname}`);
  const resolved=await resolve(pathname,request.method);
  const terminal=resolved?.handler||[()=>resolved?new Response('Method Not Allowed',{status:405,headers:{Allow:resolved.allowed.join(', ')}}):new Response('Not Found',{status:404})];
  const layers=[];
  for(const file of chain(resolved?.route)){const module=await load(file),handler=pick(module,request.method);if(handler)layers.push(...[].concat(handler));}
  layers.push(...terminal);
  const data={},params=resolved?.params||{},functionPath=resolved?.route.path||pathname;
  const collect=waitUntil||(promise=>{background.push(Promise.resolve(promise));});
  let index=0,current=request;
  const next=async(input,init)=>{
   if(input!==undefined)current=input instanceof Request&&init===undefined?input:new Request(input,init);
   const layer=layers[index++];
   if(!layer)throw new Error('next() was called after the final Pages handler');
   return layer({request:current,env,params,data,functionPath,next,waitUntil:collect,passThroughOnException(){}});
  };
  try{
   const response=await next();
   if(!(response instanceof Response))throw new TypeError(`${functionPath} did not return a Response`);
   return response;
  }catch(error){errors.push({path:pathname,method:request.method,stack:error?.stack||String(error)});return new Response('Synthetic Pages router: the function threw',{status:500});}
 }
 async function settle(){
  const results=[];
  while(background.length)results.push(...await Promise.allSettled(background.splice(0)));
  return results;
 }
 return {routes,prefix,handles,match:pathname=>{for(const route of routes){const params=matchRoute(route,pathname);if(params)return {route,params};}return null;},fetch:dispatch,settle,background,errors,now:clock,clockedRoutes};
}

// Node http glue so a createServer() harness can hand requests to the router.
export async function nodeRequest(incoming,base){
 const chunks=[];for await(const part of incoming)chunks.push(part);
 const body=Buffer.concat(chunks),headers=new Headers();
 for(const [key,value] of Object.entries(incoming.headers))if(value!==undefined)for(const item of[].concat(value))headers.append(key,item);
 return new Request(new URL(incoming.url,base),{method:incoming.method,headers,...(body.length&&!['GET','HEAD'].includes(incoming.method)?{body}:{})});
}

export async function writeNodeResponse(outgoing,response){
 const headers={};
 for(const [key,value] of response.headers)if(key!=='set-cookie')headers[key]=value;
 const cookies=response.headers.getSetCookie();if(cookies.length)headers['set-cookie']=cookies;
 const body=Buffer.from(await response.arrayBuffer());
 outgoing.writeHead(response.status,headers);outgoing.end(body);
 return body;
}
