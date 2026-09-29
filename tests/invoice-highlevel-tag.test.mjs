// M5 invoicing, HighLevel-owned messaging: issuing invoices from the Hub
// Invoicing screen (one or a batch) starts exactly the lifecycle trigger the
// standard finance save starts, byte for byte: one POST /api/highlevel
// tool=lifecycle event=invoice-issued per invoice, adding the egc-invoice-issued
// tag whose HighLevel workflow sends the invoice. The Hub sends no message
// itself: no /api/messages call and no HighLevel conversations/messages call.
// Both paths run their real browser code (the suite's finance action and
// helpers sliced into a vm; the Invoicing screen on the real UI kit over a
// small DOM) against the real /api/invoice-batch and /api/highlevel handlers.
// Only Firestore (in memory) and HighLevel (fetch) are faked; the clock is fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from './helpers/vm-realm.mjs';
import { invoiceBatchHandlers } from '../functions/api/invoice-batch.js';
import { onRequestPost as highlevelPost } from '../functions/api/highlevel.js';
import { mutateMoney } from '../functions/_lib/money-service.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createDocument, storage } from './helpers/hub-dom.mjs';

const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const kitSource = readFileSync(new URL('../employee-ui-kit.js', import.meta.url), 'utf8');
const moneySource = readFileSync(new URL('../employee-money.js', import.meta.url), 'utf8');
const sourceLine = prefix => { const line = suite.split('\n').find(value => value.startsWith(prefix)); assert.ok(line, `missing ${prefix}`); return line; };
const sourceBetween = (start, end) => { const first = suite.indexOf(start), last = suite.indexOf(end, first); assert.ok(first >= 0 && last > first, `missing ${start}`); return suite.slice(first, last); };

const HUB_ENV = { HUB_SESSION_SECRET: 'synthetic-invoice-tag-session-secret', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-zac', displayName: 'Synthetic Owner', role: 'owner', payType: 'owner', hourlyRate: 0 } }), HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: 'location-1', EGC_OPERATIONS_ENABLED: 'false', MONEY_API_ENABLED: 'true' };
const COOKIE = (await createHubSessionCookie(HUB_ENV, 'ZacB')).split(';')[0];
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const ORIGIN = 'https://easygaragecleaning.com', AT = '2026-09-22T18:05:00.000Z', DUE = '2026-09-29';
// Finished jobs with an accepted quote, no payment and no invoice: ready to invoice on either path.
const finished = (id, overrides = {}) => ({ type: 'job', customerId: `c-${id}`, customer: `Synthetic ${id}`, phone: '9705550100', email: `${id}@example.invalid`, address: '1 Synthetic Way, Fort Collins, CO 80521',
  serviceType: 'Garage transformation', date: '2026-09-18', status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-18T22:00:00.000Z', notify: true,
  highlevelContactId: `contact-${id}`, highlevelAppointmentId: `appt-${id}`, total: 1400, estimate: { number: `EST-${id.slice(-6).toUpperCase()}`, status: 'accepted', amount: 1400 }, ...overrides });
const JOBS = { 'job-alpha01': finished('job-alpha01'), 'job-beta002': finished('job-beta002', { total: 900, estimate: { number: 'EST-BETA02', status: 'accepted', amount: 900 } }), 'job-quiet03': finished('job-quiet03', { notify: false }) };

const clock = { now: Date.parse(AT) };
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
// A manager's browser whose clock runs `skew` ms ahead of the server's (behind when negative).
const browserDate = (skew = 0) => skew ? class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now + skew])); } static now() { return clock.now + skew; } } : FixedDate;
const MINUTE = 60000, later = minutes => new Date(Date.parse(AT) + minutes * MINUTE).toISOString();

// One Firestore project: the money store (server, revisions) and the browser SDK (set-merge, transactions) share it.
function firestore(jobs) {
  const docs = new Map(Object.entries(jobs).map(([id, job]) => [`jobs/${id}`, { ...structuredClone(job), id, revision: `${id}-r0` }]));
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
  let serial = Promise.resolve();
  const db = { collection: collection => ({ doc: id => ({ collection, id, get: async () => snapshot(collection, id), set: async (patch, options = {}) => { write(collection, id, patch, options); } }) }),
    runTransaction: run => { const done = serial.then(async () => { const writes = []; const result = await run({ get: async ref => snapshot(ref.collection, ref.id), set: (ref, patch, options) => { writes.push([ref, patch, options]); } }); for (const [ref, patch, options] of writes) write(ref.collection, ref.id, patch, options); return result; }); serial = done.catch(() => {}); return done; } };
  const cached = () => [...docs].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => { const { revision, ...job } = structuredClone(row); return job; });
  return { docs, store, db, cached, job: id => docs.get(`jobs/${id}`) };
}

// The suite's own finance action and lifecycle helpers, reaching /api/highlevel exactly as the page does.
function suitePage(fs, input = null, { skew = 0 } = {}) {
  const requests = [], toasts = [];
  const hubFetch = async (url, init = {}) => {
    requests.push({ url, init: { method: init.method, headers: init.headers, body: init.body } });
    return highlevelPost({ request: new Request(ORIGIN + url, { method: init.method, headers: { Origin: ORIGIN, Cookie: COOKIE, ...init.headers }, body: init.body }), env: HUB_ENV });
  };
  const context = vm.createContext({ window: {}, Date: browserDate(skew), db: fs.db, jobsCache: fs.cached(), hubFetch, askAction: async () => input, render: () => {}, showToast: message => toasts.push(message), employeeIdentity: () => 'zacb', financeDatePlus: () => DUE, jobStage: row => row.pipelineStatus || row.status || 'scheduled' });
  vm.runInContext([
    'function jobs(){return jobsCache}',
    ...['const money=', 'const payMoney=', 'const day=', 'async function patchJob(', 'function cachePortalInvitation(', 'function cacheSalesExit(', 'function portalInvitationState(', 'function portalInvitationLabel(', 'async function syncLifecycle(', 'function financeState(', 'function communicationNote(', 'async function syncCustomerCommunication('].map(sourceLine),
    sourceBetween('const customerCommunicationTypes={', 'function communicationNote('),
    sourceBetween('window.opsFinanceAction=', 'function addCalendarMonths'),
    // The suite's own helper (MONEY-GHL-PARITY), which the Invoicing screen reuses: sync, read, claim, missed.
    sourceLine('window.EGCCustomerCommunication='),
    // Customer messages' Trigger in HighLevel button (a manual trigger).
    sourceLine('window.opsTriggerCommunication='),
  ].join('\n'), context, { filename: 'employee-suite.js#finance' });
  return { window: context.window, requests, toasts };
}

// One Hub tab with the Invoicing screen mounted on the real UI kit. `lose` drops the answer of the next issue POSTs.
function invoicingTab(fs, hooks, { session = storage({ egc_u: 'ZacB' }), lose = 0, store = fs.store, skew = 0 } = {}) {
  const document = createDocument(), Element = document.Element.prototype, calls = [], toasts = [], events = {};
  Element.prepend = function (...nodes) { for (const node of nodes.reverse()) this.insertBefore(node, this.childNodes[0] || null); };
  Element.showModal = function () { this.setAttribute('open', ''); };
  Element.close = function () { this.removeAttribute('open'); };
  for (const [name, pick] of [['lastChild', nodes => nodes.at(-1)], ['firstChild', nodes => nodes[0]]]) Object.defineProperty(Element, name, { configurable: true, get() { return pick(this.childNodes) || null; } });
  const api = invoiceBatchHandlers({ session: async () => OWNER, storage: () => store, now: () => new Date(clock.now) });
  const state = { lose };
  const hubFetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method });
    assert.equal(url.split('?')[0], '/api/invoice-batch', `the Invoicing screen only calls /api/invoice-batch, not ${url}`);
    const request = new Request(ORIGIN + url, { method, headers: { 'Sec-Fetch-Site': 'same-origin', Origin: ORIGIN, ...(init.headers || {}) }, body: init.body });
    const response = await (method === 'GET' ? api.get({ request, env: HUB_ENV }) : api.post({ request, env: HUB_ENV }));
    if (method === 'POST' && state.lose > 0) { state.lose--; throw new TypeError('Failed to fetch'); }
    return response;
  };
  const context = {
    console, URL, URLSearchParams, Intl, Promise, Map, Set, Error, TypeError, JSON, Object, Array, Math, Number, String, Symbol, AbortController, structuredClone, crypto, queueMicrotask,
    Date: browserDate(skew), Node: document.Node, document, sessionStorage: session, localStorage: storage(), CSS: { escape: value => String(value) }, setTimeout, clearTimeout,
    EGCCustomerCommunication: hooks, showToast: message => toasts.push(message),
    addEventListener: (name, listener) => { (events[name] ||= []).push(listener); }, removeEventListener() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(kitSource, context, { filename: 'employee-ui-kit.js' });
  vm.runInContext(moneySource, context, { filename: 'employee-money.js' });
  const host = document.createElement('main');
  document.body.append(host);
  const mounted = context.EGCMoney.mount(host, { identity: 'ZacB', role: 'owner', capabilities: ['crew', 'business', 'owner'], hubFetch, toast: message => toasts.push(String(message)), go() {}, screen: 'invoicing' });
  const root = () => host.querySelector('.egc-invoicing');
  const buttons = () => root().querySelectorAll('button');
  const button = label => { const found = buttons().filter(node => node.textContent === label).at(-1); assert.ok(found, `no ${label} button in: ${buttons().map(node => node.textContent).join(' | ')}`); return found; };
  const pick = id => { const box = root().querySelector(`#mn-pick-${id}`); assert.ok(box, `no row for ${id}`); box.checked = true; box.dispatchEvent({ type: 'change', target: box }); };
  return { context, document, host, calls, toasts, session, state, mounted, root, button, pick, text: () => root().textContent, module: context.EGCMoney };
}
async function settle(done, label) {
  for (let i = 0; i < 4000; i++) { if (done()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail(`timed out waiting for ${label}`);
}
// Selects the jobs, confirms the issue and waits for the triggers' toast.
async function issue(tab, ids) {
  await tab.mounted;
  for (const id of ids) tab.pick(id);
  tab.button(ids.length > 1 ? `Issue ${ids.length} invoices` : 'Issue invoice').click();
  const toasts = tab.toasts.length;
  tab.button(ids.length > 1 ? `Issue ${ids.length} invoices` : 'Issue invoice').click();
  await settle(() => tab.toasts.length > toasts && tab.module.canLeave(), 'the issue toast');
}

// Issues the jobs from a tab whose answer is lost, and returns `copies` copies of
// its saved, unconfirmed batch, as tabs duplicated meanwhile hold it.
async function lostIssue(fs, hooks, ids, { copies = 1, skew = 0 } = {}) {
  const tab = invoicingTab(fs, hooks, { lose: 1, skew }), label = ids.length > 1 ? `Issue ${ids.length} invoices` : 'Issue invoice';
  await tab.mounted;
  for (const id of ids) tab.pick(id);
  tab.button(label).click(); tab.button(label).click();
  await settle(() => /Invoices were not issued/.test(tab.text()) && tab.module.canLeave(), 'the lost answer');
  return Array.from({ length: copies }, () => storage(Object.fromEntries(tab.session.values)));
}
// A duplicated tab retrying the saved batch, once its toast is shown.
async function replayTab(fs, hooks, session, options = {}) {
  const tab = invoicingTab(fs, hooks, { session, ...options });
  await tab.mounted;
  const before = tab.toasts.length;
  tab.button('Retry original batch').click();
  await settle(() => tab.toasts.length > before && tab.module.canLeave(), 'the replay');
  return tab;
}
// A later money save on the job (a recorded check): the batch's own request for it is superseded.
const pay = (fs, id, at) => mutateMoney(fs.store, OWNER, { action: 'payment.record_offline', requestId: randomUUID(), jobId: id, expectedRevision: fs.job(id).revision, amountCents: 10000, method: 'check', reference: `Synthetic check ${at.slice(11, 16)}` }, at);
// The money dialog's trigger after its own save, as employee-money-actions.js starts it: the saved job's moneyUpdatedAt is the marker.
async function dialogTrigger(hooks, id) {
  const job = await hooks.read(id), marker = `invoice:${job.moneyUpdatedAt}`;
  assert.equal(await hooks.claim(id, 'invoice-issued', marker), null, 'the dialog claims its own trigger');
  return hooks.sync(job, 'invoice-issued', marker);
}
// One job's result row (named by its customer, or by its ID when the list no longer has the job).
const resultRow = (tab, id) => { const found = tab.root().querySelectorAll('li.mn-result').filter(row => [id, `Synthetic ${id}`].includes(row.querySelector('.mn-name').textContent)); assert.equal(found.length, 1, `one result row for ${id}`); return found[0].textContent; };
const log = (fs, id) => (fs.job(id).communicationLog || []).map(entry => [entry.id, entry.status]);

// HighLevel: record every provider call the /api/highlevel handler makes.
function highlevelProvider(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = new URL(String(url));
    calls.push({ host: target.hostname, path: target.pathname, method: options.method || 'GET', body: options.body ?? null, key: options.headers?.['Idempotency-Key'] ?? null });
    if (target.hostname !== 'services.leadconnectorhq.com') return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(target.pathname.endsWith('/notes') ? { note: { id: 'note-1' } } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
const exact = request => [request.url, JSON.stringify(request.init)].join('\n');
const lifecycle = requests => requests.filter(request => request.url === '/api/highlevel');
const noMessages = calls => calls.filter(call => /\/conversations(\/messages)?/.test(call.path));
const trail = (fs, id) => JSON.stringify(['communicationLog', 'communicationLastEvent', 'communicationLastStatus', 'communicationLastAt', 'automationMilestones', 'lifecycleSync', 'lifecycleSyncPayload', 'lifecycleSyncError', 'lifecycleSyncNextRetryAt'].map(key => fs.job(id)[key] ?? null));

// The standard finance save's invoice for one job, at the same instant: its /api/highlevel request and HighLevel calls.
async function legacyInvoice(ghl, id) {
  const fs = firestore({ [id]: JOBS[id] }), page = suitePage(fs, { dueDate: DUE, customerReference: '' });
  await page.window.opsFinanceAction(id, 'invoice');
  return { fs, page, ghl: ghl.splice(0) };
}

test('issuing one invoice from the Invoicing screen makes exactly the standard finance save\'s egc-invoice-issued request and sends nothing', async t => {
  const ghl = highlevelProvider(t), id = 'job-alpha01';
  const legacy = await legacyInvoice(ghl, id);
  assert.equal(legacy.page.requests.length, 1, 'the standard invoice save makes one lifecycle request');
  const fs = firestore(JOBS), page = suitePage(fs), tab = invoicingTab(fs, page.window.EGCCustomerCommunication);
  await issue(tab, [id]);
  const server = ghl.splice(0);
  assert.deepEqual(lifecycle(page.requests).map(exact), legacy.page.requests.map(exact), 'byte-for-byte the same /api/highlevel request');
  assert.equal(page.requests.length, 1, 'one request, and nothing else from the suite');
  const payload = JSON.parse(page.requests[0].init.body);
  assert.deepEqual([payload.tool, payload.event, payload.job_id, payload.suppress_automation, payload.idempotency_key], ['lifecycle', 'invoice-issued', id, false, `communication:${id}:invoice-issued:invoice:${AT}`]);
  assert.equal(fs.job(id).moneyUpdatedAt, AT, 'the marker is the issue\'s own save time, as the standard save uses its own');
  assert.deepEqual(JSON.parse(JSON.stringify(server)), JSON.parse(JSON.stringify(legacy.ghl)), 'HighLevel sees the same calls');
  assert.deepEqual(server.filter(call => call.path === `/contacts/contact-${id}/tags`).map(call => JSON.parse(call.body).tags), [['egc-invoice-issued']], 'exactly the egc-invoice-issued tag');
  assert.deepEqual([noMessages(server), noMessages(legacy.ghl)], [[], []], 'no HighLevel conversation message from the Hub');
  assert.equal(trail(fs, id), trail(legacy.fs, id), 'the same communication log and retry marker on the job');
  assert.equal(fs.job(id).communicationLastStatus, 'triggered');
  assert.deepEqual(tab.calls.map(call => `${call.method} ${call.url}`), ['GET /api/invoice-batch', 'POST /api/invoice-batch', 'GET /api/invoice-batch'], 'no /api/messages call');
  assert.equal(tab.toasts.at(-1), '1 invoice issued · HighLevel invoice automation started');
  assert.match(tab.text(), /HighLevel invoice automation started/);
  assert.equal(fs.job(id).invoice.status, 'issued');
});

test('a batch starts one egc-invoice-issued trigger per invoice, each the standard save\'s own, and a job with notifications off is suppressed as there', async t => {
  const ghl = highlevelProvider(t), ids = Object.keys(JOBS), legacy = {};
  for (const id of ids) legacy[id] = await legacyInvoice(ghl, id);
  const fs = firestore(JOBS), page = suitePage(fs), tab = invoicingTab(fs, page.window.EGCCustomerCommunication);
  await issue(tab, ids);
  const server = ghl.splice(0);
  assert.deepEqual(lifecycle(page.requests).map(exact), ids.map(id => exact(legacy[id].page.requests[0])), 'one request per invoice, in order, each byte-for-byte the standard save\'s');
  assert.equal(page.requests.length, ids.length);
  assert.deepEqual(page.requests.map(request => JSON.parse(request.init.body).suppress_automation), [false, false, true]);
  assert.deepEqual(JSON.parse(JSON.stringify(server)), JSON.parse(JSON.stringify(ids.flatMap(id => legacy[id].ghl))), 'HighLevel sees the same calls as three standard saves');
  assert.deepEqual(server.filter(call => call.path.endsWith('/tags')).map(call => [call.path, JSON.parse(call.body).tags]), [['/contacts/contact-job-alpha01/tags', ['egc-invoice-issued']], ['/contacts/contact-job-beta002/tags', ['egc-invoice-issued']]], 'notify off adds no tag');
  assert.deepEqual(noMessages(server), [], 'no HighLevel conversation message from the Hub');
  for (const id of ids) assert.equal(trail(fs, id), trail(legacy[id].fs, id), id);
  assert.deepEqual(tab.calls.filter(call => call.method === 'POST').length, 1, 'one batch request, no /api/messages call');
  assert.equal(tab.toasts.at(-1), '3 invoices issued · HighLevel invoice automation started for 2 · 1 with notifications off');
});

test('a lost answer and a duplicated tab replaying the same batch start each trigger once', async t => {
  const ghl = highlevelProvider(t), ids = ['job-alpha01', 'job-beta002'];
  const fs = firestore(JOBS), page = suitePage(fs), first = invoicingTab(fs, page.window.EGCCustomerCommunication, { lose: 1 });
  await first.mounted;
  for (const id of ids) first.pick(id);
  first.button('Issue 2 invoices').click(); first.button('Issue 2 invoices').click();
  await settle(() => /Invoices were not issued/.test(first.text()) && first.module.canLeave(), 'the lost answer');
  assert.deepEqual([page.requests.length, ids.map(id => fs.job(id).invoice?.status)], [0, ['issued', 'issued']], 'the server issued both, and no trigger starts before the screen sees them');
  // The tab was duplicated while the batch was unconfirmed: both hold the same pending request.
  const copy = storage(Object.fromEntries(first.session.values));
  const toasts = first.toasts.length;
  first.button('Retry original batch').click();
  await settle(() => first.toasts.length > toasts && first.module.canLeave(), 'the retried batch');
  assert.equal(lifecycle(page.requests).length, 2, 'one trigger per invoice');
  const second = invoicingTab(fs, page.window.EGCCustomerCommunication, { session: copy });
  await second.mounted;
  const more = second.toasts.length;
  second.button('Retry original batch').click();
  await settle(() => second.toasts.length > more && second.module.canLeave(), 'the duplicate replay');
  assert.equal(lifecycle(page.requests).length, 2, 'the replay found both triggers in the job logs and started none again');
  assert.equal(second.toasts.at(-1), '2 invoices issued · HighLevel invoice automation started');
  assert.deepEqual(new Set(page.requests.map(request => JSON.parse(request.init.body).idempotency_key)).size, 2);
  assert.deepEqual(ghl.filter(call => call.path.endsWith('/tags')).length, 2);
  assert.deepEqual(noMessages(ghl), []);
});

test('an invoice voided elsewhere and issued again on the same screen starts its own egc-invoice-issued trigger', async t => {
  const ghl = highlevelProvider(t), id = 'job-alpha01';
  t.after(() => { clock.now = Date.parse(AT); });
  const fs = firestore(JOBS), page = suitePage(fs), tab = invoicingTab(fs, page.window.EGCCustomerCommunication);
  await issue(tab, [id]);
  assert.equal(lifecycle(page.requests).length, 1);
  // Another tab's money dialog, another manager or MCP voids it through the same money service.
  clock.now = Date.parse('2026-09-22T18:06:00.000Z');
  await mutateMoney(fs.store, OWNER, { action: 'invoice.void', requestId: randomUUID(), jobId: id, expectedRevision: fs.job(id).revision, reason: 'Wrong due date' }, new Date(clock.now).toISOString());
  const REISSUED = '2026-09-22T18:07:00.000Z';
  clock.now = Date.parse(REISSUED);
  await tab.module.refresh();
  await issue(tab, [id]);
  assert.deepEqual([fs.job(id).invoice.status, fs.job(id).moneyUpdatedAt], ['issued', REISSUED]);
  const keys = lifecycle(page.requests).map(request => JSON.parse(request.init.body).idempotency_key);
  assert.deepEqual(keys, [`communication:${id}:invoice-issued:invoice:${AT}`, `communication:${id}:invoice-issued:invoice:${REISSUED}`], 'one trigger per issued invoice, each with its own save time');
  assert.deepEqual(fs.job(id).communicationLog.filter(entry => entry.event === 'invoice-issued').map(entry => [entry.id, entry.status]), keys.map(key => [key, 'triggered']));
  assert.deepEqual(ghl.filter(call => call.path === `/contacts/contact-${id}/tags`).map(call => JSON.parse(call.body).tags), [['egc-invoice-issued'], ['egc-invoice-issued']]);
  assert.deepEqual(noMessages(ghl), []);
  assert.equal(tab.toasts.at(-1), '1 invoice issued · HighLevel invoice automation started');
  assert.match(tab.text(), /HighLevel invoice automation started/);
});

test('a replay the server reports as changed since finds the trigger in the job log and flags nothing', async t => {
  const ghl = highlevelProvider(t), ids = ['job-alpha01', 'job-beta002'];
  const fs = firestore(JOBS), page = suitePage(fs), first = invoicingTab(fs, page.window.EGCCustomerCommunication, { lose: 1 });
  await first.mounted;
  for (const id of ids) first.pick(id);
  first.button('Issue 2 invoices').click(); first.button('Issue 2 invoices').click();
  await settle(() => /Invoices were not issued/.test(first.text()) && first.module.canLeave(), 'the lost answer');
  // The tab was duplicated while the batch was unconfirmed; the first copy retries and starts both triggers.
  const copy = storage(Object.fromEntries(first.session.values));
  const toasts = first.toasts.length;
  first.button('Retry original batch').click();
  await settle(() => first.toasts.length > toasts && first.module.canLeave(), 'the retried batch');
  assert.equal(lifecycle(page.requests).length, 2);
  // A check is then recorded on job-alpha01, so the batch's request for it is superseded.
  await mutateMoney(fs.store, OWNER, { action: 'payment.record_offline', requestId: randomUUID(), jobId: 'job-alpha01', expectedRevision: fs.job('job-alpha01').revision, amountCents: 10000, method: 'check', reference: 'Synthetic check 101' }, AT);
  const logged = JSON.stringify(fs.job('job-alpha01').communicationLog);
  const second = invoicingTab(fs, page.window.EGCCustomerCommunication, { session: copy });
  await second.mounted;
  const more = second.toasts.length;
  second.button('Retry original batch').click();
  await settle(() => second.toasts.length > more && second.module.canLeave(), 'the duplicate replay');
  assert.equal(lifecycle(page.requests).length, 2, 'no trigger starts again');
  assert.equal(JSON.stringify(fs.job('job-alpha01').communicationLog), logged, 'no needs_attention flag for an invoice whose trigger already ran');
  assert.deepEqual([fs.job('job-alpha01').communicationLog.map(entry => entry.status), fs.job('job-alpha01').communicationLastStatus], [['triggered'], 'triggered']);
  assert.equal(second.toasts.at(-1), '2 invoices issued · HighLevel invoice automation started', 'nothing asks for a second, manual egc-invoice-issued tag');
  assert.match(second.text(), /Invoice issued earlier; the job has changed since\. Refresh to review it\.HighLevel invoice automation started/);
  assert.equal(ghl.filter(call => call.path.endsWith('/tags')).length, 2);
});

test('a changed-since replay whose trigger is not in the job log is reported, never flagged or started', async t => {
  const ghl = highlevelProvider(t), id = 'job-alpha01';
  // The issue's answer is lost and this tab is closed; the batch is replayed only after a later payment.
  const fs = firestore(JOBS), page = suitePage(fs), first = invoicingTab(fs, page.window.EGCCustomerCommunication, { lose: 1 });
  await first.mounted;
  first.pick(id);
  first.button('Issue invoice').click(); first.button('Issue invoice').click();
  await settle(() => /Invoices were not issued/.test(first.text()) && first.module.canLeave(), 'the lost answer');
  const copy = storage(Object.fromEntries(first.session.values));
  await mutateMoney(fs.store, OWNER, { action: 'payment.record_offline', requestId: randomUUID(), jobId: id, expectedRevision: fs.job(id).revision, amountCents: 10000, method: 'check', reference: 'Synthetic check 102' }, AT);
  const second = invoicingTab(fs, page.window.EGCCustomerCommunication, { session: copy });
  await second.mounted;
  const more = second.toasts.length;
  second.button('Retry original batch').click();
  await settle(() => second.toasts.length > more && second.module.canLeave(), 'the replay');
  assert.deepEqual([page.requests.length, ghl.length, fs.job(id).communicationLog ?? null], [0, 0, null], 'nothing is started or flagged for a job that has changed since');
  assert.equal(second.toasts.at(-1), '1 invoice issued · 1 needs Trigger in HighLevel');
  assert.match(second.text(), /HighLevel not triggered · use Trigger in HighLevel/);
});

test('without the suite helper nothing is triggered, and the rows say to use Trigger in HighLevel', async t => {
  const ghl = highlevelProvider(t), fs = firestore(JOBS), tab = invoicingTab(fs, undefined);
  await issue(tab, ['job-alpha01']);
  assert.deepEqual([ghl.length, fs.job('job-alpha01').invoice.status], [0, 'issued']);
  assert.match(tab.text(), /HighLevel not triggered · use Trigger in HighLevel/);
  assert.equal(tab.toasts.at(-1), '1 invoice issued · 1 needs Trigger in HighLevel');
});

test('a claim another tab left pending past the claim window counts as not triggered on a changed-since replay; a live one is another tab\'s', async t => {
  const ghl = highlevelProvider(t), ids = ['job-alpha01', 'job-beta002'];
  t.after(() => { clock.now = Date.parse(AT); });
  const fs = firestore(JOBS), page = suitePage(fs), hooks = page.window.EGCCustomerCommunication;
  const [copy] = await lostIssue(fs, hooks, ids);
  // A tab claims job-alpha01's trigger and closes before starting it: its claim stays pending.
  assert.equal(await hooks.claim('job-alpha01', 'invoice-issued', `invoice:${AT}`), null);
  // An hour later, another tab is starting job-beta002's trigger right now.
  clock.now = Date.parse(later(58));
  assert.equal(await hooks.claim('job-beta002', 'invoice-issued', `invoice:${AT}`), null);
  clock.now = Date.parse(later(60));
  for (const id of ids) await pay(fs, id, later(60));
  const tab = await replayTab(fs, hooks, copy);
  assert.deepEqual([page.requests.length, ghl.length], [0, 0], 'a replay starts no trigger');
  for (const id of ids) assert.deepEqual(log(fs, id), [[`communication:${id}:invoice-issued:invoice:${AT}`, 'pending']], `${id}: a replay flags nothing`);
  assert.equal(tab.toasts.at(-1), '2 invoices issued · HighLevel invoice automation started for 1 · 1 needs Trigger in HighLevel');
  assert.match(resultRow(tab, 'job-alpha01'), /HighLevel not triggered · use Trigger in HighLevel/, 'the abandoned claim (1 hour old) never started');
  assert.match(resultRow(tab, 'job-beta002'), /HighLevel automation already started in another tab/, 'a claim inside the 5-minute window is left to its tab');
});

test('a changed-since replay finds the trigger the money dialog started when it updated the invoice, timed by the server save in its key', async t => {
  const ghl = highlevelProvider(t), id = 'job-alpha01';
  t.after(() => { clock.now = Date.parse(AT); });
  const fs = firestore(JOBS), page = suitePage(fs);
  const [copy] = await lostIssue(fs, page.window.EGCCustomerCommunication, [id]);
  // Ten minutes later the money dialog updates the issued invoice (a new due date): issuedAt stays the batch's.
  const DIALOG = later(10);
  await mutateMoney(fs.store, OWNER, { action: 'invoice.issue', requestId: randomUUID(), jobId: id, expectedRevision: fs.job(id).revision, dueDate: '2026-10-02' }, DIALOG);
  assert.deepEqual([fs.job(id).invoice.issuedAt, fs.job(id).moneyUpdatedAt, fs.job(id).invoice.dueDate], [AT, DIALOG, '2026-10-02']);
  // Its trigger runs in a browser whose clock is 12 minutes slow, so its attemptedAt is before the issue.
  clock.now = Date.parse(DIALOG);
  const dialog = suitePage(fs, null, { skew: -12 * MINUTE });
  assert.equal(await dialogTrigger(dialog.window.EGCCustomerCommunication, id), true);
  const entry = fs.job(id).communicationLog.at(-1);
  assert.deepEqual([entry.id, entry.status, entry.attemptedAt < AT], [`communication:${id}:invoice-issued:invoice:${DIALOG}`, 'triggered', true]);
  const logged = JSON.stringify(fs.job(id).communicationLog);
  clock.now = Date.parse(later(15));
  const tab = await replayTab(fs, page.window.EGCCustomerCommunication, copy);
  assert.deepEqual([page.requests.length, dialog.requests.length], [0, 1], 'the replay starts no second trigger');
  assert.equal(JSON.stringify(fs.job(id).communicationLog), logged, 'and flags nothing');
  assert.equal(tab.toasts.at(-1), '1 invoice issued · HighLevel invoice automation started');
  assert.match(resultRow(tab, id), /Refresh to review it\.HighLevel invoice automation started/);
  assert.deepEqual(ghl.filter(call => call.path.endsWith('/tags')).map(call => JSON.parse(call.body).tags), [['egc-invoice-issued']]);
});

test('a changed-since replay counts a manual Trigger in HighLevel pressed after the issue, never one pressed before it', async t => {
  const ghl = highlevelProvider(t), id = 'job-alpha01';
  t.after(() => { clock.now = Date.parse(AT); });
  const fs = firestore(JOBS);
  // An hour before the issue, a manager pressed Trigger in HighLevel for the job's earlier invoice.
  clock.now = Date.parse(later(-60));
  const earlier = suitePage(fs, {});
  await earlier.window.opsTriggerCommunication(id, 'invoice-issued');
  assert.deepEqual(log(fs, id), [[`communication:${id}:invoice-issued:manual`, 'triggered']]);
  clock.now = Date.parse(AT);
  const page = suitePage(fs), hooks = page.window.EGCCustomerCommunication;
  const [before, after] = await lostIssue(fs, hooks, [id], { copies: 2 });
  await pay(fs, id, later(1));
  clock.now = Date.parse(later(2));
  const first = await replayTab(fs, hooks, before);
  assert.equal(first.toasts.at(-1), '1 invoice issued · 1 needs Trigger in HighLevel', 'a manual trigger from before the issue does not count');
  assert.match(resultRow(first, id), /HighLevel not triggered · use Trigger in HighLevel/);
  // Then a manager presses Trigger in HighLevel for this invoice.
  clock.now = Date.parse(later(5));
  const manual = suitePage(fs, {});
  await manual.window.opsTriggerCommunication(id, 'invoice-issued');
  assert.equal(manual.toasts.at(-1), 'HighLevel automation triggered');
  clock.now = Date.parse(later(6));
  const second = await replayTab(fs, hooks, after);
  assert.equal(second.toasts.at(-1), '1 invoice issued · HighLevel invoice automation started', 'the manual trigger after the issue counts');
  assert.match(resultRow(second, id), /HighLevel invoice automation started/);
  assert.deepEqual([page.requests.length, earlier.requests.length, manual.requests.length], [0, 1, 1], 'the replays start nothing');
  assert.deepEqual(log(fs, id), [[`communication:${id}:invoice-issued:manual`, 'triggered']], 'and flag nothing');
  assert.equal(ghl.filter(call => call.path.endsWith('/tags')).length, 2);
});

test('an earlier invoice\'s trigger never counts for a reissued one, even from a browser whose clock runs fast', async t => {
  const ghl = highlevelProvider(t), id = 'job-alpha01', skew = 5 * MINUTE;
  t.after(() => { clock.now = Date.parse(AT); });
  const fs = firestore(JOBS), page = suitePage(fs, null, { skew }), hooks = page.window.EGCCustomerCommunication;
  await issue(invoicingTab(fs, hooks, { skew }), [id]);
  const first = fs.job(id).communicationLog[0];
  assert.deepEqual([first.id, first.status, first.attemptedAt], [`communication:${id}:invoice-issued:invoice:${AT}`, 'triggered', later(5)], 'its attemptedAt is the fast browser clock');
  clock.now = Date.parse(later(1));
  await mutateMoney(fs.store, OWNER, { action: 'invoice.void', requestId: randomUUID(), jobId: id, expectedRevision: fs.job(id).revision, reason: 'Wrong due date' }, later(1));
  // Reissued a minute later (within the skew), with the answer lost; then a check is recorded.
  clock.now = Date.parse(later(2));
  const [copy] = await lostIssue(fs, hooks, [id], { skew });
  assert.equal(fs.job(id).invoice.issuedAt, later(2));
  await pay(fs, id, later(3));
  clock.now = Date.parse(later(4));
  const tab = await replayTab(fs, hooks, copy, { skew });
  assert.equal(tab.toasts.at(-1), '1 invoice issued · 1 needs Trigger in HighLevel', 'the voided invoice\'s trigger (server time 18:05) is not the reissue\'s (18:07)');
  assert.match(resultRow(tab, id), /HighLevel not triggered · use Trigger in HighLevel/);
  assert.deepEqual([page.requests.length, log(fs, id)], [1, [[first.id, 'triggered']]], 'one trigger, for the first invoice; the replay flags nothing');
  assert.equal(ghl.filter(call => call.path.endsWith('/tags')).length, 1);
});

test('a new invoice whose read-back finds a later money save is flagged in the job log, since no trigger can have run for it', async t => {
  const ghl = highlevelProvider(t), id = 'job-alpha01';
  const fs = firestore(JOBS), page = suitePage(fs);
  // A check is recorded on the job between the batch's invoice save and its read-back.
  let raced = false;
  const store = { ...fs.store, async commit(writes) {
    await fs.store.commit(writes);
    if (!raced && writes.some(write => write.collection === 'jobs' && write.id === id && write.patch.invoice?.status === 'issued')) { raced = true; await pay(fs, id, AT); }
  } };
  const tab = invoicingTab(fs, page.window.EGCCustomerCommunication, { store });
  await issue(tab, [id]);
  assert.equal(raced, true);
  const [, receipt] = [...fs.docs].find(([key, row]) => key.startsWith('moneyOperations/') && row.action === 'invoice.issue' && row.jobId === id);
  assert.deepEqual([page.requests.length, ghl.length], [0, 0], 'nothing is started for it');
  assert.deepEqual(log(fs, id), [[`communication:${id}:invoice-issued:money:${receipt.requestId}`, 'needs_attention']], 'it needs attention in Customer messages');
  assert.equal(fs.job(id).communicationLastStatus, 'needs_attention');
  assert.equal(tab.toasts.at(-1), '1 invoice issued · 1 needs Trigger in HighLevel');
  assert.match(resultRow(tab, id), /Invoice issued; the job has changed since\. Refresh to review it\.Not confirmed · flagged in Customer messages/);
});
