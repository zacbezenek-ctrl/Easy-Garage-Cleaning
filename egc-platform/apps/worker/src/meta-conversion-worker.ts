import { syncConversions } from "@egc/meta-conversions";

/** Only aggregate, bounded fields are loggable. Never log a raw payload,
 * customer identity, exception, token, or provider response from the sender. */
export function metaSyncLog(result: unknown) {
  const row = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown> : {};
  const summary: Record<string, string | number | boolean | null> = {
    event: "meta_conversion_sync",
    mode: row.mode === "production" || row.mode === "shadow" ? row.mode : "unknown",
    dryRun: typeof row.dryRun === "boolean" ? row.dryRun : null
  };
  for (const key of ["accepted", "newlySent", "pending", "failed", "skipped", "discovered", "alreadySynced", "locallyDeduplicated", "missingValue", "missingAttribution", "requiringHumanReconciliation"]) {
    const value = row[key];
    summary[key] = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  summary.productionBlockerCount = Array.isArray(row.productionBlockers) ? row.productionBlockers.length : null;
  return summary;
}

type Sync = (options: { dryRun: boolean; limit: number; days: number }) => Promise<unknown>;

/** Reconciliation and the durable sender run independently of GHL availability. */
export function startMetaConversionWorker({
  sync = syncConversions,
  intervalMs = 60_000,
  logger = console
}: {
  sync?: Sync;
  intervalMs?: number;
  logger?: Pick<Console, "error"> & Partial<Pick<Console, "info">>;
} = {}) {
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      // The service controls mode, activation time, event age, backoff, and
      // database claims. Local exclusion also avoids overlapping scans.
      const result = await sync({ dryRun: false, limit: 100, days: 7 });
      logger.info?.(JSON.stringify({ ...metaSyncLog(result), observedAt: new Date().toISOString() }));
    } catch {
      logger.error("Meta conversion worker failed; inspect conversion status for sanitized diagnostics.");
    } finally {
      running = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
