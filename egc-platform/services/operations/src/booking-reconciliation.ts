import {appointmentDigest, appointmentStatus} from "./appointment-reliability.js";

/** Hub records are the schedule authority. Provider observations are evidence,
 * never a reason to manufacture a Hub visit or revive a cancelled appointment. */
export interface BookingVisit {
  id:string; kind:"walkthrough"|"job"; status:string; highlevelContactId:string|null;
  startAt:string|null; endAt:string|null; address:string|null;
  highlevelAppointmentId?:string|null; highlevelCalendarId?:string|null;
  portalCustomerId?:string|null; portalProjectId?:string|null; sourceRevision?:string|null;
  syncStatus?:string|null; providerAppointmentStatus?:string|null;
}
export interface BookingProviderEvent {
  id:string; contactProviderId:string|null; calendarId:string|null; status:string|null;
  startAt:string|null; endAt:string|null; address?:string|null;
}
export interface VerbalBooking {
  eventId:string; contactId:string; contactProviderId:string|null; kind:"walkthrough"|"job";
  startAt:string|null; evidence:string; occurredAt:string;
}
export type BookingReconciliationStatus="fully_reconciled"|"verbally_booked_provider_pending"|"provider_booking_confirmed"|"reconciliation_needed"|"duplicate_suspected";
export interface BookingFinding {
  id:string; code:string; status:BookingReconciliationStatus;
  portalVisitId:string|null; contactProviderId:string|null; providerAppointmentIds:string[];
  nextAction:string; automaticRepair:boolean; evidenceIds:string[];
}
export interface BookingSnapshot {
  visits:BookingVisit[]; appointments:BookingProviderEvent[]; verbalBookings?:VerbalBooking[];
  coverage:{portalComplete:boolean;providerComplete:boolean};
}
const instant=(s:string|null|undefined)=>s&&Number.isFinite(Date.parse(s))?Date.parse(s):null;
const cancelled=(s:string|null)=>appointmentStatus(s)==="cancelled";
const active=(s:string|null)=>["new","confirmed","showed"].includes(appointmentStatus(s)??"");
const terminal=(s:string)=>["cancelled","canceled","noshow","no_show","no-show"].includes(s);
export function expectedProviderAppointmentStatus(s:string):string {
  if(["cancelled","canceled"].includes(s))return "cancelled";
  if(["completed","paid","invoiced","closed","review_requested"].includes(s))return "showed";
  if(["noshow","no_show","no-show"].includes(s))return "noshow";
  return "confirmed";
}
const sameTime=(a:string|null|undefined,b:string|null|undefined)=>instant(a)!==null&&instant(a)===instant(b);
const near=(a:string|null,b:string|null)=>instant(a)!==null&&instant(b)!==null&&Math.abs(instant(a)!-instant(b)!)<=90_000;
const exact=(visit:BookingVisit,event:BookingProviderEvent)=>Boolean(visit.highlevelContactId)&&visit.highlevelContactId===event.contactProviderId&&sameTime(visit.startAt,event.startAt)&&sameTime(visit.endAt,event.endAt)&&(!visit.highlevelCalendarId||visit.highlevelCalendarId===event.calendarId);

export function diagnoseBookingReconciliation(snapshot:BookingSnapshot) {
  const findings:BookingFinding[]=[],linked=new Set(snapshot.visits.map(v=>v.highlevelAppointmentId).filter(Boolean));
  const add=(code:string,visit:BookingVisit|null,events:BookingProviderEvent[],nextAction:string,automaticRepair=false,status:BookingReconciliationStatus="reconciliation_needed",evidenceIds:string[]=[])=>{
    const identity={code,portalVisitId:visit?.id??null,providerAppointmentIds:events.map(e=>e.id).sort(),evidenceIds:[...evidenceIds].sort()};
    findings.push({id:`booking:${appointmentDigest(identity)}`,...identity,contactProviderId:visit?.highlevelContactId??events[0]?.contactProviderId??null,
      status,nextAction,automaticRepair:automaticRepair&&snapshot.coverage.portalComplete&&snapshot.coverage.providerComplete});
  };
  if(!snapshot.coverage.portalComplete||!snapshot.coverage.providerComplete)add("booking_source_coverage_incomplete",null,[],"Restore complete Hub and provider reads before repair.");
  for(const visit of snapshot.visits) {
    const matching=snapshot.appointments.filter(e=>e.contactProviderId===visit.highlevelContactId&&near(e.startAt,visit.startAt)&&active(e.status));
    const provider=visit.highlevelAppointmentId?snapshot.appointments.find(e=>e.id===visit.highlevelAppointmentId):null;
    const localDuplicates=snapshot.visits.filter(v=>v.id!==visit.id&&v.kind===visit.kind&&v.highlevelContactId&&v.highlevelContactId===visit.highlevelContactId&&sameTime(v.startAt,visit.startAt)&&!terminal(v.status));
    if(!terminal(visit.status)&&localDuplicates.length){add("duplicate_hub_visit_suspected",visit,matching,"Review exact Hub visits and retain the intended visit; preserve cancellation history.",false,"duplicate_suspected",localDuplicates.map(v=>v.id));continue;}
    if(matching.length>1){add("duplicate_provider_appointments",visit,matching,"Compare provider appointments and retain the verified Hub link; cancel only proven duplicates.",false,"duplicate_suspected");continue;}
    if(!visit.highlevelContactId){add("hub_customer_link_missing",visit,provider?[provider]:[],"Resolve the exact Hub customer/contact identity before provider synchronization.");continue;}
    if(instant(visit.startAt)===null||instant(visit.endAt)===null||instant(visit.endAt)!<=instant(visit.startAt)!){add("hub_schedule_time_invalid",visit,provider?[provider]:[],"Correct the Hub visit time using the original customer agreement.");continue;}
    if(!terminal(visit.status)&&!visit.address?.trim()){add("hub_address_missing",visit,provider?[provider]:[],"Recover the agreed address from customer evidence and save it on the Hub visit.");continue;}
    if(visit.highlevelAppointmentId&&!provider){add("linked_provider_appointment_missing",visit,[],"Read the exact provider appointment; do not create a replacement from a missing mirror.");continue;}
    if(provider){
      if(!exact(visit,provider)){add("provider_schedule_or_identity_mismatch",visit,[provider],"Compare Hub agreement and exact provider identity; reconcile the saved Hub schedule.");continue;}
      if(cancelled(provider.status)&&!cancelled(visit.status)){add("provider_cancelled_while_hub_active",visit,[provider],"Resolve the cancellation against customer evidence; never revive a previously cancelled duplicate automatically.");continue;}
      if(appointmentStatus(provider.status)!==expectedProviderAppointmentStatus(visit.status)){
        add(cancelled(visit.status)?"stale_cancelled_mirror":"provider_status_mismatch",visit,[provider],"Synchronize the exact provider link from the saved Hub status.",true);continue;
      }
      if(!visit.portalCustomerId){add("hub_customer_link_missing",visit,[provider],"Verify the saved provider contact and link this exact native Hub visit to its customer.",true);continue;}
      add("booking_reconciled",visit,[provider],"No scheduling action required.",false,"fully_reconciled");continue;
    }
    if(terminal(visit.status)){add("terminal_hub_visit_without_provider",visit,[],"Retain the terminal Hub history; no provider appointment should be created.",false,"fully_reconciled");continue;}
    if(matching[0]){
      if(exact(visit,matching[0]))add("provider_booking_missing_hub_link",visit,matching,"Verify and attach the existing provider appointment to this Hub visit.",true,"provider_booking_confirmed");
      else add("nearby_provider_booking_requires_review",visit,matching,"Review nearby provider booking before creating or changing anything.");
      continue;
    }
    add("hub_visit_provider_pending",visit,[],visit.portalCustomerId?"Synchronize this saved Hub visit using the durable read-before-write appointment path.":"Verify the saved provider contact, link this exact Hub visit to its customer, then synchronize its appointment.",true,"reconciliation_needed");
  }
  for(const event of snapshot.appointments.filter(e=>active(e.status)&&!linked.has(e.id))) {
    if(snapshot.visits.some(v=>exact(v,event)))continue;
    add("provider_booking_missing_hub_visit",null,[event],"Find or create the authoritative Hub visit from verified customer evidence, then link this provider appointment.",false,"provider_booking_confirmed");
  }
  for(const evidence of snapshot.verbalBookings??[]) {
    if(snapshot.visits.some(v=>v.highlevelContactId===evidence.contactProviderId&&v.kind===evidence.kind&&(evidence.startAt?sameTime(v.startAt,evidence.startAt):!terminal(v.status))))continue;
    const finding:BookingFinding={id:`booking:${appointmentDigest({eventId:evidence.eventId,code:"verbal_booking_missing_hub_visit"})}`,code:"verbal_booking_missing_hub_visit",status:"verbally_booked_provider_pending",portalVisitId:null,contactProviderId:evidence.contactProviderId,providerAppointmentIds:[],nextAction:"Save the verified agreed time and address in the EGC Hub, then synchronize the provider.",automaticRepair:false,evidenceIds:[evidence.eventId]};
    findings.push(finding);
  }
  return {authority:"employee_hub" as const,coverage:snapshot.coverage,findings,
    counts:Object.fromEntries(["fully_reconciled","verbally_booked_provider_pending","provider_booking_confirmed","reconciliation_needed","duplicate_suspected"].map(status=>[status,findings.filter(f=>f.status===status).length])),
    unresolved:findings.filter(f=>f.status!=="fully_reconciled")};
}

/** The callback must call schedule.sync_provider, which freshly resolves Hub and
 * provider records and uses the durable appointment ledger. It must never issue
 * a raw provider create. Ambiguous/cancelled/duplicate records stay diagnostics. */
export async function reconcileBookingSnapshot(snapshot:BookingSnapshot,options:{
  syncVisit:(input:{portalVisitId:string;requestId:string;runAutomations:false})=>Promise<unknown>;
  limit?:number; dryRun?:boolean;
}) {
  const diagnostics=diagnoseBookingReconciliation(snapshot),limit=Math.min(100,Math.max(0,options.limit??25));
  const candidates=diagnostics.findings.filter(f=>f.automaticRepair&&f.portalVisitId),results=[];
  for(const item of candidates.slice(0,limit)){
    const visit=snapshot.visits.find(v=>v.id===item.portalVisitId)!;
    const requestId=`reconcile:${appointmentDigest({portalVisitId:visit.id,startAt:visit.startAt,endAt:visit.endAt,status:visit.status,address:visit.address,providerId:visit.highlevelAppointmentId??null})}`;
    if(options.dryRun!==false){results.push({findingId:item.id,portalVisitId:visit.id,status:"would_reconcile"});continue;}
    try{await options.syncVisit({portalVisitId:visit.id,requestId,runAutomations:false});results.push({findingId:item.id,portalVisitId:visit.id,status:"reconciled"});}
    catch(error){const code=error&&typeof error==="object"&&"code" in error&&typeof error.code==="string"&&/^[a-z_]+$/.test(error.code)?error.code:"booking_reconciliation_unavailable";results.push({findingId:item.id,portalVisitId:visit.id,status:"blocked",errorCode:code});}
  }
  return {...diagnostics,results,remaining:Math.max(0,candidates.length-limit),dryRun:options.dryRun!==false};
}
