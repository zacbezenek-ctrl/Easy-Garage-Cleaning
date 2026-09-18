import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";

async function providerNames(resourceTypes: string[]) {
  const db = getDb();
  const rows = await db.select({
    resourceType: schema.providerMappings.resourceType,
    providerId: schema.providerMappings.providerId,
    displayName: schema.providerMappings.displayName
  }).from(schema.providerMappings)
    .where(inArray(schema.providerMappings.resourceType, resourceTypes));

  return new Map(
    rows.map((row) => [
      `${row.resourceType}:${row.providerId}`,
      row.displayName ?? row.providerId
    ])
  );
}

function providerName(
  mappings: Map<string, string>,
  resourceType: string,
  providerId: string | null | undefined
) {
  if (!providerId) return null;
  return mappings.get(`${resourceType}:${providerId}`) ?? providerId;
}

export async function getDashboardData() {
  const db = getDb();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const now = new Date();
  const nextWeek = new Date(Date.now() + 7 * 86_400_000);

  const [leadStates, upcomingAppointments, jobs, walkthroughs] = await Promise.all([
    db.select({
      state: schema.leads.currentState,
      count: sql<number>`count(*)::int`
    }).from(schema.leads)
      .where(gte(schema.leads.createdAt, since))
      .groupBy(schema.leads.currentState),
    db.select({ count: sql<number>`count(*)::int` })
      .from(schema.appointments)
      .where(and(
        gte(schema.appointments.appointmentStartAt, now),
        lt(schema.appointments.appointmentStartAt, nextWeek),
        inArray(schema.appointments.status, ["new", "confirmed"])
      )),
    db.select({ count: sql<number>`count(*)::int` }).from(schema.jobs),
    db.select({ count: sql<number>`count(*)::int` }).from(schema.walkthroughs)
  ]);

  const followups = leadStates
    .filter((row) => ["NEVER_CONTACTED", "OUTREACH_ATTEMPTED_NO_REPLY"].includes(row.state))
    .reduce((sum, row) => sum + Number(row.count), 0);
  const booked = Number(leadStates.find((row) => row.state === "BOOKED")?.count ?? 0);
  const totalLeads = leadStates.reduce((sum, row) => sum + Number(row.count), 0);

  return {
    leadStates,
    totalLeads,
    booked,
    followups,
    upcomingAppointments: Number(upcomingAppointments[0]?.count ?? 0),
    jobs: Number(jobs[0]?.count ?? 0),
    walkthroughs: Number(walkthroughs[0]?.count ?? 0)
  };
}

export async function getLeads(limit = 200) {
  const db = getDb();
  return db.select({
    lead: schema.leads,
    contact: schema.contacts
  }).from(schema.leads)
    .innerJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id))
    .orderBy(desc(schema.leads.createdAt))
    .limit(limit);
}

export async function getFollowups(limit = 200) {
  const db = getDb();
  return db.select({
    lead: schema.leads,
    contact: schema.contacts
  }).from(schema.leads)
    .innerJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id))
    .where(inArray(schema.leads.currentState, [
      "NEVER_CONTACTED",
      "OUTREACH_ATTEMPTED_NO_REPLY"
    ]))
    .orderBy(schema.leads.createdAt)
    .limit(limit);
}

export async function getCustomers(limit = 200) {
  const db = getDb();
  return db.select().from(schema.contacts)
    .orderBy(desc(schema.contacts.updatedAt))
    .limit(limit);
}

export async function getJobs(limit = 200) {
  const db = getDb();
  return db.select({
    job: schema.jobs,
    contact: schema.contacts
  }).from(schema.jobs)
    .innerJoin(schema.contacts, eq(schema.jobs.contactId, schema.contacts.id))
    .orderBy(desc(schema.jobs.updatedAt))
    .limit(limit);
}

export async function getPipeline(limit = 250) {
  const db = getDb();
  const [rows, mappings] = await Promise.all([
    db.select({
      opportunity: schema.opportunities,
      contact: schema.contacts
    }).from(schema.opportunities)
      .innerJoin(schema.contacts, eq(schema.opportunities.contactId, schema.contacts.id))
      .orderBy(desc(schema.opportunities.updatedAt))
      .limit(limit),
    providerNames(["pipeline", "pipeline_stage", "user"])
  ]);

  return rows.map((row) => ({
    ...row,
    pipelineName: providerName(mappings, "pipeline", row.opportunity.pipelineId),
    pipelineStageName: providerName(mappings, "pipeline_stage", row.opportunity.pipelineStageId),
    assignedUserName: providerName(mappings, "user", row.opportunity.assignedUserId)
  }));
}

export async function getWalkthroughs(limit = 200) {
  const db = getDb();
  return db.select({
    walkthrough: schema.walkthroughs,
    contact: schema.contacts
  }).from(schema.walkthroughs)
    .innerJoin(schema.contacts, eq(schema.walkthroughs.contactId, schema.contacts.id))
    .orderBy(desc(schema.walkthroughs.createdAt))
    .limit(limit);
}

export async function getAnalytics() {
  const db = getDb();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [leadStates, opportunities, jobStates, bookings] = await Promise.all([
    db.select({
      state: schema.leads.currentState,
      count: sql<number>`count(*)::int`
    }).from(schema.leads)
      .where(gte(schema.leads.createdAt, since))
      .groupBy(schema.leads.currentState),
    db.select({
      status: schema.opportunities.status,
      monetaryValueCents: schema.opportunities.monetaryValueCents
    }).from(schema.opportunities),
    db.select({
      status: schema.jobs.status,
      count: sql<number>`count(*)::int`
    }).from(schema.jobs)
      .groupBy(schema.jobs.status),
    db.select({ count: sql<number>`count(*)::int` })
      .from(schema.appointments)
      .where(and(
        gte(schema.appointments.appointmentCreatedAt, since),
        inArray(schema.appointments.status, ["new", "confirmed", "showed"])
      ))
  ]);

  const opportunityMap = new Map<string, { count: number; valueCents: number }>();
  for (const row of opportunities) {
    const key = row.status ?? "unknown";
    const current = opportunityMap.get(key) ?? { count: 0, valueCents: 0 };
    current.count += 1;
    current.valueCents += row.monetaryValueCents ?? 0;
    opportunityMap.set(key, current);
  }

  const totalLeads = leadStates.reduce((sum, row) => sum + Number(row.count), 0);
  const bookedLeads = Number(leadStates.find((row) => row.state === "BOOKED")?.count ?? 0);

  return {
    leadStates,
    opportunityStates: [...opportunityMap.entries()].map(([status, values]) => ({ status, ...values })),
    jobStates,
    bookings: Number(bookings[0]?.count ?? 0),
    totalLeads,
    bookedLeads,
    bookedLeadRate: totalLeads ? bookedLeads / totalLeads : 0
  };
}

export async function getLeadDetail(leadId: string) {
  const db = getDb();
  const [row] = await db.select({
    lead: schema.leads,
    contact: schema.contacts
  }).from(schema.leads)
    .innerJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id))
    .where(eq(schema.leads.id, leadId))
    .limit(1);
  if (!row) return null;

  const [messages, calls, appointments, opportunities] = await Promise.all([
    db.select().from(schema.messages)
      .where(eq(schema.messages.contactId, row.contact.id))
      .orderBy(desc(schema.messages.occurredAt))
      .limit(50),
    db.select().from(schema.calls)
      .where(eq(schema.calls.contactId, row.contact.id))
      .orderBy(desc(schema.calls.startedAt))
      .limit(25),
    db.select().from(schema.appointments)
      .where(eq(schema.appointments.contactId, row.contact.id))
      .orderBy(desc(schema.appointments.appointmentStartAt)),
    db.select().from(schema.opportunities)
      .where(eq(schema.opportunities.contactId, row.contact.id))
      .orderBy(desc(schema.opportunities.updatedAt))
  ]);

  return { ...row, messages, calls, appointments, opportunities };
}

export async function getCustomerDetail(contactId: string) {
  const db = getDb();
  const [contact] = await db.select().from(schema.contacts)
    .where(eq(schema.contacts.id, contactId))
    .limit(1);
  if (!contact) return null;

  const [lead, messages, calls, appointments, opportunities, jobs, walkthroughs] = await Promise.all([
    db.select().from(schema.leads).where(eq(schema.leads.contactId, contactId)).limit(1),
    db.select().from(schema.messages).where(eq(schema.messages.contactId, contactId)).orderBy(desc(schema.messages.occurredAt)).limit(50),
    db.select().from(schema.calls).where(eq(schema.calls.contactId, contactId)).orderBy(desc(schema.calls.startedAt)).limit(25),
    db.select().from(schema.appointments).where(eq(schema.appointments.contactId, contactId)).orderBy(desc(schema.appointments.appointmentStartAt)),
    db.select().from(schema.opportunities).where(eq(schema.opportunities.contactId, contactId)).orderBy(desc(schema.opportunities.updatedAt)),
    db.select().from(schema.jobs).where(eq(schema.jobs.contactId, contactId)).orderBy(desc(schema.jobs.updatedAt)),
    db.select().from(schema.walkthroughs).where(eq(schema.walkthroughs.contactId, contactId)).orderBy(desc(schema.walkthroughs.createdAt))
  ]);

  return {
    contact,
    lead: lead[0] ?? null,
    messages,
    calls,
    appointments,
    opportunities,
    jobs,
    walkthroughs
  };
}

export async function getJobDetail(jobId: string) {
  const db = getDb();
  const [job] = await db.select().from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);
  if (!job) return null;

  const [contact, notes, walkthroughs] = await Promise.all([
    db.select().from(schema.contacts).where(eq(schema.contacts.id, job.contactId)).limit(1),
    db.select().from(schema.jobNotes).where(eq(schema.jobNotes.jobId, jobId)).orderBy(schema.jobNotes.createdAt),
    db.select().from(schema.walkthroughs).where(eq(schema.walkthroughs.jobId, jobId)).orderBy(desc(schema.walkthroughs.createdAt))
  ]);

  return { job, contact: contact[0] ?? null, notes, walkthroughs };
}
