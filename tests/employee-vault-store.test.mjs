import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EMPLOYEE_HUB_COLLECTIONS, expectedDocument, open, openStored, opaqueId, readAll, readCollection, readOne, seal, writeOne } from '../functions/_lib/employee-vault.js';
import { BUSINESS_USERS, OWNER_USERNAME } from '../functions/_lib/business-users.js';
import { createHubSessionCookie, getHubUserProfile, hashHubCredential, hasBusinessAccess, isHubOwner } from '../functions/_lib/hub-session.js';
import { isReservedEmployeeUsername } from '../functions/_lib/employee-accounts.js';
import { createStaffInvitationService, namedStaffRole, staffTokenHash } from '../functions/_lib/staff-invitation-service.js';
import { onRequestGet as employeeHubGet, readEmployeeTimecards } from '../functions/api/employee-hub.js';
import * as hubAuth from '../functions/api/hub-auth.js';
import * as employeeAccounts from '../functions/api/employee-accounts.js';
import { onRequestGet as gustoAuthGet } from '../functions/api/gusto-auth.js';
import { createGustoSyncHandlers } from '../functions/api/gusto-sync.js';
import { matchesWhere } from './helpers/firestore-query.mjs';

const NOW = '2026-09-22T12:00:00.000Z';
const SECRET = 'vault-store-test-data-key';
const env = { EMPLOYEE_HUB_DATA_SECRET: SECRET, FIREBASE_API_KEY: 'firebase-test-vault-store' };
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const unreadable = error => error?.code === 'EMPLOYEE_HUB_STORAGE_UNREADABLE';

// Captured from the pre-extraction functions/api/employee-hub.js (POST as the owner
// with EMPLOYEE_HUB_DATA_SECRET=SECRET). The new vault library must open them as-is.
const LEGACY = {
  timeEntries: {
    id: 'legacy-shift-1', documentId: 'secure_xmy4d46LJzeTZonr_dO8vwynY8y0gqW5gc3uXaC_KQ0', iv: 'dumbLnQxPr9W4puj', updatedAt: '2026-09-27T20:52:10.001Z',
    payload: '32LOA5dlDGsvLFFOGdfoPHoiAAcSc15mqGLI5_bb29RWRV9uVSrFGWk2Z0cX1xgMYmy363r16qfest6QWA8VrdlqEGEmQOvtzo7VSAxi8RHDKNsen5dJzA4vwRaQcH-eL0kZzWUzI8DySjiRTCLMe243gzr7OPfWZq4P_Otmzv3pYjf7JXhPIzSt7SZ-t6H91ixr9-zeYMjUrhnBTiVJaBI7iAUQiY0aPudUCijuUA63W0PoUNs4fb1Sk65Jxp2kN0GfrCdbYkk47useHExWywY88Dt4T55PUhN02JRNq1kycCt23SEmZBmUOX1cB9Eep-TQkr2O3_gbaoQlYVsJbzxpQSu-oVI9KUm4un8CmQemvVQQVWaDXlNR32Yu9GTnV_6QAiPh_EN-G4zguz9N1crXtcDqIpaolwM2ECeXFednllPqI0NQ4KUyh7l-cVrlh8nutHrgKPysfrW7hxi8fMGj9oTc2lInfVJp9OyPAqOWHUhHajv9DoxCc8On_UbBEiPHzkeLI33sNfvyE0D3ibTx8DeZWzYgKGgw6efduyCrdyx4NgBSOocJZIey5qgcoJ1IvwckiDQaDlGxSvjSF843TfLai9dOYR-4qX7Xwdi1ZOugpcmYvV9txTW0sYPev94OXljULF_el2fU7oi2zhxR98Z3g2Hl9O2GvR0s_lbfAM9Oxhcet1GNkcek7gykkfObBSLl7VLf00DpV6zqAsupo_JdYYWQaWbGXHGYsCrUzTEBTGwKYr38Zkmyz-6ozrY_N7DqMrvuVFKniyiGlm15Vq2iIiSTrc5Znt0JmhQVH82zzt6_NrnMdLMOVEvc2eiA_v1Lqbihjm750uWIxNsjYiBx-kf2IAPVUBEdh-15pgR8fBeRSL--v4tG1YLHZjXhOyKCaNK8ndmgLs4DeMAVr9HCHvbv0df4hjuq_SqnXOHxLqOGJ86nTpFd1-up2VPfx2SCHjx4PPnFuQoNABcwyoMvR5W-_AfNvGxpst8HQg',
  },
  announcements: {
    id: 'legacy-note-1', documentId: 'secure_bwIqKwWwTkWjgAg9eI7lyGRZVIT1ZDoSMhfRt0onQcE', iv: 'ZDoNDBjlvWe35YOS', updatedAt: '2026-09-27T20:52:10.006Z',
    payload: 'vYMC-Klc-yXc-_IHyYuI69F6vppiohM75B6DRKcq73UPVmolodsD8WrHRx5T42_69mP9zTvmdL2wlWuUT64bffdeEeK9jg3zpzAcHauvmlG9zaGf5JHdZa8YbV7geFrBXVyg9N7EFJvSfXlTHH47E3jbiqBeGMs35vWg_28',
  },
};
const sealedFields = (collection, { documentId, iv, payload, updatedAt }) => ({
  recordType: { stringValue: 'employee_hub_v2' }, employeeHubType: { stringValue: collection },
  sealedPayload: { stringValue: payload }, sealedIv: { stringValue: iv }, schemaVersion: { integerValue: '2' },
  updatedAt: { stringValue: updatedAt }, vaultId: { stringValue: documentId },
});
const legacySeed = () => Object.fromEntries(Object.entries(LEGACY).map(([collection, record]) => [
  `jobs/${record.documentId}`, { fields: sealedFields(collection, record), updateTime: '2026-09-21T23:05:01.000000Z' },
]));

// Independent re-implementation of the original vault crypto (not imported from it).
const encoder = new TextEncoder();
const b64url = bytes => Buffer.from(bytes).toString('base64url');
async function legacyId(secret, collection, id) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `secure_${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${collection}:${id}`))))}`;
}
async function legacyKey(secret) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:employee-hub-v2:data`)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function legacySeal(secret, documentId, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(documentId) }, await legacyKey(secret), encoder.encode(JSON.stringify(payload)));
  return { iv: b64url(iv), payload: b64url(new Uint8Array(sealed)) };
}
async function legacyOpen(secret, documentId, iv, payload) {
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: encoder.encode(documentId) }, await legacyKey(secret), Buffer.from(payload, 'base64url'));
  return JSON.parse(new TextDecoder().decode(clear));
}

// Set `familyQuery` to answer two-filter (compositeFilter) queries with a canned
// response, e.g. Firestore's index-required error.
function firestore(t, seed = {}) {
  const docs = new Map(Object.entries(seed)), requests = [], store = { docs, requests, familyQuery: null };
  let revision = 0;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    requests.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    assert.equal(url.hostname, 'firestore.googleapis.com');
    if (url.pathname.endsWith('/documents:runQuery')) {
      const { structuredQuery } = JSON.parse(options.body);
      assert.deepEqual(structuredQuery.from, [{ collectionId: 'jobs' }]);
      if (store.familyQuery && structuredQuery.where?.compositeFilter) return store.familyQuery();
      const rows = [...docs].filter(([path, doc]) => path.startsWith('jobs/') && matchesWhere(doc, structuredQuery.where))
        .map(([path, doc]) => ({ document: { name: `${ROOT}/${path}`, ...doc } }));
      return Response.json(rows.length ? rows : [{ readTime: NOW }]);
    }
    const path = decodeURIComponent(url.pathname.split('/documents/')[1]);
    if (method === 'PATCH') {
      const absent = url.searchParams.get('currentDocument.exists'), expected = url.searchParams.get('currentDocument.updateTime');
      if ((absent === 'false' && docs.has(path)) || (expected && docs.get(path)?.updateTime !== expected)) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 412 });
      docs.set(path, { ...JSON.parse(options.body), updateTime: `2026-09-22T12:00:01.${String(++revision).padStart(6, '0')}Z` });
    }
    return docs.has(path) ? Response.json({ name: `${ROOT}/${path}`, ...docs.get(path) }) : Response.json({}, { status: 404 });
  });
  return store;
}

test('records sealed by the pre-extraction Hub API open through the shared vault library', async t => {
  assert.equal(await opaqueId(env, 'timeEntries', LEGACY.timeEntries.id), LEGACY.timeEntries.documentId);
  assert.equal(await opaqueId(env, 'announcements', LEGACY.announcements.id), LEGACY.announcements.documentId);
  firestore(t, legacySeed());
  const one = await readOne(env, 'timeEntries', 'legacy-shift-1');
  assert.equal(one.documentId, LEGACY.timeEntries.documentId);
  assert.equal(one.updateTime, '2026-09-21T23:05:01.000000Z');
  assert.equal(one.data.id, 'legacy-shift-1');
  assert.equal(one.data.employee, 'Crew.One');
  assert.equal(one.data.approvalStatus, 'approved');
  assert.equal(one.data.hours, 8);
  assert.equal(one.data.grossEstimate, 160);
  assert.equal(one.data.workDate, '2026-09-21');
  assert.deepEqual(await readCollection(env, 'timeEntries'), [one.data]);
  assert.deepEqual(await readEmployeeTimecards(env), [one.data]);
  assert.deepEqual(await readCollection(env, 'announcements'), [{ title: 'Synthetic', body: 'Legacy sealed note', updatedAt: '2026-09-21T10:00:00.000Z', id: 'legacy-note-1' }]);
  assert.deepEqual((await readAll(env)).map(row => row.collection).sort(), ['announcements', 'timeEntries']);
  assert.deepEqual(await readCollection(env, 'profiles'), []);
  // A different key derives different ids and keys; it must never look like an empty vault.
  await assert.rejects(readCollection({ ...env, EMPLOYEE_HUB_DATA_SECRET: 'another-vault-key' }, 'timeEntries'), unreadable);
  await assert.rejects(readAll({ ...env, EMPLOYEE_HUB_DATA_SECRET: 'another-vault-key' }), unreadable);
});

test('the Hub API still serves legacy sealed records after the extraction', async t => {
  const hubEnv = { ...env, HUB_SESSION_SECRET: 'vault-store-test-session-key', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-owner-hash', displayName: 'Owner', role: 'owner' } }) };
  const cookie = (await createHubSessionCookie(hubEnv, 'ZacB')).split(';')[0];
  firestore(t, legacySeed());
  const response = await employeeHubGet({ env: hubEnv, request: new Request('https://easygaragecleaning.com/api/employee-hub', { headers: { Cookie: cookie } }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.collections.timeEntries.map(entry => entry.id), ['legacy-shift-1']);
  assert.deepEqual(body.collections.announcements.map(entry => entry.body), ['Legacy sealed note']);
});

test('the vault keeps the legacy key derivation, AAD binding and document-id contract', async () => {
  for (const [collection, id] of [['profiles', 'crew.one'], ['timeLocks', 'crew.one'], ['timeEntries', 'shift 1/α'], ['jobMessages', 'room:1']]) {
    assert.equal(await opaqueId(env, collection, id), await legacyId(SECRET, collection, id), `${collection}:${id}`);
  }
  const documentId = await legacyId(SECRET, 'profiles', 'crew.one');
  const sealed = await seal(env, documentId, { id: 'crew.one', username: 'Crew.One' });
  assert.equal(Buffer.from(sealed.iv, 'base64url').length, 12);
  assert.deepEqual(await legacyOpen(SECRET, documentId, sealed.iv, sealed.payload), { id: 'crew.one', username: 'Crew.One' });
  await assert.rejects(legacyOpen(SECRET, await legacyId(SECRET, 'profiles', 'crew.two'), sealed.iv, sealed.payload));
  assert.notEqual((await seal(env, documentId, { id: 'crew.one' })).iv, (await seal(env, documentId, { id: 'crew.one' })).iv);

  const legacy = await legacySeal(SECRET, documentId, { id: 'crew.one', username: 'Crew.One', hourlyRate: 21 });
  assert.deepEqual(await open(env, documentId, legacy.iv, legacy.payload), { id: 'crew.one', username: 'Crew.One', hourlyRate: 21 });
  assert.deepEqual(await openStored(env, { documentId, collection: 'profiles', ...legacy }), { id: 'crew.one', username: 'Crew.One', hourlyRate: 21 });
  // The id inside the payload must derive the document id for the stored family.
  await assert.rejects(openStored(env, { documentId, collection: 'training', ...legacy }), unreadable);
  const moved = await legacyId(SECRET, 'profiles', 'crew.two');
  await assert.rejects(openStored(env, { documentId: moved, collection: 'profiles', ...legacy }), unreadable);
});

test('readCollection issues one two-filter runQuery and decrypts only the requested family', async t => {
  const store = firestore(t);
  await writeOne(env, 'timeEntries', 'shift-1', { employee: 'Crew.One', approvalStatus: 'approved' }, null, NOW);
  await writeOne(env, 'announcements', 'note-1', { body: 'Team note' }, null, NOW);
  // A damaged record of another family is excluded by the query and never decrypted.
  const brokenId = await opaqueId(env, 'profiles', 'crew.one');
  store.docs.set(`jobs/${brokenId}`, { fields: sealedFields('profiles', { documentId: brokenId, iv: 'AAAAAAAAAAAAAAAA', payload: 'AAAA', updatedAt: NOW }), updateTime: NOW });
  store.requests.length = 0;
  assert.deepEqual(await readCollection(env, 'timeEntries'), [{ employee: 'Crew.One', approvalStatus: 'approved', id: 'shift-1', updatedAt: NOW }]);
  assert.equal(store.requests.length, 1);
  const [query] = store.requests;
  assert.equal(query.method, 'POST');
  assert.equal(query.url.pathname, `/v1/${ROOT}:runQuery`);
  assert.equal(query.url.searchParams.get('key'), 'firebase-test-vault-store');
  assert.deepEqual(query.body, { structuredQuery: {
    from: [{ collectionId: 'jobs' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'recordType' }, op: 'EQUAL', value: { stringValue: 'employee_hub_v2' } } },
      { fieldFilter: { field: { fieldPath: 'employeeHubType' }, op: 'EQUAL', value: { stringValue: 'timeEntries' } } },
    ] } },
  } });
  assert.deepEqual((await readEmployeeTimecards(env)).map(entry => entry.id), ['shift-1']);
  // The whole-vault read keeps its single-filter query and still fails closed on any damage.
  store.requests.length = 0;
  await assert.rejects(readAll(env), unreadable);
  assert.deepEqual(store.requests[0].body.structuredQuery.where, { fieldFilter: { field: { fieldPath: 'recordType' }, op: 'EQUAL', value: { stringValue: 'employee_hub_v2' } } });
  await assert.rejects(readCollection(env, 'profiles'), unreadable);
  assert.doesNotMatch(read('functions/_lib/employee-vault.js'), /\?key=/, 'credentials are added only by firestoreFetch');
});

test('readCollection fails closed on malformed, partial or unfiltered query responses', async t => {
  const note = { documentId: LEGACY.announcements.documentId, ...LEGACY.announcements };
  const timeDoc = fields => ({ name: `${ROOT}/jobs/${LEGACY.timeEntries.documentId}`, updateTime: NOW, fields: { ...sealedFields('timeEntries', LEGACY.timeEntries), ...fields } });
  const cases = [
    ['non-array body', () => Response.json({})],
    ['non-JSON body', () => new Response('not json', { status: 200 })],
    ['error row', () => Response.json([{ error: { status: 'INTERNAL' } }])],
    ['null row', () => Response.json([null])],
    ['row without document or readTime', () => Response.json([{}])],
    ['row of another family', () => Response.json([{ document: { name: `${ROOT}/jobs/${note.documentId}`, updateTime: NOW, fields: sealedFields('announcements', note) } }])],
    ['time lock row', () => Response.json([{ document: timeDoc({ employeeHubType: { stringValue: 'timeLocks' } }) }])],
    ['vault id mismatch', () => Response.json([{ document: timeDoc({ vaultId: { stringValue: 'secure_other' } }) }])],
    ['unknown schema', () => Response.json([{ document: timeDoc({ schemaVersion: { integerValue: '3' } }) }])],
    ['tampered payload', () => Response.json([{ document: timeDoc({ sealedPayload: { stringValue: LEGACY.announcements.payload } }) }])],
  ];
  let respond;
  t.mock.method(globalThis, 'fetch', async () => respond());
  for (const [name, reply] of cases) {
    respond = reply;
    await assert.rejects(readCollection(env, 'timeEntries'), unreadable, name);
  }
  respond = () => Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
  await assert.rejects(readCollection(env, 'timeEntries'), /Employee Hub storage query failed \(503\)/);
  respond = () => Response.json([{ readTime: NOW }]);
  assert.deepEqual(await readCollection(env, 'timeEntries'), []);
  respond = () => Response.json([{ document: timeDoc({}) }, { readTime: NOW }]);
  assert.deepEqual((await readCollection(env, 'timeEntries')).map(entry => entry.id), ['legacy-shift-1']);
});

const recordTypeOnly = { fieldFilter: { field: { fieldPath: 'recordType' }, op: 'EQUAL', value: { stringValue: 'employee_hub_v2' } } };
const queryKinds = requests => requests.map(({ body }) => body.structuredQuery.where.compositeFilter ? 'family' : body.structuredQuery.where.fieldFilter.field.fieldPath);
const indexError = { code: 400, message: 'The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/egcw-1ec83/firestore/indexes?create_composite=synthetic', status: 'FAILED_PRECONDITION' };

test('an index-required family query falls back to the whole-vault read with the same records', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const store = firestore(t, legacySeed());
  const families = ['timeEntries', 'announcements', 'profiles'], direct = {};
  for (const family of families) direct[family] = await readCollection(env, family);
  assert.equal(direct.timeEntries[0].id, 'legacy-shift-1');
  assert.equal(warn.mock.callCount(), 0);
  // Firestore streams the error as [{error}]; the plain {error} form is accepted too.
  for (const body of [[{ error: indexError }], { error: indexError }]) {
    store.familyQuery = () => Response.json(body, { status: 400 });
    for (const family of families) {
      store.requests.length = 0;
      warn.mock.resetCalls();
      assert.deepEqual(await readCollection(env, family), direct[family], family);
      assert.deepEqual(queryKinds(store.requests), ['family', 'recordType'], 'one rejected family query, then the pre-P1-02 whole-vault query');
      assert.deepEqual(store.requests[1].body.structuredQuery.where, recordTypeOnly);
      assert.equal(warn.mock.callCount(), 1);
      const { arguments: args } = warn.mock.calls[0];
      assert.equal(args.length, 1);
      assert.match(args[0], /^Employee vault: .*FAILED_PRECONDITION.*whole-vault read\.$/);
      for (const secret of [SECRET, env.FIREBASE_API_KEY, 'console.firebase.google.com', 'create_composite', LEGACY.timeEntries.documentId, 'Crew.One']) assert.ok(!args[0].includes(secret), secret);
    }
    assert.deepEqual(await readEmployeeTimecards(env), direct.timeEntries);
  }
  // The fallback is exactly the old read, so it still fails closed on a wrong key or any damaged record.
  store.familyQuery = () => Response.json([{ error: indexError }], { status: 400 });
  await assert.rejects(readCollection({ ...env, EMPLOYEE_HUB_DATA_SECRET: 'another-vault-key' }, 'timeEntries'), unreadable);
  const brokenId = await opaqueId(env, 'profiles', 'crew.one');
  store.docs.set(`jobs/${brokenId}`, { fields: sealedFields('profiles', { documentId: brokenId, iv: 'AAAAAAAAAAAAAAAA', payload: 'AAAA', updatedAt: NOW }), updateTime: NOW });
  await assert.rejects(readCollection(env, 'timeEntries'), unreadable);
  await assert.rejects(readEmployeeTimecards(env), unreadable);
});

test('every other failed family query still fails closed without a fallback', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const store = firestore(t, legacySeed());
  const failed = status => error => error?.message === `Employee Hub storage query failed (${status})` && !unreadable(error);
  const cases = [
    ['invalid argument', () => Response.json([{ error: { code: 400, message: 'Synthetic invalid query', status: 'INVALID_ARGUMENT' } }], { status: 400 }), failed(400)],
    ['empty 400', () => new Response('', { status: 400 }), failed(400)],
    ['non-JSON 400', () => new Response('Bad Request', { status: 400 }), failed(400)],
    ['400 error without a status', () => Response.json({ error: { code: 400 } }, { status: 400 }), failed(400)],
    ['400 string error', () => Response.json([{ error: 'FAILED_PRECONDITION' }], { status: 400 }), failed(400)],
    ['400 index error mixed with rows', () => Response.json([{ error: indexError }, { readTime: NOW }], { status: 400 }), failed(400)],
    ['400 empty stream', () => Response.json([], { status: 400 }), failed(400)],
    ['FAILED_PRECONDITION with a non-400 status', () => Response.json([{ error: indexError }], { status: 500 }), failed(500)],
    ['permission denied', () => Response.json([{ error: { code: 403, status: 'PERMISSION_DENIED' } }], { status: 403 }), failed(403)],
    ['unavailable', () => Response.json({ error: { code: 503, status: 'UNAVAILABLE' } }, { status: 503 }), failed(503)],
    ['index error row in a 200 stream', () => Response.json([{ error: indexError }]), unreadable],
    ['malformed 200 body', () => Response.json({}), unreadable],
  ];
  for (const [name, respond, expected] of cases) {
    store.familyQuery = respond;
    store.requests.length = 0;
    await assert.rejects(readCollection(env, 'timeEntries'), expected, name);
    await assert.rejects(readEmployeeTimecards(env), expected, name);
    assert.deepEqual(queryKinds(store.requests), ['family', 'family'], `${name}: no whole-vault retry`);
  }
  store.familyQuery = () => Promise.reject(new TypeError('synthetic network failure'));
  await assert.rejects(readCollection(env, 'timeEntries'), /synthetic network failure/);
  assert.equal(warn.mock.callCount(), 0);
});

test('EGC_EMPLOYEE_VAULT_QUERY=legacy switches family reads to the whole-vault query', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const store = firestore(t, legacySeed());
  const direct = await readCollection(env, 'timeEntries'), notes = await readCollection(env, 'announcements');
  // With the switch on, the family query is never sent.
  store.familyQuery = () => { throw new Error('the family query must not run in legacy mode'); };
  for (const value of ['legacy', ' LEGACY ']) {
    const legacyEnv = { ...env, EGC_EMPLOYEE_VAULT_QUERY: value };
    store.requests.length = 0;
    assert.deepEqual(await readCollection(legacyEnv, 'timeEntries'), direct, value);
    assert.deepEqual(await readEmployeeTimecards(legacyEnv), direct, value);
    assert.deepEqual(await readCollection(legacyEnv, 'announcements'), notes);
    assert.deepEqual(await readCollection(legacyEnv, 'profiles'), []);
    assert.deepEqual(queryKinds(store.requests), ['recordType', 'recordType', 'recordType', 'recordType']);
    for (const { body } of store.requests) assert.deepEqual(body.structuredQuery.where, recordTypeOnly);
    await assert.rejects(readCollection(legacyEnv, 'timeLocks'), TypeError);
    await assert.rejects(readCollection({ ...legacyEnv, EMPLOYEE_HUB_DATA_SECRET: 'another-vault-key' }, 'timeEntries'), unreadable);
  }
  // Unset (the default) and any other value use the two-filter family query.
  store.familyQuery = null;
  for (const value of [undefined, '', 'query', 'true', 'legacy-mode']) {
    store.requests.length = 0;
    assert.deepEqual(await readCollection({ ...env, EGC_EMPLOYEE_VAULT_QUERY: value }, 'timeEntries'), direct, String(value));
    assert.deepEqual(queryKinds(store.requests), ['family'], String(value));
  }
  assert.equal(warn.mock.callCount(), 0);
});

test('unknown families are rejected before any storage request', async t => {
  const store = firestore(t);
  assert.ok(EMPLOYEE_HUB_COLLECTIONS.has('timeEntries') && EMPLOYEE_HUB_COLLECTIONS.has('profiles') && !EMPLOYEE_HUB_COLLECTIONS.has('timeLocks'));
  for (const collection of ['timeLocks', 'accounts', '', undefined]) {
    await assert.rejects(readCollection(env, collection), TypeError);
    await assert.rejects(writeOne(env, collection, 'x', { note: 'x' }, null, NOW), TypeError);
  }
  assert.equal(store.requests.length, 0);
});

test('writeOne keeps the sealed document shape, create-only and revision preconditions', async t => {
  const store = firestore(t);
  const saved = await writeOne(env, 'profiles', 'crew.one', { username: 'Crew.One' }, null, NOW);
  assert.deepEqual(saved, { username: 'Crew.One', id: 'crew.one', updatedAt: NOW });
  const documentId = await legacyId(SECRET, 'profiles', 'crew.one');
  const [patch] = store.requests;
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.url.pathname, `/v1/${ROOT}/jobs/${documentId}`);
  assert.equal(patch.url.searchParams.has('currentDocument.exists') || patch.url.searchParams.has('currentDocument.updateTime'), false);
  const { sealedPayload, sealedIv, ...plain } = patch.body.fields;
  assert.deepEqual(plain, {
    recordType: { stringValue: 'employee_hub_v2' }, employeeHubType: { stringValue: 'profiles' },
    schemaVersion: { integerValue: '2' }, updatedAt: { stringValue: NOW }, vaultId: { stringValue: documentId },
  });
  assert.deepEqual(await legacyOpen(SECRET, documentId, sealedIv.stringValue, sealedPayload.stringValue), saved);
  assert.equal((await writeOne(env, 'profiles', 'crew.two', { username: 'Crew.Two', updatedAt: '2026-09-01T00:00:00.000Z' }, null, NOW)).updatedAt, '2026-09-01T00:00:00.000Z');

  const target = await readOne(env, 'profiles', 'crew.one');
  assert.deepEqual(expectedDocument(target), { updateTime: target.updateTime });
  await writeOne(env, 'profiles', 'crew.one', { ...target.data, phone: '9705550100' }, target, NOW);
  assert.equal(store.requests.at(-1).url.searchParams.get('currentDocument.updateTime'), target.updateTime);
  await assert.rejects(writeOne(env, 'profiles', 'crew.one', { ...target.data, phone: 'stale' }, target, NOW), error => error.code === 'EMPLOYEE_HUB_WRITE_CONFLICT');
  assert.equal((await readOne(env, 'profiles', 'crew.one')).data.phone, '9705550100');

  const missing = await readOne(env, 'profiles', 'new.crew');
  assert.deepEqual(expectedDocument(missing), { exists: false });
  await writeOne(env, 'profiles', 'new.crew', { username: 'New.Crew' }, missing, NOW);
  assert.equal(store.requests.at(-1).url.searchParams.get('currentDocument.exists'), 'false');
  await assert.rejects(writeOne(env, 'profiles', 'new.crew', { username: 'Replacement' }, missing, NOW), error => error.code === 'EMPLOYEE_HUB_WRITE_CONFLICT');

  const before = store.requests.length;
  assert.throws(() => expectedDocument({ data: { id: 'x' } }), unreadable);
  await assert.rejects(writeOne(env, 'profiles', 'crew.one', { username: 'Crew.One' }, { data: { id: 'crew.one' } }, NOW), unreadable);
  assert.equal(store.requests.length, before, 'a version-less target is never written');
});

test('sealing refuses read-only recovery vaults and empty keys while recovery reads still work', async t => {
  const store = firestore(t, legacySeed());
  const recovery = { FIREBASE_API_KEY: env.FIREBASE_API_KEY, EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HIGHLEVEL_API_KEY', HIGHLEVEL_API_KEY: SECRET };
  assert.equal((await readOne(recovery, 'timeEntries', 'legacy-shift-1')).data.id, 'legacy-shift-1');
  const before = store.requests.length;
  await assert.rejects(writeOne(recovery, 'profiles', 'crew.one', { username: 'Crew.One' }, null, NOW), error => error.code === 'EMPLOYEE_HUB_RECOVERY_READ_ONLY' && error.status === 503);
  await assert.rejects(seal(recovery, 'secure_any', { id: 'x' }), error => error.code === 'EMPLOYEE_HUB_RECOVERY_READ_ONLY');
  await assert.rejects(seal({ FIREBASE_API_KEY: env.FIREBASE_API_KEY }, 'secure_any', { id: 'x' }), error => error.code === 'EMPLOYEE_HUB_NOT_CONFIGURED' && error.status === 503);
  assert.equal(store.requests.filter(request => request.method === 'PATCH').length, 0);
  assert.equal(store.requests.length, before);
  await writeOne({ ...recovery, EMPLOYEE_HUB_LEGACY_WRITES_VERIFIED: 'true' }, 'profiles', 'crew.one', { username: 'Crew.One' }, null, NOW);
  assert.equal((await readOne(env, 'profiles', 'crew.one')).data.username, 'Crew.One');
});

// Part B — one definition of business staff and the owner.
const legacyBusiness = value => {
  const names = new Set(['zacb', 'tylerg', 'alexk']);
  if (value && typeof value === 'object') return value.businessAccess === true && names.has(String(value.user || '').trim().toLowerCase());
  return names.has(String(value || '').trim().toLowerCase());
};
const legacyReserved = value => new Set(['zacb', 'tylerg', 'alexk']).has(String(value || '').trim().slice(0, 32).toLowerCase());
const usernames = ['ZacB', 'zacb', ' ZACB ', 'TylerG', 'tylerg', 'AlexK', ' alexk', 'FrankJara', 'Crewtest', 'zac', 'zacb2', 'tyler.g', 'new.manager', '', null, undefined, 42];

test('business users and the owner are defined once and cannot be changed at runtime', () => {
  assert.deepEqual([...BUSINESS_USERS], ['zacb', 'tylerg', 'alexk']);
  assert.equal(OWNER_USERNAME, 'zacb');
  assert.ok(BUSINESS_USERS.has(OWNER_USERNAME));
  assert.ok(Object.isFrozen(BUSINESS_USERS));
  assert.throws(() => BUSINESS_USERS.add('intruder'), TypeError);
  assert.throws(() => BUSINESS_USERS.delete('zacb'), TypeError);
  assert.throws(() => BUSINESS_USERS.clear(), TypeError);
  assert.deepEqual([...BUSINESS_USERS], ['zacb', 'tylerg', 'alexk']);
  assert.equal(hasBusinessAccess('intruder'), false);
  // Security invariant: staff names are not re-declared in any consumer.
  for (const file of ['functions/_lib/hub-session.js', 'functions/_lib/employee-accounts.js', 'functions/_lib/staff-invitation-service.js', 'functions/api/employee-accounts.js', 'functions/api/employee-hub.js',
    'functions/api/gusto-auth.js', 'functions/api/gusto-sync.js', 'functions/api/hub-auth.js', 'employee-suite.js', 'crew/hub-auth.js']) {
    assert.doesNotMatch(read(file), /['"](?:zacb|tylerg|alexk)['"]/i, file);
  }
  assert.doesNotMatch(read('employee.html'), /const ADMINS|BUSINESS_USERS/);
});

test('Set.prototype methods called on the shared list cannot grant or remove business access', () => {
  assert.ok(!(BUSINESS_USERS instanceof Set));
  for (const attempt of [
    () => Set.prototype.add.call(BUSINESS_USERS, 'intruder'),
    () => Set.prototype.delete.call(BUSINESS_USERS, 'tylerg'),
    () => Set.prototype.clear.call(BUSINESS_USERS),
    () => { BUSINESS_USERS.has = () => true; },
    () => { BUSINESS_USERS.has.call = () => true; },
    () => Object.defineProperty(BUSINESS_USERS, 'has', { value: () => true }),
    () => Object.setPrototypeOf(BUSINESS_USERS, Set.prototype),
  ]) assert.throws(attempt, TypeError, String(attempt));
  const copy = [...BUSINESS_USERS];
  copy.push('intruder');
  assert.equal(BUSINESS_USERS.has('intruder'), false);
  assert.equal(hasBusinessAccess('intruder'), false);
  assert.equal(hasBusinessAccess({ user: 'intruder', businessAccess: true }), false);
  assert.equal(isReservedEmployeeUsername('intruder'), false);
  assert.equal(hasBusinessAccess({ user: 'TylerG', businessAccess: true }), true);
  assert.deepEqual([...BUSINESS_USERS], ['zacb', 'tylerg', 'alexk']);
});

test('staff invitations still require exactly the owner username as approver', async () => {
  const token = 'a'.repeat(43), email = 'synthetic.sales@example.invalid';
  const account = approvedBy => ({ role: 'sales', username: 'synthetic.sales', email, invitation: { kind: 'named_staff_v1', approvedBy, username: 'synthetic.sales', email, consumedAt: NOW } });
  const manifest = async approvedBy => ({ id: 'synthetic-invite', username: 'synthetic.sales', firstName: 'Synthetic', lastName: 'Sales', email, role: 'sales', approvedBy,
    tokenHash: await staffTokenHash(token), createdAt: NOW, expiresAt: '2026-09-24T12:00:00.000Z' });
  // Same exact comparison as the previous hardcoded 'zacb': no trimming or case folding.
  for (const [approvedBy, accepted] of [[OWNER_USERNAME, true], ['zacb', true], ['ZacB', false], [' zacb', false], ['zacb ', false], ['tylerg', false], ['alexk', false], ['', false], [undefined, false]]) {
    assert.equal(namedStaffRole(account(approvedBy)), accepted ? 'sales' : 'crew', `role ${approvedBy}`);
    const service = createStaffInvitationService({ store: { read: async () => null, list: async () => [] }, manifests: [await manifest(approvedBy)], now: () => Date.parse(NOW) });
    const inspected = service.inspect(`synthetic-invite.${token}`);
    if (accepted) assert.equal((await inspected).username, 'synthetic.sales');
    else await assert.rejects(inspected, error => error.status === 410, `invite ${approvedBy}`);
  }
});

test('business access, reserved signup names and profiles match the previous hardcoded rules', () => {
  for (const name of usernames) {
    assert.equal(hasBusinessAccess(name), legacyBusiness(name), `username ${name}`);
    assert.equal(isReservedEmployeeUsername(name), legacyReserved(name), `reserved ${name}`);
    for (const businessAccess of [true, false, 'true', undefined]) {
      const profile = { user: name, businessAccess };
      assert.equal(hasBusinessAccess(profile), legacyBusiness(profile), `profile ${name} ${businessAccess}`);
    }
  }
  const users = { ZacB: { passwordHash: 'x', role: 'owner' }, TylerG: { passwordHash: 'x', role: 'crew_lead' }, AlexK: { passwordHash: 'x', role: 'manager' }, FrankJara: { passwordHash: 'x', role: 'crew' }, NewManager: { passwordHash: 'x', role: 'manager' } };
  const configured = { HUB_AUTH_USERS_JSON: JSON.stringify(users) };
  assert.deepEqual(Object.keys(users).map(user => getHubUserProfile(configured, user).businessAccess), [true, true, true, false, false]);
});

test('the owner flag belongs only to the signed-in owner profile', () => {
  const cases = [
    [{ user: 'ZacB', businessAccess: true }, true], [{ user: ' zacb ', businessAccess: true }, true],
    [{ user: 'ZacB', businessAccess: false }, false], [{ user: 'ZacB', businessAccess: false, source: 'employee-account' }, false],
    [{ user: 'ZacB', businessAccess: 'true' }, false], [{ user: 'TylerG', businessAccess: true }, false],
    [{ user: 'AlexK', businessAccess: true }, false], [{ user: 'FrankJara', businessAccess: false }, false],
    ['ZacB', false], [null, false], [undefined, false], [{}, false],
  ];
  for (const [profile, expected] of cases) assert.equal(isHubOwner(profile), expected, JSON.stringify(profile));
});

const staffEnv = async () => ({
  HUB_SESSION_SECRET: 'vault-store-test-session-key', EMPLOYEE_HUB_DATA_SECRET: SECRET,
  HUB_AUTH_USERS_JSON: JSON.stringify({
    ZacB: { passwordHash: await hashHubCredential('ZacB', 'synthetic-pass'), displayName: 'Owner', role: 'owner' },
    TylerG: { passwordHash: await hashHubCredential('TylerG', 'synthetic-pass'), displayName: 'Lead', role: 'crew_lead' },
    AlexK: { passwordHash: await hashHubCredential('AlexK', 'synthetic-pass'), displayName: 'Manager', role: 'manager' },
    FrankJara: { passwordHash: await hashHubCredential('FrankJara', 'synthetic-pass'), displayName: 'Crew', role: 'crew' },
  }),
});
const grants = { ZacB: [true, true], TylerG: [true, false], AlexK: [true, false], FrankJara: [false, false] };

test('/api/hub-auth adds owner to sign-in and restore without changing business access', async () => {
  const staff = await staffEnv();
  for (const [user, [businessAccess, owner]] of Object.entries(grants)) {
    const login = await hubAuth.onRequestPost({ env: staff, request: new Request('https://easygaragecleaning.com/api/hub-auth', {
      method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: 'synthetic-pass' }),
    }) });
    assert.equal(login.status, 200, user);
    const signedIn = await login.json();
    assert.deepEqual([signedIn.user, signedIn.businessAccess, signedIn.owner], [user, businessAccess, owner], `${user} sign-in`);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const restored = await (await hubAuth.onRequestGet({ env: staff, request: new Request('https://easygaragecleaning.com/api/hub-auth', { headers: { Cookie: cookie } }) })).json();
    assert.deepEqual([restored.user, restored.businessAccess, restored.owner], [user, businessAccess, owner], `${user} restore`);
  }
  assert.equal((await hubAuth.onRequestGet({ env: staff, request: new Request('https://easygaragecleaning.com/api/hub-auth') })).status, 401);
});

test('owner-only endpoints keep the same authorization outcome for every staff account', async t => {
  const staff = await staffEnv();
  const cookie = async user => (await createHubSessionCookie(staff, user)).split(';')[0];
  const gusto = { ...staff, FIREBASE_API_KEY: 'firebase-test-vault-store', GUSTO_ENVIRONMENT: 'demo', GUSTO_COMPANY_UUID: '11111111-1111-4111-8111-111111111111', GUSTO_CLIENT_ID: 'synthetic-client', GUSTO_CLIENT_SECRET: 'synthetic-secret', GUSTO_REDIRECT_URI: 'https://easygaragecleaning.com/api/gusto-auth' };
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('storage offline'); });
  // Storage is deliberately unavailable: the owner passes the gate and reaches it (503); others stop at 403.
  const expected = { ZacB: 503, TylerG: 403, AlexK: 403, FrankJara: 403 };
  for (const [user, status] of Object.entries(expected)) {
    const headers = { Cookie: await cookie(user) };
    assert.equal((await employeeAccounts.onRequestGet({ env: staff, request: new Request('https://easygaragecleaning.com/api/employee-accounts', { headers }) })).status, status, `${user} account approvals`);
    assert.equal((await employeeHubGet({ env: staff, request: new Request('https://easygaragecleaning.com/api/employee-hub?include=accounts', { headers }) })).status, status, `${user} hub accounts`);
    assert.equal((await gustoAuthGet({ env: gusto, request: new Request('https://easygaragecleaning.com/api/gusto-auth', { headers }) })).status, status, `${user} gusto connect`);
  }
  assert.equal((await gustoAuthGet({ env: gusto, request: new Request('https://easygaragecleaning.com/api/gusto-auth') })).status, 401);
  const zac = getHubUserProfile(staff, 'ZacB');
  for (const [session, status] of [[zac, 200], [getHubUserProfile(staff, 'TylerG'), 403], [getHubUserProfile(staff, 'AlexK'), 403], [getHubUserProfile(staff, 'FrankJara'), 403],
    [{ ...zac, businessAccess: false }, 403], [{ ...zac, role: 'manager' }, 403], [null, 401]]) {
    const handlers = createGustoSyncHandlers({ session: async () => session, timecards: { preview: async () => ({ rows: [] }) } });
    assert.equal((await handlers.onRequestGet({ env: gusto, request: new Request('https://easygaragecleaning.com/api/gusto-sync') })).status, status, JSON.stringify(session));
  }
});

// Front-end: business and owner views come from the server grants stored at sign-in.
const storage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
};
const element = () => ({
  value: '', textContent: '', innerHTML: '', disabled: false, style: {}, attrs: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener() {}, setAttribute(name, value) { this.attrs[name] = value; }, focus() {}, remove() {},
});
function browser(session = {}, local = {}) {
  const events = {}, elements = new Map();
  const context = {
    console, URLSearchParams, Date, Intl, Promise, Set, Map, Error, Event,
    sessionStorage: storage(session), localStorage: storage(local), navigator: {}, location: { pathname: '/employee', search: '' },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener: (name, callback) => { events[name] = callback; }, dispatchEvent: event => events[event.type]?.(event),
    document: {
      readyState: 'complete', activeElement: null, body: element(), addEventListener() {}, querySelectorAll: () => [],
      getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelector(selector) { return selector === '#login-screen .btn-main' ? this.getElementById('login-button') : null; },
    },
  };
  context.window = context;
  return context;
}
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('employee-suite manager and owner views follow server grants, never usernames', () => {
  const load = (session, local) => {
    const context = browser(session, local);
    Object.assign(context, { me: session.egc_u || local?.egc_u || '', jobsCache: [], hubFetch: async () => reply({ ok: true }) });
    vm.runInNewContext(read('employee-suite.js').replace(/\}\)\(\);\s*$/, 'globalThis.ui={isManager,isOwnerAccount,canView};})();'), context);
    return context.ui;
  };
  const cases = [
    [{ egc_u: 'NewManager', egc_business_access: 'true', egc_owner: 'false' }, undefined, true, false],
    [{ egc_u: 'ZacB', egc_business_access: 'false', egc_owner: 'false' }, undefined, false, false],
    [{ egc_u: 'ZacB', egc_business_access: 'true' }, undefined, true, false],
    [{ egc_u: 'ZacB', egc_business_access: 'true', egc_owner: 'true' }, undefined, true, true],
    [{ egc_u: '', egc_business_access: 'true', egc_owner: 'true' }, undefined, false, false],
    [{}, { egc_u: 'TylerG', egc_business_access: 'true', egc_owner: 'false' }, true, false],
  ];
  for (const [session, local, manager, owner] of cases) {
    const ui = load(session, local);
    assert.equal(ui.isManager(), manager, JSON.stringify({ session, local }));
    assert.equal(ui.isOwnerAccount(), owner, JSON.stringify({ session, local }));
    assert.equal(ui.canView('people'), manager);
    assert.equal(ui.canView('my_day'), true);
  }
});

test('crew hub-auth grants business tools and owner only from the signed-in server profile', async () => {
  const signIn = async profile => {
    const context = browser();
    context.firebase = { auth: () => ({ signInWithCustomToken: async () => {}, signOut: async () => {} }) };
    context.fetch = async (url, init = {}) => url.includes('firebase-session') ? reply({ ok: true, token: 'synthetic-token' })
      : init.method === 'DELETE' ? reply({ ok: true }) : reply({ ok: true, ...profile });
    vm.runInNewContext(read('crew/hub-auth.js'), context);
    assert.equal(await context.EGCHubAuth.session(), profile.user);
    return context;
  };
  const manager = await signIn({ user: 'NewManager', displayName: 'New Manager', role: 'manager', businessAccess: true, owner: false });
  assert.equal(manager.EGCHubAuth.canRunBusiness(), true, 'a manager added only on the server gets business tools');
  assert.equal(manager.EGCHubAuth.canRunBusiness(' newmanager '), true);
  assert.equal(manager.EGCHubAuth.canRunBusiness('ZacB'), false, 'another name cannot borrow the grant');
  assert.equal(manager.EGCHubAuth.profile().owner, false);
  const crew = await signIn({ user: 'ZacB', displayName: 'Look-alike', role: 'crew', businessAccess: false });
  assert.equal(crew.EGCHubAuth.canRunBusiness(), false, 'a username alone grants nothing');
  assert.equal(crew.localStorage.getItem('egc_owner'), 'false');
  const owner = await signIn({ user: 'ZacB', displayName: 'Owner', role: 'owner', businessAccess: true, owner: true });
  assert.equal(owner.EGCHubAuth.canRunBusiness('ZacB'), true);
  assert.equal(owner.EGCHubAuth.profile().owner, true);
  assert.equal(owner.sessionStorage.getItem('egc_owner'), 'true');
  await owner.EGCHubAuth.signOut();
  for (const store of [owner.sessionStorage, owner.localStorage]) {
    assert.equal(store.getItem('egc_owner'), null);
    assert.equal(store.getItem('egc_business_access'), null);
  }
  assert.equal(owner.EGCHubAuth.canRunBusiness('ZacB'), false);
});

test('employee.html stores the owner grant and enters business mode from businessAccess', async () => {
  const page = read('employee.html');
  const source = page.slice(page.indexOf('let me = null;'), page.indexOf('async function sendBookingConfirmation'));
  const login = async profile => {
    const context = browser();
    Object.assign(context, {
      fetch: async (url, init = {}) => url.includes('firebase-session') ? reply({ ok: true, token: 'synthetic-token' }) : init.method === 'DELETE' ? reply({ ok: true }) : reply({ ok: true, ...profile }),
      firebase: { auth: () => ({ signInWithCustomToken: async () => {}, signOut: async () => {} }) },
      showModeSelect() { context.entered = 'business'; }, bootDashboard() { context.entered = 'employee'; },
      _dataGeneration: 0, _dataUnsubscribers: [], _listenersStarted: false, _leadsTimer: null,
      jobsCache: [], custsCache: [], leadsCache: [], blockedDays: new Set(), blockedSlots: new Set(),
    });
    vm.runInNewContext(`${source}\nglobalThis.ui={doLogin,doLogout,canRunBusiness};`, context);
    context.document.getElementById('l-user').value = profile.user;
    context.document.getElementById('l-pass').value = 'SyntheticPassword1';
    await context.ui.doLogin();
    return context;
  };
  const manager = await login({ user: 'NewManager', role: 'manager', businessAccess: true, owner: false });
  assert.equal(manager.ui.canRunBusiness(), true);
  assert.equal(manager.entered, 'business');
  assert.equal(manager.sessionStorage.getItem('egc_owner'), 'false');
  const lookalike = await login({ user: 'ZacB', role: 'crew', businessAccess: false });
  assert.equal(lookalike.ui.canRunBusiness(), false);
  assert.equal(lookalike.entered, 'employee');
  const owner = await login({ user: 'ZacB', role: 'owner', businessAccess: true, owner: true });
  assert.equal(owner.sessionStorage.getItem('egc_owner'), 'true');
  assert.equal(owner.entered, 'business');
  await owner.ui.doLogout();
  assert.equal(owner.sessionStorage.getItem('egc_owner'), null);
  assert.equal(owner.ui.canRunBusiness(), false);
});

test('employee.html canRunBusiness() and the legacy admin controls use only the server businessAccess flag', () => {
  const page = read('employee.html');
  const pick = name => { const start = page.indexOf(`function ${name}(`); assert.ok(start > 0, name); return page.slice(start, page.indexOf('\n}\n', start) + 3); };
  const legacy = (me, session, local = {}) => {
    const context = browser(session, local), writes = [];
    const doc = path => ({ set: value => writes.push(['set', path, value.blockedBy]), delete: () => writes.push(['delete', path]) });
    Object.assign(context, { me, writes, blockedDays: new Set(), blockedSlots: new Set(), db: { collection: name => ({ doc: id => doc(`${name}/${id}`) }) } });
    vm.runInNewContext(`${['canRunBusiness', 'toggleBlockDay', 'toggleBlockSlot'].map(pick).join('\n')}\nglobalThis.ui={canRunBusiness,toggleBlockDay,toggleBlockSlot};`, context);
    return context;
  };
  // The username never matters: a configured business name without the flag gets nothing,
  // and any signed-in account the server flagged gets the controls.
  for (const me of ['ZacB', 'zacb', ' ZACB ', 'TylerG', 'AlexK', 'FrankJara', 'NewManager', 'Synthetic.Crew']) {
    for (const flag of ['true', 'false', 'TRUE', '1', undefined]) {
      const expected = flag === 'true';
      const context = legacy(me, flag === undefined ? {} : { egc_u: me, egc_business_access: flag });
      assert.equal(context.ui.canRunBusiness(), expected, `${me} ${flag}`);
      context.ui.toggleBlockDay('2026-09-22');
      context.ui.toggleBlockSlot('2026-09-22_09');
      assert.deepEqual(context.writes, expected ? [['set', 'blocked_days/2026-09-22', me], ['set', 'blocked_slots/2026-09-22_09', me]] : [], `${me} ${flag} controls`);
    }
  }
  // Nothing else stands in for the server flag: no signed-in user, a browser-wide copy,
  // the owner flag or an owner role alone never enable business controls.
  for (const [me, session, local] of [
    [null, { egc_business_access: 'true' }], ['', { egc_business_access: 'true' }],
    ['ZacB', {}, { egc_u: 'ZacB', egc_business_access: 'true' }],
    ['ZacB', { egc_u: 'ZacB', egc_business_access: 'false', egc_owner: 'true', egc_role: 'owner' }],
  ]) assert.equal(legacy(me, session, local).ui.canRunBusiness(), false, JSON.stringify({ me, session, local }));
  assert.doesNotMatch(page, /\bADMINS\b|includes\(me\)/, 'no client-side staff list gates the legacy dashboard');
});
