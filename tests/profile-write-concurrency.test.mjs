import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { onRequestGet, onRequestPost } from '../functions/api/employee-hub.js';

const endpoint = 'https://easygaragecleaning.com/api/employee-hub';
const env = {
  HUB_SESSION_SECRET: 'synthetic-profile-concurrency-session', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-profile-concurrency-vault',
  FIREBASE_API_KEY: 'firebase-test-profile-concurrency',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test', displayName: 'Owner', role: 'owner' }, 'Crew.Test': { passwordHash: 'test', displayName: 'Crew Test', role: 'crew' } }),
};
const cookies = new Map(await Promise.all(['ZacB', 'Crew.Test'].map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const completed = {
  preferredName: 'Final name', phone: '9705550100', emergencyContactName: 'Final emergency', emergencyContactPhone: '9705550101',
  onboardingCompletedAt: '2026-09-07T01:01:00Z', onboardingAcknowledgements: ['timekeeping', 'location_policy', 'safety', 'customer_care', 'hub_basics'],
};

function fixture(t, conflictStatus = 412) {
  const documents = new Map(), patches = [];
  let revision = 0, hold = null, rejectWrites = false, omitVersion = false, conflicts = 0;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    assert.equal(url.hostname, 'firestore.googleapis.com', 'all storage transport is mocked');
    const envelope = (id, doc) => { const result = { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...doc }; if (omitVersion) delete result.updateTime; return result; };
    if (url.pathname.endsWith('/documents:runQuery')) return Response.json([...documents].map(([id, doc]) => ({ document: envelope(id, doc) })));
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (method === 'PATCH') {
      patches.push({ exists: url.searchParams.get('currentDocument.exists'), updateTime: url.searchParams.get('currentDocument.updateTime'), id });
      if (hold) { const active = hold; hold = null; active.started(); await active.promise; }
      const expected = url.searchParams.get('currentDocument.updateTime'), exists = url.searchParams.get('currentDocument.exists');
      if (rejectWrites || (exists === 'false' && documents.has(id)) || (expected && documents.get(id)?.updateTime !== expected)) {
        conflicts += 1;
        return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: conflictStatus });
      }
      documents.set(id, { ...JSON.parse(options.body), updateTime: `2026-09-07T00:00:00.${String(++revision).padStart(9, '0')}Z` });
    }
    return documents.has(id) ? Response.json(envelope(id, documents.get(id))) : Response.json({}, { status: 404 });
  });
  return {
    documents, patches, conflicts: () => conflicts,
    rejectWrites: () => { rejectWrites = true; }, omitVersion: () => { omitVersion = true; },
    pauseNext() {
      let release, started;
      const ready = new Promise(resolve => { started = resolve; });
      const promise = new Promise(resolve => { release = resolve; });
      hold = { started, promise };
      return { ready, release };
    },
    post(data, user = 'Crew.Test', id = 'crew.test') {
      return onRequestPost({ env, request: new Request(endpoint, { method: 'POST',
        headers: { Cookie: cookies.get(user), Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'profiles', id, data }),
      }) });
    },
    async read() { const response = await onRequestGet({ env, request: new Request(endpoint, { headers: { Cookie: cookies.get('Crew.Test') } }) }); assert.equal(response.status, 200); return (await response.json()).collections.profiles[0]; },
  };
}

for (const [label, update] of [
  ['location verification', { locationVerifiedAt: '2026-09-07T01:00:00Z', locationVerificationAccuracy: 10 }],
  ['first-login profile initialization', { username: 'Crew.Test' }],
  ['older autosave', { preferredName: 'Old draft', emergencyContactName: 'Old emergency', onboardingDraftAt: '2026-09-07T01:00:00Z' }],
]) {
  test(`a delayed ${label} retries and preserves a completed profile`, async t => {
    const store = fixture(t);
    assert.equal((await store.post({ username: 'Crew.Test' })).status, 200);
    const gate = store.pauseNext(), pending = store.post(update);
    await gate.ready;
    assert.equal((await store.post(completed)).status, 200);
    gate.release();
    assert.equal((await pending).status, 200);
    const record = await store.read();
    assert.equal(record.preferredName, 'Final name');
    assert.equal(record.emergencyContactName, 'Final emergency');
    assert.equal(record.onboardingCompletedAt, completed.onboardingCompletedAt);
    assert.equal(record.onboardingDraftAt, '');
    if (update.locationVerifiedAt) assert.equal(record.locationVerifiedAt, update.locationVerifiedAt);
    assert.equal(store.conflicts(), 1);
    assert.ok(store.patches.slice(1).every(patch => patch.updateTime));
  });
}

test('concurrent first-profile creation uses create-only, then retries the winner version', async t => {
  const store = fixture(t, 400), gate = store.pauseNext();
  const pending = store.post({ username: 'Crew.Test' });
  await gate.ready;
  assert.equal((await store.post(completed)).status, 200);
  gate.release();
  assert.equal((await pending).status, 200);
  assert.equal(store.documents.size, 1);
  assert.equal((await store.read()).onboardingCompletedAt, completed.onboardingCompletedAt);
  assert.equal(store.conflicts(), 1);
  assert.equal(store.patches[0].exists, 'false');
  assert.equal(store.patches[1].exists, 'false');
  assert.ok(store.patches[2].updateTime);
});

test('legacy migration guards the absent canonical target instead of its legacy source version', async t => {
  const store = fixture(t);
  assert.equal((await store.post({ username: 'Crew.Test', hourlyRate: 26, preferredName: 'Legacy name' }, 'ZacB', 'crew-test')).status, 200);
  const legacy = JSON.stringify([...store.documents]);
  const gate = store.pauseNext(), pending = store.post({ locationVerifiedAt: '2026-09-07T01:00:00Z' });
  await gate.ready;
  assert.equal((await store.post(completed)).status, 200);
  gate.release();
  assert.equal((await pending).status, 200);
  const record = await store.read();
  assert.equal(record.id, 'crew.test');
  assert.equal(record.hourlyRate, 26);
  assert.equal(record.onboardingCompletedAt, completed.onboardingCompletedAt);
  assert.ok(record.locationVerifiedAt);
  assert.equal(store.documents.size, 2);
  assert.equal(JSON.stringify([[...store.documents][0][0], [...store.documents][0][1]]), JSON.stringify(JSON.parse(legacy)[0]));
  assert.equal(store.patches[1].exists, 'false');
  assert.equal(store.patches[2].exists, 'false');
  assert.ok(store.patches[3].updateTime);
});

test('bounded conflict retries fail visibly without replacing the last saved completion', async t => {
  const store = fixture(t);
  assert.equal((await store.post(completed)).status, 200);
  const saved = JSON.stringify([...store.documents]);
  store.rejectWrites();
  const response = await store.post({ locationVerifiedAt: '2026-09-07T01:02:00Z' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'EMPLOYEE_HUB_WRITE_CONFLICT');
  assert.equal(store.conflicts(), 4);
  assert.equal(JSON.stringify([...store.documents]), saved);
});

test('missing Firestore profile version fails safely before issuing an unguarded update', async t => {
  const store = fixture(t);
  assert.equal((await store.post(completed)).status, 200);
  const saved = JSON.stringify([...store.documents]), writes = store.patches.length;
  store.omitVersion();
  const response = await store.post({ locationVerifiedAt: '2026-09-07T01:02:00Z' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'EMPLOYEE_HUB_STORAGE_UNREADABLE');
  assert.equal(store.patches.length, writes);
  assert.equal(JSON.stringify([...store.documents]), saved);
});
