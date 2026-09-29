// GHL-TRACK-1 endpoints and first attempts. POST /api/ghl-tag-drain answers only the egc-worker's signed v2 envelope
// for exactly that path (the messaging-cron service auth) and the ghl-tag-worker actor; managers read the stuck count
// and retry. /api/dispatch and /api/walkthrough-visit start the first attempt with waitUntil after a save, and the
// browser's /api/highlevel schedule sync leaves an outbox-owned visit's tags to the outbox and hands it the attempt once
// the appointment and contact are linked. Synthetic data, fixed clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { servicePublicKeySet, signServiceRequest } from '../egc-platform/services/operations/src/service-auth.ts';
import { verifyApiServiceEnvelope } from '../functions/_lib/operations-service-auth.js';
import { GHL_TAG_DRAIN_PATH, ghlTagDrainHandlers } from '../functions/api/ghl-tag-drain.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { walkthroughVisitHandlers } from '../functions/api/walkthrough-visit.js';
import { GHL_TAG_OUTBOX, drainGhlTagOutbox, firstGhlTagAttempt, ghlTagChangeKey, ghlTagEntryId, ghlTagOutboxStorage, scheduleTagWrites } from '../functions/_lib/ghl-tag-outbox.js';
import { recordingHighLevel } from './helpers/highlevel-recorder.mjs';
import { FLAG_OFF_ENV, FLAG_OFF_JOBS, FLAG_OFF_REQUESTS, highLevelRequestLog } from './helpers/ghl-track-fixture.mjs';

const NOW = '2026-09-22T12:00:00.000Z', AT = Date.parse(NOW), ORIGIN = 'https://easygaragecleaning.com';
const API_ROOT = 'synthetic-ghl-tag-drain-api-root-secret-0123456789';
const ENV = Object.freeze({ HUB_SESSION_SECRET: 'synthetic-ghl-tag-drain-session-secret-0123456789', HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: 'location-1', EGC_GHL_TAG_OUTBOX: 'true' });
const WORKER = Object.freeze({ id: 'ghl-tag-worker', kind: 'integration', role: 'integration', workspace: 'egc' });
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const crew = { user: 'crew1', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false };
// A booked visit the calendar mirror has already written to HighLevel (its tags go only with an appointment).
const visit = { type: 'walkthrough', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'contact-1', highlevelAppointmentId: 'appt-seeded', syncStatus: 'synced', date: '2026-09-23', time: '09:00', endTime: '10:00', status: 'scheduled', pipelineStatus: 'scheduled', notify: true };

function memory() {
  const rows = new Map(); let n = 0;
  const all = prefix => [...rows].filter(([key]) => key.startsWith(prefix + '/')).map(([, row]) => structuredClone(row));
  const store = {
    ghlTagOutbox: true, rows,
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { status: 409 }); }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` });
    },
    due: async () => ({ rows: all(GHL_TAG_OUTBOX).filter(row => row.status === 'pending'), truncated: false }),
    parked: async () => ({ rows: all(GHL_TAG_OUTBOX).filter(row => row.status === 'parked'), truncated: false }),
    entries: () => all(GHL_TAG_OUTBOX),
  };
  return store;
}
async function seeded(count = 1) {
  const store = memory();
  for (let i = 0; i < count; i++) {
    const id = `visit-${i}`, job = { ...visit, id }, tags = await scheduleTagWrites({ jobId: id, after: job, action: 'schedule.create', requestId: randomUUID(), now: NOW });
    await store.commit([{ collection: 'jobs', id, patch: { ...job, ghlTagEntry: tags.pointer } }, tags.write]);
  }
  return store;
}

// The real Hub verifier with the API key pinned in memory and a create-only nonce ledger.
function signed() {
  const nonces = new Set(), keys = servicePublicKeySet({ service: 'api', rootSecret: API_ROOT, workspace: 'egc' });
  const firestoreFetch = async (_env, url, init) => {
    const body = JSON.parse(init.body), name = body.writes[0].update.name;
    if (nonces.has(name)) return new Response('{}', { status: 409 });
    nonces.add(name); return Response.json({});
  };
  return (env, token, path, options) => verifyApiServiceEnvelope(env, token, path, { ...options, resolveKey: async () => (await keys).keys[0], firestoreFetch });
}
const envelope = ({ actor = WORKER, path = GHL_TAG_DRAIN_PATH, body = { command: 'ghl_tags.drain' } } = {}) => signServiceRequest({ service: 'api', rootSecret: API_ROOT, workspace: 'egc', path, actor, request: { requestId: randomUUID(), body }, now: AT });
const post = (handlers, body, { env = ENV, headers = {}, waitUntil } = {}) => handlers.post({ request: new Request(`${ORIGIN}${GHL_TAG_DRAIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, waitUntil });
const json = async response => ({ status: response.status, body: await response.json() });

test('the signed worker tick drains due entries: exactly the ghl-tag-worker, this path, one use per envelope', async () => {
  const store = await seeded(2), ghl = recordingHighLevel();
  const handlers = ghlTagDrainHandlers({ verify: signed(), storage: () => store, now: () => new Date(NOW), fetcher: ghl.fetcher });
  const token = await envelope();
  const first = await json(await post(handlers, { envelope: token }));
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.summary.due, first.body.summary.done], [2, 2]);
  assert.deepEqual(ghl.lines(), ['POST /contacts/contact-1/tags', 'POST /contacts/contact-1/tags']);
  assert.deepEqual([first.body.checkedIn, store.rows.get('ghlTagDrainState/worker').lastRunAt], [true, NOW], 'a completed pass is the worker\'s check-in');
  store.rows.delete('ghlTagDrainState/worker');
  assert.deepEqual((await json(await post(handlers, { envelope: token }))), { status: 409, body: { ok: false, code: 'ghl_tag_drain_replayed', error: 'This signed request was already used. Sign a new request.' } });
  const refused = async (options, expected) => { const result = await json(await post(handlers, { envelope: await envelope(options) })); assert.deepEqual([result.status, result.body.code], expected, JSON.stringify(options)); };
  await refused({ actor: { ...WORKER, id: 'messaging-cron-worker' } }, [403, 'ghl_tag_drain_forbidden']);
  await refused({ actor: { ...WORKER, id: 'schedule-sync-worker' } }, [403, 'ghl_tag_drain_forbidden']);
  const otherWorkspace = await json(await post(handlers, { envelope: await envelope() }, { env: { ...ENV, EGC_OPERATIONS_WORKSPACE: 'other' } }));
  assert.deepEqual([otherWorkspace.status, otherWorkspace.body.code], [401, 'ghl_tag_drain_unauthorized'], 'an envelope for another workspace is refused');
  await refused({ path: '/api/messaging-cron' }, [401, 'ghl_tag_drain_unauthorized']);
  await refused({ body: { command: 'ghl_tags.drain', limit: 50 } }, [400, 'ghl_tag_drain_command_invalid']);
  const off = await json(await post(handlers, { envelope: await envelope() }, { env: { ...ENV, EGC_GHL_TAG_OUTBOX: 'TRUE' } }));
  assert.deepEqual([off.status, off.body.code], [409, 'ghl_tag_outbox_disabled']);
  const legacy = await json(await post(handlers, { envelope: await envelope() }, { env: { ...ENV, EGC_OPERATIONS_SERVICE_AUTH: 'legacy' } }));
  assert.deepEqual([legacy.status, legacy.body.code], [503, 'ghl_tag_drain_not_configured']);
  assert.equal(ghl.calls.length, 2, 'no refused request reached HighLevel');
  assert.equal(store.rows.has('ghlTagDrainState/worker'), false, 'a refused, replayed or switched-off tick is no check-in');
  const waiting = await seeded();
  const unconfigured = await json(await post(ghlTagDrainHandlers({ verify: signed(), storage: () => waiting, now: () => new Date(NOW), fetcher: ghl.fetcher }), { envelope: await envelope() }, { env: { ...ENV, HIGHLEVEL_API_KEY: '' } }));
  assert.deepEqual([unconfigured.status, unconfigured.body.code], [503, 'ghl_tag_highlevel_not_configured']);
  assert.deepEqual(waiting.entries().map(entry => [entry.status, entry.attempts]), [['pending', 0]], 'nothing is claimed or counted while HighLevel is not configured');
  assert.equal(waiting.rows.has('ghlTagDrainState/worker'), false, 'a pass that could not run is no check-in');
});

test('flag on, sync-worker mode, no drain ticks: the stuck view counts the waiting visit and says the worker stopped; Retry and a tick clear it', async () => {
  const store = memory(), ghl = recordingHighLevel();
  // Booked in worker mode: the save's only first attempt waited for the appointment, then the schedule-sync worker wrote it.
  const job = { ...visit, id: 'visit-worker', date: '2026-09-30', providerSyncOwner: 'operations' };
  const tags = await scheduleTagWrites({ jobId: job.id, after: job, action: 'schedule.create', requestId: randomUUID(), now: NOW });
  await store.commit([{ collection: 'jobs', id: job.id, patch: { ...job, ghlTagEntry: tags.pointer } }, { ...tags.write, patch: { ...tags.write.patch, waits: 1, waitingFor: 'appointment', nextAttemptAt: '2026-09-22T12:01:00.000Z' } }]);
  let clock = Date.parse('2026-09-22T12:10:00.000Z');
  const handlers = ghlTagDrainHandlers({ verify: signed(), session: async () => owner, storage: () => store, now: () => new Date(clock), fetcher: ghl.fetcher });
  const get = async () => (await json(await handlers.get({ request: new Request(`${ORIGIN}${GHL_TAG_DRAIN_PATH}?view=stuck`), env: ENV }))).body;
  const early = await get();
  assert.deepEqual([early.visits, early.drain], [0, { lastRunAt: null, minutesSince: null, stale: true }], 'nine minutes past due is not stuck yet, but the worker never checked in');
  clock = Date.parse('2026-09-22T12:30:00.000Z');
  const stuck = await get();
  assert.deepEqual([stuck.visits, stuck.entries, stuck.parked, stuck.overdue, stuck.jobIds, stuck.drain.stale], [1, 1, 0, 1, ['visit-worker'], true]);
  assert.deepEqual(ghl.calls, [], 'nothing was told while the worker was stopped');
  // Retry puts it through at once, without the worker.
  const background = [];
  const retried = await json(await post(handlers, { action: 'retry', requestId: randomUUID(), jobId: 'visit-worker' }, { headers: { Origin: ORIGIN }, waitUntil: promise => background.push(promise) }));
  assert.deepEqual([retried.status, retried.body.requeued], [200, 1]);
  await Promise.all(background);
  assert.deepEqual(tagCalls({ calls: ghl.calls }).map(call => call.body.tags), [['egc-hub-scheduled', 'egc-walkthrough-scheduled', 'egc-reminder-2d']]);
  assert.equal((await get()).visits, 0);
  // The worker comes back: its signed tick checks in and the Hub stops saying it stopped, until it goes quiet again.
  const token = await signServiceRequest({ service: 'api', rootSecret: API_ROOT, workspace: 'egc', path: GHL_TAG_DRAIN_PATH, actor: WORKER, request: { requestId: randomUUID(), body: { command: 'ghl_tags.drain' } }, now: clock });
  const tick = await json(await post(handlers, { envelope: token }));
  assert.deepEqual([tick.status, tick.body.summary.due, tick.body.checkedIn], [200, 0, true]);
  clock = Date.parse('2026-09-22T12:35:00.000Z');
  assert.deepEqual((await get()).drain, { lastRunAt: '2026-09-22T12:30:00.000Z', minutesSince: 5, stale: false });
  clock = Date.parse('2026-09-22T12:40:00.000Z');
  assert.deepEqual((await get()).drain, { lastRunAt: '2026-09-22T12:30:00.000Z', minutesSince: 10, stale: true });
});

test('managers read the stuck count and retry; crew, other sites and a switched-off outbox are refused', async () => {
  const store = await seeded(3), ghl = recordingHighLevel();
  for (const entry of store.entries().slice(0, 2)) await store.commit([{ collection: GHL_TAG_OUTBOX, id: entry.id, revision: entry.revision, patch: { status: 'parked', attempts: 8, lastError: 'highlevel_503' } }]);
  let viewer = owner;
  const handlers = ghlTagDrainHandlers({ session: async () => viewer, storage: () => store, now: () => new Date(NOW), fetcher: ghl.fetcher });
  const get = async (query = '?view=stuck', env = ENV) => json(await handlers.get({ request: new Request(`${ORIGIN}${GHL_TAG_DRAIN_PATH}${query}`), env }));
  const stuck = await get();
  assert.deepEqual([stuck.status, stuck.body.visits, stuck.body.entries, stuck.body.coverage.complete], [200, 2, 2, true]);
  assert.deepEqual((await get('?view=stuck', { ...ENV, EGC_GHL_TAG_OUTBOX: undefined })).body, { ok: true, enabled: false });
  assert.equal((await get('?view=all')).status, 400);
  viewer = crew; assert.equal((await get()).status, 403);
  assert.deepEqual(await get('?view=stuck', { ...ENV, EGC_GHL_TAG_OUTBOX: undefined }), { status: 200, body: { ok: true, enabled: false } }, 'switched off, every signed-in viewer gets the same answer');
  viewer = null; assert.equal((await get()).status, 401);
  viewer = crew;
  assert.equal((await json(await post(handlers, { action: 'retry', requestId: randomUUID() }, { headers: { Origin: ORIGIN } }))).body.code, 'ghl_tag_forbidden');
  viewer = owner;
  assert.equal((await json(await post(handlers, { action: 'retry', requestId: randomUUID() }, { headers: { Origin: 'https://example.invalid' } }))).status, 403);
  assert.equal((await json(await post(handlers, { action: 'retry', requestId: randomUUID() }, { headers: { Origin: ORIGIN }, env: { ...ENV, EGC_GHL_TAG_OUTBOX: 'false' } }))).body.code, 'ghl_tag_outbox_disabled');
  const background = [];
  const retried = await json(await post(handlers, { action: 'retry', requestId: randomUUID(), jobId: 'visit-0' }, { headers: { Origin: ORIGIN }, waitUntil: promise => background.push(promise) }));
  assert.deepEqual([retried.status, retried.body.requeued], [200, 1]);
  await Promise.all(background);
  assert.deepEqual(ghl.lines(), ['POST /contacts/contact-1/tags'], 'the retried visit got one attempt at once');
  assert.equal((await get()).body.visits, 1);
});

test('/api/dispatch starts the first attempt after the save (waitUntil) only when the flag is on', async t => {
  const ghl = recordingHighLevel();
  t.mock.method(globalThis, 'fetch', ghl.fetcher);
  const run = async env => {
    const store = memory(), calls = [];
    store.rows.set('customers/c1', { id: 'c1', name: 'Synthetic Customer', highlevelContactId: 'contact-1', revision: 'c1r' });
    Object.assign(store, { ghlTagOutbox: env.EGC_GHL_TAG_OUTBOX === 'true', jobs: async () => [...store.rows].filter(([key]) => key.startsWith('jobs/')).map(([, row]) => structuredClone(row)), resources: async () => [], roster: async () => [{ id: 'crew1', name: 'Synthetic Crew', role: 'crew' }] });
    const handlers = dispatchHandlers({ session: async () => owner, storage: () => store, travel: () => null, now: () => new Date(NOW), ghlTags: (context, ids, at) => { calls.push({ ids, at, waitUntil: typeof context.waitUntil, env: context.env === env }); return firstGhlTagAttempt(context, ids, at, () => store); } });
    const background = [], requestId = randomUUID();
    const response = await handlers.post({ request: new Request(`${ORIGIN}/api/dispatch`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'schedule.create', requestId, customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-23', time: '09:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic walkthrough' } }) }), env, waitUntil: promise => background.push(promise) });
    assert.equal(response.status, 200);
    return { calls, background, store, requestId, body: await response.json() };
  };
  const off = await run({});
  assert.deepEqual([off.calls, off.background, off.store.entries()], [[], [], []]);
  const on = await run({ ...ENV });
  const [entry] = on.store.entries();
  assert.deepEqual(on.calls, [{ ids: [entry.id], at: NOW, waitUntil: 'function', env: true }]);
  assert.equal(on.background.length, 1, 'the first attempt runs after the response, never inside it');
  assert.equal(on.body.job.ghlTagEntry.id, entry.id);
  assert.equal(entry.id, await ghlTagEntryId(on.body.job.id, ghlTagChangeKey('dispatch', on.requestId)));
  assert.equal(on.body.providerSync, 'pending');
  await Promise.all(on.background);
  assert.deepEqual(ghl.lines(), [], 'the first attempt waits for the appointment write');
  assert.deepEqual([on.store.entries()[0].status, on.store.entries()[0].waitingFor], ['pending', 'appointment']);
  const key = `jobs/${on.body.job.id}`;
  on.store.rows.set(key, { ...on.store.rows.get(key), syncStatus: 'synced', highlevelAppointmentId: 'appt-1' });
  await drainGhlTagOutbox(on.store, { env: ENV, now: '2026-09-22T12:01:00.000Z', fetcher: ghl.fetcher });
  assert.deepEqual(ghl.lines(), ['POST /contacts/contact-1/tags']);
});

test('/api/walkthrough-visit starts the first attempt for an outcome it queued', async () => {
  const store = memory(), calls = [];
  store.rows.set('jobs/w1', { id: 'w1', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', date: '2026-09-22', time: '09:00', endTime: '10:00', assignedCrew: ['zacb'], projectId: 'project_w1', highlevelContactId: 'contact-1', revision: 'w1r' });
  Object.assign(store, { env: {}, assigned: async () => true, activeShift: async () => null });
  const handlers = walkthroughVisitHandlers({ session: async () => owner, storage: () => store, now: () => new Date('2026-09-22T15:05:00.000Z'), ghlTags: (context, ids) => { calls.push(ids); return true; } });
  const requestId = randomUUID();
  const response = await handlers.post({ request: new Request(`${ORIGIN}/api/walkthrough-visit`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'no_show', visitId: 'w1', requestId, expectedRevision: 'w1r', outcome: 'customer_no_show', reasonCode: 'customer_not_home', skipTimecard: true }) }), env: { ...ENV, EGC_WALKTHROUGH_VISIT_ENABLED: 'true' }, waitUntil: () => {} });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const [entry] = store.entries();
  assert.deepEqual(calls, [[entry.id]]);
  assert.deepEqual(entry.addTags, ['egc-walkthrough-no-show']);
});

// A visit's pointer and its outbox entry, as the dispatch commit writes them; `entry` overrides the entry's state.
async function queued(id, job, entry = {}) {
  const tags = await scheduleTagWrites({ jobId: id, after: job, action: 'schedule.create', requestId: randomUUID(), now: NOW });
  return { job: { ...job, ghlTagEntry: tags.pointer }, path: `${GHL_TAG_OUTBOX}/${tags.write.id}`, entry: { ...tags.write.patch, ...entry } };
}
const tagCalls = row => row.calls.filter(call => /\/tags$/.test(call.path));

test('flag on: the browser schedule sync adds the tags only when no outbox entry will, never re-confirms a closed visit, and writes it without notifications', async t => {
  const walk = FLAG_OFF_JOBS['visit-walk'], documents = {}, jobs = { ...FLAG_OFF_JOBS };
  for (const [id, state] of [['visit-walk', {}], ['visit-told', { status: 'done', doneAt: NOW, steps: { tags: NOW } }], ['visit-closed-entry', { status: 'done', doneAt: NOW, skipped: 'superseded' }], ['visit-no-entry', null]]) {
    const row = await queued(id, walk, state || {});
    jobs[id] = row.job;
    if (state) documents[row.path] = row.entry;
  }
  Object.assign(jobs, { 'visit-noshow': { ...FLAG_OFF_JOBS['visit-cancel'], type: 'job', status: 'no_show', pipelineStatus: 'no_show', highlevelAppointmentId: 'appt-9' },
    'visit-bare': { ...FLAG_OFF_JOBS['visit-cancel'], highlevelAppointmentId: '' } });
  const [schedule, job, cancelled] = FLAG_OFF_REQUESTS.map(([, payload]) => payload), as = id => ({ ...schedule, job_id: id, idempotency_key: `schedule:${id}:1` });
  const requests = [['outbox-owned walkthrough, not told yet', schedule], ['already told', as('visit-told')], ['entry closed without telling', as('visit-closed-entry')], ['pointer without an entry', as('visit-no-entry')],
    ['visit without an entry', job], ['cancelled visit', cancelled],
    ['no-show visit', { ...cancelled, job_id: 'visit-noshow', idempotency_key: 'schedule:visit-noshow:2', event_type: 'job', appointment_id: 'appt-9' }],
    ['cancelled visit without an appointment', { ...cancelled, job_id: 'visit-bare', idempotency_key: 'schedule:visit-bare:2', appointment_id: '' }]];
  const { responses, memory } = await highLevelRequestLog(t, { ...FLAG_OFF_ENV, EGC_GHL_TAG_OUTBOX: 'true' }, jobs, requests, { documents });
  const lines = row => row.calls.map(call => `${call.method} ${call.path}`);
  const [owned, told, closedEntry, noEntry, bare, cancel, noShow, none] = responses;
  assert.equal(owned.status, 200);
  assert.deepEqual(lines(owned), ['GET /calendars/events', 'POST /calendars/events/appointments', 'GET /contacts/contact-1', 'POST /contacts/contact-1/tags'], 'the appointment first, then the outbox\'s tags, once');
  assert.deepEqual(owned.body.automation, { trigger: 'egc-walkthrough-scheduled', reminderTrigger: 'egc-reminder-3d', tagSynced: false, notificationsRequested: true, tagOwner: 'outbox', tagStatus: 'queued' }, 'never reported as synced before the tags were added');
  assert.deepEqual(tagCalls(owned).map(call => call.body.tags), [['egc-hub-scheduled', 'egc-walkthrough-scheduled', 'egc-reminder-3d']]);
  const ownedEntry = memory.get(Object.keys(documents)[0]);
  assert.deepEqual([ownedEntry.status, ownedEntry.contactId, ownedEntry.sentTags.length], ['done', 'contact-1', 3]);
  assert.equal(memory.get('jobs/visit-walk').highlevelAppointmentId, owned.body.appointmentId, 'the sync linked the appointment before the outbox told HighLevel');
  assert.deepEqual([tagCalls(told), told.body.automation.tagSynced, told.body.automation.tagStatus], [[], true, 'done'], 'told once: the browser adds nothing');
  for (const row of [closedEntry, noEntry]) {
    assert.deepEqual(tagCalls(row).map(call => call.body.tags), [['egc-hub-scheduled', 'egc-walkthrough-scheduled', 'egc-reminder-3d']], `${row.label}: the browser adds them, as with the flag off`);
    assert.deepEqual([row.body.automation.tagSynced, 'tagOwner' in row.body.automation], [true, false]);
  }
  assert.deepEqual(tagCalls(bare).map(call => call.body.tags), [['egc-hub-scheduled', 'egc-job-scheduled']], 'a visit without an entry keeps the browser tags');
  const put = cancel.calls.find(call => call.method === 'PUT');
  assert.deepEqual([put.path, put.body.appointmentStatus, put.body.toNotify, cancel.body.pipeline.reason], ['/calendars/events/appointments/appt-1', 'cancelled', false, 'visit-cancelled'], 'a cancelled visit is never re-confirmed, and HighLevel sends no calendar notice for it');
  assert.equal(cancel.body.automation.notificationsRequested, true, 'Notify customer is reported as saved');
  const noShowPut = noShow.calls.find(call => call.method === 'PUT');
  assert.deepEqual([noShowPut.path, noShowPut.body.appointmentStatus, noShowPut.body.toNotify, noShow.body.pipeline.reason], ['/calendars/events/appointments/appt-9', 'noshow', false, 'visit-no-show']);
  assert.equal(noShow.calls.some(call => /\/tags$/.test(call.path) || call.path.startsWith('/opportunities')), false, 'a no-show gets no scheduled tags or stage move');
  assert.equal(none.calls.some(call => call.path.startsWith('/calendars')), false, 'no appointment is created for a cancelled visit');
});

// A quote author's signed handoff leaves the job unlinked with syncStatus 'pending' until a manager's page syncs it. The
// signed-handoff sync itself needs the operations bridge; the Game Plan path it shares for the job's tags runs here.
test('dry run, an unlinked visit awaiting its sync: the drain waits (never parks), then the Game Plan sync links the contact and the booking tags are added without a Retry', async t => {
  const env = { ...FLAG_OFF_ENV, EGC_GHL_TAG_OUTBOX: 'true' }, plan = FLAG_OFF_REQUESTS.find(([label]) => label === 'game plan with a job date')[1];
  const handoff = { ...FLAG_OFF_JOBS['visit-plan'], type: 'job', highlevelContactId: '', syncStatus: 'pending', providerSyncOwner: 'operations' };
  const row = await queued('visit-handoff', handoff);
  let first;
  const { responses, memory } = await highLevelRequestLog(t, env, { 'visit-handoff': row.job }, [['Game Plan sync for the handoff', { ...plan, job_id: 'visit-handoff', idempotency_key: 'plan:visit-handoff:1', client: { ...plan.client, highlevel_contact_id: '' } }]], {
    documents: { [row.path]: row.entry },
    // The worker's drain runs first, before any manager's page syncs the visit.
    seed: async (store, ghl) => { first = await drainGhlTagOutbox(ghlTagOutboxStorage(env), { env, now: NOW, fetcher: ghl.fetcher }); assert.deepEqual(ghl.calls, [], 'the dry-run drain makes no HighLevel request'); },
  });
  assert.deepEqual([first.waiting, first.parked], [1, 0], 'waiting for the appointment, not parked as unlinked');
  const [sync] = responses;
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.deepEqual([sync.body.automation.tagOwner, sync.body.automation.tagSynced, sync.body.automation.tagStatus], ['outbox', false, 'queued']);
  const booking = tagCalls(sync).filter(call => call.body.tags.includes('egc-hub-scheduled'));
  assert.deepEqual(booking.map(call => [call.path, call.body.tags]), [['/contacts/contact-new/tags', ['egc-hub-scheduled', 'egc-job-scheduled', 'egc-reminder-3d']]], 'one booking-tag request, by the outbox, to the contact the sync linked');
  const lines = sync.calls.map(call => `${call.method} ${call.path}`);
  assert.ok(lines.indexOf('POST /calendars/events/appointments') < lines.indexOf('POST /contacts/contact-new/tags', lines.indexOf('POST /calendars/events/appointments')), 'the appointment is written before the booking tags');
  const entry = memory.get(row.path), saved = memory.get('jobs/visit-handoff');
  assert.deepEqual([entry.status, entry.contactId, saved.highlevelContactId, Boolean(saved.highlevelAppointmentId)], ['done', 'contact-new', 'contact-new', true]);
});

test('a parked entry gets a fresh budget from the browser sync that links its contact: told once, no Retry needed', async t => {
  const env = { ...FLAG_OFF_ENV, EGC_GHL_TAG_OUTBOX: 'true' }, [, schedule] = FLAG_OFF_REQUESTS[0];
  const unlinked = { ...FLAG_OFF_JOBS['visit-walk'], highlevelContactId: '', syncStatus: 'error' };
  const row = await queued('visit-parked', unlinked, { status: 'parked', attempts: 8, lastError: 'ghl_tag_contact_not_linked', nextAttemptAt: NOW });
  const { responses, memory } = await highLevelRequestLog(t, env, { 'visit-parked': row.job }, [['schedule sync', { ...schedule, job_id: 'visit-parked', idempotency_key: 'schedule:visit-parked:1', client: { ...schedule.client, highlevel_contact_id: '' } }]], { documents: { [row.path]: row.entry } });
  const [sync] = responses;
  assert.deepEqual(sync.calls.map(call => `${call.method} ${call.path}`), ['POST /contacts/upsert', 'GET /calendars/events', 'POST /calendars/events/appointments', 'GET /contacts/contact-new', 'POST /contacts/contact-new/tags']);
  assert.deepEqual(tagCalls(sync).map(call => call.body.tags), [['egc-hub-scheduled', 'egc-walkthrough-scheduled', 'egc-reminder-3d']]);
  assert.deepEqual([sync.body.automation.tagSynced, sync.body.automation.tagOwner], [false, 'outbox']);
  const entry = memory.get(row.path);
  assert.deepEqual([entry.status, entry.attempts, entry.retriedBy, entry.contactId], ['done', 1, 'browser_sync', 'contact-new']);
});
