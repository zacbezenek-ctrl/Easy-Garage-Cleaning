import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {HUB_COMMAND_POLICY,HUB_REQUEST_ID_PATTERN} from '../egc-platform/services/operations/src/hub-command-policy.ts';
import {HUB_COMMAND_RECEIPTS,HUB_COMMAND_REGISTRY,isHubCommand,runHubCommand} from '../functions/_lib/operations-hub-commands.js';
import {dispatchStorage} from '../functions/_lib/dispatch-storage.js';
import {operationsActorSession,operationsDelegates} from '../functions/_lib/operations-actor-session.js';
import {signOperationsEnvelope} from '../functions/_lib/operations-envelope.js';
import {encodeFirestoreFields} from '../functions/_lib/firestore-job.js';
import {onRequestPost as portal} from '../functions/api/operations-portal.js';

const NOW='2026-09-22T12:00:00.000Z',now=()=>new Date(NOW);
const key='isolated-hub-bridge-test-key-0123456789abcdef';
const owner={id:'zacb',role:'owner',kind:'human',workspace:'egc'},manager={id:'tylerg',role:'manager',kind:'human',workspace:'egc'},sales={id:'alexk',role:'sales',kind:'human',workspace:'egc'};
const grant={id:'mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8',role:'integration',kind:'integration',workspace:'egc'};
const profiles=[
  {user:'zacb',displayName:'Synthetic Owner',role:'owner',payType:'hourly',hourlyRate:987.65,businessAccess:true},
  {user:'tylerg',displayName:'Synthetic Manager',role:'manager',payType:'hourly',hourlyRate:876.54,businessAccess:true},
  {user:'alexk',displayName:'Synthetic Sales',role:'sales',businessAccess:true},
  {user:'crew1',displayName:'Synthetic Crew',role:'crew',hourlyRate:765.43,businessAccess:false},
  {user:'lead1',displayName:'Synthetic Lead',role:'crew_lead',businessAccess:false},
  {user:'outside',displayName:'Synthetic Outside Manager',role:'manager',businessAccess:false},
];
const delegates=new Map([[grant.id,'tylerg'],['mcp-oauth-grant:owner','zacb'],['mcp-oauth-grant:crew','crew1']]);
const rejectsCode=(promise,code,status)=>assert.rejects(promise,error=>{assert.equal(error.code,code);assert.equal(error.message,code);if(status)assert.equal(error.status,status);return true;});
const throwsCode=(fn,code,status=403)=>assert.throws(fn,error=>error.code===code&&error.status===status);
function fixture() {
  const calls=[];
  const jobs=[
    {id:'job-a',revision:'r1',type:'job',customerId:'c1',customer:'Synthetic Customer',address:'100 Synthetic Street',date:'2026-09-23',time:'08:00',endTime:'10:00',assignedCrew:['crew1'],jobInstructions:'Synthetic scope',status:'scheduled',estimate:{amount:4321},deposit:{paidAmount:1234},hourlyRate:55.5},
    {id:'job-later',revision:'r2',type:'job',customerId:'c1',customer:'Synthetic Customer',address:'100 Synthetic Street',date:'2026-10-30',time:'08:00',endTime:'10:00',assignedCrew:['crew1'],jobInstructions:'Synthetic scope',status:'scheduled'},
    {id:'secure_vault',revision:'r3',recordType:'employee_hub_v2',sealedPayload:'never-return-vault'},
  ];
  const roster=[{id:'zacb',name:'Synthetic Owner',role:'owner',hourlyRate:987.65,payType:'hourly'},{id:'crew1',name:'Synthetic Crew',role:'crew',hourlyRate:765.43,passwordHash:'never-return-hash'}];
  const store={
    jobs:async()=>{calls.push('jobs');return structuredClone(jobs);},resources:async()=>{calls.push('resources');return [];},roster:async()=>{calls.push('roster');return structuredClone(roster);},
    customers:async()=>{throw new Error('customer search is not a bridge read');},
    read:async(collection,id)=>{calls.push(`read:${collection}/${id}`);return structuredClone(jobs.find(job=>job.id===id)||null);},
    commit:async()=>{throw new Error('reads never commit');},
  };
  return {store,calls,options:{storage:()=>store,profiles:()=>profiles,delegates:()=>delegates,now}};
}

test('the Hub registry mirrors the shared bridge policy exactly',()=>{
  assert.deepEqual(Object.keys(HUB_COMMAND_REGISTRY).sort(),Object.keys(HUB_COMMAND_POLICY).sort());
  for(const [name,entry] of Object.entries(HUB_COMMAND_REGISTRY)){
    const {input,handler,...policy}=entry;
    assert.deepEqual(policy,{...HUB_COMMAND_POLICY[name]},name);
    assert.equal(typeof input,'function');assert.equal(typeof handler,'function');
    assert.ok(Object.isFrozen(entry));
  }
  for(const [name,entry] of Object.entries(HUB_COMMAND_REGISTRY)){
    // API (hubWriteCommand/assertHubContract) and Hub (runHubCommand) read ONE revisioned flag.
    assert.equal(typeof HUB_COMMAND_POLICY[name].revisioned,'boolean',name);
    assert.equal(entry.revisioned,HUB_COMMAND_POLICY[name].revisioned,name);
  }
  assert.equal(isHubCommand({command:'hub.staff.roster'}),true);
  for(const value of [{command:'portal.job'},{command:'hubx'},null,{command:['hub.staff.roster']}])assert.equal(isHubCommand(value),false);
});

test('an unknown hub command is a 400 before identity, storage or clock are touched',async()=>{
  const touched=[],options={storage:()=>touched.push('storage'),profiles:()=>touched.push('profiles'),delegates:()=>touched.push('delegates'),now:()=>touched.push('now')};
  for(const command of [{command:'hub.nope'},{command:'hub.__proto__'},{command:'hub.constructor'},{command:'hub.staff.roster.extra'}])await rejectsCode(runHubCommand({},owner,command,options),'hub_command_unknown',400);
  await rejectsCode(runHubCommand({},owner,['hub.staff.roster'],options),'hub_command_invalid',400);
  assert.deepEqual(touched,[]);
});

test('a registry handler receives the injected store and clock, the sanitized command and a delegated read-only session',async()=>{
  let seen;const store={synthetic:true};
  const registry={'hub.synthetic.read':{write:false,integrationAllowed:true,roles:['owner','manager'],ownerOnly:false,confirmRequired:false,input:input=>({...input,normalized:true}),handler:async(...args)=>{seen=args;return {value:1,authority:'forged',ok:false};}}};
  const result=await runHubCommand({},grant,{command:'hub.synthetic.read',delegate:'TylerG',filter:'x'},{registry,storage:env=>{assert.deepEqual(env,{});return store;},profiles:()=>profiles,delegates:()=>delegates,now});
  const [receivedStore,actor,command,at]=seen;
  assert.equal(receivedStore,store);assert.equal(at.toISOString(),NOW);
  assert.deepEqual(command,{command:'hub.synthetic.read',filter:'x',normalized:true});
  assert.equal(actor.id,grant.id);assert.equal(actor.kind,'integration');assert.ok(Object.isFrozen(actor));
  assert.deepEqual({...actor.session},{user:'tylerg',displayName:'Synthetic Manager',role:'manager',businessAccess:true,source:'operations_bridge',actorId:grant.id,actorKind:'integration',delegatedBy:grant.id,readOnly:true});
  assert.deepEqual(result,{value:1,ok:true,authority:'employee_hub',command:'hub.synthetic.read',actedAs:{user:'tylerg',delegatedBy:grant.id}});
});

test('hub.dispatch.overview runs the existing dispatch overview for a verified human with an injected clock and no money or pay fields',async()=>{
  const f=fixture();
  const result=await runHubCommand({},manager,{command:'hub.dispatch.overview',view:'schedule'},f.options);
  assert.equal(result.authority,'employee_hub');assert.equal(result.startDate,'2026-09-22');assert.equal(result.endDate,'2026-09-29');
  assert.deepEqual(result.coverage,{complete:true,asOf:NOW});
  assert.deepEqual(result.jobs.map(job=>job.id),['job-a']);assert.equal(result.jobs[0].startAt,'2026-09-23T14:00:00.000Z');
  // jobs[].jobTime is computed from the injected bridge clock, never the real one.
  assert.equal(result.jobs[0].jobTime.asOf,NOW);assert.equal(result.jobs[0].jobTime.recorded,false);
  assert.deepEqual(result.roster,[{id:'zacb',name:'Synthetic Owner',role:'owner'},{id:'crew1',name:'Synthetic Crew',role:'crew'}]);
  assert.deepEqual(result.actedAs,{user:'tylerg',delegatedBy:null});
  const text=JSON.stringify(result);for(const secret of ['4321','1234','55.5','987.65','765.43','never-return','hourlyRate','payType','"estimate"','"deposit"','paidAmount'])assert.equal(text.includes(secret),false,secret);
  const detail=await runHubCommand({},grant,{command:'hub.dispatch.overview',view:'job',jobId:'job-a',delegate:'tylerg'},f.options);
  assert.equal(detail.job.id,'job-a');assert.equal(detail.job.jobTime.asOf,NOW);assert.ok(f.calls.includes('read:jobs/job-a'));
  const range=await runHubCommand({},owner,{command:'hub.dispatch.overview',view:'schedule',startDate:'2026-10-01',endDate:'2026-11-01'},f.options);
  assert.deepEqual(range.jobs.map(job=>job.id),['job-later']);
});

test('hub.dispatch.overview relays dispatch refusals as codes and rejects malformed or private-record input',async()=>{
  const f=fixture();
  await rejectsCode(runHubCommand({},owner,{command:'hub.dispatch.overview',view:'schedule',startDate:'2026-09-01',endDate:'2027-09-01'},f.options),'dispatch_range_invalid',400);
  await rejectsCode(runHubCommand({},owner,{command:'hub.dispatch.overview',view:'job',jobId:'missing'},f.options),'dispatch_job_not_found',404);
  for(const command of [{view:'customers',q:'Synthetic'},{view:'job',jobId:'secure_vault'},{view:'job',jobId:'_egc_schedule_lock_2026-09-23'},{view:'job'},{view:'schedule',jobId:'job-a'},{startDate:'09/22/2026'},{includeUnscheduled:'true'},{actor:'zacb'}])
    await rejectsCode(runHubCommand({},owner,{command:'hub.dispatch.overview',...command},f.options),'hub_command_invalid',400);
  await rejectsCode(runHubCommand({},sales,{command:'hub.dispatch.overview'},f.options),'hub_role_forbidden',403);
  assert.equal(f.calls.includes('read:jobs/secure_vault'),false);
});

test('hub.staff.roster returns names and roles only, for humans and verified delegates',async()=>{
  const f=fixture();
  for(const [actor,command] of [[sales,{command:'hub.staff.roster'}],[grant,{command:'hub.staff.roster',delegate:'tylerg'}]]){
    const result=await runHubCommand({},actor,command,f.options);
    assert.deepEqual(result.staff,[{id:'zacb',name:'Synthetic Owner',role:'owner'},{id:'crew1',name:'Synthetic Crew',role:'crew'}]);
    assert.deepEqual(result.coverage,{complete:true,asOf:NOW});
    assert.equal(/hourlyRate|payType|987\.65|765\.43|never-return-hash/.test(JSON.stringify(result)),false);
  }
  await rejectsCode(runHubCommand({},owner,{command:'hub.staff.roster',includePay:true},f.options),'hub_command_invalid',400);
  await rejectsCode(runHubCommand({},owner,{command:'hub.staff.roster',requestId:randomUUID()},f.options),'hub_command_invalid',400);
});

test('the actor-session adapter refuses crew roles and integrations without a verified delegate',()=>{
  for(const role of ['crew','crew_lead'])throwsCode(()=>operationsActorSession({...owner,role},{profiles}),'hub_actor_role_forbidden');
  throwsCode(()=>operationsActorSession({...grant,id:'mcp-oauth-grant:crew'},{profiles,delegates,delegate:'crew1'}),'hub_actor_role_forbidden');
  throwsCode(()=>operationsActorSession({...owner,id:'crew1',role:'owner'},{profiles}),'hub_actor_role_forbidden');
  throwsCode(()=>operationsActorSession({...manager,id:'outside'},{profiles}),'hub_actor_role_forbidden');
  throwsCode(()=>operationsActorSession(grant,{profiles,delegates}),'hub_delegate_required');
  throwsCode(()=>operationsActorSession(grant,{profiles,delegates:new Map(),delegate:'tylerg'}),'hub_delegate_unverified');
  throwsCode(()=>operationsActorSession(grant,{profiles,delegates,delegate:'zacb'}),'hub_delegate_unverified');
  throwsCode(()=>operationsActorSession({...grant,id:'mcp-oauth-grant:owner'},{profiles:profiles.filter(p=>p.user!=='zacb'),delegates,delegate:'zacb'}),'hub_delegate_unverified');
  throwsCode(()=>operationsActorSession(grant,{profiles,delegates,delegate:'tylerg',write:true}),'hub_integration_write_forbidden');
  throwsCode(()=>operationsActorSession(owner,{profiles,delegate:'tylerg'}),'hub_delegate_not_allowed');
  throwsCode(()=>operationsActorSession({...owner,id:'ghost'},{profiles}),'hub_actor_unknown');
  throwsCode(()=>operationsActorSession({...owner,role:'manager'},{profiles}),'hub_actor_changed');
  for(const actor of [null,{...owner,kind:'integration'},{...grant,kind:'human'},{...owner,id:'../x'},{...owner,kind:'robot'}])throwsCode(()=>operationsActorSession(actor,{profiles}),'hub_actor_invalid');
  throwsCode(()=>operationsActorSession(owner,{profiles:[...profiles,{...profiles[0]}]}),'hub_actor_unknown');
  const session=operationsActorSession(owner,{profiles,write:true});
  assert.deepEqual({...session},{user:'zacb',displayName:'Synthetic Owner',role:'owner',businessAccess:true,source:'operations_bridge',actorId:'zacb',actorKind:'human',delegatedBy:null,readOnly:false});
  assert.ok(Object.isFrozen(session));assert.equal('hourlyRate' in session||'payType' in session,false);
});

test('delegations come only from a well-formed owner configuration and fail closed',()=>{
  assert.equal(operationsDelegates({}).size,0);assert.equal(operationsDelegates({EGC_OPERATIONS_HUB_DELEGATES_JSON:'  '}).size,0);
  assert.deepEqual([...operationsDelegates({EGC_OPERATIONS_HUB_DELEGATES_JSON:JSON.stringify({'mcp-oauth-grant:a':' ZacB '})})],[['mcp-oauth-grant:a','zacb']]);
  for(const raw of ['{','[]','"zacb"','null',JSON.stringify({'bad id/../':'zacb'}),JSON.stringify({'mcp-oauth-grant:a':''}),JSON.stringify({'mcp-oauth-grant:a':{user:'zacb'}}),JSON.stringify({'mcp-oauth-grant:a':'Zac B'})])
    throwsCode(()=>operationsDelegates({EGC_OPERATIONS_HUB_DELEGATES_JSON:raw}),'hub_delegate_config_invalid',503);
});

const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const sha256=value=>createHash('sha256').update(canonical(value)).digest('hex');
const conflict=()=>Object.assign(new Error('precondition failed'),{code:'dispatch_revision_conflict',status:409});
/* In-memory Firestore-like store: structuredClone reads, commit rejects duplicate targets,
 * revision (updateTime) preconditions, create-only writes without revision, verify-only
 * writes, a new revision per write, and all-or-nothing application. */
function memoryStore(seed={}){
  const docs=new Map(Object.entries(seed).map(([path,data])=>[path,{...structuredClone(data),revision:'r1'}]));
  let counter=1;const commits=[],reads=[];
  const store={
    loseResponse:false,failBeforeApply:false,failReads:false,
    read:async(collection,id)=>{reads.push(`${collection}/${id}`);if(store.failReads)throw Object.assign(new Error('synthetic read outage'),{code:'dispatch_storage_unavailable',status:503});const row=docs.get(`${collection}/${id}`);return row?structuredClone({...row,id}):null;},
    commit:async writes=>{
      const targets=new Set();
      for(const write of writes){
        const path=`${write.collection}/${write.id}`;assert.equal(targets.has(path),false,`duplicate write ${path}`);targets.add(path);
        const current=docs.get(path);
        if(write.revision?current?.revision!==write.revision:current)throw conflict();
      }
      if(store.failBeforeApply){store.failBeforeApply=false;throw Object.assign(new Error('synthetic network cut'),{code:'dispatch_outcome_unknown',status:503});}
      for(const write of writes.filter(write=>!write.verify)){const path=`${write.collection}/${write.id}`;docs.set(path,{...(docs.get(path)||{}),...structuredClone(write.patch),revision:`r${++counter}`});}
      commits.push(structuredClone(writes));
      if(store.loseResponse){store.loseResponse=false;throw Object.assign(new Error('synthetic lost response'),{code:'dispatch_outcome_unknown',status:503});}
      return {writeResults:writes.map(()=>({}))};
    },
  };
  return {store,docs,commits,reads};
}
/* A revisioned synthetic write: fenced by expectedRevision, audited with before/after. */
function titleEntry(runs,extra={}){
  return {write:true,integrationAllowed:false,roles:['owner','manager'],ownerOnly:false,confirmRequired:false,revisioned:true,
    input:input=>{if(typeof input.title!=='string')throw Object.assign(new Error('Title is required'),{code:'hub_command_invalid',status:400});return {title:input.title};},
    handler:async(store,actor,command,at)=>{
      runs.push({command,user:actor.session.user,at:at.toISOString()});
      const current=await store.read('synthetic_records','rec-1');
      await store.commit([{collection:'synthetic_records',id:'rec-1',revision:command.expectedRevision,patch:{title:command.title,updatedBy:actor.session.user}}],{before:{title:current.title,revision:command.expectedRevision},after:{title:command.title}});
      return {ignored:'the write response is the saved receipt'};
    },...extra};
}
const writeOptions=(registry,store)=>({registry,storage:()=>store,profiles:()=>profiles,delegates:()=>delegates,now});

test('registry writes require a human with the right role, requestId, expectedRevision, confirmation and before/after snapshots',async()=>{
  const writes=[];
  const entry=(extra={})=>({write:true,integrationAllowed:false,roles:['owner','manager'],ownerOnly:false,confirmRequired:false,revisioned:true,input:input=>{if(typeof input.title!=='string')throw Object.assign(new Error('Title is required'),{code:'hub_command_invalid',status:400});return {title:input.title};},
    handler:async(store,actor,command,at)=>{writes.push({command,user:actor.session.user,at:at.toISOString()});await store.commit([{collection:'synthetic_records',id:'rec-1',revision:command.expectedRevision,patch:{title:command.title}}],{before:{title:'Old',revision:command.expectedRevision},after:{title:command.title,revision:'r2'}});return {before:{title:'Old'},after:{title:command.title}};},...extra});
  const registry={'hub.synthetic.save':entry(),'hub.synthetic.confirm':entry({confirmRequired:true}),'hub.synthetic.owner':entry({ownerOnly:true}),'hub.synthetic.bad':entry({handler:async()=>({after:{title:'x'}})}),
    'hub.synthetic.partial':entry({handler:async store=>{await store.commit([{collection:'synthetic_records',id:'rec-1',revision:'r1',patch:{title:'x'}}],{after:{title:'x'}});}})};
  const memory=memoryStore({'synthetic_records/rec-1':{title:'Old'}});
  const options={registry,storage:()=>memory.store,profiles:()=>profiles,delegates:()=>delegates,now};
  const requestId=randomUUID(),body={command:'hub.synthetic.save',requestId,expectedRevision:'r1',title:'New'};
  const result=await runHubCommand({},manager,body,options);
  assert.deepEqual(result.audit,{requestId,command:'hub.synthetic.save',actorId:'tylerg',actorKind:'human',user:'tylerg',before:{title:'Old',revision:'r1'},after:{title:'New',revision:'r2'},at:NOW});
  assert.deepEqual(writes,[{command:{title:'New',command:'hub.synthetic.save',requestId,expectedRevision:'r1'},user:'tylerg',at:NOW}]);
  await rejectsCode(runHubCommand({},manager,{...body,requestId:undefined},options),'hub_request_id_required',400);
  await rejectsCode(runHubCommand({},manager,{...body,requestId:'not-a-uuid'},options),'hub_request_id_required',400);
  for(const id of ['00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff'])await rejectsCode(runHubCommand({},manager,{...body,requestId:id},options),'hub_request_id_required',400);
  await rejectsCode(runHubCommand({},manager,{...body,expectedRevision:undefined},options),'hub_expected_revision_required',400);
  await rejectsCode(runHubCommand({},manager,{...body,expectedRevision:'x'.repeat(201)},options),'hub_expected_revision_required',400);
  await rejectsCode(runHubCommand({},manager,{...body,confirmed:true},options),'hub_command_invalid',400);
  await rejectsCode(runHubCommand({},grant,{...body,delegate:'tylerg'},options),'hub_integration_forbidden',403);
  await rejectsCode(runHubCommand({},grant,{...body,delegate:'tylerg'},{...options,registry:{'hub.synthetic.save':entry({integrationAllowed:true})}}),'hub_integration_write_forbidden',403);
  await rejectsCode(runHubCommand({},sales,body,options),'hub_role_forbidden',403);
  await rejectsCode(runHubCommand({},{...owner,role:'crew'},body,options),'hub_role_forbidden',403);
  await rejectsCode(runHubCommand({},manager,{...body,command:'hub.synthetic.owner'},options),'hub_owner_required',403);
  await rejectsCode(runHubCommand({},manager,{...body,command:'hub.synthetic.confirm'},options),'hub_confirmation_required',403);
  const confirmed=memoryStore({'synthetic_records/rec-1':{title:'Old'}});
  assert.equal((await runHubCommand({},owner,{...body,requestId:randomUUID(),command:'hub.synthetic.confirm',confirmed:true},{...options,storage:()=>confirmed.store})).audit.user,'zacb');
  // A write that returns without a durable, audited commit is refused; so is a commit without a before snapshot.
  await rejectsCode(runHubCommand({},manager,{...body,requestId:randomUUID(),command:'hub.synthetic.bad'},options),'hub_audit_snapshot_missing',503);
  await rejectsCode(runHubCommand({},manager,{...body,requestId:randomUUID(),command:'hub.synthetic.partial'},options),'hub_audit_snapshot_missing',503);
  await rejectsCode(runHubCommand({},manager,{...body,requestId:randomUUID(),title:7},options),'hub_command_invalid',400);
  assert.equal(writes.length,2);
  assert.equal(memory.commits.length,1);assert.equal(confirmed.commits.length,1);
});

test('every registry write commits a create-only server-only receipt in the SAME commit and a retry replays it without re-running the handler',async()=>{
  const runs=[],memory=memoryStore({'synthetic_records/rec-1':{title:'Old'}});
  const options=writeOptions({'hub.synthetic.save':titleEntry(runs)},memory.store);
  const requestId=randomUUID().toUpperCase(),receiptId=requestId.toLowerCase(),body={command:'hub.synthetic.save',requestId,expectedRevision:'r1',title:'New'};
  const first=await runHubCommand({},manager,body,options);
  assert.equal(runs.length,1);assert.equal(memory.commits.length,1);
  const [commit]=memory.commits;
  assert.deepEqual(commit.map(write=>`${write.collection}/${write.id}`),['synthetic_records/rec-1',`${HUB_COMMAND_RECEIPTS}/${receiptId}`]);
  const receipt=commit[1];
  assert.equal(HUB_COMMAND_RECEIPTS,'hub_command_operations');
  assert.equal('revision' in receipt||'verify' in receipt,false,'the receipt is create-only (currentDocument.exists=false)');
  const fingerprint=sha256({actor:{id:'tylerg',kind:'human',workspace:'egc'},command:body});
  assert.deepEqual({...receipt.patch,attempt:typeof receipt.patch.attempt},{requestId,fingerprint,attempt:'string',command:'hub.synthetic.save',actor:{id:'tylerg',kind:'human',role:'manager',workspace:'egc'},user:'tylerg',delegatedBy:null,
    before:JSON.stringify({title:'Old',revision:'r1'}),after:JSON.stringify({title:'New'}),at:NOW});
  assert.deepEqual(first,{ok:true,authority:'employee_hub',command:'hub.synthetic.save',requestId,replayed:false,actedAs:{user:'tylerg',delegatedBy:null},before:{title:'Old',revision:'r1'},after:{title:'New'},
    audit:{requestId,command:'hub.synthetic.save',actorId:'tylerg',actorKind:'human',user:'tylerg',before:{title:'Old',revision:'r1'},after:{title:'New'},at:NOW}});
  assert.equal(memory.docs.get('synthetic_records/rec-1').title,'New');
  // The record moved past r1, so re-running the handler would now fail its precondition: a replay must not.
  const later=()=>new Date(Date.parse(NOW)+3600000);
  const replay=await runHubCommand({},manager,structuredClone(body),{...options,now:later});
  assert.deepEqual(replay,{...first,replayed:true});
  assert.equal(runs.length,1);assert.equal(memory.commits.length,1);
  // Same requestId with a different payload, casing or actor is a 409 before the handler or any commit.
  for(const [actor,changed] of [[manager,{...body,title:'Other'}],[manager,{...body,expectedRevision:'r9'}],[manager,{...body,requestId:receiptId}],[owner,body]])
    await rejectsCode(runHubCommand({},actor,changed,options),'hub_idempotency_conflict',409);
  assert.equal(runs.length,1);assert.equal(memory.commits.length,1);
  // Authorization still runs before any replay.
  await rejectsCode(runHubCommand({},sales,body,options),'hub_role_forbidden',403);
  await rejectsCode(runHubCommand({},manager,body,{...options,profiles:()=>profiles.map(p=>p.user==='tylerg'?{...p,role:'sales'}:p)}),'hub_actor_changed',403);
});

test('a lost commit response is recovered from the receipt, and an unapplied or refused commit is never reported as saved',async()=>{
  const runs=[],memory=memoryStore({'synthetic_records/rec-1':{title:'Old'}});
  const options=writeOptions({'hub.synthetic.save':titleEntry(runs)},memory.store);
  const body={command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:'r1',title:'New'};
  memory.store.loseResponse=true;
  const recovered=await runHubCommand({},manager,body,options);
  assert.equal(recovered.replayed,false);assert.deepEqual(recovered.after,{title:'New'});assert.equal(recovered.audit.at,NOW);
  assert.equal(memory.commits.length,1);
  assert.deepEqual(await runHubCommand({},manager,body,options),{...recovered,replayed:true});
  assert.equal(runs.length,1);
  // The connection was cut before Firestore applied anything: no receipt yet, so the outcome is reported as unknown and the SAME request can run.
  const next={command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:memory.docs.get('synthetic_records/rec-1').revision,title:'Newer'};
  memory.store.failBeforeApply=true;
  await rejectsCode(runHubCommand({},manager,next,options),'hub_outcome_unknown',503);
  assert.equal(memory.docs.has(`${HUB_COMMAND_RECEIPTS}/${next.requestId}`),false);
  const retried=await runHubCommand({},manager,next,options);
  assert.equal(retried.replayed,false);assert.equal(memory.docs.get('synthetic_records/rec-1').title,'Newer');assert.equal(runs.length,3);
  // A stale expectedRevision fails the atomic commit, so neither the record nor the receipt is written.
  const stale={command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:'r1',title:'Stale'};
  await rejectsCode(runHubCommand({},manager,stale,options),'dispatch_revision_conflict',409);
  assert.equal(memory.docs.has(`${HUB_COMMAND_RECEIPTS}/${stale.requestId}`),false);assert.equal(memory.docs.get('synthetic_records/rec-1').title,'Newer');
  // When the outcome cannot be read back, the caller is told to retry the same request, never that it saved.
  const unknown={command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:memory.docs.get('synthetic_records/rec-1').revision,title:'Unknown'};
  const flaky={...memory.store,commit:async writes=>{await memory.store.commit(writes);memory.store.failReads=true;throw Object.assign(new Error('lost'),{code:'dispatch_outcome_unknown',status:503});}};
  await rejectsCode(runHubCommand({},manager,unknown,{...options,storage:()=>flaky}),'hub_outcome_unknown',503);
  memory.store.failReads=false;
  assert.equal((await runHubCommand({},manager,unknown,options)).replayed,true);
});

test('concurrent requests with one requestId apply once: the create-only receipt makes the loser replay or conflict',async()=>{
  const runs=[],memory=memoryStore({'synthetic_records/rec-1':{title:'Old'}});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const entry=titleEntry(runs),handler=entry.handler;
  const options=writeOptions({'hub.synthetic.save':{...entry,handler:async(...args)=>{if(runs.length===0){runs.push('first-started');await gate;}else setTimeout(release,0);return handler(...args);}}},memory.store);
  const body={command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:'r1',title:'New'};
  const results=await Promise.all([runHubCommand({},manager,body,options),runHubCommand({},manager,body,options)]);
  assert.deepEqual(results.map(result=>result.replayed).sort(),[false,true]);
  assert.deepEqual({...results[0],replayed:null},{...results[1],replayed:null});
  assert.equal(memory.commits.length,1);assert.equal(runs.length,3,'both requests passed the replay check and ran the handler');
  const other=memoryStore({'synthetic_records/rec-1':{title:'Old'}}),runs2=[];
  let open;const barrier=new Promise(resolve=>{open=resolve;});
  const entry2=titleEntry(runs2),options2=writeOptions({'hub.synthetic.save':{...entry2,handler:async(...args)=>{if(runs2.length===0){runs2.push('first-started');await barrier;}else setTimeout(open,0);return entry2.handler(...args);}}},other.store);
  const settled=await Promise.allSettled([runHubCommand({},manager,body,options2),runHubCommand({},manager,{...body,title:'Different'},options2)]);
  assert.deepEqual(settled.map(result=>result.status).sort(),['fulfilled','rejected']);
  assert.equal(settled.find(result=>result.status==='rejected').reason.code,'hub_idempotency_conflict');
  assert.equal(other.commits.length,1);
});

test('write handlers cannot bypass the receipt: one commit, no receipt forgery, bounded JSON snapshots',async()=>{
  const memory=memoryStore({'synthetic_records/rec-1':{title:'Old'}});
  const entry=handler=>({...titleEntry([]),handler});
  const run=(handler,store=memory.store)=>runHubCommand({},manager,{command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:'r1',title:'New'},writeOptions({'hub.synthetic.save':entry(handler)},store));
  await rejectsCode(run(async store=>{await store.commit([{collection:HUB_COMMAND_RECEIPTS,id:'forged',patch:{fingerprint:'x'}}],{before:null,after:{}});}),'hub_commit_invalid',503);
  await rejectsCode(run(async store=>{await store.commit([{collection:'synthetic_records',id:'rec-1',revision:'r1',patch:{title:'x'}}]);}),'hub_audit_snapshot_missing',503);
  await rejectsCode(run(async store=>{await store.commit([],{before:[],after:{}});}),'hub_audit_snapshot_missing',503);
  await rejectsCode(run(async store=>{await store.commit([],{before:null,after:{blob:'x'.repeat(200001)}});}),'hub_audit_snapshot_too_large',503);
  assert.equal(memory.commits.length,0);
  // A second commit is refused; the first (audited) commit stands and is what the response reports.
  const second=await run(async store=>{await store.commit([],{before:null,after:{step:1}});await store.commit([{collection:'synthetic_records',id:'rec-1',revision:'r1',patch:{title:'unaudited'}}],{before:null,after:{step:2}});});
  assert.deepEqual(second.after,{step:1});assert.equal(memory.commits.length,1);assert.equal(memory.docs.get('synthetic_records/rec-1').title,'Old');
  // A no-op write still records its audited receipt; nested arrays and odd keys survive as JSON text.
  const noop=await run(async store=>{await store.commit([],{before:{grid:[[1,2],[3]]},after:{grid:[[1,2],[3]],'':'empty key','__x__':true}});});
  assert.deepEqual(noop.before,{grid:[[1,2],[3]]});assert.deepEqual(noop.after,{grid:[[1,2],[3]],'':'empty key','__x__':true});
  // A corrupted receipt fails closed instead of replaying garbage.
  const corrupt=memoryStore({'synthetic_records/rec-1':{title:'Old'}}),body={command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:'r1',title:'New'};
  corrupt.docs.set(`${HUB_COMMAND_RECEIPTS}/${body.requestId}`,{fingerprint:sha256({actor:{id:'tylerg',kind:'human',workspace:'egc'},command:body}),requestId:body.requestId,command:'hub.synthetic.save',actor:{id:'tylerg',kind:'human'},user:'tylerg',at:NOW,before:'{not json',after:'{}',revision:'r5'});
  await rejectsCode(runHubCommand({},manager,body,writeOptions({'hub.synthetic.save':titleEntry([])},corrupt.store)),'hub_receipt_invalid',503);
  // A handler that fails with an internal error after its commit was attempted never reports success without a receipt.
  const failing=memoryStore({'synthetic_records/rec-1':{title:'Old'}});
  await rejectsCode(runHubCommand({},manager,{command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:'r1',title:'New'},writeOptions({'hub.synthetic.save':entry(async store=>{await store.commit([],{before:null,after:{}}).catch(()=>null);throw new Error('postgres://private Synthetic Customer');})},{...failing.store,commit:async()=>{throw new Error('socket hang up');}})),'hub_outcome_unknown',503);
});

test('through real Firestore REST storage the business write and the create-only receipt travel in ONE :commit and replay from the stored receipt',async()=>{
  const ROOT='projects/egcw-1ec83/databases/(default)/documents',stored=new Map([['synthetic_records/rec-1',{fields:encodeFirestoreFields({title:'Old'}),updateTime:'2026-09-21T18:00:00.000000Z'}]]),commits=[];
  const fetcher=async(_env,url,init={})=>{
    const target=String(url);
    if(target.endsWith(':commit')){
      const request=JSON.parse(init.body);commits.push(request);
      for(const write of request.writes){const path=write.update.name.slice(ROOT.length+1),current=stored.get(path);
        if(write.currentDocument.exists===false?current:current?.updateTime!==write.currentDocument.updateTime)return new Response('{}',{status:412});}
      for(const write of request.writes){const path=write.update.name.slice(ROOT.length+1);stored.set(path,{fields:{...(stored.get(path)?.fields||{}),...write.update.fields},updateTime:'2026-09-22T12:00:01.000000Z'});}
      return new Response(JSON.stringify({writeResults:[],commitTime:'2026-09-22T12:00:01.000000Z'}),{status:200});
    }
    const path=decodeURIComponent(new URL(target).pathname.split('/documents/')[1]||''),row=stored.get(path);
    return row?new Response(JSON.stringify({name:`${ROOT}/${path}`,...row}),{status:200}):new Response('{}',{status:404});
  };
  const runs=[],options={...writeOptions({'hub.synthetic.save':titleEntry(runs)},null),storage:env=>dispatchStorage(env,fetcher)};
  const body={command:'hub.synthetic.save',requestId:randomUUID(),expectedRevision:'2026-09-21T18:00:00.000000Z',title:'New'};
  const first=await runHubCommand({},manager,body,options);
  assert.equal(commits.length,1);
  const writes=commits[0].writes;
  assert.deepEqual(writes.map(write=>[write.update.name.slice(ROOT.length+1),write.currentDocument]),[['synthetic_records/rec-1',{updateTime:'2026-09-21T18:00:00.000000Z'}],[`hub_command_operations/${body.requestId}`,{exists:false}]]);
  assert.deepEqual(writes[1].updateMask.fieldPaths.sort(),['actor','after','at','attempt','before','command','delegatedBy','fingerprint','requestId','user']);
  assert.deepEqual([first.replayed,first.before,first.after],[false,{title:'Old',revision:body.expectedRevision},{title:'New'}]);
  assert.deepEqual(await runHubCommand({},manager,body,options),{...first,replayed:true});
  assert.equal(runs.length,1);assert.equal(commits.length,1);
  await rejectsCode(runHubCommand({},manager,{...body,title:'Other'},options),'hub_idempotency_conflict',409);
});

test('hub command receipts are server-only in firestore.rules',()=>{
  const rules=readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
  assert.match(rules,/match \/hub_command_operations\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
  assert.match(rules,/match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);
});

test('the Hub runner and the API schema share one requestId rule',async()=>{
  const registry={'hub.synthetic.save':{...titleEntry([]),revisioned:false,handler:async store=>{await store.commit([],{before:null,after:{ok:true}});}}};
  for(const [id,valid] of [[randomUUID(),true],['0190f3a2-7c1e-7d4b-9a2f-3c5e8b1d2f40',true],['6BA7B810-9DAD-11D1-80B4-00C04FD430C8',true],['00000000-0000-0000-0000-000000000000',false],['ffffffff-ffff-ffff-ffff-ffffffffffff',false],['6ba7b810-9dad-01d1-80b4-00c04fd430c8',false],['6ba7b810-9dad-91d1-80b4-00c04fd430c8',false],['6ba7b810-9dad-11d1-c0b4-00c04fd430c8',false]]){
    assert.equal(HUB_REQUEST_ID_PATTERN.test(id),valid,id);
    const run=runHubCommand({},manager,{command:'hub.synthetic.save',requestId:id,title:'x'},writeOptions(registry,memoryStore().store));
    if(valid)assert.equal((await run).requestId,id);else await rejectsCode(run,'hub_request_id_required',400);
  }
});

test('handler failures never relay Hub messages or storage internals over the bridge',async()=>{
  const registry=handler=>({'hub.synthetic.read':{write:false,integrationAllowed:true,roles:['owner'],ownerOnly:false,confirmRequired:false,input:input=>input,handler}});
  const options=handler=>({registry:registry(handler),storage:()=>({}),profiles:()=>profiles,delegates:()=>delegates,now});
  await rejectsCode(runHubCommand({},owner,{command:'hub.synthetic.read'},options(async()=>{throw new Error('postgres://private-password@db Synthetic Customer');})),'hub_source_unavailable',503);
  await rejectsCode(runHubCommand({},owner,{command:'hub.synthetic.read'},options(async()=>{throw Object.assign(new Error('Customer 555-0100 conflicts'),{code:'dispatch_conflict',status:409});})),'dispatch_conflict',409);
  await rejectsCode(runHubCommand({},owner,{command:'hub.synthetic.read'},options(async()=>{throw Object.assign(new Error('x'),{code:'EMPLOYEE_HUB_STORAGE_UNREADABLE',status:503});})),'hub_source_unavailable',503);
  await rejectsCode(runHubCommand({},owner,{command:'hub.synthetic.read'},options(async()=>{throw Object.assign(new Error('x'),{code:'dispatch_weird',status:500});})),'hub_source_unavailable',503);
  await rejectsCode(runHubCommand({},owner,{command:'hub.synthetic.read'},options(async()=>['not','a','record'])),'hub_result_invalid',503);
  await rejectsCode(runHubCommand({},grant,{command:'hub.synthetic.read',delegate:'tylerg'},{...options(async()=>({})),delegates:()=>operationsDelegates({EGC_OPERATIONS_HUB_DELEGATES_JSON:'{'})}),'hub_delegate_config_invalid',503);
});

const staffEnv=extra=>({EGC_OPERATIONS_ENABLED:'true',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key,FIREBASE_API_KEY:'firebase-test-hub-bridge',
  HUB_AUTH_USERS_JSON:JSON.stringify({zacb:{passwordHash:'synthetic-hash-never-returned',role:'owner',displayName:'Synthetic Owner',hourlyRate:987.65},tylerg:{passwordHash:'synthetic-hash-never-returned',role:'manager',displayName:'Synthetic Manager',hourlyRate:876.54},crew1:{passwordHash:'synthetic-hash-never-returned',role:'crew',displayName:'Synthetic Crew',hourlyRate:765.43}}),...extra});
async function signed(actor,body,env=staffEnv()){
  const claims={v:1,iss:'portal',aud:'egc-portal',iat:Math.floor(Date.parse(NOW)/1000),nonce:randomUUID(),actor,request:{requestId:randomUUID(),body}};
  const response=await portal({request:new Request('https://portal.test/api/operations-portal',{method:'POST',body:JSON.stringify({envelope:await signOperationsEnvelope(claims,key)})}),env});
  return {status:response.status,body:await response.json()};
}

test('the signed portal endpoint routes hub commands through the registry and keeps legacy commands unchanged',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
  const hosts=[];t.mock.method(globalThis,'fetch',async input=>{const url=new URL(String(input));hosts.push(url.hostname);throw new Error('no network in this test');});
  const roster=await signed(owner,{command:'hub.staff.roster'});
  assert.equal(roster.status,200);assert.equal(roster.body.authority,'employee_hub');
  assert.deepEqual(roster.body.staff,[{id:'crew1',name:'Synthetic Crew',role:'crew'},{id:'tylerg',name:'Synthetic Manager',role:'manager'},{id:'zacb',name:'Synthetic Owner',role:'owner'}]);
  assert.equal(/hourlyRate|987\.65|765\.43|synthetic-hash/.test(JSON.stringify(roster.body)),false);
  assert.deepEqual(await signed(owner,{command:'hub.nope'}),{status:400,body:{error:'hub_command_unknown'}});
  assert.deepEqual(await signed(grant,{command:'hub.staff.roster'}),{status:403,body:{error:'hub_delegate_required'}});
  assert.deepEqual(await signed(grant,{command:'hub.staff.roster',delegate:'zacb'}),{status:403,body:{error:'hub_delegate_unverified'}});
  const delegated=await signed(grant,{command:'hub.staff.roster',delegate:'zacb'},staffEnv({EGC_OPERATIONS_HUB_DELEGATES_JSON:JSON.stringify({[grant.id]:'zacb'})}));
  assert.equal(delegated.status,200);assert.deepEqual(delegated.body.actedAs,{user:'zacb',delegatedBy:grant.id});
  assert.deepEqual(await signed(owner,{command:'task.create'}),{status:400,body:{error:'read_only_portal_command_required'}});
  const members=await signed(owner,{command:'portal.members'});
  assert.equal(members.status,200);assert.deepEqual(members.body.members.map(m=>m.id).sort(),['tylerg','zacb']);
  assert.deepEqual(await signed({...owner,workspace:'other'},{command:'hub.staff.roster'}),{status:403,body:{error:'workspace_forbidden'}});
  assert.deepEqual(hosts,[]);
});

test('the signed portal endpoint serves hub.dispatch.overview from Firestore storage and fails closed when storage is unavailable',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
  const doc=(collection,id,fields)=>({name:`projects/egcw-1ec83/databases/(default)/documents/${collection}/${id}`,updateTime:'2026-09-21T18:00:00.000000Z',fields:encodeFirestoreFields(fields)});
  let available=true;const seen=[];
  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(String(input));assert.equal(url.hostname,'firestore.googleapis.com');assert.equal(url.searchParams.get('key'),'firebase-test-hub-bridge');seen.push(url.pathname.split('/').pop());
    if(!available)return new Response('{}',{status:503});
    // No owner dispatch settings are saved (dispatch-settings.js): the defaults apply.
    if(url.pathname.endsWith('/dispatchSettings/current'))return new Response('{}',{status:404});
    const documents=url.pathname.endsWith('/jobs')?[doc('jobs','job-a',{type:'job',customerId:'c1',customer:'Synthetic Customer',address:'100 Synthetic Street',date:'2026-09-23',time:'08:00',endTime:'10:00',assignedCrew:['crew1'],jobInstructions:'Synthetic scope',status:'scheduled'})]:[];
    return new Response(JSON.stringify({documents}),{status:200,headers:{'Content-Type':'application/json'}});
  });
  const result=await signed(manager,{command:'hub.dispatch.overview',view:'schedule'});
  assert.equal(result.status,200);assert.deepEqual(result.body.jobs.map(job=>[job.id,job.revision,job.startAt]),[['job-a','2026-09-21T18:00:00.000000Z','2026-09-23T14:00:00.000Z']]);
  assert.deepEqual(result.body.coverage,{complete:true,asOf:NOW});assert.deepEqual(seen.sort(),['current','dispatchResources','jobs']);
  available=false;
  assert.deepEqual(await signed(manager,{command:'hub.dispatch.overview',view:'schedule'}),{status:503,body:{error:'dispatch_storage_unavailable'}});
});
