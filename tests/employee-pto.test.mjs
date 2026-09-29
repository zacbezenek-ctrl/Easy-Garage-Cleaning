import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutatePto, paidTimeOffHours, projectPtoRequest, ptoOverview, ptoVault } from '../functions/_lib/employee-pto.js';
import { cancelManagedAvailability, createManagedAvailability, crewAvailabilityOverview, mutateCrewAvailability, projectCrewAvailability } from '../functions/_lib/crew-availability.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { firestoreDoc, opaqueId, readCollection, seal } from '../functions/_lib/employee-vault.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { employeePtoHandlers } from '../functions/api/employee-pto.js';
import { onRequestPost as employeeHubPost } from '../functions/api/employee-hub.js';
import { computeTimesheetWeek, ptoFromRequests } from '../functions/_lib/timesheet-week.js';
import { matchesWhere } from './helpers/firestore-query.mjs';

const NOW = '2026-09-22T12:00:00.000Z';
const crew = {user:'Crew.One',displayName:'Crew One',role:'crew'};
const crewTwo = {user:'crew2',displayName:'Crew Two',role:'crew'};
const manager = {user:'zacb',displayName:'Owner',role:'owner',businessAccess:true};
const conflictError = () => Object.assign(new Error('Employee record changed while saving. Refresh and retry.'),{code:'EMPLOYEE_HUB_WRITE_CONFLICT'});

function fixture() {
  const rows = new Map([['customers/c1',{id:'c1',revision:'customer-1',name:'Synthetic Customer',phone:'9705550100'}]]), commits = [];
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
        // Sealed requests share the jobs collection, so a commit can verify one unchanged.
        const key=write.collection+'/'+write.id, current=write.verify && key.startsWith('jobs/secure_') ? {revision:f.vaultRevision(write.id)} : rows.get(key); assert.ok(!targets.has(key));targets.add(key);
        if (write.revision ? current?.revision !== write.revision : Boolean(current)) throw Object.assign(new Error('Schedule changed'),{code:'dispatch_revision_conflict',status:409});
      }
      commits.push(structuredClone(writes));
      for (const write of writes) if (!write.verify) {const key=write.collection+'/'+write.id;rows.set(key,{...rows.get(key),...structuredClone(write.patch),id:write.id,revision:'revision-'+(++revision)});}
    },
  };
  const records = new Map(), vaultWrites = [];
  let vaultRevision = 0;
  const vault = {
    readOnly:false,
    async read(id) { const row = records.get(id); return row ? {documentId:'secure_'+id,updateTime:row.updateTime,data:structuredClone(row.data)} : null; },
    async list() { return [...records.values()].map(row=>structuredClone(row.data)); },
    async write(id, data, expected, now) {
      const current = records.get(id);
      if (expected ? current?.updateTime !== expected.updateTime : current) throw conflictError();
      vaultWrites.push(structuredClone(data));
      records.set(id,{data:{...structuredClone(data),id,updatedAt:data.updatedAt || now},updateTime:'vault-'+(++vaultRevision)});
      return data;
    },
    guard:found=>({collection:'jobs',id:found.documentId,revision:found.updateTime,verify:true}),
  };
  const f = {rows,roster,store,commits,records,vault,vaultWrites,vaultRevision:id=>records.get(id.slice('secure_'.length))?.updateTime,gate:count=>{gateCount=count;gate=new Promise(resolve=>{release=resolve;});},
    seed:(data,updateTime='legacy-1')=>records.set(data.id,{data:structuredClone(data),updateTime}),
    request:(changes={},actor=crew,now=NOW)=>mutatePto(store,vault,actor,{action:'request',requestId:randomUUID(),type:'time_off',startDate:'2026-09-23',endDate:'2026-09-25',reason:'Family trip',paid:true,hoursPerDay:8,...changes},now),
    act:(action,id,extra={},actor=manager,now=NOW)=>mutatePto(store,vault,actor,{action,requestId:randomUUID(),id,...extra},now),
    send:(input,actor=manager,now=NOW)=>mutatePto(store,vault,actor,input,now),
    record:id=>structuredClone(records.get(id)?.data),
    blocks:()=>all('jobs').filter(row=>row.type==='availability'),
    lock:date=>rows.get('jobs/_egc_schedule_lock_'+date),
    assign:(changes={})=>mutateDispatch(store,manager,{action:'schedule.create',requestId:randomUUID(),customerId:'c1',kind:'job',changes:{date:'2026-09-23',time:'09:00',endTime:'11:00',assignedCrew:['crew.one'],...changes}},NOW),
  };
  return f;
}

test('crew requests store whitelisted time off with paid hours and decision history',async()=>{
  const f=fixture(),input={action:'request',requestId:randomUUID(),type:'time_off',startDate:'2026-09-23',endDate:'2026-09-25',reason:' Family trip ',paid:true,hoursPerDay:7.5};
  const result=await f.send(input,crew);
  assert.equal(result.request.id,'pto_'+input.requestId.replaceAll('-',''));assert.equal(result.request.status,'pending');assert.equal(result.request.employee,'crew.one');
  assert.equal(result.request.paidHours,22.5);assert.deepEqual(result.request.paidDays.map(day=>day.date),['2026-09-23','2026-09-24','2026-09-25']);assert.equal(result.request.decisions[0].action,'request');
  assert.equal(result.request.decisions[0].fingerprint,undefined);
  const saved=f.record(result.request.id);
  assert.deepEqual(Object.keys(saved).sort(),['availabilityIds','createdAt','createdBy','decisions','employee','employeeName','endDate','hoursPerDay','id','paid','paidHours','reason','requestId','reviewedAt','reviewedBy','startDate','status','type','updatedAt']);
  assert.equal(saved.reason,'Family trip');assert.equal(saved.createdAt,NOW);assert.equal(saved.decisions[0].by,'crew.one');assert.equal(f.commits.length,0);
  const again=await f.send(input,crew);assert.equal(again.replayed,true);assert.equal(f.vaultWrites.length,1);
  await assert.rejects(f.send({...input,reason:'Different'},crew),error=>error.code==='pto_idempotency_conflict'&&error.status===409);
  await assert.rejects(f.request({startDate:'2026-09-25',endDate:'2026-09-26'}),error=>error.code==='pto_overlap'&&error.status===409);
  const shift=await f.request({type:'shift_change',paid:undefined,hoursPerDay:undefined,startDate:'2026-09-24',endDate:'2026-09-24'});assert.equal(shift.request.paid,false);assert.equal(f.record(shift.request.id).paid,undefined);
  const unpaid=await f.request({startDate:'2026-10-05',endDate:'2026-10-05',paid:false,hoursPerDay:undefined});assert.equal(unpaid.request.paidHours,0);
  const invalid=[{employee:'crew2'},{status:'approved'},{type:'vacation'},{paid:'yes'},{hoursPerDay:0},{hoursPerDay:13},{hoursPerDay:7.3},{paid:false,hoursPerDay:8},{type:'shift_change'},
    {startDate:'2026-02-30',endDate:'2026-03-01'},{startDate:'2026-09-25',endDate:'2026-09-23'},{startDate:'2026-11-01',endDate:'2026-12-02'},{startDate:'2026-09-01',endDate:'2026-09-01'},{startDate:'2027-10-01',endDate:'2027-10-01'},{reason:'x'.repeat(501)}];
  for (const changes of invalid) await assert.rejects(f.request({startDate:'2026-10-20',endDate:'2026-10-20',...changes}),error=>error.status===400,JSON.stringify(changes));
  const sick=await f.request({startDate:'2026-09-10',endDate:'2026-09-10'});assert.equal(sick.request.status,'pending');
  await assert.rejects(f.request({},{user:'unknown',displayName:'Crew One',role:'crew'}),error=>error.code==='pto_employee_inactive'&&error.status===403);
  await assert.rejects(f.send({action:'request',requestId:'not-a-uuid',type:'time_off',startDate:'2026-10-20',endDate:'2026-10-20'},crew),error=>error.code==='pto_invalid_request');
  await assert.rejects(mutatePto(f.store,f.vault,null,input,NOW),error=>error.status===401);
});

test('manager approval creates one linked all-day block through the lock, revision and receipt contract before marking approved',async()=>{
  const f=fixture(),{request}=await f.request(),approval=await f.act('approve',request.id,{note:'Enjoy'});
  const saved=f.record(request.id),[block]=f.blocks();
  assert.equal(approval.request.status,'approved');assert.equal(saved.reviewedBy,'zacb');assert.equal(saved.reviewedAt,NOW);assert.deepEqual(saved.availabilityIds,[block.id]);assert.match(block.id,/^pto_block_[a-f0-9]{40}$/);
  assert.equal(block.type,'availability');assert.equal(block.recordType,'crew_availability');assert.equal(block.employee,'crew.one');assert.equal(block.allDay,true);assert.equal(block.date,'2026-09-23');assert.equal(block.endDate,'2026-09-25');
  assert.equal(block.sourceRequestId,request.id);assert.equal(block.dispatchRequestId,saved.decisions[1].requestId);assert.equal(block.createdBy,'zacb');assert.equal(block.reason,'Approved time off');assert.equal(block.startAt,'2026-09-23T06:00:00.000Z');assert.equal(block.endAt,'2026-09-26T06:00:00.000Z');
  assert.equal(f.commits.length,1);assert.ok(f.rows.has('dispatchState/revision'));
  const receipt=f.rows.get('dispatchOperations/'+saved.decisions[1].requestId);assert.equal(receipt.scope,'crew_availability_managed');assert.equal(receipt.actorId,'zacb');assert.equal(receipt.employeeId,'crew.one');assert.equal(receipt.targetId,block.id);
  for(const date of ['2026-09-23','2026-09-24','2026-09-25']){const entry=f.lock(date).entries[0];assert.equal(entry.id,block.id);assert.deepEqual(entry.assignedCrew,['crew.one']);assert.equal(entry.start,'00:00');assert.equal(entry.end,'24:00');}
  assert.equal(f.rows.has('jobs/_egc_schedule_lock_2026-09-26'),false);
  assert.deepEqual(saved.decisions.map(entry=>entry.action),['request','approve']);assert.equal(saved.decisions[1].note,'Enjoy');assert.equal(saved.decisions[1].paid,true);
  const calendar=await crewAvailabilityOverview(f.store,crew,{startDate:'2026-09-23',endDate:'2026-09-26'},new Date(NOW));assert.equal(calendar.availability[0].canCancel,false);
  // Production calendar scans mask fields; the block id alone marks request-owned time.
  assert.equal(projectCrewAvailability({id:block.id,type:'availability',employee:'crew.one',date:'2026-09-23',allDay:true,status:'active'}).canCancel,false);
  assert.equal(projectCrewAvailability({id:'availability_1',type:'availability',employee:'crew.one',date:'2026-09-23',allDay:true,status:'active'}).canCancel,true);
  await assert.rejects(mutateCrewAvailability(f.store,crew,{action:'cancel',requestId:randomUUID(),id:block.id,expectedRevision:block.revision},NOW),error=>error.code==='crew_availability_request_linked'&&error.status===409);
  await assert.rejects(f.assign({date:'2026-09-24'}),error=>error.code==='dispatch_conflict'&&error.details.conflicts.some(row=>row.code==='employee_unavailable'&&row.availabilityId===block.id));
  const shift=await f.request({type:'shift_change',paid:undefined,hoursPerDay:undefined,startDate:'2026-10-02',endDate:'2026-10-02'}),shiftApproval=await f.act('approve',shift.request.id);
  assert.equal(shiftApproval.request.status,'approved');assert.equal(f.commits.length,1);
  await assert.rejects(f.act('approve',shift.request.id),error=>error.code==='pto_not_pending'&&error.status===409);
  const swap=await f.request({type:'shift_change',paid:undefined,hoursPerDay:undefined,startDate:'2026-10-03',endDate:'2026-10-03'});
  for(const extra of [{paid:true},{hoursPerDay:8},{acknowledgeConflicts:true}])await assert.rejects(f.act('approve',swap.request.id,extra),error=>error.code==='pto_invalid_request');
  await assert.rejects(f.act('approve',request.id,{paid:'yes'}),error=>error.code==='pto_not_pending');
  const other=await f.request({startDate:'2026-10-12',endDate:'2026-10-12'});
  for(const extra of [{paid:'yes'},{acknowledgeConflicts:'true'},{hoursPerDay:13},{paid:false,hoursPerDay:8},{note:'x'.repeat(501)},{employee:'crew2'}])await assert.rejects(f.act('approve',other.request.id,extra),error=>error.status===400,JSON.stringify(extra));
  assert.equal(f.record(other.request.id).status,'pending');assert.equal(f.commits.length,1);
});

test('approval over assigned work returns 409 with job details and creates nothing until the manager acknowledges it',async()=>{
  const f=fixture(),job=(await f.assign()).job,{request}=await f.request(),before=f.commits.length;
  await assert.rejects(f.act('approve',request.id),error=>{
    assert.equal(error.status,409);assert.equal(error.code,'crew_availability_assignment_conflict');assert.equal(error.details.acknowledgeable,true);
    assert.deepEqual(error.details.conflicts.map(row=>[row.code,row.jobId,row.date,row.time,row.label]),[['assigned_job',job.id,'2026-09-23','09:00','Synthetic Customer']]);return true;});
  assert.equal(f.commits.length,before);assert.equal(f.blocks().length,0);assert.equal(f.record(request.id).status,'pending');assert.equal(f.record(request.id).decisions.length,1);
  const approval=await f.act('approve',request.id,{acknowledgeConflicts:true});
  assert.equal(approval.warnings[0].code,'availability_conflicts');assert.equal(approval.warnings[0].conflicts[0].jobId,job.id);assert.equal(f.blocks().length,1);
  assert.deepEqual(f.record(request.id).decisions[1].warnings,[{code:'availability_conflicts',message:'Time off was approved over assigned work. Reassign these jobs before dispatch.',jobIds:[job.id]}]);
  // An approval that reuses a block an interrupted approval created keeps the warnings that block was approved with.
  const m=fixture(),reassign=(await m.assign()).job,open=(await m.request()).request,vaultWrite=m.vault.write;
  m.vault.write=async()=>{throw new Error('Firestore unavailable');};
  await assert.rejects(m.act('approve',open.id,{acknowledgeConflicts:true}),error=>error.code==='pto_outcome_unknown');
  m.vault.write=vaultWrite;
  const reused=await m.act('approve',open.id,{},{...manager,user:'tylerg'});
  assert.equal(reused.warnings[0].code,'availability_conflicts');assert.equal(reused.warnings[0].conflicts[0].jobId,reassign.id);assert.equal(m.blocks().length,1);
  assert.deepEqual(m.record(open.id).decisions[1].warnings,[{code:'availability_conflicts',message:'Time off was approved over assigned work. Reassign these jobs before dispatch.',jobIds:[reassign.id]}]);
  // A company-wide block is not the employee's assigned work.
  const g=fixture();await mutateDispatch(g.store,manager,{action:'schedule.create',requestId:randomUUID(),kind:'blocked',changes:{date:'2026-09-24',time:'08:00',endTime:'12:00'}},NOW);
  const other=await g.request();assert.equal((await g.act('approve',other.request.id)).warnings.length,0);
});

test('lost responses and a partial failure replay the same approval without duplicate blocks',async()=>{
  const f=fixture(),{request}=await f.request(),input={action:'approve',requestId:randomUUID(),id:request.id},commit=f.store.commit;
  f.store.commit=async writes=>{await commit(writes);throw new Error('Lost response after commit');};
  const first=await f.send(input);assert.equal(first.request.status,'approved');f.store.commit=commit;
  const again=await f.send(input);assert.equal(again.replayed,true);assert.equal(f.blocks().length,1);assert.equal(f.commits.length,1);
  await assert.rejects(f.send({...input,note:'Changed'}),error=>error.code==='pto_idempotency_conflict');

  const g=fixture(),pending=(await g.request()).request,retry={action:'approve',requestId:randomUUID(),id:pending.id},write=g.vault.write;
  g.vault.write=async()=>{throw new Error('Firestore unavailable');};
  await assert.rejects(g.send(retry),error=>error.code==='pto_outcome_unknown'&&error.status===503);
  assert.equal(g.record(pending.id).status,'pending');assert.equal(g.blocks().length,1);assert.equal(g.commits.length,1);
  g.vault.write=write;
  // The block is bound to the whole approval: the same request ID with other terms is refused, not recorded.
  assert.equal(g.rows.get('dispatchOperations/'+retry.requestId).sourceFingerprint.length,64);
  for(const changes of [{note:'Changed'},{paid:false},{hoursPerDay:4},{paidDates:['2026-09-23']},{acknowledgeConflicts:true}])
    await assert.rejects(g.send({...retry,...changes}),error=>error.code==='pto_idempotency_conflict'&&error.status===409,JSON.stringify(changes));
  assert.equal(g.record(pending.id).status,'pending');assert.equal(g.record(pending.id).decisions.length,1);assert.equal(g.blocks().length,1);assert.equal(g.commits.length,1);
  const replay=await g.send(retry);assert.equal(replay.request.status,'approved');assert.equal(g.blocks().length,1);assert.equal(g.commits.length,1);
  assert.deepEqual(g.record(pending.id).availabilityIds,[g.blocks()[0].id]);

  const h=fixture(),saved=(await h.request()).request,lost={action:'approve',requestId:randomUUID(),id:saved.id},vaultWrite=h.vault.write;
  h.vault.write=async(...args)=>{await vaultWrite(...args);throw new Error('Lost vault response');};
  assert.equal((await h.send(lost)).request.status,'approved');h.vault.write=vaultWrite;assert.equal((await h.send(lost)).replayed,true);assert.equal(h.blocks().length,1);

  const k=fixture(),same=(await k.request()).request,twice={action:'approve',requestId:randomUUID(),id:same.id};k.gate(2);
  const results=await Promise.all([k.send(twice),k.send(twice)]);assert.deepEqual(results.map(row=>row.request.status),['approved','approved']);assert.equal(k.blocks().length,1);assert.equal(k.commits.length,1);
});

test('crew cannot approve, deny or end requests, and cannot change another employee request',async()=>{
  const f=fixture(),{request}=await f.request(),writes=f.vaultWrites.length;
  for(const actor of [crew,crewTwo,{user:'tylerg',displayName:'Business Crew',role:'crew',businessAccess:true},{user:'crew2',role:'manager'}])
    for(const action of ['approve','deny','end']) await assert.rejects(f.act(action,request.id,action==='end'?{endedEarlyFrom:'2026-09-24'}:{},actor),error=>error.code==='pto_forbidden'&&error.status===403);
  await assert.rejects(f.act('cancel',request.id,{},crewTwo),error=>error.code==='pto_forbidden'&&error.status===403);
  await assert.rejects(createManagedAvailability(f.store,crew,'crew.one',{requestId:randomUUID(),date:'2026-09-23',allDay:true},NOW),error=>error.code==='dispatch_forbidden');
  assert.equal(f.vaultWrites.length,writes);assert.equal(f.commits.length,0);assert.equal(f.record(request.id).status,'pending');
  await assert.rejects(f.act('approve','missing-request'),error=>error.code==='pto_not_found'&&error.status===404);
  f.seed({id:'incident-1',type:'incident',employee:'Crew.One',status:'open'});await assert.rejects(f.act('approve','incident-1'),error=>error.code==='pto_unsupported_request');
});

test('denied requests create no blocks, keep their history and replay idempotently',async()=>{
  const f=fixture(),{request}=await f.request(),input={action:'deny',requestId:randomUUID(),id:request.id,note:'Short staffed that week'};
  const denied=await f.send(input);
  assert.equal(denied.request.status,'denied');assert.equal(f.blocks().length,0);assert.equal([...f.rows.keys()].some(key=>key.includes('_egc_schedule_lock_')),false);assert.equal(f.commits.length,0);
  const saved=f.record(request.id);assert.equal(saved.reviewedBy,'zacb');assert.deepEqual(saved.decisions.map(entry=>[entry.action,entry.status]),[['request','pending'],['deny','denied']]);assert.equal(saved.decisions[1].note,'Short staffed that week');
  assert.equal((await f.send(input)).replayed,true);assert.equal(f.blocks().length,0);
  await assert.rejects(f.act('approve',request.id),error=>error.code==='pto_not_pending'&&error.status===409);
  await assert.rejects(f.act('cancel',request.id,{},crew),error=>error.code==='pto_not_pending');
  assert.equal(f.blocks().length,0);assert.equal(f.record(request.id).status,'denied');
});

test('cancelling approved time off releases its block and day locks; crew may cancel only before it starts',async()=>{
  const f=fixture(),{request}=await f.request();await f.act('approve',request.id);
  const input={action:'cancel',requestId:randomUUID(),id:request.id,note:'Plans changed'},cancelled=await f.send(input,crew),[block]=f.blocks();
  assert.equal(cancelled.request.status,'cancelled');assert.equal(block.status,'cancelled');assert.equal(block.cancelledBy,'crew.one');assert.equal(block.dispatchRequestId,input.requestId);
  for(const date of ['2026-09-23','2026-09-24','2026-09-25'])assert.deepEqual(f.lock(date).entries,[]);
  const saved=f.record(request.id);assert.equal(saved.cancelledBy,'crew.one');assert.deepEqual(saved.decisions.at(-1).releaseIds,[block.id]);
  assert.equal(f.rows.get('dispatchOperations/'+input.requestId).scope,'crew_availability_managed_release');
  assert.equal((await f.send(input,crew)).replayed,true);assert.equal(f.commits.length,2);
  await f.assign({date:'2026-09-24'});

  // Time off has started on its first day: nobody cancels it then. A manager ends it early, back that day, which
  // releases it and keeps it on the record with no paid hours; before it starts it keeps at least its first day.
  const g=fixture(),started=(await g.request()).request,DAY1='2026-09-23T18:00:00.000Z';await g.act('approve',started.id);
  await assert.rejects(g.act('end',started.id,{endedEarlyFrom:'2026-09-23'}),error=>error.code==='pto_invalid_dates'&&error.status===400);
  await assert.rejects(g.act('cancel',started.id,{},crew,DAY1),error=>error.code==='pto_started'&&error.status===409);
  await assert.rejects(g.act('cancel',started.id,{},manager,DAY1),error=>error.code==='pto_started'&&error.status===409);
  await assert.rejects(g.act('end',started.id,{endedEarlyFrom:'2026-09-22'},manager,DAY1),error=>error.code==='pto_invalid_dates');
  const backToday=await g.act('end',started.id,{endedEarlyFrom:'2026-09-23'},manager,DAY1);
  assert.equal(backToday.request.status,'approved');assert.equal(backToday.request.endedEarlyFrom,'2026-09-23');assert.equal(backToday.request.paidHours,0);assert.deepEqual(backToday.request.paidDays,[]);
  assert.equal(g.blocks()[0].status,'cancelled');for(const date of ['2026-09-23','2026-09-24','2026-09-25'])assert.deepEqual(g.lock(date).entries,[]);
  await assert.rejects(g.act('end',started.id,{endedEarlyFrom:'2026-09-24'},manager,DAY1),error=>error.code==='pto_ended');
  assert.equal((await ptoOverview(g.store,g.vault,manager,{startDate:'2026-09-21',endDate:'2026-09-28'},new Date(DAY1))).paidTimeOff.days.length,0);
  const pending=(await g.request({startDate:'2026-10-05',endDate:'2026-10-05'})).request;
  assert.equal((await g.act('cancel',pending.id,{},crew)).request.status,'cancelled');assert.equal(g.blocks().length,1);
  const shift=(await g.request({type:'shift_change',paid:undefined,hoursPerDay:undefined,startDate:'2026-10-09',endDate:'2026-10-09'})).request;await g.act('approve',shift.id);
  await assert.rejects(g.act('cancel',shift.id,{},crew),error=>error.code==='pto_started');
});

test('a release that fails after the cancellation is recorded finishes on replay of the same request',async()=>{
  const f=fixture(),{request}=await f.request();await f.act('approve',request.id);
  const input={action:'cancel',requestId:randomUUID(),id:request.id},commit=f.store.commit;
  f.store.commit=async()=>{throw Object.assign(new Error('Schedule changed'),{code:'dispatch_revision_conflict',status:409});};
  await assert.rejects(f.send(input),error=>error.code==='pto_release_incomplete'&&error.status===503);
  assert.equal(f.record(request.id).status,'cancelled');assert.equal(f.blocks()[0].status,'active');
  f.store.commit=commit;
  const replay=await f.send(input);assert.equal(replay.replayed,true);assert.equal(f.blocks()[0].status,'cancelled');assert.deepEqual(f.lock('2026-09-24').entries,[]);
});

test('a deny racing an approval never leaves the approval block active',async()=>{
  // Deny recorded between the approval's block commit and its request write.
  const f=fixture(),{request}=await f.request(),write=f.vault.write;
  f.vault.write=async(id,data,...rest)=>{if(data.status==='approved'){f.vault.write=write;await f.act('deny',request.id,{},{...manager,user:'tylerg'});}return write(id,data,...rest);};
  await assert.rejects(f.act('approve',request.id),error=>error.code==='pto_not_pending'&&error.details.status==='denied');
  assert.equal(f.record(request.id).status,'denied');assert.deepEqual(f.blocks().map(row=>row.status),['cancelled']);assert.deepEqual(f.lock('2026-09-23').entries,[]);
  // Deny recorded (and its release found nothing) before the approval's block commit: that commit verifies the
  // request unchanged since it was read, so no block is created and nothing is left for anyone to release.
  const g=fixture(),pending=(await g.request()).request,commit=g.store.commit;
  g.store.commit=async writes=>{g.store.commit=commit;await g.act('deny',pending.id,{},{...manager,user:'tylerg'});return commit(writes);};
  await assert.rejects(g.act('approve',pending.id),error=>error.code==='pto_not_pending'&&error.details.status==='denied');
  assert.equal(g.record(pending.id).status,'denied');assert.deepEqual(g.blocks(),[]);assert.equal(g.lock('2026-09-24'),undefined);
  assert.ok(g.commits.every(writes=>!writes.some(write=>write.id.startsWith('pto_block_'))));
  // The fence is part of the block commit, verify-only.
  const v=fixture(),fenced=(await v.request()).request;await v.act('approve',fenced.id);
  assert.deepEqual(v.commits[0].filter(write=>write.verify),[{collection:'jobs',id:'secure_'+fenced.id,revision:'vault-1',verify:true}]);
  // A request rewritten but still pending is a conflict to review; a schedule conflict alone keeps its own error.
  const w=fixture(),rewritten=(await w.request()).request,wCommit=w.store.commit;
  w.store.commit=async writes=>{w.store.commit=wCommit;w.seed(w.record(rewritten.id),'vault-rewritten');return wCommit(writes);};
  await assert.rejects(w.act('approve',rewritten.id),error=>error.code==='pto_revision_conflict'&&error.status===409);
  w.store.commit=async()=>{throw Object.assign(new Error('Schedule changed'),{code:'dispatch_revision_conflict',status:409});};
  await assert.rejects(w.act('approve',rewritten.id),error=>error.code==='dispatch_revision_conflict');
  w.store.commit=wCommit;assert.equal(w.record(rewritten.id).status,'pending');assert.deepEqual(w.blocks(),[]);
  // Two managers approving at once share the one block.
  const h=fixture(),both=(await h.request()).request,vaultWrite=h.vault.write;
  h.vault.write=async(id,data,...rest)=>{if(data.status==='approved'){h.vault.write=vaultWrite;await h.act('approve',both.id,{},{...manager,user:'tylerg'});}return vaultWrite(id,data,...rest);};
  await assert.rejects(h.act('approve',both.id),error=>error.code==='pto_not_pending'&&error.details.status==='approved');
  assert.deepEqual(h.blocks().map(row=>row.status),['active']);assert.equal(h.record(both.id).reviewedBy,'tylerg');assert.deepEqual(h.record(both.id).availabilityIds,[h.blocks()[0].id]);
});

test('legacy requests stay readable, approve with computed defaults, and cancel their browser-era per-day blocks',async()=>{
  const f=fixture();
  f.seed({id:'request-crewone-lx1',type:'time_off',employee:'Crew.One',startDate:'2026-09-23',endDate:'2026-09-24',reason:'Legacy trip',status:'pending',reviewedBy:'',reviewedAt:'',createdAt:'2026-09-20T10:00:00.000Z'});
  const legacy=projectPtoRequest(f.record('request-crewone-lx1'));
  assert.equal(legacy.paid,false);assert.equal(legacy.paidHours,0);assert.equal(legacy.hoursPerDay,null);assert.equal(legacy.legacy,true);assert.deepEqual(legacy.decisions,[]);
  assert.deepEqual((await ptoOverview(f.store,f.vault,crew,{},new Date(NOW))).requests.map(row=>row.id),['request-crewone-lx1']);
  await assert.rejects(f.request({startDate:'2026-09-24',endDate:'2026-09-24'}),error=>error.code==='pto_overlap');
  const approved=await f.act('approve','request-crewone-lx1',{paid:true,hoursPerDay:8});
  assert.equal(approved.request.paidHours,16);assert.equal(f.record('request-crewone-lx1').reason,'Legacy trip');assert.deepEqual(f.record('request-crewone-lx1').decisions.map(entry=>entry.action),['approve']);

  f.seed({id:'request-crewone-old',type:'time_off',employee:'Crew.One',startDate:'2026-09-28',endDate:'2026-09-29',reason:'Old approval',status:'approved',reviewedBy:'zacb',reviewedAt:'2026-09-15T10:00:00.000Z'});
  for(const [date,owner] of [['2026-09-28','request-crewone-old'],['2026-09-29','request-crewone-old'],['2026-09-30','request-crewone-other']])
    f.rows.set(`jobs/availability-crewone-${date}-pto`,{id:`availability-crewone-${date}-pto`,revision:'legacy-'+date,type:'availability',recordType:'crew_availability',employee:'Crew.One',date,time:'00:00',endTime:'23:59',reason:'Approved time off',requestId:owner,status:'active'});
  const calendar=await crewAvailabilityOverview(f.store,crew,{startDate:'2026-09-28',endDate:'2026-10-01'},new Date(NOW));assert.deepEqual(calendar.availability.map(row=>row.canCancel),[false,false,false]);
  const cancelled=await f.act('cancel','request-crewone-old',{},crew);
  assert.equal(cancelled.request.status,'cancelled');
  assert.deepEqual(['2026-09-28','2026-09-29','2026-09-30'].map(date=>f.rows.get(`jobs/availability-crewone-${date}-pto`).status),['cancelled','cancelled','active']);
  // A started browser-era approval ends early: earlier per-day blocks stay, later ones are released.
  f.seed({id:'request-crewone-week',type:'time_off',employee:'Crew.One',startDate:'2026-10-05',endDate:'2026-10-07',reason:'Old week',status:'approved',reviewedBy:'zacb'});
  for(const date of ['2026-10-05','2026-10-06','2026-10-07'])
    f.rows.set(`jobs/availability-crewone-${date}-pto`,{id:`availability-crewone-${date}-pto`,revision:'legacy-'+date,type:'availability',recordType:'crew_availability',employee:'Crew.One',date,time:'00:00',endTime:'23:59',reason:'Approved time off',requestId:'request-crewone-week',status:'active'});
  const ended=await f.act('end','request-crewone-week',{endedEarlyFrom:'2026-10-06'},manager,'2026-10-05T18:00:00.000Z');
  assert.equal(ended.request.status,'approved');assert.equal(ended.request.endedEarlyFrom,'2026-10-06');assert.equal(ended.request.paidHours,0);
  assert.deepEqual(['2026-10-05','2026-10-06','2026-10-07'].map(date=>f.rows.get(`jobs/availability-crewone-${date}-pto`).status),['active','cancelled','cancelled']);
  assert.deepEqual(f.record('request-crewone-week').decisions.map(entry=>[entry.action,entry.endedEarlyFrom]),[['end','2026-10-06']]);
  f.seed({id:'request-crewone-bad',type:'time_off',employee:'Crew.One',startDate:'soon',status:'approved'});
  await assert.rejects(f.act('cancel','request-crewone-bad'),error=>error.code==='pto_legacy_review'&&error.status===409);
  await assert.rejects(f.act('end','request-crewone-bad',{endedEarlyFrom:'2026-09-23'}),error=>error.code==='pto_legacy_review'&&error.status===409);
  f.seed({id:'request-crewone-shift',type:'shift_change',employee:'Crew.One',startDate:'2026-10-01',endDate:'2026-10-01',reason:'Swap',status:'pending'});
  assert.equal((await f.act('deny','request-crewone-shift')).request.status,'denied');
});

test('a browser-era approval that ends early keeps releasing its per-day blocks when it ends again or is cancelled',async()=>{
  const legacyWeek=(f,id,days)=>{
    f.seed({id,type:'time_off',employee:'Crew.One',startDate:days[0],endDate:days.at(-1),reason:'Old week',status:'approved',reviewedBy:'zacb'});
    for(const date of days){
      const block=`availability-crewone-${date}-pto`;
      f.rows.set('jobs/'+block,{id:block,revision:'legacy-'+date,type:'availability',recordType:'crew_availability',employee:'Crew.One',date,time:'00:00',endTime:'23:59',reason:'Approved time off',requestId:id,status:'active'});
      f.rows.set('jobs/_egc_schedule_lock_'+date,{id:'_egc_schedule_lock_'+date,revision:'lock-'+date,recordType:'schedule_lock',date,entries:[{id:block,type:'availability',start:'00:00',end:'24:00',label:'Employee unavailable',status:'active',assignedCrew:['crew.one']}]});
    }
  };
  const days=['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09'],DAY1='2026-10-05T18:00:00.000Z',DAY2='2026-10-06T18:00:00.000Z';
  const state=f=>days.map(date=>[f.rows.get(`jobs/availability-crewone-${date}-pto`).status,f.lock(date).entries.map(entry=>entry.id).join()]);
  const held=date=>['active',`availability-crewone-${date}-pto`],freed=['cancelled',''];
  // Ended early twice: each first day back releases its newly freed days and their lock entries.
  const f=fixture();legacyWeek(f,'request-crewone-week',days);
  await f.act('end','request-crewone-week',{endedEarlyFrom:'2026-10-08'},manager,DAY1);
  assert.deepEqual(state(f),[held('2026-10-05'),held('2026-10-06'),held('2026-10-07'),freed,freed]);
  const input={action:'end',requestId:randomUUID(),id:'request-crewone-week',endedEarlyFrom:'2026-10-07'},again=await f.send(input,manager,DAY2);
  assert.equal(again.request.endedEarlyFrom,'2026-10-07');assert.deepEqual(state(f),[held('2026-10-05'),held('2026-10-06'),freed,freed,freed]);
  assert.equal(f.rows.get('jobs/availability-crewone-2026-10-07-pto').dispatchRequestId,input.requestId);
  assert.deepEqual(f.record('request-crewone-week').decisions.at(-1).releaseIds.toSorted(),days.map(date=>`availability-crewone-${date}-pto`));
  assert.equal((await f.send(input,manager,DAY2)).replayed,true);assert.deepEqual(state(f),[held('2026-10-05'),held('2026-10-06'),freed,freed,freed]);
  // Shortened before it starts, then cancelled by the employee: the days it still held are released too.
  const g=fixture();legacyWeek(g,'request-crewone-trip',days);
  await g.act('end','request-crewone-trip',{endedEarlyFrom:'2026-10-07'});
  assert.deepEqual(state(g),[held('2026-10-05'),held('2026-10-06'),freed,freed,freed]);
  assert.equal((await g.act('cancel','request-crewone-trip',{},crew)).request.status,'cancelled');
  assert.deepEqual(state(g),[freed,freed,freed,freed,freed]);assert.equal(g.rows.get('jobs/availability-crewone-2026-10-05-pto').cancelledBy,'crew.one');
});

test('a manager ends started time off early: taken days keep their block and paid hours, the rest is released',async()=>{
  const f=fixture(),{request}=await f.request();await f.act('approve',request.id);
  const DAY2='2026-09-24T18:00:00.000Z',LATER='2026-09-26T18:00:00.000Z';
  await assert.rejects(f.act('cancel',request.id,{},manager,DAY2),error=>error.code==='pto_started'&&error.status===409);
  await assert.rejects(f.act('cancel',request.id,{},crew,DAY2),error=>error.code==='pto_started'&&error.status===409);
  for(const endedEarlyFrom of ['2026-09-23','2026-09-26','2026-09-22','soon',undefined])
    await assert.rejects(f.act('end',request.id,endedEarlyFrom===undefined?{}:{endedEarlyFrom},manager,DAY2),error=>error.code==='pto_invalid_dates'&&error.status===400,String(endedEarlyFrom));
  const commits=f.commits.length,input={action:'end',requestId:randomUUID(),id:request.id,endedEarlyFrom:'2026-09-25',note:'Back Friday'};
  const ended=await f.send(input,manager,DAY2),[block]=f.blocks(),saved=f.record(request.id);
  assert.equal(ended.request.status,'approved');assert.equal(ended.request.endedEarlyFrom,'2026-09-25');assert.equal(ended.request.paidHours,16);
  assert.deepEqual(ended.request.paidDays,[{date:'2026-09-23',hours:8},{date:'2026-09-24',hours:8}]);
  assert.equal(block.status,'active');assert.equal(block.date,'2026-09-23');assert.equal(block.endDate,'2026-09-24');assert.equal(block.endAt,'2026-09-25T06:00:00.000Z');assert.equal(block.dispatchRequestId,input.requestId);
  assert.equal(f.lock('2026-09-23').entries[0].id,block.id);assert.equal(f.lock('2026-09-24').entries[0].id,block.id);assert.deepEqual(f.lock('2026-09-25').entries,[]);
  assert.equal(saved.paidHours,16);assert.equal(saved.endedEarlyBy,'zacb');assert.equal(saved.endedEarlyAt,DAY2);
  assert.deepEqual({...saved.decisions.at(-1),fingerprint:undefined},{action:'end',status:'approved',by:'zacb',at:DAY2,requestId:input.requestId,fingerprint:undefined,note:'Back Friday',endedEarlyFrom:'2026-09-25',releaseIds:[block.id]});
  const receipt=f.rows.get('dispatchOperations/'+input.requestId);assert.equal(receipt.action,'availability.managed.end');assert.equal(receipt.after[0].endDate,'2026-09-24');
  assert.equal(f.commits.length,commits+1);assert.equal((await f.send(input,manager,DAY2)).replayed,true);assert.equal(f.commits.length,commits+1);
  await assert.rejects(f.send({...input,endedEarlyFrom:'2026-09-24'},manager,DAY2),error=>error.code==='pto_idempotency_conflict');
  // The released day takes work again; the days taken still block it.
  await f.assign({date:'2026-09-25'});
  await assert.rejects(f.assign({date:'2026-09-24'}),error=>error.code==='dispatch_conflict');
  const week=await ptoOverview(f.store,f.vault,manager,{startDate:'2026-09-21',endDate:'2026-09-28'},new Date(DAY2));
  assert.deepEqual(week.paidTimeOff.totals,[{employee:'crew.one',hours:16}]);
  // A later first day back cannot undo the early end; an earlier one shortens it again.
  await assert.rejects(f.act('end',request.id,{endedEarlyFrom:'2026-09-25'},manager,DAY2),error=>error.code==='pto_invalid_dates');
  const again=await f.act('end',request.id,{endedEarlyFrom:'2026-09-24'},manager,DAY2);
  assert.equal(again.request.paidHours,8);assert.equal(f.blocks()[0].endDate,'2026-09-23');assert.deepEqual(f.lock('2026-09-24').entries,[]);
  // Time off that is over stays on the record.
  await assert.rejects(f.act('end',request.id,{endedEarlyFrom:'2026-09-26'},manager,LATER),error=>error.code==='pto_ended'&&error.status===409);
  await assert.rejects(f.act('cancel',request.id,{},manager,LATER),error=>error.code==='pto_started');
  const pending=(await f.request({startDate:'2026-10-05',endDate:'2026-10-06'})).request;
  await assert.rejects(f.act('end',pending.id,{endedEarlyFrom:'2026-10-06'}),error=>error.code==='pto_not_approved'&&error.status===409);
  assert.equal(f.record(pending.id).status,'pending');
});

test('a manager can pay only the weekdays of time off that spans a weekend',async()=>{
  const f=fixture(),{request}=await f.request({startDate:'2026-09-25',endDate:'2026-09-28'});
  for(const paidDates of [[],['2026-09-28','2026-09-25'],['2026-09-25','2026-09-25'],['2026-09-24'],['2026-09-25','2026-09-29'],'2026-09-25',[20260925]])
    await assert.rejects(f.act('approve',request.id,{paidDates}),error=>error.code==='pto_invalid_paid_dates'&&error.status===400,JSON.stringify(paidDates));
  await assert.rejects(f.act('approve',request.id,{paid:false,paidDates:['2026-09-25']}),error=>error.code==='pto_invalid_paid_dates');
  assert.equal(f.commits.length,0);assert.equal(f.record(request.id).status,'pending');
  const approval=await f.act('approve',request.id,{paidDates:['2026-09-25','2026-09-28']}),saved=f.record(request.id),[block]=f.blocks();
  assert.equal(approval.request.paidHours,16);assert.deepEqual(approval.request.paidDays,[{date:'2026-09-25',hours:8},{date:'2026-09-28',hours:8}]);
  assert.deepEqual(saved.paidDates,['2026-09-25','2026-09-28']);assert.equal(saved.paidHours,16);assert.deepEqual(saved.decisions[1].paidDates,['2026-09-25','2026-09-28']);
  // The whole request is still blocked on the schedule.
  assert.equal(block.date,'2026-09-25');assert.equal(block.endDate,'2026-09-28');
  assert.deepEqual((await ptoOverview(f.store,f.vault,manager,{startDate:'2026-09-21',endDate:'2026-09-28'},new Date(NOW))).paidTimeOff.days.map(row=>row.date),['2026-09-25']);
  const shift=(await f.request({type:'shift_change',paid:undefined,hoursPerDay:undefined,startDate:'2026-10-02',endDate:'2026-10-02'})).request;
  await assert.rejects(f.act('approve',shift.id,{paidDates:['2026-10-02']}),error=>error.code==='pto_invalid_request');
});

test('paid days default to the requested weekdays: weekend days are paid only when the manager chooses them',async()=>{
  const f=fixture(),{request}=await f.request({startDate:'2026-09-25',endDate:'2026-09-28'});
  // The pending request already shows what a default approval would pay.
  assert.equal(request.paidHours,16);assert.deepEqual(request.paidDays.map(day=>day.date),['2026-09-25','2026-09-28']);assert.equal(f.record(request.id).paidHours,16);
  const approval=await f.act('approve',request.id),saved=f.record(request.id);
  assert.deepEqual(saved.paidDates,['2026-09-25','2026-09-28']);assert.equal(saved.paidHours,16);assert.deepEqual(saved.decisions[1].paidDates,['2026-09-25','2026-09-28']);
  assert.deepEqual(approval.request.paidDays,[{date:'2026-09-25',hours:8},{date:'2026-09-28',hours:8}]);assert.equal(approval.request.payModel,'workflow');
  assert.deepEqual(ptoFromRequests([saved]).map(entry=>[entry.date,entry.hours]),[['2026-09-25',8],['2026-09-28',8]]);
  assert.equal(f.blocks()[0].endDate,'2026-09-28');
  // Weekend-only time off has no default paid day: the manager chooses the days or approves it unpaid.
  const weekend=(await f.request({startDate:'2026-10-03',endDate:'2026-10-04'})).request;
  assert.deepEqual([weekend.paid,weekend.paidHours,weekend.paidDays],[true,0,[]]);
  const commits=f.commits.length;
  await assert.rejects(f.act('approve',weekend.id),error=>error.code==='pto_invalid_paid_dates'&&error.status===400&&/Weekend days are not paid unless you choose them/.test(error.message));
  assert.equal(f.commits.length,commits);assert.equal(f.record(weekend.id).status,'pending');assert.equal(f.blocks().length,1);
  const chosen=await f.act('approve',weekend.id,{paidDates:['2026-10-04']});
  assert.deepEqual([chosen.request.paidHours,chosen.request.paidDays],[8,[{date:'2026-10-04',hours:8}]]);
  const unpaid=(await f.request({startDate:'2026-10-10',endDate:'2026-10-11'})).request;
  assert.deepEqual([(await f.act('approve',unpaid.id,{paid:false})).request.paid,f.record(unpaid.id).paidHours],[false,0]);
});

test('older approvals with only paidHoursPerDay keep their weekday rule, workflow fields win only when a workflow decision set them, and an early end stops pay',async()=>{
  const older={id:'request-crewone-p103',type:'time_off',employee:'Crew.One',startDate:'2026-09-25',endDate:'2026-09-28',reason:'Older approval',status:'approved',reviewedBy:'zacb',reviewedAt:'2026-09-15T10:00:00.000Z',paidHoursPerDay:8};
  // What the workflow writes: the terms, and a decision whose by/at are the record's reviewedBy/reviewedAt.
  const workflow=(row,terms,at='2026-09-20T15:00:00.000Z')=>({...row,...terms,reviewedBy:'tylerg',reviewedAt:at,decisions:[...(row.decisions || []),{action:'approve',status:'approved',by:'tylerg',at,...terms}]});
  const pick=row=>{const view=projectPtoRequest(row);return [view.payModel,view.paid,view.hoursPerDay,view.paidHours,view.paidDays.map(day=>day.date)];};
  assert.deepEqual(pick(older),['legacy',true,8,16,['2026-09-25','2026-09-28']]);
  assert.deepEqual(pick({...older,paidWeekends:true}),['legacy',true,8,32,['2026-09-25','2026-09-26','2026-09-27','2026-09-28']]);
  assert.deepEqual(pick(workflow({...older,paidWeekends:true},{paid:true,hoursPerDay:4,paidDates:['2026-09-26']})),['workflow',true,4,4,['2026-09-26']]);
  assert.deepEqual(pick(workflow(older,{paid:true,hoursPerDay:4})),['workflow',true,4,8,['2026-09-25','2026-09-28']]);
  assert.deepEqual(pick(workflow(older,{paid:false})),[null,false,null,0,[]]);
  assert.deepEqual(pick({...older,paidHoursPerDay:'8'}),['legacy',false,null,0,[]]);
  assert.deepEqual(pick({id:'browser-era',type:'time_off',employee:'Crew.One',startDate:'2026-09-25',status:'approved'}),[null,false,null,0,[]]);
  // Pay fields an employee wrote into a request that a manager approved in the browser never pay, even with a
  // written decision history: only the latest approve or amend decision matching reviewedBy/reviewedAt counts.
  const crafted={...older,paidHoursPerDay:undefined,paid:true,hoursPerDay:12,paidDates:['2026-09-25','2026-09-26','2026-09-27','2026-09-28']};
  for (const row of [crafted,{...crafted,decisions:[{action:'approve',status:'approved',by:'zacb',at:'2026-09-14T00:00:00.000Z'}]},{...crafted,decisions:[{action:'approve',status:'approved',by:'zacb'}],reviewedAt:undefined}])
    assert.deepEqual(pick(row),[null,false,null,0,[]]);
  assert.deepEqual(pick({...crafted,paidHoursPerDay:8}),['legacy',true,8,16,['2026-09-25','2026-09-28']]);
  const later=workflow(crafted,{paid:true,hoursPerDay:4,paidDates:['2026-09-25']});
  assert.deepEqual(pick(later),['workflow',true,4,4,['2026-09-25']]);
  assert.deepEqual(pick({...later,decisions:[...later.decisions,{action:'amend',status:'approved',by:'tylerg',at:'2026-09-21T00:00:00.000Z'}]}),[null,false,null,0,[]]);
  // Every reader derives the same days and hours: the request board, the per-day PTO view and payroll.
  const records=[older,workflow({...older,id:'request-both',employee:'crew2',paidWeekends:true},{paid:true,hoursPerDay:6,paidDates:['2026-09-26','2026-09-28']}),{...crafted,id:'request-crafted',employee:'crew-one'}];
  const view=paidTimeOffHours(records,'2026-09-21','2026-10-05'),payroll=ptoFromRequests(records);
  assert.deepEqual(view.days.map(row=>[row.requestId,row.date,row.hours]).sort(),payroll.map(entry=>[entry.id,entry.date,entry.hours]).sort());
  assert.deepEqual(view.totals,[{employee:'crew.one',hours:16},{employee:'crew2',hours:12}]);
  // Ended early through the workflow, the older approval stops paying from the first day back.
  const f=fixture();f.seed(older);
  const ended=await f.act('end',older.id,{endedEarlyFrom:'2026-09-28'},manager,'2026-09-26T18:00:00.000Z');
  assert.deepEqual([ended.request.payModel,ended.request.paidHours,ended.request.paidDays.map(day=>day.date)],['legacy',8,['2026-09-25']]);
  assert.equal(f.record(older.id).paidHours,8);assert.equal(f.record(older.id).paidHoursPerDay,8);
  assert.deepEqual(ptoFromRequests([f.record(older.id)]).map(entry=>[entry.date,entry.hours]),[['2026-09-25',8]]);
});

test('a manager changes what approved time off pays at any time, without touching the schedule, and payroll reads the new terms',async()=>{
  const f=fixture(),{request}=await f.request({startDate:'2026-09-25',endDate:'2026-09-28'});
  await f.act('approve',request.id,{paid:false});
  const commits=f.commits.length,blocks=f.blocks(),later='2026-09-30T18:00:00.000Z';
  assert.equal(projectPtoRequest(f.record(request.id)).paidHours,0);
  // After the time off is over, the manager pays Friday and Saturday at 6 hours.
  const input={action:'amend',requestId:randomUUID(),id:request.id,paid:true,hoursPerDay:6,paidDates:['2026-09-25','2026-09-26'],note:'Approved as paid'};
  const changed=await f.send(input,manager,later),saved=f.record(request.id);
  assert.deepEqual([changed.request.status,changed.request.payModel,changed.request.paidHours,changed.request.paidDays.map(day=>day.date),changed.warnings],['approved','workflow',12,['2026-09-25','2026-09-26'],[]]);
  assert.deepEqual([saved.paid,saved.hoursPerDay,saved.paidDates,saved.paidHours,saved.reviewedBy,saved.reviewedAt],[true,6,['2026-09-25','2026-09-26'],12,'zacb',later]);
  assert.deepEqual({...saved.decisions.at(-1),fingerprint:undefined},{action:'amend',status:'approved',by:'zacb',at:later,requestId:input.requestId,fingerprint:undefined,note:'Approved as paid',paid:true,hoursPerDay:6,paidDates:['2026-09-25','2026-09-26'],previousPaidHours:0});
  assert.equal(changed.request.decisions.at(-1).fingerprint,undefined);
  assert.equal(f.commits.length,commits);assert.deepEqual(f.blocks(),blocks);
  assert.deepEqual(ptoFromRequests([saved]).map(entry=>[entry.date,entry.hours]),[['2026-09-25',6],['2026-09-26',6]]);
  // A replay returns the recorded change; the same request ID with other terms is refused.
  const writes=f.vaultWrites.length,again=await f.send(input,manager,later);
  assert.equal(again.replayed,true);assert.equal(again.request.paidHours,12);assert.equal(f.vaultWrites.length,writes);
  await assert.rejects(f.send({...input,hoursPerDay:8},manager,later),error=>error.code==='pto_idempotency_conflict'&&error.status===409);
  // Without chosen days a paid change pays the weekdays; an unpaid change removes every paid hour.
  assert.deepEqual((await f.act('amend',request.id,{paid:true,hoursPerDay:8},{...manager,user:'tylerg'},later)).request.paidDays.map(day=>day.date),['2026-09-25','2026-09-28']);
  assert.equal(f.record(request.id).reviewedBy,'tylerg');
  const unpaid=await f.act('amend',request.id,{paid:false},manager,later);
  assert.deepEqual([unpaid.request.paid,unpaid.request.paidHours,f.record(request.id).paidDates,f.record(request.id).decisions.at(-1).previousPaidHours],[false,0,[],16]);
  assert.deepEqual(ptoFromRequests([f.record(request.id)]),[]);
  assert.deepEqual(f.record(request.id).decisions.map(entry=>entry.action),['request','approve','amend','amend','amend']);
  // Only managers change pay, only of approved time off, and only with complete terms.
  await assert.rejects(f.act('amend',request.id,{paid:true,hoursPerDay:8},crew,later),error=>error.code==='pto_forbidden'&&error.status===403);
  for(const extra of [{},{paid:'yes'},{paid:true},{paid:true,hoursPerDay:13},{paid:false,hoursPerDay:8},{paid:false,paidDates:['2026-09-25']},{paid:true,hoursPerDay:8,paidDates:['2026-09-24']},
    {paid:true,hoursPerDay:8,paidDates:['2026-09-28','2026-09-25']},{paid:true,hoursPerDay:8,paidDates:[]},{paid:true,hoursPerDay:8,acknowledgeConflicts:true},{paid:true,hoursPerDay:8,note:'x'.repeat(501)}])
    await assert.rejects(f.act('amend',request.id,extra,manager,later),error=>error.status===400,JSON.stringify(extra));
  assert.equal(f.record(request.id).decisions.length,5);
  const pending=(await f.request({startDate:'2026-10-12',endDate:'2026-10-12'})).request;
  await assert.rejects(f.act('amend',pending.id,{paid:true,hoursPerDay:8}),error=>error.code==='pto_not_approved'&&error.status===409);
  const shift=(await f.request({type:'shift_change',paid:undefined,hoursPerDay:undefined,startDate:'2026-10-02',endDate:'2026-10-02'})).request;await f.act('approve',shift.id);
  await assert.rejects(f.act('amend',shift.id,{paid:false}),error=>error.code==='pto_not_approved');
  await f.act('cancel',pending.id,{},crew);
  await assert.rejects(f.act('amend',pending.id,{paid:false}),error=>error.code==='pto_not_approved'&&error.details.status==='cancelled');
  // A weekend-only change needs chosen days; days from an early end on were released and cannot be paid.
  const weekend=(await f.request({startDate:'2026-10-03',endDate:'2026-10-04',paid:false,hoursPerDay:undefined})).request;await f.act('approve',weekend.id);
  await assert.rejects(f.act('amend',weekend.id,{paid:true,hoursPerDay:8}),error=>error.code==='pto_invalid_paid_dates'&&/make this time off unpaid/.test(error.message));
  const trip=(await f.request({startDate:'2026-10-19',endDate:'2026-10-23'})).request;await f.act('approve',trip.id);
  await f.act('end',trip.id,{endedEarlyFrom:'2026-10-21'},manager,'2026-10-20T18:00:00.000Z');
  await assert.rejects(f.act('amend',trip.id,{paid:true,hoursPerDay:8,paidDates:['2026-10-20','2026-10-21']},manager,later),error=>error.code==='pto_invalid_paid_dates');
  const kept=await f.act('amend',trip.id,{paid:true,hoursPerDay:4},manager,later);
  assert.deepEqual([kept.request.paidHours,kept.request.paidDays.map(day=>day.date),kept.request.endedEarlyFrom],[8,['2026-10-19','2026-10-20'],'2026-10-21']);
});

test('a pay change that meets a concurrent cancel or pay change is refused, and an older approval payroll cannot read is corrected instead of blocking the week',async()=>{
  const f=fixture(),{request}=await f.request({startDate:'2026-10-19',endDate:'2026-10-21'});await f.act('approve',request.id);
  const vaultWrite=f.vault.write;
  f.vault.write=async(id,...rest)=>{f.vault.write=vaultWrite;await f.act('cancel',request.id);return vaultWrite(id,...rest);};
  await assert.rejects(f.act('amend',request.id,{paid:false}),error=>error.code==='pto_revision_conflict'&&error.status===409&&error.details.status==='cancelled');
  assert.deepEqual([f.record(request.id).status,f.record(request.id).paid,f.record(request.id).decisions.map(entry=>entry.action)],['cancelled',true,['request','approve','cancel']]);
  // Another manager's pay change saved meanwhile is not overwritten.
  const other=(await f.request({startDate:'2026-10-26',endDate:'2026-10-27'})).request;await f.act('approve',other.id);
  f.vault.write=async(id,...rest)=>{f.vault.write=vaultWrite;await f.act('amend',other.id,{paid:true,hoursPerDay:4},{...manager,user:'tylerg'},'2026-09-22T12:05:00.000Z');return vaultWrite(id,...rest);};
  await assert.rejects(f.act('amend',other.id,{paid:false}),error=>error.code==='pto_revision_conflict'&&error.status===409);
  assert.deepEqual([f.record(other.id).paidHours,f.record(other.id).reviewedBy,f.record(other.id).decisions.map(entry=>entry.action)],[8,'tylerg',['request','approve','amend']]);
  const commits=f.commits.length;
  // Browser-era approvals whose manager-set pay payroll cannot read hold the week in review until a manager changes them.
  f.seed({id:'request-crewone-hours',type:'time_off',employee:'Crew.One',startDate:'2026-09-21',endDate:'2026-09-22',reason:'Old trip',status:'approved',reviewedBy:'zacb',reviewedAt:'2026-09-15T10:00:00.000Z',paidHoursPerDay:'eight'});
  f.seed({id:'request-crewone-dates',type:'time_off',employee:'Crew.One',startDate:'2026-09-23',endDate:'2026-09-22',reason:'Old day',status:'approved',reviewedBy:'zacb',paidHoursPerDay:8});
  const review=()=>computeTimesheetWeek({timecards:[],pto:ptoFromRequests([...f.records.values()].map(row=>row.data)),policy:'colorado',weekStart:'2026-09-21',now:'2026-10-01T12:00:00.000Z'}).needsReview.map(item=>[item.id,item.reason]);
  assert.deepEqual(review(),[['request-crewone-hours','invalid_pto'],['request-crewone-hours','invalid_pto'],['request-crewone-dates','invalid_pto']]);
  const fixed=await f.act('amend','request-crewone-hours',{paid:true,hoursPerDay:8});
  assert.deepEqual([fixed.request.payModel,fixed.request.paidHours,f.record('request-crewone-hours').paidHoursPerDay],['workflow',16,'eight']);
  await assert.rejects(f.act('amend','request-crewone-dates',{paid:true,hoursPerDay:8}),error=>error.code==='pto_invalid_dates'&&error.status===409);
  assert.equal((await f.act('amend','request-crewone-dates',{paid:false})).request.paid,false);
  assert.deepEqual(review(),[]);assert.equal(f.commits.length,commits);
});

test('approving an older pending request that carries a manager-set paidHoursPerDay keeps the pay the board shows by default',async()=>{
  const f=fixture(),seed=(id,extra)=>f.seed({id,type:'time_off',employee:'Crew.One',startDate:'2026-09-25',endDate:'2026-09-28',reason:'Older request',status:'pending',reviewedBy:'',reviewedAt:'',...extra});
  seed('request-older-weekdays',{paidHoursPerDay:8});
  seed('request-older-weekends',{startDate:'2026-10-02',endDate:'2026-10-05',paidHoursPerDay:6,paidWeekends:true});
  seed('request-older-long',{startDate:'2026-10-09',endDate:'2026-10-09',paidHoursPerDay:16});
  seed('request-older-unpaid',{startDate:'2026-10-12',endDate:'2026-10-12',paidHoursPerDay:8});
  const shown=id=>projectPtoRequest(f.record(id)),terms=view=>[view.paid,view.hoursPerDay,view.paidHours,view.paidDays.map(day=>day.date)];
  for (const id of ['request-older-weekdays','request-older-weekends']) {
    const board=terms(shown(id)),approval=await f.act('approve',id);
    assert.deepEqual(terms(approval.request),board,id);assert.equal(approval.request.payModel,'workflow');
  }
  assert.deepEqual(f.record('request-older-weekends').paidDates,['2026-10-02','2026-10-03','2026-10-04','2026-10-05']);assert.equal(f.record('request-older-weekends').paidHours,24);
  // Hours the workflow cannot pay are never dropped silently: the manager chooses them, or unpaid.
  await assert.rejects(f.act('approve','request-older-long'),error=>error.code==='pto_invalid_hours'&&error.status===400);
  assert.equal(f.record('request-older-long').status,'pending');
  assert.equal((await f.act('approve','request-older-long',{hoursPerDay:10})).request.paidHours,10);
  assert.deepEqual(terms((await f.act('approve','request-older-unpaid',{paid:false})).request),[false,null,0,[]]);
});

test('approval scans each crew segment of a split job: only the day this employee works conflicts',async()=>{
  const f=fixture();f.store.segmentsEnabled=true;
  const {job}=await mutateDispatch(f.store,manager,{action:'schedule.create',requestId:randomUUID(),customerId:'c1',kind:'job',changes:{assignmentSegments:[
    {id:'d1',date:'2026-09-23',time:'09:00',endTime:'12:00',assignedCrew:['crew2']},{id:'d2',date:'2026-09-24',time:'13:00',endTime:'15:00',assignedCrew:['crew.one']}]}},NOW);
  assert.deepEqual([job.date,job.endDate],['2026-09-23','2026-09-24']);
  // The whole job spans both days with both employees, but Crew One works only the second day.
  const free=(await f.request({startDate:'2026-09-23',endDate:'2026-09-23'})).request;
  assert.deepEqual((await f.act('approve',free.id)).warnings,[]);
  const busy=(await f.request({startDate:'2026-09-24',endDate:'2026-09-24'})).request,before=f.commits.length;
  await assert.rejects(f.act('approve',busy.id),error=>{
    assert.equal(error.status,409);assert.equal(error.code,'crew_availability_assignment_conflict');assert.equal(error.details.acknowledgeable,true);
    assert.deepEqual(error.details.conflicts.map(row=>[row.code,row.jobId,row.segmentId,row.date,row.time,row.endDate,row.endTime]),[['assigned_job',job.id,'d2','2026-09-24','13:00','2026-09-24','15:00']]);return true;});
  assert.equal(f.commits.length,before);assert.equal(f.record(busy.id).status,'pending');
  const approved=await f.act('approve',busy.id,{acknowledgeConflicts:true});
  assert.deepEqual(approved.warnings[0].conflicts.map(row=>[row.jobId,row.segmentId]),[[job.id,'d2']]);
  assert.deepEqual(f.record(busy.id).decisions.at(-1).warnings[0].jobIds,[job.id]);
});

test('one request is one availability block, including across the November clock change',async()=>{
  const f=fixture();
  await assert.rejects(f.request({startDate:'2026-10-10',endDate:'2026-11-09'}),error=>error.code==='pto_invalid_dates'&&error.status===400);
  const fits=(await f.request({startDate:'2026-10-10',endDate:'2026-11-08',paid:false,hoursPerDay:undefined})).request;
  await f.act('approve',fits.id);assert.equal(f.blocks()[0].startAt,'2026-10-10T06:00:00.000Z');assert.equal(f.blocks()[0].endAt,'2026-11-09T07:00:00.000Z');
  assert.equal((await f.request({startDate:'2026-12-01',endDate:'2026-12-31',paid:false,hoursPerDay:undefined})).request.status,'pending');
  f.seed({id:'request-crewtwo-long',type:'time_off',employee:'crew2',startDate:'2026-10-10',endDate:'2026-11-09',status:'pending'});
  await assert.rejects(f.act('approve','request-crewtwo-long'),error=>error.code==='pto_invalid_dates'&&error.status===409);
  assert.equal(f.blocks().length,1);assert.equal(f.record('request-crewtwo-long').status,'pending');
});

test('a release the schedule refuses is recorded once and flagged for dispatch review; too many linked blocks are refused first',async()=>{
  const f=fixture(),{request}=await f.request();await f.act('approve',request.id);
  // A manual block that is not linked to this request is listed on it.
  f.rows.set('jobs/manual_block',{id:'manual_block',revision:'manual-1',type:'availability',recordType:'crew_availability',employee:'crew.one',date:'2026-10-01',allDay:true,status:'active'});
  const current=f.records.get(request.id);f.seed({...current.data,availabilityIds:[...current.data.availabilityIds,'manual_block']},current.updateTime);
  const input={action:'cancel',requestId:randomUUID(),id:request.id},commits=f.commits.length;
  await assert.rejects(f.send(input),error=>error.code==='pto_release_review'&&error.status===409&&error.details.availabilityIds.includes('manual_block'));
  assert.equal(f.record(request.id).status,'cancelled');assert.equal(f.commits.length,commits);assert.ok(f.blocks().every(row=>row.status==='active'));
  await assert.rejects(f.send(input),error=>error.code==='pto_release_review');assert.equal(f.record(request.id).decisions.length,3);
  // An approval made here (it has an approve decision) owns its 62 listed blocks and its pto_block_: 63 in all.
  const approval={action:'approve',status:'approved',by:'zacb',at:NOW,requestId:randomUUID()};
  f.seed({id:'request-crewone-many',type:'time_off',employee:'Crew.One',startDate:'2026-10-01',endDate:'2026-10-01',status:'approved',decisions:[approval],availabilityIds:Array.from({length:62},(_,index)=>'block_'+index)});
  await assert.rejects(f.act('cancel','request-crewone-many'),error=>error.code==='pto_legacy_review'&&error.status===409);
  assert.equal(f.record('request-crewone-many').status,'approved');assert.deepEqual(f.record('request-crewone-many').decisions,[approval]);
});

test('approved paid time off is exposed per Denver day for a timesheet week',async()=>{
  const f=fixture();
  const paid=(await f.request()).request;await f.act('approve',paid.id);
  const unpaid=(await f.request({startDate:'2026-09-26',endDate:'2026-09-26',paid:false,hoursPerDay:undefined})).request;await f.act('approve',unpaid.id);
  await f.request({startDate:'2026-09-27',endDate:'2026-09-27'});
  const denied=(await f.request({startDate:'2026-10-01',endDate:'2026-10-01'})).request;await f.act('deny',denied.id);
  const other=(await f.request({startDate:'2026-09-24',endDate:'2026-09-24',hoursPerDay:4},crewTwo)).request;await f.act('approve',other.id);
  const week=await ptoOverview(f.store,f.vault,manager,{startDate:'2026-09-21',endDate:'2026-09-28'},new Date(NOW));
  assert.deepEqual(week.paidTimeOff.days.map(row=>[row.employee,row.date,row.hours]),[['crew.one','2026-09-23',8],['crew.one','2026-09-24',8],['crew2','2026-09-24',4],['crew.one','2026-09-25',8]]);
  assert.deepEqual(week.paidTimeOff.totals,[{employee:'crew.one',hours:24},{employee:'crew2',hours:4}]);assert.equal(week.coverage.asOf,NOW);assert.equal(week.requests.length,5);
  const own=await ptoOverview(f.store,f.vault,crew,{startDate:'2026-09-24',endDate:'2026-09-28'},new Date(NOW));
  assert.deepEqual(own.paidTimeOff.totals,[{employee:'crew.one',hours:16}]);assert.ok(own.requests.every(row=>row.employee==='crew.one'));assert.equal(own.employee,'crew.one');
  assert.deepEqual(paidTimeOffHours([f.record(paid.id)],'2026-09-25','2026-09-26').days.map(row=>row.date),['2026-09-25']);
  for(const query of [{startDate:'2026-09-21'},{startDate:'2026-09-28',endDate:'2026-09-21'},{startDate:'2026-01-01',endDate:'2026-06-01'},{employee:'crew2'}])
    await assert.rejects(ptoOverview(f.store,f.vault,manager,query,new Date(NOW)),error=>error.status===400);
});

test('managed availability validates identity, links and replays its release receipt',async()=>{
  const f=fixture(),requestId=randomUUID();
  await assert.rejects(createManagedAvailability(f.store,manager,'former.employee',{requestId,date:'2026-09-23',allDay:true},NOW),error=>error.code==='crew_availability_employee_inactive');
  const past=await createManagedAvailability(f.store,manager,'Crew.One',{requestId,id:'pto_block_manual',sourceRequestId:'source-1',date:'2026-09-20',allDay:true,reason:'Sick day'},NOW);
  assert.equal(past.record.employee,'crew.one');assert.equal((await createManagedAvailability(f.store,manager,'Crew.One',{requestId,id:'pto_block_manual',sourceRequestId:'source-1',date:'2026-09-20',allDay:true,reason:'Sick day'},NOW)).replayed,true);
  await assert.rejects(createManagedAvailability(f.store,manager,'crew.one',{requestId:randomUUID(),id:'pto_block_manual',date:'2026-09-21',allDay:true},NOW),error=>error.code==='crew_availability_record_exists');
  await assert.rejects(createManagedAvailability(f.store,manager,'crew.one',{requestId:randomUUID(),date:'2026-09-21',allDay:true,employee:'crew2'},NOW),error=>error.code==='crew_availability_invalid_request');
  const release={requestId:randomUUID(),ids:['pto_block_manual'],sourceRequestId:'source-1'};
  await assert.rejects(cancelManagedAvailability(f.store,crewTwo,'crew.one',release,NOW),error=>error.code==='crew_availability_forbidden');
  await assert.rejects(cancelManagedAvailability(f.store,manager,'crew.one',{...release,sourceRequestId:'source-2'},NOW),error=>error.code==='crew_availability_forbidden');
  const released=await cancelManagedAvailability(f.store,crew,'crew.one',release,NOW);assert.equal(released.records[0].status,'cancelled');
  assert.equal((await cancelManagedAvailability(f.store,crew,'crew.one',release,NOW)).replayed,true);
  assert.equal((await cancelManagedAvailability(f.store,manager,'crew.one',{...release,requestId:randomUUID()},NOW)).unchanged,true);
  await assert.rejects(cancelManagedAvailability(f.store,manager,'crew.one',{...release,requestId:randomUUID(),ids:['_egc_schedule_lock_2026-09-20']},NOW),error=>error.code==='crew_availability_invalid_request');
});

test('HTTP API enforces the signed session, same-origin JSON, bounded bodies, a writable vault and safe errors',async()=>{
  const f=fixture();let actor=null;const url='https://easygaragecleaning.com/api/employee-pto';
  const handlers=employeePtoHandlers({session:async()=>actor,storage:()=>f.store,vault:()=>f.vault,now:()=>new Date(NOW)});
  const post=(body,headers={})=>handlers.post({env:{},request:new Request(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://easygaragecleaning.com',...headers},body:typeof body==='string'?body:JSON.stringify(body)})});
  const input=()=>({action:'request',requestId:randomUUID(),type:'time_off',startDate:'2026-09-23',endDate:'2026-09-23',paid:true,hoursPerDay:8});
  assert.equal((await handlers.get({env:{},request:new Request(url)})).status,401);assert.equal((await post(input())).status,401);actor=crew;
  assert.equal((await post(input(),{Origin:'https://attacker.example'})).status,403);assert.equal((await post(input(),{'Sec-Fetch-Site':'cross-site'})).status,403);assert.equal((await post(input(),{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post('{')).status,400);assert.equal((await post('x'.repeat(9000))).status,413);assert.equal((await post(null)).status,400);
  f.vault.readOnly=true;const readOnly=await post(input());assert.equal(readOnly.status,503);assert.equal((await readOnly.json()).code,'pto_recovery_read_only');f.vault.readOnly=false;assert.equal(f.vaultWrites.length,0);
  const created=await post(input());assert.equal(created.status,200);assert.equal(created.headers.get('Cache-Control'),'no-store');assert.equal(created.headers.get('X-Content-Type-Options'),'nosniff');
  const {request}=await created.json();await f.assign();actor=manager;
  const conflict=await post({action:'approve',requestId:randomUUID(),id:request.id});assert.equal(conflict.status,409);const body=await conflict.json();
  assert.equal(body.ok,false);assert.equal(body.code,'crew_availability_assignment_conflict');assert.equal(body.details.conflicts.length,1);
  const listed=await handlers.get({env:{},request:new Request(url+'?startDate=2026-09-21&endDate=2026-09-28')});assert.equal(listed.status,200);assert.equal((await listed.json()).requests[0].id,request.id);
  assert.equal((await handlers.get({env:{},request:new Request(url+'?startDate=2026-09-21&startDate=2026-09-22&endDate=2026-09-28')})).status,400);
  f.vault.list=async()=>{throw new Error('internal provider detail secret-token');};
  const failed=await handlers.get({env:{},request:new Request(url)}),text=await failed.text();assert.equal(failed.status,503);assert.doesNotMatch(text,/secret-token/);assert.match(text,/pto_unavailable/);
  const unconfigured=employeePtoHandlers({session:async()=>crew,storage:()=>f.store,now:()=>new Date(NOW)});
  const missing=await unconfigured.post({env:{},request:new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input())})});
  assert.equal(missing.status,503);assert.equal((await missing.json()).code,'pto_not_configured');
});

// Firestore REST fake for the sealed-vault adapter (runQuery, get, PATCH preconditions).
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
function firestore(t, seed = {}) {
  const docs = new Map(Object.entries(seed)), calls = [];
  let revision = 0;
  t.mock.method(globalThis,'fetch',async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    calls.push({url,method});assert.equal(url.hostname,'firestore.googleapis.com');
    if (url.pathname.endsWith('/documents:runQuery')) {
      const {structuredQuery} = JSON.parse(options.body);
      const rows = [...docs].filter(([path,doc])=>path.startsWith('jobs/') && matchesWhere(doc,structuredQuery.where)).map(([path,doc])=>({document:{name:`${ROOT}/${path}`,...doc}}));
      return Response.json(rows.length ? rows : [{readTime:NOW}]);
    }
    const path = decodeURIComponent(url.pathname.split('/documents/')[1]);
    if (method === 'PATCH') {
      const absent = url.searchParams.get('currentDocument.exists'), expected = url.searchParams.get('currentDocument.updateTime');
      if ((absent === 'false' && docs.has(path)) || (expected && docs.get(path)?.updateTime !== expected)) return Response.json({error:{status:'FAILED_PRECONDITION'}},{status:412});
      docs.set(path,{...JSON.parse(options.body),updateTime:`2026-09-22T12:00:01.${String(++revision).padStart(6,'0')}Z`});
    }
    return docs.has(path) ? Response.json({name:`${ROOT}/${path}`,...docs.get(path)}) : Response.json({},{status:404});
  });
  return {docs,calls};
}

test('the sealed vault adapter stores requests encrypted with compare-and-set and never creates into an unproven vault',async t=>{
  const env={EMPLOYEE_HUB_DATA_SECRET:'synthetic-pto-vault-key',FIREBASE_API_KEY:'firebase-test-pto'};
  assert.throws(()=>ptoVault({}),error=>error.code==='pto_not_configured');
  assert.equal(ptoVault({...env,EMPLOYEE_HUB_LEGACY_KEY_SOURCE:'HIGHLEVEL_API_KEY'}).readOnly,true);
  const {docs}=firestore(t),f=fixture(),vault=ptoVault(env);f.vaultRevision=id=>docs.get('jobs/'+id)?.updateTime;
  const {request}=await mutatePto(f.store,vault,crew,{action:'request',requestId:randomUUID(),type:'time_off',startDate:'2026-09-23',endDate:'2026-09-23',reason:'Synthetic private reason',paid:true,hoursPerDay:8},NOW);
  const documentId=await opaqueId(env,'requests',request.id),stored=docs.get('jobs/'+documentId);
  assert.equal(stored.fields.recordType.stringValue,'employee_hub_v2');assert.equal(stored.fields.employeeHubType.stringValue,'requests');assert.doesNotMatch(JSON.stringify(stored),/Synthetic private reason|crew\.one/);
  await mutatePto(f.store,vault,manager,{action:'approve',requestId:randomUUID(),id:request.id},NOW);
  assert.deepEqual(f.commits[0].filter(write=>write.verify),[{collection:'jobs',id:documentId,revision:stored.updateTime,verify:true}]);
  const [saved]=await readCollection(env,'requests');assert.equal(saved.status,'approved');assert.equal(saved.paidHours,8);assert.equal(f.blocks().length,1);
  // A vault that only holds records sealed under another key cannot prove a 404.
  const otherEnv={...env,EMPLOYEE_HUB_DATA_SECRET:'synthetic-other-key'},foreignId=await opaqueId(otherEnv,'profiles','crew.one');
  const foreign={...firestoreDoc('profiles',foreignId,await seal(otherEnv,foreignId,{id:'crew.one',username:'Crew.One'}),NOW),updateTime:'2026-09-22T11:00:00.000000Z'};
  const g=fixture(),empty=firestore(t,{['jobs/'+foreignId]:foreign});
  await assert.rejects(mutatePto(g.store,ptoVault(env),crew,{action:'request',requestId:randomUUID(),type:'time_off',startDate:'2026-09-23',endDate:'2026-09-23'},NOW),error=>error.code==='EMPLOYEE_HUB_STORAGE_UNREADABLE');
  assert.equal([...empty.docs.keys()].length,1);
});

test('the generic employee record endpoint no longer accepts request writes from crew or managers',async t=>{
  const env={HUB_SESSION_SECRET:'synthetic-pto-session-secret',EMPLOYEE_HUB_DATA_SECRET:'synthetic-pto-vault-key',FIREBASE_API_KEY:'firebase-test-pto-hub',
    HUB_AUTH_USERS_JSON:JSON.stringify({ZacB:{passwordHash:'synthetic-owner-hash',displayName:'Owner',role:'owner'},'Crew.One':{passwordHash:'synthetic-crew-hash',displayName:'Crew One',role:'crew'}})};
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected storage access');});
  for (const user of ['ZacB','Crew.One']) {
    const cookie=(await createHubSessionCookie(env,user)).split(';')[0];
    for (const data of [{type:'time_off',status:'approved',startDate:'2026-09-23'},{type:'shift_change',startDate:'2026-09-23',endDate:'2026-09-23',reason:'Swap'}]) {
      const response=await employeeHubPost({env,request:new Request('https://easygaragecleaning.com/api/employee-hub',{method:'POST',headers:{Cookie:cookie,Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify({collection:'requests',id:'request-1',data})})});
      assert.equal(response.status,403);assert.equal((await response.json()).code,'EMPLOYEE_HUB_REQUEST_WORKFLOW_REQUIRED');
    }
  }
});
