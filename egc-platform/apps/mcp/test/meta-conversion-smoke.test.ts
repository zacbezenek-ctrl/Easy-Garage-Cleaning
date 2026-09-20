import { describe, expect, it, vi } from "vitest";
import { verifyMetaConversionsOnStart } from "../src/meta-conversion-smoke.js";

const env = { META_CAPI_VERIFY_ON_START: "true", MCP_BEARER_TOKEN: "synthetic-internal-credential-at-least-32-characters", MCP_PUBLIC_ORIGIN: "https://egc-mcp.example.test" };
const toolNames = ["meta.conversions.preview", "meta.conversions.sync", "meta.conversions.status", "meta.conversions.retry", "meta.conversions.test", "egc.lead_conversion_funnel"];

function fixture(sse = false) {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(init?.body as string);
    requests.push(request);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const value = request.method === "tools/list" ? { tools: toolNames.map(name => ({ name })) }
      : request.method === "initialize" ? { protocolVersion: "2025-11-25" }
      : { structuredContent: { result: {
        total: 8, eligible: 3, accepted: 0, dryRun: true,
        events: [{ email: "private@example.test", accessToken: "provider-secret" }],
        counts: { accepted: 3, pending: 1, "private@example.test": 999 },
        cohort: { allLeads: 65, eligibleMetaLeads: 8, booked: 3 },
        configuration: { mode: "shadow", tokenConfigured: false },
        productionBlockers: ["secret-that-must-not-be-logged"],
        attributionHealth: { eligible_meta_paid: 8, non_meta: 3, "private@example.test": 1 }
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
});
