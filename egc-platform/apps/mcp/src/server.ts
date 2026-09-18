import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { eq, desc } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import {
  callTranscriptsForContact,
  leadsNeedingContact,
  leadsNotResponding,
  recentBookings
} from "@egc/lead-audit";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value }
  };
}

function buildServer() {
  const server = new McpServer(
    { name: "easy-garage-cleaning", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  server.registerTool("egc.leads_needing_contact", {
    description: "Return recent leads that still need human contact or human follow-up.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(3) }),
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ days }) => textResult(await leadsNeedingContact(days)));

  server.registerTool("egc.leads_not_responding", {
    description: "Return recent leads that received human outreach but have never replied.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(3) }),
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ days }) => textResult(await leadsNotResponding(days)));

  server.registerTool("egc.recent_bookings", {
    description: "Return bookings created in the requested lookback window, enriched with job scope, opportunity context, recent messages, and call transcripts. Filters on booking creation time, not appointment time.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(3) }),
    annotations: { readOnlyHint: true, destructiveHint: false }
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

      return {
        ...booking,
        job: jobRows[0] ?? null,
        opportunity: opportunityRows[0] ?? null,
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
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ contactId, days }) => textResult(await callTranscriptsForContact(contactId, days)));

  server.registerTool("egc.customer_history", {
    description: "Return a unified read-only history for one customer/contact.",
    inputSchema: z.object({ contactId: z.string().uuid() }),
    annotations: { readOnlyHint: true, destructiveHint: false }
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
    annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ jobId }) => {
    const db = getDb();
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
    if (!job) return textResult({ error: "job_not_found" });
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, job.contactId)).limit(1);
    const notes = await db.select().from(schema.jobNotes).where(eq(schema.jobNotes.jobId, jobId)).orderBy(schema.jobNotes.createdAt);
    return textResult({ job, customer: contact ?? null, notes });
  });

  return server;
}

const token = process.env.MCP_BEARER_TOKEN;
if (!token || token.length < 32) {
  throw new Error("MCP_BEARER_TOKEN must be configured with at least 32 characters");
}

const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === "production" && allowedHosts.length === 0) {
  throw new Error("MCP_ALLOWED_HOSTS is required in production");
}

const app = createMcpExpressApp({
  host: "0.0.0.0",
  ...(allowedHosts.length > 0 ? { allowedHosts } : {})
});
const handler = toNodeHandler(createMcpHandler(buildServer));

app.get("/health", (_req, res) => res.json({ ok: true, service: "egc-mcp" }));

app.all("/mcp", (req, res, next) => {
  const auth = req.header("authorization");
  if (auth !== `Bearer ${token}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}, (req, res) => void handler(req, res, req.body));

const port = Number(process.env.MCP_PORT ?? 4200);
app.listen(port, "0.0.0.0", () => {
  console.log(`EGC MCP listening on :${port}/mcp`);
});
