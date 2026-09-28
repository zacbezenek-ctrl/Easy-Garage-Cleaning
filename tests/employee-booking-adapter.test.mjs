import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {dispatchHandlers} from '../functions/api/dispatch.js';
import {customerResolveHandler} from '../functions/api/customer-resolve.js';
import {recurringPlanHandlers} from '../functions/api/recurring-plans.js';

const source=readFileSync(new URL('../employee-booking.js',import.meta.url),'utf8');
const manager={user:'zacb',role:'owner',businessAccess:true};
// Recurring-plan flows run dispatch and plan handlers on one mocked instant.
const NOW='2026-09-22T12:00:00.000Z',clock=t=>t.mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
function fixture(){
  const rows=new Map([['customers/c1',{id:'c1',revision:'c1-r',name:'Synthetic Customer',phone:'9705550100',email:'synthetic@example.invalid',address:'123 Synthetic Way'}]]),calls=[],batches=[],storage={},listeners={};let revision=0;
  const scan=collection=>[...rows].filter(([key])=>key.startsWith(collection+'/')).map(([,row])=>structuredClone(row));
  const store={read:async(collection,id)=>structuredClone(rows.get(collection+'/'+id)||null),roster:async()=>[{id:'crew.one',name:'Crew One',role:'crew'},{id:'zacb',name:'Zac',role:'owner'}],jobs:async()=>scan('jobs'),customers:async()=>scan('customers'),recurringPlans:async()=>scan('recurringPlans'),resources:async()=>scan('dispatchResources'),commit:async writes=>{
    for(const write of writes){const current=rows.get(write.collection+'/'+write.id);if(write.revision?current?.revision!==write.revision:Boolean(current))throw Object.assign(new Error('Changed'),{code:'dispatch_revision_conflict',status:409});}
    batches.push(writes);for(const write of writes)rows.set(write.collection+'/'+write.id,{...rows.get(write.collection+'/'+write.id),...structuredClone(write.patch),id:write.id,revision:'r'+(++revision)});
  }};
  // Recurring plans are served by the real handler; the flag stays off unless a test sets f.env.
  const routes=dispatchHandlers({session:async()=>manager,storage:()=>store}),customer=customerResolveHandler({session:async()=>manager,storage:()=>store}),recurring=recurringPlanHandlers({session:async()=>manager,storage:()=>store,now:()=>new Date(NOW)});
  const f={rows,calls,batches,store,lost:false,offline:false,malformed:false,env:{},lostPlan:null,statusDown:null};
  function load(){const sessionStorage={...storage,getItem:key=>storage[key]??null,setItem:(key,value)=>{storage[key]=String(value);sessionStorage[key]=String(value);},removeItem:key=>{delete storage[key];delete sessionStorage[key];}};sessionStorage.setItem('egc_u','zacb');
    const context={URLSearchParams,Date,Intl,Promise,Set,Map,Error,JSON,crypto,AbortSignal,sessionStorage,addEventListener:(name,fn)=>{listeners[name]=fn;},fetch:async(path,options={})=>{
      const req=new Request('https://easygaragecleaning.com'+path,{...options,headers:{Origin:'https://easygaragecleaning.com',...(options.headers||{})}});calls.push({path,body:options.body?JSON.parse(options.body):null});
      if(f.offline)throw new Error('offline');
      if(path==='/api/recurring-plans?view=status'&&f.statusDown){if(f.statusDown==='offline')throw new Error('offline');return Response.json({ok:false,code:'recurring_unavailable',error:'Unavailable'},{status:f.statusDown});}
      const response=path.startsWith('/api/customer-resolve')?await customer({request:req,env:{}}):path.startsWith('/api/recurring-plans')?await recurring[options.method==='POST'?'post':'get']({request:req,env:f.env}):await routes[options.method==='POST'?'post':'get']({request:req,env:{}});
      if(options.method==='POST'&&path==='/api/recurring-plans'&&f.lostPlan&&calls.at(-1).body.action===f.lostPlan){f.lostPlan=null;throw new Error('Reply lost after commit');}
      if(options.method==='POST'&&path==='/api/dispatch'&&f.lost){f.lost=false;throw new Error('Reply lost after commit');}
      if(options.method==='POST'&&path==='/api/dispatch'&&f.malformed){f.malformed=false;return Response.json({ok:true});}
      return response;
    }};context.window=context;vm.runInNewContext(source,context);f.ui=context.EGCBooking;f.context=context;}
  load();f.reload=load;f.signout=()=>listeners['egc:signout']();return f;
}
const draft=(changes={})=>({id:'legacy-draft',type:'job',customerId:'c1',customer:'Synthetic Customer',date:'2026-09-23',time:'08:00',endTime:'10:00',assignedCrew:['Crew One'],crewNeeded:1,notes:'Keep the workbench',...changes});
test('legacy create uses canonical dispatch record and exact roster aliases without frontend job writes',async()=>{
  const f=fixture(),job=await f.ui.save(draft());assert.notEqual(job.id,'legacy-draft');assert.deepEqual([...job.assignedCrew],['crew.one']);assert.equal(job.date,'2026-09-23');assert.equal(f.batches.length,1);
  const body=f.calls.find(call=>call.body)?.body;assert.equal(body.action,'schedule.create');assert.equal(body.customerId,'c1');assert.equal(body.changes.notes,'Keep the workbench');assert.equal(f.ui.canLeave(),true);
});
test('manual customer intake resolves once before schedule creation without dropping canonical customer identity',async()=>{
  const f=fixture(),job=await f.ui.save(draft({customerId:undefined,phone:'9705550100',email:'synthetic@example.invalid'}));assert.equal(job.customerId,'c1');assert.equal(f.calls.filter(call=>call.path==='/api/customer-resolve').length,1);assert.equal((await f.store.customers()).length,1);
});
test('lost booking response is replayed after full adapter reload without a duplicate customer or job',async()=>{
  const f=fixture(),input=draft({customerId:undefined,phone:'9705550100'});f.lost=true;await assert.rejects(f.ui.save(input),problem=>problem.status===503);assert.equal(f.ui.canLeave(),false);f.reload();const saved=await f.ui.save(input);
  const posts=f.calls.filter(call=>call.path==='/api/dispatch'&&call.body);assert.deepEqual(posts[0].body,posts[1].body);assert.equal((await f.store.jobs()).filter(row=>row.type==='job').length,1);assert.equal(saved.status,'scheduled');assert.equal(f.calls.filter(call=>call.path==='/api/customer-resolve').length,1);assert.equal(f.ui.canLeave(),true);
});
test('unknown mutation refuses changed fields and incomplete success retains original request',async()=>{
  const f=fixture(),input=draft();f.malformed=true;await assert.rejects(f.ui.save(input),problem=>problem.status===503);await assert.rejects(f.ui.save({...input,time:'12:00'}),problem=>problem.code==='booking_pending_operation');assert.equal(f.calls.filter(call=>call.body).length,1);await f.ui.save(input);assert.equal(f.calls.filter(call=>call.body).length,2);
});
test('edits compare the observed revision before using current CAS and preserve financial fields',async()=>{
  const f=fixture(),job=await f.ui.save(draft());f.rows.get('jobs/'+job.id).estimate={amount:1200};const updated=await f.ui.save({...job,time:'11:00',endTime:'13:00'},job);assert.equal(updated.time,'11:00');assert.deepEqual(f.rows.get('jobs/'+job.id).estimate,{amount:1200});
  const before=f.batches.length;await assert.rejects(f.ui.save({...job,time:'14:00',endTime:'16:00'},job),problem=>problem.code==='dispatch_revision_conflict');assert.equal(f.batches.length,before);
});
test('resource time off and unverified crew names reject old-form bookings server-side',async()=>{
  const f=fixture();f.rows.set('dispatchResources/timeoff',{id:'timeoff',recordType:'availability',employeeId:'crew.one',date:'2026-09-23',allDay:true,status:'active'});await assert.rejects(f.ui.save(draft()),problem=>problem.code==='dispatch_conflict');assert.equal(f.batches.length,0);assert.equal(f.ui.canLeave(),true);
  await assert.rejects(f.ui.save(draft({assignedCrew:['Crew']})),problem=>problem.code==='booking_employee_unverified');assert.equal(f.batches.length,0);
});
test('global blocked time uses a customerless command and blocks subsequent crew work',async()=>{
  const f=fixture(),saved=await f.ui.save(draft({type:'blocked',customerId:undefined,customer:'Truck maintenance'}));assert.equal(saved.type,'blocked');assert.equal(saved.title,'Truck maintenance');const body=f.calls.find(call=>call.body)?.body;assert.equal(body.customerId,undefined);assert.equal(body.changes.assignedCrew,undefined);
  await assert.rejects(f.ui.save(draft({id:'other-draft'})),problem=>problem.code==='dispatch_conflict');
});
test('recurring visit links canonical template without cloning payments or execution',async()=>{
  const f=fixture(),original=await f.ui.save(draft({recurrence:'weekly',shiftPickupEnabled:true}));Object.assign(f.rows.get('jobs/'+original.id),{payment:{amount:1200},fieldExecution:{completedAt:'before'}});
  const next=await f.ui.save({...original,id:'next-draft',date:'2026-09-30',endDate:'2026-09-30',sourceTemplateJobId:original.id});const raw=f.rows.get('jobs/'+next.id);assert.equal(raw.sourceTemplateJobId,original.id);assert.equal(raw.recurrence,'weekly');assert.equal(raw.payment,undefined);assert.equal(raw.fieldExecution,undefined);
});
test('cancellation saves required reason and releases capacity with stable retry identity',async()=>{
  const f=fixture(),job=await f.ui.save(draft());f.lost=true;await assert.rejects(f.ui.cancel(job,'Customer changed date'),problem=>problem.status===503);const result=await f.ui.cancel(job,'Customer changed date');assert.equal(result.status,'cancelled');assert.equal(f.rows.get('jobs/'+job.id).cancellationReason,'Customer changed date');
  const calls=f.calls.filter(call=>call.body?.action==='schedule.cancel');assert.deepEqual(calls[0].body,calls[1].body);const second=await f.ui.save(draft({id:'next',customerId:'c1',time:'08:30',endTime:'10:30'}));assert.equal(second.status,'scheduled');
});
test('offline reads do not manufacture a pending save and signout clears saved mutation identity',async()=>{
  const f=fixture();f.offline=true;await assert.rejects(f.ui.save(draft()),problem=>problem.status===503);assert.equal(f.ui.canLeave(),true);f.offline=false;f.lost=true;await assert.rejects(f.ui.save(draft()));assert.equal(f.ui.canLeave(),false);f.signout();assert.equal(f.ui.canLeave(),true);
});
test('refresh recovery discovers saved commands and replays without needing the old form draft',async()=>{
  const f=fixture();f.lost=true;await assert.rejects(f.ui.save(draft()));f.reload();assert.equal(f.ui.canLeave(),false);const recovery=f.ui.recoveries();assert.equal(recovery.length,1);assert.equal(recovery[0].request.changes.date,'2026-09-23');const saved=await f.ui.retryPending(recovery[0].key);assert.equal(saved.status,'scheduled');assert.equal((await f.store.jobs()).filter(row=>row.type==='job').length,1);assert.equal(f.ui.recoveries().length,0);
});
test('recurring series resumes after a lost response and clamps month ends in Mountain calendar dates',async()=>{
  const f=fixture(),input=draft({date:'2026-01-31',recurrence:'monthly'});f.lost=true;await assert.rejects(f.ui.saveSeries(input,{}, {operationKey:'series-draft'}));f.reload();const recovery=f.ui.recoveries();assert.equal(recovery.length,1);assert.equal(recovery[0].series,true);const result=await f.ui.retryPending(recovery[0].key);
  assert.equal(result.visits.length,7);assert.equal(result.visits[1].date,'2026-02-28');assert.equal(result.visits[2].date,'2026-03-31');assert.equal((await f.store.jobs()).filter(row=>row.type==='job').length,7);assert.equal(f.ui.canLeave(),true);
});
test('recurring series stops on a definite resource conflict and reports its exact partial result',async()=>{
  const f=fixture();f.rows.set('dispatchResources/timeoff',{id:'timeoff',recordType:'availability',employeeId:'crew.one',date:'2026-09-30',allDay:true,status:'active'});
  const result=await f.ui.saveSeries(draft({recurrence:'weekly'}),{}, {operationKey:'blocked-series'});assert.equal(result.visits.length,1);assert.equal(result.remaining,8);assert.match(result.warning,/Remaining visits were not created/);assert.equal((await f.store.jobs()).filter(row=>row.type==='job').length,1);assert.equal(f.ui.canLeave(),true);
});
test('a late save response after signout cannot restore another session draft',async()=>{
  const f=fixture(),original=f.context.fetch;let release,started;const waiting=new Promise(resolve=>release=resolve),sent=new Promise(resolve=>started=resolve);
  f.context.fetch=async(path,options)=>{const response=await original(path,options);if(path==='/api/dispatch'&&options.method==='POST'){started();await waiting;}return response;};
  const saving=f.ui.save(draft());await sent;f.signout();f.context.sessionStorage.setItem('egc_u','another.manager');release();await assert.rejects(saving,problem=>problem.code==='booking_session_changed');assert.equal(f.ui.canLeave(),true);assert.equal(f.ui.recoveries().length,0);
});
test('with recurring plans off, a repeating booking only checks the setting and keeps the legacy fixed series',async t=>{
  clock(t);
  const f=fixture(),result=await f.ui.saveSeries(draft({recurrence:'biweekly'}),{}, {operationKey:'legacy-off'});
  assert.equal(result.visits.length,7);assert.equal(result.plan,undefined);
  assert.deepEqual(f.calls.filter(call=>call.path.startsWith('/api/recurring-plans')).map(call=>[call.path,call.body]),[['/api/recurring-plans?view=status',null]]);
  assert.equal((await f.store.recurringPlans()).length,0);
});
test('with recurring plans on, a repeating booking saves its first visit then a server plan adds rolling visits',async t=>{
  clock(t);
  const f=fixture();f.env.EGC_RECURRING_PLANS_ENABLED='true';
  const result=await f.ui.saveSeries(draft({recurrence:'weekly'}),{}, {operationKey:'plan-series'});
  const plans=await f.store.recurringPlans(),jobs=(await f.store.jobs()).filter(row=>row.type==='job');
  assert.equal(plans.length,1);assert.equal(plans[0].templateJobId,result.job.id);assert.equal(plans[0].notifyCustomer,true,'wizard series keep legacy reminder behavior');assert.deepEqual(plans[0].cadence,{frequency:'weekly'});assert.equal(plans[0].horizonDays,56);
  assert.deepEqual([...result.visits.map(job=>job.date)],['2026-09-23','2026-09-30','2026-10-07','2026-10-14','2026-10-21','2026-10-28','2026-11-04','2026-11-11']);
  assert.equal(jobs.length,8);assert.equal(jobs.filter(row=>row.recurringPlanId===plans[0].id).length,7);assert.equal(result.warning,undefined);
  const posts=f.calls.filter(call=>call.body);assert.deepEqual(posts.map(call=>call.body.action),['schedule.create','create','extend','extend']);
  assert.equal(posts[1].body.plan.templateJobId,result.job.id);assert.notEqual(posts[3].body.expectedRevision,posts[2].body.expectedRevision,'each round uses the revision returned by the previous one');
  assert.equal(f.ui.canLeave(),true);assert.equal(f.ui.recoveries().length,0);
});
test('a lost recurring-plan response resumes the saved series after reload without duplicate visits',async t=>{
  clock(t);
  const f=fixture();f.env.EGC_RECURRING_PLANS_ENABLED='true';f.lostPlan='extend';
  await assert.rejects(f.ui.saveSeries(draft({recurrence:'weekly'}),{}, {operationKey:'lost-plan'}),problem=>problem.status===503);
  assert.equal(f.ui.canLeave(),false);f.reload();
  const recovery=f.ui.recoveries();assert.equal(recovery.length,1);assert.equal(recovery[0].series,true);
  const result=await f.ui.retryPending(recovery[0].key);
  assert.equal(result.visits.length,8);assert.equal((await f.store.jobs()).filter(row=>row.type==='job').length,8);
  const extends_=f.calls.filter(call=>call.body?.action==='extend');assert.deepEqual(extends_[0].body,extends_[1].body);
  assert.equal((await f.store.recurringPlans()).length,1);assert.equal(f.ui.canLeave(),true);
});
test('recurring conflicts are saved unscheduled and reported instead of silently dropped',async t=>{
  clock(t);
  const f=fixture();f.env.EGC_RECURRING_PLANS_ENABLED='true';
  f.rows.set('dispatchResources/timeoff',{id:'timeoff',recordType:'availability',employeeId:'crew.one',date:'2026-10-07',allDay:true,status:'active'});
  const result=await f.ui.saveSeries(draft({recurrence:'weekly'}),{}, {operationKey:'conflict-plan'});
  assert.match(result.warning,/1 recurring visit\(s\) conflicted/);
  const conflict=(await f.store.jobs()).find(row=>row.occurrenceDate==='2026-10-07');assert.equal(conflict.status,'unscheduled');assert.equal(conflict.recurrenceConflict.code,'dispatch_conflict');
  assert.equal(result.visits.filter(job=>!job.date).length,1);
});
test('edits and walkthrough series never create a recurring plan',async t=>{
  clock(t);
  const f=fixture();f.env.EGC_RECURRING_PLANS_ENABLED='true';
  await f.ui.saveSeries(draft({type:'walkthrough',recurrence:'monthly'}),{}, {operationKey:'walkthrough-series'});
  const job=await f.ui.save(draft({id:'edit-me',time:'12:00',endTime:'13:00'}));await f.ui.saveSeries({...job,time:'14:00',endTime:'15:00',recurrence:'weekly'},job,{operationKey:'edit-series'});
  assert.equal(f.calls.filter(call=>call.path.startsWith('/api/recurring-plans')).length,0);assert.equal((await f.store.recurringPlans()).length,0);
});
test('with recurring plans on, a rejected first visit creates no plan and leaves nothing pending',async t=>{
  clock(t);
  const f=fixture();f.env.EGC_RECURRING_PLANS_ENABLED='true';
  f.rows.set('dispatchResources/timeoff',{id:'timeoff',recordType:'availability',employeeId:'crew.one',date:'2026-09-23',allDay:true,status:'active'});
  await assert.rejects(f.ui.saveSeries(draft({recurrence:'monthly'}),{}, {operationKey:'rejected-plan'}),problem=>problem.code==='dispatch_conflict');
  assert.equal((await f.store.recurringPlans()).length,0);assert.equal(f.calls.filter(call=>call.path==='/api/recurring-plans').length,0);assert.equal(f.ui.canLeave(),true);assert.equal(f.ui.recoveries().length,0);
});
test('a failed recurring settings check saves nothing and says so, for network and server failures',async t=>{
  clock(t);
  for(const failure of ['offline',503]){
    const f=fixture();f.statusDown=failure;
    await assert.rejects(f.ui.saveSeries(draft({recurrence:'weekly'}),{}, {operationKey:'status-'+failure}),problem=>problem.code==='booking_recurring_status_unavailable'&&problem.status===503&&/nothing was saved/.test(problem.message));
    assert.deepEqual(f.calls.map(call=>call.path),['/api/recurring-plans?view=status']);assert.equal(f.batches.length,0);
    assert.equal(f.ui.recoveries().length,0);assert.equal(f.ui.canLeave(),true);
    f.statusDown=null;const result=await f.ui.saveSeries(draft({recurrence:'weekly'}),{}, {operationKey:'status-'+failure});assert.equal(result.visits.length,9,'a plain retry books the legacy series once the check succeeds');
  }
});
