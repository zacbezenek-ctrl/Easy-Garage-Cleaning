import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { recordCustomerStripePayment } from '../functions/_lib/customer-payments.js';
import { funnelEventId, FUNNEL_EVENTS_COLLECTION } from '../functions/_lib/funnel-events.js';
import { paymentLedger } from '../functions/_lib/money-core.js';
import { moneyDocumentModel } from '../functions/_lib/money-document.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import * as crewPayment from '../functions/api/job-payment.js';

// FUN-33: Stripe checkout payments recorded through one :commit with their
// funnel events, over a Firestore REST fake with updateTime/exists
// preconditions and an all-or-nothing :commit.
const NOW = '2026-09-22T18:00:00.000Z'; // noon in Denver on 2026-09-22
const origin = 'https://easygaragecleaning.com';
const env = {
  FIREBASE_API_KEY: 'firebase-test-stripe-payment-events', STRIPE_SECRET_KEY: 'sk_test_synthetic_payment_events', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_payment_events',
  HUB_SESSION_SECRET: 'synthetic-payment-events-hub-secret', FUNNEL_PAYMENT_EVENTS_ENABLED: 'true', MONEY_API_ENABLED: 'true',
  HUB_AUTH_USERS_JSON: JSON.stringify({ crew1: { role: 'crew', displayName: 'Synthetic Crew', passwordHash: 'synthetic-hash' } }),
};
const seconds = at => Date.parse(at) / 1000;
const crewJob = { type: 'job', customer: 'Synthetic Crew Customer', email: 'crew-customer@example.invalid', customerId: 'c1', total: 1000, date: '2026-09-24', status: 'scheduled', assignedCrew: ['crew1'] };

async function fixture(t, { jobs = { 'job-1': crewJob }, environment = env } = {}) {
  const docs = new Map(Object.entries(jobs).map(([id, value]) => [`jobs/${id}`, { value: structuredClone(value), version: 1 }])), sessions = new Map(), stripeCalls = [];
  let jobPatches = 0, commits = 0, contention = 0, loseCommit = false, stripeDown = false;
  const version = row => `2026-09-22T00:00:00.${String(row.version).padStart(6, '0')}Z`;
  const named = name => decodeURIComponent(name.split('/documents/')[1]);
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      if (url.pathname.endsWith('/documents:commit')) {
        const { writes } = JSON.parse(options.body);
        if (contention) { contention--; docs.get('jobs/job-1').version++; }
        for (const write of writes) {
          const row = docs.get(named(write.update.name)), want = write.currentDocument;
          if (want.updateTime ? !row || want.updateTime !== version(row) : want.exists === false && row) return Response.json({ error: { code: row ? 409 : 400, status: row && !want.updateTime ? 'ALREADY_EXISTS' : 'FAILED_PRECONDITION' } }, { status: row && !want.updateTime ? 409 : 400 });
        }
        for (const write of writes) {
          const path = named(write.update.name), row = docs.get(path), fields = decodeFirestoreFields(write.update.fields);
          docs.set(path, { value: { ...(row?.value || {}), ...Object.fromEntries(write.updateMask.fieldPaths.map(field => [field, fields[field]])) }, version: (row?.version || 0) + 1 });
        }
        commits++;
        if (loseCommit) { loseCommit = false; throw new TypeError('Synthetic lost commit response'); }
        return Response.json({ writeResults: writes.map(() => ({})), commitTime: NOW });
      }
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]); let row = docs.get(path);
      if (method === 'PATCH') {
        if (row ? url.searchParams.get('currentDocument.updateTime') !== version(row) : url.searchParams.get('currentDocument.exists') !== 'false') return Response.json({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, { status: 400 });
        if (path.startsWith('jobs/')) jobPatches++;
        row = { value: { ...(row?.value || {}), ...decodeFirestoreFields(JSON.parse(options.body).fields) }, version: (row?.version || 0) + 1 }; docs.set(path, row);
      }
      return row ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(row.value), updateTime: version(row) }) : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') {
      stripeCalls.push({ path: url.pathname, expand: url.searchParams.get('expand[]'), method });
      if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
        const params = new URLSearchParams(options.body), id = `cs_test_crew_session_${sessions.size + 1}`;
        sessions.set(id, { id, object: 'checkout.session', mode: params.get('mode'), status: 'open', payment_status: 'unpaid', currency: params.get('line_items[0][price_data][currency]'), amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), client_reference_id: params.get('client_reference_id'), livemode: false, metadata: Object.fromEntries([...params].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])), url: `https://checkout.stripe.com/c/pay/${id}` });
        return Response.json(sessions.get(id));
      }
      if (stripeDown) return Response.json({ error: { type: 'api_error' } }, { status: 500 });
      const session = sessions.get(url.pathname.split('/')[4]);
      if (!session) return Response.json({}, { status: 404 });
      return Response.json(url.searchParams.get('expand[]') === 'payment_intent.latest_charge' || !session.payment_intent ? session : { ...session, payment_intent: session.payment_intent.id });
    }
    throw new Error(`Unexpected request ${url.hostname}${url.pathname}`);
  });
  const crewCookie = (await createHubSessionCookie(environment, 'crew1')).split(';')[0];
  const webhook = stripeWebhookHandlers({ now: () => new Date(NOW) }), verifier = crewPayment.jobPaymentVerifier({ now: () => new Date(NOW) });
  let events = 0;
  const f = {
    docs, sessions, stripeCalls,
    job: (id = 'job-1') => docs.get(`jobs/${id}`).value,
    events: () => [...docs].filter(([key]) => key.startsWith(`${FUNNEL_EVENTS_COLLECTION}/`)).map(([key, row]) => ({ id: key.split('/')[1], ...row.value })),
    jobPatches: () => jobPatches, commits: () => commits,
    contend: writes => { contention = writes; }, loseCommit: () => { loseCommit = true; }, stripeDown: value => { stripeDown = value; },
    async checkout(amountCents, key) {
      const response = await crewPayment.onRequestPost({ env: environment, request: new Request(`${origin}/api/job-payment`, { method: 'POST', headers: { Cookie: crewCookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: 'job-1', request_id: key, amount_cents: amountCents }) }) });
      assert.equal(response.status, 200); return (await response.json()).sessionId;
    },
    session: (id, values) => sessions.set(id, { id, object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', currency: 'usd', livemode: false, ...values }),
    complete: (id, chargedAt, type = 'card') => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', url: null, customer_details: { email: 'customer@example.invalid' },
      payment_intent: { id: `pi_${id.slice(3)}`, created: seconds(chargedAt) - 30, latest_charge: { id: `ch_${id.slice(3)}`, created: seconds(chargedAt), receipt_url: `https://pay.stripe.com/receipts/${id}`, payment_method_details: { type } } } }),
    // Stripe's webhook object carries the PaymentIntent ID, not the expanded charge.
    webhookObject: id => ({ ...sessions.get(id), payment_intent: sessions.get(id).payment_intent?.id || null }),
    async event(object, { type = 'checkout.session.completed', id = `evt_synthetic_payment_${++events}` } = {}) {
      const timestamp = seconds(NOW), raw = JSON.stringify({ id, type, created: timestamp, data: { object } });
      const signature = createHmac('sha256', environment.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
      return webhook.post({ env: environment, request: new Request(`${origin}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body: raw }) });
    },
    verify: id => verifier({ env: environment, request: new Request(`${origin}/api/job-payment?session_id=${id}`, { headers: { Cookie: crewCookie, Origin: origin } }) }),
  };
  return f;
}

test('a crew card payment through the webhook alone is one commit with its payment event, dated at the Stripe charge', async t => {
  const f = await fixture(t), id = await f.checkout(50000, 'synthetic-deposit'), charged = '2026-09-22T17:55:00.000Z'; f.complete(id, charged);
  const response = await f.event(f.webhookObject(id));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, received: true, recorded: true, duplicate: false });
  assert.ok(f.stripeCalls.some(call => call.path === `/v1/checkout/sessions/${id}` && call.expand === 'payment_intent.latest_charge'), 'the webhook reads the charge time from Stripe');
  assert.deepEqual([f.commits(), f.jobPatches()], [1, 0], 'the job and its event are one :commit, never a lone patch');
  const [event] = f.events(), job = f.job();
  assert.equal(event.id, funnelEventId('payment.received', { field: 'jobId', value: 'job-1' }, `stripeSession:${id}`));
  assert.deepEqual({ type: event.type, data: event.data, occurredAt: event.occurredAt, clockSource: event.clockSource, recordedAt: event.recordedAt, denverDate: event.denverDate, actor: event.actor, via: event.via, source: event.source, key: event.idempotencyKey, customerId: event.customerId }, {
    type: 'payment.received', data: { amountCents: 50000, cash: true, kind: 'deposit', kindInferred: true, method: 'card' }, occurredAt: charged, clockSource: 'provider', recordedAt: NOW, denverDate: '2026-09-22',
    actor: { id: 'stripe_webhook', kind: 'integration', role: null }, via: 'stripe', source: { collection: 'jobs', id: `job-1:stripeSessions:${id}` }, key: `stripeSession:${id}`, customerId: 'c1' });
  // FUN-20's role-less Stripe webhook actor: the same id as every other Stripe webhook event, never a signable bridge principal.
  assert.deepEqual([event.isTest, event.exclusion], [true, 'stripe_test_mode'], 'a test-mode session is flagged by the shared eligibility');
  // The inference is noted beside the session and never written into its purpose, so the ledger, the receipt
  // and the invoice read the payment exactly as before (no customer-facing "Deposit" label from an unconfirmed rule).
  const [session] = job.payment.stripeSessions;
  assert.deepEqual([session.purpose, session.inferredKind, 'purposeInferred' in session], [undefined, 'deposit', false]);
  assert.deepEqual(paymentLedger(job).entries.map(entry => entry.kind), ['balance']);
  for (const kind of ['receipt', 'invoice']) assert.deepEqual(moneyDocumentModel({ ...job, id: 'job-1' }, { kind, now: NOW }).payments.map(row => row.label), ['Payment · Card (Stripe)'], kind);
  assert.deepEqual([job.payment.amount, job.invoice.balance, job.paidInFullAt, job.payment.receiptUrl], [500, 500, undefined, `https://pay.stripe.com/receipts/${id}`]);
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) assert.equal((await (await f.event(f.webhookObject(id), { type })).json()).duplicate, true);
  assert.deepEqual([f.commits(), f.events().length], [1, 1], 'replays write nothing');
});

test('the crew return that clears the balance records a balance payment and job.paid_in_full in the same commit', async t => {
  const f = await fixture(t), deposit = await f.checkout(50000, 'synthetic-deposit'); f.complete(deposit, '2026-09-21T16:00:00.000Z');
  assert.equal((await f.event(f.webhookObject(deposit))).status, 200);
  const final = await f.checkout(50000, 'synthetic-final'), charged = '2026-09-22T17:58:00.000Z'; f.complete(final, charged);
  const stripeReads = f.stripeCalls.length, response = await f.verify(final), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.duplicate, false); assert.equal(body.invoice.status, 'paid');
  assert.equal(f.stripeCalls.length, stripeReads + 1, 'the browser return already holds the expanded charge');
  assert.equal(f.commits(), 2);
  const events = f.events().filter(event => event.source.id === `job-1:stripeSessions:${final}`).sort((a, b) => a.type.localeCompare(b.type));
  assert.deepEqual(events.map(event => [event.type, event.data, event.occurredAt, event.via, event.actor.id]), [
    ['job.paid_in_full', { amountCents: 100000 }, charged, 'field', 'crew1'],
    ['payment.received', { amountCents: 50000, cash: true, kind: 'balance', kindInferred: true, method: 'card' }, charged, 'field', 'crew1'],
  ], 'the deposit is covered, so a second pre-service payment is a flagged balance');
  assert.equal(events[0].id, funnelEventId('job.paid_in_full', { field: 'jobId', value: 'job-1' }, `stripeSession:${final}`));
  assert.deepEqual([f.job().paidInFullAt, f.job().paidInFullRevision], [charged, null], 'a job without an estimate revision is bound to an unknown revision, never 0');
});

test('whichever of the webhook and the browser return lands first, the charge has the same single event', async t => {
  const ids = [];
  for (const order of [['event', 'verify'], ['verify', 'event'], ['both']]) {
    const f = await fixture(t), id = await f.checkout(30000, 'synthetic-order'); f.complete(id, '2026-09-22T17:00:00.000Z');
    if (order[0] === 'both') assert.deepEqual((await Promise.all([f.event(f.webhookObject(id)), f.verify(id), f.event(f.webhookObject(id))])).map(response => response.status), [200, 200, 200]);
    else for (const step of order) assert.equal((await (step === 'event' ? f.event(f.webhookObject(id)) : f.verify(id))).status, 200);
    assert.deepEqual([f.commits(), f.events().length, f.job().payment.stripeSessions.length], [1, 1, 1]);
    ids.push(f.events()[0].id);
    t.mock.restoreAll();
  }
  assert.equal(new Set(ids).size, 1, 'keyed by the session id, never by the delivery path');
});

test('a stale job at commit retries on a fresh read; a lost commit response is found as the recorded session', async t => {
  const f = await fixture(t), id = await f.checkout(30000, 'synthetic-contended'); f.complete(id, '2026-09-22T17:00:00.000Z');
  f.contend(2);
  assert.equal((await f.event(f.webhookObject(id))).status, 200, 'the third attempt commits on the fresh revision');
  assert.deepEqual([f.commits(), f.events().length, f.job().payment.amount], [1, 1, 300]);
  f.contend(3);
  const second = await f.checkout(20000, 'synthetic-busy'); f.complete(second, '2026-09-22T17:10:00.000Z');
  const busy = await f.verify(second);
  assert.equal(busy.status, 409); assert.equal((await busy.json()).error, 'The payment record changed. Refresh to confirm the latest balance.');
  assert.deepEqual([f.commits(), f.events().length], [1, 1], 'nothing half-written');
  f.loseCommit();
  const lost = await f.event(f.webhookObject(second));
  assert.equal(lost.status, 200); assert.equal((await lost.json()).duplicate, true, 'the retry reads the committed session back');
  assert.deepEqual([f.commits(), f.events().length, f.job().payment.amount], [2, 2, 500]);
});

test('portal deposits and balances keep their purpose, and paid-in-full is bound to the approved estimate revision', async t => {
  const portalJob = { type: 'job', customer: 'Synthetic Portal Customer', customerId: 'c2', projectId: 'project_w9', date: '2026-09-24', status: 'scheduled', total: 1000, estimate: { status: 'accepted', amount: 1000, revision: 2, depositRequired: 400 }, customerApproval: { status: 'approved', amount: 1000 } };
  const f = await fixture(t, { jobs: { 'job-portal': portalJob } });
  const metadata = purpose => ({ kind: 'egc_customer_portal_payment', job_id: 'job-portal', payment_purpose: purpose, quote_revision: '2', quoted_total_cents: '100000' });
  f.session('cs_live_portal_deposit_1', { amount_total: 40000, client_reference_id: 'job-portal', livemode: true, metadata: metadata('deposit') });
  f.complete('cs_live_portal_deposit_1', '2026-09-20T15:00:00.000Z');
  const recorded = await recordCustomerStripePayment(env, f.sessions.get('cs_live_portal_deposit_1'), 'job-portal', NOW);
  assert.equal(recorded.duplicate, false);
  let [deposit] = f.events();
  assert.deepEqual([deposit.type, deposit.data, deposit.via, deposit.actor, deposit.projectId, deposit.isTest, deposit.exclusion, deposit.occurredAt], ['payment.received', { amountCents: 40000, cash: true, estimateRevision: 2, kind: 'deposit', method: 'card' }, 'portal', { id: 'customer', kind: 'customer', role: null }, 'project_w9', false, null, '2026-09-20T15:00:00.000Z']);
  assert.deepEqual([f.job('job-portal').payment.stripeSessions[0].purpose, f.job('job-portal').payment.stripeSessions[0].inferredKind], ['deposit', undefined], 'an explicit purpose is kept and not flagged');
  // The balance arrives by webhook only; its purpose is explicit too, even on the service date.
  f.session('cs_live_portal_balance_1', { amount_total: 60000, client_reference_id: 'job-portal', livemode: true, metadata: metadata('balance') });
  f.complete('cs_live_portal_balance_1', '2026-09-22T17:30:00.000Z');
  assert.equal((await f.event(f.webhookObject('cs_live_portal_balance_1'))).status, 200);
  const latest = f.events().filter(event => event.idempotencyKey === 'stripeSession:cs_live_portal_balance_1').sort((a, b) => a.type.localeCompare(b.type));
  assert.deepEqual(latest.map(event => [event.type, event.data, event.via]), [['job.paid_in_full', { amountCents: 100000, estimateRevision: 2 }, 'stripe'], ['payment.received', { amountCents: 60000, cash: true, estimateRevision: 2, kind: 'balance', method: 'card' }, 'stripe']]);
  assert.deepEqual([f.job('job-portal').paidInFullAt, f.job('job-portal').paidInFullRevision], ['2026-09-22T17:30:00.000Z', 2]);
});

test('a Stripe webhook that lands after a revision or a reopen pays the job off when it is recorded; the payment keeps the charge time', async t => {
  const savedAt = '2026-09-22T17:00:00.000Z', chargedAt = '2026-09-19T16:30:00.000Z';
  const portalJob = extra => ({ type: 'job', customer: 'Synthetic Portal Customer', customerId: 'c2', date: '2026-09-18', status: 'completed', pipelineStatus: 'completed', total: 1000,
    estimate: { status: 'accepted', amount: 1000, revision: 2, depositRequired: 400 }, customerApproval: { status: 'approved', amount: 1000 },
    payment: { amount: 400, verified: true, stripeSessions: [{ sessionId: 'cs_test_portal_dep_late', paymentIntentId: 'pi_portal_dep_late', amount: 400, purpose: 'deposit', verifiedAt: '2026-09-10T15:00:00.000Z' }] }, ...extra });
  // An ACH balance debit started on the 19th settles on the 22nd, after revision 2 was saved (or the balance was reopened).
  for (const [label, extra, crossing] of [
    ['after a revision', { estimate: { status: 'accepted', amount: 1000, revision: 2, depositRequired: 400, updatedAt: savedAt } }, [NOW, 'server']],
    ['after a reopen', { balanceReopenedAt: savedAt, balanceReopenedReason: 'estimate_revised' }, [NOW, 'server']],
    ['before either', { estimate: { status: 'accepted', amount: 1000, revision: 2, depositRequired: 400, updatedAt: '2026-09-15T17:00:00.000Z' } }, [chargedAt, 'provider']],
  ]) {
    const f = await fixture(t, { jobs: { 'job-portal': portalJob(extra) } });
    f.session('cs_test_portal_ach_late', { amount_total: 60000, client_reference_id: 'job-portal', metadata: { kind: 'egc_customer_portal_payment', job_id: 'job-portal', payment_purpose: 'balance', quote_revision: '2', quoted_total_cents: '100000' } });
    f.complete('cs_test_portal_ach_late', chargedAt, 'us_bank_account');
    assert.equal((await f.event(f.webhookObject('cs_test_portal_ach_late'), { type: 'checkout.session.async_payment_succeeded' })).status, 200, label);
    const events = f.events().sort((a, b) => a.type.localeCompare(b.type));
    assert.deepEqual(events.map(event => [event.type, event.occurredAt, event.clockSource, event.recordedAt, event.data.estimateRevision]), [
      ['job.paid_in_full', ...crossing, NOW, 2], ['payment.received', chargedAt, 'provider', NOW, 2],
    ], label);
    assert.deepEqual([f.job('job-portal').paidInFullAt, f.job('job-portal').paidInFullRevision], [crossing[0], 2], label);
    t.mock.restoreAll();
  }
});

test('the funnel method comes from the Stripe charge: a bank debit is ach, Link is card, anything else is other', async t => {
  const portalJob = { type: 'job', customer: 'Synthetic Portal Customer', customerId: 'c2', date: '2026-09-24', status: 'scheduled', total: 1000, estimate: { status: 'accepted', amount: 1000, revision: 1 }, customerApproval: { status: 'approved', amount: 1000 } };
  const f = await fixture(t, { jobs: { 'job-portal': portalJob } });
  const metadata = { kind: 'egc_customer_portal_payment', job_id: 'job-portal', payment_purpose: 'balance', quote_revision: '1', quoted_total_cents: '100000' };
  for (const [id, amount, type] of [['cs_test_portal_ach_1', 30000, 'us_bank_account'], ['cs_test_portal_link_1', 20000, 'link'], ['cs_test_portal_cashapp_1', 10000, 'cashapp']]) {
    f.session(id, { amount_total: amount, client_reference_id: 'job-portal', metadata }); f.complete(id, '2026-09-22T17:00:00.000Z', type);
    // A bank debit settles later: Stripe sends async_payment_succeeded once it clears.
    assert.equal((await f.event(f.webhookObject(id), { type: type === 'us_bank_account' ? 'checkout.session.async_payment_succeeded' : 'checkout.session.completed' })).status, 200);
  }
  const received = f.events().filter(event => event.type === 'payment.received').map(event => [event.idempotencyKey, event.data.method, event.data.cash]).sort();
  assert.deepEqual(received, [['stripeSession:cs_test_portal_ach_1', 'ach', true], ['stripeSession:cs_test_portal_cashapp_1', 'other', true], ['stripeSession:cs_test_portal_link_1', 'card', true]]);
});

test('the commit goes to the verified job document even when the job stores a different id field', async t => {
  const f = await fixture(t, { jobs: { 'job-1': { ...crewJob, id: 'job-stale-copy' } } }), id = await f.checkout(30000, 'synthetic-stored-id'); f.complete(id, '2026-09-22T17:00:00.000Z');
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  assert.equal(f.docs.has('jobs/job-stale-copy'), false, 'nothing is written to the stored id');
  assert.deepEqual([f.commits(), f.job().payment.amount], [1, 300]);
  const [event] = f.events();
  assert.deepEqual([event.jobId, event.source, event.id], ['job-1', { collection: 'jobs', id: `job-1:stripeSessions:${id}` }, funnelEventId('payment.received', { field: 'jobId', value: 'job-1' }, `stripeSession:${id}`)]);
});

test('a Stripe read failure asks Stripe to retry and leaves the job untouched', async t => {
  const f = await fixture(t), id = await f.checkout(30000, 'synthetic-outage'); f.complete(id, '2026-09-22T17:00:00.000Z');
  f.stripeDown(true);
  const failed = await f.event(f.webhookObject(id));
  assert.equal(failed.status, 503); assert.equal(f.job().payment, undefined); assert.deepEqual([f.commits(), f.events().length], [0, 0]);
  f.stripeDown(false);
  assert.equal((await f.event(f.webhookObject(id))).status, 200); assert.deepEqual([f.commits(), f.events().length], [1, 1]);
});

test('an event that cannot be built never strands a confirmed charge: it is recorded and marked for reconciliation', async t => {
  const f = await fixture(t);
  // Hub checkout ids pass verification; this one is too short for the funnel stripeSession key.
  f.session('cs_ab1', { amount_total: 20000, client_reference_id: 'job-1', metadata: { kind: 'egc_job_payment', job_id: 'job-1', created_by: 'crew1' } });
  f.complete('cs_ab1', '2026-09-22T17:00:00.000Z');
  assert.equal((await f.event(f.webhookObject('cs_ab1'))).status, 200);
  assert.equal(f.job().payment.amount, 200); assert.equal(f.events().length, 0);
  assert.deepEqual(f.job().paymentEventIssue, { code: 'funnel_event_invalid', sessionId: 'cs_ab1', at: NOW });
});

test('with MONEY_API_ENABLED unset the payment events stay off even when FUNNEL_PAYMENT_EVENTS_ENABLED is true', async t => {
  // The Hub's browser finance tools (money API off) record payments with no event, so the funnel could never be complete.
  const { MONEY_API_ENABLED, ...partial } = env;
  const f = await fixture(t, { environment: partial }), id = await f.checkout(100000, 'synthetic-partial'); f.complete(id, '2026-09-22T17:00:00.000Z');
  const stripeReads = f.stripeCalls.length;
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  // REVIEWS-UI: the webhook always reads the session back once, expanded, so a refund is seen; the FUN-33 flags add no read.
  assert.deepEqual(f.stripeCalls.slice(stripeReads).map(call => [call.path, call.expand, call.method]), [[`/v1/checkout/sessions/${id}`, 'payment_intent.latest_charge', 'GET']], 'one expanded read-back');
  assert.deepEqual([f.commits(), f.jobPatches(), f.events().length], [0, 1, 0]);
  assert.equal('inferredKind' in f.job().payment.stripeSessions[0], false); assert.equal('paidInFullAt' in f.job(), false);
});

test('with FUNNEL_PAYMENT_EVENTS_ENABLED unset a Stripe payment patches the job alone, exactly as before', async t => {
  const { FUNNEL_PAYMENT_EVENTS_ENABLED, ...legacy } = env;
  const f = await fixture(t, { environment: legacy }), id = await f.checkout(100000, 'synthetic-legacy'); f.complete(id, '2026-09-22T17:00:00.000Z');
  const stripeReads = f.stripeCalls.length;
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  // The integration's read-back is the only Stripe call, exactly as with the FUN-33 flag on.
  assert.deepEqual(f.stripeCalls.slice(stripeReads).map(call => [call.path, call.expand, call.method]), [[`/v1/checkout/sessions/${id}`, 'payment_intent.latest_charge', 'GET']], 'one expanded read-back');
  assert.deepEqual([f.commits(), f.jobPatches(), f.events().length], [0, 1, 0]);
  const job = f.job();
  // The read-back carries the charge, so the Stripe receipt is saved exactly as on the integration tree.
  assert.equal(job.payment.amount, 1000); assert.equal(job.payment.receiptUrl, `https://pay.stripe.com/receipts/${id}`);
  assert.equal('purpose' in job.payment.stripeSessions[0], false); assert.equal('inferredKind' in job.payment.stripeSessions[0], false); assert.equal('paidInFullAt' in job, false);
});
