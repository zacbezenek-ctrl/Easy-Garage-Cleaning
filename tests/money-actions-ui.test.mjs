import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../employee-money-actions.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');

// A Storage-like object over `data`: Object.keys lists the stored keys, as in a browser.
const storage = data => new Proxy(data, { get: (target, key) => ({ getItem: name => Object.hasOwn(target, name) ? target[name] : null, setItem: (name, value) => { target[name] = String(value); }, removeItem: name => { delete target[name]; } })[key] });

// One page load: `data` is the tab's sessionStorage, shared across loads.
function harness(status, data = {}) {
  const calls = [], legacy = [], listeners = {}, requests = [], toasts = [];
  const window = {
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); }, removeEventListener() {}, dispatchEvent: event => { for (const fn of listeners[event.type] || []) fn(event); },
    opsFinanceAction: async (id, action) => { legacy.push([id, action]); }, showToast: message => { toasts.push(message); },
  };
  const fetch = async (url, init) => { requests.push(String(url)); calls.push(init); return status(); };
  const context = vm.createContext({ window, fetch, sessionStorage: storage(data), document: {}, crypto: globalThis.crypto, Intl, URLSearchParams, AbortController, setTimeout, clearTimeout, console, Event: class { constructor(type) { this.type = type; } } });
  vm.runInContext(source, context);
  return { window, legacy, requests, calls, toasts };
}
const reply = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('with the server flag off every finance button keeps today\'s browser tools', async () => {
  const h = harness(reply({ ok: true, status: {}, flags: { moneyApi: false } }));
  for (const action of ['estimate', 'accept', 'deposit', 'payment', 'invoice', 'cost']) await h.window.opsFinanceAction('job-1', action);
  assert.deepEqual(h.legacy.map(([, action]) => action), ['estimate', 'accept', 'deposit', 'payment', 'invoice', 'cost']);
  assert.deepEqual(h.requests, ['/api/integration-status'], 'the flag is read once and cached');
  assert.equal(h.calls[0].credentials, 'same-origin'); assert.equal(h.calls[0].cache, 'no-store');
  assert.equal(h.window.EGC_FLAGS.moneyApi, false);
});

test('an unreadable flag keeps today\'s tools and is checked again; a signed-out viewer gets neither path', async () => {
  let fail = true;
  const h = harness(() => fail ? new Response('{}', { status: 503 }) : reply({ ok: true, status: {}, flags: { moneyApi: false } })());
  await h.window.opsFinanceAction('job-1', 'payment');
  assert.deepEqual(h.legacy, [['job-1', 'payment']]); assert.equal(h.window.EGC_FLAGS, undefined);
  fail = false; await h.window.opsFinanceAction('job-1', 'payment');
  assert.equal(h.requests.length, 2); assert.equal(h.window.EGC_FLAGS.moneyApi, false);
  const out = harness(reply({ ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in' }, 401));
  await out.window.opsFinanceAction('job-1', 'estimate');
  assert.deepEqual(out.legacy, []);
  h.window.dispatchEvent({ type: 'egc:signout' });
  assert.equal(h.window.EGC_FLAGS.moneyApi, undefined, 'sign-out forgets the flag so the next viewer re-checks it');
});

test('once server money actions were on for this viewer, an unreadable setting runs neither path until it can be checked', async () => {
  const tab = { egc_u: 'zacb' }, failing = () => new Response('{}', { status: 503 });
  const first = harness(reply({ ok: true, status: {}, flags: { moneyApi: true } }), tab);
  assert.equal(await first.window.EGCMoneyActions.enabled(), true);
  assert.equal(tab['egc.money.flag.v1.zacb'], 'true', 'the last value read is kept per viewer for this tab');
  // The next page load in the same tab cannot read the setting.
  const second = harness(failing, tab);
  await second.window.opsFinanceAction('job-1', 'payment'); await second.window.opsFinanceAction('job-1', 'invoice');
  assert.deepEqual(second.legacy, [], 'the browser finance tools never run in place of the server path');
  assert.deepEqual(second.toasts, ['Finance settings could not be checked. Retry.', 'Finance settings could not be checked. Retry.']);
  assert.equal(second.requests.length, 2, 'every click checks again'); assert.equal(second.window.EGC_FLAGS, undefined);
  await second.window.opsFinanceAction('job-1', 'cost'); assert.deepEqual(second.legacy, [['job-1', 'cost']], 'actions the server path does not handle are unaffected');
  // Another viewer signing in to this tab never inherits it.
  tab.egc_u = 'tylerg'; await second.window.opsFinanceAction('job-1', 'payment');
  assert.deepEqual(second.legacy.at(-1), ['job-1', 'payment']);
  // After a rollback was read (off), a failed check keeps today's tools.
  tab.egc_u = 'zacb';
  const rolledBack = harness(reply({ ok: true, status: {}, flags: { moneyApi: false } }), tab);
  assert.equal(await rolledBack.window.EGCMoneyActions.enabled(), false); assert.equal(tab['egc.money.flag.v1.zacb'], 'false');
  const third = harness(failing, tab);
  await third.window.opsFinanceAction('job-1', 'estimate'); assert.deepEqual(third.legacy, [['job-1', 'estimate']]); assert.deepEqual(third.toasts, []);
  // Sign-out forgets every remembered value.
  tab['egc.money.flag.v1.zacb'] = 'true'; tab['egc.money.pending.v1.zacb:job-1'] = '{}';
  third.window.dispatchEvent({ type: 'egc:signout' });
  assert.deepEqual(Object.keys(tab), ['egc_u']);
});

// MONEY-GHL-PARITY: a confirmed save now starts the standard finance save's HighLevel lifecycle trigger, but only
// through the suite's own helper (window.EGCCustomerCommunication); the module itself still sends nothing.
test('the money module is wired after the suite, never injects HTML and never sends to customers itself', () => {
  const suite = html.indexOf('<script src="employee-suite.js?v='), module = html.indexOf('<script src="employee-money-actions.js?v=');
  assert.ok(suite > 0 && module > suite, 'employee-money-actions.js must load after employee-suite.js to wrap opsFinanceAction');
  assert.match(html, /<link rel="stylesheet" href="employee-money-actions\.css\?v=\d{8}money">/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(source, /\/api\/(highlevel|messages|customer-payments)|syncCustomerCommunication|firebase|firestore|db\.collection/i);
  assert.deepEqual([...new Set(source.match(/window\.EGCCustomerCommunication/g))], ['window.EGCCustomerCommunication'], 'the only customer-communication path is the suite helper');
});
