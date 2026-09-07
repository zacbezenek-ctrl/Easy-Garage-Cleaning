import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubCredentialHash, createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { onRequestGet, onRequestPost } from '../functions/api/employee-hub.js';

const endpoint = 'https://easygaragecleaning.com/api/employee-hub';
const names = ['ZacB', 'John.Smith', 'John_Smith', 'John-Smith', 'JohnSmith', 'JohnSmith2'];
const hash = await createHubCredentialHash('Synthetic test password 904!');
const env = {
  HUB_SESSION_SECRET: 'employee-identity-session-key', EMPLOYEE_HUB_DATA_SECRET: 'employee-identity-vault-key',
  FIREBASE_API_KEY: 'firebase-test-employee-identity',
  HUB_AUTH_USERS_JSON: JSON.stringify(Object.fromEntries(names.map(user => [user, { passwordHash: hash, displayName: user, role: user === 'ZacB' ? 'owner' : 'crew' }]))),
};
const cookies = new Map(await Promise.all(names.map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const post = (user, collection, id, data) => onRequestPost({ env, request: new Request(endpoint, {
  method: 'POST', headers: { Cookie: cookies.get(user), Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' },
  body: JSON.stringify({ collection, id, data }),
}) });
const get = user => onRequestGet({ env, request: new Request(endpoint, { headers: { Cookie: cookies.get(user) } }) });

function storage(t) {
  const documents = new Map();
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.pathname.endsWith('/documents:runQuery')) return Response.json([...documents].map(([id, document]) => ({ document: {
      name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...document,
    } })));
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (method === 'PATCH') documents.set(id, JSON.parse(options.body));
    if (!documents.has(id)) return Response.json({}, { status: 404 });
    return Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...documents.get(id) });
  });
  return documents;
}
const acknowledgements = ['timekeeping', 'location_policy', 'safety', 'customer_care', 'hub_basics'];

test('accepted punctuation variants complete and reload separate employee profiles and training', async t => {
  storage(t);
  for (const user of names.slice(1)) {
    const id = user.toLowerCase();
    assert.equal((await post(user, 'profiles', id, { username: user })).status, 200, `${user}: initial profile`);
    assert.equal((await post(user, 'profiles', id, { preferredName: user, phone: '9705550100', onboardingDraftAt: '2026-09-07T01:00:00Z' })).status, 200, `${user}: draft`);
    assert.equal((await post(user, 'profiles', id, { locationVerifiedAt: '2026-09-07T01:00:00Z', locationVerificationAccuracy: 20 })).status, 200, `${user}: location`);
    assert.equal((await post(user, 'profiles', id, { preferredName: user, phone: '9705550100', emergencyContactName: `Contact for ${user}`, emergencyContactPhone: '9705550101', onboardingCompletedAt: '2026-09-07T01:01:00Z', onboardingAcknowledgements: acknowledgements })).status, 200, `${user}: completion`);
    assert.equal((await post(user, 'training', id, { moduleId: 'welcome', answer: 1 })).status, 200, `${user}: training`);
  }
  for (const user of names.slice(1)) {
    const body = await (await get(user)).json();
    assert.equal(body.collections.profiles.length, 1);
    const profile = body.collections.profiles[0];
    assert.equal(profile.username, user);
    assert.equal(profile.emergencyContactName, `Contact for ${user}`);
    assert.equal(profile.onboardingVersion, '2026-09-location-v2');
    assert.equal(profile.locationVerificationAccuracy, 20);
    assert.equal(body.collections.training.length, 1);
    assert.equal(body.collections.training[0].employee, user);
  }
});

test('canonical profile migration preserves only an exactly owned legacy profile', async t => {
  storage(t);
  assert.equal((await post('ZacB', 'profiles', 'john-smith', { username: 'John.Smith', preferredName: 'Saved preferred name', hourlyRate: 26, emergencyContactName: 'Saved emergency contact' })).status, 200);
  const response = await post('John.Smith', 'profiles', 'john.smith', { locationVerifiedAt: '2026-09-07T01:00:00Z', locationVerificationAccuracy: 9 });
  assert.equal(response.status, 200);
  const record = (await response.json()).record;
  assert.equal(record.id, 'john.smith');
  assert.equal(record.hourlyRate, 26);
  assert.equal(record.emergencyContactName, 'Saved emergency contact');
  const rows = (await (await get('John.Smith')).json()).collections.profiles;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'john.smith');
  assert.equal(rows[0].locationVerificationAccuracy, 9);
});

test('an occupied legacy profile ID cannot be overwritten or supply another employee pay rate', async t => {
  const documents = storage(t);
  assert.equal((await post('ZacB', 'profiles', 'john-smith', { username: 'John.Smith', hourlyRate: 99, emergencyContactName: 'Private contact' })).status, 200);
  const before = JSON.stringify([...documents]);
  const denied = await post('John-Smith', 'profiles', 'john-smith', { username: 'John-Smith' });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /belongs to another employee/);
  assert.equal(JSON.stringify([...documents]), before);
  const clock = await post('John-Smith', 'timeEntries', 'synthetic-shift', { locationTracking: true, lastLocation: { lat: 40, lng: -105 } });
  assert.equal(clock.status, 200);
  assert.equal((await clock.json()).record.hourlyRate, 0);
});

function suite(user) {
  const values = new Map([['egc_u', user], ['egc_name', user], ['egc_role', 'crew']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const context = { console, URLSearchParams, Date, Intl, Promise, Set, Map, Error, Event,
    sessionStorage: storage, localStorage: storage, navigator: {}, location: { pathname: '/employee', search: '' },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    document: { readyState: 'loading', activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
  };
  context.window = context;
  let source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'globalThis.ui={S,employeeKey,sameAccount,ownProfile,trainingRecord,personalEntries,onboardingDraftKey};})();');
  vm.runInNewContext(source, context);
  return context.ui;
}

test('profile and training selection uses exact usernames and personal pay retains actual timecards', () => {
  const ui = suite('John.Smith');
  ui.S.people.profiles = [
    { id: 'john-smith', username: 'John-Smith', preferredName: 'Other punctuation', hourlyRate: 99 },
    { id: 'johnsmith2', username: 'JohnSmith2', preferredName: 'Other prefix', hourlyRate: 88 },
    { id: 'johnsmith', username: 'John.Smith', preferredName: 'Correct legacy profile', hourlyRate: 26 },
  ];
  assert.equal(ui.ownProfile().preferredName, 'Correct legacy profile');
  ui.S.people.training = [{ employee: 'John-Smith', id: 'other-training' }, { employee: 'John.Smith', id: 'legacy-own-training' }];
  assert.equal(ui.trainingRecord().id, 'legacy-own-training');
  ui.S.people.timeEntries = [{ id: 'other', employee: 'John-Smith' }, { id: 'own', employee: 'John.Smith', clockInAt: '2026-09-07T01:00:00Z' }];
  assert.deepEqual(Array.from(ui.personalEntries(), row => row.id), ['own']);
  assert.equal(ui.onboardingDraftKey(), 'egc_onboarding_draft:john.smith');
  assert.equal(ui.sameAccount('John.Smith', 'John-Smith'), false);
  assert.equal(ui.sameAccount('JohnSmith', 'JohnSmith2'), false);
  assert.equal(ui.employeeKey(' John_Smith '), 'john_smith');
});
