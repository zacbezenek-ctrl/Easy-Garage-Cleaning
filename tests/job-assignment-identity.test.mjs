import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createEmployeeApplication, reviewEmployeeApplication } from '../functions/_lib/employee-accounts.js';
import { createJobAssignmentAccess, jobCrewNames } from '../functions/_lib/job-assignment.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import * as crew from '../functions/api/crew-jobs.js';
import * as payment from '../functions/api/job-payment.js';
import * as hub from '../functions/api/employee-hub.js';
import * as hook from '../functions/api/crew-hook.js';
import * as quo from '../functions/api/quo-send.js';
import * as highlevel from '../functions/api/highlevel.js';

const variants = ['John.Smith', 'John_Smith', 'John-Smith', 'JohnSmith', 'JohnSmith2'];
const users = Object.fromEntries(['ZacB', ...variants].map(user => [user, { passwordHash: 'synthetic', displayName: user, role: user === 'ZacB' ? 'owner' : 'crew' }]));
const env = {
  HUB_SESSION_SECRET: 'assignment-session-synthetic', EMPLOYEE_HUB_DATA_SECRET: 'assignment-vault-synthetic',
  HUB_AUTH_USERS_JSON: JSON.stringify(users), FIREBASE_API_KEY: 'firebase-test-assignment',
  STRIPE_SECRET_KEY: 'sk_test_synthetic', HIGHLEVEL_API_KEY: 'synthetic', HIGHLEVEL_LOCATION_ID: 'synthetic',
  QUO_API_KEY: 'synthetic', CREW_WEBHOOK_URL: 'https://synthetic.invalid/hook',
};
const cookies = new Map(await Promise.all(['ZacB', ...variants].map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const request = (route, user, data) => new Request(`https://easygaragecleaning.com/api/${route}`, {
  method: data ? 'POST' : 'GET', headers: { Cookie: cookies.get(user), Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' },
  ...(data ? { body: JSON.stringify(data) } : {}),
});

function storage(t) {
  const documents = new Map();
  const calls = { writes: 0, upstream: 0, accountQueries: 0 };
  let revision = 0;
  const document = (id, data) => ({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, fields: encodeFirestoreFields(data), updateTime: `2026-09-07T00:00:00.${String(++revision).padStart(9, '0')}Z` });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname !== 'firestore.googleapis.com') {
      calls.upstream++;
      if (url.hostname === 'api.stripe.com') return Response.json({ id: 'cs_test_synthetic', url: 'https://checkout.stripe.com/c/pay/synthetic' });
      return Response.json({ id: 'synthetic', messageId: 'synthetic' });
    }
    if (url.pathname.endsWith('/documents:runQuery')) {
      const query = JSON.parse(options.body).structuredQuery;
      const filter = query.where?.fieldFilter;
      if (filter?.value?.stringValue === 'employee_account_v1') calls.accountQueries++;
      const rows = [...documents.values()].filter(row => !filter || row.fields?.[filter.field.fieldPath]?.stringValue === filter.value.stringValue).map(document => ({ document }));
      return Response.json(rows.length ? rows : [{ readTime: '2026-09-07T00:00:00Z' }]);
    }
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (method === 'PATCH') {
      const existing = documents.get(id);
      if (url.searchParams.get('currentDocument.exists') === 'false' && existing) return Response.json({}, { status: 412 });
      const expected = url.searchParams.get('currentDocument.updateTime');
      if (expected && expected !== existing?.updateTime) return Response.json({}, { status: 412 });
      const incoming = decodeFirestoreFields(JSON.parse(options.body).fields);
      documents.set(id, document(id, { ...decodeFirestoreFields(existing?.fields || {}), ...incoming }));
      calls.writes++;
    }
    return documents.has(id) ? Response.json(documents.get(id)) : Response.json({}, { status: 404 });
  });
  return { documents, calls, put: (id, data) => documents.set(id, document(id, data)), get: id => decodeFirestoreFields(documents.get(id)?.fields || {}) };
}

test('assignment identities retain punctuation and suffixes, and explicit crew overrides stale text', async () => {
  for (const user of variants) {
    const access = createJobAssignmentAccess({}, { user, displayName: user });
    for (const name of variants) {
      assert.equal(await access.assigned({ assignedCrew: [name] }), user === name, `${user} / ${name}`);
      assert.equal(await access.assigned({ assignedTo: `Someone Else + ${name}` }), user === name);
    }
    assert.equal(await access.matches(` ${user.toUpperCase()} `), true);
    assert.equal(await access.matches(''), false);
    assert.equal(await access.matches({ username: 'Outsider', name: user }), false);
    for (const field of ['username', 'user', 'id']) {
      assert.equal(await access.assigned({ assignedCrew: [{ [field]: user, name: 'Different label' }] }), true);
      assert.equal(await access.assigned({ assignedCrew: [{ [field]: 'Outsider', name: user }] }), false);
    }
    assert.equal(await access.assigned({ assignedCrew: [null, 42, { username: {} }, { name: user }] }), true);
    assert.equal(await access.assigned({ assignedCrew: ['Outsider'], assignedTo: user }), false);
  }
  assert.deepEqual(jobCrewNames({ assignedCrew: [...variants, 'john.smith'] }), variants);
});

test('every job mutation route rejects prefix and punctuation neighbors before writes or external calls', async t => {
  const store = storage(t);
  for (const user of variants) {
    for (const assignee of variants.filter(name => name !== user)) {
      store.put('job-1', { type: 'job', assignedCrew: [assignee], total: 100, phone: '9705550100' });
      const requests = [
        [crew, 'crew-jobs', { action: 'send_customer_message', jobId: 'job-1', body: 'Synthetic', requestId: 'synthetic-message' }],
        [payment, 'job-payment', { job_id: 'job-1', amount_cents: 1000, request_id: 'synthetic-payment' }],
        [hub, 'employee-hub', { collection: 'jobMessages', id: 'synthetic-message', data: { jobId: 'job-1', body: 'Synthetic' } }],
        [hook, 'crew-hook', { tool: 'post_job', job_id: 'job-1' }],
        [quo, 'quo-send', { job_id: 'job-1', message: 'Synthetic' }],
        [highlevel, 'highlevel', { tool: 'lifecycle', event: 'arrived', job_id: 'job-1' }],
      ];
      for (const [route, path, data] of requests) assert.equal((await route.onRequestPost({ env, request: request(path, user, data) })).status, 403, `${path}: ${user} cannot operate ${assignee}'s job`);
    }
  }
  assert.equal(store.calls.writes, 0);
  assert.equal(store.calls.upstream, 0);
  assert.equal(store.calls.accountQueries, 0, 'exact username checks need no roster query');
});

test('crew schedule and encrypted job rooms show only the exact employee work', async t => {
  const store = storage(t);
  for (let index = 0; index < variants.length; index++) {
    const user = variants[index], jobId = `job-${index}`;
    store.put(jobId, { type: 'job', assignedCrew: [user], customer: `Private ${user}` });
    store.put(`availability-${index}`, { type: 'availability', employee: user });
    assert.equal((await hub.onRequestPost({ env, request: request('employee-hub', 'ZacB', { collection: 'jobMessages', id: `room-${index}`, data: { jobId, body: `Private ${user}` } }) })).status, 200);
  }
  for (let index = 0; index < variants.length; index++) {
    const user = variants[index];
    const schedule = await (await crew.onRequestGet({ env, request: request('crew-jobs', user) })).json();
    assert.deepEqual(schedule.jobs.map(row => row.id).sort(), [`availability-${index}`, `job-${index}`]);
    const people = await (await hub.onRequestGet({ env, request: request('employee-hub', user) })).json();
    assert.deepEqual(people.collections.jobMessages.map(row => row.jobId), [`job-${index}`]);
    const checkout = await payment.onRequestPost({ env, request: request('job-payment', user, { job_id: `job-${index}`, amount_cents: 1000, request_id: `synthetic-${index}` }) });
    assert.equal(checkout.status, 409, 'the assigned user reaches balance validation');
  }
});

test('legacy display names require a unique approved account and share one roster read per request', async t => {
  const store = storage(t);
  const aliasEnv = { ...env, HUB_AUTH_USERS_JSON: JSON.stringify({ Assigned: { passwordHash: 'synthetic', displayName: 'Unique Crew' } }) };
  const access = createJobAssignmentAccess(aliasEnv, { user: 'Assigned', displayName: 'Unique Crew' });
  assert.equal(await access.assigned({ assignedCrew: ['Unique Crew'] }), true);
  assert.equal(await access.matches('Unique Crew'), true);
  assert.deepEqual(await access.identities(), ['Assigned', 'Unique Crew']);
  assert.equal(await access.matches('Unique'), false);
  assert.equal(store.calls.accountQueries, 1);
  const conflicting = createJobAssignmentAccess({ HUB_AUTH_USERS_JSON: JSON.stringify({ Assigned: { passwordHash: 'synthetic', displayName: 'Unique Crew' }, Other: { passwordHash: 'synthetic', displayName: 'Unique Crew' } }) }, { user: 'Assigned', displayName: 'Unique Crew' });
  assert.equal(await conflicting.matches('Unique Crew'), false);
  assert.equal(await conflicting.matches('Assigned'), true);
  const application = await createEmployeeApplication(aliasEnv, { firstName: 'Unique', lastName: 'Crew', username: 'OtherCrew', email: 'synthetic@example.com', phone: '9705550100', password: 'Synthetic password 904!', confirmPassword: 'Synthetic password 904!' });
  assert.equal(await createJobAssignmentAccess(aliasEnv, { user: 'Assigned', displayName: 'Unique Crew' }).matches('Unique Crew'), true, 'pending signup cannot disable an existing employee alias');
  await reviewEmployeeApplication(aliasEnv, application.username, 'approved', 'ZacB');
  const approvedConflict = createJobAssignmentAccess(aliasEnv, { user: 'Assigned', displayName: 'Unique Crew' });
  assert.equal(await approvedConflict.matches('Unique Crew'), false, 'duplicate approved display names are ambiguous');
  assert.deepEqual(await approvedConflict.identities(), ['Assigned'], 'Firebase must omit the same registered-account alias rejected by server routes');
});

test('new pickup and release records use usernames even for employees sharing a display name', async t => {
  const store = storage(t);
  const claimEnv = { ...env, HUB_AUTH_USERS_JSON: JSON.stringify(Object.fromEntries(variants.map(user => [user, { passwordHash: 'synthetic', displayName: 'John Smith' }]))) };
  store.put('pickup', { id: 'pickup', type: 'job', status: 'scheduled', date: '2026-09-08', time: '10:00', endTime: '11:00', shiftPickupEnabled: true, openShift: true, crewNeeded: 3, assignedCrew: [] });
  for (const user of ['John.Smith', 'John-Smith']) assert.equal((await crew.onRequestPost({ env: claimEnv, request: request('crew-jobs', user, { action: 'claim', jobId: 'pickup' }) })).status, 200);
  assert.deepEqual(store.get('pickup').assignedCrew, ['John.Smith', 'John-Smith']);
  assert.deepEqual(store.get('pickup').shiftClaims.map(row => row.employee), ['John.Smith', 'John-Smith']);
  assert.equal((await crew.onRequestPost({ env: claimEnv, request: request('crew-jobs', 'JohnSmith', { action: 'release', jobId: 'pickup' }) })).status, 403);
  assert.equal((await crew.onRequestPost({ env: claimEnv, request: request('crew-jobs', 'John.Smith', { action: 'release', jobId: 'pickup' }) })).status, 200);
  assert.deepEqual(store.get('pickup').assignedCrew, ['John-Smith']);
  assert.deepEqual(store.get('pickup').shiftClaims.map(row => row.employee), ['John-Smith']);
});

test('pickup conflict checks distinguish similar accounts and preserve exact legacy unavailable time', async t => {
  const store = storage(t);
  const slot = { type: 'job', status: 'scheduled', date: '2026-09-08', time: '10:00', endTime: '11:00', shiftPickupEnabled: true, openShift: true, crewNeeded: 3, assignedCrew: [] };
  store.put('pickup', { ...slot, id: 'pickup' });
  store.put('other-time', { type: 'availability', status: 'active', date: slot.date, time: '09:00', endTime: '12:00', employee: 'John-Smith' });
  assert.equal((await crew.onRequestPost({ env, request: request('crew-jobs', 'John.Smith', { action: 'claim', jobId: 'pickup' }) })).status, 200);
  store.put('pickup', { ...slot, id: 'pickup' });
  store.put('own-time', { type: 'availability', status: 'active', date: slot.date, time: '09:00', endTime: '12:00', employee: 'John.Smith' });
  assert.equal((await crew.onRequestPost({ env, request: request('crew-jobs', 'John.Smith', { action: 'claim', jobId: 'pickup' }) })).status, 409);
  store.documents.delete('own-time');
  const aliasEnv = { ...env, HUB_AUTH_USERS_JSON: JSON.stringify({ ...users, 'John.Smith': { ...users['John.Smith'], displayName: 'Exact Legacy' } }) };
  store.put('own-time', { type: 'availability', status: 'active', date: slot.date, time: '09:00', endTime: '12:00', employee: 'Exact Legacy' });
  assert.equal((await crew.onRequestPost({ env: aliasEnv, request: request('crew-jobs', 'John.Smith', { action: 'claim', jobId: 'pickup' }) })).status, 409);
});

test('unreadable alias roster denies legacy access while canonical assignments remain usable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
  const access = createJobAssignmentAccess(env, { user: 'John.Smith', displayName: 'Exact Legacy' });
  assert.equal(await access.assigned({ assignedCrew: ['Exact Legacy'] }), false);
  assert.equal(await access.assigned({ assignedCrew: ['John.Smith'] }), true);
});

test('personal schedule UI resolves exact legacy display names without merging similar usernames', () => {
  const values = new Map([['egc_u', 'John.Smith'], ['egc_name', 'John Smith'], ['egc_role', 'crew']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const context = { console, URLSearchParams, Date, Intl, Promise, Set, Map, Error, Event,
    sessionStorage: storage, localStorage: storage, navigator: {}, location: { pathname: '/employee', search: '' },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    document: { readyState: 'loading', activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    jobsCache: [...variants, 'John Smith'].map((name, index) => ({ id: `job-${index}`, type: 'job', status: 'scheduled', date: '2099-09-08', assignedCrew: [name] })),
  };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.ui={S,sameEmployee,sameScheduleEmployee,myShiftJobs,crewNames};})();');
  vm.runInNewContext(source, context);
  const ui = context.ui;
  ui.S.people.profiles = variants.map(username => ({ username, displayName: username === 'John.Smith' ? 'John Smith' : username }));
  assert.deepEqual(Array.from(ui.myShiftJobs(), job => job.id), ['job-0', 'job-5']);
  assert.equal(ui.sameEmployee('John.Smith', 'John-Smith'), false);
  assert.equal(ui.sameScheduleEmployee('JohnSmith', 'JohnSmith2'), false);
  ui.S.people.profiles.push({ username: 'OtherCrew', displayName: 'John Smith' });
  assert.deepEqual(Array.from(ui.myShiftJobs(), job => job.id), ['job-0']);
  assert.deepEqual(Array.from(ui.crewNames({ assignedCrew: [{ username: 'John.Smith', name: 'John Smith' }], assignedTo: 'John-Smith' })), ['John.Smith']);
});
