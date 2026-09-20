import { describe, expect, it } from "vitest";
import {
  classifyAttribution, detectConversions, deterministicEventId, eventTimeReasons,
  normalizeEmail, normalizePhone, reliableRevenueCents, sha256, toConversionPreview,
  type ConversionAppointment, type ConversionJob, type ConversionLead,
  type ConversionOpportunity, type DetectionOptions
} from "./core.js";

const now = new Date("2026-09-20T18:00:00.000Z");
const booked = "2026-09-19T18:00:00.000Z";
const options: DetectionOptions = { now, walkthroughCalendarIds: ["walkthrough"], jobCalendarIds: ["service"] };
function lead(overrides: Partial<ConversionLead> = {}): ConversionLead {
  return {
    leadId: "lead-1", contactId: "contact-1", source: "Facebook", email: " Example@Example.com ", phone: "+1 (970) 555-1234",
    providerCreatedAt: "2026-09-18T18:00:00.000Z",
    raw: { attributionSource: { adId: "120253868777650385", medium: "facebook", adSource: "facebook", campaignId: "120253712240240385", utmSource: "facebook", sessionSource: "Paid Social", mediumId: "1585285739806114" } },
    ...overrides
  };
}
function appointment(overrides: Partial<ConversionAppointment> = {}): ConversionAppointment {
  return { id: "appointment-1", contactId: "contact-1", calendarId: "walkthrough", status: "confirmed", appointmentCreatedAt: booked, appointmentStartAt: "2026-09-22T18:00:00.000Z", ...overrides };
}
function opportunity(overrides: Partial<ConversionOpportunity> = {}): ConversionOpportunity {
  return { id: "opportunity-1", contactId: "contact-1", status: "won", wonAt: booked, monetaryValueCents: 190_000, ...overrides };
}
function job(overrides: Partial<ConversionJob> = {}): ConversionJob {
  return { id: "job-1", contactId: "contact-1", status: "scheduled", serviceType: "garage cleaning", appointmentId: "service-appointment", wonAt: booked, scheduledAt: "2026-09-22T18:00:00.000Z", priceCents: 190_000, depositCents: 50_000, ...overrides };
}
function serviceAppointment(): ConversionAppointment {
  return appointment({ id: "service-appointment", calendarId: "service" });
}
function booking(overrides: Partial<ConversionLead> = {}, app: Partial<ConversionAppointment> = {}, config: DetectionOptions = options) {
  return detectConversions({ lead: lead(overrides), appointments: [appointment(app)] }, config)[0]!;
}

describe("deterministic Meta attribution", () => {
  it("accepts preserved Facebook paid attribution without mistaking mediumId for a Meta lead", () => {
    const result = classifyAttribution(lead());
    expect(result.classification).toBe("eligible_meta_paid");
    expect(result.evidence.adId).toBe("120253868777650385");
    expect(result.userData.lead_id).toBeUndefined();
    expect(result.matching.quality).toBe("strong");
  });
  it("accepts phone-only Facebook leads", () => {
    const result = classifyAttribution(lead({ email: null }));
    expect(result.classification).toBe("eligible_meta_paid");
    expect(result.matching.quality).toBe("usable");
  });
  it.each(["website", "Referral", "Google", "Organic", "direct"])("does not attribute %s leads to Meta", (source) => {
    expect(classifyAttribution(lead({ source, raw: {} })).classification).toBe("non_meta");
  });
  it("requires actual paid evidence for a Facebook source", () => {
    expect(classifyAttribution(lead({ raw: {} })).classification).toBe("ambiguous");
  });
  it("does not treat Meta-shaped ad IDs as proof of Meta origin", () => {
    expect(classifyAttribution(lead({ source: "website", raw: { attributionSource: { adId: "120253868777650385" } } })).classification).toBe("ambiguous");
  });
  it("rejects conflicting organic and paid Meta evidence", () => {
    expect(classifyAttribution(lead({ contactSource: "Referral" })).classification).toBe("ambiguous");
    expect(classifyAttribution(lead({ raw: { attributionSource: { adId: "120253868777650385", sessionSource: "Organic Social" } } })).classification).toBe("ambiguous");
  });
  it("keeps initial origin authoritative over a later paid visit", () => {
    const result = classifyAttribution(lead({ source: "website", raw: {
      attributionSource: { source: "website", sessionSource: "Organic" },
      lastAttributionSource: { utmSource: "facebook", adId: "120253868777650385" }
    } }));
    expect(result.classification).toBe("non_meta");
    expect(result.evidence.attributionSource).toBe("initial");
  });
  it("never merges a later ad into insufficient initial attribution", () => {
    const result = classifyAttribution(lead({ raw: {
      attributionSource: { source: "facebook" }, lastAttributionSource: { adId: "120253868777650385" }
    } }));
    expect(result.classification).toBe("ambiguous");
  });
  it("classifies missing supported matching separately even with external and browser IDs", () => {
    const input = lead({ email: null, phone: null });
    input.raw!.fbp = "fb.1.1790000000000.123456789";
    input.raw!.fbc = "fb.1.1790000000000.Abcdef0123456789";
    const result = classifyAttribution(input);
    expect(result.classification).toBe("meta_insufficient_matching");
    expect(result.matching.quality).toBe("insufficient");
  });
  it("uses genuine explicit Meta lead identifiers un-hashed", () => {
    const input = lead({ email: null, phone: null });
    input.raw!.facebookLeadId = "987654321098765";
    const result = classifyAttribution(input);
    expect(result.classification).toBe("eligible_meta_paid");
    expect(result.userData.lead_id).toBe("987654321098765");
  });
  it("never uses contact ID, generic lead ID, medium ID, or ad ID as Meta lead_id", () => {
    const input = lead({ email: null, phone: null });
    input.raw!.id = "987654321098765";
    input.raw!.leadId = "987654321098765";
    input.raw!.lead_id = "987654321098765";
    input.raw!.fbclid = "abcdef123456";
    const result = classifyAttribution(input);
    expect(result.userData.lead_id).toBeUndefined();
    expect(result.userData.fbc).toBeUndefined();
    expect(result.classification).toBe("meta_insufficient_matching");
  });
  it("rejects conflicting explicit Meta identifiers", () => {
    const input = lead();
    input.raw!.facebookLeadId = "987654321098765";
    input.raw!.metaLeadId = "987654321098766";
    expect(classifyAttribution(input).classification).toBe("ambiguous");
  });
  it("rejects numeric ad IDs that may already have lost precision", () => {
    const input = lead({ raw: { attributionSource: { adId: 120253868777650385 } } });
    expect(classifyAttribution(input).classification).toBe("ambiguous");
  });
  it("does not return free-form source text, raw fields, email or phone in a preview", () => {
    const candidate = booking();
    const preview = JSON.stringify(toConversionPreview(candidate));
    expect(preview).not.toContain("Example@");
    expect(preview).not.toContain("555-1234");
    expect(preview).not.toContain(sha256("example@example.com"));
    expect(preview).not.toContain("user_data");
    expect(preview).not.toContain("payload\"");
  });
});

describe("matching normalization", () => {
  it("trims and lowercases email before hashing", () => {
    expect(normalizeEmail(" User.Name+Offer@EXAMPLE.COM ")).toBe("user.name+offer@example.com");
    expect(classifyAttribution(lead()).userData.em).toEqual([sha256("example@example.com")]);
    expect(sha256("test")).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });
  it.each(["", "not-email", "a b@example.com", "a@@b.com"])("rejects invalid email %s", (value) => {
    expect(normalizeEmail(value)).toBeNull();
  });
  it("normalizes US phone numbers and retains explicit international country codes", () => {
    expect(normalizePhone("(970) 555-1234")).toBe("19705551234");
    expect(normalizePhone("1-970-555-1234")).toBe("19705551234");
    expect(normalizePhone("+44 20 7946 0958", "GB")).toBe("442079460958");
    expect(classifyAttribution(lead()).userData.ph).toEqual([sha256("19705551234")]);
  });
  it.each(["5551234", "0000000000", "+1 170 155-1234", "+1 970 555-1234 ext 5", "+00012345678"])("rejects invalid or ambiguous phone %s", (value) => {
    expect(normalizePhone(value)).toBeNull();
  });
  it("does not assume US for an explicitly foreign local number", () => {
    expect(normalizePhone("2079460958", "GB")).toBeNull();
  });
});

describe("walkthrough eligibility and timing", () => {
  it("uses booking creation time, never future appointment start", () => {
    const candidate = booking();
    expect(candidate.eligible).toBe(true);
    expect(candidate.eventTime).toBe(booked);
    expect(candidate.payload?.event_time).toBe(Date.parse(booked) / 1000);
    expect(candidate.payload?.event_name).toBe("WALKTHROUGH_BOOKED");
    expect(candidate.payload?.action_source).toBe("system_generated");
    expect(candidate.payload?.custom_data).toEqual({ event_source: "crm", lead_event_source: "EGC" });
  });
  it("does not create downstream events for ordinary new leads or firstBookedAt alone", () => {
    expect(detectConversions({ lead: lead({ firstBookedAt: booked }) }, options)).toEqual([]);
  });
  it.each(["cancelled", "noshow", "invalid"])("does not send %s appointments", (status) => {
    expect(detectConversions({ lead: lead(), appointments: [appointment({ status })] }, options)).toEqual([]);
  });
  it("requires allowlisted walkthrough calendar and reliable booking timestamp", () => {
    expect(booking({}, { calendarId: "unknown" }).eligibility).toBe("manual_review");
    expect(booking({}, {}, { ...options, walkthroughCalendarIds: [] }).reasons).toContain("walkthrough_calendar_not_configured");
    expect(booking({}, { appointmentCreatedAt: null }).reasons).toContain("missing_reliable_transition_time");
    expect(booking({}, { appointmentStartAt: null }).eligible).toBe(false);
  });
  it("never blocks a valid walkthrough because another appointment is on a different calendar", () => {
    const result = detectConversions({ lead: lead(), appointments: [serviceAppointment(), appointment()] }, options);
    expect(result).toHaveLength(1);
    expect(result[0]!.eligible).toBe(true);
    expect(result[0]!.appointmentId).toBe("appointment-1");
  });
  it("does not fabricate a booking entered after the appointment occurred", () => {
    expect(booking({}, { appointmentStartAt: "2026-09-18T18:00:00.000Z" }).reasons).toContain("appointment_start_precedes_booking");
  });
  it("requires explicit time zones rather than guessing local timestamps", () => {
    expect(booking({}, { appointmentCreatedAt: "2026-09-19 18:00:00" }).eligible).toBe(false);
  });
  it("rejects future, stale and pre-activation events without retiming them", () => {
    expect(booking({}, { appointmentCreatedAt: "2026-09-21T18:00:00.000Z" }).reasons).toContain("future_event_time");
    expect(booking({}, { appointmentCreatedAt: "2026-09-12T18:00:00.000Z" }).reasons).toContain("event_outside_meta_age_window");
    expect(booking({}, {}, { ...options, notBefore: now }).reasons).toContain("before_production_activation");
  });
  it("caps any configured age window at Meta's seven-day limit", () => {
    expect(eventTimeReasons(new Date("2026-09-12T18:00:00Z"), { ...options, maxAgeDays: 100 })).toContain("event_outside_meta_age_window");
    expect(eventTimeReasons(new Date("2026-09-13T18:00:00Z"), options)).toEqual([]);
  });
  it("rejects conversions predating known lead creation", () => {
    expect(booking({ providerCreatedAt: now }).reasons).toContain("conversion_precedes_lead_creation");
  });
  it("uses first logical booking before date filtering instead of relabeling a later rebooking as first", () => {
    const result = detectConversions({ lead: lead({ providerCreatedAt: "2026-09-01T18:00:00Z" }), appointments: [
      appointment(), appointment({ id: "old-booking", appointmentCreatedAt: "2026-09-10T18:00:00Z" })
    ] }, options);
    expect(result[0]!.appointmentId).toBe("old-booking");
    expect(result[0]!.eligible).toBe(false);
  });
});

describe("customer wins and revenue", () => {
  it("sends distinct won stage with reliable USD opportunity value", () => {
    const result = detectConversions({ lead: lead(), opportunities: [opportunity()], appointments: [appointment()] }, options);
    expect(result.map((event) => event.stage)).toEqual(["WALKTHROUGH_BOOKED", "JOB_WON"]);
    expect(result[1]!.payload?.custom_data).toMatchObject({ value: 1900, currency: "USD" });
    expect(result[1]!.eventId).not.toBe(result[0]!.eventId);
  });
  it("requires a real durable won transition, not generic record update time", () => {
    const result = detectConversions({ lead: lead(), opportunities: [opportunity({ wonAt: null })] }, options);
    expect(result[0]!.eligible).toBe(false);
    expect(result[0]!.reasons).toContain("missing_reliable_transition_time");
  });
  it.each(["open", "lost", "abandoned"])("does not qualify %s opportunities", (status) => {
    expect(detectConversions({ lead: lead(), opportunities: [opportunity({ status })] }, options)).toEqual([]);
  });
  it("qualifies scheduled service job only with a verified service calendar", () => {
    const result = detectConversions({ lead: lead(), jobs: [job()], appointments: [serviceAppointment()] }, options);
    const win = result.find((candidate) => candidate.stage === "JOB_WON")!;
    expect(win.eligible).toBe(true);
    expect(win.payload?.custom_data.value).toBe(1900);
    expect(win.payload?.custom_data.value).not.toBe(500);
  });
  it("rejects the existing scheduled walkthrough-job pattern", () => {
    const result = detectConversions({ lead: lead(), jobs: [job({ appointmentId: "appointment-1" })], appointments: [appointment()] }, options);
    expect(result.map((candidate) => candidate.stage)).toEqual(["WALKTHROUGH_BOOKED"]);
  });
  it("requires manual review for scheduled job without a verified service booking", () => {
    const result = detectConversions({ lead: lead(), jobs: [job({ appointmentId: null })] }, options);
    expect(result[0]!.eligibility).toBe("manual_review");
    expect(result[0]!.reasons).toContain("missing_verified_job_appointment");
  });
  it.each(["draft", "quoted", "cancelled"])("does not qualify %s jobs even if priced and scheduled", (status) => {
    expect(detectConversions({ lead: lead(), jobs: [job({ status })] }, options)).toEqual([]);
  });
  it("does not count just a walkthrough service as a won customer", () => {
    expect(detectConversions({ lead: lead(), jobs: [job({ status: "completed", serviceType: "Garage walkthrough" })] }, options)).toEqual([]);
  });
  it("qualifies completed/in-progress actual service jobs using durable win time", () => {
    for (const status of ["in_progress", "completed"]) {
      const result = detectConversions({ lead: lead(), jobs: [job({ status, appointmentId: null, scheduledAt: null })] }, options);
      expect(result[0]!.eligible).toBe(true);
    }
  });
  it("deduplicates linked job and won opportunity without summing revenue", () => {
    const result = detectConversions({ lead: lead(), opportunities: [opportunity()], jobs: [job({ opportunityId: "opportunity-1", priceCents: 250_000 })] }, options);
    expect(result).toHaveLength(1);
    expect(result[0]!.valueCents).toBe(190_000);
  });
  it("uses one verified linked service job's total when opportunity value is missing", () => {
    const result = detectConversions({ lead: lead(), opportunities: [opportunity({ monetaryValueCents: null })], jobs: [job({ opportunityId: "opportunity-1" })], appointments: [serviceAppointment()] }, options);
    expect(result).toHaveLength(1);
    expect(result[0]!.valueCents).toBe(190_000);
    expect(result[0]!.jobId).toBe("job-1");
    expect(result[0]!.eventTime).toBe(booked);
  });
  it("does not guess a total from multiple linked jobs or a linked walkthrough", () => {
    const opportunities = [opportunity({ monetaryValueCents: null })];
    const multiple = detectConversions({ lead: lead(), opportunities, jobs: [job({ opportunityId: "opportunity-1", status: "completed" }), job({ id: "job-2", opportunityId: "opportunity-1", status: "completed" })] }, options);
    expect(multiple[0]!.valueCents).toBeUndefined();
    const walkthrough = detectConversions({ lead: lead(), opportunities, jobs: [job({ opportunityId: "opportunity-1", serviceType: "Walkthrough" })] }, options);
    expect(walkthrough[0]!.valueCents).toBeUndefined();
  });
  it.each([null, 0, -100, Number.NaN, 1.5])("omits unreliable or missing revenue %s while retaining valid conversion", (value) => {
    const result = detectConversions({ lead: lead(), opportunities: [opportunity({ monetaryValueCents: value })] }, options);
    expect(result[0]!.eligible).toBe(true);
    expect(result[0]!.payload?.custom_data.value).toBeUndefined();
    expect(result[0]!.payload?.custom_data.currency).toBeUndefined();
  });
  it("never substitutes a deposit for missing total revenue", () => {
    const result = detectConversions({ lead: lead(), jobs: [job({ status: "completed", appointmentId: null, priceCents: null })] }, options);
    expect(result[0]!.payload?.custom_data.value).toBeUndefined();
  });
  it("rejects unsafe revenue values", () => {
    expect(reliableRevenueCents(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(reliableRevenueCents("190000")).toBeNull();
    expect(reliableRevenueCents(190000)).toBe(190000);
  });
});

describe("logical idempotency", () => {
  it("returns the identical event ID across runs, edits and appointment identities", () => {
    expect(booking().eventId).toBe(booking({}, { id: "replacement-appointment" }).eventId);
    expect(booking().eventId).toBe(deterministicEventId("lead-1", "WALKTHROUGH_BOOKED"));
    expect(deterministicEventId("lead-1", "JOB_WON")).not.toBe(deterministicEventId("lead-1", "WALKTHROUGH_BOOKED"));
    expect(deterministicEventId("lead-2", "JOB_WON")).not.toBe(deterministicEventId("lead-1", "JOB_WON"));
  });
  it("emits one logical conversion per stage despite duplicate provider records", () => {
    const result = detectConversions({ lead: lead(), appointments: [appointment(), appointment({ id: "duplicate" })], opportunities: [opportunity(), opportunity({ id: "duplicate" })] }, options);
    expect(result).toHaveLength(2);
  });
  it("never generates payload for ineligible attribution", () => {
    expect(booking({ source: "Referral", raw: {} }).payload).toBeUndefined();
  });
});
