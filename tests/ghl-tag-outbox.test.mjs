// GHL-TRACK-1: the durable HighLevel tag outbox. With EGC_GHL_TAG_OUTBOX on, a dispatch or bridge schedule change and a
// walkthrough outcome queue one outbox entry in the same commit, and the drain tells HighLevel through tags and the
// appointment status only (never a message). A booking waits for its appointment write (the calendar mirror, simulated
// by mirror()) before its tags. A fake HighLevel records every request by method and path. Synthetic data, fixed clock,
// no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutateDispatch, dispatchOverview } from '../functions/_lib/dispatch-service.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { recordWalkthroughVisit } from '../functions/_lib/walkthrough-visit.js';
import { serverScheduleSyncOwned } from '../functions/_lib/schedule-sync-queue.js';
import { GHL_TAG_DRAIN_STALE_MINUTES, GHL_TAG_OUTBOX, GHL_TAG_OVERDUE_MINUTES, GHL_TAG_PARK_ATTEMPTS, GHL_TAG_WAIT_MINUTES, drainGhlTagOutbox, ghlTagBackoffMinutes, ghlTagChangeKey, ghlTagEntryId, ghlTagOverdue, ghlTagStuck, outboxOwnsScheduleTags, recordGhlTagDrainCheckIn, retryGhlTags, scheduleTagWrites, withGhlTagStatus } from '../functions/_lib/ghl-tag-outbox.js';
import { recordingHighLevel } from './helpers/highlevel-recorder.mjs';

const NOW = '2026-09-22T12:00:00.000Z', MINUTE = 60000;
const later = minutes => new Date(Date.parse(NOW) + minutes * MINUTE).toISOString();
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const crew = { user: 'crew1', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false };
const GHL_ENV = Object.freeze({ HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: 'location-1' });
const REMINDER = ['egc-hub-scheduled', 'egc-walkthrough-scheduled', 'egc-reminder-2d'];

function fixture({ fail } = {}) {
  const rows = new Map([
    ['customers/c1', { id: 'c1', name: 'Synthetic Customer', phone: '+1 (970) 555-0123', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevelContactId: 'contact-1', revision: 'c1r' }],
    ['customers/c2', { id: 'c2', name: 'Synthetic Unlinked', phone: '+1 (970) 555-0124', email: 'unlinked@example.invalid', address: '2 Synthetic Way', revision: 'c2r' }],
  ]);
  let revision = 0;
  const commits = [], clone = value => structuredClone(value), all = prefix => [...rows].filter(([key]) => key.startsWith(prefix + '/')).map(([, value]) => clone(value));
  const roster = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Synthetic Crew', role: 'crew' }];
  const store = {
    ghlTagOutbox: true,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(roster),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'no duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
      commits.push(writes.map(write => `${write.collection}/${write.id}`));
    },
    due: async () => ({ rows: all(GHL_TAG_OUTBOX).filter(row => row.status === 'pending'), truncated: false }),
    parked: async () => ({ rows: all(GHL_TAG_OUTBOX).filter(row => row.status === 'parked'), truncated: false }),
  };
  const ghl = recordingHighLevel({ fail });
  const mutate = (input, at = NOW) => mutateDispatch(store, owner, input, at);
  const create = (changes = {}, extra = {}) => mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-23', time: '09:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic walkthrough', ...changes }, ...extra });
  const edit = (job, action, extra = {}) => mutate({ action, requestId: randomUUID(), jobId: job.id, expectedRevision: rows.get(`jobs/${job.id}`).revision, changes: {}, ...extra });
  const drain = (at = NOW, options = {}) => drainGhlTagOutbox(store, { env: GHL_ENV, now: at, fetcher: ghl.fetcher, ...options });
  const entries = () => all(GHL_TAG_OUTBOX);
  // The calendar mirror (the page's sync or the schedule-sync worker's bind) wrote the visit's HighLevel appointment.
  const mirror = (id, appointmentId = `appt-${id}`) => { const key = `jobs/${id}`; rows.set(key, { ...rows.get(key), syncStatus: 'synced', highlevelAppointmentId: appointmentId, revision: `m${++revision}` }); };
  return { rows, store, commits, ghl, mutate, create, edit, drain, entries, mirror, job: id => clone(rows.get(`jobs/${id}`)) };
}
const tagBodies = f => f.ghl.tags().map(call => call.body.tags);

test('creating a walkthrough queues one entry in the same commit and makes exactly one tag request with the 3 tags', async () => {
  const f = fixture(), result = await f.create();
  const [entry] = f.entries();
  assert.equal(f.entries().length, 1);
  assert.ok(f.commits.at(-1).includes(`jobs/${result.job.id}`) && f.commits.at(-1).includes(`${GHL_TAG_OUTBOX}/${entry.id}`), 'the entry commits with the visit');
  assert.equal(entry.id, await ghlTagEntryId(result.job.id, ghlTagChangeKey('dispatch', result.requestId)), 'the id is derived from the job and its change key');
  assert.deepEqual({ addTags: entry.addTags, appointmentStatus: entry.appointmentStatus, opportunityStage: entry.opportunityStage, note: entry.note, attempts: entry.attempts, nextAttemptAt: entry.nextAttemptAt, status: entry.status, createdAt: entry.createdAt },
    { addTags: REMINDER, appointmentStatus: null, opportunityStage: null, note: null, attempts: 0, nextAttemptAt: NOW, status: 'pending', createdAt: NOW });
  assert.deepEqual(f.job(result.job.id).ghlTagEntry, { id: entry.id, kind: 'scheduled', startAt: '2026-09-23T15:00:00.000Z', requestId: result.requestId, queuedAt: NOW });
  assert.equal(result.job.ghlTagEntry.id, entry.id, 'the dispatch response names the entry for the first attempt');
  // The booking waits for its appointment write, so HighLevel sees the appointment before the tag, as with the flag off.
  assert.equal(f.job(result.job.id).syncStatus, 'pending');
  const waiting = await f.drain();
  assert.deepEqual([waiting.attempted, waiting.waiting, waiting.parked, f.ghl.calls.length], [1, 1, 0, 0]);
  const held = f.entries()[0];
  assert.deepEqual([held.status, held.attempts, held.waits, held.waitingFor, held.nextAttemptAt, held.claimId], ['pending', 0, 1, 'appointment', later(1), ''], 'waiting is not a failed attempt');
  assert.equal((await f.drain(later(0.5))).attempted, 0, 'the next check waits its turn');
  const again = await f.drain(later(1));
  assert.deepEqual([again.waiting, f.entries()[0].waits, f.entries()[0].nextAttemptAt], [1, 2, later(3)], 'still no appointment: checked again 2 minutes later');
  f.mirror(result.job.id);
  const summary = await f.drain(later(3));
  assert.deepEqual([summary.attempted, summary.done], [1, 1]);
  assert.deepEqual(f.ghl.lines(), ['POST /contacts/contact-1/tags']);
  assert.deepEqual(tagBodies(f), [REMINDER]);
  assert.equal(f.ghl.calls[0].headers.Authorization, 'Bearer synthetic-ghl-key');
  const done = f.entries()[0];
  assert.deepEqual([done.status, done.doneAt, done.contactId, done.claimId, done.waitingFor, done.attempts, done.sentTags], ['done', later(3), 'contact-1', '', '', 1, REMINDER]);
  assert.equal((await f.drain(later(10))).attempted, 0, 'a done entry is never attempted again');
  assert.equal(f.ghl.calls.length, 1);
});

test('a booking whose appointment is never written is not told, never parks, and closes when the visit starts', async () => {
  const f = fixture(), created = await f.create();
  let at = NOW;
  for (let check = 1; check <= 12; check++) { await f.drain(at); at = f.entries()[0].nextAttemptAt; }
  const [entry] = f.entries();
  assert.deepEqual([entry.status, entry.attempts, entry.waits], ['pending', 0, 12]);
  assert.deepEqual(GHL_TAG_WAIT_MINUTES, [1, 2, 5, 10, 15, 30, 60]);
  assert.equal(Date.parse(entry.nextAttemptAt) - Date.parse(entry.lastAttemptAt), 60 * MINUTE, 'the checks settle at one an hour');
  assert.equal((await ghlTagStuck(f.store, at)).visits, 0, 'waiting is not stuck');
  await f.drain('2026-09-23T15:00:00.000Z');
  assert.deepEqual([f.entries()[0].status, f.entries()[0].skipped], ['done', 'superseded']);
  assert.deepEqual(f.ghl.calls, [], 'as with the flag off: no appointment, no booking tags');
  assert.equal(created.job.ghlTagEntry.id, entry.id);
});

test('Notify customer off leaves out the reminder tag; a job gets the job tag; reminder days are clamped', async () => {
  const f = fixture();
  await f.create({ notify: false });
  await f.create({ date: '2026-09-24', reminderDays: 5 });
  await f.mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-25', time: '08:00', endTime: '12:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic job' } });
  for (const entry of f.entries()) f.mirror(entry.jobId);
  await f.drain(NOW, { limit: 10 });
  assert.deepEqual(tagBodies(f).map(tags => tags.join(' ')).sort(), ['egc-hub-scheduled egc-job-scheduled egc-reminder-2d', 'egc-hub-scheduled egc-walkthrough-scheduled', 'egc-hub-scheduled egc-walkthrough-scheduled egc-reminder-5d']);
  assert.deepEqual(f.ghl.writes().filter(call => !/\/tags$/.test(call.path)), [], 'only tags: no message, contact, note or appointment write');
  // The browser sync's mapping (event_type is the visit's type; only 'job' is a job): a cleanout or reorg starts the same workflow either way.
  for (const type of ['cleanout', 'reorg', 'walkthrough', 'job']) {
    const queued = await scheduleTagWrites({ jobId: `visit-${type}`, after: { type, date: '2026-09-25', time: '09:00', endTime: '10:00', status: 'scheduled', notify: false }, action: 'schedule.create', requestId: randomUUID(), now: NOW });
    assert.deepEqual(queued.write.patch.addTags, ['egc-hub-scheduled', type === 'job' ? 'egc-job-scheduled' : 'egc-walkthrough-scheduled'], type);
  }
});

test('worker mode (serverScheduleSync + providerSyncOwner operations): the browser skips the visit, the outbox still adds the tags', async () => {
  const f = fixture(), result = await f.create();
  const saved = f.job(result.job.id);
  assert.deepEqual([saved.providerSyncOwner, saved.syncStatus], ['operations', 'pending']);
  assert.equal(serverScheduleSyncOwned(saved), true, 'the schedule-sync worker owns the mirror, so page loads skip this visit');
  assert.equal(outboxOwnsScheduleTags({ EGC_GHL_TAG_OUTBOX: 'true' }, saved), true, 'a browser sync would leave the tags to the outbox');
  assert.equal(outboxOwnsScheduleTags({}, saved), false, 'flag off: the browser keeps adding them');
  await f.drain();
  assert.deepEqual(f.ghl.calls, [], 'the worker has not written the appointment yet');
  f.mirror(result.job.id);
  await f.drain(later(1));
  assert.deepEqual(tagBodies(f), [REMINDER], 'confirmation and reminder tags still fire, after the appointment');
});

test('reschedule, cancel, no-show and restore produce the right tags and appointment status', async () => {
  const f = fixture(), created = await f.create();
  const id = created.job.id;
  f.mirror(id, 'appt-1');
  await f.drain();
  await f.mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision, changes: { time: '11:00', endTime: '12:00' }, reasonCode: 'customer_request' });
  assert.equal(f.job(id).syncStatus, 'pending', 'the move queues the appointment update');
  const told = f.ghl.calls.length;
  await f.drain(later(1));
  assert.equal(f.ghl.calls.length, told, 'the reschedule waits until the appointment shows the new time');
  f.mirror(id, 'appt-1');
  await f.drain(later(2));
  assert.deepEqual(tagBodies(f).at(-1), [...REMINDER, 'egc-visit-rescheduled']);
  assert.equal(f.job(id).ghlTagEntry.kind, 'rescheduled');
  await f.edit(created.job, 'schedule.cancel', { reasonCode: 'customer_changed_plans', initiatedBy: 'customer' });
  const before = f.ghl.calls.length;
  await f.drain(later(2));
  assert.deepEqual(f.ghl.calls.slice(before).map(call => `${call.method} ${call.path}`), ['GET /calendars/events/appointments/appt-1', 'PUT /calendars/events/appointments/appt-1', 'POST /contacts/contact-1/tags']);
  assert.deepEqual([f.ghl.calls.at(-2).body.appointmentStatus, f.ghl.calls.at(-2).body.toNotify], ['cancelled', false]);
  assert.deepEqual(tagBodies(f).at(-1), ['egc-visit-cancelled']);
  await f.edit(created.job, 'schedule.restore');
  f.mirror(id, 'appt-1');
  await f.drain(later(3));
  assert.deepEqual(tagBodies(f).at(-1), REMINDER, 'restore adds the scheduled tags again');
  assert.equal(f.entries().find(row => row.kind === 'restored').status, 'done');
  // A job no-show (dispatch refuses walkthrough no-shows) from one hour before its start.
  const job = await f.mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-22', time: '06:30', endTime: '08:30', assignedCrew: ['crew1'], jobInstructions: 'Synthetic job' } });
  f.rows.set(`jobs/${job.job.id}`, { ...f.rows.get(`jobs/${job.job.id}`), highlevelAppointmentId: 'appt-2' });
  await f.edit(job.job, 'schedule.no_show', { reasonCode: 'customer_not_home' });
  const mark = f.ghl.calls.length;
  await f.drain(later(4), { limit: 10 });
  const noShow = f.ghl.calls.slice(mark);
  assert.deepEqual(noShow.map(call => `${call.method} ${call.path}`), ['GET /calendars/events/appointments/appt-2', 'PUT /calendars/events/appointments/appt-2', 'POST /contacts/contact-1/tags']);
  assert.deepEqual([noShow[1].body.appointmentStatus, noShow[2].body.tags], ['noshow', ['egc-visit-no-show']]);
  assert.equal(f.entries().find(row => row.kind === 'scheduled' && row.jobId === job.job.id).skipped, 'superseded', 'the job was a no-show before its placement drained: no scheduled tags');
  assert.deepEqual(f.ghl.calls.filter(call => call.path.startsWith('/conversations')), [], 'no message is ever sent');
});

test('a change the visit has moved past is closed without any HighLevel request; a replayed request queues nothing new', async () => {
  const f = fixture(), input = { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-09-23', time: '09:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic walkthrough' } };
  const created = await f.mutate(input);
  assert.equal((await f.mutate(input)).replayed, true);
  assert.equal(f.entries().length, 1, 'the replayed request adds no second entry');
  // HighLevel has the visit's appointment (the mirror wrote it), but the booking tags had not gone out yet.
  f.mirror(created.job.id, 'appt-1');
  await f.edit(created.job, 'schedule.cancel', { reasonCode: 'duplicate_booking' });
  const summary = await f.drain(NOW, { limit: 10 });
  assert.deepEqual([summary.done, summary.skipped], [1, 1]);
  assert.deepEqual(tagBodies(f), [['egc-visit-cancelled']], 'the placement was cancelled before it drained: only the cancellation is told');
  assert.deepEqual(f.ghl.writes().filter(call => call.method === 'PUT').map(call => [call.path, call.body.appointmentStatus]), [['/calendars/events/appointments/appt-1', 'cancelled']], 'and its appointment is marked cancelled');
  assert.equal(f.entries().find(row => row.kind === 'scheduled').skipped, 'superseded');
  // The same change key always names the same entry, and it is created once.
  const again = await scheduleTagWrites({ jobId: created.job.id, before: null, after: f.job(created.job.id), action: 'schedule.restore', requestId: created.requestId.toUpperCase(), now: NOW });
  assert.equal(again.write.id, await ghlTagEntryId(created.job.id, ghlTagChangeKey('dispatch', created.requestId)));
  await assert.rejects(f.store.commit([again.write]), error => error.status === 409, 'an entry id is create-only');
});

test('a replay with the same change key makes one request: concurrent drains and the first attempt never both write', async () => {
  const f = fixture(), created = await f.create(), id = created.job.ghlTagEntry.id;
  f.mirror(created.job.id);
  const results = await Promise.all([f.drain(), f.drain(), f.drain(NOW, { ids: [id] }), f.drain(NOW, { ids: [id, id] })]);
  assert.equal(results.reduce((sum, row) => sum + row.done, 0), 1);
  assert.equal(f.ghl.tags().length, 1, 'one tag request for the change');
  await f.drain(later(60), { ids: [id] });
  assert.equal(f.ghl.tags().length, 1);
  // A claim that never finished (the Worker died) is picked up after the claim expires, as another attempt.
  const g = fixture(), second = await g.create(), entryId = second.job.ghlTagEntry.id, key = `${GHL_TAG_OUTBOX}/${entryId}`;
  g.mirror(second.job.id);
  g.rows.set(key, { ...g.rows.get(key), claimId: 'lost', claimedUntil: later(5), attempts: 1, revision: 'claimed' });
  assert.equal((await g.drain(later(4))).attempted, 0);
  assert.equal((await g.drain(later(5))).done, 1);
  assert.equal(g.entries()[0].attempts, 2);
});

test('the drain backs off 1, 5, 15, then 60 minutes and parks after 8 attempts; a manager retry gives it a fresh budget', async () => {
  let down = true;
  const f = fixture({ fail: call => down && /\/tags$/.test(call.path) ? 503 : 0 }), created = await f.create({ date: '2026-09-24' });
  f.mirror(created.job.id);
  const schedule = [];
  let at = NOW;
  for (let attempt = 1; attempt <= GHL_TAG_PARK_ATTEMPTS; attempt++) {
    const early = await f.drain(new Date(Date.parse(at) - 1000).toISOString());
    if (attempt > 1) assert.equal(early.attempted, 0, `attempt ${attempt} waits for its backoff`);
    const summary = await f.drain(at), [entry] = f.entries();
    assert.equal(summary.attempted, 1);
    assert.equal(entry.attempts, attempt);
    assert.equal(entry.lastError, 'highlevel_503');
    if (attempt < GHL_TAG_PARK_ATTEMPTS) { assert.equal(entry.status, 'pending'); schedule.push((Date.parse(entry.nextAttemptAt) - Date.parse(at)) / MINUTE); at = entry.nextAttemptAt; }
    else assert.equal(entry.status, 'parked');
  }
  assert.deepEqual(schedule, [1, 5, 15, 60, 60, 60, 60]);
  assert.deepEqual([1, 2, 3, 4, 8].map(ghlTagBackoffMinutes), [1, 5, 15, 60, 60]);
  assert.equal(f.ghl.tags().length, GHL_TAG_PARK_ATTEMPTS);
  assert.equal((await f.drain(later(24 * 60))).attempted, 0, 'a parked entry waits for a person');
  assert.deepEqual(await ghlTagStuck(f.store, later(300)), { ok: true, enabled: true, visits: 1, entries: 1, parked: 1, overdue: 0, jobIds: [created.job.id],
    drain: { lastRunAt: null, minutesSince: null, stale: true }, asOf: later(300), coverage: { complete: true, asOf: later(300) } });
  const [view] = await withGhlTagStatus(f.store, [f.job(created.job.id)]);
  assert.deepEqual(view.ghlTags, { status: 'parked', doneAt: null, skipped: null, attempts: 8, nextAttemptAt: null, lastError: 'highlevel_503', overdue: false, current: null });
  assert.equal((await withGhlTagStatus(f.store, [f.job(created.job.id)], later(300)))[0].ghlTags.current, true, 'still the visit\'s change: the card shows it stuck');
  await assert.rejects(retryGhlTags(f.store, crew, { action: 'retry', requestId: randomUUID() }, later(300), {}), error => error.code === 'ghl_tag_forbidden');
  await assert.rejects(retryGhlTags(f.store, owner, { action: 'retry', requestId: 'not-a-uuid' }, later(300), {}), error => error.code === 'ghl_tag_request_invalid');
  const retried = await retryGhlTags(f.store, owner, { action: 'retry', requestId: randomUUID(), jobId: created.job.id }, later(300), {});
  assert.deepEqual([retried.requeued, f.entries()[0].status, f.entries()[0].attempts, f.entries()[0].retriedBy], [1, 'pending', 0, 'zacb']);
  down = false;
  assert.equal((await f.drain(later(300), { ids: retried.ids })).done, 1);
  assert.deepEqual((await ghlTagStuck(f.store, later(301))).visits, 0);
});

test('a visit the Hub never mirrors (no contact, sync not needed) has nothing to tell: closed at once, never stuck, no contact made', async () => {
  for (const env of [GHL_ENV, { ...GHL_ENV, EGC_MESSAGING_DRY_RUN: 'false' }]) {
    const f = fixture(), created = await f.create({}, { customerId: 'c2' });
    assert.equal(f.job(created.job.id).syncStatus, 'not_needed');
    const summary = await f.drain(NOW, { env });
    assert.deepEqual([summary.skipped, summary.parked, f.ghl.calls.length], [1, 0, 0], 'not even a contact search');
    assert.deepEqual([f.entries()[0].status, f.entries()[0].skipped], ['done', 'contact_not_linked']);
    assert.equal((await ghlTagStuck(f.store, later(1))).visits, 0);
    assert.equal((await retryGhlTags(f.store, owner, { action: 'retry', requestId: randomUUID() }, later(1), {})).requeued, 0, 'Retry has nothing to requeue');
  }
});

// A walkthrough recorded as a customer no-show on a visit whose HighLevel sync is expected (a signed handoff's syncStatus
// 'pending') but whose contact is not linked yet. The rep was there, so HighLevel's no-show follow-up is due once it can
// be told. (A dispatch cancel of such a visit tells HighLevel nothing: see 'never heard of' below.)
const OUTCOME_AT = '2026-09-22T15:05:00.000Z', afterOutcome = minutes => new Date(Date.parse(OUTCOME_AT) + minutes * MINUTE).toISOString();
async function unlinkedOutcome(fixtureOptions) {
  const f = outcomes(fixtureOptions, { customerId: 'c2', customer: 'Synthetic Unlinked', phone: '+1 (970) 555-0124', email: 'unlinked@example.invalid', address: '2 Synthetic Way', highlevelContactId: undefined, highlevelAppointmentId: undefined, syncStatus: 'pending' });
  await f.record('no_show', { outcome: 'customer_no_show', reasonCode: 'customer_not_home' });
  return { ...f, id: 'w1', entry: () => f.entries().find(row => row.kind === 'walkthrough_no_show') };
}

test('a messaging dry run creates no contact: an unlinked change retries with backoff and is told once the contact is linked', async () => {
  const f = await unlinkedOutcome();
  await f.drain(OUTCOME_AT, { limit: 10 });
  assert.deepEqual(f.ghl.calls, [], 'no contact search or upsert in a dry run');
  assert.deepEqual([f.entry().status, f.entry().attempts, f.entry().lastError, f.entry().nextAttemptAt], ['pending', 1, 'ghl_tag_contact_not_linked', afterOutcome(1)], 'an ordinary retryable failure, not parked');
  await f.drain(afterOutcome(1));
  assert.deepEqual([f.entry().status, f.entry().attempts, f.entry().nextAttemptAt], ['pending', 2, afterOutcome(6)]);
  // customer-resolve (or the browser sync) links the customer's contact: the next attempt reads it and tells HighLevel.
  f.rows.set('customers/c2', { ...f.rows.get('customers/c2'), highlevelContactId: 'contact-2' });
  await f.drain(afterOutcome(6));
  assert.deepEqual(f.ghl.lines(), ['POST /contacts/contact-2/tags']);
  assert.deepEqual(tagBodies(f), [['egc-walkthrough-no-show']]);
  assert.deepEqual([f.entry().status, f.entry().steps.appointment, f.entry().contactId], ['done', 'not_linked', 'contact-2']);
  // Never linked: it parks after 8 attempts, for a person, like any other failure.
  const g = await unlinkedOutcome();
  let at = OUTCOME_AT;
  for (let attempt = 1; attempt <= GHL_TAG_PARK_ATTEMPTS; attempt++) { await g.drain(at, { limit: 10 }); at = g.entry().nextAttemptAt; }
  assert.deepEqual([g.entry().status, g.entry().lastError, g.ghl.calls.length], ['parked', 'ghl_tag_contact_not_linked', 0]);
  // Only with EGC_MESSAGING_DRY_RUN exactly "false" may the outbox create the contact, as the browser sync does.
  for (const value of ['FALSE', '0', 'true', '']) {
    const h = await unlinkedOutcome();
    assert.equal((await h.drain(OUTCOME_AT, { env: { ...GHL_ENV, EGC_MESSAGING_DRY_RUN: value }, limit: 10 })).retrying, 1, `EGC_MESSAGING_DRY_RUN=${value} is still a dry run`);
    assert.deepEqual(h.ghl.calls, []);
  }
  const k = await unlinkedOutcome();
  await k.drain(OUTCOME_AT, { env: { ...GHL_ENV, EGC_MESSAGING_DRY_RUN: 'false' }, limit: 10 });
  assert.deepEqual(k.ghl.lines(), ['POST /contacts/upsert', 'POST /contacts/contact-new/tags']);
  assert.deepEqual(k.ghl.calls[0].body, { locationId: 'location-1', name: 'Synthetic Unlinked', phone: '+1 (970) 555-0124', email: 'unlinked@example.invalid', address1: '2 Synthetic Way', source: 'EGC Hub schedule' });
});

test('a cancel or no-show for a booking HighLevel never heard of tells it nothing', async () => {
  // Booked, the first attempt waits for the appointment write, and minutes later the dispatcher cancels it.
  const f = fixture(), created = await f.create(), id = created.job.id;
  assert.equal((await f.drain()).waiting, 1);
  await f.edit(created.job, 'schedule.cancel', { reasonCode: 'customer_changed_plans', initiatedBy: 'customer' });
  const summary = await f.drain(later(0.5), { limit: 10 });
  assert.deepEqual([summary.attempted, summary.skipped, summary.done], [1, 1, 0]);
  const cancel = () => f.entries().find(row => row.kind === 'cancelled');
  assert.deepEqual([cancel().status, cancel().skipped, cancel().attempts, 'sentTags' in cancel()], ['done', 'never_told', 1, false]);
  await f.drain(later(1), { limit: 10 });
  assert.equal(f.entries().find(row => row.kind === 'scheduled').skipped, 'superseded');
  assert.deepEqual(f.ghl.calls, [], 'no tag, no appointment write, no contact request');
  assert.equal('highlevelAppointmentId' in f.job(id), false);
  assert.equal((await ghlTagStuck(f.store, later(60))).visits, 0, 'nothing to retry');
  assert.deepEqual((await withGhlTagStatus(f.store, [f.job(id)], later(60)))[0].ghlTags.skipped, 'never_told', 'the card shows no chip for it');
  // A job booked and marked a no-show before HighLevel heard of it.
  const g = fixture();
  const job = await g.mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-22', time: '06:30', endTime: '08:30', assignedCrew: ['crew1'], jobInstructions: 'Synthetic job' } });
  await g.edit(job.job, 'schedule.no_show', { reasonCode: 'customer_not_home' });
  await g.drain(later(1), { limit: 10 });
  assert.deepEqual([g.ghl.calls, g.entries().find(row => row.kind === 'no_show').skipped], [[], 'never_told']);
  // A signed handoff's visit (sync expected, no contact yet) cancelled before any sync: no contact is made for it either.
  const h = fixture(), unlinked = await h.create({ date: '2026-09-24' }, { customerId: 'c2' });
  h.rows.set(`jobs/${unlinked.job.id}`, { ...h.rows.get(`jobs/${unlinked.job.id}`), syncStatus: 'pending' });
  await h.edit(unlinked.job, 'schedule.cancel', { reasonCode: 'customer_changed_plans', initiatedBy: 'customer' });
  const closed = await h.drain(NOW, { env: { ...GHL_ENV, EGC_MESSAGING_DRY_RUN: 'false' }, limit: 10 });
  assert.deepEqual([closed.skipped, closed.retrying, closed.parked, h.ghl.calls], [2, 0, 0, []]);
  assert.equal(h.entries().find(row => row.kind === 'cancelled').skipped, 'never_told');
});

test('a cancel or a move waits while the earlier change is being told, then follows what HighLevel heard', async () => {
  for (const heard of [true, false]) {
    // The booking's attempt holds its claim (it read the visit before the cancel) while the cancel's first attempt runs.
    const f = fixture(), created = await f.create(), id = created.job.id, key = `${GHL_TAG_OUTBOX}/${created.job.ghlTagEntry.id}`;
    f.rows.set(key, { ...f.rows.get(key), claimId: 'in-flight', claimedUntil: later(5), attempts: 1, revision: 'claimed' });
    await f.edit(created.job, 'schedule.cancel', { reasonCode: 'customer_changed_plans', initiatedBy: 'customer' });
    const cancelId = f.job(id).ghlTagEntry.id, cancel = () => f.entries().find(row => row.id === cancelId);
    assert.equal((await f.drain(NOW, { ids: [cancelId] })).waiting, 1);
    assert.deepEqual([cancel().status, cancel().waitingFor, cancel().attempts, cancel().nextAttemptAt, f.ghl.calls], ['pending', 'earlier_change', 0, later(1), []], 'waiting is not an attempt');
    // The booking's attempt settles: told (its tags went out before the cancel) or closed untold.
    f.rows.set(key, { ...f.rows.get(key), claimId: '', claimedUntil: '', status: 'done', doneAt: NOW, ...(heard ? { contactId: 'contact-1', steps: { tags: NOW } } : { skipped: 'superseded' }), revision: 'settled' });
    await f.drain(later(1), { ids: [cancelId] });
    assert.deepEqual(tagBodies(f), heard ? [['egc-visit-cancelled']] : [], `heard ${heard}`);
    assert.deepEqual([cancel().status, cancel().skipped || null], ['done', heard ? null : 'never_told']);
  }
  // A move while the booking's attempt is in flight: once it was told, the move is a reschedule.
  const g = fixture(), booked = await g.create(), id = booked.job.id, key = `${GHL_TAG_OUTBOX}/${booked.job.ghlTagEntry.id}`;
  g.mirror(id, 'appt-1');
  g.rows.set(key, { ...g.rows.get(key), claimId: 'in-flight', claimedUntil: later(5), attempts: 1, revision: 'claimed' });
  await g.mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: g.rows.get(`jobs/${id}`).revision, changes: { time: '11:00', endTime: '12:00' }, reasonCode: 'customer_request' });
  g.mirror(id, 'appt-1');
  const moveId = g.job(id).ghlTagEntry.id;
  assert.equal((await g.drain(NOW, { ids: [moveId] })).waiting, 1);
  assert.deepEqual(g.ghl.calls, []);
  g.rows.set(key, { ...g.rows.get(key), claimId: '', claimedUntil: '', status: 'done', doneAt: NOW, contactId: 'contact-1', steps: { tags: NOW }, revision: 'settled' });
  await g.drain(later(1), { ids: [moveId] });
  assert.deepEqual(tagBodies(g), [[...REMINDER, 'egc-visit-rescheduled']]);
});

test('a booking with no HighLevel appointment and none coming is closed untold, as with the flag off', async () => {
  // Booked for a customer with no contact ('not_needed'); the customer is linked later and the visit is moved.
  const f = fixture(), created = await f.create({}, { customerId: 'c2' }), id = created.job.id;
  await f.drain();
  f.rows.set('customers/c2', { ...f.rows.get('customers/c2'), highlevelContactId: 'contact-2' });
  await f.mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision, changes: { time: '11:00', endTime: '12:00' }, reasonCode: 'customer_request' });
  assert.deepEqual([f.job(id).syncStatus, 'highlevelAppointmentId' in f.job(id)], ['not_needed', false], 'the move queues no appointment write');
  const summary = await f.drain(later(1), { limit: 10 });
  assert.deepEqual([summary.skipped, summary.done, summary.waiting, f.ghl.calls], [1, 0, 0, []], 'no booking or reminder tags for an appointment HighLevel does not have');
  assert.deepEqual([f.job(id).ghlTagEntry.kind, f.entries().find(row => row.kind === 'rescheduled').skipped], ['rescheduled', 'not_mirrored']);
  assert.equal((await ghlTagStuck(f.store, later(60))).visits, 0);
  // A mirror that finished ('synced') without an appointment id is the same: nothing is coming.
  const g = fixture(), booked = await g.create();
  g.rows.set(`jobs/${booked.job.id}`, { ...g.rows.get(`jobs/${booked.job.id}`), syncStatus: 'synced' });
  await g.drain();
  assert.deepEqual([g.entries()[0].skipped, g.ghl.calls], ['not_mirrored', []]);
  // Still coming ('pending', 'syncing', 'error'): it waits, and is told once the appointment is written.
  const h = fixture(), waiting = await h.create();
  for (const status of ['syncing', 'error']) { h.rows.set(`jobs/${waiting.job.id}`, { ...h.rows.get(`jobs/${waiting.job.id}`), syncStatus: status }); await h.drain(h.entries()[0].nextAttemptAt); }
  assert.deepEqual([h.entries()[0].status, h.entries()[0].waits, h.ghl.calls], ['pending', 2, []]);
  h.mirror(waiting.job.id);
  await h.drain(h.entries()[0].nextAttemptAt);
  assert.deepEqual(tagBodies(h), [REMINDER]);
});

test('the stuck count only has changes still current: a parked entry the visit moved past is closed, not counted', async () => {
  let down = true;
  const f = fixture({ fail: call => down && /\/tags$/.test(call.path) ? 503 : 0 }), created = await f.create({ date: '2026-09-24' }), id = created.job.id;
  f.mirror(id, 'appt-1');
  let at = NOW;
  for (let attempt = 1; attempt <= GHL_TAG_PARK_ATTEMPTS; attempt++) { await f.drain(at); at = f.entries()[0].nextAttemptAt || at; }
  const placement = () => f.entries().find(row => row.kind === 'scheduled');
  assert.equal(placement().status, 'parked');
  down = false;
  await f.edit(created.job, 'schedule.cancel', { reasonCode: 'customer_changed_plans', initiatedBy: 'customer' });
  await f.drain(later(600), { limit: 10 });
  assert.deepEqual(tagBodies(f).at(-1), ['egc-visit-cancelled'], 'HighLevel had the appointment: the cancel is told');
  assert.equal((await withGhlTagStatus(f.store, [f.job(id)], later(601)))[0].ghlTags.status, 'done', 'the card shows the cancel told');
  const calls = f.ghl.calls.length, stuck = await ghlTagStuck(f.store, later(601));
  assert.deepEqual([stuck.visits, stuck.entries, stuck.jobIds], [0, 0, []]);
  assert.deepEqual([placement().status, placement().skipped, placement().doneAt], ['done', 'superseded', later(601)], 'the stuck view closes it without a request');
  assert.equal(f.ghl.calls.length, calls);
  assert.equal((await retryGhlTags(f.store, owner, { action: 'retry', requestId: randomUUID() }, later(602), {})).requeued, 0, 'Retry has nothing left to do');
  // A parked booking whose visit has started: its card shows nothing (it would close untold) and it is not counted.
  down = true;
  const g = fixture({ fail: call => down && /\/tags$/.test(call.path) ? 503 : 0 }), booked = await g.create();
  g.mirror(booked.job.id, 'appt-2');
  at = NOW;
  for (let attempt = 1; attempt <= GHL_TAG_PARK_ATTEMPTS; attempt++) { await g.drain(at); at = g.entries()[0].nextAttemptAt || at; }
  const start = '2026-09-23T15:00:00.000Z';
  assert.equal((await withGhlTagStatus(g.store, [g.job(booked.job.id)], later(10)))[0].ghlTags.current, true);
  assert.equal((await ghlTagStuck(g.store, later(10))).visits, 1, 'before its start it is stuck');
  assert.equal((await withGhlTagStatus(g.store, [g.job(booked.job.id)], start))[0].ghlTags.current, false);
  assert.equal((await ghlTagStuck(g.store, start)).visits, 0);
  assert.deepEqual([g.entries()[0].status, g.entries()[0].skipped], ['done', 'superseded']);
});

test('with the tag worker stopped, a waiting booking becomes stuck, the Hub says the worker stopped, and Retry tells HighLevel at once', async () => {
  // Worker mode: the schedule-sync worker owns the mirror, so page loads skip the visit and only the drain tells HighLevel.
  const f = fixture(), created = await f.create({ date: '2026-09-30' }), id = created.job.id, entryId = created.job.ghlTagEntry.id;
  assert.equal(serverScheduleSyncOwned(f.job(id)), true);
  assert.equal((await f.drain(NOW, { ids: [entryId] })).waiting, 1, 'the save\'s first attempt waits for the appointment');
  f.mirror(id);
  // No drain tick ever runs.
  const early = await ghlTagStuck(f.store, later(GHL_TAG_OVERDUE_MINUTES));
  assert.deepEqual([early.visits, early.drain], [0, { lastRunAt: null, minutesSince: null, stale: true }], 'due a minute after the save: not overdue yet, but the worker never checked in');
  const stuck = await ghlTagStuck(f.store, later(1 + GHL_TAG_OVERDUE_MINUTES + 0.5));
  assert.deepEqual([stuck.visits, stuck.entries, stuck.parked, stuck.overdue, stuck.jobIds], [1, 1, 0, 1, [id]]);
  const [card] = await withGhlTagStatus(f.store, [f.job(id)], later(1 + GHL_TAG_OVERDUE_MINUTES + 0.5));
  assert.deepEqual([card.ghlTags.status, card.ghlTags.overdue, card.ghlTags.current], ['pending', true, true], 'the card shows it stuck, not waiting');
  const days = later(3 * 24 * 60);
  assert.equal((await ghlTagStuck(f.store, days)).visits, 1, 'three days later it is still stuck, never silently waiting');
  assert.deepEqual(f.ghl.calls, []);
  const retried = await retryGhlTags(f.store, owner, { action: 'retry', requestId: randomUUID(), jobId: id }, days, {});
  assert.deepEqual([retried.requeued, f.entries()[0].status, f.entries()[0].attempts, f.entries()[0].retriedBy], [1, 'pending', 0, 'zacb']);
  assert.equal((await f.drain(days, { ids: retried.ids })).done, 1);
  assert.deepEqual(tagBodies(f), [REMINDER]);
  assert.equal((await ghlTagStuck(f.store, days)).visits, 0);
  // The worker's check-in: fresh for GHL_TAG_DRAIN_STALE_MINUTES after a pass, then stale again.
  assert.equal(await recordGhlTagDrainCheckIn(f.store, days), true);
  const checkedAt = Date.parse(days), plus = minutes => new Date(checkedAt + minutes * MINUTE).toISOString();
  assert.deepEqual((await ghlTagStuck(f.store, plus(5))).drain, { lastRunAt: days, minutesSince: 5, stale: false });
  assert.deepEqual((await ghlTagStuck(f.store, plus(GHL_TAG_DRAIN_STALE_MINUTES))).drain, { lastRunAt: days, minutesSince: GHL_TAG_DRAIN_STALE_MINUTES, stale: true });
  assert.equal((await ghlTagStuck(f.store, new Date(checkedAt - 2 * MINUTE).toISOString())).drain.stale, true, 'a check-in from the future is not trusted');
  assert.equal(await recordGhlTagDrainCheckIn(f.store, plus(12)), true, 'the next check-in replaces it');
  assert.equal((await ghlTagStuck(f.store, plus(13))).drain.stale, false);
  // Overdue is measured from when the entry was due, and a claimed or backing-off entry is never overdue.
  const due = { status: 'pending', nextAttemptAt: NOW };
  assert.deepEqual([ghlTagOverdue(due, Date.parse(later(GHL_TAG_OVERDUE_MINUTES))), ghlTagOverdue(due, Date.parse(later(GHL_TAG_OVERDUE_MINUTES + 1))), ghlTagOverdue({ ...due, claimedUntil: later(20) }, Date.parse(later(16))), ghlTagOverdue({ ...due, status: 'parked' }, Date.parse(later(16)))], [false, true, false, false]);
});

test('a storage read that fails mid-attempt is recorded as storage, not as a HighLevel status', async () => {
  const f = fixture(), created = await f.create();
  f.mirror(created.job.id);
  const read = f.store.read;
  f.store.read = async (collection, id) => { if (collection === 'jobs') throw Object.assign(new Error('Dispatch storage is unavailable.'), { code: 'dispatch_storage_unavailable', status: 503 }); return read(collection, id); };
  assert.equal((await f.drain()).retrying, 1);
  assert.deepEqual([f.entries()[0].status, f.entries()[0].lastError], ['pending', 'ghl_tag_storage_unavailable']);
  f.store.read = read;
  assert.equal((await f.drain(later(1))).done, 1);
});

test('a move before HighLevel heard the visit\'s time is its first booking; a move after it heard is a reschedule', async () => {
  const f = fixture(), created = await f.create(), id = created.job.id;
  const move = async (time, endTime) => f.mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: f.rows.get(`jobs/${id}`).revision, changes: { time, endTime }, reasonCode: 'customer_request' });
  await f.drain();
  await move('11:00', '12:00');
  assert.equal(f.job(id).ghlTagEntry.kind, 'rescheduled');
  f.mirror(id);
  await f.drain(later(1), { limit: 10 });
  assert.deepEqual(tagBodies(f), [REMINDER], 'one confirmation, and no "rescheduled" for a time HighLevel never knew');
  const first = f.entries().find(row => row.kind === 'rescheduled');
  assert.deepEqual([first.addTags.at(-1), first.sentTags], ['egc-visit-rescheduled', REMINDER]);
  assert.equal(f.entries().find(row => row.kind === 'scheduled').skipped, 'superseded');
  // Told at 11:00; moved to 13:00 (moved again before it was told) and then to 14:00: HighLevel knew 11:00, so a reschedule.
  await move('13:00', '14:00'); await move('14:00', '15:00');
  f.mirror(id);
  await f.drain(later(2), { limit: 10 });
  assert.deepEqual(tagBodies(f).at(-1), [...REMINDER, 'egc-visit-rescheduled']);
  assert.equal(f.ghl.tags().length, 2, 'the 13:00 change was closed without a request');
  // A visit from before the outbox: an appointment it already had means HighLevel knew its time; none means it did not.
  for (const [appointment, expected] of [['appt-legacy', [...REMINDER, 'egc-visit-rescheduled']], [null, REMINDER]]) {
    const g = fixture();
    g.store.ghlTagOutbox = undefined;
    const legacy = await g.create();
    g.store.ghlTagOutbox = true;
    if (appointment) g.mirror(legacy.job.id, appointment);
    await g.mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: legacy.job.id, expectedRevision: g.rows.get(`jobs/${legacy.job.id}`).revision, changes: { time: '11:00', endTime: '12:00' }, reasonCode: 'customer_request' });
    g.mirror(legacy.job.id, appointment || 'appt-new');
    await g.drain();
    assert.deepEqual(tagBodies(g), [expected], `before the outbox, appointment ${appointment}`);
  }
});

test('flag off: dispatch writes no outbox entry and no pointer, and the drain has nothing to do', async () => {
  const f = fixture();
  f.store.ghlTagOutbox = undefined;
  const created = await f.create();
  await f.edit(created.job, 'schedule.cancel', { reasonCode: 'duplicate_booking' });
  assert.equal(f.entries().length, 0);
  assert.equal('ghlTagEntry' in f.job(created.job.id), false);
  assert.equal('ghlTagEntry' in created.job, false);
  assert.equal((await f.drain()).due, 0);
  assert.deepEqual(f.ghl.calls, []);
  const overview = await dispatchOverview(f.store, owner, { startDate: '2026-09-23', endDate: '2026-09-24' }, new Date(NOW));
  assert.equal('ghlTagOutbox' in overview, false);
  assert.equal(overview.jobs.some(job => 'ghlTags' in job), false);
});

test('the dispatch board shows each visit\'s outbox status; an unreadable outbox is unknown, never done', async () => {
  const f = fixture(), created = await f.create();
  let board = await dispatchOverview(f.store, owner, { startDate: '2026-09-23', endDate: '2026-09-24' }, new Date(NOW));
  assert.equal(board.ghlTagOutbox, true);
  assert.equal(board.jobs[0].ghlTags.status, 'pending');
  f.mirror(created.job.id);
  await f.drain();
  board = await dispatchOverview(f.store, owner, { view: 'job', jobId: created.job.id }, new Date(NOW));
  assert.deepEqual([board.job.ghlTags.status, board.job.ghlTags.doneAt], ['done', NOW]);
  const read = f.store.read;
  f.store.read = async (collection, id) => { if (collection === GHL_TAG_OUTBOX) throw new Error('unavailable'); return read(collection, id); };
  assert.deepEqual((await withGhlTagStatus(f.store, [f.job(created.job.id)]))[0].ghlTags, { status: 'unknown' });
});

test('bridge schedule changes queue the same tags with their own change key', async () => {
  const f = fixture();
  Object.assign(f.store, { day: async date => [...f.rows].filter(([key, row]) => key.startsWith('jobs/') && row.date === date).map(([, row]) => structuredClone(row)), legacyBlockMode: 'off' });
  const actor = { id: 'operations-api', kind: 'integration', role: 'integration', workspace: 'egc' }, requestId = randomUUID();
  const created = await mutateScheduledVisit(f.store, actor, { mode: 'create', kind: 'walkthrough', requestId, portalCustomerId: 'c1', changes: { date: '2026-09-23', time: '09:00', endTime: '10:00' } }, NOW);
  const [entry] = f.entries();
  assert.equal(entry.id, await ghlTagEntryId(created.visit.portalVisitId, ghlTagChangeKey('bridge', requestId)));
  assert.equal(f.job(created.visit.portalVisitId).ghlTagEntry.id, entry.id);
  assert.equal(f.job(created.visit.portalVisitId).syncStatus, 'pending', 'the bridge queues its own appointment write');
  f.mirror(created.visit.portalVisitId);
  await f.drain();
  assert.deepEqual(tagBodies(f), [REMINDER]);
});

// FUN-05/FUN-06 walkthrough outcomes through the real recorder (no timecard) and the same drain.
function outcomes(fixtureOptions, visit = {}) {
  const f = fixture(fixtureOptions);
  const row = { id: 'w1', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '1 Synthetic Way', date: '2026-09-22', time: '09:00', endTime: '10:00', assignedCrew: ['zacb'], projectId: 'project_w1', highlevelContactId: 'contact-1', highlevelAppointmentId: 'appt-w1', revision: 'w1r', ...visit };
  f.rows.set('jobs/w1', Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)));
  Object.assign(f.store, { env: {}, assigned: async () => true, activeShift: async () => null, sealShift: async () => { throw new Error('no timecard'); } });
  const record = async (action, extra = {}) => recordWalkthroughVisit(f.store, owner, { action, visitId: 'w1', requestId: randomUUID(), expectedRevision: f.rows.get('jobs/w1').revision, skipTimecard: true, ...(action === 'start' ? { recordingStatus: 'recorded' } : {}), ...extra }, '2026-09-22T15:05:00.000Z');
  return { ...f, record };
}

test('each walkthrough outcome produces its tag; a sale keeps the Game Plan tags and a reschedule waits for Dispatch', async () => {
  const cases = [
    ['no_show', { outcome: 'customer_no_show', reasonCode: 'customer_not_home' }, ['egc-walkthrough-no-show'], 'noshow', null],
    ['finish', { outcome: 'not_interested', reasonCode: 'price', recordingStatus: 'recorded' }, ['egc-walkthrough-lost'], null, 'Walkthrough outcome: not interested. Reason code: price.'],
    ['finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, ['egc-walkthrough-complete', 'egc-quote-to-follow'], null, null],
    ['finish', { outcome: 'sold_on_site', recordingStatus: 'recorded' }, null],
    ['finish', { outcome: 'rescheduled', reasonCode: 'customer_request', recordingStatus: 'recorded' }, null],
  ];
  for (const [action, extra, tags, appointmentStatus, note] of cases) {
    const f = outcomes();
    if (action === 'finish') await f.record('start');
    const result = await f.record(action, extra);
    const entries = f.entries();
    if (!tags) { assert.equal(entries.length, 0, extra.outcome); continue; }
    assert.equal(entries.length, 1, extra.outcome);
    assert.equal(entries[0].id, await ghlTagEntryId('w1', ghlTagChangeKey('walkthrough-outcome', result.requestId)));
    assert.ok(f.commits.at(-1).includes(`${GHL_TAG_OUTBOX}/${entries[0].id}`) && f.commits.at(-1).includes('jobs/w1'), 'the entry commits with the outcome');
    await f.drain('2026-09-22T15:06:00.000Z');
    assert.deepEqual(tagBodies(f), [tags], extra.outcome);
    assert.equal(f.ghl.calls.some(call => call.method === 'PUT' && call.body?.appointmentStatus === appointmentStatus), Boolean(appointmentStatus), extra.outcome);
    const notes = f.ghl.calls.filter(call => /\/notes$/.test(call.path));
    assert.deepEqual(notes.map(call => call.body.body), note ? [note] : [], extra.outcome);
    if (note) assert.deepEqual([notes[0].body.pinned, notes[0].headers['Idempotency-Key']], [false, entries[0].id]);
    assert.deepEqual(f.ghl.calls.filter(call => call.path.startsWith('/conversations')), []);
  }
});

test('flag off: a walkthrough outcome queues nothing', async () => {
  const f = outcomes();
  f.store.ghlTagOutbox = false;
  await f.record('no_show', { outcome: 'customer_no_show', reasonCode: 'customer_not_home' });
  assert.equal(f.entries().length, 0);
  assert.equal('ghlTagEntry' in f.rows.get('jobs/w1'), false);
});
