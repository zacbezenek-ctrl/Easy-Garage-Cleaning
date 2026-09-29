import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createJobAssignmentAccess } from '../functions/_lib/job-assignment.js';
import { fieldActivity, fieldChecklist, fieldJobProjection, fieldViewerWorksOn } from '../functions/_lib/field-execution.js';
import { fieldJobTime } from '../functions/_lib/field-execution-time.js';
import { fieldExpenseHandlers } from '../functions/api/field-expenses.js';
import { CLOSURE_LIMIT, VISIT_LIMIT, assignedDuring, assignedOn, fieldJobDays, fieldVisitCommand, fieldVisitProjection, fieldVisitsEnabled } from '../functions/_lib/field-execution-visits.js';
import * as route from '../functions/api/field-jobs.js';
import { storage } from './helpers/field-fixture.mjs';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const D1 = '2026-09-22', D2 = '2026-09-23', D3 = '2026-09-24', D4 = '2026-09-25';
// Mountain daylight time is UTC-6 throughout these dates.
const at = (date, time) => new Date(`${date}T${time}:00.000-06:00`).toISOString();
const minute = 60000, hour = 60 * minute, uuid = () => crypto.randomUUID();
const users = { ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Owner' }, 'Crew.One': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' }, 'Crew.Two': { passwordHash: 'test', role: 'crew', displayName: 'Crew Two' } };
const off = { HUB_SESSION_SECRET: 'synthetic-multiday-session-secret', FIREBASE_API_KEY: 'firebase-test-multiday', HUB_AUTH_USERS_JSON: JSON.stringify(users), GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test' };
const on = { ...off, FIELD_MULTIDAY_VISITS: 'true' };
const cookies = new Map(await Promise.all(Object.keys(users).map(async user => [user, (await createHubSessionCookie(off, user)).split(';')[0]])));
const crew = { user: 'Crew.One', displayName: 'Crew One', manager: false }, boss = { user: 'ZacB', displayName: 'Owner', manager: true };
const picture = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]).toString('base64')}`;

function request(user, body, search = '') {
  return new Request(`https://easygaragecleaning.com/api/field-jobs${search}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookies.get(user) || '', Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function get(env, user, search) { const response = await route.onRequestGet({ env, request: request(user, null, search) }); return { status: response.status, body: await response.json() }; }
async function post(env, store, user, data, jobId = 'job-1') {
  const response = await route.onRequestPost({ env, request: request(user, { jobId, requestId: uuid(), expectedRevision: store.revision(jobId), ...data }) });
  return { status: response.status, body: await response.json() };
}
// A three-day job with its checklist done and verified before/after photos, so
// each day exercises only the visit rules.
function threeDay(extra = {}) {
  const job = { id: 'job-1', type: 'job', customer: 'Synthetic Multi-Day Garage', address: '1 Synthetic Way, Fort Collins, CO', phone: '9705550100', date: D1, time: '08:00', endDate: D3, endTime: '17:00', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', status: 'scheduled', pipelineStatus: 'scheduled', total: 4800, jobInstructions: { operationalScope: 'Synthetic three-day cleanout' }, ...extra };
  job.fieldExecution = { checks: Object.fromEntries(fieldChecklist(job).map(item => [item.id, { completed: true, actorId: 'Crew.One' }])), photos: ['before', 'after'].map(category => ({ id: uuid(), fileId: `file-${category}`, category, verified: true })), ...extra.fieldExecution };
  return job;
}
const part = (id, date, assignedCrew) => ({ id, date, time: '08:00', endDate: date, endTime: '17:00', assignedCrew, crewLead: null, crewId: null, vehicleId: null, notes: '' });
const split = () => threeDay({ id: 'split', assignedCrew: ['crew.one', 'crew.two'], crewLead: null, assignmentSegments: [part('a', D1, ['crew.one']), part('b', D2, ['crew.two']), part('c', D3, ['crew.one'])] });
const apply = (job, actor, input, now) => { const result = fieldVisitCommand(job, actor, { requestId: uuid(), ...input }, now); return { ...job, ...result.patch, __event: result.event }; };

test('FIELD_MULTIDAY_VISITS is on only for exactly "true"', () => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true', '1', true]) assert.equal(fieldVisitsEnabled({ FIELD_MULTIDAY_VISITS: value }), false, String(value));
  assert.equal(fieldVisitsEnabled({ FIELD_MULTIDAY_VISITS: 'true' }), true);
  assert.equal(fieldVisitsEnabled(undefined), false);
});

test('job days follow the Denver schedule, midnight releases, split segments and unreadable times', () => {
  assert.deepEqual(fieldJobDays(threeDay()), [D1, D2, D3]);
  assert.deepEqual(fieldJobDays({ date: D1, time: '20:00', endDate: D2, endTime: '00:00' }), [D1], 'an end at midnight releases the next day');
  assert.deepEqual(fieldJobDays({ date: D1, time: '08:00', endTime: '11:00' }), [D1]);
  assert.deepEqual(fieldJobDays({ ...split(), assignmentSegments: [part('a', D1, ['crew.one']), part('c', D3, ['crew.one'])] }), [D1, D3], 'no day between split segments');
  assert.deepEqual(fieldJobDays({ date: D1, endDate: D3, time: '', endTime: '' }), [D1, D2, D3], 'wall dates stand in for unreadable times');
  assert.deepEqual(fieldJobDays({ date: 'not-a-date' }), []);
});

test('a three-day job keeps each day’s end_day visit, refuses completion before the final day and completes on day 3 without double-counting the job clock', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(D1, '07:30')) });
  const store = storage(t); store.put('jobs/job-1', threeDay());
  const step = async (time, data, user = 'Crew.One') => { t.mock.timers.setTime(Date.parse(time)); const result = await post(on, store, user, data); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  await step(at(D1, '07:30'), { action: 'status', status: 'dispatched' });
  await step(at(D1, '08:00'), { action: 'status', status: 'arrived' });
  let body = await step(at(D1, '08:15'), { action: 'status', status: 'in_progress' });
  assert.deepEqual(body.job.visits.days.map(day => [day.date, day.status]), [[D1, 'in_progress'], [D2, 'not_started'], [D3, 'not_started']]);
  assert.equal(body.job.visits.completionOpen, false); assert.equal(body.job.visits.canEndDay, true); assert.equal(body.job.visits.finalDay, D3);
  const endDay1 = { action: 'end_day', requestId: uuid(), notes: 'Synthetic day one: north wall cleared, shelving remains.' };
  body = await step(at(D1, '16:15'), endDay1);
  assert.equal(body.job.fieldStatus, 'day_ended'); assert.equal(body.job.status, 'in_progress');
  assert.deepEqual(body.job.allowedStatuses, ['waiting', 'delayed', 'in_progress'], 'no pause once the day has ended');
  assert.deepEqual([body.job.visits.days[0].status, body.job.visits.days[0].notes, body.job.visits.days[0].endedBy, body.job.visits.canEndDay], ['ended', endDay1.notes, 'Crew One', false]);
  assert.equal(body.job.jobTime.runningKind, null); assert.equal(body.job.jobTime.workMs, 8 * hour);
  const commits = store.calls.commits;
  let refused = await post(on, store, 'Crew.One', { action: 'complete', notes: 'Synthetic attempt to close the job on day one.', hasIssues: false });
  assert.deepEqual([refused.status, refused.body.code], [409, 'FIELD_COMPLETION_NOT_FINAL_DAY']);
  refused = await post(on, store, 'Crew.One', { action: 'end_day', notes: 'Synthetic second end of the same day.' });
  assert.deepEqual([refused.status, refused.body.code], [409, 'FIELD_VISIT_ENDED']);
  const replay = await post(on, store, 'Crew.One', endDay1);
  assert.deepEqual([replay.status, replay.body.alreadyApplied], [200, true]);
  assert.equal(store.calls.commits, commits, 'refusals and the replay write nothing');
  // Overnight: the stopped clock does not run.
  t.mock.timers.setTime(Date.parse(at(D2, '07:55')));
  const overnight = await get(on, 'Crew.One', '?jobId=job-1&view=timer');
  assert.deepEqual([overnight.body.jobTime.workMs, overnight.body.jobTime.runningKind, overnight.body.jobTime.needsReview], [8 * hour, null, false]);
  assert.deepEqual((await get(on, 'Crew.One', `?date=${D2}`)).body.jobs.map(job => [job.id, job.visits.today]), [['job-1', D2]]);
  body = await step(at(D2, '08:00'), { action: 'status', status: 'in_progress' });
  assert.equal(body.job.fieldStatus, 'in_progress'); assert.equal(body.job.visits.days[1].status, 'in_progress');
  await step(at(D2, '12:00'), { action: 'status', status: 'paused', reason: 'Synthetic dump run' });
  await step(at(D2, '12:30'), { action: 'status', status: 'in_progress' });
  body = await step(at(D2, '17:00'), { action: 'end_day', notes: 'Synthetic day two: shelving out, floor prep remains.' });
  assert.equal(body.job.jobTime.workMs, 16.5 * hour);
  refused = await post(on, store, 'Crew.One', { action: 'complete', notes: 'Synthetic attempt to close the job on day two.', hasIssues: false });
  assert.deepEqual([refused.status, refused.body.code], [409, 'FIELD_COMPLETION_NOT_FINAL_DAY']);
  body = await step(at(D3, '08:00'), { action: 'status', status: 'in_progress' });
  assert.equal(body.job.visits.completionOpen, true);
  body = await step(at(D3, '11:00'), { action: 'complete', notes: 'Synthetic final day: floor finished and walkthrough complete.', hasIssues: false });
  assert.equal(body.job.status, 'completed');
  const saved = store.get('jobs/job-1'), visits = saved.fieldExecution.visits;
  assert.deepEqual(Object.keys(visits).sort(), [D1, D2, D3]);
  assert.deepEqual([visits[D1].status, visits[D1].notes, visits[D1].endedAt, visits[D1].startedAt], ['ended', endDay1.notes, at(D1, '16:15'), at(D1, '07:30')], 'day one’s end_day is kept');
  assert.deepEqual([visits[D2].status, visits[D3].status, visits[D3].notes], ['ended', 'completed', 'Synthetic final day: floor finished and walkthrough complete.']);
  const time = fieldJobTime(saved, at(D4, '09:00'));
  assert.deepEqual([time.workMs, time.pausedMs, time.travelMs, time.arrivalMs, time.runningKind, time.needsReview], [19.5 * hour, 30 * minute, 30 * minute, 15 * minute, null, false]);
  assert.equal(time.totalRecordedMs, 19.5 * hour + 75 * minute, 'nights between visits are never counted');
  const events = [...store.documents.keys()].filter(key => key.startsWith('jobs/job-1/fieldEvents/')).map(key => store.get(key));
  assert.deepEqual(events.filter(event => event.action === 'end_day').map(event => [event.visitDate, event.timeSegment.kind]).sort(), [[D1, 'work'], [D2, 'work']]);
  assert.equal(events.filter(event => event.action === 'end_day').length, 2, 'the replayed end_day was recorded once');
});

test('a lost end_day response is recovered from its receipt and never stops the clock twice', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(D1, '08:15')) });
  const store = storage(t); store.put('jobs/job-1', threeDay({ status: 'in_progress', pipelineStatus: 'in_progress', startedAt: at(D1, '08:15') }));
  assert.equal((await post(on, store, 'Crew.One', { action: 'status', status: 'in_progress' })).status, 200);
  const provider = globalThis.fetch; let interrupt = true;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const response = await provider(input, options);
    if (interrupt && new URL(input).pathname.endsWith('/documents:commit')) { interrupt = false; return Response.json({}, { status: 503 }); }
    return response;
  });
  t.mock.timers.setTime(Date.parse(at(D1, '12:15')));
  const input = { action: 'end_day', requestId: uuid(), notes: 'Synthetic day one ended before the reply was lost.' };
  let result = await post(on, store, 'Crew.One', input);
  assert.deepEqual([result.status, result.body.alreadyApplied], [200, true]);
  t.mock.timers.setTime(Date.parse(at(D1, '13:15')));
  result = await post(on, store, 'Crew.One', input);
  assert.deepEqual([result.status, result.body.alreadyApplied, result.body.job.jobTime.workMs], [200, true, 4 * hour]);
  assert.equal(store.get('jobs/job-1').fieldExecution.jobTime.totalsMs.work, 4 * hour);
});

test('a member scheduled only on day 2 of a split job sees it only on day 2 and gets 403 on day 1 writes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(D1, '10:00')) });
  const store = storage(t); store.put('jobs/split', split());
  const list = async (user, date) => (await get(on, user, `?date=${date}`)).body.jobs.map(job => job.id);
  assert.deepEqual([await list('Crew.Two', D1), await list('Crew.Two', D2), await list('Crew.Two', D3)], [[], ['split'], []]);
  assert.deepEqual([await list('Crew.One', D1), await list('Crew.One', D2), await list('Crew.One', D3)], [['split'], [], ['split']]);
  const detail = await get(on, 'Crew.Two', '?jobId=split');
  assert.equal(detail.status, 200, 'the job stays readable for review');
  assert.deepEqual([detail.body.job.visits.assignedToday, detail.body.job.visits.canEndDay, detail.body.job.visits.days.map(day => day.date)], [false, false, [D2]]);
  const commits = store.calls.commits;
  for (const data of [{ action: 'note', body: 'Synthetic early note' }, { action: 'status', status: 'dispatched' }, { action: 'checklist', itemId: 'departure-address', completed: false }, { action: 'end_day', notes: 'Synthetic day that is not mine.' }, { action: 'photo', category: 'progress', caption: '', dataUrl: picture }]) {
    const refused = await post(on, store, 'Crew.Two', data, 'split');
    assert.deepEqual([refused.status, refused.body.code], [403, 'FIELD_JOB_NOT_ASSIGNED_TODAY'], data.action);
  }
  assert.equal(store.calls.commits, commits); assert.equal(store.calls.generated, 0, 'no Drive file is allocated for a refused photo');
  assert.equal((await post(on, store, 'Crew.One', { action: 'note', body: 'Synthetic day one crew note' }, 'split')).status, 200);
  assert.equal((await post(on, store, 'ZacB', { action: 'note', body: 'Synthetic manager note on any day' }, 'split')).status, 200);
  t.mock.timers.setTime(Date.parse(at(D2, '10:00')));
  const own = { action: 'note', requestId: uuid(), body: 'Synthetic day two crew note' };
  assert.equal((await post(on, store, 'Crew.Two', own, 'split')).status, 200);
  assert.deepEqual([(await post(on, store, 'Crew.One', { action: 'note', body: 'Synthetic not my day' }, 'split')).body.code], ['FIELD_JOB_NOT_ASSIGNED_TODAY']);
  t.mock.timers.setTime(Date.parse(at(D3, '10:00')));
  const replay = await post(on, store, 'Crew.Two', own, 'split');
  assert.deepEqual([replay.status, replay.body.alreadyApplied], [200, true], 'a confirmed action replays after the day changes');
  assert.equal((await post(on, store, 'Crew.Two', { action: 'note', body: 'Synthetic day three note' }, 'split')).status, 403);
  assert.equal((await post(off, store, 'Crew.Two', { action: 'note', body: 'Synthetic flag-off note' }, 'split')).status, 200, 'with the flag off the job-level crew can write on any day');
  assert.deepEqual(await list('Crew.Two', D2), ['split']);
});

test('only a manager with a reason completes a multi-day job early; single-day and overrun jobs are unchanged', () => {
  const job = threeDay({ status: 'in_progress', pipelineStatus: 'in_progress', startedAt: at(D1, '08:00') }), input = { action: 'complete', notes: 'Synthetic early finish, all agreed work done.', hasIssues: false };
  assert.throws(() => fieldVisitCommand(job, crew, { requestId: uuid(), ...input }, at(D1, '15:00')), error => error.status === 409 && error.code === 'FIELD_COMPLETION_NOT_FINAL_DAY');
  for (const reason of [undefined, 'Too short', 7, 'x'.repeat(1001)]) assert.throws(() => fieldVisitCommand(job, boss, { requestId: uuid(), ...input, earlyCompletionReason: reason }, at(D1, '15:00')), error => error.status === 400 && error.code === 'FIELD_EARLY_COMPLETION_REASON_REQUIRED');
  const early = apply(job, boss, { ...input, earlyCompletionReason: '  Customer asked us to finish in one long day.  ' }, at(D1, '15:00'));
  assert.equal(early.status, 'completed');
  assert.deepEqual(early.fieldExecution.completion.earlyCompletion, { reason: 'Customer asked us to finish in one long day.', finalDay: D3, approvedBy: 'ZacB', approvedByName: 'Owner', at: at(D1, '15:00') });
  assert.match(early.__event.summary, /before the final scheduled day$/); assert.equal(early.__event.earlyCompletionReason, 'Customer asked us to finish in one long day.');
  assert.match(early.fieldCompletionSync.body, /Completed before the final scheduled day \(2026-09-24\) by Owner: Customer asked us to finish in one long day\.$/);
  assert.equal(early.fieldExecution.visits[D1].status, 'completed');
  const finalDay = apply(job, crew, { ...input, earlyCompletionReason: 'Ignored on the final day.' }, at(D3, '15:00'));
  assert.deepEqual([finalDay.status, finalDay.fieldExecution.completion.earlyCompletion, finalDay.__event.earlyCompletionReason], ['completed', undefined, undefined]);
  assert.equal(apply(job, crew, input, at(D4, '09:00')).status, 'completed', 'an overrun past the final day completes');
  const oneDay = threeDay({ date: D2, endDate: D2, time: '08:00', endTime: '12:00', status: 'in_progress', pipelineStatus: 'in_progress' });
  assert.equal(apply(oneDay, crew, input, at(D1, '15:00')).status, 'completed', 'a single-day job keeps completing on any day');
});

test('end_day needs notes and an active job; status starts and reopens the day’s visit', () => {
  const job = threeDay();
  assert.throws(() => fieldVisitCommand(job, crew, { requestId: uuid(), action: 'end_day', notes: 'Synthetic notes for a job not started.' }, at(D1, '09:00')), error => error.code === 'FIELD_VISIT_NOT_STARTED' && error.status === 409);
  let day = apply(job, crew, { action: 'status', status: 'dispatched' }, at(D1, '07:30'));
  assert.deepEqual(day.fieldExecution.visits, { [D1]: { status: 'in_progress', startedAt: at(D1, '07:30'), startedBy: 'Crew.One' } });
  assert.equal(day.__event.visitDate, D1);
  day = apply(day, crew, { action: 'status', status: 'arrived' }, at(D1, '08:00'));
  assert.equal(day.fieldExecution.visits[D1].startedAt, at(D1, '07:30'), 'later status actions keep the day’s start');
  for (const notes of [undefined, 42, 'too short', ' '.repeat(20), 'x'.repeat(4001)]) assert.throws(() => fieldVisitCommand(day, crew, { requestId: uuid(), action: 'end_day', notes }, at(D1, '12:00')), error => error.status === 400, String(notes));
  day = apply(day, crew, { action: 'end_day', notes: '  Synthetic crew waited on the customer all day.  ' }, at(D1, '16:00'));
  assert.deepEqual([fieldActivity(day), day.status, day.fieldExecution.activityReason, day.fieldExecution.visits[D1].notes], ['day_ended', 'arrived', 'Synthetic crew waited on the customer all day.', 'Synthetic crew waited on the customer all day.']);
  assert.deepEqual(fieldJobProjection(day).allowedStatuses, ['in_progress', 'waiting']);
  assert.equal(day.fieldExecution.jobTime.current, null); assert.equal(day.fieldExecution.jobTime.stoppedAt, at(D1, '16:00'));
  const reopened = apply(day, crew, { action: 'status', status: 'waiting', reason: 'Synthetic customer returned' }, at(D1, '16:30'));
  // Reopening moves the earlier end of day into the visit's closures instead of leaving it on the open visit.
  assert.deepEqual(reopened.fieldExecution.visits[D1], { status: 'in_progress', startedAt: at(D1, '07:30'), startedBy: 'Crew.One', reopenedAt: at(D1, '16:30'), reopenedBy: 'Crew.One',
    closures: [{ endedAt: at(D1, '16:00'), endedBy: 'Crew.One', endedByName: 'Crew One', notes: 'Synthetic crew waited on the customer all day.', requestId: day.__event.id }] });
  assert.deepEqual(fieldVisitProjection(reopened, { today: D1, viewer: 'Crew.One', assignedToday: true }).days[0], { date: D1, scheduled: true, status: 'in_progress', startedAt: at(D1, '07:30'), endedAt: null, endedBy: '', notes: '', endedLate: false, reopenedAt: at(D1, '16:30'),
    earlierEnds: [{ endedAt: at(D1, '16:00'), endedBy: 'Crew One', notes: 'Synthetic crew waited on the customer all day.' }] });
  const again = apply(reopened, crew, { action: 'end_day', notes: 'Synthetic second close after reopening.' }, at(D1, '17:00'));
  assert.deepEqual([again.fieldExecution.visits[D1].status, again.fieldExecution.visits[D1].notes, again.fieldExecution.visits[D1].closures.map(end => end.notes)], ['ended', 'Synthetic second close after reopening.', ['Synthetic crew waited on the customer all day.']], 'the second end of day keeps the first');
  let cycled = again;
  for (let round = 0; round < CLOSURE_LIMIT + 2; round++) {
    cycled = apply(cycled, crew, { action: 'status', status: 'waiting', reason: 'Synthetic customer returned again' }, at(D1, `17:${String(10 + round * 2).padStart(2, '0')}`));
    cycled = apply(cycled, crew, { action: 'end_day', notes: `Synthetic close number ${round + 3} of the day.` }, at(D1, `17:${String(11 + round * 2).padStart(2, '0')}`));
  }
  assert.deepEqual(cycled.fieldExecution.visits[D1].closures.map(end => end.notes), ['Synthetic close number 4 of the day.', 'Synthetic close number 5 of the day.', 'Synthetic close number 6 of the day.'], 'closures are bounded to the latest few');
  assert.equal(cycled.fieldExecution.visits[D1].notes, 'Synthetic close number 7 of the day.');
  assert.equal(fieldActivity({ status: 'scheduled', fieldExecution: { activity: 'day_ended' } }), 'scheduled', 'a stale day_ended is ignored once dispatch resets the job');
  const closed = { ...day, status: 'completed', pipelineStatus: 'completed' };
  assert.throws(() => fieldVisitCommand(closed, crew, { requestId: uuid(), action: 'end_day', notes: 'Synthetic closed job notes.' }, at(D2, '12:00')), error => error.code === 'FIELD_JOB_CLOSED');
  const untouched = apply(threeDay({ status: 'in_progress', pipelineStatus: 'in_progress', fieldExecution: { jobTime: { version: 99 } } }), crew, { action: 'end_day', notes: 'Synthetic unreadable clock is preserved.' }, at(D1, '12:00'));
  assert.deepEqual(untouched.fieldExecution.jobTime, { version: 99 }, 'an unreadable job timer is kept for review, not overwritten');
  assert.equal(untouched.__event.timeSegment.warning.includes('requires review'), true);
  const full = threeDay({ status: 'in_progress', pipelineStatus: 'in_progress', fieldExecution: { visits: Object.fromEntries(Array.from({ length: VISIT_LIMIT }, (_, index) => [`2026-0${1 + Math.floor(index / 28)}-${String(1 + index % 28).padStart(2, '0')}`, { status: 'ended' }])) } });
  assert.throws(() => fieldVisitCommand(full, crew, { requestId: uuid(), action: 'end_day', notes: 'Synthetic day beyond the visit limit.' }, at(D1, '12:00')), error => error.code === 'FIELD_VISIT_LIMIT');
  const started = apply(full, crew, { action: 'status', status: 'in_progress' }, at(D1, '12:00'));
  assert.deepEqual([started.pipelineStatus, D1 in started.fieldExecution.visits], ['in_progress', false], 'a status action still saves without a new visit day');
});

test('the visits block is an allowlist; crew on a split job see their own days plus recorded visits', () => {
  const job = split();
  job.fieldExecution.visits = { [D1]: { status: 'ended', startedAt: at(D1, '08:00'), startedBy: 'crew.one', endedAt: at(D1, '16:00'), endedBy: 'crew.one', endedByName: 'Crew One', notes: 'Synthetic handoff for day two.', requestId: 'receipt-id', payroll: 'secret-rate-42' }, 'not-a-day': { status: 'ended' }, [D4]: { status: 'bogus' }, [D2]: null };
  const two = fieldVisitProjection(job, { today: D1, viewer: 'Crew.Two', assignedToday: false });
  assert.deepEqual(two.days.map(day => [day.date, day.scheduled, day.status]), [[D1, false, 'ended'], [D2, true, 'not_started']]);
  // endedLate, reopenedAt and earlierEnds were added deliberately for late-synced and reopened visits.
  assert.deepEqual(Object.keys(two.days[0]), ['date', 'scheduled', 'status', 'startedAt', 'endedAt', 'endedBy', 'notes', 'endedLate', 'reopenedAt', 'earlierEnds']);
  assert.deepEqual([two.days[0].endedBy, two.days[0].notes], ['Crew One', 'Synthetic handoff for day two.']);
  for (const secret of ['secret-rate-42', 'receipt-id', 'not-a-day', 'bogus', D4]) assert.equal(JSON.stringify(two).includes(secret), false, secret);
  assert.deepEqual([two.assignedToday, two.canEndDay, two.multiDay, two.finalDay, two.completionOpen, two.earlyCompletionReasonRequired], [false, false, true, D3, false, false]);
  const manager = fieldVisitProjection(job, { today: D1, manager: true, viewer: 'ZacB' });
  assert.deepEqual([manager.days.map(day => day.date), manager.assignedToday, manager.earlyCompletionReasonRequired], [[D1, D2, D3], true, true]);
  const active = { ...job, status: 'in_progress', pipelineStatus: 'in_progress' };
  assert.equal(fieldVisitProjection(active, { today: D2, viewer: 'Crew.Two', assignedToday: true }).canEndDay, true);
  assert.equal(fieldVisitProjection(active, { today: D1, viewer: 'Crew.One', assignedToday: true }).canEndDay, false, 'today’s visit already ended');
  assert.equal(fieldVisitProjection({ ...active, status: 'completed', pipelineStatus: 'completed' }, { today: D2, manager: true }).canEndDay, false);
  assert.deepEqual([fieldVisitProjection(active, { today: D3, viewer: 'Crew.One', assignedToday: true }).completionOpen, fieldVisitProjection(threeDay({ endDate: D1 }), { today: D1, manager: true }).multiDay], [true, false]);
});

test('assignedOn uses each day’s segments with an exact username and matches the previous day-list filter', async () => {
  const access = user => createJobAssignmentAccess(off, { user, displayName: users[user]?.displayName || user });
  const legacy = threeDay({ id: 'legacy' }), segmented = split(), drifted = { ...split(), assignedCrew: ['crew.one'] }, broken = { ...split(), assignmentSegments: [{ id: 'bad id!', assignedCrew: ['crew.two'] }] };
  const aliased = { ...split(), assignedCrew: ['Crew Two'], assignmentSegments: [part('a', D1, ['Crew Two'])] };
  for (const user of ['Crew.One', 'Crew.Two', 'ZacB']) for (const job of [legacy, segmented, drifted, broken, aliased]) for (const [start, end] of [[D1, D1], [D2, D2], [D3, D3], [D1, D3], [D4, D4]]) {
    const before = await access(user).assigned(job) && fieldViewerWorksOn(job, user, start, end);
    // The listing loads only jobs scheduled in the range, so compare where the job occupies a listed day.
    if (!fieldJobDays(job).some(day => day >= start && day <= end)) continue;
    assert.equal(await assignedDuring(job, start, end, access(user)), before, `${user} ${job.id} ${job.assignmentSegments?.[0]?.id} ${start}..${end}`);
  }
  assert.deepEqual(await Promise.all([D1, D2, D3].map(day => assignedOn(segmented, day, access('Crew.Two')))), [false, true, false]);
  assert.equal(await assignedOn(legacy, '2027-01-01', access('Crew.One')), true, 'legacy jobs are never locked by the calendar');
  assert.equal(await assignedOn(drifted, D2, access('Crew.Two')), false, 'the job-level assignment is still required');
  assert.equal(await assignedOn(aliased, D1, access('Crew.Two')), false, 'a segment never matches a display-name alias');
  assert.equal(await assignedOn(segmented, 'not-a-day', access('Crew.One')), false);
  assert.equal(access('Crew.One').exactly('CREW.ONE '), true); assert.equal(access('Crew.One').exactly('Crew One'), false); assert.equal(createJobAssignmentAccess(off, {}).exactly(''), false);
});

test('with the flag off the field workflow is unchanged: no visits, no end_day and completion on any day', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(D1, '15:00')) });
  const store = storage(t); store.put('jobs/job-1', threeDay({ status: 'in_progress', pipelineStatus: 'in_progress', startedAt: at(D1, '08:00') }));
  const detail = await get(off, 'Crew.One', '?jobId=job-1');
  assert.equal('visits' in detail.body.job, false);
  assert.equal((await get(off, 'Crew.One', `?date=${D1}`)).body.jobs.some(job => 'visits' in job), false);
  const commits = store.calls.commits, refused = await post(off, store, 'Crew.One', { action: 'end_day', notes: 'Synthetic end of day while the flag is off.' });
  assert.deepEqual([refused.status, refused.body.code, store.calls.commits], [400, 'FIELD_REQUEST_INVALID', commits]);
  const done = await post(off, store, 'Crew.One', { action: 'complete', notes: 'Synthetic completion on day one while the flag is off.', hasIssues: false });
  assert.deepEqual([done.status, done.body.job.status], [200, 'completed']);
  assert.equal(store.get('jobs/job-1').fieldExecution.visits, undefined, 'nothing new is written to the job');
});

test('end_day is queued through the F-PWA outbox and overlays today’s visit until it syncs', async () => {
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, URL, Error, TypeError, Map, Set, encodeURIComponent, indexedDB: fakeIndexedDB() });
  context.self = context; vm.runInContext(readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8'), context);
  const api = context.EGCFieldOutbox, plain = value => JSON.parse(JSON.stringify(value));
  assert.equal(api.QUEUEABLE.includes('end_day'), true);
  const item = (action, extra) => { const requestId = uuid(); return { requestId, kind: 'field', user: 'Crew.One', jobId: 'job-1', payload: { action, ...extra, jobId: 'job-1', requestId, expectedRevision: 'seen', expectedUser: 'Crew.One' } }; };
  const box = api.create({ now: () => new Date(at(D1, '16:00')) }), sent = [];
  const queued = [item('status', { status: 'in_progress' }), item('end_day', { notes: 'Synthetic offline end of day.' })];
  for (const row of queued) await box.enqueue(row);
  const wire = { session: async () => ({ ok: true, user: 'Crew.One' }), revision: async () => `rev-${sent.length + 1}`, field: async input => { sent.push(input); return { ok: true, alreadyApplied: false, job: { id: 'job-1' } }; } };
  const result = await box.flush({ user: 'Crew.One', transport: wire });
  assert.deepEqual([result.applied.length, sent.map(input => input.action), sent.map(input => input.requestId), sent.map(input => input.expectedRevision)], [2, ['status', 'end_day'], queued.map(row => row.requestId), ['rev-1', 'rev-2']]);
  const job = { id: 'job-1', status: 'in_progress', fieldStatus: 'in_progress', allowedStatuses: ['paused', 'waiting', 'delayed', 'in_progress'], checklist: [], materials: [], visits: { today: D2, finalDay: D3, multiDay: true, assignedToday: true, canEndDay: true, completionOpen: false, days: [{ date: D1, scheduled: true, status: 'ended', notes: 'Synthetic day one.' }, { date: D2, scheduled: true, status: 'in_progress', startedAt: at(D2, '08:00') }] } };
  const row = (state, notes = 'Synthetic queued end of day.') => ({ kind: 'field', jobId: 'job-1', state, queuedAt: at(D2, '16:00'), payload: { action: 'end_day', notes } });
  const view = plain(api.projectJob(job, [row('queued')]));
  assert.deepEqual([view.fieldStatus, view.statusQueued, view.allowedStatuses, view.visits.canEndDay], ['day_ended', true, ['waiting', 'delayed', 'in_progress'], false]);
  assert.deepEqual(view.visits.days[1], { date: D2, scheduled: true, status: 'ended', startedAt: at(D2, '08:00'), endedAt: at(D2, '16:00'), endedBy: '', notes: 'Synthetic queued end of day.', queued: true });
  assert.equal(job.visits.days[1].status, 'in_progress', 'the confirmed job is not mutated');
  assert.deepEqual(plain(api.projectJob(job, [row('error')])).visits.days[1].status, 'in_progress', 'a refused end of day is not shown as done');
  const unscheduled = plain(api.projectJob({ ...job, visits: { ...job.visits, today: D4 } }, [row('queued')]));
  assert.deepEqual(unscheduled.visits.days.map(day => [day.date, day.status]), [[D1, 'ended'], [D2, 'in_progress'], [D4, 'ended']]);
  // A watched first attempt refused because the day already ended is dropped and shown, like other refusals.
  const direct = item('end_day', { notes: 'Synthetic duplicate end of day.' }), refusal = api.create({ now: () => new Date(at(D2, '16:05')) });
  await refusal.enqueue(direct);
  const stopped = await refusal.flush({ user: 'Crew.One', direct: direct.requestId, transport: { ...wire, field: async () => { throw Object.assign(new Error('Today’s visit has already ended.'), { status: 409, code: 'FIELD_VISIT_ENDED' }); } } });
  assert.deepEqual([stopped.stopped.reason, stopped.stopped.discarded, stopped.remaining], ['rejected', true, 0]);
});

test('an end of day saved offline before midnight and synced after it closes that day, never the new one', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(D1, '07:30')) });
  const store = storage(t); store.put('jobs/job-1', threeDay());
  const step = async (time, data, user = 'Crew.One') => { t.mock.timers.setTime(Date.parse(time)); const result = await post(on, store, user, data); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  await step(at(D1, '07:30'), { action: 'status', status: 'dispatched' });
  await step(at(D1, '08:00'), { action: 'status', status: 'arrived' });
  await step(at(D1, '08:15'), { action: 'status', status: 'in_progress' });
  // Saved on an iPhone at 16:00 on day one (no Background Sync); the page is next opened at 07:30 on day two.
  const queued = { action: 'end_day', requestId: uuid(), notes: 'Synthetic day one: north wall cleared, shelving remains.', visitDate: D1 };
  let body = await step(at(D2, '07:30'), queued);
  const saved = store.get('jobs/job-1'), visits = saved.fieldExecution.visits;
  assert.deepEqual(Object.keys(visits), [D1], 'day two is untouched');
  assert.deepEqual([visits[D1].status, visits[D1].notes, visits[D1].endedLate, visits[D1].endedAt, visits[D1].startedAt], ['ended', queued.notes, true, at(D2, '07:30'), at(D1, '07:30')]);
  assert.deepEqual([saved.fieldExecution.activity, saved.fieldExecution.jobTime.current, saved.fieldExecution.jobTime.needsReview], ['day_ended', null, true], 'the clock stops and is flagged for review');
  assert.deepEqual([body.job.jobTime.needsReview, body.job.jobTime.runningKind, body.job.fieldStatus], [true, null, 'day_ended']);
  assert.deepEqual(body.job.visits.days.map(day => [day.date, day.status, day.endedLate]), [[D1, 'ended', true], [D2, 'not_started', false], [D3, 'not_started', false]]);
  assert.deepEqual([body.job.visits.today, body.job.visits.canEndDay], [D2, true]);
  const event = store.get(`jobs/job-1/fieldEvents/${queued.requestId}`);
  assert.deepEqual([event.visitDate, event.summary, event.timeSegment.kind, event.timeSegment.durationMs], [D1, `Day ended (${D1}, synced late)`, 'work', 23.25 * hour]);
  assert.match(event.timeSegment.warning, /synced after it/);
  const replay = await step(at(D2, '07:35'), queued);
  assert.equal(replay.alreadyApplied, true);
  // Day two starts cleanly and can be ended on its own.
  body = await step(at(D2, '08:00'), { action: 'status', status: 'in_progress' });
  assert.deepEqual([body.job.visits.days[1].status, body.job.visits.days[1].startedAt], ['in_progress', at(D2, '08:00')]);
  body = await step(at(D2, '16:00'), { action: 'end_day', notes: 'Synthetic day two: shelving out, floor remains.', visitDate: D2 });
  assert.deepEqual(body.job.visits.days.slice(0, 2).map(day => [day.date, day.status, day.notes, day.endedLate]), [[D1, 'ended', queued.notes, true], [D2, 'ended', 'Synthetic day two: shelving out, floor remains.', false]]);
  // Refusals: the day already ended, a day older than yesterday, a future day, and a malformed day.
  const commits = store.calls.commits;
  for (const [time, visitDate, status, code] of [[at(D3, '07:00'), D2, 409, 'FIELD_VISIT_ENDED'], [at(D4, '07:00'), D2, 409, 'FIELD_VISIT_DAY_CHANGED'], [at(D2, '17:00'), D3, 400, 'FIELD_REQUEST_INVALID'], [at(D2, '17:00'), '2026-02-30', 400, 'FIELD_REQUEST_INVALID']]) {
    t.mock.timers.setTime(Date.parse(time));
    const refused = await post(on, store, 'Crew.One', { action: 'end_day', notes: 'Synthetic refused end of day notes.', visitDate });
    assert.deepEqual([refused.status, refused.body.code], [status, code], `${visitDate} at ${time}`);
  }
  assert.equal(store.calls.commits, commits, 'refusals write nothing');
});

test('a split-job member’s late end of day closes only their day and leaves the next crew’s visit and clock alone', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at(D1, '07:30')) });
  const store = storage(t); store.put('jobs/split', split());
  const step = async (time, data, user) => { t.mock.timers.setTime(Date.parse(time)); const result = await post(on, store, user, data, 'split'); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  await step(at(D1, '07:30'), { action: 'status', status: 'dispatched' }, 'Crew.One');
  await step(at(D1, '08:00'), { action: 'status', status: 'arrived' }, 'Crew.One');
  await step(at(D1, '08:15'), { action: 'status', status: 'in_progress' }, 'Crew.One');
  // Day two's crew starts before day one's queued end of day syncs; the clock
  // was never stopped, so the overnight time is flagged when day two starts.
  let body = await step(at(D2, '07:00'), { action: 'status', status: 'in_progress' }, 'Crew.Two');
  assert.deepEqual([body.job.jobTime.needsReview, body.job.jobTime.runningKind], [true, 'work']);
  const started = store.get('jobs/split').fieldExecution;
  assert.match(store.get(`jobs/split/fieldEvents/${[...store.documents.keys()].filter(key => key.startsWith('jobs/split/fieldEvents/')).map(key => store.get(key)).find(event => event.actorId === 'Crew.Two').id}`).timeSegment.warning, /past Denver midnight/);
  // Day one's member is not on day two, yet their end of day for day one is accepted.
  const refusedToday = await post(on, store, 'Crew.One', { action: 'end_day', notes: 'Synthetic end of a day that is not mine.', visitDate: D2 }, 'split');
  assert.deepEqual([refusedToday.status, refusedToday.body.code], [403, 'FIELD_JOB_NOT_ASSIGNED_TODAY']);
  body = await step(at(D2, '07:30'), { action: 'end_day', notes: 'Synthetic day one handoff: shelving remains.', visitDate: D1 }, 'Crew.One');
  const saved = store.get('jobs/split').fieldExecution;
  assert.deepEqual([saved.visits[D1].status, saved.visits[D1].endedLate, saved.visits[D1].notes], ['ended', true, 'Synthetic day one handoff: shelving remains.']);
  assert.deepEqual(saved.visits[D2], started.visits[D2], 'day two’s visit is untouched');
  assert.deepEqual(saved.jobTime, started.jobTime, 'day two’s running clock is untouched');
  assert.deepEqual([saved.activity, store.get('jobs/split').status], ['in_progress', 'in_progress']);
  assert.equal(body.job.visits.assignedToday, false);
  const other = await post(on, store, 'Crew.Two', { action: 'end_day', notes: 'Synthetic end of a day that was not mine.', visitDate: D1 }, 'split');
  assert.deepEqual([other.status, other.body.code], [403, 'FIELD_JOB_NOT_ASSIGNED_TODAY'], 'day two’s crew cannot end day one');
});

test('the overnight review flag covers a forgotten end of day on multi-day jobs only', () => {
  const running = apply(threeDay(), crew, { action: 'status', status: 'dispatched' }, at(D1, '07:30'));
  const working = apply(apply(running, crew, { action: 'status', status: 'arrived' }, at(D1, '08:00')), crew, { action: 'status', status: 'in_progress' }, at(D1, '08:15'));
  const sameDay = apply(working, crew, { action: 'status', status: 'paused', reason: 'Synthetic lunch' }, at(D1, '12:00'));
  assert.equal(sameDay.fieldExecution.jobTime.needsReview, undefined, 'a same-day change is not flagged');
  const nextDay = apply(working, crew, { action: 'status', status: 'paused', reason: 'Synthetic dump run' }, at(D2, '09:00'));
  assert.deepEqual([nextDay.fieldExecution.jobTime.needsReview, nextDay.fieldExecution.visits[D2].status, nextDay.__event.timeSegment.durationMs], [true, 'in_progress', 24.75 * hour]);
  assert.match(nextDay.__event.timeSegment.warning, /past Denver midnight/);
  const ended = apply(working, crew, { action: 'end_day', notes: 'Synthetic end the next morning.' }, at(D2, '07:00'));
  assert.deepEqual([ended.fieldExecution.jobTime.needsReview, Object.keys(ended.fieldExecution.visits)], [true, [D1, D2]], 'ending today after a forgotten day is flagged too');
  const completed = apply(working, crew, { action: 'complete', notes: 'Synthetic completion after a forgotten end of day.', hasIssues: false }, at(D3, '10:00'));
  assert.equal(completed.fieldExecution.jobTime.needsReview, true);
  const oneDay = threeDay({ endDate: D1, status: 'in_progress', pipelineStatus: 'in_progress', fieldExecution: { jobTime: { version: 1, trackingStartedAt: at(D1, '08:00'), partialHistory: false, totalsMs: { work: 0, paused: 0, waiting: 0, delayed: 0, travel: 0, arrival: 0 }, current: { kind: 'work', startedAt: at(D1, '20:00'), actorId: 'Crew.One', requestId: uuid() } } } });
  assert.equal(apply(oneDay, crew, { action: 'status', status: 'paused', reason: 'Synthetic late finish' }, at(D2, '01:00')).fieldExecution.jobTime.needsReview, undefined, 'a single-day job is unchanged');
});

test('the visit limit hides the end-of-day form and a direct refusal is shown, not left blocking the job', async () => {
  const full = threeDay({ status: 'in_progress', pipelineStatus: 'in_progress', fieldExecution: { visits: Object.fromEntries(Array.from({ length: VISIT_LIMIT }, (_, index) => [`2026-0${1 + Math.floor(index / 28)}-${String(1 + index % 28).padStart(2, '0')}`, { status: 'ended' }])) } });
  assert.equal(fieldVisitProjection(full, { today: D1, viewer: 'Crew.One', assignedToday: true }).canEndDay, false);
  const recorded = { ...full, fieldExecution: { ...full.fieldExecution, visits: { ...full.fieldExecution.visits, [D1]: { status: 'in_progress' } } } };
  assert.equal(fieldVisitProjection(recorded, { today: D1, viewer: 'Crew.One', assignedToday: true }).canEndDay, true, 'a day already recorded can still end');
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, URL, Error, TypeError, Map, Set, encodeURIComponent, indexedDB: fakeIndexedDB() });
  context.self = context; vm.runInContext(readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8'), context);
  const box = context.EGCFieldOutbox.create({ now: () => new Date(at(D1, '16:00')) }), requestId = uuid();
  await box.enqueue({ requestId, kind: 'field', user: 'Crew.One', jobId: 'job-1', payload: { action: 'end_day', notes: 'Synthetic day over the limit.', visitDate: D1, jobId: 'job-1', requestId, expectedRevision: 'seen', expectedUser: 'Crew.One' } });
  const result = await box.flush({ user: 'Crew.One', direct: requestId, transport: { session: async () => ({ ok: true, user: 'Crew.One' }), revision: async () => 'rev', field: async () => { throw Object.assign(new Error('This job already has 62 recorded visit days.'), { status: 409, code: 'FIELD_VISIT_LIMIT' }); } } });
  assert.deepEqual([result.stopped.reason, result.stopped.discarded, result.remaining], ['rejected', true, 0]);
});

test('a queued end of day overlays the day it was saved for, even after the page moves to the next day', () => {
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, URL, Error, TypeError, Map, Set, encodeURIComponent, indexedDB: fakeIndexedDB() });
  context.self = context; vm.runInContext(readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8'), context);
  const api = context.EGCFieldOutbox, plain = value => JSON.parse(JSON.stringify(value));
  const job = days => ({ id: 'job-1', status: 'in_progress', fieldStatus: 'in_progress', allowedStatuses: ['paused', 'waiting', 'delayed', 'in_progress'], checklist: [], materials: [], visits: { today: D2, finalDay: D3, multiDay: true, assignedToday: true, canEndDay: true, completionOpen: false, days } });
  const row = { kind: 'field', jobId: 'job-1', state: 'queued', queuedAt: at(D1, '16:00'), payload: { action: 'end_day', notes: 'Synthetic day one saved offline.', visitDate: D1 } };
  const waiting = plain(api.projectJob(job([{ date: D1, scheduled: true, status: 'in_progress' }, { date: D2, scheduled: true, status: 'not_started' }]), [row]));
  assert.deepEqual(waiting.visits.days.map(day => [day.date, day.status, day.queued === true]), [[D1, 'ended', true], [D2, 'not_started', false]]);
  assert.deepEqual([waiting.fieldStatus, waiting.visits.canEndDay], ['day_ended', false], 'with day two not started the job’s day ends too');
  const underway = plain(api.projectJob(job([{ date: D1, scheduled: true, status: 'in_progress' }, { date: D2, scheduled: true, status: 'in_progress' }]), [row]));
  assert.deepEqual([underway.visits.days.map(day => [day.date, day.status]), underway.fieldStatus, underway.allowedStatuses.includes('paused')], [[[D1, 'ended'], [D2, 'in_progress']], 'in_progress', true], 'day two’s work stays as it is');
});

test('job costs follow the per-day lock: crew record only on a day they work a split job; managers and the flag off are unchanged', async t => {
  const store = storage(t); store.put('jobs/split', split());
  const costs = (env, time) => { const handlers = fieldExpenseHandlers({ now: () => new Date(time) }); return {
    get: user => handlers.get({ env, request: new Request('https://easygaragecleaning.com/api/field-expenses?jobId=split', { headers: { Cookie: cookies.get(user) } }) }).then(response => response.json()),
    post: (user, input) => handlers.post({ env, request: new Request('https://easygaragecleaning.com/api/field-expenses', { method: 'POST', headers: { Cookie: cookies.get(user), Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: 'split', requestId: uuid(), kind: 'dump_fee', amountCents: 4200, vendor: 'Synthetic Landfill', note: '', ...input }) }) }).then(async response => ({ status: response.status, body: await response.json() })),
  }; };
  const withCosts = { ...on, FIELD_EXPENSES_ENABLED: 'true' }, dayOne = costs(withCosts, at(D1, '10:00')), dayTwo = costs(withCosts, at(D2, '10:00'));
  const saved = () => [...store.documents.keys()].filter(key => key.startsWith('jobs/split/fieldExpenses/')).length;
  const listing = await dayOne.get('Crew.Two');
  assert.deepEqual([listing.ok, listing.canRecord, listing.notScheduledToday], [true, false, true]);
  const refused = await dayOne.post('Crew.Two', {});
  assert.deepEqual([refused.status, refused.body.code, saved()], [403, 'FIELD_JOB_NOT_ASSIGNED_TODAY', 0]);
  assert.deepEqual([(await dayOne.get('Crew.One')).canRecord, (await dayOne.get('Crew.One')).notScheduledToday], [true, undefined]);
  assert.equal((await dayOne.post('Crew.One', {})).status, 200);
  assert.equal((await dayTwo.post('Crew.Two', {})).status, 200);
  assert.equal((await dayOne.post('ZacB', {})).status, 200, 'managers record on any day');
  assert.equal((await costs({ ...off, FIELD_EXPENSES_ENABLED: 'true' }, at(D1, '10:00')).post('Crew.Two', {})).status, 200, 'with the flag off the job-level crew records on any day');
  assert.equal(saved(), 4);
  const source = readFileSync(new URL('../crew/field-expenses.js', import.meta.url), 'utf8');
  assert.match(source, /S\.data\.notScheduledToday \? 'You are not scheduled on this job today/);
});
