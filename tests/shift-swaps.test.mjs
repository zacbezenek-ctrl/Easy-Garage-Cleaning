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
