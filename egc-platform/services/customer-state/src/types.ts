export const OPERATIONAL_STATES = [
  "NEW_LEAD", "OUTREACH_ATTEMPTED", "TWO_WAY_CONTACT", "QUALIFIED", "PRICE_EXPECTATION_ACCEPTED",
  "VIDEO_QUOTE_PENDING_CUSTOMER", "VIDEO_QUOTE_RECEIVED", "VIDEO_QUOTE_IN_PROGRESS", "QUOTE_DELIVERED",
  "WALKTHROUGH_VERBALLY_BOOKED", "WALKTHROUGH_BOOKED", "WALKTHROUGH_COMPLETED", "FOLLOW_UP_PENDING",
  "CUSTOMER_DECIDING", "JOB_VERBALLY_ACCEPTED", "JOB_SOLD", "JOB_SCHEDULED", "JOB_COMPLETED", "CASH_COLLECTED",
  "LOST", "DO_NOT_CONTACT"
] as const;
export type OperationalState = typeof OPERATIONAL_STATES[number];
export const EVENT_TYPES = [
  "lead_created", "human_outreach", "customer_response", "two_way_contact", "qualified", "price_expectation_given",
  "price_expectation_accepted", "address_supplied", "appointment_time_agreed", "video_quote_requested", "video_quote_customer_agreed",
  "video_quote_received", "video_quote_in_progress", "quote_prepared", "quote_delivered", "customer_deciding",
  "walkthrough_verbally_booked", "walkthrough_booked", "walkthrough_showed", "walkthrough_completed",
  "walkthrough_negative_outcome", "job_verbally_accepted", "job_sold", "payment_discussed", "deposit_collected",
  "job_scheduled", "job_completed", "revenue_collected", "lost", "do_not_contact", "appointment_cancelled",
  "no_show", "follow_up_commitment"
] as const;
export type CustomerEventType = typeof EVENT_TYPES[number];
export type SourceType = "lead" | "message" | "call" | "call_transcript" | "appointment" | "opportunity" | "job" | "job_note" | "walkthrough" | "portal_visit" | "portal_job" | "portal_payment" | "user_confirmed" | "provider_note";
export type Json = Record<string, unknown>;
export type EvidenceRef = {
  sourceType: SourceType; sourceRecordId: string; occurredAt: string; excerpt: string;
  sourcePointer?: string; confidence: number; humanReviewNeeded: boolean; excerptTruncated?: boolean;
};
export interface EvidenceEvent {
  eventType: CustomerEventType;
  confidence: number;
  supportingText: string;
  humanReviewNeeded: boolean;
  nextAction: string | null;
  occurredAt?: string;
  details?: Json;
  valueCents?: number;
  currency?: string;
  valueVerified?: boolean;
}
export interface SourceRecord {
  sourceType: SourceType; sourceRecordId: string; contactId: string; leadId?: string | null;
  occurredAt: string; text: string; direction?: string; actorType?: string; raw?: Json;
  opportunityId?: string | null; appointmentId?: string | null; jobId?: string | null;
  events?: EvidenceEvent[]; extractionStatus?: string; sourcePointer?: string;
}
export interface CanonicalEvent {
  eventId: string; eventType: CustomerEventType; contactId: string; leadId: string | null;
  opportunityId: string | null; appointmentId: string | null; jobId: string | null;
  occurredAt: string; source: SourceType; confidence: number; humanReviewNeeded: boolean;
  evidence: EvidenceRef[]; nextAction: string | null; details: Json;
  attribution: Json; valueCents: number | null; currency: string | null; valueVerified: boolean;
  syncState: string;
}
export interface OperationalAssertion {
  id: string; contactId: string; field: string; value: unknown; assertedAt: string; occurredAt: string;
  exactText: string; sourceReference: string; actorId: string;
  occurredAtVerified?: boolean;
  status: "pending_reconciliation" | "reconciled" | "superseded"; reconciledAt?: string | null;
  valueCents?: number | null; currency?: string | null;
}
export interface CustomerProjection {
  contactId: string; leadId: string | null; customerName: string | null; leadCreatedAt: string;
  state: OperationalState; intentStage: "unengaged" | "engaged" | "qualified" | "high_intent" | "accepted" | "converted" | "inactive";
  pipeline: "walkthrough" | "video_quote" | "direct_job" | "unclassified";
  videoQuoteStage: "requested" | "customer_agreed" | "media_received" | "estimator_review" | "quote_prepared" | "quote_sent" | "customer_deciding" | "accepted" | "lost" | null;
  pipelineDisposition: "active" | "converted" | "negative_outcome" | "lost" | "do_not_contact";
  reconciliationStatus: "fully_reconciled" | "verbally_booked_provider_pending" | "provider_booking_confirmed" | "reconciliation_needed" | "duplicate_suspected";
  supportingEvidence: EvidenceRef[]; nextRequiredAction: string; humanReviewNeeded: boolean;
  followUpCommitment?: {occurredAt:string;deadline:unknown;action:string|null;evidence:EvidenceRef[]}|null;
  discrepancies: Array<{code: string; detail: string; sourceIds: string[]}>;
  excluded: boolean; exclusionReasons: string[]; eventIds: string[]; lastEventAt: string;
}
export interface PortalEvidenceRecord {
  id: string; highlevelContactId: string; kind: "walkthrough" | "job" | "payment";
  status: string; createdAt?: string | null; updatedAt?: string | null; completedAt?: string | null;
  startAt?: string | null; sourceRevision?: string | null; highlevelAppointmentId?: string | null;
  jobId?: string | null; sourceWalkthroughId?: string | null; address?: string | null;
  soldAt?: string | null; paidAt?: string | null; priceCents?: number | null; paidCents?: number | null;
  currency?: string | null; financials?: Json;
}
export interface ReconcileOptions {
  contactIds?: string[]; since?: Date | string; until?: Date | string; useAI?: boolean; maxContacts?: number;
  portalRecords?: PortalEvidenceRecord[]; portalCoverage?: { complete: boolean; asOf: string; error?: string; window?: { start: string; end: string } };
}
