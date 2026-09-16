import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const collectionNames = ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'];
const collections = () => Object.fromEntries(collectionNames.map(name => [name, []]));
const response = body => ({ ok: true, status: 200, json: async () => body });

function suite() {
  let now = 1700000000000, nextTimer = 0;
  const timers = new Map(), events = {}, documentEvents = {}, calls = [];
  const values = new Map([['egc_u', 'ZacB'], ['egc_business_access', 'true'], ['egc_role', 'owner']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const context = {
    console, URLSearchParams, Intl, Promise, Set, Map, Error,
    Date: class extends Date { static now() { return now; } },
    sessionStorage: storage, localStorage: storage, navigator: {}, me: 'ZacB', jobsCache: [],
    location: { pathname: '/employee', search: '' },
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, at: now + delay }); return id; },
    clearInterval(id) { timers.delete(id); }, setTimeout: () => 1, clearTimeout() {},
    addEventListener(name, callback) { events[name] = callback; },
    document: {
      readyState: 'loading', hidden: false, activeElement: null,
      addEventListener(name, callback) { documentEvents[name] = callback; },
      querySelector: () => null, querySelectorAll: () => [],
    },
  };
  const env = { context, timers, events, documentEvents, calls, pending: null };
  context.hubFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('employee-accounts')) return response({ ok: true, accounts: [] });
    if (init.method === 'POST') return response({ ok: true, record: JSON.parse(init.body).data });
    if (env.pending) return env.pending;
    return response({ ok: true, collections: collections() });
  };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,refreshPeople,startPeopleListeners,peopleSet}});})();');
  vm.runInNewContext(source, context);
  env.api = context.ui;
  env.reads = () => calls.filter(call => call.url === '/api/employee-hub' && call.method === 'GET').length;
  env.advance = async milliseconds => {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.values()].filter(timer => timer.at <= target).sort((left, right) => left.at - right.at)[0];
      if (!next) break;
      now = next.at;
      next.at += next.delay;
      await next.callback();
    }
    now = target;
  };
  env.elapse = milliseconds => { now += milliseconds; };
  return env;
}

test('employee polling pauses hidden tabs, refreshes on return, and uses a minute outside chat', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  await env.advance(45000);
  assert.equal(env.reads(), initial);
  await env.advance(15000);
  assert.equal(env.reads(), initial + 1);

  env.context.document.hidden = true;
  await env.documentEvents.visibilitychange();
  await env.advance(5 * 60000);
  assert.equal(env.reads(), initial + 1, 'a background tab must not reread employee records');
  env.context.document.hidden = false;
  await env.documentEvents.visibilitychange();
  assert.equal(env.reads(), initial + 2, 'returning to the tab refreshes immediately');
  await env.advance(45000);
  assert.equal(env.reads(), initial + 2);
  await env.advance(15000);
  assert.equal(env.reads(), initial + 3);
});

test('active crew chat keeps 15-second updates and leaving chat restores minute polling', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  env.api.S.active = 'crew_chat';
  await env.advance(15000);
  assert.equal(env.reads(), initial + 1);
  await env.advance(15000);
  assert.equal(env.reads(), initial + 2);
  env.api.S.active = 'my_day';
  await env.advance(45000);
  assert.equal(env.reads(), initial + 2);
  await env.advance(15000);
  assert.equal(env.reads(), initial + 3);
});

test('manual and post-write employee refreshes run immediately between automatic polls', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  await env.api.refreshPeople();
  assert.equal(env.reads(), initial + 1);
  await env.api.peopleSet('profiles', 'zacb', { username: 'ZacB' });
  assert.equal(env.reads(), initial + 2);
  await env.advance(45000);
  assert.equal(env.reads(), initial + 2);
});

test('polling and visibility changes share one request and logout discards its response', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  const initial = env.reads();
  let resolve;
  env.pending = new Promise(done => { resolve = done; });
  const timer = [...env.timers.values()][0];
  env.elapse(60000);
  const first = timer.callback();
  env.elapse(60000);
  const next = timer.callback();
  const visible = env.documentEvents.visibilitychange();
  assert.equal(env.reads(), initial + 1, 'there must be only one in-flight collection read');

  env.events['egc:signout']();
  resolve(response({ ok: true, collections: { ...collections(), profiles: [{ username: 'PreviousPerson' }] } }));
  await Promise.all([first, next, visible]);
  assert.equal(env.timers.size, 0);
  assert.equal(env.api.S.peopleState.loaded, false);
  assert.equal(env.api.S.people.profiles.length, 0);
  await env.documentEvents.visibilitychange();
  await env.advance(60000);
  assert.equal(env.reads(), initial + 1, 'logout must stop visibility-triggered reads too');
});
