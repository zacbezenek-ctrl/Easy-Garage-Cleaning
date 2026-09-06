import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const storage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
};
const element = () => ({
  value: '', textContent: '', innerHTML: '', disabled: false, style: {}, listeners: {}, attrs: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener(name, handler) { this.listeners[name] = handler; },
  setAttribute(name, value) { this.attrs[name] = value; },
  focus() { this.focused = true; }, scrollIntoView() {}, remove() {},
});

function browser() {
  const events = {}, elements = new Map();
  const context = {
    console, URLSearchParams, Date, Intl, Promise, Set, Map, Error, Event,
    sessionStorage: storage(), localStorage: storage(), navigator: {},
    location: { pathname: '/employee', search: '' },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener: (name, callback) => { events[name] = callback; },
    dispatchEvent: event => events[event.type]?.(event),
    document: {
      readyState: 'loading', activeElement: null,
      body: element(),
      addEventListener() {}, querySelectorAll: () => [],
      getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelector(selector) { return selector === '#login-screen .btn-main' ? this.getElementById('login-button') : null; },
    },
  };
  context.window = context;
  return { context, events, elements, node: id => context.document.getElementById(id) };
}

const collectionNames = ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'];
const collections = () => Object.fromEntries(collectionNames.map(name => [name, []]));

function suite(fetcher) {
  const env = browser();
  env.context.sessionStorage = storage({ egc_u: 'ZacB', egc_business_access: 'true', egc_role: 'owner' });
  env.context.me = 'ZacB';
  env.context.jobsCache = [];
  env.context.hubFetch = fetcher;
  let source = read('employee-suite.js');
  source = source.replace(/\}\)\(\);\s*$/, "Object.assign(globalThis,{ui:{S,refreshPeople,refreshAccountApplications,accountApprovalBoard,employeeUnavailable,loadIntegrations,updateQuickClock,render}});})();");
  vm.runInNewContext(source, env.context);
  return { ...env, api: env.context.ui };
}

test('a failed approval lookup is unavailable, never a verified zero or a stale approval list', async () => {
  let failed = false;
  const env = suite(async () => failed
    ? response({ ok: false, error: 'Restore the existing employee data key.' }, 503)
    : response({ ok: true, accounts: [{ username: 'SyntheticCrew', displayName: 'Synthetic crew', status: 'pending' }] }));
  assert.doesNotMatch(env.api.accountApprovalBoard(), /No accounts waiting|All caught up/);
  await env.api.refreshAccountApplications();
  assert.match(env.api.accountApprovalBoard(), /1 waiting for you/);
  failed = true;
  await env.api.refreshAccountApplications();
  const html = env.api.accountApprovalBoard();
  assert.match(html, /Account requests unavailable/);
  assert.match(html, /Restore the existing employee data key/);
  assert.doesNotMatch(html, /All caught up|No accounts waiting|Synthetic crew|>Approve</);
});

test('only a successful, complete account response can show no accounts waiting', async () => {
  let result = response({ ok: true });
  const env = suite(async () => result);
  await env.api.refreshAccountApplications();
  assert.match(env.api.accountApprovalBoard(), /Account requests unavailable/);
  result = response({ ok: true, accounts: [] });
  await env.api.refreshAccountApplications();
  assert.match(env.api.accountApprovalBoard(), /No accounts waiting/);
});

test('employee data failures disable clock and recover on retry without substituting zero pay', async () => {
  let failed = true;
  const env = suite(async url => url.includes('employee-accounts')
    ? response({ ok: true, accounts: [] })
    : failed ? response({ ok: false, error: 'Employee storage unavailable' }, 503)
      : response({ ok: true, collections: collections() }));
  const clock = element();
  const main = element();
  env.context.document.querySelector = selector => selector === '#ops-quick-clock' ? clock : selector === '#ops-main' ? main : null;
  await env.api.refreshPeople();
  assert.equal(clock.disabled, true);
  assert.match(main.innerHTML, /Employee records unavailable/);
  assert.doesNotMatch(main.innerHTML, /\$0\.00|No earnings recorded/);
  failed = false;
  await env.api.refreshPeople();
  assert.equal(env.api.S.peopleState.loaded, true);
  assert.equal(env.api.S.peopleState.error, '');
  assert.equal(clock.disabled, false);
});

test('malformed employee collections are not accepted as an empty workforce', async () => {
  const env = suite(async url => response(url.includes('employee-accounts') ? { ok: true, accounts: [] } : { ok: true, collections: {} }));
  await env.api.refreshPeople();
  assert.equal(env.api.S.peopleState.loaded, false);
  assert.match(env.api.S.peopleState.error, /incomplete/);
});

test('refresh leaves an employee onboarding draft and an unsent chat draft in place', async () => {
  const env = suite(async url => response(url.includes('employee-accounts') ? { ok: true, accounts: [] } : { ok: true, collections: collections() }));
  const main = element();
  main.innerHTML = 'unsaved draft';
  env.context.document.querySelector = selector => selector === '#ops-main' ? main : null;
  for (const form of ['.ops-onboarding', '.ops-chat-compose', '.ops-customer-thread form']) {
    env.context.document.activeElement = { closest: selector => selector.includes(form) ? {} : null };
    await env.api.refreshPeople();
    assert.equal(main.innerHTML, 'unsaved draft', form);
  }
});

test('a public Firebase library does not overwrite server configuration readiness', async () => {
  const env = suite(async () => response({ ok: true, status: { firebase: false, employeeAccounts: false } }));
  env.context.firebase = {};
  await env.api.loadIntegrations();
  assert.equal(env.api.S.integrations.firebase, false);
  assert.equal(env.api.S.integrations.employeeAccounts, false);
});

test('logout discards pending employee responses instead of repopulating another login', async () => {
  let resolveEmployee;
  const env = suite(async url => url.includes('employee-accounts') ? response({ ok: true, accounts: [] }) : new Promise(resolve => { resolveEmployee = resolve; }));
  const request = env.api.refreshPeople();
  env.events['egc:signout']();
  resolveEmployee(response({ ok: true, collections: { ...collections(), profiles: [{ username: 'PreviousPerson' }] } }));
  await request;
  assert.equal(env.api.S.people.profiles.length, 0);
  assert.equal(env.api.S.peopleState.loaded, false);
});

function employeeAuth(fetcher) {
  const env = browser();
  Object.assign(env.context, {
    fetch: fetcher, firebase: { auth: () => ({ signInWithCustomToken: async () => {}, signOut: async () => {} }) },
    showModeSelect() { env.context.entered = true; }, bootDashboard() { env.context.entered = true; },
    _dataGeneration: 0, _dataUnsubscribers: [], _listenersStarted: false, _leadsTimer: null,
    jobsCache: [], custsCache: [], leadsCache: [], blockedDays: new Set(), blockedSlots: new Set(),
  });
  const page = read('employee.html');
  const source = page.slice(page.indexOf("const ADMINS ="), page.indexOf('async function sendBookingConfirmation'));
  vm.runInNewContext(source + '\nglobalThis.ui={doLogin,doLogout,enterEmployeeApp,getUser:()=>me};', env.context);
  return { ...env, api: env.context.ui };
}

test('accepted credentials with missing Firebase setup do not enter or retain a privileged profile', async () => {
  const env = employeeAuth(async url => url.includes('firebase-session')
    ? response({ ok: false, code: 'FIREBASE_NOT_CONFIGURED', error: 'Secure data setup is incomplete' }, 503)
    : response({ ok: true, user: 'ZacB', displayName: 'Zac', businessAccess: true, role: 'owner' }));
  env.node('l-user').value = 'ZacB';env.node('l-pass').value = 'SyntheticPassword1';
  await env.api.doLogin();
  assert.equal(env.api.getUser(), null);
  assert.equal(env.context.sessionStorage.getItem('egc_business_access'), null);
  assert.equal(env.context.entered, undefined);
  assert.match(env.node('login-error').textContent, /setup is incomplete/);
  assert.equal(env.node('login-button').disabled, false);
});

test('a successful login clears its password and logout clears both old profile stores', async () => {
  const env = employeeAuth(async url => response(url.includes('firebase-session') ? { ok: true, token: 'synthetic-token' } : { ok: true, user: 'ZacB', displayName: 'Zac', businessAccess: true, role: 'owner' }));
  env.node('l-user').value = 'ZacB';env.node('l-pass').value = 'SyntheticPassword1';
  await env.api.doLogin();
  assert.equal(env.api.getUser(), 'ZacB');
  assert.equal(env.context.entered, true);
  assert.equal(env.node('l-pass').value, '');
  env.context.localStorage.setItem('egc_business_access', 'true');
  env.context.localStorage.setItem('egc_u', 'PriorOwner');
  await env.api.doLogout();
  assert.equal(env.context.localStorage.getItem('egc_business_access'), null);
  assert.equal(env.context.sessionStorage.getItem('egc_u'), null);
});

test('crew session restore surfaces secure-data failure instead of silently showing a fresh login', async () => {
  const env = browser();
  env.context.firebase = { auth: () => ({ signInWithCustomToken: async () => {} }) };
  env.context.fetch = async url => url.includes('firebase-session')
    ? response({ ok: false, code: 'FIREBASE_NOT_CONFIGURED', error: 'Firebase setup is incomplete' }, 503)
    : response({ ok: true, user: 'ZacB', displayName: 'Zac', businessAccess: true });
  vm.runInNewContext(read('crew/hub-auth.js'), env.context);
  assert.equal(await env.context.EGCHubAuth.session(), null);
  assert.match(env.node('gate-err').textContent, /Firebase setup is incomplete/);
  assert.equal(env.context.localStorage.getItem('egc_business_access'), null);
});

function signup(fetcher) {
  const env = browser();
  const values = { username: 'SyntheticCrew', firstName: 'Synthetic', lastName: 'Crew', email: 'synthetic@example.invalid', phone: '9705550100', password: 'SyntheticPassword1', confirmPassword: 'SyntheticPassword1', acknowledged: 'on' };
  // FormData is iterable; no live browser submission or external request is made.
  env.context.FormData = class { [Symbol.iterator]() { return Object.entries(values)[Symbol.iterator](); } };
  env.context.fetch = fetcher;
  const form = env.node('signup-form');form.reset = () => { env.reset = true; };
  const script = [...read('employee-signup.html').matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInNewContext(script, env.context);
  return { ...env, submit: () => form.listeners.submit({ preventDefault() {}, currentTarget: form }), values };
}

test('signup configuration failures preserve the form and do not display a sent request', async () => {
  const env = signup(async () => response({ ok: false, error: 'Employee account signup is not configured' }, 503));
  await env.submit();
  assert.equal(env.reset, undefined);
  assert.notEqual(env.node('form-panel').style.display, 'none');
  assert.match(env.node('message').textContent, /not configured/);
  assert.equal(env.node('submit-button').disabled, false);
});

test('signup lost responses explain uncertainty without asserting the request failed', async () => {
  const env = signup(async () => { throw new Error('Network disconnected'); });
  await env.submit();
  assert.match(env.node('message').textContent, /could not confirm/);
  assert.equal(env.reset, undefined);
});
