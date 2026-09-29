import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { customerDepositState, customerMoneyState, payable, requestTip, tipLimitCents, validTip } from '../functions/_lib/customer-payments.js';
import { customerMoneyTotals, paymentLedger } from '../functions/_lib/money-core.js';
import { reconcileLedger } from '../functions/_lib/money-ledger.js';
import { listMoney } from '../functions/_lib/money-reports.js';
import { mutateMoney } from '../functions/_lib/money-service.js';
import { moneyStorage } from '../functions/_lib/money-storage.js';
import { moneyDocumentModel } from '../functions/_lib/money-document.js';
import { summarizeFinancialJobs } from '../functions/_lib/operations-financials.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createCustomerPortalHandlers } from '../functions/api/customer-portal.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';
import * as crewPayment from '../functions/api/job-payment.js';
import { stripeReviewOverview, stripeReviewStorage } from '../functions/_lib/stripe-reviews.js';
import { stripeReviewHandlers } from '../functions/api/stripe-reviews.js';
import { computeTipAllocation } from '../functions/_lib/tip-allocation.js';

const NOW = '2026-09-22T12:00:00.000Z';
const origin = 'https://easygaragecleaning.com';
const base = {
  FIREBASE_API_KEY: 'firebase-test-customer-tipping', STRIPE_SECRET_KEY: 'sk_test_synthetic_customer_tipping', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_customer_tipping',
  CUSTOMER_PORTAL_SECRET: 'synthetic-customer-tipping-portal-secret', HUB_SESSION_SECRET: 'synthetic-customer-tipping-hub-secret',
  HUB_AUTH_USERS_JSON: JSON.stringify({ crew1: { role: 'crew', displayName: 'Synthetic Crew', passwordHash: 'synthetic-hash' }, ZacB: { role: 'owner', displayName: 'Synthetic Owner', passwordHash: 'synthetic-hash' }, TylerG: { role: 'manager', displayName: 'Synthetic Manager', passwordHash: 'synthetic-hash' } }),
};
const ON = { ...base, CUSTOMER_TIPS_ENABLED: 'true' };
// Completed work with the $500 deposit paid by card: the $500 balance is due now.
const closing = () => ({ type: 'job', customer: 'Synthetic Tip Customer', email: 'tip-customer@example.invalid', serviceType: 'Garage Turnaround', total: 1000, status: 'completed', completedAt: '2026-09-22T10:00:00.000Z',
  estimate: { status: 'accepted', amount: 1000, revision: 1, depositRequired: 500 }, customerApproval: { status: 'approved', approvedAt: '2026-09-18T16:00:00.000Z', amount: 1000 },
  deposit: { amount: 500, paidAmount: 500, status: 'paid', verified: true },
  payment: { amount: 500, verified: true, method: 'stripe', stripeSessions: [{ sessionId: 'cs_live_seed_deposit', paymentIntentId: 'pi_seed_deposit', amount: 500, purpose: 'deposit', verifiedAt: '2026-09-18T16:05:00.000Z' }] } });
const crewJob = () => ({ type: 'job', customer: 'Synthetic Crew Customer', email: 'crew-customer@example.invalid', total: 1600, status: 'in_progress', assignedCrew: ['crew1'] });

async function fixture(t, jobs = { 'job-1': closing() }, env = ON) {
  const docs = new Map(Object.entries(jobs).map(([id, value]) => [`jobs/${id}`, { value: structuredClone(value), version: 1 }]));
  const sessions = new Map(), keys = new Map(), stripePosts = [], expired = [];
  // jobPatches counts job money writes: a PATCH of the job, or a commit that writes its payment.
  let jobPatches = 0, events = 0;
  const commits = [], stripeReads = [], queries = [];
  let loseCommit = false, queryFails = false, beforeCommit = null;
  const version = row => `2026-09-22T00:00:00.${String(row.version).padStart(6, '0')}Z`;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    // A Firestore commit (the Hub resolve, or a tipped charge booked while it has no review): every precondition is
    // checked first, then all writes land together. A delete with currentDocument.exists=false is a precondition only
    // (a no-op on a missing document, ALREADY_EXISTS on one that exists), as on Firestore and its emulator.
    if (url.hostname === 'firestore.googleapis.com' && method === 'POST' && url.pathname.endsWith('/documents:commit')) {
      const writes = JSON.parse(options.body).writes, key = write => (write.update?.name || write.delete).split('/documents/')[1];
      // A concurrent writer that lands just before this commit (a race), once.
      if (beforeCommit) { const run = beforeCommit; beforeCommit = null; run(writes.map(key)); }
      for (const write of writes) {
        const row = docs.get(key(write)), pre = write.currentDocument || {};
        if (pre.exists === false && row) return Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 });
        if (pre.updateTime && (!row || version(row) !== pre.updateTime)) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
      }
      for (const write of writes) {
        if (write.delete) { docs.delete(key(write)); continue; }
        if (key(write).startsWith('jobs/') && write.update.fields.payment) jobPatches++;
        const row = docs.get(key(write)), patch = decodeFirestoreFields(write.update.fields), mask = write.updateMask?.fieldPaths || Object.keys(patch);
        docs.set(key(write), { value: { ...(row?.value || {}), ...Object.fromEntries(mask.map(name => [name, patch[name]])) }, version: (row?.version || 0) + 1 });
      }
      commits.push(writes.map(key));
      if (loseCommit) { loseCommit = false; throw new TypeError('Synthetic lost commit response'); }
      return Response.json({ writeResults: writes.map(() => ({ updateTime: NOW })) });
    }
    // A Firestore query (the open holds on a job): an equality filter over one collection.
    if (url.hostname === 'firestore.googleapis.com' && method === 'POST' && url.pathname.endsWith('/documents:runQuery')) {
      const query = JSON.parse(options.body).structuredQuery, collection = query.from[0].collectionId, filter = query.where.fieldFilter;
      queries.push({ collection, field: filter.field.fieldPath, value: filter.value.stringValue });
      if (queryFails) return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
      const rows = [...docs].filter(([key, row]) => key.startsWith(`${collection}/`) && row.value[filter.field.fieldPath] === filter.value.stringValue).slice(0, query.limit);
      return Response.json(rows.length ? rows.map(([key, row]) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/${key}`, fields: encodeFirestoreFields(row.value), updateTime: version(row) }, readTime: NOW })) : [{ readTime: NOW }]);
    }
    if (url.hostname === 'firestore.googleapis.com') {
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]); let row = docs.get(path);
      const document = (key, value) => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${key}`, fields: encodeFirestoreFields(value.value), updateTime: version(value) });
      if (method === 'GET' && !path.includes('/')) {
        const rows = [...docs].filter(([key]) => key.startsWith(`${path}/`));
        return Response.json(rows.length ? { documents: rows.map(([key, value]) => document(key, value)) } : {});
      }
      if (method === 'PATCH') {
        if (row ? url.searchParams.get('currentDocument.updateTime') !== version(row) : url.searchParams.get('currentDocument.exists') !== 'false') return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
        if (path.startsWith('jobs/')) jobPatches++;
        const mask = url.searchParams.getAll('updateMask.fieldPaths'), patch = decodeFirestoreFields(JSON.parse(options.body).fields);
        const next = mask.length ? { ...(row?.value || {}), ...Object.fromEntries(mask.map(key => [key, patch[key]])) } : { ...(row?.value || {}), ...patch };
        row = { value: path.startsWith('customer_payment_checkouts/') ? patch : next, version: (row?.version || 0) + 1 }; docs.set(path, row);
      }
      return row ? Response.json(document(path, row)) : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') {
      // Listing sessions by PaymentIntent (a charge event names only its PaymentIntent): payment_intent stays an ID.
      if (url.pathname === '/v1/checkout/sessions' && method === 'GET') {
        const wanted = url.searchParams.get('payment_intent');
        stripeReads.push(`list:${wanted}`);
        return Response.json({ object: 'list', data: [...sessions.values()].filter(session => session.payment_intent?.id === wanted).slice(0, 1).map(session => ({ ...session, payment_intent: session.payment_intent.id })), has_more: false });
      }
      if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
        const params = new URLSearchParams(options.body), key = options.headers['Idempotency-Key'];
        stripePosts.push({ key, params });
        let id = keys.get(key);
        if (id) assert.equal(params.toString(), stripePosts.find(post => post.key === key).params.toString(), 'an idempotent retry sends identical parameters');
        else {
          id = `cs_live_synthetic_tip_${sessions.size + 1}`; keys.set(key, id);
          let total = 0;
          for (let line = 0; params.has(`line_items[${line}][price_data][unit_amount]`); line++) total += Number(params.get(`line_items[${line}][price_data][unit_amount]`)) * Number(params.get(`line_items[${line}][quantity]`));
          sessions.set(id, { id, object: 'checkout.session', mode: params.get('mode'), status: 'open', payment_status: 'unpaid', currency: 'usd', amount_total: total, client_reference_id: params.get('client_reference_id'),
            metadata: Object.fromEntries([...params].filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value])), url: `https://checkout.stripe.com/c/pay/${id}`, livemode: false });
        }
        return Response.json(sessions.get(id));
      }
      const id = url.pathname.split('/')[4], session = sessions.get(id);
      if (method === 'GET') stripeReads.push(id);
      if (!session) return Response.json({}, { status: 404 });
      if (url.pathname.endsWith('/expire')) {
        if (session.status !== 'open') return Response.json({}, { status: 409 });
        expired.push(id); session.status = 'expired'; session.url = null;
      }
      return Response.json(url.searchParams.get('expand[]') === 'payment_intent.latest_charge' || !session.payment_intent ? session : { ...session, payment_intent: session.payment_intent.id });
    }
    throw new Error(`Unexpected request ${url.hostname}${url.pathname}`);
  });
  const portal = createCustomerPortalHandlers({ now: () => new Date(NOW) }), webhook = stripeWebhookHandlers({ now: () => new Date(NOW) }), verifier = crewPayment.jobPaymentVerifier({ now: () => new Date(NOW) });
  const portalCookie = async id => (await createCustomerPortalSessionCookie(env, id, { linkVersion: 0 }, Date.parse(NOW))).split(';')[0];
  const crewCookie = (await createHubSessionCookie(env, 'crew1')).split(';')[0];
  const portalRequest = async (body, id) => new Request(`${origin}/api/customer-portal`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, Cookie: await portalCookie(id), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const read = async response => ({ status: response.status, body: await response.json() });
  // Held charges, tipped or not, are resolved in Hub > Review queues (POST /api/stripe-reviews), the one resolve path.
  const reviews = stripeReviewHandlers({ now: () => new Date(NOW) }), ownerCookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0], managerCookie = (await createHubSessionCookie(env, 'TylerG')).split(';')[0];
  const hubRequest = (method, body, cookie = ownerCookie, headers = {}) => new Request(`${origin}/api/stripe-reviews`, { method, headers: { Cookie: cookie, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const f = {
    docs, sessions, stripePosts, expired, env, commits, stripeReads, crewCookie, managerCookie, queries,
    failQueries: (fails = true) => { queryFails = fails; },
    heldReviews: async (cookie = ownerCookie) => read(await reviews.get({ env, request: hubRequest('GET', null, cookie) })),
    resolve: async (body, cookie = ownerCookie, headers = {}) => read(await reviews.post({ env, request: hubRequest('POST', body, cookie, headers) })),
    review: id => docs.get(`payment_reviews/${id}`)?.value,
    edit: (patch, id = 'job-1') => { const row = docs.get(`jobs/${id}`); row.value = { ...row.value, ...patch }; row.version++; },
    loseNextCommit: () => { loseCommit = true; },
    refund: (id, amountRefunded, refunded = false) => Object.assign(sessions.get(id).payment_intent.latest_charge, { amount_refunded: amountRefunded, refunded }),
    job: (id = 'job-1') => docs.get(`jobs/${id}`).value,
    ledger: (id = 'job-1') => docs.get(`customer_payment_checkouts/${id}`)?.value,
    jobPatches: () => jobPatches,
    view: async (id = 'job-1') => read(await portal.onRequestGet({ env, request: await portalRequest(null, id) })),
    pay: async (extra = {}, id = 'job-1') => read(await portal.onRequestPost({ env, request: await portalRequest({ action: 'create_payment', request_id: `synthetic-${randomUUID()}`, ...extra }, id) })),
    verifyPortal: async (sessionId, id = 'job-1') => read(await portal.onRequestPost({ env, request: await portalRequest({ action: 'verify_payment', session_id: sessionId }, id) })),
    crewPay: async (body, key = 'synthetic-crew-request') => read(await crewPayment.onRequestPost({ env, request: new Request(`${origin}/api/job-payment`, { method: 'POST', headers: { Cookie: crewCookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: 'job-1', request_id: key, ...body }) }) })),
    crewVerify: async sessionId => read(await verifier({ env, request: new Request(`${origin}/api/job-payment?session_id=${sessionId}`, { headers: { Cookie: crewCookie, Origin: origin } }) })),
    crewConfig: async (query = 'config=tips') => read(await verifier({ env, request: new Request(`${origin}/api/job-payment?${query}`, { headers: { Cookie: crewCookie, Origin: origin } }) })),
    complete: id => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', url: null, payment_intent: { id: `pi_${id}`, latest_charge: { receipt_url: `https://pay.stripe.com/receipts/${id}` } }, customer_details: { email: 'tip-customer@example.invalid' } }),
    webhookObject: id => ({ ...sessions.get(id), payment_intent: sessions.get(id).payment_intent?.id || null }),
    async event(object, eventId = `evt_synthetic_tip_${++events}`, type = 'checkout.session.completed') {
      const timestamp = Math.floor(Date.parse(NOW) / 1000), raw = JSON.stringify({ id: eventId, type, created: timestamp, data: { object } });
      const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
      return read(await webhook.post({ env, request: new Request(`${origin}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body: raw }) }));
    },
    lastSession: () => [...sessions.values()].at(-1),
    // Stripe's charge.refunded event: a Charge naming only its PaymentIntent.
    refundEvent: id => f.event({ id: `ch_${id}`, object: 'charge', payment_intent: sessions.get(id).payment_intent.id, amount_refunded: sessions.get(id).payment_intent.latest_charge.amount_refunded || 0, refunded: sessions.get(id).payment_intent.latest_charge.refunded === true }, undefined, 'charge.refunded'),
    beforeNextCommit: run => { beforeCommit = run; },
    // The office records money on the job by hand (Estimates & payments, POST /api/money payment.record_offline).
    async recordOffline(amountCents, reference, id = 'job-1') {
      const store = moneyStorage(env), job = await store.read('jobs', id);
      return mutateMoney(store, { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' }, { action: 'payment.record_offline', requestId: randomUUID(), jobId: id, expectedRevision: job.revision, amountCents, method: 'check', reference }, NOW);
    },
  };
  return f;
}
const moneyFields = job => ({ amount: job.payment.amount, lastAmount: job.payment.lastAmount, invoice: { amount: job.invoice.amount, paid: job.invoice.paid, balance: job.invoice.balance, status: job.invoice.status },
  deposit: { amount: job.deposit.amount, paidAmount: job.deposit.paidAmount, status: job.deposit.status }, state: customerMoneyState(job), depositState: customerDepositState(job) });

test('the tip limit is half the balance or $500, whichever is more, and only whole-cent tips on a balance are valid', () => {
  assert.deepEqual([tipLimitCents(0), tipLimitCents(50000), tipLimitCents(100000), tipLimitCents(100001), tipLimitCents(250000)], [50000, 50000, 50000, 50001, 125000]);
  assert.deepEqual([requestTip(undefined), requestTip(null), requestTip(0), requestTip(1500)], [0, 0, 0, 1500]);
  for (const bad of [-1, 12.5, '1500', NaN, Infinity, {}, true]) assert.throws(() => requestTip(bad), error => error.code === 'tip_invalid' && error.status === 400, String(bad));
  assert.equal(validTip(125000, 250000), 125000);
  assert.throws(() => validTip(125001, 250000), error => error.code === 'tip_over_limit' && error.status === 400);
  assert.throws(() => validTip(1000, 50000, 'deposit'), error => error.code === 'tip_not_balance' && error.status === 409);
  assert.throws(() => validTip(1000, 49), error => error.code === 'tip_without_balance' && error.status === 409);
  assert.equal(validTip(0, 0, 'deposit'), 0, 'no tip is always valid');
});

test('a partial card charge carries a tip of at most half of itself, so it is never a tip-only checkout', () => {
  assert.deepEqual([tipLimitCents(160000, 160000), tipLimitCents(10000, 10000), tipLimitCents(160000, 100000), tipLimitCents(160000, 50), tipLimitCents(10000, 9999)], [80000, 50000, 50000, 25, 5000],
    'the $500 floor applies only when the charge pays the whole balance');
  assert.equal(tipLimitCents(160000, 200000), 80000, 'a charge above the balance is refused elsewhere; the limit never grows past the whole-balance rule');
  assert.equal(validTip(25, 160000, 'balance', 50), 25);
  assert.throws(() => validTip(50000, 160000, 'balance', 50), error => error.code === 'tip_over_limit' && error.status === 400 && /at most \$0\.25 on a partial card payment of \$0\.50/.test(error.message));
  assert.throws(() => validTip(1000, 160000, 'balance', 49), error => error.code === 'tip_without_balance');
  assert.equal(validTip(80000, 160000, 'balance', 160000), 80000, 'the whole balance keeps the portal limit');
});

test('the portal tip is a second Checkout line named for the crew and carried in the metadata', async t => {
  const f = await fixture(t), { status, body } = await f.pay({ tip_cents: 7500 });
  assert.equal(status, 200); assert.deepEqual({ amount: body.amount, tip: body.tip, purpose: body.purpose }, { amount: 500, tip: 75, purpose: 'balance' });
  const params = f.stripePosts[0].params;
  assert.deepEqual([params.get('line_items[0][price_data][unit_amount]'), params.get('line_items[1][price_data][unit_amount]'), params.get('line_items[1][quantity]'), params.get('line_items[1][price_data][currency]')], ['50000', '7500', '1', 'usd']);
  assert.equal(params.get('line_items[1][price_data][product_data][name]'), 'Tip for your crew');
  assert.deepEqual([params.get('metadata[tip_cents]'), params.get('payment_intent_data[metadata][tip_cents]'), params.get('metadata[payment_purpose]')], ['7500', '7500', 'balance']);
  assert.equal(f.lastSession().amount_total, 57500);
  assert.deepEqual({ amountCents: f.ledger().amountCents, tipCents: f.ledger().tipCents, status: f.ledger().status }, { amountCents: 50000, tipCents: 7500, status: 'open' });
  assert.match(f.ledger().fingerprint, /"tipCents":7500/, 'the tip is part of the ledger fingerprint');
});

test('ledger resume: the same tip reuses the session; a different tip, or none, expires it and opens a new one', async t => {
  const f = await fixture(t), first = await f.pay({ tip_cents: 7500 });
  const again = await f.pay({ tip_cents: 7500 });
  assert.equal(again.body.url, first.body.url); assert.equal(f.stripePosts.length, 1); assert.deepEqual(f.expired, []);
  const changed = await f.pay({ tip_cents: 10000 });
  assert.equal(changed.status, 200); assert.notEqual(changed.body.url, first.body.url); assert.equal(changed.body.tip, 100);
  assert.deepEqual(f.expired, ['cs_live_synthetic_tip_1']); assert.equal(f.lastSession().amount_total, 60000); assert.equal(f.lastSession().metadata.tip_cents, '10000');
  const none = await f.pay();
  assert.deepEqual(f.expired, ['cs_live_synthetic_tip_1', 'cs_live_synthetic_tip_2']);
  assert.equal(none.body.tip, undefined); assert.equal(f.lastSession().amount_total, 50000); assert.equal(f.lastSession().metadata.tip_cents, undefined);
  assert.equal(f.stripePosts.at(-1).params.has('line_items[1][price_data][unit_amount]'), false);
  assert.equal(f.ledger().tipCents, undefined); assert.doesNotMatch(f.ledger().fingerprint, /tipCents/, 'a checkout without a tip keeps the pre-tip fingerprint');
  assert.equal((await f.pay()).body.url, none.body.url, 'no tip resumes the untipped session');
  assert.equal(f.sessions.size, 3);
});

test('a tip never changes deposit or balance math', async t => {
  // Each fixture owns the fetch mock, so the tipped and untipped runs go one after the other.
  const settle = async (f, extra) => { const { body } = await f.pay(extra); const id = body.url.split('/').pop(); f.complete(id); assert.equal((await f.event(f.webhookObject(id))).status, 200); return id; };
  const a = await fixture(t), tippedId = await settle(a, { tip_cents: 7500 }), withTip = structuredClone(a.job());
  t.mock.restoreAll(); const b = await fixture(t); await settle(b, {}); const withoutTip = structuredClone(b.job());
  assert.deepEqual(moneyFields(withTip), moneyFields(withoutTip));
  assert.deepEqual(moneyFields(withTip).invoice, { amount: 1000, paid: 1000, balance: 0, status: 'paid' });
  assert.deepEqual(moneyFields(withTip).deposit, { amount: 500, paidAmount: 500, status: 'paid' });
  assert.equal(withTip.payment.amount, 1000, 'payment.amount holds only service money');
  // The webhook names itself as the recorder (REVIEWS-UI passes recordedBy: 'stripe_webhook').
  assert.deepEqual(withTip.payment.tips, [{ sessionId: tippedId, paymentIntentId: `pi_${tippedId}`, amountCents: 7500, amount: 75, source: 'customer_portal', createdBy: '', recordedBy: 'stripe_webhook', verifiedAt: NOW }]);
  assert.deepEqual({ amount: withTip.payment.stripeSessions.at(-1).amount, tipCents: withTip.payment.stripeSessions.at(-1).tipCents }, { amount: 500, tipCents: 7500 });
  assert.equal(withoutTip.payment.tips, undefined);
  const totals = customerMoneyTotals(withTip), untipped = customerMoneyTotals(withoutTip);
  for (const key of ['totalCents', 'revenueCents', 'appliedCents', 'recordedCents', 'balanceCents', 'depositRequiredCents', 'depositPaidCents', 'depositDueCents', 'dueNowCents', 'overpaidCents']) assert.equal(totals[key], untipped[key], key);
  assert.deepEqual([totals.tipCents, totals.paidCents, totals.appliedCents, totals.recordedCents, totals.complete], [7500, 107500, 100000, 100000, true]);
  const ledger = paymentLedger(withTip);
  assert.deepEqual(ledger.entries.map(entry => [entry.id, entry.kind, entry.amountCents, entry.source]), [['stripe:cs_live_seed_deposit', 'deposit', 50000, 'stripe_session'], [`stripe:${tippedId}`, 'balance', 50000, 'stripe_session'], [`tip:${tippedId}`, 'tip', 7500, 'stripe_tip']]);
  assert.deepEqual([ledger.unreconciledCents, ledger.complete], [0, true]);
  const stored = reconcileLedger(withTip);
  assert.deepEqual([stored.complete, stored.legacyCents, stored.entries.filter(entry => entry.kind === 'tip').length], [true, 0, 1], 'the stored payment ledger itemizes the tip without a legacy remainder');
  assert.deepEqual(reconcileLedger({ ...withTip, paymentLedger: stored.entries }).issues, [], 'a saved ledger with tip entries reads back clean');
});

test('tip-only and deposit tips are refused before Stripe is called', async t => {
  const paid = closing(); paid.payment = { ...paid.payment, amount: 1000, stripeSessions: [...paid.payment.stripeSessions, { sessionId: 'cs_live_seed_balance', paymentIntentId: 'pi_seed_balance', amount: 500, purpose: 'balance', verifiedAt: '2026-09-21T16:00:00.000Z' }] };
  const deposit = { ...closing(), status: 'scheduled', completedAt: undefined, deposit: { amount: 500, paidAmount: 0 }, payment: {} };
  const f = await fixture(t, { 'job-1': paid, 'job-2': deposit });
  const tipOnly = await f.pay({ tip_cents: 2000 });
  assert.deepEqual([tipOnly.status, tipOnly.body.code], [409, 'CUSTOMER_PORTAL_TIP_INVALID']);
  const onDeposit = await f.pay({ tip_cents: 2000 }, 'job-2');
  assert.deepEqual([onDeposit.status, onDeposit.body.code], [409, 'CUSTOMER_PORTAL_TIP_INVALID']); assert.match(onDeposit.body.error, /remaining balance/);
  for (const tip of [-100, 12.5, '2000']) assert.deepEqual([(await f.pay({ tip_cents: tip }, 'job-2')).status], [400], String(tip));
  assert.equal(f.stripePosts.length, 0);
  assert.equal((await f.pay({}, 'job-2')).status, 200, 'the deposit itself still opens without a tip');
  // The crew link needs a real charge beside any tip.
  const crew = await fixture(t, { 'job-1': crewJob() });
  assert.equal((await crew.crewPay({ amount_cents: 0, tip_cents: 2000 })).status, 400);
  assert.equal((await crew.crewPay({ amount_cents: 49, tip_cents: 2000 })).status, 400);
  assert.equal(crew.stripePosts.length, 0);
  // A $0.50 charge toward a $1,600 balance cannot carry a $500 tip: that is a tip-only checkout in all but name.
  const tiny = await crew.crewPay({ amount_cents: 50, tip_cents: 50000 });
  assert.deepEqual([tiny.status, tiny.body.code], [400, 'JOB_PAYMENT_TIP_INVALID']); assert.match(tiny.body.error, /partial card payment of \$0\.50/);
  const partialOver = await crew.crewPay({ amount_cents: 100000, tip_cents: 50001 });
  assert.deepEqual([partialOver.status, partialOver.body.code], [400, 'JOB_PAYMENT_TIP_INVALID']);
  assert.equal(crew.stripePosts.length, 0, 'nothing reaches Stripe');
  assert.equal((await crew.crewPay({ amount_cents: 50, tip_cents: 25 })).status, 200);
  assert.equal(crew.lastSession().amount_total, 75);
  assert.equal((await crew.crewPay({ amount_cents: 100000, tip_cents: 50000 })).status, 200, 'half of a partial charge is allowed');
});

test('an over-limit tip is refused on the portal and on the crew card link', async t => {
  const f = await fixture(t);
  const over = await f.pay({ tip_cents: 50001 });
  assert.deepEqual([over.status, over.body.code], [400, 'CUSTOMER_PORTAL_TIP_INVALID']); assert.match(over.body.error, /at most \$500\.00/);
  assert.equal(f.stripePosts.length, 0);
  assert.equal((await f.pay({ tip_cents: 50000 })).status, 200, 'exactly the limit is allowed');
  const crew = await fixture(t, { 'job-1': crewJob() });
  const crewOver = await crew.crewPay({ amount_cents: 160000, tip_cents: 80001 });
  assert.deepEqual([crewOver.status, crewOver.body.code], [400, 'JOB_PAYMENT_TIP_INVALID']);
  assert.equal(crew.stripePosts.length, 0);
  const crewAtLimit = await crew.crewPay({ amount_cents: 160000, tip_cents: 80000 });
  assert.equal(crewAtLimit.status, 200);
  const post = crew.stripePosts[0];
  assert.equal(post.key, 'egc-job-payment:job-1:synthetic-crew-request:tip:80000');
  assert.deepEqual([post.params.get('line_items[1][price_data][product_data][name]'), post.params.get('metadata[tip_cents]'), post.params.get('metadata[created_by]')], ['Tip for your crew', '80000', 'crew1']);
});

test('a crew device that changes the tip closes the checkout it opened before, and a paid one is verified, never charged again', async t => {
  const f = await fixture(t, { 'job-1': crewJob() });
  const stripeCalls = () => globalThis.fetch.mock.calls.filter(call => new URL(call.arguments[0]).hostname === 'api.stripe.com').map(call => [call.arguments[1]?.method || 'GET', new URL(call.arguments[0]).pathname]);
  const first = await f.crewPay({ amount_cents: 100000, tip_cents: 20000 }, 'synthetic-crew-a');
  assert.equal(first.status, 200);
  assert.deepEqual(stripeCalls(), [['POST', '/v1/checkout/sessions']], 'a request that replaces nothing makes today\'s single Stripe call');
  const changed = { amount_cents: 100000, tip_cents: 30000, replaces_session_id: first.body.sessionId };
  const second = await f.crewPay(changed, 'synthetic-crew-b');
  assert.equal(second.status, 200); assert.notEqual(second.body.sessionId, first.body.sessionId);
  assert.deepEqual(f.expired, [first.body.sessionId], 'only one checkout per job stays payable');
  // The retry of a request whose response was lost finds the earlier checkout closed and gets its own checkout back.
  const retry = await f.crewPay(changed, 'synthetic-crew-b');
  assert.deepEqual([retry.status, retry.body.sessionId, f.expired.length, f.sessions.size], [200, second.body.sessionId, 1, 2]);
  // Paid on Stripe but not on the job yet (the return and the webhook are still on their way): verify it, do not charge again.
  f.complete(second.body.sessionId); const posts = f.stripePosts.length;
  const paid = await f.crewPay({ amount_cents: 100000, replaces_session_id: second.body.sessionId }, 'synthetic-crew-c');
  assert.deepEqual([paid.status, paid.body.code, paid.body.sessionId, paid.body.url], [409, 'JOB_PAYMENT_EARLIER_CHECKOUT_PAID', second.body.sessionId, undefined]);
  assert.equal(f.stripePosts.length, posts, 'no new checkout is opened'); assert.equal(f.sessions.get(second.body.sessionId).status, 'complete');
  const verified = await f.crewVerify(second.body.sessionId);
  assert.deepEqual([verified.status, verified.body.duplicate, verified.body.tipPaid, verified.body.invoice.balance], [200, false, 300, 600]);
  // Once the paid checkout is on the job, naming it again is harmless: the rest of the balance opens normally.
  const rest = await f.crewPay({ amount_cents: 60000, replaces_session_id: second.body.sessionId }, 'synthetic-crew-d');
  assert.equal(rest.status, 200); assert.equal(f.sessions.get(second.body.sessionId).status, 'complete'); assert.equal(f.expired.length, 1);
  // Only this job's own crew checkout is ever closed; anything else named is left alone.
  const other = { status: 'open', currency: 'usd', mode: 'payment', amount_total: 5000 };
  f.sessions.set('cs_test_other_job', { ...other, id: 'cs_test_other_job', client_reference_id: 'job-2', metadata: { kind: 'egc_job_payment', job_id: 'job-2' } });
  f.sessions.set('cs_test_portal_link', { ...other, id: 'cs_test_portal_link', client_reference_id: 'job-1', metadata: { kind: 'egc_customer_portal_payment', job_id: 'job-1' } });
  for (const id of ['cs_test_other_job', 'cs_test_portal_link', 'cs_test_unknown']) assert.equal((await f.crewPay({ amount_cents: 5000, replaces_session_id: id }, `synthetic-crew-${id}`)).status, 200, id);
  assert.deepEqual([f.sessions.get('cs_test_other_job').status, f.sessions.get('cs_test_portal_link').status, f.expired.length], ['open', 'open', 1]);
  const invalid = await f.crewPay({ amount_cents: 5000, replaces_session_id: 'pi_not_a_checkout' }, 'synthetic-crew-invalid');
  assert.deepEqual([invalid.status, invalid.body.code], [400, 'JOB_PAYMENT_CHECKOUT_INVALID']);
  // A request can never replace itself: Stripe would hand back the checkout that was just closed.
  const self = await f.crewPay({ amount_cents: 60000, replaces_session_id: rest.body.sessionId }, 'synthetic-crew-d');
  assert.deepEqual([self.status, self.body.code, self.body.url], [409, 'JOB_PAYMENT_REQUEST_STALE', undefined]);
});

test('a replayed webhook and the browser returns record the tip exactly once', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 7500 }), id = body.url.split('/').pop(); f.complete(id);
  const first = await f.event(f.webhookObject(id), 'evt_synthetic_tip_completed');
  assert.deepEqual(first.body, { ok: true, received: true, recorded: true, duplicate: false });
  for (const eventId of ['evt_synthetic_tip_completed', 'evt_synthetic_tip_retry']) assert.equal((await f.event(f.webhookObject(id), eventId)).body.duplicate, true);
  const returned = await f.verifyPortal(id);
  assert.deepEqual({ status: returned.status, duplicate: returned.body.duplicate, amountPaid: returned.body.amountPaid, tipPaid: returned.body.tipPaid, balance: returned.body.balance }, { status: 200, duplicate: true, amountPaid: 500, tipPaid: 75, balance: 0 });
  assert.equal(f.jobPatches(), 1, 'one money write: the webhook reads the charge, with its receipt link, from Stripe');
  assert.equal(f.job().payment.tips.length, 1); assert.equal(f.job().payment.amount, 1000); assert.equal(f.job().payment.stripeSessions.length, 2);
  assert.equal((await f.pay({ tip_cents: 7500 })).status, 409, 'a settled job cannot be tipped again through a new checkout');
  // The crew card link records its tip once as well, whichever return lands first.
  t.mock.restoreAll();
  const crew = await fixture(t, { 'job-1': crewJob() }), link = await crew.crewPay({ amount_cents: 160000, tip_cents: 24000 }), session = link.body.sessionId; crew.complete(session);
  const verified = await crew.crewVerify(session);
  assert.deepEqual({ status: verified.status, paid: verified.body.paid, duplicate: verified.body.duplicate, tipPaid: verified.body.tipPaid, amountTotal: verified.body.amountTotal }, { status: 200, paid: true, duplicate: false, tipPaid: 240, amountTotal: 184000 });
  assert.deepEqual({ amount: verified.body.payment.amount, balance: verified.body.invoice.balance, sync: verified.body.paymentSyncPayload.amount, syncTip: verified.body.paymentSyncPayload.tipCents }, { amount: 1600, balance: 0, sync: 1600, syncTip: 24000 });
  assert.equal((await crew.event(crew.webhookObject(session))).body.duplicate, true);
  assert.equal((await crew.crewVerify(session)).body.duplicate, true);
  assert.deepEqual(crew.job().payment.tips.map(tip => [tip.amountCents, tip.source, tip.createdBy, tip.recordedBy]), [[24000, 'crew_card', 'crew1', 'crew1']]);
  assert.deepEqual({ invoice: crew.job().invoice.paid, status: crew.job().invoice.status, amount: crew.job().payment.amount }, { invoice: 1600, status: 'paid', amount: 1600 }, 'the tip over the full balance is not an overpayment');
  assert.equal(crew.job().paymentReviewRequired, undefined);
});

test('a crew charge is held against the balance by its service part only, and a held tip is kept on the review', async t => {
  const f = await fixture(t, { 'job-1': crewJob() }), link = await f.crewPay({ amount_cents: 160000, tip_cents: 20000 }), id = link.body.sessionId; f.complete(id);
  const job = f.job(); job.payment = { amount: 700, verified: true, method: 'check', stripeSessions: [] }; f.docs.get('jobs/job-1').version++;
  const held = await f.event(f.webhookObject(id));
  assert.deepEqual(held.body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_exceeds_balance' });
  assert.deepEqual({ amount: f.docs.get(`payment_reviews/${id}`).value.amountCents, tip: f.docs.get(`payment_reviews/${id}`).value.tipCents }, { amount: 180000, tip: 20000 });
  assert.equal(f.job().payment.tips, undefined);
  // The manager sees the $1,600 service part and the $200 tip apart, not one $1,800 overcharge.
  const view = await stripeReviewOverview(stripeReviewStorage(f.env), { user: 'zacb', role: 'owner', businessAccess: true }, new Date(NOW));
  assert.deepEqual(view.paymentReviews.map(row => [row.sessionId, row.amountCents, row.serviceCents, row.tipCents, row.reason]), [[id, 180000, 160000, 20000, 'payment_exceeds_balance']]);
});

test('the recorder trusts only a Hub-shaped tip in the session metadata', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 7500 }), id = body.url.split('/').pop(); f.complete(id);
  // The webhook reads the session again from Stripe, so the metadata is changed where it would have to be: in Stripe.
  const session = f.sessions.get(id), original = { ...session.metadata };
  for (const metadata of [{ tip_cents: '57500' }, { tip_cents: '57451' }, { tip_cents: '-5' }, { tip_cents: '75.00' }, { tip_cents: '9000' }]) {
    session.metadata = { ...original, ...metadata };
    assert.notEqual((await f.event(f.webhookObject(id))).status, 200, JSON.stringify(metadata));
    assert.notEqual((await f.verifyPortal(id)).status, 200, JSON.stringify(metadata));
  }
  assert.equal(f.jobPatches(), 0); assert.equal(f.job().payment.amount, 500);
  // A tampered payload alone changes nothing: the webhook records the session as Stripe holds it.
  session.metadata = original;
  assert.deepEqual((await f.event({ ...f.webhookObject(id), metadata: { ...original, tip_cents: '57500' } })).body, { ok: true, received: true, recorded: true, duplicate: false });
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips.map(tip => tip.amountCents)], [1000, [7500]]);
});

test('with CUSTOMER_TIPS_ENABLED unset the portal and crew keep today’s payments exactly', async t => {
  const f = await fixture(t, { 'job-1': closing() }, base);
  const view = await f.view();
  assert.equal(view.status, 200); assert.equal(Object.hasOwn(view.body.payment, 'tip'), false, 'the portal DTO keeps its shape');
  assert.equal(Object.hasOwn(view.body.payment, 'held'), false);
  assert.equal(globalThis.fetch.mock.calls.some(call => String(call.arguments[0]).includes('/customer_payment_checkouts/')), false, 'the portal read touches no checkout ledger');
  const refused = await f.pay({ tip_cents: 5000 });
  assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_TIPS_DISABLED']); assert.equal(f.stripePosts.length, 0);
  assert.equal((await f.pay({ tip_cents: 0 })).status, 200);
  const params = f.stripePosts[0].params;
  assert.deepEqual([...params.keys()].filter(key => /line_items\[1\]|tip/.test(key)), []);
  t.mock.restoreAll();
  const crew = await fixture(t, { 'job-1': crewJob() }, base);
  assert.deepEqual((await crew.crewConfig()).body, { ok: true, tips: { enabled: false, presets: [10, 15, 20] } });
  assert.deepEqual([(await crew.crewPay({ amount_cents: 1000, tip_cents: 100 })).body.code], ['JOB_PAYMENT_TIPS_DISABLED']);
  const plain = await crew.crewPay({ amount_cents: 1000 });
  assert.equal(plain.status, 200); assert.equal(crew.stripePosts[0].key, 'egc-job-payment:job-1:synthetic-crew-request');
  assert.equal((await crew.crewConfig('config=other')).status, 400, 'only config=tips is a config read');
  assert.deepEqual([f.queries, crew.queries], [[], []], 'no held-payment query on any path while tips are off');
});

test('with CUSTOMER_TIPS_ENABLED unset a crew request naming an earlier checkout is handled exactly as before tips', async t => {
  const f = await fixture(t, { 'job-1': crewJob() }, base);
  const stripeCalls = () => globalThis.fetch.mock.calls.filter(call => new URL(call.arguments[0]).hostname === 'api.stripe.com').map(call => [call.arguments[1]?.method || 'GET', new URL(call.arguments[0]).pathname]);
  const first = await f.crewPay({ amount_cents: 100000 }, 'synthetic-crew-a');
  const changed = await f.crewPay({ amount_cents: 90000, replaces_session_id: first.body.sessionId }, 'synthetic-crew-b');
  assert.equal(changed.status, 200); assert.notEqual(changed.body.sessionId, first.body.sessionId);
  assert.deepEqual([f.expired, f.sessions.get(first.body.sessionId).status], [[], 'open'], 'no earlier checkout is looked up or expired');
  // Even a paid checkout that is not on the job yet is not looked up: the flag-off request is today's single Stripe call.
  f.complete(changed.body.sessionId);
  const named = await f.crewPay({ amount_cents: 5000, replaces_session_id: changed.body.sessionId }, 'synthetic-crew-c');
  assert.deepEqual([named.status, named.body.code], [200, undefined]);
  assert.equal((await f.crewPay({ amount_cents: 5000, replaces_session_id: 'pi_not_a_checkout' }, 'synthetic-crew-d')).status, 200, 'the field is ignored, not validated');
  assert.deepEqual(stripeCalls(), Array(4).fill(['POST', '/v1/checkout/sessions']));
  assert.deepEqual(f.stripePosts.map(post => post.key), ['a', 'b', 'c', 'd'].map(id => `egc-job-payment:job-1:synthetic-crew-${id}`));
});

test('no tip can be added to a cancelled, superseded, lost, void-invoice or refunded job', async t => {
  const refunded = { ...crewJob(), payment: { amount: 200, verified: true, method: 'check', refundedAmount: 50 } };
  const f = await fixture(t, {
    'job-1': { ...crewJob(), status: 'cancelled', pipelineStatus: 'cancelled' }, 'job-2': { ...crewJob(), pipelineStatus: 'superseded' }, 'job-3': { ...crewJob(), status: 'Lost' },
    'job-4': { ...crewJob(), invoice: { status: 'void', amount: 1600 } }, 'job-5': refunded, 'job-6': { ...crewJob(), refunds: [{ amount: 100 }] },
  });
  for (const id of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) {
    const refused = await f.crewPay({ job_id: id, amount_cents: 100000, tip_cents: 20000 }, `synthetic-crew-${id}`);
    assert.deepEqual([refused.status, refused.body.code], [409, 'JOB_PAYMENT_TIP_UNAVAILABLE'], id);
    assert.match(refused.body.error, /tip cannot be added.*without a tip/, id);
  }
  assert.equal(f.stripePosts.length, 0, 'nothing reaches Stripe');
  t.mock.restoreAll();
  const refundedPortal = closing(); refundedPortal.refunds = [{ amount: 50, at: '2026-09-21T16:00:00.000Z' }]; refundedPortal.payment = { ...refundedPortal.payment, refundedAmount: 50 };
  const voidPortal = closing(); voidPortal.invoice = { status: 'void', amount: 1000 };
  const portal = await fixture(t, { 'job-1': refundedPortal, 'job-2': voidPortal, 'job-3': closing() });
  for (const id of ['job-1', 'job-2']) {
    assert.deepEqual((await portal.view(id)).body.payment.tip, { available: false, maxCents: 0, presets: [10, 15, 20], paidCents: 0 }, id);
    const refused = await portal.pay({ tip_cents: 5000 }, id);
    assert.deepEqual([refused.status, refused.body.code], [409, 'CUSTOMER_PORTAL_TIP_INVALID'], id);
  }
  assert.match((await portal.pay({ tip_cents: 5000 }, 'job-1')).body.error, /refund is recorded/);
  assert.equal(portal.stripePosts.length, 0);
  assert.equal((await portal.view('job-3')).body.payment.tip.available, true, 'an open job still offers the tip');
});

test('a duplicated tip row is counted once and flagged, and tips on an unverified payment are unknown, never zero', () => {
  const tipRow = { sessionId: 'cs_live_dup_tip', paymentIntentId: 'pi_dup_tip', amountCents: 7500, amount: 75, verifiedAt: '2026-09-21T16:00:00.000Z' };
  const job = (tips, extra = {}) => ({ ...closing(), completedAt: undefined, status: 'completed', payment: { amount: 900, verified: true, method: 'stripe', stripeSessions: [{ sessionId: 'cs_live_dup_pay', paymentIntentId: 'pi_dup_pay', amount: 900, verifiedAt: '2026-09-21T16:00:00.000Z' }], tips, ...extra } });
  const once = customerMoneyTotals(job([tipRow])), twice = customerMoneyTotals(job([tipRow, { ...tipRow }]));
  assert.deepEqual([once.tipCents, once.appliedCents, once.balanceCents, once.complete], [7500, 90000, 10000, true]);
  assert.deepEqual([twice.tipCents, twice.paidCents, twice.appliedCents, twice.balanceCents, twice.complete], [7500, 97500, 90000, 10000, false], 'the copy never lowers the balance');
  assert.ok(twice.issues.includes('money_tip_conflict'));
  assert.deepEqual(paymentLedger(job([tipRow, { ...tipRow }])).entries.filter(entry => entry.kind === 'tip').length, 1);
  // A copy that shares only the PaymentIntent is the same tip; copies that disagree on the amount leave the tip total unknown.
  assert.equal(customerMoneyTotals(job([tipRow, { ...tipRow, sessionId: undefined }])).balanceCents, 10000);
  const disagree = customerMoneyTotals(job([tipRow, { ...tipRow, amountCents: 9000, amount: 90 }]));
  assert.deepEqual([disagree.tipCents, disagree.balanceCents, disagree.issues.includes('money_tip_conflict'), disagree.issues.includes('money_tips_unknown')], [null, null, true, true]);
  const unverified = customerMoneyTotals(job([tipRow], { verified: false }));
  assert.deepEqual([unverified.tipCents, unverified.balanceCents, unverified.complete], [null, null, false]);
  assert.ok(unverified.issues.includes('money_tips_unknown'));
  assert.deepEqual([paymentLedger(job([tipRow], { verified: false })).tipCents, paymentLedger(job([tipRow], { verified: false })).issues.includes('money_payment_not_verified')], [null, true]);
  assert.equal(customerMoneyTotals(job([], { verified: false })).tipCents, 0, 'no tip rows stays a known zero');
});

test('a held portal payment keeps the service part and the tip apart for a manager settling it by hand', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 7500 }), id = body.url.split('/').pop(); f.complete(id);
  // An unverified crew-entered receipt lands on the job before the Stripe return does.
  Object.assign(f.job().payment, { verified: false, amount: 600, method: 'check' }); f.docs.get('jobs/job-1').version++;
  const held = await f.verifyPortal(id);
  assert.equal(held.status, 409); assert.match(held.body.error, /confirmed/);
  const receipt = f.ledger().verifiedReceipt;
  assert.deepEqual({ sessionId: receipt.sessionId, amount: receipt.amount, serviceAmount: receipt.serviceAmount, tipCents: receipt.tipCents }, { sessionId: id, amount: 575, serviceAmount: 500, tipCents: 7500 });
  assert.equal(f.ledger().requiresReview, true); assert.equal(f.job().payment.tips, undefined);
});

test('the portal offers a tip only on a payable balance, to a viewer who may pay', async t => {
  const deposit = { ...closing(), status: 'scheduled', completedAt: undefined, deposit: { amount: 500, paidAmount: 0 }, payment: {} };
  const tippedBefore = closing(); tippedBefore.payment = { ...tippedBefore.payment, tips: [{ sessionId: 'cs_live_old_tip', paymentIntentId: 'pi_old_tip', amountCents: 2500, amount: 25, verifiedAt: '2026-09-19T16:00:00.000Z' }] };
  const f = await fixture(t, { 'job-1': closing(), 'job-2': deposit, 'job-3': tippedBefore });
  assert.deepEqual((await f.view()).body.payment.tip, { available: true, maxCents: 50000, presets: [10, 15, 20], paidCents: 0 });
  assert.deepEqual((await f.view('job-2')).body.payment.tip, { available: false, maxCents: 0, presets: [10, 15, 20], paidCents: 0 });
  const earlier = (await f.view('job-3')).body.payment;
  assert.deepEqual([earlier.tip.paidCents, earlier.paid, earlier.balance, earlier.dueNow], [2500, 500, 500, 500], 'a recorded tip is shown apart from the balance');
});

test('receipts with a tip keep the Pay button on the money-core balance (M4)', async t => {
  const f = await fixture(t, { 'job-1': crewJob() }), link = await f.crewPay({ amount_cents: 100000, tip_cents: 15000 }), id = link.body.sessionId; f.complete(id);
  assert.equal((await f.event(f.webhookObject(id))).status, 200);
  const job = { ...structuredClone(f.job()), id: 'job-1', status: 'completed', completedAt: '2026-09-22T11:00:00.000Z', customerApproval: { status: 'approved', amount: 1600 }, estimate: { status: 'approved', amount: 1600, depositRequired: 800 } };
  const receipt = moneyDocumentModel(job, { kind: 'receipt', now: NOW, payUrl: '/customer-portal#pay' });
  assert.deepEqual(receipt.rows.map(row => [row.label, row.cents]), [['Service total', 160000], ['Paid toward service', 100000], ['Tips for your crew (not part of the service total)', 15000], ['Total paid', 115000], ['Balance remaining', 60000]]);
  assert.deepEqual(receipt.payments.map(row => [row.label, row.amountCents]), [['Payment · Card (Stripe)', 100000], ['Tip for your crew · Card (Stripe)', 15000]]);
  assert.equal(Math.round(payable(job).dueNow * 100), 60000, 'the portal checkout charges the money-core balance');
  assert.deepEqual(receipt.pay, { url: '/customer-portal#pay', amountCents: 60000, label: 'Pay $600.00 balance securely' });
  for (const kind of ['invoice', 'estimate']) assert.equal(moneyDocumentModel(job, { kind, now: NOW, payUrl: '/customer-portal#pay' }).pay?.amountCents, 60000, kind);
});

test('revenue summaries and money lists leave tips out of revenue and paid-toward-service', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 7500 }), id = body.url.split('/').pop(); f.complete(id);
  await f.event(f.webhookObject(id));
  const job = { ...structuredClone(f.job()), id: 'job-1', invoice: { ...f.job().invoice, number: 'INV-TIP001', issuedAt: '2026-09-22T11:30:00.000Z' } };
  const summary = summarizeFinancialJobs([job], '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  assert.deepEqual([summary.cashCollectedCents, summary.revenueSoldCents, summary.revenueCompletedCents, summary.cash.uniqueReceiptCount], [100000, 100000, 100000, 2], 'cash is the $500 deposit and $500 balance; the $75 tip is not revenue');
  assert.deepEqual(summary.exceptions, []);
  assert.equal(customerMoneyTotals(job).revenueCents, 100000);
  const store = { jobs: async () => [structuredClone(job)] };
  const invoices = await listMoney(store, { view: 'invoices' }, NOW);
  assert.deepEqual([invoices.items[0].paidCents, invoices.items[0].balanceCents], [100000, 0]);
  const payments = await listMoney(store, { view: 'payments' }, NOW);
  assert.deepEqual(payments.items.map(row => [row.kind, row.amountCents, row.source, row.ledgerComplete]), [['balance', 50000, 'stripe_session', true], ['tip', 7500, 'stripe_tip', true], ['deposit', 50000, 'stripe_session', true]]);
});

test('an offline payment after a tip grows the service total, never absorbing the tip', async t => {
  const f = await fixture(t, { 'job-1': crewJob() }), link = await f.crewPay({ amount_cents: 60000, tip_cents: 9000 }), id = link.body.sessionId; f.complete(id);
  await f.event(f.webhookObject(id));
  const docs = new Map([['jobs/job-1', { ...structuredClone(f.job()), id: 'job-1', revision: 'r0', status: 'completed', completedAt: '2026-09-22T11:00:00.000Z', estimate: { status: 'approved', amount: 1600 } }]]);
  let n = 0;
  const store = {
    read: async (collection, docId) => structuredClone(docs.get(`${collection}/${docId}`) ?? null),
    async commit(writes) {
      for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.exists ? !old : write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 }); }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision || write.exists ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
  await mutateMoney(store, owner, { action: 'payment.record_offline', requestId: randomUUID(), jobId: 'job-1', expectedRevision: 'r0', amountCents: 100000, method: 'check', reference: 'CHK-TIP-1' }, NOW);
  const saved = docs.get('jobs/job-1');
  assert.equal(saved.payment.amount, 1600, '$600 card + $1,000 check; the $90 tip stays out of payment.amount');
  assert.deepEqual(saved.payment.tips.map(tip => tip.amountCents), [9000]);
  assert.deepEqual([saved.invoice.paid, saved.invoice.balance, saved.paymentLedgerStatus], [1600, 0, 'complete']);
  assert.deepEqual(saved.paymentLedger.map(entry => [entry.kind, entry.amountCents, entry.source]).sort(), [['balance', 60000, 'stripe_session'], ['offline', 100000, 'hub_offline'], ['tip', 9000, 'stripe_tip']]);
  const totals = customerMoneyTotals(saved);
  assert.deepEqual([totals.paidCents, totals.tipCents, totals.appliedCents, totals.balanceCents, totals.complete], [169000, 9000, 160000, 0, true]);
});

// crew/postjob.html closeout: the real inline tip and card-checkout functions with a stubbed DOM, Hub fetch, storage and picker.
function closeout({ enabled = true, search = '', stored = {}, configHangs = false } = {}) {
  const html = readFileSync(new URL('../crew/postjob.html', import.meta.url), 'utf8'), lines = html.split(/\r?\n/);
  const prefixes = ['const CREW_CHECKOUT_ID=', 'function crewCheckoutRecord(', 'function crewCheckoutAttempt(', 'function crewLegacyAttempt(', 'function crewCheckoutPending(', 'async function takeStripePayment(', 'async function recordVerifiedStripePayment(', 'async function verifyStripeReturn(', 'let CREW_TIP=null;', 'function crewTipConfig(', 'async function renderCrewTip('];
  const source = prefixes.map(prefix => { const line = lines.find(row => row.startsWith(prefix)); assert.ok(line, prefix); return line; }).join('\n');
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, { id, value: '', hidden: true, listeners: {}, replaceChildren() { this.children = []; }, addEventListener(type, handler) { this.listeners[type] = handler; } }); return nodes.get(id); };
  const storage = new Map(Object.entries(stored)), replies = [], sessions = new Map();
  const state = { fetches: [], mounts: [], updates: [], statuses: [], tip: 0, assigned: null, ids: 0, replies, storage, timers: [], aborted: 0 };
  const context = vm.createContext({
    ACTIVE: { jobId: 'job-1', total: 2000, paidToDate: 0, name: 'Synthetic Crew Customer', email: 'crew-customer@example.invalid' }, JSON, Number, Math, Promise, String, URLSearchParams,
    // The closeout's timers never run on their own: a test fires them, so no real time passes.
    setTimeout: (run, ms) => state.timers.push({ run, ms, cleared: false }), clearTimeout: id => { if (state.timers[id - 1]) state.timers[id - 1].cleared = true; },
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; state.aborted++; } },
    document: { getElementById: node }, localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    uid: () => `synthetic-${++state.ids}`, location: { search, assign: url => { state.assigned = url; } }, history: { replaceState() {} },
    stripeStatus: (message, tone) => state.statuses.push([message, tone || '']), updateStripePanel() {}, saveAll() {}, syncStripePaymentToHighLevel: async () => true,
    EGCTip: { mount: (host, options) => { state.mounts.push(options); return { value: () => state.tip, update: next => state.updates.push(next) }; } },
    EGCHubAuth: { fetch: async (url, options = {}) => {
      state.fetches.push({ url, ...options });
      if (url === '/api/job-payment?config=tips') {
        if (configHangs) return new Promise((resolve, reject) => { const check = () => options.signal?.aborted ? reject(new Error('aborted')) : setImmediate(check); check(); });
        return { ok: true, json: async () => ({ ok: true, tips: { enabled, presets: [10, 15, 20] } }) };
      }
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      if (reply) return { ok: reply.ok !== false, json: async () => reply.body };
      // Like Stripe, the same request id gets the same checkout back.
      const requestId = JSON.parse(options.body).request_id, sessionId = `cs_test_crew_tip_${sessions.get(requestId) ?? sessions.set(requestId, sessions.size + 1).get(requestId)}`;
      return { ok: true, json: async () => ({ ok: true, sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}` }) };
    } },
  });
  vm.runInContext(source, context);
  const posts = () => state.fetches.filter(call => call.url === '/api/job-payment').map(call => JSON.parse(call.body));
  const record = () => JSON.parse(storage.get('egc_stripe_checkout:job-1') ?? 'null');
  return { context, state, node, posts, record };
}

test('crew closeout offers the tip picker only when the server enables it, and sends the chosen tip', async () => {
  const h = closeout(), button = { disabled: false, textContent: '' };
  h.node('j_payment_amount').value = '1500';
  await h.context.renderCrewTip(); await h.context.renderCrewTip();
  assert.equal(h.node('tip_picker').hidden, false);
  assert.deepEqual(h.state.mounts.map(({ balanceCents, maxCents, presets, idPrefix }) => ({ balanceCents, maxCents, presets: [...presets], idPrefix })), [{ balanceCents: 150000, maxCents: 75000, presets: [10, 15, 20], idPrefix: 'crew-tip' }], 'presets follow the card amount; a partial card amount caps the tip at half of it, as the server does');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.updates)), [{ balanceCents: 150000, maxCents: 75000 }]);
  assert.equal(h.state.fetches.filter(call => call.url.includes('config=tips')).length, 1, 'the tip config is read once');
  h.node('j_payment_amount').value = ''; await h.context.renderCrewTip();
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.updates.at(-1))), { balanceCents: 200000, maxCents: 100000 }, 'the whole balance keeps the half-the-balance-or-$500 limit');
  h.node('j_payment_amount').value = '1500';
  h.state.tip = null; await h.context.takeStripePayment(button);
  assert.deepEqual(h.state.statuses.at(-1), ['Fix the tip amount, or choose No tip, before taking payment.', 'bad']);
  assert.equal(h.state.fetches.some(call => call.url === '/api/job-payment'), false, 'an invalid tip never opens Stripe');
  h.state.tip = 22500; await h.context.takeStripePayment(button);
  const body = h.posts()[0];
  assert.deepEqual({ amount: body.amount_cents, tip: body.tip_cents, job: body.job_id }, { amount: 150000, tip: 22500, job: 'job-1' });
  assert.equal(h.state.assigned, 'https://checkout.stripe.com/c/pay/cs_test_crew_tip_1');
  const off = closeout({ enabled: false }), offButton = { disabled: false, textContent: '' };
  await off.context.renderCrewTip(); await off.context.takeStripePayment(offButton);
  assert.equal(off.node('tip_picker').hidden, true); assert.deepEqual(off.state.mounts, []);
  assert.deepEqual(Object.keys(off.posts()[0]).sort(), ['amount_cents', 'customer', 'email', 'job_id', 'request_id'], 'without tips the request is exactly today\'s');
});

test('crew closeout keeps one checkout per job: a retry reuses it, a changed tip or a cancel replaces it', async () => {
  const h = closeout(), button = { disabled: false, textContent: '' }, pay = async tip => { h.state.tip = tip; await h.context.takeStripePayment(button); return h.posts().at(-1); };
  h.node('j_payment_amount').value = '1500'; await h.context.renderCrewTip();
  const first = await pay(20000);
  assert.deepEqual([first.request_id, first.replaces_session_id], ['pay-synthetic-1', undefined]);
  assert.deepEqual(h.record(), { requestId: 'pay-synthetic-1', amountCents: 150000, tipCents: 20000, sessionId: 'cs_test_crew_tip_1', replaces: '' });
  const same = await pay(20000);
  assert.deepEqual([same.request_id, same.replaces_session_id], ['pay-synthetic-1', undefined], 'the same amount and tip is a retry of the same checkout');
  // A changed tip is a new request that names the checkout to close; a lost response is retried unchanged.
  h.state.replies.push(new TypeError('Failed to fetch'));
  const changed = await pay(30000);
  assert.deepEqual([changed.request_id, changed.replaces_session_id, changed.tip_cents], ['pay-synthetic-2', 'cs_test_crew_tip_1', 30000]);
  assert.equal(button.textContent, 'Retry card payment');
  const retried = await pay(30000);
  assert.deepEqual([retried.request_id, retried.replaces_session_id], ['pay-synthetic-2', 'cs_test_crew_tip_1']);
  assert.deepEqual(h.record(), { requestId: 'pay-synthetic-2', amountCents: 150000, tipCents: 30000, sessionId: 'cs_test_crew_tip_2', replaces: 'cs_test_crew_tip_1' });
  // Back from a cancelled checkout: the next card payment is a new request that closes the cancelled one.
  const back = closeout({ search: '?jobId=job-1&payment=stripe-cancelled', stored: Object.fromEntries(h.state.storage) });
  await back.context.verifyStripeReturn();
  assert.deepEqual(back.record(), { requestId: '', sessionId: '', replaces: 'cs_test_crew_tip_2' });
  back.node('j_payment_amount').value = '1500'; await back.context.renderCrewTip(); back.state.tip = 30000; await back.context.takeStripePayment({});
  assert.deepEqual([back.posts()[0].request_id, back.posts()[0].replaces_session_id], ['pay-synthetic-1', 'cs_test_crew_tip_2']);
  // Stripe had already taken the checkout being replaced: the device verifies that payment instead of opening another.
  back.state.replies.push({ ok: false, body: { ok: false, code: 'JOB_PAYMENT_EARLIER_CHECKOUT_PAID', error: 'Verify it.', sessionId: 'cs_test_crew_tip_2' } });
  await back.context.takeStripePayment({});
  assert.deepEqual([back.posts()[1].request_id, back.posts()[1].replaces_session_id], ['pay-synthetic-1', 'cs_test_crew_tip_2']);
  assert.equal(back.state.assigned, '/crew/postjob.html?jobId=job-1&payment=stripe-success&session_id=cs_test_crew_tip_2');
  assert.equal(back.record().replaces, '', 'the verified checkout is named once, so a held payment never locks the device');
  // A verified return clears the record, and the pre-tips request key is adopted for an untipped retry only.
  const done = closeout({ search: '?jobId=job-1&payment=stripe-success&session_id=cs_test_crew_tip_2', stored: Object.fromEntries(back.state.storage) });
  done.state.replies.push({ body: { ok: true, paid: true, jobId: 'job-1', sessionId: 'cs_test_crew_tip_2', payment: { amount: 1500 }, invoice: { balance: 500 }, paymentSyncPayload: { sessionId: 'cs_test_crew_tip_2' } } });
  await done.context.verifyStripeReturn();
  assert.equal(done.state.statuses.at(-1)[0], 'Payment verified in Stripe, Hub, and HighLevel.'); assert.equal(done.state.storage.size, 0);
  const legacy = closeout({ stored: { 'egc_stripe_payment_request:job-1': 'pay-legacy-request' } });
  await legacy.context.takeStripePayment({});
  assert.deepEqual([legacy.posts()[0].request_id, legacy.state.storage.has('egc_stripe_payment_request:job-1')], ['pay-legacy-request', false]);
  const legacyTip = closeout({ stored: { 'egc_stripe_payment_request:job-1': 'pay-legacy-request' } }); await legacyTip.context.renderCrewTip(); legacyTip.state.tip = 5000;
  await legacyTip.context.takeStripePayment({});
  assert.deepEqual([legacyTip.posts()[0].request_id, legacyTip.posts()[0].replaces_session_id], ['pay-synthetic-1', undefined]);
  // A request the server calls stale is dropped, so the next tap is a fresh request rather than the same refusal forever.
  const stale = closeout({ stored: { 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-old', amountCents: 200000, tipCents: 0, sessionId: 'cs_test_old', replaces: '' }) } }), staleButton = { disabled: false, textContent: '' };
  stale.state.replies.push({ ok: false, body: { ok: false, code: 'JOB_PAYMENT_REQUEST_STALE', error: 'This card payment request is out of date. Take the payment again.' } });
  await stale.context.takeStripePayment(staleButton);
  assert.deepEqual([stale.posts()[0].request_id, stale.record(), staleButton.textContent], ['pay-old', null, 'Retry card payment']);
  await stale.context.takeStripePayment(staleButton);
  assert.deepEqual([stale.posts()[1].request_id, stale.posts()[1].replaces_session_id], ['pay-synthetic-1', undefined]);
});

test('with tips off, crew closeout keeps today’s one request key per job and never names an earlier checkout', async () => {
  const h = closeout({ enabled: false }), button = { disabled: false, textContent: 'Take card payment' };
  h.node('j_payment_amount').value = '1500'; await h.context.renderCrewTip(); await h.context.takeStripePayment(button);
  h.node('j_payment_amount').value = '1000'; await h.context.takeStripePayment(button);
  assert.deepEqual(h.posts().map(body => [body.request_id, body.amount_cents, body.replaces_session_id, body.tip_cents]), [['pay-synthetic-1', 150000, undefined, undefined], ['pay-synthetic-1', 100000, undefined, undefined]], 'a changed amount reuses the request key, exactly as before tips');
  assert.deepEqual([...h.state.storage], [['egc_stripe_payment_request:job-1', 'pay-synthetic-1']], 'no checkout record is kept');
  const back = closeout({ enabled: false, search: '?jobId=job-1&payment=stripe-cancelled', stored: Object.fromEntries(h.state.storage) });
  await back.context.verifyStripeReturn();
  assert.equal(back.state.storage.size, 0, 'a cancelled checkout drops the request key, as before');
  back.node('j_payment_amount').value = '1500'; await back.context.takeStripePayment({ disabled: false, textContent: '' });
  assert.deepEqual([back.posts()[0].request_id, back.posts()[0].replaces_session_id], ['pay-synthetic-1', undefined]);
  // A checkout record left from when tips were on is not used while they are off.
  const leftover = closeout({ enabled: false, stored: { 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-old', amountCents: 150000, tipCents: 0, sessionId: 'cs_test_old', replaces: '' }) } });
  leftover.node('j_payment_amount').value = '1500'; await leftover.context.takeStripePayment({ disabled: false, textContent: '' });
  assert.deepEqual([leftover.posts()[0].request_id, leftover.posts()[0].replaces_session_id], ['pay-synthetic-1', undefined]);
});

test('a paid earlier checkout stays to be verified until verification records it or holds it for a manager', async () => {
  const stored = { 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-new', amountCents: 150000, tipCents: 30000, sessionId: '', replaces: 'cs_test_paid' }) };
  const h = closeout({ stored }), button = { disabled: false, textContent: 'Take card payment' };
  h.node('j_payment_amount').value = '1500'; await h.context.renderCrewTip(); h.state.tip = 30000;
  h.state.replies.push({ ok: false, body: { ok: false, code: 'JOB_PAYMENT_EARLIER_CHECKOUT_PAID', error: 'Verify it.', sessionId: 'cs_test_paid' } });
  await h.context.takeStripePayment(button);
  const verifyUrl = '/crew/postjob.html?jobId=job-1&payment=stripe-success&session_id=cs_test_paid';
  assert.equal(h.state.assigned, verifyUrl);
  assert.deepEqual(h.record(), { requestId: 'pay-new', amountCents: 150000, tipCents: 30000, sessionId: '', replaces: '', verify: 'cs_test_paid' });
  // Verification fails (offline, then a storage error): the paid checkout is still named, so the next tap verifies again.
  for (const reply of [new TypeError('Failed to fetch'), { ok: false, body: { ok: false, error: 'Payment information is temporarily unavailable' } }]) {
    const back = closeout({ search: '?jobId=job-1&payment=stripe-success&session_id=cs_test_paid', stored: Object.fromEntries(h.state.storage) });
    back.state.replies.push(reply); await back.context.verifyStripeReturn();
    assert.equal(back.state.statuses.at(-1)[1], 'bad'); assert.equal(back.record().verify, 'cs_test_paid');
    back.node('j_payment_amount').value = '1500'; back.state.tip = 30000; await back.context.takeStripePayment({ disabled: false, textContent: '' });
    assert.deepEqual([back.posts().length, back.state.assigned], [0, verifyUrl], 'no new checkout is opened while the paid one is unverified');
    assert.match(back.state.statuses.at(-1)[0], /Verifying the earlier card payment/);
  }
  // Held for manager review: the device keeps the charge as held, so the next tap checks it again instead of taking another card payment.
  const held = closeout({ search: '?jobId=job-1&payment=stripe-success&session_id=cs_test_paid', stored: Object.fromEntries(h.state.storage) });
  held.state.replies.push({ ok: false, body: { ok: false, code: 'payment_exceeds_balance', reviewRecorded: true, error: 'Stripe confirmed this payment, but it exceeds the current job balance. The charge is saved for manager review. Do not charge again.' } });
  await held.context.verifyStripeReturn();
  assert.deepEqual(held.state.statuses.at(-1), ['Stripe confirmed this payment, but it exceeds the current job balance. The charge is saved for manager review. Do not charge again.', 'bad']);
  assert.deepEqual(held.record(), { requestId: 'pay-new', amountCents: 150000, tipCents: 30000, sessionId: '', replaces: '', held: 'cs_test_paid' });
  held.node('j_payment_amount').value = '1500'; await held.context.renderCrewTip(); held.state.tip = 30000; await held.context.takeStripePayment({ disabled: false, textContent: '' });
  assert.deepEqual([held.posts().length, held.state.assigned], [0, verifyUrl], 'a held charge is never charged again from this device');
  assert.match(held.state.statuses.at(-1)[0], /Checking the held card payment/);
  // A cancelled checkout return never forgets a paid one still waiting to be verified.
  const cancelled = closeout({ search: '?jobId=job-1&payment=stripe-cancelled', stored: { 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-x', amountCents: 1, tipCents: 0, sessionId: 'cs_test_open', replaces: '', verify: 'cs_test_paid' }) } });
  await cancelled.context.verifyStripeReturn();
  assert.deepEqual(cancelled.record(), { requestId: '', sessionId: '', replaces: 'cs_test_open', verify: 'cs_test_paid' });
  const cancelledHeld = closeout({ search: '?jobId=job-1&payment=stripe-cancelled', stored: { 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-x', amountCents: 1, tipCents: 0, sessionId: 'cs_test_open', replaces: '', held: 'cs_test_paid' }) } });
  await cancelledHeld.context.verifyStripeReturn();
  assert.deepEqual(cancelledHeld.record(), { requestId: '', sessionId: '', replaces: 'cs_test_open', held: 'cs_test_paid' }, 'nor one held for a manager');
});

test('a held charge keeps the device from charging again whatever the tip config says, until the office resolves it', async () => {
  const verifyUrl = '/crew/postjob.html?jobId=job-1&payment=stripe-success&session_id=cs_test_held';
  // A tip hold seen on a device with no checkout record of its own still marks the charge held.
  const first = closeout({ search: '?jobId=job-1&payment=stripe-success&session_id=cs_test_held' });
  first.state.replies.push({ ok: false, body: { ok: false, code: 'payment_tip_refused', reviewRecorded: true, error: 'Stripe confirmed this payment, but the job is now closed, voided or refunded, so its tip cannot be added. The charge is saved for manager review. Do not charge again.' } });
  await first.context.verifyStripeReturn();
  assert.deepEqual(first.record(), { requestId: '', sessionId: '', replaces: '', held: 'cs_test_held' });
  // A tip config read that hangs (the case that used to fall back to a fresh request) never gets asked: the tap checks the hold.
  const slow = closeout({ configHangs: true, stored: Object.fromEntries(first.state.storage) }), button = { disabled: false, textContent: 'Check held payment' };
  slow.node('j_payment_amount').value = '1000'; await slow.context.takeStripePayment(button);
  assert.deepEqual([slow.posts().length, slow.state.assigned, slow.state.fetches.length, slow.state.timers.length], [0, verifyUrl, 0, 0]);
  const off = closeout({ enabled: false, stored: Object.fromEntries(first.state.storage) });
  off.node('j_payment_amount').value = '1000'; await off.context.takeStripePayment({ disabled: false, textContent: '' });
  assert.deepEqual([off.posts().length, off.state.assigned], [0, verifyUrl], 'with tips off too');
  // Still held when checked again: it stays held.
  const again = closeout({ search: '?jobId=job-1&payment=stripe-success&session_id=cs_test_held', stored: Object.fromEntries(first.state.storage) });
  again.state.replies.push({ ok: false, body: { ok: false, code: 'payment_tip_refused', reviewRecorded: true, error: 'Held.' } });
  await again.context.verifyStripeReturn();
  assert.equal(again.record().held, 'cs_test_held');
  // The office resolved it (refunded, or settled by hand): the charge is never booked, and the device may take the balance again.
  const resolved = closeout({ search: '?jobId=job-1&payment=stripe-success&session_id=cs_test_held', stored: Object.fromEntries(again.state.storage) });
  resolved.state.replies.push({ ok: false, body: { ok: false, code: 'payment_review_resolved', reviewRecorded: true, error: 'The office already resolved this Stripe charge, so it was not added to the job. Check with the office before charging again.' } });
  await resolved.context.verifyStripeReturn();
  assert.deepEqual(resolved.record(), { requestId: '', sessionId: '', replaces: '' });
  assert.match(resolved.state.statuses.at(-1)[0], /already resolved/);
  resolved.node('j_payment_amount').value = '1000'; await resolved.context.renderCrewTip(); resolved.state.tip = 0;
  await resolved.context.takeStripePayment({ disabled: false, textContent: '' });
  assert.deepEqual([resolved.posts().length, resolved.posts()[0].request_id, resolved.posts()[0].replaces_session_id], [1, 'pay-synthetic-1', undefined]);
});

test('a closeout refused because the job has a held charge says so and never offers to retry the charge', async () => {
  for (const [options, stored] of [[{ configHangs: true }, {}], [{}, { 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-open', amountCents: 100000, tipCents: 0, sessionId: 'cs_test_open', replaces: '' }) }]]) {
    const h = closeout({ ...options, stored }), button = { disabled: false, textContent: 'Take card payment' };
    h.node('j_payment_amount').value = '1000';
    // The one refusal for a held charge (a held tipped charge with tips on, or any with the checkout block on).
    h.state.replies.push({ ok: false, body: { ok: false, code: 'payment_review_open', error: 'A confirmed card payment on this job is waiting for manager review. Do not charge again; a manager resolves it in Hub > Review queues.' } });
    const paying = h.context.takeStripePayment(button);
    if (options.configHangs) { await new Promise(resolve => setImmediate(resolve)); h.state.timers.find(item => !item.cleared).run(); }
    await paying;
    assert.equal(h.posts().length, 1); assert.equal(h.state.assigned, null, 'no checkout is opened');
    assert.deepEqual([button.disabled, button.textContent], [false, 'Take card payment']);
    assert.deepEqual(h.state.statuses.at(-1), ['A confirmed card payment on this job is waiting for manager review. Do not charge again; a manager resolves it in Hub > Review queues.', 'bad']);
  }
});

test('a tip config read that hangs still names the checkout this device opened before, so it never opens a second one beside it', async () => {
  const stored = { 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-open', amountCents: 150000, tipCents: 20000, sessionId: 'cs_test_open', replaces: '' }) };
  const h = closeout({ configHangs: true, stored }), button = { disabled: false, textContent: 'Take card payment' };
  h.node('j_payment_amount').value = '1500';
  const paying = h.context.takeStripePayment(button);
  await new Promise(resolve => setImmediate(resolve));
  h.state.timers.find(item => !item.cleared).run(); await paying;
  assert.deepEqual(JSON.parse(JSON.stringify(h.posts()[0])), { job_id: 'job-1', request_id: 'pay-synthetic-1', amount_cents: 150000, replaces_session_id: 'cs_test_open', customer: 'Synthetic Crew Customer', email: 'crew-customer@example.invalid' }, 'no tip, and the open checkout is closed by the server');
  assert.deepEqual(h.record(), { requestId: 'pay-synthetic-1', amountCents: 150000, tipCents: 0, sessionId: 'cs_test_crew_tip_1', replaces: 'cs_test_open' });
  // The earlier checkout was already paid: verify it, never charge again.
  const paid = closeout({ configHangs: true, stored: { 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-old', amountCents: 150000, tipCents: 20000, sessionId: 'cs_test_paid', replaces: '' }) } });
  paid.node('j_payment_amount').value = '1500';
  paid.state.replies.push({ ok: false, body: { ok: false, code: 'JOB_PAYMENT_EARLIER_CHECKOUT_PAID', error: 'Verify it.', sessionId: 'cs_test_paid' } });
  const tapping = paid.context.takeStripePayment({ disabled: false, textContent: '' });
  await new Promise(resolve => setImmediate(resolve));
  paid.state.timers.find(item => !item.cleared).run(); await tapping;
  assert.equal(paid.posts()[0].replaces_session_id, 'cs_test_paid');
  assert.equal(paid.state.assigned, '/crew/postjob.html?jobId=job-1&payment=stripe-success&session_id=cs_test_paid');
  assert.equal(paid.record().verify, 'cs_test_paid');
});

test('the closeout card button offers to verify a paid earlier checkout instead of taking another payment', () => {
  const html = readFileSync(new URL('../crew/postjob.html', import.meta.url), 'utf8'), lines = html.split(/\r?\n/);
  const source = ['const CREW_CHECKOUT_ID=', 'function crewCheckoutRecord(', 'function crewCheckoutPending(', 'function updateStripePanel('].map(prefix => lines.find(row => row.startsWith(prefix))).join('\n');
  const panel = stored => {
    const storage = new Map(Object.entries(stored)), button = { disabled: false, textContent: '' }, statuses = [];
    const context = vm.createContext({ ACTIVE: { jobId: 'job-1', total: 2000, paidToDate: 500 }, JSON, Number, Math, String, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      document: { querySelector: selector => selector === '#stripe_pay button' ? button : null }, stripeStatus: (message, tone) => statuses.push([message, tone || '']), renderCrewTip() {} });
    vm.runInContext(source, context); context.updateStripePanel();
    return { button, status: statuses.at(-1) };
  };
  const plain = panel({});
  assert.deepEqual([plain.button.textContent, plain.button.disabled, plain.status[1]], ['Take card payment', false, '']);
  const pending = panel({ 'egc_stripe_checkout:job-1': JSON.stringify({ requestId: 'pay-new', sessionId: '', replaces: '', verify: 'cs_test_paid' }) });
  assert.deepEqual([pending.button.textContent, pending.button.disabled], ['Verify earlier payment', false]);
  assert.deepEqual(pending.status, ['An earlier card checkout for this job was paid but is not verified yet. Verify it before taking another payment. Do not charge again.', 'bad']);
});

test('a tip config read that hangs falls back to today’s card payment after 5 seconds, and the next tap asks again', async () => {
  const h = closeout({ configHangs: true }), button = { disabled: false, textContent: 'Take card payment' };
  h.node('j_payment_amount').value = '1500';
  const paying = h.context.takeStripePayment(button);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([button.textContent, button.disabled, h.posts().length], ['Opening Stripe…', true, 0], 'waiting on the config read');
  const timer = h.state.timers.find(item => !item.cleared);
  assert.equal(timer.ms, 5000);
  timer.run(); await paying;
  assert.equal(h.state.aborted, 1, 'the hung read is abandoned');
  assert.deepEqual(Object.keys(h.posts()[0]).sort(), ['amount_cents', 'customer', 'email', 'job_id', 'request_id'], 'the request is exactly the pre-tips one');
  assert.deepEqual([...h.state.storage], [['egc_stripe_payment_request:job-1', 'pay-synthetic-1']], 'the pre-tips request key');
  assert.equal(h.state.assigned, 'https://checkout.stripe.com/c/pay/cs_test_crew_tip_1');
  const again = h.context.crewTipConfig();
  assert.equal(h.state.fetches.filter(call => call.url === '/api/job-payment?config=tips').length, 2, 'a late read is not cached');
  h.state.timers.at(-1).run(); assert.equal(await again, null);
  // A config read that answers in time clears its timer and is kept.
  const quick = closeout(); assert.deepEqual(JSON.parse(JSON.stringify(await quick.context.crewTipConfig())), { enabled: true, presets: [10, 15, 20] });
  assert.deepEqual([quick.state.timers.length, quick.state.timers[0].cleared, quick.state.aborted], [1, true, 0]);
  await quick.context.crewTipConfig(); assert.equal(quick.state.fetches.length, 1);
});

test('no tip is added to a no-show job, and an empty refunds list is not a refund', async t => {
  const f = await fixture(t, {
    'job-1': { ...crewJob(), status: 'no_show' }, 'job-2': { ...crewJob(), pipelineStatus: 'No-Show' }, 'job-3': { ...crewJob(), status: 'noshow' },
    'job-4': { ...crewJob(), refunds: [] }, 'job-5': { ...crewJob(), payment: { amount: 0, verified: true, refunds: [] } },
  });
  for (const id of ['job-1', 'job-2', 'job-3']) {
    const refused = await f.crewPay({ job_id: id, amount_cents: 100000, tip_cents: 20000 }, `synthetic-crew-${id}`);
    assert.deepEqual([refused.status, refused.body.code], [409, 'JOB_PAYMENT_TIP_UNAVAILABLE'], id); assert.match(refused.body.error, /closed/, id);
  }
  assert.equal(f.stripePosts.length, 0, 'nothing reaches Stripe');
  for (const id of ['job-4', 'job-5']) assert.equal((await f.crewPay({ job_id: id, amount_cents: 100000, tip_cents: 20000 }, `synthetic-crew-${id}`)).status, 200, id);
  for (const refunds of [[], {}]) assert.equal(paymentLedger({ id: 'j', refunds, payment: { refunds } }).issues.includes('money_refunds_unreconciled'), false, JSON.stringify(refunds));
  assert.ok(paymentLedger({ id: 'j', refunds: [{ amount: 1 }] }).issues.includes('money_refunds_unreconciled'), 'a listed refund still counts');
  t.mock.restoreAll();
  const portal = await fixture(t, { 'job-1': { ...closing(), status: 'no_show' }, 'job-2': { ...closing(), refunds: [] } });
  assert.deepEqual((await portal.view('job-1')).body.payment.tip, { available: false, maxCents: 0, presets: [10, 15, 20], paidCents: 0 });
  const refused = await portal.pay({ tip_cents: 5000 }, 'job-1');
  assert.deepEqual([refused.status, refused.body.code, portal.stripePosts.length], [409, 'CUSTOMER_PORTAL_TIP_INVALID', 0]);
  assert.equal((await portal.pay({}, 'job-1')).status, 200, 'the balance itself stays payable, as before tips');
  assert.equal((await portal.view('job-2')).body.payment.tip.available, true);
});

test('a tipped checkout paid after its job closed is held for a manager, never booked onto the closed job', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  Object.assign(f.job(), { status: 'cancelled', pipelineStatus: 'cancelled' }); f.docs.get('jobs/job-1').version++;
  assert.equal((await f.pay({ tip_cents: 5000 })).body.error, 'This job is closed, so a tip cannot be added.', 'a new tipped checkout is refused');
  const held = await f.verifyPortal(id);
  assert.deepEqual([held.status, held.body.code, held.body.reviewRecorded], [409, 'payment_tip_refused', true]); assert.match(held.body.error, /confirmed.*do not pay again/i);
  const review = f.docs.get(`payment_reviews/${id}`).value;
  assert.deepEqual({ kind: review.kind, reason: review.reason, amount: review.amountCents, tip: review.tipCents, status: review.status, paid: review.jobPaidCents }, { kind: 'egc_customer_portal_payment', reason: 'payment_tip_refused', amount: 55000, tip: 5000, status: 'open', paid: 50000 });
  assert.deepEqual({ amount: f.job().payment.amount, tips: f.job().payment.tips, sessions: f.job().payment.stripeSessions.length }, { amount: 500, tips: undefined, sessions: 1 }, 'the job is unchanged');
  // The webhook and its replays stop at the review instead of retrying for days.
  for (const eventId of ['evt_synthetic_tip_closed', 'evt_synthetic_tip_closed_retry']) assert.deepEqual((await f.event(f.webhookObject(id), eventId)).body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_tip_refused' });
  assert.equal(f.job().payment.amount, 500);
  const view = await stripeReviewOverview(stripeReviewStorage(f.env), { user: 'zacb', role: 'owner', businessAccess: true }, new Date(NOW));
  assert.deepEqual(view.paymentReviews.map(row => [row.sessionId, row.reason, row.serviceCents, row.tipCents]), [[id, 'payment_tip_refused', 50000, 5000]]);
  // The crew link: a tipped charge on a job whose invoice was voided after the link opened is held the same way.
  t.mock.restoreAll();
  const crew = await fixture(t, { 'job-1': crewJob() }), link = await crew.crewPay({ amount_cents: 100000, tip_cents: 15000 }), session = link.body.sessionId; crew.complete(session);
  // An untipped link opened before the hold (a new one cannot open while it is held; see below).
  const plain = await crew.crewPay({ amount_cents: 20000 }, 'synthetic-crew-plain');
  crew.job().invoice = { status: 'void', amount: 1600 }; crew.docs.get('jobs/job-1').version++;
  const refused = await crew.crewVerify(session);
  assert.deepEqual([refused.status, refused.body.code, refused.body.reviewRecorded], [409, 'payment_tip_refused', true]); assert.match(refused.body.error, /saved for manager review\. Do not charge again/);
  assert.equal((await crew.event(crew.webhookObject(session))).body.reason, 'payment_tip_refused');
  assert.deepEqual({ tips: crew.job().payment?.tips, reviewTip: crew.docs.get(`payment_reviews/${session}`).value.tipCents }, { tips: undefined, reviewTip: 15000 });
  // While it is held, no new card link opens for the job.
  const posts = crew.stripePosts.length, blocked = await crew.crewPay({ amount_cents: 20000 }, 'synthetic-crew-after-hold');
  assert.deepEqual([blocked.status, blocked.body.code, crew.stripePosts.length], [409, 'payment_review_open', posts]);
  // An untipped charge is recorded as it always was: this hold is only for tips.
  crew.complete(plain.body.sessionId);
  assert.deepEqual([(await crew.crewVerify(plain.body.sessionId)).status, crew.job().payment.amount], [200, 200]);
});

test('the portal counts a repeated tip row once, as the receipt does, and an unreadable tip total as unknown', async t => {
  const row = { sessionId: 'cs_live_old_tip', paymentIntentId: 'pi_old_tip', amountCents: 7500, amount: 75, verifiedAt: '2026-09-19T16:00:00.000Z' };
  const withTips = tips => { const job = closing(); job.payment = { ...job.payment, tips }; return job; };
  const f = await fixture(t, { 'job-1': withTips([row, { ...row }]), 'job-2': withTips([row, { ...row, amountCents: 9000, amount: 90 }]), 'job-3': withTips([row]) });
  const twice = (await f.view('job-1')).body.payment;
  assert.deepEqual([twice.tip.paidCents, twice.balance], [7500, 500]);
  assert.equal(moneyDocumentModel({ ...withTips([row, { ...row }]), id: 'job-1' }, { kind: 'receipt', now: NOW }).rows.find(item => /Tips/.test(item.label)).cents, 7500, 'the receipt agrees');
  assert.equal((await f.view('job-2')).body.payment.tip.paidCents, null);
  assert.equal((await f.view('job-3')).body.payment.tip.paidCents, 7500);
});

const moneyOf = job => ({ amount: job.payment?.amount, tips: job.payment?.tips, sessions: job.payment?.stripeSessions?.length, invoice: job.invoice, deposit: job.deposit });

test('a held tipped charge refunded in Stripe is never booked after its job is restored, from any path', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.edit({ status: 'cancelled', pipelineStatus: 'cancelled' });
  const held = await f.verifyPortal(id);
  assert.deepEqual([held.status, held.body.code, held.body.reviewRecorded], [409, 'payment_tip_refused', true]);
  assert.deepEqual([f.ledger().status, f.ledger().sessionId, f.ledger().heldReason, f.ledger().heldAt], ['held', id, 'payment_tip_refused', NOW], 'the Pay button is held for the team');
  // The manager refunds the whole charge in Stripe, then restores the job.
  f.refund(id, 55000, true);
  f.edit({ status: 'completed', pipelineStatus: 'completed' });
  const before = moneyOf(f.job());
  assert.deepEqual([before.amount, before.tips, before.sessions, before.invoice], [500, undefined, 1, undefined]);
  // The customer clicks Pay: the held session is not read or verified again, and no new checkout opens.
  const reads = f.stripeReads.length, posts = f.stripePosts.length;
  const pay = await f.pay({});
  assert.deepEqual([pay.status, pay.body.code, pay.body.reviewRecorded, pay.body.alreadyPaid], [409, 'payment_review_open', true, undefined]);
  assert.match(pay.body.error, /being reviewed by our team\. Please wait for us to confirm it before paying again/);
  assert.deepEqual([f.stripeReads.length, f.stripePosts.length], [reads, posts]);
  // The browser return, the webhook and their replays hold it too, whatever the job looks like now. The refund read
  // back from Stripe comes first (REVIEWS-UI): the open review is marked refunded, keeping why it was first held.
  const again = await f.verifyPortal(id);
  assert.deepEqual([again.status, again.body.code, again.body.reviewRecorded], [409, 'payment_refunded', true]);
  for (const eventId of ['evt_synthetic_restored', 'evt_synthetic_restored_retry']) assert.deepEqual((await f.event(f.webhookObject(id), eventId)).body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.deepEqual(moneyOf(f.job()), before, 'nothing refunded is booked as paid');
  assert.deepEqual([f.review(id).status, f.review(id).reason, f.review(id).heldReason, f.review(id).refundedCents, f.review(id).tipCents], ['open', 'payment_refunded', 'payment_tip_refused', 55000, 5000], 'only a person closes it');
  const view = (await f.view()).body.payment;
  assert.deepEqual([view.held, view.dueNow, view.balance, view.tip.available], [true, 0, 500, false]);
  // No tip reaches the payroll export.
  const allocation = computeTipAllocation({ jobs: [{ ...f.job(), id: 'job-1' }], timecards: [], start: '2026-09-21', end: '2026-09-28', now: NOW });
  assert.deepEqual([allocation.jobs.length, allocation.totals.tipCents], [0, 0]);
});

test('a tipped charge Stripe shows refunded is held, never counted as paid, whichever return sees it first', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.refund(id, 5000);
  // The webhook payload carries only the PaymentIntent ID: the session is read again, with its charge, before anything is recorded.
  const reads = f.stripeReads.length, hook = await f.event(f.webhookObject(id));
  assert.deepEqual(hook.body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.deepEqual(f.stripeReads.slice(reads), [id]);
  const review = f.review(id);
  assert.deepEqual({ reason: review.reason, status: review.status, amount: review.amountCents, tip: review.tipCents, refunded: review.refundedCents, seen: review.refundSeenAt }, { reason: 'payment_refunded', status: 'open', amount: 55000, tip: 5000, refunded: 5000, seen: NOW });
  assert.equal(f.ledger().status, 'held');
  const back = await f.verifyPortal(id);
  assert.deepEqual([back.status, back.body.code, back.body.reviewRecorded], [409, 'payment_refunded', true]); assert.match(back.body.error, /refunded.*do not pay again/i);
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips, f.jobPatches()], [500, undefined, 0]);
  // A webhook that cannot read the charge makes Stripe retry; nothing is recorded blind.
  t.mock.restoreAll();
  const lost = await fixture(t), made = await lost.pay({ tip_cents: 5000 }), gone = made.body.url.split('/').pop(); lost.complete(gone);
  const object = lost.webhookObject(gone); lost.sessions.delete(gone);
  const retry = await lost.event(object);
  assert.equal(retry.status, 503); assert.deepEqual([lost.job().payment.amount, lost.review(gone), lost.jobPatches()], [500, undefined, 0]);
  // The crew card link the same way.
  t.mock.restoreAll();
  const crew = await fixture(t, { 'job-1': crewJob() }), link = await crew.crewPay({ amount_cents: 100000, tip_cents: 15000 }), session = link.body.sessionId; crew.complete(session);
  const plain = await crew.crewPay({ amount_cents: 20000 }, 'synthetic-crew-plain');
  crew.refund(session, 115000, true);
  const verified = await crew.crewVerify(session);
  assert.deepEqual([verified.status, verified.body.code, verified.body.reviewRecorded], [409, 'payment_refunded', true]); assert.match(verified.body.error, /Do not charge again/);
  assert.deepEqual([crew.job().payment, crew.review(session).refundedCents, crew.review(session).kind], [undefined, 115000, 'egc_job_payment']);
  assert.deepEqual((await crew.event(crew.webhookObject(session))).body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  // An untipped charge (its link opened before the hold) is recorded exactly as on the integration branch: its own review
  // is read once (REVIEWS-UI reads every charge's), and nothing about tips is read or written.
  crew.complete(plain.body.sessionId);
  const firestoreReads = () => globalThis.fetch.mock.calls.filter(call => String(call.arguments[0]).includes('/payment_reviews/')).length, before = firestoreReads();
  assert.deepEqual([(await crew.crewVerify(plain.body.sessionId)).status, crew.job().payment.amount, crew.job().payment.tips, firestoreReads()], [200, 200, undefined, before + 1]);
});

// Held charges, tipped or not, have one resolve path: Hub > Review queues (POST /api/stripe-reviews, REVIEWS-UI), with
// its owner-only refund, Stripe check and receipts. heldReviews() is its GET; resolve() its POST.
const reconcile = (row, note, extra = {}) => ({ action: 'payment.reconcile', requestId: randomUUID(), reviewId: row.reviewId, expectedRevision: row.revision, note, ...extra });
const recordRefund = (row, extra = {}) => ({ action: 'payment.refund', requestId: randomUUID(), reviewId: row.reviewId, expectedRevision: row.revision, reason: 'job_cancelled', ...extra });

test('a hold resolved in Review queues is final: the restored job never books it, and the portal opens the balance really due', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.edit({ status: 'cancelled', pipelineStatus: 'cancelled' });
  assert.equal((await f.verifyPortal(id)).body.code, 'payment_tip_refused');
  const list = await f.heldReviews();
  assert.equal(list.status, 200); assert.equal(list.body.coverage.complete, true);
  const [row] = list.body.paymentReviews;
  assert.deepEqual([row.sessionId, row.reviewId, row.reason, row.amountCents, row.serviceCents, row.tipCents, row.customer, row.createdBy, row.recordedOnJob], [id, id, 'payment_tip_refused', 55000, 50000, 5000, 'Synthetic Tip Customer', 'customer_portal', false]);
  // Nothing is recorded on this job: the charge was applied to the customer's next visit, so the portal later asks for this
  // job's own balance (a charge whose service part stays with this job is recorded on it first; see the partial refund test).
  // The owner says so explicitly (appliedElsewhere): without it, closing the hold would give Pay back for a balance this
  // charge may already have paid, so it is refused.
  const request = reconcile(row, 'Applied the $500 service part to the customer’s next visit (job-2); tip paid with payroll.', { actorId: 'ZacB', appliedElsewhere: true });
  const missing = await f.resolve({ ...request, requestId: randomUUID(), note: ' ' });
  assert.deepEqual([missing.status, missing.body.code], [400, 'stripe_review_invalid_field'], 'a charge not on the job needs a note');
  const unsaid = await f.resolve({ ...request, requestId: randomUUID(), appliedElsewhere: false });
  assert.deepEqual([unsaid.status, unsaid.body.code, unsaid.body.details.serviceCents, unsaid.body.details.recordedSinceCents, unsaid.body.details.jobBalanceCents, f.commits.length], [409, 'stripe_review_service_not_recorded', 50000, 0, 50000, 0]);
  const reads = f.stripeReads.length, resolved = await f.resolve(request);
  assert.equal(resolved.status, 200);
  assert.deepEqual(f.stripeReads.slice(reads), [id], 'the charge is checked in Stripe before it is closed');
  assert.deepEqual([resolved.body.replayed, resolved.body.review.status, resolved.body.review.resolution, resolved.body.review.resolvedBy, resolved.body.review.note, resolved.body.review.tipCents], [false, 'resolved', 'reconciled', 'zacb', request.note, 5000]);
  assert.deepEqual([resolved.body.review.serviceAppliedElsewhere, f.review(id).serviceAppliedElsewhere], [true, true]);
  // ONE commit: the review, the held portal checkout released under its revision, the receipt, the audit entry and the job mark.
  const commit = f.commits.at(-1);
  assert.deepEqual(commit.slice(0, 3), [`payment_reviews/${id}`, 'customer_payment_checkouts/job-1', `stripe_review_operations/${request.requestId}`]);
  assert.match(commit[3], /^hub_audit\//); assert.equal(commit[4], 'jobs/job-1');
  assert.deepEqual([f.ledger().status, f.ledger().settledBy, f.ledger().settledAt, f.job().paymentReviewResolvedAt], ['settled', 'review_resolved', NOW, NOW], 'the Pay button is released by the resolve itself');
  const audit = f.docs.get(commit[3]).value;
  assert.deepEqual([audit.action, audit.actor.id, audit.entityKey, audit.requestId], ['stripe_review.payment.reconcile', 'zacb', `payment_reviews/${id}`, request.requestId.toLowerCase()]);
  assert.equal(audit.reason, `${request.note} (its service part is not on this job: applied to another job or settled outside the Hub)`);
  // The same request replays its answer; its ID cannot be reused for another change, and a resolved hold stays resolved.
  const replay = await f.resolve(request);
  assert.deepEqual([replay.status, replay.body.replayed, f.commits.length], [200, true, 1]);
  assert.deepEqual((await f.resolve({ ...request, note: 'Different note.' })).body.code, 'stripe_review_idempotency_conflict');
  assert.deepEqual((await f.resolve({ ...request, requestId: randomUUID() })).body.code, 'stripe_review_already_resolved');
  assert.deepEqual((await f.heldReviews()).body.paymentReviews, [], 'the resolved hold leaves the queue');
  // The job is restored: the resolved charge is never booked, from any path.
  f.edit({ status: 'completed', pipelineStatus: 'completed' });
  const before = moneyOf(f.job());
  const back = await f.verifyPortal(id);
  assert.deepEqual([back.status, back.body.code, back.body.reviewRecorded], [409, 'payment_review_resolved', true]);
  // Nothing is queued for a person any more, so the webhook never says a review is required.
  assert.deepEqual((await f.event(f.webhookObject(id))).body, { ok: true, received: true, recorded: false, reviewRequired: false, reason: 'payment_review_resolved' });
  assert.deepEqual(moneyOf(f.job()), before); assert.deepEqual([before.amount, before.tips, before.sessions], [500, undefined, 1]);
  // The portal GET shows Pay again (nothing held, the balance due now), and Pay opens a new checkout for it.
  const view = (await f.view()).body.payment;
  assert.deepEqual([view.held, view.dueNow], [false, 500]);
  const pay = await f.pay({});
  assert.equal(pay.status, 200); assert.notEqual(pay.body.url.split('/').pop(), id); assert.equal(pay.body.amount, 500);
  assert.equal(f.review(id).status, 'resolved');
});

test('held is derived from the review: a lost mark still stops Pay, and a mark left after a resolve never holds it', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.edit({ status: 'cancelled', pipelineStatus: 'cancelled' });
  assert.equal((await f.event(f.webhookObject(id))).body.reason, 'payment_tip_refused');
  assert.equal(f.ledger().status, 'held', 'the webhook marks the portal checkout held too');
  const mark = status => { const row = f.docs.get('customer_payment_checkouts/job-1'); row.value = { ...row.value, status }; row.version++; };
  mark('open'); f.edit({ status: 'completed', pipelineStatus: 'completed' });
  // The mark is lost: Pay still finds the open hold from the review before Stripe is read, and writes nothing.
  const reads = f.stripeReads.length, posts = f.stripePosts.length, ledgerVersion = f.docs.get('customer_payment_checkouts/job-1').version, refused = await f.pay({});
  assert.deepEqual([refused.status, refused.body.code, refused.body.reviewRecorded], [409, 'payment_review_open', true]);
  assert.deepEqual([f.ledger().status, f.docs.get('customer_payment_checkouts/job-1').version], ['open', ledgerVersion], 'Pay no longer writes a held mark: the review decides');
  assert.deepEqual([(await f.view()).body.payment.held, (await f.view()).body.payment.dueNow], [true, 0]);
  assert.deepEqual([f.stripeReads.length, f.stripePosts.length], [reads, posts], 'held: no Stripe read and no new checkout');
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips], [500, undefined]);
  // The office resolves it while the ledger is not marked, so the resolve leaves the ledger alone; a lost commit response
  // is confirmed from the receipt, not saved twice.
  const [row] = (await f.heldReviews()).body.paymentReviews;
  f.loseNextCommit();
  const resolved = await f.resolve(reconcile(row, 'Customer asked us to keep the tip; service settled in cash outside the Hub.', { appliedElsewhere: true }));
  assert.deepEqual([resolved.status, resolved.body.replayed, f.commits.length, f.commits[0].includes('customer_payment_checkouts/job-1')], [200, false, 1, false]);
  // A held mark that lands after the resolve (a Pay or return that read the review just before it) never holds Pay:
  // the portal reads the review, shows the balance due and settles the stale mark.
  mark('held');
  const view = (await f.view()).body.payment;
  assert.deepEqual([view.held, view.dueNow, f.ledger().status, f.ledger().settledBy], [false, 500, 'settled', 'review_resolved']);
  mark('held');
  const pay = await f.pay({});
  assert.equal(pay.status, 200); assert.notEqual(pay.body.url.split('/').pop(), id);
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips, f.job().payment.stripeSessions.length], [500, undefined, 1]);
  // A held mark whose review cannot be found fails closed.
  t.mock.restoreAll();
  const lost = await fixture(t);
  lost.docs.set('customer_payment_checkouts/job-1', { value: { status: 'held', sessionId: 'cs_test_missing_review', amountCents: 50000, tipCents: 5000 }, version: 1 });
  assert.deepEqual([(await lost.view()).body.payment.held, (await lost.pay({})).body.code], [true, 'payment_review_open']);
});

test('a held tipped crew charge is settled in Review queues: refunds are the owner\'s, checked in Stripe, and the tip kept is never service money', async t => {
  const f = await fixture(t, { 'job-1': crewJob() }), link = await f.crewPay({ amount_cents: 100000, tip_cents: 15000 }), id = link.body.sessionId; f.complete(id);
  f.edit({ invoice: { status: 'void', amount: 1600 } });
  assert.equal((await f.crewVerify(id)).body.code, 'payment_tip_refused');
  // Owners and operations managers only, from the Hub.
  assert.deepEqual([(await f.heldReviews('')).status, (await f.heldReviews(f.crewCookie)).status], [401, 403]);
  const [row] = (await f.heldReviews()).body.paymentReviews;
  assert.deepEqual([row.sessionId, row.reason, row.serviceCents, row.tipCents, row.createdBy], [id, 'payment_tip_refused', 100000, 15000, 'crew1']);
  const request = recordRefund(row);
  assert.deepEqual([(await f.resolve(request, f.crewCookie)).status, (await f.resolve(request, undefined, { Origin: 'https://evil.example.invalid' })).status, (await f.resolve(JSON.stringify(request), undefined, { 'Content-Type': 'text/plain' })).status], [403, 403, 415]);
  assert.deepEqual([(await f.resolve({ ...request, requestId: 'not-a-uuid' })).body.code, (await f.resolve({ ...request, extra: true })).body.code, (await f.resolve({ ...request, reason: 'ignored' })).body.code], ['stripe_review_request_invalid', 'stripe_review_request_invalid', 'stripe_review_invalid_field']);
  // A manager cannot record a refund, and once Stripe shows one cannot reconcile it either (PROBE 3): the owner settles it.
  assert.deepEqual((await f.resolve(recordRefund(row), f.managerCookie)).body.code, 'stripe_review_owner_required');
  // Stripe must show the refund first; nothing is saved until then.
  assert.deepEqual((await f.resolve(request)).body.code, 'stripe_review_refund_not_found');
  f.refund(id, 15000);
  const manager = await f.resolve(reconcile(row, 'handled'), f.managerCookie);
  assert.deepEqual([manager.status, manager.body.code], [403, 'stripe_review_owner_required']);
  const shown = await f.resolve(reconcile(row, 'handled'));
  assert.deepEqual([shown.status, shown.body.code, shown.body.details], [409, 'stripe_review_refund_shown', { amountCents: 115000, refundedCents: 15000, keptCents: 100000, keptServiceCents: 85000, keptTipCents: 15000, recordedOnJob: false }]);
  // A partial refund: the owner confirms the exact amount kept, shown split so the kept tip is never recorded as service.
  const partial = await f.resolve({ ...request, requestId: randomUUID() });
  assert.deepEqual([partial.status, partial.body.code, partial.body.details], [409, 'stripe_review_refund_partial', { amountCents: 115000, refundedCents: 15000, keptCents: 100000, keptServiceCents: 85000, keptTipCents: 15000 }]);
  assert.match(partial.body.error, /Up to \$150\.00 of it is the crew tip, which is never a service payment\. First record its service part on the job under Estimates & payments \(\$850\.00 if the refund came out of the service first, or \$1,000\.00 if the crew tip was refunded first\), then confirm the amount kept here/);
  const stale = await f.resolve({ ...request, requestId: randomUUID(), keptCentsAcknowledged: 100000, expectedRevision: '2026-09-22T00:00:00.000099Z' });
  assert.deepEqual([stale.status, stale.body.code], [409, 'stripe_review_revision_conflict']);
  assert.deepEqual([f.review(id).status, f.commits.length], ['open', 0]);
  // Once a return sees the refund, the review is marked refunded (keeping why it was first held) and the queue shows the split.
  assert.equal((await f.crewVerify(id)).body.code, 'payment_refunded');
  const current = (await f.heldReviews()).body.paymentReviews[0];
  assert.deepEqual([current.reason, current.heldReason, current.refundedCents, current.keptCents, current.keptServiceCents, current.keptTipCents], ['payment_refunded', 'payment_tip_refused', 15000, 100000, 85000, 15000], 'the queue shows the kept split too');
  // The owner refunded the tip: the whole $1,000 service part was kept, and it must be on the job before the review closes.
  const early = await f.resolve({ ...recordRefund(current), keptCentsAcknowledged: 100000, tipRefundedFirst: true, note: 'Refunded the tip; service recorded by hand.' });
  assert.deepEqual([early.status, early.body.code, early.body.details.keptServiceCents, early.body.details.keptTipCents, early.body.details.recordedSinceCents], [409, 'stripe_review_kept_not_recorded', 100000, 0, 0]);
  assert.match(early.body.error, /Record the \$1,000\.00 service part kept on the job under Estimates & payments first \(the crew tip was refunded first\)/);
  assert.deepEqual([f.review(id).status, f.commits.length], ['open', 0], 'nothing is saved');
  assert.equal((await f.resolve({ ...recordRefund(current), keptCentsAcknowledged: 100000, tipRefundedFirst: 'yes' })).body.code, 'stripe_review_invalid_field');
  await f.recordOffline(100000, 'CHK-1150');
  const done = await f.resolve({ ...recordRefund(current), keptCentsAcknowledged: 100000, tipRefundedFirst: true, note: 'Refunded the tip; service recorded by hand.' });
  assert.equal(done.status, 200);
  assert.deepEqual([f.review(id).resolution, f.review(id).refundedCents, f.review(id).refundFull, f.review(id).keptCents, f.review(id).keptServiceCents, f.review(id).keptTipCents, f.review(id).tipRefundedFirst], ['refunded', 15000, false, 100000, 100000, 0, true]);
  assert.deepEqual([done.body.review.keptServiceCents, done.body.review.keptTipCents, done.body.review.tipCents, done.body.review.tipRefundedFirst], [100000, 0, 15000, true]);
  assert.deepEqual(f.commits.at(-1).filter(key => !key.startsWith('hub_audit/')), [`payment_reviews/${id}`, `stripe_review_operations/${f.review(id).resolveRequestId.toLowerCase()}`, 'jobs/job-1'], 'a crew hold has no portal checkout to release');
  // The invoice is issued again: the crew return and the webhook never book the refunded charge.
  f.edit({ invoice: { status: 'sent', amount: 1600 } });
  const back = await f.crewVerify(id);
  assert.deepEqual([back.status, back.body.code, back.body.reviewRecorded], [409, 'payment_review_resolved', true]); assert.match(back.body.error, /already resolved this Stripe charge.*Do not charge again/);
  assert.equal((await f.event(f.webhookObject(id))).body.reason, 'payment_review_resolved');
  // Only the $1,000 check the office recorded is on the job: never the refunded charge or its tip.
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips, (f.job().payment.stripeSessions || []).some(row => row.sessionId === id)], [1000, undefined, false]);
});

// Resolving a review gives the customer Pay back in the same commit, so the service part a partial refund kept is recorded
// on the job FIRST, while the review still holds Pay; the refund is recorded only once it is there.
test('a partly refunded tipped charge is closed only after its kept service part is on the job, so Pay then asks only for the true remainder', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.refund(id, 20000);
  const held = await f.verifyPortal(id);
  assert.deepEqual([held.status, held.body.code], [409, 'payment_refunded']);
  assert.deepEqual([(await f.view()).body.payment.held, f.ledger().status], [true, 'held']);
  const [row] = (await f.heldReviews(f.managerCookie)).body.paymentReviews;
  assert.deepEqual([row.recordedOnJob, row.keptCents, row.keptServiceCents, row.keptTipCents, row.jobPaidCents], [false, 35000, 30000, 5000, 50000]);
  assert.equal((await f.resolve(recordRefund(row, { keptCentsAcknowledged: 35000 }), f.managerCookie)).body.code, 'stripe_review_owner_required');
  // The owner is told to record the service part first...
  const partial = await f.resolve(recordRefund(row));
  assert.deepEqual([partial.status, partial.body.code], [409, 'stripe_review_refund_partial']);
  assert.match(partial.body.error, /First record its service part on the job under Estimates & payments \(\$300\.00 if the refund came out of the service first, or \$350\.00 if the crew tip was refunded first\), then confirm the amount kept here/);
  // ...and cannot close the review (which gives Pay back) until it is there.
  const early = await f.resolve(recordRefund(row, { keptCentsAcknowledged: 35000 }));
  assert.deepEqual([early.status, early.body.code, early.body.details.keptServiceCents, early.body.details.recordedSinceCents, early.body.details.jobBalanceCents], [409, 'stripe_review_kept_not_recorded', 30000, 0, 50000]);
  assert.match(early.body.error, /^Record the \$300\.00 service part kept on the job under Estimates & payments first: .*Pay button would ask again for money this charge already paid\. Then record the refund\. Nothing was saved\.$/);
  assert.deepEqual([f.review(id).status, f.ledger().status, (await f.view()).body.payment.held], ['open', 'held', true]);
  // Recording the service part while the review is open never opens Pay: the review still holds it.
  await f.recordOffline(30000, 'KEPT-300');
  assert.deepEqual([f.job().payment.amount, f.job().invoice.balance, f.job().payment.tips], [800, 200, undefined]);
  const posts = f.stripePosts.length, stillHeld = (await f.view()).body.payment;
  assert.deepEqual([stillHeld.held, stillHeld.dueNow, (await f.pay({})).body.code, f.stripePosts.length], [true, 0, 'payment_review_open', posts]);
  // Now the refund is recorded: the review closes, the ledger is released, and Pay asks only for the $200 really due.
  const done = await f.resolve(recordRefund(row, { keptCentsAcknowledged: 35000, note: 'Refunded $200 of the service; $300 recorded by check.' }));
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.review.keptServiceCents, done.body.review.keptTipCents, done.body.review.tipRefundedFirst], [30000, 5000, undefined]);
  assert.deepEqual([f.review(id).status, f.ledger().status], ['resolved', 'settled']);
  const view = (await f.view()).body.payment;
  assert.deepEqual([view.held, view.dueNow, view.balance], [false, 200, 200]);
  const pay = await f.pay({});
  assert.deepEqual([pay.status, pay.body.amount, f.lastSession().amount_total], [200, 200, 20000], 'the $300 the refunded charge kept is never asked for again');
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips, f.job().payment.stripeSessions.some(item => item.sessionId === id)], [800, undefined, false]);
});

test('a refund the owner says was the crew tip keeps the whole service part, which must be on the job before the review closes', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.refund(id, 5000);
  assert.equal((await f.verifyPortal(id)).body.code, 'payment_refunded');
  const [row] = (await f.heldReviews()).body.paymentReviews;
  // Stripe does not say which part it refunded: the queue reads it as the service first (the tip kept), never booking a kept tip as service.
  assert.deepEqual([row.keptCents, row.keptServiceCents, row.keptTipCents], [50000, 45000, 5000]);
  // The customer asked to drop the tip: the owner says so, so the whole $500 service part was kept.
  const early = await f.resolve(recordRefund(row, { keptCentsAcknowledged: 50000, tipRefundedFirst: true }));
  assert.deepEqual([early.body.code, early.body.details.keptServiceCents, early.body.details.keptTipCents], ['stripe_review_kept_not_recorded', 50000, 0]);
  await f.recordOffline(45000, 'SERVICE-450');
  const short = await f.resolve(recordRefund(row, { keptCentsAcknowledged: 50000, tipRefundedFirst: true }));
  assert.deepEqual([short.body.code, short.body.details.recordedSinceCents], ['stripe_review_kept_not_recorded', 45000], 'the service-first amount is not the whole service part');
  assert.match(short.body.error, /the job's payments have grown by \$450\.00 since this charge was held/);
  await f.recordOffline(5000, 'SERVICE-50');
  const done = await f.resolve(recordRefund(row, { keptCentsAcknowledged: 50000, tipRefundedFirst: true, reason: 'customer_request' }));
  assert.equal(done.status, 200);
  assert.deepEqual([f.review(id).keptServiceCents, f.review(id).keptTipCents, f.review(id).tipRefundedFirst], [50000, 0, true]);
  // The whole balance is paid: the customer is never asked for the $50 of service the charge already paid.
  const view = (await f.view()).body.payment;
  assert.deepEqual([view.held, view.dueNow, view.balance], [false, 0, 0]);
});

test('a tipped charge is booked only while it has no review: a refund review created during the booking holds it instead', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  // A webhook that read Stripe after a refund records its review between this return's reads and its booking commit.
  let raced = null;
  f.beforeNextCommit(keys => { raced = keys; f.docs.set(`payment_reviews/${id}`, { value: { sessionId: id, jobId: 'job-1', kind: 'egc_customer_portal_payment', reason: 'payment_refunded', status: 'open', amountCents: 55000, tipCents: 5000, refundedCents: 20000, jobPaidCents: 50000, createdAt: NOW }, version: 1 }); });
  const back = await f.verifyPortal(id);
  assert.deepEqual(raced, ['jobs/job-1', `payment_reviews/${id}`], 'the booking carries a precondition on the review');
  assert.deepEqual([back.status, back.body.code, back.body.reviewRecorded], [409, 'payment_refunded', true]);
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips, f.job().payment.stripeSessions.length, f.jobPatches()], [500, undefined, 1, 0], 'the refunded tipped charge is never booked');
  assert.deepEqual([f.review(id).status, (await f.view()).body.payment.held], ['open', true]);
  // Without a race the same commit books it and leaves no review behind.
  t.mock.restoreAll();
  const g = await fixture(t), made = await g.pay({ tip_cents: 5000 }), session = made.body.url.split('/').pop(); g.complete(session);
  assert.equal((await g.verifyPortal(session)).status, 200);
  assert.deepEqual([g.job().payment.amount, g.job().payment.tips.map(tip => tip.amountCents), g.review(session), g.jobPatches()], [1000, [5000], undefined, 1]);
  // An untipped charge keeps its single job PATCH, exactly as before tips.
  t.mock.restoreAll();
  const plain = await fixture(t), open = await plain.pay({}), untipped = open.body.url.split('/').pop(); plain.complete(untipped);
  assert.equal((await plain.verifyPortal(untipped)).status, 200);
  const calls = globalThis.fetch.mock.calls.map(call => ({ url: String(call.arguments[0]), method: call.arguments[1]?.method || 'GET' }));
  assert.deepEqual([calls.filter(call => call.url.includes(':commit')).length, calls.filter(call => call.method === 'PATCH' && call.url.includes('/documents/jobs/')).length, plain.job().payment.amount], [0, 1, 1000]);
});

// FUN-33: with the payment events on, the booking is one moneyStorage :commit (the job and its funnel events) that
// still carries the "no review yet" precondition, as a precondition-only delete of payment_reviews/{sessionId}. The
// same race therefore holds the charge: nothing is booked and no payment or payoff event is written for money Stripe
// shows refunded.
test('with FUN-33 payment events on, a tipped charge is still booked only while it has no review', async t => {
  const EVENTS = { ...ON, FUNNEL_PAYMENT_EVENTS_ENABLED: 'true', MONEY_API_ENABLED: 'true' };
  const funnelEvents = h => [...h.docs].filter(([key]) => key.startsWith('funnelEvents/')).map(([, row]) => row.value);
  const f = await fixture(t, undefined, EVENTS), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  let raced = null;
  f.beforeNextCommit(keys => { raced = keys; f.docs.set(`payment_reviews/${id}`, { value: { sessionId: id, jobId: 'job-1', kind: 'egc_customer_portal_payment', reason: 'payment_refunded', status: 'open', amountCents: 55000, tipCents: 5000, refundedCents: 20000, jobPaidCents: 50000, createdAt: NOW }, version: 1 }); });
  const back = await f.verifyPortal(id);
  assert.deepEqual(raced.slice(0, 2), ['jobs/job-1', `payment_reviews/${id}`], 'the booking carries the precondition on the review');
  assert.deepEqual(raced.slice(2).map(key => key.split('/')[0]), ['funnelEvents', 'funnelEvents'], 'beside its payment.received and job.paid_in_full');
  assert.deepEqual([back.status, back.body.code, back.body.reviewRecorded], [409, 'payment_refunded', true]);
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips, f.job().payment.stripeSessions.length, f.job().paidInFullAt, f.jobPatches()], [500, undefined, 1, undefined, 0], 'the refunded tipped charge is never booked');
  assert.deepEqual(funnelEvents(f), [], 'no payment or payoff event for money Stripe shows refunded');
  assert.deepEqual([f.review(id).status, f.review(id).reason, (await f.view()).body.payment.held], ['open', 'payment_refunded', true]);
  // Without a race the same commit books it with its events and leaves no review behind.
  t.mock.restoreAll();
  const g = await fixture(t, undefined, EVENTS), made = await g.pay({ tip_cents: 5000 }), session = made.body.url.split('/').pop(); g.complete(session);
  assert.equal((await g.verifyPortal(session)).status, 200);
  assert.deepEqual([g.job().payment.amount, g.job().payment.tips.map(tip => tip.amountCents), g.review(session), g.jobPatches(), g.job().paidInFullAt], [1000, [5000], undefined, 1, NOW]);
  assert.deepEqual(g.commits.at(-1).slice(0, 2), ['jobs/job-1', `payment_reviews/${session}`]);
  const booked = funnelEvents(g).sort((a, b) => a.type.localeCompare(b.type));
  assert.deepEqual(booked.map(event => [event.type, event.data.amountCents, event.data.tipCents, event.idempotencyKey]), [
    ['job.paid_in_full', 100000, undefined, `stripeSession:${session}`], ['payment.received', 50000, 5000, `stripeSession:${session}`],
  ], 'one payment event for the service money, with the crew tip beside it');
  // An untipped charge carries no review write: the job and its events only.
  t.mock.restoreAll();
  const plain = await fixture(t, undefined, EVENTS), open = await plain.pay({}), untipped = open.body.url.split('/').pop(); plain.complete(untipped);
  assert.equal((await plain.verifyPortal(untipped)).status, 200);
  assert.deepEqual(plain.commits.at(-1).map(key => key.split('/')[0]), ['jobs', 'funnelEvents', 'funnelEvents']);
  assert.deepEqual([plain.job().payment.amount, plain.jobPatches()], [1000, 1]);
});

test('with tips on, Stripe’s charge.refunded brings a refund on a tipped charge to Review queues and tip payroll without a return', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  assert.equal((await f.verifyPortal(id)).status, 200);
  f.refund(id, 5000);
  const reads = f.stripeReads.length, hook = await f.refundEvent(id);
  assert.deepEqual(hook.body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.deepEqual(f.stripeReads.slice(reads), [`list:pi_${id}`, id], 'the checkout is found by its PaymentIntent, then read again with its charge');
  assert.deepEqual([f.review(id).reason, f.review(id).status, f.review(id).tipCents, f.review(id).refundedCents, f.review(id).recordedBy], ['payment_refunded', 'open', 5000, 5000, 'stripe_webhook']);
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips.length], [1000, 1], 'the job is unchanged');
  const allocation = computeTipAllocation({ jobs: [{ ...f.job(), id: 'job-1' }], timecards: [], start: '2026-09-21', end: '2026-09-28', now: NOW, refundReviews: new Map([['job-1', [f.review(id)]]]) });
  assert.deepEqual([allocation.jobs[0].reasons.includes('tip_refund_open'), allocation.totals.allocatedCents], [true, 0], 'tip payroll holds the tip');
  assert.equal((await f.refundEvent(id)).body.reason, 'payment_refunded', 'a redelivery finds the same review');
  // The owner records it, saying the crew tip was refunded; Stripe then refunds $200 more: a follow-up names what the first record kept.
  const [row] = (await f.heldReviews()).body.paymentReviews;
  assert.equal(row.recordedOnJob, true);
  assert.equal((await f.resolve(recordRefund(row, { jobPaymentAcknowledged: true, tipRefundedFirst: true, reason: 'customer_request' }))).status, 200);
  assert.deepEqual([f.review(id).keptServiceCents, f.review(id).keptTipCents, f.review(id).tipRefundedFirst], [50000, 0, true]);
  f.refund(id, 25000);
  assert.equal((await f.refundEvent(id)).body.reason, 'payment_refunded');
  const followUp = f.review(`${id}:refund`);
  assert.deepEqual([followUp.priorRefundedCents, followUp.priorKeptServiceCents, followUp.priorKeptTipCents, followUp.refundedCents, followUp.tipCents], [5000, 50000, 0, 25000, 5000]);
  const [next] = (await f.heldReviews()).body.paymentReviews;
  assert.deepEqual([next.reviewId, next.recordedOnJob, next.keptServiceCents, next.keptTipCents, next.priorKeptServiceCents, next.priorKeptTipCents], [`${id}:refund`, true, 30000, 0, 50000, 0], 'the $200 more came out of the service');
  // A crew card charge the same way.
  t.mock.restoreAll();
  const crew = await fixture(t, { 'job-1': crewJob() }), link = await crew.crewPay({ amount_cents: 100000, tip_cents: 15000 }), session = link.body.sessionId; crew.complete(session);
  assert.equal((await crew.crewVerify(session)).status, 200);
  crew.refund(session, 115000, true);
  assert.equal((await crew.refundEvent(session)).body.reason, 'payment_refunded');
  assert.deepEqual([crew.review(session).kind, crew.review(session).tipCents, crew.review(session).refundedCents], ['egc_job_payment', 15000, 115000]);
  // An untipped charge, a charge that is not a Hub checkout, and any charge with tips off are acknowledged and ignored, as before.
  t.mock.restoreAll();
  const plain = await fixture(t), open = await plain.pay({}), untipped = open.body.url.split('/').pop(); plain.complete(untipped);
  assert.equal((await plain.verifyPortal(untipped)).status, 200);
  plain.refund(untipped, 10000);
  assert.deepEqual((await plain.refundEvent(untipped)).body, { ok: true, received: true, ignored: true });
  assert.deepEqual((await plain.event({ id: 'ch_other', object: 'charge', payment_intent: 'pi_not_a_hub_checkout' }, undefined, 'charge.refunded')).body, { ok: true, received: true, ignored: true });
  assert.deepEqual((await plain.event({ id: 'ch_no_intent', object: 'charge', payment_intent: null }, undefined, 'charge.refunded')).body, { ok: true, received: true, ignored: true });
  assert.equal(plain.review(untipped), undefined);
  t.mock.restoreAll();
  const off = await fixture(t, { 'job-1': closing() }, base), made = await off.pay({}), offSession = made.body.url.split('/').pop(); off.complete(offSession);
  assert.equal((await off.verifyPortal(offSession)).status, 200);
  off.refund(offSession, 10000);
  const before = off.stripeReads.length;
  assert.deepEqual((await off.refundEvent(offSession)).body, { ok: true, received: true, ignored: true });
  assert.deepEqual([off.stripeReads.length, off.review(offSession)], [before, undefined], 'tips off: nothing is read from Stripe');
});

test('held charges are server-only records, resolved only through Review queues', async () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/payment_reviews\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
  assert.match(rules, /match \/stripe_review_operations\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
  assert.doesNotMatch(rules, /tip_review_operations/, 'no second resolve path keeps receipts');
  for (const path of ['../functions/api/tip-reviews.js', '../functions/_lib/tip-reviews.js']) assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
});

test('with tips on, a held tipped crew charge stops every new card checkout for its job, from any device and the portal, until it is resolved', async t => {
  const f = await fixture(t, { 'job-1': { ...closing(), assignedCrew: ['crew1'] } });
  const link = await f.crewPay({ amount_cents: 50000, tip_cents: 5000 }, 'pay-tipped'), id = link.body.sessionId; f.complete(id);
  f.edit({ status: 'cancelled', pipelineStatus: 'cancelled' });
  assert.equal((await f.crewVerify(id)).body.code, 'payment_tip_refused');
  f.edit({ status: 'completed', pipelineStatus: 'completed' });
  const before = moneyOf(f.job()), posts = f.stripePosts.length;
  // The reviewed repro: a device whose tip config read timed out sends a fresh request with no earlier checkout named
  // (tips on, PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED off).
  const fresh = await f.crewPay({ amount_cents: 50000 }, 'pay-u1');
  assert.deepEqual([fresh.status, fresh.body.code, f.stripePosts.length], [409, 'payment_review_open', posts]);
  assert.match(fresh.body.error, /waiting for manager review\. Do not charge again; a manager resolves it in Hub > Review queues/);
  assert.deepEqual(f.queries.at(-1), { collection: 'payment_reviews', field: 'jobId', value: 'job-1' });
  // The restored job never books the held charge from the crew return either.
  assert.equal((await f.crewVerify(id)).body.code, 'payment_tip_refused');
  // The portal shows it held (no Pay, no tip) and refuses a new checkout, before Stripe is read.
  const view = (await f.view()).body.payment;
  assert.deepEqual([view.held, view.dueNow, view.balance, view.tip.available], [true, 0, 500, false]);
  const reads = f.stripeReads.length, pay = await f.pay({});
  assert.deepEqual([pay.status, pay.body.code, pay.body.reviewRecorded, f.stripePosts.length, f.stripeReads.length], [409, 'payment_review_open', true, posts, reads]);
  assert.equal(f.ledger(), undefined, 'a crew hold leaves the portal checkout ledger alone');
  // Unreadable holds fail closed: nothing opens.
  f.failQueries();
  const unknown = await f.crewPay({ amount_cents: 50000 }, 'pay-u2');
  assert.deepEqual([unknown.status, unknown.body.code, (await f.pay({})).status, f.stripePosts.length], [503, 'payment_review_unavailable', 503, posts]);
  const blind = (await f.view()).body.payment;
  assert.equal(blind.held, null, 'an unknown hold is never shown as none');
  f.failQueries(false);
  assert.deepEqual(moneyOf(f.job()), before);
  // The office refunds it in Stripe and the owner records the refund: card payments open again, and the charge is never booked.
  f.refund(id, 55000, true);
  const [row] = (await f.heldReviews()).body.paymentReviews;
  assert.equal((await f.resolve(recordRefund(row))).status, 200);
  const again = await f.crewPay({ amount_cents: 50000 }, 'pay-u3');
  assert.equal(again.status, 200); assert.notEqual(again.body.sessionId, id);
  assert.deepEqual([(await f.view()).body.payment.held, (await f.pay({})).status], [false, 200]);
  assert.deepEqual(moneyOf(f.job()), before);
});

test('one query serves both holds: tips on with the checkout block also stops on an untipped review, with the same code', async t => {
  const block = { ...ON, PAYMENT_REVIEW_CHECKOUT_BLOCK_ENABLED: 'true' };
  const f = await fixture(t, { 'job-1': { ...closing(), assignedCrew: ['crew1'] } }, block);
  f.docs.set('payment_reviews/cs_test_untipped', { value: { sessionId: 'cs_test_untipped', jobId: 'job-1', kind: 'egc_job_payment', status: 'open', reason: 'payment_exceeds_balance', amountCents: 5000, createdAt: NOW }, version: 1 });
  const queries = f.queries.length, crew = await f.crewPay({ amount_cents: 50000 }, 'pay-block');
  assert.deepEqual([crew.status, crew.body.code, f.queries.length - queries, f.stripePosts.length], [409, 'payment_review_open', 1, 0]);
  const pay = await f.pay({});
  assert.deepEqual([pay.status, pay.body.code, pay.body.reviewRecorded, f.stripePosts.length], [409, 'payment_review_open', true, 0]);
  assert.deepEqual([(await f.view()).body.payment.held, (await f.view()).body.payment.dueNow], [true, 0]);
  // Tips on without the block: an untipped review holds nothing, as before tips.
  t.mock.restoreAll();
  const g = await fixture(t, { 'job-1': { ...closing(), assignedCrew: ['crew1'] } });
  g.docs.set('payment_reviews/cs_test_untipped', { value: { sessionId: 'cs_test_untipped', jobId: 'job-1', kind: 'egc_job_payment', status: 'open', reason: 'payment_exceeds_balance', amountCents: 5000, createdAt: NOW }, version: 1 });
  assert.deepEqual([(await g.crewPay({ amount_cents: 50000 }, 'pay-open')).status, (await g.view()).body.payment.held, (await g.pay({})).status], [200, false, 200]);
});

// Decision: a refund Stripe shows on a tipped charge the job already counts as paid opens REVIEWS-UI's refund review
// (carrying tipCents), but it is not a tip hold: the balance a new checkout charges already counts that charge, so it
// cannot be charged twice (REVIEWS-UI's *_balance_open wording). Its tip is held out of the payroll split instead.
test('a refund on a tipped charge already on the job carries the tip to Review queues and payroll, but blocks no checkout', async t => {
  const f = await fixture(t, { 'job-1': crewJob() }), link = await f.crewPay({ amount_cents: 100000, tip_cents: 15000 }), id = link.body.sessionId; f.complete(id);
  assert.deepEqual([(await f.crewVerify(id)).status, f.job().payment.amount, f.job().payment.tips.map(tip => tip.amountCents)], [200, 1000, [15000]]);
  f.refund(id, 15000);
  const back = await f.crewVerify(id);
  assert.deepEqual([back.status, back.body.code, back.body.reviewRecorded], [409, 'payment_refunded', true]);
  assert.match(back.body.error, /any balance the job still shows can be collected as usual/);
  assert.deepEqual([f.review(id).reason, f.review(id).status, f.review(id).tipCents, f.review(id).refundedCents], ['payment_refunded', 'open', 15000, 15000]);
  assert.deepEqual([f.job().payment.amount, f.job().payment.tips.length], [1000, 1], 'the job is unchanged');
  // The remaining $600 balance can still be taken: this review is not a tip hold.
  const rest = await f.crewPay({ amount_cents: 60000 }, 'pay-rest');
  assert.equal(rest.status, 200);
  // Review queues shows the refund with the tip apart; payroll holds the tip out of the split until the owner settles it.
  const [row] = (await f.heldReviews()).body.paymentReviews;
  assert.deepEqual([row.reviewId, row.recordedOnJob, row.tipCents, row.serviceCents, row.refundedCents], [id, true, 15000, 100000, 15000]);
  const allocation = computeTipAllocation({ jobs: [{ ...f.job(), id: 'job-1' }], timecards: [], start: '2026-09-21', end: '2026-09-28', now: NOW, refundReviews: new Map([['job-1', [f.review(id)]]]) });
  assert.deepEqual([allocation.jobs[0].reasons.includes('tip_refund_open'), allocation.totals.allocatedCents], [true, 0]);
  // A later follow-up review of the same charge carries the tip as well.
  const done = await f.resolve({ ...recordRefund(row), jobPaymentAcknowledged: true });
  assert.equal(done.status, 200);
  f.refund(id, 30000);
  assert.equal((await f.crewVerify(id)).body.code, 'payment_refunded');
  assert.deepEqual([f.review(`${id}:refund`).tipCents, f.review(`${id}:refund`).followUpOf, f.review(`${id}:refund`).refundedCents], [15000, id, 30000]);
});

test('a tipped crew charge held for exceeding the balance stays held when the balance frees up; an untipped one is booked as before tips', async t => {
  const f = await fixture(t, { 'job-1': crewJob() }), link = await f.crewPay({ amount_cents: 100000, tip_cents: 15000 }), id = link.body.sessionId; f.complete(id);
  f.edit({ total: 800 });
  const held = await f.crewVerify(id);
  assert.deepEqual([held.status, held.body.code, held.body.reviewRecorded, f.review(id).tipCents], [409, 'payment_exceeds_balance', true, 15000]);
  // The balance frees up again: the tipped charge is still never booked automatically, from the crew return or the webhook.
  f.edit({ total: 1600 });
  const again = await f.crewVerify(id);
  assert.deepEqual([again.status, again.body.code, again.body.reviewRecorded], [409, 'payment_exceeds_balance', true]);
  assert.match(again.body.error, /exceeds the current job balance.*Do not charge again/);
  assert.deepEqual((await f.event(f.webhookObject(id))).body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_exceeds_balance' });
  assert.deepEqual([f.job().payment, f.review(id).status, f.review(id).jobRecordedAt], [undefined, 'open', undefined]);
  assert.equal((await f.crewPay({ amount_cents: 20000 }, 'synthetic-crew-while-held')).body.code, 'payment_review_open');
  // Listed in Review queues for the office, who settles it by hand; the resolved charge stays off the job.
  const [row] = (await f.heldReviews()).body.paymentReviews;
  assert.deepEqual([row.sessionId, row.reason, row.serviceCents, row.tipCents], [id, 'payment_exceeds_balance', 100000, 15000]);
  // Nothing was recorded on the job since the hold: the manager must say where the service part went.
  assert.equal((await f.resolve(reconcile(row, 'Service recorded as a check; tip paid with payroll.'), f.managerCookie)).body.code, 'stripe_review_service_not_recorded');
  assert.equal((await f.resolve(reconcile(row, 'Service settled by a check outside the Hub; tip paid with payroll.', { appliedElsewhere: true }), f.managerCookie)).status, 200, 'a manager may reconcile a charge Stripe shows no refund on');
  assert.equal((await f.crewVerify(id)).body.code, 'payment_review_resolved');
  assert.equal(f.job().payment, undefined);
  // The same story without a tip keeps the integration branch's behaviour: held while it exceeds, booked by the crew
  // return once it fits (with its review marked), and no new link is blocked.
  t.mock.restoreAll();
  const plain = await fixture(t, { 'job-1': crewJob() }), untipped = await plain.crewPay({ amount_cents: 100000 }), session = untipped.body.sessionId; plain.complete(session);
  plain.edit({ total: 800 });
  assert.equal((await plain.crewVerify(session)).body.code, 'payment_exceeds_balance');
  assert.equal((await plain.crewPay({ amount_cents: 20000 }, 'synthetic-crew-untipped-hold')).status, 200, 'an untipped review blocks nothing new');
  plain.edit({ total: 1600 });
  assert.deepEqual([(await plain.crewVerify(session)).status, plain.job().payment.amount, plain.review(session).jobRecordedAt], [200, 1000, NOW]);
});

// Seventh review. Closing a tipped charge's review gives the customer's Pay button (and the crew card link) back for
// whatever balance the job shows, so a charge not on its job is closed only once its service part is recorded on the
// job by hand since the hold, or the person resolving it says it went elsewhere (PROBE P2c).
test('marking a tipped charge not on its job reconciled needs its service part recorded since the hold, or an explicit applied-elsewhere, so Pay never asks twice', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.edit({ status: 'cancelled', pipelineStatus: 'cancelled' });
  assert.equal((await f.verifyPortal(id)).body.code, 'payment_tip_refused');
  f.edit({ status: 'completed', pipelineStatus: 'completed' });
  const [row] = (await f.heldReviews()).body.paymentReviews;
  // The note says the service was recorded by hand, but nothing was: refused for the owner and a manager alike.
  for (const cookie of [undefined, f.managerCookie]) {
    const refused = await f.resolve(reconcile(row, 'Service recorded by hand'), cookie);
    assert.deepEqual([refused.status, refused.body.code, refused.body.details], [409, 'stripe_review_service_not_recorded', { amountCents: 55000, tipCents: 5000, serviceCents: 50000, recordedSinceCents: 0, jobBalanceCents: 50000 }]);
    assert.equal(refused.body.error, "Not on the job: closing this review lets the job's $500.00 balance be paid again. First record its $500.00 service part under Estimates & payments (never the $50.00 tip); $0.00 recorded since the hold. Or tick that it went to another job or outside the Hub. Nothing was saved.");
  }
  assert.equal((await f.resolve(reconcile(row, 'Service recorded by hand', { appliedElsewhere: 'yes' }))).body.code, 'stripe_review_invalid_field');
  assert.equal((await f.resolve({ ...recordRefund(row), appliedElsewhere: true })).body.code, 'stripe_review_request_invalid', 'only a reconcile takes appliedElsewhere');
  // No double-charge window: the review stays open, Pay stays held and nothing was written.
  const view = (await f.view()).body.payment;
  assert.deepEqual([f.review(id).status, f.commits.length, view.held, view.dueNow, (await f.pay({})).body.code], ['open', 0, true, 0, 'payment_review_open']);
  // One cent short of the $500 service part is still refused; the whole of it closes the review.
  await f.recordOffline(49999, 'SERVICE-499');
  const short = await f.resolve(reconcile(row, 'Service recorded by hand'));
  assert.deepEqual([short.body.code, short.body.details.recordedSinceCents], ['stripe_review_service_not_recorded', 49999]);
  await f.recordOffline(1, 'SERVICE-CENT');
  const done = await f.resolve(reconcile(row, 'Service recorded by hand'));
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.review.serviceAppliedElsewhere, f.review(id).serviceAppliedElsewhere], [undefined, undefined], 'no acknowledgment is saved when none was needed');
  const after = (await f.view()).body.payment;
  assert.deepEqual([after.held, after.dueNow, f.job().payment.amount, f.job().payment.tips], [false, 0, 1000, undefined], 'Pay asks only for what is really due: nothing');
});

// Seventh review. The kept service part is measured by the payments a person recorded on the job since the hold, never
// by the job's net paid total (PROBE P2d); a payment the job already had when the charge was held never counts.
test('the kept service check counts payments recorded since the hold: a payment corrected down never traps the owner, and one recorded before never counts', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.refund(id, 20000);
  assert.equal((await f.verifyPortal(id)).body.code, 'payment_refunded');
  const [row] = (await f.heldReviews()).body.paymentReviews;
  // The $500 deposit record is corrected to $400 while the review is open; the owner then records the $300 kept.
  f.edit({ payment: { ...f.job().payment, amount: 400 }, deposit: { ...f.job().deposit, paidAmount: 400 } });
  await f.recordOffline(30000, 'KEPT-300');
  const done = await f.resolve(recordRefund(row, { keptCentsAcknowledged: 35000 }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const view = (await f.view()).body.payment;
  assert.deepEqual([view.held, view.dueNow, f.job().payment.amount], [false, 300, 700], 'the $400 deposit and the $300 kept are paid; $300 is really due');
  // A check the job already had when the charge was held is never the kept service part, even at the same instant.
  t.mock.restoreAll();
  const g = await fixture(t, { 'job-1': crewJob() }), link = await g.crewPay({ amount_cents: 160000, tip_cents: 20000 }), session = link.body.sessionId; g.complete(session);
  // A $1,000 check is recorded after the crew link opened but before the charge came back, so the charge is held.
  await g.recordOffline(100000, 'CHK-EARLY');
  const early = g.job().paymentLedger.find(entry => entry.source === 'hub_offline').id;
  assert.equal((await g.crewVerify(session)).body.code, 'payment_exceeds_balance');
  assert.deepEqual([g.review(session).createdAt, g.review(session).jobLedgerIds], [NOW, [early]], 'the hold names the payments the job already had');
  g.refund(session, 100000); await g.refundEvent(session);
  const [held] = (await g.heldReviews()).body.paymentReviews;
  const refused = await g.resolve(recordRefund(held, { keptCentsAcknowledged: 80000, tipRefundedFirst: true }));
  assert.deepEqual([refused.body.code, refused.body.details.keptServiceCents, refused.body.details.recordedSinceCents, refused.body.details.jobBalanceCents], ['stripe_review_kept_not_recorded', 80000, 0, 60000]);
  // Recording the $600 balance leaves nothing for a new checkout to charge, so the refund can be recorded.
  await g.recordOffline(60000, 'BAL');
  assert.equal((await g.resolve(recordRefund(held, { keptCentsAcknowledged: 80000, tipRefundedFirst: true }))).status, 200);
});

// Seventh review. A refund Stripe shows after the review of a charge NOT on its job was closed, beyond what that close
// settled, reaches the owner in a follow-up review exactly as for a charge on its job (PROBE P6); the webhook says a
// review is required only while one is queued.
test('more refunded after a closed review of a tipped charge not on its job opens one follow-up, settled like a charge on the job', async t => {
  const f = await fixture(t), { body } = await f.pay({ tip_cents: 5000 }), id = body.url.split('/').pop(); f.complete(id);
  f.refund(id, 20000);
  assert.equal((await f.verifyPortal(id)).body.code, 'payment_refunded');
  const [row] = (await f.heldReviews()).body.paymentReviews;
  await f.recordOffline(30000, 'KEPT-300');
  assert.equal((await f.resolve(recordRefund(row, { keptCentsAcknowledged: 35000 }))).status, 200);
  const closed = structuredClone(f.docs.get(`payment_reviews/${id}`));
  // Stripe then shows the whole $550 refunded.
  f.refund(id, 55000, true);
  const hook = await f.refundEvent(id);
  assert.deepEqual(hook.body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  const followUp = f.review(`${id}:refund`);
  assert.deepEqual([followUp.reason, followUp.status, followUp.followUpOf, followUp.priorResolution, followUp.priorRefundedCents, followUp.priorKeptServiceCents, followUp.priorKeptTipCents, followUp.refundedCents, followUp.tipCents, followUp.recordedBy],
    ['payment_refunded', 'open', id, 'refunded', 20000, 30000, 5000, 55000, 5000, 'stripe_webhook']);
  assert.deepEqual(f.docs.get(`payment_reviews/${id}`), closed, 'the closed review is never reopened or rewritten');
  // Redeliveries, the completion webhook and the return all find the same follow-up; none opens a second.
  const version = f.docs.get(`payment_reviews/${id}:refund`).version;
  assert.equal((await f.refundEvent(id)).body.reason, 'payment_refunded');
  assert.deepEqual((await f.event(f.webhookObject(id))).body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  const back = await f.verifyPortal(id);
  assert.deepEqual([back.status, back.body.code, back.body.reviewRecorded], [409, 'payment_refunded', true]);
  assert.deepEqual([f.docs.get(`payment_reviews/${id}:refund`).version, f.review(`${id}:refund:2`)], [version, undefined]);
  // Review queues shows it; Pay is held while it is open, and the job is left as it is.
  const queue = (await f.heldReviews()).body.paymentReviews;
  assert.deepEqual(queue.map(item => [item.reviewId, item.recordedOnJob, item.refundedCents, item.priorRefundedCents, item.priorKeptServiceCents, item.priorKeptTipCents]), [[`${id}:refund`, false, 55000, 20000, 30000, 5000]]);
  const view = (await f.view()).body.payment;
  assert.deepEqual([view.held, view.dueNow, (await f.pay({})).body.code, f.job().payment.amount], [true, 0, 'payment_review_open', 800]);
  // The money kept was recorded on the job by hand when the first review closed: the owner confirms that correction and
  // records nothing more first.
  const [next] = queue;
  const unconfirmed = await f.resolve(recordRefund(next));
  assert.deepEqual([unconfirmed.status, unconfirmed.body.code, unconfirmed.body.details], [409, 'stripe_review_refund_settled_earlier', { recordedOnJob: false, settledEarlier: true }]);
  const done = await f.resolve(recordRefund(next, { jobPaymentAcknowledged: true }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.review.id, done.body.review.refundFull, done.body.review.recordedOnJobAtResolution, done.body.review.settledEarlierAtResolution], [`${id}:refund`, true, false, true]);
  const audit = [...f.docs.values()].map(item => item.value).find(item => item.entityKey === `payment_reviews/${id}:refund`);
  assert.equal(audit.reason, 'Job cancelled (an earlier review of this charge was closed: what it kept is on the job, recorded by hand, or on another job)');
  // Nothing is queued now: the webhook says so, and no further follow-up opens.
  assert.deepEqual((await f.refundEvent(id)).body, { ok: true, received: true, recorded: false, reviewRequired: false, reason: 'payment_review_resolved' });
  assert.equal(f.review(`${id}:refund:2`), undefined);
  // A charge reconciled as applied elsewhere, then partly refunded: its follow-up needs no amount kept recorded on this job.
  t.mock.restoreAll();
  const g = await fixture(t), made = await g.pay({ tip_cents: 5000 }), session = made.body.url.split('/').pop(); g.complete(session);
  g.edit({ status: 'cancelled', pipelineStatus: 'cancelled' });
  assert.equal((await g.verifyPortal(session)).body.code, 'payment_tip_refused');
  const [first] = (await g.heldReviews()).body.paymentReviews;
  assert.equal((await g.resolve(reconcile(first, 'Applied to job-2', { appliedElsewhere: true }))).status, 200);
  g.refund(session, 20000);
  assert.deepEqual((await g.refundEvent(session)).body, { ok: true, received: true, recorded: false, reviewRequired: true, reason: 'payment_refunded' });
  assert.deepEqual([g.review(`${session}:refund`).priorResolution, g.review(`${session}:refund`).priorRefundedCents, g.review(`${session}:refund`).heldReason], ['reconciled', undefined, 'payment_tip_refused']);
  const [later] = (await g.heldReviews()).body.paymentReviews;
  // Stripe no longer shows the refund? It is still the owner's; here it does, so reconciling is refused and the refund is recorded.
  assert.equal((await g.resolve(reconcile(later, 'Handled with the customer'))).body.code, 'stripe_review_refund_shown');
  const settled = await g.resolve(recordRefund(later, { jobPaymentAcknowledged: true }));
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.deepEqual([g.review(`${session}:refund`).keptCents, g.review(`${session}:refund`).keptServiceCents, g.review(`${session}:refund`).keptTipCents], [35000, 30000, 5000]);
});

// Seventh review. charge.refunded only ever holds (PROBE P3b): with no refund in Stripe and no review it writes nothing, and
// booking the charge is left to checkout.session.completed and the browser returns.
test('charge.refunded never books a charge: with no refund shown and no review it is ignored and writes nothing', async t => {
  const f = await fixture(t, { 'job-1': crewJob() }), link = await f.crewPay({ amount_cents: 100000, tip_cents: 15000 }), id = link.body.sessionId; f.complete(id);
  // A refund was made and then failed: Stripe shows none when the charge is read again.
  const reads = f.stripeReads.length, patches = f.jobPatches(), docs = [...f.docs.keys()];
  const hook = await f.refundEvent(id);
  assert.deepEqual(hook.body, { ok: true, received: true, ignored: true });
  assert.deepEqual(f.stripeReads.slice(reads), [`list:pi_${id}`, id], 'Stripe is still checked for a refund');
  assert.deepEqual([f.job().payment, f.review(id), f.jobPatches(), f.commits.length, [...f.docs.keys()]], [undefined, undefined, patches, 0, docs], 'nothing is booked or written');
  assert.deepEqual((await f.refundEvent(id)).body, { ok: true, received: true, ignored: true });
  // The completion webhook books it once, with its tip.
  assert.deepEqual((await f.event(f.webhookObject(id))).body, { ok: true, received: true, recorded: true, duplicate: false });
  assert.deepEqual([f.job().payment.amount, f.job().payment.stripeSessions.length, f.job().payment.tips.map(tip => tip.amountCents)], [1000, 1, [15000]]);
  // On the job with no refund shown, charge.refunded still writes nothing, not even a newer receipt link.
  f.sessions.get(id).payment_intent.latest_charge.receipt_url = `https://pay.stripe.com/receipts/${id}-updated`;
  const booked = structuredClone(f.job()), bookedPatches = f.jobPatches();
  assert.deepEqual((await f.refundEvent(id)).body, { ok: true, received: true, ignored: true });
  assert.deepEqual([f.job(), f.jobPatches()], [booked, bookedPatches]);
  // A portal charge the same way: ignored, and its checkout ledger is left alone.
  t.mock.restoreAll();
  const g = await fixture(t), made = await g.pay({ tip_cents: 5000 }), session = made.body.url.split('/').pop(); g.complete(session);
  const ledger = structuredClone(g.docs.get('customer_payment_checkouts/job-1'));
  assert.deepEqual((await g.refundEvent(session)).body, { ok: true, received: true, ignored: true });
  assert.deepEqual([g.job().payment.amount, g.job().payment.tips, g.review(session), g.docs.get('customer_payment_checkouts/job-1')], [500, undefined, undefined, ledger]);
  assert.equal((await g.verifyPortal(session)).status, 200, 'the return books it');
  assert.deepEqual([g.job().payment.amount, g.job().payment.tips.map(tip => tip.amountCents)], [1000, [5000]]);
});
