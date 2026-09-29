import { requireDispatcher } from './dispatch-service.js';
import { auditWrite } from './hub-audit.js';
import { hubRecordEligibility } from './funnel-definitions.js';
import { MAX_TOTAL_CENTS, moneyCents } from './money-core.js';
import { payOwnerOnly, seesLaborCost } from './pay-visibility.js';

/**
 * JOB-COST-PRIVACY: the labor dollars entered for a job live in the server-only jobLaborCosts/{jobId} record
 * (firestore.rules denies every browser), never on jobs/{id}: every business user can read that document and the Hub
 * streams it to every manager's browser, and on a job one employee worked alone labor over hours is that employee's
 * rate. A record's laborCents is whole cents, or null when the owner left labor blank (unknown). Older saves left a
 * copy on the job (costs.labor, costs.laborCents and the older top-level laborCost); a blank costs.labor (null) is the
 * Hub's "unknown" marker, which reveals nothing. Readers fall back to the copy until
 * scripts/backfill-job-labor-private.mjs moves it, every owner-only server labor save moves it, and the rules refuse a
 * browser write that adds or changes one (dropping one only once the record exists).
 * With EGC_STAFF_PAY_OWNER_ONLY=false (actor.laborOnJob) every save also writes the figure back onto the job, where
 * it was before, so the jobs the older code reads keep today's data.
 *   saveJobLabor(store, actor, input, now) / listJobLabor(store, actor)
 * store: {read(collection,id), commit(writes), laborRecords()} (moneyStorage or a fake). A job write may carry
 * `remove`, field paths to delete in the same commit, and `mask`, the field paths it sets (default: its patch keys).
 * actor is the session plus laborCostVisible and laborOnJob, which the handler resolves from the session and env
 * (laborCostViewer); without them only the owner sees labor and nothing is written onto the job, the flag's default.
 */
export const JOB_LABOR_COSTS = 'jobLaborCosts';
export const JOB_LABOR_RECEIPTS = 'jobLaborCostOperations';
export const LEGACY_JOB_LABOR_FIELDS = Object.freeze(['costs.labor', 'costs.laborCents', 'laborCost']);

const KEYS = ['requestId', 'jobId', 'laborCents', 'expectedRevision', 'actorId'];
const FINAL = new Set(['job_labor_idempotency_conflict', 'job_labor_changed_since_operation', 'job_labor_actor_changed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const str = (value, max = 120) => typeof value === 'string' ? value.slice(0, max) : null;
const fail = (reason, message, status = 400) => Object.assign(new Error(message), { code: `job_labor_${reason}`, status });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
// The jobs whose money the Hub manages (money-service moneyJob): never walkthroughs, blocks or private records.
const laborJob = job => Boolean(job) && safeId(job.id) && hubRecordEligibility(job).exclusion !== 'private_record' && !['walkthrough', 'blocked', 'availability'].includes(job.type);
export const validLaborCents = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOTAL_CENTS;
/** A record's figure: whole cents, or null for the owner's blank (unknown). */
export const validLaborFigure = value => value === null || validLaborCents(value);

/** The viewer as the labor readers and writers take it: the session plus whether it sees labor dollars and whether saves also go onto the job. */
export const laborCostViewer = (session, env) => session ? { ...session, laborCostVisible: seesLaborCost(session, env), laborOnJob: !payOwnerOnly(env) } : session;
export const laborCostVisible = actor => typeof actor?.laborCostVisible === 'boolean' ? actor.laborCostVisible : seesLaborCost(actor, {});
export const laborOnJob = actor => actor?.laborOnJob === true;
/** The job's costs.labor in dollars as the Hub dialog wrote it: null for a blank. */
export const jobLaborDollars = laborCents => laborCents === null ? null : laborCents / 100;

export const legacyJobLaborFields = job => LEGACY_JOB_LABOR_FIELDS.filter(path => {
  const [head, key] = path.split('.');
  return key ? plain(job?.[head]) && job[head][key] !== undefined : plain(job) && job[head] !== undefined;
});

const UNKNOWN = 'unknown', UNREADABLE = 'unreadable';
const reading = (value, cents) => value === null ? UNKNOWN : cents ?? UNREADABLE;
/**
 * What the copies an older save left on the job say, as every reader before the private record showed them: the
 * finance board read costs.labor, else laborCost (a blank costs.labor, the Hub's unknown marker, hides laborCost), and
 * /api/money read costs.laborCents, else costs.labor. A laborCost behind a costs.labor was never shown.
 *   fields  every copy field present (a null included): what a move deletes
 *   figure  true when a field holds something other than null (a dollar figure to keep private)
 *   state   'none' (no field), 'empty' (only a null laborCost), 'value' (every shown copy agrees on `cents`),
 *           'unknown' (every shown copy is blank), or 'review' (`reason`: the shown copies disagree, or one is not a
 *           readable dollar amount). A 'review' copy is never moved or deleted by a move: the owner decides.
 */
export function legacyJobLabor(job) {
  const fields = legacyJobLaborFields(job), costs = plain(job?.costs) ? job.costs : {}, readings = [];
  if (!fields.length) return { fields, figure: false, state: 'none', cents: null };
  if (costs.labor !== undefined) readings.push(reading(costs.labor, moneyCents(costs.labor)));
  else if (job.laborCost !== undefined && job.laborCost !== null) readings.push(reading(job.laborCost, moneyCents(job.laborCost)));
  if (costs.laborCents !== undefined) readings.push(reading(costs.laborCents, validLaborCents(costs.laborCents) ? costs.laborCents : null));
  const figure = fields.some(path => { const [head, key] = path.split('.'); return (key ? job[head][key] : job[head]) !== null; });
  const base = { fields, figure, cents: null };
  if (!readings.length) return { ...base, state: 'empty' };
  if (readings.some(value => value === UNREADABLE || value !== UNKNOWN && !validLaborCents(value))) return { ...base, state: 'review', reason: 'labor_copy_unreadable' };
  if (new Set(readings).size > 1) return { ...base, state: 'review', reason: 'labor_copies_disagree' };
  return readings[0] === UNKNOWN ? { ...base, state: 'unknown' } : { ...base, state: 'value', cents: readings[0] };
}
/** The copy's agreed figure in cents; null when there is none, it is blank, or it needs review. */
export const legacyJobLaborCents = job => { const legacy = legacyJobLabor(job); return legacy.state === 'value' ? legacy.cents : null; };

/** The job without any labor copy, for a business response to a viewer who does not see labor dollars. */
export function withoutJobLabor(job) {
  if (!plain(job) || !legacyJobLaborFields(job).length) return job;
  const { laborCost, ...rest } = job;
  if (!plain(rest.costs)) return rest;
  const { labor, laborCents, ...costs } = rest.costs;
  return { ...rest, costs };
}

export const laborRecordPatch = (jobId, laborCents, { recordedAt = null, recordedBy = null, source, requestId = null, movedAt = null }) =>
  ({ jobId, laborCents, recordedAt, recordedBy, source, ...(requestId ? { requestId } : {}), ...(movedAt ? { movedAt } : {}) });

/**
 * Moving a job's labor copy off the job in the commit that changes the job: `remove` lists the copy's field paths (the
 * caller's job write deletes them), and when the job has no private record yet the copy becomes one (source
 * legacy_job; a blank copy becomes a blank record). An existing record always wins over a stale copy. Without a
 * record, a copy that needs review, or one that is only blank (it reveals nothing), stays where it is: `keep` is true.
 */
export function legacyLaborMove(job, record, now) {
  const legacy = legacyJobLabor(job), costs = plain(job?.costs) ? job.costs : {};
  if (!legacy.fields.length) return { remove: [], writes: [], keep: false, legacy };
  if (record) return { remove: legacy.fields, writes: [], keep: false, legacy };
  if (legacy.state === 'review' || !legacy.figure || !['value', 'unknown'].includes(legacy.state)) return { remove: [], writes: [], keep: true, legacy };
  return { remove: legacy.fields, keep: false, legacy, writes: [{ collection: JOB_LABOR_COSTS, id: job.id,
    patch: laborRecordPatch(job.id, legacy.state === 'value' ? legacy.cents : null, { recordedAt: str(costs.recordedAt, 40), recordedBy: str(costs.recordedBy), source: 'legacy_job', movedAt: now }) }] };
}

const recordView = row => ({ jobId: row.id, laborCents: row.laborCents, recordedAt: str(row.recordedAt, 40), recordedBy: str(row.recordedBy), revision: row.revision });
const validRecord = row => plain(row) && safeId(row.id) && validLaborFigure(row.laborCents) && typeof row.revision === 'string' && Boolean(row.revision);

export function requireLaborOwner(actor) {
  try { requireDispatcher(actor); }
  catch (error) {
    if (error.status === 401) throw fail('sign_in_required', 'Sign in to the Employee Hub to open job labor cost.', 401);
    throw fail('forbidden', 'Only an operations manager or owner can open job labor cost.', 403);
  }
  if (!laborCostVisible(actor)) throw fail('owner_only', 'Only the owner sees and enters job labor dollars.', 403);
}

/** Every job's private labor record for a viewer who sees labor dollars; a record that cannot be read fails the whole list. */
export async function listJobLabor(store, actor) {
  requireLaborOwner(actor);
  let rows;
  try { rows = await store.laborRecords(); } catch { throw fail('storage_unavailable', 'Job labor costs could not be loaded. Retry.', 503); }
  if (!Array.isArray(rows) || rows.some(row => !validRecord(row))) throw fail('storage_incomplete', 'Job labor costs could not be read completely. Retry, and nothing is shown until they are.', 503);
  return rows.map(recordView).sort((a, b) => a.jobId.localeCompare(b.jobId));
}

function validate(input, actor) {
  if (!plain(input) || Object.keys(input).some(key => !KEYS.includes(key)) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'Use a supported labor cost request with a unique request ID.');
  if (!safeId(input.jobId)) throw fail('request_invalid', 'Choose a valid job.');
  if (!Object.hasOwn(input, 'laborCents') || !validLaborFigure(input.laborCents)) throw fail('invalid_amount', 'Labor cost must be whole cents from $0.00 to $1,000,000.00, or null to leave it unknown.');
  if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 100)) throw fail('request_invalid', 'Refresh the labor cost before changing it.');
  if (input.actorId !== undefined && String(input.actorId).trim().toLowerCase() !== String(actor.user).trim().toLowerCase()) throw fail('actor_changed', 'The signed-in employee changed. Sign in as the original employee to finish this request, or discard it.', 403);
}

const result = (record, replayed) => ({ ok: true, authority: 'employee_hub', replayed, labor: recordView(record) });

/**
 * Saves the owner's labor figure (whole cents, or null to leave it unknown) for one job in ONE commit: the private
 * record (updateTime precondition from input.expectedRevision, or create-only when that is null), the job write (its
 * updateTime precondition) that removes any labor copy on the job, or, with EGC_STAFF_PAY_OWNER_ONLY=false
 * (actor.laborOnJob), sets costs.labor to the figure in dollars as the Hub dialog always did, a create-only
 * jobLaborCostOperations/{requestId} receipt (sha256 of {actor,input}) and an owner-only hub_audit entry. A replay
 * returns the saved record; the same requestId with another payload is job_labor_idempotency_conflict.
 */
export async function saveJobLabor(store, actor, input, now = new Date().toISOString()) {
  requireLaborOwner(actor);
  validate(input, actor);
  const fingerprint = await digest({ actor: actor.user, input }), receiptId = input.requestId.toLowerCase();
  async function replay(replayed) {
    const receipt = await store.read(JOB_LABOR_RECEIPTS, receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor.user) throw fail('idempotency_conflict', 'This request ID was already used for a different labor cost. Refresh before saving.', 409);
    const record = await store.read(JOB_LABOR_COSTS, receipt.jobId);
    if (!record || record.requestId !== input.requestId) throw fail('changed_since_operation', 'That labor cost was saved, but it has changed since. Refresh to see the current figure.', 409);
    return result(record, replayed);
  }
  async function execute() {
    const job = await store.read('jobs', input.jobId);
    if (!laborJob(job)) throw fail('job_not_found', 'This job is not available for labor cost.', 404);
    if (typeof job.revision !== 'string' || !job.revision) throw fail('storage_incomplete', 'The job has no verifiable revision. Retry.', 503);
    const record = await store.read(JOB_LABOR_COSTS, job.id);
    if ((record?.revision ?? null) !== input.expectedRevision) throw fail('revision_conflict', 'The labor cost changed after you opened it. Refresh and review the latest figure.', 409);
    const legacy = legacyJobLabor(job), before = record ? record.laborCents : legacy.state === 'value' ? legacy.cents : null;
    const jobWrite = laborOnJob(actor) ? { collection: 'jobs', id: job.id, revision: job.revision, patch: { costs: { labor: jobLaborDollars(input.laborCents) } }, mask: ['costs.labor'] }
      : legacy.fields.length ? { collection: 'jobs', id: job.id, revision: job.revision, patch: {}, remove: legacy.fields } : null;
    const audit = auditWrite({ actor: { id: actor.user, kind: 'human', role: actor.role }, via: 'hub', action: 'money.labor.save', entity: { collection: 'jobs', id: job.id },
      before: { laborCents: before ?? null }, after: { laborCents: input.laborCents }, requestId: input.requestId, visibility: 'owner', now });
    await store.commit([
      { collection: JOB_LABOR_COSTS, id: job.id, ...(record ? { revision: record.revision } : {}), patch: laborRecordPatch(job.id, input.laborCents, { recordedAt: now, recordedBy: actor.user, source: 'egc_hub', requestId: input.requestId }) },
      ...(jobWrite ? [jobWrite] : []),
      { collection: JOB_LABOR_RECEIPTS, id: receiptId, patch: { fingerprint, actorId: actor.user, jobId: job.id, requestId: input.requestId, auditId: audit.id, createdAt: now } },
      audit,
    ]);
    const saved = await store.read(JOB_LABOR_COSTS, job.id);
    if (!saved) throw fail('outcome_unknown', 'The saved labor cost could not be read back. Retry the same request.', 503);
    if (saved.requestId !== input.requestId) throw fail('changed_since_operation', 'The labor cost saved, but it has changed again. Refresh to review it.', 409);
    return result(saved, false);
  }
  const prior = await replay(true);
  if (prior) return prior;
  try { return await execute(); }
  catch (error) {
    if (FINAL.has(error.code)) throw error;
    // A lost commit response (or a racing copy of this request) may have saved: the receipt is the proof.
    const recovered = await replay(false).catch(replayError => { if (FINAL.has(replayError.code)) throw replayError; return null; });
    if (recovered) return recovered;
    // Storage speaks money_* (moneyStorage); callers get this endpoint's codes.
    if (error.code === 'money_revision_conflict') throw fail('revision_conflict', 'The job or its labor cost changed while saving. Nothing was saved. Refresh and retry.', 409);
    if (/^money_/.test(error.code || '')) throw fail('outcome_unknown', 'The labor cost save could not be verified. Retry the same request to safely check it.', 503);
    throw error;
  }
}
