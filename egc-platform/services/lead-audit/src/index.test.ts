import { describe, expect, it } from "vitest";
import { computeLeadState, dedupeBookingsByContactAndStart } from "./index.js";

describe("computeLeadState", () => {
  it("keeps do-not-contact as the highest-precedence state", () => {
    expect(computeLeadState({
      doNotContact: true,
      lost: false,
      booked: true,
      hasCustomerResponse: true,
      hasHumanOutreach: true
    })).toBe("DO_NOT_CONTACT");
  });

  it("marks lost before booked or conversation state", () => {
    expect(computeLeadState({
      doNotContact: false,
      lost: true,
      booked: true,
      hasCustomerResponse: true,
      hasHumanOutreach: true
    })).toBe("LOST");
  });

  it("marks booked leads as booked", () => {
    expect(computeLeadState({
      doNotContact: false,
      lost: false,
      booked: true,
      hasCustomerResponse: false,
      hasHumanOutreach: true
    })).toBe("BOOKED");
  });

  it("distinguishes an active conversation from a one-off response", () => {
    expect(computeLeadState({
      doNotContact: false,
      lost: false,
      booked: false,
      hasCustomerResponse: true,
      hasHumanOutreach: true,
      conversationActive: true
    })).toBe("ACTIVE_CONVERSATION");
  });

  it("keeps a customer response without an active exchange as responded", () => {
    expect(computeLeadState({
      doNotContact: false,
      lost: false,
      booked: false,
      hasCustomerResponse: true,
      hasHumanOutreach: true,
      conversationActive: false
    })).toBe("CUSTOMER_RESPONDED");
  });

  it("marks human outreach without a reply as no-reply follow-up", () => {
    expect(computeLeadState({
      doNotContact: false,
      lost: false,
      booked: false,
      hasCustomerResponse: false,
      hasHumanOutreach: true
    })).toBe("OUTREACH_ATTEMPTED_NO_REPLY");
  });

  it("marks a lead with no human outreach as never contacted", () => {
    expect(computeLeadState({
      doNotContact: false,
      lost: false,
      booked: false,
      hasCustomerResponse: false,
      hasHumanOutreach: false
    })).toBe("NEVER_CONTACTED");
  });
});


describe("dedupeBookingsByContactAndStart", () => {
  it("collapses duplicate appointment records for the same contact and start minute", () => {
    const start = new Date("2026-09-22T22:30:00.000Z");
    const rows = [
      { id: "newer", contactId: "contact-1", appointmentStartAt: start },
      { id: "duplicate", contactId: "contact-1", appointmentStartAt: new Date(start.valueOf() + 20_000) },
      { id: "different-contact", contactId: "contact-2", appointmentStartAt: start },
      { id: "different-minute", contactId: "contact-1", appointmentStartAt: new Date(start.valueOf() + 61_000) }
    ];

    expect(dedupeBookingsByContactAndStart(rows).map((row) => row.id)).toEqual([
      "newer",
      "different-contact",
      "different-minute"
    ]);
  });
});
