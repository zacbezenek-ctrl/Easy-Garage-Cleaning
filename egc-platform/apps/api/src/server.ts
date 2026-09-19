import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import rawBody from "fastify-raw-body";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { extractWalkthrough, transcribeWalkthrough } from "@egc/ai";
import { walkthroughExtractionSchema } from "@egc/schemas";
import { putObject } from "@egc/storage";
import { verifyGhlWebhook } from "./webhook-signature.js";
import { registerOperationsRoutes } from "./operations.js";

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

function formatWalkthroughNote(
  extraction: ReturnType<typeof walkthroughExtractionSchema.parse>,
  jobId: string
) {
  const lines = [
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
  ];

  return lines.join("\n").slice(0, 4500);
}

app.get("/health", async (_request, reply) => {
  try {
    await getDb().select({ id: schema.contacts.id }).from(schema.contacts).limit(1);
    return { ok: true, service: "egc-api", database: "ready" };
  } catch {
    return reply.code(503).send({ ok: false, service: "egc-api", database: "not_ready" });
  }
});

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
  const bodyDigest = createHash("sha256").update(raw).digest("hex");
  const providerEventId =
    typeof payload.webhookId === "string" && payload.webhookId.length > 0
      ? payload.webhookId
      : `sha256:${bodyDigest}`;

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
  if (walkthrough.status === "approved") {
    return reply.code(409).send({ error: "walkthrough_already_approved", jobId: walkthrough.jobId });
  }

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

    let ghlWritebackQueued = false;
    if (process.env.GHL_WRITEBACK_ENABLED === "true") {
      const [contact] = await tx.select({
        providerId: schema.contacts.providerId
      }).from(schema.contacts)
        .where(eq(schema.contacts.id, walkthrough.contactId))
        .limit(1);

      if (contact?.providerId) {
        await tx.insert(schema.outboxEvents).values({
          type: "ghl.walkthrough_note.sync",
          entityId: walkthroughId,
          payload: {
            ghlContactId: contact.providerId,
            walkthroughId,
            jobId,
            noteBody: formatWalkthroughNote(extraction, jobId)
          },
          processingStatus: "pending"
        }).onConflictDoNothing({
          target: [schema.outboxEvents.type, schema.outboxEvents.entityId]
        });

        await tx.insert(schema.auditLogs).values({
          actor: body.approvedBy ?? "portal",
          action: "walkthrough.ghl_sync_queued",
          entity: "walkthrough",
          entityId: walkthroughId,
          newValue: { jobId },
          source: "portal"
        });

        ghlWritebackQueued = true;
      }
    }

    return { jobId, ghlWritebackQueued };
  });

  return reply.send({ ok: true, ...result, extraction });
});

await registerOperationsRoutes(app);

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4100);
await app.listen({ host: "0.0.0.0", port });
