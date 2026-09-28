import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Today's work keeps the last confirmed job and shift in the tab's session so
// an offline reload can show them. Signing out (Employee Hub or crew pages)
// must remove those copies and record the sign-out time for other tabs.
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-22T15:00:00.000Z');
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
function webStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
const crewCopies = () => ({
  'egc-field:viewer': JSON.stringify({ user: 'Crew.One', savedAt: NOW - 60000 }),
  'egc-field:Crew.One:job-a:snapshot': JSON.stringify({ job: { id: 'job-a', customer: 'Synthetic Customer', address: '1 Synthetic Way', phone: '9705550100' } }),
  'egc-field:Crew.One:job-b:snapshot': JSON.stringify({ job: { id: 'job-b' } }),
  'egc-field:Crew.One:shift-snapshot': JSON.stringify({ entry: null }),
  'egc-field:Crew.One:job-a:note': 'Synthetic unsent note draft',
  'egc-dispatch-recovery:unrelated': 'kept',
});
function assertRetired(session, local) {
  assert.deepEqual([...session.values.keys()].sort(), ['egc-dispatch-recovery:unrelated', 'egc-field:Crew.One:job-a:note'], 'the viewer and every job or shift copy are removed; drafts keyed to their author stay');
  assert.equal(local.getItem('egc-field:signed-out-at'), String(NOW), 'other tabs learn when the sign-out happened');
}

test('signing out of the Employee Hub retires Today’s work offline copies on this device', async () => {
  const session = webStorage(crewCopies()), local = webStorage(), calls = [], events = [];
  const context = {
    console, URLSearchParams, Date: FixedDate, Intl, Promise, Set, Map, Error, Event, sessionStorage: session, localStorage: local, navigator: {},
    location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener() {}, dispatchEvent: event => events.push(event.type),
    fetch: async (url, init = {}) => { calls.push([url, init.method || 'GET']); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    firebase: { auth: () => ({ signOut: async () => {} }) },
    _dataGeneration: 0, _dataUnsubscribers: [], _listenersStarted: false, _leadsTimer: null, jobsCache: [], custsCache: [], leadsCache: [], blockedDays: new Set(), blockedSlots: new Set(),
    document: { body: { classList: { remove() {} } }, getElementById: () => ({ style: {}, classList: { remove() {} }, value: '' }), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  context.window = context;
  const page = read('employee.html');
  assert.ok(page.indexOf('// Business access comes from the signed server profile') >= 0 && page.indexOf('async function sendBookingConfirmation') > 0, 'the Hub auth script markers exist');
  vm.runInNewContext(page.slice(page.indexOf('// Business access comes from the signed server profile'), page.indexOf('async function sendBookingConfirmation')) + '\nglobalThis.logout=doLogout;', context);
  await context.logout();
  assertRetired(session, local);
  assert.deepEqual(events, ['egc:signout']);
  assert.deepEqual(calls, [['/api/hub-auth', 'DELETE']]);
});

test('signing out from a crew page retires the same copies before the session is closed', async () => {
  const session = webStorage(crewCopies()), local = webStorage(), calls = [];
  const context = {
    console, Date: FixedDate, Promise, Error, Set, Map, sessionStorage: session, localStorage: local,
    fetch: async (url, init = {}) => { calls.push([url, init.method || 'GET', session.values.has('egc-field:viewer')]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, addEventListener() {} },
    addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(read('crew/hub-auth.js'), context);
  await context.EGCHubAuth.signOut();
  assertRetired(session, local);
  assert.deepEqual(calls, [['/api/hub-auth', 'DELETE', false]]);
});

test('sign-out keeps working when the browser refuses storage', async () => {
  const refusing = { get length() { throw new Error('SecurityError'); }, key() { throw new Error('SecurityError'); }, getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
  const calls = [];
  const context = { console, Date: FixedDate, Promise, Error, Set, Map, sessionStorage: refusing, localStorage: refusing, fetch: async (url, init = {}) => { calls.push([url, init.method]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }, document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, addEventListener() {} }, addEventListener() {} };
  context.window = context;
  vm.runInNewContext(read('crew/hub-auth.js'), context);
  await context.EGCHubAuth.signOut();
  assert.deepEqual(calls, [['/api/hub-auth', 'DELETE']], 'the server session is still closed');
});
