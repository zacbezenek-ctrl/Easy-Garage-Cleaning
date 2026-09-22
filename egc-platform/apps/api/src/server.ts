import {registerGhlWebhook} from "./webhooks.js";
import { createHash } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import rawBody from "fastify-raw-body";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { verifyGhlWebhook } from "./webhook-signature.js";
import { registerOperationsRoutes } from "./operations.js";
import { registerRecordingRoutes } from "./recordings.js";
import { registerLegacyWalkthroughRoutes } from "./legacy-walkthroughs.js";
import { registerIntelligenceRoutes } from './intelligence.js';

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

app.get("/health", async (_request, reply) => {
  try {
    await getDb().select({ id: schema.communicationExecutions.id }).from(schema.communicationExecutions).limit(1);
    await getDb().select({ id: schema.customerEvents.eventId }).from(schema.customerEvents).limit(1);
    return { ok: true, service: "egc-api", database: "ready",release:process.env.RAILWAY_GIT_COMMIT_SHA??process.env.EGC_RELEASE_SHA??null,operationsEnabled:process.env.EGC_OPERATIONS_ENABLED==="true" };
  } catch {
    return reply.code(503).send({ ok: false, service: "egc-api", database: "not_ready" });
  }
});

await registerGhlWebhook(app);

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

// Preserve the existing workflow until the signed Hub rollout is activated.
// Managed recordings cannot use legacy scope promotion in either flag state.
await registerLegacyWalkthroughRoutes(app, requireInternalAuth);
await registerRecordingRoutes(app);
await registerOperationsRoutes(app);
await registerIntelligenceRoutes(app,requireInternalAuth);

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4100);
await app.listen({ host: "0.0.0.0", port });
