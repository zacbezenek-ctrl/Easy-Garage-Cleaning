/** Estimator accuracy (owner, 2026-10-21: "shows estimated man hours vs total man hours on a given job, so we can praise
 * estimators for higher accuracy of guessing"). Built on job actuals (job-actuals.js): no new reads, hours only.
 *
 * Per completed job: the man-hours the estimate sold (job actuals' billed hours: the Labor line, D12) against the actual
 * man-hours on site (job actuals' best signal: timecards, else the crew lead's people × hours at Complete). The error is
 * (actual − estimated) / estimated: positive means the job took longer than estimated (under-estimated).
 *
 * The estimator is whoever priced the job, from what the job record itself says (never a guess):
 *   1. 'walkthrough_signer': the employee who recorded the customer's signature on the walkthrough
 *      (acceptance.recordedBy with method 'in_person_signature', walkthrough-handoff.js). They built that quote on site.
 *   2. 'quote_sender': the employee who sent the priced quote (quoteDraft.sentBy, quote-draft.js) when it was not signed
 *      on a walkthrough.
 *   Neither: the job is listed but not scored ('no_estimator').
 * A job is scored only when both hours are firm. Excluded, with the reason shown: junk-only (sold by the truck, no labor
 * estimate), no Labor line (a legacy quote), actual hours not recorded, timecards incomplete or unreadable (the actual
 * may be short), or no estimator on record.
 *
 * Per estimator, over the last 30 and 90 days: jobs scored, average absolute error (lower is more accurate), bias (the
 * average signed error: + under-estimates, − over-estimates) and the share of jobs within ±10% and ±20%. Ranking needs
 * ESTIMATOR_MIN_JOBS scored jobs, so one lucky job never wins; the most accurate ranked estimator of the last 30 days is
 * the callout. Percents are tenths, rounded half up in integers (milli-hours), like the rest of job actuals. */
import { divRoundHalfUp, milliHours } from './job-actuals.js';

export const ESTIMATOR_MIN_JOBS = 3;
export const ACCURACY_BANDS = Object.freeze([10, 20]);
export const ESTIMATOR_FIELDS = Object.freeze(['acceptance.recordedBy', 'acceptance.method', 'quoteDraft.sentBy']);
// The staff key the commission ledger uses for the same signer (knock-setters.js handoffSigner).
const STAFF_KEY = /^[a-z0-9._-]{1,64}$/;
const key = value => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STAFF_KEY.test(text) ? text : '';
};

/** {key, evidence} for the employee who priced the job, or null. */
export function estimatorOf(job) {
  const signer = job?.acceptance?.method === 'in_person_signature' ? key(job.acceptance.recordedBy) : '';
  if (signer) return { key: signer, evidence: 'walkthrough_signer' };
  const sender = key(job?.quoteDraft?.sentBy);
  return sender ? { key: sender, evidence: 'quote_sender' } : null;
}

const EXCLUDING_REASONS = ['timecards_incomplete', 'timecards_unavailable'];
/** Why a job actuals row is not scored, or '' when it is. */
export function exclusionOf(row, estimator) {
  if (row.billed.source === 'junk_only') return 'junk_only';
  if (row.billed.manHours === null) return 'no_labor_estimate';
  if (row.actual.manHours === null) return 'actual_not_recorded';
  const flagged = EXCLUDING_REASONS.find(reason => row.reasons.includes(reason));
  if (flagged) return flagged;
  return estimator ? '' : 'no_estimator';
}

/** The error in tenths of a percent, (actual − estimated) / estimated, half up; null without both. */
export function errorTenths(estimatedMilli, actualMilli) {
  return Number.isSafeInteger(estimatedMilli) && estimatedMilli > 0 && Number.isSafeInteger(actualMilli) ? divRoundHalfUp((actualMilli - estimatedMilli) * 1000, estimatedMilli) : null;
}

/** One job: estimated vs actual man-hours with its estimator and, when not scored, why. */
export function accuracyRow(row, job) {
  const estimator = estimatorOf(job), excluded = exclusionOf(row, estimator);
  const estimatedMilli = row.billed.manHours === null ? null : milliHours(row.billed.manHours);
  const actualMilli = row.actual.manHours === null ? null : milliHours(row.actual.manHours);
  const tenths = estimatedMilli !== null && actualMilli !== null ? errorTenths(estimatedMilli, actualMilli) : null;
  return {
    jobId: row.jobId, date: row.date, customer: row.customer, serviceType: row.serviceType,
    estimator: estimator?.key || null, estimatorEvidence: estimator?.evidence || null,
    estimatedManHours: row.billed.manHours, actualManHours: row.actual.manHours, actualSource: row.actual.source,
    differenceManHours: estimatedMilli !== null && actualMilli !== null ? (actualMilli - estimatedMilli) / 1000 : null,
    differencePercent: tenths === null ? null : tenths / 10, scored: !excluded, excluded: excluded || null,
  };
}

const average = (values) => values.length ? divRoundHalfUp(values.reduce((sum, value) => sum + value, 0), values.length) / 10 : null;
const share = (count, total) => total ? divRoundHalfUp(count * 1000, total) / 10 : null;

/** The scorecard of scored rows: one entry per estimator, ranked ones first (lowest average error, then most jobs). */
export function estimatorScorecard(rows, { minJobs = ESTIMATOR_MIN_JOBS } = {}) {
  const groups = new Map();
  for (const row of rows) if (row.scored) (groups.get(row.estimator) || groups.set(row.estimator, []).get(row.estimator)).push(row);
  const estimators = [...groups].map(([estimator, list]) => {
    const tenths = list.map(row => Math.round(row.differencePercent * 10)), absolute = tenths.map(Math.abs);
    const estimatedMilli = list.reduce((sum, row) => sum + milliHours(row.estimatedManHours), 0), actualMilli = list.reduce((sum, row) => sum + milliHours(row.actualManHours), 0);
    return {
      estimator, jobs: list.length, ranked: list.length >= minJobs,
      averageErrorPercent: average(absolute), biasPercent: average(tenths),
      ...Object.fromEntries(ACCURACY_BANDS.map(band => [`within${band}Percent`, share(absolute.filter(value => value <= band * 10).length, list.length)])),
      estimatedManHours: estimatedMilli / 1000, actualManHours: actualMilli / 1000,
    };
  }).sort((a, b) => Number(b.ranked) - Number(a.ranked) || (a.ranked ? a.averageErrorPercent - b.averageErrorPercent : 0) || b.jobs - a.jobs || a.estimator.localeCompare(b.estimator));
  const top = estimators.find(entry => entry.ranked) || null;
  return { minJobs, estimators, top: top ? { estimator: top.estimator, averageErrorPercent: top.averageErrorPercent, jobs: top.jobs } : null };
}

/** The estimator accuracy block of the job actuals report: rows (every completed job, scored or not, newest first as the
 * report's rows), the 30- and 90-day scorecards and how many jobs each exclusion left out. */
export function buildEstimatorAccuracy({ rows = [], jobs = [], shortStart, minJobs = ESTIMATOR_MIN_JOBS }) {
  const byId = new Map(jobs.map(job => [job.id, job])), list = rows.map(row => accuracyRow(row, byId.get(row.jobId)));
  const excluded = {};
  for (const row of list) if (row.excluded) excluded[row.excluded] = (excluded[row.excluded] || 0) + 1;
  return {
    minJobs, bands: [...ACCURACY_BANDS], rows: list, excluded,
    last30: estimatorScorecard(list.filter(row => typeof row.date === 'string' && row.date >= shortStart), { minJobs }),
    last90: estimatorScorecard(list, { minJobs }),
  };
}
