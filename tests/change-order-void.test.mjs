import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { billedChangeCents, respondToDecision } from '../functions/_lib/change-orders.js';
import { customerDepositState, customerMoneyState } from '../functions/_lib/customer-payments.js';
import { customerMoneyTotals, invoiceLineItems } from '../functions/_lib/money-core.js';
import { MONEY_ACTIONS, moneyProjection, mutateMoney } from '../functions/_lib/money-service.js';
import { moneyHandlers } from '../functions/api/money.js';
import { env as portalEnv, portalCookie, portalHandlers, portalPost, portalStore } from './helpers/portal-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z', APPROVED = '2026-09-22T16:30:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const crew = { user: 'synthetic.crew', role: 'crew', businessAccess: false };
const decision = (extra = {}) => ({ id: 'decision-freezer', title: 'Haul the old freezer', details: 'Synthetic crew note.', priceDelta: 150, status: 'pending', promptedAt: '2026-09-22T16:00:00.000Z', ...extra });
const base = (extra = {}) => ({
  type: 'job', customerId: 'c1', customer: 'Synthetic Customer', serviceType: 'Garage Turnaround', date: '2026-09-22', total: 1000, status: 'in_progress', pipelineStatus: 'in_progress',
  estimate: { number: 'EST-ABC123', status: 'approved', amount: 1000, depositRequired: 500, revision: 2, scope: 'Synthetic scope', lineItems: [{ id: 'line-1', kind: 'service', name: 'Garage Turnaround', description: '', quantity: 1, unitCents: 100000 }] },
  customerApproval: { status: 'approved', approvedAt: '2026-09-20T16:00:00.000Z', approvedBy: 'Synthetic Customer', amount: 1000 },
  deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true },
  payment: { amount: 500, verified: true, method: 'deposit', reference: 'CHK-100', lastAmount: 500, lastReceivedAt: '2026-09-20T16:00:00.000Z', recordedBy: 'zacb' },
  customerDecisions: [decision()], ...extra,
});
// The job after the customer approved the +$150 change in the portal with billing on
// (the portal passes money-core's applied payments, customerMoneyTotals(job).appliedCents).
const billed = (extra = {}) => {
  const job = base(extra);
  return { ...job, ...respondToDecision(job, { decisionId: 'decision-freezer', response: 'approved', respondedBy: 'Synthetic Customer', note: '', requestId: randomUUID(), priceDeltaCents: 15000 }, { billing: true, now: APPROVED, paidCents: customerMoneyTotals(job).appliedCents }).patch };
};

function fixture(job) {
  const docs = new Map([['jobs/job-abc123', { ...structuredClone(job), id: 'job-abc123', revision: 'r0' }]]);
  let n = 0;
  const commits = [];
  const store = {
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
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
  const f = { docs, store, commits, job: () => docs.get('jobs/job-abc123'),
    input: fields => ({ action: 'change_order.void', requestId: randomUUID(), jobId: 'job-abc123', expectedRevision: docs.get('jobs/job-abc123').revision, changeOrderId: 'change-decision-freezer', reason: 'The crew left the freezer in place', ...fields }),
    run: (fields, actor = owner) => mutateMoney(store, actor, f.input(fields), NOW) };
  return f;
}
const audits = f => [...f.docs].filter(([key]) => key.startsWith('hub_audit/')).map(([, row]) => row);

test('change_order.void is a Hub money action for managers only', async () => {
  assert.ok(MONEY_ACTIONS.includes('change_order.void'));
  const f = fixture(billed());
  await assert.rejects(f.run({}, crew), error => error.code === 'money_forbidden' && error.status === 403);
  await assert.rejects(f.run({ reason: 'no' }), error => error.code === 'money_invalid_field');
  await assert.rejects(f.run({ changeOrderId: 'line-1' }), error => error.code === 'money_request_invalid');
  await assert.rejects(f.run({ changeOrderId: 'change-decision-paint' }), error => error.code === 'money_change_order_missing' && error.status === 409);
  await assert.rejects(f.run({ note: 'extra' }), error => error.code === 'money_request_invalid');
  assert.equal(f.commits.length, 0);
});

test('voiding a billed change drops it from every balance and lowers the issued invoice in one audited commit', async () => {
  const invoice = { number: 'INV-ABC123', status: 'partial', issuedAt: '2026-09-22T16:00:00.000Z', dueDate: '2026-09-29', amount: 1000, amountCents: 100000, paid: 500, paidCents: 50000, balance: 500, balanceCents: 50000, approvedChangeCents: 0,
    lineItems: [{ id: 'line-1', kind: 'service', name: 'Garage Turnaround', description: '', quantity: 1, unitCents: 100000, totalCents: 100000, amount: 1000 }] };
  const job = billed({ invoice }), f = fixture(job);
  assert.deepEqual([job.invoice.amount, job.invoice.balance, job.invoice.lineItems.length], [1150, 650, 2], 'the approval raised the invoice');
  assert.deepEqual(moneyProjection(f.job(), NOW).changeOrders, [{ id: 'change-decision-freezer', name: 'Approved change: Haul the old freezer', totalCents: 15000, approvedAt: APPROVED, approvedBy: 'Synthetic Customer', backfilled: false }]);
  const result = await f.run();
  assert.equal(result.ok, true); assert.deepEqual(result.warnings, []); assert.deepEqual(result.job.changeOrders, []);
  const saved = f.job(), [line] = saved.changeOrders;
  assert.deepEqual([line.status, line.voidedAt, line.voidedBy, line.voidReason, line.totalCents, line.approvedBy], ['void', NOW, 'zacb', 'The crew left the freezer in place', 15000, 'Synthetic Customer'], 'the line stays as evidence');
  assert.deepEqual([saved.customerDecisions[0].status, saved.customerDecisions[0].changeOrderVoidedAt, saved.customerDecisions[0].changeOrderVoidedBy], ['approved', NOW, 'zacb'], 'the customer answer is kept');
  assert.equal(saved.approvedChangeTotal, 0); assert.equal(billedChangeCents(saved), 0);
  // The portal, the checkout and money-core agree on the quote alone again.
  assert.deepEqual(customerMoneyState(saved), { total: 1000, paid: 500, balance: 500 });
  assert.equal(customerDepositState(saved).remainder, 500);
  const totals = customerMoneyTotals(saved);
  assert.deepEqual([totals.totalCents, totals.approvedChangeCents, totals.balanceCents, totals.issues], [100000, 0, 50000, []]);
  assert.deepEqual(invoiceLineItems(saved).lineItems.map(item => item.id), ['line-1']);
  assert.deepEqual(saved.invoice, { ...invoice, updatedAt: NOW });
  // One commit: the job (revision-checked), the receipt and the audit entry with the change before and after.
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.commits[0].map(write => [write.collection, write.revision]), [['jobs', 'r0'], ['moneyOperations', undefined], ['hub_audit', undefined]]);
  assert.deepEqual(Object.keys(f.commits[0][0].patch).sort(), ['approvedChangeTotal', 'changeOrders', 'customerDecisions', 'invoice', 'moneyRequestId', 'moneyUpdatedAt', 'updatedAt']);
  const [audit] = audits(f);
  assert.equal(audit.action, 'money.change_order.void'); assert.match(audit.reason, /^\$150\.00 Approved change: Haul the old freezer: The crew left the freezer in place$/);
  assert.deepEqual([JSON.parse(audit.before).approvedChangeTotal, JSON.parse(audit.after).approvedChangeTotal, JSON.parse(audit.after).changeOrders[0].status], [150, 0, 'void']);
  // It cannot be voided twice, and re-approving the decision in the portal goes to the team.
  await assert.rejects(f.run(), error => error.code === 'money_change_order_missing');
  assert.throws(() => respondToDecision({ ...saved, customerDecisions: [{ ...saved.customerDecisions[0], status: 'pending' }] }, { decisionId: 'decision-freezer', response: 'approved', respondedBy: 'Synthetic Customer', note: '', requestId: randomUUID(), priceDeltaCents: 15000 }, { billing: true, now: NOW }), { code: 'CUSTOMER_PORTAL_DECISION_AMBIGUOUS' });
});

test('voiding a change that settles the balance marks the invoice paid; a change already paid keeps the payment and warns', async () => {
  const settle = fixture(billed({ payment: { ...base().payment, amount: 1000, lastAmount: 500 }, invoice: { number: 'INV-ABC123', status: 'partial', amount: 1000, paid: 1000, balance: 0 } }));
  assert.equal(settle.job().invoice.balance, 150);
  const settled = await settle.run();
  assert.deepEqual([settle.job().invoice.status, settle.job().invoice.amount, settle.job().invoice.balance], ['paid', 1000, 0]); assert.deepEqual(settled.warnings, []);
  const paid = fixture(billed({ payment: { ...base().payment, amount: 1150, lastAmount: 650 }, invoice: { number: 'INV-ABC123', status: 'paid', amount: 1000, paid: 1150, balance: 0 } }));
  const result = await paid.run();
  assert.deepEqual(result.warnings.map(warning => warning.code), ['payments_exceed_total']); assert.match(result.warnings[0].message, /\$150\.00 more than the new total/);
  assert.deepEqual([paid.job().payment.amount, paid.job().invoice.status, paid.job().invoice.amount, paid.job().invoice.balance], [1150, 'paid', 1000, 0]);
});

test('a stale invoice paid figure follows the recorded payments through the approval and the void', async () => {
  // $1,000 is recorded (the second $500 offline, after INV-ABC123 was issued), but the invoice still says $500 paid.
  const invoice = { number: 'INV-ABC123', status: 'partial', issuedAt: '2026-09-21T17:00:00.000Z', dueDate: '2026-09-29', amount: 1000, amountCents: 100000, paid: 500, paidCents: 50000, balance: 500, balanceCents: 50000 };
  const figures = row => [row.amount, row.amountCents, row.paid, row.paidCents, row.balance, row.balanceCents, row.status];
  const payment = { ...base().payment, amount: 1000 }, raised = billed({ payment, invoice });
  assert.deepEqual(figures(raised.invoice), [1150, 115000, 1000, 100000, 150, 15000, 'partial'], 'the approval raised it from the recorded payments, as the portal reads them');
  const f = fixture(raised);
  assert.deepEqual((await f.run()).warnings, []);
  assert.deepEqual(figures(f.job().invoice), [1000, 100000, 1000, 100000, 0, 0, 'paid']);
  assert.deepEqual([customerMoneyState(f.job()).balance, customerMoneyTotals(f.job()).balanceCents], [0, 0]);
  // An invoice issued with the change that went stale afterwards is brought to the recorded payments by the void too.
  const g = fixture({ ...billed({ payment }), invoice: { ...invoice, amount: 1150, amountCents: 115000, balance: 650, balanceCents: 65000 } });
  assert.deepEqual((await g.run()).warnings, []);
  assert.deepEqual(figures(g.job().invoice), [1000, 100000, 1000, 100000, 0, 0, 'paid']);
  // A legacy invoice without a paid figure does not gain one.
  const h = fixture({ ...billed({ payment }), invoice: { number: 'INV-ABC123', status: 'issued', amount: 1150, balance: 150 } });
  await h.run();
  assert.deepEqual(h.job().invoice, { number: 'INV-ABC123', status: 'paid', amount: 1000, balance: 0, updatedAt: NOW });
});

test('the portal approval and the Hub void save the same paid figure: money-core applied payments, tips excluded', async t => {
  // $550 is recorded: the $500 deposit and a $50 card tip, which never counts toward the balance.
  const payment = { amount: 550, verified: true, method: 'stripe', processor: 'stripe', stripeSessions: [
    { sessionId: 'cs_test_synthetic_deposit', paymentIntentId: 'pi_synthetic_deposit', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-20T16:05:00.000Z' },
    { sessionId: 'cs_test_synthetic_tip', paymentIntentId: 'pi_synthetic_tip', amount: 50, purpose: 'tip', verifiedAt: '2026-09-21T16:05:00.000Z' },
  ] };
  const issued = { number: 'INV-ABC123', status: 'partial', issuedAt: '2026-09-21T17:00:00.000Z', dueDate: '2026-09-29', amount: 1000, amountCents: 100000, paid: 500, paidCents: 50000, balance: 500, balanceCents: 50000 };
  const jobs = { 'job-1': base({ payment, invoice: issued }), 'job-2': base({ payment, invoice: { number: 'INV-ABC123', status: 'issued', amount: 1000, balance: 500 } }) };
  assert.deepEqual([customerMoneyTotals(jobs['job-1']).paidCents, customerMoneyTotals(jobs['job-1']).tipCents, customerMoneyTotals(jobs['job-1']).appliedCents], [55000, 5000, 50000]);
  const portal = portalStore(t, jobs), handlers = portalHandlers(), on = { ...portalEnv, CHANGE_ORDER_BILLING_ENABLED: 'true', MONEY_API_ENABLED: 'true' };
  const figures = row => [row.amount, row.paid, row.balance];
  for (const id of Object.keys(jobs)) {
    const body = { action: 'respond_decision', decision_id: 'decision-freezer', response: 'approved', responded_by: 'Synthetic Customer', note: '', request_id: randomUUID(), price_delta_cents: 15000 };
    assert.equal((await portalPost(handlers, await portalCookie(id), body, on)).status, 200, id);
    const raised = portal.job(id), after = customerMoneyTotals(raised);
    assert.deepEqual(figures(raised.invoice), [1150, 500, 650], `${id}: the approval saves money-core's applied payments`);
    assert.deepEqual([after.appliedCents, after.balanceCents], [raised.invoice.paid * 100, raised.invoice.balance * 100], id);
    const f = fixture(raised);
    assert.deepEqual((await f.run()).warnings, [], id);
    const voided = f.job().invoice;
    assert.deepEqual(figures(voided), [1000, 500, 500], `${id}: the void keeps the paid figure the approval saved`);
    assert.deepEqual([raised.invoice.status, voided.status], [jobs[id].invoice.status, jobs[id].invoice.status], `${id}: $500 is still owed either way`);
    assert.equal(voided.paid, raised.invoice.paid, id);
    assert.deepEqual([customerMoneyTotals(f.job()).appliedCents, customerMoneyTotals(f.job()).balanceCents], [voided.paid * 100, voided.balance * 100], id);
    if (id === 'job-1') assert.deepEqual([raised.invoice.paidCents, voided.paidCents], [50000, 50000]);
  }
});

test('neither the approval nor the void turns unreadable payments into a paid figure', async () => {
  // No payment total is recorded and the deposit's paid amount is not dollars and cents.
  const job = billed({ payment: { verified: false }, deposit: { amount: 500, paidAmount: 'five hundred', status: 'paid' }, invoice: { number: 'INV-ABC123', status: 'issued', amount: 1000, balance: 1000 } });
  assert.deepEqual([job.invoice.amount, job.invoice.balance, Object.hasOwn(job.invoice, 'paid')], [1150, 1150, false]);
  assert.ok(customerMoneyTotals(job).issues.includes('money_paid_invalid'));
  const f = fixture(job), result = await f.run();
  assert.deepEqual(result.warnings.map(warning => warning.code), ['invoice_not_updated'], 'the void leaves an invoice whose payments cannot be read for the team');
  assert.equal(Object.hasOwn(f.job().invoice, 'paid'), false);
  assert.equal(billedChangeCents(f.job()), 0);
  assert.ok(customerMoneyTotals(f.job()).issues.includes('money_paid_invalid'));
});

test('an invoice that does not match the job money is left for the team, and a draft or void one is not touched', async () => {
  const odd = fixture({ ...billed(), invoice: { number: 'INV-ABC123', status: 'issued', amount: 999, balance: 499 } });
  const result = await odd.run();
  assert.deepEqual(result.warnings.map(warning => warning.code), ['invoice_not_updated']);
  assert.deepEqual(odd.job().invoice, { number: 'INV-ABC123', status: 'issued', amount: 999, balance: 499 });
  for (const status of ['draft', 'void']) {
    const f = fixture({ ...billed(), invoice: { number: 'INV-ABC123', status, amount: 1150 } });
    assert.deepEqual((await f.run()).warnings, []); assert.equal(f.job().invoice.amount, 1150, status);
  }
});

test('the Hub void closes a portal checkout sized to the old balance and tells staff when it could not', async () => {
  const request = body => new Request('https://easygaragecleaning.com/api/money', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cases = [
    ['expired', ['checkout_closed'], /card checkout for the old balance was closed/],
    ['paid', ['checkout_paid'], /already paid a card checkout opened for the old balance/],
    ['pending', ['checkout_open'], /may still be open for the old balance/],
    [new Error('synthetic Stripe outage'), ['checkout_open'], /may still be open for the old balance/],
    ['none', [], null], ['current', [], null],
  ];
  for (const [outcome, codes, message] of cases) {
    const f = fixture(billed()), calls = [];
    const api = moneyHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(NOW), checkouts: async (env, jobId) => { calls.push([env.MONEY_API_ENABLED, jobId]); if (outcome instanceof Error) throw outcome; return outcome; } });
    const response = await api.post({ request: request(f.input({})), env: { MONEY_API_ENABLED: 'true' } }), body = await response.json();
    assert.equal(response.status, 200, String(outcome)); assert.equal(body.ok, true);
    assert.deepEqual(body.warnings.map(warning => warning.code), codes, String(outcome));
    if (message) assert.match(body.warnings.at(-1).message, message);
    assert.deepEqual(calls, [['true', 'job-abc123']], 'checked once, after the void was saved');
    assert.equal(billedChangeCents(f.job()), 0, 'the void is saved whatever happens to the checkout');
  }
  // Other money actions never touch the customer's checkout.
  const f = fixture(billed()), calls = [];
  const api = moneyHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(NOW), checkouts: async () => { calls.push(1); return 'expired'; } });
  const costs = { laborCents: 20000, disposalCents: 5000, materialsCents: 0, fuelCents: 1500, processingCents: 0, otherCents: 0 };
  const saved = await api.post({ request: request({ action: 'costs.save', requestId: randomUUID(), jobId: 'job-abc123', expectedRevision: f.job().revision, costs }), env: { MONEY_API_ENABLED: 'true' } });
  assert.equal(saved.status, 200); assert.deepEqual((await saved.json()).warnings, []); assert.deepEqual(calls, []);
  // Without a Stripe key (the default checker) no portal checkout can exist, so nothing is checked or warned.
  const plain = fixture(billed()), result = await (await moneyHandlers({ session: async () => owner, storage: () => plain.store, now: () => new Date(NOW) }).post({ request: request(plain.input({})), env: { MONEY_API_ENABLED: 'true' } })).json();
  assert.deepEqual(result.warnings, []);
});
