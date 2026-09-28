import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutateMoney, moneyProjection, moneySnapshot, paymentNeedsVerification, MAX_ESTIMATE_LINES } from '../functions/_lib/money-service.js';
import { reconcileLedger } from '../functions/_lib/money-ledger.js';
import { moneyStorage } from '../functions/_lib/money-storage.js';

const NOW = '2026-09-22T18:00:00.000Z'; // noon in Denver on 2026-09-22
const LATER = '2026-09-23T18:00:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const line = (id, name, unitCents, quantity = 1, extra = {}) => ({ id, kind: 'service', name, description: `${name} (synthetic)`, quantity, unitCents, ...extra });
const LINES = [line('line-1', 'Garage cleanout', 90000), line('line-2', 'Shelving install', 25000, 2)];

function fixture(job = {}, rows = []) {
  const docs = new Map([
    ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'synthetic@example.invalid' }],
    ['jobs/job-abc123', { id: 'job-abc123', revision: 'r0', type: 'job', customerId: 'c1', customer: 'Synthetic Customer', serviceType: 'Garage transformation', date: '2026-09-24', status: 'scheduled', pipelineStatus: 'scheduled', notify: true, ...job }],
    ...rows.map(row => [`${row.collection}/${row.id}`, { revision: `${row.id}-r`, ...row.data, id: row.id }]),
  ]);
  let n = 0, hook = null;
  const commits = [];
  const store = {
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    jobs: async () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)),
    async commit(writes) {
      if (hook) { const fn = hook; hook = null; await fn(writes); }
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = docs.get(key);
        assert(!keys.has(key), 'one write per document per commit'); keys.add(key);
        if (write.exists ? !old : write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 });
      }
      commits.push(structuredClone(writes));
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision || write.exists ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  const f = { docs, store, commits, job: (id = 'job-abc123') => docs.get(`jobs/${id}`), beforeCommit: fn => { hook = fn; },
    input: (action, fields = {}, id = 'job-abc123') => ({ action, requestId: randomUUID(), jobId: id, expectedRevision: docs.get(`jobs/${id}`).revision, ...fields }),
    run: (action, fields, actor = owner, now = NOW, id) => mutateMoney(store, actor, f.input(action, fields, id), now) };
  return f;
}
const estimate = (f, fields = {}, actor = owner) => f.run('estimate.save', { lineItems: LINES, scope: 'Clear and reset the two-car garage.', validUntil: '2026-10-06', ...fields }, actor);
const audits = f => [...f.docs].filter(([key]) => key.startsWith('hub_audit/')).map(([, row]) => row);

test('estimate.save stores itemized integer-cent lines, a 50% deposit, a receipt and an audit entry in one commit', async () => {
  const f = fixture(), result = await estimate(f), job = f.job();
  assert.equal(result.ok, true); assert.equal(result.replayed, false); assert.equal(result.action, 'estimate.save');
  assert.equal(job.estimate.number, 'EST-ABC123'); assert.equal(job.estimate.status, 'draft'); assert.equal(job.estimate.revision, 1);
  assert.equal(job.estimate.amountCents, 140000); assert.equal(job.estimate.amount, 1400); assert.equal(job.total, 1400); assert.equal(job.priceQuoted, 1400);
  assert.equal(job.estimate.depositRequiredCents, 70000); assert.equal(job.deposit.amount, 700); assert.equal(job.deposit.status, 'required');
  assert.deepEqual(job.estimate.lineItems.map(item => [item.id, item.quantity, item.unitCents, item.totalCents, item.amount]), [['line-1', 1, 90000, 90000, 900], ['line-2', 2, 25000, 50000, 500]]);
  assert.equal(job.moneyRequestId, result.requestId); assert.equal(job.customerAutomationEnabled, undefined, 'saving never enables customer automations');
  assert.equal(f.commits.length, 1);
  const writes = f.commits[0];
  assert.deepEqual(writes.map(write => write.collection), ['jobs', 'moneyOperations', 'hub_audit']);
  assert.equal(writes[0].revision, 'r0'); assert.equal(writes[1].revision, undefined); assert.equal(writes[2].revision, undefined);
  assert.equal(writes[1].id, result.requestId.toLowerCase()); assert.match(writes[1].patch.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.job.totals.quoteCents, 140000); assert.equal(result.job.revision, job.revision);
  assert.deepEqual(result.job.lineItems.map(item => item.id), ['line-1', 'line-2']);
});

test('replaying a requestId returns the identical result; another payload or actor under that id is refused', async () => {
  const f = fixture(), input = f.input('estimate.save', { lineItems: LINES, scope: 'Clear and reset.', validUntil: '2026-10-06' });
  const first = await mutateMoney(f.store, owner, input, NOW), second = await mutateMoney(f.store, owner, structuredClone(input), NOW);
  assert.deepEqual({ ...second, replayed: false }, first); assert.equal(second.replayed, true); assert.equal(f.commits.length, 1);
  await assert.rejects(mutateMoney(f.store, owner, { ...input, scope: 'A different scope.' }, NOW), error => error.code === 'money_idempotency_conflict' && error.status === 409);
  await assert.rejects(mutateMoney(f.store, manager, input, NOW), error => error.code === 'money_idempotency_conflict');
  assert.equal(f.commits.length, 1);
  // A later money change makes the old request's result stale, never re-applied.
  await f.run('estimate.mark_sent', { channel: 'email' });
  await assert.rejects(mutateMoney(f.store, owner, input, NOW), error => error.code === 'money_changed_since_operation');
});

test('a stale expectedRevision or a concurrent write during commit is money_revision_conflict and writes nothing', async () => {
  const f = fixture();
  await assert.rejects(mutateMoney(f.store, owner, { ...f.input('estimate.save', { lineItems: LINES, scope: 'Reset.', validUntil: '2026-10-06' }), expectedRevision: 'stale' }, NOW), error => error.code === 'money_revision_conflict' && error.status === 409);
  f.beforeCommit(() => { f.job().revision = 'changed-by-someone-else'; });
  await assert.rejects(estimate(f), error => error.code === 'money_revision_conflict');
  assert.equal(f.commits.length, 0); assert.equal(audits(f).length, 0);
  assert.equal([...f.docs.keys()].some(key => key.startsWith('moneyOperations/')), false);
});

test('a lost commit response is recovered from the receipt instead of saving twice', async () => {
  const f = fixture(), input = f.input('estimate.save', { lineItems: LINES, scope: 'Reset.', validUntil: '2026-10-06' });
  const commit = f.store.commit;
  f.store.commit = async writes => { await commit(writes); throw Object.assign(new Error('lost'), { code: 'money_outcome_unknown', status: 503 }); };
  const first = await mutateMoney(f.store, owner, input, NOW);
  f.store.commit = commit;
  assert.equal(first.replayed, false); assert.equal(first.job.estimate.revision, 1);
  const again = await mutateMoney(f.store, owner, input, NOW);
  assert.equal(again.replayed, true); assert.equal(f.commits.length, 1); assert.equal(audits(f).length, 1);
});

test('an estimate revision after approval supersedes the approval and the invoice but keeps payments and deposit receipts', async () => {
  const f = fixture({ payment: { amount: 700, verified: true, lastAmount: 700, reference: 'CHK-100', method: 'deposit', recordedBy: 'zacb', lastReceivedAt: '2026-09-20T16:00:00.000Z' }, deposit: { amount: 700, paidAmount: 700, status: 'paid', reference: 'CHK-100', verified: true, providerReceiptId: 'receipt-1' } });
  await estimate(f);
  await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' });
  await f.run('invoice.issue', { dueDate: '2026-09-29' });
  // $700 of $1,400 is paid: the saved invoice is 'issued' (what the Hub finance board shows) and the projection derives 'partial'.
  assert.equal(f.job().customerApproval.status, 'approved'); assert.equal(f.job().invoice.status, 'issued'); assert.equal(f.job().invoice.balanceCents, 70000);
  assert.equal(moneyProjection(f.job(), NOW).invoice.status, 'partial');
  // Re-saving the same estimate from the editor is not a material change.
  const same = await estimate(f);
  assert.equal(f.job().customerApproval.status, 'approved'); assert.equal(f.job().estimate.revision, 1); assert.deepEqual(same.warnings, []);
  const revised = await estimate(f, { lineItems: [...LINES, line('line-3', 'Haul away', 15000)] }), job = f.job();
  assert.equal(job.estimate.revision, 2); assert.equal(job.estimate.status, 'draft'); assert.equal(job.estimate.acceptedAt, null);
  assert.equal(job.customerApproval.status, 'superseded'); assert.equal(job.customerApproval.approvedBy, 'Synthetic Customer'); assert.equal(job.customerApproval.supersededAt, NOW); assert.equal(job.quoteStatus, 'draft');
  assert.equal(job.invoice.status, 'superseded'); assert.equal(job.invoice.supersededReason, 'estimate_revised');
  assert.deepEqual(job.payment, f.job().payment); assert.equal(job.payment.amount, 700); assert.equal(job.payment.reference, 'CHK-100');
  assert.equal(job.deposit.paidAmount, 700); assert.equal(job.deposit.providerReceiptId, 'receipt-1'); assert.equal(job.deposit.reference, 'CHK-100'); assert.equal(job.deposit.verified, true);
  assert.deepEqual(revised.warnings.map(warning => warning.code), ['approval_superseded', 'invoice_superseded']);
});

test('a deposit-only change needs a fresh approval; a new expiry date alone does not', async () => {
  const f = fixture();
  await estimate(f); await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' });
  await estimate(f, { validUntil: '2026-10-20' });
  assert.equal(f.job().customerApproval.status, 'approved'); assert.equal(f.job().estimate.validUntil, '2026-10-20');
  await estimate(f, { depositCents: 50000 });
  assert.equal(f.job().customerApproval.status, 'superseded'); assert.equal(f.job().estimate.depositRequired, 500); assert.equal(f.job().deposit.amount, 500);
});

test('a legacy single-price estimate re-saved unchanged from its projection keeps its approval', async () => {
  const f = fixture({ total: 800, estimate: { number: 'EST-ABC123', status: 'accepted', revision: 3, amount: 800, scope: 'Legacy scope', depositRequired: 400, lineItems: [{ name: 'Garage transformation', description: 'Legacy scope', quantity: 1, amount: 800 }], validUntil: '2026-10-01' }, customerApproval: { status: 'approved', approvedAt: '2026-09-20T15:00:00.000Z', approvedBy: 'Synthetic Customer', amount: 800 } });
  const view = moneyProjection(f.job(), NOW), lines = view.lineItems.map(({ id, kind, name, description, quantity, unitCents }) => ({ id, kind, name, description, quantity, unitCents }));
  const saved = await f.run('estimate.save', { lineItems: lines, scope: view.estimate.scope, depositCents: view.totals.depositRequiredCents, validUntil: view.estimate.validUntil });
  assert.deepEqual(saved.warnings, []); assert.equal(f.job().customerApproval.status, 'approved'); assert.equal(f.job().estimate.revision, 3); assert.equal(f.job().estimate.status, 'accepted');
});

test('a portal approval racing a Hub revision never leaves a stale approved approval', async () => {
  const f = fixture();
  await estimate(f);
  const portalApprove = () => { const job = f.job(); Object.assign(job, { revision: 'portal-approved', customerApproval: { status: 'approved', approvedAt: NOW, approvedBy: 'Synthetic Customer', amount: 1400, source: 'customer_portal' }, estimate: { ...job.estimate, status: 'approved', acceptedAt: NOW, acceptedBy: 'Synthetic Customer' }, quoteStatus: 'approved' }); };
  // The portal commits between the manager opening the job and the commit.
  const opened = f.input('estimate.save', { lineItems: [line('line-1', 'Garage cleanout', 120000)], scope: 'Bigger scope.', validUntil: '2026-10-06' });
  f.beforeCommit(portalApprove);
  await assert.rejects(mutateMoney(f.store, owner, opened, NOW), error => error.code === 'money_revision_conflict');
  let job = f.job();
  assert.equal(job.customerApproval.status, 'approved'); assert.equal(job.estimate.amount, 1400, 'the approval still matches the estimate the customer saw');
  // The same stale request stays refused; after refreshing, the revision explicitly supersedes the approval.
  await assert.rejects(mutateMoney(f.store, owner, opened, NOW), error => error.code === 'money_revision_conflict');
  await f.run('estimate.save', { lineItems: [line('line-1', 'Garage cleanout', 120000)], scope: 'Bigger scope.', validUntil: '2026-10-06' });
  job = f.job();
  assert.equal(job.estimate.amount, 1200); assert.equal(job.customerApproval.status, 'superseded'); assert.equal(job.estimate.status, 'draft'); assert.equal(job.quoteStatus, 'draft');
});

test('recording an approval binds it to the current estimate revision and never sends anything', async () => {
  const f = fixture();
  await assert.rejects(f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' }), error => error.code === 'money_estimate_missing' && error.status === 409);
  await estimate(f);
  await assert.rejects(f.run('estimate.record_approval', { approvedBy: 'X' }), error => error.code === 'money_invalid_field');
  const result = await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' }), job = f.job();
  assert.equal(job.estimate.status, 'accepted'); assert.equal(job.estimate.acceptanceMethod, 'employee_recorded'); assert.equal(job.estimate.acceptedAt, NOW);
  assert.deepEqual({ ...job.customerApproval, estimateFingerprint: 'x' }, { status: 'approved', approvedAt: NOW, approvedBy: 'Synthetic Customer', amount: 1400, source: 'employee_recorded', recordedBy: 'zacb', estimateRevision: 1, estimateFingerprint: 'x' });
  assert.equal(job.customerApproval.estimateFingerprint, result.job.estimate.fingerprint);
  assert.equal(job.quoteStatus, 'approved'); assert.equal(job.customerPortalInvitationRequestedAt, NOW);
  await assert.rejects(f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' }), error => error.code === 'money_already_approved' && error.status === 409);
  const g = fixture(); await estimate(g, { validUntil: '2026-09-22' });
  await assert.rejects(g.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' }, owner, LATER), error => error.code === 'money_estimate_expired');
});

test('estimate.mark_sent records a human send without sending, and a later material revision returns it to draft', async () => {
  const f = fixture();
  await estimate(f);
  await assert.rejects(f.run('estimate.mark_sent', { channel: 'carrier_pigeon' }), error => error.code === 'money_invalid_channel');
  await f.run('estimate.mark_sent', { channel: 'email', note: 'Sent from the office inbox' });
  let job = f.job();
  assert.equal(job.estimate.status, 'sent'); assert.equal(job.estimate.sentBy, 'zacb'); assert.equal(job.estimate.sentChannel, 'email'); assert.equal(job.estimate.sentRevision, 1);
  assert.equal(job.customerAutomationEnabled, undefined); assert.equal(job.communicationLog, undefined);
  await estimate(f, { scope: 'A materially different scope.' });
  job = f.job();
  assert.equal(job.estimate.status, 'draft'); assert.equal(job.estimate.revision, 2); assert.equal(job.estimate.sentRevision, 1);
});

test('an offline payment cannot exceed the balance and nothing is written when it would', async () => {
  const f = fixture();
  await estimate(f);
  const before = f.commits.length;
  await assert.rejects(f.run('payment.record_offline', { amountCents: 140001, method: 'check', reference: 'CHK-9' }), error => error.code === 'money_amount_exceeds_balance' && error.status === 409 && error.details.balanceCents === 140000);
  await assert.rejects(f.run('payment.record_offline', { amountCents: 0, method: 'check', reference: 'CHK-9' }), error => error.code === 'money_invalid_amount');
  await assert.rejects(f.run('payment.record_offline', { amountCents: 100, method: 'check', reference: '' }), error => error.code === 'money_invalid_field');
  await assert.rejects(f.run('payment.record_offline', { amountCents: 100, method: 'check', reference: 'CHK-9', receivedAt: '2026-09-23T18:00:00.000Z' }), error => error.code === 'money_invalid_received_at');
  assert.equal(f.commits.length, before);
  await f.run('payment.record_offline', { amountCents: 100000, method: 'check', reference: 'CHK-9' });
  await assert.rejects(f.run('payment.record_offline', { amountCents: 40001, method: 'cash', reference: 'Receipt 12' }), error => error.code === 'money_amount_exceeds_balance' && error.details.balanceCents === 40000);
  const g = fixture({ total: 0 });
  await assert.rejects(g.run('payment.record_offline', { amountCents: 100, method: 'cash', reference: 'Receipt 1' }), error => ['money_amount_exceeds_balance', 'money_total_unknown'].includes(error.code));
});

test('offline payments append ledger entries that reconcile Stripe evidence and legacy manual money', async () => {
  const f = fixture({ estimate: { number: 'EST-ABC123', status: 'accepted', revision: 1, amount: 1400, depositRequired: 700, scope: 'Reset' }, customerApproval: { status: 'approved', amount: 1400 },
    payment: { amount: 900, verified: true, method: 'stripe', reference: 'pi_synthetic1', stripeSessions: [{ sessionId: 'cs_test_synthetic1', paymentIntentId: 'pi_synthetic1', amount: 700, purpose: 'deposit', verifiedAt: '2026-09-20T16:00:00.000Z' }], receiptUrl: 'https://pay.stripe.com/receipts/synthetic' } });
  const result = await f.run('payment.record_offline', { amountCents: 30000, method: 'check', reference: 'CHK-200' }), job = f.job();
  assert.equal(job.payment.amount, 1200); assert.equal(job.payment.lastAmount, 300); assert.equal(job.payment.method, 'check'); assert.equal(job.payment.verified, true); assert.equal(job.payment.recordedBy, 'zacb');
  assert.deepEqual(job.payment.stripeSessions.length, 1, 'Stripe evidence is preserved');
  assert.deepEqual(job.paymentLedger.map(row => [row.id, row.kind, row.amountCents, row.method, row.source]), [
    ['stripe:cs_test_synthetic1', 'deposit', 70000, 'card', 'stripe_session'],
    [`offline:${result.requestId}`, 'offline', 30000, 'check', 'hub_offline'],
    ['legacy:manual', 'offline', 20000, 'legacy_manual', 'legacy_aggregate'],
  ]);
  assert.equal(job.paymentLedgerStatus, 'complete'); assert.deepEqual(job.paymentLedgerIssues, []);
  assert.equal(job.invoice.number, 'INV-ABC123'); assert.equal(job.invoice.status, 'partial'); assert.equal(job.invoice.balanceCents, 20000); assert.equal(job.invoice.paidCents, 120000);
  assert.equal(job.status, 'scheduled', 'a prepaid job stays on the schedule');
  assert.equal(f.docs.get('customers/c1').lastPaymentStatus, 'partial'); assert.equal(f.docs.get('customers/c1').lastPaymentBalance, 200);
  assert.equal(f.docs.get('moneyInvoiceNumbers/n_INV-ABC123').jobId, 'job-abc123');
  const ledger = reconcileLedger(job);
  assert.equal(ledger.complete, true); assert.equal(ledger.unreconciledCents, 0);
  assert.equal(result.job.ledger.complete, true); assert.equal(result.job.payments.length, 3);
  // Paying the balance on finished work closes the job as paid.
  job.pipelineStatus = job.status = 'completed'; job.revision = 'completed-r';
  await f.run('payment.record_offline', { amountCents: 20000, method: 'cash', reference: 'Receipt 7' });
  assert.equal(f.job().invoice.status, 'paid'); assert.equal(f.job().pipelineStatus, 'paid'); assert.equal(f.job().paymentLedger.filter(row => row.source === 'legacy_aggregate')[0].amountCents, 20000);
});

test('a deposit is recorded against the deposit terms; an unverified earlier payment blocks new money', async () => {
  const f = fixture();
  await estimate(f);
  await f.run('deposit.record_offline', { amountCents: 50000, method: 'bank_transfer', reference: 'ACH-77' });
  let job = f.job();
  assert.deepEqual([job.deposit.amount, job.deposit.paidAmount, job.deposit.status, job.deposit.reference, job.deposit.verified], [700, 500, 'partial', 'ACH-77', true]);
  assert.equal(job.payment.amount, 500); assert.equal(job.payment.method, 'deposit'); assert.equal(job.invoice, undefined);
  assert.equal(job.paymentLedger[0].kind, 'deposit');
  const result = await f.run('deposit.record_offline', { amountCents: 30000, method: 'cash', reference: 'Receipt 3' });
  job = f.job();
  assert.equal(job.deposit.status, 'paid'); assert.equal(job.deposit.paidAmount, 800); assert.deepEqual(result.warnings.map(warning => warning.code), ['deposit_exceeds_due']);
  const g = fixture({ total: 1400, payment: { amount: 200, verified: false, reference: 'crew-entered' } });
  await assert.rejects(g.run('payment.record_offline', { amountCents: 100, method: 'cash', reference: 'Receipt 4' }), error => error.code === 'money_payment_needs_review');
});

test('invoice.issue bills only the selected lines under a unique number; void needs a reason and keeps payments', async () => {
  const optional = { estimate: { number: 'EST-ABC123', status: 'accepted', revision: 2, amount: 1150, depositRequired: 575, scope: 'Reset',
    lineItems: [line('base', 'Garage cleanout', 90000), line('shelves', 'Shelving', 25000, 1, { optional: true, selected: true }), line('epoxy', 'Epoxy floor', 300000, 1, { optional: true, selected: false })] }, customerApproval: { status: 'approved', amount: 1150 } };
  const f = fixture(optional, [{ collection: 'jobs', id: 'other-abc123', data: { type: 'job', customerId: 'c2', customer: 'Other Synthetic', total: 500, estimate: { amount: 500 } } }]);
  const other = await f.run('invoice.issue', { dueDate: '2026-09-29' }, owner, NOW, 'other-abc123');
  assert.equal(other.job.invoice.number, 'INV-ABC123');
  const result = await f.run('invoice.issue', { dueDate: '2026-09-29', customerReference: 'PO-1' }), job = f.job();
  assert.equal(job.invoice.number, 'INV-ABC123-2', 'two jobs sharing the last six id characters never share a number');
  assert.deepEqual(job.invoice.lineItems.map(item => item.id), ['base', 'shelves']); assert.equal(job.invoice.amountCents, 115000);
  assert.equal(job.invoice.status, 'issued'); assert.equal(job.invoice.issuedBy, 'zacb'); assert.equal(job.invoice.dueDate, '2026-09-29'); assert.equal(job.invoice.customerReference, 'PO-1');
  assert.equal(job.invoice.lineItems.some(item => 'split' in item || 'catalog' in item), false);
  assert.equal(result.job.invoice.status, 'issued');
  await assert.rejects(f.run('invoice.issue', { dueDate: '2026-09-21' }), error => error.code === 'money_invalid_due_date');
  await f.run('payment.record_offline', { amountCents: 15000, method: 'check', reference: 'CHK-5' });
  await assert.rejects(f.run('invoice.void', { reason: '' }), error => error.code === 'money_invalid_field');
  const voided = await f.run('invoice.void', { reason: 'Customer asked for a split invoice' });
  assert.equal(f.job().invoice.status, 'void'); assert.equal(f.job().invoice.voidReason, 'Customer asked for a split invoice'); assert.equal(f.job().payment.amount, 150);
  assert.deepEqual(voided.warnings.map(warning => warning.code), ['payments_kept']);
  await assert.rejects(f.run('invoice.void', { reason: 'Again please' }), error => error.code === 'money_invoice_not_active');
  const reissued = await f.run('invoice.issue', { dueDate: '2026-09-30' });
  assert.equal(f.job().invoice.number, 'INV-ABC123-2'); assert.equal(f.job().invoice.status, 'issued'); assert.equal(f.job().invoice.paidCents, 15000); assert.equal(f.job().invoice.balanceCents, 100000);
  assert.equal(reissued.job.invoice.savedStatus, 'issued'); assert.equal(reissued.job.invoice.status, 'partial');
  assert.equal(f.job().invoice.voidReason, undefined, 'a reissued invoice starts fresh');
});

test('costs.save keeps cents and dollars, and its audit snapshot is owner-only', async () => {
  const f = fixture();
  await assert.rejects(f.run('costs.save', { costs: { laborCents: 100 } }), error => error.code === 'money_invalid_costs');
  await f.run('costs.save', { costs: { laborCents: 32000, disposalCents: 8550, materialsCents: 0, fuelCents: 1200, processingCents: 0, otherCents: 0 } }, manager);
  const job = f.job();
  assert.deepEqual([job.costs.labor, job.costs.laborCents, job.costs.disposal, job.costs.recordedBy, job.costs.source], [320, 32000, 85.5, 'tylerg', 'egc_hub']);
  const [audit] = audits(f);
  assert.equal(audit.visibility, 'owner'); assert.equal(audit.action, 'money.costs.save'); assert.equal(audit.actor.id, 'tylerg');
});

test('every mutation writes an audit entry with the money before and after', async () => {
  const f = fixture();
  await estimate(f);
  await f.run('payment.record_offline', { amountCents: 20000, method: 'check', reference: 'CHK-42' });
  const entries = audits(f).sort((a, b) => a.at.localeCompare(b.at) || a.action.localeCompare(b.action));
  assert.deepEqual(entries.map(entry => entry.action).sort(), ['money.estimate.save', 'money.payment.record_offline']);
  const payment = entries.find(entry => entry.action === 'money.payment.record_offline'), before = JSON.parse(payment.before), after = JSON.parse(payment.after);
  assert.equal(before.payment, null); assert.equal(after.payment.amount, 200); assert.equal(after.payment.reference, 'CHK-42');
  assert.ok(payment.changedKeys.includes('payment') && payment.changedKeys.includes('paymentLedger') && payment.changedKeys.includes('invoice'));
  assert.equal(payment.via, 'hub'); assert.equal(payment.entity.id, 'job-abc123'); assert.equal(payment.requestId, f.job().moneyRequestId.toLowerCase());
  assert.match(payment.reason, /\$200\.00 check CHK-42/);
  const receipt = f.docs.get(`moneyOperations/${f.job().moneyRequestId.toLowerCase()}`);
  assert.equal(receipt.auditId, payment.id); assert.equal(receipt.actorId, 'zacb');
});

test('only signed-in owners and managers with business access can change money', async () => {
  const f = fixture();
  await assert.rejects(estimate(f, {}, null), error => error.code === 'money_sign_in_required' && error.status === 401);
  for (const actor of [{ user: 'crew1', role: 'crew', businessAccess: false }, { user: 'sales1', role: 'sales', businessAccess: false }, { user: 'zacb', role: 'crew', businessAccess: true }, { user: 'intruder', role: 'owner', businessAccess: true }])
    await assert.rejects(estimate(f, {}, actor), error => error.code === 'money_forbidden' && error.status === 403);
  assert.equal(f.commits.length, 0);
  await assert.rejects(f.run('estimate.save', { lineItems: LINES, scope: 'x', validUntil: '2026-10-06', actorId: 'tylerg' }), error => error.code === 'money_actor_changed' && error.status === 403);
});

test('requests are validated before any read: actions, ids, fields, lines and dates', async () => {
  const f = fixture(), bad = async (input, code) => assert.rejects(mutateMoney(f.store, owner, input, NOW), error => error.code === code, code);
  await bad({ ...f.input('estimate.save'), action: 'estimate.delete' }, 'money_request_invalid');
  await bad({ ...f.input('estimate.save'), requestId: 'not-a-uuid' }, 'money_request_invalid');
  await bad({ ...f.input('estimate.save', { lineItems: LINES, scope: 'x', validUntil: '2026-10-06' }), amount: 1 }, 'money_request_invalid');
  await bad({ ...f.input('estimate.save'), jobId: '_egc_schedule_lock_2026-09-22' }, 'money_request_invalid');
  await bad({ ...f.input('estimate.save', { lineItems: LINES, scope: 'x', validUntil: '2026-10-06' }), jobId: 'missing-job', expectedRevision: 'r' }, 'money_job_not_found');
  const save = fields => f.run('estimate.save', { lineItems: LINES, scope: 'Reset.', validUntil: '2026-10-06', ...fields });
  await assert.rejects(save({ lineItems: [] }), error => error.code === 'money_invalid_line_items');
  await assert.rejects(save({ lineItems: Array.from({ length: MAX_ESTIMATE_LINES + 1 }, (_, i) => line(`l${i}`, 'Line', 100)) }), error => error.code === 'money_too_many_lines');
  await assert.rejects(save({ lineItems: [line('a', 'Line', 100, 1, { amount: 5 })] }), error => error.code === 'money_invalid_line_items' && error.details.code === 'quote_amount_mismatch');
  await assert.rejects(save({ lineItems: [line('a', 'Line', 100, 1, { bogus: true })] }), error => error.code === 'money_invalid_line_items' && error.details.code === 'quote_unknown_field');
  await assert.rejects(save({ lineItems: [line('a', 'Line', 1000), { ...line('d', 'Discount', 100), kind: 'discount' }] }), error => error.code === 'money_line_kind_unsupported');
  await assert.rejects(save({ lineItems: [line('a', 'Line', 1000), line('b', 'Maybe', 100, 1, { optional: true, selected: true })] }), error => error.code === 'money_options_unsupported');
  await assert.rejects(save({ depositCents: 140001 }), error => error.code === 'money_invalid_amount');
  await assert.rejects(save({ validUntil: '2026-09-21' }), error => error.code === 'money_invalid_valid_until');
  await assert.rejects(save({ scope: '   ' }), error => error.code === 'money_invalid_field');
  const walkthrough = fixture({ type: 'walkthrough' });
  await assert.rejects(walkthrough.run('estimate.save', { lineItems: LINES, scope: 'x', validUntil: '2026-10-06' }), error => error.code === 'money_job_not_found' && error.status === 404);
  const cancelled = fixture({ status: 'cancelled', pipelineStatus: 'cancelled' });
  await assert.rejects(cancelled.run('estimate.save', { lineItems: LINES, scope: 'x', validUntil: '2026-10-06' }), error => error.code === 'money_job_closed');
  assert.equal(f.commits.length, 0);
});

test('the projection is an allowlist: no signatures, notes or contact details reach the money DTO', () => {
  const view = moneyProjection({ id: 'job-abc123', revision: 'r1', type: 'job', customer: 'Synthetic Customer', phone: '9705550100', email: 'synthetic@example.invalid', internalNotes: 'CANARY-NOTE', acceptance: { signatureData: 'data:image/png;base64,CANARY' },
    estimate: { amount: 500, number: 'EST-1', status: 'draft', revision: 1, scope: 'Reset' }, payment: { amount: 100, verified: true, reference: 'CHK-1', recordedBy: 'zacb', lastAmount: 100, lastReceivedAt: NOW, method: 'check' } }, NOW);
  const json = JSON.stringify(view);
  assert.equal(json.includes('CANARY'), false); assert.equal(json.includes('9705550100'), false); assert.equal(json.includes('example.invalid'), false);
  assert.equal(view.totals.balanceCents, 40000); assert.equal(view.invoice.status, 'not_issued'); assert.equal(view.payments[0].source, 'legacy_aggregate');
});

test('moneyStorage maps FAILED_PRECONDITION and ALREADY_EXISTS to money_revision_conflict and lost responses to money_outcome_unknown', async () => {
  const bodies = [];
  const respond = (status, body) => async (_env, url, options) => { bodies.push({ url: String(url), body: JSON.parse(options.body) }); return new Response(JSON.stringify(body), { status }); };
  const writes = [{ collection: 'jobs', id: 'job-1', revision: '2026-09-22T12:00:00.000000Z', patch: { total: 5 } }, { collection: 'moneyOperations', id: 'r1', patch: { fingerprint: 'f' } }];
  await moneyStorage({}, respond(200, { writeResults: [] })).commit(writes);
  assert.match(bodies[0].url, /documents:commit$/);
  assert.deepEqual(bodies[0].body.writes.map(write => write.currentDocument), [{ updateTime: '2026-09-22T12:00:00.000000Z' }, { exists: false }]);
  assert.deepEqual(bodies[0].body.writes[0].updateMask, { fieldPaths: ['total'] });
  await assert.rejects(moneyStorage({}, respond(400, { error: { status: 'FAILED_PRECONDITION' } })).commit(writes), error => error.code === 'money_revision_conflict' && error.status === 409);
  await assert.rejects(moneyStorage({}, respond(409, { error: { status: 'ALREADY_EXISTS' } })).commit(writes), error => error.code === 'money_revision_conflict');
  await assert.rejects(moneyStorage({}, respond(400, { error: { status: 'INVALID_ARGUMENT' } })).commit(writes), error => error.code === 'money_outcome_unknown' && error.status === 503);
  await assert.rejects(moneyStorage({}, respond(500, {})).commit(writes), error => error.code === 'money_outcome_unknown');
  await assert.rejects(moneyStorage({}, async () => { throw new Error('network'); }).commit(writes), error => error.code === 'money_outcome_unknown');
  await assert.rejects(moneyStorage({}, async () => new Response('{}', { status: 503 })).read('jobs', 'job-1'), error => error.code === 'money_storage_unavailable');
  assert.equal(await moneyStorage({}, async () => new Response('{}', { status: 404 })).read('jobs', 'job-1'), null);
});

test('re-saving lines from the editor keeps their internal split, catalog link and duration while the price is unchanged', async () => {
  const split = { productCents: 15000, laborCents: 8000, markupCents: 2000, disposalCents: 0, laborMinutes: 45 };
  const f = fixture({ total: 1400, estimate: { number: 'EST-ABC123', status: 'accepted', revision: 2, amount: 1400, depositRequired: 700, scope: 'Reset', validUntil: '2026-10-06',
    lineItems: [line('line-1', 'Garage cleanout', 90000, 1, { durationMinutes: 240 }), line('line-2', 'Shelving install', 25000, 2, { kind: 'product', split, catalog: { itemId: 'shelf-4', version: 3 }, customerSupplied: false })] }, customerApproval: { status: 'approved', amount: 1400 } });
  const view = moneyProjection(f.job(), NOW);
  assert.deepEqual(view.lineItems.map(item => [item.id, item.grouped, 'split' in item, 'catalog' in item]), [['line-1', false, false, false], ['line-2', false, false, false]], 'internal fields never reach the manager DTO');
  const edited = view.lineItems.map(({ id, kind, name, description, quantity, unitCents }) => ({ id, kind, name, description, quantity, unitCents }));
  const same = await f.run('estimate.save', { lineItems: edited, scope: 'Reset', depositCents: 70000, validUntil: '2026-10-06' });
  let job = f.job();
  assert.deepEqual(same.warnings, []); assert.equal(job.customerApproval.status, 'approved');
  assert.equal(job.estimate.lineItems[0].durationMinutes, 240); assert.deepEqual(job.estimate.lineItems[1].split, split); assert.deepEqual(job.estimate.lineItems[1].catalog, { itemId: 'shelf-4', version: 3 });
  await f.run('estimate.save', { lineItems: [edited[0], { ...edited[1], unitCents: 30000 }], scope: 'Reset', depositCents: 70000, validUntil: '2026-10-06' });
  job = f.job();
  assert.equal(job.estimate.lineItems[0].durationMinutes, 240); assert.equal(job.estimate.lineItems[1].split, null, 'a repriced line drops a split that no longer adds up');
  assert.deepEqual(job.estimate.lineItems[1].catalog, { itemId: 'shelf-4', version: 3 });
  assert.equal(job.customerApproval.status, 'superseded');
});

test('an estimate with option groups is reported as grouped so the editor never flattens it', () => {
  const group = { id: 'floor', label: 'Floor', selection: 'single' };
  const view = moneyProjection({ id: 'job-abc123', revision: 'r1', type: 'job', estimate: { amount: 1200, lineItems: [line('base', 'Cleanout', 90000), line('epoxy', 'Epoxy', 30000, 1, { group, selected: true, tier: 'good' })] } }, NOW);
  assert.deepEqual(view.lineItems.map(item => [item.id, item.grouped, item.selected]), [['base', false, true], ['epoxy', true, true]]);
});

test('money receipts and invoice-number reservations stay server-only in firestore.rules', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of ['moneyOperations', 'moneyInvoiceNumbers', 'hub_audit']) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`), collection);
});

test('direct costs reach only the owner-only costs.save audit entry, never a later business-visible one', async () => {
  const f = fixture();
  await estimate(f);
  await f.run('costs.save', { costs: { laborCents: 32000, disposalCents: 0, materialsCents: 0, fuelCents: 0, processingCents: 0, otherCents: 0 } });
  await f.run('invoice.issue', { dueDate: '2026-09-29' });
  await f.run('invoice.void', { reason: 'Synthetic reissue' });
  const entries = audits(f), costs = entries.find(entry => entry.action === 'money.costs.save');
  assert.equal(costs.visibility, 'owner'); assert.equal(JSON.parse(costs.after).costs.labor, 320);
  assert.deepEqual(entries.filter(entry => entry !== costs).map(entry => entry.action).sort(), ['money.estimate.save', 'money.invoice.issue', 'money.invoice.void']);
  for (const entry of entries.filter(entry => entry !== costs)) {
    assert.equal(entry.visibility, 'business', entry.action);
    for (const side of ['before', 'after']) assert.equal(Object.hasOwn(JSON.parse(entry[side]), 'costs'), false, `${entry.action} ${side}`);
  }
  assert.equal(f.job().costs.labor, 320, 'the job keeps its costs');
  assert.equal(Object.hasOwn(moneySnapshot(f.job()), 'costs'), false); assert.equal(moneySnapshot(f.job(), { costs: true }).costs.labor, 320);
});

test('new money never verifies earlier unverified money, including unverified card sessions saved without a paid total', async () => {
  const session = { sessionId: 'cs_test_synthetic9', paymentIntentId: 'pi_synthetic9', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-20T16:00:00.000Z' };
  const f = fixture({ total: 1400, estimate: { number: 'EST-ABC123', amount: 1400, depositRequired: 700, scope: 'Reset' }, payment: { verified: false, stripeSessions: [session] } });
  assert.equal(paymentNeedsVerification(f.job()), true);
  for (const action of ['payment.record_offline', 'deposit.record_offline'])
    await assert.rejects(f.run(action, { amountCents: 10000, method: 'cash', reference: 'Receipt 8' }), error => error.code === 'money_payment_needs_review' && error.status === 409 && /not verified/.test(error.message) && /needsVerification/.test(error.message));
  assert.equal(f.commits.length, 0); assert.equal(f.job().paymentLedger, undefined); assert.equal(f.job().payment.verified, false);
  // A legacy paid total with no payment record counts as unverified unless a verified deposit covers it (the portal's rule).
  const legacy = fixture({ total: 1400, deposit: { amount: 700, paidAmount: 300 } });
  await assert.rejects(legacy.run('payment.record_offline', { amountCents: 10000, method: 'cash', reference: 'Receipt 8' }), error => error.code === 'money_payment_needs_review');
  const covered = fixture({ total: 1400, deposit: { amount: 700, paidAmount: 300, verified: true } });
  await covered.run('payment.record_offline', { amountCents: 10000, method: 'cash', reference: 'Receipt 8' });
  assert.equal(covered.job().payment.amount, 400);
  assert.deepEqual(covered.job().paymentLedger.map(row => [row.source, row.amountCents, row.verified]), [['hub_offline', 10000, true], ['legacy_aggregate', 30000, true]]);
  // A zero paid total has nothing to verify.
  const zero = fixture({ total: 1400, payment: { amount: 0 } });
  assert.equal(paymentNeedsVerification(zero.job()), false);
  await zero.run('payment.record_offline', { amountCents: 10000, method: 'cash', reference: 'Receipt 9' });
  assert.equal(zero.job().payment.amount, 100);
});

test('the customer payment mirror is best effort: a concurrent customer edit or a missing customer never fails the payment', async () => {
  const f = fixture();
  await estimate(f);
  f.beforeCommit(() => { Object.assign(f.docs.get('customers/c1'), { revision: 'edited-meanwhile', note: 'kept' }); });
  const result = await f.run('payment.record_offline', { amountCents: 20000, method: 'check', reference: 'CHK-77' });
  assert.equal(result.replayed, false); assert.equal(f.job().payment.amount, 200); assert.equal(f.job().invoice.status, 'partial');
  const customer = f.docs.get('customers/c1');
  assert.deepEqual([customer.latestJobId, customer.lastPaymentStatus, customer.lastPaymentBalance, customer.note], ['job-abc123', 'partial', 1200, 'kept']);
  const [money, mirror] = f.commits.slice(-2);
  assert.equal(money.some(write => write.collection === 'customers'), false, 'the mirror is not part of the money commit');
  assert.deepEqual(mirror.map(write => [write.collection, write.id, write.exists, write.revision]), [['customers', 'c1', true, undefined]]);
  // A customer id without a document is never created, and the payment still saves.
  const g = fixture({ customerId: 'c-missing' });
  await estimate(g);
  await g.run('payment.record_offline', { amountCents: 20000, method: 'check', reference: 'CHK-78' });
  assert.equal(g.job().payment.amount, 200); assert.equal(g.docs.has('customers/c-missing'), false);
});

test('an invoice number another job claims during the commit is re-reserved once on the server, not reported as a job change', async () => {
  const claim = f => writes => { const write = writes.find(item => item.collection === 'moneyInvoiceNumbers'); if (write) f.docs.set(`moneyInvoiceNumbers/${write.id}`, { number: write.patch.number, jobId: 'other-abc123', revision: 'x' }); };
  const f = fixture({ total: 1400 });
  f.beforeCommit(claim(f));
  const result = await f.run('invoice.issue', { dueDate: '2026-09-29' });
  assert.equal(result.job.invoice.number, 'INV-ABC123-2'); assert.equal(f.job().invoice.number, 'INV-ABC123-2');
  assert.equal(f.docs.get('moneyInvoiceNumbers/n_INV-ABC123-2').jobId, 'job-abc123'); assert.equal(f.commits.length, 1); assert.equal(audits(f).length, 1);
  // Losing that race twice saves nothing and keeps the request for an unchanged retry.
  const g = fixture({ total: 1400 }), input = g.input('invoice.issue', { dueDate: '2026-09-29' });
  g.beforeCommit(writes => { claim(g)(writes); g.beforeCommit(claim(g)); });
  await assert.rejects(mutateMoney(g.store, owner, input, NOW), error => error.code === 'money_invoice_number_unavailable' && error.status === 503);
  assert.equal(g.commits.length, 0); assert.equal(g.job().invoice, undefined); assert.equal(audits(g).length, 0);
  const retried = await mutateMoney(g.store, owner, input, NOW);
  assert.equal(retried.replayed, false); assert.equal(retried.job.invoice.number, 'INV-ABC123-3');
  // A real change to the job is still a revision conflict.
  const h = fixture({ total: 1400 });
  h.beforeCommit(() => { h.job().revision = 'changed-by-someone-else'; });
  await assert.rejects(h.run('invoice.issue', { dueDate: '2026-09-29' }), error => error.code === 'money_revision_conflict');
  assert.equal(h.commits.length, 0);
});

test('an MCP actor is audited and receipted as via mcp; a Hub session, or any other via, as hub', async () => {
  const f = fixture();
  const receipt = result => f.docs.get(`moneyOperations/${result.requestId.toLowerCase()}`), audit = result => audits(f).find(entry => entry.id === receipt(result).auditId);
  const hub = await estimate(f), mcp = await f.run('estimate.mark_sent', { channel: 'email' }, { ...owner, via: 'mcp' }), other = await f.run('estimate.mark_sent', { channel: 'text' }, { ...owner, via: 'portal' });
  assert.deepEqual([receipt(hub).via, audit(hub).via], ['hub', 'hub']);
  assert.deepEqual([receipt(mcp).via, audit(mcp).via, audit(mcp).actor.id, audit(mcp).action], ['mcp', 'mcp', 'zacb', 'money.estimate.mark_sent']);
  assert.deepEqual([receipt(other).via, audit(other).via], ['hub', 'hub']);
});

test('the invoice preview is exactly what invoice.issue saves: change orders and the one-line fallback included', async () => {
  const decisions = [{ id: 'd1', title: 'Haul extra shelving', details: 'Synthetic', priceDelta: 150, status: 'approved' }, { id: 'd2', title: 'Epoxy floor', priceDelta: 900, status: 'declined' }];
  const f = fixture({ total: 1400, customerDecisions: decisions, approvedChangeTotal: 150, estimate: { number: 'EST-ABC123', status: 'accepted', revision: 1, amount: 1400, depositRequired: 700, scope: 'Reset', lineItems: [...LINES, line('opt', 'Epoxy', 300000, 1, { optional: true, selected: false })] } });
  const saved = job => job.invoice.lineItems.map(({ id, name, quantity, totalCents }) => ({ id, name, quantity, totalCents }));
  const preview = moneyProjection(f.job(), NOW).invoicePreview;
  assert.deepEqual(preview.lineItems.map(item => [item.name, item.quantity, item.totalCents]), [['Garage cleanout', 1, 90000], ['Shelving install', 2, 50000], ['Approved change: Haul extra shelving', 1, 15000]]);
  assert.equal(preview.totalCents, 155000); assert.deepEqual(preview.notices, []);
  await f.run('invoice.issue', { dueDate: '2026-09-29' });
  assert.deepEqual(preview.lineItems, saved(f.job())); assert.equal(f.job().invoice.amountCents, preview.totalCents);
  // Lines that do not add up to the quote become one line for the quoted amount, with the notice issue returns as a warning.
  const g = fixture({ total: 1000, estimate: { number: 'EST-ABC123', amount: 1000, depositRequired: 500, scope: 'Reset', lineItems: LINES } });
  const fallback = moneyProjection(g.job(), NOW).invoicePreview;
  assert.deepEqual(fallback.lineItems.map(item => [item.quantity, item.totalCents]), [[1, 100000]]); assert.equal(fallback.totalCents, 100000);
  assert.match(fallback.notices[0], /one line for the quoted amount/);
  const issued = await g.run('invoice.issue', { dueDate: '2026-09-29' });
  assert.deepEqual(fallback.lineItems, saved(g.job())); assert.ok(issued.warnings.some(warning => warning.message === fallback.notices[0]));
  assert.equal(moneyProjection({ id: 'job-x', revision: 'r', type: 'job' }, NOW).invoicePreview, null, 'nothing to invoice, nothing to preview');
});

test('moneyStorage sends a best-effort mirror as a merge into a document that must exist', async () => {
  let body = null;
  await moneyStorage({}, async (_env, _url, options) => { body = JSON.parse(options.body); return new Response('{}', { status: 200 }); }).commit([{ collection: 'customers', id: 'c1', exists: true, patch: { lastPaymentStatus: 'partial' } }]);
  assert.deepEqual(body.writes[0].currentDocument, { exists: true }); assert.deepEqual(body.writes[0].updateMask, { fieldPaths: ['lastPaymentStatus'] });
});
