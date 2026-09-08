import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { customerMoneyState, customerDepositState } from '../functions/_lib/customer-payments.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import * as portal from '../functions/api/customer-portal.js';
import * as webhook from '../functions/api/stripe-webhook.js';
import * as crewPayment from '../functions/api/job-payment.js';

const origin = 'https://easygaragecleaning.com';
const env = { FIREBASE_API_KEY: 'firebase-test-customer-deposit', CUSTOMER_PORTAL_SECRET: 'synthetic-customer-deposit-secret', STRIPE_SECRET_KEY: 'sk_test_synthetic_deposit', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_deposit', HUB_SESSION_SECRET: 'synthetic-hub-payment-secret', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { role: 'owner', passwordHash: 'synthetic-hash' } }) };
const approved = () => ({ type: 'job', customer: 'Test Customer', email: 'customer@example.invalid', total: 1000, status: 'scheduled', estimate: { status: 'accepted', amount: 1000, revision: 1, depositRequired: 500 }, deposit: { amount: 500, paidAmount: 0 } });
const closeout = { standardItems: [{ key: '0_1', label: 'Walk the garage with the homeowner', completed: true }] };

async function fixture(t, initial = {}) {
  const docs = new Map([['jobs/job-1', { value: { ...approved(), ...initial }, version: 1 }]]), sessions = new Map(), keys = new Map();
  const stripePosts = [], expired = [], calls = []; let lostResponse = false, failJobWrites = false;
  const version = row => `2026-09-08T00:00:00.${String(row.version).padStart(6, '0')}Z`;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET'; calls.push({ url: url.href, method });
    if (url.hostname === 'firestore.googleapis.com') {
      const path = decodeURIComponent(url.pathname.split('/documents/')[1]); let row = docs.get(path);
      if (method === 'PATCH') {
        if (failJobWrites && path.startsWith('jobs/')) return Response.json({}, { status: 503 });
        if (row ? url.searchParams.get('currentDocument.updateTime') !== version(row) : url.searchParams.get('currentDocument.exists') !== 'false') return Response.json({}, { status: 412 });
        row = { value: { ...(row?.value || {}), ...decodeFirestoreFields(JSON.parse(options.body).fields) }, version: (row?.version || 0) + 1 }; docs.set(path, row);
      }
      return row ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(row.value), updateTime: version(row) }) : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') {
      if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
        const params = new URLSearchParams(options.body), key = options.headers['Idempotency-Key'];
        stripePosts.push({ key, params });
        let id = keys.get(key);
        if (!id) {
          id = `cs_test_deposit_${sessions.size + 1}`; keys.set(key, id);
          sessions.set(id, { id, mode: 'payment', status: 'open', payment_status: 'unpaid', currency: 'usd', amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), client_reference_id: params.get('client_reference_id'), metadata: { kind: params.get('metadata[kind]'), job_id: params.get('metadata[job_id]'), payment_purpose: params.get('metadata[payment_purpose]') }, url: `https://checkout.stripe.com/c/pay/${id}` });
        } else assert.equal(params.toString(), stripePosts.find(row => row.key === key).params.toString(), 'idempotent retries use identical parameters');
        if (lostResponse) { lostResponse = false; throw new Error('Synthetic connection lost after Stripe accepted request'); }
        return Response.json(sessions.get(id));
      }
      const id = url.pathname.split('/')[4], session = sessions.get(id);
      if (!session) return Response.json({}, { status: 404 });
      if (url.pathname.endsWith('/expire')) {
        if (session.status !== 'open') return Response.json({}, { status: 409 });
        expired.push(id); session.status = 'expired'; session.url = null;
      }
      return Response.json(session);
    }
    throw new Error(`Unexpected request ${url.hostname}${url.pathname}`);
  });
  const cookie = (await createCustomerPortalSessionCookie(env, 'job-1')).split(';')[0];
  const request = body => new Request(`${origin}/api/customer-portal`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const post = body => portal.onRequestPost({ request: request(body), env });
  const pay = (extra = {}) => post({ action: 'create_payment', request_id: `synthetic-${Math.random()}`, ...extra });
  const get = async () => (await portal.onRequestGet({ request: request(), env })).json();
  const job = () => docs.get('jobs/job-1').value;
  const edit = patch => { const row = docs.get('jobs/job-1'); row.value = { ...row.value, ...patch }; row.version++; };
  const complete = id => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', url: null, payment_intent: { id: `pi_${id}`, latest_charge: { receipt_url: `https://pay.stripe.com/receipts/${id}` } }, customer_details: { email: 'customer@example.invalid' } });
  const event = async (session, { type = 'checkout.session.completed', signatureValid = true } = {}) => {
    const timestamp = Math.floor(Date.now() / 1000), raw = JSON.stringify({ id: 'evt_synthetic_deposit', type, data: { object: session } });
    const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    return webhook.onRequestPost({ env, request: new Request(`${origin}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signatureValid ? signature : '0'.repeat(64)}` }, body: raw }) });
  };
  return { docs, sessions, stripePosts, expired, calls, job, edit, post, pay, get, complete, event, loseResponse: () => { lostResponse = true; }, failJobWrites: value => { failJobWrites = value; } };
}

test('deposit defaults to half in cents, subtracts previous receipts, and preserves signed legacy terms', () => {
  const half = customerDepositState({ total: 1000.01 });
  assert.equal(half.required, 500.01); assert.equal(half.remainder, 500);
  assert.equal(customerDepositState({ total: 1000, payment: { amount: 125 } }).dueNow, 375);
  assert.equal(customerDepositState({ total: 1000, estimate: { depositRequired: 200 } }).required, 200);
  assert.equal(customerDepositState({ total: 1000, estimate: { depositRequired: 0 } }).required, 0);
  assert.equal(customerDepositState({ total: 1000, payment: { amount: 500 }, startedAt: '2026-09-08', status: 'in_progress', invoice: { amount: 1000, status: 'issued' } }).dueNow, 0, 'starting work or issuing invoice does not accelerate final balance');
  assert.equal(customerDepositState({ total: 1000, payment: { amount: 500 }, postJobProgress: closeout }).dueNow, 500, 'final customer walkthrough enables balance before closeout requires payment');
  assert.equal(customerMoneyState({ total: 1200, invoice: { amount: 1000, status: 'superseded' }, payment: { amount: 500 } }).balance, 700);
});

test('accepting a quote saves its 50% term, then server ignores caller-supplied charge amounts', async t => {
  const f = await fixture(t, { estimate: { status: 'draft', amount: 1000 }, deposit: null });
  assert.equal((await f.pay()).status, 409); assert.equal(f.sessions.size, 0);
  const approval = await f.post({ action: 'approve_estimate', signed_name: 'Test Customer', confirmed: true });
  assert.equal(approval.status, 200); assert.equal(f.job().estimate.depositRequired, 500);
  const response = await f.pay({ amount_cents: 100000, deposit_percent: 100, job_id: 'another-job' });
  assert.equal(response.status, 200); const checkout = [...f.sessions.values()][0];
  assert.equal(checkout.amount_total, 50000); assert.equal(checkout.client_reference_id, 'job-1');
  assert.equal(checkout.metadata.payment_purpose, 'deposit');
  assert.equal(f.stripePosts[0].params.get('payment_method_types[0]'), 'card');
  const view = await f.get(); assert.equal(view.payment.dueNow, 500); assert.equal(view.payment.balance, 1000);
});

test('cancel, repeat clicks, and separate browser requests reuse one Checkout session', async t => {
  const f = await fixture(t), first = await (await f.pay()).json(), retry = await (await f.pay()).json();
  assert.equal(first.url, retry.url); assert.equal(f.sessions.size, 1); assert.equal(f.stripePosts.length, 1);
});

test('concurrent requests cannot create competing deposit checkouts', async t => {
  const f = await fixture(t), responses = await Promise.all([f.pay(), f.pay(), f.pay()]);
  assert.ok(responses.some(response => response.status === 200));
  assert.ok(responses.every(response => [200, 409].includes(response.status)));
  assert.equal(f.sessions.size, 1);
});

test('a lost creation response safely recovers the same Stripe idempotency key', async t => {
  const f = await fixture(t); f.loseResponse();
  assert.equal((await f.pay()).status, 502); assert.equal(f.sessions.size, 1);
  assert.equal((await f.pay()).status, 200); assert.equal(f.sessions.size, 1);
  assert.equal(f.stripePosts[0].key, f.stripePosts[1].key);
});

test('webhook records deposit without a browser return; replay and later final balance apply once', async t => {
  const f = await fixture(t); await f.pay(); const firstId = [...f.sessions.keys()][0], first = f.complete(firstId);
  assert.equal((await f.event(first)).status, 200);
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().deposit.paidAmount, 500); assert.equal(f.job().deposit.status, 'paid');
  assert.equal(f.job().invoice.balance, 500); assert.equal(f.job().invoice.status, 'partial');
  assert.equal((await f.event(first)).status, 200);
  const verification = await f.post({ action: 'verify_payment', session_id: firstId });
  assert.equal(verification.status, 200); assert.equal((await verification.json()).duplicate, true);
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().payment.stripeSessions.length, 1);
  assert.equal((await f.pay()).status, 409, 'scheduled job must not immediately collect the other half');
  f.edit({ status: 'in_progress', postJobProgress: closeout });
  assert.equal((await f.pay()).status, 200); const secondId = [...f.sessions.keys()][1], second = f.complete(secondId);
  assert.equal(second.amount_total, 50000); assert.equal(second.metadata.payment_purpose, 'balance');
  assert.equal((await f.event(second)).status, 200);
  assert.equal(f.job().payment.amount, 1000); assert.equal(f.job().invoice.balance, 0); assert.equal(f.job().invoice.status, 'paid');
  assert.equal((await f.event(first)).status, 200); assert.equal(f.job().payment.amount, 1000);
  assert.equal((await f.pay()).status, 409); assert.equal(f.sessions.size, 2);
});

test('another checkout request reconciles a completed deposit before offering any new charge', async t => {
  const f = await fixture(t); await f.pay(); f.complete([...f.sessions.keys()][0]);
  const retry = await (await f.pay()).json();
  assert.equal(retry.alreadyPaid, true); assert.equal(f.job().payment.amount, 500); assert.equal(f.sessions.size, 1);
});

test('a browser return enriches the receipt after an unexpanded webhook without double counting', async t => {
  const f = await fixture(t); await f.pay(); const id = [...f.sessions.keys()][0], paid = f.complete(id);
  assert.equal((await f.event({ ...paid, payment_intent: paid.payment_intent.id })).status, 200);
  assert.equal(f.job().payment.receiptUrl, '');
  const response = await f.post({ action: 'verify_payment', session_id: id });
  assert.equal(response.status, 200); assert.equal((await response.json()).duplicate, true);
  assert.equal(f.job().payment.receiptUrl, `https://pay.stripe.com/receipts/${id}`);
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().payment.stripeSessions.length, 1);
});

test('changed quote or cancellation expires the outstanding link before another checkout', async t => {
  const f = await fixture(t); await f.pay();
  f.edit({ total: 1200, estimate: { status: 'accepted', amount: 1200, depositRequired: 600, revision: 2 } });
  const updated = await (await f.pay()).json();
  assert.equal(f.expired.length, 1); assert.equal(updated.amount, 600); assert.equal(f.sessions.size, 2);
  f.edit({ status: 'cancelled' }); assert.equal((await f.pay()).status, 409);
  assert.equal(f.expired.length, 2); assert.equal(f.sessions.size, 2);
});

test('a crew-editable invoice cannot inflate a charge above the agreed quote', async t => {
  const f = await fixture(t, { status: 'in_progress', postJobProgress: closeout, payment: { amount: 500, verified: true }, invoice: { amount: 10000, status: 'partial', balance: 9500 } });
  const response = await f.pay(); assert.equal(response.status, 200);
  assert.equal((await response.json()).amount, 500); assert.equal([...f.sessions.values()][0].amount_total, 50000);
  const view = await f.get(); assert.equal(view.payment.total, 1000); assert.equal(view.payment.balance, 500);
});

test('Stripe confirmation verifies signatures, paid state, job binding, currency and amount', async t => {
  const f = await fixture(t); await f.pay(); const id = [...f.sessions.keys()][0], open = f.sessions.get(id);
  assert.equal((await f.event(open)).status, 200); assert.equal(f.job().payment, undefined);
  assert.equal((await f.event(open, { signatureValid: false })).status, 400);
  const paid = f.complete(id);
  for (const changes of [{ currency: 'eur' }, { client_reference_id: 'other-job' }, { amount_total: 99999 }, { metadata: { ...paid.metadata, kind: 'egc_job_payment' } }]) {
    f.sessions.set(id, { ...paid, ...changes });
    assert.equal((await f.post({ action: 'verify_payment', session_id: id })).status, 409);
  }
  assert.equal(f.job().payment, undefined);
  f.sessions.set(id, paid);
  assert.equal((await f.event(paid, { type: 'checkout.session.async_payment_succeeded' })).status, 200);
  assert.equal(f.job().payment.amount, 500);
});

test('failed storage makes webhook retry and leaves the payment recoverable', async t => {
  const f = await fixture(t); await f.pay(); const paid = f.complete([...f.sessions.keys()][0]); f.failJobWrites(true);
  assert.equal((await f.event(paid)).status, 503); assert.equal(f.job().payment, undefined);
  f.failJobWrites(false); assert.equal((await f.event(paid)).status, 200); assert.equal(f.job().payment.amount, 500);
});

test('concurrent webhook and return verification record the charge exactly once', async t => {
  const f = await fixture(t); await f.pay(); const id = [...f.sessions.keys()][0], paid = f.complete(id);
  const responses = await Promise.all([f.event(paid), f.post({ action: 'verify_payment', session_id: id })]);
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().payment.stripeSessions.length, 1);
});

test('an unverified manual receipt cannot be blessed by a separate Stripe deposit', async t => {
  const f = await fixture(t); await f.pay(); const id = [...f.sessions.keys()][0], paid = f.complete(id);
  f.edit({ payment: { amount: 500, verified: false, reference: 'unverified-crew-entry', stripeSessions: [{ sessionId: id, amount: 500 }] } });
  assert.equal((await f.pay()).status, 409);
  assert.equal((await f.event(paid)).status, 503, 'Stripe retries after manager review');
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().payment.verified, false);
  const view = await f.get(); assert.equal(view.payment.needsReview, true); assert.equal(view.payment.dueNow, 0);
  const ledger = f.docs.get('customer_payment_checkouts/job-1').value;
  assert.equal(ledger.verifiedReceipt.sessionId, id); assert.equal(ledger.verifiedReceipt.amount, 500);
  assert.equal(f.sessions.size, 1);
  // Manager verifies the actual earlier receipt and removes the unverified claim
  // that the pending Stripe session had already been recorded.
  f.edit({ payment: { amount: 500, verified: true, reference: 'manager-verified-receipt', stripeSessions: [] } });
  assert.equal((await f.event(paid)).status, 200);
  assert.equal(f.job().payment.amount, 1000); assert.equal(f.job().payment.verified, true);
});

test('a zero-dollar unverified fake Stripe entry cannot suppress a genuine deposit receipt', async t => {
  const f = await fixture(t); await f.pay(); const id = [...f.sessions.keys()][0], paid = f.complete(id);
  f.edit({ payment: { amount: 0, verified: false, stripeSessions: [{ sessionId: id, amount: 500 }] } });
  assert.equal((await f.event(paid)).status, 200);
  assert.equal(f.job().payment.amount, 500); assert.equal(f.job().payment.stripeSessions.length, 1);
});

test('crew payment endpoints cannot bypass review and verify a combined unverified total', async t => {
  const f = await fixture(t); await f.pay(); const id = [...f.sessions.keys()][0]; f.complete(id);
  f.edit({ payment: { amount: 500, verified: false, stripeSessions: [] } });
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const verification = await crewPayment.onRequestGet({ env, request: new Request(`${origin}/api/job-payment?session_id=${id}`, { headers: { Cookie: cookie, Origin: origin } }) });
  assert.equal(verification.status, 409); assert.equal(f.job().payment.verified, false); assert.equal(f.job().payment.amount, 500);
  const payment = await crewPayment.onRequestPost({ env, request: new Request(`${origin}/api/job-payment`, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: JSON.stringify({ job_id: 'job-1', request_id: 'synthetic-crew-pay', amount_cents: 50000 }) }) });
  assert.equal(payment.status, 409); assert.equal(f.sessions.size, 1);
});

test('payment controls show deposit due now, then a receipt and remainder due on completion', () => {
  const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
  const render = html.match(/function renderPayment\(data\)\{[^\n]+/)[0];
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', classList: { toggle(key, enabled) { this[key] = enabled; } } }); return nodes.get(id); };
  const context = vm.createContext({ $: node, setText: (id, value) => { node(id).textContent = value; }, money: value => `$${Number(value).toFixed(2)}` });
  vm.runInContext(render, context);
  const data = { estimate: { status: 'approved' }, appointment: { status: 'scheduled' }, payment: { balance: 1000, dueNow: 500, purpose: 'deposit' } };
  context.renderPayment(data); assert.equal(node('pay-button').textContent, 'Pay $500.00 upfront deposit');
  assert.match(node('payment-due-now').textContent, /\$500.00 remaining after your deposit, due on completion/);
  context.renderPayment({ ...data, payment: { balance: 500, dueNow: 0, purpose: 'deposit' } });
  assert.equal(node('pay-button').classList.hidden, true); assert.match(node('payment-due-now').textContent, /Deposit received/);
  context.renderPayment({ ...data, payment: { balance: 500, dueNow: 500, purpose: 'balance' } });
  assert.equal(node('pay-button').classList.hidden, false); assert.equal(node('pay-button').textContent, 'Pay $500.00 remaining balance');
});
