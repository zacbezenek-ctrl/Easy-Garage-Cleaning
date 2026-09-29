import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adSpendSyncLog, startAdSpendWorker } from "../src/ad-spend-worker.js";

const enabled = { EGC_AD_SPEND_META_ENABLED: "true", META_ADS_ACCESS_TOKEN: "synthetic-meta-token-never-real-0123456789", META_ADS_ACCOUNT_IDS: "1234567890" };
beforeEach(() => vi.useFakeTimers({ now: new Date("2026-09-22T18:00:00.000Z") }));
afterEach(() => vi.useRealTimers());

describe("ad spend worker", () => {
  it("contacts no provider while both flags are off and only publishes 'not connected'", async () => {
    const sync = vi.fn(), publish = vi.fn().mockResolvedValue(undefined);
    const stop = startAdSpendWorker({ sync, publish, env: { META_ADS_ACCESS_TOKEN: enabled.META_ADS_ACCESS_TOKEN, META_ADS_ACCOUNT_IDS: "1234567890" } });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(sync).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
  it("syncs at start and hourly with the parsed configuration, and stops cleanly", async () => {
    const sync = vi.fn().mockResolvedValue({ sources: [] }), publish = vi.fn();
    const stop = startAdSpendWorker({ sync, publish, env: enabled, logger: { error: vi.fn(), info: vi.fn() } });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]![0].config.meta).toMatchObject({ enabled: true, accountIds: ["1234567890"] });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sync).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });
  it("never overlaps a slow run and recovers after a failure without logging its text", async () => {
    let finish!: () => void;
    const secret = `token=${enabled.META_ADS_ACCESS_TOKEN}`;
    const sync = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockRejectedValueOnce(new Error(secret)).mockResolvedValue({ sources: [] });
    const logger = { error: vi.fn(), info: vi.fn() };
    const stop = startAdSpendWorker({ sync, env: enabled, logger });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(sync).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([logger.error.mock.calls, logger.info.mock.calls])).not.toContain(enabled.META_ADS_ACCESS_TOKEN);
    stop();
  });
  it("logs bounded per-source aggregates only, keeping unknown as null", () => {
    const summary = adSpendSyncLog({ startedAt: "2026-09-22T18:00:00.000Z", sources: [
      { source: "meta_ads", active: true, ok: false, accounts: [{ accountId: "1234567890", ok: true, pulledDays: 4, restatedDays: 1 }, { accountId: "2222222222", ok: false, code: "meta_rate_limited", pulledDays: 0, restatedDays: 0, raw: "private@example.invalid" }] },
      { source: "google_ads", active: false, ok: null, accounts: [] },
      { source: "meta_leadgen", active: true, ok: true, accounts: [{ accountId: "555000111", ok: true, pulledDays: -1, restatedDays: "2" }] }] });
    expect(summary).toEqual({ event: "ad_spend_sync",
      meta_adsActive: true, meta_adsOk: false, meta_adsFailedAccounts: 1, meta_adsPulledDays: 4, meta_adsRestatedDays: 1,
      google_adsActive: false, google_adsOk: null, google_adsFailedAccounts: 0, google_adsPulledDays: 0, google_adsRestatedDays: 0,
      meta_leadgenActive: true, meta_leadgenOk: true, meta_leadgenFailedAccounts: 0, meta_leadgenPulledDays: null, meta_leadgenRestatedDays: null });
    expect(JSON.stringify(summary)).not.toMatch(/1234567890|private@example|meta_rate_limited/);
    for (const value of [undefined, null, [], "x"]) expect(adSpendSyncLog(value)).toMatchObject({ event: "ad_spend_sync", meta_adsActive: null, meta_adsPulledDays: null });
  });
});
