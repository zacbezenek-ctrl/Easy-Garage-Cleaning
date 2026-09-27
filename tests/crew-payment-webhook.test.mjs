import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { stripeSecretKey } from '../functions/_lib/customer-payments.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import { stripeReviewHandlers } from '../functions/api/stripe-reviews.js';
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
  const docs = new Map([['jobs/job-1', { value: { ...crewJob(), ...initial }, version: 1 }]]), sessions = new Map(), stripeCalls = [], hooks = [];
  let failJobWrites = false, failReads = false, failReviewWrites = false, loseReviewResponse = false, jobPatches = 0, contention = 0;
  const version = row => `2026-09-22T00:00:00.${String(row.version).padStart(6, '0')}Z`;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]); let row = docs.get(path);
      if (failReads && method === 'GET') return Response.json({}, { status: 503 });
      const document = (key, value) => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${key}`, fields: encodeFirestoreFields(value.value), updateTime: version(value) });
      if (method === 'GET' && !path.includes('/')) {
        const rows = [...docs].filter(([key]) => key.startsWith(`${path}/`));
        return Response.json(rows.length ? { documents: rows.map(([key, value]) => document(key, value)) } : {});
      }
      if (method === 'PATCH') {
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
      stripeCalls.push({ url: url.href, method, authorization: options.headers?.Authorization || '' });
      if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
        const params = new URLSearchParams(options.body), id = `cs_test_crew_${sessions.size + 1}`;
        sessions.set(id, { id, object: 'checkout.session', mode: params.get('mode'), status: 'open', payment_status: 'unpaid', currency: params.get('line_items[0][price_data][currency]'), amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), client_reference_id: params.get('client_reference_id'), metadata: Object.fromEntries([...params].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])), url: `https://checkout.stripe.com/c/pay/${id}` });
        return Response.json(sessions.get(id));
      }
      const session = sessions.get(url.pathname.split('/')[4]);
      if (!session) return Response.json({}, { status: 404 });
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
    docs, sessions, stripeCalls, hooks,
    job: () => docs.get('jobs/job-1').value,
    jobPatches: () => jobPatches,
    edit: patch => { const row = docs.get('jobs/job-1'); row.value = { ...row.value, ...patch }; row.version++; },
    failJobWrites: value => { failJobWrites = value; }, failReads: value => { failReads = value; }, contend: writes => { contention = writes; },
    failReviewWrites: value => { failReviewWrites = value; }, loseReviewResponse: () => { loseReviewResponse = true; }, crewCookie,
    async checkout(amountCents = 50000, key = 'synthetic-request') {
      const response = await crewPayment.onRequestPost({ env: environment, request: new Request(`${origin}/api/job-payment`, { method: 'POST', headers: { Cookie: crewCookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: 'job-1', request_id: key, amount_cents: amountCents }) }) });
      assert.equal(response.status, 200); return (await response.json()).sessionId;
    },
    complete: id => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', url: null, payment_intent: { id: `pi_${id}`, latest_charge: { receipt_url: `https://pay.stripe.com/receipts/${id}` } }, customer_details: { email: 'crew-customer@example.invalid' } }),
    // Stripe's webhook object carries the PaymentIntent ID, not the expanded charge.
    webhookObject: id => ({ ...sessions.get(id), payment_intent: sessions.get(id).payment_intent?.id || null }),
    async event(object, { type = 'checkout.session.completed', id = `evt_crew_${++events}`, signedAt = NOW } = {}) {
      const timestamp = Math.floor(Date.parse(signedAt) / 1000), raw = JSON.stringify({ id, type, created: timestamp, data: { object } });
      const signature = createHmac('sha256', environment.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
      return webhook.post({ env: environment, request: new Request(`${origin}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body: raw }) });
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
  assert.equal(job.payment.recordedBy, 'stripe_webhook'); assert.equal(job.payment.receiptUrl, '');
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
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
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
  assert.deepEqual(body.paymentReviews, [{ sessionId: id, jobId: 'job-1', reason: 'payment_exceeds_balance', status: 'open', amountCents: 50000, currency: 'usd', paymentIntentId: `pi_${id}`, livemode: false,
    jobTotalCents: 100000, jobPaidCents: 70000, jobBalanceCents: 30000, createdBy: 'crew1', recordedBy: 'stripe_webhook', createdAt: NOW, customer: 'Synthetic Crew Customer', jobFound: true, recordedOnJob: false }]);
  // The manager corrects the earlier record; the crew return now applies the session, and the review shows it.
  f.edit({ payment: { amount: 200, verified: true, method: 'check', stripeSessions: [] } });
  assert.equal((await f.verify(id)).status, 200);
  assert.equal((await (await get(manager)).json()).paymentReviews[0].recordedOnJob, true, 'a session already on the job is never applied twice');
  assert.equal((await get(manager, '?status=all')).status, 400);
  f.failReads(true);
  const outage = await get(manager);
  assert.equal(outage.status, 503); assert.equal((await outage.json()).code, 'stripe_review_storage_unavailable', 'an unreadable ledger is never shown as empty');
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
