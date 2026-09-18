import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { authorizeMcpRequest, mcpAuthenticateChallenge, oauthSecurityMetadata, registerOauthRoutes } from "./oauth.js";
import {
  callTranscriptsForContact,
  leadsNeedingContact,
  leadsNotResponding,
  recentBookings
} from "@egc/lead-audit";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value }
  };
}

const protectedToolMetadata = {
  annotations: { readOnlyHint: true, destructiveHint: false },
  ...oauthSecurityMetadata()
};

function timeZoneDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second")
  };
}

function offsetMs(date: Date, timeZone: string) {
  const p = timeZoneDateParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.valueOf();
}

function zonedMidnight(year: number, month: number, day: number, timeZone: string) {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = new Date(wallClockAsUtc);
  for (let attempt = 0; attempt < 2; attempt++) {
    guess = new Date(wallClockAsUtc - offsetMs(guess, timeZone));
  }
  return guess;
}

function tomorrowBounds(timeZone = "America/Denver") {
  const now = timeZoneDateParts(new Date(), timeZone);
  const calendarTomorrow = new Date(Date.UTC(now.year, now.month - 1, now.day + 1));
  const year = calendarTomorrow.getUTCFullYear();
  const month = calendarTomorrow.getUTCMonth() + 1;
  const day = calendarTomorrow.getUTCDate();
  const nextCalendarDay = new Date(Date.UTC(year, month - 1, day + 1));

  return {
    start: zonedMidnight(year, month, day, timeZone),
    end: zonedMidnight(
      nextCalendarDay.getUTCFullYear(),
      nextCalendarDay.getUTCMonth() + 1,
      nextCalendarDay.getUTCDate(),
      timeZone
    )
  };
}

function buildServer() {
  const server = new McpServer(
    { name: "easy-garage-cleaning", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.registerTool("contacts.search", {
    description: "Search normalized EGC contacts by name, phone, or email.",
    inputSchema: z.object({
      query: z.string().trim().max(200).default(""),
      limit: z.number().int().min(1).max(200).default(50)
    }),
    ...protectedToolMetadata
  }, async ({ query, limit }) => {
    const db = getDb();
    const base = db.select().from(schema.contacts);
    const rows = query
      ? await base.where(or(
          ilike(schema.contacts.name, `%${query}%`),
          ilike(schema.contacts.phone, `%${query}%`),
          ilike(schema.contacts.email, `%${query}%`)
        )).orderBy(desc(schema.contacts.updatedAt)).limit(limit)
      : await base.orderBy(desc(schema.contacts.updatedAt)).limit(limit);
    return textResult(rows);
  });

  server.registerTool("contacts.get", {
    description: "Get one normalized EGC contact by internal contact ID.",
    inputSchema: z.object({ contactId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ contactId }) => {
    const db = getDb();
    const [row] = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, contactId))
      .limit(1);
    return textResult(row ?? { error: "contact_not_found" });
  });

  server.registerTool("leads.search", {
    description: "Search recent leads, optionally filtered by canonical lead state.",
    inputSchema: z.object({
      state: z.enum([
        "NEVER_CONTACTED",
        "OUTREACH_ATTEMPTED_NO_REPLY",
        "CUSTOMER_RESPONDED",
        "ACTIVE_CONVERSATION",
        "BOOKED",
        "LOST",
        "DO_NOT_CONTACT"
      ]).optional(),
      days: z.number().int().min(1).max(365).default(30),
      limit: z.number().int().min(1).max(500).default(100)
    }),
    ...protectedToolMetadata
  }, async ({ state, days, limit }) => {
    const db = getDb();
    const since = new Date(Date.now() - days * 86_400_000);
    const base = db.select({
      lead: schema.leads,
      contact: schema.contacts
    })
      .from(schema.leads)
      .innerJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id));

    const rows = state
      ? await base.where(and(
          gte(schema.leads.createdAt, since),
          eq(schema.leads.currentState, state)
        )).orderBy(desc(schema.leads.createdAt)).limit(limit)
      : await base.where(gte(schema.leads.createdAt, since))
          .orderBy(desc(schema.leads.createdAt))
          .limit(limit);
    return textResult(rows);
  });

  server.registerTool("leads.get", {
    description: "Get one lead with its contact by internal lead ID.",
    inputSchema: z.object({ leadId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ leadId }) => {
    const db = getDb();
    const [row] = await db.select({
      lead: schema.leads,
      contact: schema.contacts
    })
      .from(schema.leads)
      .innerJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id))
      .where(eq(schema.leads.id, leadId))
      .limit(1);
    return textResult(row ?? { error: "lead_not_found" });
  });

  server.registerTool("conversations.search", {
    description: "Return conversations for a contact.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      limit: z.number().int().min(1).max(200).default(50)
    }),
    ...protectedToolMetadata
  }, async ({ contactId, limit }) => {
    const db = getDb();
    return textResult(await db.select().from(schema.conversations)
      .where(eq(schema.conversations.contactId, contactId))
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(limit));
  });

  server.registerTool("conversations.get", {
    description: "Get one conversation and its normalized messages.",
    inputSchema: z.object({
      conversationId: z.string().uuid(),
      messageLimit: z.number().int().min(1).max(500).default(100)
    }),
    ...protectedToolMetadata
  }, async ({ conversationId, messageLimit }) => {
    const db = getDb();
    const [conversation] = await db.select().from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .limit(1);
    if (!conversation) return textResult({ error: "conversation_not_found" });

    const messages = await db.select().from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(desc(schema.messages.occurredAt))
      .limit(messageLimit);
    return textResult({ conversation, messages });
  });

  server.registerTool("calls.search", {
    description: "Search recent normalized calls, optionally for one contact.",
    inputSchema: z.object({
      contactId: z.string().uuid().optional(),
      days: z.number().int().min(1).max(365).default(30),
      limit: z.number().int().min(1).max(500).default(100)
    }),
    ...protectedToolMetadata
  }, async ({ contactId, days, limit }) => {
    const db = getDb();
    const since = new Date(Date.now() - days * 86_400_000);
    const base = db.select({
      call: schema.calls,
      customerName: schema.contacts.name,
      phone: schema.contacts.phone
    })
      .from(schema.calls)
      .innerJoin(schema.contacts, eq(schema.calls.contactId, schema.contacts.id));
    const rows = contactId
      ? await base.where(and(
          eq(schema.calls.contactId, contactId),
          gte(schema.calls.startedAt, since)
        )).orderBy(desc(schema.calls.startedAt)).limit(limit)
      : await base.where(gte(schema.calls.startedAt, since))
          .orderBy(desc(schema.calls.startedAt))
          .limit(limit);
    return textResult(rows);
  });

  server.registerTool("calls.get", {
    description: "Get one call and its persisted transcript.",
    inputSchema: z.object({ callId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ callId }) => {
    const db = getDb();
    const [call] = await db.select().from(schema.calls)
      .where(eq(schema.calls.id, callId))
      .limit(1);
    if (!call) return textResult({ error: "call_not_found" });
    const [transcript] = await db.select().from(schema.callTranscripts)
      .where(eq(schema.callTranscripts.callId, callId))
      .limit(1);
    return textResult({ call, transcript: transcript ?? null });
  });

  server.registerTool("opportunities.search", {
    description: "Search normalized GHL opportunities by contact or status.",
    inputSchema: z.object({
      contactId: z.string().uuid().optional(),
      status: z.string().max(50).optional(),
      limit: z.number().int().min(1).max(500).default(100)
    }),
    ...protectedToolMetadata
  }, async ({ contactId, status, limit }) => {
    const db = getDb();
    const conditions = [
      ...(contactId ? [eq(schema.opportunities.contactId, contactId)] : []),
      ...(status ? [eq(schema.opportunities.status, status)] : [])
    ];
    const rows = conditions.length
      ? await db.select().from(schema.opportunities)
          .where(and(...conditions))
          .orderBy(desc(schema.opportunities.updatedAt))
          .limit(limit)
      : await db.select().from(schema.opportunities)
          .orderBy(desc(schema.opportunities.updatedAt))
          .limit(limit);
    return textResult(rows);
  });

  server.registerTool("opportunities.get", {
    description: "Get one normalized opportunity by internal ID.",
    inputSchema: z.object({ opportunityId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ opportunityId }) => {
    const db = getDb();
    const [row] = await db.select().from(schema.opportunities)
      .where(eq(schema.opportunities.id, opportunityId))
      .limit(1);
    return textResult(row ?? { error: "opportunity_not_found" });
  });

  server.registerTool("appointments.search", {
    description: "Search appointments in a relative time window, optionally for one contact.",
    inputSchema: z.object({
      contactId: z.string().uuid().optional(),
      daysPast: z.number().int().min(0).max(365).default(30),
      daysFuture: z.number().int().min(0).max(730).default(90),
      limit: z.number().int().min(1).max(500).default(200)
    }),
    ...protectedToolMetadata
  }, async ({ contactId, daysPast, daysFuture, limit }) => {
    const db = getDb();
    const start = new Date(Date.now() - daysPast * 86_400_000);
    const end = new Date(Date.now() + daysFuture * 86_400_000);
    const timeConditions = [
      gte(schema.appointments.appointmentStartAt, start),
      lt(schema.appointments.appointmentStartAt, end)
    ];
    const rows = contactId
      ? await db.select().from(schema.appointments).where(and(
          ...timeConditions,
          eq(schema.appointments.contactId, contactId)
        )).orderBy(schema.appointments.appointmentStartAt).limit(limit)
      : await db.select().from(schema.appointments).where(and(...timeConditions))
          .orderBy(schema.appointments.appointmentStartAt)
          .limit(limit);
    return textResult(rows);
  });

  server.registerTool("jobs.search", {
    description: "Search EGC jobs by contact or status.",
    inputSchema: z.object({
      contactId: z.string().uuid().optional(),
      status: z.string().max(80).optional(),
      limit: z.number().int().min(1).max(500).default(100)
    }),
    ...protectedToolMetadata
  }, async ({ contactId, status, limit }) => {
    const db = getDb();
    const conditions = [
      ...(contactId ? [eq(schema.jobs.contactId, contactId)] : []),
      ...(status ? [eq(schema.jobs.status, status)] : [])
    ];
    const rows = conditions.length
      ? await db.select().from(schema.jobs)
          .where(and(...conditions))
          .orderBy(desc(schema.jobs.updatedAt))
          .limit(limit)
      : await db.select().from(schema.jobs)
          .orderBy(desc(schema.jobs.updatedAt))
          .limit(limit);
    return textResult(rows);
  });

  server.registerTool("jobs.get", {
    description: "Get one raw normalized EGC job by internal ID.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ jobId }) => {
    const db = getDb();
    const [row] = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);
    return textResult(row ?? { error: "job_not_found" });
  });

  server.registerTool("walkthroughs.search", {
    description: "Search voice walkthroughs by contact or workflow status.",
    inputSchema: z.object({
      contactId: z.string().uuid().optional(),
      status: z.string().max(80).optional(),
      limit: z.number().int().min(1).max(500).default(100)
    }),
    ...protectedToolMetadata
  }, async ({ contactId, status, limit }) => {
    const db = getDb();
    const conditions = [
      ...(contactId ? [eq(schema.walkthroughs.contactId, contactId)] : []),
      ...(status ? [eq(schema.walkthroughs.status, status)] : [])
    ];
    const rows = conditions.length
      ? await db.select().from(schema.walkthroughs)
          .where(and(...conditions))
          .orderBy(desc(schema.walkthroughs.createdAt))
          .limit(limit)
      : await db.select().from(schema.walkthroughs)
          .orderBy(desc(schema.walkthroughs.createdAt))
          .limit(limit);
    return textResult(rows);
  });

  server.registerTool("walkthroughs.get", {
    description: "Get one voice walkthrough, including reviewed extraction.",
    inputSchema: z.object({ walkthroughId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ walkthroughId }) => {
    const db = getDb();
    const [row] = await db.select().from(schema.walkthroughs)
      .where(eq(schema.walkthroughs.id, walkthroughId))
      .limit(1);
    return textResult(row ?? { error: "walkthrough_not_found" });
  });

  server.registerTool("walkthroughs.transcript", {
    description: "Return the transcript for one voice walkthrough.",
    inputSchema: z.object({ walkthroughId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ walkthroughId }) => {
    const db = getDb();
    const [row] = await db.select({
      id: schema.walkthroughs.id,
      status: schema.walkthroughs.status,
      transcript: schema.walkthroughs.transcript
    }).from(schema.walkthroughs)
      .where(eq(schema.walkthroughs.id, walkthroughId))
      .limit(1);
    return textResult(row ?? { error: "walkthrough_not_found" });
  });

  server.registerTool("egc.leads_needing_contact", {
    description: "Return recent leads that still need human contact or human follow-up.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(3) }),
    ...protectedToolMetadata
  }, async ({ days }) => textResult(await leadsNeedingContact(days)));

  server.registerTool("egc.followups_due", {
    description: "Return recent leads that currently require human follow-up, with an explicit reason.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(3) }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    const rows = await leadsNeedingContact(days);
    return textResult(rows.map((row) => ({
      ...row,
      reason: row.state === "NEVER_CONTACTED"
        ? "No human outreach recorded"
        : "Human outreach recorded; no customer reply after the latest outreach"
    })));
  });

  server.registerTool("egc.leads_not_responding", {
    description: "Return recent leads that received human outreach but have never replied.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(3) }),
    ...protectedToolMetadata
  }, async ({ days }) => textResult(await leadsNotResponding(days)));

  server.registerTool("egc.recent_bookings", {
    description: "Return bookings created in the requested lookback window, enriched with job scope, opportunity context, recent messages, and call transcripts. Filters on booking creation time, not appointment time.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(3) }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    const db = getDb();
    const bookings = await recentBookings(days);
    const enriched = await Promise.all(bookings.map(async (booking) => {
      const [jobRows, opportunityRows, recentMessages, callTranscripts] = await Promise.all([
        db.select().from(schema.jobs)
          .where(eq(schema.jobs.contactId, booking.contactId))
          .orderBy(desc(schema.jobs.updatedAt))
          .limit(1),
        db.select({
          id: schema.opportunities.id,
          providerId: schema.opportunities.providerId,
          status: schema.opportunities.status,
          monetaryValueCents: schema.opportunities.monetaryValueCents,
          pipelineId: schema.opportunities.pipelineId,
          pipelineStageId: schema.opportunities.pipelineStageId,
          source: schema.opportunities.source,
          assignedUserId: schema.opportunities.assignedUserId,
          providerCreatedAt: schema.opportunities.providerCreatedAt,
          providerUpdatedAt: schema.opportunities.providerUpdatedAt
        }).from(schema.opportunities)
          .where(eq(schema.opportunities.contactId, booking.contactId))
          .orderBy(desc(schema.opportunities.updatedAt))
          .limit(1),
        db.select({
          type: schema.messages.type,
          direction: schema.messages.direction,
          actorType: schema.messages.actorType,
          body: schema.messages.body,
          occurredAt: schema.messages.occurredAt
        }).from(schema.messages)
          .where(eq(schema.messages.contactId, booking.contactId))
          .orderBy(desc(schema.messages.occurredAt))
          .limit(20),
        callTranscriptsForContact(booking.contactId, 30)
      ]);

      return {
        ...booking,
        job: jobRows[0] ?? null,
        opportunity: opportunityRows[0] ?? null,
        recentMessages,
        callTranscripts
      };
    }));

    return textResult(enriched);
  });

  server.registerTool("calls.transcript", {
    description: "Return persisted call transcripts for one EGC contact.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      days: z.number().int().min(1).max(365).default(30)
    }),
    ...protectedToolMetadata
  }, async ({ contactId, days }) => textResult(await callTranscriptsForContact(contactId, days)));

  server.registerTool("egc.customer_history", {
    description: "Return a unified read-only history for one customer/contact.",
    inputSchema: z.object({ contactId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ contactId }) => {
    const db = getDb();
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).limit(1);
    if (!contact) return textResult({ error: "contact_not_found" });
    const [messages, calls, appointments, opportunities, jobs] = await Promise.all([
      db.select().from(schema.messages).where(eq(schema.messages.contactId, contactId)).orderBy(desc(schema.messages.occurredAt)),
      db.select().from(schema.calls).where(eq(schema.calls.contactId, contactId)).orderBy(desc(schema.calls.startedAt)),
      db.select().from(schema.appointments).where(eq(schema.appointments.contactId, contactId)).orderBy(desc(schema.appointments.appointmentStartAt)),
      db.select().from(schema.opportunities).where(eq(schema.opportunities.contactId, contactId)).orderBy(desc(schema.opportunities.updatedAt)),
      db.select().from(schema.jobs).where(eq(schema.jobs.contactId, contactId)).orderBy(desc(schema.jobs.updatedAt))
    ]);
    return textResult({ contact, messages, calls, appointments, opportunities, jobs });
  });

  server.registerTool("egc.job_brief", {
    description: "Return job scope and notes required by a crew.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
    ...protectedToolMetadata
  }, async ({ jobId }) => {
    const db = getDb();
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
    if (!job) return textResult({ error: "job_not_found" });
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, job.contactId)).limit(1);
    const notes = await db.select().from(schema.jobNotes).where(eq(schema.jobNotes.jobId, jobId)).orderBy(schema.jobNotes.createdAt);
    return textResult({ job, customer: contact ?? null, notes });
  });


  server.registerTool("egc.tomorrows_jobs", {
    description: "Return tomorrow's scheduled appointments enriched with the latest EGC job scope for each customer.",
    inputSchema: z.object({
      timeZone: z.string().min(1).default("America/Denver")
    }),
    ...protectedToolMetadata
  }, async ({ timeZone }) => {
    const db = getDb();
    const { start, end } = tomorrowBounds(timeZone);
    const appointments = await db.select({
      appointmentId: schema.appointments.id,
      providerId: schema.appointments.providerId,
      contactId: schema.contacts.id,
      customerName: schema.contacts.name,
      phone: schema.contacts.phone,
      email: schema.contacts.email,
      startAt: schema.appointments.appointmentStartAt,
      endAt: schema.appointments.appointmentEndAt,
      status: schema.appointments.status,
      title: schema.appointments.title,
      notes: schema.appointments.notes,
      assignedUserId: schema.appointments.assignedUserId
    })
      .from(schema.appointments)
      .innerJoin(schema.contacts, eq(schema.appointments.contactId, schema.contacts.id))
      .where(and(
        gte(schema.appointments.appointmentStartAt, start),
        lt(schema.appointments.appointmentStartAt, end),
        inArray(schema.appointments.status, ["new", "confirmed", "showed"])
      ))
      .orderBy(schema.appointments.appointmentStartAt);

    const rows = await Promise.all(appointments.map(async (appointment) => {
      const [job] = await db.select().from(schema.jobs)
        .where(eq(schema.jobs.contactId, appointment.contactId))
        .orderBy(desc(schema.jobs.updatedAt))
        .limit(1);
      const notes = job
        ? await db.select().from(schema.jobNotes)
            .where(eq(schema.jobNotes.jobId, job.id))
            .orderBy(schema.jobNotes.createdAt)
        : [];
      return { ...appointment, job: job ?? null, jobNotes: notes };
    }));

    return textResult({ timeZone, start, end, appointments: rows });
  });

  server.registerTool("egc.unanswered_calls", {
    description: "Return recent inbound calls that were not answered, with customer identity.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).default(7)
    }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    const db = getDb();
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await db.select({
      callId: schema.calls.id,
      providerMessageId: schema.calls.providerMessageId,
      customerName: schema.contacts.name,
      contactId: schema.contacts.id,
      phone: schema.contacts.phone,
      startedAt: schema.calls.startedAt,
      durationSeconds: schema.calls.durationSeconds,
      status: schema.calls.status,
      answered: schema.calls.answered
    })
      .from(schema.calls)
      .innerJoin(schema.contacts, eq(schema.calls.contactId, schema.contacts.id))
      .where(and(
        eq(schema.calls.direction, "inbound"),
        eq(schema.calls.answered, false),
        gte(schema.calls.startedAt, since)
      ))
      .orderBy(desc(schema.calls.startedAt));
    return textResult(rows);
  });

  server.registerTool("egc.stale_opportunities", {
    description: "Return open opportunities that have not been updated in the requested number of days.",
    inputSchema: z.object({
      staleDays: z.number().int().min(1).max(365).default(7)
    }),
    ...protectedToolMetadata
  }, async ({ staleDays }) => {
    const db = getDb();
    const cutoff = new Date(Date.now() - staleDays * 86_400_000);
    const rows = await db.select({
      opportunityId: schema.opportunities.id,
      providerId: schema.opportunities.providerId,
      customerName: schema.contacts.name,
      contactId: schema.contacts.id,
      phone: schema.contacts.phone,
      email: schema.contacts.email,
      pipelineId: schema.opportunities.pipelineId,
      pipelineStageId: schema.opportunities.pipelineStageId,
      monetaryValueCents: schema.opportunities.monetaryValueCents,
      assignedUserId: schema.opportunities.assignedUserId,
      source: schema.opportunities.source,
      providerUpdatedAt: schema.opportunities.providerUpdatedAt,
      updatedAt: schema.opportunities.updatedAt
    })
      .from(schema.opportunities)
      .innerJoin(schema.contacts, eq(schema.opportunities.contactId, schema.contacts.id))
      .where(and(
        eq(schema.opportunities.status, "open"),
        lt(schema.opportunities.updatedAt, cutoff)
      ))
      .orderBy(schema.opportunities.updatedAt);
    return textResult(rows);
  });

  server.registerTool("egc.sales_pipeline", {
    description: "Return the current opportunity pipeline with customer identity and assignment.",
    inputSchema: z.object({
      status: z.enum(["open", "won", "lost", "abandoned", "all"]).default("open"),
      limit: z.number().int().min(1).max(500).default(200)
    }),
    ...protectedToolMetadata
  }, async ({ status, limit }) => {
    const db = getDb();
    const base = db.select({
      opportunityId: schema.opportunities.id,
      providerId: schema.opportunities.providerId,
      customerName: schema.contacts.name,
      contactId: schema.contacts.id,
      phone: schema.contacts.phone,
      email: schema.contacts.email,
      status: schema.opportunities.status,
      pipelineId: schema.opportunities.pipelineId,
      pipelineStageId: schema.opportunities.pipelineStageId,
      monetaryValueCents: schema.opportunities.monetaryValueCents,
      assignedUserId: schema.opportunities.assignedUserId,
      source: schema.opportunities.source,
      updatedAt: schema.opportunities.updatedAt
    })
      .from(schema.opportunities)
      .innerJoin(schema.contacts, eq(schema.opportunities.contactId, schema.contacts.id));

    const rows = status === "all"
      ? await base.orderBy(desc(schema.opportunities.updatedAt)).limit(limit)
      : await base.where(eq(schema.opportunities.status, status))
          .orderBy(desc(schema.opportunities.updatedAt))
          .limit(limit);

    return textResult(rows);
  });

  server.registerTool("egc.jobs_by_status", {
    description: "Return job counts grouped by EGC job status.",
    inputSchema: z.object({}),
    ...protectedToolMetadata
  }, async () => {
    const db = getDb();
    const rows = await db.select({
      status: schema.jobs.status,
      count: sql<number>`count(*)::int`
    }).from(schema.jobs).groupBy(schema.jobs.status).orderBy(schema.jobs.status);
    return textResult(rows);
  });

  server.registerTool("egc.lead_conversion_funnel", {
    description: "Return current lead counts by canonical EGC lead state.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(365).default(30)
    }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    const db = getDb();
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await db.select({
      state: schema.leads.currentState,
      count: sql<number>`count(*)::int`
    })
      .from(schema.leads)
      .where(gte(schema.leads.createdAt, since))
      .groupBy(schema.leads.currentState);

    const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
    return textResult({
      days,
      total,
      states: rows,
      bookedRate: total
        ? Number(rows.find((row) => row.state === "BOOKED")?.count ?? 0) / total
        : 0
    });
  });

  server.registerTool("egc.revenue_summary", {
    description: "Return won-opportunity value and locally priced job value for the requested lookback window.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(365).default(30)
    }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    const db = getDb();
    const since = new Date(Date.now() - days * 86_400_000);
    const [wonRows, jobRows] = await Promise.all([
      db.select({
        monetaryValueCents: schema.opportunities.monetaryValueCents
      }).from(schema.opportunities).where(and(
        eq(schema.opportunities.status, "won"),
        gte(schema.opportunities.updatedAt, since)
      )),
      db.select({
        priceCents: schema.jobs.priceCents,
        status: schema.jobs.status
      }).from(schema.jobs).where(gte(schema.jobs.updatedAt, since))
    ]);

    const wonOpportunityValueCents = wonRows.reduce(
      (sum, row) => sum + (row.monetaryValueCents ?? 0),
      0
    );
    const locallyPricedJobValueCents = jobRows.reduce(
      (sum, row) => sum + (row.priceCents ?? 0),
      0
    );

    return textResult({
      days,
      wonOpportunityCount: wonRows.length,
      wonOpportunityValueCents,
      locallyPricedJobCount: jobRows.filter((row) => row.priceCents !== null).length,
      locallyPricedJobValueCents,
      note: "Opportunity value comes from GHL. Local job pricing is only complete for jobs whose price has been populated."
    });
  });

  server.registerTool("egc.sales_rep_performance", {
    description: "Return lead assignment and booking counts by GHL user ID. This reports observed operational counts, not a subjective ranking.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(365).default(30)
    }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    const db = getDb();
    const since = new Date(Date.now() - days * 86_400_000);
    const [leadRows, bookingRows, wonRows] = await Promise.all([
      db.select({ assignedUserId: schema.leads.assignedUserId })
        .from(schema.leads)
        .where(gte(schema.leads.createdAt, since)),
      db.select({ assignedUserId: schema.appointments.assignedUserId })
        .from(schema.appointments)
        .where(and(
          gte(schema.appointments.appointmentCreatedAt, since),
          inArray(schema.appointments.status, ["new", "confirmed", "showed"])
        )),
      db.select({ assignedUserId: schema.opportunities.assignedUserId })
        .from(schema.opportunities)
        .where(and(
          eq(schema.opportunities.status, "won"),
          gte(schema.opportunities.updatedAt, since)
        ))
    ]);

    const metrics = new Map<string, { assignedLeads: number; bookings: number; wonOpportunities: number }>();
    const ensure = (id: string | null) => {
      const key = id ?? "unassigned";
      const current = metrics.get(key) ?? { assignedLeads: 0, bookings: 0, wonOpportunities: 0 };
      metrics.set(key, current);
      return current;
    };
    for (const row of leadRows) ensure(row.assignedUserId).assignedLeads += 1;
    for (const row of bookingRows) ensure(row.assignedUserId).bookings += 1;
    for (const row of wonRows) ensure(row.assignedUserId).wonOpportunities += 1;

    return textResult({
      days,
      reps: [...metrics.entries()].map(([assignedUserId, values]) => ({
        assignedUserId,
        ...values,
        bookingRate: values.assignedLeads ? values.bookings / values.assignedLeads : null,
        wonOpportunityRate: values.assignedLeads ? values.wonOpportunities / values.assignedLeads : null
      }))
    });
  });

  server.registerTool("egc.addon_attach_rates", {
    description: "Return observed add-on counts and attachment rates across locally stored jobs.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(365).default(90)
    }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    const db = getDb();
    const since = new Date(Date.now() - days * 86_400_000);
    const jobs = await db.select({
      id: schema.jobs.id,
      addOns: schema.jobs.addOns
    }).from(schema.jobs).where(gte(schema.jobs.createdAt, since));

    const counts = new Map<string, number>();
    let jobsWithAddOn = 0;
    for (const job of jobs) {
      const unique = [...new Set(job.addOns.map((value) => value.trim()).filter(Boolean))];
      if (unique.length) jobsWithAddOn += 1;
      for (const addOn of unique) counts.set(addOn, (counts.get(addOn) ?? 0) + 1);
    }

    return textResult({
      days,
      jobs: jobs.length,
      jobsWithAddOn,
      anyAddOnAttachRate: jobs.length ? jobsWithAddOn / jobs.length : 0,
      addOns: [...counts.entries()]
        .map(([addOn, count]) => ({
          addOn,
          count,
          attachRate: jobs.length ? count / jobs.length : 0
        }))
        .sort((a, b) => b.count - a.count)
    });
  });

  server.registerTool("egc.walkthrough_conversion", {
    description: "Return current walkthrough approval/job-creation completion metrics. This is not yet a sales close-rate metric.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(365).default(90)
    }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    const db = getDb();
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await db.select({
      status: schema.walkthroughs.status,
      jobId: schema.walkthroughs.jobId
    }).from(schema.walkthroughs).where(gte(schema.walkthroughs.createdAt, since));

    const approved = rows.filter((row) => row.status === "approved").length;
    const withJob = rows.filter((row) => row.jobId !== null).length;
    return textResult({
      days,
      walkthroughs: rows.length,
      approved,
      withJob,
      approvalRate: rows.length ? approved / rows.length : 0,
      jobCreationRate: rows.length ? withJob / rows.length : 0,
      note: "This measures the voice-walkthrough workflow. Sales walkthrough-to-job close rate requires mapped sales appointment types."
    });
  });

  return server;
}

const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === "production" && allowedHosts.length === 0) {
  throw new Error("MCP_ALLOWED_HOSTS is required in production");
}

const app = createMcpExpressApp({
  host: "0.0.0.0",
  ...(allowedHosts.length > 0 ? { allowedHosts } : {})
});
const handler = toNodeHandler(createMcpHandler(buildServer));
const oauth = registerOauthRoutes(app);

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "egc-mcp",
  oauth: true
}));

app.all(
  "/mcp",
  async (req, res, next) => {
    const body = req.body as { id?: string | number | null; method?: string } | undefined;

    // Keep MCP discovery unauthenticated so ChatGPT can initialize and list
    // protected tools. Authentication is enforced when a tool is invoked.
    if (body?.method !== "tools/call") {
      next();
      return;
    }

    if (await authorizeMcpRequest(req.header("authorization"))) {
      next();
      return;
    }

    const challenge = mcpAuthenticateChallenge(
      oauth.resourceMetadataUrl,
      req.header("authorization") ? "invalid_token" : "insufficient_scope"
    );

    res.status(200).json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        content: [{
          type: "text",
          text: "Authentication required: connect your Easy Garage Cleaning account to continue."
        }],
        isError: true,
        _meta: {
          "mcp/www_authenticate": [challenge]
        }
      }
    });
  },
  (req, res) => void handler(req, res, req.body)
);

const port = Number(process.env.PORT ?? process.env.MCP_PORT ?? 4200);
app.listen(port, "0.0.0.0", () => {
  console.log(`EGC MCP listening on :${port}/mcp with OAuth resource ${oauth.origin}`);
});
