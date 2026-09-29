import { describe, expect, it } from "vitest";
import { adSpendConfig } from "../src/config.js";
import { googleProvider, normalizeGoogleReport } from "../src/google.js";
import { syncAdSpend } from "../src/ingest.js";
import { metaProvider, normalizeMetaInsights } from "../src/meta.js";
import { failureCode, ProviderFailure } from "../src/provider.js";
import { ENABLED_ENV, fixtureFetcher, GOOGLE, IDS, jsonResponse, META, SECRETS } from "./fixtures/router.mjs";
import { memoryStore } from "./memory-store.js";

const config = adSpendConfig(ENABLED_ENV);
const range = { from: "2026-09-19", to: "2026-09-22" };
const code = async (work: Promise<unknown>) => { try { await work; } catch (error) { return { ...failureCode(error), message: (error as Error).message }; } throw new Error("expected a failure"); };

describe("Meta Marketing API client (recorded fixtures)", () => {
  it("reads the account zone and currency with the token only in the Authorization header", async () => {
    const { fetcher, calls } = fixtureFetcher();
    expect(await metaProvider(config, fetcher).account(IDS.metaAccount)).toEqual({ timeZone: "America/Denver", currency: "USD" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(`https://graph.facebook.com/v25.0/act_${IDS.metaAccount}?fields=timezone_name%2Ccurrency`);
    expect(call).toMatchObject({ method: "GET", redirect: "error", signal: true });
    expect(call.headers.authorization).toBe(`Bearer ${SECRETS.meta}`);
    expect(call.url).not.toContain(SECRETS.meta);
  });
  it("pulls account-level day totals and follows ad set pages by cursor, never the returned next URL", async () => {
    const { fetcher, calls } = fixtureFetcher();
    const report = await metaProvider(config, fetcher).spend(IDS.metaAccount, range);
    expect(calls.map(c => [c.params.level, c.params.after ?? null])).toEqual([["account", null], ["adset", null], ["adset", "MwZDZD"]]);
    expect(calls.every(c => c.host === "graph.facebook.com" && c.method === "GET" && c.params.time_increment === "1" && c.params.time_range === JSON.stringify({ since: "2026-09-19", until: "2026-09-22" }))).toBe(true);
    expect(Object.fromEntries(report.totals)).toEqual({
      "2026-09-19": { spendCents: 4567, impressions: 3021, clicks: 88 }, "2026-09-20": { spendCents: 5000, impressions: 3500, clicks: 91 }, "2026-09-22": { spendCents: 1234, impressions: 800, clicks: 20 } });
    expect(report.rows).toHaveLength(5);
    expect(report.rows[1]).toEqual({ level: "ad_set", campaignId: "120200000000000001", campaignName: "Synthetic Garage Leads", adSetId: "120200000000000102", adSetName: "Loveland retarget",
      reportDate: "2026-09-19", spendCents: 1567, impressions: 1021, clicks: 28 });
    for (const date of report.totals.keys()) expect(report.rows.filter(r => r.reportDate === date).reduce((s, r) => s + r.spendCents, 0)).toBe(report.totals.get(date)!.spendCents);
  });
  it("maps Graph errors to finite codes and never keeps the provider message", async () => {
    const leak = `Invalid OAuth access token ${SECRETS.meta} for Synthetic Customer`;
    for (const [status, error, expected] of [[400, { code: 17, message: leak }, "meta_rate_limited"], [400, { code: 190, message: leak }, "meta_auth_failed"],
      [403, { code: 200, message: leak }, "meta_permission_denied"], [500, { code: 2, message: leak }, "meta_api_rejected"], [429, { message: leak }, "meta_rate_limited"]] as const) {
      const { fetcher } = fixtureFetcher({ override: async () => jsonResponse({ error }, status) });
      const failure = await code(metaProvider(config, fetcher).account(IDS.metaAccount));
      expect(failure).toEqual({ code: expected, httpStatus: status, message: expected });
      expect(JSON.stringify(failure)).not.toContain(SECRETS.meta);
    }
    const html = fixtureFetcher({ override: async () => new Response("<html>token</html>", { status: 502 }) });
    expect(await code(metaProvider(config, html.fetcher).account(IDS.metaAccount))).toMatchObject({ code: "meta_malformed_response", httpStatus: 502 });
    const down = fixtureFetcher({ override: async () => { throw new TypeError(`connect ECONNREFUSED ${SECRETS.meta}`); } });
    expect(await code(metaProvider(config, down.fetcher).account(IDS.metaAccount))).toEqual({ code: "meta_network_unavailable", message: "meta_network_unavailable" });
  });
  it("rejects out-of-range, duplicate and malformed report rows instead of storing guesses", () => {
    const row = META.insightsAccount.data[0];
    expect(() => normalizeMetaInsights([{ ...row, date_start: "2026-09-18", date_stop: "2026-09-18" }], [], range)).toThrow("provider_row_out_of_range");
    expect(() => normalizeMetaInsights([{ ...row, date_stop: "2026-09-20" }], [], range)).toThrow("provider_row_out_of_range");
    expect(() => normalizeMetaInsights([row, row], [], range)).toThrow("provider_duplicate_row");
    expect(() => normalizeMetaInsights([{ ...row, spend: "12,50" }], [], range)).toThrow("provider_value_invalid");
    expect(() => normalizeMetaInsights([{ ...row, clicks: "-3" }], [], range)).toThrow("provider_value_invalid");
    const adset = META.insightsAdSetPages[0].data[0];
    expect(() => normalizeMetaInsights([], [adset, adset], range)).toThrow("provider_duplicate_row");
    expect(() => normalizeMetaInsights([], [{ ...adset, adset_id: undefined }], range)).toThrow("meta_malformed_response");
    expect(normalizeMetaInsights([{ spend: "0.00", date_start: "2026-09-21", date_stop: "2026-09-21" }], [], range).totals.get("2026-09-21")).toEqual({ spendCents: 0, impressions: null, clicks: null });
  });
  it("lists lead forms and reads only lead ids and creation instants", async () => {
    const { fetcher, calls } = fixtureFetcher();
    const provider = metaProvider(config, fetcher);
    expect(await provider.leadForms(IDS.page)).toEqual([{ id: "900000000000001", name: "Synthetic garage help form" }, { id: "900000000000002", name: "Synthetic spring promo" }]);
    const since = Date.parse("2026-09-20T06:00:00Z"), until = Date.parse("2026-09-23T06:00:00Z");
    const leads = await provider.formLeads("900000000000001", since, until);
    expect(leads.map(l => l.id)).toEqual(["120211111111111102", "120211111111111103"]);
    const leadCall = calls.at(-1)!;
    expect(leadCall.params.fields).toBe("id,created_time");
    expect(JSON.parse(leadCall.params.filtering)).toEqual([{ field: "time_created", operator: "GREATER_THAN", value: since / 1000 - 1 }]);
    expect(calls.some(c => /field_data/.test(c.url))).toBe(false);
  });
});

describe("Google Ads API client (recorded fixtures)", () => {
  it("refreshes one OAuth token and sends the developer and manager headers on every read", async () => {
    const { fetcher, calls } = fixtureFetcher();
    const provider = googleProvider(config, fetcher);
    expect(await provider.account(IDS.googleCustomer)).toEqual({ timeZone: "America/Denver", currency: "USD" });
    await provider.spend(IDS.googleCustomer, range);
    const [token, ...reads] = calls;
    expect(token).toMatchObject({ host: "oauth2.googleapis.com", method: "POST", redirect: "error" });
    expect(Object.fromEntries(new URLSearchParams(token!.body!))).toEqual({ client_id: "synthetic-client.apps.googleusercontent.com", client_secret: SECRETS.clientSecret, refresh_token: SECRETS.refresh, grant_type: "refresh_token" });
    expect(reads).toHaveLength(4);
    for (const read of reads) {
      expect(read.url).toBe(`https://googleads.googleapis.com/v23/customers/${IDS.googleCustomer}/googleAds:searchStream`);
      expect(read.headers).toMatchObject({ authorization: `Bearer ${GOOGLE.token.access_token}`, "developer-token": SECRETS.developer, "login-customer-id": IDS.loginCustomer });
      expect(read.url).not.toMatch(/token/);
    }
    expect(reads.slice(1).map(r => JSON.parse(r.body!).query)).toEqual([
      "SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM customer WHERE segments.date BETWEEN '2026-09-19' AND '2026-09-22'",
      "SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '2026-09-19' AND '2026-09-22'",
      "SELECT campaign.id, ad_group.id, ad_group.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM ad_group WHERE segments.date BETWEEN '2026-09-19' AND '2026-09-22'"]);
  });
  it("breaks spend into ad groups plus a campaign row for spend outside ad groups, summing exactly", async () => {
    const report = await googleProvider(config, fixtureFetcher().fetcher).spend(IDS.googleCustomer, range);
    expect(Object.fromEntries(report.totals)).toEqual({ "2026-09-19": { spendCents: 2000, impressions: 1000, clicks: 30 }, "2026-09-20": { spendCents: 1550, impressions: 900, clicks: 0 },
      "2026-09-21": { spendCents: 1000, impressions: 500, clicks: 5 } });
    expect(report.rows.map(r => [r.reportDate, r.level, r.campaignId, r.adSetId, r.spendCents, r.impressions, r.clicks])).toEqual([
      ["2026-09-19", "ad_set", "2100000010", "3100000100", 700, 350, 12], ["2026-09-19", "ad_set", "2100000010", "3100000101", 500, 250, 8],
      ["2026-09-20", "ad_set", "2100000010", "3100000100", 1550, 900, 0], ["2026-09-19", "campaign", "2100000011", null, 800, 400, 10],
      ["2026-09-21", "campaign", "2100000011", null, 1000, 500, 5]]);
    for (const [date, total] of report.totals) expect(report.rows.filter(r => r.reportDate === date).reduce((s, r) => s + r.spendCents, 0)).toBe(total.spendCents);
  });
  it("computes the campaign remainder in micros before rounding", () => {
    const at = (micros: string) => ({ segments: { date: "2026-09-19" }, metrics: { costMicros: micros } });
    const report = normalizeGoogleReport([at("3000000")], [{ ...at("3000000"), campaign: { id: "1" } }],
      [{ ...at("1004999"), campaign: { id: "1" }, adGroup: { id: "11" } }, { ...at("1004999"), campaign: { id: "1" }, adGroup: { id: "12" } }], range);
    expect(report.rows.map(r => r.spendCents)).toEqual([100, 100, 99]);
    expect(report.rows.at(-1)).toMatchObject({ level: "campaign", adSetId: null });
  });
  it("maps HTTP failures to finite codes and retries the token after an auth failure", async () => {
    let tokenCalls = 0;
    const { fetcher } = fixtureFetcher({ override: async call => { if (call.host === "oauth2.googleapis.com") return ++tokenCalls === 1 ? jsonResponse({ error: "invalid_grant", error_description: SECRETS.refresh }, 400) : undefined; return undefined; } });
    const provider = googleProvider(config, fetcher);
    expect(await code(provider.account(IDS.googleCustomer))).toEqual({ code: "google_auth_failed", httpStatus: 400, message: "google_auth_failed" });
    expect(await provider.account(IDS.googleCustomer)).toEqual({ timeZone: "America/Denver", currency: "USD" });
    for (const [status, expected] of [[401, "google_auth_failed"], [403, "google_permission_denied"], [429, "google_rate_limited"], [400, "google_ads_rejected"]] as const) {
      const failing = fixtureFetcher({ override: async call => call.host === "googleads.googleapis.com" ? jsonResponse({ error: { message: SECRETS.developer } }, status) : undefined });
      expect(await code(googleProvider(config, failing.fetcher).account(IDS.googleCustomer))).toEqual({ code: expected, httpStatus: status, message: expected });
    }
    const odd = fixtureFetcher({ override: async call => call.host === "googleads.googleapis.com" ? jsonResponse({ results: [] }) : undefined });
    expect(await code(googleProvider(config, odd.fetcher).account(IDS.googleCustomer))).toMatchObject({ code: "google_malformed_response" });
  });
  it("fails the whole pull when the stream breaks after it started, and stores nothing", async () => {
    const [first] = GOOGLE.adGroups[0].results, leak = `Internal error for ${SECRETS.developer}`;
    const broken = (tail: unknown) => fixtureFetcher({ override: async call => call.host === "googleads.googleapis.com" && /FROM ad_group WHERE/.test(JSON.parse(call.body!).query) ? jsonResponse([{ results: [first] }, tail]) : undefined });
    for (const tail of [{ error: { code: 500, message: leak, status: "INTERNAL" } }, { unexpected: true }]) {
      const failure = await code(googleProvider(config, broken(tail).fetcher).spend(IDS.googleCustomer, range));
      expect(failure).toEqual({ code: "google_stream_failed", message: "google_stream_failed" });
      expect(JSON.stringify(failure)).not.toContain(SECRETS.developer);
      const store = memoryStore();
      const result = await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_META_ENABLED: "false" }), store, fetcher: broken(tail).fetcher, now: () => new Date("2026-09-22T18:00:00.000Z") });
      expect(result.sources.find(s => s.source === "google_ads")!.accounts).toEqual([{ accountId: IDS.googleCustomer, ok: false, code: "google_stream_failed", pulledDays: 0, restatedDays: 0, rows: 0 }]);
      expect([store.writes, store.days.size, store.spend.length]).toEqual([0, 0, 0]);
      expect(JSON.parse(store.cursors.get("ad_spend:google_ads:last_failure")!)).toMatchObject({ code: "google_stream_failed", accountId: IDS.googleCustomer });
    }
    // A query with no rows streams only its metadata batch: that is a known empty answer.
    const empty = fixtureFetcher({ override: async call => call.host === "googleads.googleapis.com" && / WHERE /.test(JSON.parse(call.body!).query) ? jsonResponse([{ fieldMask: "segments.date,metrics.costMicros", requestId: "synthetic-empty" }]) : undefined });
    expect(await googleProvider(config, empty.fetcher).spend(IDS.googleCustomer, range)).toEqual({ totals: new Map(), rows: [] });
  });
  it("never interpolates an unvalidated customer id or date into GAQL", async () => {
    const { fetcher, calls } = fixtureFetcher();
    await expect(googleProvider(config, fetcher).spend(IDS.googleCustomer, { from: "2026-09-19' OR 1=1 --", to: "2026-09-22" })).rejects.toThrow(ProviderFailure);
    await expect(googleProvider(config, fetcher).account("123/../456")).rejects.toThrow("invalid_customer_ids");
    expect(calls.filter(c => c.host === "googleads.googleapis.com")).toHaveLength(0);
  });
});
