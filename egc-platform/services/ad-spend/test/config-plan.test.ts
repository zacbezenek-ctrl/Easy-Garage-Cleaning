import { describe, expect, it } from "vitest";
import { adSpendConfig, parsePublishedConfiguration, publishedConfiguration, sourceActive, sourceBlockers } from "../src/config.js";
import { planPulls, pullFloor, settledOn } from "../src/plan.js";
import { ENABLED_ENV, SECRETS } from "./fixtures/router.mjs";

const NOW = new Date("2026-09-22T18:00:00.000Z");

describe("ad spend configuration", () => {
  it("defaults to off with nothing configured and reads flags exactly", () => {
    const config = adSpendConfig({});
    expect(sourceBlockers(config, "meta_ads")).toEqual(["flag_off", "access_token_missing", "account_ids_missing"]);
    expect(sourceBlockers(config, "google_ads")).toEqual(["flag_off", "developer_token_missing", "oauth_client_missing", "refresh_token_missing", "customer_ids_missing"]);
    expect(sourceBlockers(config, "meta_leadgen")).toEqual(["flag_off", "access_token_missing", "page_ids_missing"]);
    for (const flag of ["TRUE", "1", "yes", " true"]) expect(sourceActive(adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_META_ENABLED: flag }), "meta_ads")).toBe(false);
    expect(config.meta.apiVersion).toBe("v25.0");
    expect(config.google.apiVersion).toBe("v23");
  });
  it("normalizes ids, rejects malformed ones and validates the start date", () => {
    const config = adSpendConfig({ ...ENABLED_ENV, META_ADS_ACCOUNT_IDS: "act_111, 222,act_111", EGC_AD_SPEND_START_DATE: "2026-01-01", META_ADS_API_VERSION: "v99.0", GOOGLE_ADS_API_VERSION: "v24" });
    expect(config.meta.accountIds).toEqual(["111", "222"]);
    expect(config.google.customerIds).toEqual(["1234567890"]);
    expect(config.google.loginCustomerId).toBe("9876543210");
    expect([config.startDate, config.meta.apiVersion, config.google.apiVersion]).toEqual(["2026-01-01", "v99.0", "v24"]);
    for (const source of ["meta_ads", "google_ads", "meta_leadgen"] as const) expect(sourceActive(config, source)).toBe(true);
    expect(sourceBlockers(adSpendConfig({ ...ENABLED_ENV, META_ADS_ACCOUNT_IDS: "act_12;DROP" }), "meta_ads")).toEqual(["invalid_account_ids"]);
    expect(sourceBlockers(adSpendConfig({ ...ENABLED_ENV, GOOGLE_ADS_CUSTOMER_IDS: "12345" }), "google_ads")).toEqual(["invalid_customer_ids"]);
    const bad = adSpendConfig({ EGC_AD_SPEND_START_DATE: "2026-02-30", META_ADS_API_VERSION: "latest" });
    expect([bad.startDate, bad.warnings, bad.meta.apiVersion]).toEqual([null, ["invalid_start_date"], "v25.0"]);
  });
  it("publishes connection state without any credential and parses it back strictly", () => {
    const published = publishedConfiguration(adSpendConfig({ ...ENABLED_ENV, EGC_AD_SPEND_GOOGLE_ENABLED: "false" }), NOW);
    const text = JSON.stringify(published);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(published.sources.meta_ads).toEqual({ active: true, accountIds: ["1234567890"], blockers: [] });
    expect(published.sources.google_ads).toEqual({ active: false, accountIds: [], blockers: ["flag_off"] });
    expect(parsePublishedConfiguration(text)).toEqual(published);
    for (const value of [null, "", "{", "[]", JSON.stringify({ ...published, version: 2 }), JSON.stringify({ ...published, restatementDays: 7 }),
      JSON.stringify({ ...published, sources: { ...published.sources, meta_ads: { active: true, accountIds: [], blockers: [] } } }),
      JSON.stringify({ ...published, sources: { meta_ads: published.sources.meta_ads } })]) expect(parsePublishedConfiguration(value)).toBeNull();
  });
});

describe("pull planning", () => {
  const today = "2026-09-22";
  it("keeps the last three complete days and today provisional", () => {
    expect(settledOn("2026-09-18", today)).toBe(true);
    expect(settledOn("2026-09-19", today)).toBe(false);
    expect(settledOn("2026-09-22", today)).toBe(false);
  });
  it("starts at the restatement window, the start date or the earliest pull, bounded to two years", () => {
    expect(pullFloor({ today, startDate: null, earliest: null })).toBe("2026-09-19");
    expect(pullFloor({ today, startDate: "2026-06-01", earliest: null })).toBe("2026-06-01");
    expect(pullFloor({ today, startDate: "2026-08-01", earliest: "2026-05-01" })).toBe("2026-05-01");
    expect(pullFloor({ today, startDate: "2027-01-01", earliest: null })).toBe("2026-09-19");
    expect(pullFloor({ today, startDate: "2020-01-01", earliest: null })).toBe("2024-09-22");
  });
  it("re-pulls every missing or unsettled day, newest chunk first", () => {
    const states = [{ reportDate: "2026-09-10", settled: true }, { reportDate: "2026-09-11", settled: true }, { reportDate: "2026-09-12", settled: false },
      ...["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"].map(reportDate => ({ reportDate, settled: true })), { reportDate: "2026-09-19", settled: false }];
    expect(planPulls({ today, floor: "2026-09-10", states })).toEqual([{ from: "2026-09-19", to: "2026-09-22" }, { from: "2026-09-12", to: "2026-09-12" }]);
    expect(planPulls({ today, floor: "2026-09-19", states: [] })).toEqual([{ from: "2026-09-19", to: "2026-09-22" }]);
  });
  it("splits a long backfill into bounded chunks and caps one run", () => {
    const chunks = planPulls({ today, floor: "2026-06-14", states: [] });
    expect(chunks).toEqual([{ from: "2026-08-23", to: "2026-09-22" }, { from: "2026-07-23", to: "2026-08-22" }, { from: "2026-06-22", to: "2026-07-22" }, { from: "2026-06-14", to: "2026-06-21" }]);
    expect(planPulls({ today, floor: "2025-09-22", states: [], maxChunks: 2 })).toHaveLength(2);
    expect(planPulls({ today, floor: "2026-09-19", states: ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"].map(reportDate => ({ reportDate, settled: true })) })).toEqual([]);
  });
});
