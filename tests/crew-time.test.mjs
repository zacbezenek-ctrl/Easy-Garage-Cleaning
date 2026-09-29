process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { vaultFirestore, staffEnv, cookieFor, jsonRequest, ROOT } from './helpers/vault-fixture.mjs';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { readOne, writeOne } from '../functions/_lib/employee-vault.js';
import { activeTimecard, authorizeTimecard, clockInWithoutFix } from '../functions/_lib/employee-timecards.js';
import { applyCrewJobMove, applyEmployeeJobAction, crewJobMoveState, employeeJobTime, jobStatusMovesTime, jobTimeView, ownJobTimeProjection } from '../functions/_lib/employee-job-time.js';
import { computeTimesheetWeek } from '../functions/_lib/timesheet-week.js';
import { jobTimeText, payrollCsv } from '../functions/_lib/payroll-export.js';
import { ptoOffOn } from '../functions/_lib/pto-pay.js';
import * as employeeHub from '../functions/api/employee-hub.js';

// CREW-TIME: the job status moves the worker's time, labels say where the time went, and location is taken once at
// clock-in. Every clock here is injected.
const START = '2026-09-22T14:00:00.000Z';
const at = seconds => new Date(Date.parse(START) + seconds * 1000).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
const outboxSource = readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8');
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const crew = { user: 'Crew.One', displayName: 'Crew One', role: 'crew', payType: 'hourly' };
const point = { lat: 40.58, lng: -105.08, accuracy: 5 };

function outboxApi() {
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, URL, Error, TypeError, Map, Set, encodeURIComponent });
  context.self = context;
  vm.runInContext(outboxSource, context);
  return context.EGCFieldOutbox;
}

// The server side the crew app talks to: one employee's timecards through the real timecard rules, a job status, and a
// clock the test moves.
function fieldServer({ env = { EGC_JOB_STATUS_MOVES_TIME: 'true' } } = {}) {
  const cards = new Map(), calls = []; let now = Date.parse(START);
  const time = () => new Date(now).toISOString();
  const active = () => [...cards.values()].find(activeTimecard) || null;
  const transport = {
    session: async () => ({ ok: true, user: crew.user }),
    revision: async jobId => { calls.push(['revision', jobId]); return 'rev-1'; },
    field: async input => { calls.push(['field', input.action, input.status || '']); return { ok: true, alreadyApplied: false, job: { id: input.jobId } }; },
    shift: async () => ({ ok: true, user: crew.user, entry: ownJobTimeProjection(active(), time()) }),
    employee: async body => {
      calls.push(['employee', body.data.jobAction?.kind || body.data.crewJobAction?.kind || Object.keys(body.data).sort().join('+')]);
      if (body.data.crewJobAction) return { ok: true, jobId: body.data.crewJobAction.jobId, moved: [{ employee: 'Crew.Two', name: 'Crew Two', alreadyApplied: false }], skipped: [] };
      const next = authorizeTimecard({ session: crew, manager: false, id: body.id, incoming: body.data, existing: cards.get(body.id) || null, hourlyRate: 20, now: time(), env });
      cards.set(body.id, next); return { ok: true, record: next };
    },
  };
  return { cards, calls, transport, time, advance: seconds => { now += seconds * 1000; } };
}

// What crew/job.js queues, built the way it builds it: a status (the job's lane) and the time it moves (the clock lane).
const statusItem = status => { const requestId = uuid(); return { requestId, kind: 'field', user: crew.user, jobId: 'job-a', payload: { action: 'status', status, jobId: 'job-a', requestId, expectedRevision: 'rev-1', expectedUser: crew.user } }; };
const timeItem = (shift, move, capturedAt) => { const requestId = uuid(); return { requestId, kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'job_time', source: 'status', entryId: shift.id, deviceCapturedAt: capturedAt, jobAction: { requestId, expectedSegmentId: move.expectedSegmentId, jobId: move.jobId, kind: move.kind } } }; };
const crewItem = capturedAt => { const requestId = uuid(); return { requestId, kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'crew_time', entryId: '', deviceCapturedAt: capturedAt, jobAction: { requestId, jobId: 'job-a', kind: 'work' } } }; };

test('the flag readers are off unless the owner sets exactly true', () => {
  for (const read of [[jobStatusMovesTime, 'EGC_JOB_STATUS_MOVES_TIME'], [clockInWithoutFix, 'EGC_CLOCK_IN_WITHOUT_FIX']]) {
    for (const value of ['true', 'TRUE', ' true ']) assert.equal(read[0]({ [read[1]]: value }), true, `${read[1]}=${value}`);
    for (const value of [undefined, '', 'false', '1', 'yes', 'on']) assert.equal(read[0]({ [read[1]]: value }), false, `${read[1]}=${value}`);
    assert.equal(read[0](undefined), false);
  }
});

test('statusTime: en route is travel, arrived and working are work on this job, pause/wait/delay keep the time, completing ends only this job’s time', () => {
  const Outbox = outboxApi(), shift = (kind, jobId = '') => ({ id: 'time-1', currentSegmentId: 'segment-now', current: { id: 'segment-now', kind, jobId }, summary: { needsReview: false } });
  const move = (input, current) => plain(Outbox.statusTime(input, current, 'job-a'));
  assert.deepEqual(move({ action: 'status', status: 'dispatched' }, shift('general')), { kind: 'travel', jobId: 'job-a', expectedSegmentId: 'segment-now' });
  assert.deepEqual(move({ action: 'status', status: 'arrived' }, shift('travel', 'job-a')), { kind: 'work', jobId: 'job-a', expectedSegmentId: 'segment-now' });
  assert.deepEqual(move({ action: 'status', status: 'in_progress' }, shift('work', 'job-b')), { kind: 'work', jobId: 'job-a', expectedSegmentId: 'segment-now' }, 'work on another job moves here');
  assert.equal(move({ action: 'status', status: 'in_progress' }, shift('work', 'job-a')), null, 'already working here');
  assert.equal(move({ action: 'status', status: 'dispatched' }, shift('travel', 'job-a')), null, 'already travelling here');
  for (const status of ['paused', 'waiting', 'delayed']) assert.equal(move({ action: 'status', status }, shift('work', 'job-a')), null, `${status} keeps work`);
  assert.deepEqual(move({ action: 'complete' }, shift('work', 'job-a')), { kind: 'general', jobId: '', expectedSegmentId: 'segment-now' });
  assert.equal(move({ action: 'complete' }, shift('work', 'job-b')), null, 'completing this job leaves time on another job alone');
  assert.equal(move({ action: 'complete' }, shift('general')), null);
  assert.equal(move({ action: 'status', status: 'arrived' }, null), null, 'not clocked in');
  assert.equal(move({ action: 'status', status: 'arrived' }, { ...shift('general'), summary: { needsReview: true } }), null, 'segments that need review do not move');
  assert.equal(move({ action: 'note', body: 'x' }, shift('general')), null);
});

test('CD-01: the probe-day flow (Start my travel time, en route, arrived, start work, complete) records travel then work with the right seconds', async () => {
  const Outbox = outboxApi(), server = fieldServer(), box = Outbox.create({ store: Outbox.memoryStore(), now: () => new Date(server.time()) });
  const shift = async () => Outbox.projectShift((await server.transport.shift()).entry, (await box.items(crew.user)).filter(item => item.kind === 'clock'));
  const sync = () => box.flush({ user: crew.user, transport: server.transport });
  // As crew/job.js does: the status first, then (EGC_JOB_STATUS_MOVES_TIME) the time it moves, in one ordered outbox.
  const setStatus = async (input, asked = true) => {
    const current = await shift(), move = Outbox.statusTime(input, current, 'job-a');
    if (input.action === 'status') await box.enqueue(statusItem(input.status));
    if (move && asked) await box.enqueue(timeItem(current, move, server.time()));
    return (await sync()).stopped;
  };
  await box.enqueue({ requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_in', entryId: 'time-crew.one-1', deviceCapturedAt: server.time(), lastLocation: point } });
  assert.equal((await sync()).stopped, null);
  server.advance(60);
  const manual = await shift();
  await box.enqueue(timeItem(manual, { kind: 'travel', jobId: 'job-a', expectedSegmentId: manual.currentSegmentId }, server.time()));
  assert.equal((await sync()).stopped, null, 'Start my travel time');
  server.advance(30); assert.equal(await setStatus({ action: 'status', status: 'dispatched' }), null, 'Mark en route keeps the travel already running');
  server.advance(1560); assert.equal(await setStatus({ action: 'status', status: 'arrived' }), null, 'Mark arrived starts work');
  server.advance(60); assert.equal(await setStatus({ action: 'status', status: 'in_progress' }), null, 'Start work keeps the work running');
  server.advance(7200); assert.equal(await setStatus({ action: 'complete' }), null, 'completing (OK, the default) ends the job time');
  server.advance(300);
  await box.enqueue({ requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_out', entryId: 'time-crew.one-1', deviceCapturedAt: server.time() } });
  assert.equal((await sync()).stopped, null);
  const card = server.cards.get('time-crew.one-1');
  assert.deepEqual(card.jobTracking.segments.map(segment => [segment.kind, segment.jobId, segment.startedAt]), [['general', '', at(0)], ['travel', 'job-a', at(60)], ['work', 'job-a', at(1650)], ['general', '', at(8910)]]);
  const summary = employeeJobTime(card, at(99999));
  assert.deepEqual(summary.jobs.map(row => [row.jobId, row.workMs / 1000, row.travelMs / 1000]), [['job-a', 7260, 1590]]);
  assert.deepEqual([summary.generalMs / 1000, summary.untrackedMs, summary.needsReview], [360, 0, false]);
  assert.equal(card.hours, 2.558, 'the shift is 9210 seconds');
  assert.deepEqual(server.calls.filter(([kind]) => kind !== 'revision').map(row => row.slice(1).join(' ').trim()), ['deviceCapturedAt+lastLocation+locationStatus+locationTracking', 'travel', 'status dispatched', 'status arrived', 'work', 'status in_progress', 'general', 'clockOutAt+deviceCapturedAt+status']);
  // The flag off, crew/job.js queues no time move: the old flow left the time where the buttons put it.
  assert.equal(jobStatusMovesTime({}), false);
});

test('offline, the status, the time it moves and a lead’s crew move keep their order; a refused crew move never holds the lead’s own clock-out', async () => {
  const Outbox = outboxApi(), server = fieldServer(), box = Outbox.create({ store: Outbox.memoryStore(), now: () => new Date(server.time()) });
  await box.enqueue({ requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_in', entryId: 'time-crew.one-1', deviceCapturedAt: server.time(), lastLocation: point } });
  await box.flush({ user: crew.user, transport: server.transport });
  server.calls.length = 0;
  // No signal: Mark arrived, its work move and the crew move are saved on the phone, in that order.
  const current = Outbox.projectShift((await server.transport.shift()).entry, []), move = Outbox.statusTime({ action: 'status', status: 'arrived' }, current, 'job-a');
  const status = statusItem('arrived'), work = timeItem(current, move, server.time()), mates = crewItem(server.time());
  for (const item of [status, work, mates]) await box.enqueue(item);
  assert.deepEqual(plain(Outbox.projectShift(current, (await box.items(crew.user)).filter(item => item.kind === 'clock')).current), { id: work.requestId, kind: 'work', jobId: 'job-a', jobLabel: '', startedAt: server.time() }, 'the queued work shows at once; the crew move does not change the lead’s own shift');
  const replies = []; const recording = { ...server.transport, employee: async body => { replies.push(body); return server.transport.employee(body); } };
  const result = await box.flush({ user: crew.user, transport: recording });
  assert.deepEqual(plain(result.applied.map(entry => entry.item.requestId)), [status.requestId, work.requestId, mates.requestId]);
  assert.deepEqual(plain(server.calls.map(row => row.slice(0, 2))), [['revision', 'job-a'], ['field', 'status'], ['employee', 'work'], ['employee', 'work']]);
  assert.deepEqual(plain(replies.at(-1)), { collection: 'timeEntries', id: 'job-a', expectedUser: crew.user, data: { crewJobAction: { requestId: mates.requestId, jobId: 'job-a', kind: 'work', deviceCapturedAt: server.time() } } }, 'the crew move names the lead who saved it');
  // A crew move the server refuses waits for review in its own lane; the lead's clock-out behind it still goes.
  const refused = crewItem(server.time()), out = { requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_out', entryId: 'time-crew.one-1', deviceCapturedAt: server.time() } };
  await box.enqueue(refused); await box.enqueue(out);
  const refusing = { ...server.transport, employee: async body => body.data.crewJobAction ? Promise.reject(Object.assign(new Error('Only this job’s crew lead or a manager can move crew-mates’ time.'), { status: 403, code: 'EMPLOYEE_TIMECARD_INVALID' })) : server.transport.employee(body) };
  const second = await box.flush({ user: crew.user, transport: refusing });
  assert.equal(second.stopped.item.requestId, refused.requestId); assert.equal(second.stopped.reason, 'rejected');
  assert.deepEqual(plain(second.applied.map(entry => entry.item.requestId)), [], 'the refusal is reported first');
  const third = await box.flush({ user: crew.user, transport: refusing });
  assert.deepEqual(plain(third.applied.map(entry => entry.item.requestId)), [out.requestId], 'the clock-out was not held behind the refused crew move');
  assert.equal(server.cards.get('time-crew.one-1').status, 'submitted');
  assert.deepEqual(plain((await box.items(crew.user)).map(item => [item.requestId, item.state])), [[refused.requestId, 'error']]);
});

test('the crew-app clock-in sends its one position as job_page_single_fix, or none (flagged) when the phone found none', async () => {
  const Outbox = outboxApi(), sent = [], box = Outbox.create({ store: Outbox.memoryStore(), now: () => new Date(START) });
  const transport = { session: async () => ({ ok: true, user: crew.user }), employee: async body => { sent.push(body); return { ok: true }; } };
  await box.enqueue({ requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_in', entryId: 'time-1', deviceCapturedAt: START, lastLocation: point } });
  await box.enqueue({ requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_in', entryId: 'time-2', deviceCapturedAt: START } });
  assert.deepEqual(plain(Outbox.projectShift(null, (await box.items(crew.user)).slice(1)).clockInLocation), 'missing');
  await box.flush({ user: crew.user, transport });
  assert.deepEqual(plain(sent.map(body => body.data)), [
    { locationTracking: true, lastLocation: point, locationStatus: 'job_page_single_fix', deviceCapturedAt: START },
    { locationTracking: true, locationStatus: 'location_unavailable_at_clock_in', deviceCapturedAt: START },
  ]);
});

test('a crew-mate’s status move worked out before the lead’s crew move reached the phone is confirmed as it stands and holds nothing behind it', async () => {
  const Outbox = outboxApi(), server = fieldServer(), box = Outbox.create({ store: Outbox.memoryStore(), now: () => new Date(server.time()) });
  const sync = () => box.flush({ user: crew.user, transport: server.transport }), id = 'time-crew.one-1';
  await box.enqueue({ requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_in', entryId: id, deviceCapturedAt: server.time(), lastLocation: point } });
  assert.equal((await sync()).stopped, null);
  server.advance(60);
  // The phone last read the shift on general time; the lead's move to work on this job reaches the server first.
  const stale = Outbox.projectShift((await server.transport.shift()).entry, []), lead = uuid();
  server.cards.set(id, applyCrewJobMove(server.cards.get(id), { requestId: lead, jobId: 'job-a', kind: 'work' }, { user: 'Lead.One', displayName: 'Lead One' }, server.time()));
  server.advance(30);
  const move = Outbox.statusTime({ action: 'status', status: 'in_progress' }, stale, 'job-a');
  assert.deepEqual(plain(move), { kind: 'work', jobId: 'job-a', expectedSegmentId: `clock-in:${id}` }, 'worked out from the older view');
  const status = statusItem('in_progress'), work = timeItem(stale, move, server.time()), out = { requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_out', entryId: id, deviceCapturedAt: server.time() } };
  for (const item of [status, work, out]) await box.enqueue(item);
  const result = await sync();
  assert.equal(result.stopped, null, 'not refused as a changed job');
  assert.deepEqual(plain(result.applied.map(entry => entry.item.requestId)), [status.requestId, work.requestId, out.requestId], 'the clock-out behind it went too');
  const card = server.cards.get(id);
  assert.deepEqual(card.jobTracking.segments.map(segment => [segment.id, segment.kind, segment.jobId, segment.startedAt]), [[`clock-in:${id}`, 'general', '', at(0)], [`crew:${lead}`, 'work', 'job-a', at(60)]], 'the lead’s move stands and the crew-mate’s adds no segment');
  assert.equal(card.status, 'submitted');
  assert.deepEqual(plain(await box.items(crew.user)), []);
});

test('a status’s time move the server refuses as not allowed (403) is dropped and reported, never held in the clock lane; a crew member’s own refused job-time tap still waits for review', async () => {
  const Outbox = outboxApi(), server = fieldServer(), box = Outbox.create({ store: Outbox.memoryStore(), now: () => new Date(server.time()) }), id = 'time-crew.one-1';
  await box.enqueue({ requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'clock_in', entryId: id, deviceCapturedAt: server.time(), lastLocation: point } });
  await box.flush({ user: crew.user, transport: server.transport });
  server.advance(60);
  const notAssigned = () => Object.assign(new Error('New job time is limited to your currently assigned active jobs.'), { status: 403, code: 'EMPLOYEE_TIMECARD_INVALID' });
  const refusing = { ...server.transport, employee: async body => body.data.jobAction ? Promise.reject(notAssigned()) : server.transport.employee(body) };
  // Mark en route queues its travel move behind the status; the crew member then starts a break.
  const shift = Outbox.projectShift((await server.transport.shift()).entry, []), move = Outbox.statusTime({ action: 'status', status: 'dispatched' }, shift, 'job-a');
  const status = statusItem('dispatched'), travel = timeItem(shift, move, server.time()), rest = { requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'break_start', entryId: id, deviceCapturedAt: server.time() } };
  for (const item of [status, travel, rest]) await box.enqueue(item);
  const result = await box.flush({ user: crew.user, transport: refusing });
  assert.equal(result.stopped, null, 'nothing waits for review');
  assert.deepEqual(plain(result.applied.map(entry => entry.item.requestId)), [status.requestId, rest.requestId], 'the break behind the refused move still went');
  assert.deepEqual(plain(result.dropped.map(row => [row.item.requestId, row.error.status, row.error.message])), [[travel.requestId, 403, 'New job time is limited to your currently assigned active jobs.']]);
  assert.deepEqual(plain(await box.items(crew.user)), [], 'the refused move is gone from the phone');
  assert.equal(server.cards.get(id).breaks.length, 1);
  assert.deepEqual(server.cards.get(id).jobTracking.segments.map(segment => segment.kind), ['general'], 'the time stayed where it was');
  // The crew member's own tap (no status behind it) refused the same way waits for Retry or Discard, and holds the lane.
  const own = timeItem(Outbox.projectShift((await server.transport.shift()).entry, []), { kind: 'work', jobId: 'job-a', expectedSegmentId: `clock-in:${id}` }, server.time());
  delete own.payload.source;
  const end = { requestId: uuid(), kind: 'clock', user: crew.user, jobId: 'job-a', payload: { op: 'break_end', entryId: id, deviceCapturedAt: server.time() } };
  await box.enqueue(own); await box.enqueue(end);
  const second = await box.flush({ user: crew.user, transport: refusing });
  assert.deepEqual([second.stopped?.item.requestId, second.stopped?.reason, plain(second.dropped)], [own.requestId, 'rejected', []]);
  assert.deepEqual(plain((await box.items(crew.user)).map(item => [item.requestId, item.state])), [[own.requestId, 'error'], [end.requestId, 'queued']]);
});

// ── Clock-in only, on the server ──

const clockIn = (incoming, env = {}, now = START) => authorizeTimecard({ session: crew, manager: false, id: 'shift', incoming: { locationTracking: true, ...incoming }, hourlyRate: 20, now, env });
const update = (existing, incoming, now = at(600)) => authorizeTimecard({ session: crew, manager: false, id: existing.id, existing, incoming, now });

test('a clock-in with no position is refused unless EGC_CLOCK_IN_WITHOUT_FIX is on, and then flagged for a manager', () => {
  const noFix = { locationStatus: 'location_unavailable_at_clock_in' };
  assert.throws(() => clockIn(noFix), error => error.status === 400 && /could not find its location/.test(error.message));
  assert.throws(() => clockIn({}), /valid shift location/, 'a position is still required when the phone did not say it found none');
  const flagged = clockIn(noFix, { EGC_CLOCK_IN_WITHOUT_FIX: 'true' });
  assert.deepEqual([flagged.status, flagged.locationStatus, flagged.locationReview, flagged.lastLocation, flagged.locationTracking, flagged.locationTrail], ['active', 'location_unavailable_at_clock_in', 'location_unavailable_at_clock_in', undefined, false, undefined]);
  assert.equal(ownJobTimeProjection(flagged, at(60)).clockInLocation, 'missing');
  assert.equal(ownJobTimeProjection(clockIn({ lastLocation: point }), at(60)).clockInLocation, 'shared');
  const closed = update(flagged, { clockOutAt: 'phone', status: 'submitted', locationTracking: false, locationStatus: 'stopped' }, at(3600));
  assert.equal(closed.locationReview, 'location_unavailable_at_clock_in', 'the flag stays on the card after clock-out');
  const week = computeTimesheetWeek({ timecards: [{ ...closed, approvalStatus: 'approved' }], weekStart: '2026-09-21', now: '2026-10-05T12:00:00.000Z' });
  assert.deepEqual(week.employees[0].flags, ['no_clock_in_location'], 'payroll review shows it');
  assert.equal(week.employees[0].timecards[0].locationReview, 'location_unavailable_at_clock_in');
  assert.deepEqual(week.coverage.reasons, [], 'a review flag, not a payroll block');
});

test('after clock-in nothing updates a shift’s location: position fixes, errors and statuses are refused (409), a replayed clock-in is a no-op, the clock-out still closes it', () => {
  const card = clockIn({ lastLocation: point, locationStatus: 'job_page_single_fix' });
  const refused = error => error.status === 409 && error.code === 'EMPLOYEE_TIMECARD_LOCATION_CLOCK_IN_ONLY';
  for (const incoming of [{ lastLocation: { ...point, lat: 40.7 }, locationStatus: 'tracking', locationUpdatedAt: at(60) }, { locationStatus: 'unavailable', locationError: 'Synthetic timeout' }, { locationTrail: [point] }, { locationStatus: 'tracking' }]) {
    assert.throws(() => update(card, incoming), refused, JSON.stringify(incoming));
  }
  assert.strictEqual(update(card, { locationTracking: true, lastLocation: point, locationStatus: 'job_page_single_fix', deviceCapturedAt: START }), card, 'the crew app’s clock-in replayed after a lost reply');
  const managerCard = authorizeTimecard({ session: { user: 'ZacB', displayName: 'Owner', role: 'owner' }, manager: true, id: 'shift-zacb', existing: null, incoming: { employee: 'ZacB', clockInAt: START, clockOutAt: '', status: 'active', locationTracking: true, locationStatus: 'tracking', lastLocation: { ...point, capturedAt: START }, locationTrail: [{ ...point, capturedAt: START }] }, now: START });
  assert.deepEqual([managerCard.locationTracking, managerCard.locationStatus, managerCard.locationTrail], [false, 'hub_single_fix', undefined], 'an older Hub’s clock-in body is stored as one position with no trail');
  assert.throws(() => authorizeTimecard({ session: { user: 'ZacB', role: 'owner' }, manager: true, id: 'shift-zacb', existing: managerCard, incoming: { lastLocation: { ...point, lat: 41, capturedAt: at(60) }, locationStatus: 'tracking' }, now: at(60) }), refused, 'a manager’s own open shift too');
  const closed = update(card, { clockOutAt: 'phone', status: 'submitted', locationTracking: false, locationStatus: 'stopped' }, at(3600));
  assert.deepEqual([closed.status, closed.locationStatus, plain(closed.lastLocation)], ['submitted', 'stopped', { ...point, capturedAt: START }]);
  // A card an older build tracked keeps its trail, readable; nothing appends to it.
  const legacy = { ...card, locationTracking: true, locationStatus: 'tracking', locationTrail: [{ ...point, capturedAt: START }, { ...point, lat: 40.6, capturedAt: at(60) }] };
  assert.throws(() => update(legacy, { lastLocation: { ...point, lat: 40.7 }, locationTrail: [...legacy.locationTrail, point] }), refused);
  assert.equal(update(legacy, { breaks: [{ startAt: 'phone', endAt: '' }] }).locationTrail.length, 2);
  assert.equal(authorizeTimecard({ session: crew, manager: false, id: 'shift', existing: card, incoming: { jobTime: { current: null }, notes: 'Synthetic note' }, now: at(60) }).jobTime, undefined, 'the derived jobTime is never stored');
});

test('a job-time switch sent from an older view of the shift to where it already is changes nothing; a real change is still refused', () => {
  const card = clockIn({ lastLocation: point }), general = card.jobTracking.segments[0].id;
  const moved = applyCrewJobMove(card, { requestId: uuid(), jobId: 'job-a', kind: 'work' }, { user: 'Lead.One', displayName: 'Lead One' }, at(120));
  const stale = { requestId: uuid(), expectedSegmentId: general, jobId: 'job-a', kind: 'work' };
  assert.strictEqual(applyEmployeeJobAction(moved, stale, crew, at(180)), moved);
  assert.strictEqual(update(moved, { jobAction: stale }, at(180)), moved, 'saved as it stands');
  assert.strictEqual(authorizeTimecard({ session: crew, manager: false, id: moved.id, existing: moved, incoming: { jobAction: { ...stale, deviceCapturedAt: at(170) } }, now: at(180), env: { EGC_OFFLINE_CLOCK_ENABLED: 'true' } }), moved, 'with offline device times on: no device-time review flag for a switch that changed nothing');
  assert.strictEqual(authorizeTimecard({ session: crew, manager: false, id: moved.id, existing: moved, incoming: { jobAction: { ...stale, deviceCapturedAt: at(0) } }, now: at(900) }), moved, 'with them off: no stale-time refusal either');
  for (const [kind, jobId] of [['travel', 'job-a'], ['work', 'job-b'], ['general', '']]) {
    assert.throws(() => update(moved, { jobAction: { requestId: uuid(), expectedSegmentId: general, jobId, kind } }, at(180)), error => error.status === 409 && /active job changed/.test(error.message), `${kind} ${jobId}`);
  }
  const split = update(moved, { jobAction: { requestId: uuid(), expectedSegmentId: moved.jobTracking.segments[1].id, jobId: 'job-a', kind: 'work' } }, at(240));
  assert.equal(split.jobTracking.segments.length, 3, 'naming the running segment still starts a new one, as before');
});

test('a manager’s own Hub clock-in starts its job segments on general time, so its time is general company time, not “No job segments”', () => {
  const owner = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner' }, id = 'time-zacb-1';
  const body = { employee: 'ZacB', employeeName: 'Synthetic Owner', clockInAt: START, clockOutAt: '', status: 'active', approvalStatus: 'open', locationTracking: true, locationStatus: 'hub_single_fix', lastLocation: { ...point, capturedAt: START }, breaks: [] };
  const card = authorizeTimecard({ session: owner, manager: true, id, existing: null, incoming: body, now: START });
  assert.deepEqual(plain(card.jobTracking), { version: 1, coverageStartedAt: START, partialHistory: false, segments: [{ id: `clock-in:${id}`, kind: 'general', jobId: '', jobLabel: '', startedAt: START, endedAt: '', actorId: 'ZacB' }] });
  const view = jobTimeView(card, at(3600));
  assert.deepEqual([view.recorded, view.partialHistory, view.generalMs, view.untrackedMs, view.current.kind], [true, false, 3600000, 0, 'general']);
  assert.strictEqual(authorizeTimecard({ session: owner, manager: true, id, existing: card, incoming: body, now: at(60), queued: true }), card, 'a replayed clock-in changes nothing');
  assert.equal(authorizeTimecard({ session: owner, manager: true, id: 'time-crew-entered', existing: null, incoming: { ...body, employee: 'Crew.One', employeeName: 'Crew One' }, now: START }).jobTracking, undefined, 'a shift a manager enters for someone else is stored as before');
  // A status-driven move (a manager leading a job) starts from general time, so the time before it stays general.
  const working = authorizeTimecard({ session: owner, manager: true, id, existing: card, incoming: { jobAction: { requestId: uuid(), expectedSegmentId: `clock-in:${id}`, jobId: 'job-a', kind: 'work' } }, now: at(1800) });
  const closed = authorizeTimecard({ session: owner, manager: true, id, existing: working, incoming: { clockOutAt: at(3600), status: 'submitted', approvalStatus: 'pending' }, now: at(3600) });
  const week = computeTimesheetWeek({ timecards: [{ ...closed, approvalStatus: 'approved' }], weekStart: '2026-09-21', now: '2026-10-05T12:00:00.000Z' });
  assert.deepEqual(plain(week.employees[0].jobTime), { jobs: [{ jobId: 'job-a', jobLabel: '', workHours: 0.5, travelHours: 0 }], generalHours: 0.5, untrackedHours: 0 });
  assert.doesNotMatch(jobTimeText(week.employees[0].jobTime), /No job segments/);
});

test('a shift an older build kept tracking is labelled with its last tracked location, never as shared once at clock-in', () => {
  const fresh = clockIn({ lastLocation: point, locationStatus: 'job_page_single_fix' }), place = entry => jobTimeView(entry, at(3600)).clockInLocation;
  assert.equal(place(fresh), 'shared');
  assert.equal(place(update(fresh, { clockOutAt: 'phone', status: 'submitted', locationTracking: false, locationStatus: 'stopped' }, at(1800))), 'shared', 'still its clock-in position after clock-out');
  const trail = [{ ...point, capturedAt: START }, { ...point, lat: 40.6, capturedAt: at(600) }];
  assert.equal(place({ ...fresh, locationTracking: true, locationStatus: 'tracking', lastLocation: trail[0], locationTrail: trail.slice(0, 1) }), 'tracked', 'a watch was still running on it');
  assert.equal(place({ ...fresh, locationStatus: 'stopped', lastLocation: trail[1], locationTrail: trail }), 'tracked', 'its lastLocation is the last watched position');
  assert.equal(place({ ...fresh, locationStatus: 'unavailable', lastLocation: trail[0], locationTrail: trail.slice(0, 1) }), 'shared', 'an older crew-app clock-in kept only its one position');
  assert.equal(place(clockIn({ locationStatus: 'location_unavailable_at_clock_in' }, { EGC_CLOCK_IN_WITHOUT_FIX: 'true' })), 'missing');
});

// ── The lead moves crew-mates to work (server) ──

const ENV = staffEnv({ EGC_JOB_STATUS_MOVES_TIME: 'true' }, Object.fromEntries(['Lead.One', 'Mate.A', 'Mate.B', 'Mate.C', 'Mate.D', 'Mate.E'].map(user => [user, { passwordHash: `unused-synthetic-${user}`, role: 'crew', displayName: `Synthetic ${user}`, hourlyRate: 20 }])));
const NOW = '2026-09-22T15:00:00.000Z';
const minutes = count => new Date(Date.parse(NOW) + count * 60000).toISOString();
const post = async (cookie, body, env = ENV) => employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', body, cookie) });
const seedJob = (fire, id, fields) => fire.documents.set(`jobs/${id}`, { name: `${ROOT}/jobs/${id}`, fields: encodeFirestoreFields({ type: 'job', serviceType: 'Garage cleanout', status: 'in_progress', ...fields }), updateTime: '2026-09-22T12:00:00.000001Z' });
const records = async cookie => (await (await employeeHub.onRequestGet({ env: ENV, request: jsonRequest('/api/employee-hub', undefined, cookie) })).json()).collections.timeEntries;

async function crewDay(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const fire = vaultFirestore(t), cookies = {};
  for (const user of ['Lead.One', 'Mate.A', 'Mate.B', 'Mate.C', 'Mate.D', 'Mate.E', 'ZacB']) cookies[user] = await cookieFor(ENV, user);
  seedJob(fire, 'job-crew', { customer: 'Synthetic Crew Garage', assignedCrew: ['Lead.One', 'Mate.A', 'Mate.B', 'Mate.C', 'Mate.E'], crewLead: 'Lead.One' });
  seedJob(fire, 'job-other', { customer: 'Synthetic Other Garage', assignedCrew: ['Mate.C'], crewLead: 'Mate.C' });
  // Everyone but Mate.B clocks in; Mate.D is not on this job, Mate.C is working another job, Mate.E is driving to this one.
  for (const user of ['Lead.One', 'Mate.A', 'Mate.C', 'Mate.D', 'Mate.E']) {
    const reply = await post(cookies[user], { collection: 'timeEntries', id: `time-${user.toLowerCase()}`, data: { locationTracking: true, lastLocation: point, locationStatus: 'job_page_single_fix' } });
    assert.equal(reply.status, 200, await reply.clone().text());
  }
  t.mock.timers.setTime(Date.parse(minutes(10)));
  for (const [user, jobId, kind] of [['Mate.C', 'job-other', 'work'], ['Mate.E', 'job-crew', 'travel']]) {
    const reply = await post(cookies[user], { collection: 'timeEntries', id: `time-${user.toLowerCase()}`, data: { jobAction: { requestId: uuid(), expectedSegmentId: `clock-in:time-${user.toLowerCase()}`, jobId, kind } } });
    assert.equal(reply.status, 200, await reply.clone().text());
  }
  t.mock.timers.setTime(Date.parse(minutes(30)));
  return { fire, cookies };
}
const move = (requestId, extra = {}) => ({ collection: 'timeEntries', id: 'job-crew', expectedUser: 'Lead.One', data: { crewJobAction: { requestId, jobId: 'job-crew', kind: 'work', ...extra } } });

test('the lead’s crew move applies only to assigned, clocked-in crew on general time or travelling here; the server checks each assignment and a replay changes nothing', async t => {
  const { fire, cookies } = await crewDay(t), requestId = uuid();
  const reply = await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) }));
  assert.equal(reply.status, 200, await reply.clone().text());
  const body = await reply.json(), names = rows => rows.map(row => row.employee).sort();
  assert.deepEqual(names(body.moved), ['Mate.A', 'Mate.E'], 'general time and travel here move to work');
  assert.deepEqual(body.skipped.map(row => [row.employee, row.reason]), [['Mate.C', 'on_another_job']]);
  assert.equal([...body.moved, ...body.skipped].some(row => ['Mate.B', 'Mate.D', 'Lead.One'].includes(row.employee)), false, 'not clocked in, not assigned, and the lead are not listed');
  const cards = await records(cookies.ZacB), card = user => cards.find(row => row.employee === user);
  for (const user of ['Mate.A', 'Mate.E']) {
    assert.deepEqual(plain(card(user).jobTime.current), { id: `crew:${requestId}`, kind: 'work', jobId: 'job-crew', jobLabel: 'Synthetic Crew Garage', startedAt: minutes(30) }, user);
    assert.equal(card(user).history.at(-1).action, 'job_time_crew_move'); assert.equal(card(user).history.at(-1).actor, 'Lead.One');
  }
  assert.deepEqual(plain(card('Mate.E').jobTime.jobs), [{ jobId: 'job-crew', jobLabel: 'Synthetic Crew Garage', workMs: 0, travelMs: 20 * 60000 }], 'the travel before the move stays travel');
  assert.equal(card('Mate.C').jobTime.current.jobId, 'job-other', 'work on another job is left alone');
  assert.equal(card('Mate.D').jobTime.current.kind, 'general', 'a crew member not on this job is never moved');
  assert.equal(card('Lead.One').jobTime.current.kind, 'general', 'the lead moves their own time with their own action');
  // A lost reply: the same request again moves nobody twice.
  const writes = fire.writes().length;
  const again = await (await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) }))).json();
  assert.deepEqual([names(again.moved), again.moved.every(row => row.alreadyApplied)], [['Mate.A', 'Mate.E'], true]);
  assert.equal(fire.writes().length, writes, 'nothing was written again');
});

test('only the job’s lead (or a manager) may move crew-mates, only with the switch on, and never from a stale phone time', async t => {
  const { cookies } = await crewDay(t);
  const forbidden = await post(cookies['Mate.A'], { ...move(uuid()), expectedUser: 'Mate.A' });
  assert.equal(forbidden.status, 403); assert.match((await forbidden.json()).error, /crew lead or a manager/);
  const off = await post(cookies['Lead.One'], move(uuid()), { ...ENV, EGC_JOB_STATUS_MOVES_TIME: '' });
  assert.equal(off.status, 403); assert.match((await off.json()).error, /switched off/);
  const stale = await post(cookies['Lead.One'], move(uuid(), { deviceCapturedAt: minutes(20) }));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'EMPLOYEE_TIMECARD_DEVICE_TIME');
  const account = await post(cookies['Mate.A'], move(uuid()));
  assert.equal(account.status, 409, 'a crew move saved on this phone by another account is not sent as this one'); assert.equal((await account.json()).code, 'EMPLOYEE_HUB_ACCOUNT_CHANGED');
  const manager = await post(cookies.ZacB, { ...move(uuid()), expectedUser: 'ZacB' });
  assert.equal(manager.status, 200, await manager.clone().text());
  const invalid = await post(cookies['Lead.One'], { ...move(uuid()), data: { crewJobAction: { requestId: 'not-a-uuid', jobId: 'job-crew', kind: 'work' } } });
  assert.equal(invalid.status, 400);
  const travel = await post(cookies['Lead.One'], { ...move(uuid()), data: { crewJobAction: { requestId: uuid(), jobId: 'job-crew', kind: 'travel' } } });
  assert.equal(travel.status, 400, 'only work');
});

test('one crew-mate’s card that cannot take the move is skipped for review, not the whole move; a storage failure stops it and the replay moves nobody twice', async t => {
  const { fire, cookies } = await crewDay(t), requestId = uuid();
  // A second open card for Mate.A, left from before the per-employee shift lock: saving it answers "already an active shift".
  await writeOne(ENV, 'timeEntries', 'time-mate.a-legacy', { employee: 'Mate.A', employeeName: 'Synthetic Mate.A', clockInAt: minutes(1), clockOutAt: '', status: 'active', approvalStatus: 'open', breaks: [], jobTracking: { version: 1, coverageStartedAt: minutes(1), partialHistory: false, segments: [{ id: 'clock-in:time-mate.a-legacy', kind: 'general', jobId: '', jobLabel: '', startedAt: minutes(1), endedAt: '', actorId: 'Mate.A' }] } });
  fire.hooks.commitStatus = 503;
  const failed = await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) }));
  assert.equal(failed.status, 502, 'the lead’s phone keeps it and retries'); assert.equal((await failed.json()).ok, false);
  const reply = await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) }));
  assert.equal(reply.status, 200, await reply.clone().text());
  const body = await reply.json(), rows = list => list.map(row => [row.employee, row.reason || (row.alreadyApplied ? 'again' : 'moved')]).sort((a, b) => a.join().localeCompare(b.join()));
  assert.deepEqual(rows(body.moved), [['Mate.A', 'moved'], ['Mate.E', 'moved']]);
  assert.deepEqual(rows(body.skipped), [['Mate.A', 'needs_review'], ['Mate.C', 'on_another_job']], 'the duplicate card is skipped; the rest still moved');
  const writes = fire.writes().length, again = await (await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) }))).json();
  assert.deepEqual([rows(again.moved), rows(again.skipped)], [[['Mate.A', 'again'], ['Mate.E', 'again']], [['Mate.A', 'needs_review'], ['Mate.C', 'on_another_job']]]);
  assert.equal(fire.writes().length, writes, 'a replay writes nothing');
});

test('with multi-day visits the move takes only today’s crew, a crew-mate on break stays on break, and a lead not on today’s crew cannot move anyone', async t => {
  const { cookies, fire } = await crewDay(t), VISITS = { ...ENV, FIELD_MULTIDAY_VISITS: 'true' };
  const day = (id, date, assignedCrew) => ({ id, date, time: '08:00', endDate: date, endTime: '17:00', assignedCrew, crewLead: 'Lead.One' });
  seedJob(fire, 'job-split', { customer: 'Synthetic Split Garage', crewLead: 'Lead.One', date: '2026-09-22', time: '08:00', endDate: '2026-09-23', endTime: '17:00', assignedCrew: ['Lead.One', 'Mate.A', 'Mate.B', 'Mate.D'], assignmentSegments: [day('today', '2026-09-22', ['Lead.One', 'Mate.A', 'Mate.B']), day('tomorrow', '2026-09-23', ['Lead.One', 'Mate.D'])] });
  seedJob(fire, 'job-later', { customer: 'Synthetic Later Garage', crewLead: 'Lead.One', date: '2026-09-22', time: '08:00', endDate: '2026-09-23', endTime: '17:00', assignedCrew: ['Lead.One', 'Mate.A'], assignmentSegments: [day('today', '2026-09-22', ['Mate.A']), day('tomorrow', '2026-09-23', ['Lead.One'])] });
  for (const data of [{ locationTracking: true, lastLocation: point, locationStatus: 'job_page_single_fix' }, { breaks: [{ startAt: minutes(30), endAt: '' }] }]) {
    const reply = await post(cookies['Mate.B'], { collection: 'timeEntries', id: 'time-mate.b', data });
    assert.equal(reply.status, 200, await reply.clone().text());
  }
  const split = requestId => ({ ...move(requestId), data: { crewJobAction: { requestId, jobId: 'job-split', kind: 'work' } } });
  const reply = await post(cookies['Lead.One'], split(uuid()), VISITS);
  assert.equal(reply.status, 200, await reply.clone().text());
  const body = await reply.json();
  assert.deepEqual(body.moved.map(row => row.employee), ['Mate.A']);
  assert.deepEqual(body.skipped.map(row => [row.employee, row.reason]).sort(), [['Mate.B', 'on_break'], ['Mate.D', 'not_scheduled_today']]);
  const cards = await records(cookies.ZacB), card = user => cards.find(row => row.employee === user);
  assert.deepEqual([card('Mate.B').jobTime.current.kind, card('Mate.D').jobTime.current.kind], ['general', 'general'], 'neither card changed');
  const later = await post(cookies['Lead.One'], { ...move(uuid()), data: { crewJobAction: { requestId: uuid(), jobId: 'job-later', kind: 'work' } } }, VISITS);
  assert.equal(later.status, 403); assert.match((await later.json()).error, /not scheduled on this job today/);
  // Without multi-day visits every assigned crew-mate counts, as before; the break still keeps Mate.B where they are.
  const plainDay = await (await post(cookies['Lead.One'], split(uuid()))).json();
  assert.deepEqual([plainDay.moved.map(row => row.employee), plainDay.skipped.map(row => [row.employee, row.reason]).sort()], [['Mate.D'], [['Mate.A', 'already_working'], ['Mate.B', 'on_break']]]);
});

test('a crew-mate still clocked in from an earlier day or on approved time off today is never moved', async t => {
  const { cookies } = await crewDay(t);
  // Mate.B forgot to clock out yesterday (Denver); Mate.A has approved time off today; Mate.E has time off that ended early.
  await writeOne(ENV, 'timeEntries', 'time-mate.b-yesterday', { employee: 'Mate.B', employeeName: 'Synthetic Mate.B', clockInAt: '2026-09-21T20:00:00.000Z', clockOutAt: '', status: 'active', approvalStatus: 'open', breaks: [], jobTracking: { version: 1, coverageStartedAt: '2026-09-21T20:00:00.000Z', partialHistory: false, segments: [{ id: 'clock-in:time-mate.b-yesterday', kind: 'general', jobId: '', jobLabel: '', startedAt: '2026-09-21T20:00:00.000Z', endedAt: '', actorId: 'Mate.B' }] } });
  const pto = (id, employee, extra) => writeOne(ENV, 'requests', id, { id, type: 'time_off', employee, employeeName: `Synthetic ${employee}`, startDate: '2026-09-21', endDate: '2026-09-23', reason: 'Synthetic time off', status: 'approved', ...extra });
  await pto('pto-mate-a', 'mate.a', {});
  await pto('pto-mate-e', 'mate.e', { endedEarlyFrom: '2026-09-22' });
  await pto('pto-mate-e-pending', 'mate.e', { status: 'pending', startDate: '2026-09-22', endDate: '2026-09-22' });
  const reply = await post(cookies['Lead.One'], move(uuid(), { deviceCapturedAt: minutes(30) }));
  assert.equal(reply.status, 200, await reply.clone().text());
  const body = await reply.json(), rows = list => list.map(row => [row.employee, row.reason || 'moved']).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(rows(body.moved), [['Mate.E', 'moved']], 'time off that ended early, or is only requested, does not keep anyone off');
  assert.deepEqual(rows(body.skipped), [['Mate.A', 'on_pto'], ['Mate.B', 'stale_shift'], ['Mate.C', 'on_another_job']]);
  const cards = await records(cookies.ZacB);
  assert.equal(cards.find(row => row.id === 'time-mate.a').jobTime.current.kind, 'general', 'the crew-mate on time off keeps their own time');
  assert.equal(cards.find(row => row.id === 'time-mate.b-yesterday').jobTime.current.kind, 'general', 'the stale shift gets no work segment today');
  // The pure rules the handler uses.
  const card = clockIn({ lastLocation: point });
  assert.equal(crewJobMoveState(card, 'job-a', uuid(), at(60)), 'move');
  assert.equal(crewJobMoveState(card, 'job-a', uuid(), at(60), { onPto: true }), 'on_pto');
  assert.equal(crewJobMoveState(card, 'job-a', uuid(), '2026-09-23T14:00:00.000Z'), 'stale_shift', 'the next Denver day');
  assert.equal(crewJobMoveState(card, 'job-a', uuid(), '2026-09-23T05:59:00.000Z'), 'move', '23:59 in Denver is still the same day');
  assert.throws(() => applyCrewJobMove(card, { requestId: uuid(), jobId: 'job-a', kind: 'work' }, { user: 'Lead.One' }, at(60), { onPto: true }), error => error.status === 409);
  const request = { type: 'time_off', status: 'approved', startDate: '2026-09-21', endDate: '2026-09-23' };
  assert.deepEqual(['2026-09-20', '2026-09-21', '2026-09-23', '2026-09-24'].map(date => ptoOffOn(request, date)), [false, true, true, false]);
  assert.deepEqual([ptoOffOn({ ...request, status: 'pending' }, '2026-09-22'), ptoOffOn({ ...request, type: 'shift_change' }, '2026-09-22'), ptoOffOn({ ...request, endedEarlyFrom: '2026-09-22' }, '2026-09-22'), ptoOffOn({ ...request, paid: false }, '2026-09-22')], [false, false, false, true]);
});

test('a crew move replayed long after it was applied is answered as it stands; the 2-minute limit applies only to crew-mates still to move', async t => {
  const { fire, cookies } = await crewDay(t), requestId = uuid(), names = rows => rows.map(row => row.employee).sort();
  assert.equal((await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) }))).status, 200);
  // The reply was lost; the phone retries 3 minutes later, after the job was completed.
  t.mock.timers.setTime(Date.parse(minutes(33)));
  seedJob(fire, 'job-crew', { customer: 'Synthetic Crew Garage', assignedCrew: ['Lead.One', 'Mate.A', 'Mate.B', 'Mate.C', 'Mate.E'], crewLead: 'Lead.One', status: 'completed', pipelineStatus: 'completed' });
  const writes = fire.writes().length, reply = await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) }));
  assert.equal(reply.status, 200, await reply.clone().text());
  const body = await reply.json();
  assert.deepEqual([names(body.moved), body.moved.every(row => row.alreadyApplied), body.skipped.map(row => [row.employee, row.reason])], [['Mate.A', 'Mate.E'], true, [['Mate.C', 'on_another_job']]]);
  assert.equal(fire.writes().length, writes, 'a replay writes nothing');
  // A new, late move with nobody left to move is answered too; one with crew-mates still to move is refused (above).
  const late = await post(cookies['Lead.One'], move(uuid(), { deviceCapturedAt: minutes(30) }));
  assert.equal(late.status, 200, 'nobody is left to move, so nothing is refused');
  assert.deepEqual((await late.json()).moved, []);
});

test('a partly applied crew move retried within 2 minutes finishes the rest; retried later it is refused and names exactly who was moved', async t => {
  for (const wait of [1, 3]) {
    await t.test(`retried after ${wait} minute${wait === 1 ? '' : 's'}`, async t => {
      const { fire, cookies } = await crewDay(t), requestId = uuid();
      // The first attempt moves one crew-mate, then storage fails on the second.
      fire.hooks.beforeCommit = async () => { fire.hooks.beforeCommit = async () => { fire.hooks.commitStatus = 503; }; };
      const failed = await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) }));
      assert.equal(failed.status, 502, await failed.clone().text());
      const cards = await records(cookies.ZacB), first = ['Mate.A', 'Mate.E'].find(user => cards.find(row => row.employee === user).jobTime.current.id === `crew:${requestId}`), second = first === 'Mate.A' ? 'Mate.E' : 'Mate.A';
      assert.ok(first, 'one crew-mate was moved before the failure');
      t.mock.timers.setTime(Date.parse(minutes(30 + wait)));
      const writes = fire.writes().length, reply = await post(cookies['Lead.One'], move(requestId, { deviceCapturedAt: minutes(30) })), body = await reply.json();
      if (wait === 1) {
        assert.equal(reply.status, 200, JSON.stringify(body));
        assert.deepEqual(body.moved.map(row => [row.employee, row.alreadyApplied]).sort(), [[first, true], [second, false]].sort());
        const after = await records(cookies.ZacB);
        assert.equal(after.find(row => row.employee === second).jobTime.current.id, `crew:${requestId}`, 'the rest was moved under the same request');
        return;
      }
      assert.equal(reply.status, 409); assert.equal(body.code, 'EMPLOYEE_TIMECARD_DEVICE_TIME');
      assert.deepEqual(body.details.moved.map(row => [row.employee, row.alreadyApplied]), [[first, true]]);
      assert.deepEqual(body.details.notMoved.map(row => row.employee), [second]);
      assert.equal(body.error, `This crew move waited on the phone too long to finish. Already moved to work here: Synthetic ${first}. Not moved: Synthetic ${second}. Ask them to start their own work time, or a manager to correct it.`);
      assert.equal(fire.writes().length, writes, 'nothing more was written');
    });
  }
});

test('applyCrewJobMove keeps earlier segments, refuses what crewJobMoveState refuses, and replays as a no-op', () => {
  let card = clockIn({ lastLocation: point });
  card = update(card, { jobAction: { requestId: uuid(), expectedSegmentId: card.jobTracking.segments[0].id, jobId: 'job-b', kind: 'work' } }, at(60));
  assert.equal(crewJobMoveState(card, 'job-a', uuid(), at(120)), 'on_another_job');
  assert.throws(() => applyCrewJobMove(card, { requestId: uuid(), jobId: 'job-a', kind: 'work' }, { user: 'Lead.One' }, at(120)), error => error.status === 409);
  const general = update(card, { jobAction: { requestId: uuid(), expectedSegmentId: card.jobTracking.segments[1].id, jobId: '', kind: 'general' } }, at(120)), requestId = uuid();
  const moved = applyCrewJobMove(general, { requestId, jobId: 'job-a', kind: 'work' }, { user: 'Lead.One', displayName: 'Lead One' }, at(180));
  assert.deepEqual(moved.jobTracking.segments.map(segment => [segment.kind, segment.jobId, segment.endReason || '']), [['general', '', 'job_switch'], ['work', 'job-b', 'job_switch'], ['general', '', 'crew_move'], ['work', 'job-a', '']]);
  assert.strictEqual(applyCrewJobMove(moved, { requestId, jobId: 'job-a', kind: 'work' }, { user: 'Lead.One' }, at(900)), moved);
  assert.equal(crewJobMoveState(moved, 'job-a', uuid(), at(200)), 'already_working');
  assert.equal(crewJobMoveState(update(moved, { clockOutAt: 'phone', status: 'submitted' }, at(300)), 'job-a', uuid(), at(400)), 'not_clocked_in');
  const summary = employeeJobTime(moved, at(240));
  assert.deepEqual(summary.jobs.map(row => [row.jobId, row.workMs / 1000]), [['job-b', 60], ['job-a', 60]]);
});

// ── Honest labels ──

const segmented = (id, clockInAt, clockOutAt, segments, extra = {}) => ({ id, employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 20, clockInAt, clockOutAt, status: 'submitted', approvalStatus: 'approved', breaks: [],
  jobTracking: { version: 1, coverageStartedAt: clockInAt, partialHistory: false, segments: segments.map(([kind, jobId, jobLabel, startedAt, endedAt], index) => ({ id: `${id}-${index}`, kind, jobId, jobLabel, startedAt, endedAt, actorId: 'Crew.One' })) }, ...extra });

test('payroll CSV rows carry each job’s work and travel with its label, general company time only for general segments', () => {
  const day = (time, offset = '-06:00') => `2026-09-22T${time}:00${offset}`;
  const card = segmented('shift', day('07:00'), day('11:00'), [['general', '', '', day('07:00'), day('07:30')], ['travel', 'job-a', 'Synthetic Johnson Garage', day('07:30'), day('08:00')], ['work', 'job-a', 'Synthetic Johnson Garage', day('08:00'), day('10:00')], ['work', 'job-b', '=Synthetic Formula Co', day('10:00'), day('11:00')]]);
  const legacy = { id: 'legacy', employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 20, clockInAt: day('12:00'), clockOutAt: day('13:00'), status: 'submitted', approvalStatus: 'approved', breaks: [], jobLabel: 'Synthetic Old Label' };
  const week = computeTimesheetWeek({ timecards: [card, legacy], weekStart: '2026-09-21', now: '2026-10-05T12:00:00.000Z' });
  assert.deepEqual(plain(week.employees[0].jobTime), { jobs: [{ jobId: 'job-a', jobLabel: 'Synthetic Johnson Garage', workHours: 2, travelHours: 0.5 }, { jobId: 'job-b', jobLabel: '=Synthetic Formula Co', workHours: 1, travelHours: 0 }], generalHours: 0.5, untrackedHours: 1 });
  const rows = payrollCsv(week).trimEnd().split('\r\n');
  assert.match(rows[0], /"Review flags","Job time"$/);
  assert.match(rows[1], /,"Synthetic Johnson Garage: work 2\.000 h, travel 0\.500 h; =Synthetic Formula Co: work 1\.000 h; General company time 0\.500 h; No job segments 1\.000 h"$/);
  assert.equal(jobTimeText({ jobs: [{ jobId: 'job-z', jobLabel: '', workHours: 1, travelHours: 0 }] }), 'Job job-z: work 1.000 h', 'a job without a label is named by its ID');
  assert.equal(jobTimeText(undefined), '');
  // A label that starts with = is guarded as a whole cell (csvCell); a leading formula is never the first character.
  assert.equal(payrollCsv({ ...week, employees: [{ ...week.employees[0], jobTime: { jobs: [{ jobId: 'job-b', jobLabel: '=HYPERLINK("x")', workHours: 1, travelHours: 0 }], generalHours: 0, untrackedHours: 0 } }] }).trimEnd().split('\r\n')[1].endsWith(`"'=HYPERLINK(""x""): work 1.000 h"`), true);
});

test('weekly hours and job time stay right across the fall-back DST change', () => {
  // 22:00 MDT on Oct 31 to 06:00 MST on Nov 1 is nine hours, one of them repeated on the clock.
  const card = segmented('night', '2026-10-31T22:00:00-06:00', '2026-11-01T06:00:00-07:00', [['travel', 'job-a', 'Synthetic Night Garage', '2026-10-31T22:00:00-06:00', '2026-10-31T23:00:00-06:00'], ['work', 'job-a', 'Synthetic Night Garage', '2026-10-31T23:00:00-06:00', '2026-11-01T01:30:00-07:00'], ['general', '', '', '2026-11-01T01:30:00-07:00', '2026-11-01T06:00:00-07:00']]);
  const week = computeTimesheetWeek({ timecards: [card], weekStart: '2026-10-26', now: '2026-11-10T12:00:00.000Z' }), row = week.employees[0];
  assert.deepEqual([week.weekStart, row.workedHours, row.days[5].date, row.days[5].workedHours], ['2026-10-26', 9, '2026-10-31', 9]);
  assert.deepEqual(plain(row.jobTime), { jobs: [{ jobId: 'job-a', jobLabel: 'Synthetic Night Garage', workHours: 3.5, travelHours: 1 }], generalHours: 4.5, untrackedHours: 0 });
  const view = jobTimeView({ ...card, status: 'active', clockOutAt: '', approvalStatus: 'open', jobTracking: { ...card.jobTracking, segments: card.jobTracking.segments.map((segment, index) => index === 2 ? { ...segment, endedAt: '' } : segment) } }, '2026-11-01T06:00:00-07:00');
  assert.deepEqual([view.current.kind, view.generalMs / 3600000, view.jobs[0].workMs / 3600000], ['general', 4.5, 3.5], 'an open shift’s live view counts the repeated hour once, too');
});

// The same punches through the integration tip before CREW-TIME (5434d35): its payroll CSV rows, verbatim. CREW-TIME may
// only append the Job time cell; every hour, pay and review-flag cell stays byte for byte what the tip exported.
const TIP_HEADER = '"Employee name","Employee username","Week start","Week end","Overtime policy","Regular hours","Overtime hours","Double-time hours","Paid time off hours","Total paid hours","Regular rate","Straight-time pay","Overtime premium","Paid time off pay","Bonus","Tips","Gross pay","Overtime basis","Approved timecards","Pending timecards included","Review flags"';
const TIP_ROWS = {
  '2026-10-26': '"Crew One","crew.one","2026-10-26","2026-11-01","colorado","9.000","0.000","0.000","0.000","9.000","20.0000","180.00","0.00","0.00","0.00","0.00","180.00","none","1","0",""',
  '2027-03-08': '"Crew One","crew.one","2027-03-08","2027-03-14","colorado","7.000","0.000","0.000","0.000","7.000","20.0000","140.00","0.00","0.00","0.00","0.00","140.00","none","1","0",""',
  '2027-03-15': '"Crew One","crew.one","2027-03-15","2027-03-21","colorado","23.500","0.000","0.000","0.000","23.500","20.0000","470.00","0.00","0.00","0.00","0.00","470.00","none","4","0",""',
  '2027-03-22': '"Crew One","crew.one","2027-03-22","2027-03-28","colorado","40.000","18.000","0.000","0.000","58.000","21.3103","1186.00","191.79","0.00","50.00","10.00","1437.79","weekly","6","0","bonus_or_tips multiple_rates"',
};

test('payroll hours, pay and review flags stay byte-identical to the export before CREW-TIME for the same punches; a shift whose segments need review is named only in Job time', () => {
  const at = (date, time, offset = '-06:00') => `${date}T${time}:00${offset}`;
  const cards = [
    // Spring forward, Mar 14 2027: 22:00 MST to 06:00 MDT is 7 real hours.
    segmented('spring', at('2027-03-13', '22:00', '-07:00'), at('2027-03-14', '06:00'), [['travel', 'job-a', 'A', at('2027-03-13', '22:00', '-07:00'), at('2027-03-13', '23:00', '-07:00')], ['work', 'job-a', 'A', at('2027-03-13', '23:00', '-07:00'), at('2027-03-14', '03:30')], ['general', '', '', at('2027-03-14', '03:30'), at('2027-03-14', '06:00')]]),
    // Across midnight with a paid rest break and an unpaid meal over midnight, and a lead's crew move.
    segmented('mid', at('2027-03-15', '20:00'), at('2027-03-16', '04:00'), [['general', '', '', at('2027-03-15', '20:00'), at('2027-03-15', '20:45')], ['work', 'job-m', 'M', at('2027-03-15', '20:45'), at('2027-03-16', '02:00')], ['travel', 'job-n', 'N', at('2027-03-16', '02:00'), at('2027-03-16', '04:00')]],
      { breaks: [{ startAt: at('2027-03-15', '21:00'), endAt: at('2027-03-15', '21:10'), kind: 'rest' }, { startAt: at('2027-03-15', '23:30'), endAt: at('2027-03-16', '00:30') }] }),
    // A shift from before job segments.
    { id: 'legacy', employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 20, clockInAt: at('2027-03-17', '08:00'), clockOutAt: at('2027-03-17', '12:00'), status: 'submitted', approvalStatus: 'approved', breaks: [], jobLabel: 'Old' },
    // A manager moved the clock-in later than the first segment, so its segments need review.
    segmented('corrected', at('2027-03-18', '08:30'), at('2027-03-18', '12:00'), [['general', '', '', at('2027-03-18', '08:00'), at('2027-03-18', '09:00')], ['work', 'job-a', 'A', at('2027-03-18', '09:00'), at('2027-03-18', '12:00')]]),
    // A gap between segments.
    segmented('gap', at('2027-03-19', '08:00'), at('2027-03-19', '17:00'), [['work', 'job-a', 'A', at('2027-03-19', '08:00'), at('2027-03-19', '10:00')], ['work', 'job-b', 'B', at('2027-03-19', '10:30'), at('2027-03-19', '17:00')]]),
    // Fall back, Nov 1 2026.
    segmented('fall', at('2026-10-31', '22:00'), at('2026-11-01', '06:00', '-07:00'), [['work', 'job-a', 'A', at('2026-10-31', '22:00'), at('2026-11-01', '01:30', '-07:00')], ['general', '', '', at('2026-11-01', '01:30', '-07:00'), at('2026-11-01', '06:00', '-07:00')]]),
    // Overtime: five 9-hour days, then a 13-hour Saturday at a higher rate with a bonus and tips; a pending card stays out.
    ...[22, 23, 24, 25, 26].map(date => segmented(`ot-${date}`, at(`2027-03-${date}`, '07:00'), at(`2027-03-${date}`, '16:00'), [['work', 'job-a', 'A', at(`2027-03-${date}`, '07:00'), at(`2027-03-${date}`, '16:00')]])),
    segmented('ot-27', at('2027-03-27', '06:00'), at('2027-03-27', '19:00'), [['travel', 'job-b', 'B', at('2027-03-27', '06:00'), at('2027-03-27', '06:30')], ['work', 'job-b', 'B', at('2027-03-27', '06:30'), at('2027-03-27', '19:00')]], { hourlyRate: 22, bonus: 50, tips: 10 }),
    { id: 'ot-28', employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 20, clockInAt: at('2027-03-28', '08:00'), clockOutAt: at('2027-03-28', '10:00'), status: 'submitted', approvalStatus: 'pending', breaks: [] },
  ];
  const jobTime = {};
  for (const [weekStart, tip] of Object.entries(TIP_ROWS)) {
    const week = computeTimesheetWeek({ timecards: cards, weekStart, now: '2027-04-30T12:00:00.000Z' }), [header, row, ...rest] = payrollCsv(week).trimEnd().split('\r\n');
    assert.equal(header, `${TIP_HEADER},"Job time"`);
    assert.deepEqual(rest, [], weekStart);
    assert.equal(row.slice(0, tip.length), tip, `${weekStart}: every column before Job time is byte-identical`);
    assert.match(row.slice(tip.length), /^,"[^"]*"$/, `${weekStart}: Job time is one appended cell`);
    jobTime[weekStart] = row.slice(tip.length + 2, -1);
    const time = week.employees[0].jobTime, parts = time.jobs.reduce((sum, job) => sum + job.workHours + job.travelHours, 0) + time.generalHours + time.untrackedHours + (time.reviewHours || 0);
    assert.equal(Math.round(parts * 1000) / 1000, week.employees[0].workedHours, `${weekStart}: Job time adds up to the worked hours`);
    assert.equal(week.employees[0].flags.includes('job_time_needs_review'), false, 'no review flag that nothing could clear');
  }
  assert.deepEqual(jobTime, {
    '2026-10-26': 'A: work 4.500 h; General company time 4.500 h',
    '2027-03-08': 'A: work 3.500 h, travel 1.000 h; General company time 2.500 h',
    '2027-03-15': 'M: work 4.250 h; N: work 0.000 h, travel 2.000 h; A: work 2.000 h; B: work 6.500 h; General company time 0.750 h; Job time needs manager review 3.500 h; No job segments 4.500 h',
    '2027-03-22': 'A: work 45.000 h; B: work 12.500 h, travel 0.500 h',
  });
  const corrected = computeTimesheetWeek({ timecards: cards, weekStart: '2027-03-15', now: '2027-04-30T12:00:00.000Z' }).employees[0].timecards.find(row => row.id === 'corrected');
  assert.deepEqual(plain(corrected.jobTime), { jobs: [], generalHours: 0, untrackedHours: 0, reviewHours: 3.5 }, 'the card is not split by job while its segments need review');
  assert.equal(jobTimeText(corrected.jobTime), 'Job time needs manager review 3.500 h', 'the Hub’s wording');
});

test('the Hub’s labels: the clock card names the segment running now, lists name per-job work and travel, and General company time only for general time', () => {
  const context = { console, Intl, Date, Promise, Map, Set, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {}, location: { pathname: '/employee', search: '' }, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, document: { readyState: 'loading', hidden: false, activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] } };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.ui={currentTimeLabel,jobTimeText,clockInPlace};})();'), context);
  const { currentTimeLabel, jobTimeText: hubText, clockInPlace } = context.ui, hour = 3600000;
  const time = (current, jobs = [], extra = {}) => ({ jobTime: { current, jobs, generalMs: 0, untrackedMs: 0, recorded: true, partialHistory: false, needsReview: false, ...extra } });
  assert.equal(currentTimeLabel(time({ kind: 'work', jobId: 'job-a', jobLabel: 'Synthetic Johnson Garage' })), 'Working on Synthetic Johnson Garage');
  assert.equal(currentTimeLabel(time({ kind: 'travel', jobId: 'job-a', jobLabel: 'Synthetic Johnson Garage' })), 'Travel to Synthetic Johnson Garage');
  assert.equal(currentTimeLabel(time({ kind: 'general', jobId: '' })), 'General company time');
  assert.equal(currentTimeLabel({ jobLabel: 'Synthetic Clock-in Job', pendingSync: true }), 'General company time', 'a clock-in only this phone has starts on general time, whatever job it was near');
  assert.equal(currentTimeLabel(time(null, [], { needsReview: true })), 'Job time needs manager review');
  assert.equal(currentTimeLabel({ jobLabel: 'Synthetic Old Label', jobTime: { recorded: false, jobs: [] } }), 'No job segments recorded');
  assert.equal(hubText(time(null, [{ jobId: 'job-a', jobLabel: 'Synthetic Johnson Garage', workMs: 2 * hour, travelMs: 0.5 * hour }], { generalMs: hour, untrackedMs: 0.25 * hour })), 'Synthetic Johnson Garage: work 2.00 h, travel 0.50 h; General company time 1.00 h; No job segments 0.25 h');
  assert.equal(hubText(time(null, [], { generalMs: 4 * hour })), 'General company time 4.00 h');
  assert.equal(hubText({ jobLabel: 'Synthetic Old Label' }), 'Job time not confirmed yet', 'no server job time, no guessed label');
  assert.deepEqual([clockInPlace({ lastLocation: point }), clockInPlace({ locationReview: 'location_unavailable_at_clock_in' }), clockInPlace({ locationStatus: 'location_unavailable_at_clock_in' }), clockInPlace({})], ['shared', 'missing', 'missing', '']);
  // The server's label wins (a card an older build tracked says so), and a card only this phone has yet is its one fix.
  assert.deepEqual([clockInPlace({ lastLocation: point, locationStatus: 'stopped', jobTime: { clockInLocation: 'tracked' } }), clockInPlace({ lastLocation: point, locationStatus: 'tracking' }), clockInPlace({ lastLocation: point, locationStatus: 'hub_single_fix', pendingSync: true })], ['tracked', 'tracked', 'shared']);
});
