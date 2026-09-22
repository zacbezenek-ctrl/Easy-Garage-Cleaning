import {getDb,schema} from '@egc/database';
import {and,desc,eq,inArray,or,sql} from 'drizzle-orm';
import {reconcileBookingSnapshot,type Actor,type Command,type BookingVisit,type BookingSnapshot} from '@egc/operations';
import {reconcileCustomerState,customerActivityPredicate,customerRefreshOrder,type PortalEvidenceRecord} from '@egc/customer-state';
import {syncPortalSchedule} from './scheduling.js';
import {reconcileExistingBookingAdoption} from './booking-adoption.js';
import {ReconciliationFailure,reconciliationDiagnostic,type ReconciliationDiagnostic,type ReconciliationStage} from './reconciliation-diagnostics.js';
type Json=Record<string,unknown>;
type Portal=(actor:Actor,command:Command)=>Promise<Json>;
const rec=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const str=(v:unknown)=>typeof v==='string'?v:null;
const safeDate=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null;
function exactEvidence(result:Json,requested:string[]){
 const returned=result.contactProviderIds,coverage=rec(result.coverage),allowed=new Set(requested),seen=new Set<string>();
 if(result.authority!=='employee_hub'||!Array.isArray(returned)||returned.length!==allowed.size||new Set(returned).size!==allowed.size||returned.some(id=>typeof id!=='string'||!allowed.has(id))||!Array.isArray(result.records)||!safeDate(coverage.asOf))throw new Error('hub_evidence_identity_or_coverage_invalid');
 const records:PortalEvidenceRecord[]=[];
 for(const raw of result.records){
  const r=rec(raw);
  if(typeof r.id!=='string'||!r.id||seen.has(r.id)||typeof r.highlevelContactId!=='string'||!allowed.has(r.highlevelContactId)||!['walkthrough','job','payment'].includes(String(r.kind))||typeof r.status!=='string'||!r.status)throw new Error('hub_evidence_record_identity_invalid');
  if(['createdAt','updatedAt','completedAt','startAt','soldAt','paidAt'].some(key=>r[key]!=null&&!safeDate(r[key])))throw new Error('hub_evidence_record_date_invalid');
  if(['priceCents','paidCents'].some(key=>r[key]!=null&&(!Number.isSafeInteger(r[key])||Number(r[key])<0))||(r.financials!=null&&(typeof r.financials!=='object'||Array.isArray(r.financials))))throw new Error('hub_evidence_record_value_invalid');
  seen.add(r.id);records.push(r as unknown as PortalEvidenceRecord);
 }
 return {records,complete:coverage.complete===true,asOf:coverage.asOf as string};
}

export async function reconcileHubBookings(portal:Portal,env:NodeJS.ProcessEnv=process.env){
 let stage:ReconciliationStage='startup';
 try{
 const db=getDb(),actor:Actor={id:'booking-reconciler',kind:'integration',role:'integration',workspace:env.EGC_OPERATIONS_WORKSPACE??'egc'};
 const startDate=new Date(Date.now()-30*86400000).toISOString().slice(0,10),endDate=new Date(Date.now()+90*86400000).toISOString().slice(0,10);
 const visits:BookingVisit[]=[],portalRecords:PortalEvidenceRecord[]=[];let offset=0,complete=true;
 for(let page=0;page<30;page++){
  stage='hub_calendar';
  const result=await portal(actor,{command:'calendar',startDate,endDate,timeZone:'America/Denver',offset,limit:200});
  if(result.authority!=='employee_hub'||!Array.isArray(result.items))throw new Error('hub_calendar_unavailable');
  complete=complete&&rec(result.coverage).complete===true;
  for(const raw of result.items){
   const item=rec(raw);if(typeof item.id!=='string'||!['walkthrough','job'].includes(String(item.kind))){complete=false;continue;}
   const visit:BookingVisit={id:item.id,kind:item.kind as 'walkthrough'|'job',status:String(item.status??'unknown'),highlevelContactId:str(item.highlevelContactId),startAt:safeDate(item.startAt),endAt:safeDate(item.endAt),address:str(item.address),highlevelAppointmentId:str(item.highlevelAppointmentId),highlevelCalendarId:str(item.highlevelCalendarId),portalCustomerId:str(item.portalCustomerId),sourceRevision:str(item.sourceRevision)};
   visits.push(visit);
   if(!visit.highlevelContactId){complete=false;continue;}
   // Fetch exact job facts; calendar presence is never cash or an accepted quote.
   stage='hub_job';const detail=await portal(actor,{command:'portal.job',jobId:visit.id}),job=rec(detail.job);
   if(detail.authority!=='employee_hub'||job.id!==visit.id||job.highlevelContactId!==visit.highlevelContactId){complete=false;continue;}
   portalRecords.push({id:visit.id,highlevelContactId:visit.highlevelContactId,kind:visit.kind,status:visit.status,createdAt:safeDate(job.createdAt),updatedAt:safeDate(job.updatedAt),completedAt:safeDate(job.completedAt),soldAt:safeDate(job.soldAt),startAt:visit.startAt,sourceRevision:visit.sourceRevision??null,highlevelAppointmentId:visit.highlevelAppointmentId??null,normalizedLocalJobId:str(job.normalizedLocalJobId),normalizedLocalAppointmentId:str(job.normalizedLocalAppointmentId),address:visit.address??null,financials:rec(detail.financials)});
  }
  if(result.nextOffset===null||result.nextOffset===undefined)break;
  stage='hub_calendar';if(typeof result.nextOffset!=='number'||result.nextOffset<=offset)throw new Error('hub_calendar_pagination_stalled');
  offset=result.nextOffset;if(page===29)complete=false;
 }
 const calendarContactIds=[...new Set(visits.map(v=>v.highlevelContactId).filter((id):id is string=>Boolean(id)))];
 const activitySince=new Date(Date.now()-30*86400000);
 stage='provider_snapshot';const [providerRows,syncs,events,contactRows]=await Promise.all([
  db.select({appointment:schema.appointments,providerContactId:schema.contacts.providerId}).from(schema.appointments).innerJoin(schema.contacts,eq(schema.contacts.id,schema.appointments.contactId)),
  db.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,'operations:ghl:last_success')).limit(1),
  db.select({event:schema.customerEvents,providerContactId:schema.contacts.providerId}).from(schema.customerEvents).innerJoin(schema.contacts,eq(schema.contacts.id,schema.customerEvents.contactId)),
  db.select({contactId:schema.contacts.id,providerId:schema.contacts.providerId}).from(schema.contacts).where(and(eq(schema.contacts.provider,'ghl'),or(
   calendarContactIds.length?inArray(schema.contacts.providerId,calendarContactIds):sql`false`,
   customerActivityPredicate(activitySince)
  ))).orderBy(calendarContactIds.length?desc(inArray(schema.contacts.providerId,calendarContactIds)):desc(schema.contacts.createdAt),customerRefreshOrder(),desc(schema.contacts.createdAt)).limit(501)
 ]);
 // Exact-contact evidence includes accepted estimates, completed work and receipts
 // with no calendar date. Never claim an unbounded snapshot for other customers.
 const requested=[...new Set([...calendarContactIds,...contactRows.map(c=>c.providerId)])].slice(0,500);
 const selected=contactRows.filter(c=>requested.includes(c.providerId)).slice(0,500);
 const selectionComplete=contactRows.length<=500&&new Set([...calendarContactIds,...contactRows.map(c=>c.providerId)]).size<=500;
 let evidenceComplete=false,evidenceAsOf=new Date().toISOString(),evidenceError:string|null=null;
 let evidenceFailure:ReconciliationDiagnostic|null=null;
 if(requested.length){
  try{
   stage='hub_evidence';
   const evidence=exactEvidence(await portal(actor,{command:'portal.evidence',contactProviderIds:requested}),requested);
   evidenceComplete=evidence.complete;evidenceAsOf=evidence.asOf;
   // A complete exact-contact scan supersedes the bounded calendar materialization.
   // An incomplete scan may add verified facts but cannot retire cached records.
   const byId=new Map((evidence.complete?[]:portalRecords).map(r=>[r.id,r]));for(const r of evidence.records)byId.set(r.id,r);
   portalRecords.splice(0,portalRecords.length,...byId.values());
   if(!evidence.complete)evidenceError='hub_evidence_coverage_incomplete';
  }catch(error){evidenceError='hub_evidence_unavailable_or_invalid';evidenceFailure=reconciliationDiagnostic(error,'hub_evidence');}
 }
 stage='booking_repair';
 const providerComplete=Boolean(syncs[0]?.cursor&&Date.now()-Date.parse(syncs[0].cursor)<10*60000);
 const snapshot:BookingSnapshot={visits,appointments:providerRows.map(({appointment:a,providerContactId})=>({id:a.providerId,contactProviderId:providerContactId,calendarId:a.calendarId,status:a.status,startAt:a.appointmentStartAt.toISOString(),endAt:a.appointmentEndAt?.toISOString()??null,address:str(a.raw.address)})),verbalBookings:events.filter(({event:e})=>e.active&&!e.humanReviewNeeded&&['walkthrough_verbally_booked','job_verbally_accepted'].includes(e.eventType)).map(({event:e,providerContactId})=>({eventId:e.eventId,contactId:e.contactId,contactProviderId:providerContactId,kind:e.eventType==='walkthrough_verbally_booked'?'walkthrough':'job',startAt:safeDate(e.details.scheduledAt),evidence:'Canonical source-linked commitment',occurredAt:e.occurredAt.toISOString()})),coverage:{portalComplete:complete,providerComplete}};
 const result=await reconcileBookingSnapshot(snapshot,{dryRun:env.EGC_BOOKING_AUTO_RECONCILE!=='true',limit:25,syncVisit:input=>syncPortalSchedule(actor,{command:'schedule.sync_provider',...input},portal,{env})});
 let adoption:unknown;
 try{adoption=await reconcileExistingBookingAdoption(portal,{env,visits,portalComplete:complete&&evidenceComplete,providerComplete});}
 catch{adoption={dryRun:env.EGC_BOOKING_ADOPT_EXISTING!=='true',complete:false,error:'adoption_plan_unavailable'};}
 const evidenceDiagnostics={requestedContacts:requested.length,reconciledContacts:selected.length,selectionComplete,complete:evidenceComplete,asOf:evidenceAsOf,error:evidenceError,failure:evidenceFailure,unmappedCalendarContacts:calendarContactIds.filter(id=>!contactRows.some(c=>c.providerId===id))};
 const diagnosticResult={...result,portalEvidence:evidenceDiagnostics,adoption};
 stage='diagnostic_save';await db.insert(schema.syncCursors).values({key:'customer_state:booking_reconciliation',cursor:JSON.stringify(diagnosticResult)}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor:JSON.stringify(diagnosticResult),updatedAt:new Date()}});
 stage='canonical_ingestion';
 if(selected.length)await reconcileCustomerState({contactIds:selected.map(c=>c.contactId),since:new Date(activitySince),until:new Date(),maxContacts:500,useAI:false,portalRecords,portalCoverage:{complete:evidenceComplete,asOf:evidenceAsOf,...(evidenceError?{error:evidenceError}:{})}});
 return {visits:visits.length,portalComplete:complete,providerComplete,portalEvidence:evidenceDiagnostics,counts:result.counts,repairs:result.results.length,adoption};
 }catch(error){throw new ReconciliationFailure(error,stage);}
}
