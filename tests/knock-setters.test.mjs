import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSetterAttribution, recordSetterAttribution, setterAttributions } from '../functions/_lib/knock-setters.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { call, cookieFor, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

const now = '2026-10-20T18:00:00Z', admin = { user: 'test-owner' };
const record = () => ({ walkthroughId: 'walk-1', setterKey: 'rep.one', serviceClassification: 'garage', classificationReference: 'synthetic-review' });
const visit = () => ({ id: 'walk-1', revision: 'rev-w', type: 'walkthrough', convertedJobId: 'job-1', walkthroughOutcome: { outcome: 'sold_on_site' } });
const job = () => ({ id: 'job-1', revision: 'rev-j', type: 'job', sourceWalkthroughId: 'walk-1',
  estimate: { status: 'accepted', amount: 1000, acceptedAt: '2026-10-19T12:00:00Z' },
  acceptance: { recordedBy: 'estimator.one' }, payment: { amount: 1000, verified: true,
    stripeSessions: [{ sessionId: 'cs_test_syntheticSetter', paymentIntentId: 'pi_syntheticSetter', amount: 1000, purpose: 'balance', verifiedAt: now }] } });
const store = () => knockWorld({ 'knock_reps/rep.one': { status: 'active' }, 'knock_reps/rep.two': { status: 'active' } }).storage(knockEnv());

test('setter attribution is idempotent under retries and concurrent duplicate requests', async () => {
  const db = store(), body = { ...record(), requestId: uuid(), amount: 99999 };
  const options = { readJob: async () => visit() };
  const rows = await Promise.all([recordSetterAttribution(db, admin, body, now, {}, options), recordSetterAttribution(db, admin, body, now, {}, options)]);
  assert.equal(rows.filter(row => row.duplicate).length, 1);
  assert.equal((await db.list('knock_setters')).length, 1);
  assert.equal((await db.list('knock_payouts')).length, 0);
  assert.equal((await db.list('knock_setters'))[0].amount, undefined, 'client cannot supply an earnings amount');
  assert.equal((await recordSetterAttribution(db, admin, { ...body, requestId: uuid() }, now, {}, options)).duplicate, true);
  await assert.rejects(recordSetterAttribution(db, admin, { ...body, setterKey: 'rep.two' }, now, {}, options), { code: 'knock_setter_conflict' });
  await assert.rejects(recordSetterAttribution(db, admin, { ...body, requestId: uuid(), setterKey: 'rep.two' }, now, {}, options), { code: 'knock_setter_conflict' });
  await assert.rejects(recordSetterAttribution(db, admin, { ...body, walkthroughId: 'walk-2' }, now, {}, options), { code: 'knock_setter_conflict' });
});

test('a canonical walkthrough and reviewed classification are required for setter attribution', async () => {
  const db = store(), body = { ...record(), requestId: uuid() };
  await assert.rejects(recordSetterAttribution(db, admin, body, now, {}, { readJob: async () => null }), { code: 'knock_setter_walkthrough' });
  await assert.rejects(recordSetterAttribution(db, admin, { ...body, classificationReference: '' }, now, {}, { readJob: async () => visit() }), { code: 'knock_setter_scope' });
  await assert.rejects(recordSetterAttribution(db, admin, { ...body, setterKey: 'unknown' }, now, {}, { readJob: async () => visit() }), { code: 'knock_setter_rep' });
});

test('booking, no-show and unclosed quotes never earn setter commission', () => {
  for (const outcome of [undefined, 'customer_no_show', 'not_interested']) {
    const source = { ...visit(), convertedJobId: null, walkthroughOutcome: outcome ? { outcome } : null };
    const row = projectSetterAttribution(record(), source, null, [], Date.parse(now));
    assert.equal(row.earnedCommission, 0);
    assert.equal(row.payableCommission, 0);
    assert.equal(row.qualifyingAt, null);
  }
  assert.equal(projectSetterAttribution(record(), visit(), { ...job(), estimate: { status: 'draft' } }).state, 'awaiting_close');
});

test('closed and collected setter work is separate from estimator credit and held for the unanswered stacking policy', () => {
  const row = projectSetterAttribution(record(), visit(), job(), [], Date.parse(now));
  assert.equal(row.rate, 0.12);
  assert.equal(row.setterKey, 'rep.one');
  assert.equal(row.estimatorKey, null, 'the quote recorder is not assumed to be the estimator');
  assert.equal(row.closingActorKey, 'estimator.one');
  assert.equal(row.estimatorEvidence, 'unverified');
  const attributed = projectSetterAttribution({ ...record(), estimatorKey: 'estimator.two', estimatorReference: 'synthetic-roster-review' }, visit(), job(), [], Date.parse(now));
  assert.equal(attributed.estimatorKey, 'estimator.two');
  assert.equal(attributed.estimatorEvidence, 'admin_recorded_unreconciled');
  assert.equal(row.customerCollectedRevenue, 1000);
  assert.equal(row.qualifyingAt, new Date(now).toISOString());
  assert.equal(row.earnedCommission, null);
  assert.equal(row.payableCommission, null);
  assert.ok(row.reviewReasons.includes('estimator_stacking_unconfigured'));
  const duplicate = job(); duplicate.payment.stripeSessions.push({ ...duplicate.payment.stripeSessions[0] });
  assert.equal(projectSetterAttribution(record(), visit(), duplicate, [], Date.parse(now)).customerCollectedRevenue, 1000);
});

test('junk, partial/refunded receipts, conflicting direct-sale credit and missing links stay safe', () => {
  assert.equal(projectSetterAttribution({ ...record(), serviceClassification: 'junk_removal' }, visit(), job()).earnedCommission, 0);
  const partial = job(); partial.payment.amount = partial.payment.stripeSessions[0].amount = 200;
  assert.ok(projectSetterAttribution(record(), visit(), partial).reviewReasons.includes('partial_collection_policy_unconfigured'));
  const refunded = job(); refunded.payment.refundedAmount = 20;
  assert.ok(projectSetterAttribution(record(), visit(), refunded).reviewReasons.includes('collection_unverified'));
  const direct = [{ repKey: 'rep.one', handoff: { job: { ref: 'job-1' } } }];
  const conflict = projectSetterAttribution(record(), visit(), job(), direct);
  assert.equal(conflict.directSaleRepKey, 'rep.one');
  assert.ok(conflict.reviewReasons.includes('direct_close_attribution_conflict'));
  assert.equal(conflict.payableCommission, null, '25% and 12% are never combined');
  assert.ok(projectSetterAttribution(record(), visit(), { ...job(), sourceWalkthroughId: 'another' }).reviewReasons.includes('conversion_link_unverified'));
  assert.ok(projectSetterAttribution(record(), visit(), { ...job(), type: 'walkthrough' }).reviewReasons.includes('conversion_link_unverified'));
  assert.ok(projectSetterAttribution({ ...record(), serviceClassification: 'unverified' }, visit(), job()).reviewReasons.includes('service_scope_unverified'));
});

test('setter reads stay scoped, source failure is visible, and reps cannot confirm attribution', async () => {
  const env = knockEnv(), world = knockWorld({
    'knock_setters/walk-1': record(), 'knock_setters/walk-2': { ...record(), walkthroughId: 'walk-2', setterKey: 'rep.two' },
  });
  const rows = await setterAttributions(world.storage(env), env, { repKey: 'rep.one', readJob: async () => { throw new Error('unavailable'); } });
  assert.deepEqual(rows.rows.map(row => row.setterKey), ['rep.one']);
  assert.deepEqual(rows.rows[0].reviewReasons, ['source_unavailable']);
  assert.equal(rows.rows[0].earnedCommission, null);
  const handlers = knockAdminHandlers({ storage: world.storage });
  const result = await call(handlers.post, post('/api/knock-admin', { action: 'setter.record', ...record(), requestId: uuid() }, await cookieFor(env, 'Rep.One')), env);
  assert.equal(result.status, 403);
});
