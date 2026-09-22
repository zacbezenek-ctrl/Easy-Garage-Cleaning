/** Diagnostics are deliberately finite: never persist arbitrary provider text, SQL or credentials. */
export const reconciliationStages = ['startup', 'hub_calendar', 'hub_job', 'provider_snapshot', 'hub_evidence', 'booking_repair', 'diagnostic_save', 'canonical_ingestion', 'inbound_activation', 'inbound_policy', 'inbound_messages', 'inbound_create', 'inbound_answered', 'inbound_complete', 'inbound_save'] as const;
export type ReconciliationStage = typeof reconciliationStages[number];
const codes = new Set([
  'reconciliation_unavailable', 'portal_authority_unavailable', 'portal_source_unavailable', 'portal_identity_unverified',
  'operations_not_enabled', 'operations_auth_mode_invalid', 'operations_bridge_not_configured', 'workspace_forbidden', 'unauthorized', 'read_only_portal_command_required', 'request_too_large',
  'invalid_service_signature', 'service_signing_not_configured', 'service_origin_not_trusted', 'service_key_unavailable', 'invalid_service_claims', 'service_signature_expired', 'invalid_service_actor', 'invalid_service_request', 'service_request_too_large', 'service_key_source_unavailable', 'invalid_service_public_key', 'invalid_service_key_source', 'unknown_service_key', 'service_replay_store_unavailable', 'service_request_replayed', 'invalid_service_nonce',
  'hub_calendar_unavailable', 'hub_calendar_pagination_stalled', 'hub_evidence_identity_or_coverage_invalid', 'hub_evidence_record_identity_invalid', 'hub_evidence_record_date_invalid', 'hub_evidence_record_value_invalid', 'hub_evidence_coverage_incomplete', 'hub_evidence_unavailable_or_invalid',
  'inbound_policy_unresolved', 'inbound_owner_unresolved', 'inbound_activation_invalid', 'inbound_action_write_failed', 'inbound_reconciliation_unavailable',
  'network_unavailable', 'request_timeout', 'invalid_json_response', 'database_unavailable',
]);
const sqlStates = new Set(['08000', '08001', '08003', '08006', '08P01', '23502', '23503', '23505', '23514', '25P02', '40001', '40P01', '42501', '42703', '42804', '42883', '42P01', '53300', '53400', '57014', '57P01', '57P02', '57P03']);
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const status = (value: unknown) => Number.isInteger(value) && Number(value) >= 400 && Number(value) <= 599 ? Number(value) : undefined;
export const safeReconciliationCode = (value: unknown): string | null => typeof value === 'string' && codes.has(value) ? value : null;
export type ReconciliationDiagnostic = {stage: ReconciliationStage; errorCode: string; httpStatus?: number; upstreamStatus?: number; sqlState?: string};
export function reconciliationDiagnostic(error: unknown, stage: ReconciliationStage = 'startup'): ReconciliationDiagnostic {
  if (error instanceof ReconciliationFailure) return {...error.diagnostic};
  const result: ReconciliationDiagnostic = {stage, errorCode: 'reconciliation_unavailable'};
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const e = obj(current), known = safeReconciliationCode(e.code) ?? safeReconciliationCode(e.message);
    if (known && result.errorCode === 'reconciliation_unavailable') result.errorCode = known;
    if (status(e.status) !== undefined && result.httpStatus === undefined) result.httpStatus = status(e.status)!;
    const upstreamStatus = status(obj(e.details).upstreamStatus);
    if (upstreamStatus !== undefined && result.upstreamStatus === undefined) result.upstreamStatus = upstreamStatus;
    if (typeof e.code === 'string' && sqlStates.has(e.code)) {result.sqlState = e.code; if (result.errorCode === 'reconciliation_unavailable') result.errorCode = 'database_unavailable';}
    if (typeof e.code === 'string' && networkCodes.has(e.code) && result.errorCode === 'reconciliation_unavailable') result.errorCode = 'network_unavailable';
    if (['TimeoutError', 'AbortError'].includes(String(e.name)) && result.errorCode === 'reconciliation_unavailable') result.errorCode = 'request_timeout';
    if (e.name === 'SyntaxError' && result.errorCode === 'reconciliation_unavailable') result.errorCode = 'invalid_json_response';
    current = e.cause;
  }
  return result;
}
export class ReconciliationFailure extends Error {
  readonly diagnostic: ReconciliationDiagnostic;
  constructor(error: unknown, stage: ReconciliationStage) {
    const diagnostic = reconciliationDiagnostic(error, stage);
    super(diagnostic.errorCode);
    this.name = 'ReconciliationFailure';
    this.diagnostic = diagnostic;
  }
}
