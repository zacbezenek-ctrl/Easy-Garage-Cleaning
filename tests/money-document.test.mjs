import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { customerMoneyTotals, invoiceLineItems } from '../functions/_lib/money-core.js';
import { createCustomerStripeCheckout } from '../functions/_lib/customer-payments.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { MONEY_DOCUMENT_CSP, moneyDocumentHeaders, moneyDocumentKinds, moneyDocumentLinks, moneyDocumentModel, renderMoneyDocument, renderMoneyDocumentError, usd } from '../functions/_lib/money-document.js';
import { moneyDocumentHandlers } from '../functions/api/money-document.js';
import { onRequest as middleware } from '../functions/_middleware.js';
import { env as portalEnv, NOW, portalCookie, portalHandlers, portalStore, portalView } from './helpers/portal-fixture.mjs';

const FIXED = Date.parse(NOW), ORIGIN = 'https://easygaragecleaning.com';
const env = { ...portalEnv, MONEY_DOCUMENT_ENABLED: 'true' };
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const snapshot = kind => new URL(`./snapshots/money-document-${kind}.snap`, import.meta.url);
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const crew = { user: 'crew.one', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };

// Estimate lines with an option group, optional add-ons, a discount and
// internal cost data (split, catalog, duration) that must never be shown.
const lines = () => [
  { id: 'cleanout', kind: 'service', name: 'Synthetic cleanout & haul-away', description: 'Two loads', quantity: 1, unitCents: 90000, totalCents: 90000, split: { productCents: 0, laborCents: 61111, markupCents: 28889, disposalCents: 0, laborMinutes: 240 }, catalog: { itemId: 'catalog-canary-item', version: 3 }, durationMinutes: 240 },
  { id: 'shelf-good', kind: 'product', name: 'Shelving good tier', description: '', quantity: 2, unitCents: 15000, totalCents: 30000, group: { id: 'shelving', label: 'Shelving', selection: 'single', required: false }, tier: 'good', selected: false },
  { id: 'shelf-best', kind: 'product', name: 'Shelving best tier', description: '', quantity: 2, unitCents: 25000, totalCents: 50000, group: { id: 'shelving', label: 'Shelving', selection: 'single', required: false }, tier: 'best', selected: true, split: { productCents: 17777, laborCents: 5000, markupCents: 2223, disposalCents: 0, laborMinutes: 30 } },
  { id: 'epoxy', kind: 'service', name: 'Floor epoxy add-on', description: '', quantity: 1, unitCents: 40000, totalCents: 40000, optional: true, selected: false },
  { id: 'wash', kind: 'service', name: 'Pressure wash add-on', description: '', quantity: 1, unitCents: 12500, totalCents: 12500, optional: true, selected: true },
  { id: 'loyalty', kind: 'discount', name: 'Returning-customer discount', description: '', quantity: 1, unitCents: -5000, totalCents: -5000 },
];
const multi = (extra = {}) => ({
  id: 'synthetic-multi-000201', type: 'job', customer: 'Synthetic Customer', customerId: 'customer-201', address: '200 Synthetic Street, Fort Collins', phone: '970-555-0102', email: 'multi@example.invalid', serviceType: 'Garage transformation',
  notes: 'INTERNAL-CANARY crew note', internalNotes: 'INTERNAL-CANARY office note', costs: { recordedAt: NOW, laborCost: 333.33, dumpFees: 44.44 }, crewPay: { lead: 'INTERNAL-CANARY pay' },
  estimate: { number: 'EST-000201', status: 'approved', amount: 1475, depositRequired: 737.5, scope: 'Synthetic scope: clear, shelve and wash the garage', lineItems: lines(), termsVersion: '2026-09', revision: 2, validUntil: '2026-10-15', createdAt: '2026-09-18T15:00:00.000Z' },
  customerApproval: { status: 'approved', approvedBy: 'Synthetic Customer', approvedAt: '2026-09-19T16:00:00.000Z', amount: 1475, source: 'customer_portal' },
  customerDecisions: [{ id: 'freezer', title: 'Haul the old freezer', details: 'Approved in the portal', priceDelta: 150, status: 'approved' }], approvedChangeTotal: 150,
  payment: { amount: 787.5, verified: true, receiptUrl: 'https://pay.stripe.com/receipts/synthetic-201', stripeSessions: [
    { sessionId: 'cs_test_deposit201', paymentIntentId: 'pi_deposit201', amount: 737.5, purpose: 'deposit', verifiedAt: '2026-09-19T16:05:00.000Z' },
    { sessionId: 'cs_test_tip201', paymentIntentId: 'pi_tip201', amount: 50, purpose: 'tip', verifiedAt: '2026-09-21T22:00:00.000Z' },
  ] },
  invoice: { number: 'INV-000201', status: 'issued', issuedAt: '2026-09-21T23:00:00.000Z', dueDate: '2026-09-28', customerReference: 'PO-201', termsVersion: '2026-09' },
  status: 'completed', completedAt: '2026-09-21T21:00:00.000Z', ...extra,
});
// Shapes the Hub, the walkthrough handoff and the payment paths write today.
const simple = () => [
  { id: 'synthetic-hub-estimate-000101', type: 'job', customer: 'Synthetic Customer', serviceType: 'Garage transformation', total: 1425, estimate: { number: 'EST-000101', status: 'draft', amount: 1425, scope: 'Synthetic scope', lineItems: [{ name: 'Garage transformation', description: 'Synthetic scope', quantity: 1, amount: 1425 }], depositRequired: 712.5, revision: 1 } },
  { id: 'synthetic-walkthrough-000102', type: 'job', customer: 'Synthetic Customer', total: 1400.01, quoteStatus: 'approved', customerApproval: { status: 'approved', approvedAt: '2026-09-20T16:30:00.000Z', amount: 1400.01 }, estimate: { status: 'accepted', amount: 1400.01, depositRequired: 700.01 }, deposit: { amount: 700.01, paidAmount: 0 } },
  { id: 'synthetic-completed-000104', type: 'cleanout', customer: 'Synthetic Customer', priceQuoted: 850, status: 'completed', payment: { amount: 200, verified: true, method: 'check', recordedBy: 'zacb', reference: 'check-1001', lastAmount: 200, lastReceivedAt: '2026-09-20T16:30:00.000Z' }, invoice: { number: 'INV-000104', status: 'partial', issuedAt: '2026-09-20T17:00:00.000Z', dueDate: '2026-09-27' } },
  { id: 'synthetic-string-money-000112', type: 'job', customer: 'Synthetic Customer', total: '1500.50', estimate: { amount: '1500.50', depositRequired: '750.25', status: 'approved' }, payment: { amount: '250' } },
  { id: 'synthetic-overpaid-000111', type: 'job', customer: 'Synthetic Customer', total: 1000, estimate: { amount: 1000, status: 'approved' }, payment: { amount: 1200, verified: true }, pipelineStatus: 'paid', invoice: { number: 'INV-000111', status: 'paid', issuedAt: '2026-09-20T17:00:00.000Z' } },
  multi(),
];
// multi() without an approved change or a tip: the portal checkout (still on the
// legacy money state) charges exactly money-core's balance, so "Pay" is offered.
const settled = () => ({ customerDecisions: [], approvedChangeTotal: 0, payment: { amount: 737.5, verified: true, receiptUrl: 'https://pay.stripe.com/receipts/synthetic-201', stripeSessions: [multi().payment.stripeSessions[0]] } });
const payable = (extra = {}) => multi({ ...settled(), ...extra });
const row = (doc, label) => doc.rows.find(item => item.label === label)?.cents;
const rendered = (kind, job = multi(), options = {}) => renderMoneyDocument(job, { kind, now: NOW, payUrl: '/customer-portal#pay', ...options });

test('customer text is escaped everywhere it appears and the document has no script', () => {
  const hostile = '<script>alert("x")</script>&<img src=x onerror=alert(1)>';
  const job = multi({ customer: `Synthetic ${hostile}`, address: `"><svg onload=alert(1)> 200 Synthetic St`, email: "o'brien@example.invalid", phone: '<b>970</b>',
    estimate: { ...multi().estimate, scope: `Scope ${hostile}`, lineItems: lines().map((line, index) => index === 0 ? { ...line, name: `Cleanout ${hostile}`, description: `Desc ${hostile}` } : line) },
    customerApproval: { ...multi().customerApproval, approvedBy: `Signer ${hostile}` }, invoice: { ...multi().invoice, customerReference: `PO ${hostile}` }, serviceType: `Service ${hostile}` });
  for (const kind of ['estimate', 'invoice', 'receipt']) {
    const html = rendered(kind, job);
    assert.doesNotMatch(html, /<(?:script|svg)|<img src=x|<[^>]*\son[a-z]+=/i, kind);
    assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&lt;img src=x onerror=alert(1)&gt;'), kind);
    assert.ok(html.includes('Synthetic &lt;script&gt;'), `${kind} customer name`);
    assert.ok(html.includes('&quot;&gt;&lt;svg onload=alert(1)&gt; 200 Synthetic St'), `${kind} address`);
    assert.ok(html.includes('o&#39;brien@example.invalid'), `${kind} email`);
    assert.equal((html.match(/<img\b/g) || []).length, 1, 'only the brand logo is an image');
  }
  assert.ok(rendered('estimate', job).includes('Scope &lt;script&gt;'));
  assert.ok(rendered('estimate', job).includes('Signer &lt;script&gt;'));
  assert.ok(rendered('invoice', job).includes('PO &lt;script&gt;'));
});

test('every figure matches money-core for legacy and itemized jobs', () => {
  for (const job of simple()) {
    const totals = customerMoneyTotals(job);
    for (const kind of moneyDocumentKinds(job, NOW)) {
      const doc = moneyDocumentModel(job, { kind, now: NOW }), html = renderMoneyDocument(job, { kind, now: NOW });
      assert.deepEqual(doc.totals, totals, `${job.id} ${kind}`);
      const total = kind === 'receipt' ? row(doc, 'Service total') : row(doc, 'Total'), applied = kind === 'receipt' ? row(doc, 'Paid toward service') : row(doc, 'Payments received');
      assert.equal(total, totals.totalCents, `${job.id} ${kind} total`);
      assert.equal(applied, totals.appliedCents, `${job.id} ${kind} paid`);
      assert.equal(row(doc, kind === 'receipt' ? 'Balance remaining' : 'Balance due'), totals.balanceCents, `${job.id} ${kind} balance`);
      if (kind === 'estimate') assert.equal(doc.rows.find(item => /deposit/i.test(item.label)).cents, totals.depositRequiredCents);
      const counted = doc.lines.filter(line => line.included).reduce((sum, line) => sum + line.totalCents, 0);
      assert.equal(counted, kind === 'estimate' ? totals.quoteCents : totals.totalCents, `${job.id} ${kind} lines add up`);
      if (kind !== 'estimate') assert.deepEqual(doc.lines.map(({ included, choice, ...line }) => line), invoiceLineItems(job, totals).lineItems, `${job.id} ${kind} invoice lines`);
      for (const item of doc.rows) assert.ok(html.includes(`<span>${item.label.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}</span><strong>${usd(item.cents)}</strong>`), `${job.id} ${kind} ${item.label}`);
    }
  }
  const doc = moneyDocumentModel(multi(), { kind: 'estimate', now: NOW });
  assert.deepEqual(doc.rows.map(item => [item.label, item.cents]), [['Estimate', 147500], ['Approved changes', 15000], ['Total', 162500], ['Deposit due upfront', 73750], ['Payments received', 73750], ['Balance due', 88750]]);
  assert.equal(usd(-5000), '−$50.00'); assert.equal(usd(123456789), '$1,234,567.89'); assert.equal(usd(null), '—');
});

test('estimates mark optional lines with their state; invoices and receipts list selected lines only', () => {
  const estimate = rendered('estimate'), invoice = rendered('invoice'), receipt = rendered('receipt');
  assert.match(estimate, /<tr class="excluded"><td><strong>Shelving good tier<\/strong><small>2 × \$150\.00<\/small><span class="tag">Option · not selected · not in total<\/span><\/td><td class="amount">\$300\.00<\/td><\/tr>/);
  assert.match(estimate, /<tr class="excluded"><td><strong>Floor epoxy add-on<\/strong><span class="tag">Optional add-on · not selected · not in total<\/span>/);
  assert.match(estimate, /<tr><td><strong>Shelving best tier<\/strong><small>2 × \$250\.00<\/small><span class="tag">Selected option<\/span><\/td><td class="amount">\$500\.00<\/td><\/tr>/);
  assert.match(estimate, /<tr><td><strong>Pressure wash add-on<\/strong><span class="tag">Optional add-on · selected<\/span>/);
  assert.match(estimate, /Returning-customer discount<\/strong><\/td><td class="amount">−\$50\.00/);
  for (const html of [invoice, receipt]) {
    assert.doesNotMatch(html, /Shelving good tier|Floor epoxy add-on|not selected|class="excluded"/);
    for (const name of ['Synthetic cleanout &amp; haul-away', 'Shelving best tier', 'Pressure wash add-on', 'Returning-customer discount', 'Approved change: Haul the old freezer']) assert.ok(html.includes(`<strong>${name}</strong>`), name);
  }
  const model = moneyDocumentModel(multi(), { kind: 'invoice', now: NOW });
  assert.deepEqual(model.lines.map(line => [line.id, line.totalCents]), [['cleanout', 90000], ['shelf-best', 50000], ['wash', 12500], ['loyalty', -5000], ['change-freezer', 15000]]);
});

test('internal cost splits, markup, catalog, durations and staff notes never reach a document', () => {
  for (const kind of ['estimate', 'invoice', 'receipt']) {
    const html = rendered(kind), model = JSON.stringify(moneyDocumentModel(multi(), { kind, now: NOW }).lines);
    for (const canary of ['$611.11', '$288.89', '$177.77', '$22.23', '$333.33', '$44.44', 'catalog-canary-item', 'INTERNAL-CANARY', 'markup', 'split', 'laborMinutes', 'durationMinutes', 'zacb', 'pi_deposit201', 'cs_test_']) {
      assert.ok(!html.includes(canary), `${kind} shows ${canary}`);
    }
    for (const key of ['split', 'catalog', 'durationMinutes', 'group', 'tier', 'package', 'markupCents']) assert.ok(!model.includes(`"${key}"`), `${kind} model carries ${key}`);
  }
});

test('receipts list payments and show tips as a separate, non-revenue line', () => {
  const doc = moneyDocumentModel(multi(), { kind: 'receipt', now: NOW }), html = rendered('receipt');
  assert.deepEqual(doc.rows.map(item => [item.label, item.cents]), [['Service total', 162500], ['Paid toward service', 73750], ['Tips for your crew (not part of the service total)', 5000], ['Total paid', 78750], ['Balance remaining', 88750]]);
  assert.deepEqual(doc.payments, [
    { date: 'September 19, 2026', label: 'Deposit · Card (Stripe)', amountCents: 73750, receiptUrl: '' },
    { date: 'September 21, 2026', label: 'Tip for your crew · Card (Stripe)', amountCents: 5000, receiptUrl: 'https://pay.stripe.com/receipts/synthetic-201' },
  ]);
  // An invoice lists what was paid toward the service; tips stay on receipts.
  const invoice = moneyDocumentModel(multi(), { kind: 'invoice', now: NOW });
  assert.deepEqual(invoice.payments, [{ date: 'September 19, 2026', label: 'Deposit · Card (Stripe)', amountCents: 73750, receiptUrl: '' }]);
  assert.equal(invoice.payments.reduce((sum, item) => sum + item.amountCents, 0), row(invoice, 'Payments received'));
  assert.doesNotMatch(rendered('invoice'), /Tip for your crew|class="tip"/);
  assert.match(html, /<div class="tip"><span>Tips for your crew \(not part of the service total\)<\/span><strong>\$50\.00<\/strong><\/div>/);
  assert.match(html, /<a class="link" href="https:\/\/pay\.stripe\.com\/receipts\/synthetic-201" rel="noopener noreferrer">Stripe receipt<\/a>/);
  assert.equal(doc.statusLabel, 'Partial payment');
  // A staff-recorded check keeps its method; an unexplained remainder is still shown, not dropped.
  const check = moneyDocumentModel(simple()[2], { kind: 'receipt', now: NOW });
  assert.deepEqual(check.payments, [{ date: 'September 20, 2026', label: 'Payment · Check', amountCents: 20000, receiptUrl: '' }]);
  const older = moneyDocumentModel(simple()[3], { kind: 'receipt', now: NOW });
  assert.deepEqual(older.payments, [{ date: '', label: 'Earlier recorded payments', amountCents: 25000, receiptUrl: '' }]);
  assert.equal(older.statusLabel, 'Payment pending verification', 'an unverified payment is never called paid');
  assert.throws(() => moneyDocumentModel(simple()[0], { kind: 'receipt', now: NOW }), { code: 'money_document_unavailable', status: 409 });
});

test('the pay link follows the portal pay rules and never carries a token', () => {
  const invoice = moneyDocumentModel(payable(), { kind: 'invoice', now: NOW, payUrl: '/customer-portal#pay' });
  assert.deepEqual(invoice.pay, { url: '/customer-portal#pay', amountCents: 73750, label: 'Pay $737.50 balance securely' });
  assert.match(rendered('invoice', payable()), /<a class="pay" href="\/customer-portal#pay">Pay \$737\.50 balance securely<\/a><p class="pay-note">Opens your private Easy Garage Cleaning customer portal\./);
  // Deposit due before the job closes; nothing to pay without approval or while a payment awaits review.
  const approved = simple()[1];
  assert.equal(moneyDocumentModel(approved, { kind: 'estimate', now: NOW, payUrl: '/customer-portal#pay' }).pay.label, 'Pay $700.01 deposit securely');
  const draft = moneyDocumentModel(simple()[0], { kind: 'estimate', now: NOW, payUrl: '/customer-portal#pay' });
  assert.equal(draft.pay, null); assert.match(draft.payNote, /Approve this estimate/);
  const review = moneyDocumentModel(simple()[3], { kind: 'estimate', now: NOW, payUrl: '/customer-portal#pay' });
  assert.equal(review.pay, null); assert.match(review.payNote, /awaiting verification/);
  assert.equal(moneyDocumentModel(payable(), { kind: 'invoice', now: NOW }).pay, null, 'no pay link without a payer');
  for (const bad of ['javascript:alert(1)', '//evil.example/pay', 'http://evil.example/pay', 'https://user:pw@evil.example/']) assert.equal(moneyDocumentModel(payable(), { kind: 'invoice', now: NOW, payUrl: bad }).pay, null, bad);
  const paid = multi({ payment: { ...multi().payment, amount: 1675, stripeSessions: [...multi().payment.stripeSessions, { sessionId: 'cs_test_bal201', paymentIntentId: 'pi_bal201', amount: 887.5, purpose: 'balance', verifiedAt: '2026-09-22T17:00:00.000Z' }] } });
  assert.equal(moneyDocumentModel(paid, { kind: 'invoice', now: NOW, payUrl: '/customer-portal#pay' }).pay, null);
  assert.equal(moneyDocumentModel(paid, { kind: 'receipt', now: NOW }).statusLabel, 'Paid in full');
  const voided = moneyDocumentModel(payable({ invoice: { ...multi().invoice, status: 'void' } }), { kind: 'invoice', now: NOW, payUrl: '/customer-portal#pay' });
  assert.equal(voided.pay, null); assert.match(voided.notice, /void/); assert.equal(voided.payNote, '');
  // A Hub copy is printed or handed on without the customer's portal session.
  const staff = moneyDocumentModel(payable(), { kind: 'invoice', now: NOW, payUrl: `${ORIGIN}/customer-portal#pay`, audience: 'staff' });
  assert.equal(staff.pay.url, `${ORIGIN}/customer-portal#pay`);
  assert.equal(staff.payNote, 'Pay securely from the private portal link Easy Garage Cleaning sent you. Card details are entered on Stripe’s secure checkout.');
});

// The real portal checkout (createCustomerStripeCheckout) against a Firestore
// and Stripe fake: what Stripe would be asked to charge, or why it refuses.
function checkoutHarness(t) {
  const docs = new Map(), charged = [], stamp = version => `2026-09-22T00:00:00.${String(version).padStart(6, '0')}Z`;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]);
      if (method === 'PATCH') docs.set(path, { value: decodeFirestoreFields(JSON.parse(options.body).fields), version: (docs.get(path)?.version || 0) + 1 });
      const row = docs.get(path);
      return row ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(row.value), updateTime: stamp(row.version) }) : Response.json({}, { status: 404 });
    }
    assert.equal(`${url.hostname}${url.pathname}`, 'api.stripe.com/v1/checkout/sessions', 'only a checkout is created');
    const amount = Number(new URLSearchParams(options.body).get('line_items[0][price_data][unit_amount]'));
    charged.push(amount);
    return Response.json({ id: 'cs_test_document', status: 'open', amount_total: amount, url: 'https://checkout.stripe.com/c/pay/cs_test_document' });
  });
  return async job => {
    const { id, ...fields } = structuredClone(job);
    docs.clear(); docs.set('jobs/job-1', { value: fields, version: 1 }); charged.length = 0;
    try { const result = await createCustomerStripeCheckout(env, 'sk_test_synthetic_document', 'job-1', ORIGIN); assert.equal(result.amount * 100, charged[0]); return { cents: charged[0] }; } catch (error) { assert.deepEqual(charged, []); return { refused: error.message }; }
  };
}

test('the pay button appears only when the portal checkout charges exactly its amount', async t => {
  const checkout = checkoutHarness(t), options = kind => ({ kind, now: NOW, payUrl: '/customer-portal#pay' });
  const contact = 'Online card payment is not available for this balance. Please call or text Easy Garage Cleaning at (970) 999-1818 to pay it.';
  // Deposit paid; the balance matches what the checkout charges.
  const agreed = payable();
  assert.deepEqual(await checkout(agreed), { cents: 73750 });
  for (const kind of ['estimate', 'invoice', 'receipt']) assert.equal(moneyDocumentModel(agreed, options(kind)).pay.amountCents, 73750, kind);
  // Before completion the deposit is due, and the approved change is not part of it.
  const deposit = payable({ status: 'scheduled', completedAt: undefined, payment: {}, customerDecisions: multi().customerDecisions, approvedChangeTotal: 150 });
  assert.deepEqual(await checkout(deposit), { cents: 73750 });
  assert.equal(moneyDocumentModel(deposit, options('estimate')).pay.label, 'Pay $737.50 deposit securely');
  // (a) A $150 change order approved in the portal: the checkout leaves it out.
  const change = payable({ customerDecisions: multi().customerDecisions, approvedChangeTotal: 150 });
  assert.deepEqual(await checkout(change), { cents: 73750 });
  for (const kind of ['estimate', 'invoice']) {
    const doc = moneyDocumentModel(change, options(kind));
    assert.equal(row(doc, 'Balance due'), 88750); assert.equal(doc.pay, null, kind); assert.equal(doc.payNote, contact, kind);
  }
  assert.doesNotMatch(renderMoneyDocument(change, options('invoice')), /class="pay"|Pay \$/);
  // ...and once the checkout's $737.50 is paid, the change is still owed but the checkout refuses.
  const after = { ...change, payment: { amount: 1475, verified: true, stripeSessions: [...settled().payment.stripeSessions, { sessionId: 'cs_test_bal201', paymentIntentId: 'pi_bal201', amount: 737.5, purpose: 'balance', verifiedAt: '2026-09-22T17:00:00.000Z' }] } };
  assert.deepEqual(await checkout(after), { refused: 'There is no outstanding balance' });
  const owed = moneyDocumentModel(after, options('invoice'));
  assert.equal(row(owed, 'Balance due'), 15000); assert.equal(owed.pay, null); assert.equal(owed.payNote, contact);
  // (b) A tip paid alongside the deposit: the checkout counts the tip as paid.
  const tip = payable({ status: 'scheduled', completedAt: undefined, payment: { amount: 50, verified: true, stripeSessions: [multi().payment.stripeSessions[1]] } });
  assert.deepEqual(await checkout(tip), { cents: 68750 });
  const tipDoc = moneyDocumentModel(tip, options('estimate'));
  assert.equal(tipDoc.totals.dueNowCents, 73750); assert.equal(tipDoc.pay, null); assert.equal(tipDoc.payNote, contact);
  // (c) completedAt without a completed status or an approved estimate: the checkout refuses.
  const unapproved = payable({ status: 'scheduled', customerApproval: {}, estimate: { ...multi().estimate, status: 'sent' }, quoteStatus: 'sent' });
  assert.deepEqual(await checkout(unapproved), { refused: 'Approve the estimate before paying' });
  const estimate = moneyDocumentModel(unapproved, options('estimate')), invoice = moneyDocumentModel(unapproved, options('invoice'));
  assert.equal(estimate.totals.purpose, 'balance'); assert.equal(estimate.pay, null); assert.equal(invoice.pay, null);
  assert.equal(estimate.payNote, 'Approve this estimate in your customer portal to pay online.');
  assert.equal(invoice.payNote, 'Approve your estimate in your customer portal to pay online.');
  // (d) A balance under Stripe's $0.50 minimum.
  const cents = payable({ payment: { amount: 1474.99, verified: true } });
  assert.deepEqual(await checkout(cents), { refused: 'There is no outstanding balance' });
  const small = moneyDocumentModel(cents, options('invoice'));
  assert.equal(row(small, 'Balance due'), 1); assert.equal(small.pay, null); assert.equal(small.payNote, contact);
  assert.doesNotMatch(renderMoneyDocument(cents, options('invoice')), /Pay \$0\.01/);
});

test('approval stamp, terms version, statuses and Denver dates come from the saved job', () => {
  const estimate = rendered('estimate');
  assert.match(estimate, /<p class="approval">✓ Estimate approved by Synthetic Customer on September 19, 2026 in the customer portal<\/p>/);
  assert.match(estimate, /Estimate terms · version 2026-09/);
  assert.match(estimate, /<dt>Valid through<\/dt><dd>October 15, 2026<\/dd>/);
  assert.match(estimate, /<dt>Revision<\/dt><dd>2<\/dd>/);
  const invoice = rendered('invoice');
  assert.match(invoice, /<dt>Issued<\/dt><dd>September 21, 2026<\/dd>/, '23:00Z is still the 21st in Denver');
  assert.match(invoice, /<dt>Payment due<\/dt><dd>September 28, 2026<\/dd><\/div><div><dt>Your reference<\/dt><dd>PO-201<\/dd>/);
  assert.match(invoice, /Payment terms · version 2026-09/);
  assert.equal(moneyDocumentModel(multi(), { kind: 'invoice', now: '2026-09-30T18:00:00.000Z' }).statusLabel, 'Overdue');
  assert.equal(moneyDocumentModel(simple()[0], { kind: 'estimate', now: NOW }).statusLabel, 'Draft');
  const expired = multi({ customerApproval: {}, estimate: { ...multi().estimate, status: 'sent', validUntil: '2026-09-01' } });
  assert.equal(moneyDocumentModel(expired, { kind: 'estimate', now: NOW }).statusLabel, 'Expired');
  const notIssued = moneyDocumentModel(simple()[0], { kind: 'invoice', now: NOW });
  assert.equal(notIssued.statusLabel, 'Not issued'); assert.match(notIssued.notice, /not been issued/);
  assert.match(renderMoneyDocument(multi(), { kind: 'estimate', now: NOW }), /<span>970-555-0102 · multi@example\.invalid<\/span>/);
  assert.doesNotMatch(renderMoneyDocument(multi(), { kind: 'estimate', now: NOW, contact: false }), /970-555-0102|multi@example\.invalid/);
});

test('a revised estimate after a superseded approval awaits a new approval', () => {
  const revised = multi({ quoteStatus: 'draft', customerApproval: { status: 'superseded', supersededAt: '2026-09-21T15:00:00.000Z', reason: 'estimate_revised', approvedBy: 'Synthetic Customer', approvedAt: '2026-09-19T16:00:00.000Z' },
    estimate: { ...multi().estimate, status: 'draft', revision: 3 }, payment: {}, customerDecisions: [], approvedChangeTotal: 0, status: 'scheduled', completedAt: undefined });
  const doc = moneyDocumentModel(revised, { kind: 'estimate', now: NOW, payUrl: '/customer-portal#pay' });
  assert.equal(doc.status, 'revised'); assert.equal(doc.statusLabel, 'Revised · awaiting approval');
  assert.equal(doc.notice, '', 'the current revision is not "replaced"');
  assert.equal(doc.approval, '', 'an approval of an earlier revision is never stamped on this one');
  assert.equal(doc.pay, null); assert.match(doc.payNote, /Approve this estimate/);
  assert.equal(moneyDocumentModel(revised, { kind: 'invoice', now: NOW }).approval, '');
  // Even a stale "accepted" estimate status cannot outvote the superseded approval.
  const stale = moneyDocumentModel({ ...revised, estimate: { ...revised.estimate, status: 'accepted' }, quoteStatus: 'approved' }, { kind: 'estimate', now: NOW, payUrl: '/customer-portal#pay' });
  assert.equal(stale.status, 'revised'); assert.equal(stale.approval, ''); assert.equal(stale.pay, null);
  assert.equal(moneyDocumentModel({ ...revised, estimate: { ...revised.estimate, validUntil: '2026-09-01' } }, { kind: 'estimate', now: NOW }).statusLabel, 'Expired');
  const reapproved = moneyDocumentModel({ ...revised, customerApproval: { status: 'approved', approvedBy: 'Synthetic Customer', approvedAt: '2026-09-22T15:00:00.000Z' } }, { kind: 'estimate', now: NOW });
  assert.equal(reapproved.status, 'approved'); assert.match(reapproved.approval, /September 22, 2026/);
});

test('invalid input fails closed with money_document codes', () => {
  assert.throws(() => moneyDocumentModel(multi(), { kind: 'estimate' }), { code: 'money_document_now_required' });
  assert.throws(() => moneyDocumentModel(multi(), { kind: 'quote', now: NOW }), { code: 'money_document_invalid_kind', status: 400 });
  assert.throws(() => moneyDocumentModel({ ...multi(), id: 'secure_abc' }, { kind: 'estimate', now: NOW }), { code: 'money_document_not_found', status: 404 });
  assert.throws(() => moneyDocumentModel({ ...multi(), recordType: 'employee_hub_v2' }, { kind: 'estimate', now: NOW }), { code: 'money_document_not_found' });
  assert.throws(() => moneyDocumentModel({ id: 'synthetic-unknown', type: 'job', total: 'lots' }, { kind: 'estimate', now: NOW }), { code: 'money_document_total_unknown', status: 409 });
  assert.deepEqual(moneyDocumentKinds({ id: 'synthetic-unknown', type: 'job', total: 'lots' }, NOW), []);
  // Incomplete saved lines fall back to one honest line carrying the quote.
  const broken = multi({ estimate: { ...multi().estimate, lineItems: [{ name: 'Half line', quantity: 1, amount: 100 }] } });
  const doc = moneyDocumentModel(broken, { kind: 'estimate', now: NOW });
  assert.deepEqual(doc.lines.map(line => [line.name, line.totalCents]), [['Garage transformation', 147500]]);
  assert.ok(doc.issues.includes('money_line_items_mismatch'));
});

test('receipts are dated by the latest recorded payment, so reopening one never redates it', () => {
  const dates = (job, now) => moneyDocumentModel(job, { kind: 'receipt', now }).dates;
  assert.deepEqual(dates(multi(), NOW), [['Receipt date', 'September 21, 2026']], 'the tip at 22:00Z on the 21st is the latest payment');
  assert.deepEqual(dates(multi(), '2026-10-30T18:00:00.000Z'), dates(multi(), NOW));
  assert.deepEqual(dates(simple()[2], NOW), [['Receipt date', 'September 20, 2026']], 'a staff-recorded check keeps its received date');
  assert.deepEqual(dates(simple()[3], NOW), [['Receipt date', 'September 22, 2026']], 'an undated legacy total falls back to the generated date');
  assert.match(rendered('receipt'), /<dl class="dates"><div><dt>Receipt date<\/dt><dd>September 21, 2026<\/dd><\/div><\/dl>/);
});

test('every address sits inside Cloudflare email_off markers, since the CSP blocks its decoder script', () => {
  for (const html of [rendered('estimate'), rendered('invoice'), rendered('receipt'), renderMoneyDocumentError('Synthetic failure')]) {
    const [before, inside, after] = html.split(/<!--email_off-->|<!--\/email_off-->/);
    assert.match(before, /<body>$/); assert.match(after, /^<\/body><\/html>$/);
    assert.match(inside, /^<main class="doc">[\s\S]*<\/main>$/);
    assert.ok(inside.includes('contact@easygaragecleaning.com'));
    assert.doesNotMatch(before + after, /[\w.+-]+@[\w-]+\.[a-z]/i, 'no address outside the markers');
  }
  assert.ok(rendered('invoice').split('<!--/email_off-->')[0].includes('multi@example.invalid'));
});

test('a deterministic snapshot is produced with an injected now, whatever the real clock says', async t => {
  const first = Object.fromEntries(['estimate', 'invoice', 'receipt'].map(kind => [kind, rendered(kind)]));
  t.mock.timers.enable({ apis: ['Date'], now: FIXED + 400 * 86400000 });
  for (const kind of Object.keys(first)) assert.equal(rendered(kind), first[kind], `${kind} depends on the real clock`);
  t.mock.timers.reset();
  const later = rendered('invoice', multi(), { now: '2026-09-23T01:30:00.000Z' });
  assert.match(first.invoice, /Generated September 22, 2026, 12:00 PM Mountain Time/);
  assert.match(later, /Generated September 22, 2026, 7:30 PM Mountain Time/);
  assert.equal(later.replace('7:30 PM', '12:00 PM'), first.invoice, 'only the generated stamp follows now');
  for (const kind of Object.keys(first)) {
    if (process.env.UPDATE_SNAPSHOTS === '1') { mkdirSync(new URL('./snapshots/', import.meta.url), { recursive: true }); writeFileSync(snapshot(kind), first[kind]); }
    assert.ok(existsSync(snapshot(kind)), `run with UPDATE_SNAPSHOTS=1 to create ${kind}`);
    assert.equal(first[kind], readFileSync(snapshot(kind), 'utf8'), `${kind} snapshot changed; review and rerun with UPDATE_SNAPSHOTS=1`);
  }
});

test('the no-script CSP pins the exact stylesheet, and the layout carries 375px width rules', () => {
  const html = rendered('invoice'), style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const hash = createHash('sha256').update(style).digest('base64');
  assert.equal(MONEY_DOCUMENT_CSP, `default-src 'none'; img-src 'self'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.doesNotMatch(html, /<script|\sstyle=|\son[a-z]+=|<form|<iframe|https?:\/\/(?!pay\.stripe\.com\/receipts\/)/i);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<img class="logo" src="\/images\/brand\/egc-logo-horizontal-primary\.png" alt="Easy Garage Cleaning" width="255" height="48">/);
  // Mobile-first: nothing wider than the viewport outside the >=681px block.
  const mobile = style.split('@media')[0];
  assert.match(mobile, /\.doc\{width:100%;max-width:820px/);
  assert.match(mobile, /\.logo\{display:block;width:200px;max-width:100%;height:auto\}/);
  assert.match(mobile, /table\{width:100%;border-collapse:collapse;table-layout:fixed\}/);
  assert.match(mobile, /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(mobile, /overflow-wrap:anywhere/);
  assert.match(mobile, /\.pay\{display:flex;align-items:center;justify-content:center;min-height:48px/);
  assert.match(mobile, /\.foot a,\.link\{display:inline-block;min-height:44px/);
  for (const [, width] of mobile.matchAll(/(?<![-\w])(?:min-)?width:(\d+)px/g)) assert.ok(Number(width) <= 343, `fixed width ${width}px overflows a 375px phone`);
  assert.match(style, /@media print\{/);
  assert.deepEqual(moneyDocumentHeaders(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': MONEY_DOCUMENT_CSP, 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' });
});

// ---- API ----
const request = (query, headers = {}) => new Request(`${ORIGIN}/api/money-document${query}`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...headers } });
const api = (deps = {}) => moneyDocumentHandlers({ now: () => new Date(NOW), ...deps });
const hubStore = (rows = { [multi().id]: multi() }) => { const calls = []; return { calls, read: async (testEnv, id) => { calls.push(id); return rows[id] ? { ...structuredClone(rows[id]), __updateTime: '2026-09-22T00:00:00.000001Z' } : null; } }; };
async function body(response) { return response.headers.get('Content-Type')?.startsWith('text/html') ? response.text() : response.json(); }

test('Hub business users get any job as a no-store, strict-CSP HTML document with a token-free pay link', async () => {
  const store = hubStore({ [multi().id]: payable() }), handler = api({ session: async () => owner, read: store.read });
  const response = await handler.get({ env, request: request(`?job_id=${multi().id}&kind=invoice`) });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(response.headers), Object.fromEntries(new Headers(moneyDocumentHeaders())));
  const html = await response.text();
  assert.equal(html, rendered('invoice', payable(), { payUrl: `${ORIGIN}/customer-portal#pay`, audience: 'staff' }));
  assert.match(html, /<a class="pay" href="https:\/\/easygaragecleaning\.com\/customer-portal#pay">Pay \$737\.50 balance securely<\/a><p class="pay-note">Pay securely from the private portal link Easy Garage Cleaning sent you\./);
  assert.doesNotMatch(html, /Opens your private/, 'a printed Hub copy never promises to open the portal');
  assert.doesNotMatch(html, /access=|customer-portal-session|egc_customer_portal/);
  assert.deepEqual(store.calls, [multi().id]);
  const estimate = await handler.get({ env, request: request(`?kind=estimate&job_id=${multi().id}`) });
  assert.equal(estimate.status, 200); assert.match(await estimate.text(), /<h1>Estimate<\/h1>/);
});

test('crew and Hub sessions without business access or an owner/manager role are denied', async () => {
  for (const staff of [crew, { ...owner, businessAccess: false }, { user: 'synthetic.sales', role: 'sales', businessAccess: true }, { user: 'tylerg', role: 'crew', businessAccess: true }, { user: 'alexk', role: 'sales', businessAccess: true }]) {
    const store = hubStore();
    const response = await api({ session: async () => staff, read: store.read, portalSession: async () => null }).get({ env, request: request(`?job_id=${multi().id}&kind=invoice`) });
    assert.equal(response.status, 403, staff.user);
    assert.deepEqual(await response.json(), { ok: false, code: 'money_document_forbidden', error: 'Only an owner or manager with business access can open customer documents.' });
    assert.deepEqual(store.calls, [], 'no job is read for a denied session');
    const probe = await api({ session: async () => staff }).get({ env, request: request('?probe=1') });
    assert.equal(probe.status, 403);
  }
  const manager = await api({ session: async () => ({ user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' }), read: hubStore().read }).get({ env, request: request(`?job_id=${multi().id}&kind=invoice`) });
  assert.equal(manager.status, 200, 'a business manager opens documents like the owner');
  const anonymous = await api({ session: async () => null, portalSession: async () => null }).get({ env, request: request(`?job_id=${multi().id}&kind=invoice`) });
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).code, 'money_document_sign_in_required');
});

test('the flag defaults off: documents are 404 and the probe reports disabled', async () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
    const flagged = { ...portalEnv, ...(flag === undefined ? {} : { MONEY_DOCUMENT_ENABLED: flag }) }, store = hubStore();
    const response = await api({ session: async () => owner, read: store.read }).get({ env: flagged, request: request(`?job_id=${multi().id}&kind=invoice`) });
    assert.equal(response.status, 404, String(flag)); assert.equal((await response.json()).code, 'money_document_disabled');
    assert.deepEqual(store.calls, []);
    const probe = await api({ session: async () => owner }).get({ env: flagged, request: request('?probe=1') });
    assert.deepEqual(await probe.json(), { ok: true, enabled: false });
  }
  const probe = await api({ session: async () => owner }).get({ env, request: request('?probe=1') });
  assert.equal(probe.status, 200); assert.deepEqual(await probe.json(), { ok: true, enabled: true });
  assert.equal(probe.headers.get('Cache-Control'), 'no-store');
  assert.equal((await api({ session: async () => null }).get({ env, request: request('?probe=1') })).status, 401);
});

test('requests are validated before any read: params, ids, kinds and cross-site navigation', async () => {
  const store = hubStore(), handler = api({ session: async () => owner, read: store.read });
  const cases = [
    ['?job_id=synthetic-multi-000201&kind=quote', 400, 'money_document_invalid_kind'],
    ['?job_id=synthetic-multi-000201', 400, 'money_document_invalid_kind'],
    ['?job_id=synthetic-multi-000201&kind=invoice&kind=estimate', 400, 'money_document_invalid_request'],
    ['?job_id=synthetic-multi-000201&kind=invoice&token=x', 400, 'money_document_invalid_request'],
    ['?job_id=secure_employee&kind=invoice', 400, 'money_document_invalid_request'],
    ['?job_id=_egc_schedule_lock_2026-09-22&kind=invoice', 400, 'money_document_invalid_request'],
    ['?job_id=..%2Fcustomers&kind=invoice', 400, 'money_document_invalid_request'],
    ['?probe=1&kind=invoice', 400, 'money_document_invalid_request'],
    ['?kind=invoice', 400, 'money_document_job_required'],
    ['?job_id=synthetic-missing&kind=invoice', 404, 'money_document_not_found'],
  ];
  for (const [query, status, code] of cases) {
    const response = await handler.get({ env, request: request(query) });
    assert.equal(response.status, status, query); assert.equal((await response.json()).code, code, query);
  }
  assert.deepEqual(store.calls, ['synthetic-missing']);
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }, { Referer: 'https://easygaragecleaning.com.evil.example/x' }]) {
    const response = await handler.get({ env, request: request(`?job_id=${multi().id}&kind=invoice`, headers) });
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'money_document_origin_forbidden');
  }
  assert.equal((await handler.get({ env, request: request(`?job_id=${multi().id}&kind=invoice`, { Referer: `${ORIGIN}/employee` }) })).status, 200);
  const failing = await api({ session: async () => owner, read: async () => { throw new Error('Job storage read failed (500) secret-detail'); } }).get({ env, request: request(`?job_id=${multi().id}&kind=invoice`) });
  assert.equal(failing.status, 503);
  assert.deepEqual(await failing.json(), { ok: false, code: 'money_document_unavailable', error: 'This document could not be loaded. Please try again shortly.' });
  const private_ = await api({ session: async () => owner, read: hubStore({ [multi().id]: { ...multi(), recordType: 'employee_hub_v2' } }).read }).get({ env, request: request(`?job_id=${multi().id}&kind=invoice`) });
  assert.equal(private_.status, 404);
});

test('browser navigations get a branded HTML error under the same CSP', async () => {
  const response = await api({ session: async () => null, portalSession: async () => null }).get({ env, request: request('?kind=invoice', { Accept: 'text/html,application/xhtml+xml' }) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Content-Security-Policy'), MONEY_DOCUMENT_CSP);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const html = await response.text();
  assert.match(html, /We couldn’t open this document<\/h2><p>Open the private project link from Easy Garage Cleaning\.<\/p>/);
  assert.doesNotMatch(html, /<script/);
});

// Customer portal sessions go through readCustomerPortalContext against a Firestore REST fake.
const stored = extra => { const { id, ...job } = multi(extra); return job; };
const portalJobs = extra => ({ 'job-1': { ...stored(), customerCollaborators: [
  { id: 'person-view', name: 'Synthetic Viewer', email: 'viewer@example.invalid', status: 'active', permissions: { view: true, decide: false, pay: false, rebook: false } },
  { id: 'person-pay', name: 'Synthetic Payer', email: 'payer@example.invalid', status: 'active', permissions: { view: true, decide: false, pay: true, rebook: false } },
  { id: 'person-removed', name: 'Synthetic Removed', email: 'removed@example.invalid', status: 'removed', permissions: { view: true } },
], ...extra }, 'job-2': stored({ customer: 'Synthetic Other Customer', customerId: 'customer-other', address: '999 Other Street' }) });
const portalGet = async (cookie, query = '?kind=invoice', testEnv = env) => {
  const response = await api().get({ env: testEnv, request: request(query, { Cookie: cookie }) });
  return { status: response.status, headers: response.headers, body: await body(response) };
};

test('a portal session opens its own job only; other jobs are 404 without being read', async t => {
  const store = portalStore(t, portalJobs(settled()));
  const cookie = await portalCookie('job-1');
  const own = await portalGet(cookie);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('Content-Security-Policy'), MONEY_DOCUMENT_CSP);
  assert.match(own.body, /<a class="pay" href="\/customer-portal#pay">Pay \$737\.50 balance securely<\/a><p class="pay-note">Opens your private Easy Garage Cleaning customer portal\./);
  assert.match(own.body, /970-555-0102 · multi@example\.invalid/, 'the account owner sees their own contact details');
  assert.equal((await portalGet(cookie, '?kind=invoice&job_id=job-1')).status, 200);
  const before = store.calls.length;
  const other = await portalGet(cookie, '?kind=invoice&job_id=job-2');
  assert.equal(other.status, 404); assert.equal(other.body.code, 'money_document_not_found');
  assert.equal(store.calls.length, before, 'the other job is never read');
  assert.doesNotMatch(JSON.stringify(other.body), /Other Customer|999 Other/);
  assert.equal(store.writes.length, 0, 'viewing a document writes nothing');
});

test('portal access honours link revocation and collaborator view and pay permissions', async t => {
  portalStore(t, portalJobs({ ...settled(), customerPortalLinkVersion: 1 }));
  const stale = await portalGet(await portalCookie('job-1', { linkVersion: 0 }));
  assert.equal(stale.status, 403); assert.equal(stale.body.code, 'money_document_forbidden'); assert.match(stale.body.error, /replaced/);
  const current = await portalGet(await portalCookie('job-1', { linkVersion: 1, linkRoot: 'job-1' }));
  assert.equal(current.status, 200);
  const viewer = await portalGet(await portalCookie('job-1', { actorId: 'person-view', permissions: { view: true } }));
  assert.equal(viewer.status, 200);
  assert.doesNotMatch(viewer.body, /class="pay"|970-555-0102|multi@example\.invalid/, 'no pay link or owner contact details for a view-only collaborator');
  const payer = await portalGet(await portalCookie('job-1', { actorId: 'person-pay', permissions: { view: true, pay: true } }));
  assert.match(payer.body, /<a class="pay" href="\/customer-portal#pay">/);
  const removed = await portalGet(await portalCookie('job-1', { actorId: 'person-removed', permissions: { view: true } }));
  assert.equal(removed.status, 403);
  const expired = await portalGet(await portalCookie('job-1', {}, FIXED - 8 * 86400000));
  assert.equal(expired.status, 401); assert.equal(expired.body.code, 'money_document_sign_in_required');
});

test('business project viewers follow their saved permissions; portal storage failures stay retryable', async () => {
  const job = { ...payable(), id: 'job-1' }, seen = [];
  const deps = permissions => ({ session: async () => null, portalSession: async () => ({ jobId: 'job-1', actorId: 'biz_synthetic_member_1' }),
    portalContext: async (testEnv, customer, options) => { seen.push([customer.actorId, typeof options.read]); return { session: { ...customer, permissions }, job }; } });
  const viewer = await api(deps({ view: true, decide: false, pay: false, rebook: false })).get({ env, request: request('?kind=invoice') });
  assert.equal(viewer.status, 200);
  assert.doesNotMatch(await viewer.text(), /class="pay"|970-555-0102|multi@example\.invalid/, 'no pay link or homeowner contact details for a company viewer');
  const payer = await api(deps({ view: true, pay: true })).get({ env, request: request('?kind=invoice') });
  assert.match(await payer.text(), /<a class="pay" href="\/customer-portal#pay">/);
  const hidden = await api(deps({ view: false, pay: true })).get({ env, request: request('?kind=invoice') });
  assert.equal(hidden.status, 403); assert.equal((await hidden.json()).code, 'money_document_forbidden');
  assert.deepEqual(seen, Array(3).fill(['biz_synthetic_member_1', 'function']), 'every request is re-authorized through the portal context');
  const down = await api({ session: async () => null, portalSession: async () => ({ jobId: 'job-1' }), portalContext: async () => { throw Object.assign(new Error('Your project could not be loaded. Please try again shortly.'), { code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', status: 503 }); } })
    .get({ env, request: request('?kind=invoice') });
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { ok: false, code: 'money_document_unavailable', error: 'Your project could not be loaded. Please try again shortly.' });
});

test('portal documents appear only once they exist: issued invoice, recorded payment', async t => {
  portalStore(t, portalJobs({ invoice: { number: 'INV-000201', status: 'draft' }, payment: {} , customerDecisions: [], approvedChangeTotal: 0 }));
  const cookie = await portalCookie('job-1');
  assert.equal((await portalGet(cookie, '?kind=estimate')).status, 200);
  const invoice = await portalGet(cookie, '?kind=invoice');
  assert.equal(invoice.status, 404); assert.equal(invoice.body.code, 'money_document_unavailable');
  assert.equal((await portalGet(cookie, '?kind=receipt')).status, 404);
  const disabled = await portalGet(cookie, '?kind=estimate', portalEnv);
  assert.equal(disabled.status, 404); assert.equal(disabled.body.code, 'money_document_disabled');
});

test('the portal response lists session-scoped document links only while the flag is on', async t => {
  portalStore(t, portalJobs());
  const handlers = portalHandlers(), cookie = await portalCookie('job-1');
  const off = await portalView(handlers, cookie);
  assert.equal(off.status, 200); assert.deepEqual(off.body.moneyDocuments, []);
  const on = await portalView(handlers, cookie, env);
  assert.deepEqual(on.body.moneyDocuments, [
    { kind: 'estimate', label: 'View estimate', url: '/api/money-document?kind=estimate' },
    { kind: 'invoice', label: 'View invoice', url: '/api/money-document?kind=invoice' },
    { kind: 'receipt', label: 'View receipt', url: '/api/money-document?kind=receipt' },
  ]);
  assert.deepEqual(moneyDocumentLinks(simple()[0], { enabled: true, now: NOW }).map(link => link.kind), ['estimate']);
  assert.deepEqual(moneyDocumentLinks(multi(), { enabled: false, now: NOW }), []);
});

test('edge middleware keeps the document CSP, no-referrer and DENY framing', async () => {
  const html = rendered('invoice');
  const response = await middleware({ request: new Request(`${ORIGIN}/api/money-document?kind=invoice`), env: {}, next: async () => new Response(html, { headers: moneyDocumentHeaders() }) });
  assert.equal(response.headers.get('Content-Security-Policy'), MONEY_DOCUMENT_CSP);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(await response.text(), html);
  const other = await middleware({ request: new Request(`${ORIGIN}/api/dispatch`), env: {}, next: async () => new Response('{}', { headers: { 'Content-Security-Policy': "default-src 'none'" } }) });
  assert.notEqual(other.headers.get('Content-Security-Policy'), "default-src 'none'", 'other routes still get the site policy');
});

// ---- Browser code ----
function portalFunctions(documents, hash = '') {
  const page = read('customer-portal.html'), source = ['function renderMoneyDocuments(', 'function focusPayFromLink('].map(prefix => page.split(/\r?\n/).find(line => line.startsWith(prefix))).join('\n');
  const element = tag => ({ tag, className: '', textContent: '', children: [], attributes: {}, classes: new Set(), classList: { toggle(name, on) { if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); }, contains(name) { return this.owner.classes.has(name); } }, replaceChildren(...children) { this.children = children; } });
  const nodes = {}, $ = id => { if (!nodes[id]) { nodes[id] = element('div'); nodes[id].classList.owner = nodes[id]; } return nodes[id]; };
  const scrolled = [];
  $('pay-button').scrollIntoView = () => scrolled.push('pay-button'); $('pay-button').focus = () => scrolled.push('focus'); $('pay-button').closest = () => ({ scrollIntoView: () => scrolled.push('payment-card') });
  const make = (tag, className, text) => { const node = element(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const context = vm.createContext({ $, make, location: { hash }, String, Array });
  vm.runInContext(source, context);
  context.renderMoneyDocuments({ moneyDocuments: documents });
  return { nodes, scrolled, context };
}

test('the portal renders document links as text-only links and ignores anything else', () => {
  const { nodes } = portalFunctions([
    { kind: 'invoice', label: 'View invoice', url: '/api/money-document?kind=invoice' },
    { kind: 'receipt', label: '<img src=x onerror=alert(1)>', url: '/api/money-document?kind=receipt' },
    { kind: 'estimate', label: 'Evil', url: 'javascript:alert(1)' },
    { kind: 'estimate', label: 'Wrong kind', url: '/api/money-document?kind=invoice' },
    { kind: 'invoice', label: 'Other job', url: '/api/money-document?kind=invoice&job_id=job-2' },
  ]);
  const links = nodes['document-links'].children;
  assert.deepEqual(links.map(link => [link.tag, link.textContent, link.href, link.target, link.rel, link.className]), [
    ['a', 'View invoice', '/api/money-document?kind=invoice', '_blank', 'noopener noreferrer', 'btn secondary'],
    ['a', '<img src=x onerror=alert(1)>', '/api/money-document?kind=receipt', '_blank', 'noopener noreferrer', 'btn secondary'],
  ]);
  assert.equal(nodes['document-links'].classes.has('hidden'), false);
  assert.equal(portalFunctions([]).nodes['document-links'].classes.has('hidden'), true);
  assert.equal(portalFunctions(undefined).nodes['document-links'].children.length, 0);
  const page = read('customer-portal.html');
  assert.match(page, /<nav class="document-links hidden" id="document-links" aria-label="Printable estimate, invoice and receipt"><\/nav><\/section>/);
  assert.match(page, /\.document-links \.btn\{min-height:48px;/);
  assert.match(page, /renderExperience\(data\);renderMoneyDocuments\(data\);focusPayFromLink\(\)\};/);
});

test('a document pay link lands on the portal pay button once', () => {
  const { context, scrolled } = portalFunctions([], '#pay');
  context.$('pay-button').classes.add('hidden');
  context.focusPayFromLink(); context.focusPayFromLink();
  assert.deepEqual(scrolled, ['payment-card'], 'a hidden pay button scrolls to its card, once');
  const visible = portalFunctions([], '#pay');
  visible.context.focusPayFromLink();
  assert.deepEqual(visible.scrolled, ['pay-button', 'focus']);
  const none = portalFunctions([], '');
  none.context.focusPayFromLink(); assert.deepEqual(none.scrolled, []);
});

function hubModule(respond, { popups = [] } = {}) {
  const listeners = {}, calls = [], timers = [], toasts = [];
  const context = vm.createContext({ window: { addEventListener: (name, handler) => { listeners[name] = handler; }, open: (...args) => { const next = popups.shift(); if (next) next.args = args; return next || null; } }, location: { origin: ORIGIN }, URL, URLSearchParams, Promise, AbortController, showToast: message => toasts.push(message),
    setTimeout: (callback, ms) => { timers.push({ callback, ms, cleared: false }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    hubFetch: async () => { throw new Error('the probe must not use hubFetch (it signs out on 401)'); },
    fetch: async (path, options) => { calls.push([path, options.cache, options.credentials, options.signal instanceof AbortSignal]); return respond(calls.length, options); } });
  vm.runInContext(read('employee-money-document.js'), context);
  return { module: context.window.EGCMoneyDocument, listeners, calls, timers, toasts };
}
const popup = () => { const opened = []; const win = { opened, opener: 'hub', closed: false, close() { win.closed = true; }, location: { replace: url => opened.push(url) } }; return win; };

test('the Hub hand-off probes the flag once per sign-in and falls back to the legacy print view', async () => {
  const off = hubModule(() => Response.json({ ok: true, enabled: false }));
  const win = popup();
  assert.equal(await off.module.open(win, multi().id, 'invoice'), false);
  assert.equal(await off.module.open(win, multi().id, 'estimate'), false);
  assert.deepEqual(win.opened, []); assert.deepEqual(off.calls, [['/api/money-document?probe=1', 'no-store', 'same-origin', true]]);
  assert.deepEqual(off.timers.map(timer => [timer.ms, timer.cleared]), [[3000, true]], 'the probe timeout is cleared once answered');
  const on = hubModule(() => Response.json({ ok: true, enabled: true })), target = popup();
  assert.equal(await on.module.open(target, multi().id, 'invoice'), true);
  assert.deepEqual(target.opened, [`${ORIGIN}/api/money-document?job_id=${multi().id}&kind=invoice`]);
  assert.equal(await on.module.open(target, 'secure_employee', 'invoice'), false);
  assert.equal(await on.module.open(target, multi().id, 'quote'), false);
  assert.equal(on.calls.length, 1, 'the answer is remembered');
  on.listeners['egc:signout']();
  await on.module.open(popup(), multi().id, 'estimate');
  assert.equal(on.calls.length, 2, 'sign-out forgets the answer');
  const flaky = hubModule(count => { if (count === 1) throw new TypeError('offline'); return Response.json({ ok: true, enabled: true }); });
  assert.equal(await flaky.module.open(popup(), multi().id, 'invoice'), false, 'an unanswered probe prints the legacy view');
  assert.equal(await flaky.module.open(popup(), multi().id, 'invoice'), true, 'and is asked again next time');
  for (const status of [401, 403, 503]) {
    const denied = hubModule(() => Response.json({ ok: false, code: 'money_document_forbidden' }, { status }));
    assert.equal(await denied.module.open(popup(), multi().id, 'invoice'), false, `${status} prints the legacy view without signing out`);
    assert.equal(await denied.module.open(popup(), multi().id, 'estimate'), false);
    // A definitive 401/403 is remembered until sign-out, so later prints never wait on the probe.
    assert.equal(denied.calls.length, status === 503 ? 2 : 1, `${status} probes`);
    denied.listeners['egc:signout']();
    await denied.module.open(popup(), multi().id, 'invoice');
    assert.equal(denied.calls.length, status === 503 ? 3 : 2, `${status} after sign-out`);
  }
  const malformed = hubModule(() => Response.json({ ok: true, enabled: 'yes' }));
  assert.equal(await malformed.module.open(popup(), multi().id, 'invoice'), false);
});

test('a probe that hangs is aborted and the legacy print view is used', async () => {
  const hung = hubModule((count, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  const pending = hung.module.open(popup(), multi().id, 'invoice');
  assert.equal(hung.timers.length, 1); assert.equal(hung.timers[0].ms, 3000);
  hung.timers[0].callback();
  assert.equal(await pending, false);
  const again = hung.module.enabled();
  assert.equal(hung.calls.length, 2, 'a timed-out probe is not remembered');
  hung.timers[1].callback();
  assert.equal(await again, false);
});

test('opsPrintDocument delegates to the hand-off and otherwise writes its own print view unchanged', async () => {
  const suite = read('employee-suite.js'), line = prefix => suite.split(/\r?\n/).find(item => item.startsWith(prefix));
  const source = ['const esc=', 'const payMoney=', 'function financeState(', 'function customerDocumentTerms(', 'window.opsPrintDocument='].map(line).join('\n');
  assert.match(line('window.opsPrintDocument='), /win\.opener=null;if\(window\.EGCMoneyDocument&&await window\.EGCMoneyDocument\.open\(win,id,kind\)\)return;win\.document\.write\(/);
  const job = simple()[0];
  for (const delegated of [true, false, undefined]) {
    let html = '', asked = null;
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [FIXED])); } static now() { return FIXED; } }
    const win = { document: { write: value => { html += value; }, close() {} } };
    const window = { open: () => win, ...(delegated === undefined ? {} : { EGCMoneyDocument: { open: async (target, id, kind) => { asked = [target === win, id, kind]; return delegated; } } }) };
    const context = vm.createContext({ Date: FixedDate, window, jobs: () => [job], location: { origin: ORIGIN }, day: () => '2026-09-22', dateLabel: String });
    vm.runInContext(source, context);
    await context.window.opsPrintDocument(job.id, 'invoice');
    if (delegated !== undefined) assert.deepEqual(asked, [true, job.id, 'invoice']);
    if (delegated) assert.equal(html, '', 'the server document replaces the legacy view');
    else { assert.match(html, /Print \/ Save PDF/); assert.match(html, /<h1>Invoice<\/h1>/); }
  }
  const employee = read('employee.html');
  assert.ok(employee.indexOf('employee-money-document.js?v=20260928m4') > 0 && employee.indexOf('employee-money-document.js') < employee.indexOf('employee-suite.js?v='), 'the hand-off loads before the suite');
});

test('Print receipt opens only the server document and says so when it is off', async () => {
  const win = popup(), on = hubModule(() => Response.json({ ok: true, enabled: true }), { popups: [win] });
  assert.equal(await on.module.print(multi().id, 'receipt'), true);
  assert.deepEqual(win.opened, [`${ORIGIN}/api/money-document?job_id=${multi().id}&kind=receipt`]);
  assert.deepEqual(win.args, ['', '_blank', 'width=900,height=960']); assert.equal(win.opener, null); assert.deepEqual(on.toasts, []);
  const closed = popup(), off = hubModule(() => Response.json({ ok: true, enabled: false }), { popups: [closed] });
  assert.equal(await off.module.print(multi().id, 'receipt'), false);
  assert.equal(closed.closed, true, 'the blank window is closed; there is no legacy receipt view');
  assert.deepEqual(closed.opened, []); assert.deepEqual(off.toasts, ['Printable receipts are not available yet.']);
  const failed = popup(), offline = hubModule(() => { throw new TypeError('offline'); }, { popups: [failed] });
  assert.equal(await offline.module.print(multi().id, 'receipt'), false);
  assert.equal(failed.closed, true); assert.deepEqual(offline.toasts, ['The receipt could not be opened. Please try again.']);
  const blocked = hubModule(() => Response.json({ ok: true, enabled: true }));
  assert.equal(await blocked.module.print(multi().id, 'receipt'), false);
  assert.deepEqual(blocked.toasts, ['Allow pop-ups to open the printable document']); assert.equal(blocked.calls.length, 0);
  const bad = hubModule(() => Response.json({ ok: true, enabled: true }), { popups: [popup()] });
  assert.equal(await bad.module.print('_egc_schedule_lock_2026-09-22', 'receipt'), false); assert.equal(bad.calls.length, 0);
  // The finance board offers it once a payment is recorded, through the hand-off only.
  const board = read('employee-suite.js').split(/\r?\n/).find(item => item.startsWith('function financeBoard('));
  assert.ok(board.includes("${f.paid>0?`<button onclick=\"window.EGCMoneyDocument?.print('${esc(j.id)}','receipt')\">Print receipt</button>`:''}</div></article>"));
});
