import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { stripeSecretKey } from '../functions/_lib/customer-payments.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import { stripeReviewHandlers } from '../functions/api/stripe-reviews.js';
import { resolveStripeReview, stripeReviewClient, stripeReviewStorage } from '../functions/_lib/stripe-reviews.js';
import * as crewPayment from '../functions/api/job-payment.js';
import * as portal from '../functions/api/customer-portal.js';

const NOW = '2026-09-22T12:00:00.000Z';
const origin = 'https://easygaragecleaning.com';
const env = {
  FIREBASE_API_KEY: 'firebase-test-crew-payment-webhook', STRIPE_SECRET_KEY: 'sk_test_synthetic_crew_payment', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_crew_payment',
  CUSTOMER_PORTAL_SECRET: 'synthetic-crew-payment-portal-secret', HUB_SESSION_SECRET: 'synthetic-crew-payment-hub-secret', GARAGE_GUARD_HOOK_URL: 'https://hooks.example.invalid/garage-guard',
  HUB_AUTH_USERS_JSON: JSON.stringify({ crew1: { role: 'crew', displayName: 'Synthetic Crew', passwordHash: 'synthetic-hash' }, ZacB: { role: 'owner', passwordHash: 'synthetic-hash' } }),
};
const crewJob = () => ({ type: 'job', customer: 'Synthetic Crew Customer', email: 'crew-customer@example.invalid', total: 1000, status: 'in_progress', assignedCrew: ['crew1'] });

async function fixture(t, initial = {}, environment = env) {
  const docs = new Map([['jobs/job-1', { value: { ...crewJob(), ...initial }, version: 1 }]]), sessions = new Map(), stripeCalls = [], hooks = [], commits = [];
  let failJobWrites = false, failReads = false, failReviewWrites = false, loseReviewResponse = false, failStripeReads = false, jobPatches = 0, contention = 0, beforeCommit = null, beforeJobPatch = null, transactionSeq = 0;
  const version = row => `2026-09-22T00:00:00.${String(row.version).padStart(6, '0')}Z`, transactions = new Map();
  const document = (key, value) => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${key}`, fields: encodeFirestoreFields(value.value), updateTime: version(value) });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      // Verify-only fences (membership links) use a read-write transaction: its reads are remembered, and the
      // commit aborts (409 ABORTED, as Firestore answers) if any of them changed since. Payment resolutions
      // write a marker on the job under its revision instead, so they commit without a transaction.
      if (url.pathname.endsWith(':beginTransaction')) { const id = `synthetic-transaction-${++transactionSeq}`; transactions.set(id, new Map()); return Response.json({ transaction: id }); }
      if (url.pathname.endsWith(':rollback')) { transactions.delete(JSON.parse(options.body).transaction); return Response.json({}); }
      // The checkout block's one-filter query (PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED): an empty result is one readTime row, as Firestore answers.
      if (url.pathname.endsWith(':runQuery')) {
        const query = JSON.parse(options.body).structuredQuery, filter = query.where.fieldFilter, collection = query.from[0].collectionId;
        const rows = [...docs].filter(([key, row]) => key.split('/').length === 2 && key.startsWith(`${collection}/`) && row.value[filter.field.fieldPath] === filter.value.stringValue);
        return Response.json(rows.length ? rows.map(([key, row]) => ({ document: document(key, row) })) : [{ readTime: NOW }]);
      }
      if (url.pathname.endsWith(':batchGet')) {
        const body = JSON.parse(options.body), reads = transactions.get(body.transaction);
        return Response.json(body.documents.map(name => { const key = decodeURIComponent(name.split('/documents/')[1]), row = docs.get(key); if (row) reads?.set(key, row.version); return row ? { found: document(key, row) } : { missing: name }; }));
      }
      // An atomic commit (a held session applied with the mark on its open review): all preconditions or nothing.
      if (url.pathname.endsWith(':commit')) {
        const body = JSON.parse(options.body), writes = body.writes.map(write => ({ ...write, path: decodeURIComponent(write.update.name.split('/documents/')[1]) }));
        const race = beforeCommit; beforeCommit = null; race?.();
        if (body.transaction) {
          const reads = transactions.get(body.transaction); transactions.delete(body.transaction);
          if (!reads || [...reads].some(([key, read]) => docs.get(key)?.version !== read)) return Response.json({ error: { code: 409, status: 'ABORTED' } }, { status: 409 });
        }
        if (contention && writes.some(write => write.path.startsWith('jobs/'))) { contention--; docs.get('jobs/job-1').version++; }
        if (failJobWrites && writes.some(write => write.path.startsWith('jobs/'))) return Response.json({}, { status: 503 });
        if (writes.some(write => { const row = docs.get(write.path); return write.currentDocument.updateTime ? !row || version(row) !== write.currentDocument.updateTime : row; })) return Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 });
        for (const write of writes) {
          const row = docs.get(write.path);
          docs.set(write.path, { value: { ...(row?.value || {}), ...decodeFirestoreFields(write.update.fields) }, version: (row?.version || 0) + 1 });
          if (write.path.startsWith('jobs/')) jobPatches++;
        }
        commits.push(writes.map(write => write.path));
        return Response.json({ writeResults: writes.map(() => ({})) });
      }
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]); let row = docs.get(path);
      if (failReads && method === 'GET') return Response.json({}, { status: 503 });
      if (method === 'GET' && !path.includes('/')) {
        const rows = [...docs].filter(([key]) => key.startsWith(`${path}/`));
        return Response.json(rows.length ? { documents: rows.map(([key, value]) => document(key, value)) } : {});
      }
      if (method === 'PATCH') {
        // Another request runs to completion before this job write reaches Firestore (it lands after that commit).
        if (beforeJobPatch && path.startsWith('jobs/')) { const run = beforeJobPatch; beforeJobPatch = null; await run(); row = docs.get(path); }
        if (failJobWrites && path.startsWith('jobs/')) return Response.json({}, { status: 503 });
        if (failReviewWrites && path.startsWith('payment_reviews/')) return Response.json({}, { status: 503 });
        // Another writer lands first; Firestore answers a stale updateTime with 400 FAILED_PRECONDITION.
        if (contention && path.startsWith('jobs/')) { contention--; row.version++; }
        if (row ? url.searchParams.get('currentDocument.updateTime') !== version(row) : url.searchParams.get('currentDocument.exists') !== 'false') return Response.json({ error: { code: row ? 400 : 409, status: row ? 'FAILED_PRECONDITION' : 'ALREADY_EXISTS' } }, { status: row ? 400 : 409 });
        if (path.startsWith('jobs/')) jobPatches++;
        row = { value: { ...(row?.value || {}), ...decodeFirestoreFields(JSON.parse(options.body).fields) }, version: (row?.version || 0) + 1 }; docs.set(path, row);
        if (loseReviewResponse && path.startsWith('payment_reviews/')) { loseReviewResponse = false; throw new TypeError('Synthetic lost response'); }
      }
      return row ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(row.value), updateTime: version(row) }) : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') {
      stripeCalls.push({ url: url.href, method, authorization: options.headers?.Authorization || '', version: options.headers?.['Stripe-Version'] || '' });
      // A read whose deadline passed never reaches Stripe (fetch rejects as it would on AbortSignal.timeout).
      if (options.signal?.aborted) throw options.signal.reason;
      if (failStripeReads && method === 'GET') return Response.json({ error: { message: 'synthetic Stripe outage' } }, { status: 500 });
      if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
        const params = new URLSearchParams(options.body), id = `cs_test_crew_${sessions.size + 1}`;
        sessions.set(id, { id, object: 'checkout.session', mode: params.get('mode'), status: 'open', payment_status: 'unpaid', currency: params.get('line_items[0][price_data][currency]'), amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), client_reference_id: params.get('client_reference_id'), metadata: Object.fromEntries([...params].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])), url: `https://checkout.stripe.com/c/pay/${id}` });
        return Response.json(sessions.get(id));
      }
      const session = sessions.get(url.pathname.split('/')[4]);
      if (!session) return Response.json({}, { status: 404 });
      if (method === 'POST' && url.pathname.endsWith('/expire')) { session.status = 'expired'; session.url = null; return Response.json(session); }
      // Only the expanded browser verification carries the charge receipt.
      return Response.json(url.searchParams.get('expand[]') === 'payment_intent.latest_charge' || !session.payment_intent ? session : { ...session, payment_intent: session.payment_intent.id });
    }
    if (url.hostname === 'hooks.example.invalid') { hooks.push(url.href); return Response.json({}); }
    throw new Error(`Unexpected request ${url.hostname}${url.pathname}`);
  });
  const crewCookie = (await createHubSessionCookie(environment, 'crew1')).split(';')[0];
  const webhook = stripeWebhookHandlers({ now: () => new Date(NOW) });
  const verifier = crewPayment.jobPaymentVerifier({ now: () => new Date(NOW) });
  let events = 0;
  const f = {
    docs, sessions, stripeCalls, hooks, commits,
    job: () => docs.get('jobs/job-1').value,
    jobPatches: () => jobPatches,
    edit: patch => { const row = docs.get('jobs/job-1'); row.value = { ...row.value, ...patch }; row.version++; },
    failJobWrites: value => { failJobWrites = value; }, failReads: value => { failReads = value; }, contend: writes => { contention = writes; },
    failReviewWrites: value => { failReviewWrites = value; }, loseReviewResponse: () => { loseReviewResponse = true; }, raceNextCommit: fn => { beforeCommit = fn; }, crewCookie,
    failStripeReads: value => { failStripeReads = value; }, beforeNextJobPatch: fn => { beforeJobPatch = fn; },
    async checkout(amountCents = 50000, key = 'synthetic-request') {
      const response = await crewPayment.onRequestPost({ env: environment, request: new Request(`${origin}/api/job-payment`, { method: 'POST', headers: { Cookie: crewCookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: 'job-1', request_id: key, amount_cents: amountCents }) }) });
      assert.equal(response.status, 200); return (await response.json()).sessionId;
    },
    complete: id => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', url: null, payment_intent: { id: `pi_${id}`, latest_charge: { receipt_url: `https://pay.stripe.com/receipts/${id}` } }, customer_details: { email: 'crew-customer@example.invalid' } }),
    // Stripe's webhook object carries the PaymentIntent ID, not the expanded charge.
    webhookObject: id => ({ ...sessions.get(id), payment_intent: sessions.get(id).payment_intent?.id || null }),
    async event(object, { type = 'checkout.session.completed', id = `evt_crew_${++events}`, signedAt = NOW, env: deliveryEnv = environment } = {}) {
      const timestamp = Math.floor(Date.parse(signedAt) / 1000), raw = JSON.stringify({ id, type, created: timestamp, data: { object } });
      const signature = createHmac('sha256', deliveryEnv.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
      return webhook.post({ env: deliveryEnv, request: new Request(`${origin}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body: raw }) });
    },
    verify: id => verifier({ env: environment, request: new Request(`${origin}/api/job-payment?session_id=${id}`, { headers: { Cookie: crewCookie, Origin: origin } }) }),
  };
  return f;
}

test('a crew card payment completed only through the webhook is recorded once', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  const first = await f.event(f.webhookObject(id), { id: 'evt_crew_completed' });
  assert.equal(first.status, 200); assert.deepEqual(await first.json(), { ok: true, received: true, recorded: true, duplicate: false });
  for (const [type, eventId] of [['checkout.session.completed', 'evt_crew_completed'], ['checkout.session.async_payment_succeeded', 'evt_crew_async']]) {
    const replay = await f.event(f.webhookObject(id), { type, id: eventId });
    assert.equal(replay.status, 200); assert.equal((await replay.json()).duplicate, true);
  }
  const job = f.job();
  assert.equal(f.jobPatches(), 1, 'replays and the async success event never write again');
  assert.equal(job.payment.amount, 500); assert.equal(job.payment.verified, true); assert.equal(job.payment.method, 'stripe'); assert.equal(job.payment.reference, `pi_${id}`);
  // The webhook payload has no charge, so the webhook reads the session (and its receipt) from Stripe first.
  assert.equal(job.payment.recordedBy, 'stripe_webhook'); assert.equal(job.payment.receiptUrl, `https://pay.stripe.com/receipts/${id}`);
  assert.ok(f.stripeCalls.some(call => new URL(call.url).pathname === `/v1/checkout/sessions/${id}` && new URL(call.url).searchParams.get('expand[]') === 'payment_intent.latest_charge' && call.method === 'GET'), 'the webhook reads the expanded charge');
  assert.deepEqual(job.payment.stripeSessions, [{ sessionId: id, paymentIntentId: `pi_${id}`, amount: 500, receiptEmail: 'crew-customer@example.invalid', createdBy: 'crew1', recordedBy: 'stripe_webhook', verifiedAt: NOW }]);
  assert.deepEqual({ paid: job.invoice.paid, balance: job.invoice.balance, status: job.invoice.status, amount: job.invoice.amount }, { paid: 500, balance: 500, status: 'partial', amount: 1000 });
  assert.deepEqual({ amount: job.deposit.amount, paidAmount: job.deposit.paidAmount, status: job.deposit.status, verified: job.deposit.verified }, { amount: 500, paidAmount: 500, status: 'paid', verified: true });
  assert.equal(job.paymentSyncStatus, 'pending'); assert.equal(job.paymentSyncPayload.sessionId, id); assert.equal(job.paymentSyncPayload.balance, 500);
  assert.deepEqual(f.hooks, [], 'a job payment is never announced as a membership');
});

test('a webhook replayed after browser verification causes no double count', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  const verified = await f.verify(id), body = await verified.json();
  assert.equal(verified.status, 200); assert.equal(body.paid, true); assert.equal(body.duplicate, false);
  assert.ok(f.stripeCalls.some(call => new URL(call.url).pathname === `/v1/checkout/sessions/${id}` && new URL(call.url).searchParams.get('expand[]') === 'payment_intent.latest_charge'), 'the browser return reads the expanded charge');
  // crew/postjob.html recordVerifiedStripePayment needs the recorded job copy.
  assert.equal(body.payment.amount, 500); assert.equal(body.payment.recordedBy, 'crew1'); assert.equal(body.invoice.balance, 500); assert.equal(body.paymentSyncPayload.sessionId, id);
  assert.equal(f.job().payment.receiptUrl, `https://pay.stripe.com/receipts/${id}`);
  const replay = await f.event(f.webhookObject(id));
  assert.equal(replay.status, 200); assert.equal((await replay.json()).duplicate, true);
  const again = await (await f.verify(id)).json();
  assert.equal(again.duplicate, true); assert.equal(again.payment.amount, 500); assert.equal(again.invoice.balance, 500); assert.equal(again.paymentSyncPayload.sessionId, id); assert.equal(again.paymentSyncPayload.paidTotal, 500);
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().payment.stripeSessions.length, 1); assert.equal(f.jobPatches(), 1);
});

test('the browser return after a webhook enriches the receipt without adding the payment again', async t => {
  const f = await fixture(t), id = await f.checkout(100000); f.complete(id);
  // Stripe has not issued the receipt yet when the webhook records the charge.
  const charge = f.sessions.get(id).payment_intent.latest_charge, receipt = charge.receipt_url; delete charge.receipt_url;
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  assert.equal(f.job().payment.receiptUrl, '');
  charge.receipt_url = receipt;
  const body = await (await f.verify(id)).json();
  assert.equal(body.duplicate, true); assert.equal(body.receiptUrl, `https://pay.stripe.com/receipts/${id}`); assert.equal(body.payment.receiptUrl, `https://pay.stripe.com/receipts/${id}`);
  assert.equal(body.invoice.status, 'paid'); assert.equal(body.paymentSyncPayload.sessionId, id);
  assert.equal(f.job().payment.amount, 1000); assert.equal(f.job().payment.stripeSessions.length, 1); assert.equal(f.job().payment.receiptUrl, `https://pay.stripe.com/receipts/${id}`);
});

test('wrong kind, currency or binding returns 409 without touching the job', async t => {
  const f = await fixture(t), id = await f.checkout(), open = await f.checkout(10000, 'second-link'); f.complete(id);
  assert.equal((await f.event(f.webhookObject(open))).status, 200, 'an unpaid session is acknowledged as processing');
  const paid = f.sessions.get(id);
  f.sessions.set('cs_test_portal_1', { ...paid, id: 'cs_test_portal_1', metadata: { ...paid.metadata, kind: 'egc_customer_portal_payment' } });
  assert.equal((await f.verify('cs_test_portal_1')).status, 409, 'a portal checkout cannot be settled as a crew payment');
  for (const changes of [{ currency: 'eur' }, { client_reference_id: 'job-2' }, { mode: 'subscription' }, { amount_total: 0 }]) {
    f.sessions.set(id, { ...paid, ...changes });
    assert.equal((await f.verify(id)).status, 409, JSON.stringify(changes));
    assert.equal((await f.event(f.webhookObject(id))).status, 409, JSON.stringify(changes));
  }
  assert.equal(f.jobPatches(), 0); assert.equal(f.job().payment, undefined); assert.equal(f.job().invoice, undefined);
  assert.deepEqual([...f.docs.keys()].filter(key => key.startsWith('payment_reviews/')), [], 'a session the Hub did not create is not a held charge');
});

test('a confirmed crew charge above the balance or behind an unverified receipt is held for manager review, never lost', async t => {
  const f = await fixture(t), id = await f.checkout(), second = await f.checkout(20000, 'second-link'); f.complete(id); f.complete(second);
  // A manager recorded a verified payment after the crew link opened: $500 exceeds the $300 balance.
  f.edit({ payment: { amount: 700, verified: true, method: 'check', stripeSessions: [] } });
  const before = structuredClone(f.job());
  const over = await f.event(f.webhookObject(id), { id: 'evt_crew_over' });
  assert.equal(over.status, 200, 'Stripe stops retrying once the charge is durably held');
  assert.deepEqual(await over.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_exceeds_balance' });
  assert.deepEqual(f.docs.get(`payment_reviews/${id}`), { version: 1, value: {
    sessionId: id, jobId: 'job-1', kind: 'egc_job_payment', reason: 'payment_exceeds_balance', status: 'open', amountCents: 50000, currency: 'usd', paymentIntentId: `pi_${id}`, livemode: false,
    jobRevision: '2026-09-22T00:00:00.000002Z', jobTotalCents: 100000, jobPaidCents: 70000, jobBalanceCents: 30000, createdBy: 'crew1', recordedBy: 'stripe_webhook', createdAt: NOW } });
  assert.deepEqual(f.job(), before, 'the job money state is unchanged'); assert.equal(f.jobPatches(), 0);
  // Replays and the crew return find the same held record; the first record wins and is never rewritten.
  assert.equal((await f.event(f.webhookObject(id), { id: 'evt_crew_over' })).status, 200);
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.equal(crewReturn.status, 409); assert.deepEqual({ code: body.code, held: body.reviewRecorded }, { code: 'payment_exceeds_balance', held: true }); assert.match(body.error, /saved for manager review\. Do not charge again/);
  assert.equal(f.docs.get(`payment_reviews/${id}`).version, 1); assert.equal(f.docs.get(`payment_reviews/${id}`).value.recordedBy, 'stripe_webhook');
  // An unverified crew receipt blocks another card record the same way.
  f.edit({ payment: { amount: 200, verified: false } });
  const blocked = await f.event(f.webhookObject(second));
  assert.equal(blocked.status, 200); assert.equal((await blocked.json()).reason, 'payment_needs_review');
  assert.deepEqual({ reason: f.docs.get(`payment_reviews/${second}`).value.reason, amount: f.docs.get(`payment_reviews/${second}`).value.amountCents, paid: f.docs.get(`payment_reviews/${second}`).value.jobPaidCents }, { reason: 'payment_needs_review', amount: 20000, paid: 20000 });
  assert.equal(f.jobPatches(), 0); assert.equal(f.job().payment.amount, 200); assert.equal(f.job().invoice, undefined);
  assert.deepEqual(f.hooks, [], 'a held job payment is never announced as a membership');
});

test('a held charge is acknowledged only once its review record is durable', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  f.edit({ payment: { amount: 700, verified: true, method: 'check', stripeSessions: [] } });
  f.failReviewWrites(true);
  const failed = await f.event(f.webhookObject(id));
  assert.equal(failed.status, 503, 'Stripe keeps retrying until the charge is recorded somewhere'); assert.equal(f.docs.get(`payment_reviews/${id}`), undefined);
  assert.equal((await f.verify(id)).status, 503, 'the crew return reports the outage too');
  f.failReviewWrites(false); f.loseReviewResponse();
  const lost = await f.event(f.webhookObject(id));
  assert.equal(lost.status, 200, 'a create whose response was lost is confirmed by reading it back');
  assert.equal(f.docs.get(`payment_reviews/${id}`).value.reason, 'payment_exceeds_balance'); assert.equal(f.jobPatches(), 0); assert.equal(f.job().payment.amount, 700);
});

test('managers see held charges, and whether the session has since reached the job', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  f.edit({ payment: { amount: 700, verified: true, method: 'check', stripeSessions: [] } });
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  const reviews = stripeReviewHandlers({ now: () => new Date(NOW) });
  const get = (cookie = '', query = '') => reviews.get({ env, request: new Request(`${origin}/api/stripe-reviews${query}`, { headers: cookie ? { Cookie: cookie } : {} }) });
  assert.equal((await get()).status, 401); assert.equal((await get(f.crewCookie)).status, 403, 'crew never see held charges');
  const manager = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const response = await get(manager), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual({ counts: body.counts, coverage: body.coverage, memberships: body.membershipReviews }, { counts: { paymentReviews: 1, membershipReviews: 0 }, coverage: { complete: true, asOf: NOW }, memberships: [] });
  // revision is the review's Firestore updateTime; resolving a review in the Hub is revision-checked against it.
  assert.deepEqual(body.paymentReviews, [{ sessionId: id, reviewId: id, revision: '2026-09-22T00:00:00.000001Z', jobId: 'job-1', reason: 'payment_exceeds_balance', status: 'open', amountCents: 50000, tipCents: 0, serviceCents: 50000, currency: 'usd', paymentIntentId: `pi_${id}`, livemode: false,
    jobTotalCents: 100000, jobPaidCents: 70000, jobBalanceCents: 30000, createdBy: 'crew1', recordedBy: 'stripe_webhook', createdAt: NOW, customer: 'Synthetic Crew Customer', jobFound: true, recordedOnJob: false }]);
  // The manager corrects the earlier record; the crew return now applies the session, and the review shows it.
  f.edit({ payment: { amount: 200, verified: true, method: 'check', stripeSessions: [] } });
  assert.equal((await f.verify(id)).status, 200);
  // The job and a mark on the still-open review land in one commit, fenced by the review's revision.
  assert.deepEqual(f.commits, [['jobs/job-1', `payment_reviews/${id}`]]);
  assert.deepEqual([f.docs.get(`payment_reviews/${id}`).value.status, f.docs.get(`payment_reviews/${id}`).value.jobRecordedAt, f.docs.get(`payment_reviews/${id}`).value.jobRecordedBy], ['open', NOW, 'crew1']);
  assert.equal(f.job().payment.amount, 700);
  assert.equal((await (await get(manager)).json()).paymentReviews[0].recordedOnJob, true, 'a session already on the job is never applied twice');
  assert.equal((await get(manager, '?status=all')).status, 400);
  f.failReads(true);
  const outage = await get(manager);
  assert.equal(outage.status, 503); assert.equal((await outage.json()).code, 'stripe_review_storage_unavailable', 'an unreadable ledger is never shown as empty');
});

// Held $500 on a $1,000 job whose $700 check was recorded after the link opened.
async function heldCharge(t) {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  f.edit({ payment: { amount: 700, verified: true, method: 'check', stripeSessions: [] } });
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  assert.equal(f.docs.get(`payment_reviews/${id}`).value.status, 'open');
  return { f, id };
}
const ownerActor = { user: 'zacb', role: 'owner', businessAccess: true };
const managerActor = { user: 'tylerg', role: 'manager', businessAccess: true };
async function resolveHeld(f, id, action, extra, actor = ownerActor) {
  const saved = f.docs.get(`payment_reviews/${id}`), revision = `2026-09-22T00:00:00.${String(saved.version).padStart(6, '0')}Z`;
  const input = { action, requestId: randomUUID(), reviewId: id, expectedRevision: revision, ...extra };
  return resolveStripeReview(stripeReviewStorage(env), actor, input, NOW, { stripe: stripeReviewClient(env) });
}
const audits = f => [...f.docs].filter(([key]) => key.startsWith('hub_audit/')).map(([, row]) => row.value);

for (const [label, action, extra, refund] of [
  ['refunded in Stripe', 'payment.refund', { reason: 'exceeds_balance' }, true],
  ['reconciled as applied to another job', 'payment.reconcile', { note: 'Applied to the customer’s other job' }, false],
]) {
  test(`a held charge the office ${label} never reaches the job, even after the job balance allows it`, async t => {
    const { f, id } = await heldCharge(t);
    if (refund) f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 50000;
    const resolved = await resolveHeld(f, id, action, extra);
    assert.equal(resolved.review.status, 'resolved');
    // The manager corrects the earlier record, so the $500 now fits the balance.
    f.edit({ payment: { amount: 200, verified: true, method: 'check', stripeSessions: [] } });
    const before = structuredClone(f.job()), patches = f.jobPatches();
    const crewReturn = await f.verify(id), body = await crewReturn.json();
    assert.equal(crewReturn.status, 409);
    assert.deepEqual([body.code, body.reviewRecorded], ['payment_review_resolved', true]);
    assert.match(body.error, /already resolved this Stripe charge.*Do not charge again/);
    // A webhook retry stops at 200 without recording anything; nothing is queued, so it never says a review is required.
    const retry = await f.event(f.webhookObject(id));
    assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), { ok: true, received: true, recorded: false, reviewRequired: false, reason: 'payment_review_resolved' });
    assert.deepEqual(f.job(), before, 'job.payment is unchanged'); assert.equal(f.jobPatches(), patches);
    assert.equal(f.job().payment.amount, 200); assert.deepEqual(f.job().payment.stripeSessions, []);
    assert.equal(f.docs.get(`payment_reviews/${id}`).value.status, 'resolved');
  });
}

test('a charge Stripe shows refunded is held for review on the crew return, and a later webhook never applies it', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 20000;
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.equal(crewReturn.status, 409); assert.deepEqual([body.code, body.reviewRecorded], ['payment_refunded', true]);
  assert.deepEqual([f.docs.get(`payment_reviews/${id}`).value.reason, f.docs.get(`payment_reviews/${id}`).value.status, f.docs.get(`payment_reviews/${id}`).value.recordedBy], ['payment_refunded', 'open', 'crew1']);
  // The webhook payload carries no charge, but the open refund review keeps the money off the job.
  const webhook = await f.event(f.webhookObject(id));
  assert.equal(webhook.status, 200); assert.equal((await webhook.json()).reason, 'payment_refunded');
  assert.equal(f.job().payment, undefined); assert.equal(f.jobPatches(), 0);
});

test('a review resolved while the crew return is applying the held charge wins; the job is never written', async t => {
  const { f, id } = await heldCharge(t);
  f.edit({ payment: { amount: 200, verified: true, method: 'check', stripeSessions: [] } });
  const before = structuredClone(f.job());
  // The owner resolves the review between the crew return's read and its commit.
  f.raceNextCommit(() => { const row = f.docs.get(`payment_reviews/${id}`); row.value = { ...row.value, status: 'resolved', resolution: 'reconciled' }; row.version++; });
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.equal(crewReturn.status, 409); assert.equal(body.code, 'payment_review_resolved');
  assert.deepEqual(f.job(), before); assert.equal(f.jobPatches(), 0); assert.deepEqual(f.commits, []);
});

test('a review the job cannot be checked against fails closed', async t => {
  const { f, id } = await heldCharge(t);
  f.edit({ payment: { amount: 200, verified: true, method: 'check', stripeSessions: [] } });
  f.docs.get(`payment_reviews/${id}`).value.sessionId = 'cs_test_other';
  assert.equal((await f.verify(id)).status, 503);
  assert.equal((await f.event(f.webhookObject(id))).status, 503, 'Stripe retries until the review can be read');
  assert.equal(f.job().payment.amount, 200); assert.equal(f.jobPatches(), 0);
});

test('a held charge Stripe shows refunded is marked refunded by the crew return, and a webhook redelivery never applies it after the job is corrected', async t => {
  const { f, id } = await heldCharge(t);
  Object.assign(f.sessions.get(id).payment_intent.latest_charge, { amount_refunded: 50000, refunded: true });
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.equal(crewReturn.status, 409); assert.deepEqual([body.code, body.reviewRecorded], ['payment_refunded', true]);
  const review = f.docs.get(`payment_reviews/${id}`);
  assert.deepEqual([review.value.status, review.value.reason, review.value.heldReason, review.value.refundedCents, review.value.refundSeenAt, review.value.recordedBy], ['open', 'payment_refunded', 'payment_exceeds_balance', 50000, NOW, 'stripe_webhook'], 'the queue shows the refund the crew return saw');
  assert.equal(review.version, 2, 'one update, made under the revision that was read');
  // The manager corrects the earlier record, so the $500 would now fit the balance.
  f.edit({ payment: { amount: 200, verified: true, method: 'check', stripeSessions: [] } });
  const before = structuredClone(f.job()), patches = f.jobPatches();
  const redelivery = await f.event(f.webhookObject(id));
  assert.equal(redelivery.status, 200, 'Stripe stops retrying');
  assert.deepEqual(await redelivery.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.deepEqual(f.job(), before, 'job.payment is unchanged'); assert.equal(f.jobPatches(), patches); assert.deepEqual(f.commits, []);
  assert.equal(f.job().payment.amount, 200); assert.deepEqual(f.job().payment.stripeSessions, []);
  // Another crew return finds the review already showing the refund and writes nothing.
  assert.equal((await f.verify(id)).status, 409); assert.equal(f.docs.get(`payment_reviews/${id}`).version, 2);
  assert.deepEqual(f.job(), before);
});

test('a webhook never settles a charge that has an open review; the crew return, which reads the charge, applies it once the job allows', async t => {
  const { f, id } = await heldCharge(t);
  f.edit({ payment: { amount: 200, verified: true, method: 'check', stripeSessions: [] } });
  const before = structuredClone(f.job());
  const redelivery = await f.event(f.webhookObject(id));
  assert.equal(redelivery.status, 200);
  assert.deepEqual(await redelivery.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_exceeds_balance' });
  assert.deepEqual(f.job(), before); assert.equal(f.jobPatches(), 0); assert.equal(f.docs.get(`payment_reviews/${id}`).version, 1, 'the review is not rewritten');
  const crewReturn = await f.verify(id);
  assert.equal(crewReturn.status, 200);
  assert.deepEqual(f.commits, [['jobs/job-1', `payment_reviews/${id}`]], 'the job and the mark on the open review in one commit');
  assert.equal(f.job().payment.amount, 700);
});

test('a partly refunded held charge is recorded only once the owner confirms the exact amount kept, which is saved and stays off the job', async t => {
  const { f, id } = await heldCharge(t);
  // The owner refunds the $200 above the $300 balance in Stripe.
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 20000;
  const partial = error => error.code === 'stripe_review_refund_partial' && error.status === 409 && JSON.stringify(error.details) === JSON.stringify({ amountCents: 50000, refundedCents: 20000, keptCents: 30000 })
    && /Stripe shows \$200\.00 of \$500\.00 refunded\. The \$300\.00 kept is not on the job/.test(error.message) && /Estimates & payments/.test(error.message);
  await assert.rejects(resolveHeld(f, id, 'payment.refund', { reason: 'exceeds_balance' }), partial);
  await assert.rejects(resolveHeld(f, id, 'payment.refund', { reason: 'exceeds_balance', keptCentsAcknowledged: 20000 }), partial, 'the refunded amount is not the amount kept');
  assert.equal(f.docs.get(`payment_reviews/${id}`).value.status, 'open'); assert.deepEqual(audits(f), [], 'nothing is saved before the confirmation');
  const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'exceeds_balance', keptCentsAcknowledged: 30000, note: 'Refunded the excess over the balance' });
  assert.deepEqual([resolved.review.resolution, resolved.review.refundedCents, resolved.review.refundFull, resolved.review.keptCents, resolved.review.recordedOnJobAtResolution], ['refunded', 20000, false, 30000, false]);
  assert.deepEqual([f.docs.get(`payment_reviews/${id}`).value.keptCents, f.docs.get(`payment_reviews/${id}`).value.refundFull], [30000, false]);
  const [audit] = audits(f);
  assert.deepEqual([audit.visibility, audit.reason], ['owner', 'More than the job balance: Refunded the excess over the balance (Stripe shows $200.00 of $500.00 refunded; the $300.00 kept is not on the job)']);
  assert.equal(JSON.parse(audit.after).keptCents, 30000);
  // The review is final: the $300 kept is recorded on the job by a person, never by the crew return or a webhook.
  const crewReturn = await f.verify(id);
  assert.equal(crewReturn.status, 409); assert.equal((await crewReturn.json()).code, 'payment_review_resolved');
  assert.equal(f.job().payment.amount, 700); assert.deepEqual(f.job().payment.stripeSessions, []);
});

test('only the owner settles a charge Stripe shows refunded: a manager cannot close it as reconciled', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 50000;
  assert.equal((await f.verify(id)).status, 409);
  const stripeCalls = f.stripeCalls.length;
  await assert.rejects(resolveHeld(f, id, 'payment.reconcile', { note: 'Refunded the full charge in Stripe' }, managerActor), error => error.code === 'stripe_review_owner_required' && error.status === 403);
  assert.equal(f.docs.get(`payment_reviews/${id}`).value.status, 'open'); assert.deepEqual(f.commits, []); assert.deepEqual(audits(f), []);
  assert.equal(f.stripeCalls.length, stripeCalls, 'Stripe is not asked for a refused reconcile');
  const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request' });
  assert.deepEqual([resolved.review.resolution, resolved.review.refundFull, resolved.review.keptCents], ['refunded', true, 0]);
});

test('a charge put on the job while the owner records its refund makes the save a conflict, and the re-run sees it on the job', async t => {
  const { f, id } = await heldCharge(t);
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 50000;
  // A delivery that read no review yet puts the charge on the job between the owner's job read and the commit.
  f.raceNextCommit(() => f.edit({ payment: { amount: 1200, verified: true, method: 'stripe', stripeSessions: [{ sessionId: id, amount: 500 }] } }));
  await assert.rejects(resolveHeld(f, id, 'payment.refund', { reason: 'duplicate_charge' }), error => error.code === 'dispatch_revision_conflict' && error.status === 409);
  assert.equal(f.docs.get(`payment_reviews/${id}`).value.status, 'open', 'nothing was saved'); assert.deepEqual(audits(f), []);
  // Re-run against the current job: the charge is on it now, so the owner must acknowledge the job correction.
  await assert.rejects(resolveHeld(f, id, 'payment.refund', { reason: 'duplicate_charge' }), error => error.code === 'stripe_review_refund_on_job');
  const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'duplicate_charge', jobPaymentAcknowledged: true });
  assert.deepEqual([resolved.review.resolution, resolved.review.recordedOnJobAtResolution], ['refunded', true]);
  assert.equal(JSON.parse(audits(f)[0].after).recordedOnJobAtResolution, true);
});

test('a storage failure returns 503 and the retry records the payment once', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  f.failJobWrites(true);
  const failed = await f.event(f.webhookObject(id));
  assert.equal(failed.status, 503); assert.equal((await failed.json()).error, 'Payment recording needs retry'); assert.equal(f.job().payment, undefined);
  assert.equal((await f.verify(id)).status, 503, 'the browser return reports a retryable outage, not a conflict');
  f.failJobWrites(false); f.failReads(true);
  assert.equal((await f.event(f.webhookObject(id))).status, 503);
  f.failReads(false);
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  assert.equal((await (await f.event(f.webhookObject(id))).json()).duplicate, true);
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().payment.stripeSessions.length, 1); assert.equal(f.jobPatches(), 1);
});

test('stale job revisions retry from a fresh read and report a conflict, not an outage', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  f.contend(3);
  const busy = await f.verify(id);
  assert.equal(busy.status, 409); assert.equal((await busy.json()).error, 'The payment record changed. Refresh to confirm the latest balance.');
  f.contend(3);
  assert.equal((await f.event(f.webhookObject(id))).status, 503, 'Stripe retries a contended record later');
  assert.equal(f.job().payment, undefined);
  f.contend(2);
  assert.equal((await f.event(f.webhookObject(id))).status, 200, 'the third attempt records on the fresh revision');
  assert.equal(f.job().payment.amount, 500); assert.equal(f.jobPatches(), 1);
});

test('concurrent webhook and browser verification record a crew charge exactly once', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  const responses = await Promise.all([f.event(f.webhookObject(id)), f.verify(id), f.event(f.webhookObject(id))]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().payment.stripeSessions.length, 1); assert.equal(f.job().invoice.balance, 500);
});

test('webhook signatures are checked against the injected clock', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  assert.equal((await f.event(f.webhookObject(id), { signedAt: '2026-09-22T11:50:00.000Z' })).status, 400);
  assert.equal(f.job().payment, undefined);
});

test('restricted rk_ keys are accepted consistently and publishable keys are not', async t => {
  assert.equal(stripeSecretKey({ STRIPE_SECRET_KEY: 'rk_live_Synthetic123' }), 'rk_live_Synthetic123');
  assert.equal(stripeSecretKey({ stripe_secret: ' sk_test_Synthetic_456 ' }), 'sk_test_Synthetic_456');
  for (const key of ['pk_live_Synthetic123', 'whsec_Synthetic', 'rk_Synthetic', '']) assert.equal(stripeSecretKey({ STRIPE_SECRET_KEY: key }), '', key);
  const restricted = { ...env, STRIPE_SECRET_KEY: 'rk_test_synthetic_restricted' };
  const f = await fixture(t, {}, restricted), id = await f.checkout(); f.complete(id);
  assert.equal((await f.verify(id)).status, 200);
  assert.ok(f.stripeCalls.length >= 2 && f.stripeCalls.every(call => call.authorization === `Basic ${btoa('rk_test_synthetic_restricted:')}`));
  f.docs.set('jobs/portal-job', { value: { type: 'job', customer: 'Synthetic Portal Customer', total: 1000, status: 'scheduled', estimate: { status: 'accepted', amount: 1000, revision: 1, depositRequired: 500 } }, version: 1 });
  const cookie = (await createCustomerPortalSessionCookie(restricted, 'portal-job', { linkVersion: 0 })).split(';')[0];
  const portalPay = await portal.onRequestPost({ env: restricted, request: new Request(`${origin}/api/customer-portal`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create_payment', request_id: 'synthetic-portal-rk' }) }) });
  assert.equal(portalPay.status, 200); assert.match((await portalPay.json()).url, /^https:\/\/checkout\.stripe\.com\//);
  const publishable = await crewPayment.onRequestPost({ env: { ...env, STRIPE_SECRET_KEY: 'pk_live_synthetic' }, request: new Request(`${origin}/api/job-payment`, { method: 'POST', headers: { Cookie: (await createHubSessionCookie(env, 'crew1')).split(';')[0], Origin: origin }, body: '{}' }) });
  assert.equal(publishable.status, 501);
});

// ---- Refunds are seen by every recording path (the webhook reads the charge from Stripe), for crew and portal charges ----

for (const [label, refunded, full] of [['fully', 50000, true], ['partly', 20000, false]]) {
  test(`a crew charge ${label} refunded before the first successful webhook never reaches the job: the webhook reads the refund and holds it for the owner`, async t => {
    const f = await fixture(t), id = await f.checkout(); f.complete(id);
    // The first deliveries land while Stripe cannot be read (no key, then an outage): Stripe retries, nothing is written.
    const noKey = await f.event(f.webhookObject(id), { env: { ...env, STRIPE_SECRET_KEY: '' } });
    assert.equal(noKey.status, 503);
    f.failStripeReads(true);
    const outage = await f.event(f.webhookObject(id));
    assert.equal(outage.status, 503); assert.equal(f.job().payment, undefined); assert.equal(f.docs.get(`payment_reviews/${id}`), undefined);
    f.failStripeReads(false);
    // Meanwhile the office refunded the charge in Stripe (and collected another way).
    Object.assign(f.sessions.get(id).payment_intent.latest_charge, { amount_refunded: refunded, refunded: full });
    const retry = await f.event(f.webhookObject(id));
    assert.equal(retry.status, 200, 'the held charge is durable, so Stripe stops retrying');
    assert.deepEqual(await retry.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
    assert.equal(f.job().payment, undefined); assert.equal(f.job().invoice, undefined); assert.equal(f.jobPatches(), 0);
    const review = f.docs.get(`payment_reviews/${id}`).value;
    assert.deepEqual([review.status, review.reason, review.kind, review.amountCents, review.refundedCents, review.refundSeenAt, review.recordedBy, review.createdBy], ['open', 'payment_refunded', 'egc_job_payment', 50000, refunded, NOW, 'stripe_webhook', 'crew1']);
    // The crew return finds the same review, never a paid duplicate, and writes nothing.
    const crewReturn = await f.verify(id), body = await crewReturn.json();
    assert.equal(crewReturn.status, 409); assert.deepEqual([body.code, body.reviewRecorded, body.paid], ['payment_refunded', true, undefined]);
    assert.equal(f.docs.get(`payment_reviews/${id}`).version, 1); assert.equal(f.job().payment, undefined);
  });
}

test('a refund Stripe shows after a crew charge is on the job opens a review for the owner instead of a silent paid duplicate', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  const before = structuredClone(f.job()), patches = f.jobPatches();
  assert.equal(before.payment.amount, 500);
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 20000;
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.equal(crewReturn.status, 409);
  assert.deepEqual([body.code, body.reviewRecorded, body.paid, body.duplicate], ['payment_refunded', true, undefined, undefined]);
  assert.match(body.error, /already counts as paid.*Do not charge again/);
  const review = f.docs.get(`payment_reviews/${id}`);
  assert.deepEqual([review.value.status, review.value.reason, review.value.refundedCents, review.value.recordedBy, review.value.jobPaidCents, review.value.refundSeenAt], ['open', 'payment_refunded', 20000, 'crew1', 50000, NOW]);
  assert.deepEqual(f.job(), before, 'the job is left exactly as it was'); assert.equal(f.jobPatches(), patches);
  // The owner sees it in Review queues as a refunded charge that is already on the job.
  const owner = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const [row] = (await (await stripeReviewHandlers({ now: () => new Date(NOW) }).get({ env, request: new Request(`${origin}/api/stripe-reviews`, { headers: { Cookie: owner } }) })).json()).paymentReviews;
  assert.deepEqual([row.sessionId, row.reason, row.refundedCents, row.keptCents, row.recordedOnJob], [id, 'payment_refunded', 20000, 30000, true]);
  // A webhook redelivery finds the same review; a larger refund later updates it under its revision.
  const redelivery = await f.event(f.webhookObject(id));
  assert.equal(redelivery.status, 200); assert.deepEqual(await redelivery.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.equal(f.docs.get(`payment_reviews/${id}`).version, 1, 'the review is not rewritten');
  Object.assign(f.sessions.get(id).payment_intent.latest_charge, { amount_refunded: 50000, refunded: true });
  assert.equal((await f.verify(id)).status, 409);
  assert.deepEqual([f.docs.get(`payment_reviews/${id}`).version, f.docs.get(`payment_reviews/${id}`).value.refundedCents], [2, 50000]);
  assert.deepEqual(f.job(), before);
  // Mark reconciled is refused; the owner records the refund with the job acknowledgement.
  await assert.rejects(resolveHeld(f, id, 'payment.reconcile', { note: 'Refunded' }), error => error.code === 'stripe_review_refund_shown' && error.details.recordedOnJob === true && /confirms the job correction/.test(error.message));
  const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  assert.deepEqual([resolved.review.resolution, resolved.review.recordedOnJobAtResolution], ['refunded', true]);
  // Later returns still never answer a paid duplicate: they say the office resolved it.
  const after = await f.verify(id), afterBody = await after.json();
  assert.deepEqual([after.status, afterBody.code, afterBody.reviewRecorded], [409, 'payment_review_resolved', true]); assert.match(afterBody.error, /office already resolved it/);
  assert.equal(f.job().payment.amount, 500, 'the owner corrects the job payment by hand');
});

test('a crew return that read the job before the owner recorded the refund, and writes after that commit, fails its revision check and finds the review resolved', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  // The crew return has read the charge (no refund yet), the job and "no review". Before its job write reaches
  // Firestore, the office refunds the charge, a webhook holds it, and the owner records the refund.
  f.beforeNextJobPatch(async () => {
    Object.assign(f.sessions.get(id).payment_intent.latest_charge, { amount_refunded: 50000, refunded: true });
    assert.equal((await (await f.event(f.webhookObject(id))).json()).reason, 'payment_refunded');
    const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request' });
    assert.deepEqual([resolved.review.status, resolved.review.recordedOnJobAtResolution], ['resolved', false]);
    assert.equal(f.job().paymentReviewResolvedAt, NOW, 'the resolution wrote its marker on the job at the revision it read');
  });
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.equal(crewReturn.status, 409); assert.deepEqual([body.code, body.reviewRecorded], ['payment_review_resolved', true]);
  assert.equal(f.job().payment, undefined, 'the late write failed its revision check, so the refunded charge never reached the job');
  assert.equal(f.jobPatches(), 1, 'the only job write is the resolution marker'); assert.equal(f.docs.get(`payment_reviews/${id}`).value.resolution, 'refunded');
});

test('Mark reconciled checks Stripe: a charge Stripe shows refunded is never reconciled, whether or not a crew return saw the refund', async t => {
  const { f, id } = await heldCharge(t);
  // Held because it exceeded the balance; the owner then refunded the $200 excess in Stripe. No crew return ran.
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 20000;
  const calls = f.stripeCalls.length;
  await assert.rejects(resolveHeld(f, id, 'payment.reconcile', { note: 'Handled' }, managerActor), error => error.code === 'stripe_review_owner_required' && error.status === 403);
  assert.equal(f.stripeCalls.length, calls + 1, 'the manager reconcile checked the charge in Stripe');
  const shown = error => error.code === 'stripe_review_refund_shown' && error.status === 409 && JSON.stringify(error.details) === JSON.stringify({ amountCents: 50000, refundedCents: 20000, keptCents: 30000, recordedOnJob: false })
    && /Stripe shows \$200\.00 of \$500\.00 refunded/.test(error.message) && /confirms the \$300\.00 kept/.test(error.message);
  await assert.rejects(resolveHeld(f, id, 'payment.reconcile', { note: 'Refunded the excess' }), shown);
  await assert.rejects(resolveHeld(f, id, 'payment.reconcile', { note: 'Refunded the excess', keptCentsAcknowledged: 30000 }), error => error.code === 'stripe_review_request_invalid', 'the amount kept is confirmed only by recording the refund');
  // After a crew return marks it refunded, a manager is refused without asking Stripe, and the owner is still sent to Record refund.
  assert.equal((await f.verify(id)).status, 409); assert.equal(f.docs.get(`payment_reviews/${id}`).value.reason, 'payment_refunded');
  const before = f.stripeCalls.length;
  await assert.rejects(resolveHeld(f, id, 'payment.reconcile', { note: 'Handled' }, managerActor), error => error.code === 'stripe_review_owner_required' && error.status === 403);
  assert.equal(f.stripeCalls.length, before);
  await assert.rejects(resolveHeld(f, id, 'payment.reconcile', { note: 'Refunded the excess' }), shown);
  assert.equal(f.docs.get(`payment_reviews/${id}`).value.status, 'open'); assert.deepEqual(audits(f), []); assert.equal(f.job().paymentReviewResolvedAt, undefined);
  const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'exceeds_balance', keptCentsAcknowledged: 30000 });
  assert.deepEqual([resolved.review.resolution, resolved.review.keptCents, audits(f)[0].visibility], ['refunded', 30000, 'owner']);
});

// A $500 portal deposit on a $1,000 job, paid in Stripe; the portal handlers run on the injected clock.
async function portalPayment(t, environment = env) {
  const f = await fixture(t, {}, environment);
  f.docs.set('jobs/portal-job', { value: { type: 'job', customer: 'Synthetic Portal Customer', email: 'portal-customer@example.invalid', total: 1000, status: 'scheduled', estimate: { status: 'accepted', amount: 1000, revision: 1, depositRequired: 500 } }, version: 1 });
  const cookie = (await createCustomerPortalSessionCookie(environment, 'portal-job', { linkVersion: 0 }, Date.parse(NOW))).split(';')[0];
  const handlers = portal.createCustomerPortalHandlers({ now: () => new Date(NOW) });
  const call = async body => {
    const response = await handlers.onRequestPost({ env: environment, request: new Request(`${origin}/api/customer-portal`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const created = await call({ action: 'create_payment', request_id: 'synthetic-portal-1' });
  assert.equal(created.status, 200); assert.equal(created.body.amount, 500);
  const id = [...f.sessions.keys()].at(-1); f.complete(id);
  return { f, id, call, job: () => f.docs.get('jobs/portal-job').value };
}
const posts = f => f.stripeCalls.filter(call => call.method === 'POST' && new URL(call.url).pathname === '/v1/checkout/sessions').length;

test('a portal payment Stripe shows refunded is held on the portal return, never recorded as paid, and nothing new can be paid until the owner resolves it', async t => {
  const { f, id, call, job } = await portalPayment(t);
  Object.assign(f.sessions.get(id).payment_intent.latest_charge, { amount_refunded: 50000, refunded: true });
  const verified = await call({ action: 'verify_payment', session_id: id });
  assert.equal(verified.status, 409);
  assert.deepEqual([verified.body.code, verified.body.reviewRecorded, verified.body.paid], ['payment_refunded', true, undefined]);
  assert.match(verified.body.error, /held for our team to review\. Please do not pay again/);
  assert.equal(job().payment, undefined);
  const review = f.docs.get(`payment_reviews/${id}`).value;
  assert.deepEqual([review.kind, review.reason, review.status, review.jobId, review.amountCents, review.refundedCents, review.createdBy, review.recordedBy, review.refundSeenAt, review.createdAt],
    ['egc_customer_portal_payment', 'payment_refunded', 'open', 'portal-job', 50000, 50000, 'customer_portal', 'customer_portal', NOW, NOW]);
  // Paying again reuses the completed checkout, which is held: no new Stripe session.
  const created = posts(f), again = await call({ action: 'create_payment', request_id: 'synthetic-portal-2' });
  assert.deepEqual([again.status, again.body.code], [409, 'payment_refunded']); assert.match(again.body.error, /Please do not pay again/);
  assert.equal(posts(f), created);
  // The portal webhook finds the same review and is acknowledged.
  const delivered = await f.event(f.webhookObject(id));
  assert.equal(delivered.status, 200); assert.deepEqual(await delivered.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.equal(f.docs.get(`payment_reviews/${id}`).version, 1); assert.equal(job().payment, undefined);
  // The owner sees it in Review queues and records the refund, checked against Stripe.
  const owner = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const [row] = (await (await stripeReviewHandlers({ now: () => new Date(NOW) }).get({ env, request: new Request(`${origin}/api/stripe-reviews`, { headers: { Cookie: owner } }) })).json()).paymentReviews;
  assert.deepEqual([row.sessionId, row.jobId, row.reason, row.refundedCents, row.createdBy, row.customer, row.recordedOnJob], [id, 'portal-job', 'payment_refunded', 50000, 'customer_portal', 'Synthetic Portal Customer', false]);
  const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request' });
  assert.deepEqual([resolved.review.resolution, resolved.review.refundFull, resolved.review.keptCents], ['refunded', true, 0]);
  // Resolved: the old checkout never reaches the job, and the customer can pay the deposit with a new checkout.
  const late = await call({ action: 'verify_payment', session_id: id });
  assert.deepEqual([late.status, late.body.code], [409, 'payment_review_resolved']); assert.match(late.body.error, /already reviewed this payment/);
  const reopened = await call({ action: 'create_payment', request_id: 'synthetic-portal-3' });
  assert.equal(reopened.status, 200); assert.equal(reopened.body.amount, 500); assert.match(reopened.body.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(posts(f), created + 1); assert.equal(f.docs.get('customer_payment_checkouts/portal-job').value.sessionId, [...f.sessions.keys()].at(-1));
  assert.equal(job().payment, undefined);
});

test('a portal payment Stripe shows partly refunded is held by the webhook, never recorded as fully paid, and settled only with the amount kept confirmed', async t => {
  const { f, id, job } = await portalPayment(t);
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 20000;
  const delivered = await f.event(f.webhookObject(id));
  assert.equal(delivered.status, 200); assert.deepEqual(await delivered.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.equal(job().payment, undefined, 'a partly refunded $500 is never recorded as $500 paid');
  const review = f.docs.get(`payment_reviews/${id}`).value;
  assert.deepEqual([review.kind, review.reason, review.refundedCents, review.recordedBy], ['egc_customer_portal_payment', 'payment_refunded', 20000, 'stripe_webhook']);
  await assert.rejects(resolveHeld(f, id, 'payment.refund', { reason: 'customer_request' }), error => error.code === 'stripe_review_refund_partial' && error.details.keptCents === 30000);
  await assert.rejects(resolveHeld(f, id, 'payment.reconcile', { note: 'Kept part of it' }), error => error.code === 'stripe_review_refund_shown');
  const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request', keptCentsAcknowledged: 30000 });
  assert.deepEqual([resolved.review.resolution, resolved.review.refundedCents, resolved.review.keptCents], ['refunded', 20000, 30000]);
  assert.equal(job().payment, undefined); assert.equal(job().paymentReviewResolvedAt, NOW);
});

test('a refund Stripe shows after a portal payment was recorded opens a review on the next return, and the job is left as it is', async t => {
  const { f, id, call, job } = await portalPayment(t);
  const paid = await call({ action: 'verify_payment', session_id: id });
  assert.deepEqual([paid.status, paid.body.paid, paid.body.duplicate], [200, true, false]); assert.equal(job().payment.amount, 500);
  const before = structuredClone(job());
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 50000;
  const refunded = await call({ action: 'verify_payment', session_id: id });
  assert.deepEqual([refunded.status, refunded.body.code, refunded.body.paid], [409, 'payment_refunded', undefined]);
  assert.deepEqual(job(), before);
  assert.deepEqual([f.docs.get(`payment_reviews/${id}`).value.reason, f.docs.get(`payment_reviews/${id}`).value.jobPaidCents], ['payment_refunded', 50000]);
  const delivered = await f.event(f.webhookObject(id));
  assert.equal(delivered.status, 200); assert.equal((await delivered.json()).reviewRequired, true);
});

for (const [path, refunded, full] of [['portal return', 20000, false], ['webhook', 50000, true]]) {
  test(`a portal payment Stripe shows ${full ? 'fully' : 'partly'} refunded is held by the ${path} and never recorded as paid`, async t => {
    const { f, id, call, job } = await portalPayment(t);
    Object.assign(f.sessions.get(id).payment_intent.latest_charge, { amount_refunded: refunded, refunded: full });
    if (path === 'webhook') {
      const delivered = await f.event(f.webhookObject(id));
      assert.equal(delivered.status, 200); assert.deepEqual(await delivered.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
    } else {
      const verified = await call({ action: 'verify_payment', session_id: id });
      assert.deepEqual([verified.status, verified.body.code, verified.body.reviewRecorded], [409, 'payment_refunded', true]); assert.match(verified.body.error, /Please do not pay again/);
    }
    assert.equal(job().payment, undefined); assert.equal(job().invoice, undefined);
    const review = f.docs.get(`payment_reviews/${id}`).value;
    assert.deepEqual([review.kind, review.reason, review.status, review.refundedCents, review.recordedBy], ['egc_customer_portal_payment', 'payment_refunded', 'open', refunded, path === 'webhook' ? 'stripe_webhook' : 'customer_portal']);
  });
}

// ---- A refund on a portal payment the job already counts, a refund after a review was closed, and the pinned Stripe reads ----

const markCompleted = (f, jobId = 'portal-job') => { const row = f.docs.get(`jobs/${jobId}`); row.value = { ...row.value, status: 'completed' }; row.version++; };
const ledger = f => f.docs.get('customer_payment_checkouts/portal-job').value;

test('a refund on a portal payment the job already counts opens one review, and the customer can still pay the balance while the checkout block is off', async t => {
  const { f, id, call, job } = await portalPayment(t);
  assert.equal((await call({ action: 'verify_payment', session_id: id })).status, 200);
  assert.equal(job().payment.amount, 500);
  // The owner refunds $100 of the $500 deposit in Stripe; the job is completed, so the $500 balance is due.
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 10000;
  markCompleted(f);
  const before = structuredClone(job()), created = posts(f);
  const pay = await call({ action: 'create_payment', request_id: 'synthetic-portal-balance' });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.deepEqual([pay.body.amount, pay.body.purpose], [500, 'balance']); assert.match(pay.body.url, /^https:\/\/checkout\.stripe\.com\//);
  const next = [...f.sessions.keys()].at(-1);
  assert.equal(posts(f), created + 1, 'one new checkout, for the balance the job shows');
  assert.notEqual(next, id); assert.equal(f.sessions.get(next).amount_total, 50000);
  assert.deepEqual([ledger(f).sessionId, ledger(f).status], [next, 'open']);
  // The refund still reaches the owner, once, and the job is left as it is.
  assert.deepEqual([...f.docs.keys()].filter(key => key.startsWith('payment_reviews/')), [`payment_reviews/${id}`]);
  const review = f.docs.get(`payment_reviews/${id}`).value;
  assert.deepEqual([review.status, review.reason, review.refundedCents, review.jobPaidCents, review.recordedBy], ['open', 'payment_refunded', 10000, 50000, 'customer_portal']);
  assert.deepEqual(job(), before);
  // Asking again hands out the same new link; the refunded checkout is not read or recorded again.
  const again = await call({ action: 'create_payment', request_id: 'synthetic-portal-balance-2' });
  assert.deepEqual([again.status, again.body.url, posts(f)], [200, pay.body.url, created + 1]);
  assert.equal(f.docs.get(`payment_reviews/${id}`).version, 1);
});

test('with PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED, a refund on a portal payment the job already counts holds new checkouts until the owner records it', async t => {
  const { f, id, call, job } = await portalPayment(t, { ...env, PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED: 'true' });
  assert.equal((await call({ action: 'verify_payment', session_id: id })).status, 200);
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 10000;
  markCompleted(f);
  const before = structuredClone(job()), created = posts(f);
  const held = await call({ action: 'create_payment', request_id: 'synthetic-portal-balance' });
  assert.deepEqual([held.status, held.body.code, held.body.reviewRecorded], [409, 'payment_refunded', true]);
  assert.match(held.body.error, /Please do not pay again until we contact you/);
  assert.equal(posts(f), created, 'no new checkout while the review is open');
  assert.deepEqual([ledger(f).sessionId, ledger(f).status], [id, 'open']);
  assert.deepEqual([f.docs.get(`payment_reviews/${id}`).value.reason, f.docs.get(`payment_reviews/${id}`).value.refundedCents], ['payment_refunded', 10000]);
  assert.deepEqual(job(), before);
  // The owner records the refund (and corrects the job by hand); then the balance can be paid.
  const resolved = await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  assert.deepEqual([resolved.review.resolution, resolved.review.refundedCents, resolved.review.recordedOnJobAtResolution], ['refunded', 10000, true]);
  const pay = await call({ action: 'create_payment', request_id: 'synthetic-portal-balance-2' });
  assert.equal(pay.status, 200, JSON.stringify(pay.body)); assert.equal(pay.body.amount, 500);
  assert.equal(posts(f), created + 1);
  assert.deepEqual([...f.docs.keys()].filter(key => key.startsWith('payment_reviews/')), [`payment_reviews/${id}`]);
});

// FIX-PORTAL-CRASH: the portal stops asking again only on an answer that names its code.
test('a portal return for a charge waiting on an earlier unverified payment names payment_needs_review and leaves the job as it is', async t => {
  const { f, id, call, job } = await portalPayment(t);
  const row = f.docs.get('jobs/portal-job'); row.value = { ...row.value, payment: { amount: 200, verified: false, method: 'check' } }; row.version++;
  const before = structuredClone(job());
  const verified = await call({ action: 'verify_payment', session_id: id });
  assert.deepEqual([verified.status, verified.body.code, verified.body.reviewRecorded, verified.body.paid], [409, 'payment_needs_review', undefined, undefined]);
  assert.match(verified.body.error, /Your Stripe payment is confirmed\. An earlier recorded payment needs team verification.*Please do not pay again\./);
  assert.deepEqual(job(), before);
  assert.deepEqual([ledger(f).requiresReview, ledger(f).verifiedReceipt.sessionId, ledger(f).verifiedReceipt.amount, ledger(f).verifiedReceipt.confirmedAt], [true, id, 500, NOW]);
  assert.deepEqual([...f.docs.keys()].filter(key => key.startsWith('payment_reviews/')), [], 'no review is opened for it');
  // Other refusals still carry no code (Stripe has not settled this session).
  f.sessions.get(id).status = 'open';
  const unsettled = await call({ action: 'verify_payment', session_id: id });
  assert.deepEqual([unsettled.status, unsettled.body], [409, { ok: false, error: 'Stripe has not verified this job payment' }]);
});

test('a refund Stripe shows after the review of a charge on the job was closed reaches the owner in one follow-up review', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  const followUp = `payment_reviews/${id}:refund`, reviewKeys = () => [...f.docs.keys()].filter(key => key.startsWith('payment_reviews/'));
  // Held behind an unverified $100 receipt; once it is verified the crew return settles the charge, and a manager reconciles the review.
  f.edit({ payment: { amount: 100, verified: false, method: 'check' } });
  assert.equal((await (await f.event(f.webhookObject(id))).json()).reason, 'payment_needs_review');
  f.edit({ payment: { amount: 100, verified: true, method: 'check', stripeSessions: [] } });
  assert.equal((await f.verify(id)).status, 200); assert.equal(f.job().payment.amount, 600);
  const reconciled = await resolveHeld(f, id, 'payment.reconcile', {}, managerActor);
  assert.deepEqual([reconciled.review.resolution, reconciled.review.recordedOnJobAtResolution], ['reconciled', true]);
  const closed = structuredClone(f.docs.get(`payment_reviews/${id}`)), before = structuredClone(f.job());
  const jobRevision = `2026-09-22T00:00:00.${String(f.docs.get('jobs/job-1').version).padStart(6, '0')}Z`;
  // Stripe then shows $200 refunded: the crew return is told, and the owner gets a follow-up review instead of a silent "resolved".
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 20000;
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.deepEqual([crewReturn.status, body.code, body.reviewRecorded], [409, 'payment_refunded', true]);
  assert.match(body.error, /already counts as paid.*Do not charge again/);
  assert.deepEqual(f.docs.get(followUp), { version: 1, value: {
    sessionId: id, jobId: 'job-1', kind: 'egc_job_payment', reason: 'payment_refunded', status: 'open', amountCents: 50000, currency: 'usd', paymentIntentId: `pi_${id}`, livemode: false,
    jobRevision, jobTotalCents: 100000, jobPaidCents: 60000, jobBalanceCents: 40000, createdBy: 'crew1', recordedBy: 'crew1', createdAt: NOW,
    followUpOf: id, priorResolution: 'reconciled', heldReason: 'payment_needs_review', refundedCents: 20000, refundSeenAt: NOW } });
  assert.deepEqual(f.docs.get(`payment_reviews/${id}`), closed, 'the closed review is never reopened or rewritten');
  assert.deepEqual(f.job(), before, 'the job is left as it is');
  // Redeliveries and returns keep the one follow-up; a larger refund updates it under its revision, once.
  const redelivery = await f.event(f.webhookObject(id));
  assert.equal(redelivery.status, 200); assert.deepEqual(await redelivery.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.equal((await f.verify(id)).status, 409); assert.equal(f.docs.get(followUp).version, 1);
  Object.assign(f.sessions.get(id).payment_intent.latest_charge, { amount_refunded: 50000, refunded: true });
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  assert.deepEqual([f.docs.get(followUp).version, f.docs.get(followUp).value.refundedCents], [2, 50000]);
  assert.equal((await f.event(f.webhookObject(id))).status, 200); assert.equal(f.docs.get(followUp).version, 2);
  assert.deepEqual(reviewKeys(), [`payment_reviews/${id}`, followUp]); assert.deepEqual(f.job(), before);
  // The owner sees it in Review queues under its own review ID; it is the owner's to record, with the job correction acknowledged.
  const ownerCookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0], reviews = stripeReviewHandlers({ now: () => new Date(NOW) });
  const [row] = (await (await reviews.get({ env, request: new Request(`${origin}/api/stripe-reviews`, { headers: { Cookie: ownerCookie } }) })).json()).paymentReviews;
  assert.deepEqual([row.sessionId, row.reviewId, row.reason, row.refundedCents, row.keptCents, row.heldReason, row.recordedOnJob], [id, `${id}:refund`, 'payment_refunded', 50000, 0, 'payment_needs_review', true]);
  await assert.rejects(resolveHeld(f, `${id}:refund`, 'payment.reconcile', { note: 'Refunded' }, managerActor), error => error.code === 'stripe_review_owner_required' && error.status === 403);
  await assert.rejects(resolveHeld(f, `${id}:refund`, 'payment.reconcile', { note: 'Refunded' }), error => error.code === 'stripe_review_refund_shown' && error.details.recordedOnJob === true);
  const post = payload => reviews.post({ env, request: new Request(`${origin}/api/stripe-reviews`, { method: 'POST', headers: { Cookie: ownerCookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) });
  const payload = { action: 'payment.refund', requestId: randomUUID(), reviewId: row.reviewId, expectedRevision: row.revision, reason: 'customer_request' };
  const unacknowledged = await post(payload);
  assert.deepEqual([unacknowledged.status, (await unacknowledged.json()).code], [409, 'stripe_review_refund_on_job']);
  const saved = await post({ ...payload, requestId: randomUUID(), jobPaymentAcknowledged: true }), savedBody = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(savedBody));
  assert.deepEqual([savedBody.review.id, savedBody.review.resolution, savedBody.review.refundFull, savedBody.review.recordedOnJobAtResolution], [`${id}:refund`, 'refunded', true, true]);
  const audit = audits(f).find(entry => entry.entityKey === followUp);
  assert.deepEqual([audit.action, audit.visibility, audit.reason], ['stripe_review.payment.refund', 'owner', 'Customer asked for a refund (the job still counts this charge as paid)']);
  // Resolved: later returns and redeliveries say so (with nothing queued, the webhook says no review is required), and nothing else is opened.
  const after = await f.verify(id), afterBody = await after.json();
  assert.deepEqual([after.status, afterBody.code], [409, 'payment_review_resolved']); assert.match(afterBody.error, /office already resolved it/);
  assert.deepEqual(await (await f.event(f.webhookObject(id))).json(), { ok: true, received: true, recorded: false, reviewRequired: false, reason: 'payment_review_resolved' });
  assert.deepEqual(reviewKeys(), [`payment_reviews/${id}`, followUp]);
  assert.equal(f.job().payment.amount, 600, 'the owner corrects the job payment by hand');
});

test('a larger refund Stripe shows after the owner recorded a smaller one on a charge the job counts opens exactly one follow-up review', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  const reviewKeys = () => [...f.docs.keys()].filter(key => key.startsWith('payment_reviews/')), open = () => reviewKeys().filter(key => f.docs.get(key).value.status === 'open');
  assert.equal((await f.verify(id)).status, 200); assert.equal(f.job().payment.amount, 500);
  // Stripe shows $100 refunded; the owner records it (and will correct the job by hand).
  f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 10000;
  assert.equal((await (await f.verify(id)).json()).code, 'payment_refunded');
  const first = await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  assert.deepEqual([first.review.resolution, first.review.refundedCents, first.review.refundFull], ['refunded', 10000, false]);
  const closed = structuredClone(f.docs.get(`payment_reviews/${id}`)), before = structuredClone(f.job());
  // The same $100 seen again is already settled: returns and redeliveries say so and open nothing.
  assert.equal((await (await f.verify(id)).json()).code, 'payment_review_resolved');
  assert.equal((await (await f.event(f.webhookObject(id))).json()).reason, 'payment_review_resolved');
  assert.deepEqual(reviewKeys(), [`payment_reviews/${id}`]);
  // Stripe then shows the full $500 refunded: the $400 more reaches the owner in one follow-up, never a silent "resolved".
  Object.assign(f.sessions.get(id).payment_intent.latest_charge, { amount_refunded: 50000, refunded: true });
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.deepEqual([crewReturn.status, body.code, body.reviewRecorded], [409, 'payment_refunded', true]);
  const webhook = await f.event(f.webhookObject(id));
  assert.equal(webhook.status, 200); assert.deepEqual(await webhook.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.equal((await f.verify(id)).status, 409);
  assert.deepEqual(open(), [`payment_reviews/${id}:refund`], 'exactly one new open review');
  const followUp = f.docs.get(`payment_reviews/${id}:refund`);
  assert.deepEqual([followUp.version, followUp.value.sessionId, followUp.value.reason, followUp.value.refundedCents, followUp.value.priorRefundedCents, followUp.value.priorResolution, followUp.value.followUpOf, followUp.value.createdAt],
    [1, id, 'payment_refunded', 50000, 10000, 'refunded', id, NOW]);
  assert.deepEqual(f.docs.get(`payment_reviews/${id}`), closed, 'the closed review is never reopened or rewritten'); assert.deepEqual(f.job(), before);
  // The queue names the refund recorded before; the owner records the rest with the job correction acknowledged.
  const ownerCookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const rows = (await (await stripeReviewHandlers({ now: () => new Date(NOW) }).get({ env, request: new Request(`${origin}/api/stripe-reviews`, { headers: { Cookie: ownerCookie } }) })).json()).paymentReviews;
  assert.deepEqual(rows.map(row => [row.reviewId, row.refundedCents, row.priorRefundedCents, row.recordedOnJob]), [[`${id}:refund`, 50000, 10000, true]]);
  await assert.rejects(resolveHeld(f, `${id}:refund`, 'payment.reconcile', { note: 'Refunded' }), error => error.code === 'stripe_review_refund_shown');
  const second = await resolveHeld(f, `${id}:refund`, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  assert.deepEqual([second.review.id, second.review.refundedCents, second.review.refundFull], [`${id}:refund`, 50000, true]);
  assert.equal((await (await f.verify(id)).json()).code, 'payment_review_resolved');
  assert.equal((await (await f.event(f.webhookObject(id))).json()).reason, 'payment_review_resolved');
  assert.deepEqual(reviewKeys(), [`payment_reviews/${id}`, `payment_reviews/${id}:refund`]); assert.deepEqual(open(), []);
  assert.equal(f.job().payment.amount, 500, 'the owner corrects the job payment by hand');
});

test('each further refund after a follow-up was recorded opens the next follow-up ({sessionId}:refund:2), updated while open, never a second open one', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  const reviewKeys = () => [...f.docs.keys()].filter(key => key.startsWith('payment_reviews/')), open = () => reviewKeys().filter(key => f.docs.get(key).value.status === 'open');
  const charge = () => f.sessions.get(id).payment_intent.latest_charge;
  assert.equal((await f.event(f.webhookObject(id))).status, 200); assert.equal(f.job().payment.amount, 500);
  // $100, then $300 in all, each recorded by the owner.
  charge().amount_refunded = 10000; assert.equal((await f.verify(id)).status, 409);
  await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  charge().amount_refunded = 30000; assert.equal((await (await f.event(f.webhookObject(id))).json()).reason, 'payment_refunded');
  assert.deepEqual(open(), [`payment_reviews/${id}:refund`]);
  const recorded = await resolveHeld(f, `${id}:refund`, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  assert.deepEqual([recorded.review.refundedCents, recorded.review.refundFull], [30000, false]);
  // $400 in all: the next follow-up, created once across returns and redeliveries.
  charge().amount_refunded = 40000;
  for (let delivery = 0; delivery < 2; delivery++) assert.equal((await (await f.event(f.webhookObject(id))).json()).reason, 'payment_refunded');
  assert.equal((await (await f.verify(id)).json()).code, 'payment_refunded');
  const next = `payment_reviews/${id}:refund:2`;
  assert.deepEqual(open(), [next]);
  assert.deepEqual([f.docs.get(next).version, f.docs.get(next).value.sessionId, f.docs.get(next).value.refundedCents, f.docs.get(next).value.priorRefundedCents, f.docs.get(next).value.priorResolution], [1, id, 40000, 30000, 'refunded']);
  // While it is open, the full refund updates it under its revision instead of opening another.
  Object.assign(charge(), { amount_refunded: 50000, refunded: true });
  assert.equal((await f.verify(id)).status, 409); assert.equal((await f.event(f.webhookObject(id))).status, 200);
  assert.deepEqual([open(), f.docs.get(next).version, f.docs.get(next).value.refundedCents], [[next], 2, 50000]);
  // Resolved by its own ID against the same charge; then everything is settled.
  const last = await resolveHeld(f, `${id}:refund:2`, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  assert.deepEqual([last.review.id, last.review.refundFull, last.review.recordedOnJobAtResolution], [`${id}:refund:2`, true, true]);
  assert.equal((await (await f.verify(id)).json()).code, 'payment_review_resolved');
  assert.deepEqual(reviewKeys(), [`payment_reviews/${id}`, `payment_reviews/${id}:refund`, next]); assert.deepEqual(open(), []);
  assert.equal(f.job().payment.amount, 500);
});

test('a refund Stripe shows after the owner closed a refund that failed ("Stripe no longer shows a refund") reaches the owner in a follow-up', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  const charge = () => f.sessions.get(id).payment_intent.latest_charge;
  assert.equal((await f.verify(id)).status, 200);
  charge().amount_refunded = 20000; assert.equal((await f.verify(id)).status, 409);
  assert.deepEqual([f.docs.get(`payment_reviews/${id}`).value.reason, f.docs.get(`payment_reviews/${id}`).value.refundedCents], ['payment_refunded', 20000]);
  // The refund failed, so Stripe no longer shows it; the owner closes the review with that exit.
  charge().amount_refunded = 0;
  const exit = await resolveHeld(f, id, 'payment.reconcile', { note: 'The refund failed' });
  assert.deepEqual([exit.review.resolution, f.docs.get(`payment_reviews/${id}`).value.refundedCents], ['reconciled', 20000]);
  // A real refund later is not settled by that close.
  charge().amount_refunded = 20000;
  const webhook = await f.event(f.webhookObject(id));
  assert.deepEqual(await webhook.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  const followUp = f.docs.get(`payment_reviews/${id}:refund`).value;
  assert.deepEqual([followUp.status, followUp.refundedCents, followUp.priorResolution, followUp.priorRefundedCents], ['open', 20000, 'reconciled', undefined]);
});

test('after a follow-up is closed as "Stripe no longer shows a refund", a refund no larger than an earlier recorded one still reaches the owner: the last close decides', async t => {
  const f = await fixture(t), id = await f.checkout(); f.complete(id);
  const reviewKeys = () => [...f.docs.keys()].filter(key => key.startsWith('payment_reviews/')), open = () => reviewKeys().filter(key => f.docs.get(key).value.status === 'open');
  const charge = () => f.sessions.get(id).payment_intent.latest_charge;
  assert.equal((await f.verify(id)).status, 200); assert.equal(f.job().payment.amount, 500);
  // The owner records a $200 refund on the charge's own review.
  charge().amount_refunded = 20000; assert.equal((await (await f.verify(id)).json()).code, 'payment_refunded');
  const first = await resolveHeld(f, id, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  assert.deepEqual([first.review.resolution, first.review.refundedCents, first.review.refundFull], ['refunded', 20000, false]);
  // Stripe shows $300: the :refund follow-up opens.
  charge().amount_refunded = 30000; assert.equal((await (await f.verify(id)).json()).code, 'payment_refunded');
  assert.deepEqual(open(), [`payment_reviews/${id}:refund`]);
  assert.equal(f.docs.get(`payment_reviews/${id}:refund`).value.priorRefundedCents, 20000);
  // The refunds fail and Stripe shows none: the owner closes :refund with "Stripe no longer shows a refund".
  charge().amount_refunded = 0;
  const exit = await resolveHeld(f, `${id}:refund`, 'payment.reconcile', { note: 'The refunds failed' });
  assert.equal(exit.review.resolution, 'reconciled');
  assert.deepEqual(open(), []);
  const closed = Object.fromEntries(reviewKeys().map(key => [key, structuredClone(f.docs.get(key))])), before = structuredClone(f.job());
  // Stripe later shows $200 again. The charge's own review recorded $200, but the last close settled none:
  // the crew return and the webhook open one follow-up instead of answering "already resolved".
  charge().amount_refunded = 20000;
  const crewReturn = await f.verify(id), body = await crewReturn.json();
  assert.deepEqual([crewReturn.status, body.code, body.reviewRecorded], [409, 'payment_refunded', true]);
  for (let delivery = 0; delivery < 2; delivery++) {
    const webhook = await f.event(f.webhookObject(id));
    assert.equal(webhook.status, 200); assert.deepEqual(await webhook.json(), { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  }
  assert.equal((await (await f.verify(id)).json()).code, 'payment_refunded');
  const next = `payment_reviews/${id}:refund:2`;
  assert.deepEqual(open(), [next], 'exactly one new open review');
  const followUp = f.docs.get(next);
  assert.deepEqual([followUp.version, followUp.value.sessionId, followUp.value.reason, followUp.value.refundedCents, followUp.value.priorResolution, followUp.value.priorRefundedCents, followUp.value.followUpOf, followUp.value.createdAt],
    [1, id, 'payment_refunded', 20000, 'reconciled', undefined, id, NOW]);
  for (const [key, row] of Object.entries(closed)) assert.deepEqual(f.docs.get(key), row, `${key} is never reopened or rewritten`);
  assert.deepEqual(f.job(), before);
  // Once the owner records it, the same $200 is settled by the last close and stays resolved.
  const last = await resolveHeld(f, `${id}:refund:2`, 'payment.refund', { reason: 'customer_request', jobPaymentAcknowledged: true });
  assert.deepEqual([last.review.id, last.review.refundedCents, last.review.refundFull], [`${id}:refund:2`, 20000, false]);
  assert.equal((await (await f.verify(id)).json()).code, 'payment_review_resolved');
  assert.equal((await (await f.event(f.webhookObject(id))).json()).reason, 'payment_review_resolved');
  assert.deepEqual(reviewKeys().sort(), [`payment_reviews/${id}`, `payment_reviews/${id}:refund`, next].sort()); assert.deepEqual(open(), []);
  assert.equal(f.job().payment.amount, 500, 'the owner corrects the job payment by hand');
});

test('while the checkout block is off, a refund on a charge the job already counts tells the customer and the crew the balance is unchanged, never "do not pay again"', async t => {
  for (const [label, environment] of [['off', env], ['on', { ...env, PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED: 'true' }]]) {
    await t.test(`checkout block ${label}`, async st => {
      const { f, id, call } = await portalPayment(st, environment);
      assert.equal((await call({ action: 'verify_payment', session_id: id })).status, 200);
      f.sessions.get(id).payment_intent.latest_charge.amount_refunded = 10000;
      markCompleted(f);
      const verified = await call({ action: 'verify_payment', session_id: id });
      const pay = await call({ action: 'create_payment', request_id: 'synthetic-portal-balance' });
      assert.deepEqual([verified.status, verified.body.code, verified.body.reviewRecorded], [409, 'payment_refunded', true]);
      if (label === 'off') {
        assert.equal(verified.body.error, 'Stripe shows a refund on this payment, and our team is reviewing it. Your remaining balance is unchanged.');
        assert.doesNotMatch(verified.body.error, /do not pay again/i);
        assert.deepEqual([pay.status, pay.body.amount], [200, 500], 'the balance checkout the message allows');
      } else {
        assert.match(verified.body.error, /Please do not pay again until we contact you/);
        assert.deepEqual([pay.status, pay.body.code], [409, 'payment_refunded'], 'the checkout the message forbids is held');
      }
      // The crew closeout gets the same answer for a crew charge on the job.
      const crewId = await f.checkout(); f.complete(crewId);
      assert.equal((await f.verify(crewId)).status, 200);
      f.sessions.get(crewId).payment_intent.latest_charge.amount_refunded = 10000;
      const crew = await (await f.verify(crewId)).json();
      assert.equal(crew.code, 'payment_refunded'); assert.match(crew.error, /already counts as paid.*Do not charge again/);
      if (label === 'off') assert.equal(crew.error, 'Stripe shows a refund on this charge, which the job already counts as paid, so the job balance is unchanged. The owner is reviewing the refund. Do not charge again for this payment; any balance the job still shows can be collected as usual.');
      else assert.equal(crew.error, 'Stripe shows a refund on this charge, which the job already counts as paid. It is saved for the owner to review. Do not charge again.');
    });
  }
});

test('every customer-payment Stripe call is pinned to API version 2024-06-20, and the webhook read-back gives up after 15 seconds so Stripe retries', async t => {
  const { f, id, call, job } = await portalPayment(t);
  // A webhook read-back that runs past its deadline is a 503: nothing is recorded and Stripe redelivers.
  const deadlines = [], timeout = t.mock.method(AbortSignal, 'timeout', ms => { deadlines.push(ms); return AbortSignal.abort(new DOMException('synthetic deadline', 'TimeoutError')); });
  const late = await f.event(f.webhookObject(id));
  timeout.mock.restore();
  assert.deepEqual([late.status, deadlines], [503, [15000]]); assert.equal(job().payment, undefined);
  assert.equal((await f.event(f.webhookObject(id))).status, 200); assert.equal(job().payment.amount, 500);
  // The portal return, then a balance checkout that is resumed, and expired once the quote changes.
  assert.equal((await call({ action: 'verify_payment', session_id: id })).status, 200);
  markCompleted(f);
  const balance = await call({ action: 'create_payment', request_id: 'synthetic-portal-balance' });
  assert.equal(balance.status, 200);
  const row = f.docs.get('jobs/portal-job'); row.value = { ...row.value, estimate: { ...row.value.estimate, amount: 1200 } }; row.version++;
  const changed = await call({ action: 'create_payment', request_id: 'synthetic-portal-changed' });
  assert.deepEqual([changed.status, changed.body.amount], [200, 700]);
  const kinds = new Set(f.stripeCalls.map(({ method, url }) => `${method} ${new URL(url).pathname.replace(/cs_test_crew_\d+/, '{id}')}${new URL(url).searchParams.get('expand[]') ? ' expanded' : ''}`));
  assert.deepEqual([...kinds].sort(), ['GET /v1/checkout/sessions/{id} expanded', 'POST /v1/checkout/sessions', 'POST /v1/checkout/sessions/{id}/expire']);
  assert.ok(f.stripeCalls.length >= 8);
  assert.deepEqual(f.stripeCalls.filter(entry => entry.version !== '2024-06-20').map(entry => entry.url), [], 'create, resume, expire, verify and the webhook read all send Stripe-Version');
});
