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
  operationalState?: string;
  intentStage?: string;
  pipeline?: string;
  nextRequiredAction?: string;
  reconciliationStatus?: string;
  supportingEvidence?: unknown[];
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

  const [messages, calls, canonicalEvents, canonicalSnapshot] = await Promise.all([
    db.select().from(schema.messages).where(eq(schema.messages.contactId, contactId)),
    db.select({call:schema.calls,transcript:schema.callTranscripts.text}).from(schema.calls).leftJoin(schema.callTranscripts,eq(schema.calls.id,schema.callTranscripts.callId)).where(eq(schema.calls.contactId,contactId)),
    db.select().from(schema.customerEvents).where(and(eq(schema.customerEvents.contactId,contactId),eq(schema.customerEvents.active,true),eq(schema.customerEvents.humanReviewNeeded,false))),
    db.select().from(schema.customerStateSnapshots).where(eq(schema.customerStateSnapshots.contactId,contactId))
  ]);
  const evidence = communicationSummary(
    messages.map(m => ({...m, at:m.occurredAt})), calls.map(c => ({...c.call, transcript:c.transcript, at:c.call.startedAt}))
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

  const eventTime=(type:string)=>canonicalEvents.filter(e=>e.eventType===type&&Number(e.confidence)>=.85).reduce<Date|null>((latest,e)=>!latest||e.occurredAt>latest?e.occurredAt:latest,null);
  const lastHumanOutreachAt=latestDate(evidence.lastHumanOutreachAt,eventTime("human_outreach"));
  const lastCustomerResponseAt=latestDate(evidence.lastCustomerResponseAt,eventTime("customer_response"),eventTime("two_way_contact"));
  const twoWayContactAt=latestDate(evidence.twoWayContactAt,eventTime("two_way_contact"));
  const richState=canonicalSnapshot[0]?.state;
  const now = Date.now();
  const conversationActive = Boolean(
    twoWayContactAt &&
    lastCustomerResponseAt &&
    lastHumanOutreachAt &&
    Math.abs(lastCustomerResponseAt.valueOf() - lastHumanOutreachAt.valueOf()) < 72 * 60 * 60 * 1000 &&
    Math.max(lastCustomerResponseAt.valueOf(), lastHumanOutreachAt.valueOf()) > now - 72 * 60 * 60 * 1000
  );

  const state = computeLeadState({
    doNotContact: lead.doNotContact || richState==="DO_NOT_CONTACT",
    lost: richState==="LOST" || (!richState && Boolean(lostOpportunity)),
    booked: richState ? ["WALKTHROUGH_VERBALLY_BOOKED","WALKTHROUGH_BOOKED","WALKTHROUGH_COMPLETED","JOB_VERBALLY_ACCEPTED","JOB_SOLD","JOB_SCHEDULED","JOB_COMPLETED","CASH_COLLECTED"].includes(richState) : Boolean(booking),
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

  if(!rows.length)return [];
  const canonical=await db.select().from(schema.customerStateSnapshots).where(inArray(schema.customerStateSnapshots.contactId,rows.map(r=>r.contactId)));
  return rows.map(row=>{
    const old=enrichLeadAuditRow(row),projection=canonical.find(c=>c.contactId===row.contactId)?.snapshot;
    if(!projection)return old;
    const state=String(projection.state),terminal=["LOST","DO_NOT_CONTACT","JOB_SOLD","JOB_SCHEDULED","JOB_COMPLETED","CASH_COLLECTED"].includes(state)||projection.pipelineDisposition==="negative_outcome";
    // A real quote or verbal commitment retains its concrete next action. Do not
    // send closed/DNC customers back into generic lead-chasing queues.
    const actionable=["NEW_LEAD","OUTREACH_ATTEMPTED","TWO_WAY_CONTACT","QUALIFIED","PRICE_EXPECTATION_ACCEPTED","VIDEO_QUOTE_PENDING_CUSTOMER","VIDEO_QUOTE_RECEIVED","VIDEO_QUOTE_IN_PROGRESS","QUOTE_DELIVERED","WALKTHROUGH_VERBALLY_BOOKED","WALKTHROUGH_COMPLETED","FOLLOW_UP_PENDING","CUSTOMER_DECIDING","JOB_VERBALLY_ACCEPTED"].includes(state);
    return {...old,operationalState:state,intentStage:String(projection.intentStage),pipeline:String(projection.pipeline),nextRequiredAction:String(projection.nextRequiredAction),reconciliationStatus:String(projection.reconciliationStatus),supportingEvidence:Array.isArray(projection.supportingEvidence)?projection.supportingEvidence:[],needsFollowUp:!terminal&&actionable,followUpReason:!terminal&&actionable?String(projection.nextRequiredAction):null};
  });
}

export async function leadsNeedingContact(days = 3): Promise<LeadAuditRow[]> {
  const rows = await recentLeadRows(days);
  return rows.filter((row) => row.needsFollowUp);
}

export async function leadsNotResponding(days = 3): Promise<LeadAuditRow[]> {
  const rows = await recentLeadRows(days);
  return rows.filter((row) =>
    !["LOST","DO_NOT_CONTACT","JOB_SOLD","JOB_SCHEDULED","JOB_COMPLETED","CASH_COLLECTED","JOB_VERBALLY_ACCEPTED","WALKTHROUGH_VERBALLY_BOOKED","WALKTHROUGH_BOOKED","VIDEO_QUOTE_RECEIVED","VIDEO_QUOTE_IN_PROGRESS","QUOTE_DELIVERED"].includes(row.operationalState??"") &&
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

  const canonical=rows.length?await db.select().from(schema.customerStateSnapshots).where(inArray(schema.customerStateSnapshots.contactId,rows.map(r=>r.contactId))):[];
  return dedupeBookingsByContactAndStart(rows).map(row=>({ ...row,canonicalCustomer:canonical.find(c=>c.contactId===row.contactId)?.snapshot??null,reportingAuthority:"canonical_operational_report_for_conversion_counts" }));
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
