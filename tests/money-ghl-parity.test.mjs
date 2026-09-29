import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { moneyHandlers } from '../functions/api/money.js';
import { onRequestPost as highlevelPost } from '../functions/api/highlevel.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';

// MONEY-GHL-PARITY: with MONEY_API_ENABLED=true the server money dialog starts the same HighLevel
// lifecycle trigger as the standard finance save. Both paths run their real browser code (the suite's
// finance action and helpers, the money module over a small fake DOM) against the real /api/money and
// /api/highlevel handlers; only Firestore (an in-memory store) and HighLevel (fetch) are faked.
const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const moduleSource = readFileSync(new URL('../employee-money-actions.js', import.meta.url), 'utf8');
const sourceLine = prefix => { const line = suite.split('\n').find(value => value.startsWith(prefix)); assert.ok(line, `missing ${prefix}`); return line; };
const sourceBetween = (start, end) => { const first = suite.indexOf(start), last = suite.indexOf(end, first); assert.ok(first >= 0 && last > first, `missing ${start}`); return suite.slice(first, last); };

// Notes go straight to HighLevel here (EGC_OPERATIONS_ENABLED=false); OPS_ENV signs them for the native operations bridge instead.
const OPS_ENV = { HUB_SESSION_SECRET: 'synthetic-money-ghl-parity-session', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-zac', displayName: 'Synthetic Owner', role: 'owner', payType: 'owner', hourlyRate: 0 } }), HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: 'location-1' };
const HUB_ENV = { ...OPS_ENV, EGC_OPERATIONS_ENABLED: 'false' };
const COOKIE = (await createHubSessionCookie(HUB_ENV, 'ZacB')).split(';')[0];
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const ORIGIN = 'https://easygaragecleaning.com', ID = 'job-abc123';
const SCOPE = 'Clear and reset the two-car garage.';
const BASE = { type: 'job', customerId: 'c1', customer: 'Synthetic Customer', phone: '9705550100', email: 'synthetic@example.invalid', address: '1 Synthetic Way, Fort Collins, CO 80521', serviceType: 'Garage transformation', date: '2026-09-24', status: 'scheduled', pipelineStatus: 'scheduled', notify: true, highlevelContactId: 'contact-1', highlevelAppointmentId: 'appt-1', total: 1400 };

const clock = { now: 0 };
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
const at = iso => { clock.now = Date.parse(iso); return iso; };
const T = minute => `2026-09-22T18:${String(minute).padStart(2, '0')}:00.000Z`; // noon in Denver

// One Firestore project: the money store (server, revisions) and the browser SDK (set-merge) share it.
function firestore(job) {
  const docs = new Map([[`jobs/${ID}`, { ...structuredClone(job), id: ID, revision: 'r0' }], ['customers/c1', { id: 'c1', revision: 'c1-r0', name: 'Synthetic Customer' }]]);
  let n = 0;
  const conflict = () => Object.assign(new Error('Conflict'), { code: 'money_revision_conflict', status: 409 });
  const store = {
    read: async (collection, id) => structuredClone(docs.get(`${collection}/${id}`) ?? null),
    jobs: async () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)),
    async commit(writes) {
      for (const write of writes) { const old = docs.get(`${write.collection}/${write.id}`); if (write.exists ? !old : write.revision ? old?.revision !== write.revision : old) throw conflict(); }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; docs.set(key, { ...(write.revision || write.exists ? docs.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
  };
  const snapshot = (collection, id) => { const row = docs.get(`${collection}/${id}`); if (!row) return { id, exists: false, data: () => undefined }; const { id: _id, revision, ...data } = structuredClone(row); return { id, exists: true, data: () => data }; };
  const write = (collection, id, patch, options = {}) => { const key = `${collection}/${id}`; docs.set(key, { ...(options.merge ? docs.get(key) || {} : {}), ...structuredClone(patch), id, revision: `browser-${++n}` }); };
  // The browser SDK. Faults: the next `readFaults` reads and `writeFaults` writes fail (as offline); `hangWrites` never settle.
  const browser = { reads: 0, readFaults: 0, writeFaults: 0, hangWrites: false, transactions: 0 };
  let serial = Promise.resolve();
  const db = { collection: collection => ({ doc: id => ({ collection, id,
    get: async () => { browser.reads++; if (browser.readFaults > 0) { browser.readFaults--; throw new Error('Synthetic offline read'); } return snapshot(collection, id); },
    set: async (patch, options = {}) => { if (browser.hangWrites) return new Promise(() => {}); if (browser.writeFaults > 0) { browser.writeFaults--; throw new Error('Synthetic offline write'); } write(collection, id, patch, options); },
  }) }),
    // Firestore transactions are serializable: run them one at a time, writes applied at commit.
    runTransaction: run => { const done = serial.then(async () => { browser.transactions++; const writes = []; const result = await run({ get: async ref => snapshot(ref.collection, ref.id), set: (ref, patch, options) => { writes.push([ref, patch, options]); } }); for (const [ref, patch, options] of writes) write(ref.collection, ref.id, patch, options); return result; }); serial = done.catch(() => {}); return done; } };
  const cached = () => { const { revision, ...row } = structuredClone(docs.get(`jobs/${ID}`)); return row; };
  return { docs, store, db, browser, job: () => docs.get(`jobs/${ID}`), cached, touch: () => db.collection('jobs').doc(ID).set({ opsNotes: 'Synthetic concurrent edit' }, { merge: true }) };
}

// The suite's own finance action and lifecycle helpers, reached through /api/highlevel exactly as the page does.
function suitePage(fs, input = null, env = HUB_ENV) {
  const requests = [], toasts = [];
  const hubFetch = async (url, init = {}) => {
    requests.push({ url, init: { method: init.method, headers: init.headers, body: init.body } });
    return highlevelPost({ request: new Request(ORIGIN + url, { method: init.method, headers: { Origin: ORIGIN, Cookie: COOKIE, ...init.headers }, body: init.body }), env });
  };
  const context = vm.createContext({ window: {}, Date: FixedDate, db: fs.db, jobsCache: [fs.cached()], hubFetch, askAction: async () => input, render: () => {}, showToast: message => toasts.push(message), employeeIdentity: () => 'zacb', financeDatePlus: () => '2026-09-29', jobStage: row => row.pipelineStatus || row.status || 'scheduled' });
  vm.runInContext([
    'function jobs(){return jobsCache}',
    ...['const money=', 'const payMoney=', 'const day=', 'async function patchJob(', 'function cachePortalInvitation(', 'function cacheSalesExit(', 'function portalInvitationState(', 'function portalInvitationLabel(', 'async function syncLifecycle(', 'function financeState(', 'function communicationNote(', 'async function syncCustomerCommunication(', 'window.EGCCustomerCommunication='].map(sourceLine),
    sourceBetween('const customerCommunicationTypes={', 'function communicationNote('),
    sourceBetween('window.opsFinanceAction=', 'function addCalendarMonths'),
  ].join('\n'), context, { filename: 'employee-suite.js#finance' });
  return { window: context.window, requests, toasts };
}

// A small DOM: enough for the money module to build, fill and submit its dialog.
class FakeNode { constructor() { this.childNodes = []; this.parentNode = null; } append(...nodes) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); } } replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); } remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; } get isConnected() { return false; } }
class FakeText extends FakeNode { constructor(data) { super(); this.data = data; } }
class FakeElement extends FakeNode {
  constructor(tag) { super(); Object.assign(this, { tagName: tag.toUpperCase(), attributes: {}, listeners: {}, id: '', name: '', value: '', type: '', className: '', disabled: false, open: false, textContent: '' }); }
  setAttribute(name, value) { this.attributes[name] = String(value); } getAttribute(name) { return this.attributes[name] ?? null; } removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } removeEventListener() {}
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {} }); }
  get elements() { const out = [], walk = node => { for (const child of node.childNodes) if (child instanceof FakeElement) { out.push(child); walk(child); } }; walk(this); return out; }
  get text() { return this.textContent + this.childNodes.map(node => node instanceof FakeElement ? node.text : node.data).join(''); }
  querySelector() { return null; } querySelectorAll(selector) { return selector === 'input,select,textarea' ? this.elements.filter(node => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) : []; }
  focus() {} showModal() { this.open = true; } close() { this.open = false; }
}
const storage = data => new Proxy(data, { get: (target, key) => ({ getItem: name => Object.hasOwn(target, name) ? target[name] : null, setItem: (name, value) => { target[name] = String(value); }, removeItem: name => { delete target[name]; } })[key] });

// /api/money over the shared store. A fault drops the request ('offline') or only its answer ('lost').
function moneyApi(fs, { env = { MONEY_API_ENABLED: 'true' }, faults = [] } = {}) {
  const api = moneyHandlers({ session: async () => OWNER, storage: () => fs.store, now: () => new Date(clock.now) }), posts = [], gets = [];
  const hubFetch = async (url, init = {}) => {
    const request = new Request(ORIGIN + url, { method: init.method || 'GET', headers: { 'Sec-Fetch-Site': 'same-origin', Origin: ORIGIN, ...(init.headers || {}) }, body: init.body });
    if (init.method !== 'POST') { gets.push(url); return api.get({ request, env }); }
    posts.push(JSON.parse(init.body));
    const fault = faults.shift();
    if (fault === 'offline') throw new TypeError('Failed to fetch');
    const response = await api.post({ request, env });
    if (fault === 'lost') throw new TypeError('Failed to fetch');
    return response;
  };
  return { hubFetch, posts, gets, faults };
}

// One Hub tab with the money module loaded after the suite (sessionStorage is the tab's).
function moneyTab({ api, hooks, session = { egc_u: 'zacb' }, flag = true, legacy = null }) {
  const toasts = [], listeners = {}, body = new FakeElement('body'), legacyCalls = [], timers = [];
  // The module's short waits (read-back backoff, the missed-trigger flag) run at once and are recorded; the long request
  // and next-form caps keep their length and are always cleared first.
  const fastTimeout = (fn, ms = 0, ...args) => { timers.push(ms); return setTimeout(fn, ms < 10000 ? 0 : ms, ...args); };
  const window = { EGC_FLAGS: { moneyApi: flag }, hubFetch: api.hubFetch, showToast: message => toasts.push(message), EGCCustomerCommunication: hooks, opsFinanceAction: async (id, action) => { legacyCalls.push([id, action]); return legacy?.(id, action); },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, removeEventListener() {}, dispatchEvent: event => { for (const fn of listeners[event.type] || []) fn(event); } };
  const context = vm.createContext({ window, document: { createElement: tag => new FakeElement(tag), createTextNode: data => new FakeText(data), body, activeElement: null }, Node: FakeNode, HTMLElement: FakeElement, CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    sessionStorage: storage(session), localStorage: storage({}), crypto: globalThis.crypto, Date: FixedDate, URLSearchParams, AbortController, setTimeout: fastTimeout, clearTimeout, queueMicrotask, fetch: () => { throw new Error('the module must use hubFetch'); } });
  vm.runInContext(moduleSource, context, { filename: 'employee-money-actions.js' });
  const dialog = () => body.childNodes.find(node => node.tagName === 'DIALOG') || null, form = () => dialog()?.childNodes[0];
  return {
    window, toasts, legacyCalls, dialog, session, timers,
    open: (action, id = ID) => window.opsFinanceAction(id, action),
    fill: fields => { for (const [name, value] of Object.entries(fields)) { const node = form().elements.find(el => el.name === name); assert.ok(node, `no ${name} field`); node.value = value; node.fire('input'); node.fire('change'); } },
    find: label => form()?.elements.find(el => el.tagName === 'BUTTON' && el.text === label) || null,
    button: label => { const node = form()?.elements.find(el => el.tagName === 'BUTTON' && el.text === label); assert.ok(node, `no ${label} button`); return node; },
    notice: () => (form()?.elements || []).filter(el => el.tagName === 'P').map(el => el.text).join('\n'),
    idle: () => form()?.getAttribute('aria-busy') === 'false',
    submit: () => form().fire('submit'),
  };
}
async function settle(done, label) {
  for (let i = 0; i < 5000; i++) { if (done()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail(`timed out waiting for ${label}`);
}
// Submits the open dialog and waits for the save's toast.
async function save(tab, fields = {}) {
  tab.fill(fields);
  const toasts = tab.toasts.length; tab.submit();
  await settle(() => tab.toasts.length > toasts, 'the save toast');
}

// HighLevel: record every provider call the /api/highlevel handler makes.
// With `hold`, HighLevel answers only once hold.open() is called (a slow round trip).
function highlevelProvider(t, hold = null) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = new URL(String(url));
    calls.push({ host: target.hostname, path: target.pathname, method: options.method || 'GET', body: options.body ?? null, key: options.headers?.['Idempotency-Key'] ?? null });
    if (hold) await hold.promise;
    if (target.hostname !== 'services.leadconnectorhq.com') return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(target.pathname.endsWith('/notes') ? { note: { id: 'note-1' } } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

const latch = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };

// The five legacy finance saves, in order, with the matching dialog entries.
const STEPS = [
  { action: 'estimate', event: 'estimate-ready', legacy: { amount: '1400', scope: SCOPE, deposit: '700', validUntil: '2026-10-06' }, fields: { scope: SCOPE } },
  { action: 'accept', event: 'estimate-approved', legacy: { acceptedBy: 'Synthetic Customer' }, fields: {} },
  { action: 'deposit', event: 'deposit-received', legacy: { amount: '700', reference: 'CHK-1001' }, fields: { reference: 'CHK-1001' } },
  { action: 'invoice', event: 'invoice-issued', legacy: { dueDate: '2026-09-29', customerReference: '' }, fields: {} },
  { action: 'payment', event: 'payment-received', legacy: { amount: '700', reference: 'CHK-1002' }, fields: { reference: 'CHK-1002' } },
];
const legacyRun = async (job, step, now) => { const fs = firestore(job), page = suitePage(fs, step.legacy); at(now); await page.window.opsFinanceAction(ID, step.action); return { fs, page }; };
async function serverRun(job, step, now, options = {}) {
  const fs = firestore(job), page = suitePage(fs), api = moneyApi(fs, options), tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication });
  at(now); await tab.open(step.action); assert.ok(tab.dialog(), 'the server money dialog opened');
  await save(tab, step.fields);
  return { fs, page, api, tab };
}
const exact = request => [request.url, JSON.stringify(request.init)].join('\n');
const trail = fs => JSON.stringify(['communicationLog', 'communicationLastEvent', 'communicationLastStatus', 'communicationLastAt', 'automationMilestones', 'lifecycleSync', 'lifecycleSyncPayload', 'lifecycleSyncError', 'lifecycleSyncNextRetryAt', 'highlevelContactId'].map(key => fs.job()[key] ?? null));

test('each of the five finance saves makes the same /api/highlevel request, tag, log and toast on both paths', async t => {
  const ghl = highlevelProvider(t), hosts = new Set();
  let job = BASE;
  for (const [index, step] of STEPS.entries()) {
    const now = T(index + 1);
    const legacy = await legacyRun(job, step, now), legacyGhl = ghl.splice(0);
    const server = await serverRun(job, step, now), serverGhl = ghl.splice(0);
    for (const call of [...legacyGhl, ...serverGhl]) hosts.add(call.host);
    assert.equal(legacy.page.requests.length, 1, `${step.action}: the standard save makes one lifecycle request`);
    assert.equal(server.page.requests.length, 1, `${step.action}: the server save makes one lifecycle request`);
    assert.equal(exact(server.page.requests[0]), exact(legacy.page.requests[0]), `${step.action}: byte-for-byte the same /api/highlevel request`);
    const payload = JSON.parse(server.page.requests[0].init.body);
    assert.equal(payload.event, step.event); assert.equal(payload.job_id, ID); assert.equal(payload.suppress_automation, false);
    assert.equal(payload.idempotency_key, `communication:${ID}:${step.event}:${step.action}:${now}`, 'the legacy marker: the finance action and the save time');
    assert.equal(server.fs.job().moneyUpdatedAt, now);
    assert.deepEqual(JSON.parse(JSON.stringify(serverGhl)), JSON.parse(JSON.stringify(legacyGhl)), `${step.action}: HighLevel sees the same calls`);
    const tags = serverGhl.filter(call => call.path === '/contacts/contact-1/tags').map(call => JSON.parse(call.body).tags);
    assert.deepEqual(tags, [[`egc-${step.event}`]], `${step.action}: exactly the egc-${step.event} tag`);
    assert.equal(trail(server.fs), trail(legacy.fs), `${step.action}: the same communication log and retry marker on the job`);
    assert.equal(server.fs.job().communicationLastStatus, 'triggered');
    assert.equal(server.tab.toasts.at(-1), legacy.page.toasts.at(-1), `${step.action}: the same toast`);
    assert.equal(server.tab.toasts.length, 1); assert.equal(server.api.posts.length, 1);
    job = server.fs.cached();
  }
  assert.deepEqual([...hosts], ['services.leadconnectorhq.com'], 'only HighLevel is called, directly');
});

test('the standard finance save still sends today\'s exact request (the flag-off path is unchanged)', async t => {
  highlevelProvider(t);
  const { page } = await legacyRun(BASE, STEPS[0], T(1));
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, '/api/highlevel');
  assert.equal(JSON.stringify(page.requests[0].init), JSON.stringify({ method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `communication:${ID}:estimate-ready:estimate:${T(1)}` }, body: JSON.stringify({
    tool: 'lifecycle', event: 'estimate-ready', job_id: ID, idempotency_key: `communication:${ID}:estimate-ready:estimate:${T(1)}`, highlevel_contact_id: 'contact-1', appointment_id: 'appt-1', suppress_automation: false,
    note: 'Estimate ready · EST-ABC123 · Service date 2026-09-24 · Estimate $1,400.00', client: { name: 'Synthetic Customer', phone: '9705550100', email: 'synthetic@example.invalid', address: '1 Synthetic Way, Fort Collins, CO 80521', highlevel_contact_id: 'contact-1' } }) }));
  assert.deepEqual(page.toasts, ['Saved · HighLevel automation triggered']);
});

test('with the money switch off the Hub runs only the standard save; the money module never triggers HighLevel itself', async t => {
  const ghl = highlevelProvider(t);
  // The browser already knows the switch is off.
  const offFs = firestore(BASE), offPage = suitePage(offFs, STEPS[0].legacy), off = moneyApi(offFs, { env: {} });
  const hookCalls = [], hooks = { read: async id => { hookCalls.push(['read', id]); return null; }, sync: async (job, event) => { hookCalls.push(['sync', event]); return true; }, portalLabel: () => '', render: () => {} };
  const tab = moneyTab({ api: off, hooks, flag: false, legacy: offPage.window.opsFinanceAction });
  at(T(1)); await tab.open('estimate');
  assert.deepEqual(tab.legacyCalls, [[ID, 'estimate']]); assert.equal(tab.dialog(), null); assert.equal(off.posts.length, 0);
  assert.equal(offPage.requests.length, 1, 'only the standard save\'s own request'); assert.deepEqual(hookCalls, []);
  // The switch was turned off on the server while the dialog was open: nothing is saved there and nothing is triggered from the dialog.
  const fs = firestore(BASE), page = suitePage(fs, STEPS[2].legacy), api = moneyApi(fs, { env: {} });
  const job = { ...BASE, total: 1400, priceQuoted: 1400, estimate: { number: 'EST-ABC123', status: 'accepted', amount: 1400, depositRequired: 700, scope: SCOPE, validUntil: '2026-10-06' }, customerApproval: { status: 'approved', amount: 1400 }, deposit: { amount: 700, status: 'required' } };
  fs.docs.set(`jobs/${ID}`, { ...job, id: ID, revision: 'r0' });
  const openTab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication, legacy: page.window.opsFinanceAction });
  at(T(2)); await openTab.open('deposit');
  // The GET reports the server switch off before any typing and hands over to the standard tool.
  await settle(() => page.toasts.length === 1 && openTab.toasts.length === 1, 'the hand-over and the standard save');
  assert.equal(openTab.dialog(), null); assert.deepEqual(openTab.legacyCalls, [[ID, 'deposit']]); assert.equal(api.posts.length, 0);
  assert.equal(page.requests.length, 1); assert.equal(JSON.parse(page.requests[0].init.body).event, 'deposit-received'); assert.match(openTab.toasts[0], /turned off/);
  assert.deepEqual([...offPage.toasts, ...page.toasts], ['Saved · HighLevel automation triggered', 'Saved · HighLevel automation triggered']);
  assert.equal(ghl.filter(call => call.path.endsWith('/tags')).length, 2, 'one tag for each standard save, none from the money module');
});

test('notify=false suppresses the tag on both paths with the same request and toast', async t => {
  const ghl = highlevelProvider(t), job = { ...BASE, notify: false };
  const legacy = await legacyRun(job, STEPS[0], T(1)), legacyGhl = ghl.splice(0);
  const server = await serverRun(job, STEPS[0], T(1)), serverGhl = ghl.splice(0);
  assert.equal(exact(server.page.requests[0]), exact(legacy.page.requests[0]));
  assert.equal(JSON.parse(server.page.requests[0].init.body).suppress_automation, true);
  assert.equal(serverGhl.some(call => call.path.endsWith('/tags')), false, 'no egc-<event> tag');
  assert.equal(legacyGhl.some(call => call.path.endsWith('/tags')), false);
  assert.deepEqual([server.tab.toasts.at(-1), legacy.page.toasts.at(-1)], ['Saved · customer automation suppressed', 'Saved · customer automation suppressed']);
  assert.equal(server.fs.job().communicationLastStatus, 'suppressed'); assert.equal(trail(server.fs), trail(legacy.fs));
});

test('a refused, failed or conflicting save triggers nothing', async t => {
  const ghl = highlevelProvider(t);
  const accepted = { ...BASE, priceQuoted: 1400, estimate: { number: 'EST-ABC123', status: 'accepted', amount: 1400, depositRequired: 700, scope: SCOPE, validUntil: '2026-10-06' }, customerApproval: { status: 'approved', amount: 1400 }, deposit: { amount: 700, status: 'required' } };
  const fs = firestore(accepted), page = suitePage(fs), api = moneyApi(fs, { faults: [null, 'offline'] }), tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication });
  at(T(1)); await tab.open('deposit');
  // Refused by the server: more than the balance.
  tab.fill({ amount: '5000', reference: 'CHK-1' }); tab.submit();
  await settle(() => api.posts.length === 1 && tab.idle() && /more than the \$1,400\.00 balance/.test(tab.notice()), 'the refusal');
  // Failed: the request never reached the server; it is kept for an unchanged retry.
  tab.fill({ amount: '700' }); tab.submit();
  await settle(() => api.posts.length === 2 && tab.find('Retry original save'), 'the kept request');
  assert.match(tab.notice(), /Retry it unchanged/);
  // Discarded, then a conflicting save: the job changed after the dialog loaded it.
  tab.button('Discard it').fire('click'); await fs.touch();
  tab.fill({ amount: '700', reference: 'CHK-2' }); tab.submit();
  await settle(() => api.posts.length === 3 && tab.idle() && /changed after you opened it/.test(tab.notice()), 'the revision conflict');
  assert.equal(page.requests.length, 0, 'no lifecycle request for a refused, failed or conflicting save');
  assert.equal(ghl.length, 0); assert.deepEqual(tab.toasts, []); assert.equal(fs.job().deposit.paidAmount, undefined);
  // The latest details save once and trigger once.
  tab.button('Load latest details').fire('click'); await settle(() => tab.idle() && tab.find('Save deposit') && !/changed after you opened it/.test(tab.notice()), 'the reload');
  tab.fill({ reference: 'CHK-2' }); tab.submit();
  await settle(() => tab.toasts.length === 1, 'the save');
  assert.equal(page.requests.length, 1); assert.equal(JSON.parse(page.requests[0].init.body).event, 'deposit-received');
  assert.deepEqual(tab.toasts, ['Saved · HighLevel automation triggered']);
});

test('a save whose answer was lost triggers exactly once when it is replayed, with the original save\'s marker', async t => {
  const ghl = highlevelProvider(t);
  const legacy = await legacyRun(BASE, STEPS[0], T(1)); ghl.splice(0);
  const fs = firestore(BASE), page = suitePage(fs), api = moneyApi(fs, { faults: ['lost'] }), tabSession = { egc_u: 'zacb' };
  const tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication, session: tabSession });
  at(T(1)); await tab.open('estimate');
  tab.fill({ scope: SCOPE }); tab.submit();
  await settle(() => tab.find('Retry original save'), 'the lost answer');
  assert.equal(fs.job().moneyUpdatedAt, T(1), 'the server saved it'); assert.equal(page.requests.length, 0, 'nothing is triggered before the save is confirmed');
  // A duplicated tab carries the same unconfirmed request.
  const twin = moneyTab({ api, hooks: page.window.EGCCustomerCommunication, session: structuredClone(tabSession) });
  // Minutes later the original tab retries it unchanged: the server replays it and the trigger starts once.
  at(T(9)); tab.button('Retry original save').fire('click');
  await settle(() => tab.toasts.length === 1, 'the replay');
  assert.equal(api.posts.length, 2); assert.deepEqual(api.posts[1], api.posts[0]);
  assert.equal(page.requests.length, 1);
  assert.equal(exact(page.requests[0]), exact(legacy.page.requests[0]), 'the same request the standard save made at the original time');
  assert.deepEqual(tab.toasts, ['Saved · HighLevel automation triggered']);
  // The duplicated tab replays it too; the job's log shows it already started, so it is not started again.
  at(T(10)); await twin.open('estimate'); assert.match(twin.notice(), /was not confirmed/); twin.button('Retry original save').fire('click');
  await settle(() => twin.toasts.length === 1, 'the second replay');
  assert.equal(api.posts.length, 3); assert.equal(page.requests.length, 1, 'still exactly one lifecycle request');
  assert.equal(ghl.filter(call => call.path.endsWith('/tags')).length, 1);
  assert.deepEqual(twin.toasts, ['Saved · HighLevel automation triggered']);
  assert.equal(fs.job().communicationLog.length, 1);
});

test('a replay refused because the job changed since triggers nothing and says so', async t => {
  highlevelProvider(t);
  const fs = firestore(BASE), page = suitePage(fs), api = moneyApi(fs, { faults: ['lost'] }), tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication });
  at(T(1)); await tab.open('estimate'); tab.fill({ scope: SCOPE }); tab.submit();
  await settle(() => tab.find('Retry original save'), 'the lost answer');
  // Another manager records the approval before this tab retries.
  const other = moneyTab({ api, hooks: page.window.EGCCustomerCommunication, session: { egc_u: 'zacb' } });
  at(T(2)); await other.open('accept'); await save(other);
  assert.equal(page.requests.length, 1); assert.equal(JSON.parse(page.requests[0].init.body).event, 'estimate-approved');
  at(T(3)); tab.button('Retry original save').fire('click');
  await settle(() => tab.toasts.length === 1, 'the refused replay');
  assert.equal(page.requests.length, 1, 'the estimate-ready trigger is not started for a save the job no longer shows');
  assert.equal(tab.toasts[0], 'Saved earlier · the job has changed since, so review it · customer message not triggered · use Trigger in HighLevel if it is still needed');
});

test('marking an estimate sent and voiding an invoice trigger nothing, as in the standard tools', async t => {
  highlevelProvider(t);
  const job = { ...BASE, priceQuoted: 1400, estimate: { number: 'EST-ABC123', status: 'draft', amount: 1400, depositRequired: 700, scope: SCOPE, validUntil: '2026-10-06', lineItems: [{ id: 'line-1', kind: 'service', name: 'Garage transformation', description: '', quantity: 1, unitCents: 140000, amount: 1400 }] },
    invoice: { number: 'INV-ABC123', status: 'issued', amount: 1400, dueDate: '2026-09-29', issuedAt: T(0) } };
  const fs = firestore(job), page = suitePage(fs), api = moneyApi(fs), tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication });
  at(T(1)); await tab.open('estimate'); tab.button('Record that it was sent').fire('click');
  await save(tab, { channel: 'text' });
  at(T(2)); await tab.open('invoice'); tab.button('Void this invoice…').fire('click');
  await save(tab, { reason: 'Synthetic split invoice' });
  assert.deepEqual(api.posts.map(post => post.action), ['estimate.mark_sent', 'invoice.void']);
  assert.equal(page.requests.length, 0);
  assert.match(tab.toasts[0], /^Estimate marked as sent · nothing was sent to the customer/); assert.match(tab.toasts[1], /^Invoice voided · nothing was sent to the customer/);
});

// Updated deliberately (MONEY-GHL-PARITY review): a save the browser cannot read back used to end in a toast only. It is
// now read back again with a short backoff and then flagged in the job's log, so the Customer messages board shows it.
test('without the suite helper nothing is triggered; a save that cannot be read back is retried, then flagged in the job\'s log', async t => {
  const ghl = highlevelProvider(t);
  const fs = firestore(BASE), api = moneyApi(fs), bare = moneyTab({ api, hooks: undefined });
  at(T(1)); await bare.open('estimate'); await save(bare, { scope: SCOPE });
  assert.deepEqual(bare.toasts, ['Saved · customer message not triggered · use Trigger in HighLevel if it is still needed']);
  // Every browser read fails, and the Hub's cached copy of the job predates this save.
  const page = suitePage(fs), tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication });
  fs.browser.readFaults = Infinity;
  at(T(2)); await tab.open('accept'); await save(tab);
  const requestId = api.posts[1].requestId;
  assert.equal(fs.browser.reads, 4, 'the first read and three retries'); assert.deepEqual(tab.timers.filter(ms => ms < 10000), [400, 1200, 3000, 8000]);
  assert.equal(page.requests.length, 0); assert.equal(ghl.length, 0, 'nothing is triggered from a job that does not show this save');
  const job = fs.job();
  assert.deepEqual(job.communicationLog, [{ id: `communication:${ID}:estimate-approved:money:${requestId}`, event: 'estimate-approved', label: 'Estimate approved', status: 'needs_attention', source: 'automatic', attemptedAt: T(2), trigger: '' }]);
  assert.deepEqual([job.communicationLastEvent, job.communicationLastStatus, job.communicationLastAt, job.updatedAt], ['estimate-approved', 'needs_attention', T(2), T(2)], 'the Action Center lists it as a message that needs retry');
  assert.equal(job.lifecycleSyncPayload, undefined, 'no automatic retry for a save the Hub could not confirm');
  assert.deepEqual(tab.toasts, ['Saved · customer message not triggered · flagged in Customer messages, so use Trigger in HighLevel there if it is still needed']);
});

test('a read-back that fails at first is retried with a short backoff, then the trigger starts as usual', async t => {
  highlevelProvider(t);
  const legacy = await legacyRun(BASE, STEPS[0], T(1));
  const fs = firestore(BASE), page = suitePage(fs), api = moneyApi(fs), tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication });
  fs.browser.readFaults = 2;
  at(T(1)); await tab.open('estimate'); await save(tab, { scope: SCOPE });
  assert.equal(fs.browser.reads, 3); assert.deepEqual(tab.timers.filter(ms => ms < 10000), [400, 1200]);
  assert.equal(page.requests.length, 1); assert.equal(exact(page.requests[0]), exact(legacy.page.requests[0]));
  assert.deepEqual(tab.toasts, ['Saved · HighLevel automation triggered']); assert.equal(trail(fs), trail(legacy.fs));
});

test('when the missed-trigger flag cannot be written either, the toast still reports it', async t => {
  highlevelProvider(t);
  for (const fault of ['fails', 'never settles']) {
    const fs = firestore(BASE), page = suitePage(fs), api = moneyApi(fs), tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication });
    fs.browser.readFaults = Infinity; if (fault === 'fails') fs.browser.writeFaults = Infinity; else fs.browser.hangWrites = true;
    at(T(1)); await tab.open('estimate'); await save(tab, { scope: SCOPE });
    assert.deepEqual(tab.toasts, ['Saved · customer message not triggered · use Trigger in HighLevel if it is still needed'], fault);
    assert.equal(fs.job().communicationLog, undefined, fault); assert.equal(page.requests.length, 0, fault);
  }
});

test('two tabs replaying the same lost save within one HighLevel round trip start its trigger once', async t => {
  const hold = latch(), ghl = highlevelProvider(t, hold);
  const fs = firestore(BASE), pageA = suitePage(fs), pageB = suitePage(fs), api = moneyApi(fs, { faults: ['lost'] }), session = { egc_u: 'zacb' };
  const tab = moneyTab({ api, hooks: pageA.window.EGCCustomerCommunication, session });
  at(T(1)); await tab.open('estimate'); tab.fill({ scope: SCOPE }); tab.submit();
  await settle(() => tab.find('Retry original save'), 'the lost answer');
  const twin = moneyTab({ api, hooks: pageB.window.EGCCustomerCommunication, session: structuredClone(session) });
  at(T(2)); await twin.open('estimate'); assert.match(twin.notice(), /was not confirmed/);
  tab.button('Retry original save').fire('click'); twin.button('Retry original save').fire('click');
  const lifecycle = () => pageA.requests.length + pageB.requests.length;
  await settle(() => lifecycle() >= 2 || tab.toasts.length + twin.toasts.length === 1, 'one tab to start the trigger and the other to stand down');
  hold.open();
  await settle(() => tab.toasts.length + twin.toasts.length === 2, 'both toasts');
  assert.equal(api.posts.length, 3); assert.equal(fs.browser.transactions, 2, 'each tab tried to claim it'); assert.equal(lifecycle(), 1, 'one /api/highlevel request');
  assert.equal(ghl.filter(call => call.path.endsWith('/tags')).length, 1, 'one tag'); assert.equal(ghl.filter(call => call.path.endsWith('/notes')).length, 1, 'one note');
  assert.deepEqual([...tab.toasts, ...twin.toasts].sort(), ['Saved · HighLevel automation triggered', 'Saved · customer message already started in another tab']);
  assert.deepEqual(fs.job().communicationLog.map(entry => [entry.id, entry.status]), [[`communication:${ID}:estimate-ready:estimate:${T(1)}`, 'triggered']]);
});

test('a claim left pending by a tab that closed mid-trigger holds for five minutes, then a replay starts the trigger', async t => {
  highlevelProvider(t);
  const fs = firestore(BASE), page = suitePage(fs), api = moneyApi(fs, { faults: ['lost'] }), session = { egc_u: 'zacb' };
  const tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication, session });
  at(T(1)); await tab.open('estimate'); tab.fill({ scope: SCOPE }); tab.submit();
  await settle(() => tab.find('Retry original save'), 'the lost answer');
  const twin = moneyTab({ api, hooks: page.window.EGCCustomerCommunication, session: structuredClone(session) });
  // Another tab claimed this trigger at 12:02 and closed before HighLevel answered.
  const key = `communication:${ID}:estimate-ready:estimate:${T(1)}`;
  fs.docs.set(`jobs/${ID}`, { ...fs.job(), communicationLog: [{ id: key, event: 'estimate-ready', label: 'Estimate ready', status: 'pending', source: 'automatic', attemptedAt: T(2), trigger: '' }] });
  at(T(6)); tab.button('Retry original save').fire('click');
  await settle(() => tab.toasts.length === 1, 'the replay four minutes later');
  assert.deepEqual(tab.toasts, ['Saved · customer message already started in another tab']); assert.equal(page.requests.length, 0);
  at(T(8)); await twin.open('estimate'); twin.button('Retry original save').fire('click');
  await settle(() => twin.toasts.length === 1, 'the replay six minutes later');
  assert.deepEqual(twin.toasts, ['Saved · HighLevel automation triggered']); assert.equal(page.requests.length, 1);
  assert.equal(JSON.parse(page.requests[0].init.body).idempotency_key, key);
  assert.deepEqual(fs.job().communicationLog.map(entry => [entry.id, entry.status]), [[key, 'triggered']]);
});

test('the next money form for the same job loads after the last save\'s trigger, so saving it does not conflict', async t => {
  const hold = latch(), ghl = highlevelProvider(t, hold);
  const fs = firestore(BASE), page = suitePage(fs), api = moneyApi(fs), tab = moneyTab({ api, hooks: page.window.EGCCustomerCommunication });
  at(T(1)); await tab.open('estimate'); tab.fill({ scope: SCOPE }); tab.submit();
  await settle(() => ghl.length > 0, 'HighLevel to be reached');
  assert.equal(tab.dialog(), null, 'the estimate form closed once the money was saved');
  // The manager records the approval straight away, while HighLevel is still answering the estimate-ready trigger.
  at(T(2)); const opening = tab.open('accept');
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(tab.dialog(), 'the approval form is open'); assert.equal(api.gets.length, 1, 'but it has not loaded the job yet');
  hold.open(); await opening;
  assert.deepEqual(tab.toasts, ['Saved · HighLevel automation triggered']); assert.equal(api.gets.length, 2);
  assert.equal(fs.job().communicationLastEvent, 'estimate-ready', 'the trigger\'s patches landed before the form loaded');
  await save(tab);
  assert.deepEqual(api.posts.map(post => post.action), ['estimate.save', 'estimate.record_approval']);
  assert.equal(tab.dialog(), null, 'the approval saved without a revision conflict');
  assert.deepEqual(page.requests.map(request => JSON.parse(request.init.body).event), ['estimate-ready', 'estimate-approved']);
});

test('a HighLevel failure keeps the legacy retry marker and toast', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return new Response('{"message":"synthetic outage"}', { status: 503 }); });
  const legacy = await legacyRun(BASE, STEPS[0], T(1));
  const server = await serverRun(BASE, STEPS[0], T(1));
  assert.equal(exact(server.page.requests[0]), exact(legacy.page.requests[0]));
  assert.deepEqual([server.tab.toasts.at(-1), legacy.page.toasts.at(-1)], ['Saved · customer message needs retry', 'Saved · customer message needs retry']);
  const job = server.fs.job();
  assert.equal(job.lifecycleSync.status, 'error'); assert.equal(job.lifecycleSyncPayload.idempotency_key, `communication:${ID}:estimate-ready:estimate:${T(1)}`);
  assert.equal(job.communicationLastStatus, 'needs_attention'); assert.equal(trail(server.fs), trail(legacy.fs), 'the same retry marker and schedule');
  assert.ok(calls.length > 0);
});

test('with the native operations bridge on, both paths sign the same HighLevel note and add the same tag', async t => {
  const ghl = highlevelProvider(t), step = STEPS[3];
  const job = { ...BASE, priceQuoted: 1400, estimate: { number: 'EST-ABC123', status: 'accepted', amount: 1400, depositRequired: 700, scope: SCOPE, validUntil: '2026-10-06' }, customerApproval: { status: 'approved', amount: 1400 }, deposit: { amount: 700, paidAmount: 700, status: 'paid', verified: true }, payment: { amount: 700, verified: true, method: 'deposit', reference: 'CHK-1001', recordedBy: 'zacb' } };
  const signed = calls => calls.filter(call => call.path === '/operations/rpc').map(call => JSON.parse(Buffer.from(JSON.parse(call.body).envelope.split('.')[0], 'base64url').toString()).request.body);
  const fsL = firestore(job), legacyPage = suitePage(fsL, step.legacy, OPS_ENV);
  at(T(1)); await legacyPage.window.opsFinanceAction(ID, step.action); const legacyGhl = ghl.splice(0);
  const fs = firestore(job), page = suitePage(fs, null, OPS_ENV), tab = moneyTab({ api: moneyApi(fs), hooks: page.window.EGCCustomerCommunication });
  at(T(1)); await tab.open(step.action); await save(tab); const serverGhl = ghl.splice(0);
  assert.equal(exact(page.requests[0]), exact(legacyPage.requests[0]));
  assert.equal(signed(serverGhl).length, 1); assert.deepEqual(signed(serverGhl), signed(legacyGhl));
  assert.equal(signed(serverGhl)[0].requestId, `communication:${ID}:invoice-issued:invoice:${T(1)}`);
  assert.deepEqual(serverGhl.filter(call => call.path.endsWith('/tags')).map(call => call.body), ['{"tags":["egc-invoice-issued"]}']);
  assert.deepEqual(legacyGhl.filter(call => call.path.endsWith('/tags')).map(call => call.body), ['{"tags":["egc-invoice-issued"]}']);
  assert.equal(tab.toasts.at(-1), legacyPage.toasts.at(-1));
});
