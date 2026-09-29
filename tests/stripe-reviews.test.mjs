import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { REVIEW_LIST_LIMIT, keptSplit, reviewKeptSplit, stripeReviewOverview, stripeReviewStorage } from '../functions/_lib/stripe-reviews.js';
import { stripeReviewHandlers } from '../functions/api/stripe-reviews.js';
import { applyGarageGuardEvent, garageGuardEvent } from '../functions/_lib/garage-guard-membership.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const origin = 'https://easygaragecleaning.com';
const env = { FIREBASE_API_KEY: 'firebase-test-stripe-reviews' };
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';

// A Firestore REST fake for list and get; every page is checked the way dispatchStorage checks scans.
function firestore(seed, { pageSize = 300, broken = '' } = {}) {
  const docs = new Map(Object.entries(seed)), calls = [];
  const document = path => ({ name: `${ROOT}/${path}`, fields: encodeFirestoreFields(docs.get(path)), updateTime: `2026-09-22T00:00:00.${String([...docs.keys()].indexOf(path) + 1).padStart(6, '0')}Z` });
  const fetcher = async (_env, input, init = {}) => {
    const url = new URL(input), path = decodeURIComponent(url.pathname.split('/documents/')[1] || ''); calls.push(url.pathname + url.search);
    assert.equal(url.hostname, 'firestore.googleapis.com');
    if (url.pathname.endsWith(':batchGet')) return Response.json(JSON.parse(init.body).documents.map(name => { const key = name.split('/documents/')[1]; return docs.has(key) ? { found: document(key) } : { missing: name }; }));
    if (broken === path) return Response.json({ documents: 'not-a-list' });
    if (!path.includes('/')) {
      const keys = [...docs.keys()].filter(key => key.startsWith(`${path}/`)), start = Number(url.searchParams.get('pageToken') || 0), page = keys.slice(start, start + pageSize);
      return Response.json({ ...(page.length ? { documents: page.map(document) } : {}), ...(start + pageSize < keys.length ? { nextPageToken: String(start + pageSize) } : {}) });
    }
    return docs.has(path) ? Response.json(document(path)) : Response.json({}, { status: 404 });
  };
  return { docs, calls, fetcher, revision: path => document(path).updateTime };
}

const heldCharge = (sessionId, extra = {}) => ({ sessionId, jobId: 'job-1', kind: 'egc_job_payment', reason: 'payment_exceeds_balance', status: 'open', amountCents: 50000, currency: 'usd', paymentIntentId: `pi_${sessionId}`, livemode: false, jobRevision: 'r1', jobTotalCents: 100000, jobPaidCents: 70000, jobBalanceCents: 30000, createdBy: 'crew1', recordedBy: 'stripe_webhook', createdAt: '2026-09-21T12:00:00.000Z', ...extra });
const memberReview = (subscriptionId, extra = {}) => ({ subscriptionId, status: 'open', reason: 'ambiguous_customer', candidateCustomerIds: ['cust-a', 'cust-b'], plan: 'guard', customerEmail: 'member@example.invalid', phone: '+1 970 555 0101', customerName: 'Synthetic Member', serviceAddress: '1 Synthetic Way', eventId: 'evt_synthetic', createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z', ...extra });

test('managers get open payment and membership reviews, newest first, with counts', async () => {
  const db = firestore({
    'jobs/job-1': { type: 'job', customer: 'Synthetic Customer', payment: { verified: true, amount: 700, stripeSessions: [{ sessionId: 'cs_test_applied' }] }, internalNotes: 'synthetic-secret-note' },
    'payment_reviews/cs_test_old': heldCharge('cs_test_old', { createdAt: '2026-09-20T12:00:00.000Z' }),
    'payment_reviews/cs_test_applied': heldCharge('cs_test_applied'),
    'payment_reviews/cs_test_resolved': heldCharge('cs_test_resolved', { status: 'resolved' }),
    'payment_reviews/cs_test_orphan': heldCharge('cs_test_orphan', { jobId: 'secure_vault', createdAt: '2026-09-19T12:00:00.000Z' }),
    'membership_reviews/sub_open': memberReview('sub_open', { internal: 'synthetic-secret' }),
    'customers/cust-a': { name: 'Synthetic Candidate', phone: '970-555-0101', email: 'candidate@example.invalid', address: '1 Synthetic Way', notes: 'synthetic-secret-note' },
    'membership_reviews/sub_closed': memberReview('sub_closed', { status: 'resolved' }),
  });
  const view = await stripeReviewOverview(stripeReviewStorage(env, db.fetcher), owner, NOW);
  assert.deepEqual(view.counts, { paymentReviews: 3, membershipReviews: 1 });
  assert.deepEqual(view.paymentReviews.map(row => [row.sessionId, row.recordedOnJob, row.jobFound]), [['cs_test_applied', true, true], ['cs_test_old', false, true], ['cs_test_orphan', false, false]]);
  assert.equal(view.paymentReviews[0].customer, 'Synthetic Customer');
  // Each review carries its Firestore revision (resolving one is revision-checked) and the candidate
  // customers' contact details, read in one batch; a missing candidate is shown as not found.
  assert.deepEqual(view.membershipReviews, [{ subscriptionId: 'sub_open', revision: db.revision('membership_reviews/sub_open'), reason: 'ambiguous_customer', status: 'open', plan: 'guard', candidateCustomerIds: ['cust-a', 'cust-b'],
    candidates: [{ id: 'cust-a', found: true, name: 'Synthetic Candidate', phone: '970-555-0101', email: 'candidate@example.invalid', address: '1 Synthetic Way' }, { id: 'cust-b', found: false, name: '', phone: '', email: '', address: '' }],
    customerName: 'Synthetic Member', customerEmail: 'member@example.invalid', phone: '+1 970 555 0101', serviceAddress: '1 Synthetic Way', eventId: 'evt_synthetic', createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z' }]);
  assert.deepEqual(view.paymentReviews.map(row => row.revision), ['cs_test_applied', 'cs_test_old', 'cs_test_orphan'].map(id => db.revision(`payment_reviews/${id}`)));
  assert.deepEqual({ viewer: view.viewer, checkoutBlock: view.checkoutBlock }, { viewer: { canRecordRefund: true }, checkoutBlock: false });
  assert.equal(db.calls.filter(call => call.endsWith(':batchGet')).length, 1, 'candidate customers are read in one batch');
  assert.deepEqual(view.coverage, { complete: true, asOf: NOW.toISOString() });
  assert.doesNotMatch(JSON.stringify(view), /synthetic-secret|jobRevision|internalNotes/, 'only allowlisted fields leave the server');
  assert.equal(db.calls.filter(call => call.includes('/documents/jobs/')).length, 1, 'each job is read once; private ids are never read');
});

test('a held charge shows its service part and crew tip apart; rows from before tips read as no tip', async () => {
  const db = firestore({
    'jobs/job-1': { type: 'job', customer: 'Synthetic Customer' },
    'payment_reviews/cs_test_tipped': heldCharge('cs_test_tipped', { amountCents: 180000, tipCents: 20000, createdAt: '2026-09-21T15:00:00.000Z' }),
    'payment_reviews/cs_test_legacy': heldCharge('cs_test_legacy', { createdAt: '2026-09-21T14:00:00.000Z' }),
    'payment_reviews/cs_test_bad_tip': heldCharge('cs_test_bad_tip', { tipCents: 'lots', createdAt: '2026-09-21T13:00:00.000Z' }),
    'payment_reviews/cs_test_big_tip': heldCharge('cs_test_big_tip', { tipCents: 50001, createdAt: '2026-09-21T12:00:00.000Z' }),
  });
  const view = await stripeReviewOverview(stripeReviewStorage(env, db.fetcher), owner, NOW);
  assert.deepEqual(view.paymentReviews.map(row => [row.sessionId, row.amountCents, row.tipCents, row.serviceCents]), [
    ['cs_test_tipped', 180000, 20000, 160000], ['cs_test_legacy', 50000, 0, 50000],
    ['cs_test_bad_tip', 50000, null, null], ['cs_test_big_tip', 50000, 50001, null],
  ], 'an unreadable split is unknown (null), never folded into the service amount');
});

// Stripe does not say which part of a tipped charge it refunded: the tip is counted as kept first, so the service part
// recorded on the job never holds tip money (at worst it is too small, and the owner adds the rest).
test('money kept from a partly refunded tipped charge is split with the tip counted as kept first', async () => {
  assert.deepEqual(keptSplit(35000, 5000), { keptServiceCents: 30000, keptTipCents: 5000 });
  assert.deepEqual(keptSplit(3000, 5000), { keptServiceCents: 0, keptTipCents: 3000 }, 'less kept than the tip: all of it may be tip');
  assert.deepEqual(keptSplit(35000, 0), {}, 'an untipped charge has nothing to split');
  for (const [kept, tip] of [[35000, null], [null, 5000], [1.5, 5000]]) assert.deepEqual(keptSplit(kept, tip), { keptServiceCents: null, keptTipCents: null }, `${kept}/${tip}`);
  const db = firestore({
    'jobs/job-1': { type: 'job', customer: 'Synthetic Customer' },
    'payment_reviews/cs_test_tipped': heldCharge('cs_test_tipped', { amountCents: 55000, tipCents: 5000, reason: 'payment_refunded', refundedCents: 20000, createdAt: '2026-09-21T15:00:00.000Z' }),
    'payment_reviews/cs_test_plain': heldCharge('cs_test_plain', { reason: 'payment_refunded', refundedCents: 20000, createdAt: '2026-09-21T14:00:00.000Z' }),
  });
  const view = await stripeReviewOverview(stripeReviewStorage(env, db.fetcher), owner, NOW);
  assert.deepEqual(view.paymentReviews.map(row => [row.sessionId, row.keptCents, row.keptServiceCents, row.keptTipCents]), [['cs_test_tipped', 35000, 30000, 5000], ['cs_test_plain', 30000, undefined, undefined]]);
  assert.equal('keptServiceCents' in view.paymentReviews[1], false, 'an untipped row keeps the shape it had before tips');
});

// The owner, who made the refund, may say the crew tip was refunded first (the customer asked to drop it): the kept money
// is then service first. A follow-up review reads only the refund beyond the earlier recorded one, out of what it kept.
test('a refund read as the crew tip first keeps the service part, and a follow-up splits only the refund beyond the earlier one', async () => {
  assert.deepEqual(keptSplit(50000, 5000, { tipRefundedFirst: true, refundedCents: 5000 }), { keptServiceCents: 50000, keptTipCents: 0 }, 'exactly the tip refunded');
  assert.deepEqual(keptSplit(53000, 5000, { tipRefundedFirst: true, refundedCents: 2000 }), { keptServiceCents: 50000, keptTipCents: 3000 }, 'part of the tip refunded');
  assert.deepEqual(keptSplit(35000, 5000, { tipRefundedFirst: true, refundedCents: 20000 }), { keptServiceCents: 35000, keptTipCents: 0 }, 'the tip, then $150 of service');
  assert.deepEqual(keptSplit(0, 5000, { tipRefundedFirst: true, refundedCents: 55000 }), { keptServiceCents: 0, keptTipCents: 0 });
  for (const refundedCents of [null, -1, 1.5]) assert.deepEqual(keptSplit(35000, 5000, { tipRefundedFirst: true, refundedCents }), { keptServiceCents: null, keptTipCents: null }, String(refundedCents));
  assert.deepEqual(keptSplit(35000, 0, { tipRefundedFirst: true, refundedCents: 20000 }), {}, 'untipped: nothing to split');
  // A $50 tip refunded first and recorded; Stripe then shows $250 refunded in all: the $200 more is read on its own.
  const followUp = { tipCents: 5000, amountCents: 55000, priorRefundedCents: 5000, priorKeptServiceCents: 50000, priorKeptTipCents: 0 };
  assert.deepEqual(reviewKeptSplit(followUp, 25000, 30000), { keptServiceCents: 30000, keptTipCents: 0 }, 'no tip is left to count as kept');
  assert.deepEqual(reviewKeptSplit(followUp, 25000, 30000, true), { keptServiceCents: 30000, keptTipCents: 0 });
  // $200 of service refunded and recorded (the tip kept); then $30 more: out of the service first, or the tip.
  const served = { tipCents: 5000, amountCents: 55000, priorRefundedCents: 20000, priorKeptServiceCents: 30000, priorKeptTipCents: 5000 };
  assert.deepEqual([reviewKeptSplit(served, 23000, 32000), reviewKeptSplit(served, 23000, 32000, true)], [{ keptServiceCents: 27000, keptTipCents: 5000 }, { keptServiceCents: 30000, keptTipCents: 2000 }]);
  // Without the earlier split (a follow-up from before it was kept) the whole refund is read at once.
  assert.deepEqual(reviewKeptSplit({ tipCents: 5000, priorRefundedCents: 20000 }, 23000, 32000), keptSplit(32000, 5000));
});

test('a ledger larger than the cap is reported incomplete, and unreadable pages fail closed', async () => {
  const seed = Object.fromEntries(Array.from({ length: REVIEW_LIST_LIMIT + 3 }, (_, index) => [`membership_reviews/sub_${String(index).padStart(4, '0')}`, memberReview(`sub_${index}`)]));
  const big = firestore(seed, { pageSize: 251 });
  const view = await stripeReviewOverview(stripeReviewStorage(env, big.fetcher), owner, NOW);
  assert.deepEqual({ complete: view.coverage.complete, shown: view.membershipReviews.length }, { complete: false, shown: 502 }, 'more reviews than the cap are flagged, never presented as the whole list');
  delete seed[`membership_reviews/sub_${String(REVIEW_LIST_LIMIT + 2).padStart(4, '0')}`];
  const exact = await stripeReviewOverview(stripeReviewStorage(env, firestore(seed, { pageSize: 251 }).fetcher), owner, NOW);
  assert.deepEqual({ complete: exact.coverage.complete, shown: exact.membershipReviews.length }, { complete: true, shown: 502 });
  const broken = firestore({ 'payment_reviews/cs_test_x': heldCharge('cs_test_x') }, { broken: 'payment_reviews' });
  await assert.rejects(stripeReviewOverview(stripeReviewStorage(env, broken.fetcher), owner, NOW), { code: 'stripe_review_storage_incomplete', status: 503 });
  const offline = stripeReviewStorage(env, async () => { throw new TypeError('offline'); });
  await assert.rejects(stripeReviewOverview(offline, owner, NOW), { code: 'stripe_review_storage_unavailable', status: 503 });
  const jobDown = firestore({ 'payment_reviews/cs_test_x': heldCharge('cs_test_x') }), store = stripeReviewStorage(env, jobDown.fetcher);
  await assert.rejects(stripeReviewOverview({ ...store, read: async () => { throw Object.assign(new Error('down'), { code: 'dispatch_storage_unavailable', status: 503 }); } }, owner, NOW), { code: 'dispatch_storage_unavailable' }, 'a job read failure is never shown as "not recorded"');
});

test('the endpoint requires a dispatcher, takes no parameters and never leaks storage errors', async () => {
  const db = firestore({ 'payment_reviews/cs_test_x': heldCharge('cs_test_x') });
  const handler = actor => stripeReviewHandlers({ session: async () => actor, storage: () => stripeReviewStorage(env, db.fetcher), now: () => NOW });
  const get = (actor, query = '') => handler(actor).get({ env, request: new Request(`${origin}/api/stripe-reviews${query}`) });
  assert.deepEqual([(await get(null)).status, (await get({ user: 'crew1', role: 'crew' })).status, (await get({ ...owner, role: 'crew' })).status, (await get({ ...owner, user: 'someone' })).status], [401, 403, 403, 403]);
  assert.equal(db.calls.length, 0, 'nothing is read before authorization');
  const manager = await get({ ...owner, user: 'tylerg', role: 'manager' });
  assert.equal(manager.status, 200); assert.equal(manager.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await manager.json()).counts.paymentReviews, 1);
  for (const query of ['?status=open', '?x=1&x=2']) assert.equal((await get(owner, query)).status, 400);
  const failing = stripeReviewHandlers({ session: async () => owner, storage: () => ({ list: async () => { throw new Error('raw provider text synthetic-secret'); } }), now: () => NOW });
  const response = await failing.get({ env, request: new Request(`${origin}/api/stripe-reviews`) }), body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.code, 'stripe_review_unavailable'); assert.doesNotMatch(JSON.stringify(body), /synthetic-secret/);
});

test('a membership review written by the webhook appears in the manager view as recorded', async () => {
  const rows = new Map(Object.entries({
    'customers/cust-a': { name: 'Synthetic A', phone: '970-555-0142' }, 'customers/cust-b': { name: 'Synthetic B', phone: '(970) 555-0142' },
  }).map(([path, value], index) => [path, { value, revision: `r${index}` }]));
  let revision = 10;
  const out = ([path, row]) => ({ ...structuredClone(row.value), id: path.split('/')[1], revision: row.revision });
  const store = {
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? out([`${collection}/${id}`, row]) : null; },
    async customers() { return [...rows].filter(([path]) => path.startsWith('customers/')).map(out); },
    async customerJobs() { return []; },
    async commit(writes) { for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { value: { ...(rows.get(`${write.collection}/${write.id}`)?.value || {}), ...structuredClone(write.patch) }, revision: `r${++revision}` }); },
    async list(collection) { return { rows: [...rows].filter(([path]) => path.startsWith(`${collection}/`)).map(out), complete: true }; },
  };
  const event = garageGuardEvent({ id: 'evt_review_view', type: 'checkout.session.completed', created: 1, livemode: false, data: { object: { mode: 'subscription', payment_status: 'paid', subscription: 'sub_review_view', customer: 'cus_review', metadata: { plan: 'black' }, customer_details: { phone: '+19705550142', name: 'Synthetic Member' }, custom_fields: [{ key: 'service_address', text: { value: '2 Synthetic Way' } }] } } });
  assert.equal((await applyGarageGuardEvent(store, event, { now: NOW.toISOString() })).reason, 'ambiguous_customer');
  const view = await stripeReviewOverview(store, owner, NOW);
  assert.deepEqual(view.membershipReviews, [{ subscriptionId: 'sub_review_view', revision: rows.get('membership_reviews/sub_review_view').revision, reason: 'ambiguous_customer', status: 'open', plan: 'black', candidateCustomerIds: ['cust-a', 'cust-b'],
    candidates: [{ id: 'cust-a', found: true, name: 'Synthetic A', phone: '970-555-0142', email: '', address: '' }, { id: 'cust-b', found: true, name: 'Synthetic B', phone: '(970) 555-0142', email: '', address: '' }],
    customerName: 'Synthetic Member', customerEmail: '', phone: '+19705550142', serviceAddress: '2 Synthetic Way', eventId: 'evt_review_view', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }]);
  assert.deepEqual(view.counts, { paymentReviews: 0, membershipReviews: 1 });
});
