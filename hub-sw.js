/* EGC Employee Hub service worker (HUB_OFFLINE_ENABLED, registered by employee-hub-screens.js with scope /).
   It keeps a device copy of the Hub's versioned static files (/employee-*.js|css?v=… and /app-touch.css?v=…) so an installed Hub still opens
   its screens on a weak or dropped connection. Pages (employee.html stays no-store), API responses, other origins,
   non-GET requests and unversioned files are never intercepted or cached; queued Hub posts live in the page's own
   IndexedDB queue (employee-offline-queue.js). */
'use strict';
const VERSION = '20260929hubpwa';
const CACHE_PREFIX = 'egc-hub-assets-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const CONFIG = '/api/hub-offline';
const ASSET = /^(?:\/employee-[A-Za-z0-9_-]+\.(?:js|css)|\/app-touch\.css)$/;
const VERSIONED = /^\?v=[A-Za-z0-9._-]{1,40}$/;
const NETWORK_WAIT = 6000;
let configCheckedAt = 0, retired = false, signOuts = 0;

// Only the 200 that was asked for is kept: never a sign-in redirect, a 401 from the staff gate (EGC_STAFF_PAGE_GATE),
// an error or another page. The gate's private, no-store is for HTTP caches; this cache is the device's own copy, filled
// only by signed-in loads.
const keep = response => response.status === 200 && response.type === 'basic' && !response.redirected;
const offline = () => new Response('The Hub is offline and this file is not saved on this device.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

// The file cache is made when this worker activates and is only ever written while it exists: once a switched-off page
// or the kill switch deletes it, this worker (still serving the pages it controls until they close) never recreates it,
// and a file that was still loading when it was retired is not left behind either. A Hub sign-out clears the copies
// (employee-hub-screens.js forgetOfflineFiles) so a signed-out load offline gets no staff file from them: a file that
// was still loading when the page signed out is not kept, and copies are kept again from the next signed-in load.
async function store(key, response, started) {
  if (retired || started !== signOuts || !await caches.has(CACHE)) return;
  const cache = await caches.open(CACHE), path = key.split('?')[0];
  await cache.put(key, response);
  if (retired) return removeCaches();
  if (started !== signOuts) return cache.delete(key);
  // One copy per file: an older ?v= build is dropped once a newer one is saved.
  for (const request of await cache.keys()) { const url = new URL(request.url); if (url.pathname === path && url.pathname + url.search !== key) await cache.delete(request); }
}

async function removeCaches(keepName = '') {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== keepName).map(name => caches.delete(name)));
}

// A definite HUB_OFFLINE_ENABLED off removes the file cache and this worker even if no Hub page runs again; an
// unreachable or unverified answer keeps it. Checked on activation and at most every five minutes after.
async function killSwitch(force = false) {
  if (!force && Date.now() - configCheckedAt < 300000) return false;
  configCheckedAt = Date.now();
  let config;
  try {
    const response = await fetch(new Request(CONFIG, { cache: 'no-store', credentials: 'same-origin' }));
    if (!response.ok) return false;
    config = await response.json();
  } catch { return false; }
  if (config?.ok !== true || config.enabled !== false) return false;
  retired = true;
  await removeCaches();
  await self.registration.unregister();
  return true;
}

// Every online load asks the network first, with the saved copy's ETag, so a file changed without a ?v= bump is never
// served stale; an unchanged file answers 304 and costs no download. The saved copy answers only when the network fails
// or stalls, and a stalled request still refreshes it in the background.
function versioned(key) {
  const started = signOuts, saved = caches.match(key, { cacheName: CACHE }).catch(() => undefined);
  const network = saved.then(copy => fetch(new Request(key, { credentials: 'same-origin', cache: 'no-store', headers: copy?.headers.has('ETag') ? { 'If-None-Match': copy.headers.get('ETag') } : {} })));
  const stored = network.then(response => keep(response) ? store(key, response.clone(), started) : null);
  const answer = saved.then(async copy => {
    const fresh = network.then(response => response.status === 304 && copy ? copy.clone() : response);
    try { return copy ? await Promise.race([fresh, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Network is slow')), NETWORK_WAIT))]) : await fresh; }
    catch { return copy || offline(); }
  });
  return { answer, settled: Promise.allSettled([stored]) };
}

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await removeCaches(CACHE);
    if (await killSwitch(true)) return;
    await caches.open(CACHE);
    await self.clients.claim();
  })());
});

// A switched-off Hub page retires this worker, and waits for the answer, before it unregisters it and deletes the file
// cache (employee-hub-screens.js removeOffline). A signing-out page says so, and waits, before it clears the copies.
self.addEventListener('message', event => {
  const type = event.data?.type;
  if (type === 'egc-hub-offline-retire') retired = true;
  else if (type === 'egc-hub-offline-signout') signOuts++;
  else return;
  event.ports?.[0]?.postMessage({ ok: true });
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || request.mode === 'navigate' || url.origin !== self.location.origin || !ASSET.test(url.pathname) || !VERSIONED.test(url.search)) return;
  const { answer, settled } = versioned(url.pathname + url.search);
  event.respondWith(answer);
  event.waitUntil(settled.then(() => killSwitch()).catch(() => {}));
});
