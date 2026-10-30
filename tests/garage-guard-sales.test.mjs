import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPagesRouter } from './helpers/pages-router.mjs';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { GARAGE_GUARD_CHECKOUT_PLANS, garageGuardCheckoutParams } from '../functions/_lib/garage-guard-checkout.js';
import { GUARD_SALE_TEXT_TEMPLATE, guardLinkSignature, guardSaleFromMetadata, guardSaleText } from '../functions/_lib/garage-guard-sales.js';
import { applyGarageGuardEvent, garageGuardEvent } from '../functions/_lib/garage-guard-membership.js';
import { AUTOMATION_REGISTRY } from '../functions/_lib/automation-registry-data.js';
import { garageGuardSellHandlers } from '../functions/api/garage-guard-sell.js';
import { stripeWebhookHandlers } from '../functions/api/stripe-webhook.js';

/* GUARD-SELL: the staff Garage Guard sales tool's server side, through the real Pages routes (tests/helpers/pages-router.mjs
   with the middleware) and a fake Stripe and HighLevel behind the global fetch: nothing leaves the process, and any other
   host fails the test. Synthetic people, jobs and ids only. */

const ORIGIN = 'https://easygaragecleaning.com', NOW = '2026-10-30T18:00:00.000Z';
const USERS = { 'crew.one': { role: 'crew', displayName: 'Crew One', passwordHash: 'synthetic-hash' }, 'crew.two': { role: 'crew', displayName: 'Crew Two', passwordHash: 'synthetic-hash' },
  'rep.one': { role: 'crew', displayName: 'Rep One', passwordHash: 'synthetic-hash' }, ZacB: { role: 'owner', displayName: 'Zac Owner', passwordHash: 'synthetic-hash' } };
const ENV = Object.freeze({ HUB_SESSION_SECRET: 'synthetic-guard-sales-hub-secret-0123456789abcdef', STRIPE_SECRET_KEY: 'sk_test_syntheticGuardSales', HUB_AUTH_USERS_JSON: JSON.stringify(USERS) });
const REQUEST_ID = '00000000-0000-4000-a000-000000000001';
const cookie = async (user, env = ENV) => (await createHubSessionCookie(env, user)).split(';')[0];

// Fake Stripe (Checkout sessions, with Idempotency-Key) and HighLevel (one contact, conversations). Records every call.
function world({ contact = { id: 'ghl-contact-1', locationId: 'loc-synthetic', phone: '+19705550101', tags: [] } } = {}) {
  const sessions = new Map(), keys = new Map(), calls = [], outside = [];
  let serial = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetcher(input, init = {}) {
    const url = new URL(String(input instanceof Request ? input.url : input)), method = (init.method || 'GET').toUpperCase(), headers = new Headers(init.headers || {});
    calls.push({ method, host: url.hostname, path: url.pathname, headers, body: init.body ? String(init.body) : '' });
    if (url.hostname === 'api.stripe.com') {
      assert.equal(headers.get('Authorization'), `Bearer ${ENV.STRIPE_SECRET_KEY}`);
      if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const key = headers.get('Idempotency-Key');
        if (key && keys.has(key)) return json(sessions.get(keys.get(key)));
        const form = new URLSearchParams(String(init.body)), id = `cs_test_guardsale${String(++serial).padStart(4, '0')}`;
        const metadata = Object.fromEntries([...form].filter(([name]) => /^metadata\[/.test(name)).map(([name, value]) => [name.slice(9, -1), value]));
        const session = { id, object: 'checkout.session', mode: 'subscription', status: 'open', payment_status: 'unpaid', url: `https://checkout.stripe.com/c/pay/${id}#fidSynthetic`, metadata, form };
        sessions.set(id, session); if (key) keys.set(key, id);
        return json(session);
      }
      const match = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
      if (method === 'GET' && match) return sessions.has(match[1]) ? json(sessions.get(match[1])) : json({ error: { type: 'invalid_request_error' } }, 404);
    }
    if (url.hostname === 'services.leadconnectorhq.com') {
      if (method === 'GET' && url.pathname === `/contacts/${contact.id}`) return json({ contact });
      if (method === 'POST' && url.pathname === '/conversations/messages') return json({ messageId: `msg-${calls.length}`, conversationId: 'conv-1' });
    }
    outside.push(`${method} ${url.hostname}${url.pathname}`);
    throw new Error(`Synthetic test: refused ${url.hostname}${url.pathname}`);
  }
  return { fetcher, sessions, calls, outside, stripe: () => calls.filter(call => call.host === 'api.stripe.com'), highlevel: () => calls.filter(call => call.host === 'services.leadconnectorhq.com') };
}

// Runs fn with the fake world as the global fetch, the way the production handlers reach Stripe.
async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetcher;
  try { return await fn(); } finally { globalThis.fetch = original; assert.deepEqual(fake.outside, [], 'no request left the process'); }
}

function routed(env = ENV) {
  const router = createPagesRouter({ now: NOW, env });
  const call = async (path, { method = 'GET', user = '', body, headers = {} } = {}) => {
    const response = await router.fetch(new Request(ORIGIN + path, { method, headers: { ...(user ? { Cookie: await cookie(user, env) } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env);
    assert.deepEqual(router.errors, [], 'no Pages function threw');
    const type = response.headers.get('Content-Type') || '';
    return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : await response.text() };
  };
  return call;
}

const start = (overrides = {}) => ({ action: 'start', requestId: REQUEST_ID, plan: 'guard', channel: 'postjob', jobId: 'job-1', customerId: 'cust-1', email: 'Dana@Example.invalid', address: '1 Synthetic Way, Fort Collins', ...overrides });

test('the plans keep their amounts and drop the two unenforced promises, and the public checkout body is unchanged', async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(GARAGE_GUARD_CHECKOUT_PLANS).map(([key, plan]) => [key, plan.amount])), { lite: 45000, guard: 80000, black: 250000 });
  for (const plan of Object.values(GARAGE_GUARD_CHECKOUT_PLANS)) {
    assert.doesNotMatch(plan.description + plan.includes.join(' '), /gift card|Limited to 5|memberships/i, plan.name);
    assert.ok(plan.includes.length >= 2 && plan.includes.every(item => typeof item === 'string' && item));
  }
  const params = garageGuardCheckoutParams('guard', { origin: ORIGIN, env: {} });
  assert.deepEqual([...params.keys()], ['mode', 'success_url', 'cancel_url', 'line_items[0][quantity]', 'line_items[0][price_data][currency]', 'line_items[0][price_data][unit_amount]',
    'line_items[0][price_data][recurring][interval]', 'line_items[0][price_data][product_data][name]', 'line_items[0][price_data][product_data][description]', 'phone_number_collection[enabled]',
    'billing_address_collection', 'custom_fields[0][key]', 'custom_fields[0][label][type]', 'custom_fields[0][label][custom]', 'custom_fields[0][type]', 'allow_promotion_codes', 'metadata[plan]', 'subscription_data[metadata][plan]']);
  assert.equal(params.get('line_items[0][price_data][product_data][description]'), 'Garage Guard membership — 4 quarterly visits a year, up to 5 cubic yards hauled each visit.');
  assert.equal(garageGuardCheckoutParams('black', { origin: ORIGIN }).get('line_items[0][price_data][product_data][description]'), 'Garage Guard Black — monthly whole-property visits, free monthly single-item pickup, annual deep clean, front-of-line scheduling.');
  assert.equal(garageGuardCheckoutParams('toString', { origin: ORIGIN }), null);

  // The public page through its real route: no staff fields, and the two bugs found by the checkout tests stay fixed.
  const fake = world(), call = routed();
  await withFetch(fake, async () => {
    const ok = await call('/api/garage-guard-checkout', { method: 'POST', body: { plan: 'lite' } });
    assert.equal(ok.status, 200); assert.match(ok.body.url, /^https:\/\/checkout\.stripe\.com\//);
    const sent = new URLSearchParams(fake.stripe()[0].body);
    assert.equal(sent.get('line_items[0][price_data][unit_amount]'), '45000');
    assert.equal(sent.get('customer_email'), null); assert.equal(sent.get('metadata[sold_by]'), null); assert.equal(fake.stripe()[0].headers.get('Idempotency-Key'), null);
    for (const plan of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const refused = await call('/api/garage-guard-checkout', { method: 'POST', body: { plan } });
      assert.deepEqual([refused.status, refused.body.error], [400, 'Unknown plan'], plan);
    }
    for (const raw of ['null', '5', '"guard"']) {
      const refused = await call('/api/garage-guard-checkout', { method: 'POST', body: raw });
      assert.deepEqual([refused.status, refused.body.error], [400, 'Unknown plan'], raw);
    }
    assert.equal(fake.stripe().length, 1, 'a refused plan never reaches Stripe');
  });
});

test('any signed-in staff member gets the plans from the server; a signed-out request gets nothing', async () => {
  const call = routed();
  const signedOut = await call('/api/garage-guard-sell');
  assert.deepEqual([signedOut.status, signedOut.body.code], [401, 'guard_sales_auth_required']);
  assert.equal(signedOut.body.plans, undefined);
  const plans = await call('/api/garage-guard-sell', { user: 'crew.one' });
  assert.equal(plans.status, 200);
  assert.deepEqual(plans.body.plans.map(plan => [plan.key, plan.name, plan.amountCents, plan.interval]), [['black', 'Guard Black', 250000, 'year'], ['guard', 'Garage Guard', 80000, 'year'], ['lite', 'Guard Lite', 45000, 'year']]);
  assert.deepEqual([plans.body.configured, plans.body.textEnabled], [true, false]);
  assert.match(plans.headers.get('Cache-Control'), /no-store/);
  const unconfigured = await routed({ ...ENV, STRIPE_SECRET_KEY: 'pk_live_publishable' })('/api/garage-guard-sell', { user: 'crew.one', });
  assert.equal(unconfigured.body.configured, false);
});

test('start opens the Stripe subscription checkout with the seller, channel, job and customer on the session and the subscription', async () => {
  const fake = world(), call = routed();
  await withFetch(fake, async () => {
    const sold = await call('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body: start() });
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    const [request] = fake.stripe(), form = new URLSearchParams(request.body);
    assert.equal(request.headers.get('Idempotency-Key'), `egc-guard-sell-${REQUEST_ID}`);
    assert.equal(request.headers.get('Stripe-Version'), '2024-06-20');
    assert.deepEqual([form.get('mode'), form.get('line_items[0][price_data][unit_amount]'), form.get('line_items[0][price_data][recurring][interval]')], ['subscription', '80000', 'year']);
    assert.equal(form.get('success_url'), `${ORIGIN}/garage-guard.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(form.get('customer_email'), 'dana@example.invalid');
    assert.equal(form.get('custom_fields[0][text][default_value]'), '1 Synthetic Way, Fort Collins');
    const attribution = { plan: 'guard', sold_by: 'crew.one', sales_channel: 'postjob', sale_job_id: 'job-1', sale_customer_id: 'cust-1', sale_request_id: REQUEST_ID };
    for (const [key, value] of Object.entries(attribution)) {
      assert.equal(form.get(`metadata[${key}]`), value, key);
      assert.equal(form.get(`subscription_data[metadata][${key}]`), value, `subscription ${key}`);
    }
    const sessionId = fake.sessions.keys().next().value, signature = await guardLinkSignature(ENV, sessionId);
    assert.deepEqual(sold.body, { ok: true, sessionId, link: `${ORIGIN}/api/garage-guard-link?s=${sessionId}&k=${signature}`, plan: { key: 'guard', name: 'Garage Guard', amountCents: 80000, interval: 'year', includes: [...GARAGE_GUARD_CHECKOUT_PLANS.guard.includes] }, status: 'open' });
    assert.ok(sold.body.link.length < 160, 'the QR code stays small');

    // A retried tap with the same request id answers the same session.
    const again = await call('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body: start() });
    assert.equal(again.body.sessionId, sessionId); assert.equal(fake.sessions.size, 1);

    // With a dashboard Price the line uses it; amounts never come from the browser.
    const priced = await routed({ ...ENV, STRIPE_PRICE_GUARD_BLACK: 'price_synthetic_black' })('/api/garage-guard-sell', { method: 'POST', user: 'rep.one', body: start({ requestId: '00000000-0000-4000-a000-000000000002', plan: 'black', channel: 'knock', jobId: '', customerId: '', email: '', address: '' }) });
    assert.equal(priced.status, 200);
    const blackForm = new URLSearchParams(fake.stripe().at(-1).body);
    assert.deepEqual([blackForm.get('line_items[0][price]'), blackForm.get('line_items[0][price_data][unit_amount]'), blackForm.get('customer_email'), blackForm.get('metadata[sold_by]'), blackForm.get('metadata[sales_channel]'), blackForm.get('metadata[sale_job_id]')],
      ['price_synthetic_black', null, null, 'rep.one', 'knock', null]);

    const before = fake.stripe().length;
    const refusals = [
      [start({ amountCents: 100 }), 400, 'guard_sales_request_invalid'], [start({ price: 1 }), 400, 'guard_sales_request_invalid'], [start({ plan: 'platinum' }), 400, 'guard_sales_plan_invalid'],
      [start({ plan: 'toString' }), 400, 'guard_sales_plan_invalid'], [start({ channel: 'website' }), 400, 'guard_sales_channel_invalid'], [start({ email: 'not-an-email' }), 400, 'guard_sales_email_invalid'],
      [start({ jobId: 'jobs/../x' }), 400, 'guard_sales_request_invalid'], [start({ requestId: 'short' }), 400, 'guard_sales_request_invalid'], ['null', 400, 'guard_sales_json_invalid'],
    ];
    for (const [body, status, code] of refusals) {
      const refused = await call('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body });
      assert.deepEqual([refused.status, refused.body.code], [status, code], JSON.stringify(body));
    }
    const signedOut = await call('/api/garage-guard-sell', { method: 'POST', body: start() });
    assert.equal(signedOut.status, 401);
    const crossSite = await call('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body: start(), headers: { Origin: 'https://attacker.example' } });
    assert.deepEqual([crossSite.status, crossSite.body.code], [403, 'guard_sales_origin_forbidden']);
    assert.equal(fake.stripe().length, before, 'no refused sign-up reaches Stripe');
  });
});

test('the short link sends the customer to the open Stripe page, and never asks Stripe about a forged link', async () => {
  const fake = world(), call = routed();
  await withFetch(fake, async () => {
    const { body: sold } = await call('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body: start() });
    const path = sold.link.slice(ORIGIN.length), session = fake.sessions.get(sold.sessionId);
    const open = await call(path);
    assert.deepEqual([open.status, open.headers.get('Location'), open.headers.get('Cache-Control')], [303, session.url, 'no-store']);
    assert.match(open.headers.get('Referrer-Policy'), /^(?:no-referrer|strict-origin-when-cross-origin)$/, 'Stripe never receives the signed link as a referrer');
    const reads = fake.stripe().length;
    for (const forged of [path.replace(/k=.*/, 'k=AAAAAAAAAAAAAAAAAAAAAA'), path.replace(/&k=.*/, ''), '/api/garage-guard-link?s=cs_test_guardsale9999&k=x', '/api/garage-guard-link']) {
      const refused = await call(forged);
      assert.equal(refused.status, 404, forged); assert.match(refused.body, /not valid/);
      assert.doesNotMatch(refused.body, /crew\.one|Dana|job-1/);
    }
    assert.equal(fake.stripe().length, reads, 'a forged link never reaches Stripe');
    session.url = 'https://evil.example/c/pay'; assert.equal((await call(path)).status, 410, 'only a Stripe Checkout page is a redirect target');
    session.status = 'complete'; session.payment_status = 'paid';
    assert.deepEqual([(await call(path)).status, (await call(path)).headers.get('Location')], [303, '/garage-guard.html?checkout=success']);
    session.status = 'expired'; assert.equal((await call(path)).status, 410);
    // A public-page session (no seller) is never served through this route, even with a valid signature.
    const publicSession = { id: 'cs_test_publicpage0001', status: 'open', url: 'https://checkout.stripe.com/c/pay/x', metadata: { plan: 'lite' } };
    fake.sessions.set(publicSession.id, publicSession);
    assert.equal((await call(`/api/garage-guard-link?s=${publicSession.id}&k=${await guardLinkSignature(ENV, publicSession.id)}`)).status, 404);
  });
});

test('the seller sees "Member" once Stripe completes the sign-up; another crew member cannot read it, a dispatcher can', async () => {
  const fake = world(), call = routed();
  await withFetch(fake, async () => {
    const { body: sold } = await call('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body: start() });
    const status = user => call(`/api/garage-guard-sell?session=${sold.sessionId}`, { user });
    assert.deepEqual((await status('crew.one')).body, { ok: true, status: 'open', member: false, plan: 'guard' });
    Object.assign(fake.sessions.get(sold.sessionId), { status: 'complete', payment_status: 'paid' });
    assert.deepEqual((await status('crew.one')).body, { ok: true, status: 'complete', member: true, plan: 'guard' });
    const other = await status('crew.two');
    assert.deepEqual([other.status, other.body.code], [404, 'guard_sales_session_missing']);
    assert.equal((await status('ZacB')).body.member, true);
    assert.equal((await call('/api/garage-guard-sell?session=cs_test_guardsale0001&x=1', { user: 'crew.one' })).status, 400);
    for (const body of Object.values((await status('crew.one')).body)) assert.doesNotMatch(String(body), /dana|Synthetic Way|cust-1|job-1/i, 'the status never names the customer or job');
  });
});

// Hub storage for the text path: jobs and the one-text claims, with create-only and revision semantics like dispatchStorage.
function memoryStorage(seed) {
  const rows = new Map(Object.entries(seed).map(([path, value]) => [path, { value, revision: 'rev-0' }])), commits = [];
  let serial = 0;
  return {
    rows, commits,
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? { ...structuredClone(row.value), id, revision: row.revision } : null; },
    async commit(writes) {
      for (const write of writes) {
        const row = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? row?.revision !== write.revision : row) throw Object.assign(new Error('conflict'), { code: 'dispatch_revision_conflict' });
      }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { value: { ...(rows.get(`${write.collection}/${write.id}`)?.value || {}), ...structuredClone(write.patch) }, revision: `rev-${++serial}` });
      commits.push(writes.map(write => `${write.collection}/${write.id}`));
    },
  };
}

test('texting the link is off by default: the sheet only shows the code and Copy link', async () => {
  const fake = world(), call = routed();
  await withFetch(fake, async () => {
    const { body: sold } = await call('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body: start() });
    const refused = await call('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body: { action: 'text', requestId: REQUEST_ID, sessionId: sold.sessionId } });
    assert.deepEqual([refused.status, refused.body.code], [409, 'guard_sales_text_off']);
    for (const value of ['TRUE', '1', 'yes', 'on']) {
      const off = await routed({ ...ENV, EGC_GUARD_SALES_TEXT_ENABLED: value })('/api/garage-guard-sell', { method: 'POST', user: 'crew.one', body: { action: 'text', requestId: REQUEST_ID, sessionId: sold.sessionId } });
      assert.equal(off.body.code, 'guard_sales_text_off', `only exactly "true" turns it on, not ${value}`);
    }
    assert.deepEqual(fake.highlevel(), [], 'HighLevel is never called');
  });
});

test('with texting on, the link is texted once per sign-up to the job\'s HighLevel contact, only by someone on the job', async () => {
  const env = { ...ENV, EGC_GUARD_SALES_TEXT_ENABLED: 'true', HIGHLEVEL_API_KEY: 'synthetic-highlevel-key', HIGHLEVEL_LOCATION_ID: 'loc-synthetic', FIREBASE_API_KEY: 'firebase-test-guard-sales' };
  const fake = world(), storage = memoryStorage({
    'jobs/job-1': { type: 'job', customer: 'Synthetic Dana', phone: '(970) 555-0101', highlevelContactId: 'ghl-contact-1', assignedCrew: ['crew.one'], total: 900, estimate: { amount: 900 } },
    'jobs/job-2': { type: 'job', customer: 'Synthetic Eli', phone: '(970) 555-0102', assignedCrew: ['crew.one'] },
  });
  const handlers = garageGuardSellHandlers({ now: () => new Date(NOW), fetcher: fake.fetcher, storage: () => storage });
  const send = async (user, body, handler = handlers.post) => {
    const response = await handler({ env, request: new Request(`${ORIGIN}/api/garage-guard-sell`, { method: 'POST', headers: { Cookie: await cookie(user, env), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const sold = (await send('crew.one', start())).body;
  const text = { action: 'text', requestId: '00000000-0000-4000-a000-0000000000a1', sessionId: sold.sessionId };
  // Without Hub storage nothing is claimed, so nothing is sent.
  const { FIREBASE_API_KEY: _key, ...noStorage } = env;
  const unstored = await garageGuardSellHandlers({ now: () => new Date(NOW), fetcher: fake.fetcher, storage: () => storage }).post({ env: noStorage,
    request: new Request(`${ORIGIN}/api/garage-guard-sell`, { method: 'POST', headers: { Cookie: await cookie('crew.one', env), Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(text) }) });
  assert.deepEqual([unstored.status, (await unstored.json()).code], [503, 'guard_sales_storage_unavailable']);
  // Someone not on the job never reaches HighLevel and leaves no claim.
  const outsider = await send('crew.two', text);
  assert.deepEqual([outsider.status, outsider.body.code], [404, 'guard_sales_session_missing'], 'another crew member cannot even see the sign-up');
  const owner = await send('ZacB', text);
  assert.equal(owner.status, 200, 'a dispatcher works on every job');
  assert.deepEqual(owner.body, { ok: true, delivery: { status: 'sent' } });
  const [message] = fake.highlevel().filter(call => call.method === 'POST');
  const payload = JSON.parse(message.body);
  assert.equal(payload.message, guardSaleText('guard', sold.link));
  assert.equal(payload.message, `Easy Garage Cleaning: here is your Garage Guard sign-up link ($800 a year, paid securely through Stripe): ${sold.link} Questions? Reply here.`);
  assert.deepEqual([payload.type, payload.contactId, payload.toNumber], ['SMS', 'ghl-contact-1', '+19705550101']);
  assert.doesNotMatch(payload.message, /900/, 'the job\'s own price is never in the text');
  assert.equal(storage.rows.get(`guard_sale_texts/${sold.sessionId}`).value.status, 'sent');
  // Once per sign-up, ever.
  const again = await send('crew.one', { ...text, requestId: '00000000-0000-4000-a000-0000000000a2' });
  assert.deepEqual([again.status, again.body.code], [409, 'guard_sales_text_already_sent']);
  assert.equal(fake.highlevel().filter(call => call.method === 'POST').length, 1);

  // A sale started without a job, or for a job the seller is not on, is never texted.
  const noJob = (await send('crew.one', start({ requestId: '00000000-0000-4000-a000-0000000000b1', jobId: '' }))).body;
  assert.equal((await send('crew.one', { ...text, sessionId: noJob.sessionId })).body.code, 'guard_sales_text_needs_job');
  const otherJob = (await send('crew.two', start({ requestId: '00000000-0000-4000-a000-0000000000b2', jobId: 'job-1', channel: 'walkthrough' }))).body;
  const notOnJob = await send('crew.two', { ...text, sessionId: otherJob.sessionId });
  assert.deepEqual([notOnJob.status, notOnJob.body.code], [403, 'guard_sales_text_forbidden']);
  assert.equal(storage.rows.has(`guard_sale_texts/${otherJob.sessionId}`), false);
  // A closed sign-up is never texted.
  fake.sessions.get(noJob.sessionId).status = 'complete';
  assert.equal((await send('crew.one', { ...text, sessionId: noJob.sessionId })).body.code, 'guard_sales_session_closed');
  assert.equal(fake.highlevel().filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(fake.outside, []);
});

// The webhook side: a minimal store (no customer matches) so the membership commit is visible.
function membershipStore() {
  const rows = new Map();
  return {
    rows,
    async read(collection, id) { const row = rows.get(`${collection}/${id}`); return row ? { ...structuredClone(row), id, revision: row.__rev } : null; },
    async customers() { return []; },
    async customerJobs() { return []; },
    async commit(writes) { for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...(rows.get(`${write.collection}/${write.id}`) || {}), ...structuredClone(write.patch), __rev: `r${rows.size + 1}` }); },
  };
}
const created = Math.floor(Date.parse(NOW) / 1000);
const checkout = ({ id = 'evt_guard_staff_1', session = 'cs_test_guardsale0001', subscription = 'sub_staff_1', metadata = { plan: 'guard', sold_by: 'Crew.One', sales_channel: 'postjob', sale_job_id: 'job-1', sale_customer_id: 'cust-1' } } = {}) => ({
  id, type: 'checkout.session.completed', created, livemode: false, data: { object: { id: session, object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', subscription,
    customer: 'cus_staff_1', amount_total: 80000, metadata, customer_details: { email: 'dana@example.invalid', phone: '+1 970 555 0101', name: 'Synthetic Dana' }, custom_fields: [{ key: 'service_address', text: { value: '1 Synthetic Way' } }] } } });

test('the membership record keeps who sold it from the checkout metadata; a public-page sign-up has no seller', async () => {
  assert.deepEqual(guardSaleFromMetadata({ sold_by: 'Crew.One', sales_channel: 'postjob', sale_job_id: 'job-1' }), { staffKey: 'crew.one', channel: 'postjob', jobId: 'job-1', customerId: '' });
  for (const metadata of [{ plan: 'guard' }, { sold_by: 'crew.one', sales_channel: 'website' }, { sold_by: 'bad key!', sales_channel: 'hub' }, null]) assert.equal(guardSaleFromMetadata(metadata), null);

  const store = membershipStore();
  await applyGarageGuardEvent(store, garageGuardEvent(checkout()), { now: NOW });
  assert.deepEqual(store.rows.get('memberships/sub_staff_1').soldBy, { staffKey: 'crew.one', channel: 'postjob', jobId: 'job-1', customerId: 'cust-1', checkoutSessionId: 'cs_test_guardsale0001', recordedAt: NOW });
  // A later checkout event for the same membership never replaces the seller.
  await applyGarageGuardEvent(store, garageGuardEvent(checkout({ id: 'evt_guard_staff_2', session: 'cs_test_guardsale0002', metadata: { plan: 'guard', sold_by: 'crew.two', sales_channel: 'hub' } })), { now: '2026-10-31T18:00:00.000Z' });
  assert.equal(store.rows.get('memberships/sub_staff_1').soldBy.staffKey, 'crew.one');

  const publicStore = membershipStore();
  await applyGarageGuardEvent(publicStore, garageGuardEvent(checkout({ subscription: 'sub_public_1', metadata: { plan: 'lite' } })), { now: NOW });
  assert.equal('soldBy' in publicStore.rows.get('memberships/sub_public_1'), false);
  assert.equal('sale' in garageGuardEvent(checkout({ metadata: { plan: 'lite' } })), false, 'a public-page event parses exactly as before');
});

test('with membership sync off, the team alert names who sold a staff sign-up and is unchanged for a public one', async () => {
  const secret = 'whsec_synthetic_guard_sales', sent = [];
  const handlers = stripeWebhookHandlers({ now: () => new Date(NOW), send: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); } });
  const deliver = async event => {
    const raw = JSON.stringify(event), signature = createHmac('sha256', secret).update(`${created}.${raw}`).digest('hex');
    return handlers.post({ env: { STRIPE_WEBHOOK_SECRET: secret, GARAGE_GUARD_HOOK_URL: 'https://hooks.example.invalid/guard' }, request: new Request(`${ORIGIN}/api/stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${created},v1=${signature}` }, body: raw }) });
  };
  assert.equal((await deliver(checkout())).status, 200);
  assert.deepEqual([sent[0].sold_by, sent[0].sales_channel, sent[0].plan], ['crew.one', 'postjob', 'guard']);
  await deliver(checkout({ id: 'evt_public', metadata: { plan: 'lite' } }));
  assert.deepEqual(Object.keys(sent[1]).sort(), ['alert', 'amount_total', 'customer_email', 'customer_name', 'customer_phone', 'event_id', 'event_type', 'livemode', 'plan', 'service_address', 'source'], 'the public alert has exactly its old fields');
});

test('the text is registered with its exact wording and stays off; the crew pages load one versioned sheet', () => {
  const entry = AUTOMATION_REGISTRY.automations.find(item => item.id === 'hub.guard_sale_link_text');
  assert.equal(entry.templateText, GUARD_SALE_TEXT_TEMPLATE);
  assert.deepEqual([entry.audience, entry.channel, entry.sendsToday, entry.disposition, entry.approvedBy], ['customer', 'SMS', 'no', 'approved_human', null]);
  assert.deepEqual(AUTOMATION_REGISTRY.codeInventory['functions/api/garage-guard-sell.js'], { hub_send_helper_call: 1 });
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const key = /guard-sell\.js\?v=([A-Za-z0-9]+)/;
  const versions = ['crew/postjob.html', 'crew/gameplan.html', 'crew/knock-guard.js', 'employee-suite.js', 'employee-guard-sales.js'].map(path => [path, key.exec(read(path))?.[1]]);
  for (const [path, version] of versions) assert.equal(version, versions[0][1], `${path} loads the same guard-sell.js build`);
  assert.match(read('crew/guard-sell.js'), new RegExp(`/crew/guard-sell\\.css\\?v=${versions[0][1]}`), 'the sheet loads its stylesheet at the same version');
  // The sheet never carries a plan price of its own: names, prices and inclusions come from GET /api/garage-guard-sell.
  assert.doesNotMatch(read('crew/guard-sell.js'), /45000|80000|250000|\$450|\$800|\$2,500/);
});

test('the owner\'s member list shows who sold each staff sign-up, and nothing for a public-page member', async () => {
  const { member } = await import('./helpers/garage-guard-fixture.mjs');
  const { garageGuardOverview } = await import('../functions/_lib/garage-guard-visits.js');
  const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
  const store = await member();
  const before = (await garageGuardOverview(store, owner, {}, new Date(NOW))).memberships[0];
  assert.equal('soldBy' in before, false, 'a public-page member row is exactly as before');
  store.put('memberships/sub_member_1', { ...store.get('memberships/sub_member_1'), soldBy: { staffKey: 'rep.one', channel: 'knock', jobId: '', customerId: 'cust-dana', checkoutSessionId: 'cs_test_guardsale0001', recordedAt: NOW } });
  const row = (await garageGuardOverview(store, owner, {}, new Date(NOW))).memberships[0];
  assert.deepEqual(row.soldBy, { staffKey: 'rep.one', channel: 'knock', jobId: null, customerId: 'cust-dana', at: NOW });
  assert.deepEqual({ ...row, soldBy: undefined, revision: before.revision }, { ...before, soldBy: undefined }, 'only soldBy is added to the row');
});
