import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOpenings } from '../functions/_lib/dispatch-openings.js';
import { dispatchOpeningsHandlers } from '../functions/api/dispatch-openings.js';
import { scheduleInterval } from '../functions/_lib/dispatch-time.js';

const manager={user:'zacb',role:'owner',businessAccess:true},now=new Date('2026-09-22T12:00:00Z');
const query={startDate:'2026-09-23',endDate:'2026-09-24',employeeIds:'crew1',durationMinutes:'60',travelBufferMinutes:'0'};
function fixture() {
  const data={jobs:[],resources:[],roster:[{id:'crew1',name:'Crew One',role:'crew'},{id:'crew2',name:'Crew Two',role:'crew'}],guard:{revision:'r1'},locks:{}};
  const store={jobs:async()=>structuredClone(data.jobs),resources:async()=>structuredClone(data.resources),roster:async()=>structuredClone(data.roster),read:async(collection,id)=>structuredClone(collection==='dispatchState'?data.guard:data.locks[id]||null)};
  const check=(changes={},at=now)=>dispatchOpenings(store,manager,{...query,...changes},at);
  const job=(id,changes={})=>({id,type:'job',status:'scheduled',date:'2026-09-23',time:'09:00',endTime:'10:00',assignedCrew:['crew1'],...changes});
  return {data,store,check,job};
}

test('capacity returns deterministic maximal gaps for selected people with no inferred working availability',async()=>{
  const f=fixture();f.data.jobs=[f.job('one'),f.job('two',{time:'11:00',endTime:'12:00'}),f.job('other',{time:'08:00',endTime:'17:00',assignedCrew:['crew2']})];
  const result=await f.check();
  assert.deepEqual(result.candidates.map(row=>[row.time,row.endTime,row.gapMinutes]),[['08:00','09:00',60],['10:00','11:00',60],['12:00','13:00',300]]);
  assert.equal(result.coverage.consistent,true);assert.equal(result.coverage.revision,'r1');assert.equal(result.constraints.workingAvailabilityConfirmed,false);
  assert.ok(result.warnings.some(row=>row.code==='working_availability_unconfirmed'));
  assert.deepEqual((await f.check({employeeIds:'crew1,crew2'})).candidates,[]);
});

test('travel buffers merge reservations and use the greater requested or existing job buffer',async()=>{
  const f=fixture();f.data.jobs=[f.job('one',{travelBufferMinutes:30}),f.job('two',{time:'10:20',endTime:'11:00'})];
  const result=await f.check({travelBufferMinutes:'15'});
  assert.equal(result.candidates[0].time,'11:15');assert.equal(result.candidates[0].gapMinutes,345);
  assert.ok(result.warnings.some(row=>row.code==='travel_buffer_estimate'));
});

test('multi-day work and both time-off sources block exactly the selected employee and release midnight',async()=>{
  const f=fixture();
  f.data.jobs=[f.job('overnight',{date:'2026-09-22',time:'16:00',endDate:'2026-09-23',endTime:'09:00'}),{id:'crew-off',type:'availability',recordType:'crew_availability',employee:'Crew One',date:'2026-09-23',time:'10:00',endTime:'12:00',allDay:false,status:'active'},f.job('midnight',{date:'2026-09-22',endDate:'2026-09-23',endTime:'00:00'})];
  f.data.resources=[{id:'resource-off',recordType:'availability',employeeId:'crew1',date:'2026-09-23',time:'13:00',endTime:'14:00',status:'active'},{id:'other-off',recordType:'availability',employeeId:'crew2',date:'2026-09-23',allDay:true,status:'active'}];
  assert.deepEqual((await f.check()).candidates.map(row=>row.time),['09:00','12:00','14:00']);
});

test('unknown legacy work and global blocks reserve capacity; explicitly empty native crews do not',async()=>{
  const f=fixture();f.data.jobs=[f.job('unassigned',{assignedCrew:[],time:'08:00',endTime:'17:00'}),f.job('legacy',{assignedCrew:undefined,time:'08:00',endTime:'10:00'}),f.job('blocked',{type:'blocked',assignedCrew:[],time:'10:00',endTime:'12:00'})];
  assert.equal((await f.check()).candidates[0].time,'12:00');
  f.data.jobs[1].status='cancelled';f.data.jobs[2].status='completed';assert.equal((await f.check()).candidates[0].time,'08:00');
});

test('selected vehicle conflicts across different crews and unavailable or unknown vehicles cannot advertise gaps',async()=>{
  const f=fixture();f.data.resources=[{id:'truck',recordType:'vehicle',name:'Box truck',status:'available',notes:'Private repair detail'}];
  f.data.jobs=[f.job('truck-job',{vehicleId:'truck',assignedCrew:['crew2'],time:'08:00',endTime:'12:00'})];
  const result=await f.check({vehicleId:'truck'});assert.equal(result.candidates[0].time,'12:00');assert.equal(result.vehicles[0].notes,undefined);
  for(const status of ['out_of_service','inactive']) {f.data.resources[0].status=status;await assert.rejects(f.check({vehicleId:'truck'}),e=>e.code==='dispatch_vehicle_unavailable');}
  await assert.rejects(f.check({vehicleId:'missing'}),e=>e.code==='dispatch_vehicle_unavailable');
});

test('malformed times, reversed dates, missing unavailable dates and orphan guards never create false capacity',async()=>{
  for(const row of [{time:'bad'},{endDate:'2026-09-22'},{date:'invalid'}]) {
    const f=fixture();f.data.jobs=[f.job('broken',row)];const result=await f.check();assert.deepEqual(result.candidates,[]);assert.ok(result.warnings.some(w=>w.code==='invalid_schedule'));
  }
  const f=fixture();f.data.resources=[{id:'bad-off',recordType:'availability',employeeId:'crew1',status:'active'}];assert.deepEqual((await f.check()).candidates,[]);
  f.data.resources=[];f.data.locks['_egc_schedule_lock_2026-09-23']={recordType:'schedule_lock',revision:'lock1',entries:[{id:'missing-job',start:'08:00',end:'12:00',assignedCrew:['crew1'],status:'scheduled'}]};
  assert.equal((await f.check()).candidates[0].time,'12:00');
  f.data.locks['_egc_schedule_lock_2026-09-23'].entries[0].start='bad';assert.deepEqual((await f.check()).candidates,[]);
  f.data.locks['_egc_schedule_lock_2026-09-23'].entries='bad';await assert.rejects(f.check(),e=>e.code==='dispatch_lock_unavailable');
});

test('completed canonical work overrides its old lock without resurrecting a reservation',async()=>{
  const f=fixture();f.data.jobs=[f.job('done',{status:'completed'})];f.data.locks['_egc_schedule_lock_2026-09-23']={recordType:'schedule_lock',revision:'lock1',entries:[{id:'done',start:'08:00',end:'17:00',assignedCrew:['crew1'],status:'scheduled'}]};
  assert.equal((await f.check()).candidates[0].gapMinutes,540);
});

test('a concurrent schedule commit during collection scans retries the snapshot and sees the new reservation',async()=>{
  const f=fixture(),read=f.store.jobs;let scans=0;
  f.store.jobs=async()=>{const snapshot=await read();if(++scans===1){f.data.jobs=[f.job('new',{time:'08:00',endTime:'12:00'})];f.data.guard={revision:'r2'};}return snapshot;};
  const result=await f.check();assert.equal(scans,2);assert.equal(result.coverage.revision,'r2');assert.equal(result.candidates[0].time,'12:00');
});

test('day-lock-only races and employee account changes also invalidate the capacity snapshot',async()=>{
  const f=fixture(),read=f.store.jobs;let scans=0;
  f.store.jobs=async()=>{const result=await read();if(++scans===1)f.data.locks['_egc_schedule_lock_2026-09-23']={recordType:'schedule_lock',revision:'new-lock',entries:[{id:'legacy',start:'08:00',end:'12:00',assignedCrew:['crew1']}]};return result;};
  assert.equal((await f.check()).candidates[0].time,'12:00');assert.equal(scans,2);
  const g=fixture(),roster=g.store.roster;let rosterReads=0;
  g.store.roster=async()=>{const result=await roster();if(++rosterReads===1)g.data.roster=g.data.roster.filter(person=>person.id!=='crew1');return result;};
  await assert.rejects(g.check(),e=>e.code==='dispatch_employee_inactive');
});

test('repeated schedule movement fails clearly rather than returning a mixed or silently stale snapshot',async()=>{
  const f=fixture();let scans=0;f.store.jobs=async()=>{f.data.guard={revision:`changed${++scans}`};return [];};
  await assert.rejects(f.check(),e=>e.code==='dispatch_snapshot_changed'&&e.status===409);assert.equal(scans,2);
  f.store.jobs=async()=>{throw new Error('partial scan');};await assert.rejects(f.check());
});

test('DST gaps, repeated hours, next-day midnight and elapsed duration round-trip through canonical booking',async()=>{
  const f=fixture();
  for(const [startDate,endDate,durationMinutes,expectedEnd,gapMinutes] of [['2026-03-08','2026-03-09','180','04:00',180],['2026-11-01','2026-11-02','240','03:00',300]]) {
    const result=await f.check({startDate,endDate,durationMinutes,workdayStart:'00:00',workdayEnd:'04:00'},new Date('2026-01-01T12:00:00Z'));
    assert.equal(result.candidates[0].endTime,expectedEnd);assert.equal(result.candidates[0].gapMinutes,gapMinutes);
    const interval=scheduleInterval(result.candidates[0]);assert.equal((interval.end-interval.start)/60000,Number(durationMinutes));
  }
  const ambiguous=await f.check({startDate:'2026-11-01',endDate:'2026-11-02',workdayStart:'00:00',workdayEnd:'04:00',durationMinutes:'90'},new Date('2026-01-01T12:00:00Z'));
  assert.equal(ambiguous.candidates[0].time,'02:00');assert.equal(ambiguous.candidates[0].endTime,'03:30');
  const midnight=await f.check({workdayStart:'23:00',workdayEnd:'24:00'});assert.equal(midnight.candidates[0].endDate,'2026-09-24');assert.equal(midnight.candidates[0].endTime,'00:00');
  const bad=await f.check({startDate:'2026-03-08',endDate:'2026-03-09',workdayStart:'02:00'},new Date('2026-01-01T12:00:00Z'));assert.deepEqual(bad.candidates,[]);assert.equal(bad.warnings.at(-1).code,'workday_time_ambiguous');
});

test('past minutes are omitted and candidate output is capped at20 without hiding remaining gap count',async()=>{
  const f=fixture();assert.equal((await f.check({},new Date('2026-09-23T16:30:20Z'))).candidates[0].time,'10:31');
  assert.deepEqual((await f.check({},new Date('2026-09-24T12:00:00Z'))).candidates,[]);
  for(let day=23;day<=30;day++)for(const hour of [9,11,13,15])f.data.jobs.push(f.job(`${day}-${hour}`,{date:`2026-09-${day}`,time:`${String(hour).padStart(2,'0')}:00`,endTime:`${String(hour+1).padStart(2,'0')}:00`}));
  const result=await f.check({endDate:'2026-10-01',durationMinutes:'30'});assert.equal(result.candidates.length,20);assert.equal(result.total,40);assert.equal(result.truncated,true);
});

test('manager-only HTTP API has no-store responses, bounded query inputs and no mutation side effects',async()=>{
  const f=fixture();f.store.commit=()=>{throw new Error('Openings must never write');};
  const handler=actor=>dispatchOpeningsHandlers({session:async()=>actor,storage:()=>f.store,now:()=>now});
  const request=new Request('https://egc.test/api/dispatch-openings?'+new URLSearchParams(query));
  for(const [actor,status] of [[null,401],[{user:'crew1',role:'crew'},403]])assert.equal((await handler(actor).get({request,env:{}})).status,status);
  const result=await handler(manager).get({request,env:{}});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  for(const changes of [{durationMinutes:'14'},{durationMinutes:'1441'},{durationMinutes:'15.5'},{employeeIds:''},{employeeIds:'crew1,CREW1'},{employeeIds:'Crew One'},{endDate:'2026-10-15'},{workdayEnd:'07:00'},{travelBufferMinutes:'181'},{unexpected:'x'}])await assert.rejects(f.check(changes));
  const duplicate=new Request(request.url+'&durationMinutes=60');assert.equal((await handler(manager).get({request:duplicate,env:{}})).status,400);
});
