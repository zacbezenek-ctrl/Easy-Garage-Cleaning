import { describe, expect, it, vi } from "vitest";
import { verifyMetaConversionsOnStart } from "../src/meta-conversion-smoke.js";

const env = { META_CAPI_VERIFY_ON_START: "true", MCP_BEARER_TOKEN: "synthetic-internal-credential-at-least-32-characters", MCP_PUBLIC_ORIGIN: "https://egc-mcp.example.test" };
const toolNames = ["meta.conversions.preview", "meta.conversions.sync", "meta.conversions.status", "meta.conversions.retry", "meta.conversions.test", "egc.lead_conversion_funnel"];

function fixture(sse = false, testValue: unknown = {}, statusExtra: Record<string, unknown> = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(init?.body as string);
    requests.push(request);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const value = request.method === "tools/list" ? { tools: toolNames.map(name => ({ name })) }
      : request.method === "initialize" ? { protocolVersion: "2025-11-25" }
      : request.params?.name === "meta.conversions.test" ? { structuredContent: { result: testValue } }
      : { structuredContent: { result: {
        total: 8, eligible: 3, accepted: 0, dryRun: true,
        events: [{ email: "private@example.test", accessToken: "provider-secret" }],
        counts: { accepted: 3, pending: 1, "private@example.test": 999 },
        cohort: { allLeads: 65, eligibleMetaLeads: 8, booked: 3 },
        configuration: { mode: "shadow", tokenConfigured: false },
        productionBlockers: ["secret-that-must-not-be-logged"],
        attributionHealth: { eligible_meta_paid: 8, non_meta: 3, "private@example.test": 1 },
        ...statusExtra
      } } };
    const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value });
    return new Response(sse ? `event: message\ndata: ${body}\n\n` : body, { headers: { "mcp-session-id": "test-session" } });
  });
  return { fetcher, requests };
}

describe("startup MCP verification", () => {
  it.each([false, true])("verifies local MCP JSON-RPC paths and logs only safe aggregates (SSE=%s)", async (sse) => {
    const { fetcher, requests } = fixture(sse);
    const logger = { log: vi.fn(), error: vi.fn() };
    await verifyMetaConversionsOnStart({ port: 4200, env, fetcher: fetcher as typeof fetch, logger });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(logger.log.mock.calls);
    for (const forbidden of [env.MCP_BEARER_TOKEN, "provider-secret", "private@example.test", "secret-that-must-not-be-logged"]) expect(output).not.toContain(forbidden);
    const calls = requests.filter(request => request.method === "tools/call").map(request => request.params);
    expect(calls).toHaveLength(4);
    expect(calls).toContainEqual({ name: "meta.conversions.sync", arguments: { days: 7, limit: 100, dryRun: true } });
    expect(calls).not.toContainEqual(expect.objectContaining({ name: "meta.conversions.test" }));
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4200/mcp");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Host: "egc-mcp.example.test", Authorization: `Bearer ${env.MCP_BEARER_TOKEN}` });
  });

  it("is inactive without explicit server configuration and fails safely without credentials", async () => {
    const { fetcher } = fixture();
    const logger = { log: vi.fn(), error: vi.fn() };
    await verifyMetaConversionsOnStart({ port: 4200, env: {}, fetcher: fetcher as typeof fetch, logger });
    expect(fetcher).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    await verifyMetaConversionsOnStart({ port: 4200, env: { META_CAPI_VERIFY_ON_START: "true" }, fetcher: fetcher as typeof fetch, logger });
    expect(fetcher).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("sanitizes HTTP, malformed reply, and provider failures", async () => {
    for (const response of [new Response("private@example.test provider-secret", { status: 403 }), new Response("not-json provider-secret"), new Response(JSON.stringify({ id: 1, error: { message: "provider-secret" } }))]) {
      const logger = { log: vi.fn(), error: vi.fn() };
      await verifyMetaConversionsOnStart({ port: 4200, env, fetcher: vi.fn().mockResolvedValue(response), logger });
      expect(logger.log).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith("Meta startup verification failed", "initialize");
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain("provider-secret");
    }
  });

  it("does not run a synthetic test when verification itself is disabled", async () => {
    const { fetcher } = fixture();
    await verifyMetaConversionsOnStart({ port: 4200, env: { ...env, META_CAPI_VERIFY_ON_START: "false", META_CAPI_TEST_ON_START: "true", META_CAPI_MODE: "shadow" }, fetcher: fetcher as typeof fetch });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["production", undefined])("refuses startup tests unless explicit shadow mode is set (mode=%s)", async (mode) => {
    const { fetcher, requests } = fixture();
    const logger = { log: vi.fn(), error: vi.fn() };
    await verifyMetaConversionsOnStart({ port: 4200, env: { ...env, META_CAPI_TEST_ON_START: "true", META_CAPI_MODE: mode }, fetcher: fetcher as typeof fetch, logger });
    expect(requests.filter(request => request.method === "tools/call")).toHaveLength(4);
    expect(requests.some(request => (request.params as { name?: string })?.name === "meta.conversions.test")).toBe(false);
    expect(logger.error).toHaveBeenCalledWith("Meta startup synthetic test refused: explicit shadow mode required.");
    expect(logger.log.mock.calls.at(-1)?.[0]).toBe("Meta startup verification passed");
  });

  it("calls the authenticated MCP test once with an empty payload and records only validated safe diagnostics", async () => {
    const id = "egc_test_12345678-1234-1234-1234-123456789abc";
    const { fetcher, requests } = fixture(false, {
      id, datasetId: "123456789", accepted: true, error: null,
      accessToken: "provider-secret", raw: "private@example.test",
      response: { events: [
        { stage: "WALKTHROUGH_BOOKED", httpStatus: 200, eventsReceived: 1, raw: "provider-secret" },
        { stage: "JOB_WON", httpStatus: 200, eventsReceived: 1, userData: "private@example.test" }
      ] }
    }, {
      lastSync: { startedAt: "2026-09-20T23:10:00Z", finishedAt: "2026-09-20T23:10:01Z", mode: "shadow", raw: "provider-secret" },
      lastTest: { createdAt: "2026-09-20T23:11:00Z", accepted: true, raw: "private@example.test" }
    });
    const logger = { log: vi.fn(), error: vi.fn() };
    await verifyMetaConversionsOnStart({ port: 4200, env: { ...env, META_CAPI_TEST_ON_START: "true", META_CAPI_MODE: "shadow" }, fetcher: fetcher as typeof fetch, logger });
    expect(logger.error).not.toHaveBeenCalled();
    const testCalls = requests.filter(request => (request.params as { name?: string })?.name === "meta.conversions.test");
    expect(testCalls).toHaveLength(1);
    expect(testCalls[0]?.params).toEqual({ name: "meta.conversions.test", arguments: {} });
    const diagnostic = JSON.parse(logger.log.mock.calls[0]?.[1]);
    expect(diagnostic).toMatchObject({ accepted: true, id, datasetId: "123456789", error: null });
    expect(diagnostic.events).toEqual([
      { stage: "WALKTHROUGH_BOOKED", httpStatus: 200, eventsReceived: 1 },
      { stage: "JOB_WON", httpStatus: 200, eventsReceived: 1 }
    ]);
    const summary = JSON.parse(logger.log.mock.calls.at(-1)?.[1]);
    expect(summary.lastSync).toEqual({ startedAt: "2026-09-20T23:10:00.000Z", finishedAt: "2026-09-20T23:10:01.000Z", mode: "shadow" });
    expect(summary.lastTest).toEqual({ createdAt: "2026-09-20T23:11:00.000Z", accepted: true });
    for (const forbidden of [env.MCP_BEARER_TOKEN, "provider-secret", "private@example.test"]) expect(JSON.stringify(logger.log.mock.calls)).not.toContain(forbidden);
  });

  it("rejects malformed success evidence and untrusted diagnostic fields without leaking them", async () => {
    const { fetcher } = fixture(false, { accepted: true, id: "private@example.test", datasetId: "provider-secret", error: "provider-secret", response: { events: [{ stage: "private@example.test", httpStatus: 200 }] } }, {
      lastSync: { startedAt: "private@example.test", finishedAt: "provider-secret", mode: "provider-secret" },
      lastTest: { createdAt: "private@example.test", accepted: "provider-secret" }
    });
    const logger = { log: vi.fn(), error: vi.fn() };
    await verifyMetaConversionsOnStart({ port: 4200, env: { ...env, META_CAPI_TEST_ON_START: "true", META_CAPI_MODE: "shadow" }, fetcher: fetcher as typeof fetch, logger });
    expect(JSON.parse(logger.log.mock.calls[0]?.[1])).toEqual({ accepted: false, id: null, datasetId: null, error: "unexpected_test_response", events: [] });
    const summary = JSON.parse(logger.log.mock.calls.at(-1)?.[1]);
    expect(summary.lastSync).toEqual({ startedAt: null, finishedAt: null, mode: null });
    expect(summary.lastTest).toEqual({ createdAt: null, accepted: null });
    for (const forbidden of ["provider-secret", "private@example.test"]) expect(JSON.stringify(logger.log.mock.calls)).not.toContain(forbidden);
  });

  it("keeps read-only verification healthy after a synthetic test transport failure without retrying", async () => {
    const { fetcher } = fixture();
    let attempts = 0;
    const failingFetcher: typeof fetch = async (url, init) => {
      const request = JSON.parse(init?.body as string);
      if (request.params?.name === "meta.conversions.test") {
        attempts++;
        throw new Error("provider-secret private@example.test");
      }
      return fetcher(url, init);
    };
    const logger = { log: vi.fn(), error: vi.fn() };
    await expect(verifyMetaConversionsOnStart({ port: 4200, env: { ...env, META_CAPI_TEST_ON_START: "true", META_CAPI_MODE: "shadow" }, fetcher: failingFetcher, logger })).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    expect(logger.error).toHaveBeenCalledWith("Meta startup synthetic test failed; inspect test status.");
    expect(logger.log.mock.calls.at(-1)?.[0]).toBe("Meta startup verification passed");
    for (const forbidden of ["provider-secret", "private@example.test"]) expect(JSON.stringify([logger.log.mock.calls, logger.error.mock.calls])).not.toContain(forbidden);
  });
});
