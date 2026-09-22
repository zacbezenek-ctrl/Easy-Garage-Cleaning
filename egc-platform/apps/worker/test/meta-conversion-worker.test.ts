import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@egc/meta-conversions", () => ({ syncConversions: vi.fn() }));
import { startMetaConversionWorker, metaSyncLog } from "../src/meta-conversion-worker.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Meta conversion automatic worker", () => {
  it("reconciles immediately and every minute with bounded production-request options", async () => {
    const sync = vi.fn().mockResolvedValue({ accepted: 0 });
    const stop = startMetaConversionWorker({ sync });
    expect(sync).toHaveBeenCalledWith({ dryRun: false, limit: 100, days: 7 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("does not start overlapping scans while a sender run is pending", async () => {
    let finish!: () => void;
    const sync = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = startMetaConversionWorker({ sync });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sync).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(2);
    finish();
    stop();
  });

  it("recovers after failures and emits no raw provider exception", async () => {
    const secret = "access_token=fake-secret private@example.test";
    const sync = vi.fn().mockRejectedValueOnce(new Error(secret)).mockResolvedValue({ accepted: 1 });
    const logger = { error: vi.fn() };
    const stop = startMetaConversionWorker({ sync, logger });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
    stop();
  });
});


describe("Meta worker safe operational evidence", () => {
  it("logs only bounded aggregates, preserving unknown rather than reporting zero", () => {
    const summary = metaSyncLog({ mode: "production", dryRun: false, accepted: 3, newlySent: 3, pending: 0,
      failed: -1, skipped: NaN, discovered: Infinity, alreadySynced: "19",
      productionBlockers: ["access_token=fake-secret"], payload: { email: "private@example.invalid" },
      response: { access_token: "fake-secret" }, customer: "Private Customer" });
    expect(summary).toMatchObject({ event: "meta_conversion_sync", mode: "production", dryRun: false,
      accepted: 3, newlySent: 3, pending: 0, failed: null, skipped: null, discovered: null,
      alreadySynced: null, productionBlockerCount: 1 });
    expect(JSON.stringify(summary)).not.toMatch(/fake-secret|private@example|Private Customer/);
    for (const value of [undefined, null, [], false, "token"]) {
      expect(metaSyncLog(value)).toMatchObject({ mode: "unknown", accepted: null, productionBlockerCount: null });
    }
  });
  it("emits the actual synchronization result without changing cadence or resending", async () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const sync = vi.fn().mockResolvedValue({ mode: "production", dryRun: false, newlySent: 0,
      alreadySynced: 19, accepted: 0, pending: 0, failed: 0, productionBlockers: [] });
    const stop = startMetaConversionWorker({ sync, logger });
    await vi.advanceTimersByTimeAsync(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.info.mock.calls[0][0])).toMatchObject({ event: "meta_conversion_sync",
      mode: "production", newlySent: 0, alreadySynced: 19, pending: 0, failed: 0 });
    expect(sync).toHaveBeenCalledTimes(1);
    stop();
  });
});
