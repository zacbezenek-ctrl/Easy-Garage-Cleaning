import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { communicationSummary } from "./communications.js";
export { communicationSummary, callContactEvidence, isCallMessage } from "./communications.js";
import type { LeadState } from "@egc/schemas";

/** Explicit EGC validation markers only. A name containing "test" is not evidence. */
export const businessContactPredicate=()=>sql`not (${schema.contacts.tags} @> '["egc-test"]'::jsonb or lower(coalesce(${schema.contacts.source},'')) = 'egc synthetic routing validation')`;

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
  twoWayContactAt: Date | null;
  hasEverResponded: boolean;
  hasHumanOutreach: boolean;
  humanContactEstablished: boolean;
  twoWayConversationEstablished: boolean;
  lastInteractionDirection: "customer" | "human" | null;
  needsFollowUp: boolean;
  followUpReason: string | null;
};

type BaseLeadAuditRow = Omit<
  LeadAuditRow,
  | "hasEverResponded"
  | "hasHumanOutreach"
  | "humanContactEstablished"
  | "twoWayConversationEstablished"
  | "lastInteractionDirection"
  | "needsFollowUp"
  | "followUpReason"
>;

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

function latestDate(...values: Array<Date | null | undefined>) {
  return values
    .filter((value): value is Date => Boolean(value))
    .sort((a, b) => b.valueOf() - a.valueOf())[0] ?? null;
}

function enrichLeadAuditRow(row: BaseLeadAuditRow): LeadAuditRow {
  const terminal = row.state === "BOOKED" || row.state === "LOST" || row.state === "DO_NOT_CONTACT";
  const hasHumanOutreach = Boolean(row.lastHumanOutreachAt);
  const hasEverResponded = Boolean(row.lastCustomerResponseAt);
  const twoWayConversationEstablished = Boolean(row.twoWayContactAt);

  let lastInteractionDirection: "customer" | "human" | null = null;
  if (row.lastCustomerResponseAt || row.lastHumanOutreachAt) {
    lastInteractionDirection =
      (row.lastCustomerResponseAt?.valueOf() ?? -1) >=
      (row.lastHumanOutreachAt?.valueOf() ?? -1)
        ? "customer"
        : "human";
  }

  const needsFollowUp = !terminal && (
    !row.lastHumanOutreachAt ||
    !row.lastCustomerResponseAt ||
    row.lastHumanOutreachAt.valueOf() !== row.lastCustomerResponseAt.valueOf()
  );

  let followUpReason: string | null = null;
  if (needsFollowUp) {
    if (!row.lastHumanOutreachAt && row.lastCustomerResponseAt) {
      followUpReason = "Customer reached out; no human outreach recorded";
    } else if (!row.lastHumanOutreachAt) {
      followUpReason = "No human outreach recorded";
    } else if (!row.lastCustomerResponseAt) {
      followUpReason = "Human outreach recorded; customer has never responded";
    } else if (lastInteractionDirection === "customer") {
      followUpReason = "Latest customer reply awaits EGC review";
    } else {
      followUpReason = "Customer previously responded, but the latest human outreach is awaiting a reply";
    }
  }

  return {
    ...row,
    hasEverResponded,
    hasHumanOutreach,
    humanContactEstablished: twoWayConversationEstablished,
    twoWayConversationEstablished,
    lastInteractionDirection,
    needsFollowUp,
    followUpReason
  };
}

export async function recomputeLeadState(contactId: string): Promise<LeadState> {
  const db = getDb();
  const [lead] = await db.select().from(schema.leads)
    .where(eq(schema.leads.contactId, contactId)).limit(1);
  if (!lead) throw new Error(`Lead not found for contact ${contactId}`);

  const [messages, calls] = await Promise.all([
    db.select().from(schema.messages).where(eq(schema.messages.contactId, contactId)),
    db.select().from(schema.calls).where(eq(schema.calls.contactId, contactId))
  ]);
  const evidence = communicationSummary(
    messages.map(m => ({...m, at:m.occurredAt})), calls.map(c => ({...c, at:c.startedAt}))
  );
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

  const {lastHumanOutreachAt, lastCustomerResponseAt, twoWayContactAt} = evidence;
  const now = Date.now();
  const conversationActive = Boolean(
    twoWayContactAt &&
    lastCustomerResponseAt &&
    lastHumanOutreachAt &&
    Math.abs(lastCustomerResponseAt.valueOf() - lastHumanOutreachAt.valueOf()) < 72 * 60 * 60 * 1000 &&
    Math.max(lastCustomerResponseAt.valueOf(), lastHumanOutreachAt.valueOf()) > now - 72 * 60 * 60 * 1000
  );

  const state = computeLeadState({
    doNotContact: lead.doNotContact,
    lost: Boolean(lostOpportunity),
    booked: Boolean(booking),
    hasCustomerResponse: Boolean(lastCustomerResponseAt),
    hasHumanOutreach: Boolean(lastHumanOutreachAt),
    conversationActive
  });

  await db.update(schema.leads).set({
    currentState: state,
    lastHumanOutreachAt,
    lastCustomerResponseAt,
    twoWayContactAt,
    firstBookedAt: booking?.at ?? lead.firstBookedAt,
    updatedAt: new Date()
  }).where(eq(schema.leads.id, lead.id));

  return state;
}

async function recentLeadRows(days: number): Promise<LeadAuditRow[]> {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.select({
    leadId: schema.leads.id,
    contactId: schema.contacts.id,
    name: schema.contacts.name,
    phone: schema.contacts.phone,
    email: schema.contacts.email,
    source: schema.leads.source,
    state: schema.leads.currentState,
    createdAt: schema.leads.createdAt,
    lastHumanOutreachAt: schema.leads.lastHumanOutreachAt,
    lastCustomerResponseAt: schema.leads.lastCustomerResponseAt,
    twoWayContactAt: schema.leads.twoWayContactAt
  })
  .from(schema.leads)
  .innerJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id))
  .where(and(gte(schema.leads.createdAt, since),businessContactPredicate()))
  .orderBy(schema.leads.createdAt) as BaseLeadAuditRow[];

  return rows.map(enrichLeadAuditRow);
}

export async function leadsNeedingContact(days = 3): Promise<LeadAuditRow[]> {
  const rows = await recentLeadRows(days);
  return rows.filter((row) => row.needsFollowUp);
}

export async function leadsNotResponding(days = 3): Promise<LeadAuditRow[]> {
  const rows = await recentLeadRows(days);
  return rows.filter((row) =>
    row.state !== "BOOKED" &&
    row.state !== "LOST" &&
    row.state !== "DO_NOT_CONTACT" &&
    Boolean(row.lastHumanOutreachAt) &&
    !row.lastCustomerResponseAt
  );
}

export function dedupeBookingsByContactAndStart<T extends {
  contactId: string;
  appointmentStartAt: Date;
}>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const row of rows) {
    const startMinute = Math.floor(row.appointmentStartAt.valueOf() / 60_000);
    const key = `${row.contactId}:${startMinute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

export async function recentBookings(days = 3) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.select({
    appointmentId: schema.appointments.id,
    bookingCreatedAt: schema.appointments.appointmentCreatedAt,
    appointmentStartAt: schema.appointments.appointmentStartAt,
    appointmentStatus: schema.appointments.status,
    calendarId: schema.appointments.calendarId,
    assignedUserId: schema.appointments.assignedUserId,
    appointmentTitle: schema.appointments.title,
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

  return dedupeBookingsByContactAndStart(rows);
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
