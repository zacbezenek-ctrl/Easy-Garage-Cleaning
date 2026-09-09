import test from 'node:test';
import assert from 'node:assert/strict';
import * as accounts from '../functions/api/employee-accounts.js';
import * as auth from '../functions/api/hub-auth.js';
import * as hub from '../functions/api/employee-hub.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';

const origin = 'https://easygaragecleaning.com';
const accountType = 'employee_account_v1';
const hubType = 'employee_hub_v2';
const password = 'SyntheticRoster904!';
const key = username => username.trim().toLowerCase();
const request = (path, body, cookie) => new Request(origin + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function setup(t) {
  const documents = new Map(), queries = [], writes = [];
  const queryFailures = new Map();
  let revision = 0;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'firestore.googleapis.com', 'the test must never contact another service');
    if (url.pathname.endsWith('/documents:runQuery')) {
      const query = JSON.parse(init.body).structuredQuery;
      assert.equal(query.where.fieldFilter.field.fieldPath, 'recordType');
      const type = query.where.fieldFilter.value.stringValue;
      queries.push(type);
      if (queryFailures.has(type)) return Response.json({ error: 'Synthetic storage failure' }, { status: queryFailures.get(type) });
      return Response.json([...documents].filter(([, document]) => document.fields.recordType.stringValue === type)
        .map(([id, document]) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...document } })));
    }
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (init.method === 'PATCH') {
      if (url.searchParams.get('currentDocument.exists') === 'false' && documents.has(id)) return Response.json({}, { status: 412 });
      const expected = url.searchParams.get('currentDocument.updateTime');
      if (expected && documents.get(id)?.updateTime !== expected) return Response.json({}, { status: 412 });
      writes.push(id);
      documents.set(id, { ...JSON.parse(init.body), updateTime: `2026-09-09T00:00:00.${String(++revision).padStart(9, '0')}Z` });
    }
    return documents.has(id)
      ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...documents.get(id) })
      : Response.json({}, { status: 404 });
  });
  const env = {
    HUB_SESSION_SECRET: 'synthetic-roster-session-secret',
    EMPLOYEE_HUB_DATA_SECRET: 'synthetic-roster-vault-secret',
    FIREBASE_API_KEY: 'firebase-test-approved-roster',
    HUB_AUTH_USERS_JSON: JSON.stringify({
      ZacB: { passwordHash: 'unused-synthetic-owner-hash', role: 'owner', displayName: 'Test Owner' },
      AlexK: { passwordHash: 'unused-synthetic-manager-hash', role: 'manager', displayName: 'Test Manager' },
    }),
  };
  const owner = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const manager = (await createHubSessionCookie(env, 'AlexK')).split(';')[0];
  const register = async username => {
    const response = await accounts.onRequestPost({ env, request: request('/api/employee-accounts', {
      action: 'register', acknowledged: true, username, firstName: 'New', lastName: 'Crew',
      email: 'private-application@example.invalid', phone: '9705550199', password,
    }) });
    assert.equal(response.status, 201, await response.text());
  };
  const review = async (username, decision = 'approved') => {
    const response = await accounts.onRequestPost({ env, request: request('/api/employee-accounts', { action: 'review', username, decision }, owner) });
    assert.equal(response.status, 200, await response.text());
  };
  const login = async username => {
    const response = await auth.onRequestPost({ env, request: request('/api/hub-auth', { username, password }) });
    assert.equal(response.status, 200, await response.text());
    return response.headers.get('set-cookie').split(';')[0];
  };
  const write = async (username, data, cookie = owner) => {
    const response = await hub.onRequestPost({ env, request: request('/api/employee-hub', { collection: 'profiles', id: key(username), data }, cookie) });
    assert.equal(response.status, 200);
    return (await response.json()).record;
  };
  const get = (cookie = owner) => hub.onRequestGet({ env, request: request('/api/employee-hub', undefined, cookie) });
  const roster = async (cookie = owner) => {
    const response = await get(cookie);
    assert.equal(response.status, 200);
    return (await response.json()).collections.profiles;
  };
  const profileDocuments = () => [...documents.values()].filter(document => document.fields.recordType.stringValue === hubType && document.fields.employeeHubType.stringValue === 'profiles');
  return { env, documents, queries, writes, queryFailures, owner, manager, register, review, login, write, get, roster, profileDocuments };
}

test('owner approval immediately adds a crew member to owner and manager rosters without creating a profile or leaking application details', async t => {
  const store = await setup(t);
  await store.register(' New.Crew_1 ');
  assert.equal((await store.roster()).some(profile => key(profile.username) === 'new.crew_1'), false);
  await store.review(' NEW.CREW_1 ');
  const snapshot = JSON.stringify([...store.documents]);
  const writes = store.writes.length;
  for (const cookie of [store.owner, store.manager]) {
    const profiles = await store.roster(cookie);
    const employee = profiles.find(profile => key(profile.username) === 'new.crew_1');
    assert.deepEqual(employee, {
      id: 'new.crew_1', username: 'New.Crew_1', displayName: 'New Crew', role: 'crew',
      payType: 'hourly', hourlyRate: 0, status: 'active', accountStatus: 'approved', awaitingFirstSignIn: true,
    });
    assert.doesNotMatch(JSON.stringify(profiles), /passwordHash|passwordSalt|sessionVersion|sealedPayload|sealedIv|private-application|9705550199|SyntheticRoster904/);
  }
  assert.equal(store.profileDocuments().length, 0, 'roster visibility must not write a synthetic employee profile');
  assert.equal(store.writes.length, writes);
  assert.equal(JSON.stringify([...store.documents]), snapshot);
  assert.ok(store.queries.includes(accountType));
  assert.ok(store.queries.includes(hubType));
});

test('a manager can set pay before first login and employee initialization preserves it without duplicate profiles', async t => {
  const store = await setup(t);
  await store.register('New.Crew_1');
  await store.review('New.Crew_1');
  const initial = (await store.roster(store.manager)).find(profile => profile.username === 'New.Crew_1');
  assert.ok(initial, 'approval must supply an editable roster record before the employee signs in');
  await store.write('New.Crew_1', { ...initial, displayName: 'Crew display', preferredName: 'Crew nickname', hourlyRate: 27.5 }, store.manager);
  let profile = (await store.roster()).find(profile => profile.username === 'New.Crew_1');
  assert.equal(profile.awaitingFirstSignIn, true, 'manager editing must not imply the employee has signed in');
  assert.equal(profile.hourlyRate, 27.5);
  const cookie = await store.login(' NEW.CREW_1 ');
  await store.write('New.Crew_1', { username: 'New.Crew_1', displayName: 'New Crew', role: 'crew', payType: 'hourly', hourlyRate: 0, status: 'active', lastSeenAt: new Date().toISOString() }, cookie);
  const profiles = (await store.roster()).filter(row => key(row.username) === 'new.crew_1');
  assert.equal(profiles.length, 1);
  profile = profiles[0];
  assert.equal(profile.hourlyRate, 27.5);
  assert.equal(profile.preferredName, 'Crew nickname');
  assert.equal(profile.awaitingFirstSignIn, false);
  assert.ok(profile.lastSeenAt);
  assert.equal(store.profileDocuments().length, 1);
});

test('punctuated approved usernames remain distinct when virtual and saved profiles are merged', async t => {
  const store = await setup(t);
  const usernames = ['Crew.One', 'Crew-One', 'Crew_One', 'CrewOne'];
  for (const username of usernames) {
    await store.register(username);
    await store.review(username);
  }
  await store.write('Crew.One', { username: 'Crew.One', preferredName: 'Dot only', hourlyRate: 31 });
  const profiles = (await store.roster()).filter(profile => usernames.includes(profile.username));
  assert.equal(profiles.length, 4);
  assert.deepEqual(profiles.map(profile => profile.id).sort(), usernames.map(key).sort());
  assert.equal(profiles.find(profile => profile.username === 'Crew.One').hourlyRate, 31);
  for (const profile of profiles.filter(profile => profile.username !== 'Crew.One')) {
    assert.equal(profile.hourlyRate, 0);
    assert.equal(profile.preferredName, undefined);
  }
});

test('merging account approval retains existing onboarding, emergency contact, pay, and readiness fields', async t => {
  const store = await setup(t);
  await store.register('Known.Crew');
  await store.review('Known.Crew');
  const saved = {
    username: 'Known.Crew', displayName: 'Existing display', preferredName: 'Existing preference', hourlyRate: 29,
    phone: '9705550100', emergencyContactName: 'Saved emergency', emergencyContactPhone: '9705550101',
    onboardingCompletedAt: '2026-09-08T18:00:00Z', onboardingVersion: '2026-09-location-v2',
    onboardingAcknowledgements: ['timekeeping', 'location_policy', 'safety', 'customer_care', 'hub_basics'],
    locationVerifiedAt: '2026-09-08T17:00:00Z', shadowShiftCompletedAt: '2026-09-08T19:00:00Z', readyForSoloAt: '2026-09-08T20:00:00Z',
  };
  await store.write('Known.Crew', saved);
  const profiles = (await store.roster()).filter(profile => profile.username === 'Known.Crew');
  assert.equal(profiles.length, 1);
  for (const [field, value] of Object.entries(saved)) assert.deepEqual(profiles[0][field], value, field);
  assert.equal(profiles[0].accountStatus, 'approved');
  assert.equal(profiles[0].awaitingFirstSignIn, false, 'an existing completion is sufficient even without lastSeenAt');
});

test('pending and rejected applications stay off the roster while an existing rejected employee is retained as inactive', async t => {
  const store = await setup(t);
  for (const username of ['Pending.Crew', 'Rejected.Crew', 'Former.Crew']) await store.register(username);
  await store.review('Rejected.Crew', 'rejected');
  await store.review('Former.Crew');
  await store.write('Former.Crew', { username: 'Former.Crew', displayName: 'Former teammate', status: 'active', hourlyRate: 22, lastSeenAt: '2026-09-08T12:00:00Z' });
  await store.review('Former.Crew', 'rejected');
  const profiles = await store.roster();
  assert.equal(profiles.some(profile => ['Pending.Crew', 'Rejected.Crew'].includes(profile.username)), false);
  const former = profiles.find(profile => profile.username === 'Former.Crew');
  assert.ok(former, 'historical employee profile must remain available');
  assert.equal(former.status, 'inactive');
  assert.equal(former.accountStatus, 'rejected');
  assert.equal(former.awaitingFirstSignIn, false);
  assert.equal(former.hourlyRate, 22);
});

test('crew requests remain limited to their own stored profiles and do not query the account roster', async t => {
  const store = await setup(t);
  for (const username of ['Own.Crew', 'Other.Crew']) {
    await store.register(username);
    await store.review(username);
  }
  await store.write('Other.Crew', { username: 'Other.Crew', emergencyContactName: 'Other private contact', hourlyRate: 35 });
  const cookie = await store.login('Own.Crew');
  const queryCount = store.queries.length;
  assert.deepEqual(await store.roster(cookie), []);
  await store.write('Own.Crew', { username: 'Own.Crew' }, cookie);
  const profiles = await store.roster(cookie);
  assert.deepEqual(profiles.map(profile => profile.username), ['Own.Crew']);
  assert.doesNotMatch(JSON.stringify(profiles), /Other.Crew|Other private contact|passwordHash|passwordSalt/);
  assert.equal(store.queries.slice(queryCount).includes(accountType), false, 'crew reads must not start a whole-account query');
});

test('corrupt application data causes a visible manager roster failure without changing saved records', async t => {
  const store = await setup(t);
  await store.register('Corrupt.Crew');
  await store.review('Corrupt.Crew');
  const account = [...store.documents.values()].find(document => document.fields.recordType.stringValue === accountType);
  account.fields.sealedPayload.stringValue = 'synthetic-corrupted-ciphertext';
  const snapshot = JSON.stringify([...store.documents]);
  const response = await store.get(store.manager);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.collections, undefined);
  assert.ok(body.error);
  assert.equal(JSON.stringify([...store.documents]), snapshot);
});

test('unavailable account storage is a roster error rather than a successful incomplete team', async t => {
  const store = await setup(t);
  store.queryFailures.set(accountType, 503);
  const response = await store.get();
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.collections, undefined);
  assert.ok(body.error);
  assert.equal(store.writes.length, 0);
});
