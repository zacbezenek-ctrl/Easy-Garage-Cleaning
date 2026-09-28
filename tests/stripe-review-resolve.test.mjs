import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { applyGarageGuardEvent, garageGuardEvent } from '../functions/_lib/garage-guard-membership.js';
import { STRIPE_REVIEW_OPERATIONS, resolveStripeReview, stripeReviewClient, stripeReviewOverview, stripeReviewStorage } from '../functions/_lib/stripe-reviews.js';
import { stripeReviewHandlers } from '../functions/api/stripe-reviews.js';

const NOW = '2026-09-22T12:00:00.000Z', LATER = '2026-09-23T12:00:00.000Z';
const T0 = Math.floor(Date.parse(NOW) / 1000);
const origin = 'https://easygaragecleaning.com';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const crew = { user: 'crew1', role: 'crew', businessAccess: false };
const conflict = () => Object.assign(new Error('Synthetic revision conflict'), { code: 'dispatch_revision_conflict', status: 409 });
const unknown = () => Object.assign(new Error('Synthetic unknown outcome'), { code: 'dispatch_outcome_unknown', status: 503 });
const code = (expected, status) => error => { assert.equal(error.code, expected); if (status) assert.equal(error.status, status); return true; };

const held = (sessionId, extra = {}) => ({ sessionId, jobId: 'job-1', kind: 'egc_job_payment', reason: 'payment_exceeds_balance', status: 'open', amountCents: 50000, currency: 'usd', paymentIntentId: `pi_${sessionId}`, livemode: false, jobRevision: 'r1', jobTotalCents: 100000, jobPaidCents: 70000, jobBalanceCents: 30000, createdBy: 'crew1', recordedBy: 'stripe_webhook', createdAt: '2026-09-21T12:00:00.000Z', ...extra });
const seed = () => ({
  'jobs/job-1': { type: 'job', customer: 'Synthetic Customer', total: 1000, payment: { amount: 700, verified: true, method: 'check', stripeSessions: [] } },
  'payment_reviews/cs_test_held': held('cs_test_held'),
  'payment_reviews/cs_test_applied': held('cs_test_applied', { createdAt: '2026-09-20T12:00:00.000Z' }),
  'customerIdentityState/revision': { updatedAt: '2026-09-01T12:00:00.000Z' },
  // Two customers share the member's phone, so the webhook cannot choose and opens a review.
  'customers/cust-dana': { name: 'Synthetic Dana', phone: '(970) 555-0101', email: 'dana@example.invalid', address: '1 Synthetic Way' },
  'customers/cust-twin': { name: 'Synthetic Twin', phone: '970-555-0101', email: 'twin@example.invalid', address: '9 Other Way' },
  'jobs/job-root': { type: 'job', customerId: 'cust-dana', customer: 'Synthetic Dana', address: '1 Synthetic Way', garageGuard: { nextVisit: '2026-10-05' } },
  'jobs/job-child': { type: 'job', customerId: 'cust-dana', customerAccountOwnerJobId: 'job-root', customer: 'Synthetic Dana', status: 'scheduled' },
});

// Revisioned in-memory store with the dispatchStorage commit contract (create-only
// without a revision, exact-revision updates, verify-only fences) plus list/readMany.
function memoryStore(initial = seed()) {
  const rows = new Map(), commits = [];
  let revision = 0, failures = [], loseResponse = false;
  const stamp = () => `2026-09-22T00:00:00.${String(++revision).padStart(6, '0')}Z`;
  const put = (path, value) => rows.set(path, { value: structuredClone(value), revision: stamp() });
  for (const [path, value] of Object.entries(initial)) put(path, value);
  const out = (path, row) => ({ ...structuredClone(row.value), id: path.split('/').slice(1).join('/'), revision: row.revision });
  const within = collection => [...rows].filter(([path]) => path.startsWith(`${collection}/`));
  return {
    rows, commits, put,
    get: path => rows.has(path) ? structuredClone(rows.get(path).value) : null,
    revisionOf: path => rows.get(path)?.revision,
    edit: (path, patch) => put(path, { ...rows.get(path).value, ...patch }),
    failNextCommit: (...errors) => { failures = errors; },
    loseNextResponse: () => { loseResponse = true; },
    audits: () => within('hub_audit').map(([path, row]) => out(path, row)),
    async read(collection, id) { const path = `${collection}/${id}`; return rows.has(path) ? out(path, rows.get(path)) : null; },
    async readMany(collection, ids) { return ids.filter(id => rows.has(`${collection}/${id}`)).map(id => out(`${collection}/${id}`, rows.get(`${collection}/${id}`))); },
    async customers() { return within('customers').map(([path, row]) => out(path, row)); },
    async customerJobs(customerId, limit) { return within('jobs').filter(([, row]) => row.value.customerId === customerId).slice(0, limit).map(([path, row]) => out(path, row)); },
    async list(collection) { return { rows: within(collection).map(([path, row]) => out(path, row)), complete: true }; },
    async commit(writes) {
      const failure = failures.shift();
      if (failure) throw failure;
      const paths = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(paths).size, paths.length, 'a commit never writes or verifies the same document twice');
      for (const [index, write] of writes.entries()) { const row = rows.get(paths[index]); if (write.verify ? row?.revision !== write.revision : write.revision ? row?.revision !== write.revision : row) throw conflict(); }
      for (const [index, write] of writes.entries()) if (!write.verify) rows.set(paths[index], { value: { ...(rows.get(paths[index])?.value || {}), ...structuredClone(write.patch) }, revision: stamp() });
      commits.push({ writes: paths.filter((_, index) => !writes[index].verify), verified: paths.filter((_, index) => writes[index].verify) });
      if (loseResponse) { loseResponse = false; throw unknown(); }
    },
  };
}

const request = (review, action, extra = {}) => ({ action, requestId: randomUUID(), reviewId: review.id, expectedRevision: review.revision, ...extra });
// Stripe's read-only view of a held $500 checkout on job-1, with refundedCents refunded (none by default).
const stripeShows = (refundedCents = 0, extra = {}) => async path => ({ id: decodeURIComponent(path.split('/')[2].split('?')[0]), client_reference_id: 'job-1', metadata: { job_id: 'job-1' }, amount_total: 50000, livemode: false,
  payment_intent: { id: 'pi_synthetic', latest_charge: { amount_refunded: refundedCents, refunded: refundedCents >= 50000 } }, ...extra });
const reviewOf = async (store, path) => { const [collection, id] = path.split('/'); return store.read(collection, id); };
const checkout = ({ id = 'evt_guard_checkout', subscription = 'sub_member_1', phone = '+1 970 555 0101' } = {}) => ({ id, type: 'checkout.session.completed', created: T0, livemode: false, data: { object: {
  id: 'cs_test_guard_1', mode: 'subscription', status: 'complete', payment_status: 'paid', subscription, customer: 'cus_member_1', metadata: { plan: 'guard' },
  customer_details: { phone, name: 'Synthetic Dana' }, custom_fields: [{ key: 'service_address', text: { value: '1 Synthetic Way' } }] } } });
const renewal = ({ id = 'evt_guard_renewal', subscription = 'sub_member_1' } = {}) => ({ id, type: 'invoice.paid', created: T0 + 3600, livemode: false, data: { object: {
  id: 'in_synthetic', billing_reason: 'subscription_cycle', customer: 'cus_member_1', subscription, subscription_details: { metadata: { plan: 'guard' } },
  lines: { data: [{ type: 'subscription', subscription, period: { start: T0, end: T0 + 365 * 86400 }, metadata: { plan: 'guard' } }] } } } });
async function flagged(store = memoryStore()) {
  const outcome = await applyGarageGuardEvent(store, garageGuardEvent(checkout()), { now: NOW });
  assert.equal(outcome.reason, 'ambiguous_customer');
  return store;
}

test('a manager marks a held charge reconciled: one commit with the receipt and audit, and a replay returns the same result', async () => {
  const store = memoryStore(), review = await reviewOf(store, 'payment_reviews/cs_test_held');
  // The charge is not on the job, so the manager must say how it was reconciled.
  await assert.rejects(resolveStripeReview(store, manager, request(review, 'payment.reconcile'), NOW), code('stripe_review_invalid_field', 400));
  assert.equal(store.commits.length, 0);
  const input = request(review, 'payment.reconcile', { note: 'Applied $300 by check; $200 refunded in Stripe' });
  const result = await resolveStripeReview(store, manager, input, NOW, { stripe: stripeShows() });
  assert.deepEqual({ ...result.review, revision: undefined }, { id: 'cs_test_held', kind: 'payment', revision: undefined, status: 'resolved', resolution: 'reconciled', resolvedAt: NOW, resolvedBy: 'tylerg', note: 'Applied $300 by check; $200 refunded in Stripe', jobId: 'job-1', amountCents: 50000, refundReason: '', refundedCents: null, refundFull: false, keptCents: null, recordedOnJobAtResolution: false });
  assert.equal(result.replayed, false);
  const [commit] = store.commits, receipt = store.get(`${STRIPE_REVIEW_OPERATIONS}/${input.requestId}`), [audit] = store.audits();
  assert.deepEqual(commit.writes.slice(0, 2), ['payment_reviews/cs_test_held', `${STRIPE_REVIEW_OPERATIONS}/${input.requestId}`]);
  assert.equal(commit.writes[2], `hub_audit/${audit.id}`, 'the audit entry is in the same commit as the resolution');
  assert.deepEqual([commit.writes[3], commit.verified], ['jobs/job-1', []], 'the job gets a marker at the revision the resolution read, in the same commit');
  assert.equal(store.get('jobs/job-1').paymentReviewResolvedAt, NOW);
  assert.deepEqual([receipt.actorId, receipt.reviewCollection, receipt.reviewId, receipt.auditId, receipt.createdAt], ['tylerg', 'payment_reviews', 'cs_test_held', audit.id, NOW]);
  assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual([audit.action, audit.visibility, audit.reason, audit.entityKey, audit.actor.id], ['stripe_review.payment.reconcile', 'business', 'Applied $300 by check; $200 refunded in Stripe', 'payment_reviews/cs_test_held', 'tylerg']);
  const saved = store.get('payment_reviews/cs_test_held');
  assert.deepEqual([saved.status, saved.resolution, saved.recordedOnJobAtResolution, saved.resolveRequestId, saved.jobRevision], ['resolved', 'reconciled', false, input.requestId, 'r1']);
  assert.deepEqual(store.get('jobs/job-1').payment, { amount: 700, verified: true, method: 'check', stripeSessions: [] }, 'resolving never changes the job money');
  const replay = await resolveStripeReview(store, manager, input, LATER);
  assert.equal(replay.replayed, true); assert.equal(replay.review.resolvedAt, NOW); assert.equal(store.commits.length, 1);
  await assert.rejects(resolveStripeReview(store, manager, { ...input, note: 'different' }, NOW), code('stripe_review_idempotency_conflict', 409));
  await assert.rejects(resolveStripeReview(store, owner, input, NOW), code('stripe_review_idempotency_conflict', 409), 'a request ID belongs to the person who sent it');
  await assert.rejects(resolveStripeReview(store, manager, request(await reviewOf(store, 'payment_reviews/cs_test_held'), 'payment.reconcile', { note: 'again' }), NOW), code('stripe_review_already_resolved', 409));
  // The resolved review leaves the open queue.
  const view = await stripeReviewOverview(store, manager, new Date(NOW));
  assert.deepEqual(view.paymentReviews.map(row => row.sessionId), ['cs_test_applied']);
  assert.equal(view.viewer.canRecordRefund, false, 'managers see that only the owner records refunds');
});

test('a charge the job already shows can be reconciled without a note; stale revisions, bad input and crew are refused before anything is written', async () => {
  const store = memoryStore();
  store.edit('jobs/job-1', { payment: { amount: 1200, verified: true, stripeSessions: [{ sessionId: 'cs_test_applied' }] } });
  const review = await reviewOf(store, 'payment_reviews/cs_test_applied');
  await assert.rejects(resolveStripeReview(store, crew, request(review, 'payment.reconcile'), NOW), code('dispatch_forbidden', 403));
  await assert.rejects(resolveStripeReview(store, null, request(review, 'payment.reconcile'), NOW), code('dispatch_sign_in_required', 401));
  for (const bad of [{ requestId: 'not-a-uuid' }, { action: 'payment.delete' }, { reviewId: 'sub_member_1' }, { reviewId: 'cs_test/../x' }, { expectedRevision: '' }, { amountCents: 1 }, { note: 42 }, { note: 'x'.repeat(501) }]) {
    await assert.rejects(resolveStripeReview(store, manager, { ...request(review, 'payment.reconcile'), ...bad }, NOW), error => /^stripe_review_(request_invalid|invalid_field)$/.test(error.code) && error.status === 400, JSON.stringify(bad));
  }
  await assert.rejects(resolveStripeReview(store, manager, { ...request(review, 'payment.reconcile'), actorId: 'someone-else' }, NOW), code('stripe_review_actor_changed', 403));
  await assert.rejects(resolveStripeReview(store, manager, { ...request(review, 'payment.reconcile'), expectedRevision: 'stale' }, NOW), code('stripe_review_revision_conflict', 409));
  await assert.rejects(resolveStripeReview(store, manager, { ...request(review, 'payment.reconcile'), reviewId: 'cs_test_missing' }, NOW), code('stripe_review_not_found', 404));
  assert.equal(store.commits.length, 0);
  const result = await resolveStripeReview(store, manager, request(review, 'payment.reconcile'), NOW, { stripe: stripeShows() });
  assert.equal(store.get('payment_reviews/cs_test_applied').recordedOnJobAtResolution, true);
  assert.equal(result.review.note, '');
});

test('a lost commit response is recovered from the receipt, and a racing change is a conflict with nothing half-applied', async () => {
  const store = memoryStore(), review = await reviewOf(store, 'payment_reviews/cs_test_held');
  const input = request(review, 'payment.reconcile', { note: 'Matched to the bank deposit' });
  store.loseNextResponse();
  const recovered = await resolveStripeReview(store, manager, input, NOW, { stripe: stripeShows() });
  assert.deepEqual([recovered.replayed, recovered.review.resolution, store.commits.length], [false, 'reconciled', 1]);
  const other = memoryStore(), fresh = await reviewOf(other, 'payment_reviews/cs_test_held');
  other.failNextCommit(conflict());
  await assert.rejects(resolveStripeReview(other, manager, request(fresh, 'payment.reconcile', { note: 'Matched to the bank deposit' }), NOW, { stripe: stripeShows() }), code('dispatch_revision_conflict', 409));
  assert.equal(other.get('payment_reviews/cs_test_held').status, 'open'); assert.equal(other.audits().length, 0);
});

test('only the owner records a refund, only once Stripe shows it, and the refund note stays owner-only', async () => {
  const store = memoryStore(), review = await reviewOf(store, 'payment_reviews/cs_test_held'), calls = [];
  let charge = { amount: 50000, amount_refunded: 0, refunded: false }, session = {};
  const stripe = async path => { calls.push(path); return { id: 'cs_test_held', client_reference_id: 'job-1', metadata: { job_id: 'job-1', kind: 'egc_job_payment' }, amount_total: 50000, livemode: false, payment_intent: { id: 'pi_cs_test_held', latest_charge: charge }, ...session }; };
  const refund = extra => request(review, 'payment.refund', { reason: 'exceeds_balance', note: 'Customer paid twice; refunded the $500 card charge', ...extra });
  await assert.rejects(resolveStripeReview(store, manager, refund(), NOW, { stripe }), code('stripe_review_owner_required', 403));
  await assert.rejects(resolveStripeReview(store, { ...manager, user: 'zacb' }, refund(), NOW, { stripe }), code('stripe_review_owner_required', 403), 'the owner role is required, not only the username');
  assert.equal(calls.length, 0, 'Stripe is never asked for a manager');
  await assert.rejects(resolveStripeReview(store, owner, refund({ reason: 'because' }), NOW, { stripe }), code('stripe_review_invalid_field', 400));
  // Not retryable: the same request cannot succeed until the Stripe key is set, so the Hub must not keep it as pending.
  await assert.rejects(resolveStripeReview(store, owner, refund(), NOW, { stripe: null }), code('stripe_review_stripe_unconfigured', 409));
  await assert.rejects(resolveStripeReview(store, owner, refund(), NOW, { stripe }), code('stripe_review_refund_not_found', 409));
  assert.deepEqual(calls, ['checkout/sessions/cs_test_held?expand[]=payment_intent.latest_charge']);
  for (const mismatch of [{ amount_total: 40000 }, { metadata: { job_id: 'job-2' }, client_reference_id: 'job-2' }, { livemode: true }, { id: 'cs_test_other' }, { payment_intent: 'pi_unexpanded' }]) {
    session = mismatch; charge = { amount: 50000, amount_refunded: 50000, refunded: true };
    await assert.rejects(resolveStripeReview(store, owner, refund(), NOW, { stripe }), code('stripe_review_stripe_mismatch', 409), JSON.stringify(mismatch));
  }
  assert.equal(store.commits.length, 0, 'nothing is recorded until Stripe shows the refund');
  session = {}; charge = { amount: 50000, amount_refunded: 20000, refunded: false };
  // Only part was refunded and the charge is not on the job: the owner confirms the exact amount kept first.
  const partial = error => error.code === 'stripe_review_refund_partial' && error.status === 409 && JSON.stringify(error.details) === JSON.stringify({ amountCents: 50000, refundedCents: 20000, keptCents: 30000 }) && /\$200\.00 of \$500\.00 refunded\. The \$300\.00 kept is not on the job/.test(error.message);
  await assert.rejects(resolveStripeReview(store, owner, refund(), NOW, { stripe }), partial);
  await assert.rejects(resolveStripeReview(store, owner, refund({ keptCentsAcknowledged: 50000 }), NOW, { stripe }), partial, 'an acknowledgement of a different amount is not an acknowledgement');
  for (const bad of ['30000', 0, -1, 1.5, true]) await assert.rejects(resolveStripeReview(store, owner, refund({ keptCentsAcknowledged: bad }), NOW, { stripe }), code('stripe_review_invalid_field', 400), JSON.stringify(bad));
  await assert.rejects(resolveStripeReview(store, owner, request(review, 'payment.reconcile', { note: 'Kept $300', keptCentsAcknowledged: 30000 }), NOW), code('stripe_review_request_invalid', 400), 'only a refund takes the amount kept');
  assert.equal(store.commits.length, 0, 'nothing is recorded before the owner confirms the amount kept');
  const result = await resolveStripeReview(store, owner, refund({ keptCentsAcknowledged: 30000 }), NOW, { stripe });
  assert.deepEqual([result.review.resolution, result.review.refundReason, result.review.refundedCents, result.review.refundFull, result.review.keptCents, result.review.note], ['refunded', 'exceeds_balance', 20000, false, 30000, 'Customer paid twice; refunded the $500 card charge']);
  const [audit] = store.audits();
  assert.deepEqual([audit.visibility, audit.reason], ['owner', 'More than the job balance: Customer paid twice; refunded the $500 card charge (Stripe shows $200.00 of $500.00 refunded; the $300.00 kept is not on the job)'], 'managers never read the refund note in the audit log');
  assert.deepEqual([JSON.parse(audit.after).keptCents, JSON.parse(audit.after).refundedCents], [30000, 20000], 'the owner-only audit keeps the amount kept');
  assert.equal(store.get('payment_reviews/cs_test_held').refundedCents, 20000);
  assert.equal(store.get('payment_reviews/cs_test_held').keptCents, 30000);
  assert.equal(store.get('payment_reviews/cs_test_held').recordedOnJobAtResolution, false);
  assert.deepEqual([store.commits.at(-1).writes.at(-1), store.commits.at(-1).verified], ['jobs/job-1', []], 'the job gets a marker at the revision the refund read');
  assert.deepEqual([store.get('jobs/job-1').paymentReviewResolvedAt, store.get('jobs/job-1').payment], [NOW, { amount: 700, verified: true, method: 'check', stripeSessions: [] }], 'the marker never changes the job money');
});

test('a full refund needs no amount confirmation and saves nothing kept; a partial refund of a charge on the job needs only the job acknowledgement', async () => {
  const store = memoryStore(), review = await reviewOf(store, 'payment_reviews/cs_test_held');
  let refunded = { amount_refunded: 50000, refunded: true };
  const stripe = async () => ({ id: review.id, client_reference_id: 'job-1', metadata: { job_id: 'job-1' }, amount_total: 50000, livemode: false, payment_intent: { id: 'pi_x', latest_charge: refunded } });
  const full = await resolveStripeReview(store, owner, request(review, 'payment.refund', { reason: 'duplicate_charge' }), NOW, { stripe });
  assert.deepEqual([full.review.refundFull, full.review.refundedCents, full.review.keptCents], [true, 50000, 0]);
  assert.equal(store.audits()[0].reason, 'Duplicate charge', 'a full refund adds no amounts to the reason');
  // The job already counts the $500: the $300 kept is on it, and the job acknowledgement covers the correction.
  store.edit('jobs/job-1', { payment: { amount: 1200, verified: true, stripeSessions: [{ sessionId: 'cs_test_applied', amount: 500 }] } });
  const applied = await reviewOf(store, 'payment_reviews/cs_test_applied');
  refunded = { amount_refunded: 20000, refunded: false };
  const onJob = await resolveStripeReview(store, owner, request(applied, 'payment.refund', { reason: 'exceeds_balance', jobPaymentAcknowledged: true }), NOW, { stripe: async () => ({ ...(await stripe()), id: applied.id }) });
  assert.deepEqual([onJob.review.refundFull, onJob.review.keptCents, onJob.review.recordedOnJobAtResolution], [false, 30000, true]);
  assert.equal(store.audits().find(audit => audit.entityKey === 'payment_reviews/cs_test_applied').reason, 'More than the job balance (Stripe shows $200.00 of $500.00 refunded; the job still counts this charge as paid)');
});

test('a charge Stripe shows refunded is settled only by the owner: a manager cannot reconcile it, the owner can', async () => {
  const store = memoryStore();
  store.edit('payment_reviews/cs_test_held', { reason: 'payment_refunded', heldReason: 'payment_exceeds_balance', refundedCents: 50000, refundSeenAt: NOW });
  const review = await reviewOf(store, 'payment_reviews/cs_test_held');
  await assert.rejects(resolveStripeReview(store, manager, request(review, 'payment.reconcile', { note: 'Refunded the full charge in Stripe' }), NOW), code('stripe_review_owner_required', 403));
  assert.equal(store.commits.length, 0); assert.equal(store.get('payment_reviews/cs_test_held').status, 'open');
  // The queue shows what the crew return saw in Stripe.
  const [row] = (await stripeReviewOverview(store, manager, new Date(NOW))).paymentReviews.filter(item => item.sessionId === 'cs_test_held');
  assert.deepEqual([row.reason, row.refundedCents, row.keptCents, row.heldReason, row.refundSeenAt], ['payment_refunded', 50000, 0, 'payment_exceeds_balance', NOW]);
  const [other] = (await stripeReviewOverview(store, manager, new Date(NOW))).paymentReviews.filter(item => item.sessionId === 'cs_test_applied');
  assert.equal(other.refundedCents, undefined, 'a review without a refund carries no refund fields');
  // While Stripe shows the refund, the owner records it as a refund; a reconcile is refused with the amounts.
  await assert.rejects(resolveStripeReview(store, owner, request(review, 'payment.reconcile', { note: 'Refund confirmed with the bank statement' }), NOW, { stripe: stripeShows(50000) }),
    error => error.code === 'stripe_review_refund_shown' && error.status === 409 && JSON.stringify(error.details) === JSON.stringify({ amountCents: 50000, refundedCents: 50000, keptCents: 0, recordedOnJob: false }) && /Use Record refund/.test(error.message));
  assert.equal(store.commits.length, 0);
  // The owner's exit: Stripe no longer shows the refund (it failed), so the owner closes the review as reconciled.
  const result = await resolveStripeReview(store, owner, request(review, 'payment.reconcile', { note: 'The refund failed; the customer paid by check' }), NOW, { stripe: stripeShows() });
  assert.equal(result.review.resolution, 'reconciled');
  assert.deepEqual([store.audits()[0].visibility, store.audits()[0].reason], ['owner', 'Stripe no longer shows a refund: The refund failed; the customer paid by check']);
});

test('a reconcile checks the charge in Stripe: a refund makes it owner-only, and the owner is sent to Record refund with the amounts', async () => {
  const store = memoryStore(), review = await reviewOf(store, 'payment_reviews/cs_test_held'), calls = [];
  const tracked = (refunded, extra) => { const stripe = stripeShows(refunded, extra); return async path => { calls.push(path); return stripe(path); }; };
  const reconcile = (actor, stripe, extra = {}) => resolveStripeReview(store, actor, request(review, 'payment.reconcile', { note: 'Settled with the customer', ...extra }), NOW, { stripe });
  // Held because it exceeded the balance; the queue never saw a refund, but Stripe shows $200 of $500 refunded.
  await assert.rejects(reconcile(manager, tracked(20000)), code('stripe_review_owner_required', 403));
  assert.deepEqual(calls, ['checkout/sessions/cs_test_held?expand[]=payment_intent.latest_charge'], 'the manager reconcile asked Stripe');
  const partial = error => error.code === 'stripe_review_refund_shown' && error.status === 409 && JSON.stringify(error.details) === JSON.stringify({ amountCents: 50000, refundedCents: 20000, keptCents: 30000, recordedOnJob: false })
    && /Stripe shows \$200\.00 of \$500\.00 refunded, so this charge is settled by recording the refund/.test(error.message) && /Use Record refund, which confirms the \$300\.00 kept\. Nothing was saved\./.test(error.message);
  await assert.rejects(reconcile(owner, tracked(20000)), partial, 'the owner cannot close a partly refunded charge without confirming the amount kept');
  await assert.rejects(reconcile(owner, tracked(20000), { keptCentsAcknowledged: 30000 }), code('stripe_review_request_invalid', 400), 'the amount kept is confirmed only by recording the refund');
  await assert.rejects(reconcile(owner, tracked(50000)), error => error.code === 'stripe_review_refund_shown' && error.details.keptCents === 0 && /Stripe shows the full \$500\.00 refunded/.test(error.message));
  // A charge on the job: the owner records the refund with the job acknowledgement instead.
  store.edit('jobs/job-1', { payment: { amount: 1200, verified: true, stripeSessions: [{ sessionId: 'cs_test_held', amount: 500 }] } });
  const onJob = await reviewOf(store, 'payment_reviews/cs_test_held');
  await assert.rejects(resolveStripeReview(store, owner, request(onJob, 'payment.reconcile'), NOW, { stripe: tracked(20000) }), error => error.code === 'stripe_review_refund_shown' && error.details.recordedOnJob === true && /which confirms the job correction/.test(error.message));
  // The check fails closed: no key, another charge, or Stripe unreachable saves nothing.
  await assert.rejects(reconcile(manager, null), code('stripe_review_stripe_unconfigured', 409));
  await assert.rejects(reconcile(manager, stripeShows(0, { amount_total: 40000 })), code('stripe_review_stripe_mismatch', 409));
  await assert.rejects(reconcile(manager, stripeReviewClient({ STRIPE_SECRET_KEY: 'sk_test_synthetic_reviews' }, async () => { throw new TypeError('offline'); })), code('stripe_review_stripe_unavailable', 503));
  assert.deepEqual([store.commits.length, store.audits().length, store.get('payment_reviews/cs_test_held').status], [0, 0, 'open']);
  assert.equal(store.get('jobs/job-1').paymentReviewResolvedAt, undefined);
});

test('over HTTP: an owner reconcile of a partly refunded charge is 409 with the amounts, and a manager reconcile of a charge Stripe shows refunded is 403', async () => {
  const db = firestore({ 'jobs/job-1': seed()['jobs/job-1'], 'payment_reviews/cs_test_held': held('cs_test_held') }), env = { FIREBASE_API_KEY: 'firebase-test-review-resolve' }, asked = [];
  let actor = owner;
  const handlers = stripeReviewHandlers({ session: async () => actor, storage: store => stripeReviewStorage(store, db.fetcher), now: () => new Date(NOW), stripe: () => async path => { asked.push(path); return stripeShows(20000)(path); } });
  const post = body => handlers.post({ env, request: new Request(`${origin}/api/stripe-reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const review = (await (await handlers.get({ env, request: new Request(`${origin}/api/stripe-reviews`) })).json()).paymentReviews[0];
  const body = { action: 'payment.reconcile', requestId: randomUUID(), reviewId: review.sessionId, expectedRevision: review.revision, note: 'Refunded the excess' };
  const refused = await post(body), refusedBody = await refused.json();
  assert.deepEqual([refused.status, refusedBody.code, refusedBody.details], [409, 'stripe_review_refund_shown', { amountCents: 50000, refundedCents: 20000, keptCents: 30000, recordedOnJob: false }]);
  assert.match(refusedBody.error, /Use Record refund, which confirms the \$300\.00 kept/);
  actor = manager;
  const forbidden = await post({ ...body, requestId: randomUUID() }), forbiddenBody = await forbidden.json();
  assert.deepEqual([forbidden.status, forbiddenBody.code], [403, 'stripe_review_owner_required']);
  assert.equal(asked.length, 2, 'both reconciles checked Stripe');
  assert.equal(db.commits.length, 0); assert.equal(db.docs.get('payment_reviews/cs_test_held').value.status, 'open');
  // The owner records it as a refund with the amount kept confirmed; the job gets only the marker.
  actor = owner;
  const ok = await post({ action: 'payment.refund', requestId: randomUUID(), reviewId: review.sessionId, expectedRevision: review.revision, reason: 'exceeds_balance', keptCentsAcknowledged: 30000 });
  assert.equal(ok.status, 200); assert.deepEqual([(await ok.json()).review.keptCents, db.commits.at(-1).at(-1)], [30000, 'jobs/job-1']);
  assert.deepEqual([db.docs.get('jobs/job-1').value.paymentReviewResolvedAt, db.docs.get('jobs/job-1').value.payment.amount], [NOW, 700]);
});

test('a job changed between the resolution read and its commit is a conflict with nothing saved', async () => {
  const store = memoryStore(), review = await reviewOf(store, 'payment_reviews/cs_test_held');
  // A crew return that read no review yet puts the charge on the job while the owner's Stripe check runs.
  const stripe = async () => { store.edit('jobs/job-1', { payment: { amount: 1200, verified: true, stripeSessions: [{ sessionId: 'cs_test_held', amount: 500 }] } }); return { id: review.id, client_reference_id: 'job-1', metadata: { job_id: 'job-1' }, amount_total: 50000, livemode: false, payment_intent: { id: 'pi_x', latest_charge: { amount_refunded: 50000, refunded: true } } }; };
  await assert.rejects(resolveStripeReview(store, owner, request(review, 'payment.refund', { reason: 'duplicate_charge' }), NOW, { stripe }), code('dispatch_revision_conflict', 409));
  assert.equal(store.get('payment_reviews/cs_test_held').status, 'open'); assert.equal(store.audits().length, 0); assert.equal(store.commits.length, 0);
  await assert.rejects(resolveStripeReview(store, owner, request(review, 'payment.refund', { reason: 'duplicate_charge' }), NOW, { stripe: async () => ({ id: review.id, client_reference_id: 'job-1', metadata: { job_id: 'job-1' }, amount_total: 50000, livemode: false, payment_intent: { id: 'pi_x', latest_charge: { amount_refunded: 50000, refunded: true } } }) }), code('stripe_review_refund_on_job', 409), 'the re-run sees the charge on the job');
});

test('a refund on a charge the job already counts as paid needs the owner to acknowledge the job correction, and records that it was on the job', async () => {
  const store = memoryStore(), calls = [];
  store.edit('jobs/job-1', { payment: { amount: 1200, verified: true, stripeSessions: [{ sessionId: 'cs_test_applied', amount: 500 }] } });
  const review = await reviewOf(store, 'payment_reviews/cs_test_applied');
  const stripe = async path => { calls.push(path); return { id: 'cs_test_applied', client_reference_id: 'job-1', metadata: { job_id: 'job-1' }, amount_total: 50000, livemode: false, payment_intent: { id: 'pi_x', latest_charge: { amount_refunded: 50000, refunded: true } } }; };
  const refund = extra => request(review, 'payment.refund', { reason: 'duplicate_charge', ...extra });
  await assert.rejects(resolveStripeReview(store, owner, refund(), NOW, { stripe }), error => error.code === 'stripe_review_refund_on_job' && error.status === 409 && error.details.recordedOnJob === true && /already counted as paid on the job/.test(error.message));
  await assert.rejects(resolveStripeReview(store, owner, refund({ jobPaymentAcknowledged: false }), NOW, { stripe }), code('stripe_review_refund_on_job', 409));
  await assert.rejects(resolveStripeReview(store, owner, refund({ jobPaymentAcknowledged: 'yes' }), NOW, { stripe }), code('stripe_review_invalid_field', 400));
  await assert.rejects(resolveStripeReview(store, owner, request(review, 'payment.reconcile', { jobPaymentAcknowledged: true }), NOW), code('stripe_review_request_invalid', 400), 'only a refund takes the acknowledgement');
  assert.deepEqual([calls.length, store.commits.length], [0, 0], 'nothing is checked in Stripe or saved before the acknowledgement');
  const result = await resolveStripeReview(store, owner, refund({ jobPaymentAcknowledged: true, note: 'Customer paid twice' }), NOW, { stripe });
  assert.deepEqual([result.review.resolution, result.review.refundFull, result.review.recordedOnJobAtResolution], ['refunded', true, true]);
  assert.equal(store.get('payment_reviews/cs_test_applied').recordedOnJobAtResolution, true);
  const [audit] = store.audits();
  assert.equal(audit.reason, 'Duplicate charge: Customer paid twice (the job still counts this charge as paid)');
  assert.equal(JSON.parse(audit.after).recordedOnJobAtResolution, true);
  assert.deepEqual(store.get('jobs/job-1').payment, { amount: 1200, verified: true, stripeSessions: [{ sessionId: 'cs_test_applied', amount: 500 }] }, 'the Hub never changes the job money from here');
});

test('Stripe lookups for refunds are read-only, authenticated with the secret key, and never leak provider errors', async () => {
  const seen = [];
  assert.equal(stripeReviewClient({}), null);
  assert.equal(stripeReviewClient({ STRIPE_SECRET_KEY: 'pk_live_synthetic' }), null, 'a publishable key is never used');
  const client = stripeReviewClient({ STRIPE_SECRET_KEY: 'sk_test_synthetic_reviews' }, async (url, init) => { seen.push({ url, init }); return Response.json({ id: 'cs_test_x' }); });
  assert.deepEqual(await client('checkout/sessions/cs_test_x'), { id: 'cs_test_x' });
  assert.equal(seen[0].url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_x');
  assert.equal(seen[0].init.method, undefined, 'GET only');
  assert.equal(seen[0].init.headers.Authorization, `Basic ${btoa('sk_test_synthetic_reviews:')}`);
  assert.equal(seen[0].init.headers['Stripe-Version'], '2024-06-20', 'pinned like every customer-payment call');
  assert.ok(seen[0].init.signal instanceof AbortSignal, 'a lookup has a deadline');
  assert.deepEqual([client.livemode, stripeReviewClient({ STRIPE_SECRET_KEY: 'rk_live_synthetic_reviews' }).livemode], [false, true], 'the client says which mode its key reads');
  const failing = status => stripeReviewClient({ STRIPE_SECRET_KEY: 'sk_test_synthetic_reviews' }, async () => Response.json({ error: { message: 'raw provider text synthetic-secret' } }, { status }));
  await assert.rejects(failing(404)('x'), error => error.code === 'stripe_review_stripe_not_found' && !/synthetic-secret/.test(error.message));
  await assert.rejects(failing(500)('x'), error => error.code === 'stripe_review_stripe_unavailable' && !/synthetic-secret/.test(error.message));
  await assert.rejects(stripeReviewClient({ STRIPE_SECRET_KEY: 'sk_test_synthetic_reviews' }, async () => { throw new TypeError('offline'); })('x'), code('stripe_review_stripe_unavailable', 503));
});

// Stripe answers 404 for every checkout: the configured key cannot see these charges.
const stripeMissing = (key, calls = []) => stripeReviewClient({ STRIPE_SECRET_KEY: key }, async url => { calls.push(url); return Response.json({ error: { message: 'No such checkout.session: synthetic' } }, { status: 404 }); });

test('a test-mode charge Stripe has no record of for the configured account (a live key, or no key) is closed by the owner only, audited owner-only; a live-mode charge never is', async () => {
  const store = memoryStore(), calls = [];
  const review = await reviewOf(store, 'payment_reviews/cs_test_held');
  const reconcile = (actor, stripe, extra = {}, held = review) => resolveStripeReview(store, actor, request(held, 'payment.reconcile', { note: 'Test-mode charge from before going live', ...extra }), NOW, { stripe });
  // A test-mode review, and the Hub now runs on a live key, which Stripe answers with 404. Managers stay refused.
  await assert.rejects(reconcile(manager, stripeMissing('sk_live_synthetic_reviews', calls)), error => error.code === 'stripe_review_stripe_not_found' && error.status === 409 && /Only the owner can close it without a Stripe check/.test(error.message));
  await assert.rejects(reconcile(manager, null), error => error.code === 'stripe_review_stripe_unconfigured' && error.status === 409 && /Only the owner can close it without a Stripe check/.test(error.message));
  // A 404 from a key in the charge's own mode, or from a lookup that cannot say which mode it reads, stays refused for everyone.
  await assert.rejects(reconcile(owner, stripeMissing('sk_test_synthetic_reviews')), error => error.code === 'stripe_review_stripe_not_found' && !/Only the owner/.test(error.message));
  await assert.rejects(reconcile(owner, async () => { throw Object.assign(new Error('Synthetic 404'), { code: 'stripe_review_stripe_not_found', status: 409 }); }), code('stripe_review_stripe_not_found', 409));
  // A refund is still recorded only once Stripe shows it, and the note is still required for a charge not on the job.
  for (const stripe of [stripeMissing('sk_live_synthetic_reviews'), null]) await assert.rejects(resolveStripeReview(store, owner, request(review, 'payment.refund', { reason: 'other', note: 'Test charge' }), NOW, { stripe }), error => /^stripe_review_stripe_(not_found|unconfigured)$/.test(error.code) && error.status === 409);
  await assert.rejects(reconcile(owner, stripeMissing('sk_live_synthetic_reviews'), { note: '' }), code('stripe_review_invalid_field', 400));
  assert.deepEqual([store.commits.length, store.audits().length, store.get('payment_reviews/cs_test_held').status], [0, 0, 'open']);
  const asked = calls.length, closed = await reconcile(owner, stripeMissing('sk_live_synthetic_reviews', calls));
  assert.deepEqual(calls.slice(asked), ['https://api.stripe.com/v1/checkout/sessions/cs_test_held?expand[]=payment_intent.latest_charge'], 'Stripe was asked first');
  assert.deepEqual([closed.review.resolution, closed.review.stripeCheck, closed.review.note, closed.review.recordedOnJobAtResolution], ['reconciled', 'other_mode', 'Test-mode charge from before going live', false]);
  const [audit] = store.audits();
  assert.deepEqual([audit.action, audit.visibility, audit.reason, audit.entityKey, JSON.parse(audit.after).stripeCheck], ['stripe_review.payment.reconcile', 'owner', 'Stripe has no record for the configured account: Test-mode charge from before going live', 'payment_reviews/cs_test_held', 'other_mode']);
  assert.deepEqual([store.get('payment_reviews/cs_test_held').stripeCheck, store.get('jobs/job-1').paymentReviewResolvedAt], ['other_mode', NOW]);
  // A live-mode review flagged partly refunded, read with a test key or with no key: managers are refused before Stripe is asked,
  // and the owner is refused too. Only Stripe can say whether it was refunded and how much was kept, so it stays open until the live key is set.
  store.edit('payment_reviews/cs_test_applied', { livemode: true, reason: 'payment_refunded', refundedCents: 20000 });
  const live = await reviewOf(store, 'payment_reviews/cs_test_applied'), before = store.commits.length;
  await assert.rejects(reconcile(manager, stripeMissing('rk_test_synthetic_reviews'), {}, live), code('stripe_review_owner_required', 403));
  await assert.rejects(reconcile(owner, stripeMissing('rk_test_synthetic_reviews'), {}, live), error => error.code === 'stripe_review_stripe_not_found' && error.status === 409 && /live-mode charge, and the Hub's Stripe key is a test key/.test(error.message) && !/Only the owner/.test(error.message));
  await assert.rejects(reconcile(owner, null, {}, live), error => error.code === 'stripe_review_stripe_unconfigured' && error.status === 409 && /live-mode charge and Stripe is not configured/.test(error.message));
  for (const stripe of [stripeMissing('rk_test_synthetic_reviews'), null]) await assert.rejects(resolveStripeReview(store, owner, request(live, 'payment.refund', { reason: 'exceeds_balance', keptCentsAcknowledged: 30000 }), NOW, { stripe }), error => /^stripe_review_stripe_(not_found|unconfigured)$/.test(error.code) && error.status === 409 && /live-mode charge/.test(error.message));
  // A live-mode charge held for another reason (a cs_live_ checkout, or a review marked livemode) is refused to managers and the owner alike.
  store.put('payment_reviews/cs_live_held', held('cs_live_held', { livemode: false }));
  store.put('payment_reviews/cs_test_marked_live', held('cs_test_marked_live', { livemode: true }));
  for (const path of ['payment_reviews/cs_live_held', 'payment_reviews/cs_test_marked_live']) for (const actor of [manager, owner]) for (const stripe of [stripeMissing('sk_test_synthetic_reviews'), null]) {
    await assert.rejects(reconcile(actor, stripe, {}, await reviewOf(store, path)), error => /^stripe_review_stripe_(not_found|unconfigured)$/.test(error.code) && error.status === 409 && /live-mode charge/.test(error.message), `${path} ${actor.user} ${stripe ? 'test key' : 'no key'}`);
  }
  assert.equal(store.commits.length, before, 'nothing is saved for a live-mode charge the Hub cannot check');
  assert.deepEqual(['cs_test_applied', 'cs_live_held', 'cs_test_marked_live'].map(id => [store.get(`payment_reviews/${id}`).status, store.get(`payment_reviews/${id}`).stripeCheck]), [['open', undefined], ['open', undefined], ['open', undefined]]);
  // A 404 from the live key for a live-mode charge stays refused for everyone, with Stripe's own wording.
  await assert.rejects(reconcile(owner, stripeMissing('sk_live_synthetic_reviews'), {}, live), error => error.code === 'stripe_review_stripe_not_found' && /Check test or live mode/.test(error.message));
  // Without any Stripe key, the owner can close a review; the audit says Stripe could not be checked.
  store.put('payment_reviews/cs_test_nokey', held('cs_test_nokey'));
  const noKey = await reconcile(owner, null, { note: 'Recorded by check instead' }, await reviewOf(store, 'payment_reviews/cs_test_nokey'));
  assert.deepEqual([noKey.review.resolution, noKey.review.stripeCheck], ['reconciled', 'unconfigured']);
  const noKeyAudit = store.audits().find(entry => entry.entityKey === 'payment_reviews/cs_test_nokey');
  assert.deepEqual([noKeyAudit.visibility, noKeyAudit.reason], ['owner', 'Stripe has no record for the configured account: Recorded by check instead']);
});

test('over HTTP: the owner closes a review the configured Stripe key cannot find, a manager is refused, and nothing is saved for the manager', async () => {
  const db = firestore({ 'jobs/job-1': seed()['jobs/job-1'], 'payment_reviews/cs_test_held': held('cs_test_held'), 'payment_reviews/cs_test_nokey': held('cs_test_nokey') });
  let actor = manager, env = { FIREBASE_API_KEY: 'firebase-test-review-resolve', STRIPE_SECRET_KEY: 'sk_live_synthetic_reviews' };
  const handlers = stripeReviewHandlers({ session: async () => actor, storage: store => stripeReviewStorage(store, db.fetcher), now: () => new Date(NOW), stripe: environment => stripeReviewClient(environment, async () => Response.json({ error: { message: 'No such checkout.session' } }, { status: 404 })) });
  const post = body => handlers.post({ env, request: new Request(`${origin}/api/stripe-reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const rows = (await (await handlers.get({ env, request: new Request(`${origin}/api/stripe-reviews`) })).json()).paymentReviews;
  const row = rows.find(item => item.reviewId === 'cs_test_held'), body = { action: 'payment.reconcile', requestId: randomUUID(), reviewId: row.reviewId, expectedRevision: row.revision, note: 'Test-mode charge' };
  const refused = await post(body), refusedBody = await refused.json();
  assert.deepEqual([refused.status, refusedBody.code, db.commits.length], [409, 'stripe_review_stripe_not_found', 0]);
  actor = owner;
  const ok = await post({ ...body, requestId: randomUUID() }), okBody = await ok.json();
  assert.deepEqual([ok.status, okBody.review.resolution, okBody.review.stripeCheck], [200, 'reconciled', 'other_mode']);
  // The same with no Stripe key at all (the handler's own lookup is then null).
  env = { FIREBASE_API_KEY: 'firebase-test-review-resolve' };
  const unconfigured = stripeReviewHandlers({ session: async () => actor, storage: store => stripeReviewStorage(store, db.fetcher), now: () => new Date(NOW) });
  const nokey = rows.find(item => item.reviewId === 'cs_test_nokey');
  const saved = await unconfigured.post({ env, request: new Request(`${origin}/api/stripe-reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'payment.reconcile', requestId: randomUUID(), reviewId: nokey.reviewId, expectedRevision: nokey.revision, note: 'No Stripe key yet' }) }) });
  assert.deepEqual([saved.status, (await saved.json()).review.stripeCheck], [200, 'unconfigured']);
  assert.deepEqual([db.docs.get('payment_reviews/cs_test_held').value.status, db.docs.get('payment_reviews/cs_test_nokey').value.status], ['resolved', 'resolved']);
});

test('a refund follow-up review ({sessionId}:refund) is resolved by its own ID against the charge it names', async () => {
  const store = memoryStore(), calls = [];
  store.edit('jobs/job-1', { payment: { amount: 1200, verified: true, stripeSessions: [{ sessionId: 'cs_test_applied', amount: 500 }] } });
  store.edit('payment_reviews/cs_test_applied', { status: 'resolved', resolution: 'reconciled' });
  store.put('payment_reviews/cs_test_applied:refund', held('cs_test_applied', { reason: 'payment_refunded', refundedCents: 50000, refundSeenAt: NOW, followUpOf: 'cs_test_applied', priorResolution: 'reconciled', heldReason: 'payment_exceeds_balance' }));
  const [row] = (await stripeReviewOverview(store, owner, new Date(NOW))).paymentReviews.filter(item => item.sessionId === 'cs_test_applied');
  assert.deepEqual([row.reviewId, row.reason, row.refundedCents, row.recordedOnJob], ['cs_test_applied:refund', 'payment_refunded', 50000, true]);
  const followUp = await reviewOf(store, 'payment_reviews/cs_test_applied:refund');
  for (const reviewId of ['cs_test_applied:other', 'cs_test_applied:refund:refund', ':refund', 'cs_test_applied:refund:1', 'cs_test_applied:refund:0', 'cs_test_applied:refund:02', 'cs_test_applied:refund:100']) await assert.rejects(resolveStripeReview(store, owner, { ...request(followUp, 'payment.refund', { reason: 'customer_request' }), reviewId }, NOW), code('stripe_review_request_invalid', 400), reviewId);
  const stripe = async path => { calls.push(path); return stripeShows(50000, { id: 'cs_test_applied' })(path); };
  await assert.rejects(resolveStripeReview(store, owner, request(followUp, 'payment.refund', { reason: 'customer_request' }), NOW, { stripe }), code('stripe_review_refund_on_job', 409));
  const result = await resolveStripeReview(store, owner, request(followUp, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true }), NOW, { stripe });
  assert.deepEqual(calls, ['checkout/sessions/cs_test_applied?expand[]=payment_intent.latest_charge'], 'Stripe is asked about the charge, not the follow-up ID');
  assert.deepEqual([result.review.id, result.review.resolution, result.review.refundFull, result.review.recordedOnJobAtResolution], ['cs_test_applied:refund', 'refunded', true, true]);
  assert.deepEqual([store.audits()[0].entityKey, store.get('payment_reviews/cs_test_applied').status], ['payment_reviews/cs_test_applied:refund', 'resolved']);
  // A follow-up that names another charge is refused before anything is saved.
  store.put('payment_reviews/cs_test_held:refund', held('cs_test_other', { reason: 'payment_refunded', refundedCents: 50000 }));
  const mismatched = await reviewOf(store, 'payment_reviews/cs_test_held:refund'), commits = store.commits.length;
  await assert.rejects(resolveStripeReview(store, owner, request(mismatched, 'payment.reconcile', { note: 'x' }), NOW, { stripe }), code('stripe_review_stripe_mismatch', 409));
  assert.equal(store.commits.length, commits);
});

test('a later follow-up ({sessionId}:refund:2) is resolved by its own ID against the charge it names, and the queue shows the refund recorded before', async () => {
  const store = memoryStore(), calls = [];
  store.edit('jobs/job-1', { payment: { amount: 1200, verified: true, stripeSessions: [{ sessionId: 'cs_test_applied', amount: 500 }] } });
  store.edit('payment_reviews/cs_test_applied', { status: 'resolved', resolution: 'refunded', reason: 'payment_refunded', refundedCents: 10000, refundFull: false });
  store.put('payment_reviews/cs_test_applied:refund', held('cs_test_applied', { status: 'resolved', resolution: 'refunded', reason: 'payment_refunded', refundedCents: 30000, refundFull: false, followUpOf: 'cs_test_applied', priorRefundedCents: 10000 }));
  store.put('payment_reviews/cs_test_applied:refund:2', held('cs_test_applied', { reason: 'payment_refunded', refundedCents: 50000, refundSeenAt: NOW, followUpOf: 'cs_test_applied', priorResolution: 'refunded', priorRefundedCents: 30000 }));
  const rows = (await stripeReviewOverview(store, owner, new Date(NOW))).paymentReviews.filter(item => item.sessionId === 'cs_test_applied');
  assert.deepEqual(rows.map(row => [row.reviewId, row.refundedCents, row.keptCents, row.priorRefundedCents, row.recordedOnJob]), [['cs_test_applied:refund:2', 50000, 0, 30000, true]]);
  const [plainRow] = (await stripeReviewOverview(store, owner, new Date(NOW))).paymentReviews.filter(item => item.sessionId === 'cs_test_held');
  assert.equal(Object.hasOwn(plainRow, 'priorRefundedCents'), false, 'only a follow-up after a recorded refund names one');
  const review = await reviewOf(store, 'payment_reviews/cs_test_applied:refund:2');
  const stripe = async path => { calls.push(path); return stripeShows(50000, { id: 'cs_test_applied' })(path); };
  const result = await resolveStripeReview(store, owner, request(review, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true }), NOW, { stripe });
  assert.deepEqual(calls, ['checkout/sessions/cs_test_applied?expand[]=payment_intent.latest_charge'], 'Stripe is asked about the charge, not the follow-up ID');
  assert.deepEqual([result.review.id, result.review.resolution, result.review.refundedCents, result.review.refundFull], ['cs_test_applied:refund:2', 'refunded', 50000, true]);
  // A numbered follow-up that names another charge is refused before anything is saved.
  store.put('payment_reviews/cs_test_held:refund:2', held('cs_test_other', { reason: 'payment_refunded', refundedCents: 50000 }));
  const commits = store.commits.length;
  await assert.rejects(resolveStripeReview(store, owner, request(await reviewOf(store, 'payment_reviews/cs_test_held:refund:2'), 'payment.reconcile', { note: 'x' }), NOW, { stripe }), code('stripe_review_stripe_mismatch', 409));
  assert.equal(store.commits.length, commits);
});

test('linking a flagged member to a chosen candidate writes the link, the account mirror and fences in one commit, and later events keep it', async () => {
  const store = await flagged(), review = await reviewOf(store, 'membership_reviews/sub_member_1');
  assert.deepEqual(review.candidateCustomerIds, ['cust-dana', 'cust-twin']);
  const view = await stripeReviewOverview(store, owner, new Date(NOW));
  assert.deepEqual(view.membershipReviews[0].candidates.map(row => [row.id, row.name, row.address]), [['cust-dana', 'Synthetic Dana', '1 Synthetic Way'], ['cust-twin', 'Synthetic Twin', '9 Other Way']]);
  await assert.rejects(resolveStripeReview(store, manager, request(review, 'membership.link', { customerId: 'cust-other' }), NOW), code('stripe_review_customer_not_candidate', 400));
  await assert.rejects(resolveStripeReview(store, manager, request(review, 'membership.link', { customerId: 'secure_vault' }), NOW), code('stripe_review_invalid_field', 400));
  const commitsBefore = store.commits.length, input = request(review, 'membership.link', { customerId: 'cust-dana' });
  const result = await resolveStripeReview(store, manager, input, LATER);
  assert.deepEqual([result.review.resolution, result.review.linkedCustomerId, result.review.linkedJobId], ['linked', 'cust-dana', 'job-root']);
  const commit = store.commits[commitsBefore];
  assert.equal(store.commits.length, commitsBefore + 1, 'one commit');
  for (const path of ['membership_reviews/sub_member_1', 'memberships/sub_member_1', 'jobs/job-root', `${STRIPE_REVIEW_OPERATIONS}/${input.requestId}`]) assert.ok(commit.writes.includes(path), path);
  assert.ok(commit.verified.includes('customers/cust-dana'), 'the chosen customer is fenced at the revision that was read');
  assert.ok(commit.verified.includes('jobs/job-child'), 'the account lineage the link relies on is fenced');
  const membership = store.get('memberships/sub_member_1');
  assert.deepEqual({ ...membership.link }, { status: 'linked', customerId: 'cust-dana', accountJobId: 'job-root', method: 'manager', linkedAt: LATER, linkedBy: 'tylerg', mirroredAt: LATER });
  const guard = store.get('jobs/job-root').garageGuard;
  assert.deepEqual([guard.plan, guard.status, guard.visitsRemaining, guard.membershipId, guard.nextVisit, guard.updatedBy], ['guard', 'active', 4, 'sub_member_1', '2026-10-05', 'tylerg'], 'the account job gets the display copy and keeps its own fields');
  assert.equal(store.get('jobs/job-child').garageGuard, undefined);
  // The next renewal follows the manager's link and never reopens the review.
  const next = await applyGarageGuardEvent(store, garageGuardEvent(renewal()), { now: LATER });
  assert.deepEqual([next.link, next.mirrored], ['linked', true]);
  assert.equal(store.get('membership_reviews/sub_member_1').status, 'resolved');
});

test('a link the account cannot take is refused with its reason, and a changed membership is a conflict', async () => {
  const store = await flagged();
  store.edit('jobs/job-root', { garageGuard: { membershipId: 'sub_other_member', plan: 'lite' } });
  const review = await reviewOf(store, 'membership_reviews/sub_member_1'), before = store.commits.length;
  await assert.rejects(resolveStripeReview(store, owner, request(review, 'membership.link', { customerId: 'cust-dana' }), NOW), error => error.code === 'stripe_review_link_blocked' && error.details.reason === 'account_has_other_membership');
  assert.equal(store.commits.length, before);
  const other = await flagged(), stale = await reviewOf(other, 'membership_reviews/sub_member_1');
  other.edit('memberships/sub_member_1', { link: { status: 'linked', customerId: 'cust-dana', accountJobId: 'job-root' } });
  await assert.rejects(resolveStripeReview(other, owner, request(stale, 'membership.link', { customerId: 'cust-dana' }), NOW), code('stripe_review_membership_changed', 409));
  await assert.rejects(resolveStripeReview(other, owner, request(stale, 'membership.dismiss', { reason: 'not_a_customer' }), NOW), code('stripe_review_membership_changed', 409));
});

test('dismissing a member keeps it unlinked for good: later events never reopen the review or guess a customer', async () => {
  const store = await flagged(), review = await reviewOf(store, 'membership_reviews/sub_member_1');
  await assert.rejects(resolveStripeReview(store, manager, request(review, 'membership.dismiss', { reason: 'other' }), NOW), code('stripe_review_invalid_field', 400), '"Other" needs a note');
  await assert.rejects(resolveStripeReview(store, manager, request(review, 'membership.dismiss', { reason: 'unknown' }), NOW), code('stripe_review_invalid_field', 400));
  const result = await resolveStripeReview(store, manager, request(review, 'membership.dismiss', { reason: 'not_a_customer', note: 'New member; no Hub visit booked yet' }), NOW);
  assert.deepEqual([result.review.resolution, result.review.dismissReason, result.review.note], ['dismissed', 'not_a_customer', 'New member; no Hub visit booked yet']);
  assert.deepEqual(store.get('memberships/sub_member_1').link, { status: 'dismissed', reason: 'not_a_customer', dismissedAt: NOW, dismissedBy: 'tylerg', reviewReason: 'ambiguous_customer' });
  store.edit('customers/cust-twin', { phone: '970-555-0199' });
  const next = await applyGarageGuardEvent(store, garageGuardEvent(renewal()), { now: LATER });
  assert.deepEqual([next.status, next.link, next.mirrored], ['applied', 'dismissed', false], 'an exact match appearing later does not override the manager');
  assert.equal(store.get('membership_reviews/sub_member_1').status, 'resolved');
  assert.equal(store.get('jobs/job-root').garageGuard.membershipId, undefined);
  const [audit] = store.audits().filter(row => row.action === 'stripe_review.membership.dismiss');
  assert.deepEqual([audit.visibility, audit.reason], ['business', 'Not a Hub customer yet: New member; no Hub visit booked yet']);
});

// Firestore REST fake: get, list, batchGet and commit with updateTime preconditions
// (a stale one is 400 FAILED_PRECONDITION, as Firestore answers; payment resolutions
// write their job marker under one), plus the read-write transaction verify-only fences
// use (membership links): a commit whose transaction reads changed is 409 ABORTED.
function firestore(initial) {
  const docs = new Map(Object.entries(initial).map(([path, value], index) => [path, { value, version: index + 1 }])), commits = [], transactions = new Map();
  const ROOT = 'projects/egcw-1ec83/databases/(default)/documents', time = version => `2026-09-22T00:00:00.${String(version).padStart(6, '0')}Z`;
  const document = path => ({ name: `${ROOT}/${path}`, fields: encodeFirestoreFields(docs.get(path).value), updateTime: time(docs.get(path).version) });
  let race = null, clock = 1000, sequence = 0;
  const fetcher = async (_env, input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'firestore.googleapis.com');
    if (url.pathname.endsWith(':beginTransaction')) { const id = `synthetic-transaction-${++sequence}`; transactions.set(id, new Map()); return Response.json({ transaction: id }); }
    if (url.pathname.endsWith(':rollback')) { transactions.delete(JSON.parse(init.body).transaction); return Response.json({}); }
    if (url.pathname.endsWith(':commit')) {
      race?.(); race = null;
      const { writes, transaction } = JSON.parse(init.body);
      if (transaction) {
        const reads = transactions.get(transaction); transactions.delete(transaction);
        if (!reads || [...reads].some(([path, version]) => docs.get(path)?.version !== version)) return Response.json({ error: { code: 409, status: 'ABORTED' } }, { status: 409 });
      }
      for (const write of writes) {
        const path = write.update.name.split('/documents/')[1], row = docs.get(path), expected = write.currentDocument;
        if (expected.updateTime ? !row || time(row.version) !== expected.updateTime : row) return Response.json({ error: { code: row ? 400 : 409, status: row ? 'FAILED_PRECONDITION' : 'ALREADY_EXISTS' } }, { status: row ? 400 : 409 });
      }
      commits.push(writes.map(write => write.update.name.split('/documents/')[1]));
      for (const write of writes) { const path = write.update.name.split('/documents/')[1]; docs.set(path, { value: { ...(docs.get(path)?.value || {}), ...decodeFirestoreFields(write.update.fields) }, version: ++clock }); }
      return Response.json({ writeResults: [] });
    }
    if (url.pathname.endsWith(':batchGet')) { const body = JSON.parse(init.body), reads = transactions.get(body.transaction); return Response.json(body.documents.map(name => { const path = name.split('/documents/')[1]; if (docs.has(path)) reads?.set(path, docs.get(path).version); return docs.has(path) ? { found: document(path) } : { missing: name }; })); }
    const path = decodeURIComponent(url.pathname.split('/documents/')[1] || '');
    if (!path.includes('/')) { const keys = [...docs.keys()].filter(key => key.startsWith(`${path}/`)); return Response.json(keys.length ? { documents: keys.map(document) } : {}); }
    return docs.has(path) ? Response.json(document(path)) : Response.json({}, { status: 404 });
  };
  return { docs, commits, fetcher, bump: path => { docs.get(path).version += 100; }, raceNextCommit: fn => { race = fn; } };
}

test('over HTTP: same-origin JSON only, dispatcher only, and a stale Firestore revision is a conflict, not an unknown outcome', async () => {
  const db = firestore({ 'jobs/job-1': seed()['jobs/job-1'], 'payment_reviews/cs_test_held': held('cs_test_held') });
  let actor = manager;
  // A reconcile checks the held charge in Stripe too (read-only); this one shows no refund.
  const handlers = stripeReviewHandlers({ session: async () => actor, storage: env => stripeReviewStorage(env, db.fetcher), now: () => new Date(NOW), stripe: () => stripeShows() });
  const post = (body, headers = {}) => handlers.post({ env: { FIREBASE_API_KEY: 'firebase-test-review-resolve' }, request: new Request(`${origin}/api/stripe-reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const view = await (await handlers.get({ env: { FIREBASE_API_KEY: 'firebase-test-review-resolve', PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED: 'true' }, request: new Request(`${origin}/api/stripe-reviews`) })).json();
  assert.equal(view.checkoutBlock, true, 'the queue says when checkouts on these jobs are blocked');
  const review = view.paymentReviews[0], body = { action: 'payment.reconcile', requestId: randomUUID(), reviewId: review.sessionId, expectedRevision: review.revision, note: 'Matched to a bank deposit' };
  assert.equal((await post(body, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{"action":', {})).status, 400);
  assert.equal((await post({ ...body, note: 'x'.repeat(9000) })).status, 413);
  actor = crew; assert.equal((await post(body)).status, 403);
  actor = null; assert.equal((await post(body)).status, 401);
  actor = manager;
  assert.equal(db.commits.length, 0);
  // Another writer changes the review between the read and the commit.
  db.raceNextCommit(() => db.bump('payment_reviews/cs_test_held'));
  const raced = await post(body), raceBody = await raced.json();
  assert.deepEqual([raced.status, raceBody.code], [409, 'stripe_review_revision_conflict']);
  const stale = await post({ ...body, requestId: randomUUID() }), staleBody = await stale.json();
  assert.deepEqual([stale.status, staleBody.code], [409, 'stripe_review_revision_conflict']);
  const fresh = (await (await handlers.get({ env: { FIREBASE_API_KEY: 'firebase-test-review-resolve' }, request: new Request(`${origin}/api/stripe-reviews`) })).json()).paymentReviews[0];
  // Without a Stripe key a refund cannot be confirmed: a 409 the Hub shows and discards, never a retryable 503.
  const unconfigured = stripeReviewHandlers({ session: async () => owner, storage: env => stripeReviewStorage(env, db.fetcher), now: () => new Date(NOW), stripe: () => null });
  const noKey = await unconfigured.post({ env: { FIREBASE_API_KEY: 'firebase-test-review-resolve' }, request: new Request(`${origin}/api/stripe-reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'payment.refund', requestId: randomUUID(), reviewId: fresh.sessionId, expectedRevision: fresh.revision, reason: 'duplicate_charge' }) }) });
  assert.deepEqual([noKey.status, (await noKey.json()).code, db.commits.length], [409, 'stripe_review_stripe_unconfigured', 0]);
  const requestId = randomUUID(), ok = await post({ ...body, requestId, expectedRevision: fresh.revision });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.equal((await ok.json()).review.resolution, 'reconciled');
  assert.deepEqual(db.commits.at(-1).slice(0, 2), ['payment_reviews/cs_test_held', `${STRIPE_REVIEW_OPERATIONS}/${requestId}`]);
  assert.equal(db.docs.get('payment_reviews/cs_test_held').value.resolveRequestId, requestId);
  const broken = stripeReviewHandlers({ session: async () => manager, storage: () => ({ read: async () => { throw new Error('raw provider text synthetic-secret'); } }), now: () => new Date(NOW) });
  const failed = await broken.post({ env: {}, request: new Request(`${origin}/api/stripe-reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, requestId: randomUUID() }) }) });
  const failedBody = await failed.json();
  assert.deepEqual([failed.status, failedBody.code], [503, 'stripe_review_unavailable']); assert.doesNotMatch(JSON.stringify(failedBody), /synthetic-secret/);
});

test('over HTTP: a partial refund answers 409 with its amounts until the owner confirms the amount kept, and a job changed meanwhile is a revision conflict', async () => {
  const db = firestore({ 'jobs/job-1': seed()['jobs/job-1'], 'payment_reviews/cs_test_held': held('cs_test_held') }), env = { FIREBASE_API_KEY: 'firebase-test-review-resolve' };
  const stripe = () => async () => ({ id: 'cs_test_held', client_reference_id: 'job-1', metadata: { job_id: 'job-1' }, amount_total: 50000, livemode: false, payment_intent: { id: 'pi_x', latest_charge: { amount_refunded: 20000, refunded: false } } });
  const handlers = stripeReviewHandlers({ session: async () => owner, storage: store => stripeReviewStorage(store, db.fetcher), now: () => new Date(NOW), stripe });
  const post = body => handlers.post({ env, request: new Request(`${origin}/api/stripe-reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const review = (await (await handlers.get({ env, request: new Request(`${origin}/api/stripe-reviews`) })).json()).paymentReviews[0];
  const body = { action: 'payment.refund', requestId: randomUUID(), reviewId: review.sessionId, expectedRevision: review.revision, reason: 'exceeds_balance' };
  const partial = await post(body), partialBody = await partial.json();
  assert.equal(partial.status, 409);
  assert.deepEqual([partialBody.code, partialBody.details], ['stripe_review_refund_partial', { amountCents: 50000, refundedCents: 20000, keptCents: 30000 }], 'the Hub gets the amounts to show and confirm');
  assert.match(partialBody.error, /Stripe shows \$200\.00 of \$500\.00 refunded\. The \$300\.00 kept is not on the job/);
  assert.equal(db.commits.length, 0);
  // The job changes after the fence read: the save is a revision conflict and nothing lands.
  db.raceNextCommit(() => db.bump('jobs/job-1'));
  const raced = await post({ ...body, requestId: randomUUID(), keptCentsAcknowledged: 30000 }), racedBody = await raced.json();
  assert.deepEqual([raced.status, racedBody.code], [409, 'stripe_review_revision_conflict']);
  assert.match(racedBody.error, /review or its job changed/);
  assert.equal(db.commits.length, 0); assert.equal(db.docs.get('payment_reviews/cs_test_held').value.status, 'open');
  const ok = await post({ ...body, requestId: randomUUID(), keptCentsAcknowledged: 30000 }), okBody = await ok.json();
  assert.equal(ok.status, 200);
  assert.deepEqual([okBody.review.resolution, okBody.review.refundedCents, okBody.review.keptCents, okBody.review.refundFull], ['refunded', 20000, 30000, false]);
  assert.equal(db.docs.get('payment_reviews/cs_test_held').value.keptCents, 30000);
});

test('review receipts are server-only in the Firestore rules', async () => {
  const { readFileSync } = await import('node:fs');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/stripe_review_operations\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
  assert.ok(rules.indexOf('match /stripe_review_operations/') < rules.indexOf('match /{document=**}'), 'declared before the catch-all');
});
