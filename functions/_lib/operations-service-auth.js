import {SERVICE_ORIGINS,servicePublicKeySet,signServiceRequest,verifyServiceRequest} from '../../egc-platform/services/operations/src/service-auth.ts';
import {signOperationsEnvelope,verifyOperationsEnvelope} from './operations-envelope.js';
import {firestoreFetch} from './firebase-service-account.js';
const ROOT='projects/egcw-1ec83/databases/(default)/documents';
const FIRESTORE_URL=`https://firestore.googleapis.com/v1/${ROOT}`;
const COLLECTION='operations_service_nonces';
const fail=(code,status=503)=>Object.assign(new Error(code),{code,status});
const validRoot=env=>typeof env.HUB_SESSION_SECRET==='string'&&env.HUB_SESSION_SECRET.length>=32&&env.HUB_SESSION_SECRET.length<=8192;
export function operationsAuthMode(env){
  const mode=env.EGC_OPERATIONS_SERVICE_AUTH;
  if(mode&& !['v2','legacy'].includes(mode))throw fail('operations_auth_mode_invalid');
  return mode||(validRoot(env)?'v2':'legacy');
}
export function operationsEnabled(env){
  if(env.EGC_OPERATIONS_ENABLED==='false')return false;
  if(env.EGC_OPERATIONS_ENABLED!==undefined&&env.EGC_OPERATIONS_ENABLED!=='true')return false;
  try{return operationsAuthMode(env)==='v2'?validRoot(env):env.EGC_OPERATIONS_ENABLED==='true';}catch{return false;}
}
export function operationsApiOrigin(env){
  const mode=operationsAuthMode(env),value=env.EGC_OPERATIONS_API_ORIGIN||(mode==='v2'?SERVICE_ORIGINS.api:'');
  let origin;try{origin=new URL(value);}catch{throw fail('operations_bridge_not_configured');}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||mode==='v2'&&origin.origin!==SERVICE_ORIGINS.api)throw fail('operations_bridge_not_configured');
  return origin;
}
export async function signPortalServiceEnvelope(env,{actor,request,path,audience='egc-operations'}){
  if(env.EGC_OPERATIONS_ENABLED==='false')throw fail('operations_not_enabled');
  operationsApiOrigin(env);
  if(operationsAuthMode(env)==='v2')return signServiceRequest({service:'hub',rootSecret:env.HUB_SESSION_SECRET,workspace:env.EGC_OPERATIONS_WORKSPACE||'egc',path,actor,request});
  return signOperationsEnvelope({v:1,iss:'portal',aud:audience,iat:Math.floor(Date.now()/1000),nonce:crypto.randomUUID(),actor,request},env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET);
}
export async function portalServicePublicKeys(env){
  if(!operationsEnabled(env)||operationsAuthMode(env)!=='v2')throw fail('service_signing_not_configured');
  return servicePublicKeySet({service:'hub',rootSecret:env.HUB_SESSION_SECRET,workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'});
}
/** Atomic create-only nonce receipt in a dedicated collection; never in jobs. */
export async function consumePortalServiceNonce(env,issuer,nonce,expiresAt,fetcher=firestoreFetch){
  if(issuer!==SERVICE_ORIGINS.api||!/^[a-f0-9-]{36}$/i.test(nonce)||!Number.isInteger(expiresAt))throw fail('invalid_service_nonce');
  const name=`${ROOT}/${COLLECTION}/api_${nonce}`;
  const fields={issuer:{stringValue:issuer},nonce:{stringValue:nonce},expiresAt:{timestampValue:new Date(expiresAt*1000).toISOString()},createdAt:{timestampValue:new Date().toISOString()}};
  const r=await fetcher(env,`${FIRESTORE_URL}:commit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({writes:[{update:{name,fields},currentDocument:{exists:false}}]}),signal:AbortSignal.timeout(10000)});
  if(r.status===409||r.status===412)return false;
  if(!r.ok)throw fail('service_replay_store_unavailable');
  // Expired receipts cannot authorize anything. Periodically remove a bounded
  // batch so operation does not depend on separately configuring a TTL policy.
  if(nonce.endsWith('0'))await cleanupExpiredPortalServiceNonces(env,fetcher).catch(()=>{});
  return true;
}
export async function cleanupExpiredPortalServiceNonces(env,fetcher=firestoreFetch,now=Date.now()){
  const r=await fetcher(env,`${FIRESTORE_URL}:runQuery`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({structuredQuery:{from:[{collectionId:COLLECTION}],where:{fieldFilter:{field:{fieldPath:'expiresAt'},op:'LESS_THAN',value:{timestampValue:new Date(now-600000).toISOString()}}},limit:100}}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)return 0;const rows=await r.json();if(!Array.isArray(rows))return 0;
  const docs=rows.map(x=>x.document).filter(d=>d&&typeof d.name==='string'&&d.name.startsWith(`${ROOT}/${COLLECTION}/api_`)&&d.updateTime);
  if(!docs.length)return 0;
  const deleted=await fetcher(env,`${FIRESTORE_URL}:commit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({writes:docs.map(d=>({delete:d.name,currentDocument:{updateTime:d.updateTime}}))}),signal:AbortSignal.timeout(10000)});
  return deleted.ok?docs.length:0;
}
export async function verifyApiServiceEnvelope(env,token,path,options={}){
  if(!operationsEnabled(env))throw fail('operations_not_enabled');
  if(operationsAuthMode(env)==='v2')return verifyServiceRequest(token,{service:'hub',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc',path,consumeNonce:(issuer,nonce,expiry)=>consumePortalServiceNonce(env,issuer,nonce,expiry,options.firestoreFetch),...(options.resolveKey?{resolveKey:options.resolveKey}:{}),...(options.now?{now:options.now}:{})});
  return verifyOperationsEnvelope(token,env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET,'egc-portal');
}
