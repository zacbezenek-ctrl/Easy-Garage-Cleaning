/* JOB-COST-PRIVACY: job labor dollars for the Hub finance board and cost dialog. They live in the server-only
 * jobLaborCosts record (/api/job-labor-costs), never on the job documents the Hub streams to every manager. The
 * server answers laborCostHidden:true, with no figures, to a manager who does not see labor dollars, and the board
 * then shows "Labor $ hidden". An account that is not an operations manager (a crew lead or sales account with
 * business access) is refused with 403 job_labor_forbidden whatever EGC_STAFF_PAY_OWNER_ONLY says, so the board shows
 * it "Labor $ hidden" too, with no Retry: retrying cannot change that answer. Until the server answers the board shows
 * no labor figure ("Labor $ loading"), and a failed load says so with a Retry, never a zero or a guess. The owner's
 * save carries a request ID kept for this viewer and job until the server settles it, so saving the same figure after
 * a lost response repeats the same request. */
(function () {
'use strict';
const PREFIX = 'egc.labor.pending.v1.', RETRY_STATUS = new Set([401, 403, 408, 429]), TIMEOUT = 30000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,180}$/;
const S = { status: 'idle', jobs: new Map(), request: null, generation: 0 };
const cents = value => Number.isSafeInteger(value) && value >= 0;
// A saved figure is whole cents, or null when the owner left labor blank (unknown).
const figure = value => value === null || cents(value);
const key = (viewer, jobId) => PREFIX + String(viewer || '').trim().toLowerCase() + '.' + jobId;
function send(url, init = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
  const run = typeof hubFetch === 'function' ? hubFetch : fetch;
  return run(url, { credentials: 'same-origin', cache: 'no-store', ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}
function recordOf(row) {
  if (!row || typeof row !== 'object' || typeof row.jobId !== 'string' || !SAFE_ID.test(row.jobId) || !figure(row.laborCents) || typeof row.revision !== 'string' || !row.revision) return null;
  return { jobId: row.jobId, laborCents: row.laborCents, revision: row.revision, recordedAt: typeof row.recordedAt === 'string' ? row.recordedAt : '', recordedBy: typeof row.recordedBy === 'string' ? row.recordedBy : '' };
}
/** 'idle' before the first load, then 'loading', 'hidden', 'visible' or 'unavailable'. */
const state = () => S.status;
const record = jobId => S.status === 'visible' ? S.jobs.get(jobId) || null : null;
/** Loads every job's labor figure (or the hidden answer). Resolves true when the state changed. */
function load({ force = false } = {}) {
  if (S.request && !force) return S.request;
  if (!force && S.status !== 'idle') return Promise.resolve(false);
  const generation = ++S.generation;
  S.status = 'loading';
  const request = (async () => {
    let status = 'unavailable', jobs = new Map();
    try {
      const response = await send('/api/job-labor-costs'), body = await response.json();
      if (response.status === 403 && body?.ok === false && body.code === 'job_labor_forbidden') status = 'hidden';
      else if (!response.ok || body?.ok !== true || typeof body.laborCostHidden !== 'boolean') throw new Error('unavailable');
      else if (body.laborCostHidden) { if (body.jobs !== null) throw new Error('unavailable'); status = 'hidden'; }
      else {
        if (body.complete !== true || !Array.isArray(body.jobs)) throw new Error('unavailable');
        for (const row of body.jobs) { const saved = recordOf(row); if (!saved || jobs.has(saved.jobId)) throw new Error('unavailable'); jobs.set(saved.jobId, saved); }
        status = 'visible';
      }
    } catch { status = 'unavailable'; jobs = new Map(); }
    if (generation !== S.generation) return false;
    S.status = status; S.jobs = jobs; S.request = null;
    return true;
  })();
  S.request = request;
  return request;
}
function pending(viewer, jobId) { try { return JSON.parse(sessionStorage.getItem(key(viewer, jobId)) || 'null'); } catch { return null; } }
function keep(viewer, jobId, body) { try { sessionStorage.setItem(key(viewer, jobId), JSON.stringify(body)); } catch {} }
function drop(viewer, jobId) { try { sessionStorage.removeItem(key(viewer, jobId)); } catch {} }
/**
 * Saves the owner's labor figure for one job: whole cents, or null to leave it unknown. Resolves the saved record;
 * rejects with an Error whose message is for the person. A lost response, a timeout, 5xx, 401, 403, 408 or 429 keep
 * the request, so saving the same figure again repeats it unchanged; any other refusal discards it, and a revision
 * conflict reloads the figures first.
 */
async function save({ jobId, laborCents, viewer }) {
  if (S.status !== 'visible') throw new Error('Labor cost has not loaded. Retry labor cost before saving it.');
  if (!SAFE_ID.test(String(jobId || '')) || !figure(laborCents)) throw new Error('Enter labor cost as a dollar amount, or leave it blank if unknown.');
  const saved = pending(viewer, jobId), current = S.jobs.get(jobId) || null;
  const body = saved && saved.laborCents === laborCents && saved.jobId === jobId ? saved : { requestId: crypto.randomUUID(), jobId, laborCents, expectedRevision: current ? current.revision : null, actorId: String(viewer || '') };
  keep(viewer, jobId, body);
  let response, result;
  try { response = await send('/api/job-labor-costs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); result = await response.json().catch(() => null); }
  catch { throw new Error('Labor cost may not have saved. Save the same figure again to check it; nothing else was changed.'); }
  if (response.ok && result?.ok === true) {
    const next = recordOf(result.labor);
    if (!next || next.jobId !== jobId || next.laborCents !== laborCents) throw new Error('Labor cost could not be verified. Save the same figure again to check it.');
    drop(viewer, jobId); S.jobs.set(jobId, next);
    return next;
  }
  if (response.status >= 500 || RETRY_STATUS.has(response.status)) throw new Error((result?.error || 'Labor cost could not be verified.') + ' Save the same figure again to retry it.');
  drop(viewer, jobId);
  if (result?.code === 'job_labor_revision_conflict' || result?.code === 'job_labor_changed_since_operation') { await load({ force: true }); throw new Error('Labor cost changed since you opened it. The latest figure is loaded; review it and save again.'); }
  throw new Error(result?.error || 'Labor cost was not saved.');
}
function reset() {
  S.generation++; S.status = 'idle'; S.jobs = new Map(); S.request = null;
  try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const name = sessionStorage.key(i); if (String(name || '').startsWith(PREFIX)) sessionStorage.removeItem(name); } } catch {}
}
window.addEventListener('egc:signout', reset);
window.EGCLaborCosts = { state, record, load, save, reset, ensure: onChange => { if (S.status === 'idle') load().then(changed => { if (changed) onChange(); }); } };
})();
