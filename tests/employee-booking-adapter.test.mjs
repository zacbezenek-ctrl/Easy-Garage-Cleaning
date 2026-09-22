import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {dispatchHandlers} from '../functions/api/dispatch.js';
import {customerResolveHandler} from '../functions/api/customer-resolve.js';

const source=readFileSync(new URL('../employee-booking.js',import.meta.url),'utf8');
const manager={user:'zacb',role:'owner',businessAccess:true};
function fixture(){
  const rows=new Map([['customers/c1',{id:'c1',revision:'c1-r',name:'Synthetic Customer',phone:'9705550100',email:'synthetic@example.invalid',address:'123 Synthetic Way'}]]),calls=[],batches=[],storage={},listeners={};let revision=0;
  const scan=collection=>[...rows].filter(([key])=>key.startsWith(collection+'/')).map(([,row])=>structuredClone(row));
  const store={read:async(collection,id)=>structuredClone(rows.get(collection+'/'+id)||null),roster:async()=>[{id:'crew.one',name:'Crew One',role:'crew'},{id:'zacb',name:'Zac',role:'owner'}],jobs:async()=>scan('jobs'),customers:async()=>scan('customers'),resources:async()=>scan('dispatchResources'),commit:async writes=>{
    for(const write of writes){const current=rows.get(write.collection+'/'+write.id);if(write.revision?current?.revision!==write.revision:Boolean(current))throw Object.assign(new Error('Changed'),{code:'dispatch_revision_conflict',status:409});}
    batches.push(writes);for(const write of writes)rows.set(write.collection+'/'+write.id,{...rows.get(write.collection+'/'+write.id),...structuredClone(write.patch),id:write.id,revision:'r'+(++revision)});
  }};
  const routes=dispatchHandlers({session:async()=>manager,storage:()=>store}),customer=customerResolveHandler({session:async()=>manager,storage:()=>store});
  const f={rows,calls,batches,store,lost:false,offline:false,malformed:false};
  function load(){const sessionStorage={...storage,getItem:key=>storage[key]??null,setItem:(key,value)=>{storage[key]=String(value);sessionStorage[key]=String(value);},removeItem:key=>{delete storage[key];delete sessionStorage[key];}};sessionStorage.setItem('egc_u','zacb');
    const context={URLSearchParams,Date,Intl,Promise,Set,Map,Error,JSON,crypto,AbortSignal,sessionStorage,addEventListener:(name,fn)=>{listeners[name]=fn;},fetch:async(path,options={})=>{
      const req=new Request('https://easygaragecleaning.com'+path,{...options,headers:{Origin:'https://easygaragecleaning.com',...(options.headers||{})}});calls.push({path,body:options.body?JSON.parse(options.body):null});
      if(f.offline)throw new Error('offline');const response=path.startsWith('/api/customer-resolve')?await customer({request:req,env:{}}):await routes[options.method==='POST'?'post':'get']({request:req,env:{}});
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
