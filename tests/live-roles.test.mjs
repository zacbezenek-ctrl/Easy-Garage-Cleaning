import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { HUB_ACCESS_HEADER, getHubSession, hubAccessStamp, verifiedHubAccessStamp } from '../functions/_lib/hub-session.js';
import { can } from '../functions/_lib/staff-roles.js';
import { employeeInvitationStore } from '../functions/_lib/employee-accounts.js';
import * as hubAuth from '../functions/api/hub-auth.js';
import { staffDirectoryHandlers } from '../functions/api/staff-directory.js';
import { employeeAccountsHandlers } from '../functions/api/employee-accounts.js';
import { onRequest as middleware } from '../functions/_middleware.js';
import { ORIGIN, cookieFor, jsonRequest, login, seedAccount, staffEnv, vaultFirestore } from './helpers/vault-fixture.mjs';

// LIVE-ROLES (owner 2026-10-21): "Let's not do that please the re sign in thing." A Staff directory role change keeps the
// person signed in. The server applies it to their next request (the session already re-reads the account), and their
// open pages follow the access stamp the middleware sends on every API answer (X-EGC-Access).
const ACCESS = { EGC_STAFF_ROLE_ACCESS: 'true', EGC_STAFF_DIRECTORY_ENABLED: 'true' };
const NOW = '2026-09-22T18:00:00.000Z';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const request = (cookie, path = '/api/hub-auth') => new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });

async function setRoles(env, ownerCookie, username, staffRoles) {
  const handlers = staffDirectoryHandlers({ now: () => new Date(NOW) });
  const listed = await (await handlers.get({ env, request: jsonRequest(`/api/staff-directory?username=${username}`, undefined, ownerCookie) })).json();
  const response = await handlers.post({ env, request: jsonRequest('/api/staff-directory', { action: 'set_roles', requestId: crypto.randomUUID(), username, expectedRevision: listed.people[0].revision, staffRoles }, ownerCookie) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function signedInSales(t) {
  const env = staffEnv(ACCESS), fire = vaultFirestore(t);
  await seedAccount(env, 'Rep.Live');
  const { cookie } = await login(env, 'Rep.Live');
  return { env, fire, cookie, owner: await cookieFor(env, 'ZacB') };
}

test('granting Sales applies to the same session on its next request: the walkthrough opens without a sign-in', async t => {
  const { env, cookie, owner } = await signedInSales(t);
  const before = await getHubSession(request(cookie), env);
  assert.equal(can(before, 'walkthrough.perform', env), false);
  const saved = await setRoles(env, owner, 'Rep.Live', ['crew', 'sales']);
  assert.deepEqual([saved.sessionsKept, Object.hasOwn(saved, 'sessionsRevoked')], [true, false]);
  const after = await getHubSession(request(cookie), env);
  assert.ok(after, 'the session is kept');
  assert.equal(can(after, 'walkthrough.perform', env), true, 'the server opens the walkthrough on the next request');
  const reported = await (await hubAuth.onRequestGet({ env, request: request(cookie) })).json();
  assert.ok(reported.capabilities.includes('walkthrough.perform'), '/api/hub-auth reports it to the page');
});

test('removing a role stops it on the server on the very next request, with no cache window', async t => {
  const { env, cookie, owner } = await signedInSales(t);
  await setRoles(env, owner, 'Rep.Live', ['sales']);
  assert.equal(can(await getHubSession(request(cookie), env), 'walkthrough.perform', env), true);
  await setRoles(env, owner, 'Rep.Live', ['crew']);
  const after = await getHubSession(request(cookie), env);
  assert.equal(after?.user, 'Rep.Live', 'the person stays signed in');
  assert.equal(can(after, 'walkthrough.perform', env), false, 'the removed role is refused at once');
  assert.deepEqual((await (await hubAuth.onRequestGet({ env, request: request(cookie) })).json()).capabilities.includes('walkthrough.perform'), false);
});

test('a role change costs no extra read: a session check is one account read before and after, and the stamp reads nothing', async t => {
  const { env, fire, cookie, owner } = await signedInSales(t);
  const reads = async action => { const start = fire.requests.length; await action(); return fire.requests.slice(start).map(entry => `${entry.method} ${decodeURIComponent(entry.url.pathname).split('/documents/')[1]}`); };
  const before = await reads(() => getHubSession(request(cookie), env));
  assert.equal(before.length, 1, 'one account document read, as today');
  await setRoles(env, owner, 'Rep.Live', ['crew', 'sales']);
  assert.deepEqual(await reads(() => getHubSession(request(cookie), env)), before, 'the same single read after the change');
  assert.deepEqual(await reads(async () => verifiedHubAccessStamp(request(cookie))), [], 'the stamp is kept from that read');
  // The middleware adds the header without a read of its own.
  const through = await reads(() => middleware({ env, request: request(cookie, '/api/staff-roles'), next: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }) }));
  assert.deepEqual(through, [], 'a request that never checked its session reads nothing and gets no stamp');
});

test('the middleware sends the stamp of the session the request checked, and the stamp changes exactly when access does', async t => {
  const { env, cookie, owner } = await signedInSales(t);
  const call = async (path = '/api/crew-jobs', check = true) => middleware({ env, request: request(cookie, path),
    next: async () => { if (check) await getHubSession(request(cookie, path), env); return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); } });
  await setRoles(env, owner, 'Rep.Live', ['crew', 'phone']);
  const first = (await call()).headers.get(HUB_ACCESS_HEADER);
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal((await call()).headers.get(HUB_ACCESS_HEADER), first, 'unchanged access, unchanged stamp');
  assert.equal((await call('/api/crew-jobs', false)).headers.get(HUB_ACCESS_HEADER), null, 'an earlier request\'s stamp is never reused');
  assert.equal((await middleware({ env, request: request(cookie, '/employee'), next: async () => { await getHubSession(request(cookie), env); return new Response('<p>', { headers: { 'Content-Type': 'text/plain' } }); } })).headers.get(HUB_ACCESS_HEADER), null, 'only API answers carry it');
  await setRoles(env, owner, 'Rep.Live', ['crew', 'phone', 'sales']);
  const granted = (await call()).headers.get(HUB_ACCESS_HEADER);
  assert.notEqual(granted, first, 'a granted role changes it');
  await setRoles(env, owner, 'Rep.Live', ['crew', 'phone']);
  assert.equal((await call()).headers.get(HUB_ACCESS_HEADER), first, 'back to the same roles, back to the same stamp');
  // What it covers: the account, the session role, business access, ownership and the stored roles (order-free).
  const base = { user: 'Rep.Live', role: 'crew', staffRoles: ['crew', 'sales'] };
  assert.equal(await hubAccessStamp(base), await hubAccessStamp({ ...base, staffRoles: ['sales', 'crew'], displayName: 'Renamed', hourlyRate: 40 }));
  assert.notEqual(await hubAccessStamp(base), await hubAccessStamp({ ...base, user: 'Other' }));
  assert.equal(await hubAccessStamp(null), '');
});

test('a disabled account still signs out at once: a rejected review ends the session', async t => {
  const { env, cookie, owner } = await signedInSales(t);
  const before = await employeeInvitationStore(env).read('Rep.Live');
  const handlers = employeeAccountsHandlers({ now: () => new Date(NOW), revocations: () => null });
  const response = await handlers.post({ env: { ...env, EGC_STAFF_PASSWORD_RESET: 'true' }, request: jsonRequest('/api/employee-accounts', { action: 'review', requestId: crypto.randomUUID(), username: 'Rep.Live', decision: 'rejected', reason: 'Synthetic departure' }, owner) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.notEqual((await employeeInvitationStore(env).read('Rep.Live')).account.sessionVersion, before.account.sessionVersion);
  assert.equal(await getHubSession(request(cookie), env), null, 'a rejected account is signed out everywhere');
});

test('re-approving an approved account with new roles keeps its sessions; only a status change ends them', async t => {
  const { env, cookie, owner } = await signedInSales(t);
  const before = await employeeInvitationStore(env).read('Rep.Live');
  const handlers = employeeAccountsHandlers({ now: () => new Date(NOW), revocations: () => null });
  const response = await handlers.post({ env: { ...env, EGC_STAFF_PASSWORD_RESET: 'true' }, request: jsonRequest('/api/employee-accounts', { action: 'review', requestId: crypto.randomUUID(), username: 'Rep.Live', decision: 'approved', staffRoles: ['sales'], hourlyRate: 21 }, owner) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await employeeInvitationStore(env).read('Rep.Live')).account.sessionVersion, before.account.sessionVersion);
  const session = await getHubSession(request(cookie), env);
  assert.deepEqual([session?.user, can(session, 'walkthrough.perform', env)], ['Rep.Live', true]);
});

// The crew pages' client (crew/hub-auth.js) in a VM: timers run at once so the settle wait does not slow the suite.
function crewBrowser(fetcher) {
  const store = () => { const map = new Map(); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map }; };
  const events = [], minted = [];
  const context = { sessionStorage: store(), localStorage: store(), fetch: fetcher, console, setTimeout: callback => { queueMicrotask(callback); return 1; },
    document: { readyState: 'loading', querySelector: () => null, getElementById: () => null, createElement: () => ({}) },
    location: { pathname: '/crew/' }, firebase: { auth: () => ({ signInWithCustomToken: async token => { minted.push(token); }, signOut: async () => {} }) },
    addEventListener() {}, dispatchEvent: event => events.push(event.type), Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Error, Promise, JSON, Number, String, Array, Math, Date };
  context.window = context;
  vm.runInNewContext(read('crew/hub-auth.js'), context);
  return { context, events, minted };
}
const answer = (body, stamp) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...(stamp ? { 'X-EGC-Access': stamp } : {}) } });
const flush = async () => { for (let index = 0; index < 40; index++) await new Promise(resolve => setImmediate(resolve)); };

test('crew pages: a changed stamp refreshes the capabilities, mints a new Firebase session and redraws, without signing out', async () => {
  let profile = { ok: true, user: 'Rep.Live', displayName: 'Rep', role: 'crew', roleAccess: true, capabilities: [] }, stamp = 'aaaaaaaaaaaaaaaa', authCalls = 0;
  const { context, events, minted } = crewBrowser(async url => {
    const path = String(url);
    if (path.includes('firebase-session')) return answer({ ok: true, token: `token-${minted.length + 1}` });
    if (path.includes('/api/hub-auth')) { authCalls += 1; return answer(profile, stamp); }
    return answer({ ok: true }, stamp);
  });
  const auth = context.EGCHubAuth;
  assert.equal(await auth.session(), 'Rep.Live');
  assert.equal(auth.canRunWalkthrough(), false);
  await auth.fetch('/api/crew-jobs');
  await flush();
  assert.deepEqual([authCalls, minted.length], [1, 1], 'an unchanged stamp asks nothing');
  // The owner adds Sales: the next answer carries a new stamp.
  profile = { ...profile, capabilities: ['schedule.book', 'walkthrough.perform'] }; stamp = 'bbbbbbbbbbbbbbbb';
  await auth.fetch('/api/crew-jobs');
  await flush();
  assert.equal(authCalls, 2, 'the page asks /api/hub-auth once');
  assert.equal(auth.canRunWalkthrough(), true, 'the walkthrough opens');
  assert.deepEqual([minted.length, context.sessionStorage.getItem('egc_access_stamp'), events.includes('egc:access-changed'), events.includes('egc:session-expired')], [2, stamp, true, false]);
  assert.equal(auth.profile().user, 'Rep.Live', 'still signed in');
  // Removing it again is picked up the same way (after the short recheck spacing).
  profile = { ...profile, capabilities: [] }; stamp = 'cccccccccccccccc';
  const realNow = Date.now; context.Date = class extends Date { static now() { return realNow() + 60000; } };
  await auth.fetch('/api/crew-jobs');
  await flush();
  assert.deepEqual([authCalls, auth.canRunWalkthrough()], [3, false]);
});

test('crew pages: a stamp for another account signed in elsewhere is not adopted here', async () => {
  let profile = { ok: true, user: 'Rep.Live', role: 'crew', capabilities: [] }, stamp = 'aaaaaaaaaaaaaaaa';
  const { context, minted } = crewBrowser(async url => String(url).includes('firebase-session') ? answer({ ok: true, token: 't' }) : answer(profile, stamp));
  await context.EGCHubAuth.session();
  profile = { ok: true, user: 'Someone.Else', role: 'manager', businessAccess: true, capabilities: ['dispatch.write'] }; stamp = 'dddddddddddddddd';
  await context.EGCHubAuth.fetch('/api/crew-jobs');
  await flush();
  assert.deepEqual([context.EGCHubAuth.profile().user, context.EGCHubAuth.can('dispatch.write'), minted.length], ['Rep.Live', false, 1]);
});

// The Hub page's own client (employee.html), as tests/employee-ui-errors.test.mjs runs it.
function hubPage(fetcher) {
  const values = () => { const map = new Map(); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; };
  const element = () => ({ value: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, addEventListener() {}, setAttribute() {}, focus() {} });
  const nodes = new Map(), events = [], toasts = [], minted = [], reloads = [];
  const context = { console, URLSearchParams, Date, Intl, Promise, Set, Map, Error, Event: class { constructor(type) { this.type = type; } }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    sessionStorage: values(), localStorage: values(), navigator: {}, location: { pathname: '/employee', search: '', reload() { reloads.push(1); } },
    setInterval: () => 1, clearInterval() {}, setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {},
    addEventListener() {}, dispatchEvent: event => events.push(event), showToast: message => toasts.push(message),
    document: { readyState: 'loading', body: element(), addEventListener() {}, querySelectorAll: () => [], querySelector: () => element(), getElementById: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); } },
    fetch: fetcher, firebase: { auth: () => ({ signInWithCustomToken: async token => { minted.push(token); }, signOut: async () => {} }) },
    showModeSelect() {}, bootDashboard() {}, _dataGeneration: 0, _dataUnsubscribers: [], _listenersStarted: false, _leadsTimer: null,
    jobsCache: [], custsCache: [], leadsCache: [], blockedDays: new Set(), blockedSlots: new Set() };
  context.window = context;
  const page = read('employee.html');
  vm.runInNewContext(page.slice(page.indexOf('let me = null;'), page.indexOf('async function sendBookingConfirmation')) + '\nglobalThis.ui={restoreHubSession,hubFetch};', context);
  return { context, api: context.ui, events, toasts, minted, reloads };
}

test('the Hub: a changed stamp keeps the session, stores the new capabilities, mints a new Firebase session and redraws', async () => {
  let profile = { ok: true, user: 'Rep.Live', displayName: 'Rep', role: 'crew', roleAccess: true, capabilities: [] }, stamp = 'aaaaaaaaaaaaaaaa', authCalls = 0;
  const hub = hubPage(async url => {
    const path = String(url);
    if (path.includes('firebase-session')) return answer({ ok: true, token: `token-${hub.minted.length + 1}` });
    if (path.includes('/api/hub-auth')) { authCalls += 1; return answer(profile, stamp); }
    return answer({ ok: true }, stamp);
  });
  await hub.api.restoreHubSession();
  assert.equal(hub.context.sessionStorage.getItem('egc_access_stamp'), stamp);
  await hub.api.hubFetch('/api/employee-hub');
  await flush();
  assert.equal(authCalls, 1);
  profile = { ...profile, capabilities: ['schedule.book', 'walkthrough.perform'] }; stamp = 'bbbbbbbbbbbbbbbb';
  await hub.api.hubFetch('/api/employee-hub');
  await flush();
  assert.equal(authCalls, 2);
  assert.deepEqual(JSON.parse(hub.context.sessionStorage.getItem('egc_capabilities')), ['schedule.book', 'walkthrough.perform']);
  assert.deepEqual([hub.minted.length, hub.context.sessionStorage.getItem('egc_access_stamp'), hub.context.sessionStorage.getItem('egc_u')], [2, stamp, 'Rep.Live']);
  assert.deepEqual(JSON.parse(JSON.stringify(hub.events.filter(event => event.type === 'egc:access-changed').map(event => event.detail))), [{ firebaseRestarted: true }]);
  assert.deepEqual(hub.toasts, ['Your Hub access was updated.']);
  assert.equal(hub.events.some(event => event.type === 'egc:signout'), false, 'nobody is signed out');
});

// A Hub page signed in as Rep.Live whose /api/hub-auth answers come from `auth` (stamp first, then the body).
async function hubWith(auth, { firebase = () => true } = {}) {
  const hub = hubPage(async url => {
    const path = String(url);
    if (path.includes('firebase-session')) return answer({ ok: true, token: 't' });
    if (path.includes('/api/hub-auth')) { const [stamp, body] = auth(); return answer(body, stamp); }
    return answer({ ok: true }, auth()[0]);
  });
  hub.context.firebase = { auth: () => ({ signInWithCustomToken: async token => { if (!firebase()) throw Object.assign(new Error('synthetic'), { code: 'auth/network-request-failed' }); hub.minted.push(token); }, signOut: async () => {} }) };
  await hub.api.restoreHubSession();
  return hub;
}
const later = (hub, ms) => { const now = Date.now(); hub.context.Date = class extends Date { static now() { return now + ms; } }; };
const crewProfile = { ok: true, user: 'Rep.Live', displayName: 'Rep', role: 'crew', roleAccess: true, businessAccess: false, capabilities: [] };

test('the Hub: business access turning on reloads the page when nothing is unsaved, and never shows business screens on crew data', async () => {
  let stamp = 'aaaaaaaaaaaaaaaa', body = crewProfile, safe = true;
  const hub = await hubWith(() => [stamp, body]);
  hub.context.EGCHubSafeToReload = () => safe;
  stamp = 'bbbbbbbbbbbbbbbb'; body = { ...crewProfile, role: 'manager', businessAccess: true, capabilities: ['dispatch.write'] };
  await hub.api.hubFetch('/api/employee-hub');
  await flush();
  assert.deepEqual([hub.reloads.length, hub.context.sessionStorage.getItem('egc_business_access'), hub.events.filter(event => event.type === 'egc:access-changed').length], [1, 'false', 0], 'reloaded; the old page never switched to business screens');
});

test('the Hub: with unsaved work it keeps the old screens, says so once and reloads on a later answer once it is safe', async () => {
  let stamp = 'aaaaaaaaaaaaaaaa', body = { ...crewProfile, role: 'manager', businessAccess: true, capabilities: ['dispatch.write'] }, safe = false;
  const hub = await hubWith(() => [stamp, body]);
  hub.context.EGCHubSafeToReload = () => safe;
  // Removal: a manager loses business access while a draft is open.
  stamp = 'cccccccccccccccc'; body = crewProfile;
  await hub.api.hubFetch('/api/employee-hub');
  await flush();
  assert.deepEqual([hub.reloads.length, hub.context.sessionStorage.getItem('egc_business_access'), hub.context.sessionStorage.getItem('egc_access_stamp')], [0, 'true', 'aaaaaaaaaaaaaaaa'], 'nothing reloaded and the stamp is not taken, so it is checked again');
  assert.deepEqual(hub.toasts, ['Your Hub access changed. Save or finish what is open, and the Hub reloads to apply it.']);
  later(hub, 31000);
  await hub.api.hubFetch('/api/employee-hub');
  await flush();
  assert.equal(hub.toasts.length, 1, 'the notice is shown once');
  safe = true; later(hub, 62000);
  await hub.api.hubFetch('/api/employee-hub');
  await flush();
  assert.equal(hub.reloads.length, 1, 'reloaded once nothing is unsaved');
});

test('the Hub and crew pages keep the old stamp when the new Firebase session fails, so a later answer tries again', async () => {
  let stamp = 'aaaaaaaaaaaaaaaa', body = crewProfile, firebaseUp = true;
  const hub = await hubWith(() => [stamp, body], { firebase: () => firebaseUp });
  stamp = 'bbbbbbbbbbbbbbbb'; body = { ...crewProfile, capabilities: ['walkthrough.perform'] }; firebaseUp = false;
  await hub.api.hubFetch('/api/employee-hub');
  await flush();
  assert.deepEqual([hub.context.sessionStorage.getItem('egc_access_stamp'), hub.toasts.length], ['aaaaaaaaaaaaaaaa', 0], 'no stamp and no "updated" notice after a failed restart');
  firebaseUp = true; later(hub, 31000);
  await hub.api.hubFetch('/api/employee-hub');
  await flush();
  assert.deepEqual([hub.context.sessionStorage.getItem('egc_access_stamp'), hub.toasts], [stamp, ['Your Hub access was updated.']]);
  // crew/hub-auth.js does the same.
  let crewStamp = 'aaaaaaaaaaaaaaaa', crewBody = crewProfile, crewUp = true;
  const crew = crewBrowser(async url => String(url).includes('firebase-session') ? answer({ ok: true, token: 't' }) : answer(crewBody, crewStamp));
  crew.context.firebase = { auth: () => ({ signInWithCustomToken: async () => { if (!crewUp) throw new Error('synthetic'); }, signOut: async () => {} }) };
  await crew.context.EGCHubAuth.session();
  crewStamp = 'bbbbbbbbbbbbbbbb'; crewBody = { ...crewProfile, capabilities: ['walkthrough.perform'] }; crewUp = false;
  await crew.context.EGCHubAuth.fetch('/api/crew-jobs');
  await flush();
  assert.equal(crew.context.sessionStorage.getItem('egc_access_stamp'), 'aaaaaaaaaaaaaaaa');
});

test('Knock: a stamp change keeps an admin screen and its unsaved form; only a changed admin flag or rep status redraws it', () => {
  const source = read('crew/knock-app.js'), start = source.indexOf('export function accessRedraw');
  const context = {};
  vm.runInNewContext(source.slice(start, source.indexOf('\n}\n', start) + 3).replace('export function', 'function') + 'globalThis.accessRedraw = accessRedraw;', context);
  const { accessRedraw } = context;
  const admin = { admin: true, status: 'active' };
  assert.equal(accessRedraw({ onAdmin: true, before: admin, after: { ...admin } }), 'chrome', 'an admin editing settings keeps the form');
  assert.equal(accessRedraw({ onAdmin: true, before: admin, after: { admin: false, status: 'active' } }), 'screen', 'an admin who lost admin sees the lock');
  assert.equal(accessRedraw({ onAdmin: true, before: admin, after: { admin: true, status: 'inactive' } }), 'screen');
  assert.equal(accessRedraw({ onAdmin: false, before: admin, after: admin }), 'screen', 'other screens redraw');
  assert.match(source, /const redraw = accessRedraw\(\{ onAdmin: Boolean\(screens\.get\(S\.route\.name\)\?\.admin\), before, after: \{ admin: S\.viewer\?\.admin, status: S\.rep\?\.status \} \}\);\n\s+if \(redraw === 'screen'\) render\(\); else \{ renderChrome\(\); renderTabs\(\); \}/);
});

test('crew pages redraw on egc:access-changed: crew home re-runs its tools and jobs, the walkthrough says when access was removed', async () => {
  assert.match(read('crew/index.html'), /addEventListener\('egc:access-changed',\(\)=>\{if\(EGCHubAuth\.profile\(\)\.user\)openCrewHome\(\)\}\);/);
  const page = read('crew/gameplan.html'), line = page.split('\n').find(text => text.startsWith("window.addEventListener('egc:access-changed'"));
  const prepended = [], nodes = new Map(), listeners = {};
  let allowed = false;
  const node = () => ({ style: {}, children: [], setAttribute(name, value) { this[name] = value; }, append(...items) { this.children.push(...items); }, remove() { nodes.delete(this.id); } });
  const context = { EGCHubAuth: { canRunWalkthrough: () => allowed },
    window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    document: { body: { prepend: item => { prepended.push(item); nodes.set(item.id, item); } }, createElement: () => node(), getElementById: id => nodes.get(id) || null } };
  context.$ = id => context.document.getElementById(id);
  vm.runInNewContext(line, context);
  listeners['egc:access-changed']();
  const note = prepended[0];
  assert.deepEqual([note.id, note.role, note.children[0]], ['walkthrough-access-removed', 'alert', 'Walkthrough access was removed. Your draft is saved on this device. ']);
  listeners['egc:access-changed']();
  assert.equal(prepended.length, 1, 'shown once');
  allowed = true; listeners['egc:access-changed']();
  assert.equal(nodes.has('walkthrough-access-removed'), false, 'taken down when access comes back');
});

test('the Hub suite redraws its menu on egc:access-changed and Knock reloads its profile on a changed stamp', () => {
  const suite = read('employee-suite.js');
  assert.match(suite, /window\.addEventListener\('egc:access-changed',\(\)=>\{if\(!S\.installed\)return;const rail=\$\('#ops-rail \.ops-nav'\);if\(rail\)\{rail\.replaceChildren\(\);navList\(rail,visibleNav\(\)\)\}if\(!canView\(S\.active\)\)go\('my_day'\)/);
  const knock = read('crew/knock-app.js');
  assert.match(knock, /if \(response\.status !== 401\) noteAccess\(response, path\.split\('\?'\)\[0\]\);/);
  assert.match(knock, /const session = await api\('\/api\/hub-auth'\);\n\s+if \(String\(session\.user \|\| ''\)\.toLowerCase\(\) !== String\(user \|\| ''\)\.toLowerCase\(\)\) return;\n\s+const before = \{ admin: S\.viewer\?\.admin, status: S\.rep\?\.status \};\n\s+await loadServer\(\);/);
  assert.match(read('employee-staff.js'), /stays signed in\. The new roles apply in the Hub, the crew app and Knock within about a minute/);
  assert.doesNotMatch(read('employee-staff.js'), /Saving signs/);
});
