/* ESTIMATOR-COMMISSION (owner decision D6b, 2026-10-17): the estimator's 7%, as a projection, an office view
   (Knock Admin > Estimators, GET /api/knock-admin?view=estimators), the estimator's own read-only view (Hub > My
   commission, GET /api/estimator-commission) and, once the owner approved the setter terms (knock-admin.js
   approveSetterTerms, crew/knock-money.js SETTER_TERMS), the earned shares in the commission statement (periodStatement
   channels, Admin > Money and its CSV).
   Each signed walkthrough job pays its estimator once, never stacked:
     - a walkthrough a door-to-door rep set (knock_setters) pays through its setter record: 13% to the rep, 7% to the
       estimator the record names (the bridge's or the office's), else the handoff's signer (knock-setters.js);
     - any other signed walkthrough (walkthroughHandoffs, walkthrough-handoff.js) is the estimator's direct sale: 7% to
       the employee who recorded the customer's signature (acceptance.recordedBy), unless the office linked a door sale
       to the job (direct_close_attribution_conflict: the 25% and the 7% never stack).
   Both use the same evidence (knock-setters.js collectionEvidence): the job closed (accepted estimate) and paid in full
   with verified receipts, on its whole price including goods, rounded to the cent; garage work by its signed lines or
   scope (signedGarageHandoff) or the office's classification (estimator.classify; setter.classify for a setter record).
   Under knock-setter-v2 (owner decision 2026-10-30) a share is earned on the day the job is completed once it is paid
   in full, a refund or cancellation after that takes its share back on the next pay period's statement (clawbacks),
   and a quote saved from the walkthrough and approved within 30 days of it pays as if signed there: 7% to the employee
   who did the walkthrough (knock-setters.js walkthroughEstimator), never whoever recorded or sent the quote; approved
   later it pays nothing. A knock-setter-v1 approval keeps its own rules until the owner approves v2.
   Before the owner's approval every row says so (commission_terms_unapproved, or the setter record's own holds) and
   shows no amount. Reads are bounded: one estimator's signed receipts (actorId) and setter records, or, for the office
   and the statement, the receipts and setter records made in the CHANNEL_LOOKBACK_DAYS before the pay period (the same
   bound the estimator's own view holds an older source to, statement_lookback_exceeded), their jobs (masked, in
   batches), the door sales linked to those jobs and the office's classifications of unclassified direct sales. Never a
   customer contact detail or another person's pay to an estimator. */
import { CHANNEL_LOOKBACK_DAYS, CHANNEL_PERCENTS, payPeriodFor } from '../../crew/knock-money.js';
import { addDays, zonedDate } from '../../crew/knock-time.js';
import { knockFailure, write } from './knock-store.js';
import { dispatchStorage } from './dispatch-storage.js';
import { commissionAllocations } from './knock-allocations.js';
import { SETTER_JOB_FIELDS, adjustmentHold, approvalWindow, approvedBase, approvedGarageQuote, approvedWalkthroughQuote, centsToDollars, collectionEvidence, completionProjection, directSalesFor, earlierRules,
  earnedFloor, earnedTime, handoffSigner, qualifyingCollection, setterAttributions, setterBatchReaderFor, signedGarageHandoff, underEarlierTerms, walkthroughEstimator } from './knock-setters.js';

export const ESTIMATOR_LOOKBACK_DAYS = CHANNEL_LOOKBACK_DAYS;
// Setter records a statement or the office view projects (each reads its walkthrough and job); the rest hold their
// recipients' statements (setter_records_truncated), never everyone's.
export const ESTIMATOR_SETTER_LIMIT = 500;
const ID = /^[A-Za-z0-9_-]{1,120}$/, BATCH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE = CHANNEL_PERCENTS.estimator / 100;
const CANCELLED = ['cancelled', 'canceled', 'no_show'];

/** A walkthrough the estimator sold directly (no setter record), as money: the 7% direct-estimator channel. office is the
 * office's classification of the job (knock_estimator_jobs, estimator.classify), directSale a door sale the office linked
 * to it, signedAt the newest signed-handoff receipt (the source a statement's lookback counts from; for a quote approved
 * online, its approval). visit: the walkthrough of a quote saved from it and approved (knock-setter-v2, ONLINE-APPROVAL),
 * whose estimator and date it pays by. */
export function projectEstimatorJob(job, { terms = null, nowMs = Date.now(), office = null, directSale = null, signedAt = null, visit = null } = {}) {
  const earlier = underEarlierTerms(terms, legacy => projectEstimatorJob(job, { terms: legacy, nowMs, office, directSale, signedAt, visit }));
  if (earlier) return earlier;
  const approved = terms?.verified === true, v1 = earlierRules(terms), online = approvedWalkthroughQuote(job);
  const estimatorKey = online ? walkthroughEstimator(visit) : handoffSigner(job);
  const result = { id: `${job?.id}:direct_estimator`, jobId: job?.id || null, walkthroughId: job?.sourceWalkthroughId || null, jobDate: typeof job?.date === 'string' ? job.date : null,
    channel: 'direct_estimator', estimatorKey: estimatorKey || null, estimatorEvidence: estimatorKey ? online ? 'walkthrough_estimator' : 'handoff_signer' : 'unverified', state: 'awaiting_close', rate: RATE,
    customerCollectedRevenue: null, qualifyingAt: null, earnedAt: null, projectedCommission: null, earnedCommission: null, payableCommission: null, reviewReasons: [], settlement: 'not_reconciled',
    ...(approved ? { signedAt } : {}), ...(online ? { closedBy: 'approved_quote' } : {}) };
  if (!job || job.type !== 'job' || !job.revision || !ID.test(String(job.sourceWalkthroughId || ''))) return { ...result, state: 'review_required', reviewReasons: ['conversion_link_unverified'] };
  // Only a signed handoff paid under knock-setter-v1.
  if (online && v1) return result;
  if (online && (visit?.id !== job.sourceWalkthroughId || visit.type !== 'walkthrough')) return { ...result, state: 'review_required', reviewReasons: ['walkthrough_unverified'] };
  const officeClass = ['garage', 'junk_removal'].includes(office?.serviceClassification) ? office.serviceClassification : null;
  if (officeClass === 'junk_removal') return { ...result, serviceClassification: 'junk_removal', state: 'excluded', earnedCommission: 0, payableCommission: 0 };
  // Approved more than 30 days after the walkthrough: no commission, and why.
  const window = online ? approvalWindow(visit, job) : 'signed';
  if (window === 'after') return { ...result, state: 'excluded', earnedCommission: 0, payableCommission: 0, reviewReasons: ['approved_after_30_days'] };
  if (window === 'unverified') result.reviewReasons.push('walkthrough_date_unverified');
  const classification = officeClass || ((online ? approvedGarageQuote(job) : signedGarageHandoff(job)) ? 'garage' : 'unverified');
  if (classification !== 'garage') result.reviewReasons.push('service_scope_unverified');
  if (directSale) Object.assign(result, { directSaleRepKey: directSale.repKey || null }).reviewReasons.push('direct_close_attribution_conflict');
  // knock-setter-v2 decides a cancellation by when it came (knock-setters.js completionEarning); v1 holds every one.
  if (v1 && CANCELLED.includes(job.pipelineStatus || job.status)) result.reviewReasons.push('cancellation_review');
  const evidence = collectionEvidence(job);
  if (!evidence) return { ...result, state: 'awaiting_close' };
  const allocation = commissionAllocations({ channel: 'direct_estimator', jobId: job.id, serviceClassification: classification, estimatorKey, ...approvedBase(terms, evidence) });
  // A cancelled job projects nothing: it cannot be earned while it stays cancelled.
  if (approved && !result.reviewReasons.includes('cancellation_review')) result.projectedCommission = centsToDollars(allocation.allocations[0]?.amountCents);
  if (!v1) return completionProjection(result, { job, evidence, allocation, terms, floors: [officeClass ? office.classifiedAt : null], ownRole: 'estimator', nowMs, unapproved: { reviewReasons: ['commission_terms_unapproved'] } });
  if (!evidence.verified) result.reviewReasons.push('collection_unverified');
  if (evidence.collected !== null) result.customerCollectedRevenue = evidence.collected;
  const floor = officeClass ? office.classifiedAt : null;
  if (result.reviewReasons.length) {
    const adjustment = approved ? adjustmentHold(job, evidence, result.reviewReasons, earnedFloor(terms, floor), nowMs) : null;
    return { ...result, state: 'review_required', ...(adjustment ? { adjustment } : {}) };
  }
  const qualified = qualifyingCollection(evidence, nowMs);
  if (qualified.state !== 'qualified') return { ...result, state: qualified.state, reviewReasons: qualified.reviewReasons };
  const qualifyingAt = new Date(qualified.at).toISOString();
  if (!approved) return { ...result, state: 'review_required', qualifyingAt, reviewReasons: ['commission_terms_unapproved'] };
  if (allocation.state !== 'calculated') return { ...result, state: 'review_required', qualifyingAt, reviewReasons: allocation.reviewReasons };
  const earned = centsToDollars(allocation.allocations[0].amountCents);
  return { ...result, state: 'earned', qualifyingAt, earnedAt: earnedTime(qualified.at, terms, floor), earnedCommission: earned, payableCommission: earned };
}

/** The estimator's row of a projected setter record (knock-setters.js projectSetterAttribution): its 7% allocation only,
 * never the setter's share. */
export function estimatorShare(row) {
  const share = (Array.isArray(row?.allocations) ? row.allocations : []).find(item => item?.role === 'estimator');
  const amount = centsToDollars(share?.amountCents), reasons = row.reviewReasons || [], mine = (row.clawbacks || []).filter(line => line.role === 'estimator');
  return { id: share?.id || `${row.walkthroughId}:appointment_setter:estimator`, jobId: row.jobId || null, walkthroughId: row.walkthroughId, jobDate: row.jobDate ?? null,
    channel: 'appointment_setter', estimatorKey: row.estimatorKey || null, estimatorEvidence: row.estimatorEvidence || 'unverified', setterKey: row.setterKey || null,
    state: row.state, rate: RATE, customerCollectedRevenue: row.customerCollectedRevenue ?? null, qualifyingAt: row.qualifyingAt ?? null, earnedAt: row.earnedAt ?? null,
    projectedCommission: reasons.includes('cancellation_review') || row.state === 'cancelled' ? null : amount, earnedCommission: row.state === 'earned' ? amount : row.earnedCommission === 0 ? 0 : null,
    payableCommission: row.state === 'earned' ? amount : row.payableCommission === 0 ? 0 : null, reviewReasons: reasons, settlement: 'not_reconciled',
    ...(row.recordedAt !== undefined ? { recordedAt: row.recordedAt } : {}), ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(mine.length ? { clawbacks: mine, clawedBackCommission: mine.reduce((sum, line) => sum + line.amountCents, 0) / 100 } : {}) };
}

// The signed walkthrough jobs behind the receipts a ledger query returns (each job once; masked, in batches), each with
// its newest receipt's time (signedAt).
async function signedJobs(dispatch, spec, signer) {
  const receipts = (await dispatch.handoffLedger(spec)).filter(row => row.kind === undefined && ID.test(String(row.jobId || '')) && ID.test(String(row.sourceWalkthroughId || '')));
  const signedAt = new Map();
  for (const row of receipts) if (typeof row.createdAt === 'string' && !(signedAt.get(row.jobId) >= row.createdAt)) signedAt.set(row.jobId, row.createdAt);
  const ids = [...new Set(receipts.map(row => row.jobId))], jobs = [];
  for (let at = 0; at < ids.length; at += BATCH) jobs.push(...await dispatch.readMany('jobs', ids.slice(at, at + BATCH), [...SETTER_JOB_FIELDS]));
  return jobs.filter(job => job.type === 'job' && ID.test(String(job.sourceWalkthroughId || '')) && (!signer || handoffSigner(job) === signer))
    .map(job => ({ job, signedAt: signedAt.get(job.id) || null }));
}

/* ONLINE-APPROVAL (knock-setter-v2): the quotes saved from a walkthrough and approved since `since` (one range on the
   approval time), with their walkthroughs (masked, in batches) and the approval as their source time (signedAt); a job
   in `skip` (signed) is left out; with signer, only the walkthroughs that employee did. */
async function approvedQuotes(dispatch, since, skip, signer) {
  if (typeof dispatch.approvedJobsSince !== 'function') return [];
  const jobs = (await dispatch.approvedJobsSince(String(since || ''), [...SETTER_JOB_FIELDS])).filter(job => approvedWalkthroughQuote(job) && !skip.has(job.id));
  const ids = [...new Set(jobs.map(job => job.sourceWalkthroughId))], visits = new Map();
  for (let at = 0; at < ids.length; at += BATCH) for (const visit of await dispatch.readMany('jobs', ids.slice(at, at + BATCH), [...SETTER_JOB_FIELDS])) visits.set(visit.id, visit);
  return jobs.map(job => ({ job, visit: visits.get(job.sourceWalkthroughId) || null, signedAt: job.customerApproval.approvedAt }))
    .filter(({ visit }) => !signer || walkthroughEstimator(visit) === signer);
}

const byId = rows => [...new Map(rows.map(row => [row.id, row])).values()];

/** The estimator 7% rows: one estimator's (estimatorKey, the staff key, and actorId, the Hub sign-in their receipts carry)
 * or every estimator's (since: receipts created and setter records made on or after that date, plus any older setter
 * record behind a job signed since then). Answers {rows, setters, truncated, overflow}: rows are estimator rows,
 * setters the projected setter records they came from (the office and statements use both shares), overflow the setter
 * records past setterLimit that were not projected. An estimator's own rows leave out a share the Knock bridge booked
 * them for that another employee signed (estimator_attribution_conflict): it is not theirs until the office settles it. */
export async function estimatorLedger({ kstore, dispatch, env = {}, estimatorKey = null, actorId = null, since = null, terms = null, nowMs = Date.now(), readJob = null, setterLimit = ESTIMATOR_SETTER_LIMIT } = {}) {
  const signer = estimatorKey ? String(estimatorKey).trim().toLowerCase() : '';
  const signedOnly = await signedJobs(dispatch, signer ? { field: 'actorId', op: 'EQUAL', value: String(actorId || estimatorKey) } : { field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: String(since || '') }, signer);
  // ONLINE-APPROVAL: never under a knock-setter-v1 approval. One estimator's own view reads the approvals of the year a
  // statement could still count (CHANNEL_LOOKBACK_DAYS before the longest pay period).
  const quotes = earlierRules(terms) ? [] : await approvedQuotes(dispatch, signer ? addDays(zonedDate(nowMs), -(ESTIMATOR_LOOKBACK_DAYS + 31)) : since, new Set(signedOnly.map(({ job }) => job.id)), signer);
  const signed = [...signedOnly, ...quotes];
  const walkthroughs = [...new Set(signed.map(({ job }) => job.sourceWalkthroughId))];
  let records;
  if (signer) {
    const [mine, linked] = await Promise.all([kstore.query('knock_setters', { where: [['estimatorKey', '==', signer]] }), walkthroughs.length ? kstore.getMany('knock_setters', walkthroughs) : new Map()]);
    records = byId([...mine, ...linked.values()]);
  } else {
    const recent = await kstore.query('knock_setters', { where: [['recordedAt', '>=', String(since || '')]], orderBy: [['recordedAt', 'ASCENDING']] });
    const known = new Set(recent.map(row => row.walkthroughId)), older = walkthroughs.filter(id => !known.has(id));
    const linked = older.length ? await kstore.getMany('knock_setters', older) : new Map();
    // Newest first: past the limit, the oldest records are the ones left unread.
    records = byId([...recent, ...linked.values()]).sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')));
  }
  const viaSetter = new Set(records.map(row => row.walkthroughId)), direct = signed.filter(({ job }) => !viaSetter.has(job.sourceWalkthroughId));
  const unclassified = direct.filter(({ job }) => !signedGarageHandoff(job) && !approvedGarageQuote(job)).map(({ job }) => job.id);
  const [offices, sales, setters] = await Promise.all([unclassified.length ? kstore.getMany('knock_estimator_jobs', unclassified) : new Map(), directSalesFor(kstore, direct.map(({ job }) => job.id)),
    setterAttributions(kstore, env, { rows: records, terms, nowMs, limit: setterLimit, ...(readJob ? { readJob } : { readJobs: setterBatchReaderFor(dispatch) }) })]);
  const saleFor = new Map(sales.map(sale => [sale.handoff?.job?.ref, sale]));
  // REP-WALKTHROUGH: a walkthrough the rep ran and signed (channel direct_sale) has no estimator share at all.
  const shares = setters.rows.filter(row => row.channel !== 'direct_sale').map(estimatorShare).filter(row => !signer || row.estimatorKey === signer && !row.reviewReasons.includes('estimator_attribution_conflict'));
  const directRows = direct.map(({ job, signedAt, visit = null }) => projectEstimatorJob(job, { terms, nowMs, office: offices.get(job.id) || null, directSale: saleFor.get(job.id) || null, signedAt, visit }));
  return { rows: [...shares, ...directRows], setters, truncated: setters.truncated, overflow: records.slice(setterLimit) };
}

/** What earned setter and estimator shares add to a commission statement (periodStatement channels, channelHolds and
 * channelReview), from projected setter rows, direct estimator rows and the setter records left unread:
 *  - items: each earned share, by its share (jobId:role, the same for a job's estimator on either channel) and source time;
 *    and, under knock-setter-v2, each share a refund or cancellation took back after it was earned (kind 'clawback', a
 *    negative amount by its own share key, counted on the first day of the pay period after the refund or cancellation,
 *    by `payroll`, the approved pay cycle; ref, reason and eventDate keep its evidence);
 *  - holds: the recipients of a share held after money was collected (adjustmentHold), and of a setter record that was
 *    not read (setter_records_truncated, setter_source_unavailable);
 *  - review: reasons that hold every row: a record that was not read and names no estimator (its signer is unknown). */
export function channelLedger({ setters = { rows: [] }, rows = [], overflow = [], payroll = null } = {}) {
  const items = [], holds = [], review = new Set();
  const sourceMs = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const nextPeriod = at => { const period = payPeriodFor(zonedDate(Date.parse(at)), payroll), next = period && payPeriodFor(addDays(period.end, 1), payroll); return next ? Date.parse(`${next.start}T12:00:00Z`) : NaN; };
  const clawback = (line, sourceAt) => items.push({ id: line.id, share: `${line.jobId}:${line.role}:clawback:${line.reason}:${Date.parse(line.at)}`, repKey: line.repKey, role: line.role, amount: -line.amountCents / 100,
    earnedAt: nextPeriod(line.at), sourceAt, kind: 'clawback', reason: line.reason, eventDate: zonedDate(Date.parse(line.at)), ref: `job:${line.jobId}:${line.role}` });
  const hold = (keys, extra) => { for (const repKey of new Set(keys.filter(key => typeof key === 'string' && key))) holds.push({ repKey, ...extra }); };
  const unread = (row, reason) => { const estimator = String(row.estimatorKey || '').trim().toLowerCase(); if (estimator) hold([row.setterKey, estimator], { reasons: [reason], all: true }); else review.add(reason); };
  for (const row of setters.rows || []) {
    if (row.state === 'earned') for (const share of row.allocations) items.push({ id: share.id, share: `${row.jobId}:${share.role}`, repKey: share.repKey, role: share.role, amount: share.amountCents / 100, earnedAt: Date.parse(row.earnedAt), sourceAt: sourceMs(row.recordedAt) });
    if (row.state === 'earned') for (const line of row.clawbacks || []) clawback(line, sourceMs(row.recordedAt));
    if (row.adjustment) hold((row.allocations || []).map(share => share.repKey), row.adjustment);
    if ((row.reviewReasons || []).includes('source_unavailable')) unread(row, 'setter_source_unavailable');
  }
  for (const row of rows) if (row.channel === 'direct_estimator') {
    if (row.state === 'earned') items.push({ id: row.id, share: `${row.jobId}:estimator`, repKey: row.estimatorKey, role: 'estimator', amount: row.earnedCommission, earnedAt: Date.parse(row.earnedAt), sourceAt: sourceMs(row.signedAt) });
    if (row.state === 'earned') for (const line of row.clawbacks || []) clawback(line, sourceMs(row.signedAt));
    if (row.adjustment) hold([row.estimatorKey], row.adjustment);
  }
  for (const record of overflow) unread(record, 'setter_records_truncated');
  return { items, holds, review: [...review] };
}

/** The earned setter and estimator shares a commission statement adds (channelLedger: {items, holds, review}), once the
 * owner approved the setter terms; null before. payroll: the approved pay cycle a share taken back is counted by. */
export async function channelEarnings({ kstore, dispatch, env = {}, terms, nowMs = Date.now(), period, readJob = null, payroll = null }) {
  if (terms?.verified !== true) return null;
  return channelLedger({ ...await estimatorLedger({ kstore, dispatch, env, since: addDays(period.start, -ESTIMATOR_LOOKBACK_DAYS), terms, nowMs, readJob }), payroll });
}

/** One estimator's own read-only view (GET /api/estimator-commission): their 7% rows, newest job first, with no setter,
 * customer or other employee named; totals of what is projected (closed, not yet earned) and earned. With payroll (the
 * pay cycle), an earned share whose source is older than the statement of its pay period reads (CHANNEL_LOOKBACK_DAYS)
 * is held (statement_lookback_exceeded), as the statement leaves it out: the two never disagree. */
export function estimatorView(ledger, terms, { payroll = null } = {}) {
  const windowStart = earnedAt => { const period = payPeriodFor(zonedDate(Date.parse(earnedAt)), payroll); return period ? Date.parse(addDays(period.start, -ESTIMATOR_LOOKBACK_DAYS)) : NaN; };
  const outside = row => Boolean(payroll) && row.state === 'earned' && !(Date.parse(row.channel === 'direct_estimator' ? row.signedAt : row.recordedAt) >= windowStart(row.earnedAt));
  const rows = ledger.rows.map(row => outside(row) ? { ...row, state: 'review_required', earnedCommission: null, payableCommission: null, reviewReasons: [...row.reviewReasons, 'statement_lookback_exceeded'] } : row)
    .map(row => ({ id: row.id, jobId: row.jobId, jobDate: row.jobDate, channel: row.channel === 'direct_estimator' ? 'direct' : 'door_to_door',
      state: row.state, rate: row.rate, projectedCommission: row.projectedCommission, earnedCommission: row.earnedCommission, earnedAt: row.earnedAt, reviewReasons: row.reviewReasons,
      // knock-setter-v2: what a refund or cancellation after it was earned took back from this share (their own lines).
      ...(Number.isFinite(row.clawedBackCommission) && row.clawedBackCommission > 0 ? { clawedBackCommission: row.clawedBackCommission } : {}) }))
    .sort((a, b) => String(b.jobDate || '').localeCompare(String(a.jobDate || '')) || String(a.id).localeCompare(String(b.id)));
  const sum = values => Math.round(values.reduce((total, value) => total + value * 100, 0)) / 100;
  return { terms: { verified: terms?.verified === true, approvedAt: terms?.approvedAt || null, percent: CHANNEL_PERCENTS.estimator },
    rows, totals: { projected: sum(rows.filter(row => row.state !== 'earned' && Number.isFinite(row.projectedCommission)).map(row => row.projectedCommission)),
      earned: sum(rows.filter(row => row.state === 'earned').map(row => row.earnedCommission)) }, truncated: ledger.truncated };
}

/** estimator.classify: the office settles whether a direct walkthrough sale (no setter record) is garage work or junk
 * removal (which earns nothing), with its review reference, when its signed handoff does not show garage work
 * (signedGarageHandoff). Recorded once per job in knock_estimator_jobs; a different later answer is refused (409, finance
 * reviews it). Under the approved terms a share it settles is earned no earlier than this (earnedFloor). Idempotent on
 * requestId. Body: { requestId, jobId, serviceClassification: 'garage'|'junk_removal', classificationReference }. */
export async function classifyEstimatorJob(store, admin, body, nowIso, env = {}, { dispatch = dispatchStorage } = {}) {
  const { requestId, jobId, serviceClassification } = body || {};
  if (!UUID.test(String(requestId || '')) || !ID.test(String(jobId || ''))) throw knockFailure('Choose a valid job and request id.', 400, 'knock_estimator_invalid');
  const classificationReference = String(body.classificationReference || '').trim();
  if (!['garage', 'junk_removal'].includes(serviceClassification) || !classificationReference || classificationReference.length > 120) throw knockFailure('Choose garage work or junk removal, with its review reference.', 400, 'knock_estimator_scope');
  const change = { jobId, serviceClassification, classificationReference }, receiptId = `estimator_classify_${requestId.toLowerCase()}`;
  const conflict = () => knockFailure('This job already has a different classification. Finance must review it; nothing was changed.', 409, 'knock_estimator_conflict');
  const same = row => Object.keys(change).every(key => row?.[key] === change[key]);
  const replay = async () => {
    const receipt = await store.get('knock_receipts', receiptId);
    if (!receipt) return null;
    if (receipt.kind !== 'estimator_classification' || !same(receipt)) throw conflict();
    return { duplicate: true, classification: await store.get('knock_estimator_jobs', jobId) };
  };
  const prior = await replay();
  if (prior) return prior;
  const [job] = await dispatch(env).readMany('jobs', [jobId], [...SETTER_JOB_FIELDS]);
  if (!job || job.id !== jobId || job.type !== 'job' || !job.revision || !ID.test(String(job.sourceWalkthroughId || ''))) throw knockFailure('That job is not a signed walkthrough sale.', 409, 'knock_estimator_job');
  if (await store.get('knock_setters', job.sourceWalkthroughId)) throw knockFailure('A door-to-door rep set this walkthrough: classify it in Setters.', 409, 'knock_estimator_setter');
  const existing = await store.get('knock_estimator_jobs', jobId);
  if (existing && !same(existing)) throw conflict();
  const row = { jobId, walkthroughId: job.sourceWalkthroughId, serviceClassification, classificationReference, classifiedBy: admin.user, classifiedAt: nowIso, requestId };
  try {
    await store.commit([...(existing ? [] : [write.create('knock_estimator_jobs', jobId, row)]),
      write.create('knock_receipts', receiptId, { kind: 'estimator_classification', ...change, recordedBy: admin.user, recordedAt: nowIso })]);
  } catch (error) {
    const replayed = await replay();
    if (replayed) return replayed;
    const saved = await store.get('knock_estimator_jobs', jobId);
    if (saved && !same(saved)) throw conflict();
    throw error;
  }
  const { __updateTime, ...saved } = existing || { ...row, id: jobId };
  return { duplicate: Boolean(existing), classification: { ...saved, id: jobId } };
}
