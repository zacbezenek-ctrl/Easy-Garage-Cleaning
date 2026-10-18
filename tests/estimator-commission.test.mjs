// R8 / D6b: the estimator's 7%, on a walkthrough a door-to-door rep set (through its setter record) and on one the
// estimator sold directly (their signed handoff): a projection, the office view (Knock Admin > Estimators) and the
// estimator's own read-only view (GET /api/estimator-commission, Hub > My commission). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTER_CONTRACT, SETTER_TERMS } from '../crew/knock-money.js';
import { estimatorLedger, estimatorView, projectEstimatorJob } from '../functions/_lib/estimator-commission.js';
import { createKnockStore } from '../functions/_lib/knock-store.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { estimatorCommissionHandlers } from '../functions/api/estimator-commission.js';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { approvedKnockSettings, call, cookieFor, get, knockEnv } from './helpers/knock-fixture.mjs';

const NOW = '2026-10-21T18:00:00.000Z', APPROVED_AT = '2026-10-20T16:00:00.000Z';
const env = knockEnv({ HUB_AUTH_USERS_JSON: JSON.stringify({
  ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Zac' },
  'Rep.One': { passwordHash: 'test', role: 'sales', displayName: 'Rep One' },
  'Estimator.One': { passwordHash: 'test', role: 'sales', displayName: 'Estimator One' },
  'Estimator.Two': { passwordHash: 'test', role: 'sales', displayName: 'Estimator Two' },
}) });
const job = (id, walkthroughId, amount, signer = 'Estimator.One', extra = {}) => ({ type: 'job', status: 'scheduled', date: '2026-10-19', sourceWalkthroughId: walkthroughId,
  handoffVersion: 1, handoffRequestId: `req${id}`, serviceType: 'Garage transformation', customer: 'Synthetic Customer', phone: '9705550100',
  estimate: { status: 'accepted', amount, acceptedAt: '2026-10-17T15:00:00Z' }, acceptance: { recordedBy: signer, acceptedAt: '2026-10-17T14:55:00Z' },
  payment: { amount, verified: true, stripeSessions: [{ sessionId: `cs_test_${id}`, paymentIntentId: `pi_${id}`, amount, purpose: 'balance', verifiedAt: '2026-10-19T20:00:00Z' }] }, ...extra });
const visit = convertedJobId => ({ type: 'walkthrough', status: 'completed', convertedJobId, walkthroughOutcome: { outcome: 'sold_on_site' } });
const receipt = (actorId, jobId, sourceWalkthroughId, createdAt = '2026-10-17T15:00:00.000Z') => ({ actorId, jobId, sourceWalkthroughId, createdAt, signature: 'data:image/png;base64,AAAA', plan: { client: { phone: '9705550100' } } });

function world({ approved = true } = {}) {
  const unpaid = job('j4', 'w4', 1000); delete unpaid.payment;
  const fake = firestoreRest({
    'knock_settings/current': { ...approvedKnockSettings(), ...(approved ? { setterApproval: { contract: SETTER_CONTRACT, reference: 'synthetic-d6b-record', reviewedBy: 'ZacB', reviewedAt: APPROVED_AT, terms: { ...SETTER_TERMS } } } : {}) },
    'knock_reps/rep.one': { repKey: 'rep.one', displayName: 'Rep One', status: 'active' },
    // w1: set at the door by rep.one (the bridge's record names the estimator); w2, w4: sold directly; w3: another estimator's sale.
    'knock_setters/w1': { walkthroughId: 'w1', setterKey: 'rep.one', serviceClassification: 'unverified', classificationReference: '', estimatorKey: 'estimator.one', estimatorReference: 'knock-walkthrough:kw-1', channel: 'appointment_setter' },
    'jobs/w1': visit('j1'), 'jobs/j1': job('j1', 'w1', 3000),
    'jobs/w2': visit('j2'), 'jobs/j2': job('j2', 'w2', 1234.56),
    'jobs/w3': visit('j3'), 'jobs/j3': job('j3', 'w3', 2000, 'Estimator.Two'),
    'jobs/w4': visit('j4'), 'jobs/j4': unpaid,
    'walkthroughHandoffs/r1': receipt('Estimator.One', 'j1', 'w1'), 'walkthroughHandoffs/r2': receipt('Estimator.One', 'j2', 'w2'),
    'walkthroughHandoffs/r2b': receipt('Estimator.One', 'j2', 'w2', '2026-10-18T15:00:00.000Z'),
    'walkthroughHandoffs/r3': receipt('Estimator.Two', 'j3', 'w3'), 'walkthroughHandoffs/r4': receipt('Estimator.One', 'j4', 'w4'),
    'walkthroughHandoffs/old': receipt('Estimator.Two', 'j3', 'w3', '2025-01-01T00:00:00.000Z'),
  });
  return { fake, knock: () => createKnockStore(env, fake.fetcher), dispatch: () => dispatchStorage(env, fake.fetcher) };
}
const hub = w => estimatorCommissionHandlers({ knock: () => w.knock(), dispatch: () => w.dispatch(), now: () => new Date(NOW) });
const mine = async (w, user = 'Estimator.One') => call(hub(w).get, get('/api/estimator-commission', await cookieFor(env, user)), env);

test('the estimator\'s own view: their 7% on a rep-set walkthrough and on their direct sales, held with no amount until the owner approves', async () => {
  const held = (await mine(world({ approved: false }))).body;
  assert.equal(held.terms.verified, false);
  assert.deepEqual(held.rows.map(row => [row.jobId, row.channel, row.state, row.projectedCommission, row.earnedCommission, row.reviewReasons]), [
    ['j2', 'direct', 'review_required', null, null, ['commission_terms_unapproved']],
    ['j4', 'direct', 'awaiting_collection', null, null, []],
    ['j1', 'door_to_door', 'review_required', null, null, ['service_scope_unverified']]], 'the setter record\'s own hold, exactly as before');
  assert.deepEqual(held.totals, { projected: 0, earned: 0 });
  const body = (await mine(world())).body;
  assert.deepEqual([body.terms.verified, body.terms.percent, body.terms.approvedAt], [true, 7, APPROVED_AT]);
  assert.deepEqual(body.rows.map(row => [row.jobId, row.jobDate, row.channel, row.state, row.projectedCommission, row.earnedCommission, row.earnedAt]), [
    ['j1', '2026-10-19', 'door_to_door', 'earned', 210, 210, APPROVED_AT],
    ['j2', '2026-10-19', 'direct', 'earned', 86.42, 86.42, APPROVED_AT],
    ['j4', '2026-10-19', 'direct', 'awaiting_collection', 70, null, null]]);
  assert.deepEqual(body.totals, { projected: 70, earned: 296.42 });
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /rep\.one|Rep One|estimator\.two|j3|Synthetic Customer|9705550100|setterKey|39000|390/, 'no setter, other estimator, customer or the setter\'s share');
});

test('the estimator\'s view reads only their own signed receipts and setter records; another estimator sees only theirs; sign-in is required', async () => {
  const w = world();
  await mine(w);
  const queries = w.fake.queries('walkthroughHandoffs').map(item => item.body.structuredQuery.where.fieldFilter);
  assert.deepEqual(queries.map(filter => [filter.field.fieldPath, filter.op, filter.value.stringValue]), [['actorId', 'EQUAL', 'Estimator.One']]);
  assert.deepEqual(queries.length && w.fake.queries('walkthroughHandoffs')[0].body.structuredQuery.select.fields.map(field => field.fieldPath), ['kind', 'actorId', 'jobId', 'sourceWalkthroughId', 'createdAt'], 'never the signature or plan');
  assert.equal(w.fake.scans('jobs').length + w.fake.scans('walkthroughHandoffs').length, 0, 'no collection scan');
  const other = (await mine(world(), 'Estimator.Two')).body;
  assert.deepEqual(other.rows.map(row => [row.jobId, row.state, row.earnedCommission]), [['j3', 'earned', 140]]);
  const rep = (await mine(world(), 'Rep.One')).body;
  assert.deepEqual(rep.rows, [], 'a rep who set the walkthrough is not its estimator');
  const anonymous = await call(hub(world()).get, get('/api/estimator-commission'), env);
  assert.deepEqual([anonymous.status, anonymous.body.code], [401, 'estimator_commission_sign_in']);
  const broken = estimatorCommissionHandlers({ knock: () => world().knock(), dispatch: () => ({ handoffLedger: async () => { throw new Error('down'); } }), now: () => new Date(NOW) });
  const failed = await call(broken.get, get('/api/estimator-commission', await cookieFor(env, 'Estimator.One')), env);
  assert.deepEqual([failed.status, failed.body.code], [503, 'estimator_commission_unavailable'], 'a read failure is never shown as no commission');
});

test('the office view lists every estimator\'s 7% signed in the last year, with the estimator and setter named; admins only', async () => {
  const w = world();
  const handlers = knockAdminHandlers({ storage: () => w.knock(), dispatch: () => w.dispatch(), now: () => new Date(NOW) });
  const data = (await call(handlers.get, get('/api/knock-admin?view=estimators', await cookieFor(env, 'ZacB')), env)).body;
  assert.deepEqual([data.terms.verified, data.lookbackDays, data.truncated], [true, 365, false]);
  assert.deepEqual(data.rows.map(row => [row.jobId, row.channel, row.estimatorKey, row.setterKey ?? null, row.state, row.earnedCommission]).sort(), [
    ['j1', 'appointment_setter', 'estimator.one', 'rep.one', 'earned', 210],
    ['j2', 'direct_estimator', 'estimator.one', null, 'earned', 86.42],
    ['j3', 'direct_estimator', 'estimator.two', null, 'earned', 140],
    ['j4', 'direct_estimator', 'estimator.one', null, 'awaiting_collection', null]]);
  const ranged = w.fake.queries('walkthroughHandoffs').at(-1).body.structuredQuery.where.fieldFilter;
  assert.deepEqual([ranged.field.fieldPath, ranged.op, ranged.value.stringValue], ['createdAt', 'GREATER_THAN_OR_EQUAL', '2025-10-21']);
  const rep = await call(handlers.get, get('/api/knock-admin?view=estimators', await cookieFor(env, 'Rep.One')), env);
  assert.equal(rep.status, 403);
});

test('a direct sale\'s projection: 7% of the closed price, never stacked on a setter record, junk or a short payment held', () => {
  const terms = { verified: true, approvedAt: APPROVED_AT, reference: 'synthetic' }, at = Date.parse(NOW);
  const row = projectEstimatorJob({ ...job('j9', 'w9', 3000), id: 'j9', revision: 'r' }, { terms, nowMs: at });
  assert.deepEqual([row.channel, row.estimatorKey, row.estimatorEvidence, row.state, row.earnedCommission, row.qualifyingAt], ['direct_estimator', 'estimator.one', 'handoff_signer', 'earned', 210, '2026-10-19T20:00:00.000Z']);
  const later = projectEstimatorJob({ ...job('j9', 'w9', 3000), id: 'j9', revision: 'r' }, { terms: { ...terms, approvedAt: '2026-10-01T00:00:00.000Z' }, nowMs: at });
  assert.equal(later.earnedAt, '2026-10-19T20:00:00.000Z', 'earned when paid, after an earlier approval');
  assert.deepEqual(projectEstimatorJob({ ...job('j9', 'w9', 3000, 'Estimator.One', { serviceType: 'Junk removal' }), id: 'j9', revision: 'r' }, { terms, nowMs: at }).reviewReasons, ['service_scope_unverified']);
  const short = job('j9', 'w9', 3000); short.payment.amount = short.payment.stripeSessions[0].amount = 1000;
  assert.deepEqual(projectEstimatorJob({ ...short, id: 'j9', revision: 'r' }, { terms, nowMs: at }).reviewReasons, ['partial_collection_policy_unconfigured']);
  assert.deepEqual(projectEstimatorJob({ ...job('j9', '', 3000), id: 'j9', revision: 'r' }, { terms, nowMs: at }).reviewReasons, ['conversion_link_unverified'], 'a sale with no walkthrough is not a walkthrough sale');
  const unsigned = projectEstimatorJob({ ...job('j9', 'w9', 3000, ''), id: 'j9', revision: 'r' }, { terms, nowMs: at });
  assert.deepEqual([unsigned.state, unsigned.reviewReasons], ['review_required', ['recipient_unverified']]);
  assert.equal(estimatorView({ rows: [], truncated: false }, null).terms.verified, false);
});

test('one job pays one estimator share: a walkthrough with a setter record is never also a direct sale', async () => {
  const w = world();
  const ledger = await estimatorLedger({ kstore: w.knock(), dispatch: w.dispatch(), env, since: '2025-10-21', terms: { verified: true, approvedAt: APPROVED_AT, reference: 'x' }, nowMs: Date.parse(NOW) });
  assert.equal(ledger.rows.filter(row => row.jobId === 'j1').length, 1);
  assert.deepEqual(ledger.setters.rows.map(row => row.allocations.map(item => [item.role, item.amountCents])), [[['setter', 39000], ['estimator', 21000]]]);
});
