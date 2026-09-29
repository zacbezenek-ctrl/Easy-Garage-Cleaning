import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutateDispatch, mutateDispatchSelfAssignment } from '../functions/_lib/dispatch-service.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { adoptScheduledVisit } from '../functions/_lib/operations-adoption.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { applyRecordingApproval } from '../functions/_lib/operations-recording-approval.js';
import { prepareBridgeCommand } from '../functions/_lib/operations-command-policy.js';
import { RECORDING_COMMANDS } from '../functions/api/operations-recording-approval.js';
import { recordWalkthroughVisit, walkthroughVisitProjection } from '../functions/_lib/walkthrough-visit.js';
import { authorizeTimecard } from '../functions/_lib/employee-timecards.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { bookingInput, reasonInput, lateCancel, cancelStart, cancelPatch, requestKey, eventActor, eventVia, providerClock, dispatchFunnelOptions, visitFunnelWrites } from '../functions/_lib/dispatch-funnel.js';
import { funnelEventId, funnelEventWrite } from '../functions/_lib/funnel-events.js';
import { definitionsHash } from '../functions/_lib/funnel-definitions.js';

// FUN-02: booking, dispatch, handoff and approval events. Every schedule change
// commits its funnelEvents rows with the visit and its receipt; a failed commit
// writes none, and a replay never writes a second one. Fixed clocks only.
const NOW = '2026-09-22T12:00:00.000Z'; // 06:00 Denver
const owner = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
const ROSTER = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }];
const conflict = () => Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });

// In-memory Firestore: create-only writes without a revision, compare-and-set with
// one, all or nothing, a new revision per write and one entry per commit.
function memory(seed = {}) {
  const rows = new Map(Object.entries(seed).map(([key, value]) => [key, { revision: `${key}-r0`, ...structuredClone(value), id: key.split('/')[1] }]));
  let n = 0;
  const list = prefix => [...rows].filter(([key]) => key.startsWith(`${prefix}/`)).map(([, value]) => structuredClone(value));
  const store = {
    rows, commits: [], fault: null, before: null,
    jobs: async () => list('jobs'), resources: async () => list('dispatchResources'), roster: async () => structuredClone(ROSTER),
    customers: async provider => provider === undefined ? list('customers') : list('customers').filter(row => row.highlevelContactId === provider),
    day: async date => list('jobs').filter(row => row.date === date), snapshot: async () => list('jobs').filter(row => !row.recordType), identityCandidates: async () => [],
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      store.before?.(writes);
      const keys = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(keys).size, keys.length, 'a commit never writes one document twice');
      if (store.fault === 'conflict') throw conflict();
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw conflict(); }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` });
      store.commits.push(keys);
      if (store.fault === 'lost') throw new Error('response lost');
    },
  };
  store.events = type => list('funnelEvents').filter(event => !type || event.type === type);
  return store;
}
const customers = { 'customers/c1': { name: 'Synthetic Customer', phone: '9705550100', address: '100 Synthetic Lane', highlevelContactId: 'contactA' }, 'customers/c2': { name: 'Synthetic Unlinked', phone: '9705550111', address: '200 Synthetic Lane' } };
const create = (changes = {}, extra = {}) => ({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic scope', ...changes }, ...extra });
const edit = (job, action, extra = {}) => ({ action, requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, changes: {}, ...extra });
const saved = (store, id) => store.rows.get(`jobs/${id}`);

test('a Hub booking records channel, self-reported channel, booker, visit purpose and CRM link, and emits job.scheduled and job.assigned in the visit commit', async () => {
  const store = memory(customers), input = create({}, { booking: { channel: 'hub_phone', channelSelfReported: 'google_maps' } });
  const { job } = await mutateDispatch(store, owner, input, NOW), row = saved(store, job.id);
  assert.deepEqual([row.bookingChannel, row.channelSelfReported, row.bookedBy, row.visitPurpose, row.crmLinkReason, row.scheduleOccurrence], ['hub_phone', 'google_maps', 'zacb', 'service', null, 1]);
  assert.equal(store.rows.get(`projects/${row.projectId}`).highlevelContactId, 'contactA');
  const [scheduled] = store.events('job.scheduled'), [assigned] = store.events('job.assigned');
  assert.equal(store.events().length, 2);
  assert.deepEqual(scheduled.data, { channel: 'hub_phone', channelSelfReported: 'google_maps', occurrence: 1, visitPurpose: 'service' });
  assert.deepEqual([scheduled.jobId, scheduled.projectId, scheduled.customerId, scheduled.highlevelContactId, scheduled.occurredAt, scheduled.denverDate, scheduled.clockSource], [job.id, row.projectId, 'c1', 'contactA', NOW, '2026-09-22', 'server']);
  assert.deepEqual(scheduled.actor, { id: 'zacb', kind: 'human', role: 'owner' });
  assert.deepEqual(scheduled.source, { collection: 'dispatchOperations', id: input.requestId });
  assert.equal(scheduled.idempotencyKey, `requestId:${input.requestId}`);
  assert.equal(scheduled.definitionsHash, definitionsHash());
  assert.equal(scheduled.id, funnelEventId('job.scheduled', { field: 'jobId', value: job.id }, `requestId:${input.requestId}`));
  assert.equal(assigned.jobId, job.id);
  const commit = store.commits.at(-1);
  for (const key of [`jobs/${job.id}`, `dispatchOperations/${input.requestId}`, `funnelEvents/${scheduled.id}`, `funnelEvents/${assigned.id}`]) assert.ok(commit.includes(key), `${key} commits together`);
  assert.equal(store.rows.get(`dispatchOperations/${input.requestId}`).after.visitPurpose, 'service');
});

test('an unlinked customer keeps the CRM link reason on the visit and project; a walkthrough is always a walkthrough visit', async () => {
  const store = memory(customers);
  const { job } = await mutateDispatch(store, owner, create({ assignedCrew: [] }, { customerId: 'c2', kind: 'walkthrough', booking: { channel: 'hub_in_person', crmLinkReason: 'crm_sync_pending' } }), NOW);
  const row = saved(store, job.id), project = store.rows.get(`projects/${row.projectId}`);
  assert.deepEqual([row.visitPurpose, row.crmLinkReason, project.crmLinkReason, project.highlevelContactId], ['walkthrough', 'crm_sync_pending', 'crm_sync_pending', '']);
  const [booked] = store.events();
  assert.equal(store.events().length, 1, 'no job.assigned for a walkthrough');
  assert.deepEqual([booked.type, booked.walkthroughId, booked.jobId, booked.data.visitPurpose, booked.data.channel], ['walkthrough.booked', job.id, null, 'walkthrough', 'hub_in_person']);
  const linked = memory(customers);
  const other = await mutateDispatch(linked, owner, create({}, { booking: { crmLinkReason: 'other' } }), NOW);
  assert.equal(saved(linked, other.job.id).crmLinkReason, null, 'a CRM-linked visit keeps no reason for a missing link');
  await assert.rejects(mutateDispatch(memory(customers), owner, create({}, { kind: 'walkthrough', booking: { visitPurpose: 'service' } }), NOW), error => error.code === 'dispatch_booking_invalid' && error.status === 400);
});

test('booking details are validated against the shared definitions and only accepted on a customer visit create', async () => {
  const rejects = async (input, code) => { const store = memory(customers); await assert.rejects(mutateDispatch(store, owner, input, NOW), error => error.code === code, code); assert.equal(store.commits.length, 0); };
  await rejects(create({}, { booking: { channel: 'jobber_legacy' } }), 'dispatch_booking_invalid');
  await rejects(create({}, { booking: { channel: 'fax' } }), 'dispatch_booking_invalid');
  await rejects(create({}, { booking: { channelSelfReported: 'billboard' } }), 'dispatch_booking_invalid');
  await rejects(create({}, { booking: { crmLinkReason: 'forgot' } }), 'dispatch_booking_invalid');
  await rejects(create({}, { booking: { channel: 'hub_phone', extra: true } }), 'dispatch_booking_invalid');
  await rejects(create({}, { booking: { visitPurpose: 'rework' } }), 'dispatch_booking_rework_invalid');
  await rejects(create({}, { booking: { visitPurpose: 'service', reworkOfJobId: 'job-1' } }), 'dispatch_booking_rework_invalid');
  await rejects(create({}, { booking: { visitPurpose: 'member_visit' } }), 'dispatch_booking_membership_invalid');
  await rejects(create({}, { booking: { membershipId: 'sub_1' } }), 'dispatch_booking_membership_invalid');
  await rejects({ action: 'schedule.create', requestId: randomUUID(), kind: 'blocked', changes: { date: '2026-09-23', time: '08:00', endTime: '10:00' }, booking: { channel: 'hub_phone' } }, 'dispatch_booking_invalid');
  await rejects(create({}, { reasonCode: 'weather' }), 'dispatch_reason_code_invalid');
  const member = memory(customers), visit = await mutateDispatch(member, owner, create({}, { booking: { visitPurpose: 'member_visit', membershipId: 'sub_Synthetic1' } }), NOW);
  assert.deepEqual([saved(member, visit.job.id).visitPurpose, saved(member, visit.job.id).membershipId, member.events('job.scheduled')[0].membershipId], ['member_visit', 'sub_Synthetic1', 'sub_Synthetic1']);
});

test('a rework visit joins the project of the job it reworks, and only for the same customer', async () => {
  const store = memory({ ...customers, 'jobs/original': { type: 'job', customerId: 'c1', status: 'completed', date: '2026-09-01', time: '08:00', endTime: '10:00' }, 'jobs/foreign': { type: 'job', customerId: 'c2', status: 'completed' } });
  await assert.rejects(mutateDispatch(store, owner, create({}, { booking: { visitPurpose: 'rework', reworkOfJobId: 'foreign' } }), NOW), error => error.code === 'dispatch_booking_rework_invalid' && error.status === 409);
  await assert.rejects(mutateDispatch(store, owner, create({}, { booking: { visitPurpose: 'rework', reworkOfJobId: 'missing' } }), NOW), error => error.code === 'dispatch_booking_rework_invalid');
  const { job } = await mutateDispatch(store, owner, create({}, { booking: { visitPurpose: 'rework', reworkOfJobId: 'original' } }), NOW);
  assert.equal(saved(store, job.id).projectId, 'project_original');
  assert.equal(saved(store, 'original').projectId, 'project_original', 'the legacy original gets the project link in the same commit');
  assert.equal(saved(store, job.id).reworkOfJobId, 'original');
  assert.equal(store.events('job.scheduled')[0].data.visitPurpose, 'rework');
  assert.equal(store.events('job.scheduled')[0].projectId, 'project_original');
  // A stored link that is not a valid Hub id never builds a project path.
  const legacy = memory({ ...customers, 'jobs/old-a': { type: 'job', customerId: 'c1', status: 'completed', sourceWalkthroughId: '../w/1' } });
  const fixed = await mutateDispatch(legacy, owner, create({}, { booking: { visitPurpose: 'rework', reworkOfJobId: 'old-a' } }), NOW);
  assert.deepEqual([saved(legacy, fixed.job.id).projectId, saved(legacy, 'old-a').projectId], ['project_old-a', 'project_old-a']);
  const malformed = memory({ ...customers, 'jobs/old-b': { type: 'job', customerId: 'c1', status: 'completed', projectId: 'projects/other/doc' } });
  await assert.rejects(mutateDispatch(malformed, owner, create({}, { booking: { visitPurpose: 'rework', reworkOfJobId: 'old-b' } }), NOW), error => error.code === 'dispatch_booking_rework_invalid' && error.status === 409);
  assert.equal(malformed.commits.length, 0);
});

test('first placement is the booking; every later start change is a reschedule with from/to, reason, initiator and occurrence', async () => {
  const store = memory(customers), input = create({ date: '', time: '', endDate: '', endTime: '' }, { booking: { channel: 'hub_phone' } });
  let { job } = await mutateDispatch(store, owner, input, NOW);
  assert.equal(saved(store, job.id).scheduleOccurrence, 0);
  assert.equal(store.events('job.scheduled').length, 0, 'an unscheduled job is not booked on the calendar yet');
  ({ job } = await mutateDispatch(store, owner, edit(job, 'schedule.update', { changes: { date: '2026-09-24', time: '09:00', endTime: '11:00' } }), NOW));
  assert.deepEqual(store.events('job.scheduled').map(event => event.data), [{ channel: 'hub_phone', occurrence: 1, visitPurpose: 'service' }]);
  ({ job } = await mutateDispatch(store, owner, edit(job, 'schedule.update', { reasonCode: 'weather', initiatedBy: 'company', changes: { date: '2026-09-25' } }), NOW));
  ({ job } = await mutateDispatch(store, owner, edit(job, 'schedule.update', { changes: { endTime: '12:00' } }), NOW));
  assert.equal(store.events('job.rescheduled').length, 1, 'an end-time change alone is not a reschedule');
  ({ job } = await mutateDispatch(store, owner, edit(job, 'schedule.update', { reasonCode: 'customer_request', initiatedBy: 'customer', changes: { date: '', time: '', endDate: '', endTime: '' } }), NOW));
  ({ job } = await mutateDispatch(store, owner, edit(job, 'schedule.update', { changes: { date: '2026-09-28', time: '13:00', endTime: '15:00' } }), NOW));
  const moves = store.events('job.rescheduled').sort((a, b) => (a.data.occurrence || 99) - (b.data.occurrence || 99) || String(a.data.toStartAt).localeCompare(String(b.data.toStartAt)));
  assert.deepEqual(moves.map(event => event.data), [
    { fromStartAt: '2026-09-24T15:00:00.000Z', initiatedBy: 'company', occurrence: 2, reasonCode: 'weather', toStartAt: '2026-09-25T15:00:00.000Z' },
    { fromStartAt: null, occurrence: 3, toStartAt: '2026-09-28T19:00:00.000Z' },
    { fromStartAt: '2026-09-25T15:00:00.000Z', initiatedBy: 'customer', reasonCode: 'customer_request' },
  ].map(data => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null))));
  assert.equal(saved(store, job.id).scheduleOccurrence, 3);
  await assert.rejects(mutateDispatch(store, owner, edit(job, 'schedule.update', { reasonCode: 'other_legacy', changes: { date: '2026-09-29' } }), NOW), error => error.code === 'dispatch_reason_code_invalid', 'other_legacy is reserved for history');
  await assert.rejects(mutateDispatch(store, owner, edit(job, 'schedule.update', { initiatedBy: 'robot', changes: { date: '2026-09-29' } }), NOW), error => error.code === 'dispatch_reason_code_invalid');
});

test('a legacy placed visit taken off the calendar and placed again is one reschedule with occurrence 2, never a second booking', async () => {
  for (const kind of ['job', 'walkthrough']) {
    // Every visit placed before FUN-02 has no scheduleOccurrence counter.
    const store = memory({ ...customers, 'jobs/legacy': { type: kind, customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'contactA', status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-23', time: '08:00', endDate: '2026-09-23', endTime: '10:00', assignedCrew: [], projectId: 'project_legacy' } });
    let { job } = await mutateDispatch(store, owner, edit(saved(store, 'legacy'), 'schedule.update', { reasonCode: 'customer_request', initiatedBy: 'customer', changes: { date: '', time: '', endDate: '', endTime: '' } }), NOW);
    assert.equal(saved(store, 'legacy').scheduleOccurrence, 1, `${kind}: taking it off the calendar saves the placement it implies`);
    ({ job } = await mutateDispatch(store, owner, edit(job, 'schedule.update', { changes: { date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '11:00' } }), NOW));
    assert.equal(store.events(kind === 'job' ? 'job.scheduled' : 'walkthrough.booked').length, 0, `${kind}: placing it again is not a second booking`);
    assert.deepEqual(store.events(`${kind}.rescheduled`).map(event => event.data), [
      { fromStartAt: '2026-09-23T14:00:00.000Z', initiatedBy: 'customer', reasonCode: 'customer_request' },
      { occurrence: 2, toStartAt: '2026-09-25T15:00:00.000Z' }], kind);
    assert.equal(saved(store, 'legacy').scheduleOccurrence, 2, kind);
  }
});

test('cancel writes reasonCode next to the free-text reason with the computed lateCancel, and restore is an event too', async () => {
  const cases = [
    { at: '2026-09-22T15:00:00.000Z', extra: { reasonCode: 'customer_changed_plans', initiatedBy: 'customer' }, want: { code: 'customer_changed_plans', by: 'customer', late: true } },
    { at: NOW, extra: { reasonCode: 'customer_schedule_conflict', initiatedBy: 'customer' }, want: { code: 'customer_schedule_conflict', by: 'customer', late: false } },
    { at: '2026-09-22T15:00:00.000Z', extra: { reasonCode: 'weather', initiatedBy: 'company' }, want: { code: 'weather', by: 'company', late: false } },
    { at: NOW, extra: {}, want: { code: 'other_legacy', by: null, late: null } },
  ];
  for (const { at, extra, want } of cases) {
    const store = memory(customers), { job } = await mutateDispatch(store, owner, create(), NOW);
    const cancelled = await mutateDispatch(store, owner, edit(job, 'schedule.cancel', { cancellationReason: 'Synthetic free text', ...extra }), at), row = saved(store, cancelled.job.id);
    assert.deepEqual([row.status, row.cancellationReason, row.cancellationReasonCode, row.cancellationInitiatedBy, row.lateCancel], ['cancelled', 'Synthetic free text', want.code, want.by, want.late]);
    const [event] = store.events('job.cancelled');
    assert.deepEqual(event.data, Object.fromEntries(Object.entries({ fromStatus: 'scheduled', initiatedBy: want.by, lateCancel: want.late, reasonCode: want.code }).filter(([, value]) => value !== null)));
    assert.equal(store.rows.get(`dispatchOperations/${cancelled.requestId}`).after.cancellationReasonCode, want.code);
  }
  const store = memory(customers), { job } = await mutateDispatch(store, owner, create(), NOW);
  const cancelled = await mutateDispatch(store, owner, edit(job, 'schedule.cancel', { reasonCode: 'weather' }), NOW);
  await mutateDispatch(store, owner, edit(cancelled.job, 'schedule.restore'), NOW);
  assert.deepEqual(store.events('job.restored').map(event => event.data), [{ fromStatus: 'cancelled', toStatus: 'scheduled' }]);
  assert.equal(store.events('job.rescheduled').length + store.events('job.scheduled').length, 1, 'restoring the same slot is not a new booking or move');
  const walk = memory(customers), visit = await mutateDispatch(walk, owner, create({ assignedCrew: [] }, { kind: 'walkthrough' }), NOW);
  const dropped = await mutateDispatch(walk, owner, edit(visit.job, 'schedule.cancel', { reasonCode: 'diy', initiatedBy: 'customer' }), NOW);
  assert.deepEqual(walk.events('walkthrough.cancelled').map(event => [event.walkthroughId, event.data]), [[visit.job.id, { initiatedBy: 'customer', lateCancel: false, reasonCode: 'diy' }]]);
  await mutateDispatch(walk, owner, edit(dropped.job, 'schedule.restore'), NOW);
  assert.deepEqual(walk.events('walkthrough.restored').map(event => [event.walkthroughId, event.jobId, event.data]), [[visit.job.id, null, { fromStatus: 'cancelled', toStatus: 'scheduled' }]], 'a restored walkthrough is never labelled a job');
  assert.equal(walk.events('job.restored').length, 0);
  // A customer cancel of a visit whose saved time cannot be read is not known to be late or on time.
  const review = memory({ ...customers, 'jobs/review': { type: 'job', customerId: 'c1', customer: 'Synthetic Customer', status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-23', time: '08:00', endDate: '2026-09-23', endTime: '07:00' } });
  await mutateDispatch(review, owner, edit(saved(review, 'review'), 'schedule.cancel', { reasonCode: 'diy', initiatedBy: 'customer' }), NOW);
  assert.deepEqual([saved(review, 'review').lateCancel, review.events('job.cancelled').map(event => event.data)], [null, [{ fromStatus: 'scheduled', initiatedBy: 'customer', reasonCode: 'diy' }]]);
});

test('no-show is a new final action with a required reason, from one hour before the start, that frees the day and never touches the provider appointment', async () => {
  const store = memory(customers), { job } = await mutateDispatch(store, owner, create(), NOW);
  Object.assign(store.rows.get(`jobs/${job.id}`), { highlevelAppointmentId: 'apptA', syncStatus: 'synced' });
  const current = () => saved(store, job.id);
  await assert.rejects(mutateDispatch(store, owner, edit(current(), 'schedule.no_show', { reasonCode: 'customer_not_home' }), '2026-09-23T12:59:00.000Z'), error => error.code === 'dispatch_no_show_too_early' && error.status === 409);
  await assert.rejects(mutateDispatch(store, owner, edit(current(), 'schedule.no_show'), '2026-09-23T15:00:00.000Z'), error => error.code === 'dispatch_reason_code_required' && error.status === 400);
  await assert.rejects(mutateDispatch(store, owner, edit(current(), 'schedule.no_show', { reasonCode: 'weather' }), '2026-09-23T15:00:00.000Z'), error => error.code === 'dispatch_reason_code_invalid');
  await assert.rejects(mutateDispatch(store, owner, edit(current(), 'schedule.no_show', { reasonCode: 'no_access', changes: { title: 'x' } }), '2026-09-23T15:00:00.000Z'), error => error.code === 'dispatch_cancel_patch_invalid');
  const commits = store.commits.length, request = edit(current(), 'schedule.no_show', { reasonCode: 'customer_not_home' });
  store.fault = 'conflict';
  await assert.rejects(mutateDispatch(store, owner, request, '2026-09-23T13:30:00.000Z'), error => error.code === 'dispatch_revision_conflict');
  store.fault = null;
  assert.deepEqual([store.commits.length, store.events('job.no_show').length, current().status], [commits, 0, 'scheduled'], 'a failed no-show commit records nothing');
  const result = await mutateDispatch(store, owner, request, '2026-09-23T13:30:00.000Z');
  assert.equal(store.commits.length, commits + 1);
  assert.equal((await mutateDispatch(store, owner, request, '2026-09-23T13:45:00.000Z')).replayed, true);
  assert.equal(store.events('job.no_show').length, 1, 'a replayed no-show writes no second event');
  assert.deepEqual([current().status, current().pipelineStatus, current().noShowReasonCode, current().noShowBy, current().noShowAt, current().syncStatus], ['no_show', 'no_show', 'customer_not_home', 'zacb', '2026-09-23T13:30:00.000Z', 'synced']);
  assert.equal(result.providerSync, 'not_needed');
  assert.deepEqual(store.rows.get('jobs/_egc_schedule_lock_2026-09-23').entries, [], 'the crew and day are free again');
  assert.deepEqual(store.events('job.no_show').map(event => [event.jobId, event.data, event.occurredAt]), [[job.id, { occurrence: 1, reasonCode: 'customer_not_home' }, '2026-09-23T13:30:00.000Z']]);
  await assert.rejects(mutateDispatch(store, owner, edit(current(), 'schedule.restore'), '2026-09-23T14:00:00.000Z'), error => error.code === 'dispatch_terminal_job');
  await assert.rejects(mutateDispatch(store, owner, edit(current(), 'schedule.no_show', { reasonCode: 'no_access' }), '2026-09-23T14:00:00.000Z'), error => error.code === 'dispatch_terminal_job');
  // A walkthrough no-show is the walkthrough visit's own outcome (FUN-05 writes walkthrough.no_show), never a dispatch action.
  const walk = memory(customers), visit = await mutateDispatch(walk, owner, create({ assignedCrew: [] }, { kind: 'walkthrough' }), NOW), walkCommits = walk.commits.length;
  await assert.rejects(mutateDispatch(walk, owner, edit(visit.job, 'schedule.no_show', { reasonCode: 'unreachable' }), '2026-09-23T14:30:00.000Z'), error => error.code === 'dispatch_no_show_walkthrough' && error.status === 409);
  assert.deepEqual([walk.commits.length, walk.events('walkthrough.no_show').length, saved(walk, visit.job.id).status], [walkCommits, 0, 'scheduled']);
  const blocks = memory(customers), block = await mutateDispatch(blocks, owner, { action: 'schedule.create', requestId: randomUUID(), kind: 'blocked', changes: { date: '2026-09-23', time: '08:00', endTime: '10:00' } }, NOW);
  await assert.rejects(mutateDispatch(blocks, owner, edit(block.job, 'schedule.no_show', { reasonCode: 'no_access' }), '2026-09-23T15:00:00.000Z'), error => error.code === 'dispatch_no_show_invalid');
  assert.equal(blocks.events().length, 0, 'company blocks are never funnel events');
});

test('crew assignment changes emit job.assigned, including self-service shift pickup; unchanged crews do not', async () => {
  const store = memory(customers), { job } = await mutateDispatch(store, owner, create({ assignedCrew: [] }), NOW);
  assert.equal(store.events('job.assigned').length, 0);
  let result = await mutateDispatch(store, owner, edit(job, 'schedule.update', { changes: { assignedCrew: ['crew1'] } }), NOW);
  result = await mutateDispatch(store, owner, edit(result.job, 'schedule.update', { changes: { assignedCrew: ['crew1'], title: 'Same crew' } }), NOW);
  assert.equal(store.events('job.assigned').length, 1);
  await mutateDispatch(store, owner, edit(result.job, 'schedule.update', { changes: { assignedCrew: ['crew1', 'crew2'], crewNeeded: 3, shiftPickupEnabled: true } }), NOW);
  const open = saved(store, job.id);
  const pickup = { action: 'claim', jobId: job.id, requestId: randomUUID(), expectedRevision: open.revision };
  await mutateDispatchSelfAssignment(store, { user: 'zacb', role: 'owner' }, pickup, NOW);
  const events = store.events('job.assigned');
  assert.equal(events.length, 3);
  assert.ok(events.some(event => event.source.id === pickup.requestId && event.actor.id === 'zacb'));
  assert.equal((await mutateDispatchSelfAssignment(store, { user: 'zacb', role: 'owner' }, pickup, NOW)).replayed, true);
  assert.equal(store.events('job.assigned').length, 3, 'a replayed pickup writes no second event');
});

test('the production dispatch storage sends the events create-only in the one visit :commit and they decode unchanged', async () => {
  const store = memory(customers); let captured;
  store.before = writes => { captured = structuredClone(writes); };
  await mutateDispatch(store, owner, create({}, { booking: { channel: 'hub_phone' } }), NOW);
  const bodies = [], firestore = dispatchStorage({}, async (_env, url, options = {}) => { bodies.push({ url: String(url), body: JSON.parse(options.body) }); return Response.json({ writeResults: [] }); });
  await firestore.commit(captured);
  assert.equal(bodies.length, 1); assert.match(bodies[0].url, /documents:commit$/);
  const events = bodies[0].body.writes.filter(write => write.update.name.includes('/documents/funnelEvents/'));
  assert.equal(events.length, 2);
  for (const write of events) {
    assert.deepEqual(write.currentDocument, { exists: false });
    const doc = decodeFirestoreFields(write.update.fields), local = store.rows.get(`funnelEvents/${write.update.name.split('/').pop()}`);
    assert.deepEqual(doc, Object.fromEntries(Object.entries(local).filter(([key]) => !['id', 'revision'].includes(key))));
  }
});

test('dispatch customer search says whether each customer has a CRM contact, never the contact id', async () => {
  const store = memory(customers), handlers = dispatchHandlers({ session: async () => owner, storage: () => store, travel: () => null, now: () => new Date(NOW) });
  const body = await (await handlers.get({ request: new Request('https://easygaragecleaning.com/api/dispatch?view=customers&q=synthetic'), env: {} })).json();
  assert.deepEqual(body.customers.map(row => [row.id, row.crmLinked]).sort(), [['c1', true], ['c2', false]]);
  assert.ok(!JSON.stringify(body).includes('contactA'));
});

test('a failed shift pickup commit writes no event', async () => {
  const store = memory(customers), { job } = await mutateDispatch(store, owner, create({ assignedCrew: ['crew1'], crewNeeded: 2, shiftPickupEnabled: true }), NOW);
  const pickup = { action: 'claim', jobId: job.id, requestId: randomUUID(), expectedRevision: saved(store, job.id).revision }, before = store.events('job.assigned').length;
  store.fault = 'conflict';
  await assert.rejects(mutateDispatchSelfAssignment(store, { user: 'crew2', role: 'crew' }, pickup, NOW));
  store.fault = null;
  assert.equal(store.events('job.assigned').length, before);
  await mutateDispatchSelfAssignment(store, { user: 'crew2', role: 'crew' }, pickup, NOW);
  assert.deepEqual(store.events('job.assigned').filter(event => event.source.id === pickup.requestId).map(event => [event.actor.id, event.actor.role]), [['crew2', 'crew']]);
});

test('a failed business commit writes no event, and replays and concurrent retries write exactly one', async () => {
  const failing = memory(customers); failing.fault = 'conflict';
  await assert.rejects(mutateDispatch(failing, owner, create(), NOW), error => error.code === 'dispatch_revision_conflict');
  assert.equal(failing.events().length, 0);
  const lost = memory(customers), input = create(); lost.fault = 'lost';
  const first = await mutateDispatch(lost, owner, input, NOW); lost.fault = null;
  const replay = await mutateDispatch(lost, owner, input, NOW);
  assert.equal(replay.replayed, true); assert.equal(first.job.id, replay.job.id);
  assert.equal(lost.events('job.scheduled').length, 1); assert.equal(lost.commits.length, 1);
  const racing = memory(customers), same = create();
  await Promise.all(Array.from({ length: 5 }, () => mutateDispatch(racing, owner, same, NOW)));
  assert.equal(racing.events('job.scheduled').length, 1); assert.equal(racing.events('job.assigned').length, 1);
  const cancel = memory(customers), { job } = await mutateDispatch(cancel, owner, create(), NOW), request = edit(job, 'schedule.cancel', { reasonCode: 'weather' });
  cancel.fault = 'conflict'; await assert.rejects(mutateDispatch(cancel, owner, request, NOW)); assert.equal(cancel.events('job.cancelled').length, 0);
  cancel.fault = null; await mutateDispatch(cancel, owner, request, NOW); await mutateDispatch(cancel, owner, request, NOW);
  assert.equal(cancel.events('job.cancelled').length, 1);
  const restore = edit(saved(cancel, job.id), 'schedule.restore');
  cancel.fault = 'conflict'; await assert.rejects(mutateDispatch(cancel, owner, restore, NOW)); assert.equal(cancel.events('job.restored').length, 0);
  cancel.fault = null; await mutateDispatch(cancel, owner, restore, NOW); assert.equal((await mutateDispatch(cancel, owner, restore, NOW)).replayed, true);
  assert.equal(cancel.events('job.restored').length, 1);
  const move = edit(saved(cancel, job.id), 'schedule.update', { reasonCode: 'weather', initiatedBy: 'company', changes: { date: '2026-09-26' } });
  cancel.fault = 'conflict'; await assert.rejects(mutateDispatch(cancel, owner, move, NOW)); assert.equal(cancel.events('job.rescheduled').length, 0);
  cancel.fault = 'lost'; await mutateDispatch(cancel, owner, move, NOW); cancel.fault = null;
  assert.equal((await mutateDispatch(cancel, owner, move, NOW)).replayed, true);
  assert.deepEqual([cancel.events('job.rescheduled').length, saved(cancel, job.id).scheduleOccurrence], [1, 2]);
});

test('the dispatch API validates the new fields and GET lists the live reason codes from the shared definitions', async () => {
  const store = memory(customers), handlers = dispatchHandlers({ session: async () => owner, storage: () => store, travel: () => null, now: () => new Date(NOW) });
  const post = body => handlers.post({ request: new Request('https://easygaragecleaning.com/api/dispatch', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: {} });
  const bad = await post(create({}, { booking: { channel: 'fax' } }));
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'dispatch_booking_invalid');
  const good = await post(create({}, { booking: { channel: 'hub_phone' } }));
  assert.equal(good.status, 200); assert.equal(store.events('job.scheduled').length, 1);
  const read = await handlers.get({ request: new Request('https://easygaragecleaning.com/api/dispatch?startDate=2026-09-22&endDate=2026-09-29'), env: {} }), body = await read.json();
  assert.equal(read.status, 200);
  assert.deepEqual(body.funnel, dispatchFunnelOptions());
  assert.deepEqual(body.funnel.bookingChannels, ['hub_phone', 'hub_in_person']);
  assert.ok(!body.funnel.reasonCodes.cancel.includes('other_legacy') && body.funnel.reasonCodes.cancel.includes('weather'));
  assert.deepEqual(body.funnel.initiatedBy, ['customer', 'company']);
});

test('the operations bridge scheduler emits booking, reschedule and cancel events with bridge provenance', async () => {
  const store = memory({ 'customers/c1': { name: 'Synthetic Customer', highlevelContactId: 'contactA' } }), actor = { id: 'mcp-oauth-grant:SYNTHETIC-1', kind: 'integration', role: 'integration', workspace: 'egc' };
  const input = (extra = {}) => ({ command: 'schedule.mutate', requestId: randomUUID(), mode: 'create', portalCustomerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '10:00', endTime: '11:00' }, ...extra });
  const booking = input(), created = await mutateScheduledVisit(store, actor, booking, NOW), id = created.visit.portalVisitId, receipt = `_egc_schedule_op_${booking.requestId.replaceAll('-', '')}`;
  assert.deepEqual([saved(store, id).bookingChannel, saved(store, id).bookedBy, saved(store, id).visitPurpose, saved(store, id).scheduleOccurrence], ['mcp', actor.id, 'service', 1]);
  const [scheduled] = store.events('job.scheduled');
  assert.deepEqual([scheduled.via, scheduled.actor, scheduled.source, scheduled.data], ['bridge', { id: 'mcp-oauth-grant:synthetic-1', kind: 'integration', role: 'integration' }, { collection: 'jobs', id: receipt }, { channel: 'mcp', occurrence: 1, visitPurpose: 'service' }]);
  assert.ok(store.commits.at(-1).includes(`funnelEvents/${scheduled.id}`) && store.commits.at(-1).includes(`jobs/${receipt}`));
  assert.equal((await mutateScheduledVisit(store, actor, booking, NOW)).replayed, true);
  assert.equal(store.events('job.scheduled').length, 1);
  await assert.rejects(mutateScheduledVisit(store, actor, input({ reasonCode: 'weather' }), NOW), error => error.message === 'schedule_reason_code_invalid' && error.status === 400);
  let visit = saved(store, id);
  await assert.rejects(mutateScheduledVisit(store, actor, input({ mode: 'update', portalVisitId: id, expectedRevision: visit.revision, reasonCode: 'nope', changes: { time: '12:00', endTime: '13:00' } }), NOW), error => error.message === 'schedule_reason_code_invalid');
  await mutateScheduledVisit(store, actor, input({ mode: 'update', portalVisitId: id, expectedRevision: visit.revision, reasonCode: 'crew_unavailable', initiatedBy: 'company', changes: { time: '12:00', endTime: '13:00' } }), NOW);
  assert.deepEqual(store.events('job.rescheduled').map(event => event.data), [{ fromStartAt: '2026-09-23T16:00:00.000Z', initiatedBy: 'company', occurrence: 2, reasonCode: 'crew_unavailable', toStartAt: '2026-09-23T18:00:00.000Z' }]);
  visit = saved(store, id);
  store.fault = 'conflict';
  const cancel = input({ mode: 'cancel', portalVisitId: id, expectedRevision: visit.revision, changes: {} });
  await assert.rejects(mutateScheduledVisit(store, actor, cancel, NOW));
  assert.equal(store.events('job.cancelled').length, 0);
  store.fault = null;
  await mutateScheduledVisit(store, actor, cancel, NOW);
  assert.equal((await mutateScheduledVisit(store, actor, cancel, NOW)).replayed, true);
  assert.deepEqual([saved(store, id).cancellationReasonCode, saved(store, id).lateCancel], ['other_legacy', null]);
  assert.deepEqual(store.events('job.cancelled').map(event => event.data), [{ fromStatus: 'scheduled', reasonCode: 'other_legacy' }]);
  // The bridge lets a cancelled visit be cancelled again; that is not a second cancellation.
  await mutateScheduledVisit(store, actor, input({ mode: 'cancel', portalVisitId: id, expectedRevision: saved(store, id).revision, reasonCode: 'weather', initiatedBy: 'company', changes: {} }), '2026-09-22T13:00:00.000Z');
  assert.equal(store.events('job.cancelled').length, 1);
  assert.deepEqual([saved(store, id).status, saved(store, id).cancellationReasonCode, saved(store, id).cancellationInitiatedBy, saved(store, id).lateCancel, saved(store, id).cancelledAt, saved(store, id).cancelledBy], ['cancelled', 'other_legacy', null, null, NOW, actor.id], 'a repeat cancel keeps the facts of the original cancellation');
  assert.deepEqual([store.rows.get(`projects/${saved(store, id).projectId}`).highlevelContactId, store.rows.get(`projects/${saved(store, id).projectId}`).crmLinkReason], ['contactA', null], 'the bridge project records its CRM link');
});

test('the bridge never relabels a dispatch no-show a cancellation, and its events carry the via its audit entry records', async () => {
  const store = memory({ 'customers/c1': { name: 'Synthetic Customer', highlevelContactId: 'contactA' } }), actor = { id: 'mcp-oauth-grant:SYNTHETIC-2', kind: 'integration', role: 'integration', workspace: 'egc' };
  const booking = { command: 'schedule.mutate', requestId: randomUUID(), mode: 'create', portalCustomerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '10:00', endTime: '11:00' } };
  const id = (await mutateScheduledVisit(store, actor, booking, NOW, { via: 'mcp' })).visit.portalVisitId;
  assert.deepEqual(store.events().map(event => [event.type, event.via]), [['job.scheduled', 'mcp']]);
  Object.assign(store.rows.get(`jobs/${id}`), { status: 'no_show', pipelineStatus: 'no_show', noShowReasonCode: 'customer_not_home' });
  await assert.rejects(mutateScheduledVisit(store, actor, { ...booking, requestId: randomUUID(), mode: 'cancel', portalVisitId: id, expectedRevision: saved(store, id).revision, changes: {} }, NOW), error => error.message === 'schedule_terminal_visit_requires_review' && error.status === 409);
  assert.deepEqual([saved(store, id).status, saved(store, id).cancellationReasonCode, store.events('job.cancelled').length], ['no_show', undefined, 0]);
  assert.deepEqual(['portal', 'mcp', 'bridge', 'hub', 'elsewhere', undefined].map(eventVia), ['portal', 'mcp', 'bridge', 'hub', 'bridge', 'bridge']);
});

test('GHL self-booking adoption is its booking, dated by the provider clock, and a repeat adoption adds nothing', async () => {
  const now = '2026-09-22T07:00:00.000Z', actor = { id: 'booking-adoption-worker', kind: 'integration', role: 'integration', workspace: 'egc' };
  const proof = { source: 'ghl_appointment', sourceId: 'provider-appointment', sourceRevision: 'verified-r1', contactProviderId: 'provider-contact', providerContact: { id: 'provider-contact', name: 'Synthetic Customer', phone: '+12025550199', email: 'synthetic@example.invalid' }, kind: 'walkthrough', startAt: '2026-09-22T20:15:00.000Z', endAt: '2026-09-22T20:45:00.000Z', address: '100 Synthetic Lane', title: 'Synthetic walkthrough', originalBookingAt: '2026-09-20T16:05:00.000Z', sourceCreatedAt: '2026-09-20T16:05:00.000Z', verifiedAt: now, providerAppointmentId: 'provider-appointment', providerCalendarId: 'walkthrough-calendar', providerStatus: 'confirmed', localJobId: null, normalizedLocalAppointmentId: null, evidenceIds: ['appointment:provider-appointment'] };
  const store = memory(), input = { command: 'schedule.adopt', requestId: randomUUID(), proof };
  const failing = memory(); failing.fault = 'conflict';
  await assert.rejects(adoptScheduledVisit(failing, actor, input, now)); assert.equal(failing.events().length, 0);
  const result = await adoptScheduledVisit(store, actor, input, now), [booked] = store.events();
  assert.equal(result.adopted, true); assert.equal(store.events().length, 1);
  assert.deepEqual([booked.type, booked.walkthroughId, booked.clockSource, booked.occurredAt, booked.denverDate, booked.recordedAt, booked.via], ['walkthrough.booked', result.jobId, 'provider', '2026-09-20T16:05:00.000Z', '2026-09-20', now, 'bridge']);
  // FUN-29: the adopted walkthrough's new project is on the walkthrough path; nothing decides its service line yet.
  assert.deepEqual(booked.data, { channel: 'ghl_self_booking', occurrence: 1, visitPurpose: 'walkthrough', funnelPath: 'walkthrough' });
  const adoptedProject = store.rows.get(`projects/${saved(store, result.jobId).projectId}`);
  assert.deepEqual([adoptedProject.serviceLine, adoptedProject.serviceLineSource, adoptedProject.funnelPath, adoptedProject.funnelPathSource], [null, null, 'walkthrough', 'walkthrough']);
  assert.equal(booked.idempotencyKey, 'ghlAdoption:ghl_appointment:provider-appointment');
  assert.deepEqual([saved(store, result.jobId).bookingChannel, saved(store, result.jobId).scheduleOccurrence], ['ghl_self_booking', 1]);
  await adoptScheduledVisit(store, actor, { ...input, requestId: randomUUID() }, now);
  assert.equal(store.events().length, 1, 'the same appointment adopted again is the same booking');
  const local = memory(), unknown = await adoptScheduledVisit(local, actor, { command: 'schedule.adopt', requestId: randomUUID(), proof: { ...proof, source: 'local_job', sourceId: '0b3b9a28-2135-4353-8cb7-ddd9e9bd977a', localJobId: '0b3b9a28-2135-4353-8cb7-ddd9e9bd977a', providerAppointmentId: null, providerCalendarId: null, providerStatus: null, originalBookingAt: null, sourceCreatedAt: null } }, now);
  const [localBooked] = local.events();
  assert.deepEqual([localBooked.clockSource, localBooked.occurredAt, localBooked.data.channel, saved(local, unknown.jobId).bookingChannel], ['server', now, undefined, null], 'an unknown channel and booking time stay unknown, never guessed');
  const existing = memory({ 'jobs/existing': { type: 'walkthrough', date: '2026-09-22', time: '14:15', endTime: '14:45', highlevelContactId: 'provider-contact', address: '100 Synthetic Lane', status: 'scheduled', pipelineStatus: 'scheduled' } });
  assert.equal((await adoptScheduledVisit(existing, actor, { ...input, requestId: randomUUID() }, now)).adopted, false);
  assert.equal(existing.events().length, 0, 'linking a visit the Hub already booked is not a second booking');
});

// Walkthrough handoff: the plan mirrors tests/walkthrough-handoff.test.mjs.
const HANDOFF_NOW = '2026-09-22T18:00:00.000Z';
const plan = (quote = {}, acceptedAt = '2026-09-22T17:45:00.000Z') => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'provider1' }, quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: '2026-09-24', start_time: '09:00', end_time: '12:00', estimated_duration_min: 180, ...quote }, acceptance: { accepted_at: acceptedAt, accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle', finish: ['shelving'], finish_details: { shelf_type: 'metal', shelf_qty: 2 } }, discovery: { success: 'Park a vehicle' }, logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Use side gate' }, internal_notes: 'Keep blue bicycle.', notes: 'Call before arrival', client_checklists: { preJob: [{ id: 'keep-bike', label: 'Protect blue bicycle', detail: 'Move to safe area', critical: true }], postJob: [] } });
const handoffStore = (walkthrough = {}) => memory({ 'customers/c1': { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }, 'jobs/w1': { type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1', ...walkthrough }, 'projects/p1': { customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' } });
const handoff = (store, extra = {}) => ({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: store.rows.get('jobs/w1').revision, plan: plan(), ...extra });

test('a signed handoff writes deal.sold on the device clock inside its two-sided bounds and sets sold_on_site in the same commit', async () => {
  const store = handoffStore(), input = handoff(store), result = await saveWalkthroughHandoff(store, owner, input, HANDOFF_NOW);
  const [sold] = store.events('deal.sold'), walk = store.rows.get('jobs/w1');
  // FUN-29: the sale records the project's service line and path; the legacy project p1 had neither, so the signed job
  // (a garage transformation sold on a walkthrough) sets them in the same commit.
  assert.deepEqual([sold.projectId, sold.jobId, sold.walkthroughId, sold.customerId, sold.highlevelContactId, sold.data], ['p1', result.job.id, 'w1', 'c1', 'provider1', { amountCents: 140000, estimateRevision: 1, serviceLine: 'garage_transformation', funnelPath: 'walkthrough' }]);
  const project = store.rows.get('projects/p1');
  assert.deepEqual([project.serviceLine, project.serviceLineSource, project.funnelPath, project.funnelPathSource, project.dimensionRulesVersion], ['garage_transformation', 'salesExitService', 'walkthrough', 'walkthrough', 1]);
  assert.deepEqual([sold.clockSource, sold.occurredAt, sold.deviceAt, sold.recordedAt, sold.clockReasons], ['device_validated', '2026-09-22T17:45:00.000Z', '2026-09-22T17:45:00.000Z', HANDOFF_NOW, []]);
  assert.deepEqual(sold.source, { collection: 'walkthroughHandoffs', id: input.requestId });
  // The outcome uses FUN-05's walkthroughOutcome shape, dated like the sale, so FUN-05 and FUN-06 readers use it as is.
  assert.deepEqual(walk.walkthroughOutcome, { outcome: 'sold_on_site', reasonCode: null, finishedAt: '2026-09-22T17:45:00.000Z', performedBy: 'zacb', recordingStatus: null, requestId: input.requestId, clockSource: 'device_validated', deviceAt: '2026-09-22T17:45:00.000Z',
    occurrence: { number: 1, date: '2026-09-22', time: '11:00', startAt: '2026-09-22T17:00:00.000Z', scheduleOccurrence: null }, repTime: { status: 'not_started', segmentId: null }, source: 'walkthrough_handoff' });
  assert.deepEqual([walkthroughVisitProjection(walk).walkthroughOutcome.finishedAt, walkthroughVisitProjection(walk).walkthroughOutcome.occurrence.number, walkthroughVisitProjection(walk).rebookPending], ['2026-09-22T17:45:00.000Z', 1, false]);
  assert.deepEqual([walk.status, walk.walkthroughCompletedAt, store.events('walkthrough.completed').length], ['scheduled', undefined, 0], 'the walkthrough completion and its event stay with FUN-05');
  const [scheduled] = store.events('job.scheduled');
  assert.equal(scheduled.data.channel, 'hub_in_person');
  const commit = store.commits.at(-1);
  for (const key of ['jobs/w1', 'projects/p1', `jobs/${result.job.id}`, `walkthroughHandoffs/${input.requestId}`, `funnelEvents/${sold.id}`, `funnelEvents/${scheduled.id}`]) assert.ok(commit.includes(key), key);
  assert.equal((await saveWalkthroughHandoff(store, owner, input, HANDOFF_NOW)).replayed, true);
  assert.equal(store.events('deal.sold').length, 1, 'a replay never writes a second sale');
});

test('a device signature time outside the bounds is attested and dated at the bound, never before the walkthrough', async () => {
  const early = handoffStore(), input = handoff(early, { plan: plan({}, '2026-09-20T10:00:00.000Z') });
  await saveWalkthroughHandoff(early, owner, input, HANDOFF_NOW);
  const [sold] = early.events('deal.sold');
  assert.deepEqual([sold.clockSource, sold.occurredAt, sold.deviceAt, sold.clockReasons, sold.denverDate], ['attested', '2026-09-21T06:00:00.000Z', '2026-09-20T10:00:00.000Z', ['device_time_before_bounds'], '2026-09-21']);
  const started = handoffStore({ walkthroughVisit: { startedAt: '2026-09-22T17:00:00.000Z' } });
  await saveWalkthroughHandoff(started, owner, handoff(started, { plan: plan({}, '2026-09-22T15:00:00.000Z') }), HANDOFF_NOW);
  assert.deepEqual(started.events('deal.sold').map(event => [event.clockSource, event.occurredAt]), [['attested', '2026-09-22T16:00:00.000Z']]);
  const failing = handoffStore(); failing.fault = 'conflict';
  await assert.rejects(saveWalkthroughHandoff(failing, owner, handoff(failing), HANDOFF_NOW));
  assert.equal(failing.events().length, 0, 'a failed handoff commit records no sale');
  assert.equal(failing.rows.get('jobs/w1').walkthroughOutcome, undefined);
});

test('an outcome the walkthrough visit already recorded is never overwritten by the handoff', async () => {
  const outcome = { outcome: 'quote_to_follow', reasonCode: null, finishedAt: '2026-09-22T17:30:00.000Z', performedBy: 'rep.one', recordingStatus: 'recorded', requestId: randomUUID(), clockSource: 'server', repTime: null };
  const store = handoffStore({ walkthroughOutcome: outcome, walkthroughCompletedAt: '2026-09-22T17:30:00.000Z' }), input = handoff(store);
  await saveWalkthroughHandoff(store, owner, input, HANDOFF_NOW);
  assert.deepEqual(store.rows.get('jobs/w1').walkthroughOutcome, outcome);
  assert.equal(store.rows.get('jobs/w1').convertedJobId, store.events('deal.sold')[0].jobId);
  assert.equal(store.events('deal.sold').length, 1, 'the sale is still recorded; FUN-12/FUN-25 reconcile an outcome that disagrees');
});

test('a walkthrough the rep Started (FUN-05) gets its outcome from Finish: the handoff records the sale, then Finish writes walkthrough.completed and closes the rep segment', async () => {
  const rep = { user: 'Sales.Rep', displayName: 'Synthetic Sales Rep', role: 'sales', businessAccess: false, source: 'employee-account' };
  const store = handoffStore({ assignedCrew: ['sales.rep'] }), shiftKey = 'jobs/secure_shift_sales.rep', visit = () => store.rows.get('jobs/w1');
  Object.assign(store, {
    assigned: async (session, job) => (job.assignedCrew || []).includes(session.user.toLowerCase()),
    activeShift: async () => { const row = store.rows.get(shiftKey); return row && !row.sealed.clockOutAt ? { entry: structuredClone(row.sealed), documentId: shiftKey.slice(5), revision: row.revision } : null; },
    sealShift: async (_id, data, updatedAt) => ({ sealed: structuredClone(data), updatedAt }),
  });
  store.rows.set(shiftKey, { id: shiftKey.slice(5), revision: 'shift-r0', sealed: authorizeTimecard({ session: rep, manager: false, id: 'shift-sales.rep', incoming: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08 } }, hourlyRate: 22, now: '2026-09-22T16:50:00.000Z' }) });
  const start = await recordWalkthroughVisit(store, rep, { action: 'start', visitId: 'w1', requestId: randomUUID(), expectedRevision: visit().revision, recordingStatus: 'recorded' }, '2026-09-22T17:05:00.000Z');
  assert.equal(start.visit.walkthroughVisit.repTime.status, 'segment_opened');
  await saveWalkthroughHandoff(store, owner, handoff(store), HANDOFF_NOW);
  assert.deepEqual([visit().walkthroughOutcome, visit().convertedJobId, store.events('deal.sold').length], [undefined, store.events('deal.sold')[0].jobId, 1], 'the handoff leaves a started visit\'s outcome to its Finish');
  const finish = { action: 'finish', visitId: 'w1', requestId: randomUUID(), expectedRevision: visit().revision, outcome: 'sold_on_site', recordingStatus: 'recorded' };
  const done = await recordWalkthroughVisit(store, rep, finish, '2026-09-22T18:10:00.000Z');
  assert.deepEqual([done.visit.walkthroughOutcome.outcome, done.visit.walkthroughOutcome.finishedAt, done.visit.walkthroughCompletedAt, done.repTime.status], ['sold_on_site', '2026-09-22T18:10:00.000Z', '2026-09-22T18:10:00.000Z', 'segment_closed']);
  assert.equal(visit().walkthroughOutcome.requestId, finish.requestId, 'the outcome is written once, by Finish');
  assert.deepEqual(store.events('walkthrough.completed').map(event => [event.walkthroughId, event.data]), [['w1', { outcome: 'sold_on_site', recordingStatus: 'recorded' }]]);
  assert.deepEqual([...store.rows].filter(([key]) => key.startsWith('walkthroughVisitLocks/')).map(([, lock]) => lock.openVisitId), [''], 'the rep can start their next walkthrough');
  assert.equal(store.events('deal.sold').length, 1);
});

test('a revised signature retires the approval it replaces, so sold minus superseded is the current contract', async () => {
  const store = handoffStore(), first = await saveWalkthroughHandoff(store, owner, handoff(store), HANDOFF_NOW), job = store.rows.get(`jobs/${first.job.id}`);
  const revised = handoff(store, { jobId: first.job.id, expectedRevision: job.revision, plan: plan({ total: 1800, deposit: 900 }) });
  await saveWalkthroughHandoff(store, owner, revised, HANDOFF_NOW);
  const sold = store.events('deal.sold'), superseded = store.events('deal.approval_superseded');
  assert.deepEqual(superseded.map(event => [event.data, event.source.id]), [[{ amountCents: 140000, estimateRevision: 1 }, revised.requestId]]);
  assert.deepEqual(sold.map(event => event.data.amountCents).sort(), [140000, 180000]);
  const net = sold.reduce((sum, event) => sum + event.data.amountCents, 0) - superseded.reduce((sum, event) => sum + event.data.amountCents, 0);
  assert.equal(net, Math.round(store.rows.get(`jobs/${first.job.id}`).estimate.amount * 100));
  assert.equal(store.events('job.rescheduled').length, 0, 'the same date is not a move');
});

test('recording approval commits scope.reviewed with the review and its receipt, on the injected clock', async () => {
  const docs = new Map([['jobs/job-1', { type: 'job', customerId: 'customer-1', sourceWalkthroughId: 'visit-1', projectId: 'project-1', highlevelContactId: 'contactA' }], ['jobs/visit-1', { type: 'walkthrough', customerId: 'customer-1', convertedJobId: 'job-1' }], ['customers/customer-1', { name: 'Synthetic' }]]);
  const commits = []; let reject = false;
  const fetcher = async (_env, url, options = {}) => {
    if (String(url).endsWith(':commit')) { const body = JSON.parse(options.body); if (reject) return Response.json({ error: 'conflict' }, { status: 409 }); commits.push(body.writes); return Response.json({ writeResults: [] }); }
    const path = String(url).split('/documents/')[1], value = docs.get(path);
    return value ? Response.json({ name: `projects/test/databases/(default)/documents/${path}`, updateTime: 'revision-1', fields: encodeFirestoreFields(value) }) : Response.json({}, { status: 404 });
  };
  const command = { recordingId: '10000000-0000-4000-a000-000000000001', requestId: '20000000-0000-4000-a000-000000000002', fingerprint: 'a'.repeat(64), portalJobId: 'job-1', portalVisitId: 'visit-1', portalCustomerId: 'customer-1', portalProjectId: 'project-1', expectedRevision: 'revision-1', extraction: { itemsKeep: ['Bike'] } };
  const actor = { id: 'synthetic-owner', role: 'owner', kind: 'human', workspace: 'egc' }, at = '2026-10-01T15:00:00.000Z';
  reject = true;
  await assert.rejects(applyRecordingApproval({}, command, actor, fetcher, { now: at }), /source_revision_conflict/);
  assert.equal(commits.length, 0);
  reject = false;
  const result = await applyRecordingApproval({}, command, actor, fetcher, { now: at });
  assert.equal(result.appliedAt, '2026-10-01T15:00:00.000Z');
  const [job, receipt, event] = commits[0];
  assert.match(job.update.name, /\/jobs\/job-1$/); assert.match(receipt.update.name, /\/operation_recording_approvals\//);
  assert.deepEqual(event.currentDocument, { exists: false });
  const doc = decodeFirestoreFields(event.update.fields);
  assert.deepEqual([doc.type, doc.walkthroughId, doc.jobId, doc.projectId, doc.customerId, doc.highlevelContactId, doc.occurredAt, doc.via, doc.clockSource], ['scope.reviewed', 'visit-1', 'job-1', 'project-1', 'customer-1', 'contactA', '2026-10-01T15:00:00.000Z', 'bridge', 'server']);
  assert.deepEqual(doc.actor, { id: 'synthetic-owner', kind: 'human', role: 'owner' });
  assert.deepEqual(doc.source, { collection: 'operation_recording_approvals', id: command.recordingId });
  assert.equal(event.update.name.split('/').pop(), funnelEventId('scope.reviewed', { field: 'walkthroughId', value: 'visit-1' }, `requestId:${command.requestId}`));
  // The recording approval accepts any hex request id; one outside RFC 9562 maps to its stable version-8 funnel key.
  const loose = { ...command, recordingId: '30000000-0000-4000-a000-000000000003', requestId: '00000000-0000-0000-0000-000000000009' };
  await applyRecordingApproval({}, loose, actor, fetcher, { now: at });
  assert.equal(commits[1][2].update.name.split('/').pop(), funnelEventId('scope.reviewed', { field: 'walkthroughId', value: 'visit-1' }, `requestId:${requestKey(loose.requestId).value}`));
  docs.set(`operation_recording_approvals/${command.recordingId}`, { fingerprint: command.fingerprint, portalJobId: 'job-1', appliedAt: 'saved' });
  assert.equal((await applyRecordingApproval({}, command, actor, fetcher, { now: at })).alreadyApplied, true);
  assert.equal(commits.length, 2, 'a replayed approval writes no second event');
  // Through the bridge, the event carries the same via as the review's hub_audit entry.
  const bridged = { command: 'recording.apply', ...command, recordingId: '40000000-0000-4000-a000-000000000004', requestId: '50000000-0000-4000-a000-000000000005' };
  const bridge = await prepareBridgeCommand({}, { ...actor, id: 'zacb' }, bridged, { commands: RECORDING_COMMANDS, unknown: 'unsupported_recording_command', now: at });
  await applyRecordingApproval({}, bridge.command, { ...actor, id: 'zacb' }, fetcher, { now: bridge.now, audit: bridge.audit, via: bridge.via });
  const written = commits[2].map(write => decodeFirestoreFields(write.update.fields)), audit = written.find(doc => doc.entityKey === 'jobs/job-1'), reviewed = written.find(doc => doc.type === 'scope.reviewed');
  assert.deepEqual([bridge.via, audit.via, reviewed.via], ['portal', 'portal', 'portal']);
});

test('the helpers keep unknown values null, reserve legacy codes and never fail a commit on an actor or provider time they cannot store', async () => {
  const fail = (reason, message, status = 400) => Object.assign(new Error(message), { code: reason, status });
  // FUN-29 added the service-line and funnel-path one-tap picks to the booking facts.
  assert.deepEqual(bookingInput(undefined, 'job', fail), { bookingChannel: null, channelSelfReported: null, visitPurpose: 'service', reworkOfJobId: null, membershipId: null, crmLinkReason: null, serviceLine: null, funnelPath: null });
  assert.equal(bookingInput({}, 'walkthrough', fail).visitPurpose, 'walkthrough');
  assert.deepEqual(reasonInput({}, 'cancel', fail), { reasonCode: null, initiatedBy: null });
  assert.throws(() => reasonInput({ reasonCode: 'other_legacy' }, 'noShow', fail), error => error.code === 'reason_code_invalid');
  assert.equal(lateCancel('2026-09-23T14:00:00.000Z', '2026-09-22T14:00:01.000Z', 'customer'), true);
  assert.equal(lateCancel('2026-09-23T14:00:00.000Z', '2026-09-22T14:00:00.000Z', 'customer'), false, 'exactly 24 hours ahead is on time');
  assert.equal(lateCancel(null, NOW, 'customer'), false, 'a visit that was never placed is not a late cancel');
  assert.equal(lateCancel(undefined, NOW, 'customer'), null, 'an unreadable start is unknown');
  assert.equal(lateCancel('not a time', NOW, 'customer'), null);
  assert.deepEqual([cancelStart({ date: '', time: '', endDate: '', endTime: '' }), cancelStart({ date: '2026-09-23', time: '08:00', endTime: '07:00' }), cancelStart({ date: '2026-09-23', time: '08:00', endTime: '10:00' })], [null, undefined, '2026-09-23T14:00:00.000Z']);
  assert.deepEqual(cancelPatch({ reasonCode: 'diy', initiatedBy: 'customer' }, { date: '2026-09-23', time: '25:00', endTime: '10:00' }, NOW), { cancellationReasonCode: 'diy', cancellationInitiatedBy: 'customer', lateCancel: null });
  assert.equal(cancelPatch({ reasonCode: 'diy', initiatedBy: 'customer' }, { date: '', time: '' }, NOW).lateCancel, false);
  assert.equal(lateCancel('2026-09-23T14:00:00.000Z', NOW, 'system'), false);
  assert.equal(lateCancel('2026-09-23T14:00:00.000Z', NOW, null), null);
  assert.deepEqual(requestKey('A704AB81-A755-4CCF-91DD-A14D304CF175'), { kind: 'requestId', value: 'a704ab81-a755-4ccf-91dd-a14d304cf175' });
  const loose = requestKey('00000000-0000-0000-0000-000000000000');
  assert.match(loose.value, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.deepEqual(requestKey('00000000-0000-0000-0000-000000000000'), loose);
  assert.deepEqual(eventActor({ id: 'ZacB', kind: 'human', role: 'Owner' }), { id: 'zacb', kind: 'human', role: 'owner' });
  const odd = eventActor({ id: 'Name With Spaces/1', kind: 'robot', role: 'bad role!' });
  assert.match(odd.id, /^sha256:[0-9a-f]{32}$/); assert.deepEqual([odd.kind, odd.role], ['integration', null]);
  assert.deepEqual(providerClock('2026-09-20T16:05:00Z', NOW), { clockSource: 'provider', occurredAt: '2026-09-20T16:05:00.000Z' });
  assert.equal(providerClock('1970-01-01T00:00:00.000Z', NOW), null); assert.equal(providerClock('2026-09-22T12:06:00.000Z', NOW), null); assert.equal(providerClock(null, NOW), null);
  const legacy = { id: 'legacy', type: 'job', date: '2026-09-23', time: '08:00', endTime: '10:00', status: 'Scheduled!', customerId: 'secure_hidden', projectId: '_egc_private', highlevelContactId: 'bad id' };
  const { writes } = await visitFunnelWrites({ action: 'update', before: legacy, after: { ...legacy, date: '2026-09-24' }, actor: eventActor({ id: 'zacb', kind: 'human', role: 'owner' }), via: 'hub', key: requestKey(randomUUID()), source: { collection: 'dispatchOperations', id: 'receipt' }, now: NOW });
  assert.deepEqual(writes.map(write => [write.patch.type, write.patch.data.occurrence, write.patch.customerId, write.patch.projectId, write.patch.highlevelContactId]), [['job.rescheduled', 2, null, null, null]], 'a legacy placed job counts as placed once; unusable ids are left out, not fatal');
  const unplaced = { id: 'legacy-2', type: 'cleanout', date: '', time: '', endTime: '', status: 'unscheduled', bookingChannel: 'fax', channelSelfReported: 'billboard', visitPurpose: 'weird' };
  const placed = await visitFunnelWrites({ action: 'update', before: unplaced, after: { ...unplaced, date: '2026-09-24', time: '08:00', endTime: '10:00' }, actor: eventActor({ id: 'zacb', kind: 'human', role: 'owner' }), via: 'hub', key: requestKey(randomUUID()), source: { collection: 'dispatchOperations', id: 'receipt' }, now: NOW });
  assert.deepEqual([placed.writes.map(write => [write.patch.type, write.patch.data]), placed.patch], [[['job.scheduled', { occurrence: 1, visitPurpose: 'service' }]], { scheduleOccurrence: 1 }], 'a legacy job placed for the first time is its booking; unknown stored facts stay unknown');
  const moved = at => funnelEventWrite(null, NOW, { type: 'job.rescheduled', idempotencyKey: requestKey(randomUUID()), jobId: 'job-1', actor: eventActor({ id: 'zacb', kind: 'human' }), via: 'hub', source: { collection: 'dispatchOperations', id: 'receipt' }, data: { toStartAt: at }, eligibility: { hub: { id: 'job-1', type: 'job' } } });
  assert.equal((await moved('2026-09-24T09:00:00-06:00')).patch.data.toStartAt, '2026-09-24T15:00:00.000Z', 'instants are stored in UTC');
  for (const bad of ['2026-09-24', 'tomorrow', 1790000000000]) await assert.rejects(moved(bad), error => error.code === 'funnel_event_invalid', String(bad));
});
