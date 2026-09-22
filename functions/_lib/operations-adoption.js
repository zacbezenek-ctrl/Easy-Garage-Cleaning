import {firestoreFetch} from './firebase-service-account.js';
import {decodeFirestoreFields} from './firestore-job.js';
import {localInstant} from './operations-portal-records.js';
import {schedulingStorage} from './operations-scheduling.js';
const BASE='https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/jobs';
const fail=(code,status=409)=>Object.assign(new Error(code),{status});
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(v)&&!/^(_egc_|secure_)/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const instant=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:null;
const exact=(v,keys)=>obj(v)&&Object.keys(v).every(k=>keys.includes(k));
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v);
const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const kind=v=>v==='walkthrough'?'walkthrough':['job','cleanout','reorg'].includes(v)?'job':null;
const terminal=v=>['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show','lost','declined'].includes(String(v||'').toLowerCase());
const norm=v=>String(v||'').trim().replace(/\s+/g,' ').toLowerCase();
const phone=v=>String(v||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
const email=v=>String(v||'').trim().toLowerCase();
const mins=v=>/^\d\d:\d\d$/.test(v||'')?Number(v.slice(0,2))*60+Number(v.slice(3)):NaN;
function validateOperationalScope(scope,localJobId){
 if(scope===undefined||scope===null)return;
 if(!exact(scope,['sourceType','sourceId','sourceCreatedAt','sourceUpdatedAt','serviceType','accessNotes','itemsKeep','itemsRelocate','itemsRemove','estimatedLaborHours'])||scope.sourceType!=='local_job'||!uuid(scope.sourceId)||scope.sourceId!==localJobId||!['sourceCreatedAt','sourceUpdatedAt'].every(key=>scope[key]===null||instant(scope[key])!==null)||!(scope.serviceType===null||typeof scope.serviceType==='string'&&scope.serviceType.length<=500)||!(scope.accessNotes===null||typeof scope.accessNotes==='string'&&scope.accessNotes.length<=10000)||!(scope.estimatedLaborHours===null||typeof scope.estimatedLaborHours==='number'&&Number.isFinite(scope.estimatedLaborHours)&&scope.estimatedLaborHours>=0&&scope.estimatedLaborHours<=9999.99)||!['itemsKeep','itemsRelocate','itemsRemove'].every(key=>Array.isArray(scope[key])&&scope[key].length<=100&&scope[key].every(item=>typeof item==='string'&&item.length<=1000)))throw fail('schedule_adoption_operational_scope_invalid',400);
 if([scope.serviceType||'',scope.accessNotes||'',...scope.itemsKeep,...scope.itemsRelocate,...scope.itemsRemove].reduce((sum,text)=>sum+text.length,0)>18000)throw fail('schedule_adoption_operational_scope_invalid',400);
}
function operationalScopeText(scope){
 return [scope.serviceType&&`Service: ${scope.serviceType}`,scope.accessNotes&&`Access and source notes: ${scope.accessNotes}`,...[['Keep',scope.itemsKeep],['Relocate',scope.itemsRelocate],['Remove',scope.itemsRemove]].flatMap(([label,items])=>items.length?[`${label}:`,...items.map(item=>`- ${item}`)]:[]),scope.estimatedLaborHours!==null&&`Estimated labor hours: ${scope.estimatedLaborHours}`].filter(Boolean).join('\n');
}
function validateLock(lock){
 if(!lock)return;
 if(lock.recordType!=='schedule_lock'||!Array.isArray(lock.entries)||typeof lock.revision!=='string'||!lock.revision)throw fail('schedule_adoption_day_lock_invalid');
 const seen=new Set();
 for(const entry of lock.entries){
  if(!obj(entry)||typeof entry.id!=='string'||!entry.id||entry.id.length>200||/[\x00-\x1f]/.test(entry.id)||seen.has(entry.id)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.start||'')||!/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(entry.end||'')||mins(entry.end)<=mins(entry.start)||entry.type!==undefined&&typeof entry.type!=='string'||entry.status!==undefined&&typeof entry.status!=='string'||entry.assignedCrew!==undefined&&(!Array.isArray(entry.assignedCrew)||entry.assignedCrew.some(v=>typeof v!=='string'||!v||v.length>200)))throw fail('schedule_adoption_day_lock_invalid');
  seen.add(entry.id);
 }
}
const local=value=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(x=>[x.type,x.value]));return{date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};};
function validate(actor,input,now){
 if(actor?.kind!=='integration'||actor.role!=='integration'||actor.id!=='booking-adoption-worker'||actor.workspace!=='egc')throw fail('schedule_adoption_internal_only',403);
 const p=input?.proof,contact=p?.providerContact;
 if(!exact(input,['command','requestId','proof'])||input.command!=='schedule.adopt'||!uuid(input.requestId)||!exact(p,['source','sourceId','sourceRevision','contactProviderId','providerContact','kind','startAt','endAt','address','title','originalBookingAt','sourceCreatedAt','verifiedAt','providerAppointmentId','providerCalendarId','providerStatus','localJobId','normalizedLocalAppointmentId','evidenceIds','operationalScope'])||!['ghl_appointment','local_job'].includes(p.source)||!safeId(p.sourceId)||!safeId(p.contactProviderId)||typeof p.sourceRevision!=='string'||!p.sourceRevision||p.sourceRevision.length>200||!['walkthrough','job'].includes(p.kind)||typeof p.address!=='string'||!p.address.trim()||p.address.length>1000||typeof p.title!=='string'||!p.title.trim()||p.title.length>500)throw fail('schedule_adoption_proof_invalid',400);
 if(!exact(contact,['id','locationId','name','firstName','lastName','phone','email','address1'])||contact.id!==p.contactProviderId||Object.values(contact).some(v=>typeof v!=='string'||v.length>1000)||contact.locationId!==undefined&&!safeId(contact.locationId))throw fail('schedule_adoption_contact_invalid',400);
 if(!Array.isArray(p.evidenceIds)||!p.evidenceIds.length||p.evidenceIds.length>30||p.evidenceIds.some(x=>typeof x!=='string'||!/^[A-Za-z0-9:_-]{1,200}$/.test(x))||!['localJobId','normalizedLocalAppointmentId'].every(k=>p[k]===null||uuid(p[k])))throw fail('schedule_adoption_proof_invalid',400);
 validateOperationalScope(p.operationalScope,p.localJobId);
 const verified=instant(p.verifiedAt),start=instant(p.startAt),end=instant(p.endAt),at=Date.parse(now);
 if(verified===null||verified>at+5000||verified<at-120000)throw fail('schedule_adoption_proof_expired');
 if(start===null||end===null||end<=start||end-start>86400000||start<at-900000||start>at+180*86400000)throw fail('schedule_adoption_time_out_of_scope');
 if(['sourceCreatedAt','originalBookingAt'].some(k=>p[k]!==null&&(instant(p[k])===null||instant(p[k])>verified+5000)))throw fail('schedule_adoption_original_time_invalid',400);
 if(!['providerAppointmentId','providerCalendarId'].every(k=>p[k]===null||safeId(p[k]))||![null,'confirmed','new'].includes(p.providerStatus)||Boolean(p.providerAppointmentId)!==Boolean(p.providerCalendarId)||Boolean(p.providerAppointmentId)!==Boolean(p.providerStatus)||p.source==='ghl_appointment'&&p.providerAppointmentId!==p.sourceId||p.source==='local_job'&&p.localJobId!==p.sourceId)throw fail('schedule_adoption_source_identity_invalid',400);
 const from=local(p.startAt),to=local(p.endAt);
 if(from.date!==to.date||localInstant(from.date,from.time)!==new Date(start).toISOString()||localInstant(to.date,to.time)!==new Date(end).toISOString())throw fail('schedule_adoption_multiday_or_ambiguous_time');
 return{p,from,to};
}
/** A complete bounded source scan includes cancelled tombstones and prior-day
 * intervals. A failed/partial scan cannot establish that adoption is safe. */
export function adoptionStorage(env,fetcher=firestoreFetch){return{...schedulingStorage(env,fetcher),async identityCandidates(contact){
 const wantedPhone=phone(contact.phone),wantedEmail=email(contact.email);
 if(!wantedPhone&&!wantedEmail)return[];
 const matches=[],seen=new Set(),tokens=new Set();let token='';
 for(let page=0;page<20;page++){
  const url=new URL(BASE.replace(/\/jobs$/,'/customers'));url.searchParams.set('pageSize','500');if(token)url.searchParams.set('pageToken',token);for(const field of ['phone','email','highlevelContactId'])url.searchParams.append('mask.fieldPaths',field);
  const response=await fetcher(env,url.toString(),{signal:AbortSignal.timeout(15000)});if(!response.ok)throw fail('schedule_adoption_customer_scan_unavailable',503);
  const data=await response.json();if(data.documents!==undefined&&!Array.isArray(data.documents))throw fail('schedule_adoption_customer_scan_incomplete',503);
  for(const doc of data.documents||[]){const id=String(doc.name||'').split('/').pop();if(!safeId(id)||seen.has(id))throw fail('schedule_adoption_customer_scan_incomplete',503);seen.add(id);const row={...decodeFirestoreFields(doc.fields||{}),id,revision:doc.updateTime};
   if(!row.highlevelContactId&&(wantedPhone&&phone(row.phone)===wantedPhone||wantedEmail&&email(row.email)===wantedEmail))matches.push(row);
  }
  token=data.nextPageToken||'';if(!token)return matches;if(tokens.has(token))throw fail('schedule_adoption_customer_scan_incomplete',503);tokens.add(token);
 }
 throw fail('schedule_adoption_customer_scan_incomplete',503);
},async snapshot(){
 const rows=[],seen=new Set(),tokens=new Set();let token='';
 const fields=['recordType','type','customerId','projectId','highlevelContactId','highlevelAppointmentId','highlevelCalendarId','normalizedLocalJobId','normalizedLocalAppointmentId','date','endDate','time','endTime','status','pipelineStatus','address','phone','email','adoptionSource','adoptionOriginalBookingAt'];
 for(let page=0;page<20;page++){
  const url=new URL(BASE);url.searchParams.set('pageSize','500');if(token)url.searchParams.set('pageToken',token);for(const f of fields)url.searchParams.append('mask.fieldPaths',f);
  const r=await fetcher(env,url.toString(),{signal:AbortSignal.timeout(15000)});if(!r.ok)throw fail('schedule_adoption_source_unavailable',503);
  const data=await r.json();if(data.documents!==undefined&&!Array.isArray(data.documents))throw fail('schedule_adoption_source_incomplete',503);
  for(const doc of data.documents||[]){const id=String(doc.name||'').split('/').pop();if(!id||seen.has(id))throw fail('schedule_adoption_source_changed',503);seen.add(id);const row={...decodeFirestoreFields(doc.fields||{}),id,revision:doc.updateTime};if(!row.recordType&&safeId(id))rows.push(row);}
  token=data.nextPageToken||'';if(!token)return rows;if(tokens.has(token))throw fail('schedule_adoption_source_incomplete',503);tokens.add(token);
 }
 throw fail('schedule_adoption_source_incomplete',503);
}};}
const response=(visit,p,adopted,replayed)=>({ok:true,authority:'employee_hub',jobId:visit.id,portalVisitId:visit.id,portalCustomerId:visit.customerId,contactProviderId:p.contactProviderId,kind:p.kind,startAt:p.startAt,endAt:p.endAt,source:{type:p.source,id:p.sourceId,revision:p.sourceRevision},adopted,replayed,duplicate:false,revision:visit.revision});
const active=v=>['scheduled','confirmed','new','booked'].includes(String(v.pipelineStatus||v.status||'').toLowerCase());
const matches=(v,p)=>v&&!v.recordType&&kind(v.type)===p.kind&&v.highlevelContactId===p.contactProviderId&&instant(localInstant(v.date,v.time))===instant(p.startAt)&&instant(localInstant(v.endDate||v.date,v.endTime))===instant(p.endAt)&&norm(v.address)===norm(p.address)&&active(v)&&(!p.providerAppointmentId||v.highlevelAppointmentId===p.providerAppointmentId&&v.highlevelCalendarId===p.providerCalendarId)&&(!p.localJobId||v.normalizedLocalJobId===p.localJobId)&&(!p.normalizedLocalAppointmentId||v.normalizedLocalAppointmentId===p.normalizedLocalAppointmentId);
const compatible=(v,p,customerId)=>v&&!v.recordType&&active(v)&&v.highlevelContactId===p.contactProviderId&&kind(v.type)===p.kind&&(!v.customerId||v.customerId===customerId)&&instant(localInstant(v.date,v.time))===instant(p.startAt)&&instant(localInstant(v.endDate||v.date,v.endTime))===instant(p.endAt)&&norm(v.address)===norm(p.address)&&(!v.highlevelAppointmentId||v.highlevelAppointmentId===p.providerAppointmentId)&&(!v.highlevelCalendarId||v.highlevelCalendarId===p.providerCalendarId)&&(!v.normalizedLocalJobId||v.normalizedLocalJobId===p.localJobId)&&(!v.normalizedLocalAppointmentId||v.normalizedLocalAppointmentId===p.normalizedLocalAppointmentId);
/** Backend-verified migration only: no provider API, notification or inferred
 * price/acceptance fields. All customer/project/visit/lock/receipts commit once. */
export async function adoptScheduledVisit(store,actor,input,now=new Date().toISOString()){
 const {p,from,to}=validate(actor,input,now),{verifiedAt,...stableProof}=p;
 const fingerprint=await digest(stableProof),sourceKey=await digest({source:p.source,id:p.sourceId}),sourceReceiptId=`_egc_adoption_source_${sourceKey.slice(0,40)}`,requestReceiptId=`_egc_adoption_request_${input.requestId.replaceAll('-','')}`;
 const [sourceReceipt,requestReceipt]=await Promise.all([store.read('jobs',sourceReceiptId),store.read('jobs',requestReceiptId)]);
 for(const receipt of [sourceReceipt,requestReceipt])if(receipt&&receipt.fingerprint!==fingerprint)throw fail('schedule_adoption_idempotency_conflict');
 const receipt=sourceReceipt||requestReceipt;
 if(receipt){const visit=await store.read('jobs',receipt.portalVisitId);if(!matches(visit,p)||visit.customerId!==receipt.portalCustomerId)throw fail('schedule_adoption_changed_since_operation');return response(visit,p,receipt.adopted===true,true);}
 // Share the same CAS fence as manager customer resolution. It is read before
 // the identity lookup and written atomically with every adoption/link.
 const identityGuard=await store.read('customerIdentityState','revision');
 const candidates=await store.customers(p.contactProviderId);if(candidates.length>1)throw fail('schedule_adoption_customer_ambiguous');
 const customerId=candidates[0]?.id||`ghl_${p.contactProviderId}`,customer=candidates[0]||await store.read('customers',customerId);
 if(!safeId(customerId)||customer&&(customer.id!==customerId||customer.highlevelContactId!==p.contactProviderId))throw fail('schedule_adoption_customer_conflict');
 if(!customer){
  if(typeof store.identityCandidates!=='function')throw fail('schedule_adoption_customer_scan_unavailable',503);
  const manualCandidates=await store.identityCandidates(p.providerContact);if(!Array.isArray(manualCandidates))throw fail('schedule_adoption_customer_scan_incomplete',503);
  if(manualCandidates.length)throw fail('schedule_adoption_customer_identity_requires_manager');
 }
 const bookingKey=await digest({customerId,kind:p.kind,date:from.date,time:from.time,timeZone:'America/Denver'}),deterministicId=`visit_${bookingKey.slice(0,40)}`;
 const lockId=`_egc_schedule_lock_${from.date}`,lock=await store.read('jobs',lockId);validateLock(lock);const snapshot=await store.snapshot();
 if(!Array.isArray(snapshot))throw fail('schedule_adoption_source_incomplete',503);
 const same=snapshot.filter(v=>v.highlevelContactId===p.contactProviderId&&kind(v.type)===p.kind&&instant(localInstant(v.date,v.time))===instant(p.startAt));
 const linked=snapshot.filter(v=>p.providerAppointmentId&&v.highlevelAppointmentId===p.providerAppointmentId||p.localJobId&&v.normalizedLocalJobId===p.localJobId||p.normalizedLocalAppointmentId&&v.normalizedLocalAppointmentId===p.normalizedLocalAppointmentId||v.adoptionSource?.type===p.source&&v.adoptionSource?.id===p.sourceId);
 if(same.length>1||linked.length>1)throw fail('schedule_adoption_duplicate_suspected');
 if(linked[0]&&same[0]?.id!==linked[0].id)throw fail('schedule_adoption_existing_source_conflict');
 let current=same[0]||await store.read('jobs',deterministicId);
 if(current&&(terminal(current.pipelineStatus||current.status)||!kind(current.type)))throw fail('schedule_adoption_terminal_tombstone');
 if(current&&!compatible(current,p,customerId))throw fail('schedule_adoption_existing_visit_conflict');
 if(current){current=await store.read('jobs',current.id);if(!compatible(current,p,customerId)||terminal(current.pipelineStatus||current.status))throw fail('schedule_adoption_source_changed');}
 const id=current?.id||deterministicId,activeEntries=(Array.isArray(lock?.entries)?lock.entries:[]).filter(v=>v.id!==id&&!terminal(v.status));
 const start=instant(p.startAt),end=instant(p.endAt);
 for(const row of snapshot){if(row.id===id||terminal(row.pipelineStatus||row.status)||!kind(row.type)&&!['blocked','block'].includes(row.type))continue;const a=instant(localInstant(row.date,row.time)),b=instant(localInstant(row.endDate||row.date,row.endTime));if(a===null||b===null){if(row.date===from.date)throw fail('schedule_adoption_conflict_time_unresolved');continue;}if(a<end&&start<b)throw fail('schedule_adoption_slot_conflict');}
 for(const entry of activeEntries){if(entry.type==='availability')continue;const a=mins(entry.start),b=mins(entry.end);if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)throw fail('schedule_adoption_conflict_time_unresolved');if(a<mins(to.time)&&mins(from.time)<b)throw fail('schedule_adoption_slot_conflict');}
 const projectId=current?.projectId||`project_${id}`,project=await store.read('projects',projectId);if(project&&project.customerId!==customerId)throw fail('schedule_adoption_project_conflict');
 const source={type:p.source,id:p.sourceId,revision:p.sourceRevision,verifiedAt,evidenceIds:[...new Set(p.evidenceIds)]};
 const patch={id,type:current?.type||p.kind,customerId,projectId,highlevelContactId:p.contactProviderId,scheduleSource:'egc_hub',providerSyncOwner:'operations',adoptionSource:source,adoptedAt:current?.adoptedAt||now,adoptionOriginalBookingAt:p.originalBookingAt,updatedAt:now};
 if(!current)Object.assign(patch,{bookingKey,date:from.date,time:from.time,endTime:to.time,status:'scheduled',pipelineStatus:'scheduled',createdAt:p.originalBookingAt||p.sourceCreatedAt||null,createdBy:actor.id,title:p.title,serviceType:p.kind==='walkthrough'?'Free garage walkthrough':'Customer job',customer:p.providerContact.name||[p.providerContact.firstName,p.providerContact.lastName].filter(Boolean).join(' '),phone:p.providerContact.phone||'',email:p.providerContact.email||'',address:p.address});
 if(!current&&p.operationalScope){
  const scope=p.operationalScope;
  patch.adoptionOperationalScope=structuredClone(scope);
  patch.operationalScope={text:operationalScopeText(scope),updatedBy:actor.id,updatedAt:now,reason:'Preserved exact local operational source during verified Hub adoption',approvalKind:'staff_operational_instructions',sourceType:scope.sourceType,sourceId:scope.sourceId,sourceRevision:p.sourceRevision};
  patch.originalServiceType=scope.serviceType;
  if(p.kind==='job'&&scope.serviceType?.trim())patch.serviceType=scope.serviceType;
 }
 if(p.localJobId)patch.normalizedLocalJobId=p.localJobId;if(p.normalizedLocalAppointmentId)patch.normalizedLocalAppointmentId=p.normalizedLocalAppointmentId;
 if(p.providerAppointmentId)Object.assign(patch,{highlevelAppointmentId:p.providerAppointmentId,highlevelCalendarId:p.providerCalendarId,providerAppointmentStatus:p.providerStatus,syncStatus:'synced',syncedAt:verifiedAt});else if(!current?.highlevelAppointmentId)patch.syncStatus='pending';
 const next={...current,...patch},writes=[{collection:'jobs',id,revision:current?.revision,patch}];
 writes.push({collection:'customerIdentityState',id:'revision',revision:identityGuard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
 if(!customer)writes.push({collection:'customers',id:customerId,patch:{id:customerId,name:next.customer||'',phone:p.providerContact.phone||'',email:p.providerContact.email||'',address:p.address,highlevelContactId:p.contactProviderId,createdAt:now,updatedAt:now,source:'verified_operational_adoption'}});
 if(!project)writes.push({collection:'projects',id:projectId,patch:{id:projectId,customerId,sourceRecordId:id,sourceWalkthroughId:p.kind==='walkthrough'?id:null,createdBy:actor.id,createdAt:now,updatedAt:now,authority:'employee_hub'}});
 activeEntries.push({id,start:from.time,end:to.time,label:next.customer||'',status:next.status||'scheduled',updatedAt:now});
 writes.push({collection:'jobs',id:lockId,revision:lock?.revision,patch:{recordType:'schedule_lock',date:from.date,entries:activeEntries,updatedAt:now}});
 for(const receiptId of [sourceReceiptId,requestReceiptId])writes.push({collection:'jobs',id:receiptId,patch:{recordType:'schedule_adoption',fingerprint,portalVisitId:id,portalCustomerId:customerId,source,adopted:!current,actorId:actor.id,createdAt:now}});
 try{await store.commit(writes);}catch(error){const recovered=await store.read('jobs',sourceReceiptId).catch(()=>null),request=await store.read('jobs',requestReceiptId).catch(()=>null);if(recovered?.fingerprint!==fingerprint||request?.fingerprint!==fingerprint)throw error;}
 const saved=await store.read('jobs',id);if(!matches(saved,p))throw fail('schedule_adoption_changed_since_operation');
 return response(saved,p,!current,false);
}
