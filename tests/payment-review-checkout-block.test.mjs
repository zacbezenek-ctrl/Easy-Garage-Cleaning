import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createCustomerStripeCheckout, openPaymentReview, paymentReviewCheckoutBlockEnabled } from '../functions/_lib/customer-payments.js';
import * as crewPayment from '../functions/api/job-payment.js';

const origin = 'https://easygaragecleaning.com';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const env = {
  FIREBASE_API_KEY: 'firebase-test-review-checkout-block', STRIPE_SECRET_KEY: 'sk_test_synthetic_review_block', HUB_SESSION_SECRET: 'synthetic-review-block-hub-secret',
  HUB_AUTH_USERS_JSON: JSON.stringify({ crew1: { role: 'crew', displayName: 'Synthetic Crew', passwordHash: 'synthetic-hash' } }),
};
const blocking = { ...env, PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED: 'true' };
const code = (expected, status) => error => { assert.equal(error.code, expected); if (status) assert.equal(error.status, status); return true; };
const review = (sessionId, status = 'open', jobId = 'job-1') => ({ document: { name: `${ROOT}/payment_reviews/${sessionId}`, updateTime: '2026-09-22T00:00:00.000001Z', fields: encodeFirestoreFields({ status, jobId }) } });

test('the block is off unless the flag is exactly "true"', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) assert.equal(paymentReviewCheckoutBlockEnabled({ PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED: value }), false, String(value));
  assert.equal(paymentReviewCheckoutBlockEnabled(blocking), true);
});

test('an open review is found with one filtered query; anything unverifiable fails closed', async () => {
  let answer = [], seen = null;
  const fetcher = async (_env, url, init) => { seen = { url: String(url), body: JSON.parse(init.body) }; return typeof answer === 'function' ? answer() : Response.json(answer); };
  assert.equal(await openPaymentReview(env, 'job-1', fetcher), false);
  assert.match(seen.url, /documents:runQuery$/);
  assert.deepEqual(seen.body.structuredQuery.from, [{ collectionId: 'payment_reviews' }]);
  assert.deepEqual(seen.body.structuredQuery.where, { fieldFilter: { field: { fieldPath: 'jobId' }, op: 'EQUAL', value: { stringValue: 'job-1' } } }, 'one equality filter needs only the automatic single-field index');
  answer = [review('cs_test_done', 'resolved'), { readTime: '2026-09-22T00:00:00Z' }];
  assert.equal(await openPaymentReview(env, 'job-1', fetcher), false);
  answer = [review('cs_test_done', 'resolved'), review('cs_test_open')];
  assert.equal(await openPaymentReview(env, 'job-1', fetcher), true);
  for (const broken of [{ not: 'a list' }, [review('cs_test_other', 'open', 'job-2')], Array.from({ length: 200 }, (_, index) => review(`cs_test_${index}`, 'resolved')), () => Response.json({}, { status: 500 }), () => { throw new TypeError('offline'); }, () => new Response('not json')]) {
    answer = broken;
    await assert.rejects(openPaymentReview(env, 'job-1', fetcher), code('payment_review_unavailable', 503));
  }
});

// Firestore and Stripe fakes for the crew card link and the portal checkout.
function fixture(t, { reviews = [], queryFails = false, job = {} } = {}) {
  const docs = new Map([['jobs/job-1', { value: { type: 'job', customer: 'Synthetic Customer', email: 'customer@example.invalid', total: 1000, status: 'in_progress', assignedCrew: ['crew1'], estimate: { amount: 1000, status: 'accepted' }, customerApproval: { status: 'accepted' }, ...job }, version: 1 }]]);
  const calls = { queries: 0, stripe: [], ledgerWrites: 0 };
  const time = version => `2026-09-22T00:00:00.${String(version).padStart(6, '0')}Z`;
  const document = path => ({ name: `${ROOT}/${path}`, fields: encodeFirestoreFields(docs.get(path).value), updateTime: time(docs.get(path).version) });
  const sessions = new Map();
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      if (url.pathname.endsWith(':runQuery')) { calls.queries++; return queryFails ? Response.json({}, { status: 503 }) : Response.json(reviews.map(([id, status]) => review(id, status))); }
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]);
      if (method === 'PATCH') {
        const row = docs.get(path), expected = url.searchParams.get('currentDocument.updateTime'), create = url.searchParams.get('currentDocument.exists') === 'false';
        if (create ? row : expected && (!row || time(row.version) !== expected)) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
        calls.ledgerWrites += path.startsWith('customer_payment_checkouts/') ? 1 : 0;
        docs.set(path, { value: { ...(row?.value || {}), ...decodeFirestoreFields(JSON.parse(options.body).fields) }, version: (row?.version || 0) + 1 });
      }
      return docs.has(path) ? Response.json(document(path)) : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') {
      calls.stripe.push(`${method} ${url.pathname}`);
      if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const params = new URLSearchParams(options.body), id = `cs_test_block_${sessions.size + 1}`;
        sessions.set(id, { id, status: 'open', payment_status: 'unpaid', amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), url: `https://checkout.stripe.com/c/pay/${id}` });
        return Response.json(sessions.get(id));
      }
      const session = sessions.get(url.pathname.split('/')[4]);
      return session ? Response.json(session) : Response.json({}, { status: 404 });
    }
    throw new Error(`Unexpected host ${url.hostname}`);
  });
  return calls;
}

async function crewCharge(environment) {
  const cookie = (await createHubSessionCookie(environment, 'crew1')).split(';')[0];
  const response = await crewPayment.onRequestPost({ env: environment, request: new Request(`${origin}/api/job-payment`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: 'job-1', request_id: 'synthetic-block-request', amount_cents: 30000 }) }) });
  return { status: response.status, body: await response.json() };
}

test('a crew card link is refused while a confirmed charge on the job is held for review, only when the flag is on', async t => {
  let calls = fixture(t, { reviews: [['cs_test_held', 'open']] });
  const off = await crewCharge(env);
  assert.equal(off.status, 200, 'flag off: today\'s behaviour, no extra read');
  assert.equal(calls.queries, 0); assert.equal(calls.stripe.length, 1);
  t.mock.restoreAll();
  calls = fixture(t, { reviews: [['cs_test_held', 'open']] });
  const held = await crewCharge(blocking);
  assert.deepEqual([held.status, held.body.code], [409, 'payment_review_open']);
  assert.match(held.body.error, /Do not charge again/);
  assert.deepEqual(calls.stripe, [], 'no Stripe checkout is created');
  t.mock.restoreAll();
  calls = fixture(t, { reviews: [['cs_test_held', 'resolved']] });
  assert.equal((await crewCharge(blocking)).status, 200, 'a resolved review no longer blocks');
  t.mock.restoreAll();
  calls = fixture(t, { queryFails: true });
  const unknown = await crewCharge(blocking);
  assert.deepEqual([unknown.status, unknown.body.code, calls.stripe.length], [503, 'payment_review_unavailable', 0], 'an unverifiable review state never opens a charge');
});

test('the customer portal cannot open or resume a checkout while a review is open', async t => {
  let calls = fixture(t, { reviews: [['cs_test_held', 'open']] });
  await assert.rejects(createCustomerStripeCheckout(blocking, blocking.STRIPE_SECRET_KEY, 'job-1', origin), error => error.code === 'payment_review_open' && error.status === 409 && /Please wait/.test(error.message));
  assert.deepEqual([calls.stripe.length, calls.ledgerWrites], [0, 0], 'nothing reaches Stripe and no checkout claim is written');
  t.mock.restoreAll();
  const reviews = [];
  calls = fixture(t, { reviews });
  const opened = await createCustomerStripeCheckout(blocking, blocking.STRIPE_SECRET_KEY, 'job-1', origin);
  assert.match(opened.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(opened.amount, 500);
  // A crew charge gets held after the link opened: the open link is not handed out again.
  reviews.push(['cs_test_late', 'open']);
  const queries = calls.queries, resumed = await createCustomerStripeCheckout(env, env.STRIPE_SECRET_KEY, 'job-1', origin);
  assert.equal(resumed.url, opened.url, 'flag off: the open link resumes as today');
  assert.equal(calls.queries, queries, 'flag off: no review read');
  await assert.rejects(createCustomerStripeCheckout(blocking, blocking.STRIPE_SECRET_KEY, 'job-1', origin), code('payment_review_open', 409));
  assert.equal(calls.stripe.filter(call => call === 'POST /v1/checkout/sessions').length, 1, 'no second session was created');
  assert.ok(!calls.stripe.some(call => call.endsWith('/expire')), 'the existing session is left alone, never expired or replaced');
});
