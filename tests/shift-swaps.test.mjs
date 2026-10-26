// SHIFT-SWAP (#202): a crew member asks a named coworker to take an assigned job; the coworker accepts; a manager or the
// owner approves, and only then does dispatch's own schedule.update move the job (rules and crew notices included).
// Nobody approves their own swap except the owner, and a request expires once the job starts. Synthetic people and jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { CREW_NOTIFICATIONS } from '../functions/_lib/crew-notifications.js';
import { requestSwap, answerSwap, requireApprover, swapBlocker, swapDispatchChanges, swapDispatchRequestId, swapView } from '../functions/_lib/shift-swaps.js';
import { shiftSwapHandlers } from '../functions/api/shift-swaps.js';

// NOW is 06:00 on Tuesday 2026-09-22 in Denver; the job is Wednesday 08:00.
const NOW = '2026-09-22T12:00:00.000Z', D1 = '2026-09-23';
const ROSTER = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'tylerg', name: 'Synthetic Manager', role: 'manager' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }, { id: 'crew3', name: 'Crew Three', role: 'crew' }];
const OWNER = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const MANAGER = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const LEAD = { user: 'AlexK', displayName: 'Synthetic Lead', role: 'crew_lead', businessAccess: true };
const crew = user => ({ user, displayName: ROSTER.find(person => person.id === user)?.name || user, role: 'crew' });
const plainJob = (extra = {}) => ({ id: 'job-1', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', date: D1, time: '08:00', endDate: D1, endTime: '12:00', serviceType: 'Garage cleanout', assignedCrew: ['crew1', 'crew2'], crewLead: 'crew1', ...extra });

test('a request: only the assigned crew member, to an active coworker not on the job, for a job that has not started', () => {
  const ask = (session, input, job = plainJob(), open = []) => requestSwap({ job, session, input: { jobId: 'job-1', requestId: randomUUID(), ...input }, roster: ROSTER, openSwaps: open, now: NOW });
  const swap = ask(crew('crew1'), { to: 'crew3', reason: 'Dentist appointment' });
  assert.deepEqual([swap.status, swap.from, swap.to, swap.toName, swap.jobDate, swap.jobTime, swap.jobStartAt, swap.service], ['requested', 'crew1', 'crew3', 'Crew Three', D1, '08:00', '2026-09-23T14:00:00.000Z', 'Garage cleanout']);
  assert.deepEqual(swap.history.map(row => [row.action, row.by]), [['requested', 'crew1']]);
  assert.throws(() => ask(crew('crew3'), { to: 'crew1' }), { code: 'shift_swap_not_assigned' });
  assert.throws(() => ask(crew('crew1'), { to: 'crew2' }), { code: 'shift_swap_coworker_assigned' });
  assert.throws(() => ask(crew('crew1'), { to: 'crew1' }), { code: 'shift_swap_coworker_invalid' });
  assert.throws(() => ask(crew('crew1'), { to: 'someone.gone' }), { code: 'shift_swap_coworker_invalid' });
  assert.throws(() => ask(crew('crew1'), { to: 'crew3' }, plainJob(), [swap]), { code: 'shift_swap_already_open' });
  for (const [job, why] of [[plainJob({ date: '2026-09-22', time: '05:00', endDate: '2026-09-22' }), 'already started'], [plainJob({ status: 'arrived', pipelineStatus: 'arrived' }), 'already started'],
    [plainJob({ status: 'completed', pipelineStatus: 'completed' }), 'finished'], [plainJob({ assignmentSegments: [{ id: 'a', date: D1, assignedCrew: ['crew1'] }] }), 'split'], [plainJob({ time: '' }), 'no scheduled time']])
    assert.throws(() => ask(crew('crew1'), { to: 'crew3' }, job), error => error.code === 'shift_swap_job_unavailable' && error.message.includes(why), why);
});

test('the coworker answers, the requester cancels, a manager denies; nobody approves a swap they are in except the owner', () => {
  const swap = requestSwap({ job: plainJob(), session: crew('crew1'), input: { jobId: 'job-1', requestId: randomUUID(), to: 'crew3' }, roster: ROSTER, now: NOW });
  assert.throws(() => answerSwap({ swap, session: crew('crew2'), action: 'accept', now: NOW }), { code: 'shift_swap_forbidden' });
  const accepted = answerSwap({ swap, session: crew('crew3'), action: 'accept', now: NOW });
  assert.equal(accepted.status, 'accepted');
  assert.throws(() => answerSwap({ swap: accepted, session: crew('crew3'), action: 'decline', now: NOW }), { code: 'shift_swap_state' });
  assert.equal(answerSwap({ swap: accepted, session: crew('crew1'), action: 'cancel', now: NOW }).status, 'cancelled');
  assert.equal(answerSwap({ swap: accepted, session: MANAGER, env: {}, action: 'deny', note: 'Short on Wednesday', now: NOW }).status, 'denied');
  assert.throws(() => answerSwap({ swap: accepted, session: crew('crew2'), env: {}, action: 'deny', now: NOW }), { code: 'shift_swap_forbidden' });
  assert.throws(() => requireApprover(accepted, LEAD, {}), { code: 'shift_swap_forbidden' }, 'a crew lead does not approve');
  assert.throws(() => requireApprover({ ...accepted, to: 'tylerg' }, MANAGER, {}), { code: 'shift_swap_self', status: 403 });
  assert.doesNotThrow(() => requireApprover({ ...accepted, from: 'zacb' }, OWNER, {}), 'the owner may approve their own');
  // Expiry: once the job's start passes, an open swap reads as expired and any answer closes it so.
  assert.equal(swapView(accepted, Date.parse('2026-09-23T14:00:00.000Z')).status, 'expired');
  assert.equal(answerSwap({ swap, session: crew('crew3'), action: 'accept', now: '2026-09-23T15:00:00.000Z' }).status, 'expired');
});

test('the approval\'s dispatch change hands the job (and the lead) to the coworker, with a stable request ID', async () => {
  const swap = { from: 'crew1', to: 'crew3' };
  assert.deepEqual(swapDispatchChanges(plainJob(), swap), { assignedCrew: ['crew3', 'crew2'], crewLead: 'crew3' });
  assert.deepEqual(swapDispatchChanges(plainJob({ crewLead: 'crew2' }), swap), { assignedCrew: ['crew3', 'crew2'] });
  assert.equal(swapDispatchChanges(plainJob({ assignedCrew: ['crew2'] }), swap), null, 'the requester is no longer on the job');
  assert.equal(swapDispatchChanges(plainJob({ assignedCrew: ['crew1', 'crew3'] }), swap), null, 'the coworker is already on it');
  const id = await swapDispatchRequestId('swap_0123');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, await swapDispatchRequestId('swap_0123'));
  assert.notEqual(id, await swapDispatchRequestId('swap_0124'));
  assert.equal(swapBlocker(plainJob(), Date.parse(NOW)), '');
});

// The real handlers and the real dispatch save over an in-memory store (the crew-notifications.test.mjs fixture shape).
function fixture() {
  const rows = new Map([['customers/c1', { id: 'c1', name: 'Synthetic Customer', revision: 'c1r' }]]);
  let revision = 0;
  const clone = value => structuredClone(value), all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const matches = (row, spec) => spec.op === 'IN' ? spec.value.includes(row[spec.field]) : row[spec.field] === spec.value;
  const store = {
    crewNotificationsEnabled: true, segmentsEnabled: false,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(ROSTER), recurringPlans: async () => all('recurringPlans'),
    datedJobs: async (start, end) => all('jobs').filter(row => row.date >= start && row.date <= end),
    shiftSwaps: async spec => all('shiftSwaps').filter(row => matches(row, spec)),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    readMany: async (collection, ids) => ids.map(id => rows.get(`${collection}/${id}`)).filter(Boolean).map(clone),
    commit: async writes => {
      for (const write of writes) {
        const old = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  let who = crew('crew1'), at = NOW;
  const handlers = shiftSwapHandlers({ session: async () => who, dispatch: () => store, travel: () => ({}), now: () => new Date(at) });
  const as = session => { who = session; };
  const clock = value => { at = value; };
  const get = async () => { const response = await handlers.get({ request: new Request('https://easygaragecleaning.com/api/shift-swaps'), env: {} }); return { status: response.status, body: await response.json() }; };
  const post = async body => { const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/shift-swaps', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify(body) }), env: {} }); return { status: response.status, body: await response.json() }; };
  return { rows, store, as, clock, get, post, job: id => rows.get(`jobs/${id}`), notices: () => all(CREW_NOTIFICATIONS) };
}
async function seedJob(f) {
  const created = await mutateDispatch(f.store, OWNER, { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: D1, time: '08:00', endTime: '12:00', assignedCrew: ['crew1', 'crew2'], crewLead: 'crew1', jobInstructions: 'Synthetic scope' } }, NOW);
  return created.job.id;
}

test('end to end: request, accept, approve; only the approval moves the job, through dispatch, and crew are told', async () => {
  const f = fixture(), jobId = await seedJob(f);
  const before = f.notices().length;
  f.as(crew('crew1'));
  const listed = (await f.get()).body;
  assert.deepEqual(listed.jobs.map(row => row.id), [jobId], 'the requester sees the job they could hand over');
  assert.ok(listed.coworkers.some(person => person.id === 'crew3') && !listed.coworkers.some(person => person.id === 'crew1'));
  assert.equal(listed.canApprove, false); assert.equal(listed.approvals, undefined);
  const requested = await f.post({ action: 'request', requestId: randomUUID(), jobId, to: 'crew3', reason: 'Family event' });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const swapId = requested.body.swap.id;
  assert.deepEqual(f.job(jobId).assignedCrew, ['crew1', 'crew2'], 'asking changes nothing');
  f.as(crew('crew3'));
  assert.deepEqual((await f.get()).body.incoming.map(row => [row.id, row.status]), [[swapId, 'requested']]);
  assert.equal((await f.post({ action: 'accept', swapId })).status, 200);
  assert.deepEqual(f.job(jobId).assignedCrew, ['crew1', 'crew2'], 'accepting changes nothing');
  assert.equal((await f.post({ action: 'approve', swapId })).status, 403, 'crew cannot approve');
  f.as(MANAGER);
  const queue = (await f.get()).body;
  assert.deepEqual(queue.approvals.map(row => [row.id, row.status, row.canDecide]), [[swapId, 'accepted', true]]);
  assert.equal(queue.approvals[0].newLead, 'Crew Three', 'the approval card names who leads the job after the swap');
  const approved = await f.post({ action: 'approve', swapId });
  assert.deepEqual([approved.status, approved.body.swap.status, approved.body.swap.decidedBy], [200, 'approved', 'TylerG'], JSON.stringify(approved.body));
  assert.deepEqual([f.job(jobId).assignedCrew, f.job(jobId).crewLead], [['crew3', 'crew2'], 'crew3'], 'the coworker is on the job and leads it');
  const stored = f.rows.get(`shiftSwaps/${swapId}`);
  assert.deepEqual(stored.history.map(row => [row.action, row.by]), [['requested', 'crew1'], ['accepted', 'crew3'], ['approved', 'TylerG']]);
  assert.ok(f.rows.has(`dispatchOperations/${stored.dispatchRequestId}`), 'the dispatch save left its receipt');
  const told = f.notices().slice(before).map(row => `${row.employeeId}:${row.intent}`).sort();
  assert.deepEqual(told, ['crew1:unassigned', 'crew3:assigned'], 'dispatch told the crew, as for any reassignment');
  const again = await f.post({ action: 'approve', swapId });
  assert.deepEqual([again.status, again.body.replayed], [200, true], 'a retried approval replays');
  assert.deepEqual(f.job(jobId).assignedCrew, ['crew3', 'crew2']);
});

test('a manager in the swap cannot approve it; the owner can; a request expires once the job starts', async () => {
  const f = fixture(), jobId = await seedJob(f);
  f.as(crew('crew2'));
  const swapId = (await f.post({ action: 'request', requestId: randomUUID(), jobId, to: 'tylerg' })).body.swap.id;
  f.as(MANAGER);
  assert.equal((await f.post({ action: 'accept', swapId })).status, 200, 'the manager accepts as the coworker');
  const queue = (await f.get()).body;
  assert.equal(queue.approvals[0].canDecide, false);
  assert.deepEqual([(await f.post({ action: 'approve', swapId })).body.code], ['shift_swap_self']);
  f.clock('2026-09-23T14:30:00.000Z');
  f.as(OWNER);
  const late = await f.post({ action: 'approve', swapId });
  assert.deepEqual([late.status, late.body.code], [409, 'shift_swap_state']);
  assert.equal(f.rows.get(`shiftSwaps/${swapId}`).status, 'expired', 'the job started first, so the request expired');
  assert.deepEqual(f.job(jobId).assignedCrew, ['crew1', 'crew2'], 'nothing moved');
});

test('a dispatch refusal leaves the swap accepted, and a crew change since the request is caught', async () => {
  const f = fixture(), jobId = await seedJob(f);
  f.as(crew('crew1'));
  const swapId = (await f.post({ action: 'request', requestId: randomUUID(), jobId, to: 'crew3' })).body.swap.id;
  f.as(crew('crew3')); await f.post({ action: 'accept', swapId });
  // Meanwhile a manager takes crew1 off the job in Dispatch.
  const job = f.job(jobId);
  await mutateDispatch(f.store, OWNER, { action: 'schedule.update', requestId: randomUUID(), jobId, expectedRevision: job.revision, changes: { assignedCrew: ['crew2'], crewLead: 'crew2' } }, NOW);
  f.as(MANAGER);
  const refused = await f.post({ action: 'approve', swapId });
  assert.deepEqual([refused.status, refused.body.code], [409, 'shift_swap_job_unavailable']);
  assert.equal(f.rows.get(`shiftSwaps/${swapId}`).status, 'accepted', 'the manager can still deny it');
  assert.equal((await f.post({ action: 'deny', swapId, note: 'Already changed in Dispatch' })).body.swap.status, 'denied');
  assert.doesNotMatch(JSON.stringify((await f.get()).body), /Synthetic Customer|estimate|price|amount/i, 'no customer or money');
});

// Accept and request a swap of the seeded job: crew1 hands it to crew3, who accepts.
async function accepted(f, jobId) {
  f.as(crew('crew1'));
  const swapId = (await f.post({ action: 'request', requestId: randomUUID(), jobId, to: 'crew3' })).body.swap.id;
  f.as(crew('crew3'));
  assert.equal((await f.post({ action: 'accept', swapId })).status, 200);
  return swapId;
}
const reschedule = (f, jobId, changes) => mutateDispatch(f.store, OWNER, { action: 'schedule.update', requestId: randomUUID(), jobId, expectedRevision: f.job(jobId).revision, changes }, NOW);

test('approval is held to the schedule the coworker accepted: a rescheduled job expires the swap', async () => {
  const f = fixture(), jobId = await seedJob(f);
  const swapId = await accepted(f, jobId);
  assert.deepEqual(f.rows.get(`shiftSwaps/${swapId}`).jobSchedule, { date: D1, time: '08:00', endDate: D1, endTime: '12:00' }, 'the accept records the schedule');
  await reschedule(f, jobId, { time: '09:00', endTime: '13:00' });
  f.as(MANAGER);
  const queue = (await f.get()).body;
  assert.deepEqual(queue.approvals, [], 'the list read closed it');
  assert.equal(f.rows.get(`shiftSwaps/${swapId}`).status, 'expired');
  // And the approval itself refuses a rescheduled job, even before any list read saw it.
  const g = fixture(), other = await seedJob(g), second = await accepted(g, other);
  await reschedule(g, other, { date: '2026-09-24', endDate: '2026-09-24' });
  g.as(MANAGER);
  const refused = await g.post({ action: 'approve', swapId: second });
  assert.deepEqual([refused.status, refused.body.code], [409, 'shift_swap_rescheduled']);
  assert.match(refused.body.error, /rescheduled; ask again/);
  assert.equal(g.rows.get(`shiftSwaps/${second}`).status, 'expired');
  assert.deepEqual(g.job(other).assignedCrew, ['crew1', 'crew2'], 'nothing moved');
  // A reschedule between the request and the accept: the coworker cannot accept the old time.
  const h = fixture(), third = await seedJob(h);
  h.as(crew('crew1'));
  const asked = (await h.post({ action: 'request', requestId: randomUUID(), jobId: third, to: 'crew3' })).body.swap.id;
  await reschedule(h, third, { time: '10:00', endTime: '14:00' });
  h.as(crew('crew3'));
  const late = await h.post({ action: 'accept', swapId: asked });
  assert.deepEqual([late.status, late.body.code], [409, 'shift_swap_job_unavailable']);
  assert.equal(h.rows.get(`shiftSwaps/${asked}`).status, 'expired');
});

test('a list read saves an open swap whose job has started as expired, by the server', async () => {
  const f = fixture(), jobId = await seedJob(f);
  f.as(crew('crew1'));
  const swapId = (await f.post({ action: 'request', requestId: randomUUID(), jobId, to: 'crew3' })).body.swap.id;
  f.clock('2026-09-23T14:30:00.000Z');
  const listed = (await f.get()).body;
  assert.deepEqual(listed.mine.map(row => [row.id, row.status]), [[swapId, 'expired']]);
  const stored = f.rows.get(`shiftSwaps/${swapId}`);
  assert.deepEqual([stored.status, stored.history.at(-1).action, stored.history.at(-1).by], ['expired', 'expired', 'system']);
  f.as(crew('crew3'));
  assert.equal((await f.post({ action: 'accept', swapId })).status, 409, 'an expired request cannot be accepted');
});

test('approve against cancel and deny: the approval claims the swap first, and a dispatch refusal puts it back', async () => {
  // 1. A cancel arriving while the approval runs is refused.
  const f = fixture(), jobId = await seedJob(f), swapId = await accepted(f, jobId);
  const commit = f.store.commit;
  let cancel = null;
  f.store.commit = async writes => {
    await commit(writes);
    if (!cancel && writes.some(write => write.patch?.status === 'approving')) { f.as(crew('crew1')); cancel = await f.post({ action: 'cancel', swapId }); }
  };
  f.as(MANAGER);
  const approved = await f.post({ action: 'approve', swapId });
  assert.deepEqual([cancel.status, cancel.body.code], [409, 'shift_swap_approving']);
  assert.deepEqual([approved.status, approved.body.swap.status], [200, 'approved'], JSON.stringify(approved.body));
  assert.deepEqual(f.job(jobId).assignedCrew, ['crew3', 'crew2']);
  // 2. A denial saved before the approval's claim wins, and the job does not move.
  const g = fixture(), other = await seedJob(g), second = await accepted(g, other);
  const read = g.store.read;
  let denied = null;
  g.store.read = async (collection, id) => {
    const row = await read(collection, id);
    if (!denied && collection === 'jobs' && id === other) { const { as } = g; as(OWNER); denied = await g.post({ action: 'deny', swapId: second }); as(MANAGER); }
    return row;
  };
  g.as(MANAGER);
  const lost = await g.post({ action: 'approve', swapId: second });
  assert.equal(denied.body.swap.status, 'denied');
  assert.deepEqual([lost.status, lost.body.code], [409, 'shift_swap_changed']);
  g.store.read = read;
  assert.equal(g.rows.get(`shiftSwaps/${second}`).status, 'denied');
  assert.deepEqual(g.job(other).assignedCrew, ['crew1', 'crew2'], 'nothing moved');
  // 3. A dispatch refusal returns the swap to accepted, so a manager can retry or deny.
  const h = fixture(), third = await seedJob(h), swap3 = await accepted(h, third);
  const save = h.store.commit;
  h.store.commit = async writes => { if (writes.some(write => write.collection === 'jobs')) throw Object.assign(new Error('Crew Three is booked'), { code: 'dispatch_conflict', status: 409 }); return save(writes); };
  h.as(MANAGER);
  const refused = await h.post({ action: 'approve', swapId: swap3 });
  assert.deepEqual([refused.status, refused.body.code], [409, 'dispatch_conflict']);
  assert.deepEqual([h.rows.get(`shiftSwaps/${swap3}`).status, h.rows.get(`shiftSwaps/${swap3}`).dispatchRequestId], ['accepted', '']);
  h.store.commit = save;
  assert.equal((await h.post({ action: 'approve', swapId: swap3 })).body.swap.status, 'approved');
  // 4. The job moved but the final save failed: it stays approving, and the retry finishes it from the dispatch receipt
  // without a second move.
  const k = fixture(), fourth = await seedJob(k), swap4 = await accepted(k, fourth);
  const keep = k.store.commit;
  let dropped = false;
  k.store.commit = async writes => { if (!dropped && writes.some(write => write.patch?.status === 'approved')) { dropped = true; throw Object.assign(new Error('lost'), { code: 'dispatch_storage_unavailable', status: 503 }); } return keep(writes); };
  k.as(MANAGER);
  const lostReply = await k.post({ action: 'approve', swapId: swap4 });
  assert.equal(lostReply.status, 503, JSON.stringify(lostReply.body));
  assert.equal(k.rows.get(`shiftSwaps/${swap4}`).status, 'approving');
  k.as(crew('crew3'));
  assert.equal((await k.post({ action: 'decline', swapId: swap4 })).body.code, 'shift_swap_approving');
  k.as(MANAGER);
  assert.deepEqual((await k.get()).body.approvals.map(row => row.status), ['approving'], 'the manager still sees it to finish');
  const finished = await k.post({ action: 'approve', swapId: swap4 });
  assert.deepEqual([finished.status, finished.body.swap.status, finished.body.replayed], [200, 'approved', true]);
  assert.deepEqual(k.job(fourth).assignedCrew, ['crew3', 'crew2']);
});

test('one open request per job and requester, even when two are sent at once', async () => {
  const f = fixture(), jobId = await seedJob(f);
  f.as(crew('crew1'));
  const both = await Promise.all([f.post({ action: 'request', requestId: randomUUID(), jobId, to: 'crew3' }), f.post({ action: 'request', requestId: randomUUID(), jobId, to: 'tylerg' })]);
  assert.deepEqual(both.map(row => row.status).sort(), [200, 409]);
  assert.equal(both.find(row => row.status === 409).body.code, 'shift_swap_already_open');
  const open = [...f.rows.keys()].filter(id => id.startsWith('shiftSwaps/'));
  assert.equal(open.length, 1, 'only one request was saved');
  // The same request sent twice is a replay, not a second request.
  const requestId = randomUUID(), g = fixture(), other = await seedJob(g);
  g.as(crew('crew1'));
  const twice = await Promise.all([g.post({ action: 'request', requestId, jobId: other, to: 'crew3' }), g.post({ action: 'request', requestId, jobId: other, to: 'crew3' })]);
  assert.deepEqual(twice.map(row => [row.status, row.body.swap?.id]), [[200, `swap_${requestId.replace(/-/g, '')}`], [200, `swap_${requestId.replace(/-/g, '')}`]]);
  assert.equal([...g.rows.keys()].filter(id => id.startsWith('shiftSwaps/')).length, 1);
  // Once the request is closed, a new one for the same job takes the lock over.
  const swapId = f.rows.get(open[0]).id;
  assert.equal((await f.post({ action: 'cancel', swapId })).status, 200);
  assert.equal((await f.post({ action: 'request', requestId: randomUUID(), jobId, to: 'crew3' })).status, 200);
  assert.equal([...f.rows.keys()].filter(id => id.startsWith('shiftSwapLocks/')).length, 1);
});

test('a refusal after the job moved finishes the approval, and two managers approving at once both end approved', async () => {
  // A Dispatch edit lands between the move's save and its read-back: the save stands, so the swap is approved, not reopened.
  const f = fixture(), jobId = await seedJob(f), swapId = await accepted(f, jobId);
  const commit = f.store.commit, read = f.store.read;
  let moved = false, late = false;
  f.store.commit = async writes => { await commit(writes); if (writes.some(write => write.collection === 'jobs')) moved = true; };
  // The read-back after the move sees another Dispatch save on the job, so Dispatch answers dispatch_changed_since_operation.
  f.store.read = async (collection, id) => { const row = await read(collection, id); if (moved && !late && collection === 'jobs' && id === jobId) { late = true; return { ...row, dispatchRequestId: randomUUID() }; } return row; };
  f.as(MANAGER);
  const approved = await f.post({ action: 'approve', swapId });
  assert.ok(late, 'Dispatch saw the later edit');
  assert.deepEqual([approved.status, approved.body.swap?.status], [200, 'approved'], JSON.stringify(approved.body));
  assert.equal(f.rows.get(`shiftSwaps/${swapId}`).status, 'approved');
  f.as(crew('crew1'));
  assert.equal((await f.post({ action: 'cancel', swapId })).status, 409, 'a moved job\'s swap cannot be cancelled');
  assert.deepEqual(f.job(jobId).assignedCrew, ['crew3', 'crew2']);
  // Two managers press Approve together: both answers say approved, the job moves once, the swap ends approved.
  const g = fixture(), other = await seedJob(g), second = await accepted(g, other);
  const receipts = () => [...g.rows.keys()].filter(key => key.startsWith('dispatchOperations/')).length, before = receipts();
  g.as(MANAGER);
  const both = await Promise.all([g.post({ action: 'approve', swapId: second }), (async () => { await Promise.resolve(); g.as(OWNER); return g.post({ action: 'approve', swapId: second }); })()]);
  assert.equal(g.rows.get(`shiftSwaps/${second}`).status, 'approved', JSON.stringify(both.map(row => row.body)));
  assert.ok(both.some(row => row.status === 200 && row.body.swap.status === 'approved'));
  assert.ok(both.every(row => row.status === 200 || row.body.code === 'shift_swap_changed'), JSON.stringify(both.map(row => row.body)));
  assert.deepEqual(g.job(other).assignedCrew, ['crew3', 'crew2']);
  assert.equal(receipts(), before + 1, 'one dispatch save for the swap');
});

test('a second approver who finds the job already moved by the first finishes it as approved, never reopens it', async () => {
  // The order: A claims 'approving'; B reads it and finds no receipt yet; A's Dispatch save lands; B reads the job, sees
  // the coworker already on it (no change left to make). B must record the approval, and A's own finish is a replay.
  const f = fixture(), jobId = await seedJob(f), swapId = await accepted(f, jobId);
  const commit = f.store.commit, read = f.store.read;
  let bWindow = false, second = null, bAtJob, aMoved;
  const atJob = new Promise(resolve => { bAtJob = resolve; }), moved = new Promise(resolve => { aMoved = resolve; });
  f.store.read = async (collection, id) => {
    if (bWindow && collection === 'jobs' && id === jobId) { bWindow = false; bAtJob(); await moved; }
    return read(collection, id);
  };
  f.store.commit = async writes => {
    if (!second && writes.some(write => write.collection === 'jobs')) {
      bWindow = true; f.as(OWNER); second = f.post({ action: 'approve', swapId });
      await atJob; await commit(writes); aMoved(); return;
    }
    return commit(writes);
  };
  f.as(MANAGER);
  const first = await f.post({ action: 'approve', swapId }), other = await second;
  assert.deepEqual([first.status, first.body.swap?.status, other.status, other.body.swap?.status], [200, 'approved', 200, 'approved'], JSON.stringify([first.body, other.body]));
  assert.equal(f.rows.get(`shiftSwaps/${swapId}`).status, 'approved');
  assert.deepEqual(f.job(jobId).assignedCrew, ['crew3', 'crew2'], 'moved once');
  f.as(crew('crew1'));
  assert.equal((await f.post({ action: 'cancel', swapId })).status, 409, 'the moved swap cannot be cancelled');
});
