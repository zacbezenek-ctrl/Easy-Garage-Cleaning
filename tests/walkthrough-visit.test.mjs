import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordWalkthroughVisit, walkthroughPerformer, walkthroughVisitProjection, walkthroughVisitState, WALKTHROUGH_VISIT_LOCKS, WALKTHROUGH_VISIT_OPERATIONS } from '../functions/_lib/walkthrough-visit.js';
import { authorizeTimecard } from '../functions/_lib/employee-timecards.js';
import { activeJobSegment, employeeJobTime } from '../functions/_lib/employee-job-time.js';
import { computeJobLaborCost } from '../functions/_lib/job-labor-cost.js';

// Synthetic fixtures only. The clock is always injected.
const CLOCK_IN = '2026-09-22T14:00:00.000Z', NOW = '2026-09-22T15:00:00.000Z', FINISH = '2026-09-22T16:00:00.000Z';
// The fixture visit is at 09:00 Denver (MDT) on 2026-09-22.
const FIRST = { number: 1, date: '2026-09-22', time: '09:00', startAt: '2026-09-22T15:00:00.000Z' };
const sales = { user: 'Sales.Rep', displayName: 'Synthetic Sales Rep', role: 'sales', businessAccess: false, source: 'employee-account' };
const otherRep = { user: 'Sales.Two', displayName: 'Synthetic Second Rep', role: 'sales', businessAccess: false, source: 'employee-account' };
const manager = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const owner = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const walkthrough = (extra = {}) => ({ type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', date: '2026-09-22', time: '09:00', endTime: '10:00', assignedCrew: ['sales.rep'], projectId: 'project_w1', highlevelContactId: 'contact1',
  estimate: { amount: 1437 }, payment: { amount: 91 }, signatureData: 'SYNTHETIC-SIGNATURE', internalNotes: 'Synthetic private note', ...extra });

// In-memory Firestore: revision per write, create-only without a revision, compare-and-set with
// one, the whole commit or nothing. The sealed timecard is stored as {sealed: entry}.
function fixture({ rows: seed = {}, offlineClock = false } = {}) {
  const rows = new Map(), commits = [], hooks = { before: null, after: null }; let n = 0;
  const put = (key, value) => rows.set(key, { ...structuredClone(value), revision: `r${++n}` });
  put('jobs/w1', walkthrough()); put('jobs/w2', walkthrough({ customer: 'Second Synthetic Customer', time: '11:00', endTime: '12:00', projectId: 'project_w2' }));
  put('jobs/w3', walkthrough({ assignedCrew: ['sales.two'], projectId: 'project_w3' })); put('jobs/job-a', { type: 'job', status: 'scheduled', assignedCrew: ['sales.rep'] });
  for (const [key, value] of Object.entries(seed)) put(key, value);
  const shiftKey = user => `jobs/secure_shift_${user.toLowerCase()}`;
  const store = {
    env: offlineClock ? { EGC_OFFLINE_CLOCK_ENABLED: 'true' } : {},
    read: async (collection, id) => { const row = rows.get(`${collection}/${id}`); return row ? structuredClone({ ...row, id }) : null; },
    assigned: async (session, job) => (job.assignedCrew || []).includes(session.user.toLowerCase()),
    activeShift: async session => {
      const row = rows.get(shiftKey(session.user));
      return row && row.sealed.status === 'active' && !row.sealed.clockOutAt ? { entry: structuredClone(row.sealed), documentId: shiftKey(session.user).slice(5), revision: row.revision } : null;
    },
    sealShift: async (documentId, data, updatedAt) => ({ sealed: structuredClone(data), updatedAt }),
    commit: async writes => {
      if (hooks.before) { const hook = hooks.before; hooks.before = null; hook(writes); }
      const keys = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(keys).size, keys.length, 'a commit never writes one document twice');
      for (const write of writes) {
        const current = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? current?.revision !== write.revision : current) throw Object.assign(new Error('conflict'), { code: 'walkthrough_visit_revision_conflict', status: 409 });
      }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...structuredClone(write.patch), revision: `r${++n}` });
      commits.push(keys);
      if (hooks.after) { const hook = hooks.after; hooks.after = null; hook(); }
    },
  };
  const clockIn = (session = sales, at = CLOCK_IN) => put(shiftKey(session.user), { sealed: authorizeTimecard({ session, manager: false, id: `shift-${session.user.toLowerCase()}`, incoming: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08 } }, hourlyRate: 22, now: at }) });
  const shift = (session = sales) => rows.get(shiftKey(session.user))?.sealed;
  const setShift = (entry, session = sales) => put(shiftKey(session.user), { sealed: entry });
  const rev = id => rows.get(`jobs/${id}`)?.revision || 'missing';
  const body = (action, extra = {}) => ({ action, visitId: 'w1', requestId: randomUUID(), expectedRevision: rev(extra.visitId || 'w1'), ...(action === 'start' ? { recordingStatus: 'recorded' } : {}), ...extra });
  const run = (session, input, now = NOW) => recordWalkthroughVisit(store, session, input, now);
  const events = type => [...rows].filter(([key, row]) => key.startsWith('funnelEvents/') && (!type || row.type === type)).map(([, row]) => row);
  const locks = () => [...rows].filter(([key]) => key.startsWith(`${WALKTHROUGH_VISIT_LOCKS}/`)).map(([, row]) => row);
  return { rows, commits, hooks, store, put, clockIn, shift, setShift, rev, body, run, events, locks, visit: id => rows.get(`jobs/${id}`) };
}
const rejects = (promise, code, status) => assert.rejects(promise, error => { assert.equal(error.code, `walkthrough_visit_${code}`, error.message); if (status) assert.equal(error.status, status); return true; });

test('Start opens the rep\'s work segment on the visit id and records the visit, lock, receipt and event in one commit', async () => {
  const f = fixture(); f.clockIn();
  const input = f.body('start'), result = await f.run(sales, input);
  assert.equal(result.ok, true); assert.equal(result.replayed, false); assert.equal(result.action, 'start'); assert.equal(result.requestId, input.requestId);
  assert.deepEqual(result.visit.walkthroughVisit, { startedAt: NOW, startedBy: 'sales.rep', clockSource: 'server', recordingStatus: 'recorded', repTime: { status: 'segment_opened', segmentId: input.requestId }, occurrence: FIRST });
  assert.equal(result.visit.rebookPending, false); assert.equal(result.visit.previousOccurrences, 0);
  assert.equal(result.visit.revision, f.rev('w1'));
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.commits[0].map(key => key.split('/')[0] + (key.startsWith('jobs/secure_') ? '/secure' : '')).sort(), ['funnelEvents', 'jobs', 'jobs/secure', WALKTHROUGH_VISIT_LOCKS, WALKTHROUGH_VISIT_OPERATIONS].sort());
  const [event] = f.events('walkthrough.started');
  assert.equal(event.walkthroughId, 'w1'); assert.equal(event.projectId, 'project_w1'); assert.equal(event.customerId, 'c1'); assert.equal(event.highlevelContactId, 'contact1'); assert.equal(event.jobId, null);
  assert.equal(event.occurredAt, NOW); assert.equal(event.clockSource, 'server'); assert.equal(event.denverDate, '2026-09-22');
  assert.deepEqual(event.actor, { id: 'sales.rep', kind: 'human', role: 'sales' }); assert.equal(event.via, 'hub');
  assert.deepEqual(event.source, { collection: WALKTHROUGH_VISIT_OPERATIONS, id: input.requestId }); assert.deepEqual(event.data, { recordingStatus: 'recorded' });
  assert.equal(event.isTest, false); assert.equal(event.isInternal, false);
  // The P1-03 timecard now attributes time to the walkthrough visit.
  const entry = f.shift(), segment = activeJobSegment(entry);
  assert.deepEqual({ id: segment.id, kind: segment.kind, jobId: segment.jobId, jobLabel: segment.jobLabel, visitKind: segment.visitKind, startedAt: segment.startedAt }, { id: input.requestId, kind: 'work', jobId: 'w1', jobLabel: 'Walkthrough: Synthetic Customer', visitKind: 'walkthrough', startedAt: NOW });
  assert.equal(entry.jobTracking.segments[0].endedAt, NOW);
  assert.equal(employeeJobTime(entry, FINISH).jobs[0].workMs, 3600000);
  assert.equal(entry.history.at(-1).action, 'job_time_switch');
  const lock = f.locks()[0];
  assert.deepEqual({ rep: lock.rep, openVisitId: lock.openVisitId, openedAt: lock.openedAt, requestId: lock.requestId }, { rep: 'sales.rep', openVisitId: 'w1', openedAt: NOW, requestId: input.requestId });
  const receipt = f.rows.get(`${WALKTHROUGH_VISIT_OPERATIONS}/${input.requestId}`);
  assert.equal(receipt.actorId, 'sales.rep'); assert.equal(receipt.action, 'start'); assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/);
  // Dispatch state and money are untouched; the response is an allowlist.
  const visit = f.visit('w1');
  assert.equal(visit.status, 'scheduled'); assert.equal(visit.completedAt, undefined); assert.equal(visit.walkthroughCompletedAt, undefined); assert.equal(visit.estimate.amount, 1437);
  const text = JSON.stringify(result);
  for (const secret of ['1437', 'SYNTHETIC-SIGNATURE', 'Synthetic private note', 'contact1', 'hourlyRate']) assert.equal(text.includes(secret), false, secret);
});

test('Start without an active shift prompts clock-in; skipTimecard records the visit explicitly without a segment', async () => {
  const f = fixture();
  await assert.rejects(f.run(sales, f.body('start')), error => error.code === 'walkthrough_visit_clock_in_required' && error.status === 409 && error.details.clockInRequired === true);
  assert.equal(f.commits.length, 0);
  const result = await f.run(sales, f.body('start', { skipTimecard: true }));
  assert.deepEqual(result.visit.walkthroughVisit.repTime, { status: 'skipped', segmentId: null });
  assert.equal(f.commits[0].some(key => key.startsWith('jobs/secure_')), false);
  assert.equal(f.events('walkthrough.started').length, 1);
});

test('the rep\'s next Start is blocked until the open walkthrough has an outcome; a manager can record it for them', async () => {
  const f = fixture(); f.clockIn();
  const first = await f.run(sales, f.body('start'));
  await assert.rejects(f.run(sales, f.body('start', { visitId: 'w2' })), error => error.code === 'walkthrough_visit_outcome_required' && error.details.visitId === 'w1' && error.details.startedAt === NOW && error.details.customer === 'Synthetic Customer');
  assert.equal(f.commits.length, 1);
  const before = JSON.stringify(f.shift());
  const closed = await f.run(manager, f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }), FINISH);
  assert.equal(closed.visit.walkthroughOutcome.performedBy, 'tylerg');
  assert.deepEqual(closed.visit.walkthroughOutcome.repTime, { status: 'other_performer', segmentId: first.requestId });
  assert.equal(JSON.stringify(f.shift()), before, 'a manager never edits the rep\'s timecard');
  assert.equal(f.locks()[0].openVisitId, '');
  const next = await f.run(sales, f.body('start', { visitId: 'w2' }), '2026-09-22T17:00:00.000Z');
  assert.equal(next.visit.id, 'w2');
  const segments = f.shift().jobTracking.segments;
  assert.deepEqual(segments.map(segment => [segment.jobId, segment.endedAt]), [['', NOW], ['w1', '2026-09-22T17:00:00.000Z'], ['w2', '']]);
});

test('a lock left by an outcome written elsewhere (a signed handoff) does not block the next Start', async () => {
  const f = fixture(); f.clockIn();
  await f.run(sales, f.body('start'));
  f.put('jobs/w1', { ...f.visit('w1'), walkthroughOutcome: { outcome: 'sold_on_site', finishedAt: FINISH, performedBy: 'zacb' } });
  const next = await f.run(sales, f.body('start', { visitId: 'w2' }), FINISH);
  assert.equal(next.visit.walkthroughVisit.startedAt, FINISH);
  assert.equal(f.locks()[0].openVisitId, 'w2');
});

test('Finish closes the segment and writes the outcome, completion time and walkthrough.completed', async () => {
  const f = fixture(); f.clockIn();
  const start = await f.run(sales, f.body('start'));
  const input = f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'declined' }), result = await f.run(sales, input, FINISH);
  const visit = f.visit('w1');
  assert.deepEqual(visit.walkthroughOutcome, { outcome: 'quote_to_follow', reasonCode: null, finishedAt: FINISH, performedBy: 'sales.rep', recordingStatus: 'declined', requestId: input.requestId, clockSource: 'server', deviceAt: null, occurrence: { ...FIRST, scheduleOccurrence: null }, repTime: { status: 'segment_closed', segmentId: start.requestId } });
  assert.equal(visit.walkthroughCompletedAt, FINISH); assert.equal(visit.walkthroughVisit.startedAt, NOW); assert.equal(visit.status, 'scheduled');
  assert.deepEqual(result.visit.walkthroughOutcome.repTime, { status: 'segment_closed', segmentId: start.requestId });
  const [event] = f.events('walkthrough.completed');
  assert.deepEqual(event.data, { outcome: 'quote_to_follow', recordingStatus: 'declined' }); assert.equal(event.occurredAt, FINISH);
  assert.equal(f.events('deal.lost').length, 0);
  const entry = f.shift(), segment = activeJobSegment(entry);
  assert.deepEqual([segment.id, segment.kind, segment.jobId, segment.startedAt], [input.requestId, 'general', '', FINISH]);
  assert.equal(entry.jobTracking.segments.find(row => row.id === start.requestId).endedAt, FINISH);
  const summary = employeeJobTime(entry, '2026-09-22T17:00:00.000Z');
  assert.deepEqual(summary.jobs.map(row => [row.jobId, row.workMs]), [['w1', 3600000]]); assert.equal(summary.generalMs, 2 * 3600000);
  assert.equal(f.locks()[0].openVisitId, '');
  assert.equal(f.commits.length, 2); assert.equal(f.commits[1].some(key => key.startsWith('jobs/secure_')), true);
  // Job costing keeps the walkthrough hour out of job cost and reports it as acquisition labor (§6.1).
  const worked = f.shift();
  f.setShift(authorizeTimecard({ session: sales, manager: false, id: worked.id, existing: worked, incoming: { jobAction: { requestId: randomUUID(), kind: 'work', jobId: 'job-a', expectedSegmentId: activeJobSegment(worked).id } }, now: '2026-09-22T16:30:00.000Z' }));
  f.setShift(authorizeTimecard({ session: sales, manager: false, id: worked.id, existing: f.shift(), incoming: { clockOutAt: 'now', status: 'submitted' }, now: '2026-09-22T17:00:00.000Z' }));
  const cost = computeJobLaborCost({ timecards: [f.shift()], start: '2026-09-21', end: '2026-09-28', now: '2026-10-05T18:00:00.000Z' });
  assert.deepEqual(cost.jobs.map(row => [row.jobId, row.projected.workHours]), [['job-a', 0.5]]); assert.equal(cost.totals.projected.workHours, 0.5);
  assert.deepEqual(cost.walkthroughLabor.visits.map(row => [row.jobId, row.jobLabel, row.projected.workHours, row.projected.straightCost]), [['w1', 'Walkthrough: Synthetic Customer', 1, 22]]);
});

test('not_interested needs a lost reason and also writes deal.lost on the project in the same commit', async () => {
  const f = fixture(); f.clockIn();
  await f.run(sales, f.body('start'));
  for (const reasonCode of [undefined, 'nope', 'customer_not_home']) await rejects(f.run(sales, f.body('finish', { outcome: 'not_interested', recordingStatus: 'recorded', ...(reasonCode ? { reasonCode } : {}) }), FINISH), 'invalid', 400);
  await f.run(sales, f.body('finish', { outcome: 'not_interested', reasonCode: 'price', recordingStatus: 'recorded' }), FINISH);
  const [completed] = f.events('walkthrough.completed'), [lost] = f.events('deal.lost');
  assert.deepEqual(completed.data, { outcome: 'not_interested', reasonCode: 'price', recordingStatus: 'recorded' });
  assert.deepEqual(lost.data, { outcome: 'not_interested', reasonCode: 'price' }); assert.equal(lost.entityKey, 'projectId:project_w1'); assert.equal(lost.walkthroughId, 'w1'); assert.equal(lost.occurredAt, FINISH);
  assert.equal(f.visit('w1').walkthroughOutcome.reasonCode, 'price');
  const last = f.commits.at(-1);
  assert.ok(last.includes('jobs/w1') && last.filter(key => key.startsWith('funnelEvents/')).length === 2);
});

test('outcome, reason and recording-status rules are enforced before anything is read or written', async () => {
  const f = fixture(); f.clockIn();
  await f.run(sales, f.body('start'));
  const finish = extra => f.run(sales, f.body('finish', extra), FINISH);
  await rejects(finish({ outcome: 'quote_to_follow' }), 'invalid', 400);
  await rejects(finish({ outcome: 'sold_on_site', recordingStatus: 'recorded', reasonCode: 'price' }), 'invalid', 400);
  await rejects(finish({ outcome: 'rescheduled', recordingStatus: 'recorded' }), 'invalid', 400);
  await rejects(finish({ outcome: 'won', recordingStatus: 'recorded' }), 'invalid', 400);
  await rejects(finish({ outcome: 'quote_to_follow', recordingStatus: 'maybe' }), 'invalid', 400);
  await rejects(f.run(sales, f.body('start', { visitId: 'w2', outcome: 'quote_to_follow' })), 'invalid', 400);
  await rejects(f.run(sales, f.body('no_show', { outcome: 'quote_to_follow', reasonCode: 'customer_not_home' })), 'invalid', 400);
  await rejects(f.run(sales, { ...f.body('start', { visitId: 'w2' }), hourlyRate: 99 }), 'invalid', 400);
  await rejects(f.run(sales, f.body('start', { visitId: 'secure_x' })), 'invalid', 400);
  await rejects(f.run(sales, f.body('start', { visitId: 'w2', requestId: 'not-a-uuid' })), 'invalid', 400);
  await rejects(f.run(sales, f.body('start', { visitId: 'w2', deviceAt: 'yesterday' })), 'invalid', 400);
  await rejects(f.run(sales, { ...f.body('start', { visitId: 'w2' }), expectedRevision: '' }), 'invalid', 400);
  assert.equal(f.commits.length, 1);
  // Rescheduled keeps its reason on the outcome; the completed event carries only lost reasons.
  await f.run(sales, f.body('finish', { outcome: 'rescheduled', reasonCode: 'customer_request', recordingStatus: 'failed_device' }), FINISH);
  assert.equal(f.visit('w1').walkthroughOutcome.reasonCode, 'customer_request');
  assert.deepEqual(f.events('walkthrough.completed')[0].data, { outcome: 'rescheduled', recordingStatus: 'failed_device' });
  // A rescheduled visit did not take place: it has no completion time, like a no-show.
  assert.equal(f.visit('w1').walkthroughCompletedAt, undefined);
});

test('No-show without a Start records customer_no_show and walkthrough.no_show, never a completion or a timecard change', async () => {
  const f = fixture(); f.clockIn();
  const before = JSON.stringify(f.shift());
  await rejects(f.run(sales, f.body('no_show')), 'invalid', 400);
  const input = f.body('no_show', { reasonCode: 'customer_not_home' }), result = await f.run(sales, input, NOW);
  assert.deepEqual(f.visit('w1').walkthroughOutcome, { outcome: 'customer_no_show', reasonCode: 'customer_not_home', finishedAt: NOW, performedBy: 'sales.rep', recordingStatus: null, requestId: input.requestId, clockSource: 'server', deviceAt: null, occurrence: { ...FIRST, scheduleOccurrence: null }, repTime: { status: 'not_started', segmentId: null } });
  assert.equal(f.visit('w1').walkthroughCompletedAt, undefined); assert.equal(result.visit.walkthroughCompletedAt, null); assert.equal(result.visit.walkthroughVisit, null);
  assert.deepEqual(f.events('walkthrough.no_show')[0].data, { reasonCode: 'customer_not_home', occurrence: 1 });
  assert.equal(f.events('walkthrough.completed').length, 0);
  assert.equal(JSON.stringify(f.shift()), before);
  assert.deepEqual(f.commits[0].map(key => key.split('/')[0]).sort(), ['funnelEvents', 'jobs', WALKTHROUGH_VISIT_OPERATIONS]);
  await assert.rejects(f.run(sales, f.body('start')), error => error.code === 'walkthrough_visit_closed' && /Move it to its new date in Dispatch/.test(error.message));
  // After a Start, a customer_no_show Finish closes the segment and is also a no-show event.
  const start = await f.run(sales, f.body('start', { visitId: 'w2' }));
  await f.run(sales, f.body('finish', { visitId: 'w2', outcome: 'customer_no_show', reasonCode: 'no_access' }), FINISH);
  assert.equal(f.visit('w2').walkthroughOutcome.repTime.status, 'segment_closed');
  assert.equal(f.visit('w2').walkthroughCompletedAt, undefined);
  assert.equal(f.events('walkthrough.no_show').length, 2);
  assert.equal(f.shift().jobTracking.segments.find(row => row.id === start.requestId).endedAt, FINISH);
});

test('replays return the saved result; a reused request ID with other content or another user is refused; a lost reply is recovered', async () => {
  const f = fixture(); f.clockIn();
  const input = f.body('start'), first = await f.run(sales, input);
  const again = await f.run(sales, { ...input, requestId: input.requestId.toUpperCase() }, FINISH);
  assert.equal(again.replayed, true); assert.deepEqual(again.visit.walkthroughVisit, first.visit.walkthroughVisit); assert.equal(f.commits.length, 1);
  await rejects(f.run(sales, { ...input, recordingStatus: 'declined' }), 'idempotency_conflict', 409);
  await rejects(f.run(manager, input), 'idempotency_conflict', 409);
  // Concurrent identical taps: one commit, every caller gets the saved result.
  const g = fixture(); g.clockIn();
  const tap = g.body('start'), results = await Promise.all([1, 2, 3].map(() => g.run(sales, tap)));
  assert.equal(g.commits.length, 1); assert.equal(new Set(results.map(item => item.visit.walkthroughVisit.startedAt)).size, 1);
  assert.equal(g.events().length, 1);
  // The commit applied but its reply was lost: the receipt proves it, nothing is written twice.
  const h = fixture(); h.clockIn();
  h.hooks.after = () => { throw Object.assign(new Error('lost'), { code: 'walkthrough_visit_outcome_unknown', status: 503 }); };
  const lost = h.body('start'), recovered = await h.run(sales, lost);
  assert.equal(recovered.replayed, true); assert.equal(recovered.visit.walkthroughVisit.startedAt, NOW);
  assert.equal((await h.run(sales, lost)).replayed, true); assert.equal(h.commits.length, 1);
  // A replay after the visit was later changed by something else is not reported as success.
  const later = h.visit('w1'); h.put('jobs/w1', { ...later, walkthroughVisit: { ...later.walkthroughVisit, startRequestId: randomUUID() } });
  await rejects(h.run(sales, lost), 'changed_since_operation', 409);
});

test('revision preconditions: a stale expectedRevision or a concurrent visit, lock or timecard change saves nothing', async () => {
  const f = fixture(); f.clockIn();
  await rejects(f.run(sales, { ...f.body('start'), expectedRevision: 'r0' }), 'revision_conflict', 409);
  const races = [
    () => f.put('jobs/w1', { ...f.visit('w1'), notes: 'changed by dispatch' }),
    () => f.setShift({ ...f.shift(), notes: 'changed on another device' }),
    writes => { const lock = writes.find(write => write.collection === WALKTHROUGH_VISIT_LOCKS); f.put(`${lock.collection}/${lock.id}`, { rep: 'sales.rep', openVisitId: 'w2' }); },
  ];
  for (const race of races) {
    f.hooks.before = race;
    await rejects(f.run(sales, f.body('start')), 'revision_conflict', 409);
    assert.equal(f.visit('w1').walkthroughVisit, undefined);
    assert.equal(activeJobSegment(f.shift()).kind, 'general');
    assert.equal([...f.rows.keys()].some(key => key.startsWith('funnelEvents/') || key.startsWith(`${WALKTHROUGH_VISIT_OPERATIONS}/`)), false);
    for (const key of [...f.rows.keys()].filter(key => key.startsWith(`${WALKTHROUGH_VISIT_LOCKS}/`))) f.rows.delete(key);
  }
  assert.equal(f.commits.length, 0);
  assert.equal((await f.run(sales, f.body('start'))).visit.walkthroughVisit.startedAt, NOW);
});

test('only sales reps, managers and the owner record walkthroughs, and a rep only their own', async () => {
  const f = fixture(); f.clockIn(); f.clockIn(otherRep);
  await rejects(recordWalkthroughVisit(f.store, null, f.body('start')), 'sign_in_required', 401);
  for (const session of [{ user: 'Crew.One', role: 'crew' }, { user: 'AlexK', role: 'crew_lead', businessAccess: true }, { user: 'Phone.Rep', role: 'phone' }, { user: 'Imposter', role: 'manager', businessAccess: true }]) await rejects(f.run(session, f.body('start')), 'forbidden', 403);
  await rejects(f.run(sales, f.body('start', { visitId: 'w3' })), 'not_assigned', 403);
  await rejects(f.run(sales, f.body('start', { actorId: 'Sales.Two' })), 'actor_changed', 403);
  await f.run(otherRep, f.body('start', { visitId: 'w3' }));
  await rejects(f.run(sales, f.body('finish', { visitId: 'w3', outcome: 'quote_to_follow', recordingStatus: 'recorded' })), 'not_assigned', 403);
  await rejects(f.run(sales, f.body('start', { visitId: 'job-a' })), 'not_found', 404);
  const own = await f.run(sales, f.body('start', { actorId: 'sales.rep' }));
  assert.equal(own.visit.walkthroughVisit.startedBy, 'sales.rep');
  // An unassigned visit is fine for the owner, who performs it themselves.
  const g = fixture({ rows: { 'jobs/w4': walkthrough({ assignedCrew: [] }), 'jobs/w5': walkthrough({ assignedCrew: ['staff.account'] }) } });
  assert.equal((await g.run(owner, g.body('start', { visitId: 'w4', skipTimecard: true }))).visit.walkthroughVisit.startedBy, 'zacb');
  // A stored sales staff role counts only with EGC_STAFF_ROLE_PERMISSIONS on.
  const staff = { user: 'Staff.Account', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['sales'] };
  await rejects(g.run(staff, g.body('start', { visitId: 'w5', skipTimecard: true })), 'forbidden', 403);
  g.store.env = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  assert.equal((await g.run(staff, g.body('start', { visitId: 'w5', skipTimecard: true }))).visit.walkthroughVisit.startedBy, 'staff.account');
  await rejects(g.run({ ...manager, staffRoles: ['crew'] }, g.body('no_show', { visitId: 'w5', reasonCode: 'unreachable' })), 'forbidden', 403);
});

test('with stored staff roles on, the P1-08 quotes.author capability decides who records walkthroughs', () => {
  const on = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  const account = staffRoles => ({ user: 'Staff.Account', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles });
  assert.equal(walkthroughPerformer(account(['sales']), on), true);
  assert.equal(walkthroughPerformer(account(['manager']), on), true);
  assert.equal(walkthroughPerformer(account(['phone', 'crew']), on), false);
  assert.equal(walkthroughPerformer(account(['sales']), {}), false, 'stored roles are inert with the flag off');
  assert.equal(walkthroughPerformer({ ...manager, staffRoles: ['crew'] }, on), false, 'stored roles are authoritative with the flag on');
  assert.equal(walkthroughPerformer(manager, on), true); assert.equal(walkthroughPerformer(sales, {}), true); assert.equal(walkthroughPerformer(owner, {}), true);
  for (const session of [null, 'zacb', {}, { user: ' ' }]) assert.equal(walkthroughPerformer(session, on), false);
});

test('device times follow the funnel clock rule, and the timecard keeps its own offline-clock policy', async () => {
  const late = '2026-09-22T14:50:00.000Z';
  // Offline clock off: the visit and event use the validated device time; the timecard refuses a stale device time.
  const f = fixture(); f.clockIn();
  await assert.rejects(f.run(sales, f.body('start', { deviceAt: late })), error => error.code === 'walkthrough_visit_time_invalid' && error.details.timecard === true && /Offline clock times are not enabled/.test(error.message));
  assert.equal(f.commits.length, 0);
  const skipped = await f.run(sales, f.body('start', { deviceAt: late, skipTimecard: true }));
  assert.equal(skipped.visit.walkthroughVisit.startedAt, late); assert.equal(skipped.visit.walkthroughVisit.clockSource, 'device_validated');
  assert.equal(f.events('walkthrough.started')[0].deviceAt, late);
  // Offline clock on: the segment starts at the device time and the timecard is flagged for review.
  const g = fixture({ offlineClock: true }); g.clockIn();
  await g.run(sales, g.body('start', { deviceAt: late }));
  const segment = activeJobSegment(g.shift());
  assert.equal(segment.startedAt, late); assert.equal(g.shift().needsReview, true); assert.equal(g.shift().deviceTime, true);
  assert.equal(g.visit('w1').walkthroughVisit.startedAt, late);
  // A phone clock in the future is attested and dated at the server time, never moved forward.
  const h = fixture(); h.clockIn();
  const ahead = await h.run(sales, h.body('start', { deviceAt: '2026-09-22T15:20:00.000Z' }));
  assert.equal(ahead.visit.walkthroughVisit.startedAt, NOW); assert.equal(ahead.visit.walkthroughVisit.clockSource, 'attested');
  assert.deepEqual(h.events('walkthrough.started')[0].clockReasons, ['device_time_in_future']);
  // A Finish is never dated before its Start: a device time before startedAt is attested at startedAt (for
  // every event of the tap), the raw time stays on the outcome, and the timecard closes at the server time.
  await h.run(sales, h.body('finish', { outcome: 'not_interested', reasonCode: 'price', recordingStatus: 'recorded', deviceAt: '2026-09-22T12:00:00.000Z' }), FINISH);
  const outcome = h.visit('w1').walkthroughOutcome;
  assert.deepEqual([outcome.finishedAt, outcome.clockSource, outcome.deviceAt, outcome.repTime.status], [NOW, 'attested', '2026-09-22T12:00:00.000Z', 'segment_closed_server_time']);
  assert.equal(h.visit('w1').walkthroughCompletedAt, NOW);
  for (const type of ['walkthrough.completed', 'deal.lost']) { const [row] = h.events(type); assert.deepEqual([row.occurredAt, row.clockSource], [NOW, 'attested'], type); }
  assert.equal(h.shift().jobTracking.segments.find(row => row.jobId === 'w1').endedAt, FINISH);
  // Even inside the C17 start - 1 h slack: a manager's Finish 40 minutes before the Start is dated at the Start.
  const k = fixture();
  await k.run(sales, k.body('start', { skipTimecard: true }));
  await k.run(manager, k.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded', deviceAt: '2026-09-22T14:20:00.000Z' }), FINISH);
  assert.deepEqual([k.visit('w1').walkthroughOutcome.finishedAt, k.visit('w1').walkthroughCompletedAt, k.visit('w1').walkthroughOutcome.clockSource], [NOW, NOW, 'attested']);
  assert.deepEqual(k.events('walkthrough.completed')[0].clockReasons, []);
  // A device time at or after the Start is kept as validated.
  const m = fixture();
  await m.run(sales, m.body('start', { skipTimecard: true }));
  await m.run(sales, m.body('no_show', { reasonCode: 'no_access', deviceAt: '2026-09-22T15:10:00.000Z' }), FINISH);
  assert.deepEqual([m.visit('w1').walkthroughOutcome.finishedAt, m.visit('w1').walkthroughOutcome.clockSource], ['2026-09-22T15:10:00.000Z', 'device_validated']);
});

test('Finish after the rep switched jobs or clocked out leaves the timecard alone, and skipTimecard never leaves a writable segment open', async () => {
  const f = fixture(); f.clockIn();
  await f.run(sales, f.body('start'));
  const entry = f.shift();
  f.setShift(authorizeTimecard({ session: sales, manager: false, id: entry.id, existing: entry, incoming: { jobAction: { requestId: randomUUID(), kind: 'work', jobId: 'job-a', expectedSegmentId: activeJobSegment(entry).id } }, now: '2026-09-22T15:30:00.000Z' }));
  const switched = JSON.stringify(f.shift());
  await f.run(sales, f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }), FINISH);
  assert.equal(f.visit('w1').walkthroughOutcome.repTime.status, 'already_ended');
  assert.equal(JSON.stringify(f.shift()), switched); assert.equal(f.commits.at(-1).some(key => key.startsWith('jobs/secure_')), false);

  const g = fixture(); g.clockIn();
  await g.run(sales, g.body('start'));
  g.setShift(authorizeTimecard({ session: sales, manager: false, id: g.shift().id, existing: g.shift(), incoming: { clockOutAt: 'now', status: 'submitted' }, now: '2026-09-22T15:45:00.000Z' }));
  await g.run(sales, g.body('finish', { outcome: 'sold_on_site', recordingStatus: 'recorded' }), FINISH);
  assert.equal(g.visit('w1').walkthroughOutcome.repTime.status, 'already_ended');
  assert.equal(g.shift().jobTracking.segments.at(-1).endReason, 'clock_out');

  // skipTimecard is honoured only when the timecard cannot be written; here the segment closes as usual.
  const h = fixture(); h.clockIn();
  await h.run(sales, h.body('start'));
  await h.run(sales, h.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded', skipTimecard: true }), FINISH);
  assert.equal(h.visit('w1').walkthroughOutcome.repTime.status, 'segment_closed'); assert.equal(activeJobSegment(h.shift()).kind, 'general');
  assert.deepEqual(employeeJobTime(h.shift(), '2026-09-22T20:00:00.000Z').jobs.map(row => [row.jobId, row.workMs]), [['w1', 3600000]]);
});

test('a Finish replayed late with a stale device time closes the segment at the server time, not at the rep\'s next Start', async () => {
  const f = fixture(); f.clockIn();
  const start = await f.run(sales, f.body('start'));
  const late = '2026-09-22T15:40:00.000Z';
  const result = await f.run(sales, f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded', deviceAt: '2026-09-22T15:30:00.000Z', skipTimecard: true }), late);
  assert.deepEqual(result.visit.walkthroughOutcome.repTime, { status: 'segment_closed_server_time', segmentId: start.requestId });
  assert.deepEqual([result.visit.walkthroughOutcome.finishedAt, result.visit.walkthroughOutcome.clockSource], ['2026-09-22T15:30:00.000Z', 'device_validated'], 'the outcome keeps its C17 time');
  const entry = f.shift();
  assert.equal(entry.jobTracking.segments.find(row => row.id === start.requestId).endedAt, late); assert.equal(activeJobSegment(entry).kind, 'general');
  assert.notEqual(entry.deviceTime, true, 'with offline clock times off the timecard records server time only');
  // By the evening the walkthrough holds 40 minutes of work, not the whole afternoon, and the next Start is its own.
  assert.deepEqual(employeeJobTime(entry, '2026-09-22T20:00:00.000Z').jobs.map(row => [row.jobId, row.workMs]), [['w1', 40 * 60000]]);
  await f.run(sales, f.body('start', { visitId: 'w2' }), '2026-09-22T18:00:00.000Z');
  assert.deepEqual(employeeJobTime(f.shift(), '2026-09-22T20:00:00.000Z').jobs.map(row => [row.jobId, row.workMs]), [['w1', 40 * 60000], ['w2', 2 * 3600000]]);
  // With offline clock times on, the same replay closes the segment at the device time and flags the timecard.
  const g = fixture({ offlineClock: true }); g.clockIn();
  await g.run(sales, g.body('start'));
  const offline = await g.run(sales, g.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded', deviceAt: '2026-09-22T15:30:00.000Z' }), late);
  assert.equal(offline.visit.walkthroughOutcome.repTime.status, 'segment_closed');
  assert.equal(g.shift().jobTracking.segments.find(row => row.jobId === 'w1').endedAt, '2026-09-22T15:30:00.000Z'); assert.equal(g.shift().needsReview, true);
});

test('the starter\'s Finish leaves the segment open only when the timecard cannot be written, and records left_open', async () => {
  const f = fixture(); f.clockIn();
  const start = await f.run(sales, f.body('start'));
  const finish = extra => f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded', ...extra });
  f.store.activeShift = async () => { throw Object.assign(new Error('unreadable'), { code: 'walkthrough_visit_time_unavailable', status: 503, details: { timecard: true } }); };
  await rejects(f.run(sales, finish(), FINISH), 'time_unavailable', 503);
  assert.equal(f.commits.length, 1);
  const open = await f.run(sales, finish({ skipTimecard: true }), FINISH);
  assert.deepEqual(open.visit.walkthroughOutcome.repTime, { status: 'left_open', segmentId: start.requestId });
  assert.equal(activeJobSegment(f.shift()).jobId, 'w1', 'nothing could be written, so a manager closes the segment');
  assert.equal(f.locks()[0].openVisitId, '');
  // A timecard that needs manager review cannot be changed either; No-show follows the same rule.
  const g = fixture(); g.clockIn();
  await g.run(sales, g.body('start'));
  const entry = g.shift(); g.setShift({ ...entry, jobTracking: { ...entry.jobTracking, version: 2 } });
  await assert.rejects(g.run(sales, g.body('no_show', { reasonCode: 'customer_not_home' }), FINISH), error => error.code === 'walkthrough_visit_time_invalid' && error.status === 409 && error.details.timecard === true && /manager review/.test(error.message));
  assert.equal((await g.run(sales, g.body('no_show', { reasonCode: 'customer_not_home', skipTimecard: true }), FINISH)).visit.walkthroughOutcome.repTime.status, 'left_open');
});

test('visit state guards: only walkthroughs, one Start, Finish after Start, one outcome, no Start on closed visits', async () => {
  const f = fixture({ rows: { 'jobs/cancelled': walkthrough({ status: 'cancelled', pipelineStatus: 'cancelled' }), 'jobs/done': walkthrough({ status: 'completed', walkthroughCompletedAt: '2026-09-21T15:00:00.000Z' }), 'jobs/private': { ...walkthrough(), recordType: 'employee_hub_v2' } } });
  f.clockIn();
  await rejects(f.run(sales, f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' })), 'not_started', 409);
  for (const visitId of ['cancelled', 'done']) {
    await rejects(f.run(sales, f.body('start', { visitId })), 'closed', 409);
    await rejects(f.run(sales, f.body('no_show', { visitId, reasonCode: 'customer_not_home' })), 'closed', 409);
  }
  await rejects(f.run(sales, f.body('start', { visitId: 'private' })), 'not_found', 404);
  await rejects(f.run(sales, f.body('start', { visitId: 'missing' })), 'not_found', 404);
  await f.run(sales, f.body('start'));
  await rejects(f.run(sales, f.body('start')), 'already_started', 409);
  // A visit cancelled in Dispatch after its Start still needs (and accepts) an outcome.
  f.put('jobs/w1', { ...f.visit('w1'), status: 'cancelled', pipelineStatus: 'cancelled' });
  await f.run(sales, f.body('finish', { outcome: 'rescheduled', reasonCode: 'customer_request', recordingStatus: 'declined' }), FINISH);
  await rejects(f.run(sales, f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }), FINISH), 'closed', 409);
  await rejects(f.run(sales, f.body('no_show', { reasonCode: 'customer_not_home' }), FINISH), 'closed', 409);
});

test('a no-show or rescheduled outcome closes only its occurrence: once Dispatch moves the visit, Start records the rebooked one', async () => {
  const f = fixture({ rows: { 'jobs/w1': walkthrough({ walkthroughVisit: { internalJobNotes: { text: 'Synthetic kept notes' } } }) } });
  f.clockIn();
  const firstStart = f.body('start'), first = await f.run(sales, firstStart);
  const noShow = await f.run(sales, f.body('finish', { outcome: 'customer_no_show', reasonCode: 'customer_not_home' }), FINISH);
  assert.deepEqual(f.events('walkthrough.no_show')[0].data, { reasonCode: 'customer_not_home', occurrence: 1 });
  assert.equal(noShow.visit.walkthroughCompletedAt, null); assert.equal(noShow.visit.rebookPending, false);
  // Until Dispatch moves it, the visit stays closed and says how to rebook it.
  await assert.rejects(f.run(sales, f.body('start'), FINISH), error => error.code === 'walkthrough_visit_closed' && /Move it to its new date in Dispatch/.test(error.message));
  // Dispatch rebooks it for next week; FUN-05 left the job status at scheduled.
  f.put('jobs/w1', { ...f.visit('w1'), date: '2026-09-29', time: '13:00', endTime: '14:00' });
  const pending = await walkthroughVisitState(f.store, sales, { visitId: 'w1' }, FINISH);
  assert.deepEqual([pending.visit.rebookPending, pending.visit.walkthroughOutcome.outcome, pending.visit.walkthroughVisit.startedAt], [true, 'customer_no_show', NOW]);
  await rejects(f.run(sales, f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }), FINISH), 'not_started', 409);
  f.clockIn(sales, '2026-09-29T18:30:00.000Z');
  const second = await f.run(sales, f.body('start'), '2026-09-29T19:00:00.000Z');
  assert.deepEqual(second.visit.walkthroughVisit.occurrence, { number: 2, date: '2026-09-29', time: '13:00', startAt: '2026-09-29T19:00:00.000Z' });
  assert.deepEqual([second.visit.walkthroughVisit.startedAt, second.visit.walkthroughOutcome, second.visit.rebookPending, second.visit.previousOccurrences], ['2026-09-29T19:00:00.000Z', null, false, 1]);
  const visit = f.visit('w1'), [earlier] = visit.walkthroughOccurrences;
  assert.deepEqual(visit.walkthroughVisit.internalJobNotes, { text: 'Synthetic kept notes' }, 'notes on the visit record survive the rebook');
  assert.deepEqual([earlier.occurrence.number, earlier.occurrence.date, earlier.walkthroughVisit.startedAt, earlier.walkthroughVisit.startRequestId, earlier.walkthroughOutcome.outcome, earlier.walkthroughOutcome.requestId, earlier.archivedRequestId, earlier.archivedBy],
    [1, '2026-09-22', NOW, first.requestId, 'customer_no_show', noShow.requestId, second.requestId, 'sales.rep']);
  assert.equal(earlier.walkthroughVisit.internalJobNotes, undefined);
  assert.equal(f.locks()[0].openVisitId, 'w1'); assert.equal(activeJobSegment(f.shift()).jobId, 'w1');
  // The rebooked occurrence records its own outcome and labor; the final occurrence is the completed one.
  const done = await f.run(sales, f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }), '2026-09-29T20:00:00.000Z');
  assert.deepEqual([done.visit.walkthroughCompletedAt, done.visit.walkthroughOutcome.occurrence.number, done.visit.walkthroughOutcome.repTime.status], ['2026-09-29T20:00:00.000Z', 2, 'segment_closed']);
  assert.deepEqual(['walkthrough.started', 'walkthrough.no_show', 'walkthrough.completed'].map(type => f.events(type).length), [2, 1, 1]);
  assert.deepEqual(employeeJobTime(f.shift(), '2026-09-29T21:00:00.000Z').jobs.map(row => [row.jobId, row.workMs]), [['w1', 3600000]]);
  // A completed occurrence is final, even after another move; an old request replays as changed, never as current.
  f.put('jobs/w1', { ...f.visit('w1'), date: '2026-10-06' });
  await rejects(f.run(sales, f.body('start'), '2026-10-06T19:00:00.000Z'), 'closed', 409);
  await rejects(f.run(sales, firstStart), 'changed_since_operation', 409);
});

test('rebooked occurrences: a No-show needs no Start, numbers follow the FUN-02 counter, and the history is bounded', async () => {
  const f = fixture({ rows: { 'jobs/w4': walkthrough({ scheduleOccurrence: 3 }) } });
  const noShow = now => f.run(sales, f.body('no_show', { visitId: 'w4', reasonCode: 'unreachable' }), now);
  await noShow(NOW);
  assert.deepEqual(f.events('walkthrough.no_show')[0].data, { reasonCode: 'unreachable', occurrence: 3 });
  await rejects(noShow(FINISH), 'closed', 409);
  // Moved away and back to the same time: FUN-02 counted new placements, so this is a new occurrence.
  f.put('jobs/w4', { ...f.visit('w4'), scheduleOccurrence: 5 });
  await noShow(FINISH);
  const visit = f.visit('w4');
  assert.deepEqual(f.events('walkthrough.no_show').map(row => row.data.occurrence).sort(), [3, 5]);
  assert.deepEqual([visit.walkthroughOccurrences.length, visit.walkthroughOccurrences[0].walkthroughVisit, visit.walkthroughOccurrences[0].occurrence.number, visit.walkthroughOutcome.occurrence.number, visit.walkthroughVisit], [1, null, 3, 5, undefined]);
  // After a started occurrence, a rebooked No-show clears the old start from the visit record.
  f.put('jobs/w7', walkthrough({ walkthroughVisit: { startedAt: NOW, startedBy: 'sales.rep', startRequestId: randomUUID(), repTime: { status: 'skipped', segmentId: null }, occurrence: { ...FIRST, scheduleOccurrence: null }, internalJobNotes: { text: 'Synthetic kept notes' } },
    walkthroughOutcome: { outcome: 'customer_no_show', reasonCode: 'no_access', finishedAt: NOW, requestId: randomUUID(), occurrence: { ...FIRST, scheduleOccurrence: null } }, date: '2026-09-24' }));
  const again = await f.run(sales, f.body('no_show', { visitId: 'w7', reasonCode: 'unreachable' }), FINISH);
  assert.deepEqual([again.visit.walkthroughVisit, f.visit('w7').walkthroughVisit, again.visit.walkthroughOutcome.occurrence.number, f.visit('w7').walkthroughOccurrences[0].walkthroughVisit.startedAt], [null, { internalJobNotes: { text: 'Synthetic kept notes' } }, 2, NOW]);
  // Taken off the calendar, a visit has no new occurrence to record.
  f.put('jobs/w4', { ...f.visit('w4'), date: '', time: '', scheduleOccurrence: 6 });
  await rejects(noShow(FINISH), 'closed', 409);
  // A rescheduled outcome is rebookable too, and a visit keeps at most 20 earlier occurrences.
  const history = Array.from({ length: 20 }, (_, index) => ({ occurrence: { number: index + 1 }, walkthroughVisit: null, walkthroughOutcome: { outcome: 'customer_no_show' }, archivedAt: NOW }));
  f.put('jobs/w5', walkthrough({ walkthroughOccurrences: history, walkthroughOutcome: { outcome: 'rescheduled', reasonCode: 'weather', finishedAt: NOW, performedBy: 'sales.rep', requestId: randomUUID(), occurrence: { ...FIRST, number: 21, scheduleOccurrence: null } } }));
  await rejects(f.run(sales, f.body('start', { visitId: 'w5', skipTimecard: true }), FINISH), 'closed', 409);
  f.put('jobs/w5', { ...f.visit('w5'), date: '2026-09-23' });
  const rebooked = await f.run(sales, f.body('start', { visitId: 'w5', skipTimecard: true }), FINISH);
  assert.equal(rebooked.visit.walkthroughVisit.occurrence.number, 22);
  const kept = f.visit('w5').walkthroughOccurrences;
  assert.deepEqual([kept.length, kept[0].occurrence.number, kept.at(-1).occurrence.number, kept.at(-1).walkthroughOutcome.outcome], [20, 2, 21, 'rescheduled']);
  // Other outcomes never reopen, whatever Dispatch does.
  f.put('jobs/w6', walkthrough({ date: '2026-09-30', walkthroughOutcome: { outcome: 'not_interested', reasonCode: 'price', finishedAt: NOW, requestId: randomUUID(), occurrence: { ...FIRST, scheduleOccurrence: null } } }));
  await rejects(f.run(sales, f.body('start', { visitId: 'w6', skipTimecard: true }), FINISH), 'closed', 409);
});

test('timecard problems stop the tap with a timecard error the rep can bypass explicitly', async () => {
  const f = fixture(); f.clockIn();
  f.setShift({ ...f.shift(), jobTracking: { version: 2, segments: [] } });
  await assert.rejects(f.run(sales, f.body('start')), error => error.code === 'walkthrough_visit_time_invalid' && error.status === 409 && /manager review/.test(error.message));
  f.store.activeShift = async () => { throw Object.assign(new Error('unreadable'), { code: 'walkthrough_visit_time_unavailable', status: 503 }); };
  await rejects(f.run(sales, f.body('start')), 'time_unavailable', 503);
  assert.equal(f.commits.length, 0);
  assert.equal((await f.run(sales, f.body('start', { skipTimecard: true }))).visit.walkthroughVisit.repTime.status, 'skipped');
});

test('test and internal walkthroughs are flagged on their events by the shared eligibility function', async () => {
  const f = fixture({ rows: { 'jobs/test-visit': walkthrough({ isTest: true }), 'jobs/internal-visit': walkthrough({ isInternal: true, internalReason: 'training_demo', highlevelContactId: 'bad id!' }) } });
  await f.run(owner, f.body('start', { visitId: 'test-visit', skipTimecard: true }));
  await f.run(manager, f.body('no_show', { visitId: 'internal-visit', reasonCode: 'unreachable' }));
  const [started] = f.events('walkthrough.started'), [noShow] = f.events('walkthrough.no_show');
  assert.equal(started.isTest, true); assert.equal(started.exclusion, 'test');
  assert.equal(noShow.isInternal, true); assert.equal(noShow.internalReason, 'training_demo');
  assert.equal(noShow.highlevelContactId, null, 'a malformed legacy CRM link is left off the event');
});

test('the state read returns the visit, the rep\'s open walkthrough and whether they are clocked in', async () => {
  const f = fixture();
  const idle = await walkthroughVisitState(f.store, sales, { visitId: 'w1' }, NOW);
  assert.equal(idle.visit.id, 'w1'); assert.equal(idle.visit.revision, f.rev('w1')); assert.equal(idle.openVisit, null);
  assert.deepEqual(idle.shift, { available: true, clockedIn: false, onBreak: false, needsReview: false, current: null });
  assert.deepEqual(idle.viewer, { id: 'sales.rep', manager: false });
  f.clockIn(); await f.run(sales, f.body('start'));
  const busy = await walkthroughVisitState(f.store, sales, {}, FINISH);
  assert.equal(busy.visit, null); assert.equal(busy.openVisit.id, 'w1'); assert.equal(busy.openVisit.walkthroughVisit.startedAt, NOW);
  assert.deepEqual(busy.shift.current, { kind: 'work', jobId: 'w1', startedAt: NOW }); assert.equal(busy.shift.clockedIn, true);
  for (const secret of ['1437', 'SYNTHETIC-SIGNATURE', 'Synthetic private note', 'hourlyRate', 'locationTrail']) assert.equal(JSON.stringify(busy).includes(secret), false, secret);
  await rejects(walkthroughVisitState(f.store, sales, { visitId: 'w3' }, NOW), 'not_assigned', 403);
  await rejects(walkthroughVisitState(f.store, sales, { visitId: 'job-a' }, NOW), 'not_found', 404);
  await rejects(walkthroughVisitState(f.store, sales, { jobId: 'w1' }, NOW), 'invalid', 400);
  await rejects(walkthroughVisitState(f.store, { user: 'Crew.One', role: 'crew' }, {}, NOW), 'forbidden', 403);
  assert.equal((await walkthroughVisitState(f.store, manager, { visitId: 'w3' }, NOW)).visit.id, 'w3');
  f.store.activeShift = async () => { throw Object.assign(new Error('x'), { code: 'walkthrough_visit_time_unavailable', status: 503 }); };
  assert.deepEqual((await walkthroughVisitState(f.store, sales, {}, NOW)).shift, { available: false, code: 'walkthrough_visit_time_unavailable' });
  await f.run(sales, f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded', skipTimecard: true }), FINISH);
  assert.equal((await walkthroughVisitState(f.store, sales, {}, FINISH)).openVisit, null);
});

test('the projection is an allowlist of schedule identity and the visit record', () => {
  const projected = walkthroughVisitProjection({ id: 'w1', revision: 'r1', ...walkthrough({ walkthroughVisit: { startedAt: NOW, startedBy: 'sales.rep', clockSource: 'server', recordingStatus: 'recorded', repTime: { status: 'segment_opened', segmentId: 's1' }, internalJobNotes: { text: 'Synthetic notes' } } }) });
  assert.deepEqual(Object.keys(projected).sort(), ['address', 'customer', 'customerId', 'date', 'endTime', 'id', 'previousOccurrences', 'projectId', 'rebookPending', 'revision', 'status', 'time', 'type', 'walkthroughCompletedAt', 'walkthroughOutcome', 'walkthroughVisit']);
  assert.equal(JSON.stringify(projected).includes('Synthetic notes'), false);
  assert.equal(walkthroughVisitProjection(null), null);
});

test('FUN-06: a walkthrough without audio carries up to three typed notes on its Finish, inside the request fingerprint', async () => {
  const { canonicalJson, sha256Hex } = await import('../functions/_lib/funnel-definitions.js');
  const f = fixture(); f.clockIn();
  await f.run(sales, f.body('start', { recordingStatus: 'declined' }));
  const notes = ['Synthetic: wants the two-car garage back', 'Synthetic: keep the workbench', 'Synthetic: side gate, dog in the yard'];
  const finish = extra => f.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'declined', ...extra });
  for (const typedNotes of [[], ['a', 'b', 'c', 'd'], [''], ['  '], ['x'.repeat(401)], 'Synthetic note', [7]]) await rejects(f.run(sales, finish({ typedNotes }), FINISH), 'invalid', 400);
  await rejects(f.run(sales, finish({ recordingStatus: 'recorded', typedNotes: notes }), FINISH), 'invalid', 400);
  await rejects(f.run(sales, f.body('start', { visitId: 'w2', typedNotes: notes })), 'invalid', 400);
  await rejects(f.run(sales, f.body('no_show', { visitId: 'w2', reasonCode: 'customer_not_home', typedNotes: notes })), 'invalid', 400);
  assert.equal(f.commits.length, 1);
  const input = finish({ typedNotes: [...notes.slice(0, 2), `  ${notes[2]}  `] }), result = await f.run(sales, input, FINISH);
  assert.deepEqual(f.visit('w1').walkthroughOutcome.typedNotes, notes, 'stored trimmed on the outcome');
  assert.deepEqual(f.events('walkthrough.completed')[0].data, { outcome: 'quote_to_follow', recordingStatus: 'declined' }, 'notes never enter the funnel event');
  assert.equal(JSON.stringify(result).includes('Synthetic: keep the workbench'), false, 'the allowlisted projection leaves the notes out');
  assert.equal((await f.run(sales, input, FINISH)).replayed, true);
  await rejects(f.run(sales, { ...input, typedNotes: ['Synthetic: something else'] }, FINISH), 'idempotency_conflict', 409);
  // A Finish without notes keeps the pre-FUN-06 fingerprint, so a request saved before this change still replays.
  const g = fixture(); g.clockIn();
  await g.run(sales, g.body('start'));
  const plainFinish = g.body('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' });
  await g.run(sales, plainFinish, FINISH);
  const { requestId, expectedRevision } = plainFinish;
  const legacy = sha256Hex(canonicalJson({ actor: 'sales.rep', input: { action: 'finish', visitId: 'w1', requestId, expectedRevision, outcome: 'quote_to_follow', reasonCode: null, recordingStatus: 'recorded', deviceAt: null, skipTimecard: false, actorId: null } }));
  assert.equal(g.rows.get(`${WALKTHROUGH_VISIT_OPERATIONS}/${requestId}`).fingerprint, legacy);
  assert.equal('typedNotes' in g.visit('w1').walkthroughOutcome, false);
});
