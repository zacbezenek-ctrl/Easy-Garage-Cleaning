import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zodTextFormat } from "openai/helpers/zod";
import { walkthroughModelOutputSchema } from "@egc/schemas";
import { DEFAULT_CLAUDE_EXTRACTION_MODEL, claudeClient, claudeSchema, extractionProvider } from "./claude.js";
import { conversationModelOutputSchema, extractConversation } from "./conversation-extraction.js";
import { extractWalkthrough } from "./index.js";

const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "pattern", "default"];
function keywords(value: unknown, parent = "", found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(item => keywords(item, "", found));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { if (parent !== "properties") found.add(key); keywords(item, key, found); }
  return found;
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let calls: { url: string; init: RequestInit }[] = [];
const respond = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply(body, status); }));
const sent = () => JSON.parse(String(calls.at(-1)!.init.body));

beforeEach(() => { calls = []; vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-claude-key"); vi.stubEnv("EXTRACTION_PROVIDER", undefined); vi.stubEnv("ANTHROPIC_EXTRACTION_MODEL", undefined); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Claude extraction provider", () => {
  it("is chosen by ANTHROPIC_API_KEY and can be forced either way", () => {
    expect(extractionProvider()).toBe("anthropic");
    vi.stubEnv("EXTRACTION_PROVIDER", "openai"); expect(extractionProvider()).toBe("openai");
    vi.stubEnv("EXTRACTION_PROVIDER", undefined); vi.stubEnv("ANTHROPIC_API_KEY", ""); expect(extractionProvider()).toBe("openai");
    vi.stubEnv("EXTRACTION_PROVIDER", "claude"); expect(extractionProvider()).toBe("anthropic");
  });

  it("sends both strict schemas without any keyword Claude rejects, keeping every property and closed object", () => {
    for (const schema of [zodTextFormat(conversationModelOutputSchema, "c").schema, zodTextFormat(walkthroughModelOutputSchema, "w").schema]) {
      const cleaned = claudeSchema(schema), seen = keywords(cleaned);
      for (const keyword of UNSUPPORTED) expect(seen.has(keyword), keyword).toBe(false);
      expect(JSON.stringify(cleaned).match(/"additionalProperties":false/g)?.length).toBe(JSON.stringify(schema).match(/"additionalProperties":false/g)?.length);
      expect(JSON.stringify(cleaned).match(/"required":/g)?.length).toBe(JSON.stringify(schema).match(/"required":/g)?.length);
    }
    expect(claudeSchema({ type: "object", properties: { maxLength: { type: "string", maxLength: 3 } }, required: ["maxLength"] })).toEqual({ type: "object", properties: { maxLength: { type: "string" } }, required: ["maxLength"] });
    expect(claudeSchema({ type: "array", items: { type: "string" }, minItems: 3 })).toEqual({ type: "array", items: { type: "string" }, minItems: 1 });
  });

  it("calls the Messages API with the system rules, the transcript and output_config", async () => {
    respond({ content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn" });
    const out = await claudeClient().responses.create({ model: "gpt-ignored", input: [{ role: "system", content: [{ type: "input_text", text: "RULES" }] }, { role: "user", content: [{ type: "input_text", text: "TRANSCRIPT" }] }], text: { format: { schema: { type: "object", properties: {}, required: [], additionalProperties: false } } } });
    expect(out.output_text).toBe('{"ok":true}');
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("synthetic-claude-key"); expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = sent();
    expect(body.model).toBe(DEFAULT_CLAUDE_EXTRACTION_MODEL);
    expect(body.system[0].text).toBe("RULES"); expect(body.messages).toEqual([{ role: "user", content: "TRANSCRIPT" }]);
    expect(body.output_config.format.type).toBe("json_schema");
  });

  it("honours ANTHROPIC_EXTRACTION_MODEL and needs the key only when it will call", async () => {
    vi.stubEnv("ANTHROPIC_EXTRACTION_MODEL", " claude-haiku-5-5 ");
    respond({ content: [{ type: "text", text: "{}" }] });
    await claudeClient().responses.create({ model: "gpt-x", input: [], text: { format: { schema: {} } } });
    expect(sent().model).toBe("claude-haiku-5-5");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => claudeClient()).toThrow("ANTHROPIC_API_KEY is required");
  });

  it("maps exhausted credits to the existing credits-exhausted signal and never leaks the provider text", async () => {
    respond({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, 400);
    const error = await claudeClient().responses.create({ model: "claude-x", input: [], text: { format: { schema: {} } } }).catch(e => e);
    expect([error.status, error.code]).toEqual([429, "credit_balance_exhausted"]);
    expect(String(error.message)).not.toContain("credit balance is too low");
    respond({ error: { type: "authentication_error", message: "bad key" } }, 401);
    expect((await claudeClient().responses.create({ model: "claude-x", input: [], text: { format: { schema: {} } } }).catch(e => e)).code).toBe("invalid_api_key");
    respond({ error: { type: "overloaded_error", message: "x" } }, 529);
    expect((await claudeClient().responses.create({ model: "claude-x", input: [], text: { format: { schema: {} } } }).catch(e => e)).code).toBe("server_is_overloaded");
  });

  it("runs the conversation extractor end to end on Claude, with the same post-validation", async () => {
    respond({ content: [{ type: "text", text: "not json" }] });
    const result = await extractConversation("Customer: can you send me the quote by Friday please", { catalog: [], context: { sourceKind: "visit_transcript", occurredAt: "2026-10-12T17:00:00Z" } });
    expect(result).toEqual({ ok: false, code: "conversation_output_invalid", retryable: true });
    expect(sent().model).toBe(DEFAULT_CLAUDE_EXTRACTION_MODEL);
    expect(sent().messages[0].content).toContain("send me the quote");
  });

  it("runs the legacy walkthrough extractor on Claude and rejects unparseable output", async () => {
    respond({ content: [{ type: "text", text: "nope" }] });
    await expect(extractWalkthrough("Customer: the couch goes, the bikes stay")).rejects.toThrow("Walkthrough extraction returned no structured output");
    expect(sent().output_config.format.schema.additionalProperties).toBe(false);
  });
});
