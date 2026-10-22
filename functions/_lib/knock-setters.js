// Appointment-setting attribution is a separate ledger from direct door sales.
// Reads canonical close/payment evidence; never creates an appointment or payout.
import { knockFailure, write } from './knock-store.js';
import { dispatchStorage } from './dispatch-storage.js';
import { customerMoneyTotals, paymentLedger, refundsRecorded } from './money-core.js';
import { walkthroughStatus } from './walkthrough-state.js';
import { commissionAllocations } from './knock-allocations.js';
import { builderLaborLine, included } from './quote-model.js';
import { isOwner, repKeyFor } from './knock-access.js';
import { CHANNEL_PERCENTS } from '../../crew/knock-money.js';

const ID = /^[A-Za-z0-9_-]{1,120}$/, STAFF_KEY = /^[a-z0-9._-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SETTER_JOB_FIELDS = Object.freeze(['type', 'status', 'pipelineStatus', 'convertedJobId', 'sourceWalkthroughId', 'walkthroughOutcome',
  'walkthroughCompletedAt', 'scheduleOccurrence', 'date', 'time', 'estimate', 'customerApproval',
  'acceptance.recordedBy', 'acceptance.acceptedAt', 'total', 'priceQuoted', 'lockedTotal', 'rate',
  'payment', 'deposit', 'invoice', 'refunds', 'changeOrders', 'giftWallet',
  // The approved setter terms read the signed handoff's evidence (signedGarageHandoff: its lines, else its finish scope)
  // and when a cancelled job was cancelled (adjustmentHold).
  'handoffVersion', 'handoffRequestId', 'serviceType', 'scope.finish', 'cancelledAt']);
const FIELDS = SETTER_JOB_FIELDS;

// Owner decision 2026-10-17: a D2D-set walkthrough pays 13% to the setter plus 7% to the
// estimator, 20% total of the full garage job including goods (was 12% + 7%).
export const setterPolicy = Object.freeze({ channel: 'appointment_setter', rate: CHANNEL_PERCENTS.setter / 100, estimatorRate: CHANNEL_PERCENTS.estimator / 100,
  totalRate: (CHANNEL_PERCENTS.setter + CHANNEL_PERCENTS.estimator) / 100,
  earningTrigger: 'closed_and_collected', payoutCadence: 'biweekly',
  approval: 'unconfigured', gaps: ['recipient_verification', 'calculation_base', 'payroll_cycle_anchor', 'partial_collections', 'refund_clawbacks'] });

// Walkthroughs and jobs by id, masked to what the setter and estimator projections read, from a dispatch store, a batch
// of up to 100 per request (one or two requests for a page of setter records, not two per record): Map id -> row.
export const setterBatchReaderFor = store => async ids => {
  const unique = [...new Set(ids.filter(id => ID.test(String(id || ''))))], rows = [];
  for (let at = 0; at < unique.length; at += 100) rows.push(...await store.readMany('jobs', unique.slice(at, at + 100), [...FIELDS]));
  return new Map(rows.map(row => [row.id, row]));
};

export function setterJobReader(env) {
  const store = dispatchStorage(env);
  return async id => (await store.readMany('jobs', [id], FIELDS))[0] || null;
}

const same = (a, b) => ['walkthroughId', 'setterKey', 'serviceClassification', 'classificationReference', 'estimatorKey', 'estimatorReference'].every(key => a?.[key] === b?.[key]);
const conflict = () => knockFailure('This walkthrough or request already has different setter attribution. Finance must review it; nothing was reassigned.', 409, 'knock_setter_conflict');

export async function recordSetterAttribution(store, admin, body, nowIso, env, { dispatch = dispatchStorage, readJob = async id => (await dispatch(env).readMany('jobs', [id], FIELDS))[0] || null } = {}) {
  const { requestId, walkthroughId, setterKey } = body;
  if (!UUID.test(String(requestId || '')) || !ID.test(String(walkthroughId || ''))) throw knockFailure('Choose a valid walkthrough and request id.', 400, 'knock_setter_invalid');
  const rep = await store.get('knock_reps', String(setterKey || ''));
  if (!rep || rep.status !== 'active') throw knockFailure('Choose an active canvassing rep as setter.', 400, 'knock_setter_rep');
  const serviceClassification = body.serviceClassification || 'unverified';
  const classificationReference = String(body.classificationReference || '').trim();
  if (!['garage', 'junk_removal', 'unverified'].includes(serviceClassification) || classificationReference.length > 120 ||
    (serviceClassification !== 'unverified' && !classificationReference)) throw knockFailure('A verified service classification needs its review reference.', 400, 'knock_setter_scope');
  // Staff keys are lowercase everywhere they are paid or read (payout.add, the estimator's own view): stored the same way.
  const estimatorKey = String(body.estimatorKey || '').trim().toLowerCase(), estimatorReference = String(body.estimatorReference || '').trim();
  if (estimatorKey && (!STAFF_KEY.test(estimatorKey) || !estimatorReference) || estimatorReference.length > 120) throw knockFailure('An estimator attribution needs a valid staff key and its review reference.', 400, 'knock_setter_estimator');
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
  if (!existing && estimatorKey) {
    const job = ID.test(String(visit.convertedJobId || '')) ? await readJob(visit.convertedJobId) : null;
    await checkEstimatorChoice(admin, estimatorKey, { signer: job?.sourceWalkthroughId === walkthroughId ? handoffSigner(job) : '', env, dispatch });
  }
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

/* Under the owner's approved setter terms (SETTER_TERMS) a signed walkthrough handoff that sold a garage transformation
   (walkthrough-handoff.js) is the evidence the office would otherwise record: that the job is garage work, and who the
   estimator is (its signer) when the walkthrough has none recorded. Every signed handoff is saved as a 'Garage
   transformation' except a junk-only builder quote ('Junk removal', D-JUNK), so what was sold decides it: an itemized
   quote needs a selected, charged service, product or labor line that is not junk removal (the builder's removal-junk
   lines, a disposal line or a line named junk); a single signed total needs a finishing option in its signed scope
   (cleanout and reset, shelving, totes...). Anything else, a junk-only quote included, stays unverified until the office
   classifies it (setter.classify, estimator.classify). A builder
   quote's Labor line (D12; since D-JUNK only on quotes with garage work, though a junk-only quote signed earlier may carry
   one) is evidence of neither. */
const junkLine = line => line.kind === 'disposal' || /^removal-junk/.test(String(line.id || '')) || /\bjunk\b/i.test(`${line.name || ''} ${line.description || ''}`);
export function signedGarageWork(job) {
  const lines = job?.estimate?.lineItems;
  if (Array.isArray(lines) && lines.length) return lines.some(line => line && typeof line === 'object' && included(line) && ['service', 'product', 'labor'].includes(line.kind) && Number(line.totalCents) > 0 && !junkLine(line) && !builderLaborLine(line));
  const finish = job?.scope?.finish;
  return Array.isArray(finish) && finish.some(id => typeof id === 'string' && id.trim() !== '');
}
export const signedGarageHandoff = job => job?.handoffVersion === 1 && job.serviceType === 'Garage transformation' && typeof job.handoffRequestId === 'string' && Boolean(job.handoffRequestId) && signedGarageWork(job);
export const handoffSigner = job => {
  const key = typeof job?.acceptance?.recordedBy === 'string' ? job.acceptance.recordedBy.trim().toLowerCase() : '';
  return STAFF_KEY.test(key) ? key : '';
};

/* REP-WALKTHROUGH (owner decision 2026-10-21): a walkthrough the Knock bridge booked a rep to run themselves ("Do the
   walkthrough now", knock-bridge.js bookSelfRun: selfRun with their Hub staff key) and whose customer signature that rep
   recorded on the handoff pays the door-sale 25% to the rep alone, never the setter 13% plus an estimator's 7%. If
   anyone else signed it (an estimator took it over) it is an ordinary door-set walkthrough: 13% to the rep and 7% to
   the signer, the estimator by that signature (the bridge records no estimator on a self-run walkthrough, and the rep
   is never read as their own estimator). */
export const repRanWalkthrough = (record, job) => record?.selfRun === true && STAFF_KEY.test(String(record.repStaffKey || '')) && handoffSigner(job) === record.repStaffKey;

/* Closed (an accepted estimate and its time) and how it was collected (the unified totals and payment ledger): the
   evidence both walkthrough channels earn on, the setter's and the estimator's. null while not closed. */
export function collectionEvidence(job) {
  const closedAt = job?.estimate?.acceptedAt || job?.customerApproval?.approvedAt;
  if (!['accepted', 'approved'].includes(job?.estimate?.status) || !Number.isFinite(Date.parse(closedAt))) return null;
  const totals = customerMoneyTotals(job, { unified: true }), ledger = paymentLedger(job);
  return { closedAt, totals, ledger, verified: totals.complete && ledger.complete && !ledger.entries.some(entry => entry.verified !== true),
    collected: totals.complete && ledger.complete ? totals.appliedCents / 100 : null };
}

// Once nothing else holds it: paid in full, and when the job qualified (its close and its last receipt), or what holds it.
export function qualifyingCollection({ closedAt, totals, ledger }, nowMs) {
  if (!(totals.totalCents > 0) || totals.appliedCents !== totals.totalCents) return { state: totals.appliedCents > 0 ? 'review_required' : 'awaiting_collection', reviewReasons: totals.appliedCents > 0 ? ['partial_collection_policy_unconfigured'] : [] };
  const times = ledger.entries.filter(entry => entry.kind !== 'tip').map(entry => Date.parse(entry.at));
  if (!times.length || times.some(time => !Number.isFinite(time))) return { state: 'review_required', reviewReasons: ['collection_time_unverified'] };
  const at = Math.max(Date.parse(closedAt), ...times);
  if (at > nowMs) return { state: 'review_required', reviewReasons: ['event_time_unverified'] };
  return { state: 'qualified', at };
}

// The approved terms' base: the job's whole price including goods (paid in full before anything is earned).
export const approvedBase = (terms, evidence) => terms?.verified === true && evidence?.totals.totalCents > 0
  ? { base: { verified: true, amountCents: evidence.totals.totalCents, reference: terms.reference }, rounding: 'nearest_cent' } : {};
/* Earned once qualified, approved and attributed: never before the owner's approval, nor before the office recorded or
   settled what pays it (floors: a setter record's recordedAt and classifiedAt, an estimator the office confirmed, an
   office classification), so neither an approval nor a later office action rewrites a closed period. */
export const earnedFloor = (terms, ...floors) => Math.max(Date.parse(terms.approvedAt), ...floors.map(value => typeof value === 'string' ? Date.parse(value) : NaN).filter(Number.isFinite));
export const earnedTime = (qualifiedAt, terms, ...floors) => new Date(Math.max(qualifiedAt, earnedFloor(terms, ...floors))).toISOString();
export const centsToDollars = amount => Number.isSafeInteger(amount) ? amount / 100 : null;

/* A share held for a cancellation, a refund or an unverified receipt after money was collected may already have been
   earned, and paid, in an earlier statement (the terms hold refunds and cancellations for review; nothing is clawed
   back). Like a direct sale's review (crew/knock-money.js reviewScope) it holds its recipients' statements for the pay
   periods it touched from floorMs on: {dates} of when it was (or would have been) earned, its close, receipts,
   cancellation and refunds, and {from} for a refund or cancellation with no usable date, which holds every period from
   floorMs. null when nothing was collected, or when all of it happened before the share could be earned. */
const ADJUSTMENT_REASONS = ['cancellation_review', 'collection_unverified'];
const refundTimes = job => [job?.refunds, job?.payment?.refunds].flatMap(list => Array.isArray(list) ? list : [])
  .map(item => item && typeof item === 'object' ? item.refundedAt || item.at || item.createdAt || item.recordedAt : null).concat(job?.payment?.refundedAt ?? [])
  .filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
export function adjustmentHold(job, evidence, reasons, floorMs, nowMs = Date.now()) {
  const held = reasons.filter(reason => ADJUSTMENT_REASONS.includes(reason));
  if (!evidence || !held.length || !Number.isFinite(floorMs)) return null;
  const refunded = refundsRecorded(job), receipts = evidence.ledger.entries.filter(entry => entry.kind !== 'tip');
  if (!receipts.length && !refunded) return null;
  const refunds = refundTimes(job), qualified = qualifyingCollection(evidence, nowMs);
  const dates = [...new Set([...[evidence.closedAt, job.cancelledAt, ...receipts.map(entry => entry.at), ...refunds].map(value => typeof value === 'string' ? Date.parse(value) : NaN),
    ...(qualified.state === 'qualified' ? [Math.max(qualified.at, floorMs)] : [])]
    .filter(time => Number.isFinite(time) && time >= floorMs))].sort((a, b) => a - b).map(time => new Date(time).toISOString());
  const undated = refunded && !refunds.length || reasons.includes('cancellation_review') && !(typeof job.cancelledAt === 'string' && Number.isFinite(Date.parse(job.cancelledAt)));
  if (!dates.length && !undated) return null;
  return { reasons: held, dates, from: undated ? new Date(floorMs).toISOString() : null };
}

/* One setter record as money. terms is the owner's setter approval (knock-access.js setterTermsState): without it (or
   unverified) every row ends held for review exactly as before, with no amount. With it, a closed job's allocations
   carry each share of its price (the projection), and a job paid in full makes both shares earned (state 'earned',
   earnedAt), each paid through its recipient's commission statement. Under the approved terms the estimator the Knock
   bridge booked (source knock_walkthrough) is weaker evidence than the handoff's signature: a different signer holds the
   share (estimator_attribution_conflict) until the office settles it (setter.classify). A held row whose job had
   collected money and was then cancelled, refunded or left with an unverified receipt carries adjustment (adjustmentHold). */
// The estimator the Knock bridge booked (knock-bridge.js recordD2dSetter), not one the office recorded.
const bridgeEstimator = record => record.source === 'knock_walkthrough' || record.recordedBy === 'knock-bridge' || String(record.estimatorReference || '').startsWith('knock-walkthrough:');
export function projectSetterAttribution(record, visit, job, directSales = [], nowMs = Date.now(), terms = null) {
  // REP-WALKTHROUGH: on a self-run record the rep is never the estimator (repRanWalkthrough), so any signer but them is.
  const recorded = String(record.estimatorKey || '').trim().toLowerCase();
  const approved = terms?.verified === true, recordedEstimator = record.selfRun === true && recorded === record.repStaffKey ? '' : recorded;
  const result = { id: record.id || record.walkthroughId, walkthroughId: record.walkthroughId, channel: 'appointment_setter',
    setterKey: record.setterKey, estimatorKey: recordedEstimator || null, estimatorEvidence: recordedEstimator ? 'admin_recorded_unreconciled' : 'unverified',
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
  // REP-WALKTHROUGH: the rep ran and signed it: one direct-sale share (25%) to them, no estimator share.
  const repRan = repRanWalkthrough(record, job);
  if (repRan) Object.assign(result, { channel: 'direct_sale', rate: CHANNEL_PERCENTS.directSale / 100, estimatorKey: null, estimatorEvidence: 'rep_ran_walkthrough' });
  const ownRole = repRan ? 'direct_rep' : 'setter';
  const classification = approved && record.serviceClassification === 'unverified' && signedGarageHandoff(job) ? 'garage' : record.serviceClassification;
  if (approved) {
    // recordedAt: when the record was made, the source a statement's lookback is counted from (estimator-commission.js).
    Object.assign(result, { jobDate: typeof job.date === 'string' ? job.date : null, serviceClassification: classification,
      classificationEvidence: classification === record.serviceClassification ? 'recorded' : 'signed_handoff', projectedCommission: null, earnedAt: null, recordedAt: record.recordedAt ?? null });
    const signer = handoffSigner(job);
    if (repRan) { /* the rep is the signer: no estimator share to attribute */ }
    else if (!recordedEstimator && signer) Object.assign(result, { estimatorKey: signer, estimatorEvidence: 'handoff_signer' });
    else if (recordedEstimator && signer && signer !== recordedEstimator && bridgeEstimator(record) && !record.estimatorClassifiedAt) result.reviewReasons.push('estimator_attribution_conflict');
  }
  const direct = directSales.find(sale => sale.handoff?.job?.ref === job.id);
  result.directSaleRepKey = direct?.repKey || null;
  if (direct) result.reviewReasons.push('direct_close_attribution_conflict');
  if (classification !== 'garage') result.reviewReasons.push('service_scope_unverified');
  if (['cancelled', 'canceled', 'no_show'].includes(job.pipelineStatus || job.status)) result.reviewReasons.push('cancellation_review');
  const evidence = collectionEvidence(job);
  if (!evidence) return { ...result, state: 'awaiting_close' };
  const allocation = repRan
    ? commissionAllocations({ channel: 'direct_sale', jobId: job.id, serviceClassification: classification, directRepKey: record.setterKey, ...approvedBase(terms, evidence) })
    : commissionAllocations({ channel: 'appointment_setter', jobId: job.id, serviceClassification: classification,
      setterKey: record.setterKey, estimatorKey: result.estimatorKey || '', directRepKey: result.directSaleRepKey || '', ...approvedBase(terms, evidence) });
  // A cancelled job projects nothing: it cannot be earned while it stays cancelled.
  if (approved) Object.assign(result, { allocations: allocation.allocations, projectedCommission: result.reviewReasons.includes('cancellation_review') ? null : centsToDollars(allocation.allocations.find(item => item.role === ownRole)?.amountCents) });
  if (!evidence.verified) result.reviewReasons.push('collection_unverified');
  if (evidence.collected !== null) result.customerCollectedRevenue = evidence.collected;
  const floors = [record.recordedAt, record.classifiedAt, record.estimatorClassifiedAt];
  if (result.reviewReasons.length) {
    const adjustment = approved ? adjustmentHold(job, evidence, result.reviewReasons, earnedFloor(terms, ...floors), nowMs) : null;
    return { ...result, state: 'review_required', ...(adjustment ? { adjustment } : {}) };
  }
  const qualified = qualifyingCollection(evidence, nowMs);
  if (qualified.state !== 'qualified') return { ...result, state: qualified.state, reviewReasons: qualified.reviewReasons };
  const qualifyingAt = new Date(qualified.at).toISOString();
  if (!approved) return { ...result, state: 'review_required', qualifyingAt, allocations: allocation.allocations, reviewReasons: [...allocation.reviewReasons, 'payroll_anchor_unconfigured'] };
  if (allocation.state !== 'calculated') return { ...result, state: 'review_required', qualifyingAt, reviewReasons: allocation.reviewReasons };
  const earnedAt = earnedTime(qualified.at, terms, ...floors), own = centsToDollars(allocation.allocations.find(item => item.role === ownRole).amountCents);
  return { ...result, state: 'earned', qualifyingAt, earnedAt, earnedCommission: own, payableCommission: own };
}

// The setter policy a view reports: the fixed rates, and whether the owner approved them (knock-access.js setterTermsState).
export const setterPolicyFor = terms => terms?.verified === true
  ? { ...setterPolicy, approval: 'approved', approvedAt: terms.approvedAt, gaps: ['partial_collections', 'refund_clawbacks'] } : setterPolicy;

/* The door sales the office linked to these jobs (knock_sales handoff.job.ref, the direct_close_attribution_conflict
   evidence): one query per 30 job ids, never every sale. */
export async function directSalesFor(store, jobIds) {
  const ids = [...new Set(jobIds.filter(id => ID.test(String(id || ''))))], sales = [];
  for (let at = 0; at < ids.length; at += 30) sales.push(...await store.query('knock_sales', { where: [['handoff.job.ref', 'in', ids.slice(at, at + 30)]], select: ['repKey', 'handoff.job.ref'] }));
  return sales;
}

/* Setter records as money, at most `limit` of them (truncated says more exist). Each reads its walkthrough and, once
   converted, its job (masked; setterJobReader, or readJobs: the whole page in batches, setterBatchReaderFor), and the
   door sales linked to those jobs. `rows` projects the given records instead of reading them. A record whose source
   cannot be read is 'source_unavailable'. */
export async function setterAttributions(store, env, { repKey = null, nowMs = Date.now(), readJob = null, readJobs = null, terms = null, limit = 100, rows: given = null } = {}) {
  const rows = given || (repKey ? await store.query('knock_setters', { where: [['setterKey', '==', repKey]] }) : await store.list('knock_setters'));
  const policy = setterPolicyFor(terms);
  if (!rows.length) return { rows: [], truncated: false, policy };
  const page = rows.slice(0, limit);
  let read = readJob || (readJobs ? null : setterJobReader(env));
  if (!read) {
    try {
      const visits = await readJobs(page.map(row => row.walkthroughId)), jobs = await readJobs([...visits.values()].map(visit => visit.convertedJobId));
      read = async id => visits.get(id) || jobs.get(id) || null;
    } catch { read = async () => { throw new Error('source_unavailable'); }; }
  }
  const sources = await Promise.all(page.map(async row => {
    try {
      const visit = await read(row.walkthroughId);
      return { row, visit, job: ID.test(String(visit?.convertedJobId || '')) ? await read(visit.convertedJobId) : null };
    } catch { return { row, unavailable: true }; }
  }));
  const directSales = await directSalesFor(store, sources.map(source => source.job?.id));
  const projected = sources.map(({ row, visit, job, unavailable }) => unavailable
    ? { id: row.id, walkthroughId: row.walkthroughId, setterKey: row.setterKey, estimatorKey: String(row.estimatorKey || '').trim().toLowerCase() || null, channel: 'appointment_setter', rate: setterPolicy.rate,
      state: 'review_required', earnedCommission: null, payableCommission: null, reviewReasons: ['source_unavailable'] }
    : projectSetterAttribution(row, visit, job, directSales, nowMs, terms));
  return { rows: projected, truncated: rows.length > page.length, policy };
}

/* Who the office may name as a walkthrough's estimator (the 7% recipient): the employee who signed its handoff (the
   evidence) always; anyone else must be on the dispatch roster, and an admin who is not the owner never names
   themselves. */
export async function checkEstimatorChoice(admin, estimatorKey, { signer = '', env = {}, dispatch = dispatchStorage } = {}) {
  if (signer && estimatorKey === signer) return;
  if (!isOwner(admin) && estimatorKey === repKeyFor(admin?.user)) throw knockFailure('Name the estimator who did the walkthrough; only the owner records themselves as its estimator.', 403, 'knock_setter_self');
  if (!(await dispatch(env).roster()).some(person => person?.id === estimatorKey)) throw knockFailure('That estimator is not on the staff roster.', 400, 'knock_setter_estimator');
}

/* The office settles a setter record: its service classification (garage, or junk removal, which earns nothing) with
   the review reference, and optionally its estimator (a staff key with its reference), e.g. a walkthrough the bridge
   recorded unverified, or one Dispatch gave another estimator. A classification already settled is never changed here
   (409 knock_setter_conflict: finance reviews it). An estimator already recorded is changed only to the employee who
   signed the walkthrough's handoff, or by the owner (409 otherwise); naming the recorded one again confirms it
   (estimatorClassifiedAt), which settles a conflict with the signer (estimator_attribution_conflict). A first estimator
   follows checkEstimatorChoice. Idempotent on requestId; the receipt keeps what it replaced.
   Body: { requestId, walkthroughId, serviceClassification: 'garage'|'junk_removal', classificationReference, estimatorKey?, estimatorReference? }. */
export async function classifySetter(store, admin, body, nowIso, env = {}, { dispatch = dispatchStorage, readJobs = null } = {}) {
  const { requestId, walkthroughId, serviceClassification } = body || {};
  if (!UUID.test(String(requestId || '')) || !ID.test(String(walkthroughId || ''))) throw knockFailure('Choose a valid walkthrough and request id.', 400, 'knock_setter_invalid');
  const classificationReference = String(body.classificationReference || '').trim();
  if (!['garage', 'junk_removal'].includes(serviceClassification) || !classificationReference || classificationReference.length > 120) throw knockFailure('Choose garage work or junk removal, with its review reference.', 400, 'knock_setter_scope');
  const estimatorKey = String(body.estimatorKey || '').trim().toLowerCase(), estimatorReference = String(body.estimatorReference || '').trim();
  if (estimatorKey && (!STAFF_KEY.test(estimatorKey) || !estimatorReference) || estimatorReference.length > 120 || !estimatorKey && estimatorReference) throw knockFailure('An estimator attribution needs a valid staff key and its review reference.', 400, 'knock_setter_estimator');
  const change = { walkthroughId, serviceClassification, classificationReference, estimatorKey, estimatorReference };
  const receiptId = `setter_classify_${requestId.toLowerCase()}`;
  const sameChange = receipt => Object.keys(change).every(key => receipt?.[key] === change[key]);
  const replay = async () => {
    const receipt = await store.get('knock_receipts', receiptId);
    if (!receipt) return null;
    if (receipt.kind !== 'setter_classification' || !sameChange(receipt)) throw conflict();
    return { duplicate: true, attribution: await store.get('knock_setters', walkthroughId) };
  };
  const prior = await replay();
  if (prior) return prior;
  const row = await store.get('knock_setters', walkthroughId);
  if (!row) throw knockFailure('No setter is recorded for that walkthrough.', 404, 'knock_setter_missing');
  const settled = row.serviceClassification !== 'unverified';
  if (settled && (row.serviceClassification !== serviceClassification || row.classificationReference !== classificationReference)) throw conflict();
  const current = String(row.estimatorKey || '').trim().toLowerCase();
  // A change, or an admin confirming themselves, is checked against the signed handoff (the evidence).
  if (estimatorKey && (estimatorKey !== current || !isOwner(admin) && estimatorKey === repKeyFor(admin?.user))) {
    const read = readJobs || setterBatchReaderFor(dispatch(env));
    const visit = (await read([walkthroughId])).get(walkthroughId);
    const job = ID.test(String(visit?.convertedJobId || '')) ? (await read([visit.convertedJobId])).get(visit.convertedJobId) : null;
    const signer = job?.sourceWalkthroughId === walkthroughId ? handoffSigner(job) : '';
    if (current && estimatorKey !== current && estimatorKey !== signer && !isOwner(admin)) throw knockFailure('This walkthrough already has an estimator. Name the estimator who signed its handoff, or ask the owner to change it; nothing was reassigned.', 409, 'knock_setter_conflict');
    await checkEstimatorChoice(admin, estimatorKey, { signer, env, dispatch });
  }
  // A settled classification keeps its time; the estimator, when named, is the office's from now (earnedFloor).
  const patch = { ...(!settled ? { serviceClassification, classificationReference, classifiedBy: admin.user, classifiedAt: nowIso } : {}),
    ...(estimatorKey ? { estimatorKey, estimatorReference, estimatorClassifiedBy: admin.user, estimatorClassifiedAt: nowIso } : {}) };
  const previous = { serviceClassification: row.serviceClassification ?? null, classificationReference: row.classificationReference ?? null, estimatorKey: row.estimatorKey ?? null, estimatorReference: row.estimatorReference ?? null };
  try {
    await store.commit([...(Object.keys(patch).length ? [write.patch('knock_setters', walkthroughId, patch, row.__updateTime)] : [write.verify('knock_setters', walkthroughId, row.__updateTime)]),
      write.create('knock_receipts', receiptId, { kind: 'setter_classification', ...change, previous, recordedBy: admin.user, recordedAt: nowIso })]);
  } catch (error) {
    const replayed = await replay();
    if (replayed) return replayed;
    throw error;
  }
  const { __updateTime, ...saved } = { ...row, ...patch };
  return { duplicate: false, attribution: { ...saved, id: walkthroughId } };
}
