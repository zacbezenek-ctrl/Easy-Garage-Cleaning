import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmployeeApplication, reviewEmployeeApplication } from '../functions/_lib/employee-accounts.js';
import { authenticateHubCredential, createHubSessionCookie, verifyHubSessionToken } from '../functions/_lib/hub-session.js';
import { onRequestGet as firebaseSession } from '../functions/api/firebase-session.js';

const configured = () => ({ HUB_SESSION_SECRET: 'synthetic-session-secret', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-vault-secret', FIREBASE_API_KEY: 'firebase-test-session-revocation', HUB_AUTH_USERS_JSON: '{}' });
const details = { firstName: 'Test', lastName: 'Crew', username: 'TestCrew', email: 'test@example.invalid', phone: '9705550100', password: 'SyntheticPassword1' };
function storage(t) {
  const documents = new Map();
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('documents:runQuery')) return Response.json([...documents.entries()].map(([id, document]) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...document } })));
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (init.method === 'PATCH') {
      if (url.searchParams.get('currentDocument.exists') === 'false' && documents.has(id)) return Response.json({}, { status: 412 });
      documents.set(id, JSON.parse(init.body));
    }
    return documents.has(id) ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...documents.get(id) }) : Response.json({}, { status: 404 });
  });
  return documents;
}
async function login(env) {
  const profile = await authenticateHubCredential(env, details.username, details.password);
  const cookie = (await createHubSessionCookie(env, profile.user, profile)).split(';')[0];
  return { cookie, token: cookie.slice(cookie.indexOf('=') + 1) };
}
test('rejecting an approved employee immediately invalidates an issued Hub session and blocks Firebase token minting', async t => {
  storage(t); const env = configured();
  await createEmployeeApplication(env, details);
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  const issued = await login(env);
  assert.equal((await verifyHubSessionToken(env, issued.token)).user, details.username);
  await reviewEmployeeApplication(env, details.username, 'rejected', 'ZacB');
  assert.equal(await verifyHubSessionToken(env, issued.token), null);
  const denied = await firebaseSession({ env, request: new Request('https://easygaragecleaning.com/api/firebase-session', { headers: { Cookie: issued.cookie } }) });
  assert.equal(denied.status, 401);
});
test('reapproval requires a fresh login while repeating the same approval does not unexpectedly log employees out', async t => {
  storage(t); const env = configured();
  await createEmployeeApplication(env, details);
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  const first = await login(env);
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  assert.equal((await verifyHubSessionToken(env, first.token)).user, details.username);
  await reviewEmployeeApplication(env, details.username, 'rejected', 'ZacB');
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  assert.equal(await verifyHubSessionToken(env, first.token), null);
  const second = await login(env);
  assert.equal((await verifyHubSessionToken(env, second.token)).user, details.username);
});
test('an account removed after login cannot retain a Hub session', async t => {
  const documents = storage(t), env = configured();
  await createEmployeeApplication(env, details);
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  const issued = await login(env);
  documents.clear();
  assert.equal(await verifyHubSessionToken(env, issued.token), null);
});
test('legacy sessions without a revision remain usable only until an actual account status change', async t => {
  const documents = storage(t), env = configured();
  await createEmployeeApplication(env, details);
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  const [id, document] = [...documents.entries()][0];
  const fields = document.fields, encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`${env.EMPLOYEE_HUB_DATA_SECRET}:employee-accounts:data`)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = Buffer.from(fields.sealedIv.stringValue, 'base64url');
  const account = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, key, Buffer.from(fields.sealedPayload.stringValue, 'base64url'))));
  delete account.sessionVersion;
  fields.sealedPayload.stringValue = Buffer.from(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, key, encoder.encode(JSON.stringify(account)))).toString('base64url');
  const signedIn = await login(env);
  const payload = JSON.parse(Buffer.from(signedIn.token.split('.')[0], 'base64url').toString());
  delete payload.av;
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = await crypto.subtle.importKey('raw', encoder.encode(env.HUB_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const legacyToken = `${encoded}.${Buffer.from(await crypto.subtle.sign('HMAC', hmac, encoder.encode(encoded))).toString('base64url')}`;
  assert.equal((await verifyHubSessionToken(env, legacyToken)).user, details.username);
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  assert.equal((await verifyHubSessionToken(env, legacyToken)).user, details.username);
  await reviewEmployeeApplication(env, details.username, 'rejected', 'ZacB');
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  assert.equal(await verifyHubSessionToken(env, legacyToken), null);
});
test('employee sessions fail closed when current account storage cannot be checked', async t => {
  storage(t); const env = configured();
  await createEmployeeApplication(env, details);
  await reviewEmployeeApplication(env, details.username, 'approved', 'ZacB');
  const issued = await login(env);
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
  assert.equal(await verifyHubSessionToken(env, issued.token), null);
});
