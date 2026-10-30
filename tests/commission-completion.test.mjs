// Owner decisions 2026-10-30 (issue #311): a commission share is earned when the job is completed (America/Denver
// completion day, once paid in full); a refund or cancellation after that takes its share back on the next pay period's
// statement, never more than was earned; a quote saved from a walkthrough and approved within 30 days of it pays exactly
// as if signed there (its estimator is whoever did the walkthrough); Job actuals deducts only what will be paid. The
// rates never change (25% door sale, 13% setter + 7% estimator, 7% direct estimator, a rep-run walkthrough 25% only).
// Earlier approvals keep their own rules: knock-setter-v1 and knock-collected-v3. Synthetic data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETED_V4_POLICY, DOOR_CONTRACT, SETTER_CONTRACT, SETTER_CONTRACT_V1, SETTER_TERMS, SETTER_TERMS_V1, commissionCsv, commissionIssues, earnedAt, periodStatement, saleClawbacks, snapshotCommissionTerms } from '../crew/knock-money.js';
import { approvalWindow, completionEarning, projectSetterAttribution, refundEvents, repRanWalkthrough } from '../functions/_lib/knock-setters.js';
import { channelLedger, estimatorLedger, projectEstimatorJob } from '../functions/_lib/estimator-commission.js';
import { loadSettings, loadSetterTerms, setterTermsState } from '../functions/_lib/knock-access.js';
import { approveSetterTerms } from '../functions/_lib/knock-admin.js';
import { createKnockStore } from '../functions/_lib/knock-store.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { jobActualsHandlers } from '../functions/api/job-actuals.js';
import { channelOf } from '../functions/_lib/job-actuals.js';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { approvedKnockSettings, call, cookieFor, get, knockEnv, post, uuid } from './helpers/knock-fixture.mjs';

const NOW = Date.parse('2026-11-20T18:00:00Z'), APPROVED_AT = '2026-10-01T16:00:00.000Z';
const TERMS = { verified: true, approvedAt: APPROVED_AT, reference: 'synthetic-terms', contract: SETTER_CONTRACT };
const SETTINGS = { commission: { verified: true }, payroll: {} };
// The default two-week cycle (anchor 2026-10-05): P1 Oct 19 - Nov 1, P2 Nov 2 - 15, P3 Nov 16 - 29.
const P1 = { key: '2026-10-19_2026-11-01', start: '2026-10-19', end: '2026-11-01' }, P2 = { key: '2026-11-02_2026-11-15', start: '2026-11-02', end: '2026-11-15' }, P3 = { key: '2026-11-16_2026-11-29', start: '2026-11-16', end: '2026-11-29' };
const card = (id, amount, verifiedAt, purpose = 'balance') => ({ sessionId: `cs_test_${id}`, paymentIntentId: `pi_${id}`, amount, purpose, verifiedAt });
// A $3,000 garage job signed at the walkthrough on Oct 17: a $750 deposit that day, the $2,250 balance on the job day.
const job = (id = 'job-1', wid = 'walk-1', extra = {}) => ({ id, revision: 'r', type: 'job', status: 'scheduled', date: '2026-10-27', sourceWalkthroughId: wid,
  handoffVersion: 1, handoffRequestId: `req-${id}`, serviceType: 'Garage transformation', scope: { finish: ['cleanout'] },
  estimate: { status: 'accepted', amount: 3000, acceptedAt: '2026-10-17T15:00:00Z' }, acceptance: { recordedBy: 'Estimator.One', acceptedAt: '2026-10-17T14:55:00Z' },
  payment: { amount: 3000, verified: true, stripeSessions: [card(`${id}d`.replace(/-/g, ''), 750, '2026-10-17T15:05:00Z', 'deposit'), card(`${id}b`.replace(/-/g, ''), 2250, '2026-10-27T15:00:00Z')] }, ...extra });
const done = (at = '2026-10-27T22:00:00Z') => ({ status: 'completed', pipelineStatus: 'completed', completedAt: at });
const visit = (id = 'walk-1', extra = {}) => ({ id, revision: 'v', type: 'walkthrough', status: 'completed', convertedJobId: 'job-1', walkthroughOutcome: { outcome: 'sold_on_site' }, ...extra });
const setter = (wid = 'walk-1', extra = {}) => ({ id: wid, walkthroughId: wid, setterKey: 'rep.one', serviceClassification: 'garage', classificationReference: 'synthetic-review', estimatorKey: '', estimatorReference: '', channel: 'appointment_setter', recordedAt: '2026-10-10T18:00:00Z', ...extra });
const shares = row => (row.allocations || []).map(item => `${item.role}:${item.repKey}=${item.amountCents}`).join(' ');
// A quote saved from walkthrough `wid` (quote-draft.js) and approved in the portal on `approvedAt`, never signed on site.
const quoteJob = (id, wid, approvedAt = '2026-10-20T15:00:00Z', extra = {}) => {
  const base = job(id, wid, { ...done(), ...extra }); delete base.acceptance; delete base.handoffVersion; delete base.handoffRequestId;
  return { ...base, estimate: { status: 'approved', amount: 3000, acceptedAt: approvedAt }, customerApproval: { status: 'approved', approvedAt, source: 'customer_portal' },
    quoteDraft: { sourceWalkthroughId: wid, createdBy: 'Office.One', sentBy: 'Office.One', sentAt: '2026-10-18T15:00:00Z' } };
};
// The walkthrough a quote was saved from: finished on Oct 16 by `performer`, never converted (no signed handoff).
const quoteVisit = (id, performer = 'estimator.one', finishedAt = '2026-10-16T18:00:00Z') => ({ id, revision: 'v', type: 'walkthrough', status: 'completed', walkthroughCompletedAt: finishedAt,
  walkthroughOutcome: { outcome: 'quote_to_follow', performedBy: performer, finishedAt } });

test('earned on the job\'s completion day (America/Denver), once paid in full; the deposit alone reads "job not complete"', () => {
  // Deposit paid, job not done (decision 5: was held as partial_collection_policy_unconfigured).
  const deposit = job(); deposit.payment = { amount: 750, verified: true, stripeSessions: [deposit.payment.stripeSessions[0]] };
  const waiting = projectSetterAttribution(setter(), visit(), deposit, [], NOW, TERMS);
  assert.deepEqual([waiting.state, waiting.reviewReasons, waiting.earnedCommission, waiting.projectedCommission], ['awaiting_completion', ['job_not_complete'], null, 390]);
  // Paid in full before the job day: still not earned until the job is completed.
  assert.equal(projectSetterAttribution(setter(), visit(), job(), [], NOW, TERMS).state, 'awaiting_completion');
  // Completed after the balance was paid: earned at completion, in the pay period holding that day.
  const row = projectSetterAttribution(setter(), visit(), job('job-1', 'walk-1', done('2026-10-27T22:00:00Z')), [], NOW, TERMS);
  assert.deepEqual([row.state, row.earnedAt, row.completedAt, shares(row)], ['earned', '2026-10-27T22:00:00.000Z', '2026-10-27T22:00:00.000Z', 'setter:rep.one=39000 estimator:estimator.one=21000']);
  // Completed 10:30 pm Nov 1 in Denver (Nov 2 in UTC): Denver's day decides the pay period.
  const late = projectSetterAttribution(setter(), visit(), job('job-1', 'walk-1', done('2026-11-02T05:30:00Z')), [], NOW, TERMS);
  const items = channelLedger({ setters: { rows: [late] } }).items;
  const inP1 = periodStatement({ settings: SETTINGS, period: P1, now: NOW, channels: items }), inP2 = periodStatement({ settings: SETTINGS, period: P2, now: NOW, channels: items });
  assert.deepEqual([inP1.find(r => r.repKey === 'rep.one').setterCommission, inP2.find(r => r.repKey === 'rep.one')?.setterCommission ?? 0], [390, 0]);
  // Completed with a balance still due: held until it is paid, then earned on the later of the two.
  const unpaid = job('job-1', 'walk-1', done('2026-10-27T22:00:00Z')); unpaid.payment = { amount: 750, verified: true, stripeSessions: [unpaid.payment.stripeSessions[0]] };
  assert.deepEqual([projectSetterAttribution(setter(), visit(), unpaid, [], NOW, TERMS).state, projectSetterAttribution(setter(), visit(), unpaid, [], NOW, TERMS).reviewReasons], ['awaiting_collection', ['balance_due']]);
  unpaid.payment = { amount: 3000, verified: true, stripeSessions: [unpaid.payment.stripeSessions[0], card('late', 2250, '2026-11-04T16:00:00Z')] };
  assert.equal(projectSetterAttribution(setter(), visit(), unpaid, [], NOW, TERMS).earnedAt, '2026-11-04T16:00:00.000Z');
  // The direct estimator's 7% follows the same rule.
  const direct = projectEstimatorJob(job('job-1', 'walk-1', done('2026-10-27T22:00:00Z')), { terms: TERMS, nowMs: NOW });
  assert.deepEqual([direct.state, direct.earnedCommission, direct.earnedAt], ['earned', 210, '2026-10-27T22:00:00.000Z']);
  assert.equal(projectEstimatorJob(deposit, { terms: TERMS, nowMs: NOW }).state, 'awaiting_completion');
});

test('a refund or cancellation after a share was earned takes it back on the next pay period\'s statement, never more than was earned', () => {
  const earned = extra => job('job-1', 'walk-1', { ...done(), ...extra });
  // $500 refunded Oct 30 (P1): 13% and 7% of it ($65, $35) come off P2, with their evidence.
  const refund = projectSetterAttribution(setter(), visit(), earned({ refunds: [{ amount: 500, refundedAt: '2026-10-30T17:00:00Z' }] }), [], NOW, TERMS);
  assert.deepEqual([refund.state, refund.earnedCommission, refund.clawedBackCommission], ['earned', 390, 65]);
  assert.deepEqual(refund.clawbacks.map(line => [line.role, line.amountCents, line.reason, line.at]), [['setter', 6500, 'refund', '2026-10-30T17:00:00.000Z'], ['estimator', 3500, 'refund', '2026-10-30T17:00:00.000Z']]);
  const items = channelLedger({ setters: { rows: [refund] } }).items;
  assert.deepEqual(items.filter(item => item.kind === 'clawback').map(item => [item.repKey, item.amount, new Date(item.earnedAt).toISOString().slice(0, 10), item.eventDate]),
    [['rep.one', -65, '2026-11-02', '2026-10-30'], ['estimator.one', -35, '2026-11-02', '2026-10-30']]);
  // P1 pays the shares; P2 nets the refund against the rep's other earnings there ($100 on another job).
  const other = { id: 'other', share: 'job-2:setter', repKey: 'rep.one', role: 'setter', amount: 100, earnedAt: Date.parse('2026-11-05T18:00:00Z') };
  const p1 = periodStatement({ settings: SETTINGS, period: P1, now: NOW, channels: [...items, other] }).find(r => r.repKey === 'rep.one');
  const p2 = periodStatement({ settings: SETTINGS, period: P2, now: NOW, channels: [...items, other] }).find(r => r.repKey === 'rep.one');
  assert.deepEqual([p1.setterCommission, p1.clawback, p1.payableCommission], [390, 0, 390]);
  assert.deepEqual([p2.setterCommission, p2.clawback, p2.payableCommission, p2.compensationState, p2.clawbacks], [35, -65, 35, 'configured', [{ ref: 'job:job-1:setter', role: 'setter', reason: 'refund', amount: -65, eventDate: '2026-10-30' }]]);
  const [header, ...lines] = commissionCsv(periodStatement({ settings: SETTINGS, period: P2, now: NOW, channels: [...items, other] }), P2).trim().split('\r\n');
  assert.match(header, /,commission_clawback_included$/);
  assert.ok(lines.some(line => line.includes(',rep.one,') && line.endsWith(',-65.00')));
  // Two refunds, then the cancellation: the cancellation takes only what is left; the shares never go below zero.
  const both = projectSetterAttribution(setter(), visit(), earned({ status: 'cancelled', pipelineStatus: 'cancelled', cancelledAt: '2026-11-10T17:00:00Z',
    refunds: [{ amountCents: 100000, refundedAt: '2026-11-01T17:00:00Z' }, { amountCents: 50000, refundedAt: '2026-11-03T17:00:00Z' }] }), [], NOW, TERMS);
  const taken = role => both.clawbacks.filter(line => line.role === role).map(line => [line.reason, line.amountCents]);
  assert.deepEqual(taken('setter'), [['refund', 13000], ['refund', 6500], ['cancellation', 19500]]);
  assert.deepEqual(taken('estimator').reduce((sum, [, cents]) => sum + cents, 0), 21000);
  // A refund before the share was earned (the job not done yet) is held, as before.
  const early = projectSetterAttribution(setter(), visit(), earned({ refunds: [{ amount: 100, refundedAt: '2026-10-20T17:00:00Z' }] }), [], NOW, TERMS);
  assert.deepEqual([early.state, early.reviewReasons, early.earnedCommission], ['review_required', ['refund_review'], null]);
  assert.ok(early.adjustment, 'its recipients\' statements are held');
  // A refund with no time cannot be placed: held. Cancelled before it was completed and paid: never earned, nothing back.
  assert.deepEqual(projectSetterAttribution(setter(), visit(), earned({ payment: { ...job().payment, refundedAmount: 50 } }), [], NOW, TERMS).reviewReasons, ['refund_unverified']);
  assert.equal(refundEvents({ refunds: [{ amount: 5 }] }), null);
  const cancelled = projectSetterAttribution(setter(), visit(), job('job-1', 'walk-1', { status: 'cancelled', cancelledAt: '2026-10-20T17:00:00Z' }), [], NOW, TERMS);
  assert.deepEqual([cancelled.state, cancelled.earnedCommission, cancelled.projectedCommission, cancelled.clawbacks], ['cancelled', 0, null, undefined]);
  // A period with nothing else is held for finance rather than shown below zero.
  const alone = periodStatement({ settings: SETTINGS, period: P2, now: NOW, channels: items }).find(r => r.repKey === 'rep.one');
  assert.deepEqual([alone.compensationState, alone.payableCommission, alone.reviewReasons, alone.clawbacks.length], ['review_required', null, ['clawback_exceeds_earned'], 1]);
});

test('a quote saved from a walkthrough and approved within 30 days pays exactly as if signed there; later, or with no walkthrough, nothing', () => {
  // Rep-set: 13% to the rep, 7% to whoever did the walkthrough (never the office that recorded and sent the quote).
  const set = projectSetterAttribution(setter('walk-q'), quoteVisit('walk-q'), quoteJob('job-q', 'walk-q'), [], NOW, TERMS);
  assert.deepEqual([set.state, set.closedBy, set.estimatorEvidence, shares(set)], ['earned', 'approved_quote', 'walkthrough_estimator', 'setter:rep.one=39000 estimator:estimator.one=21000']);
  // A rep who ran it themselves at the door: 25% to them only.
  const self = projectSetterAttribution(setter('walk-s', { selfRun: true, repStaffKey: 'rep.one' }), quoteVisit('walk-s', 'rep.one'), quoteJob('job-s', 'walk-s'), [], NOW, TERMS);
  assert.deepEqual([self.channel, shares(self)], ['direct_sale', 'direct_rep:rep.one=75000']);
  assert.equal(repRanWalkthrough(setter('walk-s', { selfRun: true, repStaffKey: 'rep.one' }), quoteJob('job-s', 'walk-s'), quoteVisit('walk-s', 'estimator.two')), false, 'an estimator did it: 13% + 7%');
  // An estimator's own walkthrough: 7% to them.
  const direct = projectEstimatorJob(quoteJob('job-d', 'walk-d'), { terms: TERMS, nowMs: NOW, visit: quoteVisit('walk-d', 'estimator.two') });
  assert.deepEqual([direct.state, direct.estimatorKey, direct.earnedCommission], ['earned', 'estimator.two', 210]);
  // Day 30 still pays; day 31 pays nothing and says why.
  assert.equal(approvalWindow(quoteVisit('w'), quoteJob('j', 'w', '2026-11-15T15:00:00Z')), 'within');
  const late = projectSetterAttribution(setter('walk-l'), quoteVisit('walk-l'), quoteJob('job-l', 'walk-l', '2026-11-16T15:00:00Z'), [], NOW, TERMS);
  assert.deepEqual([late.state, late.earnedCommission, late.reviewReasons], ['excluded', 0, ['approved_after_30_days']]);
  assert.deepEqual(projectEstimatorJob(quoteJob('job-l', 'walk-l', '2026-11-16T15:00:00Z'), { terms: TERMS, nowMs: NOW, visit: quoteVisit('walk-l') }).reviewReasons, ['approved_after_30_days']);
  // A junk-only quote is not garage work; an approval nobody can date against its walkthrough is held.
  assert.ok(projectSetterAttribution(setter('walk-j', { serviceClassification: 'unverified' }), quoteVisit('walk-j'), quoteJob('job-j', 'walk-j', undefined, { serviceType: 'Junk removal' }), [], NOW, TERMS).reviewReasons.includes('service_scope_unverified'));
  assert.ok(projectSetterAttribution(setter('walk-u'), { ...quoteVisit('walk-u'), walkthroughCompletedAt: null, walkthroughOutcome: { outcome: 'quote_to_follow', performedBy: 'estimator.one' } }, quoteJob('job-u', 'walk-u'), [], NOW, TERMS).reviewReasons.includes('walkthrough_date_unverified'));
  // A web or phone lead with no walkthrough is not a walkthrough sale.
  assert.deepEqual(projectEstimatorJob({ ...quoteJob('job-w', 'x'), sourceWalkthroughId: '' }, { terms: TERMS, nowMs: NOW }).reviewReasons, ['conversion_link_unverified']);
  // The earlier knock-setter-v1 terms never paid an approved quote: they still do not.
  const v1 = { ...TERMS, contract: SETTER_CONTRACT_V1 };
  assert.deepEqual([projectSetterAttribution(setter('walk-q'), quoteVisit('walk-q'), quoteJob('job-q', 'walk-q'), [], NOW, v1).state, projectEstimatorJob(quoteJob('job-d', 'walk-d'), { terms: v1, nowMs: NOW, visit: quoteVisit('walk-d') }).state], ['awaiting_close', 'awaiting_close']);
});

const env = knockEnv({ HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Zac' }, 'Estimator.One': { passwordHash: 'test', role: 'sales', displayName: 'Estimator One' }, 'Office.One': { passwordHash: 'test', role: 'manager', displayName: 'Office One' } }) });
function world(seed = {}, approval = { contract: SETTER_CONTRACT, reference: 'synthetic-terms', reviewedBy: 'ZacB', reviewedAt: APPROVED_AT, terms: { ...SETTER_TERMS } }) {
  const fake = firestoreRest({
    'knock_settings/current': { ...approvedKnockSettings(), ...(approval ? { setterApproval: approval } : {}) },
    'knock_reps/rep.one': { repKey: 'rep.one', displayName: 'Rep One', status: 'active', role: 'knocker' },
    'knock_setters/walk-q': setter('walk-q'), 'jobs/walk-q': quoteVisit('walk-q'), 'jobs/job-q': quoteJob('job-q', 'walk-q'),
    'jobs/walk-d': quoteVisit('walk-d', 'estimator.one'), 'jobs/job-d': quoteJob('job-d', 'walk-d'),
    'jobs/walk-l': quoteVisit('walk-l', 'estimator.one', '2026-09-01T18:00:00Z'), 'jobs/job-l': quoteJob('job-l', 'walk-l'),
    // A web lead: approved online, no walkthrough at all.
    'jobs/job-w': { ...quoteJob('job-w', ''), sourceWalkthroughId: '', quoteDraft: { createdBy: 'Office.One' } },
    ...seed,
  });
  return { fake, knock: () => createKnockStore(env, fake.fetcher), dispatch: () => dispatchStorage(env, fake.fetcher) };
}

test('the ledgers find approved quotes by their walkthrough: Admin > Money pays them, the estimator\'s own view lists them, and the margin view deducts only what is paid', async () => {
  const w = world(), clock = () => new Date(NOW);
  const ledger = await estimatorLedger({ kstore: w.knock(), dispatch: w.dispatch(), env, since: '2025-11-01', terms: await loadSetterTerms(w.knock(), await loadSettings(w.knock())), nowMs: NOW });
  assert.deepEqual(ledger.rows.map(row => [row.jobId, row.channel, row.estimatorKey, row.state, row.earnedCommission]).sort(), [
    ['job-d', 'direct_estimator', 'estimator.one', 'earned', 210], ['job-l', 'direct_estimator', 'estimator.one', 'excluded', 0], ['job-q', 'appointment_setter', 'estimator.one', 'earned', 210]]);
  const approvals = w.fake.queries('jobs').map(item => item.body.structuredQuery.where.fieldFilter).map(filter => [filter.field.fieldPath, filter.op]);
  assert.deepEqual(approvals, [['customerApproval.approvedAt', 'GREATER_THAN_OR_EQUAL'], ['sourceWalkthroughId', 'IN']], 'one range on approvals, one lookup by walkthrough: never a scan');
  assert.equal(w.fake.scans('jobs').length, 0);
  const admin = knockAdminHandlers({ storage: () => w.knock(), dispatch: () => w.dispatch(), now: clock });
  const statement = (await call(admin.get, get('/api/knock-admin?view=money&date=2026-10-28', await cookieFor(env, 'ZacB')), env)).body.statement;
  const byKey = Object.fromEntries(statement.map(row => [row.repKey, row]));
  assert.deepEqual([byKey['rep.one'].setterCommission, byKey['estimator.one'].estimatorCommission], [390, 420]);
  // Hub > My commission for the estimator who did the walkthroughs.
  const { estimatorCommissionHandlers } = await import('../functions/api/estimator-commission.js');
  const own = (await call(estimatorCommissionHandlers({ knock: () => w.knock(), dispatch: () => w.dispatch(), now: clock }).get, get('/api/estimator-commission', await cookieFor(env, 'Estimator.One')), env)).body;
  assert.deepEqual(own.rows.map(row => [row.jobId, row.state, row.earnedCommission]).sort(), [['job-d', 'earned', 210], ['job-l', 'excluded', 0], ['job-q', 'earned', 210]]);
  // Job actuals: the approved quotes are costed like signed ones; the one approved too late and the web lead deduct nothing.
  const jobs = ['job-q', 'job-d', 'job-l', 'job-w'].map(id => ({ ...w.fake.get(`jobs/${id}`), id, date: '2026-10-27' }));
  const actuals = jobActualsHandlers({ session: async () => ({ user: 'ZacB', role: 'owner', businessAccess: true }), now: clock, timecards: async () => [],
    settingsStore: () => ({ read: async () => null, commit: async () => {} }), dispatch: () => ({ datedJobs: async () => jobs, readMany: w.dispatch().readMany }), knock: () => w.knock() });
  const report = await (await actuals.get({ request: new Request('https://easygaragecleaning.com/api/job-actuals'), env: {} })).json();
  assert.deepEqual(Object.fromEntries(report.rows.map(row => [row.jobId, [row.commission.channel, row.commission.totalCents]])),
    { 'job-q': ['appointment_setter', 60000], 'job-d': ['direct_estimator', 21000], 'job-l': ['none', 0], 'job-w': ['none', 0] });
  assert.equal(channelOf({ id: 'x', sourceWalkthroughId: 'w' }, { unpaidJobs: new Set(['x']) }), 'none');
});

test('terms are versioned: a knock-setter-v1 approval keeps its rules until the owner approves v2, and shares v1 earned before that keep their time', async () => {
  const v1 = { contract: SETTER_CONTRACT_V1, reference: 'synthetic-v1', reviewedBy: 'ZacB', reviewedAt: APPROVED_AT, terms: { ...SETTER_TERMS_V1 } };
  const w = world({}, v1), store = w.knock();
  const before = await loadSetterTerms(store, await loadSettings(store));
  assert.deepEqual([before.verified, before.contract], [true, SETTER_CONTRACT_V1]);
  // Under v1: earned at full payment, completion or not; an approved quote never pays.
  const paid = job('job-1', 'walk-1');
  assert.deepEqual([projectSetterAttribution(setter(), visit(), paid, [], NOW, before).state, projectSetterAttribution(setter(), visit(), paid, [], NOW, before).earnedAt], ['earned', '2026-10-27T15:00:00.000Z']);
  // The owner approves v2 on Nov 5: the v1 approval is kept as `earlier`.
  const owner = { user: 'ZacB', role: 'owner', businessAccess: true };
  const result = await approveSetterTerms(store, owner, { requestId: uuid(), contract: SETTER_CONTRACT, reference: 'synthetic-v2', terms: { ...SETTER_TERMS } }, '2026-11-05T16:00:00.000Z');
  assert.deepEqual([result.referenceOnly, result.setter.contract, result.setter.earlierTerms], [false, SETTER_CONTRACT, false]);
  assert.deepEqual(w.fake.get('knock_settings/current').setterApproval.earlier, { contract: SETTER_CONTRACT_V1, reference: 'synthetic-v1', reviewedBy: 'ZacB', reviewedAt: APPROVED_AT });
  const after = await loadSetterTerms(store, await loadSettings(store));
  assert.deepEqual([after.contract, after.approvedAt, after.earlier.approvedAt], [SETTER_CONTRACT, '2026-11-05T16:00:00.000Z', APPROVED_AT]);
  // Paid in full Oct 27 under v1 (job never marked complete): it keeps its v1 time; nothing moves.
  const kept = projectSetterAttribution(setter(), visit(), paid, [], NOW, after);
  assert.deepEqual([kept.state, kept.earnedAt, kept.termsContract], ['earned', '2026-10-27T15:00:00.000Z', SETTER_CONTRACT_V1]);
  // Not earned under v1 before the switch (paid Nov 10): v2's rules, from the approval on.
  const later = job('job-1', 'walk-1', done('2026-11-12T22:00:00Z')); later.payment.stripeSessions[1].verifiedAt = '2026-11-10T15:00:00Z';
  assert.deepEqual([projectSetterAttribution(setter(), visit(), later, [], NOW, after).earnedAt, projectSetterAttribution(setter(), visit(), later, [], NOW, after).termsContract], ['2026-11-12T22:00:00.000Z', undefined]);
  // Changing the v1 terms by hand never verifies.
  assert.equal(setterTermsState({ setterApproval: { ...v1, terms: { ...SETTER_TERMS_V1, refunds: 'clawback_next_period' } } }, await loadSettings(store)).verified, false);
});

test('door-to-door sales: knock-completed-v4 earns at completion and takes a refunded or cancelled share back; knock-collected-v3 sales keep collection timing', async () => {
  const doc = approvedKnockSettings();
  doc.compensationApproval = { ...doc.compensationApproval, contract: DOOR_CONTRACT, collectionPolicy: { ...COMPLETED_V4_POLICY } };
  const settings = await loadSettings({ get: async () => doc });
  assert.deepEqual([settings.commission.verified, settings.commission.contract], [true, DOOR_CONTRACT]);
  const v3 = await loadSettings({ get: async () => approvedKnockSettings() });
  assert.deepEqual([v3.commission.verified, v3.commission.contract], [true, 'knock-collected-v3'], 'a v3 approval keeps verifying');
  const terms = snapshotCommissionTerms(settings.commission, '2026-10-10T16:00:00Z', 'Garage Transformation');
  assert.equal(terms.contract, DOOR_CONTRACT);
  const sale = (extra = {}) => ({ id: 's1', repKey: 'rep.one', ticket: 2000, package: 'Garage Transformation', commissionTerms: terms, soldAt: '2026-10-10T16:00:00Z', saleDate: '2026-10-10',
    status: 'paid', collectedAmount: 2000, paidAt: '2026-10-20T16:00:00Z', completedAt: '2026-10-22T22:00:00Z', ...extra });
  // Paid Oct 20, completed Oct 22: earned on the 22nd. Not completed: not earned (v3 would have been).
  assert.equal(new Date(earnedAt(sale())).toISOString(), '2026-10-22T22:00:00.000Z');
  assert.equal(earnedAt(sale({ status: 'booked', completedAt: null })), null);
  assert.equal(earnedAt({ ...sale({ status: 'booked', completedAt: null }), commissionTerms: snapshotCommissionTerms(v3.commission, '2026-10-10T16:00:00Z', 'Garage Transformation') }), Date.parse('2026-10-20T16:00:00Z'));
  // $400 refunded Oct 30, after it was earned: 25% of it ($100) comes off P2; cancelled Nov 3: the rest ($400) off P3.
  const refunded = sale({ refundedAmount: 400, refundedAt: '2026-10-30T16:00:00Z' });
  assert.deepEqual(commissionIssues(refunded, settings.commission), [], 'taken back, not held');
  assert.deepEqual(saleClawbacks([refunded], settings.commission, { now: NOW }).map(line => [line.role, line.amount, line.reason]), [['rep', -100, 'refund']]);
  const statement = (period, sales) => periodStatement({ sales, settings, period, now: NOW, reps: [{ repKey: 'rep.one', status: 'active' }] })[0];
  const p1 = statement(P1, [refunded]), p2 = statement(P2, [refunded]);
  assert.deepEqual([p1.earned, p1.clawback, p1.payableCommission], [500, 0, 500]);
  // P2 has nothing else for the rep: the line is listed and the period is held for finance, never shown below zero.
  assert.deepEqual([p2.clawbacks, p2.compensationState, p2.reviewReasons, p2.payableCommission], [[{ ref: 'sale:s1', role: 'rep', reason: 'refund', amount: -100, eventDate: '2026-10-30' }], 'review_required', ['clawback_exceeds_earned'], null]);
  // With another sale earned in P2, the refund nets against it.
  const second = sale({ id: 's2', paidAt: '2026-11-03T16:00:00Z', completedAt: '2026-11-04T22:00:00Z' });
  assert.deepEqual([statement(P2, [refunded, second]).earned, statement(P2, [refunded, second]).clawback, statement(P2, [refunded, second]).payableCommission], [400, -100, 400]);
  const cancelled = sale({ status: 'cancelled', cancelledAt: '2026-11-03T16:00:00Z', refundedAmount: 400, refundedAt: '2026-10-30T16:00:00Z' });
  assert.deepEqual(saleClawbacks([cancelled], settings.commission, { now: NOW }).map(line => [line.amount, line.reason]), [[-100, 'refund'], [-400, 'cancellation']]);
  assert.equal(statement(P3, [cancelled]).clawbacks[0].ref, 'sale:s1');
  // A refund before the job was completed and paid is held, as under earlier terms; so is a reopened job.
  assert.ok(commissionIssues(sale({ refundedAmount: 50, refundedAt: '2026-10-21T16:00:00Z' }), settings.commission).includes('refund_review'));
  assert.ok(commissionIssues(sale({ status: 'booked', completedAt: null, statusHistory: [{ status: 'completed', at: '2026-10-22T22:00:00Z' }, { status: 'booked', at: '2026-10-23T16:00:00Z' }] }), settings.commission).includes('completion_review'));
  // A v3 sale's refund is still only held: its terms never took shares back.
  const v3Sale = { ...refunded, commissionTerms: snapshotCommissionTerms(v3.commission, '2026-10-10T16:00:00Z', 'Garage Transformation') };
  assert.deepEqual([commissionIssues(v3Sale, v3.commission).includes('refund_review'), saleClawbacks([v3Sale], v3.commission, { now: NOW }).length], [true, 0]);
});

test('Knock Admin shows the new terms to approve, and a rep sees only their own share taken back', async () => {
  const v1 = { contract: SETTER_CONTRACT_V1, reference: 'synthetic-v1', reviewedBy: 'ZacB', reviewedAt: APPROVED_AT, terms: { ...SETTER_TERMS_V1 } };
  const w = world({}, v1), admin = knockAdminHandlers({ storage: () => w.knock(), dispatch: () => w.dispatch(), now: () => new Date(NOW) });
  const view = (await call(admin.get, get('/api/knock-admin?view=settings', await cookieFor(env, 'ZacB')), env)).body;
  assert.deepEqual([view.setter.verified, view.setter.earlierTerms, view.setter.terms.contract, view.setter.terms.refunds], [true, true, SETTER_CONTRACT, 'clawback_next_period']);
  assert.deepEqual([view.compensation.terms.contract, view.compensation.terms.collectionPolicy.earnedOn], [DOOR_CONTRACT, 'job_completion']);
  const approved = await call(admin.post, post('/api/knock-admin', { action: 'setter.approve', requestId: uuid(), contract: SETTER_CONTRACT, reference: 'synthetic-v2', terms: { ...SETTER_TERMS } }, await cookieFor(env, 'ZacB')), env);
  assert.deepEqual([approved.status, approved.body.setter.earlierTerms, approved.body.referenceOnly], [200, false, false]);
  const { repSetterRows } = await import('../functions/_lib/knock-reports.js');
  const row = projectSetterAttribution(setter(), visit(), job('job-1', 'walk-1', { ...done(), refunds: [{ amount: 500, refundedAt: '2026-10-30T17:00:00Z' }] }), [], NOW, TERMS);
  const mine = repSetterRows({ rows: [row] }, 'rep.one').rows[0];
  assert.deepEqual(mine.clawbacks.map(line => line.role), ['setter']);
  assert.doesNotMatch(JSON.stringify(mine), /estimator\.one|3500/);
  assert.equal(completionEarning(job('job-1', 'walk-1', done()), { closedAt: '2026-10-17T15:00:00Z', totals: { complete: true, totalCents: 300000 }, ledger: { entries: [], issues: [], unreconciledCents: 0 } }, NOW).state, 'awaiting_collection');
});
