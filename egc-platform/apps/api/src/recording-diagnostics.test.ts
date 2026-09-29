import { describe, expect, it } from 'vitest';
import { recordingFailureDiagnostic } from './recording-diagnostics.js';

describe('recording processing diagnostics', () => {
  it.each([
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
    'slow_down',
    'server_is_overloaded',
  ])('preserves known provider code %s without exposing response data', (code) => {
    const privateText = 'private transcript and credential';
    const status = code === 'server_is_overloaded' ? 503 : 429;
    const diagnostic = recordingFailureDiagnostic({
      status,
      code,
      message: privateText,
      headers: { authorization: privateText },
      error: { input: privateText },
    });
    expect(diagnostic).toEqual({ code, status });
    expect(JSON.stringify(diagnostic)).not.toContain(privateText);
  });
  it('distinguishes actionable provider failures without logging bodies, messages, headers or arbitrary codes', () => {
    const privateText = 'private transcript and credential';
    expect(recordingFailureDiagnostic({ status: 400, code: 'invalid_json_schema', message: privateText, headers: { authorization: privateText }, error: { input: privateText } }))
      .toEqual({ code: 'invalid_json_schema', status: 400 });
    expect(recordingFailureDiagnostic({ status: 429, code: 'insufficient_quota', message: privateText }))
      .toEqual({ code: 'insufficient_quota', status: 429 });
    expect(recordingFailureDiagnostic({ status: 403, code: privateText, request_id: privateText }))
      .toEqual({ code: 'provider_request_failed', status: 403 });
    expect(recordingFailureDiagnostic(new Error(privateText))).toEqual({ code: 'processing_failed' });
  });
  it('preserves output-validation and connection categories and rejects malformed status values', () => {
    expect(recordingFailureDiagnostic({ code: 'conversation_output_invalid', status: 503 }))
      .toEqual({ code: 'conversation_output_invalid', status: 503 });
    expect(recordingFailureDiagnostic({ name: 'APIConnectionTimeoutError' })).toEqual({ code: 'ai_timeout' });
    expect(recordingFailureDiagnostic({ name: 'APIConnectionError' })).toEqual({ code: 'ai_connection_failed' });
    expect(recordingFailureDiagnostic(new Error('OPENAI_API_KEY is required'))).toEqual({ code: 'ai_key_missing' });
    for (const status of ['400', 200, 599.5, 600, NaN]) {
      expect(recordingFailureDiagnostic({ status })).toEqual({ code: 'processing_failed' });
    }
  });
});
