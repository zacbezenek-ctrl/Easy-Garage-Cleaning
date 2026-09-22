import { asRecord, validDate } from "./core.js";
import type { CustomerEventType, EvidenceEvent, Json, PortalEvidenceRecord, SourceRecord } from "./types.js";
type Row=Record<string,unknown>;
export interface SourceBundle {
  contact:Row;lead:Row;messages?:Row[];calls?:Row[];transcripts?:Row[];appointments?:Row[];opportunities?:Row[];jobs?:Row[];notes?:Row[];providerNotes?:Row[];walkthroughs?:Row[];
  portalRecords?:PortalEvidenceRecord[];walkthroughCalendarIds?:string[];jobCalendarIds?:string[];
}
const str=(v:unknown)=>typeof v==="string"?v:"";
const timestamp=(v:unknown,fallback:unknown)=>validDate(v)??validDate(fallback)??"1970-01-01T00:00:00.000Z";
const amount=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:null;
export const usableTranscriptText=(v:unknown)=>typeof v==="string"&&v.trim().length>0&&!/^(?:no transcript(?:ion)? (?:found|available)|transcript(?:ion)? (?:not found|unavailable)|null|undefined)$/i.test(v.trim())?v:"";
const event=(eventType:CustomerEventType,text:string,details:Json={},valueCents:number|null=null):EvidenceEvent=>({eventType,supportingText:text,confidence:1,humanReviewNeeded:false,nextAction:null,details,...(valueCents===null?{}:{valueCents,valueVerified:true,currency:"USD"})});

/** Every adapter preserves source identifiers. Missing transition times are recorded
 * as unknown, not replaced by ingestion/update times for reporting or Meta sync.
 */
export function recordsFromSnapshot(bundle:SourceBundle):SourceRecord[] {
  const {contact,lead}=bundle,contactId=str(contact.id),leadId=str(lead.id),records:SourceRecord[]=[];
  const add=(source:Omit<SourceRecord,"contactId"|"leadId">)=>records.push({...source,contactId,leadId});
  add({sourceType:"lead",sourceRecordId:leadId,occurredAt:timestamp(lead.createdAt,contact.providerCreatedAt),text:"Lead created",events:[event("lead_created","Lead created")]});
  if(lead.doNotContact===true || asRecord(contact.raw).dnd===true)add({sourceType:"lead",sourceRecordId:`${leadId}:dnc`,occurredAt:timestamp(lead.updatedAt,lead.createdAt),text:"Provider do-not-contact enabled",events:[event("do_not_contact","Provider do-not-contact enabled",{occurredAtVerified:false})]});
  for(const m of bundle.messages??[]) {
    if(/call|voicemail/i.test(str(m.type)) || ["1","10"].includes(str(m.type)))continue;
    add({sourceType:"message",sourceRecordId:str(m.providerId)||str(m.id),occurredAt:timestamp(m.occurredAt,m.createdAt),text:str(m.body),direction:str(m.direction),actorType:str(m.actorType),raw:asRecord(m.raw),sourcePointer:`messages:${str(m.id)}`});
  }
  for(const c of bundle.calls??[]) {
    const transcript=(bundle.transcripts??[]).find(t=>t.callId===c.id);
    const text=usableTranscriptText(transcript?.text)||usableTranscriptText(transcript?.transcript);
    add({sourceType:text?"call_transcript":"call",sourceRecordId:str(c.providerMessageId)||str(c.id),occurredAt:timestamp(c.startedAt,c.createdAt),text,direction:str(c.direction),actorType:str(c.actorType),raw:asRecord(c.raw),sourcePointer:text?`call_transcripts:${str(transcript?.id)||str(c.id)}`:`calls:${str(c.id)}`});
  }
  const walkIds=new Set(bundle.walkthroughCalendarIds??[]),jobIds=new Set(bundle.jobCalendarIds??[]);
  for(const a of bundle.appointments??[]) {
    if(!["new","confirmed","showed"].includes(str(a.status)))continue;
    const calendar=str(a.calendarId),raw=asRecord(a.raw),title=str(a.title);
    const isJob=jobIds.has(calendar)||/^SERVICE JOB\b/i.test(title);
    const walkthrough=!isJob&&(walkIds.has(calendar)||/walk\s*through|walkthrough|consultation/i.test(title));
    const creation=validDate(a.appointmentCreatedAt),events:EvidenceEvent[]=[];
    if(walkthrough)events.push(event("walkthrough_booked",`Provider appointment ${str(a.providerId)}: ${title} (${str(a.status)})`,{scheduledAt:validDate(a.appointmentStartAt),address:raw.address??null,occurredAtVerified:Boolean(creation)}));
    if(isJob)events.push(event("job_scheduled",`Service appointment ${str(a.providerId)}: ${title}`,{scheduledAt:validDate(a.appointmentStartAt),occurredAtVerified:Boolean(creation)}));
    if(walkthrough&&a.status==="showed") {
      const completedAt=validDate(raw.completedAt??raw.showedAt??raw.statusChangedAt);
      events.push({...event("walkthrough_showed",`Provider marked appointment showed: ${title}`,{occurredAtVerified:Boolean(completedAt)}),occurredAt:completedAt??timestamp(a.updatedAt,a.appointmentStartAt)});
    }
    if(!walkthrough&&!isJob)events.push({eventType:"walkthrough_booked",supportingText:`Appointment type unverified: ${title}`,confidence:.5,humanReviewNeeded:true,nextAction:"Confirm the calendar's appointment type",details:{calendarId:calendar,occurredAtVerified:Boolean(creation)}});
    add({sourceType:"appointment",sourceRecordId:str(a.providerId)||str(a.id),appointmentId:str(a.id),occurredAt:creation??timestamp(a.createdAt,a.appointmentStartAt),text:title,raw,events});
  }
  for(const o of bundle.opportunities??[]) {
    const raw=asRecord(o.raw),events:EvidenceEvent[]=[],won=validDate(o.wonAt);
    if(o.status==="won")events.push(event("job_sold","Provider opportunity marked won",{occurredAtVerified:Boolean(won)},amount(o.monetaryValueCents)));
    if(o.status==="lost"||o.status==="abandoned")events.push(event("lost",`Provider opportunity marked ${str(o.status)}`,{occurredAtVerified:Boolean(validDate(raw.lostAt))}));
    add({sourceType:"opportunity",sourceRecordId:str(o.providerId)||str(o.id),opportunityId:str(o.id),occurredAt:won??timestamp(raw.lostAt,o.providerUpdatedAt??o.updatedAt),text:`Opportunity status: ${str(o.status)}`,raw,events});
  }
  for(const j of bundle.jobs??[]) {
    const linkedAppointment=(bundle.appointments??[]).find(a=>a.id===j.appointmentId);
    const serviceCalendar=Boolean(linkedAppointment&&jobIds.has(str(linkedAppointment.calendarId)));
    const walkthrough=!serviceCalendar&&(/walk\s*through|estimate|consultation/i.test(str(j.serviceType)) || Boolean(linkedAppointment && (walkIds.has(str(linkedAppointment.calendarId)) || /walk\s*through|consultation/i.test(str(linkedAppointment.title))))),events:EvidenceEvent[]=[],won=validDate(j.wonAt),status=str(j.status).toLowerCase();
    if(!walkthrough && ["sold","won","confirmed","scheduled","in_progress","completed","paid","closed"].includes(status))events.push(event("job_sold",`EGC service job status ${status}`,{occurredAtVerified:Boolean(won)}));
    if(!walkthrough && validDate(j.scheduledAt)&&["confirmed","scheduled","in_progress","completed","paid","closed"].includes(status))events.push(event("job_scheduled",`EGC service job scheduled ${String(j.scheduledAt)}`,{scheduledAt:validDate(j.scheduledAt),occurredAtVerified:false}));
    if(!walkthrough && ["completed","paid","closed"].includes(status))events.push({...event("job_completed",`EGC service job status ${status}`,{occurredAtVerified:Boolean(validDate(j.completedAt))}),occurredAt:timestamp(j.completedAt,j.updatedAt)});
    // A quoted price or deposit field is not proof of payment.
    if(walkthrough&&validDate(j.scheduledAt)&&["scheduled","confirmed"].includes(status))events.push(event("walkthrough_verbally_booked",`Local walkthrough scheduled ${String(j.scheduledAt)}`,{scheduledAt:validDate(j.scheduledAt),address:j.serviceAddress??null,occurredAtVerified:false}));
    add({sourceType:"job",sourceRecordId:str(j.id),jobId:str(j.id),opportunityId:str(j.opportunityId)||null,appointmentId:str(j.appointmentId)||null,occurredAt:won??timestamp(j.createdAt,j.updatedAt),text:`Job status ${status}. ${str(j.accessNotes)}`,events});
    if(str(j.accessNotes))add({sourceType:"job_note",sourceRecordId:`${str(j.id)}:access_notes`,jobId:str(j.id),occurredAt:timestamp(j.updatedAt,j.createdAt),text:str(j.accessNotes),raw:{occurredAtVerified:false}});
  }
  for(const n of bundle.notes??[])add({sourceType:"job_note",sourceRecordId:str(n.id),jobId:str(n.jobId)||null,occurredAt:timestamp(n.createdAt,n.updatedAt),text:str(n.body),raw:{source:n.source??null,createdBy:n.createdBy??null}});
  for(const n of bundle.providerNotes??[]){const raw=asRecord(n.raw),occurredAt=validDate(raw.dateAdded??raw.createdAt);add({sourceType:"provider_note",sourceRecordId:str(n.providerId)||str(raw.id),occurredAt:occurredAt??timestamp(raw.egcNotesReadAt,n.updatedAt),text:str(raw.body)||str(raw.note),raw:{occurredAtVerified:Boolean(occurredAt),createdBy:raw.userId??raw.createdBy??null},sourcePointer:`ghl_contact_note:${str(n.providerId)||str(raw.id)}`});}
  for(const w of bundle.walkthroughs??[]) {
    const events:EvidenceEvent[]=[];
    // Approved scope without visit evidence is not proof that a customer showed.
    if(w.approvedAt && w.portalVisitId && str(w.transcript))events.push(event("walkthrough_completed","Approved EGC Portal walkthrough recording",{portalVisitId:w.portalVisitId,portalJobId:w.portalJobId??null,occurredAtVerified:false}));
    add({sourceType:"walkthrough",sourceRecordId:str(w.id),jobId:str(w.jobId)||null,occurredAt:timestamp(w.approvedAt,w.createdAt),text:str(w.transcript),events});
  }
  for(const p of bundle.portalRecords??[]) {
    if(p.highlevelContactId!==contact.providerId)continue;
    const financials=p.financials??{},quote=asRecord(financials.quote),completion=asRecord(financials.completion);
    const events:EvidenceEvent[]=[],status=p.status.toLowerCase(),created=validDate(p.createdAt),completed=validDate(p.completedAt??completion.at),won=validDate(p.soldAt??quote.at),paid=validDate(p.paidAt);
    const active=!["cancelled","canceled","deleted","draft","invalid"].includes(status);
    const exceptions=Array.isArray(financials.exceptions)?financials.exceptions.filter(x=>typeof x==="string"):[];
    const details:Json={portalRecordId:p.id,portalJobId:p.jobId??p.id,providerAppointmentId:p.highlevelAppointmentId??null,scheduledAt:p.startAt??null,address:p.address??null,sourceRevision:p.sourceRevision??null,occurredAtVerified:Boolean(created),financialExceptions:exceptions,revenueCoverageIncomplete:exceptions.some(e=>/^payment_/.test(String(e)))};
    if(p.kind==="walkthrough"&&active&&p.startAt)events.push(event("walkthrough_booked",`EGC Portal walkthrough ${p.id} (${status})`,details));
    if(p.kind==="walkthrough"&&["completed","closed"].includes(status))events.push({...event("walkthrough_completed",`EGC Portal walkthrough completed ${p.id}`,{...details,occurredAtVerified:Boolean(completed)}),occurredAt:completed??timestamp(p.updatedAt,p.createdAt)});
    if(p.kind==="job"&&((active&&["scheduled","confirmed","in_progress","completed","paid","invoiced","closed"].includes(status))||(won&&!['cancelled','canceled','deleted','invalid'].includes(status))))events.push({...event("job_sold",`EGC Portal accepted job ${p.id} (${status})`,{...details,occurredAtVerified:Boolean(won),valueSource:quote.source??null},amount(quote.amountCents)),occurredAt:won??timestamp(p.createdAt,p.updatedAt)});
    if(p.kind==="job"&&active&&p.startAt)events.push(event("job_scheduled",`EGC Portal job scheduled ${p.id}`,details));
    if(p.kind==="job"&&["completed","paid","invoiced","closed"].includes(status))events.push({...event("job_completed",`EGC Portal job completed ${p.id}`,{...details,occurredAtVerified:Boolean(completed)}),occurredAt:completed??timestamp(p.updatedAt,p.createdAt)});
    const receipts=new Map<string,{at:string;amountCents:number;source:string;reference:string|null;recordedBy:string|null}>(),conflictingKeys=new Set<string>();
    const processorPayments=Array.isArray(financials.payments)?financials.payments:[];
    const staffPayments=(Array.isArray(financials.staffPayments)?financials.staffPayments:[]).filter(v=>{const r=asRecord(v);return r.verified===true&&r.source==="staff_recorded_customer_receipt"&&str(r.reference)&&str(r.recordedBy)&&!['stripe','gift_credit','mixed_with_gift_credit'].includes(str(r.paymentMethod));});
    for(const v of [...processorPayments,...staffPayments]){
      const receipt=asRecord(v),key=str(receipt.key),at=validDate(receipt.at),value=amount(receipt.amountCents);
      if(!key||!at||value===null||(receipt.portalJobId&&receipt.portalJobId!==p.id&&receipt.portalJobId!==p.jobId))continue;
      // A staff-entered processor reference is a mirror, never another receipt.
      if(receipt.source==="staff_recorded_customer_receipt"&&processorPayments.some(v=>{const processor=asRecord(v);return [processor.key,processor.paymentIntentId,processor.checkoutSessionId,processor.reference].includes(receipt.reference);}))continue;
      const prior=receipts.get(key);if(prior&&(prior.at!==at||prior.amountCents!==value)){conflictingKeys.add(key);continue;}
      receipts.set(key,{at,amountCents:value,source:str(receipt.source)||"customer_payment_receipt",reference:str(receipt.reference)||null,recordedBy:str(receipt.recordedBy)||null});
    }
    if(conflictingKeys.size){for(const key of conflictingKeys)receipts.delete(key);details.financialExceptions=[...exceptions,"payment_conflicting_receipt"];details.revenueCoverageIncomplete=true;}
    if(receipts.size){for(const [key,receipt] of receipts)events.push({...event("revenue_collected",`EGC Portal verified customer receipt ${key}`,{...details,occurredAtVerified:true,paymentReceiptKey:key,valueSource:receipt.source,reference:receipt.reference,recordedBy:receipt.recordedBy},receipt.amountCents),occurredAt:receipt.at});}
    else if(paid && amount(p.paidCents)!==null&&!processorPayments.length&&!staffPayments.length&&!conflictingKeys.size)events.push({...event("revenue_collected",`EGC Portal payment recorded ${p.id}`,{...details,occurredAtVerified:true},amount(p.paidCents)),occurredAt:paid});
    add({sourceType:p.kind==="walkthrough"?"portal_visit":p.kind==="payment"?"portal_payment":"portal_job",sourceRecordId:p.id,occurredAt:created??timestamp(p.updatedAt,p.startAt),text:`EGC Portal ${p.kind} ${p.id} status ${status}`,raw:{sourceRevision:p.sourceRevision??null},events});
  }
  return records.sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.sourceRecordId.localeCompare(b.sourceRecordId));
}
