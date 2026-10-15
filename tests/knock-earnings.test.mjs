import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../crew/knock-settings.js';
import { commissionEligibility, customerCollection, earnedAt, isEarned, payPeriodFor, periodStatement, projectedCommission, saleCommissions, leadOverrides, snapshotCommissionTerms } from '../crew/knock-money.js';
import { loadSettings } from '../functions/_lib/knock-access.js';
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
  for (const patch of [{ collectedAmount: 320 }, { refundedAmount: 20 }, { status: 'cancelled' }, { paidAt: null }]) {
    const changed = { ...sale, ...patch };
    assert.equal(isEarned(changed, nowMs), false);
    assert.equal(statement([changed], [], settings).payableCommission, null);
  }
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
