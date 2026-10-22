// Browser alerts on My day must never break the time clock. Chrome for Android throws a TypeError from
// `new Notification(...)` (it only shows alerts through a service worker registration), and the alert calls used
// to run inside refreshPeople's try block, so every refresh after "Enable browser alerts" failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

const collectionNames = ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'];
const response = body => ({ ok: true, status: 200, json: async () => body });

function suite({ registration = null, alerts = 'on', desktop = false, hubApp = false } = {}) {
  const values = new Map([['egc_u', 'Crew.One'], ['egc_role', 'crew']]);
  if (alerts) values.set('egc_browser_alerts', alerts);
  const storage = { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const constructed = [];
  class AndroidNotification {
    static permission = 'granted';
    static async requestPermission() { return 'granted'; }
    constructor(title) { constructed.push(title); if (desktop) return; throw new TypeError("Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead."); }
  }
  const env = { values, constructed, registration, toasts: [], collections: Object.fromEntries(collectionNames.map(name => [name, []])) };
  const context = {
    console, URLSearchParams, Intl, Promise, Set, Map, Error, TypeError,
    sessionStorage: storage, localStorage: storage, me: 'Crew.One', jobsCache: [],
    navigator: { serviceWorker: { getRegistration: async () => env.registration } },
    Notification: AndroidNotification,
    location: { pathname: '/employee', search: '' },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener() {},
    document: { readyState: 'loading', hidden: false, activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  };
  context.hubFetch = async url => {
    if (url.includes('employee-accounts')) return response({ ok: true, accounts: [] });
    return response({ ok: true, collections: env.collections, accounts: [] });
  };
  context.showToast = text => env.toasts.push(text);
  // HUB_OFFLINE_ENABLED, as employee-offline-queue.js reports it once /api/hub-offline answers.
  if (hubApp) context.EGCHubOffline = { state: () => ({ enabled: true, known: true }) };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,refreshPeople,myDayBoard}});})();');
  vm.runInNewContext(source, context);
  env.context = context;
  env.api = context.ui;
  // The alert step runs after the refresh resolves; let its promise chain finish.
  env.settle = async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); };
  env.seen = key => JSON.parse(values.get(key) || '[]');
  return env;
}

const announcement = id => ({ id, title: `Update ${id}`, body: 'Synthetic team update', status: 'active', readBy: [] });
const chat = id => ({ id, sender: 'Crew.Two', senderName: 'Crew Two', body: 'Synthetic chat line', createdAt: `2026-01-0${id.slice(-1)}T10:00:00.000Z`, status: 'active' });

test('a Notification constructor that throws (Chrome for Android) no longer breaks the refresh', async () => {
  const env = suite();
  env.collections.announcements = [announcement('a1')];
  env.collections.teamMessages = [chat('m1')];
  assert.equal(await env.api.refreshPeople(), true, 'the refresh still succeeds');
  await env.settle();
  assert.equal(env.api.S.peopleState.error, '', 'no "Employee records unavailable" error is shown');
  assert.equal(env.api.S.peopleState.loaded, true);
  assert.deepEqual(env.constructed.sort(), ['New crew-chat message', 'Update a1'], 'without a worker the constructor was tried and its throw was swallowed');
});

test('the seen lists are saved even when there is no service worker to show alerts', async () => {
  const env = suite({ registration: null });
  env.collections.announcements = [announcement('a1'), announcement('a2')];
  env.collections.teamMessages = [chat('m1')];
  await env.api.refreshPeople();
  await env.settle();
  assert.deepEqual(env.seen('egc_seen_announcements'), ['a1', 'a2']);
  assert.deepEqual(env.seen('egc_seen_chat_messages'), ['m1']);
});

test('alerts go through the service worker registration once per new row, and not again on the next refresh', async () => {
  const shown = [];
  const env = suite({ registration: { showNotification: async (title, options) => { shown.push({ title, tag: options.tag }); } } });
  env.collections.announcements = [announcement('a1')];
  env.collections.teamMessages = [chat('m1')];
  await env.api.refreshPeople();
  await env.settle();
  assert.deepEqual(shown.map(row => row.tag).sort(), ['a1', 'm1']);
  assert.deepEqual(env.constructed, [], 'with a registration, new Notification(...) is never called');
  shown.length = 0;
  await env.api.refreshPeople();
  await env.settle();
  assert.deepEqual(shown, [], 'rows already alerted are not shown twice');
});

test('a registration whose showNotification rejects does not break the refresh', async () => {
  const env = suite({ registration: { showNotification: async () => { throw new TypeError('No active service worker'); } } });
  env.collections.announcements = [announcement('a1')];
  assert.equal(await env.api.refreshPeople(), true);
  await env.settle();
  assert.equal(env.api.S.peopleState.error, '');
  assert.deepEqual(env.seen('egc_seen_announcements'), ['a1']);
});

test('Turn off browser alerts stops alerts and shows the enable button again', async () => {
  const shown = [];
  const env = suite({ registration: { showNotification: async (title, options) => { shown.push(options.tag); } } });
  await env.api.refreshPeople();
  assert.match(env.api.myDayBoard(), /opsDisableAlerts\(\)/, 'My day offers a way to turn alerts off');
  env.context.opsDisableAlerts();
  assert.equal(env.values.get('egc_browser_alerts'), 'off');
  assert.match(env.api.myDayBoard(), /opsEnableAlerts\(\)/);
  env.collections.announcements = [announcement('a9')];
  await env.api.refreshPeople();
  await env.settle();
  assert.deepEqual(shown, [], 'nothing is shown once alerts are off');
});

const unavailable = /Alerts aren\u2019t available in this browser\./, install = /Install the Hub app to get them on this phone\./;

test('a refusing worker falls back to the constructor; where both fail, My day says alerts are unavailable and still offers Turn off', async () => {
  const env = suite({ registration: { showNotification: async () => { throw new TypeError('No active service worker'); } } });
  env.collections.announcements = [announcement('a1')];
  await env.api.refreshPeople();
  await env.settle();
  assert.deepEqual(env.constructed, ['Update a1'], 'the constructor was tried after showNotification rejected');
  assert.equal(env.values.get('egc_browser_alerts_delivery'), 'refused');
  const board = env.api.myDayBoard();
  assert.match(board, unavailable);
  assert.doesNotMatch(board, /Browser alerts on/);
  assert.match(board, /opsDisableAlerts\(\)/);
});

test('a desktop browser with no worker shows alerts from the page and keeps the on badge', async () => {
  const env = suite({ desktop: true });
  env.collections.announcements = [announcement('a1')];
  await env.api.refreshPeople();
  await env.settle();
  assert.deepEqual(env.constructed, ['Update a1']);
  assert.equal(env.values.get('egc_browser_alerts_delivery'), 'page');
  assert.match(env.api.myDayBoard(), /Browser alerts on/);
});

test('alerts name the screen a tap opens, and a worker that shows them keeps the on badge', async () => {
  const shown = [];
  const env = suite({ registration: { showNotification: async (title, options) => { shown.push([options.tag, options.data?.view]); } } });
  env.collections.announcements = [announcement('a1')];
  env.collections.teamMessages = [chat('m1')];
  await env.api.refreshPeople();
  await env.settle();
  assert.deepEqual(shown.sort(), [['a1', 'my_day'], ['m1', 'crew_chat']]);
  assert.equal(env.values.get('egc_browser_alerts_delivery'), 'worker');
  assert.match(env.api.myDayBoard(), /Browser alerts on/);
});

test('installing the Hub app after alerts were found unavailable brings the on badge back at the next refresh', async () => {
  const env = suite();
  env.values.set('egc_browser_alerts_delivery', 'none');
  await env.api.refreshPeople();
  await env.settle();
  assert.match(env.api.myDayBoard(), unavailable);
  env.registration = { showNotification: async () => {} };
  await env.api.refreshPeople();
  await env.settle();
  assert.equal(env.values.get('egc_browser_alerts_delivery'), 'worker');
  assert.match(env.api.myDayBoard(), /Browser alerts on/);
});

test('enabling alerts on an Android phone without the Hub app says right away that they are unavailable', async () => {
  const env = suite({ alerts: '' });
  await env.api.refreshPeople();
  await env.context.opsEnableAlerts();
  assert.equal(env.values.get('egc_browser_alerts'), 'on');
  assert.equal(env.values.get('egc_browser_alerts_delivery'), 'none');
  assert.match(env.toasts.at(-1), unavailable);
  const desktop = suite({ alerts: '', desktop: true });
  await desktop.api.refreshPeople();
  await desktop.context.opsEnableAlerts();
  assert.deepEqual(desktop.constructed, ['Employee Hub alerts are on'], 'a desktop browser shows one confirmation alert');
  assert.equal(desktop.toasts.at(-1), 'Employee Hub alerts enabled');
});

test('a worker that refuses alerts keeps the unavailable note at later refreshes; only an alert it shows brings the badge back', async () => {
  const shown = [];
  let refuse = true;
  const env = suite({ registration: { showNotification: async (title, options) => { if (refuse) throw new TypeError('No active service worker'); shown.push(options.tag); } } });
  env.collections.announcements = [announcement('a1')];
  await env.api.refreshPeople();
  await env.settle();
  assert.equal(env.values.get('egc_browser_alerts_delivery'), 'refused');
  for (const id of ['a2', 'a3']) {
    env.collections.announcements.push(announcement(id));
    await env.api.refreshPeople();
    await env.settle();
    assert.equal(env.values.get('egc_browser_alerts_delivery'), 'refused', 'the registration being there does not flip the badge back');
    assert.match(env.api.myDayBoard(), unavailable);
  }
  refuse = false;
  env.collections.announcements.push(announcement('a4'));
  await env.api.refreshPeople();
  await env.settle();
  assert.deepEqual(shown, ['a4']);
  assert.equal(env.values.get('egc_browser_alerts_delivery'), 'worker');
  assert.match(env.api.myDayBoard(), /Browser alerts on/);
});

test('the note advises installing the Hub app only where the Hub app can be installed', async () => {
  for (const [hubApp, advice] of [[false, false], [true, true]]) {
    const env = suite({ hubApp });
    env.values.set('egc_browser_alerts_delivery', 'none');
    await env.api.refreshPeople();
    const board = env.api.myDayBoard();
    assert.match(board, unavailable);
    assert.equal(install.test(board), advice, `HUB_OFFLINE_ENABLED ${hubApp ? 'on' : 'off'}`);
  }
});

test('a storage error while checking alerts never fails the refresh or My day', async () => {
  const env = suite();
  env.collections.announcements = [announcement('a1')];
  const getItem = env.context.localStorage.getItem;
  env.context.localStorage.getItem = key => { if (key === 'egc_browser_alerts') throw new Error('SecurityError: storage blocked'); return getItem(key); };
  assert.equal(await env.api.refreshPeople(), true);
  await env.settle();
  assert.equal(env.api.S.peopleState.error, '');
  assert.match(env.api.myDayBoard(), /opsEnableAlerts\(\)/, 'alerts read as off');
});
