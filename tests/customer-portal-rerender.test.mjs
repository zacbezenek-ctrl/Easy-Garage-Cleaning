// FIX-PORTAL-CRASH: the customer portal's inline load(), Stripe return and closeout note, run from
// customer-portal.html in a vm realm with a fake DOM, fake fetch and an injected timer (no real clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { portalScript } from './helpers/portal-fixture.mjs';

const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
const SESSION = 'cs_test_synthetic_rerender';
const CONFIRMING = 'Your payment is being confirmed. It will appear here shortly.';
const UNCONFIRMED = 'We could not confirm this payment yet. If you were charged, it will appear once the team verifies it. Call (970) 999-1818 with questions.';
const CONNECTION = 'Your project could not be opened right now. Check your connection and refresh the page.';
const VIEW = { ok: true, payment: { balance: 450 } };
const UNSETTLED = { status: 409, body: { ok: false, error: 'Stripe has not verified this job payment' } };
const OUTAGE = { status: 502, body: { ok: false, error: 'Secure checkout could not be confirmed. Please try again.' } };
const DOWN = { status: 503, body: { ok: false, code: 'CUSTOMER_PORTAL_STORAGE_UNAVAILABLE', error: 'Your project could not be loaded. Please try again shortly.' } };
const offline = () => new TypeError('Failed to fetch');

function element(id, hidden) {
  const classes = new Set(hidden ? ['hidden'] : []), attributes = new Map();
  return {
    id, textContent: '', dataset: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name); return on; } },
    setAttribute: (name, value) => attributes.set(name, String(value)), getAttribute: name => attributes.get(name) ?? null, removeAttribute: name => attributes.delete(name),
    get hidden() { return classes.has('hidden'); },
  };
}

// gets/posts are queues of { status, body }, { status, html: true } (a body that is not JSON, like a proxy's error page) or an Error
// (a failed fetch). render, like the page's, first makes the answer portalData and then throws for a view with `boom`; with
// boom: 'late' it throws only after making #portal visible, as a malformed conversation entry does after renderPortalBase.
// A portal that is already `shown` was drawn by an earlier good render, so portalData holds that answer.
function portal({ search = '', shown = false, gets = [], posts = [] } = {}) {
  const hidden = new Set(['portal', 'error', 'render-notice', 'payment-notice', 'reconnect-pill', 'toast']);
  if (shown) { hidden.delete('portal'); hidden.add('loading'); }
  const nodes = new Map(), $ = id => nodes.get(id) || nodes.set(id, element(id, hidden.has(id))).get(id);
  const state = { requests: [], renders: [], errors: [], toasts: [], logged: [], replaced: [], timers: [] };
  const location = { search, reload() {} };
  const answer = async (url, options = {}) => {
    const method = options.method || 'GET', queue = method === 'GET' ? gets : posts;
    state.requests.push(method === 'GET' ? { method } : { method, body: JSON.parse(options.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    assert.ok(next, `no ${method} answer queued`);
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, json: async () => { if (next.html) throw new SyntaxError('Unexpected token < in JSON'); return structuredClone(next.body); } };
  };
  const root = { dataset: {} };
  const context = vm.createContext({
    document: { getElementById: $, documentElement: root }, fetch: answer, location, URLSearchParams, portalData: shown ? structuredClone(VIEW) : null,
    history: { replaceState: (...args) => { state.replaced.push(args); location.search = new URL(args[2], 'https://easygaragecleaning.com').search; } },
    render: data => {
      state.renders.push(data); context.portalData = data;
      const show = () => { $('portal').classList.remove('hidden'); $('loading').classList.add('hidden'); };
      if (data.boom === 'late') show();
      if (data.boom) throw new TypeError("Cannot set properties of null (setting 'textContent')");
      show();
    },
    showError: message => state.errors.push(message), toast: (message, bad) => state.toasts.push([message, Boolean(bad)]),
    console: { error: (...args) => state.logged.push(args) }, setTimeout: (callback, ms) => { state.timers.push({ callback, ms }); return state.timers.length; },
  });
  vm.runInContext(portalScript(html, ['const $=id=>document.getElementById(id),money=', 'function portalError(', 'async function api(', 'function renderSafely(', 'function loadFailed(', 'async function load(', 'function paymentNotice(', 'function stripeSeen(', 'async function stripeReturn(', 'async function confirmStripePayment(']), context);
  const verifies = () => state.requests.filter(request => request.body?.action === 'verify_payment');
  // Runs every scheduled retry in order (each awaited, as the page's timer would run it) and returns the delays.
  const drain = async () => { const delays = []; while (state.timers.length) { const timer = state.timers.shift(); delays.push(timer.ms); await timer.callback(); } return delays; };
  return { context, state, $, location, verifies, drain, root };
}
const returned = `?payment=stripe-success&session_id=${SESSION}`;

test('a Stripe return Stripe has not settled keeps the portal, asks again after 2, 4, 8, 16 and 32 seconds, then says it could not confirm yet', async () => {
  const page = portal({ search: returned, gets: [{ status: 200, body: VIEW }], posts: [UNSETTLED] });
  assert.equal(await page.context.load(), true);
  assert.deepEqual(page.state.replaced, [[null, '', '/customer-portal']], 'the return parameters are dropped before verifying');
  assert.equal(page.$('payment-notice').textContent, CONFIRMING); assert.equal(page.$('payment-notice').getAttribute('role'), 'status');
  assert.equal(page.$('payment-notice').hidden, false); assert.equal(page.$('portal').hidden, false);
  // What a browser test waits on instead of a fixed time: the answers handled, the retry scheduled, the reads in flight.
  assert.deepEqual([page.$('payment-notice').dataset.verify, page.$('payment-notice').dataset.retryIn, page.root.dataset.portalLoading], ['1', '2', '0']);
  const delays = [];
  for (let retry = 0; retry < 4; retry++) {
    const timer = page.state.timers.shift(); delays.push(timer.ms);
    const running = timer.callback();
    assert.equal(page.$('payment-notice').dataset.retryIn, undefined, 'a retry that has started is no longer scheduled');
    await running;
    assert.equal(page.$('payment-notice').textContent, CONFIRMING, `while retry ${retry + 2} is scheduled`);
    assert.deepEqual([page.$('payment-notice').dataset.verify, page.$('payment-notice').dataset.retryIn], [String(retry + 2), String([4, 8, 16, 32][retry])]);
  }
  assert.deepEqual([...delays, ...await page.drain()], [2000, 4000, 8000, 16000, 32000]);
  assert.deepEqual([page.$('payment-notice').dataset.verify, page.$('payment-notice').dataset.retryIn], ['6', undefined], 'no retry is left scheduled');
  assert.deepEqual(page.verifies().map(request => request.body), Array(6).fill({ action: 'verify_payment', session_id: SESSION }), 'one verify on return and five retries, then it stops');
  assert.equal(page.$('payment-notice').textContent, UNCONFIRMED, 'with no retry left the notice no longer promises the payment will appear shortly');
  assert.equal(page.$('payment-notice').getAttribute('role'), 'status');
  assert.deepEqual(page.state.errors, [], 'a failed verification never reaches the error screen');
  assert.deepEqual(page.state.toasts, []);
  assert.equal(page.state.renders.length, 1, 'the portal was rendered once, before verifying');
});

test('retries survive a 502 and a lost connection, and stop on success with the refreshed balance', async () => {
  const page = portal({ search: returned, gets: [{ status: 200, body: VIEW }], posts: [OUTAGE, offline(), { status: 200, body: { ok: true, paid: true, duplicate: false, amountPaid: 450, tipPaid: 25, balance: 450, receiptUrl: 'https://pay.stripe.com/receipts/synthetic' } }] });
  await page.context.load();
  assert.equal(page.$('payment-notice').textContent, CONFIRMING);
  assert.deepEqual(await page.drain(), [2000, 4000]);
  assert.equal(page.verifies().length, 3);
  assert.equal(page.$('payment-notice').textContent, 'Payment verified. Thank you for the $25.00 tip for your crew. $450.00 remaining.');
  assert.deepEqual([page.$('payment-notice').dataset.verify, page.$('payment-notice').dataset.retryIn, page.root.dataset.portalLoading], ['3', undefined, '0']);
  assert.equal(page.state.requests.filter(request => request.method === 'GET').length, 2, 'a verified payment reloads the portal');
  assert.deepEqual(page.state.errors, []);
  assert.equal(page.state.replaced.length, 1, 'the reload after verifying finds no return parameters');
});

// FIX-PORTAL-CRASH second review: the Stripe return notice follows what a later render shows.
const RECEIPT = 'https://pay.stripe.com/receipts/synthetic-rerender';
const UNPAID = { ok: true, payment: { paid: 0, balance: 900, receiptUrl: '' } }, PAID = { ok: true, payment: { paid: 450, balance: 450, receiptUrl: RECEIPT } };

test('a quiet refresh that draws the payment turns "being confirmed" into "Payment verified.", and a failed retry never turns it back', async () => {
  const page = portal({ search: returned, gets: [{ status: 200, body: UNPAID }, { status: 200, body: UNPAID }, { status: 200, body: PAID }], posts: [UNSETTLED, OUTAGE, UNSETTLED] });
  await page.context.load();
  assert.equal(page.$('payment-notice').textContent, CONFIRMING);
  await page.context.load(true);
  assert.equal(page.$('payment-notice').textContent, CONFIRMING, 'nothing new was paid yet');
  await page.context.load(true);
  assert.equal(page.$('payment-notice').textContent, 'Payment verified.'); assert.equal(page.$('payment-notice').getAttribute('role'), 'status');
  // The retries still run (the money path is unchanged), but a 502 or an unsettled answer no longer rewrites the notice.
  assert.deepEqual(await page.drain(), [2000, 4000, 8000, 16000, 32000]);
  assert.equal(page.verifies().length, 6, 'still at most six asks');
  assert.equal(page.$('payment-notice').textContent, 'Payment verified.');
  await page.context.load(true);
  assert.equal(page.$('payment-notice').textContent, 'Payment verified.');
  assert.deepEqual(page.state.errors, []); assert.deepEqual(page.state.toasts, []);
});

test('"could not confirm yet" is replaced once a render shows a receipt that was not there at the return', async () => {
  // The webhook had already counted the charge (paid is unchanged), and its receipt arrives later.
  const counted = { ok: true, payment: { paid: 450, balance: 450, receiptUrl: '' } };
  const page = portal({ search: returned, gets: [{ status: 200, body: counted }, { status: 200, body: counted }, { status: 200, body: { ...counted, payment: { ...counted.payment, receiptUrl: RECEIPT } } }], posts: [UNSETTLED] });
  await page.context.load(); await page.drain();
  assert.equal(page.$('payment-notice').textContent, UNCONFIRMED);
  await page.context.load(true);
  assert.equal(page.$('payment-notice').textContent, UNCONFIRMED, 'the same paid amount and no receipt: still unconfirmed');
  await page.context.load(true);
  assert.equal(page.$('payment-notice').textContent, 'Payment verified.');
  assert.equal(page.verifies().length, 6);
});

test('the return notice stays when nothing new is shown, when the page could not be drawn at the return, and after a final answer', async () => {
  // An earlier receipt (the deposit's) that is still the one shown is not this payment.
  const deposit = { ok: true, payment: { paid: 450, balance: 450, receiptUrl: RECEIPT } };
  const same = portal({ search: returned, gets: [{ status: 200, body: deposit }], posts: [UNSETTLED] });
  await same.context.load(); await same.context.load(true); await same.context.load(true);
  assert.equal(same.$('payment-notice').textContent, CONFIRMING);
  // The first render failed: there is no amount to compare with, so a later render changes nothing.
  const blind = portal({ search: returned, gets: [{ status: 200, body: { ...UNPAID, boom: true } }, { status: 200, body: PAID }], posts: [UNSETTLED] });
  await blind.context.load(); await blind.context.load(true);
  assert.equal(blind.$('payment-notice').textContent, CONFIRMING);
  // A charge held for review keeps the server's final message, whatever a later render shows.
  const held = 'Your card payment is confirmed. Our team will review it before applying it. Please do not pay again.';
  const review = portal({ search: returned, gets: [{ status: 200, body: UNPAID }, { status: 200, body: PAID }], posts: [{ status: 409, body: { ok: false, code: 'payment_tip_refused', reviewRecorded: true, error: held } }] });
  await review.context.load(); await review.context.load(true);
  assert.equal(review.$('payment-notice').textContent, held); assert.equal(review.$('payment-notice').getAttribute('role'), 'alert');
  // A verified payment keeps its own message (with the balance) through later renders.
  const verified = portal({ search: returned, gets: [{ status: 200, body: UNPAID }, { status: 200, body: PAID }], posts: [{ status: 200, body: { ok: true, paid: true, duplicate: false, amountPaid: 450, balance: 450, receiptUrl: RECEIPT } }] });
  await verified.context.load(); await verified.context.load(true);
  assert.equal(verified.$('payment-notice').textContent, 'Payment verified. $450.00 remaining.');
  // Without a Stripe return nothing is shown at all.
  const plain = portal({ gets: [{ status: 200, body: UNPAID }, { status: 200, body: PAID }] });
  await plain.context.load(); await plain.context.load(true);
  assert.equal(plain.$('payment-notice').hidden, true);
});

test('a 4xx other than 409 stops the retries at once and says so in our words', async () => {
  for (const status of [400, 403, 404, 422]) {
    const page = portal({ search: returned, gets: [{ status: 200, body: VIEW }], posts: [{ status, body: { ok: false, error: 'Synthetic refusal' } }] });
    await page.context.load();
    assert.equal(page.verifies().length, 1, `${status}`); assert.deepEqual(page.state.timers, [], `${status} schedules nothing`);
    assert.equal(page.$('payment-notice').textContent, UNCONFIRMED, `${status}`);
    assert.deepEqual(page.state.errors, [], `${status}`); assert.deepEqual(page.state.toasts, [], `${status}`);
  }
  // A 4xx on a later retry (the session was answered 409, then refused) ends the same way.
  const late = portal({ search: returned, gets: [{ status: 200, body: VIEW }], posts: [UNSETTLED, { status: 403, body: { ok: false, error: 'You are not authorized to pay for this job' } }] });
  await late.context.load();
  assert.deepEqual(await late.drain(), [2000]);
  assert.equal(late.verifies().length, 2); assert.equal(late.$('payment-notice').textContent, UNCONFIRMED);
});

test('a confirmed charge waiting on an earlier payment\'s verification shows the server\'s final message and never asks again', async () => {
  // What verify_payment answers for payment_needs_review (functions/api/customer-portal.js forwards its code).
  const waiting = 'Your Stripe payment is confirmed. An earlier recorded payment needs team verification before the balance can be updated. Please do not pay again.';
  const page = portal({ search: returned, gets: [{ status: 200, body: VIEW }], posts: [{ status: 409, body: { ok: false, code: 'payment_needs_review', error: waiting } }] });
  await page.context.load();
  assert.equal(page.$('payment-notice').textContent, waiting); assert.equal(page.$('payment-notice').getAttribute('role'), 'alert');
  assert.deepEqual(page.state.timers, [], 'no retry rewrites the saved confirmation');
  assert.equal(page.verifies().length, 1);
  assert.equal(page.state.requests.filter(request => request.method === 'GET').length, 2, 'the portal refreshes quietly into its awaiting-verification view');
  assert.deepEqual(page.state.errors, []); assert.deepEqual(page.state.toasts, []);
});

test('a charge held for review shows our own final message, refreshes quietly and never asks again', async () => {
  const held = 'Your card payment is confirmed. Our team will review it before applying it. Please do not pay again.';
  const page = portal({ search: returned, gets: [{ status: 200, body: VIEW }], posts: [{ status: 409, body: { ok: false, code: 'payment_tip_refused', reviewRecorded: true, error: held } }] });
  await page.context.load();
  assert.equal(page.$('payment-notice').textContent, held); assert.equal(page.$('payment-notice').getAttribute('role'), 'alert');
  assert.deepEqual(page.state.timers, []);
  assert.equal(page.state.requests.filter(request => request.method === 'GET').length, 2);
  assert.deepEqual(page.state.errors, []);
});

test('a verify answered "sign in again" shows the sign-in screen once and never retries', async () => {
  const page = portal({ search: returned, gets: [{ status: 200, body: VIEW }], posts: [{ status: 401, body: { ok: false, code: 'CUSTOMER_PORTAL_AUTH_REQUIRED', error: 'Open your private project link again.' } }] });
  await page.context.load();
  assert.deepEqual(page.state.errors, ['Open your private project link again.']);
  assert.deepEqual(page.state.timers, []);
  assert.equal(page.context.portalData, null);
  assert.equal(page.$('payment-notice').textContent, 'Verifying your Stripe payment…');
});

test('the Stripe return parameters are dropped in every case and only a paid return is verified', async () => {
  const cases = [
    ['?payment=stripe-cancelled', 'Checkout was closed. Any completed payment will appear after verification; you can safely resume an unfinished checkout.'],
    ['?payment=stripe-success', ''],
    [`?session_id=${SESSION}`, ''],
    ['?payment=anything-else', ''],
  ];
  for (const [search, notice] of cases) {
    const page = portal({ search, gets: [{ status: 200, body: VIEW }], posts: [] });
    await page.context.load();
    assert.deepEqual(page.state.replaced, [[null, '', '/customer-portal']], search);
    assert.equal(page.verifies().length, 0, search);
    assert.equal(page.$('payment-notice').textContent, notice, search);
    await page.context.load(true);
    assert.equal(page.state.replaced.length, 1, `${search}: a later refresh leaves the address alone`);
  }
  const plain = portal({ gets: [{ status: 200, body: VIEW }] });
  await plain.context.load();
  assert.deepEqual(plain.state.replaced, []); assert.equal(plain.$('payment-notice').hidden, true);
});

test('a render error is logged with its code, keeps the last good page and never reaches the error screen', async () => {
  const page = portal({ shown: true, gets: [{ status: 200, body: { ...VIEW, boom: true } }, { status: 200, body: VIEW }] });
  assert.equal(await page.context.load(true), false);
  assert.equal(page.state.logged.length, 1);
  assert.equal(page.state.logged[0][1], 'CUSTOMER_PORTAL_RENDER_FAILED'); assert.ok(page.state.logged[0][2] instanceof Error);
  assert.equal(page.$('render-notice').hidden, false); assert.equal(page.$('portal').hidden, false);
  assert.deepEqual(page.state.errors, []); assert.deepEqual(page.state.toasts, []);
  assert.equal(page.$('reconnect-pill').hidden, true, 'the read itself worked');
  assert.equal(await page.context.load(true), true);
  assert.equal(page.$('render-notice').hidden, true, 'a good render clears the notice');
});

test('a failed render leaves portalData on the answer on screen, so the next good render compares against what the customer saw', async () => {
  const shown = { ...VIEW, estimate: { revision: 1, amount: 900 } }, revised = { ...VIEW, estimate: { revision: 2, amount: 1200 } };
  const page = portal({ gets: [{ status: 200, body: shown }, { status: 200, body: { ...revised, boom: true } }, { status: 200, body: revised }] });
  assert.equal(await page.context.load(), true);
  assert.deepEqual(page.context.portalData, shown);
  assert.equal(await page.context.load(true), false);
  assert.deepEqual(page.context.portalData, shown, 'the revision that failed to render is not what the page compares against');
  assert.equal(await page.context.load(true), true);
  assert.deepEqual(page.context.portalData, revised);
  // With nothing drawn yet, a failed first render leaves no data behind.
  const first = portal({ gets: [{ status: 200, body: { ...VIEW, boom: true } }] });
  assert.equal(await first.context.load(), false);
  assert.equal(first.context.portalData, null);
});

test('a first render that fails shows only the notice, and a Stripe return is still verified', async () => {
  const page = portal({ search: returned, gets: [{ status: 200, body: { ...VIEW, boom: true } }], posts: [UNSETTLED] });
  assert.equal(await page.context.load(), false);
  assert.equal(page.$('render-notice').hidden, false);
  for (const id of ['portal', 'loading', 'error']) assert.equal(page.$(id).hidden, true, id);
  assert.deepEqual(page.state.errors, []);
  assert.equal(page.verifies().length, 1, 'money is verified even when the page could not be drawn');
  assert.deepEqual(page.state.timers.map(timer => timer.ms), [2000]);
});

test('a first render that throws after showing the portal hides it again, so only the notice shows', async () => {
  const page = portal({ search: returned, gets: [{ status: 200, body: { ...VIEW, boom: 'late' } }, { status: 200, body: VIEW }], posts: [UNSETTLED] });
  assert.equal(await page.context.load(), false);
  assert.equal(page.state.renders.length, 1); assert.equal(page.state.logged[0][1], 'CUSTOMER_PORTAL_RENDER_FAILED');
  assert.equal(page.$('render-notice').hidden, false);
  for (const id of ['portal', 'loading', 'error']) assert.equal(page.$(id).hidden, true, `${id}: no half-drawn portal (placeholders, a Pay button) stays on screen`);
  assert.equal(page.context.portalData, null);
  assert.deepEqual(page.state.errors, []); assert.deepEqual(page.state.toasts, []);
  assert.equal(page.verifies().length, 1, 'the Stripe return is still verified');
  // The next good render (the Refresh button reloads the page) shows the portal and clears the notice.
  assert.equal(await page.context.load(), true);
  assert.equal(page.$('portal').hidden, false); assert.equal(page.$('render-notice').hidden, true);
  // A render that throws late after a good one keeps the portal on screen.
  const shown = portal({ shown: true, gets: [{ status: 200, body: { ...VIEW, boom: 'late' } }] });
  assert.equal(await shown.context.load(true), false);
  assert.equal(shown.$('portal').hidden, false); assert.equal(shown.$('render-notice').hidden, false);
});

test('failed quiet refreshes never swap the page; three in a row show Reconnecting, a success clears it', async () => {
  const page = portal({ shown: true, gets: [DOWN, offline(), DOWN, { status: 200, body: VIEW }, DOWN, DOWN, { status: 200, body: VIEW }] });
  for (const pill of [true, true, false]) {
    const reading = page.context.load(true);
    assert.equal(page.root.dataset.portalLoading, '1', 'a read in flight is counted');
    assert.equal(await reading, false);
    assert.equal(page.$('reconnect-pill').hidden, pill);
    assert.equal(page.root.dataset.portalLoading, '0', 'a failed read is finished too');
  }
  assert.equal(await page.context.load(true), true);
  assert.equal(page.$('reconnect-pill').hidden, true);
  for (let failure = 0; failure < 2; failure++) { await page.context.load(true); assert.equal(page.$('reconnect-pill').hidden, true, 'the count starts again after a success'); }
  assert.deepEqual(page.state.errors, []); assert.deepEqual(page.state.toasts, []);
  assert.equal(page.$('portal').hidden, false);
});

test('a refresh after an action keeps a shown portal and says why, in our words', async () => {
  const page = portal({ shown: true, gets: [DOWN, offline()] });
  await page.context.load(); await page.context.load();
  assert.deepEqual(page.state.toasts, [[DOWN.body.error, true], ['Your project could not be refreshed. Check your connection and try again.', true]]);
  assert.deepEqual(page.state.errors, []); assert.equal(page.$('portal').hidden, false);
});

test('only the first load shows the error screen, with our own message and never raw exception text', async () => {
  const lost = portal({ gets: [offline()] });
  assert.equal(await lost.context.load(), false);
  assert.deepEqual(lost.state.errors, ['Your project could not be opened right now. Check your connection and refresh the page.']);
  const down = portal({ gets: [DOWN] });
  await down.context.load();
  assert.deepEqual(down.state.errors, [DOWN.body.error]);
  const quiet = portal({ gets: [offline()] });
  await quiet.context.load(true);
  assert.deepEqual(quiet.state.errors, [], 'a quiet refresh never shows the error screen');
  for (const page of [lost, down, quiet]) for (const message of page.state.errors) assert.doesNotMatch(message, /Failed to fetch|TypeError|Cannot (?:set|read) properties/);
});

test('an answer that is not ours (an HTML error page) is a connection problem; only a 401 or 403 falls back to the private-link message', async () => {
  for (const status of [500, 502, 503, 520, 404, 200]) {
    const first = portal({ gets: [{ status, html: true }] });
    assert.equal(await first.context.load(), false, `${status}`);
    assert.deepEqual(first.state.errors, [CONNECTION], `${status} is never shown as a missing private link`);
    const shown = portal({ shown: true, gets: [{ status, html: true }] });
    await shown.context.load();
    assert.deepEqual(shown.state.toasts, [['Your project could not be refreshed. Check your connection and try again.', true]], `${status}`);
    assert.deepEqual(shown.state.errors, []); assert.equal(shown.$('portal').hidden, false);
  }
  for (const status of [401, 403]) {
    const page = portal({ gets: [{ status, html: true }] });
    await page.context.load();
    assert.deepEqual(page.state.errors, ['Open the private link sent by Easy Garage Cleaning.'], `${status}`);
  }
  // Our own answers keep their message and their sign-out, whatever the status.
  const revoked = portal({ shown: true, gets: [{ status: 403, body: { ok: false, code: 'CUSTOMER_PORTAL_ACCESS_REVOKED', error: 'Your access to this private project has changed.' } }] });
  await revoked.context.load(true);
  assert.deepEqual(revoked.state.errors, ['Your access to this private project has changed.']); assert.equal(revoked.context.portalData, null);
  // A first read that fails keeps the Stripe return, so reloading the page verifies it.
  const returning = portal({ search: returned, gets: [{ status: 502, html: true }] });
  await returning.context.load();
  assert.deepEqual(returning.state.replaced, []); assert.equal(returning.verifies().length, 0);
});

test('showError hides the render notice, so the sign-in screen never carries it', () => {
  const nodes = new Map(), $ = id => nodes.get(id) || nodes.set(id, element(id, id !== 'render-notice' && id !== 'portal')).get(id);
  const context = vm.createContext({ document: { getElementById: $ } });
  vm.runInContext(portalScript(html, ['const $=id=>document.getElementById(id),money=', 'function showError(']), context);
  context.showError('Open the private link from Easy Garage Cleaning');
  assert.equal($('render-notice').hidden, true); assert.equal($('portal').hidden, true); assert.equal($('error').hidden, false);
  assert.equal($('error-message').textContent, 'This browser does not have a valid private project link. Send the form below and the team will reconnect you.');
});

// FIX-PORTAL-CRASH second review: renderSafely puts portalData back after a failed render, so the tip label never reads it.
test('a tip after a render that failed past the tip picker is added to the due the Pay button shows, not the restored answer', () => {
  const nodes = new Map(), node = id => nodes.get(id) || nodes.set(id, { ...element(id, false), dataset: {}, disabled: false, replaceChildren() {} }).get(id);
  let onChange = null, balance = 0;
  const picker = { chosen: 0, value() { return this.chosen; }, update(options) { balance = options.balanceCents; } };
  const context = vm.createContext({
    $: node, setText: (id, value) => { node(id).textContent = value; }, money: value => `$${Number(value).toFixed(2)}`, portalData: null,
    EGCTip: { mount: (host, options) => { onChange = options.onChange; balance = options.balanceCents; return picker; } },
  });
  vm.runInContext(portalScript(html, ['function renderPayment(', 'function renderTip(', 'function applyTip(']), context);
  const view = due => ({ estimate: { status: 'approved' }, appointment: { status: 'completed' }, viewer: { owner: true, permissions: { pay: true } },
    payment: { total: 900, paid: 900 - due, balance: due, dueNow: due, purpose: 'balance', tip: { available: true, maxCents: 50000, presets: [10, 15, 20] } } });
  const draw = data => { context.portalData = data; context.renderPayment(data); context.renderTip(data); };
  const choose = percent => { picker.chosen = Math.round(balance * percent / 100); onChange(picker.chosen); };
  const before = view(450); draw(before);
  assert.equal(node('pay-button').textContent, 'Pay $450.00 remaining balance');
  // The next answer ($400 due) is drawn through the tip picker, then a later section throws: renderSafely restores the $450 answer.
  draw(view(400)); context.portalData = before;
  assert.equal(node('pay-button').textContent, 'Pay $400.00 remaining balance');
  assert.equal(node('pay-button').dataset.dueCents, '40000');
  choose(15);
  assert.equal(node('pay-button').dataset.tipCents, '6000');
  assert.equal(node('pay-button').textContent, 'Pay $460.00 · balance + $60.00 tip', 'the $400 on screen plus the tip, as the server charges it');
  choose(0);
  assert.equal(node('pay-button').textContent, 'Pay $400.00 remaining balance');
});

// The closeout note is one node the render updates in place; #payment-due-now (also a .payment-rule) is never removed.
test('renderExperience keeps one closeout note and never removes the due-now line', () => {
  const make = (tag = 'p') => ({ tag, className: '', textContent: '', children: [], dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, remove() { throw new Error(`${this.id || this.className} was removed`); } });
  const due = { ...make(), id: 'payment-due-now', className: 'payment-rule' }, card = { ...make('section'), children: [due] };
  card.append = node => card.children.push(node);
  card.querySelector = selector => { assert.equal(selector, '.closeout-rule'); return card.children.find(node => node.className.split(' ').includes('closeout-rule')) || null; };
  const pay = { ...make('button'), closest: () => card }, nodes = new Map([['pay-button', pay]]);
  const context = { document: { createElement: make }, $: id => nodes.get(id) || nodes.set(id, { ...make(), closest: () => make() }).get(id), setText() {} };
  for (const name of ['renderDecisions', 'renderMemory', 'renderRules', 'renderRebooking', 'renderWallet', 'renderGuard', 'renderCollaborators']) context[name] = () => {};
  vm.runInNewContext(portalScript(html, ['const make=', 'function renderExperience(']), context);
  const data = payment => ({ experience: {}, payment, viewer: { owner: true, permissions: {} } });
  context.renderExperience(data({ balance: 450 }));
  const [, closeout] = card.children;
  for (const [payment, className, text] of [
    [{ balance: 450 }, 'payment-rule closeout-rule due', 'Payment is required before the crew closes this job.'],
    [{ balance: 450 }, 'payment-rule closeout-rule due', 'Payment is required before the crew closes this job.'],
    [{ balance: 450, needsReview: true }, 'payment-rule closeout-rule due', 'The team must verify the recorded payment before crew closeout.'],
    [{ balance: 0 }, 'payment-rule closeout-rule', 'Paid in full—the crew can complete closeout.'],
  ]) {
    context.renderExperience(data(payment));
    assert.deepEqual(card.children, [due, closeout], 'the same two nodes, in the same order');
    assert.deepEqual([closeout.className, closeout.textContent], [className, text]);
  }
});
