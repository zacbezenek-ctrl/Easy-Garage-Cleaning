// Only fixed categories and numeric status reach logs. Provider messages/bodies can
// contain customer text or credentials and must never be serialized here.
const knownCodes = new Set([
  'invalid_json_schema', 'invalid_api_key', 'insufficient_quota',
  'rate_limit_exceeded', 'model_not_found', 'permission_denied',
  'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
  'slow_down', 'server_is_overloaded',
  'conversation_transcript_empty', 'conversation_transcript_too_large',
  'conversation_context_invalid', 'conversation_output_invalid',
  'recording_transcript_missing',
]);
export function recordingFailureDiagnostic(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof value.status === 'number' && Number.isInteger(value.status)
    && value.status >= 400 && value.status <= 599 ? value.status : undefined;
  const code = typeof value.code === 'string' && knownCodes.has(value.code) ? value.code
    : value.message === 'OPENAI_API_KEY is required' ? 'ai_key_missing'
    : value.name === 'APIConnectionTimeoutError' ? 'ai_timeout'
    : value.name === 'APIConnectionError' ? 'ai_connection_failed'
    : status ? 'provider_request_failed' : 'processing_failed';
  return { code, ...(status ? { status } : {}) };
}
