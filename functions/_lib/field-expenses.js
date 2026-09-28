import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { fieldFailure, fieldId, fieldRequestId, fieldText } from './field-execution.js';
import { createFieldStore } from './field-execution-store.js';
import { assignmentKey } from './job-assignment.js';
import { commitConflict, commitFailure } from './firestore-errors.js';

// Field costs live in jobs/{jobId}/fieldExpenses/{requestId}. Nothing is copied
// onto the job document, so crew, customer and dispatch projections of the job
// cannot carry amounts. Manager corrections and voids leave an idempotency
// receipt at jobs/{jobId}/fieldExpenseRequests/{requestId}. The deny-all
// Firestore rule keeps both subcollections server-only; every read goes through
// the assignment-checked API.
//
// Job-costing consumers (server-side only; never call these from a browser):
//   sumFieldExpenses(env, jobId, { store }) -> Promise<{ jobId, currency,
//     totalCents, byKind, count, voidCount, pendingCount, invalidCount,
//     receiptCount, complete }> (full shape in its JSDoc below).
//     env is the Pages Functions env and comes FIRST. store is optional and
//     defaults to createFieldExpenseStore(env); tests inject a fake with
//     listExpenses(jobId).
//   fieldExpenseRange(env, { start, end }, { store }) -> per-job totals for a
//     Mountain incurredOn range of at most FIELD_EXPENSE_RANGE_DAYS days,
//     both dates included.
// Both count only receipt-verified (or receipt-free) non-void entries and report
// pending or unreadable rows (complete:false) instead of treating them as zero.
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
export const FIELD_EXPENSE_KINDS = ['material', 'dump_fee', 'other'];
export const FIELD_EXPENSE_MAX_CENTS = 500000;
// Capacity counts non-void entries (verified and pending). Managers keep a
// higher allowance so one crew member cannot block operations; the stored
// limit (void rows included) keeps every job listing verifiable in one read.
export const FIELD_EXPENSE_JOB_LIMIT = 100;
export const FIELD_EXPENSE_MANAGER_JOB_LIMIT = 150;
export const FIELD_EXPENSE_PENDING_LIMIT = 5;
export const FIELD_EXPENSE_RANGE_DAYS = 92;
const AUDIT_LIMIT = 50, LIST_LIMIT = 300, RANGE_LIMIT = 2000;
export const FIELD_EXPENSE_STORED_LIMIT = LIST_LIMIT;
const EDITABLE = ['kind', 'amountCents', 'vendor', 'note', 'incurredOn'];

export const fieldExpensesEnabled = env => env?.FIELD_EXPENSES_ENABLED === 'true';
export const fieldExpenseAmount = value => Number.isSafeInteger(value) && value >= 1 && value <= FIELD_EXPENSE_MAX_CENTS;
export const fieldExpenseDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
export const validExpenseDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const dayNumber = value => Date.parse(`${value}T12:00:00Z`) / 86400000;

export function fieldExpenseValues(input, { partial = false } = {}) {
  const values = {};
  if (!partial || input.kind !== undefined) {
    if (!FIELD_EXPENSE_KINDS.includes(input.kind)) throw fieldFailure('Choose materials, dump fee or other.', 400, 'FIELD_EXPENSE_KIND_INVALID');
    values.kind = input.kind;
  }
  if (!partial || input.amountCents !== undefined) {
    if (!fieldExpenseAmount(input.amountCents)) throw fieldFailure(`Enter an amount between $0.01 and $${(FIELD_EXPENSE_MAX_CENTS / 100).toLocaleString('en-US')}.00. Larger purchases need operations approval.`, 400, 'FIELD_EXPENSE_AMOUNT_INVALID');
    values.amountCents = input.amountCents;
  }
  if (!partial || input.vendor !== undefined) {
    if (typeof input.vendor !== 'string' || input.vendor.trim().length < 2 || input.vendor.length > 120) throw fieldFailure('Enter the store, landfill or vendor (2–120 characters).', 400, 'FIELD_EXPENSE_VENDOR_INVALID');
    values.vendor = input.vendor.trim();
  }
  if (!partial || input.note !== undefined) {
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000)) throw fieldFailure('Notes must be no longer than 1,000 characters.', 400, 'FIELD_EXPENSE_NOTE_INVALID');
    values.note = fieldText(input.note, 1000);
  }
  const kind = values.kind ?? input.currentKind, note = values.note ?? input.currentNote ?? '';
  if (kind === 'other' && note.length < 3 && (!partial || values.kind !== undefined || values.note !== undefined)) throw fieldFailure('Describe what an “other” cost was for.', 400, 'FIELD_EXPENSE_NOTE_INVALID');
  return values;
}

export function summarizeFieldExpenses(entries) {
  const byKind = Object.fromEntries(FIELD_EXPENSE_KINDS.map(kind => [kind, 0]));
  let totalCents = 0, count = 0, voidCount = 0, pendingCount = 0, invalidCount = 0, receiptCount = 0;
  for (const entry of entries) {
    if (entry.status === 'void') { voidCount++; continue; }
    if (entry.state !== 'applied') { pendingCount++; continue; }
    if (!fieldExpenseAmount(entry.amountCents) || !FIELD_EXPENSE_KINDS.includes(entry.kind)) { invalidCount++; continue; }
    byKind[entry.kind] += entry.amountCents; totalCents += entry.amountCents; count++;
    if (entry.receipt?.verified === true) receiptCount++;
  }
  // Unverified receipts and unreadable rows are reported, never silently
  // counted as zero, so a dashboard can distinguish "no costs" from "unknown".
  return { currency: 'USD', totalCents, byKind, count, voidCount, pendingCount, invalidCount, receiptCount, complete: pendingCount === 0 && invalidCount === 0 };
}

const actorLabel = (id, name) => ({ id: fieldText(id, 120), name: fieldText(name || id, 150) });
const auditValues = value => Object.fromEntries([...EDITABLE, 'status'].filter(key => value && typeof value === 'object' && key in value).map(key => [key, key === 'amountCents' ? (fieldExpenseAmount(value[key]) ? value[key] : null) : fieldText(value[key], 1000)]));
export function fieldExpenseProjection(entry, { manager = false } = {}) {
  const valid = fieldExpenseAmount(entry.amountCents) && FIELD_EXPENSE_KINDS.includes(entry.kind);
  const base = {
    id: entry.id, kind: FIELD_EXPENSE_KINDS.includes(entry.kind) ? entry.kind : 'other', amountCents: fieldExpenseAmount(entry.amountCents) ? entry.amountCents : null, currency: 'USD',
    vendor: fieldText(entry.vendor, 120), note: fieldText(entry.note, 1000), createdAt: fieldText(entry.createdAt, 40), incurredOn: fieldText(entry.incurredOn, 10),
    status: entry.status === 'void' ? 'void' : 'recorded', state: entry.state === 'applied' ? 'applied' : 'pending', needsReview: !valid,
    hasReceipt: Boolean(entry.receipt?.fileId), receiptVerified: entry.receipt?.verified === true, edited: Boolean(entry.editedAt),
  };
  if (!manager) return base;
  const verifiedReceipt = base.receiptVerified && /^[A-Za-z0-9_-]{1,200}$/.test(entry.receipt.fileId || '');
  return {
    ...base, jobId: fieldText(entry.jobId, 180), jobDate: fieldText(entry.jobDate, 10), expectedRevision: entry.__updateTime || '',
    recordedBy: actorLabel(entry.actorId, entry.actorName),
    receiptUrl: verifiedReceipt ? `/api/field-expenses?jobId=${encodeURIComponent(entry.jobId)}&expenseId=${encodeURIComponent(entry.id)}&view=receipt` : null,
    voided: entry.status === 'void' ? { at: fieldText(entry.voidedAt, 40), by: actorLabel(entry.voidedBy, entry.voidedByName), reason: fieldText(entry.voidReason, 500) } : null,
    audit: (Array.isArray(entry.audit) ? entry.audit : []).slice(-AUDIT_LIMIT).map(item => ({ action: item?.action === 'void' ? 'void' : 'edit', at: fieldText(item?.at, 40), by: actorLabel(item?.actorId, item?.actorName), reason: fieldText(item?.reason, 500), before: auditValues(item?.before), after: auditValues(item?.after) })),
    canEdit: entry.state === 'applied' && entry.status !== 'void', canVoid: entry.status !== 'void',
  };
}

export function fieldExpenseListing(jobId, rows, { manager = false, user = '' } = {}) {
  const self = assignmentKey(user);
  const visible = (manager ? [...rows] : rows.filter(row => self && assignmentKey(row.actorId) === self)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
  return { jobId, scope: manager ? 'job' : 'own', entries: visible.map(row => fieldExpenseProjection(row, { manager })), totals: summarizeFieldExpenses(visible) };
}

export function fieldExpenseCapacity(rows, { manager = false, user = '', receipt = false } = {}) {
  if (rows.length >= FIELD_EXPENSE_STORED_LIMIT) throw fieldFailure('This job has reached its stored cost-record limit. Ask the owner to review its voided entries.', 409, 'FIELD_EXPENSE_LIMIT');
  const active = rows.filter(row => row.status !== 'void'), limit = manager ? FIELD_EXPENSE_MANAGER_JOB_LIMIT : FIELD_EXPENSE_JOB_LIMIT;
  if (active.length >= limit) throw fieldFailure(`This job already has ${limit} active cost entries. ${manager ? 'Void duplicates before recording more.' : 'Ask operations to review them.'}`, 409, 'FIELD_EXPENSE_LIMIT');
  const self = assignmentKey(user);
  if (receipt && active.filter(row => row.state !== 'applied' && self && assignmentKey(row.actorId) === self).length >= FIELD_EXPENSE_PENDING_LIMIT) throw fieldFailure(`You have ${FIELD_EXPENSE_PENDING_LIMIT} costs whose receipts were not confirmed. Retry those entries or ask operations to void them before adding another receipt.`, 409, 'FIELD_EXPENSE_PENDING_LIMIT');
}

export function fieldExpenseRecord(job, actor, input, fingerprint, now) {
  const values = fieldExpenseValues(input);
  return { id: input.requestId.toLowerCase(), jobId: job.id, jobDate: fieldText(job.date, 10), ...values, currency: 'USD', actorId: actor.user, actorName: actor.displayName || actor.user, createdAt: now, incurredOn: fieldExpenseDate(now), status: 'recorded', fingerprint, audit: [], updatedAt: now };
}

export function fieldExpenseChange(expense, actor, input, fingerprint, now) {
  if (!actor.manager) throw fieldFailure('Only operations managers can correct or void recorded field costs.', 403, 'FIELD_EXPENSE_MANAGER_REQUIRED');
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500) throw fieldFailure('Give a reason for the correction (3–500 characters). It is kept in the audit trail.', 400, 'FIELD_EXPENSE_REASON_INVALID');
  if (expense.status === 'void') throw fieldFailure('This cost is already void. Record a new cost if it was voided by mistake.', 409, 'FIELD_EXPENSE_VOID');
  const audit = Array.isArray(expense.audit) ? expense.audit : [];
  if (audit.length >= AUDIT_LIMIT) throw fieldFailure('This cost has reached its correction limit. Void it and record a new cost.', 409, 'FIELD_EXPENSE_AUDIT_FULL');
  const stamp = { requestId: input.requestId.toLowerCase(), fingerprint, at: now, actorId: actor.user, actorName: actor.displayName || actor.user, reason: input.reason.trim() };
  if (input.action === 'void') return { status: 'void', voidedAt: now, voidedBy: actor.user, voidedByName: stamp.actorName, voidReason: stamp.reason, updatedAt: now, audit: [...audit, { ...stamp, action: 'void', before: { status: 'recorded' }, after: { status: 'void' } }] };
  if (expense.state !== 'applied') throw fieldFailure('This cost is still waiting for its receipt to be verified. Void it instead, or ask the crew member to retry the upload.', 409, 'FIELD_EXPENSE_PENDING');
  const values = fieldExpenseValues({ ...input, currentKind: expense.kind, currentNote: expense.note }, { partial: true });
  if (input.incurredOn !== undefined) {
    const today = fieldExpenseDate(now);
    if (!validExpenseDate(input.incurredOn) || input.incurredOn > today || dayNumber(today) - dayNumber(input.incurredOn) > 366) throw fieldFailure('Choose the purchase date within the last year.', 400, 'FIELD_EXPENSE_DATE_INVALID');
    values.incurredOn = input.incurredOn;
  }
  const before = {}, after = {};
  for (const key of EDITABLE) if (key in values && values[key] !== expense[key]) { before[key] = expense[key] ?? null; after[key] = values[key]; }
  if (!Object.keys(after).length) throw fieldFailure('Change at least one value before saving the correction.', 400, 'FIELD_EXPENSE_NO_CHANGE');
  return { ...after, editedAt: now, editedBy: actor.user, updatedAt: now, audit: [...audit, { ...stamp, action: 'edit', before, after }] };
}

const decode = (document, jobId) => {
  const match = /\/documents\/jobs\/([^/]+)\/fieldExpenses\/([^/]+)$/.exec(document?.name || '');
  if (!match || !document.fields || !fieldId(match[1]) || !fieldRequestId(match[2]) || (jobId && match[1] !== jobId)) return null;
  // Path identity wins over stored fields so a copied row cannot move jobs.
  return { ...decodeFirestoreFields(document.fields), id: match[2], jobId: match[1], __updateTime: document.updateTime || '' };
};
const decodeRequest = (document, jobId, id) => {
  const match = /\/documents\/jobs\/([^/]+)\/fieldExpenseRequests\/([^/]+)$/.exec(document?.name || '');
  if (!match || !document.fields || match[1] !== jobId || match[2] !== id) return null;
  return { ...decodeFirestoreFields(document.fields), id, jobId };
};
const unavailable = () => fieldFailure('Job-cost storage is unavailable. Retry when connected.', 503, 'FIELD_STORAGE_UNAVAILABLE');
const incomplete = () => fieldFailure('Job-cost storage returned an incomplete answer. Retry.', 503, 'FIELD_EXPENSE_STORAGE_INCOMPLETE');
const jobChanged = () => fieldFailure('This job changed while the cost was being confirmed. Retry the same entry to check it again.', 409, 'FIELD_REVISION_CONFLICT');

export function createFieldExpenseStore(env, fetcher = firestoreFetch) {
  const send = async (url, options) => { try { return await fetcher(env, url, options); } catch { throw unavailable(); } };
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function query(parent, structuredQuery, jobId) {
    const response = await send(`${BASE}${parent ? `/${parent}` : ''}:runQuery`, json({ structuredQuery }));
    if (!response.ok) {
      const detail = JSON.stringify(await response.json().catch(() => ({})));
      if (response.status === 400 && /FAILED_PRECONDITION/.test(detail)) throw fieldFailure('Job-cost reporting is waiting for its storage index. Ask the owner to finish the field-cost setup.', 503, 'FIELD_EXPENSE_INDEX_REQUIRED');
      throw unavailable();
    }
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw incomplete();
    return rows.filter(row => row?.document).map(row => decode(row.document, jobId)).filter(Boolean);
  }
  async function commit(writes, conflict, transaction = '') {
    const response = await send(`${BASE}:commit`, json({ ...(transaction ? { transaction } : {}), writes }));
    if (!response.ok && commitConflict(await commitFailure(response))) throw conflict();
    if (!response.ok) throw fieldFailure('The cost could not be confirmed. Retry with the same entry to check its result.', 503, 'FIELD_STORAGE_UNAVAILABLE');
  }
  // The public REST Write has no read-only verify operation (see
  // dispatch-storage.js), so a read-write transaction that reads the job fences
  // the cost write against the job revision whose assignment was just checked,
  // without writing the job document. A concurrent job change aborts the commit.
  async function fenced(jobId, jobRevision, writes, conflict) {
    const started = await send(`${BASE}:beginTransaction`, json({ options: { readWrite: {} } }));
    if (!started.ok) throw unavailable();
    const transaction = (await started.json().catch(() => ({})))?.transaction;
    if (typeof transaction !== 'string' || !transaction) throw incomplete();
    let committed = false;
    try {
      const result = await send(`${BASE}:batchGet`, json({ documents: [`${ROOT}/jobs/${jobId}`], mask: { fieldPaths: ['type'] }, transaction }));
      if (result.status === 409 || result.status === 412) throw jobChanged();
      if (!result.ok) throw unavailable();
      const rows = await result.json().catch(() => null);
      if (!Array.isArray(rows)) throw incomplete();
      const found = rows.find(row => row?.found?.name === `${ROOT}/jobs/${jobId}`)?.found;
      if (!found || found.updateTime !== jobRevision) throw jobChanged();
      await commit(writes, conflict, transaction); committed = true;
    } finally { if (!committed) await send(`${BASE}:rollback`, json({ transaction })).catch(() => null); }
  }
  const jobs = createFieldStore(env);
  return {
    readJob: id => jobs.readJob(id),
    async readRequest(jobId, id) {
      const response = await send(`${BASE}/jobs/${jobId}/fieldExpenseRequests/${id}`);
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable();
      const row = decodeRequest(await response.json().catch(() => null), jobId, id);
      if (!row) throw fieldFailure('Job-cost storage returned an unverifiable correction record. Retry.', 503, 'FIELD_EXPENSE_STORAGE_INCOMPLETE');
      return row;
    },
    // Current schedule dates for the date-range report: one masked batchGet per
    // 100 jobs rather than one read per job.
    async jobSchedules(ids) {
      const valid = [...new Set(ids)].filter(fieldId), chunks = [];
      for (let index = 0; index < valid.length; index += 100) chunks.push(valid.slice(index, index + 100));
      const found = new Map();
      await Promise.all(chunks.map(async chunk => {
        const response = await send(`${BASE}:batchGet`, json({ documents: chunk.map(id => `${ROOT}/jobs/${id}`), mask: { fieldPaths: ['date', 'endDate'] } }));
        if (!response.ok) throw unavailable();
        const rows = await response.json().catch(() => null);
        if (!Array.isArray(rows)) throw incomplete();
        for (const row of rows) {
          const id = /\/documents\/jobs\/([^/]+)$/.exec(row?.found?.name || '')?.[1];
          if (!id || !chunk.includes(id)) continue;
          const value = decodeFirestoreFields(row.found.fields || {});
          found.set(id, { date: validExpenseDate(value.date) ? value.date : '', endDate: validExpenseDate(value.endDate) ? value.endDate : '' });
        }
      }));
      return found;
    },
    async readExpense(jobId, id) {
      const response = await send(`${BASE}/jobs/${jobId}/fieldExpenses/${id}`);
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable();
      const row = decode(await response.json().catch(() => null), jobId);
      if (!row || row.id !== id) throw fieldFailure('Job-cost storage returned an unverifiable record. Retry.', 503, 'FIELD_EXPENSE_STORAGE_INCOMPLETE');
      return row;
    },
    async listExpenses(jobId) {
      const rows = await query(`jobs/${jobId}`, { from: [{ collectionId: 'fieldExpenses' }], limit: LIST_LIMIT + 1 }, jobId);
      if (rows.length > LIST_LIMIT) throw fieldFailure('This job has more cost records than can be verified at once. Contact operations.', 503, 'FIELD_EXPENSE_STORAGE_INCOMPLETE');
      return rows;
    },
    async listRange(start, end) {
      const range = (op, value) => ({ fieldFilter: { field: { fieldPath: 'incurredOn' }, op, value: { stringValue: value } } });
      const rows = await query('', { from: [{ collectionId: 'fieldExpenses', allDescendants: true }], where: { compositeFilter: { op: 'AND', filters: [range('GREATER_THAN_OR_EQUAL', start), range('LESS_THAN_OR_EQUAL', end)] } }, limit: RANGE_LIMIT + 1 });
      if (rows.length > RANGE_LIMIT) throw fieldFailure('This date range has too many cost records to total at once. Choose a shorter range.', 400, 'FIELD_EXPENSE_RANGE_TOO_LARGE');
      return rows;
    },
    create: (jobId, record) => commit([{ update: { name: `${ROOT}/jobs/${jobId}/fieldExpenses/${record.id}`, fields: encodeFirestoreFields(record) }, currentDocument: { exists: false } }], () => fieldFailure('This cost entry was already started. Retry to check its result.', 409, 'FIELD_EXPENSE_CONFLICT')),
    // request: a correction receipt written with exists:false in the same
    // commit. jobRevision: fence the write against that job revision.
    update(jobId, expense, patch, { request = null, jobRevision = '' } = {}) {
      if (!expense.__updateTime) throw fieldFailure('The cost version is unavailable. Refresh before changing it.', 409, 'FIELD_EXPENSE_REVISION_CONFLICT');
      const writes = [{ update: { name: `${ROOT}/jobs/${jobId}/fieldExpenses/${expense.id}`, fields: encodeFirestoreFields(patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { updateTime: expense.__updateTime } }];
      if (request) writes.push({ update: { name: `${ROOT}/jobs/${jobId}/fieldExpenseRequests/${request.id}`, fields: encodeFirestoreFields(request) }, currentDocument: { exists: false } });
      const conflict = () => fieldFailure('This cost changed while you were working. Refresh to review it, then retry.', 409, 'FIELD_EXPENSE_REVISION_CONFLICT');
      return jobRevision ? fenced(jobId, jobRevision, writes, conflict) : commit(writes, conflict);
    },
  };
}

/**
 * Totals the field costs recorded on one job for the job-costing dashboard.
 * Server-side only. NOTE the argument order: the Pages Functions env comes
 * first, then the job ID (the unit spec's sumFieldExpenses(jobId) shorthand
 * omitted env).
 *
 * @param {object} env Pages Functions env (Firestore service account).
 * @param {string} jobId jobs/{jobId} document ID.
 * @param {{ store?: { listExpenses(jobId: string): Promise<object[]> } }} [options]
 *   Injected storage; defaults to createFieldExpenseStore(env).
 * @returns {Promise<{ jobId: string, currency: 'USD', totalCents: number,
 *   byKind: { material: number, dump_fee: number, other: number },
 *   count: number, voidCount: number, pendingCount: number,
 *   invalidCount: number, receiptCount: number, complete: boolean }>}
 *   Integer cents of verified, non-void entries. complete is false while any
 *   receipt is unverified or a stored row is unreadable; never treat that as
 *   a final zero.
 * @throws 400 FIELD_REQUEST_INVALID for an invalid job ID; 503 storage codes.
 */
export async function sumFieldExpenses(env, jobId, { store } = {}) {
  if (typeof env === 'string' || !env || typeof env !== 'object') throw new TypeError('sumFieldExpenses(env, jobId, { store }) takes the Pages env first.');
  if (!fieldId(jobId)) throw fieldFailure('Choose a valid job.');
  return { jobId, ...summarizeFieldExpenses(await (store || createFieldExpenseStore(env)).listExpenses(jobId)) };
}

// Inclusive range: start and end are both counted, so 92 days is Jul 1–Sep 30.
export function fieldExpenseRangeValid(start, end) {
  return validExpenseDate(start) && validExpenseDate(end) && start <= end && dayNumber(end) - dayNumber(start) + 1 <= FIELD_EXPENSE_RANGE_DAYS;
}

/**
 * Per-job field-cost totals for purchases whose Mountain incurredOn date is in
 * [start, end] (both included, at most FIELD_EXPENSE_RANGE_DAYS days).
 * jobDates come from the job's current schedule (jobDatesBasis 'current');
 * when the job is gone or its schedule cannot be read they fall back to the
 * dates recorded with each cost (jobDatesBasis 'recorded').
 */
export async function fieldExpenseRange(env, { start, end }, { store = createFieldExpenseStore(env) } = {}) {
  if (!fieldExpenseRangeValid(start, end)) throw fieldFailure(`Choose a start and end date covering at most ${FIELD_EXPENSE_RANGE_DAYS} days, both dates included.`, 400, 'FIELD_EXPENSE_RANGE_INVALID');
  const rows = await store.listRange(start, end), groups = new Map();
  for (const row of rows) { if (!groups.has(row.jobId)) groups.set(row.jobId, []); groups.get(row.jobId).push(row); }
  let schedules = null;
  if (groups.size && typeof store.jobSchedules === 'function') { try { schedules = await store.jobSchedules([...groups.keys()]); } catch { schedules = null; } }
  const jobs = [...groups].map(([jobId, entries]) => {
    const current = schedules?.get(jobId), dates = current?.date ? [current.date, current.endDate].filter(Boolean) : entries.map(entry => fieldText(entry.jobDate, 10)).filter(validExpenseDate);
    return { jobId, jobDates: [...new Set(dates)].sort(), jobDatesBasis: current?.date ? 'current' : 'recorded', ...summarizeFieldExpenses(entries) };
  }).sort((a, b) => (a.jobDates[0] || '').localeCompare(b.jobDates[0] || '') || a.jobId.localeCompare(b.jobId));
  return { start, end, basis: 'incurredOn', timezone: 'America/Denver', jobs, totals: summarizeFieldExpenses(rows) };
}
