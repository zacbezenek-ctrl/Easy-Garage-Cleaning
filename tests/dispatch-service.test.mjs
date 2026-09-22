import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dispatchOverview, mutateDispatch, mutateDispatchSelfAssignment, projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { denverToday, addDays, scheduleInterval, occupiedDays, availabilityInterval } from '../functions/_lib/dispatch-time.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { sharedScheduleResources, scheduleDayEntry, scheduleLockConflict } from '../functions/_lib/dispatch-conflicts.js';

const manager = {user:'zacb',displayName:'Owner',role:'owner',businessAccess:true};
const NOW = '2026-09-22T12:00:00.000Z';
function fixture() {
  const rows = new Map([
    ['customers/c1',{id:'c1',name:'Test Customer',phone:'+1 (970) 555-0100',address:'100 Test Street',revision:'c1r'}],
    ['customers/c2',{id:'c2',name:'Other Customer',phone:'+1 (970) 555-0111',address:'200 Test Street',revision:'c2r'}],
  ]);
  let revision = 0;
  const clone = value => structuredClone(value);
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([,value]) => clone(value));
  const roster = [{id:'zacb',name:'Owner',role:'owner'},{id:'crew1',name:'Crew One',role:'crew'},{id:'crew2',name:'Crew Two',role:'crew'},{id:'crew3',name:'Crew Three',role:'crew'}];
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(roster),
    read: async (collection,id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key),'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'),{code:'dispatch_revision_conflict',status:409});
      }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`,{...rows.get(`${write.collection}/${write.id}`),...clone(write.patch),id:write.id,revision:`r${++revision}`});
    },
  };
  const create = (changes = {}, extra = {}) => ({action:'schedule.create',requestId:randomUUID(),customerId:'c1',kind:'job',changes:{date:'2026-09-23',time:'08:00',endTime:'10:00',assignedCrew:['crew1'],jobInstructions:'Clean garage',...changes},...extra});
  const mutate = input => mutateDispatch(store,manager,input,NOW);
  const edit = (job,changes = {},action = 'schedule.update') => ({action,requestId:randomUUID(),jobId:job.id,expectedRevision:job.revision,changes});
  return {rows,store,roster,create,mutate,edit};
}

test('dispatch creates one canonical linked job and project, persists Denver UTC instants and receipt',async () => {
  const f = fixture(),input = f.create(),result = await f.mutate(input);
  assert.equal(result.job.startAt,'2026-09-23T14:00:00.000Z');
  assert.equal(result.job.endAt,'2026-09-23T16:00:00.000Z');
  assert.equal(result.job.customerId,'c1'); assert.equal(result.job.status,'scheduled');
  assert.deepEqual(result.job.assignedCrew,['crew1']);
  assert.equal(f.rows.get('jobs/'+result.job.id).createdBy,'zacb');
  assert.ok(f.rows.get('dispatchOperations/'+input.requestId));
  assert.equal(f.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries.length,1);
  assert.equal([...f.rows.values()].filter(row => row.authority === 'employee_hub').length,1);
});

test('parallel crews can overlap; shared employees and shared vehicles cannot',async () => {
  const f = fixture();
  const v = await f.mutate({action:'vehicle.save',requestId:randomUUID(),changes:{name:'Test Truck',status:'available'}});
  await f.mutate(f.create({vehicleId:v.resource.id}));
  await assert.rejects(f.mutate(f.create({time:'09:00',endTime:'11:00'},{customerId:'c2'})),error => error.code === 'dispatch_conflict' && error.details.conflicts[0].employeeIds.includes('crew1'));
  await assert.rejects(f.mutate(f.create({time:'09:00',endTime:'11:00',assignedCrew:['crew2'],vehicleId:v.resource.id},{customerId:'c2'})),error => error.code === 'dispatch_conflict');
  const separate = await f.mutate(f.create({time:'09:00',endTime:'11:00',assignedCrew:['crew2']},{customerId:'c2'}));
  assert.equal(separate.job.status,'scheduled');
});

test('concurrent claims cannot double-book and retries do not duplicate a job',async () => {
  const f = fixture(),input = f.create();
  const results = await Promise.all(Array.from({length:5},() => f.mutate(input)));
  assert.equal(new Set(results.map(result => result.job.id)).size,1);
  assert.equal([...f.rows.values()].filter(row => row.type === 'job').length,1);
  const g = fixture();
  const claims = await Promise.allSettled([g.mutate(g.create()),g.mutate(g.create({time:'09:00',endTime:'11:00'},{customerId:'c2'}))]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length,1);
});

test('unknown commit outcome replays receipt, while changed body and old operation are rejected',async () => {
  const f = fixture(),commit = f.store.commit;
  f.store.commit = async writes => {await commit(writes);throw new Error('Lost response');};
  const input = f.create(),result = await f.mutate(input);
  assert.equal((await f.mutate(input)).replayed,true);
  await assert.rejects(f.mutate({...input,changes:{...input.changes,title:'Other'}}),error => error.code === 'dispatch_idempotency_conflict');
  const changed = await f.mutate(f.edit(result.job,{time:'11:00',endTime:'13:00'}));
  assert.equal(changed.job.time,'11:00');
  await assert.rejects(f.mutate(input),error => error.code === 'dispatch_changed_since_operation');
});

test('rescheduling releases old locks and retains scope, money, photos and provider identity',async () => {
  const f = fixture(),result = await f.mutate(f.create());
  const raw = f.rows.get('jobs/'+result.job.id);
  raw.payment = {verified:true,amount:500};raw.estimate = {total:1000};raw.fieldExecution={photoReceipts:[{id:'photo'}]};raw.highlevelAppointmentId='provider';raw.highlevelContactId='contact';
  const changed = await f.mutate(f.edit(result.job,{date:'2026-09-24'}));
  const saved = f.rows.get('jobs/'+result.job.id);
  assert.equal(saved.payment.amount,500);assert.equal(saved.fieldExecution.photoReceipts.length,1);assert.equal(saved.highlevelAppointmentId,'provider');
  assert.equal(saved.date,'2026-09-24');assert.equal(saved.endDate,'2026-09-24');assert.equal(saved.syncStatus,'pending');assert.equal(changed.providerSync,'pending');
  assert.equal(f.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries.length,0);
  assert.equal(f.rows.get('jobs/_egc_schedule_lock_2026-09-24').entries.length,1);
  assert.equal(changed.job.payment,undefined);
});

test('assignments do not mark a verified provider mirror pending',async () => {
  const f=fixture(),result=await f.mutate(f.create()),raw=f.rows.get('jobs/'+result.job.id);
  raw.highlevelAppointmentId='provider';raw.highlevelContactId='contact';raw.syncStatus='synced';
  const changed=await f.mutate(f.edit(result.job,{assignedCrew:['crew2']}));
  assert.equal(changed.job.syncStatus,'synced');assert.equal(changed.providerSync,'not_needed');
});

test('cancel and explicit restore preserve identity, validate conflicts, and cannot complete work',async () => {
  const f=fixture(),a=await f.mutate(f.create());
  const cancelled=await f.mutate(f.edit(a.job,{},'schedule.cancel'));
  assert.equal(cancelled.job.status,'cancelled');
  await f.mutate(f.create({time:'09:00',endTime:'11:00'},{customerId:'c2'}));
  await assert.rejects(f.mutate(f.edit(cancelled.job,{},'schedule.restore')),error=>error.code==='dispatch_conflict');
  const restored=await f.mutate(f.edit(cancelled.job,{time:'12:00',endTime:'14:00'},'schedule.restore'));
  assert.equal(restored.job.status,'scheduled');assert.equal(restored.job.id,a.job.id);
  await assert.rejects(f.mutate(f.edit(restored.job,{status:'completed'})),error=>error.code==='dispatch_patch_not_allowed');
});

test('date logic respects midnight, multi-day assignments, DST gaps and repeated hours',async () => {
  assert.equal(denverToday(new Date('2026-09-23T05:59:59Z')),'2026-09-22');
  assert.equal(denverToday(new Date('2026-09-23T06:00:00Z')),'2026-09-23');
  assert.equal(addDays('2026-12-31',1),'2027-01-01');
  assert.equal(scheduleInterval({date:'2026-03-08',time:'02:15',endTime:'04:00'}),null);
  assert.equal(scheduleInterval({date:'2026-11-01',time:'01:15',endTime:'03:00'}),null);
  assert.equal(scheduleInterval({date:'2026-02-30',time:'08:00',endTime:'10:00'}),null);
  assert.deepEqual(occupiedDays({date:'2026-09-23',time:'08:00',endDate:'2026-09-25',endTime:'00:00'}),['2026-09-23','2026-09-24']);
  const f=fixture(),multi=await f.mutate(f.create({endDate:'2026-09-25',endTime:'10:00'}));
  assert.equal(occupiedDays(multi.job).length,3);
  await assert.rejects(f.mutate(f.create({date:'2026-09-24',time:'09:00',endTime:'11:00'},{customerId:'c2'})),error=>error.code==='dispatch_conflict');
  const overview=await dispatchOverview(f.store,manager,{startDate:'2026-09-24',endDate:'2026-09-25'});
  assert.equal(overview.jobs.length,1);
  assert.equal(availabilityInterval({date:'2026-03-08',allDay:true}).end-availabilityInterval({date:'2026-03-08',allDay:true}).start,23*3600000);
});

test('saved and legacy availability prevent assignments, and time off reveals affected jobs',async () => {
  const f=fixture();
  await f.mutate({action:'availability.save',requestId:randomUUID(),changes:{employeeId:'crew1',date:'2026-09-23',allDay:true,status:'active'}});
  await assert.rejects(f.mutate(f.create()),error=>error.code==='dispatch_conflict');
  const scheduled=await f.mutate(f.create({assignedCrew:['crew2']}));
  const off=await f.mutate({action:'availability.save',requestId:randomUUID(),changes:{employeeId:'crew2',date:'2026-09-23',allDay:true,status:'active'}});
  assert.equal(off.warnings[0].conflicts[0].jobId,scheduled.job.id);
  const g=fixture();g.rows.set('jobs/legacyoff',{id:'legacyoff',type:'availability',employee:'Crew One',date:'2026-09-23',allDay:true,status:'active'});
  await assert.rejects(g.mutate(g.create()),error=>error.code==='dispatch_conflict');
});

test('crew snapshots, lead validation, inactive employees, and out-of-service vehicles',async () => {
  const f=fixture(),crew=await f.mutate({action:'crew.save',requestId:randomUUID(),changes:{name:'North',memberIds:['crew1','crew2'],leadId:'crew1',status:'active'}});
  const input=f.create({crewId:crew.resource.id});delete input.changes.assignedCrew;
  const created=await f.mutate(input);
  assert.equal(created.job.crewId,crew.resource.id);
  assert.deepEqual(created.job.assignedCrew,['crew1','crew2']);assert.equal(created.job.crewLead,'crew1');
  await f.mutate({action:'crew.save',requestId:randomUUID(),id:crew.resource.id,expectedRevision:crew.resource.revision,changes:{memberIds:['crew2'],leadId:'crew2'}});
  assert.deepEqual(f.rows.get('jobs/'+created.job.id).assignedCrew,['crew1','crew2']);
  await assert.rejects(f.mutate(f.edit(created.job,{crewLead:'crew3'})),error=>error.code==='dispatch_lead_not_assigned');
  await assert.rejects(f.mutate(f.edit(created.job,{assignedCrew:['inactive']})),error=>error.code==='dispatch_employee_inactive');
  const truck=await f.mutate({action:'vehicle.save',requestId:randomUUID(),changes:{name:'Broken truck',status:'out_of_service'}});
  await assert.rejects(f.mutate(f.edit(created.job,{vehicleId:truck.resource.id})),error=>error.code==='dispatch_vehicle_unavailable');
});

test('customer search finds formatted phone numbers and unscheduled work remains visible',async () => {
  const f=fixture(),unscheduled=await f.mutate(f.create({date:'',time:'',endTime:''}));
  assert.equal(unscheduled.job.status,'unscheduled');
  const overview=await dispatchOverview(f.store,manager,{startDate:'2026-09-22',endDate:'2026-09-29',includeUnscheduled:true});
  assert.equal(overview.jobs.length,1);assert.ok(overview.warnings.some(warning=>warning.code==='unscheduled'));
  const customers=await dispatchOverview(f.store,manager,{view:'customers',q:'9705550100'});
  assert.equal(customers.customers[0].id,'c1');
});

test('server authorization, origin, JSON and private fields are enforced',async () => {
  const f=fixture();
  for (const actor of [null,{...manager,role:'crew'},{...manager,role:'sales'},{...manager,user:'not-business'},{...manager,businessAccess:false}]) {
    await assert.rejects(dispatchOverview(f.store,actor),error=>[401,403].includes(error.status));
    await assert.rejects(mutateDispatch(f.store,actor,f.create()),error=>[401,403].includes(error.status));
  }
  const handlers=dispatchHandlers({session:async()=>manager,storage:()=>f.store});
  const send=(body,origin='https://easygaragecleaning.com',contentType='application/json')=>handlers.post({request:new Request('https://easygaragecleaning.com/api/dispatch',{method:'POST',headers:{Origin:origin,'Content-Type':contentType},body}),env:{}});
  assert.equal((await send(JSON.stringify(f.create()),'https://attacker.invalid')).status,403);
  assert.equal((await send('{bad')).status,400);
  assert.equal((await send('{}','https://easygaragecleaning.com','text/plain')).status,415);
  const good=await send(JSON.stringify(f.create()));assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'no-store');
  const safe=projectDispatchJob({id:'test',type:'job',estimate:{total:1000},password:'secret',hourlyRate:100,assignedCrew:[]});
  assert.equal(safe.estimate,undefined);assert.equal(safe.password,undefined);assert.equal(safe.hourlyRate,undefined);
});

test('two different open shifts claimed concurrently cannot double-book the same employee',async () => {
  const f=fixture();
  const a=await f.mutate(f.create({assignedCrew:[],crewNeeded:2}));
  const b=await f.mutate(f.create({assignedCrew:[],crewNeeded:2,time:'09:00',endTime:'11:00'},{customerId:'c2'}));
  for (const job of [a.job,b.job]) Object.assign(f.rows.get('jobs/'+job.id),{openShift:true,shiftPickupEnabled:true,syncStatus:'synced'});
  const session={user:'crew1',role:'crew',businessAccess:false};
  const claims=await Promise.allSettled([a,b].map(result=>mutateDispatchSelfAssignment(f.store,session,{action:'claim',jobId:result.job.id,requestId:randomUUID()},NOW)));
  assert.equal(claims.filter(claim=>claim.status==='fulfilled').length,1);
  const assigned=[...f.rows.values()].filter(row=>row.type==='job' && row.assignedCrew.includes('crew1'));
  assert.equal(assigned.length,1);assert.equal(assigned[0].syncStatus,'synced');
});

test('open shift claim retries are idempotent and only self-claimed assignments can be released',async () => {
  const f=fixture(),created=await f.mutate(f.create({assignedCrew:['crew2'],crewNeeded:2}));
  Object.assign(f.rows.get('jobs/'+created.job.id),{openShift:true,shiftPickupEnabled:true});
  const employee={user:'crew1'},input={action:'claim',jobId:created.job.id,requestId:randomUUID()};
  const results=await Promise.all(Array.from({length:4},()=>mutateDispatchSelfAssignment(f.store,employee,input,NOW)));
  assert.equal(results.filter(result=>result.replayed).length,3);
  assert.deepEqual(results[0].job.assignedCrew,['crew2','crew1']);assert.equal(results[0].job.openShift,false);
  await assert.rejects(mutateDispatchSelfAssignment(f.store,{user:'crew2'},{action:'release',jobId:created.job.id,requestId:randomUUID()},NOW),error=>error.code==='dispatch_shift_release_forbidden');
  const released=await mutateDispatchSelfAssignment(f.store,employee,{action:'release',jobId:created.job.id,requestId:randomUUID()},NOW);
  assert.deepEqual(released.job.assignedCrew,['crew2']);assert.equal(released.job.openShift,true);
});

test('self-assignment observes multi-day unavailable time and cannot race manager assignment',async () => {
  const f=fixture(),created=await f.mutate(f.create({assignedCrew:[],endDate:'2026-09-25',crewNeeded:2}));
  Object.assign(f.rows.get('jobs/'+created.job.id),{openShift:true,shiftPickupEnabled:true});
  await f.mutate({action:'availability.save',requestId:randomUUID(),changes:{employeeId:'crew1',date:'2026-09-24',allDay:true}});
  await assert.rejects(mutateDispatchSelfAssignment(f.store,{user:'crew1'},{action:'claim',jobId:created.job.id,requestId:randomUUID()},NOW),error=>error.code==='dispatch_conflict');
  const g=fixture(),open=await g.mutate(g.create({assignedCrew:[],crewNeeded:2}));
  Object.assign(g.rows.get('jobs/'+open.job.id),{openShift:true,shiftPickupEnabled:true});
  const races=await Promise.allSettled([mutateDispatchSelfAssignment(g.store,{user:'crew1'},{action:'claim',jobId:open.job.id,requestId:randomUUID()},NOW),g.mutate(g.create({time:'09:00',endTime:'11:00'},{customerId:'c2'}))]);
  assert.equal(races.filter(result=>result.status==='fulfilled').length,1);
});

test('a malformed dated assignment cannot silently advertise its crew as available',async () => {
  const f=fixture();
  f.rows.set('jobs/bad-time',{id:'bad-time',type:'job',date:'2026-09-23',time:'08:00',endTime:'',assignedCrew:['crew1'],status:'scheduled'});
  await assert.rejects(f.mutate(f.create()),error=>error.code==='dispatch_conflict' && error.details.conflicts.some(conflict=>conflict.code==='unverifiable_assignment'));
  const otherDay=await f.mutate(f.create({date:'2026-09-24'}));assert.equal(otherDay.ok,true);
});

test('canonical usernames containing punctuation remain valid leads and explicit object IDs never become display aliases',async () => {
  const f=fixture();f.roster.push({id:'new.user',name:'Dot User',role:'crew'});
  const job=await f.mutate(f.create({assignedCrew:['new.user'],crewLead:'new.user'}));
  assert.equal(job.job.crewLead,'new.user');
  f.rows.set('jobs/explicit',{id:'explicit',type:'job',date:'2026-09-24',time:'08:00',endTime:'10:00',assignedCrew:[{id:'Crew One',name:'Someone'}],status:'scheduled'});
  const scheduled=await f.mutate(f.create({date:'2026-09-24'}));assert.equal(scheduled.ok,true);
});

test('dispatch reflects field delays and retains completion follow-up without stale activities',async()=>{
  const f=fixture(),created=await f.mutate(f.create()),job=f.rows.get('jobs/'+created.job.id);
  Object.assign(job,{status:'in_progress',pipelineStatus:'in_progress',fieldExecution:{activity:'delayed',activityReason:'Replacement tool needed',attention:{status:'open',reason:'Customer requested return visit',actorName:'Crew One',at:NOW}}});
  let overview=await dispatchOverview(f.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'});
  assert.equal(overview.jobs[0].activity,'delayed');assert.ok(overview.warnings.some(warning=>warning.code==='job_delayed'));
  Object.assign(job,{status:'completed',pipelineStatus:'completed'});
  overview=await dispatchOverview(f.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'});
  assert.equal(overview.jobs[0].activity,'completed');assert.ok(!overview.warnings.some(warning=>warning.code==='job_delayed'));assert.ok(overview.warnings.some(warning=>warning.code==='needs_follow_up'));
});

test('an undated job for a CRM-linked customer does not enqueue an invalid appointment sync',async()=>{
  const f=fixture();f.rows.get('customers/c1').highlevelContactId='contact';
  const created=await f.mutate(f.create({date:'',time:'',endTime:''}));
  assert.equal(created.job.syncStatus,'not_needed');assert.equal(created.providerSync,'not_needed');
  const scheduled=await f.mutate(f.edit(created.job,{date:'2026-09-23',time:'08:00',endTime:'10:00'}));
  assert.equal(scheduled.job.syncStatus,'pending');assert.equal(scheduled.providerSync,'pending');
});

test('walkthrough handoff preserves authoritative project and scope while refusing duplicate or crossed contact links',async()=>{
  const f=fixture();f.rows.get('customers/c1').highlevelContactId='contact-one';
  f.rows.set('jobs/source',{id:'source',type:'walkthrough',customerId:'c1',highlevelContactId:'wrong-contact',projectId:'project-source',jobInstructions:'Approved scope',estimate:{total:500},revision:'source-r1'});
  f.rows.set('projects/project-source',{id:'project-source',customerId:'c1',sourceRecordId:'source',revision:'project-r1'});
  await assert.rejects(f.mutate(f.create({}, {sourceWalkthroughId:'source'})),error=>error.code==='dispatch_contact_link_conflict');
  f.rows.get('jobs/source').highlevelContactId='contact-one';
  const input=f.create({}, {sourceWalkthroughId:'source'});delete input.changes.jobInstructions;
  const created=await f.mutate(input),saved=f.rows.get('jobs/'+created.job.id);
  assert.equal(saved.projectId,'project-source');assert.equal(saved.jobInstructions,'Approved scope');assert.equal(saved.estimate.total,500);
  await assert.rejects(f.mutate(f.create({date:'2026-09-24'}, {sourceWalkthroughId:'source'})),error=>error.code==='dispatch_handoff_exists');
  f.rows.get('customers/c1').highlevelContactId='wrong-new-contact';
  await assert.rejects(f.mutate(f.edit(created.job,{time:'12:00',endTime:'14:00'})),error=>error.code==='dispatch_contact_link_conflict');
});

test('legacy schedule sender committing after the first scan cannot slip past shared day locks',async()=>{
  const f=fixture(),read=f.store.read;let injected=false;
  f.store.day=async date=>(await f.store.jobs()).filter(job=>job.date===date);
  f.store.read=async(collection,id)=>{
    if(collection==='jobs'&&id==='_egc_schedule_lock_2026-09-23'&&!injected){
      injected=true;
      await mutateScheduledVisit(f.store,{id:'legacy-sender',kind:'integration',role:'integration'},{requestId:randomUUID(),mode:'create',portalCustomerId:'c2',kind:'job',changes:{date:'2026-09-23',time:'09:00',endTime:'11:00',assignedTo:'crew1'}},NOW);
    }
    return read(collection,id);
  };
  await assert.rejects(f.mutate(f.create()),error=>error.code==='dispatch_conflict');
  assert.equal([...f.rows.values()].filter(job=>job.type==='job').length,1);
});

test('malformed scheduling locks are preserved for review rather than overwritten',async()=>{
  const f=fixture();f.rows.set('jobs/_egc_schedule_lock_2026-09-23',{id:'_egc_schedule_lock_2026-09-23',recordType:'schedule_lock',entries:'malformed',revision:'bad-lock'});
  await assert.rejects(f.mutate(f.create()),error=>error.code==='dispatch_lock_unavailable');
  assert.equal(f.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries,'malformed');
});

test('dispatch scope edits preserve structured legacy instructions and replace the canonical staff scope',async()=>{
  const f=fixture(),created=await f.mutate(f.create()),job=f.rows.get('jobs/'+created.job.id);
  job.jobInstructions={operationalScope:'Older scope',customerGoal:'Keep heirloom cabinet',hazards:['Low ceiling'],keepItems:['Cabinet']};
  job.operationalScope={text:'Previously approved staff scope',updatedBy:'other-manager'};
  let overview=await dispatchOverview(f.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'});
  assert.equal(overview.jobs[0].jobInstructions,'Previously approved staff scope');
  const saved=await f.mutate(f.edit(created.job,{jobInstructions:'Install shelves and organize tools'}));
  assert.equal(saved.job.jobInstructions,'Install shelves and organize tools');
  assert.equal(f.rows.get('jobs/'+job.id).jobInstructions.customerGoal,'Keep heirloom cabinet');
  assert.deepEqual(f.rows.get('jobs/'+job.id).jobInstructions.hazards,['Low ceiling']);
  assert.equal(f.rows.get('jobs/'+job.id).operationalScope.approvalKind,'staff_operational_instructions');
  await f.mutate(f.edit(saved.job,{jobInstructions:''}));
  overview=await dispatchOverview(f.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'});
  assert.equal(overview.jobs[0].jobInstructions,'');assert.ok(overview.warnings.some(warning=>warning.code==='missing_scope'));
});

test('legacy scheduling metadata remains bounded and pickup capacity follows assignments and lifecycle',async()=>{
  const f=fixture(),created=await f.mutate(f.create({assignedCrew:[],crewNeeded:1,shiftPickupEnabled:true,recurrence:'monthly',reminderDays:7,notify:false,notes:'Gate code on arrival'}));
  assert.equal(created.job.openShift,true);assert.equal(created.job.recurrence,'monthly');assert.equal(created.job.notify,false);
  const claimed=await mutateDispatchSelfAssignment(f.store,{user:'crew1'},{action:'claim',jobId:created.job.id,requestId:randomUUID()},NOW);
  assert.equal(claimed.job.openShift,false);
  const removed=await f.mutate(f.edit(claimed.job,{assignedCrew:[]}));
  assert.equal(removed.job.openShift,true);assert.deepEqual(f.rows.get('jobs/'+created.job.id).shiftClaims,[]);assert.equal(f.rows.get('jobs/'+created.job.id).lastShiftClaim,null);
  const reassigned=await f.mutate(f.edit(removed.job,{assignedCrew:['crew1']}));
  await assert.rejects(mutateDispatchSelfAssignment(f.store,{user:'crew1'},{action:'release',jobId:created.job.id,requestId:randomUUID()},NOW),e=>e.code==='dispatch_shift_release_forbidden');
  for (const changes of [{recurrence:'daily'},{reminderDays:0},{reminderDays:31},{notify:'true'},{shiftPickupEnabled:1},{openShift:true}]) await assert.rejects(f.mutate(f.edit(reassigned.job,changes)));
  const cancelled=await f.mutate({...f.edit(reassigned.job,{},'schedule.cancel'),cancellationReason:'Customer postponed'});
  assert.equal(cancelled.job.openShift,false);
  const raw=f.rows.get('jobs/'+cancelled.job.id);assert.equal(raw.cancellationReason,'Customer postponed');assert.equal(raw.cancelledBy,'zacb');assert.equal(raw.cancelledAt,NOW);
  const receipt=f.rows.get('dispatchOperations/'+cancelled.requestId);assert.equal(receipt.after.cancellationReason,'Customer postponed');
});

test('recurring clone keeps operational requirements but cannot carry accepted price, photos or completed work',async()=>{
  const f=fixture(),source=await f.mutate(f.create({recurrence:'monthly',materials:[{id:'shelf',name:'Shelf',quantity:2}],requiredEquipment:['Drill'],notes:'Use driveway'}));
  const raw=f.rows.get('jobs/'+source.job.id);
  Object.assign(raw,{status:'completed',pipelineStatus:'completed',completedAt:NOW,sourceWalkthroughId:'old-walkthrough',highlevelAppointmentId:'old-appointment',payment:{amount:500},estimate:{total:1000},acceptance:{accepted:true},fieldExecution:{photos:['old-photo']},photos:['old-photo'],jobInstructions:{customerGoal:'Storage access',hazards:['low beam'],photos:['hidden-photo'],price:1000},fieldCompletionSync:{status:'synced'},materials:[{id:'shelf',name:'Shelf',quantity:2,price:400}]});
  const cloned=await f.mutate(f.create({date:'2026-10-23',assignedCrew:[]},{sourceTemplateJobId:source.job.id})),saved=f.rows.get('jobs/'+cloned.job.id);
  assert.equal(saved.sourceTemplateJobId,source.job.id);assert.equal(saved.recurrenceParentId,source.job.id);assert.equal(saved.sourceTemplateRevision,raw.revision);
  assert.notEqual(saved.projectId,raw.projectId);assert.equal(saved.recurrence,'monthly');assert.equal(saved.notes,'Use driveway');assert.equal(saved.jobInstructions.customerGoal,'Storage access');assert.deepEqual(saved.jobInstructions.hazards,['low beam']);
  assert.deepEqual(saved.materials,[{id:'shelf',name:'Shelf',quantity:2}]);assert.deepEqual(saved.assignedCrew,[]);assert.equal(saved.openShift,false);
  for (const key of ['payment','estimate','acceptance','fieldExecution','photos','fieldCompletionSync','highlevelAppointmentId','completedAt','sourceWalkthroughId']) assert.equal(saved[key],undefined,key);
  assert.equal(saved.jobInstructions.photos,undefined);assert.equal(saved.jobInstructions.price,undefined);
  await assert.rejects(f.mutate(f.create({date:'2026-11-23'},{customerId:'c2',sourceTemplateJobId:source.job.id})),e=>e.code==='dispatch_template_invalid');
  await assert.rejects(f.mutate(f.create({date:'2026-11-23'},{sourceTemplateJobId:source.job.id,sourceWalkthroughId:'both'})),e=>e.code==='dispatch_handoff_invalid');
});

test('global blocks use the canonical atomic schedule and keep customer jobs and crews out',async()=>{
  const f=fixture(),input={action:'schedule.create',requestId:randomUUID(),kind:'blocked',changes:{date:'2026-09-23',time:'08:00',endDate:'2026-09-24',endTime:'10:00',title:'Company training'}};
  const block=await f.mutate(input);assert.equal(block.job.type,'blocked');assert.equal(block.providerSync,'not_needed');
  assert.equal([...f.rows.keys()].filter(key=>key.startsWith('projects/')).length,0);
  const overview=await dispatchOverview(f.store,manager,{startDate:'2026-09-23',endDate:'2026-09-25'});assert.equal(overview.jobs[0].title,'Company training');assert.deepEqual(overview.warnings,[]);
  assert.equal(f.rows.get('jobs/_egc_schedule_lock_2026-09-24').entries[0].type,'blocked');
  await assert.rejects(f.mutate(f.create({date:'2026-09-24',assignedCrew:['crew2']})),e=>e.code==='dispatch_conflict');
  await assert.rejects(f.mutate(f.edit(block.job,{assignedCrew:['crew1']})),e=>e.code==='dispatch_patch_not_allowed');
  const cancelled=await f.mutate(f.edit(block.job,{},'schedule.cancel'));await f.mutate(f.create());
  await assert.rejects(f.mutate(f.edit(cancelled.job,{},'schedule.restore')),e=>e.code==='dispatch_conflict');
  await assert.rejects(f.mutate({...input,requestId:randomUUID(),customerId:'c1'}),e=>e.code==='dispatch_block_invalid');
});

test('explicit native empty crew does not become a global block while missing legacy assignments stay conservative',()=>{
  const next={id:'next',type:'job',date:'2026-09-23',time:'08:00',endTime:'10:00',assignedCrew:['crew1']};
  const native={id:'native',type:'job',date:'2026-09-23',time:'08:00',endTime:'10:00',assignedCrew:[]};
  const legacy={id:'legacy',type:'job',date:'2026-09-23',time:'08:00',endTime:'10:00'};
  assert.equal(sharedScheduleResources(next,native),false);assert.equal(sharedScheduleResources(next,legacy),true);
  assert.equal(scheduleLockConflict(next,scheduleDayEntry(native,native.date),native.date),false);
  assert.equal(scheduleLockConflict(next,scheduleDayEntry(legacy,legacy.date),legacy.date),true);
  assert.equal(sharedScheduleResources({...next,vehicleId:'truck'},{...native,assignedCrew:['crew2'],vehicleId:'truck'}),true);
});

test('exact dispatch lookup survives date changes and completion handoff remains visible without exposing body or provider IDs',async()=>{
  const f=fixture(),created=await f.mutate(f.create()),raw=f.rows.get('jobs/'+created.job.id);
  Object.assign(raw,{date:'2027-01-01',endDate:'2027-01-01',status:'completed',pipelineStatus:'completed',durationMin:60,estimatedDurationMin:90,fieldCompletionSync:{status:'error',message:'Retry CRM handoff',attemptedAt:NOW,body:'PRIVATE',providerContactId:'PRIVATE'}});
  const result=await dispatchOverview(f.store,manager,{view:'job',jobId:created.job.id});
  assert.equal(result.job.date,'2027-01-01');assert.equal(result.job.durationMin,60);assert.equal(result.job.estimatedDurationMin,90);
  assert.deepEqual(result.job.completionSync,{status:'error',message:'Retry CRM handoff',attemptedAt:NOW,syncedAt:null});
  assert.ok(result.warnings.some(w=>w.code==='completion_sync_error'));
  raw.fieldCompletionSync.status='pending';assert.ok((await dispatchOverview(f.store,manager,{view:'job',jobId:created.job.id})).warnings.some(w=>w.code==='completion_sync_pending'));
  await assert.rejects(dispatchOverview(f.store,{user:'crew1',role:'crew'},{view:'job',jobId:created.job.id}),e=>e.status===403);
  await assert.rejects(dispatchOverview(f.store,manager,{view:'job',jobId:'secure_account'}),e=>e.status===404);
});
