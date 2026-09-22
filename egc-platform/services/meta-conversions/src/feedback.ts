import { createHash } from 'node:crypto';
import { detectCanonicalConversions, type CanonicalConversionEvidence } from './canonical.js';
import { reliableRevenueCents, type ConversionCandidate, type ConversionLead } from './core.js';

/** One qualification per acquisition; only explicit customer/business milestones
 * imply fit. A call record, voicemail, generic quote or outbound follow-up does not. */
export const QUALIFICATION_MILESTONES = new Set([
  'qualified', 'price_expectation_accepted', 'walkthrough_verbally_booked',
  'walkthrough_booked', 'walkthrough_showed', 'walkthrough_completed',
  'video_quote_customer_agreed', 'job_verbally_accepted', 'job_sold'
]);
export interface FeedbackOccurrence {
  id: string; contactId: string; leadId: string | null; kind: string;
  status: string; mergedIntoId: string | null;
}
export interface FeedbackAlias {
  contactId: string; occurrenceId: string; kind: string; namespace: string; recordId: string;
}
type Options = Parameters<typeof detectCanonicalConversions>[2] & {
  qualifiedSalesFeedback?: boolean;
  occurrences?: readonly FeedbackOccurrence[];
  occurrenceAliases?: readonly FeedbackAlias[];
};
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const identity = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(v) ? v : null;

/** Resolve only already persisted exact work identities, including the shadow
 * occurrence ledger. This never changes reporting mode, joins by price/address,
 * guesses which job a transcript belongs to, or mints a second order on retry. */
export function purchaseOccurrence(event: CanonicalConversionEvidence, lead: ConversionLead, options: Options): string | null {
  if (event.contactId !== lead.contactId || event.leadId !== lead.leadId || event.details.occurrenceIdentityConflict === true) return null;
  const declared = object(event.details.occurrenceIdentity);
  const direct = identity(event.occurrenceId) ?? identity(event.details.occurrenceId);
  if (event.occurrenceId && event.details.occurrenceId && event.occurrenceId !== event.details.occurrenceId) return null;
  const ids = new Set<string>(direct ? [direct] : []);
  if (declared.kind === 'job' && Array.isArray(declared.aliases)) {
    for (const raw of declared.aliases) {
      const alias = object(raw);
      if (alias.kind !== 'job' || typeof alias.namespace !== 'string' || typeof alias.recordId !== 'string') return null;
      const matches = (options.occurrenceAliases ?? []).filter(a => a.kind === 'job' && a.namespace === alias.namespace && a.recordId === alias.recordId);
      // Every referenced alias must be verified; partial binding is not identity.
      if (matches.length !== 1 || matches[0]!.contactId !== lead.contactId) return null;
      ids.add(matches[0]!.occurrenceId);
    }
  }
  if (ids.size !== 1) return null;
  const id = [...ids][0]!;
  const matches = (options.occurrences ?? []).filter(o => o.id === id);
  const row = matches[0];
  return matches.length === 1 && row?.contactId === lead.contactId && row.leadId === lead.leadId && row.kind === 'job' && row.status === 'resolved' && !row.mergedIntoId ? id : null;
}

export function purchaseEventId(leadId: string, occurrenceId: string): string {
  return `egc_${createHash('sha256').update(`egc:crm:lead:${leadId}:stage:Purchase:work:${occurrenceId}`).digest('hex')}`;
}
function held(candidate: ConversionCandidate, reasons: string[]): ConversionCandidate {
  const { payload: _private, ...rest } = candidate;
  return { ...rest, eligible: false, eligibility: 'manual_review', reasons: [...new Set([...rest.reasons, ...reasons])] };
}

/** Keep original stage identities and the existing evidence/time/attribution
 * gates. Feedback is an additional destination projection, not a new source fact. */
export function detectCanonicalFeedback(lead: ConversionLead, events: readonly CanonicalConversionEvidence[], options: Options): ConversionCandidate[] {
  const original = detectCanonicalConversions(lead, events, options);
  if (!options.qualifiedSalesFeedback) return original;
  const enabled = (stage: string) => !options.enabledStages || options.enabledStages.includes(stage);
  const result = original.filter(c => c.stage !== 'QualifiedLead');
  if (enabled('QualifiedLead')) {
    const evidence = events.filter(e => QUALIFICATION_MILESTONES.has(e.eventType));
    const qualified = detectCanonicalConversions(lead, evidence.map(e => ({ ...e, eventType: 'qualified' })), { ...options, enabledStages: ['QualifiedLead'] });
    for (const candidate of qualified) {
      const source = evidence.find(e => e.eventId === candidate.canonicalEventId);
      result.push({ ...candidate, ...(source && !['qualified', 'price_expectation_accepted'].includes(source.eventType) ? { derivedFeedback: true } : {}) });
    }
  }
  if (!enabled('Purchase')) return result;
  const sales = new Map<string, CanonicalConversionEvidence[]>();
  for (const event of events) {
    if (!event.active || !['job_verbally_accepted', 'job_sold'].includes(event.eventType) || event.contactId !== lead.contactId || event.leadId !== lead.leadId) continue;
    const occurrenceId = purchaseOccurrence(event, lead, options);
    // Unresolved sales remain visible as held; never transmit an unbound order.
    const key = occurrenceId ?? 'unresolved';
    sales.set(key, [...(sales.get(key) ?? []), event]);
  }
  for (const [occurrence, evidence] of sales) {
    const source = detectCanonicalConversions(lead, evidence, { ...options, enabledStages: ['JOB_WON'] })[0];
    if (!source) continue;
    const eventId = purchaseEventId(lead.leadId, occurrence);
    const candidate: ConversionCandidate = { ...source, stage: 'Purchase', eventId, derivedFeedback: true,
      ...(source.payload ? { payload: { ...source.payload, event_name: 'Purchase', event_id: eventId,
        custom_data: { ...source.payload.custom_data, order_id: occurrence } } } : {}) };
    const missing = [
      ...(occurrence === 'unresolved' ? ['purchase_work_identity_requires_review'] : []),
      ...(reliableRevenueCents(source.valueCents) === null || source.currency !== 'USD' ? ['purchase_verified_sale_value_required'] : [])
    ];
    result.push(missing.length ? held(candidate, missing) : candidate);
  }
  return result.sort((a, b) => (a.eventTime ?? '').localeCompare(b.eventTime ?? '') || a.eventId.localeCompare(b.eventId));
}
