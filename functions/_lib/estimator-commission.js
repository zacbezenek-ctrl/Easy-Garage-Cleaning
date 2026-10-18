/* ESTIMATOR-COMMISSION (owner decision D6b, 2026-10-17): the estimator's 7%, as a projection, an office view
   (Knock Admin > Estimators, GET /api/knock-admin?view=estimators), the estimator's own read-only view (Hub > My
   commission, GET /api/estimator-commission) and, once the owner approved the setter terms (knock-admin.js
   approveSetterTerms, crew/knock-money.js SETTER_TERMS), the earned shares in the commission statement (periodStatement
   channels, Admin > Money and its CSV).
   Each signed walkthrough job pays its estimator once, never stacked:
     - a walkthrough a door-to-door rep set (knock_setters) pays through its setter record: 13% to the rep, 7% to the
       estimator the record names (the bridge's or the office's), else the handoff's signer (knock-setters.js);
     - any other signed walkthrough (walkthroughHandoffs, walkthrough-handoff.js) is the estimator's direct sale: 7% to
       the employee who recorded the customer's signature (acceptance.recordedBy).
   Both use the same evidence (knock-setters.js collectionEvidence): the job closed (accepted estimate) and paid in full
   with verified receipts, on its whole price including goods, rounded to the cent. Before the owner's approval every
   row says so (commission_terms_unapproved, or the setter record's own holds) and shows no amount. Reads are bounded:
   one estimator's signed receipts (actorId) or those signed in the last ESTIMATOR_LOOKBACK_DAYS, their jobs (masked,
   in batches) and the setter records. Never a customer contact detail or another person's pay to an estimator. */
import { CHANNEL_PERCENTS } from '../../crew/knock-money.js';
import { addDays } from '../../crew/knock-time.js';
import { commissionAllocations } from './knock-allocations.js';
import { SETTER_JOB_FIELDS, approvedBase, centsToDollars, collectionEvidence, earnedTime, handoffSigner, qualifyingCollection, setterAttributions, setterBatchReaderFor, signedGarageHandoff } from './knock-setters.js';

export const ESTIMATOR_LOOKBACK_DAYS = 365;
// Setter records a statement or the office view projects (each reads its walkthrough and job); more holds the statement.
export const ESTIMATOR_SETTER_LIMIT = 500;
const ID = /^[A-Za-z0-9_-]{1,120}$/, BATCH = 100;
const RATE = CHANNEL_PERCENTS.estimator / 100;

/** A walkthrough the estimator sold directly (no setter record), as money: the 7% direct-estimator channel. */
export function projectEstimatorJob(job, { terms = null, nowMs = Date.now() } = {}) {
  const approved = terms?.verified === true, estimatorKey = handoffSigner(job);
  const result = { id: `${job?.id}:direct_estimator`, jobId: job?.id || null, walkthroughId: job?.sourceWalkthroughId || null, jobDate: typeof job?.date === 'string' ? job.date : null,
    channel: 'direct_estimator', estimatorKey: estimatorKey || null, estimatorEvidence: estimatorKey ? 'handoff_signer' : 'unverified', state: 'awaiting_close', rate: RATE,
    customerCollectedRevenue: null, qualifyingAt: null, earnedAt: null, projectedCommission: null, earnedCommission: null, payableCommission: null, reviewReasons: [], settlement: 'not_reconciled' };
  if (!job || job.type !== 'job' || !job.revision || !ID.test(String(job.sourceWalkthroughId || ''))) return { ...result, state: 'review_required', reviewReasons: ['conversion_link_unverified'] };
  const classification = signedGarageHandoff(job) ? 'garage' : 'unverified';
  if (classification !== 'garage') result.reviewReasons.push('service_scope_unverified');
  if (['cancelled', 'canceled', 'no_show'].includes(job.pipelineStatus || job.status)) result.reviewReasons.push('cancellation_review');
  const evidence = collectionEvidence(job);
  if (!evidence) return { ...result, state: 'awaiting_close' };
  const allocation = commissionAllocations({ channel: 'direct_estimator', jobId: job.id, serviceClassification: classification, estimatorKey, ...approvedBase(terms, evidence) });
  if (approved) result.projectedCommission = centsToDollars(allocation.allocations[0]?.amountCents);
  if (!evidence.verified) result.reviewReasons.push('collection_unverified');
  if (evidence.collected !== null) result.customerCollectedRevenue = evidence.collected;
  if (result.reviewReasons.length) return { ...result, state: 'review_required' };
  const qualified = qualifyingCollection(evidence, nowMs);
  if (qualified.state !== 'qualified') return { ...result, state: qualified.state, reviewReasons: qualified.reviewReasons };
  const qualifyingAt = new Date(qualified.at).toISOString();
  if (!approved) return { ...result, state: 'review_required', qualifyingAt, reviewReasons: ['commission_terms_unapproved'] };
  if (allocation.state !== 'calculated') return { ...result, state: 'review_required', qualifyingAt, reviewReasons: allocation.reviewReasons };
  const earned = centsToDollars(allocation.allocations[0].amountCents);
  return { ...result, state: 'earned', qualifyingAt, earnedAt: earnedTime(qualified.at, terms), earnedCommission: earned, payableCommission: earned };
}

/** The estimator's row of a projected setter record (knock-setters.js projectSetterAttribution): its 7% allocation only,
 * never the setter's share. */
export function estimatorShare(row) {
  const share = (Array.isArray(row?.allocations) ? row.allocations : []).find(item => item?.role === 'estimator');
  const amount = centsToDollars(share?.amountCents);
  return { id: share?.id || `${row.walkthroughId}:appointment_setter:estimator`, jobId: row.jobId || null, walkthroughId: row.walkthroughId, jobDate: row.jobDate ?? null,
    channel: 'appointment_setter', estimatorKey: row.estimatorKey || null, estimatorEvidence: row.estimatorEvidence || 'unverified', setterKey: row.setterKey || null,
    state: row.state, rate: RATE, customerCollectedRevenue: row.customerCollectedRevenue ?? null, qualifyingAt: row.qualifyingAt ?? null, earnedAt: row.earnedAt ?? null,
    projectedCommission: amount, earnedCommission: row.state === 'earned' ? amount : row.earnedCommission === 0 ? 0 : null,
    payableCommission: row.state === 'earned' ? amount : row.payableCommission === 0 ? 0 : null, reviewReasons: row.reviewReasons || [], settlement: 'not_reconciled' };
}

// The signed walkthrough jobs behind the receipts a ledger query returns (each job once; masked, in batches).
async function signedJobs(dispatch, spec, signer) {
  const receipts = (await dispatch.handoffLedger(spec)).filter(row => row.kind === undefined && ID.test(String(row.jobId || '')) && ID.test(String(row.sourceWalkthroughId || '')));
  const ids = [...new Set(receipts.map(row => row.jobId))], jobs = [];
  for (let at = 0; at < ids.length; at += BATCH) jobs.push(...await dispatch.readMany('jobs', ids.slice(at, at + BATCH), [...SETTER_JOB_FIELDS]));
  return jobs.filter(job => job.type === 'job' && ID.test(String(job.sourceWalkthroughId || '')) && (!signer || handoffSigner(job) === signer));
}

/** The estimator 7% rows: one estimator's (estimatorKey, the staff key, and actorId, the Hub sign-in their receipts carry)
 * or every estimator's (since: receipts created on or after that date). Answers {rows, setters, truncated}: rows are
 * estimator rows, setters the projected setter records they came from (the office and statements use both shares). */
export async function estimatorLedger({ kstore, dispatch, env = {}, estimatorKey = null, actorId = null, since = null, terms = null, nowMs = Date.now(), readJob = null, setterLimit = ESTIMATOR_SETTER_LIMIT } = {}) {
  const signer = estimatorKey ? String(estimatorKey).trim().toLowerCase() : '';
  const jobs = await signedJobs(dispatch, signer ? { field: 'actorId', op: 'EQUAL', value: String(actorId || estimatorKey) } : { field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: String(since || '') }, signer);
  let records;
  if (signer) {
    const walkthroughs = [...new Set(jobs.map(job => job.sourceWalkthroughId))];
    const [mine, linked] = await Promise.all([kstore.query('knock_setters', { where: [['estimatorKey', '==', signer]] }), walkthroughs.length ? kstore.getMany('knock_setters', walkthroughs) : new Map()]);
    records = [...new Map([...mine, ...linked.values()].map(row => [row.id, row])).values()];
  } else records = await kstore.list('knock_setters');
  const setters = await setterAttributions(kstore, env, { rows: records, terms, nowMs, limit: setterLimit, ...(readJob ? { readJob } : { readJobs: setterBatchReaderFor(dispatch) }) });
  const viaSetter = new Set(records.map(row => row.walkthroughId));
  const shares = setters.rows.map(estimatorShare).filter(row => !signer || row.estimatorKey === signer);
  const direct = jobs.filter(job => !viaSetter.has(job.sourceWalkthroughId)).map(job => projectEstimatorJob(job, { terms, nowMs }));
  return { rows: [...shares, ...direct], setters, truncated: setters.truncated };
}

/** The earned setter and estimator shares a commission statement adds (periodStatement channels), once the owner
 * approved the setter terms; null before. review holds the whole statement when the setter records were not all read
 * (more than ESTIMATOR_SETTER_LIMIT, or a walkthrough or job that could not be read), since a missing share is unknown. */
export async function channelEarnings({ kstore, dispatch, env = {}, terms, nowMs = Date.now(), period, readJob = null }) {
  if (terms?.verified !== true) return null;
  const ledger = await estimatorLedger({ kstore, dispatch, env, since: addDays(period.start, -ESTIMATOR_LOOKBACK_DAYS), terms, nowMs, readJob });
  const items = [];
  for (const row of ledger.setters.rows) if (row.state === 'earned') for (const share of row.allocations) items.push({ id: share.id, repKey: share.repKey, role: share.role, amount: share.amountCents / 100, earnedAt: Date.parse(row.earnedAt) });
  for (const row of ledger.rows) if (row.channel === 'direct_estimator' && row.state === 'earned') items.push({ id: row.id, repKey: row.estimatorKey, role: 'estimator', amount: row.earnedCommission, earnedAt: Date.parse(row.earnedAt) });
  const unread = ledger.setters.rows.some(row => (row.reviewReasons || []).includes('source_unavailable'));
  return { items, review: [...(ledger.truncated ? ['setter_records_truncated'] : []), ...(unread ? ['setter_source_unavailable'] : [])] };
}

/** One estimator's own read-only view (GET /api/estimator-commission): their 7% rows, newest job first, with no setter,
 * customer or other employee named; totals of what is projected (closed, not yet earned) and earned. */
export function estimatorView(ledger, terms) {
  const rows = ledger.rows.map(row => ({ id: row.id, jobId: row.jobId, jobDate: row.jobDate, channel: row.channel === 'direct_estimator' ? 'direct' : 'door_to_door',
    state: row.state, rate: row.rate, projectedCommission: row.projectedCommission, earnedCommission: row.earnedCommission, earnedAt: row.earnedAt, reviewReasons: row.reviewReasons }))
    .sort((a, b) => String(b.jobDate || '').localeCompare(String(a.jobDate || '')) || String(a.id).localeCompare(String(b.id)));
  const sum = values => Math.round(values.reduce((total, value) => total + value * 100, 0)) / 100;
  return { terms: { verified: terms?.verified === true, approvedAt: terms?.approvedAt || null, percent: CHANNEL_PERCENTS.estimator },
    rows, totals: { projected: sum(rows.filter(row => row.state !== 'earned' && Number.isFinite(row.projectedCommission)).map(row => row.projectedCommission)),
      earned: sum(rows.filter(row => row.state === 'earned').map(row => row.earnedCommission)) }, truncated: ledger.truncated };
}
