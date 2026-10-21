import test from 'node:test';
import assert from 'node:assert/strict';
import { vaultFirestore, staffEnv, cookieFor, jsonRequest, ROOT } from './helpers/vault-fixture.mjs';
import { commitVaultDocuments, forgetVaultSnapshots, opaqueId, sealedFields, VAULT_SNAPSHOT_MAX_AGE_MS, writeOne } from '../functions/_lib/employee-vault.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { onRequestGet, onRequestPost } from '../functions/api/employee-hub.js';

// READ-BUDGET (STAFF-DATA-READ): the Hub polls /api/employee-hub once a minute (chat every 15 seconds), and each poll
// read every sealed record of the families it shows, so its bill grew with every timecard and message ever saved. Each
// vault write now marks its family in one revision document and a poll reads that document first, reusing the sealed
// rows of every unchanged family (employee-vault.js vaultSnapshot). These tests count the billed reads of a synthetic
// history and check every answer is the one the whole-vault read gives. Synthetic data only.

const NOW = '2026-09-22T18:00:00.000Z';
const HISTORY = { timeEntries: 120, teamMessages: 150, jobMessages: 40, messageReads: 12, announcements: 6, profiles: 4 };
const VAULT_DOCS = Object.values(HISTORY).reduce((sum, count) => sum + count, 0);
// requests, incidents, equipment, training: never written here, so never marked; each costs its (empty) query, billed
// as one read, on every poll.
const EMPTY_FAMILIES = 4;
const ACCOUNTS = 1; // an office (manager) poll also lists employee accounts: none here, one billed read
const get = (env, cookie, query = '') => onRequestGet({ env, request: new Request(`https://easygaragecleaning.com/api/employee-hub${query}`, { headers: { Cookie: cookie } }) });
const post = (env, cookie, body) => onRequestPost({ env, request: jsonRequest('/api/employee-hub', body, cookie) });

// Billed reads as Firestore counts them: one per document a query returns (at least one per query) and one per
// document GET, found or not. Writes are free.
function meter(t) {
  const inner = globalThis.fetch;
  let reads = 0, queries = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const response = await inner(input, options), url = new URL(input), method = options.method || 'GET';
    if (url.pathname.endsWith(':runQuery')) {
      const rows = await response.clone().json();
      reads += Math.max(1, rows.filter(row => row.document).length);
      queries.push(JSON.parse(options.body).structuredQuery);
    } else if (method === 'GET') reads++;
    return response;
  });
  return { async measure(fn) { reads = 0; queries = []; const result = await fn(); return { result, reads, queries }; } };
}

async function world(t, extra = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  forgetVaultSnapshots();
  const store = vaultFirestore(t), env = staffEnv(extra);
  const people = ['ZacB', 'TylerG', 'Crew.Static', 'AlexK'];
  for (const [family, count] of Object.entries(HISTORY)) for (let index = 0; index < count; index++) {
    const who = people[index % people.length], at = new Date(Date.parse(NOW) - (count - index) * 3600000).toISOString();
    const data = family === 'profiles' ? { username: who, displayName: `Synthetic ${who}` }
      : family === 'timeEntries' ? { employee: who, status: 'approved', clockInAt: at, clockOutAt: at, hours: 4 }
      : family === 'jobMessages' ? { jobId: `job-${index % 5}`, sender: who, body: `Synthetic job note ${index}`, createdAt: at, status: 'active' }
      : family === 'messageReads' ? { employee: who, channel: `job:job-${index % 5}`, lastReadAt: at }
      : { sender: who, body: `Synthetic ${family} ${index}`, createdAt: at, status: 'active' };
    await writeOne(env, family, family === 'profiles' ? who.toLowerCase() : `${family}-${index}`, data, null, at);
  }
  for (let index = 0; index < 5; index++) store.documents.set(`jobs/job-${index}`, { name: `${ROOT}/jobs/job-${index}`, fields: encodeFirestoreFields({ type: 'job', assignedCrew: ['Crew.Static'] }), updateTime: NOW });
  return { store, env, meter: meter(t), owner: await cookieFor(env, 'ZacB'), crew: await cookieFor(env, 'Crew.Static') };
}
const answer = async response => { assert.equal(response.status, 200); return response.json(); };

test('an office Hub poll costs one read while nothing changed, and every answer is the whole-vault read\'s', async t => {
  const { env, meter, owner } = await world(t);
  const before = await meter.measure(async () => answer(await get({ ...env, EGC_EMPLOYEE_VAULT_QUERY: 'legacy' }, owner)));
  assert.equal(before.reads, VAULT_DOCS + ACCOUNTS, 'before: every sealed record on every poll');
  const first = await meter.measure(async () => answer(await get(env, owner)));
  assert.deepEqual(first.result, before.result);
  assert.equal(first.reads, 1 + VAULT_DOCS + EMPTY_FAMILIES + ACCOUNTS, 'the revision, then each family once');
  for (let poll = 0; poll < 3; poll++) {
    t.mock.timers.tick(60000);
    const next = await meter.measure(async () => answer(await get(env, owner)));
    assert.equal(next.reads, 1 + EMPTY_FAMILIES + ACCOUNTS, 'the revision document, the unmarked empty families and the accounts');
    assert.equal(next.queries.filter(query => query.where.compositeFilter && HISTORY[query.where.compositeFilter.filters[1].fieldFilter.value.stringValue]).length, 0, 'no history is reread');
    assert.deepEqual(next.result.collections, first.result.collections);
  }
});

test('a chat message re-reads only its family; the next poll shows it, to the office and to crew chat', async t => {
  const { env, meter, owner, crew } = await world(t);
  await answer(await get(env, owner));
  await answer(await get(env, crew, '?view=messages'));
  assert.equal((await post(env, crew, { collection: 'teamMessages', id: 'message-crew-new', data: { id: 'message-crew-new', body: 'Synthetic new note', sender: 'Crew.Static', createdAt: NOW, updatedAt: NOW, status: 'active' } })).status, 200);
  const office = await meter.measure(async () => answer(await get(env, owner)));
  assert.ok(office.result.collections.teamMessages.some(row => row.id === 'message-crew-new'));
  assert.equal(office.reads, 1 + HISTORY.teamMessages + 1 + EMPTY_FAMILIES + ACCOUNTS);
  assert.deepEqual(office.queries.filter(query => query.where.compositeFilter).map(query => query.where.compositeFilter.filters[1].fieldFilter.value.stringValue).filter(name => HISTORY[name]), ['teamMessages']);
  const chat = await meter.measure(async () => answer(await get(env, crew, '?view=messages')));
  assert.ok(chat.result.collections.teamMessages.some(row => row.id === 'message-crew-new'));
  // The crew poll still checks each job room's current assignment (5 jobs), but rereads no message history.
  assert.equal(chat.reads, 1 + 5);
});

test('a clock-in marks timecards changed in its own commit, so the next poll shows the open shift', async t => {
  const { store, env, meter, owner, crew } = await world(t);
  await answer(await get(env, owner));
  const response = await post(env, crew, { collection: 'timeEntries', id: 'time-crewstatic-1', data: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 }, status: 'active' } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(store.revisions.at(-1).updateMask.fieldPaths, ['timeEntries']);
  assert.ok(store.commits.at(-1).some(write => write.update.name.includes('/employee_time_locks/')), 'the revision rode in the shift\'s commit');
  const next = await meter.measure(async () => answer(await get(env, owner)));
  assert.equal(next.result.collections.timeEntries.find(row => row.id === 'time-crewstatic-1')?.status, 'active');
  assert.equal(next.reads, 1 + HISTORY.timeEntries + 1 + EMPTY_FAMILIES + ACCOUNTS);
});

test('after the snapshot age (fifteen minutes) every family is read again, even with no recorded change', async t => {
  const { env, meter, owner } = await world(t);
  await answer(await get(env, owner));
  t.mock.timers.tick(VAULT_SNAPSHOT_MAX_AGE_MS - 1000);
  assert.equal((await meter.measure(async () => answer(await get(env, owner)))).reads, 1 + EMPTY_FAMILIES + ACCOUNTS);
  t.mock.timers.tick(1000);
  assert.equal((await meter.measure(async () => answer(await get(env, owner)))).reads, 1 + VAULT_DOCS + EMPTY_FAMILIES + ACCOUNTS);
});

// Revision commits refused (or swallowed) while `on()` is true; record writes still apply.
function marks(t, { swallow = false } = {}) {
  const inner = globalThis.fetch;
  let on = false, refused = 0;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const body = new URL(String(input)).pathname.endsWith(':commit') ? JSON.parse(options.body) : null;
    if (on && body?.writes.every(write => write.update.name.endsWith('/employee_vault_revisions/current'))) {
      refused++;
      return swallow ? Response.json({ writeResults: [{ updateTime: NOW }] }) : Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
    }
    return inner(input, options);
  });
  return { set: value => { on = value; }, refused: () => refused };
}
function dataCenterCache(t) {
  const entries = new Map();
  const cache = { match: async key => entries.has(key) ? new Response(entries.get(key)) : undefined, put: async (key, response) => { entries.set(key, await response.text()); }, delete: async key => entries.delete(key) };
  globalThis.caches = { open: async () => cache };
  t.after(() => { delete globalThis.caches; });
  return entries;
}
const announcements = async (env, cookie) => (await answer(await get(env, cookie))).collections.announcements.length;

test('a revision mark that fails once is tried again, so the write is marked like any other', async t => {
  const { store, env, owner } = await world(t);
  dataCenterCache(t);
  await answer(await get(env, owner));
  store.hooks.commitStatus = 503; // the record's PATCH saves; its first revision commit is refused, the retry lands
  const before = store.revisions.length;
  await writeOne(env, 'announcements', 'announcement-new', { body: 'Synthetic late notice', status: 'active' }, null, NOW);
  assert.equal(store.hooks.commitStatus, 0);
  assert.deepEqual(store.revisions.slice(before).map(write => write.updateMask.fieldPaths), [['announcements']]);
  t.mock.timers.tick(60000);
  assert.equal(await announcements(env, owner), HISTORY.announcements + 1);
});

test('a revision mark that keeps failing forgets this isolate\'s copy and the data center\'s, so the next poll shows the write', async t => {
  const { env, owner } = await world(t);
  const entries = dataCenterCache(t), failing = marks(t);
  assert.equal(await announcements(env, owner), HISTORY.announcements);
  const cached = [...entries.keys()].filter(key => key.includes('/announcements/'));
  assert.equal(cached.length, 1);
  failing.set(true);
  await writeOne(env, 'announcements', 'announcement-new', { body: 'Synthetic late notice', status: 'active' }, null, NOW);
  failing.set(false);
  assert.equal(failing.refused(), 2, 'tried twice');
  assert.equal(entries.has(cached[0]), false, 'the data center copy of the revision it knew is deleted');
  for (const tick of [60000, 14 * 60000]) {
    t.mock.timers.tick(tick);
    assert.equal(await announcements(env, owner), HISTORY.announcements + 1);
  }
  // A copy another isolate cached before the failed mark (the same, unchanged revision) is refused here too.
  forgetVaultSnapshots();
  assert.equal(await announcements(env, owner), HISTORY.announcements + 1);
});

test('a save whose reply is lost still marks its family, so the next poll shows it', async t => {
  const { store, env, owner } = await world(t);
  await answer(await get(env, owner));
  const inner = globalThis.fetch;
  let lose = true;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const response = await inner(input, options);
    if (lose && options.method === 'PATCH') { lose = false; throw new TypeError('Synthetic lost reply after the PATCH applied'); }
    return response;
  });
  const before = store.revisions.length;
  await assert.rejects(writeOne(env, 'announcements', 'announcement-lost', { body: 'Synthetic saved, reply lost', status: 'active' }, null, NOW), /lost reply/);
  assert.deepEqual(store.revisions.slice(before).map(write => write.updateMask.fieldPaths), [['announcements']]);
  assert.equal(await announcements(env, owner), HISTORY.announcements + 1);
});

test('a replayed chat message that is already saved marks its family, so a save that landed unmarked shows on the next poll', async t => {
  const { store, env, owner, crew } = await world(t);
  await answer(await get(env, owner));
  await answer(await get(env, crew, '?view=messages'));
  const requestId = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
  const message = { collection: 'teamMessages', id: 'message-crew-replayed', requestId, data: { id: 'message-crew-replayed', body: 'Synthetic replayed note', sender: 'Crew.Static', createdAt: NOW, updatedAt: NOW, status: 'active' } };
  // An older deployment (or a cancelled request) saved the message without its mark.
  const swallowed = marks(t, { swallow: true });
  swallowed.set(true);
  assert.equal((await post(env, crew, message)).status, 200);
  swallowed.set(false);
  const shows = async (cookie, query) => (await answer(await get(env, cookie, query))).collections.teamMessages.some(row => row.id === 'message-crew-replayed');
  assert.equal(await shows(owner), false, 'unmarked: the snapshot still answers');
  // The device queue resends it: nothing new is written, but the family is marked.
  const commits = store.commits.length;
  assert.equal((await post(env, crew, message)).status, 200);
  assert.equal(store.commits.length, commits, 'no record write');
  assert.deepEqual(store.revisions.at(-1).updateMask.fieldPaths, ['teamMessages']);
  assert.equal(await shows(owner), true);
  assert.equal(await shows(crew, '?view=messages'), true);
});

test('a vault commit carries its families\' revision and answers only its own write results', async t => {
  const { store, env } = await world(t);
  const documentId = await opaqueId(env, 'profiles', 'crew.static');
  const current = [...store.documents].find(([path]) => path === `jobs/${documentId}`)[1];
  const result = await commitVaultDocuments(env, [
    { collection: 'jobs', id: documentId, revision: current.updateTime, patch: await sealedFields(env, 'profiles', documentId, { id: 'crew.static', username: 'Crew.Static', phone: '9705550100' }, NOW) },
    { collection: 'hub_audit', id: 'synthetic-audit', patch: { action: 'synthetic' } },
  ]);
  assert.equal(result.writeResults.length, 2);
  const sent = store.requests.at(-1).body.writes;
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.at(-1), { update: { name: `${ROOT}/employee_vault_revisions/current`, fields: { profiles: sent.at(-1).update.fields.profiles } }, updateMask: { fieldPaths: ['profiles'] } });
  assert.equal(sent.at(-1).currentDocument, undefined, 'the mark never conflicts with the records');
  // A commit of no vault family (an audit-only or receipt-only write) carries no mark.
  await commitVaultDocuments(env, [{ collection: 'hub_audit', id: 'synthetic-audit-2', patch: { action: 'synthetic' } }]);
  assert.equal(store.requests.at(-1).body.writes.length, 1);
});

test('the data center cache lets another isolate reuse the sealed rows; it never holds a decrypted record', async t => {
  const { env, meter, owner } = await world(t);
  const entries = new Map();
  const cache = { match: async key => entries.has(key) ? new Response(entries.get(key)) : undefined, put: async (key, response) => { entries.set(key, await response.text()); } };
  globalThis.caches = { open: async name => { assert.equal(name, 'egc-employee-vault-snapshots-v1'); return cache; } };
  t.after(() => { delete globalThis.caches; });
  const first = await answer(await get(env, owner));
  assert.ok(entries.size >= 6);
  for (const text of entries.values()) assert.doesNotMatch(text, /Synthetic|Crew\.Static|approved/, 'only ciphertext is cached');
  forgetVaultSnapshots();
  const other = await meter.measure(async () => answer(await get(env, owner)));
  assert.equal(other.reads, 1 + EMPTY_FAMILIES + ACCOUNTS);
  assert.deepEqual(other.result.collections, first.collections);
});

test('until a write creates the revision document the Hub reads the whole vault once, as before; legacy mode always does', async t => {
  const { store, env, meter, owner } = await world(t);
  store.documents.delete('employee_vault_revisions/current');
  forgetVaultSnapshots();
  for (const environment of [env, { ...env, EGC_EMPLOYEE_VAULT_QUERY: 'legacy' }]) {
    const read = await meter.measure(async () => answer(await get(environment, owner)));
    const vault = read.queries.filter(query => query.where.fieldFilter?.value.stringValue === 'employee_hub_v2' || query.where.compositeFilter);
    assert.equal(vault.length, 1, 'one whole-vault query');
    assert.equal(vault[0].where.fieldFilter.field.fieldPath, 'recordType');
  }
});

test('a malformed family answer fails closed and is never kept', async t => {
  const { store, env, owner } = await world(t);
  const [path, document] = [...store.documents].find(([, doc]) => doc.fields?.employeeHubType?.stringValue === 'announcements');
  const kept = structuredClone(document);
  document.fields.sealedPayload = { stringValue: 'not-a-sealed-payload' };
  assert.equal((await get(env, owner)).status, 502);
  store.documents.set(path, kept);
  assert.equal((await answer(await get(env, owner))).collections.announcements.length, HISTORY.announcements);
});
