import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { GhlClient, asDate, asRecord, asString, findArray } from "@egc/ghl";
import { recomputeLeadState } from "@egc/lead-audit";

const db = getDb();
const ghl = GhlClient.fromEnv();

async function upsertContact(rawValue: unknown) {
  const raw = asRecord(rawValue);
  const providerId = asString(raw.id);
  if (!providerId) return null;

  const values = {
    provider: "ghl",
    providerId,
    locationId: asString(raw.locationId) ?? ghl.locationId,
    firstName: asString(raw.firstName),
    lastName: asString(raw.lastName),
    name: asString(raw.contactName) ?? asString(raw.name) ??
      [asString(raw.firstName), asString(raw.lastName)].filter(Boolean).join(" ") || null,
    email: asString(raw.email),
    phone: asString(raw.phone),
    source: asString(raw.source),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((v): v is string => typeof v === "string") : [],
    customFields: asRecord(raw.customFields),
    raw,
    providerCreatedAt: asDate(raw.dateAdded) ?? null,
    providerUpdatedAt: asDate(raw.dateUpdated) ?? null,
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
  let startAfter: string | undefined;
  for (let page = 0; page < 100; page++) {
    const payload = await ghl.searchContacts(startAfter ? { startAfterId: startAfter } : {});
    const rows = findArray(payload, "contacts");
    if (!rows.length) break;
    for (const row of rows) await upsertContact(row);
    const last = asRecord(rows.at(-1));
    startAfter = asString(last.id);
    if (rows.length < 100 || !startAfter) break;
  }
}

async function syncConversationsAndCalls() {
  const payload = await ghl.searchConversations();
  const conversations = findArray(payload, "conversations");
  for (const value of conversations) {
    const raw = asRecord(value);
    const providerId = asString(raw.id);
    const ghlContactId = asString(raw.contactId);
    if (!providerId || !ghlContactId) continue;

    const [contact] = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.provider, "ghl"), eq(schema.contacts.providerId, ghlContactId)))
      .limit(1);
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
        body: asString(msg.body),
        occurredAt,
        raw: msg
      }).onConflictDoUpdate({
        target: schema.messages.providerId,
        set: { body: asString(msg.body), raw: msg, updatedAt: new Date() }
      });

      if (messageType.toLowerCase().includes("call")) {
        const [call] = await db.insert(schema.calls).values({
          providerMessageId: messageId,
          contactId: contact.id,
          direction,
          actorType: actor,
          startedAt: occurredAt,
          durationSeconds: typeof msg.duration === "number" ? msg.duration : null,
          status: asString(msg.status),
          answered: asString(msg.status)?.toLowerCase() === "completed",
          raw: msg
        }).onConflictDoUpdate({
          target: schema.calls.providerMessageId,
          set: { status: asString(msg.status), raw: msg, updatedAt: new Date() }
        }).returning();

        if (call) {
          try {
            const [recording, transcript] = await Promise.all([
              ghl.getCallRecording(messageId).catch(() => null),
              ghl.getCallTranscript(messageId).catch(() => null)
            ]);
            if (recording) {
              const recordingRecord = asRecord(recording);
              await db.update(schema.calls).set({
                recordingUrl: asString(recordingRecord.url) ?? asString(recordingRecord.recordingUrl) ?? call.recordingUrl
              }).where(eq(schema.calls.id, call.id));
            }
            if (transcript) {
              const transcriptRecord = asRecord(transcript);
              const text =
                asString(transcriptRecord.transcription) ??
                asString(transcriptRecord.transcript) ??
                asString(transcriptRecord.text);
              if (text) {
                await db.insert(schema.callTranscripts).values({
                  callId: call.id,
                  text,
                  segments: Array.isArray(transcriptRecord.segments) ? transcriptRecord.segments : [],
                  providerPayload: transcriptRecord
                }).onConflictDoUpdate({
                  target: schema.callTranscripts.callId,
                  set: { text, providerPayload: transcriptRecord, updatedAt: new Date() }
                });
              }
            }
          } catch (error) {
            console.error("call enrichment failed", messageId, error);
          }
        }
      }
    }
    await recomputeLeadState(contact.id);
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

      // V1 deliberately reconciles from GHL after any webhook rather than trusting
      // provider payload variants. This is slower but keeps normalization correct.
      await syncContacts();
      await syncConversationsAndCalls();

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
  await syncConversationsAndCalls();
}

async function main() {
  console.log("EGC worker started");
  await reconcile();
  setInterval(() => void reconcile().catch(console.error), 5 * 60_000);
  setInterval(() => void processWebhookEvents().catch(console.error), 15_000);
}

await main();
