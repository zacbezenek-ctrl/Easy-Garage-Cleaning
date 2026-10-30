import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesRouter } from './helpers/pages-router.mjs';

// /api/garage-guard-checkout through the Pages router (middleware included). Stripe is a fetch stub that records each
// Checkout Session request; every other host is refused, so nothing leaves the process. Keys and price ids are synthetic.
const SITE = 'https://easygaragecleaning.com', STRIPE = 'https://api.stripe.com/v1/checkout/sessions', KEY = 'sk_test_synthetic_guard_checkout';
const PLANS = { lite: { amount: 45000, name: 'Guard Lite', priceEnv: 'STRIPE_PRICE_GUARD_LITE' }, guard: { amount: 80000, name: 'Garage Guard', priceEnv: 'STRIPE_PRICE_GUARD' }, black: { amount: 250000, name: 'Guard Black', priceEnv: 'STRIPE_PRICE_GUARD_BLACK' } };
const opened = () => Response.json({ id: 'cs_test_synthetic', url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic' });

async function checkout(body, { env = { STRIPE_SECRET_KEY: KEY }, headers = { Origin: SITE }, stripe = opened, method = 'POST' } = {}) {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    if (url !== STRIPE) throw new Error(`External network refused: ${url}`);
    calls.push({ init, form: new URLSearchParams(init.body) });
    return stripe();
  };
  const router = createPagesRouter({ env });
  try {
    const request = new Request(`${SITE}/api/garage-guard-checkout`, method === 'GET' ? { headers } : { method, headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const response = await router.fetch(request);
    await router.settle();
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text), calls };
  } finally { globalThis.fetch = original; }
}

test('each plan opens a yearly subscription Checkout at its server-side amount when no Stripe price is configured', async () => {
  for (const [plan, expected] of Object.entries(PLANS)) {
    // The browser sends only the plan; an amount, price, interval or redirect it adds is ignored.
    const result = await checkout({ plan, amount: 1, price: 'price_from_browser', interval: 'day', success_url: 'https://evil.example/' });
    assert.deepEqual([result.status, result.body], [200, { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_synthetic' }], plan);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.calls.length, 1);
    const [{ init, form }] = result.calls;
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual([form.get('mode'), form.get('line_items[0][quantity]'), form.get('line_items[0][price]')], ['subscription', '1', null]);
    assert.deepEqual([form.get('line_items[0][price_data][currency]'), form.get('line_items[0][price_data][unit_amount]'), form.get('line_items[0][price_data][recurring][interval]'), form.get('line_items[0][price_data][product_data][name]')],
      ['usd', String(expected.amount), 'year', expected.name], plan);
    assert.deepEqual([form.get('metadata[plan]'), form.get('subscription_data[metadata][plan]')], [plan, plan]);
    assert.equal(form.get('success_url'), `${SITE}/garage-guard.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(form.get('cancel_url'), `${SITE}/garage-guard.html?checkout=cancelled#plans`);
    assert.doesNotMatch(init.body, /evil\.example|price_from_browser|interval%5D=day/);
  }
});

test('a configured Stripe price id is passed through in place of the inline amount, per plan', async () => {
  const env = { STRIPE_SECRET_KEY: KEY, STRIPE_PRICE_GUARD: 'price_synthetic_guard_yearly' };
  const guard = (await checkout({ plan: 'guard' }, { env })).calls[0].form;
  assert.equal(guard.get('line_items[0][price]'), 'price_synthetic_guard_yearly');
  assert.equal([...guard.keys()].some(key => key.startsWith('line_items[0][price_data]')), false, 'no inline amount beside the price id');
  // A plan whose own price variable is unset still uses its inline amount.
  const lite = (await checkout({ plan: 'lite' }, { env })).calls[0].form;
  assert.deepEqual([lite.get('line_items[0][price]'), lite.get('line_items[0][price_data][unit_amount]')], [null, '45000']);
});

test('an unknown or missing plan, bad JSON and an oversized body are refused before Stripe is called', async () => {
  for (const body of [{ plan: 'platinum' }, { plan: 'LITE' }, {}, { plan: '' }]) {
    const result = await checkout(body);
    assert.deepEqual([result.status, result.body, result.calls.length], [400, { ok: false, error: 'Unknown plan' }, 0], JSON.stringify(body));
  }
  const bad = await checkout('{plan:');
  assert.deepEqual([bad.status, bad.body, bad.calls.length], [400, { ok: false, error: 'Invalid JSON' }, 0]);
  const large = await checkout({ plan: 'lite', note: 'x'.repeat(5000) });
  assert.deepEqual([large.status, large.body, large.calls.length], [413, { ok: false, error: 'Payload too large' }, 0]);
});

test('without a Stripe secret key checkout answers 503 and the probe says not configured, never showing a key', async () => {
  for (const env of [{}, { STRIPE_SECRET_KEY: '' }, { STRIPE_SECRET_KEY: 'pk_test_synthetic_publishable' }]) {
    const result = await checkout({ plan: 'guard' }, { env });
    assert.deepEqual([result.status, result.body, result.calls.length], [503, { ok: false, error: 'Payments not configured' }, 0], JSON.stringify(env));
  }
  const off = await checkout(null, { env: {}, method: 'GET' });
  assert.deepEqual([off.status, off.body], [200, { ok: true, configured: false, plans: ['lite', 'guard', 'black'] }]);
  const on = await checkout(null, { method: 'GET' });
  assert.deepEqual(on.body, { ok: true, configured: true, plans: ['lite', 'guard', 'black'] });
  assert.doesNotMatch(on.text, /sk_test/);
});

test('a Stripe error is never relayed to the browser', async () => {
  const detail = { error: { type: 'invalid_request_error', message: 'No such price: price_synthetic_secret; account acct_synthetic; key sk_test_synthetic_guard_checkout' } };
  for (const [stripe, error] of [
    [() => Response.json(detail, { status: 400 }), 'Could not start checkout'],
    [() => Response.json({ id: 'cs_test_synthetic' }), 'Could not start checkout'],
    [() => new Response('<html>Bad gateway</html>', { status: 502 }), 'Bad Stripe response'],
    [() => { throw new TypeError('fetch failed: api.stripe.com'); }, 'Stripe unreachable'],
  ]) {
    const result = await checkout({ plan: 'black' }, { stripe });
    assert.deepEqual([result.status, result.body], [502, { ok: false, error }]);
    assert.doesNotMatch(result.text, /price_synthetic_secret|acct_|sk_test|invalid_request_error|api\.stripe\.com|Bad gateway/);
  }
});

test('a foreign or look-alike Origin or Referer is refused; the site\'s own hosts are accepted', async () => {
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'https://easygaragecleaning.com.evil.example' }, { Origin: 'http://easygaragecleaning.co' },
    { Referer: 'https://evil.example/garage-guard.html' }, { Origin: 'null' }]) {
    const result = await checkout({ plan: 'guard' }, { headers });
    assert.deepEqual([result.status, result.body, result.calls.length], [403, { ok: false, error: 'Forbidden origin' }, 0], JSON.stringify(headers));
  }
  for (const headers of [{ Origin: 'https://www.easygaragecleaning.com' }, { Origin: 'https://easy-garage-cleaning.pages.dev' }, { Referer: `${SITE}/garage-guard.html#plans` }]) {
    assert.equal((await checkout({ plan: 'guard' }, { headers })).status, 200, JSON.stringify(headers));
  }
});

test('current behavior, reported for review: a request with neither Origin nor Referer is allowed to start a checkout', async () => {
  // originAllowed() returns true when both headers are missing (a server-side or scripted caller, not a browser page).
  // The session it opens is still Stripe-hosted at the server's own price and redirects only to this site, but this is
  // recorded here so a change to that rule is a visible decision.
  const result = await checkout({ plan: 'lite' }, { headers: {} });
  assert.deepEqual([result.status, result.calls.length, result.calls[0].form.get('line_items[0][price_data][unit_amount]')], [200, 1, '45000']);
});
