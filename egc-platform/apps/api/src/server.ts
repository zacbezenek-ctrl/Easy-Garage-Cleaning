import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { verifyGhlWebhook } from "./webhook-signature.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, service: "egc-api" }));

app.post("/webhooks/ghl", {
  config: { rawBody: true }
}, async (request, reply) => {
  const raw = Buffer.from(JSON.stringify(request.body ?? {}));
  const signature = request.headers["x-ghl-signature"];
  const signatureValue = Array.isArray(signature) ? signature[0] : signature;

  if (!verifyGhlWebhook(raw, signatureValue)) {
    return reply.code(401).send({ error: "invalid_signature" });
  }

  const payload = (request.body ?? {}) as Record<string, unknown>;
  const eventType = String(payload.type ?? payload.eventType ?? "unknown");
  const providerEventId = typeof payload.id === "string" ? payload.id : null;
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

const port = Number(process.env.API_PORT ?? 4100);
await app.listen({ host: "0.0.0.0", port });
