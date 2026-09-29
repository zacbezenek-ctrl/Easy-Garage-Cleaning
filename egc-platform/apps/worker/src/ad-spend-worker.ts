import {adSpendConfig,publishAdSpendConfiguration,SOURCES,sourceActive,syncAdSpend,type AdSpendConfig} from "@egc/ad-spend";

/** Only bounded aggregates are loggable: never a token, provider body or exception text. */
export function adSpendSyncLog(result: unknown) {
  const row = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
  const sources = Array.isArray(row.sources) ? row.sources : [];
  const summary: Record<string, string | number | boolean | null> = { event: "ad_spend_sync" };
  for (const name of SOURCES) {
    const source = sources.find(s => s && typeof s === "object" && (s as Record<string, unknown>).source === name) as Record<string, unknown> | undefined;
    const accounts = Array.isArray(source?.accounts) ? source.accounts as Record<string, unknown>[] : [];
    const sum = (key: string) => accounts.every(a => Number.isSafeInteger(a?.[key]) && Number(a[key]) >= 0) ? accounts.reduce((total, a) => total + Number(a[key]), 0) : null;
    summary[`${name}Active`] = typeof source?.active === "boolean" ? source.active : null;
    summary[`${name}Ok`] = typeof source?.ok === "boolean" ? source.ok : null;
    summary[`${name}FailedAccounts`] = source ? accounts.filter(a => a?.ok !== true).length : null;
    summary[`${name}PulledDays`] = source ? sum("pulledDays") : null;
    summary[`${name}RestatedDays`] = source ? sum("restatedDays") : null;
  }
  return summary;
}

type Sync = (options: { config: AdSpendConfig }) => Promise<unknown>;
/** Read-only ad spend and lead-form ingestion. The non-secret configuration is always
 * published (so coverage reports "not connected" truthfully); providers are only
 * contacted when EGC_AD_SPEND_META_ENABLED / EGC_AD_SPEND_GOOGLE_ENABLED is exactly "true". */
export function startAdSpendWorker({
  sync = syncAdSpend,
  publish = publishAdSpendConfiguration,
  intervalMs = 60 * 60_000,
  logger = console,
  env = process.env
}: {
  sync?: Sync;
  publish?: (config: AdSpendConfig) => Promise<unknown>;
  intervalMs?: number;
  logger?: Pick<Console, "error"> & Partial<Pick<Console, "info">>;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const config = adSpendConfig(env);
  if (!SOURCES.some(source => sourceActive(config, source))) {
    void publish(config).catch(() => logger.error("Ad spend configuration could not be published; spend coverage reports the platforms as not connected."));
    return () => {};
  }
  let running = false;
  let stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const result = await sync({ config });
      logger.info?.(JSON.stringify({ ...adSpendSyncLog(result), observedAt: new Date().toISOString() }));
    } catch {
      logger.error("Ad spend sync failed; inspect ad spend health for sanitized diagnostics.");
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
