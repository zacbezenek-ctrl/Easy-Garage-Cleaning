// PORTAL-INBOX: client portal messages reach the office as a Hub alert committed with the message. HighLevel still
// gets the internal note after the customer has the answer, and nothing else: no task, no customer send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomerPortalSessionCookie } from '../functions/_lib/customer-portal.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import {
  ALERT_LIST_LIMIT, CUSTOMER_MESSAGE_ALERTS, customerMessageAlertId, customerMessageAlertStorage, markCustomerMessageHandled, newCustomerMessageAlert,
} from '../functions/_lib/customer-message-alerts.js';
import { createCustomerPortalHandlers } from '../functions/api/customer-portal.js';
import { customerMessageHandlers } from '../functions/api/customer-messages.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const T0 = '2026-10-21T15:00:00.000Z';
const minutes = (at, n) => new Date(Date.parse(at) + n * 60000).toISOString();
const ENV = { HUB_SESSION_SECRET: 'portal-inbox-synthetic-session-secret-0123456789', FIREBASE_API_KEY: 'firebase-test-portal-inbox', HIGHLEVEL_API_KEY: 'ghl-test', HIGHLEVEL_LOCATION_ID: 'location-1' };
const BUSINESS = { user: 'tylerg', displayName: 'Tyler G', role: 'manager', businessAccess: true };
const CREW = { user: 'crewpat', displayName: 'Pat Crew', role: 'crew', businessAccess: false };

// A Firestore REST fake (documents, :commit with preconditions, :runQuery on status) plus a programmable HighLevel.
function harness(t, { job = {}, highLevel } = {}) {
  const docs = new Map(), calls = { commits: [], highLevel: [], queries: [] };
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
      // Equality filter, one orderBy (a document without the field is left out, as Firestore does) and a limit.
      const query = JSON.parse(init.body).structuredQuery, collection = query.from[0].collectionId, filter = query.where.fieldFilter, order = query.orderBy?.[0];
      const field = (data, path) => path.split('.').reduce((value, key) => value?.[key], data);
      const matched = [...docs].filter(([key, entry]) => key.startsWith(collection + '/') && field(entry.data, filter.field.fieldPath) === filter.value.stringValue && (!order || field(entry.data, order.field.fieldPath) !== undefined));
      if (order) matched.sort(([, a], [, b]) => String(field(a.data, order.field.fieldPath)).localeCompare(String(field(b.data, order.field.fieldPath))) * (order.direction === 'DESCENDING' ? -1 : 1));
      calls.queries.push(query);
      const rows = matched.slice(0, query.limit || Infinity).map(([key, entry]) => ({ document: doc(key, entry), readTime: T0 }));
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

// HighLevel answers the internal note and nothing else: any other call is a write this feature must not make.
const healthy = () => call => {
  if (call.method === 'POST' && call.url.endsWith('/conversations/messages')) return Response.json({ messageId: 'note-1', conversationId: 'conversation-1' });
  throw new Error(`unexpected HighLevel call ${call.method} ${call.url}`);
};
const onlyNotes = h => assert.deepEqual([...new Set(h.calls.highLevel.map(call => `${call.method} ${call.url}`))], h.calls.highLevel.length ? ['POST /conversations/messages'] : []);
const down = () => { throw new TypeError('fetch failed'); };

async function portalSend(env, { now = T0, requestId = 'portal-request-0001', body = 'The side door code is 4521.', defer = true, deps = {} } = {}) {
  const cookie = (await createCustomerPortalSessionCookie(env, 'job-1', { linkVersion: 0 })).split(';')[0];
  const background = [];
  const handlers = createCustomerPortalHandlers({ now: () => new Date(now), ...deps });
  const response = await handlers.onRequestPost({
    request: new Request('https://easygaragecleaning.com/api/customer-portal', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send_message', body, request_id: requestId }) }),
    env, ...(defer ? { waitUntil: promise => background.push(promise) } : {}),
  });
  return { response, data: await response.json(), settle: () => Promise.all(background) };
}

test('a portal message commits its office alert with the message and answers before HighLevel hears of it', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { highLevel: async (call, all) => { await gate; return healthy()(call, all); } });
  const sent = await portalSend(ENV);
  assert.equal(sent.response.status, 200, 'the customer has the answer while HighLevel has not replied');
  assert.equal(sent.data.message.officeAlert, 'queued');
  const saves = h.calls.commits.filter(writes => writes.some(write => write.update.name.includes('/jobs/')));
  assert.equal(saves.length, 1, 'one commit holds the message and its alert');
  assert.deepEqual(saves[0].map(write => write.update.name.split('/documents/')[1].split('/')[0]), ['jobs', CUSTOMER_MESSAGE_ALERTS]);
  assert.deepEqual(saves[0][1].currentDocument, { exists: false }, 'the alert is created once');
  assert.equal(h.calls.commits.filter(writes => writes.some(write => write.update.name.includes('/rate_limits/'))).length, 1, 'the send counts against the job limit');
  const [alert] = h.alerts();
  assert.equal(alert.id, await customerMessageAlertId('job-1', 'customer-portal-request-0001'));
  assert.equal(alert.status, 'open');
  assert.equal(alert.body, 'The side door code is 4521.');
  assert.equal(alert.customerName, 'Dana Customer');
  assert.equal(Object.hasOwn(alert, 'task'), false, 'no HighLevel task is owed');
  assert.equal(h.data('jobs/job-1').customerConversation[0].officeAlert, 'queued');
  release();
  await sent.settle();
  const note = h.calls.highLevel.find(call => call.url.endsWith('/conversations/messages'));
  assert.equal(note.body.type, 'InternalComment', 'the internal note is kept');
  onlyNotes(h);
  assert.equal(h.data('jobs/job-1').customerConversation[0].delivery.status, 'sent', 'the note outcome is still recorded');
});

test('a replayed portal request adds no second alert and no second note', async t => {
  const h = harness(t, { highLevel: healthy() });
  await (await portalSend(ENV)).settle();
  const replay = await portalSend(ENV);
  await replay.settle();
  assert.equal(replay.data.duplicate, true);
  assert.equal(h.calls.commits.filter(writes => writes.some(write => write.update.name.includes('/jobs/'))).length, 1);
  assert.equal(h.alerts().length, 1);
  assert.equal(h.calls.highLevel.length, 1);
});

test('HighLevel down never fails the send, and the Hub list shows the message without it', async t => {
  const h = harness(t, { highLevel: down });
  const sent = await portalSend(ENV);
  await sent.settle();
  assert.deepEqual([sent.response.status, sent.data.ok], [200, true]);
  assert.equal(h.alerts()[0].status, 'open', 'the Hub alert does not depend on HighLevel');
  assert.equal(h.data('jobs/job-1').customerConversation[0].delivery.status, 'received');
  const response = await customerMessageHandlers({ session: async () => BUSINESS, now: () => new Date(minutes(T0, 2)) }).get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV });
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual(listed.messages.map(row => row.body), ['The side door code is 4521.']);
  assert.equal(Object.hasOwn(listed.messages[0], 'highlevelContactId'), false, 'the list carries no CRM ids');
  assert.equal(Object.hasOwn(listed.messages[0], 'highLevelTask'), false);
  assert.equal(h.calls.highLevel.length, 1, 'the Hub list makes no HighLevel call');
});

test('a job without a HighLevel contact still reaches the Hub, with no HighLevel call', async t => {
  const h = harness(t, { job: { highlevelContactId: '' }, highLevel: () => { throw new Error('HighLevel must not be called'); } });
  await (await portalSend(ENV)).settle();
  assert.equal(h.calls.highLevel.length, 0);
  assert.equal(h.alerts()[0].status, 'open', 'the Hub alert still shows it');
});

// An in-memory store with the storage contract (read, open, write with a revision guard).
function memoryStore(rows = []) {
  const docs = new Map(rows.map((row, index) => [row.id, { ...row, revision: `r${index}` }]));
  let n = 100;
  return {
    docs,
    async read(id) { const row = docs.get(id); return row ? structuredClone(row) : null; },
    async open() { const list = [...docs.values()].filter(row => row.status === 'open').map(row => structuredClone(row)).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)); return { rows: list, complete: true }; },
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

test('the Hub list is for people who may contact customers; Mark handled is same-origin and idempotent', async () => {
  const row = await entry();
  const store = memoryStore([row]);
  const handlers = profile => customerMessageHandlers({ session: async () => profile, storage: () => store, now: () => new Date(minutes(T0, 5)) });
  const get = profile => handlers(profile).get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV });
  const post = (profile, body, origin = 'https://easygaragecleaning.com') => handlers(profile).post({ request: new Request('https://easygaragecleaning.com/api/customer-messages', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: ENV });
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(CREW)).status, 403, 'crew never see customer messages');
  assert.equal((await post(CREW, { action: 'mark_handled', id: row.id, seenCount: 1 })).status, 403);
  // Sales holds customer.send with staff-role permissions on.
  const sales = { user: 'samsales', displayName: 'Sam', role: 'sales', staffRoles: ['sales'] };
  const salesHandlers = customerMessageHandlers({ session: async () => sales, storage: () => store });
  assert.equal((await salesHandlers.get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: { ...ENV, EGC_STAFF_ROLE_PERMISSIONS: 'true' } })).status, 200);
  assert.equal((await salesHandlers.get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV })).status, 403, 'without staff-role permissions only business users');

  const listed = await (await get(BUSINESS)).json();
  assert.deepEqual(listed.messages.map(message => [message.id, message.jobId, message.customerName, message.status]), [[row.id, 'job-1', 'Dana', 'open']]);
  assert.equal((await post(BUSINESS, { action: 'mark_handled', id: row.id, seenCount: 1 }, 'https://evil.example')).status, 403);
  assert.equal((await post(BUSINESS, { action: 'mark_handled', id: 'not-an-id' })).status, 400);
  assert.equal((await post(BUSINESS, { action: 'mark_handled', id: row.id })).status, 400, 'the count the person saw is required');
  const done = await (await post(BUSINESS, { action: 'mark_handled', id: row.id, seenCount: 1 })).json();
  assert.equal(done.message.status, 'handled');
  assert.equal(store.docs.get(row.id).handledBy, 'Tyler G');
  assert.equal(store.docs.get(row.id).handledAt, minutes(T0, 5));
  assert.equal((await (await post(BUSINESS, { action: 'mark_handled', id: row.id, seenCount: 1 })).json()).alreadyHandled, true);
  assert.deepEqual((await (await get(BUSINESS)).json()).messages, [], 'handled messages leave the list and the badge');
  assert.equal((await markCustomerMessageHandled(store, { action: 'mark_handled', id: row.id, seenCount: 1 }, BUSINESS, T0)).alreadyHandled, true);
});

test('later messages join the job\'s open entry: one Hub row until it is handled', async t => {
  const h = harness(t, { highLevel: healthy() });
  await (await portalSend(ENV, { requestId: 'portal-request-0001', body: 'Hi' })).settle();
  await (await portalSend(ENV, { requestId: 'portal-request-0002', body: 'The code is 1234', now: minutes(T0, 1) })).settle();
  await (await portalSend(ENV, { requestId: 'portal-request-0003', body: 'Thanks!', now: minutes(T0, 2) })).settle();
  let alerts = h.alerts();
  assert.equal(alerts.length, 1, 'one entry for the job');
  assert.deepEqual([alerts[0].messageCount, alerts[0].messages.map(row => row.body), alerts[0].body, alerts[0].lastMessageAt, alerts[0].createdAt], [3, ['Hi', 'The code is 1234', 'Thanks!'], 'Thanks!', minutes(T0, 2), T0]);
  assert.equal(h.data('jobs/job-1').customerMessageAlertId, alerts[0].id);
  assert.equal(h.data('jobs/job-1').customerConversation.length, 3, 'every message is still in the thread');

  // Handled: the next message opens a fresh entry.
  const store = customerMessageAlertStorage(ENV);
  await markCustomerMessageHandled(store, { action: 'mark_handled', id: alerts[0].id, seenCount: 3 }, BUSINESS, minutes(T0, 3));
  await (await portalSend(ENV, { requestId: 'portal-request-0004', body: 'One more thing', now: minutes(T0, 4) })).settle();
  alerts = h.alerts();
  const open = alerts.filter(row => row.status === 'open');
  assert.equal(alerts.length, 2);
  assert.deepEqual([open.length, open[0].messageCount, open[0].body], [1, 1, 'One more thing']);
  assert.equal(h.data('jobs/job-1').customerMessageAlertId, open[0].id);
  onlyNotes(h);
});

test('Mark handled never clears a message the office has not seen: a later message refuses it with 409 until the list is re-read', async t => {
  const h = harness(t, { highLevel: healthy() });
  const hub = customerMessageHandlers({ session: async () => BUSINESS, now: () => new Date(minutes(T0, 5)) });
  const list = async () => (await (await hub.get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV, waitUntil: () => {} })).json()).messages;
  const markHandled = async (id, seenCount) => hub.post({ request: new Request('https://easygaragecleaning.com/api/customer-messages', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mark_handled', id, seenCount }) }), env: ENV });
  await (await portalSend(ENV, { requestId: 'portal-request-0001', body: 'Can you come Tuesday?' })).settle();
  const [shown] = await list();
  assert.equal(shown.messageCount, 1, 'the office sees one message');
  await (await portalSend(ENV, { requestId: 'portal-request-0002', body: 'Actually please cancel, my dog is sick', now: minutes(T0, 1) })).settle();
  const refused = await markHandled(shown.id, shown.messageCount);
  assert.equal(refused.status, 409);
  assert.deepEqual([(await refused.json()).code], ['customer_messages_changed']);
  let [still] = await list();
  assert.deepEqual([still.id, still.status, still.messageCount, still.body], [shown.id, 'open', 2, 'Actually please cancel, my dog is sick'], 'the entry stays open with the new message');
  assert.equal((await markHandled(still.id, still.messageCount)).status, 200, 'once read, it can be marked handled');
  assert.deepEqual(await list(), []);
});

test('an append that lands between Mark handled\'s read and its write is caught on the re-read', async () => {
  const row = await entry();
  const store = memoryStore([row]), write = store.write;
  let raced = false;
  store.write = async (id, patch, revision) => {
    // The customer's next message joins the entry just before the handled write.
    if (!raced && patch.status === 'handled') { raced = true; await write(id, { messageCount: 2, body: 'One more thing', lastMessageAt: minutes(T0, 1) }, ''); }
    return write(id, patch, revision);
  };
  await assert.rejects(markCustomerMessageHandled(store, { action: 'mark_handled', id: row.id, seenCount: 1 }, BUSINESS, minutes(T0, 2)), error => error.code === 'customer_messages_changed' && error.status === 409);
  assert.deepEqual([store.docs.get(row.id).status, store.docs.get(row.id).messageCount], ['open', 2]);
  // Another write changes the revision, not the count: the click still succeeds.
  await write(row.id, { updatedAt: minutes(T0, 2) }, '');
  assert.equal((await markCustomerMessageHandled(store, { action: 'mark_handled', id: row.id, seenCount: 2 }, BUSINESS, minutes(T0, 3))).message.status, 'handled');
});

test('a Mark handled between the read and the commit is re-read: the message never lands on a handled entry', async t => {
  const h = harness(t, { highLevel: healthy() });
  await (await portalSend(ENV, { requestId: 'portal-request-0001', body: 'Hi' })).settle();
  const [first] = h.alerts(), real = customerMessageAlertStorage(ENV);
  let reads = 0;
  // The first read sees the entry open; it is then handled before the commit, so the guarded append fails.
  const racing = env => ({ ...real, read: async id => { const row = await real.read(id); if (reads++ === 0) await markCustomerMessageHandled(real, { action: 'mark_handled', id, seenCount: 1 }, BUSINESS, minutes(T0, 1)); return row; } });
  const sent = await portalSend(ENV, { requestId: 'portal-request-0002', body: 'Still there?', now: minutes(T0, 2), deps: { alerts: racing } });
  await sent.settle();
  assert.equal(sent.response.status, 200);
  const alerts = h.alerts(), handled = alerts.find(row => row.id === first.id), open = alerts.filter(row => row.status === 'open');
  assert.deepEqual([handled.status, handled.messageCount], ['handled', 1], 'the handled entry was not changed');
  assert.deepEqual([open.length, open[0].body], [1, 'Still there?'], 'the message opened a new entry');
  assert.equal(h.data('jobs/job-1').customerConversation.length, 2);
});

test('a job may send 10 portal messages in 10 minutes; the 11th is refused kindly and a replay is not counted', async t => {
  const h = harness(t, { highLevel: healthy() });
  for (let n = 1; n <= 10; n += 1) {
    const sent = await portalSend(ENV, { requestId: `portal-request-${String(n).padStart(4, '0')}`, body: `Message ${n}`, now: minutes(T0, n / 2) });
    await sent.settle();
    assert.equal(sent.response.status, 200, `message ${n}`);
  }
  const replay = await portalSend(ENV, { requestId: 'portal-request-0003', body: 'Message 3', now: minutes(T0, 6) });
  assert.deepEqual([replay.response.status, replay.data.duplicate], [200, true], 'a retry of a saved message is answered, not limited');
  const refused = await portalSend(ENV, { requestId: 'portal-request-0011', body: 'Message 11', now: minutes(T0, 6) });
  assert.equal(refused.response.status, 429);
  assert.equal(refused.data.code, 'CUSTOMER_PORTAL_MESSAGE_RATE_LIMITED');
  assert.match(refused.data.error, /the team has them/);
  assert.equal(h.data('jobs/job-1').customerConversation.length, 10, 'nothing was saved');
  assert.equal(h.alerts()[0].messageCount, 10);
  // The window rolls: ten minutes after the first send there is room again.
  const later = await portalSend(ENV, { requestId: 'portal-request-0012', body: 'Message 12', now: minutes(T0, 10.75) });
  await later.settle();
  assert.equal(later.response.status, 200);
});

test('more than 100 open entries: the list is the newest 100 by latest message', async t => {
  const h = harness(t, { highLevel: healthy() });
  const put = async index => {
    const id = await customerMessageAlertId(`job-${index}`, `customer-${index}`);
    const alert = newCustomerMessageAlert({ customer: `Customer ${index}`, highlevelContactId: `contact-${index}` }, `job-${index}`, { id: `customer-${index}`, body: `Message ${index}`, createdAt: minutes(T0, -index), authorName: `Customer ${index}` }, minutes(T0, -index));
    h.docs.set(`${CUSTOMER_MESSAGE_ALERTS}/${id}`, { data: alert, updateTime: `2026-10-21T14:00:00.${String(index).padStart(6, '0')}Z` });
    return id;
  };
  for (let index = 0; index < 120; index += 1) await put(index);
  const response = await customerMessageHandlers({ session: async () => BUSINESS, now: () => new Date(T0) }).get({ request: new Request('https://easygaragecleaning.com/api/customer-messages'), env: ENV });
  const listed = await response.json();
  assert.equal(listed.messages.length, ALERT_LIST_LIMIT);
  assert.equal(listed.complete, false);
  assert.deepEqual(listed.messages.slice(0, 3).map(row => row.customerName), ['Customer 0', 'Customer 1', 'Customer 2'], 'newest first');
  assert.equal(listed.messages.at(-1).customerName, 'Customer 99');
  assert.equal(h.calls.queries.length, 1);
  const [list] = h.calls.queries;
  assert.deepEqual([list.where.fieldFilter.field.fieldPath, list.orderBy[0].field.fieldPath, list.orderBy[0].direction, list.limit], ['status', 'lastMessageAt', 'DESCENDING', ALERT_LIST_LIMIT + 1]);
  assert.equal(h.calls.highLevel.length, 0);
  // The query has its composite index.
  const indexes = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8')).indexes.filter(index => index.collectionGroup === CUSTOMER_MESSAGE_ALERTS).map(index => index.fields.map(field => `${field.fieldPath}:${field.order}`).join(','));
  assert.deepEqual(indexes, ['status:ASCENDING,lastMessageAt:DESCENDING']);
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
  // The Hub list is the only office alert: the feature adds no HighLevel write of its own.
  for (const file of ['functions/_lib/customer-message-alerts.js', 'functions/api/customer-messages.js']) assert.doesNotMatch(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), /leadconnectorhq|\/tasks\b/, file);
});
