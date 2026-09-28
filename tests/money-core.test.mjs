import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { customerDepositState, customerMoneyState } from '../functions/_lib/customer-payments.js';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { approvedChangeCents, customerMoneyTotals, depositCents, estimateMoney, invoiceFromEstimate, invoiceLineItems, invoiceNumber, invoiceStatus, moneyCents, moneyStateCents, paymentEntries, paymentEntry, paymentLedger } from '../functions/_lib/money-core.js';
import { financialFacts } from '../functions/_lib/operations-financials.js';
import { CUSTOMER_LINE_FIELDS, estimateFingerprint, legacyLineItems, toLegacyLineItem } from '../functions/_lib/quote-model.js';
import * as portal from '../functions/api/customer-portal.js';

const NOW = '2026-09-22T18:00:00.000Z', PAID_AT = '2026-09-20T16:30:00.000Z', FIXED = Date.parse(NOW);
const env = { FIREBASE_API_KEY: 'firebase-test-money-core', CUSTOMER_PORTAL_SECRET: 'synthetic-money-core-portal-secret-000000' };
const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const sourceLine = (source, prefix) => source.split(/\r?\n/).find(line => line.startsWith(prefix));
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [FIXED])); } static now() { return FIXED; } }
const dollars = cents => cents / 100;
const scope = 'Synthetic scope: two-car garage reset';

// Shapes the Hub, the walkthrough handoff and the payment paths actually write.
const fixtures = () => [
  { id: 'synthetic-hub-estimate-000101', type: 'job', customer: 'Synthetic Customer', serviceType: 'Garage transformation', total: 1425, priceQuoted: 1425, estimate: { number: 'EST-000101', status: 'draft', amount: 1425, scope, lineItems: [{ name: 'Garage transformation', description: scope, quantity: 1, amount: 1425 }], depositRequired: 712.5, termsVersion: '2026-09', revision: 1 }, deposit: { amount: 712.5, status: 'required' } },
  { id: 'synthetic-walkthrough-job-000102', type: 'job', customer: 'Synthetic Customer', serviceType: 'Garage transformation', total: 1400.01, priceQuoted: 1400.01, quoteStatus: 'approved', customerApproval: { status: 'approved', approvedAt: PAID_AT, amount: 1400.01 }, estimate: { number: 'EST-000102', revision: 1, status: 'accepted', amount: 1400.01, depositRequired: 700.01, acceptedAt: PAID_AT }, deposit: { amount: 700.01, paidAmount: 0, status: 'due' }, acceptedHandoffPayload: { quote: { line_items: [{ name: 'Garage cleanout and reset', qty: 1, total: 1400.01 }] } } },
  { id: 'synthetic-stripe-deposit-000103', type: 'job', customer: 'Synthetic Customer', serviceType: 'Garage transformation', total: 1000, estimate: { status: 'accepted', amount: 1000, depositRequired: 500, scope, lineItems: [{ name: 'Garage transformation', description: scope, quantity: 1, amount: 1000 }] }, deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true }, payment: { amount: 500, verified: true, method: 'stripe', processor: 'stripe', receiptUrl: 'https://pay.stripe.com/receipts/synthetic-1', reference: 'pi_synthetic_1', stripeSessions: [{ sessionId: 'cs_test_synthetic_1', paymentIntentId: 'pi_synthetic_1', amount: 500, purpose: 'deposit', verifiedAt: PAID_AT }] }, invoice: { amount: 1000, paid: 500, balance: 500, status: 'partial' } },
  { id: 'synthetic-completed-cleanout-000104', type: 'cleanout', serviceType: 'Garage cleanout', priceQuoted: 850, status: 'completed', payment: { amount: 200, verified: true, method: 'deposit', recordedBy: 'zacb', reference: 'check-1001', lastAmount: 200, lastReceivedAt: PAID_AT } },
  { id: 'synthetic-locked-total-000105', type: 'job', lockedTotal: 640.4, invoice: { paid: 100.1 } },
  { id: 'synthetic-rate-job-000106', type: 'reorg', rate: 399.99, deposit: { paidAmount: 150 } },
  { id: 'synthetic-approval-only-000107', type: 'job', customerApproval: { status: 'approved', amount: 975.5 }, invoice: { amountPaid: 975.5 } },
  { id: 'synthetic-two-lines-000108', type: 'job', serviceType: 'Garage transformation', total: 1400, estimate: { status: 'accepted', amount: 1400, depositRequired: 0, lineItems: [{ name: 'Cleanout', description: 'Two loads', quantity: 1, amount: 900 }, { name: 'Shelving', description: '', quantity: 2, amount: 500 }] } },
  { id: 'synthetic-deposit-over-000109', type: 'job', total: 300, estimate: { amount: 300, depositRequired: 500 } },
  { id: 'synthetic-final-walk-000110', type: 'job', serviceType: 'Garage transformation', total: 1200, estimate: { status: 'approved', amount: 1200, depositRequired: 600 }, deposit: { amount: 600, paidAmount: 600 }, payment: { amount: 600, verified: true }, status: 'in_progress', postJobProgress: { standardItems: [{ key: '0_1', completed: true }] } },
  { id: 'synthetic-overpaid-000111', type: 'job', serviceType: 'Garage transformation', total: 1000, estimate: { amount: 1000 }, payment: { amount: 1200, verified: true }, pipelineStatus: 'paid' },
  { id: 'synthetic-string-money-000112', type: 'job', total: '1500.50', estimate: { amount: '1500.50', depositRequired: '750.25' }, payment: { amount: '250' } },
];

function legacyFigures(totals) {
  return {
    money: { total: dollars(totals.totalCents), paid: dollars(totals.paidCents), balance: dollars(totals.balanceCents) },
    deposit: { required: dollars(totals.depositRequiredCents), paid: dollars(totals.depositPaidCents), due: dollars(totals.depositDueCents), dueNow: dollars(totals.dueNowCents), purpose: totals.purpose, remainder: dollars(totals.remainderCents) },
  };
}

test('single-line estimates produce exactly the customerMoneyState and customerDepositState figures', () => {
  for (const job of fixtures()) {
    const totals = customerMoneyTotals(job), legacy = legacyFigures(totals);
    assert.deepEqual(totals.issues, [], job.id);
    assert.equal(totals.approvedChangeCents, 0);
    assert.equal(totals.totalCents, totals.quoteCents);
    assert.deepEqual(legacy.money, customerMoneyState(job), job.id);
    assert.deepEqual(legacy.deposit, customerDepositState(job), job.id);
    for (const key of ['quoteCents', 'totalCents', 'paidCents', 'balanceCents', 'depositRequiredCents', 'dueNowCents']) assert.ok(Number.isSafeInteger(totals[key]), `${job.id} ${key}`);
  }
  assert.equal(moneyStateCents, customerMoneyTotals);
});

test('the customer portal shows the model lines and money for the same saved jobs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED });
  const rows = new Map(fixtures().map(job => [job.id, job]));
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.hostname !== 'firestore.googleapis.com') throw new Error(`Unexpected request ${url.hostname}`);
    const id = decodeURIComponent(url.pathname.split('/documents/jobs/')[1] || ''), job = rows.get(id);
    return job ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, fields: encodeFirestoreFields(job), updateTime: '2026-09-22T00:00:00.000001Z' }) : Response.json({}, { status: 404 });
  });
  for (const job of rows.values()) {
    // Owner sessions name their account link version (P4-15); these jobs were never revoked.
    const cookie = (await createCustomerPortalSessionCookie(env, job.id, { linkVersion: 0 })).split(';')[0];
    const response = await portal.onRequestGet({ request: new Request('https://easygaragecleaning.com/api/customer-portal', { headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie } }), env });
    assert.equal(response.status, 200, job.id);
    const view = await response.json(), totals = customerMoneyTotals(job), legacy = legacyFigures(totals);
    assert.deepEqual(view.estimate.lineItems, legacyLineItems(job).lineItems.map(toLegacyLineItem), job.id);
    assert.equal(view.estimate.amount, dollars(totals.quoteCents));
    assert.equal(view.estimate.depositRequired, dollars(totals.depositRequiredCents));
    assert.deepEqual({ total: view.payment.total, paid: view.payment.paid, balance: view.payment.balance }, legacy.money, job.id);
    assert.deepEqual(view.payment.deposit, legacy.deposit, job.id);
  }
});

test('printed estimates and invoices list the same lines the model reads', async () => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = value => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const source = ['const esc=', 'const payMoney=', 'function financeState(', 'function customerDocumentTerms(', 'window.opsPrintDocument='].map(prefix => sourceLine(suite, prefix)).join('\n');
  // The print view prices from estimate.amount||total||priceQuoted only, so jobs
  // quoted solely through lockedTotal/rate/customerApproval.amount print $0.00
  // today; the regression covers the jobs where both read the same saved price.
  const printTotal = job => Number(job.invoice?.amount && !['draft', 'superseded', 'void'].includes(job.invoice?.status) ? job.invoice.amount : job.estimate?.amount || job.total || job.priceQuoted || 0);
  const covered = fixtures().filter(job => moneyCents(printTotal(job)) === customerMoneyTotals(job).totalCents);
  assert.ok(covered.length >= 8);
  for (const job of covered) {
    for (const kind of ['estimate', 'invoice']) {
      let html = '';
      const context = vm.createContext({ Date: FixedDate, window: { open: () => ({ document: { write: value => { html += value; }, close() {} } }) }, jobs: () => [job], location: { origin: 'https://easygaragecleaning.com' }, day: () => '2026-09-22', dateLabel: String });
      vm.runInContext(source, context);
      await context.window.opsPrintDocument(job.id, kind);
      const printed = [...html.matchAll(/<div class="line"><span><strong>(.*?)<\/strong>(?:<small>(.*?)<\/small>)?<\/span><strong>(.*?)<\/strong><\/div>/g)].map(([, name, description = '', amount]) => ({ name, description, amount }));
      const expected = legacyLineItems(job, { record: kind, surface: 'document' }).lineItems.map(line => ({ name: esc(line.name), description: esc(line.description), amount: money(line.amount) }));
      assert.deepEqual(printed, expected, `${job.id} ${kind}`);
      assert.match(html, new RegExp(`<span>Total</span><strong>${money(dollars(customerMoneyTotals(job).totalCents)).replace(/[$.]/g, '\\$&')}</strong>`), `${job.id} ${kind} total`);
    }
  }
});

test('invoiceFromEstimate matches the Hub Issue invoice action for single-line jobs', async () => {
  const input = { dueDate: '2026-09-29', customerReference: 'PO-77' };
  const covered = fixtures().filter(row => Number(row.total) > 0 && moneyCents(row.total) === customerMoneyTotals(row).quoteCents);
  assert.ok(covered.length >= 8);
  assert.ok(covered.filter(row => !row.serviceType).length >= 2, 'jobs without a serviceType are covered: the Hub names their line Garage transformation');
  for (const job of covered) {
    const captured = {};
    const context = vm.createContext({ Date: FixedDate, window: {}, jobs: () => [job], financeDatePlus: () => '2026-09-29', money: String, askAction: async () => input, patchJob: async (id, update) => { captured.update = update; }, syncCustomerCommunication: async () => true, render: () => {}, employeeIdentity: () => 'zacb', jobStage: row => row.pipelineStatus || row.status || 'scheduled' });
    vm.runInContext(suite.slice(suite.indexOf('window.opsFinanceAction='), suite.indexOf('function addCalendarMonths')), context);
    await context.window.opsFinanceAction(job.id, 'invoice');
    const hub = JSON.parse(JSON.stringify(captured.update.invoice)), { invoice, issues } = invoiceFromEstimate(job, { now: NOW, ...input });
    assert.deepEqual(issues, [], job.id);
    for (const key of ['number', 'status', 'amount', 'paid', 'balance', 'dueDate', 'customerReference', 'termsVersion', 'issuedAt']) assert.equal(invoice[key], hub[key], `${job.id} ${key}`);
    assert.deepEqual(invoice.lineItems.map(toLegacyLineItem), hub.lineItems, job.id);
    assert.equal(invoice.amountCents, Math.round(hub.amount * 100));
  }
});

test('approved change orders are counted on top of the quote while the deposit stays on the quote', () => {
  const job = { ...fixtures()[2], customerDecisions: [{ id: 'decision-1', title: 'Haul the old freezer', details: 'Customer approved in the portal', priceDelta: 150, status: 'approved' }, { id: 'decision-2', title: 'Paint', priceDelta: 400, status: 'declined' }, { id: 'decision-3', title: 'Epoxy patch', priceDelta: 75.25, status: 'approved' }], approvedChangeTotal: 225.25 };
  const totals = customerMoneyTotals(job);
  assert.equal(totals.quoteCents, 100000); assert.equal(totals.approvedChangeCents, 22525);
  assert.equal(totals.totalCents, 122525); assert.equal(totals.balanceCents, 72525);
  assert.equal(totals.depositRequiredCents, 50000); assert.equal(totals.depositDueCents, 0);
  assert.equal(customerMoneyState(job).balance, 500, 'the legacy helper (unchanged in this unit) still ignores approved changes');
  const { approvedChangeTotal, ...derivedOnly } = job;
  assert.equal(customerMoneyTotals(derivedOnly).approvedChangeCents, 22525, 'derived from approved decisions when no saved total exists');
  const issues = [];
  assert.equal(approvedChangeCents({ ...job, approvedChangeTotal: 100 }, issues), 10000);
  assert.deepEqual(issues, ['money_change_order_conflict']);
  assert.equal(customerMoneyTotals({ ...job, approvedChangeTotal: 'lots' }).totalCents, null);
  const { invoice } = invoiceFromEstimate(job, { now: NOW });
  assert.equal(invoice.amountCents, 122525); assert.equal(invoice.approvedChangeCents, 22525);
  assert.deepEqual(invoice.lineItems.map(line => [line.id, line.name, line.totalCents]), [['line-1', 'Garage transformation', 100000], ['change-decision-1', 'Approved change: Haul the old freezer', 15000], ['change-decision-3', 'Approved change: Epoxy patch', 7525]]);
  assert.equal(invoice.lineItems.reduce((sum, line) => sum + line.totalCents, 0), invoice.amountCents);
  const lumped = invoiceFromEstimate({ ...job, customerDecisions: [] }, { now: NOW }).invoice;
  assert.deepEqual(lumped.lineItems.map(line => [line.id, line.totalCents]), [['line-1', 100000], ['change-orders', 22525]], 'an unitemized saved total still reaches the invoice');
});

test('invalid saved money returns null (moneyCents semantics) instead of the legacy zero or guess', () => {
  const cases = [
    [{ estimate: { amount: '1,900' } }, 'quoteCents', 'money_quote_invalid'],
    [{ estimate: { amount: -5 } }, 'quoteCents', 'money_quote_invalid'],
    [{ id: 'synthetic-empty' }, 'quoteCents', 'money_quote_missing'],
    [{ total: 1000, payment: { amount: 'paid' } }, 'paidCents', 'money_paid_invalid'],
    [{ total: 1000, estimate: { depositRequired: 'half' } }, 'depositRequiredCents', 'money_deposit_invalid'],
  ];
  for (const [job, field, issue] of cases) {
    const totals = customerMoneyTotals(job);
    assert.equal(totals[field], null, field);
    assert.ok(totals.issues.includes(issue), issue);
    assert.equal(totals.complete, false);
  }
  assert.equal(customerMoneyState({ estimate: { amount: '1,900' } }).total, 1900, 'legacy coerces text; the money core refuses to guess');
  assert.equal(customerMoneyState({ id: 'synthetic-empty' }).total, 0);
  assert.equal(customerMoneyTotals({ estimate: { amount: '1,900' } }).balanceCents, null);
  assert.throws(() => invoiceFromEstimate({ id: 'synthetic-empty' }, { now: NOW }), error => error.code === 'money_total_unknown' && error.status === 409);
});

test('estimateMoney totals selected lines only, adds approved changes and rounds the deposit to the cent', () => {
  const lines = [{ id: 'base', kind: 'service', name: 'Reset', amount: 1000.01 }, { id: 'rush', kind: 'fee', name: 'Rush', unitCents: 5000, optional: true }, { id: 'totes', kind: 'product', name: 'Totes', unitCents: 2150, quantity: 4, optional: true, selected: true }];
  const money = estimateMoney(lines, { approvedChangeCents: 15000 });
  assert.equal(money.totalCents, 108601); assert.equal(money.optionalAvailableCents, 5000);
  assert.equal(money.contractCents, 123601); assert.equal(money.depositCents, 54301);
  assert.equal(estimateMoney([lines[0]]).depositCents, 50001, '1000.01 -> 500.01');
  assert.equal(estimateMoney([lines[0]], { depositRequiredCents: 20000 }).depositCents, 20000);
  assert.equal(estimateMoney([lines[0]], { depositRequiredCents: 900000 }).depositCents, 100001, 'a saved deposit never exceeds the total');
  assert.equal(estimateMoney([lines[0]], { depositPct: 25 }).depositCents, 25000);
  assert.throws(() => estimateMoney(lines, { approvedChangeCents: -1 }), error => error.code === 'money_invalid_amount');
  assert.equal(estimateMoney([{ name: 'Unknown', amount: 'TBD' }]).depositCents, null);
});

test('tips are paid through the ledger but never count as revenue or toward the balance', () => {
  const job = { id: 'synthetic-tip-000201', total: 1000, estimate: { amount: 1000, depositRequired: 500 }, status: 'completed', payment: { amount: 1100, verified: true, stripeSessions: [{ sessionId: 'cs_test_tip_a', paymentIntentId: 'pi_tip_a', amount: 1000, purpose: 'balance', verifiedAt: PAID_AT }, { sessionId: 'cs_test_tip_b', paymentIntentId: 'pi_tip_b', amount: 100, purpose: 'tip', verifiedAt: '2026-09-20T17:00:00.000Z' }] } };
  const totals = customerMoneyTotals(job);
  assert.equal(totals.revenueCents, 100000); assert.equal(totals.tipCents, 10000);
  assert.equal(totals.appliedCents, 100000); assert.equal(totals.balanceCents, 0); assert.equal(totals.overpaidCents, 0);
  assert.equal(paymentLedger(job).complete, true);
  assert.deepEqual(paymentEntries(job).map(entry => entry.kind), ['balance', 'tip']);
});

test('paymentEntries unifies Stripe sessions, the latest staff receipt and gift credit', () => {
  const job = { id: 'synthetic-ledger-000301', total: 2000, estimate: { amount: 2000 },
    payment: { amount: 1600, verified: true, method: 'offline_or_processor', reference: 'check-2002', recordedBy: 'zacb', lastAmount: 300, lastReceivedAt: '2026-09-21T15:00:00Z', receiptUrl: 'https://pay.stripe.com/receipts/synthetic-2', giftCreditApplied: 300,
      stripeSessions: [{ sessionId: 'cs_test_ledger_1', paymentIntentId: 'pi_ledger_1', amount: 700, purpose: 'deposit', verifiedAt: '2026-09-19T15:00:00.000Z' }, { sessionId: 'cs_test_ledger_2', paymentIntentId: 'pi_ledger_2', amount: 200, verifiedAt: '2026-09-20T15:00:00.000Z', recordedBy: 'crew.one' }, { sessionId: 'cs_test_ledger_2', amount: 200, verifiedAt: '2026-09-20T15:00:00.000Z' }] },
    giftWallet: { redemptions: [{ id: 'redemption-1', requestId: 'redeem-1', cardId: 'credit-1', amount: 100, appliedAt: '2026-09-21T16:00:00.000Z', jobId: 'synthetic-ledger-000301' }, { id: 'redemption-other', cardId: 'credit-1', amount: 999, appliedAt: PAID_AT, jobId: 'another-job' }] } };
  const ledger = paymentLedger(job);
  assert.deepEqual(ledger.entries.map(entry => [entry.id, entry.kind, entry.amountCents, entry.method, entry.processorRef, entry.by, entry.source]), [
    ['stripe:cs_test_ledger_1', 'deposit', 70000, 'card', 'pi_ledger_1', 'stripe', 'stripe_session'],
    ['stripe:cs_test_ledger_2', 'balance', 20000, 'card', 'pi_ledger_2', 'crew.one', 'stripe_session'],
    ['staff:2026-09-21T15:00:00.000Z:check-2002', 'offline', 30000, 'offline_or_processor', 'check-2002', 'zacb', 'staff_receipt'],
    ['gift:redemption-1', 'balance', 10000, 'gift_credit', 'credit-1', 'customer', 'gift_credit'],
    ['gift:synthetic-ledger-000301:applied', 'balance', 20000, 'gift_credit', '', 'customer', 'gift_credit_total'],
  ]);
  assert.deepEqual(ledger.entries.map(entry => entry.receiptUrl), ['', 'https://pay.stripe.com/receipts/synthetic-2', '', '', ''], 'only the latest card payment carries the saved receipt link');
  assert.equal(ledger.entries.find(entry => entry.id === 'stripe:cs_test_ledger_2').at, '2026-09-20T15:00:00.000Z');
  assert.equal(ledger.ledgerCents, 150000); assert.equal(ledger.paidCents, 160000);
  assert.equal(ledger.unreconciledCents, 10000, 'older staff receipts are not itemized on the job, so the ledger says so');
  assert.equal(ledger.complete, false);
  const mirrored = paymentLedger({ id: 'j', payment: { amount: 500, verified: true, method: 'stripe', reference: 'pi_m', recordedBy: 'zacb', lastAmount: 500, lastReceivedAt: PAID_AT, receiptUrl: 'https://pay.stripe.com/receipts/m', stripeSessions: [{ sessionId: 'cs_live_m', paymentIntentId: 'pi_m', amount: 500, purpose: 'deposit', verifiedAt: PAID_AT }] } });
  assert.deepEqual(mirrored.entries.map(entry => [entry.id, entry.receiptUrl]), [['stripe:cs_live_m', 'https://pay.stripe.com/receipts/m']]);
  assert.equal(mirrored.complete, true);
  const deposit = paymentLedger({ id: 'j', payment: { amount: 250, verified: true, method: 'deposit', reference: 'receipt-9', recordedBy: 'alexk', lastAmount: 250, lastReceivedAt: PAID_AT } });
  assert.deepEqual(deposit.entries.map(entry => [entry.kind, entry.amountCents, entry.verified]), [['deposit', 25000, true]]);
  const unverified = paymentLedger({ id: 'j', payment: { amount: 500, verified: false, stripeSessions: [{ sessionId: 'cs_test_u', amount: 500, verifiedAt: PAID_AT }] } });
  assert.deepEqual(unverified.entries, []); assert.ok(unverified.issues.includes('money_payment_not_verified'));
  assert.ok(paymentLedger({ id: 'j', payment: { refundedAmount: 20 } }).issues.includes('money_refunds_unreconciled'));
  assert.ok(paymentLedger({ id: 'j', payment: { verified: true, stripeSessions: ['not-a-session'] } }).issues.includes('money_payment_receipt_unknown'));
  assert.ok(paymentLedger({ id: 'j', payment: { verified: true, stripeSessions: [{ sessionId: 'cs_test_x', amount: 'lots' }] } }).issues.includes('money_payment_amount_unknown'));
  assert.deepEqual(paymentEntries({}), []);
});

test('new ledger entries are validated strictly with money_ codes', () => {
  const valid = { id: 'stripe:cs_test_new', kind: 'deposit', amountCents: 50001, method: 'card', processorRef: 'pi_new', receiptUrl: 'https://pay.stripe.com/receipts/new', at: '2026-09-22T12:00:00-06:00', by: 'stripe' };
  assert.deepEqual(paymentEntry(valid), { ...valid, at: NOW });
  assert.deepEqual(paymentEntry({ id: 'cash-1', kind: 'offline', amountCents: 100, method: 'cash', at: NOW, by: 'zacb' }), { id: 'cash-1', kind: 'offline', amountCents: 100, method: 'cash', processorRef: '', receiptUrl: '', at: NOW, by: 'zacb' });
  const cases = [
    ['money_invalid_payment_entry', { ...valid, extra: 1 }], ['money_invalid_payment_entry', { ...valid, id: 'bad id' }], ['money_invalid_payment_kind', { ...valid, kind: 'credit' }],
    ['money_invalid_amount', { ...valid, amountCents: 10.5 }], ['money_invalid_amount', { ...valid, amountCents: 0 }], ['money_invalid_amount', { ...valid, amountCents: -100 }],
    ['money_invalid_payment_method', { ...valid, method: 'Card!' }], ['money_invalid_receipt_url', { ...valid, receiptUrl: 'https://evil.example/receipt' }],
    ['money_invalid_time', { ...valid, at: '2026-09-22' }], ['money_invalid_time', { ...valid, at: 'yesterday' }], ['money_invalid_actor', { ...valid, by: '' }], ['money_invalid_payment_entry', null],
  ];
  for (const [code, raw] of cases) assert.throws(() => paymentEntry(raw), error => error.code === code && error.status === 400, code);
});

test('document numbers are deterministic EST-/INV- plus the last six characters of the job id', () => {
  assert.equal(invoiceNumber('synthetic-job-abc123'), 'INV-ABC123');
  assert.equal(invoiceNumber('synthetic-job-abc123', 'estimate'), 'EST-ABC123');
  assert.equal(invoiceNumber('ab1'), 'INV-AB1');
  assert.equal(invoiceNumber('synthetic-job-abc123', 'invoice', ' INV-2026-001 '), 'INV-2026-001');
  const job = fixtures()[0];
  assert.equal(invoiceFromEstimate(job, { now: NOW }).invoice.number, 'INV-000101');
  assert.equal(invoiceFromEstimate({ ...job, invoice: { number: 'INV-KEPT', status: 'void', issuedAt: '2026-09-01T00:00:00.000Z', customerReference: 'old' } }, { now: NOW }).invoice.number, 'INV-KEPT');
});

test('invoices use the injected clock, Denver due dates and only selected lines', () => {
  const job = { id: 'synthetic-options-000401', total: 1500, serviceType: 'Garage transformation', estimate: { status: 'accepted', revision: 3, amount: 1500, depositRequired: 750, lineItems: [{ id: 'base', kind: 'service', name: 'Reset', unitCents: 120000 }, { id: 'epoxy', kind: 'service', name: 'Epoxy', unitCents: 30000, optional: true, selected: true }, { id: 'rush', kind: 'fee', name: 'Rush', unitCents: 9900, optional: true }] }, payment: { amount: 750, verified: true } };
  const late = invoiceFromEstimate(job, { now: '2026-09-23T03:30:00.000Z' });
  assert.equal(late.invoice.dueDate, '2026-09-29', 'late evening in Denver is still Sept 22 there');
  assert.equal(late.invoice.issuedAt, '2026-09-23T03:30:00.000Z'); assert.equal(late.invoice.updatedAt, '2026-09-23T03:30:00.000Z');
  assert.deepEqual(late.invoice.lineItems.map(line => line.id), ['base', 'epoxy']);
  assert.equal(late.invoice.status, 'issued'); assert.equal(late.invoice.balanceCents, 75000); assert.equal(late.invoice.estimateRevision, 3);
  assert.equal(late.invoice.estimateFingerprint, estimateFingerprint(job.estimate));
  assert.equal(invoiceFromEstimate(job, { now: NOW, dueDays: 0 }).invoice.dueDate, '2026-09-22');
  const kept = invoiceFromEstimate({ ...job, invoice: { number: 'INV-1', issuedAt: '2026-09-10T00:00:00.000Z', status: 'issued', customerReference: 'PO-1' } }, { now: NOW }).invoice;
  assert.equal(kept.issuedAt, '2026-09-10T00:00:00.000Z'); assert.equal(kept.customerReference, 'PO-1');
  const reissued = invoiceFromEstimate({ ...job, invoice: { number: 'INV-1', issuedAt: '2026-09-10T00:00:00.000Z', status: 'superseded', supersededAt: '2026-09-11T00:00:00.000Z' } }, { now: NOW }).invoice;
  assert.equal(reissued.issuedAt, NOW); assert.equal(reissued.supersededAt, undefined); assert.equal(reissued.number, 'INV-1');
  assert.equal(invoiceFromEstimate({ ...job, payment: { amount: 1500, verified: true } }, { now: NOW }).invoice.status, 'paid');
  assert.equal(invoiceFromEstimate({ ...job, payment: { amount: 1500, verified: false } }, { now: NOW }).invoice.status, 'pending_verification');
  const drift = invoiceFromEstimate({ ...job, estimate: { ...job.estimate, amount: 1600 } }, { now: NOW });
  assert.deepEqual(drift.issues, ['money_line_items_mismatch']);
  assert.deepEqual(drift.invoice.lineItems.map(line => [line.id, line.name, line.totalCents]), [['legacy-1', 'Garage transformation', 160000]], 'lines that disagree with the saved price fall back to one honest line');
  assert.deepEqual(invoiceLineItems(job).issues, []);
  for (const [options, code] of [[{ now: 'soon' }, 'money_invalid_time'], [{ now: NOW, dueDate: '2026-02-30' }, 'money_invalid_due_date'], [{ now: NOW, dueDays: -1 }, 'money_invalid_due_date']]) assert.throws(() => invoiceFromEstimate(job, options), error => error.code === code, code);
  for (const bad of [null, { id: '_egc_lock' }, { id: 'secure_vault' }]) assert.throws(() => invoiceFromEstimate(bad, { now: NOW }), error => error.code === 'money_invalid_job');
  assert.throws(() => invoiceFromEstimate({ id: 'zero', total: 0 }, { now: NOW }), error => error.code === 'money_invoice_empty');
});

test('invoiceStatus derives overdue, partial and paid from the Denver date', () => {
  const job = { id: 'synthetic-status', total: 1000, estimate: { amount: 1000 }, invoice: { number: 'INV-1', status: 'issued', dueDate: '2026-09-22', issuedAt: PAID_AT }, payment: { amount: 0 } };
  assert.equal(invoiceStatus(job, NOW), 'issued');
  assert.equal(invoiceStatus(job, '2026-09-23T05:59:00.000Z'), 'issued', 'still Sept 22 in Denver');
  assert.equal(invoiceStatus(job, '2026-09-23T06:00:00.000Z'), 'overdue');
  assert.equal(invoiceStatus({ ...job, payment: { amount: 400, verified: true } }, NOW), 'partial');
  assert.equal(invoiceStatus({ ...job, payment: { amount: 1000, verified: true } }, '2026-10-30T00:00:00.000Z'), 'paid');
  assert.equal(invoiceStatus({ ...job, payment: { amount: 1000 } }, NOW), 'pending_verification');
  assert.equal(invoiceStatus({ ...job, invoice: { ...job.invoice, status: 'superseded' } }, '2026-12-01T00:00:00.000Z'), 'superseded');
  assert.equal(invoiceStatus({ id: 'none', total: 5 }, NOW), 'not_issued');
  assert.throws(() => invoiceStatus(job, 'later'), error => error.code === 'money_invalid_time');
});

test('saved money above the $1,000,000 cap is null plus an issue and reads never throw', () => {
  const huge = { id: 'synthetic-huge-000601', type: 'job', total: 1e9, estimate: { amount: 1e9 }, invoice: { number: 'INV-1', status: 'issued', dueDate: '2026-09-20', issuedAt: PAID_AT } };
  let totals;
  assert.doesNotThrow(() => { totals = customerMoneyTotals(huge); }, 'the probe threw quote_invalid_amount from depositCents');
  assert.deepEqual([totals.quoteCents, totals.totalCents, totals.depositRequiredCents, totals.balanceCents, totals.complete], [null, null, null, null, false]);
  assert.ok(totals.issues.includes('money_quote_invalid'));
  assert.equal(invoiceStatus(huge, NOW), 'overdue');
  assert.throws(() => invoiceFromEstimate(huge, { now: NOW }), error => error.code === 'money_total_unknown');
  const base = { id: 'synthetic-cap-000602', total: 1000, estimate: { amount: 1000 } };
  assert.equal(customerMoneyTotals({ ...base, estimate: { amount: 1000000 } }).quoteCents, 100000000, 'exactly $1,000,000 is valid');
  for (const [patch, field, issue] of [[{ estimate: { amount: 1000, depositRequired: 1000000.01 } }, 'depositRequiredCents', 'money_deposit_invalid'], [{ approvedChangeTotal: 5000000 }, 'approvedChangeCents', 'money_change_order_invalid'], [{ customerDecisions: [{ status: 'approved', priceDelta: 2000000 }] }, 'approvedChangeCents', 'money_change_order_invalid'], [{ payment: { amount: 2000000 } }, 'paidCents', 'money_paid_invalid']]) {
    const result = customerMoneyTotals({ ...base, ...patch });
    assert.equal(result[field], null, issue); assert.ok(result.issues.includes(issue), issue); assert.equal(result.complete, false);
  }
  const odd = [1e11, 1e21, Number.MAX_VALUE, -1, 'x', '1e3', NaN, Infinity, {}, [], true, '999999999999.99', null, undefined];
  let checked = 0;
  for (const value of odd) for (const build of [
    v => ({ estimate: { amount: v } }), v => ({ total: v }), v => ({ estimate: { amount: 100, depositRequired: v } }), v => ({ total: 100, deposit: { amount: v } }), v => ({ total: 100, approvedChangeTotal: v }),
    v => ({ total: 100, customerDecisions: [{ id: 'd', status: 'approved', priceDelta: v }] }), v => ({ total: 100, payment: { amount: v, verified: true, stripeSessions: [{ sessionId: 'cs_test_odd', amount: v, purpose: 'tip' }], giftCreditApplied: v, lastAmount: v, recordedBy: 'zacb', reference: 'r' } }),
    v => ({ total: 100, invoice: { status: v, amount: v, dueDate: v, paid: v } }), v => ({ total: 100, giftWallet: { redemptions: [{ id: 'g', jobId: 'synthetic-odd', amount: v }] } }),
  ]) {
    const job = { id: 'synthetic-odd', ...build(value) };
    assert.doesNotThrow(() => { customerMoneyTotals(job); paymentLedger(job); invoiceLineItems(job); invoiceStatus(job, NOW); }, `${JSON.stringify(job)}`);
    checked++;
  }
  assert.equal(checked, odd.length * 9);
});

test('estimateMoney and the money-core depositCents throw money_ codes and read lines without throwing', () => {
  const line = (id, unitCents, extra = {}) => ({ id, kind: 'service', name: `Synthetic ${id}`, unitCents, ...extra });
  let over;
  assert.doesNotThrow(() => { over = estimateMoney([line('a', 60000000), line('b', 60000000)]); }, 'lenient lines over the cap never reach depositCents');
  assert.deepEqual([over.totalCents, over.contractCents, over.depositCents, over.complete], [null, null, null, false]);
  assert.equal(estimateMoney([line('a', 100000000)]).depositCents, 50000000);
  for (const [options, code] of [[{ depositPct: 101 }, 'money_invalid_deposit_percent'], [{ depositPct: '50' }, 'money_invalid_deposit_percent'], [{ depositRequiredCents: 100000001 }, 'money_invalid_amount'], [{ approvedChangeCents: 100000001 }, 'money_invalid_amount'], [{ approvedChangeCents: 1.5 }, 'money_invalid_amount']]) {
    assert.throws(() => estimateMoney([line('a', 1000)], options), error => error.code === code && error.status === 400, code);
    assert.throws(() => estimateMoney([line('a', 60000000), line('b', 60000000)], options), error => error.code === code, `${code} even when the lines are unreadable`);
  }
  assert.equal(depositCents(100001), 50001);
  for (const [args, code] of [[[100000001], 'money_invalid_amount'], [[-1], 'money_invalid_amount'], [[1000, 12.345], 'money_invalid_deposit_percent']]) assert.throws(() => depositCents(...args), error => error.code === code && error.status === 400, code);
});

test('invoice lines are a customer projection: no cost split, markup, catalog or duration reaches an invoice', () => {
  const job = { id: 'synthetic-canary-000501', type: 'job', serviceType: 'Garage transformation', total: 1201, approvedChangeTotal: 100,
    customerDecisions: [{ id: 'd1', title: 'Extra haul', priceDelta: 100, status: 'approved' }],
    invoice: { number: 'INV-OLD', status: 'issued', lineItems: [{ name: 'Old', amount: 1, split: { markupCents: 99 }, catalog: { itemId: 'old' } }] },
    estimate: { amount: 1201, scope: 'Synthetic scope', lineItems: [
      { id: 'shelf', kind: 'product', name: 'Shelving', unitCents: 100000, taxable: true, customerSupplied: false, split: { productCents: 60000, laborCents: 30000, markupCents: 10000, laborMinutes: 90 }, catalog: { itemId: 'shelf-kit', version: 3 }, durationMinutes: 90 },
      { id: 'bins', kind: 'product', name: 'Bins', unitCents: 20100, optional: true, selected: true, group: { id: 'addons', label: 'Add-ons', zone: 'north wall', selection: 'multi' }, tier: 'good', package: 'Starter kit', split: { productCents: 15000, markupCents: 5100 } },
      { id: 'rush', kind: 'fee', name: 'Rush', unitCents: 5000, optional: true, split: { laborCents: 5000 } },
    ] } };
  const leaks = /markupCents|split|catalog|durationMinutes|laborMinutes|productCents|laborCents|disposalCents|customerSupplied|shelf-kit|north wall|Starter kit|"group"|"tier"|"package"/;
  const { invoice, issues } = invoiceFromEstimate(job, { now: NOW });
  assert.deepEqual(issues, []);
  assert.deepEqual(invoice.lineItems.map(line => [line.id, line.totalCents]), [['shelf', 100000], ['bins', 20100], ['change-d1', 10000]]);
  for (const line of invoice.lineItems) assert.deepEqual(Object.keys(line), [...CUSTOMER_LINE_FIELDS], line.id);
  assert.doesNotMatch(JSON.stringify(invoice), leaks, 'the saved invoice record carries no internal cost data');
  assert.equal(invoice.lineItems.reduce((sum, line) => sum + line.totalCents, 0), invoice.amountCents);
  const drift = invoiceFromEstimate({ ...job, estimate: { ...job.estimate, amount: 1300 } }, { now: NOW });
  assert.deepEqual(drift.issues, ['money_line_items_mismatch']);
  assert.doesNotMatch(JSON.stringify(drift.invoice), leaks);
  assert.deepEqual(invoiceLineItems(job).lineItems.map(line => Object.keys(line).length), [CUSTOMER_LINE_FIELDS.length, CUSTOMER_LINE_FIELDS.length, CUSTOMER_LINE_FIELDS.length]);
});

test('invoice lines fall back to one Hub-named line when saved lines are repaired or disagree', () => {
  const job = { id: 'synthetic-fallback-000701', type: 'cleanout', total: 1000, estimate: { amount: 1000, scope: 'Synthetic cleanout scope', lineItems: [{ id: 'base', kind: 'service', name: 'Cleanout', unitCents: 100000 }, { id: 'epoxy', kind: 'service', name: 'Epoxy', unitCents: 50000, selected: true, group: { id: 'floors', label: 'Floors', selection: 'single', sort: 2 } }] } };
  assert.equal(invoiceLineItems(job).issues[0], 'money_line_items_incomplete', 'the repaired lines add up to the quote, but a repair is not shown to the customer as fact');
  const { invoice, issues } = invoiceFromEstimate(job, { now: NOW });
  assert.deepEqual(issues, ['money_line_items_incomplete']);
  assert.deepEqual(invoice.lineItems.map(toLegacyLineItem), [{ name: 'Garage transformation', description: 'Synthetic cleanout scope', quantity: 1, amount: 1000 }], 'the Hub invoice name, never the job type');
  const bare = invoiceFromEstimate({ id: 'synthetic-fallback-000702', type: 'job', total: 640, estimate: { amount: 640, lineItems: [{ name: 'Old line', quantity: 1, amount: 600 }] } }, { now: NOW });
  assert.deepEqual(bare.invoice.lineItems.map(toLegacyLineItem), [{ name: 'Garage transformation', description: '', quantity: 1, amount: 640 }]);
});

test('the payment ledger merges Stripe receipts by session and intent exactly like the revenue report', () => {
  const later = '2026-09-21T16:30:00.000Z';
  const job = { id: 'synthetic-receipts-000801', type: 'job', total: 1000, estimate: { amount: 1000 }, customerApproval: { status: 'approved', approvedAt: PAID_AT, amount: 1000 },
    payment: { amount: 500, verified: true, method: 'stripe', reference: 'pi_dup', stripeSessions: [
      { paymentIntentId: 'pi_dup', amount: 300, purpose: 'deposit', verifiedAt: PAID_AT },
      { sessionId: 'cs_live_dup', paymentIntentId: 'pi_dup', amount: 300, purpose: 'deposit', verifiedAt: PAID_AT },
      { sessionId: 'cs_live_dup', amount: 300, purpose: 'deposit', verifiedAt: PAID_AT },
      { sessionId: 'cs_live_other', paymentIntentId: 'pi_other', amount: 200, purpose: 'balance', verifiedAt: later },
    ] } };
  const ledger = paymentLedger(job), facts = financialFacts(job);
  assert.deepEqual(ledger.entries.map(entry => [entry.id, entry.amountCents]), [['stripe:pi_dup', 30000], ['stripe:cs_live_other', 20000]], 'an intent-only row and the session rows for one payment count once (the old ledger counted 80000)');
  assert.equal(ledger.entries.length, facts.payments.length, 'the same receipts the revenue report counts');
  assert.deepEqual([ledger.ledgerCents, ledger.unreconciledCents, ledger.conflicts, ledger.complete], [50000, 0, [], true]);
  const conflicted = { ...job, payment: { ...job.payment, amount: 800, stripeSessions: [...job.payment.stripeSessions, { sessionId: 'cs_live_tip', amount: 100, purpose: 'tip', verifiedAt: later }, { sessionId: 'cs_live_tip', paymentIntentId: 'pi_tip', amount: 150, purpose: 'tip', verifiedAt: later }] } };
  const split = paymentLedger(conflicted);
  assert.ok(split.issues.includes('money_payment_conflict'));
  assert.equal(split.conflicts.length, 1); assert.equal(financialFacts(conflicted).paymentConflicts.length, 1);
  assert.deepEqual(split.entries.map(entry => entry.id), ['stripe:pi_dup', 'stripe:cs_live_other'], 'a conflicting receipt group is not listed as fact');
  assert.deepEqual([split.unreconciledCents, split.tipCents, split.complete], [null, null, false]);
  const totals = customerMoneyTotals(conflicted);
  assert.deepEqual([totals.appliedCents, totals.balanceCents, totals.complete], [null, null, false], 'an unknown tip keeps the balance unknown');
  assert.ok(totals.issues.includes('money_tips_unknown'));
  const purpose = paymentLedger({ id: 'j', payment: { amount: 100, verified: true, stripeSessions: [{ sessionId: 'cs_live_p', amount: 100, purpose: 'deposit', verifiedAt: PAID_AT }, { sessionId: 'cs_live_p', paymentIntentId: 'pi_p', amount: 100, purpose: 'tip', verifiedAt: PAID_AT }] } });
  assert.ok(purpose.issues.includes('money_payment_conflict'), 'rows for one payment that disagree on tip vs deposit are a conflict');
});

test('money logic uses only the injected clock and requires it', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2031-03-01T12:00:00.000Z') });
  const job = { id: 'synthetic-clock-000901', type: 'job', serviceType: 'Garage transformation', total: 1000, estimate: { amount: 1000 }, payment: { amount: 0 } };
  const { invoice } = invoiceFromEstimate(job, { now: NOW });
  assert.deepEqual([invoice.issuedAt, invoice.updatedAt, invoice.dueDate], [NOW, NOW, '2026-09-29'], 'the mocked wall clock (2031) is never read');
  const issued = { ...job, invoice };
  assert.equal(invoiceStatus(issued, NOW), 'issued');
  assert.equal(invoiceStatus(issued, '2026-09-30T06:00:00.000Z'), 'overdue');
  const required = error => error.code === 'money_now_required' && error.status === 500;
  assert.throws(() => invoiceFromEstimate(job), required);
  assert.throws(() => invoiceFromEstimate(job, {}), required);
  assert.throws(() => invoiceFromEstimate(job, { now: undefined, dueDays: 3 }), required);
  assert.throws(() => invoiceStatus(issued), required);
  assert.throws(() => invoiceStatus(issued, null), error => error.code === 'money_invalid_time');
});
