import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { createFieldStore } from './field-execution-store.js';
import { fieldFingerprint, fieldId, fieldRequestId } from './field-execution.js';
import { canDispatch } from './dispatch-permissions.js';
import { hasBusinessAccess } from './hub-session.js';
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { applyPurchaseState, purchaseJobOpen, purchaseList } from './job-materials.js';

/** The office purchase list (WP14c, EGC_JOB_MATERIALS): the buy materials of upcoming jobs, grouped by store and
 * product with quantities summed across jobs (job-materials.js purchaseList), and the manager action that records
 * a purchase state on one job's materials.
 *   GET  /api/purchase-list?start=YYYY-MM-DD&end=YYYY-MM-DD   (default today and the next 13 days, at most 31 days)
 *        => {ok, authority, start, end, generatedAt, stores:[{store, products:[...]}], lines, jobs}
 *   POST /api/purchase-list {requestId, jobId, materialIds:[...], state: to_buy|ordered|purchased}
 *        => {ok, alreadyApplied, jobId, changed:[{id, name, from, to}]}
 *        (Loaded is the crew's tick on the job; a cancelled, finished or no-show job is refused: purchase_job_closed.)
 * Both need dispatch.write or field-manager (business) access. Reads: one bounded range query on jobs.date with a
 * field mask (materials, crew material states and the job's date, customer and status); more than 500 jobs in the
 * range is refused rather than truncated. A mark re-reads the job and writes its materials under the job's revision
 * with a management-only job history event (jobs/{id}/fieldEvents/{requestId}) in the same commit: the audit
 * record and the idempotency receipt. No price, cost or margin is read or returned. */
export const PURCHASE_LIST_FIELDS = Object.freeze(['type', 'recordType', 'date', 'time', 'endDate', 'status', 'pipelineStatus', 'customer', 'title', 'materials', 'fieldExecution.materialStates']);
export const PURCHASE_LIST_MAX_DAYS = 31;
export const PURCHASE_LIST_DEFAULT_DAYS = 14;
export const PURCHASE_LIST_MAX_JOBS = 500;
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = state => String(state || '').replaceAll('_', ' ');

export function requirePurchaseList(session, env) {
  if (!session) throw fail('purchase_sign_in_required', 'Sign in to the Employee Hub to open the purchase list.', 401);
  if (!canDispatch(session, env) && !hasBusinessAccess(session)) throw fail('purchase_forbidden', 'Only an operations manager or owner can open the purchase list.', 403);
}

export function purchaseRange(query = {}, now = new Date()) {
  if (!plain(query) || Object.keys(query).some(key => !['start', 'end'].includes(key))) throw fail('purchase_range_invalid', 'Choose a start and end date.');
  const start = query.start || denverToday(now), end = query.end || addDays(start, PURCHASE_LIST_DEFAULT_DAYS - 1);
  if (!validDate(start) || !validDate(end) || end < start || end > addDays(start, PURCHASE_LIST_MAX_DAYS - 1)) throw fail('purchase_range_invalid', `Choose a date range of 1 to ${PURCHASE_LIST_MAX_DAYS} days.`);
  return { start, end };
}

export function purchaseListStorage(env, fetcher = firestoreFetch) {
  const field = createFieldStore(env);
  const decode = document => {
    const prefix = '/documents/jobs/', name = document?.name, id = typeof name === 'string' && name.includes(prefix) ? name.slice(name.indexOf(prefix) + prefix.length) : '';
    if (!id || id.includes('/') || typeof document.updateTime !== 'string') throw fail('purchase_storage_incomplete', 'The purchase list could not be verified. Retry.', 503);
    return { ...decodeFirestoreFields(document.fields || {}), id, __updateTime: document.updateTime };
  };
  return {
    // Jobs dated start..end (one runQuery, single-field range: no composite index, no scan of other dates).
    async listJobs(start, end) {
      const range = (op, value) => ({ fieldFilter: { field: { fieldPath: 'date' }, op, value: { stringValue: value } } });
      const structuredQuery = { from: [{ collectionId: 'jobs' }], select: { fields: PURCHASE_LIST_FIELDS.map(fieldPath => ({ fieldPath })) },
        where: { compositeFilter: { op: 'AND', filters: [range('GREATER_THAN_OR_EQUAL', start), range('LESS_THAN_OR_EQUAL', end)] } },
        orderBy: [{ field: { fieldPath: 'date' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: PURCHASE_LIST_MAX_JOBS + 1 };
      let response;
      try { response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery }), signal: AbortSignal.timeout(20000) }); }
      catch { throw fail('purchase_storage_unavailable', 'The purchase list could not be loaded. Retry.', 503); }
      if (!response.ok) throw fail('purchase_storage_unavailable', 'The purchase list could not be loaded. Retry.', 503);
      const rows = await response.json().catch(() => null);
      if (!Array.isArray(rows) || !rows.some(row => plain(row) && (row.document !== undefined || typeof row.readTime === 'string'))) throw fail('purchase_storage_incomplete', 'The purchase list could not be verified. Retry.', 503);
      return rows.filter(row => plain(row) && row.document !== undefined).map(row => decode(row.document));
    },
    readJob: id => field.readJob(id),
    readEvent: (id, requestId) => field.readEvent(id, requestId),
    commit: (job, patch, event) => field.commit(job, patch, event),
  };
}

export async function purchaseOverview(store, session, query, { env = {}, now = new Date() } = {}) {
  requirePurchaseList(session, env);
  const { start, end } = purchaseRange(query, now), jobs = await store.listJobs(start, end);
  if (jobs.length > PURCHASE_LIST_MAX_JOBS) throw fail('purchase_range_too_large', `More than ${PURCHASE_LIST_MAX_JOBS} jobs fall in this range. Choose fewer days.`);
  if (jobs.some(job => !plain(job) || typeof job.date !== 'string' || job.date < start || job.date > end)) throw fail('purchase_storage_incomplete', 'The purchase list could not be verified. Retry.', 503);
  return { ok: true, authority: 'employee_hub', start, end, generatedAt: now.toISOString(), ...purchaseList(jobs) };
}

export async function markPurchase(store, session, input, { env = {}, now = new Date() } = {}) {
  requirePurchaseList(session, env);
  if (!plain(input) || Object.keys(input).some(key => !['requestId', 'jobId', 'materialIds', 'state', 'expectedUser'].includes(key)) || !fieldRequestId(input.requestId) || !fieldId(input.jobId)) throw fail('purchase_request_invalid', 'Choose a job, its materials and a purchase state, with a unique request ID.');
  if (input.expectedUser !== undefined && (typeof input.expectedUser !== 'string' || input.expectedUser.toLowerCase() !== session.user.toLowerCase())) throw fail('purchase_account_changed', 'Your signed-in account changed. Sign in again before retrying.', 401);
  const fingerprint = await fieldFingerprint(session.user, { action: 'purchase_state', jobId: input.jobId, materialIds: input.materialIds, state: input.state }), at = now.toISOString();
  for (let attempt = 0; ; attempt++) {
    const job = await store.readJob(input.jobId);
    if (!job || !['job', 'cleanout', 'reorg'].includes(job.type) || job.recordType) throw fail('purchase_job_missing', 'This job is no longer available. Refresh the purchase list.', 404);
    const receipt = await store.readEvent(job.id, input.requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint || receipt.state !== 'applied') throw fail('purchase_idempotency_conflict', 'This request ID was already used for a different change. Refresh before retrying.', 409);
      return { ok: true, alreadyApplied: true, jobId: job.id, changed: Array.isArray(receipt.changed) ? receipt.changed : [] };
    }
    // A purchase-list tab opened before Dispatch cancelled or closed the job never rewrites that job's materials or history.
    if (!purchaseJobOpen(job)) throw fail('purchase_job_closed', 'This job is cancelled or finished, so nothing more is bought for it. Refresh the purchase list.', 409);
    const { materials, changed } = applyPurchaseState(job, input.materialIds, input.state, session.user, at, fail);
    const event = { id: input.requestId, action: 'purchase_state', actorId: session.user, actorName: session.displayName || session.user, createdAt: at, state: 'applied', visibility: 'management', fingerprint,
      summary: changed.map(row => `${row.name}: ${label(row.from)} → ${label(row.to)}`).join('; ').slice(0, 1000), purchaseState: input.state, changed };
    try { await store.commit(job, { materials, updatedAt: at }, event); return { ok: true, alreadyApplied: false, jobId: job.id, changed }; }
    catch (error) {
      // Another change to the job won the revision: re-read it and apply the same purchase state to the latest list.
      if (error?.code !== 'FIELD_REVISION_CONFLICT' || attempt >= 2) throw error;
    }
  }
}
