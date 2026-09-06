import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateHubCredential, createHubCredentialHash, createHubSessionCookie, hashHubCredential, verifyHubSessionToken } from '../functions/_lib/hub-session.js';
import { createEmployeeApplication, listEmployeeApplications, reviewEmployeeApplication } from '../functions/_lib/employee-accounts.js';
import * as auth from '../functions/api/hub-auth.js';
import * as accounts from '../functions/api/employee-accounts.js';

const origin = 'https://easygaragecleaning.com';
const request = (path, body, cookie) => new Request(origin + path, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});
const application = (username = 'JamieR') => ({ action: 'register', acknowledged: true, firstName: 'Jamie', lastName: 'Rivera', username, email: 'test@example.invalid', phone: '9705550100', password: 'ExamplePassword123' });
const env = () => ({ HUB_SESSION_SECRET: 'test-session-only', EMPLOYEE_HUB_DATA_SECRET: 'test-original-vault-key', FIREBASE_API_KEY: 'firebase-test-account-recovery', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'not-used', displayName: 'Zac', role: 'owner' } }) });

test('explicit legacy vault preserves employee accounts while recovery blocks registration and review', async t => {
  const storage = useStorage(t), original = env();
  await createEmployeeApplication(original, application());
  const legacy = { ...original, EMPLOYEE_HUB_DATA_SECRET: '', HIGHLEVEL_API_KEY: original.EMPLOYEE_HUB_DATA_SECRET, EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HIGHLEVEL_API_KEY', HUB_SESSION_SECRET: 'different-new-session' };
  const existing = await listEmployeeApplications(legacy);
  assert.equal(existing.length, 1);
  const before = storage.writes;
  await assert.rejects(createEmployeeApplication(legacy, application('AnotherTest')), { code: 'EMPLOYEE_ACCOUNT_RECOVERY_READ_ONLY' });
  await assert.rejects(reviewEmployeeApplication(legacy, 'JamieR', 'approved', 'ZacB'), { code: 'EMPLOYEE_ACCOUNT_RECOVERY_READ_ONLY' });
  assert.equal(storage.writes, before);
  assert.equal(storage.saved.size, 1);
  await reviewEmployeeApplication({ ...legacy, EMPLOYEE_HUB_LEGACY_WRITES_VERIFIED: 'true' }, 'JamieR', 'approved', 'ZacB');
  assert.equal(storage.saved.size, 1, 'the original opaque document ID remains unchanged');
});

function useStorage(t) {
  const saved = new Map();
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('documents:runQuery')) {
      const rows = [...saved.entries()].map(([id, document]) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...document } }));
      const limit = JSON.parse(init.body).structuredQuery.limit;
      return Response.json(limit === undefined ? rows : rows.slice(0, limit));
    }
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (init.method === 'PATCH') {
      if (url.searchParams.get('currentDocument.exists') === 'false' && saved.has(id)) return Response.json({}, { status: 412 });
      writes += 1;
      saved.set(id, JSON.parse(init.body));
    }
    return saved.has(id) ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...saved.get(id) }) : Response.json({}, { status: 404 });
  });
  return { saved, get writes() { return writes; } };
}

test('static staff sign-in ignores username casing while retaining canonical identity and legacy hash input', async () => {
  const configured = { HUB_SESSION_SECRET: 'case-test-session', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: await hashHubCredential('ZacB', 'test legacy password'), role: 'owner' } }) };
  const response = await auth.onRequestPost({ request: request('/api/hub-auth', { username: ' zacb ', password: 'test legacy password' }), env: configured });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user, 'ZacB');
  assert.equal(body.displayName, 'ZacB');
  assert.equal(body.businessAccess, true);
  const token = response.headers.get('set-cookie').match(/egc_hub_session=([^;]+)/)[1];
  assert.equal((await verifyHubSessionToken(configured, token)).user, 'ZacB');
  assert.equal(await authenticateHubCredential(configured, 'ZACB', 'wrong password'), null);

  configured.HUB_AUTH_USERS_JSON = JSON.stringify({ ZacB: { passwordHash: await createHubCredentialHash('new example password'), role: 'owner' } });
  assert.equal((await authenticateHubCredential(configured, 'zAcB', 'new example password')).user, 'ZacB');
});

test('ambiguous or malformed static configuration fails closed without account fallback', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('unexpected account fallback'); });
  for (const users of ['{', '[]', 'null', JSON.stringify({ ZacB: { passwordHash: 'a' }, zacb: { passwordHash: 'b' } }), JSON.stringify({ ZacB: { role: 'owner' } }), JSON.stringify({ ZacB: null }), JSON.stringify({ ZacB: { passwordHash: ' ' } })]) {
    const response = await auth.onRequestPost({ request: request('/api/hub-auth', { username: 'zacb', password: 'example' }), env: { ...env(), HUB_AUTH_USERS_JSON: users } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'HUB_AUTH_CONFIGURATION');
  }
  assert.equal(requests, 0);
});

test('a reserved business account missing from configuration reports setup failure', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('unexpected employee lookup'); });
  for (const username of ['ZacB', 'TYLERG', 'alexk']) {
    const response = await auth.onRequestPost({ request: request('/api/hub-auth', { username, password: 'example password' }), env: { ...env(), HUB_AUTH_USERS_JSON: '{}' } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'HUB_AUTH_CONFIGURATION');
  }
  assert.equal(requests, 0);
});

test('malformed successful account-query responses cannot appear as an empty list', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  for (const invalid of [{}, null, [{ error: { status: 'UNAVAILABLE' } }], [null], [{}], [{ readTime: 17 }], [{ readTime: '' }], [{ document: null, readTime: '2026-09-06T00:00:00Z' }]]) {
    body = invalid;
    await assert.rejects(listEmployeeApplications(env()), { code: 'EMPLOYEE_ACCOUNT_STORAGE_UNAVAILABLE' });
  }
  body = [{ readTime: '2026-09-06T00:00:00Z' }];
  assert.deepEqual(await listEmployeeApplications(env()), []);
});

test('all pending applications are returned beyond the former 250-record cap', async t => {
  const storage = useStorage(t);
  const configured = env();
  const encoder = new TextEncoder();
  const b64 = bytes => Buffer.from(bytes).toString('base64url');
  const encryptionKey = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`${configured.EMPLOYEE_HUB_DATA_SECRET}:employee-accounts:data`)), { name: 'AES-GCM' }, false, ['encrypt']);
  const idKey = await crypto.subtle.importKey('raw', encoder.encode(configured.EMPLOYEE_HUB_DATA_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  for (let index = 0; index < 251; index += 1) {
    const username = `Employee${index}`;
    const id = `secure_account_${b64(await crypto.subtle.sign('HMAC', idKey, encoder.encode(`employee-account:${username.toLowerCase()}`)))}`;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const account = { username, status: 'pending', appliedAt: new Date(1700000000000 + index * 1000).toISOString() };
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, encryptionKey, encoder.encode(JSON.stringify(account)));
    storage.saved.set(id, { fields: { recordType: { stringValue: 'employee_account_v1' }, sealedPayload: { stringValue: b64(ciphertext) }, sealedIv: { stringValue: b64(iv) } } });
  }
  const result = await listEmployeeApplications(configured);
  assert.equal(result.length, 251);
  assert.equal(result[0].username, 'Employee250');
  assert.equal(new Set(result.map(account => account.username)).size, 251);
  assert.equal(storage.writes, 0);
});

test('login and registration reject null and non-object JSON without throwing', async () => {
  for (const body of [null, [], 'hello', 4]) {
    assert.equal((await auth.onRequestPost({ request: request('/api/hub-auth', body), env: env() })).status, 400);
    assert.equal((await accounts.onRequestPost({ request: request('/api/employee-accounts', body), env: env() })).status, 400);
  }
});

test('owner and manager names cannot be registered when static users are absent', async t => {
  const storage = useStorage(t);
  const configured = { ...env(), HUB_AUTH_USERS_JSON: '{}' };
  for (const username of ['ZacB', 'tylerg', 'ALEXK']) {
    const response = await accounts.onRequestPost({ request: request('/api/employee-accounts', application(username)), env: configured });
    assert.equal(response.status, 409);
  }
  assert.equal(storage.writes, 0);
});

test('registration rejects an overlong username instead of silently truncating it', async t => {
  const storage = useStorage(t);
  const response = await accounts.onRequestPost({ request: request('/api/employee-accounts', application('J'.repeat(33))), env: env() });
  assert.equal(response.status, 400);
  assert.equal(storage.writes, 0);
});

test('a changed employee vault key reports recovery needed and never creates replacement accounts', async t => {
  const storage = useStorage(t);
  const original = env();
  await createEmployeeApplication(original, application());
  await reviewEmployeeApplication(original, 'JamieR', 'approved', 'ZacB');
  const previousWrites = storage.writes;
  const changed = { ...original, EMPLOYEE_HUB_DATA_SECRET: 'different-key' };

  await assert.rejects(listEmployeeApplications(changed), { code: 'EMPLOYEE_ACCOUNT_DATA_UNREADABLE' });
  const login = await auth.onRequestPost({ request: request('/api/hub-auth', { username: 'JamieR', password: 'ExamplePassword123' }), env: changed });
  assert.equal(login.status, 503);
  assert.equal((await login.json()).code, 'EMPLOYEE_ACCOUNT_DATA_UNREADABLE');
  const register = await accounts.onRequestPost({ request: request('/api/employee-accounts', application()), env: changed });
  assert.equal(register.status, 503);
  assert.equal(storage.writes, previousWrites);
  assert.equal(storage.saved.size, 1);
  assert.equal((await authenticateHubCredential(original, 'jamier', 'ExamplePassword123')).user, 'JamieR');
});

test('corrupt account data stops listing, login, and review with no writes', async t => {
  const storage = useStorage(t);
  const configured = env();
  await createEmployeeApplication(configured, application());
  const [id, document] = [...storage.saved.entries()][0];
  document.fields.sealedPayload.stringValue = 'invalid ciphertext';
  storage.saved.set(id, document);
  const previousWrites = storage.writes;
  const cookie = (await createHubSessionCookie(configured, 'ZacB')).split(';')[0];
  const list = await accounts.onRequestGet({ request: new Request(origin + '/api/employee-accounts', { headers: { Cookie: cookie } }), env: configured });
  assert.equal(list.status, 503);
  assert.equal((await list.json()).code, 'EMPLOYEE_ACCOUNT_DATA_UNREADABLE');
  const review = await accounts.onRequestPost({ request: request('/api/employee-accounts', { action: 'review', username: 'JamieR', decision: 'approved' }, cookie), env: configured });
  assert.equal(review.status, 503);
  const login = await auth.onRequestPost({ request: request('/api/hub-auth', { username: 'JamieR', password: 'ExamplePassword123' }), env: configured });
  assert.equal(login.status, 503);
  assert.equal(storage.writes, previousWrites);
});

test('storage failure is not reported as incorrect credentials', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
  const response = await auth.onRequestPost({ request: request('/api/hub-auth', { username: 'JamieR', password: 'example' }), env: env() });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'EMPLOYEE_ACCOUNT_STORAGE_UNAVAILABLE');
});

test('pending and rejected account feedback is shown only after the password is verified', async t => {
  useStorage(t);
  const configured = env();
  await createEmployeeApplication(configured, application());
  const login = password => auth.onRequestPost({ request: request('/api/hub-auth', { username: 'JamieR', password }), env: configured });
  const wrong = await login('wrong password');
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).code, undefined);
  const pending = await login('ExamplePassword123');
  assert.equal(pending.status, 401);
  assert.equal((await pending.json()).code, 'EMPLOYEE_ACCOUNT_PENDING');
  await reviewEmployeeApplication(configured, 'JamieR', 'rejected', 'ZacB');
  const rejected = await login('ExamplePassword123');
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).code, 'EMPLOYEE_ACCOUNT_REJECTED');
});
