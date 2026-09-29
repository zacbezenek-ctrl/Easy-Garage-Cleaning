import { describe, expect, it } from "vitest";
import { adSpendConfig, CONFIG_CURSOR, parsePublishedConfiguration } from "../src/config.js";
import { COVERAGE_CURSOR_KEYS } from "../src/coverage.js";
import { syncAdSpend } from "../src/ingest.js";
import { ProviderFailure, type SpendProvider, type SpendReport } from "../src/provider.js";
import { ENABLED_ENV, fixtureFetcher, IDS, SECRETS } from "./fixtures/router.mjs";
import { memoryStore } from "./memory-store.js";

const NOW = new Date("2026-09-22T18:00:00.000Z");
const clock = (start: Date) => { let at = start.valueOf(); return { now: () => new Date(at), set: (iso: string) => { at = Date.parse(iso); } }; };
const day = (store: ReturnType<typeof memoryStore>, source: string, account: string, date: string) => store.days.get(`${source}|${account}|${date}`);
const fakeSpend = (overrides: Partial<SpendProvider> & { totals?: (range: { from: string; to: string }) => SpendReport["totals"] } = {}): SpendProvider & { ranges: { from: string; to: string }[] } => {
  const ranges: { from: string; to: string }[] = [];
  return { source: "meta_ads", ranges, account: async () => ({ timeZone: "America/Denver", currency: "USD" }),
    spend: async (_account, range) => { ranges.push(range); return { totals: overrides.totals?.(range) ?? new Map(), rows: [] }; }, ...overrides };
};
const noLeads = { leadForms: async () => [], formLeads: async () => [] };

describe("ad spend ingestion orchestration", () => {
  it("contacts no provider while the flags are off, but still publishes 'not connected'", async () => {
    const store = memoryStore(), { fetcher, calls } = fixtureFetcher();
    const result = await syncAdSpend({ config: adSpendConfig({}), store, fetcher, now: () => NOW });
    expect(calls).toHaveLength(0);
    expect(result.sources.map(s => [s.source, s.active])).toEqual([["meta_ads", false], ["google_ads", false], ["meta_leadgen", false]]);
    const published = parsePublishedConfiguration(store.cursors.get(CONFIG_CURSOR));
    expect(published?.sources.meta_ads).toEqual({ active: false, accountIds: [], blockers: ["flag_off", "access_token_missing", "account_ids_missing"] });
    expect([...store.cursors.keys()]).toEqual([CONFIG_CURSOR]);
  });
  it("pulls the restatement window for every source from recorded fixtures and records health", async () => {
    const store = memoryStore(), { fetcher, calls } = fixtureFetcher();
    const result = await syncAdSpend({ config: adSpendConfig(ENABLED_ENV), store, fetcher, now: () => NOW });
    expect(result.sources.map(s => [s.source, s.ok, s.accounts.map(a => a.pulledDays)])).toEqual([["meta_ads", true, [4]], ["google_ads", true, [4]], ["meta_leadgen", true, [4]]]);
    expect(calls.every(c => ["graph.facebook.com", "oauth2.googleapis.com", "googleads.googleapis.com"].includes(c.host))).toBe(true);
    expect(calls.filter(c => c.method !== "GET").every(c => c.host !== "graph.facebook.com")).toBe(true);
    const meta = ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"].map(date => day(store, "meta_ads", IDS.metaAccount, date));
    expect(meta.map(d => [d?.totalCents, d?.settled, d?.denverDate, d?.timeZoneAligned, d?.breakdownGapCents])).toEqual([
      [4567, false, "2026-09-19", true, 0], [5000, false, "2026-09-20", true, 0], [0, false, "2026-09-21", true, 0], [1234, false, "2026-09-22", true, 0]]);
    expect(day(store, "google_ads", IDS.googleCustomer, "2026-09-22")).toMatchObject({ totalCents: 0, rowCount: 0 });
    expect(store.spend.filter(r => r.platform === "google_ads" && r.level === "campaign")).toHaveLength(2);
    // Lead bucketing is by the Denver day of each lead's creation instant (05:59Z is 23:59 the previous evening).
    expect(store.leads.map(l => [l.formId, l.denverDate, l.leadIds])).toEqual([
      ["900000000000001", "2026-09-19", ["120211111111111101"]], ["900000000000001", "2026-09-20", ["120211111111111102"]], ["900000000000001", "2026-09-22", ["120211111111111103"]]]);
    expect(["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"].map(date => day(store, "meta_leadgen", IDS.page, date)?.leadCount)).toEqual([1, 1, 0, 1]);
    for (const source of ["meta_ads", "google_ads", "meta_leadgen"]) {
      expect(store.cursors.get(`ad_spend:${source}:last_success`)).toBe(NOW.toISOString());
      expect(store.cursors.has(`ad_spend:${source}:last_failure`)).toBe(false);
    }
    const cursorText = [...store.cursors.values()].join("\n");
    for (const secret of Object.values(SECRETS)) expect(cursorText).not.toContain(secret);
    // Coverage reads the cursors by exact key: every key the sync writes must be one it reads.
    expect([...store.cursors.keys()].filter(key => !COVERAGE_CURSOR_KEYS.includes(key))).toEqual([]);
  });
  it("settles a day on the first pull after it leaves the window and flags restatements", async () => {
    const store = memoryStore(), time = clock(NOW), totals: Record<string, number> = { "2026-09-19": 1000, "2026-09-20": 2000 };
    const provider = fakeSpend({ totals: range => new Map(Object.entries(totals).filter(([d]) => d >= range.from && d <= range.to).map(([d, cents]) => [d, { spendCents: cents, impressions: null, clicks: null }])) });
    const run = () => syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_LEADGEN_PAGE_IDS: "" }), store, now: time.now, providers: { meta: { ...provider, ...noLeads } } });
    await run();
    expect(provider.ranges).toEqual([{ from: "2026-09-19", to: "2026-09-22" }]);
    time.set("2026-09-23T18:00:00.000Z"); totals["2026-09-20"] = 2150;
    const second = await run();
    expect(provider.ranges[1]).toEqual({ from: "2026-09-19", to: "2026-09-23" });
    expect(second.sources[0]!.accounts[0]).toMatchObject({ ok: true, pulledDays: 5, restatedDays: 1 });
    expect(day(store, "meta_ads", IDS.metaAccount, "2026-09-19")).toMatchObject({ settled: true, totalCents: 1000, restatedAt: null });
    expect(day(store, "meta_ads", IDS.metaAccount, "2026-09-20")).toMatchObject({ settled: false, totalCents: 2150, restatedAt: new Date("2026-09-23T18:00:00.000Z"), firstPulledAt: NOW });
    time.set("2026-10-04T18:00:00.000Z");
    await run();
    // Ten days of downtime: every missing and still-provisional day is healed in one chunk.
    expect(provider.ranges[2]).toEqual({ from: "2026-09-20", to: "2026-10-04" });
    expect(day(store, "meta_ads", IDS.metaAccount, "2026-09-30")).toMatchObject({ settled: true, totalCents: 0 });
  });
  it("backfills from the configured start date, newest chunk first", async () => {
    const store = memoryStore(), provider = fakeSpend();
    await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_LEADGEN_PAGE_IDS: "", EGC_AD_SPEND_START_DATE: "2026-06-14" }), store, now: () => NOW, providers: { meta: { ...provider, ...noLeads } } });
    expect(provider.ranges).toEqual([{ from: "2026-08-23", to: "2026-09-22" }, { from: "2026-07-23", to: "2026-08-22" }, { from: "2026-06-22", to: "2026-07-22" }, { from: "2026-06-14", to: "2026-06-21" }]);
    expect(day(store, "meta_ads", IDS.metaAccount, "2026-06-14")).toMatchObject({ settled: true, totalCents: 0 });
  });
  it("keeps one account's failure from blocking another and records only finite codes", async () => {
    const store = memoryStore();
    const provider = fakeSpend({ account: async accountId => { if (accountId === "222") throw new ProviderFailure("meta_rate_limited", 400); return { timeZone: "America/Denver", currency: "USD" }; } });
    const result = await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_LEADGEN_PAGE_IDS: "", META_ADS_ACCOUNT_IDS: "111,222" }), store, now: () => NOW, providers: { meta: { ...provider, ...noLeads } } });
    expect(result.sources[0]).toMatchObject({ ok: false, accounts: [{ accountId: "111", ok: true, pulledDays: 4 }, { accountId: "222", ok: false, code: "meta_rate_limited", httpStatus: 400, pulledDays: 0 }] });
    expect(JSON.parse(store.cursors.get("ad_spend:meta_ads:last_failure")!)).toEqual({ at: NOW.toISOString(), code: "meta_rate_limited", accountId: "222", httpStatus: 400 });
    expect(store.cursors.has("ad_spend:meta_ads:last_success")).toBe(false);
    expect(day(store, "meta_ads", "111", "2026-09-22")).toBeDefined();
    expect([...store.cursors.keys()].filter(key => !COVERAGE_CURSOR_KEYS.includes(key))).toEqual([]);
  });
  it("never persists raw exception text and never stores a half-validated report", async () => {
    const store = memoryStore(), secret = `postgres://synthetic:${SECRETS.meta}@db.invalid`;
    const unexpected = fakeSpend({ spend: async () => { throw new Error(secret); } });
    await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_LEADGEN_PAGE_IDS: "" }), store, now: () => NOW, providers: { meta: { ...unexpected, ...noLeads } } });
    expect(JSON.parse(store.cursors.get("ad_spend:meta_ads:last_failure")!).code).toBe("ad_spend_sync_failed");
    expect([...store.cursors.values()].join("\n")).not.toContain(SECRETS.meta);
    const outOfRange = fakeSpend({ spend: async () => ({ totals: new Map([["2026-01-01", { spendCents: 5, impressions: null, clicks: null }]]), rows: [] }) });
    const result = await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_LEADGEN_PAGE_IDS: "" }), store, now: () => NOW, providers: { meta: { ...outOfRange, ...noLeads } } });
    expect(result.sources[0]!.accounts[0]).toMatchObject({ ok: false, code: "provider_report_invalid" });
    expect(store.writes).toBe(0);
  });
  it("refuses an unusable account zone or currency before pulling", async () => {
    for (const [info, expected] of [[{ timeZone: "Mars/Base", currency: "USD" }, "invalid_account_time_zone"], [{ timeZone: "America/Denver", currency: "usd" }, "invalid_account_currency"]] as const) {
      const store = memoryStore(), provider = fakeSpend({ account: async () => info });
      const result = await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_LEADGEN_PAGE_IDS: "" }), store, now: () => NOW, providers: { meta: { ...provider, ...noLeads } } });
      expect(result.sources[0]!.accounts[0]).toMatchObject({ ok: false, code: expected });
      expect(provider.ranges).toHaveLength(0);
    }
  });
  it("stores a non-Denver account under Denver dates and marks the days unaligned", async () => {
    const store = memoryStore(), provider = fakeSpend({ account: async () => ({ timeZone: "America/Los_Angeles", currency: "USD" }) });
    await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_LEADGEN_PAGE_IDS: "" }), store, now: () => new Date("2026-09-23T06:30:00Z"), providers: { meta: { ...provider, ...noLeads } } });
    // 00:30 on the 23rd in Denver is still 23:30 on the 22nd in the account's own zone: the account's calendar decides the window.
    expect(provider.ranges).toEqual([{ from: "2026-09-19", to: "2026-09-22" }]);
    expect(day(store, "meta_ads", IDS.metaAccount, "2026-09-22")).toMatchObject({ denverDate: "2026-09-22", timeZoneAligned: false, timeZone: "America/Los_Angeles" });
  });
  it("never pulls lead-form days older than Meta's 90-day lead retention, even with an older start date", async () => {
    const store = memoryStore(), windows: [number, number][] = [];
    const meta = { ...fakeSpend(), leadForms: async () => [{ id: "91", name: null }], formLeads: async (_form: string, since: number, until: number) => { windows.push([since, until]); return []; } };
    await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_ADS_ACCOUNT_IDS: "", EGC_AD_SPEND_START_DATE: "2026-01-01" }), store, now: () => NOW, providers: { meta } });
    const pulled = [...store.days.values()].filter(d => d.source === "meta_leadgen").map(d => d.reportDate).sort();
    expect([pulled.length, pulled[0], pulled.at(-1)]).toEqual([90, "2026-06-25", "2026-09-22"]);
    // The oldest window opens at Denver midnight (MDT, 06:00Z) of the first retained day.
    expect(Math.min(...windows.map(([since]) => since))).toBe(Date.parse("2026-06-25T06:00:00.000Z"));
    expect(Math.max(...windows.map(([, until]) => until))).toBe(Date.parse("2026-09-23T06:00:00.000Z"));
  });
  it("fails a lead page whose forms report the same lead twice", async () => {
    const store = memoryStore(), lead = { id: "1201", createdAt: Date.parse("2026-09-21T15:00:00Z") };
    const meta = { ...fakeSpend(), leadForms: async () => [{ id: "91", name: null }, { id: "92", name: null }], formLeads: async () => [lead] };
    const result = await syncAdSpend({ config: adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false", META_ADS_ACCOUNT_IDS: "" }), store, now: () => NOW, providers: { meta } });
    expect(result.sources.find(s => s.source === "meta_leadgen")!.accounts[0]).toMatchObject({ ok: false, code: "provider_duplicate_row" });
    expect(store.leads).toHaveLength(0);
  });
});
