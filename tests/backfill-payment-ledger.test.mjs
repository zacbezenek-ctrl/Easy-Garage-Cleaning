import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, planPaymentLedgerBackfill, runPaymentLedgerBackfill } from '../scripts/backfill-payment-ledger.mjs';
import { reconcileLedger } from '../functions/_lib/money-ledger.js';
import { mutateMoney } from '../functions/_lib/money-service.js';

const NOW = '2026-09-22T18:00:00.000Z';
const RUN = '00000000-0000-4000-8000-000000000001';
const session = (id, amount, extra = {}) => ({ sessionId: `cs_test_${id}`, paymentIntentId: `pi_${id}`, amount, purpose: 'balance', verifiedAt: '2026-09-20T16:00:00.000Z', ...extra });
const JOBS = {
  'stripe-only': { type: 'job', customer: 'Synthetic Stripe Customer', total: 1400, invoice: { number: 'INV-ONE', status: 'partial', amount: 1400 }, payment: { amount: 700, verified: true, method: 'stripe', stripeSessions: [session('a', 700, { purpose: 'deposit' })], receiptUrl: 'https://pay.stripe.com/receipts/synthetic-a' } },
  'manual-only': { type: 'job', customer: 'Synthetic Check Customer', total: 800, payment: { amount: 500, verified: true, method: 'offline_or_processor', reference: 'CHK-1', lastAmount: 500, lastReceivedAt: '2026-09-18T16:00:00.000Z', recordedBy: 'zacb' } },
  mixed: { type: 'job', customer: 'Synthetic Mixed Customer', total: 1500, invoice: { number: 'INV-DUP', status: 'partial' }, payment: { amount: 1000, verified: true, method: 'deposit', reference: 'CASH-2', lastAmount: 300, recordedBy: 'tylerg', stripeSessions: [session('b', 700)] } },
  twin: { type: 'job', customer: 'Synthetic Twin Customer', total: 300, invoice: { number: 'INV-DUP', status: 'issued' } },
  reserved: { type: 'job', total: 300, invoice: { number: 'INV-KEPT', status: 'issued' } },
  unpaid: { type: 'job', customer: 'Synthetic Unpaid Customer', total: 800 },
  unverified: { type: 'job', total: 900, payment: { amount: 200, verified: false, stripeSessions: [session('c', 200)] } },
  refunded: { type: 'job', total: 900, payment: { amount: 900, verified: true, refundedAmount: 100, stripeSessions: [session('d', 900)] } },
  walk: { type: 'walkthrough', payment: { amount: 100, verified: true } },
  _egc_schedule_lock_2026_09_22: { recordType: 'schedule_lock' },
};

function fixture(jobs = JOBS, reservations = { 'n_INV-KEPT': { number: 'INV-KEPT', jobId: 'reserved' } }) {
  const docs = new Map([...Object.entries(jobs).map(([id, row]) => [`jobs/${id}`, { ...structuredClone(row), id, revision: `${id}-r0` }]), ...Object.entries(reservations).map(([id, row]) => [`moneyInvoiceNumbers/${id}`, { ...row, id, revision: `${id}-r0` }])]);
  let n = 0, hook = null;
  const commits = [];
  const store = {
    jobs: async () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)),
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
      if (hook) { const fn = hook; hook = null; await fn(writes); }
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = docs.get(key);
        assert(!keys.has(key), 'one write per document per commit'); keys.add(key);
        if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  return { docs, store, commits, job: id => docs.get(`jobs/${id}`), beforeCommit: fn => { hook = fn; } };
}

test('an unverified manual payment keeps an unverified aggregate and is listed for the owner to verify', () => {
  const plan = planPaymentLedgerBackfill([{ id: 'crew-cash', revision: 'crew-cash-r0', type: 'job', total: 500, payment: { amount: 100, reference: 'crew-entered' } }, { id: 'checked', revision: 'checked-r0', type: 'job', total: 500, payment: { amount: 100, verified: true } }]);
  assert.deepEqual(plan.report.needsVerification, [{ id: 'crew-cash', paidCents: 10000 }]);
  assert.deepEqual(plan.writes.map(row => [row.id, row.ledger.entries.map(entry => [entry.source, entry.amountCents, entry.verified])]), [['checked', [['legacy_aggregate', 10000, true]]], ['crew-cash', [['legacy_aggregate', 10000, false]]]]);
});

test('the dry run plans Stripe-session entries plus one legacy aggregate per job and writes nothing', async () => {
  const f = fixture(), report = await runPaymentLedgerBackfill(f.store, { now: NOW, runId: RUN });
  assert.equal(report.mode, 'dry_run'); assert.equal(f.commits.length, 0);
  assert.deepEqual(report.preview.map(row => row.id), ['manual-only', 'mixed', 'stripe-only']);
  assert.deepEqual(report.jobs.needsReview.map(row => [row.id, row.issues]), [['refunded', ['money_refunds_unreconciled']], ['unverified', ['money_payment_not_verified']]]);
  assert.deepEqual(report.jobs.needsVerification, [{ id: 'unverified', paidCents: 20000 }], 'the jobs /api/money records no new money on until the owner verifies them');
  assert.deepEqual([report.jobs.scanned, report.jobs.skippedRecords, report.jobs.noPayments, report.jobs.current], [10, 2, 3, 0]);
  const plan = planPaymentLedgerBackfill(await f.store.jobs());
  const entries = id => plan.writes.find(row => row.id === id).ledger.entries.map(row => [row.id, row.kind, row.amountCents, row.method, row.source, row.verified]);
  assert.deepEqual(entries('stripe-only'), [['stripe:cs_test_a', 'deposit', 70000, 'card', 'stripe_session', true]]);
  assert.deepEqual(entries('manual-only'), [['legacy:manual', 'offline', 50000, 'legacy_manual', 'legacy_aggregate', true]]);
  assert.deepEqual(entries('mixed'), [['stripe:cs_test_b', 'balance', 70000, 'card', 'stripe_session', true], ['legacy:manual', 'offline', 30000, 'legacy_manual', 'legacy_aggregate', true]]);
  assert.deepEqual(report.preview.find(row => row.id === 'mixed').after, { entries: 2, paidCents: 100000, itemizedCents: 70000, legacyCents: 30000, stripeEntries: 1 });
  assert.deepEqual(report.invoiceNumbers, { toReserve: ['INV-ONE'], alreadyReserved: 1, reservedByOther: [], duplicates: [{ number: 'INV-DUP', jobIds: ['mixed', 'twin'] }] });
  assert.equal(report.writes.planned, 3); assert.equal(report.writes.committed, 0); assert.equal(report.writes.reservationsPlanned, 1);
  assert.equal(JSON.stringify(report).includes('Synthetic'), false, 'the report carries no customer details');
});

test('--apply writes only the ledger fields with revision preconditions, an audit entry and a receipt, then a rerun is a no-op', async () => {
  const f = fixture(), before = structuredClone(f.job('mixed'));
  const report = await runPaymentLedgerBackfill(f.store, { apply: true, now: NOW, runId: RUN });
  assert.equal(report.aborted, undefined); assert.equal(report.writes.committed, 3); assert.equal(report.writes.reservationsCommitted, 1); assert.equal(report.writes.receipts.length, 1);
  const [batch] = f.commits;
  const jobs = batch.filter(write => write.collection === 'jobs');
  assert.deepEqual(jobs.map(write => [write.id, write.revision]), [['manual-only', 'manual-only-r0'], ['mixed', 'mixed-r0'], ['stripe-only', 'stripe-only-r0']]);
  for (const write of jobs) assert.deepEqual(Object.keys(write.patch).sort(), ['paymentLedger', 'paymentLedgerIssues', 'paymentLedgerStatus', 'paymentLedgerUpdatedAt', 'paymentLedgerVersion']);
  const audits = batch.filter(write => write.collection === 'hub_audit');
  assert.equal(audits.length, 3); assert.ok(audits.every(write => write.revision === undefined && write.patch.action === 'money.ledger.backfill' && write.patch.actor.kind === 'system'));
  const receipt = batch.find(write => write.collection === 'moneyOperations');
  assert.equal(receipt.patch.runId, RUN); assert.deepEqual(receipt.patch.targets.map(row => row.id), ['manual-only', 'mixed', 'stripe-only']);
  const mixed = f.job('mixed');
  assert.deepEqual(mixed.payment, before.payment, 'recorded payments are never changed'); assert.equal(mixed.total, 1500);
  assert.equal(mixed.paymentLedgerStatus, 'complete'); assert.equal(mixed.paymentLedgerVersion, 1); assert.equal(mixed.paymentLedgerUpdatedAt, NOW);
  assert.equal(reconcileLedger(mixed).complete, true); assert.equal(reconcileLedger(mixed).legacyCents, 30000);
  assert.equal(f.job('unverified').paymentLedger, undefined); assert.equal(f.job('refunded').paymentLedger, undefined);
  assert.deepEqual(f.docs.get('moneyInvoiceNumbers/n_INV-ONE'), { number: 'INV-ONE', jobId: 'stripe-only', reservedAt: NOW, source: 'backfill', runId: RUN, id: 'n_INV-ONE', revision: f.docs.get('moneyInvoiceNumbers/n_INV-ONE').revision });
  assert.equal(f.docs.has('moneyInvoiceNumbers/n_INV-DUP'), false, 'a number two jobs already share is reported, not reserved');
  const commits = f.commits.length, again = await runPaymentLedgerBackfill(f.store, { apply: true, now: '2026-09-23T18:00:00.000Z', runId: RUN });
  assert.equal(again.writes.planned, 0); assert.equal(again.writes.reservationsPlanned, 0); assert.equal(again.jobs.current, 3); assert.equal(f.commits.length, commits);
});

test('a job saved during the run is skipped and reported while the rest of its batch is written', async () => {
  const f = fixture();
  f.beforeCommit(() => { f.job('mixed').revision = 'saved-meanwhile'; });
  const report = await runPaymentLedgerBackfill(f.store, { apply: true, now: NOW, runId: RUN });
  assert.deepEqual(report.writes.changedDuringRun, ['mixed']); assert.equal(report.writes.committed, 2);
  assert.equal(f.job('mixed').paymentLedger, undefined); assert.equal(f.job('stripe-only').paymentLedgerStatus, 'complete');
});

test('a lost commit response is recovered from the run receipt instead of being reported as a failure', async () => {
  const f = fixture({ 'manual-only': JOBS['manual-only'] }, {}), commit = f.store.commit;
  f.store.commit = async writes => { await commit(writes); throw Object.assign(new Error('lost'), { code: 'money_outcome_unknown', status: 503 }); };
  const report = await runPaymentLedgerBackfill(f.store, { apply: true, now: NOW, runId: RUN });
  assert.equal(report.aborted, undefined); assert.equal(report.writes.committed, 1); assert.equal(f.job('manual-only').paymentLedgerStatus, 'complete');
  f.store.commit = async () => { throw Object.assign(new Error('down'), { code: 'money_outcome_unknown', status: 503 }); };
  const g = fixture({ 'manual-only': JOBS['manual-only'] }, {});
  g.store.commit = f.store.commit;
  assert.equal((await runPaymentLedgerBackfill(g.store, { apply: true, now: NOW, runId: RUN })).aborted.code, 'money_outcome_unknown');
});

test('the backfilled ledger is the ledger the money API keeps extending', async () => {
  const f = fixture({ 'manual-only': JOBS['manual-only'] }, {});
  await runPaymentLedgerBackfill(f.store, { apply: true, now: NOW, runId: RUN });
  const owner = { user: 'zacb', role: 'owner', businessAccess: true };
  const result = await mutateMoney(f.store, owner, { action: 'payment.record_offline', requestId: 'a0000000-0000-4000-8000-000000000002', jobId: 'manual-only', expectedRevision: f.job('manual-only').revision, amountCents: 30000, method: 'cash', reference: 'Receipt 9' }, NOW);
  assert.deepEqual(f.job('manual-only').paymentLedger.map(row => [row.id, row.amountCents]), [['offline:a0000000-0000-4000-8000-000000000002', 30000], ['legacy:manual', 50000]]);
  assert.equal(result.job.ledger.complete, true); assert.equal(result.job.totals.balanceCents, 0);
  const again = await runPaymentLedgerBackfill(f.store, { now: NOW, runId: RUN });
  assert.equal(again.writes.planned, 0); assert.equal(again.jobs.current, 1);
});

test('arguments default to a dry run and refuse ambiguous modes', () => {
  assert.deepEqual(parseArgs([]), { apply: false, report: '', help: false });
  assert.deepEqual(parseArgs(['--apply', '--report', 'out.json']), { apply: true, report: 'out.json', help: false });
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /either/);
  assert.throws(() => parseArgs(['--force']), /Unknown/);
  assert.throws(() => parseArgs(['--report']), /incomplete/);
});
