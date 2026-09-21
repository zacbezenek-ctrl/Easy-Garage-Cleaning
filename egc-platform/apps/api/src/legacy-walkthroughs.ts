import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { extractWalkthrough, transcribeWalkthrough } from "@egc/ai";
import { putObject } from "@egc/storage";
import { approveLegacyWalkthrough, assertLegacyWalkthroughAllowed, LegacyWalkthroughError } from "@egc/operations";
import { z } from "zod";

type Dependencies = {
  contactExists: (id: string) => Promise<boolean>;
  save: (contactId: string, audio: Buffer, filename: string, mimetype: string) => Promise<unknown>;
  approve: (id: string, extraction: unknown) => Promise<unknown>;
};

export async function registerLegacyWalkthroughRoutes(app: FastifyInstance,
  requireInternalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env, overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    contactExists: async id => !!(await getDb().select({id: schema.contacts.id}).from(schema.contacts).where(eq(schema.contacts.id, id)).limit(1))[0],
    save: async (contactId, audio, filename, mimetype) => {
      // Filename never becomes a path component controlled by the uploader.
      const objectKey = `walkthroughs/${contactId}/${randomUUID()}-walkthrough`;
      await putObject(objectKey, audio, mimetype);
      const transcript = await transcribeWalkthrough(audio, filename, mimetype);
      const extraction = await extractWalkthrough(transcript);
      assertLegacyWalkthroughAllowed(env);
      const [walkthrough] = await getDb().insert(schema.walkthroughs).values({contactId, status: "draft", audioObjectKey: objectKey, transcript, extraction}).returning();
      if (!walkthrough) throw new LegacyWalkthroughError("walkthrough_create_failed", 503);
      return walkthrough;
    },
    approve: (id, extraction) => approveLegacyWalkthrough({walkthroughId: id, extraction, actor: "portal", source: "portal"}, env),
    ...overrides
  };
  const failure = (error: unknown, reply: FastifyReply) => {
    if (error instanceof LegacyWalkthroughError) return reply.code(error.statusCode).send({error: error.code});
    // AI/storage/provider errors may contain customer content or credentials.
    return reply.code(503).send({error: "legacy_walkthrough_processing_failed"});
  };
  app.post("/walkthroughs/:contactId/audio", {preHandler: requireInternalAuth}, async (request, reply) => {
    try {
      assertLegacyWalkthroughAllowed(env);
      const id = z.string().uuid().safeParse((request.params as {contactId: string}).contactId);
      if (!id.success) return reply.code(400).send({error: "invalid_contact_id"});
      if (!await deps.contactExists(id.data)) return reply.code(404).send({error: "contact_not_found"});
      const file = await request.file();
      if (!file) return reply.code(400).send({error: "audio_required"});
      const audio = await file.toBuffer();
      if (!audio.length) return reply.code(400).send({error: "audio_empty"});
      const walkthrough = await deps.save(id.data, audio, file.filename || "walkthrough.webm", file.mimetype || "audio/webm");
      return reply.code(201).send({walkthrough});
    } catch (error) { return failure(error, reply); }
  });
  app.post("/walkthroughs/:walkthroughId/approve", {preHandler: requireInternalAuth}, async (request, reply) => {
    try {
      assertLegacyWalkthroughAllowed(env);
      const id = z.string().uuid().safeParse((request.params as {walkthroughId: string}).walkthroughId);
      if (!id.success) return reply.code(400).send({error: "invalid_walkthrough_id"});
      const body = z.object({extraction: z.unknown().optional()}).safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({error: "invalid_walkthrough_request"});
      return await deps.approve(id.data, body.data.extraction);
    } catch (error) { return failure(error, reply); }
  });
}
