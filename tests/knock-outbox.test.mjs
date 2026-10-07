import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { createOutbox, forServer, openKnockStore, classify } from '../crew/knock-outbox.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = (n, user = 'Rep.One', extra = {}) => ({ id: id(n), user, type: 'knock', houseId: 'h-1', outcome: 'no_answer', at: '2026-10-06T17:00:00.000Z', ...extra });
const plain = value => JSON.parse(JSON.stringify(value));

function transport(script) {
  const sent = [];
  const fn = async events => {
    sent.push(events);
    const step = script.shift();
    if (step instanceof Error) throw step;
    return step ? step(events) : { results: events.map(e => ({ id: e.id, status: 'applied' })) };
  };
  return Object.assign(fn, { sent });
}

test('events persist in IndexedDB across a reload and sync oldest first, one account at a time', async () => {
  const indexedDB = fakeIndexedDB();
  const first = createOutbox(await openKnockStore(indexedDB), { transport: transport([]) });
  await first.enqueue(event(1));
  await first.enqueue(event(2, 'Rep.Two'));
  await first.enqueue(event(3, 'Rep.One', { _prev: { lastOutcome: null } }));
  await first.enqueue(event(1));
  assert.equal((await first.list('Rep.One')).length, 2, 'the same id is queued once');

  // A reload opens the same database: nothing is lost.
  const send = transport([]);
  const reopened = createOutbox(await openKnockStore(indexedDB), { transport: send });
  const result = await reopened.flush({ user: 'Rep.One' });
  assert.deepEqual([result.applied, result.remaining], [2, 0]);
  assert.deepEqual(send.sent[0].map(e => e.id), [id(1), id(3)]);
  assert.equal('_prev' in send.sent[0][1], false, 'phone-only fields never leave the phone');
  assert.equal('user' in send.sent[0][0] || 'seq' in send.sent[0][0], false);
  assert.deepEqual(plain(await reopened.list('Rep.Two')).map(e => e.id), [id(2)], 'another account\'s events wait for that account');
});

test('no signal keeps everything queued; an expired sign-in stops without losing anything', async () => {
  const store = await openKnockStore(fakeIndexedDB());
  const offline = createOutbox(store, { transport: transport([Object.assign(new Error('No connection'), { status: 0 })]) });
  for (let n = 1; n <= 5; n++) await offline.enqueue(event(n));
  const noSignal = await offline.flush({ user: 'Rep.One' });
  assert.deepEqual([noSignal.stopped.reason, noSignal.remaining], ['network', 5]);

  const expired = createOutbox(store, { transport: transport([Object.assign(new Error('Sign in'), { status: 401 })]) });
  const auth = await expired.flush({ user: 'Rep.One' });
  assert.deepEqual([auth.stopped.reason, auth.remaining], ['auth', 5]);

  const back = transport([]);
  const online = createOutbox(store, { transport: back });
  const synced = await online.flush({ user: 'Rep.One' });
  assert.deepEqual([synced.applied, synced.remaining], [5, 0]);
  assert.equal(back.sent.length, 1);
});

test('a refused event is kept as a problem with its reason; duplicates count as synced; batches are capped', async () => {
  const store = await openKnockStore(fakeIndexedDB());
  const send = transport([
    events => ({ results: events.map((e, i) => i === 1 ? { id: e.id, status: 'rejected', code: 'knock_not_assigned', error: 'Not your territory' } : { id: e.id, status: i === 0 ? 'duplicate' : 'applied' }) }),
  ]);
  const outbox = createOutbox(store, { transport: send, batchSize: 3 });
  for (let n = 1; n <= 4; n++) await outbox.enqueue(event(n));
  const result = await outbox.flush({ user: 'Rep.One' });
  assert.deepEqual([result.applied, result.rejected, result.remaining], [3, 1, 0]);
  assert.deepEqual(send.sent.map(batch => batch.length), [3, 1]);
  const [problem] = await outbox.list('Rep.One');
  assert.deepEqual([problem.id, problem.state, problem.error.code], [id(2), 'error', 'knock_not_assigned']);
  await outbox.retry(id(2));
  assert.equal((await outbox.list('Rep.One'))[0].state, 'queued');
});

test('an unsent door can be edited or removed in place; a sent one cannot', async () => {
  const outbox = createOutbox(await openKnockStore(fakeIndexedDB()), { transport: transport([]) });
  await outbox.enqueue(event(1, 'Rep.One', { quotedAmount: 900 }));
  await outbox.amend(id(1), row => { const next = { ...row, outcome: 'come_back' }; delete next.quotedAmount; return next; });
  const [edited] = plain(await outbox.list('Rep.One'));
  assert.deepEqual([edited.outcome, 'quotedAmount' in edited], ['come_back', false]);
  await outbox.remove(id(1));
  assert.deepEqual(await outbox.list('Rep.One'), []);
  assert.equal(await outbox.amend(id(9), { outcome: 'look' }), null);
});

test('without IndexedDB the queue still works in memory and says it is not persistent', async () => {
  const store = await openKnockStore(undefined);
  assert.equal(store.persistent, false);
  const outbox = createOutbox(store, { transport: transport([]) });
  await outbox.enqueue(event(1));
  assert.equal((await outbox.flush({ user: 'Rep.One' })).applied, 1);
  await store.cache.set('me', { rep: 'x' });
  assert.deepEqual(await store.cache.get('me'), { rep: 'x' });
});

test('the cache round-trips values by key and errors classify as network, auth, transient or rejected', async () => {
  const store = await openKnockStore(fakeIndexedDB());
  await store.cache.set('houses:rep.one', [{ id: 'h-1' }]);
  assert.deepEqual(plain(await store.cache.get('houses:rep.one')), [{ id: 'h-1' }]);
  assert.equal(await store.cache.get('missing'), null);
  assert.deepEqual([classify({ status: 0 }), classify({ status: 401 }), classify({ status: 503 }), classify({ status: 403 })], ['network', 'auth', 'transient', 'rejected']);
  assert.deepEqual(forServer({ id: 'a', user: 'u', seq: 1, state: 'queued', _prev: 1, type: 'knock' }), { id: 'a', type: 'knock' });
});
