import {asRecord,buildReport,REPORT_METRICS} from './core.js';
import type {CanonicalEvent,CustomerProjection,EvidenceRef} from './types.js';

const sourceRef=({sourceType,sourceRecordId}:EvidenceRef)=>({sourceType,sourceRecordId});
const quote=(ref:EvidenceRef)=>({...ref,excerpt:ref.excerpt.slice(0,400),...(ref.excerpt.length>400?{excerptTruncated:true}:{})});
const eventSummary=(event:CanonicalEvent)=>{
  return {eventId:event.eventId,contactId:event.contactId,...(event.occurrenceId?{occurrenceId:event.occurrenceId,occurrenceIdentityStatus:event.details.occurrenceIdentityStatus}:{}),eventType:event.eventType,occurredAt:event.occurredAt,occurredAtVerified:event.details.occurredAtVerified!==false,confidence:event.confidence,humanReviewNeeded:event.humanReviewNeeded,nextAction:event.nextAction,
    ...(event.valueCents!==null||['job_sold','revenue_collected'].includes(event.eventType)?{valueCents:event.valueCents,currency:event.currency,valueVerified:event.valueVerified}:{}),
    ...(event.details.reason?{reason:event.details.reason}:{}),...(event.details.scheduledAt?{scheduledAt:event.details.scheduledAt}:{}),...(event.details.timeMention?{timeMention:event.details.timeMention}:{}),
    evidence:event.evidence.slice(0,1).map(quote),evidenceSourceCount:event.evidence.length,evidenceSources:event.evidence.map(sourceRef)};
};
const customerSummary=(customer:CustomerProjection)=>{
  const {eventIds,supportingEvidence}=customer;
  return {contactId:customer.contactId,customerName:customer.customerName,leadCreatedAt:customer.leadCreatedAt,state:customer.state,intentStage:customer.intentStage,pipeline:customer.pipeline,videoQuoteStage:customer.videoQuoteStage,pipelineDisposition:customer.pipelineDisposition,reconciliationStatus:customer.reconciliationStatus,nextRequiredAction:customer.nextRequiredAction,humanReviewNeeded:customer.humanReviewNeeded,discrepancies:customer.discrepancies,
    supportingEvidence:supportingEvidence.slice(-1).map(quote),supportingEvidenceSourceCount:supportingEvidence.length,supportingEvidenceSources:supportingEvidence.map(sourceRef),timelineEventCount:eventIds.length,
    ...(customer.followUpCommitment?{followUpCommitment:{occurredAt:customer.followUpCommitment.occurredAt,deadline:customer.followUpCommitment.deadline,action:customer.followUpCommitment.action}}:{}),...(customer.activeWork?{activeWork:customer.activeWork}:{}),
    evidenceRetrieval:{tool:'egc.customer_timeline',contactId:customer.contactId}};
};

/** MCP presentation only. It preserves business counts and coverage, and points to
 * bounded read tools for the unchanged event/source identities. Full service/UI
 * reports retain their complete ID indexes and the ledger retains full sources. */
export function formatOperationalBriefing<T extends ReturnType<typeof buildReport>>(report:T) {
  const extra=report as T&{coverage?:unknown;countedEventsPage?:unknown};
  const coverage=asRecord(extra.coverage),page=asRecord(extra.countedEventsPage),offset=typeof page.offset==='number'?page.offset:0;
  const total=typeof page.total==='number'?page.total:report.countedEvents.length,limit=typeof page.limit==='number'?Math.min(40,page.limit):40,shown=report.countedEvents.slice(0,limit);
  const periodActivity=Object.fromEntries(Object.entries(report.periodActivity).map(([key,{eventIds,...metric}])=>[key,{...metric,evidenceEventCount:eventIds.length,eventTypes:REPORT_METRICS[key]??[]}])) as Record<string,{count:number;unit:string;contactIds:string[];evidenceEventCount:number;eventTypes:string[]}>;
  const customers=report.customers.map(customerSummary);
  const pipeline=(name:keyof typeof report.pipelines)=>report.pipelines[name].map(c=>({contactId:c.contactId,customerName:c.customerName,state:c.state,intentStage:c.intentStage,nextRequiredAction:c.nextRequiredAction}));
  const sourceCoverage=Array.isArray(coverage.customers)?coverage.customers.map(c=>{const row=asRecord(c),sources=asRecord(row.coverage);return {contactId:row.contactId,lastReconciledAt:row.lastReconciledAt,semanticComplete:asRecord(sources.extraction).complete===true,portalComplete:asRecord(sources.portal).complete===true,providerNotesComplete:asRecord(sources.providerNotes).complete===true};}):[];
  return {...report,presentation:'compact_operational_briefing',periodActivity,customers,
    pipelines:{walkthrough:pipeline('walkthrough'),videoQuote:pipeline('videoQuote'),directJob:pipeline('directJob')},
    countedEvents:shown.map(eventSummary),countedEventsPage:{...page,offset,limit,total,nextOffset:offset+shown.length<total?offset+shown.length:null},
    confirmedOutcomesWithUnknownTime:report.confirmedOutcomesWithUnknownTime.map(eventSummary),reviewRequiredEvents:report.reviewRequiredEvents.map(eventSummary),
    ...(extra.coverage?{coverage:{scope:coverage.scope,complete:coverage.complete,missingCustomers:coverage.missingCustomers,source:coverage.source,customers:sourceCoverage,historicalInventory:coverage.historicalInventory,diagnosticsTool:'egc.customer_state_diagnostics'}}:{}),
    evidenceRetrieval:{tool:'egc.operational_event_evidence',since:report.period.since,until:report.period.until,nextOffset:offset+shown.length<total?offset+shown.length:null,limit,identityPolicy:'Original event and source IDs are returned unchanged by evidence pages and customer timelines.'}};
}
