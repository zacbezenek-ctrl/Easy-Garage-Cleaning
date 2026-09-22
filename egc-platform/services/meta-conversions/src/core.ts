import { createHash } from "node:crypto";

export const PAYLOAD_VERSION = "1";
export const MAX_EVENT_AGE_DAYS = 7;
export type ConversionStage = "Lead" | "QualifiedLead" | "WALKTHROUGH_BOOKED" | "WALKTHROUGH_SHOWED" | "WALKTHROUGH_COMPLETED" | "QUOTE_DELIVERED" | "JOB_WON" | "JOB_COMPLETED" | "REVENUE_COLLECTED";
export type AttributionClassification = "eligible_meta_paid" | "meta_insufficient_matching" | "non_meta" | "ambiguous";
type DateValue = Date | string | null;

/** Original normalized lead/contact data. Never pass this object to an MCP response. */
export interface ConversionLead {
  leadId: string;
  contactId: string;
  source?: string | null;
  contactSource?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  raw?: Record<string, unknown> | null;
  createdAt?: DateValue;
  providerCreatedAt?: DateValue;
  firstBookedAt?: DateValue;
}

export interface ConversionAppointment {
  id: string;
  contactId: string;
  calendarId: string | null;
  status: string;
  appointmentCreatedAt: DateValue;
  appointmentStartAt: DateValue;
}

export interface ConversionOpportunity {
  id: string;
  contactId: string;
  status: string | null;
  wonAt?: DateValue;
  monetaryValueCents?: number | null;
}

export interface ConversionJob {
  id: string;
  contactId: string;
  opportunityId?: string | null;
  appointmentId?: string | null;
  status: string;
  serviceType?: string | null;
  wonAt?: DateValue;
  scheduledAt?: DateValue;
  priceCents?: number | null;
  depositCents?: number | null;
}

export interface MetaUserData {
  em?: string[];
  ph?: string[];
  external_id?: string[];
  lead_id?: string;
  fbc?: string;
  fbp?: string;
}

export interface AttributionEvidence {
  source: "meta" | "non_meta" | "unknown" | "conflicting";
  attributionSource: "initial" | "last" | "root" | "none";
  adId?: string;
  campaignId?: string;
  adSetId?: string;
  paidEvidence: boolean;
}

export interface MatchingSummary {
  fields: Array<keyof MetaUserData>;
  quality: "strong" | "usable" | "insufficient";
}

export interface AttributionResult {
  classification: AttributionClassification;
  reasons: string[];
  evidence: AttributionEvidence;
  matching: MatchingSummary;
  /** Server only. toConversionPreview explicitly excludes these identifiers and hashes. */
  userData: MetaUserData;
}

export interface MetaConversionPayload {
  event_name: ConversionStage;
  event_time: number;
  event_id: string;
  action_source: "system_generated";
  user_data: MetaUserData;
  custom_data: {
    event_source: "crm";
    lead_event_source: "EGC";
    value?: number;
    currency?: "USD";
  };
}

export interface ConversionCandidate {
  canonicalEventId?: string;
  eventId: string;
  stage: ConversionStage;
  leadId: string;
  contactId: string;
  appointmentId?: string;
  jobId?: string;
  opportunityId?: string;
  eventTime: string | null;
  eligible: boolean;
  eligibility: "eligible" | "skipped" | "manual_review";
  reasons: string[];
  attribution: Omit<AttributionResult, "userData">;
  matching: MatchingSummary;
  valueCents?: number;
  currency?: "USD";
  payloadVersion: string;
  payload?: MetaConversionPayload;
}

export interface DetectionOptions {
  now: Date;
  walkthroughCalendarIds: readonly string[];
  jobCalendarIds?: readonly string[];
  maxAgeDays?: number;
  /** Explicit activation boundary; never invent a fresh timestamp for older events. */
  notBefore?: Date;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonical(value: unknown): string {
  return string(value)?.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ") ?? "";
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeEmail(value: unknown): string | null {
  const email = string(value)?.toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  return email;
}

/** EGC serves the US. A foreign country marker disables the US local-number default. */
export function normalizePhone(value: unknown, country: string | null = "US"): string | null {
  const phone = string(value);
  if (!phone || !/^\+?[\d\s().-]+$/.test(phone)) return null;
  let digits = phone.replace(/\D/g, "");
  const isUS = ["us", "usa", "united states", ""].includes(canonical(country));
  if (!phone.startsWith("+") && digits.length === 10 && isUS) digits = `1${digits}`;
  if (!phone.startsWith("+") && !(isUS && digits.length === 11 && digits.startsWith("1"))) return null;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  // Reject invalid NANP exchange/area prefixes and obvious placeholders.
  if (digits.startsWith("1") && (digits.length !== 11 || !/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits))) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  return digits;
}

function numericId(value: unknown): string | undefined {
  // Strings only: a JS number may already have lost Meta's integer precision.
  const id = string(value);
  return id && /^\d{5,25}$/.test(id) && !/^0+$/.test(id) ? id : undefined;
}

function aliases(source: Record<string, unknown>, keys: readonly string[]): { value?: string; conflict: boolean } {
  const values = [...new Set(keys.map((key) => numericId(source[key])).filter((v): v is string => Boolean(v)))];
  return { ...(values.length === 1 ? { value: values[0]! } : {}), conflict: values.length > 1 };
}

const META_SOURCES = new Set([
  "facebook", "fb", "meta", "instagram", "ig", "facebook ads", "meta ads", "instagram ads",
  "facebook lead ads", "facebook lead ad", "meta lead ads", "facebook lead form"
]);
const OTHER_SOURCES = new Set([
  "website", "web", "organic", "organic social", "direct", "referral", "word of mouth", "google",
  "google ads", "google business profile", "google my business", "bing", "yelp", "nextdoor", "manual"
]);
const PAID_CHANNELS = new Set(["paid social", "paid", "cpc", "ppc", "paid social media"]);
const ORGANIC_CHANNELS = new Set(["organic", "organic social", "referral", "direct", "organic search"]);

export function classifyAttribution(lead: ConversionLead): AttributionResult {
  const raw = record(lead.raw);
  const initial = record(raw.attributionSource);
  const last = record(raw.lastAttributionSource);
  const hasInitial = Object.keys(initial).length > 0;
  const hasLast = Object.keys(last).length > 0;
  // First-touch attribution stays authoritative even after a later paid visit.
  const selected = hasInitial ? initial : hasLast ? last : raw;
  const scope: AttributionEvidence["attributionSource"] = hasInitial ? "initial" : hasLast ? "last" : Object.keys(raw).length ? "root" : "none";
  const selectedSources = [selected.source, selected.utmSource, selected.utm_source, selected.adSource, selected.medium];
  const hasInitialOrigin = hasInitial && selectedSources.some(value => Boolean(string(value)));
  const sourceValues = [...(hasInitialOrigin ? [] : [lead.source, lead.contactSource, raw.source]), ...selectedSources]
    .map(canonical).filter(Boolean);
  const channelValues = [selected.sessionSource, selected.session_source, selected.utmMedium, selected.utm_medium]
    .map(canonical).filter(Boolean);
  const hasMeta = sourceValues.some((source) => META_SOURCES.has(source));
  const hasOther = sourceValues.some((source) => OTHER_SOURCES.has(source)) || channelValues.some((source) => ORGANIC_CHANNELS.has(source));
  const ad = aliases(selected, ["adId", "ad_id"]);
  const campaign = aliases(selected, ["campaignId", "campaign_id"]);
  const adSet = aliases(selected, ["adSetId", "adsetId", "ad_set_id", "adset_id"]);
  const paidEvidence = Boolean(ad.value || (campaign.value && channelValues.some((channel) => PAID_CHANNELS.has(channel))));

  // Only names which identify a Meta lead explicitly. Generic raw.id/leadId/lead_id
  // may identify a GHL contact or lead and must never be sent as a Meta lead_id.
  const leadKeys = ["facebookLeadId", "facebook_lead_id", "fbLeadId", "fb_lead_id", "metaLeadId", "meta_lead_id", "leadgen_id"];
  const selectedLeadId = aliases(selected, leadKeys);
  const rootLeadId = aliases(raw, leadKeys);
  const leadIdConflict = selectedLeadId.conflict || rootLeadId.conflict || Boolean(selectedLeadId.value && rootLeadId.value && selectedLeadId.value !== rootLeadId.value);
  const metaLeadId = leadIdConflict ? undefined : selectedLeadId.value ?? rootLeadId.value;
  const userData: MetaUserData = {};
  const email = normalizeEmail(lead.email);
  const phone = normalizePhone(lead.phone, lead.country ?? string(raw.country) ?? "US");
  if (email) userData.em = [sha256(email)];
  if (phone) userData.ph = [sha256(phone)];
  if (metaLeadId) userData.lead_id = metaLeadId;
  // These are captured values only. Never synthesize fbc from an ad or click ID.
  const fbc = string(selected.fbc) ?? string(selected._fbc) ?? string(raw.fbc) ?? string(raw._fbc);
  const fbp = string(selected.fbp) ?? string(selected._fbp) ?? string(raw.fbp) ?? string(raw._fbp);
  if (fbc && /^fb\.[0-2]\.\d{13}\.[A-Za-z0-9_-]{6,500}$/.test(fbc)) userData.fbc = fbc;
  if (fbp && /^fb\.[0-2]\.\d{13}\.\d{5,30}$/.test(fbp)) userData.fbp = fbp;
  if (lead.contactId) userData.external_id = [sha256(`egc:contact:${lead.contactId}`)];
  const sufficientMatching = Boolean(userData.lead_id || userData.em || userData.ph);
  const matching: MatchingSummary = {
    fields: Object.keys(userData) as Array<keyof MetaUserData>,
    quality: userData.lead_id || (userData.em && userData.ph) ? "strong" : sufficientMatching ? "usable" : "insufficient"
  };
  const evidence: AttributionEvidence = {
    source: hasMeta && hasOther ? "conflicting" : hasMeta ? "meta" : hasOther ? "non_meta" : "unknown",
    attributionSource: scope,
    ...(ad.value ? { adId: ad.value } : {}),
    ...(campaign.value ? { campaignId: campaign.value } : {}),
    ...(adSet.value ? { adSetId: adSet.value } : {}),
    paidEvidence
  };

  let classification: AttributionClassification;
  const reasons: string[] = [];
  // Explicit provider test markers override otherwise valid attribution. Do not
  // guess from names, email addresses, or a numeric Meta lead ID: real customers
  // can resemble test data, and verification leads use ordinary-looking IDs.
  const tags = Array.isArray(raw.tags) ? raw.tags.map(canonical) : [];
  const excluded = raw.dnd === true || raw.doNotContact === true || tags.some(tag => ["do not contact", "dnc"].includes(tag));
  const explicitInternal = raw.isInternal === true || raw.isVendor === true || tags.some(tag => ["egc test", "test", "test lead", "egc internal", "internal", "vendor", "egc vendor", "supplier"].includes(tag)) || canonical(raw.source) === "egc synthetic routing validation";
  const explicitTest = [raw, initial, last].some((source) =>
    ["isTest", "is_test", "isTestLead", "is_test_lead"].some((key) => source[key] === true));
  if (excluded || explicitInternal) {
    classification = "ambiguous";
    reasons.push(excluded ? "do_not_contact" : "internal_or_vendor_record");
  } else if (explicitTest) {
    classification = "ambiguous";
    reasons.push("explicit_test_record");
  } else if ((hasMeta && hasOther) || ad.conflict || campaign.conflict || adSet.conflict || leadIdConflict) {
    classification = "ambiguous";
    reasons.push(hasMeta && hasOther ? "conflicting_origin_evidence" : "conflicting_meta_identifiers");
  } else if (hasMeta && paidEvidence) {
    classification = sufficientMatching ? "eligible_meta_paid" : "meta_insufficient_matching";
    reasons.push(sufficientMatching ? "verified_meta_paid_origin" : "missing_supported_customer_match");
  } else if (hasMeta) {
    classification = "ambiguous";
    reasons.push("meta_origin_without_paid_ad_evidence");
  } else if (paidEvidence || metaLeadId) {
    classification = "ambiguous";
    reasons.push("meta_identifiers_without_meta_origin");
  } else {
    classification = "non_meta";
    reasons.push("no_meta_paid_origin");
  }
  return { classification, reasons, evidence, matching, userData };
}

export function deterministicEventId(leadId: string, stage: ConversionStage): string {
  if (!leadId) throw new Error("missing_lead_id");
  // Identity intentionally excludes payload version, value, entity updates, and send time.
  return `egc_${sha256(`egc:crm:lead:${leadId}:stage:${stage}`)}`;
}

function date(value: DateValue | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

export function reliableRevenueCents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
}

export function eventTimeReasons(eventTime: Date | null, options: DetectionOptions): string[] {
  if (!eventTime) return ["missing_reliable_transition_time"];
  if (!Number.isFinite(options.now.valueOf())) return ["invalid_reference_time"];
  if (eventTime.valueOf() > options.now.valueOf()) return ["future_event_time"];
  const ageDays = options.maxAgeDays ?? MAX_EVENT_AGE_DAYS;
  const maxAge = Math.max(0, Math.min(MAX_EVENT_AGE_DAYS, Number.isFinite(ageDays) ? ageDays : MAX_EVENT_AGE_DAYS));
  if (eventTime.valueOf() < options.now.valueOf() - maxAge * 86_400_000) return ["event_outside_meta_age_window"];
  if (options.notBefore && eventTime.valueOf() < options.notBefore.valueOf()) return ["before_production_activation"];
  return [];
}

type DetectedStage = {
  stage: ConversionStage;
  time: Date | null;
  reasons: string[];
  appointmentId?: string;
  opportunityId?: string;
  jobId?: string;
  valueCents?: number;
};

function stableStageOrder(a: DetectedStage, b: DetectedStage): number {
  // Unknown earlier history is a manual-review blocker, not a reason to select a later event.
  return (a.time?.valueOf() ?? -Infinity) - (b.time?.valueOf() ?? -Infinity)
    || (a.appointmentId ?? a.opportunityId ?? a.jobId ?? "").localeCompare(b.appointmentId ?? b.opportunityId ?? b.jobId ?? "");
}

function jobQualificationReasons(job: ConversionJob, lead: ConversionLead, appointments: readonly ConversionAppointment[], options: DetectionOptions): string[] | null {
  if (job.contactId !== lead.contactId || !["scheduled", "confirmed", "in_progress", "completed"].includes(job.status)) return null;
  if (/walk\s*through|estimate|consultation/i.test(job.serviceType ?? "")) return null;
  const appointment = appointments.find((candidate) => candidate.id === job.appointmentId && candidate.contactId === lead.contactId);
  if (appointment?.calendarId && options.walkthroughCalendarIds.includes(appointment.calendarId)) return null;
  const reasons: string[] = [];
  if (["scheduled", "confirmed"].includes(job.status)) {
    if (!date(job.scheduledAt)) reasons.push("missing_job_schedule");
    if (!options.jobCalendarIds?.length) reasons.push("job_calendar_not_configured");
    else if (!appointment?.calendarId || !options.jobCalendarIds.includes(appointment.calendarId) || !["new", "confirmed", "showed"].includes(appointment.status)) {
      reasons.push("missing_verified_job_appointment");
    }
  }
  return reasons;
}

export function buildCandidate(lead: ConversionLead, attribution: AttributionResult, detected: DetectedStage, options: DetectionOptions): ConversionCandidate {
  const reasons = [...attribution.reasons, ...detected.reasons, ...eventTimeReasons(detected.time, options)];
  const leadCreatedAt = date(lead.providerCreatedAt ?? lead.createdAt);
  if (detected.time && leadCreatedAt && detected.time < leadCreatedAt) reasons.push("conversion_precedes_lead_creation");
  const eligible = attribution.classification === "eligible_meta_paid" && reasons.length === 1;
  const manualReview = attribution.classification === "ambiguous" || reasons.some((reason) => [
    "missing_reliable_transition_time", "walkthrough_calendar_not_configured", "unknown_walkthrough_calendar",
    "conversion_precedes_lead_creation", "missing_appointment_start", "appointment_start_precedes_booking",
    "missing_job_schedule", "job_calendar_not_configured", "missing_verified_job_appointment", "invalid_reference_time", "future_event_time",
    "canonical_evidence_needs_review", "canonical_evidence_reference_missing", "canonical_source_extraction_incomplete",
    "canonical_do_not_contact", "canonical_customer_excluded", "missing_canonical_state"
  ].includes(reason));
  const eventId = deterministicEventId(lead.leadId, detected.stage);
  const { userData, ...safeAttribution } = attribution;
  const hasValue = detected.valueCents !== undefined;
  return {
    eventId, stage: detected.stage, leadId: lead.leadId, contactId: lead.contactId,
    ...(detected.appointmentId ? { appointmentId: detected.appointmentId } : {}),
    ...(detected.opportunityId ? { opportunityId: detected.opportunityId } : {}),
    ...(detected.jobId ? { jobId: detected.jobId } : {}),
    eventTime: detected.time?.toISOString() ?? null,
    eligible, eligibility: eligible ? "eligible" : manualReview ? "manual_review" : "skipped",
    reasons, attribution: safeAttribution, matching: attribution.matching,
    ...(hasValue ? { valueCents: detected.valueCents!, currency: "USD" as const } : {}),
    payloadVersion: PAYLOAD_VERSION,
    ...(eligible && detected.time ? { payload: {
      event_name: detected.stage,
      event_time: Math.floor(detected.time.valueOf() / 1000),
      event_id: eventId,
      action_source: "system_generated" as const,
      user_data: userData,
      custom_data: {
        event_source: "crm" as const, lead_event_source: "EGC" as const,
        ...(hasValue ? { value: detected.valueCents! / 100, currency: "USD" as const } : {})
      }
    } } : {})
  };
}

/** First legitimate conversion of each stage per lead; cancellation never creates a new stage identity. */
export function detectConversions(input: {
  lead: ConversionLead;
  appointments?: readonly ConversionAppointment[];
  opportunities?: readonly ConversionOpportunity[];
  jobs?: readonly ConversionJob[];
}, options: DetectionOptions): ConversionCandidate[] {
  const { lead } = input;
  const attribution = classifyAttribution(lead);
  const stages: DetectedStage[] = [];
  const bookings: DetectedStage[] = [];
  const calendars = new Set(options.walkthroughCalendarIds.filter(Boolean));
  const jobCalendars = new Set(options.jobCalendarIds ?? []);
  for (const appointment of input.appointments ?? []) {
    if (appointment.contactId !== lead.contactId || !["new", "confirmed", "showed"].includes(appointment.status)) continue;
    // A known service appointment is not an unverified walkthrough candidate.
    if (appointment.calendarId && jobCalendars.has(appointment.calendarId) && !calendars.has(appointment.calendarId)) continue;
    // An unrecognized calendar cannot prove a garage walkthrough. Include it as a
    // review row only when there are no verified walkthroughs to avoid masking one.
    const reasons: string[] = [];
    if (!calendars.size) reasons.push("walkthrough_calendar_not_configured");
    else if (!appointment.calendarId || !calendars.has(appointment.calendarId)) reasons.push("unknown_walkthrough_calendar");
    const time = date(appointment.appointmentCreatedAt);
    const start = date(appointment.appointmentStartAt);
    if (!start) reasons.push("missing_appointment_start");
    else if (time && start < time) reasons.push("appointment_start_precedes_booking");
    bookings.push({ stage: "WALKTHROUGH_BOOKED", time, reasons, appointmentId: appointment.id });
  }
  const verifiedBookings = bookings.filter((booking) => !booking.reasons.some((reason) => reason.includes("calendar")));
  const booking = (verifiedBookings.length ? verifiedBookings : bookings).sort(stableStageOrder)[0];
  if (booking) stages.push(booking);

  const wins: DetectedStage[] = [];
  const opportunities = (input.opportunities ?? []).filter((opportunity) => opportunity.contactId === lead.contactId && opportunity.status === "won");
  for (const opportunity of opportunities) {
    const opportunityRevenue = reliableRevenueCents(opportunity.monetaryValueCents);
    const linkedServiceJobs = (input.jobs ?? []).filter((job) => job.opportunityId === opportunity.id &&
      jobQualificationReasons(job, lead, input.appointments ?? [], options)?.length === 0);
    // A single verified linked service job may supply a missing opportunity
    // value. Multiple jobs are not summed or guessed into a customer lifetime value.
    const valueJob = opportunityRevenue === null && linkedServiceJobs.length === 1 ? linkedServiceJobs[0] : undefined;
    const revenue = opportunityRevenue ?? reliableRevenueCents(valueJob?.priceCents);
    wins.push({
      stage: "JOB_WON", time: date(opportunity.wonAt), reasons: [], opportunityId: opportunity.id,
      ...(valueJob && revenue !== null ? { jobId: valueJob.id } : {}),
      ...(revenue === null ? {} : { valueCents: revenue })
    });
  }
  for (const job of input.jobs ?? []) {
    const reasons = jobQualificationReasons(job, lead, input.appointments ?? [], options);
    if (reasons === null) continue;
    // The won opportunity is already this logical customer conversion. Its value
    // and transition are authoritative; never sum a linked job or deposit into it.
    if (job.opportunityId && opportunities.some((opportunity) => opportunity.id === job.opportunityId)) continue;
    const revenue = reliableRevenueCents(job.priceCents);
    wins.push({
      stage: "JOB_WON", time: date(job.wonAt), reasons, jobId: job.id,
      ...(job.opportunityId ? { opportunityId: job.opportunityId } : {}),
      ...(revenue === null ? {} : { valueCents: revenue })
    });
  }
  const won = wins.sort(stableStageOrder)[0];
  if (won) stages.push(won);
  return stages.map((stage) => buildCandidate(lead, attribution, stage, options));
}

export function toConversionPreview(candidate: ConversionCandidate): Omit<ConversionCandidate, "payload"> {
  // An explicit allowlist avoids leaking newly added server-only fields later.
  return {
    ...(candidate.canonicalEventId ? { canonicalEventId: candidate.canonicalEventId } : {}),
    eventId: candidate.eventId, stage: candidate.stage, leadId: candidate.leadId, contactId: candidate.contactId,
    ...(candidate.appointmentId ? { appointmentId: candidate.appointmentId } : {}),
    ...(candidate.jobId ? { jobId: candidate.jobId } : {}),
    ...(candidate.opportunityId ? { opportunityId: candidate.opportunityId } : {}),
    eventTime: candidate.eventTime, eligible: candidate.eligible, eligibility: candidate.eligibility,
    reasons: candidate.reasons, attribution: candidate.attribution, matching: candidate.matching,
    ...(candidate.valueCents !== undefined ? { valueCents: candidate.valueCents, currency: "USD" as const } : {}),
    payloadVersion: candidate.payloadVersion
  };
}
