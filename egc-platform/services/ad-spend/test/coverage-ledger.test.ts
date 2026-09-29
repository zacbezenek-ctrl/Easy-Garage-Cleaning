import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adSpendConfig, publishedConfiguration } from "../src/config.js";
import { allocateEntry, combine, computeSpendCoverage, type CoverageInput, type SyncDayRecord } from "../src/coverage.js";
import { dateRange, denverDateOf } from "../src/dates.js";
import { API_CHANNEL_ALIAS, requireSpendOwner, SpendLedgerError, validateSpendEntry } from "../src/ledger.js";
import { ENABLED_ENV, IDS } from "./fixtures/router.mjs";

const NOW = new Date("2026-09-22T18:00:00.000Z");
const connected = publishedConfiguration(adSpendConfig(ENABLED_ENV), NOW);
const metaOnly = publishedConfiguration(adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false" }), NOW);
const sync = (source: string, accountId: string, date: string, extra: Partial<SyncDayRecord> = {}): SyncDayRecord => ({ source, accountId, reportDate: date, denverDate: date,
  timeZone: "America/Denver", timeZoneAligned: true, currency: source === "meta_leadgen" ? null : "USD", totalCents: source === "meta_leadgen" ? null : 1000,
  leadCount: source === "meta_leadgen" ? 2 : null, settled: true, restatedAt: null, ...extra });
const input = (overrides: Partial<CoverageInput>): CoverageInput => ({ from: "2026-09-01", to: "2026-09-04", now: NOW, configuration: connected, syncDays: [], entries: [], entriesComplete: true, leadForms: [], cursors: new Map(), ...overrides });
const days = (from: string, to: string) => dateRange(from, to);
const fullSync = (from: string, to: string, extra: Partial<SyncDayRecord> = {}) => [
  ...days(from, to).map(d => sync("meta_ads", IDS.metaAccount, d, extra)), ...days(from, to).map(d => sync("google_ads", IDS.googleCustomer, d, { totalCents: 500, ...extra }))];

describe("per-day spend coverage", () => {
  it("is unknown (null, never 0) before the worker has published anything", () => {
    const report = computeSpendCoverage(input({ configuration: null }));
    expect(report.metric).toMatchObject({ key: "ad_spend", value: null, status: "unknown", unit: "cents", currency: "USD" });
    expect(report.metric.coverage.reasons).toEqual(["worker_configuration_missing"]);
    expect(report.days.every(d => d.value === null && d.status === "unknown")).toBe(true);
    expect(report.leadgen).toMatchObject({ value: null, status: "unknown" });
    expect(report.sources.map(s => [s.source, s.status, s.blockers])).toEqual([["meta_ads", "not_connected", ["worker_configuration_missing"]], ["google_ads", "not_connected", ["worker_configuration_missing"]], ["meta_leadgen", "not_connected", ["worker_configuration_missing"]]]);
  });
  it("is complete when every connected account has a settled pull for every day", () => {
    const report = computeSpendCoverage(input({ syncDays: fullSync("2026-09-01", "2026-09-03") }));
    expect(report.metric).toMatchObject({ value: 4500, status: "complete", clockSources: ["provider"] });
    expect(report.metric.coverage).toMatchObject({ included: ["meta_ads", "google_ads"], excluded: [], reasons: [] });
    expect(report.channels.map(c => [c.channel, c.value, c.status])).toEqual([["meta_ads", 3000, "complete"], ["google_ads", 1500, "complete"]]);
    expect(report.days.map(d => d.value)).toEqual([1500, 1500, 1500]);
  });
  it("reports a platform that is not connected as unknown and the total as partial", () => {
    const report = computeSpendCoverage(input({ configuration: metaOnly, syncDays: fullSync("2026-09-01", "2026-09-03").filter(r => r.source === "meta_ads") }));
    expect(report.metric).toMatchObject({ value: 3000, status: "partial" });
    expect(report.metric.coverage.excluded).toEqual([{ channel: "google_ads", reasons: ["platform_not_connected"] }]);
    expect(report.channels.find(c => c.channel === "google_ads")).toMatchObject({ value: null, status: "unknown", blockers: ["flag_off"] });
  });
  it("treats a pulled zero-spend day as known 0 and a missing day as unknown", () => {
    const rows = fullSync("2026-09-01", "2026-09-03").filter(r => !(r.source === "google_ads" && r.denverDate === "2026-09-02"));
    rows.push(sync("meta_ads", IDS.metaAccount, "2026-09-03", { totalCents: 0 }));
    const report = computeSpendCoverage(input({ syncDays: rows.filter((r, i, all) => all.findLastIndex(x => x.source === r.source && x.denverDate === r.denverDate) === i) }));
    expect(report.days.map(d => [d.date, d.value, d.status])).toEqual([["2026-09-01", 1500, "complete"], ["2026-09-02", 1000, "partial"], ["2026-09-03", 500, "complete"]]);
    expect(report.metric).toMatchObject({ value: 3000, status: "partial" });
    expect(report.metric.gaps).toEqual([{ channel: "google_ads", accountId: IDS.googleCustomer, date: "2026-09-02", reason: "day_not_pulled" }]);
  });
  it("marks days inside the restatement window, unaligned account zones and foreign currency", () => {
    const rows = [...fullSync("2026-09-01", "2026-09-03").filter(r => r.source === "google_ads"),
      sync("meta_ads", IDS.metaAccount, "2026-09-01", { settled: false }), sync("meta_ads", IDS.metaAccount, "2026-09-02", { timeZoneAligned: false, timeZone: "America/Los_Angeles" }),
      sync("meta_ads", IDS.metaAccount, "2026-09-03", { currency: "CAD" })];
    const meta = computeSpendCoverage(input({ syncDays: rows })).channels.find(c => c.channel === "meta_ads")!;
    expect(meta.days.map(d => [d.value, d.status, d.reasons])).toEqual([[1000, "partial", ["restatement_window"]], [1000, "partial", ["account_time_zone_not_denver"]], [null, "unknown", ["currency_not_usd"]]]);
    expect(meta).toMatchObject({ value: 2000, status: "partial", reasons: ["account_time_zone_not_denver", "currency_not_usd", "restatement_window"] });
  });
  it("explains a Denver date that an account zone about 12 hours away never maps to, instead of calling it unpulled", () => {
    const dhaka = (reportDate: string, extra: Partial<SyncDayRecord> = {}) => sync("meta_ads", IDS.metaAccount, reportDate, { denverDate: denverDateOf(reportDate, "Asia/Dhaka"), timeZone: "Asia/Dhaka", timeZoneAligned: false, ...extra });
    const pulled = ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-12"].map(date => dhaka(date));
    const report = computeSpendCoverage(input({ configuration: metaOnly, from: "2026-03-07", to: "2026-03-12", syncDays: pulled.filter(row => row.denverDate >= "2026-03-07" && row.denverDate < "2026-03-12") }));
    const meta = report.channels.find(c => c.channel === "meta_ads")!;
    expect(meta.days.map(d => [d.date, d.value, d.reasons])).toEqual([["2026-03-07", 1000, ["account_time_zone_not_denver"]], ["2026-03-08", null, ["account_time_zone_not_denver"]],
      ["2026-03-09", 1000, ["account_time_zone_not_denver"]], ["2026-03-10", 1000, ["account_time_zone_not_denver"]], ["2026-03-11", null, ["day_not_pulled"]]]);
    expect(report.metric.gaps.filter(g => g.channel === "meta_ads").map(g => [g.date, g.reason])).toEqual([["2026-03-08", "account_time_zone_not_denver"], ["2026-03-11", "day_not_pulled"]]);
  });
  it("sums several accounts and keeps a missing account visible", () => {
    const two = publishedConfiguration(adSpendConfig({ ...ENABLED_ENV, META_ADS_ACCOUNT_IDS: "111,222" }), NOW);
    const report = computeSpendCoverage(input({ configuration: two, from: "2026-09-01", to: "2026-09-02", syncDays: [sync("meta_ads", "111", "2026-09-01", { totalCents: 700 }), sync("google_ads", IDS.googleCustomer, "2026-09-01")] }));
    const meta = report.channels.find(c => c.channel === "meta_ads")!;
    expect(meta).toMatchObject({ value: 700, status: "partial" });
    expect(meta.accounts).toEqual([{ accountId: "111", timeZones: ["America/Denver"], value: 700, status: "complete", reasons: [] }, { accountId: "222", timeZones: [], value: null, status: "unknown", reasons: ["day_not_pulled"] }]);
  });
  it("exposes the latest restatement so cached rollups know to recompute", () => {
    const restatedAt = new Date("2026-09-21T10:00:00Z");
    const report = computeSpendCoverage(input({ syncDays: fullSync("2026-09-01", "2026-09-03").map((r, i) => i === 1 ? { ...r, restatedAt } : r) }));
    expect(report.channels.find(c => c.channel === "meta_ads")!.lastRestatedAt).toBe(restatedAt.toISOString());
  });
});

describe("owner-entered channels in coverage", () => {
  it("allocates integer cents evenly per day and the shares always sum to the attested amount", () => {
    const share = allocateEntry({ amountCents: 10000, firstDate: "2026-09-01", lastDate: "2026-09-03" });
    expect(["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map(share)).toEqual([0, 3334, 3333, 3333, 0]);
    for (const [amount, span] of [[1, 30], [99999, 31], [0, 7], [2_000_000_000, 366]] as const) {
      const entry = { amountCents: amount, firstDate: "2025-01-01", lastDate: dateRange("2025-01-01", "2026-12-31")[span - 1]! };
      expect(dateRange(entry.firstDate, entry.lastDate).reduce((sum, date) => sum + allocateEntry(entry)(date), 0)).toBe(amount);
    }
  });
  it("counts an attested entry, including a zero entry, and reports holes inside a channel's span", () => {
    const entries = [{ id: "e1", channel: "yard_signs", amountCents: 3000, firstDate: "2026-09-01", lastDate: "2026-09-03" },
      { id: "e2", channel: "yard_signs", amountCents: 0, firstDate: "2026-09-06", lastDate: "2026-09-06" },
      { id: "e3", channel: "nextdoor", amountCents: 700, firstDate: "2026-08-20", lastDate: "2026-09-02" }];
    const report = computeSpendCoverage(input({ from: "2026-09-01", to: "2026-09-07", syncDays: fullSync("2026-09-01", "2026-09-06"), entries }));
    const signs = report.channels.find(c => c.channel === "yard_signs")!, nextdoor = report.channels.find(c => c.channel === "nextdoor")!;
    expect(signs).toMatchObject({ kind: "manual", clockSource: "attested", value: 3000, status: "partial", entryIds: ["e1", "e2"] });
    expect(signs.days.map(d => [d.date, d.value, d.status])).toEqual([["2026-09-01", 1000, "complete"], ["2026-09-02", 1000, "complete"], ["2026-09-03", 1000, "complete"],
      ["2026-09-04", null, "unknown"], ["2026-09-05", null, "unknown"], ["2026-09-06", 0, "complete"]]);
    // Nextdoor ended on the 2nd: after its span it is simply inactive, not missing.
    expect(nextdoor.days.map(d => [d.date, d.value])).toEqual([["2026-09-01", 50], ["2026-09-02", 50]]);
    expect(report.days.find(d => d.date === "2026-09-04")).toMatchObject({ value: 1500, status: "partial", reasons: ["manual_entry_gap"] });
    expect(report.metric.clockSources).toEqual(["attested", "provider"]);
    expect(report.metric.coverage.disclosures).toContain("non_api_channels_count_only_owner_entries");
    expect(report.metric.gaps.filter(g => g.channel === "yard_signs").map(g => g.date)).toEqual(["2026-09-04", "2026-09-05"]);
  });
  it("turns the metric partial when the ledger read was truncated", () => {
    const report = computeSpendCoverage(input({ syncDays: fullSync("2026-09-01", "2026-09-03"), entriesComplete: false }));
    expect(report.metric).toMatchObject({ value: 4500, status: "partial" });
    expect(report.metric.coverage.reasons).toContain("manual_entries_truncated");
  });
  it("combines unknown as null, not zero", () => {
    expect(combine([{ value: null, status: "unknown", reasons: ["a"] }, { value: null, status: "unknown", reasons: ["b"] }])).toEqual({ value: null, status: "unknown", reasons: ["a", "b"] });
    expect(combine([{ value: 0, status: "complete", reasons: [] }, { value: null, status: "unknown", reasons: ["b"] }])).toEqual({ value: 0, status: "partial", reasons: ["b"] });
  });
});

describe("Meta lead-form coverage", () => {
  it("counts per page day and per form, and leaves unpulled days unknown", () => {
    const report = computeSpendCoverage(input({ syncDays: [sync("meta_leadgen", IDS.page, "2026-09-01"), sync("meta_leadgen", IDS.page, "2026-09-02", { leadCount: 0, settled: false })],
      leadForms: [{ pageId: IDS.page, formId: "901", formName: "Synthetic form", denverDate: "2026-09-01", leadCount: 2 }] }));
    expect(report.leadgen).toMatchObject({ key: "meta_leadgen_count", unit: "count", value: 2, status: "partial" });
    expect(report.leadgen.days.map(d => [d.value, d.status])).toEqual([[2, "complete"], [0, "partial"], [null, "unknown"]]);
    expect(report.leadgen.forms).toEqual([{ formId: "901", formName: "Synthetic form", pageId: IDS.page, count: 2, days: [{ date: "2026-09-01", count: 2 }] }]);
  });
});

describe("Meta lead-form retention", () => {
  it("explains unpulled days older than Meta's 90-day lead retention instead of calling them missed", () => {
    const report = computeSpendCoverage(input({ from: "2026-06-23", to: "2026-06-27" }));
    expect(report.leadgen.days.map(d => [d.date, d.value, d.reasons])).toEqual([["2026-06-23", null, ["meta_lead_retention_exceeded"]], ["2026-06-24", null, ["meta_lead_retention_exceeded"]],
      ["2026-06-25", null, ["day_not_pulled"]], ["2026-06-26", null, ["day_not_pulled"]]]);
    expect(report.leadgen).toMatchObject({ value: null, status: "unknown" });
  });
});

describe("source health from sync cursors", () => {
  it("distinguishes healthy, stale, failing and never-synced sources and drops unsafe cursor text", () => {
    const cursors = new Map([
      ["ad_spend:meta_ads:last_success", "2026-09-22T17:00:00.000Z"],
      ["ad_spend:google_ads:last_success", "2026-09-22T10:00:00.000Z"],
      ["ad_spend:meta_leadgen:last_success", "2026-09-22T12:00:00.000Z"],
      ["ad_spend:meta_leadgen:last_failure", JSON.stringify({ at: "2026-09-22T17:30:00.000Z", code: "Error: token=abc", accountId: "555; drop", httpStatus: 999 })],
      ["ad_spend:meta_ads:last_run", JSON.stringify({ at: "2026-09-22T17:00:00.000Z", accounts: [{ accountId: IDS.metaAccount, ok: true, pulledDays: 4, restatedDays: 1, raw: "private" }] })]
    ]);
    const report = computeSpendCoverage(input({ cursors }));
    expect(report.sources.map(s => [s.source, s.status])).toEqual([["meta_ads", "healthy"], ["google_ads", "stale"], ["meta_leadgen", "failing"]]);
    expect(report.sources[2]!.lastFailure).toEqual({ at: "2026-09-22T17:30:00.000Z", code: "ad_spend_sync_failed", accountId: null });
    expect(report.sources[0]!.lastRun).toEqual({ at: "2026-09-22T17:00:00.000Z", accounts: [{ accountId: IDS.metaAccount, ok: true, pulledDays: 4, restatedDays: 1 }] });
    expect(computeSpendCoverage(input({})).sources[0]!.status).toBe("never_synced");
  });
});

describe("owner spend ledger validation", () => {
  const entry = { channel: "yard_signs", description: "Synthetic sign order", amountCents: 12500, firstDate: "2026-09-01", lastDate: "2026-09-30", receiptReference: "INV-SYN-1001" };
  const fails = (work: () => unknown, code: string) => { try { work(); } catch (error) { expect(error).toBeInstanceOf(SpendLedgerError); expect((error as SpendLedgerError).code).toBe(code); return; } throw new Error("expected " + code); };
  it("accepts an attested month and trims the text", () => {
    expect(validateSpendEntry({ ...entry, description: "  Synthetic sign order  " }, NOW)).toEqual({ ...entry, currency: "USD" });
  });
  it("refuses API channels, bad text, amounts, currencies and periods", () => {
    fails(() => validateSpendEntry({ ...entry, channel: "meta_ads" }, NOW), "spend_channel_api_ingested");
    fails(() => validateSpendEntry({ ...entry, channel: "google_ads" }, NOW), "spend_channel_api_ingested");
    // Meta or Google spend typed under another name would be counted twice once the API backfills those days.
    for (const channel of ["facebook", "facebook_ads", "fb", "fb_boosts", "paid_fb", "instagram", "insta_story", "ig_ads", "meta", "metaads", "meta_boost", "google", "googleads", "google_lsa", "adwords", "gads", "youtube_preroll", "yt", "paid_facebook_leads"])
      fails(() => validateSpendEntry({ ...entry, channel }, NOW), "spend_channel_api_ingested");
    for (const channel of ["nextdoor", "metal_signs", "bing_ads", "local_services_ads", "instant_flyers", "big_banner", "tiktok", "yelp", "figure_eight_mailers"])
      expect(validateSpendEntry({ ...entry, channel }, NOW).channel).toBe(channel);
    for (const channel of ["Yard", "1signs", "a", "x".repeat(41), "yard-signs"]) fails(() => validateSpendEntry({ ...entry, channel }, NOW), "spend_channel_invalid");
    fails(() => validateSpendEntry({ ...entry, receiptReference: " " }, NOW), "spend_receipt_required");
    fails(() => validateSpendEntry({ ...entry, description: "line\nbreak" }, NOW), "spend_description_invalid");
    for (const amountCents of [-1, 1.5, 2_000_000_001, Number.NaN]) fails(() => validateSpendEntry({ ...entry, amountCents }, NOW), "spend_amount_invalid");
    fails(() => validateSpendEntry({ ...entry, currency: "CAD" as "USD" }, NOW), "spend_currency_unsupported");
    for (const period of [{ firstDate: "2026-09-30", lastDate: "2026-09-01" }, { firstDate: "2026-02-30", lastDate: "2026-03-01" }, { firstDate: "2019-12-31", lastDate: "2020-01-02" }, { firstDate: "2025-08-31", lastDate: "2026-09-01" }])
      fails(() => validateSpendEntry({ ...entry, ...period }, NOW), "spend_period_invalid");
    fails(() => validateSpendEntry({ ...entry, firstDate: "2026-11-01", lastDate: "2026-11-30" }, NOW), "spend_period_in_future");
    expect(validateSpendEntry({ ...entry, firstDate: "2026-10-01", lastDate: "2026-10-31" }, NOW).lastDate).toBe("2026-10-31");
  });
  it("uses one alias pattern in the ledger, the operations command schema and the database check", () => {
    for (const file of ["../../operations/src/spend-commands.ts", "../../../packages/database/src/schema.ts", "../../../packages/database/migrations/0015_ad_spend.sql"])
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).toContain(API_CHANNEL_ALIAS.source);
  });
  it("is owner-only, as a human", () => {
    expect(() => requireSpendOwner({ id: "zacb", role: "owner", kind: "human", workspace: "egc" })).not.toThrow();
    for (const actor of [{ id: "m", role: "manager", kind: "human" }, { id: "s", role: "sales", kind: "human" }, { id: "mcp", role: "integration", kind: "integration" }, { id: "x", role: "owner", kind: "integration" }])
      fails(() => requireSpendOwner({ ...actor, workspace: "egc" }), "spend_owner_required");
  });
});
