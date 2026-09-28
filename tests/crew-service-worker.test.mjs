import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ORIGIN = 'https://easygaragecleaning.com';
const worker = read('crew/sw.js'), outboxSource = read('crew/field-outbox.js');
const absolute = key => typeof key === 'string' ? new URL(key, ORIGIN).href : key.url;
const basic = response => Object.defineProperty(response, 'type', { value: 'basic' });
// Inside a worker, relative request URLs resolve against the worker's origin.
class WorkerRequest extends Request { constructor(input, init) { super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init); } }
const NOW = Date.parse('2026-09-22T15:00:00.000Z');

function harness({ config = { enabled: true }, indexedDB = fakeIndexedDB(), api = null } = {}) {
  const listeners = {}, stores = new Map(), fetched = [], messages = [];
  // The worker and the outbox it imports see only this clock, advanced explicitly.
  const clock = { at: NOW, advance(ms) { clock.at += ms; } };
  class WorkerDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.at])); } static now() { return clock.at; } }
  const state = { online: true, stall: false, config, unregistered: 0, claimed: 0, skipped: 0, headers: {} };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const rows = stores.get(name);
      return {
        async put(key, response) { rows.set(absolute(key), response); },
        async match(key) { const hit = rows.get(absolute(key)); return hit ? hit.clone() : undefined; },
        async keys() { return [...rows.keys()].map(url => new Request(url)); },
        async delete(key) { return rows.delete(absolute(key)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN), method = (typeof input === 'string' ? init.method : input.method) || 'GET';
    fetched.push(`${method} ${url.pathname}${url.search}`);
    if (!state.online) throw new TypeError('Failed to fetch');
    if (url.pathname === '/crew/sw-config.json') return basic(Response.json(state.config));
    if (url.pathname.startsWith('/api/')) {
      if (api) return api(url, method, typeof input === 'string' ? init.body : null);
      return basic(Response.json({ ok: true, customer: 'Synthetic Customer', phone: '9705550100' }, { headers: { 'Cache-Control': 'private, no-store' } }));
    }
    if (state.stall && url.pathname.startsWith('/crew/')) return new Promise(() => {});
    return basic(new Response(`network ${url.pathname}`, { headers: { 'Content-Type': url.pathname.endsWith('.js') ? 'application/javascript' : 'text/html', ...state.headers } }));
  }
  const context = {
    caches, fetch, indexedDB, Request: WorkerRequest, Response, Headers, URL, Promise, JSON, Date: WorkerDate, Map, Set, Error, TypeError, console, encodeURIComponent,
    setTimeout: callback => setTimeout(callback, 0), clearTimeout,
    location: new URL('/crew/sw.js', ORIGIN),
    registration: { unregister: async () => { state.unregistered++; return true; } },
    clients: { claim: async () => { state.claimed++; }, matchAll: async () => [{ postMessage: message => messages.push(message) }] },
    skipWaiting: async () => { state.skipped++; },
    addEventListener: (type, listener) => (listeners[type] ||= []).push(listener),
    importScripts: path => { assert.equal(path, '/crew/field-outbox.js?v=20260927pwa'); vm.runInContext(outboxSource, context); },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(worker, context);
  async function dispatch(type, init = {}, { settle = true } = {}) {
    const extended = []; let responded = null;
    const event = { ...init, waitUntil: promise => extended.push(Promise.resolve(promise)), respondWith: promise => { responded = Promise.resolve(promise); } };
    for (const listener of listeners[type] || []) listener(event);
    const response = responded ? await responded : undefined;
    const settled = settle ? await Promise.allSettled(extended) : [];
    return { response, responded: Boolean(responded), settled };
  }
  const request = (path, { method = 'GET', mode = 'cors', origin = ORIGIN } = {}) => ({ url: new URL(path, origin).href, method, mode, headers: new Headers() });
  const cached = async () => { const urls = []; for (const [name, rows] of stores) for (const url of rows.keys()) urls.push([name, new URL(url).pathname + new URL(url).search]); return urls; };
  return { state, stores, fetched, messages, clock, dispatch, request, cached, fetchEvent: (path, options, settle) => dispatch('fetch', { request: request(path, options) }, settle), context };
}
async function installed(options) {
  const sw = harness(options), install = await sw.dispatch('install');
  assert.deepEqual(install.settled.map(result => result.status), ['fulfilled']);
  await sw.dispatch('activate');
  return sw;
}

test('install caches only the static job shell under a versioned cache and activation claims the crew pages', async () => {
  const sw = harness(), existing = await sw.context.caches.open('egc-crew-shell-older'); await existing.put('/crew/job.html', new Response('old build'));
  await sw.context.caches.open('unrelated-cache');
  await sw.dispatch('install');
  assert.equal(sw.state.skipped, 1);
  const shell = (await sw.cached()).filter(([name]) => name === 'egc-crew-shell-20260927pwa').map(([, path]) => path).sort();
  assert.deepEqual(shell, ['/crew/field-expenses.css?v=20260927exp', '/crew/field-expenses.js?v=20260927exp2', '/crew/field-outbox.js?v=20260927pwa', '/crew/job.css?v=20260927pwa', '/crew/job.html', '/crew/job.js?v=20260927pwa', '/crew/manifest.webmanifest', '/crew/offline.html']);
  await sw.dispatch('activate');
  assert.deepEqual([...sw.stores.keys()].sort(), ['egc-crew-shell-20260927pwa', 'unrelated-cache'], 'older shell versions are removed; other caches are left alone');
  assert.equal(sw.state.claimed, 1); assert.equal(sw.state.unregistered, 0);
});

test('API calls, non-GET requests, other origins and the kill-switch config are never intercepted or cached', async () => {
  const sw = await installed(), before = await sw.cached();
  for (const [path, options] of [['/api/field-jobs?jobId=job-a'], ['/api/employee-hub?view=own-job-time'], ['/api/hub-auth'], ['/api/field-jobs', { method: 'POST' }], ['/crew/job.html', { method: 'POST', mode: 'navigate' }], ['/crew/sw-config.json'], ['/crew/hub-auth.js?v=1'], ['https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js', { origin: 'https://www.gstatic.com' }], ['/employee?view=my_day', { mode: 'navigate' }]]) {
    const result = await sw.fetchEvent(path, options);
    assert.equal(result.responded, false, `${options?.method || 'GET'} ${path} goes straight to the network`);
  }
  assert.deepEqual(await sw.cached(), before);
  assert.equal((await sw.cached()).some(([, path]) => path.startsWith('/api/')), false);
});

test('Today’s work loads network-first and falls back to the cached shell, or the offline page, when the connection drops', async () => {
  const sw = await installed();
  const online = await sw.fetchEvent('/crew/job.html?jobId=job-a', { mode: 'navigate' });
  assert.equal(await online.response.text(), 'network /crew/job.html', 'online navigations always use the fresh page');
  assert.equal(await (await (await sw.context.caches.open('egc-crew-shell-20260927pwa')).match('/crew/job.html')).text(), 'network /crew/job.html', 'the fresh page replaces the cached shell');
  sw.state.online = false;
  for (const path of ['/crew/job.html?jobId=job-b', '/crew/job?jobId=job-b']) assert.equal(await (await sw.fetchEvent(path, { mode: 'navigate' })).response.text(), 'network /crew/job.html', `${path} reloads offline from the shell`);
  assert.equal(await (await sw.fetchEvent('/crew/prejob.html?jobId=job-a', { mode: 'navigate' })).response.text(), 'network /crew/offline.html');
  assert.equal(await (await sw.fetchEvent('/crew/job.js?v=20260927pwa')).response.text(), 'network /crew/job.js');
  const missing = await sw.fetchEvent('/crew/job.js?v=never-cached');
  assert.equal(missing.response.status, 503);
});

test('a stalled network falls back to the cached shell instead of leaving the crew on a blank page', async () => {
  const sw = await installed();
  sw.state.stall = true;
  assert.equal(await (await sw.fetchEvent('/crew/job.html?jobId=job-a', { mode: 'navigate' }, { settle: false })).response.text(), 'network /crew/job.html');
});

test('shell assets refresh on each online load, keep one copy per file, and never store no-store responses', async () => {
  const sw = await installed();
  await sw.fetchEvent('/crew/job.js?v=20261001next');
  const scripts = (await sw.cached()).filter(([, path]) => path.startsWith('/crew/job.js'));
  assert.deepEqual(scripts.map(([, path]) => path), ['/crew/job.js?v=20261001next'], 'a newer build replaces the older cached copy');
  sw.state.headers = { 'Cache-Control': 'no-store' };
  const response = await sw.fetchEvent('/crew/job.css?v=20261001next');
  assert.equal(await response.response.text(), 'network /crew/job.css');
  assert.equal((await sw.cached()).some(([, path]) => path === '/crew/job.css?v=20261001next'), false);
});

test('the kill switch unregisters the worker and removes the shell cache', async () => {
  const disabled = harness({ config: { enabled: false } });
  await disabled.dispatch('install'); await disabled.dispatch('activate');
  assert.equal(disabled.state.unregistered, 1); assert.equal(disabled.state.claimed, 0);
  assert.deepEqual([...disabled.stores.keys()], []);
  const later = await installed();
  later.state.config = { enabled: false };
  later.clock.advance(299999);
  await later.fetchEvent('/crew/job.html?jobId=job-a', { mode: 'navigate' });
  assert.equal(later.state.unregistered, 0, 'the config is re-checked at most every five minutes');
  later.clock.advance(1);
  await later.fetchEvent('/crew/job.html?jobId=job-a', { mode: 'navigate' });
  assert.equal(later.state.unregistered, 1, 'a navigation re-checks the config');
  assert.equal([...later.stores.keys()].some(name => name.startsWith('egc-crew-shell-')), false);
  const unreachable = await installed();
  unreachable.state.online = false; unreachable.clock.advance(600000);
  await unreachable.fetchEvent('/crew/job.html', { mode: 'navigate' });
  assert.equal(unreachable.state.unregistered, 0, 'an unreachable config never disables offline support');
});

test('Background Sync replays the signed-in account’s queued actions and asks to retry while offline', async () => {
  const indexedDB = fakeIndexedDB(), sent = [];
  const api = (url, method, body) => {
    if (url.pathname === '/api/hub-auth') return basic(Response.json({ ok: true, user: 'Crew.One' }));
    if (url.searchParams.get('view') === 'timer') return basic(Response.json({ ok: true, expectedRevision: 'server-rev' }));
    sent.push(JSON.parse(body)); return basic(Response.json({ ok: true, alreadyApplied: false, job: { id: 'job-a' } }));
  };
  const sw = await installed({ indexedDB, api });
  const box = sw.context.EGCFieldOutbox.create({ store: sw.context.EGCFieldOutbox.idbStore(indexedDB) });
  const input = (user, requestId) => ({ requestId, kind: 'field', user, jobId: 'job-a', payload: { action: 'checklist', itemId: 'one', completed: true, jobId: 'job-a', requestId, expectedRevision: 'seen', expectedUser: user } });
  await box.enqueue(input('Crew.One', '00000000-0000-4000-8000-000000000101'));
  await box.enqueue(input('Crew.Two', '00000000-0000-4000-8000-000000000102'));
  const ignored = await sw.dispatch('sync', { tag: 'unrelated' });
  assert.equal(ignored.settled.length, 0);
  sw.state.online = false;
  const offline = await sw.dispatch('sync', { tag: 'egc-field-outbox' });
  assert.equal(offline.settled[0].status, 'rejected', 'the browser is asked to retry the sync later');
  sw.state.online = true;
  const synced = await sw.dispatch('sync', { tag: 'egc-field-outbox' });
  assert.equal(synced.settled[0].status, 'fulfilled');
  assert.deepEqual(sent.map(body => [body.requestId, body.expectedRevision]), [['00000000-0000-4000-8000-000000000101', 'server-rev']]);
  assert.deepEqual(indexedDB.rows('egc-field-outbox', 'actions').map(row => row.user), ['Crew.Two'], 'another account’s action stays queued');
  assert.equal(sw.messages.at(-1).type, 'egc-field-outbox-changed'); assert.equal(sw.messages.at(-1).applied, 1);
  assert.equal((await sw.cached()).some(([, path]) => path.startsWith('/api/')), false);
});

test('the precached shell matches the versioned files Today’s work and the offline page load', () => {
  const job = read('crew/job.html'), offline = read('crew/offline.html'), assets = [...worker.matchAll(/'(\/crew\/[a-z-]+\.(?:js|css)\?v=[^']+)'/g)].map(match => match[1]);
  for (const path of [...job.matchAll(/(?:src|href)="(\/crew\/[^"]+\?v=[^"]+)"/g)].map(match => match[1])) assert.ok(assets.includes(path), `${path} must be precached for offline reloads`);
  assert.match(offline, /href="\/crew\/job\.css\?v=20260927pwa"/);
  assert.match(job, /<link rel="manifest" href="\/crew\/manifest\.webmanifest">/);
  assert.ok(job.indexOf('field-outbox.js') < job.indexOf('/crew/job.js'), 'the outbox loads before the page script');
  assert.match(read('crew/job.js'), /navigator\.serviceWorker\.register\('\/crew\/sw\.js', \{ scope: '\/crew\/' \}\)/);
  assert.match(worker, /importScripts\('\/crew\/field-outbox\.js\?v=20260927pwa'\)/);
});

test('the manifest, headers and config scope the installable app to /crew/', () => {
  const manifest = JSON.parse(read('crew/manifest.webmanifest')), headers = read('_headers');
  assert.equal(manifest.scope, '/crew/'); assert.equal(manifest.start_url, '/crew/job.html'); assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map(icon => icon.sizes).sort(), ['192x192', '512x512']);
  for (const icon of manifest.icons) assert.ok(existsSync(new URL(`..${icon.src}`, import.meta.url)), `${icon.src} exists`);
  assert.match(headers, /\/crew\/sw\.js\n  Cache-Control: no-cache\n  Service-Worker-Allowed: \/crew\//);
  assert.match(headers, /\/crew\/sw-config\.json\n  Cache-Control: no-store/);
  assert.deepEqual(JSON.parse(read('crew/sw-config.json')), { enabled: true });
  assert.doesNotMatch(read('crew/index.html'), /will sync when your connection returns/, 'the crew home no longer claims offline work syncs');
});
