import type { AdSpendConfig } from "./config.js";
import { parseInstant, validDate } from "./dates.js";
import { countValue, decimalCents } from "./money.js";
import { ProviderFailure, providerId, providerJson, providerName, record, type DateRange, type DayTotal, type LeadgenProvider, type SpendProvider, type SpendReport, type SpendRow } from "./provider.js";

// Graph error codes for throttling (application, user, ad account and business use case limits).
const RATE_LIMIT = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

/** Read-only Marketing API client. The token travels only in the Authorization header,
 * paging follows the returned cursor (never the provider's `next` URL), and only GETs exist. */
export function metaProvider(config: AdSpendConfig, fetcher: typeof fetch = fetch): SpendProvider & LeadgenProvider {
  async function graph(path: string, params: Record<string, string>) {
    const url = new URL(`https://graph.facebook.com/${config.meta.apiVersion}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const { status, ok, body } = await providerJson(fetcher, url, { method: "GET", headers: { Authorization: `Bearer ${config.meta.accessToken}`, Accept: "application/json" } }, "meta");
    const value = record(body), error = record(value?.error);
    if (!ok || !value || error) {
      const code = typeof error?.code === "number" ? error.code : null;
      throw new ProviderFailure(status === 429 || (code !== null && RATE_LIMIT.has(code)) ? "meta_rate_limited"
        : status === 401 || code === 190 ? "meta_auth_failed" : status === 403 || code === 10 || code === 200 ? "meta_permission_denied" : "meta_api_rejected", status);
    }
    return value;
  }
  async function edge(path: string, params: Record<string, string>, maxPages = 100) {
    const rows: Record<string, unknown>[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body = await graph(path, { ...params, ...(after ? { after } : {}) });
      if (!Array.isArray(body.data)) throw new ProviderFailure("meta_malformed_response");
      for (const row of body.data) rows.push(record(row) ?? (() => { throw new ProviderFailure("meta_malformed_response"); })());
      const paging = record(body.paging), cursor = record(paging?.cursors)?.after;
      if (typeof paging?.next !== "string" || typeof cursor !== "string" || !cursor || cursor === after) return rows;
      after = cursor;
    }
    throw new ProviderFailure("meta_page_limit_exceeded");
  }
  return {
    source: "meta_ads",
    async account(accountId) {
      const body = await graph(`act_${accountId}`, { fields: "timezone_name,currency" });
      return { timeZone: body.timezone_name, currency: body.currency };
    },
    async spend(accountId, range) {
      const common = { time_increment: "1", time_range: JSON.stringify({ since: range.from, until: range.to }), limit: "500" };
      // Account level is the authoritative day total; ad set level is the breakdown.
      const totals = await edge(`act_${accountId}/insights`, { ...common, level: "account", fields: "spend,impressions,clicks,date_start,date_stop" });
      const breakdown = await edge(`act_${accountId}/insights`, { ...common, level: "adset", fields: "campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,date_start,date_stop" });
      return normalizeMetaInsights(totals, breakdown, range);
    },
    async leadForms(pageId) {
      const rows = await edge(`${pageId}/leadgen_forms`, { fields: "id,name,status", limit: "100" });
      return rows.map(row => {
        const id = providerId(row.id);
        if (!id) throw new ProviderFailure("meta_malformed_response");
        return { id, name: providerName(row.name) };
      });
    },
    async formLeads(formId, since, until) {
      // Only the lead id and its creation instant are requested: never field_data (PII).
      const filtering = JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since / 1000) - 1 }]);
      const rows = await edge(`${formId}/leads`, { fields: "id,created_time", filtering, limit: "500" }, 200);
      return rows.map(row => {
        const id = providerId(row.id), createdAt = parseInstant(row.created_time);
        if (!id || createdAt === null) throw new ProviderFailure("meta_malformed_response");
        return { id, createdAt };
      }).filter(lead => lead.createdAt >= since && lead.createdAt < until);
    }
  };
}

// Meta omits a metric it was not asked for; a requested but malformed value fails the pull.
function metric(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const count = countValue(value);
  if (count === null) throw new ProviderFailure("provider_value_invalid");
  return count;
}
function day(row: Record<string, unknown>, range: DateRange): string {
  const date = row.date_start;
  if (!validDate(date) || row.date_stop !== date || date < range.from || date > range.to) throw new ProviderFailure("provider_row_out_of_range");
  return date;
}
function cents(value: unknown): number {
  const amount = decimalCents(value);
  if (amount === null) throw new ProviderFailure("provider_value_invalid");
  return amount;
}
export function normalizeMetaInsights(totalRows: Record<string, unknown>[], breakdownRows: Record<string, unknown>[], range: DateRange): SpendReport {
  const totals = new Map<string, DayTotal>();
  for (const row of totalRows) {
    const date = day(row, range);
    if (totals.has(date)) throw new ProviderFailure("provider_duplicate_row");
    totals.set(date, { spendCents: cents(row.spend), impressions: metric(row.impressions), clicks: metric(row.clicks) });
  }
  const rows: SpendRow[] = [], keys = new Set<string>();
  for (const row of breakdownRows) {
    const reportDate = day(row, range), campaignId = providerId(row.campaign_id), adSetId = providerId(row.adset_id);
    if (!campaignId || !adSetId) throw new ProviderFailure("meta_malformed_response");
    const key = `${reportDate}|${campaignId}|${adSetId}`;
    if (keys.has(key)) throw new ProviderFailure("provider_duplicate_row");
    keys.add(key);
    rows.push({ level: "ad_set", campaignId, campaignName: providerName(row.campaign_name), adSetId, adSetName: providerName(row.adset_name),
      reportDate, spendCents: cents(row.spend), impressions: metric(row.impressions), clicks: metric(row.clicks) });
  }
  return { totals, rows };
}
