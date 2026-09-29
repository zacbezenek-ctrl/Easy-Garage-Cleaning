import {firestoreFetch} from './firebase-service-account.js';
import {encodeFirestoreFields,decodeFirestoreFields} from './firestore-job.js';
import {localInstant} from './operations-portal-records.js';
import {dispatchStorage} from './dispatch-storage.js';
import {scheduleRowsConflict,scheduleLockConflict,scheduleDayEntry} from './dispatch-conflicts.js';
import {arrivalWindowProblem,arrivalWindowFields} from './dispatch-arrival.js';
import {DISPATCH_TIME_ZONE} from './dispatch-contract.js';
import {legacyBlockMode,legacyBlockedDays} from './dispatch-legacy-blocks.js';
import {customerIdentityFields,withCustomerSearchKeys} from './customer-identity.js';
import {segmented} from './dispatch-segments.js';
import {crewNotificationWrites,crewNotificationsEnabled} from './crew-notifications.js';
import {reasonInput,cancelPatch,visitFunnelWrites,requestKey,eventActor,eventVia,defaultVisitPurpose} from './dispatch-funnel.js';
import {eventDimensions,firstPlacementDimensions,legacyDimensionFacts,projectDimensionPatch,resolveDimensions,visitDimensionFacts} from './funnel-dimensions.js';
import {commitConflict,commitFailure} from './firestore-errors.js';
import {bridgeCommandDenial,bridgeCommandPolicy} from '../../egc-platform/services/operations/src/bridge-command-policy.ts';
const ROOT='projects/egcw-1ec83/databases/(default)/documents';
const URL=`https://firestore.googleapis.com/v1/${ROOT}`;
const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(id)&&!/^(_egc_|secure_)/.test(id);
const uuid=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id);
const visitKind=value=>value==='walkthrough'?'walkthrough':['job','cleanout','reorg'].includes(value)?'job':null;
const terminal=new Set(['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show']);
const failure=(code,status=409)=>Object.assign(new Error(code),{status});
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v);
const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const scheduleState=visit=>({date:visit.date,...(visit.endDate&&visit.endDate!==visit.date?{endDate:visit.endDate}:{}),time:visit.time,endTime:visit.endTime,status:visit.pipelineStatus||visit.status,title:visit.title||null,address:visit.address||null,assignedTo:visit.assignedTo||null});
/** The visit's own sync key after a bridge schedule change: fresh per change, but minted
 * here so it never equals the caller's requestId. MCP egc.schedule_visit reuses that
 * requestId for its own schedule.sync_provider (automations off unless asked), while the
 * page's syncJobRecord sends this key with automations on; the appointment ledger never
 * takes two payloads under one key. The schedule-sync mirror appends ':mirror'. */
export const scheduleMutateSyncKey=requestId=>`schedule-mutate:${requestId}`;
/** A fresh sync key for a visit whose provider appointment drifted from the synced Hub schedule. */
export const scheduleDriftSyncKey=operationId=>`schedule-drift:${operationId}`;
function fromDoc(doc){return{...decodeFirestoreFields(doc.fields||{}),id:String(doc.name||'').split('/').pop(),revision:doc.updateTime};}
export function schedulingStorage(env,fetcher=firestoreFetch){return{
  resources:()=>dispatchStorage(env,fetcher).resources(),
  roster:()=>dispatchStorage(env,fetcher).roster(),
  settings:()=>dispatchStorage(env,fetcher).settings(),
  legacyBlockMode:legacyBlockMode(env),
  // EGC_CREW_NOTIFICATIONS_ENABLED: moves and cancellations queue crew notices in the same commit.
  crewNotificationsEnabled:crewNotificationsEnabled(env),
  legacyBlockedDays:dates=>dispatchStorage(env,fetcher).legacyBlockedDays(dates),
  async customers(providerId){const r=await fetcher(env,`${URL}:runQuery`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({structuredQuery:{from:[{collectionId:'customers'}],where:{fieldFilter:{field:{fieldPath:'highlevelContactId'},op:'EQUAL',value:{stringValue:providerId}}},limit:3}}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw failure('schedule_source_unavailable',503);const rows=await r.json();if(!Array.isArray(rows))throw failure('schedule_source_incomplete',503);return rows.filter(x=>x.document).map(x=>fromDoc(x.document));},
  async read(collection,id){const r=await fetcher(env,`${URL}/${collection}/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)});if(r.status===404)return null;if(!r.ok)throw failure('schedule_source_unavailable',503);return fromDoc(await r.json());},
  async day(date){const r=await fetcher(env,`${URL}:runQuery`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({structuredQuery:{from:[{collectionId:'jobs'}],where:{fieldFilter:{field:{fieldPath:'date'},op:'EQUAL',value:{stringValue:date}}},limit:501}}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw failure('schedule_source_unavailable',503);const rows=await r.json();if(!Array.isArray(rows)||rows.length>500)throw failure('schedule_source_incomplete',503);return rows.filter(x=>x.document).map(x=>fromDoc(x.document));},
  async commit(writes){let r;try{r=await fetcher(env,`${URL}:commit`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({writes:writes.map(w=>({update:{name:`${ROOT}/${w.collection}/${w.id}`,fields:encodeFirestoreFields(w.patch)},updateMask:{fieldPaths:Object.keys(w.patch)},currentDocument:w.revision?{updateTime:w.revision}:{exists:false}}))}),signal:AbortSignal.timeout(15000)});}catch{throw failure('schedule_commit_outcome_unknown',503);}if(!r.ok){if(commitConflict(await commitFailure(r)))throw failure('schedule_revision_conflict',409);throw failure('schedule_commit_outcome_unknown',r.status>=500?503:409);}return r.json();}
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
  // FUN-29: a project created for an existing visit takes its service line and path from the visit's records (the legacy mapping).
  if(!project)writes.push({collection:'projects',id:projectId,patch:{id:projectId,customerId:id,sourceRecordId:root.id,sourceWalkthroughId:root.type==='walkthrough'?root.id:null,createdAt:now,updatedAt:now,authority:'employee_hub',...projectDimensionPatch(null,resolveDimensions(legacyDimensionFacts({sourceWalkthroughId:root.type==='walkthrough'?root.id:null},[root,...(root.id===visit.id?[]:[visit])])),{actor:actor.id,now})}});
  if(!customer)writes.push({collection:'customers',id,patch:withCustomerSearchKeys({id,name:contact.name||[contact.firstName,contact.lastName].filter(Boolean).join(' ')||visit.customer||'',phone:contact.phone||'',email:contact.email||'',...customerIdentityFields(contact),address:visit.address||contact.address1||'',highlevelContactId:contact.id,createdAt:now,updatedAt:now,source:'verified_provider_contact'})});
  else if(!customer.highlevelContactId)writes.push({collection:'customers',id,revision:customer.revision,patch:{highlevelContactId:contact.id,...customerIdentityFields(customer),updatedAt:now}});
  // An already exact link is not rewritten: repeated provider syncs must not churn the
  // visit revision that the schedule-sync queue guards its failure backoff with.
  const linked=writes.length===1&&visit.customerId===id&&visit.projectId===projectId&&visit.highlevelContactId===contact.id&&visit.providerSyncOwner==='operations';
  if(!linked)try{await store.commit(writes);}catch(error){const latest=await store.read('jobs',visit.id).catch(()=>null);if(!latest||latest.customerId!==id||latest.highlevelContactId!==contact.id)throw error;}
  return resolveScheduledVisit(store,visit.id);
}

/** Uses the Hub's existing jobs and per-day schedule-lock documents. The receipt,
 * visit and both affected day locks commit atomically with revision preconditions. */
export async function mutateScheduledVisit(store,actor,input,now=new Date().toISOString(),{via='bridge'}={}){
  // SEC-04: the shared bridge policy's roles (owner/manager or integration) hold for every
  // caller; the signed bridge matched the exact integration principal before this runs.
  if(bridgeCommandDenial(actor,bridgeCommandPolicy({command:'schedule.mutate',mode:input?.mode}),{principals:false}))throw failure('schedule_actor_forbidden',403);
  if(!uuid(input.requestId)||!safeId(input.portalCustomerId)||!['create','update','cancel'].includes(input.mode))throw failure('schedule_request_invalid',400);
  // FUN-02: an optional reason on a move or cancel (codes from the shared funnel definitions).
  const reasonList=input.mode==='update'?'reschedule':input.mode==='cancel'?'cancel':null;
  if(!reasonList&&(input.reasonCode!==undefined||input.initiatedBy!==undefined))throw failure('schedule_reason_code_invalid',400);
  const reason=reasonList?reasonInput(input,reasonList,code=>failure(`schedule_${code}`,400)):{reasonCode:null,initiatedBy:null};
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
    // Split crews and per-day windows have per-segment locks only dispatch maintains.
    if(segmented(current))throw failure('schedule_segments_require_dispatch');
    if(current.endDate&&current.endDate!==current.date)throw failure('schedule_multiday_requires_dispatch');
    if(current.customerId!==input.portalCustomerId)throw failure('schedule_customer_link_conflict');
    if(!input.expectedRevision||current.revision!==input.expectedRevision)throw failure('schedule_revision_conflict');
    if(input.kind&&input.kind!==visitKind(current.type))throw failure('schedule_visit_kind_immutable');
    if(terminal.has(current.pipelineStatus||current.status)&&input.mode!=='cancel')throw failure('schedule_terminal_visit_requires_review');
    // A dispatch no-show (FUN-02) is a final fact: the bridge cannot relabel it a cancellation.
    if(input.mode==='cancel'&&['noshow','no_show','no-show'].includes(current.pipelineStatus||current.status))throw failure('schedule_terminal_visit_requires_review');
  }
  const changes=input.changes||{},allowed=new Set(['date','time','endTime','title','assignedTo','address']);
  if(Object.keys(changes).some(k=>!allowed.has(k)))throw failure('schedule_patch_not_allowed',400);
  if(Object.entries(changes).some(([key,value])=>typeof value!=='string'||value.length>({title:500,assignedTo:200,address:1000}[key]||10)))throw failure('schedule_patch_invalid',400);
  if(current?.assignedCrew?.length&&changes.assignedTo!==undefined&&changes.assignedTo!==current.assignedTo)throw failure('schedule_assignment_requires_dispatch');
  const kind=visitKind(current?.type)||input.kind;if(!['walkthrough','job'].includes(kind))throw failure('schedule_visit_kind_required',400);
  const patch={...changes,id,type:current?.type||kind,customerId:customer.id,customer:current?.customer||customer.name||'',
    highlevelContactId:current?.highlevelContactId||customer.highlevelContactId||'',scheduleSource:'egc_hub',providerSyncOwner:'operations',syncStatus:'pending',syncIdempotencyKey:scheduleMutateSyncKey(input.requestId),updatedAt:now};
  if(input.mode==='create')Object.assign(patch,{bookingKey,status:'scheduled',pipelineStatus:'scheduled',createdAt:now,createdBy:actor.id,phone:customer.phone||'',email:customer.email||'',address:changes.address||customer.address||'',serviceType:kind==='walkthrough'?'Free garage walkthrough':'Customer job',
    bookingChannel:actor.kind==='integration'?'mcp':null,channelSelfReported:null,bookedBy:actor.id,visitPurpose:defaultVisitPurpose(kind),crmLinkReason:null});
  // Cancelling an already cancelled visit keeps the original cancellation's time, actor and reason facts.
  if(input.mode==='cancel'&&!['cancelled','canceled'].includes(current.pipelineStatus||current.status))Object.assign(patch,{status:'cancelled',pipelineStatus:'cancelled',cancelledAt:now,cancelledBy:actor.id,...cancelPatch(reason,current,now)});
  const projectWrites=[];let dimensions=null;
  // Firestore cannot put read preconditions on a commit. Identity-field no-ops
  // fence the exact customer/source/project revisions together with the visit,
  // receipt and schedule locks; a changed lineage must abort the entire save.
  const identityWrites=[];
  const guardIdentity=(collection,record)=>{
    if(typeof record?.revision!=='string'||!record.revision)throw failure('schedule_source_unavailable',503);
    identityWrites.push({collection,id:record.id,revision:record.revision,patch:{id:record.id}});
  };
  guardIdentity('customers',customer);
  if(input.mode==='create'){
    let projectId=`project_${id}`;
    if(input.sourceWalkthroughId){
      const source=await store.read('jobs',input.sourceWalkthroughId);
      if(kind!=='job'||!source||source.type!=='walkthrough'||source.customerId!==customer.id||!source.projectId)throw failure('schedule_source_walkthrough_link_conflict');
      const project=await store.read('projects',source.projectId);
      if(!project||project.customerId!==customer.id)throw failure('schedule_project_link_conflict');
      guardIdentity('jobs',source);guardIdentity('projects',project);
      projectId=source.projectId;patch.sourceWalkthroughId=source.id;dimensions=eventDimensions(project);
    }else{
      // FUN-29: the new project's service line and funnel path from this booking's facts (no staff picks on the bridge).
      const fields=projectDimensionPatch(null,resolveDimensions(visitDimensionFacts({...patch,sourceWalkthroughId:undefined})),{actor:actor.id,now});dimensions=eventDimensions(fields);
      projectWrites.push({collection:'projects',id:projectId,patch:{id:projectId,customerId:customer.id,sourceRecordId:id,sourceWalkthroughId:kind==='walkthrough'?id:null,createdBy:actor.id,createdAt:now,updatedAt:now,authority:'employee_hub',highlevelContactId:patch.highlevelContactId,crmLinkReason:null,...fields}});
    }
    patch.projectId=projectId;
  }
  const next={...current,...patch},start=localInstant(next.date,next.time),end=localInstant(next.date,next.endTime);
  if(!start||!end||end<=start)throw failure('schedule_time_invalid_or_ambiguous',400);
  // Single-day visits keep the dispatch-derived instants in step with the wall time.
  Object.assign(patch,{endDate:next.date,startAt:start,endAt:end,timeZone:DISPATCH_TIME_ZONE});Object.assign(next,patch);
  // This path returns no warnings, so legacy calendar day blocks matter only when enforced.
  if(store.legacyBlockMode==='enforce'&&input.mode!=='cancel'&&(input.mode==='create'||['date','time','endTime'].some(key=>next[key]!==current?.[key]))){
    const legacy=await legacyBlockedDays(store,[next.date]).catch(()=>{throw failure('schedule_source_unavailable',503);});
    if(legacy.mode==='enforce'&&legacy.rows.length)throw failure('schedule_slot_conflict');
  }
  const dispatchGuard=await store.read('dispatchState','revision');
  const [resources,roster]=await Promise.all([store.resources?store.resources():[],store.roster?store.roster():[]]);
  if(input.mode!=='cancel'&&next.vehicleId&&!resources.some(row=>row.id===next.vehicleId&&row.recordType==='vehicle'&&row.status==='available'))throw failure('schedule_vehicle_unavailable');
  if(input.mode!=='cancel'&&resources.some(row=>row.recordType==='availability'&&scheduleRowsConflict(next,row,roster)))throw failure('schedule_slot_conflict');
  // Arrival windows are chosen in dispatch. This writer keeps a saved window that
  // still contains the start time, re-derives the default label, or rejects.
  if(input.mode!=='cancel'){
    if(arrivalWindowProblem(next))throw failure('schedule_arrival_window_requires_dispatch');
    const arrival=arrivalWindowFields(next,store.settings?await store.settings():{});
    for(const [key,value] of Object.entries(arrival))if((current?.[key]??null)!==value)patch[key]=value;
  }
  const days=[...new Set([next.date,current?.date].filter(Boolean))],locks=[];
  for(const date of days){
    const lockId=`_egc_schedule_lock_${date}`,lock=await store.read('jobs',lockId);
    if(lock&&(lock.recordType!=='schedule_lock'||!Array.isArray(lock.entries)))throw failure('schedule_lock_unavailable',503);
    const entries=(Array.isArray(lock?.entries)?lock.entries:[]).filter(x=>x.id!==id&&!terminal.has(x.status));
    if(date===next.date&&input.mode!=='cancel'){
      const existing=await store.day(date);
      const conflict=existing.find(x=>x.id!==next.id&&(visitKind(x.type)||x.type==='blocked'||x.type==='availability'||x.recordType==='crew_availability')&&(!terminal.has(x.pipelineStatus||x.status)&&x.customerId===next.customerId&&visitKind(x.type)===visitKind(next.type)&&x.date===next.date&&x.time===next.time||scheduleRowsConflict(next,x,roster)));
      if(conflict||entries.some(x=>scheduleLockConflict(next,x,date,roster)))throw failure('schedule_slot_conflict');
      entries.push(scheduleDayEntry(next,date,roster,now));
    }
    locks.push({collection:'jobs',id:lockId,revision:lock?.revision,patch:{recordType:'schedule_lock',date,entries,updatedAt:now}});
  }
  const assigned=input.mode!=='cancel'&&typeof changes.assignedTo==='string'&&Boolean(changes.assignedTo.trim())&&changes.assignedTo!==(current?.assignedTo||'');
  // FUN-29: an update that places a visit saved unscheduled books it with its project's values, as dispatch does.
  dimensions??=await firstPlacementDimensions(store,current,{...current,...patch});
  const funnel=await visitFunnelWrites({action:input.mode,before:current,after:{...current,...patch},actor:eventActor(actor),via:eventVia(via),key:requestKey(input.requestId),source:{collection:'jobs',id:receiptId},reason:{...reason,lateCancel:patch.lateCancel},crewChanged:assigned,dimensions,now});
  Object.assign(patch,funnel.patch);
  const writes=[{collection:'jobs',id,revision:current?.revision,patch},...projectWrites,...identityWrites,...locks,...funnel.writes,{collection:'dispatchState',id:'revision',revision:dispatchGuard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}},{collection:'jobs',id:receiptId,patch:{recordType:'schedule_operation',fingerprint:hash,scheduleHash:await digest(scheduleState(next)),portalVisitId:id,actorId:actor.id,actorKind:actor.kind,requestId:input.requestId,mode:input.mode,before:current?{date:current.date,time:current.time,endTime:current.endTime,status:current.status,revision:current.revision}:null,after:{date:next.date,time:next.time,endTime:next.endTime,status:next.status},createdAt:now}}];
  if(store.crewNotificationsEnabled===true)writes.push(...await crewNotificationWrites({jobId:id,requestId:input.requestId,action:`schedule.${input.mode}`,actorId:actor.id,type:next.type,before:current,after:next,roster,now,baseRevision:current?.revision}));
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
  if(!identity.startTime||!identity.endTimeInstant||Date.parse(event.startTime)!==Date.parse(identity.startTime)||Date.parse(event.endTime)!==Date.parse(identity.endTimeInstant)||providerStatus!==expectedStatus){
    // A verified provider event that disagrees with a Hub already synced to this very appointment
    // means a sync that resolved an older schedule wrote after a newer change was mirrored: the
    // provider is stale. Re-queue the visit under a fresh drift key (a ledger replay of an earlier
    // key would vouch for the stale event again) so the next schedule-sync tick or page retry
    // re-mirrors the Hub schedule. The bind itself is still refused. A stale write that binds while the
    // visit is still pending cannot be told from an ordinary refusal here; the sync that binds after it
    // reads the appointment back (egc-platform/apps/api/src/scheduling.ts, with EGC_SCHEDULE_SYNC_WORKER)
    // and re-binds the event it found, which re-queues the now synced visit through this same rule.
    if(!receipt&&current.syncStatus==='synced'&&identity.highlevelAppointmentId&&event.id===identity.highlevelAppointmentId){
      const patch={syncStatus:'pending',syncIdempotencyKey:scheduleDriftSyncKey(input.operationId),syncError:'schedule_provider_drift',syncNextRetryAt:'',syncDriftAt:now,updatedAt:now};
      // A concurrent change re-queues or re-mirrors the visit on its own.
      await store.commit([{collection:'jobs',id:current.id,revision:current.revision,patch}]).catch(()=>{});
    }
    throw failure('schedule_provider_state_conflict');
  }
  const patch={highlevelAppointmentId:event.id,highlevelCalendarId:event.calendarId||'',providerAppointmentStatus:providerStatus,syncStatus:'synced',syncedAt:now,updatedAt:now};
  if(receipt){
    // A replayed operation proves the same verified provider state. A later unconditional
    // page write (syncStatus 'error' under the same key) is healed here, never left to loop.
    if(current.syncStatus==='synced'&&current.highlevelAppointmentId===event.id)return {ok:true,authority:'employee_hub',visit:identity,replayed:true};
    try{await store.commit([{collection:'jobs',id:current.id,revision:current.revision,patch:{...patch,syncError:'',syncNextRetryAt:''}}]);}catch(error){const latest=await store.read('jobs',current.id).catch(()=>null);if(latest?.syncStatus!=='synced'||latest.highlevelAppointmentId!==event.id)throw error;}
    return {...await resolveScheduledVisit(store,current.id),replayed:true};
  }
  if(current.revision!==input.expectedRevision)throw failure('schedule_revision_conflict');
  try{await store.commit([{collection:'jobs',id:current.id,revision:current.revision,patch},{collection:'jobs',id:receiptId,patch:{recordType:'schedule_provider_receipt',portalVisitId:current.id,providerAppointmentId:event.id,operationId:input.operationId,actorId:actor.id,createdAt:now}}]);}catch(error){const recovered=await store.read('jobs',receiptId).catch(()=>null);if(!recovered||recovered.providerAppointmentId!==event.id)throw error;}
  return {...await resolveScheduledVisit(store,current.id),providerSync:'verified'};
}
