// Refunds and chargebacks reach the job, the books and the refund holds (issue #303). A Stripe refund or card dispute
// on any Hub checkout opens a Review queues item (never money from the webhook); an owner or manager records the refund
// on the job (payment.record_refund), or the owner does it while closing the review; money-core then nets it, and every
// hold built on refundsRecorded fires. Synthetic data only; Stripe and Firestore are in-memory fakes; the clock is fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { firestoreMemory } from './helpers/firestore-memory.mjs';
import { applyWrite } from './helpers/commit-write.mjs';
import { customerMoneyTotals, invoiceStatus, paymentLedger, refundsRecorded } from '../functions/_lib/money-core.js';
import { reconcileLedger } from '../functions/_lib/money-ledger.js';
import { MONEY_REFUND_REASONS, REFUND_METHODS, mutateMoney } from '../functions/_lib/money-service.js';
import { customerMoneyState, payable, tipRefusal } from '../functions/_lib/customer-payments.js';
import { messagePolicy } from '../functions/_lib/message-policies.js';
import { moneyDocumentModel } from '../functions/_lib/money-document.js';
import { adjustmentHold, collectionEvidence } from '../functions/_lib/knock-setters.js';
import { jobActualsRow } from '../functions/_lib/job-actuals.js';
import { computeTipAllocation } from '../functions/_lib/tip-allocation.js';
import { fieldPaymentJobEligible } from '../functions/api/field-payments.js';
import { resolveStripeReview, stripeReviewOverview } from '../functions/_lib/stripe-reviews.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';

const NOW = '2026-09-22T18:00:00.000Z', PAID_AT = '2026-09-20T16:00:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const crew = { user: 'crew1', role: 'crew', businessAccess: false };
const code = (expected, status) => error => { assert.equal(error.code, expected, error.message); if (status) assert.equal(error.status, status); return true; };

// A finished $1,000 job paid in full by one $1,000 Stripe card charge, with its invoice paid.
const SESSION = 'cs_test_refund_paid';
const paidJob = (extra = {}) => ({
  type: 'job', customer: 'Synthetic Refund Customer', customerId: 'cust-refund', serviceType: 'Garage cleanout', date: '2026-09-20', status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-20T22:00:00.000Z',
  total: 1000, estimate: { number: 'EST-REFUND', status: 'accepted', amount: 1000, depositRequired: 250, acceptedAt: '2026-09-15T16:00:00.000Z' }, customerApproval: { status: 'approved', approvedAt: '2026-09-15T16:00:00.000Z', amount: 1000 },
  deposit: { amount: 250, paidAmount: 250, status: 'paid', verified: true },
  payment: { amount: 1000, verified: true, method: 'stripe', processor: 'stripe', reference: 'pi_refund_paid', stripeSessions: [{ sessionId: SESSION, paymentIntentId: 'pi_refund_paid', amount: 1000, purpose: 'balance', verifiedAt: PAID_AT }] },
  invoice: { number: 'INV-REFUND', status: 'paid', amount: 1000, paid: 1000, balance: 0, dueDate: '2026-09-27', issuedAt: '2026-09-20T22:30:00.000Z' },
  ...extra,
});

// Revisioned in-memory store with the money and dispatch commit contract: an update needs its revision, a create needs
// the document to be absent, exists:true needs it present, and a verify-only fence checks a revision without writing.
function memoryStore(initial = {}, flags = {}) {
  const rows = new Map(), commits = [];
  let revision = 0;
  const stamp = () => `2026-09-22T00:00:00.${String(++revision).padStart(6, '0')}Z`;
  const put = (path, value) => rows.set(path, { value: structuredClone(value), revision: stamp() });
  for (const [path, value] of Object.entries(initial)) put(path, value);
  const out = (path, row) => ({ ...structuredClone(row.value), id: path.split('/').slice(1).join('/'), revision: row.revision });
  const within = collection => [...rows].filter(([path]) => path.startsWith(`${collection}/`));
  return {
    ...flags, rows, commits, put,
    get: path => rows.has(path) ? structuredClone(rows.get(path).value) : null,
    of: collection => within(collection).map(([path, row]) => out(path, row)),
    async read(collection, id) { const path = `${collection}/${id}`; return rows.has(path) ? out(path, rows.get(path)) : null; },
    async readMany(collection, ids) { return ids.filter(id => rows.has(`${collection}/${id}`)).map(id => out(`${collection}/${id}`, rows.get(`${collection}/${id}`))); },
    async list(collection) { return { rows: within(collection).map(([path, row]) => out(path, row)), complete: true }; },
    async jobs() { return within('jobs').map(([path, row]) => out(path, row)); },
    async commit(writes) {
      const paths = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(paths).size, paths.length, 'a commit writes each document once');
      for (const [index, write] of writes.entries()) {
        const row = rows.get(paths[index]);
        if (write.verify ? row?.revision !== write.revision : write.revision ? row?.revision !== write.revision : write.exists ? !row : row) throw Object.assign(new Error('Synthetic conflict'), { code: 'money_revision_conflict', status: 409 });
      }
      for (const [index, write] of writes.entries()) if (!write.verify) rows.set(paths[index], { value: applyWrite(rows.get(paths[index])?.value, write), revision: stamp() });
      commits.push(paths.filter((_, index) => !writes[index].verify));
    },
  };
}
const refundInput = (store, fields = {}, jobId = 'job-refund') => ({ action: 'payment.record_refund', requestId: randomUUID(), jobId, expectedRevision: store.rows.get(`jobs/${jobId}`).revision, amountCents: 25000, method: 'stripe_refund', reason: 'customer_request', stripeRef: 're_synthetic_refund_1', ...fields });

test('money-core nets the refunds the money API records, and still flags every other refund record', () => {
  const row = { id: 'refund:re_synthetic_1', amountCents: 25000, amount: 250, method: 'stripe_refund', reason: 'customer_request', reference: 're_synthetic_1', refundedAt: '2026-09-21T15:00:00.000Z', recordedBy: 'zacb' };
  const job = { id: 'job-net', ...paidJob(), payment: { ...paidJob().payment, amount: 750, refunds: [row] } };
  const ledger = paymentLedger(job), totals = customerMoneyTotals(job);
  assert.deepEqual([ledger.issues, ledger.ledgerCents, ledger.unreconciledCents, ledger.complete], [['money_refund_recorded'], 75000, 0, false], 'the refund is itemized against the net paid total, and stays for review');
  assert.deepEqual(ledger.entries.map(entry => [entry.id, entry.kind, entry.amountCents]), [[`stripe:${SESSION}`, 'balance', 100000], ['refund:re_synthetic_1', 'refund', 25000]]);
  assert.deepEqual([totals.appliedCents, totals.balanceCents, totals.complete], [75000, 25000, true]);
  assert.equal(refundsRecorded(job), true, 'every refund hold still sees it');
  assert.deepEqual([customerMoneyTotals(job, { unified: true }).balanceCents, customerMoneyState(job).paid, customerMoneyState(job, 'unified').balance], [25000, 750, 250], 'legacy and unified money agree');
  // Refunds in any other shape (or a row the money API did not write) are still not reconciled here.
  for (const other of [{ ...job, refunds: [{ amount: 250 }] }, { ...job, payment: { ...job.payment, refundedAmount: 250 } }, { ...job, payment: { ...job.payment, refunds: [{ ...row, id: 'r1' }] } }, { ...job, payment: { ...job.payment, refunds: [row, { amount: 50 }] } }]) {
    assert.ok(paymentLedger(other).issues.includes('money_refunds_unreconciled'), JSON.stringify(other.refunds ?? other.payment.refunds));
  }
});

test('an owner or manager records a Stripe refund on the job: net paid, a refund ledger entry, the invoice reopened, one audited commit', async () => {
  for (const totalsMode of ['off', 'unified']) {
    const store = memoryStore({ 'jobs/job-refund': paidJob() }, { totalsMode }), input = refundInput(store);
    await assert.rejects(mutateMoney(store, crew, input, NOW), code('money_forbidden', 403));
    const result = await mutateMoney(store, manager, input, NOW), job = store.get('jobs/job-refund');
    assert.deepEqual([job.payment.amount, job.payment.refunds.length, job.payment.refunds[0].id, job.payment.refunds[0].amountCents, job.payment.refunds[0].refundedAt, job.payment.refunds[0].reference], [750, 1, 'refund:re_synthetic_refund_1', 25000, NOW, 're_synthetic_refund_1'], totalsMode);
    assert.deepEqual(job.paymentLedger.filter(entry => entry.kind === 'refund').map(entry => [entry.id, entry.amountCents, entry.method, entry.source]), [['refund:re_synthetic_refund_1', 25000, 'stripe_refund', 'hub_offline']]);
    assert.deepEqual([job.paymentLedgerStatus, job.paymentLedgerIssues], ['needs_review', ['money_refund_recorded']], 'reconciled, and held for review like every refund');
    assert.equal(reconcileLedger(job).unreconciledCents, 0);
    assert.ok(!result.warnings.some(warning => warning.code === 'ledger_needs_review'));
    assert.deepEqual([job.invoice.status, job.invoice.paidCents, job.invoice.balanceCents, invoiceStatus(job, NOW, { unified: totalsMode === 'unified' })], ['partial', 75000, 25000, 'partial']);
    assert.equal(job.status, 'completed', 'the job status is left as it was');
    assert.deepEqual([result.job.totals.appliedCents, result.job.totals.balanceCents, result.job.payments.find(entry => entry.kind === 'refund')?.amountCents], [75000, 25000, 25000]);
    assert.ok(result.warnings.some(warning => warning.code === 'balance_reopened'));
    assert.deepEqual(store.commits.map(paths => paths.map(path => path.split('/')[0])), [['jobs', 'moneyOperations', 'hub_audit']], 'one commit');
    assert.equal(store.of('hub_audit')[0].action, 'money.payment.record_refund');
    // The same request replays; the same Stripe refund under a new request is refused.
    assert.equal((await mutateMoney(store, manager, input, NOW)).replayed, true);
    await assert.rejects(mutateMoney(store, owner, refundInput(store, { amountCents: 100 }), NOW), code('money_refund_duplicate', 409));
    assert.equal(store.get('jobs/job-refund').payment.amount, 750);
  }
});

test('a refund is whole cents up to the service money paid, never a crew tip, and needs verified money and a reason', async () => {
  const tipped = paidJob({ payment: { ...paidJob().payment, tips: [{ sessionId: SESSION, paymentIntentId: 'pi_refund_paid', amountCents: 5000, amount: 50, source: 'customer_portal', verifiedAt: PAID_AT }] } });
  const store = memoryStore({ 'jobs/job-refund': tipped, 'jobs/job-unverified': { ...paidJob(), payment: { ...paidJob().payment, verified: false } } });
  await assert.rejects(mutateMoney(store, owner, refundInput(store, { amountCents: 100001 }), NOW), error => error.code === 'money_amount_exceeds_paid' && error.details.appliedCents === 100000 && /tips are not refunded/i.test(error.message));
  for (const [fields, expected] of [[{ amountCents: 0 }, 'money_invalid_amount'], [{ amountCents: 12.5 }, 'money_invalid_amount'], [{ method: 'card' }, 'money_invalid_refund_method'], [{ reason: 'because' }, 'money_invalid_refund_reason'],
    [{ reason: 'other' }, 'money_invalid_field'], [{ stripeRef: 'ch_not_a_refund' }, 'money_invalid_stripe_ref'], [{ refundedAt: '2026-09-30T00:00:00.000Z' }, 'money_invalid_refunded_at'], [{ extra: true }, 'money_request_invalid']]) {
    await assert.rejects(mutateMoney(store, owner, refundInput(store, fields), NOW), code(expected), JSON.stringify(fields));
  }
  await assert.rejects(mutateMoney(store, owner, refundInput(store, {}, 'job-unverified'), NOW), code('money_payment_needs_review', 409));
  // A chargeback for all the service money: the tip stays in the tip ledger, held for the owner apart.
  await mutateMoney(store, owner, refundInput(store, { amountCents: 100000, method: 'chargeback', reason: 'dispute_lost', stripeRef: 'dp_synthetic_1', refundedAt: '2026-09-21T15:00:00.000Z' }), NOW);
  const job = store.get('jobs/job-refund'), totals = customerMoneyTotals(job);
  assert.deepEqual([job.payment.amount, job.payment.tips.length, totals.appliedCents, totals.tipCents, totals.paidCents, totals.balanceCents], [0, 1, 0, 5000, 5000, 100000]);
  assert.deepEqual([reconcileLedger(job).unreconciledCents, reconcileLedger(job).issues], [0, ['money_refund_recorded']]);
});

test('a refund that reopens a paid-in-full balance records the job.balance_reopened crossing as a refund', async () => {
  const store = memoryStore({ 'jobs/job-refund': paidJob({ paidInFullAt: PAID_AT, paidInFullRevision: null }) }, { paymentEvents: true });
  await mutateMoney(store, owner, refundInput(store), NOW);
  const job = store.get('jobs/job-refund'), events = store.of('funnelEvents');
  assert.deepEqual([job.paidInFullAt, job.balanceReopenedReason], [null, 'refund']);
  assert.deepEqual(events.map(event => [event.type, event.data?.reasonCode, event.data?.amountCents]), [['job.balance_reopened', 'refund', 25000]]);
});

test('once a refund is on the job every refund hold fires: portal card pay, reminders, tips, field pay, commissions and job actuals', async () => {
  const store = memoryStore({ 'jobs/job-refund': paidJob() });
  await mutateMoney(store, owner, refundInput(store), NOW);
  const job = { ...store.get('jobs/job-refund'), id: 'job-refund' };
  assert.throws(() => payable(job), error => error.code === 'CUSTOMER_PORTAL_MONEY_REVIEW' && error.status === 409, 'the reopened balance is never charged by card on its own');
  assert.doesNotThrow(() => payable({ ...paidJob(), id: 'job-open', payment: { ...paidJob().payment, amount: 750, stripeSessions: [{ ...paidJob().payment.stripeSessions[0], amount: 750 }] } }), 'an unrefunded balance still opens');
  assert.match(tipRefusal(job), /refund/);
  assert.equal(fieldPaymentJobEligible(job), false);
  const upcoming = { ...job, status: 'scheduled', pipelineStatus: 'scheduled', completedAt: null, date: '2026-09-25', payment: { ...job.payment, amount: 0 } };
  upcoming.payment.refunds = [{ ...job.payment.refunds[0], amountCents: 100000, amount: 1000 }];
  assert.deepEqual(messagePolicy('deposit_reminder').eligible({ job: upcoming, today: '2026-09-22', automated: true }), { eligible: false, reason: 'refund_recorded' }, 'a deposit a refund reopened is never chased');
  // Commissions stay held for review exactly as before: the collection is unverified while a refund is on the job.
  assert.equal(collectionEvidence(job).verified, false);
  const hold = adjustmentHold(job, collectionEvidence(job), ['collection_unverified'], Date.parse('2026-09-01T00:00:00.000Z'), Date.parse(NOW));
  assert.ok(hold.dates.includes(NOW), 'the hold names the refund time');
  assert.ok(jobActualsRow(job).reasons.includes('revenue_unreconciled'));
});

test('receipts and invoices list the refund as its own line, and their totals are net', () => {
  const row = { id: 'refund:re_synthetic_doc', amountCents: 25000, amount: 250, method: 'stripe_refund', reason: 'customer_request', reference: 're_synthetic_doc', refundedAt: '2026-09-21T15:00:00.000Z', recordedBy: 'zacb' };
  const job = { id: 'job-doc', ...paidJob(), payment: { ...paidJob().payment, amount: 750, refunds: [row] }, invoice: { ...paidJob().invoice, status: 'partial', paid: 750, balance: 250 } };
  for (const kind of ['receipt', 'invoice']) {
    const doc = moneyDocumentModel(job, { kind, now: NOW });
    assert.deepEqual(doc.payments.map(line => [line.label, line.amountCents]), [['Payment · Card (Stripe)', 100000], ['Refund · Card (Stripe)', -25000]], kind);
    assert.equal(doc.paymentsReconciled, true);
    assert.deepEqual(doc.rows.filter(line => /Paid toward service|Payments received|Balance/.test(line.label)).map(line => line.cents), [75000, 25000], kind);
  }
});

test('Review queues: the owner records a refund of a charge on the job on the job itself, in the same commit', async () => {
  const review = { sessionId: SESSION, jobId: 'job-refund', kind: 'egc_customer_portal_payment', reason: 'payment_refunded', status: 'open', amountCents: 100000, currency: 'usd', paymentIntentId: 'pi_refund_paid', livemode: false, refundedCents: 25000, createdBy: 'customer_portal', recordedBy: 'stripe_webhook', createdAt: '2026-09-21T15:00:00.000Z' };
  const store = memoryStore({ 'jobs/job-refund': paidJob(), [`payment_reviews/${SESSION}`]: review });
  const stripe = async path => ({ id: decodeURIComponent(path.split('/')[2].split('?')[0]), client_reference_id: 'job-refund', metadata: { job_id: 'job-refund' }, amount_total: 100000, livemode: false, payment_intent: { id: 'pi_refund_paid', latest_charge: { amount_refunded: 25000, refunded: false } } });
  const held = await store.read('payment_reviews', SESSION), base = { action: 'payment.refund', reviewId: SESSION, expectedRevision: held.revision, reason: 'customer_request', note: 'Owner-only synthetic note' };
  await assert.rejects(resolveStripeReview(store, owner, { ...base, requestId: randomUUID(), recordOnJob: true, jobPaymentAcknowledged: true }, NOW, { stripe }), code('stripe_review_invalid_field', 400));
  await assert.rejects(resolveStripeReview(store, owner, { ...base, requestId: randomUUID() }, NOW, { stripe }), error => error.code === 'stripe_review_refund_on_job' && /Record the refund on the job here/.test(error.message));
  await assert.rejects(resolveStripeReview(store, manager, { ...base, requestId: randomUUID(), recordOnJob: true }, NOW, { stripe }), code('stripe_review_owner_required', 403));
  const input = { ...base, requestId: randomUUID(), recordOnJob: true }, result = await resolveStripeReview(store, owner, input, NOW, { stripe });
  const job = store.get('jobs/job-refund'), saved = store.get(`payment_reviews/${SESSION}`);
  assert.deepEqual([result.review.resolution, result.review.jobRefundCents, saved.status, saved.jobRefundCents], ['refunded', 25000, 'resolved', 25000]);
  assert.deepEqual([job.payment.amount, job.payment.refunds.map(row => [row.id, row.amountCents, row.method, row.reviewId, row.note]), job.invoice.status, job.paymentReviewResolvedAt], [750, [[`refund:${SESSION}`, 25000, 'stripe_refund', SESSION, undefined]], 'partial', NOW], 'the owner-only note never goes on the job');
  assert.equal(store.commits.length, 1, 'the job and the review change together');
  assert.deepEqual(store.of('hub_audit').map(entry => entry.action).sort(), ['money.payment.record_refund', 'stripe_review.payment.refund']);
  assert.equal((await resolveStripeReview(store, owner, input, NOW, { stripe })).replayed, true);
  assert.equal(store.get('jobs/job-refund').payment.amount, 750, 'a replay never takes it off twice');
});

test('Review queues: a tipped charge on the job takes only its service part off the job, read the way the owner says it was refunded', async () => {
  for (const [tipRefundedFirst, serviceCents] of [[false, 30000], [true, 25000]]) {
    const job = paidJob({ payment: { ...paidJob().payment, tips: [{ sessionId: SESSION, paymentIntentId: 'pi_refund_paid', amountCents: 5000, amount: 50, source: 'customer_portal', verifiedAt: PAID_AT }] } });
    const store = memoryStore({ 'jobs/job-refund': job, [`payment_reviews/${SESSION}`]: { sessionId: SESSION, jobId: 'job-refund', kind: 'egc_customer_portal_payment', reason: 'payment_refunded', status: 'open', amountCents: 105000, tipCents: 5000, currency: 'usd', paymentIntentId: 'pi_refund_paid', livemode: false, refundedCents: 30000, createdAt: '2026-09-21T15:00:00.000Z' } });
    const stripe = async () => ({ id: SESSION, client_reference_id: 'job-refund', metadata: { job_id: 'job-refund' }, amount_total: 105000, livemode: false, payment_intent: { id: 'pi_refund_paid', latest_charge: { amount_refunded: 30000, refunded: false } } });
    const held = await store.read('payment_reviews', SESSION);
    await resolveStripeReview(store, owner, { action: 'payment.refund', requestId: randomUUID(), reviewId: SESSION, expectedRevision: held.revision, reason: 'customer_request', recordOnJob: true, tipRefundedFirst }, NOW, { stripe });
    const saved = store.get('jobs/job-refund');
    assert.deepEqual([saved.payment.refunds[0].amountCents, saved.payment.amount, saved.payment.tips.length], [serviceCents, (100000 - serviceCents) / 100, 1], `tip refunded first: ${tipRefundedFirst}`);
  }
  // A charge that is not on the job has nothing to take off it.
  const store = memoryStore({ 'jobs/job-refund': { ...paidJob(), payment: { amount: 0, verified: true } }, [`payment_reviews/${SESSION}`]: { sessionId: SESSION, jobId: 'job-refund', kind: 'egc_customer_portal_payment', reason: 'payment_refunded', status: 'open', amountCents: 100000, currency: 'usd', paymentIntentId: 'pi_refund_paid', livemode: false, refundedCents: 100000, createdAt: '2026-09-21T15:00:00.000Z' } });
  const held = await store.read('payment_reviews', SESSION);
  await assert.rejects(resolveStripeReview(store, owner, { action: 'payment.refund', requestId: randomUUID(), reviewId: SESSION, expectedRevision: held.revision, reason: 'duplicate_charge', recordOnJob: true }, NOW, { stripe: async () => ({ id: SESSION, client_reference_id: 'job-refund', metadata: { job_id: 'job-refund' }, amount_total: 100000, livemode: false, payment_intent: { id: 'pi_refund_paid', latest_charge: { amount_refunded: 100000, refunded: true } } }) }), code('stripe_review_refund_not_on_job', 409));
});

test('Review queues: the owner closes a card dispute once Stripe shows how it ended, and a lost one needs its chargeback on the job first', async () => {
  const id = `${SESSION}:dispute`, dispute = { sessionId: SESSION, jobId: 'job-refund', kind: 'egc_customer_portal_payment', reason: 'payment_disputed', status: 'open', amountCents: 100000, currency: 'usd', paymentIntentId: 'pi_refund_paid', livemode: false, disputeId: 'dp_synthetic_1', disputeStatus: 'needs_response', disputeAmountCents: 100000, createdAt: '2026-09-21T15:00:00.000Z' };
  const store = memoryStore({ 'jobs/job-refund': paidJob(), [`payment_reviews/${id}`]: dispute });
  let status = 'lost';
  const stripe = async path => { assert.equal(path, 'disputes/dp_synthetic_1'); return { id: 'dp_synthetic_1', payment_intent: 'pi_refund_paid', status, amount: 100000 }; };
  const overview = await stripeReviewOverview(store, manager, new Date(NOW));
  assert.deepEqual(overview.paymentReviews.map(row => [row.reviewId, row.reason, row.disputeStatus, row.disputeAmountCents, row.recordedOnJob, row.chargebackOnJob]), [[id, 'payment_disputed', 'needs_response', 100000, true, false]]);
  const request = (action, fields = {}) => ({ action, requestId: randomUUID(), reviewId: id, expectedRevision: store.rows.get(`payment_reviews/${id}`).revision, ...fields });
  await assert.rejects(resolveStripeReview(store, manager, request('payment.reconcile', { note: 'Bank decided' }), NOW, { stripe }), code('stripe_review_owner_required', 403));
  await assert.rejects(resolveStripeReview(store, owner, request('payment.refund', { reason: 'other', recordOnJob: true }), NOW, { stripe }), code('stripe_review_dispute_not_refund', 409));
  await assert.rejects(resolveStripeReview(store, owner, request('payment.reconcile', { note: 'Bank decided for the customer' }), NOW, { stripe }), error => error.code === 'stripe_review_chargeback_not_recorded' && error.details.disputeId === 'dp_synthetic_1' && /dp_synthetic_1/.test(error.message));
  assert.equal(store.commits.length, 0);
  // The chargeback goes on the job with its dispute ID; then the review closes.
  await mutateMoney(store, owner, refundInput(store, { amountCents: 100000, method: 'chargeback', reason: 'dispute_lost', stripeRef: 'dp_synthetic_1' }), NOW);
  const closed = await resolveStripeReview(store, owner, request('payment.reconcile', { note: 'Bank decided for the customer' }), NOW, { stripe });
  assert.deepEqual([closed.review.resolution, closed.review.disputeStatus, store.get('jobs/job-refund').payment.amount], ['reconciled', 'lost', 0]);
  // A dispute the business won closes with a note and nothing on the job.
  status = 'won';
  const won = memoryStore({ 'jobs/job-refund': paidJob(), [`payment_reviews/${id}`]: dispute });
  const wonRequest = { action: 'payment.reconcile', requestId: randomUUID(), reviewId: id, expectedRevision: won.rows.get(`payment_reviews/${id}`).revision, note: 'Evidence accepted' };
  assert.equal((await resolveStripeReview(won, owner, wonRequest, NOW, { stripe })).review.disputeStatus, 'won');
  assert.equal(won.get('jobs/job-refund').payment.amount, 1000);
});

// The Stripe webhook, signed with a synthetic secret, over the in-memory Firestore; Stripe reads are injected fakes.
function webhookWorld(env = {}) {
  const mem = firestoreMemory(), sessions = new Map();
  const restore = globalThis.fetch;
  globalThis.fetch = (input, options) => mem.fetch(input, options);
  const secret = 'whsec_synthetic_refunds';
  const config = { FIREBASE_API_KEY: 'firebase-test-refunds', STRIPE_SECRET_KEY: 'sk_test_synthetic_refunds', STRIPE_WEBHOOK_SECRET: secret, ...env };
  const handlers = stripeWebhookHandlers({ now: () => new Date(NOW), readCheckout: async (_env, id) => structuredClone(sessions.get(id)), findCheckout: async (_env, pi) => [...sessions.values()].find(session => session.payment_intent.id === pi) || null });
  let n = 0;
  return {
    mem, sessions, restore: () => { globalThis.fetch = restore; },
    session(jobId, amount, { kind = 'egc_customer_portal_payment', currency = 'usd', refunded = 0 } = {}) {
      const i = ++n, id = `cs_test_refund_hook_${i}`;
      sessions.set(id, { id, object: 'checkout.session', client_reference_id: jobId, mode: 'payment', status: 'complete', payment_status: 'paid', currency, amount_total: amount, livemode: false,
        metadata: { kind, job_id: jobId, payment_purpose: 'balance', ...(kind === 'egc_job_payment' ? { created_by: 'crew1' } : {}) }, payment_intent: { id: `pi_refund_hook_${i}`, latest_charge: { id: `ch_refund_hook_${i}`, amount_refunded: refunded, refunded: refunded >= amount && refunded > 0, receipt_url: `https://pay.stripe.com/receipts/refund_hook_${i}` } } });
      return sessions.get(id);
    },
    async deliver(type, object) {
      const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type, livemode: false, data: { object } }), t = Math.floor(Date.parse(NOW) / 1000);
      const signature = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
      const response = await handlers.post({ env: config, request: new Request('https://easygaragecleaning.com/api/stripe-webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${signature}` }, body: raw }) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('webhook: a refund of any Hub charge, tipped or not and with tips off, opens a Review queues item and never changes the job', async t => {
  const w = webhookWorld(); t.after(w.restore);
  w.mem.put('jobs/job-hook', paidJob());
  const portal = w.session('job-hook', 25000), crewCharge = w.session('job-hook', 30000, { kind: 'egc_job_payment' });
  assert.equal((await w.deliver('checkout.session.completed', { id: portal.id, metadata: portal.metadata, payment_status: 'paid' })).body.recorded, true);
  const booked = w.mem.get('jobs/job-hook');
  Object.assign(portal.payment_intent.latest_charge, { amount_refunded: 25000, refunded: true });
  const refunded = await w.deliver('charge.refunded', { id: portal.payment_intent.latest_charge.id, object: 'charge', payment_intent: portal.payment_intent.id, amount_refunded: 25000 });
  assert.deepEqual(refunded, { status: 200, body: { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' } });
  assert.deepEqual([w.mem.get(`payment_reviews/${portal.id}`).reason, w.mem.get(`payment_reviews/${portal.id}`).refundedCents], ['payment_refunded', 25000]);
  assert.deepEqual(w.mem.get('jobs/job-hook'), booked, 'the webhook writes no money');
  // A crew card charge refunded before it was booked is held, not booked.
  Object.assign(crewCharge.payment_intent.latest_charge, { amount_refunded: 30000, refunded: true });
  assert.equal((await w.deliver('charge.refunded', { id: crewCharge.payment_intent.latest_charge.id, object: 'charge', payment_intent: crewCharge.payment_intent.id })).body.reason, 'payment_refunded');
  assert.equal(w.mem.get(`payment_reviews/${crewCharge.id}`).kind, 'egc_job_payment');
  // A charge that is not a Hub checkout is still acknowledged and ignored.
  assert.deepEqual((await w.deliver('charge.refunded', { id: 'ch_other', object: 'charge', payment_intent: 'pi_not_a_hub_checkout' })).body, { ok: true, received: true, ignored: true });
});

test('webhook: a card dispute on a Hub charge opens, updates and, once it ends after review, reopens one Review queues item', async t => {
  const w = webhookWorld(); t.after(w.restore);
  w.mem.put('jobs/job-hook', paidJob());
  const charge = w.session('job-hook', 25000);
  await w.deliver('checkout.session.completed', { id: charge.id, metadata: charge.metadata, payment_status: 'paid' });
  const booked = w.mem.get('jobs/job-hook'), id = `payment_reviews/${charge.id}:dispute`;
  const dispute = (status, extra = {}) => ({ id: 'dp_synthetic_hook', object: 'dispute', charge: charge.payment_intent.latest_charge.id, payment_intent: charge.payment_intent.id, amount: 25000, currency: 'usd', reason: 'product_not_received', status, ...extra });
  assert.deepEqual((await w.deliver('charge.dispute.created', dispute('needs_response'))).body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_disputed' });
  const opened = w.mem.get(id);
  assert.deepEqual([opened.reason, opened.status, opened.disputeId, opened.disputeStatus, opened.disputeAmountCents, opened.jobId, opened.amountCents], ['payment_disputed', 'open', 'dp_synthetic_hook', 'needs_response', 25000, 'job-hook', 25000]);
  await w.deliver('charge.dispute.created', dispute('needs_response'));
  await w.deliver('charge.dispute.updated', dispute('under_review'));
  assert.equal(w.mem.get(id).disputeStatus, 'under_review');
  // The owner closes it while it is under review; the bank's final answer opens the one follow-up.
  w.mem.put(id, { ...w.mem.get(id), status: 'resolved', resolution: 'reconciled' });
  await w.deliver('charge.dispute.updated', dispute('under_review'));
  assert.equal(w.mem.get(`${id}:closed`), null, 'a change that is not an outcome opens nothing');
  assert.equal((await w.deliver('charge.dispute.closed', dispute('lost'))).body.reviewRequired, true);
  assert.deepEqual([w.mem.get(`${id}:closed`).status, w.mem.get(`${id}:closed`).disputeStatus], ['open', 'lost']);
  assert.deepEqual(w.mem.get('jobs/job-hook'), booked, 'disputes never write money');
});

test('webhook: a portal session that fails verification (another currency) is refused like a crew one, not retried as an outage', async t => {
  const w = webhookWorld(); t.after(w.restore);
  const { payment, invoice, ...unpaid } = paidJob();
  w.mem.put('jobs/job-hook', unpaid);
  const cad = w.session('job-hook', 25000, { currency: 'cad' });
  assert.deepEqual(await w.deliver('checkout.session.completed', { id: cad.id, metadata: cad.metadata, payment_status: 'paid' }), { status: 409, body: { ok: false, error: 'Payment needs manager review' } });
  assert.equal(w.mem.get('jobs/job-hook').payment, undefined);
});

test('tip payroll holds a tip while a card dispute on its charge is open', () => {
  const job = { id: 'job-tip', ...paidJob(), assignedCrew: ['crew1'], payment: { ...paidJob().payment, tips: [{ sessionId: SESSION, paymentIntentId: 'pi_refund_paid', amountCents: 5000, amount: 50, source: 'customer_portal', verifiedAt: PAID_AT }] } };
  const reviews = new Map([['job-tip', [{ sessionId: SESSION, jobId: 'job-tip', status: 'open', reason: 'payment_disputed', tipCents: 5000 }]]]);
  const allocation = computeTipAllocation({ jobs: [job], timecards: [], start: '2026-09-14', end: '2026-09-28', now: NOW, refundReviews: reviews });
  assert.ok(allocation.jobs[0].reasons.includes('tip_refund_open'));
});

test('the Hub money screen records a refund through the money API, with the server\'s methods and reasons, and starts no customer message', () => {
  const source = readFileSync(new URL('../employee-money-actions.js', import.meta.url), 'utf8'), at = source.indexOf('const LIFECYCLE='), lifecycle = source.slice(at, source.indexOf('\n', at));
  assert.match(source, /action:'payment\.record_refund'/);
  assert.ok(at > 0 && !lifecycle.includes('record_refund'), 'a refund starts no HighLevel lifecycle trigger');
  const list = name => { const start = source.indexOf(`const ${name}=`); return [...source.slice(start, source.indexOf(';', start)).matchAll(/\['([a-z_]+)',/g)].map(match => match[1]); };
  assert.deepEqual(list('REFUND_METHODS').sort(), [...REFUND_METHODS].sort());
  assert.deepEqual(list('REFUND_REASONS').sort(), Object.keys(MONEY_REFUND_REASONS).sort());
});
