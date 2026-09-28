import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { applyGarageGuardEvent, garageGuardEvent } from '../functions/_lib/garage-guard-membership.js';
import { LEDGER_LIMITS, VISIT_LIST_RETRY_MS, afterPaidPeriod, churnClass, coveringPeriod, garageGuardBilling, garageGuardDrift, garageGuardLedgerStore, garageGuardSummary, ledgerStaleFrom, listedUnresolvedVisits, memberStart, membershipDeferred, periodVisitSpan, visitAllocation, visitCountGap } from '../functions/_lib/garage-guard-ledger.js';
import { applyMembershipVisit, garageGuardAction, garageGuardOverview } from '../functions/_lib/garage-guard-visits.js';
import { funnelEventId } from '../functions/_lib/funnel-events.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import { NOW, T0, YEAR, account, at, checkoutEvent, completeVisit, deletedEvent, invoiceEvent, member, memoryStore, webhookApply } from './helpers/garage-guard-fixture.mjs';

const LATER = '2027-12-01T12:00:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true };
const events = store => store.collection('funnelEvents').sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.type.localeCompare(b.type));

test('Stripe amounts, discounts, promotions and cancellation details are read exactly; anything else is unknown (null)', () => {
  assert.deepEqual(garageGuardBilling(checkoutEvent()), {
    sessionId: 'cs_test_guard_member_1', invoiceId: 'in_guard_first', currency: 'usd', amountPaidCents: 80000, amountTotalCents: 80000, amountSubtotalCents: 90000, amountDueCents: null, discountCents: 10000,
    promotionCodes: ['promo_synthetic_ten'], couponIds: ['SYNTHETICTENOFF'], paidAt: null, periodStart: null, attemptCount: null, nextPaymentAttemptAt: null, cancellationReason: null, cancellationFeedback: null,
  });
  assert.equal(garageGuardBilling(checkoutEvent({ paymentStatus: 'unpaid' })).amountPaidCents, null, 'an unpaid session has paid nothing yet');
  assert.equal(garageGuardBilling(checkoutEvent({ paymentStatus: 'no_payment_required', amountTotal: 0 })).amountPaidCents, 0, 'a fully discounted checkout is a known $0');
  const invoice = garageGuardBilling(invoiceEvent({ id: 'evt_guard_paid_invoice', paidAt: T0 + 90, attempt: 2 }));
  assert.deepEqual({ ...invoice, promotionCodes: invoice.promotionCodes.join(), couponIds: invoice.couponIds.join() }, {
    sessionId: null, invoiceId: 'in_guard_first', currency: 'usd', amountPaidCents: 80000, amountTotalCents: 80000, amountSubtotalCents: 90000, amountDueCents: 80000, discountCents: 10000,
    promotionCodes: 'promo_synthetic_ten', couponIds: 'SYNTHETICTENOFF', paidAt: at(T0 + 90), periodStart: at(T0), attemptCount: 2, nextPaymentAttemptAt: null, cancellationReason: null, cancellationFeedback: null,
  });
  // A proration from a mid-year change can ride on the cycle invoice; the paid period still starts where its subscription line does.
  const prorated = invoiceEvent({ id: 'evt_guard_prorated' }); prorated.data.object.lines.data.unshift({ type: 'invoiceitem', proration: true, period: { start: T0 - 100 * 86400, end: T0 } });
  assert.equal(garageGuardBilling(prorated).periodStart, at(T0));
  // Newer API versions list discount objects and put the coupon under source.
  const basil = invoiceEvent({ id: 'evt_guard_basil', discount: 0 }); Object.assign(basil.data.object, { discount: undefined, discounts: ['di_expanded_elsewhere', { id: 'di_synthetic', promotion_code: { id: 'promo_basil' }, source: { coupon: 'BASILCOUPON' } }] });
  assert.deepEqual([garageGuardBilling(basil).promotionCodes, garageGuardBilling(basil).couponIds, garageGuardBilling(basil).discountCents], [['promo_basil'], ['BASILCOUPON'], 0]);
  const bad = invoiceEvent({ id: 'evt_guard_bad' }); Object.assign(bad.data.object, { amount_paid: -5, total: 12.5, subtotal: '900', amount_due: 1e12, total_discount_amounts: [{ amount: 'x' }], currency: 'US dollars', attempt_count: -1 });
  const parsed = garageGuardBilling(bad);
  assert.deepEqual([parsed.amountPaidCents, parsed.amountTotalCents, parsed.amountSubtotalCents, parsed.amountDueCents, parsed.discountCents, parsed.currency, parsed.attemptCount], [null, null, null, null, null, null, null]);
  assert.deepEqual([garageGuardBilling(deletedEvent()).cancellationReason, garageGuardBilling(deletedEvent()).cancellationFeedback], ['cancellation_requested', 'unused']);
  assert.deepEqual([garageGuardBilling(deletedEvent({ reason: 'payment_failed', feedback: 'something new' })).cancellationReason, garageGuardBilling(deletedEvent({ reason: 'payment_failed', feedback: 'something new' })).cancellationFeedback], ['payment_failed', null]);
  assert.equal(JSON.stringify(garageGuardBilling(deletedEvent())).includes('Synthetic free text'), false, 'free-text cancellation comments are never kept');
  assert.equal(garageGuardBilling(deletedEvent({ reason: null })).cancellationReason, null);
});

test('member visit revenue is paid / included, with the last visit taking the remainder, never more than was paid', () => {
  const period = (paid, included, recognized = 0) => ({ paidCents: paid, visitsIncluded: included, recognizedCents: recognized });
  assert.deepEqual([1, 2, 3, 4].map(n => visitAllocation(period(80000, 4), n)), [20000, 20000, 20000, 20000]);
  let recognized = 0; const black = [];
  for (let n = 1; n <= 12; n++) { const value = visitAllocation(period(250000, 12, recognized), n); black.push(value); recognized += value; }
  assert.deepEqual([black[0], black[11], recognized], [20833, 20837, 250000], 'twelve Black visits add up to exactly the price paid');
  assert.deepEqual([visitAllocation(period(45001, 2), 1), visitAllocation(period(45001, 2, 22500), 2)], [22500, 22501]);
  assert.equal(visitAllocation(period(80000, 4, 70000), 1), 10000, 'capped at what the period still holds');
  assert.equal(visitAllocation(period(80000, 4, 80000), 4), 0);
  for (const [value, occurrence] of [[period(null, 4), 1], [period(80000, null), 1], [period(80000, 0), 1], [period(80000, 4), 0], [period(80000, 4), 5], [period(80000, 4), null], [null, 1]]) assert.equal(visitAllocation(value, occurrence), null);
});

test('churn is voluntary for a requested cancellation and involuntary after failed payments; otherwise unknown', () => {
  assert.deepEqual(churnClass('cancellation_requested', 'past_due'), { class: 'voluntary', source: 'stripe_reason' });
  assert.deepEqual(churnClass('payment_failed', 'active'), { class: 'involuntary', source: 'stripe_reason' });
  assert.deepEqual(churnClass('payment_disputed', 'active'), { class: 'involuntary', source: 'stripe_reason' });
  assert.deepEqual(churnClass(null, 'past_due'), { class: 'involuntary', source: 'past_due_status' });
  assert.deepEqual(churnClass(null, 'active'), { class: 'voluntary', source: 'active_status' });
  assert.deepEqual([churnClass(null, 'pending').class, churnClass(null, '').class], [null, null]);
});

test('a new member stores the amounts on the receipt and membership, opens one paid period and writes membership.started in the same commit', async () => {
  const store = memoryStore();
  await webhookApply(store, checkoutEvent(), LATER);
  const [commit] = store.commits, started = events(store);
  assert.deepEqual(commit.slice(0, 3), ['jobs/job-root', 'memberships/sub_member_1', 'stripe_events/evt_guard_checkout']);
  assert.deepEqual(commit.slice(3), started.map(event => `funnelEvents/${event.id}`), 'the event is part of the membership commit');
  assert.deepEqual(started.map(event => [event.type, event.occurredAt, event.clockSource, event.membershipId, event.customerId, event.via, event.data, event.source, event.isTest, event.idempotencyKey]),
    [['membership.started', NOW, 'provider', 'sub_member_1', 'cust-dana', 'stripe', { amountCents: 80000, discountCents: 10000, plan: 'guard' }, { collection: 'stripe_events', id: 'evt_guard_checkout' }, true, 'stripeEvent:evt_guard_checkout']]);
  assert.equal(started[0].id, funnelEventId('membership.started', { field: 'membershipId', value: 'sub_member_1' }, 'stripeEvent:evt_guard_checkout'));
  assert.deepEqual(store.get('stripe_events/evt_guard_checkout').amounts, { currency: 'usd', amountPaidCents: 80000, amountTotalCents: 80000, amountSubtotalCents: 90000, amountDueCents: null, discountCents: 10000, promotionCodes: ['promo_synthetic_ten'], couponIds: ['SYNTHETICTENOFF'], invoiceId: 'in_guard_first', sessionId: 'cs_test_guard_member_1' });
  assert.deepEqual(store.get('stripe_events/evt_guard_checkout').funnelEventIds, [started[0].id]);
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual({ paid: membership.amountPaidCents, total: membership.amountTotalCents, discount: membership.discountCents, promo: membership.promotionCodes, coupons: membership.couponIds, currency: membership.currency, startedAt: membership.startedAt, lifetime: membership.lifetimePaidCents },
    { paid: 80000, total: 80000, discount: 10000, promo: ['promo_synthetic_ten'], coupons: ['SYNTHETICTENOFF'], currency: 'usd', startedAt: NOW, lifetime: 0 }, 'a checkout is not subscription cash; its invoice is');
  assert.deepEqual(membership.periods.map(period => [period.id, period.status, period.paidSource, period.paidCents, period.visitsIncluded, period.visitsUsed, period.recognizedCents]), [['checkout:evt_guard_checkout', 'open', 'checkout', 80000, 4, 0, 0]]);
  // The first invoice confirms that period instead of opening a second one.
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5, paid: 79000 }), LATER);
  const confirmed = store.get('memberships/sub_member_1');
  assert.deepEqual(confirmed.periods.map(period => [period.status, period.paidSource, period.invoiceId, period.paidCents, period.periodStart, period.periodEnd]), [['open', 'invoice', 'in_guard_first', 79000, at(T0), at(T0 + YEAR)]]);
  assert.deepEqual([confirmed.amountPaidCents, confirmed.lifetimePaidCents, confirmed.invoices.length, confirmed.invoices[0].billingReason], [79000, 79000, 1, 'subscription_create']);
  assert.deepEqual(events(store).map(event => event.type), ['membership.started'], 'the first invoice is neither a second start nor a renewal');
  assert.equal(store.get('stripe_events/evt_guard_first_invoice').funnelEventIds, undefined);
});

test('an invoice before its checkout starts the membership once, and a replayed event adds nothing', async () => {
  const store = memoryStore();
  // Stripe created the invoice after the checkout but delivered it first.
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5 }), LATER);
  await webhookApply(store, checkoutEvent(), LATER);
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual(events(store).map(event => [event.type, event.source.id, event.occurredAt]), [['membership.started', 'evt_guard_first_invoice', at(T0 + 5)]]);
  assert.equal(membership.periods.length, 1); assert.equal(membership.periods[0].paidSource, 'invoice');
  assert.deepEqual(membership.checkout.sessionId, 'cs_test_guard_member_1', 'the checkout amounts are kept even when it arrives second');
  assert.equal(membership.amountsEventId, 'evt_guard_first_invoice', 'an older checkout delivered late never overwrites the newer invoice amounts');
  const before = structuredClone([...store.rows]);
  assert.equal((await webhookApply(store, checkoutEvent(), LATER)).status, 'duplicate');
  assert.deepEqual([...store.rows], before);
});

test('a membership recorded before the ledger never starts again; one that was never active starts on its first payment', async () => {
  const store = memoryStore();
  store.put('memberships/sub_member_1', { subscriptionId: 'sub_member_1', plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 2, currentPeriodEnd: at(T0), link: { status: 'unlinked' }, statusEventCreated: T0 - YEAR, livemode: true });
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_legacy_renewal', reason: 'subscription_cycle', created: T0 + 60, invoice: 'in_guard_second' }), LATER);
  const legacy = store.get('memberships/sub_member_1');
  assert.deepEqual(events(store).map(event => event.type), ['membership.renewed']);
  assert.deepEqual([legacy.startedAt, legacy.renewalCount, legacy.periods.length, legacy.periods[1].paidCents, legacy.ledgerVersion, legacy.preLedger, legacy.provisionalStartedAt], [undefined, 1, 2, 80000, 1, true, at(T0 - YEAR)]);
  // Its pre-ledger year closes as a stub with unknown amounts, so the renewal still counts.
  assert.deepEqual(legacy.periods.map(period => [period.id, period.status, period.closeReason, period.periodEnd, period.paidCents, period.visitsUsed, period.breakageCents, period.closedAt]),
    [['pre_ledger', 'closed', 'renewed', at(T0), null, null, null, at(T0 + 60)], ['in_guard_second', 'open', null, at(T0 + YEAR), 80000, 0, null, null]]);
  const renewals = garageGuardSummary([legacy], { startAt: at(T0 - 86400), endAt: at(T0 + 86400), asOf: LATER }).renewals;
  assert.deepEqual([renewals.due, renewals.renewed, renewals.rate], [1, 1, 1]);
  const late = memoryStore();
  await webhookApply(late, invoiceEvent({ id: 'evt_guard_first_failure', type: 'invoice.payment_failed', reason: 'subscription_create', created: T0, paid: 0 }), LATER);
  assert.equal(late.get('memberships/sub_member_1').status, 'past_due');
  await webhookApply(late, invoiceEvent({ id: 'evt_guard_first_success', reason: 'subscription_create', created: T0 + 60 }), LATER);
  assert.deepEqual(events(late).map(event => event.type), ['membership.payment_failed', 'membership.started']);
  assert.equal(late.get('memberships/sub_member_1').startedAt, at(T0 + 60));
});

test('a member recorded before the ledger whose renewal fails and is then paid only renews: it never starts, so it is not counted as new', async () => {
  const store = memoryStore();
  store.put('memberships/sub_member_1', { subscriptionId: 'sub_member_1', plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, currentPeriodEnd: at(T0), link: { status: 'unlinked' }, statusEventCreated: T0 - YEAR, livemode: true });
  // An expired card on the annual renewal, then the retry succeeds.
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_expired_card', type: 'invoice.payment_failed', reason: 'subscription_cycle', created: T0 + 60, invoice: 'in_guard_second', paid: 0 }), LATER);
  const failed = store.get('memberships/sub_member_1');
  assert.deepEqual([failed.status, failed.preLedger, failed.provisionalStartedAt, failed.ledgerVersion, failed.periods], ['past_due', true, at(T0 - YEAR), 1, []]);
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_retry_paid', reason: 'subscription_cycle', created: T0 + 3 * 86400, invoice: 'in_guard_second' }), LATER);
  const renewed = store.get('memberships/sub_member_1');
  assert.deepEqual(events(store).map(event => event.type), ['membership.payment_failed', 'membership.renewed'], 'one Stripe event never writes both renewed and started');
  assert.deepEqual([renewed.status, renewed.startedAt, renewed.startedEventId, renewed.renewalCount, renewed.preLedger, renewed.provisionalStartedAt], ['active', undefined, undefined, 1, true, at(T0 - YEAR)]);
  const summary = garageGuardSummary([{ ...renewed, id: 'sub_member_1' }], { startAt: at(T0), endAt: at(T0 + 30 * 86400), asOf: LATER });
  assert.deepEqual([summary.members.started, summary.members.activeAtStart, summary.members.activeAtStartProvisional, summary.renewals.renewed, summary.coverage.counts.provisionalStart], [0, 1, 1, 1, 1]);
  // A ledger member whose activating payment failed to record cannot prove it was never active either.
  const gap = memoryStore();
  await webhookApply(gap, invoiceEvent({ id: 'evt_guard_first_failure', type: 'invoice.payment_failed', reason: 'subscription_create', created: T0, paid: 0 }), LATER);
  const input = garageGuardEvent(invoiceEvent({ id: 'evt_guard_unrecorded_paid', reason: 'subscription_create', created: T0 + 60 }));
  await applyGarageGuardEvent(garageGuardLedgerStore(gap, input, null, LATER), input, { now: LATER, alerts: false });
  await webhookApply(gap, invoiceEvent({ id: 'evt_guard_next_failure', type: 'invoice.payment_failed', reason: 'subscription_cycle', created: T0 + YEAR, invoice: 'in_guard_second', paid: 0 }), LATER);
  await webhookApply(gap, invoiceEvent({ id: 'evt_guard_next_paid', reason: 'subscription_cycle', created: T0 + YEAR + 60, invoice: 'in_guard_second', periodEnd: T0 + 2 * YEAR }), LATER);
  assert.deepEqual(events(gap).map(event => event.type), ['membership.payment_failed', 'membership.payment_failed', 'membership.renewed']);
  assert.deepEqual([gap.get('memberships/sub_member_1').startedAt, gap.get('memberships/sub_member_1').ledgerError.eventId], [undefined, 'evt_guard_unrecorded_paid']);
});

test('a renewal closes the used period with breakage, opens the next and writes membership.renewed', async () => {
  const store = await member();
  completeVisit(store);
  assert.equal((await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, '2026-10-05T19:00:00.000Z')).allocatedCents, 20000);
  const renewedAt = T0 + YEAR - 3600;
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_renewal', reason: 'subscription_cycle', created: renewedAt, invoice: 'in_guard_second', periodEnd: T0 + 2 * YEAR, paid: 85000, total: 85000, due: 85000, discount: 0 }), LATER);
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual(membership.periods.map(period => [period.status, period.closeReason, period.paidCents, period.recognizedCents, period.breakageCents, period.visitsUsed, period.visitsIncluded]),
    [['closed', 'renewed', 80000, 20000, 60000, 1, 4], ['open', null, 85000, 0, null, 0, 4]], 'three unused visits become breakage on the renewal date');
  assert.deepEqual([membership.periods[0].closedAt, membership.renewalCount, membership.lastRenewedAt, membership.visitsRemaining, membership.lifetimePaidCents], [at(renewedAt), 1, at(renewedAt), 4, 165000]);
  const renewal = events(store).find(event => event.type === 'membership.renewed');
  assert.deepEqual([renewal.occurredAt, renewal.data], [at(renewedAt), { amountCents: 85000, discountCents: 0, breakageCents: 60000, plan: 'guard' }]);
  assert.equal(store.get('jobs/job-root').garageGuard.visitsRemaining, 4, 'the renewal restores the mirrored visits');
  // A proration invoice pays into the open period; an old period's invoice does not.
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_upgrade', reason: 'subscription_update', created: renewedAt + 100, invoice: 'in_guard_proration', periodEnd: T0 + 2 * YEAR, paid: 5000, total: 5000, due: 5000, discount: 0 }), LATER);
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_old_cycle', reason: 'subscription_cycle', created: renewedAt + 200, invoice: 'in_guard_ancient', periodEnd: T0, paid: 1000, total: 1000, due: 1000, discount: 0 }), LATER);
  const after = store.get('memberships/sub_member_1');
  assert.deepEqual([after.periods.length, after.periods[1].paidCents, after.periods[1].invoiceIds, after.lifetimePaidCents, after.renewalCount], [2, 90000, ['in_guard_second', 'in_guard_proration'], 171000, 1]);
});

test('payment failures and cancellations are classed: requested is voluntary, failed payments involuntary, with breakage on the cancel date', async () => {
  const cases = [
    ['cancellation_requested', false, 'voluntary', 'stripe_reason', undefined],
    ['payment_failed', true, 'involuntary', 'stripe_reason', 'system'],
    [null, true, 'involuntary', 'past_due_status', 'system'],
    [null, false, 'voluntary', 'active_status', undefined],
  ];
  for (const [reason, failed, expected, source, initiatedBy] of cases) {
    const store = await member();
    completeVisit(store, 'job-visit-1', at(T0 + 500));
    await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, at(T0 + 600));
    if (failed) await webhookApply(store, invoiceEvent({ id: 'evt_guard_failed', type: 'invoice.payment_failed', reason: 'subscription_cycle', created: T0 + 1000, invoice: 'in_guard_second', paid: 0, due: 80000, attempt: 3, nextAttempt: T0 + 90000 }), LATER);
    await webhookApply(store, deletedEvent({ reason, created: T0 + 2000 }), LATER);
    const membership = store.get('memberships/sub_member_1'), types = events(store).map(event => event.type), cancelled = events(store).find(event => event.type === 'membership.cancelled');
    assert.deepEqual([membership.status, membership.churn.class, membership.churn.source, membership.churn.statusAtCancel, membership.churn.at], ['cancelled', expected, source, failed ? 'past_due' : 'active', at(T0 + 2000)], `${reason}/${failed}`);
    assert.deepEqual(cancelled.data, { churnClass: expected, breakageCents: 60000, plan: 'guard', ...(initiatedBy ? { initiatedBy } : {}) });
    assert.deepEqual(membership.periods.map(period => [period.status, period.closeReason, period.breakageCents, period.closedAt]), [['closed', 'cancelled', 60000, at(T0 + 2000)]]);
    assert.equal(store.get(`stripe_events/evt_guard_deleted`).churnClass, expected);
    if (failed) {
      assert.deepEqual(types, ['membership.started', 'membership.visit_used', 'membership.payment_failed', 'membership.cancelled']);
      assert.deepEqual(events(store)[2].data, { amountCents: 80000, plan: 'guard' });
      assert.deepEqual([membership.paymentFailureCount, membership.lastPaymentFailure.attemptCount, membership.lastPaymentFailure.nextPaymentAttemptAt, membership.lastPaymentFailure.amountDueCents], [1, 3, at(T0 + 90000), 80000]);
    }
    // Cancellation is terminal: a later failure or deletion adds no event and no second churn.
    await webhookApply(store, invoiceEvent({ id: 'evt_guard_late_failure', type: 'invoice.payment_failed', created: T0 + 3000, invoice: 'in_guard_third' }), LATER);
    await webhookApply(store, deletedEvent({ id: 'evt_guard_deleted_again', reason, created: T0 + 4000 }), LATER);
    assert.equal(events(store).length, types.length); assert.equal(store.get('memberships/sub_member_1').churn.at, at(T0 + 2000));
  }
});

test('a browser edit of the mirrored garageGuard is flagged on the next Stripe event and kept until reconciled', async () => {
  const store = await member();
  // employee-suite.js opsSetCustomerMembership replaces the whole map.
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 2, nextVisit: '2026-11-02', updatedAt: NOW, updatedBy: 'alexk', source: 'hub_manual' } });
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_failed', type: 'invoice.payment_failed', created: T0 + 1000, invoice: 'in_guard_second', paid: 0 }), LATER);
  const flag = store.get('memberships/sub_member_1').manualEdit;
  assert.deepEqual({ status: flag.status, fields: flag.fields, rewritten: flag.rewritten, observed: flag.observed, expected: flag.expected, detectedBy: flag.detectedBy, first: flag.firstDetectedAt },
    { status: 'open', fields: ['visitsRemaining'], rewritten: true, observed: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 2, source: 'hub_manual', updatedBy: 'alexk', updatedAt: NOW }, expected: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4 }, detectedBy: 'stripe_event:evt_guard_failed', first: LATER });
  assert.equal(store.get('jobs/job-root').garageGuard.visitsRemaining, 2, 'the manager count is still shown until someone reconciles it');
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_paid_retry', type: 'invoice.paid', reason: 'subscription_update', created: T0 + 2000, invoice: 'in_guard_second' }), '2027-12-02T12:00:00.000Z');
  const again = store.get('memberships/sub_member_1').manualEdit;
  assert.deepEqual([again.firstDetectedAt, again.detectedAt, again.detectedBy], [LATER, '2027-12-02T12:00:00.000Z', 'stripe_event:evt_guard_paid_retry']);
  assert.equal(store.get('jobs/job-root').garageGuard.source, 'stripe', 'the Stripe mirror rewrote the map but kept the manual count, so the flag stays open');
  // Review finding: a browser save that only changed nextVisit or renewalDate rewrites the map but is not drift; the next server mirror restores the rest.
  assert.equal(garageGuardDrift({ plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, nextVisit: '2026-12-01', source: 'hub_manual' }, store.get('memberships/sub_member_1')), null, 'matching plan, status and counts are not a manual edit');
  assert.deepEqual(garageGuardDrift({ plan: 'guard', status: 'paused', visitsIncluded: 4, visitsRemaining: 4, source: 'hub_manual' }, store.get('memberships/sub_member_1')), { fields: ['status'], rewritten: true, observed: { plan: 'guard', status: 'paused', visitsIncluded: 4, visitsRemaining: 4, source: 'hub_manual', updatedBy: null, updatedAt: null }, expected: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4 } });
  assert.equal(garageGuardDrift({ nextVisit: '2026-10-05' }, { plan: 'guard', link: { status: 'linked' } }), null, 'nothing is compared before the server has mirrored the membership');
});

test('a ledger failure never blocks recording the membership; the gap is kept on the membership and receipt', async () => {
  const store = memoryStore(), event = checkoutEvent(), input = garageGuardEvent(event);
  const result = await applyGarageGuardEvent(garageGuardLedgerStore(store, input, null, LATER), input, { now: LATER, alerts: false });
  assert.equal(result.status, 'applied');
  assert.deepEqual([store.get('memberships/sub_member_1').status, store.get('memberships/sub_member_1').ledgerError, store.get('stripe_events/evt_guard_checkout').ledgerError], ['active', { eventId: 'evt_guard_checkout', at: LATER, code: 'ledger_failed' }, { eventId: 'evt_guard_checkout', at: LATER, code: 'ledger_failed' }]);
  assert.equal(store.collection('funnelEvents').length, 0);
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5 }), LATER);
  assert.equal(store.get('memberships/sub_member_1').ledgerError.eventId, 'evt_guard_checkout', 'a later event does not hide the missing one');
  // An event id Stripe would never send is recorded without funnel events, and says so.
  const odd = memoryStore(); await webhookApply(odd, checkoutEvent({ id: 'evt_x' }), LATER);
  assert.deepEqual([odd.collection('funnelEvents').length, odd.get('stripe_events/evt_x').funnelEventsSkipped], [0, 'invalid_stripe_id']);
  // Alert claims and settlements pass through the ledger store untouched.
  const wrapped = garageGuardLedgerStore(odd, input, garageGuardBilling(event), LATER);
  await wrapped.commit([{ collection: 'stripe_events', id: 'evt_x', revision: odd.revisionOf('stripe_events/evt_x'), patch: { alert: { status: 'sending' } } }]);
  assert.deepEqual(odd.commits.at(-1), ['stripe_events/evt_x']);
});

test('a stale membership read makes the event retry with a fresh ledger, so visits and amounts are never lost', async () => {
  const store = await member();
  completeVisit(store);
  // A member visit is counted after the webhook read the membership and before it commits (with its mirror onto the account job, as applyMembershipVisit writes it).
  store.raceNextCommit(() => {
    store.put('memberships/sub_member_1', { ...store.get('memberships/sub_member_1'), visitsRemaining: 3, periods: [{ ...store.get('memberships/sub_member_1').periods[0], visitsUsed: 1, recognizedCents: 20000, visits: [{ jobId: 'job-visit-1', allocatedCents: 20000 }] }] });
    store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { ...store.get('jobs/job-root').garageGuard, visitsRemaining: 3, updatedBy: 'garage_guard_visit' } });
  });
  await webhookApply(store, deletedEvent({ created: T0 + 2000 }), LATER);
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual([membership.status, membership.periods[0].recognizedCents, membership.periods[0].breakageCents, membership.periods[0].visits.length], ['cancelled', 20000, 60000, 1]);
  assert.equal(events(store).filter(event => event.type === 'membership.cancelled').length, 1);
});

test('the A8 summary counts members, churn by class, renewals, utilization and revenue, and reports what it cannot know', () => {
  const startAt = '2027-01-01T07:00:00.000Z', endAt = '2027-02-01T07:00:00.000Z', inJan = '2027-01-15T18:00:00.000Z', dec = '2026-12-10T18:00:00.000Z';
  // Periods the ledger tracked throughout (GARAGE_GUARD_VISIT_TRACKING_ENABLED on at each of their Stripe events).
  const period = extra => ({ id: 'in_x', status: 'open', paidCents: 120000, periodStart: '2026-06-01T12:00:00.000Z', periodEnd: '2027-06-01T12:00:00.000Z', visitsIncluded: 4, visitsTracked: true, visitsUsed: 0, recognizedCents: 0, visits: [], adjustments: [], ...extra });
  const rows = [
    { id: 'sub_a', status: 'active', startedAt: dec, lifetimePaidCents: 120000, lifetimePaidComplete: true, invoices: [{ invoiceId: 'in_a', paidAt: dec, amountPaidCents: 120000 }], periods: [period({ visitsUsed: 1, recognizedCents: 30000, visits: [{ jobId: 'j1', usedAt: inJan, allocatedCents: 30000 }] })] },
    { id: 'sub_b', status: 'active', startedAt: inJan, lifetimePaidCents: 80000, lifetimePaidComplete: true, invoices: [{ invoiceId: 'in_b', paidAt: inJan, amountPaidCents: 80000 }], periods: [period({ paidCents: 80000, periodStart: '2027-01-15T18:00:00.000Z', periodEnd: '2028-01-15T18:00:00.000Z' })] },
    { id: 'sub_c', status: 'cancelled', startedAt: '2026-01-10T12:00:00.000Z', churn: { class: 'voluntary', at: inJan }, periods: [period({ status: 'closed', closedAt: inJan, closeReason: 'cancelled', periodEnd: '2027-01-10T12:00:00.000Z', visitsUsed: 2, recognizedCents: 40000, breakageCents: 40000, paidCents: 80000 })] },
    { id: 'sub_d', status: 'cancelled', startedAt: '2026-02-10T12:00:00.000Z', churn: { class: 'involuntary', at: inJan }, periods: [] },
    { id: 'sub_e', status: 'past_due', startedAt: '2026-01-20T12:00:00.000Z', invoices: [{ invoiceId: 'in_e', paidAt: '2027-01-20T12:00:00.000Z', amountPaidCents: null }],
      periods: [period({ status: 'closed', closeReason: 'renewed', closedAt: '2027-01-20T12:00:00.000Z', periodEnd: '2027-01-20T12:00:00.000Z', visitsUsed: 4, recognizedCents: 120000, breakageCents: 0 }), period({ paidCents: null, periodStart: '2027-01-20T12:00:00.000Z', periodEnd: '2028-01-20T12:00:00.000Z' })] },
    { id: 'sub_legacy', status: 'active', periods: [], manualEdit: { status: 'open' } },
    { id: 'sub_pending', status: 'pending', periods: [] },
  ];
  const summary = garageGuardSummary(rows, { startAt, endAt, asOf: '2027-01-31T12:00:00.000Z' });
  assert.deepEqual(summary.members, { total: 7, active: 3, pastDue: 1, pending: 1, cancelled: 2, started: 1, cancelledInPeriod: 2, activeAtStart: 4, activeAtStartProvisional: 0 });
  assert.deepEqual(summary.churn, { voluntary: 1, involuntary: 1, unknown: 0, ofActiveAtStart: 2, startedInPeriod: 0, rate: 0.5, voluntaryRate: 0.25, involuntaryRate: 0.25, atRiskPastDue: 1 });
  assert.deepEqual(summary.renewals, { due: 2, renewed: 1, lapsed: 1, awaitingPayment: 0, rate: 0.5 });
  // Second review: sub_legacy is live with no billing period (recorded before FUN-20), so the visits it used in January, and their revenue, are unknown.
  assert.deepEqual(summary.visits, { usedInPeriod: null, knownUsedInPeriod: 1, closedPeriods: { count: 2, included: 8, used: 6, utilization: 0.75 }, openPeriods: { count: 3, included: 12, used: 1, utilization: 0.0833 } });
  // Review finding: a total with any unknown contribution is null (sub_e's cash, sub_e and sub_legacy's deferred revenue and MRR, sub_legacy's visits), never a partial sum; the known parts are a floor.
  assert.deepEqual(summary.revenue, { subscriptionCashCents: null, visitRevenueCents: null, adjustmentRevenueCents: 0, breakageCents: 40000, recognizedCents: null, deferredCents: null, mrrCents: null,
    memberLtv: { basis: 'revenue', members: 2, totalCents: 200000, averageCents: 100000 },
    knownCents: { subscriptionCashCents: 80000, visitRevenueCents: 30000, adjustmentRevenueCents: 0, breakageCents: 40000, recognizedCents: 70000, deferredCents: 90000 + 80000, mrrCents: 10007 + 6671 } }, 'LTV to date counts only members whose every payment the ledger holds');
  assert.deepEqual(summary.coverage.counts, { noLedger: 1, unknownStart: 1, provisionalStart: 0, unknownChurnPopulation: 0, unknownCash: 1, unknownAllocation: 0, unknownBreakage: 0, unknownDeferred: 2, unknownMrr: 2, unknownIncluded: 0, unknownUsed: 0, unknownVisits: 1, visitsUntracked: 0, unknownLifetime: 4, manualEdits: 1, ledgerErrors: 0 });
  assert.equal(summary.coverage.complete, false);
  assert.deepEqual(summary.coverage.reasons, ['noLedger', 'unknownStart', 'unknownCash', 'unknownDeferred', 'unknownMrr', 'unknownVisits', 'unknownLifetime', 'manualEdits']);
  // Without it every period overlapping January held all of its visits (sub_e's unknown amount leaves no visit unpriced in the range), so the visit revenue is known.
  const held = garageGuardSummary(rows.filter(row => row.id !== 'sub_legacy'), { startAt, endAt, asOf: '2027-01-31T12:00:00.000Z' });
  assert.deepEqual([held.visits.usedInPeriod, held.revenue.visitRevenueCents, held.revenue.recognizedCents, held.coverage.counts.unknownVisits], [1, 30000, 70000, 0]);
  assert.deepEqual(summary.coverage.excluded, { testMode: 0 });
  assert.deepEqual([membershipDeferred(rows[0]), membershipDeferred(rows[5]), membershipDeferred(rows[3])], [{ cents: 90000, known: true }, { cents: null, known: false }, { cents: 0, known: true }]);
  const empty = garageGuardSummary([], { startAt, endAt, asOf: endAt });
  assert.deepEqual([empty.churn.rate, empty.renewals.rate, empty.visits.closedPeriods.utilization, empty.coverage.complete], [null, null, null, true], 'no denominator is a null rate, never 0%');
  assert.equal(account()['jobs/job-root'].type, 'job');
});

test('churn rates count only cancellations of members live at the period start; unplaced starts, unallocated visits and test mode are reported, never mixed in', () => {
  const startAt = '2027-01-01T07:00:00.000Z', endAt = '2027-02-01T07:00:00.000Z', inJan = '2027-01-15T18:00:00.000Z', seconds = value => Math.floor(Date.parse(value) / 1000);
  // Review repro: one member live at the start plus two pre-FUN-20 cancellations gave a 200% churn rate.
  const repro = garageGuardSummary([
    { id: 'sub_new', status: 'active', startedAt: '2026-12-01T12:00:00.000Z', livemode: true },
    { id: 'sub_old_1', status: 'cancelled', preLedger: true, cancelledAt: inJan, churn: { class: 'voluntary', at: inJan }, livemode: true },
    { id: 'sub_old_2', status: 'cancelled', cancelledAt: inJan, livemode: true },
  ], { startAt, endAt, asOf: endAt });
  assert.deepEqual([repro.churn.rate, repro.churn.ofActiveAtStart, repro.members.cancelledInPeriod, repro.churn.voluntary, repro.churn.unknown, repro.coverage.counts.unknownChurnPopulation, repro.coverage.complete], [0, 0, 2, 1, 1, 2, false]);
  const rows = [
    // Recorded before the ledger and still live: live at least since the Stripe event that set its status; its renewal is due in the period.
    { id: 'sub_legacy', status: 'active', statusEventCreated: seconds('2026-11-01T12:00:00.000Z'), currentPeriodEnd: '2027-01-20T12:00:00.000Z', periods: [], unallocatedVisits: [{ jobId: 'job-legacy', usedAt: inJan, allocatedCents: null }], livemode: true },
    // Recorded before the ledger, which saved its live-since bound; its pre-ledger year closed as a stub when it cancelled.
    { id: 'sub_legacy_gone', status: 'cancelled', preLedger: true, provisionalStartedAt: '2026-06-01T12:00:00.000Z', churn: { class: 'involuntary', at: inJan }, livemode: true,
      periods: [{ id: 'pre_ledger', status: 'closed', preLedger: true, periodEnd: '2027-01-10T12:00:00.000Z', visitsIncluded: 4, visitsUsed: null, paidCents: null, recognizedCents: null, breakageCents: null, closedAt: inJan, closeReason: 'cancelled', visits: [], adjustments: [] }] },
    // Joined and left inside the period: outside the rate by definition.
    { id: 'sub_brief', status: 'cancelled', startedAt: '2027-01-05T12:00:00.000Z', churn: { class: 'voluntary', at: inJan }, livemode: true, lifetimePaidCents: 45000, lifetimePaidComplete: true, invoices: [{ invoiceId: 'in_brief', paidAt: '2027-01-05T12:00:00.000Z', amountPaidCents: 45000 }] },
    // A live-since bound inside the period cannot say whether the member was live at its start.
    { id: 'sub_unplaced', status: 'cancelled', preLedger: true, provisionalStartedAt: '2027-01-03T12:00:00.000Z', churn: { class: 'voluntary', at: inJan }, livemode: true },
    { id: 'sub_known', status: 'active', startedAt: '2026-10-01T12:00:00.000Z', livemode: true, lifetimePaidCents: 80000, lifetimePaidComplete: true, invoices: [{ invoiceId: 'in_known', paidAt: '2026-10-01T12:00:00.000Z', amountPaidCents: 80000 }],
      periods: [{ id: 'in_known', status: 'open', paidCents: 80000, periodStart: '2026-10-01T12:00:00.000Z', periodEnd: '2027-10-01T12:00:00.000Z', visitsIncluded: 4, visitsTracked: true, visitsUsed: 0, recognizedCents: 0, visits: [], adjustments: [] }] },
    // Stripe test mode is never business data.
    { id: 'sub_test', status: 'cancelled', startedAt: '2026-10-01T12:00:00.000Z', churn: { class: 'voluntary', at: inJan }, livemode: false, invoices: [{ invoiceId: 'in_test', paidAt: inJan, amountPaidCents: 99900 }] },
  ];
  const summary = garageGuardSummary(rows, { startAt, endAt, asOf: endAt });
  assert.deepEqual(summary.members, { total: 5, active: 2, pastDue: 0, pending: 0, cancelled: 3, started: 1, cancelledInPeriod: 3, activeAtStart: 3, activeAtStartProvisional: 2 });
  assert.deepEqual(summary.churn, { voluntary: 2, involuntary: 1, unknown: 0, ofActiveAtStart: 1, startedInPeriod: 1, rate: 0.3333, voluntaryRate: 0, involuntaryRate: 0.3333, atRiskPastDue: 0 });
  assert.deepEqual(summary.renewals, { due: 2, renewed: 0, lapsed: 1, awaitingPayment: 1, rate: 0 });
  assert.deepEqual([summary.visits.knownUsedInPeriod, summary.visits.closedPeriods], [1, { count: 1, included: 0, used: 0, utilization: null }], 'a visit taken with no open period is still a used visit');
  // Second review: sub_legacy has no billing period, sub_legacy_gone's stub overlaps January, and sub_unplaced (recorded before FUN-20, live
  // in January until it cancelled) has no ledger year at all, so the visits used in it are unknown, not 1.
  assert.deepEqual([summary.visits.usedInPeriod, summary.revenue.visitRevenueCents, summary.revenue.recognizedCents, summary.coverage.counts.unknownVisits], [null, null, null, 3]);
  assert.deepEqual([summary.revenue.subscriptionCashCents, summary.revenue.memberLtv], [45000, { basis: 'revenue', members: 2, totalCents: 125000, averageCents: 62500 }]);
  assert.deepEqual(summary.coverage.excluded, { testMode: 1 });
  const counts = summary.coverage.counts;
  assert.deepEqual([counts.provisionalStart, counts.unknownChurnPopulation, counts.unknownAllocation, counts.unknownUsed, counts.unknownBreakage, counts.unknownStart, counts.unknownLifetime, counts.noLedger], [2, 1, 1, 1, 1, 0, 3, 1]);
  assert.deepEqual([memberStart(rows[0]), memberStart(rows[2]), memberStart({ status: 'cancelled' })], [{ at: '2026-11-01T12:00:00.000Z', provisional: true }, { at: '2027-01-05T12:00:00.000Z', provisional: false }, null]);
});

// Second review: a period the ledger did not see every visit of has unknown breakage, deferred revenue and utilization.
const browserCount = (store, visitsRemaining) => { const root = store.get('jobs/job-root'); store.put('jobs/job-root', { ...root, garageGuard: { ...root.garageGuard, visitsRemaining, source: 'hub_manual', membershipId: undefined, updatedBy: 'alexk', updatedAt: NOW } }); };
const renewal = (extra = {}) => invoiceEvent({ id: 'evt_guard_renewal', reason: 'subscription_cycle', created: T0 + YEAR, invoice: 'in_guard_second', periodEnd: T0 + 2 * YEAR, livemode: true, ...extra });

test('visits counted only in the browser dialog leave the closing year\'s breakage unknown, and the event leaves it out', async () => {
  // Review repro (probe H): the manager records 2 of 4 visits in the browser, then the member cancels.
  const store = await member(undefined, { livemode: true });
  browserCount(store, 2);
  const cancelAt = T0 + 90 * 86400;
  await webhookApply(store, deletedEvent({ created: cancelAt, livemode: true }), at(cancelAt + 60));
  const [period] = store.get('memberships/sub_member_1').periods;
  assert.deepEqual([period.status, period.paidCents, period.recognizedCents, period.breakageCents, period.breakageUnknown, period.countsAtClose],
    ['closed', 80000, 0, null, 'manual_edit', { membershipVisitsRemaining: 4, accountVisitsRemaining: 2, manualEditOpen: false }]);
  assert.deepEqual(events(store).find(event => event.type === 'membership.cancelled').data, { churnClass: 'voluntary', plan: 'guard' }, 'unknown breakage is never written as the whole price');
  const summary = garageGuardSummary(store.collection('memberships'), { startAt: at(T0), endAt: at(T0 + 120 * 86400), asOf: at(T0 + 120 * 86400) });
  assert.deepEqual([summary.revenue.breakageCents, summary.revenue.recognizedCents, summary.revenue.knownCents.breakageCents, summary.visits.closedPeriods, summary.coverage.counts.unknownBreakage, summary.coverage.counts.unknownUsed, summary.coverage.complete],
    [null, null, 0, { count: 1, included: 0, used: 0, utilization: null }, 1, 1, false], 'unknown breakage is a null total, never 0');

  // The same count at a renewal: the old year's breakage is unknown, the new year starts from the Stripe count, and nothing stays flagged (review finding: the renewal's own mirror settles it).
  const renewing = await member(undefined, { livemode: true });
  browserCount(renewing, 2);
  await webhookApply(renewing, renewal(), at(T0 + YEAR + 60));
  const renewed = renewing.get('memberships/sub_member_1');
  assert.deepEqual(renewed.periods.map(item => [item.status, item.breakageCents, item.breakageUnknown, item.visitsTracked]), [['closed', null, 'manual_edit', true], ['open', null, null, true]]);
  assert.deepEqual(renewed.periods[0].countsAtClose, { membershipVisitsRemaining: 4, accountVisitsRemaining: 2, manualEditOpen: false });
  assert.deepEqual(events(renewing).find(event => event.type === 'membership.renewed').data, { amountCents: 80000, discountCents: 10000, plan: 'guard' });
  assert.deepEqual([renewed.visitsRemaining, renewing.get('jobs/job-root').garageGuard.visitsRemaining, renewed.manualEdit], [4, 4, undefined]);
  const view = await garageGuardOverview(renewing, owner, { period: 'custom', from: '2027-09-23', to: '2027-10-01' }, new Date(at(T0 + YEAR + 3600)));
  assert.deepEqual([view.counts.manualEdits, view.summary.coverage.counts.manualEdits], [0, 0]);

  // A flag an earlier event opened is resolved by the renewal that settles the count; the closed year keeps the dispute.
  const flagged = await member(undefined, { livemode: true });
  browserCount(flagged, 2);
  await webhookApply(flagged, renewal({ id: 'evt_guard_renewal_failed', type: 'invoice.payment_failed', paid: 0 }), at(T0 + YEAR + 60));
  assert.equal(flagged.get('memberships/sub_member_1').manualEdit.status, 'open');
  await webhookApply(flagged, renewal({ id: 'evt_guard_renewal_retry', created: T0 + YEAR + 3 * 86400 }), at(T0 + YEAR + 3 * 86400 + 60));
  const settled = flagged.get('memberships/sub_member_1');
  assert.deepEqual([settled.manualEdit.status, settled.manualEdit.resolution, settled.manualEdit.resolvedBy, settled.manualEdit.resolvedPeriodId, settled.manualEdit.fields], ['resolved', 'renewal_reset', 'stripe_webhook', 'checkout:evt_guard_checkout', ['visitsRemaining']]);
  assert.deepEqual([settled.periods[0].breakageCents, settled.periods[0].breakageUnknown, settled.periods[0].countsAtClose.manualEditOpen], [null, 'manual_edit', true]);
});

test('periods the ledger did not track throughout report utilization, deferred revenue and breakage as unknown, never as 0% used', async () => {
  // Review repro (probe I): visit tracking off; the open year was 100% deferred and 0% used with coverage complete.
  const off = await member(undefined, { livemode: true, visitTracking: false });
  const membership = off.get('memberships/sub_member_1');
  assert.equal(membership.periods[0].visitsTracked, false);
  assert.deepEqual(membershipDeferred(membership), { cents: null, known: false });
  const summary = garageGuardSummary(off.collection('memberships'), { startAt: at(T0), endAt: at(T0 + 200 * 86400), asOf: at(T0 + 200 * 86400) });
  // Review finding: with tracking off (the production default) every total the untracked year feeds is null, never 0. No year closed in the
  // range, so its breakage is a known 0; its visits (so the revenue they recognized) are unknown (second review).
  assert.deepEqual([summary.revenue.deferredCents, summary.revenue.breakageCents, summary.revenue.recognizedCents, summary.revenue.visitRevenueCents, summary.visits.usedInPeriod, summary.visits.openPeriods, summary.coverage.counts.visitsUntracked, summary.coverage.counts.unknownDeferred, summary.coverage.counts.unknownVisits, summary.coverage.complete],
    [null, 0, null, null, null, { count: 1, included: 0, used: 0, utilization: null }, 1, 1, 1, false]);
  assert.ok(summary.coverage.reasons.includes('visitsUntracked'));
  assert.equal(summary.revenue.mrrCents > 0, true, 'what the ledger does know (the price) is still reported');
  // Switching tracking on does not make that year known; the year opened with it on is tracked.
  await webhookApply(off, renewal(), at(T0 + YEAR + 60));
  const renewed = off.get('memberships/sub_member_1');
  assert.deepEqual(renewed.periods.map(item => [item.status, item.visitsTracked, item.breakageCents, item.breakageUnknown]), [['closed', false, null, 'visits_untracked'], ['open', true, null, null]]);
  assert.equal('breakageCents' in events(off).find(event => event.type === 'membership.renewed').data, false);
  // A period tracked when it opened but not at a later Stripe event is untracked for good.
  const toggled = await member(undefined, { livemode: true });
  await webhookApply(toggled, invoiceEvent({ id: 'evt_guard_failed', type: 'invoice.payment_failed', created: T0 + 1000, invoice: 'in_guard_second', paid: 0, livemode: true }), LATER, { visitTracking: false });
  await webhookApply(toggled, deletedEvent({ created: T0 + 2000, livemode: true }), LATER);
  assert.deepEqual(toggled.get('memberships/sub_member_1').periods.map(item => [item.visitsTracked, item.breakageCents, item.breakageUnknown]), [[false, null, 'visits_untracked']]);
});

test('a disputed charge is not breakage: the cancelled year keeps its breakage unknown', async () => {
  // Review repro (probe C): a payment_disputed cancellation booked the whole unused year as breakage revenue.
  const store = await member(undefined, { livemode: true });
  completeVisit(store, 'job-visit-1', at(T0 + 500));
  await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, at(T0 + 600));
  store.put('jobs/job-late', { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', membershipId: 'sub_member_1', visitPurpose: 'member_visit', status: 'completed', completedAt: at(T0 + 1500) });
  await webhookApply(store, deletedEvent({ reason: 'payment_disputed', feedback: null, created: T0 + 2000, livemode: true }), at(T0 + 2100));
  const [period] = store.get('memberships/sub_member_1').periods;
  assert.deepEqual([period.recognizedCents, period.breakageCents, period.breakageUnknown, store.get('memberships/sub_member_1').churn.class], [20000, null, 'payment_disputed', 'involuntary']);
  assert.deepEqual(events(store).find(event => event.type === 'membership.cancelled').data, { churnClass: 'involuntary', initiatedBy: 'system', plan: 'guard' });
  // A visit from before the cancellation applied later is visit revenue, and the breakage stays unknown.
  const late = await applyMembershipVisit(store, owner, { jobId: 'job-late' }, at(T0 + 3000));
  assert.deepEqual([late.status, late.allocatedCents, store.get('memberships/sub_member_1').periods[0].recognizedCents, store.get('memberships/sub_member_1').periods[0].breakageCents], ['applied', 20000, 40000, null]);
});

test('a plan change mid-year is recorded on the period, whose later visit revenue and breakage are then unknown; visits count in the period\'s own order', async () => {
  const upgrade = (id, created) => { const event = invoiceEvent({ id, reason: 'subscription_update', created, invoice: `in_${id.slice(4)}`, plan: 'black', paid: 85000, total: 85000, due: 85000, discount: 0, periodEnd: T0 + YEAR, livemode: true }); Object.assign(event.data.object.lines.data[0], { proration: true, period: { start: created, end: T0 + YEAR } }); return event; };
  const store = await member(undefined, { livemode: true });
  completeVisit(store, 'job-visit-1', at(T0 + 600));
  assert.equal((await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, at(T0 + 700))).allocatedCents, 20000, 'a visit before the change is priced on the plan paid for');
  await webhookApply(store, upgrade('evt_guard_upgrade', T0 + 86400), at(T0 + 86400 + 60));
  const changed = store.get('memberships/sub_member_1'), [open] = changed.periods;
  assert.deepEqual([changed.plan, changed.visitsIncluded, changed.visitsRemaining, open.plan, open.visitsIncluded, open.paidCents, open.planChanges], ['black', 12, 3, 'black', 4, 165000, [{ at: at(T0 + 86400), eventId: 'evt_guard_upgrade', plan: 'black', visitsIncluded: 12 }]]);
  // Review repro (probe B): the next visit was occurrence 10 of the membership (null revenue) and the cancel then booked all 165000 as breakage.
  store.put('jobs/job-visit-2', { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', membershipId: 'sub_member_1', visitPurpose: 'member_visit', status: 'completed', completedAt: at(T0 + 2 * 86400) });
  const second = await applyMembershipVisit(store, owner, { jobId: 'job-visit-2' }, at(T0 + 3 * 86400));
  assert.deepEqual([second.status, second.occurrence, second.allocatedCents, second.visitsRemaining], ['applied', 2, null, 2]);
  assert.deepEqual(membershipDeferred(store.get('memberships/sub_member_1')), { cents: null, known: false });
  // A reconcile moves the period's own count (not 12 - remaining) and recognizes nothing it cannot price.
  const reconciled = await garageGuardAction(store, owner, { action: 'visits.reconcile', requestId: crypto.randomUUID(), membershipId: 'sub_member_1', expectedRevision: store.revisionOf('memberships/sub_member_1'), visitsRemaining: 1, note: 'One visit was done on the phone booking.' }, at(T0 + 4 * 86400));
  assert.deepEqual([reconciled.recognizedCents, store.get('memberships/sub_member_1').periods[0].visitsUsed], [null, 3]);
  await webhookApply(store, deletedEvent({ created: T0 + 10 * 86400, livemode: true }), at(T0 + 10 * 86400 + 60));
  const [closed] = store.get('memberships/sub_member_1').periods;
  assert.deepEqual([closed.recognizedCents, closed.breakageCents, closed.breakageUnknown], [20000, null, 'unknown_allocation']);
  const summary = garageGuardSummary(store.collection('memberships'), { startAt: at(T0), endAt: at(T0 + 30 * 86400), asOf: at(T0 + 30 * 86400) });
  assert.deepEqual([summary.revenue.breakageCents, summary.revenue.visitRevenueCents, summary.revenue.recognizedCents, summary.revenue.knownCents.visitRevenueCents, summary.coverage.counts.unknownAllocation, summary.coverage.counts.unknownBreakage], [null, null, null, 20000, 2, 1]);
  // With no visit after the change, the year's breakage is still known: price paid less what its visits recognized.
  const quiet = await member(undefined, { livemode: true });
  completeVisit(quiet, 'job-visit-1', at(T0 + 600));
  await applyMembershipVisit(quiet, owner, { jobId: 'job-visit-1' }, at(T0 + 700));
  await webhookApply(quiet, upgrade('evt_guard_upgrade', T0 + 86400), at(T0 + 86400 + 60));
  await webhookApply(quiet, deletedEvent({ created: T0 + 10 * 86400, livemode: true }), at(T0 + 10 * 86400 + 60));
  assert.deepEqual([quiet.get('memberships/sub_member_1').periods[0].breakageCents, events(quiet).find(event => event.type === 'membership.cancelled').data.breakageCents], [145000, 145000]);
});

test('a period starts where its subscription line does; an invoice item swept into the renewal invoice never moves it', async () => {
  const swept = { type: 'invoiceitem', subscription: 'sub_member_1', period: { start: T0 + YEAR - 150 * 86400, end: T0 + YEAR - 150 * 86400 }, amount: 5000 };
  const classic = renewal(); classic.data.object.lines.data.push(swept);
  assert.equal(garageGuardBilling(classic).periodStart, at(T0 + YEAR));
  // Newer API versions describe lines by parent.
  const basil = renewal(); basil.data.object.lines.data = [
    { parent: { type: 'invoice_item_details', invoice_item_details: { subscription: 'sub_member_1', proration: false } }, period: { start: T0 + YEAR - 150 * 86400, end: T0 + YEAR - 150 * 86400 } },
    { parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_member_1', proration: true } }, period: { start: T0 + YEAR - 100 * 86400, end: T0 + YEAR } },
    { parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_member_1', proration: false } }, period: { start: T0 + YEAR, end: T0 + 2 * YEAR } },
  ];
  assert.equal(garageGuardBilling(basil).periodStart, at(T0 + YEAR));
  // Review repro (probe E): the invoice item moved the new year's start back 150 days and a previous-year visit applied after the renewal was charged to the new year.
  const store = await member(undefined, { livemode: true });
  await webhookApply(store, classic, at(T0 + YEAR + 60));
  completeVisit(store, 'job-visit-1', at(T0 + YEAR - 30 * 86400));
  const applied = await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, at(T0 + YEAR + 3600));
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual([membership.periods[1].periodStart, applied.periodClosed, membership.visitsRemaining, membership.periods[0].breakageCents, membership.periods[0].visitsUsed], [at(T0 + YEAR), true, 4, 60000, 1]);
});

test('lifetime paid is complete only once an invoice is on file, and the owner view says when it is not', async () => {
  // Review repro (probe G): a member recorded only from its checkout counted in LTV with 0 cents.
  const store = memoryStore();
  await webhookApply(store, checkoutEvent({ livemode: true }), LATER);
  const checkedOut = store.get('memberships/sub_member_1');
  assert.deepEqual([checkedOut.lifetimePaidCents, checkedOut.lifetimePaidComplete, checkedOut.periods[0].paidCents], [0, false, 80000]);
  const window = { startAt: at(T0 - 86400), endAt: at(T0 + 86400), asOf: at(T0 + 86400) };
  assert.deepEqual([garageGuardSummary(store.collection('memberships'), window).revenue.memberLtv, garageGuardSummary(store.collection('memberships'), window).coverage.counts.unknownLifetime], [{ basis: 'revenue', members: 0, totalCents: 0, averageCents: null }, 1]);
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5, livemode: true }), LATER);
  assert.deepEqual(garageGuardSummary(store.collection('memberships'), window).revenue.memberLtv, { basis: 'revenue', members: 1, totalCents: 80000, averageCents: 80000 });
  const [row] = (await garageGuardOverview(store, owner, { period: 'custom', from: '2026-09-01', to: '2026-10-01' }, new Date(LATER))).memberships;
  assert.deepEqual([row.lifetimePaidCents, row.lifetimePaidComplete, row.preLedger], [80000, true, false]);
  // A member recorded before FUN-20 paid earlier years the ledger never saw.
  const legacy = memoryStore();
  legacy.put('memberships/sub_member_1', { subscriptionId: 'sub_member_1', plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, currentPeriodEnd: at(T0), link: { status: 'unlinked' }, statusEventCreated: T0 - YEAR, livemode: true });
  await webhookApply(legacy, renewal({ created: T0 + 60, periodEnd: T0 + YEAR }), LATER);
  const [old] = (await garageGuardOverview(legacy, owner, {}, new Date(LATER))).memberships;
  assert.deepEqual([old.lifetimePaidCents, old.lifetimePaidComplete, old.preLedger], [80000, false, true]);
  const [hidden] = (await garageGuardOverview(legacy, { user: 'alexk', role: 'manager', businessAccess: true }, {}, new Date(LATER))).memberships;
  assert.deepEqual([hidden.preLedger, 'lifetimePaidCents' in hidden, 'lifetimePaidComplete' in hidden], [true, false, false]);
});

// Third review: every path through the real signed webhook, with the injected clock and GARAGE_GUARD_VISIT_TRACKING_ENABLED on.
const DAY = 86400, manager = { user: 'alexk', role: 'manager', businessAccess: true };
const hookEnv = { STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_garage_guard', GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED: 'true', GARAGE_GUARD_VISIT_TRACKING_ENABLED: 'true', FIREBASE_API_KEY: 'firebase-test-garage-guard-ledger' };
function signedWebhook(t, store, env = hookEnv) {
  let clock = at(T0);
  t.mock.method(globalThis, 'fetch', async input => { throw new Error(`Unexpected network request ${input}`); });
  const handlers = stripeWebhookHandlers({ storage: () => store, now: () => new Date(clock), send: async () => new Response('{}') });
  const post = async event => {
    const signedAt = Math.floor(Date.parse(clock) / 1000), raw = JSON.stringify(event), signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${signedAt}.${raw}`).digest('hex');
    const response = await handlers.post({ env, request: new Request('https://easygaragecleaning.com/api/stripe-webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${signedAt},v1=${signature}` }, body: raw }) });
    return { status: response.status, body: await response.json() };
  };
  // Stripe delivers each event a minute after it was created (or `delay` seconds after, for a redelivery).
  return { deliver: async (event, delay = 60) => { clock = at(event.created + delay); return post(event); } };
}
// A checkout and invoices that carry no email or phone, so the member cannot be matched to anyone (link 'unlinked').
const anonymous = event => { const object = event.data.object; delete object.customer_email; if (object.customer_details) object.customer_details = { name: 'Synthetic Anonymous' }; return event; };

test('a member not linked to a Hub customer (needs review, or no identity) renews and cancels with a full ledger, and its untracked years stay unknown', async t => {
  for (const [label, seed, shape, link] of [['no customer match', (() => { const rows = account(); delete rows['customers/cust-dana']; return rows; })(), event => event, 'needs_review'], ['no identity', account(), anonymous, 'unlinked']]) {
    // Review repro (probe6 W1): every event after the checkout set ledgerError; no renewal or cancellation was recorded and the year stayed open.
    const store = memoryStore(seed), hook = signedWebhook(t, store);
    const responses = [
      await hook.deliver(shape(checkoutEvent({ livemode: true }))),
      await hook.deliver(shape(invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5, livemode: true }))),
      await hook.deliver(shape(renewal())),
      await hook.deliver(shape(deletedEvent({ created: T0 + YEAR + 90 * DAY, livemode: true }))),
    ];
    assert.deepEqual(responses.map(response => [response.status, response.body.membership]), [[200, link], [200, link], [200, link], [200, link]], label);
    const membership = store.get('memberships/sub_member_1');
    assert.deepEqual([membership.status, membership.link.status, membership.ledgerError, membership.renewalCount, membership.churn.class], ['cancelled', link, undefined, 1, 'voluntary'], label);
    for (const id of ['evt_guard_checkout', 'evt_guard_first_invoice', 'evt_guard_renewal', 'evt_guard_deleted']) assert.equal(store.get(`stripe_events/${id}`).ledgerError, undefined, `${label}: ${id}`);
    // The Hub counted no visit of an unlinked member, so neither year's breakage is known, and no year is left open.
    assert.deepEqual(membership.periods.map(period => [period.status, period.closeReason, period.paidCents, period.visitsTracked, period.breakageCents, period.breakageUnknown]),
      [['closed', 'renewed', 80000, false, null, 'visits_untracked'], ['closed', 'cancelled', 80000, false, null, 'visits_untracked']], label);
    assert.deepEqual(events(store).map(event => [event.type, 'breakageCents' in event.data, event.customerId]), [['membership.started', false, null], ['membership.renewed', false, null], ['membership.cancelled', false, null]], label);
    assert.deepEqual(store.visitReads, [], `${label}: an untracked year never needs its visits listed`);
    const summary = garageGuardSummary(store.collection('memberships'), { startAt: at(T0 + YEAR - DAY), endAt: at(T0 + YEAR + 120 * DAY), asOf: at(T0 + YEAR + 120 * DAY) });
    assert.deepEqual([summary.visits.openPeriods.count, summary.visits.closedPeriods, summary.churn.voluntary, summary.renewals.renewed, summary.revenue.breakageCents, summary.coverage.counts.ledgerErrors, summary.coverage.counts.visitsUntracked, summary.coverage.counts.unknownBreakage],
      [0, { count: 2, included: 0, used: 0, utilization: null }, 1, 1, null, 0, 2, 2], label);
  }
  // While open, an unlinked member's year has unknown deferred revenue (never 100% deferred, never 0% used).
  const seed = account(); delete seed['customers/cust-dana'];
  const open = memoryStore(seed), hook = signedWebhook(t, open);
  await hook.deliver(checkoutEvent({ livemode: true }));
  await hook.deliver(invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5, livemode: true }));
  assert.deepEqual([open.get('memberships/sub_member_1').periods[0].visitsTracked, membershipDeferred(open.get('memberships/sub_member_1'))], [false, { cents: null, known: false }]);
});

test('a year that closes with a completed member visit still uncounted keeps its breakage unknown until the visit is counted; a cancelled year still takes its late visits', async t => {
  // Review repro (probe6 W3): the cancel booked 80000 of breakage while a linked visit was waiting, and a visit linked after the cancel was refused.
  const store = await member(undefined, { livemode: true }), hook = signedWebhook(t, store);
  store.put('jobs/job-visit-1', { ...store.get('jobs/job-visit-1'), status: 'completed', pipelineStatus: 'completed', completedAt: at(T0 + 80 * DAY) });
  store.put('jobs/job-visit-2', { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', status: 'completed', pipelineStatus: 'completed', completedAt: at(T0 + 85 * DAY), date: '2026-12-16' });
  store.put('jobs/job-visit-3', { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', status: 'completed', pipelineStatus: 'completed', completedAt: at(T0 + 95 * DAY), date: '2026-12-26' });
  await garageGuardAction(store, manager, { action: 'visit.link', requestId: crypto.randomUUID(), jobId: 'job-visit-1', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-visit-1') }, at(T0 + 86 * DAY));
  assert.deepEqual((await garageGuardOverview(store, owner, { period: 'custom', from: '2026-09-01', to: '2026-12-31' }, new Date(at(T0 + 87 * DAY)))).coverage.reasons, ['visitsUnresolved']);
  assert.equal((await hook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }))).status, 200);
  const cancelled = store.get('memberships/sub_member_1').periods[0];
  assert.deepEqual([cancelled.status, cancelled.visitsTracked, cancelled.visitsUsed, cancelled.breakageCents, cancelled.breakageUnknown, cancelled.unresolvedVisitJobIds], ['closed', true, 0, null, 'visits_unresolved', ['job-visit-1']]);
  assert.deepEqual(events(store).find(event => event.type === 'membership.cancelled').data, { churnClass: 'voluntary', plan: 'guard' }, 'the guessed breakage is left out of the event');
  assert.deepEqual(store.visitReads, ['sub_member_1'], 'the webhook listed the member visits when the tracked year closed');
  const closedSummary = garageGuardSummary(store.collection('memberships'), { startAt: at(T0), endAt: at(T0 + 100 * DAY), asOf: at(T0 + 100 * DAY) });
  assert.deepEqual([closedSummary.revenue.breakageCents, closedSummary.coverage.counts.unknownBreakage, closedSummary.coverage.counts.unknownUsed, closedSummary.visits.closedPeriods.included], [null, 1, 1, 0]);
  // Counting the waiting visit settles the year.
  const first = await garageGuardAction(store, owner, { action: 'visit.apply', requestId: crypto.randomUUID(), jobId: 'job-visit-1' }, at(T0 + 91 * DAY), { visitsEnabled: true });
  assert.deepEqual([first.status, first.periodClosed, first.allocatedCents], ['applied', true, 20000]);
  let period = store.get('memberships/sub_member_1').periods[0];
  assert.deepEqual([period.visitsUsed, period.recognizedCents, period.breakageCents, period.breakageUnknown, period.unresolvedVisitJobIds], [1, 20000, 60000, null, []]);
  // A visit completed in the paid year but linked only after the cancel is still linked and counted there.
  const linked = await garageGuardAction(store, manager, { action: 'visit.link', requestId: crypto.randomUUID(), jobId: 'job-visit-2', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-visit-2') }, at(T0 + 92 * DAY));
  assert.deepEqual([linked.status, linked.completed], ['linked', true]);
  const second = await garageGuardAction(store, owner, { action: 'visit.apply', requestId: crypto.randomUUID(), jobId: 'job-visit-2' }, at(T0 + 92 * DAY), { visitsEnabled: true });
  assert.deepEqual([second.status, second.periodClosed, second.occurrence], ['applied', true, 2]);
  period = store.get('memberships/sub_member_1').periods[0];
  assert.deepEqual([period.visitsUsed, period.recognizedCents, period.breakageCents, store.get('memberships/sub_member_1').visitsRemaining], [2, 40000, 40000, 4]);
  // One completed after the cancellation belongs to no paid year.
  await assert.rejects(garageGuardAction(store, manager, { action: 'visit.link', requestId: crypto.randomUUID(), jobId: 'job-visit-3', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-visit-3') }, at(T0 + 96 * DAY)), { code: 'garage_guard_membership_not_active', status: 409 });

  // A visit the year was waiting on that a manager settles without counting (visits.reconcile jobIds) settles its breakage too.
  const settled = await member(undefined, { livemode: true }), settledHook = signedWebhook(t, settled);
  completeVisit(settled, 'job-visit-1', at(T0 + 40 * DAY));
  assert.equal((await settledHook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }))).status, 200);
  assert.deepEqual(settled.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, ['job-visit-1']);
  await garageGuardAction(settled, manager, { action: 'visits.reconcile', requestId: crypto.randomUUID(), membershipId: 'sub_member_1', expectedRevision: settled.revisionOf('memberships/sub_member_1'), visitsRemaining: 4, note: 'The visit was a warranty call, not a member visit.', jobIds: ['job-visit-1'] }, at(T0 + 95 * DAY));
  const reconciled = settled.get('memberships/sub_member_1').periods[0];
  assert.deepEqual([reconciled.unresolvedVisitJobIds, reconciled.breakageCents, reconciled.breakageUnknown, settled.get('jobs/job-visit-1').membershipVisit.status], [[], 80000, null, 'reconciled']);

  // A storage failure listing the visits makes Stripe redeliver; nothing is recorded until the retry.
  const outage = await member(undefined, { livemode: true }), outageHook = signedWebhook(t, outage), list = outage.membershipVisits;
  let calls = 0;
  outage.membershipVisits = async id => { if (calls++ === 0) throw Object.assign(new Error('Synthetic outage'), { code: 'garage_guard_storage_unavailable', status: 503 }); return list(id); };
  const failed = await outageHook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }));
  assert.deepEqual([failed.status, outage.get('memberships/sub_member_1').status, outage.get('stripe_events/evt_guard_deleted')], [503, 'active', null]);
  const retried = await outageHook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }));
  assert.deepEqual([retried.status, outage.get('memberships/sub_member_1').status, outage.get('memberships/sub_member_1').ledgerError, outage.get('memberships/sub_member_1').periods[0].breakageCents], [200, 'cancelled', undefined, 80000]);
  // A store that cannot list member visits leaves a tracked year's breakage unknown rather than guessing it.
  const blind = await member(undefined, { livemode: true });
  delete blind.membershipVisits;
  await webhookApply(blind, deletedEvent({ created: T0 + 90 * DAY, livemode: true }), at(T0 + 90 * DAY + 60));
  assert.deepEqual([blind.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, blind.get('memberships/sub_member_1').periods[0].breakageUnknown], [null, 'visits_unresolved']);
});

test('a plan change that resets the billing anchor extends the paid year, so visits after the old end still count', async () => {
  // Review repro (probe8): an upgrade on day 200 billed [day 200, day 200 + 1 year], but the open year kept its old end and held every later visit as awaiting_renewal.
  const store = await member(undefined, { livemode: true }), upgradedAt = T0 + 200 * DAY, newEnd = upgradedAt + YEAR;
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_upgrade', reason: 'subscription_update', created: upgradedAt, invoice: 'in_guard_upgrade', plan: 'black', paid: 200000, total: 200000, due: 200000, discount: 0, periodEnd: newEnd, livemode: true }), at(upgradedAt + 60));
  const upgraded = store.get('memberships/sub_member_1'), [open] = upgraded.periods;
  assert.deepEqual([upgraded.currentPeriodEnd, open.status, open.periodEnd, open.paidCents, open.invoiceIds], [at(newEnd), 'open', at(newEnd), 280000, ['in_guard_first', 'in_guard_upgrade']]);
  assert.deepEqual(open.planChanges, [{ at: at(upgradedAt), eventId: 'evt_guard_upgrade', plan: 'black', visitsIncluded: 12, previousPeriodEnd: at(T0 + YEAR), periodEnd: at(newEnd) }]);
  // Day 400: after the old end, before the new one; the member is active and paid up.
  completeVisit(store, 'job-visit-1', at(T0 + 400 * DAY));
  const field = await applyMembershipVisit(store, owner, { jobId: 'job-visit-1', via: 'field' }, at(T0 + 400 * DAY + 60));
  assert.deepEqual([field.status, field.allocatedCents, field.visitsRemaining, store.get('jobs/job-root').garageGuard.visitsRemaining], ['applied', null, 3, 3], 'counted in the extended year (its revenue waits for the plan-change decision)');
  // After the new end, a visit still waits for the renewal.
  store.put('jobs/job-visit-2', { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', membershipId: 'sub_member_1', visitPurpose: 'member_visit', status: 'completed', completedAt: at(newEnd + 5 * DAY) });
  assert.equal((await garageGuardAction(store, owner, { action: 'visit.apply', requestId: crypto.randomUUID(), jobId: 'job-visit-2' }, at(newEnd + 6 * DAY), { visitsEnabled: true })).reason, 'awaiting_renewal');
  // The next cycle renewal closes the extended year on its own date; a replayed upgrade invoice extends nothing.
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_upgrade_replay', reason: 'subscription_update', created: upgradedAt + 10, invoice: 'in_guard_upgrade', plan: 'black', paid: 200000, total: 200000, due: 200000, discount: 0, periodEnd: newEnd, livemode: true }), at(upgradedAt + 120));
  assert.equal(store.get('memberships/sub_member_1').periods[0].planChanges.length, 1);
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_renewal', reason: 'subscription_cycle', created: newEnd, invoice: 'in_guard_second', plan: 'black', paid: 200000, total: 200000, due: 200000, discount: 0, periodEnd: newEnd + YEAR, livemode: true }), at(newEnd + 60));
  assert.deepEqual(store.get('memberships/sub_member_1').periods.map(period => [period.status, period.periodStart, period.periodEnd, period.closedAt]), [['closed', at(T0), at(newEnd), at(newEnd)], ['open', at(newEnd), at(newEnd + YEAR), null]]);
});

test('a visit after the paid year ended, while the renewal failed and before the cancellation, is never booked into the paid year', async () => {
  // Review repro (probe5 P3b): the dunning visit was counted in year one after Stripe cancelled for failed payments, and breakage fell 80000 -> 60000.
  const store = await member(undefined, { livemode: true });
  await webhookApply(store, invoiceEvent({ id: 'evt_guard_renew_fail', type: 'invoice.payment_failed', created: T0 + YEAR + 60, invoice: 'in_guard_second', periodEnd: T0 + 2 * YEAR, paid: 0, livemode: true }), at(T0 + YEAR + 120));
  completeVisit(store, 'job-visit-1', at(T0 + YEAR + 5 * DAY));
  assert.equal((await applyMembershipVisit(store, owner, { jobId: 'job-visit-1', via: 'field' }, at(T0 + YEAR + 5 * DAY + 60))).reason, 'awaiting_renewal');
  await webhookApply(store, deletedEvent({ created: T0 + YEAR + 20 * DAY, reason: 'payment_failed', livemode: true }), at(T0 + YEAR + 20 * DAY + 60));
  const periods = store.get('memberships/sub_member_1').periods;
  assert.deepEqual([periods[0].breakageCents, periods[0].unresolvedVisitJobIds, periods[0].closedAt], [80000, [], at(T0 + YEAR + 20 * DAY)], 'the dunning visit is not the paid year\'s');
  assert.deepEqual([coveringPeriod(periods, at(T0 + YEAR + 5 * DAY)), coveringPeriod(periods, at(T0 + YEAR - 5 * DAY))?.id, afterPaidPeriod(periods, at(T0 + YEAR + 5 * DAY))?.id, afterPaidPeriod(periods, at(T0 + YEAR + 25 * DAY))],
    [null, 'checkout:evt_guard_checkout', 'checkout:evt_guard_checkout', null]);
  const held = await garageGuardAction(store, owner, { action: 'visit.apply', requestId: crypto.randomUUID(), jobId: 'job-visit-1' }, at(T0 + YEAR + 21 * DAY), { visitsEnabled: true });
  assert.deepEqual([held.status, held.reason, store.get('jobs/job-visit-1').membershipVisit.reason], ['needs_review', 'after_paid_period', 'after_paid_period']);
  const after = store.get('memberships/sub_member_1').periods[0];
  assert.deepEqual([after.visitsUsed, after.recognizedCents, after.breakageCents, events(store).find(event => event.type === 'membership.cancelled').data.breakageCents], [0, 0, 80000, 80000]);
  // A manager settles it without counting it.
  const settled = await garageGuardAction(store, manager, { action: 'visits.reconcile', requestId: crypto.randomUUID(), membershipId: 'sub_member_1', expectedRevision: store.revisionOf('memberships/sub_member_1'), visitsRemaining: 4, note: 'Serviced during dunning; the year was never paid.', jobIds: ['job-visit-1'] }, at(T0 + YEAR + 22 * DAY));
  assert.deepEqual([settled.status, store.get('jobs/job-visit-1').membershipVisit.status, store.get('memberships/sub_member_1').periods[0].breakageCents], ['reconciled', 'reconciled', 80000]);
});

test('with visit tracking off (the production default) the owner revenue totals are null, never 0', async () => {
  // Review repro: one live and one cancelled member with tracking off reported breakage, deferred and recognized revenue of 0.
  const live = await member(undefined, { livemode: true, visitTracking: false });
  const gone = await member(undefined, { livemode: true, visitTracking: false });
  await webhookApply(gone, deletedEvent({ created: T0 + 30 * DAY, livemode: true }), at(T0 + 30 * DAY + 60), { visitTracking: false });
  const rows = [live.get('memberships/sub_member_1'), { ...gone.get('memberships/sub_member_1'), subscriptionId: 'sub_member_2' }];
  const summary = garageGuardSummary(rows, { startAt: at(T0), endAt: at(T0 + 60 * DAY), asOf: at(T0 + 60 * DAY) });
  // Second review: the visits of both untracked years are unknown too, so their visit revenue is null, not 0.
  assert.deepEqual([summary.revenue.breakageCents, summary.revenue.deferredCents, summary.revenue.recognizedCents, summary.revenue.visitRevenueCents, summary.revenue.subscriptionCashCents, summary.visits.usedInPeriod],
    [null, null, null, null, 160000, null]);
  assert.deepEqual(summary.revenue.knownCents, { subscriptionCashCents: 160000, visitRevenueCents: 0, adjustmentRevenueCents: 0, breakageCents: 0, recognizedCents: 0, deferredCents: 0, mrrCents: summary.revenue.mrrCents });
  assert.deepEqual([summary.coverage.counts.unknownBreakage, summary.coverage.counts.unknownDeferred, summary.coverage.counts.visitsUntracked, summary.coverage.counts.unknownVisits], [1, 1, 2, 2]);
});

// Second review, round two: unknown visit revenue in a month with no close, races with the close, a listing that keeps failing, and years stuck unknown.
const november = { period: 'custom', from: '2026-11-01', to: '2026-12-01' }, DECEMBER_2 = new Date('2026-12-02T12:00:00.000Z');
const memberVisitJob = (store, id, completedAt, extra = {}) => store.put(`jobs/${id}`, { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', membershipId: 'sub_member_1', visitPurpose: 'member_visit', status: 'completed', pipelineStatus: 'completed', completedAt, ...extra });

test('with visit tracking off, a month with no renewal or cancellation has unknown visit and recognized revenue, never 0', async t => {
  // Review repro (probe10 (e)): the real signed webhook with sync on and tracking off, one live member with a completed visit on 2026-11-10.
  const off = memoryStore(), offHook = signedWebhook(t, off, { STRIPE_WEBHOOK_SECRET: hookEnv.STRIPE_WEBHOOK_SECRET, GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED: 'true', FIREBASE_API_KEY: hookEnv.FIREBASE_API_KEY });
  assert.equal((await offHook.deliver(checkoutEvent({ livemode: true }))).status, 200);
  assert.equal((await offHook.deliver(invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5, livemode: true }))).status, 200);
  memberVisitJob(off, 'job-visit-1', '2026-11-10T18:00:00.000Z', { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  const view = await garageGuardOverview(off, owner, november, DECEMBER_2, { visitsEnabled: false });
  assert.deepEqual([view.summary.revenue.visitRevenueCents, view.summary.revenue.recognizedCents, view.summary.revenue.breakageCents, view.summary.revenue.deferredCents, view.summary.visits.usedInPeriod, view.summary.visits.knownUsedInPeriod],
    [null, null, 0, null, null, 0], 'no year closed in November, so its breakage is a known 0; the visits and the revenue they recognized are unknown');
  assert.deepEqual([view.summary.revenue.knownCents.recognizedCents, view.summary.coverage.counts.unknownVisits, view.summary.coverage.counts.visitsUntracked, view.coverage.complete], [0, 1, 1, false]);
  assert.ok(view.summary.coverage.reasons.includes('unknownVisits'));
  assert.equal(visitCountGap(off.get('memberships/sub_member_1').periods[0], off.get('memberships/sub_member_1')), 'visits_untracked');

  // The same month with tracking on: the ledger counted the visit, so every total is known.
  const on = memoryStore(), onHook = signedWebhook(t, on);
  await onHook.deliver(checkoutEvent({ livemode: true }));
  await onHook.deliver(invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5, livemode: true }));
  memberVisitJob(on, 'job-visit-1', '2026-11-10T18:00:00.000Z', { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  assert.equal((await applyMembershipVisit(on, owner, { jobId: 'job-visit-1', via: 'field' }, '2026-11-10T18:05:00.000Z')).allocatedCents, 20000);
  const known = await garageGuardOverview(on, owner, november, DECEMBER_2, { visitsEnabled: true });
  assert.deepEqual([known.summary.revenue.visitRevenueCents, known.summary.revenue.recognizedCents, known.summary.revenue.deferredCents, known.summary.visits.usedInPeriod, known.summary.coverage.counts.unknownVisits, known.summary.coverage.complete],
    [20000, 20000, 60000, 1, 0, true]);
});

test('a member recorded before FUN-20 has unknown visit revenue until its first renewal opens a tracked year', async () => {
  // Review repro (probe11 (e)): every production member on deploy day showed 0 recognized revenue in a month with no renewal.
  const store = memoryStore();
  store.put('memberships/sub_member_1', { subscriptionId: 'sub_member_1', plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 2, currentPeriodEnd: at(T0 + 120 * DAY), statusEventCreated: T0 - 200 * DAY, livemode: true,
    link: { status: 'linked', customerId: 'cust-dana', accountJobId: 'job-root', mirroredAt: NOW } });
  const legacy = garageGuardSummary(store.collection('memberships'), { startAt: '2026-11-01T06:00:00.000Z', endAt: '2026-12-01T07:00:00.000Z', asOf: DECEMBER_2.toISOString() });
  assert.deepEqual([legacy.revenue.recognizedCents, legacy.revenue.visitRevenueCents, legacy.revenue.deferredCents, legacy.revenue.mrrCents, legacy.visits.usedInPeriod, legacy.coverage.counts.noLedger, legacy.coverage.counts.unknownVisits],
    [null, null, null, null, null, 1, 1]);
  // Its renewal closes the pre-ledger year as a stub and opens a tracked year: the month of the renewal is still unknown, a later month is known.
  await webhookApply(store, renewal({ created: T0 + 120 * DAY, periodEnd: T0 + 120 * DAY + YEAR }), at(T0 + 120 * DAY + 60));
  const periods = store.get('memberships/sub_member_1').periods;
  assert.deepEqual(periods.map(period => [period.id, period.status, period.visitsTracked]), [['pre_ledger', 'closed', false], ['in_guard_second', 'open', true]]);
  assert.deepEqual(periodVisitSpan(periods[0]), [Date.parse(at(T0 + 120 * DAY - YEAR)), Date.parse(at(T0 + 120 * DAY))], 'a stub covers the plan year before its periodEnd');
  const month = (startAt, endAt) => garageGuardSummary(store.collection('memberships'), { startAt, endAt, asOf: at(T0 + 200 * DAY) });
  const renewalMonth = month('2027-01-01T07:00:00.000Z', '2027-02-01T07:00:00.000Z'), later = month('2027-03-01T07:00:00.000Z', '2027-04-01T06:00:00.000Z');
  assert.deepEqual([renewalMonth.revenue.recognizedCents, renewalMonth.visits.usedInPeriod, renewalMonth.coverage.counts.unknownVisits], [null, null, 1]);
  assert.deepEqual([later.revenue.recognizedCents, later.revenue.visitRevenueCents, later.visits.usedInPeriod, later.coverage.counts.unknownVisits, later.coverage.counts.noLedger], [0, 0, 0, 0, 0]);
  // A month before the stub's plan year is still one the ledger never saw (the member may have been live then), never a known 0.
  const history = month('2025-11-01T06:00:00.000Z', '2025-12-01T07:00:00.000Z');
  assert.ok(periodVisitSpan(periods[0])[0] > Date.parse('2025-12-01T07:00:00.000Z'), 'the range is outside the stub');
  assert.deepEqual([history.revenue.recognizedCents, history.revenue.visitRevenueCents, history.visits.usedInPeriod, history.coverage.counts.unknownVisits], [null, null, null, 1]);

  // A member recorded before FUN-20 that cancelled before the ledger ever wrote it has no period at all: a month it may have been live in is
  // unknown, a month after its cancellation is a known 0.
  const gone = memoryStore();
  gone.put('memberships/sub_member_gone', { subscriptionId: 'sub_member_gone', plan: 'guard', status: 'cancelled', cancelledAt: '2026-06-15T18:00:00.000Z', visitsIncluded: 4, visitsRemaining: 1, statusEventCreated: T0 - 400 * DAY, livemode: true, link: { status: 'unlinked' } });
  const before = garageGuardSummary(gone.collection('memberships'), { startAt: '2026-05-01T06:00:00.000Z', endAt: '2026-06-01T06:00:00.000Z', asOf: DECEMBER_2.toISOString() });
  const after = garageGuardSummary(gone.collection('memberships'), { startAt: '2026-11-01T06:00:00.000Z', endAt: '2026-12-01T07:00:00.000Z', asOf: DECEMBER_2.toISOString() });
  assert.deepEqual([before.revenue.recognizedCents, before.visits.usedInPeriod, before.coverage.counts.unknownVisits], [null, null, 1]);
  assert.deepEqual([after.revenue.recognizedCents, after.visits.usedInPeriod, after.coverage.counts.unknownVisits], [0, 0, 0]);
});

test('a link or a completion that lands between the close\'s visit listing and its commit makes the event list the visits again', async t => {
  // Review repro (probe11 race): the link committed right after the query and the cancellation booked 80000 of breakage in the period and the event.
  const store = await member(undefined, { livemode: true }), hook = signedWebhook(t, store), list = store.membershipVisits;
  store.put('jobs/job-visit-1', { ...store.get('jobs/job-visit-1'), status: 'completed', pipelineStatus: 'completed', completedAt: at(T0 + 80 * DAY) });
  let raced = false;
  store.membershipVisits = async id => {
    const listed = await list(id);
    if (!raced) { raced = true; await garageGuardAction(store, manager, { action: 'visit.link', requestId: crypto.randomUUID(), jobId: 'job-visit-1', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-visit-1') }, at(T0 + 90 * DAY)); }
    return listed;
  };
  assert.equal((await hook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }))).status, 200);
  const [period] = store.get('memberships/sub_member_1').periods;
  assert.deepEqual([raced, store.visitReads.length, period.breakageCents, period.breakageUnknown, period.unresolvedVisitJobIds], [true, 2, null, 'visits_unresolved', ['job-visit-1']]);
  assert.equal('breakageCents' in events(store).find(event => event.type === 'membership.cancelled').data, false, 'the guessed breakage never reaches the append-only event');

  // A listed member visit the ledger has not counted is fenced: completing it (backdated into the year) before the commit lands conflicts too.
  const fenced = await member(undefined, { livemode: true }), fencedHook = signedWebhook(t, fenced), fencedList = fenced.membershipVisits;
  memberVisitJob(fenced, 'job-visit-1', undefined, { status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-12-01' });
  let completed = false;
  fenced.membershipVisits = async id => {
    const listed = await fencedList(id);
    if (!completed) { completed = true; memberVisitJob(fenced, 'job-visit-1', at(T0 + 70 * DAY), { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } }); }
    return listed;
  };
  assert.equal((await fencedHook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }))).status, 200);
  assert.deepEqual([fenced.visitReads.length, fenced.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, fenced.get('memberships/sub_member_1').periods[0].breakageCents], [2, ['job-visit-1'], null]);
  assert.ok(fenced.verified.at(-1).includes('jobs/job-visit-1'), 'the listed job is fenced at the revision the close read');
  // A counted visit needs no fence; one the commit already writes is fenced by that write.
  const quiet = await member(undefined, { livemode: true }), quietHook = signedWebhook(t, quiet);
  memberVisitJob(quiet, 'job-visit-1', at(T0 + 10 * DAY));
  await applyMembershipVisit(quiet, owner, { jobId: 'job-visit-1' }, at(T0 + 10 * DAY + 60));
  assert.equal((await quietHook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }))).status, 200);
  assert.deepEqual([quiet.verified.at(-1).includes('jobs/job-visit-1'), quiet.get('memberships/sub_member_1').periods[0].breakageCents], [false, 60000]);
});

test('a visit listing that keeps failing never blocks the membership record: after an hour of retries it is recorded with the year unknown, and a manager settles it', async t => {
  const store = await member(undefined, { livemode: true }), hook = signedWebhook(t, store), list = store.membershipVisits;
  memberVisitJob(store, 'job-visit-1', at(T0 + 40 * DAY), { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  let failing = true;
  store.membershipVisits = async id => { if (failing) throw Object.assign(new Error('Synthetic index exemption'), { code: 'garage_guard_storage_incomplete', status: 503 }); return list(id); };
  const cancel = deletedEvent({ created: T0 + 90 * DAY, livemode: true });
  // Within the hour Stripe redelivers, and nothing is recorded.
  assert.equal((await hook.deliver(cancel, 60)).status, 503);
  assert.equal((await hook.deliver(cancel, VISIT_LIST_RETRY_MS / 1000 - 60)).status, 503);
  assert.deepEqual([store.get('memberships/sub_member_1').status, store.get('stripe_events/evt_guard_deleted')], ['active', null]);
  // Past it, the cancellation, churn and receipt are recorded; the year's unresolved visits are unknown, so its breakage is too.
  const late = await hook.deliver(cancel, 2 * 3600);
  assert.equal(late.status, 200);
  const membership = store.get('memberships/sub_member_1'), [period] = membership.periods, unlisted = { at: at(cancel.created + 2 * 3600), code: 'garage_guard_storage_incomplete' };
  assert.deepEqual([membership.status, membership.churn.class, membership.ledgerError, period.breakageCents, period.breakageUnknown, period.unresolvedVisitJobIds, period.visitsUnlisted], ['cancelled', 'voluntary', undefined, null, 'visits_unresolved', null, unlisted]);
  assert.deepEqual([store.get('stripe_events/evt_guard_deleted').visitsUnlisted, events(store).find(event => event.type === 'membership.cancelled').data], [unlisted, { churnClass: 'voluntary', plan: 'guard' }]);
  const [row] = (await garageGuardOverview(store, manager, {}, new Date(at(T0 + 91 * DAY)))).memberships;
  assert.deepEqual(row.unresolvedPeriods, [{ periodId: 'checkout:evt_guard_checkout', closedAt: at(cancel.created), jobIds: null, unlisted: true }]);
  // Once listing works again, any reconcile lists the year's visits again; settling the pending one makes the breakage known.
  failing = false;
  const relisted = await garageGuardAction(store, manager, { action: 'visits.reconcile', requestId: crypto.randomUUID(), membershipId: 'sub_member_1', expectedRevision: store.revisionOf('memberships/sub_member_1'), visitsRemaining: 4, note: 'Re-listing the member visits after the outage.' }, at(T0 + 92 * DAY));
  assert.deepEqual([relisted.coveredJobIds, store.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, store.get('memberships/sub_member_1').periods[0].breakageUnknown, store.get('memberships/sub_member_1').periods[0].visitsListedAt], [[], ['job-visit-1'], 'visits_unresolved', at(T0 + 92 * DAY)]);
  assert.ok(store.verified.at(-1).includes('jobs/job-visit-1'), 'the re-listed job is fenced in the reconcile commit');
  const counted = await garageGuardAction(store, owner, { action: 'visit.apply', requestId: crypto.randomUUID(), jobId: 'job-visit-1' }, at(T0 + 93 * DAY), { visitsEnabled: true });
  const settled = store.get('memberships/sub_member_1').periods[0];
  assert.deepEqual([counted.status, counted.periodClosed, settled.unresolvedVisitJobIds, settled.breakageCents, settled.breakageUnknown], ['applied', true, [], 60000, null]);
});

test('a year waiting on a visit that is later cancelled, deleted or moved is settled by a reconcile that drops it without marking it', async () => {
  // Review repro (probe12): the job was cancelled after the close; visit.apply said not_completed and reconcile refused it, so the year stayed unknown for good.
  for (const [label, change] of [
    ['cancelled', store => store.put('jobs/job-visit-1', { ...store.get('jobs/job-visit-1'), status: 'cancelled', pipelineStatus: 'cancelled' })],
    ['deleted', store => store.rows.delete('jobs/job-visit-1')],
    ['moved', store => store.put('jobs/job-visit-1', { ...store.get('jobs/job-visit-1'), membershipId: 'sub_other_member' })],
  ]) {
    const store = await member(undefined, { livemode: true });
    memberVisitJob(store, 'job-visit-1', at(T0 + 40 * DAY), { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
    await webhookApply(store, deletedEvent({ created: T0 + 90 * DAY, livemode: true }), at(T0 + 90 * DAY + 60));
    assert.deepEqual(store.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, ['job-visit-1'], label);
    change(store);
    const before = store.get('jobs/job-visit-1');
    const result = await garageGuardAction(store, manager, { action: 'visits.reconcile', requestId: crypto.randomUUID(), membershipId: 'sub_member_1', expectedRevision: store.revisionOf('memberships/sub_member_1'), visitsRemaining: 4, note: `The listed visit was ${label}; not a member visit.`, jobIds: ['job-visit-1'] }, at(T0 + 92 * DAY));
    const period = store.get('memberships/sub_member_1').periods[0];
    assert.deepEqual([result.coveredJobIds, result.droppedJobIds, period.unresolvedVisitJobIds, period.breakageCents, period.breakageUnknown], [[], ['job-visit-1'], [], 80000, null], label);
    assert.deepEqual(store.get('jobs/job-visit-1'), before, `${label}: the job is never marked`);
    assert.deepEqual(store.get('memberships/sub_member_1').visitAdjustments.at(-1).jobIds, [], `${label}: a dropped job is not a reconciled visit of this membership`);
    const audit = store.collection('hub_audit').at(-1);
    assert.deepEqual([JSON.parse(audit.after).droppedJobIds, audit.reason], [['job-visit-1'], `The listed visit was ${label}; not a member visit.`], `${label}: the drop is audited with the note`);
  }
  // A job no year waits on is still refused unless it is a completed member visit of this membership.
  const store = await member(undefined, { livemode: true });
  memberVisitJob(store, 'job-visit-1', undefined, { status: 'cancelled', pipelineStatus: 'cancelled' });
  await assert.rejects(garageGuardAction(store, manager, { action: 'visits.reconcile', requestId: crypto.randomUUID(), membershipId: 'sub_member_1', expectedRevision: store.revisionOf('memberships/sub_member_1'), visitsRemaining: 4, note: 'Trying to cover a cancelled visit.', jobIds: ['job-visit-1'] }, at(T0 + 92 * DAY)), { code: 'garage_guard_visit_not_completed' });
});

test('linking a visit into a closed year makes its breakage unknown again until the visit is counted or settled', async () => {
  // Review finding (probe6 W3): the year showed 60000 of known breakage while a linked visit completed in it was still uncounted.
  const store = await member(undefined, { livemode: true });
  memberVisitJob(store, 'job-visit-1', at(T0 + 40 * DAY));
  await applyMembershipVisit(store, owner, { jobId: 'job-visit-1' }, at(T0 + 40 * DAY + 60));
  store.put('jobs/job-service', { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', status: 'completed', pipelineStatus: 'completed', completedAt: at(T0 + 60 * DAY), date: '2026-11-21' });
  await webhookApply(store, deletedEvent({ created: T0 + 90 * DAY, livemode: true }), at(T0 + 90 * DAY + 60));
  assert.deepEqual([store.get('memberships/sub_member_1').periods[0].breakageCents, store.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds], [60000, []]);
  const linked = await garageGuardAction(store, manager, { action: 'visit.link', requestId: crypto.randomUUID(), jobId: 'job-service', membershipId: 'sub_member_1', expectedRevision: store.revisionOf('jobs/job-service') }, at(T0 + 95 * DAY));
  assert.deepEqual([linked.status, linked.periodId, linked.periodClosed], ['linked', 'checkout:evt_guard_checkout', true]);
  let period = store.get('memberships/sub_member_1').periods[0];
  assert.deepEqual([period.unresolvedVisitJobIds, period.breakageCents, period.breakageUnknown], [['job-service'], null, 'visits_unresolved']);
  assert.equal(JSON.parse(store.collection('hub_audit').at(-1).after).closedPeriodId, 'checkout:evt_guard_checkout');
  const summary = garageGuardSummary(store.collection('memberships'), { startAt: at(T0), endAt: at(T0 + 100 * DAY), asOf: at(T0 + 100 * DAY) });
  assert.deepEqual([summary.revenue.breakageCents, summary.revenue.recognizedCents, summary.visits.usedInPeriod, summary.coverage.counts.unknownBreakage], [null, null, null, 1]);
  // Counting it in that year settles the breakage again.
  const applied = await garageGuardAction(store, owner, { action: 'visit.apply', requestId: crypto.randomUUID(), jobId: 'job-service' }, at(T0 + 96 * DAY), { visitsEnabled: true });
  period = store.get('memberships/sub_member_1').periods[0];
  assert.deepEqual([applied.status, applied.occurrence, period.unresolvedVisitJobIds, period.breakageCents, period.breakageUnknown, store.get('memberships/sub_member_1').visitsRemaining], ['applied', 2, [], 40000, null, 3]);
  assert.equal(events(store).find(event => event.type === 'membership.cancelled').data.breakageCents, 60000, 'the append-only event keeps the breakage known at the close');
});

// Fifth review: the close's listing limit, a browser count the view shows but no Stripe event has flagged, and a ledger out of step with Stripe.
const offVisitJob = (store, id, extra = {}) => store.put(`jobs/${id}`, { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', membershipId: 'sub_member_1', visitPurpose: 'member_visit', status: 'cancelled', pipelineStatus: 'cancelled', date: '2026-10-01', ...extra });
const YEAR_ONE = 'checkout:evt_guard_checkout';
async function linkedMember(t) {
  const store = memoryStore(), hook = signedWebhook(t, store);
  assert.equal((await hook.deliver(checkoutEvent({ livemode: true }))).status, 200);
  assert.equal((await hook.deliver(invoiceEvent({ id: 'evt_guard_first_invoice', reason: 'subscription_create', created: T0 + 5, livemode: true }))).status, 200);
  return { store, hook };
}

test('cancelled member visits and visits of other years never make a close\'s unresolved visits unknown; only jobs that could still land in the year are fenced', async t => {
  // Review repro (probeG): 61 cancelled member-visit jobs made every close record unresolvedVisitJobIds: null, for good.
  const store = await member(undefined, { livemode: true }), hook = signedWebhook(t, store);
  for (let index = 0; index <= LEDGER_LIMITS.visits; index++) offVisitJob(store, `job-cancelled-${index}`);
  offVisitJob(store, 'job-no-show', { status: 'no_show', pipelineStatus: 'no_show' });
  memberVisitJob(store, 'job-before', '2026-06-10T18:00:00.000Z', { membershipVisit: { status: 'needs_review', reason: 'visit_before_membership', membershipId: 'sub_member_1' } });
  store.put('jobs/job-record', { type: 'job', recordType: 'schedule_operation', membershipId: 'sub_member_1', status: 'scheduled' });
  memberVisitJob(store, 'job-next', undefined, { status: 'scheduled', pipelineStatus: 'scheduled', date: '2027-01-05' });
  assert.equal((await hook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }))).status, 200);
  const [period] = store.get('memberships/sub_member_1').periods;
  assert.deepEqual([period.unresolvedVisitJobIds, period.breakageCents, period.breakageUnknown], [[], 80000, null]);
  assert.equal(events(store).find(event => event.type === 'membership.cancelled').data.breakageCents, 80000, 'the known breakage reaches the event');
  assert.deepEqual(store.verified.at(-1), ['jobs/job-next'], 'only the scheduled visit that could still be completed into the year is fenced');

  // With a visit of the year still uncounted, the list names it (never null), and it is fenced after the scheduled one.
  const waiting = await member(undefined, { livemode: true }), waitingHook = signedWebhook(t, waiting);
  for (let index = 0; index <= LEDGER_LIMITS.visits; index++) offVisitJob(waiting, `job-cancelled-${index}`);
  memberVisitJob(waiting, 'job-visit-1', at(T0 + 40 * DAY), { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  memberVisitJob(waiting, 'job-next', undefined, { status: 'scheduled', pipelineStatus: 'scheduled', date: '2027-01-05' });
  assert.equal((await waitingHook.deliver(deletedEvent({ created: T0 + 90 * DAY, livemode: true }))).status, 200);
  assert.deepEqual([waiting.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, waiting.get('memberships/sub_member_1').periods[0].breakageUnknown, waiting.verified.at(-1)],
    [['job-visit-1'], 'visits_unresolved', ['jobs/job-next', 'jobs/job-visit-1']]);

  // The limit applies to the year's own uncounted visits; the fences are capped instead, nearest the close by date first (an undated one first).
  const year = { id: 'in_year', status: 'closed', periodStart: at(T0), periodEnd: at(T0 + YEAR), closedAt: at(T0 + 90 * DAY), visitsTracked: true, visitsIncluded: 4, visitsUsed: 0, visits: [], adjustments: [] };
  const owned = { subscriptionId: 'sub_member_1', periods: [year] }, closeAt = at(T0 + 90 * DAY);
  const scheduled = Array.from({ length: 150 }, (_, index) => ({ id: `job-s${String(index).padStart(3, '0')}`, revision: `r-${index}`, type: 'job', membershipId: 'sub_member_1', status: 'scheduled', date: at(T0 + (91 + index) * DAY).slice(0, 10) }));
  const done = { id: 'job-done', revision: 'r-done', type: 'job', membershipId: 'sub_member_1', status: 'completed', completedAt: at(T0 + 30 * DAY), membershipVisit: { status: 'pending' } };
  const capped = listedUnresolvedVisits({ complete: true, rows: [...scheduled, { id: 'job-undated', revision: 'r-undated', type: 'job', membershipId: 'sub_member_1', status: 'scheduled' }, done] }, owned, year, closeAt);
  assert.deepEqual([capped.ids, capped.fences.length, capped.fences[0].id, capped.fences[1].id, capped.fences.at(-1).id, capped.fences.every(fence => fence.verify === true)], [['job-done'], LEDGER_LIMITS.fences, 'job-undated', 'job-s000', 'job-s098', true]);
  const crowded = Array.from({ length: LEDGER_LIMITS.visits + 1 }, (_, index) => ({ ...done, id: `job-done-${index}`, revision: `r-done-${index}` }));
  assert.deepEqual(listedUnresolvedVisits({ complete: true, rows: crowded }, owned, year, closeAt), { ids: null, fences: [] }, 'more of the year\'s own visits than a year can list is unknown');
  assert.deepEqual(listedUnresolvedVisits({ complete: true, rows: [{ ...scheduled[0], revision: '' }] }, owned, year, closeAt), { ids: null, fences: [] }, 'a job that could land in the year but cannot be fenced leaves the list unknown');
  assert.deepEqual(listedUnresolvedVisits({ complete: true, rows: [{ ...scheduled[0], status: 'cancelled', revision: '' }] }, owned, year, closeAt), { ids: [], fences: [] }, 'a cancelled job needs no fence');
});

test('a closed year whose member visits cannot be listed is settled by a manager who confirms none is waiting, with the note audited', async () => {
  // Review repro (probeG G2): a null list could not be settled by visits.reconcile, and the docs said any reconcile would fill it.
  const store = await member(undefined, { livemode: true }), list = store.membershipVisits, note = 'No member visit was done in the cancelled year.';
  let failing = true;
  store.membershipVisits = async id => { if (failing) throw Object.assign(new Error('Synthetic index exemption'), { code: 'garage_guard_storage_incomplete', status: 503 }); return list(id); };
  await webhookApply(store, deletedEvent({ created: T0 + 90 * DAY, livemode: true }), at(T0 + 90 * DAY + 2 * 3600));
  assert.deepEqual([store.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, store.get('memberships/sub_member_1').periods[0].breakageUnknown], [null, 'visits_unresolved']);
  const reconcile = (extra = {}, target = store) => garageGuardAction(target, manager, { action: 'visits.reconcile', requestId: crypto.randomUUID(), membershipId: 'sub_member_1', expectedRevision: target.revisionOf('memberships/sub_member_1'), visitsRemaining: 4, note, ...extra }, at(T0 + 92 * DAY));
  // Without a confirmation, a listing that still fails fails the reconcile and nothing is saved.
  await assert.rejects(reconcile(), { code: 'garage_guard_storage_incomplete' });
  // Only a closed year still unlisted can be confirmed, and a malformed confirmation is refused.
  await assert.rejects(reconcile({ confirmEmptyPeriodIds: ['in_guard_other'] }), { code: 'garage_guard_period_not_unlisted', status: 409 });
  for (const bad of [[], YEAR_ONE, [YEAR_ONE, YEAR_ONE], [' padded '], [7]]) await assert.rejects(reconcile({ confirmEmptyPeriodIds: bad }), { code: 'garage_guard_reconcile_invalid', status: 400 }, JSON.stringify(bad));
  assert.deepEqual([store.collection('hub_audit').length, store.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds], [0, null]);
  const confirmed = await reconcile({ confirmEmptyPeriodIds: [YEAR_ONE] });
  const [period] = store.get('memberships/sub_member_1').periods;
  assert.deepEqual([confirmed.status, confirmed.confirmedEmptyPeriodIds, period.unresolvedVisitJobIds, period.breakageCents, period.breakageUnknown, period.visitsConfirmedEmpty],
    ['reconciled', [YEAR_ONE], [], 80000, null, { at: at(T0 + 92 * DAY), by: 'alexk', requestId: confirmed.requestId, note }]);
  const audit = store.collection('hub_audit').at(-1);
  assert.deepEqual([audit.action, JSON.parse(audit.after).confirmedEmptyPeriodIds, audit.reason, store.get('memberships/sub_member_1').visitAdjustments.at(-1).confirmedEmptyPeriodIds], ['garage_guard.visits_reconcile', [YEAR_ONE], note, [YEAR_ONE]]);
  assert.equal(garageGuardSummary(store.collection('memberships'), { startAt: at(T0 + 80 * DAY), endAt: at(T0 + 100 * DAY), asOf: at(T0 + 100 * DAY) }).revenue.breakageCents, 80000);
  await assert.rejects(reconcile({ confirmEmptyPeriodIds: [YEAR_ONE] }), { code: 'garage_guard_period_not_unlisted', status: 409 }, 'a confirmed year is no longer unlisted');

  // More of the year's own visits uncounted than a year can list: listing them again cannot fill it; the manager's confirmation settles it.
  const crowded = await member(undefined, { livemode: true });
  for (let index = 0; index <= LEDGER_LIMITS.visits; index++) memberVisitJob(crowded, `job-visit-${index}`, at(T0 + 10 * DAY + index * 3600), { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  await webhookApply(crowded, deletedEvent({ created: T0 + 90 * DAY, livemode: true }), at(T0 + 90 * DAY + 60));
  assert.equal(crowded.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, null);
  const relisted = await reconcile({}, crowded);
  assert.deepEqual([relisted.confirmedEmptyPeriodIds, crowded.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds], [undefined, null]);
  const settled = await reconcile({ confirmEmptyPeriodIds: [YEAR_ONE], note: 'These were warranty call-backs, not member visits.' }, crowded);
  assert.deepEqual([settled.confirmedEmptyPeriodIds, crowded.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, crowded.get('memberships/sub_member_1').periods[0].breakageCents], [[YEAR_ONE], [], 80000]);
  // A year a reconcile manages to list is listed, not confirmed.
  const listed = await member(undefined, { livemode: true });
  memberVisitJob(listed, 'job-visit-1', at(T0 + 40 * DAY), { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  delete listed.membershipVisits;
  await webhookApply(listed, deletedEvent({ created: T0 + 90 * DAY, livemode: true }), at(T0 + 90 * DAY + 60));
  listed.membershipVisits = async id => ({ rows: listed.collection('jobs').filter(job => job.membershipId === id), complete: true });
  const both = await reconcile({ confirmEmptyPeriodIds: [YEAR_ONE] }, listed);
  assert.deepEqual([both.confirmedEmptyPeriodIds, listed.get('memberships/sub_member_1').periods[0].unresolvedVisitJobIds, listed.get('memberships/sub_member_1').periods[0].visitsConfirmedEmpty], [undefined, ['job-visit-1'], undefined]);
});

test('a browser count no Stripe event has flagged yet makes the open year\'s A8 totals unknown, and the view incomplete', async t => {
  // Review repro (probeA A6): the view showed the manual edit, but reported visit and recognized revenue as known and coverage.complete true.
  const { store, hook } = await linkedMember(t);
  memberVisitJob(store, 'job-visit-1', '2026-11-10T18:00:00.000Z', { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  await applyMembershipVisit(store, owner, { jobId: 'job-visit-1', via: 'field' }, '2026-11-10T18:05:00.000Z');
  const clean = await garageGuardOverview(store, owner, november, DECEMBER_2, { visitsEnabled: true });
  assert.deepEqual([clean.summary.revenue.recognizedCents, clean.summary.revenue.deferredCents, clean.memberships[0].deferredCents, clean.coverage.complete, clean.coverage.manualEdits], [20000, 60000, 60000, true, 0]);
  // A manager rewrites the count in the browser dialog (a visit done outside the Hub).
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { ...store.get('jobs/job-root').garageGuard, visitsRemaining: 2, source: 'hub_manual', updatedBy: 'alexk', updatedAt: '2026-11-20T12:00:00.000Z' } });
  const view = await garageGuardOverview(store, owner, november, DECEMBER_2, { visitsEnabled: true });
  assert.equal(store.get('memberships/sub_member_1').manualEdit, undefined, 'nothing has flagged it on the membership yet');
  assert.deepEqual([view.summary.revenue.visitRevenueCents, view.summary.revenue.recognizedCents, view.summary.revenue.deferredCents, view.summary.visits.usedInPeriod], [null, null, null, null]);
  assert.deepEqual([view.summary.revenue.knownCents.recognizedCents, view.summary.visits.knownUsedInPeriod, view.summary.coverage.counts.manualEdits, view.summary.coverage.counts.unknownVisits], [20000, 1, 1, 1]);
  assert.deepEqual([view.counts.manualEdits, view.coverage.manualEdits, view.coverage.complete, view.coverage.reasons.includes('manualEdits'), view.memberships[0].deferredCents], [1, 1, false, true, null]);
  // A Stripe event then stores the flag, and the stored flag keeps the totals unknown with or without the account jobs.
  assert.equal((await hook.deliver(invoiceEvent({ id: 'evt_guard_fail', type: 'invoice.payment_failed', created: T0 + 100 * DAY, invoice: 'in_guard_x', periodEnd: T0 + YEAR, paid: 0, reason: 'subscription_update', livemode: true }))).status, 200);
  assert.equal(store.get('memberships/sub_member_1').manualEdit.status, 'open');
  assert.equal(garageGuardSummary(store.collection('memberships'), { startAt: '2026-11-01T06:00:00.000Z', endAt: '2026-12-01T07:00:00.000Z', asOf: DECEMBER_2.toISOString() }).revenue.recognizedCents, null);

  // A browser save that changed only the plan shown is no count: the totals stay known, but the view is incomplete until it is reconciled.
  const shown = await linkedMember(t);
  memberVisitJob(shown.store, 'job-visit-1', '2026-11-10T18:00:00.000Z', { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  await applyMembershipVisit(shown.store, owner, { jobId: 'job-visit-1', via: 'field' }, '2026-11-10T18:05:00.000Z');
  shown.store.put('jobs/job-root', { ...shown.store.get('jobs/job-root'), garageGuard: { ...shown.store.get('jobs/job-root').garageGuard, plan: 'black', source: 'hub_manual' } });
  const planOnly = await garageGuardOverview(shown.store, owner, november, DECEMBER_2, { visitsEnabled: true });
  assert.deepEqual([planOnly.summary.revenue.recognizedCents, planOnly.memberships[0].manualEdit.fields, planOnly.coverage.manualEdits, planOnly.coverage.complete, planOnly.coverage.reasons], [20000, ['plan'], 1, false, ['manualEdits']]);
});

test('a ledger out of step with Stripe (a failed write, a missed renewal, an unclosed cancellation) reports the ranges after that point as unknown', async t => {
  // Review repro (probeA A9): a ledgerError at the renewal left year one open with its old periodEnd, and year-two months reported known totals.
  const { store, hook } = await linkedMember(t), list = store.membershipVisits;
  memberVisitJob(store, 'job-visit-1', at(T0 + 40 * DAY), { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  await applyMembershipVisit(store, owner, { jobId: 'job-visit-1', via: 'field' }, at(T0 + 40 * DAY + 60));
  const malformed = async () => ({ rows: [new Proxy({}, { get() { throw new Error('Synthetic malformed member visit'); } })], complete: true });
  store.membershipVisits = malformed;
  assert.equal((await hook.deliver(renewal())).status, 200, 'the ledger failure never blocks the renewal');
  store.membershipVisits = list;
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual([membership.ledgerError.code, membership.periods.map(period => [period.status, period.periodEnd]), membership.currentPeriodEnd, membership.visitsRemaining], ['ledger_failed', [['open', at(T0 + YEAR)]], at(T0 + 2 * YEAR), 4]);
  assert.equal(ledgerStaleFrom(membership), Date.parse(at(T0 + YEAR)), 'from the missed renewal, before the error was recorded');
  // A year-two visit waits for a renewal the ledger never saw.
  memberVisitJob(store, 'job-visit-2', at(T0 + YEAR + 40 * DAY), { membershipVisit: { status: 'pending', membershipId: 'sub_member_1' } });
  assert.equal((await applyMembershipVisit(store, owner, { jobId: 'job-visit-2', via: 'field' }, at(T0 + YEAR + 40 * DAY + 60))).reason, 'awaiting_renewal');
  const range = (target, from, to) => garageGuardSummary(target.collection('memberships'), { startAt: at(from), endAt: at(to), asOf: at(to) });
  const yearTwo = range(store, T0 + YEAR + 30 * DAY, T0 + YEAR + 60 * DAY);
  assert.deepEqual([yearTwo.revenue.visitRevenueCents, yearTwo.revenue.recognizedCents, yearTwo.revenue.deferredCents, yearTwo.revenue.mrrCents, yearTwo.visits.usedInPeriod, yearTwo.revenue.breakageCents],
    [null, null, null, null, null, 0], 'no year closes in the middle of year two, so only its breakage is a known 0');
  assert.deepEqual([yearTwo.coverage.counts.unknownVisits, yearTwo.coverage.counts.unknownDeferred, yearTwo.coverage.counts.unknownMrr, yearTwo.coverage.counts.ledgerErrors], [1, 1, 1, 1]);
  // The range holding the missed renewal never had year one's breakage booked.
  const renewalMonth = range(store, T0 + YEAR - 10 * DAY, T0 + YEAR + 10 * DAY);
  assert.deepEqual([renewalMonth.revenue.breakageCents, renewalMonth.revenue.recognizedCents, renewalMonth.coverage.counts.unknownBreakage], [null, null, 1]);
  // Year one, before the ledger fell out of step, is still known.
  const yearOne = range(store, T0 + 30 * DAY, T0 + 60 * DAY);
  assert.deepEqual([yearOne.revenue.visitRevenueCents, yearOne.revenue.recognizedCents, yearOne.visits.usedInPeriod, yearOne.coverage.counts.unknownVisits], [20000, 20000, 1, 0]);
  assert.deepEqual(membershipDeferred(membership), { cents: null, known: false }, 'the open year may be the wrong one');
  const [row] = (await garageGuardOverview(store, owner, {}, new Date(at(T0 + YEAR + 60 * DAY)))).memberships;
  assert.deepEqual([row.deferredCents, row.ledgerError.code], [null, 'ledger_failed']);

  // A renewal recorded without the ledger at all (no ledgerError: a rollback to code before it) is caught from the open year's end too.
  const missed = await member(undefined, { livemode: true });
  missed.put('memberships/sub_member_1', { ...missed.get('memberships/sub_member_1'), currentPeriodEnd: at(T0 + 2 * YEAR), visitsRemaining: 4 });
  const missedYearTwo = range(missed, T0 + YEAR + 30 * DAY, T0 + YEAR + 60 * DAY), missedYearOne = range(missed, T0 + 30 * DAY, T0 + 60 * DAY);
  assert.deepEqual([ledgerStaleFrom(missed.get('memberships/sub_member_1')), missedYearTwo.revenue.recognizedCents, missedYearTwo.revenue.deferredCents, missedYearTwo.coverage.counts.ledgerErrors, missedYearOne.revenue.recognizedCents],
    [Date.parse(at(T0 + YEAR)), null, null, 1, 0]);

  // A cancellation whose ledger write failed leaves its year open: the months from the cancellation are unknown, including its breakage.
  const gone = await member(undefined, { livemode: true });
  gone.membershipVisits = malformed;
  await webhookApply(gone, deletedEvent({ created: T0 + 90 * DAY, livemode: true }), at(T0 + 90 * DAY + 60));
  const cancelled = gone.get('memberships/sub_member_1');
  assert.deepEqual([cancelled.status, cancelled.periods[0].status, cancelled.ledgerError.code, ledgerStaleFrom(cancelled)], ['cancelled', 'open', 'ledger_failed', Date.parse(at(T0 + 90 * DAY))]);
  const cancelMonth = range(gone, T0 + 80 * DAY, T0 + 100 * DAY), before = range(gone, T0 + 10 * DAY, T0 + 20 * DAY);
  assert.deepEqual([cancelMonth.members.cancelledInPeriod, cancelMonth.revenue.breakageCents, cancelMonth.revenue.recognizedCents, cancelMonth.visits.usedInPeriod], [1, null, null, null]);
  assert.deepEqual([before.revenue.breakageCents, before.revenue.recognizedCents, before.visits.usedInPeriod], [0, 0, 0]);
});
