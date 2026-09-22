import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { assertionEvents, assertionReconciled, asRecord, buildCanonicalEvents, buildReport, captureOriginalAttribution, EXTRACTOR_VERSION, exclusionReasons, extractEvidence, hash, projectCustomer, validDate,validateUserConfirmedOutcome } from "./core.js";
import { extractStructuredEvidence } from "./extractor.js";
import { recordsFromSnapshot,usableTranscriptText } from "./sources.js";
import type { CanonicalEvent, CustomerProjection, EvidenceEvent, Json, OperationalAssertion, ReconcileOptions, SourceRecord } from "./types.js";
export * from "./core.js";
export * from "./sources.js";
export { extractStructuredEvidence, validateExtractedEvent } from "./extractor.js";

type DbEvent=typeof schema.customerEvents.$inferSelect;
const toEvent=(e:DbEvent):CanonicalEvent=>({...e,confidence:Number(e.confidence),occurredAt:e.occurredAt.toISOString(),eventType:e.eventType as CanonicalEvent["eventType"],source:e.source as CanonicalEvent["source"],evidence:e.evidence as CanonicalEvent["evidence"]});
const toAssertion=(a:typeof schema.customerOperationalAssertions.$inferSelect):OperationalAssertion=>({...a,assertedAt:a.assertedAt.toISOString(),occurredAt:a.occurredAt.toISOString(),reconciledAt:a.reconciledAt?.toISOString()??null,status:a.status as OperationalAssertion["status"]});
const sourceId=(r:Pick<SourceRecord,"sourceType"|"sourceRecordId">)=>`egce_${hash(`${r.sourceType}:${r.sourceRecordId}`)}`;
const ids=(s:string|undefined)=>(s??"").split(",").map(s=>s.trim()).filter(Boolean);

export type ReconciliationResult={startedAt:string;finishedAt:string;inspected:number;truncated:boolean;failed:number;partialCustomers:number;results:Array<{contactId:string;state?:string;events?:number;coverage?:Json;error?:string}>};
export async function reconcileCustomerState(options:ReconcileOptions={}):Promise<ReconciliationResult> {
  const db=getDb(),startedAt=new Date(),since=new Date(options.since??Date.now()-30*86_400_000),until=new Date(options.until??Date.now());
  if(!Number.isFinite(since.valueOf())||!Number.isFinite(until.valueOf())||since>until)throw new Error("invalid_reconciliation_window");
  const max=Math.max(1,Math.min(2000,options.maxContacts??500));
  const selected=await db.select({contact:schema.contacts,lead:schema.leads}).from(schema.leads).innerJoin(schema.contacts,eq(schema.contacts.id,schema.leads.contactId)).where(
    options.contactIds ? (options.contactIds.length?inArray(schema.contacts.id,options.contactIds):sql`false`) : and(lt(schema.leads.createdAt,until),or(gte(schema.leads.createdAt,since),sql`exists(select 1 from messages m where m.contact_id=${schema.contacts.id} and m.occurred_at>=${since.toISOString()}::timestamptz)`,sql`exists(select 1 from calls c where c.contact_id=${schema.contacts.id} and c.started_at>=${since.toISOString()}::timestamptz)`,sql`exists(select 1 from customer_operational_assertions a where a.contact_id=${schema.contacts.id} and a.status='pending_reconciliation')`))
  ).orderBy(desc(schema.leads.createdAt)).limit(max+1);
  const truncated=selected.length>max,customers=selected.slice(0,max),results:Array<{contactId:string;state?:string;events?:number;coverage?:Json;error?:string}>=[];
  for(const {contact,lead} of customers) {
    try {
      const [messages,calls,transcripts,appointments,opportunities,jobs,notes,walkthroughs,cached,assertionRows,originalRows,providerNotes,notesCursor]=await Promise.all([
        db.select().from(schema.messages).where(eq(schema.messages.contactId,contact.id)).orderBy(asc(schema.messages.occurredAt)),
        db.select().from(schema.calls).where(eq(schema.calls.contactId,contact.id)).orderBy(asc(schema.calls.startedAt)),
        db.select({id:schema.callTranscripts.id,callId:schema.callTranscripts.callId,text:schema.callTranscripts.text}).from(schema.callTranscripts).innerJoin(schema.calls,eq(schema.calls.id,schema.callTranscripts.callId)).where(eq(schema.calls.contactId,contact.id)),
        db.select().from(schema.appointments).where(eq(schema.appointments.contactId,contact.id)),db.select().from(schema.opportunities).where(eq(schema.opportunities.contactId,contact.id)),
        db.select().from(schema.jobs).where(eq(schema.jobs.contactId,contact.id)),
        db.select({id:schema.jobNotes.id,jobId:schema.jobNotes.jobId,body:schema.jobNotes.body,source:schema.jobNotes.source,createdBy:schema.jobNotes.createdBy,createdAt:schema.jobNotes.createdAt}).from(schema.jobNotes).innerJoin(schema.jobs,eq(schema.jobs.id,schema.jobNotes.jobId)).where(eq(schema.jobs.contactId,contact.id)),
        db.select().from(schema.walkthroughs).where(eq(schema.walkthroughs.contactId,contact.id)),
        db.select().from(schema.customerEvidence).where(eq(schema.customerEvidence.contactId,contact.id)),
        db.select().from(schema.customerOperationalAssertions).where(and(eq(schema.customerOperationalAssertions.contactId,contact.id),sql`${schema.customerOperationalAssertions.status}<>'superseded'`)),
        db.select().from(schema.leadOriginalAttribution).where(eq(schema.leadOriginalAttribution.leadId,lead.id)),
        db.select().from(schema.providerMappings).where(and(eq(schema.providerMappings.provider,"ghl"),eq(schema.providerMappings.resourceType,"contact_note"),sql`${schema.providerMappings.raw}->>'egcContactId'=${contact.id}`)),
        db.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,`customer_state:provider_notes:${contact.id}`))
      ]);
      const attribution=captureOriginalAttribution({raw:contact.raw,source:lead.source,leadCreatedAt:lead.createdAt.toISOString()},originalRows[0]?.attribution);
      await db.insert(schema.leadOriginalAttribution).values({leadId:lead.id,contactId:contact.id,attribution,sourceRecordId:contact.providerId,provenance:String(attribution.provenance??"provider_initial_attribution")}).onConflictDoNothing();
      const records=recordsFromSnapshot({contact,lead,messages,calls,transcripts,appointments,opportunities,jobs,notes,providerNotes,walkthroughs,
        portalRecords:options.portalRecords??[],walkthroughCalendarIds:ids(process.env.META_CAPI_WALKTHROUGH_CALENDAR_IDS),jobCalendarIds:ids(process.env.META_CAPI_JOB_CALENDAR_IDS)});
      // Hub is a separate authoritative source. A worker without its bridge must
      // retain the last known exact records and disclose their freshness.
      const seen=new Set(records.map(sourceId));
      const retiredPortalIds=new Set(cached.filter(row=>{
        if(!row.sourceType.startsWith("portal_")||seen.has(row.id)||!options.portalCoverage?.complete)return false;
        const window=options.portalCoverage.window;if(!window)return true;
        // Calendar snapshots are bounded. Absence outside their exact covered
        // scheduled interval cannot invalidate historic receipts or completed work.
        const scheduled=(row.extractedEvents as unknown as EvidenceEvent[]).map(e=>validDate(e.details?.scheduledAt)).filter((v):v is string=>Boolean(v));
        const start=validDate(window.start),end=validDate(window.end);
        return Boolean(start&&end&&scheduled.length&&scheduled.every(at=>at>=start&&at<end));
      }).map(row=>row.id));
      for(const row of cached)if(["portal_visit","portal_job","portal_payment","provider_note"].includes(row.sourceType)&&!seen.has(row.id)&&!retiredPortalIds.has(row.id))records.push({sourceType:row.sourceType as SourceRecord["sourceType"],sourceRecordId:row.sourceRecordId,contactId:contact.id,leadId:lead.id,occurredAt:row.occurredAt.toISOString(),text:"",events:row.extractedEvents as unknown as EvidenceEvent[],extractionStatus:row.status,...(row.sourcePointer?{sourcePointer:row.sourcePointer}:{})});
      const pending:SourceRecord[]=[],prepared:SourceRecord[]=[],hashes=new Map<string,string>();
      for(const record of records) {
        const digest=hash(JSON.stringify({text:record.text,direction:record.direction,actorType:record.actorType,raw:record.raw,events:record.events}));hashes.set(sourceId(record),digest);
        const previous=cached.find(e=>e.id===sourceId(record));
        const goodCache=previous?.sourceHash===digest && previous.extractorVersion===EXTRACTOR_VERSION;
        if(goodCache && (previous.status==="complete" || previous.status==="review_required" || options.useAI===false || !process.env.OPENAI_API_KEY))prepared.push({...record,events:previous.extractedEvents as unknown as EvidenceEvent[],extractionStatus:previous.status});
        else if(record.events)prepared.push({...record,extractionStatus:"complete"});
        else pending.push(record);
      }
      // Bounded model requests keep complete transcripts intact. Context adds prior
      // messages so a customer's short agreement can refer to the actual offer.
      const extractionErrors:string[]=[];
      let batch:SourceRecord[]=[],size=0;
      const runBatch=async()=>{
        if(!batch.length)return;
        const earliest=batch[0]!.occurredAt,context=records.filter(r=>r.occurredAt<earliest&&r.text&&["message","call_transcript"].includes(r.sourceType)).slice(-8);
        const extracted=await extractStructuredEvidence(batch,context,{useAI:options.useAI!==false});
        if(extracted.error)extractionErrors.push(extracted.error);
        prepared.push(...extracted.records.map(r=>({...r,extractionStatus:extracted.status==="complete"?"complete":extracted.error?.startsWith("unsupported_or_unquoted")?"review_required":"partial"})));
        batch=[];size=0;
      };
      for(const record of pending){if(size+record.text.length>60_000 || batch.length>=35)await runBatch();batch.push(record);size+=record.text.length;}await runBatch();
      // Text/time and address often arrive separately. Re-evaluate every message
      // against preceding content without discarding semantic events in its cache.
      for(const record of prepared){const {events:alreadyExtracted,...source}=record;const local=record.extractionStatus==="complete"&&["message","call_transcript","job_note","provider_note"].includes(record.sourceType)?[]:extractEvidence(source,records);record.events=[...(alreadyExtracted??[]),...local.filter(e=>!alreadyExtracted?.some(p=>p.eventType===e.eventType))].map(e=>record.raw?.occurredAtVerified===false?{...e,details:{...e.details,occurredAtVerified:false}}:e);}
      const providerEvents=buildCanonicalEvents(prepared,attribution),assertions=assertionRows.map(toAssertion);
      for(const assertion of assertions)if(assertionReconciled(assertion,providerEvents)){assertion.status="reconciled";assertion.reconciledAt=startedAt.toISOString();}
      const assertionSources:SourceRecord[]=assertions.map(a=>({sourceType:"user_confirmed",sourceRecordId:a.id,contactId:contact.id,leadId:lead.id,occurredAt:a.occurredAt,text:a.exactText,events:assertionEvents(a).filter(e=>!(e.eventType==="revenue_collected"&&a.status==="reconciled"&&providerEvents.some(p=>p.eventType==="revenue_collected"&&p.details.paymentReceiptKey))),sourcePointer:a.sourceReference}));
      const events=buildCanonicalEvents([...prepared,...assertionSources],attribution);
      const missingTranscripts=calls.filter(c=>c.startedAt>=since&&!transcripts.some(t=>t.callId===c.id&&usableTranscriptText(t.text))&&((c.raw.attachments instanceof Array && c.raw.attachments.length>0)||c.recordingUrl||c.status==="completed")).map(c=>c.id);
      const groups=new Map<string,number>();for(const a of appointments.filter(a=>["new","confirmed"].includes(a.status))){const key=`${a.calendarId}:${a.appointmentStartAt.toISOString()}`;groups.set(key,(groups.get(key)??0)+1);}
      const snapshot=projectCustomer({contactId:contact.id,leadId:lead.id,customerName:contact.name,leadCreatedAt:lead.createdAt.toISOString(),events,assertions,exclusionReasons:exclusionReasons({tags:contact.tags,raw:contact.raw,source:contact.source,doNotContact:lead.doNotContact}),providerAppointmentCount:Math.max(0,...groups.values()),missingJobLink:appointments.some(a=>["new","confirmed"].includes(a.status)&&!jobs.some(j=>j.appointmentId===a.id)),missingTranscriptIds:missingTranscripts});
      const priorCoverage=await db.select({coverage:schema.customerStateSnapshots.coverage}).from(schema.customerStateSnapshots).where(eq(schema.customerStateSnapshots.contactId,contact.id));
      const portalCoverage=options.portalCoverage??asRecord(priorCoverage[0]?.coverage.portal);
      let providerNoteCoverage:Json={complete:false,error:"provider_notes_not_synced"};try{if(notesCursor[0]?.cursor)providerNoteCoverage=asRecord(JSON.parse(notesCursor[0].cursor));}catch{providerNoteCoverage={complete:false,error:"provider_notes_cursor_invalid"};}
      const coverage:Json={messages:{inspected:messages.length},calls:{inspected:calls.length,transcriptsInspected:transcripts.length,missingTranscriptIds:missingTranscripts},appointments:{inspected:appointments.length},opportunities:{inspected:opportunities.length},jobs:{inspected:jobs.length},notes:{inspected:notes.length},providerNotes:{...providerNoteCoverage,inspected:providerNotes.length},walkthroughs:{inspected:walkthroughs.length},userConfirmed:{inspected:assertions.length},portal:portalCoverage,
        extraction:{version:EXTRACTOR_VERSION,complete:prepared.every(r=>r.extractionStatus==="complete")&&missingTranscripts.length===0,errors:extractionErrors,partialSourceIds:prepared.filter(r=>r.extractionStatus!=="complete").map(r=>r.sourceRecordId)},asOf:startedAt.toISOString()};
      let refreshAfterRace=false;
      await db.transaction(async tx=>{
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`customer-state:${contact.id}`}))`);
        const [newer]=await tx.select().from(schema.customerStateSnapshots).where(and(eq(schema.customerStateSnapshots.contactId,contact.id),gte(schema.customerStateSnapshots.lastReconciledAt,startedAt))).limit(1);
        if(newer){
          // A report's fast deterministic refresh may finish while the worker is
          // interpreting a call. Preserve stronger extraction for unchanged
          // sources, then rebuild from fresh rows instead of discarding the AI
          // work or overwriting a newer contact/provider/assertion snapshot.
          if(options.useAI!==false)for(const record of prepared.filter(r=>r.extractionStatus==="complete")){
            const changed=await tx.update(schema.customerEvidence).set({extractedEvents:(record.events??[]) as unknown as Json[],status:"complete",error:null,updatedAt:new Date()}).where(and(eq(schema.customerEvidence.id,sourceId(record)),eq(schema.customerEvidence.sourceHash,hashes.get(sourceId(record))??""),sql`${schema.customerEvidence.status}<>'complete'`)).returning({id:schema.customerEvidence.id});
            if(changed.length)refreshAfterRace=true;
          }
          return;
        }
        for(const record of prepared){const value={id:sourceId(record),contactId:contact.id,leadId:lead.id,sourceType:record.sourceType,sourceRecordId:record.sourceRecordId,sourceHash:hashes.get(sourceId(record))??hash(JSON.stringify(record.events)),extractorVersion:EXTRACTOR_VERSION,occurredAt:new Date(record.occurredAt),status:record.extractionStatus??"complete",extractedEvents:(record.events??[]) as unknown as Json[],sourcePointer:record.sourcePointer??null,error:record.extractionStatus==="partial"?extractionErrors.join(",")||"semantic_coverage_partial":null,updatedAt:startedAt};
          await tx.insert(schema.customerEvidence).values(value).onConflictDoUpdate({target:schema.customerEvidence.id,set:{...value,attemptCount:sql`${schema.customerEvidence.attemptCount}+1`}});
        }
        for(const oldId of retiredPortalIds)await tx.update(schema.customerEvidence).set({extractedEvents:[],status:"complete",sourceHash:hash("retired_by_complete_portal_snapshot"),updatedAt:startedAt}).where(eq(schema.customerEvidence.id,oldId));
        // Retire unsupported projections, retaining the durable old evidence row
        // and conversion identity for audit. Corrected data never creates a replay.
        await tx.update(schema.customerEvents).set({active:false,updatedAt:startedAt}).where(eq(schema.customerEvents.contactId,contact.id));
        for(const e of events){const value={...e,occurredAt:new Date(e.occurredAt),confidence:e.confidence.toFixed(3),evidence:e.evidence as unknown as Json[],active:true,updatedAt:startedAt};const {syncState,...mutable}=value;
          await tx.insert(schema.customerEvents).values(value).onConflictDoUpdate({target:schema.customerEvents.eventId,set:mutable});}
        for(const a of assertions)if(a.status==="reconciled")await tx.update(schema.customerOperationalAssertions).set({status:"reconciled",reconciledAt:new Date(a.reconciledAt!),updatedAt:startedAt}).where(eq(schema.customerOperationalAssertions.id,a.id));
        const row={contactId:contact.id,leadId:lead.id,state:snapshot.state,intentStage:snapshot.intentStage,pipeline:snapshot.pipeline,reconciliationStatus:snapshot.reconciliationStatus,snapshot:snapshot as unknown as Json,coverage,lastReconciledAt:startedAt,updatedAt:startedAt};
        await tx.insert(schema.customerStateSnapshots).values(row).onConflictDoUpdate({target:schema.customerStateSnapshots.contactId,set:row});
      });
      if(refreshAfterRace){const refreshed=await reconcileCustomerState({contactIds:[contact.id],useAI:false});results.push(...refreshed.results);continue;}
      results.push({contactId:contact.id,state:snapshot.state,events:events.length,coverage});
    } catch(error) {results.push({contactId:contact.id,error:error instanceof Error&&/invalid_|required|not_found/.test(error.message)?error.message:"customer_reconciliation_failed"});}
  }
  const summary={startedAt:startedAt.toISOString(),finishedAt:new Date().toISOString(),inspected:customers.length,truncated,failed:results.filter(r=>r.error).length,partialCustomers:results.filter(r=>!r.error&&asRecord(r.coverage?.extraction).complete!==true).length,results};
  const cursor=JSON.stringify({since:since.toISOString(),until:until.toISOString(),inspected:customers.length,truncated,failed:summary.failed,partialCustomers:summary.partialCustomers,lastAttempt:summary.startedAt,lastSuccess:summary.failed||truncated||summary.partialCustomers?null:summary.finishedAt,successScope:"semantic_extraction_only_see_customer_source_coverage"});
  await db.insert(schema.syncCursors).values({key:"customer_state_reconciliation",cursor,updatedAt:new Date()}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor,updatedAt:new Date()}});
  return summary;
}

export interface UserConfirmedOutcomeInput {
  contactId:string;field:string;value:unknown;exactText:string;sourceReference:string;actorId:string;
  occurredAt?:Date|string;assertedAt?:Date|string;valueCents?:number;currency?:string;idempotencyKey?:string;
}
export async function recordUserConfirmedOutcome(input:UserConfirmedOutcomeInput) {
  const validated=validateUserConfirmedOutcome(input);
  const db=getDb(),assertedAt=new Date(input.assertedAt??Date.now()),occurredAt=new Date(input.occurredAt??assertedAt);
  if(!input.exactText.trim()||!input.sourceReference.trim()||!input.actorId.trim()||!input.field.trim())throw new Error("user_confirmation_source_required");
  if(!Number.isFinite(assertedAt.valueOf())||!Number.isFinite(occurredAt.valueOf()))throw new Error("invalid_confirmation_timestamp");
  if(input.valueCents!==undefined&&(!Number.isSafeInteger(input.valueCents)||input.valueCents<0))throw new Error("invalid_verified_value");
  const [contact]=await db.select({id:schema.contacts.id}).from(schema.contacts).where(eq(schema.contacts.id,input.contactId)).limit(1);if(!contact)throw new Error("contact_not_found");
  const id=`egca_${hash(`${input.contactId}:${input.idempotencyKey??`${input.sourceReference}:${input.field}:${JSON.stringify(input.value)}`}`)}`;
  const row={id,contactId:input.contactId,...validated,source:"user_confirmed",exactText:input.exactText,sourceReference:input.sourceReference,actorId:input.actorId,assertedAt,occurredAt,occurredAtVerified:input.occurredAt!==undefined};
  if(!assertionEvents({...row,assertedAt:assertedAt.toISOString(),occurredAt:occurredAt.toISOString(),status:"pending_reconciliation"}).length)throw new Error("unsupported_asserted_field_or_value");
  await db.transaction(async tx=>{
    const [existing]=await tx.select().from(schema.customerOperationalAssertions).where(eq(schema.customerOperationalAssertions.id,id)).limit(1);
    if(existing){if(existing.field!==row.field||JSON.stringify(existing.value)!==JSON.stringify(row.value)||existing.contactId!==row.contactId)throw new Error("confirmation_idempotency_conflict");return;}
    await tx.update(schema.customerOperationalAssertions).set({status:"superseded",updatedAt:new Date()}).where(and(eq(schema.customerOperationalAssertions.contactId,input.contactId),eq(schema.customerOperationalAssertions.field,input.field),sql`${schema.customerOperationalAssertions.status}<>'superseded'`));
    await tx.insert(schema.customerOperationalAssertions).values(row);
  });
  const reconciliation=await reconcileCustomerState({contactIds:[input.contactId],useAI:false});
  return {assertionId:id,source:"user_confirmed",providerDataOverwritten:false,occurredAtVerified:input.occurredAt!==undefined,reconciliation};
}

export async function getCustomerTimeline(input:{contactId:string;refresh?:boolean}) {
  if(input.refresh)await reconcileCustomerState({contactIds:[input.contactId],useAI:false});
  const db=getDb();const [snapshot,events,assertions,evidence]=await Promise.all([
    db.select().from(schema.customerStateSnapshots).where(eq(schema.customerStateSnapshots.contactId,input.contactId)),
    db.select().from(schema.customerEvents).where(and(eq(schema.customerEvents.contactId,input.contactId),eq(schema.customerEvents.active,true))).orderBy(asc(schema.customerEvents.occurredAt)),
    db.select().from(schema.customerOperationalAssertions).where(eq(schema.customerOperationalAssertions.contactId,input.contactId)).orderBy(asc(schema.customerOperationalAssertions.assertedAt)),
    db.select().from(schema.customerEvidence).where(eq(schema.customerEvidence.contactId,input.contactId)).orderBy(asc(schema.customerEvidence.occurredAt))]);
  return {contactId:input.contactId,customer:snapshot[0]?.snapshot??null,coverage:snapshot[0]?.coverage??{complete:false,error:"customer_not_reconciled"},lastReconciledAt:snapshot[0]?.lastReconciledAt??null,events:events.map(toEvent),assertions:assertions.map(toAssertion),extraction:evidence.map(e=>({sourceType:e.sourceType,sourceRecordId:e.sourceRecordId,status:e.status,error:e.error,occurredAt:e.occurredAt,sourcePointer:e.sourcePointer}))};
}
export const getCanonicalCustomer=getCustomerTimeline;

export async function getCanonicalReport(input:{since:Date|string;until:Date|string;cohortSince?:Date|string;cohortUntil?:Date|string;refresh?:boolean}) {
  const since=validDate(input.since),until=validDate(input.until);if(!since||!until)throw new Error("invalid_report_window");
  if(input.refresh)await reconcileCustomerState({since,until,useAI:false});
  const db=getDb();const [snapshots,events,leads,meta,cursors]=await Promise.all([
    db.select().from(schema.customerStateSnapshots),db.select().from(schema.customerEvents).where(eq(schema.customerEvents.active,true)),
    db.select({id:schema.leads.id,contactId:schema.leads.contactId,createdAt:schema.leads.createdAt,doNotContact:schema.leads.doNotContact,source:schema.contacts.source,tags:schema.contacts.tags,raw:schema.contacts.raw}).from(schema.leads).innerJoin(schema.contacts,eq(schema.contacts.id,schema.leads.contactId)).where(or(and(gte(schema.leads.createdAt,new Date(input.cohortSince??since)),lt(schema.leads.createdAt,new Date(input.cohortUntil??until))),and(gte(schema.leads.createdAt,new Date(since)),lt(schema.leads.createdAt,new Date(until))))),
    db.select({status:schema.metaConversionEvents.status,count:sql<number>`count(*)::int`}).from(schema.metaConversionEvents).groupBy(schema.metaConversionEvents.status),db.select().from(schema.syncCursors).where(sql`${schema.syncCursors.key} like '%conversion%' or ${schema.syncCursors.key}='customer_state_reconciliation' or ${schema.syncCursors.key}='customer_state:booking_reconciliation' or ${schema.syncCursors.key} like 'customer_state:last_%'`)]);
  const leadRoster=leads.map(l=>({contactId:l.contactId,leadCreatedAt:l.createdAt.toISOString(),excluded:exclusionReasons({tags:l.tags,raw:l.raw,source:l.source,doNotContact:l.doNotContact}).includes("test_internal_or_vendor")}));
  const report=buildReport({events:events.map(toEvent),customers:snapshots.map(s=>s.snapshot as unknown as CustomerProjection),leadRoster,since,until,...(input.cohortSince?{cohortSince:validDate(input.cohortSince)!}:{}),...(input.cohortUntil?{cohortUntil:validDate(input.cohortUntil)!}:{})});
  const missing=leads.filter(l=>!snapshots.some(s=>s.contactId===l.contactId));
  return {...report,coverage:{complete:!missing.length&&snapshots.every(s=>asRecord(s.coverage.extraction).complete===true&&asRecord(s.coverage.portal).complete===true&&asRecord(s.coverage.providerNotes).complete===true),missingCustomers:missing.map(l=>({id:l.id,contactId:l.contactId})),customers:snapshots.map(s=>({contactId:s.contactId,lastReconciledAt:s.lastReconciledAt,coverage:s.coverage})),source:"provider_mirrors_plus_persisted_portal_evidence"},metaConversions:meta,cursors};
}

export async function getCustomerStateDiagnostics() {
  const db=getDb();const [snapshots,failedSources,meta,lastAccepted,cursors]=await Promise.all([
    db.select().from(schema.customerStateSnapshots),db.select().from(schema.customerEvidence).where(sql`${schema.customerEvidence.status}<>'complete'`),
    db.select({status:schema.metaConversionEvents.status,count:sql<number>`count(*)::int`}).from(schema.metaConversionEvents).groupBy(schema.metaConversionEvents.status),
    db.select({at:schema.metaConversionEvents.acceptedAt}).from(schema.metaConversionEvents).where(eq(schema.metaConversionEvents.status,"accepted")).orderBy(desc(schema.metaConversionEvents.acceptedAt)).limit(1),
    db.select().from(schema.syncCursors).where(sql`${schema.syncCursors.key} like '%conversion%' or ${schema.syncCursors.key}='customer_state_reconciliation' or ${schema.syncCursors.key}='customer_state:booking_reconciliation' or ${schema.syncCursors.key} like 'customer_state:last_%'`)]);
  const customers=snapshots.map(s=>s.snapshot as unknown as CustomerProjection),withCode=(code:string)=>customers.filter(c=>c.discrepancies.some(d=>d.code===code));
  return {generatedAt:new Date().toISOString(),unresolvedDiscrepancies:customers.filter(c=>c.discrepancies.length),verballyBookedProviderMissing:withCode("verbally_booked_provider_missing"),providerMissingJobLink:withCode("provider_missing_job_link"),duplicateAppointmentsSuspected:withCode("duplicate_appointment_suspected"),transcriptFailures:failedSources.filter(e=>e.sourceType==="call_transcript"||e.sourceType==="call").map(e=>({contactId:e.contactId,sourceRecordId:e.sourceRecordId,status:e.status,error:e.error})),missingTranscripts:withCode("transcript_unavailable"),pendingVideoQuotes:customers.filter(c=>c.pipeline==="video_quote"&&c.pipelineDisposition==="active"),closedWithoutPaymentEvidence:withCode("closed_without_payment_evidence"),userConfirmedAwaitingReconciliation:withCode("user_confirmed_awaiting_backend"),meta:{counts:meta,lastSuccessfulSync:lastAccepted[0]?.at??null,cursors},coverage:snapshots.map(s=>({contactId:s.contactId,lastReconciledAt:s.lastReconciledAt,coverage:s.coverage}))};
}
