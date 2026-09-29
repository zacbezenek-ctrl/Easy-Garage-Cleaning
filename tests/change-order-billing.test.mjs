import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { readJob, encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { CLOSED_STAGES, DECISION_APPROVAL_DAYS, approvalClosed, approvedChangeTotal, billedChangeCents, billedChangeOrders, changeOrderBillingEnabled, changeOrderLineId, changeOrderSaved, jobClosed, jobFinished, raisedInvoice, respondToDecision, voidChangeOrder } from '../functions/_lib/change-orders.js';
import { createCustomerStripeCheckout, customerDepositState, customerMoneyState, customerQuoteTotal, expireStaleCustomerCheckout } from '../functions/_lib/customer-payments.js';
import { approvedChangeCents, customerMoneyTotals, invoiceFromEstimate, invoiceLineItems, invoiceStatus } from '../functions/_lib/money-core.js';
import { moneyProjection } from '../functions/_lib/money-service.js';
import { moneyDocumentModel } from '../functions/_lib/money-document.js';
import { NOW, env, portalStore, portalCookie, portalHandlers, portalView, portalPost, portalScript } from './helpers/portal-fixture.mjs';
import { applyFirestoreCommit } from './helpers/firestore-commit.mjs';

const billing = { ...env, CHANGE_ORDER_BILLING_ENABLED: 'true', MONEY_API_ENABLED: 'true' };
const ORIGIN = 'https://easygaragecleaning.com';
const decision = (extra = {}) => ({ id: 'decision-freezer', title: 'Haul the old freezer', details: 'Synthetic crew note: it sits by the side door.', priceDelta: 150, timeDeltaMinutes: 20, status: 'pending', promptedAt: '2026-09-22T16:00:00.000Z', promptedBy: 'synthetic.manager', ...extra });
// An approved $1,000 estimate whose $500 deposit was paid by card, with one crew decision waiting.
const job = (extra = {}) => ({
  type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', email: 'synthetic@example.invalid', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 1000, status: 'in_progress',
  estimate: { number: 'EST-1', status: 'approved', amount: 1000, depositRequired: 500, revision: 2, scope: 'Synthetic garage reset scope', validUntil: '2026-10-01' },
  customerApproval: { status: 'approved', approvedAt: '2026-09-20T16:00:00.000Z', approvedBy: 'Synthetic Customer', amount: 1000, source: 'customer_portal' }, quoteStatus: 'approved',
  deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true },
  payment: { amount: 500, verified: true, method: 'stripe', processor: 'stripe', stripeSessions: [{ sessionId: 'cs_test_synthetic_deposit', paymentIntentId: 'pi_synthetic_deposit', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-20T16:05:00.000Z' }] },
  customerDecisions: [decision()], ...extra,
});
const answer = (extra = {}) => ({ action: 'respond_decision', decision_id: 'decision-freezer', response: 'approved', responded_by: 'Synthetic Customer', note: 'Yes, take it', request_id: randomUUID(), price_delta_cents: 15000, ...extra });
const input = (extra = {}) => ({ decisionId: 'decision-freezer', response: 'approved', respondedBy: 'Synthetic Customer', note: '', requestId: '2b7f0c1e-5a4d-4c3b-9e8f-7a6b5c4d3e2f', priceDeltaCents: 15000, ...extra });
const money = view => [view.payment.total, view.payment.paid, view.payment.balance, view.payment.approvedChanges];

test('the flag is off unless it and MONEY_API_ENABLED are exactly "true"', () => {
  for (const value of [undefined, '', 'TRUE', '1', 'yes', true]) assert.equal(changeOrderBillingEnabled({ CHANGE_ORDER_BILLING_ENABLED: value, MONEY_API_ENABLED: 'true' }), false, String(value));
  // The legacy Hub finance board would show balances without the change, so billing waits for the money API.
  for (const value of [undefined, '', 'TRUE', 'false']) assert.equal(changeOrderBillingEnabled({ CHANGE_ORDER_BILLING_ENABLED: 'true', MONEY_API_ENABLED: value }), false, `money API ${value}`);
  assert.equal(changeOrderBillingEnabled(billing), true);
});

test('an approved change bills its price once, on top of the quote, with the decision as evidence', () => {
  const current = job(), plan = respondToDecision(current, input(), { billing: true, now: NOW, actorId: '' });
  assert.equal(plan.replayed, false); assert.equal(plan.billedCents, 15000);
  const [line] = plan.patch.changeOrders;
  assert.deepEqual(line, {
    id: 'change-decision-freezer', kind: 'fee', source: 'customer_decision', decisionId: 'decision-freezer', name: 'Approved change: Haul the old freezer', description: 'Synthetic crew note: it sits by the side door.',
    quantity: 1, unitCents: 15000, totalCents: 15000, amount: 150, approvedAt: NOW, approvedBy: 'Synthetic Customer', requestId: input().requestId, estimateRevision: 2, estimateFingerprint: line.estimateFingerprint,
  });
  assert.match(line.estimateFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual([plan.decision.status, plan.decision.respondedAt, plan.decision.responseBy, plan.decision.responseSource, plan.decision.responseRequestId, plan.decision.changeOrderId], ['approved', NOW, 'Synthetic Customer', 'customer_portal', input().requestId, 'change-decision-freezer']);
  assert.match(plan.decision.responseFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(plan.patch).sort(), ['approvedChangeTotal', 'changeOrders', 'customerDecisionUpdatedAt', 'customerDecisions', 'updatedAt'], 'the estimate, approval, deposit and payment are never rewritten');
  const saved = { ...current, ...plan.patch };
  assert.equal(saved.approvedChangeTotal, 150);
  assert.deepEqual(customerMoneyState(current), { total: 1000, paid: 500, balance: 500 });
  assert.deepEqual(customerMoneyState(saved), { total: 1150, paid: 500, balance: 650 });
  assert.equal(customerQuoteTotal(saved), 1000);
  assert.deepEqual(customerDepositState(saved), { required: 500, paid: 500, due: 0, dueNow: 0, purpose: 'deposit', remainder: 650 });
  // money-core (Hub money API, documents, invoices) reads the same figures.
  const totals = customerMoneyTotals(saved);
  assert.deepEqual([totals.quoteCents, totals.approvedChangeCents, totals.totalCents, totals.balanceCents, totals.depositRequiredCents, totals.issues], [100000, 15000, 115000, 65000, 50000, []]);
  // A replay of the saved answer changes nothing; a different request is refused.
  const replay = respondToDecision(saved, input(), { billing: true, now: '2026-09-22T18:05:00.000Z' });
  assert.deepEqual([replay.replayed, replay.patch, replay.billedCents], [true, null, 15000]);
  assert.equal(replay.decision.respondedAt, NOW);
  assert.throws(() => respondToDecision(saved, input({ requestId: randomUUID() }), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_ANSWERED', status: 409 });
  assert.throws(() => respondToDecision(saved, input({ requestId: randomUUID(), response: 'declined' }), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_ANSWERED', status: 409 });
  // The same request id with another answer, name, note, price or viewer is an idempotency conflict, never a replay.
  for (const [extra, actorId] of [[{ response: 'declined' }, ''], [{ respondedBy: 'Another Person' }, ''], [{ note: 'Changed my mind' }, ''], [{ priceDeltaCents: 20000 }, ''], [{}, 'person-1']]) {
    assert.throws(() => respondToDecision(saved, input(extra), { billing: true, now: NOW, actorId }), { code: 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT', status: 409 }, JSON.stringify([extra, actorId]));
  }
  // A request id answers one decision: reusing it for another decision is refused too.
  const other = { ...saved, customerDecisions: [...saved.customerDecisions, decision({ id: 'decision-paint', priceDelta: 0 })] };
  assert.throws(() => respondToDecision(other, input({ decisionId: 'decision-paint', priceDeltaCents: 0 }), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT' });
  // An answer saved before fingerprints existed is replayed by its request id alone.
  const { responseFingerprint, ...older } = saved.customerDecisions[0];
  assert.equal(respondToDecision({ ...saved, customerDecisions: [older] }, input({ note: 'Different note' }), { billing: true, now: NOW }).replayed, true);
});

test('an unpaid deposit is not raised by a change: the change is due with the balance', () => {
  const unpaid = job({ deposit: { amount: 500, paidAmount: 0, status: 'due' }, payment: {}, status: 'scheduled' });
  const saved = { ...unpaid, ...respondToDecision(unpaid, input(), { billing: true, now: NOW }).patch };
  assert.deepEqual(customerDepositState(saved), { required: 500, paid: 0, due: 500, dueNow: 500, purpose: 'deposit', remainder: 650 });
  const closing = { ...saved, status: 'completed', completedAt: NOW };
  assert.deepEqual([customerDepositState(closing).dueNow, customerDepositState(closing).purpose], [1150, 'balance']);
  assert.equal(customerMoneyTotals(closing).dueNowCents, 115000);
  // Without a saved deposit term the 50% default is taken on the quote, not on the quote plus changes.
  const { depositRequired, ...terms } = saved.estimate, defaulted = { ...saved, estimate: terms, deposit: undefined };
  assert.equal(customerDepositState(defaulted).required, 500);
  assert.equal(customerMoneyTotals(defaulted).depositRequiredCents, 50000);
});

test('an older page without a request id replays by the same answer and name only', () => {
  const legacy = { ...input(), requestId: '' }, saved = { ...job(), ...respondToDecision(job(), legacy, { billing: true, now: NOW }).patch };
  assert.equal(saved.customerDecisions[0].responseRequestId, undefined);
  assert.equal(respondToDecision(saved, { ...legacy, respondedBy: ' synthetic customer ' }, { billing: true, now: NOW }).replayed, true);
  assert.throws(() => respondToDecision(saved, { ...legacy, respondedBy: 'Another Person' }, { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_ANSWERED' });
  const withId = { ...job(), ...respondToDecision(job(), input(), { billing: true, now: NOW }).patch };
  assert.throws(() => respondToDecision(withId, legacy, { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_ANSWERED' }, 'an answer saved with a request id is replayed only by that id');
});

test('a declined decision leaves every money figure unchanged', () => {
  const current = job(), plan = respondToDecision(current, input({ response: 'declined' }), { billing: true, now: NOW }), saved = { ...current, ...plan.patch };
  assert.equal(plan.billedCents, 0); assert.equal(plan.decision.changeOrderId, undefined); assert.equal(plan.patch.changeOrders, undefined); assert.equal(plan.patch.invoice, undefined);
  assert.equal(saved.approvedChangeTotal, 0);
  assert.deepEqual(customerMoneyState(saved), customerMoneyState(current));
  assert.deepEqual(customerDepositState(saved), customerDepositState(current));
  assert.equal(customerMoneyTotals(saved).totalCents, 100000);
});

test('billing reads only whole change-order lines that name one decision, once per decision', () => {
  const line = (decisionId, cents, extra = {}) => ({ id: `change-${decisionId}`, kind: 'fee', source: 'customer_decision', decisionId, quantity: 1, unitCents: cents, totalCents: cents, amount: cents / 100, ...extra });
  const changeOrders = [
    line('a', 1000),
    line('a', 1000), // a repeated line is billed once
    line('b', 1000, { kind: 'service' }),
    line('c', 1000, { source: 'hub' }),
    line('d', 1000, { id: 'change-other' }),
    line('e', 10.5), line('f', -1000), line('g', 0), line('h', 100000001), line('i', '1000'),
    { ...line('j', 1000), decisionId: '' },
    null, 'x',
    line('k', 2500),
  ];
  assert.deepEqual(billedChangeOrders({ changeOrders }).map(item => item.decisionId), ['a', 'k']);
  assert.equal(billedChangeCents({ changeOrders }), 3500);
  assert.equal(billedChangeCents({}), 0); assert.equal(billedChangeCents({ changeOrders: 'nope' }), 0);
  assert.equal(customerMoneyState({ total: 100, changeOrders }).total, 135);
  // An approval saved without a line (before billing existed) is not charged, as today.
  assert.equal(customerMoneyState({ total: 100, customerDecisions: [{ id: 'z', status: 'approved', priceDelta: 50 }], approvedChangeTotal: 50 }).total, 100);
});

test('approvedChangeTotal counts billed lines and the shown price of unbilled approvals, in whole cents', () => {
  const approved = values => values.map((priceDelta, index) => ({ id: `d${index}`, status: 'approved', priceDelta }));
  assert.equal(approvedChangeTotal(approved([0.1, 0.2])), 0.3);
  assert.equal(approvedChangeTotal(approved([75.25, 150, '$10.05', 'n/a', -20])), 235.3, 'the shown price, never negative, as the portal card reads it');
  assert.equal(approvedChangeTotal([{ status: 'declined', priceDelta: 50 }, null, 'x']), 0);
  // A billed line counts at the price the customer approved, even after the decision is edited or trimmed away.
  const lines = [{ decisionId: 'd0', totalCents: 1000 }, { decisionId: 'gone', totalCents: 2500 }];
  assert.equal(approvedChangeTotal([{ id: 'd0', status: 'approved', priceDelta: 99 }, { id: 'd1', status: 'approved', priceDelta: 5 }], lines), 40);
});

test('without the flag an approval is saved exactly as today and never charged', () => {
  const current = job(), plan = respondToDecision(current, { ...input(), requestId: '', priceDeltaCents: null }, { now: NOW }), saved = { ...current, ...plan.patch };
  assert.equal(plan.billedCents, 0); assert.equal(plan.patch.changeOrders, undefined); assert.equal(plan.decision.changeOrderId, undefined);
  assert.equal(saved.approvedChangeTotal, 150);
  assert.deepEqual(customerMoneyState(saved), customerMoneyState(current));
});

test('billing refuses an unseen, unreadable or ambiguous price and a closed job', () => {
  const refuse = (current, extra, code) => assert.throws(() => respondToDecision(current, input(extra), { billing: true, now: NOW }), { code: `CUSTOMER_PORTAL_${code}`, status: 409 }, code);
  refuse(job(), { priceDeltaCents: null }, 'DECISION_CHANGED');
  refuse(job(), { priceDeltaCents: 10000 }, 'DECISION_CHANGED');
  for (const priceDelta of ['lots', -5, '$150', 1000000.01]) refuse(job({ customerDecisions: [decision({ priceDelta })] }), {}, 'DECISION_PRICE_INVALID');
  refuse(job({ customerDecisions: [decision(), decision()] }), {}, 'DECISION_AMBIGUOUS');
  for (const status of ['cancelled', 'canceled', 'lost']) refuse(job({ status }), {}, 'JOB_CLOSED');
  refuse(job({ pipelineStatus: 'superseded' }), {}, 'JOB_CLOSED');
  assert.throws(() => respondToDecision(job(), input({ decisionId: 'decision-missing' }), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_NOT_FOUND', status: 404 });
  assert.throws(() => respondToDecision(job(), input(), { billing: true }), { status: 503 }, 'the time is always passed in');
  // A decision with no price is approved without a change order or a price check.
  const free = respondToDecision(job({ customerDecisions: [decision({ priceDelta: 0 })] }), input({ priceDeltaCents: null }), { billing: true, now: NOW });
  assert.equal(free.billedCents, 0); assert.equal(free.decision.status, 'approved'); assert.equal(free.patch.changeOrders, undefined);
  // A pending decision that already has a line, or a job at the line cap, goes to the team instead.
  const line = respondToDecision(job(), input(), { billing: true, now: NOW }).patch.changeOrders[0];
  refuse(job({ changeOrders: [line] }), {}, 'DECISION_AMBIGUOUS');
  refuse(job({ changeOrders: Array.from({ length: 50 }, (_, index) => ({ ...line, id: `change-old-${index}`, decisionId: `old-${index}` })) }), {}, 'DECISION_AMBIGUOUS');
});

test('an issued invoice is raised by exactly the change and lists it; void and draft invoices are left alone', () => {
  const issued = { number: 'INV-000001', status: 'paid', issuedAt: '2026-09-21T17:00:00.000Z', dueDate: '2026-09-28', amount: 1000, amountCents: 100000, paid: 1000, paidCents: 100000, balance: 0, balanceCents: 0, approvedChangeCents: 0,
    lineItems: [{ id: 'line-1', kind: 'service', name: 'Garage Turnaround', description: '', quantity: 1, unitCents: 100000, totalCents: 100000, amount: 1000 }] };
  const paid = job({ payment: { ...job().payment, amount: 1000 }, invoice: issued }), plan = respondToDecision(paid, input(), { billing: true, now: NOW });
  assert.deepEqual(plan.patch.invoice, {
    ...issued, amount: 1150, amountCents: 115000, balance: 150, balanceCents: 15000, approvedChangeCents: 15000, status: 'partial', updatedAt: NOW,
    lineItems: [...issued.lineItems, { id: 'change-decision-freezer', kind: 'fee', name: 'Approved change: Haul the old freezer', description: 'Synthetic crew note: it sits by the side door.', quantity: 1, unitCents: 15000, totalCents: 15000, amount: 150 }],
  });
  const saved = { ...paid, ...plan.patch };
  assert.equal(customerMoneyState(saved).balance, 150);
  assert.deepEqual(invoiceLineItems(saved).lineItems.map(line => [line.id, line.kind, line.totalCents]), [['legacy-1', 'service', 100000], ['change-decision-freezer', 'fee', 15000]], 'money-core invoices show the same fee line');
  // An unnumbered invoice from an earlier payment only has its running figures raised.
  const legacy = respondToDecision(job({ invoice: { amount: 1000, paid: 500, balance: 500, status: 'partial' } }), input(), { billing: true, now: NOW }).patch.invoice;
  assert.deepEqual(legacy, { amount: 1150, paid: 500, balance: 650, status: 'partial', updatedAt: NOW });
  for (const status of ['void', 'superseded', 'draft']) assert.equal(respondToDecision(job({ invoice: { ...issued, status } }), input(), { billing: true, now: NOW }).patch.invoice, undefined, status);
  assert.equal(respondToDecision(job({ invoice: { status: 'issued' } }), input(), { billing: true, now: NOW }).patch.invoice, undefined, 'an invoice without a readable amount is left for the Hub');
});

test('portal: an approved +$150 decision raises the balance by $150 exactly once and keeps the paid deposit', async t => {
  const original = job(), f = portalStore(t, { 'job-1': original }), handlers = portalHandlers(), cookie = await portalCookie();
  const before = (await portalView(handlers, cookie, billing)).body;
  assert.deepEqual(money(before), [1000, 500, 500, 0]);
  assert.deepEqual(before.experience.decisions.map(item => [item.id, item.status, item.priceDelta, item.billed]), [['decision-freezer', 'pending', 150, false]]);
  const body = answer(), first = await portalPost(handlers, cookie, body, billing);
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.billed, first.body.replayed, first.body.approvedChangeTotal, first.body.decision.status, first.body.decision.billed], [true, false, 150, 'approved', true]);
  assert.equal(first.body.decision.promptedBy, undefined, 'the response is the portal view of the decision, not the saved record');
  assert.equal(first.body.decision.changeOrderId, undefined);
  const after = (await portalView(handlers, cookie, billing)).body;
  assert.deepEqual(money(after), [1150, 500, 650, 150]);
  assert.deepEqual([after.payment.dueNow, after.payment.purpose, after.payment.deposit.required, after.payment.deposit.paid, after.payment.deposit.remainder], [0, 'deposit', 500, 500, 650]);
  // The signed estimate the customer approved is untouched: same total, revision and fingerprint.
  assert.deepEqual([after.estimate.amount, after.estimate.revision, after.estimate.status, after.estimate.fingerprint], [1000, 2, 'approved', before.estimate.fingerprint]);
  // Replaying the same request (a double tap or a retried network call) adds nothing.
  for (let index = 0; index < 2; index += 1) {
    const replay = await portalPost(handlers, cookie, body, billing);
    assert.equal(replay.status, 200); assert.deepEqual([replay.body.replayed, replay.body.billed, replay.body.approvedChangeTotal], [true, true, 150]);
  }
  const other = await portalPost(handlers, cookie, answer(), billing);
  assert.equal(other.status, 409); assert.equal(other.body.code, 'CUSTOMER_PORTAL_DECISION_ANSWERED');
  assert.equal(f.writes.length, 1, 'one write for the one answer');
  assert.deepEqual(money((await portalView(handlers, cookie, billing)).body), [1150, 500, 650, 150]);
  const saved = f.job('job-1');
  for (const key of ['estimate', 'customerApproval', 'deposit', 'payment', 'total', 'quoteStatus']) assert.deepEqual(saved[key], original[key], `${key} is preserved`);
  assert.equal(saved.approvedChangeTotal, 150);
  assert.deepEqual(saved.changeOrders.map(line => [line.id, line.kind, line.totalCents, line.requestId]), [['change-decision-freezer', 'fee', 15000, body.request_id]]);
  assert.deepEqual([saved.customerDecisions[0].responseRequestId, saved.customerDecisions[0].changeOrderId], [body.request_id, 'change-decision-freezer']);
});

test('portal: an answer whose write landed without a response is a replay, not a second charge', async t => {
  const f = portalStore(t, { 'job-1': job() }), cookie = await portalCookie(), body = answer();
  // The same request's earlier attempt lands after this one read the job.
  const landed = async (testEnv, id) => {
    const row = await readJob(testEnv, id);
    if (row.customerDecisions[0].status === 'pending') f.edit('job-1', respondToDecision(row, input({ requestId: body.request_id, note: body.note }), { billing: true, now: NOW }).patch);
    return row;
  };
  const retried = await portalPost(portalHandlers(NOW, { read: landed }), cookie, body, billing);
  assert.equal(retried.status, 200); assert.equal(retried.body.replayed, true); assert.equal(retried.body.billed, true);
  assert.equal(f.writes.length, 0); assert.equal(f.rejected.length, 1, 'the stale write was refused by its revision');
  assert.deepEqual(money((await portalView(portalHandlers(), cookie, billing)).body), [1150, 500, 650, 150]);
});

test('portal: a storage error is retried against the latest revision and still bills once', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  f.failNextWrite();
  const saved = await portalPost(handlers, cookie, answer(), billing);
  assert.equal(saved.status, 200); assert.equal(saved.body.replayed, false);
  assert.equal(f.writes.length, 1);
  assert.equal(billedChangeCents(f.job('job-1')), 15000);
});

test('portal: two devices answering at once add the change once', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  const results = await Promise.all([portalPost(handlers, cookie, answer(), billing), portalPost(handlers, cookie, answer({ responded_by: 'Synthetic Partner' }), billing)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.status === 409).body.code, 'CUSTOMER_PORTAL_DECISION_ANSWERED');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(money((await portalView(handlers, cookie, billing)).body), [1150, 500, 650, 150]);
});

test('portal: a declined decision leaves money unchanged', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  const declined = await portalPost(handlers, cookie, answer({ response: 'declined', price_delta_cents: undefined }), billing);
  assert.equal(declined.status, 200); assert.deepEqual([declined.body.billed, declined.body.approvedChangeTotal, declined.body.decision.status], [false, 0, 'declined']);
  assert.deepEqual(money((await portalView(handlers, cookie, billing)).body), [1000, 500, 500, 0]);
  assert.equal(f.job('job-1').changeOrders, undefined);
  assert.equal(f.job('job-1').approvedChangeTotal, 0);
});

test('portal: a price changed after the page loaded must be reviewed before it is approved', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  f.edit('job-1', { customerDecisions: [decision({ priceDelta: 200 })] });
  for (const body of [answer(), answer({ price_delta_cents: undefined }), answer({ price_delta_cents: '20000' })]) {
    const refused = await portalPost(handlers, cookie, body, billing);
    assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CUSTOMER_PORTAL_DECISION_CHANGED'); assert.match(refused.body.error, /Refresh and review the current price/);
  }
  assert.equal(f.writes.length, 0);
  assert.equal((await portalPost(handlers, cookie, answer({ price_delta_cents: 20000 }), billing)).status, 200);
  assert.deepEqual(money((await portalView(handlers, cookie, billing)).body), [1200, 500, 700, 200]);
  const invalid = await portalPost(handlers, cookie, answer({ request_id: 'not-a-uuid' }), billing);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.code, 'CUSTOMER_PORTAL_REQUEST_INVALID');
});

test('portal: with the flag unset an approval is recorded but not charged, as today', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  const legacy = await portalPost(handlers, cookie, { action: 'respond_decision', decision_id: 'decision-freezer', response: 'approved', responded_by: 'Synthetic Customer', note: '' });
  assert.equal(legacy.status, 200); assert.deepEqual([legacy.body.billed, legacy.body.approvedChangeTotal], [false, 150]);
  assert.deepEqual(money((await portalView(handlers, cookie)).body), [1000, 500, 500, 0]);
  assert.equal(f.job('job-1').changeOrders, undefined);
  // Turning billing on later never charges an approval made without it.
  assert.deepEqual(money((await portalView(handlers, cookie, billing)).body), [1000, 500, 500, 0]);
});

test('portal: a collaborator without decision rights cannot approve a change', async t => {
  const f = portalStore(t, { 'job-1': job({ customerCollaborators: [{ id: 'person-1', name: 'Synthetic Viewer', email: 'viewer@example.invalid', permissions: { view: true, decide: false, pay: true }, status: 'active' }] }) });
  const cookie = await portalCookie('job-1', { actorId: 'person-1', permissions: { view: true, decide: false, pay: true, rebook: false } });
  assert.equal((await portalPost(portalHandlers(), cookie, answer(), billing)).status, 403);
  assert.equal(f.writes.length, 0);
});

// Firestore (jobs and the checkout ledger) and Stripe Checkout, for the real portal payment path.
function paymentStore(t, jobs) {
  const docs = new Map(), sessions = new Map(), keys = new Map(), created = [], expired = [];
  let version = 0;
  const stamp = () => `2026-09-22T00:00:00.${String(++version).padStart(6, '0')}Z`;
  for (const [id, value] of Object.entries(jobs)) docs.set(`jobs/${id}`, { value: structuredClone(value), updateTime: stamp() });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      // FUN-03: portal decision answers commit the job with their funnel event (documents:commit).
      if (url.pathname.endsWith('/documents:commit')) {
        const result = applyFirestoreCommit(JSON.parse(options.body), { read: key => docs.has(key) ? { data: docs.get(key).value, updateTime: docs.get(key).updateTime } : null, write: (key, value) => docs.set(key, { value, updateTime: stamp() }) });
        return result.stale ? Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 }) : Response.json({ writeResults: result.paths.map(() => ({})) });
      }
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]), row = docs.get(path);
      if (method === 'PATCH') {
        const precondition = url.searchParams.get('currentDocument.updateTime'), create = url.searchParams.get('currentDocument.exists') === 'false';
        if (row && (create || precondition && precondition !== row.updateTime) || !row && precondition) return Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 });
        const mask = url.searchParams.getAll('updateMask.fieldPaths'), patch = decodeFirestoreFields(JSON.parse(options.body).fields);
        const next = mask.length ? { ...row?.value, ...Object.fromEntries(mask.map(key => [key, patch[key]])) } : patch;
        docs.set(path, { value: next, updateTime: stamp() });
      }
      const saved = docs.get(path);
      return saved ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(saved.value), updateTime: saved.updateTime }) : Response.json({}, { status: 404 });
    }
    assert.equal(url.hostname, 'api.stripe.com', `Unexpected external request to ${url.hostname}`);
    if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
      const params = new URLSearchParams(options.body), key = options.headers['Idempotency-Key'];
      if (!keys.has(key)) {
        const id = `cs_test_change_${sessions.size + 1}`, metadata = Object.fromEntries([...params].filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value]));
        keys.set(key, id); created.push(params);
        sessions.set(id, { id, mode: 'payment', status: 'open', payment_status: 'unpaid', currency: 'usd', amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), client_reference_id: params.get('client_reference_id'), metadata, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      return Response.json(sessions.get(keys.get(key)));
    }
    const session = sessions.get(decodeURIComponent(url.pathname.split('/')[4]));
    if (!session) return Response.json({}, { status: 404 });
    if (method === 'POST' && url.pathname.endsWith('/expire')) { session.status = 'expired'; session.url = null; expired.push(session.id); }
    return Response.json(session);
  });
  const complete = id => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', url: null, payment_intent: { id: `pi_${id}`, latest_charge: { receipt_url: `https://pay.stripe.com/receipts/${id}` } }, customer_details: { email: 'synthetic@example.invalid' } });
  return { docs, sessions, created, expired, complete, job: id => structuredClone(docs.get(`jobs/${id}`).value), edit: (id, patch) => docs.set(`jobs/${id}`, { value: { ...docs.get(`jobs/${id}`).value, ...patch }, updateTime: stamp() }) };
}

test('checkout: the balance charged online includes the approved change, and paying it settles the job without a review', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const stripeEnv = { ...billing, STRIPE_SECRET_KEY: 'sk_test_synthetic_change_orders' };
  // The final walkthrough is done, so the balance is due, but the crew is still on site.
  const f = paymentStore(t, { 'job-1': job({ postJobProgress: { standardItems: [{ key: '0_1', completed: true }] } }) }), handlers = portalHandlers(), cookie = await portalCookie();
  // A checkout opened before the change is sized to the old balance...
  assert.equal((await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'synthetic-pay-1' }, stripeEnv)).status, 200);
  assert.equal(f.sessions.get('cs_test_change_1').amount_total, 50000);
  assert.equal((await portalPost(handlers, cookie, answer(), stripeEnv)).status, 200);
  // ...so it is expired and replaced by one that charges the change too.
  const paying = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'synthetic-pay-2', amount_cents: 100 }, stripeEnv);
  assert.equal(paying.status, 200); assert.equal(paying.body.amount, 650); assert.equal(paying.body.purpose, 'balance');
  assert.deepEqual(f.expired, ['cs_test_change_1']);
  const params = f.created.at(-1);
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), '65000');
  assert.equal(params.get('metadata[approved_change_cents]'), '15000'); assert.equal(params.get('metadata[quoted_total_cents]'), '115000');
  assert.match(params.get('line_items[0][price_data][product_data][description]'), /including \$150\.00 in approved changes\.$/);
  assert.equal(f.created[0].get('metadata[approved_change_cents]'), null, 'a checkout without a change keeps its original parameters');
  f.complete('cs_test_change_2');
  const verified = await portalPost(handlers, cookie, { action: 'verify_payment', session_id: 'cs_test_change_2' }, stripeEnv);
  assert.equal(verified.status, 200); assert.deepEqual([verified.body.paid, verified.body.duplicate, verified.body.balance], [true, false, 0]);
  const saved = f.job('job-1');
  assert.equal(jobFinished(saved), false);
  assert.deepEqual([saved.payment.amount, saved.invoice.amount, saved.invoice.paid, saved.invoice.balance, saved.invoice.status], [1150, 1150, 1150, 0, 'paid']);
  assert.equal(saved.paymentReviewRequired, undefined, 'paying the change is not an overpayment');
  assert.deepEqual([saved.deposit.amount, saved.deposit.paidAmount, saved.deposit.status], [500, 500, 'paid']);
  assert.equal(customerMoneyTotals(saved).balanceCents, 0);
  assert.equal((await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'synthetic-pay-3' }, stripeEnv)).status, 409, 'nothing more is charged');
});

test('money documents offer Pay for a billed change because the checkout charges the money-core amount', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  // Approved while the crew was on site; the crew then finished the job.
  const working = job({ id: 'synthetic-change-000301', invoice: { number: 'INV-000301', status: 'issued', issuedAt: '2026-09-22T16:45:00.000Z', dueDate: '2026-09-29', amount: 1000, paid: 500, balance: 500 } });
  const finished = { status: 'completed', completedAt: '2026-09-22T18:30:00.000Z' };
  const billed = { ...working, ...respondToDecision(working, input(), { billing: true, now: NOW }).patch, ...finished };
  const unbilled = { ...working, ...respondToDecision(working, { ...input(), requestId: '', priceDeltaCents: null }, { now: NOW }).patch, ...finished };
  const charged = async current => {
    const { id, ...fields } = current, f = paymentStore(t, { [id]: fields });
    try { return Math.round((await createCustomerStripeCheckout(env, 'sk_test_synthetic_change_orders', id, ORIGIN)).amount * 100); }
    finally { assert.ok(f.created.length <= 1); }
  };
  for (const kind of ['invoice', 'estimate']) {
    const doc = moneyDocumentModel(billed, { kind, now: NOW, payUrl: '/customer-portal#pay' });
    assert.equal(doc.totals.dueNowCents, 65000, kind);
    assert.deepEqual(doc.pay, { url: '/customer-portal#pay', amountCents: 65000, label: 'Pay $650.00 balance securely' }, kind);
    // An approval saved without billing is still owed on paper but not charged online (the M4 rule).
    assert.equal(moneyDocumentModel(unbilled, { kind, now: NOW, payUrl: '/customer-portal#pay' }).pay, null, kind);
  }
  assert.equal(await charged(billed), 65000);
  assert.equal(await charged(unbilled), 50000);
  assert.deepEqual(moneyDocumentModel(billed, { kind: 'invoice', now: NOW }).lines.map(line => [line.id, line.totalCents]), [['legacy-1', 100000], ['change-decision-freezer', 15000]]);
});

test('the portal page sends the displayed price with a request id it reuses until the answer is saved', async () => {
  const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
  const stored = new Map(), posts = [], toasts = [], loads = [];
  let outcome = () => Promise.reject(Object.assign(new Error('Network connection lost'), { code: '' }));
  // QUOTE-DRAFT (merge): a saved answer also drops the decision list's render key, so the next refresh rebuilds it.
  const decisionList = { dataset: { key: 'rendered' } };
  const context = vm.createContext({
    $: id => id === 'decision-list' ? decisionList : null,
    crypto: globalThis.crypto, money: value => `$${Number(value).toFixed(2)}`, portalData: { viewer: { owner: true, actorId: '', jobKey: 'synthetic-job-key' } },
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) },
    api: async body => { posts.push(structuredClone(body)); return outcome(); }, toast: (message, error = false) => toasts.push([message, error]), load: async quiet => { loads.push(quiet); },
  });
  vm.runInContext(portalScript(html, ['function reviewRequestId(', 'function decisionKey(', 'async function respondDecision(']), context);
  const control = value => ({ value }), button = { disabled: false, textContent: 'Approve +$150.00' };
  const item = { id: 'decision-freezer', priceDelta: 150 };
  await context.respondDecision(item, 'approved', control(' Synthetic Customer '), control(' Yes '), button);
  assert.deepEqual([button.disabled, button.textContent, toasts.at(-1)], [false, 'Approve +$150.00', ['Network connection lost', true]]);
  // The unconfirmed request is kept for this viewer on this job only.
  assert.deepEqual([...stored.keys()], ['egc.portal.decision.owner.synthetic-job-key.decision-freezer.approved']);
  assert.equal(decisionList.dataset.key, 'rendered', 'an unconfirmed answer keeps what the customer typed');
  outcome = () => Promise.resolve({ ok: true, billed: true });
  await context.respondDecision(item, 'approved', control('Synthetic Customer'), control('Yes'), button);
  assert.equal(posts.length, 2);
  assert.match(posts[0].request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(posts[1].request_id, posts[0].request_id, 'a retry repeats the same request');
  assert.deepEqual({ ...posts[1], request_id: 'x' }, { action: 'respond_decision', decision_id: 'decision-freezer', response: 'approved', responded_by: 'Synthetic Customer', note: 'Yes', request_id: 'x', price_delta_cents: 15000 });
  assert.equal(stored.size, 0, 'a saved answer forgets its request');
  assert.equal('key' in decisionList.dataset, false, 'a saved answer rebuilds the decision list on the next load');
  assert.deepEqual(toasts.at(-1), ['Change approved. $150.00 was added to your balance.', false]);
  outcome = () => Promise.resolve({ ok: true, billed: false });
  await context.respondDecision({ id: 'decision-paint', priceDelta: 0 }, 'declined', control('Synthetic Customer'), control(''), button);
  assert.equal(posts.at(-1).price_delta_cents, 0); assert.notEqual(posts.at(-1).request_id, posts[0].request_id);
  assert.deepEqual(toasts.at(-1), ['Decision declined. The crew can see it now.', false]);
  // A price the team changed reloads the card so the customer sees the new price; the refused request is dropped.
  outcome = () => Promise.reject(Object.assign(new Error('This change was updated after the page loaded.'), { code: 'CUSTOMER_PORTAL_DECISION_CHANGED' }));
  loads.length = 0;
  await context.respondDecision(item, 'approved', control('Synthetic Customer'), control(''), button);
  assert.deepEqual(loads, [true]); assert.equal(stored.size, 0);
  // Another viewer in the same tab never reuses the owner's unconfirmed request.
  outcome = () => Promise.reject(Object.assign(new Error('Network connection lost'), { code: '' }));
  await context.respondDecision(item, 'approved', control('Synthetic Customer'), control(''), button);
  context.portalData = { viewer: { owner: false, actorId: 'person-1', jobKey: 'synthetic-job-key' } };
  await context.respondDecision(item, 'approved', control('Synthetic Partner'), control(''), button);
  assert.deepEqual([...stored.keys()], ['egc.portal.decision.owner.synthetic-job-key.decision-freezer.approved', 'egc.portal.decision.person-1.synthetic-job-key.decision-freezer.approved']);
  assert.notEqual(posts.at(-1).request_id, posts.at(-2).request_id);
  // A request the server already saved with other details is dropped and the page reloads.
  outcome = () => Promise.reject(Object.assign(new Error('This answer was already sent with different details.'), { code: 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT' }));
  loads.length = 0;
  await context.respondDecision(item, 'approved', control('Synthetic Partner'), control('Changed'), button);
  assert.deepEqual(loads, [true]); assert.deepEqual([...stored.keys()], ['egc.portal.decision.owner.synthetic-job-key.decision-freezer.approved']);
});

test('a finished job is closed for billing: an old priced question approved late is refused and adds nothing', () => {
  const at = '2026-09-19T20:00:00.000Z';
  for (const extra of [{ status: 'completed' }, { status: 'invoiced' }, { status: 'paid' }, { status: 'review_requested' }, { status: 'closed' }, { pipelineStatus: 'paid' }, { completedAt: at }, { postJobChecklist: { completedAt: at } }]) {
    const current = job(extra);
    assert.equal(jobFinished(current), true, JSON.stringify(extra));
    assert.throws(() => respondToDecision(current, input(), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_JOB_CLOSED', status: 409, message: /crew has finished this job/ }, JSON.stringify(extra));
  }
  for (const extra of [{}, { status: 'scheduled' }, { status: 'dispatched' }, { status: 'arrived' }, { postJobProgress: { standardItems: [{ key: '0_1', completed: true }] } }]) assert.equal(jobFinished(job(extra)), false, JSON.stringify(extra));
  // Declining it, or approving a question with no price, is recorded without money; without billing it is saved unbilled, as today.
  const done = job({ status: 'completed', completedAt: at });
  assert.equal(respondToDecision(done, input({ response: 'declined' }), { billing: true, now: NOW }).decision.status, 'declined');
  const free = respondToDecision(job({ status: 'completed', completedAt: at, customerDecisions: [decision({ priceDelta: 0 })] }), input({ priceDeltaCents: 0 }), { billing: true, now: NOW });
  assert.deepEqual([free.decision.status, free.billedCents, free.patch.changeOrders], ['approved', 0, undefined]);
  const legacy = respondToDecision(done, { ...input(), requestId: '', priceDeltaCents: null }, { now: NOW });
  assert.deepEqual([legacy.billedCents, legacy.patch.changeOrders, legacy.patch.invoice], [0, undefined, undefined]);
});

test('portal: a completed, paid job with an old pending +$150 question refuses the approval and leaves money and the invoice unchanged', async t => {
  const invoice = { number: 'INV-000001', status: 'paid', issuedAt: '2026-09-19T20:05:00.000Z', amount: 1000, paid: 1000, balance: 0 };
  const original = job({ status: 'paid', pipelineStatus: 'paid', completedAt: '2026-09-19T20:00:00.000Z', payment: { ...job().payment, amount: 1000 }, invoice });
  const f = portalStore(t, { 'job-1': original }), handlers = portalHandlers(), cookie = await portalCookie();
  const before = (await portalView(handlers, cookie, billing)).body;
  assert.deepEqual(before.experience.decisions.map(item => [item.id, item.status, item.closed]), [['decision-freezer', 'pending', true]], 'the page shows the question as closed instead of offering Approve');
  const refused = await portalPost(handlers, cookie, answer(), billing);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CUSTOMER_PORTAL_JOB_CLOSED'); assert.match(refused.body.error, /crew has finished this job.*call or text us/);
  assert.equal(f.writes.length, 0);
  const after = (await portalView(handlers, cookie, billing)).body;
  assert.deepEqual(money(after), [1000, 1000, 0, 0]); assert.deepEqual([after.payment.dueNow, after.payment.purpose], [0, 'balance']);
  const saved = f.job('job-1');
  assert.deepEqual(saved.invoice, invoice); assert.equal(saved.changeOrders, undefined); assert.equal(saved.customerDecisions[0].status, 'pending');
  assert.deepEqual(customerMoneyState(saved), { total: 1000, paid: 1000, balance: 0 });
  assert.equal(customerMoneyTotals(saved).balanceCents, 0);
  // Without billing the page offers the question exactly as today.
  assert.equal((await portalView(handlers, cookie)).body.experience.decisions[0].closed, false);
});

test('raising an invoice keeps a pending verification and reads the recorded payment when the invoice has no paid figure', async t => {
  const line = { id: 'change-decision-freezer', kind: 'fee', name: 'Approved change: Haul the old freezer', description: '', totalCents: 15000, amount: 150 };
  assert.deepEqual(raisedInvoice({ status: 'pending_verification', amount: 1000, balance: 0 }, line, NOW, 100000), { status: 'pending_verification', amount: 1150, paid: 1000, balance: 150, updatedAt: NOW });
  assert.equal(raisedInvoice({ status: 'paid', amount: 1000, balance: 0 }, line, NOW, 100000).status, 'partial');
  assert.equal(raisedInvoice({ status: 'paid', amount: 1000, balance: 0 }, line, NOW, 0).status, 'issued');
  assert.deepEqual(raisedInvoice({ status: 'paid', amount: 1000, paid: 0, balance: 0 }, line, NOW, 100000), { status: 'partial', amount: 1150, paid: 1000, balance: 150, updatedAt: NOW }, "the job's recorded paid total wins over the invoice's own paid figure");
  assert.deepEqual(raisedInvoice({ status: 'paid', amount: 1000, paid: 0, balance: 0 }, line, NOW), { status: 'issued', amount: 1150, paid: 0, balance: 1150, updatedAt: NOW }, "without the recorded total the invoice's own paid figure is read");
  // The portal passes the job's recorded payment: a prepaid job still in progress reopens as partial.
  const f = portalStore(t, { 'job-1': job({ payment: { ...job().payment, amount: 1000 }, invoice: { status: 'paid', amount: 1000, balance: 0 } }) }), cookie = await portalCookie();
  assert.equal((await portalPost(portalHandlers(), cookie, answer(), billing)).status, 200);
  assert.deepEqual(f.job('job-1').invoice, { status: 'partial', amount: 1150, paid: 1000, balance: 150, updatedAt: NOW });
});

test('a stale invoice paid figure never outvotes the recorded payments: the raised invoice agrees with the portal and money-core', async t => {
  // INV-1 was issued while $500 was paid; the other $500 was recorded offline afterwards, which never updates the invoice.
  const invoice = { number: 'INV-1', status: 'partial', issuedAt: '2026-09-21T17:00:00.000Z', dueDate: '2026-09-29', amount: 1000, amountCents: 100000, paid: 500, paidCents: 50000, balance: 500, balanceCents: 50000 };
  const stale = job({ payment: { ...job().payment, amount: 1000 }, invoice });
  assert.deepEqual([customerMoneyState(stale).balance, customerMoneyTotals(stale).balanceCents], [0, 0], 'every surface already reads the quote as paid');
  const f = portalStore(t, { 'job-1': stale }), cookie = await portalCookie();
  assert.equal((await portalPost(portalHandlers(), cookie, answer(), billing)).status, 200);
  const saved = f.job('job-1');
  assert.deepEqual([saved.invoice.amount, saved.invoice.amountCents, saved.invoice.paid, saved.invoice.paidCents, saved.invoice.balance, saved.invoice.balanceCents, saved.invoice.status], [1150, 115000, 1000, 100000, 150, 15000, 'partial']);
  // The invoice, the portal, the checkout balance, money-core and the crew closeout all owe exactly the change.
  assert.deepEqual(money((await portalView(portalHandlers(), cookie, billing)).body), [1150, 1000, 150, 150]);
  assert.deepEqual(customerMoneyState(saved), { total: 1150, paid: 1000, balance: 150 });
  assert.equal(customerMoneyTotals(saved).balanceCents, 15000);
  // Called without the recorded total (an older caller), the invoice's own figure is still what it reads.
  assert.deepEqual([raisedInvoice(invoice, saved.changeOrders[0], NOW).paid, raisedInvoice(invoice, saved.changeOrders[0], NOW).balance], [500, 650]);
});

test('a decision whose change-order line id is already taken goes to the team instead of being billed', () => {
  const stem = `decision-${'x'.repeat(60)}`, first = `${stem}-a`, second = `${stem}-b`;
  assert.equal(changeOrderLineId(first), changeOrderLineId(second), 'line ids keep 60 characters of the decision id (quote-model line ids are at most 80)');
  const current = job({ customerDecisions: [decision({ id: first }), decision({ id: second, priceDelta: 75 })] });
  const saved = { ...current, ...respondToDecision(current, input({ decisionId: first }), { billing: true, now: NOW }).patch };
  assert.throws(() => respondToDecision(saved, input({ decisionId: second, priceDeltaCents: 7500, requestId: randomUUID() }), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_AMBIGUOUS' });
  assert.deepEqual([billedChangeCents(saved), saved.approvedChangeTotal, customerMoneyTotals(saved).approvedChangeCents], [15000, 150, 15000]);
  // A voided line still holds its id, so re-approving that decision goes to the team too.
  const voided = { ...job(), changeOrders: [{ ...saved.changeOrders[0], id: 'change-decision-freezer', decisionId: 'decision-freezer', status: 'void', voidedAt: NOW }] };
  assert.equal(billedChangeCents(voided), 0);
  assert.throws(() => respondToDecision(voided, input(), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_AMBIGUOUS' });
});

test('portal: the same request id with a different answer is an idempotency conflict and writes once', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie(), body = answer();
  assert.equal((await portalPost(handlers, cookie, body, billing)).status, 200);
  for (const extra of [{ responded_by: 'Synthetic Partner' }, { note: 'Changed my mind' }, { response: 'declined', price_delta_cents: undefined }]) {
    const conflict = await portalPost(handlers, cookie, { ...body, ...extra }, billing);
    assert.equal(conflict.status, 409, JSON.stringify(extra)); assert.equal(conflict.body.code, 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT');
  }
  assert.equal((await portalPost(handlers, cookie, body, billing)).body.replayed, true);
  assert.equal(f.writes.length, 1); assert.equal(billedChangeCents(f.job('job-1')), 15000);
});

test('portal: without billing a storage error is retried and still records the one answer', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  f.failNextWrite();
  const saved = await portalPost(handlers, cookie, answer());
  assert.equal(saved.status, 200); assert.deepEqual([saved.body.billed, saved.body.replayed, saved.body.approvedChangeTotal, saved.body.decision.status], [false, false, 150, 'approved']);
  assert.equal(f.writes.length, 1); assert.equal(f.job('job-1').changeOrders, undefined);
  assert.deepEqual(money((await portalView(handlers, cookie)).body), [1000, 500, 500, 0]);
});

test('portal: without billing two devices answering at once save one answer and tell the other it was answered', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  const results = await Promise.all([portalPost(handlers, cookie, answer()), portalPost(handlers, cookie, answer({ responded_by: 'Synthetic Partner', response: 'declined' }))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.status === 409).body.code, 'CUSTOMER_PORTAL_DECISION_ANSWERED');
  assert.equal(f.writes.length, 1);
});

test('portal: a retry re-checks the viewer, so a decision right or link revoked meanwhile stops the answer', async t => {
  const person = { id: 'person-1', name: 'Synthetic Partner', email: 'partner@example.invalid', permissions: { view: true, decide: true, pay: false }, status: 'active' };
  const f = portalStore(t, { 'job-1': job({ customerCollaborators: [person] }) });
  let reads = 0, revoke = () => {};
  const read = async (testEnv, id) => { if (++reads === 2) revoke(); return readJob(testEnv, id); };
  const partner = await portalCookie('job-1', { actorId: 'person-1', permissions: { view: true, decide: true, pay: false, rebook: false } });
  revoke = () => f.edit('job-1', { customerCollaborators: [{ ...person, permissions: { view: true, decide: false } }] });
  f.failNextWrite();
  const refused = await portalPost(portalHandlers(NOW, { read }), partner, answer({ responded_by: 'Synthetic Partner' }), billing);
  assert.equal(refused.status, 403); assert.equal(f.writes.length, 0);
  // The owner's link is replaced (account link version bumped) while the first write fails.
  reads = 0; revoke = () => f.edit('job-1', { customerPortalLinkVersion: 1 });
  f.failNextWrite();
  const revoked = await portalPost(portalHandlers(NOW, { read }), await portalCookie(), answer(), billing);
  assert.equal(revoked.status, 403); assert.equal(revoked.body.code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
  assert.equal(f.writes.length, 0); assert.equal(f.job('job-1').customerDecisions[0].status, 'pending');
});

test('portal: the page scopes saved requests with an opaque per-job key, never the job id', async t => {
  portalStore(t, { 'job-1': job(), 'job-2': job() });
  const handlers = portalHandlers(), one = (await portalView(handlers, await portalCookie('job-1'))).body.viewer, two = (await portalView(handlers, await portalCookie('job-2'))).body.viewer;
  assert.match(one.jobKey, /^[0-9a-f]{16}$/); assert.notEqual(one.jobKey, two.jobKey);
  assert.equal((await portalView(handlers, await portalCookie('job-1'))).body.viewer.jobKey, one.jobKey);
});

test('crew closeout adds billed change orders to the balance exactly as the server bills them', () => {
  const html = readFileSync(new URL('../crew/postjob.html', import.meta.url), 'utf8'), context = vm.createContext({});
  vm.runInContext(portalScript(html, ['function billedChangeTotal(']), context);
  const line = (decisionId, cents, extra = {}) => ({ id: `change-${decisionId}`, kind: 'fee', source: 'customer_decision', decisionId, quantity: 1, unitCents: cents, totalCents: cents, amount: cents / 100, ...extra });
  const long = `decision-${'y'.repeat(70)}`;
  const jobs = [
    {}, { changeOrders: 'nope' }, { changeOrders: [line('a', 15000)] },
    { changeOrders: [line('a', 1000), line('a', 1000), line('b', 1000, { kind: 'service' }), line('c', 1000, { source: 'hub' }), line('d', 1000, { id: 'change-other' }), line('e', 10.5), line('f', -1000), line('g', 0), line('h', 100000001), line('i', '1000'), { ...line('j', 1000), decisionId: '' }, null, 'x', line('k', 2500)] },
    { changeOrders: [line('v', 5000, { status: 'void' }), line('w', 7000, { voidedAt: NOW }), line('z', 1234)] },
    { changeOrders: [{ ...line('ignored', 4200), id: changeOrderLineId(long), decisionId: long }] },
  ];
  for (const current of jobs) assert.equal(Math.round(context.billedChangeTotal(current) * 100), billedChangeCents(current), JSON.stringify(current).slice(0, 80));
  assert.equal(context.billedChangeTotal({ changeOrders: [line('a', 15000)] }), 150);
});

test('crew closeout still offers the card payment for a billed change after the quote balance was collected', async () => {
  const html = readFileSync(new URL('../crew/postjob.html', import.meta.url), 'utf8'), elements = new Map();
  const node = id => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '', className: '' }); return elements.get(id); };
  const saved = { ...job(), ...respondToDecision(job(), input(), { billing: true, now: NOW }).patch, payment: { ...job().payment, amount: 1000 } };
  const context = vm.createContext({
    CENTRAL_JOB_ID: 'job-1', ACTIVE: {}, restoreAll() {}, saveAll() {}, restoreSharedProgress() {}, normalizedInstructions: () => [],
    HUBDB: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, id: 'job-1', data: () => structuredClone(saved) }) }) }) },
    document: { getElementById: node, querySelector: selector => selector === '#stripe_pay button' ? node('stripe-button') : null },
  });
  vm.runInContext(portalScript(html, ['function stripeStatus(', 'function updateStripePanel(', 'function billedChangeTotal(', 'async function loadCentralJob(']), context);
  await context.loadCentralJob();
  context.updateStripePanel();
  assert.deepEqual([context.ACTIVE.total, context.ACTIVE.paidToDate], [1150, 1000]);
  assert.deepEqual([node('stripe-button').disabled, node('stripe-button').textContent], [false, 'Take card payment']);
  assert.equal(node('stripe_status').textContent, '$150.00 outstanding · customer enters their card on Stripe.');
  assert.deepEqual([node('j_payment_amount').value, node('payment_hint').textContent], ['150', '$1,000.00 already recorded · $150.00 remaining']);
});

// ---- Second review: answers a stale Hub write reverted, closed stages, expiry, voided coverage, overpaid invoices, stale checkouts.

// The job after the customer approved the +$150 freezer change (billed), then a
// Hub decision write built from the list read before that answer turned it back
// into a pending question and dropped its request id and line link.
const reverted = (extra = {}) => {
  const current = job(), approved = { ...current, ...respondToDecision(current, input(), { billing: true, now: NOW }).patch };
  return { ...approved, customerDecisions: [decision(), decision({ id: 'decision-paint', title: 'Paint the trim', priceDelta: 0 })], ...extra };
};

test('a pending decision that already has a saved line cannot be declined or approved again, billing on or off, and money stays unchanged', () => {
  const current = reverted();
  assert.equal(changeOrderSaved(current.changeOrders, 'decision-freezer'), true); assert.equal(changeOrderSaved(current.changeOrders, 'decision-paint'), false);
  assert.equal(changeOrderSaved(current.changeOrders, undefined), false); assert.equal(changeOrderSaved('nope', 'decision-freezer'), false);
  assert.deepEqual(customerMoneyState(current), { total: 1150, paid: 500, balance: 650 });
  for (const billing of [true, false]) {
    for (const answer of [input({ response: 'declined', priceDeltaCents: null }), input(), input({ requestId: '' }), input({ response: 'declined', requestId: '', priceDeltaCents: null })]) {
      assert.throws(() => respondToDecision(current, answer, { billing, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_AMBIGUOUS', status: 409, message: /quick review by our team before it can be answered/ }, JSON.stringify([billing, answer.response, answer.requestId]));
    }
  }
  // A voided line covers its decision too: the team decides, never a second portal answer.
  const voided = { ...current, ...voidChangeOrder(current, 'change-decision-freezer', { reason: 'Synthetic: not done', by: 'zacb', now: NOW }).patch, customerDecisions: current.customerDecisions };
  assert.throws(() => respondToDecision(voided, input({ response: 'declined', priceDeltaCents: null }), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_AMBIGUOUS' });
  // The other question on the job is answered as usual, and the billed line stays billed exactly once.
  const other = respondToDecision(current, input({ decisionId: 'decision-paint', priceDeltaCents: 0 }), { billing: true, now: NOW }), saved = { ...current, ...other.patch };
  assert.equal(other.decision.status, 'approved'); assert.equal(other.patch.changeOrders, undefined);
  assert.equal(saved.approvedChangeTotal, 150);
  assert.deepEqual(customerMoneyState(saved), { total: 1150, paid: 500, balance: 650 });
  assert.deepEqual([customerMoneyTotals(saved).totalCents, customerMoneyTotals(saved).issues], [115000, []]);
});

test('portal: a billed change a stale Hub write reverted shows as approved and cannot be declined, so the customer is never charged for a declined change', async t => {
  const f = portalStore(t, { 'job-1': job() }), handlers = portalHandlers(), cookie = await portalCookie();
  const approved = await portalPost(handlers, cookie, answer(), billing);
  assert.equal(approved.status, 200);
  const line = f.job('job-1').changeOrders[0];
  // The Hub sends another question from the list it read before the approval.
  f.edit('job-1', { customerDecisions: [decision(), decision({ id: 'decision-paint', title: 'Paint the trim', priceDelta: 0, promptedAt: '2026-09-22T17:00:00.000Z' })] });
  const before = f.job('job-1'), writes = f.writes.length;
  for (const testEnv of [billing, env]) {
    const view = (await portalView(handlers, cookie, testEnv)).body;
    const freezer = view.experience.decisions.find(item => item.id === 'decision-freezer');
    assert.deepEqual([freezer.status, freezer.billed, freezer.closed, freezer.respondedAt, freezer.responseBy], ['approved', true, false, line.approvedAt, 'Synthetic Customer'], 'shown as the approval its line records, with no Approve or Decline');
    assert.equal(freezer.closedReason, undefined);
    assert.deepEqual(money(view), [1150, 500, 650, 150]);
    for (const body of [answer({ response: 'declined', price_delta_cents: undefined }), answer({ response: 'declined', request_id: undefined, price_delta_cents: undefined }), answer()]) {
      const refused = await portalPost(handlers, cookie, body, testEnv);
      assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CUSTOMER_PORTAL_DECISION_AMBIGUOUS'); assert.match(refused.body.error, /call or text us/);
    }
  }
  assert.equal(f.writes.length, writes, 'nothing was written');
  assert.deepEqual(f.job('job-1'), before);
  assert.deepEqual(customerMoneyState(f.job('job-1')), { total: 1150, paid: 500, balance: 650 });
  assert.deepEqual([customerMoneyTotals(f.job('job-1')).totalCents, customerMoneyTotals(f.job('job-1')).issues], [115000, []]);
  // The new question is answered normally.
  const paint = await portalPost(handlers, cookie, answer({ decision_id: 'decision-paint', price_delta_cents: 0 }), billing);
  assert.equal(paint.status, 200); assert.deepEqual([paint.body.decision.status, paint.body.billed, paint.body.approvedChangeTotal], ['approved', false, 150]);
});

test('the Hub adds a crew question to the decisions saved now, so a portal answer saved while its dialog was open is kept', async () => {
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), clock = Date.parse('2026-09-22T18:30:00.000Z');
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  // The Hub list still shows the freezer question pending; the customer approved it meanwhile (billed).
  const stale = job(), approved = { ...stale, ...respondToDecision(stale, input(), { billing: true, now: NOW }).patch };
  const ref = { path: 'jobs/job-1' }, writes = [], synced = [], toasts = [];
  let stored = structuredClone(approved), fail = false;
  const db = {
    collection: name => ({ doc: id => { assert.deepEqual([name, id], ['jobs', 'job-1']); return ref; } }),
    async runTransaction(work) {
      if (fail) throw new Error('synthetic transaction failure');
      const pending = [], result = await work({ get: async target => { assert.equal(target, ref); return { exists: true, data: () => structuredClone(stored) }; }, update: (target, patch) => { assert.equal(target, ref); pending.push(structuredClone(patch)); } });
      for (const patch of pending) { stored = { ...stored, ...patch }; writes.push(patch); }
      return result;
    },
  };
  const context = vm.createContext({
    Date: FixedDate, window: {}, db, jobsCache: [{ id: 'job-1', ...structuredClone(stale) }],
    askAction: async () => ({ title: 'Move the shelving?', details: 'Synthetic crew note.', priceDelta: '40', timeDeltaMinutes: '10', photoUrl: '' }),
    employeeIdentity: () => 'synthetic.manager', render: () => {}, showToast: message => toasts.push(message),
    syncCustomerCommunication: async (row, event, id) => { synced.push(JSON.parse(JSON.stringify([row.customerDecisions.map(item => [item.id, item.status]), event, id]))); return true; },
  });
  context.jobs = () => context.jobsCache;
  vm.runInContext(portalScript(suite, ['async function appendCustomerDecision(', 'window.opsSendCustomerDecision=']), context);
  await context.window.opsSendCustomerDecision('job-1');
  const id = `decision-${clock.toString(36)}`;
  assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0]).sort(), ['customerDecisionUpdatedAt', 'customerDecisions', 'updatedAt']);
  assert.deepEqual(stored.customerDecisions.map(item => [item.id, item.status]), [['decision-freezer', 'approved'], [id, 'pending']]);
  assert.deepEqual(stored.customerDecisions[0], approved.customerDecisions[0], 'the answer, its request id and its line link are kept');
  assert.deepEqual([stored.customerDecisions[1].promptedAt, stored.customerDecisions[1].priceDelta, stored.customerDecisions[1].promptedBy, stored.customerDecisionUpdatedAt], ['2026-09-22T18:30:00.000Z', 40, 'synthetic.manager', '2026-09-22T18:30:00.000Z']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.jobsCache[0].customerDecisions)), stored.customerDecisions, 'the Hub list shows what was saved');
  assert.deepEqual(synced, [[[['decision-freezer', 'approved'], [id, 'pending']], 'decision-needed', id]]);
  assert.deepEqual(toasts, ['Decision sent through the customer workflow']);
  assert.deepEqual([customerMoneyState(stored), customerMoneyTotals(stored).totalCents], [{ total: 1150, paid: 500, balance: 650 }, 115000]);
  // A failed transaction sends nothing and says so.
  fail = true;
  await context.window.opsSendCustomerDecision('job-1');
  assert.equal(writes.length, 1); assert.equal(synced.length, 1);
  assert.equal(toasts.at(-1), 'The decision was not sent. Refresh the job and try again.');
});

test('no-show, declined and other closed jobs never bill a late approval, and the portal shows the question as closed', async t => {
  assert.deepEqual([...CLOSED_STAGES].sort(), ['canceled', 'cancelled', 'declined', 'lost', 'no-show', 'no_show', 'noshow', 'superseded']);
  for (const stage of CLOSED_STAGES) {
    for (const extra of [{ status: stage }, { pipelineStatus: stage }]) {
      const current = job(extra);
      assert.equal(jobClosed(current), true, stage); assert.equal(approvalClosed(current, decision(), NOW), 'closed', stage);
      assert.throws(() => respondToDecision(current, input(), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_JOB_CLOSED', status: 409, message: /This job is closed/ }, JSON.stringify(extra));
      // Declining is recorded without money; without billing the approval is saved unbilled, as today.
      assert.equal(respondToDecision(current, input({ response: 'declined', priceDeltaCents: null }), { billing: true, now: NOW }).patch.changeOrders, undefined);
      assert.equal(respondToDecision(current, { ...input(), requestId: '', priceDeltaCents: null }, { now: NOW }).billedCents, 0);
    }
  }
  assert.equal(jobClosed(job()), false); assert.equal(approvalClosed(job(), decision(), NOW), '');
  const f = portalStore(t, { 'job-1': job({ status: 'no_show' }), 'job-2': job({ pipelineStatus: 'cancelled' }) }), handlers = portalHandlers();
  for (const id of ['job-1', 'job-2']) {
    const cookie = await portalCookie(id), [shown] = (await portalView(handlers, cookie, billing)).body.experience.decisions;
    assert.deepEqual([shown.status, shown.closed, shown.closedReason], ['pending', true, 'closed'], id);
    const refused = await portalPost(handlers, cookie, answer(), billing);
    assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CUSTOMER_PORTAL_JOB_CLOSED');
    // Without billing the page offers the question exactly as today.
    const [legacy] = (await portalView(handlers, cookie)).body.experience.decisions;
    assert.deepEqual([legacy.closed, legacy.closedReason], [false, undefined], id);
  }
  assert.equal(f.writes.length, 0);
});

test(`a priced question can be approved for billing for ${DECISION_APPROVAL_DAYS} days after it was sent`, async t => {
  const day = 86400000, asked = at => decision({ promptedAt: new Date(Date.parse(NOW) - at).toISOString() });
  assert.equal(DECISION_APPROVAL_DAYS, 14);
  const fresh = job({ customerDecisions: [asked(14 * day)] }), old = job({ customerDecisions: [asked(14 * day + 1000)] });
  assert.equal(approvalClosed(fresh, fresh.customerDecisions[0], NOW), '');
  assert.equal(respondToDecision(fresh, input(), { billing: true, now: NOW }).billedCents, 15000);
  assert.equal(approvalClosed(old, old.customerDecisions[0], NOW), 'expired');
  assert.throws(() => respondToDecision(old, input(), { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_EXPIRED', status: 409, message: /more than 14 days ago.*call or text us/ });
  // Declining it, approving it without a price, or approving it without billing is recorded as today.
  assert.equal(respondToDecision(old, input({ response: 'declined', priceDeltaCents: null }), { billing: true, now: NOW }).decision.status, 'declined');
  assert.equal(respondToDecision(job({ customerDecisions: [{ ...asked(30 * day), priceDelta: 0 }] }), input({ priceDeltaCents: 0 }), { billing: true, now: NOW }).decision.status, 'approved');
  assert.equal(respondToDecision(old, { ...input(), requestId: '', priceDeltaCents: null }, { now: NOW }).billedCents, 0);
  // A question without a readable send time has no age limit (the Hub always records one).
  for (const promptedAt of [undefined, '', 'yesterday']) assert.equal(respondToDecision(job({ customerDecisions: [decision({ promptedAt })] }), input(), { billing: true, now: NOW }).billedCents, 15000, String(promptedAt));
  // The portal marks the old question closed (billing on) and refuses its approval; the clock is the handler's.
  const f = portalStore(t, { 'job-1': old }), cookie = await portalCookie();
  const [shown] = (await portalView(portalHandlers(), cookie, billing)).body.experience.decisions;
  assert.deepEqual([shown.closed, shown.closedReason], [true, 'expired']);
  const [earlier] = (await portalView(portalHandlers('2026-09-08T17:00:00.000Z'), cookie, billing)).body.experience.decisions;
  assert.deepEqual([earlier.closed, earlier.closedReason], [false, undefined], 'the same question was still open two weeks earlier');
  const refused = await portalPost(portalHandlers(), cookie, answer(), billing);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CUSTOMER_PORTAL_DECISION_EXPIRED'); assert.equal(f.writes.length, 0);
});

test('a voided change stays out of approvedChangeTotal and money-core even after a stale write drops its void marker', async t => {
  const current = job({ customerDecisions: [decision(), decision({ id: 'decision-paint', title: 'Paint the trim', priceDelta: 40, promptedAt: '2026-09-22T17:00:00.000Z' })] });
  const approved = { ...current, ...respondToDecision(current, input(), { billing: true, now: NOW }).patch };
  const voided = { ...approved, ...voidChangeOrder(approved, 'change-decision-freezer', { reason: 'Synthetic: not done', by: 'zacb', now: NOW }).patch };
  assert.deepEqual([voided.approvedChangeTotal, billedChangeCents(voided), customerMoneyTotals(voided).totalCents], [0, 0, 100000]);
  // A Hub write from the list read before the void drops changeOrderVoidedAt (the decision is still approved).
  const stale = { ...voided, customerDecisions: approved.customerDecisions };
  assert.equal(stale.customerDecisions[0].changeOrderVoidedAt, undefined);
  assert.equal(approvedChangeTotal(stale.customerDecisions, billedChangeOrders(stale), stale.changeOrders), 0, 'the voided line still covers its decision');
  const issues = [], { approvedChangeTotal: _, ...derivedOnly } = stale;
  assert.equal(approvedChangeCents(stale, issues), 0); assert.deepEqual(issues, [], 'no conflict: the voided change is not derived back');
  assert.equal(approvedChangeCents(derivedOnly), 0);
  assert.deepEqual(invoiceLineItems(stale).lineItems.map(line => line.id), ['legacy-1']);
  // The next portal answer on the other question recomputes the total without the voided change.
  const f = portalStore(t, { 'job-1': stale }), handlers = portalHandlers(), cookie = await portalCookie();
  const paint = await portalPost(handlers, cookie, answer({ decision_id: 'decision-paint', price_delta_cents: 4000 }), billing);
  assert.equal(paint.status, 200); assert.equal(paint.body.approvedChangeTotal, 40);
  const saved = f.job('job-1');
  assert.deepEqual([saved.approvedChangeTotal, billedChangeCents(saved)], [40, 4000]);
  assert.deepEqual(customerMoneyState(saved), { total: 1040, paid: 500, balance: 540 });
  assert.deepEqual([customerMoneyTotals(saved).totalCents, customerMoneyTotals(saved).approvedChangeCents, customerMoneyTotals(saved).issues], [104000, 4000, []], 'the portal and money-core agree');
  assert.deepEqual(invoiceLineItems(saved).lineItems.map(line => [line.id, line.totalCents]), [['legacy-1', 100000], ['change-decision-paint', 4000]]);
  // Without billing, an approval no line covers still counts at its shown price, as today.
  const legacy = { ...stale, ...respondToDecision(stale, { ...input({ decisionId: 'decision-paint' }), requestId: '', priceDeltaCents: null }, { now: NOW }).patch };
  assert.deepEqual([legacy.approvedChangeTotal, approvedChangeCents(legacy), customerMoneyState(legacy).total], [40, 4000, 1000]);
});

test('money-core counts billed lines once and derives the same total the portal saves', () => {
  const current = job({ customerDecisions: [decision(), decision({ id: 'decision-paint', title: 'Paint the trim', priceDelta: 40 })] });
  const billed = { ...current, ...respondToDecision(current, input(), { billing: true, now: NOW }).patch };
  // A pre-billing approval of the other question, saved without a line.
  const mixed = { ...billed, customerDecisions: billed.customerDecisions.map(item => item.id === 'decision-paint' ? { ...item, status: 'approved' } : item), approvedChangeTotal: 190 };
  const issues = [], { approvedChangeTotal: _, ...derivedOnly } = mixed;
  assert.equal(approvedChangeCents(mixed, issues), 19000); assert.deepEqual(issues, []);
  assert.equal(approvedChangeCents(derivedOnly), 19000);
  assert.deepEqual(invoiceLineItems(mixed).lineItems.map(line => [line.id, line.name, line.totalCents]), [['legacy-1', 'Garage Turnaround', 100000], ['change-decision-freezer', 'Approved change: Haul the old freezer', 15000], ['change-decision-paint', 'Approved change: Paint the trim', 4000]]);
  // A line whose decision was reverted to pending (or trimmed away) is still billed and itemized.
  const revertedJob = reverted();
  assert.deepEqual([approvedChangeCents(revertedJob), invoiceLineItems(revertedJob).lineItems.map(line => line.id)], [15000, ['legacy-1', 'change-decision-freezer']]);
  const conflict = [];
  assert.equal(approvedChangeCents({ ...mixed, approvedChangeTotal: 150 }, conflict), 15000); assert.deepEqual(conflict, ['money_change_order_conflict']);
});

test('a legacy change total whose decision a stale write turned back into a question is flagged for review, never billed silently', () => {
  // Approved for +$150 before billing (no line), then an old Hub write turned the answer back into a question.
  const legacy = job({ approvedChangeTotal: 150 });
  assert.equal(legacy.customerDecisions[0].status, 'pending');
  const totals = customerMoneyTotals(legacy);
  assert.deepEqual([totals.approvedChangeCents, totals.totalCents, totals.complete, totals.issues], [15000, 115000, false, ['money_change_order_conflict']]);
  assert.deepEqual(invoiceFromEstimate({ ...legacy, id: 'job-1' }, { now: NOW }).issues, ['money_change_order_conflict'], 'issuing an invoice warns the team');
  assert.deepEqual(moneyProjection({ ...legacy, id: 'job-1', revision: 'r1' }, NOW).totals.issues, ['money_change_order_conflict'], 'the Hub money view reports it');
  const bare = [];
  assert.equal(approvedChangeCents({ ...legacy, customerDecisions: [] }, bare), 15000); assert.deepEqual(bare, ['money_change_order_conflict'], 'a saved total with nothing behind it is flagged too');
  // Totals that match what the decisions and lines say raise nothing.
  for (const current of [job(), job({ approvedChangeTotal: 0 }), job({ customerDecisions: [decision({ status: 'declined' })], approvedChangeTotal: 0 }), job({ customerDecisions: [decision({ status: 'approved' })], approvedChangeTotal: 150 })]) {
    assert.deepEqual(customerMoneyTotals(current).issues, [], JSON.stringify(current.customerDecisions));
  }
  // The customer's answer recomputes the total, which ends the conflict.
  const declined = { ...legacy, ...respondToDecision(legacy, input({ response: 'declined', priceDeltaCents: null }), { billing: true, now: NOW }).patch };
  assert.deepEqual([declined.approvedChangeTotal, customerMoneyTotals(declined).totalCents, customerMoneyTotals(declined).issues], [0, 100000, []]);
});

test('an overpaid invoice absorbs an approved change: it stays paid with nothing owed, as the portal says', async t => {
  const line = { id: 'change-decision-freezer', kind: 'fee', name: 'Approved change: Haul the old freezer', description: '', totalCents: 15000, amount: 150 };
  assert.deepEqual(raisedInvoice({ status: 'paid', amount: 1000, paid: 1150, balance: 0 }, line, NOW), { status: 'paid', amount: 1150, paid: 1150, balance: 0, updatedAt: NOW });
  assert.deepEqual(raisedInvoice({ status: 'paid', amount: 1000, amountCents: 100000, paid: 1100, balance: 0, balanceCents: 0 }, line, NOW), { status: 'partial', amount: 1150, amountCents: 115000, paid: 1100, paidCents: 110000, balance: 50, balanceCents: 5000, updatedAt: NOW });
  assert.deepEqual(raisedInvoice({ status: 'partial', amount: 1000, balance: 0 }, line, NOW, 120000), { status: 'pending_verification', amount: 1150, paid: 1200, balance: 0, updatedAt: NOW }, 'the job paid total when the invoice has none; it covers the raise, so the invoice awaits verification');
  assert.deepEqual(raisedInvoice({ status: 'partial', amount: 1000, balance: 0 }, line, NOW, 120000, true), { status: 'paid', amount: 1150, paid: 1200, balance: 0, updatedAt: NOW }, 'a verified payment that covers the raise marks it paid');
  const overpaid = job({ payment: { ...job().payment, amount: 1150 }, invoice: { number: 'INV-000001', status: 'paid', amount: 1000, paid: 1150, balance: 0 } });
  const f = portalStore(t, { 'job-1': overpaid }), cookie = await portalCookie();
  assert.equal((await portalPost(portalHandlers(), cookie, answer(), billing)).status, 200);
  const saved = f.job('job-1');
  assert.deepEqual([saved.invoice.status, saved.invoice.amount, saved.invoice.balance], ['paid', 1150, 0]);
  assert.deepEqual(customerMoneyState(saved), { total: 1150, paid: 1150, balance: 0 });
  assert.equal(customerMoneyTotals(saved).balanceCents, 0);
});

test('an approval the recorded payments already cover settles the invoice: paid when the payment is verified, else pending verification', async t => {
  const line = { id: 'change-decision-freezer', kind: 'fee', name: 'Approved change: Haul the old freezer', description: '', totalCents: 15000, amount: 150 };
  // $1,200 is recorded, but INV-000001 was issued when $500 was paid: the +$150 change leaves nothing owed.
  const invoice = { number: 'INV-000001', status: 'partial', amount: 1000, paid: 500, balance: 500 };
  const covered = job({ payment: { ...job().payment, amount: 1200 }, invoice });
  const f = portalStore(t, { 'job-1': covered }), cookie = await portalCookie();
  assert.equal((await portalPost(portalHandlers(), cookie, answer(), billing)).status, 200);
  const saved = f.job('job-1');
  assert.deepEqual(saved.invoice, { ...invoice, status: 'paid', amount: 1150, paid: 1200, balance: 0, updatedAt: NOW });
  assert.deepEqual([customerMoneyTotals(saved).balanceCents, invoiceStatus(saved, NOW), customerMoneyState(saved).balance], [0, 'paid', 0], 'the saved status is the one money-core, documents and the checkout read');
  // A payment still awaiting verification leaves the settled invoice pending verification, as change_order.void does.
  const unverified = job({ payment: { amount: 1200, verified: false }, invoice });
  const plan = respondToDecision(unverified, input(), { billing: true, now: NOW, paidCents: customerMoneyTotals(unverified).appliedCents });
  assert.deepEqual([plan.patch.invoice.status, plan.patch.invoice.paid, plan.patch.invoice.balance], ['pending_verification', 1200, 0]);
  assert.equal(invoiceStatus({ ...unverified, ...plan.patch }, NOW), 'pending_verification');
  for (const status of ['issued', 'partial', 'overdue']) {
    assert.equal(raisedInvoice({ ...invoice, status }, line, NOW, 120000, true).status, 'paid', status);
    assert.equal(raisedInvoice({ ...invoice, status }, line, NOW, 120000).status, 'pending_verification', status);
    assert.equal(raisedInvoice({ ...invoice, status }, line, NOW, 100000, true).status, status, `${status} with $150 still owed`);
  }
  assert.equal(raisedInvoice({ ...invoice, status: 'paid' }, line, NOW, 120000, true).status, 'paid');
  assert.equal(raisedInvoice({ ...invoice, status: 'pending_verification' }, line, NOW, 120000, true).status, 'pending_verification', 'one awaiting verification keeps its status');
});

test('unreadable payments never become a paid figure on a raised invoice: money-core still flags money_paid_invalid after the approval', async t => {
  // No payment total is recorded, and the fallback money-core reads instead is not dollars and cents.
  const legacy = { number: 'INV-000001', status: 'issued', amount: 1000, balance: 1000 };
  const jobs = {
    'job-1': job({ payment: { verified: false }, invoice: { ...legacy, amountPaid: '$500 by check' } }),
    'job-2': job({ payment: { verified: false }, deposit: { amount: 500, paidAmount: 'five hundred', status: 'paid' }, invoice: legacy }),
  };
  const f = portalStore(t, jobs), handlers = portalHandlers();
  for (const [id, current] of Object.entries(jobs)) {
    const before = customerMoneyTotals(current);
    assert.deepEqual([before.paidCents, before.appliedCents, before.issues.includes('money_paid_invalid')], [null, null, true], id);
    assert.equal((await portalPost(handlers, await portalCookie(id), answer(), billing)).status, 200, id);
    const saved = f.job(id), after = customerMoneyTotals(saved);
    // The invoice keeps no paid figure, and its balance rises by exactly the change.
    assert.deepEqual(saved.invoice, { ...current.invoice, amount: 1150, balance: 1150, updatedAt: NOW }, id);
    assert.equal(Object.hasOwn(saved.invoice, 'paid'), false, id);
    assert.deepEqual([after.paidCents, after.appliedCents, after.balanceCents, after.issues.includes('money_paid_invalid')], [null, null, null, true], id);
    assert.ok(moneyProjection({ ...saved, id, revision: 'r1' }, NOW).totals.issues.includes('money_paid_invalid'), `${id}: the Hub money view still asks for review`);
  }
  const line = { id: 'change-decision-freezer', kind: 'fee', name: 'Approved change: Haul the old freezer', description: '', totalCents: 15000, amount: 150 };
  assert.deepEqual(raisedInvoice({ status: 'partial', amount: 1000, amountCents: 100000, paid: 'n/a', balance: 500, balanceCents: 50000 }, line, NOW, null), { status: 'partial', amount: 1150, amountCents: 115000, paid: 'n/a', balance: 650, balanceCents: 65000, updatedAt: NOW }, 'an unreadable paid figure is kept as it is, never replaced');
  assert.deepEqual(raisedInvoice({ status: 'paid', amount: 1000, balance: 0 }, line, NOW, null), { status: 'partial', amount: 1150, balance: 150, updatedAt: NOW }, 'a paid invoice whose payments cannot be read reopens by exactly the change');
  const unreadable = job({ payment: { verified: false }, invoice: { ...legacy, paid: 'n/a', balance: 500 } });
  const raised = { ...unreadable, ...respondToDecision(unreadable, input(), { billing: true, now: NOW, paidCents: customerMoneyTotals(unreadable).appliedCents }).patch };
  assert.deepEqual([raised.invoice.paid, raised.invoice.balance, customerMoneyTotals(raised).issues.includes('money_paid_invalid')], ['n/a', 650, true]);
});

test('a void closes a portal checkout sized to the old balance, so the customer cannot pay the voided change', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const secret = 'sk_test_synthetic_change_orders', stripeEnv = { ...billing, STRIPE_SECRET_KEY: secret };
  const f = paymentStore(t, { 'job-1': job({ postJobProgress: { standardItems: [{ key: '0_1', completed: true }] } }) }), handlers = portalHandlers(), cookie = await portalCookie();
  assert.equal(await expireStaleCustomerCheckout(stripeEnv, secret, 'job-1'), 'none', 'no checkout was ever opened');
  assert.equal((await portalPost(handlers, cookie, answer(), stripeEnv)).status, 200);
  const paying = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'synthetic-pay-1' }, stripeEnv);
  assert.equal(paying.body.amount, 650);
  assert.equal(await expireStaleCustomerCheckout(stripeEnv, secret, 'job-1'), 'current', 'a checkout that still charges what is due stays open');
  assert.deepEqual(f.expired, []);
  // A manager voids the change (the money-service patch, applied as its commit would).
  f.edit('job-1', voidChangeOrder(f.job('job-1'), 'change-decision-freezer', { reason: 'Synthetic: not done', by: 'zacb', now: NOW }).patch);
  assert.equal(await expireStaleCustomerCheckout(stripeEnv, secret, 'job-1'), 'expired');
  assert.deepEqual(f.expired, ['cs_test_change_1']);
  assert.equal(f.docs.get('customer_payment_checkouts/job-1').value.status, 'expired');
  assert.equal(await expireStaleCustomerCheckout(stripeEnv, secret, 'job-1'), 'none');
  // The next Pay charges the balance without the voided change.
  const again = await portalPost(handlers, cookie, { action: 'create_payment', request_id: 'synthetic-pay-2' }, stripeEnv);
  assert.equal(again.status, 200); assert.equal(again.body.amount, 500);
  assert.equal(f.created.at(-1).get('line_items[0][price_data][unit_amount]'), '50000');
  // A checkout the customer already completed is reported, never expired.
  f.edit('job-1', { payment: { ...f.job('job-1').payment, amount: 400 } });
  f.complete('cs_test_change_2');
  assert.equal(await expireStaleCustomerCheckout(stripeEnv, secret, 'job-1'), 'paid');
  assert.deepEqual(f.expired, ['cs_test_change_1']);
  // A deposit checkout survives a void: the change is due with the balance, so the deposit it charges is still exactly what is due.
  const deposit = paymentStore(t, { 'job-2': job({ deposit: { amount: 500, paidAmount: 0, status: 'due' }, payment: {}, status: 'scheduled' }) }), depositCookie = await portalCookie('job-2');
  assert.equal((await portalPost(handlers, depositCookie, answer(), stripeEnv)).status, 200);
  assert.equal((await portalPost(handlers, depositCookie, { action: 'create_payment', request_id: 'synthetic-pay-3' }, stripeEnv)).body.amount, 500);
  deposit.edit('job-2', voidChangeOrder(deposit.job('job-2'), 'change-decision-freezer', { reason: 'Synthetic: not done', by: 'zacb', now: NOW }).patch);
  assert.equal(await expireStaleCustomerCheckout(stripeEnv, secret, 'job-2'), 'current');
  assert.deepEqual(deposit.expired, []);
});
