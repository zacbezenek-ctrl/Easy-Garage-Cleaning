import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { onRequest } from '../functions/_middleware.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { hubOfflineEnabled, onRequestGet as hubOfflineSetting } from '../functions/api/hub-offline.js';
import { STAFF_PUBLIC_PATHS, staffGatedPath } from '../staff-paths.js';
import { createPagesHandler, parseHeadersFile, headersFor } from './lighthouse/serve.mjs';
import { createDocument } from './helpers/hub-dom.mjs';

// HUB-PWA: the installable Employee Hub (employee.webmanifest + hub-sw.js), its switch and its edge headers.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ORIGIN = 'https://easygaragecleaning.com';
const worker = read('hub-sw.js');
const NOW = Date.parse('2026-09-28T16:00:00.000Z');
const CACHE = 'egc-hub-assets-20260929hubpwa';
const plain = value => JSON.parse(JSON.stringify(value));
const absolute = key => typeof key === 'string' ? new URL(key, ORIGIN).href : key.url;
const basic = response => Object.defineProperty(response, 'type', { value: 'basic' });
// Inside a worker, relative request URLs resolve against the worker's origin.
class WorkerRequest extends Request { constructor(input, init) { super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init); } }

function harness({ config = { ok: true, enabled: true }, network = null } = {}) {
  const listeners = {}, stores = new Map(), requests = [];
  const clock = { at: NOW, advance(ms) { clock.at += ms; } };
  class WorkerDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.at])); } static now() { return clock.at; } }
  // files: what the site serves now (body and ETag per path); status/redirectTo/type model refusals and odd responses.
  const state = { online: true, stall: false, config, unregistered: 0, claimed: 0, skipped: 0, status: 200, redirectTo: '', type: 'basic', files: new Map() };
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
    async has(name) { return stores.has(name); },
    async delete(name) { return stores.delete(name); },
    // CacheStorage.match with a cacheName reads only that cache and never creates it.
    async match(key, { cacheName } = {}) { const hit = stores.get(cacheName)?.get(absolute(key)); return hit ? hit.clone() : undefined; },
  };
  async function fetch(input, init = {}) {
    const request = typeof input === 'string' ? new WorkerRequest(input, init) : input, url = new URL(request.url);
    requests.push(request);
    if (!state.online) throw new TypeError('Failed to fetch');
    if (network) return network(request);
    if (url.pathname === '/api/hub-offline') return basic(Response.json(state.config));
    if (state.stall) return new Promise(() => {});
    const file = state.files.get(url.pathname) || { body: `network ${url.pathname}`, etag: '"v1"' };
    if (state.status === 200 && !state.redirectTo && request.headers.get('If-None-Match') === file.etag) return basic(new Response(null, { status: 304, headers: { ETag: file.etag } }));
    const response = new Response(state.status === 200 ? file.body : `refused ${state.status}`, { status: state.status, headers: { 'Content-Type': 'text/javascript', ETag: file.etag, 'Cache-Control': 'private, no-store' } });
    Object.defineProperty(response, 'type', { value: state.type });
    return state.redirectTo ? Object.defineProperties(response, { redirected: { value: true }, url: { value: new URL(state.redirectTo, ORIGIN).href } }) : response;
  }
  const context = {
    caches, fetch, Request: WorkerRequest, Response, Headers, URL, Promise, JSON, Date: WorkerDate, Map, Set, Error, TypeError, console,
    setTimeout: callback => setTimeout(callback, 0), clearTimeout,
    location: new URL('/hub-sw.js', ORIGIN),
    registration: { unregister: async () => { state.unregistered++; return true; } },
    clients: { claim: async () => { state.claimed++; } },
    skipWaiting: async () => { state.skipped++; },
    addEventListener: (type, listener) => (listeners[type] ||= []).push(listener),
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(worker, context, { filename: 'hub-sw.js' });
  // settle:false answers without waiting for the event's background work (a stalled request never finishes it).
  async function dispatch(type, init = {}, { settle = true } = {}) {
    const extended = []; let responded = null;
    const event = { ...init, waitUntil: promise => extended.push(Promise.resolve(promise)), respondWith: promise => { responded = Promise.resolve(promise); } };
    for (const listener of listeners[type] || []) listener(event);
    const response = responded ? await responded : undefined;
    const settled = settle ? await Promise.allSettled(extended) : [];
    return { response, responded: Boolean(responded), settled };
  }
  const fetchEvent = (path, { method = 'GET', mode = 'no-cors', origin = ORIGIN } = {}, options) => dispatch('fetch', { request: { url: new URL(path, origin).href, method, mode, headers: new Headers() } }, options);
  const cached = async () => { const rows = []; for (const [name, entries] of stores) for (const url of entries.keys()) rows.push([name, new URL(url).pathname + new URL(url).search]); return rows; };
  const assets = requests => requests.filter(request => new URL(request.url).pathname !== '/api/hub-offline');
  return { state, stores, requests, clock, dispatch, fetchEvent, cached, context, assetRequests: () => assets(requests) };
}
async function installed(options) {
  const sw = harness(options);
  assert.deepEqual((await sw.dispatch('install')).settled.map(result => result.status), ['fulfilled']);
  await sw.dispatch('activate');
  return sw;
}
const copyOf = async (sw, key) => (await (await sw.context.caches.open(CACHE)).match(key))?.text();

test('install activates at once without fetching anything; activation removes only older Hub file caches, makes its own and takes control', async () => {
  const sw = harness();
  for (const name of ['egc-hub-assets-older', 'egc-crew-shell-20260928gate', 'unrelated-cache']) await (await sw.context.caches.open(name)).put('/x', new Response('x'));
  await sw.dispatch('install');
  assert.equal(sw.state.skipped, 1);
  assert.deepEqual(sw.requests, [], 'nothing is precached: staff files are kept only from signed-in loads');
  await sw.dispatch('activate');
  assert.deepEqual([...sw.stores.keys()].sort(), ['egc-crew-shell-20260928gate', CACHE, 'unrelated-cache'], 'the crew shell and other caches are left alone');
  assert.equal(sw.stores.get(CACHE).size, 0, 'the file cache starts empty');
  assert.equal(sw.state.claimed, 1); assert.equal(sw.state.unregistered, 0);
  assert.deepEqual(sw.requests.map(request => new URL(request.url).pathname), ['/api/hub-offline'], 'activation checks the switch');
});

test('pages, API calls, non-GET requests, other origins, unversioned and non-Hub files are never intercepted or kept', async () => {
  const sw = await installed();
  for (const [path, options] of [['/employee.html', { mode: 'navigate' }], ['/employee?view=my_day', { mode: 'navigate' }], ['/employee-suite.js?v=20260922ops', { mode: 'navigate' }],
    ['/api/employee-hub'], ['/api/hub-offline'], ['/api/employee-hub', { method: 'POST', mode: 'cors' }], ['/employee-suite.js?v=20260922ops', { method: 'POST' }],
    ['/employee-suite.js'], ['/employee-suite.js?v=1&extra=2'], ['/employee-suite.js?version=1'], ['/employee.webmanifest'], ['/hub-sw.js'], ['/styles.css?v=20260904j'],
    ['/crew/job.js?v=20260927pwa'], ['/dispatch.html', { mode: 'navigate' }], ['/employee-a.b.js?v=1'], ['/sub/employee-suite.js?v=1'],
    ['https://www.gstatic.com/firebasejs/9.23.0/employee-suite.js?v=1', { origin: 'https://www.gstatic.com' }]]) {
    const result = await sw.fetchEvent(path, options);
    assert.equal(result.responded, false, `${options?.method || 'GET'} ${path} goes straight to the network`);
  }
  assert.deepEqual(await sw.cached(), []);
  assert.deepEqual(sw.assetRequests(), [], 'the worker itself fetched nothing for them');
});

test('a versioned Hub file loads fresh with the session cookie and is kept; later loads revalidate with its ETag, so an unchanged file costs a 304', async () => {
  const sw = await installed(), key = '/employee-suite.js?v=20260922ops';
  const first = await sw.fetchEvent(key);
  assert.equal(await first.response.text(), 'network /employee-suite.js');
  const [request] = sw.assetRequests();
  assert.equal(new URL(request.url).pathname + new URL(request.url).search, key);
  assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store'); assert.equal(request.headers.has('If-None-Match'), false);
  assert.equal(await copyOf(sw, key), 'network /employee-suite.js');
  const second = await sw.fetchEvent(key);
  assert.equal(sw.assetRequests()[1].headers.get('If-None-Match'), '"v1"');
  assert.equal(second.response.status, 200, 'the 304 is answered with the saved copy');
  assert.equal(await second.response.text(), 'network /employee-suite.js');
});

test('a file changed without a ?v= bump is never served stale: the new file is served and replaces the device copy', async () => {
  const sw = await installed(), key = '/employee-suite.js?v=20260922ops';
  await sw.fetchEvent(key);
  sw.state.files.set('/employee-suite.js', { body: 'network changed build', etag: '"v2"' });
  const response = await sw.fetchEvent(key);
  assert.equal(await response.response.text(), 'network changed build');
  assert.equal(await copyOf(sw, key), 'network changed build');
});

test('offline or on a stalled connection the device copy answers, and a file never kept answers 503', async () => {
  const sw = await installed(), key = '/employee-offline-queue.js?v=20260929hubpwa2';
  await sw.fetchEvent(key);
  sw.state.online = false;
  assert.equal(await (await sw.fetchEvent(key)).response.text(), 'network /employee-offline-queue.js');
  const missing = await sw.fetchEvent('/employee-dispatch.js?v=20260928recur');
  assert.equal(missing.response.status, 503); assert.equal(missing.response.headers.get('cache-control'), 'no-store');
  sw.state.online = true; sw.state.stall = true;
  assert.equal(await (await sw.fetchEvent(key, {}, { settle: false })).response.text(), 'network /employee-offline-queue.js', 'a stalled request falls back to the copy');
});

// STAFF-GATE: never keep a 302/401 or a redirected response; the device copy is only ever a signed-in 200 for that file.
test('only a 200 for the file itself is kept: 401, 500, sign-in redirects and opaque responses pass through and never replace the copy', async () => {
  const sw = await installed(), key = '/employee-hub-screens.js?v=20260927hubreg';
  await sw.fetchEvent(key);
  for (const [label, change] of [['401', { status: 401 }], ['500', { status: 500 }], ['sign-in redirect', { redirectTo: '/staff-login?next=%2Femployee' }], ['opaque', { type: 'opaque' }]]) {
    Object.assign(sw.state, { status: 200, redirectTo: '', type: 'basic' }, change);
    sw.state.files.set('/employee-hub-screens.js', { body: 'network newer build', etag: `"${label}"` });
    const result = await sw.fetchEvent(key);
    assert.equal(result.response.status, change.status || 200, `${label} is passed through as it came`);
    assert.equal(await copyOf(sw, key), 'network /employee-hub-screens.js', `${label} never replaces the kept copy`);
    const fresh = await sw.fetchEvent('/employee-ui-kit.js?v=20260927hubreg');
    assert.equal((await sw.cached()).some(([, path]) => path.startsWith('/employee-ui-kit.js')), false, `${label}: nothing new is kept`);
    assert.equal(fresh.response.status, change.status || 200);
  }
});

test('a newer ?v= build replaces the older copy of the same file and leaves other files alone', async () => {
  const sw = await installed();
  await sw.fetchEvent('/employee-suite.js?v=20260922ops');
  await sw.fetchEvent('/employee-suite.css?v=20260909gusto');
  await sw.fetchEvent('/employee-suite.js?v=20261001next');
  assert.deepEqual((await sw.cached()).map(([, path]) => path).sort(), ['/employee-suite.css?v=20260909gusto', '/employee-suite.js?v=20261001next']);
  assert.deepEqual([...sw.stores.keys()], [CACHE]);
});

test('HUB_OFFLINE_ENABLED off removes the file cache and the worker; it is re-checked at most every five minutes, and an unreachable answer keeps it', async () => {
  const disabled = harness({ config: { ok: true, enabled: false } });
  await (await disabled.context.caches.open(CACHE)).put('/employee-suite.js?v=1', new Response('kept'));
  await disabled.dispatch('install'); await disabled.dispatch('activate');
  assert.equal(disabled.state.unregistered, 1); assert.equal(disabled.state.claimed, 0);
  assert.deepEqual([...disabled.stores.keys()], []);
  const later = await installed();
  await later.fetchEvent('/employee-suite.js?v=20260922ops');
  later.state.config = { ok: true, enabled: false };
  later.clock.advance(299999);
  await later.fetchEvent('/employee-suite.js?v=20260922ops');
  assert.equal(later.state.unregistered, 0, 'not re-checked within five minutes');
  later.clock.advance(1);
  await later.fetchEvent('/employee-suite.js?v=20260922ops');
  assert.equal(later.state.unregistered, 1, 'a Hub file load re-checks the switch');
  assert.equal([...later.stores.keys()].some(name => name.startsWith('egc-hub-assets-')), false);
  for (const config of [{ ok: false }, { enabled: false }, { ok: true, enabled: 'false' }, null]) {
    const kept = harness({ config }); await kept.dispatch('install'); await kept.dispatch('activate');
    assert.equal(kept.state.unregistered, 0, JSON.stringify(config)); assert.equal(kept.state.claimed, 1);
  }
  const unreachable = await installed();
  unreachable.state.online = false; unreachable.clock.advance(600000);
  await unreachable.fetchEvent('/employee-suite.js?v=20260922ops');
  assert.equal(unreachable.state.unregistered, 0, 'an unreachable switch never removes offline support');
});

test('a switched-off page that deletes the file cache while this worker still serves it: later loads come from the network and nothing is kept again', async () => {
  const sw = await installed(), key = '/employee-suite.js?v=20260922ops';
  await sw.fetchEvent(key);
  assert.equal(await copyOf(sw, key), 'network /employee-suite.js');
  // employee-hub-screens.js removeOffline(): the page unregisters the worker and deletes its cache; this worker keeps
  // serving the page's remaining loads until the page closes.
  await sw.context.caches.delete(CACHE);
  for (const path of [key, '/employee-dispatch.js?v=20260928recur', '/employee-suite.css?v=20260909gusto']) {
    const result = await sw.fetchEvent(path);
    assert.equal(result.response.status, 200, path); assert.equal(await result.response.text(), `network ${path.split('?')[0]}`, path);
  }
  assert.deepEqual([...sw.stores.keys()], [], 'the deleted cache is never made again');
  assert.deepEqual(sw.assetRequests().slice(1).map(request => request.headers.has('If-None-Match')), [false, false, false], 'no saved copy is consulted');
});

test('a retired worker keeps nothing more: a file still loading when the page retires it and deletes the cache is not left behind', async () => {
  const sw = await installed(), key = '/employee-dispatch.js?v=20260928recur', replies = [];
  await sw.fetchEvent('/employee-suite.js?v=20260922ops');
  // The page's removeOffline() lands between this worker's check that its cache exists and its write.
  const open = sw.context.caches.open;
  let racing = true;
  sw.context.caches.open = async name => {
    if (racing && name === CACHE) {
      racing = false;
      await sw.dispatch('message', { data: { type: 'egc-hub-offline-retire' }, ports: [{ postMessage: message => replies.push(message) }] });
      await sw.context.caches.delete(CACHE);
    }
    return open(name);
  };
  const result = await sw.fetchEvent(key);
  assert.equal(await result.response.text(), 'network /employee-dispatch.js', 'the page still gets its file');
  assert.deepEqual(plain(replies), [{ ok: true }], 'the worker answers the retire');
  assert.deepEqual([...sw.stores.keys()], [], 'the write that raced the deletion is removed again');
  await sw.fetchEvent('/employee-suite.css?v=20260909gusto');
  assert.deepEqual([...sw.stores.keys()], [], 'nothing is kept after retiring');
  await sw.dispatch('message', { data: { type: 'something-else' }, ports: [{ postMessage: message => replies.push(message) }] });
  assert.equal(replies.length, 1, 'other messages are ignored');
});

// The worker against the real edge: functions/_middleware.js with EGC_STAFF_PAGE_GATE=on in front of the repo's static
// files, and /api/hub-offline served by its real handler.
const STAFF_ENV = Object.freeze({ EGC_STAFF_PAGE_GATE: 'on', HUB_OFFLINE_ENABLED: 'true', HUB_SESSION_SECRET: 'synthetic-hub-pwa-gate-secret-0123456789abcdef', HUB_AUTH_USERS_JSON: JSON.stringify({ 'synthetic.crew': { passwordHash: 'c'.repeat(64), displayName: 'Synthetic Crew', role: 'crew' } }) });
const pages = createPagesHandler();
function gatedSite(env = STAFF_ENV) {
  const phone = { cookie: '', edge: [] };
  const next = url => async () => {
    if (url.pathname === '/api/hub-offline') return hubOfflineSetting({ env });
    const out = pages({ method: 'GET', url: url.pathname + url.search, headers: { 'accept-encoding': 'identity' } });
    return new Response(out.status === 308 ? null : out.body, { status: out.status, headers: Object.entries(out.headers).filter(([name]) => name !== 'content-length') });
  };
  phone.fetch = async request => {
    const url = new URL(request.url), headers = new Headers({ Accept: '*/*', 'Sec-Fetch-Mode': 'same-origin' });
    if (phone.cookie) headers.set('Cookie', phone.cookie);
    const response = await onRequest({ request: new Request(url, { headers }), env, next: next(url) });
    phone.edge.push([url.pathname + url.search, response.status]);
    return Object.defineProperties(response, { type: { value: 'basic' }, url: { value: url.href } });
  };
  phone.signIn = async () => { phone.cookie = (await createHubSessionCookie(env, 'synthetic.crew')).split(';')[0]; };
  return phone;
}

test('staff gate on: a signed-out load gets the 401 untouched and keeps nothing; a signed-in load keeps the file, private no-store headers and all', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const phone = gatedSite(), sw = harness({ network: phone.fetch }), key = '/employee-offline-queue.js?v=20260929hubpwa2';
  await sw.dispatch('install'); await sw.dispatch('activate');
  assert.equal(sw.state.claimed, 1, 'the switch read through the edge is on');
  const refused = await sw.fetchEvent(key);
  assert.equal(refused.response.status, 401); assert.equal(await refused.response.text(), 'Sign in required.\n');
  assert.deepEqual(await sw.cached(), [], 'a refusal is never kept');
  await phone.signIn();
  const allowed = await sw.fetchEvent(key);
  assert.equal(allowed.response.status, 200); assert.equal(allowed.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await allowed.response.text(), read('employee-offline-queue.js'));
  assert.deepEqual((await sw.cached()).map(([, path]) => path), [key], 'the signed-in copy is kept on the device');
  assert.deepEqual(phone.edge.filter(([path]) => path === key).map(([, status]) => status), [401, 200]);
});

test('the manifest makes /employee.html an installable standalone app with existing icons', () => {
  const manifest = JSON.parse(read('employee.webmanifest'));
  assert.equal(manifest.start_url, '/employee.html'); assert.equal(manifest.id, '/employee.html'); assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone'); assert.match(manifest.name, /Employee Hub/); assert.ok(manifest.short_name.length <= 12);
  assert.deepEqual(manifest.icons.map(icon => icon.sizes).sort(), ['192x192', '512x512']);
  for (const icon of manifest.icons) assert.ok(existsSync(new URL(`..${icon.src}`, import.meta.url)), `${icon.src} exists`);
});

test('_headers: the worker revalidates on every update check, and employee.html and every /employee* file stay no-store', () => {
  const rules = parseHeadersFile(read('_headers'));
  assert.deepEqual(headersFor(rules, '/hub-sw.js'), { 'cache-control': 'no-cache', 'service-worker-allowed': '/' });
  for (const path of ['/employee.html', '/employee', '/employee-suite.js', '/employee-offline-queue.js', '/employee-offline-queue.css', '/employee.webmanifest']) assert.equal(headersFor(rules, path)['cache-control'], 'no-store', path);
  assert.equal(headersFor(rules, '/employee.html')['x-frame-options'], 'DENY');
});

test('staff gate: the manifest and the worker load signed out, the queue files are staff files, and the setting is never gated', async () => {
  for (const path of ['/employee.webmanifest', '/hub-sw.js', '/api/hub-offline']) assert.equal(staffGatedPath(path), false, path);
  for (const path of ['/employee-offline-queue.js', '/employee-offline-queue.css']) assert.equal(staffGatedPath(path), true, path);
  assert.ok(STAFF_PUBLIC_PATHS.includes('/employee.webmanifest'));
  for (const [path, status] of [['/employee.webmanifest', 200], ['/hub-sw.js', 200], ['/api/hub-offline', 200], ['/employee-offline-queue.js', 401]]) {
    let continued = 0;
    const response = await onRequest({ env: STAFF_ENV, request: new Request(ORIGIN + path, { headers: { Accept: '*/*' } }), next: async () => { continued++; return path === '/api/hub-offline' ? hubOfflineSetting({ env: STAFF_ENV }) : new Response('static'); } });
    assert.equal(response.status, status, path); assert.equal(continued, status === 200 ? 1 : 0, path);
  }
});

test('middleware: the Hub page may ask for the microphone (walkthrough recordings); its worker, manifest, scripts and the signup page may not', async () => {
  for (const [path, allowed] of [['/employee', true], ['/employee.html', true], ['/employee/', true], ['/employee-signup', false], ['/employee-offline-queue.js', false], ['/employee.webmanifest', false], ['/hub-sw.js', false], ['/', false]]) {
    const response = await onRequest({ request: new Request(ORIGIN + path), next: async () => new Response('page') });
    const policy = response.headers.get('Permissions-Policy');
    assert.ok(policy.includes(allowed ? 'microphone=(self)' : 'microphone=()'), `${path}: ${policy}`);
    assert.match(policy, /camera=\(\)/, path);
  }
});

test('/api/hub-offline is on only for exactly "true", and the answer is never cached', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true', '1', 'on', 'yes']) assert.equal(hubOfflineEnabled({ HUB_OFFLINE_ENABLED: value }), false, String(value));
  assert.equal(hubOfflineEnabled(undefined), false);
  assert.equal(hubOfflineEnabled({ HUB_OFFLINE_ENABLED: 'true' }), true);
  for (const [env, enabled] of [[{}, false], [{ HUB_OFFLINE_ENABLED: 'true' }, true]]) {
    const response = await onRequest({ env, request: new Request(`${ORIGIN}/api/hub-offline`), next: async () => hubOfflineSetting({ env }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, enabled });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('employee.html: the Hub CSP allows blob:/https: images and blob: media, the queue loads before the registry and the suite, and nothing makes it installable by default', () => {
  const html = read('employee.html'), csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1];
  const directive = name => csp.split(';').map(part => part.trim()).find(part => part.startsWith(name + ' ')).split(/\s+/).slice(1);
  for (const source of ["'self'", 'data:', 'blob:', 'https:']) assert.ok(directive('img-src').includes(source), `img-src ${source}`);
  assert.deepEqual(directive('media-src'), ["'self'", 'blob:']);
  assert.ok(directive('script-src').includes("'self'"), 'the worker registers under script-src');
  const at = name => html.indexOf(name);
  assert.ok(at('employee-offline-queue.js?v=20260929crewtime') > 0, 'CREW-TIME bumped the queue: it now keeps a clock-in with no position fix');
  assert.ok(at('employee-offline-queue.css?v=20260929hubpwa') > 0);
  assert.ok(at('employee-offline-queue.js') < at('employee-hub-screens.js') && at('employee-hub-screens.js') < at('employee-suite.js?v='));
  assert.doesNotMatch(html, /rel="manifest"/, 'the manifest link is added only when the switch is on');
  assert.doesNotMatch(html, /serviceWorker/);
});

// The registry side (employee-hub-screens.js): read the switch once, then install or remove.
function registry({ answer, registrations = [], retire = true } = {}) {
  const document = createDocument(), calls = { fetch: [], register: [], unregistered: [], deleted: [], configure: [], warn: [], steps: [] }, listeners = {};
  const names = new Set(['egc-hub-assets-20260929hubpwa', 'egc-hub-assets-older', 'egc-crew-shell-20260928gate']);
  // The files each cache holds (Cache.keys() / Cache.delete(request)).
  const files = new Map([...names].map(name => [name, new Set([`${ORIGIN}/employee-suite.js?v=20260922ops`, `${ORIGIN}/employee-ui-kit.js?v=20260927hubreg`])]));
  // A Hub worker answers the page's retire on the port it was handed (retire:false never answers).
  const worker = script => ({ unregister: async () => { calls.unregistered.push(script); calls.steps.push(`unregister ${script}`); return true; },
    active: { scriptURL: `${ORIGIN}${script}`, postMessage: (message, [port] = []) => { calls.steps.push(`${message?.type} ${script}`); if (retire) port?.postMessage({ ok: true }); } } });
  const context = {
    document, console: { ...console, warn: (...args) => calls.warn.push(args.join(' ')) }, location: new URL('/employee.html', ORIGIN), URL, Promise, Map, Set, Error, Object, String, Array, JSON,
    addEventListener: (type, listener) => (listeners[type] ||= []).push(listener), setTimeout, clearTimeout, MessageChannel,
    fetch: async (url, init) => { calls.fetch.push([url, init]); return answer(); },
    navigator: { serviceWorker: { register: async (script, options) => { calls.register.push([script, options]); return {}; }, getRegistrations: async () => registrations.map(worker) } },
    caches: { keys: async () => [...names], delete: async name => { calls.deleted.push(name); calls.steps.push(`delete ${name}`); return names.delete(name); },
      open: async name => ({ keys: async () => [...files.get(name) || []].map(url => new Request(url)), delete: async request => { calls.steps.push(`forget ${name} ${new URL(request.url).pathname}`); return files.get(name)?.delete(request.url) ?? false; } }) },
    EGCHubOffline: { configure: options => calls.configure.push(options) },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('employee-hub-screens.js'), context, { filename: 'employee-hub-screens.js' });
  const fire = type => { for (const listener of listeners[type] || []) listener({ type }); };
  return { context, document, calls, names, files, fire };
}

test('the registry reads the switch once: on adds the manifest and registers hub-sw.js at scope /; off removes only the Hub worker and caches; unreachable changes nothing', async () => {
  const on = registry({ answer: async () => Response.json({ ok: true, enabled: true }) });
  assert.equal(await on.context.EGCHubScreens.offline(), true);
  assert.equal(await on.context.EGCHubScreens.offline(), true);
  assert.equal(on.calls.fetch.length, 1, 'read once per page');
  assert.deepEqual(plain(on.calls.fetch[0]), ['/api/hub-offline', { credentials: 'same-origin', cache: 'no-store' }]);
  assert.deepEqual(plain(on.calls.register), [['/hub-sw.js', { scope: '/' }]]);
  const links = on.document.head.querySelectorAll('link').filter(link => link.getAttribute('rel') === 'manifest');
  assert.deepEqual(links.map(link => link.getAttribute('href')), ['/employee.webmanifest']);
  assert.deepEqual(on.calls.configure.map(options => ({ ...options })), [{ enabled: true }]);
  assert.deepEqual(on.calls.unregistered, []); assert.deepEqual(on.calls.deleted, []);

  const off = registry({ answer: async () => Response.json({ ok: true, enabled: false }), registrations: ['/hub-sw.js', '/crew/sw.js'] });
  assert.equal(await off.context.EGCHubScreens.offline(), false);
  assert.deepEqual(off.calls.unregistered, ['/hub-sw.js'], 'the crew worker is not touched');
  assert.deepEqual(off.calls.steps.slice(0, 2), ['egc-hub-offline-retire /hub-sw.js', 'unregister /hub-sw.js'], 'the Hub worker is retired, and has answered, before it is unregistered and its files are deleted');
  assert.equal(off.calls.steps.filter(step => step.startsWith('delete ')).length, 2);
  assert.deepEqual(off.calls.deleted.sort(), ['egc-hub-assets-20260929hubpwa', 'egc-hub-assets-older']);
  assert.deepEqual(off.calls.register, []);
  assert.equal(off.document.head.querySelectorAll('link').length, 0);
  assert.deepEqual(off.calls.configure.map(options => ({ ...options })), [{ enabled: false }]);

  const silent = registry({ answer: async () => Response.json({ ok: true, enabled: false }), registrations: ['/hub-sw.js'], retire: false });
  silent.context.setTimeout = (callback, ms) => { assert.equal(ms, 2000); return setTimeout(callback, 0); };
  assert.equal(await silent.context.EGCHubScreens.offline(), false);
  assert.deepEqual(silent.calls.steps, ['egc-hub-offline-retire /hub-sw.js', 'unregister /hub-sw.js', 'delete egc-hub-assets-20260929hubpwa', 'delete egc-hub-assets-older'], 'a worker that never answers is still removed after 2 s');

  for (const answer of [async () => { throw new TypeError('Failed to fetch'); }, async () => Response.json({ ok: false, error: 'Synthetic service unavailable' }, { status: 503 }), async () => Response.json({ ok: true, enabled: 'true' }), async () => new Response('not json')]) {
    const unknown = registry({ answer, registrations: ['/hub-sw.js'] });
    assert.equal(await unknown.context.EGCHubScreens.offline(), null);
    assert.deepEqual([unknown.calls.register, unknown.calls.unregistered, unknown.calls.deleted], [[], [], []], 'an unknown answer neither installs nor removes');
    assert.deepEqual(unknown.calls.configure, [], 'the queue is neither switched on nor switched off (which removes expired actions unannounced): it stays as the page started, holding nothing new');
  }
  const blocked = registry({ answer: async () => Response.json({ ok: true, enabled: true }) });
  blocked.context.navigator.serviceWorker.register = async () => { throw new Error('Service workers are blocked'); };
  assert.equal(await blocked.context.EGCHubScreens.offline(), true);
  assert.match(blocked.calls.warn.join('\n'), /Hub offline worker was not registered: Service workers are blocked/);
  assert.deepEqual(blocked.calls.configure.map(options => ({ ...options })), [{ enabled: true }], 'the queue still works without the worker');
});

test('an unknown answer is not kept: the switch is asked again when the connection returns or the Hub is shown, until it is definite, and then never again', async () => {
  const replies = [async () => { throw new TypeError('Failed to fetch'); }, async () => Response.json({ ok: false }, { status: 503 }), async () => Response.json({ ok: true, enabled: true })];
  const hub = registry({ answer: () => replies.shift()() });
  assert.equal(await hub.context.EGCHubScreens.offline(), null, 'the page loaded during a signal blip');
  assert.equal(hub.calls.fetch.length, 1);
  assert.deepEqual(hub.calls.configure, [], 'the queue stays as the page started (holding nothing new) for now');
  hub.fire('online');
  assert.equal(await hub.context.EGCHubScreens.offline(), null, 'still unknown');
  assert.equal(hub.calls.fetch.length, 2, 'the returning connection asked again');
  assert.deepEqual(hub.calls.configure, [], 'a repeated unknown answer changes nothing');
  hub.document.dispatch({ type: 'visibilitychange' });
  assert.equal(await hub.context.EGCHubScreens.offline(), true);
  assert.equal(hub.calls.fetch.length, 3, 'the Hub shown again asked again');
  assert.deepEqual(hub.calls.configure.map(options => ({ ...options })), [{ enabled: true }], 'the queue switches on with the first definite answer');
  assert.deepEqual(plain(hub.calls.register), [['/hub-sw.js', { scope: '/' }]]);
  hub.fire('online'); hub.document.dispatch({ type: 'visibilitychange' });
  assert.equal(await hub.context.EGCHubScreens.offline(), true);
  assert.equal(hub.calls.fetch.length, 3, 'a definite answer holds for the page');
  const hidden = registry({ answer: async () => { throw new TypeError('Failed to fetch'); } });
  await hidden.context.EGCHubScreens.offline();
  hidden.document.visibilityState = 'hidden';
  hidden.document.dispatch({ type: 'visibilitychange' });
  await hidden.context.EGCHubScreens.offline();
  assert.equal(hidden.calls.fetch.length, 2, 'hiding the Hub asks nothing; only the explicit call asked again');
});

test('signing out clears the device copies of the Hub files after telling the worker; the caches, other caches and the worker stay', async () => {
  const hub = registry({ answer: async () => Response.json({ ok: true, enabled: true }), registrations: ['/hub-sw.js', '/crew/sw.js'] });
  await hub.context.EGCHubScreens.offline();
  hub.fire('egc:signout');
  for (let i = 0; i < 50 && hub.calls.steps.filter(step => step.startsWith('forget ')).length < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(hub.calls.steps, ['egc-hub-offline-signout /hub-sw.js',
    'forget egc-hub-assets-20260929hubpwa /employee-suite.js', 'forget egc-hub-assets-20260929hubpwa /employee-ui-kit.js',
    'forget egc-hub-assets-older /employee-suite.js', 'forget egc-hub-assets-older /employee-ui-kit.js'], 'the Hub worker answers before its copies are cleared; the crew worker is not told');
  assert.deepEqual([...hub.files.get('egc-hub-assets-20260929hubpwa')], []);
  assert.equal(hub.files.get('egc-crew-shell-20260928gate').size, 2, 'the crew shell keeps its files');
  assert.deepEqual([...hub.names].sort(), ['egc-crew-shell-20260928gate', 'egc-hub-assets-20260929hubpwa', 'egc-hub-assets-older'], 'no cache is deleted, so the worker keeps copies again after the next sign-in');
  assert.deepEqual(hub.calls.unregistered, []);
  // A worker that never answers does not keep the copies: they are cleared after 2 s.
  const silent = registry({ answer: async () => Response.json({ ok: true, enabled: true }), registrations: ['/hub-sw.js'], retire: false });
  silent.context.setTimeout = (callback, ms) => { assert.equal(ms, 2000); return setTimeout(callback, 0); };
  silent.fire('egc:signout');
  for (let i = 0; i < 50 && silent.files.get('egc-hub-assets-20260929hubpwa').size; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(silent.files.get('egc-hub-assets-20260929hubpwa').size, 0);
});

test('a sign-out while a Hub file is loading: the worker answers, does not keep that file, and keeps copies again from the next signed-in load', async () => {
  const sw = await installed(), replies = [], key = '/employee-dispatch.js?v=20260928recur';
  await sw.fetchEvent('/employee-suite.js?v=20260922ops');
  // The page's sign-out lands between this worker's check that its cache exists and its write, and then clears the copies.
  const open = sw.context.caches.open;
  let racing = true;
  sw.context.caches.open = async name => {
    if (racing && name === CACHE) {
      racing = false;
      await sw.dispatch('message', { data: { type: 'egc-hub-offline-signout' }, ports: [{ postMessage: message => replies.push(message) }] });
      const cache = await open(name);
      for (const request of await cache.keys()) await cache.delete(request);
    }
    return open(name);
  };
  const result = await sw.fetchEvent(key);
  assert.equal(await result.response.text(), 'network /employee-dispatch.js', 'the page still gets its file');
  assert.deepEqual(plain(replies), [{ ok: true }], 'the worker answers the sign-out');
  assert.deepEqual(await sw.cached(), [], 'the file that raced the sign-out is not kept');
  sw.state.online = false;
  assert.equal((await sw.fetchEvent('/employee-suite.js?v=20260922ops')).response.status, 503, 'signed out and offline, no staff file is served from the device');
  sw.state.online = true;
  await sw.fetchEvent('/employee-suite.js?v=20260922ops');
  assert.deepEqual((await sw.cached()).map(([, path]) => path), ['/employee-suite.js?v=20260922ops'], 'the next signed-in load is kept again');
  assert.equal(sw.state.unregistered, 0);
});
