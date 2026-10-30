import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCustomerStripeCheckout, recordCustomerStripePayment } from '../functions/_lib/customer-payments.js';
import { customerMoneyTotals } from '../functions/_lib/money-core.js';
import { moneyStorage } from '../functions/_lib/money-storage.js';
import { REVIEW_LIST_LIMIT, stripeReviewOverview, stripeReviewStorage } from '../functions/_lib/stripe-reviews.js';
import { moneyHandlers } from '../functions/api/money.js';
import { stripeReviewHandlers } from '../functions/api/stripe-reviews.js';
import { firestoreMemory } from './helpers/firestore-memory.mjs';
import { createDocument, storage, FixedDate } from './helpers/hub-dom.mjs';

// A balance paid twice (QA, issue #304): the office records a check by hand while the customer's portal card checkout
// for the same balance is still open, and the customer then finishes that checkout. Recording money by hand now closes
// the open checkout (as a change_order.void does), a card payment that still lands is recorded in full, and a job paid
// above its total is listed in Hub > Review queues. Synthetic data only; nothing leaves the process; the clock is fixed.
const NOW = '2026-10-30T16:00:00.000Z', LATER = '2026-10-30T17:00:00.000Z';
const ORIGIN = 'https://easygaragecleaning.com';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const OFF = { FIREBASE_API_KEY: 'firebase-test-offline-checkout', STRIPE_SECRET_KEY: 'sk_test_synthetic_offline_checkout', MONEY_API_ENABLED: 'true' };
const UNIFIED = { ...OFF, MONEY_UNIFIED_TOTALS: 'true' };
const post = body => new Request(`${ORIGIN}/api/money`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// A completed $1,000 job whose $250 deposit was paid by card: $750 is due now.
const completedJob = (extra = {}) => ({
  type: 'job', customer: 'Synthetic Customer', customerId: 'customer-synthetic-1', email: 'synthetic@example.invalid', serviceType: 'Garage Turnaround', date: '2026-10-29',
  status: 'completed', pipelineStatus: 'completed', completedAt: '2026-10-29T20:00:00.000Z', total: 1000,
  estimate: { number: 'EST-SYN1', status: 'accepted', amount: 1000, depositRequired: 250, revision: 1 }, customerApproval: { status: 'approved', amount: 1000 },
  deposit: { amount: 250, paidAmount: 250, status: 'paid', verified: true },
  payment: { amount: 250, verified: true, method: 'stripe', stripeSessions: [{ sessionId: 'cs_test_synthetic_deposit', paymentIntentId: 'pi_synthetic_deposit', amount: 250, purpose: 'deposit', verifiedAt: '2026-10-20T17:00:00.000Z' }] },
  ...extra,
});

// Stripe Checkout in-process: create, read and expire sessions; pay() is the customer finishing a page they still have open.
function stripeStub() {
  const sessions = new Map(), keys = new Map(), expired = [];
  const handle = (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
      const params = new URLSearchParams(options.body), key = options.headers?.['Idempotency-Key'];
      if (!keys.has(key)) {
        const id = `cs_test_synthetic_offline_${sessions.size + 1}`;
        sessions.set(id, { id, object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', currency: 'usd', livemode: false, client_reference_id: params.get('client_reference_id'), url: `https://checkout.stripe.com/c/pay/${id}`,
          amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), metadata: Object.fromEntries([...params].filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value])) });
        keys.set(key, id);
      }
      return Response.json(sessions.get(keys.get(key)));
    }
    const match = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/), session = match && sessions.get(decodeURIComponent(match[1]));
    if (!session) return Response.json({ error: { message: 'No such checkout.session' } }, { status: 404 });
    if (match[2] && method === 'POST') { if (session.status === 'open') { session.status = 'expired'; session.url = null; expired.push(session.id); } return Response.json(session); }
    return Response.json(session);
  };
  const pay = id => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', url: null, customer_details: { email: 'synthetic@example.invalid' },
    payment_intent: { id: `pi_${id}`, latest_charge: { id: `ch_${id}`, amount_refunded: 0, refunded: false, receipt_url: `https://pay.stripe.com/receipts/${id}` } } });
  return { sessions, expired, handle, pay };
}

function world(t) {
  const stripe = stripeStub();
  const mem = firestoreMemory({ fallback: (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, 'api.stripe.com', `Unexpected external request to ${url.hostname}`);
    return stripe.handle(url, options);
  } });
  t.mock.method(globalThis, 'fetch', mem.fetch);
  return { mem, stripe };
}

test('recording the balance by hand closes the customer’s open card checkout; a card payment that lands anyway is kept in full and the job is listed in Review queues', async t => {
  for (const env of [OFF, UNIFIED]) {
    const label = env.MONEY_UNIFIED_TOTALS ? 'unified' : 'off', { mem, stripe } = world(t);
    mem.put('jobs/job-twice', completedJob());
    // 9:00 the customer opens Pay for the $750 balance.
    const opened = await createCustomerStripeCheckout(env, env.STRIPE_SECRET_KEY, 'job-twice', ORIGIN, { now: NOW });
    const [sessionId] = stripe.sessions.keys();
    assert.deepEqual([opened.amount, mem.get('customer_payment_checkouts/job-twice').status], [750, 'open'], label);
    // 10:00 the office records the customer's $750 check in Estimates & payments.
    const api = moneyHandlers({ session: async () => owner, now: () => new Date(NOW) });
    const expectedRevision = (await moneyStorage(env).read('jobs', 'job-twice')).revision;
    const response = await api.post({ request: post({ action: 'payment.record_offline', requestId: randomUUID(), jobId: 'job-twice', expectedRevision, amountCents: 75000, method: 'check', reference: 'Check 9001' }), env }), body = await response.json();
    assert.equal(response.status, 200, label);
    assert.deepEqual(body.warnings.map(warning => warning.code), ['checkout_closed'], `${label}: staff are told the open checkout was closed`);
    assert.deepEqual(stripe.expired, [sessionId], `${label}: Stripe closed the old checkout, so the page cannot take the money again`);
    assert.equal(mem.get('customer_payment_checkouts/job-twice').status, 'expired', label);
    assert.equal(customerMoneyTotals(mem.get('jobs/job-twice')).balanceCents, 0, label);
    // Should that card payment still land, it is never dropped: it is recorded in full and the job is flagged...
    stripe.pay(sessionId);
    const paid = await recordCustomerStripePayment(env, stripe.sessions.get(sessionId), 'job-twice', LATER, { recordedBy: 'stripe_webhook', settleHeld: false, fromWebhook: true });
    const saved = mem.get('jobs/job-twice');
    assert.equal(paid.paid, true, label);
    assert.deepEqual([saved.payment.amount, saved.payment.stripeSessions.some(item => item.sessionId === sessionId), saved.paymentReviewRequired], [1750, true, true], `${label}: every dollar taken is on the job`);
    // ...and listed in Review queues with the amount to refund, until the job is no longer paid above its total.
    const reviews = stripeReviewHandlers({ session: async () => owner, now: () => new Date(LATER) });
    const read = async () => (await reviews.get({ env, request: new Request(`${ORIGIN}/api/stripe-reviews`) })).json();
    const view = await read();
    assert.deepEqual(view.overpaidJobs, [{ jobId: 'job-twice', customer: 'Synthetic Customer', date: '2026-10-29', totalCents: 100000, appliedCents: 175000, overpaidCents: 75000 }], label);
    assert.deepEqual([view.counts, view.coverage.complete], [{ paymentReviews: 0, membershipReviews: 0 }, true], label);
    mem.put('jobs/job-twice', { ...saved, payment: { ...saved.payment, amount: 1000 } });
    assert.deepEqual((await read()).overpaidJobs, [], `${label}: a corrected job leaves the list on its own`);
  }
});

test('recording a deposit by hand closes the customer’s open deposit checkout too', async t => {
  const { mem, stripe } = world(t);
  mem.put('jobs/job-deposit', completedJob({ status: 'scheduled', pipelineStatus: 'scheduled', completedAt: null, date: '2026-11-12', deposit: { amount: 250, paidAmount: 0, status: 'due' }, payment: {} }));
  assert.equal((await createCustomerStripeCheckout(OFF, OFF.STRIPE_SECRET_KEY, 'job-deposit', ORIGIN, { now: NOW })).amount, 250);
  const api = moneyHandlers({ session: async () => owner, now: () => new Date(NOW) }), expectedRevision = (await moneyStorage(OFF).read('jobs', 'job-deposit')).revision;
  const body = await (await api.post({ request: post({ action: 'deposit.record_offline', requestId: randomUUID(), jobId: 'job-deposit', expectedRevision, amountCents: 25000, method: 'cash', reference: 'Cash receipt 12' }), env: OFF })).json();
  assert.deepEqual([body.ok, body.warnings.map(warning => warning.code)], [true, ['checkout_closed']]);
  assert.deepEqual(stripe.expired, [[...stripe.sessions.keys()][0]]);
  assert.equal(mem.get('customer_payment_checkouts/job-deposit').status, 'expired');
});

test('a deposit the customer already paid online is not mistaken for an open checkout when the office records the balance', async t => {
  const { mem, stripe } = world(t);
  mem.put('jobs/job-usual', completedJob({ deposit: { amount: 250, paidAmount: 0, status: 'due' }, payment: {} }));
  // The customer paid the $250 deposit in the portal and came back: the charge is on the job, its checkout row still open.
  mem.put('jobs/job-usual', { ...mem.get('jobs/job-usual'), status: 'scheduled', pipelineStatus: 'scheduled', completedAt: null });
  await createCustomerStripeCheckout(OFF, OFF.STRIPE_SECRET_KEY, 'job-usual', ORIGIN, { now: NOW });
  const [sessionId] = stripe.sessions.keys();
  stripe.pay(sessionId);
  await recordCustomerStripePayment(OFF, stripe.sessions.get(sessionId), 'job-usual', NOW);
  mem.put('jobs/job-usual', { ...mem.get('jobs/job-usual'), status: 'completed', pipelineStatus: 'completed', completedAt: '2026-10-29T20:00:00.000Z' });
  assert.deepEqual([mem.get('jobs/job-usual').payment.amount, mem.get('customer_payment_checkouts/job-usual').status], [250, 'open']);
  // On the job day the office records the $750 balance check: nothing is open to close, and no one is told otherwise.
  const api = moneyHandlers({ session: async () => owner, now: () => new Date(LATER) }), expectedRevision = (await moneyStorage(OFF).read('jobs', 'job-usual')).revision;
  const body = await (await api.post({ request: post({ action: 'payment.record_offline', requestId: randomUUID(), jobId: 'job-usual', expectedRevision, amountCents: 75000, method: 'check', reference: 'Check 9002' }), env: OFF })).json();
  assert.deepEqual([body.ok, body.warnings], [true, []]);
  assert.deepEqual(stripe.expired, []);
});

// The office job a manager records money on (Estimates & payments): a $1,000 quote, nothing paid yet.
function fixture() {
  const docs = new Map([['jobs/job-office', { ...completedJob({ deposit: { amount: 250, paidAmount: 0, status: 'due' }, payment: {} }), id: 'job-office', revision: 'r0' }]]);
  let n = 0;
  const store = {
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    async commit(writes) {
      for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 }); }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  return { store, job: () => docs.get('jobs/job-office') };
}

test('every money recorded by hand checks the customer’s checkout once, after it is saved, and says what happened in words that are true', async () => {
  const cases = [
    ['expired', ['checkout_closed'], /checkout was closed so it cannot charge this money again/],
    ['paid', ['checkout_paid'], /already paid a card checkout opened before this was recorded.*listed in Review queues/],
    ['pending', ['checkout_open'], /may still be open.*listed in Review queues/],
    [new Error('synthetic Stripe outage'), ['checkout_open'], /may still be open.*listed in Review queues/],
    ['none', [], null], ['current', [], null],
  ];
  for (const [action, amountCents] of [['deposit.record_offline', 25000], ['payment.record_offline', 30000]]) {
    for (const [outcome, codes, message] of cases) {
      const f = fixture(), calls = [];
      const api = moneyHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(NOW), checkouts: async (env, jobId) => { calls.push([jobId, f.job().payment.amount]); if (outcome instanceof Error) throw outcome; return outcome; } });
      const response = await api.post({ request: post({ action, requestId: randomUUID(), jobId: 'job-office', expectedRevision: 'r0', amountCents, method: 'check', reference: 'Check 7001' }), env: { MONEY_API_ENABLED: 'true' } }), body = await response.json();
      assert.deepEqual([response.status, body.ok], [200, true], `${action} ${outcome}`);
      assert.deepEqual(body.warnings.map(warning => warning.code), codes, `${action} ${outcome}`);
      if (message) assert.match(body.warnings.at(-1).message, message);
      assert.deepEqual(calls, [['job-office', amountCents / 100]], `${action}: checked once, after the money was saved`);
      for (const warning of body.warnings) assert.doesNotMatch(warning.message, /flagged for review/, 'no warning promises a flag nobody reads');
    }
  }
  // A void's warning names where the extra payment shows up, too (tests/change-order-void.test.mjs runs the void itself).
  const source = readFileSync(new URL('../functions/api/money.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /flagged for review/);
  assert.match(source, /before this void may still be open for the old balance\. If the customer pays it, the job is listed in Review queues as paid above its total/);
});

// Review queues store: lists of open reviews (none here) and the flagged jobs a query would return.
const reviewStore = (flagged, { complete = true, fail = false } = {}) => ({
  list: async () => ({ rows: [], complete: true }), read: async () => null,
  flaggedJobs: async () => { if (fail) throw Object.assign(new Error('synthetic outage'), { code: 'stripe_review_storage_unavailable' }); return { rows: flagged, complete }; },
});

test('Review queues list a job a card payment put above its total while it is still over, in the totals mode shown, and never a private or corrected one', async () => {
  const over = { ...completedJob({ payment: { amount: 1750, verified: true } }), id: 'job-over', revision: 'r1', paymentReviewRequired: true };
  const corrected = { ...over, id: 'job-corrected', payment: { amount: 1000, verified: true } };
  const unreadable = { ...over, id: 'job-unreadable', payment: { amount: 'lots', verified: true } };
  // Unified totals count only billed change lines: an approval saved without one is owed today, not in unified money.
  const changed = { ...over, id: 'job-changed', payment: { amount: 1100, verified: true }, approvedChangeTotal: 150 };
  const rows = [over, corrected, unreadable, changed, { ...over, id: 'secure_vault' }, { ...over, id: 'job-availability', recordType: 'availability' }, { ...over, id: 'job-unflagged', paymentReviewRequired: 'yes' }];
  const view = await stripeReviewOverview(reviewStore(rows), owner, new Date(NOW));
  assert.deepEqual(view.overpaidJobs.map(row => [row.jobId, row.overpaidCents]), [['job-over', 75000], ['job-unreadable', null]]);
  const unified = await stripeReviewOverview(reviewStore(rows), owner, new Date(NOW), { totalsMode: 'unified' });
  assert.deepEqual(unified.overpaidJobs.map(row => [row.jobId, row.overpaidCents]), [['job-changed', 10000], ['job-over', 75000], ['job-unreadable', null]]);
  assert.doesNotMatch(JSON.stringify(view.overpaidJobs), /synthetic@example|customer-synthetic-1|EST-SYN1/, 'only allowlisted fields leave the server');
  // More flagged jobs than one read holds: the view says so. An outage hides nothing else and is never "none".
  assert.equal((await stripeReviewOverview(reviewStore([over], { complete: false }), owner, new Date(NOW))).coverage.complete, false);
  const outage = await stripeReviewOverview(reviewStore([over], { fail: true }), owner, new Date(NOW));
  assert.deepEqual([outage.overpaidJobs, outage.coverage.complete, outage.ok], [null, true, true]);
  await assert.rejects(stripeReviewOverview(reviewStore([over]), { user: 'crew1', role: 'crew', businessAccess: false }, new Date(NOW)), error => /^dispatch_/.test(error.code));
});

test('the flagged-jobs read is one equality query on the job flag, capped, and fails closed on a malformed answer', async () => {
  const ROOT = 'projects/egcw-1ec83/databases/(default)/documents', asked = [];
  const doc = (id, fields = { paymentReviewRequired: { booleanValue: true } }) => ({ document: { name: `${ROOT}/jobs/${id}`, fields, updateTime: '2026-10-30T00:00:00.000001Z' }, readTime: '2026-10-30T00:00:00Z' });
  const reader = answer => stripeReviewStorage({ FIREBASE_API_KEY: 'firebase-test-offline-checkout' }, async (_env, url, init) => { asked.push({ url: String(url), init }); return typeof answer === 'function' ? answer() : Response.json(answer); });
  const { rows, complete } = await reader([doc('job-a'), doc('job-b')]).flaggedJobs();
  assert.deepEqual([rows.map(row => [row.id, row.paymentReviewRequired, row.revision]), complete], [[['job-a', true, '2026-10-30T00:00:00.000001Z'], ['job-b', true, '2026-10-30T00:00:00.000001Z']], true]);
  assert.match(asked[0].url, /\/documents:runQuery$/);
  assert.deepEqual(JSON.parse(asked[0].init.body), { structuredQuery: { from: [{ collectionId: 'jobs' }], where: { fieldFilter: { field: { fieldPath: 'paymentReviewRequired' }, op: 'EQUAL', value: { booleanValue: true } } }, limit: REVIEW_LIST_LIMIT + 1 } });
  assert.deepEqual(await reader([{ readTime: '2026-10-30T00:00:00Z' }]).flaggedJobs(), { rows: [], complete: true });
  const many = await reader(Array.from({ length: REVIEW_LIST_LIMIT + 1 }, (_, index) => doc(`job-${index}`))).flaggedJobs();
  assert.deepEqual([many.rows.length, many.complete], [REVIEW_LIST_LIMIT, false]);
  for (const bad of [[], {}, [doc('job-a'), doc('job-a')], [{ document: { name: `${ROOT}/jobs/job-a`, fields: {} } }], [null]]) await assert.rejects(reader(bad).flaggedJobs(), error => error.code === 'stripe_review_storage_incomplete', JSON.stringify(bad));
  await assert.rejects(reader(() => new Response('{}', { status: 500 })).flaggedJobs(), error => error.code === 'stripe_review_storage_unavailable');
});

// The real Review queues screen and Command Center alert, in a vm DOM with the Hub kit and fake APIs.
const reviewsResponse = overpaidJobs => ({ ok: true, paymentReviews: [], membershipReviews: [], overpaidJobs, counts: { paymentReviews: 0, membershipReviews: 0 }, viewer: { canRecordRefund: true }, checkoutBlock: false, coverage: { complete: true, asOf: NOW } });
const OVER = { jobId: 'job-twice', customer: 'Synthetic Customer', date: '2026-10-29', totalCents: 100000, appliedCents: 175000, overpaidCents: 75000 };
async function reviewsScreen(stripe) {
  const document = createDocument(), events = {};
  const context = { console, URL, URLSearchParams, Intl, Promise, Map, Set, Error, JSON, Object, Array, Math, Number, String, AbortController, crypto, Date: FixedDate, Node: document.Node, document,
    sessionStorage: storage(), localStorage: storage(), setTimeout: () => 0, clearTimeout() {}, addEventListener: (name, listener) => { (events[name] ||= []).push(listener); } };
  context.window = context;
  vm.createContext(context);
  for (const file of ['employee-ui-kit.js', 'employee-reviews.js']) vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, { filename: file });
  const answers = { '/api/stripe-reviews': stripe, '/api/message-sends': { ok: true, sends: [], coverage: { complete: true } }, '/api/portal-documents-admin': { ok: true, insurance: { state: 'current' } } };
  const host = document.createElement('main');
  document.body.append(host);
  context.EGCReviews.mount(host, { hubFetch: async path => ({ ok: true, status: 200, json: async () => answers[path] }), go() {} });
  for (let index = 0; index < 40; index++) await new Promise(resolve => setImmediate(resolve));
  return host.textContent.replace(/\s+/g, ' ');
}

test('Review queues show each job paid above its total with the amount over, and say when the jobs could not be checked', async () => {
  const shown = await reviewsScreen(reviewsResponse([OVER]));
  assert.match(shown, /Jobs paid above their total\s*1/);
  assert.match(shown, /\$750\.00 over · Synthetic Customer/);
  assert.match(shown, /\$1,750\.00 of \$1,000\.00/);
  assert.match(shown, /Refund the extra in Stripe/);
  assert.match(shown, /1 job paid above total/);
  assert.match(await reviewsScreen(reviewsResponse([])), /No job is paid above its total\./);
  assert.match(await reviewsScreen(reviewsResponse(null)), /Jobs paid above their total could not be checked/);
  assert.doesNotMatch(await reviewsScreen({ ...reviewsResponse(undefined), overpaidJobs: undefined }), /paid above their total/, 'a server from before the list shows no empty section');
});

test('the Command Center alert counts jobs paid above their total and never shows them as clear when they could not be checked', async () => {
  const run = async stripe => {
    const document = createDocument(), context = { document, Node: document.Node, console, Promise, Object, Array, String, Number, Error, JSON, Date: FixedDate, addEventListener() {} };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(readFileSync(new URL('../employee-review-alerts.js', import.meta.url), 'utf8'), context, { filename: 'employee-review-alerts.js' });
    const answers = { '/api/stripe-reviews': stripe, '/api/message-sends': { ok: true, sends: [] }, '/api/portal-documents-admin': { ok: true, insurance: { state: 'current' } } };
    const slot = document.createElement('div');
    document.body.append(slot);
    context.EGCReviewAlerts.mount(slot, { hubFetch: async path => ({ ok: true, status: 200, json: async () => answers[path] }), go() {} });
    for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve));
    return slot.textContent.replace(/\s+/g, ' ');
  };
  const one = await run(reviewsResponse([OVER]));
  assert.match(one, /1 item is waiting for a person/);
  assert.match(one, /1 job is paid above the total/);
  assert.match(await run(reviewsResponse([OVER, { ...OVER, jobId: 'job-2' }])), /2 jobs are paid above the total/);
  assert.match(await run(reviewsResponse(null)), /Review queues could not be checked/);
  assert.equal(await run(reviewsResponse([])), '', 'nothing waiting: no alert');
});
