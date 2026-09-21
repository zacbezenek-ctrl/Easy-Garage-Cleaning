import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ZodType } from "zod/v4";

const service = vi.hoisted(() => ({
  previewConversions: vi.fn(),
  syncConversions: vi.fn(),
  conversionStatus: vi.fn(),
  retryConversions: vi.fn(),
  sendTestEvent: vi.fn()
}));
vi.mock("@egc/meta-conversions", () => service);

import { META_CONVERSION_WRITE_TOOLS, registerMetaConversionTools } from "../src/meta-conversion-tools.js";
import { requiredToolScope } from "../src/tool-access.js";

type Registration = {
  config: {
    inputSchema: ZodType;
    annotations: { readOnlyHint: boolean; idempotentHint?: boolean };
    securitySchemes: Array<{ type: string; scopes: string[] }>;
    _meta: { securitySchemes: Array<{ type: string; scopes: string[] }> };
  };
  handler: (input: unknown) => Promise<unknown>;
};

const registrations = new Map<string, Registration>();
function tool(name: string) {
  const registration = registrations.get(`meta.conversions.${name}`);
  if (!registration) throw new Error(`Tool missing: ${name}`);
  return registration;
}
async function call(name: string, input: unknown = {}) {
  const registration = tool(name);
  return registration.handler(registration.config.inputSchema.parse(input));
}

beforeEach(() => {
  vi.resetAllMocks();
  registrations.clear();
  registerMetaConversionTools({
    registerTool: (name: string, config: Registration["config"], handler: Registration["handler"]) => {
      registrations.set(name, { config, handler });
    }
  } as unknown as McpServer);
});

describe("Meta conversion MCP tools", () => {
  it("registers read-only preview/status and enforces write scope on sending/retry/test tools", () => {
    expect(registrations.size).toBe(5);
    for (const [name, { config }] of registrations) {
      const mutates = META_CONVERSION_WRITE_TOOLS.includes(name as typeof META_CONVERSION_WRITE_TOOLS[number]);
      expect(requiredToolScope(name)).toBe(mutates ? "egc:write" : "egc:read");
      expect(config.annotations.readOnlyHint).toBe(!mutates);
      expect(config.securitySchemes).toEqual([{ type: "oauth2", scopes: mutates ? ["egc:read", "egc:write"] : ["egc:read"] }]);
      expect(config._meta.securitySchemes).toEqual(config.securitySchemes);
    }
    // Moving the policy to a testable module must retain existing protections.
    expect(requiredToolScope("jobs.update")).toBe("egc:write");
    expect(requiredToolScope("appointments.delete")).toBe("egc:write");
    expect(requiredToolScope("contacts.search")).toBe("egc:read");
  });

  it("previews without invoking a mutation and preserves public JSON results", async () => {
    const preview = { events: [{ eventType: "WALKTHROUGH_BOOKED", eligible: true, matchingQuality: "phone" }] };
    service.previewConversions.mockResolvedValue(preview);
    const response = await call("preview", { days: 3, from: "2026-09-18T00:00:00Z", to: "2026-09-20T00:00:00Z", limit: 25 });
    expect(service.previewConversions).toHaveBeenCalledWith({ days: 3, from: "2026-09-18T00:00:00Z", to: "2026-09-20T00:00:00Z", limit: 25 });
    expect(response).toEqual({ content: [{ type: "text", text: JSON.stringify(preview, null, 2) }], structuredContent: { result: preview } });
    expect(service.syncConversions).not.toHaveBeenCalled();
    expect(service.retryConversions).not.toHaveBeenCalled();
    expect(service.sendTestEvent).not.toHaveBeenCalled();
  });

  it("defaults synchronization to dry-run and forwards explicit live requests", async () => {
    service.syncConversions.mockResolvedValue({ accepted: 0, skipped: 2, failed: 0, alreadySynced: 1 });
    await call("sync");
    expect(service.syncConversions).toHaveBeenLastCalledWith({ days: 7, limit: 100, dryRun: true });
    await call("sync", { dryRun: false, days: 1, limit: 10 });
    expect(service.syncConversions).toHaveBeenLastCalledWith({ days: 1, limit: 10, dryRun: false });
    expect(tool("sync").config.annotations.idempotentHint).toBe(true);
  });

  it("defaults status to a 30-day read and exposes the returned health summary", async () => {
    service.conversionStatus.mockResolvedValue({ pending: 4, failed: 0, accepted: 3 });
    expect(await call("status")).toMatchObject({ structuredContent: { result: { pending: 4, failed: 0, accepted: 3 } } });
    expect(service.conversionStatus).toHaveBeenCalledWith({ days: 30, limit: 100 });
    expect(service.syncConversions).not.toHaveBeenCalled();
  });

  it("retries only requested IDs with dry-run by default", async () => {
    service.retryConversions.mockResolvedValue({ accepted: 0, failed: 0, alreadySynced: 1 });
    const eventId = `egc_${"a".repeat(64)}`;
    await call("retry", { eventIds: [eventId] });
    expect(service.retryConversions).toHaveBeenCalledWith({ days: 7, limit: 100, dryRun: true, eventIds: [eventId] });
    expect(service.syncConversions).not.toHaveBeenCalled();
  });

  it("rejects invalid/reversed ranges and unbounded batches before service calls", async () => {
    await expect(call("preview", { from: "2026-09-20" })).rejects.toThrow();
    await expect(call("preview", { from: "2026-09-20T00:00:00Z", to: "2026-09-18T00:00:00Z" })).rejects.toThrow();
    await expect(call("sync", { days: 30 })).rejects.toThrow();
    await expect(call("sync", { limit: 101 })).rejects.toThrow();
    await expect(call("retry", { eventIds: [] })).rejects.toThrow();
    await expect(call("retry", { eventIds: Array(101).fill("event-id") })).rejects.toThrow();
    expect(service.syncConversions).not.toHaveBeenCalled();
    expect(service.retryConversions).not.toHaveBeenCalled();
  });

  it("test-event tool accepts no credentials, PII, or destination overrides", async () => {
    service.sendTestEvent.mockResolvedValue({ accepted: true, test: true });
    await call("test");
    expect(service.sendTestEvent).toHaveBeenCalledWith();
    await expect(call("test", { accessToken: "do-not-accept", email: "private@example.test", datasetId: "123" })).rejects.toThrow();
    expect(service.sendTestEvent).toHaveBeenCalledTimes(1);
  });

  it("sanitizes unexpected errors without logging provider secrets or customer data", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "Bearer fake-secret private@example.test";
    service.syncConversions.mockRejectedValue(new Error(secret));
    const response = await call("sync", { dryRun: false });
    expect(response).toMatchObject({ isError: true, structuredContent: { result: { error: "meta_conversion_operation_failed" } } });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
