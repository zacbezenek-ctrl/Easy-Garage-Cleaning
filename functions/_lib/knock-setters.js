// Appointment-setting attribution is a separate ledger from direct door sales.
// Reads canonical close/payment evidence; never creates an appointment or payout.
import { knockFailure, write } from './knock-store.js';
import { dispatchStorage } from './dispatch-storage.js';
import { customerMoneyTotals, moneyCents, paymentLedger, refundsRecorded } from './money-core.js';
import { walkthroughStatus } from './walkthrough-state.js';
import { commissionAllocations } from './knock-allocations.js';
import { builderLaborLine, included } from './quote-model.js';
import { isOwner, repKeyFor } from './knock-access.js';
import { CHANNEL_PERCENTS, ONLINE_APPROVAL_DAYS, SETTER_CONTRACT_V1 } from '../../crew/knock-money.js';
import { addDays, validDate, zonedDate } from '../../crew/knock-time.js';

const ID = /^[A-Za-z0-9_-]{1,120}$/, STAFF_KEY = /^[a-z0-9._-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SETTER_JOB_FIELDS = Object.freeze(['type', 'status', 'pipelineStatus', 'convertedJobId', 'sourceWalkthroughId', 'walkthroughOutcome',
  'walkthroughCompletedAt', 'scheduleOccurrence', 'date', 'time', 'estimate', 'customerApproval',
  'acceptance.recordedBy', 'acceptance.firstRecordedBy', 'acceptance.acceptedAt', 'total', 'priceQuoted', 'lockedTotal', 'rate',
  'payment', 'deposit', 'invoice', 'refunds', 'changeOrders', 'giftWallet',
  // The approved setter terms read the signed handoff's evidence (signedGarageHandoff: its lines, else its finish scope)
  // and when a cancelled job was cancelled (adjustmentHold).
  'handoffVersion', 'handoffRequestId', 'serviceType', 'scope.finish', 'cancelledAt',
  // knock-setter-v2: when the job was completed (jobCompletedAt), the quote a walkthrough saved (approvedWalkthroughQuote)
  // and who did the walkthrough (walkthroughEstimator).
  'completedAt', 'fieldExecution.completion.completedAt', 'quoteDraft.sourceWalkthroughId', 'walkthroughVisit.startedBy']);
const FIELDS = SETTER_JOB_FIELDS;

// Owner decision 2026-10-17: a D2D-set walkthrough pays 13% to the setter plus 7% to the
// estimator, 20% total of the full garage job including goods (was 12% + 7%). Owner decision 2026-10-30
// (knock-setter-v2): earned when the job is completed and paid in full.
export const setterPolicy = Object.freeze({ channel: 'appointment_setter', rate: CHANNEL_PERCENTS.setter / 100, estimatorRate: CHANNEL_PERCENTS.estimator / 100,
  totalRate: (CHANNEL_PERCENTS.setter + CHANNEL_PERCENTS.estimator) / 100,
  earningTrigger: 'completed_and_collected', payoutCadence: 'biweekly',
  approval: 'unconfigured', gaps: ['recipient_verification', 'calculation_base', 'payroll_cycle_anchor', 'partial_collections'] });

/* The jobs saved from these walkthroughs (quote-draft.js createDraft: sourceWalkthroughId), masked like the rest, 30
   walkthroughs a query: Map walkthroughId -> [jobs]. Only knock-setter-v2 reads them (approvedWalkthroughQuote). */
const quoteJobsFor = store => async ids => {
  const unique = [...new Set(ids.filter(id => ID.test(String(id || ''))))], found = new Map();
  if (typeof store.walkthroughJobs !== 'function') return found;
  for (let at = 0; at < unique.length; at += 30) for (const job of await store.walkthroughJobs(unique.slice(at, at + 30), [...FIELDS])) {
    if (!found.has(job.sourceWalkthroughId)) found.set(job.sourceWalkthroughId, []);
    found.get(job.sourceWalkthroughId).push(job);
  }
  return found;
};

// Walkthroughs and jobs by id, masked to what the setter and estimator projections read, from a dispatch store, a batch
// of up to 100 per request (one or two requests for a page of setter records, not two per record): Map id -> row.
// Its quoteJobs reads the jobs saved from walkthroughs that never converted (quoteJobsFor).
export const setterBatchReaderFor = store => Object.assign(async ids => {
  const unique = [...new Set(ids.filter(id => ID.test(String(id || ''))))], rows = [];
  for (let at = 0; at < unique.length; at += 100) rows.push(...await store.readMany('jobs', unique.slice(at, at + 100), [...FIELDS]));
  return new Map(rows.map(row => [row.id, row]));
}, { quoteJobs: quoteJobsFor(store) });

export function setterJobReader(env) {
  const store = dispatchStorage(env);
  return Object.assign(async id => (await store.readMany('jobs', [id], FIELDS))[0] || null, { quoteJobs: quoteJobsFor(store) });
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
// Who signed the job's first handoff: a manager's later signed revision never takes the rep's walkthrough from them.
export const firstHandoffSigner = job => {
  const key = String(job?.acceptance?.firstRecordedBy || job?.acceptance?.recordedBy || '').trim().toLowerCase();
  return STAFF_KEY.test(key) ? key : '';
};
// The staff key must be the setter's own (repKeyFor), so a visit an estimator was given can never pay the rep 25%. A quote
// saved from the walkthrough and approved (ONLINE-APPROVAL, visit given) has no signer: whoever did the walkthrough.
export const repRanWalkthrough = (record, job, visit = null) => record?.selfRun === true && STAFF_KEY.test(String(record.repStaffKey || '')) && repKeyFor(record.repStaffKey) === record.setterKey &&
  (firstHandoffSigner(job) || (visit && approvedWalkthroughQuote(job) ? walkthroughEstimator(visit) : '')) === record.repStaffKey;

/* ONLINE-APPROVAL (owner decision 2026-10-30, knock-setter-v2): a quote saved from a walkthrough (quote-draft.js
   createDraft: sourceWalkthroughId on the job and on its quoteDraft) and approved by the customer in the portal or as the
   office recorded it (customer-portal.js, money-service.js estimate.record_approval), never signed on site. It never
   converts the walkthrough (only a signed handoff sets convertedJobId), so the ledgers find it by its walkthrough. Approved
   within ONLINE_APPROVAL_DAYS of the walkthrough it pays exactly as a signed one: its garage evidence is the approved
   quote's (approvedGarageQuote, as signedGarageHandoff), its estimator the one who did the walkthrough
   (walkthroughEstimator, as the handoff's signer), never whoever recorded or sent the quote. Approved later, it pays
   nothing (approved_after_30_days). A web or phone lead with no walkthrough has nothing to pay. */
const ONLINE_SOURCES = ['customer_portal', 'employee_recorded'];
export const approvedWalkthroughQuote = job => job?.type === 'job' && ID.test(String(job.sourceWalkthroughId || '')) && job.quoteDraft?.sourceWalkthroughId === job.sourceWalkthroughId &&
  job.customerApproval?.status === 'approved' && ONLINE_SOURCES.includes(job.customerApproval.source) && job.estimate?.acceptanceMethod !== 'in_person_signature' && job.handoffVersion !== 1;
export const approvedGarageQuote = job => approvedWalkthroughQuote(job) && job.serviceType === 'Garage transformation' && signedGarageWork(job);
// Who did the walkthrough: the staff key that finished it (walkthrough-visit.js), else the one that started it.
export const walkthroughEstimator = visit => {
  const key = String(visit?.walkthroughOutcome?.performedBy || visit?.walkthroughVisit?.startedBy || '').trim().toLowerCase();
  return STAFF_KEY.test(key) ? key : '';
};
// 'within' ONLINE_APPROVAL_DAYS of the walkthrough (Denver dates: the day it was finished, else its booked day), 'after',
// or 'unverified' when either date cannot be read. The approval is the one collectionEvidence closes the job with.
export function approvalWindow(visit, job) {
  const done = [visit?.walkthroughCompletedAt, visit?.walkthroughOutcome?.finishedAt].find(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  const from = done ? zonedDate(Date.parse(done)) : validDate(visit?.date) ? visit.date : null, at = Date.parse(job?.estimate?.acceptedAt || job?.customerApproval?.approvedAt || '');
  if (!from || !Number.isFinite(at)) return 'unverified';
  return zonedDate(at) <= addDays(from, ONLINE_APPROVAL_DAYS) ? 'within' : 'after';
}
// Whether the ledgers pay a walkthrough's job at all under knock-setter-v2: signed at the walkthrough, or its quote
// approved within the window (job-actuals.js deducts exactly these).
export const signedWalkthroughJob = job => job?.handoffVersion === 1 || job?.estimate?.acceptanceMethod === 'in_person_signature' || job?.customerApproval?.source === 'in_person_signature';
export const paidWalkthroughJob = (job, visit) => signedWalkthroughJob(job) || approvedWalkthroughQuote(job) && approvalWindow(visit, job) === 'within';

// knock-setter-v1 approvals keep their own rules exactly; v2, or no approval yet, the owner's 2026-10-30 rules.
export const earlierRules = terms => terms?.contract === SETTER_CONTRACT_V1;
/* knock-setter-v2 approved over a knock-setter-v1 approval (terms.earlier, knock-access.js setterTermsState): a share v1
   earned before the v2 approval keeps its time and amount, so no closed period changes; anything else follows v2. */
export function underEarlierTerms(terms, project) {
  if (terms?.verified !== true || earlierRules(terms) || !terms.earlier) return null;
  const legacy = project({ verified: true, approvedAt: terms.earlier.approvedAt, reference: terms.earlier.reference || terms.reference, contract: SETTER_CONTRACT_V1 });
  return legacy.state === 'earned' && Date.parse(legacy.earnedAt) < Date.parse(terms.approvedAt) ? { ...legacy, termsContract: SETTER_CONTRACT_V1 } : null;
}

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

/* ---- knock-setter-v2: earned at completion, taken back after a refund or cancellation (owner decision 2026-10-30) ---- */

const DONE = ['completed', 'paid', 'invoiced', 'closed', 'review_requested'], CANCELLED = ['cancelled', 'canceled', 'no_show'];
const stages = job => [job?.pipelineStatus || job?.status, job?.status].map(value => String(value || '').toLowerCase());
const cancelledJob = job => stages(job).some(stage => CANCELLED.includes(stage));
// When the job's work was completed (its field completion, else completedAt; America/Denver decides its pay period), on a
// job marked done or cancelled after it; null otherwise.
export function jobCompletedAt(job) {
  const at = Date.parse(job?.fieldExecution?.completion?.completedAt || job?.completedAt || '');
  return Number.isFinite(at) && (stages(job).some(stage => DONE.includes(stage)) || cancelledJob(job)) ? at : null;
}
/* The refunds recorded on the job, in the shapes refundsRecorded reads (job.refunds, payment.refunds rows with their
   amount and refundedAt; payment.refundedAmount with payment.refundedAt), as [{cents, at}]; null when one of them has no
   readable amount or time, or a lump refund sits beside itemized ones. */
export function refundEvents(job) {
  const events = [], lump = moneyCents(job?.payment?.refundedAmount);
  for (const list of [job?.refunds, job?.payment?.refunds]) {
    if (!Array.isArray(list)) { if (list && (typeof list !== 'object' || Object.keys(list).length)) return null; continue; }
    for (const item of list) {
      const cents = Number.isSafeInteger(item?.amountCents) && item.amountCents > 0 ? item.amountCents : moneyCents(item?.amount);
      const at = Date.parse(item && typeof item === 'object' ? item.refundedAt || item.at || item.createdAt || item.recordedAt || '' : '');
      if (!(cents > 0) || !Number.isFinite(at)) return null;
      events.push({ cents, at });
    }
  }
  if (lump > 0) {
    const at = Date.parse(job.payment.refundedAt || '');
    if (events.length || !Number.isFinite(at)) return null;
    events.push({ cents: lump, at });
  }
  return events.sort((a, b) => a.at - b.at);
}
/* When a share is earned under knock-setter-v2, from the job's own evidence: the later of its close, its full payment
   (verified receipts reaching its whole price, tips and refunds aside) and its completion; and the refunds and the
   cancellation dated after nothing more than now. {state: 'qualified', at, completedAt, events: [{reason, cents?, at}]}
   or the state that holds it: awaiting_completion (job_not_complete: a deposit is not earned before the job is done),
   awaiting_collection (a completed job's balance is still due), cancelled (cancelled before it was completed and paid
   in full: never earned, nothing to take back), review_required. */
export function completionEarning(job, { closedAt, totals, ledger }, nowMs) {
  const refunds = refundEvents(job);
  if (refunds === null) return { state: 'review_required', reviewReasons: ['refund_unverified'] };
  const receipts = ledger.entries.filter(entry => !['tip', 'refund'].includes(entry.kind));
  // A refund money-core cannot reconcile yet is read here by its own amount and time.
  const issues = ledger.issues.filter(issue => !(issue === 'money_refunds_unreconciled' && refunds.length));
  if (!totals.complete || ledger.unreconciledCents !== 0 || issues.length || receipts.some(entry => entry.verified !== true || !Number.isSafeInteger(entry.amountCents))) return { state: 'review_required', reviewReasons: ['collection_unverified'] };
  const gross = receipts.reduce((sum, entry) => sum + entry.amountCents, 0), completedAt = jobCompletedAt(job), cancelled = cancelledJob(job);
  if (!(totals.totalCents > 0) || gross > totals.totalCents) return { state: 'review_required', reviewReasons: ['partial_collection_policy_unconfigured'] };
  if (cancelled && (completedAt === null || gross < totals.totalCents)) return { state: 'cancelled', reviewReasons: [] };
  if (completedAt === null) return { state: 'awaiting_completion', reviewReasons: ['job_not_complete'] };
  if (gross < totals.totalCents) return { state: 'awaiting_collection', reviewReasons: gross > 0 ? ['balance_due'] : [] };
  const times = receipts.map(entry => Date.parse(entry.at));
  if (!times.length || times.some(time => !Number.isFinite(time))) return { state: 'review_required', reviewReasons: ['collection_time_unverified'] };
  const at = Math.max(Date.parse(closedAt), ...times, completedAt), cancelledAt = Date.parse(job.cancelledAt || '');
  if (at > nowMs) return { state: 'review_required', reviewReasons: ['event_time_unverified'] };
  if (cancelled && !Number.isFinite(cancelledAt)) return { state: 'review_required', reviewReasons: ['cancellation_review'] };
  if (refunds.reduce((sum, event) => sum + event.cents, 0) > gross) return { state: 'review_required', reviewReasons: ['refund_review'] };
  const events = [...refunds.map(event => ({ reason: 'refund', ...event })), ...(cancelled ? [{ reason: 'cancellation', at: cancelledAt }] : [])]
    .filter(event => event.at <= nowMs).sort((a, b) => a.at - b.at || (a.reason === 'cancellation') - (b.reason === 'cancellation'));
  return { state: 'qualified', at, completedAt, events };
}
/* What each refund or the cancellation takes back from each share: the refunded part at the share's rate, half up to the
   cent and counted cumulatively, all of what is left when cancelled, never more than the share. Each line keeps its
   evidence (reason, when) and a stable id from the share, the reason and the event's time. */
export function shareClawbacks(allocations, events, jobId) {
  const lines = [];
  for (const share of allocations) {
    const percent = Math.round(share.rate * 100);
    let refunded = 0, taken = 0;
    for (const event of events) {
      refunded += event.cents || 0;
      const want = event.reason === 'cancellation' ? share.amountCents : Math.min(share.amountCents, Math.floor((refunded * percent + 50) / 100));
      if (want > taken) lines.push({ id: `${share.id}:clawback:${event.reason}:${event.at}`, jobId, role: share.role, repKey: share.repKey, amountCents: want - taken, reason: event.reason, at: new Date(event.at).toISOString(), refundedCents: event.cents ?? null });
      taken = Math.max(taken, want);
    }
  }
  return lines;
}
/* One share's knock-setter-v2 state from its projection so far (result: its reasons that hold it), its job's evidence
   and its allocations: earned on completion once paid in full (or at the approval or the office's later record:
   floors), with the shares a later refund or cancellation takes back (clawbacks); a refund or cancellation before it was
   earned holds it as before. unapproved: what a row says once qualified before the owner approved the terms. */
export function completionProjection(result, { job, evidence, allocation, terms, floors, ownRole, nowMs, unapproved }) {
  const approved = terms?.verified === true, earning = completionEarning(job, evidence, nowMs), iso = at => new Date(at).toISOString();
  if (evidence.collected !== null) result.customerCollectedRevenue = evidence.collected;
  // A cancelled job projects nothing unless its share was earned before the cancellation (then taken back).
  const projected = result.projectedCommission;
  if (cancelledJob(job)) result.projectedCommission = null;
  if (earning.state === 'cancelled') return { ...result, state: 'cancelled', projectedCommission: null, earnedCommission: 0, payableCommission: 0 };
  const hold = reasons => {
    const adjustment = approved ? adjustmentHold(job, evidence, reasons, earnedFloor(terms, ...floors), nowMs, earning.at) : null;
    return { ...result, state: 'review_required', reviewReasons: reasons, ...(adjustment ? { adjustment } : {}) };
  };
  if (result.reviewReasons.length || earning.state === 'review_required') return hold([...result.reviewReasons, ...(earning.reviewReasons || [])]);
  if (earning.state !== 'qualified') return { ...result, state: earning.state, reviewReasons: earning.reviewReasons };
  const qualifyingAt = iso(earning.at), completedAt = iso(earning.completedAt);
  if (!approved) return { ...result, state: 'review_required', qualifyingAt, completedAt, ...unapproved };
  if (allocation.state !== 'calculated') return { ...result, state: 'review_required', qualifyingAt, completedAt, reviewReasons: allocation.reviewReasons };
  const earnedAt = earnedTime(earning.at, terms, ...floors), early = earning.events.filter(event => event.at <= Date.parse(earnedAt));
  if (early.length) return hold([...new Set(early.map(event => event.reason === 'refund' ? 'refund_review' : 'cancellation_review'))]);
  const clawbacks = shareClawbacks(allocation.allocations, earning.events, job.id), own = centsToDollars(allocation.allocations.find(item => item.role === ownRole).amountCents);
  const taken = clawbacks.filter(line => line.role === ownRole).reduce((sum, line) => sum + line.amountCents, 0);
  return { ...result, state: 'earned', projectedCommission: projected, qualifyingAt, completedAt, earnedAt, earnedCommission: own, payableCommission: own, ...(clawbacks.length ? { clawbacks, clawedBackCommission: centsToDollars(taken) } : {}) };
}

/* A share held for a cancellation, a refund or an unverified receipt after money was collected may already have been
   earned, and paid, in an earlier statement (knock-setter-v1 holds refunds and cancellations for review; v2 holds those
   before the share was earned, or that it cannot read). Like a direct sale's review (crew/knock-money.js reviewScope) it
   holds its recipients' statements for the pay periods it touched from floorMs on: {dates} of when it was (or would have
   been) earned (qualifiedAt: v2's completion-based time, else full payment), its close, receipts, cancellation and
   refunds, and {from} for a refund or cancellation with no usable date, which holds every period from floorMs. null when
   nothing was collected, or when all of it happened before the share could be earned. */
const ADJUSTMENT_REASONS = ['cancellation_review', 'collection_unverified', 'refund_review', 'refund_unverified'];
const refundTimes = job => [job?.refunds, job?.payment?.refunds].flatMap(list => Array.isArray(list) ? list : [])
  .map(item => item && typeof item === 'object' ? item.refundedAt || item.at || item.createdAt || item.recordedAt : null).concat(job?.payment?.refundedAt ?? [])
  .filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
export function adjustmentHold(job, evidence, reasons, floorMs, nowMs = Date.now(), qualifiedAt = null) {
  const held = reasons.filter(reason => ADJUSTMENT_REASONS.includes(reason));
  if (!evidence || !held.length || !Number.isFinite(floorMs)) return null;
  const refunded = refundsRecorded(job), receipts = evidence.ledger.entries.filter(entry => entry.kind !== 'tip');
  if (!receipts.length && !refunded) return null;
  const refunds = refundTimes(job), qualified = Number.isFinite(qualifiedAt) ? { state: 'qualified', at: qualifiedAt } : qualifyingCollection(evidence, nowMs);
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
  const earlier = underEarlierTerms(terms, legacy => projectSetterAttribution(record, visit, job, directSales, nowMs, legacy));
  if (earlier) return earlier;
  // REP-WALKTHROUGH: on a self-run record the rep is never the estimator (repRanWalkthrough), so any signer but them is.
  const recorded = String(record.estimatorKey || '').trim().toLowerCase(), v1 = earlierRules(terms);
  const approved = terms?.verified === true, recordedEstimator = record.selfRun === true && recorded === record.repStaffKey ? '' : recorded;
  const result = { id: record.id || record.walkthroughId, walkthroughId: record.walkthroughId, channel: 'appointment_setter',
    setterKey: record.setterKey, estimatorKey: recordedEstimator || null, estimatorEvidence: recordedEstimator ? 'admin_recorded_unreconciled' : 'unverified',
    closingActorKey: null, directSaleRepKey: null, serviceClassification: record.serviceClassification,
    state: 'awaiting_close', rate: setterPolicy.rate, earnedCommission: null, payableCommission: null,
    customerCollectedRevenue: null, qualifyingAt: null, allocations: [], reviewReasons: [], settlement: 'not_reconciled' };
  if (record.serviceClassification === 'junk_removal') return { ...result, state: 'excluded', earnedCommission: 0, payableCommission: 0 };
  if (!visit || visit.id !== record.walkthroughId || visit.type !== 'walkthrough' || !visit.revision) return { ...result, state: 'review_required', reviewReasons: ['walkthrough_unverified'] };
  const status = walkthroughStatus(visit);
  // ONLINE-APPROVAL (knock-setter-v2): the quote saved from the walkthrough and approved (setterAttributions finds it).
  if (!visit.convertedJobId && !v1 && job?.ambiguous === true) return { ...result, state: 'review_required', reviewReasons: ['conversion_link_unverified'] };
  const online = !visit.convertedJobId && !v1 && approvedWalkthroughQuote(job);
  if (!visit.convertedJobId && !online) return { ...result, state: ['no_show', 'cancelled', 'lost'].includes(status.state) ? status.state : 'awaiting_close', earnedCommission: 0, payableCommission: 0 };
  if (!job || job.type !== 'job' || job.id !== (online ? job.id : visit.convertedJobId) || job.sourceWalkthroughId !== visit.id || !job.revision) return { ...result, state: 'review_required', reviewReasons: ['conversion_link_unverified'] };
  result.jobId = job.id;
  result.closingActorKey = typeof job.acceptance?.recordedBy === 'string' ? job.acceptance.recordedBy : null;
  if (online) result.closedBy = 'approved_quote';
  // REP-WALKTHROUGH: the rep ran and signed it (or did the walkthrough of the approved quote): one direct-sale share
  // (25%) to them, no estimator share.
  const repRan = repRanWalkthrough(record, job, online ? visit : null);
  if (repRan) Object.assign(result, { channel: 'direct_sale', rate: CHANNEL_PERCENTS.directSale / 100, estimatorKey: null, estimatorEvidence: 'rep_ran_walkthrough' });
  const ownRole = repRan ? 'direct_rep' : 'setter';
  const classification = approved && record.serviceClassification === 'unverified' && (online ? approvedGarageQuote(job) : signedGarageHandoff(job)) ? 'garage' : record.serviceClassification;
  if (approved) {
    // recordedAt: when the record was made, the source a statement's lookback is counted from (estimator-commission.js).
    Object.assign(result, { jobDate: typeof job.date === 'string' ? job.date : null, serviceClassification: classification,
      classificationEvidence: classification === record.serviceClassification ? 'recorded' : online ? 'approved_quote' : 'signed_handoff', projectedCommission: null, earnedAt: null, recordedAt: record.recordedAt ?? null });
    // An approved quote has no signer: the one who did the walkthrough is the same evidence.
    const signer = online ? walkthroughEstimator(visit) : handoffSigner(job);
    if (repRan) { /* the rep is the signer: no estimator share to attribute */ }
    else if (!recordedEstimator && signer) Object.assign(result, { estimatorKey: signer, estimatorEvidence: online ? 'walkthrough_estimator' : 'handoff_signer' });
    else if (recordedEstimator && signer && signer !== recordedEstimator && bridgeEstimator(record) && !record.estimatorClassifiedAt) result.reviewReasons.push('estimator_attribution_conflict');
  }
  // ONLINE-APPROVAL: approved more than ONLINE_APPROVAL_DAYS after the walkthrough pays nothing, and says why.
  const window = online ? approvalWindow(visit, job) : 'signed';
  if (window === 'after') return { ...result, state: 'excluded', earnedCommission: 0, payableCommission: 0, reviewReasons: ['approved_after_30_days'] };
  if (window === 'unverified') result.reviewReasons.push('walkthrough_date_unverified');
  const direct = directSales.find(sale => sale.handoff?.job?.ref === job.id);
  result.directSaleRepKey = direct?.repKey || null;
  if (direct) result.reviewReasons.push('direct_close_attribution_conflict');
  if (classification !== 'garage') result.reviewReasons.push('service_scope_unverified');
  // knock-setter-v2 decides a cancellation by when it came (completionEarning); v1 holds every one.
  if (v1 && ['cancelled', 'canceled', 'no_show'].includes(job.pipelineStatus || job.status)) result.reviewReasons.push('cancellation_review');
  const evidence = collectionEvidence(job);
  if (!evidence) return { ...result, state: 'awaiting_close' };
  const allocation = repRan
    ? commissionAllocations({ channel: 'direct_sale', jobId: job.id, serviceClassification: classification, directRepKey: record.setterKey, ...approvedBase(terms, evidence) })
    : commissionAllocations({ channel: 'appointment_setter', jobId: job.id, serviceClassification: classification,
      setterKey: record.setterKey, estimatorKey: result.estimatorKey || '', directRepKey: result.directSaleRepKey || '', ...approvedBase(terms, evidence) });
  // A cancelled job projects nothing: it cannot be earned while it stays cancelled.
  if (approved) Object.assign(result, { allocations: allocation.allocations, projectedCommission: result.reviewReasons.includes('cancellation_review') ? null : centsToDollars(allocation.allocations.find(item => item.role === ownRole)?.amountCents) });
  const floors = [record.recordedAt, record.classifiedAt, record.estimatorClassifiedAt];
  if (!v1) return completionProjection(result, { job, evidence, allocation, terms, floors, ownRole, nowMs,
    unapproved: { allocations: allocation.allocations, reviewReasons: [...allocation.reviewReasons, 'payroll_anchor_unconfigured'] } });
  if (!evidence.verified) result.reviewReasons.push('collection_unverified');
  if (evidence.collected !== null) result.customerCollectedRevenue = evidence.collected;
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

// The setter policy a view reports: the fixed rates, and whether the owner approved them (knock-access.js setterTermsState)
// under which contract (a knock-setter-v1 approval keeps its own trigger and its refund holds).
export const setterPolicyFor = terms => terms?.verified !== true ? setterPolicy : earlierRules(terms)
  ? { ...setterPolicy, earningTrigger: 'closed_and_collected', approval: 'approved', contract: terms.contract, approvedAt: terms.approvedAt, gaps: ['partial_collections', 'refund_clawbacks'] }
  : { ...setterPolicy, approval: 'approved', contract: terms.contract ?? null, approvedAt: terms.approvedAt, gaps: ['partial_collections'] };

/* The door sales the office linked to these jobs (knock_sales handoff.job.ref, the direct_close_attribution_conflict
   evidence): one query per 30 job ids, never every sale. */
export async function directSalesFor(store, jobIds) {
  const ids = [...new Set(jobIds.filter(id => ID.test(String(id || ''))))], sales = [];
  for (let at = 0; at < ids.length; at += 30) sales.push(...await store.query('knock_sales', { where: [['handoff.job.ref', 'in', ids.slice(at, at + 30)]], select: ['repKey', 'handoff.job.ref'] }));
  return sales;
}

/* Setter records as money, at most `limit` of them (truncated says more exist). Each reads its walkthrough and, once
   converted, its job (masked; setterJobReader, or readJobs: the whole page in batches, setterBatchReaderFor), and the
   door sales linked to those jobs. Under knock-setter-v2 a walkthrough that never converted is matched to the quote
   saved from it and approved (the reader's quoteJobs; approvedWalkthroughQuote; more than one is held). `rows`
   projects the given records instead of reading them. A record whose source cannot be read is 'source_unavailable'. */
const quoteFor = (jobs = [], visitId) => {
  const approved = jobs.filter(job => job?.sourceWalkthroughId === visitId && approvedWalkthroughQuote(job));
  return approved.length > 1 ? { type: 'job', sourceWalkthroughId: visitId, ambiguous: true } : approved[0] || null;
};
export async function setterAttributions(store, env, { repKey = null, nowMs = Date.now(), readJob = null, readJobs = null, terms = null, limit = 100, rows: given = null } = {}) {
  const rows = given || (repKey ? await store.query('knock_setters', { where: [['setterKey', '==', repKey]] }) : await store.list('knock_setters'));
  const policy = setterPolicyFor(terms);
  if (!rows.length) return { rows: [], truncated: false, policy };
  const page = rows.slice(0, limit), open = visit => visit && !ID.test(String(visit.convertedJobId || ''));
  let read = readJob || (readJobs ? null : setterJobReader(env)), quotes = earlierRules(terms) ? null : (read || readJobs)?.quoteJobs || null;
  if (!read) {
    try {
      const visits = await readJobs(page.map(row => row.walkthroughId)), jobs = await readJobs([...visits.values()].map(visit => visit.convertedJobId));
      const saved = quotes ? await quotes([...visits.values()].filter(open).map(visit => visit.id)) : new Map();
      read = async id => visits.get(id) || jobs.get(id) || null;
      quotes = async ids => new Map(ids.map(id => [id, saved.get(id) || []]));
    } catch { read = async () => { throw new Error('source_unavailable'); }; }
  }
  const sources = await Promise.all(page.map(async row => {
    try {
      const visit = await read(row.walkthroughId);
      return { row, visit, job: ID.test(String(visit?.convertedJobId || '')) ? await read(visit.convertedJobId) : open(visit) && quotes ? quoteFor((await quotes([visit.id])).get(visit.id), visit.id) : null };
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
