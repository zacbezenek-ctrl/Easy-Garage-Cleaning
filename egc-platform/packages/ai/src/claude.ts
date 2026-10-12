/** Claude (Anthropic Messages API) behind the same `responses.create` shape the extractors already call, so the
 * prompts, strict schemas and deterministic post-validation stay exactly as they are. Plain fetch: no extra
 * dependency. Claude reads text only; audio transcription stays with the transcription provider. */

export const DEFAULT_CLAUDE_EXTRACTION_MODEL = "claude-sonnet-5-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 16_000;
const TIMEOUT_MS = 120_000;

/** Which provider extracts: EXTRACTION_PROVIDER wins; otherwise Claude whenever ANTHROPIC_API_KEY is set. */
export function extractionProvider(): "anthropic" | "openai" {
  const chosen = process.env.EXTRACTION_PROVIDER?.trim().toLowerCase();
  if (chosen === "anthropic" || chosen === "claude") return "anthropic";
  if (chosen === "openai") return "openai";
  return process.env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "openai";
}

/** The Claude model for extraction: ANTHROPIC_EXTRACTION_MODEL, else the default. */
export function claudeExtractionModel() {
  return process.env.ANTHROPIC_EXTRACTION_MODEL?.trim() || DEFAULT_CLAUDE_EXTRACTION_MODEL;
}

// Keywords Claude structured outputs do not accept. They are only removed from the request: zod still enforces every
// limit on the reply, so nothing the old schema rejected can get through.
const DROPPED = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "pattern", "default", "$schema"]);
const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
export function claudeSchema<T>(value: T, parent = ""): T {
  if (Array.isArray(value)) return value.map(item => claudeSchema(item)) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Property names are data, never keywords: keep every property whatever it is called.
    if (parent !== "properties" && parent !== "$defs" && parent !== "definitions") {
      if (DROPPED.has(key)) continue;
      if (key === "format" && !(typeof item === "string" && FORMATS.has(item))) continue;
      if (key === "minItems" && !(item === 0 || item === 1)) { out.minItems = 1; continue; }
    }
    out[key] = claudeSchema(item, key);
  }
  return out as T;
}

type InputPart = { type?: string; text?: string };
type InputMessage = { role: string; content: string | InputPart[] };
export type ResponsesRequest = { model: string; input: InputMessage[]; text: { format: { schema: Record<string, unknown> } } };
const text = (content: InputMessage["content"]) => typeof content === "string" ? content : content.map(part => part.text ?? "").join("\n");

/** A provider error the recording diagnostics already understand (status + fixed code, never the provider's text). */
function providerError(status: number, type: string, message: string) {
  const lower = message.toLowerCase();
  const code = /credit balance|billing|purchase credits/.test(lower) ? "credit_balance_exhausted"
    : status === 401 ? "invalid_api_key"
    : status === 403 ? "permission_denied"
    : status === 404 ? "model_not_found"
    : status === 429 ? "rate_limit_exceeded"
    : status === 529 || type === "overloaded_error" ? "server_is_overloaded"
    : status === 400 && /schema/.test(lower) ? "invalid_json_schema"
    : type || "provider_request_failed";
  // The existing Hub message for exhausted credits keys on 429, whichever provider ran out.
  return Object.assign(new Error(`Claude request failed (${code})`), { status: code === "credit_balance_exhausted" ? 429 : status, code });
}

/** `responses.create` for Claude: system text → system, user text → the message, strict schema → output_config. */
export function claudeClient() {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is required");
  return {
    responses: {
      async create(request: ResponsesRequest): Promise<{ output_text: string }> {
        const system = request.input.filter(m => m.role === "system").map(m => text(m.content)).join("\n");
        const user = request.input.filter(m => m.role !== "system").map(m => text(m.content)).join("\n");
        const model = /^claude/i.test(request.model) ? request.model : claudeExtractionModel();
        let response: Response;
        try {
          response = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
            body: JSON.stringify({
              model, max_tokens: MAX_OUTPUT_TOKENS,
              // The long static rules and catalog are one cacheable prefix, as with the previous provider.
              system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: user }],
              output_config: { format: { type: "json_schema", schema: claudeSchema(request.text.format.schema) } }
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });
        } catch (error) {
          const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
          throw Object.assign(new Error(timedOut ? "Claude request timed out" : "Claude request could not connect"), { name: timedOut ? "APIConnectionTimeoutError" : "APIConnectionError" });
        }
        const body = await response.json().catch(() => null) as { error?: { type?: string; message?: string }; stop_reason?: string; content?: { type: string; text?: string }[] } | null;
        if (!response.ok) throw providerError(response.status, body?.error?.type ?? "", body?.error?.message ?? "");
        // A refusal or a reply cut off at max_tokens may not match the schema: the caller's validation rejects it.
        return { output_text: (body?.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join("") };
      }
    }
  };
}
