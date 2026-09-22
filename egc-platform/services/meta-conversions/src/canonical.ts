import { buildCandidate, classifyAttribution, reliableRevenueCents, type ConversionCandidate, type ConversionLead, type ConversionStage, type DetectionOptions } from './core.js';

export const CANONICAL_META_STAGES: Record<string, ConversionStage> = {
  lead_created: 'Lead', qualified: 'QualifiedLead', price_expectation_accepted: 'QualifiedLead',
  walkthrough_verbally_booked: 'WALKTHROUGH_BOOKED', walkthrough_booked: 'WALKTHROUGH_BOOKED',
  walkthrough_showed: 'WALKTHROUGH_SHOWED', walkthrough_completed: 'WALKTHROUGH_COMPLETED',
  quote_delivered: 'QUOTE_DELIVERED', job_verbally_accepted: 'JOB_WON', job_sold: 'JOB_WON',
  job_completed: 'JOB_COMPLETED', revenue_collected: 'REVENUE_COLLECTED'
};

/** Only interchangeable aliases for one acquisition milestone. Individual cash
 * receipts deliberately never share a canonical delivery status. */
export function canonicalStageAliases(stage:string):string[] {
  const aliases=Object.entries(CANONICAL_META_STAGES).filter(([,mapped])=>mapped===stage).map(([type])=>type);
  return aliases.length>1?aliases:[];
}

export interface CanonicalConversionEvidence {
  eventId: string; contactId: string; leadId: string | null; eventType: string;
  occurredAt: Date | string; active: boolean; humanReviewNeeded: boolean; confidence: string | number;
  evidence: Record<string, unknown>[]; details: Record<string, unknown>;
  occurrenceId?: string | null;
  appointmentId?: string | null; opportunityId?: string | null; jobId?: string | null;
  valueCents?: number | null; currency?: string | null; valueVerified: boolean;
}

export interface CanonicalSourceState {
  contactId: string; sourceType: string; sourceRecordId: string; status: string;
}
export interface CanonicalCustomerGate {
  state?: string; excluded?: boolean; exclusionReasons?: readonly string[];
}
export function canonicalExclusionReasons(customer: CanonicalCustomerGate): string[] {
  const reasons = customer.exclusionReasons ?? [];
  return [
    ...(customer.state === 'DO_NOT_CONTACT' || reasons.includes('do_not_contact') ? ['canonical_do_not_contact'] : []),
    ...(customer.excluded || reasons.includes('test_internal_or_vendor') ? ['canonical_customer_excluded'] : [])
  ];
}

/** A provider mirror without canonical reconciliation is useful diagnostic data,
 * never an alternate production sender. Remove its payload at this boundary. */
export function holdForCanonicalState(candidate: ConversionCandidate): ConversionCandidate {
  const {payload: _payload, ...safe} = candidate;
  return {...safe, eligible:false, eligibility:'manual_review', reasons:[...new Set([...safe.reasons,'missing_canonical_state'])]};
}

const structuredSources = new Set(['lead','appointment','opportunity','job','portal_visit','portal_job','portal_payment','walkthrough','user_confirmed']);
const sourceKey = (contactId:string,type:string,id:string)=>`${contactId}:${type}:${id}`;
function sourceProof(event:CanonicalConversionEvidence, sourceStates:readonly CanonicalSourceState[]) {
  const statuses = new Map(sourceStates.map(s=>[sourceKey(s.contactId,s.sourceType,s.sourceRecordId),s.status]));
  const evidenceAtSelectedTime = event.evidence.filter(ref=>{
    const confidence=Number(ref.confidence ?? event.confidence);
    return ref.humanReviewNeeded!==true && Number.isFinite(confidence) && confidence>=.85
      && (typeof ref.occurredAt!=='string' || new Date(ref.occurredAt).valueOf()===new Date(event.occurredAt).valueOf());
  });
  const trusted = evidenceAtSelectedTime.filter(ref=>{
    const type=String(ref.sourceType??''), id=String(ref.sourceRecordId??'');
    if(!id)return false;
    // Structured facts are vetted by their source adapters. User confirmations
    // separately require a verified occurrence time before buildCandidate sends.
    return structuredSources.has(type) || statuses.get(sourceKey(event.contactId,type,id))==='complete';
  });
  return trusted.length>0;
}

/** The existing first-stage Meta identities survive provider reconciliation and
 * mirrored Hub/call evidence. One business milestone never becomes a second send. */
export function detectCanonicalConversions(lead: ConversionLead, events: readonly CanonicalConversionEvidence[], options: DetectionOptions & { enabledStages?: readonly string[]; sourceStates?: readonly CanonicalSourceState[]; customerState?: CanonicalCustomerGate }): ConversionCandidate[] {
  const attribution = classifyAttribution(lead);
  const stages = new Map<ConversionStage, CanonicalConversionEvidence[]>();
  for (const event of events) {
    const stage = CANONICAL_META_STAGES[event.eventType];
    if (!stage || !event.active || event.contactId !== lead.contactId || event.leadId !== lead.leadId) continue;
    if (options.enabledStages && !options.enabledStages.includes(stage)) continue;
    stages.set(stage, [...(stages.get(stage) ?? []), event]);
  }
  return [...stages].map(([stage, rows]) => {
    // Prefer verified evidence for the same milestone; never use a newer send
    // timestamp to make an old conversion eligible.
    const verified=(row:CanonicalConversionEvidence)=>!row.humanReviewNeeded&&Number(row.confidence)>=.85&&row.details.occurredAtVerified!==false&&row.details.timestampQuality!=='asserted_at_only'&&row.details.occurrenceTimeUnknown!==true&&sourceProof(row,options.sourceStates??[]);
    const verifiedMoney=(row:CanonicalConversionEvidence)=>['JOB_WON','REVENUE_COLLECTED'].includes(stage)&&row.valueVerified&&row.currency==='USD'&&reliableRevenueCents(row.valueCents)!==null;
    rows.sort((a,b) => Number(verified(b))-Number(verified(a)) || Number(a.humanReviewNeeded)-Number(b.humanReviewNeeded) || new Date(a.occurredAt).valueOf()-new Date(b.occurredAt).valueOf() || Number(verifiedMoney(b))-Number(verifiedMoney(a)) || a.eventId.localeCompare(b.eventId));
    const event = rows[0]!;
    const reasons: string[] = canonicalExclusionReasons(options.customerState ?? {});
    if (event.humanReviewNeeded || Number(event.confidence) < 0.85) reasons.push('canonical_evidence_needs_review');
    if (!event.evidence.length) reasons.push('canonical_evidence_reference_missing');
    else if(!sourceProof(event,options.sourceStates??[]))reasons.push('canonical_source_extraction_incomplete');
    const timeVerified = event.details.occurredAtVerified !== false && event.details.timestampQuality !== 'asserted_at_only' && event.details.occurrenceTimeUnknown !== true;
    const time = timeVerified ? new Date(event.occurredAt) : null;
    const revenue = ['JOB_WON','REVENUE_COLLECTED'].includes(stage) && event.valueVerified && event.currency === 'USD' ? reliableRevenueCents(event.valueCents) : null;
    const candidate = buildCandidate(lead, attribution, {
      stage, time: time && Number.isFinite(time.valueOf()) ? time : null, reasons,
      ...(event.appointmentId ? {appointmentId:event.appointmentId}:{}),
      ...(event.opportunityId ? {opportunityId:event.opportunityId}:{}),
      ...(event.jobId ? {jobId:event.jobId}:{}),
      ...(revenue === null ? {} : {valueCents:revenue})
    }, options);
    return {...candidate, canonicalEventId:event.eventId};
  });
}
