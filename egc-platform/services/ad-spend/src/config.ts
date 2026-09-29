import { validDate } from "./dates.js";

export const API_SOURCES = ["meta_ads", "google_ads"] as const;
export const SOURCES = ["meta_ads", "google_ads", "meta_leadgen"] as const;
export type SpendSource = typeof API_SOURCES[number];
export type AdSource = typeof SOURCES[number];
/** A day is re-pulled until it is older than this many complete days (provider restatement). */
export const RESTATEMENT_DAYS = 3;
/** Meta returns lead-form leads for 90 days only: an older day pulled for the first time
 * would read as zero, so it is never pulled and stays unknown. */
export const LEADGEN_RETENTION_DAYS = 90;
export const CONFIG_CURSOR = "ad_spend:config";
const META_ID = /^\d{1,20}$/, GOOGLE_ID = /^\d{10}$/;
const ids = (value: string | undefined, normalize: (id: string) => string) =>
  [...new Set((value ?? "").split(",").map(id => normalize(id.trim())).filter(Boolean))];

/** Both ingestions are read-only toward the providers and default off. */
export function adSpendConfig(env: NodeJS.ProcessEnv = process.env) {
  const start = (env.EGC_AD_SPEND_START_DATE ?? "").trim();
  return {
    startDate: validDate(start) ? start : null,
    warnings: start && !validDate(start) ? ["invalid_start_date"] : [],
    meta: {
      enabled: env.EGC_AD_SPEND_META_ENABLED === "true",
      accessToken: env.META_ADS_ACCESS_TOKEN ?? "",
      accountIds: ids(env.META_ADS_ACCOUNT_IDS, id => id.replace(/^act_/, "")),
      pageIds: ids(env.META_LEADGEN_PAGE_IDS, id => id),
      apiVersion: /^v\d{1,3}\.0$/.test(env.META_ADS_API_VERSION ?? "") ? env.META_ADS_API_VERSION! : "v25.0"
    },
    google: {
      enabled: env.EGC_AD_SPEND_GOOGLE_ENABLED === "true",
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
      clientId: env.GOOGLE_ADS_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET ?? "",
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN ?? "",
      customerIds: ids(env.GOOGLE_ADS_CUSTOMER_IDS, id => id.replace(/-/g, "")),
      loginCustomerId: (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "").trim().replace(/-/g, ""),
      apiVersion: /^v\d{2,3}$/.test(env.GOOGLE_ADS_API_VERSION ?? "") ? env.GOOGLE_ADS_API_VERSION! : "v23"
    }
  };
}
export type AdSpendConfig = ReturnType<typeof adSpendConfig>;

export function sourceBlockers(config: AdSpendConfig, source: AdSource): string[] {
  if (source === "google_ads") {
    const g = config.google;
    return [...(!g.enabled ? ["flag_off"] : []), ...(!g.developerToken ? ["developer_token_missing"] : []),
      ...(!g.clientId || !g.clientSecret ? ["oauth_client_missing"] : []), ...(!g.refreshToken ? ["refresh_token_missing"] : []),
      ...(!g.customerIds.length ? ["customer_ids_missing"] : []),
      ...(g.customerIds.some(id => !GOOGLE_ID.test(id)) || (g.loginCustomerId && !GOOGLE_ID.test(g.loginCustomerId)) ? ["invalid_customer_ids"] : [])];
  }
  const m = config.meta, common = [...(!m.enabled ? ["flag_off"] : []), ...(!m.accessToken ? ["access_token_missing"] : [])];
  if (source === "meta_leadgen") return [...common, ...(!m.pageIds.length ? ["page_ids_missing"] : []), ...(m.pageIds.some(id => !META_ID.test(id)) ? ["invalid_page_ids"] : [])];
  return [...common, ...(!m.accountIds.length ? ["account_ids_missing"] : []), ...(m.accountIds.some(id => !META_ID.test(id)) ? ["invalid_account_ids"] : [])];
}
export const sourceAccounts = (config: AdSpendConfig, source: AdSource) =>
  source === "google_ads" ? config.google.customerIds : source === "meta_leadgen" ? config.meta.pageIds : config.meta.accountIds;
export const sourceActive = (config: AdSpendConfig, source: AdSource) => sourceBlockers(config, source).length === 0;

export type SourcePublication = { active: boolean; accountIds: string[]; blockers: string[] };
export type PublishedConfiguration = { version: 1; publishedAt: string; restatementDays: number; startDate: string | null; warnings: string[]; sources: Record<AdSource, SourcePublication> };
/** Non-secret configuration the worker publishes to sync_cursors, so the API can tell which
 * platforms are connected without holding any provider credential. */
export function publishedConfiguration(config: AdSpendConfig, now: Date): PublishedConfiguration {
  const sources = Object.fromEntries(SOURCES.map(source => {
    const blockers = sourceBlockers(config, source);
    return [source, { active: blockers.length === 0, accountIds: blockers.length ? [] : [...sourceAccounts(config, source)], blockers }];
  })) as Record<AdSource, SourcePublication>;
  return { version: 1, publishedAt: now.toISOString(), restatementDays: RESTATEMENT_DAYS, startDate: config.startDate, warnings: [...config.warnings], sources };
}
const strings = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(v => typeof v === "string" && v.length > 0 && v.length <= 80);
export function parsePublishedConfiguration(value: string | null | undefined): PublishedConfiguration | null {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value)); } catch { return null; }
  const record = parsed as Partial<PublishedConfiguration> | null;
  if (!record || record.version !== 1 || typeof record.publishedAt !== "string" || !Number.isFinite(Date.parse(record.publishedAt))
    || record.restatementDays !== RESTATEMENT_DAYS || !record.sources || typeof record.sources !== "object") return null;
  for (const source of SOURCES) {
    const entry = record.sources[source];
    if (!entry || typeof entry.active !== "boolean" || !strings(entry.accountIds, 50) || !strings(entry.blockers, 20) || (entry.active && !entry.accountIds.length)) return null;
  }
  return { version: 1, publishedAt: record.publishedAt, restatementDays: RESTATEMENT_DAYS, startDate: validDate(record.startDate) ? record.startDate : null,
    warnings: strings(record.warnings, 20) ? record.warnings : [], sources: record.sources };
}
