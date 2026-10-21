// CHAT-SEEN read markers (/api/employee-hub messageReads): a marker records how far the person has actually seen (the
// newest message their screen showed, seenThrough), never later than now and never moving back, and it is always the
// caller's own, managers included. Synthetic staff from tests/helpers/vault-fixture.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vaultFirestore, staffEnv, cookieFor } from './helpers/vault-fixture.mjs';
import { readOne, writeOne } from '../functions/_lib/employee-vault.js';
import { onRequestPost } from '../functions/api/employee-hub.js';

const post = (env, cookie, id, data) => onRequestPost({ env, request: new Request('https://easygaragecleaning.com/api/employee-hub', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ collection: 'messageReads', id, data }) }) });
const marker = async (env, id) => (await readOne(env, 'messageReads', id))?.data ?? (await readOne(env, 'messageReads', id));
const iso = ms => new Date(ms).toISOString();

test('a read marker stores the newest message seen, clamped to now, and never moves back', async t => {
  vaultFirestore(t); const env = staffEnv(), cookie = await cookieFor(env, 'Crew.Static'), id = 'read-crew.static-team';
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
  assert.equal((await post(env, cookie, 'read-crew.static-team', { channel: 'team', lastReadAt: '2030-01-01T00:00:00.000Z' })).status, 200);
  const stored = Date.parse((await marker(env, 'read-crew.static-team')).lastReadAt);
  assert.ok(stored >= before && stored <= Date.now(), 'a client-sent lastReadAt is ignored');
});

test('a read marker is always the caller\'s own: a manager cannot write or overwrite another person\'s', async t => {
  vaultFirestore(t); const env = staffEnv(), manager = await cookieFor(env, 'TylerG'), seen = iso(Date.now() - 60000);
  await writeOne(env, 'messageReads', 'read-crew.static-team', { employee: 'Crew.Static', channel: 'team', lastReadAt: iso(Date.now() - 9000000) }, null, iso(Date.now()));
  assert.notEqual((await post(env, manager, 'read-crew.static-team', { employee: 'Crew.Static', channel: 'team', seenThrough: seen })).status, 200);
  assert.equal((await marker(env, 'read-crew.static-team')).employee, 'Crew.Static', 'the crew member\'s marker is untouched');
  assert.equal((await post(env, manager, 'read-tylerg-team', { employee: 'Crew.Static', channel: 'team', seenThrough: seen })).status, 200);
  const own = await marker(env, 'read-tylerg-team');
  assert.deepEqual([own.employee, own.lastReadAt], ['TylerG', seen], 'employee is the signed-in manager whatever the body says');
});
