// PORTAL-INBOX: client portal messages reach the office as a Hub alert committed with the message and a HighLevel
// task on the contact, created after the customer has the answer and retried (idempotently) when HighLevel is down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import {
  CUSTOMER_MESSAGE_ALERTS, TASK_PARK_ATTEMPTS, attemptCustomerMessageTask, customerMessageAlertId, customerMessageAlertStorage,
  ensureCustomerMessageTask, markCustomerMessageHandled, newCustomerMessageAlert, retryDueCustomerMessageTasks,
} from '../functions/_lib/customer-message-alerts.js';
import { createCustomerPortalHandlers } from '../functions/api/customer-portal.js';
import { customerMessageHandlers } from '../functions/api/customer-messages.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const T0 = '2026-10-21T15:00:00.000Z';
const minutes = (at, n) => new Date(Date.parse(at) + n * 60000).toISOString();
const ENV = { HUB_SESSION_SECRET: 'portal-inbox-secret', FIREBASE_API_KEY: 'firebase-test-portal-inbox', HIGHLEVEL_API_KEY: 'ghl-test', HIGHLEVEL_LOCATION_ID: 'location-1' };
const BUSINESS = { user: 'tylerg', displayName: 'Tyler G', role: 'manager', businessAccess: true };
const CREW = { user: 'crewpat', displayName: 'Pat Crew', role: 'crew', businessAccess: false };

// A Firestore REST fake (documents, :commit with preconditions, :runQuery on status) plus a programmable HighLevel.
function harness(t, { job = {}, highLevel } = {}) {
  const docs = new Map(), calls = { commits: [], highLevel: [] };
  let clock = 0;
  const stamp = () => `2026-10-21T15:00:${String(++clock).padStart(2, '0')}.000000Z`;
  const put = (path, data) => { const updateTime = stamp(); docs.set(path, { data, updateTime }); return updateTime; };
  put('jobs/job-1', { type: 'job', customer: 'Dana Customer', serviceType: 'Garage cleanout', date: '2026-10-24', highlevelContactId: 'contact-1', customerConversation: [], ...job });
  const doc = (path, entry) => ({ name: `${ROOT}/${path}`, updateTime: entry.updateTime, fields: encodeFirestoreFields(entry.data) });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method || 'GET';
    if (url.host === 'services.leadconnectorhq.com') {
      const call = { url: url.pathname, method, body: init.body ? JSON.parse(init.body) : null };
      calls.highLevel.push(call);
      return highLevel(call, calls.highLevel);
    }
    const path = decodeURIComponent(url.pathname.split('/documents/')[1] || '');
    if (url.pathname.endsWith(':commit')) {
      const { writes } = JSON.parse(init.body);
      for (const write of writes) {
        const key = write.update.name.split('/documents/')[1].split('/').map(decodeURIComponent).join('/'), current = docs.get(key), pre = write.currentDocument || {};
        if (pre.exists === false && current || pre.exists === true && !current || pre.updateTime && current?.updateTime !== pre.updateTime) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: pre.exists === false ? 409 : 400 });
      }
      const results = writes.map(write => {
        const key = write.update.name.split('/documents/')[1].split('/').map(decodeURIComponent).join('/'), patch = decodeFirestoreFields(write.update.fields);
        return { updateTime: put(key, { ...(docs.get(key)?.data || {}), ...patch }) };
      });
      calls.commits.push(writes);
      return Response.json({ writeResults: results, commitTime: results.at(-1).updateTime });
    }
    if (url.pathname.endsWith(':runQuery')) {
      const query = JSON.parse(init.body).structuredQuery, collection = query.from[0].collectionId, wanted = query.where.fieldFilter.value.stringValue;
      const rows = [...docs].filter(([key, entry]) => key.startsWith(collection + '/') && entry.data.status === wanted).map(([key, entry]) => ({ document: doc(key, entry), readTime: T0 }));
      return Response.json(rows.length ? rows : [{ readTime: T0 }]);
    }
    if (method === 'PATCH') {
      const current = docs.get(path), expected = url.searchParams.get('currentDocument.updateTime');
      if (expected && current?.updateTime !== expected) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
      const updateTime = put(path, { ...(current?.data || {}), ...decodeFirestoreFields(JSON.parse(init.body).fields) });
      return Response.json(doc(path, docs.get(path)), { headers: { 'x-update': updateTime } });
    }
    const entry = docs.get(path);
    return entry ? Response.json(doc(path, entry)) : Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });
  return { docs, calls, data: path => docs.get(path)?.data, alerts: () => [...docs].filter(([key]) => key.startsWith(CUSTOMER_MESSAGE_ALERTS + '/')).map(([key, entry]) => ({ id: key.split('/')[1], ...entry.data })) };
}

const healthy = ({ existing = [] } = {}) => (call, all) => {
  if (call.url.endsWith('/conversations/messages')) return Response.json({ messageId: 'note-1', conversationId: 'conversation-1' });
  if (call.url.endsWith('/tasks') && call.method === 'GET') return Response.json({ tasks: [...existing, ...all.filter(item => item.method === 'POST' && item.url.endsWith('/tasks')).map((item, index) => ({ id: `task-${index + 1}`, ...item.body }))] });
  if (call.url.endsWith('/tasks') && call.method === 'POST') return Response.json({ task: { id: `task-${all.filter(item => item.method === 'POST' && item.url.endsWith('/tasks')).length}` } });
  return Response.json({}, { status: 404 });
};
const down = () => { throw new TypeError('fetch failed'); };

async function portalSend(env, { now = T0, requestId = 'portal-request-0001', body = 'The side door code is 4521.', defer = true } = {}) {
  const cookie = (await createCustomerPortalSessionCookie(env, 'job-1', { linkVersion: 0 })).split(';')[0];
  const background = [];
  const handlers = createCustomerPortalHandlers({ now: () => new Date(now) });
  const response = await handlers.onRequestPost({
    request: new Request('https://easygaragecleaning.com/api/customer-portal', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send_message', body, request_id: requestId }) }),
    env, ...(defer ? { waitUntil: promise => background.push(promise) } : {}),
  });
  return { response, data: await response.json(), settle: () => Promise.all(background) };
}

test('a portal message commits its office alert with the message and answers before HighLevel is called', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { highLevel: async (call, all) => { await gate; return healthy()(call, all); } });
  const env = { ...ENV, EGC_CUSTOMER_MESSAGE_TASK_USER_ID: 'office-user-7' };
  const sent = await portalSend(env);
  assert.equal(sent.response.status, 200, 'the customer has the answer while HighLevel has not replied');
  assert.equal(sent.data.message.officeAlert, 'queued');
  assert.equal(h.calls.commits.length, 1, 'one commit holds the message and its alert');
  assert.deepEqual(h.calls.commits[0].map(write => write.update.name.split('/documents/')[1].split('/')[0]), ['jobs', CUSTOMER_MESSAGE_ALERTS]);
  assert.deepEqual(h.calls.commits[0][1].currentDocument, { exists: false }, 'the alert is created once');
  const [alert] = h.alerts();
  assert.equal(alert.id, await customerMessageAlertId('job-1', 'customer-portal-request-0001'));
  assert.equal(alert.status, 'open');
  assert.equal(alert.body, 'The side door code is 4521.');
  assert.equal(alert.customerName, 'Dana Customer');
  assert.equal(alert.task.status, 'pending');
  assert.equal(h.data('jobs/job-1').customerConversation[0].officeAlert, 'queued');
  release();
  await sent.settle();
  const note = h.calls.highLevel.find(call => call.url.endsWith('/conversations/messages'));
  assert.equal(note.body.type, 'InternalComment', 'the internal note is kept');
  const post = h.calls.highLevel.find(call => call.method === 'POST' && call.url.endsWith('/tasks'));
  assert.equal(post.url, '/contacts/contact-1/tasks');
  assert.equal(post.body.assignedTo, 'office-user-7');
  assert.equal(post.body.dueDate, T0, 'due when the customer sent it');
  assert.equal(post.body.completed, false);
  assert.match(post.body.title, /Reply to client portal message: Dana Customer/);
  assert.match(post.body.body, /The side door code is 4521\./);
  assert.match(post.body.body, new RegExp(`Ref: ${alert.id}`));
  assert.deepEqual([h.alerts()[0].task.status, h.alerts()[0].task.taskId], ['created', 'task-1']);
  assert.equal(h.data('jobs/job-1').customerConversation[0].delivery.status, 'sent', 'the note outcome is still recorded');
});

test('a replayed portal request adds no second alert and no second HighLevel task', async t => {
  const h = harness(t, { highLevel: healthy() });
  await (await portalSend(ENV)).settle();
  const replay = await portalSend(ENV);
  await replay.settle();
  assert.equal(replay.data.duplicate, true);
  assert.equal(h.calls.commits.filter(writes => writes.some(write => write.update.name.includes('/jobs/'))).length, 1);
  assert.equal(h.alerts().length, 1);
  assert.equal(h.calls.highLevel.filter(call => call.method === 'POST' && call.url.endsWith('/tasks')).length, 1);
});

test('without an office user the task is created unassigned', async t => {
  const h = harness(t, { highLevel: healthy() });
  await (await portalSend(ENV)).settle();
  const post = h.calls.highLevel.find(call => call.method === 'POST' && call.url.endsWith('/tasks'));
  assert.equal(Object.hasOwn(post.body, 'assignedTo'), false);
});

test('HighLevel down never fails the send; the task is queued and the Hub list retries it once due', async t => {
  let highLevel = down;
  const h = harness(t, { highLevel: (call, all) => highLevel(call, all) });
  const sent = await portalSend(ENV);
  await sent.settle();
  assert.equal(sent.response.status, 200);
  assert.equal(sent.data.ok, true);
  let [alert] = h.alerts();
  assert.equal(alert.status, 'open', 'the Hub alert does not depend on HighLevel');
  assert.deepEqual([alert.task.status, alert.task.attempts, alert.task.nextAttemptAt, alert.task.claimedUntil], ['pending', 1, minutes(T0, 1), '']);
  assert.equal(h.data('jobs/job-1').customerConversation[0].delivery.status, 'received');

  // Not due yet: a Hub read inside the backoff makes no HighLevel call.
  const hub = at => customerMessageHandlers({ session: async () => BUSINESS, now: () => new Date(at) });
  const before = h.calls.highLevel.length;
  const background = [];
  let response = await hub(minutes(T0, 0.5)).get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV, waitUntil: promise => background.push(promise) });
  await Promise.all(background);
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].highLevelTask, 'pending');
  assert.equal(listed.messages[0].body, 'The side door code is 4521.');
  assert.equal(Object.hasOwn(listed.messages[0], 'highlevelContactId'), false, 'the list carries no CRM ids');
  assert.equal(h.calls.highLevel.length, before);

  // HighLevel is back: the next due read creates the task exactly once.
  highLevel = healthy();
  background.length = 0;
  response = await hub(minutes(T0, 2)).get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV, waitUntil: promise => background.push(promise) });
  await Promise.all(background);
  [alert] = h.alerts();
  assert.deepEqual([alert.task.status, alert.task.attempts, alert.task.taskId], ['created', 2, 'task-1']);
  background.length = 0;
  await hub(minutes(T0, 30)).get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV, waitUntil: promise => background.push(promise) });
  await Promise.all(background);
  assert.equal(h.calls.highLevel.filter(call => call.method === 'POST' && call.url.endsWith('/tasks')).length, 1);
});

test('uncertain then retried: the second attempt reads the landed task and writes nothing', async t => {
  let lose = true;
  const tasks = [];
  const h = harness(t, { highLevel: call => {
    if (call.url.endsWith('/conversations/messages')) return Response.json({ messageId: 'note-1' });
    if (call.method === 'GET') return Response.json({ tasks });
    tasks.push({ id: 'task-landed', ...call.body });
    if (lose) { lose = false; return new Response('upstream timeout', { status: 504 }); }
    return Response.json({ task: { id: 'task-second' } });
  } });
  await (await portalSend(ENV)).settle();
  let [alert] = h.alerts();
  assert.deepEqual([alert.task.status, alert.task.httpStatus], ['pending', 504]);
  const result = await attemptCustomerMessageTask(customerMessageAlertStorage(ENV), alert.id, { env: ENV, now: minutes(T0, 1) });
  assert.deepEqual(result, { id: alert.id, outcome: 'created', taskId: 'task-landed' });
  assert.equal(tasks.length, 1, 'HighLevel holds one task');
  [alert] = h.alerts();
  assert.equal(alert.task.taskId, 'task-landed');
});

test('outcomes that are not retried: no contact, HighLevel not configured, a definite rejection', async t => {
  const h = harness(t, { job: { highlevelContactId: '' }, highLevel: () => { throw new Error('HighLevel must not be called'); } });
  await (await portalSend(ENV)).settle();
  assert.equal(h.alerts()[0].task.status, 'needs_contact');
  assert.equal(h.calls.highLevel.length, 0);
  assert.equal(h.alerts()[0].status, 'open', 'the Hub alert still shows it');

  assert.deepEqual(await ensureCustomerMessageTask({}, { id: 'cma_' + '0'.repeat(40), highlevelContactId: 'contact-1' }), { status: 'not_configured' });
  const refused = await ensureCustomerMessageTask(ENV, { id: 'cma_' + '0'.repeat(40), highlevelContactId: 'contact-1', body: 'x' }, { fetcher: async (url, init = {}) => init.method === 'POST' ? new Response('{}', { status: 422 }) : Response.json({ tasks: [] }) });
  assert.deepEqual(refused, { status: 'failed', httpStatus: 422 });
  const limited = await ensureCustomerMessageTask(ENV, { id: 'cma_' + '0'.repeat(40), highlevelContactId: 'contact-1', body: 'x' }, { fetcher: async () => new Response('{}', { status: 429 }) });
  assert.equal(limited.status, 'unavailable', 'rate limited is retried, not failed');
});

// An in-memory store with the storage contract (read, open, write with a revision guard).
function memoryStore(rows = []) {
  const docs = new Map(rows.map((row, index) => [row.id, { ...row, revision: `r${index}` }]));
  let n = 100;
  return {
    docs,
    async read(id) { const row = docs.get(id); return row ? structuredClone(row) : null; },
    async open() { const list = [...docs.values()].filter(row => row.status === 'open').map(row => structuredClone(row)); return { rows: list, complete: true }; },
    async write(id, patch, revision = '') {
      const row = docs.get(id);
      if (!row || revision && row.revision !== revision) return null;
      docs.set(id, { ...row, ...structuredClone(patch), revision: `r${++n}` });
      return docs.get(id).revision;
    },
  };
}
const entry = async (overrides = {}) => {
  const id = await customerMessageAlertId('job-1', overrides.messageId || 'customer-m1');
  return { id, ...newCustomerMessageAlert({ customer: 'Dana', highlevelContactId: 'contact-1' }, 'job-1', { id: overrides.messageId || 'customer-m1', body: 'Hi', createdAt: T0, authorName: 'Dana' }, T0), ...overrides };
};

test('an entry parks after the attempt budget and is then left for a person', async () => {
  const row = await entry();
  const store = memoryStore([row]);
  let at = T0;
  for (let attempt = 1; attempt <= TASK_PARK_ATTEMPTS; attempt += 1) {
    const result = await attemptCustomerMessageTask(store, row.id, { env: ENV, now: at, fetcher: down });
    assert.equal(result.outcome, attempt < TASK_PARK_ATTEMPTS ? 'pending' : 'parked');
    at = store.docs.get(row.id).task.nextAttemptAt || at;
  }
  assert.equal((await attemptCustomerMessageTask(store, row.id, { env: ENV, now: minutes(at, 600), fetcher: () => { throw new Error('not called'); } })).outcome, 'skipped');
  const backoff = [];
  const fresh = memoryStore([await entry()]);
  let now = T0;
  for (let attempt = 0; attempt < 5; attempt += 1) { await attemptCustomerMessageTask(fresh, row.id, { env: ENV, now, fetcher: down }); const next = fresh.docs.get(row.id).task.nextAttemptAt; backoff.push((Date.parse(next) - Date.parse(now)) / 60000); now = next; }
  assert.deepEqual(backoff, [1, 5, 15, 60, 60]);
});

test('a claim held elsewhere or lost to a race makes no HighLevel call', async () => {
  const claimed = await entry({ task: { status: 'pending', attempts: 1, nextAttemptAt: T0, claimedUntil: minutes(T0, 1) } });
  const store = memoryStore([claimed]);
  const never = () => { throw new Error('HighLevel must not be called'); };
  assert.equal((await attemptCustomerMessageTask(store, claimed.id, { env: ENV, now: T0, fetcher: never })).outcome, 'skipped');
  const raced = memoryStore([await entry()]), id = [...raced.docs.keys()][0], realRead = raced.read;
  raced.read = async key => ({ ...(await realRead(key)), revision: 'stale' });
  assert.equal((await attemptCustomerMessageTask(raced, id, { env: ENV, now: T0, fetcher: never })).outcome, 'claimed_elsewhere');
  // An expired claim (the Worker died mid-attempt) is picked up again.
  const fetchCreated = async (url, init = {}) => init.method === 'POST' ? Response.json({ task: { id: 'task-9' } }) : Response.json({ tasks: [] });
  assert.equal((await attemptCustomerMessageTask(store, claimed.id, { env: ENV, now: minutes(T0, 3), fetcher: fetchCreated })).outcome, 'created');
});

test('handled before HighLevel heard of it: no task is written; retries take the oldest due first', async () => {
  const handled = await entry({ status: 'handled' });
  const store = memoryStore([handled]);
  assert.equal((await attemptCustomerMessageTask(store, handled.id, { env: ENV, now: T0, fetcher: () => { throw new Error('not called'); } })).outcome, 'not_needed');
  assert.equal(store.docs.get(handled.id).task.status, 'not_needed');

  const rows = await Promise.all(['a', 'b', 'c', 'd'].map(async (key, index) => entry({ messageId: `customer-${key}`, createdAt: minutes(T0, -index) })));
  const many = memoryStore(rows), seen = [];
  const results = await retryDueCustomerMessageTasks(many, rows, { env: ENV, now: T0, fetcher: async (url, init = {}) => { if (init.method === 'POST') seen.push(JSON.parse(init.body).body.match(/Ref: (cma_\w+)/)[1]); return init.method === 'POST' ? Response.json({ task: { id: `t${seen.length}` } }) : Response.json({ tasks: [] }); } });
  assert.equal(results.length, 3, 'one Hub read retries at most three');
  assert.deepEqual(seen, [rows[3].id, rows[2].id, rows[1].id]);
});

test('the Hub list is for people who may contact customers; Mark handled is same-origin and idempotent', async () => {
  const row = await entry();
  const store = memoryStore([row]);
  const fetchNone = async (url, init = {}) => init.method === 'POST' ? Response.json({ task: { id: 'task-api' } }) : Response.json({ tasks: [] });
  const handlers = profile => customerMessageHandlers({ session: async () => profile, storage: () => store, now: () => new Date(minutes(T0, 5)), fetcher: fetchNone });
  const get = profile => handlers(profile).get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV });
  const post = (profile, body, origin = 'https://easygaragecleaning.com') => handlers(profile).post({ request: new Request('https://easygaragecleaning.com/api/customer-messages', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: ENV });
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(CREW)).status, 403, 'crew never see customer messages');
  assert.equal((await post(CREW, { action: 'mark_handled', id: row.id })).status, 403);
  // Sales holds customer.send with staff-role permissions on.
  const sales = { user: 'samsales', displayName: 'Sam', role: 'sales', staffRoles: ['sales'] };
  const salesHandlers = customerMessageHandlers({ session: async () => sales, storage: () => store, fetcher: fetchNone });
  assert.equal((await salesHandlers.get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: { ...ENV, EGC_STAFF_ROLE_PERMISSIONS: 'true' } })).status, 200);
  assert.equal((await salesHandlers.get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV })).status, 403, 'without staff-role permissions only business users');

  const listed = await (await get(BUSINESS)).json();
  assert.deepEqual(listed.messages.map(message => [message.id, message.jobId, message.customerName, message.status]), [[row.id, 'job-1', 'Dana', 'open']]);
  assert.equal((await post(BUSINESS, { action: 'mark_handled', id: row.id }, 'https://evil.example')).status, 403);
  assert.equal((await post(BUSINESS, { action: 'mark_handled', id: 'not-an-id' })).status, 400);
  const done = await (await post(BUSINESS, { action: 'mark_handled', id: row.id })).json();
  assert.equal(done.message.status, 'handled');
  assert.equal(store.docs.get(row.id).handledBy, 'Tyler G');
  assert.equal(store.docs.get(row.id).handledAt, minutes(T0, 5));
  assert.equal((await (await post(BUSINESS, { action: 'mark_handled', id: row.id })).json()).alreadyHandled, true);
  assert.deepEqual((await (await get(BUSINESS)).json()).messages, [], 'handled messages leave the list and the badge');
  assert.equal((await markCustomerMessageHandled(store, { action: 'mark_handled', id: row.id }, BUSINESS, T0)).alreadyHandled, true);
});

test('the portal shows a truthful "Sent to the team" and the Hub registers the screen and widget', () => {
  const portal = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
  assert.match(portal, /item\.officeAlert==='queued'\?'Sent to the team'/);
  const registry = readFileSync(new URL('../employee-hub-screens.js', import.meta.url), 'utf8');
  assert.match(registry, /\{id:'customer_messages',group:'CLIENT WORK',label:'Customer messages'[^\n]*capability:'customer_contact'[^\n]*module:'EGCCustomerMessages'\}/);
  assert.match(registry, /\{id:'customer_messages',label:'Customer messages',homes:\['today','my_day'\],capability:'customer_contact',module:'EGCCustomerMessagesHome'/);
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
  assert.match(suite, /\.\.\.\(staffAccessCan\('customer\.send'\)\?\['customer_contact'\]:\[\]\)\]/, 'the capability follows the server list');
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/customerMessageAlerts\/\{documentId\} \{\s*allow read, write: if false;/);
  const inventory = readFileSync(new URL('../docs/env-inventory.md', import.meta.url), 'utf8');
  assert.match(inventory, /`EGC_CUSTOMER_MESSAGE_TASK_USER_ID`/);
});
