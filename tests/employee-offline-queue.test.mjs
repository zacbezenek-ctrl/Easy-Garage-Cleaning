import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { createDocument, hubPage } from './helpers/hub-dom.mjs';
import { vaultFirestore, staffEnv, cookieFor, jsonRequest, ROOT } from './helpers/vault-fixture.mjs';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import * as employeeHub from '../functions/api/employee-hub.js';
import * as hubAuth from '../functions/api/hub-auth.js';

// HUB-PWA: the Employee Hub's on-device queue for its own time-clock and chat posts (employee-offline-queue.js).
const source = readFileSync(new URL('../employee-offline-queue.js', import.meta.url), 'utf8');
const NOW = '2026-09-22T18:00:00.000Z';
const PATH = '/api/employee-hub';
const at = minutes => new Date(Date.parse(NOW) + minutes * 60000).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
const idle = () => new Promise(resolve => setTimeout(resolve, 0));
let counter = 0;
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
// Every clock in this file is injected; the queue never reads the real one.
const clock = (start = NOW) => { let tick = Date.parse(start); return () => new Date(tick++); };
const point = { lat: 40.58, lng: -105.08, accuracy: 5, capturedAt: NOW };
const STORE = ['egc-hub-offline', 'requests'];

// The exact payloads employee-suite.js sends through peopleSet (opsClockIn/opsClockOut/opsStartBreak/opsEndBreak/opsSendChat).
// CREW-TIME: a clock-in carries its one position (hub_single_fix) and no trail.
const hubClockIn = (user, time = NOW) => ({ id: 'time-crewone-1', employee: user, employeeName: 'Synthetic Crew', role: 'crew', payType: 'hourly', hourlyRate: 20, clockInAt: time, clockOutAt: '', status: 'active', approvalStatus: 'open', jobId: '', jobLabel: '', locationTracking: true, locationConsentAt: time, locationStatus: 'hub_single_fix', lastLocation: point, locationUpdatedAt: time, breaks: [], createdAt: time, updatedAt: time });
const hubClockOut = (time = NOW) => ({ clockOutAt: time, status: 'submitted', approvalStatus: 'pending', hours: 2, grossEstimate: 40, locationTracking: false, locationStatus: 'stopped', updatedAt: time });
const hubMessage = (user, body, jobId = '') => ({ id: 'message-crewone-1', jobId, body, sender: user, senderName: 'Synthetic Crew', createdAt: NOW, updatedAt: NOW, status: 'active' });

function load(extra = {}) {
  const events = {};
  const context = { console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, Promise, JSON, Date, URL, Error, TypeError, Map, Set, Intl, Response, AbortController, crypto,
    addEventListener: (name, listener) => (events[name] ||= []).push(listener), ...extra };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'employee-offline-queue.js' });
  const fire = name => { for (const listener of events[name] || []) listener({ type: name }); };
  return { api: context.EGCHubOffline, context, events, fire };
}

function action(user, collection, data, recordId = `${collection}-${counter + 1}`, queuedAt) {
  const requestId = id();
  return { requestId, user, path: PATH, label: collection, kind: collection === 'timeEntries' ? 'clock' : 'message', ...(queuedAt ? { queuedAt } : {}), body: JSON.stringify({ collection, id: recordId, data, requestId, expectedUser: user }) };
}

// A transport that records each body it is handed and answers from a script (a reply object, or an Error to throw).
function wire(script = () => ({ status: 200, data: { ok: true, record: {} } })) {
  const calls = []; let active = 0, overlap = false;
  const transport = async (path, body) => {
    active++; if (active > 1) overlap = true;
    calls.push({ path, body });
    try { await new Promise(resolve => setTimeout(resolve, 1)); const outcome = await script(JSON.parse(body), calls.length); if (outcome instanceof Error) throw outcome; return outcome; }
    finally { active--; }
  };
  return { transport, calls, get overlap() { return overlap; } };
}

function queue(options = {}) {
  const loaded = load(), indexedDB = options.indexedDB || fakeIndexedDB();
  return { ...loaded, indexedDB, box: loaded.api.create({ store: loaded.api.idbStore(indexedDB), now: clock(), locks: options.locks }) };
}

test('queued Hub posts replay oldest first, one at a time, each with its original request ID and byte-identical body', async () => {
  const { box, indexedDB } = queue();
  const queued = [action('Crew.One', 'timeEntries', hubClockOut(), 'time-crewone-1'), action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic on my way')), action('Crew.One', 'jobMessages', hubMessage('Crew.One', 'Synthetic gate code works', 'job-1'))];
  for (const item of queued) await box.enqueue(item);
  assert.deepEqual(indexedDB.rows(...STORE).map(row => [row.seq, row.requestId]).sort(), queued.map((item, index) => [index + 1, item.requestId]), 'every action is on the device before anything is sent');
  const line = wire(), result = await box.flush({ user: 'crew.one', transport: line.transport });
  assert.deepEqual(line.calls.map(call => call.body), queued.map(item => item.body), 'the bodies sent are the stored bodies, in queue order');
  assert.deepEqual(line.calls.map(call => JSON.parse(call.body).requestId), queued.map(item => item.requestId));
  assert.ok(line.calls.every(call => call.path === PATH));
  assert.equal(line.overlap, false, 'no two requests are in flight at once');
  assert.deepEqual(plain(result.applied.map(entry => entry.item.requestId)), queued.map(item => item.requestId));
  assert.equal(result.stopped, null); assert.equal(result.remaining, 0);
  assert.deepEqual(indexedDB.rows(...STORE), []);
});

test('a 4xx is the server’s answer: the action is dropped and the next is sent; a 5xx keeps it and later actions wait behind it', async () => {
  const { box, indexedDB } = queue(), queued = ['first', 'second', 'third'].map(text => action('Crew.One', 'teamMessages', hubMessage('Crew.One', `Synthetic ${text}`)));
  for (const item of queued) await box.enqueue(item);
  const failing = wire((body, call) => call === 1 ? { status: 403, data: { ok: false, error: 'This job room is limited to assigned crew' } } : { status: 503, data: { ok: false, error: 'Employee Hub storage failed' } });
  const first = await box.flush({ user: 'Crew.One', transport: failing.transport });
  assert.deepEqual(failing.calls.map(call => call.body), [queued[0].body, queued[1].body], 'the third action was not sent past the kept one');
  assert.deepEqual(plain(first.dropped.map(entry => [entry.item.requestId, entry.status, entry.data.error])), [[queued[0].requestId, 403, 'This job room is limited to assigned crew']]);
  assert.deepEqual(plain(first.stopped && { id: first.stopped.item.requestId, status: first.stopped.status, reason: first.stopped.reason }), { id: queued[1].requestId, status: 503, reason: 'server' });
  assert.equal(first.remaining, 2);
  const kept = indexedDB.rows(...STORE).find(row => row.requestId === queued[1].requestId);
  assert.deepEqual([kept.attempts, kept.lastStatus, kept.waiting, kept.body], [1, 503, 'server', queued[1].body]);
  const healthy = wire(), second = await box.flush({ user: 'Crew.One', transport: healthy.transport });
  assert.deepEqual(healthy.calls.map(call => call.body), [queued[1].body, queued[2].body], 'the kept action retries unchanged, then the one behind it');
  assert.equal(second.remaining, 0); assert.deepEqual(indexedDB.rows(...STORE), []);
});

test('no reply, 401, 408, 429, a lost write race, another signed-in account, a 5xx and an unreadable or unconfirmed 2xx all keep the action; its retry repeats the same request', async () => {
  const cases = [['no reply', Object.assign(new TypeError('Failed to fetch'), { status: 0 }), 'network'], ['sign-in', { status: 401, data: { ok: false, error: 'Sign in required' } }, 'auth'],
    ['timeout', { status: 408, data: null }, 'server'], ['rate limit', { status: 429, data: null }, 'server'], ['server error', { status: 500, data: { ok: false } }, 'server'],
    ['write race', { status: 409, data: { ok: false, code: 'EMPLOYEE_HUB_WRITE_CONFLICT', error: 'Your timecard changed while saving. Refresh and retry.' } }, 'server'],
    ['another account', { status: 409, data: { ok: false, code: 'EMPLOYEE_HUB_ACCOUNT_CHANGED', error: 'This action was saved on this device by another account.' } }, 'account'],
    ['cut-off reply', { status: 200, data: null }, 'unknown'], ['unconfirmed success', { status: 200, data: { ok: false } }, 'unknown']];
  for (const [label, reply, reason] of cases) {
    const { box, indexedDB } = queue(), item = action('Crew.One', 'timeEntries', hubClockOut(), 'time-crewone-1');
    await box.enqueue(item);
    const lost = wire(() => reply), kept = await box.flush({ user: 'Crew.One', transport: lost.transport });
    assert.equal(kept.stopped?.reason, reason, label); assert.equal(kept.remaining, 1, label);
    assert.equal(indexedDB.rows(...STORE)[0].attempts, 1, label);
    const later = wire(), applied = await box.flush({ user: 'Crew.One', transport: later.transport });
    assert.deepEqual([...lost.calls, ...later.calls].map(call => call.body), [item.body, item.body], `${label}: exactly the same request is retried`);
    assert.equal(applied.applied.length, 1, label); assert.equal(applied.remaining, 0, label);
  }
  const { api } = load();
  for (const [status, data, expected] of [[204, { ok: true }, 'applied'], [400, {}, 'refused'], [403, {}, 'refused'], [404, {}, 'refused'], [409, {}, 'refused'], [409, { code: 'EMPLOYEE_TIMECARD_DEVICE_TIME' }, 'refused'], [409, { code: 'EMPLOYEE_HUB_WRITE_CONFLICT' }, 'server'], [409, { code: 'EMPLOYEE_HUB_ACCOUNT_CHANGED' }, 'account'], [413, {}, 'refused'], [302, null, 'unknown'], [0, null, 'network']]) assert.equal(api.classify({ status, data }), `${expected}`, `${status} ${data?.code || ''}`);
});

test('only the signed-in account’s actions are sent, a request ID is stored once, and the queue survives a reload', async () => {
  const indexedDB = fakeIndexedDB(), { box } = queue({ indexedDB }), mine = action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic mine')), theirs = action('Crew.Two', 'teamMessages', hubMessage('Crew.Two', 'Synthetic theirs'));
  await box.enqueue(mine); await box.enqueue(theirs); await box.enqueue({ ...mine });
  assert.equal(indexedDB.rows(...STORE).length, 2, 'enqueueing the same request ID again keeps one copy');
  await assert.rejects(box.enqueue({ ...mine, requestId: id() }), error => error.code === 'HUB_OFFLINE_INVALID', 'the body must carry the item’s own request ID');
  await assert.rejects(box.enqueue({ ...theirs, path: '/api/crew-jobs' }), error => error.code === 'HUB_OFFLINE_INVALID');
  await assert.rejects(box.enqueue({ ...theirs, user: 'Crew.One' }), error => error.code === 'HUB_OFFLINE_INVALID', 'the body must name the account that saved it');
  const reloaded = load().api.create({ store: load().api.idbStore(indexedDB), now: clock() });
  assert.deepEqual(plain((await reloaded.items('crew.one')).map(item => item.requestId)), [mine.requestId], 'a new page sees what an earlier one kept');
  const line = wire(), result = await reloaded.flush({ user: 'Crew.One', transport: line.transport });
  assert.deepEqual(line.calls.map(call => call.body), [mine.body]);
  assert.equal(result.remaining, 0);
  assert.deepEqual(indexedDB.rows(...STORE).map(row => row.user), ['Crew.Two'], 'another account’s action stays on the device, unsent');
  assert.deepEqual(plain(await reloaded.flush({ user: '', transport: line.transport })), { applied: [], dropped: [], stopped: null, remaining: 0 });
});

test('Web Locks keep two Hub tabs from replaying the same queue at once, so each action is sent exactly once', async () => {
  let chain = Promise.resolve(), held = 0;
  const locks = { request(name, task) { assert.equal(name, 'egc-hub-offline'); const run = chain.then(async () => { held++; try { return await task(); } finally { held--; } }); chain = run.catch(() => {}); return run; } };
  const indexedDB = fakeIndexedDB(), tabA = queue({ indexedDB, locks }), tabB = queue({ indexedDB, locks }), queued = [1, 2, 3].map(n => action('Crew.One', 'teamMessages', hubMessage('Crew.One', `Synthetic ${n}`)));
  for (const item of queued) await tabA.box.enqueue(item);
  const line = wire(() => { assert.equal(held, 1, 'a replay runs only while holding the lock'); return { status: 200, data: { ok: true } }; });
  const [a, b] = await Promise.all([tabA.box.flush({ user: 'Crew.One', transport: line.transport }), tabB.box.flush({ user: 'Crew.One', transport: line.transport })]);
  assert.deepEqual(line.calls.map(call => call.body), queued.map(item => item.body));
  assert.equal(line.overlap, false);
  assert.equal(a.applied.length + b.applied.length, 3); assert.deepEqual(indexedDB.rows(...STORE), []);
});

test('Discard while a request is out is final: a failed reply does not bring the action back', async () => {
  const { box, indexedDB } = queue(), item = action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic discard me'));
  await box.enqueue(item);
  const line = wire(async () => { await box.remove(item.requestId); return { status: 503, data: null }; });
  const result = await box.flush({ user: 'Crew.One', transport: line.transport });
  assert.equal(result.stopped.reason, 'server'); assert.equal(result.remaining, 0);
  assert.deepEqual(indexedDB.rows(...STORE), []);
});

test('only the viewer’s own clock actions and chat messages are queued; location updates, approvals and every other save are not', () => {
  const { api } = load(), user = 'Crew.One', body = (collection, data, recordId = 'time-crewone-1') => ({ collection, id: recordId, data });
  const recognized = [
    [body('timeEntries', hubClockIn(user)), 'clock_in', 'Clock in'],
    [body('timeEntries', hubClockOut()), 'clock_out', 'Clock out'],
    [body('timeEntries', { breaks: [{ startAt: at(-60), endAt: at(-45) }, { startAt: NOW, endAt: '' }], updatedAt: NOW }), 'break_start', 'Start break'],
    [body('timeEntries', { breaks: [{ startAt: at(-10), endAt: NOW }], updatedAt: NOW }), 'break_end', 'End break'],
    [body('teamMessages', hubMessage(user, 'Synthetic hello'), 'message-crewone-1'), 'message', 'Crew chat message'],
    [body('jobMessages', hubMessage(user, 'Synthetic gate', 'job-1'), 'message-crewone-2'), 'message', 'Job room message'],
  ];
  for (const [payload, op, label] of recognized) assert.deepEqual(plain(api.describe(PATH, payload, user)), { kind: op === 'message' ? 'message' : 'clock', op, label }, op);
  const ignored = [
    [PATH, body('timeEntries', { lastLocation: point, locationTrail: [point], locationStatus: 'tracking', locationUpdatedAt: NOW })],
    [PATH, body('timeEntries', { locationStatus: 'unavailable', locationError: 'Synthetic denied', locationUpdatedAt: NOW })],
    [PATH, body('timeEntries', { approvalStatus: 'approved', approvedBy: 'ZacB', approvedAt: NOW, updatedAt: NOW })],
    [PATH, body('timeEntries', { ...hubClockOut(), employee: 'Crew.Two' })],
    [PATH, body('timeEntries', hubClockIn('Crew.Two'))],
    [PATH, body('teamMessages', { ...hubMessage(user, '   ') })],
    [PATH, body('profiles', { lastSeenAt: NOW }, 'crew.one')],
    [PATH, body('messageReads', { employee: user, channel: 'team', lastReadAt: NOW }, 'read-crewone-team')],
    [PATH, body('requests', { type: 'time_off', employee: user }, 'request-1')],
    ['/api/crew-jobs', { action: 'send_customer_message', jobId: 'job-1', body: 'Synthetic customer text' }],
    [PATH, { collection: 'timeEntries', id: '', data: hubClockOut() }],
  ];
  for (const [path, payload] of ignored) assert.equal(api.describe(path, payload, user), null, JSON.stringify(payload).slice(0, 80));
});

test('a queued body carries its request ID and account; a crew clock action also carries the time the Hub showed, a manager’s does not; every queued break carries its request ID', () => {
  const { api } = load(), requestId = id(), now = () => new Date(at(5));
  const message = { collection: 'teamMessages', id: 'message-crewone-1', data: hubMessage('Crew.One', 'Synthetic hello') };
  assert.deepEqual(plain(api.prepare(message, api.describe(PATH, message, 'Crew.One'), { requestId, user: 'Crew.One', crew: true, now })), { ...message, requestId, expectedUser: 'Crew.One' });
  const out = { collection: 'timeEntries', id: 'time-crewone-1', data: hubClockOut(at(-3)) };
  assert.deepEqual(plain(api.prepare(out, api.describe(PATH, out, 'Crew.One'), { requestId, user: 'Crew.One', crew: true, now })), { ...out, requestId, expectedUser: 'Crew.One', data: { ...out.data, deviceCapturedAt: at(-3) } });
  assert.deepEqual(plain(api.prepare(out, api.describe(PATH, out, 'Crew.One'), { requestId, user: 'Crew.One', crew: true, captured: false, now })), { ...out, requestId, expectedUser: 'Crew.One' }, 'the first attempt, sent live, leaves the device time out');
  assert.deepEqual(plain(api.prepare(out, api.describe(PATH, out, 'ZacB'), { requestId, user: 'ZacB', crew: false, now })), { ...out, requestId, expectedUser: 'ZacB' }, 'a manager’s clock times are already in the body');
  const into = { collection: 'timeEntries', id: 'time-crewone-1', data: hubClockIn('Crew.One', at(-2)) };
  assert.equal(api.prepare(into, api.describe(PATH, into, 'Crew.One'), { requestId, crew: true, now }).data.deviceCapturedAt, at(-2));
  const earlier = { startAt: at(-60), endAt: at(-45), startRequestId: 'x' }, start = { collection: 'timeEntries', id: 'time-crewone-1', data: { breaks: [earlier, { startAt: at(-1), endAt: '' }], updatedAt: at(-1) } };
  assert.deepEqual(plain(api.prepare(start, api.describe(PATH, start, 'Crew.One'), { requestId, crew: true, now }).data), { breaks: [earlier, { startAt: at(-1), endAt: '', requestId }], updatedAt: at(-1), deviceCapturedAt: at(-1) });
  assert.deepEqual(plain(api.prepare(start, api.describe(PATH, start, 'Crew.One'), { requestId, crew: true, captured: false, now }).data), { breaks: [earlier, { startAt: at(-1), endAt: '', requestId }], updatedAt: at(-1) }, 'a live break still carries its request ID');
  const end = { collection: 'timeEntries', id: 'time-crewone-1', data: { breaks: [{ startAt: at(-9), endAt: 'shown-later' }], updatedAt: at(-1) } };
  assert.equal(api.prepare(end, api.describe(PATH, end, 'Crew.One'), { requestId, crew: true, now }).data.deviceCapturedAt, at(5), 'an unreadable shown time falls back to the injected clock');
  // A manager's break carries its request ID too (the server records it once by that ID), with the manager's own times only.
  const managerStart = { collection: 'timeEntries', id: 'time-zacb-1', data: { breaks: [earlier, { startAt: at(-1), endAt: '' }], updatedAt: at(-1) } };
  assert.deepEqual(plain(api.prepare(managerStart, api.describe(PATH, managerStart, 'ZacB'), { requestId, user: 'ZacB', crew: false, now })), { ...managerStart, requestId, expectedUser: 'ZacB', data: { breaks: [earlier, { startAt: at(-1), endAt: '', requestId }], updatedAt: at(-1) } });
  const managerIn = { collection: 'timeEntries', id: 'time-zacb-1', data: hubClockIn('ZacB', at(-2)) };
  assert.deepEqual(plain(api.prepare(managerIn, api.describe(PATH, managerIn, 'ZacB'), { requestId, user: 'ZacB', crew: false, now })), { ...managerIn, requestId, expectedUser: 'ZacB' });
});

// ── The page side: switch, send() for peopleSet, replay triggers and the Pending sync chip ──

// net.user is the account the tab shows (sessionStorage egc_u); net.account, when set, is the one the cookie holds now.
// The switch-on check (an empty pass) settles before the test acts, as it does long before a tap on a real page.
// serve, when given, answers every request (the real Pages Functions behind one cookie).
async function page({ online = true, user = 'Crew.One', crew = true, indexedDB = fakeIndexedDB(), enabled = true, reply, store, serve, extra = {} } = {}) {
  const document = createDocument(), toasts = [], net = { online, calls: [], user, account: null };
  const answer = reply || (async () => Response.json({ ok: true, record: { id: 'saved' } }));
  const loaded = load({ document, ...extra });
  const box = loaded.api.create({ store: store ? store(loaded.api.idbStore(indexedDB)) : loaded.api.idbStore(indexedDB), now: clock() });
  const posts = () => net.calls.filter(call => call.init?.method === 'POST');
  const hub = loaded.api.controller({ document, queue: box, online: () => net.online, viewer: () => ({ user: net.user, crew }), now: clock(), uuid: id, toast: message => toasts.push(message),
    timers: { setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {} },
    fetch: async (url, init) => {
      net.calls.push({ url, init, stored: indexedDB.rows(...STORE).map(row => row.requestId), kept: indexedDB.rows(...STORE).map(row => row.body) });
      if (serve) return serve(url, init);
      if (url === '/api/hub-auth') return Response.json({ ok: true, user: net.account || net.user });
      return answer(url, init, posts().length);
    } });
  if (enabled) { hub.configure({ enabled: true }); await hub.sync(); }
  const chip = () => document.querySelector('.egc-hub-sync');
  return { ...loaded, document, hub, box, net, posts, toasts, indexedDB, chip, text: () => chip()?.querySelector('.hs-label')?.textContent || '' };
}
const request = (collection, data, recordId = 'time-crewone-1') => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collection, id: recordId, data }) });

test('switched off (the default), send() is the original hubFetch call and nothing touches IndexedDB', async () => {
  const p = await page({ enabled: false }), init = request('timeEntries', hubClockOut());
  const response = await p.hub.send(PATH, init);
  assert.equal(response.status, 200);
  assert.equal(p.net.calls.length, 1); assert.equal(p.net.calls[0].init, init, 'the very same request object');
  assert.equal(p.indexedDB.stats.opens, 0); assert.equal(p.chip(), null);
  const { api } = load();
  assert.equal(api.state().enabled, false, 'the page controller starts switched off');
});

test('online: the action is stored before it is sent, the server’s reply goes back to peopleSet, and nothing is left queued', async () => {
  const p = await page(), init = request('timeEntries', hubClockOut(at(-1)));
  const response = await p.hub.send(PATH, init), body = JSON.parse(p.net.calls[0].init.body);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, record: { id: 'saved' } });
  assert.equal(p.net.calls.length, 1, 'the Hub’s own save costs no extra request: the server checks its expectedUser');
  assert.deepEqual(p.net.calls[0].stored, [body.requestId], 'the request was on the device while it was out');
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body, { ...JSON.parse(init.body), requestId: body.requestId, expectedUser: 'Crew.One' }, 'the live attempt has no device time, so the server records its own time as before');
  assert.deepEqual(JSON.parse(p.net.calls[0].kept[0]), { ...body, data: { ...body.data, deviceCapturedAt: at(-1) } }, 'the device copy, sent only if this attempt is not answered, carries the time the Hub showed');
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  assert.ok(!p.chip() || p.chip().hidden, 'no chip when nothing is waiting');
});

test('offline: a clock-out is kept (202 queued) without a request, shown as Pending sync, and sent exactly once when the connection returns', async () => {
  const p = await page({ online: false }), init = request('timeEntries', hubClockOut());
  const response = await p.hub.send(PATH, init), saved = await response.json();
  assert.equal(response.status, 202);
  assert.equal(saved.ok, true); assert.equal(saved.queued, true); assert.equal(saved.record.clockOutAt, NOW);
  assert.equal(p.net.calls.length, 0, 'nothing is sent while offline');
  const [row] = p.indexedDB.rows(...STORE);
  assert.equal(row.requestId, saved.requestId); assert.equal(row.label, 'Clock out');
  assert.equal(p.chip().hidden, false); assert.equal(p.text(), 'Pending sync · 1');
  assert.equal(p.chip().querySelector('button').getAttribute('aria-label'), '1 action waiting to sync. Open pending sync.');
  assert.ok(p.chip().querySelector('button').type === 'button');
  p.hub.open();
  const panel = p.document.querySelector('.hs-panel');
  assert.match(panel.textContent, /You are offline\. These actions are saved on this device/);
  assert.match(panel.textContent, /Clock out/); assert.match(panel.textContent, /Saved Sep 22, 12:00 PM · Waiting for a connection/, 'queued times read in Denver time');
  assert.equal(panel.querySelector('.hs-sync').hasAttribute('disabled'), true, 'Sync now waits for a connection');
  await p.hub.sync();
  assert.equal(p.net.calls.length, 0, 'a check while offline sends nothing');
  p.net.online = true; p.fire('online'); await p.hub.sync();
  assert.deepEqual(p.net.calls.map(call => [call.url, call.init.method]), [['/api/hub-auth', 'GET'], [PATH, 'POST']], 'the signed-in account is confirmed, then exactly one request after reconnecting');
  assert.equal(p.net.calls[0].init.cache, 'no-store');
  assert.equal(p.posts()[0].init.body, row.body, 'the stored body is sent unchanged');
  assert.equal(JSON.parse(row.body).data.deviceCapturedAt, NOW); assert.equal(JSON.parse(row.body).expectedUser, 'Crew.One');
  assert.equal(p.posts()[0].init.cache, 'no-store'); assert.ok(p.posts()[0].init.signal);
  assert.equal(p.chip().hidden, true); assert.deepEqual(p.indexedDB.rows(...STORE), []);
  p.fire('online'); p.document.dispatch({ type: 'visibilitychange' }); await p.hub.sync();
  assert.equal(p.net.calls.length, 2, 'later triggers find nothing to send and ask nothing');
});

test('an action saved behind older queued ones is kept at once, without waiting on them, and is sent after them, never ahead', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const p = await page({ online: false, reply: async (url, init, call) => { if (call === 1) await gate; return Response.json({ ok: true, record: {} }); } });
  await p.hub.send(PATH, request('teamMessages', hubMessage('Crew.One', 'Synthetic first'), 'message-crewone-1'));
  p.net.online = true;
  const first = p.hub.sync();
  for (let i = 0; i < 50 && !p.posts().length; i++) await idle();
  const second = await p.hub.send(PATH, request('timeEntries', hubClockOut()));
  assert.equal(second.status, 202, 'the Hub is not held behind the older request still out');
  assert.equal(p.posts().length, 1);
  release(); await first; await p.hub.sync();
  assert.deepEqual(p.posts().map(call => JSON.parse(call.init.body).collection), ['teamMessages', 'timeEntries']);
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
});

test('a first attempt the server does not confirm stays queued; a first attempt the server refuses returns to the caller unchanged', async () => {
  const busy = await page({ reply: async () => Response.json({ ok: false, error: 'Employee Hub storage failed' }, { status: 503 }) });
  const kept = await busy.hub.send(PATH, request('teamMessages', hubMessage('Crew.One', 'Synthetic kept'), 'message-crewone-1'));
  assert.equal(kept.status, 202);
  const keptBody = await kept.json();
  assert.equal(keptBody.queued, true); assert.equal(keptBody.accountChanged, undefined, 'a busy server is not a changed account');
  assert.equal(busy.text(), 'Pending sync · 1');
  busy.hub.open();
  assert.match(busy.document.querySelector('.hs-panel').textContent, /Crew chat message.*The Hub did not confirm it yet; it will retry/s);
  const refused = await page({ reply: async () => Response.json({ ok: false, error: 'This job room is limited to assigned crew' }, { status: 403 }) });
  const answer = await refused.hub.send(PATH, request('jobMessages', hubMessage('Crew.One', 'Synthetic outsider', 'job-9'), 'message-crewone-2'));
  assert.equal(answer.status, 403); assert.deepEqual(await answer.json(), { ok: false, error: 'This job room is limited to assigned crew' });
  assert.deepEqual(refused.indexedDB.rows(...STORE), [], 'a refused action is dropped');
  assert.deepEqual(plain(refused.hub.state().refused), [], 'the viewer saw this refusal directly, so it is not listed again');
  assert.deepEqual(refused.toasts, []);
});

test('a background replay the server refuses is dropped and listed as not saved with the server’s reason until dismissed', async () => {
  const p = await page({ online: false, reply: async (url, init) => JSON.parse(init.body).collection === 'timeEntries' ? Response.json({ ok: false, code: 'EMPLOYEE_TIMECARD_DEVICE_TIME', error: 'Offline clock times are not enabled. Record it again now or ask a manager for a time correction.' }, { status: 409 }) : Response.json({ ok: true, record: {} }) });
  await p.hub.send(PATH, request('timeEntries', hubClockOut()));
  await p.hub.send(PATH, request('teamMessages', hubMessage('Crew.One', 'Synthetic after'), 'message-crewone-1'));
  assert.equal(p.text(), 'Pending sync · 2');
  p.net.online = true; await p.hub.sync();
  assert.deepEqual(p.posts().map(call => JSON.parse(call.init.body).collection), ['timeEntries', 'teamMessages'], 'the refusal does not hold back the next action');
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  assert.deepEqual(plain(p.hub.state().refused.map(row => [row.label, row.message])), [['Clock out', 'Offline clock times are not enabled. Record it again now or ask a manager for a time correction.']]);
  assert.deepEqual(p.toasts, ['Not saved: Clock out. Offline clock times are not enabled. Record it again now or ask a manager for a time correction.']);
  assert.equal(p.text(), '1 not saved'); assert.equal(p.chip().classList.contains('refused'), true);
  p.hub.open();
  const alert = p.document.querySelector('.hs-refused');
  assert.equal(alert.getAttribute('role'), 'alert'); assert.match(alert.textContent, /Not saved.*Clock out.*Record it again now/s);
  alert.querySelector('.hs-dismiss').click();
  assert.equal(p.chip().hidden, true);
});

test('saves the queue does not hold, and a device without IndexedDB, go to the network exactly as before', async () => {
  const p = await page();
  for (const [collection, data, recordId] of [['timeEntries', { lastLocation: point, locationTrail: [point], locationStatus: 'tracking', locationUpdatedAt: NOW }, 'time-crewone-1'], ['profiles', { lastSeenAt: NOW }, 'crew.one'], ['messageReads', { channel: 'team' }, 'read-1']]) {
    const init = request(collection, data, recordId);
    await p.hub.send(PATH, init);
    assert.equal(p.net.calls.at(-1).init, init, collection);
  }
  const get = { cache: 'no-store' };
  await p.hub.send(PATH, get); assert.equal(p.net.calls.at(-1).init, get);
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  const loaded = load({ document: createDocument() }), calls = [];
  const noDevice = loaded.api.controller({ document: createDocument(), queue: loaded.api.create({ store: loaded.api.idbStore(null) }), online: () => true, viewer: () => ({ user: 'Crew.One', crew: true }), fetch: async (url, init) => { calls.push(init); return Response.json({ ok: true }); } });
  noDevice.configure({ enabled: true });
  const init = request('timeEntries', hubClockOut());
  assert.equal((await noDevice.send(PATH, init)).status, 200);
  assert.deepEqual(calls, [init], 'the original request, without a queue request ID');
});

test('a sign-in error on the first attempt is rethrown to the Hub and the action waits for the same account to sign back in', async () => {
  const expired = Object.assign(new Error('Sign in required'), { code: 'HUB_AUTH_REQUIRED' });
  let signedIn = false;
  const p = await page({ reply: async () => { if (!signedIn) throw expired; return Response.json({ ok: true, record: {} }); } });
  const init = request('timeEntries', hubClockOut());
  await assert.rejects(p.hub.send(PATH, init), error => error === expired, 'hubFetch’s own sign-in error reaches peopleSet');
  const [row] = p.indexedDB.rows(...STORE);
  assert.equal(row.waiting, 'auth'); assert.equal(row.lastStatus, 401);
  p.hub.open(); assert.match(p.document.querySelector('.hs-panel').textContent, /Sign in again to send it/);
  p.fire('egc:signout');
  assert.equal(p.chip().hidden, true, 'sign-out hides the chip');
  p.net.user = 'Crew.Two'; await p.hub.sync();
  assert.equal(p.net.calls.length, 1, 'another account never sends it'); assert.equal(p.chip().hidden, true);
  p.net.user = 'Crew.One'; signedIn = true;
  await p.hub.send(PATH, request('profiles', { lastSeenAt: NOW }, 'crew.one'));
  await p.hub.sync();
  const sent = p.posts().filter(call => JSON.parse(call.init.body).collection === 'timeEntries');
  assert.equal(sent.length, 2); assert.equal(sent[1].init.body, row.body, 'the first save after signing back in replays it unchanged');
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
});

test('Discard asks for a second tap and removes only that action', async () => {
  const p = await page({ online: false });
  await p.hub.send(PATH, request('teamMessages', hubMessage('Crew.One', 'Synthetic one'), 'message-crewone-1'));
  await p.hub.send(PATH, request('teamMessages', hubMessage('Crew.One', 'Synthetic two'), 'message-crewone-2'));
  p.hub.open();
  const first = () => p.document.querySelectorAll('.hs-discard')[0];
  first().click();
  assert.equal(first().textContent, 'Tap again to discard');
  assert.equal(p.indexedDB.rows(...STORE).length, 2, 'one tap never discards');
  first().click();
  for (let i = 0; i < 50 && p.text() !== 'Pending sync · 1'; i++) await idle();
  assert.deepEqual(p.indexedDB.rows(...STORE).map(row => JSON.parse(row.body).id), ['message-crewone-2']);
  assert.equal(p.text(), 'Pending sync · 1');
});

// ── The real Hub: employee-suite.js peopleSet routes its clock-out and chat through the queue ──

function hubWithQueue({ online = false, reply, user = 'Crew.One', account = user, entry = { id: 'time-crewone-1', employee: user, status: 'active', approvalStatus: 'open', clockInAt: at(-120), clockOutAt: '', hourlyRate: 20, breaks: [] }, records } = {}) {
  const posts = [], gets = [];
  const hub = hubPage({ user, business: false, role: 'crew', fetcher: async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') { posts.push(JSON.parse(init.body)); return reply ? reply(JSON.parse(init.body)) : { ok: true, status: 200, json: async () => ({ ok: true, record: {} }) }; }
    gets.push(url);
    if (url === '/api/hub-auth') return { ok: true, status: 200, json: async () => ({ ok: true, user: account }) };
    if (records && url === '/api/employee-hub') return { ok: true, status: 200, json: async () => ({ ok: true, collections: records() }) };
    return { ok: false, status: 503, json: async () => ({ ok: false, error: 'Synthetic service unavailable' }) };
  } });
  const indexedDB = fakeIndexedDB();
  Object.assign(hub.context, { indexedDB, Response, Event: class { constructor(type) { this.type = type; } }, dispatchEvent: event => { hub.fire(event.type); return true; } });
  hub.context.navigator.onLine = online;
  vm.runInContext(source, hub.context, { filename: 'employee-offline-queue.js' });
  hub.api.S.peopleState.loaded = true;
  hub.api.S.people.timeEntries = [entry];
  return { hub, posts, gets, indexedDB };
}

test('the Hub’s clock-out while offline shows as saved on this device and reaches the server once, with its capture time, after reconnecting', async () => {
  const { hub, posts, gets, indexedDB } = hubWithQueue();
  hub.context.EGCHubOffline.configure({ enabled: true });
  hub.api.install();
  await hub.context.opsClockOut();
  assert.deepEqual(posts, [], 'nothing was sent offline');
  const shown = hub.api.S.people.timeEntries.find(entry => entry.id === 'time-crewone-1');
  assert.equal(shown.clockOutAt, NOW); assert.equal(shown.status, 'submitted'); assert.equal(shown.pendingSync, true);
  assert.equal(hub.toasts.at(-1), 'Clock-out saved on this device · 2.00 hours sync when you are back online');
  assert.equal(indexedDB.rows(...STORE).length, 1);
  assert.equal(hub.document.querySelector('.egc-hub-sync .hs-label').textContent, 'Pending sync · 1');
  const before = gets.length;
  hub.context.navigator.onLine = true; hub.fire('online');
  await hub.context.EGCHubOffline.sync();
  assert.equal(posts.length, 1, 'exactly one POST');
  assert.deepEqual(posts[0], { collection: 'timeEntries', id: 'time-crewone-1', requestId: posts[0].requestId, expectedUser: 'Crew.One', data: { clockOutAt: NOW, status: 'submitted', approvalStatus: 'pending', hours: 2, grossEstimate: 40, locationTracking: false, locationStatus: 'stopped', updatedAt: NOW, deviceCapturedAt: NOW } });
  assert.ok(gets.slice(before).indexOf('/api/hub-auth') >= 0, 'the replay confirmed the signed-in account first');
  assert.match(posts[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(indexedDB.rows(...STORE), []);
  assert.ok(gets.slice(before).some(url => url === '/api/employee-hub'), 'the Hub reloads its employee records once the replay is confirmed');
  assert.equal(hub.document.querySelector('.egc-hub-sync').hidden, true);
});

test('the Hub’s crew chat is kept offline and replayed once; with the queue switched off the Hub saves exactly as before', async () => {
  const { hub, posts } = hubWithQueue();
  hub.context.EGCHubOffline.configure({ enabled: true });
  hub.api.install();
  const form = hub.document.createElement('form'), input = hub.document.createElement('textarea'), submit = hub.document.createElement('button');
  input.setAttribute('name', 'body'); input.value = 'Synthetic running late'; form.append(input, submit); form.reset = () => { input.value = ''; };
  await hub.context.opsSendChat({ preventDefault() {}, currentTarget: form });
  const chat = () => posts.filter(body => body.collection === 'teamMessages');
  assert.deepEqual(chat(), [], 'the message was not sent offline (its read marker is an ordinary save)');
  const shown = hub.api.S.people.teamMessages.at(-1);
  assert.equal(shown.body, 'Synthetic running late'); assert.equal(shown.pendingSync, true); assert.equal(input.value, '', 'the draft is cleared once the message is kept');
  hub.context.navigator.onLine = true; hub.fire('online'); await hub.context.EGCHubOffline.sync();
  assert.equal(chat().length, 1); assert.equal(chat()[0].id, shown.id); assert.equal(chat()[0].data.body, 'Synthetic running late'); assert.match(chat()[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(Object.keys(chat()[0].data).includes('deviceCapturedAt'), false, 'messages carry only the request ID');

  const off = hubWithQueue({ online: true });
  off.hub.api.install();
  await off.hub.context.opsClockOut();
  assert.deepEqual(off.posts, [{ collection: 'timeEntries', id: 'time-crewone-1', data: { clockOutAt: NOW, status: 'submitted', approvalStatus: 'pending', hours: 2, grossEstimate: 40, locationTracking: false, locationStatus: 'stopped', updatedAt: NOW } }], 'no request ID, no device time: today’s request');
  assert.equal(off.indexedDB.stats.opens, 0);
  assert.equal(off.hub.toasts.at(-1), 'Clocked out · 2.00 hours submitted');
});

// ── The server contract the queue relies on: a replay after a lost reply saves nothing twice ──

const ENV = staffEnv({}, { 'Crew.Other': { passwordHash: 'unused-synthetic-other-hash', role: 'crew', displayName: 'Synthetic Other Crew', hourlyRate: 19 } });
const CREW = 'Crew.Static';
function seedJob(fire, jobId, crew) {
  fire.documents.set(`jobs/${jobId}`, { name: `${ROOT}/jobs/${jobId}`, fields: encodeFirestoreFields({ type: 'job', customer: 'Synthetic Customer', serviceType: 'Garage cleanout', assignedCrew: crew, status: 'scheduled' }), updateTime: '2026-09-22T12:00:00.000001Z' });
}
const post = async (cookie, body, env = ENV) => employeeHub.onRequestPost({ env, request: jsonRequest(PATH, body, cookie) });

test('server: a crew member’s replayed message returns the saved message and writes nothing; any other change is still refused', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const fire = vaultFirestore(t), cookie = await cookieFor(ENV, CREW), other = await cookieFor(ENV, 'Crew.Other');
  seedJob(fire, 'job-1', [CREW]);
  for (const [collection, data] of [['teamMessages', { body: 'Synthetic on my way', jobId: '' }], ['jobMessages', { body: 'Synthetic gate code works', jobId: 'job-1' }]]) {
    const body = { collection, id: `message-${collection}`, requestId: id(), data };
    const first = await post(cookie, body);
    assert.equal(first.status, 200, await first.clone().text());
    const saved = (await first.json()).record, writes = fire.writes().length;
    t.mock.timers.setTime(Date.parse(at(3)));
    const replay = await post(cookie, body);
    assert.equal(replay.status, 200, `${collection}: ${await replay.clone().text()}`);
    assert.deepEqual((await replay.json()).record, saved, `${collection}: the saved message, with its first createdAt`);
    assert.equal(fire.writes().length, writes, `${collection}: a replay writes nothing`);
    const edited = await post(cookie, { ...body, data: { ...data, body: 'Synthetic edited text' } });
    assert.equal(edited.status, 403, `${collection}: changing the text is still a manager-only edit`);
    const impostor = await post(other, body);
    assert.equal(impostor.status, 403, `${collection}: another employee cannot claim the message`);
    t.mock.timers.setTime(Date.parse(NOW));
  }
});

test('server: without a queued request ID (the Hub’s direct saves, and every save with HUB_OFFLINE_ENABLED off) a re-posted message and a break built on other copies of earlier breaks are refused as before', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(-120)) });
  const fire = vaultFirestore(t), cookie = await cookieFor(ENV, CREW);
  seedJob(fire, 'job-2', [CREW]);
  for (const [collection, data, refusal] of [['teamMessages', { body: 'Synthetic direct hello', jobId: '' }, 'Only a manager can change an existing team message'], ['jobMessages', { body: 'Synthetic direct gate note', jobId: 'job-2' }, 'This record belongs to another employee']]) {
    const body = { collection, id: `direct-${collection}`, data };
    assert.equal((await post(cookie, body)).status, 200);
    const writes = fire.writes().length, again = await post(cookie, body);
    assert.equal(again.status, 403, `${collection}: a direct re-post is refused, as before`);
    assert.equal((await again.json()).error, refusal, collection);
    for (const requestId of ['not-a-uuid', 42]) assert.equal((await post(cookie, { ...body, requestId })).status, 403, `${collection}: ${requestId} is not a queued request ID`);
    const queued = await post(cookie, { ...body, requestId: id(), expectedUser: CREW });
    assert.equal(queued.status, 200, `${collection}: the queued replay is the saved message`);
    assert.equal(fire.writes().length, writes, collection);
  }
  const recordId = 'time-crewstatic-direct', card = { ...hubClockIn(CREW, at(-120)), id: recordId };
  assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: card })).status, 200);
  // A first break started and ended from this device's queue: the server keeps its request IDs on the row.
  t.mock.timers.setTime(Date.parse(at(-60)));
  const start = id(), end = id();
  assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, requestId: start, expectedUser: CREW, data: { breaks: [{ startAt: at(-60), endAt: '', requestId: start }], updatedAt: at(-60) } })).status, 200);
  t.mock.timers.setTime(Date.parse(at(-45)));
  const ended = await post(cookie, { collection: 'timeEntries', id: recordId, requestId: end, expectedUser: CREW, data: { breaks: [{ startAt: at(-60), endAt: at(-45), requestId: end }], updatedAt: at(-45) } });
  assert.deepEqual((await ended.json()).record.breaks, [{ startAt: at(-60), endAt: at(-45), startRequestId: start, endRequestId: end }]);
  // A second break built on a copy of the first without those IDs.
  t.mock.timers.setTime(Date.parse(at(-30)));
  const second = { breaks: [{ startAt: at(-60), endAt: at(-45) }, { startAt: at(-30), endAt: '' }], updatedAt: at(-30) };
  const direct = await post(cookie, { collection: 'timeEntries', id: recordId, data: second });
  assert.equal(direct.status, 403, 'a direct save compares the earlier breaks whole, as before');
  assert.match((await direct.json()).error, /Recorded breaks cannot be rewritten/);
  const next = id(), queued = await post(cookie, { collection: 'timeEntries', id: recordId, requestId: next, expectedUser: CREW, data: { ...second, breaks: [second.breaks[0], { ...second.breaks[1], requestId: next }] } });
  assert.equal(queued.status, 200, 'a queued save compares their times');
  assert.deepEqual((await queued.json()).record.breaks, [{ startAt: at(-60), endAt: at(-45), startRequestId: start, endRequestId: end }, { startAt: at(-30), endAt: '', startRequestId: next }], 'the rows kept are the server’s');
});

test('server + queue: a crew clock-out whose reply is lost is replayed once and recorded once, at the time it was first saved', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(-120)) });
  const fire = vaultFirestore(t), cookie = await cookieFor(ENV, CREW), { api } = load();
  const started = await post(cookie, { collection: 'timeEntries', id: 'time-crewstatic-1', data: hubClockIn(CREW, at(-120)) });
  assert.equal(started.status, 200, await started.clone().text());
  t.mock.timers.setTime(Date.parse(NOW));
  const box = api.create({ store: api.memoryStore(), now: clock() }), requestId = id(), outBody = { collection: 'timeEntries', id: 'time-crewstatic-1', data: hubClockOut(NOW) };
  await box.enqueue({ requestId, user: CREW, path: PATH, label: 'Clock out', body: JSON.stringify(api.prepare(outBody, api.describe(PATH, outBody, CREW), { requestId, user: CREW, crew: true, now: clock() })) });
  let lose = 1;
  const transport = async (path, body) => {
    const response = await employeeHub.onRequestPost({ env: ENV, request: jsonRequest(path, body, cookie) }), data = await response.json();
    if (lose-- > 0) throw Object.assign(new TypeError('Synthetic lost reply'), { status: 0 });
    return { status: response.status, data };
  };
  const lost = await box.flush({ user: CREW, transport });
  assert.equal(lost.stopped.reason, 'network'); assert.equal(lost.remaining, 1);
  t.mock.timers.setTime(Date.parse(at(1)));
  const replay = await box.flush({ user: CREW, transport });
  assert.equal(replay.applied.length, 1); assert.equal(replay.remaining, 0);
  const record = replay.applied[0].data.record;
  assert.equal(record.clockOutAt, NOW, 'the replay did not restamp the clock-out');
  assert.equal(record.status, 'submitted');
  assert.equal(record.history.filter(entry => entry.action === 'clock_out').length, 1, 'one clock-out in the audit history');
});

test('server + queue: without EGC_OFFLINE_CLOCK_ENABLED a clock-out queued more than two minutes ago is dropped as not saved; with it, the capture time is kept for review', async t => {
  for (const flag of ['', 'true']) {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(-120)) });
    const env = flag ? { ...ENV, EGC_OFFLINE_CLOCK_ENABLED: flag } : ENV;
    const fire = vaultFirestore(t), cookie = await cookieFor(env, CREW), { api } = load();
    assert.equal((await post(cookie, { collection: 'timeEntries', id: `time-offline-${flag || 'off'}`, data: hubClockIn(CREW, at(-120)) }, env)).status, 200);
    const box = api.create({ store: api.memoryStore(), now: clock() }), requestId = id(), outBody = { collection: 'timeEntries', id: `time-offline-${flag || 'off'}`, data: hubClockOut(at(-10)) };
    await box.enqueue({ requestId, user: CREW, path: PATH, label: 'Clock out', body: JSON.stringify(api.prepare(outBody, api.describe(PATH, outBody, CREW), { requestId, user: CREW, crew: true, now: clock() })) });
    t.mock.timers.setTime(Date.parse(NOW));
    const result = await box.flush({ user: CREW, transport: async (path, body) => { const response = await employeeHub.onRequestPost({ env, request: jsonRequest(path, body, cookie) }); return { status: response.status, data: await response.json() }; } });
    assert.equal(result.remaining, 0, flag);
    if (!flag) {
      assert.deepEqual(plain(result.dropped.map(entry => [entry.status, entry.data.code])), [[409, 'EMPLOYEE_TIMECARD_DEVICE_TIME']], 'a stale time is refused, never moved to the moment of reconnecting');
    } else {
      const record = result.applied[0].data.record;
      assert.equal(record.clockOutAt, at(-10)); assert.equal(record.deviceTime, true); assert.equal(record.needsReview, true);
    }
    assert.ok(fire.writes().length > 0);
    t.mock.timers.reset();
  }
});

test('server + queue: actions one account saved are never sent while another account holds the cookie; they wait for the account that saved them', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const fire = vaultFirestore(t), cookies = { [CREW]: await cookieFor(ENV, CREW), 'Crew.Other': await cookieFor(ENV, 'Crew.Other') };
  let signedIn = CREW;
  // The real endpoints behind the one shared cookie: this tab still shows CREW while another tab signed in as Crew.Other.
  const serve = (url, init) => url === '/api/hub-auth' ? hubAuth.onRequestGet({ env: ENV, request: jsonRequest(url, undefined, cookies[signedIn]) }) : employeeHub.onRequestPost({ env: ENV, request: jsonRequest(url, init.body, cookies[signedIn]) });
  const p = await page({ online: false, user: CREW, serve });
  const clockIn = { ...hubClockIn(CREW), id: 'time-crewstatic-stale' };
  assert.equal((await p.hub.send(PATH, request('timeEntries', clockIn, clockIn.id))).status, 202);
  assert.equal((await p.hub.send(PATH, request('teamMessages', hubMessage(CREW, 'Synthetic from the stale tab'), 'message-crewstatic-stale'))).status, 202);
  signedIn = 'Crew.Other'; p.net.online = true;
  await p.hub.sync(); p.fire('online'); p.document.dispatch({ type: 'visibilitychange' }); await p.hub.sync();
  assert.deepEqual(p.posts(), [], 'nothing is posted for the other account');
  assert.ok(p.net.calls.every(call => call.url === '/api/hub-auth'));
  assert.equal(fire.writes().length, 0, 'no timecard or message is written for Crew.Other');
  const rows = p.indexedDB.rows(...STORE);
  assert.equal(rows.length, 2, 'both actions are kept'); assert.equal(rows.find(row => row.label === 'Clock in').waiting, 'account');
  assert.deepEqual(p.toasts, []); assert.deepEqual(plain(p.hub.state().refused), []);
  p.hub.open(); assert.match(p.document.querySelector('.hs-panel').textContent, /Clock in.*Sign in as Crew\.Static to send it/s);
  // The server refuses the same bodies on its own, so a request that skips the page's check still writes nothing.
  for (const row of rows) {
    const refused = await post(cookies['Crew.Other'], row.body);
    assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'EMPLOYEE_HUB_ACCOUNT_CHANGED');
  }
  // The stale tab's own live save: its first attempt has no account check of its own, the server's 409 keeps it.
  const live = await page({ user: CREW, serve });
  const kept = await live.hub.send(PATH, request('teamMessages', hubMessage(CREW, 'Synthetic live from the stale tab'), 'message-crewstatic-live'));
  assert.equal(kept.status, 202);
  const keptBody = await kept.json();
  assert.equal(keptBody.queued, true); assert.equal(keptBody.accountChanged, true, 'the Hub is told another account is signed in');
  assert.deepEqual(plain(live.indexedDB.rows(...STORE).map(row => [row.waiting, row.lastStatus])), [['account', 409]]);
  assert.equal(fire.writes().length, 0);
  signedIn = CREW;
  const sent = await p.hub.sync();
  assert.equal(sent.applied.length, 2); assert.equal(sent.remaining, 0);
  const [card, message] = sent.applied.map(entry => entry.data.record);
  assert.equal(card.employee, CREW); assert.equal(card.status, 'active'); assert.equal(message.sender, CREW);
});

test('server + Hub queue: with EGC_OFFLINE_CLOCK_ENABLED, a break ended and a second one started in one offline window all replay, each at the time the Hub showed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(-120)) });
  const env = { ...ENV, EGC_OFFLINE_CLOCK_ENABLED: 'true' }, fire = vaultFirestore(t), cookie = await cookieFor(env, CREW);
  const started = await post(cookie, { collection: 'timeEntries', id: 'time-crewstatic-breaks', data: { ...hubClockIn(CREW, at(-120)), id: 'time-crewstatic-breaks' } }, env);
  assert.equal(started.status, 200, await started.clone().text());
  const card = (await started.json()).record;
  t.mock.timers.setTime(Date.parse(NOW));
  const { hub, posts } = hubWithQueue({ user: CREW, entry: card, reply: body => employeeHub.onRequestPost({ env, request: jsonRequest(PATH, body, cookie) }) });
  const showing = time => { hub.context.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [Date.parse(time)])); } static now() { return Date.parse(time); } }; };
  hub.context.EGCHubOffline.configure({ enabled: true });
  hub.api.install();
  for (const [time, act] of [[at(-60), 'opsStartBreak'], [at(-45), 'opsEndBreak'], [at(-30), 'opsStartBreak']]) { showing(time); await hub.context[act](); }
  assert.deepEqual(posts, [], 'all three were kept offline');
  assert.deepEqual(plain(hub.api.S.people.timeEntries.find(entry => entry.id === card.id).breaks), [{ startAt: at(-60), endAt: at(-45) }, { startAt: at(-30), endAt: '' }]);
  showing(NOW); hub.context.navigator.onLine = true;
  const result = await hub.context.EGCHubOffline.sync();
  assert.deepEqual(plain(result.dropped.map(entry => entry.data)), [], 'no break was refused as a rewrite');
  assert.equal(result.applied.length, 3); assert.equal(posts.length, 3);
  const record = result.applied.at(-1).data.record, ids = posts.map(body => body.requestId.toLowerCase());
  assert.deepEqual(record.breaks, [{ startAt: at(-60), endAt: at(-45), startRequestId: ids[0], endRequestId: ids[1] }, { startAt: at(-30), endAt: '', startRequestId: ids[2] }]);
  assert.equal(record.deviceTime, true); assert.equal(record.needsReview, true);
  assert.equal(record.history.filter(entry => entry.action === 'break_update').length, 3);
  // A replay of the same three after a lost reply is a no-op by request ID.
  for (const body of posts) assert.equal((await post(cookie, body, env)).status, 200);
  assert.deepEqual((await (await post(cookie, posts[2], env)).json()).record.breaks, record.breaks);
  // Only the request IDs are set aside when earlier breaks are compared: changing an earlier break's times is still refused.
  const rewrite = await post(cookie, { collection: 'timeEntries', id: card.id, data: { breaks: [{ startAt: at(-70), endAt: at(-45) }, { startAt: at(-30), endAt: at(-1) }], updatedAt: at(-1) } }, env);
  assert.equal(rewrite.status, 400); assert.match((await rewrite.json()).error, /Only the current break can be ended/);
});

test('server + queue: a live clock-out from a phone whose clock runs five minutes slow is recorded at the server’s time as before, never refused or flagged as an offline time', async t => {
  for (const flag of ['', 'true']) {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(-120)) });
    const env = flag ? { ...ENV, EGC_OFFLINE_CLOCK_ENABLED: flag } : ENV, fire = vaultFirestore(t), cookie = await cookieFor(env, CREW), recordId = `time-skew-${flag || 'off'}`;
    assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: { ...hubClockIn(CREW, at(-120)), id: recordId } }, env)).status, 200);
    t.mock.timers.setTime(Date.parse(NOW));
    const p = await page({ user: CREW, serve: (url, init) => employeeHub.onRequestPost({ env, request: jsonRequest(url, init.body, cookie) }) });
    // The phone shows 11:55 while the server's clock reads 12:00.
    const response = await p.hub.send(PATH, request('timeEntries', hubClockOut(at(-5)), recordId));
    assert.equal(response.status, 200, `${flag}: ${await response.clone().text()}`);
    const record = (await response.json()).record;
    assert.equal(record.clockOutAt, NOW, `${flag}: the server’s time`); assert.equal(record.status, 'submitted');
    assert.equal(Boolean(record.needsReview), false, `${flag}: a live action is not flagged for review`);
    assert.deepEqual(p.indexedDB.rows(...STORE), []); assert.ok(fire.writes().length > 0);
    t.mock.timers.reset();
  }
});

test('an action that waited too long is never sent: a clock action after 12 hours, a message after a day; every account’s are removed and the viewer’s are listed as not saved', async () => {
  const indexedDB = fakeIndexedDB(), { api } = load(), box = api.create({ store: api.idbStore(indexedDB), now: clock() }), hours = h => at(-h * 60);
  const staleClock = action('Crew.One', 'timeEntries', hubClockOut(hours(13)), 'time-crewone-1', hours(13));
  const oldMessage = action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic yesterday'), 'message-1', hours(25));
  const recentMessage = action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic this morning'), 'message-2', hours(13));
  const theirStale = action('Crew.Two', 'timeEntries', hubClockIn('Crew.Two'), 'time-crewtwo-1', hours(12.5));
  const theirRecent = action('Crew.Two', 'teamMessages', hubMessage('Crew.Two', 'Synthetic theirs'), 'message-3', hours(1));
  for (const item of [staleClock, oldMessage, recentMessage, theirStale, theirRecent]) await box.enqueue(item);
  const line = wire(), result = await box.flush({ user: 'Crew.One', transport: line.transport });
  assert.deepEqual(line.calls.map(call => call.body), [recentMessage.body], 'only the message still within a day is sent');
  assert.deepEqual(plain(result.dropped.map(entry => [entry.item.requestId, entry.expired, entry.data.code])), [[staleClock.requestId, true, 'HUB_OFFLINE_EXPIRED'], [oldMessage.requestId, true, 'HUB_OFFLINE_EXPIRED']]);
  assert.match(result.dropped[0].data.error, /more than 12 hours.*Ask a manager for a time correction/);
  assert.match(result.dropped[1].data.error, /more than a day/);
  assert.deepEqual(indexedDB.rows(...STORE).map(row => row.requestId), [theirRecent.requestId], 'another account’s expired clock-in (location, pay) is removed from the device too');

  // Offline, the Hub lists them as not saved without sending anything.
  const p = await page({ online: false });
  await p.box.enqueue(action('Crew.One', 'timeEntries', hubClockOut(hours(20)), 'time-crewone-1', hours(20)));
  await p.hub.sync();
  assert.deepEqual(p.net.calls, []); assert.deepEqual(p.indexedDB.rows(...STORE), []);
  assert.deepEqual(p.toasts, ['Not saved: timeEntries. It waited on this device for more than 12 hours, so it was not sent. Ask a manager for a time correction.']);
  assert.equal(p.text(), '1 not saved');

  // Switched off, a device that has a queue removes the expired actions and keeps the rest for a later switch-on.
  const device = fakeIndexedDB(), listed = { open: (...args) => device.open(...args), databases: () => device.databases() };
  const off = load({ document: createDocument() }), offBox = off.api.create({ store: off.api.idbStore(listed), now: clock() });
  const fresh = action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic fresh'), 'message-4');
  await offBox.enqueue(action('Crew.Two', 'timeEntries', hubClockOut(hours(30)), 'time-crewtwo-1', hours(30))); await offBox.enqueue(fresh);
  off.api.controller({ document: createDocument(), queue: offBox, online: () => true, viewer: () => ({ user: '', crew: true }), now: clock(), fetch: async () => assert.fail('switched off sends nothing') }).configure({ enabled: false });
  for (let i = 0; i < 100 && device.rows(...STORE).length > 1; i++) await idle();
  assert.deepEqual(device.rows(...STORE).map(row => row.requestId), [fresh.requestId]);
  // A device that never had a queue is not given one.
  const never = fakeIndexedDB(), none = { open: (...args) => never.open(...args), databases: async () => [] }, bare = load({ document: createDocument() });
  bare.api.controller({ document: createDocument(), queue: bare.api.create({ store: bare.api.idbStore(none), now: clock() }), online: () => true, viewer: () => ({ user: 'Crew.One', crew: true }), now: clock() }).configure({ enabled: false });
  for (let i = 0; i < 5; i++) await idle();
  assert.equal(never.stats.opens, 0);
});

test('discarding a queued clock-out has the Hub reload its records, so the shift the server still has shows as active again', async () => {
  const server = { id: 'time-crewone-1', employee: 'Crew.One', status: 'active', approvalStatus: 'open', clockInAt: at(-120), clockOutAt: '', hourlyRate: 20, breaks: [] };
  const records = () => ({ profiles: [], timeEntries: [plain(server)], announcements: [], requests: [], incidents: [], equipment: [], training: [], teamMessages: [], jobMessages: [], messageReads: [] });
  const { hub, gets, indexedDB } = hubWithQueue({ entry: plain(server), records });
  hub.context.EGCHubOffline.configure({ enabled: true });
  hub.api.install();
  await hub.context.opsClockOut();
  const shown = () => hub.api.S.people.timeEntries.find(entry => entry.id === server.id);
  assert.equal(shown().pendingSync, true); assert.equal(shown().status, 'submitted');
  for (let i = 0; i < 50 && hub.api.S.peopleRequest; i++) await idle();
  const before = gets.length;
  hub.document.querySelector('.egc-hub-sync button').click();
  const discard = () => hub.document.querySelector('.hs-discard');
  discard().click(); discard().click();
  for (let i = 0; i < 100 && (indexedDB.rows(...STORE).length || shown().pendingSync || !gets.slice(before).includes('/api/employee-hub') || hub.api.S.peopleRequest); i++) await idle();
  assert.deepEqual(indexedDB.rows(...STORE), []);
  assert.ok(gets.slice(before).includes('/api/employee-hub'), 'the Hub reloaded its employee records');
  assert.equal(shown().status, 'active'); assert.equal(shown().pendingSync, undefined, 'the discarded clock-out no longer shows');
});

test('a save that a pass already under way sends first gets that pass’s answer, not “saved on this device”, and no second notice', async () => {
  for (const [label, status, body] of [['applied', 200, { ok: true, record: { id: 'saved' } }], ['refused', 403, { ok: false, error: 'This job room is limited to assigned crew' }]]) {
    let trigger = null, background = null;
    // The 30 s check starts just as the Hub's save is written to the device, so that pass sends it first.
    const p = await page({ reply: async () => Response.json(body, { status }), store: base => ({ ...base, put: async item => { await base.put(item); const run = trigger; trigger = null; run?.(); } }) });
    trigger = () => { background = p.hub.sync(); };
    const response = await p.hub.send(PATH, request('jobMessages', hubMessage('Crew.One', 'Synthetic race', 'job-1'), 'message-crewone-9'));
    await background;
    assert.deepEqual(p.net.calls.map(call => call.url), ['/api/hub-auth', PATH], `${label}: sent once, by the background pass`);
    assert.equal(response.status, status, label); assert.deepEqual(await response.json(), body, label);
    assert.deepEqual(p.toasts, [], `${label}: the Hub shows its own answer and nothing else`);
    assert.deepEqual(plain(p.hub.state().refused), [], label);
    assert.deepEqual(p.indexedDB.rows(...STORE), [], label);
  }
});

test('a crew clock action saved online goes out without the device time only on its first attempt within two minutes; a retry, a later first attempt or one saved behind others carries it', async () => {
  const { api } = load();
  let tick = Date.parse(NOW);
  const box = api.create({ store: api.memoryStore(), now: () => new Date(tick) });
  const saved = (recordId, time) => {
    const requestId = id(), out = { collection: 'timeEntries', id: recordId, data: hubClockOut(time) }, kind = api.describe(PATH, out, 'Crew.One'), options = { requestId, user: 'Crew.One', crew: true, now: () => new Date(tick) };
    return { requestId, user: 'Crew.One', path: PATH, label: 'Clock out', kind: 'clock', body: JSON.stringify(api.prepare(out, kind, options)), live: JSON.stringify(api.prepare(out, kind, { ...options, captured: false })) };
  };
  const captured = body => JSON.parse(body).data.deviceCapturedAt;
  const first = saved('time-crewone-1', NOW), second = saved('time-crewone-2', NOW);
  await box.enqueue(first); await box.enqueue(second);
  assert.equal((await box.items('Crew.One'))[1].live, '', 'an action saved behind another has no live body');
  const busy = wire(() => ({ status: 503, data: null }));
  await box.flush({ user: 'Crew.One', transport: busy.transport });
  assert.deepEqual(busy.calls.map(call => call.body), [first.live]);
  assert.equal(captured(busy.calls[0].body), undefined, 'the first attempt is the live save');
  const retry = wire();
  await box.flush({ user: 'Crew.One', transport: retry.transport });
  assert.deepEqual(retry.calls.map(call => call.body), [first.body, second.body], 'the retry and the action behind it carry the time the Hub showed');
  assert.deepEqual(retry.calls.map(call => captured(call.body)), [NOW, NOW]);
  // A page closed before its first attempt: three minutes later, the kept body goes out.
  const closed = saved('time-crewone-3', NOW);
  await box.enqueue(closed);
  tick += 3 * 60000;
  const late = wire();
  await box.flush({ user: 'Crew.One', transport: late.transport });
  assert.deepEqual(late.calls.map(call => call.body), [closed.body]);
  await assert.rejects(box.enqueue({ ...saved('time-crewone-4', NOW), live: JSON.stringify({ collection: 'timeEntries', id: 'x', data: {}, requestId: id(), expectedUser: 'Crew.One' }) }), error => error.code === 'HUB_OFFLINE_INVALID', 'a live body must be the same request');
});

test('a clock-out that a background pass sends first, as the Hub saves it, goes out without the device time and is recorded at the server’s time', async () => {
  let trigger = null, background = null;
  const p = await page({ store: base => ({ ...base, put: async item => { await base.put(item); const run = trigger; trigger = null; run?.(); } }) });
  trigger = () => { background = p.hub.sync(); };
  const response = await p.hub.send(PATH, request('timeEntries', hubClockOut(at(-1))));
  await background;
  assert.equal(response.status, 200);
  assert.deepEqual(p.net.calls.map(call => call.url), ['/api/hub-auth', PATH]);
  const sent = JSON.parse(p.posts()[0].init.body), kept = JSON.parse(p.posts()[0].kept[0]);
  assert.equal(sent.data.deviceCapturedAt, undefined, 'the background pass sent the live save');
  assert.equal(kept.data.deviceCapturedAt, at(-1), 'the device copy kept the time the Hub showed');
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
});

// ── The Hub's clock follows the queue: the real Hub (employee-suite.js + this queue) against the real endpoints ──

// navigator.geolocation for the Hub. CREW-TIME (owner decision 2026-09-29, clock-in only): the Hub reads one position as
// the shift starts (reads) and never watches it; a watch it started would be listed in watches, which every test below
// expects empty, so no position fix can leave any tab after clock-in. (These tests once followed the HUB-PWA shift
// location watch; its assertions now check that none exists.)
function geolocation(coords = { latitude: 40.585, longitude: -105.084, accuracy: 6 }) {
  const watches = [], reads = [];
  return {
    watches, reads, live: () => watches,
    getCurrentPosition: (success, failure, options) => { reads.push(options); success({ coords }); },
    watchPosition: (success, failure) => { watches.push({ success, failure }); return watches.length; },
    clearWatch() {},
    // The phone has a new position: with no watch, nothing on the page hears it.
    fix: async () => { for (const watch of watches) await watch.success({ coords }); },
  };
}
// The viewer's open shift, as the Hub shows it.
const openShiftId = p => p.S.people.timeEntries.find(entry => entry.status === 'active' && !entry.clockOutAt)?.id || '';
const NO_WATCH = 'no location watch: the position is read once, at clock-in';
const until = async (done, rounds = 400) => { for (let i = 0; i < rounds && !done(); i++) await idle(); return done(); };

// gate.post(body) may answer a POST itself (or wait) before the real handler runs; gate.get(response) may hold a
// GET /api/employee-hub reply that was already read from the server; gate.auth() may hold the replay's account check. network: while navigator.onLine is false nothing
// reaches the server (every request fails as a dropped connection does). configure:false leaves the queue as a page
// finds it before /api/hub-offline answers. indexedDB is this device's storage, shared by Hub pages opened on it.
function hubOnServer({ env = ENV, user = CREW, cookie, online = true, gate = {}, business = false, role = 'crew', network = false, configure = true, indexedDB = fakeIndexedDB(), before }) {
  const posts = [], snapshots = [];
  // Requests the real endpoints are still answering (their WebCrypto work runs off the event loop, so it takes as long as
  // the machine needs): settle() waits for them, as for a load or a replay. A request a gate holds does not count.
  let serving = 0;
  const serve = async work => { serving++; try { return await work(); } finally { serving--; } };
  const hub = hubPage({ user, business, role, before, fetcher: async (url, init = {}) => {
    if (network && hub.context.navigator.onLine === false) throw new TypeError('Failed to fetch');
    if ((init.method || 'GET') === 'POST') {
      const body = JSON.parse(init.body); posts.push(body);
      const answer = await gate.post?.(body);
      return answer || serve(() => employeeHub.onRequestPost({ env, request: jsonRequest(url, init.body, cookie) }));
    }
    if (url === '/api/hub-auth') { await gate.auth?.(); return serve(() => hubAuth.onRequestGet({ env, request: jsonRequest(url, undefined, cookie) })); }
    if (url.startsWith('/api/employee-hub')) {
      const response = await serve(() => employeeHub.onRequestGet({ env, request: jsonRequest(url, undefined, cookie) }));
      const read = await response.clone().json();
      snapshots.push(plain((read.collections?.timeEntries || []).map(entry => [entry.id, entry.status])));
      await gate.get?.(response);
      return response;
    }
    return Response.json({ ok: false, error: 'Synthetic service unavailable' }, { status: 503 });
  } });
  const geo = geolocation();
  hub.context.navigator.geolocation = geo;
  hub.context.navigator.onLine = online;
  Object.assign(hub.context, { indexedDB, Response, Event: class { constructor(type) { this.type = type; } }, dispatchEvent: event => { hub.fire(event.type); return true; } });
  vm.runInContext(source, hub.context, { filename: 'employee-offline-queue.js' });
  if (configure) hub.context.EGCHubOffline.configure({ enabled: true });
  const S = hub.api.S, quiet = () => !serving && !S.peopleRequest && !hub.context.EGCHubOffline.state().syncing;
  const settle = async () => { for (let round = 0; round < 3; round++) { await until(quiet); for (let i = 0; i < 20; i++) await idle(); } };
  const shift = entryId => S.people.timeEntries.find(entry => entry.id === entryId);
  const locations = () => posts.filter(body => body.collection === 'timeEntries' && body.data.lastLocation && !body.data.clockInAt);
  const card = () => hub.document.querySelector('.ops-clock-card')?.textContent || '';
  return { hub, S, posts, snapshots, geo, indexedDB, settle, shift, locations, card };
}
// The Hub's clock reads this time (the vm's Date), as the test module's server clock does through t.mock.timers.
const pageTime = (hub, iso) => { const fixed = Date.parse(iso); hub.context.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } }; };
const serverRecords = async cookie => (await employeeHub.onRequestGet({ env: ENV, request: jsonRequest(PATH, undefined, cookie) }).then(response => response.json())).collections.timeEntries;
// Pending sync → Discard, tapped twice to confirm, for the oldest waiting action.
const discardFirst = async p => {
  p.hub.document.querySelector('.egc-hub-sync button').click();
  const tap = () => p.hub.document.querySelector('.hs-discard');
  tap().click(); tap().click();
  await p.settle();
};
// The crew member finished onboarding, so the Hub opens on My Day with its time clock.
const onboarded = async (cookie, env = ENV) => {
  const saved = await post(cookie, { collection: 'profiles', id: CREW.toLowerCase(), data: { onboardingCompletedAt: at(-600), onboardingAcknowledgements: ['timekeeping', 'location_policy', 'safety', 'customer_care', 'hub_basics'] } }, env);
  assert.equal(saved.status, 200, await saved.clone().text());
};
const clockedIn = async (t, env, recordId) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(-120)) });
  const fire = vaultFirestore(t), cookie = await cookieFor(env, CREW);
  await onboarded(cookie, env);
  const started = await post(cookie, { collection: 'timeEntries', id: recordId, data: { ...hubClockIn(CREW, at(-120)), id: recordId } }, env);
  assert.equal(started.status, 200, await started.clone().text());
  t.mock.timers.setTime(Date.parse(NOW));
  return { fire, cookie };
};

test('Hub + server: a reload that reads the server before a queued clock-out lands never brings the shift back; it shows submitted and no position is read', async t => {
  for (const release of ['after the replay is confirmed', 'as the replay lands', 'not held']) {
    const recordId = `time-crewstatic-gps-${release.split(' ')[0]}`, { cookie } = await clockedIn(t, ENV, recordId);
    let hold = null, held = null, landed = null;
    const gate = {
      get: async () => { if (hold) { const wait = hold; hold = null; held = true; await wait; } },
      post: async body => { if (body.data.clockOutAt) landed = true; return null; },
    };
    const p = hubOnServer({ cookie, gate });
    p.hub.api.install();
    await p.settle();
    assert.equal(p.shift(recordId)?.status, 'active', release);
    assert.deepEqual(p.geo.watches, [], NO_WATCH);
    assert.equal(openShiftId(p), recordId);

    // Signal drops; the crew member clocks out.
    p.hub.context.navigator.onLine = false;
    await p.hub.context.opsClockOut();
    assert.equal(p.hub.toasts.at(-1), 'Clock-out saved on this device · 2.00 hours sync when you are back online');
    assert.deepEqual(p.geo.live(), [], `${release}: clocking out stops shift location`);

    // Signal returns and the page is shown again: the Hub's reload and the queue's replay start on the same event, and
    // the reload's read of the server is taken before the queued clock-out reaches it.
    let open = () => {};
    if (release !== 'not held') hold = new Promise(resolve => { open = resolve; });
    if (release === 'as the replay lands') gate.post = async body => { if (body.data.clockOutAt) { const response = await employeeHub.onRequestPost({ env: ENV, request: jsonRequest(PATH, body, cookie) }); landed = true; open(); return response; } return null; };
    const before = p.snapshots.length;
    p.hub.context.navigator.onLine = true;
    p.hub.document.dispatch({ type: 'visibilitychange' });
    p.hub.fire('online');
    await until(() => landed);
    if (release === 'after the replay is confirmed') { await until(() => !p.hub.context.EGCHubOffline.state().syncing && !p.indexedDB.rows(...STORE).length); open(); }
    await p.settle();
    if (release !== 'not held') {
      assert.equal(held, true, `${release}: the reload was held`);
      assert.deepEqual(p.snapshots[before], [[recordId, 'active']], `${release}: the reload read the server before the clock-out landed`);
    }
    assert.equal(p.posts.filter(body => body.data?.clockOutAt).length, 1, `${release}: the clock-out was sent once`);
    assert.deepEqual(p.indexedDB.rows(...STORE), [], release);
    assert.deepEqual(p.snapshots.at(-1), [[recordId, 'submitted']], `${release}: the Hub's last read shows the clock-out`);
    assert.equal(p.shift(recordId).status, 'submitted', `${release}: the Hub shows the shift submitted`);
    assert.equal(p.shift(recordId).pendingSync, undefined, release);
    assert.deepEqual(p.geo.watches, [], `${release}: shift location stays off`);
    assert.deepEqual(p.geo.live(), [], release); assert.deepEqual(p.geo.watches, [], `${release}: no second watch was started`);
    assert.match(p.hub.document.querySelector('.ops-clock-card')?.textContent || '', /Ready when you are/, release);
    // Later reloads keep it off, and nothing sends location for the closed shift.
    p.hub.document.dispatch({ type: 'visibilitychange' });
    await p.settle();
    assert.deepEqual(p.geo.live(), [], release); assert.deepEqual(p.locations(), [], `${release}: no location update after the clock-out`);
    t.mock.timers.reset();
  }
});

test('Hub + server: a clock-out kept after a 503 shows submitted through a reload and lands on the next pass; no position is read', async t => {
  const recordId = 'time-crewstatic-kept', { cookie } = await clockedIn(t, ENV, recordId);
  let refuse = true;
  const p = hubOnServer({ cookie, gate: { post: async body => body.data.clockOutAt && refuse ? Response.json({ ok: false, error: 'Synthetic service unavailable' }, { status: 503 }) : null } });
  p.hub.api.install();
  await p.settle();
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  await p.hub.context.opsClockOut();
  assert.equal(p.indexedDB.rows(...STORE).length, 1, 'the clock-out is kept on the device');
  assert.deepEqual(p.geo.live(), []);
  // The Hub reloads its records (as its poll does) before the queue retries: the server still has the shift open.
  p.hub.fire('egc:hub-offline-synced');
  await p.settle();
  assert.deepEqual(p.snapshots.at(-1), [[recordId, 'active']], 'the server has not seen the clock-out');
  assert.equal(p.shift(recordId).status, 'submitted', 'the kept clock-out still shows');
  assert.equal(p.shift(recordId).pendingSync, true);
  assert.deepEqual(p.geo.watches, [], 'shift location stays off for a shift with a queued clock-out');
  assert.deepEqual(p.geo.watches, []);
  refuse = false;
  await p.hub.context.EGCHubOffline.sync();
  await p.settle();
  assert.deepEqual(p.snapshots.at(-1), [[recordId, 'submitted']]);
  assert.equal(p.shift(recordId).status, 'submitted'); assert.equal(p.shift(recordId).pendingSync, undefined);
  assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.locations(), []);
  t.mock.timers.reset();
});

test('Hub + server: a queued clock-in the server refuses leaves no shift, and the next clock-in keeps its own one position; no position fix follows either', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, CREW);
  await onboarded(cookie);
  const p = hubOnServer({ cookie, online: false });
  p.hub.api.install();
  await p.settle();
  // Offline, the crew member clocks in: kept on the device with the one position the Hub read.
  await p.hub.context.opsClockIn();
  const first = openShiftId(p);
  assert.match(first, /^time-crewstatic-/);
  assert.equal(p.hub.toasts.at(-1), 'Clock-in saved on this device · it syncs when you are back online');
  assert.deepEqual(p.geo.watches, [], NO_WATCH); assert.equal(p.geo.reads.length, 1, 'one position, read at clock-in');
  // The signal returns ten minutes later; without EGC_OFFLINE_CLOCK_ENABLED the server refuses the stale time.
  t.mock.timers.setTime(Date.parse(at(10)));
  p.hub.context.navigator.onLine = true; p.hub.fire('online');
  await p.hub.context.EGCHubOffline.sync();
  await p.settle();
  assert.match(p.hub.toasts.find(text => text.startsWith('Not saved: Clock in.')) || '', /Offline clock times are not enabled/);
  assert.deepEqual(p.snapshots.at(-1), [], 'the server has no shift');
  assert.deepEqual(p.S.people.timeEntries.filter(entry => entry.status === 'active'), [], 'the Hub shows no active shift');
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  assert.match(p.hub.document.querySelector('.ops-clock-card')?.textContent || '', /Ready when you are/);
  // Clocking in again, online, reads one position for the new shift; later fixes send nothing.
  const later = Date.parse(at(10));
  p.hub.context.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [later])); } static now() { return later; } };
  await p.hub.context.opsClockIn();
  await p.settle();
  const second = openShiftId(p), [entry] = p.snapshots.at(-1);
  assert.notEqual(second, first);
  assert.deepEqual(entry, [second, 'active'], 'the server has the new shift');
  assert.equal(p.hub.toasts.at(-1), 'Clocked in · location shared once');
  assert.deepEqual(p.geo.watches, [], NO_WATCH); assert.equal(p.geo.reads.length, 2);
  assert.match(p.hub.document.querySelector('.ops-clock-card')?.textContent || '', /Location shared once at clock-in/);
  await p.geo.fix({ latitude: 40.6, longitude: -105.1, accuracy: 5 });
  await p.settle();
  assert.deepEqual(p.locations(), [], 'no position fix leaves the phone after clock-in');
  const saved = await employeeHub.onRequestGet({ env: ENV, request: jsonRequest(PATH, undefined, cookie) }).then(response => response.json()), card = saved.collections.timeEntries.find(row => row.id === second);
  assert.deepEqual([plain(card.lastLocation), card.locationStatus, card.locationTracking, card.locationTrail], [{ lat: 40.585, lng: -105.084, accuracy: 6, capturedAt: at(10) }, 'hub_single_fix', false, undefined], 'the clock-in position, once, with no trail');
  t.mock.timers.reset();
});

test('Hub: a stale tab’s own save kept on the server’s changed-account answer says who must sign in, not that it syncs when back online', async () => {
  // This tab still shows Crew.One; another tab has since signed this browser in as Crew.Other.
  const { hub, posts } = hubWithQueue({ online: true, account: 'Crew.Other', reply: () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'EMPLOYEE_HUB_ACCOUNT_CHANGED', error: 'This action was saved on this device by another account. Sign in as that employee to send it.' }) }) });
  hub.context.EGCHubOffline.configure({ enabled: true });
  hub.api.install();
  await hub.context.opsClockOut();
  assert.equal(posts.filter(body => body.collection === 'timeEntries').length, 1, 'the live save was sent once');
  assert.deepEqual(hub.toasts.filter(text => /Clock-out|Saved on this device/.test(text)), ['Saved on this device. Sign in as Crew.One to send it.']);
  const shown = hub.api.S.people.timeEntries.find(entry => entry.id === 'time-crewone-1');
  assert.equal(shown.status, 'submitted'); assert.equal(shown.pendingSync, true); assert.equal(shown.pendingAccount, undefined, 'the note is not stored on the record');
  // Offline (no account answer yet), the usual note is shown.
  const offline = hubWithQueue();
  offline.hub.context.EGCHubOffline.configure({ enabled: true });
  offline.hub.api.install();
  await offline.hub.context.opsClockOut();
  assert.equal(offline.hub.toasts.at(-1), 'Clock-out saved on this device · 2.00 hours sync when you are back online');
});

test('records() lists the viewer’s queued records oldest first as the Hub saved them, and revision() counts every change to the queue', async () => {
  const off = await page({ enabled: false });
  assert.equal(off.hub.holding(), false); assert.deepEqual(plain(await off.hub.records()), []);
  assert.equal(off.indexedDB.stats.opens, 0, 'switched off, nothing touches IndexedDB');
  const p = await page({ online: false, reply: async () => Response.json({ ok: false, error: 'Synthetic service unavailable' }, { status: 503 }) });
  assert.equal(p.hub.holding(), true);
  const start = p.hub.revision();
  const breaks = [{ startAt: at(-60), endAt: at(-45), startRequestId: 'kept-start', endRequestId: 'kept-end' }, { startAt: at(-30), endAt: '' }];
  await p.hub.send(PATH, request('timeEntries', { breaks, updatedAt: at(-30) }));
  await p.hub.send(PATH, request('teamMessages', hubMessage('Crew.One', 'Synthetic queued hello'), 'message-crewone-7'));
  await p.hub.send(PATH, request('timeEntries', hubClockOut(at(-1))));
  assert.equal(p.hub.revision(), start + 3, 'each kept action counts');
  const rows = await p.hub.records();
  assert.deepEqual(plain(rows.map(({ requestId, ...row }) => row)), [
    { collection: 'timeEntries', id: 'time-crewone-1', data: { breaks, updatedAt: at(-30) } },
    { collection: 'teamMessages', id: 'message-crewone-7', data: hubMessage('Crew.One', 'Synthetic queued hello') },
    { collection: 'timeEntries', id: 'time-crewone-1', data: hubClockOut(at(-1)) },
  ], 'without the device time or the break request ID the queue adds');
  assert.deepEqual(plain(rows.map(row => row.requestId)), p.indexedDB.rows(...STORE).sort((a, b) => a.seq - b.seq).map(row => row.requestId));
  p.net.user = 'Crew.Other';
  assert.deepEqual(plain(await p.hub.records()), [], 'another account sees none of them');
  p.net.user = 'Crew.One'; p.net.online = true;
  const kept = p.hub.revision();
  await p.hub.sync();
  assert.equal(p.hub.revision(), kept + 1, 'a retry the server did not confirm counts');
  await p.hub.discard(rows[1].requestId);
  assert.equal(p.hub.revision(), kept + 2, 'a discard counts');
  assert.deepEqual(plain((await p.hub.records()).map(row => row.id)), ['time-crewone-1', 'time-crewone-1']);
});

// ── What the Hub shows settles on the device as the queue settles each action; no position ever follows a clock-in ──

for (const who of [{ user: CREW, business: false, role: 'crew' }, { user: 'TylerG', business: true, role: 'manager' }]) {
  test(`Hub + server (${who.role}): a queued clock-in discarded offline leaves no shift at once; after reconnecting no position fix is sent and the server has no timecard`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
    vaultFirestore(t);
    const cookie = await cookieFor(ENV, who.user);
    if (who.role === 'crew') await onboarded(cookie);
    const p = hubOnServer({ cookie, online: false, network: true, ...who });
    p.hub.api.install();
    await p.settle();
    await p.hub.context.opsClockIn();
    const id = openShiftId(p);
    assert.match(id, /^time-/);
    assert.equal(p.hub.toasts.at(-1), 'Clock-in saved on this device · it syncs when you are back online');
    assert.equal(p.shift(id).pendingSync, true);
    assert.deepEqual(p.geo.watches, [], NO_WATCH);
    // Still offline, the clock-in is discarded from Pending sync: the Hub cannot reload, and does not need to.
    await discardFirst(p);
    assert.deepEqual(p.indexedDB.rows(...STORE), []);
    assert.equal(p.shift(id), undefined, 'the clock-in only this device had is gone from the Hub');
    assert.deepEqual(p.geo.watches, [], NO_WATCH);
    assert.notEqual(p.S.peopleState.error, '', 'the reload after the discard failed offline');
    // The signal returns and a position fix arrives before the Hub's next poll.
    p.hub.context.navigator.onLine = true; p.hub.fire('online');
    await p.settle();
    await p.geo.fix({ latitude: 40.6, longitude: -105.1, accuracy: 5 });
    await p.settle();
    assert.deepEqual(p.posts.filter(body => body.collection === 'timeEntries'), [], 'nothing about the discarded shift reached the server');
    assert.deepEqual(await serverRecords(cookie), [], 'the server has no timecard, not even a location-only one');
    p.hub.document.dispatch({ type: 'visibilitychange' });
    await p.settle();
    assert.deepEqual(plain(p.S.people.timeEntries.filter(entry => entry.status === 'active')), []);
    assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.geo.watches, [], 'no watch was started again');
    p.hub.api.go('my_day');
    await p.settle();
    assert.match(p.card(), /Ready when you are/);
    t.mock.timers.reset();
  });
}

test('Hub + server: a queued clock-in the server refuses no longer shows even when the reload after it fails, and no position fix goes to the refused shift', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, CREW);
  await onboarded(cookie);
  let failReads = false;
  const p = hubOnServer({ cookie, online: false, network: true, gate: { get: async () => { if (failReads) throw new TypeError('Failed to fetch'); } } });
  p.hub.api.install();
  await p.settle();
  await p.hub.context.opsClockIn();
  const refused = openShiftId(p);
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  // Ten minutes later, on a weak signal, the replay reaches the server but the Hub's reload after it does not.
  t.mock.timers.setTime(Date.parse(at(10)));
  failReads = true;
  p.hub.context.navigator.onLine = true; p.hub.fire('online');
  await p.settle();
  assert.match(p.hub.toasts.find(text => text.startsWith('Not saved: Clock in.')) || '', /Offline clock times are not enabled/);
  assert.match(p.S.peopleState.error, /Failed to fetch/, 'the reload failed');
  assert.equal(p.shift(refused), undefined, 'the refused clock-in no longer shows');
  assert.deepEqual(plain(p.S.people.timeEntries.filter(entry => entry.status === 'active')), []);
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  await p.geo.fix({ latitude: 40.6, longitude: -105.1, accuracy: 5 });
  await p.settle();
  assert.deepEqual(p.locations(), [], 'no location update for the refused shift');
  assert.deepEqual(await serverRecords(cookie), []);
  t.mock.timers.reset();
});

test('Hub + server (manager): the replay of a queued clock-in creates the shift with its one clock-in position; no position fix is sent before or after it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, 'TylerG');
  const p = hubOnServer({ cookie, online: false, network: true, user: 'TylerG', business: true, role: 'manager' });
  p.hub.api.install();
  await p.settle();
  await p.hub.context.opsClockIn();
  const id = openShiftId(p);
  // The connection is back (navigator.onLine) but the queue has not replayed yet when a position fix arrives.
  p.hub.context.navigator.onLine = true;
  await p.geo.fix({ latitude: 40.61, longitude: -105.11, accuracy: 5 });
  await p.settle();
  assert.deepEqual(p.locations(), [], 'no location update for a shift the server does not have yet');
  assert.deepEqual(await serverRecords(cookie), []);
  await p.hub.context.EGCHubOffline.sync();
  await p.settle();
  const [saved] = await serverRecords(cookie);
  assert.equal(saved.id, id); assert.equal(saved.employee, 'TylerG'); assert.equal(saved.status, 'active'); assert.equal(saved.clockInAt, NOW);
  assert.deepEqual(saved.history.map(entry => entry.action), ['manager_timecard_create'], 'the replay created the shift; no location-only record came first');
  assert.equal(p.shift(id).pendingSync, undefined, 'the confirmed clock-in no longer shows as pending');
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  await p.geo.fix({ latitude: 40.62, longitude: -105.12, accuracy: 5 });
  await p.settle();
  assert.deepEqual(p.locations(), [], 'no position fix after the clock-in either');
  const [updated] = await serverRecords(cookie);
  assert.deepEqual([plain(updated.lastLocation), updated.locationStatus, updated.locationTracking, updated.locationTrail], [{ lat: 40.585, lng: -105.084, accuracy: 6, capturedAt: NOW }, 'hub_single_fix', false, undefined], 'a manager’s card keeps the clock-in position, with no trail');
  t.mock.timers.reset();
});

test('server: a manager’s save for a timecard the server does not have must name its employee, so a location update never creates one', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, 'TylerG');
  const location = await post(cookie, { collection: 'timeEntries', id: 'time-tylerg-missing', data: { lastLocation: point, locationTrail: [point], locationStatus: 'tracking', locationUpdatedAt: NOW } });
  assert.equal(location.status, 400);
  assert.match((await location.json()).error, /needs an employee/);
  assert.deepEqual(await serverRecords(cookie), []);
  // An administrative entry that names the employee is created as before (without pay: EGC_STAFF_PAY_OWNER_ONLY keeps
  // another employee's pay the owner's).
  const entry = await post(cookie, { collection: 'timeEntries', id: 'time-crewstatic-import', data: { employee: CREW, clockInAt: at(-180), clockOutAt: at(-60), status: 'submitted', approvalStatus: 'pending' } });
  assert.equal(entry.status, 200, await entry.clone().text());
  assert.deepEqual((await serverRecords(cookie)).map(row => [row.id, row.employee, row.hours]), [['time-crewstatic-import', CREW, 2]]);
  t.mock.timers.reset();
});

test('Hub + server: a queued clock-out the server refuses keeps the time card saying it was not saved until the crew member taps Keep working or clocks out again; no position is ever sent', async t => {
  const recordId = 'time-crewstatic-paused', { cookie } = await clockedIn(t, ENV, recordId);
  const p = hubOnServer({ cookie });
  p.hub.api.install();
  await p.settle();
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  p.hub.context.navigator.onLine = false;
  await p.hub.context.opsClockOut();
  assert.equal(p.hub.toasts.at(-1), 'Clock-out saved on this device · 2.00 hours sync when you are back online');
  assert.deepEqual(p.geo.live(), []);
  // Twenty minutes later the phone reconnects; without EGC_OFFLINE_CLOCK_ENABLED the server refuses the stale time.
  t.mock.timers.setTime(Date.parse(at(20))); pageTime(p.hub, at(20));
  p.hub.context.navigator.onLine = true; p.hub.fire('online'); p.hub.document.dispatch({ type: 'visibilitychange' });
  await p.settle();
  assert.match(p.hub.toasts.find(text => text.startsWith('Not saved: Clock out.')) || '', /Offline clock times are not enabled/);
  assert.deepEqual(p.snapshots.at(-1), [[recordId, 'active']], 'the server still has the shift open');
  assert.equal(p.shift(recordId).status, 'active'); assert.equal(p.shift(recordId).pendingSync, undefined);
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  assert.match(p.card(), /Clock-out not saved — clock out again/);
  assert.match(p.card(), /Clock-out not saved/); assert.match(p.card(), /Location shared once at clock-in/);
  assert.ok(p.hub.document.querySelectorAll('.ops-clock-card button').some(button => button.getAttribute('onclick') === 'opsKeepWorking()' && button.textContent === 'Keep working'));
  // Later reloads keep saying so, and nothing sends a position.
  p.hub.document.dispatch({ type: 'visibilitychange' });
  await p.settle();
  assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.locations(), []);
  assert.match(p.card(), /Clock-out not saved/);
  // The Hub reopened in this tab remembers it.
  const reopened = hubOnServer({ cookie, indexedDB: p.indexedDB, before: context => { context.sessionStorage = p.hub.session; } });
  pageTime(reopened.hub, at(20));
  reopened.hub.api.install();
  await reopened.settle();
  assert.deepEqual(reopened.geo.watches, [], NO_WATCH);
  assert.match(reopened.card(), /Clock-out not saved — clock out again/);
  // The crew member is still working: Keep working.
  p.hub.context.opsKeepWorking();
  await p.settle();
  assert.equal(p.hub.toasts.at(-1), 'Your shift stays open');
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  assert.match(p.card(), /Location shared once at clock-in/); assert.doesNotMatch(p.card(), /Clock-out not saved/);
  // Clocking out again, online, closes the shift and forgets the pause.
  await p.hub.context.opsClockOut();
  await p.settle();
  assert.deepEqual(p.snapshots.at(-1), [[recordId, 'submitted']]);
  assert.deepEqual(p.geo.live(), []);
  assert.match(p.card(), /Ready when you are/);
  assert.equal(p.hub.session.getItem('egc_hub_location_paused'), null, 'nothing is left paused once the shift is closed');
  t.mock.timers.reset();
});

test('Hub + server: a Hub reopened after a queued clock-out expired shows it until the switch answers, then lists it as not saved and the still-open shift says so', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, CREW);
  await onboarded(cookie);
  const recordId = 'time-crewstatic-overnight', start = at(-14 * 60), closed = at(-13 * 60);
  t.mock.timers.setTime(Date.parse(start));
  assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: { ...hubClockIn(CREW, start), id: recordId } })).status, 200);
  // Yesterday evening: clocked out offline, and the phone was put away.
  t.mock.timers.setTime(Date.parse(closed));
  const indexedDB = fakeIndexedDB();
  const evening = hubOnServer({ cookie, indexedDB, before: context => pageTime({ context }, closed) });
  evening.hub.api.install();
  await evening.settle();
  evening.hub.context.navigator.onLine = false;
  await evening.hub.context.opsClockOut();
  assert.equal(indexedDB.rows(...STORE).length, 1);
  // This morning, in a new tab, before /api/hub-offline answers: the queued clock-out shows and nothing is removed.
  t.mock.timers.setTime(Date.parse(NOW));
  const morning = hubOnServer({ cookie, indexedDB, configure: false });
  morning.hub.api.install();
  await morning.settle();
  assert.equal(morning.hub.context.EGCHubOffline.state().known, false);
  assert.equal(morning.shift(recordId).status, 'submitted'); assert.equal(morning.shift(recordId).pendingSync, true);
  assert.deepEqual(morning.geo.watches, []);
  assert.equal(indexedDB.rows(...STORE).length, 1, 'an unknown switch removes nothing unannounced');
  assert.deepEqual(morning.hub.toasts, []);
  // The switch answers on: the clock-out is too old to send.
  morning.hub.context.EGCHubOffline.configure({ enabled: true });
  await morning.settle();
  assert.deepEqual(indexedDB.rows(...STORE), []);
  assert.deepEqual(morning.hub.toasts, ['Not saved: Clock out. It waited on this device for more than 12 hours, so it was not sent. Ask a manager for a time correction.']);
  assert.deepEqual(morning.posts.filter(body => body.collection === 'timeEntries'), [], 'the expired clock-out was never sent');
  assert.equal(morning.shift(recordId).status, 'active', 'the server still has the shift open');
  assert.deepEqual(morning.geo.watches, [], 'shift location never restarted for last night’s shift');
  assert.match(morning.card(), /Clock-out not saved — clock out again/);
  t.mock.timers.reset();
});

test('Hub + server: a load the queue overtakes on all three reads is shown but read once more, and the Hub’s own clock-out that landed during the third read shows submitted, with no position read', async t => {
  const recordId = 'time-crewstatic-overtaken', { cookie } = await clockedIn(t, ENV, recordId);
  const holds = [], held = [];
  let landed = false;
  const gate = {
    get: async () => { const hold = holds.shift(); if (hold) { held.push(hold); await hold.promise; } },
    post: async body => { if (!body.data?.clockOutAt) return null; const response = await employeeHub.onRequestPost({ env: ENV, request: jsonRequest(PATH, body, cookie) }); landed = true; return response; },
  };
  const p = hubOnServer({ cookie, gate });
  p.hub.api.install();
  await p.settle();
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  const hold = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
  const reads = [hold(), hold(), hold()];
  holds.push(...reads);
  const start = p.snapshots.length;
  p.hub.document.dispatch({ type: 'visibilitychange' });
  // Each read is overtaken by a crew chat message the Hub saves through the queue while it is out.
  for (const [index, read] of reads.slice(0, 2).entries()) {
    await until(() => held.includes(read));
    assert.equal((await p.hub.context.EGCHubOffline.send(PATH, request('teamMessages', hubMessage(CREW, `Synthetic update ${index}`), `message-crewstatic-${index}`))).status, 200);
    read.open();
  }
  await until(() => held.includes(reads[2]));
  assert.equal(p.snapshots.length - start, 3, 'three reads so far');
  // The third read was taken before the crew member clocks out, online; the clock-out lands while it is still out.
  const out = p.hub.context.opsClockOut();
  await until(() => landed && !p.indexedDB.rows(...STORE).length);
  for (let i = 0; i < 20; i++) await idle();
  reads[2].open();
  await out;
  await p.settle();
  assert.equal(p.hub.toasts.at(-1), 'Clocked out · 2.00 hours submitted');
  assert.deepEqual(p.snapshots.slice(start).map(rows => rows[0][1]), ['active', 'active', 'active', 'submitted'], 'a fourth read followed the overtaken third');
  assert.equal(p.shift(recordId).status, 'submitted');
  assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.geo.watches, [], 'shift location never started again, not even from the overtaken read');
  assert.match(p.card(), /Ready when you are/);
  t.mock.timers.reset();
});

test('Hub + server, switch off: the Hub’s own clock-out landing while a poll is out reads again instead of reusing the older read, so the shift shows submitted', async t => {
  const recordId = 'time-crewstatic-poll', { cookie } = await clockedIn(t, ENV, recordId);
  let hold = null;
  const p = hubOnServer({ cookie, configure: false, gate: { get: async () => { if (hold) { const wait = hold; hold = null; await wait; } } } });
  p.hub.context.EGCHubOffline.configure({ enabled: false });
  p.hub.api.install();
  await p.settle();
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  let open;
  hold = new Promise(resolve => { open = resolve; });
  const start = p.snapshots.length;
  p.hub.document.dispatch({ type: 'visibilitychange' });
  await until(() => hold === null);
  const out = p.hub.context.opsClockOut();
  await until(() => p.posts.some(body => body.data?.clockOutAt));
  for (let i = 0; i < 20; i++) await idle();
  open();
  await out;
  await p.settle();
  assert.equal(p.posts.filter(body => body.data?.clockOutAt)[0].requestId, undefined, 'switched off, the clock-out is the direct save it always was');
  assert.deepEqual(p.snapshots.slice(start).map(rows => rows[0][1]), ['active', 'submitted'], 'the save had the poll read again');
  assert.equal(p.hub.toasts.at(-1), 'Clocked out · 2.00 hours submitted');
  assert.equal(p.shift(recordId).status, 'submitted');
  assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.geo.watches, []);
  assert.match(p.card(), /Ready when you are/);
  t.mock.timers.reset();
});

test('Hub + server: a Hub opened before the offline switch answers shows a clock-out another page left queued, reads no position and removes nothing; the switch turning on sends it', async t => {
  const recordId = 'time-crewstatic-unknown', { cookie } = await clockedIn(t, ENV, recordId);
  const indexedDB = fakeIndexedDB();
  const first = hubOnServer({ cookie, indexedDB });
  first.hub.api.install();
  await first.settle();
  first.hub.context.navigator.onLine = false;
  await first.hub.context.opsClockOut();
  // Another account's message left on this device two days ago.
  const { api } = load(), box = api.create({ store: api.idbStore(indexedDB), now: clock() });
  const stale = action('Crew.Other', 'teamMessages', hubMessage('Crew.Other', 'Synthetic old note'), 'message-crewother-1', at(-48 * 60));
  await box.enqueue(stale);
  assert.equal(indexedDB.rows(...STORE).length, 2);
  const second = hubOnServer({ cookie, indexedDB, configure: false });
  second.hub.api.install();
  await second.settle();
  assert.deepEqual(plain(second.hub.context.EGCHubOffline.state()), { enabled: false, known: false, pending: [], refused: [], syncing: false });
  assert.deepEqual(second.snapshots.at(-1), [[recordId, 'active']], 'the server still has the shift open');
  assert.equal(second.shift(recordId).status, 'submitted', 'the queued clock-out shows over it');
  assert.equal(second.shift(recordId).pendingSync, true);
  assert.deepEqual(second.geo.watches, [], 'shift location never started');
  assert.match(second.card(), /Ready when you are/);
  assert.equal(indexedDB.rows(...STORE).length, 2, 'nothing is removed, not even another account’s expired message');
  assert.deepEqual(second.posts.filter(body => body.collection === 'timeEntries'), [], 'and nothing is sent');
  // A save made meanwhile goes to the network as before; the queue holds nothing new.
  assert.equal((await second.hub.context.EGCHubOffline.send(PATH, request('teamMessages', hubMessage(CREW, 'Synthetic meanwhile'), 'message-crewstatic-9'))).status, 200);
  assert.equal(second.posts.at(-1).requestId, undefined);
  assert.equal(indexedDB.rows(...STORE).length, 2);
  second.hub.context.EGCHubOffline.configure({ enabled: true });
  await second.settle();
  assert.deepEqual(indexedDB.rows(...STORE), [], 'the clock-out was sent and the expired message removed');
  assert.deepEqual(second.snapshots.at(-1), [[recordId, 'submitted']]);
  assert.equal(second.shift(recordId).status, 'submitted'); assert.equal(second.shift(recordId).pendingSync, undefined);
  assert.deepEqual(second.geo.watches, []);
  t.mock.timers.reset();
});

test('the Hub asks the offline switch again on its record polls until it answers, then never again', async () => {
  const intervals = [], asked = [];
  const replies = [async () => Response.json({ ok: false, error: 'Synthetic service unavailable' }, { status: 503 }), async () => { throw new TypeError('Failed to fetch'); }, async () => Response.json({ ok: true, enabled: true })];
  const hub = hubPage({ user: 'Crew.One', business: false, role: 'crew', before: context => {
    Object.assign(context, { Response, fetch: async url => { asked.push(url); assert.equal(url, '/api/hub-offline'); return replies.shift()(); }, setInterval: callback => { intervals.push(callback); return intervals.length; } });
  } });
  Object.assign(hub.context, { indexedDB: fakeIndexedDB(), Event: class { constructor(type) { this.type = type; } }, dispatchEvent: event => { hub.fire(event.type); return true; } });
  vm.runInContext(source, hub.context, { filename: 'employee-offline-queue.js' });
  const queue = hub.context.EGCHubOffline;
  await until(() => asked.length === 1);
  for (let i = 0; i < 20; i++) await idle();
  assert.equal(queue.state().known, false, 'the answer as the Hub loaded was a 503');
  hub.api.install();
  await until(() => intervals.some(callback => callback.name === 'pollPeople'));
  const poll = () => intervals.find(callback => callback.name === 'pollPeople')();
  poll();
  await until(() => asked.length === 2);
  for (let i = 0; i < 20; i++) await idle();
  assert.equal(queue.state().known, false, 'still no answer');
  poll();
  await until(() => queue.state().enabled);
  assert.equal(asked.length, 3);
  poll(); poll();
  for (let i = 0; i < 20; i++) await idle();
  assert.equal(asked.length, 3, 'a definite answer holds for the page');
});

test('Hub + server: a break still queued for the open shift keeps showing, and a new position on the phone sends nothing (clock-in only)', async t => {
  const recordId = 'time-crewstatic-break', { cookie } = await clockedIn(t, ENV, recordId);
  const p = hubOnServer({ cookie, gate: { post: async body => body.data?.breaks ? Response.json({ ok: false, error: 'Synthetic service unavailable' }, { status: 503 }) : null } });
  p.hub.api.install();
  await p.settle();
  await p.hub.context.opsStartBreak();
  assert.equal(p.indexedDB.rows(...STORE).length, 1, 'the break is kept after the 503');
  assert.equal(p.shift(recordId).pendingSync, true); assert.equal(p.shift(recordId).breaks.length, 1);
  await p.geo.fix({ latitude: 40.6, longitude: -105.1, accuracy: 5 });
  p.hub.document.dispatch({ type: 'visibilitychange' });
  await p.settle();
  assert.deepEqual(p.locations(), [], 'no location update: the clock-in position is the shift’s only one');
  const shown = p.shift(recordId);
  assert.equal(shown.pendingSync, true, 'the queued break still shows over the server’s record');
  assert.equal(shown.breaks.length, 1); assert.equal(shown.breaks[0].endAt, '');
  assert.deepEqual(plain(shown.lastLocation), { ...point, capturedAt: at(-120) }, 'with the clock-in position the server saved');
  t.mock.timers.reset();
});

test('before the switch answers the queue holds nothing new and removes nothing, but shows what an earlier page left queued on this device; a definite off shows nothing', async () => {
  const indexedDB = fakeIndexedDB();
  const earlier = await page({ online: false, indexedDB });
  assert.equal((await earlier.hub.send(PATH, request('timeEntries', hubClockOut(at(-1))))).status, 202);
  const { api } = load(), box = api.create({ store: api.idbStore(indexedDB), now: clock() });
  await box.enqueue(action('Crew.Other', 'teamMessages', hubMessage('Crew.Other', 'Synthetic old note'), 'message-crewother-2', at(-48 * 60)));
  const fresh = await page({ enabled: false, indexedDB });
  assert.equal(fresh.hub.state().known, false);
  assert.equal(fresh.hub.holding(), false, 'no save is held');
  assert.equal(fresh.hub.showing(), true, 'but queued records are shown');
  assert.deepEqual(plain((await fresh.hub.records()).map(row => [row.collection, row.id, row.data.status])), [['timeEntries', 'time-crewone-1', 'submitted']]);
  const response = await fresh.hub.send(PATH, request('teamMessages', hubMessage('Crew.One', 'Synthetic direct'), 'message-crewone-8'));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(fresh.posts()[0].init.body).requestId, undefined, 'a save goes to the network exactly as before');
  await fresh.hub.sync();
  assert.equal(indexedDB.rows(...STORE).length, 2, 'nothing is sent or removed, not even another account’s expired message');
  assert.equal(fresh.chip(), null);
  // A definite off shows nothing and removes expired actions, as before.
  fresh.hub.configure({ enabled: false });
  assert.equal(fresh.hub.showing(), false); assert.deepEqual(plain(await fresh.hub.records()), []);
  for (let i = 0; i < 100 && indexedDB.rows(...STORE).length > 1; i++) await idle();
  assert.deepEqual(indexedDB.rows(...STORE).map(row => row.user), ['Crew.One']);
  // A device that never had a queue is not given one while the switch is unknown.
  const never = fakeIndexedDB(), bare = await page({ enabled: false, indexedDB: never });
  assert.deepEqual(plain(await bare.hub.records()), []);
  assert.equal(never.stats.opens, 0);
});

test('settled() tells the Hub what became of each action this page saw leave the queue: applied with the server’s record, refused, expired or discarded', async () => {
  const answers = { 'time-crewone-1': [200, { ok: true, record: { id: 'time-crewone-1', status: 'submitted' } }], 'message-crewone-2': [403, { ok: false, error: 'Synthetic refusal' }] };
  const p = await page({ online: false, reply: async (url, init) => { const [status, body] = answers[JSON.parse(init.body).id]; return Response.json(body, { status }); } });
  const kept = async (collection, data, recordId) => (await (await p.hub.send(PATH, request(collection, data, recordId))).json()).requestId;
  const out = await kept('timeEntries', hubClockOut(at(-1)));
  const refused = await kept('teamMessages', hubMessage('Crew.One', 'Synthetic refused'), 'message-crewone-2');
  const dropped = await kept('teamMessages', hubMessage('Crew.One', 'Synthetic discarded'), 'message-crewone-3');
  await p.box.enqueue(action('Crew.One', 'timeEntries', hubClockOut(at(-15 * 60)), 'time-crewone-0', at(-15 * 60)));
  const expired = p.indexedDB.rows(...STORE).find(row => JSON.parse(row.body).id === 'time-crewone-0').requestId;
  assert.equal(p.hub.settled(out), null, 'still queued');
  await p.hub.discard(dropped);
  p.net.online = true;
  await p.hub.sync();
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  assert.deepEqual(plain(p.hub.settled(out)), { requestId: out, outcome: 'applied', collection: 'timeEntries', id: 'time-crewone-1', clockIn: false, clockOut: true, record: { id: 'time-crewone-1', status: 'submitted' } });
  assert.deepEqual(plain(p.hub.settled(refused)), { requestId: refused, outcome: 'refused', collection: 'teamMessages', id: 'message-crewone-2', clockIn: false, clockOut: false, record: null });
  assert.deepEqual(plain(p.hub.settled(dropped)), { requestId: dropped, outcome: 'discarded', collection: 'teamMessages', id: 'message-crewone-3', clockIn: false, clockOut: false, record: null });
  assert.deepEqual(plain(p.hub.settled(expired)), { requestId: expired, outcome: 'expired', collection: 'timeEntries', id: 'time-crewone-0', clockIn: false, clockOut: true, record: null });
  assert.deepEqual(plain(p.hub.settled().map(row => row.outcome)), ['discarded', 'expired', 'applied', 'refused'], 'oldest first');
  assert.equal(p.posts().length, 2, 'the expired clock-out was never sent');
  p.fire('egc:signout');
  assert.deepEqual(plain(p.hub.settled()), [], 'signing out forgets them');
});

test('Hub + server: a clock-out that expired on the device is shown as not saved before a replay pass sends anything, so a Hub load during a slow pass never shows the shift clocked out', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, CREW);
  await onboarded(cookie);
  const recordId = 'time-crewstatic-slowpass', start = at(-14 * 60), closed = at(-13 * 60);
  t.mock.timers.setTime(Date.parse(start));
  assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: { ...hubClockIn(CREW, start), id: recordId } })).status, 200);
  t.mock.timers.setTime(Date.parse(closed));
  const indexedDB = fakeIndexedDB();
  const evening = hubOnServer({ cookie, indexedDB, before: context => pageTime({ context }, closed) });
  evening.hub.api.install();
  await evening.settle();
  evening.hub.context.navigator.onLine = false;
  await evening.hub.context.opsClockOut();
  assert.equal((await evening.hub.context.EGCHubOffline.send(PATH, request('teamMessages', hubMessage(CREW, 'Synthetic evening note'), 'message-crewstatic-evening'))).status, 202);
  // This morning the switch answers on as the Hub opens, and the account check before the pass sends the (still
  // fresh) message is slow.
  t.mock.timers.setTime(Date.parse(NOW));
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const morning = hubOnServer({ cookie, indexedDB, gate: { auth: () => slow } });
  morning.hub.api.install();
  await until(() => !morning.S.peopleRequest && morning.snapshots.length);
  for (let i = 0; i < 40; i++) await idle();
  assert.equal(morning.hub.context.EGCHubOffline.state().syncing, true, 'the pass is still under way');
  assert.deepEqual(morning.hub.toasts, ['Not saved: Clock out. It waited on this device for more than 12 hours, so it was not sent. Ask a manager for a time correction.']);
  assert.deepEqual(morning.snapshots.at(-1), [[recordId, 'active']]);
  assert.deepEqual(morning.geo.watches, [], 'the Hub load during the pass did not start shift location for last night’s shift');
  assert.match(morning.card(), /Clock-out not saved — clock out again/);
  const queuedPosts = () => morning.posts.filter(body => ['timeEntries', 'teamMessages'].includes(body.collection));
  assert.deepEqual(queuedPosts(), [], 'nothing was sent yet');
  release();
  await morning.settle();
  assert.deepEqual(queuedPosts().map(body => body.collection), ['teamMessages'], 'the message was sent, the expired clock-out never');
  assert.deepEqual(indexedDB.rows(...STORE), []);
  assert.deepEqual(morning.geo.watches, []);
  t.mock.timers.reset();
});

test('Hub: a stale tab’s clock-in kept for the account that saved it sends no position fix while another account holds the sign-in', async () => {
  const closed = { id: 'time-crewone-0', employee: 'Crew.One', status: 'submitted', approvalStatus: 'pending', clockInAt: at(-240), clockOutAt: at(-180), hourlyRate: 20, breaks: [] };
  const { hub, posts } = hubWithQueue({ online: true, account: 'Crew.Other', entry: closed, reply: () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'EMPLOYEE_HUB_ACCOUNT_CHANGED', error: 'This action was saved on this device by another account. Sign in as that employee to send it.' }) }) });
  const geo = geolocation();
  hub.context.navigator.geolocation = geo;
  hub.context.EGCHubOffline.configure({ enabled: true });
  hub.api.install();
  await hub.context.opsClockIn();
  assert.equal(hub.toasts.at(-1), 'Saved on this device. Sign in as Crew.One to send it.');
  const id = openShiftId({ S: hub.api.S });
  assert.equal(hub.api.S.people.timeEntries.find(entry => entry.id === id).pendingSync, true);
  assert.equal(posts.filter(body => body.collection === 'timeEntries').length, 1, 'only the clock-in’s live attempt');
  await geo.fix({ latitude: 40.6, longitude: -105.1, accuracy: 5 });
  for (let i = 0; i < 20; i++) await idle();
  assert.equal(posts.filter(body => body.collection === 'timeEntries').length, 1, 'no location update or status goes out');
  assert.deepEqual(geo.watches, [], NO_WATCH); assert.equal(geo.reads.length, 1, 'the one position read at clock-in');
});

// ── A queued clock-in carries the clock actions queued after it for the same shift ──

test('discarding a queued clock-in also discards the clock actions queued after it for that shift; other shifts, messages and other accounts’ actions stay', async () => {
  const { box, indexedDB } = queue();
  const clockIn = action('Crew.One', 'timeEntries', hubClockIn('Crew.One', at(-30)), 'time-crewone-9');
  const onBreak = action('Crew.One', 'timeEntries', { breaks: [{ startAt: at(-20), endAt: '' }], updatedAt: at(-20) }, 'time-crewone-9');
  const note = action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic note'), 'message-crewone-9');
  const out = action('Crew.One', 'timeEntries', hubClockOut(at(-10)), 'time-crewone-9');
  const otherShift = action('Crew.One', 'timeEntries', hubClockOut(at(-5)), 'time-crewone-8');
  const otherAccount = action('Crew.Other', 'timeEntries', hubClockOut(at(-5)), 'time-crewone-9');
  for (const item of [clockIn, onBreak, note, out, otherShift, otherAccount]) await box.enqueue(item);
  const start = box.revision();
  const gone = await box.discard(clockIn.requestId);
  assert.deepEqual(plain(gone.map(item => item.requestId)), [clockIn.requestId, onBreak.requestId, out.requestId]);
  assert.deepEqual(indexedDB.rows(...STORE).map(row => row.requestId).sort(), [note, otherShift, otherAccount].map(item => item.requestId).sort());
  assert.equal(box.revision(), start + 1);
  // A clock action discarded on its own takes nothing with it.
  assert.deepEqual(plain((await box.discard(otherShift.requestId)).map(item => item.requestId)), [otherShift.requestId]);
  assert.equal(indexedDB.rows(...STORE).length, 2);
});

test('a queued clock-in the server refuses takes the clock actions queued after it for that shift with it, unsent and listed as not saved; the other actions still go', async () => {
  const p = await page({ online: false, reply: async (url, init) => JSON.parse(init.body).data.clockInAt ? Response.json({ ok: false, error: 'Synthetic refusal' }, { status: 403 }) : Response.json({ ok: true, record: {} }) });
  const kept = async (collection, data, recordId) => (await (await p.hub.send(PATH, request(collection, data, recordId))).json()).requestId;
  const clockIn = await kept('timeEntries', hubClockIn('Crew.One', at(-30)), 'time-crewone-9');
  const onBreak = await kept('timeEntries', { breaks: [{ startAt: at(-20), endAt: '' }], updatedAt: at(-20) }, 'time-crewone-9');
  const note = await kept('teamMessages', hubMessage('Crew.One', 'Synthetic note'), 'message-crewone-9');
  const out = await kept('timeEntries', hubClockOut(at(-10)), 'time-crewone-9');
  assert.equal(p.indexedDB.rows(...STORE).length, 4);
  p.net.online = true;
  await p.hub.sync();
  assert.deepEqual(p.posts().map(call => JSON.parse(call.init.body).id), ['time-crewone-9', 'message-crewone-9'], 'the clock-in was sent and refused, the message went, the break and clock-out never did');
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  assert.deepEqual(p.toasts, [
    'Not saved: Clock in. Synthetic refusal',
    'Not saved: Start break. The clock-in for this shift was not saved, so this was not sent.',
    'Not saved: Clock out. The clock-in for this shift was not saved, so this was not sent.',
  ]);
  assert.deepEqual(plain(p.hub.state().refused.map(row => row.label)), ['Clock in', 'Start break', 'Clock out']);
  assert.deepEqual(plain([clockIn, onBreak, note, out].map(requestId => { const done = p.hub.settled(requestId); return [done.outcome, done.clockIn, done.clockOut]; })), [['refused', true, false], ['refused', false, false], ['applied', false, false], ['refused', false, true]]);
});

test('a queued clock-in that waited more than 12 hours takes the clock actions queued after it for that shift with it, even ones not yet that old', async () => {
  const p = await page({ online: false });
  await p.box.enqueue(action('Crew.One', 'timeEntries', hubClockIn('Crew.One', at(-13 * 60)), 'time-crewone-9', at(-13 * 60)));
  await p.box.enqueue(action('Crew.One', 'timeEntries', hubClockOut(at(-11 * 60)), 'time-crewone-9', at(-11 * 60)));
  await p.box.enqueue(action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic note'), 'message-crewone-9', at(-11 * 60)));
  p.net.online = true;
  await p.hub.sync();
  assert.deepEqual(p.posts().map(call => JSON.parse(call.init.body).collection), ['teamMessages'], 'only the message, which may wait a day, was sent');
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  assert.deepEqual(p.toasts, [
    'Not saved: timeEntries. It waited on this device for more than 12 hours, so it was not sent. Ask a manager for a time correction.',
    'Not saved: timeEntries. The clock-in for this shift waited on this device for more than 12 hours and was not sent, so this was not sent either.',
  ]);
});

for (const who of [{ user: CREW, business: false, role: 'crew' }, { user: 'TylerG', business: true, role: 'manager' }]) {
  test(`Hub + server (${who.role}): discarding a queued clock-in discards the clock-out queued after it for that shift; no orphan record shows, nothing is sent and no misleading notice follows`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
    vaultFirestore(t);
    const cookie = await cookieFor(ENV, who.user);
    if (who.role === 'crew') await onboarded(cookie);
    const p = hubOnServer({ cookie, online: false, network: true, ...who });
    p.hub.api.install();
    await p.settle();
    await p.hub.context.opsClockIn();
    const id = openShiftId(p);
    await p.hub.context.opsClockOut();
    assert.equal(p.indexedDB.rows(...STORE).length, 2);
    assert.equal(p.shift(id).status, 'submitted'); assert.equal(p.shift(id).pendingSync, true);
    p.hub.document.querySelector('.egc-hub-sync button').click();
    const tap = () => p.hub.document.querySelector('.hs-discard');
    tap().click();
    assert.equal(tap().textContent, 'Tap again to discard this shift', 'the clock-in’s Discard says the whole shift goes');
    tap().click();
    await p.settle();
    assert.deepEqual(p.indexedDB.rows(...STORE), [], 'the clock-out queued for that shift went with its clock-in');
    assert.equal(p.shift(id), undefined, 'no orphan record without an employee or a clock-in time');
    assert.deepEqual(plain(p.S.people.timeEntries.filter(entry => entry.pendingSync)), []);
    assert.deepEqual(p.geo.live(), []);
    assert.equal(p.hub.session.getItem('egc_hub_location_paused'), null, 'nothing is paused for a shift the server never had');
    p.hub.context.navigator.onLine = true; p.hub.fire('online');
    await p.hub.context.EGCHubOffline.sync();
    await p.settle();
    assert.deepEqual(p.posts.filter(body => body.collection === 'timeEntries'), [], 'nothing about the discarded shift was sent');
    assert.deepEqual(p.hub.toasts.filter(text => text.startsWith('Not saved')), [], 'and no notice about a clock-out refused for a shift the server does not have');
    assert.deepEqual(await serverRecords(cookie), []);
    p.hub.document.dispatch({ type: 'visibilitychange' });
    await p.settle();
    assert.deepEqual(plain(p.S.people.timeEntries), []);
    p.hub.api.go('my_day');
    await p.settle();
    assert.match(p.card(), /Ready when you are/);
    t.mock.timers.reset();
  });

  test(`Hub + server (${who.role}): a queued clock-in the server refuses takes its queued clock-out with it: one request, a clear notice for each, and no record or location on the server`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
    vaultFirestore(t);
    const cookie = await cookieFor(ENV, who.user);
    if (who.role === 'crew') await onboarded(cookie);
    const gate = { post: async body => body.data?.clockInAt ? Response.json({ ok: false, error: 'Synthetic refusal' }, { status: 403 }) : null };
    const p = hubOnServer({ cookie, online: false, network: true, gate, ...who });
    p.hub.api.install();
    await p.settle();
    await p.hub.context.opsClockIn();
    const id = openShiftId(p);
    await p.hub.context.opsClockOut();
    p.hub.context.navigator.onLine = true; p.hub.fire('online');
    await p.hub.context.EGCHubOffline.sync();
    await p.settle();
    assert.deepEqual(p.posts.filter(body => body.collection === 'timeEntries').map(body => [body.id, Boolean(body.data.clockInAt), Boolean(body.data.clockOutAt)]), [[id, true, false]], 'only the clock-in was sent');
    assert.deepEqual(p.hub.toasts.filter(text => text.startsWith('Not saved')), ['Not saved: Clock in. Synthetic refusal', 'Not saved: Clock out. The clock-in for this shift was not saved, so this was not sent.']);
    assert.deepEqual(p.indexedDB.rows(...STORE), []);
    assert.equal(p.shift(id), undefined); assert.deepEqual(p.geo.live(), []);
    assert.equal(p.hub.session.getItem('egc_hub_location_paused'), null);
    assert.deepEqual(await serverRecords(cookie), []);
    t.mock.timers.reset();
  });
}

// ── Shift location never outlives the shift: the Hub's own clock save, and another Hub tab's queued clock-out ──

// The crew chat composer as the Hub renders it: opsSendChat reads the form's body and disables its button while sending.
const chatSubmit = (hub, text) => {
  const form = hub.document.createElement('form'), input = hub.document.createElement('textarea'), button = hub.document.createElement('button');
  input.setAttribute('name', 'body'); input.value = text; form.append(input, button); form.reset = () => { input.value = ''; };
  return { preventDefault() {}, currentTarget: form };
};
// The shift the tests below start on the server two hours before NOW, with its clock-in position taken then.
const openShift = async (t, who, recordId) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(-120)) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, who.user);
  if (who.role === 'crew') await onboarded(cookie);
  const where = { ...point, capturedAt: at(-120) };
  const started = await post(cookie, { collection: 'timeEntries', id: recordId, data: { ...hubClockIn(who.user, at(-120)), id: recordId, lastLocation: where, locationTrail: [where] } });
  assert.equal(started.status, 200, await started.clone().text());
  t.mock.timers.setTime(Date.parse(NOW));
  return cookie;
};
const clockInPosition = { lat: 40.58, lng: -105.08, accuracy: 5, capturedAt: at(-120) };

for (const who of [{ user: CREW, business: false, role: 'crew' }, { user: 'TylerG', business: true, role: 'manager' }]) {
  test(`Hub + server (${who.role}): a chat that settles while the Hub’s own online clock-out is still reloading never brings the shift back from the older records, and no position fix leaves the phone`, async t => {
    const recordId = `time-${who.role}-inflight`, cookie = await openShift(t, who, recordId);
    const hold = () => { const gate = { held: false }; gate.promise = new Promise(resolve => { gate.open = resolve; }); return gate; };
    const slowPost = hold(), slowReload = hold();
    let reloads = false;
    const gate = {
      post: async body => { if (body.data?.clockOutAt && !slowPost.held) { slowPost.held = true; await slowPost.promise; } return null; },
      get: async () => { if (reloads && !slowReload.held) { slowReload.held = true; await slowReload.promise; } },
    };
    const p = hubOnServer({ cookie, gate, ...who });
    p.hub.api.install();
    await p.settle();
    assert.deepEqual(p.geo.watches, [], NO_WATCH);
    // Online on a weak signal: the clock-out's request is slow, and a chat message sent meanwhile waits behind it.
    const out = p.hub.context.opsClockOut();
    await until(() => slowPost.held);
    assert.deepEqual(p.geo.live(), [], 'clocking out stops shift location at once');
    const chat = p.hub.context.opsSendChat(chatSubmit(p.hub, 'Synthetic heading back'));
    await until(() => p.indexedDB.rows(...STORE).length === 2);
    // The clock-out lands and the message goes out right behind it, while the Hub's reload after the save is slow.
    reloads = true;
    slowPost.open();
    await until(() => slowReload.held);
    for (let i = 0; i < 40; i++) await idle();
    assert.deepEqual(p.indexedDB.rows(...STORE), [], 'both were sent');
    assert.deepEqual(p.geo.live(), [], 'the settled message did not restart shift location from the records read before the clock-out');
    await p.geo.fix({ latitude: 40.8, longitude: -105.3, accuracy: 5 });
    for (let i = 0; i < 20; i++) await idle();
    slowReload.open();
    await out; await chat;
    await p.settle();
    assert.deepEqual(p.locations(), [], 'no position fix left the phone after the clock-out');
    assert.deepEqual(p.geo.watches, [], 'shift location was never started again');
    assert.equal(p.hub.toasts.find(text => text.startsWith('Clocked out')), 'Clocked out · 2.00 hours submitted');
    assert.equal(p.shift(recordId).status, 'submitted');
    const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
    assert.deepEqual([saved.status, saved.locationStatus, saved.locationTracking], ['submitted', 'stopped', false]);
    assert.deepEqual(plain(saved.lastLocation), clockInPosition, 'the card keeps the position taken while the shift was open');
    t.mock.timers.reset();
  });

  test(`Hub + server (${who.role}): another Hub tab sends no position fix for a shift clocked out offline in this tab; shown again after the replay, it reads the shift closed`, async t => {
    const recordId = `time-${who.role}-twotabs`, cookie = await openShift(t, who, recordId);
    const indexedDB = fakeIndexedDB();
    const A = hubOnServer({ cookie, indexedDB, network: true, ...who }), B = hubOnServer({ cookie, indexedDB, network: true, ...who });
    A.hub.api.install(); B.hub.api.install();
    await A.settle(); await B.settle();
    assert.deepEqual(A.geo.watches, [], NO_WATCH); assert.deepEqual(B.geo.watches, [], NO_WATCH);
    // The signal drops and the shift is clocked out in tab A; tab B is not told.
    A.hub.context.navigator.onLine = false; B.hub.context.navigator.onLine = false;
    await A.hub.context.opsClockOut();
    assert.equal(A.hub.toasts.at(-1), 'Clock-out saved on this device · 2.00 hours sync when you are back online');
    assert.equal(indexedDB.rows(...STORE).length, 1);
    assert.equal(B.shift(recordId).status, 'active'); assert.deepEqual(B.geo.watches, [], NO_WATCH);
    // The signal returns, and tab B's next position fix comes before tab A replays.
    A.hub.context.navigator.onLine = true; B.hub.context.navigator.onLine = true;
    await B.geo.fix({ latitude: 40.7, longitude: -105.2, accuracy: 5 });
    for (let i = 0; i < 20; i++) await idle();
    assert.deepEqual(B.locations(), [], 'tab B sent no position fix: nothing follows the shift after clock-in');
    A.hub.fire('online');
    await A.settle();
    assert.deepEqual(indexedDB.rows(...STORE), [], 'tab A sent the clock-out');
    await B.geo.fix({ latitude: 40.71, longitude: -105.21, accuracy: 5 });
    B.hub.document.dispatch({ type: 'visibilitychange' });
    await B.settle();
    assert.deepEqual(B.locations(), []); assert.deepEqual(B.geo.watches, [], NO_WATCH);
    assert.equal(B.shift(recordId).status, 'submitted'); assert.equal(B.shift(recordId).pendingSync, undefined);
    const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
    assert.deepEqual([saved.status, saved.locationStatus, saved.locationTracking], ['submitted', 'stopped', false]);
    assert.deepEqual(plain(saved.lastLocation), clockInPosition);
    t.mock.timers.reset();
  });
}

// CREW-TIME replaced the HUB-PWA test of a watch's location error in a stale tab: there is no watch to report one.
test('Hub: Keep working on an open shift (even one an older build tracked) reads no position and starts no watch', async () => {
  const { hub, posts } = hubWithQueue({ online: true });
  const geo = geolocation();
  hub.context.navigator.geolocation = geo;
  hub.context.EGCHubOffline.configure({ enabled: true });
  hub.api.install();
  await hub.flush();
  hub.api.S.people.timeEntries = [{ id: 'time-crewone-1', employee: 'Crew.One', status: 'active', approvalStatus: 'open', clockInAt: at(-120), clockOutAt: '', hourlyRate: 20, breaks: [], locationTracking: true, locationStatus: 'tracking', lastLocation: point }];
  hub.context.opsKeepWorking();
  await geo.fix({ latitude: 40.7, longitude: -105.2, accuracy: 5 });
  for (let i = 0; i < 20; i++) await idle();
  assert.deepEqual(geo.watches, [], NO_WATCH); assert.deepEqual(geo.reads, [], 'no position read after clock-in');
  assert.deepEqual(posts.filter(body => 'lastLocation' in body.data || 'locationError' in body.data), [], 'no location went out');
  assert.equal(hub.toasts.at(-1), 'Your shift stays open');
});

test('server: a closed shift’s location is final for a manager too; a position fix, trail, error or status sent after the clock-out is refused and the card keeps its clock-out location', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(-120)) });
  vaultFirestore(t);
  const managerCookie = await cookieFor(ENV, 'TylerG'), crewCookie = await cookieFor(ENV, CREW);
  await onboarded(crewCookie);
  const where = { ...point, capturedAt: at(-120) };
  for (const [cookie, user] of [[managerCookie, 'TylerG'], [crewCookie, CREW]]) {
    t.mock.timers.setTime(Date.parse(at(-120)));
    const recordId = `time-${user.toLowerCase().replace(/\W/g, '')}-closed`;
    assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: { ...hubClockIn(user, at(-120)), id: recordId, lastLocation: where, locationTrail: [where] } })).status, 200);
    t.mock.timers.setTime(Date.parse(NOW));
    assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: hubClockOut(NOW) })).status, 200);
    const closed = (await serverRecords(managerCookie)).find(row => row.id === recordId);
    assert.deepEqual([closed.status, closed.locationStatus], ['submitted', 'stopped']);
    t.mock.timers.setTime(Date.parse(at(5)));
    const late = { lat: 40.8, lng: -105.3, accuracy: 5, capturedAt: at(5) };
    for (const data of [
      { lastLocation: late, locationTrail: [late], locationStatus: 'tracking', locationUpdatedAt: at(5) },
      { locationStatus: 'unavailable', locationError: 'Synthetic location timeout', locationUpdatedAt: at(5) },
      { lastLocation: late }, { locationTrail: [late] }, { locationStatus: 'tracking' }, { locationTracking: true },
    ]) {
      const reply = await post(cookie, { collection: 'timeEntries', id: recordId, data });
      if (user === 'TylerG') { assert.equal(reply.status, 409, JSON.stringify(data)); assert.match((await reply.json()).error, /shift is closed/); }
      else assert.equal(reply.status, 403, 'the crew member’s closed card was already refused');
    }
    const after = (await serverRecords(managerCookie)).find(row => row.id === recordId);
    assert.deepEqual(plain(after), plain(closed), 'nothing about the closed card changed');
  }
  // The manager's other saves to a closed card work as before: a clock-out replay, values it already has, an approval.
  const recordId = 'time-tylerg-closed', closed = (await serverRecords(managerCookie)).find(row => row.id === recordId);
  assert.equal((await post(managerCookie, { collection: 'timeEntries', id: recordId, data: hubClockOut(NOW) })).status, 200);
  assert.equal((await post(managerCookie, { collection: 'timeEntries', id: recordId, data: { lastLocation: closed.lastLocation, locationTrail: closed.locationTrail, locationStatus: 'stopped', locationTracking: false } })).status, 200);
  const approved = await post(managerCookie, { collection: 'timeEntries', id: 'time-crewstatic-closed', data: { approvalStatus: 'approved' } });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal((await approved.json()).record.approvalStatus, 'approved');
  t.mock.timers.reset();
});

// ── HUB_OFFLINE_ENABLED turned off after it was on: what a device still has queued is held, and the Hub says so ──

test('Hub + server: offline saving switched off with a clock-out still queued on the device: it is held, never sent, and the crew member is told to clock out again', async t => {
  const told = 'A clock-out saved on this device was not sent because offline saving is off — clock out again.';
  for (const order of ['answered before the Hub loads', 'answered after the Hub shows it']) {
    const recordId = `time-crewstatic-rollback-${order.split(' ')[1]}`, { cookie } = await clockedIn(t, ENV, recordId);
    const indexedDB = fakeIndexedDB();
    const first = hubOnServer({ cookie, indexedDB, network: true });
    first.hub.api.install();
    await first.settle();
    first.hub.context.navigator.onLine = false;
    await first.hub.context.opsClockOut();
    assert.equal(first.hub.toasts.at(-1), 'Clock-out saved on this device · 2.00 hours sync when you are back online');
    // The owner turns HUB_OFFLINE_ENABLED off; the crew member opens the Hub again, online.
    const next = hubOnServer({ cookie, indexedDB, configure: false });
    const off = () => next.hub.context.EGCHubOffline.configure({ enabled: false });
    if (order === 'answered before the Hub loads') off();
    next.hub.api.install();
    await next.settle();
    if (order === 'answered after the Hub shows it') {
      assert.equal(next.shift(recordId).status, 'submitted', 'before the switch answers, the queued clock-out shows');
      assert.deepEqual(next.geo.watches, []);
      off();
      await next.settle();
    }
    assert.deepEqual(next.snapshots.at(-1), [[recordId, 'active']], 'the server still has the shift open');
    assert.equal(next.shift(recordId).status, 'active'); assert.equal(next.shift(recordId).pendingSync, undefined, 'the Hub shows the server’s records');
    assert.deepEqual(next.geo.watches, [], 'shift location never started for the shift clocked out on this device');
    assert.equal(indexedDB.rows(...STORE).length, 1, 'the clock-out is held on the device');
    assert.deepEqual(next.posts.filter(body => body.collection === 'timeEntries'), [], 'and never sent while the switch is off');
    assert.deepEqual(next.hub.toasts, [told]);
    assert.match(next.card(), /Clock-out not saved — clock out again/); assert.match(next.card(), /Clock-out not saved/);
    const chip = next.hub.document.querySelector('.egc-hub-sync');
    assert.ok(!chip || chip.hidden, 'no Pending sync chip while the switch is off');
    // Later reloads tell it once and start nothing.
    next.hub.document.dispatch({ type: 'visibilitychange' });
    await next.settle();
    assert.deepEqual(next.hub.toasts, [told]); assert.deepEqual(next.geo.watches, []);
    // Clocking out again closes the shift with a direct save, as with the switch off.
    await next.hub.context.opsClockOut();
    await next.settle();
    assert.deepEqual(next.snapshots.at(-1), [[recordId, 'submitted']]);
    assert.equal(next.posts.find(body => body.data?.clockOutAt).requestId, undefined);
    assert.deepEqual(next.geo.watches, []); assert.deepEqual(next.locations(), []);
    assert.match(next.card(), /Ready when you are/);
    t.mock.timers.reset();
  }
});

test('Hub + server: offline saving switched off with a clock-out that waited more than 12 hours: it is removed, listed as not saved, and the still-open shift says its clock-out was not saved', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, CREW);
  await onboarded(cookie);
  const recordId = 'time-crewstatic-rollback-old', start = at(-14 * 60), closed = at(-13 * 60);
  t.mock.timers.setTime(Date.parse(start));
  assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: { ...hubClockIn(CREW, start), id: recordId } })).status, 200);
  t.mock.timers.setTime(Date.parse(closed));
  const indexedDB = fakeIndexedDB();
  const evening = hubOnServer({ cookie, indexedDB, before: context => pageTime({ context }, closed) });
  evening.hub.api.install();
  await evening.settle();
  evening.hub.context.navigator.onLine = false;
  await evening.hub.context.opsClockOut();
  t.mock.timers.setTime(Date.parse(NOW));
  const morning = hubOnServer({ cookie, indexedDB, configure: false });
  morning.hub.context.EGCHubOffline.configure({ enabled: false });
  morning.hub.api.install();
  await morning.settle();
  assert.deepEqual(indexedDB.rows(...STORE), [], 'the expired clock-out was removed');
  assert.deepEqual(morning.hub.toasts, ['Not saved: Clock out. It waited on this device for more than 12 hours, so it was not sent. Ask a manager for a time correction.']);
  assert.deepEqual(morning.posts.filter(body => body.collection === 'timeEntries'), []);
  assert.equal(morning.shift(recordId).status, 'active');
  assert.deepEqual(morning.geo.watches, [], 'shift location never restarted for last night’s shift');
  assert.match(morning.card(), /Clock-out not saved — clock out again/);
  t.mock.timers.reset();
});

test('Hub + server: offline saving switched off with a clock-in still queued on the device: no shift starts for it and the crew member is told to clock in again', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, CREW);
  await onboarded(cookie);
  const indexedDB = fakeIndexedDB();
  const first = hubOnServer({ cookie, indexedDB, online: false, network: true });
  first.hub.api.install();
  await first.settle();
  await first.hub.context.opsClockIn();
  assert.equal(first.hub.toasts.at(-1), 'Clock-in saved on this device · it syncs when you are back online');
  const next = hubOnServer({ cookie, indexedDB, configure: false });
  next.hub.context.EGCHubOffline.configure({ enabled: false });
  next.hub.api.install();
  await next.settle();
  assert.deepEqual(next.snapshots.at(-1), [], 'the server has no shift');
  assert.deepEqual(next.hub.toasts, ['A clock-in saved on this device was not sent because offline saving is off — clock in again if you are working, or ask a manager for a time correction.']);
  assert.deepEqual(next.geo.watches, []);
  assert.equal(indexedDB.rows(...STORE).length, 1);
  assert.deepEqual(next.posts.filter(body => body.collection === 'timeEntries'), []);
  assert.equal(next.hub.session.getItem('egc_hub_location_paused'), null);
  assert.match(next.card(), /Ready when you are/);
  t.mock.timers.reset();
});

// ── Third review: a stale tab after another tab's replayed clock-out, resuming a held shift, a lost clock-in reply,
// superseded held actions, and each defence that keeps shift location from starting on records read before a clock-out ──

// A promise the test opens when it chooses (held reports whether the code under test is waiting on it).
const gateHold = () => { const gate = { held: false }; gate.promise = new Promise(resolve => { gate.open = resolve; }); return gate; };
// The Hub's clock and the server's move together to that many minutes after NOW.
const later = (t, minutes, ...pages) => { t.mock.timers.setTime(Date.parse(at(minutes))); for (const p of pages) pageTime(p.hub, at(minutes)); };
const clockInKind = body => body.data?.clockOutAt ? 'clock-out' : body.data?.clockInAt ? 'clock-in' : body.data?.lastLocation ? 'location' : body.data?.breaks ? 'break' : 'other';
// The Hub's first load is followed by its profile save and a second load; this waits for both, so a test that makes the
// Hub's records stale starts from settled ones.
const ready = async (...pages) => { for (const p of pages) { await until(() => p.snapshots.length >= 2 && p.posts.some(body => body.collection === 'profiles') && !p.S.peopleRequest, 4000); await p.settle(); } };

test('a queue from before clock-out records (version 1) is upgraded in place: its actions stay and are sent, and a clock-out queued now is remembered for 12 hours after it leaves the queue', async () => {
  const indexedDB = fakeIndexedDB(), { api } = load();
  // An earlier build made the database with the request store only, and left a message in it.
  const kept = { ...action('Crew.One', 'teamMessages', hubMessage('Crew.One', 'Synthetic kept'), 'message-crewone-3'), live: '', kind: 'message', label: 'Crew chat message', queuedAt: at(-5), seq: 1, attempts: 0, lastStatus: 0, waiting: '' };
  await new Promise(resolve => {
    const open = indexedDB.open('egc-hub-offline', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('requests', { keyPath: 'requestId' });
    open.onsuccess = () => { const tx = open.result.transaction('requests', 'readwrite'); tx.objectStore('requests').put(kept); tx.oncomplete = () => { open.result.close(); resolve(); }; };
  });
  let tick = Date.parse(NOW);
  const box = api.create({ store: api.idbStore(indexedDB), now: () => new Date(tick) });
  assert.deepEqual(plain((await box.items('Crew.One')).map(item => item.requestId)), [kept.requestId], 'the queued message is still there');
  assert.equal(indexedDB.stored.get('egc-hub-offline').version, 2);
  const out = action('Crew.One', 'timeEntries', hubClockOut(NOW), 'time-crewone-1');
  await box.enqueue(out);
  assert.deepEqual(indexedDB.rows('egc-hub-offline', 'clockOuts'), [{ requestId: out.requestId, user: 'Crew.One', id: 'time-crewone-1', at: NOW }], 'written with the clock-out, in one write');
  const sent = wire();
  await box.flush({ user: 'Crew.One', transport: sent.transport });
  assert.deepEqual(sent.calls.map(call => JSON.parse(call.body).id), ['message-crewone-3', 'time-crewone-1']);
  assert.deepEqual(indexedDB.rows(...STORE), []);
  assert.equal((await box.clockedOut('crew.one', 'time-crewone-1'))?.requestId, out.requestId, 'the clock-out is remembered after it was sent');
  assert.equal(await box.clockedOut('Crew.Other', 'time-crewone-1'), null, 'for the account that saved it only');
  assert.equal(await box.clockedOut('Crew.One', 'time-crewone-2'), null);
  tick += 12 * 3600000 + 1;
  assert.equal(await box.clockedOut('Crew.One', 'time-crewone-1'), null, 'for 12 hours');
  // The next clock-out written drops records that old.
  await box.enqueue(action('Crew.One', 'timeEntries', hubClockOut(at(12 * 60)), 'time-crewone-2'));
  assert.deepEqual(indexedDB.rows('egc-hub-offline', 'clockOuts').map(row => row.id), ['time-crewone-2']);
  await box.forget('Crew.One', 'time-crewone-2');
  assert.deepEqual(indexedDB.rows('egc-hub-offline', 'clockOuts'), [], 'Keep working on the shift forgets it');
});

for (const who of [{ user: CREW, business: false, role: 'crew' }, { user: 'TylerG', business: true, role: 'manager' }]) {
  test(`Hub + server (${who.role}): a hidden Hub tab sends no position while another tab clocks out and replays it; shown again, it reads the shift closed`, async t => {
    const recordId = `time-${who.role}-stale-tab`, cookie = await openShift(t, who, recordId);
    const indexedDB = fakeIndexedDB();
    const A = hubOnServer({ cookie, indexedDB, network: true, ...who }), B = hubOnServer({ cookie, indexedDB, network: true, ...who });
    A.hub.api.install(); B.hub.api.install();
    await ready(A, B);
    assert.deepEqual(B.geo.watches, [], NO_WATCH);
    // Tab B is in the background, so it never polls its records.
    B.hub.document.hidden = true;
    A.hub.context.navigator.onLine = false; B.hub.context.navigator.onLine = false;
    await A.hub.context.opsClockOut();
    // The signal returns within the minute and tab A replays the clock-out before tab B takes any position fix.
    A.hub.context.navigator.onLine = true; B.hub.context.navigator.onLine = true;
    A.hub.fire('online');
    await A.settle();
    assert.deepEqual(indexedDB.rows(...STORE), [], 'tab A sent the clock-out');
    B.hub.fire('online');
    await B.settle();
    assert.equal(B.shift(recordId).status, 'active', 'tab B still shows the records it read before');
    assert.deepEqual(B.geo.watches, [], NO_WATCH);
    for (const minutes of [2, 4, 6]) {
      later(t, minutes, B);
      await B.geo.fix({ latitude: 40.7 + minutes / 100, longitude: -105.2, accuracy: 5 });
      await B.settle();
    }
    assert.deepEqual(B.locations(), [], 'no position fix left the phone after the clock-out');
    assert.deepEqual(B.geo.watches, [], NO_WATCH);
    B.hub.document.hidden = false; B.hub.document.dispatch({ type: 'visibilitychange' });
    await B.settle();
    assert.equal(B.shift(recordId).status, 'submitted', 'tab B, shown again, read the server and shows the shift closed');
    assert.equal(B.hub.session.getItem('egc_hub_location_paused'), null, 'the clock-out was saved, so nothing is paused');
    const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
    assert.deepEqual([saved.status, saved.locationStatus, saved.locationTracking], ['submitted', 'stopped', false]);
    assert.deepEqual(plain(saved.lastLocation), clockInPosition);
    t.mock.timers.reset();
  });

  test(`Hub + server (${who.role}): when another tab’s queued clock-out is refused, a stale tab sends nothing, reads the shift still open when shown, and Keep working there reads no position`, async t => {
    const recordId = `time-${who.role}-stale-refused`, cookie = await openShift(t, who, recordId);
    const indexedDB = fakeIndexedDB(), refuse = { post: async body => body.data?.clockOutAt ? Response.json({ ok: false, error: 'Synthetic refusal' }, { status: 403 }) : null };
    const A = hubOnServer({ cookie, indexedDB, network: true, gate: refuse, ...who }), B = hubOnServer({ cookie, indexedDB, network: true, ...who });
    A.hub.api.install(); B.hub.api.install();
    await ready(A, B);
    B.hub.document.hidden = true;
    A.hub.context.navigator.onLine = false; B.hub.context.navigator.onLine = false;
    await A.hub.context.opsClockOut();
    A.hub.context.navigator.onLine = true; B.hub.context.navigator.onLine = true;
    A.hub.fire('online');
    await A.settle();
    assert.deepEqual(A.hub.toasts.filter(text => text.startsWith('Not saved')), ['Not saved: Clock out. Synthetic refusal']);
    assert.deepEqual(indexedDB.rows(...STORE), []);
    later(t, 2, B);
    await B.geo.fix({ latitude: 40.7, longitude: -105.2, accuracy: 5 });
    await B.settle();
    assert.deepEqual(B.locations(), [], 'the stale tab sent nothing');
    assert.deepEqual(B.geo.watches, [], NO_WATCH);
    // Shown again, it reads the server: the shift is still open (tab A says its clock-out was not saved).
    B.hub.document.hidden = false; B.hub.document.dispatch({ type: 'visibilitychange' });
    await B.settle();
    assert.deepEqual(B.snapshots.at(-1), [[recordId, 'active']], 'the shift is still open on the server');
    assert.equal(B.shift(recordId).status, 'active');
    if (who.role === 'crew') assert.match(A.card(), /Clock-out not saved — clock out again/);
    // The crew member is still working and taps Keep working in that tab: no position is read or sent.
    B.hub.context.opsKeepWorking();
    assert.equal(B.hub.toasts.at(-1), 'Your shift stays open');
    later(t, 4, B);
    await B.geo.fix({ latitude: 40.71, longitude: -105.21, accuracy: 5 });
    await B.settle();
    assert.deepEqual(B.locations(), [], 'nothing after clock-in');
    assert.deepEqual(B.geo.watches, [], NO_WATCH); assert.deepEqual(B.geo.reads, []);
    assert.equal(B.hub.session.getItem('egc_hub_location_paused'), null);
    const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
    assert.deepEqual([saved.status, plain(saved.lastLocation)], ['active', clockInPosition], 'the card keeps its clock-in position');
    t.mock.timers.reset();
  });

  test(`Hub + server (${who.role}): a Hub on another device, or with offline saving off, whose shift was clocked out elsewhere sends no position fix, and reads the shift closed when shown again`, async t => {
    for (const setting of ['on', 'off']) {
      const recordId = `time-${who.role}-elsewhere-${setting}`, cookie = await openShift(t, who, recordId);
      const open = (options = {}) => { const p = hubOnServer({ cookie, network: true, configure: setting === 'on', ...who, ...options }); if (setting === 'off') p.hub.context.EGCHubOffline.configure({ enabled: false }); return p; };
      // Two devices: nothing on one is stored on the other.
      const A = open(), B = open();
      A.hub.api.install(); B.hub.api.install();
      await ready(A, B);
      B.hub.document.hidden = true;
      await A.hub.context.opsClockOut();
      await A.settle();
      assert.equal(A.shift(recordId).status, 'submitted', setting);
      for (const minutes of [2, 4, 6]) {
        later(t, minutes, B);
        await B.geo.fix({ latitude: 40.7 + minutes / 100, longitude: -105.2, accuracy: 5 });
        await B.settle();
      }
      assert.deepEqual(B.locations(), [], `${setting}: no position fix went out`);
      assert.deepEqual(B.geo.watches, [], `${setting}: ${NO_WATCH}`);
      B.hub.document.hidden = false; B.hub.document.dispatch({ type: 'visibilitychange' });
      await B.settle();
      assert.equal(B.shift(recordId).status, 'submitted', `${setting}: shown again, the Hub read its records`);
      const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
      assert.deepEqual([saved.status, saved.locationStatus], ['submitted', 'stopped'], setting);
      assert.deepEqual(plain(saved.lastLocation), clockInPosition, `${setting}: nothing was stored`);
      t.mock.timers.reset();
    }
  });

  test(`Hub + server (${who.role}), switch off: Keep working on a shift whose clock-out is held removes the held clock-out, reads and sends no position, and switching back on sends nothing`, async t => {
    const recordId = `time-${who.role}-held-resume`, cookie = await openShift(t, who, recordId);
    const indexedDB = fakeIndexedDB();
    const first = hubOnServer({ cookie, indexedDB, ...who });
    first.hub.api.install();
    await first.settle();
    first.hub.context.navigator.onLine = false;
    await first.hub.context.opsClockOut();
    // The owner turns HUB_OFFLINE_ENABLED off; the crew member, still working, opens the Hub again, online.
    const next = hubOnServer({ cookie, indexedDB, configure: false, ...who });
    next.hub.context.EGCHubOffline.configure({ enabled: false });
    next.hub.api.install();
    await next.settle();
    assert.deepEqual(next.hub.toasts, ['A clock-out saved on this device was not sent because offline saving is off — clock out again.']);
    assert.deepEqual(next.geo.watches, []);
    assert.deepEqual(indexedDB.rows(...STORE).map(row => row.superseded), [true], 'once told, it is never sent');
    next.hub.context.opsKeepWorking();
    assert.equal(next.hub.toasts.at(-1), 'Your shift stays open · the clock-out saved on this device will not be sent');
    assert.deepEqual(next.geo.watches, [], NO_WATCH);
    later(t, 2, next);
    await next.geo.fix({ latitude: 40.7, longitude: -105.2, accuracy: 5 });
    await next.settle();
    assert.deepEqual(next.locations(), [], 'no position went out');
    assert.deepEqual(next.geo.watches, [], NO_WATCH); assert.deepEqual(next.geo.reads, []);
    assert.equal(next.hub.session.getItem('egc_hub_location_paused'), null);
    if (who.role === 'crew') { assert.match(next.card(), /Location shared once at clock-in/); assert.doesNotMatch(next.card(), /Clock-out not saved/); }
    assert.deepEqual(indexedDB.rows(...STORE), [], 'the held clock-out was removed from the device');
    // Switched back on later: nothing is sent, and the shift stays open.
    const on = hubOnServer({ cookie, indexedDB, ...who });
    pageTime(on.hub, at(4));
    on.hub.api.install();
    await on.settle();
    assert.deepEqual(on.posts.filter(body => body.data?.clockOutAt), []);
    const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
    assert.deepEqual([saved.status, plain(saved.lastLocation)], ['active', clockInPosition]);
    t.mock.timers.reset();
  });
}

test('a clock-in whose earlier attempt may have been saved (its reply was lost) keeps the clock actions queued after it when its retry is refused or it expires; they are sent', async () => {
  let tick = Date.parse(NOW);
  const { api } = load(), box = api.create({ store: api.memoryStore(), now: () => new Date(tick) });
  const clockIn = action('Crew.One', 'timeEntries', hubClockIn('Crew.One', NOW), 'time-crewone-9');
  const out = action('Crew.One', 'timeEntries', hubClockOut(at(1)), 'time-crewone-9');
  await box.enqueue(clockIn); await box.enqueue(out);
  const lost = wire(() => new TypeError('Failed to fetch'));
  await box.flush({ user: 'Crew.One', transport: lost.transport });
  assert.equal(lost.calls.length, 1);
  const refused = wire(body => body.data.clockInAt ? { status: 403, data: { ok: false, error: 'Recorded breaks cannot be rewritten.' } } : { status: 200, data: { ok: true, record: {} } });
  const result = await box.flush({ user: 'Crew.One', transport: refused.transport });
  assert.deepEqual(refused.calls.map(call => clockInKind(JSON.parse(call.body))), ['clock-in', 'clock-out'], 'the clock-out was still sent');
  assert.deepEqual(plain(result.dropped.map(entry => [entry.item.requestId, Boolean(entry.lost)])), [[clockIn.requestId, false]]);
  assert.deepEqual(plain(result.applied.map(entry => entry.item.requestId)), [out.requestId]);
  // The same after 12 hours: the clock-in that was tried expires alone.
  const again = action('Crew.One', 'timeEntries', hubClockIn('Crew.One', NOW), 'time-crewone-8');
  await box.enqueue(again);
  await box.flush({ user: 'Crew.One', transport: wire(() => ({ status: 503, data: null })).transport });
  tick += 11 * 3600000;
  const late = action('Crew.One', 'timeEntries', hubClockOut(at(11 * 60)), 'time-crewone-8');
  await box.enqueue(late);
  tick += 2 * 3600000;
  const sent = wire();
  const expired = await box.flush({ user: 'Crew.One', transport: sent.transport });
  assert.deepEqual(plain(expired.dropped.map(entry => [entry.item.requestId, Boolean(entry.expired), Boolean(entry.lost)])), [[again.requestId, true, false]]);
  assert.deepEqual(sent.calls.map(call => JSON.parse(call.body).data.clockOutAt), [at(11 * 60)], 'its clock-out, not yet 12 hours old, was sent');
});

test('a clock-in refused by the server says so once and the clock-out after it still goes out when an earlier attempt may have been saved; refused on its first attempt, both are listed as not saved as before', async () => {
  for (const firstTry of ['lost reply', 'refused']) {
    let lostOnce = firstTry === 'lost reply';
    const p = await page({ online: false, reply: async (url, init) => {
      if (!JSON.parse(init.body).data.clockInAt) return Response.json({ ok: true, record: {} });
      if (lostOnce) { lostOnce = false; throw new TypeError('Failed to fetch'); }
      return Response.json({ ok: false, error: 'Synthetic refusal' }, { status: 403 });
    } });
    await p.hub.send(PATH, request('timeEntries', hubClockIn('Crew.One', at(-30)), 'time-crewone-9'));
    await p.hub.send(PATH, request('timeEntries', hubClockOut(at(-10)), 'time-crewone-9'));
    p.net.online = true;
    await p.hub.sync();
    if (firstTry === 'lost reply') await p.hub.sync();
    const kinds = p.posts().map(call => clockInKind(JSON.parse(call.init.body)));
    if (firstTry === 'lost reply') {
      assert.deepEqual(kinds, ['clock-in', 'clock-in', 'clock-out']);
      assert.deepEqual(p.toasts, ['Not saved: Clock in. Synthetic refusal']);
    } else {
      assert.deepEqual(kinds, ['clock-in']);
      assert.deepEqual(p.toasts, ['Not saved: Clock in. Synthetic refusal', 'Not saved: Clock out. The clock-in for this shift was not saved, so this was not sent.']);
    }
    assert.deepEqual(p.indexedDB.rows(...STORE), [], firstTry);
  }
});

test('Hub + server: a queued clock-in saved with its reply lost and refused on its retry, after the crew app recorded a break on that timecard, still sends the clock-out queued after it, which closes the shift', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, CREW);
  await onboarded(cookie);
  let lost = false;
  // The clock-in reaches the server and is saved, but its reply never reaches the phone. Its retry is refused here: since
  // CREW-TIME the server itself answers a clock-in retried onto its open card with that card, so the refusal is the gate's.
  const gate = { post: async body => { if (body.data?.clockInAt && !lost) { lost = true; assert.equal((await post(cookie, body)).status, 200); throw new TypeError('Failed to fetch'); } if (body.data?.clockInAt) return Response.json({ ok: false, error: 'Synthetic refusal of the retried clock-in.' }, { status: 400 }); return null; } };
  const p = hubOnServer({ cookie, network: true, gate });
  p.hub.api.install();
  await p.settle();
  await p.hub.context.opsClockIn();
  const id = openShiftId(p);
  assert.equal(p.hub.toasts.at(-1), 'Clock-in saved on this device · it syncs when you are back online');
  assert.deepEqual((await serverRecords(cookie)).map(row => [row.id, row.status]), [[id, 'active']], 'the server has the timecard');
  // No signal now: the crew member clocks out, which waits behind the clock-in.
  p.hub.context.navigator.onLine = false;
  await p.hub.context.opsClockOut();
  assert.equal(p.indexedDB.rows(...STORE).length, 2);
  // Meanwhile the crew app records a break on that timecard.
  for (const breaks of [[{ startAt: NOW, endAt: '' }], [{ startAt: NOW, endAt: NOW }]]) assert.equal((await post(cookie, { collection: 'timeEntries', id, data: { breaks, updatedAt: NOW } })).status, 200);
  p.hub.context.navigator.onLine = true; p.hub.fire('online');
  await p.settle();
  assert.deepEqual(p.posts.filter(body => body.collection === 'timeEntries').map(clockInKind), ['clock-in', 'clock-in', 'clock-out'], 'the refused retry did not take the clock-out with it');
  assert.deepEqual(p.hub.toasts.filter(text => text.startsWith('Not saved')), ['Not saved: Clock in. Synthetic refusal of the retried clock-in.']);
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  const saved = (await serverRecords(cookie)).find(row => row.id === id);
  assert.deepEqual([saved.status, saved.locationStatus, saved.breaks.length], ['submitted', 'stopped', 1], 'the clock-out closed the shift');
  assert.equal(p.shift(id).status, 'submitted');
  assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.locations(), []);
  assert.equal(p.hub.session.getItem('egc_hub_location_paused'), null);
  t.mock.timers.reset();
});

test('Hub + server: discarding a queued shift whose clock-in was saved with its reply lost says that shift’s clock-out was not saved once the server shows it open; nothing of it is sent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  vaultFirestore(t);
  const cookie = await cookieFor(ENV, CREW);
  await onboarded(cookie);
  let lost = false;
  const gate = { post: async body => { if (body.data?.clockInAt && !lost) { lost = true; assert.equal((await post(cookie, body)).status, 200); throw new TypeError('Failed to fetch'); } return null; } };
  const p = hubOnServer({ cookie, network: true, gate });
  p.hub.api.install();
  await p.settle();
  await p.hub.context.opsClockIn();
  const id = openShiftId(p);
  p.hub.context.navigator.onLine = false;
  await p.hub.context.opsClockOut();
  // Believing the shift never reached the Hub, the crew member discards it from Pending sync.
  await discardFirst(p);
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  assert.equal(p.shift(id), undefined);
  p.hub.context.navigator.onLine = true;
  p.hub.document.dispatch({ type: 'visibilitychange' });
  await p.settle();
  assert.deepEqual(p.snapshots.at(-1), [[id, 'active']], 'the server has the shift open');
  assert.equal(p.shift(id).status, 'active');
  assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.geo.watches, [], 'shift location never started for the shift the crew member clocked out of');
  assert.match(p.card(), /Clock-out not saved — clock out again/); assert.match(p.card(), /Clock-out not saved/);
  assert.deepEqual(p.posts.filter(body => body.collection === 'timeEntries').map(clockInKind), ['clock-in']);
  assert.deepEqual(p.locations(), []);
  t.mock.timers.reset();
});

test('the queue never sends a superseded action: a later replay removes it unsent and quietly, with the clock actions queued after a superseded clock-in; one queued after it is listed as not saved', async () => {
  const p = await page({ online: false });
  const kept = async (collection, data, recordId) => (await (await p.hub.send(PATH, request(collection, data, recordId))).json()).requestId;
  const clockIn = await kept('timeEntries', hubClockIn('Crew.One', at(-30)), 'time-crewone-9');
  const onBreak = await kept('timeEntries', { breaks: [{ startAt: at(-20), endAt: '' }], updatedAt: at(-20) }, 'time-crewone-9');
  const note = await kept('teamMessages', hubMessage('Crew.One', 'Synthetic note'), 'message-crewone-9');
  assert.deepEqual(plain((await p.box.supersede(clockIn)).map(item => item.requestId)), [clockIn, onBreak], 'a clock-in takes what was queued after it for that shift');
  const out = await kept('timeEntries', hubClockOut(at(-10)), 'time-crewone-9');
  p.net.online = true;
  await p.hub.sync();
  assert.deepEqual(p.posts().map(call => JSON.parse(call.init.body).collection), ['teamMessages'], 'only the message was sent');
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  assert.deepEqual(p.toasts, ['Not saved: Clock out. The clock-in for this shift was not saved, so this was not sent.'], 'the superseded ones get no second notice');
  assert.deepEqual(plain([clockIn, onBreak, note, out].map(requestId => p.hub.settled(requestId).outcome)), ['superseded', 'superseded', 'applied', 'refused']);
});

test('Hub + server, switch off: a held clock-in the crew member was told about is never sent; clocking in again removes it, so switching back on (with device times kept) creates no second shift', async t => {
  const env = { ...ENV, EGC_OFFLINE_CLOCK_ENABLED: 'true' };
  for (const then of ['clocks in again', 'does nothing']) {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
    vaultFirestore(t);
    const cookie = await cookieFor(env, CREW);
    await onboarded(cookie, env);
    const indexedDB = fakeIndexedDB();
    const first = hubOnServer({ env, cookie, indexedDB, online: false, network: true });
    first.hub.api.install();
    await first.settle();
    await first.hub.context.opsClockIn();
    const heldShift = openShiftId(first);
    await first.hub.context.opsClockOut();
    assert.equal(indexedDB.rows(...STORE).length, 2);
    // Offline saving is switched off; ten minutes later the crew member opens the Hub online.
    later(t, 10);
    const next = hubOnServer({ env, cookie, indexedDB, configure: false, before: context => pageTime({ context }, at(10)) });
    next.hub.context.EGCHubOffline.configure({ enabled: false });
    next.hub.api.install();
    await next.settle();
    assert.deepEqual(next.hub.toasts, ['A clock-in saved on this device was not sent because offline saving is off — clock in again if you are working, or ask a manager for a time correction.'], then);
    assert.deepEqual(indexedDB.rows(...STORE).map(row => row.superseded), [true, true], `${then}: the clock-in and the clock-out after it are never sent`);
    if (then === 'clocks in again') {
      await next.hub.context.opsClockIn();
      await next.settle();
      assert.deepEqual(indexedDB.rows(...STORE), [], 'clocking in again removed them from the device');
    }
    const shifts = (await serverRecords(cookie)).map(row => row.id);
    // Switched back on an hour later.
    later(t, 70);
    const on = hubOnServer({ env, cookie, indexedDB, before: context => pageTime({ context }, at(70)) });
    on.hub.api.install();
    await on.settle();
    assert.deepEqual(on.posts.filter(body => body.collection === 'timeEntries'), [], `${then}: nothing held was sent`);
    assert.deepEqual(on.hub.toasts.filter(text => text.startsWith('Not saved')), [], `${then}: and no second notice`);
    assert.deepEqual(indexedDB.rows(...STORE), []);
    assert.deepEqual((await serverRecords(cookie)).map(row => row.id), shifts, `${then}: no shift was created for the held clock-in`);
    assert.ok(!shifts.includes(heldShift));
    assert.equal(shifts.length, then === 'clocks in again' ? 1 : 0);
    t.mock.timers.reset();
  }
});

for (const who of [{ user: CREW, business: false, role: 'crew' }, { user: 'TylerG', business: true, role: 'manager' }]) {
  test(`Hub + server (${who.role}), switch off: a held clock-out the crew member was told about is never sent; clocking out again removes it, so switching back on keeps that clock-out time, and doing nothing keeps the shift open, shown as not clocked out`, async t => {
    for (const then of ['clocks out again', 'does nothing']) {
      const recordId = `time-${who.role}-held-out-${then.split(' ')[0]}`, cookie = await openShift(t, who, recordId);
      const indexedDB = fakeIndexedDB();
      const first = hubOnServer({ cookie, indexedDB, ...who });
      first.hub.api.install();
      await first.settle();
      first.hub.context.navigator.onLine = false;
      await first.hub.context.opsClockOut();
      later(t, 10);
      const next = hubOnServer({ cookie, indexedDB, configure: false, before: context => pageTime({ context }, at(10)), ...who });
      next.hub.context.EGCHubOffline.configure({ enabled: false });
      next.hub.api.install();
      await next.settle();
      assert.deepEqual(next.hub.toasts, ['A clock-out saved on this device was not sent because offline saving is off — clock out again.']);
      assert.deepEqual(indexedDB.rows(...STORE).map(row => row.superseded), [true]);
      if (then === 'clocks out again') {
        await next.hub.context.opsClockOut();
        await next.settle();
        assert.deepEqual(indexedDB.rows(...STORE), [], 'clocking out again removed it from the device');
      }
      later(t, 20);
      const on = hubOnServer({ cookie, indexedDB, before: context => pageTime({ context }, at(20)), ...who });
      on.hub.api.install();
      await on.settle();
      assert.deepEqual(on.posts.filter(body => body.data?.clockOutAt), [], `${then}: the held clock-out was never sent`);
      assert.deepEqual(indexedDB.rows(...STORE), []);
      const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
      if (then === 'clocks out again') assert.deepEqual([saved.status, saved.clockOutAt], ['submitted', at(10)], 'the clock-out the crew member made again is the one kept');
      else {
        assert.equal(saved.status, 'active', 'the shift stays open until someone clocks it out');
        assert.deepEqual(on.geo.watches, [], 'and its location stays paused');
        if (who.role === 'crew') assert.match(on.card(), /Clock-out not saved — clock out again/);
      }
      t.mock.timers.reset();
    }
  });
}

test('Hub + server: a queued chat that settles while the Hub still shows a shift clocked out elsewhere reads no position from those records, with no clock save of the Hub’s own under way', async t => {
  const recordId = 'time-crewstatic-settle-only', { cookie } = await clockedIn(t, ENV, recordId);
  let reads = null;
  const p = hubOnServer({ cookie, network: true, gate: { get: async () => { if (reads) { reads.held = true; await reads.promise; } } } });
  p.hub.api.install();
  await ready(p);
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  // The shift is clocked out on another device, which this Hub has not read yet.
  assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: hubClockOut(NOW) })).status, 200);
  // With no signal the crew member sends a chat message, which waits on the device.
  p.hub.context.navigator.onLine = false;
  await p.hub.context.opsSendChat(chatSubmit(p.hub, 'Synthetic heading out'));
  assert.equal(p.indexedDB.rows(...STORE).length, 1);
  // Back online, the message is sent and settles while the Hub's read of its records is slow.
  reads = gateHold();
  p.hub.context.navigator.onLine = true; p.hub.fire('online');
  await until(() => reads.held);
  for (let i = 0; i < 40; i++) await idle();
  assert.deepEqual(p.indexedDB.rows(...STORE), [], 'the message was sent');
  assert.equal(p.S.clockSaving, 0, 'no clock save of the Hub’s own is under way');
  assert.equal(p.shift(recordId).status, 'active', 'the Hub still shows the records it read before the clock-out');
  assert.deepEqual(p.geo.watches, [], NO_WATCH); assert.deepEqual(p.geo.reads, [], 'no position read after clock-in');
  reads.open();
  await p.settle();
  assert.equal(p.shift(recordId).status, 'submitted');
  assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.geo.watches, []);
  assert.deepEqual(p.locations(), []);
  t.mock.timers.reset();
});

test('Hub + server, switch off: a read of the records that completes while the Hub’s own clock-out is still being saved never shows the shift open from the records it read before the clock-out landed', async t => {
  const recordId = 'time-crewstatic-clock-saving', { cookie } = await clockedIn(t, ENV, recordId);
  const slowPost = gateHold();
  const p = hubOnServer({ cookie, configure: false, gate: { post: async body => { if (body.data?.clockOutAt && !slowPost.held) { slowPost.held = true; await slowPost.promise; } return null; } } });
  p.hub.context.EGCHubOffline.configure({ enabled: false });
  p.hub.api.install();
  await ready(p);
  assert.deepEqual(p.geo.watches, [], NO_WATCH);
  const out = p.hub.context.opsClockOut();
  await until(() => slowPost.held);
  assert.deepEqual(p.geo.live(), []);
  // The Hub is shown again and reads its records while the clock-out is still on its way: the server has the shift open.
  const start = p.snapshots.length;
  p.hub.document.dispatch({ type: 'visibilitychange' });
  await until(() => p.snapshots.length > start && !p.S.peopleRequest);
  for (let i = 0; i < 20; i++) await idle();
  assert.deepEqual(p.snapshots.at(-1), [[recordId, 'active']]);
  assert.equal(p.S.clockSaving, 1, 'the Hub’s clock-out is still being saved');
  assert.equal(p.hub.context.EGCHubOffline.settled().length, 0, 'and the queue settled nothing');
  assert.deepEqual(p.geo.watches, [], 'that read did not start shift location');
  slowPost.open();
  await out;
  await p.settle();
  assert.equal(p.shift(recordId).status, 'submitted');
  assert.deepEqual(p.geo.live(), []); assert.deepEqual(p.geo.watches, []);
  assert.deepEqual(p.locations(), []);
  t.mock.timers.reset();
});

// ── Fourth review: a manager's own queued clock actions replay as no-ops, as a crew member's do ──

// The first POST that match(body) picks reaches the server and is saved there, but its reply is lost on the way back.
const loseReply = (cookie, match) => {
  const gate = { lost: null };
  gate.post = async body => {
    if (gate.lost || !match(body)) return null;
    gate.lost = body;
    const saved = await post(cookie, body);
    assert.equal(saved.status, 200, await saved.clone().text());
    throw new TypeError('Failed to fetch');
  };
  return gate;
};
const WHOS = [{ user: CREW, business: false, role: 'crew' }, { user: 'TylerG', business: true, role: 'manager' }];

for (const who of WHOS) {
  test(`Hub + server (${who.role}): a clock-in saved with its reply lost and replayed after the shift was clocked out on another device never reopens it, and the phone sends no position fix for it`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
    vaultFirestore(t);
    const cookie = await cookieFor(ENV, who.user);
    if (who.role === 'crew') await onboarded(cookie);
    const gate = loseReply(cookie, body => body.collection === 'timeEntries' && body.data?.status === 'active' && typeof body.data?.clockInAt === 'string');
    const p = hubOnServer({ cookie, network: true, gate, ...who });
    p.hub.api.install();
    await ready(p);
    await p.hub.context.opsClockIn();
    p.hub.context.navigator.onLine = false;
    await p.settle();
    const recordId = gate.lost?.id;
    assert.ok(recordId, 'the clock-in reached the server');
    assert.equal((await serverRecords(cookie)).find(row => row.id === recordId)?.status, 'active');
    assert.equal(p.indexedDB.rows(...STORE).length, 1, 'with no reply, the phone keeps the clock-in queued');
    // Three hours later the shift is clocked out on another device.
    later(t, 180, p);
    const out = await post(cookie, { collection: 'timeEntries', id: recordId, data: hubClockOut(at(180)) });
    assert.equal(out.status, 200, await out.clone().text());
    const closed = (await serverRecords(cookie)).find(row => row.id === recordId);
    // The phone reconnects and replays the clock-in.
    later(t, 200, p);
    p.hub.context.navigator.onLine = true; p.hub.fire('online');
    await p.settle(); await p.settle();
    assert.deepEqual(p.indexedDB.rows(...STORE), [], 'the replay was answered');
    const replay = p.hub.context.EGCHubOffline.settled().find(done => done.id === recordId && done.clockIn);
    // A crew member's replay is refused as a change to a submitted card; a manager's is the card as it is, unchanged.
    assert.equal(replay?.outcome, who.role === 'crew' ? 'refused' : 'applied');
    if (who.role === 'manager') assert.deepEqual([replay.record.status, replay.record.clockOutAt], ['submitted', at(180)]);
    const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
    assert.deepEqual(plain(saved), plain(closed), 'the server card is exactly as the other device left it');
    assert.deepEqual([saved.status, saved.approvalStatus, saved.locationTracking, saved.locationStatus], ['submitted', 'pending', false, 'stopped']);
    // The phone shows the shift closed and keeps shift location off; a position fix is never sent.
    assert.equal(p.shift(recordId).status, 'submitted');
    assert.deepEqual(p.geo.live(), []);
    later(t, 203, p);
    await p.geo.fix({ latitude: 40.9, longitude: -105.3, accuracy: 5 });
    await p.settle();
    assert.deepEqual(p.locations(), []);
    assert.deepEqual(plain((await serverRecords(cookie)).find(row => row.id === recordId).lastLocation), plain(closed.lastLocation));
    // The crew Hub opens on My Day, whose time clock is ready for the next shift.
    if (who.role === 'crew') assert.match(p.card(), /Ready when you are/);
    t.mock.timers.reset();
  });

  test(`Hub + server (${who.role}): a clock-out saved with its reply lost and replayed after the owner approved the card changes nothing; the approval stands`, async t => {
    const recordId = `time-${who.role}-approved-replay`, cookie = await openShift(t, who, recordId), owner = await cookieFor(ENV, 'ZacB');
    const gate = loseReply(cookie, body => body.collection === 'timeEntries' && Boolean(body.data?.clockOutAt));
    const p = hubOnServer({ cookie, network: true, gate, ...who });
    p.hub.api.install();
    await ready(p);
    await p.hub.context.opsClockOut();
    p.hub.context.navigator.onLine = false;
    await p.settle();
    assert.ok(gate.lost, 'the clock-out reached the server');
    assert.equal(p.indexedDB.rows(...STORE).length, 1, 'with no reply, the phone keeps the clock-out queued');
    later(t, 60, p);
    const approval = await post(owner, { collection: 'timeEntries', id: recordId, data: { approvalStatus: 'approved' } });
    assert.equal(approval.status, 200, await approval.clone().text());
    const approved = (await serverRecords(owner)).find(row => row.id === recordId);
    assert.deepEqual([approved.status, approved.approvalStatus, approved.approvedBy, approved.approvedAt], ['submitted', 'approved', 'ZacB', at(60)]);
    later(t, 90, p);
    p.hub.context.navigator.onLine = true; p.hub.fire('online');
    await p.settle();
    assert.deepEqual(p.indexedDB.rows(...STORE), []);
    assert.equal(p.hub.context.EGCHubOffline.settled().find(done => done.id === recordId && done.clockOut)?.outcome, 'applied', 'the replay is answered with the card as it is');
    assert.deepEqual(plain((await serverRecords(owner)).find(row => row.id === recordId)), plain(approved), 'still approved, by the owner, with nothing else changed');
    assert.deepEqual(p.hub.toasts.filter(text => text.startsWith('Not saved')), []);
    assert.deepEqual(p.locations(), []);
    t.mock.timers.reset();
  });

  test(`Hub + server (${who.role}): a break started with its reply lost and replayed after the break was ended and the shift clocked out on another device changes nothing`, async t => {
    const recordId = `time-${who.role}-break-replay`, cookie = await openShift(t, who, recordId);
    const gate = loseReply(cookie, body => body.collection === 'timeEntries' && Array.isArray(body.data?.breaks));
    const p = hubOnServer({ cookie, network: true, gate, ...who });
    p.hub.api.install();
    await ready(p);
    later(t, 10, p);
    await p.hub.context.opsStartBreak();
    p.hub.context.navigator.onLine = false;
    await p.settle();
    assert.ok(gate.lost, 'the break reached the server');
    const started = (await serverRecords(cookie)).find(row => row.id === recordId);
    assert.equal(started.breaks.length, 1); assert.equal(started.breaks[0].endAt, '');
    // Another device ends the break and clocks out.
    later(t, 30, p);
    const ended = await post(cookie, { collection: 'timeEntries', id: recordId, data: { breaks: [{ ...started.breaks[0], endAt: at(30) }] } });
    assert.equal(ended.status, 200, await ended.clone().text());
    later(t, 60, p);
    assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: hubClockOut(at(60)) })).status, 200);
    const closed = (await serverRecords(cookie)).find(row => row.id === recordId);
    assert.deepEqual([closed.status, closed.breaks.length, Boolean(closed.breaks[0].endAt)], ['submitted', 1, true]);
    later(t, 90, p);
    p.hub.context.navigator.onLine = true; p.hub.fire('online');
    await p.settle();
    assert.deepEqual(p.indexedDB.rows(...STORE), []);
    // A crew member's replay onto the submitted card is refused; a manager's is recognised by its request ID.
    assert.equal(p.hub.context.EGCHubOffline.settled().find(done => done.id === recordId)?.outcome, who.role === 'crew' ? 'refused' : 'applied');
    assert.deepEqual(plain((await serverRecords(cookie)).find(row => row.id === recordId)), plain(closed), 'no second break, no reopened break, and the card stays submitted');
    t.mock.timers.reset();
  });
}

test('Hub + server (manager): breaks started and ended offline replay in order, each recorded once at the time the Hub showed; sent again, before or after the clock-out, they change nothing', async t => {
  const who = WHOS[1], recordId = 'time-manager-offline-breaks', cookie = await openShift(t, who, recordId), owner = await cookieFor(ENV, 'ZacB');
  const p = hubOnServer({ cookie, network: true, ...who });
  p.hub.api.install();
  await ready(p);
  p.hub.context.navigator.onLine = false;
  later(t, 10, p);
  await p.hub.context.opsStartBreak();
  later(t, 25, p);
  await p.hub.context.opsEndBreak();
  assert.equal(p.indexedDB.rows(...STORE).length, 2);
  later(t, 40, p);
  p.hub.context.navigator.onLine = true; p.hub.fire('online');
  await p.settle();
  assert.deepEqual(p.indexedDB.rows(...STORE), []);
  const sent = p.posts.filter(body => body.collection === 'timeEntries' && Array.isArray(body.data?.breaks));
  assert.deepEqual(sent.map(body => body.data.breaks.at(-1).requestId), [sent[0].requestId, sent[1].requestId], 'each break carries its own request ID');
  const recorded = (await serverRecords(cookie)).find(row => row.id === recordId);
  assert.deepEqual(plain(recorded.breaks), [{ startAt: at(10), endAt: at(25), startRequestId: sent[0].requestId, endRequestId: sent[1].requestId }]);
  assert.equal(recorded.status, 'active');
  // The same bodies again (a reply lost on each): nothing changes, while the shift is open or after it is closed and approved.
  for (const body of sent) assert.equal((await post(cookie, body)).status, 200);
  assert.deepEqual(plain((await serverRecords(cookie)).find(row => row.id === recordId)), plain(recorded));
  later(t, 60, p);
  assert.equal((await post(cookie, { collection: 'timeEntries', id: recordId, data: hubClockOut(at(60)) })).status, 200);
  assert.equal((await post(owner, { collection: 'timeEntries', id: recordId, data: { approvalStatus: 'approved' } })).status, 200);
  const approved = (await serverRecords(owner)).find(row => row.id === recordId);
  later(t, 90, p);
  for (const body of sent) assert.equal((await post(cookie, body)).status, 200);
  assert.deepEqual(plain((await serverRecords(owner)).find(row => row.id === recordId)), plain(approved));
  assert.equal(approved.approvalStatus, 'approved');
  t.mock.timers.reset();
});

for (const who of WHOS) {
  test(`Hub + server (${who.role}): a position on the phone just before the Hub’s own clock-out sends nothing before or after it, with offline saving on or off`, async t => {
    for (const enabled of [true, false]) for (const kind of ['fix']) {
      const recordId = `time-${who.role}-inflight-${enabled ? 'on' : 'off'}-${kind}`, cookie = await openShift(t, who, recordId);
      const p = hubOnServer({ cookie, configure: false, ...who });
      p.hub.context.EGCHubOffline.configure({ enabled });
      p.hub.api.install();
      await ready(p);
      later(t, 2, p);
      const label = `${enabled ? 'on' : 'off'}, ${kind}`;
      assert.deepEqual(p.geo.watches, [], `${label}: ${NO_WATCH}`);
      // A new position reaches the phone as the clock-out is tapped: with no watch, nothing hears it.
      const inflight = p.geo.fix({ latitude: 40.9, longitude: -105.3, accuracy: 5 });
      const out = p.hub.context.opsClockOut();
      await inflight; await out;
      await p.settle();
      const shift = p.posts.filter(body => body.collection === 'timeEntries' && body.id === recordId);
      assert.deepEqual(shift.map(clockInKind), ['clock-out'], `${label}: only the clock-out was sent`);
      const saved = (await serverRecords(cookie)).find(row => row.id === recordId);
      assert.deepEqual([saved.status, saved.locationStatus, saved.locationError ?? ''], ['submitted', 'stopped', ''], label);
      assert.deepEqual(plain(saved.lastLocation), clockInPosition, label);
      assert.deepEqual(p.geo.live(), [], label);
      t.mock.timers.reset();
    }
  });
}

// ── Fourth review: the device queue without indexedDB.databases(), clock-out records kept from when they leave the
// queue, and an upgrade to the version 2 queue that another tab blocks ──

// An earlier build's queue (version 1: the request store only), left open when keep is true.
const versionOne = (indexedDB, keep = false) => new Promise(resolve => {
  const open = indexedDB.open('egc-hub-offline', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('requests', { keyPath: 'requestId' });
  open.onsuccess = () => { if (!keep) open.result.close(); resolve(open.result); };
});
// This device's IndexedDB as a browser without databases() (Firefox before 126) shows it to a page.
const withoutDatabases = indexedDB => new Proxy(indexedDB, { get: (target, key) => key === 'databases' ? undefined : target[key] });

test('without indexedDB.databases() (Firefox before 126) a queue on the device is found by opening it at its own version, and a device without one is never given one', async () => {
  const { api } = load(), indexedDB = fakeIndexedDB(), store = api.idbStore(withoutDatabases(indexedDB));
  assert.equal(await store.exists(), false);
  assert.equal(indexedDB.stored.has('egc-hub-offline'), false, 'asking created no database');
  await versionOne(indexedDB);
  assert.equal(await store.exists(), true);
  assert.equal(indexedDB.stored.get('egc-hub-offline').version, 1, 'found as it is, not upgraded by asking');
  assert.equal(indexedDB.stored.get('egc-hub-offline').connections.size, 0, 'and closed again');
  assert.equal(await api.idbStore({ open() { throw new Error('SecurityError'); } }).exists(), false);
  assert.equal(await api.idbStore(null).exists(), false);
  // With databases(), as before.
  assert.equal(await api.idbStore(indexedDB).exists(), true);
  assert.equal(await api.idbStore(fakeIndexedDB()).exists(), false);
});

for (const who of WHOS) {
  test(`Hub + server (${who.role}): a Hub tab without indexedDB.databases() whose offline switch has not answered sends no position fix for a shift another tab clocked out on this device`, async t => {
    const recordId = `time-${who.role}-no-databases`, cookie = await openShift(t, who, recordId);
    const indexedDB = fakeIndexedDB();
    const A = hubOnServer({ cookie, indexedDB, network: true, ...who }), B = hubOnServer({ cookie, indexedDB: withoutDatabases(indexedDB), network: true, configure: false, ...who });
    A.hub.api.install(); B.hub.api.install();
    await ready(A, B);
    assert.deepEqual(B.geo.watches, [], NO_WATCH);
    B.hub.document.hidden = true;
    A.hub.context.navigator.onLine = false;
    await A.hub.context.opsClockOut();
    A.hub.context.navigator.onLine = true; A.hub.fire('online');
    await A.settle();
    assert.deepEqual(indexedDB.rows(...STORE), [], 'tab A sent the clock-out');
    for (const minutes of [2, 4, 6]) {
      later(t, minutes, B);
      await B.geo.fix({ latitude: 40.7 + minutes / 100, longitude: -105.2, accuracy: 5 });
      await B.settle();
    }
    assert.deepEqual(B.locations(), [], 'no position fix left the phone');
    assert.deepEqual(B.geo.watches, [], NO_WATCH);
    B.hub.document.hidden = false; B.hub.document.dispatch({ type: 'visibilitychange' });
    await B.settle();
    assert.equal(B.shift(recordId).status, 'submitted', 'tab B, shown again, read the server and shows the shift closed');
    assert.deepEqual(plain((await serverRecords(cookie)).find(row => row.id === recordId).lastLocation), clockInPosition);
    t.mock.timers.reset();
  });
}

test('a clock-out’s record on the device is kept for 12 hours after the clock-out leaves the queue, however long it waited; one forgotten stays forgotten', async () => {
  for (const kind of ['IndexedDB', 'memory']) {
    const { api } = load(), indexedDB = fakeIndexedDB();
    let tick = Date.parse(NOW);
    const box = api.create({ store: kind === 'memory' ? api.memoryStore() : api.idbStore(indexedDB), now: () => new Date(tick) });
    const out = action('Crew.One', 'timeEntries', hubClockOut(NOW), 'time-crewone-1');
    await box.enqueue(out);
    // It waits almost 12 hours on the device, then is sent.
    tick += 11 * 3600000 + 50 * 60000;
    const sent = wire();
    await box.flush({ user: 'Crew.One', transport: sent.transport });
    assert.equal(sent.calls.length, 1, kind);
    const left = new Date(tick).toISOString();
    tick += 11 * 3600000;
    assert.equal((await box.clockedOut('Crew.One', 'time-crewone-1'))?.requestId, out.requestId, `${kind}: still remembered 11 hours after it was sent (almost 23 after it was queued)`);
    // Another clock-out queued now keeps it too (records are dropped by the time they left the queue).
    await box.enqueue(action('Crew.One', 'timeEntries', hubClockOut(new Date(tick).toISOString()), 'time-crewone-2'));
    assert.equal((await box.clockedOut('Crew.One', 'time-crewone-1'))?.requestId, out.requestId, kind);
    if (kind === 'IndexedDB') assert.deepEqual(indexedDB.rows('egc-hub-offline', 'clockOuts').find(row => row.id === 'time-crewone-1'), { requestId: out.requestId, user: 'Crew.One', id: 'time-crewone-1', at: NOW, left });
    tick = Date.parse(left) + 12 * 3600000 + 1;
    assert.equal(await box.clockedOut('Crew.One', 'time-crewone-1'), null, `${kind}: 12 hours after it left the queue it is gone`);
    // Forgotten (shift location resumed) while still queued, it is not brought back when it leaves the queue.
    const held = action('Crew.One', 'timeEntries', hubClockOut(new Date(tick).toISOString()), 'time-crewone-3');
    await box.enqueue(held);
    await box.forget('Crew.One', 'time-crewone-3');
    await box.discard(held.requestId);
    assert.equal(await box.clockedOut('Crew.One', 'time-crewone-3'), null, kind);
  }
});

test('an upgrade to the version 2 queue that a tab still running the version 1 script blocks sends the action to the network; the upgrade finishes once that tab lets go and its connection closes at once, so it never holds up a later upgrade', async () => {
  const indexedDB = fakeIndexedDB(), old = await versionOne(indexedDB, true);
  const p = await page({ indexedDB });
  const init = request('timeEntries', hubClockOut(at(-1)));
  const response = await p.hub.send(PATH, init);
  assert.equal(response.status, 200);
  assert.equal(p.posts().at(-1).init, init, 'the original request, sent at once without a queue request ID');
  assert.equal(indexedDB.stored.get('egc-hub-offline').version, 1, 'still version 1 while the old tab holds it');
  old.close();
  await indexedDB.idle();
  const db = indexedDB.stored.get('egc-hub-offline');
  assert.equal(db.version, 2, 'the upgrade went ahead once the old tab let go');
  assert.equal(db.connections.size, 0, 'and no connection was left open by it');
  const queued = await p.hub.send(PATH, request('timeEntries', hubClockOut(at(-1)), 'time-crewone-2'));
  assert.equal(queued.status, 200);
  assert.match(JSON.parse(p.posts().at(-1).init.body).requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'the queue holds the next action again');
  const later3 = await new Promise(resolve => { const open = indexedDB.open('egc-hub-offline', 3); open.onblocked = () => resolve('blocked'); open.onsuccess = () => { open.result.close(); resolve('opened'); }; });
  assert.equal(later3, 'opened', 'a later upgrade is not held up');
});

test('a queue connection that is open when another tab asks for a newer version lets go at once, so that upgrade is not blocked', async () => {
  const { api } = load(), indexedDB = fakeIndexedDB(), newer = { blocked: false, opened: false, asked: false };
  // Right as this page's connection opens, another tab asks for version 3.
  const factory = { databases: () => indexedDB.databases(), open(name, version) {
    const request = indexedDB.open(name, version);
    let handler = null;
    Object.defineProperty(request, 'onsuccess', { configurable: true, set: fn => { handler = fn; }, get: () => handler && (() => {
      handler();
      if (newer.asked || version !== 2) return;
      newer.asked = true;
      const next = indexedDB.open(name, 3);
      next.onblocked = () => { newer.blocked = true; };
      next.onsuccess = () => { newer.opened = true; next.result.close(); };
    }) });
    return request;
  } };
  assert.deepEqual(await api.idbStore(factory).all(), []);
  await indexedDB.idle();
  assert.deepEqual(newer, { blocked: false, opened: true, asked: true });
});
