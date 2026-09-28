/* EGC crew service worker. It keeps only the static Today's work shell for
   offline reloads. API responses, customer data and non-GET requests are never
   intercepted or cached; queued work lives in the explicit field outbox. */
'use strict';
const VERSION = '20260928photoq';
const CACHE_PREFIX = 'egc-crew-shell-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const CONFIG = '/crew/sw-config.json';
const PAGES = { '/crew/job.html': '/crew/job.html', '/crew/job': '/crew/job.html', '/crew/offline.html': '/crew/offline.html', '/crew/offline': '/crew/offline.html' };
const ASSETS = ['/crew/job.css?v=20260928photoq', '/crew/job.js?v=20260928photoq', '/crew/field-outbox.js?v=20260928photoq', '/crew/field-expenses.css?v=20260928fun19', '/crew/field-expenses.js?v=20260928fun19', '/crew/job-photo-sharing.css?v=20260927photo', '/crew/job-photo-sharing.js?v=20260928photo', '/crew/manifest.webmanifest'];
const ASSET_PATHS = new Set(ASSETS.map(asset => asset.split('?')[0]));
// With EGC_STAFF_PAGE_GATE=on the edge refuses the job page and its files without a Hub session (staff-paths.js). Every
// install needs this public part; the rest is cached when the install, or a later signed-in load, receives it.
const PUBLIC_SHELL = new Set(['/crew/offline.html', '/crew/field-outbox.js', '/crew/manifest.webmanifest']);
const NETWORK_WAIT = 6000;
let configCheckedAt = 0;

importScripts('/crew/field-outbox.js?v=20260928photoq');

// Pretty-URL redirects (/crew/job.html -> /crew/job) must not be replayed as a
// redirected response, which browsers refuse for navigations.
async function clean(response) {
  if (!response.redirected) return response;
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

// A shell file is kept only as the 200 it asked for (a pretty-URL redirect to the same page is fine), never a sign-in
// redirect, 401 or other page. The gate's private, no-store is for HTTP caches; this cache is the phone's own copy.
const pageOf = path => path.split('?')[0].replace(/\.html$/, '');
const shellResponse = (key, response) => response.status === 200 && response.type === 'basic' &&
  (!response.redirected || pageOf(new URL(response.url || '/', self.location.origin).pathname) === pageOf(key));

async function store(key, response) {
  const cache = await caches.open(CACHE), path = key.split('?')[0];
  await cache.put(key, await clean(response));
  // One copy per shell file: an older ?v= build is dropped once a newer one is saved.
  for (const request of await cache.keys()) { const url = new URL(request.url); if (url.pathname === path && url.pathname + url.search !== key) await cache.delete(request); }
}

async function precache() {
  const shell = [...new Set(Object.values(PAGES)), ...ASSETS];
  const responses = await Promise.all(shell.map(async key => {
    const response = await fetch(new Request(key, { cache: 'reload', credentials: 'same-origin' })).catch(() => null);
    // Read (or release) each body at once: an unread one keeps its connection busy and can stall the rest of the install.
    if (response && shellResponse(key, response)) return [key, new Response(await response.blob(), { status: 200, statusText: response.statusText, headers: response.headers })];
    await response?.body?.cancel().catch(() => {});
    if (PUBLIC_SHELL.has(key.split('?')[0])) throw new Error(`Crew shell file ${key} could not be cached.`);
    return null;
  }));
  for (const entry of responses) if (entry) await store(...entry);
}

async function removeCaches(keep = '') {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== keep).map(name => caches.delete(name)));
}

// Kill switch: /crew/sw-config.json {"enabled": false} removes the shell cache
// and unregisters this worker. An unreachable config keeps the worker running.
async function killSwitch(force = false) {
  if (!force && Date.now() - configCheckedAt < 300000) return false;
  configCheckedAt = Date.now();
  let config;
  try {
    const response = await fetch(new Request(CONFIG, { cache: 'no-store', credentials: 'same-origin' }));
    if (!response.ok) return false;
    config = await response.json();
  } catch { return false; }
  if (config?.enabled !== false) return false;
  await removeCaches();
  await self.registration.unregister();
  return true;
}

// Network first. The cached shell answers only when the network fails or
// stalls, and a fresh copy still replaces it in the background.
async function networkFirst(network, key, fallback) {
  const cache = await caches.open(CACHE), cached = key ? await cache.match(key) : null;
  try {
    if (!cached) return await network;
    return await Promise.race([network, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Network is slow')), NETWORK_WAIT))]);
  } catch {
    return cached || (fallback && await cache.match(fallback)) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await removeCaches(CACHE);
    if (!await killSwitch(true)) await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  // Only same-origin crew GETs are handled. /api/*, the kill-switch config and
  // every POST go straight to the network and are never stored.
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/crew/') || url.pathname === CONFIG) return;
  const navigation = request.mode === 'navigate';
  if (!navigation && !ASSET_PATHS.has(url.pathname)) return;
  const key = navigation ? PAGES[url.pathname] || '' : url.pathname + url.search;
  const network = fetch(request), saved = network.then(response => key && shellResponse(key, response) ? store(key, response.clone()) : null);
  event.waitUntil(saved.then(() => navigation && killSwitch()).catch(() => {}));
  event.respondWith(networkFirst(network, key, navigation ? '/crew/offline.html' : ''));
});

async function syncOutbox() {
  const outbox = self.EGCFieldOutbox.create({ locks: self.navigator?.locks });
  const result = await self.EGCFieldOutbox.replaySignedIn(outbox, self.EGCFieldOutbox.httpTransport(self.fetch.bind(self)));
  const windows = await self.clients.matchAll({ type: 'window' });
  windows.forEach(client => client.postMessage({ type: 'egc-field-outbox-changed', applied: result.applied.length, remaining: result.remaining }));
  // Ask the browser to retry later while the connection is still down.
  if (['network', 'transient'].includes(result.stopped?.reason)) throw new Error('Queued field work is waiting for a connection.');
}

self.addEventListener('sync', event => {
  if (event.tag === self.EGCFieldOutbox.SYNC_TAG) event.waitUntil(syncOutbox());
});
