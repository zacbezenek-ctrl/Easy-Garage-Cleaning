import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adoptScheduledVisit,adoptionStorage} from '../functions/_lib/operations-adoption.js';
import {calendarItem,portalEvidence,portalJob} from '../functions/_lib/operations-portal-records.js';
import {encodeFirestoreFields} from '../functions/_lib/firestore-job.js';
const now='2026-09-22T07:00:00.000Z',actor={id:'booking-adoption-worker',kind:'integration',role:'integration',workspace:'egc'};
const sourceJob='0b3b9a28-2135-4353-8cb7-ddd9e9bd977a',localAppointment='9b1ce5d8-ae67-432e-b761-a0222d9ff6ed';
const proof=()=>({source:'ghl_appointment',sourceId:'provider-appointment',sourceRevision:'verified-r1',contactProviderId:'provider-contact',providerContact:{id:'provider-contact',name:'Synthetic Customer',phone:'+12025550199',email:'synthetic@example.invalid'},kind:'walkthrough',startAt:'2026-09-22T20:15:00.000Z',endAt:'2026-09-22T20:45:00.000Z',address:'100 Synthetic Lane',title:'Synthetic walkthrough',originalBookingAt:'2026-09-20T16:05:00.000Z',sourceCreatedAt:'2026-09-20T16:05:00.000Z',verifiedAt:now,providerAppointmentId:'provider-appointment',providerCalendarId:'walkthrough-calendar',providerStatus:'confirmed',localJobId:sourceJob,normalizedLocalAppointmentId:localAppointment,evidenceIds:['appointment:provider-appointment','call:confirmed-booking']});
const input=(change={})=>({command:'schedule.adopt',requestId:randomUUID(),proof:{...proof(),...change}});
const operationalScope=()=>({sourceType:'local_job',sourceId:sourceJob,sourceCreatedAt:'2026-09-18T18:00:00Z',sourceUpdatedAt:'2026-09-20T18:00:00Z',serviceType:'Garage relocation',accessNotes:'Use side gate; source note says discussed $139 pickup',itemsKeep:['Keep shelving'],itemsRelocate:['Move garage items to room','Rotate tool cabinet'],itemsRemove:['Bagged debris'],estimatedLaborHours:5});
function fixture(){
 const rows=new Map();let revision=0,commits=0;
 const normPhone=v=>String(v||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,''),normEmail=v=>String(v||'').trim().toLowerCase();
 const store={read:async(c,id)=>structuredClone(rows.get(`${c}/${id}`)||null),customers:async provider=>[...rows.entries()].filter(([k,v])=>k.startsWith('customers/')&&v.highlevelContactId===provider).map(([,v])=>structuredClone(v)),identityCandidates:async contact=>[...rows.entries()].filter(([k,v])=>k.startsWith('customers/')&&!v.highlevelContactId&&(normPhone(contact.phone)&&normPhone(v.phone)===normPhone(contact.phone)||normEmail(contact.email)&&normEmail(v.email)===normEmail(contact.email))).map(([,v])=>structuredClone(v)),snapshot:async()=>[...rows.entries()].filter(([k,v])=>k.startsWith('jobs/')&&!v.recordType).map(([,v])=>structuredClone(v)),commit:async writes=>{
  for(const w of writes){const current=rows.get(`${w.collection}/${w.id}`);if(w.revision?current?.revision!==w.revision:Boolean(current))throw new Error('schedule_revision_conflict');}
  for(const w of writes)rows.set(`${w.collection}/${w.id}`,{...rows.get(`${w.collection}/${w.id}`),...structuredClone(w.patch),id:w.id,revision:`revision-${++revision}`});commits++;
 }};
 return{rows,store,commits:()=>commits,visits:()=>[...rows.values()].filter(v=>v.type==='walkthrough'||v.type==='job')};
}
test('verified adoption commits exact customer, provider IDs, original occurrence, project and one day lock',async()=>{
 const f=fixture(),i=input(),r=await adoptScheduledVisit(f.store,actor,i,now),v=f.rows.get('jobs/'+r.jobId);
 assert.equal(r.authority,'employee_hub');assert.equal(r.adopted,true);assert.equal(r.duplicate,false);assert.equal(v.highlevelAppointmentId,i.proof.sourceId);assert.equal(v.normalizedLocalJobId,sourceJob);assert.equal(v.normalizedLocalAppointmentId,localAppointment);assert.equal(v.createdAt,i.proof.originalBookingAt);assert.equal(v.adoptedAt,now);assert.equal(v.date,'2026-09-22');assert.equal(v.time,'14:15');assert.equal(v.endTime,'14:45');assert.equal(v.syncStatus,'synced');assert.equal(v.type,'walkthrough');assert.equal(f.rows.get('customers/'+r.portalCustomerId).highlevelContactId,'provider-contact');assert.equal(f.rows.get('projects/'+v.projectId).sourceRecordId,r.jobId);assert.equal(f.rows.get('jobs/_egc_schedule_lock_2026-09-22').entries.length,1);assert.equal(f.commits(),1);assert.equal(v.price,undefined);assert.equal(v.payment,undefined);
});
test('local commitment remains provider pending and never invents value, appointment or occurrence time',async()=>{
 const f=fixture(),r=await adoptScheduledVisit(f.store,actor,input({source:'local_job',sourceId:sourceJob,providerAppointmentId:null,providerCalendarId:null,providerStatus:null,normalizedLocalAppointmentId:null,originalBookingAt:null,sourceCreatedAt:null}),now),v=f.rows.get('jobs/'+r.jobId);
 assert.equal(v.syncStatus,'pending');assert.equal(v.highlevelAppointmentId,undefined);assert.equal(v.createdAt,null);assert.equal(v.estimate,undefined);
});
test('repeated source and request are one visit despite new verification time and fresh request UUID',async()=>{
 const f=fixture(),i=input(),a=await adoptScheduledVisit(f.store,actor,i,now),b=await adoptScheduledVisit(f.store,actor,{...i,proof:{...i.proof,verifiedAt:'2026-09-22T07:00:01.000Z'}},'2026-09-22T07:00:02.000Z'),c=await adoptScheduledVisit(f.store,actor,{...i,requestId:randomUUID()},now);
 assert.equal(a.jobId,b.jobId);assert.equal(a.jobId,c.jobId);assert.equal(b.replayed,true);assert.equal(f.visits().length,1);assert.equal(f.commits(),1);
});
test('ambiguous successful commit is reread without retrying writes',async()=>{const f=fixture(),commit=f.store.commit;f.store.commit=async writes=>{await commit(writes);throw new Error('network response unknown');};const r=await adoptScheduledVisit(f.store,actor,input(),now);assert.equal(r.ok,true);assert.equal(f.commits(),1);assert.equal(f.visits().length,1);});
test('concurrent same source adopts once; concurrent different customers cannot occupy one slot',async()=>{
 const f=fixture(),i=input(),results=await Promise.all(Array.from({length:6},()=>adoptScheduledVisit(f.store,actor,i,now)));assert.equal(new Set(results.map(r=>r.jobId)).size,1);assert.equal(f.commits(),1);
 const g=fixture(),second=input({sourceId:'appointment-two',providerAppointmentId:'appointment-two',contactProviderId:'contact-two',providerContact:{id:'contact-two'},localJobId:null,normalizedLocalAppointmentId:null});const competing=await Promise.allSettled([adoptScheduledVisit(g.store,actor,input(),now),adoptScheduledVisit(g.store,actor,second,now)]);assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);assert.equal(g.visits().length,1);
});
test('changed source revision or source under same request cannot reuse receipt',async()=>{const f=fixture(),i=input();await adoptScheduledVisit(f.store,actor,i,now);await assert.rejects(adoptScheduledVisit(f.store,actor,{...i,proof:{...i.proof,sourceRevision:'r2'}},now),/idempotency_conflict/);await assert.rejects(adoptScheduledVisit(f.store,actor,{...i,proof:{...i.proof,sourceId:'other',providerAppointmentId:'other'}},now),/idempotency_conflict/);assert.equal(f.visits().length,1);});
test('cancelled adopted visit cannot be revived by source retry or fresh UUID',async()=>{const f=fixture(),i=input(),r=await adoptScheduledVisit(f.store,actor,i,now);Object.assign(f.rows.get('jobs/'+r.jobId),{status:'cancelled',pipelineStatus:'cancelled'});await assert.rejects(adoptScheduledVisit(f.store,actor,i,now),/changed_since_operation/);await assert.rejects(adoptScheduledVisit(f.store,actor,{...i,requestId:randomUUID()},now),/changed_since_operation/);assert.equal(f.commits(),1);});
const existing=(extra={})=>({id:'existing',type:'walkthrough',date:'2026-09-22',time:'14:15',endTime:'14:45',highlevelContactId:'provider-contact',address:'100 Synthetic Lane',status:'scheduled',pipelineStatus:'scheduled',revision:'r1',...extra});
test('exact existing Hub visit is linked once without changing its financial fields or original date',async()=>{const f=fixture();f.rows.set('jobs/existing',existing({createdAt:'2026-09-19T13:00:00Z',estimate:{accepted:true,total:777},notes:'retain'}));const r=await adoptScheduledVisit(f.store,actor,input(),now);assert.equal(r.jobId,'existing');assert.equal(r.adopted,false);assert.equal(f.visits().length,1);const v=f.rows.get('jobs/existing');assert.equal(v.createdAt,'2026-09-19T13:00:00Z');assert.equal(v.estimate.total,777);assert.equal(v.notes,'retain');});

test('new adopted work preserves exact source-linked operational scope without creating financial state',async()=>{
 const f=fixture(),scope=operationalScope(),i=input({kind:'job',operationalScope:scope}),r=await adoptScheduledVisit(f.store,actor,i,now),v=f.rows.get('jobs/'+r.jobId);
 assert.deepEqual(v.adoptionOperationalScope,scope);assert.equal(v.originalServiceType,'Garage relocation');assert.equal(v.serviceType,'Garage relocation');assert.equal(v.operationalScope.sourceId,sourceJob);assert.equal(v.operationalScope.sourceRevision,i.proof.sourceRevision);assert.equal(v.operationalScope.approvalKind,'staff_operational_instructions');assert.match(v.operationalScope.text,/Move garage items to room/);assert.match(v.operationalScope.text,/discussed \$139 pickup/);assert.match(v.operationalScope.text,/Estimated labor hours: 5/);
 for(const key of ['price','total','estimate','acceptance','customerApproval','deposit','payment','signature'])assert.equal(v[key],undefined);
 const raw={name:'projects/test/databases/(default)/documents/jobs/'+v.id,updateTime:v.revision,fields:encodeFirestoreFields(v)},detail=await portalJob({},v.id,async()=>new Response(JSON.stringify(raw)));
 assert.deepEqual(detail.job.adoptionOperationalScope,scope);assert.equal(detail.job.operationalScope.text,v.operationalScope.text);
});

test('existing native instructions and original service remain authoritative when adoption links a visit',async()=>{
 const f=fixture(),savedScope={text:'Native reviewed instructions',updatedBy:'manager',approvalKind:'staff_operational_instructions'};f.rows.set('jobs/existing',existing({jobInstructions:'Signed native scope',operationalScope:savedScope,serviceType:'Native selected service'}));
 const r=await adoptScheduledVisit(f.store,actor,input({operationalScope:operationalScope()}),now),v=f.rows.get('jobs/'+r.jobId);assert.equal(r.adopted,false);assert.equal(v.jobInstructions,'Signed native scope');assert.deepEqual(v.operationalScope,savedScope);assert.equal(v.serviceType,'Native selected service');assert.equal(v.adoptionOperationalScope,undefined);
});

test('scope identity, dates, structured financial fields, item shape and size are validated before writes',async()=>{
 for(const change of [{sourceId:randomUUID()},{sourceCreatedAt:'not-a-date'},{itemsKeep:'strings are not item arrays'},{itemsRemove:[{amount:139}]},{estimatedLaborHours:Infinity},{priceCents:13900},{itemsRelocate:Array(101).fill('item')},{accessNotes:'x'.repeat(10001)},{itemsKeep:Array(19).fill('x'.repeat(1000))}]){const f=fixture();await assert.rejects(adoptScheduledVisit(f.store,actor,input({operationalScope:{...operationalScope(),...change}}),now),/operational_scope_invalid/);assert.equal(f.commits(),0);}
});

test('source scope is part of the deterministic receipt fingerprint',async()=>{
 const f=fixture(),i=input({operationalScope:operationalScope()});await adoptScheduledVisit(f.store,actor,i,now);
 await assert.rejects(adoptScheduledVisit(f.store,actor,{...i,proof:{...i.proof,operationalScope:{...i.proof.operationalScope,itemsRelocate:['Different scope']}}},now),/idempotency_conflict/);assert.equal(f.commits(),1);
});
test('cancelled tombstones and duplicate semantic visits fail without writes',async()=>{for(const rows of [[existing({status:'cancelled',pipelineStatus:'cancelled'})],[existing(),existing({id:'duplicate'})]]){const f=fixture();for(const r of rows)f.rows.set('jobs/'+r.id,r);await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/terminal_tombstone|duplicate_suspected/);assert.equal(f.commits(),0);}});
test('exact appointment linked to wrong customer/time cannot create another visit',async()=>{const f=fixture();f.rows.set('jobs/wrong',existing({id:'wrong',highlevelContactId:'other',highlevelAppointmentId:'provider-appointment'}));await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/existing_source_conflict/);assert.equal(f.commits(),0);});
test('conflicting source schedule, customer and provider identity stop adoption',async()=>{for(const extra of [{endTime:'15:15'},{customerId:'different-customer'},{highlevelAppointmentId:'different-provider'},{address:'Unverified different address'}]){const f=fixture();f.rows.set('jobs/existing',existing(extra));await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/existing_visit_conflict/);assert.equal(f.commits(),0);}});
test('ambiguous customer mappings cannot be collapsed by name',async()=>{const f=fixture();for(const id of ['a','b'])f.rows.set('customers/'+id,{id,highlevelContactId:'provider-contact',name:'Same name'});await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/customer_ambiguous/);assert.equal(f.commits(),0);});
test('unlinked manual customers with exact normalized phone or email block instead of being silently merged or duplicated',async()=>{
 for(const details of [{phone:'(202) 555-0199'},{email:'  SYNTHETIC@EXAMPLE.INVALID  '},{phone:'+1 202 555 0199',email:'different@example.invalid'}]){const f=fixture(),manual={id:'manual',name:'Different display name',...details};f.rows.set('customers/manual',manual);await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/customer_identity_requires_manager/);assert.equal(f.commits(),0);assert.deepEqual(f.rows.get('customers/manual'),manual);assert.equal([...f.rows.keys()].filter(k=>k.startsWith('customers/')).length,1);}
 const f=fixture();f.rows.set('customers/same-name',{id:'same-name',name:'Synthetic Customer',phone:'2025550188',email:'other@example.invalid'});assert.equal((await adoptScheduledVisit(f.store,actor,input(),now)).adopted,true);
});
test('a failed manual identity scan blocks adoption before customer or visit writes',async()=>{const f=fixture();f.store.identityCandidates=async()=>{throw new Error('schedule_adoption_customer_scan_unavailable');};await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/customer_scan_unavailable/);assert.equal(f.commits(),0);assert.equal(f.rows.size,0);});
test('customer identity guard is read before lookup and shares manager CAS payload',async()=>{
 const f=fixture(),calls=[],read=f.store.read,customers=f.store.customers;
 f.rows.set('customerIdentityState/revision',{id:'revision',revision:'guard1',otherField:'preserve'});
 f.store.read=async(c,id)=>{calls.push(`${c}/${id}`);return read(c,id);};f.store.customers=async provider=>{calls.push('customer-lookup');return customers(provider);};const i=input();await adoptScheduledVisit(f.store,actor,i,now);
 assert.ok(calls.indexOf('customerIdentityState/revision')<calls.indexOf('customer-lookup'));
 const guard=f.rows.get('customerIdentityState/revision');assert.equal(guard.lastRequestId,i.requestId);assert.equal(guard.updatedAt,now);assert.equal(guard.otherField,'preserve');assert.notEqual(guard.revision,'guard1');
});
test('concurrent manager identity creation invalidates adoption atomically and retry reuses exact manager customer',async()=>{
 const f=fixture(),commit=f.store.commit,i=input();let race=true;
 f.store.commit=async writes=>{if(race){race=false;f.rows.set('customers/manager-created',{id:'manager-created',highlevelContactId:'provider-contact',revision:'manager-customer'});f.rows.set('customerIdentityState/revision',{id:'revision',updatedAt:now,lastRequestId:'manager-request',revision:'manager-guard'});}return commit(writes);};
 await assert.rejects(adoptScheduledVisit(f.store,actor,i,now),/revision_conflict/);assert.equal(f.visits().length,0);assert.equal(f.commits(),0);assert.equal([...f.rows.keys()].filter(k=>k.startsWith('customers/')).length,1);
 const result=await adoptScheduledVisit(f.store,actor,i,now);assert.equal(result.portalCustomerId,'manager-created');assert.equal([...f.rows.keys()].filter(k=>k.startsWith('customers/')).length,1);assert.equal(f.visits().length,1);
});
test('incomplete or failed source snapshot never means no collision',async()=>{const f=fixture();f.store.snapshot=async()=>{throw new Error('source unavailable');};await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/source unavailable/);assert.equal(f.commits(),0);});
test('live Hub schedule change during exact reread is not overwritten',async()=>{const f=fixture();f.rows.set('jobs/existing',existing());const read=f.store.read;f.store.read=async(c,id)=>c==='jobs'&&id==='existing'?existing({time:'16:00',endTime:'16:30',revision:'r2'}):read(c,id);await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/source_changed/);assert.equal(f.commits(),0);});
test('availability entries do not occupy calendar; dispatch state and other lock entries survive',async()=>{const f=fixture();f.rows.set('jobs/_egc_schedule_lock_2026-09-22',{id:'_egc_schedule_lock_2026-09-22',recordType:'schedule_lock',revision:'lock1',dispatchState:{revision:12,keep:true},entries:[{id:'available',type:'availability',assignedCrew:['crew'],start:'08:00',end:'18:00'},{id:'earlier',start:'10:00',end:'11:00'}]});await adoptScheduledVisit(f.store,actor,input(),now);const lock=f.rows.get('jobs/_egc_schedule_lock_2026-09-22');assert.equal(lock.entries.length,3);assert.deepEqual(lock.dispatchState,{revision:12,keep:true});});
test('existing malformed day locks fail closed and are never replaced with an empty conflict set',async()=>{
 const good={id:'one',type:'job',start:'10:00',end:'11:00',assignedCrew:['crew-a'],vehicleId:'van-1'};
 for(const entries of [undefined,null,{},[null],[{}],[{...good,id:''}],[{...good,start:'99:00'}],[{...good,end:'09:00'}],[{...good,assignedCrew:'crew-a'}],[good,good]]){const f=fixture(),row={id:'_egc_schedule_lock_2026-09-22',recordType:'schedule_lock',revision:'lock1',dispatchState:{revision:9},entries};f.rows.set('jobs/'+row.id,structuredClone(row));await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/day_lock_invalid/);assert.deepEqual(f.rows.get('jobs/'+row.id),row);assert.equal(f.commits(),0);}
});
test('global lock, legacy same-day visit and prior-day multi-day visit each block overlaps',async()=>{
 for(const entry of [{collection:'jobs',row:existing({id:'other',highlevelContactId:'other'})},{collection:'jobs',row:existing({id:'multi',highlevelContactId:'other',date:'2026-09-21',endDate:'2026-09-23',time:'10:00',endTime:'11:00'})},{collection:'jobs',row:{id:'_egc_schedule_lock_2026-09-22',revision:'lock1',recordType:'schedule_lock',entries:[{id:'blocking',type:'blocked',start:'14:00',end:'15:00'}]}}]){const f=fixture();f.rows.set(entry.collection+'/'+entry.row.id,entry.row);await assert.rejects(adoptScheduledVisit(f.store,actor,input(),now),/slot_conflict/);assert.equal(f.commits(),0);}
});
test('expired/unbounded/ambiguous and mismatched proof is rejected before reads',async()=>{
 const f=fixture();for(const changed of [{verifiedAt:'2026-09-22T06:00:00Z'},{providerContact:{id:'other'}},{sourceId:'other'},{providerStatus:'cancelled'},{localJobId:'not-a-uuid'},{startAt:'2026-09-21T20:15:00Z'},{startAt:'2026-09-22T23:15:00Z',endAt:'2026-09-23T08:00:00Z'},{startAt:'2026-11-01T07:15:00Z',endAt:'2026-11-01T07:45:00Z'},{runAutomations:true}])await assert.rejects(adoptScheduledVisit(f.store,actor,input(changed),now),/schedule_adoption_/);assert.equal(f.commits(),0);
 for(const other of [{...actor,id:'operations-api'},{...actor,kind:'human',role:'owner'},{...actor,workspace:'other'}])await assert.rejects(adoptScheduledVisit(f.store,other,input(),now),/internal_only/);
});
test('HTTP source reader includes tombstones and blocks malformed/repeated pagination',async()=>{
 const doc={name:'projects/test/databases/default/documents/jobs/cancelled',updateTime:'r1',fields:encodeFirestoreFields(existing({id:'cancelled',status:'cancelled'}))};const requests=[];const store=adoptionStorage({},async(_env,url)=>{requests.push(String(url));return new Response(JSON.stringify({documents:[doc]}));});const rows=await store.snapshot();assert.equal(rows[0].status,'cancelled');assert.ok(new URL(requests[0]).searchParams.getAll('mask.fieldPaths').includes('endDate'));
 for(const data of [{documents:{}},{documents:[],nextPageToken:'repeat'}])await assert.rejects(adoptionStorage({},async()=>new Response(JSON.stringify(data))).snapshot(),/source_incomplete/);
 await assert.rejects(adoptionStorage({},async()=>new Response('{}',{status:503})).snapshot(),/source_unavailable/);
});
test('manual identity scan is bounded, normalized, unlinked-only, and retains partial failure as unknown',async()=>{
 const doc=(id,fields)=>({name:'projects/test/databases/default/documents/customers/'+id,fields:encodeFirestoreFields(fields)});
 let calls=0;const pages=[{documents:[doc('manual-phone',{phone:'(202)555-0199'}),doc('linked',{phone:'2025550199',highlevelContactId:'another-provider'})],nextPageToken:'page2'},{documents:[doc('manual-email',{email:' SYNTHETIC@EXAMPLE.INVALID '}),doc('other',{phone:'2025550188'})]}];
 const store=adoptionStorage({},async(_env,url)=>{assert.ok(String(url).includes('/customers?'));assert.deepEqual(new URL(url).searchParams.getAll('mask.fieldPaths'),['phone','email','highlevelContactId']);return new Response(JSON.stringify(pages[calls++]));});
 assert.deepEqual((await store.identityCandidates(proof().providerContact)).map(x=>x.id),['manual-phone','manual-email']);assert.equal(calls,2);
 let count=0;await assert.rejects(adoptionStorage({},async()=>new Response(JSON.stringify({documents:[],nextPageToken:'page'+(++count)}))).identityCandidates(proof().providerContact),/customer_scan_incomplete/);assert.equal(count,20);
 await assert.rejects(adoptionStorage({},async()=>new Response('{}',{status:503})).identityCandidates(proof().providerContact),/customer_scan_unavailable/);
});
test('all Hub read adapters retain exact normalized mirror links and adoption provenance',async()=>{
 const row=existing({normalizedLocalJobId:sourceJob,normalizedLocalAppointmentId:localAppointment,adoptionSource:{type:'local_job',id:sourceJob},createdAt:'2026-09-20T16:05:00Z'}),doc={name:'projects/test/databases/default/documents/jobs/existing',updateTime:'r1',fields:encodeFirestoreFields(row)};
 const item=calendarItem(row,'America/Denver');assert.equal(item.normalizedLocalJobId,sourceJob);assert.equal(item.normalizedLocalAppointmentId,localAppointment);
 const job=await portalJob({},'existing',async()=>new Response(JSON.stringify(doc)));assert.equal(job.job.normalizedLocalJobId,sourceJob);
 const evidence=await portalEvidence({},{contactProviderIds:['provider-contact']},async (_env,url)=>{assert.ok(new URL(url).searchParams.getAll('mask.fieldPaths').includes('normalizedLocalAppointmentId'));return new Response(JSON.stringify({documents:[doc]}));});assert.equal(evidence.records[0].normalizedLocalAppointmentId,localAppointment);assert.equal(evidence.records[0].adoptionSource.type,'local_job');
});
