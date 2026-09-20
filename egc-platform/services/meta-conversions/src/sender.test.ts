import { describe, expect, it, vi } from "vitest";
import { conversionConfig, configurationHealth, productionBlockers } from "./config.js";
import { retrySafety, sendToMeta } from "./sender.js";

const env = { META_CAPI_DATASET_ID: "1262944809378035", META_CAPI_DATASET_VERIFIED_ID: "1262944809378035",
  META_CAPI_ACCESS_TOKEN: "SECRET_CANARY_NEVER_RETURN", META_CAPI_TEST_EVENT_CODE: "TEST_SECRET_CANARY" };
const config = conversionConfig(env);
const payload = { event_id: "fixed", event_time: 1789900000, event_name: "WALKTHROUGH_BOOKED", user_data: { ph: ["hash"] } };
const fakeFetch = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("Meta transport", () => {
  it("accepts exactly one acknowledged event and keeps token only in auth header", async () => {
    const fetcher = fakeFetch({ events_received: 1, fbtrace_id: "safe_trace" });
    expect(await sendToMeta(payload, config, false, fetcher)).toMatchObject({ accepted: true, error: null });
    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(String(url)).not.toContain(env.META_CAPI_ACCESS_TOKEN);
    expect(init?.headers).toHaveProperty("Authorization", `Bearer ${env.META_CAPI_ACCESS_TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({ data: [payload] });
  });
  it("uses the official top-level test code only for explicit tests", async () => {
    const fetcher = fakeFetch({ events_received: 1 });
    await sendToMeta(payload, config, true, fetcher);
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]?.body))).toEqual({ data: [payload], test_event_code: env.META_CAPI_TEST_EVENT_CODE });
  });
  it("blocks missing destination verification and test code without network", async () => {
    const fetcher = fakeFetch({ events_received: 1 });
    expect((await sendToMeta(payload, { ...config, verified: false }, false, fetcher)).accepted).toBe(false);
    expect((await sendToMeta(payload, { ...config, testEventCode: "" }, true, fetcher)).accepted).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { events_received: "1" }, { events_received: 0 }, { events_received: 2 }])("rejects malformed acknowledgment %j", async body => {
    expect(await sendToMeta(payload, config, false, fakeFetch(body))).toMatchObject({ accepted: false, ambiguous: true });
  });
  it("treats invalid JSON and network exceptions as unknown outcomes", async () => {
    expect(await sendToMeta(payload, config, false, vi.fn(async () => new Response("<html>")) as typeof fetch)).toMatchObject({ accepted: false, ambiguous: true, error: "malformed_meta_response" });
    const fetcher = vi.fn(async () => { throw new Error(env.META_CAPI_ACCESS_TOKEN); }) as typeof fetch;
    expect(await sendToMeta(payload, config, false, fetcher)).toMatchObject({ ambiguous: true, error: "meta_network_outcome_unknown" });
  });
  it.each([429, 500, 503])("retries transient HTTP %i", async status => {
    expect(await sendToMeta(payload, config, false, fakeFetch({ error: { code: 2, is_transient: true } }, status))).toMatchObject({ accepted: false, retryable: true });
  });
  it("rejects invalid credentials permanently and never returns/logs provider error text", async () => {
    const log = vi.spyOn(console, "error");
    const result = await sendToMeta(payload, config, false, fakeFetch({
      error: { code: 190, message: `${env.META_CAPI_ACCESS_TOKEN} customer@example.com`, error_data: { token: env.META_CAPI_ACCESS_TOKEN } },
      messages: [env.META_CAPI_ACCESS_TOKEN], fbtrace_id: "invalid secret string"
    }, 400));
    expect(result).toMatchObject({ accepted: false, retryable: false, error: "meta_api_rejected", response: { code: 190 } });
    expect(JSON.stringify(result)).not.toContain("SECRET_CANARY");
    expect(JSON.stringify(result)).not.toContain("customer@example.com");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("uses identical payloads and IDs on retry", async () => {
    const fetcher = fakeFetch({ events_received: 1 });
    await sendToMeta(payload, config, false, fetcher); await sendToMeta(payload, config, false, fetcher);
    expect(vi.mocked(fetcher).mock.calls[0]![1]?.body).toBe(vi.mocked(fetcher).mock.calls[1]![1]?.body);
  });
});

describe("production guard and retry horizon", () => {
  it("defaults to shadow and requires explicit start, funnel, destination, token and a successful test", () => {
    expect(productionBlockers(conversionConfig({}), false)).toContain("shadow_mode");
    const enabled = conversionConfig({ ...env, META_CAPI_MODE: "production", META_CAPI_START_AT: "2026-09-20T00:00:00Z", META_CAPI_FUNNEL_VERIFIED: "true", META_CAPI_WALKTHROUGH_CALENDAR_IDS: "walk" });
    expect(productionBlockers(enabled, true)).toEqual([]);
    expect(productionBlockers(enabled, false)).toEqual(["accepted_test_event_required"]);
    expect(JSON.stringify(configurationHealth(enabled))).not.toContain("SECRET_CANARY");
  });
  it("will not refresh timestamps or retry past dedupe/age windows", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    expect(retrySafety(new Date(now.valueOf() - 47 * 3_600_000), new Date(now.valueOf() - 3 * 86_400_000), now)).toContain("manual_review");
    expect(retrySafety(null, new Date(now.valueOf() - 8 * 86_400_000), now)).toBe("event_expired");
    expect(retrySafety(null, new Date(now.valueOf() + 1000), now)).toBe("future_event_time");
    expect(retrySafety(null, now, now)).toBeNull();
  });
});
