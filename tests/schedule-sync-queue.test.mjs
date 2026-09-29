import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { serverScheduleSyncOwned, scheduleSyncRequestId, scheduleSyncBackoffMinutes, selectScheduleSyncDue, recordScheduleSyncFailure, runScheduleSyncCommand, isScheduleSyncCommand, serverScheduleSyncActive, SCHEDULE_SYNC_BATCH_LIMIT, SCHEDULE_SYNC_WORKER_ID, SCHEDULE_SYNC_REVIEW_ATTEMPTS, SCHEDULE_SYNC_PARK_CODES } from '../functions/_lib/schedule-sync-queue.js';
import { resolveScheduledVisit, linkScheduledCustomer, bindScheduledProvider } from '../functions/_lib/operations-scheduling.js';
import { localInstant } from '../functions/_lib/operations-portal-records.js';
import { signOperationsEnvelope } from '../functions/_lib/operations-envelope.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { onRequestPost as portalBridge } from '../functions/api/operations-portal.js';
import { integrationStatusHandlers } from '../functions/api/integration-status.js';
import { runScheduleSyncTick, SCHEDULE_SYNC_WORKER_ACTOR_ID } from '../egc-platform/apps/api/src/schedule-sync-worker.ts';

const NOW = '2026-09-22T12:00:00.000Z', AT = new Date(NOW);
const ENV = Object.freeze({ EGC_SCHEDULE_SYNC_WORKER: 'true' });
const WORKER = Object.freeze({ id: 'schedule-sync-worker', kind: 'integration', role: 'integration', workspace: 'egc' });
const OWNER = Object.freeze({ id: 'zacb', kind: 'human', role: 'owner', workspace: 'egc' });
const minutes = n => new Date(Date.parse(NOW) + n * 60000).toISOString();
const DUE = { command: 'schedule.sync_due' };
// The worker's provider key: never the visit key the page sends with customer automations on, nor an MCP requestId.
const mirror = key => `${key}:mirror`;

// A provider-linked visit that dispatch rescheduled: pending, keyed by the dispatch requestId.
const visit = (id, extra = {}) => ({ id, type: 'job', customerId: 'customer-a', projectId: `project_${id}`, customer: 'Synthetic Customer', highlevelContactId: 'contact-a', date: '2026-09-30', time: '09:00', endTime: '11:00', status: 'scheduled', pipelineStatus: 'scheduled', address: '100 Synthetic Way', title: 'Synthetic garage job', providerSyncOwner: 'operations', syncStatus: 'pending', syncIdempotencyKey: randomUUID(), dispatchUpdatedAt: '2026-09-21T10:00:00.000Z', updatedAt: '2026-09-21T10:00:00.000Z', ...extra });

// In-memory Hub: revisioned rows, create/update preconditions, one write per document per commit.
function fixture(jobs = []) {
  const rows = new Map([['customers/customer-a', { id: 'customer-a', name: 'Synthetic Customer', highlevelContactId: 'contact-a', revision: 'customer-r1' }]]);
  const commits = [];
  let revision = 0;
  for (const job of jobs) {
    rows.set(`jobs/${job.id}`, { ...structuredClone(job), revision: `seed-${job.id}` });
    if (job.projectId) rows.set(`projects/${job.projectId}`, { id: job.projectId, customerId: 'customer-a', sourceRecordId: job.id, authority: 'employee_hub', revision: `seed-${job.projectId}` });
  }
  const store = {
    async due() { return { rows: [...rows.entries()].filter(([key, row]) => key.startsWith('jobs/') && ['pending', 'error', 'syncing'].includes(row.syncStatus)).map(([, row]) => structuredClone(row)), truncated: false }; },
    async read(collection, id) { return structuredClone(rows.get(`${collection}/${id}`) || null); },
    async commit(writes) {
      const targets = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, prior = rows.get(key);
        assert.ok(!targets.has(key), 'one write per document per commit'); targets.add(key);
        if (write.revision ? prior?.revision !== write.revision : Boolean(prior)) throw Object.assign(new Error('schedule_revision_conflict'), { code: 'schedule_revision_conflict', status: 409 });
      }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; rows.set(key, { ...rows.get(key), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` }); }
      commits.push(structuredClone(writes));
      return {};
    },
  };
  return { rows, store, commits, job: id => structuredClone(rows.get(`jobs/${id}`)), set: (id, patch) => rows.set(`jobs/${id}`, { ...rows.get(`jobs/${id}`), ...patch, revision: `r${++revision}` }) };
}

test('ownership: only provider-linked operations visits the calendar mirror alone can finish belong to the server', () => {
  const cases = [
    [visit('owned'), true],
    [visit('walkthrough', { type: 'walkthrough' }), true],
    [visit('cleanout', { type: 'cleanout' }), true],
    [visit('page-owned', { providerSyncOwner: '' }), false],
    [visit('blocked', { type: 'blocked' }), false],
    [visit('no-contact', { highlevelContactId: '' }), false],
    [visit('handoff-crm-pending', { handoffVersion: 1, handoffSyncStatus: 'pending' }), false],
    [visit('handoff-crm-done', { handoffVersion: 1, handoffSyncStatus: 'synced' }), true],
    [visit('cancelled-never-booked', { status: 'cancelled', pipelineStatus: 'cancelled' }), false],
    [visit('cancelled-booked', { status: 'cancelled', pipelineStatus: 'cancelled', highlevelAppointmentId: 'appointment-1' }), true],
    [visit('no-show-never-booked', { status: 'no_show', pipelineStatus: '' }), false],
  ];
  for (const [job, expected] of cases) assert.equal(serverScheduleSyncOwned(job), expected, job.id);
  for (const job of [visit('_egc_schedule_lock_2026-09-30'), visit('secure_abc'), visit('receipt', { recordType: 'schedule_operation' }), null, 'visit'])
    assert.equal(serverScheduleSyncOwned(job), false, 'private records never enter the queue');
  // The page's copy of the rule is evaluated from employee-suite.js itself.
  const line = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').split('\n').find(text => text.startsWith('function serverScheduleMirror('));
  assert.ok(line, 'employee-suite.js keeps serverScheduleMirror on one line');
  const mirror = S => vm.runInNewContext(`${line};serverScheduleMirror`, { S });
  const on = mirror({ integrationState: { loaded: true, error: '' }, integrations: { serverScheduleSync: true } });
  for (const [job, expected] of cases) assert.equal(on(job), expected, `page ${job.id}`);
  for (const S of [{ integrationState: { loaded: true, error: '' }, integrations: { serverScheduleSync: false } }, { integrationState: { loaded: false, error: '' }, integrations: { serverScheduleSync: true } }, { integrationState: { loaded: true, error: 'Configuration readiness is unavailable' }, integrations: { serverScheduleSync: true } }, { integrationState: { loaded: true, error: '' }, integrations: {} }])
    assert.equal(mirror(S)(visit('owned')), false, 'an off or unknown status keeps today\'s page retries');
});

test('sync_due selects owned pending, error and interrupted syncing visits whose retry time has come, oldest dispatch change first', async () => {
  const f = fixture([
    visit('newest', { dispatchUpdatedAt: '2026-09-22T11:00:00.000Z' }),
    visit('oldest', { dispatchUpdatedAt: '2026-09-20T08:00:00.000Z' }),
    visit('operations-mutated', { dispatchUpdatedAt: undefined, updatedAt: '2026-09-21T09:00:00.000Z' }),
    visit('backing-off', { syncStatus: 'error', syncIdempotencyKey: 'key-backing-off', syncFailureKey: mirror('key-backing-off'), syncNextRetryAt: minutes(5) }),
    visit('retry-now', { syncStatus: 'error', syncNextRetryAt: NOW, dispatchUpdatedAt: '2026-09-22T10:00:00.000Z' }),
    visit('malformed-retry', { syncStatus: 'error', syncNextRetryAt: 'soon', dispatchUpdatedAt: '2026-09-22T10:30:00.000Z' }),
    visit('rescheduled-after-failure', { syncNextRetryAt: minutes(600), syncFailureKey: 'an-older-key', dispatchUpdatedAt: '2026-09-22T09:00:00.000Z' }),
    // A page retry left 'syncing' by a closed tab is picked up once it is 10 minutes old; a live one is not.
    visit('interrupted', { syncStatus: 'syncing', syncLastAttemptAt: minutes(-10), dispatchUpdatedAt: '2026-09-22T10:45:00.000Z' }),
    visit('retrying-now', { syncStatus: 'syncing', syncLastAttemptAt: minutes(-9) }),
    visit('synced', { syncStatus: 'synced' }),
    visit('page-owned', { providerSyncOwner: '' }),
  ]);
  const result = await selectScheduleSyncDue(f.store, DUE, AT);
  assert.deepEqual(result.items.map(item => item.portalVisitId), ['oldest', 'operations-mutated', 'rescheduled-after-failure', 'retry-now', 'malformed-retry', 'interrupted', 'newest']);
  assert.deepEqual([result.counts, result.oldestFailureAt], [{ scanned: 10, owned: 9, due: 7, returned: 7, backingOff: 1, parked: 0 }, null]);
  assert.deepEqual([result.ok, result.authority, result.asOf, result.limit, result.coverage], [true, 'employee_hub', NOW, SCHEDULE_SYNC_BATCH_LIMIT, { complete: true, asOf: NOW }]);
  const oldest = f.job('oldest');
  assert.deepEqual(result.items[0], { portalVisitId: 'oldest', requestId: mirror(oldest.syncIdempotencyKey), expectedRevision: oldest.revision, type: 'job', syncStatus: 'pending', syncAttempts: 0, queuedAt: '2026-09-20T08:00:00.000Z', startAt: '2026-09-30T15:00:00.000Z', endAt: '2026-09-30T17:00:00.000Z' });
  assert.ok(!JSON.stringify(result).includes('Synthetic'), 'queue items carry no customer details');
  // The injected clock, not the real one, releases the backoff.
  assert.ok(!(await selectScheduleSyncDue(f.store, DUE, new Date(minutes(4)))).items.some(item => item.portalVisitId === 'backing-off'));
  assert.ok((await selectScheduleSyncDue(f.store, DUE, new Date(minutes(5)))).items.some(item => item.portalVisitId === 'backing-off'));
  assert.equal(f.commits.length, 0, 'the selector is read-only');
});

test('sync_due is bounded to 25 and validates its input', async () => {
  const f = fixture(Array.from({ length: 30 }, (_, i) => visit(`visit-${String(i).padStart(2, '0')}`, { dispatchUpdatedAt: `2026-09-21T10:${String(i).padStart(2, '0')}:00.000Z` })));
  const result = await selectScheduleSyncDue(f.store, DUE, AT);
  assert.deepEqual([result.items.length, result.counts.due, result.items[0].portalVisitId, result.items[24].portalVisitId], [25, 30, 'visit-00', 'visit-24']);
  assert.deepEqual((await selectScheduleSyncDue(f.store, { ...DUE, limit: 3 }, AT)).items.map(item => item.portalVisitId), ['visit-00', 'visit-01', 'visit-02']);
  for (const bad of [{ ...DUE, limit: 26 }, { ...DUE, limit: 0 }, { ...DUE, limit: '5' }, { ...DUE, limit: null }, { ...DUE, jobId: 'visit-00' }, { command: 'schedule.sync_failed' }, null])
    await assert.rejects(selectScheduleSyncDue(f.store, bad, AT), error => error.code === 'schedule_request_invalid' && error.status === 400, JSON.stringify(bad));
  const truncated = await selectScheduleSyncDue({ due: async () => ({ rows: [visit('only')], truncated: true }) }, DUE, AT);
  assert.deepEqual([truncated.items.length, truncated.coverage.complete], [1, false], 'a capped scan is reported, never presented as the whole queue');
});

test('the mirror keys a change by its sync key plus :mirror, else by a stable key that changes only with its mirrored schedule', async () => {
  const adopted = visit('adopted', { syncIdempotencyKey: undefined });
  const key = await scheduleSyncRequestId(adopted);
  assert.match(key, /^schedule-sync:adopted:[a-f0-9]{32}$/);
  assert.equal(await scheduleSyncRequestId({ ...adopted, updatedAt: minutes(30), syncAttempts: 4, syncStatus: 'error' }), key, 'bookkeeping writes keep the key');
  for (const change of [{ time: '10:00' }, { endDate: '2026-10-01' }, { status: 'cancelled', pipelineStatus: 'cancelled' }, { address: '200 Synthetic Way' }, { highlevelAppointmentId: 'appointment-1' }])
    assert.notEqual(await scheduleSyncRequestId({ ...adopted, ...change }), key, JSON.stringify(change));
  assert.equal(await scheduleSyncRequestId({ ...adopted, syncIdempotencyKey: 'walkthrough-handoff:1b4e28ba-2fa1-41d2-883f-0016d3cca427' }), 'walkthrough-handoff:1b4e28ba-2fa1-41d2-883f-0016d3cca427:mirror');
  assert.equal(await scheduleSyncRequestId({ ...adopted, syncIdempotencyKey: 'has spaces/and slashes' }), key, 'an unusable legacy key falls back to the derived one');
  const longest = 'k'.repeat(243);
  assert.deepEqual([(await scheduleSyncRequestId({ ...adopted, syncIdempotencyKey: longest })).length, await scheduleSyncRequestId({ ...adopted, syncIdempotencyKey: `${longest}k` })], [250, key], 'the mirror key stays within the 250-character provider key');
});

test('a multi-day visit is queued with its end on the end date in Denver time, across the DST change', async () => {
  const f = fixture([visit('multi-day', { date: '2026-10-30', time: '08:00', endDate: '2026-11-02', endTime: '12:00' })]);
  const [item] = (await selectScheduleSyncDue(f.store, DUE, AT)).items;
  assert.deepEqual([item.startAt, item.endAt], [localInstant('2026-10-30', '08:00'), localInstant('2026-11-02', '12:00')]);
  assert.deepEqual([item.startAt, item.endAt], ['2026-10-30T14:00:00.000Z', '2026-11-02T19:00:00.000Z']);
});

test('sync_failed records the error with a backoff counted per sync key, guarded by the selected revision', async () => {
  const f = fixture([visit('failing')]);
  const failure = async (at, extra = {}) => {
    const [item] = (await selectScheduleSyncDue(f.store, DUE, new Date(at))).items;
    assert.ok(item, `due at ${at}`);
    return recordScheduleSyncFailure(f.store, WORKER, { command: 'schedule.sync_failed', requestId: randomUUID(), portalVisitId: item.portalVisitId, expectedRevision: item.expectedRevision, syncRequestId: item.requestId, code: 'schedule_provider_sync_unavailable', ...extra }, at);
  };
  const first = await failure(NOW);
  assert.deepEqual([first.ok, first.syncStatus, first.syncAttempts, first.syncNextRetryAt], [true, 'error', 1, minutes(10)]);
  const saved = f.job('failing');
  assert.deepEqual([saved.syncError, saved.syncLastAttemptAt, saved.syncFailureKey, saved.syncFailedBy, saved.updatedAt], ['schedule_provider_sync_unavailable', NOW, mirror(saved.syncIdempotencyKey), 'schedule-sync-worker', NOW]);
  assert.deepEqual((await selectScheduleSyncDue(f.store, DUE, new Date(minutes(9)))).items, []);
  const second = await failure(minutes(10), { code: 'appointment_outcome_unknown' });
  assert.deepEqual([second.syncAttempts, second.syncNextRetryAt], [2, minutes(30)]);
  // A reschedule gets a new dispatch key: due at once, and its backoff starts over.
  f.set('failing', { time: '13:00', endTime: '15:00', syncStatus: 'pending', syncIdempotencyKey: randomUUID(), dispatchUpdatedAt: minutes(11) });
  const third = await failure(minutes(11));
  assert.deepEqual([third.syncAttempts, third.syncNextRetryAt], [1, minutes(21)]);
  assert.deepEqual([1, 2, 3, 7, 8, 9, 30].map(scheduleSyncBackoffMinutes), [10, 20, 40, 640, 1280, 1280, 1280]);
});

test('sync_failed refuses stale, replayed-with-changes, unowned and malformed failures without writing', async () => {
  const f = fixture([visit('guarded'), visit('page-owned', { providerSyncOwner: '' })]);
  const [item] = (await selectScheduleSyncDue(f.store, DUE, AT)).items;
  const body = (extra = {}) => ({ command: 'schedule.sync_failed', requestId: randomUUID(), portalVisitId: 'guarded', expectedRevision: item.expectedRevision, syncRequestId: item.requestId, code: 'schedule_provider_sync_unavailable', ...extra });
  const rejects = async (input, code, status) => { const before = f.commits.length; await assert.rejects(recordScheduleSyncFailure(f.store, WORKER, input, NOW), error => error.code === code && error.status === status, code); assert.equal(f.commits.length, before, `${code} writes nothing`); };
  await rejects(body({ expectedRevision: 'stale-revision', syncRequestId: 'an-older-change:mirror' }), 'schedule_revision_conflict', 409);
  await rejects(body({ syncRequestId: 'a-different-change' }), 'schedule_sync_changed_since_selection', 409);
  await rejects(body({ portalVisitId: 'missing' }), 'schedule_visit_not_found', 404);
  await rejects(body({ portalVisitId: 'page-owned', expectedRevision: f.job('page-owned').revision }), 'schedule_sync_not_pending', 409);
  for (const bad of [{ requestId: 'not-a-uuid' }, { portalVisitId: '_egc_schedule_lock_2026-09-30' }, { expectedRevision: '' }, { syncRequestId: 'has spaces' }, { code: 'Upstream said: token=synthetic' }, { extra: true }, { command: 'schedule.sync_due' }])
    await rejects(body(bad), 'schedule_request_invalid', 400);
  const input = body();
  const recorded = await recordScheduleSyncFailure(f.store, WORKER, input, NOW);
  const replay = await recordScheduleSyncFailure(f.store, WORKER, input, minutes(1));
  assert.deepEqual([replay.replayed, replay.syncAttempts, replay.syncNextRetryAt, replay.revision], [true, 1, recorded.syncNextRetryAt, recorded.revision], 'a replay returns the saved failure');
  await rejects({ ...input, code: 'schedule_provider_contact_mismatch' }, 'schedule_idempotency_conflict', 409);
  // Once the mirror lands (bind_provider marks it synced) a late failure is refused.
  f.set('guarded', { syncStatus: 'synced' });
  const synced = f.job('guarded');
  await rejects(body({ expectedRevision: recorded.revision }), 'schedule_revision_conflict', 409);
  await rejects(body({ expectedRevision: synced.revision }), 'schedule_sync_not_pending', 409);
});

test('a bookkeeping write during the sync keeps the failure, an interrupted page retry can fail, a live one is left alone', async () => {
  const f = fixture([visit('crew-edited'), visit('interrupted', { syncStatus: 'syncing', syncLastAttemptAt: minutes(-30) }), visit('manual-retry')]);
  const items = new Map((await selectScheduleSyncDue(f.store, DUE, AT)).items.map(item => [item.portalVisitId, item]));
  assert.deepEqual([...items.keys()].sort(), ['crew-edited', 'interrupted', 'manual-retry']);
  const fail = id => recordScheduleSyncFailure(f.store, WORKER, { command: 'schedule.sync_failed', requestId: randomUUID(), portalVisitId: id, expectedRevision: items.get(id).expectedRevision, syncRequestId: items.get(id).requestId, code: 'schedule_provider_sync_unavailable' }, NOW);
  // A crew field changed while the sync ran: the same key still awaits its mirror, so the backoff is recorded by CAS on the fresh revision.
  f.set('crew-edited', { assignedCrew: ['crew.one'], assignedTo: 'crew.one' });
  const edited = await fail('crew-edited');
  assert.deepEqual([edited.syncStatus, edited.syncAttempts, edited.syncNextRetryAt, f.job('crew-edited').assignedTo], ['error', 1, minutes(10), 'crew.one']);
  const interrupted = await fail('interrupted');
  assert.deepEqual([interrupted.syncStatus, interrupted.syncNextRetryAt], ['error', minutes(10)]);
  // A manager's retry started a minute ago: the worker's failure never overwrites it.
  f.set('manual-retry', { syncStatus: 'syncing', syncLastAttemptAt: minutes(-1), syncError: '' });
  const before = f.commits.length;
  await assert.rejects(fail('manual-retry'), error => error.code === 'schedule_revision_conflict');
  assert.deepEqual([f.commits.length, f.job('manual-retry').syncStatus], [before, 'syncing']);
});

test('a visit failing on one key is parked for manual review after 8 attempts, and the backlog is counted', async () => {
  const f = fixture([visit('poison'), visit('waiting', { dispatchUpdatedAt: '2026-09-21T11:00:00.000Z' })]);
  let at = Date.parse(NOW);
  const select = () => selectScheduleSyncDue(f.store, DUE, new Date(at));
  const fail = async () => {
    const item = (await select()).items.find(entry => entry.portalVisitId === 'poison');
    assert.ok(item, `poison is due at ${new Date(at).toISOString()}`);
    return recordScheduleSyncFailure(f.store, WORKER, { command: 'schedule.sync_failed', requestId: randomUUID(), portalVisitId: 'poison', expectedRevision: item.expectedRevision, syncRequestId: item.requestId, code: 'schedule_provider_sync_unavailable' }, new Date(at).toISOString());
  };
  assert.equal(SCHEDULE_SYNC_REVIEW_ATTEMPTS, 8);
  const first = await fail();
  let job = f.job('poison');
  assert.deepEqual([first.reviewRequired, job.syncFirstFailedAt, job.syncFailedAt, job.syncLastAttemptAt, job.syncReviewRequired], [false, NOW, NOW, NOW, false]);
  at += 60_000;
  const backingOff = await select();
  assert.deepEqual([backingOff.items.map(item => item.portalVisitId), backingOff.counts.backingOff, backingOff.counts.parked, backingOff.oldestFailureAt], [['waiting'], 1, 0, NOW]);
  for (let attempt = 2; attempt <= 8; attempt += 1) { at = Date.parse(f.job('poison').syncNextRetryAt); const result = await fail(); assert.equal(result.reviewRequired, attempt === 8, `attempt ${attempt}`); }
  job = f.job('poison');
  assert.deepEqual([job.syncWorkerAttempts, job.syncReviewRequired, job.syncFirstFailedAt, job.syncStatus], [8, true, NOW, 'error'], 'the first failure time is kept for the key');
  assert.equal(job.syncAttempts, undefined, 'the worker counts apart from the page\'s own syncAttempts');
  // Parked: never selected again on this key, however long it waits, and counted for the owner.
  at = Date.parse(job.syncNextRetryAt) + 7 * 24 * 60 * 60_000;
  const parked = await select();
  assert.deepEqual([parked.items.map(item => item.portalVisitId), parked.counts.parked, parked.counts.backingOff, parked.oldestFailureAt], [['waiting'], 1, 0, NOW]);
  // A new schedule change is a new key: queued again at once, its count starting over.
  f.set('poison', { time: '13:00', endTime: '15:00', syncStatus: 'pending', syncIdempotencyKey: randomUUID() });
  const requeued = await select();
  assert.deepEqual([requeued.items.map(item => item.portalVisitId).sort(), requeued.counts.parked, requeued.oldestFailureAt], [['poison', 'waiting'], 0, null]);
  assert.deepEqual([(await fail()).syncAttempts, f.job('poison').syncFirstFailedAt, f.job('poison').syncReviewRequired], [1, new Date(at).toISOString(), false]);
});

test('a ledger refusal no retry can clear parks the visit at once, and a manual Retry gives the worker a fresh budget', async () => {
  const f = fixture([visit('refused'), visit('outage', { dispatchUpdatedAt: '2026-09-21T11:00:00.000Z' })]);
  const fail = async (id, code, at = NOW) => {
    const item = (await selectScheduleSyncDue(f.store, DUE, new Date(at))).items.find(entry => entry.portalVisitId === id);
    assert.ok(item, `${id} is due at ${at}`);
    return recordScheduleSyncFailure(f.store, WORKER, { command: 'schedule.sync_failed', requestId: randomUUID(), portalVisitId: id, expectedRevision: item.expectedRevision, syncRequestId: item.requestId, code }, at);
  };
  assert.deepEqual(SCHEDULE_SYNC_PARK_CODES, ['appointment_idempotency_payload_conflict', 'appointment_changed_since_acceptance']);
  for (const code of SCHEDULE_SYNC_PARK_CODES) {
    // Each round is a new schedule change: a review flag left from an earlier key never parks the new one.
    f.set('refused', { syncStatus: 'pending', syncIdempotencyKey: randomUUID() });
    const parked = await fail('refused', code);
    assert.deepEqual([parked.syncAttempts, parked.reviewRequired, f.job('refused').syncReviewRequired, f.job('refused').syncWorkerAttempts], [1, true, true, 1], code);
    const week = await selectScheduleSyncDue(f.store, DUE, new Date(minutes(7 * 24 * 60)));
    assert.deepEqual([week.items.map(item => item.portalVisitId), week.counts.parked], [['outage'], 1], `${code} is never selected again on its key`);
  }
  const outage = await fail('outage', 'appointment_outcome_unknown');
  assert.deepEqual([outage.syncAttempts, outage.reviewRequired], [1, false], 'any other failure keeps retrying with backoff');
  // A manager's Retry: the page's 'syncing' write clears the park, then its own attempt fails (a plain page error write).
  const key = f.job('refused').syncFailureKey;
  f.set('refused', { syncStatus: 'syncing', syncAttempts: 1, syncLastAttemptAt: minutes(1), syncError: '', syncFailureKey: null, syncReviewRequired: false });
  f.set('refused', { syncStatus: 'error', syncError: 'HighLevel sync failed', syncNextRetryAt: minutes(11), syncAttempts: 1, syncLastAttemptAt: minutes(1), updatedAt: minutes(1) });
  assert.ok(!(await selectScheduleSyncDue(f.store, DUE, new Date(minutes(10)))).items.some(item => item.portalVisitId === 'refused'), 'the page\'s own backoff is respected');
  const resumed = await selectScheduleSyncDue(f.store, DUE, new Date(minutes(11)));
  const item = resumed.items.find(entry => entry.portalVisitId === 'refused');
  assert.deepEqual([item.requestId, item.syncAttempts, resumed.counts.parked], [key, 0, 0], 'unparked on the same key, with no worker attempts counted');
  const fresh = await fail('refused', 'schedule_provider_sync_unavailable', minutes(11));
  assert.deepEqual([fresh.syncAttempts, fresh.reviewRequired, f.job('refused').syncWorkerAttempts, f.job('refused').syncAttempts], [1, false, 1, 1], 'a fresh worker budget, and the page\'s count stays its own');
});

test('only the schedule-sync worker reaches the queue commands, only while the Hub flag is on, and sync_due records its check-in', async () => {
  const f = fixture([visit('queued')]);
  assert.equal(SCHEDULE_SYNC_WORKER_ID, SCHEDULE_SYNC_WORKER_ACTOR_ID);
  const failed = { command: 'schedule.sync_failed', requestId: randomUUID(), portalVisitId: 'queued', expectedRevision: f.job('queued').revision, syncRequestId: mirror(f.job('queued').syncIdempotencyKey), code: 'schedule_provider_sync_unavailable' };
  const otherIntegrations = ['operations-api', 'inbound-response-reconciler', 'booking-adoption-worker', 'schedule-sync:schedule-sync-worker', 'hub-schedule:zacb', 'mcp:chatgpt'].map(id => ({ ...WORKER, id }));
  for (const actor of [OWNER, { ...OWNER, role: 'manager' }, { id: 'mixed', kind: 'integration', role: 'owner', workspace: 'egc' }, { ...WORKER, kind: 'human' }, ...otherIntegrations, null])
    for (const command of [DUE, failed]) await assert.rejects(runScheduleSyncCommand(ENV, actor, command, { store: f.store, now: AT }), error => error.code === 'schedule_sync_queue_integration_only' && error.status === 403, JSON.stringify(actor));
  for (const env of [{}, { EGC_SCHEDULE_SYNC_WORKER: 'TRUE' }, { EGC_SCHEDULE_SYNC_WORKER: '1' }, { EGC_SCHEDULE_SYNC_WORKER: 'false' }])
    for (const command of [DUE, failed]) await assert.rejects(runScheduleSyncCommand(env, WORKER, command, { store: f.store, now: AT }), error => error.code === 'schedule_sync_queue_disabled' && error.status === 409, JSON.stringify(env));
  assert.equal(f.commits.length, 0);
  const due = await runScheduleSyncCommand(ENV, WORKER, DUE, { store: f.store, now: AT });
  assert.deepEqual([due.items.map(item => item.portalVisitId), due.heartbeat], [['queued'], true]);
  assert.deepEqual(f.commits.flat().map(write => [write.collection, write.id, write.patch]), [['scheduleSyncState', 'worker', { lastDueAt: NOW, workerId: 'schedule-sync-worker', updatedAt: NOW }]], 'the check-in is the only write, outside jobs');
  const later = await runScheduleSyncCommand(ENV, WORKER, DUE, { store: f.store, now: new Date(minutes(2)) });
  assert.deepEqual([later.heartbeat, f.rows.get('scheduleSyncState/worker').lastDueAt], [true, minutes(2)], 'each tick refreshes the check-in');
  assert.equal((await runScheduleSyncCommand(ENV, WORKER, failed, { store: f.store, now: AT })).syncStatus, 'error');
  const unwritable = { ...f.store, commit: async () => { throw Object.assign(new Error('schedule_commit_outcome_unknown'), { status: 503 }); } };
  assert.deepEqual((await runScheduleSyncCommand(ENV, WORKER, DUE, { store: unwritable, now: AT })).heartbeat, false, 'a failed check-in never blocks the queue');
  assert.deepEqual(['schedule.sync_due', 'schedule.sync_failed', 'schedule.sync_provider', 'toString', '__proto__'].map(name => isScheduleSyncCommand({ command: name })), [true, true, false, false, false]);
});

test('the signed Hub bridge routes the queue, queries Firestore for operations-owned rows by sync status and never reports an unreadable queue as empty', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const key = 'isolated-schedule-sync-signing-key-0123456789abcdef';
  const env = { EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: key, FIREBASE_API_KEY: 'firebase-test-schedule-sync', EGC_SCHEDULE_SYNC_WORKER: 'true' };
  const call = async (actor, body, extra = {}) => {
    const claims = { v: 1, iss: 'portal', aud: 'egc-portal', iat: Math.floor(Date.now() / 1000), nonce: randomUUID(), actor, request: { requestId: randomUUID(), body } };
    const response = await portalBridge({ request: new Request('https://easygaragecleaning.com/api/operations-portal', { method: 'POST', body: JSON.stringify({ envelope: await signOperationsEnvelope(claims, key) }) }), env: { ...env, ...extra } });
    return [response.status, await response.json()];
  };
  const doc = (id, fields, updateTime = '2026-09-22T11:00:00.000000Z') => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, ...(updateTime ? { updateTime } : {}), fields: encodeFirestoreFields(fields) }, readTime: NOW });
  const queries = [], commits = [];
  let answer = () => Response.json([doc('dispatch-owned', visit('dispatch-owned', { syncIdempotencyKey: 'dispatch-key-1' })), doc('page-owned', visit('page-owned', { providerSyncOwner: '' }))]);
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const target = new URL(url);
    assert.equal(target.hostname, 'firestore.googleapis.com', 'no other host is contacted');
    if (target.pathname.endsWith('/documents:runQuery')) { queries.push(JSON.parse(init.body)); return answer(); }
    if (target.pathname.endsWith('/documents/scheduleSyncState/worker')) { assert.equal(init.method || 'GET', 'GET'); return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 }); }
    assert.ok(target.pathname.endsWith('/documents:commit'), target.pathname);
    commits.push(JSON.parse(init.body));
    return Response.json({ writeResults: [{ updateTime: '2026-09-22T12:00:00.000000Z' }], commitTime: '2026-09-22T12:00:00.000000Z' });
  });
  // SEC-04 (BRIDGE-AUTHZ): the shared policy table refuses other principals before the queue's own check.
  assert.deepEqual(await call(OWNER, DUE), [403, { error: 'bridge_role_forbidden' }]);
  for (const id of ['operations-api', 'booking-adoption-worker', 'schedule-sync:schedule-sync-worker', 'mcp-service-grant']) assert.deepEqual(await call({ ...WORKER, id }, { command: 'schedule.sync_failed', requestId: randomUUID(), portalVisitId: 'dispatch-owned', expectedRevision: 'r1', syncRequestId: 'k:mirror', code: 'x' }), [403, { error: 'bridge_integration_forbidden' }], id);
  assert.deepEqual(await call(WORKER, DUE, { EGC_SCHEDULE_SYNC_WORKER: '' }), [409, { error: 'schedule_sync_queue_disabled' }]);
  assert.equal(queries.length, 0, 'refused calls never read storage');
  const [status, body] = await call(WORKER, DUE);
  assert.equal(status, 200);
  assert.deepEqual(body.items.map(item => [item.portalVisitId, item.requestId, item.expectedRevision]), [['dispatch-owned', 'dispatch-key-1:mirror', '2026-09-22T11:00:00.000000Z']]);
  assert.equal(body.heartbeat, true);
  assert.deepEqual(commits.map(commit => commit.writes.map(write => [write.update.name.split('/documents/')[1], write.currentDocument, write.updateMask.fieldPaths])), [[['scheduleSyncState/worker', { exists: false }, ['lastDueAt', 'workerId', 'updatedAt']]]], 'the only write is the check-in, outside jobs');
  const query = queries[0].structuredQuery;
  // Scoped to operations-owned rows, so legacy page-owned error rows never count toward the scan cap.
  assert.deepEqual(query.where, { compositeFilter: { op: 'AND', filters: [{ fieldFilter: { field: { fieldPath: 'providerSyncOwner' }, op: 'EQUAL', value: { stringValue: 'operations' } } }, { fieldFilter: { field: { fieldPath: 'syncStatus' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'pending' }, { stringValue: 'error' }, { stringValue: 'syncing' }] } } } }] } });
  const index = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8')).indexes.find(entry => entry.collectionGroup === 'jobs' && entry.fields.map(field => field.fieldPath).join() === 'providerSyncOwner,syncStatus');
  assert.deepEqual(index, { collectionGroup: 'jobs', queryScope: 'COLLECTION', fields: [{ fieldPath: 'providerSyncOwner', order: 'ASCENDING' }, { fieldPath: 'syncStatus', order: 'ASCENDING' }] }, 'the scoped query has its composite index');
  assert.ok(query.select.fields.some(field => field.fieldPath === 'syncLastAttemptAt'), 'an interrupted page retry is judged by its attempt time');
  for (const fieldPath of ['syncFailureKey', 'syncWorkerAttempts', 'syncReviewRequired']) assert.ok(query.select.fields.some(field => field.fieldPath === fieldPath), `the park is judged by ${fieldPath}`);
  assert.ok(!query.select.fields.some(field => field.fieldPath === 'syncAttempts'), 'the page\'s own attempt count plays no part in the worker\'s budget');
  assert.deepEqual([query.from, query.limit], [[{ collectionId: 'jobs' }], 1001]);
  assert.ok(query.select.fields.some(field => field.fieldPath === 'providerSyncOwner') && !query.select.fields.some(field => ['phone', 'email', 'customer', 'estimate'].includes(field.fieldPath)), 'a field mask limits the read');
  for (const [reply, code] of [[() => Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 }), 'schedule_sync_queue_unavailable'], [() => Response.json({ documents: [] }), 'schedule_sync_queue_incomplete'], [() => new Response('<html>', { status: 200 }), 'schedule_sync_queue_incomplete'], [() => Response.json([doc('no-revision', visit('no-revision'), '')]), 'schedule_sync_queue_incomplete']]) {
    answer = reply;
    assert.deepEqual(await call(WORKER, DUE), [503, { error: code }], code);
  }
  assert.equal(commits.length, 1, 'an unreadable queue records no check-in');
});

test('through the real Hub bridge, sync_failed commits the job failure with its hub_audit entry, and sync_due writes only the check-in', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const key = 'isolated-schedule-sync-signing-key-0123456789abcdef';
  const env = { EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: key, FIREBASE_API_KEY: 'firebase-test-schedule-sync', EGC_SCHEDULE_SYNC_WORKER: 'true' };
  const call = async body => {
    const claims = { v: 1, iss: 'portal', aud: 'egc-portal', iat: Math.floor(Date.now() / 1000), nonce: randomUUID(), actor: WORKER, request: { requestId: randomUUID(), body } };
    const response = await portalBridge({ request: new Request('https://easygaragecleaning.com/api/operations-portal', { method: 'POST', body: JSON.stringify({ envelope: await signOperationsEnvelope(claims, key) }) }), env });
    return [response.status, await response.json()];
  };
  // A Firestore double that keeps the job and its updateTime, so the failure writer's CAS and read-back are real.
  const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
  let job = visit('audited', { syncIdempotencyKey: 'dispatch-key-audited' }), updateTime = '2026-09-22T11:00:00.000000Z';
  const document = () => ({ name: `${ROOT}/jobs/audited`, updateTime, fields: encodeFirestoreFields(job) });
  const commits = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const target = new URL(url);
    assert.equal(target.hostname, 'firestore.googleapis.com');
    if (target.pathname.endsWith('/documents:runQuery')) return Response.json([{ document: document(), readTime: NOW }]);
    if (target.pathname.endsWith('/documents/jobs/audited')) return Response.json(document());
    if (target.pathname.endsWith('/documents/scheduleSyncState/worker')) return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    assert.ok(target.pathname.endsWith('/documents:commit'), target.pathname);
    const body = JSON.parse(init.body);
    commits.push(body);
    for (const write of body.writes) if (write.update.name === `${ROOT}/jobs/audited`) {
      assert.deepEqual(write.currentDocument, { updateTime }, 'the failure is written by CAS');
      job = { ...job, ...decodeFirestoreFields(write.update.fields) };
      updateTime = '2026-09-22T12:00:01.000000Z';
    }
    return Response.json({ writeResults: body.writes.map(() => ({ updateTime })), commitTime: updateTime });
  });
  const [dueStatus, due] = await call(DUE);
  assert.equal(dueStatus, 200);
  assert.deepEqual(due.items.map(item => [item.portalVisitId, item.requestId, item.expectedRevision]), [['audited', 'dispatch-key-audited:mirror', '2026-09-22T11:00:00.000000Z']]);
  const requestId = randomUUID();
  const [failedStatus, failed] = await call({ command: 'schedule.sync_failed', requestId, portalVisitId: 'audited', expectedRevision: due.items[0].expectedRevision, syncRequestId: due.items[0].requestId, code: 'schedule_provider_sync_unavailable' });
  assert.deepEqual([failedStatus, failed.syncStatus, failed.syncAttempts, failed.revision], [200, 'error', 1, '2026-09-22T12:00:01.000000Z']);
  const names = commits.map(commit => commit.writes.map(write => write.update.name.slice(ROOT.length + 1)));
  assert.deepEqual(names[0], ['scheduleSyncState/worker'], 'sync_due writes only the check-in, with no audit entry');
  assert.equal(names.length, 2, 'one commit per command');
  assert.equal(names[1].length, 2, 'the failure and its audit entry land in one commit');
  assert.equal(names[1][0], 'jobs/audited');
  assert.match(names[1][1], /^hub_audit\//);
  const audit = decodeFirestoreFields(commits[1].writes[1].update.fields);
  assert.deepEqual([audit.action, audit.entityKey, audit.actor, audit.requestId, audit.via], ['schedule.sync_failed', 'jobs/audited', { id: 'schedule-sync-worker', kind: 'integration', role: 'integration' }, requestId, 'bridge']);
  assert.deepEqual(JSON.parse(audit.after).syncStatus, 'error');
  assert.deepEqual(commits[1].writes[1].currentDocument, { exists: false }, 'the audit entry is create-only');
  assert.deepEqual([job.syncStatus, job.syncError, job.syncWorkerAttempts, job.syncFailureKey], ['error', 'schedule_provider_sync_unavailable', 1, 'dispatch-key-audited:mirror']);
});

// Mirrors the API's syncPortalSchedule over ReliableAppointments: resolve and link the saved Hub
// visit, then one ledger operation per resource and requestId, bound to its payload (toNotify
// included) and replayed under its OWN operation id after re-reading the provider event; an
// update whose provider state already matches is accepted without a write; then bind the event.
function fakeProvider(store) {
  const provider = { writes: [], ledger: new Map(), events: new Map(), failAfterWrite: 0 };
  const system = { id: 'schedule-sync:schedule-sync-worker', kind: 'integration', role: 'integration', workspace: 'egc' };
  const refused = code => Object.assign(new Error(code), { code, status: 409 });
  const same = (event, payload) => event && event.startTime === payload.startTime && event.endTime === payload.endTime && event.title === payload.title;
  provider.book = (id, visitRow) => provider.events.set(id, { id, contactId: visitRow.highlevelContactId, calendarId: 'calendar-jobs', title: visitRow.title, startTime: localInstant(visitRow.date, visitRow.time), endTime: localInstant(visitRow.endDate || visitRow.date, visitRow.endTime), appointmentStatus: 'confirmed' });
  provider.sync = async command => {
    const resolved = (await resolveScheduledVisit(store, command.portalVisitId)).visit;
    const { visit: saved } = await linkScheduledCustomer(store, system, { portalVisitId: command.portalVisitId, expectedRevision: resolved.revision, providerContact: { id: resolved.highlevelContactId, email: 'synthetic@example.invalid' } }, new Date(provider.at()).toISOString());
    const payload = { title: saved.title, startTime: saved.startTime, endTime: saved.endTimeInstant, appointmentStatus: 'confirmed', toNotify: command.runAutomations };
    const recorded = [...provider.ledger.values()].filter(op => op.portalVisitId === saved.portalVisitId).map(op => op.eventId);
    const providerId = saved.highlevelAppointmentId || recorded[0] || null;
    const key = `${providerId ? `appointment:${providerId}` : `create:portal:${saved.portalVisitId}`}:${command.requestId}`;
    let op = provider.ledger.get(key);
    if (op && JSON.stringify(op.payload) !== JSON.stringify(payload)) throw refused('appointment_idempotency_payload_conflict');
    if (!op) {
      let event = providerId ? provider.events.get(providerId) : null;
      if (!same(event, payload)) {
        event = { id: providerId || `appointment-${provider.events.size + 1}`, contactId: saved.highlevelContactId, calendarId: 'calendar-jobs', title: payload.title, startTime: payload.startTime, endTime: payload.endTime, appointmentStatus: 'confirmed' };
        provider.events.set(event.id, event);
        provider.writes.push({ kind: providerId ? 'update' : 'create', requestId: command.requestId, portalVisitId: saved.portalVisitId, ...payload });
      }
      op = { operationId: randomUUID(), portalVisitId: saved.portalVisitId, eventId: event.id, payload };
      provider.ledger.set(key, op);
    }
    const event = provider.events.get(op.eventId);
    if (!same(event, op.payload)) throw refused('appointment_changed_since_acceptance');
    if (provider.failAfterWrite > 0) { provider.failAfterWrite -= 1; throw Object.assign(new Error('socket hang up token=synthetic'), { code: 'schedule_provider_sync_unavailable', status: 503 }); }
    const latest = (await resolveScheduledVisit(store, command.portalVisitId)).visit;
    await bindScheduledProvider(store, system, { operationId: op.operationId, portalVisitId: command.portalVisitId, expectedRevision: latest.revision, event }, new Date(provider.at()).toISOString());
    return { ok: true, authority: 'employee_hub', providerSync: 'verified', portalVisitId: command.portalVisitId, operationId: op.operationId, appointmentId: event.id };
  };
  return provider;
}
// The API's OperationsService passthrough for the queue, the fake provider for sync_provider.
function worker(f, provider, clock, env = ENV) {
  const calls = [];
  provider.at = clock;
  const execute = async (actor, body, requestId) => {
    assert.deepEqual(actor, WORKER);
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    calls.push(structuredClone(body));
    if (body.command === 'schedule.sync_provider') return provider.sync(body);
    return runScheduleSyncCommand(env, actor, body, { store: f.store, now: new Date(clock()) });
  };
  return { calls, tick: () => runScheduleSyncTick({ execute, now: clock, requestId: randomUUID }) };
}
// What the page's syncJobRecord leaves behind when its own attempt fails: an unconditional merge.
const pageErrorWrite = (f, id, at) => f.set(id, { syncStatus: 'error', syncError: 'HighLevel sync failed', syncNextRetryAt: at, syncAttempts: 1, syncLastAttemptAt: NOW, updatedAt: NOW });
const counts = extra => ({ due: 0, selected: 0, synced: 0, notNeeded: 0, failed: 0, conflicts: 0, stateConflicts: 0, unrecorded: 0, deferred: 0, complete: true, heartbeat: true, ...extra });

test('rerunning the worker never repeats a provider write, and a multi-day visit mirrors its true end instant', async () => {
  let at = Date.parse(NOW);
  const f = fixture([visit('single'), visit('multi-day', { date: '2026-10-30', time: '08:00', endDate: '2026-11-02', endTime: '12:00', dispatchUpdatedAt: '2026-09-21T09:00:00.000Z' }), visit('page-owned', { providerSyncOwner: '' })]);
  const provider = fakeProvider(f.store), run = worker(f, provider, () => at);
  assert.equal(SCHEDULE_SYNC_WORKER_ACTOR_ID, WORKER.id);
  assert.deepEqual(await run.tick(), { status: 'completed', code: '', counts: counts({ due: 2, selected: 2, synced: 2 }), backlog: { owned: 2, backingOff: 0, parked: 0, oldestFailureMinutes: null } });
  assert.deepEqual(provider.writes.map(write => write.portalVisitId), ['multi-day', 'single']);
  const multiDay = provider.writes[0];
  assert.deepEqual([multiDay.startTime, multiDay.endTime], ['2026-10-30T14:00:00.000Z', '2026-11-02T19:00:00.000Z'], 'the end instant is on the end date, not the start date');
  assert.ok(provider.writes.every(write => write.toNotify === false), 'a calendar mirror never runs customer automations');
  assert.deepEqual(provider.writes.map(write => write.requestId), [mirror(f.job('multi-day').syncIdempotencyKey), mirror(f.job('single').syncIdempotencyKey)], 'requestId is the job\'s mirror key');
  assert.deepEqual(['single', 'multi-day'].map(id => [f.job(id).syncStatus, f.job(id).highlevelAppointmentId]), [['synced', 'appointment-2'], ['synced', 'appointment-1']]);
  for (const _ of [1, 2, 3]) { at += 120_000; assert.equal((await run.tick()).counts.selected, 0); }
  assert.equal(provider.writes.length, 2, 'reruns write nothing');
  assert.equal(f.job('page-owned').syncStatus, 'pending', 'the page keeps what the server does not own');
  assert.ok(!run.calls.some(body => body.portalVisitId === 'page-owned'));
});

test('a sync whose outcome was lost backs off, then replays the same key without a second provider write', async () => {
  let at = Date.parse(NOW);
  const f = fixture([visit('lost')]), provider = fakeProvider(f.store), run = worker(f, provider, () => at);
  provider.failAfterWrite = 1;
  assert.deepEqual((await run.tick()).counts, counts({ due: 1, selected: 1, failed: 1 }));
  const failed = f.job('lost');
  assert.deepEqual([failed.syncStatus, failed.syncError, failed.syncWorkerAttempts, failed.syncNextRetryAt], ['error', 'schedule_provider_sync_unavailable', 1, minutes(10)]);
  assert.ok(!JSON.stringify(failed).includes('token=synthetic'), 'provider error text is never stored');
  at = Date.parse(minutes(5));
  assert.equal((await run.tick()).counts.selected, 0, 'the backoff is respected');
  at = Date.parse(minutes(10));
  assert.equal((await run.tick()).counts.synced, 1);
  assert.equal(provider.writes.length, 1, 'the retry verified the accepted provider state instead of writing again');
  const keys = run.calls.filter(body => body.command === 'schedule.sync_provider').map(body => body.requestId);
  assert.deepEqual([keys.length, new Set(keys).size, keys[0]], [2, 1, mirror(failed.syncIdempotencyKey)]);
  assert.equal(f.job('lost').syncStatus, 'synced');
  // A reschedule during a later backoff is mirrored at once under its new key.
  provider.failAfterWrite = 1;
  f.set('lost', { time: '14:00', endTime: '16:00', syncStatus: 'pending', syncIdempotencyKey: randomUUID(), dispatchUpdatedAt: minutes(11) });
  at = Date.parse(minutes(11));
  assert.equal((await run.tick()).counts.failed, 1);
  f.set('lost', { time: '15:00', endTime: '17:00', syncStatus: 'pending', syncIdempotencyKey: randomUUID(), dispatchUpdatedAt: minutes(12) });
  at = Date.parse(minutes(12));
  assert.equal((await run.tick()).counts.synced, 1, 'a newer change is not held back by the older key\'s backoff');
  assert.deepEqual(provider.writes.map(write => [write.kind, write.startTime]), [['create', '2026-09-30T15:00:00.000Z'], ['update', '2026-09-30T20:00:00.000Z'], ['update', '2026-09-30T21:00:00.000Z']]);
});

test('a visit changed while its sync ran is left for the next tick instead of being marked failed', async () => {
  let at = Date.parse(NOW);
  const f = fixture([visit('moving'), visit('steady')]), provider = fakeProvider(f.store), run = worker(f, provider, () => at);
  const sync = provider.sync;
  provider.sync = async command => {
    if (command.portalVisitId !== 'moving') return sync(command);
    f.set('moving', { time: '10:00', endTime: '12:00', syncIdempotencyKey: randomUUID() });
    throw Object.assign(new Error('schedule_revision_conflict'), { code: 'schedule_revision_conflict', status: 409 });
  };
  assert.deepEqual((await run.tick()).counts, counts({ due: 2, selected: 2, synced: 1, conflicts: 1 }));
  assert.deepEqual([f.job('moving').syncStatus, f.job('moving').syncError], ['pending', undefined]);
  provider.sync = sync;
  at += 120_000;
  assert.equal((await run.tick()).counts.synced, 1);
  assert.equal(f.job('moving').syncStatus, 'synced');
});

test('an exact customer link is not rewritten, and a first link made during a failed sync still records its backoff', async () => {
  let at = Date.parse(NOW);
  const f = fixture([visit('linked'), visit('first-link', { projectId: undefined })]), provider = fakeProvider(f.store), run = worker(f, provider, () => at);
  provider.failAfterWrite = 99;
  // The first link of 'first-link' writes its project mid-sync; its sync key is unchanged, so the
  // failure is still recorded (on the fresh revision) instead of being retried every tick.
  assert.deepEqual((await run.tick()).counts, counts({ due: 2, selected: 2, failed: 2 }));
  assert.deepEqual([f.job('linked').syncStatus, f.job('linked').syncWorkerAttempts, f.job('first-link').syncStatus, f.job('first-link').syncWorkerAttempts, f.job('first-link').projectId], ['error', 1, 'error', 1, 'project_first-link']);
  at += 120_000;
  assert.equal((await run.tick()).counts.selected, 0, 'both back off');
  at = Date.parse(minutes(10));
  assert.deepEqual((await run.tick()).counts, counts({ due: 2, selected: 2, failed: 2 }));
  assert.deepEqual([f.job('linked').syncWorkerAttempts, f.job('first-link').syncWorkerAttempts], [2, 2]);
  const links = f.commits.filter(writes => writes.some(write => write.patch.providerSyncOwner === 'operations' && 'highlevelContactId' in write.patch));
  assert.equal(links.length, 1, 'only the first link wrote');
});

test('a replayed bind heals a page error write that landed after the mirror, and an exact replay writes nothing', async () => {
  const f = fixture([visit('bound')]);
  const system = { id: 'schedule-sync:schedule-sync-worker', kind: 'integration', role: 'integration', workspace: 'egc' };
  const event = { id: 'appointment-1', contactId: 'contact-a', calendarId: 'calendar-jobs', startTime: '2026-09-30T15:00:00.000Z', endTime: '2026-09-30T17:00:00.000Z', appointmentStatus: 'confirmed' };
  const operationId = randomUUID();
  const bind = at => bindScheduledProvider(f.store, system, { operationId, portalVisitId: 'bound', expectedRevision: f.job('bound').revision, event }, at);
  assert.equal((await bind(NOW)).providerSync, 'verified');
  const bound = f.commits.length;
  assert.equal((await bind(minutes(1))).replayed, true);
  assert.equal(f.commits.length, bound, 'an exact replay writes nothing');
  pageErrorWrite(f, 'bound', minutes(20));
  const healed = await bind(minutes(2));
  const job = f.job('bound');
  assert.deepEqual([healed.replayed, healed.visit.syncStatus, job.syncStatus, job.syncError, job.syncNextRetryAt, job.highlevelAppointmentId, job.syncedAt], [true, 'synced', 'synced', '', '', 'appointment-1', minutes(2)]);
  assert.deepEqual(Object.keys(f.commits.at(-1)[0].patch).sort(), ['highlevelAppointmentId', 'highlevelCalendarId', 'providerAppointmentStatus', 'syncError', 'syncNextRetryAt', 'syncStatus', 'syncedAt', 'updatedAt'], 'the heal touches sync fields only, never the schedule');
  // A replay whose schedule no longer matches the visit is refused and writes nothing.
  f.set('bound', { time: '10:00', endTime: '12:00', syncStatus: 'pending' });
  const before = f.commits.length;
  await assert.rejects(bind(minutes(3)), error => error.message === 'schedule_provider_state_conflict');
  assert.equal(f.commits.length, before);
});

test('a stale provider event for the appointment a synced visit holds re-queues the visit under a fresh drift key', async () => {
  // Another writer rescheduled the visit to 13:00 and mirrored it; a sync that resolved 09:00 then wrote 09:00.
  const f = fixture([visit('drifted', { time: '13:00', endTime: '15:00', syncStatus: 'synced', highlevelAppointmentId: 'appointment-1' }), visit('pending-change', { time: '13:00', endTime: '15:00', highlevelAppointmentId: 'appointment-2' })]);
  const system = { id: 'schedule-sync:schedule-sync-worker', kind: 'integration', role: 'integration', workspace: 'egc' };
  const stale = id => ({ id, contactId: 'contact-a', calendarId: 'calendar-jobs', startTime: '2026-09-30T15:00:00.000Z', endTime: '2026-09-30T17:00:00.000Z', appointmentStatus: 'confirmed' });
  const bind = (portalVisitId, event, operationId = randomUUID()) => bindScheduledProvider(f.store, system, { operationId, portalVisitId, expectedRevision: f.job(portalVisitId).revision, event }, NOW);
  const operationId = randomUUID();
  await assert.rejects(bind('drifted', stale('appointment-1'), operationId), error => error.message === 'schedule_provider_state_conflict');
  const job = f.job('drifted');
  assert.deepEqual([job.syncStatus, job.syncIdempotencyKey, job.syncError, job.syncNextRetryAt, job.syncDriftAt, job.time, job.highlevelAppointmentId], ['pending', `schedule-drift:${operationId}`, 'schedule_provider_drift', '', NOW, '13:00', 'appointment-1']);
  assert.deepEqual(f.commits.map(writes => writes.map(write => [write.id, Object.keys(write.patch).sort()])), [[['drifted', ['syncDriftAt', 'syncError', 'syncIdempotencyKey', 'syncNextRetryAt', 'syncStatus', 'updatedAt']]]], 'sync fields only: no receipt, no schedule change');
  assert.equal(await scheduleSyncRequestId(job), `schedule-drift:${operationId}:mirror`, 'the mirror of the correction never replays an earlier key');
  assert.deepEqual((await selectScheduleSyncDue(f.store, DUE, AT)).items.map(item => item.portalVisitId).sort(), ['drifted', 'pending-change']);
  // A visit that is not synced already awaits its own mirror: refused, nothing written.
  await assert.rejects(bind('pending-change', stale('appointment-2')), error => error.message === 'schedule_provider_state_conflict');
  // The re-queued visit is no longer 'synced', so a repeat of the stale bind writes nothing more.
  await assert.rejects(bind('drifted', stale('appointment-1'), operationId), error => error.message === 'schedule_provider_state_conflict');
  assert.equal(f.commits.length, 1);
  // A correct bind of the drift mirror clears it.
  const fixed = { ...stale('appointment-1'), startTime: '2026-09-30T19:00:00.000Z', endTime: '2026-09-30T21:00:00.000Z' };
  assert.equal((await bind('drifted', fixed)).providerSync, 'verified');
  assert.equal(f.job('drifted').syncStatus, 'synced');
});

test('a page error write after the worker bound a reschedule does not loop: the next tick heals it and the visit leaves the queue', async () => {
  let at = Date.parse(NOW);
  const booked = visit('rescheduled', { highlevelAppointmentId: 'appointment-1' });
  const f = fixture([booked]), provider = fakeProvider(f.store), run = worker(f, provider, () => at);
  provider.book('appointment-1', { ...booked, date: '2026-09-29' });
  assert.deepEqual((await run.tick()).counts, counts({ due: 1, selected: 1, synced: 1 }));
  assert.deepEqual(provider.writes.map(write => [write.kind, write.startTime]), [['update', '2026-09-30T15:00:00.000Z']]);
  pageErrorWrite(f, 'rescheduled', minutes(10));
  at = Date.parse(minutes(10));
  assert.deepEqual((await run.tick()).counts, counts({ due: 1, selected: 1, synced: 1 }));
  assert.deepEqual([f.job('rescheduled').syncStatus, f.job('rescheduled').syncError], ['synced', '']);
  for (const _ of [1, 2, 3, 4, 5]) { at += 120_000; assert.equal((await run.tick()).counts.selected, 0, 'healed visits leave the queue'); }
  assert.equal(provider.writes.length, 1, 'the heal never writes to the provider again');
  assert.equal(run.calls.filter(body => body.command === 'schedule.sync_provider').length, 2);
});

test('the mirror never shares a provider key with the page or MCP: page first then worker, and worker first then a manual retry', async () => {
  let at = Date.parse(NOW);
  const f = fixture([visit('page-first', { highlevelAppointmentId: 'appointment-1' }), visit('worker-first', { highlevelAppointmentId: 'appointment-2', dispatchUpdatedAt: '2026-09-21T11:00:00.000Z' })]);
  const provider = fakeProvider(f.store), run = worker(f, provider, () => at);
  provider.book('appointment-1', { ...f.job('page-first'), date: '2026-09-29' });
  provider.book('appointment-2', { ...f.job('worker-first'), date: '2026-09-29' });
  // The page wrote the provider under the visit's own key with automations on, then lost its bind.
  const pageKey = f.job('page-first').syncIdempotencyKey;
  provider.failAfterWrite = 1;
  await assert.rejects(provider.sync({ portalVisitId: 'page-first', requestId: pageKey, runAutomations: true }), error => error.code === 'schedule_provider_sync_unavailable');
  pageErrorWrite(f, 'page-first', NOW);
  assert.deepEqual((await run.tick()).counts, counts({ due: 2, selected: 2, synced: 2 }), 'no appointment_idempotency_payload_conflict');
  assert.deepEqual(provider.writes.map(write => [write.portalVisitId, write.requestId, write.toNotify]), [['page-first', pageKey, true], ['worker-first', mirror(f.job('worker-first').syncIdempotencyKey), false]], 'the page\'s accepted write is verified, not repeated');
  // A manager's manual retry after the worker mirrored the change: same visit key, automations on.
  pageErrorWrite(f, 'worker-first', minutes(30));
  const retried = await provider.sync({ portalVisitId: 'worker-first', requestId: f.job('worker-first').syncIdempotencyKey, runAutomations: true });
  assert.deepEqual([retried.providerSync, f.job('worker-first').syncStatus, provider.writes.length], ['verified', 'synced', 2]);
  // The same payload conflict the real ledger raises still guards one key against two payloads.
  await assert.rejects(provider.sync({ portalVisitId: 'worker-first', requestId: f.job('worker-first').syncIdempotencyKey, runAutomations: false }), error => error.code === 'appointment_idempotency_payload_conflict');
  at += 120_000;
  assert.equal((await run.tick()).counts.selected, 0);
});

// Loads the real employee-suite.js with a fake Hub API and runs the manager page-load retry. The fake
// Firestore records every write (merge sets and transactional sets) against its own copy of the jobs;
// onSync runs while /api/highlevel is in flight (a Hub write landing during the page's sync).
function page(serverScheduleSync, jobs, { onSync = () => {} } = {}) {
  const now = Date.parse(NOW), timeouts = [], calls = [], writes = [];
  const docs = new Map(jobs.map(job => [job.id, structuredClone(job)]));
  const merge = (id, update) => docs.set(id, { ...(docs.get(id) || {}), ...structuredClone(update) });
  const values = new Map([['egc_u', 'ZacB'], ['egc_business_access', 'true'], ['egc_owner', 'true'], ['egc_role', 'owner']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const response = (body, code = 200) => ({ ok: code < 400, status: code, json: async () => body });
  const context = {
    console, URLSearchParams, Intl, Promise, Set, Map, Error, JSON, Math, Number, String, Array, Object,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    sessionStorage: storage, localStorage: storage, navigator: {}, me: 'ZacB', location: { pathname: '/employee', search: '' },
    jobsCache: jobs.map(job => structuredClone(job)),
    db: {
      collection: collection => ({ doc: id => ({ collection, id, set: async (update, options) => { writes.push({ collection, id, update: structuredClone(update), options, transaction: false }); if (collection === 'jobs') merge(id, update); } }) }),
      runTransaction: async run => run({ get: async ref => ({ exists: docs.has(ref.id), data: () => structuredClone(docs.get(ref.id)) }), set: (ref, update, options) => { writes.push({ collection: ref.collection, id: ref.id, update: structuredClone(update), options, transaction: true }); merge(ref.id, update); } }),
    },
    setTimeout: (callback, delay) => { timeouts.push({ callback, delay }); return timeouts.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {}, document: { readyState: 'loading', hidden: false, activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  };
  context.window = context;
  context.hubFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url === '/api/integration-status') return serverScheduleSync === 'unavailable' ? response({ ok: false, error: 'Configuration readiness is unavailable' }, 503) : response({ ok: true, status: { highlevel: true, serverMessaging: true, serverScheduleSync } });
    if (url.startsWith('/api/employee-hub')) return response(init.method === 'POST' ? { ok: true, record: JSON.parse(init.body).data } : { ok: true, collections: {}, accounts: [] });
    if (url.startsWith('/api/employee-accounts')) return response({ ok: true, accounts: [] });
    if (url.startsWith('/api/highlevel?')) return response({ ok: true, pipelines: [], opportunities: [], events: [] });
    if (url === '/api/highlevel') { await onSync(JSON.parse(init.body), docs); return response({ ok: true, contactId: 'contact-a', appointmentId: 'appointment-page' }); }
    return response({ ok: false, error: 'unexpected' }, 404);
  };
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,loadAll,syncState,syncJobRecord}});})();');
  vm.runInNewContext(source, context);
  context.ui.S.active = 'availability';
  context.EGCAvailability = { mount() {}, unmount() {} };
  return {
    context, docs, writes,
    async load() {
      await context.ui.loadAll();
      const retry = timeouts.splice(0).filter(timer => timer.delay === 1500);
      assert.equal(retry.length, 1);
      retry[0].callback();
      for (let turn = 0; turn < 50; turn += 1) await new Promise(resolve => setImmediate(resolve));
    },
    synced: () => calls.filter(call => call.method === 'POST' && call.url === '/api/highlevel' && call.body?.tool === 'schedule').map(call => call.body.job_id).sort(),
  };
}

test('while the server owns the mirror, a manager page load stops auto-retrying those visits and keeps the rest', async () => {
  const jobs = [visit('server-owned'), visit('page-owned', { providerSyncOwner: '' }), visit('no-contact', { highlevelContactId: '' })];
  for (const [status, expected] of [[false, ['no-contact', 'page-owned', 'server-owned']], ['unavailable', ['no-contact', 'page-owned', 'server-owned']], [true, ['no-contact', 'page-owned']]]) {
    const hub = page(status, jobs);
    await hub.load();
    assert.deepEqual(hub.synced(), expected, String(status));
  }
  // A manager's explicit retry still works for a server-owned visit.
  const hub = page(true, jobs);
  await hub.load();
  await hub.context.opsRetrySync('server-owned');
  assert.deepEqual(hub.synced(), ['no-contact', 'page-owned', 'server-owned']);
});

test('when page loads own retries again, a backoff the worker wrote never delays them, and a parked visit reads as needing review', async () => {
  const later = minutes(1200);
  const workerFailure = at => ({ syncStatus: 'error', syncNextRetryAt: later, syncFailedBy: 'schedule-sync-worker', syncFailedAt: at, syncLastAttemptAt: at });
  const jobs = [
    visit('worker-failed', { ...workerFailure(minutes(-5)), syncWorkerAttempts: 6 }),
    // A page attempt after the worker's failure moved syncLastAttemptAt: the page's own backoff applies.
    visit('page-failed-after-worker', { ...workerFailure(minutes(-50)), syncLastAttemptAt: minutes(-5) }),
    visit('page-failed', { syncStatus: 'error', syncNextRetryAt: later, syncLastAttemptAt: minutes(-5) }),
  ];
  // Flag rolled back (or the worker silent, or status unknown): the page retries the worker's failure at once.
  for (const [status, expected] of [[false, ['worker-failed']], ['unavailable', ['worker-failed']], [true, []]]) {
    const hub = page(status, jobs);
    await hub.load();
    assert.deepEqual(hub.synced(), expected, String(status));
  }
  const { syncState } = page(true, jobs).context.ui;
  const label = job => /Sync needs review|Sync failed|Sync pending/.exec(syncState(job))?.[0];
  // The label follows the parked state (syncReviewRequired), whoever wrote the last failure: a page
  // attempt that failed after the worker parked the visit (it moved syncLastAttemptAt, so the failure
  // is no longer the worker's) leaves it parked, and the worker will not select it again until a
  // manual Retry clears syncReviewRequired and syncFailureKey. Before, that visit read 'Sync failed'
  // while nothing would ever retry it.
  assert.deepEqual([
    label(visit('parked', { ...workerFailure(NOW), syncWorkerAttempts: SCHEDULE_SYNC_REVIEW_ATTEMPTS, syncReviewRequired: true })),
    label(visit('retried-by-hand', { ...workerFailure(minutes(-5)), syncReviewRequired: true, syncLastAttemptAt: NOW })),
    label(visit('parked-at-once', { ...workerFailure(NOW), syncWorkerAttempts: 1, syncError: 'appointment_changed_since_acceptance', syncReviewRequired: true })),
    label(visit('manual-retry-failed', { ...workerFailure(minutes(-5)), syncLastAttemptAt: NOW, syncFailureKey: null, syncReviewRequired: false })),
    label(visit('backing-off', { ...workerFailure(NOW), syncReviewRequired: false })),
    label(visit('queued')),
  ], ['Sync needs review', 'Sync needs review', 'Sync needs review', 'Sync failed', 'Sync failed', 'Sync pending']);
  assert.match(syncState(visit('parked', { ...workerFailure(NOW), syncReviewRequired: true })), /opsRetrySync\('parked'\)/, 'the manager\'s Retry stays on the card');
});

test('a manual Retry clears the worker\'s park so it starts a fresh budget; a page-load retry leaves the park to the worker', async () => {
  const parked = visit('parked', { syncStatus: 'error', syncNextRetryAt: minutes(1200), syncFailedBy: 'schedule-sync-worker', syncFailedAt: minutes(-5), syncLastAttemptAt: minutes(-5), syncFailureKey: 'dispatch-key:mirror', syncWorkerAttempts: SCHEDULE_SYNC_REVIEW_ATTEMPTS, syncReviewRequired: true, syncAttempts: 2 });
  const syncing = hub => hub.writes.filter(write => write.id === 'parked' && write.update.syncStatus === 'syncing').map(write => write.update);
  // Flag rolled back: the page-load retry syncs the worker's failure at once but never touches the worker's park.
  const auto = page(false, [parked]);
  await auto.load();
  assert.deepEqual(syncing(auto), [{ syncStatus: 'syncing', syncAttempts: 3, syncLastAttemptAt: NOW, syncError: '' }]);
  // A manager's Retry, on one visit or Retry all, clears it; syncAttempts stays the page's own count.
  for (const retry of [hub => hub.context.opsRetrySync('parked'), hub => hub.context.opsRetryAll()]) {
    const hub = page(true, [parked]);
    await hub.load();
    await retry(hub);
    assert.deepEqual(syncing(hub), [{ syncStatus: 'syncing', syncAttempts: 3, syncLastAttemptAt: NOW, syncError: '', syncFailureKey: null, syncReviewRequired: false }]);
    assert.deepEqual([hub.docs.get('parked').syncStatus, hub.docs.get('parked').syncWorkerAttempts], ['synced', SCHEDULE_SYNC_REVIEW_ATTEMPTS]);
  }
  // A visit the worker never parked keeps today's write exactly.
  const plain = page(true, [visit('plain', { syncStatus: 'error', syncAttempts: 1 })]);
  await plain.load();
  await plain.context.opsRetrySync('plain');
  assert.deepEqual(plain.writes.filter(write => write.update.syncStatus === 'syncing').map(write => write.update), [{ syncStatus: 'syncing', syncAttempts: 2, syncLastAttemptAt: NOW, syncError: '' }]);
});

test('the page\'s synced write never overwrites a drift re-queue that landed while its sync ran, in every mode', async () => {
  const drift = 'schedule-drift:0f7c2a4e-5b6d-4e8f-9a1b-2c3d4e5f6a7b';
  // The Hub re-queued 'raced' while /api/highlevel was in flight (another writer's stale time reached HighLevel).
  const onSync = (body, docs) => { if (body.job_id === 'raced') docs.set('raced', { ...docs.get('raced'), syncStatus: 'pending', syncError: 'schedule_provider_drift', syncIdempotencyKey: drift, syncNextRetryAt: '' }); };
  const jobs = () => [visit('raced', { syncStatus: 'error', syncAttempts: 1 }), visit('steady', { syncStatus: 'error', syncAttempts: 1 })];
  // Flag off the page-load retry syncs both; flag on a manager retries them.
  for (const [status, run] of [[false, async () => {}], [true, async hub => { assert.equal(await hub.context.ui.syncJobRecord('raced', { manual: true }), false, 'reported as still queued'); assert.equal(await hub.context.ui.syncJobRecord('steady', { manual: true }), true); }]]) {
    const hub = page(status, jobs(), { onSync });
    await hub.load();
    await run(hub);
    assert.deepEqual(hub.synced(), ['raced', 'steady'], String(status));
    const raced = hub.docs.get('raced');
    assert.deepEqual([raced.syncStatus, raced.syncError, raced.syncIdempotencyKey], ['pending', 'schedule_provider_drift', drift], `${status}: the re-queue stands`);
    assert.ok(!hub.writes.some(write => write.id === 'raced' && ['synced', 'error'].includes(write.update.syncStatus)), `${status}: neither 'synced' nor 'error' was written over it`);
    assert.equal(hub.context.jobsCache.find(job => job.id === 'raced').syncStatus, 'pending', `${status}: the card shows the re-queue`);
    assert.deepEqual(hub.writes.filter(write => write.id === 'steady' && write.update.syncStatus === 'synced').map(write => [write.transaction, write.update.highlevelAppointmentId]), [[true, 'appointment-page']], `${status}: an ordinary success is written as before, inside a transaction`);
    assert.equal(hub.docs.get('steady').syncStatus, 'synced');
  }
});

test('integration status hands page retries to the server only while the flag is on and the worker checked in recently', async () => {
  const env = { HUB_SESSION_SECRET: 'synthetic-schedule-sync-session-secret', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-hash', displayName: 'Zac', role: 'owner' } }) };
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  let reads = 0;
  const status = async (extra, beat) => {
    const read = async () => { reads += 1; if (beat instanceof Error) throw beat; return beat; };
    const handlers = integrationStatusHandlers({ scheduleSync: (e, options) => serverScheduleSyncActive(e, { ...options, read }), now: () => AT });
    return (await (await handlers.get({ request: new Request('https://easygaragecleaning.com/api/integration-status', { headers: { Cookie: cookie } }), env: { ...env, ...extra } })).json()).status.serverScheduleSync;
  };
  const on = { EGC_SCHEDULE_SYNC_WORKER: 'true' };
  assert.deepEqual([await status({}, { lastDueAt: NOW }), await status({ EGC_SCHEDULE_SYNC_WORKER: 'yes' }, { lastDueAt: NOW })], [false, false]);
  assert.equal(reads, 0, 'with the flag off nothing is read');
  assert.deepEqual([await status(on, { lastDueAt: minutes(-9) }), await status(on, { lastDueAt: minutes(-10) }), await status(on, null), await status(on, { lastDueAt: 'soon' }), await status(on, { lastDueAt: minutes(5) }), await status(on, new Error('firestore unavailable'))],
    [true, false, false, false, false, false], 'a silent, missing, malformed, future or unreadable check-in keeps the page retrying');
});

test('the check-in is read from Firestore with a short timeout and an unreadable document is never an active worker', async t => {
  const env = { FIREBASE_API_KEY: 'firebase-test-schedule-sync', EGC_SCHEDULE_SYNC_WORKER: 'true' };
  let answer;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const target = new URL(url);
    assert.equal(target.hostname, 'firestore.googleapis.com');
    assert.ok(target.pathname.endsWith('/documents/scheduleSyncState/worker'), target.pathname);
    assert.ok(init.signal, 'the read is bounded');
    return answer();
  });
  const active = () => serverScheduleSyncActive(env, { now: AT });
  answer = () => Response.json({ name: 'projects/egcw-1ec83/databases/(default)/documents/scheduleSyncState/worker', updateTime: NOW, fields: encodeFirestoreFields({ lastDueAt: minutes(-2), workerId: 'schedule-sync-worker' }) });
  assert.equal(await active(), true);
  answer = () => Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
  assert.equal(await active(), false);
  answer = () => Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
  assert.equal(await active(), false);
  answer = () => { throw new Error('network down'); };
  assert.equal(await active(), false);
});
