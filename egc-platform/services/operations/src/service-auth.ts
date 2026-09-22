/**
 * EGC service authentication v2. This module deliberately uses only standard
 * WebCrypto: the same code runs in Cloudflare Pages and the Node API.
 * Public keys are trusted only through the exact pinned service HTTPS origins.
 */
export type ServiceIdentity = "hub" | "api";
export const SERVICE_ORIGINS = Object.freeze({hub:"https://easygaragecleaning.com",api:"https://egc-api-production-faeb.up.railway.app"});
export const SERVICE_AUTH_KEY_PATHS = Object.freeze({hub:"/api/operations-service-keys",api:"/operations/service-keys"});
export const SERVICE_AUTH_PROTOCOL = "egc-service-auth-v2";
type Actor = {id:string;kind:"human"|"integration";role:"owner"|"manager"|"sales"|"crew_lead"|"crew"|"integration";workspace:string};
type ServiceRequest = {requestId:string;body:Record<string,unknown>};
export type ServiceClaims = {v:2;alg:"EdDSA";kid:string;iss:string;aud:string;workspace:string;iat:number;nbf:number;exp:number;nonce:string;method:"POST";path:string;actor:Actor;request:ServiceRequest};
export type ServicePublicJwk = JsonWebKey & {kty:"OKP";crv:"Ed25519";x:string;kid:string;use:"sig";alg:"EdDSA";key_ops:["verify"]};
export type ServicePublicKeySet = {protocol:typeof SERVICE_AUTH_PROTOCOL;issuer:string;workspace:string;keys:ServicePublicJwk[]};
type RootOptions = {service:ServiceIdentity;rootSecret:string;workspace:string};
type Resolver = (service:ServiceIdentity,workspace:string,kid:string)=>Promise<ServicePublicJwk>;
const encoder=new TextEncoder();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
export class ServiceAuthenticationError extends Error {code:string;status:number;constructor(code:string,status=401){super(code);this.name="ServiceAuthenticationError";this.code=code;this.status=status;}}
const fail=(code="invalid_service_signature",status=401):never=>{throw new ServiceAuthenticationError(code,status);};
function b64(bytes:Uint8Array){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function unb64(value:string){if(!/^[A-Za-z0-9_-]+$/.test(value))return fail();try{const bytes=Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((value.length+3)%4)),c=>c.charCodeAt(0));if(b64(bytes)!==value)return fail();return bytes;}catch{return fail();}}
const counterpart=(service:ServiceIdentity):ServiceIdentity=>service==="hub"?"api":"hub";
const bytes=(value:Uint8Array):ArrayBuffer=>value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength) as ArrayBuffer;
function validateRoot(options:RootOptions){if(!["hub","api"].includes(options.service)||options.workspace!=="egc"||typeof options.rootSecret!=="string"||options.rootSecret.length<32||options.rootSecret.length>8192)fail("service_signing_not_configured",503);}
async function signingKey(options:RootOptions){
  validateRoot(options);
  const material=await crypto.subtle.importKey("raw",encoder.encode(options.rootSecret),"HKDF",false,["deriveBits"]);
  const seed=new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt:encoder.encode("egc/service-auth/v2/ed25519/seed"),info:encoder.encode(JSON.stringify({service:options.service,origin:SERVICE_ORIGINS[options.service],workspace:options.workspace,purpose:"signed-service-request",version:2}))},material,256));
  // RFC 8410 PKCS#8 wrapping of the 32-byte RFC 8032 Ed25519 seed.
  const pkcs8=new Uint8Array(48);pkcs8.set([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);pkcs8.set(seed,16);
  try{return await crypto.subtle.importKey("pkcs8",bytes(pkcs8),"Ed25519",true,["sign"]);}finally{seed.fill(0);pkcs8.fill(0);}
}
async function publicJwk(options:RootOptions,key:CryptoKey):Promise<ServicePublicJwk>{
  const exported=await crypto.subtle.exportKey("jwk",key);
  if(!exported.x)fail("service_key_unavailable",503);
  const x=exported.x!;
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes(unb64(x))));
  const kid=`${options.service}-v2-${[...hash].map(v=>v.toString(16).padStart(2,"0")).join("").slice(0,32)}`;
  // Explicit allowlist: exporting a private key to JWK must NEVER publish d.
  return {kty:"OKP",crv:"Ed25519",x,kid,use:"sig",alg:"EdDSA",key_ops:["verify"]};
}
export async function servicePublicKeySet(options:RootOptions):Promise<ServicePublicKeySet>{const key=await signingKey(options);return{protocol:SERVICE_AUTH_PROTOCOL,issuer:SERVICE_ORIGINS[options.service],workspace:options.workspace,keys:[await publicJwk(options,key)]};}
function validateClaims(value:unknown,service:ServiceIdentity,workspace:string,path:string,now:number):ServiceClaims{
  if(!exact(value,["v","alg","kid","iss","aud","workspace","iat","nbf","exp","nonce","method","path","actor","request"]))return fail("invalid_service_claims");
  const c=value as ServiceClaims,from=counterpart(service);
  if(c.v!==2||c.alg!=="EdDSA"||c.iss!==SERVICE_ORIGINS[from]||c.aud!==SERVICE_ORIGINS[service]||workspace!=="egc"||c.workspace!==workspace||c.method!=="POST"||c.path!==path||!/^\/[a-z0-9/-]{1,100}$/.test(path)||!new RegExp(`^${from}-v2-[a-f0-9]{32}$`).test(c.kid)||typeof c.nonce!=="string"||!uuid.test(c.nonce))return fail("invalid_service_claims");
  if(![c.iat,c.nbf,c.exp].every(Number.isInteger)||c.nbf!==c.iat-5||c.exp!==c.iat+60||c.iat>Math.floor(now/1000)+5||c.nbf>Math.floor(now/1000)||c.exp<=Math.floor(now/1000))return fail("service_signature_expired");
  if(!exact(c.actor,["id","kind","role","workspace"])||typeof c.actor.id!=="string"||!/^[A-Za-z0-9_:@.\-]{1,200}$/.test(c.actor.id)||c.actor.workspace!==workspace||!["human","integration"].includes(c.actor.kind)||!["owner","manager","sales","crew_lead","crew","integration"].includes(c.actor.role)||(c.actor.kind==="integration")!==(c.actor.role==="integration"))return fail("invalid_service_actor");
  if(!exact(c.request,["requestId","body"])||typeof c.request.requestId!=="string"||!uuid.test(c.request.requestId)||!c.request.body||typeof c.request.body!=="object"||Array.isArray(c.request.body))return fail("invalid_service_request");
  return c;
}
export async function signServiceRequest(options:RootOptions&{path:string;actor:Actor;request:ServiceRequest;now?:number}):Promise<string>{
  const key=await signingKey(options),jwk=await publicJwk(options,key),iat=Math.floor((options.now??Date.now())/1000);
  const claims:ServiceClaims={v:2,alg:"EdDSA",kid:jwk.kid,iss:SERVICE_ORIGINS[options.service],aud:SERVICE_ORIGINS[counterpart(options.service)],workspace:options.workspace,iat,nbf:iat-5,exp:iat+60,nonce:crypto.randomUUID(),method:"POST",path:options.path,actor:options.actor,request:options.request};
  validateClaims(claims,counterpart(options.service),options.workspace,options.path,options.now??Date.now());
  const payload=b64(encoder.encode(JSON.stringify(claims)));if(payload.length>199900)fail("service_request_too_large",413);
  return payload+"."+b64(new Uint8Array(await crypto.subtle.sign("Ed25519",key,encoder.encode(payload))));
}
export function createServiceKeyResolver(options:{fetcher?:typeof fetch;ttlMs?:number;now?:()=>number}={}):Resolver{
  const fetcher=options.fetcher??fetch,clock=options.now??Date.now,ttl=Math.min(60000,Math.max(1000,options.ttlMs??60000));
  const cache=new Map<string,{key:ServicePublicJwk;until:number}>(),pending=new Map<string,Promise<ServicePublicJwk>>();
  async function load(service:ServiceIdentity,workspace:string):Promise<ServicePublicJwk>{
    const url=SERVICE_ORIGINS[service]+SERVICE_AUTH_KEY_PATHS[service];
    // Workers does not implement redirect:"error". Manual mode plus a strict
    // success status/URL check prevents redirects in BOTH supported runtimes.
    let response:Response;try{response=await fetcher(url,{method:"GET",redirect:"manual",headers:{accept:"application/json"},signal:AbortSignal.timeout(5000)});}catch{return fail("service_key_source_unavailable",503);}
    if(!response.ok||!response.headers.get("content-type")?.includes("application/json")||response.url&&response.url!==url)return fail("service_key_source_unavailable",503);
    const raw=await response.text();if(raw.length>8192)return fail("invalid_service_public_key",503);
    let set:ServicePublicKeySet;try{set=JSON.parse(raw);}catch{return fail("invalid_service_public_key",503);}
    if(!exact(set,["protocol","issuer","workspace","keys"])||set.protocol!==SERVICE_AUTH_PROTOCOL||set.issuer!==SERVICE_ORIGINS[service]||set.workspace!==workspace||!Array.isArray(set.keys)||set.keys.length!==1)return fail("invalid_service_public_key",503);
    const key=set.keys[0]!;
    if(!exact(key,["kty","crv","x","kid","use","alg","key_ops"])||key.kty!=="OKP"||key.crv!=="Ed25519"||key.use!=="sig"||key.alg!=="EdDSA"||!Array.isArray(key.key_ops)||key.key_ops.length!==1||key.key_ops[0]!=="verify"||typeof key.x!=="string"||unb64(key.x).length!==32||!new RegExp(`^${service}-v2-[a-f0-9]{32}$`).test(key.kid))return fail("invalid_service_public_key",503);
    const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes(unb64(key.x))));
    if(key.kid!==`${service}-v2-${[...digest].map(v=>v.toString(16).padStart(2,"0")).join("").slice(0,32)}`)return fail("invalid_service_public_key",503);
    cache.set(service+":"+workspace,{key,until:clock()+ttl});return key;
  }
  return async(service,workspace,kid)=>{
    if(!["hub","api"].includes(service)||workspace!=="egc")return fail("invalid_service_key_source");
    const id=service+":"+workspace,cached=cache.get(id);
    // Unknown kids do not trigger attacker-controlled fetch storms. Rotation is
    // picked up at the short cache expiry; callers safely retry a fresh envelope.
    if(cached&&cached.until>clock()){if(cached.key.kid!==kid)return fail("unknown_service_key");return cached.key;}
    let task=pending.get(id);if(!task){task=load(service,workspace).finally(()=>pending.delete(id));pending.set(id,task);}
    const key=await task;if(key.kid!==kid)return fail("unknown_service_key");return key;
  };
}
let defaultResolver:Resolver|undefined;
export async function verifyServiceRequest(token:unknown,options:{service:ServiceIdentity;workspace:string;path:string;consumeNonce:(issuer:string,nonce:string,expiresAt:number)=>Promise<boolean>;now?:number;resolveKey?:Resolver}):Promise<ServiceClaims>{
  if(typeof token!=="string"||token.length>200000)return fail();const parts=token.split(".");if(parts.length!==2)return fail();
  const payload=parts[0]!,signature=unb64(parts[1]!);if(signature.length!==64)return fail();
  let parsed:unknown;try{parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(unb64(payload)));}catch{return fail();}
  const claims=validateClaims(parsed,options.service,options.workspace,options.path,options.now??Date.now());
  const resolve=options.resolveKey??(defaultResolver??=createServiceKeyResolver());
  const jwk=await resolve(counterpart(options.service),options.workspace,claims.kid);
  const key=await crypto.subtle.importKey("jwk",jwk,"Ed25519",false,["verify"]);
  if(!await crypto.subtle.verify("Ed25519",key,bytes(signature),encoder.encode(payload)))return fail();
  // No work, including reads, runs unless a durable store atomically claims this
  // nonce. Unknown outcomes retry with a fresh envelope and the SAME requestId.
  let consumed:boolean;try{consumed=await options.consumeNonce(claims.iss,claims.nonce,claims.exp);}catch{return fail("service_replay_store_unavailable",503);}
  if(consumed!==true)return fail("service_request_replayed",409);
  return claims;
}
