import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { firebaseReadStatus } from '../functions/_lib/firebase-read-status.js';
import { integrationStatusHandlers } from '../functions/api/integration-status.js';

const serviceAccount = JSON.stringify({ type: 'service_account', project_id: 'egcw-1ec83', client_email: 'synthetic@egcw-1ec83.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nQQ==\n-----END PRIVATE KEY-----' });
const env = { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount };
const request = new Request('https://easygaragecleaning.com/api/integration-status');
const owner = { user: 'ZacB', role: 'owner', businessAccess: true };

test('the Firebase read check is a bounded masked GET and never returns document fields', async () => {
  let call;
  const result = await firebaseReadStatus(env, async (_env, input, init) => {
    call = { url: new URL(input), init };
    return Response.json({ documents: [{ name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/synthetic', fields: { customer: { stringValue: 'never returned' } } }] });
  });
  assert.deepEqual(result, { state: 'readable' });
  assert.equal(call.url.pathname, '/v1/projects/egcw-1ec83/databases/(default)/documents/jobs');
  assert.equal(call.url.searchParams.get('pageSize'), '1');
  assert.deepEqual(call.url.searchParams.getAll('mask.fieldPaths'), ['status']);
  assert.equal(call.init.method, 'GET');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(result), /customer|never returned|synthetic/);
  assert.deepEqual(await firebaseReadStatus(env, async () => Response.json({})), { state: 'readable' }, 'an empty jobs collection is still readable');
});

test('Firebase failures are reduced to fixed categories and safe HTTP codes', async () => {
  for (const [code, state] of [[401, 'authentication'], [403, 'permission'], [404, 'setup'], [429, 'quota'], [503, 'unavailable']]) {
    assert.deepEqual(await firebaseReadStatus(env, async () => new Response('upstream secret', { status: code })), { state, httpStatus: code });
  }
  assert.deepEqual(await firebaseReadStatus(env, async () => new Response('unexpected', { status: 418 })), { state: 'unavailable' });
  assert.deepEqual(await firebaseReadStatus(env, async () => { throw new Error('Firebase service authentication failed (401)'); }), { state: 'authentication', httpStatus: 401 });
  assert.deepEqual(await firebaseReadStatus(env, async () => { throw new Error('private credential data'); }), { state: 'unavailable' });
  assert.deepEqual(await firebaseReadStatus(env, async () => new Response('<html>bad gateway</html>')), { state: 'invalid_response' });
  const started = Date.now();
  assert.deepEqual(await firebaseReadStatus(env, async () => new Promise(() => {}), { timeoutMs: 15 }), { state: 'timeout' });
  assert.ok(Date.now() - started < 500, 'the deadline bounds even a stalled token exchange or fetch');
});

test('only a signed business viewer receives the live read result; credential readiness stays boolean', async () => {
  let probes = 0;
  const handler = session => integrationStatusHandlers({ session: async () => session, scheduleSync: async () => false, revocations: () => null,
    firebaseRead: async () => { probes++; return { state: 'permission', httpStatus: 403 }; } }).get({ request, env });
  const unsigned = await handler(null);
  assert.equal(unsigned.status, 401);
  const crew = await (await handler({ user: 'Crew', role: 'crew', businessAccess: false })).json();
  assert.equal(crew.status.firebase, true);
  assert.equal(Object.hasOwn(crew.status, 'firebaseRead'), false);
  const business = await (await handler(owner)).json();
  assert.deepEqual(business.status.firebaseRead, { state: 'permission', httpStatus: 403 });
  assert.equal(business.status.firebase, true);
  assert.equal(probes, 1);
  assert.doesNotMatch(JSON.stringify(business), /private_key|QQ==|client_email/);
  const withoutCredentials = await (await integrationStatusHandlers({ session: async () => owner, scheduleSync: async () => false, revocations: () => null,
    firebaseRead: async () => { throw new Error('must not run'); } }).get({ request, env: {} })).json();
  assert.equal(withoutCredentials.status.firebase, false);
  assert.equal(Object.hasOwn(withoutCredentials.status, 'firebaseRead'), false);
});

test('Integrations distinguishes a verified read from a configured but blocked or unchecked account', () => {
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const context = { console, URLSearchParams, Date, Intl, Promise, Set, Map, Error, me: 'ZacB', jobsCache: [], sessionStorage: storage, localStorage: storage,
    navigator: {}, location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    document: { readyState: 'loading', activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    FormData: class { forEach() {} }, hubFetch: async () => { throw new Error('Unexpected request'); }, showToast() {} };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.ui={S,views};})();');
  vm.runInNewContext(source, context);
  const { S, views } = context.ui;
  S.integrationState.loaded = true;
  const row = () => views.settings().match(/<strong>Firebase<\/strong>.*?<\/article>/)[0];
  S.integrations = { firebase: true, firebaseRead: { state: 'permission', httpStatus: 403 } };
  assert.match(row(), /Read denied/);
  assert.match(row(), /Check Firestore API access and the service account read role/);
  assert.doesNotMatch(row(), /Configured<\/span>/);
  S.integrations.firebaseRead = { state: 'readable' };
  assert.match(row(), /Read check passed/);
  assert.match(row(), /One masked server read succeeded.*Writes, browser access rules, and encrypted vault access were not checked/);
  S.integrations.firebaseRead = undefined;
  assert.match(row(), /Read not checked/);
  assert.match(row(), /live Firestore read has not been verified/);
  S.integrations.firebase = false;
  assert.match(row(), /Needs setup/);
});
