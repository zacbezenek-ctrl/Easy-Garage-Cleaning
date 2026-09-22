import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveWalkthroughHandoff, prepareHandoff, savedHandoffPayload, normalizeHandoffPlan } from '../functions/_lib/walkthrough-handoff.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
const owner={user:'zacb',role:'owner',businessAccess:true,displayName:'Owner'};
const NOW='2026-09-22T18:00:00.000Z';
// Synthetic signature fixture is used only by these isolated tests.
const plan=()=>({client:{name:'Synthetic Customer',phone:'9705550100',email:'test@example.invalid',address:'100 Fixture Lane',highlevel_contact_id:'provider1'},quote:{title:'Garage reset',total:1400,deposit:700,job_date:'2026-09-24',start_time:'09:00',end_time:'12:00',estimated_duration_min:180},acceptance:{accepted_at:'2026-09-22T17:45:00.000Z',accepted_by:'Synthetic Customer',signature_captured:true,method:'in_person_signature',terms_version:'2026-09-deposit50'},signature:'data:image/png;base64,iVBORw0KGgo=',terms_version:'2026-09-deposit50',terms_accepted:true,photos:{before:3},scope:{keep_items:'Blue bicycle',remove_items:'Empty cartons',exclusions:'Locked cabinet',finish:['shelving'],finish_details:{shelf_type:'metal',shelf_qty:2}},discovery:{success:'Park a vehicle'},logistics:{crew_size:2,assigned_to:'Crew of 2',notes:'Use side gate'},internal_notes:'Keep blue bicycle. Remove empty cartons. Do not open the locked cabinet.',notes:'Call before arrival',client_checklists:{preJob:[{id:'keep-bike',label:'Protect blue bicycle',detail:'Move to safe area',critical:true}],postJob:[{id:'scope-review',label:'Review with customer',detail:'Confirm agreed scope'}]}});
function fixture(){
 const rows=new Map([
  ['customers/c1',{id:'c1',revision:'c1r',name:'Synthetic Customer',phone:'9705550100',email:'test@example.invalid',address:'100 Fixture Lane',highlevelContactId:'provider1'}],
  ['jobs/w1',{id:'w1',revision:'w1r',type:'walkthrough',status:'scheduled',pipelineStatus:'scheduled',customerId:'c1',customer:'Synthetic Customer',highlevelContactId:'provider1',highlevelAppointmentId:'walk-provider',date:'2026-09-22',time:'11:00',endTime:'12:00',projectId:'p1',payment:{verified:true,amount:90}}],
  ['projects/p1',{id:'p1',revision:'p1r',customerId:'c1',sourceRecordId:'w1',sourceWalkthroughId:'w1'}]
 ]);
 let n=0,before=()=>{},after=()=>{};const calls=[];
 const roster=[{id:'zacb',name:'Owner',role:'owner'},{id:'crew1',name:'Crew One',role:'crew'},{id:'crew2',name:'Crew Two',role:'crew'}];
 const store={read:async(c,id)=>structuredClone(rows.get(`${c}/${id}`)||null),jobs:async()=>[...rows].filter(([k])=>k.startsWith('jobs/')).map(([,v])=>structuredClone(v)),resources:async()=>[],roster:async()=>structuredClone(roster),
 commit:async writes=>{before(writes);const keys=new Set();for(const w of writes){const k=`${w.collection}/${w.id}`,old=rows.get(k);assert(!keys.has(k),'unique writes');keys.add(k);if(w.revision?old?.revision!==w.revision:!!old)throw Object.assign(new Error('Conflict'),{code:'dispatch_revision_conflict',status:409});}calls.push(structuredClone(writes));for(const w of writes)if(!w.verify){const k=`${w.collection}/${w.id}`;rows.set(k,{...rows.get(k),...structuredClone(w.patch),id:w.id,revision:`r${++n}`});}after();}};
 const input={requestId:randomUUID(),customerId:'c1',sourceWalkthroughId:'w1',sourceRevision:'w1r',plan:plan()};
 return{rows,store,input,calls,before:fn=>before=fn,after:fn=>after=fn,run:()=>saveWalkthroughHandoff(store,owner,input,NOW)};
}
test('signed walkthrough becomes one linked job with private proof, crew instructions and no fabricated payment/completion',async()=>{
 const f=fixture(),r=await f.run(),j=f.rows.get('jobs/'+r.job.id);
 assert.equal(j.projectId,'p1');assert.equal(j.customerId,'c1');assert.equal(j.sourceWalkthroughId,'w1');
 assert.equal(j.jobInstructions.keepItems,'Blue bicycle');assert.equal(j.clientChecklists.preJob[0].required,true);
 assert.equal(j.estimate.amount,1400);assert.equal(j.estimate.status,'accepted');assert.equal(j.deposit.amount,700);assert.equal(j.deposit.paidAmount,0);assert.equal(j.payment,undefined);
 assert.equal(j.acceptance.acceptedAt,'2026-09-22T17:45:00.000Z');assert.equal(f.rows.get('jobs/w1').status,'scheduled');assert.equal(f.rows.get('jobs/w1').completedAt,undefined);assert.equal(f.rows.get('jobs/w1').payment.amount,90);
 assert.equal(j.walkthroughAppointmentId,'walk-provider');assert.equal(j.syncStatus,'pending');assert.equal(r.financialState,'accepted_quote_not_payment');assert.deepEqual(r.job.assignedCrew,[]);assert(r.warnings.some(x=>x.code==='unassigned'));
 assert.equal(r.job.acceptance,undefined);assert.equal(r.job.estimate,undefined);assert.equal(r.job.signature,undefined);
 assert.equal(f.rows.get('walkthroughHandoffs/'+f.input.requestId).signature,f.input.plan.signature);
 assert.equal((await f.run()).job.id,j.id);assert.equal(f.calls.length,1);
});
test('new requests and concurrent requests cannot duplicate a source walkthrough job',async()=>{
 const f=fixture(),results=await Promise.all(Array.from({length:4},()=>f.run()));assert.equal(new Set(results.map(r=>r.job.id)).size,1);assert.equal(f.calls.length,1);
 f.input.requestId=randomUUID();f.input.sourceRevision=f.rows.get('jobs/w1').revision;
 await assert.rejects(f.run(),e=>e.code==='handoff_existing_job');
});
test('unknown commit result recovers exact receipt; changed request content cannot overwrite it',async()=>{
 const f=fixture();f.after(()=>{throw new Error('response lost');});const a=await f.run(),b=await f.run();assert.equal(a.job.id,b.job.id);assert.equal(f.calls.length,1);
 f.input.plan.quote.total=1600;f.input.plan.quote.deposit=800;await assert.rejects(f.run(),e=>e.code==='handoff_idempotency_conflict');
});
for(const key of ['customers/c1','jobs/w1','projects/p1'])test('atomic handoff fails on concurrent dependency change: '+key,async()=>{
 const f=fixture();f.before(()=>{f.rows.get(key).revision='changed';});await assert.rejects(f.run(),e=>e.code==='dispatch_revision_conflict');assert.equal(f.calls.length,0);assert.equal(f.rows.has('walkthroughHandoffs/'+f.input.requestId),false);
});
test('preparation resolves existing job and exact revisions without creating any record',async()=>{
 const f=fixture(),a=await prepareHandoff(f.store,owner,{sourceWalkthroughId:'w1'});assert.equal(a.customerId,'c1');assert.equal(a.sourceRevision,'w1r');assert.equal(f.calls.length,0);
 const saved=await f.run(),b=await prepareHandoff(f.store,owner,{sourceWalkthroughId:'w1'});assert.equal(b.jobId,saved.job.id);assert.equal(b.expectedRevision,saved.job.revision);assert.equal(f.calls.length,1);
});
test('changed finance, cancellation and false source identity are not reported as replay success',async()=>{
 const f=fixture(),saved=await f.run(),j=f.rows.get('jobs/'+saved.job.id);j.estimate.amount=99;await assert.rejects(f.run(),e=>e.code==='handoff_sync_snapshot_changed');
 j.estimate.amount=1400;j.status=j.pipelineStatus='cancelled';await assert.rejects(f.run(),e=>e.code==='handoff_sync_snapshot_changed');
 const g=fixture();g.input.plan.client.phone='9705550999';await assert.rejects(g.run(),e=>e.code==='handoff_customer_mismatch');assert.equal(g.calls.length,0);
});
test('explicit signed revision preserves deposit receipts/payment and archives prior acceptance',async()=>{
 const f=fixture(),first=await f.run(),j=f.rows.get('jobs/'+first.job.id);j.deposit={...j.deposit,paidAmount:700,status:'paid',providerReceiptId:'receipt-1'};j.payment={verified:true,amount:700,receiptId:'receipt-1'};j.invoice={amount:1400,status:'open',number:'inv-1'};
 f.input={...f.input}; // run closure uses the same input object below.
 const changed={...f.input,requestId:randomUUID(),sourceRevision:f.rows.get('jobs/w1').revision,jobId:first.job.id,expectedRevision:j.revision,plan:{...plan(),quote:{...plan().quote,total:1800,deposit:900}}};
 const r=await saveWalkthroughHandoff(f.store,owner,changed,NOW),current=f.rows.get('jobs/'+r.job.id);
 assert.equal(current.deposit.paidAmount,700);assert.equal(current.deposit.providerReceiptId,'receipt-1');assert.equal(current.payment.receiptId,'receipt-1');assert.equal(current.deposit.status,'partial');assert.equal(current.invoice.status,'superseded');assert.equal(f.rows.get('walkthroughHandoffs/'+changed.requestId).priorEstimate.amount,1400);
});
test('work already started cannot be silently replaced with a revised signed handoff',async()=>{
 const f=fixture(),r=await f.run(),j=f.rows.get('jobs/'+r.job.id);j.fieldLastActionAt=NOW;
 await assert.rejects(saveWalkthroughHandoff(f.store,owner,{...f.input,requestId:randomUUID(),sourceRevision:f.rows.get('jobs/w1').revision,jobId:j.id,expectedRevision:j.revision},NOW),e=>e.code==='handoff_work_started');
});
test('Denver wall times do not trust browser-supplied UTC values and DST gaps fail',()=>{
 const p=plan();p.quote.start_at='2026-09-24T00:00:00.000Z';assert.equal(normalizeHandoffPlan(p,NOW).quote.start_at,'2026-09-24T15:00:00.000Z');p.quote.job_date='2026-03-08';p.quote.start_time='02:30';assert.throws(()=>normalizeHandoffPlan(p,NOW),e=>e.code==='handoff_invalid_schedule');
});
test('acceptance requires original timestamp, signature, explicit terms and exact money',()=>{
 for(const change of [p=>p.terms_accepted=false,p=>p.signature='',p=>p.acceptance.accepted_at='',p=>p.quote.deposit=1,p=>p.quote.total=NaN,p=>p.acceptance.terms_version='other']){const p=plan();change(p);assert.throws(()=>normalizeHandoffPlan(p,NOW));}
});
test('provider synchronization hydrates signed saved job, not browser money or original draft ID',async()=>{
 const f=fixture(),r=await f.run(),j=f.rows.get('jobs/'+r.job.id),p=savedHandoffPayload(j,f.input.requestId);assert.equal(p.job_id,j.id);assert.equal(p.quote.total,1400);assert.equal(p.quote.start_at,'2026-09-24T15:00:00.000Z');assert.equal(p.client.highlevel_appointment_id,'walk-provider');assert.equal(p.signature,undefined);
});
test('handoff API enforces owner/manager sessions, same origin and bounded JSON',async()=>{
 const f=fixture();const req=(body,headers={})=>new Request('https://easygaragecleaning.com/api/walkthrough-handoff',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://easygaragecleaning.com',...headers},body:JSON.stringify(body)});
 for(const actor of [null,{user:'crew1',role:'crew',businessAccess:false}]){const h=handoffHandlers({session:async()=>actor,storage:()=>f.store});assert([401,403].includes((await h.post({request:req(f.input),env:{}})).status));}
 const h=handoffHandlers({session:async()=>owner,storage:()=>f.store});assert.equal((await h.post({request:req(f.input,{Origin:'https://other.invalid'}),env:{}})).status,403);assert.equal((await h.post({request:req(f.input,{'Content-Length':'400000'}),env:{}})).status,413);assert.equal(f.calls.length,0);
});


test('an explicitly missing job is not silently treated as a new handoff',async()=>{
 const f=fixture();await assert.rejects(prepareHandoff(f.store,owner,{jobId:'missing-job'}),e=>e.code==='handoff_job_missing');assert.equal(f.calls.length,0);
});

test('walkthrough-only reference photos do not block an intentional newly signed quote revision',async()=>{
 const f=fixture(),r=await f.run(),j=f.rows.get('jobs/'+r.job.id);
 j.fieldExecution={photos:[{id:randomUUID(),category:'walkthrough',verified:true,fileId:'private-reference'}]};
 const change={...f.input,requestId:randomUUID(),sourceRevision:f.rows.get('jobs/w1').revision,jobId:j.id,expectedRevision:j.revision};
 const updated=await saveWalkthroughHandoff(f.store,owner,change,NOW);assert.equal(updated.job.id,j.id);
 assert.equal(f.rows.get('jobs/'+j.id).fieldExecution.photos[0].category,'walkthrough');
});
