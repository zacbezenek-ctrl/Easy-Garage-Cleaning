import { and, asc, gt, notInArray } from "drizzle-orm";
import { getDb, schema } from "@egc/database";
import { buildDueWorkSnapshot, collectTaskPages } from "./operations-core.js";

/**
 * Internal read adapter; deliberately NOT registered as an API or MCP tool yet.
 * The caller must enforce role access before invoking this service. This reads
 * the existing tasks table, NOT a new task store and NOT the portal calendar.
 * No exception is converted to an empty/successful queue.
 */
export async function readExistingTaskQueue(options: { dueBefore: string; timeZone: string }) {
  return getDb().transaction(async tx => {
    const generatedAt = new Date();
    const tasks = await collectTaskPages(async (afterId, pageSize) => {
      const conditions = [notInArray(schema.tasks.status, ["completed", "cancelled", "superseded"])];
      if (afterId) conditions.push(gt(schema.tasks.id, afterId));
      // No lead-created-at, booking, interaction-direction, or arbitrary age filter.
      // Undated/ownerless rows must be included to generate visible exceptions.
      return tx.select({
        id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status,
        priority: schema.tasks.priority, dueAt: schema.tasks.dueAt,
        assignedUserId: schema.tasks.assignedUserId,
        contactId: schema.tasks.contactId, jobId: schema.tasks.jobId
      }).from(schema.tasks).where(and(...conditions)).orderBy(asc(schema.tasks.id)).limit(pageSize);
    });
    const snapshot = buildDueWorkSnapshot({
      id: globalThis.crypto.randomUUID(), generatedAt, dueBefore: options.dueBefore,
      timeZone: options.timeZone, tasks,
      requiredSources: ["platform_tasks", "portal_project_mapping", "communication_obligations"],
      coverage: [
        { source: "platform_tasks", status: "fresh", complete: true, asOf: generatedAt },
        { source: "portal_project_mapping", status: "unknown", complete: false, asOf: null },
        { source: "communication_obligations", status: "unknown", complete: false, asOf: null }
      ]
    });
    return {
      persisted: false as const,
      authority: "existing_platform_tasks_only" as const,
      portalParityVerified: false as const,
      snapshot
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
