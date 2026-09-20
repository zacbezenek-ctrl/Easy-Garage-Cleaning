import { and, asc, eq, lte } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { GhlClient, asDate, asRecord, asString, findArray } from "@egc/ghl";
import { recomputeLeadState } from "@egc/lead-audit";
import { startMetaConversionWorker } from "./meta-conversion-worker.js";

const db = getDb();
const ghl = GhlClient.fromEnv();

function ghlMoneyToCents(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function normalizeAppointmentStatus(value: unknown):
  "new" | "confirmed" | "cancelled" | "showed" | "noshow" | "invalid" {
  const s = asString(value)?.toLowerCase();
  if (s === "confirmed") return "confirmed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "showed" || s === "completed") return "showed";
  if (s === "noshow" || s === "no_show" || s === "no-show") return "noshow";
  if (s === "invalid") return "invalid";
  return "new";
}

async function localContactByProviderId(providerId: string) {
  const [contact] = await db.select().from(schema.contacts)
    .where(and(eq(schema.contacts.provider, "ghl"), eq(schema.contacts.providerId, providerId)))
    .limit(1);
  return contact ?? null;
}

async function upsertContact(rawValue: unknown) {
  const raw = asRecord(rawValue);
  const providerId = asString(raw.id);
  if (!providerId) return null;

  const composedName = [asString(raw.firstName), asString(raw.lastName)].filter(Boolean).join(" ");
  const values = {
    provider: "ghl",
    providerId,
    locationId: asString(raw.locationId) ?? ghl.locationId,
    firstName: asString(raw.firstName) ?? null,
    lastName: asString(raw.lastName) ?? null,
    name: asString(raw.contactName) ?? asString(raw.name) ?? (composedName || null),
    email: asString(raw.email) ?? null,
    phone: asString(raw.phone) ?? null,
    source: asString(raw.source) ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((v): v is string => typeof v === "string") : [],
    customFields: Array.isArray(raw.customFields) ? raw.customFields : [],
    raw,
    providerCreatedAt: asDate(raw.dateAdded) ?? asDate(raw.createdAt) ?? null,
    providerUpdatedAt: asDate(raw.dateUpdated) ?? asDate(raw.updatedAt) ?? null,
    updatedAt: new Date()
  };

  const [contact] = await db.insert(schema.contacts).values(values)
    .onConflictDoUpdate({
      target: [schema.contacts.provider, schema.contacts.providerId],
      set: values
    })
    .returning();

  if (contact) {
    const assignedUserId = asString(raw.assignedTo) ?? asString(raw.assignedUserId) ?? null;
    await db.insert(schema.leads).values({
      contactId: contact.id,
      source: contact.source,
      assignedUserId,
      createdAt: contact.providerCreatedAt ?? new Date()
    }).onConflictDoUpdate({
      target: schema.leads.contactId,
      set: {
        source: contact.source,
        assignedUserId,
        updatedAt: new Date()
      }
    });
  }
  return contact ?? null;
}

async function upsertProviderMapping(input: {
  resourceType: string;
  providerId: string;
  displayName?: string | null;
  fieldType?: string | null;
  canonicalField?: string | null;
  raw: Record<string, unknown>;
}) {
  const values = {
    provider: "ghl",
    resourceType: input.resourceType,
    providerId: input.providerId,
    displayName: input.displayName ?? null,
    fieldType: input.fieldType ?? null,
    canonicalField: input.canonicalField ?? null,
    raw: input.raw,
    updatedAt: new Date()
  };

  await db.insert(schema.providerMappings).values(values)
    .onConflictDoUpdate({
      target: [
        schema.providerMappings.provider,
        schema.providerMappings.resourceType,
        schema.providerMappings.providerId
      ],
      set: values
    });
}

async function syncReferenceMappings() {
  const locationPayload = await ghl.getLocation();
  const location = asRecord(locationPayload.location);
  const companyId = asString(location.companyId);

  if (Object.keys(location).length > 0) {
    await upsertProviderMapping({
      resourceType: "location",
      providerId: ghl.locationId,
      displayName: asString(location.name) ?? "EGC Location",
      raw: location
    });
  }

  const pipelinesPayload = await ghl.getPipelines();

  for (const value of findArray(pipelinesPayload, "pipelines")) {
    const pipeline = asRecord(value);
    const pipelineId = asString(pipeline.id);
    if (!pipelineId) continue;

    await upsertProviderMapping({
      resourceType: "pipeline",
      providerId: pipelineId,
      displayName: asString(pipeline.name) ?? pipelineId,
      raw: pipeline
    });

    const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
    for (const stageValue of stages) {
      const stage = asRecord(stageValue);
      const stageId = asString(stage.id);
      if (!stageId) continue;
      await upsertProviderMapping({
        resourceType: "pipeline_stage",
        providerId: stageId,
        displayName: asString(stage.name) ?? stageId,
        canonicalField: pipelineId,
        raw: { ...stage, pipelineId }
      });
    }
  }

  if (!companyId) return;

  let skip = 0;
  for (let page = 0; page < 100; page++) {
    const payload = await ghl.searchUsers(companyId, { skip, limit: 100 });
    const users = findArray(payload, "users");
    if (!users.length) break;

    for (const value of users) {
      const user = asRecord(value);
      const userId = asString(user.id);
      if (!userId) continue;
      const displayName = [
        asString(user.firstName),
        asString(user.lastName)
      ].filter(Boolean).join(" ") || asString(user.name) || asString(user.email) || userId;

      await upsertProviderMapping({
        resourceType: "user",
        providerId: userId,
        displayName,
        raw: user
      });
    }

    const countRaw = payload.count;
    const total = typeof countRaw === "number" ? countRaw : Number(countRaw);
    skip += users.length;
    if (users.length < 100 || (Number.isFinite(total) && skip >= total)) break;
  }
}

async function syncCustomFieldDefinitions() {
  const payload = await ghl.getCustomFields();
  const rows = findArray(payload, "customFields", "fields");

  for (const value of rows) {
    const raw = asRecord(value);
    const providerId = asString(raw.id);
    if (!providerId) continue;

    await upsertProviderMapping({
      resourceType: "contact_custom_field",
      providerId,
      displayName:
        asString(raw.name) ??
        asString(raw.fieldKey) ??
        asString(raw.placeholder) ??
        providerId,
      fieldType:
        asString(raw.dataType) ??
        asString(raw.fieldType) ??
        asString(raw.type) ??
        null,
      raw
    });
  }
}

async function syncContacts() {
  let page = 1;

  for (let requestCount = 0; requestCount < 100; requestCount++) {
    const payload = await ghl.searchContacts({
      page,
      pageLimit: 500,
      sort: [{ field: "dateAdded", direction: "asc" }]
    });
    const rows = findArray(payload, "contacts");
    if (!rows.length) break;

    for (const row of rows) await upsertContact(row);

    const meta = asRecord(payload.meta);
    const nextPageRaw = meta.nextPage;
    const nextPage = typeof nextPageRaw === "number"
      ? nextPageRaw
      : Number(nextPageRaw);

    if (Number.isFinite(nextPage) && nextPage > page) {
      page = nextPage;
      continue;
    }

    if (rows.length < 500) break;
    page += 1;
  }
}

async function persistTranscript(callId: string, payload: unknown) {
  if (typeof payload === "string") {
    const text = payload.trim();
    if (!text) return;

    await db.insert(schema.callTranscripts).values({
      callId,
      text,
      segments: [],
      providerPayload: { source: "ghl_transcript_download" }
    }).onConflictDoUpdate({
      target: schema.callTranscripts.callId,
      set: {
        text,
        segments: [],
        providerPayload: { source: "ghl_transcript_download" },
        updatedAt: new Date()
      }
    });
    return;
  }

  const segments = Array.isArray(payload) ? payload : [payload];
  const cleanSegments = segments
    .map(asRecord)
    .filter((segment) => Object.keys(segment).length > 0);

  const text = cleanSegments
    .map((segment) =>
      asString(segment.transcript) ??
      asString(segment.transcription) ??
      asString(segment.text) ??
      ""
    )
    .filter(Boolean)
    .join("\n");

  if (!text) return;

  await db.insert(schema.callTranscripts).values({
    callId,
    text,
    segments: cleanSegments,
    providerPayload: { segments: cleanSegments }
  }).onConflictDoUpdate({
    target: schema.callTranscripts.callId,
    set: {
      text,
      segments: cleanSegments,
      providerPayload: { segments: cleanSegments },
      updatedAt: new Date()
    }
  });
}

async function getSyncCursor(key: string) {
  const [row] = await db.select().from(schema.syncCursors)
    .where(eq(schema.syncCursors.key, key))
    .limit(1);
  return row?.cursor ?? null;
}

async function setSyncCursor(key: string, cursor: string) {
  await db.insert(schema.syncCursors).values({
    key,
    cursor,
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: schema.syncCursors.key,
    set: { cursor, updatedAt: new Date() }
  });
}

async function ensureContactByProviderId(providerId: string) {
  const local = await localContactByProviderId(providerId);
  if (local) return local;

  const remotePayload = await ghl.getContact(providerId).catch(() => null);
  if (!remotePayload) return null;
  const remote = asRecord(remotePayload);
  const candidate = Object.keys(asRecord(remote.contact)).length
    ? asRecord(remote.contact)
    : remote;
  return upsertContact(candidate);
}

function classifyOutboundActor(message: Record<string, unknown>) {
  const source = asString(message.source)?.toLowerCase();
  if (source === "workflow" || source === "bulk_actions" || source === "campaign" || source === "api") {
    return "automation" as const;
  }
  return Boolean(message.userId) ? "human" as const : "automation" as const;
}

async function persistMessage(rawValue: unknown): Promise<string | null> {
  const msg = asRecord(rawValue);
  const messageId = asString(msg.id);
  const ghlContactId = asString(msg.contactId);
  const conversationProviderId = asString(msg.conversationId);
  const occurredAt = asDate(msg.dateAdded) ?? asDate(msg.createdAt);

  if (!messageId || !ghlContactId || !occurredAt) return null;

  const contact = await ensureContactByProviderId(ghlContactId);
  if (!contact) return null;

  let conversationId: string | null = null;
  if (conversationProviderId) {
    const [conversation] = await db.insert(schema.conversations).values({
      providerId: conversationProviderId,
      contactId: contact.id,
      raw: {
        id: conversationProviderId,
        contactId: ghlContactId,
        locationId: asString(msg.locationId) ?? ghl.locationId
      }
    }).onConflictDoUpdate({
      target: schema.conversations.providerId,
      set: {
        raw: {
          id: conversationProviderId,
          contactId: ghlContactId,
          locationId: asString(msg.locationId) ?? ghl.locationId
        },
        updatedAt: new Date()
      }
    }).returning();
    conversationId = conversation?.id ?? null;
  }

  const messageType =
    asString(msg.messageType) ??
    (typeof msg.type === "number" ? String(msg.type) : "unknown");
  const messageDirection = asString(msg.direction) === "inbound" ? "inbound" : "outbound";
  const actor = messageDirection === "inbound"
    ? "customer"
    : classifyOutboundActor(msg);

  await db.insert(schema.messages).values({
    providerId: messageId,
    conversationId,
    contactId: contact.id,
    type: messageType,
    direction: messageDirection,
    actorType: actor,
    body: asString(msg.body) ?? asString(msg.message) ?? null,
    occurredAt,
    raw: msg
  }).onConflictDoUpdate({
    target: schema.messages.providerId,
    set: {
      conversationId,
      body: asString(msg.body) ?? asString(msg.message) ?? null,
      direction: messageDirection,
      actorType: actor,
      raw: msg,
      updatedAt: new Date()
    }
  });

  if (messageType.toLowerCase().includes("call")) {
    const meta = asRecord(msg.meta);
    const durationRaw = msg.duration ?? meta.callDuration;
    const duration = typeof durationRaw === "number" ? durationRaw : Number(durationRaw);
    const callStatus = asString(meta.callStatus) ?? asString(msg.status) ?? null;
    const normalizedCallStatus = callStatus?.toLowerCase() ?? "";

    const [call] = await db.insert(schema.calls).values({
      providerMessageId: messageId,
      contactId: contact.id,
      direction: messageDirection,
      actorType: actor,
      startedAt: occurredAt,
      durationSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
      status: callStatus,
      answered: ["completed", "connected", "answered"].includes(normalizedCallStatus),
      raw: msg
    }).onConflictDoUpdate({
      target: schema.calls.providerMessageId,
      set: {
        direction: messageDirection,
        actorType: actor,
        durationSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
        status: callStatus,
        answered: ["completed", "connected", "answered"].includes(normalizedCallStatus),
        raw: msg,
        updatedAt: new Date()
      }
    }).returning();

    if (call) {
      const [existingTranscript] = await db.select({ id: schema.callTranscripts.id })
        .from(schema.callTranscripts)
        .where(eq(schema.callTranscripts.callId, call.id))
        .limit(1);

      if (!existingTranscript) {
        const downloaded = await ghl.downloadCallTranscript(messageId).catch(() => null);
        if (downloaded?.trim()) {
          await persistTranscript(call.id, downloaded);
        } else {
          const transcript = await ghl.getCallTranscript(messageId).catch(() => null);
          if (transcript) await persistTranscript(call.id, transcript);
        }
      }
    }
  }

  return contact.id;
}

async function syncMessageChannel(channel?: "Email") {
  const cursorKey = channel
    ? "ghl.messages.email.last_seen_at"
    : "ghl.messages.non_email.last_seen_at";
  const stored = await getSyncCursor(cursorKey);
  const storedDate = stored ? asDate(stored) : undefined;
  const overlapStart = storedDate
    ? new Date(storedDate.valueOf() - 5 * 60_000).toISOString()
    : undefined;

  let cursor: string | undefined;
  let maxSeen = storedDate;
  const touchedContacts = new Set<string>();

  for (let page = 0; page < 500; page++) {
    const payload = await ghl.exportMessages({
      ...(channel ? { channel } : {}),
      ...(overlapStart ? { startDate: overlapStart } : {}),
      ...(cursor ? { cursor } : {})
    });
    const rows = findArray(payload, "messages");

    for (const row of rows) {
      const record = asRecord(row);
      const occurredAt = asDate(record.dateAdded) ?? asDate(record.createdAt);
      if (occurredAt && (!maxSeen || occurredAt > maxSeen)) maxSeen = occurredAt;

      const contactId = await persistMessage(row);
      if (contactId) touchedContacts.add(contactId);
    }

    const nextCursor = asString(payload.nextCursor);
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  if (maxSeen) await setSyncCursor(cursorKey, maxSeen.toISOString());
  return touchedContacts;
}

async function syncConversationsAndCalls() {
  const [nonEmailContacts, emailContacts] = await Promise.all([
    syncMessageChannel(),
    syncMessageChannel("Email")
  ]);

  const touchedContacts = new Set<string>([
    ...nonEmailContacts,
    ...emailContacts
  ]);

  for (const contactId of touchedContacts) {
    await recomputeLeadState(contactId);
  }
}

async function syncOpportunities() {
  let startAfter: string | undefined;
  let startAfterId: string | undefined;

  for (let page = 0; page < 100; page++) {
    const payload = await ghl.searchOpportunities({
      ...(startAfter ? { startAfter } : {}),
      ...(startAfterId ? { startAfterId } : {})
    });
    const rows = findArray(payload, "opportunities");
    if (!rows.length) break;

    for (const value of rows) {
      const raw = asRecord(value);
      const providerId = asString(raw.id);
      const ghlContactId = asString(raw.contactId);
      if (!providerId || !ghlContactId) continue;
      const contact = await localContactByProviderId(ghlContactId);
      if (!contact) continue;

      const values = {
        providerId,
        contactId: contact.id,
        pipelineId: asString(raw.pipelineId) ?? null,
        pipelineStageId: asString(raw.pipelineStageId) ?? null,
        status: asString(raw.status) ?? null,
        monetaryValueCents: ghlMoneyToCents(raw.monetaryValue),
        assignedUserId: asString(raw.assignedTo) ?? asString(raw.assignedUserId) ?? null,
        source: asString(raw.source) ?? null,
        raw,
        providerCreatedAt: asDate(raw.dateAdded) ?? asDate(raw.createdAt) ?? null,
        providerUpdatedAt: asDate(raw.dateUpdated) ?? asDate(raw.updatedAt) ?? null,
        updatedAt: new Date()
      };

      await db.insert(schema.opportunities).values(values)
        .onConflictDoUpdate({
          target: schema.opportunities.providerId,
          set: values
        });

      await recomputeLeadState(contact.id);
    }

    const last = asRecord(rows.at(-1));
    const cursor = asDate(last.dateAdded) ?? asDate(last.createdAt);
    startAfter = cursor ? String(cursor.valueOf()) : undefined;
    startAfterId = asString(last.id);
    if (rows.length < 100 || !startAfterId) break;
  }
}

async function upsertAppointment(rawValue: unknown, calendarIdOverride?: string) {
  const raw = asRecord(rawValue);
  const providerId = asString(raw.id);
  const ghlContactId = asString(raw.contactId);
  const startAt = asDate(raw.startTime);
  if (!providerId || !ghlContactId || !startAt) return null;

  const contact = await ensureContactByProviderId(ghlContactId);
  if (!contact) return null;

  const [existingAppointment] = await db.select({
    appointmentCreatedAt: schema.appointments.appointmentCreatedAt
  }).from(schema.appointments)
    .where(eq(schema.appointments.providerId, providerId))
    .limit(1);

  // Booking creation time and appointment start time are different facts.
  // Never substitute startAt when GHL omits the creation timestamp.
  const appointmentCreatedAt =
    asDate(raw.dateAdded) ??
    asDate(raw.createdAt) ??
    asDate(raw.appointmentCreatedAt) ??
    existingAppointment?.appointmentCreatedAt ??
    null;

  const values = {
    providerId,
    contactId: contact.id,
    calendarId: calendarIdOverride ?? asString(raw.calendarId) ?? null,
    assignedUserId: asString(raw.assignedUserId) ?? asString(raw.userId) ?? null,
    title: asString(raw.title) ?? null,
    status: normalizeAppointmentStatus(raw.appointmentStatus ?? raw.status),
    appointmentCreatedAt,
    appointmentStartAt: startAt,
    appointmentEndAt: asDate(raw.endTime) ?? null,
    notes: asString(raw.notes) ?? null,
    raw,
    updatedAt: new Date()
  };

  await db.insert(schema.appointments).values(values)
    .onConflictDoUpdate({
      target: schema.appointments.providerId,
      set: values
    });

  await recomputeLeadState(contact.id);
  return contact.id;
}

async function syncAppointments() {
  const calendarsPayload = await ghl.getCalendars();
  const calendars = findArray(calendarsPayload, "calendars");
  const startTime = Date.now() - 180 * 86_400_000;
  const endTime = Date.now() + 365 * 86_400_000;

  for (const calendarValue of calendars) {
    const calendar = asRecord(calendarValue);
    const calendarId = asString(calendar.id);
    if (!calendarId) continue;

    await upsertProviderMapping({
      resourceType: "calendar",
      providerId: calendarId,
      displayName: asString(calendar.name) ?? calendarId,
      raw: calendar
    });

    const eventPayload = await ghl.getCalendarEvents({
      calendarId,
      startTime,
      endTime
    });
    const events = findArray(eventPayload, "events");

    for (const eventValue of events) {
      await upsertAppointment(eventValue, calendarId);
    }
  }
}

async function ingestKnownWebhook(payload: Record<string, unknown>): Promise<boolean> {
  const eventType = asString(payload.type) ?? asString(payload.eventType);
  if (eventType === "AppointmentCreate" || eventType === "AppointmentUpdate") {
    const appointment = asRecord(payload.appointment);
    if (Object.keys(appointment).length > 0) {
      await upsertAppointment(appointment, asString(appointment.calendarId));
      return true;
    }
  }
  return false;
}

async function processWebhookEvents() {
  const events = await db.select().from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.processingStatus, "pending"))
    .orderBy(asc(schema.webhookEvents.receivedAt))
    .limit(50);

  const repairEvents: typeof events = [];

  for (const event of events) {
    try {
      await db.update(schema.webhookEvents).set({
        processingStatus: "processing",
        retryCount: event.retryCount + 1
      }).where(eq(schema.webhookEvents.id, event.id));

      const handledDirectly = await ingestKnownWebhook(event.payload);
      if (!handledDirectly) {
        repairEvents.push(event);
        continue;
      }

      await db.update(schema.webhookEvents).set({
        processingStatus: "processed",
        processedAt: new Date()
      }).where(eq(schema.webhookEvents.id, event.id));
    } catch (error) {
      console.error("webhook processing failed", event.id, error);
      const attempts = event.retryCount + 1;
      await db.update(schema.webhookEvents).set({
        processingStatus: attempts < 5 ? "pending" : "failed"
      }).where(eq(schema.webhookEvents.id, event.id));
    }
  }

  if (!repairEvents.length) return;

  try {
    // Unknown or not-yet-specialized webhook types share one reconciliation pass
    // instead of triggering a complete GHL crawl per delivery.
    await reconcile();
    for (const event of repairEvents) {
      await db.update(schema.webhookEvents).set({
        processingStatus: "processed",
        processedAt: new Date()
      }).where(eq(schema.webhookEvents.id, event.id));
    }
  } catch (error) {
    console.error("batched webhook reconciliation failed", error);
    for (const event of repairEvents) {
      const attempts = event.retryCount + 1;
      await db.update(schema.webhookEvents).set({
        processingStatus: attempts < 5 ? "pending" : "failed"
      }).where(eq(schema.webhookEvents.id, event.id));
    }
  }
}

async function reconcile() {
  await Promise.all([
    syncReferenceMappings(),
    syncCustomFieldDefinitions(),
    syncContacts()
  ]);
  await Promise.all([
    syncConversationsAndCalls(),
    syncOpportunities(),
    syncAppointments()
  ]);
}

async function processOutboxEvents() {
  const events = await db.select().from(schema.outboxEvents)
    .where(and(
      eq(schema.outboxEvents.processingStatus, "pending"),
      lte(schema.outboxEvents.availableAt, new Date())
    ))
    .orderBy(asc(schema.outboxEvents.availableAt))
    .limit(25);

  for (const event of events) {
    await db.update(schema.outboxEvents).set({
      processingStatus: "processing",
      updatedAt: new Date()
    }).where(eq(schema.outboxEvents.id, event.id));

    try {
      if (
        event.type !== "ghl.walkthrough_note.sync" &&
        event.type !== "ghl.contact_note.sync"
      ) {
        throw new Error(`Unsupported outbox event type: ${event.type}`);
      }

      const payload = asRecord(event.payload);
      const ghlContactId = asString(payload.ghlContactId);
      const noteBody = asString(payload.noteBody);
      const title =
        asString(payload.title) ??
        (event.type === "ghl.walkthrough_note.sync"
          ? "EGC Walkthrough — Approved Scope"
          : "EGC Operations Note");

      if (!ghlContactId || !noteBody) {
        throw new Error("GHL contact note writeback payload is incomplete");
      }

      const response = await ghl.createContactNote(
        ghlContactId,
        noteBody,
        title
      );
      const noteId = asString(asRecord(response.note).id) ?? null;

      await db.transaction(async (tx) => {
        await tx.update(schema.outboxEvents).set({
          processingStatus: "processed",
          processedAt: new Date(),
          lastError: null,
          updatedAt: new Date()
        }).where(eq(schema.outboxEvents.id, event.id));

        await tx.insert(schema.auditLogs).values({
          actor: "worker",
          action: "ghl.contact_note.sync",
          entity: event.type === "ghl.walkthrough_note.sync" ? "walkthrough" : "operation",
          entityId: event.entityId,
          newValue: { noteId, title },
          source: "sync"
        });
      });
    } catch (error) {
      const attempts = event.retryCount + 1;
      const delayMs = Math.min(15 * 60_000, 15_000 * 2 ** Math.min(attempts, 6));
      const lastError = error instanceof Error ? error.message.slice(0, 500) : "unknown_error";

      await db.update(schema.outboxEvents).set({
        processingStatus: attempts < 8 ? "pending" : "failed",
        retryCount: attempts,
        availableAt: new Date(Date.now() + delayMs),
        lastError,
        updatedAt: new Date()
      }).where(eq(schema.outboxEvents.id, event.id));
    }
  }
}

async function main() {
  console.log("EGC worker started");
  startMetaConversionWorker();
  // A transient GHL startup failure must not stop Meta synchronization or the
  // existing webhook/outbox polling loops from being scheduled.
  await reconcile().catch(() => console.error("Initial GHL reconciliation failed; scheduled reconciliation will retry."));
  await processOutboxEvents().catch(() => console.error("Initial outbox processing failed; scheduled processing will retry."));
  setInterval(() => void reconcile().catch(console.error), 5 * 60_000);
  setInterval(() => void processWebhookEvents().catch(console.error), 15_000);
  setInterval(() => void processOutboxEvents().catch(console.error), 15_000);
}

await main();
