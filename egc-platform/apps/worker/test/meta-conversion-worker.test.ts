import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@egc/meta-conversions", () => ({ syncConversions: vi.fn() }));
import { startMetaConversionWorker } from "../src/meta-conversion-worker.js";

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
