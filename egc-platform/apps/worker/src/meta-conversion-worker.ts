import { syncConversions } from "@egc/meta-conversions";

type Sync = (options: { dryRun: boolean; limit: number; days: number }) => Promise<unknown>;

/** Reconciliation and the durable sender run independently of GHL availability. */
export function startMetaConversionWorker({
  sync = syncConversions,
  intervalMs = 60_000,
  logger = console
}: {
  sync?: Sync;
  intervalMs?: number;
  logger?: Pick<Console, "error">;
} = {}) {
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      // The service controls mode, activation time, event age, backoff, and
      // database claims. Local exclusion also avoids overlapping scans.
      await sync({ dryRun: false, limit: 100, days: 7 });
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
