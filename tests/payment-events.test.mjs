import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cashPayment, crossingClock, funnelPaymentEventsEnabled, funnelPaymentMethod, moneyEventWrites, paidInFullChange, paidInFullState, paymentKind, stripeChargeClock, stripePaymentMethod } from '../functions/_lib/payment-events.js';
import { funnelEventId, FUNNEL_EVENTS_COLLECTION } from '../functions/_lib/funnel-events.js';
import { mutateMoney, moneyProjection } from '../functions/_lib/money-service.js';
import { moneyStorage } from '../functions/_lib/money-storage.js';
import { listMoney, moneyCsv } from '../functions/_lib/money-reports.js';
import { respondToDecision } from '../functions/_lib/change-orders.js';
import { moneyHandlers } from '../functions/api/money.js';

const NOW = '2026-09-22T18:00:00.000Z'; // noon in Denver on 2026-09-22
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const line = (id, name, unitCents, quantity = 1) => ({ id, kind: 'service', name, description: `${name} (synthetic)`, quantity, unitCents });
const LINES = [line('line-1', 'Garage cleanout', 90000), line('line-2', 'Shelving install', 25000, 2)];
const job = (extra = {}) => ({ id: 'job-1', type: 'job', customerId: 'c1', ...extra });
const paid = (amount, extra = {}) => ({ amount, verified: true, ...extra });
const seconds = at => Date.parse(at) / 1000;

test('paid in full comes from ledger balance math in integer cents, never from the job status', () => {
  assert.deepEqual(paidInFullState(job({ total: 1000, payment: paid(1000), status: 'scheduled', estimate: { revision: 3, amount: 1000 } })), { paid: true, totalCents: 100000, balanceCents: 0, estimateRevision: 3 });
  assert.equal(paidInFullState(job({ total: 1000, payment: paid(400), status: 'paid', pipelineStatus: 'paid', invoice: { status: 'paid' } })).paid, false, 'a paid status with an open balance is not paid');
  assert.equal(paidInFullState(job({ total: 30.3, payment: paid(30.3) })).paid, true, 'dollars compare as whole cents');
  assert.equal(paidInFullState(job({ total: 1000, approvedChangeTotal: 200, payment: paid(1000) })).balanceCents, 20000, 'an approved change order keeps the balance open');
  // A card tip is never applied to the balance.
  assert.equal(paidInFullState(job({ total: 1000, payment: paid(1000, { stripeSessions: [{ sessionId: 'cs_test_tip0001', amount: 100, purpose: 'tip' }, { sessionId: 'cs_test_bal0001', amount: 900, purpose: 'balance' }] }) })).paid, false);
  assert.equal(paidInFullState(job({ total: 500, deposit: { paidAmount: 500, verified: true } })).paid, true, 'a verified legacy deposit pays a job off');
  // Unknown is never paid and never unpaid.
  for (const unknown of [job(), job({ total: 0 }), job({ total: 'abc', payment: paid(10) }), job({ total: 1000, payment: { amount: 1000, verified: false, reference: 'crew-entered' } }), job({ total: 500, payment: paid(Number.NaN) })])
    assert.equal(paidInFullState(unknown).paid, null, JSON.stringify(unknown));
  assert.equal(paidInFullState(job({ total: 1000, payment: paid(1000), estimate: { amount: 1000, revision: 'two' } })).estimateRevision, null, 'an unreadable revision is unknown, not 0');
  // Status is a UI field: every status gives the same answer.
  for (const status of ['scheduled', 'in_progress', 'completed', 'paid', 'invoiced', 'review_requested', 'cancelled'])
    assert.deepEqual([paidInFullState(job({ total: 1000, payment: paid(600), status, pipelineStatus: status })).paid, paidInFullState(job({ total: 1000, payment: paid(1000), status, pipelineStatus: status })).paid], [false, true], status);
});

test('the crossing is computed from the job as read and as saved: paid_in_full, balance_reopened or nothing', () => {
  const open = job({ total: 1000, payment: paid(500) }), full = job({ total: 1000, payment: paid(1000) });
  assert.equal(paidInFullChange(open, full).type, 'job.paid_in_full');
  assert.equal(paidInFullChange(full, { ...full, total: 1200 }).type, 'job.balance_reopened');
  assert.equal(paidInFullChange(full, { ...full, estimate: { amount: 1000, revision: 2 } }), null, 'a revision that keeps the job paid is no crossing');
  assert.equal(paidInFullChange(open, { ...open, payment: paid(700) }), null);
  assert.equal(paidInFullChange(full, { ...full, total: 'unknown' }), null, 'an unknown balance never reopens anything');
  // An unreadable earlier balance falls back to the saved crossing.
  const unreadable = job({ total: 'unknown', payment: paid(1000) });
  assert.equal(paidInFullChange({ ...unreadable, paidInFullAt: '2026-09-01T00:00:00.000Z' }, { ...full, total: 1200 }).type, 'job.balance_reopened');
  assert.equal(paidInFullChange(unreadable, full).type, 'job.paid_in_full');
  assert.equal(paidInFullChange({ ...unreadable, paidInFullAt: '2026-09-01T00:00:00.000Z' }, full), null);
});

test('a payment without a purpose is a deposit only before the Denver service date and within the deposit due, and is always flagged', () => {
  const scheduled = job({ date: '2026-09-24', total: 1000 }); // 50% deposit: $500 due
  assert.deepEqual(paymentKind(scheduled, { amountCents: 50000, occurredAt: NOW }), { kind: 'deposit', inferred: true });
  assert.deepEqual(paymentKind(scheduled, { amountCents: 50001, occurredAt: NOW }), { kind: 'balance', inferred: true }, 'more than the deposit is a balance payment');
  assert.deepEqual(paymentKind(scheduled, { amountCents: 100, occurredAt: '2026-09-24T15:00:00.000Z' }), { kind: 'balance', inferred: true }, 'on the service date');
  // 05:30 UTC on the 24th is 11:30 pm on the 23rd in Denver: still before the service date.
  assert.equal(paymentKind(scheduled, { amountCents: 100, occurredAt: '2026-09-24T05:30:00.000Z' }).kind, 'deposit');
  assert.equal(paymentKind(scheduled, { amountCents: 100, occurredAt: '2026-09-24T06:30:00.000Z' }).kind, 'balance', '12:30 am Denver on the service date');
  assert.equal(paymentKind(job({ total: 1000 }), { amountCents: 100, occurredAt: NOW }).kind, 'balance', 'no service date: balance');
  assert.equal(paymentKind(job({ date: '2026-09-24', total: 1000, estimate: { amount: 1000, depositRequired: 300 } }), { amountCents: 30001, occurredAt: NOW }).kind, 'balance', 'the saved deposit term wins');
  // Once the deposit is covered, a second pre-service payment is a balance, so deposits never sum past the term.
  assert.equal(paymentKind({ ...scheduled, payment: paid(500) }, { amountCents: 20000, occurredAt: NOW }).kind, 'balance');
  assert.equal(paymentKind({ ...scheduled, payment: paid(200) }, { amountCents: 30000, occurredAt: NOW }).kind, 'deposit');
  for (const purpose of ['deposit', 'balance', 'tip']) assert.deepEqual(paymentKind(scheduled, { purpose, amountCents: 90000, occurredAt: '2026-10-01T15:00:00.000Z' }), { kind: purpose, inferred: false });
  for (const status of ['completed', 'paid', 'in_progress']) assert.equal(paymentKind({ ...scheduled, status, pipelineStatus: status, completedAt: NOW }, { amountCents: 100, occurredAt: NOW }).kind, 'deposit', `the rule never reads status (${status})`);
});

test('the Stripe charge time is the provider clock; a missing or impossible time falls back to the server clock', () => {
  const charged = '2026-09-22T17:55:00.000Z';
  assert.deepEqual(stripeChargeClock({ payment_intent: { created: seconds('2026-09-22T17:50:00.000Z'), latest_charge: { created: seconds(charged) } } }, NOW), { clockSource: 'provider', occurredAt: charged });
  assert.deepEqual(stripeChargeClock({ payment_intent: { created: seconds(charged), latest_charge: 'ch_1' } }, NOW), { clockSource: 'provider', occurredAt: charged }, 'the PaymentIntent time when the charge is not expanded');
  for (const checkout of [{}, { payment_intent: 'pi_1' }, { payment_intent: { latest_charge: { created: seconds('2026-09-22T18:06:00.000Z') } } }, { payment_intent: { latest_charge: { created: seconds('1999-12-31T23:59:59.000Z') } } }, { payment_intent: { latest_charge: { created: 1.5 } } }])
    assert.deepEqual(stripeChargeClock(checkout, NOW), {}, JSON.stringify(checkout));
});

test('a Stripe payment method comes from the expanded charge, and only an unexpanded charge falls back to card', () => {
  const checkout = type => ({ payment_intent: { id: 'pi_1', latest_charge: { id: 'ch_1', created: 1790000000, payment_method_details: type === undefined ? undefined : { type } } } });
  assert.deepEqual(['card', 'link', 'us_bank_account', 'cashapp', 'amazon_pay', '__proto__', undefined].map(type => stripePaymentMethod(checkout(type))), ['card', 'card', 'ach', 'other', 'other', 'other', 'other']);
  for (const unexpanded of [{}, { payment_intent: 'pi_1' }, { payment_intent: { id: 'pi_1', latest_charge: 'ch_1' } }, { payment_intent: { id: 'pi_1', latest_charge: null } }, null])
    assert.equal(stripePaymentMethod(unexpanded), 'card', JSON.stringify(unexpanded));
  assert.deepEqual(['card', 'ach', 'other'].map(funnelPaymentMethod), ['card', 'ach', 'other'], 'every result is in the funnel vocabulary');
});

test('gift-credit redemptions are applied money, never cash; every recorded method maps to the funnel vocabulary', async () => {
  assert.deepEqual(['card', 'stripe', 'card_terminal', 'ach', 'bank_transfer', 'cash', 'check', 'gift_credit', 'other', 'venmo', '__proto__', 'constructor', undefined].map(funnelPaymentMethod),
    ['card', 'card', 'card', 'ach', 'ach', 'cash', 'check', 'gift_credit', 'other', 'other', 'other', 'other', 'other']);
  assert.equal(cashPayment('gift_credit'), false); assert.equal(cashPayment('check'), true); assert.equal(cashPayment('mixed_with_gift_credit'), true);
  // The helper a gift-credit writer calls: the redemption pays the job off without counting as cash.
  const before = job({ total: 1000, payment: paid(900) }), after = job({ total: 1000, payment: paid(1000, { giftCreditApplied: 100 }) }), requestId = randomUUID();
  const { patch, writes } = await moneyEventWrites({ before, after, now: NOW, idempotencyKey: { kind: 'requestId', value: requestId }, actor: { id: 'customer', kind: 'customer' }, via: 'portal', source: { collection: 'customerOperations', id: requestId }, payment: { amountCents: 10000, kind: 'balance', method: 'gift_credit' } });
  assert.deepEqual(writes.map(write => [write.patch.type, write.patch.data]), [['payment.received', { amountCents: 10000, cash: false, kind: 'balance', method: 'gift_credit' }], ['job.paid_in_full', { amountCents: 100000 }]]);
  assert.deepEqual(patch, { paidInFullAt: NOW, paidInFullRevision: null });
});

test('writers outside the money API reopen with their own reason: change order, refund, re-sign', async () => {
  const full = job({ total: 1000, payment: paid(1000), paidInFullAt: '2026-09-20T15:00:00.000Z', paidInFullRevision: 1, estimate: { amount: 1000, revision: 1 } }), requestId = randomUUID();
  const base = { before: full, now: NOW, idempotencyKey: { kind: 'portalRequest', value: `portal-${requestId}` }, actor: { id: 'customer', kind: 'customer' }, via: 'portal', source: { collection: 'customerOperations', id: requestId } };
  const change = await moneyEventWrites({ ...base, after: { ...full, approvedChangeTotal: 250 }, reason: 'change_order' });
  assert.deepEqual(change.writes.map(write => [write.patch.type, write.patch.data]), [['job.balance_reopened', { amountCents: 25000, estimateRevision: 1, reasonCode: 'change_order' }]]);
  assert.deepEqual(change.patch, { paidInFullAt: null, paidInFullRevision: null, balanceReopenedAt: NOW, balanceReopenedReason: 'change_order' });
  const resigned = await moneyEventWrites({ ...base, after: { ...full, estimate: { amount: 1100, revision: 2 } }, reason: 'resigned' });
  assert.deepEqual(resigned.writes[0].patch.data, { amountCents: 10000, estimateRevision: 2, reasonCode: 'resigned' });
  const refunded = await moneyEventWrites({ ...base, after: { ...full, payment: paid(900) }, reason: 'refund', clock: { clockSource: 'provider', occurredAt: '2026-09-22T17:00:00.000Z' } });
  assert.deepEqual([refunded.writes[0].patch.data.reasonCode, refunded.patch.balanceReopenedAt], ['refund', '2026-09-22T17:00:00.000Z']);
  await assert.rejects(moneyEventWrites({ ...base, after: { ...full, approvedChangeTotal: 250 }, reason: 'because' }), error => error.code === 'funnel_event_invalid', 'reasons come from reasonCodes.balanceReopened');
});

test('a revision that keeps a recorded crossing paid only moves paidInFullRevision; nothing else is written', async () => {
  const full = job({ total: 1000, payment: paid(1000), paidInFullAt: '2026-09-20T15:00:00.000Z', paidInFullRevision: 1, estimate: { amount: 1000, revision: 1 } }), requestId = randomUUID();
  const base = { before: full, now: NOW, idempotencyKey: { kind: 'requestId', value: requestId }, actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', source: { collection: 'moneyOperations', id: requestId }, reason: 'estimate_revised' };
  assert.deepEqual(await moneyEventWrites({ ...base, after: { ...full, estimate: { amount: 900, revision: 2 } } }), { patch: { paidInFullRevision: 2 }, writes: [] });
  assert.deepEqual(await moneyEventWrites({ ...base, after: { ...full, estimate: { amount: 900, revision: 'two' } } }), { patch: { paidInFullRevision: null }, writes: [] }, 'an unreadable revision is unknown, never the old one');
  assert.deepEqual(await moneyEventWrites({ ...base, after: full }), { patch: {}, writes: [] }, 'the same revision changes nothing');
  // A job paid before the flag has no recorded crossing: it stays computed on read.
  const legacy = job({ total: 1000, payment: paid(1000), estimate: { amount: 1000, revision: 1 } });
  assert.deepEqual(await moneyEventWrites({ ...base, before: legacy, after: { ...legacy, estimate: { amount: 900, revision: 2 } } }), { patch: {}, writes: [] });
});

test('refunds the ledger does not net yet leave paid in full unknown, never paid', () => {
  for (const refunded of [{ refunds: [{ amount: 100 }] }, { payment: paid(1000, { refunds: [{ amount: 100 }] }) }, { payment: paid(1000, { refundedAmount: 100 }) }]) {
    const state = paidInFullState(job({ total: 1000, payment: paid(1000), ...refunded }));
    assert.deepEqual([state.paid, state.balanceCents], [null, null], JSON.stringify(refunded));
  }
  assert.equal(paidInFullState(job({ total: 1000, payment: paid(1000, { refundedAmount: 0 }) })).paid, true, 'a zero refund is no refund');
  // No crossing either way from a balance that has not been netted: FUN-17 nets refunds first.
  const full = job({ total: 1000, payment: paid(1000), paidInFullAt: '2026-09-20T15:00:00.000Z' });
  assert.equal(paidInFullChange(full, { ...full, payment: paid(1000, { refundedAmount: 100 }) }), null);
  assert.equal(paidInFullChange(job({ total: 1000, payment: paid(900) }), job({ total: 1000, payment: paid(1000, { refundedAmount: 100 }) })), null);
});

test('a crossing is never dated before the reopen, the last crossing or the estimate revision it is bound to', () => {
  const at = '2026-09-21T20:00:00.000Z', attested = { clockSource: 'attested', occurredAt: at }, provider = { clockSource: 'provider', occurredAt: at };
  assert.deepEqual(crossingClock(job(), job(), attested, NOW), attested, 'nothing earlier to follow: the payment time stands');
  assert.deepEqual(crossingClock(job(), job(), {}, NOW), {}, 'a server-clock write stays on the server clock');
  for (const before of [
    job({ balanceReopenedAt: '2026-09-22T17:00:00.000Z' }),
    job({ paidInFullAt: '2026-09-21T20:00:00.001Z' }),
    job({ estimate: { revision: 2, updatedAt: '2026-09-22T17:00:00.000Z' } }),
    job({ estimate: { revision: 1, createdAt: '2026-09-22T09:00:00.000Z' } }),
    job({ acceptance: { recordedAt: '2026-09-22T09:00:00.000Z' } }),
  ]) for (const clock of [attested, provider]) assert.deepEqual(crossingClock(before, before, clock, NOW), {}, JSON.stringify(before));
  // A write that saves a new revision itself pays off (or reopens) at the save.
  assert.deepEqual(crossingClock(job({ estimate: { revision: 1 } }), job({ estimate: { revision: 2 } }), attested, NOW), {});
  // A time at (or after) every floor stands; unreadable floors are ignored.
  const floors = job({ balanceReopenedAt: '2026-09-21T19:00:00.000Z', paidInFullAt: 42, estimate: { revision: 2, updatedAt: at, createdAt: 'yesterday' } });
  assert.deepEqual(crossingClock(floors, floors, attested, NOW), attested);
});

test('a crossing is never dated before the last money write or the change-order approval or void that set the total', () => {
  const at = '2026-09-21T20:00:00.000Z', attested = { clockSource: 'attested', occurredAt: at }, provider = { clockSource: 'provider', occurredAt: at }, later = '2026-09-22T09:00:00.000Z', earlier = '2026-09-20T09:00:00.000Z';
  for (const before of [
    job({ moneyUpdatedAt: later }),
    job({ changeOrders: [{ id: 'change-d1', approvedAt: later }] }),
    job({ changeOrders: [{ id: 'change-d1', approvedAt: earlier }, { id: 'change-d2', approvedAt: earlier, voidedAt: later, status: 'void' }] }),
    job({ customerDecisions: [{ id: 'd1', status: 'approved', respondedAt: later }] }),
    job({ customerDecisions: [{ id: 'd1', status: 'approved', respondedAt: earlier, changeOrderVoidedAt: later }] }),
  ]) for (const clock of [attested, provider]) assert.deepEqual(crossingClock(before, before, clock, NOW), {}, JSON.stringify(before));
  // Earlier facts, a declined answer (it never moved the total) and unreadable rows or times do not hold the payment time back.
  const settled = job({ moneyUpdatedAt: earlier, changeOrders: [{ id: 'change-d1', approvedAt: earlier, voidedAt: at }, null, 'change-d9', { id: 'change-d3', approvedAt: 'soon' }],
    customerDecisions: [{ id: 'd1', status: 'declined', respondedAt: later }, { id: 'd2', status: 'approved', respondedAt: earlier, changeOrderVoidedAt: 7 }] });
  assert.deepEqual(crossingClock(settled, settled, attested, NOW), attested);
  assert.deepEqual(crossingClock(job({ changeOrders: 'change-d1', customerDecisions: {} }), job(), attested, NOW), attested, 'no readable change orders: nothing to follow');
});

test('a crew tip on the same charge rides on payment.received as tipCents; only the service money pays the balance', async () => {
  const requestId = randomUUID(), base = { now: NOW, idempotencyKey: { kind: 'stripeSession', value: 'cs_test_tipped_balance_1' }, actor: { id: 'stripe_webhook', kind: 'integration', role: null }, via: 'stripe', source: { collection: 'jobs', id: 'job-1:stripeSessions:cs_test_tipped_balance_1' }, stripe: { sessionId: 'cs_test_tipped_balance_1', livemode: false } };
  const before = job({ total: 1000, payment: paid(500) }), after = job({ total: 1000, payment: paid(1000) });
  const { writes } = await moneyEventWrites({ ...base, before, after, payment: { amountCents: 50000, tipCents: 7500, kind: 'balance', kindInferred: true, method: 'card' } });
  assert.deepEqual(writes.map(write => [write.patch.type, write.patch.data]), [
    ['payment.received', { amountCents: 50000, cash: true, kind: 'balance', kindInferred: true, method: 'card', tipCents: 7500 }],
    ['job.paid_in_full', { amountCents: 100000 }],
  ], 'one payment event per charge: no second event for the tip');
  for (const tipCents of [0, -1, 1.5, '500', null]) {
    const [received] = (await moneyEventWrites({ ...base, before, after: before, idempotencyKey: { kind: 'requestId', value: requestId }, via: 'hub', actor: { id: 'zacb', kind: 'human', role: 'owner' }, source: { collection: 'moneyOperations', id: requestId }, stripe: undefined, payment: { amountCents: 100, tipCents, kind: 'balance', method: 'card' } })).writes;
    assert.equal('tipCents' in received.patch.data, false, String(tipCents));
  }
  // A tip rides only on a balance payment, so a tipped charge is never classed as a deposit.
  const scheduled = job({ date: '2026-09-24', total: 1000 });
  assert.deepEqual(paymentKind(scheduled, { amountCents: 30000, occurredAt: NOW }), { kind: 'deposit', inferred: true });
  assert.deepEqual(paymentKind(scheduled, { amountCents: 30000, tipCents: 5000, occurredAt: NOW }), { kind: 'balance', inferred: true });
  assert.deepEqual(paymentKind(scheduled, { amountCents: 30000, tipCents: 0, occurredAt: NOW }), { kind: 'deposit', inferred: true });
});

test('events carry the job, project, customer and contact links, and private records or unusable ids get none', async () => {
  const requestId = randomUUID(), base = { now: NOW, idempotencyKey: { kind: 'requestId', value: requestId }, actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', source: { collection: 'moneyOperations', id: requestId }, payment: { amountCents: 500, kind: 'balance', method: 'cash' } };
  const linked = job({ total: 1000, payment: paid(5), projectId: 'project_w1', highlevelContactId: 'contact1', isTest: true });
  const [event] = (await moneyEventWrites({ ...base, before: linked, after: linked })).writes;
  assert.equal(event.collection, FUNNEL_EVENTS_COLLECTION); assert.equal(event.revision, undefined, 'create-only');
  assert.equal(event.id, funnelEventId('payment.received', { field: 'jobId', value: 'job-1' }, `requestId:${requestId}`));
  assert.deepEqual([event.patch.jobId, event.patch.projectId, event.patch.customerId, event.patch.highlevelContactId, event.patch.isTest, event.patch.exclusion], ['job-1', 'project_w1', 'c1', 'contact1', true, 'test']);
  const odd = job({ total: 1000, projectId: '_egc_lock', customerId: 'secure_x', highlevelContactId: 'bad id' });
  const [plainEvent] = (await moneyEventWrites({ ...base, before: odd, after: odd })).writes;
  assert.deepEqual([plainEvent.patch.projectId, plainEvent.patch.customerId, plainEvent.patch.highlevelContactId], [null, null, null], 'invalid links are left off, never fail the payment');
  for (const record of [{ ...linked, recordType: 'schedule_lock' }, { ...linked, id: '_egc_schedule_lock_2026-09-22' }, { ...linked, id: 'secure_abc' }, { ...linked, id: 'has space' }, null])
    assert.deepEqual(await moneyEventWrites({ ...base, before: record, after: record }), { patch: {}, writes: [] });
});

// In-memory money store with Firestore commit semantics (see tests/money-service.test.mjs).
function fixture(jobFields = {}, { events = true } = {}) {
  const docs = new Map([['jobs/job-abc123', { id: 'job-abc123', revision: 'r0', type: 'job', customerId: 'c1', customer: 'Synthetic Customer', serviceType: 'Garage transformation', date: '2026-09-24', status: 'scheduled', pipelineStatus: 'scheduled', ...jobFields }], ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer' }]]);
  let n = 0;
  const commits = [];
  const store = {
    paymentEvents: events,
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
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
  const f = {
    docs, store, commits, job: () => docs.get('jobs/job-abc123'),
    // The money commit (the best-effort customer mirror follows it as its own commit).
    last: () => commits.filter(writes => writes[0].collection === 'jobs').at(-1),
    events: () => [...docs].filter(([key]) => key.startsWith(`${FUNNEL_EVENTS_COLLECTION}/`)).map(([, row]) => row),
    input: (action, fields = {}) => ({ action, requestId: randomUUID(), jobId: 'job-abc123', expectedRevision: docs.get('jobs/job-abc123').revision, ...fields }),
    run: (action, fields, now = NOW) => mutateMoney(store, owner, f.input(action, fields), now),
  };
  return f;
}
const saveEstimate = (f, lineItems = LINES, now = NOW) => f.run('estimate.save', { lineItems, scope: 'Clear and reset the two-car garage.', validUntil: '2026-10-06' }, now);
const EARLIER = '2026-09-22T14:00:00.000Z'; // the estimate is saved and approved before the check below is received

test('offline money commits payment.received, and the payment that clears the balance job.paid_in_full, with the ledger change', async () => {
  const f = fixture();
  await saveEstimate(f); await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' });
  assert.equal(f.events().length, 0, 'an estimate on an unpaid job is no payment crossing');
  const deposit = f.input('deposit.record_offline', { amountCents: 70000, method: 'bank_transfer', reference: 'ACH-77', receivedAt: '2026-09-21T16:00:00.000Z' });
  await mutateMoney(f.store, owner, deposit, NOW);
  const commit = f.last(), receipt = deposit.requestId.toLowerCase();
  assert.deepEqual(commit.map(write => write.collection), ['jobs', 'moneyOperations', 'hub_audit', FUNNEL_EVENTS_COLLECTION], 'the event is in the same commit as the money change');
  const event = commit[3];
  assert.equal(event.revision, undefined); assert.equal(event.id, funnelEventId('payment.received', { field: 'jobId', value: 'job-abc123' }, `requestId:${receipt}`));
  assert.deepEqual({ type: event.patch.type, data: event.patch.data, occurredAt: event.patch.occurredAt, clockSource: event.patch.clockSource, recordedAt: event.patch.recordedAt, denverDate: event.patch.denverDate, actor: event.patch.actor, via: event.patch.via, source: event.patch.source, key: event.patch.idempotencyKey, customerId: event.patch.customerId }, {
    type: 'payment.received', data: { amountCents: 70000, cash: true, estimateRevision: 1, kind: 'deposit', method: 'ach' }, occurredAt: '2026-09-21T16:00:00.000Z', clockSource: 'attested', recordedAt: NOW, denverDate: '2026-09-21',
    actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', source: { collection: 'moneyOperations', id: receipt }, key: `requestId:${receipt}`, customerId: 'c1' });
  assert.equal(f.job().paidInFullAt, undefined);
  // The balance payment is a balance (never the ledger's 'offline' kind) and pays the job off at estimate revision 1.
  const final = f.input('payment.record_offline', { amountCents: 70000, method: 'cash', reference: 'Receipt 7' }), balance = await mutateMoney(f.store, owner, final, NOW);
  const [received, crossing] = f.last().slice(-2).map(write => write.patch);
  assert.deepEqual([received.type, received.data, received.clockSource, received.occurredAt], ['payment.received', { amountCents: 70000, cash: true, estimateRevision: 1, kind: 'balance', method: 'cash' }, 'server', NOW]);
  assert.deepEqual([crossing.type, crossing.data, crossing.occurredAt], ['job.paid_in_full', { amountCents: 140000, estimateRevision: 1 }, NOW]);
  assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision, f.job().status], [NOW, 1, 'scheduled'], 'a prepaid job is paid in full while it stays on the schedule');
  assert.deepEqual(balance.job.paidInFull, { paid: true, at: NOW, revision: 1 });
  // A replay is answered from the receipt: no second event.
  const commits = f.commits.length;
  assert.equal((await mutateMoney(f.store, owner, final, NOW)).replayed, true);
  assert.equal(f.commits.length, commits); assert.equal(f.events().length, 3);
});

test('a revision that raises the total reopens the balance; a revision back down pays it off again, bound to that revision', async () => {
  const f = fixture();
  await saveEstimate(f, LINES, EARLIER); await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' }, EARLIER);
  await f.run('payment.record_offline', { amountCents: 140000, method: 'check', reference: 'CHK-1', receivedAt: '2026-09-22T15:00:00.000Z' });
  assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision], ['2026-09-22T15:00:00.000Z', 1], 'the crossing is dated when the money was received');
  await saveEstimate(f, [...LINES, line('line-3', 'Haul away', 15000)]);
  let [reopened] = f.last().filter(write => write.collection === FUNNEL_EVENTS_COLLECTION).map(write => write.patch);
  assert.deepEqual([reopened.type, reopened.data, reopened.clockSource], ['job.balance_reopened', { amountCents: 15000, estimateRevision: 2, reasonCode: 'estimate_revised' }, 'server']);
  assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision, f.job().balanceReopenedAt, f.job().balanceReopenedReason], [null, null, NOW, 'estimate_revised']);
  assert.equal(moneyProjection(f.job(), NOW, { paymentEvents: true }).paidInFull.paid, false);
  // Saving the revision again unchanged is no crossing.
  await saveEstimate(f, [...LINES, line('line-3', 'Haul away', 15000)]);
  assert.equal(f.last().some(write => write.collection === FUNNEL_EVENTS_COLLECTION), false);
  await saveEstimate(f, LINES);
  const [again] = f.last().filter(write => write.collection === FUNNEL_EVENTS_COLLECTION).map(write => write.patch);
  assert.deepEqual([again.type, again.data], ['job.paid_in_full', { amountCents: 140000, estimateRevision: 3 }]);
  assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision], [NOW, 3]);
  assert.deepEqual(f.events().map(event => event.type).sort(), ['job.balance_reopened', 'job.paid_in_full', 'job.paid_in_full', 'payment.received']);
});

test('a lower revision after payment in full keeps the job paid at the new revision, while the event keeps its crossing', async () => {
  const f = fixture();
  await saveEstimate(f, LINES, EARLIER); await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' }, EARLIER);
  await f.run('payment.record_offline', { amountCents: 140000, method: 'check', reference: 'CHK-1', receivedAt: '2026-09-22T15:00:00.000Z' });
  await saveEstimate(f, [LINES[0], line('line-2', 'Shelving install', 20000, 2)]);
  assert.equal(f.job().estimate.revision, 2);
  assert.equal(f.last().some(write => write.collection === FUNNEL_EVENTS_COLLECTION), false, 'staying paid is no crossing');
  assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision], ['2026-09-22T15:00:00.000Z', 2]);
  assert.deepEqual(moneyProjection(f.job(), NOW, { paymentEvents: true }).paidInFull, { paid: true, at: '2026-09-22T15:00:00.000Z', revision: 2 });
  assert.deepEqual(f.events().filter(event => event.type === 'job.paid_in_full').map(event => event.data), [{ amountCents: 140000, estimateRevision: 1 }], 'the one crossing, at the revision it happened');
});

test('a check backdated before the reopen pays the job off when it is recorded; the payment keeps its attested time', async () => {
  const reopenedAt = '2026-09-22T17:00:00.000Z';
  async function reopened() {
    const f = fixture({ date: '2026-09-20', status: 'completed', pipelineStatus: 'completed' });
    await saveEstimate(f, LINES, '2026-09-20T15:00:00.000Z'); await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' }, '2026-09-20T15:05:00.000Z');
    await f.run('payment.record_offline', { amountCents: 140000, method: 'check', reference: 'CHK-1' }, '2026-09-20T16:00:00.000Z');
    assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision], ['2026-09-20T16:00:00.000Z', 1]);
    await saveEstimate(f, [...LINES, line('line-3', 'Haul away', 20000)], reopenedAt);
    assert.deepEqual([f.job().balanceReopenedAt, f.job().estimate.revision, f.job().paidInFullAt], [reopenedAt, 2, null]);
    return f;
  }
  // The check for the difference was handed over the day before the revision existed and is recorded now.
  const f = await reopened();
  await f.run('payment.record_offline', { amountCents: 20000, method: 'check', reference: 'CHK-2', receivedAt: '2026-09-21T20:00:00.000Z' }, NOW);
  const [received, crossing] = f.last().filter(write => write.collection === FUNNEL_EVENTS_COLLECTION).map(write => write.patch);
  assert.deepEqual([received.type, received.occurredAt, received.clockSource, received.data.estimateRevision], ['payment.received', '2026-09-21T20:00:00.000Z', 'attested', 2], 'the money keeps its own time');
  assert.deepEqual([crossing.type, crossing.data, crossing.occurredAt, crossing.clockSource, crossing.recordedAt], ['job.paid_in_full', { amountCents: 160000, estimateRevision: 2 }, NOW, 'server', NOW]);
  assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision, f.job().balanceReopenedAt], [NOW, 2, reopenedAt]);
  assert.ok(Date.parse(f.job().paidInFullAt) > Date.parse(f.job().balanceReopenedAt), 'the job fields agree with the event order');
  // Ordered by occurredAt, the last crossing is the payoff, so a state-at-time reader sees the job paid.
  const crossings = f.events().filter(event => event.type !== 'payment.received').sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  assert.deepEqual(crossings.map(event => [event.type, event.occurredAt, event.data.estimateRevision]), [['job.paid_in_full', '2026-09-20T16:00:00.000Z', 1], ['job.balance_reopened', reopenedAt, 2], ['job.paid_in_full', NOW, 2]]);
  // A check received after the reopen and the revision keeps its attested time for the crossing as well.
  const g = await reopened(), later = '2026-09-22T17:30:00.000Z';
  await g.run('payment.record_offline', { amountCents: 20000, method: 'check', reference: 'CHK-2', receivedAt: later }, NOW);
  const payoff = g.last().filter(write => write.collection === FUNNEL_EVENTS_COLLECTION).map(write => write.patch).find(event => event.type === 'job.paid_in_full');
  assert.deepEqual([payoff.occurredAt, payoff.clockSource, g.job().paidInFullAt], [later, 'attested', later]);
});

test('a check received before a change-order void and recorded after it pays the job off when it is recorded, never before the void', async () => {
  const voidedAt = '2026-09-22T17:00:00.000Z';
  async function voided() {
    const f = fixture();
    await saveEstimate(f, [line('line-1', 'Garage cleanout', 100000)], '2026-09-20T15:00:00.000Z'); await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' }, '2026-09-20T15:05:00.000Z');
    await f.run('deposit.record_offline', { amountCents: 50000, method: 'check', reference: 'CHK-1' }, '2026-09-20T15:10:00.000Z');
    // On the 21st the customer approved a $200 change in the portal with billing on (CHANGE-ORDERS): $1,200 is owed.
    const decision = { id: 'decision-shelves', title: 'Add shelves', details: 'Synthetic crew note.', priceDelta: 200, status: 'pending', promptedAt: '2026-09-21T15:00:00.000Z' }, asked = { ...f.job(), customerDecisions: [decision] };
    const { patch } = respondToDecision(asked, { decisionId: decision.id, response: 'approved', respondedBy: 'Synthetic Customer', note: '', requestId: randomUUID(), priceDeltaCents: 20000 }, { billing: true, now: '2026-09-21T16:00:00.000Z', paidCents: 50000 });
    f.docs.set('jobs/job-abc123', { ...asked, ...patch, revision: 'portal-r1' });
    assert.equal(paidInFullState(f.job()).balanceCents, 70000);
    // On the 22nd at 17:00 a manager voids it (priced by mistake): $1,000 is owed and $500 of it is still open.
    await f.run('change_order.void', { changeOrderId: 'change-decision-shelves', reason: 'Priced by mistake' }, voidedAt);
    assert.deepEqual([paidInFullState(f.job()).balanceCents, f.job().moneyUpdatedAt, f.last().some(write => write.collection === FUNNEL_EVENTS_COLLECTION)], [50000, voidedAt, false], 'the void leaves a balance: no crossing');
    return f;
  }
  // At 18:00 staff record the $500 check the customer handed over at 12:00, before the void: at 12:00 $1,200 was owed and $1,000 paid.
  const f = await voided();
  await f.run('payment.record_offline', { amountCents: 50000, method: 'check', reference: 'CHK-2', receivedAt: '2026-09-22T12:00:00.000Z' }, NOW);
  const [received, crossing] = f.last().filter(write => write.collection === FUNNEL_EVENTS_COLLECTION).map(write => write.patch);
  assert.deepEqual([received.type, received.occurredAt, received.clockSource, received.data.amountCents], ['payment.received', '2026-09-22T12:00:00.000Z', 'attested', 50000], 'the money keeps its own time');
  assert.deepEqual([crossing.type, crossing.data, crossing.occurredAt, crossing.clockSource], ['job.paid_in_full', { amountCents: 100000, estimateRevision: 1 }, NOW, 'server']);
  assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision], [NOW, 1]);
  assert.ok(Date.parse(f.job().paidInFullAt) >= Date.parse(voidedAt), 'never before the void that made $1,000 enough');
  // A check received after the void keeps its attested time for the crossing as well.
  const g = await voided(), later = '2026-09-22T17:30:00.000Z';
  await g.run('payment.record_offline', { amountCents: 50000, method: 'check', reference: 'CHK-2', receivedAt: later }, NOW);
  const payoff = g.last().filter(write => write.collection === FUNNEL_EVENTS_COLLECTION).map(write => write.patch).find(event => event.type === 'job.paid_in_full');
  assert.deepEqual([payoff.occurredAt, payoff.clockSource, g.job().paidInFullAt], [later, 'attested', later]);
});

test('a job marked paid by status alone never counts as paid in full', async () => {
  const f = fixture({ status: 'paid', pipelineStatus: 'paid', invoice: { status: 'paid', amount: 1400 } });
  await saveEstimate(f); await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' });
  await f.run('deposit.record_offline', { amountCents: 70000, method: 'cash', reference: 'Receipt 1' });
  assert.deepEqual(f.events().map(event => event.type), ['payment.received']);
  assert.equal(f.job().paidInFullAt, undefined); assert.equal(moneyProjection(f.job(), NOW, { paymentEvents: true }).paidInFull.paid, false);
});

test('with FUNNEL_PAYMENT_EVENTS_ENABLED unset the money commit is exactly as before', async () => {
  const f = fixture({}, { events: false });
  await saveEstimate(f); await f.run('estimate.record_approval', { approvedBy: 'Synthetic Customer' });
  const response = await f.run('payment.record_offline', { amountCents: 140000, method: 'check', reference: 'CHK-1', receivedAt: '1999-12-31T12:00:00.000Z' });
  assert.equal(f.events().length, 0); assert.equal(f.commits.flat().some(write => write.collection === FUNNEL_EVENTS_COLLECTION), false);
  assert.equal('paidInFullAt' in f.job(), false);
  assert.deepEqual(f.last().map(write => write.collection), ['jobs', 'moneyInvoiceNumbers', 'moneyOperations', 'hub_audit']);
  // The DTO is exactly as before too: no paidInFull and no nonCashCredit on the payments.
  assert.ok(response.job.payments.length > 0);
  assert.equal('paidInFull' in response.job, false); assert.equal(response.job.payments.some(row => 'nonCashCredit' in row), false);
  assert.equal('paidInFull' in moneyProjection(f.job(), NOW), false);
  // With the flag on, a job saved before it is computed on read from the ledger.
  assert.deepEqual(moneyProjection(f.job(), NOW, { paymentEvents: true }).paidInFull, { paid: true, at: null, revision: null });
  const on = { FUNNEL_PAYMENT_EVENTS_ENABLED: 'true', MONEY_API_ENABLED: 'true' };
  assert.deepEqual([undefined, '', 'TRUE', 'yes', true].map(value => funnelPaymentEventsEnabled({ ...on, FUNNEL_PAYMENT_EVENTS_ENABLED: value })), [false, false, false, false, false]);
  assert.equal(funnelPaymentEventsEnabled(on), true);
  // The Hub's browser finance tools (money API off) write payments with no event, so the events need both flags.
  assert.deepEqual([{ FUNNEL_PAYMENT_EVENTS_ENABLED: 'true' }, { FUNNEL_PAYMENT_EVENTS_ENABLED: 'true', MONEY_API_ENABLED: 'yes' }, { MONEY_API_ENABLED: 'true' }].map(funnelPaymentEventsEnabled), [false, false, false]);
  assert.equal(moneyStorage(on).paymentEvents, true); assert.equal(moneyStorage({ FUNNEL_PAYMENT_EVENTS_ENABLED: 'true' }).paymentEvents, false); assert.equal(moneyStorage({}).paymentEvents, false);
});

test('with events on, a time received before the funnel range is refused and nothing is saved', async () => {
  const f = fixture();
  await saveEstimate(f);
  const commits = f.commits.length;
  await assert.rejects(f.run('deposit.record_offline', { amountCents: 100, method: 'cash', reference: 'Receipt 1', receivedAt: '1999-12-31T12:00:00.000Z' }), error => error.code === 'money_invalid_received_at' && error.status === 400);
  assert.equal(f.commits.length, commits);
});

test('with events on, ledger lists and CSV mark gift credit as non-cash credit; unset, both are exactly as before', async () => {
  const jobs = [{ id: 'job-g', revision: 'r1', type: 'job', customerId: 'c1', customer: 'Synthetic Gift', total: 400,
    paymentLedger: [{ id: 'hub:chk9', kind: 'offline', amountCents: 10000, method: 'check', processor: '', processorRef: 'CHK-9', receiptUrl: '', at: '2026-09-21T16:00:00.000Z', by: 'zacb', verified: true, source: 'hub_offline' }],
    payment: { amount: 400, verified: true, giftCreditApplied: 100, stripeSessions: [{ sessionId: 'cs_test_giftcard1', paymentIntentId: 'pi_giftcard1', amount: 200, purpose: 'deposit', verifiedAt: '2026-09-20T16:00:00.000Z' }] } }];
  const page = await listMoney({ paymentEvents: true, jobs: async () => structuredClone(jobs) }, { view: 'payments' }, NOW);
  // Card and check money is collected money: only the gift-credit redemption is non-cash credit.
  assert.deepEqual(page.items.map(row => [row.method, row.nonCashCredit, row.amountCents]).sort(), [['card', false, 20000], ['check', false, 10000], ['gift_credit', true, 10000]]);
  const csv = moneyCsv('payments', page.rows, { paymentEvents: true }).split('\r\n');
  assert.match(csv[0], /"Entry ID","Non-cash credit"$/);
  assert.deepEqual(csv.slice(1, -1).map(row => [row.match(/"(card|check|gift_credit)"/)[1], row.endsWith('"yes"') ? 'yes' : row.endsWith('"no"') ? 'no' : '?']).sort(), [['card', 'no'], ['check', 'no'], ['gift_credit', 'yes']]);
  assert.deepEqual(moneyProjection(jobs[0], NOW, { paymentEvents: true }).payments.map(row => [row.method, row.nonCashCredit]).sort(), [['card', false], ['check', false], ['gift_credit', true]]);
  // Flag off: no new field and no new column.
  const legacy = await listMoney({ paymentEvents: false, jobs: async () => structuredClone(jobs) }, { view: 'payments' }, NOW);
  assert.equal(legacy.items.some(row => 'nonCashCredit' in row || 'cash' in row), false);
  assert.match(moneyCsv('payments', legacy.rows).split('\r\n')[0], /"Source","Entry ID"$/);
  assert.equal(moneyCsv('invoices', [], { paymentEvents: true }).includes('Non-cash credit'), false, 'the invoices view never gains the column');
  assert.equal(moneyProjection(jobs[0], NOW).payments.some(row => 'nonCashCredit' in row || 'cash' in row), false);
});

test('GET /api/money adds paidInFull and the Non-cash credit column only when both flags are on', async () => {
  const row = { id: 'job-g', revision: 'r1', type: 'job', customerId: 'c1', customer: 'Synthetic Gift', total: 300, payment: { amount: 300, verified: true, giftCreditApplied: 100,
    stripeSessions: [{ sessionId: 'cs_test_giftcard2', paymentIntentId: 'pi_giftcard2', amount: 200, purpose: 'deposit', verifiedAt: '2026-09-20T16:00:00.000Z' }] } };
  // The handler hands the store's own flag to every read, as moneyStorage(env) sets it.
  const api = moneyHandlers({ session: async () => owner, now: () => new Date(NOW), storage: env => ({ paymentEvents: funnelPaymentEventsEnabled(env), read: async () => structuredClone(row), jobs: async () => [structuredClone(row)] }) });
  const get = query => new Request(`https://easygaragecleaning.com/api/money${query}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  const read = async env => {
    const job = (await (await api.get({ request: get('?jobId=job-g'), env })).json()).job;
    const csv = await (await api.get({ request: get('?view=payments&format=csv'), env })).text();
    return { paidInFull: job.paidInFull, marks: job.payments.map(entry => entry.nonCashCredit), header: csv.split('\r\n')[0] };
  };
  const on = await read({ FUNNEL_PAYMENT_EVENTS_ENABLED: 'true', MONEY_API_ENABLED: 'true' });
  assert.deepEqual(on.paidInFull, { paid: true, at: null, revision: null });
  assert.deepEqual(on.marks.sort(), [false, true]); assert.match(on.header, /"Entry ID","Non-cash credit"$/);
  for (const env of [{}, { FUNNEL_PAYMENT_EVENTS_ENABLED: 'true' }, { MONEY_API_ENABLED: 'true' }]) {
    const off = await read(env);
    assert.deepEqual([off.paidInFull, off.marks], [undefined, [undefined, undefined]], JSON.stringify(env)); assert.match(off.header, /"Source","Entry ID"$/, JSON.stringify(env));
  }
});
