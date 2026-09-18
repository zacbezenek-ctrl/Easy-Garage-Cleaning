import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { GhlClient, asDate, asRecord, asString, findArray } from "@egc/ghl";
import { recomputeLeadState } from "@egc/lead-audit";

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
    name: asString(raw.contactName) ?? asString(raw.name) ?? composedName || null,
    email: asString(raw.email) ?? null,
    phone: asString(raw.phone) ?? null,
    source: asString(raw.source) ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((v): v is string => typeof v === "string") : [],
    customFields: asRecord(raw.customFields),
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
    await db.insert(schema.leads).values({
      contactId: contact.id,
      source: contact.source,
      createdAt: contact.providerCreatedAt ?? new Date()
    }).onConflictDoNothing({ target: schema.leads.contactId });
  }
  return contact ?? null;
}

async function syncContacts() {
  let startAfterId: string | undefined;
  for (let page = 0; page < 100; page++) {
    const payload = await ghl.searchContacts(startAfterId ? { startAfterId } : {});
    const rows = findArray(payload, "contacts");
    if (!rows.length) break;
    for (const row of rows) await upsertContact(row);
    const last = asRecord(rows.at(-1));
    startAfterId = asString(last.id);
    if (rows.length < 100 || !startAfterId) break;
  }
}

async function persistTranscript(callId: string, payload: unknown) {
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

async function syncConversationsAndCalls() {
  const payload = await ghl.searchConversations();
  const conversations = findArray(payload, "conversations");

  for (const value of conversations) {
    const raw = asRecord(value);
    const providerId = asString(raw.id);
    const ghlContactId = asString(raw.contactId);
    if (!providerId || !ghlContactId) continue;

    const contact = await localContactByProviderId(ghlContactId);
    if (!contact) continue;

    const [conversation] = await db.insert(schema.conversations).values({
      providerId,
      contactId: contact.id,
      raw
    }).onConflictDoUpdate({
      target: schema.conversations.providerId,
      set: { raw, updatedAt: new Date() }
    }).returning();

    if (!conversation) continue;

    const messagePayload = await ghl.getConversationMessages(providerId);
    const messages = findArray(messagePayload, "messages");

    for (const item of messages) {
      const msg = asRecord(item);
      const messageId = asString(msg.id);
      if (!messageId) continue;

      const messageType = asString(msg.messageType) ?? asString(msg.type) ?? "unknown";
      const direction = asString(msg.direction) === "inbound" ? "inbound" : "outbound";
      const occurredAt = asDate(msg.dateAdded) ?? asDate(msg.createdAt) ?? new Date();

      // Outbound messages with a user id are treated as human. Other outbound
      // messages stay classified as automation so an autoresponder cannot make
      // a lead count as "human contacted".
      const actor = direction === "inbound"
        ? "customer"
        : (Boolean(msg.userId) ? "human" : "automation");

      await db.insert(schema.messages).values({
        providerId: messageId,
        conversationId: conversation.id,
        contactId: contact.id,
        type: messageType,
        direction,
        actorType: actor,
        body: asString(msg.body) ?? asString(msg.message) ?? null,
        occurredAt,
        raw: msg
      }).onConflictDoUpdate({
        target: schema.messages.providerId,
        set: {
          body: asString(msg.body) ?? asString(msg.message) ?? null,
          raw: msg,
          updatedAt: new Date()
        }
      });

      if (messageType.toLowerCase().includes("call")) {
        const [call] = await db.insert(schema.calls).values({
          providerMessageId: messageId,
          contactId: contact.id,
          direction,
          actorType: actor,
          startedAt: occurredAt,
          durationSeconds: typeof msg.duration === "number" ? msg.duration : null,
          status: asString(msg.status) ?? null,
          answered: asString(msg.status)?.toLowerCase() === "completed",
          raw: msg
        }).onConflictDoUpdate({
          target: schema.calls.providerMessageId,
          set: {
            status: asString(msg.status) ?? null,
            raw: msg,
            updatedAt: new Date()
          }
        }).returning();

        if (call) {
          const transcript = await ghl.getCallTranscript(messageId).catch(() => null);
          if (transcript) await persistTranscript(call.id, transcript);
        }
      }
    }

    await recomputeLeadState(contact.id);
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

async function syncAppointments() {
  const calendarsPayload = await ghl.getCalendars();
  const calendars = findArray(calendarsPayload, "calendars");
  const startTime = Date.now() - 180 * 86_400_000;
  const endTime = Date.now() + 365 * 86_400_000;

  for (const calendarValue of calendars) {
    const calendar = asRecord(calendarValue);
    const calendarId = asString(calendar.id);
    if (!calendarId) continue;

    const eventPayload = await ghl.getCalendarEvents({
      calendarId,
      startTime,
      endTime
    });
    const events = findArray(eventPayload, "events");

    for (const eventValue of events) {
      const raw = asRecord(eventValue);
      const providerId = asString(raw.id);
      const ghlContactId = asString(raw.contactId);
      const startAt = asDate(raw.startTime);
      if (!providerId || !ghlContactId || !startAt) continue;

      const contact = await localContactByProviderId(ghlContactId);
      if (!contact) continue;

      // Actual GHL payloads commonly include dateAdded/createdAt even though the
      // short docs example omits them. If absent, preserve the uncertainty by
      // using the start timestamp and retaining the raw payload for later repair.
      const appointmentCreatedAt =
        asDate(raw.dateAdded) ??
        asDate(raw.createdAt) ??
        asDate(raw.appointmentCreatedAt) ??
        startAt;

      const values = {
        providerId,
        contactId: contact.id,
        calendarId,
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
    }
  }
}

async function processWebhookEvents() {
  const events = await db.select().from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.processingStatus, "pending"))
    .orderBy(asc(schema.webhookEvents.receivedAt))
    .limit(50);

  for (const event of events) {
    try {
      await db.update(schema.webhookEvents).set({
        processingStatus: "processing",
        retryCount: event.retryCount + 1
      }).where(eq(schema.webhookEvents.id, event.id));

      await reconcile();

      await db.update(schema.webhookEvents).set({
        processingStatus: "processed",
        processedAt: new Date()
      }).where(eq(schema.webhookEvents.id, event.id));
    } catch (error) {
      console.error("webhook processing failed", event.id, error);
      await db.update(schema.webhookEvents).set({
        processingStatus: "failed"
      }).where(eq(schema.webhookEvents.id, event.id));
    }
  }
}

async function reconcile() {
  await syncContacts();
  await Promise.all([
    syncConversationsAndCalls(),
    syncOpportunities(),
    syncAppointments()
  ]);
}

async function main() {
  console.log("EGC worker started");
  await reconcile();
  setInterval(() => void reconcile().catch(console.error), 5 * 60_000);
  setInterval(() => void processWebhookEvents().catch(console.error), 15_000);
}

await main();
