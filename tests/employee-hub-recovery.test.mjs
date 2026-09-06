import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubCredentialHash, createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { onRequestGet, onRequestPost } from '../functions/api/employee-hub.js';

const endpoint = 'https://easygaragecleaning.com/api/employee-hub';
const env = {
  HUB_SESSION_SECRET: 'employee-hub-recovery-test-session-key',
  EMPLOYEE_HUB_DATA_SECRET: 'employee-hub-recovery-test-vault-key',
  FIREBASE_API_KEY: 'firebase-test-employee-hub-recovery',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: {
    passwordHash: await createHubCredentialHash('Synthetic test password 904!'),
    displayName: 'Test Owner', role: 'owner',
  } }),
};
const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
const get = (environment = env) => onRequestGet({
  request: new Request(endpoint, { headers: { Cookie: cookie } }), env: environment,
});
const post = (body, environment = env) => onRequestPost({
  request: new Request(endpoint, {
    method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env: environment,
});

function storage(t) {
  const documents = new Map();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    requests.push({ url, method, body: options.body });
    if (url.pathname.endsWith('/documents:runQuery')) {
      const query = JSON.parse(options.body).structuredQuery;
      const entries = [...documents.entries()].slice(0, query.limit ?? documents.size);
      return Response.json(entries.map(([id, document]) => ({ document: {
        name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...document,
      } })));
    }
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (method === 'PATCH') documents.set(id, JSON.parse(options.body));
    if (!documents.has(id)) return Response.json({}, { status: 404 });
    return Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...documents.get(id) });
  });
  return { documents, requests };
}

async function seed() {
  const response = await post({ collection: 'training', id: 'saved-training', data: { employee: 'Crewtest', completed: ['welcome'] } });
  assert.equal(response.status, 200);
}

async function assertUnreadable(response) {
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'EMPLOYEE_HUB_STORAGE_UNREADABLE');
  assert.equal(body.collections, undefined);
  assert.equal(body.record, undefined);
}

test('corrupt encrypted history fails visibly and cannot be overwritten as a missing record', async t => {
  const { documents, requests } = storage(t);
  await seed();
  const document = [...documents.values()][0];
  document.fields.sealedPayload.stringValue = 'broken-ciphertext';
  const saved = JSON.stringify([...documents]);
  const writes = requests.filter(request => request.method === 'PATCH').length;
  await assertUnreadable(await get());
  await assertUnreadable(await post({ collection: 'training', id: 'saved-training', data: { completed: [] } }));
  assert.equal(requests.filter(request => request.method === 'PATCH').length, writes);
  assert.equal(JSON.stringify([...documents]), saved);
});

test('malformed existing storage envelopes are never treated as absent', async t => {
  const { documents, requests } = storage(t);
  await seed();
  delete [...documents.values()][0].fields.sealedIv;
  const writes = requests.filter(request => request.method === 'PATCH').length;
  await assertUnreadable(await get());
  await assertUnreadable(await post({ collection: 'training', id: 'saved-training', data: { completed: [] } }));
  assert.equal(requests.filter(request => request.method === 'PATCH').length, writes);
});

test('changing the vault key reports unavailable history instead of an empty successful list', async t => {
  const { documents, requests } = storage(t);
  await seed();
  const wrongKeyEnv = { ...env, EMPLOYEE_HUB_DATA_SECRET: 'different-vault-key' };
  const saved = JSON.stringify([...documents]);
  const writes = requests.filter(request => request.method === 'PATCH').length;
  await assertUnreadable(await get(wrongKeyEnv));
  await assertUnreadable(await post({ collection: 'training', id: 'saved-training', data: { completed: [] } }, wrongKeyEnv));
  await assertUnreadable(await post({ collection: 'timeEntries', id: 'new-time', data: { employee: 'Crewtest' } }, wrongKeyEnv));
  assert.equal(requests.filter(request => request.method === 'PATCH').length, writes);
  assert.equal(JSON.stringify([...documents]), saved);
});

test('the complete employee history remains available beyond 500 records', async t => {
  const { documents, requests } = storage(t);
  const encoder = new TextEncoder();
  const base64Url = value => Buffer.from(value).toString('base64url');
  const identityKey = await crypto.subtle.importKey('raw', encoder.encode(env.EMPLOYEE_HUB_DATA_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const encryptionKey = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`${env.EMPLOYEE_HUB_DATA_SECRET}:employee-hub-v2:data`)), 'AES-GCM', false, ['encrypt']);
  for (let index = 0; index < 501; index += 1) {
    const id = `time-${index}`;
    const documentId = `secure_${base64Url(await crypto.subtle.sign('HMAC', identityKey, encoder.encode(`timeEntries:${id}`)))}`;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(documentId) }, encryptionKey,
      encoder.encode(JSON.stringify({ id, employee: 'Crewtest', marker: index })));
    documents.set(documentId, { fields: {
      recordType: { stringValue: 'employee_hub_v2' }, employeeHubType: { stringValue: 'timeEntries' },
      vaultId: { stringValue: documentId }, schemaVersion: { integerValue: '2' },
      sealedPayload: { stringValue: base64Url(ciphertext) }, sealedIv: { stringValue: base64Url(iv) },
    } });
  }
  const response = await get();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.collections.timeEntries.length, 501);
  assert.equal(body.collections.timeEntries.at(-1).marker, 500);
  assert.equal(JSON.parse(requests.find(request => request.url.pathname.endsWith(':runQuery')).body).structuredQuery.limit, undefined);
  assert.equal((await post({ collection: 'timeEntries', id: 'time-501', data: { employee: 'Crewtest', marker: 501 } })).status, 200);
});

test('a genuinely empty store is distinguishable from malformed query responses', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json([{ readTime: '2026-09-06T20:00:00Z' }]));
  const empty = await get();
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).collections.timeEntries, []);
  for (const result of [{ error: 'upstream' }, [{}], [{ error: { code: 13 } }], [null]]) {
    mocked.mock.mockImplementation(async () => Response.json(result));
    await assertUnreadable(await get());
  }
});

test('invalid employee write bodies are rejected before any storage access', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Storage must not be accessed'); });
  for (const body of [null, [], 'string', 1,
    { collection: 'training', id: ['id'], data: {} },
    ...[null, [], 'text', 1].map(data => ({ collection: 'training', id: 'id', data })),
  ]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(mocked.mock.callCount(), 0);
});
