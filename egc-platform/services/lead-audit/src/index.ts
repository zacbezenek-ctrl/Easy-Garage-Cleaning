import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import type { LeadState } from "@egc/schemas";

export type LeadAuditRow = {
  leadId: string;
  contactId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  state: LeadState;
  createdAt: Date;
  lastHumanOutreachAt: Date | null;
  lastCustomerResponseAt: Date | null;
};

export function computeLeadState(input: {
  doNotContact: boolean;
  lost: boolean;
  booked: boolean;
  hasCustomerResponse: boolean;
  hasHumanOutreach: boolean;
  conversationActive?: boolean;
}): LeadState {
  if (input.doNotContact) return "DO_NOT_CONTACT";
  if (input.lost) return "LOST";
  if (input.booked) return "BOOKED";
  if (input.conversationActive) return "ACTIVE_CONVERSATION";
  if (input.hasCustomerResponse) return "CUSTOMER_RESPONDED";
  if (input.hasHumanOutreach) return "OUTREACH_ATTEMPTED_NO_REPLY";
  return "NEVER_CONTACTED";
}

export async function recomputeLeadState(contactId: string): Promise<LeadState> {
  const db = getDb();
  const [lead] = await db.select().from(schema.leads).where(eq(schema.leads.contactId, contactId)).limit(1);
  if (!lead) throw new Error(`Lead not found for contact ${contactId}`);

  const [humanOutreach] = await db
    .select({ at: schema.messages.occurredAt })
    .from(schema.messages)
    .where(and(
      eq(schema.messages.contactId, contactId),
      eq(schema.messages.direction, "outbound"),
      eq(schema.messages.actorType, "human")
    ))
    .orderBy(desc(schema.messages.occurredAt))
    .limit(1);

  const [humanCall] = await db
    .select({ at: schema.calls.startedAt })
    .from(schema.calls)
    .where(and(
      eq(schema.calls.contactId, contactId),
      eq(schema.calls.direction, "outbound"),
      eq(schema.calls.actorType, "human")
    ))
    .orderBy(desc(schema.calls.startedAt))
    .limit(1);

  const [customerReply] = await db
    .select({ at: schema.messages.occurredAt })
    .from(schema.messages)
    .where(and(
      eq(schema.messages.contactId, contactId),
      eq(schema.messages.direction, "inbound"),
      eq(schema.messages.actorType, "customer")
    ))
    .orderBy(desc(schema.messages.occurredAt))
    .limit(1);

  const [booking] = await db
    .select({ at: schema.appointments.appointmentCreatedAt })
    .from(schema.appointments)
    .where(and(
      eq(schema.appointments.contactId, contactId),
      inArray(schema.appointments.status, ["new", "confirmed", "showed"])
    ))
    .orderBy(desc(schema.appointments.appointmentCreatedAt))
    .limit(1);

  const [lostOpportunity] = await db
    .select({ id: schema.opportunities.id })
    .from(schema.opportunities)
    .where(and(
      eq(schema.opportunities.contactId, contactId),
      eq(schema.opportunities.status, "lost")
    ))
    .limit(1);

  const lastHumanOutreachAt = [humanOutreach?.at, humanCall?.at]
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.valueOf() - a.valueOf())[0] ?? null;
  const lastCustomerResponseAt = customerReply?.at ?? null;

  const state = computeLeadState({
    doNotContact: lead.doNotContact,
    lost: Boolean(lostOpportunity),
    booked: Boolean(booking),
    hasCustomerResponse: Boolean(lastCustomerResponseAt),
    hasHumanOutreach: Boolean(lastHumanOutreachAt),
    conversationActive: Boolean(
      lastCustomerResponseAt &&
      lastHumanOutreachAt &&
      Math.abs(lastCustomerResponseAt.valueOf() - lastHumanOutreachAt.valueOf()) < 72 * 60 * 60 * 1000
    )
  });

  await db.update(schema.leads).set({
    currentState: state,
    lastHumanOutreachAt,
    lastCustomerResponseAt,
    firstBookedAt: booking?.at ?? lead.firstBookedAt,
    updatedAt: new Date()
  }).where(eq(schema.leads.id, lead.id));

  return state;
}

export async function leadsNeedingContact(days = 3): Promise<LeadAuditRow[]> {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  return db.select({
    leadId: schema.leads.id,
    contactId: schema.contacts.id,
    name: schema.contacts.name,
    phone: schema.contacts.phone,
    email: schema.contacts.email,
    source: schema.leads.source,
    state: schema.leads.currentState,
    createdAt: schema.leads.createdAt,
    lastHumanOutreachAt: schema.leads.lastHumanOutreachAt,
    lastCustomerResponseAt: schema.leads.lastCustomerResponseAt
  })
  .from(schema.leads)
  .innerJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id))
  .where(and(
    gte(schema.leads.createdAt, since),
    inArray(schema.leads.currentState, ["NEVER_CONTACTED", "OUTREACH_ATTEMPTED_NO_REPLY"])
  ))
  .orderBy(schema.leads.createdAt) as Promise<LeadAuditRow[]>;
}

export async function leadsNotResponding(days = 3): Promise<LeadAuditRow[]> {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  return db.select({
    leadId: schema.leads.id,
    contactId: schema.contacts.id,
    name: schema.contacts.name,
    phone: schema.contacts.phone,
    email: schema.contacts.email,
    source: schema.leads.source,
    state: schema.leads.currentState,
    createdAt: schema.leads.createdAt,
    lastHumanOutreachAt: schema.leads.lastHumanOutreachAt,
    lastCustomerResponseAt: schema.leads.lastCustomerResponseAt
  })
  .from(schema.leads)
  .innerJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id))
  .where(and(
    gte(schema.leads.createdAt, since),
    eq(schema.leads.currentState, "OUTREACH_ATTEMPTED_NO_REPLY")
  ))
  .orderBy(schema.leads.createdAt) as Promise<LeadAuditRow[]>;
}

export async function recentBookings(days = 3) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  return db.select({
    appointmentId: schema.appointments.id,
    bookingCreatedAt: schema.appointments.appointmentCreatedAt,
    appointmentStartAt: schema.appointments.appointmentStartAt,
    appointmentStatus: schema.appointments.status,
    contactId: schema.contacts.id,
    customerName: schema.contacts.name,
    phone: schema.contacts.phone,
    email: schema.contacts.email,
    source: schema.contacts.source,
    appointmentNotes: schema.appointments.notes
  })
  .from(schema.appointments)
  .innerJoin(schema.contacts, eq(schema.appointments.contactId, schema.contacts.id))
  .where(and(
    gte(schema.appointments.appointmentCreatedAt, since),
    inArray(schema.appointments.status, ["new", "confirmed", "showed"])
  ))
  .orderBy(desc(schema.appointments.appointmentCreatedAt));
}

export async function callTranscriptsForContact(contactId: string, days = 30) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  return db.select({
    callId: schema.calls.id,
    direction: schema.calls.direction,
    startedAt: schema.calls.startedAt,
    durationSeconds: schema.calls.durationSeconds,
    status: schema.calls.status,
    transcript: schema.callTranscripts.text
  })
  .from(schema.calls)
  .leftJoin(schema.callTranscripts, eq(schema.callTranscripts.callId, schema.calls.id))
  .where(and(eq(schema.calls.contactId, contactId), gte(schema.calls.startedAt, since)))
  .orderBy(desc(schema.calls.startedAt));
}
