// DIRECT-MESSAGES (/api/employee-hub directMessages): one employee messages one other employee from Crew chat. Each
// message is read by its two people only (managers and the owner included), is sent as the signed-in person to a real
// active staff member, and cannot be edited. Every signed-in employee gets the name-only team list to pick from.
// Synthetic staff from tests/helpers/vault-fixture.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vaultFirestore, staffEnv, cookieFor } from './helpers/vault-fixture.mjs';
import { readOne, writeOne } from '../functions/_lib/employee-vault.js';
import { directChannel, onRequestGet, onRequestPost } from '../functions/api/employee-hub.js';

const URL_ = 'https://easygaragecleaning.com/api/employee-hub';
const post = (env, cookie, collection, id, data) => onRequestPost({ env, request: new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ collection, id, data }) }) });
const get = (env, cookie, query = '') => onRequestGet({ env, request: new Request(URL_ + query, { headers: { Cookie: cookie } }) });

test('a crew member sends a direct message as themselves to a real staff member', async t => {
  vaultFirestore(t); const env = staffEnv(), cookie = await cookieFor(env, 'Crew.Static');
  const response = await post(env, cookie, 'directMessages', 'dm-1', { to: 'tylerg', body: '  Need the ladder at 9  ', sender: 'ZacB', senderName: 'Forged', participants: ['ZacB', 'TylerG'] });
  assert.equal(response.status, 200);
  const saved = (await readOne(env, 'directMessages', 'dm-1')).data;
  assert.equal(saved.sender, 'Crew.Static', 'the sender is whoever is signed in, never the body');
  assert.equal(saved.to, 'TylerG');
  assert.deepEqual(saved.participants, ['Crew.Static', 'TylerG']);
  assert.equal(saved.channel, directChannel('Crew.Static', 'TylerG'));
  assert.equal(saved.channel, directChannel('tylerg', 'crew.static'), 'both sides name the conversation the same way');
  assert.equal(saved.body, 'Need the ladder at 9');
});

test('a direct message needs text, a real active recipient and someone other than yourself', async t => {
  vaultFirestore(t); const env = staffEnv(), cookie = await cookieFor(env, 'Crew.Static');
  await writeOne(env, 'profiles', 'gone.crew', { username: 'Gone.Crew', status: 'inactive' }, null, '2026-10-01T00:00:00.000Z');
  assert.equal((await post(env, cookie, 'directMessages', 'dm-a', { to: 'TylerG', body: '   ' })).status, 400);
  assert.equal((await post(env, cookie, 'directMessages', 'dm-b', { to: 'Nobody.Here', body: 'hi' })).status, 400);
  assert.equal((await post(env, cookie, 'directMessages', 'dm-c', { to: 'Gone.Crew', body: 'hi' })).status, 400, 'an inactive employee cannot be messaged');
  assert.notEqual((await post(env, cookie, 'directMessages', 'dm-d', { to: 'crew.static', body: 'hi' })).status, 200);
  for (const id of ['dm-a', 'dm-b', 'dm-c', 'dm-d']) assert.equal((await readOne(env, 'directMessages', id)).data, null);
});

test('a sent direct message cannot be changed, by its sender or a manager; an identical replay is accepted', async t => {
  vaultFirestore(t); const env = staffEnv(), crew = await cookieFor(env, 'Crew.Static'), manager = await cookieFor(env, 'TylerG');
  assert.equal((await post(env, crew, 'directMessages', 'dm-1', { to: 'AlexK', body: 'Original' })).status, 200);
  assert.equal((await post(env, crew, 'directMessages', 'dm-1', { to: 'AlexK', body: 'Original' })).status, 200, 'a resend of the same message');
  assert.equal((await post(env, crew, 'directMessages', 'dm-1', { to: 'AlexK', body: 'Edited' })).status, 403);
  assert.equal((await post(env, manager, 'directMessages', 'dm-1', { to: 'AlexK', body: 'Manager edit', status: 'archived' })).status, 403);
  const saved = (await readOne(env, 'directMessages', 'dm-1')).data;
  assert.deepEqual([saved.body, saved.sender, saved.status], ['Original', 'Crew.Static', 'active']);
});

test('only the two people read a direct message: not other crew, not managers, not the owner', async t => {
  vaultFirestore(t); const env = staffEnv();
  assert.equal((await post(env, await cookieFor(env, 'Crew.Static'), 'directMessages', 'dm-1', { to: 'AlexK', body: 'Just us' })).status, 200);
  const seen = async user => (await (await get(env, await cookieFor(env, user), '?view=messages')).json()).collections.directMessages.map(row => row.id);
  assert.deepEqual(await seen('Crew.Static'), ['dm-1']);
  assert.deepEqual(await seen('AlexK'), ['dm-1']);
  assert.deepEqual(await seen('TylerG'), [], 'a manager does not see other people\'s direct messages');
  assert.deepEqual(await seen('ZacB'), [], 'nor does the owner');
  const full = await (await get(env, await cookieFor(env, 'TylerG'))).json();
  assert.deepEqual(full.collections.directMessages, [], 'the full view keeps the same rule');
});

test('a direct-message read marker is only for one of its two people', async t => {
  vaultFirestore(t); const env = staffEnv(), channel = directChannel('Crew.Static', 'AlexK');
  assert.equal((await post(env, await cookieFor(env, 'AlexK'), 'messageReads', 'x', { channel, seenThrough: new Date(Date.now() - 1000).toISOString() })).status, 200);
  assert.equal((await post(env, await cookieFor(env, 'TylerG'), 'messageReads', 'x', { channel, seenThrough: new Date(Date.now() - 1000).toISOString() })).status, 403);
});

test('every employee gets the name-only team list to start a conversation from', async t => {
  vaultFirestore(t); const env = staffEnv();
  await writeOne(env, 'profiles', 'new.hire', { username: 'New.Hire', displayName: 'Synthetic New Hire', preferredName: 'Newbie', status: 'active', hourlyRate: 22, phone: '9705550100' }, null, '2026-10-01T00:00:00.000Z');
  await writeOne(env, 'profiles', 'gone.crew', { username: 'Gone.Crew', displayName: 'Synthetic Gone', status: 'inactive' }, null, '2026-10-01T00:00:00.000Z');
  const body = await (await get(env, await cookieFor(env, 'Crew.Static'))).json();
  const names = body.chatRoster.map(person => person.username);
  for (const user of ['ZacB', 'TylerG', 'AlexK', 'Crew.Static', 'New.Hire']) assert.ok(names.includes(user), user);
  assert.ok(!names.includes('Gone.Crew'), 'inactive employees are left out');
  assert.equal(body.chatRoster.find(person => person.username === 'New.Hire').displayName, 'Newbie');
  for (const person of body.chatRoster) assert.deepEqual(Object.keys(person).sort(), ['displayName', 'username'], 'names only: no pay, phone or role');
  assert.deepEqual(body.collections.profiles.map(profile => profile.username), ['Crew.Static'], 'crew still read only their own profile');
});
