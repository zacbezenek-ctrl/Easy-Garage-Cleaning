import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryStore} from './helpers/dispatch-legacy-scenario.mjs';
import {previewRecording,saveRecording,readRecordingAppointment} from '../functions/_lib/walkthrough-recording.js';
import {walkthroughRecordingHandlers} from '../functions/api/walkthrough-recording.js';
import {mutateDispatch} from '../functions/_lib/dispatch-service.js';
import {resolveScheduledVisit,mutateScheduledVisit,linkScheduledCustomer} from '../functions/_lib/operations-scheduling.js';
import {scheduleTagWrites,outcomeTagWrites} from '../functions/_lib/ghl-tag-outbox.js';
import {scheduleMirrorWrites} from '../functions/_lib/ghl-schedule-mirror.js';
import {highLevelRequestLog,FLAG_OFF_ENV} from './helpers/ghl-track-fixture.mjs';

const owner={user:'ZacB',role:'owner',businessAccess:true};
const now=()=>new Date('2026-10-27T21:00:00Z');
const base={mode:'hub_only',customerId:'c1',employeeId:'crew1',address:'100 Synthetic Oak Street',scope:'Review storage and tools',reason:'Owner records an agreed visit without a provider booking',date:'2026-10-27',time:'14:30',endTime:'15:00'};
const imported={...base,mode:'import',appointmentId:'appt-1',calendarId:'cal-1'};
for(const key of ['date','time','endTime'])delete imported[key];
const source={appointmentId:'appt-1',calendarId:'cal-1',calendarName:'Personal calendar',contactId:'contact-1',locationId:'loc-1',startAt:'2026-10-30T21:30:00.000Z',endAt:'2026-10-30T22:15:00.000Z',status:'confirmed',assignedUserId:'user-1',providerAddress:'100 Synthetic Oak Street',providerUpdatedAt:null};
function fixture(){const f=memoryStore();f.rows.get('customers/c1').highlevelContactId='contact-1';f.store.ghlTagOutbox=true;f.store.ghlScheduleMirror=true;let calls=0;return{...f,deps:{now,appointment:async()=>{calls++;return structuredClone(source);}},calls:()=>calls};}
async function reviewed(f,input=base){const r=await previewRecording(f.store,owner,input,{},f.deps);return{input,fingerprint:r.fingerprint,requestId:randomUUID()};}
const code=expected=>e=>e.code===expected;

test('only the signed owner can preview or save, before any reads; strict payload rejects sync overrides',async()=>{
  for(const actor of [null,{user:'ZacB',role:'crew'}, {user:'manager',role:'manager',businessAccess:true},{user:'sales',role:'sales'}, {id:'booking-adoption-worker',kind:'integration',role:'integration'}]){
    const store={read(){assert.fail('no reads');}};
    await assert.rejects(previewRecording(store,actor,base,{}, {now}),e=>[401,403].includes(e.status));
    await assert.rejects(saveRecording(store,actor,{},{}),e=>[401,403].includes(e.status));
  }
  const f=fixture();
  await assert.rejects(previewRecording(f.store,owner,{...base,syncStatus:'synced'}, {},f.deps),code('dispatch_recording_invalid'));
  await assert.rejects(mutateDispatch(f.store,owner,{action:'schedule.create',requestId:randomUUID(),kind:'walkthrough',customerId:'c1',ownerWalkthrough:{providerWrites:'blocked'},changes:{}}),code('dispatch_patch_not_allowed'));
  await assert.rejects(mutateDispatch(f.store,{user:'manager',role:'manager',businessAccess:true},{action:'schedule.create',kind:'walkthrough'},{},{authorize:()=>{},ownerWalkthrough:{providerWrites:'blocked'}}),code('dispatch_recording_forbidden'));
});

test('Hub-only uses native locks, assignment and audit while retaining the contact and creating no outbox',async()=>{
  const f=fixture(),body=await reviewed(f),r=await saveRecording(f.store,owner,body,{},f.deps),job=f.rows.get('jobs/'+r.job.id);
  assert.equal(f.calls(),0);assert.equal(job.highlevelContactId,'contact-1');assert.equal(job.highlevelAppointmentId,undefined);
  assert.match(job.id,/^recorded_visit_[a-f0-9]{40}$/);
  assert.equal(job.startAt,'2026-10-27T20:30:00.000Z');assert.equal(job.endAt,'2026-10-27T21:00:00.000Z');
  assert.deepEqual(job.assignedCrew,['crew1']);assert.equal(job.notify,false);assert.equal(job.syncStatus,'not_needed');assert.equal(r.providerWrites,false);
  assert.equal(job.ownerWalkthrough.recordedBy,'ZacB');assert.equal(f.rows.get('dispatchOperations/'+body.requestId).after.ownerWalkthrough.providerWrites,'blocked');
  assert.equal(f.rows.get('jobs/_egc_schedule_lock_2026-10-27').entries.length,1);
  assert.equal([...f.rows.keys()].some(k=>/^ghl/.test(k)),false);
});

test('imports exact duration, calendar and DST instants as a snapshot without provider writes',async()=>{
  const f=fixture(),body=await reviewed(f,imported),r=await saveRecording(f.store,owner,body,{},f.deps);
  assert.equal(f.calls(),3);assert.equal(r.job.time,'15:30');assert.equal(r.job.endTime,'16:15');assert.equal(r.job.syncStatus,'imported');assert.equal(r.job.highlevelCalendarId,'cal-1');
  assert.equal(f.rows.get('walkthroughProviderLinks/appt-1').jobId,r.job.id);
  assert.equal([...f.rows.keys()].some(k=>/^ghl/.test(k)),false);
  const g=fixture();g.deps.appointment=async()=>({...source,startAt:'2026-11-05T23:30:00.000Z',endAt:'2026-11-06T00:00:00.000Z'});
  const p=await previewRecording(g.store,owner,imported,{},g.deps);assert.equal(p.snapshot.date,'2026-11-05');assert.equal(p.snapshot.time,'16:30');assert.equal(p.snapshot.endTime,'17:00');assert.equal(p.snapshot.durationMinutes,30);
});

test('duplicate clicks, retries and ambiguous success keep one visit and one import claim',async()=>{
  const f=fixture(),body=await reviewed(f,imported),commit=f.store.commit;
  f.store.commit=async writes=>{await commit(writes);throw new Error('lost response');};
  const r=await saveRecording(f.store,owner,body,{},f.deps);assert.ok(r.job.id);
  const calls=f.calls();assert.equal((await saveRecording(f.store,owner,body,{},f.deps)).job.id,r.job.id);assert.equal(f.calls(),calls);
  await assert.rejects(saveRecording(f.store,owner,{...body,input:{...body.input,reason:'different'}},{},f.deps),code('dispatch_recording_idempotency_conflict'));
  f.store.commit=commit;
  await assert.rejects(saveRecording(f.store,owner,{...body,requestId:randomUUID()},{},f.deps),code('dispatch_recording_already_imported'));
  assert.equal([...f.rows.values()].filter(row=>row.ownerWalkthrough).length,1);
  const g=fixture(),same=await reviewed(g);const results=await Promise.all(Array.from({length:4},()=>saveRecording(g.store,owner,same,{},g.deps)));
  assert.equal(new Set(results.map(r=>r.job.id)).size,1);
  const h=fixture(),one=await reviewed(h,imported),two={...one,requestId:randomUUID()};
  const imports=await Promise.allSettled([saveRecording(h.store,owner,one,{},h.deps),saveRecording(h.store,owner,two,{},h.deps)]);
  assert.equal(imports.filter(r=>r.status==='fulfilled').length,1);
  assert.equal([...h.rows.values()].filter(row=>row.ownerWalkthrough).length,1);
});

test('changed preview, legacy appointment links, conflicting slots and stale customer revisions fail closed',async()=>{
  const f=fixture(),body=await reviewed(f,imported);f.deps.appointment=async()=>({...source,startAt:'2026-10-31T21:30:00.000Z',endAt:'2026-10-31T22:15:00.000Z'});
  await assert.rejects(saveRecording(f.store,owner,body,{},f.deps),code('dispatch_recording_changed'));
  const g=fixture(),b=await reviewed(g,imported);g.rows.set('jobs/old',{id:'old',type:'walkthrough',date:'2026-10-29',time:'12:00',highlevelAppointmentId:'appt-1',status:'cancelled'});
  await assert.rejects(saveRecording(g.store,owner,b,{},g.deps),code('dispatch_recording_already_imported'));
  const h=fixture(),first=await reviewed(h);await saveRecording(h.store,owner,first,{},h.deps);
  await assert.rejects(saveRecording(h.store,owner,await reviewed(h,{...base,customerId:'c2'}),{},h.deps),code('dispatch_conflict'));
  const c=fixture(),cb=await reviewed(c);c.rows.get('customers/c1').revision='changed';await assert.rejects(saveRecording(c.store,owner,cb,{},c.deps),code('dispatch_recording_changed'));
  const d=fixture(),db=await reviewed(d,imported);let reads=0;d.deps.appointment=async()=>++reads===1?source:{...source,status:'cancelled'};
  await assert.rejects(saveRecording(d.store,owner,db,{},d.deps),code('dispatch_recording_changed'));
  assert.equal([...d.rows.values()].some(row=>row.ownerWalkthrough),false);
});

test('invalid, ambiguous DST, old date and unknown staff are refused',async()=>{
  const f=fixture();
  for(const input of [{...base,time:'15:00',endTime:'14:30'},{...base,date:'2026-11-01',time:'01:30',endTime:'02:00'},{...base,date:'2026-10-26'},{...base,employeeId:'removed'}])await assert.rejects(previewRecording(f.store,owner,input,{},f.deps));
});

test('provider GET validation requires exact contact, location, calendar, appointment and active status',async()=>{
  const env={HIGHLEVEL_API_KEY:'synthetic',HIGHLEVEL_LOCATION_ID:'loc-1'},customer={highlevelContactId:'contact-1',phone:'9705550101'};
  const good={id:'appt-1',calendarId:'cal-1',contactId:'contact-1',startTime:source.startAt,endTime:source.endAt,appointmentStatus:'confirmed'};
  async function run({event=good,contact={id:'contact-1',locationId:'loc-1',phone:'9705550101'},calendars=[{id:'cal-1',name:'Personal Calendar',locationId:'loc-1'}]}={}){
    const methods=[];const result=await readRecordingAppointment(env,imported,customer,async(url,options)=>{methods.push(options.method||'GET');return Response.json(url.includes('/contacts/')?{contact}:url.includes('events/appointments')?{event}:{calendars});});
    assert.deepEqual(methods,['GET','GET','GET']);return result;
  }
  assert.equal((await run()).endAt,source.endAt);
  for(const patch of [{id:'other'},{calendarId:'other'},{contactId:'other'},{locationId:'other'},{appointmentStatus:'cancelled'},{appointmentStatus:'noshow'},{appointmentStatus:'invalid'},{startTime:'2026-10-30T15:30:00'},{endTime:'2026-10-30T22:15:01Z'}])await assert.rejects(run({event:{...good,...patch}}));
  await assert.rejects(run({contact:{id:'contact-1',locationId:'loc-2',phone:'9705550101'}}));
  await assert.rejects(run({contact:{id:'contact-1',locationId:'loc-1',phone:'9705550199'}}));
  await assert.rejects(run({calendars:[]}));
});

test('later schedule paths cannot create provider writes or turn on notifications',async()=>{
  const f=fixture(),r=await saveRecording(f.store,owner,await reviewed(f),{},f.deps),job=f.rows.get('jobs/'+r.job.id);
  const moved=await mutateDispatch(f.store,owner,{action:'schedule.update',requestId:randomUUID(),jobId:job.id,expectedRevision:job.revision,changes:{date:'2026-10-28',notify:true}},now().toISOString());
  assert.equal(moved.job.notify,false);assert.equal(moved.job.syncStatus,'not_needed');assert.equal([...f.rows.keys()].some(k=>/^ghl/.test(k)),false);
  await assert.rejects(resolveScheduledVisit(f.store,job.id),code('schedule_owner_recording_read_only'));
  await assert.rejects(linkScheduledCustomer(f.store,{kind:'integration',role:'integration'},{portalVisitId:job.id,expectedRevision:moved.job.revision,providerContact:{id:'contact-1'}}),code('schedule_owner_recording_read_only'));
  await assert.rejects(mutateScheduledVisit(f.store,{id:'ZacB',kind:'human',role:'owner'},{mode:'update',portalCustomerId:'c1',portalVisitId:job.id,requestId:randomUUID(),expectedRevision:moved.job.revision,changes:{}}),code('schedule_owner_recording_read_only'));
  assert.equal(await scheduleTagWrites({jobId:job.id,after:job,action:'schedule.create',requestId:randomUUID(),now:now().toISOString()}),null);
  assert.equal(await outcomeTagWrites({visit:job,outcome:'no_show',requestId:randomUUID(),now:now().toISOString()}),null);
  assert.deepEqual(await scheduleMirrorWrites(f.store,{jobId:job.id,after:job,action:'schedule.create'}),[]);
  const g=fixture(),im=await saveRecording(g.store,owner,await reviewed(g,imported),{},g.deps);
  await assert.rejects(mutateDispatch(g.store,owner,{action:'schedule.cancel',requestId:randomUUID(),jobId:im.job.id,expectedRevision:im.job.revision,changes:{}},now().toISOString()),code('dispatch_recording_import_read_only'));
});

test('actual HighLevel route blocks every handoff tool before provider calls',async t=>{
  const job={type:'walkthrough',customerId:'c1',ownerWalkthrough:{providerWrites:'blocked',mode:'hub_only'}};
  const jobId='recorded_visit_'+'a'.repeat(40);
  const requests=new Map(['schedule','lifecycle','post_job','game_plan','sales_exit'].map(tool=>[tool,{tool,job_id:jobId,event:'job-cancelled'}]));
  const r=await highLevelRequestLog(t,FLAG_OFF_ENV,{[jobId]:job},requests);
  assert.equal(r.calls.length,0);for(const response of r.responses){assert.equal(response.status,409);assert.equal(response.body.code,'OWNER_RECORDING_READ_ONLY');}
});

test('owner HTTP route protects origin/content type and preview never writes',async()=>{
  const f=fixture(),handler=walkthroughRecordingHandlers({session:async()=>owner,storage:()=>f.store,...f.deps}).post;
  const req=(body,headers={})=>({request:new Request('https://example.invalid/api/walkthrough-recording',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),env:{}});
  assert.equal((await handler(req({action:'preview',input:base},{Origin:'https://evil.invalid'}))).status,403);
  assert.equal((await handler(req({action:'preview',input:base},{'Content-Type':'text/plain'}))).status,415);
  for(const actor of [null,{user:'other',role:'owner',businessAccess:true},{user:'sales',role:'sales'},{user:'crew1',role:'crew'}]) {
    const denied=walkthroughRecordingHandlers({session:async()=>actor,storage:()=>{assert.fail('forbidden request reached storage');}}).post;
    assert.ok([401,403].includes((await denied(req({action:'preview',input:base}))).status));
  }
  const r=await handler(req({action:'preview',input:base}));assert.equal(r.status,200);assert.equal([...f.rows.values()].some(row=>row.ownerWalkthrough),false);
  assert.equal((await handler(req({action:'save',input:base}))).status,400);
});
