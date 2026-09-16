import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const collectionNames = ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'];
const collections = () => Object.fromEntries(collectionNames.map(name => [name, []]));
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

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
    if (url.includes('employee-accounts')) return env.accountResponse || response({ ok: true, accounts: [] });
    if (init.method === 'POST') return response({ ok: true, record: JSON.parse(init.body).data });
    if (env.pending) return env.pending;
    return response({ ok: true, collections: collections(), accounts: [] });
  };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,refreshPeople,startPeopleListeners,peopleSet,accountApprovalBoard}});})();');
  vm.runInNewContext(source, context);
  env.api = context.ui;
  env.reads = () => calls.filter(call => call.url.split('?')[0] === '/api/employee-hub' && call.method === 'GET').length;
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

test('owner refresh reuses the account list from the hub instead of reading it twice', async () => {
  const env = suite();
  await env.api.startPeopleListeners();
  await env.advance(60000);
  assert.ok(env.reads() > 0);
  assert.equal(env.calls.filter(call => call.url.includes('employee-accounts')).length, 0);
  assert.ok(env.calls.some(call => call.url === '/api/employee-hub?include=accounts'));
  assert.equal(env.api.S.accountState.loaded, true);
  assert.equal(env.api.S.accountState.error, '');
});

test('an older hub response falls back to one account lookup and preserves both results', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: { ...collections(), profiles: [{ username: 'SyntheticCrew' }] } });
  env.accountResponse = response({ ok: true, accounts: [{ username: 'SyntheticCrew', displayName: 'Synthetic crew', status: 'pending' }] });
  assert.equal(await env.api.refreshPeople(), true);
  assert.equal(env.reads(), 1);
  assert.equal(env.calls.filter(call => call.url === '/api/employee-accounts').length, 1);
  assert.equal(env.api.S.people.profiles[0].username, 'SyntheticCrew');
  assert.equal(env.api.S.people.accounts[0].status, 'pending');
  assert.equal(env.api.S.accountState.loaded, true);
  assert.equal(env.api.S.accountState.loading, false);
  assert.equal(env.api.S.accountState.error, '');
  assert.match(env.api.accountApprovalBoard(), /1 waiting for you/);
});

test('a malformed combined account list blocks stale approvals while employee data stays usable', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: collections(), accounts: [{ username: 'SyntheticCrew', displayName: 'Synthetic crew', status: 'pending' }] });
  await env.api.refreshPeople();
  assert.match(env.api.accountApprovalBoard(), /1 waiting for you/);
  env.pending = response({ ok: true, collections: { ...collections(), profiles: [{ username: 'UpdatedCrew' }] }, accounts: null });
  assert.equal(await env.api.refreshPeople(), true);
  assert.equal(env.api.S.peopleState.loaded, true);
  assert.equal(env.api.S.peopleState.error, '');
  assert.equal(env.api.S.people.profiles[0].username, 'UpdatedCrew');
  assert.equal(env.api.S.accountState.loading, false);
  assert.match(env.api.S.accountState.error, /incomplete/);
  assert.match(env.api.accountApprovalBoard(), /Account requests unavailable/);
  assert.doesNotMatch(env.api.accountApprovalBoard(), /No accounts waiting|Synthetic crew|>Approve</);
  assert.equal(env.calls.filter(call => call.url === '/api/employee-accounts').length, 0, 'an invalid supplied list must not be treated as an older server response');
  const count = env.calls.length;
  await env.context.opsReviewEmployeeAccount('SyntheticCrew', 'approved');
  assert.equal(env.calls.length, count, 'an unverified account list must not authorize an approval write');

  env.pending = response({ ok: true, collections: collections(), accounts: [] });
  await env.api.refreshPeople();
  assert.equal(env.api.S.accountState.error, '');
  assert.match(env.api.accountApprovalBoard(), /No accounts waiting/);
});

test('a failed legacy account fallback does not claim that the approval queue is empty', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: collections() });
  env.accountResponse = response({ ok: false, error: 'Account storage unavailable' }, 503);
  assert.equal(await env.api.refreshPeople(), true);
  assert.equal(env.api.S.peopleState.loaded, true);
  assert.equal(env.api.S.peopleState.error, '');
  assert.equal(env.api.S.accountState.loaded, false);
  assert.equal(env.api.S.accountState.loading, false);
  assert.equal(env.api.S.accountState.error, 'Account storage unavailable');
  assert.match(env.api.accountApprovalBoard(), /Account requests unavailable/);
  assert.doesNotMatch(env.api.accountApprovalBoard(), /No accounts waiting|>Approve</);
});

test('a failed combined request invalidates account approvals and clears both loading states', async () => {
  const env = suite();
  await env.api.refreshPeople();
  env.pending = response({ ok: false, error: 'Employee storage unavailable' }, 503);
  assert.equal(await env.api.refreshPeople(), false);
  assert.equal(env.api.S.peopleState.error, 'Employee storage unavailable');
  assert.equal(env.api.S.accountState.error, 'Employee storage unavailable');
  assert.equal(env.api.S.peopleState.loading, false);
  assert.equal(env.api.S.accountState.loading, false);
  assert.equal(env.api.S.peopleRequest, null);
  assert.match(env.api.accountApprovalBoard(), /Account requests unavailable/);
});

test('logout during a legacy account fallback discards both delayed account and employee data', async () => {
  const env = suite();
  env.pending = response({ ok: true, collections: { ...collections(), profiles: [{ username: 'PreviousPerson' }] } });
  let resolve;
  env.accountResponse = new Promise(done => { resolve = done; });
  const pending = env.api.refreshPeople();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(env.calls.filter(call => call.url === '/api/employee-accounts').length, 1);
  assert.equal(env.api.S.accountState.loading, true);
  env.events['egc:signout']();
  resolve(response({ ok: true, accounts: [{ username: 'PreviousPerson', status: 'pending' }] }));
  assert.equal(await pending, false);
  assert.equal(env.api.S.people.accounts.length, 0);
  assert.equal(env.api.S.people.profiles.length, 0);
  assert.equal(env.api.S.accountState.loaded, false);
  assert.equal(env.api.S.accountState.loading, false);
  assert.equal(env.api.S.accountState.error, '');
  assert.equal(env.api.S.peopleState.loaded, false);
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
  resolve(response({ ok: true, collections: { ...collections(), profiles: [{ username: 'PreviousPerson' }] }, accounts: [{ username: 'PreviousPerson', status: 'pending' }] }));
  await Promise.all([first, next, visible]);
  assert.equal(env.timers.size, 0);
  assert.equal(env.api.S.peopleState.loaded, false);
  assert.equal(env.api.S.people.profiles.length, 0);
  assert.equal(env.api.S.people.accounts.length, 0);
  assert.equal(env.api.S.accountState.loaded, false);
  assert.equal(env.api.S.accountState.loading, false);
  await env.documentEvents.visibilitychange();
  await env.advance(60000);
  assert.equal(env.reads(), initial + 1, 'logout must stop visibility-triggered reads too');
});
