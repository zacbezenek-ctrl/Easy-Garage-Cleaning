import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const script = [...read('copilot.html').matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('Co-Pilot voice input can request the microphone on its own page', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  for (const path of ['/copilot', '/copilot.html', '/employee', '/']) {
    const r = await onRequest({ request: new Request('https://easygaragecleaning.com' + path), next: async () => new Response('page') });
    assert.ok(r.headers.get('Permissions-Policy').includes(path.startsWith('/copilot') ? 'microphone=(self)' : 'microphone=()'));
  }
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ restored = false, firebaseError = '', schedule, sessionResponse } = {}) {
  const nodes = new Map(), events = new Map(), timers = new Map(), requests = [], firebaseEvents = [];
  let timerId = 0, loggedIn = restored;
  function element(id = '') {
    if (id && nodes.has(id)) return nodes.get(id);
    const classes = new Set();
    const node = { value: '', style: {}, textContent: '', innerHTML: '', disabled: false, children: [], listeners: {},
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener: (name, fn) => { node.listeners[name] = fn; },
      appendChild: child => node.children.push(child), setAttribute() {}, remove() {},
    };
    if (id) nodes.set(id, node);
    return node;
  }
  const storage = () => { const values = new Map(); return { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) }; };
  const context = vm.createContext({
    console: { log() {} }, Event, Date, Intl, Error,
    document: { readyState: 'loading', getElementById: id => /^gate/.test(id) || id === 'egc-gate' ? null : element(id), querySelector: () => null, createElement: () => element() },
    location: { pathname: '/copilot' }, sessionStorage: storage(), localStorage: storage(),
    setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id), setTimeout: () => 0,
    addEventListener: (name, fn) => events.set(name, fn), dispatchEvent: event => events.get(event.type)?.(event),
    firebase: { apps: [], initializeApp() { this.apps.push({}); firebaseEvents.push('initialize'); }, auth() {
      assert.equal(this.apps.length, 1, 'Firebase app must exist before authentication');
      return { signInWithCustomToken: async () => { firebaseEvents.push('authenticate'); }, signOut: async () => {} };
    } },
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      if (url === '/api/hub-auth') {
        if (!init.method && sessionResponse) return sessionResponse();
        if (init.method === 'DELETE') { loggedIn = false; return response({ ok: true }); }
        if (init.method === 'POST') loggedIn = true;
        return loggedIn ? response({ ok: true, user: 'SyntheticCrew', displayName: 'Synthetic Crew', role: 'crew' }) : response({ ok: false }, 401);
      }
      if (url === '/api/firebase-session') return firebaseError ? response({ ok: false, error: firebaseError }, 503) : response({ ok: true, token: 'test-token' });
      if (url === '/api/crew-jobs') return schedule ? schedule() : response({ ok: true, jobs: [] });
      if (url === '/api/copilot') return response({ answer: 'Synthetic answer' });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  context.window = context;
  vm.runInContext(read('crew/hub-auth.js'), context);
  vm.runInContext(script + '\n;globalThis.state = () => ({ me, todayJobs, history, sessionVersion });', context);
  element('l-user').value = 'SyntheticCrew'; element('l-pass').value = 'Synthetic password';
  return { context, element, timers, requests, firebaseEvents };
}

test('Co-Pilot cold sign-in initializes Firebase before token exchange and loads permitted schedule', async () => {
  const h = harness(); await flush();
  assert.equal(h.requests.filter(r => r.url === '/api/crew-jobs').length, 0);
  await h.context.doLogin(); await flush();
  assert.deepEqual(h.firebaseEvents, ['initialize', 'authenticate']);
  assert.equal(h.context.state().me, 'SyntheticCrew');
  assert.equal(h.element('l-pass').value, '');
  assert.equal(h.element('copilot-screen').classList.contains('active'), true);
  assert.equal(h.requests.filter(r => r.url === '/api/crew-jobs').length, 1);
  assert.equal(h.timers.size, 2);
});

test('Co-Pilot restored login completes the same Firebase initialization', async () => {
  const h = harness({ restored: true }); await flush();
  assert.deepEqual(h.firebaseEvents, ['initialize', 'authenticate']);
  assert.equal(h.element('copilot-screen').classList.contains('active'), true);
});

test('Co-Pilot displays configuration failure accurately on sign-in and restored session', async () => {
  for (const restored of [false, true]) {
    const h = harness({ restored, firebaseError: 'Firebase connection needs setup' }); await flush();
    if (!restored) await h.context.doLogin();
    assert.equal(h.element('login-error').textContent, 'Firebase connection needs setup');
    assert.equal(h.element('copilot-screen').classList.contains('active'), false);
    assert.equal(h.element('login-button').disabled, false);
    assert.equal(h.timers.size, 0);
  }
});

test('Co-Pilot maps actual Hub job fields and excludes other dates and availability', async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
  const h = harness({ restored: true, schedule: () => response({ ok: true, jobs: [
    { id: 'job', customer: 'Sample Client', time: '14:00', endTime: '16:00', total: 450, date: today, type: 'job' },
    { id: 'old', date: '2000-01-01', type: 'job' },
    { id: 'away', date: today, type: 'availability' },
  ] }) }); await flush();
  assert.equal(h.context.state().todayJobs.length, 1);
  const job = h.context.state().todayJobs[0];
  assert.equal(job.customerName, 'Sample Client'); assert.equal(job.timeWindow, '14:00–16:00'); assert.equal(job.quoteAmount, 450);
  assert.match(h.element('jobs-strip').innerHTML, /Sample Client/);
  assert.doesNotMatch(h.element('jobs-strip').innerHTML, /Unknown/);
});

test('Co-Pilot logout cancels refreshes and ignores a previous account schedule response', async () => {
  const pending = deferred();
  const h = harness({ restored: true, schedule: () => pending.promise }); await flush();
  assert.equal(h.timers.size, 2);
  await h.context.doLogout();
  pending.resolve(response({ ok: true, jobs: [{ id: 'private', customer: 'Old client', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' }) }] }));
  await flush();
  assert.equal(h.timers.size, 0); assert.equal(h.context.state().todayJobs.length, 0);
  assert.equal(h.element('jobs-strip').innerHTML, '');
  await h.context.doLogin(); await flush();
  assert.equal(h.timers.size, 2, 'relogin must not accumulate timers');
});

test('Co-Pilot failed or expired schedule clears stale data and shows the login gate', async () => {
  let status = 200;
  const h = harness({ restored: true, schedule: () => response(status === 200 ? { ok: true, jobs: [] } : { ok: false, error: 'Sign in required' }, status) });
  await flush(); status = 401;
  await h.context.loadSchedule();
  assert.equal(h.context.state().me, null); assert.equal(h.timers.size, 0);
  assert.equal(h.element('login-screen').style.display, '');
  assert.match(h.element('login-error').textContent, /session expired/i);
});

test('Co-Pilot ignores a chat response that arrives after logout', async () => {
  const h = harness({ restored: true }); await flush();
  const pending = deferred(), original = h.context.fetch;
  h.context.fetch = (url, init) => url === '/api/copilot' ? pending.promise : original(url, init);
  h.element('query-input').value = 'Synthetic query';
  const sending = h.context.sendQuery(); await flush();
  await h.context.doLogout();
  const count = h.element('chat-area').children.length;
  pending.resolve(response({ answer: 'Previous account answer' })); await sending;
  assert.equal(h.element('chat-area').children.length, count);
  assert.equal(h.context.state().history.length, 0);
});

test('a slow signed-out restore cannot clear a newer successful crew login', async () => {
  const pending = deferred();
  const h = harness({ sessionResponse: () => pending.promise }); await flush();
  await h.context.doLogin(); await flush();
  pending.resolve(response({ ok: false }, 401)); await flush();
  assert.equal(h.context.EGCHubAuth.profile().user, 'SyntheticCrew');
  assert.equal(h.context.state().me, 'SyntheticCrew');
  assert.equal(h.element('copilot-screen').classList.contains('active'), true);
});

test('a stale API unauthorized response cannot sign out a newer crew session', async () => {
  const h = harness({ restored: true }); await flush();
  const pending = deferred(), original = h.context.fetch;
  h.context.fetch = (url, init) => url === '/api/old-request' ? pending.promise : original(url, init);
  const oldRequest = h.context.EGCHubAuth.fetch('/api/old-request').catch(error => error.code);
  await h.context.doLogout(); await h.context.doLogin();
  pending.resolve(response({ ok: false }, 401));
  assert.equal(await oldRequest, 'HUB_AUTH_INTERRUPTED');
  assert.equal(h.context.EGCHubAuth.profile().user, 'SyntheticCrew');
});

test('sign-out waits for an in-flight Firebase sign-in before clearing it', async () => {
  const h = harness(); await flush();
  const tokenExchange = deferred(), actions = [];
  h.context.firebase.auth = () => ({
    signInWithCustomToken: async () => { actions.push('signing-in'); await tokenExchange.promise; actions.push('signed-in'); },
    signOut: async () => { actions.push('signed-out'); },
  });
  const login = h.context.doLogin(); await flush();
  const logout = h.context.doLogout(); await flush();
  assert.deepEqual(actions, ['signing-in']);
  tokenExchange.resolve(); await login; await logout;
  assert.deepEqual(actions, ['signing-in', 'signed-in', 'signed-out']);
  assert.equal(h.context.EGCHubAuth.profile().user, '');
  assert.equal(h.context.state().me, null);
});

test('crew session restoration waits for pending cookie deletion', async () => {
  const h = harness({ restored: true }); await flush();
  const pending = deferred(), original = h.context.fetch;
  h.context.fetch = async (url, init = {}) => {
    if (url === '/api/hub-auth' && init.method === 'DELETE') await pending.promise;
    return original(url, init);
  };
  const logout = h.context.doLogout(); await flush();
  const before = h.requests.filter(r => r.url === '/api/hub-auth' && !r.init.method).length;
  const restored = h.context.EGCHubAuth.session(); await flush();
  assert.equal(h.requests.filter(r => r.url === '/api/hub-auth' && !r.init.method).length, before);
  pending.resolve(); await logout;
  assert.equal(await restored, null);
  assert.equal(h.context.EGCHubAuth.profile().user, '');
});
