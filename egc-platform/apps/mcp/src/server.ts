import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { walkthroughExtractionSchema } from "@egc/schemas";
import { GhlClient, asDate, asRecord, asString, findArray } from "@egc/ghl";
import { authorizeMcpRequest, mcpAuthenticateChallenge, oauthSecurityMetadata, READ_SCOPE, registerOauthRoutes, WRITE_SCOPE } from "./oauth.js";
import {
  callTranscriptsForContact,
  leadsNeedingContact,
  leadsNotResponding,
  recentBookings,
  recomputeLeadState
} from "@egc/lead-audit";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value }
  };
}

const protectedToolMetadata = {
  annotations: { readOnlyHint: true, destructiveHint: false },
  ...oauthSecurityMetadata([READ_SCOPE])
};

const writeToolMetadata = {
  annotations: { readOnlyHint: false, destructiveHint: false },
  ...oauthSecurityMetadata([READ_SCOPE, WRITE_SCOPE])
};

const destructiveWriteToolMetadata = {
  annotations: { readOnlyHint: false, destructiveHint: true },
  ...oauthSecurityMetadata([READ_SCOPE, WRITE_SCOPE])
};

const WRITE_TOOLS = new Set([
  "jobs.create",
  "jobs.update",
  "jobs.add_note",
  "walkthroughs.create_draft",
  "walkthroughs.update_draft",
  "walkthroughs.approve",
  "contacts.create",
  "contacts.update",
  "contacts.add_tags",
  "contacts.remove_tags",
  "opportunities.create",
  "opportunities.update",
  "appointments.create",
  "appointments.update",
  "appointments.cancel",
  "appointments.delete",
  "conversations.send_message",
  "send_sms"
]);

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

const isoDateTimeSchema = z.string().datetime({ offset: true });

const jobMutationSchema = z.object({
  status: z.string().min(1).max(80).optional(),
  serviceAddress: z.string().max(500).nullable().optional(),
  garageSize: z.string().max(80).nullable().optional(),
  serviceType: z.string().max(120).nullable().optional(),
  junkVolumeYards: z.number().min(0).nullable().optional(),
  itemsRemove: z.array(z.string().max(500)).optional(),
  itemsKeep: z.array(z.string().max(500)).optional(),
  itemsRelocate: z.array(z.string().max(500)).optional(),
  organizationRequirements: z.array(z.string().max(500)).optional(),
  addOns: z.array(z.string().max(500)).optional(),
  accessNotes: z.string().max(5000).nullable().optional(),
  estimatedLaborHours: z.number().min(0).nullable().optional(),
  scheduledAt: isoDateTimeSchema.nullable().optional(),
  priceCents: z.number().int().min(0).nullable().optional(),
  depositCents: z.number().int().min(0).nullable().optional()
});

const contactMutationSchema = z.object({
  firstName: z.string().max(200).nullable().optional(),
  lastName: z.string().max(200).nullable().optional(),
  name: z.string().max(300).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(80).nullable().optional(),
  address1: z.string().max(500).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  postalCode: z.string().max(30).optional(),
  timezone: z.string().max(120).nullable().optional(),
  source: z.string().max(200).nullable().optional(),
  country: z.string().max(2).optional(),
  assignedTo: z.string().max(100).nullable().optional(),
  tags: z.array(z.string().max(200)).optional(),
  customFields: z.array(z.record(z.string(), z.unknown())).optional()
});

const opportunityMutationSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  pipelineId: z.string().min(1).max(200).optional(),
  pipelineStageId: z.string().min(1).max(200).optional(),
  status: z.enum(["open", "won", "lost", "abandoned"]).optional(),
  monetaryValueCents: z.number().int().min(0).nullable().optional(),
  assignedTo: z.string().max(200).nullable().optional(),
  forecastExpectedCloseDate: z.string().max(100).nullable().optional(),
  forecastProbability: z.number().min(0).max(100).nullable().optional(),
  customFields: z.array(z.record(z.string(), z.unknown())).optional()
});

const appointmentMutationSchema = z.object({
  title: z.string().max(500).optional(),
  calendarId: z.string().min(1).max(200).optional(),
  assignedUserId: z.string().max(200).nullable().optional(),
  appointmentStatus: z.enum([
    "new", "confirmed", "cancelled", "showed", "noshow", "invalid", "completed", "active"
  ]).optional(),
  description: z.string().max(5000).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  startTime: isoDateTimeSchema.optional(),
  endTime: isoDateTimeSchema.nullable().optional(),
  runAutomations: z.boolean().default(false),
  ignoreDateRange: z.boolean().default(false),
  ignoreFreeSlotValidation: z.boolean().default(false)
});

function ghlClient() {
  return GhlClient.fromEnv();
}

function unwrapRecord(payload: Record<string, unknown>, key: string) {
  const nested = asRecord(payload[key]);
  return Object.keys(nested).length ? nested : payload;
}

function normalizeLocalAppointmentStatus(value: unknown):
  "new" | "confirmed" | "cancelled" | "showed" | "noshow" | "invalid" {
  const s = asString(value)?.toLowerCase();
  if (s === "confirmed" || s === "active") return "confirmed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "showed" || s === "completed") return "showed";
  if (s === "noshow" || s === "no_show" || s === "no-show") return "noshow";
  if (s === "invalid") return "invalid";
  return "new";
}

async function syncContactFromGhl(
  payload: Record<string, unknown>,
  localId?: string
) {
  const db = getDb();
  const raw = unwrapRecord(payload, "contact");
  const providerId = asString(raw.id);
  if (!providerId) throw new Error("ghl_contact_missing_id");

  const composedName = [asString(raw.firstName), asString(raw.lastName)]
    .filter(Boolean)
    .join(" ");

  const values = {
    provider: "ghl",
    providerId,
    locationId: asString(raw.locationId) ?? ghlClient().locationId,
    firstName: asString(raw.firstName) ?? null,
    lastName: asString(raw.lastName) ?? null,
    name: asString(raw.contactName) ?? asString(raw.name) ?? (composedName || null),
    email: asString(raw.email) ?? null,
    phone: asString(raw.phone) ?? null,
    source: asString(raw.source) ?? null,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((value): value is string => typeof value === "string")
      : [],
    customFields: Array.isArray(raw.customFields) ? raw.customFields : [],
    raw,
    providerCreatedAt: asDate(raw.dateAdded) ?? asDate(raw.createdAt) ?? null,
    providerUpdatedAt: asDate(raw.dateUpdated) ?? asDate(raw.updatedAt) ?? null,
    updatedAt: new Date()
  };

  let contact;
  if (localId) {
    [contact] = await db.update(schema.contacts)
      .set(values)
      .where(eq(schema.contacts.id, localId))
      .returning();
  } else {
    [contact] = await db.insert(schema.contacts).values(values)
      .onConflictDoUpdate({
        target: [schema.contacts.provider, schema.contacts.providerId],
        set: values
      })
      .returning();
  }

  if (!contact) throw new Error("local_contact_sync_failed");

  await db.insert(schema.leads).values({
    contactId: contact.id,
    source: contact.source,
    createdAt: contact.providerCreatedAt ?? new Date()
  }).onConflictDoNothing({ target: schema.leads.contactId });

  return contact;
}

async function syncOpportunityFromGhl(
  payload: Record<string, unknown>,
  contactId: string,
  existingLocalId?: string
) {
  const db = getDb();
  const raw = unwrapRecord(payload, "opportunity");
  const providerId = asString(raw.id);
  if (!providerId) throw new Error("ghl_opportunity_missing_id");

  const money = typeof raw.monetaryValue === "number"
    ? raw.monetaryValue
    : Number(raw.monetaryValue);

  const values = {
    providerId,
    contactId,
    pipelineId: asString(raw.pipelineId) ?? null,
    pipelineStageId: asString(raw.pipelineStageId) ?? null,
    status: asString(raw.status) ?? null,
    monetaryValueCents: Number.isFinite(money) ? Math.round(money * 100) : null,
    assignedUserId: asString(raw.assignedTo) ?? asString(raw.assignedUserId) ?? null,
    source: asString(raw.source) ?? null,
    raw,
    providerCreatedAt: asDate(raw.dateAdded) ?? asDate(raw.createdAt) ?? null,
    providerUpdatedAt: asDate(raw.dateUpdated) ?? asDate(raw.updatedAt) ?? null,
    updatedAt: new Date()
  };

  let opportunity;
  if (existingLocalId) {
    [opportunity] = await db.update(schema.opportunities)
      .set(values)
      .where(eq(schema.opportunities.id, existingLocalId))
      .returning();
  } else {
    [opportunity] = await db.insert(schema.opportunities).values(values)
      .onConflictDoUpdate({
        target: schema.opportunities.providerId,
        set: values
      })
      .returning();
  }

  if (!opportunity) throw new Error("local_opportunity_sync_failed");
  await recomputeLeadState(contactId);
  return opportunity;
}

async function syncAppointmentFromGhl(
  payload: Record<string, unknown>,
  contactId: string,
  existingLocalId?: string
) {
  const db = getDb();
  const raw = unwrapRecord(payload, "event");
  const providerId = asString(raw.id);
  const startAt = asDate(raw.startTime);
  if (!providerId || !startAt) throw new Error("ghl_appointment_missing_required_fields");

  const existing = existingLocalId
    ? (await db.select().from(schema.appointments)
        .where(eq(schema.appointments.id, existingLocalId))
        .limit(1))[0]
    : undefined;

  const values = {
    providerId,
    contactId,
    calendarId: asString(raw.calendarId) ?? existing?.calendarId ?? null,
    assignedUserId: asString(raw.assignedUserId) ?? existing?.assignedUserId ?? null,
    title: asString(raw.title) ?? existing?.title ?? null,
    status: normalizeLocalAppointmentStatus(raw.appointmentStatus ?? raw.status),
    appointmentCreatedAt:
      asDate(raw.dateAdded) ??
      asDate(raw.createdAt) ??
      existing?.appointmentCreatedAt ??
      null,
    appointmentStartAt: startAt,
    appointmentEndAt: asDate(raw.endTime) ?? null,
    notes: asString(raw.notes) ?? asString(raw.description) ?? null,
    raw,
    updatedAt: new Date()
  };

  let appointment;
  if (existingLocalId) {
    [appointment] = await db.update(schema.appointments)
      .set(values)
      .where(eq(schema.appointments.id, existingLocalId))
      .returning();
  } else {
    [appointment] = await db.insert(schema.appointments).values(values)
      .onConflictDoUpdate({
        target: schema.appointments.providerId,
        set: values
      })
      .returning();
  }

  if (!appointment) throw new Error("local_appointment_sync_failed");
  await recomputeLeadState(contactId);
  return appointment;
}

function normalizedComparableText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titlesEquivalent(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizedComparableText(a);
  const right = normalizedComparableText(b);
  if (!left || !right) return true;
  return left === right || left.includes(right) || right.includes(left);
}

async function findEquivalentLocalAppointment(input: {
  contactId: string;
  calendarId: string;
  startAt: Date;
  title?: string | undefined;
}) {
  const db = getDb();
  const toleranceMs = 90_000;
  const rows = await db.select().from(schema.appointments)
    .where(and(
      eq(schema.appointments.contactId, input.contactId),
      eq(schema.appointments.calendarId, input.calendarId),
      gte(schema.appointments.appointmentStartAt, new Date(input.startAt.valueOf() - toleranceMs)),
      lte(schema.appointments.appointmentStartAt, new Date(input.startAt.valueOf() + toleranceMs))
    ))
    .orderBy(desc(schema.appointments.updatedAt))
    .limit(10);

  return rows.find((row) => titlesEquivalent(row.title, input.title)) ?? null;
}

async function findEquivalentRemoteAppointment(input: {
  contactProviderId: string;
  calendarId: string;
  startAt: Date;
  title?: string | undefined;
}) {
  const toleranceMs = 5 * 60_000;
  const payload = await ghlClient().getCalendarEvents({
    calendarId: input.calendarId,
    startTime: input.startAt.valueOf() - toleranceMs,
    endTime: input.startAt.valueOf() + toleranceMs
  });
  const events = findArray(payload, "events");

  for (const value of events) {
    const event = asRecord(value);
    const eventStart = asDate(event.startTime);
    const eventContactId = asString(event.contactId);
    const eventCalendarId = asString(event.calendarId) ?? input.calendarId;
    if (!eventStart || !eventContactId) continue;
    if (eventContactId !== input.contactProviderId) continue;
    if (eventCalendarId !== input.calendarId) continue;
    if (Math.abs(eventStart.valueOf() - input.startAt.valueOf()) > 90_000) continue;
    if (!titlesEquivalent(asString(event.title), input.title)) continue;
    return event;
  }

  return null;
}

async function persistOutboundMessage(input: {
  contactId: string;
  contactProviderId: string;
  channel: "SMS" | "Email";
  body: string;
  providerMessageId: string;
  conversationProviderId: string;
  providerPayload: Record<string, unknown>;
  occurredAt?: Date;
}) {
  const db = getDb();
  const occurredAt = input.occurredAt ?? new Date();

  const [conversation] = await db.insert(schema.conversations).values({
    providerId: input.conversationProviderId,
    contactId: input.contactId,
    raw: {
      id: input.conversationProviderId,
      contactId: input.contactProviderId,
      locationId: ghlClient().locationId
    }
  }).onConflictDoUpdate({
    target: schema.conversations.providerId,
    set: {
      contactId: input.contactId,
      raw: {
        id: input.conversationProviderId,
        contactId: input.contactProviderId,
        locationId: ghlClient().locationId
      },
      updatedAt: new Date()
    }
  }).returning();

  await db.insert(schema.messages).values({
    providerId: input.providerMessageId,
    conversationId: conversation?.id ?? null,
    contactId: input.contactId,
    type: input.channel === "SMS" ? "TYPE_SMS" : "TYPE_EMAIL",
    direction: "outbound",
    actorType: "human",
    body: input.body,
    occurredAt,
    raw: input.providerPayload
  }).onConflictDoUpdate({
    target: schema.messages.providerId,
    set: {
      conversationId: conversation?.id ?? null,
      contactId: input.contactId,
      type: input.channel === "SMS" ? "TYPE_SMS" : "TYPE_EMAIL",
      direction: "outbound",
      actorType: "human",
      body: input.body,
      occurredAt,
      raw: input.providerPayload,
      updatedAt: new Date()
    }
  });

  await recomputeLeadState(input.contactId);
}

async function findRecentDuplicateOutbound(input: {
  contactId: string;
  body: string;
  channel: "SMS" | "Email";
  withinMinutes: number;
}) {
  const db = getDb();
  const since = new Date(Date.now() - input.withinMinutes * 60_000);
  const rows = await db.select().from(schema.messages)
    .where(and(
      eq(schema.messages.contactId, input.contactId),
      eq(schema.messages.direction, "outbound"),
      eq(schema.messages.actorType, "human"),
      gte(schema.messages.occurredAt, since)
    ))
    .orderBy(desc(schema.messages.occurredAt))
    .limit(30);

  const expectedType = input.channel === "SMS" ? "sms" : "email";
  return rows.find((row) =>
    normalizedComparableText(row.body) === normalizedComparableText(input.body) &&
    row.type.toLowerCase().includes(expectedType)
  ) ?? null;
}

async function recoverRecentProviderMessage(input: {
  contactProviderId: string;
  body: string;
  channel: "SMS" | "Email";
}) {
  const conversationsPayload = await ghlClient().searchConversations({
    contactId: input.contactProviderId
  });
  const conversations = findArray(conversationsPayload, "conversations");
  const since = Date.now() - 10 * 60_000;

  for (const rawConversation of conversations.slice(0, 5)) {
    const conversation = asRecord(rawConversation);
    const conversationId = asString(conversation.id);
    if (!conversationId) continue;

    const messagesPayload = await ghlClient().getConversationMessages(conversationId, { limit: 50 });
    const messages = findArray(messagesPayload, "messages");

    for (const rawMessage of messages) {
      const message = asRecord(rawMessage);
      const id = asString(message.id);
      const occurredAt = asDate(message.dateAdded) ?? asDate(message.createdAt);
      const direction = asString(message.direction)?.toLowerCase();
      const body = asString(message.body) ?? asString(message.message) ?? "";
      const messageType =
        (asString(message.messageType) ?? asString(message.type) ?? "").toLowerCase();

      if (!id || !occurredAt || occurredAt.valueOf() < since) continue;
      if (direction !== "outbound") continue;
      if (normalizedComparableText(body) !== normalizedComparableText(input.body)) continue;
      if (!messageType.includes(input.channel.toLowerCase())) continue;

      return {
        messageId: id,
        conversationId,
        occurredAt,
        message
      };
    }
  }

  return null;
}

async function sendConversationMessage(input: {
  contactId: string;
  channel: "SMS" | "Email";
  body: string;
  subject?: string | undefined;
  emailFrom?: string | undefined;
  emailTo?: string | undefined;
  fromNumber?: string | undefined;
  toNumber?: string | undefined;
  duplicateWindowMinutes?: number;
}) {
  const db = getDb();
  const [contact] = await db.select().from(schema.contacts)
    .where(eq(schema.contacts.id, input.contactId))
    .limit(1);
  if (!contact) return { ok: false as const, error: "contact_not_found" };

  const duplicate = await findRecentDuplicateOutbound({
    contactId: input.contactId,
    body: input.body,
    channel: input.channel,
    withinMinutes: input.duplicateWindowMinutes ?? 10
  });
  if (duplicate) {
    return {
      ok: true as const,
      duplicatePrevented: true,
      message: duplicate
    };
  }

  let response: Record<string, unknown> | null = null;
  let recovered = null as Awaited<ReturnType<typeof recoverRecentProviderMessage>>;

  try {
    response = await ghlClient().sendMessage({
      type: input.channel,
      contactId: contact.providerId,
      message: input.body,
      ...(input.channel === "Email" ? {
        subject: input.subject,
        emailFrom: input.emailFrom,
        emailTo: input.emailTo
      } : {
        fromNumber: input.fromNumber,
        toNumber: input.toNumber
      })
    });
  } catch (error) {
    recovered = await recoverRecentProviderMessage({
      contactProviderId: contact.providerId,
      body: input.body,
      channel: input.channel
    }).catch(() => null);

    if (!recovered) throw error;
  }

  const providerMessageId =
    asString(response?.messageId) ??
    recovered?.messageId;
  const conversationProviderId =
    asString(response?.conversationId) ??
    recovered?.conversationId;

  if (!providerMessageId || !conversationProviderId) {
    throw new Error("ghl_message_missing_required_fields");
  }

  const occurredAt = recovered?.occurredAt ?? new Date();
  const providerPayload = response ?? recovered?.message ?? {};

  await persistOutboundMessage({
    contactId: input.contactId,
    contactProviderId: contact.providerId,
    channel: input.channel,
    body: input.body,
    providerMessageId,
    conversationProviderId,
    providerPayload,
    occurredAt
  });

  await db.insert(schema.auditLogs).values({
    actor: "chatgpt-mcp",
    action: input.channel === "SMS" ? "ghl.message.sms.send" : "ghl.message.email.send",
    entity: "message",
    entityId: providerMessageId,
    newValue: {
      contactId: input.contactId,
      conversationProviderId,
      body: input.body,
      recoveredFromAmbiguousProviderError: Boolean(recovered)
    },
    source: "mcp"
  });

  return {
    ok: true as const,
    duplicatePrevented: false,
    recoveredFromAmbiguousProviderError: Boolean(recovered),
    messageId: providerMessageId,
    conversationId: conversationProviderId,
    contactId: input.contactId,
    timestamp: occurredAt.toISOString(),
    status: asString(response?.msg) ?? "queued"
  };
}

async function ensureAppointment(input: {
  contactId: string;
  calendarId: string;
  startAt: Date;
  endAt: Date | null;
  title?: string | undefined;
  appointmentStatus: "new" | "confirmed" | "cancelled" | "showed" | "noshow" | "invalid" | "completed" | "active";
  assignedUserId?: string | undefined;
  description?: string | undefined;
  address?: string | undefined;
  runAutomations: boolean;
  ignoreDateRange: boolean;
  ignoreFreeSlotValidation: boolean;
  jobId?: string | undefined;
}) {
  const db = getDb();
  const [contact] = await db.select().from(schema.contacts)
    .where(eq(schema.contacts.id, input.contactId))
    .limit(1);
  if (!contact) return { ok: false as const, error: "contact_not_found" };

  if (input.jobId) {
    const [job] = await db.select().from(schema.jobs)
      .where(and(eq(schema.jobs.id, input.jobId), eq(schema.jobs.contactId, input.contactId)))
      .limit(1);
    if (!job) return { ok: false as const, error: "job_not_found_for_contact" };
  }

  let appointment = await findEquivalentLocalAppointment({
    contactId: input.contactId,
    calendarId: input.calendarId,
    startAt: input.startAt,
    title: input.title
  });
  let source: "local" | "provider-preflight" | "created" | "provider-recovery" = "local";

  if (!appointment) {
    const remoteExisting = await findEquivalentRemoteAppointment({
      contactProviderId: contact.providerId,
      calendarId: input.calendarId,
      startAt: input.startAt,
      title: input.title
    }).catch(() => null);

    if (remoteExisting) {
      appointment = await syncAppointmentFromGhl(remoteExisting, input.contactId);
      source = "provider-preflight";
    }
  }

  if (!appointment) {
    const body: Record<string, unknown> = {
      title: input.title ?? contact.name ?? "EGC Appointment",
      calendarId: input.calendarId,
      contactId: contact.providerId,
      startTime: input.startAt.toISOString(),
      appointmentStatus: input.appointmentStatus,
      toNotify: input.runAutomations,
      ignoreDateRange: input.ignoreDateRange,
      ignoreFreeSlotValidation: input.ignoreFreeSlotValidation
    };
    if (input.endAt) body.endTime = input.endAt.toISOString();
    if (input.assignedUserId) body.assignedUserId = input.assignedUserId;
    if (input.description) body.description = input.description;
    if (input.address) body.address = input.address;

    try {
      const remote = await ghlClient().createAppointment(body);
      appointment = await syncAppointmentFromGhl(remote, input.contactId);
      source = "created";
    } catch (error) {
      const remoteRecovered = await findEquivalentRemoteAppointment({
        contactProviderId: contact.providerId,
        calendarId: input.calendarId,
        startAt: input.startAt,
        title: input.title
      }).catch(() => null);

      if (!remoteRecovered) throw error;
      appointment = await syncAppointmentFromGhl(remoteRecovered, input.contactId);
      source = "provider-recovery";
    }
  }

  if (input.jobId) {
    await db.update(schema.jobs).set({
      appointmentId: appointment.id,
      scheduledAt: appointment.appointmentStartAt,
      updatedAt: new Date()
    }).where(eq(schema.jobs.id, input.jobId));
  }

  await db.insert(schema.auditLogs).values({
    actor: "chatgpt-mcp",
    action: source === "created" ? "ghl.appointment.create" : "ghl.appointment.ensure",
    entity: "appointment",
    entityId: appointment.id,
    newValue: {
      appointment,
      source,
      duplicatePrevented: source !== "created",
      recoveredFromAmbiguousProviderError: source === "provider-recovery"
    },
    source: "mcp"
  });

  return {
    ok: true as const,
    duplicatePrevented: source !== "created",
    recoveredFromAmbiguousProviderError: source === "provider-recovery",
    source,
    appointment
  };
}

function formatApprovedWalkthroughNote(
  extraction: ReturnType<typeof walkthroughExtractionSchema.parse>,
  jobId: string
) {
  return [
    "EGC WALKTHROUGH — APPROVED",
    `Job ID: ${jobId}`,
    `Garage size: ${extraction.garageSize}`,
    `Estimated junk: ${extraction.junkVolumeYards ?? "unknown"} yd³`,
    `Estimated labor: ${extraction.estimatedLaborHours ?? "unknown"} hours`,
    "",
    `REMOVE: ${extraction.itemsRemove.length ? extraction.itemsRemove.join("; ") : "None noted"}`,
    `KEEP: ${extraction.itemsKeep.length ? extraction.itemsKeep.join("; ") : "None noted"}`,
    `RELOCATE: ${extraction.itemsRelocate.length ? extraction.itemsRelocate.join("; ") : "None noted"}`,
    `STORAGE: ${extraction.storageRequirements.length ? extraction.storageRequirements.join("; ") : "None noted"}`,
    `BIKE RACKS: ${extraction.bikeRacks}`,
    `TOOL RACKS: ${extraction.toolRacks}`,
    `SHELVING: ${extraction.shelving.length ? extraction.shelving.join("; ") : "None noted"}`,
    `PRESSURE WASHING: ${extraction.pressureWashing ? "Yes" : "No"}`,
    `PEST OBSERVATIONS: ${extraction.pestObservations.length ? extraction.pestObservations.join("; ") : "None noted"}`,
    `ACTIVE INFESTATION KNOWN: ${extraction.activeInfestation === null ? "Unknown" : extraction.activeInfestation ? "Yes" : "No"}`,
    `ACCESS: ${extraction.accessNotes ?? "None noted"}`,
    "",
    `CUSTOMER PREFERENCES: ${extraction.customerPreferences.length ? extraction.customerPreferences.join("; ") : "None noted"}`,
    `CUSTOMER OBJECTIONS: ${extraction.customerObjections.length ? extraction.customerObjections.join("; ") : "None noted"}`,
    `SALES NOTES: ${extraction.salesNotes.length ? extraction.salesNotes.join("; ") : "None noted"}`,
    `CREW NOTES: ${extraction.crewNotes.length ? extraction.crewNotes.join("; ") : "None noted"}`,
    `PRICING NOTES: ${extraction.pricingNotes.length ? extraction.pricingNotes.join("; ") : "None noted"}`
  ].join("\n").slice(0, 4500);
}

async function referenceMap(resourceTypes: string[]) {
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

function mappedName(
  mappings: Map<string, string>,
  resourceType: string,
  providerId: string | null | undefined
) {
  if (!providerId) return null;
  return mappings.get(`${resourceType}:${providerId}`) ?? providerId;
}

function buildServer() {
  const server = new McpServer(
    { name: "easy-garage-cleaning", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.registerTool("ghl.pipelines", {
    description: "Return live GHL opportunity pipelines and stages for the EGC location. Use this to resolve pipeline and stage IDs before opportunity writes.",
    inputSchema: z.object({}),
    ...protectedToolMetadata
  }, async () => textResult(await ghlClient().getPipelines()));

  server.registerTool("ghl.calendars", {
    description: "Return live GHL calendars for the EGC location. Use this to resolve calendar IDs before appointment writes.",
    inputSchema: z.object({}),
    ...protectedToolMetadata
  }, async () => textResult(await ghlClient().getCalendars()));

  server.registerTool("ghl.users", {
    description: "Return live GHL users for the EGC location so assignments can be made by user ID.",
    inputSchema: z.object({}),
    ...protectedToolMetadata
  }, async () => {
    const ghl = ghlClient();
    const locationPayload = await ghl.getLocation();
    const location = unwrapRecord(locationPayload, "location");
    const companyId = asString(location.companyId);
    if (!companyId) return textResult({ error: "ghl_company_id_not_found" });
    return textResult(await ghl.searchUsers(companyId));
  });

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

      const opportunity = opportunityRows[0] ?? null;
      const mappings = await referenceMap(["pipeline", "pipeline_stage", "user"]);
      return {
        ...booking,
        assignedUserName: mappedName(mappings, "user", booking.assignedUserId),
        job: jobRows[0] ?? null,
        opportunity: opportunity ? {
          ...opportunity,
          pipelineName: mappedName(mappings, "pipeline", opportunity.pipelineId),
          pipelineStageName: mappedName(mappings, "pipeline_stage", opportunity.pipelineStageId),
          assignedUserName: mappedName(mappings, "user", opportunity.assignedUserId)
        } : null,
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
      assignedUserId: schema.appointments.assignedUserId,
      calendarId: schema.appointments.calendarId
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

    const mappings = await referenceMap(["user", "calendar"]);
    return textResult({
      timeZone,
      start,
      end,
      appointments: rows.map((row) => ({
        ...row,
        assignedUserName: mappedName(mappings, "user", row.assignedUserId),
        calendarName: mappedName(mappings, "calendar", row.calendarId)
      }))
    });
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
    const mappings = await referenceMap(["pipeline", "pipeline_stage", "user"]);
    return textResult(rows.map((row) => ({
      ...row,
      pipelineName: mappedName(mappings, "pipeline", row.pipelineId),
      pipelineStageName: mappedName(mappings, "pipeline_stage", row.pipelineStageId),
      assignedUserName: mappedName(mappings, "user", row.assignedUserId)
    })));
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

    const mappings = await referenceMap(["pipeline", "pipeline_stage", "user"]);
    return textResult(rows.map((row) => ({
      ...row,
      pipelineName: mappedName(mappings, "pipeline", row.pipelineId),
      pipelineStageName: mappedName(mappings, "pipeline_stage", row.pipelineStageId),
      assignedUserName: mappedName(mappings, "user", row.assignedUserId)
    })));
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

    const mappings = await referenceMap(["user"]);
    return textResult({
      days,
      reps: [...metrics.entries()].map(([assignedUserId, values]) => ({
        assignedUserId,
        assignedUserName: assignedUserId === "unassigned"
          ? "Unassigned"
          : mappedName(mappings, "user", assignedUserId),
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


  server.registerTool("jobs.create", {
    description: "Create a new internal EGC job for an existing normalized contact.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      opportunityId: z.string().uuid().nullable().optional(),
      appointmentId: z.string().uuid().nullable().optional(),
      job: jobMutationSchema.default({})
    }),
    ...writeToolMetadata
  }, async ({ contactId, opportunityId, appointmentId, job }) => {
    const db = getDb();
    const [contact] = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, contactId))
      .limit(1);
    if (!contact) return textResult({ error: "contact_not_found" });

    const [created] = await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.jobs).values({
        contactId,
        opportunityId: opportunityId ?? null,
        appointmentId: appointmentId ?? null,
        status: job.status ?? "draft",
        serviceAddress: job.serviceAddress ?? null,
        garageSize: job.garageSize ?? null,
        serviceType: job.serviceType ?? null,
        junkVolumeYards: job.junkVolumeYards === undefined || job.junkVolumeYards === null
          ? null
          : String(job.junkVolumeYards),
        itemsRemove: job.itemsRemove ?? [],
        itemsKeep: job.itemsKeep ?? [],
        itemsRelocate: job.itemsRelocate ?? [],
        organizationRequirements: job.organizationRequirements ?? [],
        addOns: job.addOns ?? [],
        accessNotes: job.accessNotes ?? null,
        estimatedLaborHours: job.estimatedLaborHours === undefined || job.estimatedLaborHours === null
          ? null
          : String(job.estimatedLaborHours),
        scheduledAt: job.scheduledAt ? new Date(job.scheduledAt) : null,
        priceCents: job.priceCents ?? null,
        depositCents: job.depositCents ?? null
      }).returning();

      if (!row) throw new Error("job_create_failed");

      await tx.insert(schema.auditLogs).values({
        actor: "chatgpt-mcp",
        action: "job.create",
        entity: "job",
        entityId: row.id,
        newValue: row,
        source: "mcp"
      });

      if (process.env.GHL_WRITEBACK_ENABLED === "true" && contact.providerId) {
        await tx.insert(schema.outboxEvents).values({
          type: "ghl.contact_note.sync",
          entityId: `${row.id}:create`,
          payload: {
            ghlContactId: contact.providerId,
            title: "EGC Job Created",
            noteBody: [
              "EGC JOB CREATED VIA CHATGPT",
              `Job ID: ${row.id}`,
              `Status: ${row.status}`,
              `Service: ${row.serviceType ?? "Not set"}`,
              `Scheduled: ${row.scheduledAt?.toISOString() ?? "Not scheduled"}`
            ].join("\n")
          }
        }).onConflictDoNothing({
          target: [schema.outboxEvents.type, schema.outboxEvents.entityId]
        });
      }

      return [row];
    });

    return textResult({ ok: true, job: created });
  });

  server.registerTool("jobs.update", {
    description: "Update operational fields on an existing EGC job, including scope, schedule, status, pricing, and access notes.",
    inputSchema: z.object({
      jobId: z.string().uuid(),
      changes: jobMutationSchema
    }),
    ...writeToolMetadata
  }, async ({ jobId, changes }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);
    if (!existing) return textResult({ error: "job_not_found" });

    const updateValues = {
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.serviceAddress !== undefined ? { serviceAddress: changes.serviceAddress } : {}),
      ...(changes.garageSize !== undefined ? { garageSize: changes.garageSize } : {}),
      ...(changes.serviceType !== undefined ? { serviceType: changes.serviceType } : {}),
      ...(changes.junkVolumeYards !== undefined
        ? { junkVolumeYards: changes.junkVolumeYards === null ? null : String(changes.junkVolumeYards) }
        : {}),
      ...(changes.itemsRemove !== undefined ? { itemsRemove: changes.itemsRemove } : {}),
      ...(changes.itemsKeep !== undefined ? { itemsKeep: changes.itemsKeep } : {}),
      ...(changes.itemsRelocate !== undefined ? { itemsRelocate: changes.itemsRelocate } : {}),
      ...(changes.organizationRequirements !== undefined ? { organizationRequirements: changes.organizationRequirements } : {}),
      ...(changes.addOns !== undefined ? { addOns: changes.addOns } : {}),
      ...(changes.accessNotes !== undefined ? { accessNotes: changes.accessNotes } : {}),
      ...(changes.estimatedLaborHours !== undefined
        ? { estimatedLaborHours: changes.estimatedLaborHours === null ? null : String(changes.estimatedLaborHours) }
        : {}),
      ...(changes.scheduledAt !== undefined
        ? { scheduledAt: changes.scheduledAt === null ? null : new Date(changes.scheduledAt) }
        : {}),
      ...(changes.priceCents !== undefined ? { priceCents: changes.priceCents } : {}),
      ...(changes.depositCents !== undefined ? { depositCents: changes.depositCents } : {}),
      updatedAt: new Date()
    };

    const [updated] = await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.jobs)
        .set(updateValues)
        .where(eq(schema.jobs.id, jobId))
        .returning();

      if (!row) throw new Error("job_update_failed");

      await tx.insert(schema.auditLogs).values({
        actor: "chatgpt-mcp",
        action: "job.update",
        entity: "job",
        entityId: jobId,
        oldValue: existing,
        newValue: row,
        source: "mcp"
      });

      return [row];
    });

    return textResult({ ok: true, job: updated });
  });

  server.registerTool("jobs.add_note", {
    description: "Add an internal operational note to an EGC job and optionally mirror it into GHL as a contact note.",
    inputSchema: z.object({
      jobId: z.string().uuid(),
      type: z.enum(["general", "crew", "sales", "pricing", "customer", "operations"]).default("general"),
      body: z.string().min(1).max(10000)
    }),
    ...writeToolMetadata
  }, async ({ jobId, type, body }) => {
    const db = getDb();
    const [job] = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);
    if (!job) return textResult({ error: "job_not_found" });

    const [contact] = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, job.contactId))
      .limit(1);

    const [note] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(schema.jobNotes).values({
        jobId,
        type,
        body,
        source: "mcp",
        createdBy: "chatgpt-mcp"
      }).returning();

      if (!created) throw new Error("job_note_create_failed");

      await tx.insert(schema.auditLogs).values({
        actor: "chatgpt-mcp",
        action: "job.note.create",
        entity: "job",
        entityId: jobId,
        newValue: created,
        source: "mcp"
      });

      if (process.env.GHL_WRITEBACK_ENABLED === "true" && contact?.providerId) {
        await tx.insert(schema.outboxEvents).values({
          type: "ghl.contact_note.sync",
          entityId: `${jobId}:note:${created.id}`,
          payload: {
            ghlContactId: contact.providerId,
            title: `EGC Job Note — ${type}`,
            noteBody: body
          }
        }).onConflictDoNothing({
          target: [schema.outboxEvents.type, schema.outboxEvents.entityId]
        });
      }

      return [created];
    });

    return textResult({ ok: true, note });
  });

  server.registerTool("walkthroughs.create_draft", {
    description: "Create a structured walkthrough draft from ChatGPT-supplied scope data, optionally attaching a transcript and an existing job.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      jobId: z.string().uuid().nullable().optional(),
      transcript: z.string().max(100000).nullable().optional(),
      extraction: walkthroughExtractionSchema
    }),
    ...writeToolMetadata
  }, async ({ contactId, jobId, transcript, extraction }) => {
    const db = getDb();
    const [contact] = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, contactId))
      .limit(1);
    if (!contact) return textResult({ error: "contact_not_found" });

    if (jobId) {
      const [job] = await db.select().from(schema.jobs)
        .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.contactId, contactId)))
        .limit(1);
      if (!job) return textResult({ error: "job_not_found_for_contact" });
    }

    const [walkthrough] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(schema.walkthroughs).values({
        contactId,
        jobId: jobId ?? null,
        status: "draft",
        transcript: transcript ?? null,
        extraction
      }).returning();

      if (!created) throw new Error("walkthrough_create_failed");

      await tx.insert(schema.auditLogs).values({
        actor: "chatgpt-mcp",
        action: "walkthrough.create",
        entity: "walkthrough",
        entityId: created.id,
        newValue: created,
        source: "mcp"
      });

      return [created];
    });

    return textResult({ ok: true, walkthrough });
  });

  server.registerTool("walkthroughs.update_draft", {
    description: "Edit the transcript and/or structured scope of a draft walkthrough before approval.",
    inputSchema: z.object({
      walkthroughId: z.string().uuid(),
      transcript: z.string().max(100000).nullable().optional(),
      extraction: walkthroughExtractionSchema.optional()
    }),
    ...writeToolMetadata
  }, async ({ walkthroughId, transcript, extraction }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.walkthroughs)
      .where(eq(schema.walkthroughs.id, walkthroughId))
      .limit(1);
    if (!existing) return textResult({ error: "walkthrough_not_found" });
    if (existing.status !== "draft") return textResult({ error: "walkthrough_not_editable", status: existing.status });

    const [updated] = await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.walkthroughs).set({
        ...(transcript !== undefined ? { transcript } : {}),
        ...(extraction !== undefined ? { extraction } : {}),
        updatedAt: new Date()
      }).where(eq(schema.walkthroughs.id, walkthroughId)).returning();

      if (!row) throw new Error("walkthrough_update_failed");

      await tx.insert(schema.auditLogs).values({
        actor: "chatgpt-mcp",
        action: "walkthrough.update",
        entity: "walkthrough",
        entityId: walkthroughId,
        oldValue: existing,
        newValue: row,
        source: "mcp"
      });

      return [row];
    });

    return textResult({ ok: true, walkthrough: updated });
  });

  server.registerTool("walkthroughs.approve", {
    description: "Approve a reviewed walkthrough. This creates a job when needed or updates the linked job scope, then queues GHL note write-back when enabled.",
    inputSchema: z.object({
      walkthroughId: z.string().uuid(),
      extraction: walkthroughExtractionSchema.optional()
    }),
    ...writeToolMetadata
  }, async ({ walkthroughId, extraction: extractionOverride }) => {
    const db = getDb();
    const [walkthrough] = await db.select().from(schema.walkthroughs)
      .where(eq(schema.walkthroughs.id, walkthroughId))
      .limit(1);

    if (!walkthrough) return textResult({ error: "walkthrough_not_found" });
    if (walkthrough.status === "approved") {
      return textResult({ error: "walkthrough_already_approved", jobId: walkthrough.jobId });
    }

    const extraction = walkthroughExtractionSchema.parse(
      extractionOverride ?? walkthrough.extraction
    );
    const addOns = [
      ...(extraction.bikeRacks > 0 ? [`${extraction.bikeRacks} bike rack(s)`] : []),
      ...(extraction.toolRacks > 0 ? [`${extraction.toolRacks} tool rack(s)`] : []),
      ...(extraction.shelving.length > 0 ? ["shelving"] : []),
      ...(extraction.pressureWashing ? ["pressure washing"] : [])
    ];

    const result = await db.transaction(async (tx) => {
      let jobId = walkthrough.jobId;

      if (!jobId) {
        const [job] = await tx.insert(schema.jobs).values({
          contactId: walkthrough.contactId,
          status: "scope_approved",
          garageSize: extraction.garageSize,
          junkVolumeYards: extraction.junkVolumeYards === null ? null : String(extraction.junkVolumeYards),
          itemsRemove: extraction.itemsRemove,
          itemsKeep: extraction.itemsKeep,
          itemsRelocate: extraction.itemsRelocate,
          organizationRequirements: extraction.storageRequirements,
          addOns,
          accessNotes: extraction.accessNotes,
          estimatedLaborHours: extraction.estimatedLaborHours === null ? null : String(extraction.estimatedLaborHours)
        }).returning();

        if (!job) throw new Error("job_create_failed");
        jobId = job.id;
      } else {
        await tx.update(schema.jobs).set({
          status: "scope_approved",
          garageSize: extraction.garageSize,
          junkVolumeYards: extraction.junkVolumeYards === null ? null : String(extraction.junkVolumeYards),
          itemsRemove: extraction.itemsRemove,
          itemsKeep: extraction.itemsKeep,
          itemsRelocate: extraction.itemsRelocate,
          organizationRequirements: extraction.storageRequirements,
          addOns,
          accessNotes: extraction.accessNotes,
          estimatedLaborHours: extraction.estimatedLaborHours === null ? null : String(extraction.estimatedLaborHours),
          updatedAt: new Date()
        }).where(eq(schema.jobs.id, jobId));
      }

      await tx.update(schema.walkthroughs).set({
        jobId,
        status: "approved",
        extraction,
        approvedAt: new Date(),
        approvedBy: "chatgpt-mcp",
        updatedAt: new Date()
      }).where(eq(schema.walkthroughs.id, walkthroughId));

      await tx.insert(schema.auditLogs).values({
        actor: "chatgpt-mcp",
        action: "walkthrough.approve",
        entity: "walkthrough",
        entityId: walkthroughId,
        oldValue: walkthrough.extraction,
        newValue: extraction,
        source: "mcp"
      });

      let ghlWritebackQueued = false;
      if (process.env.GHL_WRITEBACK_ENABLED === "true") {
        const [contact] = await tx.select({
          providerId: schema.contacts.providerId
        }).from(schema.contacts)
          .where(eq(schema.contacts.id, walkthrough.contactId))
          .limit(1);

        if (contact?.providerId) {
          await tx.insert(schema.outboxEvents).values({
            type: "ghl.contact_note.sync",
            entityId: `${walkthroughId}:approved`,
            payload: {
              ghlContactId: contact.providerId,
              title: "EGC Walkthrough — Approved Scope",
              noteBody: formatApprovedWalkthroughNote(extraction, jobId)
            }
          }).onConflictDoNothing({
            target: [schema.outboxEvents.type, schema.outboxEvents.entityId]
          });
          ghlWritebackQueued = true;
        }
      }

      return { jobId, ghlWritebackQueued };
    });

    const [job] = await db.select().from(schema.jobs)
      .where(eq(schema.jobs.id, result.jobId))
      .limit(1);

    return textResult({
      ok: true,
      ...result,
      extraction,
      job: job ?? null
    });
  });


  server.registerTool("conversations.send_message", {
    description: "Send a context-aware SMS or email to an existing EGC contact through GHL. Prevents identical recent duplicate sends, mirrors the outbound message locally immediately, updates lead state, and recovers from ambiguous provider errors when the message was actually sent.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      channel: z.enum(["SMS", "Email"]),
      body: z.string().min(1).max(5000),
      subject: z.string().max(500).optional(),
      emailFrom: z.string().email().optional(),
      emailTo: z.string().email().optional(),
      fromNumber: z.string().max(80).optional(),
      toNumber: z.string().max(80).optional(),
      duplicateWindowMinutes: z.number().int().min(1).max(120).default(10)
    }),
    ...writeToolMetadata
  }, async (input) => textResult(await sendConversationMessage(input)));

  server.registerTool("send_sms", {
    description: "Send an SMS to an existing EGC contact through GHL with duplicate suppression, immediate local mirroring, lead-state update, and ambiguous-provider-error recovery.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      body: z.string().min(1).max(1600),
      fromNumber: z.string().max(80).optional(),
      toNumber: z.string().max(80).optional(),
      duplicateWindowMinutes: z.number().int().min(1).max(120).default(10)
    }),
    ...writeToolMetadata
  }, async ({ contactId, body, fromNumber, toNumber, duplicateWindowMinutes }) =>
    textResult(await sendConversationMessage({
      contactId,
      channel: "SMS",
      body,
      fromNumber,
      toNumber,
      duplicateWindowMinutes
    }))
  );

  server.registerTool("contacts.create", {
    description: "Create a contact in GHL and immediately create the normalized EGC contact/lead record.",
    inputSchema: z.object({
      contact: contactMutationSchema
    }),
    ...writeToolMetadata
  }, async ({ contact: input }) => {
    const db = getDb();
    const remote = await ghlClient().upsertContact(input);
    const contact = await syncContactFromGhl(remote);

    if (input.assignedTo !== undefined) {
      await db.update(schema.leads).set({
        assignedUserId: input.assignedTo,
        updatedAt: new Date()
      }).where(eq(schema.leads.contactId, contact.id));
    }

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.contact.create",
      entity: "contact",
      entityId: contact.id,
      newValue: contact,
      source: "mcp"
    });

    return textResult({ ok: true, contact });
  });

  server.registerTool("contacts.update", {
    description: "Update an existing EGC contact in GHL and immediately mirror the result locally. Supplying tags here replaces the full GHL tag set; use add/remove tag tools for incremental changes.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      changes: contactMutationSchema
    }),
    ...writeToolMetadata
  }, async ({ contactId, changes }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, contactId))
      .limit(1);
    if (!existing) return textResult({ error: "contact_not_found" });

    const remote = await ghlClient().updateContact(existing.providerId, changes);
    const updated = await syncContactFromGhl(remote, contactId);

    if (changes.assignedTo !== undefined) {
      await db.update(schema.leads).set({
        assignedUserId: changes.assignedTo,
        updatedAt: new Date()
      }).where(eq(schema.leads.contactId, contactId));
    }

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.contact.update",
      entity: "contact",
      entityId: contactId,
      oldValue: existing,
      newValue: updated,
      source: "mcp"
    });

    return textResult({ ok: true, contact: updated });
  });

  server.registerTool("contacts.add_tags", {
    description: "Add one or more tags to a GHL contact without replacing existing tags.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      tags: z.array(z.string().min(1).max(200)).min(1)
    }),
    ...writeToolMetadata
  }, async ({ contactId, tags }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, contactId))
      .limit(1);
    if (!existing) return textResult({ error: "contact_not_found" });

    const remote = await ghlClient().addContactTags(existing.providerId, tags);
    const currentTags = findArray(remote, "tags")
      .filter((value): value is string => typeof value === "string");
    const nextTags = currentTags.length
      ? currentTags
      : [...new Set([...existing.tags, ...tags])];

    const [updated] = await db.update(schema.contacts).set({
      tags: nextTags,
      updatedAt: new Date()
    }).where(eq(schema.contacts.id, contactId)).returning();

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.contact.tags.add",
      entity: "contact",
      entityId: contactId,
      oldValue: { tags: existing.tags },
      newValue: { tags: updated?.tags ?? nextTags },
      source: "mcp"
    });

    return textResult({ ok: true, tags: updated?.tags ?? nextTags });
  });

  server.registerTool("contacts.remove_tags", {
    description: "Remove one or more tags from a GHL contact without changing unrelated tags.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      tags: z.array(z.string().min(1).max(200)).min(1)
    }),
    ...writeToolMetadata
  }, async ({ contactId, tags }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, contactId))
      .limit(1);
    if (!existing) return textResult({ error: "contact_not_found" });

    const remote = await ghlClient().removeContactTags(existing.providerId, tags);
    const remoteTags = findArray(remote, "tags")
      .filter((value): value is string => typeof value === "string");
    const nextTags = remoteTags.length || existing.tags.length === tags.length
      ? remoteTags
      : existing.tags.filter((tag) => !tags.includes(tag));

    const [updated] = await db.update(schema.contacts).set({
      tags: nextTags,
      updatedAt: new Date()
    }).where(eq(schema.contacts.id, contactId)).returning();

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.contact.tags.remove",
      entity: "contact",
      entityId: contactId,
      oldValue: { tags: existing.tags },
      newValue: { tags: updated?.tags ?? nextTags },
      source: "mcp"
    });

    return textResult({ ok: true, tags: updated?.tags ?? nextTags });
  });

  server.registerTool("opportunities.create", {
    description: "Create a GHL opportunity for an EGC contact and immediately normalize it locally. Use ghl.pipelines first when pipeline/stage IDs are unknown.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      pipelineId: z.string().min(1),
      pipelineStageId: z.string().min(1).optional(),
      name: z.string().min(1).max(500).optional(),
      status: z.enum(["open", "won", "lost", "abandoned"]).default("open"),
      monetaryValueCents: z.number().int().min(0).nullable().optional(),
      assignedTo: z.string().min(1).optional(),
      forecastExpectedCloseDate: z.string().max(100).optional(),
      forecastProbability: z.number().min(0).max(100).optional(),
      jobId: z.string().uuid().optional()
    }),
    ...writeToolMetadata
  }, async ({
    contactId,
    pipelineId,
    pipelineStageId,
    name,
    status,
    monetaryValueCents,
    assignedTo,
    forecastExpectedCloseDate,
    forecastProbability,
    jobId
  }) => {
    const db = getDb();
    const [contact] = await db.select().from(schema.contacts)
      .where(eq(schema.contacts.id, contactId))
      .limit(1);
    if (!contact) return textResult({ error: "contact_not_found" });

    if (jobId) {
      const [job] = await db.select().from(schema.jobs)
        .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.contactId, contactId)))
        .limit(1);
      if (!job) return textResult({ error: "job_not_found_for_contact" });
    }

    const body: Record<string, unknown> = {
      pipelineId,
      name: name ?? contact.name ?? "EGC Opportunity",
      status,
      contactId: contact.providerId
    };
    if (pipelineStageId) body.pipelineStageId = pipelineStageId;
    if (monetaryValueCents !== undefined && monetaryValueCents !== null) {
      body.monetaryValue = monetaryValueCents / 100;
    }
    if (assignedTo) body.assignedTo = assignedTo;
    if (forecastExpectedCloseDate) body.forecastExpectedCloseDate = forecastExpectedCloseDate;
    if (forecastProbability !== undefined) body.forecastProbability = forecastProbability;

    const remote = await ghlClient().createOpportunity(body);
    const opportunity = await syncOpportunityFromGhl(remote, contactId);

    if (jobId) {
      await db.update(schema.jobs).set({
        opportunityId: opportunity.id,
        updatedAt: new Date()
      }).where(eq(schema.jobs.id, jobId));
    }

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.opportunity.create",
      entity: "opportunity",
      entityId: opportunity.id,
      newValue: opportunity,
      source: "mcp"
    });

    return textResult({ ok: true, opportunity });
  });

  server.registerTool("opportunities.update", {
    description: "Update GHL opportunity pipeline stage, status, value, owner, name, or forecast fields and immediately mirror the change locally.",
    inputSchema: z.object({
      opportunityId: z.string().uuid(),
      changes: opportunityMutationSchema
    }),
    ...writeToolMetadata
  }, async ({ opportunityId, changes }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.opportunities)
      .where(eq(schema.opportunities.id, opportunityId))
      .limit(1);
    if (!existing) return textResult({ error: "opportunity_not_found" });

    const body: Record<string, unknown> = {};
    if (changes.name !== undefined) body.name = changes.name;
    if (changes.pipelineId !== undefined) body.pipelineId = changes.pipelineId;
    if (changes.pipelineStageId !== undefined) body.pipelineStageId = changes.pipelineStageId;
    if (changes.status !== undefined) body.status = changes.status;
    if (changes.monetaryValueCents !== undefined) {
      body.monetaryValue = changes.monetaryValueCents === null
        ? 0
        : changes.monetaryValueCents / 100;
    }
    if (changes.assignedTo !== undefined) body.assignedTo = changes.assignedTo;
    if (changes.forecastExpectedCloseDate !== undefined) {
      body.forecastExpectedCloseDate = changes.forecastExpectedCloseDate;
    }
    if (changes.forecastProbability !== undefined) {
      body.forecastProbability = changes.forecastProbability;
    }
    if (changes.customFields !== undefined) body.customFields = changes.customFields;

    const remote = await ghlClient().updateOpportunity(existing.providerId, body);
    const updated = await syncOpportunityFromGhl(remote, existing.contactId, opportunityId);

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.opportunity.update",
      entity: "opportunity",
      entityId: opportunityId,
      oldValue: existing,
      newValue: updated,
      source: "mcp"
    });

    return textResult({ ok: true, opportunity: updated });
  });

  server.registerTool("appointments.create", {
    description: "Idempotently ensure a GHL appointment exists for an EGC contact. Checks local and live GHL calendars first, recovers after ambiguous provider errors, mirrors the canonical appointment locally, and optionally links/schedules an EGC job.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      calendarId: z.string().min(1),
      startTime: isoDateTimeSchema,
      endTime: isoDateTimeSchema.nullable().optional(),
      title: z.string().max(500).optional(),
      appointmentStatus: z.enum([
        "new", "confirmed", "cancelled", "showed", "noshow", "invalid", "completed", "active"
      ]).default("confirmed"),
      assignedUserId: z.string().min(1).optional(),
      description: z.string().max(5000).optional(),
      address: z.string().max(1000).optional(),
      runAutomations: z.boolean().default(false),
      ignoreDateRange: z.boolean().default(false),
      ignoreFreeSlotValidation: z.boolean().default(false),
      jobId: z.string().uuid().optional()
    }),
    ...writeToolMetadata
  }, async ({
    contactId,
    calendarId,
    startTime,
    endTime,
    title,
    appointmentStatus,
    assignedUserId,
    description,
    address,
    runAutomations,
    ignoreDateRange,
    ignoreFreeSlotValidation,
    jobId
  }) => textResult(await ensureAppointment({
    contactId,
    calendarId,
    startAt: new Date(startTime),
    endAt: endTime ? new Date(endTime) : null,
    title,
    appointmentStatus,
    assignedUserId,
    description,
    address,
    runAutomations,
    ignoreDateRange,
    ignoreFreeSlotValidation,
    jobId
  })));

  server.registerTool("appointments.update", {
    description: "Reschedule, reassign, rename, or change status/details of an existing GHL appointment and immediately mirror it locally. GHL automations are disabled by default unless runAutomations=true.",
    inputSchema: z.object({
      appointmentId: z.string().uuid(),
      changes: appointmentMutationSchema
    }),
    ...writeToolMetadata
  }, async ({ appointmentId, changes }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId))
      .limit(1);
    if (!existing) return textResult({ error: "appointment_not_found" });

    const body: Record<string, unknown> = {
      toNotify: changes.runAutomations,
      ignoreDateRange: changes.ignoreDateRange,
      ignoreFreeSlotValidation: changes.ignoreFreeSlotValidation
    };
    if (changes.title !== undefined) body.title = changes.title;
    if (changes.calendarId !== undefined) body.calendarId = changes.calendarId;
    if (changes.assignedUserId !== undefined && changes.assignedUserId !== null) {
      body.assignedUserId = changes.assignedUserId;
    }
    if (changes.appointmentStatus !== undefined) body.appointmentStatus = changes.appointmentStatus;
    if (changes.description !== undefined) body.description = changes.description;
    if (changes.address !== undefined) body.address = changes.address;
    if (changes.startTime !== undefined) {
      body.startTime = new Date(changes.startTime).toISOString();
    }
    if (changes.endTime !== undefined && changes.endTime !== null) {
      body.endTime = new Date(changes.endTime).toISOString();
    }

    const remote = await ghlClient().updateAppointment(existing.providerId, body);
    const updated = await syncAppointmentFromGhl(remote, existing.contactId, appointmentId);

    if (changes.startTime !== undefined) {
      await db.update(schema.jobs).set({
        scheduledAt: updated.appointmentStartAt,
        updatedAt: new Date()
      }).where(eq(schema.jobs.appointmentId, appointmentId));
    }

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.appointment.update",
      entity: "appointment",
      entityId: appointmentId,
      oldValue: existing,
      newValue: updated,
      source: "mcp"
    });

    return textResult({ ok: true, appointment: updated });
  });

  server.registerTool("appointments.cancel", {
    description: "Cancel an existing GHL appointment without deleting its audit/history record. Mirrors cancelled status locally and preserves any linked EGC job.",
    inputSchema: z.object({
      appointmentId: z.string().uuid(),
      reason: z.string().max(1000).optional(),
      runAutomations: z.boolean().default(false)
    }),
    ...writeToolMetadata
  }, async ({ appointmentId, reason, runAutomations }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId))
      .limit(1);
    if (!existing) return textResult({ error: "appointment_not_found" });

    const remote = await ghlClient().updateAppointment(existing.providerId, {
      appointmentStatus: "cancelled",
      toNotify: runAutomations,
      ...(reason ? { description: reason } : {})
    });
    const updated = await syncAppointmentFromGhl(remote, existing.contactId, appointmentId);

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.appointment.cancel",
      entity: "appointment",
      entityId: appointmentId,
      oldValue: existing,
      newValue: updated,
      source: "mcp"
    });

    return textResult({ ok: true, appointment: updated });
  });

  server.registerTool("appointments.delete", {
    description: "Delete a GHL calendar event and remove the normalized appointment. Refuses to delete an appointment linked to an EGC job unless force=true.",
    inputSchema: z.object({
      appointmentId: z.string().uuid(),
      force: z.boolean().default(false)
    }),
    ...destructiveWriteToolMetadata
  }, async ({ appointmentId, force }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId))
      .limit(1);
    if (!existing) return textResult({ error: "appointment_not_found" });

    const linkedJobs = await db.select({ id: schema.jobs.id }).from(schema.jobs)
      .where(eq(schema.jobs.appointmentId, appointmentId))
      .limit(10);

    if (linkedJobs.length && !force) {
      return textResult({
        error: "appointment_linked_to_job",
        linkedJobIds: linkedJobs.map((job) => job.id),
        guidance: "Cancel instead, or pass force=true only after confirming the canonical replacement appointment."
      });
    }

    const providerResult = await ghlClient().deleteCalendarEvent(existing.providerId);

    await db.transaction(async (tx) => {
      if (linkedJobs.length) {
        await tx.update(schema.jobs).set({
          appointmentId: null,
          updatedAt: new Date()
        }).where(eq(schema.jobs.appointmentId, appointmentId));
      }

      await tx.delete(schema.appointments)
        .where(eq(schema.appointments.id, appointmentId));

      await tx.insert(schema.auditLogs).values({
        actor: "chatgpt-mcp",
        action: "ghl.appointment.delete",
        entity: "appointment",
        entityId: appointmentId,
        oldValue: existing,
        newValue: {
          deleted: true,
          providerResult,
          clearedJobLinks: linkedJobs.map((job) => job.id)
        },
        source: "mcp"
      });
    });

    await recomputeLeadState(existing.contactId);

    return textResult({
      ok: true,
      deleted: true,
      appointmentId,
      providerId: existing.providerId,
      clearedJobLinks: linkedJobs.map((job) => job.id)
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

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// Railway's internal healthcheck hostname is not the public MCP hostname.
// Keep /health outside host validation while validating every OAuth/MCP route.
app.get("/health", async (_req, res) => {
  try {
    await getDb().select({ id: schema.contacts.id }).from(schema.contacts).limit(1);
    res.json({ ok: true, service: "egc-mcp", oauth: true, database: "ready" });
  } catch {
    res.status(503).json({ ok: false, service: "egc-mcp", oauth: true, database: "not_ready" });
  }
});

app.use((req, res, next) => {
  if (allowedHosts.length === 0 || allowedHosts.includes(req.hostname)) {
    next();
    return;
  }

  res.status(403).json({ error: "invalid_host" });
});

const handler = toNodeHandler(createMcpHandler(buildServer));
const oauth = registerOauthRoutes(app);

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

    const toolName =
      body &&
      typeof (body as { params?: unknown }).params === "object" &&
      (body as { params?: { name?: unknown } }).params !== null &&
      typeof (body as { params?: { name?: unknown } }).params?.name === "string"
        ? (body as { params: { name: string } }).params.name
        : "";

    const requiredScope = WRITE_TOOLS.has(toolName) ? WRITE_SCOPE : READ_SCOPE;

    if (await authorizeMcpRequest(req.header("authorization"), requiredScope)) {
      next();
      return;
    }

    const challenge = mcpAuthenticateChallenge(
      oauth.resourceMetadataUrl,
      requiredScope,
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
