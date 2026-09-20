import type { ConversionConfig } from "./config.js";

export type SendResult = {
  accepted: boolean; retryable: boolean; ambiguous: boolean;
  error: string | null; response: Record<string, unknown>;
};

// Strict allowlist: Meta error text can echo submitted PII or access credentials.
// Never persist/log raw bodies, URLs, headers, exceptions, or Graph error messages.
export async function sendToMeta(
  payload: Record<string, unknown>,
  config: ConversionConfig,
  test = false,
  fetcher: typeof fetch = fetch
): Promise<SendResult> {
  if (!config.verified || !config.accessToken || (test && !config.testEventCode)) {
    return { accepted: false, retryable: false, ambiguous: false, error: "configuration_incomplete", response: {} };
  }
  try {
    const response = await fetcher(`https://graph.facebook.com/${config.apiVersion}/${config.datasetId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.accessToken}` },
      body: JSON.stringify({ data: [payload], ...(test ? { test_event_code: config.testEventCode } : {}) }),
      signal: AbortSignal.timeout(15_000), redirect: "error"
    });
    let value: unknown;
    try { value = await response.json(); }
    catch { return { accepted: false, retryable: true, ambiguous: true, error: "malformed_meta_response", response: { httpStatus: response.status } }; }
    const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const rawError = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
    const safe: Record<string, unknown> = { httpStatus: response.status };
    if (typeof body.events_received === "number") safe.eventsReceived = body.events_received;
    if (typeof rawError.code === "number") safe.code = rawError.code;
    if (typeof rawError.error_subcode === "number") safe.subcode = rawError.error_subcode;
    if (typeof rawError.is_transient === "boolean") safe.transient = rawError.is_transient;
    // Keep trace IDs only if they cannot contain request/customer data.
    if (typeof body.fbtrace_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.fbtrace_id)
      && !body.fbtrace_id.includes(config.accessToken)
      && (!config.testEventCode || !body.fbtrace_id.includes(config.testEventCode))) safe.traceId = body.fbtrace_id;
    if (Array.isArray(body.messages)) safe.messageCount = body.messages.length;
    if (response.ok && body.events_received === 1 && !body.error) {
      return { accepted: true, retryable: false, ambiguous: false, error: null, response: safe };
    }
    const graphFailure = typeof rawError.code === "number";
    return {
      accepted: false,
      retryable: !graphFailure || response.status === 429 || response.status >= 500 || rawError.is_transient === true,
      ambiguous: !graphFailure,
      error: graphFailure ? "meta_api_rejected" : "unexpected_meta_response", response: safe
    };
  } catch {
    return { accepted: false, retryable: true, ambiguous: true, error: "meta_network_outcome_unknown", response: {} };
  }
}

export function retrySafety(firstAttemptAt: Date | null, eventTime: Date | null, now: Date) {
  if (!eventTime || now.valueOf() - eventTime.valueOf() > 7 * 86_400_000) return "event_expired";
  if (eventTime > now) return "future_event_time";
  // Conservative even after explicit rejection: never retry outside Meta's dedupe window.
  if (firstAttemptAt && now.valueOf() - firstAttemptAt.valueOf() >= 47 * 3_600_000) return "deduplication_window_exhausted_manual_review";
  return null;
}
