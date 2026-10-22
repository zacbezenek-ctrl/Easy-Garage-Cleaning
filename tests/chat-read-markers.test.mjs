// CHAT-SEEN read markers (/api/employee-hub messageReads): a marker records how far the person has actually seen (the
// newest message their screen showed, seenThrough), never later than now and never moving back, and it is always the
// caller's own, managers included. Synthetic staff from tests/helpers/vault-fixture.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vaultFirestore, staffEnv, cookieFor, ROOT } from './helpers/vault-fixture.mjs';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { readOne, writeOne } from '../functions/_lib/employee-vault.js';
import { onRequestPost } from '../functions/api/employee-hub.js';

const post = (env, cookie, id, data) => onRequestPost({ env, request: new Request('https://easygaragecleaning.com/api/employee-hub', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ collection: 'messageReads', id, data }) }) });
const marker = async (env, id) => (await readOne(env, 'messageReads', id))?.data ?? null;
const iso = ms => new Date(ms).toISOString();
// The server's marker ID: a hash of the lowercased username and the channel (functions/api/employee-hub.js readMarkerId).
const mid = async (user, channel) => `read-${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${user.toLowerCase()}\n${channel}`)))].slice(0, 20).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
const CREW = await mid('Crew.Static', 'team'), MANAGER = await mid('TylerG', 'team');

test('a read marker stores the newest message seen, clamped to now, and never moves back', async t => {
  vaultFirestore(t); const env = staffEnv(), cookie = await cookieFor(env, 'Crew.Static'), id = CREW;
  const seen = iso(Date.now() - 3600000);
  assert.equal((await post(env, cookie, id, { employee: 'Crew.Static', channel: 'team', seenThrough: seen })).status, 200);
  assert.equal((await marker(env, id)).lastReadAt, seen, 'the message the screen showed, not the time of the write');
  assert.equal((await post(env, cookie, id, { channel: 'team', seenThrough: iso(Date.now() - 7200000) })).status, 200);
  assert.equal((await marker(env, id)).lastReadAt, seen, 'an older screen never moves the marker back');
  const before = Date.now();
  assert.equal((await post(env, cookie, id, { channel: 'team', seenThrough: iso(Date.now() + 86400000) })).status, 200);
  const stored = Date.parse((await marker(env, id)).lastReadAt);
  assert.ok(stored >= before && stored <= Date.now(), 'a seenThrough in the future is clamped to now');
  assert.notEqual((await post(env, cookie, id, { channel: 'team', seenThrough: 'soon' })).status, 200, 'an unreadable time is refused');
});

test('without seenThrough (an older cached Hub) the marker is now, as before', async t => {
  vaultFirestore(t); const env = staffEnv(), cookie = await cookieFor(env, 'Crew.Static'), before = Date.now();
  assert.equal((await post(env, cookie, CREW, { channel: 'team', lastReadAt: '2030-01-01T00:00:00.000Z' })).status, 200);
  const stored = Date.parse((await marker(env, CREW)).lastReadAt);
  assert.ok(stored >= before && stored <= Date.now(), 'a client-sent lastReadAt is ignored');
});

test('a read marker is always the caller\'s own: a manager cannot write or overwrite another person\'s', async t => {
  vaultFirestore(t); const env = staffEnv(), manager = await cookieFor(env, 'TylerG'), seen = iso(Date.now() - 60000);
  await writeOne(env, 'messageReads', CREW, { employee: 'Crew.Static', channel: 'team', lastReadAt: iso(Date.now() - 9000000) }, null, iso(Date.now()));
  // The ID a request names is ignored: the server writes the caller's own marker, so another person's is untouched.
  assert.equal((await post(env, manager, CREW, { employee: 'Crew.Static', channel: 'team', seenThrough: seen })).status, 200);
  assert.equal((await marker(env, CREW)).employee, 'Crew.Static', 'the crew member\'s marker is untouched');
  const own = await marker(env, MANAGER);
  assert.deepEqual([own.employee, own.lastReadAt], ['TylerG', seen], 'employee is the signed-in manager whatever the body says');
});

test('a crew member cannot take a manager\'s marker ID; the manager\'s own marker still saves', async t => {
  vaultFirestore(t); const env = staffEnv(), crewCookie = await cookieFor(env, 'Crew.Static'), managerCookie = await cookieFor(env, 'TylerG'), seen = iso(Date.now() - 60000);
  assert.equal((await post(env, crewCookie, MANAGER, { channel: 'team', seenThrough: seen })).status, 200);
  assert.equal((await marker(env, CREW)).employee, 'Crew.Static', 'saved under the crew member\'s own ID');
  assert.equal(await marker(env, MANAGER), null, 'the manager\'s ID was not claimed');
  assert.equal((await post(env, managerCookie, 'anything', { channel: 'team', seenThrough: seen })).status, 200);
  assert.equal((await marker(env, MANAGER)).employee, 'TylerG');
});

test('a job room marker needs a place in that room; managers read every room', async t => {
  const store = vaultFirestore(t), env = staffEnv(), now = iso(Date.now());
  for (const [id, crew] of [['assigned', ['Crew.Static']], ['other', ['Other.Crew']]]) store.documents.set('jobs/' + id, { name: ROOT + '/jobs/' + id, fields: encodeFirestoreFields({ type: 'job', assignedCrew: crew }), updateTime: now });
  const crewCookie = await cookieFor(env, 'Crew.Static'), seen = iso(Date.now() - 60000);
  assert.equal((await post(env, crewCookie, 'x', { channel: 'job:assigned', seenThrough: seen })).status, 200);
  assert.notEqual((await post(env, crewCookie, 'x', { channel: 'job:other', seenThrough: seen })).status, 200, 'not in that room');
  assert.equal(await marker(env, await mid('Crew.Static', 'job:other')), null);
  assert.equal((await post(env, await cookieFor(env, 'TylerG'), 'x', { channel: 'job:other', seenThrough: seen })).status, 200);
});

test('a manager\'s new team message takes the server\'s time and their own name', async t => {
  vaultFirestore(t); const env = staffEnv(), before = Date.now();
  const response = await onRequestPost({ env, request: new Request('https://easygaragecleaning.com/api/employee-hub', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await cookieFor(env, 'TylerG') }, body: JSON.stringify({ collection: 'teamMessages', id: 'message-synthetic-1', data: { body: 'Bring the tall ladder', sender: 'ZacB', createdAt: '2030-01-01T00:00:00.000Z' } }) }) });
  assert.equal(response.status, 200);
  const saved = (await readOne(env, 'teamMessages', 'message-synthetic-1')).data;
  assert.equal(saved.sender, 'TylerG');
  assert.ok(Date.parse(saved.createdAt) >= before && Date.parse(saved.createdAt) <= Date.now(), 'a fast device clock is not trusted');
});

test('two accounts that differ only in punctuation keep their own markers, and an older-format marker carries over', async t => {
  vaultFirestore(t); const env = staffEnv({}, { Crew_Static: { passwordHash: 'unused-synthetic-crew-hash', role: 'crew', displayName: 'Synthetic Underscore Crew' } }), seen = iso(Date.now() - 60000), older = iso(Date.now() - 30000);
  const dotted = await cookieFor(env, 'Crew.Static'), underscored = await cookieFor(env, 'Crew_Static');
  assert.notEqual(CREW, await mid('Crew_Static', 'team'));
  assert.equal((await post(env, dotted, 'x', { channel: 'team', seenThrough: seen })).status, 200);
  assert.equal((await post(env, underscored, 'x', { channel: 'team', seenThrough: seen })).status, 200, 'the second account saves its own marker');
  assert.deepEqual([(await marker(env, CREW)).employee, (await marker(env, await mid('Crew_Static', 'team'))).employee], ['Crew.Static', 'Crew_Static']);
  // A marker saved before the new IDs (letters and digits only) is where the first new save starts: it never moves back.
  await writeOne(env, 'messageReads', 'read-alexk-team', { employee: 'AlexK', channel: 'team', lastReadAt: older }, null, iso(Date.now()));
  assert.equal((await post(env, await cookieFor(env, 'AlexK'), 'x', { channel: 'team', seenThrough: seen })).status, 200);
  assert.equal((await marker(env, await mid('AlexK', 'team'))).lastReadAt, older, 'the older marker was further along');
});
