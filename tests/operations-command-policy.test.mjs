import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {HUB_COMMAND_POLICY} from '../egc-platform/services/operations/src/hub-command-policy.ts';
import {BRIDGE_COMMAND_KINDS} from '../egc-platform/services/operations/src/bridge-command-policy.ts';
import {BRIDGE_COMMAND_POLICY,OPERATIONS_COMMAND_POLICY,authorizeCommand,bridgeConfirmationRequired,bridgeTarget,prepareBridgeCommand} from '../functions/_lib/operations-command-policy.js';
import {CONFIRM_TOKEN_COLLECTION,issueConfirmation} from '../functions/_lib/confirm-token.js';
import {HUB_AUDIT_COLLECTION,auditWrite,listAudit} from '../functions/_lib/hub-audit.js';
import {mutateScheduledVisit} from '../functions/_lib/operations-scheduling.js';
import {applyRecordingApproval} from '../functions/_lib/operations-recording-approval.js';
import {signOperationsEnvelope} from '../functions/_lib/operations-envelope.js';
import {SERVICE_ORIGINS,SERVICE_AUTH_KEY_PATHS,servicePublicKeySet,signServiceRequest} from '../egc-platform/services/operations/src/service-auth.ts';
import {decodeFirestoreFields,encodeFirestoreFields} from '../functions/_lib/firestore-job.js';
import {PORTAL_COMMANDS,onRequestPost as portal} from '../functions/api/operations-portal.js';
import {RECORDING_COMMANDS,onRequestPost as recordings} from '../functions/api/operations-recording-approval.js';
import {storage} from './helpers/field-fixture.mjs';

const NOW='2026-09-22T12:00:00.000Z';
const key='isolated-bridge-authz-test-key-0123456789abcdef';
const secret='synthetic-bridge-authz-session-secret-0123456789';
const human=(id,role)=>({id,role,kind:'human',workspace:'egc'}),integration=id=>({id,role:'integration',kind:'integration',workspace:'egc'});
const owner=human('zacb','owner'),manager=human('tylerg','manager'),sales=human('alexk','sales'),crew=human('crew1','crew'),lead=human('lead1','crew_lead');
const grant=integration('mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8'),service=integration('mcp-service-grant'),worker=integration('booking-adoption-worker'),sync=integration('schedule-sync:mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8'),noteLink=integration('note-link:hub-note:tylerg');
// The API's own workers only read; an id that merely resembles an MCP grant is not one.
const readers=['booking-reconciler','inbound-response-reconciler','operations-api','post-job-followup','hub-note:tylerg','verified-grant','mcp-oauth-grant:synthetic','mcp-oauth-grant:6BA7B810-9DAD-41D1-80B4-00C04FD430C8','mcp-service-grant:x'].map(integration);
const PORTAL={commands:PORTAL_COMMANDS,hub:true,unknown:'read_only_portal_command_required'},RECORDING={commands:RECORDING_COMMANDS,unknown:'unsupported_recording_command'};
const throwsCode=(fn,code,status)=>assert.throws(fn,error=>{assert.equal(error.code,code);assert.equal(error.message,code);assert.equal(error.status,status);return true;});
const rejectsCode=(promise,code,status)=>assert.rejects(promise,error=>{assert.equal(error.message,code);assert.equal(error.status,status);return true;});
const visitInput=(extra={})=>({command:'schedule.mutate',requestId:randomUUID(),mode:'create',portalCustomerId:'customer-a',kind:'walkthrough',changes:{date:'2026-09-23',time:'10:00',endTime:'11:00'},...extra});

// In-memory scheduling store with revisioned, create-only and one-write-per-document commits.
function scheduleFixture(){
  const rows=new Map([['customers/customer-a',{id:'customer-a',name:'Synthetic Customer',highlevelContactId:'contact-a',revision:'customer-r1'}]]),commits=[];let revision=0;
  const store={
    customers:async()=>[],
    read:async(collection,id)=>structuredClone(rows.get(`${collection}/${id}`)||null),
    day:async date=>[...rows.entries()].filter(([k,v])=>k.startsWith('jobs/')&&v.date===date).map(([,v])=>structuredClone(v)),
    commit:async writes=>{
      const targets=writes.map(w=>`${w.collection}/${w.id}`);
      assert.equal(new Set(targets).size,targets.length,'One write per document per commit.');
      for(const w of writes){const prior=rows.get(`${w.collection}/${w.id}`);if(w.revision?prior?.revision!==w.revision:Boolean(prior))throw Object.assign(new Error('schedule_revision_conflict'),{status:409});}
      commits.push(structuredClone(writes));
      for(const w of writes)rows.set(`${w.collection}/${w.id}`,{...rows.get(`${w.collection}/${w.id}`),...structuredClone(w.patch),id:w.id,revision:`r${++revision}`});
      return {};
    },
  };
  return {rows,store,commits};
}

const env=(extra={})=>({EGC_OPERATIONS_ENABLED:'true',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key,...extra});
async function signed(endpoint,path,actor,body,environment=env()){
  const claims={v:1,iss:'portal',aud:'egc-portal',iat:Math.floor(Date.parse(NOW)/1000),nonce:randomUUID(),actor,request:{requestId:randomUUID(),body}};
  const response=await endpoint({request:new Request(`https://portal.test${path}`,{method:'POST',body:JSON.stringify({envelope:await signOperationsEnvelope(claims,key)})}),env:environment});
  return {status:response.status,body:await response.json()};
}
const toPortal=(actor,body,environment)=>signed(portal,'/api/operations-portal',actor,body,environment);
const toRecordings=(actor,body,environment)=>signed(recordings,'/api/operations-recording-approval',actor,body,environment);

test('every command the signed bridge endpoints dispatch has exactly one shared policy entry',()=>{
  const routed=[...PORTAL_COMMANDS,...RECORDING_COMMANDS];
  assert.equal(new Set(routed).size,routed.length,'No command is routed by two endpoints.');
  assert.deepEqual([...routed].sort(),Object.keys(BRIDGE_COMMAND_POLICY).sort(),'Every routed legacy command has a policy and no policy is orphaned.');
  assert.deepEqual(Object.keys(OPERATIONS_COMMAND_POLICY).sort(),[...routed,...Object.keys(HUB_COMMAND_POLICY)].sort(),'The one table also carries every hub.* command.');
  // Security invariant: every command literal an endpoint dispatches is on its allowlist, so nothing runs before its policy.
  for(const [file,list] of [['../functions/api/operations-portal.js',PORTAL_COMMANDS],['../functions/api/operations-recording-approval.js',RECORDING_COMMANDS]]){
    const source=readFileSync(new URL(file,import.meta.url),'utf8'),dispatched=new Set([...source.matchAll(/command\.command===['"]([^'"]+)['"]/g)].map(match=>match[1]));
    for(const match of source.matchAll(/\[([^\]]*)\]\.includes\(command\.command\)/g))for(const name of match[1].matchAll(/['"]([^'"]+)['"]/g))dispatched.add(name[1]);
    assert.deepEqual([...dispatched].sort(),[...list].sort(),file);
    assert.match(source,/await prepareBridgeCommand\(env,c\.actor,c\.request\.body,/,`${file} authorizes before it dispatches`);
  }
  assert.ok(Object.isFrozen(OPERATIONS_COMMAND_POLICY)&&Object.isFrozen(BRIDGE_COMMAND_POLICY)&&Object.isFrozen(PORTAL_COMMANDS)&&Object.isFrozen(RECORDING_COMMANDS));
  for(const [name,rule] of Object.entries(OPERATIONS_COMMAND_POLICY)){
    assert.ok(Object.isFrozen(rule)&&Object.isFrozen(rule.actors)&&rule.actors.length,name);
    assert.ok(BRIDGE_COMMAND_KINDS.includes(rule.kind),name);assert.equal(typeof rule.confirm,'boolean',name);
    for(const actor of rule.actors){
      assert.ok(Object.isFrozen(actor)&&['human','integration'].includes(actor.kind),name);
      assert.equal(actor.kind==='integration',actor.role==='integration',name);
      assert.ok(!['crew','crew_lead'].includes(actor.role),`${name} never admits a crew role`);
    }
    if(rule.kind!=='read')assert.ok(!rule.actors.some(actor=>actor.role==='sales'),`${name}: sales staff only read over the bridge`);
  }
  assert.deepEqual(BRIDGE_COMMAND_POLICY['schedule.mutate'].modes,{cancel:{kind:'destructive',confirm:true}});
  assert.ok(Object.isFrozen(BRIDGE_COMMAND_POLICY['schedule.mutate'].modes.cancel));
});

test('crew roles are refused every bridge command; sales reads; writes need a manager or an integration',()=>{
  for(const actor of [crew,lead]){
    for(const command of PORTAL_COMMANDS)throwsCode(()=>authorizeCommand(actor,{command},PORTAL),'bridge_role_forbidden',403);
    for(const command of RECORDING_COMMANDS)throwsCode(()=>authorizeCommand(actor,{command},RECORDING),'bridge_role_forbidden',403);
    for(const command of Object.keys(HUB_COMMAND_POLICY))throwsCode(()=>authorizeCommand(actor,{command},PORTAL),'hub_role_forbidden',403);
  }
  for(const mode of ['create','update','cancel']){
    for(const actor of [owner,manager,grant,service])assert.equal(authorizeCommand(actor,{command:'schedule.mutate',mode},PORTAL).command,'schedule.mutate',`${actor.id} ${mode}`);
    throwsCode(()=>authorizeCommand(sales,{command:'schedule.mutate',mode},PORTAL),'bridge_role_forbidden',403);
    for(const actor of [...readers,sync,noteLink,worker])throwsCode(()=>authorizeCommand(actor,{command:'schedule.mutate',mode},PORTAL),'bridge_integration_forbidden',403);
  }
  for(const command of ['portal.note.add','portal.job.edit','portal.project.ensure']){
    for(const actor of [owner,manager,grant,service])assert.equal(authorizeCommand(actor,{command},PORTAL).kind,'write');
    throwsCode(()=>authorizeCommand(sales,{command},PORTAL),'bridge_role_forbidden',403);
    for(const actor of [...readers,sync,noteLink,worker])throwsCode(()=>authorizeCommand(actor,{command},PORTAL),'bridge_integration_forbidden',403);
  }
  for(const command of ['calendar','portal.job','portal.evidence','portal.members','portal.revenue','portal.rules','schedule.resolve'])
    for(const actor of [owner,manager,sales,grant,service,sync,...readers])assert.equal(authorizeCommand(actor,{command},PORTAL).kind,'read',`${actor.id} ${command}`);
  assert.equal(authorizeCommand(worker,{command:'schedule.adopt'},PORTAL).kind,'write');
  throwsCode(()=>authorizeCommand(grant,{command:'schedule.adopt'},PORTAL),'bridge_integration_forbidden',403);
  throwsCode(()=>authorizeCommand(integration('booking-adoption-worker-2'),{command:'schedule.adopt'},PORTAL),'bridge_integration_forbidden',403);
  throwsCode(()=>authorizeCommand(owner,{command:'schedule.adopt'},PORTAL),'bridge_role_forbidden',403);
  // Customer links come from the API's schedule and note sync; provider bindings from that sync or the MCP.
  for(const [command,allowed,refused] of [['schedule.link_customer',[sync,noteLink],[grant,service,worker,...readers]],['schedule.bind_provider',[sync,grant,service],[noteLink,worker,...readers]]]){
    for(const actor of allowed)assert.equal(authorizeCommand(actor,{command},PORTAL).kind,'write',`${actor.id} ${command}`);
    for(const actor of refused)throwsCode(()=>authorizeCommand(actor,{command},PORTAL),'bridge_integration_forbidden',403);
    for(const actor of [owner,manager])throwsCode(()=>authorizeCommand(actor,{command},PORTAL),'bridge_role_forbidden',403);
  }
  for(const actor of [owner,manager])assert.equal(authorizeCommand(actor,{command:'recording.apply'},RECORDING).kind,'write');
  throwsCode(()=>authorizeCommand(sales,{command:'recording.apply'},RECORDING),'bridge_role_forbidden',403);
  throwsCode(()=>authorizeCommand(grant,{command:'recording.apply'},RECORDING),'bridge_integration_forbidden',403);
  for(const actor of [sales,grant])assert.equal(authorizeCommand(actor,{command:'recording.resolve'},RECORDING).kind,'read');
  for(const actor of [null,'zacb',{...owner,id:''},{...owner,id:undefined},{...owner,role:'integration'},{...grant,role:'owner'},{...owner,kind:'service'}])
    throwsCode(()=>authorizeCommand(actor,{command:'calendar'},PORTAL),'bridge_actor_invalid',403);
});

test('commands outside an endpoint are refused as before and modes refine the rule',()=>{
  for(const body of [undefined,null,[],'calendar',{},{command:42},{command:'task.create'},{command:'recording.apply'},{command:'__proto__'},{command:'toString'},{command:'constructor'}])
    throwsCode(()=>authorizeCommand(owner,body,PORTAL),'read_only_portal_command_required',400);
  for(const body of [{command:'schedule.mutate'},{command:'hub.staff.roster'},{command:'hasOwnProperty'}])throwsCode(()=>authorizeCommand(owner,body,RECORDING),'unsupported_recording_command',400);
  throwsCode(()=>authorizeCommand(owner,{command:'hub.nope'},PORTAL),'hub_command_unknown',400);
  throwsCode(()=>authorizeCommand(owner,{command:'task.create'}),'bridge_command_unknown',400);
  assert.equal(authorizeCommand(owner,{command:'calendar'}).kind,'read','Without an endpoint allowlist the whole legacy table applies.');
  assert.deepEqual({...authorizeCommand(owner,{command:'schedule.mutate',mode:'cancel'},PORTAL),actors:undefined},{command:'schedule.mutate',action:'schedule.mutate:cancel',kind:'destructive',confirm:true,actors:undefined});
  for(const mode of ['create','update',undefined,'toString','__proto__'])assert.deepEqual((({action,kind,confirm})=>({action,kind,confirm}))(authorizeCommand(owner,{command:'schedule.mutate',mode},PORTAL)),{action:'schedule.mutate',kind:'write',confirm:false},String(mode));
  assert.deepEqual(authorizeCommand(manager,{command:'hub.dispatch.overview'},PORTAL),{command:'hub.dispatch.overview',action:'hub.dispatch.overview',kind:'read',confirm:false,confirmed:false,hub:true});
  throwsCode(()=>authorizeCommand(sales,{command:'hub.dispatch.overview'},PORTAL),'hub_role_forbidden',403);
  throwsCode(()=>authorizeCommand(grant,{command:'hub.staff.roster'},PORTAL),'hub_delegate_required',403);
  throwsCode(()=>authorizeCommand(null,{command:'hub.staff.roster'},PORTAL),'hub_actor_invalid',403);
  assert.deepEqual([bridgeTarget({portalVisitId:'visit-a',portalCustomerId:'c'}),bridgeTarget({portalJobId:'job-a'}),bridgeTarget({portalVisitId:'_egc_lock',portalCustomerId:'c'}),bridgeTarget({jobId:'../x'}),bridgeTarget({})],['visit-a','job-a','c',null,null]);
});

test('hub.* entries in the one table carry the semantics authorizeCommand returns',()=>{
  for(const [name,rule] of Object.entries(HUB_COMMAND_POLICY)){
    const entry=OPERATIONS_COMMAND_POLICY[name],actor=rule.roles.includes('owner')?owner:manager;
    const allowed=authorizeCommand(actor,{command:name,...(rule.confirmRequired?{confirmed:true}:{})},PORTAL);
    assert.deepEqual([entry.kind,entry.confirm,entry.confirmed],[allowed.kind,allowed.confirm,allowed.confirmed],name);
    assert.equal(entry.confirm,false,`${name} never takes a SEC-03 token`);
    for(const actorRule of entry.actors)assert.deepEqual(Object.keys(actorRule).sort(),actorRule.kind==='integration'?['delegate','kind','role']:['kind','role'],name);
  }
  // A registry write that needs its confirmed:true flag reports it the same way.
  const hubPolicies={'hub.synthetic.cancel':{write:true,integrationAllowed:false,roles:['owner'],ownerOnly:true,confirmRequired:true,revisioned:false}};
  throwsCode(()=>authorizeCommand(owner,{command:'hub.synthetic.cancel'},{...PORTAL,hubPolicies}),'hub_confirmation_required',403);
  assert.deepEqual((({kind,confirm,confirmed})=>({kind,confirm,confirmed}))(authorizeCommand(owner,{command:'hub.synthetic.cancel',confirmed:true},{...PORTAL,hubPolicies})),{kind:'write',confirm:false,confirmed:true});
});

test('under v2 service auth, which admits crew principals, the endpoints refuse them before any storage access',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
  const apiRoot='synthetic-api-bearer-root-secret-0123456789abcdef',keys=await servicePublicKeySet({service:'api',rootSecret:apiRoot,workspace:'egc'}),seen=[];
  t.mock.method(globalThis,'fetch',async(input,init={})=>{
    const url=new URL(String(input));seen.push(url.pathname.split(/[/:]/).pop());
    if(String(input)===SERVICE_ORIGINS.api+SERVICE_AUTH_KEY_PATHS.api)return Response.json(keys);
    assert.equal(url.hostname,'firestore.googleapis.com');
    if(url.pathname.endsWith(':runQuery'))return Response.json([]);
    assert.ok(url.pathname.endsWith(':commit'));
    assert.ok(JSON.parse(init.body).writes.every(write=>write.update.name.includes('/operations_service_nonces/')),'Only the single-use nonce receipt is written.');
    return Response.json({});
  });
  const v2env={HUB_SESSION_SECRET:secret,FIREBASE_API_KEY:'firebase-test-bridge-authz'};
  for(const [path,endpoint,commands] of [['/api/operations-portal',portal,PORTAL_COMMANDS],['/api/operations-recording-approval',recordings,RECORDING_COMMANDS]])for(const command of commands)for(const actor of [crew,lead]){
    const envelope=await signServiceRequest({service:'api',rootSecret:apiRoot,workspace:'egc',path,actor,request:{requestId:randomUUID(),body:{command}}});
    const response=await endpoint({request:new Request(`https://easygaragecleaning.com${path}`,{method:'POST',body:JSON.stringify({envelope})}),env:v2env});
    assert.deepEqual([response.status,await response.json()],[403,{error:'bridge_role_forbidden'}],`${actor.role} ${command}`);
  }
  const requests=2*(PORTAL_COMMANDS.length+RECORDING_COMMANDS.length);
  assert.equal(seen.filter(name=>name==='commit').length,requests,'Each request consumed its nonce and nothing else was written.');
  assert.ok(seen.every(name=>['commit','runQuery','service-keys'].includes(name)),`Nothing but key discovery and nonce receipts ran: ${[...new Set(seen)]}`);
});

test('the signed endpoints refuse sales and the wrong integration before any storage access',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
  const hosts=[];t.mock.method(globalThis,'fetch',async input=>{hosts.push(new URL(String(input)).hostname);throw new Error('no storage access expected');});
  assert.deepEqual(await toPortal(crew,{command:'calendar'}),{status:401,body:{error:'unauthorized'}},'The legacy envelope never admits crew roles at all.');
  assert.deepEqual(await toPortal(sales,visitInput()),{status:403,body:{error:'bridge_role_forbidden'}},'Sales staff cannot create, move or cancel visits over the bridge.');
  assert.deepEqual(await toPortal(grant,{command:'schedule.adopt',requestId:randomUUID(),proof:{}}),{status:403,body:{error:'bridge_integration_forbidden'}});
  assert.deepEqual(await toPortal(owner,{command:'schedule.link_customer',portalVisitId:'visit-a',expectedRevision:'r1',providerContact:{id:'contact-a'}}),{status:403,body:{error:'bridge_role_forbidden'}});
  assert.deepEqual(await toRecordings(grant,{command:'recording.apply'}),{status:403,body:{error:'bridge_integration_forbidden'}});
  assert.deepEqual(await toRecordings(sales,{command:'recording.apply'}),{status:403,body:{error:'bridge_role_forbidden'}});
  assert.deepEqual(await toRecordings(owner,{command:'schedule.mutate'}),{status:400,body:{error:'unsupported_recording_command'}});
  assert.deepEqual(await toPortal(owner,{command:'recording.apply'}),{status:400,body:{error:'read_only_portal_command_required'}});
  assert.deepEqual(await toPortal(owner,{command:'portal.members',via:'email'}),{status:400,body:{error:'bridge_via_invalid'}});
  assert.deepEqual(await toPortal(owner,{command:'portal.members',onBehalfOf:'Not A User!'}),{status:400,body:{error:'bridge_on_behalf_of_invalid'}});
  assert.deepEqual(await toPortal(grant,{...visitInput(),confirmation:'ect1.x.y'}),{status:400,body:{error:'bridge_confirmation_unexpected'}});
  const confirmEnv=env({HUB_PURPOSE_KEY_SECRET:secret,EGC_OPERATIONS_BRIDGE_CONFIRM_REQUIRED:'true'});
  const cancel={command:'schedule.mutate',requestId:randomUUID(),mode:'cancel',portalVisitId:'visit-a',portalCustomerId:'customer-a',expectedRevision:'r1',changes:{}};
  assert.deepEqual(await toPortal(grant,cancel,confirmEnv),{status:403,body:{error:'bridge_confirmation_required'}});
  assert.deepEqual(await toPortal(owner,{...cancel,confirmation:'ect1.forged.signature'},confirmEnv),{status:403,body:{error:'confirm_token_invalid'}});
  assert.deepEqual(hosts,[],'Every refusal happened before storage.');
  const members=await toPortal(sales,{command:'portal.members',via:'portal'},env({HUB_AUTH_USERS_JSON:JSON.stringify({zacb:{passwordHash:'synthetic-hash-never-returned',role:'owner',displayName:'Synthetic Owner'}})}));
  assert.deepEqual([members.status,members.body.authority,members.body.members.map(m=>m.id)],[200,'employee_hub',['zacb']],'Allowed reads are unchanged.');
});

test('the scheduling lib applies the same roles to any caller; the bridge matches the principal',async()=>{
  const store={read:async()=>{throw new Error('no read before the role check');},commit:async()=>{throw new Error('no commit');}};
  for(const actor of [crew,lead,sales,{...owner,role:'integration'},null])await rejectsCode(mutateScheduledVisit(store,actor,visitInput(),NOW),'schedule_actor_forbidden',403);
  const f=scheduleFixture(),sender={id:'legacy-sender',kind:'integration',role:'integration'};
  assert.equal((await mutateScheduledVisit(f.store,sender,visitInput(),NOW)).ok,true,'Direct lib callers keep the role access existing callers rely on.');
  throwsCode(()=>authorizeCommand(sender,visitInput(),PORTAL),'bridge_integration_forbidden',403);
});

test('a bridge write commits its hub_audit entry in the same commit, records via and onBehalfOf, and keeps the lib fingerprint',async()=>{
  const f=scheduleFixture(),body=visitInput(),requestId=body.requestId;
  const bridge=await prepareBridgeCommand({},grant,{...body,via:'mcp',onBehalfOf:' ZacB '},{...PORTAL,now:NOW});
  assert.deepEqual(bridge.command,body,'The lib sees exactly the body it always did.');
  assert.deepEqual([bridge.via,bridge.onBehalfOf,bridge.now,bridge.confirmation],['mcp','zacb',NOW,null]);
  const created=await mutateScheduledVisit(bridge.store(f.store),grant,bridge.command,bridge.now),id=created.visit.portalVisitId;
  assert.equal(f.commits.length,1);
  const audits=f.commits[0].filter(write=>write.collection===HUB_AUDIT_COLLECTION);
  assert.equal(audits.length,1);assert.equal(audits[0].revision,undefined,'The audit entry is create-only.');
  const doc=audits[0].patch;
  assert.deepEqual({actor:doc.actor,via:doc.via,onBehalfOf:doc.onBehalfOf,action:doc.action,entity:doc.entity,requestId:doc.requestId,at:doc.at,before:doc.before},
    {actor:{id:grant.id,kind:'integration',role:'integration'},via:'mcp',onBehalfOf:'zacb',action:'schedule.mutate',entity:{collection:'jobs',id},requestId,at:NOW,before:null});
  assert.equal(JSON.parse(doc.after).status,'scheduled');assert.ok(doc.changedKeys.includes('date'));
  assert.equal(f.rows.get(`${HUB_AUDIT_COLLECTION}/${audits[0].id}`).action,'schedule.mutate','The entry landed with the visit.');
  assert.equal(f.rows.get(`jobs/${id}`).createdBy,grant.id);
  const retry=await prepareBridgeCommand({},grant,body,{...PORTAL,now:NOW});
  assert.equal((await mutateScheduledVisit(retry.store(f.store),grant,retry.command,retry.now)).replayed,true,'The saved fingerprint never saw via or onBehalfOf.');
  assert.equal(f.commits.length,1,'A replay commits nothing, not even an audit entry.');
  const moved=await prepareBridgeCommand({},manager,{command:'schedule.mutate',requestId:randomUUID(),mode:'update',portalVisitId:id,portalCustomerId:'customer-a',expectedRevision:f.rows.get(`jobs/${id}`).revision,changes:{title:'Synthetic moved walkthrough'}},{...PORTAL,now:'2026-09-22T12:05:00.000Z'});
  await mutateScheduledVisit(moved.store(f.store),manager,moved.command,moved.now);
  const update=f.commits[1].find(write=>write.collection===HUB_AUDIT_COLLECTION).patch;
  assert.deepEqual([update.via,'onBehalfOf' in update,update.actor.id,update.entity.id,update.at],['portal',false,'tylerg',id,'2026-09-22T12:05:00.000Z'],'Unsigned, a human actor (only Hub sessions) is audited as via portal.');
  assert.deepEqual([JSON.parse(update.before).title,JSON.parse(update.after).title],[null,'Synthetic moved walkthrough'],'Before holds the prior values of exactly the changed keys.');
  // Without a signed via, only the verified actor decides it; API workers stay 'bridge'.
  for(const [actor,via] of [[grant,'mcp'],[service,'mcp'],[sync,'bridge'],[noteLink,'bridge'],[integration('mcp-oauth-grant:synthetic'),'bridge'],[integration('booking-reconciler'),'bridge'],[owner,'portal']])
    assert.equal((await prepareBridgeCommand({},actor,{command:'portal.job',jobId:'job-a'},{...PORTAL,now:NOW})).via,via,actor.id);
  assert.equal((await prepareBridgeCommand({},grant,{command:'hub.staff.roster',delegate:'zacb'},{...PORTAL,now:NOW})).via,'mcp');
  const reads=await prepareBridgeCommand({},sales,{command:'calendar',via:'portal'},{...PORTAL,now:NOW});
  assert.deepEqual([reads.audit,reads.store(f.store)],[null,f.store],'Reads are neither wrapped nor audited.');
  const hub=await prepareBridgeCommand({},owner,{command:'hub.staff.roster',via:'mcp'},{...PORTAL,now:NOW});
  assert.deepEqual(hub.command,{command:'hub.staff.roster'},'hub.* bodies reach the registry without the bridge fields.');
  await rejectsCode(prepareBridgeCommand({},human('x'.repeat(130),'manager'),visitInput(),{...PORTAL,now:NOW}),'bridge_actor_unauditable',403);
});

test('with confirmation required, a cancellation needs a token bound to the actor, visit and exact change, consumed in its commit',async()=>{
  const f=scheduleFixture(),confirmEnv={HUB_SESSION_SECRET:secret,EGC_OPERATIONS_BRIDGE_CONFIRM_REQUIRED:'true'};
  const created=await mutateScheduledVisit(f.store,owner,visitInput(),NOW),id=created.visit.portalVisitId,revision=f.rows.get(`jobs/${id}`).revision;
  const change={command:'schedule.mutate',mode:'cancel',portalVisitId:id,portalCustomerId:'customer-a',expectedRevision:revision,changes:{}};
  const body=(extra={})=>({...change,requestId:randomUUID(),...extra});
  const issue=async(overrides={})=>(await issueConfirmation(confirmEnv,{actorId:grant.id,action:'schedule.mutate:cancel',entityId:id,payload:change,now:NOW,...overrides})).token;
  const prepare=value=>prepareBridgeCommand(confirmEnv,grant,value,{...PORTAL,now:NOW});
  await rejectsCode(prepare(body()),'bridge_confirmation_required',403);
  await rejectsCode(prepare(body({confirmation:''})),'bridge_confirmation_required',403);
  await rejectsCode(prepare(body({confirmation:{token:'x'}})),'bridge_confirmation_required',403);
  await rejectsCode(prepare(body({confirmation:'ect1.forged.signature'})),'confirm_token_invalid',403);
  await rejectsCode(prepare(body({confirmation:(await issueConfirmation({HUB_SESSION_SECRET:'synthetic-other-root-secret-0123456789abcdefgh'},{actorId:grant.id,action:'schedule.mutate:cancel',entityId:id,payload:change,now:NOW})).token})),'confirm_token_invalid',403);
  for(const overrides of [{entityId:'visit_other'},{actorId:'mcp-oauth-grant:other'},{action:'schedule.mutate'},{payload:{...change,expectedRevision:'stale'}}])
    await rejectsCode(prepare(body({confirmation:await issue(overrides)})),'confirm_token_mismatch',403);
  // An expired token reaches the lib (so a retry can replay) but can never commit a new change.
  const stale=await prepare(body({confirmation:await issue({now:'2026-09-22T11:54:00.000Z'})}));
  assert.equal(stale.confirmation.expired,true);
  await rejectsCode(mutateScheduledVisit(stale.store(f.store),grant,stale.command,stale.now),'confirm_token_expired',410);
  await rejectsCode(prepare({...change,requestId:'not-a-uuid',confirmation:await issue({now:'2026-09-22T11:54:00.000Z'})}),'confirm_token_expired',410);
  await rejectsCode(prepare({...body(),mode:'update',changes:{title:'x'},confirmation:await issue()}),'bridge_confirmation_unexpected',400);
  await rejectsCode(prepare({...body({portalVisitId:undefined}),portalCustomerId:'_egc_x'}),'bridge_confirmation_required',403);
  await rejectsCode(prepare({...body({confirmation:await issue()}),portalVisitId:undefined,portalCustomerId:'_egc_x'}),'bridge_confirmation_target_missing',400);
  assert.equal(f.commits.length,1,'No refusal committed anything.');
  const token=await issue(),requestId=randomUUID();
  const bridge=await prepare({...change,requestId,confirmation:token,via:'mcp'});
  assert.equal('confirmation' in bridge.command,false);
  const cancelled=await mutateScheduledVisit(bridge.store(f.store),grant,bridge.command,bridge.now);
  assert.equal(cancelled.visit.status,'cancelled');assert.equal(f.commits.length,2);
  const used=f.commits[1].find(write=>write.collection===CONFIRM_TOKEN_COLLECTION),audit=f.commits[1].find(write=>write.collection===HUB_AUDIT_COLLECTION);
  assert.ok(used&&audit,'The token record and the audit entry commit with the cancellation.');
  assert.deepEqual([used.revision,used.patch.requestId,used.patch.action,used.patch.entityId,used.patch.actorId],[undefined,requestId.toLowerCase(),'schedule.mutate:cancel',id,grant.id]);
  assert.deepEqual([audit.patch.action,audit.patch.via,JSON.parse(audit.patch.after).status],['schedule.mutate:cancel','mcp','cancelled']);
  const retry=await prepare({...change,requestId,confirmation:token});
  assert.equal((await mutateScheduledVisit(retry.store(f.store),grant,retry.command,retry.now)).replayed,true);
  assert.equal(f.commits.length,2,'Retrying the same request replays without consuming again.');
  // Even an identical change (the visit restored to the confirmed revision) cannot reuse the token.
  f.rows.set(`jobs/${id}`,{...f.rows.get(`jobs/${id}`),status:'scheduled',pipelineStatus:'scheduled',revision});
  const reuse=await prepare({...change,requestId:randomUUID(),confirmation:token});
  await rejectsCode(mutateScheduledVisit(reuse.store(f.store),grant,reuse.command,reuse.now),'confirm_token_used',409);
  assert.deepEqual([f.commits.length,f.rows.get(`jobs/${id}`).status],[2,'scheduled'],'A refused reuse changes nothing.');
});

test('a confirmed cancellation retried with the same requestId after its token expired replays the saved result',async()=>{
  const f=scheduleFixture(),confirmEnv={HUB_SESSION_SECRET:secret,EGC_OPERATIONS_BRIDGE_CONFIRM_REQUIRED:'true'},LATER='2026-09-22T12:06:00.000Z';
  const created=await mutateScheduledVisit(f.store,owner,visitInput(),NOW),id=created.visit.portalVisitId;
  const change={command:'schedule.mutate',mode:'cancel',portalVisitId:id,portalCustomerId:'customer-a',expectedRevision:f.rows.get(`jobs/${id}`).revision,changes:{}};
  const {token,expiresAt}=await issueConfirmation(confirmEnv,{actorId:grant.id,action:'schedule.mutate:cancel',entityId:id,payload:change,now:NOW});
  assert.ok(Date.parse(expiresAt)<Date.parse(LATER),'The retry arrives after the token expired.');
  const requestId=randomUUID(),prepare=(value,now)=>prepareBridgeCommand(confirmEnv,grant,value,{...PORTAL,now});
  const first=await prepare({...change,requestId,confirmation:token},NOW);
  assert.equal((await mutateScheduledVisit(first.store(f.store),grant,first.command,first.now)).visit.status,'cancelled');
  assert.equal(f.commits.length,2);
  // The response was lost; the caller retries the SAME requestId as the bridge asks.
  const retry=await prepare({...change,requestId,confirmation:token},LATER);
  assert.equal(retry.confirmation.expired,true);
  const replay=await mutateScheduledVisit(retry.store(f.store),grant,retry.command,retry.now);
  assert.deepEqual([replay.replayed,replay.requestId,replay.visit.status],[true,requestId,'cancelled']);
  assert.equal(f.commits.length,2,'The replay committed nothing.');
  // A fresh change with the expired token is still refused, even for an identical visit state.
  f.rows.set(`jobs/${id}`,{...f.rows.get(`jobs/${id}`),status:'scheduled',pipelineStatus:'scheduled',revision:change.expectedRevision});
  const fresh=await prepare({...change,requestId:randomUUID(),confirmation:token},LATER);
  await rejectsCode(mutateScheduledVisit(fresh.store(f.store),grant,fresh.command,fresh.now),'confirm_token_expired',410);
  assert.deepEqual([f.commits.length,f.rows.get(`jobs/${id}`).status],[2,'scheduled'],'The refused change wrote nothing, not even an audit entry.');
  // Only expiry is forgiven for the replay: a changed body or another actor is still refused up front.
  await rejectsCode(prepare({...change,requestId,expectedRevision:'other',confirmation:token},LATER),'confirm_token_mismatch',403);
  await rejectsCode(prepareBridgeCommand(confirmEnv,service,{...change,requestId,confirmation:token},{...PORTAL,now:LATER}),'confirm_token_mismatch',403);
});

test('with the flag off a cancellation runs as before, but a token that is sent is still verified',async()=>{
  const f=scheduleFixture(),plainEnv={HUB_SESSION_SECRET:secret};
  for(const value of [undefined,'','TRUE','1','yes'])assert.equal(bridgeConfirmationRequired({EGC_OPERATIONS_BRIDGE_CONFIRM_REQUIRED:value}),false,String(value));
  assert.equal(bridgeConfirmationRequired({EGC_OPERATIONS_BRIDGE_CONFIRM_REQUIRED:'true'}),true);
  const created=await mutateScheduledVisit(f.store,owner,visitInput(),NOW),id=created.visit.portalVisitId;
  const cancel={command:'schedule.mutate',requestId:randomUUID(),mode:'cancel',portalVisitId:id,portalCustomerId:'customer-a',expectedRevision:f.rows.get(`jobs/${id}`).revision,changes:{}};
  await rejectsCode(prepareBridgeCommand(plainEnv,grant,{...cancel,confirmation:'ect1.forged.signature'},{...PORTAL,now:NOW}),'confirm_token_invalid',403);
  const bridge=await prepareBridgeCommand(plainEnv,grant,cancel,{...PORTAL,now:NOW});
  assert.deepEqual([bridge.rule.confirm,bridge.confirmation],[true,null]);
  assert.equal((await mutateScheduledVisit(bridge.store(f.store),grant,bridge.command,bridge.now)).visit.status,'cancelled');
  assert.equal(f.commits[1].some(write=>write.collection===CONFIRM_TOKEN_COLLECTION),false);
  assert.equal(f.commits[1].find(write=>write.collection===HUB_AUDIT_COLLECTION).patch.action,'schedule.mutate:cancel');
});

test('portal.note.add over the signed endpoint commits one audit entry with the note and replays without the bridge fields',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
  const s=storage(t),environment=env({FIREBASE_API_KEY:'firebase-test-bridge-authz'});
  s.put('jobs/job-a',{type:'job',customerId:'c1',customer:'Synthetic Customer',status:'scheduled'});
  s.put('customers/c1',{name:'Synthetic Customer'});
  const body={command:'portal.note.add',requestId:randomUUID(),portalJobId:'job-a',expectedRevision:s.revision('job-a'),body:'Synthetic crew note'};
  assert.deepEqual(await toPortal(sales,body,environment),{status:403,body:{error:'bridge_role_forbidden'}});
  assert.equal(s.calls.commits,0);
  const first=await toPortal(manager,{...body,via:'portal',onBehalfOf:'tylerg'},environment);
  assert.deepEqual([first.status,first.body.alreadyApplied],[200,false]);
  assert.equal(s.calls.commits,1);
  const audits=[...s.documents.keys()].filter(path=>path.startsWith(`${HUB_AUDIT_COLLECTION}/`));
  assert.equal(audits.length,1);
  const entry=s.get(audits[0]);
  assert.deepEqual([entry.actor,entry.via,entry.onBehalfOf,entry.action,entry.entityKey,entry.requestId,entry.at],[{id:'tylerg',kind:'human',role:'manager'},'portal','tylerg','portal.note.add','jobs/job-a',body.requestId,NOW]);
  assert.equal(JSON.parse(entry.after).operationNotes[0].body,'Synthetic crew note');
  assert.deepEqual(JSON.parse(entry.before),{operationNotes:null,updatedAt:null});
  assert.equal(s.get('jobs/job-a').operationNotes[0].body,'Synthetic crew note');
  const again=await toPortal(manager,body,environment);
  assert.deepEqual([again.status,again.body.alreadyApplied,s.calls.commits],[200,true,1],'The same request without via replays against the saved fingerprint.');
  const mcp=await toPortal(grant,{...body,requestId:randomUUID(),expectedRevision:s.revision('job-a'),body:'Synthetic MCP note'},environment);
  assert.deepEqual([mcp.status,mcp.body.alreadyApplied,s.calls.commits],[200,false,2]);
  const mcpEntry=[...s.documents.keys()].filter(path=>path.startsWith(`${HUB_AUDIT_COLLECTION}/`)).map(path=>s.get(path)).find(row=>row.actor.id===grant.id);
  assert.deepEqual([mcpEntry.via,'onBehalfOf' in mcpEntry,mcpEntry.action],['mcp',false,'portal.note.add'],'An MCP principal is audited as via mcp although the API never names it.');
  assert.deepEqual(await toPortal(integration('booking-reconciler'),{...body,requestId:randomUUID(),expectedRevision:s.revision('job-a')},environment),{status:403,body:{error:'bridge_integration_forbidden'}});
  assert.equal(s.calls.commits,2);
});

test('recording.apply joins its hub_audit entry to the approval commit',async()=>{
  const docs=new Map([['jobs/visit-1',{type:'walkthrough',customerId:'customer-1'}],['customers/customer-1',{name:'Synthetic'}]]),commits=[];
  const fetcher=async(_env,url,options={})=>{
    if(String(url).endsWith(':commit')){commits.push(JSON.parse(options.body));return Response.json({});}
    const path=String(url).split('/documents/')[1],doc=docs.get(path);
    return doc?Response.json({name:`projects/egcw-1ec83/databases/(default)/documents/${path}`,updateTime:'revision-1',fields:encodeFirestoreFields(doc)}):Response.json({},{status:404});
  };
  const command={command:'recording.apply',recordingId:randomUUID(),requestId:randomUUID(),fingerprint:'a'.repeat(64),portalJobId:'visit-1',portalVisitId:'visit-1',portalCustomerId:'customer-1',portalProjectId:null,expectedRevision:'revision-1',extraction:{itemsKeep:['Synthetic bike']}};
  const bridge=await prepareBridgeCommand({},owner,command,{...RECORDING,now:NOW});
  const result=await applyRecordingApproval({},bridge.command,owner,fetcher,{now:bridge.now,audit:bridge.audit});
  assert.deepEqual([result.ok,result.appliedAt,commits.length],[true,NOW,1]);
  const writes=commits[0].writes,auditWriteDoc=writes.find(write=>write.update.name.includes(`/${HUB_AUDIT_COLLECTION}/`));
  assert.equal(writes.length,3);assert.deepEqual(auditWriteDoc.currentDocument,{exists:false});
  const entry=decodeFirestoreFields(auditWriteDoc.update.fields);
  assert.deepEqual([entry.action,entry.entityKey,entry.actor.id,entry.via,entry.requestId],['recording.apply','jobs/visit-1','zacb','portal',command.requestId]);
  assert.equal(JSON.parse(entry.after).reviewedWalkthroughScope.recordingId,command.recordingId);
  const plain=[];await applyRecordingApproval({},bridge.command,owner,async(e,url,options)=>{if(String(url).endsWith(':commit'))plain.push(JSON.parse(options.body));return fetcher(e,url,options);},{now:NOW});
  assert.equal(plain[0].writes.length,2,'Without an audit hook the approval commit is unchanged.');
});

test('hub_audit records onBehalfOf only when given and lists it back',async()=>{
  const base={actor:{id:grant.id,kind:'integration',role:'integration'},via:'mcp',action:'schedule.mutate',entity:{collection:'jobs',id:'visit-a'},now:NOW};
  const plain=auditWrite(base),delegated=auditWrite({...base,onBehalfOf:'ZacB'});
  assert.equal('onBehalfOf' in plain.patch,false);assert.equal(delegated.patch.onBehalfOf,'zacb');
  assert.equal(auditWrite({...base,onBehalfOf:''}).patch.onBehalfOf,undefined);
  for(const onBehalfOf of ['Not Valid!','-x',42,'x'.repeat(121)])assert.throws(()=>auditWrite({...base,onBehalfOf}),error=>error.code==='hub_audit_invalid'&&error.status===503,String(onBehalfOf));
  const rows=[plain,delegated,auditWrite({...base,now:'2026-09-22T11:00:00.000Z'})].map(write=>({...write.patch,id:write.id})).sort((a,b)=>a.id<b.id?-1:1);
  rows[2].onBehalfOf='Forged Value';
  const page=await listAudit({auditPage:async()=>structuredClone(rows)},{});
  assert.deepEqual(page.entries.map(entry=>entry.onBehalfOf).filter(Boolean),['zacb'],'Only a valid stored account is listed.');
});
