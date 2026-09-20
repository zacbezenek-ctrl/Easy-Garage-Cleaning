import { request as httpRequest } from "node:http";

const META_TOOLS = ["meta.conversions.preview", "meta.conversions.sync", "meta.conversions.status", "meta.conversions.retry", "meta.conversions.test"];
const PROTOCOL_VERSION = "2025-11-25";

// Node fetch rewrites Host for loopback requests. The native HTTP client lets
// the diagnostic obey the exact same public-host validation as other clients.
const fetchLoopback: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || typeof init?.body !== "string") throw new Error("invalid_diagnostic_request");
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(url, {
      method: "POST", headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.signal ? { signal: init.signal } : {})
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2_000_000) {
          response.destroy();
          reject(new Error("diagnostic_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502, headers }));
      });
    });
    request.on("error", reject);
    request.end(init.body);
  });
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numbers(value: unknown, keys: string[]) {
  const input = record(value);
  return Object.fromEntries(keys.filter(key => typeof input[key] === "number" && Number.isFinite(input[key]))
    .map(key => [key, input[key]]));
}

function timestamp(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}

function testSummary(value: Record<string, unknown>) {
  const id = typeof value.id === "string" && /^egc_test_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) ? value.id : null;
  const datasetId = typeof value.datasetId === "string" && /^\d{1,30}$/.test(value.datasetId) ? value.datasetId : null;
  const response = record(value.response);
  const events = (Array.isArray(response.events) ? response.events : []).slice(0, 2).map(record)
    .filter(event => event.stage === "WALKTHROUGH_BOOKED" || event.stage === "JOB_WON")
    .map(event => ({ stage: event.stage, ...numbers(event, ["httpStatus", "eventsReceived", "code", "subcode", "messageCount"]) }));
  const bothReceived = ["WALKTHROUGH_BOOKED", "JOB_WON"].every(stage => events.some(event => {
    const result = record(event);
    return result.stage === stage && result.eventsReceived === 1 && typeof result.httpStatus === "number" && result.httpStatus >= 200 && result.httpStatus < 300;
  }));
  const accepted = value.accepted === true && id !== null && datasetId !== null && bothReceived;
  const error = accepted ? null : ["test_configuration_incomplete", "test_event_rejected"].includes(String(value.error))
    ? value.error : "unexpected_test_response";
  return { accepted, id, datasetId, error, events };
}

function parseResponse(body: string, id: number) {
  const messages = body.trim().startsWith("{")
    ? [JSON.parse(body)]
    : body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean).map(data => JSON.parse(data));
  const message = messages.map(record).find(value => value.id === id);
  if (!message || message.error || !message.result) throw new Error("invalid_mcp_reply");
  return record(message.result);
}

function toolResult(result: Record<string, unknown>) {
  if (result.isError) throw new Error("mcp_tool_failed");
  const structured = record(result.structuredContent);
  if ("result" in structured) return record(structured.result);
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map(record).find(item => item.type === "text" && typeof item.text === "string");
  if (!text) throw new Error("mcp_result_missing");
  return record(JSON.parse(text.text as string));
}

/** Optional deploy smoke test against this process; emits only allowlisted aggregates. */
export async function verifyMetaConversionsOnStart({
  port,
  env = process.env,
  fetcher = fetchLoopback,
  logger = console
}: {
  port: number;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  logger?: Pick<Console, "log" | "error">;
}) {
  if (env.META_CAPI_VERIFY_ON_START !== "true") return;
  const token = env.MCP_BEARER_TOKEN ?? "";
  if (token.length < 32) {
    logger.error("Meta startup verification unavailable: internal diagnostic credential missing.");
    return;
  }
  let check = "initialize";
  try {
    const host = env.MCP_PUBLIC_ORIGIN ? new URL(env.MCP_PUBLIC_ORIGIN).host : "localhost";
    let id = 0;
    let session: string | null = null;
    async function request(method: string, params: Record<string, unknown>, notification = false, timeoutMs = 20_000) {
      const requestId = ++id;
      const response = await fetcher(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`, Host: host, "MCP-Protocol-Version": PROTOCOL_VERSION,
          ...(session ? { "Mcp-Session-Id": session } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: requestId }), method, params }),
        signal: AbortSignal.timeout(timeoutMs), redirect: "error"
      });
      if (!response.ok) throw new Error("mcp_http_failed");
      session = response.headers.get("mcp-session-id") ?? session;
      const body = await response.text();
      return notification ? {} : parseResponse(body, requestId);
    }

    await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "egc-startup-verification", version: "1.0.0" } });
    await request("notifications/initialized", {}, true);
    check = "tools/list";
    const listing = await request("tools/list", {});
    const names = Array.isArray(listing.tools) ? listing.tools.map(record).map(tool => tool.name) : [];
    if (!META_TOOLS.every(name => names.includes(name)) || !names.includes("egc.lead_conversion_funnel")) throw new Error("tools_missing");
    const summary: Record<string, unknown> = { tools: META_TOOLS, existingToolExposed: true };

    // A temporary deployment diagnostic, separately opted in. Never attempt a
    // test in production mode, and never retry automatically within this run.
    if (env.META_CAPI_TEST_ON_START === "true") {
      if (env.META_CAPI_MODE !== "shadow") {
        logger.error("Meta startup synthetic test refused: explicit shadow mode required.");
        summary.syntheticTest = { accepted: false, error: "shadow_mode_required" };
      } else {
        check = "meta.conversions.test";
        try {
          const value = toolResult(await request("tools/call", { name: check, arguments: {} }, false, 45_000));
          const diagnostic = testSummary(value);
          summary.syntheticTest = diagnostic;
          logger.log("Meta startup synthetic test result", JSON.stringify(diagnostic));
        } catch {
          summary.syntheticTest = { accepted: false, error: "test_operation_failed" };
          logger.error("Meta startup synthetic test failed; inspect test status.");
        }
      }
    }

    for (const [name, args] of [
      ["meta.conversions.preview", { days: 7, limit: 100 }],
      ["meta.conversions.sync", { days: 7, limit: 100, dryRun: true }],
      ["meta.conversions.status", { days: 30, limit: 100 }],
      ["egc.lead_conversion_funnel", { days: 30 }]
    ] as const) {
      check = name;
      const value = toolResult(await request("tools/call", { name, arguments: args }));
      if (value.error) throw new Error("mcp_operation_failed");
      if (name === "meta.conversions.preview") {
        summary.preview = numbers(value, ["total", "eligible", "alreadySynced"]);
        summary.attributionHealth = numbers(value.attributionHealth, ["eligible_meta_paid", "meta_insufficient_matching", "non_meta", "ambiguous"]);
      } else if (name === "meta.conversions.sync") {
        if (value.dryRun !== true || value.accepted !== 0) throw new Error("dry_run_invariant_failed");
        summary.dryRun = { dryRun: true, ...numbers(value, ["total", "eligible", "accepted", "skipped", "failed", "alreadySynced"]) };
      } else if (name === "meta.conversions.status") {
        summary.ledgerCounts = numbers(value.counts, ["pending", "processing", "accepted", "failed", "skipped"]);
        summary.cohort = numbers(value.cohort, ["allLeads", "eligibleMetaLeads", "booked", "customers", "stillUnqualified", "walkthroughRate", "customerRate"]);
        const configuration = record(value.configuration);
        summary.configuration = {
          mode: configuration.mode === "production" ? "production" : "shadow",
          destinationVerified: configuration.destinationVerified === true,
          tokenConfigured: configuration.tokenConfigured === true,
          productionBlockerCount: Array.isArray(value.productionBlockers) ? value.productionBlockers.length : 0
        };
        const lastSync = record(value.lastSync), lastTest = record(value.lastTest);
        summary.lastSync = {
          startedAt: timestamp(lastSync.startedAt), finishedAt: timestamp(lastSync.finishedAt),
          mode: ["shadow", "production", "retry"].includes(String(lastSync.mode)) ? lastSync.mode : null
        };
        summary.lastTest = { createdAt: timestamp(lastTest.createdAt), accepted: typeof lastTest.accepted === "boolean" ? lastTest.accepted : null };
      } else {
        summary.existingFunnel = numbers(value, ["total", "leadToBookedRate"]);
      }
    }
    logger.log("Meta startup verification passed", JSON.stringify(summary));
  } catch {
    // Only check labels generated above can reach this log; never the response,
    // request headers, raw exceptions, matching values, or record identifiers.
    logger.error("Meta startup verification failed", check);
  }
}
