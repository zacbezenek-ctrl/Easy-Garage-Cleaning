/** The schedule-sync loop end to end: the real Hub queue, resolve, link and bind
 * (functions/_lib over an in-memory revisioned store, with the bridge's error mapping),
 * the real OperationsService, syncPortalSchedule, ReliableAppointments and its Postgres
 * appointment ledger. Only GHL is synthetic. */
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getDb,schema} from '@egc/database';
import {and,eq,like,sql} from 'drizzle-orm';
import {OperationsService,OperationsError} from '@egc/operations';
import {syncPortalSchedule} from '../dist/scheduling.js';
import {runScheduleSyncTick} from '../dist/schedule-sync-worker.js';
import {runScheduleSyncCommand} from '../../../../functions/_lib/schedule-sync-queue.js';
import {resolveScheduledVisit,linkScheduledCustomer,bindScheduledProvider,mutateScheduledVisit} from '../../../../functions/_lib/operations-scheduling.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const db=getDb(),originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No HTTP in schedule sync fixtures');};
const NOW=Date.parse('2026-09-22T12:00:00.000Z');
const PAGE={id:'hub-schedule:zacb',kind:'integration',role:'integration',workspace:'egc'};
// egc-api's own env: EGC_SCHEDULE_SYNC_WORKER=true runs the loop and turns on syncPortalSchedule's post-bind
// read-back for every caller; the 'flag off' tests below set it back to {}.
const FLAG_ON=Object.freeze({EGC_SCHEDULE_SYNC_WORKER:'true'});
let clock,rows,revision,events,writes,provider,hub,contactId,failBind,failEvents,interleave,apiEnv;
const minutes=n=>new Date(NOW+n*60000).toISOString();
const iso=()=>new Date(clock).toISOString();
const visit=(id,extra={})=>({id,type:'job',customerId:'customer-exact',projectId:`project_${id}`,customer:'Synthetic Customer',highlevelContactId:contactId,date:'2026-09-30',time:'09:00',endTime:'11:00',status:'scheduled',pipelineStatus:'scheduled',title:'Synthetic garage job',address:'100 Synthetic Way',providerSyncOwner:'operations',syncStatus:'pending',syncIdempotencyKey:randomUUID(),dispatchUpdatedAt:'2026-09-21T10:00:00.000Z',...extra});
const job=id=>structuredClone(rows.get(`jobs/${id}`));
// An unconditional merge, like the page's patchJob, bumps the revision.
const set=(id,patch)=>rows.set(`jobs/${id}`,{...rows.get(`jobs/${id}`),...patch,revision:`r${++revision}`});
const seed=(...visits)=>{for(const v of visits){rows.set(`jobs/${v.id}`,{...v,revision:`r${++revision}`});rows.set(`projects/${v.projectId}`,{id:v.projectId,customerId:'customer-exact',sourceRecordId:v.id,authority:'employee_hub',revision:`r${++revision}`});}};
// A provider appointment booked before the dispatch reschedule.
const book=(id,v,startTime,endTime)=>events.set(id,{id,contactId,calendarId:'job',title:v.title,address:v.address,startTime,endTime,appointmentStatus:'confirmed'});
const store={
 async due(){return {rows:[...rows.entries()].filter(([key,r])=>key.startsWith('jobs/')&&['pending','error','syncing'].includes(r.syncStatus)).map(([,r])=>structuredClone(r)),truncated:false};},
 async read(collection,id){return structuredClone(rows.get(`${collection}/${id}`)??null);},
 // mutateScheduledVisit's day scan (the per-day schedule locks live in jobs too).
 async day(date){return [...rows.entries()].filter(([key,r])=>key.startsWith('jobs/')&&r.date===date).map(([,r])=>structuredClone(r));},
 async customers(providerId){return [...rows.entries()].filter(([key,r])=>key.startsWith('customers/')&&r.highlevelContactId===providerId).map(([,r])=>structuredClone(r));},
 async commit(writes){
  const targets=new Set();
  for(const w of writes){const key=`${w.collection}/${w.id}`,prior=rows.get(key);assert.ok(!targets.has(key));targets.add(key);if(w.revision?prior?.revision!==w.revision:prior)throw Object.assign(new Error('schedule_revision_conflict'),{status:409});}
  for(const w of writes){const key=`${w.collection}/${w.id}`;rows.set(key,{...rows.get(key),...structuredClone(w.patch),id:w.id,revision:`r${++revision}`});}
  return {};
 }
};
beforeEach(async()=>{
 await db.execute(sql`truncate appointment_operations`);
 await db.delete(schema.contacts).where(like(schema.contacts.providerId,'schedule-sync-fixture-%'));
 contactId='schedule-sync-fixture-'+randomUUID();clock=NOW;revision=0;events=new Map();writes=[];failBind=0;failEvents=0;interleave=null;apiEnv=FLAG_ON;
 rows=new Map([['customers/customer-exact',{id:'customer-exact',name:'Synthetic Customer',highlevelContactId:contactId,revision:'customer-r0'}]]);
 provider={locationId:'location',getContact:async id=>({contact:{id,locationId:'location',name:'Synthetic',email:'synthetic@example.invalid'}}),getCalendars:async()=>({calendars:[{id:'walk',name:'Free Walkthrough'},{id:'job',name:'Customer Jobs'}]}),getCalendarEvents:async()=>{if(failEvents>0){failEvents--;throw new Error('synthetic provider outage');}return {events:[...events.values()]};},getAppointment:async id=>{if(interleave){const run=interleave;interleave=null;await run();}if(!events.has(id))throw new Error('missing');return {event:events.get(id)};},
  createAppointment:async payload=>{writes.push({kind:'create',...payload});const event={...payload,id:`event-${writes.length}`,dateAdded:'2026-09-22T12:00:00.000Z'};events.set(event.id,event);return{event};},
  updateAppointment:async(id,payload)=>{writes.push({kind:'update',id,...payload});const event={...events.get(id),...payload,id};events.set(id,event);return{event};}};
 // The real Hub behind the bridge: the portal replies {error: code} with the Hub's status and the
 // API's portalAdapter turns it into an OperationsError (unknown codes collapse to portal_authority_unavailable).
 hub=async(actor,command)=>{
  try{
   if(command.command==='schedule.sync_due'||command.command==='schedule.sync_failed')return await runScheduleSyncCommand({EGC_SCHEDULE_SYNC_WORKER:'true'},actor,command,{store,now:new Date(clock)});
   if(command.command==='schedule.resolve')return await resolveScheduledVisit(store,command.portalVisitId);
   if(command.command==='schedule.link_customer')return await linkScheduledCustomer(store,actor,command,iso());
   if(command.command==='schedule.bind_provider'){if(failBind>0){failBind--;throw Object.assign(new Error('portal_source_unavailable'),{status:503});}return await bindScheduledProvider(store,actor,command,iso());}
  }catch(error){
   if(!error.status)throw error;
   throw new OperationsError(/^schedule_[a-z_]+$/.test(error.message)?error.message:'portal_authority_unavailable',error.status>=500?503:error.status);
  }
  throw new Error('Unexpected Hub command '+command.command);
 };
});
after(async()=>{globalThis.fetch=originalFetch;await db.delete(schema.contacts).where(like(schema.contacts.providerId,'schedule-sync-fixture-%'));await db.$client.end({timeout:5});});
const service=()=>new OperationsService(db,{workspace:'egc',now:()=>new Date(clock),portalRead:hub,syncSchedule:(actor,command)=>syncPortalSchedule(actor,command,hub,{db,provider,env:apiEnv})});
const tick=()=>{const operations=service();return runScheduleSyncTick({execute:(actor,body,requestId)=>operations.execute(actor,body,requestId),now:()=>clock});};
// The page's retry (employee-suite.js syncJobRecord through /api/highlevel): the visit's own key, automations on.
// MCP egc.schedule_visit never uses the visit key: it syncs under its own requestId (mcpSync below).
const pageSync=(portalVisitId,requestId)=>service().execute(PAGE,{command:'schedule.sync_provider',portalVisitId,requestId,runAutomations:true},randomUUID());
const pageErrorWrite=(id,retryAt)=>set(id,{syncStatus:'error',syncError:'HighLevel sync failed',syncNextRetryAt:retryAt,syncAttempts:1,syncLastAttemptAt:iso(),updatedAt:iso()});
const counts=extra=>({due:0,selected:0,synced:0,notNeeded:0,failed:0,conflicts:0,stateConflicts:0,unrecorded:0,deferred:0,complete:true,heartbeat:true,...extra});

test('reruns never repeat a provider write and a multi-day visit is mirrored with its true end',async()=>{
 seed(visit('single'),visit('multi-day',{date:'2026-10-30',time:'08:00',endDate:'2026-11-02',endTime:'12:00'}));
 const first=await tick();
 assert.deepEqual(first.counts,counts({due:2,selected:2,synced:2}));
 assert.equal(writes.length,2);
 const multiDay=writes.find(w=>w.startTime==='2026-10-30T14:00:00.000Z');
 assert.equal(multiDay.endTime,'2026-11-02T19:00:00.000Z');
 assert.ok(writes.every(w=>w.toNotify===false),'automations stay off for the mirror');
 assert.deepEqual(['single','multi-day'].map(id=>job(id).syncStatus),['synced','synced']);
 assert.equal(rows.get('scheduleSyncState/worker').lastDueAt,minutes(0),'each tick checks in');
 for(let i=0;i<3;i++){clock+=120000;assert.equal((await tick()).counts.selected,0);}
 // A forced replay of the same Hub state and key writes nothing new and leaves the visits synced.
 for(const id of ['single','multi-day'])set(id,{syncStatus:'pending'});
 assert.equal((await tick()).counts.synced,2);
 assert.deepEqual(['single','multi-day'].map(id=>job(id).syncStatus),['synced','synced']);
 clock+=120000;assert.equal((await tick()).counts.selected,0,'the replay left the queue');
 assert.equal(writes.length,2);
 const ledger=await db.select().from(schema.appointmentOperations);
 assert.ok(ledger.every(o=>o.status==='accepted'&&o.operationKey.endsWith(':mirror')));
});

test('a lost Hub bind backs off and the retry under the same key reuses the accepted provider appointment',async()=>{
 seed(visit('single'));failBind=1;
 const first=await tick();
 assert.deepEqual([first.counts.synced,first.counts.failed],[0,1]);
 const failed=job('single');
 assert.deepEqual([failed.syncStatus,failed.syncError,failed.syncNextRetryAt,failed.syncFailureKey],['error','portal_authority_unavailable',minutes(10),`${failed.syncIdempotencyKey}:mirror`]);
 assert.equal(writes.length,1,'the provider write happened once');
 clock=Date.parse(minutes(5));assert.equal((await tick()).counts.selected,0);
 clock=Date.parse(minutes(10));assert.equal((await tick()).counts.synced,1);
 assert.equal(writes.length,1,'the retry verified the existing appointment instead of writing again');
 assert.deepEqual([job('single').syncStatus,job('single').highlevelAppointmentId],['synced','event-1']);
 // A reschedule is a new key: one update, then quiet again.
 set('single',{time:'10:00',endTime:'12:00',syncStatus:'pending',syncIdempotencyKey:randomUUID()});
 clock+=120000;assert.equal((await tick()).counts.synced,1);
 clock+=120000;assert.equal((await tick()).counts.selected,0);
 assert.deepEqual(writes.map(w=>[w.kind,w.startTime]),[['create','2026-09-30T15:00:00.000Z'],['update','2026-09-30T16:00:00.000Z']]);
});

test('a page error write after the worker bound a reschedule is healed on the next tick instead of looping',async()=>{
 const rescheduled=visit('rescheduled',{highlevelAppointmentId:'event-booked'});
 seed(rescheduled);book('event-booked',rescheduled,'2026-09-29T15:00:00.000Z','2026-09-29T17:00:00.000Z');
 assert.deepEqual((await tick()).counts,counts({due:1,selected:1,synced:1}));
 assert.deepEqual(writes.map(w=>[w.kind,w.id,w.startTime]),[['update','event-booked','2026-09-30T15:00:00.000Z']]);
 // The page's own attempt failed and its unconditional merge landed after the worker's bind.
 pageErrorWrite('rescheduled',minutes(10));
 clock=Date.parse(minutes(10));
 assert.deepEqual((await tick()).counts,counts({due:1,selected:1,synced:1}));
 assert.deepEqual([job('rescheduled').syncStatus,job('rescheduled').syncError,job('rescheduled').syncNextRetryAt],['synced','','']);
 for(let i=0;i<5;i++){clock+=120000;assert.equal((await tick()).counts.selected,0,'the healed visit is never selected again');}
 assert.equal(writes.length,1,'no second provider write');
 const ledger=await db.select().from(schema.appointmentOperations);
 assert.equal(ledger.length,1,'the heal replayed the one accepted operation');
});

test('the page and the worker never share a ledger key: page first then worker, and worker first then a manual retry',async()=>{
 const pageFirst=visit('page-first',{highlevelAppointmentId:'event-a'}),workerFirst=visit('worker-first',{highlevelAppointmentId:'event-b',dispatchUpdatedAt:'2026-09-21T11:00:00.000Z'});
 seed(pageFirst,workerFirst);
 book('event-a',pageFirst,'2026-09-29T15:00:00.000Z','2026-09-29T17:00:00.000Z');book('event-b',workerFirst,'2026-09-29T15:00:00.000Z','2026-09-29T17:00:00.000Z');
 // The page reached the ledger under the visit key with automations on, then lost its Hub bind.
 failBind=1;
 await assert.rejects(pageSync('page-first',pageFirst.syncIdempotencyKey),error=>error.code==='portal_authority_unavailable');
 pageErrorWrite('page-first',minutes(0));
 assert.deepEqual((await tick()).counts,counts({due:2,selected:2,synced:2}),'no appointment_idempotency_payload_conflict');
 assert.deepEqual(writes.map(w=>[w.id,w.toNotify]),[['event-a',true],['event-b',false]],'the page\'s accepted write is verified, not repeated');
 assert.deepEqual(['page-first','worker-first'].map(id=>job(id).syncStatus),['synced','synced']);
 // A manager's manual retry after the worker mirrored the change works and writes nothing.
 pageErrorWrite('worker-first',minutes(30));
 const retried=await pageSync('worker-first',workerFirst.syncIdempotencyKey);
 assert.deepEqual([retried.providerSync,job('worker-first').syncStatus,writes.length],['verified','synced',2]);
 // The ledger still refuses one key with two payloads, which is why the mirror keeps its own.
 await assert.rejects(pageSync('worker-first',`${workerFirst.syncIdempotencyKey}:mirror`),error=>error.code==='appointment_idempotency_payload_conflict');
 const ledger=await db.select().from(schema.appointmentOperations);
 assert.deepEqual(ledger.map(o=>[o.status,o.operationKey.split(':').at(-1)==='mirror']).sort(),[['accepted',false],['accepted',false],['accepted',true],['accepted',true]]);
 clock+=120000;assert.equal((await tick()).counts.selected,0);
});

const MCP={id:'mcp-service-grant',kind:'integration',role:'integration',workspace:'egc'};
// MCP egc.schedule_visit (apps/mcp synchronizeHubVisit): the bridge mutate, then schedule.sync_provider under the SAME requestId, automations off by default.
const mcpSchedule=async(requestId,time,endTime)=>(await mutateScheduledVisit(store,MCP,{command:'schedule.mutate',requestId,mode:'create',portalCustomerId:'customer-exact',kind:'job',changes:{date:'2026-09-30',time,endTime}},iso())).visit.portalVisitId;
const mcpSync=(portalVisitId,requestId)=>service().execute(MCP,{command:'schedule.sync_provider',portalVisitId,requestId,runAutomations:false},randomUUID());
// The page's auto retry, 'Retry sync' and 'Retry all' (syncJobRecord): syncPayload's key and notify!==false.
const pageRetry=id=>{const v=job(id);return service().execute(PAGE,{command:'schedule.sync_provider',portalVisitId:id,requestId:v.syncIdempotencyKey||`schedule:${v.id}:${v.updatedAt||v.createdAt}`,runAutomations:v.notify!==false},randomUUID());};

test('flag off: an MCP sync that fails after its ledger reserve never blocks the page retry of the visit it scheduled',async()=>{
 // No schedule-sync tick runs here (EGC_SCHEDULE_SYNC_WORKER off): only MCP and the page sync.
 apiEnv={};
 const requestId=randomUUID(),id=await mcpSchedule(requestId,'09:00','11:00');
 assert.equal(job(id).syncIdempotencyKey,`schedule-mutate:${requestId}`,'the visit key is minted by the Hub, never the MCP requestId');
 failEvents=1;
 await assert.rejects(mcpSync(id,requestId),error=>error.code==='appointment_preflight_unavailable');
 assert.deepEqual([writes.length,job(id).syncStatus],[0,'pending']);
 assert.deepEqual((await db.select().from(schema.appointmentOperations)).map(o=>[o.operationKey.endsWith(`:${requestId}`),o.status]),[[true,'failed']],'MCP reserved its own key');
 const retried=await pageRetry(id);
 assert.deepEqual([retried.providerSync,job(id).syncStatus],['verified','synced'],'no appointment_idempotency_payload_conflict');
 assert.deepEqual(writes.map(w=>[w.kind,w.toNotify,w.startTime]),[['create',true,'2026-09-30T15:00:00.000Z']],'one provider write, with the page\'s automations');
 // MCP then retries its documented same requestId, and a manager presses Retry sync: both verify, neither writes.
 assert.equal((await mcpSync(id,requestId)).providerSync,'verified');
 assert.equal((await pageRetry(id)).providerSync,'verified');
 assert.equal(writes.length,1);
});

test('flag off: a page retry that fails after its ledger reserve never blocks MCP retrying its own requestId',async()=>{
 apiEnv={};
 const requestId=randomUUID(),id=await mcpSchedule(requestId,'13:00','15:00');
 failEvents=1;
 await assert.rejects(pageRetry(id),error=>error.code==='appointment_preflight_unavailable');
 const retried=await mcpSync(id,requestId);
 assert.deepEqual([retried.providerSync,job(id).syncStatus],['verified','synced']);
 assert.deepEqual(writes.map(w=>[w.kind,w.toNotify,w.startTime]),[['create',false,'2026-09-30T19:00:00.000Z']]);
 assert.equal((await pageRetry(id)).providerSync,'verified','a later manual retry verifies the appointment MCP created');
 assert.equal(writes.length,1);
});

test('a worker sync that resolved an older schedule never leaves HighLevel stale behind a synced Hub',async()=>{
 // Dispatch moved the booked visit to 09:00 and its mirror is due; HighLevel still holds the old 08:00 booking.
 const raced=visit('raced',{highlevelAppointmentId:'event-raced'});
 seed(raced);book('event-raced',raced,'2026-09-30T14:00:00.000Z','2026-09-30T15:00:00.000Z');
 // Between the worker's resolve and its write, MCP reschedules to 13:00 and completes its own sync.
 interleave=async()=>{
  const requestId=randomUUID();
  await mutateScheduledVisit(store,MCP,{command:'schedule.mutate',requestId,mode:'update',portalVisitId:'raced',portalCustomerId:'customer-exact',expectedRevision:job('raced').revision,changes:{time:'13:00',endTime:'15:00'}},iso());
  assert.equal((await mcpSync('raced',requestId)).providerSync,'verified');
  assert.equal(job('raced').syncStatus,'synced');
 };
 assert.deepEqual((await tick()).counts,counts({due:1,selected:1,stateConflicts:1}),'the stale write is reported, never counted as a benign conflict');
 // The worker's 09:00 write landed after MCP's 13:00 mirror, so the Hub re-queued the visit instead of staying 'synced'.
 assert.deepEqual(writes.map(w=>[w.id,w.startTime,w.toNotify]),[['event-raced','2026-09-30T19:00:00.000Z',false],['event-raced','2026-09-30T15:00:00.000Z',false]]);
 const requeued=job('raced');
 assert.deepEqual([requeued.time,requeued.syncStatus,requeued.syncError],['13:00','pending','schedule_provider_drift']);
 assert.match(requeued.syncIdempotencyKey,/^schedule-drift:[0-9a-f-]{36}$/);
 clock+=120000;
 assert.deepEqual((await tick()).counts,counts({due:1,selected:1,synced:1}));
 assert.deepEqual([events.get('event-raced').startTime,events.get('event-raced').endTime,job('raced').syncStatus],['2026-09-30T19:00:00.000Z','2026-09-30T21:00:00.000Z','synced'],'HighLevel is back on the Hub schedule');
 for(let i=0;i<3;i++){clock+=120000;assert.equal((await tick()).counts.selected,0,'and the visit leaves the queue');}
 assert.equal(writes.length,3);
});

test('a stale worker write that binds while the visit is pending, before a newer sync binds, is caught by the read-back and re-queued',async()=>{
 // Dispatch moved the booked visit to 09:00 and its mirror is due; HighLevel still holds the old 08:00 booking.
 const raced=visit('raced-pending',{highlevelAppointmentId:'event-raced-pending'});
 seed(raced);book('event-raced-pending',raced,'2026-09-30T14:00:00.000Z','2026-09-30T15:00:00.000Z');
 // Never 'synced' while HighLevel holds another time: checked after every step below.
 const coherent=async label=>{const v=job('raced-pending');if(v.syncStatus!=='synced')return;const hubVisit=(await resolveScheduledVisit(store,'raced-pending')).visit,e=events.get('event-raced-pending');assert.deepEqual([e.startTime,e.endTime],[hubVisit.startTime,hubVisit.endTimeInstant],`${label}: a synced Hub matches HighLevel`);};
 // MCP reschedules to 13:00 between the worker's resolve and its write, and writes HighLevel first; MCP's
 // bind is held until the worker's stale 09:00 write has landed and its bind was refused while 'pending'.
 const base=hub;let mcpResolves=0,releaseGate,atGate;
 const gate=new Promise(resolve=>{releaseGate=resolve;}),reachedGate=new Promise(resolve=>{atGate=resolve;});
 hub=async(actor,command)=>{
  if(actor.id===MCP.id&&command.command==='schedule.resolve'&&++mcpResolves===2){atGate();await gate;}
  return base(actor,command);
 };
 let mcpDone,mcpRequestId;
 interleave=async()=>{
  mcpRequestId=randomUUID();
  await mutateScheduledVisit(store,MCP,{command:'schedule.mutate',requestId:mcpRequestId,mode:'update',portalVisitId:'raced-pending',portalCustomerId:'customer-exact',expectedRevision:job('raced-pending').revision,changes:{time:'13:00',endTime:'15:00'}},iso());
  mcpDone=mcpSync('raced-pending',mcpRequestId).then(value=>({value}),error=>({error}));
  await reachedGate;
 };
 const first=await tick();
 assert.deepEqual(first.counts,counts({due:1,selected:1,stateConflicts:1}),'the worker\'s refused bind is a state conflict, never a benign one');
 assert.deepEqual([job('raced-pending').syncStatus,events.get('event-raced-pending').startTime],['pending','2026-09-30T15:00:00.000Z'],'the stale 09:00 write landed after MCP\'s 13:00 write');
 await coherent('after the worker');
 releaseGate();
 const mcp=await mcpDone;
 // MCP's bind marked the visit synced; its read-back found 09:00 and re-queued it under a fresh drift key.
 assert.equal(mcp.error?.code,'schedule_provider_drift');
 const requeued=job('raced-pending');
 assert.deepEqual([requeued.time,requeued.syncStatus,requeued.syncError],['13:00','pending','schedule_provider_drift']);
 assert.match(requeued.syncIdempotencyKey,/^schedule-drift:[0-9a-f-]{36}$/);
 await coherent('after MCP');
 const [mcpOperation]=(await db.select().from(schema.appointmentOperations)).filter(o=>o.operationKey.endsWith(`:${mcpRequestId}`));
 assert.equal(mcp.error.details.operationId,mcpOperation.id);
 const [drift]=await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action,'schedule.provider.drift'),sql`${schema.auditLogs.newValue}->>'operationId'=${mcpOperation.id}`));
 assert.deepEqual([drift.actor,drift.newValue.portalVisitId,drift.newValue.providerAppointmentId],[MCP.id,'raced-pending','event-raced-pending'],'the drift is audited');
 // The next tick mirrors the Hub schedule under the drift key, automations off, and the visit leaves the queue.
 clock+=120000;
 assert.deepEqual((await tick()).counts,counts({due:1,selected:1,synced:1}));
 await coherent('after the correction');
 assert.deepEqual([events.get('event-raced-pending').startTime,events.get('event-raced-pending').endTime,job('raced-pending').syncStatus],['2026-09-30T19:00:00.000Z','2026-09-30T21:00:00.000Z','synced'],'HighLevel is back on the Hub schedule');
 for(let i=0;i<3;i++){clock+=120000;assert.equal((await tick()).counts.selected,0,'and the visit leaves the queue');}
 assert.deepEqual(writes.map(w=>[w.id,w.startTime,w.toNotify]),[['event-raced-pending','2026-09-30T19:00:00.000Z',false],['event-raced-pending','2026-09-30T15:00:00.000Z',false],['event-raced-pending','2026-09-30T19:00:00.000Z',false]],'no write ever runs customer automations');
 const workerKeys=(await db.select().from(schema.appointmentOperations)).filter(o=>o.operationKey.endsWith(':mirror'));
 assert.ok(workerKeys.length===2&&workerKeys.every(o=>o.request.payload.toNotify===false),'the worker syncs with runAutomations false');
});

test('flag off: syncPortalSchedule never reads the appointment back after binding',async()=>{
 apiEnv={};
 seed(visit('quiet',{highlevelAppointmentId:'event-quiet'}));book('event-quiet',visit('quiet'),'2026-09-29T15:00:00.000Z','2026-09-29T17:00:00.000Z');
 let reads=0;const getAppointment=provider.getAppointment;provider.getAppointment=async id=>{reads++;return getAppointment(id);};
 assert.equal((await pageRetry('quiet')).providerSync,'verified');
 const flagOff=reads;reads=0;
 set('quiet',{time:'10:00',endTime:'12:00',syncStatus:'pending',syncIdempotencyKey:randomUUID()});
 apiEnv=FLAG_ON;
 assert.equal((await pageRetry('quiet')).providerSync,'verified');
 assert.equal(reads,flagOff+1,'the flag adds exactly the one read-back');
});
