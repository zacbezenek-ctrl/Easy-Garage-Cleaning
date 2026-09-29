import type { AdSpendConfig } from "./config.js";
import { validDate } from "./dates.js";
import { countValue, microsCents, parseMicros } from "./money.js";
import { ProviderFailure, providerId, providerJson, providerName, record, type DateRange, type DayTotal, type SpendProvider, type SpendReport, type SpendRow } from "./provider.js";

export async function googleAccessToken(config: AdSpendConfig, fetcher: typeof fetch = fetch): Promise<string> {
  const g = config.google;
  const body = new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: "refresh_token" });
  const response = await providerJson(fetcher, "https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body }, "google");
  const token = record(response.body)?.access_token;
  if (!response.ok || typeof token !== "string" || !/^[\x21-\x7e]{10,4096}$/.test(token)) throw new ProviderFailure("google_auth_failed", response.status);
  return token;
}

/** Read-only Google Ads API client (GAQL searchStream). Queries only interpolate dates
 * that were validated as YYYY-MM-DD; customer ids are validated 10-digit strings. */
export function googleProvider(config: AdSpendConfig, fetcher: typeof fetch = fetch): SpendProvider {
  let token: Promise<string> | null = null;
  const auth = () => token ??= googleAccessToken(config, fetcher).catch(error => { token = null; throw error; });
  async function search(customerId: string, query: string) {
    if (!/^\d{10}$/.test(customerId)) throw new ProviderFailure("invalid_customer_ids");
    const headers: Record<string, string> = { Authorization: `Bearer ${await auth()}`, "developer-token": config.google.developerToken, "Content-Type": "application/json", Accept: "application/json" };
    if (config.google.loginCustomerId) headers["login-customer-id"] = config.google.loginCustomerId;
    const { ok, status, body } = await providerJson(fetcher, `https://googleads.googleapis.com/${config.google.apiVersion}/customers/${customerId}/googleAds:searchStream`,
      { method: "POST", headers, body: JSON.stringify({ query }) }, "google");
    if (!ok) throw new ProviderFailure(status === 401 ? "google_auth_failed" : status === 429 ? "google_rate_limited" : status === 403 ? "google_permission_denied" : "google_ads_rejected", status);
    if (!Array.isArray(body)) throw new ProviderFailure("google_malformed_response", status);
    const rows: Record<string, unknown>[] = [];
    for (const batch of body) {
      const item = record(batch), results = item?.results;
      if (!item || (results !== undefined && !Array.isArray(results))) throw new ProviderFailure("google_malformed_response");
      // A stream that fails after it started still answers 200, with the error as a later
      // batch; a batch that is neither results nor the stream's own metadata is not data.
      if (item.error !== undefined || (results === undefined && item.fieldMask === undefined && item.requestId === undefined)) throw new ProviderFailure("google_stream_failed", status);
      for (const row of (results as unknown[] | undefined) ?? []) rows.push(record(row) ?? (() => { throw new ProviderFailure("google_malformed_response"); })());
      if (rows.length > 200_000) throw new ProviderFailure("google_page_limit_exceeded");
    }
    return rows;
  }
  return {
    source: "google_ads",
    async account(customerId) {
      const [row] = await search(customerId, "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer");
      const customer = record(row?.customer);
      return { timeZone: customer?.timeZone, currency: customer?.currencyCode };
    },
    async spend(customerId, range) {
      if (!validDate(range.from) || !validDate(range.to)) throw new ProviderFailure("provider_report_invalid");
      const where = `WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'`, metrics = "segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks";
      const totals = await search(customerId, `SELECT ${metrics} FROM customer ${where}`);
      const campaigns = await search(customerId, `SELECT campaign.id, campaign.name, ${metrics} FROM campaign ${where}`);
      const adGroups = await search(customerId, `SELECT campaign.id, ad_group.id, ad_group.name, ${metrics} FROM ad_group ${where}`);
      return normalizeGoogleReport(totals, campaigns, adGroups, range);
    }
  };
}

type Metrics = { micros: bigint; impressions: bigint; clicks: bigint };
// proto3 JSON omits zero-valued fields, so an absent Google metric is exactly zero.
function metrics(row: Record<string, unknown>, range: DateRange): Metrics & { date: string } {
  const date = record(row.segments)?.date, values = record(row.metrics) ?? {};
  if (!validDate(date) || date < range.from || date > range.to) throw new ProviderFailure("provider_row_out_of_range");
  const read = (value: unknown) => { const parsed = value === undefined ? 0n : parseMicros(value); if (parsed === null) throw new ProviderFailure("provider_value_invalid"); return parsed; };
  return { date, micros: read(values.costMicros), impressions: read(values.impressions), clicks: read(values.clicks) };
}
function money(value: bigint) { const cents = microsCents(value); if (cents === null) throw new ProviderFailure("provider_value_invalid"); return cents; }
function count(value: bigint) { const n = countValue(value <= 2_147_483_647n ? Number(value) : -1); if (n === null) throw new ProviderFailure("provider_value_invalid"); return n; }
/** Totals come from the customer resource. Ad groups are the ad set rows; spend a campaign
 * has outside any ad group (Performance Max, Smart) becomes one campaign-level row, computed
 * in micros before rounding so the breakdown never double counts. */
export function normalizeGoogleReport(totalRows: Record<string, unknown>[], campaignRows: Record<string, unknown>[], adGroupRows: Record<string, unknown>[], range: DateRange): SpendReport {
  const totals = new Map<string, DayTotal>();
  for (const row of totalRows) {
    const m = metrics(row, range);
    if (totals.has(m.date)) throw new ProviderFailure("provider_duplicate_row");
    totals.set(m.date, { spendCents: money(m.micros), impressions: count(m.impressions), clicks: count(m.clicks) });
  }
  const campaigns = new Map<string, Metrics & { date: string; campaignId: string; name: string | null }>();
  for (const row of campaignRows) {
    const m = metrics(row, range), campaign = record(row.campaign), campaignId = providerId(campaign?.id);
    if (!campaignId) throw new ProviderFailure("google_malformed_response");
    const key = `${m.date}|${campaignId}`;
    if (campaigns.has(key)) throw new ProviderFailure("provider_duplicate_row");
    campaigns.set(key, { ...m, campaignId, name: providerName(campaign?.name) });
  }
  const rows: SpendRow[] = [], grouped = new Map<string, Metrics>(), keys = new Set<string>();
  for (const row of adGroupRows) {
    const m = metrics(row, range), campaignId = providerId(record(row.campaign)?.id), group = record(row.adGroup), adSetId = providerId(group?.id);
    if (!campaignId || !adSetId) throw new ProviderFailure("google_malformed_response");
    const key = `${m.date}|${campaignId}`, rowKey = `${key}|${adSetId}`;
    if (keys.has(rowKey)) throw new ProviderFailure("provider_duplicate_row");
    keys.add(rowKey);
    const sum = grouped.get(key) ?? { micros: 0n, impressions: 0n, clicks: 0n };
    grouped.set(key, { micros: sum.micros + m.micros, impressions: sum.impressions + m.impressions, clicks: sum.clicks + m.clicks });
    rows.push({ level: "ad_set", campaignId, campaignName: campaigns.get(key)?.name ?? null, adSetId, adSetName: providerName(group?.name),
      reportDate: m.date, spendCents: money(m.micros), impressions: count(m.impressions), clicks: count(m.clicks) });
  }
  for (const [key, campaign] of campaigns) {
    const inGroups = grouped.get(key) ?? { micros: 0n, impressions: 0n, clicks: 0n };
    const rest = { micros: campaign.micros - inGroups.micros, impressions: campaign.impressions - inGroups.impressions, clicks: campaign.clicks - inGroups.clicks };
    if (rest.micros <= 0n && rest.impressions <= 0n && rest.clicks <= 0n) continue;
    const clamp = (value: bigint) => value > 0n ? value : 0n;
    rows.push({ level: "campaign", campaignId: campaign.campaignId, campaignName: campaign.name, adSetId: null, adSetName: null, reportDate: campaign.date,
      spendCents: money(clamp(rest.micros)), impressions: rest.impressions >= 0n ? count(rest.impressions) : null, clicks: rest.clicks >= 0n ? count(rest.clicks) : null });
  }
  return { totals, rows };
}
