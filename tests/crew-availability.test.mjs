import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { crewAvailabilityOverview, mutateCrewAvailability } from '../functions/_lib/crew-availability.js';
import { crewAvailabilityHandlers } from '../functions/api/crew-availability.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';

const NOW = '2026-09-22T12:00:00.000Z';
const crew = {user:'Crew.One',displayName:'Crew One',role:'crew'};
const manager = {user:'zacb',displayName:'Owner',role:'owner',businessAccess:true};
function fixture() {
  const rows = new Map([['customers/c1',{id:'c1',revision:'customer-1',name:'Synthetic customer',phone:'9705550100'}]]), commits = [];
  const roster = [{id:'crew.one',name:'Crew One',role:'crew'},{id:'crew-one',name:'Other Employee',role:'crew'},{id:'crew2',name:'Crew Two',role:'crew'},{id:'zacb',name:'Owner',role:'owner'}];
  const all = collection => [...rows].filter(([key])=>key.startsWith(collection+'/')).map(([,row])=>structuredClone(row));
  let revision = 0, gateCount = 0, gate, release;
  const store = {
    roster:async()=>structuredClone(roster),jobs:async()=>all('jobs'),resources:async()=>all('dispatchResources'),customers:async()=>all('customers'),
    read:async(collection,id)=>structuredClone(rows.get(collection+'/'+id) || null),
    commit:async writes=>{
      if (gateCount) {gateCount--; if(!gateCount)release(); await gate;}
      const targets = new Set();
      for (const write of writes) {
        const key=write.collection+'/'+write.id, current=rows.get(key); assert.ok(!targets.has(key));targets.add(key);
        if (write.revision ? current?.revision !== write.revision : Boolean(current)) throw Object.assign(new Error('Schedule changed'),{code:'dispatch_revision_conflict',status:409});
      }
      commits.push(structuredClone(writes));
      for (const write of writes) {const key=write.collection+'/'+write.id;rows.set(key,{...rows.get(key),...structuredClone(write.patch),id:write.id,revision:'revision-'+(++revision)});}
    },
  };
  return {rows,roster,store,commits,gate:count=>{gateCount=count;gate=new Promise(resolve=>{release=resolve;});},
    create:(changes={})=>({action:'create',requestId:randomUUID(),changes:{date:'2026-09-23',allDay:true,reason:'Personal time',...changes}}),
    mutate:(input,actor=crew,now=NOW)=>mutateCrewAvailability(store,actor,input,now),
    assign:()=>mutateDispatch(store,manager,{action:'schedule.create',requestId:randomUUID(),customerId:'c1',kind:'job',changes:{date:'2026-09-23',time:'09:00',endTime:'11:00',assignedCrew:['crew.one']}},NOW),
  };
}
const cancel = record => ({action:'cancel',requestId:randomUUID(),id:record.id,expectedRevision:record.revision});

test('self availability writes canonical Hub record, receipt, revision and every occupied-day lock atomically',async()=>{
  const f=fixture(),input=f.create({endDate:'2026-09-25'}),result=await f.mutate(input);
  assert.equal(result.record.type,'availability');assert.equal(result.record.recordType,'crew_availability');assert.equal(result.record.employee,'crew.one');
  assert.equal(result.record.startAt,'2026-09-23T06:00:00.000Z');assert.equal(result.record.endAt,'2026-09-26T06:00:00.000Z');assert.equal(result.record.endTime,'23:59');
  assert.equal(result.record.canCancel,true);assert.equal(f.commits.length,1);assert.ok(f.rows.has('dispatchOperations/'+input.requestId));assert.ok(f.rows.has('dispatchState/revision'));
  for(const date of ['2026-09-23','2026-09-24','2026-09-25']){const lock=f.rows.get('jobs/_egc_schedule_lock_'+date);assert.deepEqual(lock.entries[0].assignedCrew,['crew.one']);assert.equal(lock.entries[0].end,'24:00');assert.equal(lock.entries[0].label,'Employee unavailable');}
  assert.equal(f.rows.has('jobs/_egc_schedule_lock_2026-09-26'),false);
});
test('active assigned jobs reject self time off while manager dispatch can handle exceptions explicitly',async()=>{
  const f=fixture();await f.assign();const before=f.commits.length;
  await assert.rejects(f.mutate(f.create()),error=>error.status===409 && error.code==='crew_availability_assignment_conflict' && error.details.conflicts.length===1);
  assert.equal(f.commits.length,before);
  const managerBlock=await mutateDispatch(f.store,manager,{action:'availability.save',requestId:randomUUID(),changes:{employeeId:'crew.one',date:'2026-09-23',allDay:true,reason:'Manager exception'}},NOW);
  assert.equal(managerBlock.warnings[0].code,'availability_conflicts');
});
test('concurrent manager assignment and self time off cannot both acquire the shared capacity',async()=>{
  const f=fixture();f.gate(2);
  const results=await Promise.allSettled([f.assign(),f.mutate(f.create())]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(f.commits.length,1);
  const failed=results.find(row=>row.status==='rejected');assert.equal(failed.reason.status,409);
});
test('day-lock versions also catch a legacy writer that did not touch dispatchState',async()=>{
  const f=fixture(),jobs=f.store.jobs;
  f.store.jobs=async()=>{const result=await jobs();f.rows.set('jobs/_egc_schedule_lock_2026-09-23',{id:'_egc_schedule_lock_2026-09-23',recordType:'schedule_lock',entries:[{id:'legacy-job'}],revision:'legacy-changed'});return result;};
  await assert.rejects(f.mutate(f.create()),error=>error.code==='dispatch_revision_conflict');assert.equal(f.commits.length,0);
});
test('saved manager resources and native blocks are checked without creating duplicate unavailable time',async()=>{
  for(const source of ['jobs','dispatchResources']){
    const f=fixture();f.rows.set(source+'/existing',{id:'existing',revision:'existing-1',...(source==='jobs'?{type:'availability',recordType:'crew_availability',employee:'Crew.One'}:{recordType:'availability',employeeId:'crew.one'}),date:'2026-09-23',allDay:true,status:'active'});
    await assert.rejects(f.mutate(f.create()),error=>error.code==='crew_availability_already_unavailable');assert.equal(f.commits.length,0);
    const rows=await crewAvailabilityOverview(f.store,crew,{startDate:'2026-09-23',endDate:'2026-09-24'});assert.equal(rows.availability[0].canCancel,source==='jobs');
  }
});
test('same request and lost commit response replay one block; changed payload and changed record do not',async()=>{
  const f=fixture(),input=f.create(),commit=f.store.commit;f.store.commit=async writes=>{await commit(writes);throw new Error('Lost response after commit');};
  const result=await f.mutate(input);assert.equal(result.replayed,true);assert.equal((await f.mutate(input)).record.id,result.record.id);assert.equal(f.commits.length,1);
  await assert.rejects(f.mutate({...input,changes:{...input.changes,reason:'Different'}}),error=>error.code==='crew_availability_idempotency_conflict');
  f.store.commit=commit;await f.mutate(cancel(result.record));await assert.rejects(f.mutate(input),error=>error.code==='crew_availability_changed_since_operation');
});
test('concurrent identical requests replay the immutable receipt without duplicate records',async()=>{
  const f=fixture(),input=f.create();f.gate(2);const results=await Promise.all([f.mutate(input),f.mutate(input)]);assert.equal(results[0].record.id,results[1].record.id);assert.equal(f.commits.length,1);
});
test('only exact active employee identity can cancel owned native availability',async()=>{
  const f=fixture(),result=await f.mutate(f.create()),request=cancel(result.record);
  for(const actor of [{user:'Crew-One',role:'crew'},{user:'unknown',displayName:'Crew One',role:'owner'},manager])await assert.rejects(f.mutate(request,actor),error=>error.status===403);
  await assert.rejects(f.mutate({...request,expectedRevision:'stale'}),error=>error.code==='crew_availability_revision_conflict');
  await assert.rejects(f.mutate({action:'cancel',requestId:randomUUID(),id:result.record.id}),error=>error.code==='crew_availability_revision_required');
  const cancelled=await f.mutate(request);assert.equal(cancelled.record.status,'cancelled');assert.equal(cancelled.record.cancelledBy,'crew.one');assert.equal(f.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries.length,0);
  assert.equal((await f.mutate(request)).replayed,true);assert.equal(cancelled.record.reason,'Personal time');await f.assign();
});
test('legacy alias ownership is unique and cannot borrow a punctuated account or duplicate display name',async()=>{
  const f=fixture();f.rows.set('jobs/legacy',{id:'legacy',revision:'legacy-r',type:'availability',recordType:'crew_availability',employee:'Crew One',date:'2026-09-23',allDay:true,status:'active'});
  let result=await crewAvailabilityOverview(f.store,crew,{startDate:'2026-09-23',endDate:'2026-09-24'});assert.equal(result.availability.length,1);
  f.roster.find(row=>row.id==='crew-one').name='Crew One';result=await crewAvailabilityOverview(f.store,crew,{startDate:'2026-09-23',endDate:'2026-09-24'});assert.equal(result.availability.length,0);
  await assert.rejects(f.mutate({action:'cancel',requestId:randomUUID(),id:'legacy',expectedRevision:'legacy-r'}),error=>error.status===403);
});
test('malformed or ambiguous Mountain times, unauthorized fields and past dates cannot save',async()=>{
  const invalid=[{date:'2026-02-30'},{date:'2026-03-08',allDay:false,time:'02:15',endTime:'04:00'},{date:'2026-11-01',allDay:false,time:'01:15',endTime:'03:00'},
    {allDay:false,time:'11:00',endTime:'09:00'},{allDay:false,time:'08:00',endTime:'24:00'},{allDay:'true'},{endDate:'2026-12-31'},{employee:'zacb'},{reason:{private:true}}];
  for(const changes of invalid){const f=fixture();await assert.rejects(f.mutate(f.create(changes),crew,'2026-01-01T12:00:00Z'),error=>error.status===400);assert.equal(f.commits.length,0);}
  const f=fixture();await assert.rejects(f.mutate(f.create({date:'2026-09-21'})),error=>error.code==='crew_availability_past_date');
});
test('full-day Denver blocks cover 23/25-hour DST dates and timed midnight releases final day',async()=>{
  for(const [date,hours] of [['2026-03-08',23],['2026-11-01',25]]){const f=fixture(),result=await f.mutate(f.create({date}),crew,'2026-01-01T12:00:00Z');assert.equal((Date.parse(result.record.endAt)-Date.parse(result.record.startAt))/3600000,hours);assert.equal(f.commits[0].filter(row=>row.id.startsWith('_egc_schedule_lock_')).length,1);}
  const f=fixture(),result=await f.mutate(f.create({date:'2026-09-23',endDate:'2026-09-24',allDay:false,time:'20:00',endTime:'00:00'}));assert.equal(result.record.endAt,'2026-09-24T06:00:00.000Z');assert.equal(f.rows.has('jobs/_egc_schedule_lock_2026-09-24'),false);
});
test('own range reads are inclusive/exclusive, redact arbitrary fields, and surface malformed-date exceptions',async()=>{
  const f=fixture();await f.mutate(f.create({endDate:'2026-09-25'}));
  f.rows.set('jobs/other',{id:'other',type:'availability',employee:'crew2',date:'2026-09-24',reason:'Private reason',allDay:true});
  f.rows.set('jobs/malformed',{id:'malformed',type:'availability',employee:'crew.one',date:'bad',reason:'Needs repair'});
  const raw=[...f.rows.values()].find(row=>row.recordType==='crew_availability');raw.costs={private:100};raw.payrollToken='secret';
  const result=await crewAvailabilityOverview(f.store,crew,{startDate:'2026-09-24',endDate:'2026-09-25'},new Date(NOW));assert.equal(result.availability.length,1);assert.equal(result.availability[0].costs,undefined);assert.equal(result.availability[0].payrollToken,undefined);assert.equal(result.exceptions[0].id,'malformed');
  assert.equal((await crewAvailabilityOverview(f.store,crew,{startDate:'2026-09-26',endDate:'2026-09-27'})).availability.length,0);
  await assert.rejects(crewAvailabilityOverview(f.store,crew,{startDate:'2026-09-23',endDate:'2027-01-01'}),error=>error.code==='crew_availability_invalid_range');
});
test('malformed assigned work cannot silently appear as available and corrupt day locks are preserved',async()=>{
  const f=fixture();f.rows.set('jobs/bad-job',{id:'bad-job',type:'job',date:'2026-09-23',time:'bad',endTime:'11:00',assignedCrew:[{username:'Crew.One',name:'Other'}],status:'scheduled'});
  await assert.rejects(f.mutate(f.create()),error=>error.details.conflicts[0].code==='invalid_assignment_time');
  const g=fixture();g.rows.set('jobs/_egc_schedule_lock_2026-09-23',{id:'_egc_schedule_lock_2026-09-23',recordType:'schedule_lock',entries:{invalid:true},revision:'lock-r'});
  await assert.rejects(g.mutate(g.create()),error=>error.status===503);assert.equal(g.commits.length,0);
});
test('HTTP API enforces signed account, same-origin JSON, bounded bodies and no-store responses',async()=>{
  const f=fixture();let actor=null;const handlers=crewAvailabilityHandlers({session:async()=>actor,storage:()=>f.store}),url='https://easygaragecleaning.com/api/crew-availability';
  const post=(body,headers={})=>handlers.post({env:{},request:new Request(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://easygaragecleaning.com',...headers},body:typeof body==='string'?body:JSON.stringify(body)})});
  assert.equal((await handlers.get({env:{},request:new Request(url)})).status,401);assert.equal((await post(f.create())).status,401);actor=crew;
  assert.equal((await post(f.create(),{Origin:'https://attacker.example'})).status,403);assert.equal((await post(f.create(),{'Sec-Fetch-Site':'cross-site'})).status,403);assert.equal((await post(f.create(),{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post('{')).status,400);assert.equal((await post(null)).status,400);assert.equal((await post('x'.repeat(9000))).status,413);
  const result=await post(f.create());assert.equal(result.status,200);assert.equal(result.headers.get('Cache-Control'),'no-store');assert.equal((await result.json()).record.employee,'crew.one');
});
