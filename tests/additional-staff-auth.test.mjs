import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubCredentialHash, listHubUserProfiles, verifyHubSessionToken } from '../functions/_lib/hub-session.js';
import * as auth from '../functions/api/hub-auth.js';
import * as accounts from '../functions/api/employee-accounts.js';

const origin = 'https://easygaragecleaning.com';
const ownerPassword = 'Synthetic owner password 904!';
const tylerPassword = 'Synthetic manager password 905!';
const ownerHash = await createHubCredentialHash(ownerPassword);
const tylerHash = await createHubCredentialHash(tylerPassword);
const baseUsers = { ZacB: { passwordHash: ownerHash, displayName: 'Zac', role: 'owner', payType: 'owner', hourlyRate: 0 } };
const additionalUsers = { TylerG: { passwordHash: tylerHash, displayName: 'Tyler', role: 'manager', payType: 'hourly', hourlyRate: 23 } };
const environment = () => ({
  HUB_SESSION_SECRET: 'synthetic-additional-staff-session',
  HUB_AUTH_USERS_JSON: JSON.stringify(baseUsers),
  HUB_AUTH_ADDITIONAL_USERS_JSON: JSON.stringify(additionalUsers),
});
const signIn = (env, username, password) => auth.onRequestPost({
  env,
  request: new Request(`${origin}/api/hub-auth`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }),
});
const sessionToken = response => response.headers.get('set-cookie').match(/egc_hub_session=([^;]+)/)[1];

test('appending staff preserves the existing owner credential, profile, and session', async () => {
  const env = environment();
  delete env.HUB_AUTH_ADDITIONAL_USERS_JSON;
  const before = await signIn(env, 'ZacB', ownerPassword);
  assert.equal(before.status, 200);
  const beforeProfile = await before.json();
  const token = sessionToken(before);
  const originalBaseSecret = env.HUB_AUTH_USERS_JSON;

  env.HUB_AUTH_ADDITIONAL_USERS_JSON = JSON.stringify(additionalUsers);
  const after = await signIn(env, 'zacb', ownerPassword);
  assert.equal(after.status, 200);
  assert.deepEqual(await after.json(), beforeProfile);
  const restored = await verifyHubSessionToken(env, token);
  assert.equal(restored.user, 'ZacB');
  assert.equal(restored.role, 'owner');
  assert.equal(restored.businessAccess, true);
  assert.equal(env.HUB_AUTH_USERS_JSON, originalBaseSecret);
});

test('supplemental TylerG signs in and restores as manager while account approvals remain owner-only', async () => {
  const env = environment();
  const response = await signIn(env, ' tylerg ', tylerPassword);
  assert.equal(response.status, 200);
  const profile = await response.json();
  assert.equal(profile.user, 'TylerG');
  assert.equal(profile.displayName, 'Tyler');
  assert.equal(profile.role, 'manager');
  assert.equal(profile.businessAccess, true);
  assert.equal(profile.hourlyRate, 23);
  assert.equal(Object.hasOwn(profile, 'passwordHash'), false);
  const token = sessionToken(response);
  const restored = await verifyHubSessionToken(env, token);
  assert.equal(restored.user, 'TylerG');
  assert.equal(restored.role, 'manager');
  assert.equal(restored.businessAccess, true);
  const listed = listHubUserProfiles(env);
  assert.deepEqual(listed.map(user => user.user), ['ZacB', 'TylerG']);
  assert.equal(listed.some(user => 'passwordHash' in user || 'hash' in user), false);
  const queue = await accounts.onRequestGet({
    env,
    request: new Request(`${origin}/api/employee-accounts`, { headers: { Cookie: `egc_hub_session=${token}` } }),
  });
  assert.equal(queue.status, 403);
});

test('supplemental staff cannot sign in with an incorrect password or fall through to employee storage', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('unexpected employee fallback'); });
  const response = await signIn(environment(), 'TylerG', 'Synthetic wrong password 906!');
  assert.equal(response.status, 401);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.equal(requests, 0);
});

test('normalized username collisions fail closed within and between both maps', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('unexpected employee fallback'); });
  const cases = [
    [{ ZacB: baseUsers.ZacB, ' zacb ': baseUsers.ZacB }, additionalUsers],
    [baseUsers, { TylerG: additionalUsers.TylerG, ' TYLERG ': additionalUsers.TylerG }],
    [baseUsers, { ...additionalUsers, ZacB: additionalUsers.TylerG }],
    [baseUsers, { ...additionalUsers, ' ZACB ': additionalUsers.TylerG }],
  ];
  for (const [base, additional] of cases) {
    const env = { ...environment(), HUB_AUTH_USERS_JSON: JSON.stringify(base), HUB_AUTH_ADDITIONAL_USERS_JSON: JSON.stringify(additional) };
    for (const username of ['ZacB', 'TylerG']) {
      const response = await signIn(env, username, username === 'ZacB' ? ownerPassword : tylerPassword);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'HUB_AUTH_CONFIGURATION');
      assert.equal(response.headers.has('set-cookie'), false);
    }
  }
  assert.equal(requests, 0);
});

test('malformed base or supplemental maps cannot be masked by the valid other map', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('unexpected employee fallback'); });
  for (const setting of ['HUB_AUTH_USERS_JSON', 'HUB_AUTH_ADDITIONAL_USERS_JSON']) {
    for (const value of ['{', '[]', 'null', '42', '"text"']) {
      const env = { ...environment(), [setting]: value };
      for (const username of ['ZacB', 'TylerG']) {
        const response = await signIn(env, username, username === 'ZacB' ? ownerPassword : tylerPassword);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, 'HUB_AUTH_CONFIGURATION');
        assert.equal(response.headers.has('set-cookie'), false);
      }
    }
  }
  assert.equal(requests, 0);
});

test('supplemental records receive the same credential validation as base records', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('unexpected employee fallback'); });
  for (const record of [null, [], { role: 'manager' }, { passwordHash: ' ' }, { passwordHash: 'invalid-hash' }]) {
    const env = { ...environment(), HUB_AUTH_ADDITIONAL_USERS_JSON: JSON.stringify({ TylerG: record }) };
    const response = await signIn(env, 'TylerG', tylerPassword);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'HUB_AUTH_CONFIGURATION');
    assert.equal(response.headers.has('set-cookie'), false);
  }
  assert.equal(requests, 0);
});

test('staff additions do not weaken password generation or the business username boundary', async () => {
  await assert.rejects(createHubCredentialHash('Example123!'), /at least 12 characters/);
  const env = { ...environment(), HUB_AUTH_ADDITIONAL_USERS_JSON: JSON.stringify({ OtherStaff: additionalUsers.TylerG }) };
  const response = await signIn(env, 'OtherStaff', tylerPassword);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).businessAccess, false);
});
