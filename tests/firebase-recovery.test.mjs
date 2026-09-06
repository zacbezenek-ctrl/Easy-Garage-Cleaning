import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { firebaseServiceAccountConfigured, getFirestoreAccessToken } from '../functions/_lib/firebase-service-account.js';
import { createHubSessionCookie, hashHubCredential } from '../functions/_lib/hub-session.js';
import { onRequestGet as firebaseSession } from '../functions/api/firebase-session.js';
import { onRequestGet as integrationStatus } from '../functions/api/integration-status.js';

const makeAccount = () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { keys, account: {
    type: 'service_account', project_id: 'egcw-1ec83',
    client_email: 'synthetic-hub@egcw-1ec83.iam.gserviceaccount.com',
    private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
  } };
};
const first = makeAccount();
const env = {
  HUB_SESSION_SECRET: 'synthetic-session-for-firebase-tests',
  EMPLOYEE_HUB_DATA_SECRET: 'synthetic-vault-for-firebase-tests',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: {
    passwordHash: await hashHubCredential('ZacB', 'synthetic password'), displayName: 'Zac', role: 'owner',
  } }),
};
const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
const request = () => new Request('https://easygaragecleaning.com/api/firebase-session', { headers: { Cookie: cookie } });
const withAccount = account => ({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account) });

test('Firebase readiness rejects public web keys and malformed or wrong-project server identities', () => {
  for (const raw of ['', 'null', '[]', '{}', 'not-json', JSON.stringify({ ...first.account, project_id: 'another-project' }), JSON.stringify({ ...first.account, private_key: 'not-a-key' }), JSON.stringify({ ...first.account, type: 'authorized_user' }), JSON.stringify({ ...first.account, project_id: undefined })]) {
    assert.equal(firebaseServiceAccountConfigured({ FIREBASE_API_KEY: 'public-web-key', FIREBASE_SERVICE_ACCOUNT_JSON: raw }), false);
  }
  assert.equal(firebaseServiceAccountConfigured(withAccount(first.account)), true);
});

test('Firebase session errors stay JSON, actionable, and free of credential contents', async () => {
  assert.equal((await firebaseSession({ request: new Request('https://easygaragecleaning.com/api/firebase-session'), env })).status, 401);
  for (const [testEnv, code] of [
    [env, 'FIREBASE_NOT_CONFIGURED'],
    [withAccount({ ...first.account, private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }), 'FIREBASE_AUTH_UNAVAILABLE'],
  ]) {
    const response = await firebaseSession({ request: request(), env: testEnv });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(body.token, undefined);
    assert.doesNotMatch(JSON.stringify(body), /BEGIN PRIVATE|gserviceaccount|synthetic-session/);
  }
});

test('Firebase token signature and claims preserve owner and employee access separation', async () => {
  const testEnv = withAccount(first.account);
  const crewCookie = (await createHubSessionCookie(testEnv, 'ZacB', { source: 'employee-account', displayName: 'Crew test', role: 'owner', businessAccess: true })).split(';')[0];
  for (const [testCookie, businessAccess, role] of [[cookie, true, 'owner'], [crewCookie, false, 'crew']]) {
    const response = await firebaseSession({ request: new Request('https://easygaragecleaning.com/api/firebase-session', { headers: { Cookie: testCookie } }), env: testEnv });
    assert.equal(response.status, 200);
    const { token } = await response.json();
    const [header, payload, signature] = token.split('.');
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), first.keys.publicKey, Buffer.from(signature, 'base64url')), true);
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.uid, 'hub:zacb');
    assert.equal(claims.claims.business_access, businessAccess);
    assert.equal(claims.claims.role, role);
    assert.equal(claims.exp - claims.iat, 3600);
  }
});

test('rotating a Firebase key invalidates the cached service token even when its email is unchanged', async () => {
  const second = makeAccount();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.method, 'POST');
    calls += 1;
    return Response.json({ access_token: `synthetic-access-${calls}`, expires_in: 3600 });
  };
  try {
    assert.equal(await getFirestoreAccessToken(withAccount(first.account)), 'synthetic-access-1');
    assert.equal(await getFirestoreAccessToken(withAccount(second.account)), 'synthetic-access-2');
    assert.equal(await getFirestoreAccessToken(withAccount(second.account)), 'synthetic-access-2');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('integration readiness cannot report an employee database connection from a public Firebase key', async () => {
  for (const [testEnv, expected] of [[{ ...env, FIREBASE_API_KEY: 'public-web-key' }, false], [withAccount(first.account), true]]) {
    const response = await integrationStatus({ request: request(), env: testEnv });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status.firebase, expected);
    assert.equal(body.status.employeeAccounts, expected);
    assert.doesNotMatch(JSON.stringify(body), /private_key|synthetic-session/);
  }
});
