import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ALERT_STALE_MS, applyGarageGuardEvent, claimGarageGuardAlert, expireGarageGuardAlert, garageGuardEvent, garageGuardMembershipSyncEnabled, settleGarageGuardAlert } from '../functions/_lib/garage-guard-membership.js';
import { matchCustomerIdentity } from '../functions/_lib/customer-resolution.js';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { hookDelivery, stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import * as portal from '../functions/api/customer-portal.js';

const NOW = '2026-09-22T12:00:00.000Z', LATER = '2026-09-23T12:00:00.000Z';
const T0 = Math.floor(Date.parse(NOW) / 1000);
const origin = 'https://easygaragecleaning.com';
const env = { STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_garage_guard', GARAGE_GUARD_HOOK_URL: 'https://hooks.example.invalid/garage-guard', GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED: 'true', FIREBASE_API_KEY: 'firebase-test-garage-guard', CUSTOMER_PORTAL_SECRET: 'synthetic-garage-guard-portal-secret' };
const conflict = () => Object.assign(new Error('Synthetic revision conflict'), { code: 'dispatch_revision_conflict', status: 409 });
// dispatchStorage reports Firestore's 400 FAILED_PRECONDITION and lost responses alike.
const unknown = () => Object.assign(new Error('Synthetic unknown outcome'), { code: 'dispatch_outcome_unknown', status: 503 });

const account = () => ({
  // resolveCustomer's identity revision; the link commit fences it.
  'customerIdentityState/revision': { updatedAt: '2026-09-01T12:00:00.000Z', lastRequestId: 'synthetic-resolve' },
  'customers/cust-dana': { name: 'Synthetic Dana', phone: '(970) 555-0101', email: 'dana@example.invalid' },
  'customers/cust-other': { name: 'Synthetic Other', phone: '970-555-0199', email: 'other@example.invalid' },
  'jobs/job-root': { type: 'job', customerId: 'cust-dana', customer: 'Synthetic Dana', address: '1 Synthetic Way', garageGuard: { nextVisit: '2026-10-05' } },
  'jobs/job-child': { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', address: '1 Synthetic Way', status: 'scheduled', total: 900 },
  'jobs/job-unrelated': { type: 'job', customerId: 'cust-other', customer: 'Synthetic Other' },
});

function memoryStore(seed = account()) {
  const rows = new Map(), commits = [], verified = []; let revision = 0, failures = [], loseResponse = null, races = [], commitIndex = 0;
  const stamp = () => `2026-09-22T00:00:00.${String(++revision).padStart(6, '0')}Z`;
  const put = (path, value) => rows.set(path, { value: structuredClone(value), revision: stamp() });
  for (const [path, value] of Object.entries(seed)) put(path, value);
  const out = (path, row) => ({ ...structuredClone(row.value), id: path.split('/')[1], revision: row.revision });
  return {
    rows, commits, verified, put,
    get: path => rows.has(path) ? structuredClone(rows.get(path).value) : null,
    // One entry per upcoming commit; null lets that commit through.
    failNextCommit: (...errors) => { failures = errors; },
    // Another writer lands after this delivery's reads and before its commit.
    raceNextCommit: (...changes) => { races = changes; },
    // The commit `skip` commits from now applies, but its response is lost.
    loseNextResponse: (skip = 0) => { loseResponse = commitIndex + skip; },
    async read(collection, id) { const path = `${collection}/${id}`; return rows.has(path) ? out(path, rows.get(path)) : null; },
    async customers() { return [...rows].filter(([path]) => path.startsWith('customers/')).map(([path, row]) => out(path, row)); },
    async customerJobs(customerId, limit) { return [...rows].filter(([path, row]) => path.startsWith('jobs/') && row.value.customerId === customerId).slice(0, limit).map(([path, row]) => out(path, row)); },
    async commit(writes) {
      const index = commitIndex++, race = races.shift(), failure = failures.shift();
      if (race) race();
      if (failure) throw failure;
      const paths = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(paths).size, paths.length, 'a commit never writes or verifies the same document twice');
      // verify:true is a read-only fence (dispatchStorage runs it in a transaction): the revision must still match.
      for (const [index, write] of writes.entries()) { const row = rows.get(paths[index]); if (write.verify ? !write.revision || row?.revision !== write.revision : write.revision ? row?.revision !== write.revision : row) throw conflict(); }
      for (const [index, write] of writes.entries()) if (!write.verify) rows.set(paths[index], { value: { ...(rows.get(paths[index])?.value || {}), ...structuredClone(write.patch) }, revision: stamp() });
      commits.push(paths.filter((_, index) => !writes[index].verify)); verified.push(paths.filter((_, index) => writes[index].verify));
      if (loseResponse === index) { loseResponse = null; throw unknown(); }
    },
  };
}

const checkoutEvent = ({ id = 'evt_guard_checkout', type = 'checkout.session.completed', created = T0, subscription = 'sub_member_1', plan = 'guard', email = 'DANA@example.invalid', phone = '+1 970 555 0101', paymentStatus = 'paid', mode = 'subscription' } = {}) => ({ id, type, created, livemode: false, data: { object: {
  id: 'cs_test_guard_1', object: 'checkout.session', mode, status: 'complete', payment_status: paymentStatus, subscription, customer: 'cus_member_1', amount_total: 80000, metadata: plan ? { plan } : {},
  customer_details: { email, phone, name: 'Synthetic Dana' }, custom_fields: [{ key: 'service_address', text: { value: '1 Synthetic Way, Fort Collins' } }] } } });
const invoiceEvent = ({ id, type = 'invoice.paid', created = T0 + 60, subscription = 'sub_member_1', plan = 'guard', reason = 'subscription_cycle', periodEnd = T0 + 365 * 86400, basil = false, email = 'dana@example.invalid' } = {}) => ({ id, type, created, livemode: false, data: { object: basil
  ? { id: 'in_synthetic', object: 'invoice', billing_reason: reason, customer: 'cus_member_1', customer_email: email, parent: { type: 'subscription_details', subscription_details: { subscription, metadata: plan ? { plan } : {} } }, lines: { data: [{ parent: { type: 'subscription_item_details', subscription_item_details: { subscription } }, period: { start: periodEnd - 365 * 86400, end: periodEnd }, metadata: {} }] } }
  : { id: 'in_synthetic', object: 'invoice', billing_reason: reason, customer: 'cus_member_1', customer_email: email, subscription, subscription_details: { metadata: plan ? { plan } : {} }, lines: { data: [{ type: 'subscription', subscription, period: { start: periodEnd - 365 * 86400, end: periodEnd }, metadata: plan ? { plan } : {} }] } } } });
const deletedEvent = ({ id = 'evt_guard_deleted', created = T0 + 7200, subscription = 'sub_member_1', plan = 'guard' } = {}) => ({ id, type: 'customer.subscription.deleted', created, livemode: false, data: { object: { id: subscription, object: 'subscription', customer: 'cus_member_1', status: 'canceled', metadata: plan ? { plan } : {}, canceled_at: created, ended_at: created } } });
const apply = (store, event, options = {}) => applyGarageGuardEvent(store, garageGuardEvent(event), { now: NOW, alerts: true, ...options });

test('only Stripe events carrying a Garage Guard plan are parsed as memberships', () => {
  const checkout = garageGuardEvent(checkoutEvent());
  assert.deepEqual({ action: checkout.action, plan: checkout.plan, subscriptionId: checkout.subscriptionId, paid: checkout.paid, customer: checkout.stripeCustomerId }, { action: 'checkout', plan: 'guard', subscriptionId: 'sub_member_1', paid: true, customer: 'cus_member_1' });
  assert.deepEqual(checkout.identity, { customerEmail: 'dana@example.invalid', phone: '+1 970 555 0101', customerName: 'Synthetic Dana', serviceAddress: '1 Synthetic Way, Fort Collins' });
  for (const event of [checkoutEvent({ mode: 'payment' }), checkoutEvent({ plan: '' }), checkoutEvent({ plan: 'platinum' }), checkoutEvent({ subscription: 'not-a-subscription' }), { ...checkoutEvent(), id: 'bad id' }, invoiceEvent({ id: 'evt_x', plan: '' }), invoiceEvent({ id: 'evt_y', plan: '', basil: true }), invoiceEvent({ id: 'evt_z', subscription: null })]) assert.equal(garageGuardEvent(event), null);
  for (const basil of [false, true]) {
    const invoice = garageGuardEvent(invoiceEvent({ id: 'evt_invoice', basil }));
    assert.deepEqual({ action: invoice.action, subscriptionId: invoice.subscriptionId, plan: invoice.plan, periodEnd: invoice.periodEnd, reason: invoice.billingReason }, { action: 'paid', subscriptionId: 'sub_member_1', plan: 'guard', periodEnd: new Date((T0 + 365 * 86400) * 1000).toISOString(), reason: 'subscription_cycle' });
  }
  assert.equal(garageGuardEvent(deletedEvent({ plan: '' })).plan, '', 'a deletion without metadata relies on a membership already on file');
  assert.equal(garageGuardMembershipSyncEnabled({}), false); assert.equal(garageGuardMembershipSyncEnabled({ GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED: 'TRUE' }), true); assert.equal(garageGuardMembershipSyncEnabled({ GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED: 'yes' }), false);
});

test('exact identity matching never guesses between customers', () => {
  const rows = [{ id: 'a', phone: '(970) 555-0101', email: 'A@example.invalid' }, { id: 'b', phone: '9705550102', email: 'shared@example.invalid' }, { id: 'c', phone: '', email: 'shared@example.invalid' }];
  assert.deepEqual(matchCustomerIdentity(rows, { phone: '+19705550101', email: 'a@example.invalid' }), { status: 'matched', customer: rows[0], candidates: ['a'], method: 'exact_phone_email' });
  assert.equal(matchCustomerIdentity(rows, { email: 'shared@example.invalid' }).status, 'ambiguous');
  assert.equal(matchCustomerIdentity(rows, { phone: '9705550101', email: 'different@example.invalid' }).status, 'conflict');
  assert.equal(matchCustomerIdentity(rows, { phone: '9705550000' }).status, 'none');
  assert.equal(matchCustomerIdentity(rows, { phone: '555', email: 'not-an-email' }).status, 'no_identity');
  assert.equal(matchCustomerIdentity([{ id: '_egc_lock', phone: '9705550101' }], { phone: '9705550101' }).status, 'conflict', 'a private record id is never linked');
});

test('a new member is recorded, linked by exact identity and mirrored onto the account root only', async () => {
  const store = memoryStore(), result = await apply(store, checkoutEvent());
  assert.deepEqual(result, { status: 'applied', membershipId: 'sub_member_1', link: 'linked', reason: '', mirrored: true, alertPending: true });
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual({ plan: membership.plan, status: membership.status, customerEmail: membership.customerEmail, phone: membership.phone, serviceAddress: membership.serviceAddress, stripeCustomerId: membership.stripeCustomerId, currentPeriodEnd: membership.currentPeriodEnd, visitsIncluded: membership.visitsIncluded, visitsRemaining: membership.visitsRemaining, welcome: membership.welcomeAlertEventId },
    { plan: 'guard', status: 'active', customerEmail: 'dana@example.invalid', phone: '+1 970 555 0101', serviceAddress: '1 Synthetic Way, Fort Collins', stripeCustomerId: 'cus_member_1', currentPeriodEnd: '', visitsIncluded: 4, visitsRemaining: 4, welcome: 'evt_guard_checkout' });
  assert.deepEqual(membership.link, { status: 'linked', customerId: 'cust-dana', accountJobId: 'job-root', method: 'exact_phone_email', linkedAt: NOW, mirroredAt: NOW });
  assert.deepEqual(store.get('jobs/job-root').garageGuard, { nextVisit: '2026-10-05', plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, membershipId: 'sub_member_1', source: 'stripe', updatedAt: NOW, updatedBy: 'stripe_webhook' });
  assert.equal(store.get('jobs/job-child').garageGuard, undefined); assert.equal(store.get('jobs/job-unrelated').garageGuard, undefined);
  assert.deepEqual(store.get('stripe_events/evt_guard_checkout'), { eventId: 'evt_guard_checkout', type: 'checkout.session.completed', created: T0, livemode: false, subscriptionId: 'sub_member_1', link: 'linked', processedAt: NOW, alert: { status: 'pending' } });
  assert.deepEqual(store.commits, [['jobs/job-root', 'memberships/sub_member_1', 'stripe_events/evt_guard_checkout']], 'membership, mirror and receipt commit atomically');
  assert.equal(store.get('membership_reviews/sub_member_1'), null);
});

test('a replayed or concurrent event.id is a no-op', async () => {
  const store = memoryStore(), results = await Promise.all([apply(store, checkoutEvent()), apply(store, checkoutEvent())]);
  assert.deepEqual(results.map(result => result.status).sort(), ['applied', 'duplicate']);
  const before = structuredClone([...store.rows]);
  const replay = await apply(store, checkoutEvent(), { now: LATER });
  assert.deepEqual(replay, { status: 'duplicate', membershipId: 'sub_member_1', link: 'linked', alertPending: true, alertStatus: 'pending' });
  assert.deepEqual([...store.rows], before); assert.equal(store.commits.length, 1);
});

test('an ambiguous customer creates a review item and no mirror, and stays with the manager', async () => {
  const seed = account(); seed['customers/cust-dana-2'] = { name: 'Synthetic Dana Duplicate', phone: '970.555.0101' };
  const store = memoryStore(seed), result = await apply(store, checkoutEvent());
  assert.equal(result.link, 'needs_review'); assert.equal(result.reason, 'ambiguous_customer'); assert.equal(result.mirrored, false);
  const review = store.get('membership_reviews/sub_member_1');
  assert.deepEqual({ status: review.status, reason: review.reason, candidates: review.candidateCustomerIds, email: review.customerEmail, address: review.serviceAddress, createdAt: review.createdAt, eventId: review.eventId }, { status: 'open', reason: 'ambiguous_customer', candidates: ['cust-dana', 'cust-dana-2'], email: 'dana@example.invalid', address: '1 Synthetic Way, Fort Collins', createdAt: NOW, eventId: 'evt_guard_checkout' });
  assert.deepEqual(store.get('memberships/sub_member_1').link, { status: 'needs_review', reason: 'ambiguous_customer', flaggedAt: NOW });
  assert.deepEqual(store.get('jobs/job-root').garageGuard, { nextVisit: '2026-10-05' }, 'no guessed mirror');
  assert.equal(store.get('stripe_events/evt_guard_checkout').link, 'needs_review');
  delete seed['customers/cust-dana-2'];
  store.rows.delete('customers/cust-dana-2');
  const renewal = await apply(store, invoiceEvent({ id: 'evt_guard_renewal' }), { now: LATER });
  assert.equal(renewal.link, 'needs_review'); assert.equal(renewal.mirrored, false);
  assert.equal(store.get('membership_reviews/sub_member_1').updatedAt, NOW, 'automation never re-resolves a review');
  assert.equal(store.get('memberships/sub_member_1').visitsRemaining, 4);
});

test('unmatched, conflicting and unverifiable accounts all go to review without a mirror', async () => {
  const cases = [
    ['no_customer_match', account(), checkoutEvent({ email: 'new@example.invalid', phone: '+19705550150' })],
    ['contact_conflict', account(), checkoutEvent({ email: 'someone-else@example.invalid' })],
    ['no_account_job', (() => { const seed = account(); delete seed['jobs/job-root']; delete seed['jobs/job-child']; return seed; })(), checkoutEvent()],
    ['multiple_account_roots', { ...account(), 'jobs/job-second-root': { type: 'job', customerId: 'cust-dana', address: '9 Other Street' } }, checkoutEvent()],
    ['account_link_invalid', { ...account(), 'jobs/job-child': { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-unrelated' } }, checkoutEvent()],
    ['account_has_other_membership', { ...account(), 'jobs/job-root': { type: 'job', customerId: 'cust-dana', garageGuard: { plan: 'lite', membershipId: 'sub_another' } } }, checkoutEvent()],
    ['too_many_jobs', { ...account(), ...Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`jobs/job-visit-${index}`, { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root' }])) }, checkoutEvent()],
  ];
  for (const [reason, seed, event] of cases) {
    const store = memoryStore(seed), result = await apply(store, event);
    assert.equal(result.reason, reason); assert.equal(result.mirrored, false);
    assert.equal(store.get('membership_reviews/sub_member_1').reason, reason);
    assert.ok(store.commits[0].every(path => !path.startsWith('jobs/')), `${reason}: no job write`);
  }
  const blind = memoryStore(), cancelled = await apply(blind, deletedEvent());
  assert.equal(cancelled.link, 'unlinked'); assert.equal(blind.get('membership_reviews/sub_member_1'), null, 'no identity means nothing to review yet');
  assert.equal(blind.get('memberships/sub_member_1').status, 'cancelled');
});

test('invoice.paid restores visits, payment_failed sets past_due, deletion cancels, and late events cannot rewind', async () => {
  const store = memoryStore();
  await apply(store, checkoutEvent());
  const used = store.get('jobs/job-root'); store.put('jobs/job-root', { ...used, garageGuard: { ...used.garageGuard, visitsRemaining: 1, nextVisit: '2026-12-01' } });
  const periodEnd = Math.floor(Date.parse('2027-09-22T05:30:00.000Z') / 1000);
  const failed = await apply(store, invoiceEvent({ id: 'evt_guard_failed', type: 'invoice.payment_failed', created: T0 + 100, periodEnd }));
  assert.equal(failed.alertPending, true);
  assert.equal(store.get('memberships/sub_member_1').status, 'past_due');
  assert.deepEqual({ status: store.get('jobs/job-root').garageGuard.status, visits: store.get('jobs/job-root').garageGuard.visitsRemaining }, { status: 'past_due', visits: 1 }, 'a status change keeps the manager’s used-visit count');
  const paid = await apply(store, invoiceEvent({ id: 'evt_guard_paid', created: T0 + 200, periodEnd }), { now: LATER });
  assert.equal(paid.alertPending, false, 'renewals are recorded silently');
  const membership = store.get('memberships/sub_member_1'), guard = store.get('jobs/job-root').garageGuard;
  assert.deepEqual({ status: membership.status, visits: membership.visitsRemaining, periodEnd: membership.currentPeriodEnd }, { status: 'active', visits: 4, periodEnd: '2027-09-22T05:30:00.000Z' });
  assert.deepEqual({ status: guard.status, visits: guard.visitsRemaining, renewal: guard.renewalDate, nextVisit: guard.nextVisit, updatedAt: guard.updatedAt }, { status: 'active', visits: 4, renewal: '2027-09-21', nextVisit: '2026-12-01', updatedAt: LATER });
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { ...guard, visitsRemaining: 3 } });
  const late = await apply(store, invoiceEvent({ id: 'evt_guard_late_failure', type: 'invoice.payment_failed', created: T0 + 150, periodEnd }));
  assert.equal(late.alertPending, false); assert.equal(store.get('memberships/sub_member_1').status, 'active');
  await apply(store, invoiceEvent({ id: 'evt_guard_old_period', created: T0 + 300, periodEnd: periodEnd - 365 * 86400 }));
  assert.equal(store.get('jobs/job-root').garageGuard.visitsRemaining, 3, 'an earlier period never restores visits');
  await apply(store, invoiceEvent({ id: 'evt_guard_update', created: T0 + 320, reason: 'subscription_update', periodEnd: periodEnd + 86400 }));
  assert.equal(store.get('jobs/job-root').garageGuard.visitsRemaining, 3, 'a mid-cycle plan invoice does not restore visits');
  const deleted = await apply(store, deletedEvent({ plan: '', created: T0 + 400 }));
  assert.equal(deleted.alertPending, true); assert.equal(store.get('jobs/job-root').garageGuard.status, 'cancelled');
  assert.equal(store.get('memberships/sub_member_1').cancelledAt, new Date((T0 + 400) * 1000).toISOString());
  await apply(store, invoiceEvent({ id: 'evt_guard_after_cancel', created: T0 + 500, periodEnd: periodEnd + 2 * 365 * 86400 }));
  assert.equal(store.get('memberships/sub_member_1').status, 'cancelled', 'cancellation is terminal');
  assert.equal(store.get('jobs/job-root').garageGuard.status, 'cancelled');
});

test('a Hub "Garage Guard status" edit that rewrites garageGuard keeps its used-visit count', async () => {
  const store = memoryStore(); await apply(store, checkoutEvent());
  // employee-suite.js opsSetCustomerMembership replaces the whole map without membershipId.
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), garageGuard: { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 2, nextVisit: '2026-11-02', renewalDate: '', updatedAt: NOW, updatedBy: 'zacb' } });
  const failed = await apply(store, invoiceEvent({ id: 'evt_guard_failed', type: 'invoice.payment_failed' }), { now: LATER });
  assert.equal(failed.mirrored, true);
  const guard = store.get('jobs/job-root').garageGuard;
  assert.deepEqual({ status: guard.status, visits: guard.visitsRemaining, nextVisit: guard.nextVisit, membershipId: guard.membershipId }, { status: 'past_due', visits: 2, nextVisit: '2026-11-02', membershipId: 'sub_member_1' });
});

test('an invoice before its checkout creates the membership, and the welcome alert is claimed once', async () => {
  const store = memoryStore(), first = await apply(store, invoiceEvent({ id: 'evt_first_invoice', reason: 'subscription_create', created: T0 - 5 }));
  assert.deepEqual({ link: first.link, alert: first.alertPending }, { link: 'linked', alert: false });
  const created = store.get('memberships/sub_member_1');
  assert.deepEqual({ status: created.status, visits: created.visitsRemaining, email: created.customerEmail, phone: created.phone, method: created.link.method }, { status: 'active', visits: 4, email: 'dana@example.invalid', phone: '', method: 'exact_email' });
  assert.equal(store.get('jobs/job-root').garageGuard.visitsRemaining, 4);
  const checkout = await apply(store, checkoutEvent());
  assert.equal(checkout.alertPending, true); assert.equal(store.get('memberships/sub_member_1').phone, '+1 970 555 0101');
  const async = await apply(store, checkoutEvent({ id: 'evt_guard_async', type: 'checkout.session.async_payment_succeeded', created: T0 + 5 }));
  assert.equal(async.alertPending, false, 'one welcome per membership');
  assert.equal(await claimGarageGuardAlert(store, 'evt_guard_checkout', NOW, 'attempt-1'), true);
  assert.equal(await claimGarageGuardAlert(store, 'evt_guard_checkout', NOW, 'attempt-2'), false, 'a claimed alert is never claimed again');
  assert.equal(await settleGarageGuardAlert(store, 'evt_guard_checkout', 'sent', LATER, 'attempt-2'), false, 'only the claiming attempt settles its send');
  assert.equal(await settleGarageGuardAlert(store, 'evt_guard_checkout', 'sent', LATER, 'attempt-1'), true);
  assert.deepEqual(store.get('stripe_events/evt_guard_checkout').alert, { status: 'sent', attemptId: 'attempt-1', claimedAt: NOW, settledAt: LATER });
  assert.equal(await claimGarageGuardAlert(store, 'evt_guard_async', NOW), false);
});

test('an unpaid subscription checkout waits for async payment before mirroring or welcoming', async () => {
  const store = memoryStore(), pending = await apply(store, checkoutEvent({ paymentStatus: 'unpaid' }));
  assert.deepEqual({ link: pending.link, mirrored: pending.mirrored, alert: pending.alertPending }, { link: 'linked', mirrored: false, alert: false });
  assert.equal(store.get('memberships/sub_member_1').status, 'pending'); assert.deepEqual(store.get('jobs/job-root').garageGuard, { nextVisit: '2026-10-05' });
  const paid = await apply(store, checkoutEvent({ id: 'evt_guard_async', type: 'checkout.session.async_payment_succeeded', created: T0 + 30 }));
  assert.deepEqual({ mirrored: paid.mirrored, alert: paid.alertPending }, { mirrored: true, alert: true });
  assert.equal(store.get('jobs/job-root').garageGuard.visitsRemaining, 4); assert.equal(store.get('jobs/job-root').garageGuard.status, 'active');
});

test('a changed account link or storage outage never writes a partial membership', async () => {
  const store = memoryStore(); await apply(store, checkoutEvent());
  store.put('jobs/job-root', { ...store.get('jobs/job-root'), customerId: 'cust-other' });
  const moved = await apply(store, invoiceEvent({ id: 'evt_guard_moved' }));
  assert.deepEqual({ link: moved.link, reason: moved.reason, mirrored: moved.mirrored }, { link: 'needs_review', reason: 'account_link_changed', mirrored: false });
  assert.equal(store.get('membership_reviews/sub_member_1').candidateCustomerIds[0], 'cust-dana');
  const outage = memoryStore(), commits = outage.commits;
  outage.failNextCommit(Object.assign(new Error('offline'), { code: 'dispatch_storage_unavailable', status: 503 }));
  await assert.rejects(apply(outage, checkoutEvent()), { code: 'dispatch_storage_unavailable' });
  outage.failNextCommit(unknown(), conflict(), unknown());
  await assert.rejects(apply(outage, checkoutEvent()), { code: 'dispatch_outcome_unknown' });
  assert.equal(outage.get('memberships/sub_member_1'), null); assert.equal(outage.get('stripe_events/evt_guard_checkout'), null); assert.equal(commits.length, 0);
  outage.failNextCommit(unknown(), conflict());
  assert.equal((await apply(outage, checkoutEvent())).status, 'applied', 'stale revisions retry from fresh reads');
  outage.loseNextResponse();
  const lost = await apply(outage, invoiceEvent({ id: 'evt_guard_failed', type: 'invoice.payment_failed' }));
  assert.deepEqual({ status: lost.status, alert: lost.alertPending }, { status: 'duplicate', alert: true }, 'a commit whose response was lost is found by its receipt and still alerts');
  assert.equal(outage.commits.filter(paths => paths.includes('stripe_events/evt_guard_failed')).length, 1);
  outage.failNextCommit(unknown());
  await assert.rejects(claimGarageGuardAlert(outage, 'evt_guard_failed', NOW, 'attempt-lost'), { code: 'garage_guard_alert_unconfirmed', status: 503 }, 'an unconfirmed claim is never followed by a send; Stripe redelivers');
  assert.equal(outage.get('stripe_events/evt_guard_failed').alert.status, 'pending', 'the alert stays claimable, never silently dropped');
  outage.loseNextResponse();
  assert.equal(await claimGarageGuardAlert(outage, 'evt_guard_failed', NOW, 'attempt-landed'), true, 'a claim whose response was lost is recognised by its attemptId');
  assert.equal(await claimGarageGuardAlert(outage, 'evt_guard_failed', NOW, 'attempt-late'), false);
  outage.loseNextResponse();
  assert.equal(await settleGarageGuardAlert(outage, 'evt_guard_failed', 'sent', LATER, 'attempt-landed'), true, 'a settled result whose response was lost is found on re-read');
  assert.deepEqual(outage.get('stripe_events/evt_guard_failed').alert, { status: 'sent', attemptId: 'attempt-landed', claimedAt: NOW, settledAt: LATER });
});

function webhookFixture(t, { store = memoryStore(), environment = env, sendFails = false, respond = () => new Response('{}') } = {}) {
  const sent = []; let clock = NOW;
  const send = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), raw: init.body, init }); if (sendFails) throw new Error('Synthetic Zapier timeout'); return respond(); };
  t.mock.method(globalThis, 'fetch', async input => { throw new Error(`Unexpected network request ${input}`); });
  const handlers = stripeWebhookHandlers({ storage: () => store, now: () => new Date(clock), send });
  const post = (event, { valid = true } = {}) => {
    const signedAt = Math.floor(Date.parse(clock) / 1000), raw = JSON.stringify(event), signature = createHmac('sha256', environment.STRIPE_WEBHOOK_SECRET).update(`${signedAt}.${raw}`).digest('hex');
    return handlers.post({ env: environment, request: new Request(`${origin}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${signedAt},v1=${valid ? signature : '0'.repeat(64)}` }, body: raw }) });
  };
  return { store, sent, post, advance: ms => { clock = new Date(Date.parse(clock) + ms).toISOString(); } };
}

test('signed webhook records a member once and sends the team alert exactly once', async t => {
  const f = webhookFixture(t), first = await f.post(checkoutEvent());
  assert.equal(first.status, 200); assert.deepEqual(await first.json(), { ok: true, received: true, duplicate: false, membership: 'linked' });
  assert.equal(f.sent.length, 1);
  assert.deepEqual({ alert: f.sent[0].body.alert, plan: f.sent[0].body.plan, hub: f.sent[0].body.hub_customer, event: f.sent[0].body.event_id, address: f.sent[0].body.service_address }, { alert: 'New Garage Guard member — schedule their first visit', plan: 'guard', hub: 'linked', event: 'evt_guard_checkout', address: '1 Synthetic Way, Fort Collins' });
  assert.equal(f.store.get('stripe_events/evt_guard_checkout').alert.status, 'sent');
  const replay = await f.post(checkoutEvent());
  assert.equal(replay.status, 200); assert.equal((await replay.json()).duplicate, true); assert.equal(f.sent.length, 1);
  assert.equal((await f.post(checkoutEvent(), { valid: false })).status, 400);
  const failed = await f.post(invoiceEvent({ id: 'evt_guard_failed', type: 'invoice.payment_failed' }));
  assert.equal(failed.status, 200); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].body.alert, 'Garage Guard renewal payment FAILED — reach out before it lapses');
  assert.equal((await f.post(invoiceEvent({ id: 'evt_guard_paid', created: T0 + 120 }))).status, 200); assert.equal(f.sent.length, 2, 'a renewal is not an alert');
});

test('an unconfirmed alert send is recorded as uncertain and never repeated', async t => {
  const f = webhookFixture(t, { sendFails: true });
  assert.equal((await f.post(checkoutEvent())).status, 200);
  assert.equal(f.store.get('stripe_events/evt_guard_checkout').alert.status, 'uncertain');
  assert.equal((await f.post(checkoutEvent())).status, 200); assert.equal(f.sent.length, 1);
});

test('a storage failure returns 503 before any alert, and the retry records and alerts once', async t => {
  const f = webhookFixture(t);
  f.store.failNextCommit(Object.assign(new Error('offline'), { code: 'dispatch_storage_unavailable', status: 503 }));
  const failed = await f.post(checkoutEvent());
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { ok: false, error: 'Membership recording needs retry' }); assert.equal(f.sent.length, 0);
  assert.equal((await f.post(checkoutEvent())).status, 200); assert.equal(f.sent.length, 1);
  assert.equal(f.store.get('memberships/sub_member_1').status, 'active');
});

test('non-Guard Stripe invoices and subscriptions are ignored without writes or alerts', async t => {
  const f = webhookFixture(t);
  for (const event of [invoiceEvent({ id: 'evt_other_invoice', plan: '' }), invoiceEvent({ id: 'evt_other_failed', type: 'invoice.payment_failed', plan: '', basil: true }), deletedEvent({ id: 'evt_other_deleted', plan: '', subscription: 'sub_unrelated' }), checkoutEvent({ id: 'evt_other_checkout', plan: '' }), { id: 'evt_unhandled', type: 'customer.created', data: { object: {} } }]) {
    const response = await f.post(event);
    assert.equal(response.status, 200); assert.equal((await response.json()).ignored, true);
  }
  assert.equal(f.store.commits.length, 0); assert.equal(f.sent.length, 0);
});

test('with membership sync off the legacy relay is unchanged and never touches storage', async t => {
  const { GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED: _flag, ...legacy } = env;
  const f = webhookFixture(t, { environment: legacy });
  for (let delivery = 0; delivery < 2; delivery++) assert.equal((await f.post(checkoutEvent())).status, 200);
  assert.equal(f.sent.length, 2, 'the pre-M2 relay forwards every delivery');
  assert.equal(f.sent[0].body.alert, 'New Garage Guard member — schedule their first visit'); assert.equal(f.sent[0].body.hub_customer, undefined);
  const renewal = await f.post(invoiceEvent({ id: 'evt_guard_paid' }));
  assert.equal((await renewal.json()).ignored, true); assert.equal(f.sent.length, 2);
  assert.equal(f.store.commits.length, 0); assert.equal(f.store.get('memberships/sub_member_1'), null);
});

function firestore(t, seed) {
  const docs = new Map(), calls = []; let revision = 0;
  const stamp = () => `2026-09-22T00:00:00.${String(++revision).padStart(6, '0')}Z`;
  const document = path => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(docs.get(path).value), updateTime: docs.get(path).updateTime });
  for (const [path, value] of Object.entries(seed)) docs.set(path, { value: structuredClone(value), updateTime: stamp() });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET'; calls.push(`${method} ${url.pathname}`);
    assert.equal(url.hostname, 'firestore.googleapis.com', 'no provider call outside Firestore');
    const rest = decodeURIComponent(url.pathname.split('/documents')[1] || '');
    if (rest === ':runQuery') {
      const query = JSON.parse(options.body).structuredQuery, filter = query.where.fieldFilter;
      return Response.json([...docs.keys()].filter(path => path.startsWith(`${query.from[0].collectionId}/`) && docs.get(path).value[filter.field.fieldPath] === filter.value.stringValue).slice(0, query.limit).map(path => ({ document: document(path) })));
    }
    // dispatchStorage verifies read fences inside a read-write transaction.
    if (rest === ':beginTransaction') return Response.json({ transaction: `synthetic-transaction-${calls.length}` });
    if (rest === ':rollback') return Response.json({});
    if (rest === ':batchGet') {
      const body = JSON.parse(options.body); assert.ok(body.transaction, 'fences are read inside the commit transaction');
      return Response.json(body.documents.map(name => { const path = name.split('/documents/')[1]; return docs.has(path) ? { found: document(path) } : { missing: name }; }));
    }
    if (rest === ':commit') {
      const writes = JSON.parse(options.body).writes, paths = writes.map(write => write.update.name.split('/documents/')[1]);
      for (const [index, write] of writes.entries()) { const row = docs.get(paths[index]); if (write.currentDocument.exists === false ? row : row?.updateTime !== write.currentDocument.updateTime) return Response.json({}, { status: 409 }); }
      for (const [index, write] of writes.entries()) docs.set(paths[index], { value: { ...(docs.get(paths[index])?.value || {}), ...decodeFirestoreFields(write.update.fields) }, updateTime: stamp() });
      return Response.json({ commitTime: NOW });
    }
    assert.equal(method, 'GET');
    const path = rest.replace(/^\//, '');
    if (!path.includes('/')) return Response.json({ documents: [...docs.keys()].filter(key => key.startsWith(`${path}/`)).map(document) });
    return docs.has(path) ? Response.json(document(path)) : Response.json({}, { status: 404 });
  });
  return { docs, calls, get: path => docs.get(path)?.value };
}

test('the Firestore adapter links a member and the customer portal shows the mirrored membership', async t => {
  const db = firestore(t, account()), sent = [];
  const handlers = stripeWebhookHandlers({ now: () => new Date(NOW), send: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{}'); } });
  const post = event => { const raw = JSON.stringify(event), signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${T0}.${raw}`).digest('hex'); return handlers.post({ env, request: new Request(`${origin}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${T0},v1=${signature}` }, body: raw }) }); };
  const cookie = (await createCustomerPortalSessionCookie(env, 'job-child', { linkVersion: 0 })).split(';')[0];
  const view = async () => (await (await portal.onRequestGet({ env, request: new Request(`${origin}/api/customer-portal`, { headers: { Cookie: cookie } }) })).json()).experience.garageGuard;
  assert.deepEqual(await view(), { plan: '', status: '', visitsIncluded: 0, visitsRemaining: 0, nextVisit: '2026-10-05', renewalDate: '' });
  assert.equal((await post(checkoutEvent())).status, 200);
  assert.ok(db.calls.includes('POST /v1/projects/egcw-1ec83/databases/(default)/documents:runQuery'), 'account jobs come from an exact customerId query');
  assert.equal(db.get('memberships/sub_member_1').link.accountJobId, 'job-root'); assert.equal(db.get('stripe_events/evt_guard_checkout').alert.status, 'sent'); assert.equal(sent.length, 1);
  assert.deepEqual(await view(), { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, nextVisit: '2026-10-05', renewalDate: '' });
  const periodEnd = Math.floor(Date.parse('2027-09-22T05:30:00.000Z') / 1000);
  assert.equal((await post(invoiceEvent({ id: 'evt_guard_failed', type: 'invoice.payment_failed', periodEnd }))).status, 200);
  assert.equal((await view()).status, 'past_due');
  assert.equal((await post(invoiceEvent({ id: 'evt_guard_paid', created: T0 + 120, periodEnd, basil: true }))).status, 200);
  assert.deepEqual(await view(), { plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 4, nextVisit: '2026-10-05', renewalDate: '2027-09-21' });
  assert.equal((await post(deletedEvent({ plan: '' }))).status, 200);
  assert.equal((await view()).status, 'cancelled'); assert.equal(sent.length, 3);
  assert.equal(db.get('jobs/job-child').garageGuard, undefined, 'only the account root carries the display copy');
});

test('the link commit fences the identity revision and every account revision the decision read', async () => {
  const store = memoryStore(); await apply(store, checkoutEvent());
  assert.deepEqual(store.commits, [['jobs/job-root', 'memberships/sub_member_1', 'stripe_events/evt_guard_checkout']]);
  assert.deepEqual(store.verified, [['customerIdentityState/revision', 'jobs/job-child']], 'the mirrored root is fenced by its own revisioned write');
  const unmatched = memoryStore(); await apply(unmatched, checkoutEvent({ email: 'new@example.invalid', phone: '+19705550150' }));
  assert.deepEqual(unmatched.verified, [['customerIdentityState/revision']], 'a review decision drawn from the snapshot is fenced too');
  const blind = memoryStore(); await apply(blind, deletedEvent());
  assert.deepEqual(blind.verified, [[]], 'no identity means no customer decision to fence');
});

test('a duplicate customer created after the reads sends the link back through fresh reads to review', async () => {
  const store = memoryStore();
  // resolveCustomer creates the duplicate and bumps customerIdentityState/revision in one commit.
  store.raceNextCommit(() => { store.put('customers/cust-dana-2', { name: 'Synthetic Dana Duplicate', phone: '970.555.0101' }); store.put('customerIdentityState/revision', { updatedAt: NOW, lastRequestId: 'synthetic-race' }); });
  const result = await apply(store, checkoutEvent());
  assert.deepEqual({ link: result.link, reason: result.reason, mirrored: result.mirrored }, { link: 'needs_review', reason: 'ambiguous_customer', mirrored: false });
  assert.deepEqual(store.get('jobs/job-root').garageGuard, { nextVisit: '2026-10-05' }, 'no mirror from the stale one-customer decision');
  assert.deepEqual(store.get('membership_reviews/sub_member_1').candidateCustomerIds, ['cust-dana', 'cust-dana-2']);
  assert.deepEqual(store.commits, [['membership_reviews/sub_member_1', 'memberships/sub_member_1', 'stripe_events/evt_guard_checkout']], 'only the fresh decision is written');
});

test('a visit re-rooted after the reads makes the link retry and go to review', async () => {
  const store = memoryStore();
  store.raceNextCommit(() => store.put('jobs/job-child', { ...store.get('jobs/job-child'), customerAccountOwnerJobId: 'job-unrelated' }));
  const result = await apply(store, checkoutEvent());
  assert.deepEqual({ link: result.link, reason: result.reason, mirrored: result.mirrored }, { link: 'needs_review', reason: 'account_link_invalid', mirrored: false });
  assert.deepEqual(store.get('jobs/job-root').garageGuard, { nextVisit: '2026-10-05' });
  // The root changing between the lineage read and its own read is retried the same way.
  const root = memoryStore(); let reads = 0;
  const racing = { ...root, async read(collection, id) { if (collection === 'jobs' && id === 'job-root' && ++reads === 2) root.put('jobs/job-root', { ...root.get('jobs/job-root'), customerAccountOwnerJobId: 'job-child' }); return root.read(collection, id); } };
  const moved = await applyGarageGuardEvent(racing, garageGuardEvent(checkoutEvent()), { now: NOW, alerts: true });
  assert.equal(moved.link, 'needs_review'); assert.equal(moved.mirrored, false); assert.equal(root.get('jobs/job-root').garageGuard.plan, undefined);
});

test('the first link creates the identity guard, and a concurrent first resolution wins cleanly', async () => {
  const seed = account(); delete seed['customerIdentityState/revision'];
  const store = memoryStore(seed); await apply(store, checkoutEvent());
  assert.deepEqual(store.commits, [['jobs/job-root', 'memberships/sub_member_1', 'stripe_events/evt_guard_checkout', 'customerIdentityState/revision']]);
  assert.deepEqual(store.get('customerIdentityState/revision'), { updatedAt: NOW, lastStripeEventId: 'evt_guard_checkout' });
  const raced = memoryStore(structuredClone(seed));
  raced.raceNextCommit(() => raced.put('customerIdentityState/revision', { updatedAt: NOW, lastRequestId: 'synthetic-first-resolve' }));
  assert.equal((await apply(raced, checkoutEvent())).link, 'linked');
  assert.equal(raced.get('customerIdentityState/revision').lastRequestId, 'synthetic-first-resolve', 'the guard created meanwhile is fenced, not overwritten');
  assert.deepEqual(raced.verified.at(-1), ['customerIdentityState/revision', 'jobs/job-child']);
});

test('an unconfirmed alert claim returns 503 and the redelivery sends the alert exactly once', async t => {
  const f = webhookFixture(t);
  f.store.failNextCommit(null, unknown());
  const first = await f.post(checkoutEvent());
  assert.equal(first.status, 503); assert.deepEqual(await first.json(), { ok: false, error: 'Membership alert needs retry', membership: 'linked' });
  assert.equal(f.sent.length, 0, 'an unconfirmed claim is never followed by a send');
  assert.equal(f.store.get('memberships/sub_member_1').status, 'active', 'the membership itself is recorded');
  assert.equal(f.store.get('stripe_events/evt_guard_checkout').alert.status, 'pending');
  const redelivery = await f.post(checkoutEvent());
  assert.equal(redelivery.status, 200); assert.equal((await redelivery.json()).duplicate, true);
  assert.equal(f.sent.length, 1); assert.equal(f.store.get('stripe_events/evt_guard_checkout').alert.status, 'sent');
  assert.equal((await f.post(checkoutEvent())).status, 200); assert.equal(f.sent.length, 1);
  // A claim whose response was lost is still this delivery's, so it sends once without a redelivery.
  const lost = webhookFixture(t); lost.store.loseNextResponse(1);
  assert.equal((await lost.post(checkoutEvent())).status, 200); assert.equal(lost.sent.length, 1);
  assert.equal(lost.store.get('stripe_events/evt_guard_checkout').alert.status, 'sent');
});

test('an unsettled send is never repeated: Stripe redelivers until it is recorded uncertain', async t => {
  const f = webhookFixture(t);
  f.store.failNextCommit(null, null, unknown(), unknown(), unknown());
  const first = await f.post(checkoutEvent());
  assert.equal(first.status, 503); assert.equal(f.sent.length, 1);
  assert.equal(f.store.get('stripe_events/evt_guard_checkout').alert.status, 'sending');
  const early = await f.post(checkoutEvent());
  assert.equal(early.status, 503, 'a claim this recent may still be in flight'); assert.equal(f.sent.length, 1);
  f.advance(ALERT_STALE_MS);
  const stale = await f.post(checkoutEvent());
  assert.equal(stale.status, 200); assert.equal(f.sent.length, 1, 'the claimed alert is not sent again');
  const alert = f.store.get('stripe_events/evt_guard_checkout').alert;
  assert.deepEqual({ status: alert.status, reason: alert.reason, claimedAt: alert.claimedAt, settledAt: alert.settledAt }, { status: 'uncertain', reason: 'unsettled_claim', claimedAt: NOW, settledAt: new Date(Date.parse(NOW) + ALERT_STALE_MS).toISOString() });
  assert.equal((await f.post(checkoutEvent())).status, 200); assert.equal(f.sent.length, 1);
  const direct = memoryStore(); await apply(direct, checkoutEvent());
  assert.equal(await expireGarageGuardAlert(direct, 'evt_guard_checkout', NOW), true, 'nothing claimed, nothing to expire');
});

test('Zapier forwards carry a 15 s timeout and map 408, 5xx and timeouts to uncertain', async t => {
  const timeouts = [], abort = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return abort(ms); });
  assert.equal(hookDelivery(new Response('{}', { status: 200 })), 'sent'); assert.equal(hookDelivery(new Response(null, { status: 204 })), 'sent');
  assert.equal(hookDelivery(new Response('{}', { status: 400 })), 'failed'); assert.equal(hookDelivery(new Response('{}', { status: 410 })), 'failed');
  for (const status of [408, 500, 502, 503]) assert.equal(hookDelivery(new Response('{}', { status })), 'uncertain', String(status));
  assert.equal(hookDelivery(undefined), 'uncertain');
  const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  for (const [respond, expected] of [[() => new Response('{}', { status: 503 }), 'uncertain'], [() => new Response('{}', { status: 408 }), 'uncertain'], [() => new Response('{}', { status: 422 }), 'failed'], [timeout, 'uncertain']]) {
    const f = webhookFixture(t, { respond });
    assert.equal((await f.post(checkoutEvent())).status, 200);
    assert.equal(f.store.get('stripe_events/evt_guard_checkout').alert.status, expected);
    assert.ok(f.sent[0].init.signal instanceof AbortSignal);
    assert.equal((await f.post(checkoutEvent())).status, 200); assert.equal(f.sent.length, 1, 'never resent');
  }
  assert.ok(timeouts.length >= 4 && timeouts.every(ms => ms === 15000), 'every Zapier forward is bounded at 15 s');
});

// Verbatim copy of the pre-M2 relay summary (functions/api/stripe-webhook.js at 31ecce1).
function legacySummarize(event) {
  const obj = (event.data && event.data.object) || {};
  const base = {
    source: 'stripe-webhook',
    event_type: event.type,
    livemode: !!event.livemode,
    event_id: String(event.id || ''),
  };
  if (event.type === 'checkout.session.completed') {
    const details = obj.customer_details || {};
    const addressField = (obj.custom_fields || []).find((f) => f.key === 'service_address');
    return {
      ...base,
      alert: 'New Garage Guard member — schedule their first visit',
      plan: (obj.metadata && obj.metadata.plan) || '',
      customer_name: String(details.name || ''),
      customer_email: String(details.email || ''),
      customer_phone: String(details.phone || ''),
      service_address: String((addressField && addressField.text && addressField.text.value) || ''),
      amount_total: obj.amount_total != null ? (obj.amount_total / 100).toFixed(2) : '',
    };
  }
  if (event.type === 'invoice.payment_failed') {
    return {
      ...base,
      alert: 'Garage Guard renewal payment FAILED — reach out before it lapses',
      customer_email: String(obj.customer_email || ''),
      customer_name: String(obj.customer_name || ''),
      amount_due: obj.amount_due != null ? (obj.amount_due / 100).toFixed(2) : '',
    };
  }
  if (event.type === 'customer.subscription.deleted') {
    return {
      ...base,
      alert: 'Garage Guard membership cancelled',
      plan: (obj.metadata && obj.metadata.plan) || '',
      customer: String(obj.customer || ''),
    };
  }
  return base;
}

test('with membership sync off every Zapier payload is byte-for-byte the pre-M2 relay', async t => {
  const { GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED: _flag, ...legacy } = env;
  const f = webhookFixture(t, { environment: legacy });
  const failed = invoiceEvent({ id: 'evt_legacy_failed', type: 'invoice.payment_failed' });
  Object.assign(failed.data.object, { amount_due: 80000, customer_name: 'Synthetic Dana' });
  const events = [
    checkoutEvent({ id: 'evt_legacy_checkout', paymentStatus: 'unpaid' }),
    checkoutEvent({ id: 'evt_legacy_async', type: 'checkout.session.async_payment_succeeded' }),
    { ...checkoutEvent({ id: 'evt_legacy_live' }), livemode: true },
    failed, invoiceEvent({ id: 'evt_legacy_failed_basil', type: 'invoice.payment_failed', basil: true }),
    deletedEvent({ id: 'evt_legacy_deleted' }), deletedEvent({ id: 'evt_legacy_deleted_bare', plan: '' }),
  ];
  for (const event of events) {
    const response = await f.post(event);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, received: true });
  }
  assert.deepEqual(f.sent.map(item => item.raw), events.map(event => JSON.stringify(legacySummarize(event))));
  assert.equal(f.sent[1].body.alert, undefined, 'an async payment success is not a second "new member" alert');
  assert.ok(f.sent.every(item => item.init.signal instanceof AbortSignal && item.init.method === 'POST' && item.init.headers['Content-Type'] === 'application/json'));
  const renewal = await f.post(invoiceEvent({ id: 'evt_legacy_paid' }));
  assert.deepEqual(await renewal.json(), { ok: true, received: true, ignored: true }); assert.equal(f.sent.length, events.length);
  assert.equal(f.store.commits.length, 0);
});
