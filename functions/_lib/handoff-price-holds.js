import { firestoreFetch } from './firebase-service-account.js';
import { dispatchStorage } from './dispatch-storage.js';

/** EGC_QUOTE_BUILDER_ENABLED: the signed jobs held for the owner's price approval (walkthrough-handoff.js
 * pricesPendingApproval {status:'pending'}), for releaseHeldHandoffs after the owner approves menu prices or saves the
 * pricing settings. One bounded equality query on the map subfield pricesPendingApproval.status (Firestore's automatic
 * single-field index; no composite index), reading document names only; the release reads each job it checks. Never
 * on a hot path: it runs only after an owner's catalog save, and when an owner or manager opens Catalog & pricing or the
 * Hub home (POST /api/held-jobs: the count, or the release once per pricing-menu version). */
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const JOB_ID = /^[A-Za-z0-9_-]{1,180}$/;
export const HELD_QUERY_MAX = 100;
const unavailable = () => Object.assign(new Error('The held jobs could not be listed. They stay held; save the approval again or release them from the job.'), { code: 'handoff_held_jobs_unavailable', status: 503 });

/** The runQuery body: at most `limit` held job names, after the job id `after` when one is given (the next page, in id
 * order; still the automatic single-field index). */
export function heldJobsQuery(limit, after = '') {
  return { structuredQuery: { from: [{ collectionId: 'jobs' }], select: { fields: [{ fieldPath: '__name__' }] },
    where: { fieldFilter: { field: { fieldPath: 'pricesPendingApproval.status' }, op: 'EQUAL', value: { stringValue: 'pending' } } },
    ...(after ? { orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], startAt: { values: [{ referenceValue: `${ROOT}/jobs/${after}` }], before: false } } : {}), limit } };
}

/** The ids of at most `limit` held jobs (1..HELD_QUERY_MAX) after the job id `after`. A failed or malformed answer throws. */
export async function heldJobIds(env, limit, fetcher = firestoreFetch, after = '') {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HELD_QUERY_MAX || typeof after !== 'string' || after && !JOB_ID.test(after)) throw unavailable();
  let results;
  try {
    const response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(heldJobsQuery(limit, after)), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw unavailable();
    results = await response.json();
  } catch { throw unavailable(); }
  if (!Array.isArray(results) || results.some(result => !result || typeof result !== 'object' || Array.isArray(result))) throw unavailable();
  const prefix = `${ROOT}/jobs/`;
  return results.filter(result => result.document !== undefined).map(result => {
    const name = result.document?.name, id = typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : '';
    if (!JOB_ID.test(id)) throw unavailable();
    return id;
  }).slice(0, limit);
}

/** How many jobs are held, by pages of HELD_QUERY_MAX names (at most maxPages): {count, more}. */
export async function countHeldJobs(store, { maxPages = 10 } = {}) {
  let count = 0, after = '';
  for (let pages = 0; pages < maxPages; pages++) {
    const ids = await store.heldJobIds(HELD_QUERY_MAX, after);
    count += ids.length;
    if (ids.length < HELD_QUERY_MAX) return { count, more: false };
    after = ids.at(-1);
  }
  return { count, more: true };
}

/** dispatchStorage(env) (job reads and revision-guarded commits) plus heldJobIds(limit, after). */
export function heldReleaseStorage(env, fetcher = firestoreFetch) {
  return { ...dispatchStorage(env, fetcher), heldJobIds: (limit, after = '') => heldJobIds(env, limit, fetcher, after) };
}
