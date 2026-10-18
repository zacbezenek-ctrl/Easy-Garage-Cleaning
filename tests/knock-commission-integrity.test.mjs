// D6b review fixes (money-1..12, privacy-access-1/2/6): the approved 13% setter + 7% estimator shares are paid once, to
// the right person, in the period they were earned, and anything that changes after a share was earned or paid holds
// the statement for finance instead of moving, vanishing or paying twice. Synthetic data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTER_CONTRACT, SETTER_TERMS, periodStatement } from '../crew/knock-money.js';
import { SETTER_JOB_FIELDS, projectSetterAttribution, recordSetterAttribution, signedGarageHandoff } from '../functions/_lib/knock-setters.js';
import { channelLedger, projectEstimatorJob } from '../functions/_lib/estimator-commission.js';
import { commissionAllocations } from '../functions/_lib/knock-allocations.js';
import { createKnockStore } from '../functions/_lib/knock-store.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { knockReportsHandlers } from '../functions/api/knock-reports.js';
import { estimatorCommissionHandlers } from '../functions/api/estimator-commission.js';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { approvedKnockSettings, call, cookieFor, get, knockEnv, post, uuid } from './helpers/knock-fixture.mjs';

const NOW = '2026-10-21T18:00:00.000Z', APPROVED_AT = '2026-10-20T16:00:00.000Z';
const P1 = '2026-10-19_2026-11-01';
const env = knockEnv({ HUB_AUTH_USERS_JSON: JSON.stringify({
  ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Zac' },
  TylerG: { passwordHash: 'test', role: 'manager', displayName: 'Tyler' },
  'Rep.One': { passwordHash: 'test', role: 'sales', displayName: 'Rep One' },
  'Estimator.One': { passwordHash: 'test', role: 'sales', displayName: 'Estimator One' },
  'Estimator.Two': { passwordHash: 'test', role: 'sales', displayName: 'Estimator Two' },
}) });
const office = { user: 'TylerG', role: 'manager', businessAccess: true };
const ROSTER = ['estimator.one', 'estimator.two', 'rep.one', 'tylerg', 'zacb'].map(id => ({ id, name: id, role: 'sales' }));
const terms = { verified: true, approvedAt: APPROVED_AT, reference: 'synthetic-d6b-record' };
const setterApproval = () => ({ contract: SETTER_CONTRACT, reference: 'synthetic-d6b-record', reviewedBy: 'ZacB', reviewedAt: APPROVED_AT, terms: { ...SETTER_TERMS } });
const card = (id, amount, verifiedAt = '2026-10-19T20:00:00Z') => ({ sessionId: `cs_test_${id}`, paymentIntentId: `pi_${id}`, amount, purpose: 'balance', verifiedAt });
const paidJob = (id, walkthroughId, amount = 3000, extra = {}) => ({ type: 'job', status: 'scheduled', date: '2026-10-19', sourceWalkthroughId: walkthroughId,
  handoffVersion: 1, handoffRequestId: `req-${id}`, serviceType: 'Garage transformation', scope: { finish: ['cleanout'] }, customer: 'Synthetic Customer',
  estimate: { status: 'accepted', amount, acceptedAt: '2026-10-17T15:00:00Z' }, acceptance: { recordedBy: 'Estimator.One', acceptedAt: '2026-10-17T14:55:00Z' },
  payment: { amount, verified: true, stripeSessions: [card(id.replace(/-/g, ''), amount)] }, ...extra });
const visit = jobId => ({ type: 'walkthrough', status: 'completed', convertedJobId: jobId, walkthroughOutcome: { outcome: 'sold_on_site' }, assignedCrew: ['estimator.one'] });
const bridgeRow = (walkthroughId, extra = {}) => ({ walkthroughId, setterKey: 'rep.one', serviceClassification: 'unverified', classificationReference: '',
  estimatorKey: 'estimator.one', estimatorReference: 'knock-walkthrough:kw-1', channel: 'appointment_setter', requestId: 'kw-1', recordedBy: 'knock-bridge', recordedAt: '2026-10-16T18:00:00Z', source: 'knock_walkthrough', ...extra });
const receipt = (actorId, jobId, sourceWalkthroughId, createdAt = '2026-10-17T15:00:00.000Z') => ({ actorId, jobId, sourceWalkthroughId, createdAt, signature: 'data:image/png;base64,AAAA' });

// walk-1 -> job-1 ($3,000): set at the door by rep.one, estimator.one booked and signing. walk-2 -> job-2 ($1,234.56):
// estimator.one's direct sale. Both paid in full on 2026-10-19; the owner approved the terms on 2026-10-20.
function world({ approved = true, seed = {} } = {}) {
  const fake = firestoreRest({
    'knock_settings/current': { ...approvedKnockSettings(), ...(approved ? { setterApproval: setterApproval() } : {}) },
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', status: 'active', role: 'knocker' },
    'knock_setters/walk-1': bridgeRow('walk-1'),
    'jobs/walk-1': visit('job-1'), 'jobs/job-1': paidJob('job-1', 'walk-1'),
    'jobs/walk-2': visit('job-2'), 'jobs/job-2': paidJob('job-2', 'walk-2', 1234.56),
    'walkthroughHandoffs/r1': receipt('Estimator.One', 'job-1', 'walk-1'), 'walkthroughHandoffs/r2': receipt('Estimator.One', 'job-2', 'walk-2'),
    ...seed,
  });
  const dispatch = () => ({ ...dispatchStorage(env, fake.fetcher), roster: async () => ROSTER });
  return { fake, dispatch, knock: () => createKnockStore(env, fake.fetcher) };
}
const admin = (w, clock = NOW) => knockAdminHandlers({ storage: () => w.knock(), dispatch: w.dispatch, now: () => new Date(clock) });
const reports = (w, clock = NOW) => knockReportsHandlers({ storage: () => w.knock(), dispatch: w.dispatch, now: () => new Date(clock) });
const hub = (w, clock = NOW) => estimatorCommissionHandlers({ knock: () => w.knock(), dispatch: w.dispatch, now: () => new Date(clock) });
const as = async (user, request) => request(await cookieFor(env, user));
const statement = async (w, date, clock = NOW) => {
  const body = (await call(admin(w, clock).get, await as('ZacB', cookie => get(`/api/knock-admin?view=money&date=${date}`, cookie)), env)).body;
  return Object.fromEntries(body.statement.map(row => [row.repKey, row]));
};
const pay = async (w, repKey, periodKey, amount, clock = NOW) => call(admin(w, clock).post, await as('TylerG', cookie => post('/api/knock-admin', { action: 'payout.add', requestId: uuid(), repKey, periodKey, amount, note: 'Synthetic payroll' }, cookie)), env);
const view = async (w, name, clock = NOW) => (await call(admin(w, clock).get, await as('ZacB', cookie => get(`/api/knock-admin?view=${name}`, cookie)), env)).body;
const mine = async (w, user, clock = NOW) => (await call(hub(w, clock).get, get('/api/estimator-commission', await cookieFor(env, user)), env)).body;
const myMoney = async (w, date, clock = NOW) => (await call(reports(w, clock).get, await as('Rep.One', cookie => get(`/api/knock-reports?view=my-money&date=${date}`, cookie)), env)).body;
const edit = (w, path, change) => { const { revision, ...data } = w.fake.get(path), copy = structuredClone(data); w.fake.put(path, change(copy) || copy); };
const state = row => [row.compensationState, row.payableCommission, row.reviewReasons];

test('money-1: a share paid in one period that the job later changes holds that period and the one it moves to; it is never paid twice', async () => {
  const w = world();
  const before = await statement(w, '2026-10-21');
  assert.deepEqual([before['rep.one'].setterCommission, before['rep.one'].payableCommission, before['estimator.one'].payableCommission], [390, 390, 296.42]);
  const paid = await pay(w, 'rep.one', P1, 390);
  assert.equal(paid.status, 200);
  // The payout records the shares it paid, as the statement reads them now.
  assert.deepEqual(w.fake.get(`knock_payouts/${paid.body.payout.id}`).channelItems.map(item => [item.id, item.share, item.amountCents, item.earnedAt]),
    [['job-1:appointment_setter:setter:rep.one', 'job-1:setter', 39000, APPROVED_AT]]);
  // 11-05: the customer approves $200 more (the estimate is accepted again at $3,200) and pays it by card.
  edit(w, 'jobs/job-1', job => { job.estimate = { ...job.estimate, amount: 3200, acceptedAt: '2026-11-05T15:00:00Z' }; job.payment.amount = 3200; job.payment.stripeSessions.push(card('job1co', 200, '2026-11-05T20:00:00Z')); });
  const later = '2026-11-06T18:00:00.000Z', p1 = await statement(w, '2026-10-21', later), p2 = await statement(w, '2026-11-05', later);
  // rep.one was paid $390 in P1: P1 and P2 both hold it for finance; the $416 is never offered as payable on top.
  assert.deepEqual(state(p1['rep.one']), ['review_required', null, ['channel_share_changed', 'payout_exceeds_earned']]);
  assert.deepEqual(state(p2['rep.one']), ['review_required', null, ['channel_share_changed']]);
  // estimator.one was not paid yet: their share simply earns once, in P2, at the new price.
  assert.deepEqual([p1['estimator.one'].estimatorCommission, p1['estimator.one'].compensationState, p2['estimator.one'].estimatorCommission, p2['estimator.one'].payableCommission], [86.42, 'configured', 224, 224]);
  // A share paid and unchanged holds nothing (the payout matches the statement).
  const steady = world();
  await pay(steady, 'estimator.one', P1, 296.42);
  assert.deepEqual(state((await statement(steady, '2026-10-21'))['estimator.one']), ['configured', 0, []]);
  // A payment recorded above what the period earned (with no record of the shares it paid) is held too; without the
  // approved shares the statement is exactly as before.
  const period = { key: P1, start: '2026-10-19', end: '2026-11-01' }, settings = { commission: { verified: true }, payroll: {} };
  const input = { settings, period, payouts: [{ id: 'legacy', repKey: 'rep.one', periodKey: P1, amount: 100 }], reps: [{ repKey: 'rep.one', status: 'active' }] };
  assert.deepEqual(state(periodStatement({ ...input, channels: [] })[0]), ['review_required', null, ['payout_exceeds_earned']]);
  assert.deepEqual(state(periodStatement(input)[0]), ['configured', 0, []]);
});

test('money-4: an earned share later cancelled or refunded holds its recipients\' statements instead of silently dropping out', async () => {
  const cancelled = world();
  await pay(cancelled, 'rep.one', P1, 390);
  edit(cancelled, 'jobs/job-1', job => Object.assign(job, { status: 'cancelled', pipelineStatus: 'cancelled', cancelledAt: '2026-11-05T17:00:00Z' }));
  const later = '2026-11-06T18:00:00.000Z', p1 = await statement(cancelled, '2026-10-21', later), p2 = await statement(cancelled, '2026-11-05', later);
  assert.deepEqual(state(p1['rep.one']), ['review_required', null, ['cancellation_review', 'channel_share_changed', 'payout_exceeds_earned']]);
  // The estimator's $210 was earned in P1 too (unpaid): held there and where the cancellation happened, not dropped.
  assert.deepEqual([state(p1['estimator.one']), state(p2['estimator.one'])], [['review_required', null, ['cancellation_review']], ['review_required', null, ['cancellation_review']]]);
  assert.equal((await statement(cancelled, '2026-11-16', later))['estimator.one'], undefined, 'a period it never touched is not held');
  // A $50 refund recorded before payroll, with no date: held from the period it was earned on, never shown as configured.
  const refunded = world();
  edit(refunded, 'jobs/job-1', job => { job.payment.refundedAmount = 50; });
  const held = await statement(refunded, '2026-10-21');
  assert.deepEqual([state(held['rep.one']), state(held['estimator.one'])], [['review_required', null, ['collection_unverified']], ['review_required', null, ['collection_unverified']]]);
  // A cancelled job with nothing collected holds nothing.
  const unpaid = world();
  edit(unpaid, 'jobs/job-1', job => { delete job.payment; Object.assign(job, { status: 'cancelled', pipelineStatus: 'cancelled', cancelledAt: '2026-10-21T10:00:00Z' }); });
  assert.deepEqual(state((await statement(unpaid, '2026-10-21'))['rep.one']), ['configured', 0, []]);
});

test('money-5: a setter record made after the job was paid earns when it was made; the estimator already paid for the job is held, not paid again', async () => {
  const w = world();
  await pay(w, 'estimator.one', P1, 296.42);
  const late = '2026-11-20T18:00:00.000Z';
  const record = await recordSetterAttribution(w.knock(), office, { requestId: uuid(), walkthroughId: 'walk-2', setterKey: 'rep.one' }, late, env, { dispatch: w.dispatch });
  assert.equal(record.attribution.recordedAt, late);
  const setters = (await view(w, 'setters', late)).rows.find(row => row.walkthroughId === 'walk-2');
  assert.deepEqual([setters.state, setters.qualifyingAt, setters.earnedAt], ['earned', '2026-10-19T20:00:00.000Z', late]);
  const current = await statement(w, '2026-11-20', late), p1 = await statement(w, '2026-10-21', late);
  // The 13% (of $1,234.56) is in the period the record was made, not back-dated into P1.
  assert.deepEqual([current['rep.one'].setterCommission, current['rep.one'].payableCommission, p1['rep.one'].setterCommission], [160.49, 160.49, 390]);
  // job-2's 7% moved from a direct sale paid in P1 to the setter record: both periods hold estimator.one, nothing is paid twice.
  assert.deepEqual(state(current['estimator.one']), ['review_required', null, ['channel_share_changed']]);
  assert.deepEqual(state(p1['estimator.one']), ['review_required', null, ['channel_share_changed', 'payout_exceeds_earned']]);
  // A classification the office settles later dates the share the same way (earnedFloor).
  const row = projectSetterAttribution({ ...bridgeRow('walk-1'), serviceClassification: 'garage', classificationReference: 'r', classifiedAt: late }, { ...visit('job-1'), id: 'walk-1', revision: 'r' },
    { ...paidJob('job-1', 'walk-1'), id: 'job-1', revision: 'r' }, [], Date.parse(late), terms);
  assert.deepEqual([row.state, row.earnedAt], ['earned', late]);
});

test('money-2 / privacy-access-2: a manager cannot re-point a recorded estimator, name themselves or an unknown key; the signer and the owner can', async () => {
  const w = world({ seed: { 'knock_setters/walk-3': bridgeRow('walk-3', { estimatorKey: '', estimatorReference: '' }), 'jobs/walk-3': visit('job-3'), 'jobs/job-3': paidJob('job-3', 'walk-3', 2000) } });
  await pay(w, 'estimator.one', P1, 296.42);
  const classify = async (user, body) => call(admin(w).post, await as(user, cookie => post('/api/knock-admin', { action: 'setter.classify', requestId: uuid(), serviceClassification: 'garage', classificationReference: 'synthetic-scope-1', estimatorReference: 'synthetic-roster-review', ...body }, cookie)), env);
  const repoint = await classify('TylerG', { walkthroughId: 'walk-1', estimatorKey: 'estimator.two' });
  assert.deepEqual([repoint.status, repoint.body.code, w.fake.get('knock_setters/walk-1').estimatorKey], [409, 'knock_setter_conflict', 'estimator.one']);
  for (const [estimatorKey, status, code] of [['tylerg', 403, 'knock_setter_self'], ['nobody.real', 400, 'knock_setter_estimator']]) {
    const refused = await classify('TylerG', { walkthroughId: 'walk-3', estimatorKey });
    assert.deepEqual([refused.status, refused.body.code], [status, code], estimatorKey);
  }
  assert.equal(w.fake.get('knock_setters/walk-3').estimatorKey, '');
  // The employee who signed the handoff can be named by any admin; the owner can name another rostered estimator.
  assert.equal((await classify('TylerG', { walkthroughId: 'walk-3', estimatorKey: 'estimator.one' })).status, 200);
  const owner = await classify('ZacB', { walkthroughId: 'walk-1', estimatorKey: 'estimator.two' });
  assert.equal(owner.status, 200);
  // The owner's change after estimator.one was paid holds both statements; estimator.two is not offered the paid $210.
  const p1 = await statement(w, '2026-10-21');
  assert.deepEqual(state(p1['estimator.one']), ['review_required', null, ['channel_share_changed', 'payout_exceeds_earned']]);
  assert.deepEqual(state(p1['estimator.two']), ['review_required', null, ['channel_share_changed']]);
});

test('money-6 / privacy-access-1: an estimator the bridge booked who did not sign is held for the office, not paid; neither estimator\'s view lists it until it is settled', async () => {
  const w = world({ seed: { 'jobs/job-1': paidJob('job-1', 'walk-1', 4321, { acceptance: { recordedBy: 'Estimator.Two', acceptedAt: '2026-10-17T14:55:00Z' } }),
    'walkthroughHandoffs/r1': receipt('Estimator.Two', 'job-1', 'walk-1') } });
  const row = (await view(w, 'setters')).rows[0];
  assert.deepEqual([row.state, row.estimatorKey, row.closingActorKey, row.reviewReasons, row.earnedCommission], ['review_required', 'estimator.one', 'Estimator.Two', ['estimator_attribution_conflict'], null]);
  const p1 = await statement(w, '2026-10-21');
  assert.deepEqual([p1['estimator.one'].estimatorCommission, p1['estimator.two'], p1['rep.one'].setterCommission], [86.42, undefined, 0]);
  assert.deepEqual((await mine(w, 'Estimator.One')).rows.map(item => item.jobId), ['job-2'], 'the booked estimator does not see the job someone else signed');
  assert.deepEqual((await mine(w, 'Estimator.Two')).rows, []);
  // The office settles it: naming the signer is allowed for a manager, and the shares earn from then.
  const settled = '2026-10-22T15:00:00.000Z';
  const result = await call(admin(w, settled).post, await as('TylerG', cookie => post('/api/knock-admin', { action: 'setter.classify', requestId: uuid(), walkthroughId: 'walk-1',
    serviceClassification: 'garage', classificationReference: 'synthetic-scope-1', estimatorKey: 'estimator.two', estimatorReference: 'synthetic-signer-review' }, cookie)), env);
  assert.equal(result.status, 200);
  const after = (await view(w, 'setters', settled)).rows[0];
  assert.deepEqual([after.state, after.estimatorKey, after.earnedAt, after.allocations.map(item => [item.repKey, item.amountCents])], ['earned', 'estimator.two', settled, [['rep.one', 56173], ['estimator.two', 30247]]]);
  assert.deepEqual((await mine(w, 'Estimator.Two', settled)).rows.map(item => [item.jobId, item.state, item.earnedCommission]), [['job-1', 'earned', 302.47]]);
  // An estimator the office recorded (not the bridge's booking) stands under the terms: office recorded, else the signer.
  const officeRecorded = projectSetterAttribution({ ...bridgeRow('walk-1'), source: undefined, recordedBy: 'TylerG', estimatorReference: 'synthetic-roster-review' }, { ...visit('job-1'), id: 'walk-1', revision: 'r' },
    { ...paidJob('job-1', 'walk-1', 3000, { acceptance: { recordedBy: 'Estimator.Two' } }), id: 'job-1', revision: 'r' }, [], Date.parse(NOW), terms);
  assert.deepEqual([officeRecorded.state, officeRecorded.estimatorKey], ['earned', 'estimator.one']);
});

test('money-7: a junk-only signed handoff is not garage work; the office classifies a direct sale once (estimator.classify)', async () => {
  const base = { ...paidJob('job-9', 'walk-9', 750), id: 'job-9', revision: 'r' }, line = (id, kind, name, totalCents) => ({ id, kind, name, quantity: 1, unitCents: totalCents, totalCents, optional: false, selected: true });
  const junk = { ...base, scope: { finish: [] }, estimate: { ...base.estimate, lineItems: [line('junk', 'disposal', 'Junk removal, full truck', 75000)] } };
  const builderJunk = { ...junk, estimate: { ...junk.estimate, lineItems: [line('removal-junk-full', 'service', 'Junk removal: full truck', 75000)] } };
  const garage = { ...junk, estimate: { ...junk.estimate, lineItems: [line('removal-base', 'service', 'Two-car garage cleaning base', 50000), line('removal-junk-partial', 'service', 'Junk removal: half truck', 25000)] } };
  assert.deepEqual([junk, builderJunk, garage, { ...base, scope: { finish: [] } }, base].map(signedGarageHandoff), [false, false, true, false, true]);
  assert.deepEqual(projectEstimatorJob(junk, { terms, nowMs: Date.parse(NOW) }).reviewReasons, ['service_scope_unverified']);
  const set = projectSetterAttribution(bridgeRow('walk-9'), { ...visit('job-9'), id: 'walk-9', revision: 'r' }, junk, [], Date.parse(NOW), terms);
  assert.deepEqual([set.state, set.serviceClassification, set.reviewReasons], ['review_required', 'unverified', ['service_scope_unverified']]);
  // The office settles job-2 (made junk-only) once, through Knock Admin > Estimators.
  const w = world();
  edit(w, 'jobs/job-2', job => { job.scope = { finish: [] }; job.estimate.lineItems = [line('junk', 'disposal', 'Junk removal', 123456)]; });
  assert.deepEqual((await view(w, 'estimators')).rows.find(row => row.jobId === 'job-2').reviewReasons, ['service_scope_unverified']);
  const classify = async (body, user = 'TylerG') => call(admin(w).post, await as(user, cookie => post('/api/knock-admin', { action: 'estimator.classify', requestId: uuid(), classificationReference: 'synthetic-scope-2', ...body }, cookie)), env);
  assert.equal((await classify({ jobId: 'job-2', serviceClassification: 'junk_removal' })).status, 200);
  assert.deepEqual([(await classify({ jobId: 'job-2', serviceClassification: 'garage' })).body.code, (await classify({ jobId: 'job-1', serviceClassification: 'garage' })).body.code, (await classify({ jobId: 'job-2', serviceClassification: 'junk_removal' }, 'Rep.One')).status],
    ['knock_estimator_conflict', 'knock_estimator_setter', 403]);
  assert.equal((await classify({ jobId: 'job-2', serviceClassification: 'junk_removal' })).body.duplicate, true);
  const row = (await view(w, 'estimators')).rows.find(item => item.jobId === 'job-2');
  assert.deepEqual([row.state, row.earnedCommission], ['excluded', 0]);
  assert.equal((await statement(w, '2026-10-21'))['estimator.one'].estimatorCommission, 210);
  // Classified garage later: earned from the classification, in that period.
  const office = { serviceClassification: 'garage', classifiedAt: '2026-11-03T10:00:00.000Z' };
  assert.equal(projectEstimatorJob(junk, { terms, nowMs: Date.parse('2026-11-04T00:00:00Z'), office }).earnedAt, office.classifiedAt);
});

test('money-3: old setter records are not read and never hold a statement; records past the limit hold only the people they name', async () => {
  const old = Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`knock_setters/old-${i}`, bridgeRow(`old-${i}`, { setterKey: 'rep.old', serviceClassification: 'junk_removal', classificationReference: 'r', recordedAt: '2025-01-15T18:00:00Z' })]));
  const w = world({ seed: { ...old, 'knock_reps/rep.two': { repKey: 'rep.two', displayName: 'Rep Two', status: 'active', role: 'knocker' } } });
  const p1 = await statement(w, '2026-10-21');
  assert.deepEqual([p1['rep.one'].payableCommission, p1['estimator.one'].payableCommission, state(p1['rep.two'])], [390, 296.42, ['configured', 0, []]]);
  const reads = w.fake.queries('knock_setters').map(item => item.body.structuredQuery.where?.fieldFilter?.field.fieldPath);
  assert.ok(reads.length && reads.every(path => path === 'recordedAt'), 'the setter records are read by date, never the whole collection');
  // Past the limit: the unread records hold their setter and estimator only, or every row when the estimator is unknown.
  const ledger = channelLedger({ overflow: [{ setterKey: 'rep.three', estimatorKey: 'Est.Three' }] });
  assert.deepEqual([ledger.holds.map(item => [item.repKey, item.reasons, item.all]), ledger.review], [[['rep.three', ['setter_records_truncated'], true], ['est.three', ['setter_records_truncated'], true]], []]);
  assert.deepEqual(channelLedger({ overflow: [{ setterKey: 'rep.three', estimatorKey: '' }] }).review, ['setter_records_truncated']);
  // A rep with more than 100 records of their own is still paid through My money.
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`knock_setters/mine-${i}`, bridgeRow(`mine-${i}`, { recordedAt: '2026-10-10T18:00:00Z' })]));
  const body = await myMoney(world({ seed: many }), '2026-10-21');
  assert.deepEqual([body.periods[0].compensationState, body.periods[0].setterCommission, body.setters.truncated], ['configured', 390, false]);
});

test('money-8 / privacy-access-6: a door sale linked to a direct walkthrough job holds its 7%; linked sales are found by job, never by reading every sale', async () => {
  const sales = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`knock_sales/other-${i}`, { repKey: 'rep.one', handoff: { job: { mode: 'manual', status: 'created', ref: `elsewhere-${i}` } } }]));
  const w = world({ seed: { ...sales, 'knock_sales/s1': { repKey: 'rep.one', handoff: { job: { mode: 'manual', status: 'created', ref: 'job-2' } } } } });
  const row = (await view(w, 'estimators')).rows.find(item => item.jobId === 'job-2');
  assert.deepEqual([row.state, row.directSaleRepKey, row.reviewReasons], ['review_required', 'rep.one', ['direct_close_attribution_conflict']]);
  assert.equal((await mine(w, 'Estimator.One')).totals.earned, 210, 'the 25% and the 7% never stack');
  const queries = w.fake.queries('knock_sales').map(item => item.body.structuredQuery.where?.fieldFilter);
  assert.ok(queries.length && queries.every(filter => filter?.op === 'IN' && filter.field.fieldPath === 'handoff.job.ref'), JSON.stringify(queries));
  assert.equal(w.fake.scans('knock_sales').length, 0);
});

test('money-9: an estimator key typed with capitals is stored, paid and shown in lowercase', async () => {
  const w = world({ seed: { 'knock_setters/walk-1': bridgeRow('walk-1', { estimatorKey: 'Estimator.One', estimatorReference: 'synthetic-roster-review', source: undefined, recordedBy: 'TylerG' }) } });
  const p1 = await statement(w, '2026-10-21');
  assert.deepEqual([p1['estimator.one'].estimatorCommission, p1['Estimator.One']], [296.42, undefined]);
  assert.equal((await pay(w, 'estimator.one', P1, 296.42)).status, 200);
  assert.equal((await statement(w, '2026-10-21'))['estimator.one'].payableCommission, 0);
  assert.deepEqual((await mine(w, 'Estimator.One')).rows.map(item => [item.jobId, item.state]), [['job-1', 'earned'], ['job-2', 'earned']]);
  const record = await recordSetterAttribution(w.knock(), office, { requestId: uuid(), walkthroughId: 'walk-2', setterKey: 'rep.one', estimatorKey: 'Estimator.One', estimatorReference: 'synthetic-roster-review' }, NOW, env, { dispatch: w.dispatch });
  assert.equal(record.attribution.estimatorKey, 'estimator.one');
  assert.ok(commissionAllocations({ channel: 'appointment_setter', jobId: 'job-1', serviceClassification: 'garage', setterKey: 'rep.one', estimatorKey: 'Rep.One' }).reviewReasons.includes('recipient_overlap_review'));
});

test('money-10: an employee who sets and also signs walkthroughs sees the statement Admin > Money pays', async () => {
  const w = world({ seed: { 'jobs/walk-5': visit('job-5'), 'jobs/job-5': paidJob('job-5', 'walk-5', 1000, { acceptance: { recordedBy: 'Rep.One', acceptedAt: '2026-10-17T14:55:00Z' } }),
    'walkthroughHandoffs/r5': receipt('Rep.One', 'job-5', 'walk-5') } });
  const office = (await statement(w, '2026-10-21'))['rep.one'];
  assert.deepEqual([office.setterCommission, office.estimatorCommission, office.payableCommission], [390, 70, 460]);
  await pay(w, 'rep.one', P1, 460);
  const own = (await myMoney(w, '2026-10-21')).periods[0];
  assert.deepEqual([own.setterCommission, own.estimatorCommission, own.earnedCommission, own.paid, own.balance, own.compensationState], [390, 70, 460, 460, 0, 'configured']);
});

test('money-11: a share whose source is older than its statement reads is held in the estimator\'s own view, as the statement leaves it out', async () => {
  const w = world({ seed: { 'jobs/walk-3': visit('job-3'), 'jobs/job-3': paidJob('job-3', 'walk-3', 2000, { date: '2025-09-10', payment: { amount: 2000, verified: true, stripeSessions: [card('job3', 2000, '2025-09-15T20:00:00Z')] } }),
    'walkthroughHandoffs/r3': receipt('Estimator.One', 'job-3', 'walk-3', '2025-09-01T15:00:00.000Z') } });
  const own = await mine(w, 'Estimator.One');
  assert.deepEqual(own.rows.find(row => row.jobId === 'job-3'), { id: 'job-3:direct_estimator', jobId: 'job-3', jobDate: '2025-09-10', channel: 'direct', state: 'review_required', rate: 0.07,
    projectedCommission: 140, earnedCommission: null, earnedAt: APPROVED_AT, reviewReasons: ['statement_lookback_exceeded'] });
  assert.equal(own.totals.earned, 296.42);
  assert.equal((await statement(w, '2026-10-21'))['estimator.one'].estimatorCommission, 296.42, 'the statement and the estimator agree');
  // The rule is the statement's own (My money reads older sources too): such a share holds instead of paying.
  const period = { key: P1, start: '2026-10-19', end: '2026-11-01' }, settings = { commission: { verified: true }, payroll: {} };
  const rows = periodStatement({ settings, period, channels: [{ repKey: 'rep.one', role: 'setter', amount: 390, earnedAt: Date.parse(APPROVED_AT), sourceAt: Date.parse('2025-09-01T00:00:00Z') }] });
  assert.deepEqual([rows[0].earnedCommission, rows[0].reviewReasons], [null, ['statement_lookback_exceeded']]);
});

test('money-12: a cancelled job projects nothing to its estimator or setter', async () => {
  const cancel = job => { delete job.payment; Object.assign(job, { status: 'cancelled', pipelineStatus: 'cancelled', cancelledAt: '2026-10-20T10:00:00Z' }); };
  const w = world();
  edit(w, 'jobs/job-1', cancel); edit(w, 'jobs/job-2', cancel);
  const own = await mine(w, 'Estimator.One');
  assert.deepEqual(own.rows.map(row => [row.jobId, row.channel, row.state, row.projectedCommission, row.reviewReasons]),
    [['job-1', 'door_to_door', 'review_required', null, ['cancellation_review']], ['job-2', 'direct', 'review_required', null, ['cancellation_review']]]);
  assert.deepEqual(own.totals, { projected: 0, earned: 0 });
  const rep = (await myMoney(w, '2026-10-21')).setters.rows[0];
  assert.deepEqual([rep.state, rep.projectedCommission], ['review_required', null]);
  // Paid and then cancelled: held, and still no projection.
  const paid = projectEstimatorJob({ ...paidJob('job-9', 'walk-9', 1000), status: 'cancelled', id: 'job-9', revision: 'r' }, { terms, nowMs: Date.parse(NOW) });
  assert.deepEqual([paid.state, paid.projectedCommission], ['review_required', null]);
  assert.ok(SETTER_JOB_FIELDS.includes('cancelledAt'));
});

test('before the owner approves the setter terms, payouts and statements carry none of these shares or holds', async () => {
  const w = world({ approved: false });
  edit(w, 'jobs/job-1', job => Object.assign(job, { status: 'cancelled', pipelineStatus: 'cancelled', cancelledAt: '2026-10-25T10:00:00Z', payment: { ...job.payment, refundedAmount: 50 } }));
  const { body } = await pay(w, 'rep.one', P1, 10);
  assert.equal(Object.hasOwn(w.fake.get(`knock_payouts/${body.payout.id}`), 'channelItems'), false);
  for (const date of ['2026-10-21', '2026-11-05']) {
    const rows = Object.values(await statement(w, date));
    assert.ok(rows.every(row => !Object.hasOwn(row, 'setterCommission') && !Object.hasOwn(row, 'estimatorCommission')));
    assert.ok(rows.every(row => row.compensationState === 'configured' && !row.reviewReasons.length), JSON.stringify(rows.map(row => [row.repKey, row.reviewReasons])));
  }
});
