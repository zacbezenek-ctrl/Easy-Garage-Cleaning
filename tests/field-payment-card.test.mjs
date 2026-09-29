import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import * as card from '../functions/api/job-payment.js';
import * as field from '../functions/api/field-payments.js';

const ORIGIN = 'https://easygaragecleaning.com';
const env = { FIREBASE_API_KEY: 'firebase-test-field-card', HUB_SESSION_SECRET: 'synthetic-field-card-cookie', STRIPE_SECRET_KEY: 'sk_test_synthetic_field_card', EGC_FIELD_PAY_ENABLED: 'true', MONEY_API_ENABLED: 'true', MONEY_UNIFIED_TOTALS: 'true', MONEY_INVOICE_STATE_ENABLED: 'true', HUB_AUTH_USERS_JSON: JSON.stringify({ 'Lead.One': { role: 'crew', displayName: 'Synthetic Lead', passwordHash: 'synthetic' }, 'Crew.Two': { role: 'crew', displayName: 'Synthetic Member', passwordHash: 'synthetic' }, ZacB: { role: 'owner', displayName: 'Synthetic Owner', passwordHash: 'synthetic' } }) };
const image = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]).toString('base64')}`;
const root = 'projects/egcw-1ec83/databases/(default)/documents/';

async function fixture(t) {
  const docs = new Map([['jobs/job-1', { value: { type: 'job', customer: 'Synthetic Customer', email: 'customer@example.invalid', total: 100, status: 'completed', pipelineStatus: 'completed', payment: { amount: 0, verified: true }, assignedCrew: ['lead.one', 'crew.two'], crewLead: 'lead.one' }, version: 1 }]]);
  const sessions = new Map(), stripePosts = [], cookies = {};
  const revision = row => `2026-09-29T00:00:00.${String(row.version).padStart(6, '0')}Z`;
  const doc = (key, row) => ({ name: `${root}${key}`, fields: encodeFirestoreFields(row.value), updateTime: revision(row) });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'firestore.googleapis.com') {
      if (url.pathname.endsWith(':commit')) {
        const writes = JSON.parse(options.body).writes, items = writes.map(write => ({ key: decodeURIComponent((write.update?.name || write.delete).split('/documents/')[1]), write }));
        if (items.some(({ key, write }) => { const previous = docs.get(key), fence = write.currentDocument || {}; return fence.updateTime ? !previous || revision(previous) !== fence.updateTime : fence.exists === false ? Boolean(previous) : fence.exists === true && !previous; })) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
        for (const { key, write } of items) {
          if (write.delete) { if (write.currentDocument?.exists !== false) docs.delete(key); continue; }
          const previous = docs.get(key), patch = decodeFirestoreFields(write.update.fields), value = { ...(previous?.value || {}), ...patch };
          docs.set(key, { value, version: (previous?.version || 0) + 1 });
        }
        return Response.json({ writeResults: writes.map(() => ({})) });
      }
      const key = decodeURIComponent(url.pathname.split('/documents/')[1]), row = docs.get(key);
      return row ? Response.json(doc(key, row)) : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') {
      if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const params = new URLSearchParams(options.body), key = options.headers?.['Idempotency-Key'];
        let session = [...sessions.values()].find(item => item.key === key);
        if (!session) {
          const id = `cs_test_field_${sessions.size + 1}`;
          session = { id, key, status: 'open', payment_status: 'unpaid', url: `https://checkout.stripe.com/c/pay/${id}`, client_reference_id: params.get('client_reference_id'), amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), metadata: Object.fromEntries([...params].filter(([name]) => name.startsWith('metadata[')).map(([name, value]) => [name.slice(9, -1), value])) };
          sessions.set(id, session);
        }
        stripePosts.push(key);
        return Response.json(session);
      }
      const id = url.pathname.split('/')[4], session = sessions.get(id);
      if (!session) return Response.json({}, { status: 404 });
      if (method === 'POST' && url.pathname.endsWith('/expire')) session.status = 'expired';
      return Response.json(session);
    }
    throw new Error(`Unexpected ${url}`);
  });
  for (const user of ['Lead.One', 'Crew.Two', 'ZacB']) cookies[user] = (await createHubSessionCookie(env, user)).split(';')[0];
  const cardPost = async (user = 'Lead.One', data = {}) => card.onRequestPost({ env, request: new Request(`${ORIGIN}/api/job-payment`, { method: 'POST', headers: { Cookie: cookies[user], Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'field_exact_balance', job_id: 'job-1', request_id: randomUUID(), amount_cents: 10000, ...data }) }) });
  const fieldGet = async (user = 'Lead.One') => field.onRequestGet({ env, request: new Request(`${ORIGIN}/api/field-payments?job_id=job-1`, { headers: { Cookie: cookies[user], Origin: ORIGIN } }) });
  const fieldPost = async (user, data) => field.onRequestPost({ env, request: new Request(`${ORIGIN}/api/field-payments`, { method: 'POST', headers: { Cookie: cookies[user], Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  return { docs, sessions, stripePosts, cardPost, fieldGet, fieldPost, job: () => docs.get('jobs/job-1').value, edit: patch => { const row = docs.get('jobs/job-1'); row.value = { ...row.value, ...patch }; row.version++; } };
}
const body = async response => ({ status: response.status, ...(await response.json()) });

test('exact card checkout has one durable claim across request IDs and can be cancelled before cash', async t => {
  const f = await fixture(t), key = randomUUID();
  const first = await body(await f.cardPost('Lead.One', { request_id: key }));
  assert.equal(first.status, 200); assert.equal(f.stripePosts.length, 1); assert.equal(f.job().fieldPaymentCardRequestId, key);
  const claim = (await body(await f.fieldGet())).cardCheckout;
  assert.equal(claim.status, 'open'); assert.equal(claim.sessionId, first.sessionId);
  assert.equal((await body(await f.cardPost('Lead.One', { request_id: key }))).sessionId, first.sessionId);
  assert.equal(f.stripePosts.length, 1, 'same request resumes without creating a second checkout');
  const second = await body(await f.cardPost());
  assert.equal(second.status, 409); assert.equal(second.code, 'FIELD_PAY_CARD_OPEN'); assert.equal(second.sessionId, first.sessionId);
  assert.equal((await f.cardPost('Crew.Two')).status, 403);
  const deniedCash = await body(await f.fieldPost('Lead.One', { action: 'submit', jobId: 'job-1', requestId: randomUUID(), expectedBalanceCents: 10000, method: 'cash', amountCents: 5000, reference: 'Receipt 10', receiptDataUrl: image }));
  assert.equal(deniedCash.code, 'FIELD_PAY_CARD_OPEN'); assert.equal(f.job().payment.amount, 0);
  const cancelled = await body(await f.fieldPost('Lead.One', { action: 'cancel_card', jobId: 'job-1', requestId: randomUUID(), expectedRevision: claim.revision }));
  assert.equal(cancelled.status, 200); assert.equal(f.sessions.get(first.sessionId).status, 'expired'); assert.equal(f.job().fieldPaymentCardRequestId, null);
  const cash = await body(await f.fieldPost('Lead.One', { action: 'submit', jobId: 'job-1', requestId: randomUUID(), expectedBalanceCents: 10000, method: 'cash', amountCents: 5000, reference: 'Receipt 10', receiptDataUrl: image }));
  assert.equal(cash.status, 200); assert.equal(cash.submissions[0].status, 'pending');
  assert.equal((await body(await f.cardPost())).status, 409, 'pending cash blocks a second card checkout');
});

test('a portal checkout or changed exact balance blocks field card before Stripe', async t => {
  const f = await fixture(t);
  f.docs.set('customer_payment_checkouts/job-1', { value: { status: 'creating', key: 'old-customer-checkout' }, version: 1 });
  const held = await body(await f.cardPost());
  assert.equal(held.code, 'FIELD_PAY_PORTAL_CHECKOUT_OPEN'); assert.equal(f.stripePosts.length, 0);
  f.docs.get('customer_payment_checkouts/job-1').value.status = 'expired'; f.docs.get('customer_payment_checkouts/job-1').version++;
  f.edit({ payment: { amount: 20, verified: true } });
  assert.equal((await body(await f.cardPost())).code, 'FIELD_PAY_BALANCE_CHANGED'); assert.equal(f.stripePosts.length, 0);
});

test('a paid prior field session cannot be cancelled into a cash collection', async t => {
  const f = await fixture(t), first = await body(await f.cardPost());
  const state = (await body(await f.fieldGet())).cardCheckout;
  f.sessions.get(first.sessionId).status = 'complete'; f.sessions.get(first.sessionId).payment_status = 'paid';
  const cancel = await body(await f.fieldPost('Lead.One', { action: 'cancel_card', jobId: 'job-1', requestId: randomUUID(), expectedRevision: state.revision }));
  assert.equal(cancel.code, 'FIELD_PAY_CARD_PAID'); assert.equal(cancel.sessionId, first.sessionId);
  assert.equal(f.job().fieldPaymentCardRequestId !== null, true);
  assert.equal((await body(await f.cardPost())).code, 'FIELD_PAY_CARD_OPEN');
});

test('an unresolved creating claim older than Stripe idempotency retention stays locked for reconciliation', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const first = await body(await f.cardPost('Lead.One', { request_id: requestId }));
  assert.equal(first.status, 200);
  const row = f.docs.get('fieldPaymentCardCheckouts/job-1');
  row.value = { ...row.value, status: 'creating', sessionId: '', url: null, createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() };
  row.version++;
  const retry = await body(await f.cardPost('Lead.One', { request_id: requestId }));
  assert.equal(retry.status, 409);
  assert.equal(retry.code, 'FIELD_PAY_CARD_RECONCILE_REQUIRED');
  assert.equal(f.stripePosts.length, 1, 'old Stripe key is never POSTed again');
  const state = (await body(await f.fieldGet())).cardCheckout;
  assert.equal(state.status, 'creating');
  const cancel = await body(await f.fieldPost('Lead.One', { action: 'cancel_card', jobId: 'job-1', requestId: randomUUID(), expectedRevision: state.revision }));
  assert.equal(cancel.status, 409);
  assert.equal(cancel.code, 'FIELD_PAY_CARD_RECONCILE_REQUIRED');
  assert.equal(f.job().fieldPaymentCardRequestId, requestId);
  assert.equal(f.stripePosts.length, 1);
});

test('field flag routes all crew card creation through lead-only exact mode and refuses ineligible jobs', async t => {
  const f = await fixture(t);
  const member = await body(await f.cardPost('Crew.Two', { mode: undefined, amount_cents: 5000 }));
  const leadPartial = await body(await f.cardPost('Lead.One', { mode: undefined, amount_cents: 5000 }));
  assert.equal(member.code, 'FIELD_PAY_CANONICAL_REQUIRED');
  assert.equal(leadPartial.code, 'FIELD_PAY_CANONICAL_REQUIRED');
  assert.equal(f.stripePosts.length, 0);
  for (const patch of [
    { status: 'cancelled' }, { pipelineStatus: 'lost' }, { invoice: { status: 'void' } },
    { type: 'walkthrough' }, { recordType: 'employee_hub_v2' }, { refundedAmount: 100 },
  ]) {
    const before = { ...f.job() };
    f.edit(patch);
    const blocked = await body(await f.cardPost());
    assert.equal(blocked.status, 409, JSON.stringify(patch));
    assert.equal(blocked.code, 'FIELD_PAY_JOB_UNAVAILABLE', JSON.stringify(patch));
    f.edit(before);
  }
  assert.equal(f.stripePosts.length, 0);
});

test('a reused exact checkout is checked against Stripe identity before its URL is returned', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const first = await body(await f.cardPost('Lead.One', { request_id: requestId }));
  assert.equal(first.status, 200);
  f.sessions.get(first.sessionId).metadata.job_id = 'different-job';
  const replay = await body(await f.cardPost('Lead.One', { request_id: requestId }));
  assert.equal(replay.code, 'FIELD_PAY_CARD_UNVERIFIED');
  assert.equal(f.stripePosts.length, 1);
});
