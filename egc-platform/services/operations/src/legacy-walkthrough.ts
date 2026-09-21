import { eq } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { walkthroughExtractionSchema, type WalkthroughExtraction } from "@egc/schemas";

type Db = ReturnType<typeof getDb>;
type Walkthrough = typeof schema.walkthroughs.$inferSelect;
const managedFields = ["portalVisitId", "portalJobId", "portalCustomerId", "portalProjectId", "portalRevision", "uploadRequestId", "uploadedBy", "approvalRequestId", "approvedRevision", "approvalPayload", "approvalFingerprint"] as const;

export class LegacyWalkthroughError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 409) { super(code); }
}

/** Rollback compatibility never grants the legacy reviewer authority over Hub records. */
export function isManagedWalkthrough(row: Partial<Walkthrough>): boolean {
  return managedFields.some(key => row[key] !== null && row[key] !== undefined);
}

export function assertLegacyWalkthroughAllowed(env: NodeJS.ProcessEnv, row?: Partial<Walkthrough>): void {
  if (env.EGC_OPERATIONS_ENABLED === "true" || (row && isManagedWalkthrough(row))) {
    throw new LegacyWalkthroughError("use_employee_hub_recording_review");
  }
}

function formatNote(extraction: WalkthroughExtraction, jobId: string): string {
  const list = (items: string[]) => items.length ? items.join("; ") : "None noted";
  return [
    "EGC WALKTHROUGH — APPROVED", `Job ID: ${jobId}`, `Garage size: ${extraction.garageSize}`,
    `Estimated junk: ${extraction.junkVolumeYards ?? "unknown"} yd³`, `Estimated labor: ${extraction.estimatedLaborHours ?? "unknown"} hours`, "",
    `REMOVE: ${list(extraction.itemsRemove)}`, `KEEP: ${list(extraction.itemsKeep)}`, `RELOCATE: ${list(extraction.itemsRelocate)}`,
    `STORAGE: ${list(extraction.storageRequirements)}`, `BIKE RACKS: ${extraction.bikeRacks}`, `TOOL RACKS: ${extraction.toolRacks}`,
    `SHELVING: ${list(extraction.shelving)}`, `PRESSURE WASHING: ${extraction.pressureWashing ? "Yes" : "No"}`,
    `PEST OBSERVATIONS: ${list(extraction.pestObservations)}`, `ACTIVE INFESTATION KNOWN: ${extraction.activeInfestation === null ? "Unknown" : extraction.activeInfestation ? "Yes" : "No"}`,
    `ACCESS: ${extraction.accessNotes ?? "None noted"}`, "", `CUSTOMER PREFERENCES: ${list(extraction.customerPreferences)}`,
    `CUSTOMER OBJECTIONS: ${list(extraction.customerObjections)}`, `SALES NOTES: ${list(extraction.salesNotes)}`,
    `CREW NOTES: ${list(extraction.crewNotes)}`, `PRICING NOTES: ${list(extraction.pricingNotes)}`
  ].join("\n").slice(0, 4500);
}

/** Only the pre-activation legacy flow may commit scope to its PostgreSQL job.
 * The locked draft is the cross-entrypoint idempotency boundary: API and MCP
 * cannot race to create separate jobs or approve a managed recording. */
export async function approveLegacyWalkthrough(input: {
  walkthroughId: string; extraction?: unknown; actor: string; source: "mcp" | "portal";
}, env: NodeJS.ProcessEnv = process.env, db: Db = getDb()) {
  assertLegacyWalkthroughAllowed(env);
  return db.transaction(async tx => {
    const [existing] = await tx.select().from(schema.walkthroughs).where(eq(schema.walkthroughs.id, input.walkthroughId)).for("update");
    if (!existing) throw new LegacyWalkthroughError("walkthrough_not_found", 404);
    assertLegacyWalkthroughAllowed(env, existing);
    if (existing.status !== "draft") throw new LegacyWalkthroughError(existing.status === "approved" ? "walkthrough_already_approved" : "walkthrough_not_editable");
    if (!existing.contactId) throw new LegacyWalkthroughError("walkthrough_contact_required");
    const [contact] = await tx.select().from(schema.contacts).where(eq(schema.contacts.id, existing.contactId)).for("share");
    if (!contact) throw new LegacyWalkthroughError("contact_not_found", 404);
    const parsed = walkthroughExtractionSchema.safeParse(input.extraction ?? existing.extraction);
    if (!parsed.success) throw new LegacyWalkthroughError("invalid_walkthrough_extraction", 400);
    const extraction = parsed.data;
    const now = new Date();
    const scope = {
      status: "scope_approved", garageSize: extraction.garageSize,
      junkVolumeYards: extraction.junkVolumeYards === null ? null : String(extraction.junkVolumeYards),
      itemsRemove: extraction.itemsRemove, itemsKeep: extraction.itemsKeep, itemsRelocate: extraction.itemsRelocate,
      organizationRequirements: extraction.storageRequirements,
      addOns: [...(extraction.bikeRacks > 0 ? [`${extraction.bikeRacks} bike rack(s)`] : []), ...(extraction.toolRacks > 0 ? [`${extraction.toolRacks} tool rack(s)`] : []), ...(extraction.shelving.length ? ["shelving"] : []), ...(extraction.pressureWashing ? ["pressure washing"] : [])],
      accessNotes: extraction.accessNotes, estimatedLaborHours: extraction.estimatedLaborHours === null ? null : String(extraction.estimatedLaborHours), updatedAt: now
    };
    let job: typeof schema.jobs.$inferSelect | undefined;
    if (existing.jobId) {
      const [linked] = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, existing.jobId)).for("update");
      if (!linked || linked.contactId !== existing.contactId) throw new LegacyWalkthroughError("job_not_found_for_contact");
      [job] = await tx.update(schema.jobs).set(scope).where(eq(schema.jobs.id, linked.id)).returning();
    } else {
      [job] = await tx.insert(schema.jobs).values({contactId: existing.contactId, ...scope}).returning();
    }
    if (!job) throw new LegacyWalkthroughError("walkthrough_job_write_failed", 503);
    await tx.update(schema.walkthroughs).set({jobId: job.id, status: "approved", extraction, approvedAt: now, approvedBy: input.actor, updatedAt: now}).where(eq(schema.walkthroughs.id, existing.id));
    await tx.insert(schema.auditLogs).values({actor: input.actor, action: "walkthrough.approve", entity: "walkthrough", entityId: existing.id, oldValue: existing.extraction, newValue: extraction, source: input.source});
    let ghlWritebackQueued = false;
    if (env.GHL_WRITEBACK_ENABLED === "true" && contact.provider === "ghl" && contact.providerId) {
      const type = input.source === "portal" ? "ghl.walkthrough_note.sync" : "ghl.contact_note.sync";
      const entityId = input.source === "portal" ? existing.id : `${existing.id}:approved`;
      await tx.insert(schema.outboxEvents).values({type, entityId, payload: {ghlContactId: contact.providerId, walkthroughId: existing.id, jobId: job.id, title: "EGC Walkthrough — Approved Scope", noteBody: formatNote(extraction, job.id)}, processingStatus: "pending"}).onConflictDoNothing({target: [schema.outboxEvents.type, schema.outboxEvents.entityId]});
      await tx.insert(schema.auditLogs).values({actor: input.actor, action: "ghl.walkthrough_note.queued", entity: "walkthrough", entityId: existing.id, newValue: {jobId: job.id}, source: input.source});
      ghlWritebackQueued = true;
    }
    return {ok: true, jobId: job.id, ghlWritebackQueued, extraction, job};
  });
}
