import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import vm from 'node:vm';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { firebaseAdminConfigured, firestoreFetch, getFirestoreAccessToken, identityToolkitFetch } from '../functions/_lib/firebase-service-account.js';
import {
  FIREBASE_REVOCATION_COLLECTION, FIREBASE_REVOCATION_MAX_CALLS, FIREBASE_REVOCATION_PROBE_MS, FIREBASE_REVOCATION_PROBE_UID, FIREBASE_REVOCATION_READ_TIMEOUT_MS,
  FIREBASE_REVOCATION_RETRY_MS, createFirebaseRevocationService, decodeFirebaseRevocationState, firebaseRevocationStatus, firebaseRevocationTime,
  firebaseRevocations, firebaseStaffUid, identityToolkitRevoker, reconcilesStaffRoster, revokeStaffFirebaseSessions, staticStaffRoster,
} from '../functions/_lib/firebase-revocation.js';
import * as accounts from '../functions/api/employee-accounts.js';
import * as firebaseSession from '../functions/api/firebase-session.js';
import { integrationStatusHandlers } from '../functions/api/integration-status.js';
import { authenticateHubCredential, createHubSessionCookie, verifyHubSessionToken } from '../functions/_lib/hub-session.js';

const NOW = '2026-09-22T12:00:00.000Z';
const at = minutes => new Date(Date.parse(NOW) + minutes * 60000).toISOString();
const seconds = iso => Math.floor(Date.parse(iso) / 1000);
// The revocation time for a change saved at iso: the next whole second.
const after = iso => new Date((seconds(iso) + 1) * 1000).toISOString();
const ACCOUNTS_UPDATE = 'https://identitytoolkit.googleapis.com/v1/projects/egcw-1ec83/accounts:update';
const origin = 'https://easygaragecleaning.com';
const coded = code => Object.assign(new Error('synthetic provider detail sk_live_never'), { code });
const denied = () => coded('firebase_revocation_permission_denied');
const stateValue = (overrides = {}) => ({ pending: [], intents: [], revoked: [], staticRoster: [], verifiedAt: NOW, probedAt: '', probeError: '', ...overrides });
const revocationFields = status => Object.fromEntries(Object.entries(status).filter(([key]) => key.startsWith('firebaseRevocation')));
const summary = (state, pending, error = '') => ({ firebaseRevocation: state === 'verified', firebaseRevocationState: state, firebaseRevocationPending: pending, firebaseRevocationError: error });
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = (name, pair) => JSON.stringify({
  type: 'service_account', project_id: 'egcw-1ec83', client_email: `${name}@egcw-1ec83.iam.gserviceaccount.com`,
  private_key: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
});
const serviceAccountJson = serviceAccount('synthetic-revocation', keys);

// dispatchStorage-shaped store: Firestore encoding round trip, revision
// preconditions, and a hook that lets a concurrent writer run before a commit.
// A stale update reaches dispatchStorage from Firestore as FAILED_PRECONDITION
// (HTTP 400, dispatch_outcome_unknown); a create collision as a 409 conflict.
function memoryStore(staleCode = 'dispatch_revision_conflict') {
  const rows = new Map(), calls = { reads: 0, commits: 0 };
  let revision = 0;
  const key = (collection, id) => `${collection}/${id}`;
  const store = {
    rows, calls, failReads: false, failCommits: false, beforeCommit: null,
    peek() {
      const row = rows.get(key(FIREBASE_REVOCATION_COLLECTION, 'state'));
      return decodeFirebaseRevocationState(row ? { ...decodeFirestoreFields(structuredClone(row.fields)), revision: row.revision } : null);
    },
    put(value) {
      rows.set(key(FIREBASE_REVOCATION_COLLECTION, 'state'), { fields: encodeFirestoreFields(value), revision: `synthetic-revision-${++revision}` });
    },
    async read(collection, id) {
      calls.reads++;
      if (store.failReads) throw Object.assign(new Error('offline'), { code: 'dispatch_storage_unavailable', status: 503 });
      const row = rows.get(key(collection, id));
      return row ? { ...decodeFirestoreFields(structuredClone(row.fields)), id, revision: row.revision } : null;
    },
    async commit(writes) {
      calls.commits++;
      if (store.failCommits) throw Object.assign(new Error('lost'), { code: 'dispatch_outcome_unknown', status: 503 });
      if (store.beforeCommit) { const hook = store.beforeCommit; store.beforeCommit = null; hook(); }
      assert.equal(new Set(writes.map(write => key(write.collection, write.id))).size, writes.length);
      for (const write of writes) {
        const current = rows.get(key(write.collection, write.id));
        if (write.revision && current?.revision !== write.revision) throw Object.assign(new Error('changed'), { code: staleCode, status: staleCode === 'dispatch_revision_conflict' ? 409 : 503 });
        if (!write.revision && current) throw Object.assign(new Error('exists'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) {
        const current = rows.get(key(write.collection, write.id));
        rows.set(key(write.collection, write.id), { fields: { ...(current?.fields || {}), ...encodeFirestoreFields(structuredClone(write.patch)) }, revision: `synthetic-revision-${++revision}` });
      }
      return { writeResults: writes.map(() => ({})) };
    },
  };
  return store;
}

// The injected Identity Toolkit call: never the real provider.
function revoker(answer = () => 'revoked') {
  const calls = [];
  const revoke = async (uid, validSince) => {
    calls.push({ uid, validSince });
    const result = answer(uid, calls.length);
    if (result instanceof Error) throw result;
    return result;
  };
  revoke.calls = calls;
  return revoke;
}

const staff = [
  { user: 'ZacB', role: 'owner', businessAccess: true },
  { user: 'SyntheticLead', role: 'crew_lead', businessAccess: false },
  { user: 'SyntheticCrew', role: 'crew', businessAccess: false },
];

test('revocation targets exactly the uid /api/firebase-session mints', () => {
  assert.equal(firebaseStaffUid('ZacB'), 'hub:zacb');
  assert.equal(firebaseStaffUid('New.Crew_1'), 'hub:new.crew_1');
  assert.equal(firebaseStaffUid('x'.repeat(200)).length, 128);
  // Security invariant: mint and revocation share one uid derivation.
  const source = readFileSync(new URL('../functions/api/firebase-session.js', import.meta.url), 'utf8');
  assert.match(source, /createFirebaseCustomToken\(env, firebaseStaffUid\(session\.user\),/);
  assert.doesNotMatch(source, /`hub:\$\{/);
  assert.deepEqual(staticStaffRoster(staff).map(entry => entry.uid), ['hub:syntheticcrew', 'hub:syntheticlead', 'hub:zacb']);
  assert.throws(() => staticStaffRoster([...staff, { user: 'zacb', role: 'crew' }]), { code: 'firebase_revocation_roster_ambiguous' });
});

test('the revocation record is server-only: no Firestore rule opens it and the catch-all denies it', () => {
  // Security invariant: the only rule that can match firebaseSessionRevocations/state
  // is the final deny-all; browsers can neither read nor forge the pending list.
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const matches = [...rules.matchAll(/match \/(\S+) \{([^}]*)\}/g)].map(([, path, body]) => ({ segment: path.split('/')[0], body: body.trim() }));
  assert.ok(matches.length > 10);
  for (const { segment, body } of matches.filter(match => match.segment.startsWith('{') || match.segment === FIREBASE_REVOCATION_COLLECTION)) {
    assert.equal(segment, '{document=**}', `unexpected wildcard or revocation rule ${segment}`);
    assert.equal(body, 'allow read, write: if false;');
  }
  assert.ok(matches.some(match => match.segment === '{document=**}'), 'the catch-all deny exists');
});

test('the Identity Toolkit revoker sends validSince from the given clock and never relays provider text', async () => {
  const sent = [];
  const answers = [
    new Response('{}', { status: 200 }),
    Response.json({ error: { code: 400, message: 'USER_NOT_FOUND' } }, { status: 400 }),
    Response.json({ error: { code: 403, message: 'Caller does not have permission sk_live_never', status: 'PERMISSION_DENIED' } }, { status: 403 }),
    Response.json({ error: { code: 401, message: 'secret detail' } }, { status: 401 }),
    Response.json({ error: { code: 429 } }, { status: 429 }),
    new Response('upstream secret', { status: 503 }),
    Response.json({ error: { code: 400, message: 'INVALID_ID_TOKEN' } }, { status: 400 }),
    new Error('socket reset'),
  ];
  const env = { synthetic: true };
  const revoke = identityToolkitRevoker(env, async (receivedEnv, url, init) => {
    sent.push({ receivedEnv, url, init });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  assert.equal(await revoke('hub:jamier', seconds(NOW)), 'revoked');
  assert.equal(sent[0].receivedEnv, env);
  assert.equal(sent[0].url, ACCOUNTS_UPDATE);
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers['Content-Type'], 'application/json');
  assert.ok(sent[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(sent[0].init.body), { localId: 'hub:jamier', validSince: String(seconds(NOW)) });
  assert.equal(await revoke('hub:never-opened', seconds(NOW)), 'no_firebase_user');
  for (const code of ['permission_denied', 'permission_denied', 'unavailable', 'unavailable', 'rejected', 'unavailable']) {
    await assert.rejects(revoke('hub:jamier', seconds(NOW)), error => {
      assert.equal(error.code, `firebase_revocation_${code}`);
      assert.doesNotMatch(error.message, /sk_live|secret|socket|USER_NOT_FOUND|INVALID/);
      return true;
    });
  }
  assert.equal(sent.length, 8);
});

test('the default fetcher needs the real service account and uses its own Identity Toolkit token', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const env = { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson };
  const testKey = { FIREBASE_API_KEY: 'firebase-test-revocation' };
  assert.equal(firebaseAdminConfigured(env), true);
  assert.equal(firebaseAdminConfigured(testKey), false);
  assert.equal(firebaseRevocations(testKey), null, 'a unit-test Firestore key never reaches Identity Toolkit');
  const scopes = [], updates = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      const assertion = new URLSearchParams(String(init.body)).get('assertion');
      const { scope } = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url'));
      scopes.push(scope);
      return Response.json({ access_token: scope.endsWith('/identitytoolkit') ? 'synthetic-identity-token' : 'synthetic-datastore-token', expires_in: 3600 });
    }
    assert.equal(String(input), ACCOUNTS_UPDATE, 'no other Google endpoint is contacted');
    updates.push({ authorization: new Headers(init.headers).get('Authorization'), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  });
  const revoke = identityToolkitRevoker(env);
  assert.equal(await revoke('hub:jamier', seconds(NOW)), 'revoked');
  assert.equal(await revoke('hub:syntheticcrew', seconds(NOW)), 'revoked');
  assert.equal(await getFirestoreAccessToken(env), 'synthetic-datastore-token');
  assert.deepEqual(scopes, ['https://www.googleapis.com/auth/identitytoolkit', 'https://www.googleapis.com/auth/datastore']);
  assert.deepEqual(updates.map(update => update.authorization), ['Bearer synthetic-identity-token', 'Bearer synthetic-identity-token']);
  assert.deepEqual(updates[1].body, { localId: 'hub:syntheticcrew', validSince: String(seconds(NOW)) });
  // The production wiring uses the injected storage and fetcher.
  const store = memoryStore(), fetched = [];
  const service = firebaseRevocations(env, { storage: () => store, fetcher: async (_env, url, init) => { fetched.push(JSON.parse(init.body)); return new Response('{}'); } });
  assert.deepEqual(await service.revokeStaff(['JamieR'], 'account_status', NOW), { status: 'revoked' });
  assert.deepEqual(fetched, [{ localId: 'hub:jamier', validSince: String(seconds(NOW)) }]);
  assert.equal(store.peek().verifiedAt, NOW);
});

function accountStorage(t) {
  const documents = new Map(), hosts = [];
  let revision = 0;
  // onWrite runs when an account write lands; loseWriteResponses stores the
  // write and then answers 503, as when the response is lost after the commit.
  const control = { documents, hosts, failWrites: false, loseWriteResponses: false, onWrite: null };
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    assert.equal(url.hostname, 'firestore.googleapis.com', 'Identity Toolkit is only reachable through the injected revoker');
    if (url.pathname.endsWith('documents:runQuery')) {
      const type = JSON.parse(init.body).structuredQuery.where.fieldFilter.value.stringValue;
      return Response.json([...documents].filter(([, document]) => document.fields.recordType.stringValue === type)
        .map(([id, document]) => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...document } })));
    }
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (init.method === 'PATCH') {
      if (control.failWrites) return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
      if (url.searchParams.get('currentDocument.exists') === 'false' && documents.has(id)) return Response.json({}, { status: 412 });
      documents.set(id, { ...JSON.parse(init.body), updateTime: `2026-09-22T12:00:00.${String(++revision).padStart(6, '0')}Z` });
      control.onWrite?.();
      if (control.loseWriteResponses) return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
    }
    return documents.has(id) ? Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...documents.get(id) }) : Response.json({}, { status: 404 });
  });
  return control;
}

async function hubFixture(t, answer) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const storage = accountStorage(t);
  const env = {
    HUB_SESSION_SECRET: 'synthetic-revocation-session-secret',
    EMPLOYEE_HUB_DATA_SECRET: 'synthetic-revocation-vault-secret',
    // The test key keeps Firestore on the synthetic fake; the synthetic service
    // account only signs custom tokens locally. Identity Toolkit is injected.
    FIREBASE_API_KEY: 'firebase-test-revocation',
    FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
    HUB_AUTH_USERS_JSON: JSON.stringify({
      ZacB: { passwordHash: 'unused-synthetic-owner-hash', role: 'owner', displayName: 'Synthetic Owner' },
      SyntheticCrew: { passwordHash: 'unused-synthetic-crew-hash', role: 'crew', displayName: 'Synthetic Crew' },
    }),
  };
  const clock = { now: NOW };
  const store = memoryStore(), revoke = revoker(answer);
  const service = createFirebaseRevocationService({ store, revoke });
  const factories = { calls: 0 };
  // Every deployment holding this service account reaches the same state record.
  const revocations = received => { factories.calls++; assert.equal(received.FIREBASE_SERVICE_ACCOUNT_JSON, env.FIREBASE_SERVICE_ACCOUNT_JSON); return service; };
  const handlers = accounts.employeeAccountsHandlers({ revocations, now: () => new Date(clock.now) });
  const status = integrationStatusHandlers({ revocations, now: () => new Date(clock.now) });
  const owner = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const crew = (await createHubSessionCookie(env, 'SyntheticCrew')).split(';')[0];
  const post = (body, cookie) => handlers.post({ env, request: new Request(`${origin}/api/employee-accounts`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  }) });
  const register = async () => assert.equal((await post({ action: 'register', acknowledged: true, username: 'JamieR', firstName: 'Synthetic', lastName: 'Employee',
    email: 'jamie@example.invalid', phone: '9705550142', password: 'SyntheticPass904' })).status, 201);
  const review = async (decision, username = 'JamieR') => {
    const response = await post({ action: 'review', username, decision }, owner);
    assert.equal(response.status, 200);
    return response.json();
  };
  const readiness = async (cookie = owner, background = null, base = origin, readinessEnv = env) => {
    const response = await status.get({ env: readinessEnv, request: new Request(`${base}/api/integration-status`, { headers: { Cookie: cookie } }),
      ...(background ? { waitUntil: work => background.push(work) } : {}) });
    assert.equal(response.status, 200);
    return (await response.json()).status;
  };
  const signIn = async () => {
    const profile = await authenticateHubCredential(env, 'JamieR', 'SyntheticPass904');
    const cookie = (await createHubSessionCookie(env, profile.user, profile)).split(';')[0];
    return cookie.slice(cookie.indexOf('=') + 1);
  };
  const mint = token => firebaseSession.onRequestGet({ env, request: new Request(`${origin}/api/firebase-session`, { headers: { Cookie: `egc_hub_session=${token}` } }) });
  return { env, clock, store, service, revoke, factories, storage, post, owner, review, register, readiness, signIn, mint, crew };
}

test('approving, then deactivating an employee revokes their Firebase sessions at the injected time; repeated reviews make no call', async t => {
  const hub = await hubFixture(t);
  await hub.register();
  const approved = await hub.review('approved');
  assert.equal(approved.account.status, 'approved');
  assert.deepEqual(approved.firebaseRevocation, { status: 'revoked' });
  // validSince is the second after the saved change: Identity Toolkit keeps a
  // session minted in the same second as validSince.
  assert.deepEqual(hub.revoke.calls, [{ uid: 'hub:jamier', validSince: seconds(NOW) + 1 }]);

  hub.clock.now = at(30);
  assert.deepEqual((await hub.review('approved', ' JAMIER ')).firebaseRevocation, { status: 'not_needed' });
  assert.equal(hub.revoke.calls.length, 1, 'a no-op review does not call Identity Toolkit');
  const token = await hub.signIn();
  assert.equal((await verifyHubSessionToken(hub.env, token)).user, 'JamieR');
  // The active employee's Firebase session is minted for the uid revocation targets.
  const minted = await hub.mint(token);
  assert.equal(minted.status, 200);
  const custom = JSON.parse(Buffer.from((await minted.json()).token.split('.')[1], 'base64url'));
  assert.equal(custom.uid, 'hub:jamier');
  assert.equal(custom.claims.role, 'crew');

  hub.clock.now = at(45);
  const deactivated = await hub.review('rejected', 'jamier');
  assert.equal(deactivated.account.status, 'rejected');
  assert.deepEqual(deactivated.firebaseRevocation, { status: 'revoked' });
  assert.deepEqual(hub.revoke.calls[1], { uid: 'hub:jamier', validSince: seconds(at(45)) + 1 });
  assert.equal(await verifyHubSessionToken(hub.env, token), null, 'the Hub session ends with the same change');
  const refused = await hub.mint(token);
  assert.equal(refused.status, 401, 'a deactivated employee cannot mint a new Firebase session');
  assert.equal((await refused.json()).code, 'HUB_AUTH_REQUIRED');

  hub.clock.now = at(50);
  assert.deepEqual((await hub.review('rejected')).firebaseRevocation, { status: 'not_needed' });
  assert.equal(hub.revoke.calls.length, 2);
  const state = hub.store.peek();
  assert.equal(state.verifiedAt, after(NOW));
  assert.deepEqual([state.pending, state.intents], [[], []], 'every review settled the intent it recorded first');
  assert.deepEqual(state.revoked, [{ uid: 'hub:jamier', through: after(at(45)) }]);
  assert.ok(hub.storage.hosts.every(host => host === 'firestore.googleapis.com'));
});

test('rejecting a pending application revokes; approving a rejected one revokes again; validSince is read after the change is saved', async t => {
  const hub = await hubFixture(t);
  await hub.register();
  hub.clock.now = at(5);
  // The account write lands 2.4 s after the review started. A session minted
  // before it landed, even in the same second, must end with the change.
  const landed = new Date(Date.parse(at(5)) + 2400).toISOString();
  hub.storage.onWrite = () => { hub.clock.now = landed; };
  const rejected = await hub.review('rejected');
  hub.storage.onWrite = null;
  assert.deepEqual(rejected.firebaseRevocation, { status: 'revoked' });
  assert.equal(firebaseRevocationTime(new Date(landed)), after(landed));
  hub.clock.now = at(9);
  assert.deepEqual((await hub.review('approved')).firebaseRevocation, { status: 'revoked' });
  assert.deepEqual(hub.revoke.calls, [{ uid: 'hub:jamier', validSince: seconds(landed) + 1 }, { uid: 'hub:jamier', validSince: seconds(at(9)) + 1 }]);
  assert.equal(seconds(landed) + 1, seconds(at(5)) + 3, 'not the review clock read before the write');
});

test('refused reviews never call Identity Toolkit or leave work queued; a review whose save cannot be confirmed revokes anyway', async t => {
  const hub = await hubFixture(t);
  await hub.register();
  const refused = [
    [{ action: 'review', username: 'JamieR', decision: 'approved' }, hub.crew, 403],
    [{ action: 'review', username: 'JamieR', decision: 'approved' }, '', 401],
    [{ action: 'review', username: 'JamieR', decision: 'suspend' }, hub.owner, 400],
    [{ action: 'review', username: 'NobodySynthetic', decision: 'rejected' }, hub.owner, 400],
    [{ action: 'review', username: 'ZacB', decision: 'rejected' }, hub.owner, 400],
  ];
  for (const [body, cookie, status] of refused) assert.equal((await hub.post(body, cookie)).status, status, JSON.stringify(body));
  assert.equal(hub.revoke.calls.length, 0);
  assert.deepEqual([hub.store.peek().pending, hub.store.peek().intents], [[], []], 'the intent recorded before a refused review is dropped');

  // The account write lands but its response is lost. The review answers 502
  // and a repeat review sees no change, so the revocation happens now.
  // (Deliberate change from the first SEC-13 version, which made no call here.)
  hub.clock.now = at(3);
  hub.storage.loseWriteResponses = true;
  const unconfirmed = await hub.post({ action: 'review', username: ' JamieR ', decision: 'rejected' }, hub.owner);
  hub.storage.loseWriteResponses = false;
  assert.equal(unconfirmed.status, 502);
  assert.equal('firebaseRevocation' in await unconfirmed.json(), false);
  assert.deepEqual(hub.revoke.calls, [{ uid: 'hub:jamier', validSince: seconds(at(3)) + 1 }]);
  hub.clock.now = at(4);
  assert.deepEqual((await hub.review('rejected')).firebaseRevocation, { status: 'not_needed' }, 'the change had been saved');
  // A write that failed outright is revoked too: the route cannot tell the two apart.
  hub.storage.failWrites = true;
  assert.equal((await hub.post({ action: 'review', username: 'JamieR', decision: 'approved' }, hub.owner)).status, 502);
  assert.deepEqual(hub.revoke.calls.at(-1), { uid: 'hub:jamier', validSince: seconds(at(4)) + 1 });
  assert.equal(hub.revoke.calls.length, 2);
  const state = hub.store.peek();
  assert.deepEqual([state.pending, state.intents], [[], []]);
});

test('a missing IAM grant keeps the account change, surfaces revocation pending to business users, and clears after the grant', async t => {
  let iam = false;
  const hub = await hubFixture(t, uid => iam ? 'revoked' : denied());
  await hub.register();
  assert.equal((await hub.review('approved')).firebaseRevocation.status, 'revocation_pending');
  const token = await hub.signIn();
  hub.clock.now = at(2);
  const response = await hub.review('rejected');
  assert.equal(response.account.status, 'rejected', 'the account change succeeded');
  assert.equal(response.firebaseRevocation.status, 'revocation_pending');
  assert.equal(response.firebaseRevocation.error, 'permission_denied');
  assert.match(response.firebaseRevocation.message, /retries on the next Hub load, at most every 15 minutes.*Firebase Authentication Admin/);
  assert.doesNotMatch(JSON.stringify(response), /sk_live|synthetic provider detail/);
  assert.equal(await verifyHubSessionToken(hub.env, token), null);
  assert.equal((await hub.mint(token)).status, 401);
  assert.deepEqual(hub.store.peek().pending, [{ uid: 'hub:jamier', reason: 'account_status', requestedAt: after(at(2)), attempts: 2, lastAttemptAt: after(at(2)), lastError: 'permission_denied' }]);
  assert.deepEqual(hub.store.peek().intents, [], 'the failure is queued at the revocation time and the intent settled');

  const before = hub.factories.calls;
  const crewStatus = await hub.readiness(hub.crew);
  assert.equal(hub.factories.calls, before, 'crew readiness never touches revocation state');
  assert.equal(Object.keys(crewStatus).some(key => key.startsWith('firebaseRevocation')), false);

  const pending = await hub.readiness();
  assert.equal(pending.employeeAccounts, true, 'the other readiness fields are unchanged');
  assert.deepEqual(revocationFields(pending), summary('revocation_pending', 1, 'permission_denied'));
  const calls = hub.revoke.calls.length;

  hub.clock.now = at(10);
  iam = true;
  assert.equal((await hub.readiness()).firebaseRevocationState, 'revocation_pending');
  assert.equal(hub.revoke.calls.length, calls, 'no retry inside the retry window');

  hub.clock.now = at(18);
  const background = [];
  const deferred = await hub.readiness(undefined, background);
  assert.equal(deferred.firebaseRevocationState, 'revocation_pending', 'the response does not wait for the retry');
  assert.equal(background.length, 1);
  assert.deepEqual(await background[0], summary('verified', 0));
  assert.deepEqual(hub.revoke.calls.at(-1), { uid: 'hub:jamier', validSince: seconds(at(2)) + 1 }, 'the retry ends sessions from before the change, not later ones');
  assert.deepEqual(revocationFields(await hub.readiness()), summary('verified', 0));
});

test('without a real service account the review still succeeds and reports revocation as not configured', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const storage = accountStorage(t);
  const env = { HUB_SESSION_SECRET: 'synthetic-default-session', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-default-vault', FIREBASE_API_KEY: 'firebase-test-default',
    HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'unused-synthetic-owner-hash', role: 'owner' } }) };
  const owner = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const post = (body, cookie) => accounts.onRequestPost({ env, request: new Request(`${origin}/api/employee-accounts`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }) });
  assert.equal((await post({ action: 'register', acknowledged: true, username: 'JamieR', firstName: 'Synthetic', lastName: 'Employee', email: 'jamie@example.invalid', phone: '9705550142', password: 'SyntheticPass904' })).status, 201);
  const response = await post({ action: 'review', username: 'JamieR', decision: 'approved' }, owner);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.account.status, 'approved');
  assert.equal(body.firebaseRevocation.status, 'not_configured');
  assert.equal(storage.documents.size, 1, 'nothing but the account was written');
  assert.deepEqual(await revokeStaffFirebaseSessions(null, ['JamieR'], 'account_status', NOW), body.firebaseRevocation);
});

test('a revocation result is never reported as success when it could not be recorded', async () => {
  const store = memoryStore();
  store.failCommits = true;
  const failing = createFirebaseRevocationService({ store, revoke: revoker(() => denied()) });
  const unrecorded = await failing.revokeStaff(['JamieR'], 'account_status', NOW);
  assert.equal(unrecorded.status, 'revocation_failed');
  assert.match(unrecorded.message, /could not be confirmed or queued/);
  const working = createFirebaseRevocationService({ store, revoke: revoker() });
  assert.deepEqual(await working.revokeStaff(['JamieR'], 'account_status', NOW), { status: 'revoked' }, 'the provider call itself succeeded');
  // An unreadable record is not overwritten, and the failure is not hidden.
  const corrupt = memoryStore();
  corrupt.put({ pending: 'not-a-list' });
  const service = createFirebaseRevocationService({ store: corrupt, revoke: revoker(() => denied()) });
  assert.equal((await service.revokeStaff(['JamieR'], 'account_status', NOW)).status, 'revocation_failed');
  assert.equal(corrupt.calls.commits, 0);
  assert.deepEqual(await firebaseRevocationStatus(service, () => staff, NOW), summary('unavailable', null));
  assert.equal(corrupt.calls.commits, 0);
  // A malformed clock, reason or user list is refused before any provider call.
  const clockless = revoker();
  const fresh = createFirebaseRevocationService({ store: memoryStore(), revoke: clockless });
  for (const [users, reason, now] of [[['JamieR'], 'account_status', 'yesterday'], [['JamieR'], 'mystery', NOW], ['JamieR', 'account_status', NOW]]) {
    assert.equal((await revokeStaffFirebaseSessions(fresh, users, reason, now)).status, 'revocation_failed');
  }
  assert.equal(clockless.calls.length, 0);
});

test('malformed revocation records are rejected instead of read as empty', () => {
  const base = { pending: [], intents: [], revoked: [], staticRoster: null, verifiedAt: '', probedAt: '', probeError: '' };
  assert.deepEqual(decodeFirebaseRevocationState(null), { revision: undefined, ...base });
  const entry = { uid: 'hub:jamier', reason: 'account_status', requestedAt: NOW, attempts: 1, lastAttemptAt: NOW, lastError: 'permission_denied' };
  assert.equal(decodeFirebaseRevocationState({ ...base, pending: [entry], revision: 'r1' }).pending[0].uid, 'hub:jamier');
  // intents and revoked are optional additions: a record written without them reads as having none.
  const { intents, revoked, ...legacy } = base;
  assert.deepEqual(decodeFirebaseRevocationState({ ...legacy, pending: [entry] }), { revision: undefined, ...base, pending: [entry] });
  const intent = { uid: 'hub:jamier', reason: 'account_status', at: NOW }, done = { uid: 'hub:jamier', through: NOW };
  assert.deepEqual(decodeFirebaseRevocationState({ ...base, intents: [intent, { ...intent, at: at(1) }], revoked: [done] }).intents.length, 2);
  for (const bad of [
    'text', { ...base, pending: {} }, { ...base, pending: [{ ...entry, reason: 'other' }] }, { ...base, pending: [{ ...entry, attempts: -1 }] },
    { ...base, pending: [{ ...entry, requestedAt: 'soon' }] }, { ...base, pending: [{ ...entry, lastError: 'provider text' }] }, { ...base, pending: [entry, entry] },
    { ...base, pending: [{ ...entry, uid: '' }] }, { ...base, staticRoster: 'x' }, { ...base, staticRoster: [{ uid: 'hub:a' }] },
    { ...base, staticRoster: [{ uid: 'hub:a', fingerprint: 'crew|false' }, { uid: 'hub:a', fingerprint: 'crew|false' }] }, { ...base, verifiedAt: 'yes' }, { ...base, probeError: 'raw' },
    { ...base, intents: {} }, { ...base, intents: [intent, intent] }, { ...base, intents: [{ ...intent, at: 'later' }] }, { ...base, intents: [{ ...intent, reason: 'other' }] },
    { ...base, revoked: 'x' }, { ...base, revoked: [done, done] }, { ...base, revoked: [{ uid: 'hub:jamier' }] }, { ...base, revoked: [{ ...done, uid: '' }] },
  ]) assert.throws(() => decodeFirebaseRevocationState(bad), { code: 'firebase_revocation_state_unreadable' }, JSON.stringify(bad));
});

test('removed or re-roled static staff are revoked; additions and an unchanged roster cost nothing', async () => {
  const store = memoryStore();
  const revoke = revoker(uid => uid === FIREBASE_REVOCATION_PROBE_UID ? 'no_firebase_user' : 'revoked');
  const service = createFirebaseRevocationService({ store, revoke });
  assert.deepEqual(await service.maintain(staff, NOW), summary('verified', 0));
  assert.deepEqual(revoke.calls, [{ uid: FIREBASE_REVOCATION_PROBE_UID, validSince: seconds(NOW) }], 'the first pass records the roster and proves the grant; nobody is signed out');
  assert.deepEqual(store.peek().staticRoster, staticStaffRoster(staff));

  const known = store.peek(), before = { ...store.calls };
  assert.equal((await service.maintain(staff, at(60), known)).firebaseRevocationState, 'verified');
  assert.deepEqual(store.calls, before, 'no reads or writes when nothing changed');
  assert.equal(revoke.calls.length, 1);

  const changed = [staff[0], { ...staff[1], role: 'crew' }, { user: 'SyntheticNew', role: 'crew', businessAccess: false }];
  await service.maintain(changed, at(61));
  assert.deepEqual(revoke.calls.slice(1), [{ uid: 'hub:syntheticcrew', validSince: seconds(at(61)) }, { uid: 'hub:syntheticlead', validSince: seconds(at(61)) }]);
  assert.deepEqual(store.peek().staticRoster, staticStaffRoster(changed));
  assert.deepEqual(store.peek().pending, []);

  // Losing business access is a change even with the same role.
  await service.maintain([{ ...changed[0], businessAccess: false }, ...changed.slice(1)], at(62));
  assert.deepEqual(revoke.calls.at(-1), { uid: 'hub:zacb', validSince: seconds(at(62)) });
});

test('a static removal that cannot be revoked is queued in the same write that updates the roster', async () => {
  const store = memoryStore();
  const service = createFirebaseRevocationService({ store, revoke: revoker(uid => uid === 'hub:syntheticcrew' ? denied() : 'no_firebase_user') });
  await service.maintain(staff, NOW);
  const commits = store.calls.commits;
  assert.deepEqual(await service.maintain(staff.slice(0, 2), at(1)), summary('revocation_pending', 1, 'permission_denied'));
  assert.equal(store.calls.commits, commits + 1);
  const state = store.peek();
  assert.deepEqual(state.staticRoster.map(entry => entry.uid), ['hub:syntheticlead', 'hub:zacb']);
  assert.deepEqual(state.pending, [{ uid: 'hub:syntheticcrew', reason: 'static_removed', requestedAt: at(1), attempts: 1, lastAttemptAt: at(1), lastError: 'permission_denied' }]);
});

test('pending revocations retry only after the retry window, with the time of the original change, and a later success clears them', async () => {
  const store = memoryStore();
  let answer = () => coded('firebase_revocation_unavailable');
  const revoke = revoker((...args) => answer(...args));
  const service = createFirebaseRevocationService({ store, revoke });
  const first = await service.revokeStaff(['JamieR'], 'account_status', NOW);
  assert.deepEqual([first.status, first.error], ['revocation_pending', 'unavailable']);
  await service.maintain([], at(1));
  await service.maintain([], at(14));
  assert.equal(revoke.calls.length, 1, 'the first pass only records the roster; nothing is due yet');
  await service.maintain([], new Date(Date.parse(NOW) + FIREBASE_REVOCATION_RETRY_MS).toISOString());
  assert.deepEqual(revoke.calls.at(-1), { uid: 'hub:jamier', validSince: seconds(NOW) });
  assert.deepEqual(store.peek().pending, [{ uid: 'hub:jamier', reason: 'account_status', requestedAt: NOW, attempts: 2, lastAttemptAt: at(15), lastError: 'unavailable' }]);
  answer = () => 'revoked';
  assert.deepEqual(await service.maintain([], at(31)), summary('verified', 0));
  assert.deepEqual(revoke.calls.at(-1), { uid: 'hub:jamier', validSince: seconds(NOW) });
  assert.deepEqual(store.peek().pending, []);
});

test('a concurrent change is merged on fresh state: newer queued work survives an older success and the provider is called once', async () => {
  const entry = (requestedAt, lastAttemptAt = requestedAt) => ({ uid: 'hub:jamier', reason: 'account_status', requestedAt, attempts: 1, lastAttemptAt, lastError: 'unavailable' });
  for (const staleCode of ['dispatch_revision_conflict', 'dispatch_outcome_unknown']) {
    const store = memoryStore(staleCode), revoke = revoker();
    const service = createFirebaseRevocationService({ store, revoke });
    store.put(stateValue({ pending: [entry(NOW)] }));
    store.beforeCommit = () => store.put(stateValue({ pending: [entry(at(2))] }));
    assert.deepEqual(await service.revokeStaff(['JamieR'], 'account_status', at(1)), { status: 'revoked' }, staleCode);
    assert.equal(revoke.calls.length, 1, 'the conflict is resolved without a second provider call');
    assert.deepEqual(store.peek().pending, [entry(at(2))], 'work requested after this success is kept');
    assert.deepEqual(await service.revokeStaff(['JamieR'], 'account_status', at(3)), { status: 'revoked' });
    assert.deepEqual(store.peek().pending, [], 'work requested before a success is cleared');
    // A failed call is still recorded after the conflict, merged with the other writer's work.
    const failing = memoryStore(staleCode), failService = createFirebaseRevocationService({ store: failing, revoke: revoker(() => denied()) });
    failing.put(stateValue());
    failing.beforeCommit = () => failing.put(stateValue({ pending: [{ ...entry(NOW), uid: 'hub:other' }] }));
    assert.equal((await failService.revokeStaff(['JamieR'], 'account_status', at(1))).status, 'revocation_pending', staleCode);
    assert.deepEqual(failing.peek().pending.map(item => [item.uid, item.requestedAt]), [['hub:jamier', at(1)], ['hub:other', NOW]]);
  }
  // Two first writers racing to create the record: the loser re-reads and merges.
  const creating = memoryStore(), createService = createFirebaseRevocationService({ store: creating, revoke: revoker(() => denied()) });
  creating.beforeCommit = () => creating.put(stateValue({ verifiedAt: '', pending: [{ ...entry(NOW), uid: 'hub:other' }] }));
  assert.equal((await createService.revokeStaff(['JamieR'], 'account_status', at(1))).status, 'revocation_pending');
  assert.deepEqual(creating.peek().pending.map(item => item.uid), ['hub:jamier', 'hub:other']);

  // A retry covers only the change it was queued for: a newer change queued
  // while it ran stays pending until a call covers its own time.
  const retrying = memoryStore(), retried = revoker();
  const retryService = createFirebaseRevocationService({ store: retrying, revoke: retried });
  retrying.put(stateValue({ pending: [entry(NOW)] }));
  retrying.beforeCommit = () => retrying.put(stateValue({ pending: [entry(at(19))] }));
  assert.deepEqual(await retryService.maintain([], at(20), retrying.peek()), summary('revocation_pending', 1, 'unavailable'));
  assert.deepEqual(retried.calls, [{ uid: 'hub:jamier', validSince: seconds(NOW) }]);
  assert.deepEqual(retrying.peek().pending, [entry(at(19))]);
  await retryService.maintain([], at(40));
  assert.deepEqual(retried.calls.at(-1), { uid: 'hub:jamier', validSince: seconds(at(19)) });
  assert.deepEqual(retrying.peek().pending, []);

  // A roster entry another request recorded is queued, never silently dropped.
  const racing = memoryStore();
  const racingService = createFirebaseRevocationService({ store: racing, revoke: revoker() });
  racing.put(stateValue({ staticRoster: staticStaffRoster(staff) }));
  racing.beforeCommit = () => racing.put(stateValue({ staticRoster: [...staticStaffRoster(staff), { uid: 'hub:ghost', fingerprint: 'crew|false' }] }));
  await racingService.maintain(staff.slice(0, 2), at(3));
  assert.deepEqual(racing.peek().staticRoster, staticStaffRoster(staff.slice(0, 2)));
  assert.deepEqual(racing.peek().pending, [{ uid: 'hub:ghost', reason: 'static_removed', requestedAt: at(3), attempts: 0, lastAttemptAt: '', lastError: '' }]);
});

test('each pass makes at most three Identity Toolkit calls and queues the rest as due immediately', async () => {
  assert.equal(FIREBASE_REVOCATION_MAX_CALLS, 3);
  const store = memoryStore();
  const revoke = revoker();
  const service = createFirebaseRevocationService({ store, revoke });
  const many = Array.from({ length: 5 }, (_, index) => ({ user: `SyntheticCrew${String(index).padStart(2, '0')}`, role: 'crew', businessAccess: false }));
  store.put(stateValue({ staticRoster: staticStaffRoster(many) }));
  assert.deepEqual(await service.maintain([], at(1)), summary('revocation_pending', 2));
  assert.equal(revoke.calls.length, 3);
  assert.deepEqual(store.peek().pending.map(entry => [entry.uid, entry.attempts, entry.lastAttemptAt]), [['hub:syntheticcrew03', 0, ''], ['hub:syntheticcrew04', 0, '']]);
  assert.deepEqual(store.peek().staticRoster, []);
  await service.maintain([], at(2));
  assert.deepEqual(revoke.calls.slice(3), [{ uid: 'hub:syntheticcrew03', validSince: seconds(at(1)) }, { uid: 'hub:syntheticcrew04', validSince: seconds(at(1)) }]);
  assert.deepEqual(store.peek().pending, []);
});

test('an unproven IAM grant reads as unverified, a denied probe is surfaced, and the probe repeats hourly', async () => {
  const store = memoryStore();
  let answer = () => denied();
  const revoke = revoker((...args) => answer(...args));
  const service = createFirebaseRevocationService({ store, revoke });
  assert.deepEqual(await service.maintain(staff, NOW), summary('unverified', 0, 'permission_denied'));
  assert.equal(store.peek().probeError, 'permission_denied');
  await service.maintain(staff, at(30));
  assert.equal(revoke.calls.length, 1);
  answer = () => 'no_firebase_user';
  const retried = await service.maintain(staff, new Date(Date.parse(NOW) + FIREBASE_REVOCATION_PROBE_MS).toISOString());
  assert.deepEqual(retried, summary('verified', 0));
  assert.ok(revoke.calls.every(call => call.uid === FIREBASE_REVOCATION_PROBE_UID));
  await service.maintain(staff, at(200));
  assert.equal(revoke.calls.length, 2, 'no probing after the grant is proven');
});

test('integration status reports not configured or unavailable, never clear, when revocation cannot be checked', async () => {
  assert.deepEqual(await firebaseRevocationStatus(null, () => staff, NOW), summary('not_configured', null));
  const store = memoryStore();
  store.failReads = true;
  const revoke = revoker();
  assert.deepEqual(await firebaseRevocationStatus(createFirebaseRevocationService({ store, revoke }), () => staff, NOW), summary('unavailable', null));
  assert.equal(revoke.calls.length, 0);
  // A staff configuration that cannot be read (one bad HUB_AUTH_USERS_JSON
  // record, or two entries for one person) means removed staff are not being
  // revoked: that is never reported as working, and pending retries still run.
  const healthyStore = memoryStore();
  healthyStore.put(stateValue({ staticRoster: staticStaffRoster(staff), pending: [{ uid: 'hub:jamier', reason: 'account_status', requestedAt: NOW, attempts: 1, lastAttemptAt: NOW, lastError: 'unavailable' }] }));
  const healthy = createFirebaseRevocationService({ store: healthyStore, revoke });
  const broken = { firebaseRevocation: false, firebaseRevocationState: 'unavailable', firebaseRevocationPending: 0, firebaseRevocationError: 'staff_config' };
  assert.deepEqual(await firebaseRevocationStatus(healthy, () => { throw new Error('bad staff config'); }, at(16)), broken);
  assert.deepEqual(revoke.calls, [{ uid: 'hub:jamier', validSince: seconds(NOW) }]);
  assert.deepEqual(healthyStore.peek().staticRoster, staticStaffRoster(staff), 'the snapshot is kept, never read as everyone removed');
  assert.deepEqual(await firebaseRevocationStatus(healthy, () => [...staff, { user: 'zacb', role: 'crew' }], at(17)), broken);
  assert.equal(revoke.calls.length, 1);
  const background = [];
  assert.deepEqual(await firebaseRevocationStatus(healthy, () => { throw new Error('bad staff config'); }, at(18), { defer: work => background.push(work) }), broken, 'answered before maintenance too');
  assert.equal(background.length, 1);
  await background[0];
});

test('a slow revocation state read answers unavailable within the timeout instead of holding the Hub render', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(FIREBASE_REVOCATION_READ_TIMEOUT_MS, 3000);
  const store = memoryStore(), revoke = revoker();
  store.read = () => new Promise(() => {});
  let settled = false;
  const status = firebaseRevocationStatus(createFirebaseRevocationService({ store, revoke }), () => staff, NOW).finally(() => { settled = true; });
  t.mock.timers.tick(FIREBASE_REVOCATION_READ_TIMEOUT_MS - 1);
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  for (let index = 0; index < 50; index++) await Promise.resolve();
  assert.equal(settled, true, 'answered at the timeout');
  assert.deepEqual(await status, summary('unavailable', null));
  assert.equal(revoke.calls.length, 0);
});

test('the caller deadline of an Identity Toolkit or Firestore call also bounds its OAuth token exchange', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  // Its own credential, so no token cached by another test is reused.
  const env = { FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccount('synthetic-deadline', generateKeyPairSync('rsa', { modulusLength: 2048 })) };
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    assert.equal(new URL(String(input)).hostname, 'oauth2.googleapis.com', 'nothing is sent without a token');
    signals.push(init.signal);
    if (!init.signal) throw new Error('no caller deadline reached the token exchange');
    // A token endpoint that answers only when the caller gives up.
    if (init.signal.aborted) throw init.signal.reason;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(identityToolkitFetch(env, ACCOUNTS_UPDATE, { method: 'POST', body: '{}', signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(firestoreFetch(env, 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/firebaseSessionRevocations/state', { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(signals, [controller.signal, controller.signal]);
});

test('a review whose request stops after the change is saved is still revoked from its recorded intent, at a time after the change', async t => {
  const hub = await hubFixture(t);
  await hub.register();
  assert.deepEqual((await hub.review('approved')).firebaseRevocation, { status: 'revoked' });
  hub.clock.now = at(1);
  // The worker stops (client gone, isolate ended) after the account write
  // landed and before its revocation call.
  const revokeStaff = hub.service.revokeStaff;
  const stopped = new Promise(resolve => { hub.service.revokeStaff = () => { resolve(); return new Promise(() => {}); }; });
  hub.post({ action: 'review', username: 'JamieR', decision: 'rejected' }, hub.owner);
  await stopped;
  hub.service.revokeStaff = revokeStaff;
  assert.equal(hub.revoke.calls.length, 1, 'the stopped request made no call');
  assert.deepEqual(hub.store.peek().intents, [{ uid: 'hub:jamier', reason: 'account_status', at: at(1) }]);
  assert.deepEqual(revocationFields(await hub.readiness()), summary('revocation_pending', 1), 'the owed revocation shows as pending at once');
  hub.clock.now = at(10);
  assert.deepEqual(revocationFields(await hub.readiness()), summary('revocation_pending', 1));
  assert.equal(hub.revoke.calls.length, 1, 'not while the request could still be running');
  hub.clock.now = at(16);
  assert.deepEqual(revocationFields(await hub.readiness()), summary('verified', 0));
  // The change landed at some unknown time after at(1); this pass's time is after it.
  assert.deepEqual(hub.revoke.calls.at(-1), { uid: 'hub:jamier', validSince: seconds(at(16)) });
  assert.deepEqual(hub.store.peek().intents, []);
});

test('when neither the call nor its result can be saved, the intent recorded first keeps the revocation owed and visible', async t => {
  let first = true, iam = false, hub;
  hub = await hubFixture(t, () => {
    if (first) { first = false; hub.store.failCommits = true; }
    return iam ? 'revoked' : denied();
  });
  await hub.register();
  const response = await hub.review('approved');
  hub.store.failCommits = false;
  assert.equal(response.account.status, 'approved');
  assert.equal(response.firebaseRevocation.status, 'revocation_pending', 'queued by its intent, not lost');
  assert.deepEqual(hub.store.peek().intents, [{ uid: 'hub:jamier', reason: 'account_status', at: NOW }]);
  assert.equal((await hub.readiness()).firebaseRevocationState, 'revocation_pending', 'Integrations does not read as configured');
  hub.clock.now = at(16);
  iam = true;
  assert.deepEqual(revocationFields(await hub.readiness()), summary('verified', 0));
  assert.deepEqual(hub.revoke.calls.filter(call => call.uid === 'hub:jamier'), [{ uid: 'hub:jamier', validSince: seconds(NOW) + 1 }, { uid: 'hub:jamier', validSince: seconds(at(16)) }]);
  assert.deepEqual([hub.store.peek().pending, hub.store.peek().intents], [[], []]);
});

test('validSince never moves backwards: a stale retry is not sent after a newer revocation, and an older failure never replaces newer queued work', async () => {
  const entry = (requestedAt, lastAttemptAt = requestedAt) => ({ uid: 'hub:jamier', reason: 'account_status', requestedAt, attempts: 1, lastAttemptAt, lastError: 'unavailable' });
  // Maintenance works from state read before its response. A newer
  // revocation succeeds before the retry runs (12:20), so the queued 12:00
  // retry is not sent.
  const store = memoryStore(), revoke = revoker();
  const service = createFirebaseRevocationService({ store, revoke });
  store.put(stateValue({ pending: [entry(NOW)] }));
  const known = store.peek();
  assert.deepEqual(await service.revokeStaff(['JamieR'], 'account_status', at(20)), { status: 'revoked' });
  assert.deepEqual(await service.maintain([], at(21), known), summary('verified', 0));
  assert.deepEqual(revoke.calls.map(call => call.validSince), [seconds(at(20))]);
  assert.deepEqual(store.peek().revoked, [{ uid: 'hub:jamier', through: at(20) }]);
  // A retry whose time a remembered success already covers is cleared without a call.
  const covered = memoryStore(), coveredRevoke = revoker();
  covered.put(stateValue({ pending: [entry(NOW)], revoked: [{ uid: 'hub:jamier', through: at(20) }] }));
  assert.deepEqual(await createFirebaseRevocationService({ store: covered, revoke: coveredRevoke }).maintain([], at(21)), summary('verified', 0));
  assert.equal(coveredRevoke.calls.length, 0);
  // A retry re-read on fresh state sends the latest queued time.
  const requeued = memoryStore(), requeuedRevoke = revoker();
  requeued.put(stateValue({ pending: [entry(NOW)] }));
  const stale = requeued.peek();
  requeued.put(stateValue({ pending: [entry(at(4), NOW)] }));
  await createFirebaseRevocationService({ store: requeued, revoke: requeuedRevoke }).maintain([], at(21), stale);
  assert.deepEqual(requeuedRevoke.calls, [{ uid: 'hub:jamier', validSince: seconds(at(4)) }]);
  // An older request failing concurrently keeps the newer queued time (12:10, not 12:05).
  const failing = revoker(() => coded('firebase_revocation_unavailable'));
  const queued = memoryStore();
  queued.put(stateValue({ pending: [entry(at(10))] }));
  await createFirebaseRevocationService({ store: queued, revoke: failing }).revokeStaff(['JamieR'], 'account_status', at(5));
  assert.equal(queued.peek().pending[0].requestedAt, at(10));
  // An older failure saved after a newer success is already covered, so nothing is queued.
  const late = memoryStore();
  late.put(stateValue({ revoked: [{ uid: 'hub:jamier', through: at(10) }] }));
  await createFirebaseRevocationService({ store: late, revoke: failing }).revokeStaff(['JamieR'], 'account_status', at(5));
  assert.deepEqual(late.peek().pending, []);
  // A remembered success is kept for a day, then dropped on the next save.
  await service.revokeStaff(['SyntheticCrew'], 'account_status', at(20 + 24 * 60 + 1));
  assert.deepEqual(store.peek().revoked, [{ uid: 'hub:syntheticcrew', through: at(20 + 24 * 60 + 1) }]);
});

test('only the production host reconciles the staff roster; previews and local servers still retry pending work', async t => {
  for (const url of ['https://easygaragecleaning.com/api/integration-status', 'https://www.easygaragecleaning.com/x', 'https://easy-garage-cleaning.pages.dev/x']) assert.equal(reconcilesStaffRoster(url), true, url);
  for (const url of ['https://feature-x.easy-garage-cleaning.pages.dev/x', 'https://3f2a1b.easy-garage-cleaning.pages.dev/x', 'http://localhost:8788/x', 'http://127.0.0.1:8788/x', 'https://easygaragecleaning.com.example.invalid/x', 'not a url']) {
    assert.equal(reconcilesStaffRoster(url), false, url);
  }
  const hub = await hubFixture(t);
  await hub.readiness();
  const roster = hub.store.peek().staticRoster;
  assert.deepEqual(roster.map(entry => entry.uid), ['hub:syntheticcrew', 'hub:zacb']);
  hub.store.put(stateValue({ staticRoster: roster, pending: [{ uid: 'hub:jamier', reason: 'account_status', requestedAt: NOW, attempts: 1, lastAttemptAt: NOW, lastError: 'unavailable' }] }));
  // A preview (or wrangler pages dev) holding the production service account
  // with its own staff configuration, where SyntheticCrew does not exist.
  const preview = { ...hub.env, HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'unused-synthetic-owner-hash', role: 'owner', displayName: 'Synthetic Owner' } }) };
  hub.clock.now = at(16);
  for (const base of ['https://feature-x.easy-garage-cleaning.pages.dev', 'http://localhost:8788']) {
    assert.deepEqual(revocationFields(await hub.readiness(hub.owner, null, base, preview)), summary('verified', 0), base);
  }
  assert.deepEqual(hub.revoke.calls.filter(call => call.uid !== FIREBASE_REVOCATION_PROBE_UID), [{ uid: 'hub:jamier', validSince: seconds(NOW) }], 'the pending retry ran; production staff were not revoked');
  assert.deepEqual(hub.store.peek().staticRoster, roster);
  // The same configuration served by production is a real removal.
  await hub.readiness(hub.owner, null, origin, preview);
  assert.deepEqual(hub.revoke.calls.at(-1), { uid: 'hub:syntheticcrew', validSince: seconds(at(16)) });
});

function hubSuite(fetcher = async () => { throw new Error('Unexpected request'); }) {
  const values = new Map(Object.entries({ egc_u: 'ZacB', egc_business_access: 'true', egc_owner: 'true', egc_role: 'owner' }));
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const toasts = [];
  const context = {
    console, URLSearchParams, Date, Intl, Promise, Set, Map, Error, me: 'ZacB', jobsCache: [], sessionStorage: storage, localStorage: storage,
    navigator: {}, location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    document: { readyState: 'loading', activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    FormData: class { forEach() {} }, hubFetch: fetcher, showToast: message => toasts.push(message),
  };
  context.window = context;
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.ui={S,views};})();');
  vm.runInNewContext(source, context);
  return { context, toasts, ...context.ui };
}

test('the Hub integrations panel shows Firebase sign-out as needing setup until revocation is verified', () => {
  const { S, views } = hubSuite();
  const badge = () => views.settings().match(/<strong>Firebase sign-out<\/strong>.*?<\/article>/)[0];
  S.integrationState.loaded = true;
  S.integrationState.error = '';
  for (const state of ['revocation_pending', 'unverified', 'unavailable', 'not_configured']) {
    S.integrations = { firebaseRevocation: false, firebaseRevocationState: state };
    assert.match(badge(), /Needs setup/, state);
    assert.match(badge(), /Firebase Authentication Admin/);
  }
  S.integrations = summary('revocation_pending', 2, 'permission_denied');
  assert.match(badge(), /2 staff sign-outs pending · server account lacks permission · retries on the next Hub load, at most every 15 minutes/);
  S.integrations = summary('revocation_pending', 1, 'unavailable');
  assert.match(badge(), /1 staff sign-out pending · retries on the next Hub load, at most every 15 minutes/);
  S.integrations = { ...summary('unavailable', 0, 'staff_config'), firebaseRevocation: false };
  assert.match(badge(), /Staff configuration could not be read; removed or changed staff are not being signed out.*Needs setup/);
  S.integrations = summary('verified', 0);
  assert.match(badge(), /Configured/);
  assert.match(badge(), /Removed or changed staff lose Firebase data access; pending sign-outs retry on the next Hub load, at most every 15 minutes/);
  S.integrationState.error = 'offline';
  assert.match(badge(), /Could not check/);
});

test('an account review tells the owner when Firebase sign-out is pending and refreshes the integrations state', async () => {
  const collections = Object.fromEntries(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'].map(name => [name, []]));
  const reply = body => ({ ok: true, status: 200, json: async () => body });
  const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  for (const [signOut, toast, readinessReads] of [
    [{ status: 'revocation_pending', error: 'permission_denied', message: 'synthetic' }, /^Account request rejected\. Firebase sign-out is pending; see Integrations\.$/, 1],
    [{ status: 'revocation_failed', message: 'synthetic' }, /^Account request rejected\. Firebase sign-out could not be confirmed; check Integrations\.$/, 1],
    [{ status: 'revoked' }, /^Account request rejected$/, 0],
  ]) {
    let reads = 0;
    const ui = hubSuite(async (url, options = {}) => {
      if (options.method === 'POST') return reply({ ok: true, account: { username: 'JamieR', status: 'rejected' }, firebaseRevocation: signOut });
      if (url.includes('integration-status')) { reads++; return reply({ ok: true, status: summary('revocation_pending', 1, 'permission_denied') }); }
      if (url.includes('employee-accounts')) return reply({ ok: true, accounts: [{ username: 'JamieR', displayName: 'Synthetic Employee', status: 'rejected' }] });
      return reply({ ok: true, collections });
    });
    ui.S.accountState.loaded = true;
    ui.S.people.accounts = [{ username: 'JamieR', displayName: 'Synthetic Employee', status: 'approved' }];
    const reviewed = ui.context.opsReviewEmployeeAccount('JamieR', 'rejected');
    ui.context.opsActionSubmit({ preventDefault() {}, currentTarget: {} });
    await reviewed;
    await flush();
    assert.match(ui.toasts.at(-1), toast);
    assert.equal(reads, readinessReads);
    if (readinessReads) assert.equal(ui.S.integrations.firebaseRevocationState, 'revocation_pending');
  }
});
