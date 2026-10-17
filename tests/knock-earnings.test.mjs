import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_SETTINGS } from '../crew/knock-settings.js';
import { CHANNEL_PERCENTS, SETTER_RULE_TEXT, commissionEligibility, commissionIssues, commissionRuleText, customerCollection, earnedAt, isEarned, payPeriodFor, periodStatement, projectedCommission, saleCommissions, leadOverrides, snapshotCommissionTerms } from '../crew/knock-money.js';
import { loadSettings } from '../functions/_lib/knock-access.js';
import { createKnockStore } from '../functions/_lib/knock-store.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { recordSaleCollection, setSaleStatus } from '../functions/_lib/knock-sales.js';
import { addPayout } from '../functions/_lib/knock-reports.js';
import { saleSyncSummary } from '../functions/_lib/knock-handoff.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { knockReportsHandlers } from '../functions/api/knock-reports.js';
import { approvedKnockSettings, approvedKnockTerms, call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

const now = '2026-10-20T18:00:00Z', nowMs = Date.parse(now), admin = { user: 'test-owner' };
const paid = (patch = {}) => ({ id: 'sale-1', repKey: 'rep.one', leadKey: '', ticket: 1600,
  commissionTerms: approvedKnockTerms(),
  saleDate: '2026-10-19', soldAt: '2026-10-19T12:00:00Z', status: 'paid',
  cancelEndsAt: '2026-10-19T00:00:00Z', completedAt: '2026-10-19T18:00:00Z',
  paidAt: '2026-10-19T19:00:00Z', collectedAmount: 1600, handoff: {}, ...patch });
const statement = (sales, payouts = [], settings = DEFAULT_SETTINGS, date = '2026-10-20') => periodStatement({
  sales, payouts, settings, period: payPeriodFor(date, settings.payroll), now: nowMs,
  reps: [{ repKey: 'rep.one', status: 'active' }],
}).find(r => r.repKey === 'rep.one');

test('percentages alone do not configure compensation terms', async () => {
  for (const document of [null, { settings: DEFAULT_SETTINGS }, { ...approvedKnockSettings(), compensationApproval: undefined }]) {
    const settings = await loadSettings({ get: async () => document });
    assert.equal(settings.commission.verified, false);
    assert.equal(settings.commission.approvedAt, null);
    assert.equal(settings.commission.scope, null);
    assert.equal(settings.commission.collectionPolicy, null);
    assert.equal(settings.payroll.anchorVerified, false);
    const row = statement([paid()], [{ id: 'p', repKey: 'rep.one', periodKey: '2026-10-19_2026-11-01', amount: 80 }], settings);
    assert.deepEqual([row.projectedCommission, row.earnedCommission, row.payableCommission], [null, null, null]);
    assert.equal(row.commissionPaid, 80);
    assert.equal(row.customerCollectedRevenue, 1600);
  }
});

test('synthetic policy approval is bound to the exact settings and invalidated by an edit', async () => {
  const doc = approvedKnockSettings();
  doc.compensationApproval.commission = Object.fromEntries(Object.entries(doc.compensationApproval.commission).reverse());
  assert.equal((await loadSettings({ get: async () => doc })).commission.verified, true);
  doc.settings.commission.rate = 0.4;
  assert.equal((await loadSettings({ get: async () => doc })).commission.verified, false);
});

test('explicit stored deposit and compensation settings override defaults without migration', async () => {
  const doc = approvedKnockSettings();
  doc.settings.sale.depositRate = 0.2;
  doc.settings.commission.acceleratorEnabled = doc.compensationApproval.commission.acceleratorEnabled = true;
  doc.settings.commission.leadOverrideEnabled = doc.compensationApproval.commission.leadOverrideEnabled = true;
  const before = JSON.stringify(doc);
  const settings = await loadSettings({ get: async () => doc });
  assert.deepEqual([settings.sale.depositRate, settings.commission.acceleratorEnabled, settings.commission.leadOverrideEnabled], [0.2, true, true]);
  assert.equal(settings.commission.verified, true, 'an existing exact approval is not silently rewritten');
  assert.equal(JSON.stringify(doc), before);
});

test('current rate and override changes cannot recalculate historical sale terms', async () => {
  const original = approvedKnockSettings();
  original.settings.commission.acceleratorEnabled = original.compensationApproval.commission.acceleratorEnabled = true;
  original.settings.commission.leadOverrideEnabled = original.compensationApproval.commission.leadOverrideEnabled = true;
  const settings = await loadSettings({ get: async () => original });
  const snapshot = snapshotCommissionTerms(settings.commission, undefined, 'Garage Transformation');
  assert.ok(snapshot);
  const oldSale = paid({ leadKey: 'lead.one', package: 'Garage Transformation', commissionTerms: snapshot });
  const changed = { ...settings, commission: { ...settings.commission, rate: 0.8, acceleratorEnabled: false, acceleratorRate: 0.9, leadOverrideEnabled: false, leadOverrideRate: 0.2 } };
  assert.equal(statement([oldSale], [], changed).earnedCommission, 400);
  assert.equal(leadOverrides([oldSale], changed.commission, { now: nowMs })[0].amount, 48);
  const largerSale = { ...oldSale, ticket: 10000, collectedAmount: 10000 };
  assert.equal(saleCommissions([largerSale], changed.commission, { now: nowMs })[0].total, 2600);
  assert.equal(snapshot.policy.rate, 0.25);
  assert.equal(snapshotCommissionTerms({ ...changed.commission, verified: false }), null);
  assert.equal(snapshotCommissionTerms(settings.commission, '2026-09-30T12:00:00Z', 'Garage Transformation'), null, 'offline history cannot receive a later approval');
  assert.equal(snapshotCommissionTerms(settings.commission, now), null, 'missing package identity cannot become signed eligibility');
});

test('legacy sales without approved terms require review even after current settings are approved', async () => {
  const settings = await loadSettings({ get: async () => approvedKnockSettings() });
  const row = statement([paid({ commissionTerms: null })], [], settings);
  assert.equal(row.earnedCommission, null);
  assert.equal(row.projectedCommission, null);
  assert.equal(row.payableCommission, null);
  assert.ok(row.reviewReasons.includes('commission_terms_missing_or_invalid'));
});

test('new terms earn at full collection without inventing a completion or cancellation-delay condition', async () => {
  const settings = await loadSettings({ get: async () => approvedKnockSettings() });
  const sale = paid({ package: 'Garage Transformation', status: 'booked', completedAt: null, cancelEndsAt: '2026-10-25T00:00:00Z',
    commissionTerms: snapshotCommissionTerms(settings.commission, '2026-10-19T12:00:00Z', 'Garage Transformation') });
  assert.equal(isEarned(sale, nowMs), true);
  assert.equal(earnedAt(sale), Date.parse(sale.paidAt));
  assert.equal(statement([sale], [], settings).earnedCommission, 400);
  for (const patch of [{ collectedAmount: 320, completedAt: '2026-10-19T18:00:00Z' }, { collectedAmount: 320, status: 'completed' }, { collectedAmount: 1700 },
    { refundedAmount: 20 }, { status: 'cancelled' }, { paidAt: null }]) {
    const changed = { ...sale, ...patch };
    assert.equal(isEarned(changed, nowMs), false);
    assert.equal(statement([changed], [], settings).payableCommission, null, JSON.stringify(patch));
  }
  // A running receipt on a job still in progress is not earned yet; it is not a partial-collection review.
  const running = { ...sale, collectedAmount: 320 };
  assert.equal(isEarned(running, nowMs), false);
  const held = statement([running], [], settings);
  assert.deepEqual([held.earnedCommission, held.pending, held.payableCommission, held.compensationState, held.reviewReasons], [0, 400, 0, 'configured', []]);
});

test('collection timing does not rewrite v1 or v2 signed earning conditions', async () => {
  const settings = await loadSettings({ get: async () => approvedKnockSettings() });
  const snapshot = snapshotCommissionTerms(settings.commission, '2026-10-19T12:00:00Z', 'Garage Transformation');
  for (const terms of [approvedKnockTerms(), { ...snapshot, contract: 'knock-garage-v2' }]) {
    const sale = paid({ package: 'Garage Transformation', commissionTerms: terms, completedAt: '2026-10-25T18:00:00Z', cancelEndsAt: '2026-10-24T00:00:00Z' });
    const before = JSON.stringify(sale);
    assert.equal(isEarned(sale, nowMs), false);
    assert.equal(earnedAt(sale), Date.parse(sale.completedAt));
    assert.equal(isEarned(sale, Date.parse('2026-10-26T00:00:00Z')), true);
    assert.equal(JSON.stringify(sale), before);
  }
});

test('two-week cadence never silently approves a default anchor, base or attribution', async () => {
  for (const gap of ['anchor', 'base', 'attribution', 'cadence']) {
    const doc = approvedKnockSettings();
    if (gap === 'anchor') delete doc.compensationApproval.payrollAnchorConfirmed;
    if (gap === 'base') delete doc.compensationApproval.collectionPolicy.calculationBase;
    if (gap === 'attribution') delete doc.compensationApproval.collectionPolicy.attribution;
    if (gap === 'cadence') doc.settings.payroll.period = doc.compensationApproval.payroll.period = 'weekly';
    const settings = await loadSettings({ get: async () => doc });
    assert.equal(settings.commission.verified, false);
    assert.deepEqual(settings.commission.knownPolicy, { earnedOn: 'customer_collection', payoutCadence: 'biweekly' });
    assert.equal(settings.payroll.anchorVerified, false);
    assert.equal(payPeriodFor('2026-10-20', settings.payroll).configured, false);
    const world = knockWorld({ 'knock_settings/current': doc }), env = knockEnv();
    const handlers = knockAdminHandlers({ storage: world.storage, now: () => new Date(now) });
    const result = await call(handlers.get, get('/api/knock-admin?view=export&kind=commission', await cookieFor(env, 'ZacB')), env);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'knock_payroll_unconfigured');
  }
  const settings = await loadSettings({ get: async () => approvedKnockSettings() });
  const period = payPeriodFor('2026-10-20', settings.payroll);
  assert.equal((Date.parse(period.end) - Date.parse(period.start)) / 86400000 + 1, 14);
});

test('current approval requires garage-only D2D scope and cannot stack or substitute estimator rates', async () => {
  const mutations = [
    doc => { doc.compensationApproval.contract = 'knock-v1'; },
    doc => { delete doc.compensationApproval.scope; },
    doc => { doc.compensationApproval.scope.channel = 'direct_estimator'; },
    doc => { doc.compensationApproval.scope.estimatorStacking = true; },
    doc => { doc.compensationApproval.scope.junkRemovalPackages = ['The Works']; },
    doc => { doc.settings.commission.rate = doc.compensationApproval.commission.rate = 0.32; },
    doc => { doc.settings.commission.rate = doc.compensationApproval.commission.rate = 0.07; },
  ];
  for (const mutate of mutations) {
    const doc = approvedKnockSettings(); mutate(doc);
    assert.equal((await loadSettings({ get: async () => doc })).commission.verified, false);
  }
});

test('junk receipts never produce commission, lead overrides or accelerator progress under current terms', async () => {
  const doc = approvedKnockSettings();
  doc.compensationApproval.scope.garageOnlyPackages = ['Garage Transformation'];
  doc.compensationApproval.scope.junkRemovalPackages = ['Quick Clear'];
  const settings = await loadSettings({ get: async () => doc });
  const currentSale = (id, packageName, ticket) => paid({ id, package: packageName, ticket, collectedAmount: ticket,
    leadKey: 'lead.one', commissionTerms: snapshotCommissionTerms(settings.commission, '2026-10-19T12:00:00Z', packageName) });
  const junk = currentSale('a-junk', 'Quick Clear', 10000), garage = currentSale('b-garage', 'Garage Transformation', 400);
  assert.equal(commissionEligibility(junk), 'excluded');
  assert.equal(isEarned(junk, nowMs), false);
  assert.equal(projectedCommission(junk, settings.commission), 0);
  assert.deepEqual(leadOverrides([junk], settings.commission, { now: nowMs }), []);
  const earnings = saleCommissions([junk, garage], settings.commission, { now: nowMs });
  assert.deepEqual(earnings.map(row => [row.saleId, row.total]), [['b-garage', 100]]);
  assert.equal(statement([junk, garage], [], settings).customerCollectedRevenue, 10400);
  const mixed = currentSale('mixed', 'Full Property Reset', 900);
  assert.equal(projectedCommission(mixed, settings.commission), null);
  const held = statement([mixed], [], settings);
  assert.equal(held.payableCommission, null);
  assert.ok(held.reviewReasons.includes('commission_scope_unverified'));
});

test('new eligibility cannot rewrite an existing signed snapshot or backfill unsnapshotted history', async () => {
  const doc = approvedKnockSettings();
  doc.compensationApproval.scope.garageOnlyPackages = ['Garage Transformation'];
  doc.compensationApproval.scope.junkRemovalPackages = ['Quick Clear'];
  const settings = await loadSettings({ get: async () => doc });
  const historical = paid({ package: 'Quick Clear' });
  const before = JSON.stringify(historical);
  assert.equal(statement([historical], [], settings).earnedCommission, 400);
  assert.equal(JSON.stringify(historical), before);
  assert.equal(statement([paid({ commissionTerms: null, package: 'Garage Transformation' })], [], settings).payableCommission, null);
  const frozenGarage = paid({ package: 'Garage Transformation', commissionTerms: snapshotCommissionTerms(settings.commission, '2026-10-19T12:00:00Z', 'Garage Transformation') });
  settings.commission.scope.garageOnlyPackages = ['The Works'];
  settings.commission.scope.junkRemovalPackages = ['Garage Transformation'];
  assert.equal(statement([frozenGarage], [], settings).earnedCommission, 400);
});

test('direct-estimator benchmarks cannot become D2D targets or a go/fix/stop verdict', async () => {
  for (const channel of [undefined, 'direct_estimator']) {
    const doc = approvedKnockSettings();
    if (channel) doc.planApproval.channel = channel; else delete doc.planApproval;
    const env = knockEnv(), world = knockWorld({ 'knock_settings/current': doc,
      'knock_reps/rep.one': { repKey: 'rep.one', status: 'active', role: 'knocker' } });
    const handlers = knockReportsHandlers({ storage: world.storage, now: () => new Date(now) });
    const result = await call(handlers.get, get('/api/knock-reports?view=scoreboard', await cookieFor(env, 'ZacB')), env);
    assert.equal(result.status, 200);
    assert.equal(result.body.benchmarkState, 'unconfigured');
    assert.equal(result.body.planTargets, null);
    assert.deepEqual(result.body.totals.plan, []);
    assert.equal(result.body.gate, undefined);
  }
});

test('malformed receipt history is held for review, not paid or silently dropped', () => {
  for (const collectionHistory of [[null], [{ total: 1600, previousTotal: 1000, at: 'invalid' }], { length: 1 }]) {
    const row = statement([paid({ collectionHistory })]);
    assert.equal(row.payableCommission, null);
    assert.ok(row.reviewReasons.includes('collection_history_invalid'));
  }
});

test('customer collection, earned commission, payable and rep paid remain separate', () => {
  const periodKey = '2026-10-19_2026-11-01';
  const payout = { id: 'p1', repKey: 'rep.one', periodKey, amount: 75 };
  const row = statement([paid(), paid()], [payout, payout]);
  assert.deepEqual([row.projectedCommission, row.customerCollectedRevenue, row.earnedCommission, row.payableCommission, row.commissionPaid], [400, 1600, 400, 325, 75]);
});

test('missing, partial, overpaid and incomplete receipts never earn commission', () => {
  for (const patch of [{ collectedAmount: null }, { collectedAmount: 320 }, { collectedAmount: 1700 }, { completedAt: null }, { cancelEndsAt: null }, { paidAt: null }]) {
    const sale = paid(patch);
    assert.equal(isEarned(sale, nowMs), false, JSON.stringify(patch));
    assert.deepEqual(saleCommissions([sale], DEFAULT_SETTINGS.commission, { now: nowMs }), []);
    assert.equal(statement([sale]).payableCommission, null);
  }
  assert.equal(customerCollection(paid({ collectedAmount: null })).gross, null, 'no ticket fallback');
});

test('refund and cancellation preserve customer receipts and prior rep payments without inventing clawback', () => {
  for (const patch of [{ refundedAmount: 300, refundedAt: now }, { status: 'cancelled' },
    { statusHistory: [{ status: 'booked' }, { status: 'cancelled' }, { status: 'booked' }, { status: 'paid' }] }]) {
    const row = statement([paid(patch)], [{ id: 'p', repKey: 'rep.one', periodKey: '2026-10-19_2026-11-01', amount: 400 }]);
    assert.equal(row.customerCollectedRevenue, 1600);
    assert.equal(row.commissionPaid, 400);
    assert.equal(row.payableCommission, null);
    assert.equal(row.compensationState, 'review_required');
  }
});

test('deposit is included in final collection, not added twice', () => {
  const handoff = { deposit: { status: 'collected', collectedAmount: 320, verifiedBy: 'stripe', collectedAt: now } };
  assert.equal(customerCollection(paid({ handoff })).gross, 1600);
  assert.equal(customerCollection(paid({ handoff, collectedAmount: null })).gross, 320);
  assert.equal(customerCollection(paid({ collectedAmount: null, handoff: { deposit: { ...handoff.deposit, verifiedBy: '' } } })).gross, null);
});

test('partial receipts cross pay periods once; collecting does not complete the job', async () => {
  const env = knockEnv(), world = knockWorld({ 'knock_sales/sale-1': paid({ status: 'booked', completedAt: null, paidAt: null, collectedAmount: null, saleDate: '2026-10-06' }) });
  const store = world.storage(env);
  const first = await recordSaleCollection(store, admin, { saleId: 'sale-1', collectedAmount: 320 }, '2026-10-10T18:00:00Z');
  assert.equal(first.sale.status, 'booked');
  assert.equal(first.sale.completedAt, null);
  assert.equal((await recordSaleCollection(store, admin, { saleId: 'sale-1', collectedAmount: 320 }, now)).duplicate, true);
  const second = await recordSaleCollection(store, admin, { saleId: 'sale-1', collectedAmount: 1600 }, now);
  assert.equal(second.sale.status, 'booked');
  assert.equal(statement([second.sale], [], DEFAULT_SETTINGS, '2026-10-06').customerCollectedRevenue, 320);
  assert.equal(statement([second.sale]).customerCollectedRevenue, 1280);
  const completed = await setSaleStatus(store, admin, { saleId: 'sale-1', status: 'completed' }, now);
  assert.equal(completed.sale.status, 'paid');
  assert.equal(isEarned(completed.sale, nowMs), true);
  await assert.rejects(recordSaleCollection(store, admin, { saleId: 'sale-1', collectedAmount: 1500 }, now), { code: 'knock_collection_review' });
});

test('status edits cannot invent completion or erase receipts on cancellation and reinstatement', async () => {
  const world = knockWorld({ 'knock_sales/sale-1': paid({ status: 'booked', completedAt: null }) }), store = world.storage(knockEnv());
  await assert.rejects(setSaleStatus(store, admin, { saleId: 'sale-1', status: 'paid', collectedAmount: 1600 }, now), { code: 'knock_completion_required' });
  await setSaleStatus(store, admin, { saleId: 'sale-1', status: 'cancelled' }, now);
  const reopened = await setSaleStatus(store, admin, { saleId: 'sale-1', status: 'booked' }, now);
  assert.equal(reopened.sale.collectedAmount, 1600);
  assert.equal(reopened.sale.paidAt, '2026-10-19T19:00:00Z');
});

test('rep payment retries are idempotent and conflicting request reuse is refused', async () => {
  const store = knockWorld({ 'knock_reps/rep.one': { repKey: 'rep.one' } }).storage(knockEnv());
  const body = { requestId: uuid(), repKey: 'rep.one', periodKey: '2026-10-19_2026-11-01', amount: 100, note: 'Synthetic recorded payment' };
  const results = await Promise.all([addPayout(store, admin, body, now), addPayout(store, admin, body, now)]);
  assert.equal(results.filter(r => r.duplicate).length, 1);
  await assert.rejects(addPayout(store, admin, { ...body, amount: 200 }, now), { code: 'knock_payout_conflict' });
});

test('a claimed HighLevel receipt is visibly uncertain and cannot be treated as a synced appointment', () => {
  const sync = saleSyncSummary(paid({ handoff: { text: { mode: 'highlevel', status: 'pending' } } }), { outcome: 'sending', updatedAt: now });
  assert.equal(sync.highlevel.state, 'uncertain');
  assert.equal(sync.highlevel.retryAllowed, false);
  assert.equal(sync.appointment, 'not_verified');
  assert.equal(saleSyncSummary(paid(), { outcome: 'rejected' }).highlevel.retryAllowed, true);
});

test('rep cannot write receipts or payouts, cannot select another rep, and failed storage is not zero earnings', async () => {
  const env = knockEnv();
  const world = knockWorld({ 'knock_reps/rep.one': { repKey: 'rep.one', status: 'active', role: 'knocker' },
    'knock_sales/other': paid({ repKey: 'rep.two' }) });
  const cookie = await cookieFor(env, 'Rep.One');
  const writes = knockAdminHandlers({ storage: world.storage });
  for (const action of ['sale.collection', 'payout.add']) {
    assert.equal((await call(writes.post, post('/api/knock-admin', { action, saleId: 'other', collectedAmount: 1600 }, cookie), env)).status, 403);
  }
  const reports = knockReportsHandlers({ storage: world.storage, now: () => new Date(now) });
  const result = await call(reports.get, get('/api/knock-reports?view=my-money&repKey=rep.two', cookie), env);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.sales, []);
  const broken = knockReportsHandlers({ storage: () => ({ get: async () => { throw new Error('Storage unavailable'); } }) });
  assert.notEqual((await call(broken.get, get('/api/knock-reports?view=my-money', cookie), env)).status, 200);
});

// Real Firestore replaces the whole document on a write without an updateMask; the shared
// REST fake merges. After each successful commit this wrapper replaces such documents, so a
// wholesale write shows up while create/updateTime preconditions still behave as before.
function replacingWorld(seed) {
  const world = knockWorld(seed);
  const fetcher = async (env, input, options = {}) => {
    const response = await world.fake.fetcher(env, input, options);
    if (String(input).endsWith(':commit') && response.ok) for (const item of JSON.parse(options.body).writes || []) {
      if (item.update && !item.updateMask) world.fake.put(item.update.name.split('/documents/')[1], decodeFirestoreFields(item.update.fields || {}));
    }
    return response;
  };
  return { ...world, storage: env => createKnockStore(env, fetcher) };
}

test('saving unrelated settings keeps the owner compensation and plan approvals (V6)', async () => {
  const env = knockEnv(), seed = approvedKnockSettings(), world = replacingWorld({ 'knock_settings/current': seed });
  const handlers = knockAdminHandlers({ storage: world.storage, now: () => new Date(now) }), cookie = await cookieFor(env, 'ZacB');
  const view = await call(handlers.get, get('/api/knock-admin?view=settings', cookie), env);
  assert.equal(view.body.compensation.verified, true);
  const settings = structuredClone(view.body.settings);
  settings.map.attribution = 'Synthetic tiles';
  settings.sale.extraHolidays = ['2026-12-24'];
  const saved = await call(handlers.post, post('/api/knock-admin', { action: 'settings.update', settings }, cookie), env);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.compensation, { verified: true, approvalInvalidated: false });
  const commit = world.fake.calls.filter(item => item.path === ':commit').at(-1).body.writes[0];
  assert.deepEqual(commit.updateMask.fieldPaths.sort(), ['settings', 'updatedAt', 'updatedBy']);
  const doc = world.fake.get('knock_settings/current');
  assert.deepEqual(doc.compensationApproval, seed.compensationApproval);
  assert.deepEqual(doc.planApproval, seed.planApproval);
  assert.equal(doc.settings.map.attribution, 'Synthetic tiles');
  const loaded = await loadSettings({ get: async () => doc });
  assert.equal(loaded.commission.verified, true);
  assert.equal(loaded.plan.verified, true);
  // Changing the approved terms keeps the record for audit, but it no longer verifies.
  settings.commission.rate = 0.27;
  const changed = await call(handlers.post, post('/api/knock-admin', { action: 'settings.update', settings }, cookie), env);
  assert.deepEqual(changed.body.compensation, { verified: false, approvalInvalidated: true });
  assert.deepEqual(world.fake.get('knock_settings/current').compensationApproval, seed.compensationApproval);
  assert.equal((await loadSettings({ get: async () => world.fake.get('knock_settings/current') })).commission.verified, false);
});

test('a first settings save creates the document without inventing an approval', async () => {
  const env = knockEnv(), world = replacingWorld({}), cookie = await cookieFor(env, 'ZacB');
  const handlers = knockAdminHandlers({ storage: world.storage, now: () => new Date(now) });
  const saved = await call(handlers.post, post('/api/knock-admin', { action: 'settings.update', settings: structuredClone(DEFAULT_SETTINGS) }, cookie), env);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.compensation, { verified: false, approvalInvalidated: false });
  const doc = world.fake.get('knock_settings/current');
  assert.deepEqual([doc.updatedBy, doc.updatedAt, doc.compensationApproval, doc.planApproval], ['ZacB', new Date(now).toISOString(), undefined, undefined]);
});

const v3 = async (doc = approvedKnockSettings()) => {
  const settings = await loadSettings({ get: async () => doc });
  const terms = soldAt => snapshotCommissionTerms(settings.commission, soldAt, 'Garage Transformation');
  return { settings, terms };
};

test('a later sale awaiting its balance leaves an earlier complete period payable (V7)', async () => {
  const { settings, terms } = await v3();
  const full = paid({ id: 's1', package: 'Garage Transformation', commissionTerms: terms('2026-10-06T12:00:00Z'), saleDate: '2026-10-06', soldAt: '2026-10-06T12:00:00Z',
    cancelEndsAt: '2026-10-09T00:00:00Z', completedAt: '2026-10-12T18:00:00Z', paidAt: '2026-10-12T19:00:00Z' });
  const depositOnly = { id: 's2', repKey: 'rep.one', leadKey: '', ticket: 2000, package: 'Garage Transformation', commissionTerms: terms('2026-10-25T12:00:00Z'),
    saleDate: '2026-10-25', soldAt: '2026-10-25T12:00:00Z', status: 'booked', collectedAmount: null, completedAt: null, paidAt: null,
    handoff: { deposit: { status: 'collected', verifiedBy: 'admin', collectedAmount: 500, collectedAt: '2026-10-25T13:00:00Z' } } };
  const at = (sales, date) => periodStatement({ sales, settings, period: payPeriodFor(date, settings.payroll), now: Date.parse('2026-10-30T00:00:00Z'),
    reps: [{ repKey: 'rep.one', status: 'active' }] }).find(r => r.repKey === 'rep.one');
  for (const sales of [[full], [full, depositOnly]]) {
    const row = at(sales, '2026-10-12');
    assert.deepEqual([row.earnedCommission, row.payableCommission, row.compensationState, row.reviewReasons], [400, 400, 'configured', []]);
  }
  const later = at([full, depositOnly], '2026-10-25');
  assert.deepEqual([later.earnedCommission, later.pending, later.payableCommission, later.compensationState, later.customerCollectedRevenue], [0, 500, 0, 'configured', 500]);
  // A genuine problem on the later sale holds only the period it touches.
  const refunded = { ...depositOnly, refundedAmount: 500, refundedAt: '2026-10-27T12:00:00Z' };
  assert.deepEqual([at([full, refunded], '2026-10-12').payableCommission, at([full, refunded], '2026-10-12').compensationState], [400, 'configured']);
  const held = at([full, refunded], '2026-10-25');
  assert.deepEqual([held.payableCommission, held.compensationState], [null, 'review_required']);
  assert.ok(held.reviewReasons.includes('refund_review'));
  // A refund recorded later still reopens the period in which that sale was earned.
  const reopened = { ...full, refundedAmount: 100, refundedAt: '2026-10-27T12:00:00Z' };
  assert.equal(at([reopened], '2026-10-12').payableCommission, null);
  assert.ok(at([reopened], '2026-10-12').reviewReasons.includes('refund_review'));
});

test('an unresolved receipt holds the rest of its month only where a monthly accelerator applies', () => {
  const earned = paid({ id: 'later', saleDate: '2026-10-19', soldAt: '2026-10-19T12:00:00Z', paidAt: '2026-10-20T12:00:00Z' });
  const issue = (id, day, month = '10') => paid({ id, saleDate: `2026-${month}-${day}`, soldAt: `2026-${month}-${day}T12:00:00Z`, completedAt: `2026-${month}-${day}T18:00:00Z`,
    cancelEndsAt: `2026-${month}-${day}T00:00:00Z`, paidAt: `2026-${month}-${day}T19:00:00Z`, refundedAmount: 50, refundedAt: `2026-${month}-${day}T20:00:00Z` });
  const sameMonth = statement([earned, issue('earlier', '07')]);
  assert.equal(sameMonth.payableCommission, null, 'resolving the earlier receipt can change this month\'s tier');
  assert.ok(sameMonth.reviewReasons.includes('refund_review'));
  const otherMonth = statement([earned, issue('september', '10', '09')]);
  assert.deepEqual([otherMonth.earnedCommission, otherMonth.payableCommission, otherMonth.compensationState], [400, 400, 'configured']);
  const flat = terms => ({ ...terms, policy: { ...terms.policy, acceleratorEnabled: false } });
  const untiered = statement([{ ...earned, commissionTerms: flat(earned.commissionTerms) }, { ...issue('earlier', '07'), commissionTerms: flat(approvedKnockTerms()) }]);
  assert.deepEqual([untiered.earnedCommission, untiered.payableCommission], [400, 400]);
});

test('older signed terms hold the period of their cancellation deadline, when they would have been earned', () => {
  const flat = { ...approvedKnockTerms(), policy: { ...approvedKnockTerms().policy, acceleratorEnabled: false } };
  const sale = paid({ commissionTerms: flat, saleDate: '2026-10-14', soldAt: '2026-10-14T12:00:00Z', completedAt: '2026-10-15T18:00:00Z',
    paidAt: '2026-10-15T19:00:00Z', cancelEndsAt: '2026-10-20T06:00:00Z' });
  assert.equal(statement([sale]).earnedCommission, 400, 'earned at the deadline, in the later period');
  const refunded = { ...sale, refundedAmount: 50, refundedAt: '2026-10-16T12:00:00Z' };
  assert.equal(statement([refunded]).payableCommission, null);
  assert.ok(statement([refunded]).reviewReasons.includes('refund_review'));
});

test('a deposit-only sale is pending, even once the job is completed; only a short final collection is partial', async () => {
  const { settings, terms } = await v3();
  const booked = { id: 'dep', repKey: 'rep.one', leadKey: 'lead.one', ticket: 1600, package: 'Garage Transformation', commissionTerms: terms('2026-10-19T12:00:00Z'),
    saleDate: '2026-10-19', soldAt: '2026-10-19T12:00:00Z', status: 'booked', collectedAmount: null, completedAt: null, paidAt: null,
    handoff: { deposit: { status: 'collected', verifiedBy: 'stripe', collectedAmount: 400, collectedAt: '2026-10-19T13:00:00Z' } } };
  assert.deepEqual(commissionIssues(booked, settings.commission), []);
  assert.equal(isEarned(booked, nowMs), false);
  assert.equal(customerCollection(booked).source, 'stripe_deposit');
  const row = statement([booked], [], settings);
  assert.deepEqual([row.pending, row.earnedCommission, row.payableCommission, row.compensationState, row.collectionUnknownCount], [400, 0, 0, 'configured', 0]);
  // Finished work whose only receipt predates completion is awaiting its balance, not short.
  for (const patch of [{ status: 'completed', completedAt: '2026-10-20T12:00:00Z' }, { completedAt: '2026-10-20T12:00:00Z' }]) {
    const awaiting = { ...booked, ...patch };
    assert.deepEqual(commissionIssues(awaiting, settings.commission), [], JSON.stringify(patch));
    const held = statement([awaiting], [], settings);
    assert.deepEqual([held.pending, held.payableCommission, held.compensationState], [400, 0, 'configured'], JSON.stringify(patch));
  }
  // Short evidence of the closing collection: a receipt at or after completion, a short 'paid'
  // record from outside Knock, or a finished job with no usable completion time.
  const completed = { ...booked, status: 'completed', completedAt: '2026-10-20T12:00:00Z' };
  for (const patch of [{ collectedAmount: 1000, paidAt: '2026-10-20T12:00:00Z' },
    { collectedAmount: 1000, paidAt: '2026-10-20T15:00:00Z', collectionHistory: [{ total: 1000, previousTotal: 400, previousAt: '2026-10-19T13:00:00Z', at: '2026-10-20T15:00:00Z', by: 'test-owner' }] },
    { status: 'paid', collectedAmount: 1000, paidAt: '2026-10-19T15:00:00Z' }, { completedAt: null }, { completedAt: 'not a date' }]) {
    const short = { ...completed, ...patch };
    assert.ok(commissionIssues(short, settings.commission).includes('partial_collection_policy_unconfigured'), JSON.stringify(patch));
    assert.equal(statement([short], [], settings).payableCommission, null, JSON.stringify(patch));
  }
  // A running receipt recorded before completion is still just pending.
  const running = { ...completed, collectedAmount: 1000, paidAt: '2026-10-19T15:00:00Z' };
  assert.deepEqual(commissionIssues(running, settings.commission), []);
  const over = { ...booked, handoff: { deposit: { ...booked.handoff.deposit, collectedAmount: 1700 } } };
  assert.ok(commissionIssues(over, settings.commission).includes('partial_collection_policy_unconfigured'));
  const unverified = { ...booked, handoff: { deposit: { ...booked.handoff.deposit, collectedAt: null } } };
  assert.ok(commissionIssues(unverified, settings.commission).includes('collection_unverified'));
});

test('recorded Knock writes: completing a deposit-only job awaits the balance; a short receipt after completion is partial', async () => {
  const { settings, terms } = await v3();
  const env = knockEnv(), world = knockWorld({ 'knock_sales/flow': { repKey: 'rep.one', leadKey: '', ticket: 1600, package: 'Garage Transformation',
    commissionTerms: terms('2026-10-08T12:00:00Z'), saleDate: '2026-10-08', soldAt: '2026-10-08T12:00:00Z', status: 'booked',
    statusHistory: [{ status: 'booked', at: '2026-10-08T12:00:00Z', by: 'rep.one' }], collectedAmount: null, completedAt: null, paidAt: null, cancelledAt: null,
    handoff: { deposit: { status: 'collected', verifiedBy: 'stripe', collectedAmount: 500, collectedAt: '2026-10-08T12:30:00Z' } } } });
  const store = world.storage(env);
  const done = (await setSaleStatus(store, admin, { saleId: 'flow', status: 'completed' }, '2026-10-20T18:00:00.000Z')).sale;
  assert.deepEqual(commissionIssues(done, settings.commission), []);
  const short = (await recordSaleCollection(store, admin, { saleId: 'flow', collectedAmount: 1100 }, '2026-10-21T12:00:00.000Z')).sale;
  assert.deepEqual(commissionIssues(short, settings.commission), ['partial_collection_policy_unconfigured']);
  const full = (await recordSaleCollection(store, admin, { saleId: 'flow', collectedAmount: 1600 }, '2026-10-22T12:00:00.000Z')).sale;
  assert.deepEqual([full.status, commissionIssues(full, settings.commission), earnedAt(full)], ['paid', [], Date.parse('2026-10-22T12:00:00.000Z')]);
});

test('a sale sold in one period and completed in the next with only its deposit leaves the first period payable (V7)', async () => {
  const { settings, terms } = await v3();
  const s1 = paid({ id: 's1', package: 'Garage Transformation', commissionTerms: terms('2026-10-06T12:00:00Z'), saleDate: '2026-10-06', soldAt: '2026-10-06T12:00:00Z',
    cancelEndsAt: '2026-10-09T00:00:00Z', completedAt: '2026-10-12T18:00:00Z', paidAt: '2026-10-12T19:00:00Z' });
  const s2 = { id: 's2', repKey: 'rep.one', leadKey: '', ticket: 1600, package: 'Garage Transformation', commissionTerms: terms('2026-10-08T12:00:00Z'),
    saleDate: '2026-10-08', soldAt: '2026-10-08T12:00:00Z', status: 'completed', collectedAmount: null, completedAt: '2026-10-20T18:00:00Z', paidAt: null,
    statusHistory: [{ status: 'booked', at: '2026-10-08T12:00:00Z' }, { status: 'completed', at: '2026-10-20T18:00:00Z' }],
    handoff: { deposit: { status: 'collected', verifiedBy: 'stripe', collectedAmount: 500, collectedAt: '2026-10-08T12:30:00Z' } } };
  const at = (sales, date) => periodStatement({ sales, settings, period: payPeriodFor(date, settings.payroll), now: Date.parse('2026-10-30T00:00:00Z'),
    reps: [{ repKey: 'rep.one', status: 'active' }] }).find(r => r.repKey === 'rep.one');
  const first = at([s1, s2], '2026-10-12');
  assert.deepEqual([first.earnedCommission, first.payableCommission, first.compensationState, first.reviewReasons], [400, 400, 'configured', []]);
  const next = at([s1, s2], '2026-10-20');
  assert.deepEqual([next.earnedCommission, next.payableCommission, next.compensationState, next.reviewReasons], [0, 0, 'configured', []]);
  // A short final receipt is a real partial collection. Until finance decides that policy it
  // holds every period the sale touched, its sale-day deposit included.
  const history = [{ total: 1100, previousTotal: 500, previousAt: '2026-10-08T12:30:00Z', at: '2026-10-21T12:00:00Z' }];
  const short = { ...s2, collectedAmount: 1100, paidAt: '2026-10-21T12:00:00Z', collectionHistory: history };
  for (const date of ['2026-10-12', '2026-10-20']) {
    const held = at([s1, short], date);
    assert.deepEqual([held.payableCommission, held.reviewReasons], [null, ['partial_collection_policy_unconfigured']], date);
  }
  assert.equal(at([s1, short], '2026-11-05').compensationState, 'configured');
  // Collected in full: earned with the final receipt; both periods are payable again.
  const full = { ...short, status: 'paid', collectedAmount: 1600, paidAt: '2026-10-22T12:00:00Z',
    collectionHistory: [...history, { total: 1600, previousTotal: 1100, previousAt: '2026-10-21T12:00:00Z', at: '2026-10-22T12:00:00Z' }] };
  assert.deepEqual([at([s1, full], '2026-10-12').payableCommission, at([s1, full], '2026-10-20').earnedCommission, at([s1, full], '2026-10-20').payableCommission], [400, 400, 400]);
});

test('a refund or cancellation with no usable date holds every period; a dated one holds only its own', async () => {
  const { settings, terms } = await v3();
  const earned = paid({ id: 'r1', package: 'Garage Transformation', commissionTerms: terms('2026-10-06T12:00:00Z'), saleDate: '2026-10-06', soldAt: '2026-10-06T12:00:00Z',
    cancelEndsAt: '2026-10-09T00:00:00Z', completedAt: '2026-10-12T18:00:00Z', paidAt: '2026-10-12T19:00:00Z',
    statusHistory: [{ status: 'booked', at: '2026-10-06T12:00:00Z' }, { status: 'paid', at: '2026-10-12T19:00:00Z' }] });
  const at = (sales, date) => periodStatement({ sales, settings, period: payPeriodFor(date, settings.payroll), now: Date.parse('2026-11-10T00:00:00Z'),
    reps: [{ repKey: 'rep.one', status: 'active' }] }).find(r => r.repKey === 'rep.one');
  assert.deepEqual([at([earned], '2026-11-05').compensationState, at([earned], '2026-11-05').payableCommission], ['configured', 0]);
  for (const patch of [{ refundedAmount: 200 }, { refundedAmount: 200, refundedAt: 'not a date' }, { refundedAmount: 'unknown' }, { status: 'cancelled' }]) {
    const row = at([{ ...earned, ...patch }], '2026-11-05');
    assert.deepEqual([row.compensationState, row.payableCommission], ['review_required', null], JSON.stringify(patch));
    assert.ok(row.reviewReasons.some(reason => ['refund_review', 'cancellation_review'].includes(reason)), JSON.stringify(patch));
  }
  for (const patch of [{ refundedAmount: 200, refundedAt: '2026-10-27T12:00:00Z' },
    { status: 'cancelled', cancelledAt: '2026-10-27T12:00:00Z', statusHistory: [...earned.statusHistory, { status: 'cancelled', at: '2026-10-27T12:00:00Z' }] },
    // Reinstated: setSaleStatus clears cancelledAt, but the history still dates the cancellation.
    { statusHistory: [...earned.statusHistory, { status: 'cancelled', at: '2026-10-27T12:00:00Z' }, { status: 'paid', at: '2026-10-28T12:00:00Z' }] }]) {
    const sale = { ...earned, ...patch };
    assert.equal(at([sale], '2026-11-05').compensationState, 'configured', JSON.stringify(patch));
    assert.equal(at([sale], '2026-10-27').payableCommission, null, JSON.stringify(patch));
  }
});

test('reps read one earning rule, matching the approval state and the collected-v3 terms', async () => {
  const { settings } = await v3();
  const approved = commissionRuleText(settings.commission);
  assert.match(approved, /^25% of each eligible garage sale, earned once the customer has paid the full price \(a deposit alone does not count\), with payouts every two weeks\./);
  assert.doesNotMatch(approved, /completed|cancellation deadline|Not approved/);
  const unapproved = commissionRuleText((await loadSettings({ get: async () => ({ settings: DEFAULT_SETTINGS }) })).commission);
  assert.match(unapproved, /^Not approved yet: nothing is earned or payable/);
  assert.ok(unapproved.includes(approved.split(' Sales booked')[0]), 'the planned rule is the same sentence');
  assert.equal(commissionRuleText(undefined).startsWith('Not approved yet'), true);
  // A saved rate the contract cannot approve is never shown as the planned rate.
  const offContract = commissionRuleText({ ...settings.commission, verified: false, rate: 0.27 });
  assert.doesNotMatch(offContract, /27%|25%/);
  assert.match(offContract, /Planned once approved: Commission on each eligible garage sale at the approved rate, earned once the customer has paid the full price/);
  assert.match(SETTER_RULE_TEXT, /^13% to you .* estimator gets 7% \(20% total\)/);
  assert.deepEqual(CHANNEL_PERCENTS, { directSale: 25, setter: 13, estimator: 7 });
  const [help, money] = await Promise.all(['../crew/knock-app.js', '../crew/knock-stats-ui.js'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const source of [help, money]) assert.match(source, /commissionRuleText\((s\.commission|rates)\)/);
  assert.doesNotMatch(help, /once the job is completed, paid and past its cancellation deadline/);
});
