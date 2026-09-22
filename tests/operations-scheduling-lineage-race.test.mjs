import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, webcrypto } from 'node:crypto';
import vm from 'node:vm';

// Execute the actual scheduling mutator, isolating only imported I/O and time/
// conflict helpers. This suite proves atomic dependency guards, not live
// Firestore, Denver time conversion, authentication, or provider delivery.
const source = readFileSync(new URL('../functions/_lib/operations-scheduling.js', import.meta.url), 'utf8');
function load() {
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, AbortSignal,
    localInstant: (date, time) => date && time ? `${date}T${time}:00.000Z` : null,
    scheduleRowsConflict: () => false,
    scheduleLockConflict: () => false,
    scheduleDayEntry: row => ({ id: row.id, status: row.status }),
    encodeFirestoreFields: value => value,
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
    '\nglobalThis.api = {mutateScheduledVisit, schedulingStorage};', context);
  return context.api;
}
const api = load();
const actor = { id: 'test-owner', kind: 'human', role: 'owner' };
const now = '2026-09-22T12:00:00.000Z';
function fixture() {
  const rows = new Map([
    ['customers/customer-1', { id: 'customer-1', revision: 'c1', name: 'Synthetic fixture', highlevelContactId: 'provider-1' }],
    ['jobs/walkthrough-1', { id: 'walkthrough-1', revision: 'w1', type: 'walkthrough', customerId: 'customer-1', highlevelContactId: 'provider-1', projectId: 'project-1', estimate: { total: 1234 }, payment: { verified: true, amount: 100 } }],
    ['projects/project-1', { id: 'project-1', revision: 'p1', customerId: 'customer-1', sourceRecordId: 'walkthrough-1' }],
  ]);
  let commits = 0, beforeCommit = () => {}, afterCommit = () => {};
  const store = {
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    day: async () => [], resources: async () => [], roster: async () => [],
    commit: async writes => {
      beforeCommit();
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, current = rows.get(key);
        assert.ok(!seen.has(key), `duplicate write: ${key}`); seen.add(key);
        if (write.revision ? current?.revision !== write.revision : Boolean(current))
          throw Object.assign(new Error('schedule_revision_conflict'), { status: 409 });
      }
      commits++;
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`;
        rows.set(key, { ...rows.get(key), ...structuredClone(write.patch), id: write.id, revision: `saved-${commits}-${key}` });
      }
      afterCommit();
    },
  };
  const input = { mode: 'create', requestId: randomUUID(), portalCustomerId: 'customer-1', kind: 'job', sourceWalkthroughId: 'walkthrough-1', changes: { date: '2026-09-23', time: '08:00', endTime: '09:00' } };
  return { rows, store, input, run: () => api.mutateScheduledVisit(store, actor, input, now), commits: () => commits,
    before: fn => { beforeCommit = fn; }, after: fn => { afterCommit = fn; } };
}

for (const [key, change] of [
  ['customers/customer-1', { highlevelContactId: 'different-provider' }],
  ['jobs/walkthrough-1', { customerId: 'different-customer' }],
  ['projects/project-1', { customerId: 'different-customer' }],
]) {
  test(`concurrent change to ${key} aborts the whole booking`, async () => {
    const f = fixture();
    f.before(() => Object.assign(f.rows.get(key), change, { revision: 'concurrently-changed' }));
    await assert.rejects(f.run(), error => error.message === 'schedule_revision_conflict');
    assert.equal(f.commits(), 0);
    assert.equal([...f.rows.values()].filter(row => row.type === 'job' || row.recordType === 'schedule_operation').length, 0);
    assert.equal(f.rows.has('dispatchState/revision'), false);
  });
}

for (const key of ['customers/customer-1', 'jobs/walkthrough-1', 'projects/project-1']) {
  test(`missing revision on ${key} fails closed before commit`, async () => {
    const f = fixture(); delete f.rows.get(key).revision;
    await assert.rejects(f.run(), error => error.message === 'schedule_source_unavailable');
    assert.equal(f.commits(), 0);
  });
}

test('a valid handoff preserves lineage, original financial evidence, and one replayable receipt', async () => {
  const f = fixture(), first = await f.run(), replay = await f.run();
  assert.equal(first.visit.portalProjectId, 'project-1');
  assert.equal(f.rows.get(`jobs/${first.visit.portalVisitId}`).sourceWalkthroughId, 'walkthrough-1');
  assert.equal(replay.visit.portalVisitId, first.visit.portalVisitId);
  assert.equal(replay.replayed, true); assert.equal(f.commits(), 1);
  assert.deepEqual(f.rows.get('jobs/walkthrough-1').estimate, { total: 1234 });
  assert.deepEqual(f.rows.get('jobs/walkthrough-1').payment, { verified: true, amount: 100 });
  assert.equal(f.rows.get(`jobs/${first.visit.portalVisitId}`).payment, undefined);
  assert.equal(f.rows.get(`jobs/${first.visit.portalVisitId}`).estimate, undefined);
});

test('commit-then-timeout recovers the same booking without a duplicate', async () => {
  const f = fixture(); f.after(() => { throw new Error('lost response'); });
  const first = await f.run(), replay = await f.run();
  assert.equal(first.visit.portalVisitId, replay.visit.portalVisitId);
  assert.equal(f.commits(), 1);
});

test('Firestore adapter serializes dependency revisions as updateTime preconditions', async () => {
  let sent;
  const store = api.schedulingStorage({}, async (_env, _url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  });
  await store.commit([{ collection: 'customers', id: 'customer-1', revision: 'original-revision', patch: { id: 'customer-1' } }]);
  assert.deepEqual(sent.writes[0].currentDocument, { updateTime: 'original-revision' });
  assert.deepEqual(sent.writes[0].updateMask, { fieldPaths: ['id'] });
});
