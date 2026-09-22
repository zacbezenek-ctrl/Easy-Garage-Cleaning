import type {Actor,Command} from "./contracts.js";
import type {PortalTimelineEvent} from "./timeline.js";

type JsonObject=Record<string,unknown>;
type Read=(actor:Actor,command:Command)=>Promise<JsonObject>;
export interface NativeHistoryEvidence {
  authority:"employee_hub";
  records:JsonObject[];
  total:number|null;
  returned:number;
  truncated:boolean;
  coverage:{complete:boolean;sourceComplete:boolean;available:boolean;asOf:string|null;reason:string|null;association:"exact_provider_contact"};
}
const object=(v:unknown):JsonObject|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as JsonObject:null;
const instant=(v:unknown):v is string=>typeof v==="string"&&Number.isFinite(Date.parse(v));
const safeId=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,180}$/.test(v)&&!/^(secure_|_egc_)/.test(v);
const fields=["id","highlevelContactId","kind","sourceType","status","customerId","projectId","createdAt","updatedAt","originalBookingAt","completedAt","soldAt","startAt","endAt","localDate","localEndDate","localStart","localEnd","timeZone","sourceRevision","highlevelAppointmentId","highlevelCalendarId","providerAppointmentStatus","syncStatus","syncedAt","jobId","sourceWalkthroughId","address","normalizedLocalJobId","normalizedLocalAppointmentId","adoptionSource","scope","jobInstructions","operationalScope","serviceType","notes","operationNotes","contentCoverage","financials"];
export function unavailableNativeEvidence(reason:string):NativeHistoryEvidence {
  return {authority:"employee_hub",records:[],total:null,returned:0,truncated:false,coverage:{complete:false,sourceComplete:false,available:false,asOf:null,reason,association:"exact_provider_contact"}};
}

/** Read every exact native occurrence for this normalized provider contact. A
 * failed or foreign-contact response cannot become an apparently empty history. */
export async function readNativeHistoryEvidence(actor:Actor,providerId:string|null,read?:Read):Promise<NativeHistoryEvidence> {
  if(!providerId||!safeId(providerId))return unavailableNativeEvidence("portal_contact_link_unresolved");
  if(!read)return unavailableNativeEvidence("portal_authority_unavailable");
  let result:JsonObject;
  try{result=await read(actor,{command:"portal.evidence",contactProviderIds:[providerId]});}
  catch{return unavailableNativeEvidence("portal_evidence_unavailable");}
  const coverage=object(result.coverage),ids=result.contactProviderIds;
  if(result.ok!==true||result.authority!=="employee_hub"||!coverage||typeof coverage.complete!=="boolean"||!instant(coverage.asOf)||!Array.isArray(result.records))return unavailableNativeEvidence("portal_evidence_invalid_response");
  if(!Array.isArray(ids)||ids.length!==1||ids[0]!==providerId)return unavailableNativeEvidence("portal_evidence_identity_mismatch");
  const seen=new Set<string>(),records:JsonObject[]=[];
  // Validate the whole response, including records beyond the display bound.
  for(const value of result.records){
    const record=object(value);
    if(!record||!safeId(record.id)||record.highlevelContactId!==providerId)return unavailableNativeEvidence("portal_evidence_identity_mismatch");
    if(seen.has(record.id)||!["job","walkthrough"].includes(String(record.kind)))return unavailableNativeEvidence("portal_evidence_invalid_response");
    seen.add(record.id);
    if(records.length<100)records.push(Object.fromEntries(fields.filter(key=>key in record).map(key=>[key,record[key]])));
  }
  const reportedTotal=result.total;
  if(reportedTotal!==undefined&&(!Number.isSafeInteger(reportedTotal)||Number(reportedTotal)<result.records.length))return unavailableNativeEvidence("portal_evidence_invalid_response");
  const total=typeof reportedTotal==="number"?reportedTotal:coverage.complete?result.records.length:null;
  const truncated=result.records.length>100||result.truncated===true||(total!==null&&total>records.length);
  const sourceComplete=coverage.complete&&result.truncated!==true&&(total===null||total===result.records.length);
  return {authority:"employee_hub",records,total,returned:records.length,truncated,
    coverage:{complete:sourceComplete&&!truncated,sourceComplete,available:true,asOf:coverage.asOf as string,reason:truncated?"portal_evidence_truncated":sourceComplete?null:"portal_evidence_partial",association:"exact_provider_contact"}};
}

/** Undated native facts stay in records; never assign them an invented timeline time. */
export function nativeHistoryEvents(evidence:NativeHistoryEvidence):PortalTimelineEvent[] {
  const events=new Map<string,PortalTimelineEvent>();
  for(const record of evidence.records){
    const identity={portalJobId:record.id,projectId:record.projectId??null,authority:"employee_hub",association:"exact_portal_record"};
    if(instant(record.createdAt))events.set(`hub-record:${record.id}`,{id:`hub-record:${record.id}`,kind:"portal_record",at:record.createdAt,data:{...record,...identity}});
    const finance=object(record.financials);
    for(const value of Array.isArray(finance?.timeline)?finance.timeline:[]){const event=object(value);if(event&&typeof event.id==="string"&&typeof event.kind==="string"&&instant(event.at)){const id="hub:"+event.id;events.set(id,{id,kind:event.kind,at:event.at,data:{...object(event.data),...identity}});}}
    for(const value of Array.isArray(record.operationNotes)?record.operationNotes:[]){const note=object(value);if(note&&typeof note.id==="string"&&instant(note.createdAt)){const id="hub-note:"+note.id;events.set(id,{id,kind:"job_note",at:note.createdAt,data:{body:note.body,actor:note.actorId,supersedes:note.supersedes,...identity}});}}
    if(record.kind==="walkthrough"&&instant(record.completedAt)){const id="hub-walkthrough:"+record.id;events.set(id,{id,kind:"walkthrough_completed",at:record.completedAt,data:{portalVisitId:record.id,...identity,association:"exact_visit"}});}
  }
  return [...events.values()];
}
