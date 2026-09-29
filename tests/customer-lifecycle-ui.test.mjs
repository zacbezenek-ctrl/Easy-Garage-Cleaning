import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../employee-customer-lifecycle.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');
const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');

// A Storage-like object over `data`: Object.keys lists the stored keys, as in a browser.
const storage = data => new Proxy(data, { get: (target, key) => ({ getItem: name => Object.hasOwn(target, name) ? target[name] : null, setItem: (name, value) => { target[name] = String(value); }, removeItem: name => { delete target[name]; } })[key] });

// One page load with the suite's three legacy tools installed first; `data` is the tab's sessionStorage.
function harness(status, data = {}) {
  const calls = [], legacy = [], listeners = {}, requests = [], toasts = [];
  const window = {
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); }, removeEventListener() {}, dispatchEvent: event => { for (const fn of listeners[event.type] || []) fn(event); },
    opsIssueCustomerCredit: async id => { legacy.push([id, 'credit']); }, opsSendCustomerDecision: async id => { legacy.push([id, 'decision']); }, opsReviewRebooking: async id => { legacy.push([id, 'rebook']); },
    showToast: message => { toasts.push(message); },
  };
  const fetch = async (url, init) => { requests.push(String(url)); calls.push(init); return status(); };
  const context = vm.createContext({ window, fetch, sessionStorage: storage(data), localStorage: storage({}), document: {}, crypto: globalThis.crypto, Intl, URLSearchParams, AbortController, setTimeout, clearTimeout, console, Event: class { constructor(type) { this.type = type; } } });
  vm.runInContext(source, context);
  return { window, legacy, requests, calls, toasts };
}
const reply = (body, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ACTIONS = [['opsIssueCustomerCredit', 'credit'], ['opsSendCustomerDecision', 'decision'], ['opsReviewRebooking', 'rebook']];

test('with the server flag off every customer button keeps today\'s browser tools', async () => {
  const h = harness(reply({ ok: true, status: {}, flags: { moneyApi: true, lifecycleApi: false } }));
  for (const [name] of ACTIONS) await h.window[name]('job-1');
  assert.deepEqual(h.legacy, [['job-1', 'credit'], ['job-1', 'decision'], ['job-1', 'rebook']]);
  assert.deepEqual(h.requests, ['/api/integration-status'], 'the flag is read once and cached');
  assert.equal(h.calls[0].credentials, 'same-origin'); assert.equal(h.calls[0].cache, 'no-store');
  assert.equal(h.window.EGC_FLAGS.lifecycleApi, false); assert.equal(h.window.EGC_FLAGS.moneyApi, undefined, 'the money flag is left to its own module');
  assert.equal(h.window.EGCCustomerLifecycle.legacy('credit') !== null, true);
});

test('an unreadable flag keeps today\'s tools and is checked again; a signed-out viewer gets neither path', async () => {
  let fail = true;
  const h = harness(() => fail ? new Response('{}', { status: 503 }) : reply({ ok: true, status: {}, flags: { lifecycleApi: false } })());
  await h.window.opsIssueCustomerCredit('job-1');
  assert.deepEqual(h.legacy, [['job-1', 'credit']]); assert.equal(h.window.EGC_FLAGS, undefined);
  fail = false; await h.window.opsIssueCustomerCredit('job-1');
  assert.equal(h.requests.length, 2); assert.equal(h.window.EGC_FLAGS.lifecycleApi, false);
  const out = harness(reply({ ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in' }, 401));
  for (const [name] of ACTIONS) await out.window[name]('job-1');
  assert.deepEqual(out.legacy, []);
  h.window.dispatchEvent({ type: 'egc:signout' });
  assert.equal(h.window.EGC_FLAGS.lifecycleApi, undefined, 'sign-out forgets the flag so the next viewer re-checks it');
});

test('once the server path was on for this viewer, an unreadable setting runs neither path until it can be checked', async () => {
  const tab = { egc_u: 'zacb' }, failing = () => new Response('{}', { status: 503 });
  const first = harness(reply({ ok: true, status: {}, flags: { lifecycleApi: true } }), tab);
  assert.equal(await first.window.EGCCustomerLifecycle.enabled(), true);
  assert.equal(tab['egc.lifecycle.flag.v1.zacb'], 'true', 'the last value read is kept per viewer for this tab');
  const second = harness(failing, tab);
  for (const [name] of ACTIONS) await second.window[name]('job-1');
  assert.deepEqual(second.legacy, [], 'the browser writers never run in place of the server path');
  assert.equal(second.toasts.length, 3); assert.match(second.toasts[0], /could not be checked/);
  assert.equal(second.requests.length, 3, 'every click checks again');
  tab.egc_u = 'tylerg'; await second.window.opsReviewRebooking('job-1');
  assert.deepEqual(second.legacy, [['job-1', 'rebook']], 'another viewer in this tab never inherits it');
  tab.egc_u = 'zacb'; tab['egc.lifecycle.pending.v1.zacb:job-1:credit'] = '{}';
  second.window.dispatchEvent({ type: 'egc:signout' });
  assert.deepEqual(Object.keys(tab), ['egc_u'], 'sign-out forgets every remembered value and pending request');
});

test('the module wraps the suite\'s buttons after it loads, never injects HTML, never writes Firestore and never sends by itself', () => {
  const at = name => html.indexOf(name);
  assert.ok(at('<script src="employee-suite.js?v=') > 0 && at('<script src="employee-customer-lifecycle.js?v=') > at('<script src="employee-suite.js?v='), 'it must load after employee-suite.js to wrap its buttons');
  assert.match(html, /<link rel="stylesheet" href="employee-customer-lifecycle\.css\?v=\d{8}fun36">/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(source, /\/api\/(highlevel|messages|customer-payments|money)|syncCustomerCommunication|patchJob|firebase|firestore/i);
  // The only customer notification path is the suite's own confirmed trigger, offered after a decision is saved
  // and keyed by that decision (FUN-36 review: every decision used to share the 'manual' idempotency key).
  assert.match(source, /window\.opsTriggerCommunication\(id,'decision-needed',marker\)/);
  assert.match(suite, /window\.opsTriggerCommunication=async\(id,event,marker='manual'\)=>\{[^\n]*askAction\([^\n]*if\(!approval\)return;const sent=await syncCustomerCommunication\(job,event,key\)/, 'the suite trigger asks the manager to confirm before anything is sent');
  // The buttons this module takes over still exist in the suite with the same names.
  for (const name of ['opsIssueCustomerCredit', 'opsSendCustomerDecision', 'opsReviewRebooking']) assert.match(suite, new RegExp(`window\\.${name}=async id=>`));
});

// The suite's own trigger, run from its source line: it keys the HighLevel note and log entry by the marker it is given.
function suiteTrigger(approve = true) {
  const line = suite.split('\n').find(text => text.startsWith('window.opsTriggerCommunication='));
  const calls = [], asked = [], job = { id: 'job-1', customer: 'Synthetic Customer' };
  const context = vm.createContext({ window: {}, jobs: () => [job], customerCommunicationTypes: { 'decision-needed': { label: 'Decision needed', description: 'Synthetic.' } },
    askAction: async options => { asked.push(options); return approve ? {} : null; }, syncCustomerCommunication: async (row, event, marker) => { calls.push([row.id, event, marker]); return true; }, render() {}, showToast() {} });
  vm.runInContext(line, context);
  return { trigger: context.window.opsTriggerCommunication, calls, asked };
}

test('the suite trigger forwards a decision marker as the idempotency key, keeps manual for its own buttons and asks first', async () => {
  const s = suiteTrigger();
  await s.trigger('job-1', 'decision-needed', 'decision-0f8fad5b-d9cb-469f-a165-70867728950e');
  await s.trigger('job-1', 'decision-needed');
  for (const bad of ['../x', '', 'a'.repeat(161), 42, { toString: () => 'decision-x' }]) await s.trigger('job-1', 'decision-needed', bad);
  assert.deepEqual(s.calls, [['job-1', 'decision-needed', 'decision-0f8fad5b-d9cb-469f-a165-70867728950e'], ['job-1', 'decision-needed', 'manual'], ...Array(5).fill(['job-1', 'decision-needed', 'manual'])]);
  assert.equal(s.asked.length, 7, 'every trigger is confirmed by the manager');
  const declined = suiteTrigger(false);
  await declined.trigger('job-1', 'decision-needed', 'decision-a');
  assert.deepEqual(declined.calls, [], 'nothing is sent when the manager declines');
});
