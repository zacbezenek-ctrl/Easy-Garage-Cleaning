import {createHash} from 'node:crypto';
import {and,asc,eq,gte,inArray,lt,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {GhlClient} from '@egc/ghl';
import {assertionEvents,exclusionReasons,type OperationalAssertion} from '@egc/customer-state';
import {commandSchema,type Actor,type BookingVisit,type Command} from '@egc/operations';

type Json=Record<string,unknown>;
type Portal=(actor:Actor,command:Command)=>Promise<Json>;
const rec=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const str=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():null;
const date=(v:unknown)=>v instanceof Date&&Number.isFinite(v.valueOf())?v.toISOString():typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const digest=(v:unknown):string=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x)).digest('hex');
const ids=(v:string|undefined)=>new Set((v??'').split(',').map(x=>x.trim()).filter(Boolean));
const active=(v:unknown)=>['new','confirmed','scheduled'].includes(String(v??'').toLowerCase());
const status=(v:Json)=>String(v.appointmentStatus??v.appoinmentStatus??v.status??'').toLowerCase();
const exactRecord=(v:Json,key:string)=>Object.keys(rec(v[key])).length?rec(v[key]):v;
const denverDate=(value:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const terminal=new Set(['LOST','DO_NOT_CONTACT','JOB_COMPLETED','CASH_COLLECTED']);
const terminalEvents=new Set(['lost','do_not_contact','walkthrough_negative_outcome','job_completed','revenue_collected','appointment_cancelled','no_show']);
export type AdoptionCandidate={source:'ghl_appointment'|'local_job';sourceId:string;contact:Json;lead:Json;snapshot:Json;appointments:Json[];jobs:Json[];events:Json[];evidence:Json[];assertions:Json[]};
type Provider=Pick<GhlClient,'locationId'|'getContact'|'getAppointment'|'getCalendars'|'getCalendarEvents'>;
type Store={load:(since:Date,until:Date)=>Promise<{candidates:AdoptionCandidate[];complete:boolean}>;get:(key:string)=>Promise<Json|null>;save:(key:string,value:Json)=>Promise<void>};
type Proof=Extract<Command,{command:'schedule.adopt'}>['proof'];
type Plan={source:string;sourceId:string;contactId:string|null;contactProviderId:string|null;status:'ready'|'blocked'|'already_in_hub'|'adopted'|'failed';reasons:string[];requestId?:string;proof?:Proof;portalVisitId?:string};
const adoptionErrors=new Set(['adoption_source_changed','adoption_receipt_invalid','adoption_receipt_conflict','adoption_receipt_identity_mismatch','adoption_readback_mismatch','schedule_adoption_operational_scope_invalid',
 'schedule_adoption_customer_identity_requires_manager','schedule_adoption_customer_scan_unavailable','schedule_adoption_customer_scan_incomplete','schedule_adoption_changed_since_operation','schedule_adoption_conflict_time_unresolved','schedule_adoption_contact_invalid','schedule_adoption_customer_ambiguous','schedule_adoption_customer_conflict','schedule_adoption_day_lock_invalid','schedule_adoption_duplicate_suspected','schedule_adoption_existing_source_conflict','schedule_adoption_existing_visit_conflict','schedule_adoption_idempotency_conflict','schedule_adoption_internal_only','schedule_adoption_multiday_or_ambiguous_time','schedule_adoption_original_time_invalid','schedule_adoption_project_conflict','schedule_adoption_proof_expired','schedule_adoption_proof_invalid','schedule_adoption_slot_conflict','schedule_adoption_source_changed','schedule_adoption_source_identity_invalid','schedule_adoption_source_incomplete','schedule_adoption_source_unavailable','schedule_adoption_terminal_tombstone','schedule_adoption_time_out_of_scope']);
function matchesReadback(job:Json,proof:Proof,id:string,requireScope=false){return job.id===id&&job.highlevelContactId===proof.contactProviderId&&job.kind===proof.kind&&active(job.status)&&date(job.startAt)===proof.startAt&&date(job.endAt)===proof.endAt&&str(job.address)?.replace(/\s+/g,' ').toLowerCase()===proof.address.replace(/\s+/g,' ').toLowerCase()&&(!proof.localJobId||job.normalizedLocalJobId===proof.localJobId)&&(!proof.normalizedLocalAppointmentId||job.normalizedLocalAppointmentId===proof.normalizedLocalAppointmentId)&&(!proof.providerAppointmentId||job.highlevelAppointmentId===proof.providerAppointmentId)&&(!proof.providerCalendarId||job.highlevelCalendarId===proof.providerCalendarId)&&(!requireScope||!proof.operationalScope||job.adoptionOperationalScope!==undefined&&digest(job.adoptionOperationalScope)===digest(proof.operationalScope)&&job.originalServiceType===proof.operationalScope.serviceType);}

// Copy only the exact normalized job's operational fields. Free-text notes stay
// source narrative; they never become a financial amount or customer approval.
function sourceOperationalScope(job:Json,contactId:string):Proof['operationalScope']|undefined{
 if(job.contactId!==contactId||!str(job.id))return undefined;
 const text=(value:unknown,max:number)=>value==null?null:typeof value==='string'&&value.length<=max?value:undefined;
 const list=(value:unknown)=>value==null?[]:Array.isArray(value)&&value.length<=100&&value.every(item=>typeof item==='string'&&item.length<=1000)?value as string[]:undefined;
 const serviceType=text(job.serviceType,500),accessNotes=text(job.accessNotes,10000),itemsKeep=list(job.itemsKeep),itemsRelocate=list(job.itemsRelocate),itemsRemove=list(job.itemsRemove);
 const numeric=job.estimatedLaborHours;
 const estimatedLaborHours=numeric==null?null:typeof numeric==='number'?numeric:typeof numeric==='string'&&/^\d+(?:\.\d{1,2})?$/.test(numeric)?Number(numeric):NaN;
 const sourceCreatedAt=job.createdAt==null?null:date(job.createdAt),sourceUpdatedAt=job.updatedAt==null?null:date(job.updatedAt);
 if(serviceType===undefined||accessNotes===undefined||!itemsKeep||!itemsRelocate||!itemsRemove||estimatedLaborHours!==null&&(!Number.isFinite(estimatedLaborHours)||estimatedLaborHours<0||estimatedLaborHours>9999.99)||job.createdAt!=null&&!sourceCreatedAt||job.updatedAt!=null&&!sourceUpdatedAt)return undefined;
 if([serviceType??'',accessNotes??'',...itemsKeep,...itemsRelocate,...itemsRemove].reduce((total,value)=>total+value.length,0)>18000)return undefined;
 return{sourceType:'local_job',sourceId:String(job.id),sourceCreatedAt,sourceUpdatedAt,serviceType,accessNotes,itemsKeep:[...itemsKeep],itemsRelocate:[...itemsRelocate],itemsRemove:[...itemsRemove],estimatedLaborHours};
}

function defaultStore():Store{
 const db=getDb();
 return {
  async load(since,until){
   const [appointments,jobs]=await Promise.all([
    db.select().from(schema.appointments).where(and(gte(schema.appointments.appointmentStartAt,since),lt(schema.appointments.appointmentStartAt,until),inArray(schema.appointments.status,['new','confirmed']))).orderBy(asc(schema.appointments.appointmentStartAt)).limit(101),
    db.select().from(schema.jobs).where(and(gte(schema.jobs.scheduledAt,since),lt(schema.jobs.scheduledAt,until),inArray(schema.jobs.status,['scheduled','confirmed']))).orderBy(asc(schema.jobs.scheduledAt)).limit(101)
   ]);
   const contactIds=[...new Set([...appointments,...jobs].map(r=>r.contactId))];if(!contactIds.length)return{candidates:[],complete:true};
   const [contacts,leads,snapshots,events,evidence,assertions]=await Promise.all([
    db.select().from(schema.contacts).where(inArray(schema.contacts.id,contactIds)),db.select().from(schema.leads).where(inArray(schema.leads.contactId,contactIds)),
    db.select().from(schema.customerStateSnapshots).where(inArray(schema.customerStateSnapshots.contactId,contactIds)),
    db.select().from(schema.customerEvents).where(and(inArray(schema.customerEvents.contactId,contactIds),eq(schema.customerEvents.active,true))),
    db.select().from(schema.customerEvidence).where(inArray(schema.customerEvidence.contactId,contactIds)),
    db.select().from(schema.customerOperationalAssertions).where(and(inArray(schema.customerOperationalAssertions.contactId,contactIds),sql`${schema.customerOperationalAssertions.status}<>'superseded'`))
   ]);
   const scope=(contactId:string)=>({contact:rec(contacts.find(r=>r.id===contactId)),lead:rec(leads.find(r=>r.contactId===contactId)),snapshot:rec(snapshots.find(r=>r.contactId===contactId)?.snapshot),appointments:appointments.filter(r=>r.contactId===contactId).map(rec),jobs:jobs.filter(r=>r.contactId===contactId).map(rec),events:events.filter(r=>r.contactId===contactId).map(rec),evidence:evidence.filter(r=>r.contactId===contactId).map(rec),assertions:assertions.filter(r=>r.contactId===contactId).map(rec)});
   const candidates:AdoptionCandidate[]=[...appointments.map(a=>({source:'ghl_appointment' as const,sourceId:a.providerId,...scope(a.contactId)})),...jobs.filter(j=>!j.appointmentId).map(j=>({source:'local_job' as const,sourceId:j.id,...scope(j.contactId)}))];
   return {candidates:candidates.slice(0,100),complete:appointments.length<=100&&jobs.length<=100&&candidates.length<=100};
  },
  async get(key){const [row]=await db.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,key)).limit(1);if(!row?.cursor)return null;try{return rec(JSON.parse(row.cursor));}catch{throw new Error('adoption_receipt_invalid');}},
  async save(key,value){await db.insert(schema.syncCursors).values({key,cursor:JSON.stringify(value)}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor:JSON.stringify(value),updatedAt:new Date()}});}
 };
}
function purpose(text:unknown):'walkthrough'|'job'|null{const value=String(text??'');if(/employee|interview|hiring|test|internal|vendor/i.test(value))return null;if(/walk\s*through|consultation|free.*estimate/i.test(value))return 'walkthrough';if(/customer.?jobs|\bjob\b|garage.*clean|pressure.*wash|organiz|relocat|junk.*remov|transformation/i.test(value))return 'job';return null;}
function blocked(c:AdoptionCandidate,reason:string):Plan{return{source:c.source,sourceId:c.sourceId,contactId:str(c.contact.id),contactProviderId:str(c.contact.providerId),status:'blocked',reasons:[reason]};}
function customerBlock(c:AdoptionCandidate,providerContact?:Json){
 if(!str(c.contact.id)||c.contact.provider!=='ghl'||!str(c.contact.providerId)||!str(c.lead.id)||!c.snapshot.state)return 'canonical_customer_identity_missing';
 const reasons=exclusionReasons({tags:Array.isArray(c.contact.tags)?c.contact.tags as string[]:[],raw:rec(c.contact.raw),source:str(c.contact.source),doNotContact:c.lead.doNotContact===true});
 if(providerContact)reasons.push(...exclusionReasons({tags:Array.isArray(providerContact.tags)?providerContact.tags as string[]:[],raw:providerContact,source:str(providerContact.source)}));
 if(reasons.length||c.snapshot.excluded===true||['lost','do_not_contact','negative_outcome','converted'].includes(String(c.snapshot.pipelineDisposition))||terminal.has(String(c.snapshot.state)))return 'customer_excluded_or_terminal';
 if(c.events.some(e=>terminalEvents.has(String(e.eventType))&&e.humanReviewNeeded===false&&Number(e.confidence)>=.85))return 'terminal_or_negative_customer_evidence';
 if(c.assertions.some(a=>assertionEvents(a as unknown as OperationalAssertion).some(e=>terminalEvents.has(e.eventType)||e.eventType==='walkthrough_completed')))return 'terminal_user_confirmed_outcome';
 return null;
}
function requestIdentity(proof:Proof){const h=digest({source:proof.source,id:proof.sourceId,contact:proof.contactProviderId,kind:proof.kind,startAt:proof.startAt});return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
function proofHash(proof:Proof){const {verifiedAt:_verifiedAt,...stable}=proof;return digest(stable);}

export async function verifyBookingAdoption(c:AdoptionCandidate,options:{provider:Provider;calendars:Json[];visits:BookingVisit[];now:Date;until:Date;env:NodeJS.ProcessEnv}):Promise<Plan>{
 const {provider,calendars,visits,now,until,env}=options;
 const block=customerBlock(c);if(block)return blocked(c,block);
 const contactProviderId=String(c.contact.providerId),contact=exactRecord(await provider.getContact(contactProviderId),'contact');
 if(contact.id!==contactProviderId||contact.locationId&&contact.locationId!==provider.locationId)return blocked(c,'provider_contact_identity_mismatch');
 const freshBlock=customerBlock(c,contact);if(freshBlock)return blocked(c,freshBlock);
 let kind:'walkthrough'|'job'|null=null,startAt:string|null=null,endAt:string|null=null,address:string|null=null,title:string|null=null,sourceCreatedAt:string|null=null,originalBookingAt:string|null=null,providerAppointmentId:string|null=null,providerCalendarId:string|null=null,providerStatus:'confirmed'|'new'|null=null,localJobId:string|null=null,normalizedLocalAppointmentId:string|null=null;
 const evidenceIds:string[]=[];
 if(c.source==='ghl_appointment'){
  const mirror=c.appointments.find(a=>a.providerId===c.sourceId);if(!mirror)return blocked(c,'source_appointment_missing');
  const a=exactRecord(await provider.getAppointment(c.sourceId),'event');
  if(a.id!==c.sourceId||a.contactId!==contactProviderId||a.locationId&&a.locationId!==provider.locationId)return blocked(c,'provider_appointment_identity_mismatch');
  if(!['new','confirmed'].includes(status(a)))return blocked(c,'provider_appointment_not_active');
  startAt=date(a.startTime);endAt=date(a.endTime);providerCalendarId=str(a.calendarId);providerAppointmentId=c.sourceId;providerStatus=status(a) as 'confirmed'|'new';
  if(startAt!==date(mirror.appointmentStartAt)||endAt!==date(mirror.appointmentEndAt)||providerCalendarId!==mirror.calendarId)return blocked(c,'provider_schedule_changed_since_mirror');
  const calendar=calendars.find(x=>x.id===providerCalendarId);kind=purpose(calendar?.name);const titleKind=purpose(a.title);
  if(!kind||titleKind&&titleKind!==kind)return blocked(c,'provider_purpose_ambiguous');
  const linked=c.jobs.filter(j=>j.appointmentId===mirror.id);if(linked.length>1)return blocked(c,'multiple_local_jobs_for_appointment');
  if(linked[0]){if(!active(linked[0].status)||purpose(linked[0].serviceType)!==kind||date(linked[0].scheduledAt)!==startAt)return blocked(c,'local_provider_purpose_or_schedule_conflict');localJobId=str(linked[0].id);}
  address=str(a.address)??str(linked[0]?.serviceAddress);title=str(a.title);sourceCreatedAt=date(a.dateAdded??a.createdAt)??date(mirror.appointmentCreatedAt);originalBookingAt=sourceCreatedAt;normalizedLocalAppointmentId=str(mirror.id);evidenceIds.push(`appointment:${c.sourceId}`,...(localJobId?[`local_job:${localJobId}`]:[]));
 }else{
  const job=c.jobs.find(j=>j.id===c.sourceId);if(!job||job.appointmentId||!active(job.status))return blocked(c,'local_job_not_exact_active_unlinked');
  kind=purpose(job.serviceType);startAt=date(job.scheduledAt);address=str(job.serviceAddress);title=str(job.serviceType);sourceCreatedAt=date(job.createdAt);localJobId=c.sourceId;
  const hours=Number(job.estimatedLaborHours);if(startAt&&hours>0&&hours<=24)endAt=new Date(Date.parse(startAt)+hours*3600000).toISOString();
  if(c.jobs.filter(j=>active(j.status)&&date(j.scheduledAt)===startAt).length!==1)return blocked(c,'duplicate_local_jobs_suspected');
  const commitments=c.events.filter(e=>['walkthrough_verbally_booked','job_verbally_accepted','job_sold'].includes(String(e.eventType))&&(kind==='walkthrough'?e.eventType==='walkthrough_verbally_booked':e.eventType!=='walkthrough_verbally_booked')&&e.humanReviewNeeded===false&&Number(e.confidence)>=.9&&date(e.occurredAt)&&sourceCreatedAt&&Math.abs(Date.parse(date(e.occurredAt)!)-Date.parse(sourceCreatedAt))<=7*86400000&&Array.isArray(e.evidence)&&e.evidence.some(v=>{const ref=rec(v);return ['message','call_transcript'].includes(String(ref.sourceType))&&str(ref.excerpt)&&ref.humanReviewNeeded!==true&&c.evidence.some(s=>s.sourceType===ref.sourceType&&s.sourceRecordId===ref.sourceRecordId&&s.status==='complete');}));
  if(!commitments.length)return blocked(c,'local_job_missing_content_backed_commitment');
  if(commitments.some(e=>rec(e.details).scheduledAt&&date(rec(e.details).scheduledAt)!==startAt))return blocked(c,'content_commitment_schedule_conflict');
  evidenceIds.push(`local_job:${c.sourceId}`,...commitments.map(e=>String(e.eventId)));
  originalBookingAt=commitments.filter(e=>rec(e.details).occurredAtVerified!==false).map(e=>date(e.occurredAt)!).sort()[0]??null;
 }
 if(!kind||!startAt||!endAt||!address||!title||Date.parse(startAt)<now.valueOf()||Date.parse(startAt)>=until.valueOf()||Date.parse(endAt)<=Date.parse(startAt)||Date.parse(endAt)-Date.parse(startAt)>24*3600000)return blocked(c,'source_schedule_address_or_purpose_incomplete');
 if(denverDate(startAt)!==denverDate(endAt)||Date.parse(startAt)%60000!==0||Date.parse(endAt)%60000!==0)return blocked(c,'source_multiday_or_subminute_schedule');
 if(sourceCreatedAt&&Date.parse(sourceCreatedAt)>now.valueOf()||originalBookingAt&&Date.parse(originalBookingAt)>now.valueOf())return blocked(c,'source_creation_time_invalid');
 // Every provider calendar is checked live. Do not adopt beside a
 // duplicate or hide a provider booking that has not reached the mirror yet.
 const businessCalendars=calendars;if(!businessCalendars.length||businessCalendars.length>20||businessCalendars.some(cal=>!str(cal.id))||new Set(businessCalendars.map(cal=>cal.id)).size!==businessCalendars.length)return blocked(c,'business_calendar_inventory_ambiguous');
 const providerMatches=new Set<string>();
 for(const cal of businessCalendars){
  const list=await provider.getCalendarEvents({calendarId:String(cal.id),startTime:Date.parse(startAt)-90000,endTime:Date.parse(startAt)+90000});
  if(!Array.isArray(list.events)||list.events.length>250||list.nextPage||list.nextPageToken)return blocked(c,'provider_duplicate_scan_incomplete');
  for(const raw of list.events){const a=rec(raw);if(!str(a.id)||!str(a.contactId)||!date(a.startTime)||!str(a.calendarId)||!status(a))return blocked(c,'provider_duplicate_scan_malformed');if(a.contactId===contactProviderId&&Math.abs(Date.parse(date(a.startTime)!)-Date.parse(startAt))<=90000&&['new','confirmed'].includes(status(a)))providerMatches.add(String(a.id));}
 }
 if(c.source==='ghl_appointment'&&(providerMatches.size!==1||!providerMatches.has(c.sourceId))||c.source==='local_job'&&providerMatches.size)return blocked(c,'duplicate_or_unmirrored_provider_booking');
 const sameSource=visits.filter(v=>providerAppointmentId&&v.highlevelAppointmentId===providerAppointmentId),sameTime=visits.filter(v=>v.highlevelContactId===contactProviderId&&v.startAt&&Math.abs(Date.parse(v.startAt)-Date.parse(startAt!))<=90000&&active(v.status));
 if(sameSource.length>1||sameTime.length>1)return blocked(c,'duplicate_hub_visits_suspected');
 const existing=sameSource[0]??sameTime[0];
 if(existing&&(existing.highlevelContactId!==contactProviderId||existing.kind!==kind||date(existing.startAt)!==startAt||date(existing.endAt)!==endAt||str(existing.address)?.replace(/\s+/g,' ').toLowerCase()!==address.replace(/\s+/g,' ').toLowerCase()||!active(existing.status)||existing.highlevelAppointmentId&&existing.highlevelAppointmentId!==providerAppointmentId||existing.highlevelCalendarId&&existing.highlevelCalendarId!==providerCalendarId))return blocked(c,'hub_source_binding_conflict');
 if(existing&&providerAppointmentId&&existing.highlevelAppointmentId===providerAppointmentId)return {...blocked(c,'already_in_hub'),status:'already_in_hub',portalVisitId:existing.id};
 const sourceJob=localJobId?c.jobs.find(job=>job.id===localJobId):null;
 const operationalScope=sourceJob?sourceOperationalScope(sourceJob,String(c.contact.id)):null;
 if(localJobId&&(!sourceJob||operationalScope===undefined))return blocked(c,'source_operational_scope_invalid');
 const providerContact={id:contactProviderId,...Object.fromEntries(['locationId','name','firstName','lastName','phone','email','address1'].flatMap(key=>str(contact[key])?[[key,contact[key]]]:[]))};
 const proof:Proof={source:c.source,sourceId:c.sourceId,contactProviderId,providerContact,kind,startAt,endAt,address,title,originalBookingAt,sourceCreatedAt,verifiedAt:now.toISOString(),providerAppointmentId,providerCalendarId,providerStatus,evidenceIds:[...new Set(evidenceIds)].sort(),sourceRevision:'',localJobId,normalizedLocalAppointmentId,operationalScope};
 proof.sourceRevision=digest({...proof,verifiedAt:undefined,sourceRevision:undefined});
 if(!commandSchema.safeParse({command:'schedule.adopt',requestId:requestIdentity(proof),proof}).success)return blocked(c,'source_proof_malformed');
 if(c.source==='local_job'&&!ids(env.EGC_BOOKING_ADOPT_LOCAL_JOB_IDS).has(c.sourceId))return {...blocked(c,'local_job_requires_reviewed_allowlist'),requestId:requestIdentity(proof),proof};
 if(c.source==='ghl_appointment'&&env.EGC_BOOKING_ADOPT_PROVIDER_IDS&&!ids(env.EGC_BOOKING_ADOPT_PROVIDER_IDS).has(c.sourceId))return {...blocked(c,'provider_booking_not_in_reviewed_allowlist'),requestId:requestIdentity(proof),proof};
 return {...blocked(c,'verified_existing_booking'),status:'ready',requestId:requestIdentity(proof),proof};
}

export async function reconcileExistingBookingAdoption(portal:Portal,options:{env?:NodeJS.ProcessEnv;now?:Date;visits:BookingVisit[];portalComplete:boolean;providerComplete:boolean;provider?:Provider;store?:Store}){
 const env=options.env??process.env,now=options.now??new Date(),until=new Date(now.valueOf()+14*86400000),dryRun=env.EGC_BOOKING_ADOPT_EXISTING!=='true',store=options.store??defaultStore();
 const snapshot=await store.load(now,until),plans:Plan[]=[];
 if(!snapshot.candidates.length)return{dryRun,window:{since:now.toISOString(),until:until.toISOString()},complete:snapshot.complete&&options.portalComplete&&options.providerComplete,counts:{ready:0,blocked:0,adopted:0,already_in_hub:0,failed:0},plans:[]};
 const provider=options.provider??GhlClient.fromEnv(),calendarResponse=await provider.getCalendars();
 const calendars=Array.isArray(calendarResponse.calendars)?calendarResponse.calendars.map(rec):[];
 const actor:Actor={id:'booking-adoption-worker',kind:'integration',role:'integration',workspace:env.EGC_OPERATIONS_WORKSPACE??'egc'};
 for(const candidate of snapshot.candidates.slice(0,25)){
  let plan:Plan;
  try{
   plan=await verifyBookingAdoption(candidate,{provider,calendars,visits:options.visits,now,until,env});
   if(plan.status==='ready'&&(!options.portalComplete||!options.providerComplete||!snapshot.complete))plan={...plan,status:'blocked',reasons:['adoption_source_coverage_incomplete']};
   if(plan.status==='ready'&&!dryRun&&plan.proof&&plan.requestId){
    const latest=await store.load(new Date(),until),fresh=latest.candidates.find(c=>c.source===candidate.source&&c.sourceId===candidate.sourceId);
    if(!fresh||!latest.complete)throw new Error('adoption_source_changed');
    const verified=await verifyBookingAdoption(fresh,{provider,calendars,visits:options.visits,now:new Date(),until,env});
    if(verified.status!=='ready'||!verified.proof||proofHash(verified.proof)!==proofHash(plan.proof))throw new Error('adoption_source_changed');
    const key=`customer_state:booking_adoption:${plan.requestId}`,prior=await store.get(key),fingerprint=proofHash(verified.proof);
    if(prior&&prior.fingerprint!==fingerprint)throw new Error('adoption_receipt_conflict');
    if(prior?.phase==='adopted'){
     const priorReceipt=rec(prior.receipt),priorId=str(priorReceipt.portalVisitId);
     if(!priorId)throw new Error('adoption_receipt_invalid');
     const detail=await portal(actor,{command:'portal.job',jobId:priorId}),job=rec(detail.job);
     if(detail.authority!=='employee_hub'||!matchesReadback(job,verified.proof,priorId,priorReceipt.adopted===true))throw new Error('adoption_readback_mismatch');
     plans.push({...plan,status:'already_in_hub',portalVisitId:priorId});continue;
    }
    await store.save(key,{phase:'pending',requestId:plan.requestId,fingerprint,source:candidate.source,sourceId:candidate.sourceId});
    const receipt=await portal(actor,{command:'schedule.adopt',requestId:plan.requestId,proof:verified.proof});
    const source=rec(receipt.source);
    if(receipt.ok!==true||receipt.authority!=='employee_hub'||!str(receipt.portalVisitId)||receipt.jobId!==receipt.portalVisitId||receipt.contactProviderId!==verified.proof.contactProviderId||receipt.kind!==verified.proof.kind||date(receipt.startAt)!==verified.proof.startAt||date(receipt.endAt)!==verified.proof.endAt||source.type!==verified.proof.source||source.id!==verified.proof.sourceId||source.revision!==verified.proof.sourceRevision||receipt.duplicate!==false||typeof receipt.adopted!=='boolean'||typeof receipt.replayed!=='boolean')throw new Error('adoption_receipt_identity_mismatch');
    const detail=await portal(actor,{command:'portal.job',jobId:String(receipt.portalVisitId)}),job=rec(detail.job);
    if(detail.authority!=='employee_hub'||!matchesReadback(job,verified.proof,String(receipt.portalVisitId),receipt.adopted===true))throw new Error('adoption_readback_mismatch');
    await store.save(key,{phase:'adopted',requestId:plan.requestId,fingerprint,source:candidate.source,sourceId:candidate.sourceId,localJobId:verified.proof.localJobId,normalizedLocalAppointmentId:verified.proof.normalizedLocalAppointmentId,receipt,verifiedAt:new Date().toISOString()});
    plan={...plan,status:'adopted',portalVisitId:String(receipt.portalVisitId)};
   }
  }catch(error){const detail=rec(error),code=typeof detail.code==='string'&&adoptionErrors.has(detail.code)?detail.code:error instanceof Error&&adoptionErrors.has(error.message)?error.message:'adoption_verification_unavailable';plan={...blocked(candidate,code),status:'failed'};}
  plans.push(plan);
 }
 const counts={ready:0,blocked:0,adopted:0,already_in_hub:0,failed:0};for(const plan of plans)counts[plan.status]++;
 // Diagnostics omit matching/contact details. The signed proof remains local to
 // verification and the Hub; source IDs/timing make the proposed plan reviewable.
 return {dryRun,window:{since:now.toISOString(),until:until.toISOString()},complete:snapshot.complete&&snapshot.candidates.length<=25&&options.portalComplete&&options.providerComplete,counts,plans:plans.map(({proof,...plan})=>({...plan,...(proof?{kind:proof.kind,startAt:proof.startAt,endAt:proof.endAt,originalBookingAt:proof.originalBookingAt,sourceCreatedAt:proof.sourceCreatedAt,sourceRevision:proof.sourceRevision,evidenceIds:proof.evidenceIds,localJobId:proof.localJobId,normalizedLocalAppointmentId:proof.normalizedLocalAppointmentId}:{} )}))};
}
