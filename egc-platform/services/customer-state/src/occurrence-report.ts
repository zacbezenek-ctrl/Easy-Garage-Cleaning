import {projectCustomer,hasRecommitmentAfter,latestLifecycleEvidenceTime} from './core.js';
import {eventOccurrenceKind,readOccurrenceIdentity} from './occurrences.js';
import type {CanonicalEvent,CustomerProjection,CustomerEventType} from './types.js';

/** Unassigned claims never add a fabricated job on top of known work. The
 * unresolved claims stay in the timeline and receive their own coverage count. */
export function occurrenceMetricRows(rows:CanonicalEvent[]) {
  const known=new Set(rows.filter(e=>e.occurrenceId&&e.details.occurrenceIdentityStatus==='resolved').map(e=>`${e.contactId}:${eventOccurrenceKind(e.eventType)}`));
  return rows.filter(e=>e.details.occurrenceIdentityStatus!=='unassigned'||!known.has(`${e.contactId}:${eventOccurrenceKind(e.eventType)}`));
}
export function occurrenceMetric(rows:CanonicalEvent[],types:CustomerEventType[]) {
  const kind=types.map(eventOccurrenceKind).find(Boolean),hasOccurrences=rows.some(e=>e.occurrenceId);
  if(!kind||!hasOccurrences)return null;
  const selected=occurrenceMetricRows(rows),receipt=types.includes('revenue_collected');
  return {count:new Set(selected.map(e=>receipt?String(e.details.paymentReceiptKey??e.occurrenceId??e.contactId):e.occurrenceId??e.contactId)).size,unit:receipt?'verified_receipt_or_unallocated_collection':`distinct_${kind}_occurrences`,distinctCustomerCount:new Set(rows.map(e=>e.contactId)).size,occurrenceIds:[...new Set(selected.map(e=>e.occurrenceId).filter((id):id is string=>Boolean(id)))],unassignedCommitmentCount:new Set(rows.filter(e=>e.details.occurrenceIdentityStatus==='unassigned').map(e=>e.occurrenceId)).size};
}
/** A receipt can be a deposit. Keep collection in the ledger while work that
 * is still accepted/scheduled uses its service lifecycle, not the cash rank. */
const workStateEvents=(events:CanonicalEvent[])=>events.some(e=>['job_sold','job_verbally_accepted','job_scheduled'].includes(e.eventType))&&!events.some(e=>e.eventType==='job_completed')?events.filter(e=>e.eventType!=='revenue_collected'):events;
export function applyOccurrenceProjection(customer:CustomerProjection,events:CanonicalEvent[]):CustomerProjection {
  const groups=new Map<string,CanonicalEvent[]>();
  for(const e of events)if(e.contactId===customer.contactId&&e.occurrenceId)groups.set(e.occurrenceId,[...(groups.get(e.occurrenceId)??[]),e]);
  const allTrusted=events.filter(e=>e.contactId===customer.contactId&&!e.humanReviewNeeded&&e.confidence>=.85);
  const unscopedClosure=allTrusted.filter(e=>(!e.occurrenceId||e.details.occurrenceIdentityStatus==='unassigned')&&['appointment_cancelled','no_show','lost','walkthrough_negative_outcome'].includes(e.eventType)).map(e=>latestLifecycleEvidenceTime(e)!).sort().at(-1);
  const conversions=allTrusted.filter(e=>['job_sold','job_completed','revenue_collected'].includes(e.eventType));
  const cutoff=conversions.map(e=>typeof e.details.assertedAt==='string'?e.details.assertedAt:e.occurredAt).sort().at(-1);
  const ownerTerminal=allTrusted.filter(e=>(!e.occurrenceId||e.details.occurrenceIdentityStatus==='unassigned')&&['job_completed','revenue_collected'].includes(e.eventType)&&e.evidence.some(ref=>ref.sourceType==='user_confirmed')).map(e=>typeof e.details.assertedAt==='string'?e.details.assertedAt:e.occurredAt).sort().at(-1);
  const convertedParents=new Set<string>();
  for(const e of conversions){const identity=readOccurrenceIdentity(e);for(const parent of identity?.parents??[])convertedParents.add(`${parent.alias.kind}:${parent.alias.namespace}:${parent.alias.recordId}`);}
  const activeWork:NonNullable<CustomerProjection['activeWork']>=[];
  for(const [occurrenceId,work] of groups){const trusted=work.filter(e=>!e.humanReviewNeeded&&e.confidence>=.85);if(!trusted.length)continue;
    const kind=String(trusted[0]!.details.occurrenceKind??'unknown'),identityStatus=String(trusted[0]!.details.occurrenceIdentityStatus??'unassigned');
    if(identityStatus==='unassigned'&&[...groups.values()].some(other=>other.some(e=>e.details.occurrenceKind===kind&&e.details.occurrenceIdentityStatus==='resolved')))continue;
    const complete=trusted.some(e=>kind==='job'?e.eventType==='job_completed'||(e.eventType==='revenue_collected'&&!trusted.some(row=>['job_sold','job_verbally_accepted','job_scheduled'].includes(row.eventType))):kind==='walkthrough'?['walkthrough_completed','walkthrough_showed','walkthrough_negative_outcome'].includes(e.eventType):false);
    if(complete)continue;
    const identity=trusted.map(readOccurrenceIdentity).find(Boolean);
    if(identity?.aliases.some(a=>convertedParents.has(`${a.kind}:${a.namespace}:${a.recordId}`)))continue;
    const freshCommitment=(after:string)=>identityStatus==='resolved'&&hasRecommitmentAfter(trusted,after);
    // An unallocated cancellation closes stale work without guessing an alias.
    // A separately resolved, subsequently accepted job can still reopen work.
    if(unscopedClosure&&!freshCommitment(unscopedClosure))continue;
    const noShow=trusted.filter(e=>e.eventType==='no_show').map(e=>latestLifecycleEvidenceTime(e)!).sort().at(-1);
    if(noShow&&!freshCommitment(noShow))continue;
    // A sold/paid customer's original estimate flow is finished even when its
    // old provider mirror never advanced. Only explicit independent new work
    // can reopen it; a future scheduled date is not a new commitment timestamp.
    if(kind!=='job'&&cutoff&&!freshCommitment(cutoff))continue;
    // Unallocated owner-confirmed completion/payment must not be reversed by a
    // stale open local/Portal row. An exact subsequent accepted job can proceed.
    if(kind==='job'&&ownerTerminal&&!freshCommitment(ownerTerminal))continue;
    const projection=projectCustomer({contactId:customer.contactId,leadId:customer.leadId,customerName:customer.customerName,leadCreatedAt:customer.leadCreatedAt,events:workStateEvents(trusted)});
    if(['lost','do_not_contact','negative_outcome','cancelled'].includes(projection.pipelineDisposition))continue;
    activeWork.push({occurrenceId,kind,state:projection.state,pipeline:kind==='job'?'direct_job':kind==='walkthrough'?'walkthrough':'video_quote',nextRequiredAction:projection.nextRequiredAction,eventIds:trusted.map(e=>e.eventId),identityStatus});
  }
  // Respect contact-wide DNC/loss; independent work is shown, not silently revived.
  if(activeWork.length&&customer.pipelineDisposition!=='do_not_contact'&&customer.pipelineDisposition!=='lost'&&customer.pipelineDisposition!=='negative_outcome'){
    const focus=activeWork.find(w=>w.kind==='job')??activeWork[0]!;
    const focusEvents=groups.get(focus.occurrenceId)??[];
    const focusProjection=projectCustomer({contactId:customer.contactId,leadId:customer.leadId,customerName:customer.customerName,leadCreatedAt:customer.leadCreatedAt,events:workStateEvents(focusEvents)});
    return {...customer,activeWork,state:focus.state,intentStage:focusProjection.intentStage,supportingEvidence:focusProjection.supportingEvidence,pipeline:focus.pipeline as CustomerProjection['pipeline'],pipelineDisposition:'active',nextRequiredAction:activeWork.length>1?`${activeWork.length} active work items. ${focus.nextRequiredAction}`:focus.nextRequiredAction};
  }
  return {...customer,activeWork};
}
