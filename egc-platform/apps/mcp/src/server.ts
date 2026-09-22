import {registerCustomerStateTools,canonicalOperationalReport,canonicalFunnel} from './customer-state-tools.js';
import {getCustomerTimeline,OPERATIONAL_STATES} from '@egc/customer-state';
import {registerPortalRecordTools} from "./portal-record-tools.js";
import {verifyOperationsOnStart} from "./operations-smoke.js";
import {executeCommunication,reconcileCommunication} from "./communication-execution.js";
import {registerOperationsTools,operationsPrincipal,operationsEnabled,OPERATIONS_WRITE_TOOLS,LEGACY_MUTATIONS_DISABLED,callOperations} from "./operations.js";
import {registerRecordingTools} from "./recording-tools.js";
import express from "express";
import {ReliableAppointments,AppointmentOperationError} from "./appointment-reliability.js";
import {postgresAppointmentStore} from "./appointment-store.js";
import {registerSchedulingTools,readHubVisit,assertHubSchedule,bindHubProvider} from "./scheduling-tools.js";
import {pathToFileURL} from "node:url";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { and, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { approveLegacyWalkthrough, isManagedWalkthrough, LegacyWalkthroughError } from "@egc/operations";
import { walkthroughExtractionSchema } from "@egc/schemas";
import { GhlClient, asDate, asRecord, asString, findArray } from "@egc/ghl";
import { authenticatedMcpPrincipal, authorizeMcpRequest, mcpAuthenticateChallenge, oauthSecurityMetadata, READ_SCOPE, registerOauthRoutes, WRITE_SCOPE } from "./oauth.js";
import { registerMetaConversionTools } from "./meta-conversion-tools.js";
import { requiredToolScope } from "./tool-access.js";
import { verifyMetaConversionsOnStart } from "./meta-conversion-smoke.js";
import {
  communicationSummary,
  businessContactPredicate,
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

async function canonicalReadContexts(contactIds:string[]):Promise<Map<string,Record<string,unknown>>> {
  if(!contactIds.length)return new Map<string,Record<string,unknown>>();
  const rows=await getDb().select().from(schema.customerStateSnapshots).where(inArray(schema.customerStateSnapshots.contactId,[...new Set(contactIds)]));
  return new Map(rows.map(row=>[row.contactId,{...row.snapshot,coverage:row.coverage,lastReconciledAt:row.lastReconciledAt}]));
}

async function withCanonicalContexts<T extends {contactId:string}>(rows:T[]) {
  const canonical=await canonicalReadContexts(rows.map(row=>row.contactId));
  return rows.map(row=>({...row,operational:canonical.get(row.contactId)??{coverage:{complete:false,error:'customer_not_reconciled'}}}));
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

const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const taskStatusSchema = z.enum(["open", "in_progress", "blocked", "completed", "cancelled"]);
const taskMutationSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  priority: taskPrioritySchema.optional(),
  status: taskStatusSchema.optional(),
  dueAt: isoDateTimeSchema.nullable().optional(),
  assignedUserId: z.string().max(200).nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  jobId: z.string().uuid().nullable().optional(),
  opportunityId: z.string().uuid().nullable().optional(),
  source: z.string().min(1).max(200).optional()
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
  existingLocalId?: string,
  directlyObservedWonAt?: Date
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
    ...(directlyObservedWonAt && asString(raw.status) === "won" ? { wonAt: directlyObservedWonAt } : {}),
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
    : (await db.select().from(schema.appointments).where(eq(schema.appointments.providerId,providerId)).limit(1))[0];

  const values = {
    providerId,
    contactId,
    calendarId: asString(raw.calendarId) ?? existing?.calendarId ?? null,
    assignedUserId: asString(raw.assignedUserId) ?? existing?.assignedUserId ?? null,
    title: asString(raw.title) ?? existing?.title ?? null,
    status: normalizeLocalAppointmentStatus(raw.appointmentStatus ?? raw.appoinmentStatus ?? raw.status),
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

function reliableAppointments() {return new ReliableAppointments(postgresAppointmentStore(),ghlClient());}

async function updateAppointmentAndSync(
  existing: typeof schema.appointments.$inferSelect,
  changes: Record<string, unknown>,
  requestId?:string,
  portalVisitId?:string
) {
  const [contact]=await getDb().select({providerId:schema.contacts.providerId}).from(schema.contacts).where(eq(schema.contacts.id,existing.contactId)).limit(1);
  if(!contact)throw new AppointmentOperationError("contact_not_found");
  if(operationsEnabled()){
    if(!portalVisitId)throw new AppointmentOperationError("schedule_portal_visit_required");
    const visit=await readHubVisit(portalVisitId);
    assertHubSchedule(visit,{...existing.raw,appointmentStatus:existing.status,...changes,contactId:contact.providerId},existing.providerId);
  }
  const verified=await reliableAppointments().update(existing.providerId,changes,{contactId:existing.contactId,contactProviderId:contact.providerId,localAppointmentId:existing.id,...(portalVisitId?{portalVisitId}:{})},requestId);
  const updated=await syncAppointmentFromGhl(verified.event,existing.contactId,existing.id);
  if(portalVisitId)await bindHubProvider(portalVisitId,verified.operationId,verified.event);
  return {appointment:updated,operationId:verified.operationId,recoveredFromAmbiguousProviderError:verified.source==="provider-recovery",recoveredFromIncompleteProviderResponse:verified.source==="provider-recovery"};
}
function normalizedComparableText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
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
    actorType: "automation",
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
      actorType: "automation",
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
  requestId:string;contactId:string;channel:"SMS"|"Email";body:string;subject?:string|undefined;
  emailFrom?:string|undefined;emailTo?:string|undefined;fromNumber?:string|undefined;toNumber?:string|undefined;duplicateWindowMinutes?:number;
}) {
  const db=getDb(),actor=operationsPrincipal.getStore();
  if(!actor)return {ok:false,error:"verified_principal_required"};
  const [contact]=await db.select().from(schema.contacts).where(eq(schema.contacts.id,input.contactId)).limit(1);
  if(!contact)return {ok:false,error:"contact_not_found"};
  const [lead]=await db.select({dnd:schema.leads.doNotContact}).from(schema.leads).where(eq(schema.leads.contactId,input.contactId)).limit(1);
  const provider=ghlClient();
  let live:Record<string,unknown>;
  try{const response=await provider.getContact(contact.providerId);live=asRecord(response.contact??response);}catch{return {ok:false,error:"contact_preflight_unavailable"};}
  const restriction=asRecord(asRecord(live.dndSettings)[input.channel]);
  if(lead?.dnd||live.dnd===true||restriction.status==="active")return {ok:false,error:"contact_do_not_contact"};
  const phone=asString(live.phone),email=asString(live.email);
  if(input.channel==="SMS" && (!phone || (input.toNumber && input.toNumber.replace(/\D/g,"")!==phone.replace(/\D/g,""))))return {ok:false,error:"verified_contact_phone_required"};
  if(input.channel==="Email" && (!email || (input.emailTo && input.emailTo.toLowerCase()!==email.toLowerCase())))return {ok:false,error:"verified_contact_email_required"};
  const payload={type:input.channel,contactId:contact.providerId,message:input.body,...(input.channel==="SMS"?{toNumber:phone,fromNumber:input.fromNumber}:{emailTo:email,emailFrom:input.emailFrom,subject:input.subject})};
  const result=await executeCommunication({requestId:input.requestId,actorId:actor.id,contactId:input.contactId,payload,...(input.duplicateWindowMinutes?{duplicateWindowMinutes:input.duplicateWindowMinutes}:{})},provider,db);
  if("providerMessage" in result && result.providerMessage && result.messageId && result.conversationId) {
    await persistOutboundMessage({contactId:input.contactId,contactProviderId:contact.providerId,channel:input.channel,body:input.body,providerMessageId:result.messageId,conversationProviderId:result.conversationId,providerPayload:result.providerMessage,occurredAt:asDate(result.providerMessage.dateAdded)??new Date()});
    const {providerMessage:_,...receipt}=result;return receipt;
  }
  return result;
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
  portalVisitId?:string|undefined;
  requestId?:string|undefined;
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

  let verified;
  try {
    let linkedProviderId:string|null=null;
    if(operationsEnabled()){
      if(!input.portalVisitId)throw new AppointmentOperationError("schedule_portal_visit_required");
      const visit=await readHubVisit(input.portalVisitId);
      assertHubSchedule(visit,body);
      const calendar=await resolveBookingCalendar(visit.type as "walkthrough"|"job");
      if(calendar.id!==input.calendarId)throw new AppointmentOperationError("schedule_calendar_kind_conflict");
      linkedProviderId=asString(visit.highlevelAppointmentId)??null;
    }
    verified=await reliableAppointments().create(body,{contactId:input.contactId,contactProviderId:contact.providerId,jobId:input.jobId??null,...(input.portalVisitId?{portalVisitId:input.portalVisitId}:{})},linkedProviderId,input.requestId);
  }
  catch(error) {if(error instanceof AppointmentOperationError)return {ok:false as const,error:error.code,operationId:error.operationId};throw error;}
  const source=verified.source;
  const appointment=await syncAppointmentFromGhl(verified.event,input.contactId);
  if(input.portalVisitId){try{await bindHubProvider(input.portalVisitId,verified.operationId,verified.event);}catch(error){return {ok:false as const,providerAccepted:true,operationId:verified.operationId,error:error instanceof AppointmentOperationError?error.code:"schedule_provider_binding_unavailable",appointment};}}

  if (input.jobId) {
    await db.update(schema.jobs).set({
      appointmentId: appointment.id,
      scheduledAt: appointment.appointmentStartAt,
      updatedAt: new Date()
    }).where(eq(schema.jobs.id, input.jobId));
  }

  await db.insert(schema.auditLogs).values({
    actor: operationsPrincipal.getStore()?.id??"chatgpt-mcp",
    action: source === "created" ? "ghl.appointment.create" : "ghl.appointment.ensure",
    entity: "appointment",
    entityId: appointment.id,
    newValue: {
      appointment,
      operationId:verified.operationId,
      source,
      duplicatePrevented: source !== "created",
      recoveredFromAmbiguousProviderError: source === "provider-recovery"
    },
    source: "mcp"
  });

  return {
    ok: true as const,
    operationId:verified.operationId,
    duplicatePrevented: source !== "created",
    recoveredFromAmbiguousProviderError: source === "provider-recovery",
    source,
    appointment
  };
}

async function resolveBookingCalendar(type: "walkthrough" | "job") {
  const payload = await ghlClient().getCalendars();
  const calendars = findArray(payload, "calendars").map(asRecord);

  const scored = calendars
    .map((calendar) => {
      const id = asString(calendar.id);
      const name = asString(calendar.name) ?? "";
      const normalized = normalizedComparableText(name);
      if (!id) return null;

      let score = 0;
      if (normalized.includes("egc")) score += 2;
      if (normalized.includes("customer")) score += 1;

      if (type === "walkthrough") {
        if (normalized.includes("walkthrough")) score += 10;
        if (normalized.includes("free")) score += 2;
        if (normalized.includes("job")) score -= 8;
      } else {
        if (normalized.includes("customer jobs")) score += 12;
        else if (normalized.includes("job")) score += 8;
        if (normalized.includes("walkthrough")) score -= 10;
      }

      return { id, name, score };
    })
    .filter((row): row is { id: string; name: string; score: number } => Boolean(row))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const configuredId=type==="walkthrough"?process.env.GHL_WALKTHROUGH_CALENDAR_ID:process.env.GHL_JOBS_CALENDAR_ID;
  if(configuredId){const configured=scored.find(c=>c.id===configuredId);if(configured&&configured.score>=8)return configured;throw new AppointmentOperationError("schedule_configured_calendar_unverified");}
  if(best&&best.score>=8&&(!scored[1]||scored[1].score<best.score))return best;
  throw new AppointmentOperationError("schedule_calendar_ambiguous_or_unavailable");
}

async function synchronizeHubVisit(visit:Record<string,unknown>,input:{requestId:string;runAutomations:boolean}):Promise<Record<string,unknown>>{
  const portalVisitId=asString(visit.portalVisitId);
  if(!portalVisitId)throw new AppointmentOperationError("schedule_identity_unverified");
  const result=await callOperations({command:"schedule.sync_provider",portalVisitId,requestId:input.requestId,runAutomations:input.runAutomations},input.requestId);
  if(result.error)throw new AppointmentOperationError(String(result.error),"operationId" in result&&typeof result.operationId==="string"?result.operationId:null);
  return result;
}

type LeadRouteKind =
  | "full_transformation"
  | "removal_organization"
  | "removal_only"
  | "unknown";

function routeSelectionFromCustomFields(customFields: unknown[]): string | null {
  for (const raw of customFields) {
    const field = asRecord(raw);
    const id = asString(field.id);
    const value = asString(field.value);
    if (id === "eeVNj4ay4uwJGgP6pzrq" && value) return value;
    if (value && /full garage transformation|item removal/i.test(value)) return value;
  }

  for (const raw of customFields) {
    const field = asRecord(raw);
    const value = asString(field.value);
    if (value && /clear out unwanted stuff|junk removal/i.test(value)) return value;
  }

  return null;
}

function classifyLeadRoute(selection: string | null): LeadRouteKind {
  const value = normalizedComparableText(selection);
  if (value.includes("full garage transformation")) return "full_transformation";
  if (
    value.includes("item removal") &&
    (value.includes("organization") || value.includes("orginization"))
  ) return "removal_organization";
  if (
    value.includes("item removal only") ||
    value.includes("clear out unwanted stuff") ||
    value.includes("junk removal")
  ) return "removal_only";
  return "unknown";
}

function looksLikeJunkRemovalAutomation(body: string | null) {
  const text = normalizedComparableText(body);
  return [
    "junk removal",
    "send a photo",
    "send photos",
    "photo of what needs to go",
    "pickup",
    "pick up"
  ].some((phrase) => text.includes(phrase));
}

async function auditLeadRouting(days = 14) {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);

  const contacts = await db.select({
    id: schema.contacts.id,
    providerId: schema.contacts.providerId,
    name: schema.contacts.name,
    phone: schema.contacts.phone,
    tags: schema.contacts.tags,
    customFields: schema.contacts.customFields,
    providerCreatedAt: schema.contacts.providerCreatedAt,
    createdAt: schema.contacts.createdAt
  }).from(schema.contacts)
    .where(or(
      gte(schema.contacts.providerCreatedAt, since),
      and(
        isNull(schema.contacts.providerCreatedAt),
        gte(schema.contacts.createdAt, since)
      )
    ))
    .limit(1000);

  const classified = contacts.map((contact) => {
    const selection = routeSelectionFromCustomFields(contact.customFields);
    const route = classifyLeadRoute(selection);
    return { ...contact, selection, route };
  });

  const routeCounts = {
    fullTransformation: classified.filter((row) => row.route === "full_transformation").length,
    removalOrganization: classified.filter((row) => row.route === "removal_organization").length,
    removalOnly: classified.filter((row) => row.route === "removal_only").length,
    unknown: classified.filter((row) => row.route === "unknown").length
  };

  const transformationContacts = classified.filter(
    (row) => row.route === "full_transformation"
  );
  const contactIds = transformationContacts.map((row) => row.id);

  const messages = contactIds.length
    ? await db.select({
        contactId: schema.messages.contactId,
        providerId: schema.messages.providerId,
        actorType: schema.messages.actorType,
        direction: schema.messages.direction,
        body: schema.messages.body,
        occurredAt: schema.messages.occurredAt,
        type: schema.messages.type, raw: schema.messages.raw
      }).from(schema.messages)
        .where(and(
          inArray(schema.messages.contactId, contactIds),
          gte(schema.messages.occurredAt, since)
        ))
        .orderBy(desc(schema.messages.occurredAt))
    : [];

  const messagesByContact = new Map<string, typeof messages>();
  for (const message of messages) {
    const rows = messagesByContact.get(message.contactId) ?? [];
    rows.push(message);
    messagesByContact.set(message.contactId, rows);
  }

  const issues = transformationContacts.flatMap((contact) => {
    const wrongTags = contact.tags.filter((tag) =>
      ["jr", "junk-removal", "junk removal", "pickup"].includes(tag.toLowerCase())
    );
    const wrongMessages = (messagesByContact.get(contact.id) ?? []).filter((message) =>
      message.direction === "outbound" &&
      message.actorType === "automation" &&
      looksLikeJunkRemovalAutomation(message.body)
    );

    if (!wrongTags.length && !wrongMessages.length) return [];

    return [{
      type: "full_transformation_misrouted" as const,
      severity: wrongMessages.length ? "high" as const : "medium" as const,
      contactId: contact.id,
      providerContactId: contact.providerId,
      customerName: contact.name,
      phone: contact.phone,
      selectedRoute: contact.selection,
      wrongTags,
      wrongMessages: wrongMessages.slice(0, 5).map((message) => ({
        providerMessageId: message.providerId,
        body: message.body,
        occurredAt: message.occurredAt
      })),
      expectedBehavior: "Free walkthrough / consultative full-garage transformation flow"
    }];
  });

  return {
    days,
    customFieldId: "eeVNj4ay4uwJGgP6pzrq",
    routeCounts,
    issueCount: issues.length,
    issues
  };
}

async function collectSystemAlerts(days = 14, futureDays = 30) {
  const db = getDb();
  const now = new Date();
  const start = new Date(now.valueOf() - days * 86_400_000);
  const end = new Date(now.valueOf() + futureDays * 86_400_000);

  const [routing, appointments, jobs, calendarMappings] = await Promise.all([
    auditLeadRouting(days),
    db.select().from(schema.appointments)
      .where(and(
        gte(schema.appointments.appointmentStartAt, start),
        lte(schema.appointments.appointmentStartAt, end)
      ))
      .orderBy(schema.appointments.appointmentStartAt),
    db.select().from(schema.jobs)
      .where(and(
        gte(schema.jobs.scheduledAt, start),
        lte(schema.jobs.scheduledAt, end)
      )),
    db.select().from(schema.providerMappings)
      .where(eq(schema.providerMappings.resourceType, "calendar"))
  ]);

  const activeAppointments = appointments.filter(
    (row) => !["cancelled", "invalid"].includes(row.status)
  );

  const grouped = new Map<string, typeof activeAppointments>();
  for (const appointment of activeAppointments) {
    const minute = Math.floor(appointment.appointmentStartAt.valueOf() / 60_000);
    const key = `${appointment.contactId}:${minute}`;
    const rows = grouped.get(key) ?? [];
    rows.push(appointment);
    grouped.set(key, rows);
  }

  const duplicateAppointments = [...grouped.values()]
    .filter((rows) => rows.length > 1)
    .map((rows) => ({
      type: "duplicate_appointment" as const,
      severity: "high" as const,
      contactId: rows[0]!.contactId,
      startTime: rows[0]!.appointmentStartAt,
      appointments: rows.map((row) => ({
        appointmentId: row.id,
        providerId: row.providerId,
        calendarId: row.calendarId,
        title: row.title,
        status: row.status
      }))
    }));

  const jobsMissingAppointment = jobs
    .filter((job) =>
      job.scheduledAt &&
      !job.appointmentId &&
      !["completed", "cancelled", "canceled", "lost"].includes(job.status.toLowerCase())
    )
    .map((job) => ({
      type: "scheduled_job_missing_appointment" as const,
      severity: "high" as const,
      jobId: job.id,
      contactId: job.contactId,
      status: job.status,
      scheduledAt: job.scheduledAt,
      serviceType: job.serviceType
    }));

  const jobCalendarIds = new Set(
    calendarMappings
      .filter((mapping) => {
        const name = normalizedComparableText(mapping.displayName);
        return name.includes("customer jobs") || (
          name.includes("egc") &&
          name.includes("job") &&
          !name.includes("walkthrough")
        );
      })
      .map((mapping) => mapping.providerId)
  );
  const linkedAppointmentIds = new Set(
    jobs.map((job) => job.appointmentId).filter((id): id is string => Boolean(id))
  );

  const jobAppointmentsMissingJob = activeAppointments
    .filter((appointment) =>
      Boolean(appointment.calendarId) &&
      jobCalendarIds.has(appointment.calendarId!) &&
      !linkedAppointmentIds.has(appointment.id)
    )
    .map((appointment) => ({
      type: "job_appointment_missing_job" as const,
      severity: "medium" as const,
      appointmentId: appointment.id,
      providerId: appointment.providerId,
      contactId: appointment.contactId,
      calendarId: appointment.calendarId,
      title: appointment.title,
      startTime: appointment.appointmentStartAt
    }));

  const alerts = [
    ...duplicateAppointments,
    ...jobsMissingAppointment,
    ...jobAppointmentsMissingJob,
    ...routing.issues
  ];

  return {
    generatedAt: new Date().toISOString(),
    daysBack: days,
    futureDays,
    counts: {
      duplicates: duplicateAppointments.length,
      scheduledJobsMissingAppointment: jobsMissingAppointment.length,
      jobAppointmentsMissingJob: jobAppointmentsMissingJob.length,
      routingIssues: routing.issueCount,
      total: alerts.length
    },
    alerts
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

export function buildServer() {
  const server = new McpServer(
    { name: "easy-garage-cleaning", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  registerPortalRecordTools(server);
  registerOperationsTools(server,{includeAuthorityOverrides:operationsEnabled()});
  registerRecordingTools(server);
  registerSchedulingTools(server,synchronizeHubVisit);
  registerMetaConversionTools(server);
  registerCustomerStateTools(server);

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
    description: "Search EGC contacts by name, phone, or email with canonical evidence-backed operational state. Provider fields are preserved separately from operational truth.",
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
    const canonical=await canonicalReadContexts(rows.map(row=>row.id));
    return textResult(rows.map(row=>({...row,operational:canonical.get(row.id)??{coverage:{complete:false,error:'customer_not_reconciled'}}})));
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
    return textResult(row?{...row,canonical:await getCustomerTimeline({contactId,refresh:true})}:{ error: "contact_not_found" });
  });

  server.registerTool("leads.search", {
    description: "Search recent leads, optionally filtered by canonical lead state.",
    inputSchema: z.object({
      state: z.enum([...OPERATIONAL_STATES,
        "NEVER_CONTACTED",
        "OUTREACH_ATTEMPTED_NO_REPLY",
        "CUSTOMER_RESPONDED",
        "ACTIVE_CONVERSATION",
        "BOOKED"
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

    const rows=await base.where(gte(schema.leads.createdAt,since)).orderBy(desc(schema.leads.createdAt)).limit(500);
    const canonical=await canonicalReadContexts(rows.map(row=>row.contact.id));
    const enriched=rows.map(row=>{const operational=canonical.get(row.contact.id);return {...row,lead:{...row.lead,providerState:row.lead.currentState,currentState:operational?.state??row.lead.currentState},operational:operational??{coverage:{complete:false,error:'customer_not_reconciled'}}};});
    const aliases:Record<string,string[]>={NEVER_CONTACTED:['NEW_LEAD'],OUTREACH_ATTEMPTED_NO_REPLY:['OUTREACH_ATTEMPTED'],CUSTOMER_RESPONDED:['TWO_WAY_CONTACT'],ACTIVE_CONVERSATION:['TWO_WAY_CONTACT','QUALIFIED','PRICE_EXPECTATION_ACCEPTED','VIDEO_QUOTE_PENDING_CUSTOMER','VIDEO_QUOTE_RECEIVED','VIDEO_QUOTE_IN_PROGRESS','QUOTE_DELIVERED','FOLLOW_UP_PENDING','CUSTOMER_DECIDING'],BOOKED:['WALKTHROUGH_VERBALLY_BOOKED','WALKTHROUGH_BOOKED','WALKTHROUGH_COMPLETED','JOB_VERBALLY_ACCEPTED','JOB_SOLD','JOB_SCHEDULED','JOB_COMPLETED','CASH_COLLECTED']};
    return textResult(enriched.filter(row=>!state||row.lead.currentState===state||(aliases[state]??[]).includes(String(row.lead.currentState))).slice(0,limit));
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
    if(!row)return textResult({error:'lead_not_found'});
    const canonical=await getCustomerTimeline({contactId:row.contact.id,refresh:true});
    return textResult({...row,lead:{...row.lead,providerState:row.lead.currentState,currentState:canonical.customer?.state??row.lead.currentState},canonical});
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
    return textResult(await withCanonicalContexts(rows));
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
    return textResult(row?{...row,canonical:await getCustomerTimeline({contactId:row.contactId,refresh:true})}:{error:'opportunity_not_found'});
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
    return textResult(await withCanonicalContexts(rows));
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
    return textResult(await withCanonicalContexts(rows));
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
    return textResult(row?{...row,canonical:await getCustomerTimeline({contactId:row.contactId,refresh:true})}:{error:'job_not_found'});
  });

  server.registerTool("tasks.search", {
    description: "Search EGC operational tasks/todos by status, priority, assignment, linked entity, or due date.",
    inputSchema: z.object({
      status: taskStatusSchema.optional(),
      priority: taskPrioritySchema.optional(),
      assignedUserId: z.string().max(200).optional(),
      contactId: z.string().uuid().optional(),
      jobId: z.string().uuid().optional(),
      opportunityId: z.string().uuid().optional(),
      dueBefore: isoDateTimeSchema.optional(),
      dueAfter: isoDateTimeSchema.optional(),
      limit: z.number().int().min(1).max(200).default(100)
    }),
    ...protectedToolMetadata
  }, async ({ status, priority, assignedUserId, contactId, jobId, opportunityId, dueBefore, dueAfter, limit }) => {
    const db = getDb();
    const rows = await db.select().from(schema.tasks)
      .orderBy(desc(schema.tasks.updatedAt))
      .limit(500);

    const before = dueBefore ? new Date(dueBefore).valueOf() : null;
    const after = dueAfter ? new Date(dueAfter).valueOf() : null;
    const filtered = rows.filter((task) => {
      if (status && task.status !== status) return false;
      if (priority && task.priority !== priority) return false;
      if (assignedUserId && task.assignedUserId !== assignedUserId) return false;
      if (contactId && task.contactId !== contactId) return false;
      if (jobId && task.jobId !== jobId) return false;
      if (opportunityId && task.opportunityId !== opportunityId) return false;
      if (before !== null && (!task.dueAt || task.dueAt.valueOf() > before)) return false;
      if (after !== null && (!task.dueAt || task.dueAt.valueOf() < after)) return false;
      return true;
    }).slice(0, limit);

    return textResult(filtered);
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
    description: "When unified operations is enabled, read the canonical due-task queue across ALL lead ages and booked stages. days is legacy-only and ignored in unified mode. Returns coverage and pagination; never sends. When disabled this remains the explicitly limited legacy recent-lead heuristic.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(3),dueBefore:isoDateTimeSchema.optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(200).default(50) }),
    ...protectedToolMetadata
  }, async ({ days,dueBefore,offset,limit }) => {
    if(operationsEnabled())return textResult(await callOperations({command:"queue",view:"due",dueBefore:dueBefore??tomorrowBounds("America/Denver").start.toISOString(),offset,limit}));
    const rows = await leadsNeedingContact(days);
    return textResult(rows.map((row) => ({
      ...row,
      reason: row.followUpReason ?? "Human follow-up required"
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

    const canonical=await canonicalOperationalReport({days});
    return textResult({...canonical,providerBookings:enriched});
  });

  server.registerTool("calls.transcript", {
    description: "Return persisted call transcripts for one EGC contact.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      days: z.number().int().min(1).max(365).default(30)
    }),
    ...protectedToolMetadata
  }, async ({ contactId, days }) => textResult(await callTranscriptsForContact(contactId, days)));

  if(!operationsEnabled())server.registerTool("egc.customer_history", {
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
    return textResult({ contact, messages, calls, appointments, opportunities, jobs, callTranscripts:await callTranscriptsForContact(contactId,365), canonical:await getCustomerTimeline({contactId}) });
  });

  if(!operationsEnabled())server.registerTool("egc.job_brief", {
    description: "LEGACY: Read a PostgreSQL platform job and its stored notes by UUID. This is not a portal-authoritative Employee Hub job read and does not establish reviewed crew-scope approval.",
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
    return textResult(await withCanonicalContexts(rows.map((row) => ({
      ...row,
      pipelineName: mappedName(mappings, "pipeline", row.pipelineId),
      pipelineStageName: mappedName(mappings, "pipeline_stage", row.pipelineStageId),
      assignedUserName: mappedName(mappings, "user", row.assignedUserId)
    }))));
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
    const providerOpportunities=rows.map((row) => ({
      ...row,
      pipelineName: mappedName(mappings, "pipeline", row.pipelineId),
      pipelineStageName: mappedName(mappings, "pipeline_stage", row.pipelineStageId),
      assignedUserName: mappedName(mappings, "user", row.assignedUserId)
    }));
    const canonical=await canonicalOperationalReport({days:90});
    return textResult({...canonical,providerOpportunities,requestedStatus:status});
  });

  server.registerTool("egc.jobs_by_status", {
    description: "Return canonical 30-day job activity, customer state and revenue, with raw provider job counts separately labeled for reconciliation.",
    inputSchema: z.object({}),
    ...protectedToolMetadata
  }, async () => {
    const db = getDb();
    const rows = await db.select({
      status: schema.jobs.status,
      count: sql<number>`count(*)::int`
    }).from(schema.jobs).groupBy(schema.jobs.status).orderBy(schema.jobs.status);
    const canonical=await canonicalOperationalReport({days:30});
    return textResult({...canonical,providerJobCounts:rows,definition:'Canonical sold/completed/cash milestones use evidence. Provider job counts are raw mirrors and may include walkthroughs or stale statuses.'});
  });

  server.registerTool("egc.lead_conversion_funnel", {
    description: "Return lead lifecycle counts plus separate human outreach, customer response, two-way contact, lead-to-booked, and contact-to-booked metrics for the requested cohort.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(365).default(30)
    }),
    ...protectedToolMetadata
  }, async ({ days }) => {
    return textResult(await canonicalFunnel(days));
  });

  server.registerTool("egc.revenue_summary", {
    description: "Report observed sale timestamps and unverified CRM values separately from verified revenue. Missing payment or quote evidence remains unknown.",
    inputSchema: z.object({days:z.number().int().min(1).max(365).default(30)}),
    ...protectedToolMetadata
  }, async ({days}) => {
    const report=await canonicalOperationalReport({days});
    return textResult({...report,revenueSoldCents:report.soldRevenue.valueCents,cashCollectedCents:report.collectedRevenue.valueCents});
  });

  server.registerTool("egc.sales_rep_performance", {
    description:"Evidence-backed period activity and lead-cohort conversions by assigned GHL user. Attribution to a rep describes assignment, not causality. Verbal and formal bookings are separate; video quotes and accepted jobs are included.",
    inputSchema:z.object({days:z.number().int().min(1).max(365).default(30)}),...protectedToolMetadata
  },async({days})=>{
    const report=await canonicalOperationalReport({days}),db=getDb();
    const leads=await db.select({contactId:schema.leads.contactId,assignedUserId:schema.leads.assignedUserId,createdAt:schema.leads.createdAt}).from(schema.leads);
    const assigned=new Map(leads.map(l=>[l.contactId,l.assignedUserId??'unassigned']));
    const owners=[...new Set(report.customers.map(c=>assigned.get(c.contactId)??'unassigned'))];
    const mappings=await referenceMap(['user']);
    const reps=owners.map(assignedUserId=>{
      const cohortIds=new Set(report.customers.filter(c=>c.leadCreatedAt>=report.cohort.window.since&&c.leadCreatedAt<report.cohort.window.until&&assigned.get(c.contactId)===assignedUserId).map(c=>c.contactId));
      const metrics=Object.fromEntries(Object.entries(report.cohort.metrics).map(([key,m])=>{const contactIds=m.contactIds.filter(id=>cohortIds.has(id));return [key,{numerator:contactIds.length,denominator:cohortIds.size,rate:cohortIds.size?contactIds.length/cohortIds.size:null,contactIds}];}));
      const periodActivity=Object.fromEntries(Object.entries(report.periodActivity).map(([key,m])=>{const contactIds=m.contactIds.filter(id=>(assigned.get(id)??'unassigned')===assignedUserId);return [key,{count:contactIds.length,unit:'customers',contactIds}];}));
      return {assignedUserId,assignedUserName:assignedUserId==='unassigned'?'Unassigned':mappedName(mappings,'user',assignedUserId),periodActivity,cohort:{window:report.cohort.window,maturity:report.cohort.maturity,denominator:cohortIds.size,metrics}};
    });
    return textResult({days,period:report.period,authority:report.authority,reps,coverage:report.coverage});
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
    description:"Canonical walkthrough and job conversion evidence, separating period events from lead-cohort metrics. Includes verbal commitments awaiting provider reconciliation and owner-confirmed completed or negative visits.",
    inputSchema:z.object({days:z.number().int().min(1).max(365).default(90)}),...protectedToolMetadata
  },async({days})=>textResult(await canonicalOperationalReport({days})));

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
    if(isManagedWalkthrough(existing))return textResult({error:"use_employee_hub_recording_review",authority:"employee_hub"});
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
    description: "Approve a legacy walkthrough only while unified operations is disabled. Managed Hub recordings always require their signed-in human review flow.",
    inputSchema: z.object({walkthroughId:z.string().uuid(),extraction:walkthroughExtractionSchema.optional()}),
    ...writeToolMetadata
  }, async ({walkthroughId, extraction}) => {
    try {
      return textResult(await approveLegacyWalkthrough({walkthroughId, extraction, actor: operationsPrincipal.getStore()?.id ?? "chatgpt-mcp", source: "mcp"}));
    } catch (error) {
      return textResult({error: error instanceof LegacyWalkthroughError ? error.code : "legacy_walkthrough_approval_failed"});
    }
  });

  server.registerTool("conversations.send_message", {
    description: "Send an explicitly user-authorized SMS or email to a verified EGC contact. Durable request IDs and content deduplication prevent resend; provider read-back distinguishes accepted from delivered. Unknown outcomes require read-only reconciliation.",
    inputSchema: z.object({
      requestId:z.string().uuid().describe("Stable ID for this explicitly authorized customer message. Reuse on every retry; unknown outcomes never resend."),
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
    description: "Send one explicitly user-authorized SMS to a verified EGC contact. Reuse requestId on retries. Returns durable provider verification; an unknown outcome never automatically resends.",
    inputSchema: z.object({
      requestId:z.string().uuid().describe("Stable ID for this explicitly authorized customer message. Reuse on every retry; unknown outcomes never resend."),
      contactId: z.string().uuid(),
      body: z.string().min(1).max(1600),
      fromNumber: z.string().max(80).optional(),
      toNumber: z.string().max(80).optional(),
      duplicateWindowMinutes: z.number().int().min(1).max(120).default(10)
    }),
    ...writeToolMetadata
  }, async ({ requestId, contactId, body, fromNumber, toNumber, duplicateWindowMinutes }) =>
    textResult(await sendConversationMessage({
      requestId,
      contactId,
      channel: "SMS",
      body,
      fromNumber,
      toNumber,
      duplicateWindowMinutes
    }))
  );

  server.registerTool("communications.executions", {
    description:"Read durable authorization, transmission, verification and unknown outcomes for customer messages. Contains no credentials.",
    inputSchema:z.object({contactId:z.string().uuid().optional(),limit:z.number().int().min(1).max(100).default(30)}),...protectedToolMetadata
  },async({contactId,limit})=>{const db=getDb();return textResult(await db.select().from(schema.communicationExecutions).where(contactId?eq(schema.communicationExecutions.contactId,contactId):undefined).orderBy(desc(schema.communicationExecutions.createdAt)).limit(limit));});
  server.registerTool("actions.complete_from_message",{
    description:"Complete one reviewed message action using fresh provider-verified delivery of the exact approved recipient, body, channel, subject and send window. Requires the current task revision, still-valid approval and execution ID. Reads provider evidence but sends nothing; changed context or merely sent/queued messages cannot complete the task.",
    inputSchema:z.object({requestId:z.string().uuid(),taskId:z.string().uuid(),revision:z.number().int().positive(),executionId:z.string().uuid()}),...writeToolMetadata
  },async({requestId,...command})=>{
    const actor=operationsPrincipal.getStore();if(!actor)return textResult({error:"verified_principal_required"});
    const proof=await reconcileCommunication(command.executionId,undefined,actor.id,ghlClient());
    if(!proof.ok||!("delivered" in proof)||proof.delivered!==true||"verificationFresh" in proof&&proof.verificationFresh===false)return textResult({error:"message_delivery_not_freshly_verified",executionId:command.executionId});
    return textResult(await callOperations({command:"task.complete_from_message",...command},requestId));
  });

  server.registerTool("communications.reconcile", {
    description:"Read the provider to resolve a previous message execution. Never sends. For unknown writes without an ID, supply the exact observed provider message ID; contact, body, direction, channel and occurrence time must match.",
    inputSchema:z.object({executionId:z.string().uuid(),providerMessageId:z.string().optional()}),...writeToolMetadata
  },async({executionId,providerMessageId})=>textResult(await reconcileCommunication(executionId,providerMessageId,operationsPrincipal.getStore()?.id??"unverified",ghlClient())));

  server.registerTool("tasks.create", {
    description: "Create an actionable EGC operational task/todo, optionally linked to a contact, job, or opportunity.",
    inputSchema: z.object({
      title: z.string().min(1).max(500),
      description: z.string().max(5000).optional(),
      priority: taskPrioritySchema.default("medium"),
      dueAt: isoDateTimeSchema.optional(),
      assignedUserId: z.string().max(200).optional(),
      contactId: z.string().uuid().optional(),
      jobId: z.string().uuid().optional(),
      opportunityId: z.string().uuid().optional(),
      source: z.string().min(1).max(200).default("mcp")
    }),
    ...writeToolMetadata
  }, async ({ title, description, priority, dueAt, assignedUserId, contactId, jobId, opportunityId, source }) => {
    const db = getDb();
    let resolvedContactId = contactId ?? null;

    if (contactId) {
      const [contact] = await db.select({ id: schema.contacts.id }).from(schema.contacts)
        .where(eq(schema.contacts.id, contactId)).limit(1);
      if (!contact) return textResult({ error: "contact_not_found" });
    }

    if (jobId) {
      const [job] = await db.select({ id: schema.jobs.id, contactId: schema.jobs.contactId }).from(schema.jobs)
        .where(eq(schema.jobs.id, jobId)).limit(1);
      if (!job) return textResult({ error: "job_not_found" });
      if (resolvedContactId && resolvedContactId !== job.contactId) {
        return textResult({ error: "task_job_contact_mismatch" });
      }
      resolvedContactId = resolvedContactId ?? job.contactId;
    }

    if (opportunityId) {
      const [opportunity] = await db.select({
        id: schema.opportunities.id,
        contactId: schema.opportunities.contactId
      }).from(schema.opportunities)
        .where(eq(schema.opportunities.id, opportunityId)).limit(1);
      if (!opportunity) return textResult({ error: "opportunity_not_found" });
      if (resolvedContactId && resolvedContactId !== opportunity.contactId) {
        return textResult({ error: "task_opportunity_contact_mismatch" });
      }
      resolvedContactId = resolvedContactId ?? opportunity.contactId;
    }

    const [task] = await db.insert(schema.tasks).values({
      title,
      description: description ?? null,
      priority,
      status: "open",
      dueAt: dueAt ? new Date(dueAt) : null,
      assignedUserId: assignedUserId ?? null,
      contactId: resolvedContactId,
      jobId: jobId ?? null,
      opportunityId: opportunityId ?? null,
      source
    }).returning();

    if (!task) throw new Error("task_create_failed");

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "task.create",
      entity: "task",
      entityId: task.id,
      newValue: task,
      source: "mcp"
    });

    return textResult({ ok: true, task });
  });

  server.registerTool("tasks.update", {
    description: "Update an EGC operational task/todo, including priority, due date, assignment, links, or workflow status.",
    inputSchema: z.object({
      taskId: z.string().uuid(),
      changes: taskMutationSchema
    }),
    ...writeToolMetadata
  }, async ({ taskId, changes }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, taskId)).limit(1);
    if (!existing) return textResult({ error: "task_not_found" });

    const targetContactId = changes.contactId !== undefined
      ? changes.contactId
      : existing.contactId;

    if (changes.contactId) {
      const [contact] = await db.select({ id: schema.contacts.id }).from(schema.contacts)
        .where(eq(schema.contacts.id, changes.contactId)).limit(1);
      if (!contact) return textResult({ error: "contact_not_found" });
    }

    if (changes.jobId) {
      const [job] = await db.select({ id: schema.jobs.id, contactId: schema.jobs.contactId }).from(schema.jobs)
        .where(eq(schema.jobs.id, changes.jobId)).limit(1);
      if (!job) return textResult({ error: "job_not_found" });
      if (targetContactId && targetContactId !== job.contactId) {
        return textResult({ error: "task_job_contact_mismatch" });
      }
    }

    if (changes.opportunityId) {
      const [opportunity] = await db.select({
        id: schema.opportunities.id,
        contactId: schema.opportunities.contactId
      }).from(schema.opportunities)
        .where(eq(schema.opportunities.id, changes.opportunityId)).limit(1);
      if (!opportunity) return textResult({ error: "opportunity_not_found" });
      if (targetContactId && targetContactId !== opportunity.contactId) {
        return textResult({ error: "task_opportunity_contact_mismatch" });
      }
    }

    const [updated] = await db.update(schema.tasks).set({
      title: changes.title,
      description: changes.description,
      priority: changes.priority,
      status: changes.status,
      dueAt: changes.dueAt === undefined
        ? undefined
        : (changes.dueAt === null ? null : new Date(changes.dueAt)),
      assignedUserId: changes.assignedUserId,
      contactId: changes.contactId,
      jobId: changes.jobId,
      opportunityId: changes.opportunityId,
      source: changes.source,
      completedAt: changes.status === "completed"
        ? (existing.completedAt ?? new Date())
        : (changes.status !== undefined ? null : undefined),
      updatedAt: new Date()
    }).where(eq(schema.tasks.id, taskId)).returning();

    if (!updated) throw new Error("task_update_failed");

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "task.update",
      entity: "task",
      entityId: taskId,
      oldValue: existing,
      newValue: updated,
      source: "mcp"
    });

    return textResult({ ok: true, task: updated });
  });

  server.registerTool("tasks.complete", {
    description: "Mark an EGC operational task/todo complete while preserving its audit history.",
    inputSchema: z.object({
      taskId: z.string().uuid()
    }),
    ...writeToolMetadata
  }, async ({ taskId }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, taskId)).limit(1);
    if (!existing) return textResult({ error: "task_not_found" });

    if (existing.status === "completed") {
      return textResult({ ok: true, alreadyCompleted: true, task: existing });
    }

    const [updated] = await db.update(schema.tasks).set({
      status: "completed",
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(schema.tasks.id, taskId)).returning();

    if (!updated) throw new Error("task_complete_failed");

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "task.complete",
      entity: "task",
      entityId: taskId,
      oldValue: existing,
      newValue: updated,
      source: "mcp"
    });

    return textResult({ ok: true, task: updated });
  });

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
    const opportunity = await syncOpportunityFromGhl(remote, contactId, undefined, status === "won" ? new Date() : undefined);

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
    description: "Durably ensure a provider appointment for an exact saved Hub visit. In operations mode portalVisitId and times matching the authoritative Hub schedule are required; use egc.schedule_visit to create or change that schedule. Unknown writes reconcile without resend; cancelled or ambiguous records are not reused.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      portalVisitId:z.string().min(1).max(180).optional(),
      requestId:z.string().uuid().optional(),
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
    portalVisitId,
    requestId,
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
    portalVisitId,
    requestId,
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
    description: "Synchronize an existing GHL appointment to its exact authoritative Hub visit. In operations mode portalVisitId is required and the saved Hub schedule must already match; use egc.schedule_visit for rescheduling. Reuse requestId on retry; notifications default off.",
    inputSchema: z.object({
      appointmentId: z.string().uuid(),
      portalVisitId:z.string().min(1).max(180).optional(),
      requestId:z.string().uuid().optional().describe("Reuse this logical request ID and exact payload after any timeout. Use a new ID for an intentional later edit."),
      changes: appointmentMutationSchema
    }),
    ...writeToolMetadata
  }, async ({ appointmentId, changes, requestId, portalVisitId }) => {
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
    if (changes.assignedUserId !== undefined) {
      body.assignedUserId = changes.assignedUserId;
    }
    if (changes.appointmentStatus !== undefined) body.appointmentStatus = changes.appointmentStatus;
    if (changes.description !== undefined) body.description = changes.description;
    if (changes.address !== undefined) body.address = changes.address;
    if (changes.startTime !== undefined) {
      body.startTime = new Date(changes.startTime).toISOString();
    }
    if (changes.endTime !== undefined) {
      body.endTime = changes.endTime===null?null:new Date(changes.endTime).toISOString();
    }

    let verified;
    try {verified=await updateAppointmentAndSync(existing,body,requestId,portalVisitId);}
    catch(error) {if(error instanceof AppointmentOperationError)return textResult({ok:false,error:error.code,operationId:error.operationId});throw error;}
    const updated = verified.appointment;

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
      newValue: {
        appointment: updated,
        recoveredFromAmbiguousProviderError: verified.recoveredFromAmbiguousProviderError,
        recoveredFromIncompleteProviderResponse: verified.recoveredFromIncompleteProviderResponse
      },
      source: "mcp"
    });

    return textResult({
      ok: true,
      appointment: updated,
      operationId:verified.operationId,
      recoveredFromAmbiguousProviderError: verified.recoveredFromAmbiguousProviderError,
      recoveredFromIncompleteProviderResponse: verified.recoveredFromIncompleteProviderResponse
    });
  });

  server.registerTool("appointments.cancel", {
    description: "Cancel an existing GHL appointment without deleting its audit/history record. Mirrors cancelled status locally and preserves any linked EGC job.",
    inputSchema: z.object({
      appointmentId: z.string().uuid(),
      portalVisitId:z.string().min(1).max(180).optional(),
      requestId:z.string().uuid().optional(),
      reason: z.string().max(1000).optional(),
      runAutomations: z.boolean().default(false)
    }),
    ...writeToolMetadata
  }, async ({ appointmentId, reason, runAutomations, requestId, portalVisitId }) => {
    const db = getDb();
    const [existing] = await db.select().from(schema.appointments)
      .where(eq(schema.appointments.id, appointmentId))
      .limit(1);
    if (!existing) return textResult({ error: "appointment_not_found" });

    let verified;
    try {verified = await updateAppointmentAndSync(existing, {
      appointmentStatus: "cancelled",
      toNotify: runAutomations,
      ...(reason ? { description: reason } : {})
    },requestId,portalVisitId);}
    catch(error) {if(error instanceof AppointmentOperationError)return textResult({ok:false,error:error.code,operationId:error.operationId});throw error;}
    const updated = verified.appointment;

    await db.insert(schema.auditLogs).values({
      actor: "chatgpt-mcp",
      action: "ghl.appointment.cancel",
      entity: "appointment",
      entityId: appointmentId,
      oldValue: existing,
      newValue: {
        appointment: updated,
        recoveredFromAmbiguousProviderError: verified.recoveredFromAmbiguousProviderError,
        recoveredFromIncompleteProviderResponse: verified.recoveredFromIncompleteProviderResponse
      },
      source: "mcp"
    });

    return textResult({
      ok: true,
      appointment: updated,
      operationId:verified.operationId,
      recoveredFromAmbiguousProviderError: verified.recoveredFromAmbiguousProviderError,
      recoveredFromIncompleteProviderResponse: verified.recoveredFromIncompleteProviderResponse
    });
  });

  server.registerTool("appointments.operation_status", {
    description:"Read the durable outcome of one booking operation. Unknown means a provider write may have succeeded; use appointments.reconcile and never create a replacement blindly.",
    inputSchema:z.object({operationId:z.string().uuid()}),...protectedToolMetadata
  },async({operationId})=>{
    const row=await postgresAppointmentStore().get(operationId);
    if(!row)return textResult({error:"appointment_operation_not_found"});
    return textResult({operationId:row.id,kind:row.kind,status:row.status,providerAppointmentId:row.providerAppointmentId,
      attemptCount:row.attemptCount,lastError:row.lastError,leaseExpiresAt:row.leaseExpiresAt,context:asRecord(row.request.context),
      guidance:row.status==="unknown"?"Reconcile this operation. No provider write will be repeated.":null});
  });
  server.registerTool("appointments.reconcile", {
    description:"Reconcile one durable booking operation using provider READS only. Verifies exact fields and mirrors confirmed state locally; never creates, updates, cancels, deletes or sends notifications in GHL.",
    inputSchema:z.object({operationId:z.string().uuid()}),...writeToolMetadata
  },async({operationId})=>{
    try {
      const store=postgresAppointmentStore(),op=await store.get(operationId);
      if(!op)return textResult({error:"appointment_operation_not_found"});
      const verified=await reliableAppointments().reconcile(operationId),context=asRecord(op.request.context);
      const contactId=asString(context.contactId),localId=asString(context.localAppointmentId);
      if(!contactId)return textResult({error:"appointment_operation_contact_missing",operationId});
      const appointment=await syncAppointmentFromGhl(verified.event,contactId,localId??undefined);
      const portalVisitId=asString(context.portalVisitId);
      if(portalVisitId)await bindHubProvider(portalVisitId,operationId,verified.event);
      const jobId=asString(context.jobId);
      if(jobId)await getDb().update(schema.jobs).set({appointmentId:appointment.id,scheduledAt:appointment.appointmentStartAt,updatedAt:new Date()})
        .where(and(eq(schema.jobs.id,jobId),eq(schema.jobs.contactId,contactId)));
      if(op.kind!=="create")await getDb().update(schema.jobs).set({scheduledAt:appointment.appointmentStartAt,updatedAt:new Date()}).where(eq(schema.jobs.appointmentId,appointment.id));
      await getDb().insert(schema.auditLogs).values({actor:operationsPrincipal.getStore()?.id??"chatgpt-mcp",action:"ghl.appointment.reconcile",entity:"appointment",entityId:appointment.id,newValue:{operationId,providerAppointmentId:appointment.providerId,status:appointment.status},source:"mcp"});
      return textResult({ok:true,operationId,appointment,providerWrite:false});
    }catch(error) {if(error instanceof AppointmentOperationError)return textResult({ok:false,error:error.code,operationId:error.operationId});throw error;}
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

  server.registerTool("egc.ensure_booking", {
    description: "Ensure the provider mirror of one exact saved Hub visit. In operations mode portalVisitId is required; use egc.schedule_visit to create/reschedule the authoritative visit. Verifies the live calendar, preserves durable request outcomes and reconciles uncertain writes without creating replacements.",
    inputSchema: z.object({
      contactId: z.string().uuid(),
      portalVisitId:z.string().min(1).max(180).optional(),
      requestId:z.string().uuid().optional(),
      type: z.enum(["walkthrough", "job"]),
      startTime: isoDateTimeSchema,
      endTime: isoDateTimeSchema.nullable().optional(),
      assignedUserId: z.string().min(1).optional(),
      address: z.string().max(1000).optional(),
      description: z.string().max(5000).optional(),
      title: z.string().max(500).optional(),
      jobId: z.string().uuid().optional(),
      runAutomations: z.boolean().default(false)
    }),
    ...writeToolMetadata
  }, async ({
    contactId,
    portalVisitId,
    requestId,
    type,
    startTime,
    endTime,
    assignedUserId,
    address,
    description,
    title,
    jobId,
    runAutomations
  }) => {
    const calendar = await resolveBookingCalendar(type);

    const result = await ensureAppointment({
      contactId,
      portalVisitId,
      requestId,
      calendarId: calendar.id,
      startAt: new Date(startTime),
      endAt: endTime ? new Date(endTime) : null,
      title: title ?? (type === "walkthrough" ? "Free Garage Walkthrough" : "EGC Customer Job"),
      appointmentStatus: "confirmed",
      assignedUserId,
      description,
      address,
      runAutomations,
      ignoreDateRange: false,
      ignoreFreeSlotValidation: false,
      jobId
    });

    return textResult({
      ...result,
      bookingType: type,
      resolvedCalendar: calendar
    });
  });

  server.registerTool("egc.send_followup", {
    description: "Send one explicitly user-authorized SMS follow-up after reviewing the customer's history. Durable idempotency, live recipient and DND checks, provider read-back and audit records apply. An unknown outcome never resends.",
    inputSchema: z.object({
      requestId:z.string().uuid().describe("Stable ID for this explicitly authorized customer message. Reuse on every retry; unknown outcomes never resend."),
      contactId: z.string().uuid(),
      body: z.string().min(1).max(1600),
      contextReviewed: z.literal(true),
      duplicateWindowMinutes: z.number().int().min(1).max(120).default(10)
    }),
    ...writeToolMetadata
  }, async ({ requestId, contactId, body, duplicateWindowMinutes }) => {
    return textResult(await sendConversationMessage({
      requestId,
      contactId,
      channel: "SMS",
      body,
      duplicateWindowMinutes
    }));
  });

  server.registerTool("egc.routing_audit", {
    description: "Audit recent Facebook/lead-form contacts for routing mismatches, especially Full Garage Transformation leads sent into junk-removal tags or messaging.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).default(14)
    }),
    ...protectedToolMetadata
  }, async ({ days }) => textResult(await auditLeadRouting(days)));

  server.registerTool("egc.system_alerts", {
    description: "Detect operational consistency problems: duplicate appointments, scheduled jobs missing appointments, job-calendar appointments missing linked jobs, and lead-routing mismatches.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).default(14),
      futureDays: z.number().int().min(1).max(365).default(30)
    }),
    ...protectedToolMetadata
  }, async ({ days, futureDays }) =>
    textResult(await collectSystemAlerts(days, futureDays))
  );

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
    await getDb().select({ id: schema.communicationExecutions.id }).from(schema.communicationExecutions).limit(1);
    await getDb().select({ id: schema.customerEvents.eventId }).from(schema.customerEvents).limit(1);
    res.json({ ok: true, service: "egc-mcp", oauth: true, database: "ready",release:process.env.RAILWAY_GIT_COMMIT_SHA??process.env.EGC_RELEASE_SHA??null,operationsEnabled:operationsEnabled() });
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
    if(Array.isArray(req.body)){res.status(400).json({jsonrpc:"2.0",id:null,error:{code:-32600,message:"Batch requests are not supported"}});return;}
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

    const requiredScope = OPERATIONS_WRITE_TOOLS.has(toolName) ? WRITE_SCOPE : requiredToolScope(toolName);

    const principal=await authenticatedMcpPrincipal(req.header("authorization"),requiredScope);
    if (principal) {
      if(operationsEnabled() && LEGACY_MUTATIONS_DISABLED.has(toolName)) {
        res.status(200).json({jsonrpc:"2.0",id:body.id??null,result:{content:[{type:"text",text:JSON.stringify({error:"legacy_mutation_disabled_in_operations_mode",instruction:"Use canonical actions for internal work, egc.add_job_note for exact Hub notes, recording review for managed walkthroughs, and durable scheduling tools. Legacy parallel job/draft writes and destructive booking deletion remain disabled."})}],isError:true}});
        return;
      }
      operationsPrincipal.run({id:principal,role:"integration",kind:"integration",workspace:process.env.EGC_OPERATIONS_WORKSPACE??"egc"},()=>next());
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
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  app.listen(port, "0.0.0.0", () => {
    console.log(`EGC MCP listening on :${port}/mcp with OAuth resource ${oauth.origin}`);
    void verifyOperationsOnStart(port);
    void verifyMetaConversionsOnStart({ port });
  });
}
