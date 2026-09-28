import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// Imported first on purpose: dispatch-segments and dispatch-conflicts import
// each other, and this order must evaluate as safely as the reverse.
import { SEGMENT_LIMIT, jobSegments, segmentDays, segmentLockEntries, lockEntryOwner, ownsLockEntry, segmentsEnabled, validateSegments } from '../functions/_lib/dispatch-segments.js';
import { scheduleDayEntry, scheduleRowsConflict, scheduleLockConflict, sharedScheduleResources } from '../functions/_lib/dispatch-conflicts.js';
import { occupiedDays } from '../functions/_lib/dispatch-time.js';
import { dispatchOverview, mutateDispatch, mutateDispatchSelfAssignment, projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchOpenings } from '../functions/_lib/dispatch-openings.js';
import { mutateCrewAvailability } from '../functions/_lib/crew-availability.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { dispatchTravelRoutes } from '../functions/_lib/dispatch-travel.js';
import { mutateRecurringPlan } from '../functions/_lib/recurring-plan-service.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { fieldJobProjection, fieldViewerWorksOn } from '../functions/_lib/field-execution.js';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';
import { crewJobsHandlers, CREW_LISTING_FIELDS } from '../functions/api/crew-jobs.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import * as fieldJobs from '../functions/api/field-jobs.js';
import { storage as fieldStorage } from './helpers/field-fixture.mjs';

const manager = {user:'zacb',displayName:'Owner',role:'owner',businessAccess:true};
const NOW = '2026-09-22T12:00:00.000Z', D1 = '2026-09-23', D2 = '2026-09-24', D3 = '2026-09-25';
const ROSTER = [{id:'zacb',name:'Owner',role:'owner'},{id:'crew1',name:'Crew One',role:'crew'},{id:'crew2',name:'Crew Two',role:'crew'},{id:'crew3',name:'Crew Three',role:'crew'},{id:'crew4',name:'Crew Four',role:'crew'}];
const seg = (id,date,time,endTime,extra={}) => ({id,date,time,endTime,assignedCrew:['crew1'],...extra});

function fixture({segments=true}={}) {
  const rows = new Map([
    ['customers/c1',{id:'c1',name:'Synthetic Customer',phone:'970-555-0100',address:'100 Synthetic Street, Fort Collins, CO 80525',revision:'c1r'}],
    ['customers/c2',{id:'c2',name:'Synthetic Other',phone:'970-555-0111',address:'200 Synthetic Street, Fort Collins, CO 80525',revision:'c2r'}],
    ...['truck1','truck2','truck3'].map(id => [`dispatchResources/${id}`,{id,recordType:'vehicle',name:`Synthetic ${id}`,status:'available',revision:`${id}r`}]),
    ['dispatchResources/truck4',{id:'truck4',recordType:'vehicle',name:'Synthetic broken truck',status:'out_of_service',revision:'truck4r'}],
    ['dispatchResources/north',{id:'north',recordType:'crew',name:'North',memberIds:['crew1','crew3'],leadId:'crew1',status:'active',revision:'northr'}],
  ]);
  let revision = 0;
  const clone = value => structuredClone(value);
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([,value]) => clone(value));
  const store = {
    segmentsEnabled: segments,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(ROSTER),
    day: async date => all('jobs').filter(job => job.date === date),
    read: async (collection,id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key),'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'),{code:'dispatch_revision_conflict',status:409});
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`,{...rows.get(`${write.collection}/${write.id}`),...clone(write.patch),id:write.id,revision:`r${++revision}`});
    },
  };
  const create = (changes = {}, extra = {}) => ({action:'schedule.create',requestId:randomUUID(),customerId:'c1',kind:'job',changes:{date:D1,time:'08:00',endTime:'10:00',assignedCrew:['crew1'],jobInstructions:'Synthetic garage scope',...changes},...extra});
  const split = (assignmentSegments, changes = {}, extra = {}) => ({action:'schedule.create',requestId:randomUUID(),customerId:'c1',kind:'job',changes:{jobInstructions:'Synthetic garage scope',assignmentSegments,...changes},...extra});
  const edit = (job,changes = {},action = 'schedule.update') => ({action,requestId:randomUUID(),jobId:job.id,expectedRevision:job.revision,changes});
  const mutate = input => mutateDispatch(store,manager,input,NOW);
  const lock = date => rows.get(`jobs/_egc_schedule_lock_${date}`)?.entries || [];
  const openings = query => dispatchOpenings(store,manager,{durationMinutes:'60',travelBufferMinutes:'0',...query},new Date(NOW));
  return {rows,store,create,split,edit,mutate,lock,openings};
}
const ids = entries => entries.map(entry => entry.id).sort();

test('a legacy job is exactly one implicit segment: same object, days and single lock entry', () => {
  const job = {id:'legacy',type:'job',date:D1,time:'08:00',endDate:D3,endTime:'17:00',assignedCrew:['crew1'],status:'scheduled'};
  assert.equal(jobSegments(job).length,1); assert.equal(jobSegments(job)[0],job,'the implicit segment is the job itself');
  for (const assignmentSegments of [undefined,null,[]]) assert.equal(jobSegments({...job,assignmentSegments}).length,1);
  assert.deepEqual(segmentDays(job),occupiedDays(job));
  assert.deepEqual(segmentLockEntries(job,D2,ROSTER,NOW),[scheduleDayEntry(job,D2,ROSTER,NOW)]);
  assert.equal(lockEntryOwner({id:'job-1~a'}),'job-1'); assert.equal(lockEntryOwner({id:'job-1'}),'job-1');
  assert.ok(ownsLockEntry({id:'job-1~a'},'job-1')); assert.ok(!ownsLockEntry({id:'job-10~a'},'job-1')); assert.ok(!ownsLockEntry({id:'job-1a'},'job-1'));
  // A malformed saved segment cannot prove free capacity: the hull and union stay reserved.
  const broken = {...job,assignmentSegments:[{id:'a',date:D1,time:'08:00',endTime:'09:00',assignedCrew:'crew1'}]};
  assert.deepEqual(jobSegments(broken).map(row => [row.date,row.endDate,row.segmentId]),[[D1,D3,null]]);
  for (const assignmentSegments of [[{id:'bad id',date:D1,time:'08:00',endTime:'09:00',assignedCrew:[]}],[seg('a',D1,'08:00','09:00'),seg('a',D2,'08:00','09:00')]]) {
    assert.deepEqual(segmentLockEntries({...job,assignmentSegments},D2,ROSTER,NOW).map(entry => [entry.id,entry.start,entry.end]),[[job.id,'00:00','24:00']],'an unverifiable split keeps one conservative hull entry');
  }
  const other = {id:'other',type:'job',date:D2,time:'10:00',endTime:'11:00',assignedCrew:['crew1'],status:'scheduled'};
  assert.equal(scheduleRowsConflict(other,broken,ROSTER),true);
  assert.equal(segmentsEnabled({}),false); assert.equal(segmentsEnabled({EGC_DISPATCH_SEGMENTS:' TRUE '}),true); assert.equal(segmentsEnabled({EGC_DISPATCH_SEGMENTS:'1'}),false);
});

test('with EGC_DISPATCH_SEGMENTS off the field is rejected, and nothing is written', async () => {
  const f = fixture({segments:false});
  await assert.rejects(f.mutate(f.split([seg('a',D1,'08:00','12:00')])),error => error.code === 'dispatch_segments_disabled' && error.status === 400);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('jobs/')).length,0);
  const legacy = await f.mutate(f.create());
  for (const assignmentSegments of [[seg('a',D1,'08:00','12:00')],[]]) await assert.rejects(f.mutate(f.edit(legacy.job,{assignmentSegments})),error => error.code === 'dispatch_segments_disabled');
  assert.equal(f.rows.get('jobs/'+legacy.job.id).assignmentSegments,undefined);
  // A storage-less legacy fixture (no flag property) is also off.
  const g = fixture(); delete g.store.segmentsEnabled;
  await assert.rejects(g.mutate(g.split([seg('a',D1,'08:00','12:00')])),error => error.code === 'dispatch_segments_disabled');
  // The HTTP boundary returns the same 400 and the storage adapter reads the env flag.
  const handlers = dispatchHandlers({session:async()=>manager,storage:()=>f.store,now:()=>new Date(NOW)});
  const response = await handlers.post({request:new Request('https://easygaragecleaning.com/api/dispatch',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify(f.split([seg('a',D1,'08:00','12:00')]))}),env:{}});
  assert.equal(response.status,400); assert.equal((await response.json()).code,'dispatch_segments_disabled');
  const read = await handlers.get({request:new Request(`https://easygaragecleaning.com/api/dispatch?startDate=${D1}&endDate=${D2}`),env:{}});
  assert.deepEqual((await read.json()).segments,{enabled:false,max:SEGMENT_LIMIT});
  const fetcher = async () => Response.json({documents:[]});
  assert.equal(dispatchStorage({EGC_DISPATCH_SEGMENTS:'true'},fetcher).segmentsEnabled,true);
  assert.equal(dispatchStorage({},fetcher).segmentsEnabled,false);
});

test('two crews work one job at the same time with different vehicles; shared people or trucks conflict', async () => {
  const f = fixture();
  const created = await f.mutate(f.split([seg('a',D1,'08:00','12:00',{assignedCrew:['crew1','crew3'],crewLead:'crew1',vehicleId:'truck1'}),seg('b',D1,'08:00','12:00',{assignedCrew:['crew2'],vehicleId:'truck2',notes:'Synthetic back bay'})]));
  const job = created.job, raw = f.rows.get('jobs/'+job.id);
  assert.deepEqual([job.date,job.time,job.endDate,job.endTime,job.startAt,job.endAt],[D1,'08:00',D1,'12:00','2026-09-23T14:00:00.000Z','2026-09-23T18:00:00.000Z']);
  assert.deepEqual(raw.assignedCrew,['crew1','crew3','crew2']); assert.equal(raw.assignedTo,'crew1, crew3, crew2');
  assert.equal(raw.crewLead,'crew1'); assert.equal(raw.vehicleId,null,'mixed vehicles leave no job-level vehicle'); assert.equal(raw.openShift,false);
  assert.deepEqual(job.assignmentSegments.map(row => [row.id,row.vehicleId,row.assignedCrew.join('+')]),[['a','truck1','crew1+crew3'],['b','truck2','crew2']]);
  assert.deepEqual(ids(f.lock(D1)),[`${job.id}~a`,`${job.id}~b`]);
  assert.deepEqual(f.lock(D1).map(entry => [entry.jobId,entry.segmentId,entry.vehicleId,entry.start,entry.end]),[[job.id,'a','truck1','08:00','12:00'],[job.id,'b','truck2','08:00','12:00']]);
  await assert.rejects(f.mutate(f.create({time:'10:00',endTime:'11:00',assignedCrew:['crew2']},{customerId:'c2'})),error => error.code === 'dispatch_conflict' && error.details.conflicts.some(row => row.otherJobId === job.id && row.otherSegmentId === 'b' && row.employeeIds.includes('crew2')));
  await assert.rejects(f.mutate(f.create({time:'10:00',endTime:'11:00',assignedCrew:['crew4'],vehicleId:'truck1'},{customerId:'c2'})),error => error.code === 'dispatch_conflict' && error.details.conflicts.some(row => row.otherSegmentId === 'a' && row.vehicleId === 'truck1'));
  const parallel = await f.mutate(f.create({time:'10:00',endTime:'11:00',assignedCrew:['crew4'],vehicleId:'truck3'},{customerId:'c2'}));
  assert.equal(parallel.job.status,'scheduled');
  // Inside one job, the same person or truck cannot be in two places at once.
  for (const clash of [{assignedCrew:['crew1']},{assignedCrew:['crew4'],vehicleId:'truck1'}]) {
    await assert.rejects(f.mutate(f.split([seg('a',D2,'08:00','12:00',{vehicleId:'truck1'}),seg('b',D2,'11:00','13:00',clash)],{},{customerId:'c2'})),error => error.code === 'dispatch_conflict' && error.status === 409 && error.details.conflicts[0].code === 'segment_overlap');
  }
  // The job's 20-minute travel buffer pads each segment.
  assert.deepEqual((await f.openings({startDate:D1,endDate:D2,employeeIds:'crew2'})).candidates[0].time,'12:20');
  assert.deepEqual((await f.openings({startDate:D1,endDate:D2,employeeIds:'crew3',vehicleId:'truck2'})).candidates[0].time,'12:20');
  const overview = await dispatchOverview(f.store,manager,{startDate:D1,endDate:D2},new Date(NOW));
  assert.deepEqual(overview.segments,{enabled:true,max:SEGMENT_LIMIT});
  assert.equal(overview.jobs.find(row => row.id === job.id).assignmentSegments.length,2);
  assert.equal(projectDispatchJob({...raw,estimate:{total:1000}}).estimate,undefined);
});

test('a 3-day job with 08:00-17:00 daily windows frees each night; the same hull as one span does not', async () => {
  const f = fixture(), days = [D1,D2,D3];
  const created = await f.mutate(f.split(days.map((date,index) => seg(`d${index+1}`,date,'08:00','17:00'))));
  const job = created.job;
  assert.deepEqual([job.date,job.time,job.endDate,job.endTime],[D1,'08:00',D3,'17:00']);
  for (const [index,date] of days.entries()) assert.deepEqual(f.lock(date).map(entry => [entry.id,entry.start,entry.end]),[[`${job.id}~d${index+1}`,'08:00','17:00']]);
  const night = await f.openings({startDate:D2,endDate:D3,employeeIds:'crew1',workdayStart:'17:00',workdayEnd:'24:00',durationMinutes:'120'});
  assert.deepEqual([night.candidates[0].time,night.candidates[0].gapMinutes],['17:20',400],'the night after the 17:00 window plus its travel buffer is free');
  const evening = await f.mutate(f.create({date:D1,time:'18:00',endTime:'21:00',assignedCrew:['crew1']},{customerId:'c2'}));
  assert.equal(evening.job.status,'scheduled');
  const overnight = await mutateCrewAvailability(f.store,{user:'crew1',displayName:'Crew One',role:'crew'},{action:'create',requestId:randomUUID(),changes:{date:D2,endDate:D3,allDay:false,time:'19:00',endTime:'06:00',reason:'Synthetic appointment'}},NOW);
  assert.equal(overnight.record.status,'active');
  // Daytime time off inside a segment still conflicts, per segment.
  await assert.rejects(mutateCrewAvailability(f.store,{user:'crew1'},{action:'create',requestId:randomUUID(),changes:{date:D3,allDay:false,time:'12:00',endTime:'13:00'}},NOW),error => error.code === 'crew_availability_assignment_conflict' && error.details.conflicts.some(row => row.jobId === job.id && row.segmentId === 'd3'));

  const g = fixture(), span = await g.mutate(g.create({date:D1,time:'08:00',endDate:D3,endTime:'17:00'}));
  assert.equal(g.lock(D2)[0].id,span.job.id);
  assert.deepEqual((await g.openings({startDate:D2,endDate:D3,employeeIds:'crew1',workdayStart:'17:00',workdayEnd:'24:00',durationMinutes:'120'})).candidates,[]);
  await assert.rejects(g.mutate(g.create({date:D1,time:'18:00',endTime:'21:00'},{customerId:'c2'})),error => error.code === 'dispatch_conflict');
  await assert.rejects(mutateCrewAvailability(g.store,{user:'crew1'},{action:'create',requestId:randomUUID(),changes:{date:D2,endDate:D3,allDay:false,time:'19:00',endTime:'06:00'}},NOW),error => error.code === 'crew_availability_assignment_conflict');
});

test('split crew by day reserves each employee only on their own day, and a skipped day stays free', async () => {
  const f = fixture();
  const created = await f.mutate(f.split([seg('first',D1,'08:00','17:00',{assignedCrew:['crew1']}),seg('second',D2,'08:00','17:00',{assignedCrew:['crew2'],vehicleId:'truck1'})]));
  const job = created.job, raw = f.rows.get('jobs/'+job.id);
  assert.deepEqual([raw.date,raw.endDate,raw.assignedCrew],[D1,D2,['crew1','crew2']]);
  assert.deepEqual(f.lock(D1).map(entry => [entry.id,entry.assignedCrew]),[[`${job.id}~first`,['crew1']]]);
  assert.deepEqual(f.lock(D2).map(entry => [entry.id,entry.assignedCrew,entry.vehicleId]),[[`${job.id}~second`,['crew2'],'truck1']]);
  assert.equal((await f.mutate(f.create({date:D1,time:'09:00',endTime:'11:00',assignedCrew:['crew2']},{customerId:'c2'}))).job.status,'scheduled');
  assert.equal((await f.mutate(f.create({date:D2,time:'09:00',endTime:'11:00',assignedCrew:['crew1']},{customerId:'c2'}))).job.status,'scheduled');
  await assert.rejects(f.mutate(f.create({date:D1,time:'12:00',endTime:'13:00',assignedCrew:['crew1']},{customerId:'c2'})),error => error.code === 'dispatch_conflict');
  const routes = await dispatchTravelRoutes(f.store,manager,{date:D2},new Date(NOW));
  const stops = id => routes.employees.find(row => row.employeeId === id)?.jobs.filter(stop => stop.id === job.id) || [];
  assert.deepEqual(stops('crew2').map(stop => [stop.time,stop.endTime]),[['08:00','17:00']]);
  assert.deepEqual(stops('crew1'),[]);

  const g = fixture();
  const gap = await g.mutate(g.split([seg('mon',D1,'08:00','17:00'),seg('wed',D3,'08:00','17:00')]));
  assert.deepEqual(segmentDays(g.rows.get('jobs/'+gap.job.id)),[D1,D3]);
  assert.deepEqual(g.lock(D2),[]);
  assert.equal((await g.openings({startDate:D2,endDate:D3,employeeIds:'crew1',workdayStart:'08:00',workdayEnd:'17:00'})).candidates[0].gapMinutes,540);
  assert.equal((await g.mutate(g.create({date:D2,time:'08:00',endTime:'17:00'},{customerId:'c2'}))).job.status,'scheduled');
});

test('segment lock entries stay unique, move with edits and are all released on cancel', async () => {
  const f = fixture();
  const other = await f.mutate(f.create({date:D2,time:'06:00',endTime:'07:00',assignedCrew:['crew4']},{customerId:'c2'}));
  let job = (await f.mutate(f.split([seg('a',D1,'08:00','12:00'),seg('b',D2,'08:00','12:00',{assignedCrew:['crew2']})]))).job;
  const unique = () => { for (const date of [D1,D2,D3]) { const entries = ids(f.lock(date)); assert.equal(new Set(entries).size,entries.length); assert.ok(entries.every(id => id.length <= 200)); } };
  unique();
  job = (await f.mutate(f.edit(job,{assignmentSegments:[seg('a',D1,'08:00','12:00'),seg('b',D3,'09:00','12:00',{assignedCrew:['crew2']})]}))).job;
  assert.deepEqual(ids(f.lock(D2)),[other.job.id],'the moved segment releases its old day and keeps other work');
  assert.deepEqual(ids(f.lock(D3)),[`${job.id}~b`]); unique();
  assert.deepEqual([job.endDate,job.endTime],[D3,'12:00']);
  // Hull keys are derived: they cannot be edited next to, or instead of, segments.
  await assert.rejects(f.mutate(f.edit(job,{time:'09:00'})),error => error.code === 'dispatch_segments_hull_derived');
  await assert.rejects(f.mutate(f.edit(job,{date:D1,assignmentSegments:[seg('a',D1,'08:00','12:00')]})),error => error.code === 'dispatch_segments_hull_derived');
  job = (await f.mutate(f.edit(job,{title:'Synthetic renamed job'}))).job;
  // Clearing keeps the hull as one conservative legacy assignment keyed by the job ID.
  job = (await f.mutate(f.edit(job,{assignmentSegments:[]}))).job;
  assert.equal(f.rows.get('jobs/'+job.id).assignmentSegments,null); assert.equal(job.assignmentSegments,undefined);
  for (const date of [D1,D2,D3]) assert.ok(f.lock(date).some(entry => entry.id === job.id) && !f.lock(date).some(entry => entry.id.includes('~')));
  job = (await f.mutate(f.edit(job,{assignmentSegments:[seg('x',D1,'08:00','10:00'),seg('y',D1,'10:00','12:00')],}))).job;
  assert.deepEqual(ids(f.lock(D1)),[`${job.id}~x`,`${job.id}~y`]); assert.deepEqual(ids(f.lock(D2)),[other.job.id]); assert.deepEqual(f.lock(D3),[]);
  const cancelled = (await f.mutate(f.edit(job,{},'schedule.cancel'))).job;
  for (const date of [D1,D2,D3]) assert.ok(!f.lock(date).some(entry => ownsLockEntry(entry,job.id)));
  const restored = (await f.mutate(f.edit(cancelled,{},'schedule.restore'))).job;
  assert.deepEqual(ids(f.lock(D1)),[`${restored.id}~x`,`${restored.id}~y`]);
  const receipt = [...f.rows.entries()].find(([key,row]) => key.startsWith('dispatchOperations/') && row.targetId === job.id && row.action === 'schedule.restore')[1];
  assert.deepEqual(receipt.after.assignmentSegments.map(row => row.id),['x','y']);
  // Longest job ID and segment ID still fit the 200-character lock-entry limit.
  const long = {id:'j'.repeat(180),type:'job',status:'scheduled',assignmentSegments:[seg('s'.repeat(19),D1,'08:00','09:00')]};
  assert.equal(segmentLockEntries(long,D1,ROSTER,NOW)[0].id.length,200);
  assert.equal(scheduleLockConflict({id:long.id,type:'job',date:D1,time:'08:00',endTime:'09:00',assignedCrew:['crew1']},segmentLockEntries(long,D1,ROSTER,NOW)[0],D1,ROSTER),false,'a job never conflicts with its own segment entries');
});

test('a crew viewer sees only their own segments, windows, co-workers and vehicle', async () => {
  const f = fixture();
  const created = await f.mutate(f.split([seg('a',D1,'08:00','12:00',{assignedCrew:['crew1','crew3'],crewLead:'crew1',vehicleId:'truck1',notes:'Synthetic front bay'}),seg('b',D1,'13:00','17:00',{assignedCrew:['crew2'],vehicleId:'truck2',notes:'Synthetic back shelving'}),seg('c',D2,'08:00','12:00',{assignedCrew:['crew2']})]));
  const raw = {...f.rows.get('jobs/'+created.job.id),estimate:{total:1200}};
  const crew2 = fieldJobProjection(raw,[],{viewer:'Crew2',crewNames:{crew2:'Crew Two'},resourceNames:{truck2:'Synthetic truck2'}});
  assert.deepEqual(crew2.assignmentSegments.map(row => row.id),['b','c']);
  assert.deepEqual([crew2.date,crew2.time,crew2.endDate,crew2.endTime],[D1,'13:00',D2,'12:00']);
  assert.deepEqual(crew2.assignedCrew,['crew2']); assert.deepEqual(crew2.crewMembers,[{id:'crew2',name:'Crew Two'}]);
  assert.equal(crew2.vehicleId,'','segments b and c do not share a vehicle'); assert.equal(crew2.assignmentSegments[0].vehicleName,'Synthetic truck2');
  const text = JSON.stringify(crew2);
  for (const secret of ['crew1','crew3','Synthetic front bay','truck1','1200']) assert.ok(!text.includes(secret),`${secret} is not exposed to crew2`);
  const crew1 = fieldJobProjection(raw,[],{viewer:'crew1'});
  assert.deepEqual([crew1.assignmentSegments.map(row => row.id),crew1.time,crew1.endTime,crew1.vehicleId,crew1.crewLead],[['a'],'08:00','12:00','truck1','crew1']);
  const boss = fieldJobProjection(raw,[],{manager:true});
  assert.deepEqual([boss.assignmentSegments.map(row => row.id),boss.time,boss.endDate,boss.endTime],[['a','b','c'],'08:00',D2,'12:00']);
  assert.equal(crewJobProjection(raw,{viewer:'crew2'}).assignedTo,'crew2');
  assert.deepEqual(fieldJobProjection(raw).assignmentSegments,[],'no viewer, no segments');
  assert.equal(fieldViewerWorksOn(raw,'crew1',D2,D2),false); assert.equal(fieldViewerWorksOn(raw,'crew2',D2,D2),true); assert.equal(fieldViewerWorksOn(raw,'crew1',D1,D2),true);
  assert.equal(fieldViewerWorksOn({id:'legacy',type:'job',date:D1},'anyone',D3,D3),true,'legacy listings are unchanged');
  // The crew schedule endpoint applies the same projection to the signed-in employee.
  assert.ok(CREW_LISTING_FIELDS.includes('assignmentSegments'));
  const listing = crewJobsHandlers({session:async()=>({user:'crew2',displayName:'Crew Two',role:'crew'}),storage:()=>({jobRecords:async()=>[raw]}),now:()=>new Date(NOW)});
  const body = await (await listing.get({request:new Request('https://easygaragecleaning.com/api/crew-jobs'),env:{FIREBASE_API_KEY:'firebase-test-segments'}})).json();
  assert.deepEqual(body.jobs.map(job => job.assignmentSegments.map(row => row.id)),[['b','c']]);
  assert.ok(!JSON.stringify(body).includes('Synthetic front bay'));
});

test('segmented jobs cannot become open shifts and the legacy scheduler must hand them to dispatch', async () => {
  const f = fixture();
  const created = await f.mutate(f.split([seg('a',D1,'08:00','12:00'),seg('b',D2,'08:00','17:00')],{shiftPickupEnabled:true,crewNeeded:3}));
  assert.equal(f.rows.get('jobs/'+created.job.id).openShift,false);
  Object.assign(f.rows.get('jobs/'+created.job.id),{openShift:true});
  await assert.rejects(mutateDispatchSelfAssignment(f.store,{user:'crew2'},{action:'claim',jobId:created.job.id,requestId:randomUUID()},NOW),error => error.code === 'dispatch_shift_closed');
  const actor = {id:'legacy-sender',kind:'integration',role:'integration'};
  const single = await f.mutate(f.split([seg('a',D3,'08:00','10:00'),seg('b',D3,'08:00','10:00',{assignedCrew:['crew2']})],{},{customerId:'c2'}));
  const saved = f.rows.get('jobs/'+single.job.id);
  await assert.rejects(mutateScheduledVisit(f.store,actor,{requestId:randomUUID(),mode:'update',portalCustomerId:'c2',portalVisitId:saved.id,expectedRevision:saved.revision,changes:{time:'09:00',endTime:'11:00'}},NOW),error => error.message === 'schedule_segments_require_dispatch');
  assert.equal(f.rows.get('jobs/'+single.job.id).revision,saved.revision);
  // Its lock entries still guard other writers only during each segment window.
  const visit = changes => mutateScheduledVisit(f.store,actor,{requestId:randomUUID(),mode:'create',portalCustomerId:'c1',kind:'walkthrough',changes},NOW);
  await assert.rejects(visit({date:D2,time:'16:00',endTime:'18:00'}),error => error.message === 'schedule_slot_conflict');
  assert.equal((await visit({date:D2,time:'17:30',endTime:'18:30'})).ok,true);
});

test('segment validation is strict and warnings are reported per segment', async () => {
  const f = fixture(), roster = ROSTER, resources = await f.store.resources();
  const bad = [
    [Array.from({length:SEGMENT_LIMIT+1},(_,index) => seg(`s${index}`,D1,'08:00','09:00')),'dispatch_segments_invalid'],
    [[seg('a',D1,'08:00','09:00'),seg('a',D1,'10:00','11:00')],'dispatch_segments_invalid'],
    [[seg('bad id',D1,'08:00','09:00')],'dispatch_segments_invalid'],
    [[seg('a'.repeat(20),D1,'08:00','09:00')],'dispatch_segments_invalid'],
    [[{...seg('a',D1,'08:00','09:00'),status:'completed'}],'dispatch_segments_invalid'],
    [[seg('a','2026-03-08','02:15','04:00')],'dispatch_time_invalid'],
    [[seg('a',D1,'10:00','09:00')],'dispatch_time_invalid'],
    [[seg('a',D1,'08:00','09:00'),seg('b','2026-10-30','08:00','09:00')],'dispatch_segments_span_invalid'],
    [[seg('a',D1,'08:00','09:00',{crewLead:'crew2'})],'dispatch_lead_not_assigned'],
    [[seg('a',D1,'08:00','09:00',{assignedCrew:['former.employee']})],'dispatch_employee_inactive'],
    [[seg('a',D1,'08:00','09:00',{assignedCrew:['crew1','crew1']})],'dispatch_crew_duplicate'],
    [[seg('a',D1,'08:00','09:00',{vehicleId:'truck4'})],'dispatch_vehicle_unavailable'],
    [[seg('a',D1,'08:00','09:00',{crewId:'missing'})],'dispatch_crew_inactive'],
    ['not a list','dispatch_segments_invalid'],
  ];
  for (const [value,code] of bad) assert.throws(() => validateSegments(value,{roster,resources}),error => error.code === code,code);
  const plan = validateSegments([seg('late',D2,'08:00','09:00'),{id:'crew',date:D1,time:'08:00',endTime:'09:00',crewId:'north'}],{roster,resources});
  assert.deepEqual(plan.segments.map(row => row.id),['crew','late'],'segments are stored in start order');
  assert.deepEqual([plan.segments[0].assignedCrew,plan.segments[0].crewLead,plan.hull.crewId],[['crew1','crew3'],'crew1',null]);
  const created = await f.mutate(f.split([seg('pair',D1,'08:00','12:00',{assignedCrew:['crew1','crew2']}),seg('empty',D1,'13:00','15:00',{assignedCrew:[]})]));
  const codes = created.warnings.map(row => [row.code,row.segmentId]);
  assert.ok(codes.some(([code,segment]) => code === 'missing_crew_lead' && segment === 'pair'));
  assert.ok(codes.some(([code,segment]) => code === 'segment_unassigned' && segment === 'empty'));
  // An empty segment reserves nobody, exactly like an explicit empty native crew.
  assert.equal(sharedScheduleResources({id:'probe',type:'job',assignedCrew:['crew4']},f.rows.get('jobs/'+created.job.id),ROSTER),false);
  const stored = f.rows.get('jobs/'+created.job.id), roundTrip = decodeFirestoreFields(encodeFirestoreFields({assignmentSegments:stored.assignmentSegments}));
  assert.deepEqual(roundTrip.assignmentSegments,stored.assignmentSegments,'segments survive the Firestore encoding unchanged');
});

test('dispatch storage masks segments into scans and maps FAILED_PRECONDITION to a revision conflict with the flag on or off', async () => {
  const masks = [];
  const scan = async (_env,url) => { masks.push(new URL(url).searchParams.getAll('mask.fieldPaths')); return Response.json({documents:[]}); };
  await dispatchStorage({},scan).jobs();
  assert.ok(masks[0].includes('assignmentSegments'));
  const stale = async () => Response.json({error:{code:400,status:'FAILED_PRECONDITION',message:'Synthetic stale updateTime'}},{status:400});
  const write = [{collection:'jobs',id:'job-1',revision:'2026-09-22T00:00:00.000000Z',patch:{title:'Synthetic'}}];
  await assert.rejects(dispatchStorage({EGC_DISPATCH_SEGMENTS:'true'},stale).commit(write),error => error.code === 'dispatch_revision_conflict' && error.status === 409);
  // P0-4 (functions/_lib/firestore-errors.js) classifies a stale updateTime for every store, so the flag no longer matters.
  await assert.rejects(dispatchStorage({},stale).commit(write),error => error.code === 'dispatch_revision_conflict' && error.status === 409);
  const invalid = async () => Response.json({error:{code:400,status:'INVALID_ARGUMENT'}},{status:400});
  await assert.rejects(dispatchStorage({EGC_DISPATCH_SEGMENTS:'true'},invalid).commit(write),error => error.code === 'dispatch_outcome_unknown');
  await assert.rejects(dispatchStorage({},invalid).commit(write),error => error.code === 'dispatch_outcome_unknown' && error.status === 503);
});

test('turning the flag off keeps honouring saved segments and still allows clearing them', async () => {
  const f = fixture();
  const job = (await f.mutate(f.split([seg('a',D1,'08:00','12:00'),seg('b',D1,'08:00','12:00',{assignedCrew:['crew2']})]))).job;
  f.store.segmentsEnabled = false;
  await assert.rejects(f.mutate(f.create({time:'09:00',endTime:'10:00',assignedCrew:['crew2']},{customerId:'c2'})),error => error.code === 'dispatch_conflict');
  await assert.rejects(f.mutate(f.edit(job,{assignedCrew:['crew1']})),error => error.code === 'dispatch_segments_hull_derived');
  await assert.rejects(f.mutate(f.edit(job,{assignmentSegments:[seg('a',D1,'08:00','12:00')]})),error => error.code === 'dispatch_segments_disabled');
  const renamed = (await f.mutate(f.edit(job,{title:'Synthetic rename while off'}))).job;
  assert.equal(renamed.assignmentSegments.length,2);
  const cleared = (await f.mutate(f.edit(renamed,{assignmentSegments:[],assignedCrew:['crew1'],time:'08:00',endTime:'12:00'}))).job;
  assert.deepEqual([cleared.assignedCrew,cleared.assignmentSegments,ids(f.lock(D1))],[['crew1'],undefined,[job.id]]);
});

test('the field day list and job detail give each crew member only their own segment', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
  const env = {HUB_SESSION_SECRET:'synthetic-segments-session-secret',FIREBASE_API_KEY:'firebase-test-segments',HUB_AUTH_USERS_JSON:JSON.stringify({ZacB:{passwordHash:'test',role:'owner',displayName:'Owner'},'Crew.One':{passwordHash:'test',role:'crew',displayName:'Crew One'},'Crew.Two':{passwordHash:'test',role:'crew',displayName:'Crew Two'}})};
  const cookies = new Map(await Promise.all(['ZacB','Crew.One','Crew.Two'].map(async user => [user,(await createHubSessionCookie(env,user)).split(';')[0]])));
  const get = async (user,search) => (await fieldJobs.onRequestGet({env,request:new Request(`https://easygaragecleaning.com/api/field-jobs${search}`,{headers:{Cookie:cookies.get(user)}})})).json();
  const store = fieldStorage(t), part = (id,date,assignedCrew,vehicleId,notes) => ({id,date,time:'08:00',endDate:date,endTime:'17:00',assignedCrew,crewLead:null,crewId:null,vehicleId,notes});
  store.put('jobs/split',{type:'job',customer:'Synthetic Split Garage',address:'1 Synthetic Way',date:D1,time:'08:00',endDate:D2,endTime:'17:00',startAt:'2026-09-23T14:00:00.000Z',endAt:'2026-09-24T23:00:00.000Z',assignedCrew:['crew.one','crew.two'],status:'scheduled',pipelineStatus:'scheduled',total:900,
    assignmentSegments:[part('a',D1,['crew.one'],'truck-1','Synthetic front bay'),part('b',D2,['crew.two'],'truck-2','Synthetic back bay')]});
  store.put('dispatchResources/truck-1',{recordType:'vehicle',name:'Synthetic truck one'});store.put('dispatchResources/truck-2',{recordType:'vehicle',name:'Synthetic truck two'});
  const one = await get('Crew.One',`?date=${D1}`);
  assert.deepEqual(one.jobs.map(job => [job.id,job.date,job.endDate,job.time,job.endTime,job.vehicleName]),[['split',D1,D1,'08:00','17:00','Synthetic truck one']]);
  assert.deepEqual(one.jobs[0].assignmentSegments.map(row => row.id),['a']);
  assert.ok(!JSON.stringify(one).includes('Synthetic back bay') && !JSON.stringify(one).includes('crew.two') && !JSON.stringify(one).includes('900'));
  assert.deepEqual((await get('Crew.One',`?date=${D2}`)).jobs,[],'crew one does not work the second day');
  assert.deepEqual((await get('Crew.Two',`?date=${D1}`)).jobs,[]);
  const detail = await get('Crew.Two','?jobId=split');
  assert.deepEqual([detail.job.date,detail.job.assignmentSegments.map(row => [row.id,row.vehicleName])],[D2,[['b','Synthetic truck two']]]);
  assert.deepEqual((await get('ZacB','?jobId=split')).job.assignmentSegments.map(row => row.id),['a','b'],'managers see every segment');
});

test('canary: a crew viewer in no segment, or a projection without a viewer, sees no employees, vehicle or times', async () => {
  const f = fixture();
  const created = await f.mutate(f.split([seg('a',D1,'08:00','12:00',{crewLead:'crew1',vehicleId:'truck1',notes:'Synthetic front bay'}),seg('b',D3,'08:00','12:00',{assignedCrew:['crew2'],vehicleId:'truck2',notes:'Synthetic back bay'})]));
  // The job-level crew drifted from its segments (e.g. a direct client-SDK write): crew3 is on the job but in no segment.
  const raw = {...f.rows.get('jobs/'+created.job.id),assignedCrew:['crew1','crew2','crew3'],assignedTo:'crew1, crew2, crew3',crewName:'Synthetic stale crew',vehicleName:'Synthetic stale truck',
    shiftClaims:[{employee:'crew2',claimedAt:NOW}],lastShiftClaim:{employee:'crew2',claimedAt:NOW},estimate:{total:4321}};
  const crewNames = {crew1:'Crew One',crew2:'Crew Two',crew3:'Crew Three'}, secrets = ['crew1','crew2','Crew One','Crew Two','truck1','truck2','Synthetic front bay','Synthetic back bay','Synthetic stale','4321'];
  for (const [label,options] of [['non-member',{viewer:'crew3',crewNames}],['no viewer',{crewNames}],['blank viewer',{viewer:'  ',crewNames}],['manager false',{manager:false,crewNames,resourceNames:{truck1:'Synthetic truck1'}}]]) {
    for (const view of [fieldJobProjection(raw,[],options),crewJobProjection(raw,options)]) {
      assert.deepEqual([view.assignedCrew,view.crewMembers,view.crewLead,view.crewId,view.crewName,view.vehicleId,view.vehicleName,view.assignmentSegments],[[],[],'','','','','',[]],label);
      assert.deepEqual([view.date,view.time,view.endDate,view.endTime,view.startAt,view.endAt],['','','','','',''],label);
      const text = JSON.stringify(view);
      for (const secret of secrets) assert.ok(!text.includes(secret),`${label}: ${secret} is not exposed`);
    }
  }
  assert.deepEqual([crewJobProjection(raw,{viewer:'crew3'}).assignedTo,crewJobProjection(raw,{viewer:'crew3'}).shiftClaims,crewJobProjection(raw,{viewer:'crew3'}).lastShiftClaim],['',[],null]);
  // The crew schedule endpoint lets crew3 open the drifted job but shows no one else on it.
  const listing = crewJobsHandlers({session:async()=>({user:'crew3',displayName:'Crew Three',role:'crew'}),storage:()=>({jobRecords:async()=>[raw]}),now:()=>new Date(NOW)});
  const body = await (await listing.get({request:new Request('https://easygaragecleaning.com/api/crew-jobs'),env:{FIREBASE_API_KEY:'firebase-test-segments'}})).json();
  assert.equal(body.jobs.length,1);
  for (const secret of secrets) assert.ok(!JSON.stringify(body).includes(secret),`listing: ${secret} is not exposed`);
  // A viewer whose only segment has unreadable times keeps their own crew but no job-wide window.
  const untimed = {...raw,assignmentSegments:raw.assignmentSegments.map(row => row.id === 'a' ? {...row,time:'bad'} : row)};
  const crew1 = fieldJobProjection(untimed,[],{viewer:'crew1'});
  assert.deepEqual([crew1.assignedCrew,crew1.vehicleId,crew1.date,crew1.endDate,crew1.assignmentSegments.map(row => row.id)],[['crew1'],'truck1','','',['a']]);
  assert.ok(!JSON.stringify(crew1).includes('crew2') && !JSON.stringify(crew1).includes('truck2'));
  // Managers still see the whole job.
  const boss = fieldJobProjection(raw,[],{manager:true});
  assert.deepEqual([boss.assignmentSegments.map(row => row.id),boss.date,boss.endDate,boss.assignedCrew],[['a','b'],D1,D3,['crew1','crew2','crew3']]);
  // A legacy job is unchanged without a viewer.
  const legacy = {id:'legacy',type:'job',date:D1,time:'08:00',endTime:'10:00',assignedCrew:['crew1','crew2'],crewLead:'crew1',vehicleId:'truck1',status:'scheduled'};
  assert.deepEqual([fieldJobProjection(legacy).assignedCrew,fieldJobProjection(legacy).vehicleId,fieldJobProjection(legacy).time],[['crew1','crew2'],'truck1','08:00']);
});

test('taking a truck out of service lists each split segment that uses it', async () => {
  const f = fixture();
  const job = (await f.mutate(f.split([seg('a',D1,'08:00','12:00',{vehicleId:'truck1'}),seg('b',D1,'08:00','12:00',{assignedCrew:['crew2'],vehicleId:'truck2'})]))).job;
  assert.equal(f.rows.get('jobs/'+job.id).vehicleId,null,'mixed trucks leave no job-level vehicle');
  const legacy = (await f.mutate(f.create({date:D2,vehicleId:'truck3'},{customerId:'c2'}))).job;
  const outOfService = id => f.mutate({action:'vehicle.save',requestId:randomUUID(),id,expectedRevision:f.rows.get('dispatchResources/'+id).revision,changes:{status:'out_of_service'}});
  const review = result => result.warnings.find(row => row.code === 'vehicle_assignments_need_review');
  assert.deepEqual(review(await outOfService('truck2')),{code:'vehicle_assignments_need_review',message:'Vehicle availability was updated. Existing assignments need reassignment.',jobIds:[job.id],segments:[{jobId:job.id,segmentId:'b'}]});
  assert.deepEqual(review(await outOfService('truck3')),{code:'vehicle_assignments_need_review',message:'Vehicle availability was updated. Existing assignments need reassignment.',jobIds:[legacy.id]},'a legacy job keeps the original warning shape');
});

test('manager time off warns only about the segments that employee works', async () => {
  const f = fixture();
  const job = (await f.mutate(f.split([seg('d1',D1,'08:00','17:00'),seg('mid',D2,'08:00','17:00',{assignedCrew:['crew2']}),seg('d3',D3,'08:00','17:00')]))).job;
  const off = (employeeId,date) => f.mutate({action:'availability.save',requestId:randomUUID(),changes:{employeeId,date,allDay:true,status:'active'}});
  assert.deepEqual((await off('crew1',D2)).warnings,[],'crew1 does not work the day between their segments');
  assert.deepEqual((await off('crew1',D3)).warnings.find(row => row.code === 'availability_conflicts').conflicts,[{jobId:job.id,employeeId:'crew1',segmentId:'d3'}]);
  assert.deepEqual((await off('crew2',D2)).warnings.find(row => row.code === 'availability_conflicts').conflicts,[{jobId:job.id,employeeId:'crew2',segmentId:'mid'}]);
});

test('re-sending unchanged segments is not a move, even when storage returns their fields in another order', async () => {
  const f = fixture(), blocked = [];
  Object.assign(f.store,{legacyBlockMode:'enforce',legacyBlockedDays:async dates => blocked.filter(date => dates.includes(date))});
  const segments = [seg('a',D1,'08:00','12:00',{vehicleId:'truck1'}),seg('b',D1,'13:00','17:00',{assignedCrew:['crew2']})];
  let job = (await f.mutate(f.split(segments))).job;
  blocked.push(D1);
  const stored = f.rows.get('jobs/'+job.id);
  stored.assignmentSegments = stored.assignmentSegments.map(row => Object.fromEntries(Object.entries(row).sort(([a],[b]) => b.localeCompare(a))));
  assert.notEqual(JSON.stringify(stored.assignmentSegments),JSON.stringify(validateSegments(segments,{roster:ROSTER,resources:await f.store.resources()}).segments));
  // The editor re-sends every segment with a scope-only change; the legacy blocked day is not re-enforced.
  job = (await f.mutate(f.edit(job,{assignmentSegments:segments,jobInstructions:'Synthetic scope-only edit'}))).job;
  assert.equal(job.jobInstructions,'Synthetic scope-only edit');
  await assert.rejects(f.mutate(f.edit(job,{assignmentSegments:[segments[0],{...segments[1],time:'14:00'}]})),error => error.code === 'dispatch_conflict' && error.details.conflicts.some(row => row.code === 'legacy_blocked_day'));
});

test('a split create is keyed by its first segment start, so a repeated create is refused', async () => {
  const f = fixture(), segments = [seg('a',D1,'08:00','12:00'),seg('b',D2,'08:00','12:00',{assignedCrew:['crew2']})];
  const first = await f.mutate(f.split(segments));
  assert.match(first.job.id,/^visit_/); assert.ok(f.rows.get('jobs/'+first.job.id).bookingKey);
  await assert.rejects(f.mutate(f.split(segments)),error => error.code === 'dispatch_job_already_exists' && error.status === 409);
  await assert.rejects(f.mutate(f.split([seg('x',D1,'08:00','09:00',{assignedCrew:['crew4']})])),error => error.code === 'dispatch_job_already_exists','another split with the same start');
  await assert.rejects(f.mutate(f.create({date:D1,time:'08:00',endTime:'09:00',assignedCrew:['crew4']})),error => error.code === 'dispatch_job_already_exists','a single visit at the same start');
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('jobs/') && !key.includes('_egc_')).length,1);
  // Another customer, or another start, is a different booking.
  assert.equal((await f.mutate(f.split([seg('y',D1,'08:00','09:00',{assignedCrew:['crew4']})],{},{customerId:'c2'}))).job.status,'scheduled');
  assert.equal((await f.mutate(f.split([seg('z',D3,'08:00','09:00')]))).job.status,'scheduled');
  // With the flag off a split create is refused as disabled before any booking check.
  f.store.segmentsEnabled = false;
  await assert.rejects(f.mutate(f.split(segments)),error => error.code === 'dispatch_segments_disabled');
});

test('an unreadable saved segment list is flagged for managers and cleared with job-level time and crew', async () => {
  const f = fixture();
  const created = (await f.mutate(f.split([seg('a',D1,'08:00','12:00'),seg('b',D1,'08:00','12:00',{assignedCrew:['crew2']})]))).job;
  f.rows.get('jobs/'+created.id).assignmentSegments[1].id = 'a';
  const overview = await dispatchOverview(f.store,manager,{startDate:D1,endDate:D2},new Date(NOW)), row = overview.jobs.find(item => item.id === created.id);
  assert.deepEqual([row.assignmentSegments,row.segmentsInvalid,row.date,row.assignedCrew],[[],true,D1,['crew1','crew2']]);
  assert.ok(overview.warnings.some(warning => warning.code === 'segments_invalid' && warning.jobId === created.id));
  assert.equal(projectDispatchJob({id:'legacy',type:'job',date:D1}).segmentsInvalid,undefined);
  assert.deepEqual(fieldJobProjection(f.rows.get('jobs/'+created.id),[],{viewer:'crew1'}).assignedCrew,[],'crew see nothing of an unreadable split');
  f.store.segmentsEnabled = false;
  await assert.rejects(f.mutate(f.edit(row,{time:'09:00'})),error => error.code === 'dispatch_segments_hull_derived');
  const cleared = (await f.mutate(f.edit(row,{assignmentSegments:[],date:D1,time:'08:00',endDate:D1,endTime:'12:00',assignedCrew:['crew1','crew2'],crewLead:'crew1'}))).job;
  assert.deepEqual([f.rows.get('jobs/'+cleared.id).assignmentSegments,cleared.segmentsInvalid,cleared.assignedCrew,ids(f.lock(D1))],[null,undefined,['crew1','crew2'],[cleared.id]]);
  assert.ok(!(await dispatchOverview(f.store,manager,{startDate:D1,endDate:D2},new Date(NOW))).warnings.some(warning => warning.code === 'segments_invalid'));
});

test('a split job cannot be the template of a recurring plan', async () => {
  const f = fixture();
  const job = (await f.mutate(f.split([D1,D2,D3].map((date,index) => seg(`d${index+1}`,date,'08:00','17:00'))))).job;
  const plan = templateJobId => mutateRecurringPlan(f.store,manager,{action:'create',requestId:randomUUID(),plan:{templateJobId,cadence:{frequency:'weekly'}}},NOW,{enabled:true});
  await assert.rejects(plan(job.id),error => error.code === 'recurring_template_segmented' && error.status === 409);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('recurringPlans/')).length,0);
  const single = (await f.mutate(f.create({date:D1,time:'18:00',endTime:'20:00',assignedCrew:['crew2']},{customerId:'c2'}))).job;
  assert.equal((await plan(single.id)).plan.templateJobId,single.id,'a single-window job still repeats');
});
