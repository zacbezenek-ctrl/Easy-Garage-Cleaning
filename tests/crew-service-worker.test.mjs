import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { onRequest } from '../functions/_middleware.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createPagesHandler } from './lighthouse/serve.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ORIGIN = 'https://easygaragecleaning.com';
const worker = read('crew/sw.js'), outboxSource = read('crew/field-outbox.js');
const absolute = key => typeof key === 'string' ? new URL(key, ORIGIN).href : key.url;
const basic = response => Object.defineProperty(response, 'type', { value: 'basic' });
// Inside a worker, relative request URLs resolve against the worker's origin.
class WorkerRequest extends Request { constructor(input, init) { super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init); } }
const NOW = Date.parse('2026-09-22T15:00:00.000Z');
const SHELL_CACHE = 'egc-crew-shell-20260928gate';

function harness({ config = { enabled: true }, indexedDB = fakeIndexedDB(), api = null, network = null } = {}) {
  const listeners = {}, stores = new Map(), fetched = [], messages = [];
  // The worker and the outbox it imports see only this clock, advanced explicitly.
  const clock = { at: NOW, advance(ms) { clock.at += ms; } };
  class WorkerDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.at])); } static now() { return clock.at; } }
  const state = { online: true, stall: false, config, unregistered: 0, claimed: 0, skipped: 0, headers: {}, status: 200, redirectTo: '' };
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
    if (network) return network(input, init);
    if (url.pathname === '/crew/sw-config.json') return basic(Response.json(state.config));
    if (url.pathname.startsWith('/api/')) {
      if (api) return api(url, method, typeof input === 'string' ? init.body : null);
      return basic(Response.json({ ok: true, customer: 'Synthetic Customer', phone: '9705550100' }, { headers: { 'Cache-Control': 'private, no-store' } }));
    }
    if (state.stall && url.pathname.startsWith('/crew/')) return new Promise(() => {});
    const response = basic(new Response(`network ${url.pathname}`, { status: state.status, headers: { 'Content-Type': url.pathname.endsWith('.js') ? 'application/javascript' : 'text/html', ...state.headers } }));
    return state.redirectTo ? Object.defineProperties(response, { redirected: { value: true }, url: { value: new URL(state.redirectTo, ORIGIN).href } }) : response;
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
  const shell = (await sw.cached()).filter(([name]) => name === SHELL_CACHE).map(([, path]) => path).sort();
  // FUN-19 bumped the Job costs module (closeout, kinds, payer, shared loads) to ?v=20260928fun19.
  assert.deepEqual(shell, ['/crew/field-expenses.css?v=20260928fun19', '/crew/field-expenses.js?v=20260928fun19', '/crew/field-outbox.js?v=20260927pwa', '/crew/job-photo-sharing.css?v=20260927photo', '/crew/job-photo-sharing.js?v=20260928photo', '/crew/job.css?v=20260927pwa', '/crew/job.html', '/crew/job.js?v=20260927pwa', '/crew/manifest.webmanifest', '/crew/offline.html']);
  await sw.dispatch('activate');
  assert.deepEqual([...sw.stores.keys()].sort(), [SHELL_CACHE, 'unrelated-cache'], 'older shell versions are removed; other caches are left alone');
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
  assert.equal(await (await (await sw.context.caches.open(SHELL_CACHE)).match('/crew/job.html')).text(), 'network /crew/job.html', 'the fresh page replaces the cached shell');
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

// STAFF-GATE: the edge marks every allowed staff file 'private, no-store' (aimed at HTTP caches), so the shell cache no
// longer reads Cache-Control; it keeps only a 200 for the file it asked for and never a 401, error or redirect elsewhere.
test('shell assets refresh on each online load, keep one copy per file, and store only a 200 for the file itself', async () => {
  const sw = await installed();
  await sw.fetchEvent('/crew/job.js?v=20261001next');
  const scripts = (await sw.cached()).filter(([, path]) => path.startsWith('/crew/job.js'));
  assert.deepEqual(scripts.map(([, path]) => path), ['/crew/job.js?v=20261001next'], 'a newer build replaces the older cached copy');
  sw.state.headers = { 'Cache-Control': 'private, no-store' };
  await sw.fetchEvent('/crew/job.css?v=20261001next');
  assert.ok((await sw.cached()).some(([, path]) => path === '/crew/job.css?v=20261001next'), 'a signed-in staff file is kept on this phone');
  for (const [label, status, redirectTo] of [['401', 401, ''], ['500', 500, ''], ['sign-in redirect', 200, '/crew/?next=%2Fcrew%2Fjob.html'], ['another page', 200, '/crew/offline']]) {
    Object.assign(sw.state, { status, redirectTo });
    const response = await sw.fetchEvent('/crew/field-expenses.js?v=20261001next');
    assert.equal(response.response.status, status, `${label} is passed through`);
    assert.equal((await sw.cached()).some(([, path]) => path === '/crew/field-expenses.js?v=20261001next'), false, `${label} is never stored`);
    const page = await sw.fetchEvent('/crew/job.html?jobId=job-z', { mode: 'navigate' });
    assert.equal(page.response.status, status);
  }
  assert.equal(await (await (await sw.context.caches.open(SHELL_CACHE)).match('/crew/job.html')).text(), 'network /crew/job.html', 'the cached job page is never replaced by a refusal');
  Object.assign(sw.state, { status: 200, redirectTo: '/crew/job' });
  await sw.fetchEvent('/crew/job.html?jobId=job-a', { mode: 'navigate' });
  const pretty = await (await sw.context.caches.open(SHELL_CACHE)).match('/crew/job.html');
  assert.equal(pretty.redirected, false, 'a pretty-URL redirect to the same page is stored as a plain response');
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
  assert.doesNotMatch(offline, /<link\b|<script\b/, 'the offline page is self-contained: it renders signed out and offline');
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

// STAFF-GATE: the worker against the real edge. functions/_middleware.js runs with EGC_STAFF_PAGE_GATE=on in front of the
// repo's static files (Pages pretty URLs included); a signed-in phone sends the Hub cookie. Navigations use redirect:
// 'manual' like a browser's, so a sign-in redirect reaches the worker as an opaqueredirect.
const STAFF_ENV = Object.freeze({ EGC_STAFF_PAGE_GATE: 'on', HUB_SESSION_SECRET: 'synthetic-crew-sw-gate-secret-0123456789abcdef', HUB_AUTH_USERS_JSON: JSON.stringify({ 'synthetic.crew': { passwordHash: 'c'.repeat(64), displayName: 'Synthetic Crew', role: 'crew' } }) });
const pages = createPagesHandler();
function gatedSite({ env = STAFF_ENV, accept = '*/*' } = {}) {
  const phone = { cookie: '', edge: [] };
  const next = url => async () => {
    const out = pages({ method: 'GET', url: url.pathname + url.search, headers: { 'accept-encoding': 'identity' } });
    return new Response(out.status === 308 ? null : out.body, { status: out.status, headers: Object.entries(out.headers).filter(([name]) => name !== 'content-length') });
  };
  phone.fetch = async input => {
    const navigate = typeof input !== 'string' && input.mode === 'navigate';
    let url = new URL(typeof input === 'string' ? input : input.url, ORIGIN), redirected = false;
    for (let hop = 0; hop < 5; hop++) {
      const headers = new Headers(navigate ? { Accept: 'text/html,application/xhtml+xml', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } : { Accept: accept, 'Sec-Fetch-Mode': 'same-origin' });
      if (phone.cookie) headers.set('Cookie', phone.cookie);
      const response = await onRequest({ request: new Request(url, { headers }), env, next: next(url) });
      phone.edge.push([url.pathname + url.search, response.status, response.headers.get('location') || '']);
      if (response.status < 300 || response.status > 399) return Object.defineProperties(response, { type: { value: 'basic' }, redirected: { value: redirected }, url: { value: url.href } });
      if (navigate) return Object.defineProperties(new Response(null), { type: { value: 'opaqueredirect' }, status: { value: 0 }, ok: { value: false } });
      url = new URL(response.headers.get('location'), url); redirected = true;
    }
    throw new TypeError('Too many redirects');
  };
  phone.signIn = async () => { phone.cookie = (await createHubSessionCookie(env, 'synthetic.crew')).split(';')[0]; };
  return phone;
}
const PUBLIC_KEYS = ['/crew/field-outbox.js?v=20260927pwa', '/crew/manifest.webmanifest', '/crew/offline.html'];
const STAFF_KEYS = ['/crew/field-expenses.css?v=20260928fun19', '/crew/field-expenses.js?v=20260928fun19', '/crew/job-photo-sharing.css?v=20260927photo', '/crew/job-photo-sharing.js?v=20260928photo', '/crew/job.css?v=20260927pwa', '/crew/job.html', '/crew/job.js?v=20260927pwa'];
const shellKeys = async sw => (await sw.cached()).filter(([name]) => name === SHELL_CACHE).map(([, path]) => path).sort();

test('staff gate on: a signed-out install caches the public shell, refusals are never stored, and signing in fills in the job shell', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const phone = gatedSite(), sw = harness({ network: phone.fetch });
  const imported = /importScripts\('([^']+)'\)/.exec(worker)[1];
  assert.equal((await phone.fetch(imported)).status, 200, 'the outbox the worker imports loads signed out, so a signed-out update check cannot fail');
  const install = await sw.dispatch('install');
  assert.deepEqual(install.settled.map(result => result.status), ['fulfilled'], 'refused staff files do not reject the install');
  assert.equal(sw.state.skipped, 1);
  assert.deepEqual(await shellKeys(sw), PUBLIC_KEYS);
  for (const key of STAFF_KEYS) assert.ok(phone.edge.some(([path, status]) => path === key && status === 401), `${key} was refused by the edge`);
  assert.match(await (await (await sw.context.caches.open(SHELL_CACHE)).match('/crew/offline.html')).text(), /You are offline/);
  await sw.dispatch('activate');
  assert.equal(sw.state.claimed, 1);

  const page = await sw.fetchEvent('/crew/job.html?jobId=synthetic-job-1', { mode: 'navigate' });
  assert.equal(page.response.type, 'opaqueredirect', 'the sign-in redirect goes back to the browser untouched');
  assert.deepEqual(phone.edge.at(-1), ['/crew/job.html?jobId=synthetic-job-1', 302, '/crew/?next=%2Fcrew%2Fjob.html%3FjobId%3Dsynthetic-job-1']);
  const script = await sw.fetchEvent('/crew/job.js?v=20260927pwa');
  assert.equal(script.response.status, 401);
  assert.equal(await script.response.text(), 'Sign in required.\n');
  assert.deepEqual(await shellKeys(sw), PUBLIC_KEYS, 'no redirect or 401 is stored');
  sw.state.online = false;
  assert.match(await (await sw.fetchEvent('/crew/job.html?jobId=synthetic-job-1', { mode: 'navigate' })).response.text(), /You are offline/, 'offline without a job shell shows the offline page');

  sw.state.online = true;
  await phone.signIn();
  const job = await sw.fetchEvent('/crew/job?jobId=synthetic-job-1', { mode: 'navigate' });
  assert.equal(job.response.status, 200);
  assert.equal(job.response.headers.get('cache-control'), 'private, no-store');
  for (const key of STAFF_KEYS.filter(key => key !== '/crew/job.html')) assert.equal((await sw.fetchEvent(key)).response.status, 200, key);
  assert.deepEqual(await shellKeys(sw), [...PUBLIC_KEYS, ...STAFF_KEYS].sort(), 'a signed-in load fills in the job shell at runtime');
  sw.state.online = false;
  const offline = await sw.fetchEvent('/crew/job.html?jobId=synthetic-job-2', { mode: 'navigate' });
  assert.equal(await offline.response.text(), readFileSync(new URL('../crew/job.html', import.meta.url), 'utf8'), 'Today’s work reloads offline from the signed-in copy');
});

test('staff gate on: a signed-in install caches the whole shell, pretty-URL redirects included, and never a sign-in page', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const phone = gatedSite();
  await phone.signIn();
  const sw = harness({ network: phone.fetch }), older = await sw.context.caches.open('egc-crew-shell-20260927pwa');
  await older.put('/crew/job.html', new Response('older build'));
  const install = await sw.dispatch('install');
  assert.deepEqual(install.settled.map(result => result.status), ['fulfilled']);
  assert.deepEqual(await shellKeys(sw), [...PUBLIC_KEYS, ...STAFF_KEYS].sort());
  assert.ok(phone.edge.some(([path, status, location]) => path === '/crew/job.html' && status === 308 && location === '/crew/job'), 'the job page arrived through the Pages pretty-URL redirect');
  const cached = await (await sw.context.caches.open(SHELL_CACHE)).match('/crew/job.html');
  assert.equal(await cached.text(), readFileSync(new URL('../crew/job.html', import.meta.url), 'utf8'));
  await sw.dispatch('activate');
  assert.deepEqual([...sw.stores.keys()], [SHELL_CACHE], 'the bumped version replaces the older shell');

  // A fetch that the edge treats as a page load is redirected to the crew sign-in; following it must not store that page.
  const html = gatedSite({ accept: 'text/html' }), signedOut = harness({ network: html.fetch });
  assert.deepEqual((await signedOut.dispatch('install')).settled.map(result => result.status), ['fulfilled']);
  assert.ok(html.edge.some(([path, status, location]) => path === '/crew/job.html' && status === 302 && location === '/crew/?next=%2Fcrew%2Fjob.html'));
  assert.deepEqual(await shellKeys(signedOut), PUBLIC_KEYS);
});

test('a public shell file the install cannot get still fails the install, so a broken worker never replaces a working one', async () => {
  const sw = harness({ network: async input => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    return basic(url.pathname === '/crew/offline.html' ? new Response('down', { status: 503 }) : new Response(`network ${url.pathname}`));
  } });
  const install = await sw.dispatch('install');
  assert.deepEqual(install.settled.map(result => result.status), ['rejected']);
  assert.equal(sw.state.skipped, 0);
});
