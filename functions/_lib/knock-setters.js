// Appointment-setting attribution is a separate ledger from direct door sales.
// Reads canonical close/payment evidence; never creates an appointment or payout.
import { knockFailure, write } from './knock-store.js';
import { dispatchStorage } from './dispatch-storage.js';
import { customerMoneyTotals, paymentLedger } from './money-core.js';
import { walkthroughStatus } from './walkthrough-state.js';
import { commissionAllocations } from './knock-allocations.js';
import { CHANNEL_PERCENTS } from '../../crew/knock-money.js';

const ID = /^[A-Za-z0-9_-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = ['type', 'status', 'pipelineStatus', 'convertedJobId', 'sourceWalkthroughId', 'walkthroughOutcome',
  'walkthroughCompletedAt', 'scheduleOccurrence', 'date', 'time', 'estimate', 'customerApproval',
  'acceptance.recordedBy', 'acceptance.acceptedAt', 'total', 'priceQuoted', 'lockedTotal', 'rate',
  'payment', 'deposit', 'invoice', 'refunds', 'changeOrders', 'giftWallet'];

// Owner decision 2026-10-17: a D2D-set walkthrough pays 13% to the setter plus 7% to the
// estimator, 20% total of the full garage job including goods (was 12% + 7%).
export const setterPolicy = Object.freeze({ channel: 'appointment_setter', rate: CHANNEL_PERCENTS.setter / 100, estimatorRate: CHANNEL_PERCENTS.estimator / 100,
  totalRate: (CHANNEL_PERCENTS.setter + CHANNEL_PERCENTS.estimator) / 100,
  earningTrigger: 'closed_and_collected', payoutCadence: 'biweekly',
  approval: 'unconfigured', gaps: ['recipient_verification', 'calculation_base', 'payroll_cycle_anchor', 'partial_collections', 'refund_clawbacks'] });

export function setterJobReader(env) {
  const store = dispatchStorage(env);
  return async id => (await store.readMany('jobs', [id], FIELDS))[0] || null;
}

const same = (a, b) => ['walkthroughId', 'setterKey', 'serviceClassification', 'classificationReference', 'estimatorKey', 'estimatorReference'].every(key => a?.[key] === b?.[key]);
const conflict = () => knockFailure('This walkthrough or request already has different setter attribution. Finance must review it; nothing was reassigned.', 409, 'knock_setter_conflict');

export async function recordSetterAttribution(store, admin, body, nowIso, env, { readJob = setterJobReader(env) } = {}) {
  const { requestId, walkthroughId, setterKey } = body;
  if (!UUID.test(String(requestId || '')) || !ID.test(String(walkthroughId || ''))) throw knockFailure('Choose a valid walkthrough and request id.', 400, 'knock_setter_invalid');
  const rep = await store.get('knock_reps', String(setterKey || ''));
  if (!rep || rep.status !== 'active') throw knockFailure('Choose an active canvassing rep as setter.', 400, 'knock_setter_rep');
  const serviceClassification = body.serviceClassification || 'unverified';
  const classificationReference = String(body.classificationReference || '').trim();
  if (!['garage', 'junk_removal', 'unverified'].includes(serviceClassification) || classificationReference.length > 120 ||
    (serviceClassification !== 'unverified' && !classificationReference)) throw knockFailure('A verified service classification needs its review reference.', 400, 'knock_setter_scope');
  const estimatorKey = String(body.estimatorKey || '').trim(), estimatorReference = String(body.estimatorReference || '').trim();
  if (estimatorKey && (!/^[a-z0-9._-]{1,64}$/i.test(estimatorKey) || !estimatorReference) || estimatorReference.length > 120) throw knockFailure('An estimator attribution needs a valid staff key and its review reference.', 400, 'knock_setter_estimator');
  const payload = { walkthroughId, setterKey, serviceClassification, classificationReference, estimatorKey, estimatorReference };
  const receiptId = `setter_${requestId}`;
  const priorReceipt = await store.get('knock_receipts', receiptId);
  if (priorReceipt) {
    if (!same(priorReceipt, payload)) throw conflict();
    return { duplicate: true, attribution: await store.get('knock_setters', walkthroughId) };
  }
  const visit = await readJob(walkthroughId);
  if (!visit || visit.id !== walkthroughId || visit.type !== 'walkthrough' || !visit.revision) throw knockFailure('The canonical walkthrough could not be verified.', 409, 'knock_setter_walkthrough');
  const existing = await store.get('knock_setters', walkthroughId);
  if (existing && !same(existing, payload)) throw conflict();
  const row = { ...payload, channel: 'appointment_setter', requestId, recordedBy: admin.user, recordedAt: nowIso, sourceRevision: visit.revision };
  try {
    await store.commit([write.create('knock_receipts', receiptId, payload), ...(!existing ? [write.create('knock_setters', walkthroughId, row)] : [])]);
  } catch (error) {
    const [receipt, saved] = await Promise.all([store.get('knock_receipts', receiptId), store.get('knock_setters', walkthroughId)]);
    if (receipt) { if (!same(receipt, payload)) throw conflict(); return { duplicate: true, attribution: saved }; }
    if (!saved) throw error;
    if (!same(saved, payload)) throw conflict();
    // Another equivalent request won the walkthrough's create-only claim.
    try { await store.commit([write.create('knock_receipts', receiptId, payload)]); }
    catch (retryError) { const replay = await store.get('knock_receipts', receiptId); if (!replay) throw retryError; if (!same(replay, payload)) throw conflict(); }
    return { duplicate: true, attribution: saved };
  }
  return { duplicate: Boolean(existing), attribution: { id: walkthroughId, ...(existing || row) } };
}

export function projectSetterAttribution(record, visit, job, directSales = [], nowMs = Date.now()) {
  const result = { id: record.id || record.walkthroughId, walkthroughId: record.walkthroughId, channel: 'appointment_setter',
    setterKey: record.setterKey, estimatorKey: record.estimatorKey || null, estimatorEvidence: record.estimatorKey ? 'admin_recorded_unreconciled' : 'unverified',
    closingActorKey: null, directSaleRepKey: null, serviceClassification: record.serviceClassification,
    state: 'awaiting_close', rate: setterPolicy.rate, earnedCommission: null, payableCommission: null,
    customerCollectedRevenue: null, qualifyingAt: null, allocations: [], reviewReasons: [], settlement: 'not_reconciled' };
  if (record.serviceClassification === 'junk_removal') return { ...result, state: 'excluded', earnedCommission: 0, payableCommission: 0 };
  if (!visit || visit.id !== record.walkthroughId || visit.type !== 'walkthrough' || !visit.revision) return { ...result, state: 'review_required', reviewReasons: ['walkthrough_unverified'] };
  const status = walkthroughStatus(visit);
  if (!visit.convertedJobId) return { ...result, state: ['no_show', 'cancelled', 'lost'].includes(status.state) ? status.state : 'awaiting_close', earnedCommission: 0, payableCommission: 0 };
  if (!job || job.type !== 'job' || job.id !== visit.convertedJobId || job.sourceWalkthroughId !== visit.id || !job.revision) return { ...result, state: 'review_required', reviewReasons: ['conversion_link_unverified'] };
  result.jobId = job.id;
  result.closingActorKey = typeof job.acceptance?.recordedBy === 'string' ? job.acceptance.recordedBy : null;
  const direct = directSales.find(sale => sale.handoff?.job?.ref === job.id);
  result.directSaleRepKey = direct?.repKey || null;
  if (direct) result.reviewReasons.push('direct_close_attribution_conflict');
  if (record.serviceClassification !== 'garage') result.reviewReasons.push('service_scope_unverified');
  if (['cancelled', 'canceled', 'no_show'].includes(job.pipelineStatus || job.status)) result.reviewReasons.push('cancellation_review');
  const closedAt = job.estimate?.acceptedAt || job.customerApproval?.approvedAt;
  if (!['accepted', 'approved'].includes(job.estimate?.status) || !Number.isFinite(Date.parse(closedAt))) return { ...result, state: 'awaiting_close' };
  const totals = customerMoneyTotals(job, { unified: true }), ledger = paymentLedger(job);
  if (!totals.complete || !ledger.complete || ledger.entries.some(entry => entry.verified !== true)) result.reviewReasons.push('collection_unverified');
  if (totals.complete && ledger.complete) result.customerCollectedRevenue = totals.appliedCents / 100;
  if (result.reviewReasons.length) return { ...result, state: 'review_required' };
  if (!(totals.totalCents > 0) || totals.appliedCents !== totals.totalCents) return { ...result, state: totals.appliedCents > 0 ? 'review_required' : 'awaiting_collection', reviewReasons: totals.appliedCents > 0 ? ['partial_collection_policy_unconfigured'] : [] };
  const times = ledger.entries.filter(entry => entry.kind !== 'tip').map(entry => Date.parse(entry.at));
  if (!times.length || times.some(time => !Number.isFinite(time))) return { ...result, state: 'review_required', reviewReasons: ['collection_time_unverified'] };
  const qualifyingAt = Math.max(Date.parse(closedAt), ...times);
  if (qualifyingAt > nowMs) return { ...result, state: 'review_required', reviewReasons: ['event_time_unverified'] };
  const allocation = commissionAllocations({ channel: 'appointment_setter', jobId: job.id, serviceClassification: record.serviceClassification,
    setterKey: record.setterKey, estimatorKey: record.estimatorKey || '', directRepKey: result.directSaleRepKey || '' });
  return { ...result, state: 'review_required', qualifyingAt: new Date(qualifyingAt).toISOString(), allocations: allocation.allocations,
    reviewReasons: [...allocation.reviewReasons, 'payroll_anchor_unconfigured'] };
}

export async function setterAttributions(store, env, { repKey = null, nowMs = Date.now(), readJob = setterJobReader(env) } = {}) {
  const rows = repKey ? await store.query('knock_setters', { where: [['setterKey', '==', repKey]] }) : await store.list('knock_setters');
  if (!rows.length) return { rows: [], truncated: false, policy: setterPolicy };
  const directSales = await store.list('knock_sales');
  const projected = await Promise.all(rows.slice(0, 100).map(async row => {
    try {
      const visit = await readJob(row.walkthroughId);
      const job = ID.test(String(visit?.convertedJobId || '')) ? await readJob(visit.convertedJobId) : null;
      return projectSetterAttribution(row, visit, job, directSales, nowMs);
    } catch { return { id: row.id, walkthroughId: row.walkthroughId, setterKey: row.setterKey, channel: 'appointment_setter', rate: setterPolicy.rate,
      state: 'review_required', earnedCommission: null, payableCommission: null, reviewReasons: ['source_unavailable'] }; }
  }));
  return { rows: projected, truncated: rows.length > 100, policy: setterPolicy };
}
