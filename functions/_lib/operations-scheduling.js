import {firestoreFetch} from './firebase-service-account.js';
import {encodeFirestoreFields,decodeFirestoreFields} from './firestore-job.js';
import {localInstant} from './operations-portal-records.js';
const ROOT='projects/egcw-1ec83/databases/(default)/documents';
const URL=`https://firestore.googleapis.com/v1/${ROOT}`;
const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(id)&&!/^(_egc_|secure_)/.test(id);
const uuid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id);
const visitKind=value=>value==='walkthrough'?'walkthrough':['job','cleanout','reorg'].includes(value)?'job':null;
const terminal=new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const failure=(code,status=409)=>Object.assign(new Error(code),{status});
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v);
const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const minutes=s=>/^\d\d:\d\d$/.test(s||'')?Number(s.slice(0,2))*60+Number(s.slice(3)):NaN;
const overlap=(a,b)=>minutes(a.time)<minutes(b.endTime)&&minutes(b.time)<minutes(a.endTime);
const scheduleState=visit=>({date:visit.date,...(visit.endDate&&visit.endDate!==visit.date?{endDate:visit.endDate}:{}),time:visit.time,endTime:visit.endTime,status:visit.pipelineStatus||visit.status,title:visit.title||null,address:visit.address||null,assignedTo:visit.assignedTo||null});
function fromDoc(doc){return{...decodeFirestoreFields(doc.fields||{}),id:String(doc.name||'').split('/').pop(),revision:doc.updateTime};}
export function schedulingStorage(env,fetcher=firestoreFetch){return{
  async customers(providerId){const r=await fetcher(env,`${URL}:runQuery`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({structuredQuery:{from:[{collectionId:'customers'}],where:{fieldFilter:{field:{fieldPath:'highlevelContactId'},op:'EQUAL',value:{stringValue:providerId}}},limit:3}}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw failure('schedule_source_unavailable',503);const rows=await r.json();if(!Array.isArray(rows))throw failure('schedule_source_incomplete',503);return rows.filter(x=>x.document).map(x=>fromDoc(x.document));},
  async read(collection,id){const r=await fetcher(env,`${URL}/${collection}/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)});if(r.status===404)return null;if(!r.ok)throw failure('schedule_source_unavailable',503);return fromDoc(await r.json());},
  async day(date){const r=await fetcher(env,`${URL}:runQuery`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({structuredQuery:{from:[{collectionId:'jobs'}],where:{fieldFilter:{field:{fieldPath:'date'},op:'EQUAL',value:{stringValue:date}}},limit:501}}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw failure('schedule_source_unavailable',503);const rows=await r.json();if(!Array.isArray(rows)||rows.length>500)throw failure('schedule_source_incomplete',503);return rows.filter(x=>x.document).map(x=>fromDoc(x.document));},
  async commit(writes){let r;try{r=await fetcher(env,`${URL}:commit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({writes:writes.map(w=>({update:{name:`${ROOT}/${w.collection}/${w.id}`,fields:encodeFirestoreFields(w.patch)},updateMask:{fieldPaths:Object.keys(w.patch)},currentDocument:w.revision?{updateTime:w.revision}:{exists:false}}))}),signal:AbortSignal.timeout(15000)});}catch{throw failure('schedule_commit_outcome_unknown',503);}if(!r.ok)throw failure([409,412].includes(r.status)?'schedule_revision_conflict':'schedule_commit_outcome_unknown',r.status>=500?503:409);return r.json();}
};}
function visitIdentity(visit,customer){
  if(!visit||!safeId(visit.id)||!visitKind(visit.type)||visit.recordType)throw failure('schedule_visit_not_found',404);
  if(!visit.customerId||!customer||customer.id!==visit.customerId)throw failure('schedule_customer_link_missing');
  if(visit.highlevelContactId&&customer.highlevelContactId&&visit.highlevelContactId!==customer.highlevelContactId)throw failure('schedule_contact_link_conflict');
  return {portalVisitId:visit.id,portalCustomerId:customer.id,portalProjectId:visit.projectId||null,revision:visit.revision,
    highlevelContactId:visit.highlevelContactId||customer.highlevelContactId||null,highlevelAppointmentId:visit.highlevelAppointmentId||null,
    type:visitKind(visit.type),sourceType:visit.type,date:visit.date,endDate:visit.endDate||visit.date,time:visit.time,endTime:visit.endTime,status:visit.pipelineStatus||visit.status,
    title:visit.title||visit.serviceType|| (visit.type==='walkthrough'?'EGC Free Walkthrough':'EGC Customer Job'),address:visit.address||customer.address||'',
    startTime:localInstant(visit.date,visit.time),endTimeInstant:localInstant(visit.endDate||visit.date,visit.endTime),syncStatus:visit.syncStatus||'unknown'};
}
export async function resolveScheduledVisit(store,id){
  if(!safeId(id))throw failure('schedule_visit_not_found',404);
  const visit=await store.read('jobs',id),customer=visit?.customerId?await store.read('customers',visit.customerId):null;
  return {ok:true,authority:'employee_hub',visit:visitIdentity(visit,customer)};
}

export async function linkScheduledCustomer(store,actor,input,now=new Date().toISOString()){
  if(actor.kind!=='integration'||actor.role!=='integration'||!safeId(input.portalVisitId))throw failure('schedule_customer_link_requires_integration',403);
  const visit=await store.read('jobs',input.portalVisitId),contact=input.providerContact||{};
  if(!visit||!visitKind(visit.type)||visit.revision!==input.expectedRevision||!safeId(contact.id))throw failure('schedule_customer_link_conflict');
  if(visit.highlevelContactId&&visit.highlevelContactId!==contact.id)throw failure('schedule_customer_link_conflict');
  if(!visit.highlevelContactId){
    const phone=v=>String(v||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,''),email=v=>String(v||'').trim().toLowerCase();
    const a=phone(visit.phone),b=phone(contact.phone),c=email(visit.email),d=email(contact.email);
    if(a&&b&&a!==b||c&&d&&c!==d||!(a&&a===b||c&&c===d))throw failure('schedule_customer_matching_requires_review');
  }
  let customer=visit.customerId?await store.read('customers',visit.customerId):null;
  if(visit.customerId&&(!customer||customer.highlevelContactId&&customer.highlevelContactId!==contact.id))throw failure('schedule_customer_link_conflict');
  if(!customer){const matches=await store.customers(contact.id);if(matches.length>1)throw failure('schedule_customer_link_ambiguous');customer=matches[0]||null;}
  const id=customer?.id||`ghl_${contact.id}`;
  if(!safeId(id))throw failure('schedule_customer_link_conflict');
  let root=visit;
  if(visit.sourceWalkthroughId){root=await store.read('jobs',visit.sourceWalkthroughId);if(!root||root.type!=='walkthrough'||root.customerId!==id)throw failure('schedule_source_walkthrough_link_conflict');}
  const projectId=visit.projectId||root.projectId||`project_${root.id}`,project=await store.read('projects',projectId);
  if(project&&(project.customerId!==id||project.sourceRecordId!==root.id))throw failure('schedule_project_link_conflict');
  const writes=[{collection:'jobs',id:visit.id,revision:visit.revision,patch:{customerId:id,projectId,highlevelContactId:contact.id,providerSyncOwner:'operations',updatedAt:now}}];
  if(root.id!==visit.id&&!root.projectId)writes.push({collection:'jobs',id:root.id,revision:root.revision,patch:{projectId,updatedAt:now}});
  if(!project)writes.push({collection:'projects',id:projectId,patch:{id:projectId,customerId:id,sourceRecordId:root.id,sourceWalkthroughId:root.type==='walkthrough'?root.id:null,createdAt:now,updatedAt:now,authority:'employee_hub'}});
  if(!customer)writes.push({collection:'customers',id,patch:{id,name:contact.name||[contact.firstName,contact.lastName].filter(Boolean).join(' ')||visit.customer||'',phone:contact.phone||'',email:contact.email||'',address:visit.address||contact.address1||'',highlevelContactId:contact.id,createdAt:now,updatedAt:now,source:'verified_provider_contact'}});
  else if(!customer.highlevelContactId)writes.push({collection:'customers',id,revision:customer.revision,patch:{highlevelContactId:contact.id,updatedAt:now}});
  try{await store.commit(writes);}catch(error){const latest=await store.read('jobs',visit.id).catch(()=>null);if(!latest||latest.customerId!==id||latest.highlevelContactId!==contact.id)throw error;}
  return resolveScheduledVisit(store,visit.id);
}

/** Uses the Hub's existing jobs and per-day schedule-lock documents. The receipt,
 * visit and both affected day locks commit atomically with revision preconditions. */
export async function mutateScheduledVisit(store,actor,input,now=new Date().toISOString()){
  if(!uuid(input.requestId)||!safeId(input.portalCustomerId)||!['create','update','cancel'].includes(input.mode))throw failure('schedule_request_invalid',400);
  // The business identity survives fresh request IDs and different entry points.
  // Cancelled visits retain this identity and cannot be accidentally resurrected.
  const bookingKey=input.mode==='create'?await digest({customerId:input.portalCustomerId,kind:input.kind,date:input.changes?.date,time:input.changes?.time,timeZone:'America/Denver'}):null;
  const id=bookingKey?`visit_${bookingKey.slice(0,40)}`:input.portalVisitId;
  if(!safeId(id))throw failure('schedule_visit_not_found',404);
  const receiptId=`_egc_schedule_op_${input.requestId.replaceAll('-','')}`,hash=await digest({actor:actor.id,input});
  const previousReceipt=await store.read('jobs',receiptId);
  if(previousReceipt){
    if(previousReceipt.fingerprint!==hash)throw failure('schedule_idempotency_conflict');
    const live=await store.read('jobs',id);
    if(!live||await digest(scheduleState(live))!==previousReceipt.scheduleHash)throw failure('schedule_changed_since_operation');
    return {...await resolveScheduledVisit(store,id),replayed:true,requestId:input.requestId};
  }
  const current=await store.read('jobs',id),customer=await store.read('customers',input.portalCustomerId);
  if(!customer||customer.id!==input.portalCustomerId)throw failure('schedule_customer_not_found',404);
  if(input.mode==='create'&&current)throw failure('schedule_visit_already_exists');
  if(input.mode!=='create'){
    visitIdentity(current,customer);
    // Dispatch owns multi-day lock updates. The original single-day mutation
    // path must never truncate an interval or leave intermediate locks behind.
    if(current.endDate&&current.endDate!==current.date)throw failure('schedule_multiday_requires_dispatch');
    if(current.customerId!==input.portalCustomerId)throw failure('schedule_customer_link_conflict');
    if(!input.expectedRevision||current.revision!==input.expectedRevision)throw failure('schedule_revision_conflict');
    if(input.kind&&input.kind!==visitKind(current.type))throw failure('schedule_visit_kind_immutable');
    if(terminal.has(current.pipelineStatus||current.status)&&input.mode!=='cancel')throw failure('schedule_terminal_visit_requires_review');
  }
  const changes=input.changes||{},allowed=new Set(['date','time','endTime','title','assignedTo','address']);
  if(Object.keys(changes).some(k=>!allowed.has(k)))throw failure('schedule_patch_not_allowed',400);
  const kind=visitKind(current?.type)||input.kind;if(!['walkthrough','job'].includes(kind))throw failure('schedule_visit_kind_required',400);
  const patch={...changes,id,type:current?.type||kind,customerId:customer.id,customer:current?.customer||customer.name||'',
    highlevelContactId:current?.highlevelContactId||customer.highlevelContactId||'',scheduleSource:'egc_hub',providerSyncOwner:'operations',syncStatus:'pending',updatedAt:now};
  if(input.mode==='create')Object.assign(patch,{bookingKey,status:'scheduled',pipelineStatus:'scheduled',createdAt:now,createdBy:actor.id,phone:customer.phone||'',email:customer.email||'',address:changes.address||customer.address||'',serviceType:kind==='walkthrough'?'Free garage walkthrough':'Customer job'});
  if(input.mode==='cancel')Object.assign(patch,{status:'cancelled',pipelineStatus:'cancelled',cancelledAt:now,cancelledBy:actor.id});
  const projectWrites=[];
  if(input.mode==='create'){
    let projectId=`project_${id}`;
    if(input.sourceWalkthroughId){
      const source=await store.read('jobs',input.sourceWalkthroughId);
      if(kind!=='job'||!source||source.type!=='walkthrough'||source.customerId!==customer.id||!source.projectId)throw failure('schedule_source_walkthrough_link_conflict');
      const project=await store.read('projects',source.projectId);
      if(!project||project.customerId!==customer.id)throw failure('schedule_project_link_conflict');
      projectId=source.projectId;patch.sourceWalkthroughId=source.id;
    }else projectWrites.push({collection:'projects',id:projectId,patch:{id:projectId,customerId:customer.id,sourceRecordId:id,sourceWalkthroughId:kind==='walkthrough'?id:null,createdBy:actor.id,createdAt:now,updatedAt:now,authority:'employee_hub'}});
    patch.projectId=projectId;
  }
  const next={...current,...patch},start=localInstant(next.date,next.time),end=localInstant(next.date,next.endTime);
  if(!start||!end||end<=start)throw failure('schedule_time_invalid_or_ambiguous',400);
  const days=[...new Set([next.date,current?.date].filter(Boolean))],locks=[];
  for(const date of days){
    const lockId=`_egc_schedule_lock_${date}`,lock=await store.read('jobs',lockId),entries=(Array.isArray(lock?.entries)?lock.entries:[]).filter(x=>x.id!==id&&!terminal.has(x.status));
    if(date===next.date&&input.mode!=='cancel'){
      const existing=await store.day(date);
      const conflict=existing.find(x=>x.id!==id&&(visitKind(x.type)||x.type==='blocked')&&!terminal.has(x.pipelineStatus||x.status)&&overlap(next,x));
      if(conflict||entries.some(x=>overlap(next,{time:x.start,endTime:x.end})))throw failure('schedule_slot_conflict');
      entries.push({id,start:next.time,end:next.endTime,label:next.customer,status:next.status||'scheduled',updatedAt:now});
    }
    locks.push({collection:'jobs',id:lockId,revision:lock?.revision,patch:{recordType:'schedule_lock',date,entries,updatedAt:now}});
  }
  const writes=[{collection:'jobs',id,revision:current?.revision,patch},...projectWrites,...locks,{collection:'jobs',id:receiptId,patch:{recordType:'schedule_operation',fingerprint:hash,scheduleHash:await digest(scheduleState(next)),portalVisitId:id,actorId:actor.id,actorKind:actor.kind,requestId:input.requestId,mode:input.mode,before:current?{date:current.date,time:current.time,endTime:current.endTime,status:current.status,revision:current.revision}:null,after:{date:next.date,time:next.time,endTime:next.endTime,status:next.status},createdAt:now}}];
  try{await store.commit(writes);}catch(error){const receipt=await store.read('jobs',receiptId).catch(()=>null);if(!receipt||receipt.fingerprint!==hash)throw error;}
  const saved=await store.read('jobs',id);
  if(!saved||await digest(scheduleState(saved))!==await digest(scheduleState(next)))throw failure('schedule_changed_since_operation');
  return {ok:true,authority:'employee_hub',visit:visitIdentity(saved,customer),requestId:input.requestId};
}

/** Provider state is only attached after its exact identity and schedule match the
 * saved Hub visit. It never overwrites Hub dates, customer, scope, price or status. */
export async function bindScheduledProvider(store,actor,input,now=new Date().toISOString()){
  if(actor.kind!=='integration'||actor.role!=='integration')throw failure('schedule_provider_evidence_requires_integration',403);
  if(!uuid(input.operationId)||!safeId(input.portalVisitId))throw failure('schedule_request_invalid',400);
  const current=await store.read('jobs',input.portalVisitId),customer=current?.customerId?await store.read('customers',current.customerId):null;
  const identity=visitIdentity(current,customer),event=input.event||{};
  const receiptId=`_egc_schedule_provider_${input.operationId.replaceAll('-','')}`,receipt=await store.read('jobs',receiptId);
  if(receipt&&(receipt.providerAppointmentId!==event.id||receipt.portalVisitId!==input.portalVisitId))throw failure('schedule_idempotency_conflict');
  if(!event.id||event.contactId!==identity.highlevelContactId||(identity.highlevelAppointmentId&&event.id!==identity.highlevelAppointmentId))throw failure('schedule_provider_identity_conflict');
  const rawStatus=String(event.appointmentStatus||event.appoinmentStatus||event.status||'').toLowerCase();
  const providerStatus=({active:'confirmed',canceled:'cancelled',completed:'showed',no_show:'noshow','no-show':'noshow'})[rawStatus]||rawStatus;
  const state=String(identity.status).toLowerCase();
  const expectedStatus=['cancelled','canceled'].includes(state)?'cancelled':['completed','paid','invoiced','closed','review_requested'].includes(state)?'showed':['noshow','no_show','no-show'].includes(state)?'noshow':'confirmed';
  if(!identity.startTime||!identity.endTimeInstant||Date.parse(event.startTime)!==Date.parse(identity.startTime)||Date.parse(event.endTime)!==Date.parse(identity.endTimeInstant)||providerStatus!==expectedStatus)throw failure('schedule_provider_state_conflict');
  if(receipt)return {ok:true,authority:'employee_hub',visit:identity,replayed:true};
  if(current.revision!==input.expectedRevision)throw failure('schedule_revision_conflict');
  const patch={highlevelAppointmentId:event.id,highlevelCalendarId:event.calendarId||'',providerAppointmentStatus:providerStatus,syncStatus:'synced',syncedAt:now,updatedAt:now};
  try{await store.commit([{collection:'jobs',id:current.id,revision:current.revision,patch},{collection:'jobs',id:receiptId,patch:{recordType:'schedule_provider_receipt',portalVisitId:current.id,providerAppointmentId:event.id,operationId:input.operationId,actorId:actor.id,createdAt:now}}]);}catch(error){const recovered=await store.read('jobs',receiptId).catch(()=>null);if(!recovered||recovered.providerAppointmentId!==event.id)throw error;}
  return {...await resolveScheduledVisit(store,current.id),providerSync:'verified'};
}
