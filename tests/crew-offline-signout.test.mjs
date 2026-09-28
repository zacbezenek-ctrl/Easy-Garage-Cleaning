import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';

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
// Photos waiting on the phone (the outbox and the retired draft store) are
// private job evidence; other queued work keeps the F-PWA sign-out behaviour.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN5sAAAAASUVORK5CYII=';
const queued = (requestId, user, action, extra = {}) => ({ requestId, kind: 'field', user, jobId: 'job-a', seq: 1, state: 'queued', queuedAt: '2026-09-22T14:00:00.000Z', payload: { action, jobId: 'job-a', requestId, expectedRevision: 'rev-1', expectedUser: user, ...extra } });
function phoneWithPhotos() {
  const indexedDB = fakeIndexedDB(), seed = [];
  const put = (name, store, key, row) => new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(store, { keyPath: key });
    open.onsuccess = () => { const db = open.result, tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(row); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = reject; };
  });
  seed.push(put('egc-field-outbox', 'actions', 'requestId', queued('00000000-0000-4000-8000-000000000001', 'Crew.One', 'photo', { category: 'before', caption: 'Synthetic garage wall', dataUrl: PNG })));
  seed.push(put('egc-field-outbox', 'actions', 'requestId', queued('00000000-0000-4000-8000-000000000002', 'Crew.One', 'note', { body: 'Synthetic queued note', issue: false, visibility: 'crew' })));
  seed.push(put('egc-field-outbox', 'actions', 'requestId', queued('00000000-0000-4000-8000-000000000003', 'Crew.Two', 'photo', { category: 'after', caption: '', dataUrl: PNG })));
  seed.push(put('egc-field-photo-drafts', 'photos', 'id', { id: '00000000-0000-4000-8000-000000000004', user: 'Crew.One', jobId: 'job-a', category: 'after', caption: '', dataUrl: PNG }));
  return { indexedDB, ready: Promise.all(seed) };
}
async function assertPhotosCleared(indexedDB, local) {
  for (let attempt = 0; attempt < 200 && indexedDB.rows('egc-field-outbox', 'actions').some(row => row.payload.action === 'photo'); attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(indexedDB.rows('egc-field-outbox', 'actions').map(row => [row.requestId, row.payload.action]), [['00000000-0000-4000-8000-000000000002', 'note']], 'every waiting photo is deleted; other queued work stays');
  assert.deepEqual(indexedDB.stats.deleted, ['egc-field-photo-drafts'], 'the retired photo draft store is deleted');
  assert.equal(indexedDB.stats.closes, indexedDB.stats.opens, 'the sign-out closes its IndexedDB connections');
  assert.equal(local.getItem('egc-field:photos-cleared-at'), String(NOW), 'open job pages learn that photos were deleted');
}
// A session that merely ended (expired or revoked) keeps every waiting photo
// for the next sign-in and never tells job pages to delete theirs.
async function assertPhotosKept(indexedDB, local) {
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(indexedDB.rows('egc-field-outbox', 'actions').map(row => row.requestId).sort(), ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']);
  assert.equal(indexedDB.rows('egc-field-photo-drafts', 'photos').length, 1);
  assert.deepEqual(indexedDB.stats.deleted, []);
  assert.equal(local.getItem('egc-field:photos-cleared-at'), null);
}
const WARNING = '3 photos have not uploaded and will be deleted. Sign out anyway?';
function hubPage({ session, local, indexedDB, answer = true, status = 200 }) {
  const calls = [], events = [], asked = [], elements = new Map();
  const context = {
    console, URLSearchParams, Date: FixedDate, Intl, Promise, Set, Map, Error, Event, sessionStorage: session, localStorage: local, navigator: {}, indexedDB,
    location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener() {}, dispatchEvent: event => events.push(event.type), confirm: text => { asked.push(text); return answer; },
    fetch: async (url, init = {}) => { calls.push([url, init.method || 'GET']); const code = init.method === 'DELETE' ? 200 : status; return { ok: code < 400, status: code, json: async () => code < 400 ? { ok: true } : { ok: false, error: 'Sign in again.' } }; },
    firebase: { auth: () => ({ signOut: async () => {} }) },
    _dataGeneration: 0, _dataUnsubscribers: [], _listenersStarted: false, _leadsTimer: null, jobsCache: [], custsCache: [], leadsCache: [], blockedDays: new Set(), blockedSlots: new Set(),
    document: { body: { classList: { remove() {} } }, getElementById: id => { if (!elements.has(id)) elements.set(id, { style: {}, classList: { remove() {} }, value: '', textContent: '' }); return elements.get(id); }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  context.window = context;
  const page = read('employee.html');
  assert.ok(page.indexOf('// Business access comes from the signed server profile') >= 0 && page.indexOf('async function sendBookingConfirmation') > 0, 'the Hub auth script markers exist');
  assert.match(page, /<button class="btn-logout" onclick="signOutClicked\(\)">Sign out<\/button>/, 'the Sign out button is the explicit sign-out');
  vm.runInNewContext(page.slice(page.indexOf('// Business access comes from the signed server profile'), page.indexOf('async function sendBookingConfirmation')) + '\nglobalThis.ui={signOutClicked,doLogout,hubFetch};', context);
  return { ui: context.ui, calls, events, asked, elements };
}

test('choosing Sign out in the Employee Hub confirms, then retires Today’s work offline copies and waiting photos', async () => {
  const session = webStorage(crewCopies()), local = webStorage(), phone = phoneWithPhotos(); await phone.ready;
  const declined = hubPage({ session, local, indexedDB: phone.indexedDB, answer: false });
  await declined.ui.signOutClicked();
  assert.deepEqual(declined.asked, [WARNING], 'waiting photos, including the retired drafts, are counted before anything is deleted');
  assert.deepEqual(declined.calls, [], 'declining keeps the person signed in');
  assert.equal(session.values.has('egc-field:viewer'), true);
  await assertPhotosKept(phone.indexedDB, local);
  const hub = hubPage({ session, local, indexedDB: phone.indexedDB });
  await hub.ui.signOutClicked();
  assert.deepEqual(hub.asked, [WARNING]);
  assertRetired(session, local);
  assert.deepEqual(hub.events, ['egc:signout']);
  assert.deepEqual(hub.calls, [['/api/hub-auth', 'DELETE']]);
  await assertPhotosCleared(phone.indexedDB, local);
});

test('an expired Hub session keeps every photo waiting on the phone for the next sign-in', async () => {
  const session = webStorage(crewCopies()), local = webStorage(), phone = phoneWithPhotos(); await phone.ready;
  const hub = hubPage({ session, local, indexedDB: phone.indexedDB, status: 401 });
  await assert.rejects(hub.ui.hubFetch('/api/employee-hub?view=own-job-time'), error => error.code === 'HUB_AUTH_REQUIRED');
  assert.equal(hub.elements.get('login-error').textContent, 'Your work is saved. Sign in again to continue.');
  assert.deepEqual(hub.calls, [['/api/employee-hub?view=own-job-time', 'GET'], ['/api/hub-auth', 'DELETE']]);
  assert.deepEqual(hub.asked, [], 'an automatic sign-out never asks');
  assertRetired(session, local);
  await assertPhotosKept(phone.indexedDB, local);
  await hub.ui.doLogout();
  await assertPhotosKept(phone.indexedDB, local);
});

test('choosing to sign out from a crew page confirms, then retires the same copies and waiting photos before the session is closed', async () => {
  const session = webStorage(crewCopies()), local = webStorage(), calls = [], asked = [], phone = phoneWithPhotos(); await phone.ready;
  const context = {
    console, Date: FixedDate, Promise, Error, Set, Map, sessionStorage: session, localStorage: local, indexedDB: phone.indexedDB,
    fetch: async (url, init = {}) => { calls.push([url, init.method || 'GET', session.values.has('egc-field:viewer')]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, addEventListener() {} },
    addEventListener() {}, confirm: text => { asked.push(text); return asked.length > 1; },
  };
  context.window = context;
  vm.runInNewContext(read('crew/hub-auth.js'), context);
  assert.equal(await context.EGCHubAuth.confirmSignOut(), false, 'the person can keep the photos by staying signed in');
  assert.equal(await context.EGCHubAuth.confirmSignOut(), true);
  assert.deepEqual(asked, [WARNING, WARNING]);
  await assertPhotosKept(phone.indexedDB, local);
  await context.EGCHubAuth.signOut({ explicit: true });
  assertRetired(session, local);
  assert.deepEqual(calls, [['/api/hub-auth', 'DELETE', false]]);
  await assertPhotosCleared(phone.indexedDB, local);
  for (const page of ['crew/index.html', 'crew/prejob.html', 'crew/postjob.html', 'crew/gameplan.html']) assert.match(read(page), /if\(!await EGCHubAuth\.confirmSignOut\(\)\)return;await EGCHubAuth\.signOut\(\{explicit:true\}\);location\.reload\(\)/, `${page} signs out explicitly after confirming`);
  assert.match(read('copilot.html'), /onclick="doLogout\(\{explicit:true\}\)"/);
});

test('a crew session that ended on its own (Co-Pilot’s expired session) keeps waiting photos', async () => {
  const session = webStorage(crewCopies()), local = webStorage(), calls = [], phone = phoneWithPhotos(); await phone.ready;
  const context = { console, Date: FixedDate, Promise, Error, Set, Map, sessionStorage: session, localStorage: local, indexedDB: phone.indexedDB, fetch: async (url, init = {}) => { calls.push([url, init.method]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }, document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, addEventListener() {} }, addEventListener() {}, confirm: () => { throw new Error('an automatic sign-out never asks'); } };
  context.window = context;
  vm.runInNewContext(read('crew/hub-auth.js'), context);
  await context.EGCHubAuth.signOut();
  assertRetired(session, local);
  assert.deepEqual(calls, [['/api/hub-auth', 'DELETE']]);
  await assertPhotosKept(phone.indexedDB, local);
});

test('a sign-out on a phone that never queued photos asks nothing, creates no database and still closes the session', async () => {
  const indexedDB = fakeIndexedDB(), calls = [];
  const context = { console, Date: FixedDate, Promise, Error, Set, Map, sessionStorage: webStorage(), localStorage: webStorage(), indexedDB, fetch: async (url, init = {}) => { calls.push([url, init.method]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }, document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, addEventListener() {} }, addEventListener() {}, confirm: () => { throw new Error('nothing to confirm'); } };
  context.window = context;
  vm.runInNewContext(read('crew/hub-auth.js'), context);
  assert.equal(await context.EGCHubAuth.confirmSignOut(), true);
  await context.EGCHubAuth.signOut({ explicit: true });
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(indexedDB.stored.has('egc-field-outbox'), false, 'a manager desktop is not given an empty outbox database');
  assert.equal(indexedDB.stats.opens, 0);
  assert.deepEqual(calls, [['/api/hub-auth', 'DELETE']]);
  const hub = hubPage({ session: webStorage(), local: webStorage(), indexedDB });
  await hub.ui.signOutClicked();
  for (let attempt = 0; attempt < 20; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(hub.asked, []); assert.equal(indexedDB.stored.has('egc-field-outbox'), false); assert.equal(indexedDB.stats.opens, 0);
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
