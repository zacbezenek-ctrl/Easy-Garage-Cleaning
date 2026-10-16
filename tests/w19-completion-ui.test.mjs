import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument } from './helpers/hub-dom.mjs';

const source = readFileSync(new URL('../crew/job-completion-handoff.js', import.meta.url), 'utf8');
const READY = {
  ok: true, jobId: 'job-a', viewer: 'Crew.Lead', expectedRevision: 'revision-a', eligible: true,
  status: 'ready', completedAt: '2026-10-16T00:10:00.000Z', completedDate: '2026-10-15', missing: [], message: '', canLaunch: true,
};
const FORM = 'https://api.leadconnectorhq.com/widget/form/7HCRlKJs4VZx4KwNmDa6?synthetic-reference=opaque-test-capability';
const CUSTOM_FORM = 'https://links.easygaragecleaning.com/widget/form/7HCRlKJs4VZx4KwNmDa6?notrack=true';
const dto = changes => ({ ...READY, ...changes });
const answer = (body = READY, status = 200) => ({ status, body });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function page(t, { gets = [answer()], posts = [], online = true, search = '?jobId=job-a' } = {}) {
  const document = createDocument(), events = new Map(), calls = [], observers = [], timers = new Map(), storageCalls = [], opened = [];
  const proto = document.Element.prototype;
  Object.defineProperty(proto, 'disabled', { get() { return this.hasAttribute('disabled'); }, set(value) { this.toggleAttribute('disabled', value); } });
  const host = document.createElement('main'); host.id = 'field-main'; host.append(document.createElement('p')); document.body.append(host);
  let timerId = 0;
  const context = {
    document, URL, URLSearchParams, AbortController, crypto, navigator: { onLine: online }, location: { search },
    console: { log() { assert.fail('completion handoff must not log'); }, error() { assert.fail('completion handoff must not log'); } },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener); },
    removeEventListener(name, listener) { events.get(name)?.delete(listener); },
    open(...args) { opened.push(args); },
    localStorage: { setItem: (...args) => storageCalls.push(args), getItem: () => null, removeItem: (...args) => storageCalls.push(args) },
    sessionStorage: { setItem: (...args) => storageCalls.push(args), getItem: () => null, removeItem: (...args) => storageCalls.push(args) },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; this.connected = true; }
      disconnect() { this.connected = false; }
    },
    async fetch(url, options = {}) {
      const method = options.method || 'GET', request = { url, method, options, body: options.body ? JSON.parse(options.body) : null };
      calls.push(request);
      const queue = method === 'POST' ? posts : gets;
      assert.ok(queue.length, `unexpected ${method} request`);
      let next = queue.shift();
      if (typeof next === 'function') next = await next(request);
      if (next instanceof Error) throw next;
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => structuredClone(next.body) };
    },
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'crew/job-completion-handoff.js' });
  t.after(() => context.EGCJobCompletionHandoff.unmount());
  const card = () => host.querySelector('#completion-handoff-card');
  const buttons = () => card()?.querySelectorAll('button') || [];
  const click = label => { const button = buttons().find(item => item.textContent === label); assert.ok(button, `missing button ${label}`); host.dispatchEvent({ type: 'click', target: button }); return button; };
  const fire = (name, more = {}) => { for (const listener of [...events.get(name) || []]) listener({ type: name, ...more }); };
  const mutate = records => { const observer = observers.find(item => item.connected); assert.ok(observer); observer.callback(records); };
  const runRefresh = async () => { for (const [id, timer] of [...timers]) if (timer.delay === 200) { timers.delete(id); timer.callback(); } await flush(); };
  return { context, document, host, card, buttons, click, fire, calls, observers, mutate, runRefresh, gets, posts, timers, storageCalls, opened };
}

test('only a server-verified completed lead sees the card and its actual Denver completion date', async t => {
  const p = page(t, { gets: [answer(dto({ message: '<img src=x> Verified completion', balanceDue: 750, depositPaid: 250 }))] });
  await flush();
  assert.ok(p.card());
  assert.match(p.card().textContent, /Actual completion date: 2026-10-15 · Mountain Time/);
  assert.equal(p.card().querySelector('time').getAttribute('datetime'), READY.completedAt);
  assert.match(p.card().textContent, /<img src=x> Verified completion/);
  assert.equal(p.card().querySelector('img'), null);
  assert.doesNotMatch(p.card().textContent, /750|250|paid|collected|commission|task created/i);
  assert.deepEqual(p.calls.map(call => [call.method, call.url]), [['GET', '/api/field-completion-handoff?jobId=job-a']]);
  assert.equal(p.calls[0].options.credentials, 'same-origin'); assert.equal(p.calls[0].options.cache, 'no-store');
  assert.equal(p.card().querySelector('a'), null);
  assert.equal(p.buttons()[0].textContent, 'Open completion confirmation');
});

test('ineligible jobs and disabled, signed-out or forbidden reads expose no card or launch link', async t => {
  for (const next of [answer(dto({ eligible: false, status: 'not_completed', canLaunch: false, completedAt: null, completedDate: null })), ...[401, 403, 404].map(status => answer({ ok: false }, status))]) {
    const p = page(t, { gets: [next] }); await flush(); assert.equal(p.card(), null); assert.equal(p.calls.length, 1); p.context.EGCJobCompletionHandoff.unmount();
  }
});

test('a later read that no longer verifies completion clears the previously eligible card and link', async t => {
  const p = page(t, { gets: [answer(), answer(dto({ eligible: false, status: 'not_completed', canLaunch: false, completedAt: null, completedDate: null }))], posts: [answer(dto({ status: 'prepared', launchUrl: FORM }))] }); await flush();
  p.click('Open completion confirmation'); await flush(); assert.ok(p.card().querySelector('a'));
  p.click('Check confirmation status'); await flush(); assert.equal(p.card(), null);
  assert.deepEqual(p.calls.map(call => call.method), ['GET', 'POST', 'GET']);
});

test('unavailable setup and a received completion show server guidance without any prepare action', async t => {
  for (const data of [dto({ status: 'setup_required', canLaunch: false, missing: ['EGC_W19_FORM_QUERY_KEYS must include verified mapping keys.', 'Verified native field mapping is unavailable.'] }), dto({ status: 'released_unconfirmed', canLaunch: false, message: 'HighLevel completion received; Cesar task confirmation still needs review' })]) {
    const p = page(t, { gets: [answer(data)] }); await flush();
    assert.deepEqual(p.buttons().map(button => button.textContent), ['Check confirmation status']);
    assert.match(p.card().textContent, data.status === 'setup_required' ? /Operations needs to finish the form connection before it can open/ : /Cesar task confirmation still needs review/);
    assert.doesNotMatch(p.card().textContent, /EGC_W19_FORM_QUERY_KEYS|mapping keys|native field mapping/);
    assert.equal(p.card().querySelector('ul'), null);
    assert.equal(p.calls.filter(call => call.method === 'POST').length, 0); p.context.EGCJobCompletionHandoff.unmount();
  }
});

test('prepare binds the current actor and revision; a deliberate click-through opens no popup automatically', async t => {
  const pending = deferred(), p = page(t, { posts: [() => pending.promise] }); await flush();
  const button = p.click('Open completion confirmation'); p.host.dispatchEvent({ type: 'click', target: button });
  assert.equal(p.calls.filter(call => call.method === 'POST').length, 1);
  const request = p.calls.at(-1).body;
  assert.equal(request.action, 'prepare'); assert.equal(request.jobId, 'job-a'); assert.equal(request.expectedRevision, READY.expectedRevision); assert.equal(request.expectedUser, READY.viewer);
  assert.match(request.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(request).sort(), ['action', 'expectedRevision', 'expectedUser', 'jobId', 'requestId']);
  assert.equal(p.context.EGCJobCompletionHandoff.canLeave(), false);
  pending.resolve(answer(dto({ status: 'prepared', launchUrl: FORM }))); await flush();
  const link = p.card().querySelector('a'); assert.ok(link); assert.equal(link.href, FORM);
  assert.equal(link.getAttribute('target'), '_blank'); assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(link.textContent, 'Continue to completion form'); assert.match(p.card().textContent, /Opening the form does not confirm submission/);
  assert.deepEqual(p.opened, []); assert.deepEqual(p.storageCalls, []); assert.equal(p.context.EGCJobCompletionHandoff.canLeave(), true);
  assert.equal(p.calls.length, 2);
});

test('an uncertain prepare performs only a read; a later explicit retry reuses the same intent', async t => {
  const p = page(t, { gets: [answer(), answer(dto({ status: 'prepared', expectedRevision: 'revision-after-prepare' }))], posts: [new TypeError('Synthetic lost response'), answer(dto({ status: 'prepared', launchUrl: FORM }))] }); await flush();
  p.click('Open completion confirmation'); await flush();
  assert.deepEqual(p.calls.map(call => call.method), ['GET', 'POST', 'GET']);
  assert.equal(p.card().querySelector('a'), null); assert.match(p.card().textContent, /Review the current status/);
  p.click('Open completion confirmation'); await flush();
  assert.deepEqual(p.calls.filter(call => call.method === 'POST').map(call => call.body), [p.calls[1].body, p.calls[1].body]);
  assert.equal(p.card().querySelector('a').href, FORM);
});

test('the verified custom form origin and its notrack query remain an explicit click-through', async t => {
  const p = page(t, { posts: [answer(dto({ status: 'prepared', launchUrl: CUSTOM_FORM }))] }); await flush();
  p.click('Open completion confirmation'); await flush();
  const link = p.card().querySelector('a'); assert.ok(link); assert.equal(link.href, CUSTOM_FORM);
  assert.equal(new URL(link.href).searchParams.get('notrack'), 'true');
  assert.equal(link.getAttribute('target'), '_blank'); assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.getAttribute('referrerpolicy'), 'no-referrer');
  assert.deepEqual(p.calls.map(call => call.method), ['GET', 'POST']); assert.deepEqual(p.opened, []); assert.deepEqual(p.storageCalls, []);
});

test('a stale prepare loads the current revision and needs a new explicit intent', async t => {
  const p = page(t, { gets: [answer(), answer(dto({ expectedRevision: 'revision-b' }))], posts: [answer({ ok: false, error: 'This job changed.' }, 409), answer(dto({ expectedRevision: 'revision-b', status: 'prepared', launchUrl: FORM }))] }); await flush();
  p.click('Open completion confirmation'); await flush(); assert.equal(p.calls.length, 3);
  p.click('Open completion confirmation'); await flush();
  const [first, second] = p.calls.filter(call => call.method === 'POST').map(call => call.body);
  assert.equal(second.expectedRevision, 'revision-b'); assert.notEqual(first.requestId, second.requestId);
});

test('links outside the exact native form, credentials, fragments and unsafe URLs are rejected without a prepare retry', async t => {
  for (const launchUrl of ['javascript:alert(1)', FORM.replace('https:', 'http:'), FORM.replace('https://', 'https://user:secret@'), `${FORM}\n`, `${FORM}\u200b`, 'https://forms.example.test/completion', FORM.replace('7HCRlKJs4VZx4KwNmDa6', 'different-form'), FORM.replace('api.leadconnectorhq.com', 'api.leadconnectorhq.com.attacker.test'), `${FORM}#unverified`, FORM.replace('api.leadconnectorhq.com', 'api.leadconnectorhq.com:8443'), CUSTOM_FORM.replace('links.easygaragecleaning.com', 'links.easygaragecleaning.com.attacker.test'), CUSTOM_FORM.replace('links.easygaragecleaning.com', 'links.easygaragecleaning.com:8443'), CUSTOM_FORM.replace('https://', 'https://user:secret@'), `${CUSTOM_FORM}#unverified`]) {
    const p = page(t, { gets: [answer(), answer(dto({ status: 'prepared' }))], posts: [answer(dto({ status: 'prepared', launchUrl }))] }); await flush();
    p.click('Open completion confirmation'); await flush();
    assert.equal(p.card().querySelector('a'), null, launchUrl); assert.deepEqual(p.calls.map(call => call.method), ['GET', 'POST', 'GET']); assert.deepEqual(p.opened, []);
    p.context.EGCJobCompletionHandoff.unmount();
  }
});

test('manual status checks are reads, remove the old link immediately and never claim a Cesar task', async t => {
  const checking = deferred(), p = page(t, { gets: [answer(), () => checking.promise], posts: [answer(dto({ status: 'prepared', launchUrl: FORM }))] }); await flush();
  p.click('Open completion confirmation'); await flush(); assert.ok(p.card().querySelector('a'));
  p.click('Check confirmation status'); assert.equal(p.card().querySelector('a'), null);
  checking.resolve(answer(dto({ status: 'released_unconfirmed', canLaunch: false, message: 'HighLevel completion received; Cesar task confirmation still needs review' }))); await flush();
  assert.deepEqual(p.calls.map(call => call.method), ['GET', 'POST', 'GET']);
  assert.match(p.card().textContent, /Cesar task confirmation still needs review/);
  assert.doesNotMatch(p.card().textContent, /task created|invoice paid|payment collected|commission earned/i);
  assert.deepEqual(p.buttons().map(button => button.textContent), ['Check confirmation status']);
});

test('sign-out removes links and invalidates a late prepare response', async t => {
  const pending = deferred(), p = page(t, { posts: [() => pending.promise] }); await flush(); p.click('Open completion confirmation');
  p.fire('egc:signout'); assert.equal(p.card(), null); assert.equal(p.calls.at(-1).options.signal.aborted, true);
  pending.resolve(answer(dto({ status: 'prepared', launchUrl: FORM }))); await flush();
  assert.equal(p.card(), null); assert.equal(p.host.querySelector('a'), null); assert.deepEqual(p.storageCalls, []);
  assert.equal(p.observers.at(-1).connected, false);
});

test('offline removes links and ignores a late response; reconnect verifies the account before intent reuse', async t => {
  const pending = deferred(), p = page(t, { gets: [answer(), answer(dto({ status: 'prepared' }))], posts: [() => pending.promise, answer(dto({ status: 'prepared', launchUrl: FORM }))] }); await flush(); p.click('Open completion confirmation');
  const intent = p.calls.at(-1).body; p.context.navigator.onLine = false; p.fire('offline'); assert.equal(p.card(), null);
  pending.resolve(answer(dto({ status: 'prepared', launchUrl: FORM }))); await flush(); assert.equal(p.card(), null);
  p.context.navigator.onLine = true; p.fire('online'); await flush(); assert.equal(p.card().querySelector('a'), null);
  p.click('Open completion confirmation'); await flush(); assert.deepEqual(p.calls.at(-1).body, intent);
});

test('host replacement clears launch state and verifies the new account; own card mutations do not fetch', async t => {
  const p = page(t, { gets: [answer(), answer(dto({ viewer: 'Other.Lead', expectedRevision: 'other-revision' }))], posts: [answer(dto({ status: 'prepared', launchUrl: FORM })), answer(dto({ viewer: 'Other.Lead', expectedRevision: 'other-revision', status: 'prepared', launchUrl: FORM }))] }); await flush();
  assert.deepEqual({ ...p.observers[0].options }, { childList: true });
  p.mutate([{ addedNodes: [p.card()], removedNodes: [] }]); await flush(); assert.equal(p.calls.length, 1);
  p.click('Open completion confirmation'); await flush(); const first = p.calls.at(-1).body, old = p.card();
  const replacement = p.document.createElement('h1'); replacement.textContent = 'Current job'; p.host.replaceChildren(replacement);
  p.mutate([{ addedNodes: [replacement], removedNodes: [old] }]); assert.equal(p.card(), null);
  await p.runRefresh(); assert.ok(p.card()); assert.equal(p.card().querySelector('a'), null);
  p.click('Open completion confirmation'); await flush();
  const second = p.calls.at(-1).body; assert.equal(second.expectedUser, 'Other.Lead'); assert.equal(second.expectedRevision, 'other-revision'); assert.notEqual(second.requestId, first.requestId);
  const current = p.card(); p.mutate([{ addedNodes: [current], removedNodes: [] }]); await flush(); assert.equal(p.calls.length, 4);
});

test('an unexpected actor in a prepare response and an authorization loss clear all private state', async t => {
  for (const post of [answer(dto({ viewer: 'Other.Lead', status: 'prepared', launchUrl: FORM })), ...[401, 403, 404].map(status => answer({ ok: false }, status))]) {
    const p = page(t, { posts: [post] }); await flush(); p.click('Open completion confirmation'); await flush();
    assert.equal(p.card(), null); assert.equal(p.host.querySelector('a'), null); assert.equal(p.calls.length, 2); p.context.EGCJobCompletionHandoff.unmount();
  }
});

test('a mismatched job or unverified completion DTO fails closed', async t => {
  for (const data of [dto({ jobId: 'other-job' }), dto({ completedAt: '', completedDate: '' }), dto({ eligible: false, canLaunch: true }), dto({ status: 'released_unconfirmed', canLaunch: true })]) {
    const p = page(t, { gets: [answer(data)] }); await flush(); assert.equal(p.card(), null); p.context.EGCJobCompletionHandoff.unmount();
  }
});
