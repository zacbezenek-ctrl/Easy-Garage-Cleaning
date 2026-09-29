import test from 'node:test';
import assert from 'node:assert/strict';
import {applyRecordingApproval,currentRecordingProfile,recordingActorRole,resolveRecordingIdentity} from '../functions/_lib/operations-recording-approval.js';
import {onRequestPost as gateway} from '../functions/api/operations-recordings.js';
import {onRequestPost as approvalGateway} from '../functions/api/operations-recording-approval.js';
import {encodeFirestoreFields} from '../functions/_lib/firestore-job.js';
import {createHubSessionCookie} from '../functions/_lib/hub-session.js';
import {signOperationsEnvelope} from '../functions/_lib/operations-envelope.js';
import {ROOT,staffEnv,seedAccount,vaultFirestore} from './helpers/vault-fixture.mjs';
const recordingId='10000000-0000-4000-a000-000000000001',requestId='20000000-0000-4000-a000-000000000002';
const actor={id:'synthetic-owner',role:'owner',kind:'human',workspace:'egc'};
const command={recordingId,requestId,fingerprint:'a'.repeat(64),portalJobId:'visit-1',portalVisitId:'visit-1',portalCustomerId:'customer-1',portalProjectId:null,expectedRevision:'revision-1',extraction:{itemsKeep:['Bike'],pricingNotes:[],proposedActions:[]}};
function fixture(){const docs=new Map([['jobs/visit-1',{type:'walkthrough',customerId:'customer-1',priceQuoted:1900,acceptance:{acceptedAt:'original'}}],['customers/customer-1',{name:'Synthetic'}]]);const writes=[];let conflict=false;
const fetcher=async(_env,url,options={})=>{const path=String(url).split('/documents/')[1];if(String(url).endsWith(':commit')){const body=JSON.parse(options.body);writes.push(body);if(conflict)return Response.json({error:'conflict'},{status:409});for(const w of body.writes){assert.ok(w.currentDocument);if(w.currentDocument.exists===false)docs.set(w.update.name.split('/documents/')[1],Object.fromEntries(Object.entries(w.update.fields).map(([k,v])=>[k,v.stringValue??v.mapValue??null])));}return Response.json({writeResults:[]});}const value=docs.get(path);return value?Response.json({name:'projects/test/databases/(default)/documents/'+path,updateTime:'revision-1',fields:encodeFirestoreFields(value)}):Response.json({}, {status:404});};return{docs,writes,fetcher,setConflict:()=>{conflict=true;}};}
test('recording source identity is exact and project absence stays explicit',async()=>{const f=fixture();const result=await resolveRecordingIdentity({},'visit-1',f.fetcher);assert.equal(result.portalVisitId,'visit-1');assert.equal(result.portalCustomerId,'customer-1');assert.equal(result.portalProjectId,null);await assert.rejects(resolveRecordingIdentity({},'secure_secret',f.fetcher));});
test('missing customer or mismatched visit association cannot be inferred',async()=>{const f=fixture();delete f.docs.get('jobs/visit-1').customerId;await assert.rejects(resolveRecordingIdentity({},'visit-1',f.fetcher),/customer_link_missing/);f.docs.set('jobs/job-1',{type:'job',customerId:'customer-1',sourceWalkthroughId:'visit-1'});f.docs.set('jobs/visit-1',{type:'walkthrough',customerId:'other-customer'});await assert.rejects(resolveRecordingIdentity({},'job-1',f.fetcher),/visit_job_mismatch/);});
test('the original converted walkthrough remains a valid recording source, but a linked job must match its conversion',async()=>{
  const f=fixture();f.docs.get('jobs/visit-1').convertedJobId='job-1';
  assert.equal((await resolveRecordingIdentity({},'visit-1',f.fetcher)).portalVisitId,'visit-1');
  f.docs.set('jobs/job-1',{type:'job',customerId:'customer-1',sourceWalkthroughId:'visit-1'});
  assert.equal((await resolveRecordingIdentity({},'job-1',f.fetcher)).portalVisitId,'visit-1');
  f.docs.get('jobs/visit-1').convertedJobId='different-job';
  await assert.rejects(resolveRecordingIdentity({},'job-1',f.fetcher),/visit_job_mismatch/);
});
test('recording source rejects conflicting CRM contacts and ignores invalid contact IDs',async()=>{
  const f=fixture(),job=f.docs.get('jobs/visit-1'),customer=f.docs.get('customers/customer-1');
  job.highlevelContactId='contact-job';customer.highlevelContactId='contact-customer';
  await assert.rejects(resolveRecordingIdentity({},'visit-1',f.fetcher),error=>error.message==='recording_contact_link_conflict');
  job.highlevelContactId='bad/contact';
  assert.equal((await resolveRecordingIdentity({},'visit-1',f.fetcher)).highlevelContactId,'contact-customer');
  customer.highlevelContactId='also/bad';
  assert.equal((await resolveRecordingIdentity({},'visit-1',f.fetcher)).highlevelContactId,null);
  delete job.highlevelContactId;delete customer.highlevelContactId;
  assert.equal((await resolveRecordingIdentity({},'visit-1',f.fetcher)).highlevelContactId,null,'an unlinked visit remains a valid recording source');
});
test('staff review is atomic CAS plus unique receipt and does not overwrite signed price or scope',async()=>{const f=fixture();const result=await applyRecordingApproval({},command,actor,f.fetcher);assert.equal(result.ok,true);const writes=f.writes[0].writes;assert.equal(writes.length,3,'job CAS, receipt and (FUN-02) the scope.reviewed event');assert.deepEqual(writes[0].currentDocument,{updateTime:'revision-1'});assert.deepEqual(writes[1].currentDocument,{exists:false});assert.deepEqual(writes[2].currentDocument,{exists:false});assert.match(writes[2].update.name,/\/funnelEvents\/fe_[0-9a-f]{40}$/);assert.deepEqual(writes[0].updateMask.fieldPaths,['reviewedWalkthroughScope','updatedAt']);assert.equal(writes[0].update.fields.priceQuoted,undefined);assert.equal(writes[0].update.fields.acceptance,undefined);});
test('known accepted approval replays without another write; changed payload cannot reuse it',async()=>{const f=fixture();f.docs.set('operation_recording_approvals/'+recordingId,{fingerprint:command.fingerprint,portalJobId:command.portalJobId,appliedAt:'saved'});assert.equal((await applyRecordingApproval({},command,actor,f.fetcher)).alreadyApplied,true);assert.equal(f.writes.length,0);await assert.rejects(applyRecordingApproval({},{...command,fingerprint:'b'.repeat(64)},actor,f.fetcher),/approval_conflict/);});
test('stale source and concurrent CAS conflicts fail without a guessed retry',async()=>{const f=fixture();await assert.rejects(applyRecordingApproval({},{...command,expectedRevision:'stale'},actor,f.fetcher),/source_revision_conflict/);assert.equal(f.writes.length,0);f.setConflict();await assert.rejects(applyRecordingApproval({},command,actor,f.fetcher),/source_revision_conflict/);assert.equal(f.writes.length,1);});
test('integration or sales identity cannot approve and gateway rejects cross-origin writes',async()=>{for(const denied of [{...actor,role:'sales'},{...actor,role:'integration',kind:'integration'}])await assert.rejects(applyRecordingApproval({},command,denied,fixture().fetcher),e=>e.status===403);const response=await gateway({request:new Request('https://hub.test/api/operations-recordings',{method:'POST',headers:{Origin:'https://attacker.test'},body:'{}'}),env:{}});assert.equal(response.status,403);});

test('a Sales rep can resolve only a source assigned to them or started by their exact account',async()=>{
  const env={EGC_STAFF_ROLE_ACCESS:'true'},profile={user:'Rep.One',displayName:'Synthetic Rep',role:'sales',staffRoles:['sales'],businessAccess:false,source:'employee-account'},f=fixture();
  await assert.rejects(resolveRecordingIdentity(env,'visit-1',f.fetcher,profile),e=>e.status===403&&e.message==='recording_source_forbidden');
  f.docs.get('jobs/visit-1').assignedCrew=['rep.one'];
  assert.equal((await resolveRecordingIdentity(env,'visit-1',f.fetcher,profile)).portalVisitId,'visit-1');
  delete f.docs.get('jobs/visit-1').assignedCrew;
  f.docs.get('jobs/visit-1').walkthroughVisit={startedBy:'REP.ONE'};
  assert.equal((await resolveRecordingIdentity(env,'visit-1',f.fetcher,profile)).portalVisitId,'visit-1');
  delete f.docs.get('jobs/visit-1').walkthroughVisit;
  f.docs.set('jobs/job-1',{type:'job',customerId:'customer-1',sourceWalkthroughId:'visit-1',assignedCrew:['rep.one']});
  assert.equal((await resolveRecordingIdentity(env,'job-1',f.fetcher,profile)).portalVisitId,'visit-1');
  f.docs.get('jobs/job-1').assignedCrew=['Other.Rep'];
  await assert.rejects(resolveRecordingIdentity(env,'job-1',f.fetcher,profile),e=>e.status===403&&e.message==='recording_source_forbidden');
});

test('the recording bridge role follows current staff permissions and rejects role drift',async()=>{
  const on=staffEnv({EGC_STAFF_ROLE_ACCESS:'true',FIREBASE_API_KEY:''}),owner={user:'ZacB',role:'owner',businessAccess:true},manager={user:'TylerG',role:'manager',businessAccess:true},sales={user:'Rep.One',role:'sales',staffRoles:['sales'],businessAccess:false},phone={user:'Phone.One',role:'phone',staffRoles:['phone'],businessAccess:false};
  assert.equal(recordingActorRole(owner,on),'owner');assert.equal(recordingActorRole(manager,on),'manager');assert.equal(recordingActorRole(sales,on),'sales');assert.equal(recordingActorRole(phone,on),null);
  const profile=await currentRecordingProfile(on,{id:'TylerG',role:'manager',kind:'human'});assert.equal(profile.user,'TylerG');
  await assert.rejects(currentRecordingProfile(on,{id:'TylerG',role:'sales',kind:'human'}),e=>e.status===403&&e.message==='recording_actor_changed');
  const demoted=staffEnv({EGC_STAFF_ROLE_ACCESS:'true',FIREBASE_API_KEY:''}, {TylerG:{passwordHash:'unused',role:'manager',staffRoles:['phone']}});
  await assert.rejects(currentRecordingProfile(demoted,{id:'TylerG',role:'manager',kind:'human'}),e=>e.status===403&&e.message==='recording_actor_changed');
});

test('recording proxy accepts a JSON-escaped 80 KB transcript and reports malformed JSON as a client error',async t=>{
  const env=staffEnv({EGC_STAFF_ROLE_ACCESS:'true',EGC_OPERATIONS_ENABLED:'true',EGC_OPERATIONS_SERVICE_AUTH:'legacy',EGC_OPERATIONS_API_ORIGIN:'https://api.synthetic.invalid',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:'synthetic-portal-signing-key-0123456789012345'}, {'Rep.One':{passwordHash:'unused',role:'sales',staffRoles:['sales']},'Phone.One':{passwordHash:'unused',role:'crew',staffRoles:['phone']}});
  const cookie=(await createHubSessionCookie(env,'Rep.One')).split(';')[0],captured=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{captured.push({url:String(url),claims:JSON.parse(Buffer.from(JSON.parse(options.body).envelope.split('.')[0],'base64url').toString())});return Response.json({ok:true});});
  const transcript='"'.repeat(79000),body=JSON.stringify({requestId:crypto.randomUUID(),body:{command:'recording.transcript',portalJobId:'visit-1',transcript}});
  assert.ok(body.length>120000&&body.length<200000);
  const make=payload=>new Request('https://hub.test/api/operations-recordings',{method:'POST',headers:{Origin:'https://hub.test',Cookie:cookie,'Content-Type':'application/json'},body:payload});
  const response=await gateway({request:make(body),env});assert.equal(response.status,200,await response.clone().text());
  assert.equal(captured[0].claims.actor.role,'sales');assert.equal(captured[0].claims.request.body.transcript,transcript);
  const malformed=await gateway({request:make('{bad json'),env});assert.equal(malformed.status,400);assert.deepEqual(await malformed.json(),{error:'invalid_json'});assert.equal(captured.length,1);
  const phoneCookie=(await createHubSessionCookie(env,'Phone.One')).split(';')[0];
  const phone=await gateway({request:new Request('https://hub.test/api/operations-recordings',{method:'POST',headers:{Origin:'https://hub.test',Cookie:phoneCookie,'Content-Type':'application/json'},body}),env});
  assert.equal(phone.status,403);assert.deepEqual(await phone.json(),{error:'recording_role_forbidden'});assert.equal(captured.length,1);
});

test('signed recording resolve rechecks approved Sales identity and source assignment',async t=>{
  const fire=vaultFirestore(t),key='synthetic-api-signing-key-01234567890123456789',env=staffEnv({EGC_STAFF_ROLE_ACCESS:'true',EGC_OPERATIONS_ENABLED:'true',EGC_OPERATIONS_SERVICE_AUTH:'legacy',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key});
  await seedAccount(env,'Rep.One',{sales:true});
  const doc=(collection,id,fields)=>fire.documents.set(`${collection}/${id}`,{name:`${ROOT}/${collection}/${id}`,updateTime:'2026-09-22T12:00:00.000000Z',fields:encodeFirestoreFields(fields)});
  doc('customers','customer-1',{name:'Synthetic'});doc('jobs','visit-1',{type:'walkthrough',customerId:'customer-1',assignedCrew:['Rep.One']});
  const call=async(actor,body={command:'recording.resolve',portalJobId:'visit-1'},activeEnv=env)=>{const envelope=await signOperationsEnvelope({v:1,iss:'portal',aud:'egc-portal',iat:Math.floor(Date.now()/1000),nonce:crypto.randomUUID(),actor,request:{requestId:crypto.randomUUID(),body}},key);const response=await approvalGateway({env:activeEnv,request:new Request('https://hub.test/api/operations-recording-approval',{method:'POST',body:JSON.stringify({envelope})})});return{status:response.status,body:await response.json()};};
  const rep={id:'Rep.One',role:'sales',kind:'human',workspace:'egc'};
  assert.equal((await call(rep)).status,200);
  doc('jobs','visit-1',{type:'walkthrough',customerId:'customer-1',assignedCrew:['Other.Rep']});
  assert.deepEqual(await call(rep),{status:403,body:{error:'recording_source_forbidden'}});
  assert.deepEqual(await call({...rep,role:'manager'}),{status:403,body:{error:'recording_actor_changed'}});
  assert.equal((await call({id:'TylerG',role:'manager',kind:'human',workspace:'egc'})).status,200);
  const demoted={...env,HUB_AUTH_USERS_JSON:staffEnv({}, {TylerG:{passwordHash:'unused',role:'manager',staffRoles:['phone']}}).HUB_AUTH_USERS_JSON},before=fire.commits.length;
  assert.deepEqual(await call({id:'TylerG',role:'manager',kind:'human',workspace:'egc'},{command:'recording.apply',...command},demoted),{status:403,body:{error:'recording_actor_changed'}});
  assert.equal(fire.commits.length,before,'a demoted manager cannot apply an earlier recording approval');
  assert.equal((await call({id:'mcp-service-grant',role:'integration',kind:'integration',workspace:'egc'})).status,200,'the API still relays issuer-verified MCP recording reads');
  const malformed=await approvalGateway({env,request:new Request('https://hub.test/api/operations-recording-approval',{method:'POST',body:'{bad json'})});
  assert.equal(malformed.status,400);assert.deepEqual(await malformed.json(),{error:'invalid_json'});
});
