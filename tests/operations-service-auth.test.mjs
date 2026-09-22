import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicKey,verify as nodeVerify} from 'node:crypto';
import {SERVICE_ORIGINS,SERVICE_AUTH_KEY_PATHS,servicePublicKeySet,signServiceRequest,verifyServiceRequest,createServiceKeyResolver} from '../egc-platform/services/operations/src/service-auth.ts';
import {operationsEnabled,operationsAuthMode,operationsApiOrigin,signPortalServiceEnvelope,verifyApiServiceEnvelope,consumePortalServiceNonce,cleanupExpiredPortalServiceNonces} from '../functions/_lib/operations-service-auth.js';
import {signOperationsEnvelope} from '../functions/_lib/operations-envelope.js';
import {onRequestGet as publicKeys} from '../functions/api/operations-service-keys.js';
const secret='synthetic-isolated-service-auth-test-root-not-production';
const actor={id:'zacb',kind:'human',role:'owner',workspace:'egc'};
const request={requestId:'a704ab81-a755-4ccf-91dd-a14d304cf175',body:{command:'calendar'}};
const now=Date.parse('2026-09-22T07:00:00Z');
const options={service:'api',rootSecret:secret,workspace:'egc',path:'/api/operations-portal',actor,request,now};
const claims=token=>JSON.parse(Buffer.from(token.split('.')[0],'base64url'));
const replace=(token,patch)=>Buffer.from(JSON.stringify({...claims(token),...patch})).toString('base64url')+'.'+token.split('.')[1];
async function verifier(service='hub',extra={}){const keys=await servicePublicKeySet({...options,service:service==='hub'?'api':'hub'});return{service,workspace:'egc',path:service==='hub'?'/api/operations-portal':'/operations/rpc',now,resolveKey:async()=>keys.keys[0],consumeNonce:async()=>true,...extra};}

test('independent HKDF service keys are stable, purpose separated, public only',async()=>{
  const api=await servicePublicKeySet(options),hub=await servicePublicKeySet({...options,service:'hub'});
  assert.deepEqual(api,await servicePublicKeySet(options));assert.notEqual(api.keys[0].x,hub.keys[0].x);
  assert.equal(api.issuer,SERVICE_ORIGINS.api);assert.equal(api.protocol,'egc-service-auth-v2');
  assert.deepEqual(Object.keys(api.keys[0]).sort(),['alg','crv','key_ops','kid','kty','use','x']);assert.ok(!JSON.stringify(api).includes(secret));assert.equal(api.keys[0].d,undefined);
  assert.notEqual(api.keys[0].kid,(await servicePublicKeySet({...options,rootSecret:secret+'rotated'})).keys[0].kid);
  await assert.rejects(servicePublicKeySet({...options,rootSecret:'short'}),/service_signing_not_configured/);
});
test('WebCrypto Ed25519 signatures verify through independent Node crypto and both transport directions',async()=>{
  const token=await signServiceRequest(options),key=(await servicePublicKeySet(options)).keys[0],[payload,sig]=token.split('.');
  assert.equal(nodeVerify(null,Buffer.from(payload),createPublicKey({key,format:'jwk'}),Buffer.from(sig,'base64url')),true);
  const verified=await verifyServiceRequest(token,await verifier());assert.equal(verified.v,2);assert.equal(verified.actor.id,'zacb');assert.deepEqual(verified.request,request);
  const reverse=await signServiceRequest({...options,service:'hub',path:'/operations/rpc'});
  assert.equal((await verifyServiceRequest(reverse,await verifier('api'))).iss,SERVICE_ORIGINS.hub);
});
test('path, audience, issuer, workspace, method and extra claims fail before public key fetch',async()=>{
  const token=await signServiceRequest(options);let calls=0;const verify=await verifier('hub',{resolveKey:async()=>{calls++;throw Error('should not fetch');}});
  for(const patch of [{path:'/api/operations-recording-approval'},{iss:'https://evil.example'},{aud:'https://evil.example'},{workspace:'other'},{method:'GET'},{jku:'https://evil.example/key'},{v:1}])await assert.rejects(verifyServiceRequest(replace(token,patch),verify),/invalid_service_claims/);
  assert.equal(calls,0);
});
test('signature tampering, malformed base64, expiry and future issue time never claim nonce',async()=>{
  const token=await signServiceRequest(options);let consumed=0;const verify=await verifier('hub',{consumeNonce:async()=>{consumed++;return true;}});
  await assert.rejects(verifyServiceRequest(replace(token,{actor:{...actor,id:'other'}}),verify),/invalid_service_signature/);
  await assert.rejects(verifyServiceRequest(token+'=',verify),/invalid_service_signature/);
  await assert.rejects(verifyServiceRequest(token,{...verify,now:now+60000}),/service_signature_expired/);
  await assert.rejects(verifyServiceRequest(token,{...verify,now:now-6000}),/service_signature_expired/);
  assert.equal(consumed,0);
});
test('atomic nonce replay rejection and failed storage fail closed; fresh envelope preserves durable request ID',async()=>{
  const seen=new Set();const consumeNonce=async(iss,nonce,exp)=>{assert.equal(iss,SERVICE_ORIGINS.api);assert.equal(exp,now/1000+60);if(seen.has(nonce))return false;seen.add(nonce);return true;};
  const token=await signServiceRequest(options),verify=await verifier('hub',{consumeNonce});
  const outcomes=await Promise.allSettled([verifyServiceRequest(token,verify),verifyServiceRequest(token,verify)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.match(outcomes.find(x=>x.status==='rejected').reason.message,/service_request_replayed/);
  const retry=await signServiceRequest(options);assert.notEqual(claims(token).nonce,claims(retry).nonce);assert.equal((await verifyServiceRequest(retry,verify)).request.requestId,request.requestId);
  await assert.rejects(verifyServiceRequest(retry,{...verify,consumeNonce:async()=>{throw Error('private storage details');}}),/service_replay_store_unavailable/);
});
test('recording requests bind audio digest and upload endpoint without altering body',async()=>{
  const body={command:'recording.upload',portalJobId:'job-1',audioSha256:'a'.repeat(64)};
  const token=await signServiceRequest({...options,service:'hub',path:'/recordings/upload',request:{...request,body}}),verify=await verifier('api',{path:'/recordings/upload'});
  assert.deepEqual((await verifyServiceRequest(token,verify)).request.body,body);
  await assert.rejects(verifyServiceRequest(token,{...verify,path:'/recordings/rpc'}),/invalid_service_claims/);
  await assert.rejects(verifyServiceRequest(replace(token,{request:{...request,body:{...body,audioSha256:'b'.repeat(64)}}}),verify),/invalid_service_signature/);
});
test('actor role and kind must agree; transport carries crew while endpoint authorization remains separate',async()=>{
  await assert.rejects(signServiceRequest({...options,actor:{...actor,kind:'integration'}}),/invalid_service_actor/);
  await assert.rejects(signServiceRequest({...options,actor:{...actor,workspace:'other'}}),/invalid_service_actor/);
  const crew=await signServiceRequest({...options,actor:{...actor,role:'crew'}});assert.equal((await verifyServiceRequest(crew,await verifier())).actor.role,'crew');
});
test('key discovery is pinned, redirect forbidden, cached briefly and unknown kids do not cause fetch storms',async()=>{
  const set=await servicePublicKeySet(options);let clock=now,calls=0;const resolve=createServiceKeyResolver({now:()=>clock,ttlMs:1000,fetcher:async(url,init)=>{calls++;assert.equal(url,SERVICE_ORIGINS.api+SERVICE_AUTH_KEY_PATHS.api);assert.equal(init.redirect,'manual');return Response.json(set);}});
  assert.deepEqual(await resolve('api','egc',set.keys[0].kid),set.keys[0]);assert.equal(calls,1);
  await assert.rejects(resolve('api','egc','api-v2-'+'0'.repeat(32)),/unknown_service_key/);assert.equal(calls,1);
  await resolve('api','egc',set.keys[0].kid);assert.equal(calls,1);clock+=1001;await resolve('api','egc',set.keys[0].kid);assert.equal(calls,2);
  await assert.rejects(resolve('hub','other',set.keys[0].kid),/invalid_service_key_source/);
});
test('key source errors and private/untrusted key fields are rejected',async()=>{
  const set=await servicePublicKeySet(options);
  for(const body of [{...set,issuer:'https://evil.example'},{...set,keys:[{...set.keys[0],d:'forbidden'}]},{...set,keys:[{...set.keys[0],kid:'api-v2-'+'0'.repeat(32)}]}])await assert.rejects(createServiceKeyResolver({fetcher:async()=>Response.json(body)})('api','egc',set.keys[0].kid),/invalid_service_public_key/);
  await assert.rejects(createServiceKeyResolver({fetcher:async()=>new Response('',{status:503})})('api','egc',set.keys[0].kid),/service_key_source_unavailable/);
  await assert.rejects(createServiceKeyResolver({fetcher:async()=>Response.redirect('https://evil.example',302)})('api','egc',set.keys[0].kid),/service_key_source_unavailable/);
  await assert.rejects(createServiceKeyResolver({fetcher:async()=>{throw Error('redirect');}})('api','egc',set.keys[0].kid),/service_key_source_unavailable/);
});
test('native activation requires strong existing server secret, explicit false always disables, origin cannot be overridden',async()=>{
  assert.equal(operationsEnabled({}),false);assert.equal(operationsEnabled({HUB_SESSION_SECRET:'short'}),false);
  const env={HUB_SESSION_SECRET:secret};assert.equal(operationsEnabled(env),true);assert.equal(operationsAuthMode(env),'v2');assert.equal(operationsApiOrigin(env).origin,SERVICE_ORIGINS.api);
  assert.equal(operationsEnabled({...env,EGC_OPERATIONS_ENABLED:'false'}),false);assert.equal(operationsEnabled({...env,EGC_OPERATIONS_SERVICE_AUTH:'unknown'}),false);
  assert.throws(()=>operationsApiOrigin({...env,EGC_OPERATIONS_API_ORIGIN:'https://evil.example'}),/operations_bridge_not_configured/);
  assert.equal((await publicKeys({env})).status,200);assert.equal((await publicKeys({env:{...env,EGC_OPERATIONS_ENABLED:'false'}})).status,503);
});
test('v2 never downgrades to configured legacy HMAC; native signing uses only the existing session secret',async()=>{
  const env={HUB_SESSION_SECRET:secret,EGC_OPERATIONS_PORTAL_SIGNING_SECRET:'legacy'.repeat(10)},legacy=await signOperationsEnvelope({v:1,iss:'portal',aud:'egc-portal',iat:Math.floor(now/1000),nonce:crypto.randomUUID(),actor,request},env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET);
  await assert.rejects(verifyApiServiceEnvelope(env,legacy,'/api/operations-portal'),/invalid_service_signature/);
  const signed=await signPortalServiceEnvelope(env,{path:'/operations/rpc',actor,request});assert.equal(claims(signed).v,2);assert.equal(claims(signed).iss,SERVICE_ORIGINS.hub);
});
test('Firestore nonce receipt is create-only and stores no customer payload; duplicate and storage failure are distinguished',async()=>{
  const nonce='a704ab81-a755-4ccf-91dd-a14d304cf175';let payload;
  const fetcher=async(env,url,init)=>{assert.match(url,/:commit$/);payload=JSON.parse(init.body);return Response.json({});};
  assert.equal(await consumePortalServiceNonce({},SERVICE_ORIGINS.api,nonce,now/1000+60,fetcher),true);
  assert.deepEqual(payload.writes[0].currentDocument,{exists:false});assert.match(payload.writes[0].update.name,/\/operations_service_nonces\/api_/);assert.ok(!JSON.stringify(payload).includes('calendar'));
  assert.equal(await consumePortalServiceNonce({},SERVICE_ORIGINS.api,nonce,now/1000+60,async()=>new Response('',{status:409})),false);
  await assert.rejects(consumePortalServiceNonce({},SERVICE_ORIGINS.api,nonce,now/1000+60,async()=>new Response('',{status:503})),/service_replay_store_unavailable/);
});
test('nonce cleanup is bounded and deletes only exact collection records with revision guards',async()=>{
  const root='projects/egcw-1ec83/databases/(default)/documents',seen=[];
  const fetcher=async(env,url,init)=>{const body=JSON.parse(init.body);seen.push(body);return url.endsWith(':runQuery')?Response.json([{document:{name:root+'/operations_service_nonces/api_old',updateTime:'2026-09-21T00:00:00Z'}},{document:{name:root+'/jobs/customer-job',updateTime:'2026-09-21T00:00:00Z'}}]):Response.json({});};
  assert.equal(await cleanupExpiredPortalServiceNonces({},fetcher,now),1);assert.equal(seen[0].structuredQuery.limit,100);assert.equal(seen[1].writes.length,1);assert.deepEqual(seen[1].writes[0].currentDocument,{updateTime:'2026-09-21T00:00:00Z'});
});
