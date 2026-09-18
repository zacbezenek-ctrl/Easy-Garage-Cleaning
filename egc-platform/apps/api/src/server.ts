import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import rawBody from "fastify-raw-body";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { extractWalkthrough, transcribeWalkthrough } from "@egc/ai";
import { walkthroughExtractionSchema } from "@egc/schemas";
import { putObject } from "@egc/storage";
import { verifyGhlWebhook } from "./webhook-signature.js";

const app = Fastify({ logger: true });

await app.register(multipart, {
  limits: { fileSize: 250 * 1024 * 1024, files: 1 }
});

await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: false,
  runFirst: true
});

async function requireInternalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.API_BEARER_TOKEN;
  if (!expected || expected.length < 32) {
    await reply.code(500).send({ error: "api_auth_not_configured" });
    return;
  }
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${expected}`) {
    await reply.code(401).send({ error: "unauthorized" });
  }
}

app.get("/health", async () => ({ ok: true, service: "egc-api" }));

app.post("/webhooks/ghl", {
  config: { rawBody: true }
}, async (request, reply) => {
  const raw = (request as typeof request & { rawBody?: Buffer }).rawBody;
  if (!raw) return reply.code(400).send({ error: "raw_body_unavailable" });

  const signature = request.headers["x-ghl-signature"];
  const signatureValue = Array.isArray(signature) ? signature[0] : signature;
  if (!verifyGhlWebhook(raw, signatureValue)) {
    return reply.code(401).send({ error: "invalid_signature" });
  }

  const payload = (request.body ?? {}) as Record<string, unknown>;
  const eventType = String(payload.type ?? payload.eventType ?? "unknown");
  const appointmentPayload =
    payload.appointment && typeof payload.appointment === "object" && !Array.isArray(payload.appointment)
      ? payload.appointment as Record<string, unknown>
      : null;
  const appointmentId =
    appointmentPayload && typeof appointmentPayload.id === "string"
      ? appointmentPayload.id
      : null;
  const appointmentVersion =
    appointmentPayload && typeof appointmentPayload.dateUpdated === "string"
      ? appointmentPayload.dateUpdated
      : appointmentPayload && typeof appointmentPayload.dateAdded === "string"
        ? appointmentPayload.dateAdded
        : null;
  const providerEventId =
    typeof payload.webhookId === "string" ? payload.webhookId :
    typeof payload.id === "string" ? payload.id :
    appointmentId ? `${eventType}:${appointmentId}:${appointmentVersion ?? "unknown"}` :
    null;

  const db = getDb();

  if (providerEventId) {
    const [existing] = await db.select({ id: schema.webhookEvents.id })
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerEventId, providerEventId))
      .limit(1);
    if (existing) return reply.code(200).send({ ok: true, duplicate: true });
  }

  await db.insert(schema.webhookEvents).values({
    providerEventId,
    eventType,
    payload,
    processingStatus: "pending"
  });

  return reply.code(202).send({ ok: true });
});

app.get("/walkthroughs/:walkthroughId", {
  preHandler: requireInternalAuth
}, async (request, reply) => {
  const { walkthroughId } = request.params as { walkthroughId: string };
  const db = getDb();
  const [walkthrough] = await db.select().from(schema.walkthroughs)
    .where(eq(schema.walkthroughs.id, walkthroughId))
    .limit(1);
  if (!walkthrough) return reply.code(404).send({ error: "walkthrough_not_found" });
  return walkthrough;
});

app.post("/walkthroughs/:contactId/audio", {
  preHandler: requireInternalAuth
}, async (request, reply) => {
  const { contactId } = request.params as { contactId: string };
  const db = getDb();

  const [contact] = await db.select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId))
    .limit(1);
  if (!contact) return reply.code(404).send({ error: "contact_not_found" });

  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "audio_file_required" });

  const audio = await file.toBuffer();
  if (!audio.length) return reply.code(400).send({ error: "audio_file_empty" });

  const objectKey = `walkthroughs/${contactId}/${randomUUID()}-${file.filename || "walkthrough.webm"}`;
  await putObject(objectKey, audio, file.mimetype || "application/octet-stream");

  const transcript = await transcribeWalkthrough(
    audio,
    file.filename || "walkthrough.webm",
    file.mimetype || "audio/webm"
  );
  const extraction = await extractWalkthrough(transcript);

  const [walkthrough] = await db.insert(schema.walkthroughs).values({
    contactId,
    status: "draft",
    audioObjectKey: objectKey,
    transcript,
    extraction
  }).returning();

  return reply.code(201).send({ walkthrough });
});

app.post("/walkthroughs/:walkthroughId/approve", {
  preHandler: requireInternalAuth
}, async (request, reply) => {
  const { walkthroughId } = request.params as { walkthroughId: string };
  const body = (request.body ?? {}) as { extraction?: unknown; approvedBy?: string };
  const db = getDb();

  const [walkthrough] = await db.select().from(schema.walkthroughs)
    .where(eq(schema.walkthroughs.id, walkthroughId))
    .limit(1);
  if (!walkthrough) return reply.code(404).send({ error: "walkthrough_not_found" });

  const extraction = walkthroughExtractionSchema.parse(body.extraction ?? walkthrough.extraction);
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
      approvedBy: body.approvedBy ?? "portal",
      updatedAt: new Date()
    }).where(eq(schema.walkthroughs.id, walkthroughId));

    await tx.insert(schema.auditLogs).values({
      actor: body.approvedBy ?? "portal",
      action: "walkthrough.approve",
      entity: "walkthrough",
      entityId: walkthroughId,
      oldValue: walkthrough.extraction,
      newValue: extraction,
      source: "portal"
    });

    return { jobId };
  });

  return reply.send({ ok: true, ...result, extraction });
});

const port = Number(process.env.API_PORT ?? 4100);
await app.listen({ host: "0.0.0.0", port });
