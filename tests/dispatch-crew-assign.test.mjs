import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutateDispatch, mutateDispatchSelfAssignment } from '../functions/_lib/dispatch-service.js';
import { mutateBooking } from '../functions/_lib/dispatch-booking.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { CREW_NOTIFICATIONS } from '../functions/_lib/crew-notifications.js';
import { CREW_DAYS, DEFAULT_CREWS, crewAutoAssignEnabled, crewPriority, crewServes, crewServiceDays, eligibleCrews, pickCrew, projectCrewOpenings, serviceDaysInput, sortCrews, weekendCrew } from '../functions/_lib/dispatch-crew-assign.js';

// CREW-AUTO (owner decisions D2-D4, 2026-10-17): synthetic data only; every clock is injected.
// 2026-10-19 is a Monday and 2026-10-24 a Saturday, both after the 9:30 start policy date.
const NOW = '2026-10-17T15:00:00.000Z', MON = '2026-10-19', SAT = '2026-10-24';
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const sales = { user: 'Sales.Account', displayName: 'Synthetic Sales', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['sales'] };
const ACCESS = { EGC_STAFF_ROLE_ACCESS: 'true' }, AUTO = { ...ACCESS, EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' };
const crew = (id, name, memberIds, extra = {}) => ({ id, recordType: 'crew', name, memberIds, leadId: memberIds[0] || null, status: 'active', revision: `${id}r`, ...extra });
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
function fixture({ crews = null, notices = false, race = false } = {}) {
  const rows = new Map([
    ...['c1', 'c2', 'c3', 'c4'].map(id => [`customers/${id}`, { id, name: `Synthetic Customer ${id}`, phone: '9705550100', address: `${id} Fixture Lane`, revision: `${id}r` }]),
    ...(crews || [
      crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS, code: 'crew-1' }),
      crew('crew_two', 'Crew 2', ['c2a', 'c2b'], { priority: 2, serviceDays: WEEKDAYS, code: 'crew-2' }),
      crew('crew_three', 'Crew 3', ['c3a'], { priority: 3, serviceDays: ['sat', 'sun'], code: 'crew-3' }),
    ]).map(row => [`dispatchResources/${row.id}`, row]),
  ]);
  let revision = 0, conflicts = 0;
  // race: the first two dispatchState guard reads wait for each other (each keeps the snapshot it read), so both racers
  // read the guard before either commits and the second always loses the guard race. Without it, whether they overlapped
  // depended on when each one's SHA-256 fingerprint came back from the threadpool.
  let guardReads = 0, bothRead; const guardBarrier = new Promise(resolve => { bothRead = resolve; });
  const clone = value => structuredClone(value);
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const roster = ['zacb', 'c1a', 'c1b', 'c2a', 'c2b', 'c3a', 'c9z'].map(id => ({ id, name: `Synthetic ${id}`, role: id === 'zacb' ? 'owner' : 'crew' }));
  const store = {
    crewNotificationsEnabled: notices,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(roster),
    read: async (collection, id) => {
      const row = clone(rows.get(`${collection}/${id}`) || null);
      if (race && collection === 'dispatchState' && id === 'revision' && ++guardReads <= 2) { if (guardReads === 2) bothRead(); await guardBarrier; }
      return row;
    },
    commit: async writes => {
      for (const write of writes) {
        const old = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) { conflicts++; throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  const create = (changes = {}, extra = {}) => ({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: MON, time: '10:00', endTime: '12:00', jobInstructions: 'Synthetic garage reset', ...changes }, ...extra });
  const edit = (job, changes = {}) => ({ action: 'schedule.update', requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, changes });
  const auto = input => mutateDispatch(store, owner, input, NOW, { autoCrew: true });
  const book = (input, env = AUTO) => mutateBooking(store, sales, input, NOW, {}, env);
  const job = id => rows.get(`jobs/${id}`);
  return { rows, store, roster, create, edit, auto, book, job, conflicts: () => conflicts, guardReads: () => guardReads };
}

test('pure helpers: priority, service days, weekend crews and eligibility order', () => {
  assert.equal(crewAutoAssignEnabled({ EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' }), true);
  for (const value of ['TRUE', '1', 'yes', '', undefined]) assert.equal(crewAutoAssignEnabled({ EGC_DISPATCH_CREW_AUTO_ASSIGN: value }), false, String(value));
  assert.equal(crewPriority({}), 99, 'a legacy crew asks last'); assert.equal(crewPriority({ priority: 0 }), 99); assert.equal(crewPriority({ priority: 2 }), 2);
  assert.deepEqual(crewServiceDays({}), CREW_DAYS, 'a legacy crew works every day');
  assert.deepEqual(serviceDaysInput(['sun', 'sat']), ['sat', 'sun']);
  for (const bad of [[], ['mon', 'mon'], ['monday'], 'mon', null, [...CREW_DAYS, 'mon']]) assert.equal(serviceDaysInput(bad), null, JSON.stringify(bad));
  assert.equal(weekendCrew({ serviceDays: ['sat', 'sun'] }), true); assert.equal(weekendCrew({ serviceDays: ['fri', 'sat'] }), false); assert.equal(weekendCrew({}), false);
  assert.equal(crewServes({ serviceDays: WEEKDAYS }, MON), true); assert.equal(crewServes({ serviceDays: WEEKDAYS }, SAT), false);
  assert.equal(crewServes({ serviceDays: WEEKDAYS }, ['2026-10-23', SAT]), false, 'a two-day job needs a crew for both days');
  const roster = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const rows = [crew('z', 'Legacy', ['a']), crew('two', 'Crew 2', ['b'], { priority: 2 }), crew('one', 'Crew 1', ['c'], { priority: 1 }), crew('off', 'Off', ['d'], { priority: 1, status: 'inactive' }),
    crew('empty', 'Empty', [], { priority: 1 }), crew('gone', 'Gone', ['left'], { priority: 1 }), crew('wknd', 'Crew 3', ['d'], { priority: 3, serviceDays: ['sat', 'sun'] })];
  assert.deepEqual(eligibleCrews(rows, MON, roster).map(row => row.id), ['one', 'two', 'z'], 'priority, then legacy; inactive, empty and departed crews never');
  assert.deepEqual(eligibleCrews(rows, SAT, roster).map(row => row.id), ['one', 'two', 'wknd', 'z']);
  assert.deepEqual(eligibleCrews(rows, 'not-a-date', roster), []);
  assert.deepEqual(sortCrews([{ id: 'b', name: 'B' }, { id: 'a', name: 'A', priority: 5 }]).map(row => row.id), ['a', 'b']);
  assert.equal(pickCrew(eligibleCrews(rows, MON, roster), row => row.id !== 'one').id, 'two');
  assert.deepEqual(DEFAULT_CREWS.map(row => [row.code, row.priority, row.serviceDays.join()]), [['crew-1', 1, 'mon,tue,wed,thu,fri'], ['crew-2', 2, 'mon,tue,wed,thu,fri'], ['crew-3', 3, 'sat,sun']]);
  assert.deepEqual(projectCrewOpenings({ candidates: [{ date: MON, time: '09:30', endTime: '11:30', endDate: MON, crewId: 'one', crewName: 'Crew 1', priority: 1, employeeIds: ['c'], crewCode: 'crew-1' }, { date: MON, time: '09:30', endTime: '11:30' }] }),
    [{ date: MON, time: '09:30', endTime: '11:30', crewId: 'one', crewLabel: 'Crew 1', priority: 1 }], 'no employee ids, and only crew-mode rows');
});

test('two bookers racing for the same Monday slot get Crew 1 and Crew 2, never both Crew 1', async () => {
  const f = fixture({ race: true });
  const [first, second] = await Promise.all([f.auto(f.create({}, { customerId: 'c1' })), f.auto(f.create({}, { customerId: 'c2' }))]);
  assert.equal(f.conflicts(), 1, 'the second save lost the guard race and picked again');
  assert.equal(f.guardReads(), 3, 'both read the guard before either saved; the loser read it again');
  assert.deepEqual([first.job.crewId, second.job.crewId].sort(), ['crew_one', 'crew_two']);
  for (const result of [first, second]) {
    assert.equal(result.autoCrew.status, 'assigned');
    const saved = f.job(result.job.id), receipt = f.rows.get(`dispatchOperations/${result.requestId}`);
    assert.deepEqual(saved.assignedCrew, result.job.crewId === 'crew_one' ? ['c1a', 'c1b'] : ['c2a', 'c2b']);
    assert.equal(saved.crewLead, saved.assignedCrew[0]); assert.equal(saved.assignedTo, saved.assignedCrew.join(', '));
    assert.deepEqual([saved.crewAutoAssigned.crewId, saved.crewAutoAssigned.mode, saved.crewAutoAssigned.by], [result.job.crewId, 'pick', 'zacb']);
    assert.deepEqual(receipt.metadata.crewAutoAssigned, result.autoCrew); assert.deepEqual(receipt.after.crewAutoAssigned, saved.crewAutoAssigned);
    assert.equal(f.rows.get(`jobs/_egc_schedule_lock_${MON}`).entries.find(entry => entry.id === result.job.id).assignedCrew.join(), saved.assignedCrew.join(), 'the day lock holds the picked crew');
  }
  const third = await f.auto(f.create({}, { customerId: 'c3' }));
  assert.deepEqual([third.autoCrew.status, third.job.assignedCrew], ['unassigned', []], 'two weekday crews, so the third waits; Crew 3 never works a Monday');
});

test('Crew 1 already booked Monday: the job goes to Crew 2; Saturday goes only to Crew 3; inactive crews are skipped', async () => {
  const f = fixture();
  await mutateDispatch(f.store, owner, f.create({ time: '09:30', endTime: '17:00', assignedCrew: ['c1a', 'c1b'], crewId: 'crew_one' }, { customerId: 'c4' }), NOW);
  const monday = await f.auto(f.create());
  assert.deepEqual([monday.job.crewId, monday.autoCrew.crewName, monday.autoCrew.priority], ['crew_two', 'Crew 2', 2]);
  const saturday = await f.auto(f.create({ date: SAT }, { customerId: 'c2' }));
  assert.deepEqual([saturday.job.crewId, saturday.job.assignedCrew], ['crew_three', ['c3a']]);
  const full = await f.auto(f.create({ date: SAT }, { customerId: 'c3' }));
  assert.deepEqual([full.autoCrew.status, full.job.crewId], ['unassigned', null], 'Saturday never spills to the weekday crews');
  const g = fixture({ crews: [crew('crew_one', 'Crew 1', ['c1a'], { priority: 1, status: 'inactive' }), crew('crew_two', 'Crew 2', ['c2a'], { priority: 2 }), crew('crew_x', 'Crew X', ['c9z', 'gone.person'], { priority: 1 })] });
  assert.equal((await g.auto(g.create())).job.crewId, 'crew_two', 'an inactive crew and a crew with a departed member are never picked');
});

test('nobody free: the booking is kept unassigned with Sold: needs crew and rep-safe alternatives', async () => {
  const f = fixture();
  const blockers = [];
  for (const [id, crewId, members] of [['c3', 'crew_one', ['c1a', 'c1b']], ['c4', 'crew_two', ['c2a', 'c2b']]]) blockers.push(await mutateDispatch(f.store, owner, f.create({ time: '09:30', endTime: '17:00', assignedCrew: members, crewId }, { customerId: id }), NOW));
  const result = await f.auto(f.create());
  const saved = f.job(result.job.id);
  assert.deepEqual([saved.status, saved.date, saved.time, saved.assignedCrew, saved.crewId], ['scheduled', MON, '10:00', [], null], 'the visit is saved at the time asked for');
  assert.deepEqual([saved.soldNeedsCrew.reason, saved.soldNeedsCrew.by, saved.crewAutoAssigned], ['no_crew_free', 'zacb', undefined]);
  assert.ok(result.warnings.some(row => row.code === 'no_crew_available')); assert.ok(result.warnings.some(row => row.code === 'sold_needs_crew'));
  assert.deepEqual([result.autoCrew.status, result.autoCrew.crewId], ['unassigned', null]);
  assert.ok(result.autoCrew.alternatives.length > 0 && result.autoCrew.alternatives.length <= 10);
  for (const row of result.autoCrew.alternatives) assert.deepEqual(Object.keys(row).sort(), ['crewId', 'crewLabel', 'date', 'endTime', 'priority', 'time']);
  assert.deepEqual(result.autoCrew.alternatives[0], { date: '2026-10-20', time: '09:30', endTime: '11:30', crewId: 'crew_one', crewLabel: 'Crew 1', priority: 1 }, 'the next weekday, Crew 1 first, from 9:30');
  assert.deepEqual(f.rows.get(`dispatchOperations/${result.requestId}`).metadata.crewAutoAssigned, { status: 'unassigned', mode: 'pick', crewId: null });
  assert.deepEqual(blockers.map(row => row.job.crewId), ['crew_one', 'crew_two'], 'the hand-staffed blockers kept their crews');
});

test('a replayed request answers the same crew without picking again', async () => {
  const f = fixture(), input = f.create(), first = await f.auto(input), again = await f.auto(input);
  assert.equal(again.replayed, true); assert.deepEqual(again.autoCrew, first.autoCrew);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('jobs/') && !key.includes('_egc_')).length, 1);
});

test('crew notices go out exactly once for an auto-assigned crew, even after a lost guard race', async () => {
  const f = fixture({ notices: true, race: true });
  const results = await Promise.all([f.auto(f.create({}, { customerId: 'c1' })), f.auto(f.create({}, { customerId: 'c2' }))]);
  assert.equal(f.conflicts(), 1, 'the second save lost the guard race and picked again');
  const notices = [...f.rows.entries()].filter(([key]) => key.startsWith(`${CREW_NOTIFICATIONS}/`)).map(([, row]) => row);
  for (const result of results) {
    const mine = notices.filter(row => row.jobId === result.job.id);
    assert.deepEqual(mine.map(row => row.employee || row.employeeId || row.recipient).sort(), [...f.job(result.job.id).assignedCrew].sort(), 'one assignment notice per crew member');
    assert.ok(mine.every(row => row.dispatchRequestId === result.requestId));
  }
  assert.equal(notices.length, 4);
});

test('moves: an auto-assigned job re-picks (weekday to weekend goes to Crew 3); a hand-picked crew stays with a crew_off_day warning', async () => {
  const f = fixture();
  const booked = await f.book(f.create());
  assert.equal(booked.job.crewId, 'crew_one');
  const moved = await f.book(f.edit(f.job(booked.job.id), { date: SAT, time: '10:00', endTime: '12:00' }));
  assert.deepEqual([moved.job.crewId, moved.job.assignedCrew, moved.autoCrew.mode], ['crew_three', ['c3a'], 'repick']);
  const back = await f.book(f.edit(f.job(booked.job.id), { date: MON, time: '13:00', endTime: '15:00' }));
  assert.equal(back.job.crewId, 'crew_one');
  // A dispatcher's own crew: kept on a day it does not work, with a warning (D4).
  const hand = await mutateDispatch(f.store, owner, f.create({ assignedCrew: ['c2a', 'c2b'], crewId: 'crew_two' }, { customerId: 'c2' }), NOW, { autoCrew: 'opt_in' });
  assert.equal(hand.autoCrew, undefined);
  const weekend = await mutateDispatch(f.store, owner, f.edit(f.job(hand.job.id), { date: SAT }), NOW, { autoCrew: 'opt_in' });
  assert.deepEqual([weekend.job.crewId, weekend.job.assignedCrew], ['crew_two', ['c2a', 'c2b']]);
  assert.deepEqual(weekend.warnings.filter(row => row.code === 'crew_off_day').map(row => [row.crewId, row.message]), [['crew_two', 'Crew 2 does not work Saturdays. Check the crew or move the visit.']]);
  // A dispatcher moving an auto-assigned job to a day its crew does not work: re-picked even without asking.
  const auto = await f.book(f.create({}, { customerId: 'c3' }));
  const dispatcherMove = await mutateDispatch(f.store, owner, f.edit(f.job(auto.job.id), { date: SAT }), NOW, { autoCrew: 'opt_in' });
  assert.equal(dispatcherMove.autoCrew.mode, 'repick'); assert.notEqual(dispatcherMove.job.crewId, auto.job.crewId);
  // ...but asking for no pick keeps it, with the warning.
  const kept = await mutateDispatch(f.store, owner, { ...f.edit(f.job(back.job.id), { date: SAT }), autoCrew: false }, NOW, { autoCrew: 'opt_in' });
  assert.equal(kept.job.crewId, 'crew_one'); assert.ok(kept.warnings.some(row => row.code === 'crew_off_day'));
});

test('a dispatcher picks only when asking; a To-schedule job dated later is staffed then', async () => {
  const f = fixture();
  const plain = await mutateDispatch(f.store, owner, f.create(), NOW, { autoCrew: 'opt_in' });
  assert.deepEqual([plain.job.assignedCrew, plain.autoCrew], [[], undefined]);
  const asked = await mutateDispatch(f.store, owner, { ...f.create({}, { customerId: 'c2' }), autoCrew: true }, NOW, { autoCrew: 'opt_in' });
  assert.equal(asked.job.crewId, 'crew_one');
  await assert.rejects(mutateDispatch(f.store, owner, { ...f.create({}, { customerId: 'c3' }), autoCrew: 'yes' }, NOW, { autoCrew: 'opt_in' }), error => error.code === 'dispatch_auto_crew_invalid');
  const later = await f.book(f.create({ date: '', time: '', endTime: '' }, { customerId: 'c3' }));
  assert.deepEqual([later.job.status, later.job.assignedCrew, later.autoCrew], ['unscheduled', [], undefined], 'no date, no crew yet');
  const dated = await f.book(f.edit(f.job(later.job.id), { date: MON, time: '13:00', endTime: '15:00' }));
  assert.deepEqual([dated.job.status, dated.job.crewId, dated.autoCrew.mode], ['scheduled', 'crew_one', 'pick']);
  const walk = await f.book(f.create({ date: MON, time: '09:00', endTime: '10:00' }, { kind: 'walkthrough', customerId: 'c4' }));
  assert.deepEqual([walk.job.assignedCrew, walk.autoCrew], [[], undefined], 'walkthroughs are never crew-staffed');
});

test('a booker may only accept a server-eligible crew; raw people stay 403', async () => {
  const f = fixture();
  const chosen = await f.book(f.create({ crewId: 'crew_two' }));
  assert.deepEqual([chosen.job.crewId, chosen.autoCrew.mode, chosen.autoCrew.requestedCrewId], ['crew_two', 'choice', 'crew_two']);
  await assert.rejects(f.book(f.create({ crewId: 'crew_three' }, { customerId: 'c2' })), error => error.code === 'dispatch_crew_not_eligible' && error.status === 403, 'the weekend crew does not work Mondays');
  await assert.rejects(f.book(f.create({ assignedCrew: ['c2a'] }, { customerId: 'c2' })), error => error.code === 'dispatch_forbidden' && error.status === 403);
  await assert.rejects(f.book(f.create({ crewId: 'crew_two', crewLead: 'c2b' }, { customerId: 'c2' })), error => error.code === 'dispatch_forbidden');
  await assert.rejects(f.book(f.create({ crewId: 'crew_one', date: '', time: '', endTime: '' }, { customerId: 'c2' })), error => error.code === 'dispatch_crew_not_eligible', 'no crew for an undated visit');
  await assert.rejects(f.book(f.edit(f.job(chosen.job.id), { crewId: null })), error => error.code === 'dispatch_crew_not_eligible', 'a booker cannot unstaff a job');
  // The chosen crew was taken meanwhile: the next free crew, never a lost booking.
  const taken = await f.book(f.create({ crewId: 'crew_two' }, { customerId: 'c3' }));
  assert.deepEqual([taken.job.crewId, taken.warnings.find(row => row.code === 'crew_choice_unavailable')?.crewId], ['crew_one', 'crew_two']);
  // A reschedule that sends the shown crew back is a booking, as before.
  const echo = await f.book(f.edit(f.job(chosen.job.id), { time: '13:00', endTime: '15:00', crewId: 'crew_two', assignedCrew: ['c2a', 'c2b'], crewLead: 'c2a' }));
  assert.equal(echo.job.crewId, 'crew_two');
});

test('flag off: bookings are exactly as before; the flag is read as exactly "true"', async () => {
  const runs = [];
  for (const env of [ACCESS, { ...ACCESS, EGC_DISPATCH_CREW_AUTO_ASSIGN: 'TRUE' }, { ...ACCESS, EGC_DISPATCH_CREW_AUTO_ASSIGN: '1' }]) {
    const f = fixture(), input = { ...f.create(), requestId: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0101' };
    const result = await f.book(input, env);
    assert.deepEqual([result.job.assignedCrew, result.job.crewId, result.autoCrew], [[], null, undefined]);
    const saved = f.job(result.job.id);
    assert.equal(saved.crewAutoAssigned, undefined); assert.equal(saved.soldNeedsCrew, undefined);
    assert.equal(f.rows.get(`dispatchOperations/${input.requestId}`).metadata, undefined);
    await assert.rejects(f.book(f.create({ crewId: 'crew_one' }, { customerId: 'c2' }), env), error => error.code === 'dispatch_forbidden', 'crew stays a manager decision');
    await assert.rejects(f.book({ ...f.create({}, { customerId: 'c2' }), autoCrew: true }, env), error => error.code === 'dispatch_patch_not_allowed');
    runs.push(JSON.stringify(Object.fromEntries([...f.rows].sort(([a], [b]) => a.localeCompare(b)))));
  }
  assert.equal(new Set(runs).size, 1, 'every non-"true" value stores byte-identical documents');
  // The same create with no autoCrew option at all (a manager's save before this unit) stores the same visit.
  const g = fixture(), input = { ...g.create(), requestId: '0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a0101' };
  const base = await mutateDispatch(g.store, owner, input, NOW);
  assert.deepEqual([base.job.assignedCrew, base.autoCrew, g.job(base.job.id).crewAutoAssigned], [[], undefined, undefined]);
});

// Recorded from the code before crew auto-assign (fe998f5) running this exact flag-off sequence on
// legacy crews: a booker books, a manager staffs Crew 1, the booker moves it, a manager staffs a
// second visit by hand. Any new key or value in a flag-off save fails here, not only a difference
// between flag values.
const LEGACY_JOB_KEYS = ['address', 'assignedCrew', 'assignedTo', 'bookedBy', 'bookingChannel', 'bookingKey', 'channelSelfReported', 'createdAt', 'createdBy', 'crewId', 'crewLead', 'crewNeeded', 'crmLinkReason', 'customer', 'customerId', 'date', 'dispatchRequestId', 'dispatchUpdatedAt', 'email', 'endAt', 'endDate', 'endTime', 'highlevelContactId', 'id', 'openShift', 'operationalScope', 'phone', 'pipelineStatus', 'projectId', 'revision', 'scheduleOccurrence', 'scheduleSource', 'startAt', 'status', 'syncStatus', 'time', 'timeZone', 'travelBufferMinutes', 'type', 'updatedAt', 'updatedBy', 'vehicleId', 'visitPurpose'];
const LEGACY_RECEIPT_KEYS = ['action', 'actorId', 'after', 'before', 'collection', 'createdAt', 'fingerprint', 'id', 'requestId', 'revision', 'targetId', 'warnings'];
const LEGACY_AUDIT_KEYS = ['address', 'assignedCrew', 'assignedTo', 'bookingChannel', 'channelSelfReported', 'crewId', 'crewLead', 'crewNeeded', 'crmLinkReason', 'date', 'endDate', 'endTime', 'openShift', 'operationalScope', 'pipelineStatus', 'scheduleOccurrence', 'status', 'time', 'travelBufferMinutes', 'vehicleId', 'visitPurpose'];
const LEGACY_SCOPE = { text: 'Synthetic garage reset', updatedBy: 'Sales.Account', updatedAt: NOW, reason: 'Updated in dispatch', approvalKind: 'staff_operational_instructions' };
const LEGACY_MOVE_AUDIT = { date: MON, endDate: MON, status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['c1a', 'c1b'], assignedTo: 'c1a, c1b', crewId: 'crew_one', crewLead: 'c1a', vehicleId: null, operationalScope: LEGACY_SCOPE, crewNeeded: 1, travelBufferMinutes: 20, address: 'c1 Fixture Lane', openShift: false, visitPurpose: 'service', bookingChannel: null, channelSelfReported: null, crmLinkReason: null };
const LEGACY_LOCK = { recordType: 'schedule_lock', date: MON, entries: [
  { id: 'visit_f1147b7268d1337da5a2c865a507e03a12f82395', type: 'job', start: '13:00', end: '15:00', label: 'Synthetic Customer c1', status: 'scheduled', assignedCrew: ['c1a', 'c1b'], assignmentKnown: true, vehicleId: null, updatedAt: NOW },
  { id: 'visit_2b843668c4bd2323db81859398ca1bb050adbd62', type: 'job', start: '10:00', end: '12:00', label: 'Synthetic Customer c2', status: 'scheduled', assignedCrew: ['c2a', 'c9z'], assignmentKnown: true, vehicleId: null, updatedAt: NOW }],
  updatedAt: NOW, id: `_egc_schedule_lock_${MON}`, revision: 'r18' };
test('flag off: saves, receipts and locks have exactly the keys and values the code before crew auto-assign stored', async () => {
  for (const env of [ACCESS, { ...ACCESS, EGC_DISPATCH_CREW_AUTO_ASSIGN: 'false' }]) {
    const f = fixture({ crews: [crew('crew_one', 'Crew 1', ['c1a', 'c1b']), crew('crew_two', 'Crew 2', ['c2a', 'c2b'])] }), id = n => `0b6f6c52-5a0d-4d2e-9a51-7d0e1c2a010${n}`;
    const booked = await f.book({ ...f.create(), requestId: id(1) }, env);
    assert.deepEqual([Object.keys(booked).sort(), booked.warnings.map(row => row.code)], [['job', 'ok', 'providerSync', 'requestId', 'warnings'], ['unassigned', 'crew_size_short']]);
    const jobId = booked.job.id;
    assert.equal(jobId, 'visit_f1147b7268d1337da5a2c865a507e03a12f82395');
    assert.deepEqual([f.job(jobId).assignedCrew, f.job(jobId).crewId, f.job(jobId).crewLead, f.job(jobId).assignedTo], [[], null, null, '']);
    const staffed = await mutateDispatch(f.store, owner, { ...f.edit(f.job(jobId), { crewId: 'crew_one' }), requestId: id(2) }, NOW);
    const moved = await f.book({ ...f.edit(f.job(jobId), { time: '13:00', endTime: '15:00' }), requestId: id(3) }, env);
    const second = await mutateDispatch(f.store, owner, { ...f.create({ assignedCrew: ['c2a', 'c9z'], crewLead: 'c2a', jobInstructions: 'Synthetic second job' }, { customerId: 'c2' }), requestId: id(4) }, NOW);
    for (const result of [staffed, moved, second]) assert.deepEqual([Object.keys(result).sort(), result.warnings], [['job', 'ok', 'providerSync', 'requestId', 'warnings'], []]);
    for (const visit of [jobId, second.job.id]) assert.deepEqual(Object.keys(f.job(visit)).sort(), LEGACY_JOB_KEYS, visit);
    for (const n of [1, 2, 3, 4]) {
      const receipt = f.rows.get(`dispatchOperations/${id(n)}`);
      assert.deepEqual(Object.keys(receipt).sort(), LEGACY_RECEIPT_KEYS, `receipt ${n}: no metadata`);
      assert.deepEqual(Object.keys(receipt.after).sort(), LEGACY_AUDIT_KEYS, `receipt ${n} audit`);
    }
    const move = f.rows.get(`dispatchOperations/${id(3)}`);
    assert.deepEqual([move.before, move.after, move.warnings], [{ ...LEGACY_MOVE_AUDIT, time: '10:00', endTime: '12:00', scheduleOccurrence: 1 }, { ...LEGACY_MOVE_AUDIT, time: '13:00', endTime: '15:00', scheduleOccurrence: 2 }, []]);
    assert.deepEqual(f.rows.get(`jobs/_egc_schedule_lock_${MON}`), LEGACY_LOCK);
  }
});

test('the dispatch API: a booker is staffed by the server; a dispatcher opts in; GET says when the flag is on', async () => {
  const f = fixture(), post = (actor, env, body) => dispatchHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW) }).post({ env, request: new Request('https://egc.test/api/dispatch', { method: 'POST', headers: { Origin: 'https://egc.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const booked = await post(sales, AUTO, f.create());
  assert.equal(booked.status, 200); assert.equal((await booked.json()).job.crewId, 'crew_one');
  const manager = await post(owner, AUTO, f.create({}, { customerId: 'c2' }));
  assert.deepEqual((await manager.json()).job.assignedCrew, [], 'a dispatcher save without autoCrew picks nobody');
  const opted = await post(owner, AUTO, { ...f.create({}, { customerId: 'c3' }), autoCrew: true });
  assert.equal((await opted.json()).job.crewId, 'crew_two');
  const refused = await post(owner, ACCESS, { ...f.create({}, { customerId: 'c4' }), autoCrew: true });
  assert.deepEqual([refused.status, (await refused.json()).code], [400, 'dispatch_patch_not_allowed'], 'flag off: the key is unknown, as before');
  const get = env => dispatchHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(NOW) }).get({ env, request: new Request(`https://egc.test/api/dispatch?startDate=${MON}&endDate=2026-10-20`) });
  assert.equal((await (await get(AUTO)).json()).crewAutoAssign, true);
  assert.equal(Object.hasOwn(await (await get(ACCESS)).json(), 'crewAutoAssign'), false);
});

test('crew registry v2: priority, service days and code are validated, audited and saved only when sent', async () => {
  const f = fixture({ crews: [] }), save = changes => mutateDispatch(f.store, owner, { action: 'crew.save', requestId: randomUUID(), changes }, NOW);
  const legacy = await save({ name: 'Legacy Crew', memberIds: ['c1a'], leadId: 'c1a', status: 'active' });
  assert.deepEqual(Object.keys(f.rows.get(`dispatchResources/${legacy.resource.id}`)).filter(key => ['priority', 'serviceDays', 'code'].includes(key)), [], 'a crew saved without them keeps the old shape');
  const v2 = await save({ name: 'Crew 3', memberIds: ['c3a'], leadId: 'c3a', status: 'active', priority: 3, serviceDays: ['sun', 'sat'], code: 'crew-3' });
  assert.deepEqual([v2.resource.priority, v2.resource.serviceDays, v2.resource.code], [3, ['sat', 'sun'], 'crew-3']);
  const receipt = f.rows.get(`dispatchOperations/${v2.requestId}`);
  assert.deepEqual([receipt.after.priority, receipt.after.serviceDays, receipt.after.code], [3, ['sat', 'sun'], 'crew-3']);
  for (const [changes, code] of [[{ priority: 0 }, 'dispatch_invalid_field'], [{ priority: 100 }, 'dispatch_invalid_field'], [{ priority: '1' }, 'dispatch_invalid_field'], [{ serviceDays: [] }, 'dispatch_crew_days_invalid'], [{ serviceDays: ['mon', 'mon'] }, 'dispatch_crew_days_invalid'], [{ serviceDays: ['funday'] }, 'dispatch_crew_days_invalid'], [{ code: 'Crew 1' }, 'dispatch_crew_code_invalid'], [{ code: '-x' }, 'dispatch_crew_code_invalid'], [{ code: 'crew-3' }, 'dispatch_crew_code_taken']])
    await assert.rejects(save({ name: 'Other', memberIds: [], status: 'active', ...changes }), error => error.code === code, JSON.stringify(changes));
  const current = f.rows.get(`dispatchResources/${v2.resource.id}`);
  const cleared = await mutateDispatch(f.store, owner, { action: 'crew.save', requestId: randomUUID(), id: current.id, expectedRevision: current.revision, changes: { priority: null, code: 'crew-3' } }, NOW);
  assert.deepEqual([cleared.resource.priority, cleared.resource.code, cleared.resource.serviceDays], [null, 'crew-3', ['sat', 'sun']], 'its own code is not taken; null clears back to the default');
});

test('crew.seed_defaults creates Crew 1, 2 and 3 once, adopts a same-named crew and replays its receipt', async () => {
  const f = fixture({ crews: [crew('handmade', 'Crew 2', ['c2a'], { priority: 5 })] }), input = { action: 'crew.seed_defaults', requestId: randomUUID() };
  const seeded = await mutateDispatch(f.store, owner, input, NOW);
  assert.equal(seeded.created.length, 2); assert.deepEqual(seeded.updated, ['handmade']); assert.deepEqual(seeded.existing, []);
  const crews = [...f.rows.values()].filter(row => row.recordType === 'crew').sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(crews.map(row => [row.name, row.code, row.priority, row.serviceDays.join(), row.status, row.memberIds.length]), [['Crew 1', 'crew-1', 1, 'mon,tue,wed,thu,fri', 'active', 0], ['Crew 2', 'crew-2', 5, 'mon,tue,wed,thu,fri', 'active', 1], ['Crew 3', 'crew-3', 3, 'sat,sun', 'active', 0]], 'the adopted crew keeps its own priority and members');
  assert.ok(seeded.warnings.some(row => row.code === 'crew_members_needed'));
  const replay = await mutateDispatch(f.store, owner, input, NOW);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.created, seeded.created);
  const again = await mutateDispatch(f.store, owner, { action: 'crew.seed_defaults', requestId: randomUUID() }, NOW);
  assert.deepEqual([again.created, again.updated, again.existing.length], [[], [], 3], 'idempotent by code');
  assert.equal([...f.rows.values()].filter(row => row.recordType === 'crew').length, 3);
  await assert.rejects(mutateDispatch(f.store, owner, { ...input, requestId: randomUUID(), changes: {} }, NOW), error => error.code === 'dispatch_patch_not_allowed');
  await assert.rejects(f.book({ action: 'crew.seed_defaults', requestId: randomUUID() }), error => error.code === 'dispatch_forbidden' && error.status === 403, 'bookers never create crews');
  // Seeded crews have no members, so they are never picked until the owner adds people.
  const job = await f.auto(f.create({ date: SAT }));
  assert.equal(job.autoCrew.status, 'unassigned');
});

test('the operations scheduler (egc.schedule_visit) staffs the same way under its own day lock', async () => {
  const f = fixture();
  const store = { ...f.store, crewAutoAssign: true, day: async date => [...f.rows.values()].filter(row => row.date === date && !row.recordType), customers: async () => [] }, actor = { id: 'synthetic-owner', kind: 'human', role: 'owner' };
  const visit = (changes, customer = 'c1') => mutateScheduledVisit(store, actor, { requestId: randomUUID(), mode: 'create', kind: 'job', portalCustomerId: customer, changes: { date: MON, time: '10:00', endTime: '12:00', ...changes } }, NOW);
  const first = await visit({});
  assert.deepEqual([first.autoCrew.status, f.job(first.visit.portalVisitId).crewId, f.job(first.visit.portalVisitId).assignedTo], ['assigned', 'crew_one', 'c1a, c1b']);
  const second = await visit({}, 'c2');
  assert.equal(f.job(second.visit.portalVisitId).crewId, 'crew_two');
  const third = await visit({}, 'c3');
  const kept = f.job(third.visit.portalVisitId);
  assert.deepEqual([third.autoCrew.status, kept.assignedCrew, kept.soldNeedsCrew.reason, kept.status], ['unassigned', [], 'no_crew_free', 'scheduled'], 'kept, never refused for staffing');
  const weekend = await visit({ date: SAT }, 'c4');
  assert.equal(f.job(weekend.visit.portalVisitId).crewId, 'crew_three');
  const named = await mutateScheduledVisit(store, actor, { requestId: randomUUID(), mode: 'create', kind: 'job', portalCustomerId: 'c4', changes: { date: '2026-10-20', time: '10:00', endTime: '12:00', assignedTo: 'Someone Named' } }, NOW);
  assert.equal(f.job(named.visit.portalVisitId).crewId, undefined, 'a named assignee is never replaced');
  const off = await mutateScheduledVisit({ ...store, crewAutoAssign: false }, actor, { requestId: randomUUID(), mode: 'create', kind: 'job', portalCustomerId: 'c4', changes: { date: '2026-10-21', time: '10:00', endTime: '12:00' } }, NOW);
  const legacy = f.job(off.visit.portalVisitId);
  assert.deepEqual([off.autoCrew, legacy.assignedCrew, legacy.crewId], [undefined, undefined, undefined], 'flag off: as before');
});

test('a booker never replaces or wipes a crew a manager chose; resending the shown crew is still a booking', async () => {
  const f = fixture();
  // The owner staffs a Monday visit by hand with someone on no crew.
  const hand = await mutateDispatch(f.store, owner, f.create({ assignedCrew: ['c9z'] }, { customerId: 'c4' }), NOW);
  const before = f.job(hand.job.id);
  await assert.rejects(f.book(f.edit(before, { crewId: 'crew_two' })), error => error.code === 'dispatch_crew_not_eligible' && error.status === 403 && /manager chose the crew/.test(error.message));
  assert.deepEqual(f.job(hand.job.id), before, 'nothing saved');
  // The owner puts the weekend crew on a Monday by hand while Crew 1 is busy all day: a booker's
  // choice of Crew 1 is refused instead of clearing the visit to Sold: needs crew.
  await mutateDispatch(f.store, owner, f.create({ time: '09:30', endTime: '17:00', assignedCrew: ['c1a', 'c1b'], crewId: 'crew_one' }, { customerId: 'c2' }), NOW);
  const weekend = await mutateDispatch(f.store, owner, f.create({ assignedCrew: ['c3a'], crewId: 'crew_three' }, { customerId: 'c3' }), NOW);
  for (const crewId of ['crew_one', 'crew_two']) await assert.rejects(f.book(f.edit(f.job(weekend.job.id), { crewId })), error => error.code === 'dispatch_crew_not_eligible' && error.status === 403, crewId);
  const staffed = f.job(weekend.job.id);
  assert.deepEqual([staffed.crewId, staffed.assignedCrew, staffed.soldNeedsCrew], ['crew_three', ['c3a'], undefined]);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('dispatchOperations/')).length, 3, 'no refused save left a receipt');
  // A reschedule that sends the shown crew back keeps the manager's crew, with the off-day warning.
  const moved = await f.book(f.edit(staffed, { time: '13:00', endTime: '15:00', crewId: 'crew_three', assignedCrew: ['c3a'], crewLead: 'c3a' }));
  assert.deepEqual([moved.job.crewId, moved.job.assignedCrew, moved.autoCrew], ['crew_three', ['c3a'], undefined]);
  assert.ok(moved.warnings.some(row => row.code === 'crew_off_day'));
});

test('a crew choice on a job the server staffed never unstaffs it: its own crew is next, else it keeps its crew', async () => {
  const f = fixture();
  const booked = await f.book(f.create());
  assert.deepEqual([booked.job.crewId, f.job(booked.job.id).crewAutoAssigned.memberIds, f.job(booked.job.id).crewAutoAssigned.leadId], ['crew_one', ['c1a', 'c1b'], 'c1a'], 'the job keeps the snapshot the pick set');
  assert.equal(Object.hasOwn(booked.autoCrew, 'memberIds'), false, 'the answer and receipt name the crew, not its people');
  // Crew 2 is busy then: the chosen crew is not free, so the job stays with Crew 1.
  await mutateDispatch(f.store, owner, f.create({ time: '09:30', endTime: '17:00', assignedCrew: ['c2a', 'c2b'], crewId: 'crew_two' }, { customerId: 'c4' }), NOW);
  const stay = await f.book(f.edit(f.job(booked.job.id), { crewId: 'crew_two' }));
  assert.deepEqual([stay.job.crewId, stay.job.assignedCrew, stay.autoCrew.status, stay.autoCrew.mode, stay.autoCrew.requestedCrewId], ['crew_one', ['c1a', 'c1b'], 'assigned', 'choice', 'crew_two']);
  assert.equal(stay.warnings.find(row => row.code === 'crew_choice_unavailable').message, 'The chosen crew is not free at this time, so the visit keeps Crew 1.');
  // Crew 1 is made inactive and Crew 2 is still busy: nobody can be picked, and the visit keeps its people (status kept).
  const crewOne = f.rows.get('dispatchResources/crew_one');
  await mutateDispatch(f.store, owner, { action: 'crew.save', requestId: randomUUID(), id: 'crew_one', expectedRevision: crewOne.revision, changes: { status: 'inactive' } }, NOW);
  const kept = await f.book(f.edit(f.job(booked.job.id), { crewId: 'crew_two' }));
  const saved = f.job(booked.job.id);
  assert.deepEqual([kept.autoCrew, saved.crewId, saved.assignedCrew, saved.crewLead, saved.soldNeedsCrew], [{ status: 'kept', mode: 'choice', crewId: 'crew_one', requestedCrewId: 'crew_two' }, 'crew_one', ['c1a', 'c1b'], 'c1a', undefined]);
  assert.ok(!kept.warnings.some(row => row.code === 'no_crew_available'));
  assert.deepEqual(f.rows.get(`dispatchOperations/${kept.requestId}`).metadata.crewAutoAssigned, kept.autoCrew);
  // With a move its crew cannot make either, the save is refused: the visit stays where it was, staffed.
  await mutateDispatch(f.store, owner, f.create({ time: '13:00', endTime: '15:00', assignedCrew: ['c1a'] }, { customerId: 'c3' }), NOW);
  await assert.rejects(f.book(f.edit(f.job(booked.job.id), { crewId: 'crew_two', time: '13:00', endTime: '15:00' })), error => error.code === 'dispatch_conflict' && error.status === 409);
  assert.deepEqual([f.job(booked.job.id).time, f.job(booked.job.id).assignedCrew], ['10:00', ['c1a', 'c1b']]);
});

test('a manager edit or a pickup claim makes the crew a hand pick: moves never re-pick over it (MCP moves too)', async () => {
  const f = fixture();
  const booked = await f.book(f.create());
  const edited = await mutateDispatch(f.store, owner, f.edit(f.job(booked.job.id), { assignedCrew: ['c1a', 'c9z'], crewId: 'crew_one', crewLead: 'c1a' }), NOW, { autoCrew: 'opt_in' });
  assert.deepEqual([f.job(booked.job.id).crewAutoAssigned, f.rows.get(`dispatchOperations/${edited.requestId}`).after.crewAutoAssigned], [null, null], 'the pick record goes with the hand edit');
  const moved = await f.book(f.edit(f.job(booked.job.id), { time: '13:00', endTime: '15:00' }));
  assert.deepEqual([moved.job.crewId, moved.job.assignedCrew, moved.autoCrew], ['crew_one', ['c1a', 'c9z'], undefined], 'c9z stays and c1b is not put back');
  await assert.rejects(f.book(f.edit(f.job(booked.job.id), { crewId: 'crew_two' })), error => error.code === 'dispatch_crew_not_eligible');
  // A lead change alone is a hand pick as well.
  const g = fixture(), other = await g.book(g.create());
  await mutateDispatch(g.store, owner, g.edit(g.job(other.job.id), { crewLead: 'c1b' }), NOW);
  assert.equal(g.job(other.job.id).crewAutoAssigned, null);
  assert.equal((await g.book(g.edit(g.job(other.job.id), { time: '13:00', endTime: '15:00' }))).job.crewLead, 'c1b');
  // A pickup claim adds a member without touching the record: it no longer matches, so neither a
  // booker's nor an egc.schedule_visit move re-picks the crew without the claimer.
  const h = fixture(), open = await h.book(h.create());
  await mutateDispatch(h.store, owner, h.edit(h.job(open.job.id), { crewNeeded: 3, shiftPickupEnabled: true }), NOW);
  assert.equal(h.job(open.job.id).crewAutoAssigned.crewId, 'crew_one', 'offering a seat keeps the pick');
  await mutateDispatchSelfAssignment(h.store, { user: 'c9z' }, { action: 'claim', jobId: open.job.id, requestId: randomUUID() }, NOW);
  assert.deepEqual(h.job(open.job.id).assignedCrew, ['c1a', 'c1b', 'c9z']);
  const store = { ...h.store, crewAutoAssign: true, day: async date => [...h.rows.values()].filter(row => row.date === date && !row.recordType) };
  const job = h.job(open.job.id);
  const mcp = await mutateScheduledVisit(store, { id: 'synthetic-owner', kind: 'human', role: 'owner' }, { requestId: randomUUID(), mode: 'update', portalCustomerId: 'c1', portalVisitId: job.id, expectedRevision: job.revision, changes: { date: MON, time: '13:00', endTime: '15:00' } }, NOW);
  assert.deepEqual([mcp.autoCrew, h.job(open.job.id).assignedCrew, h.job(open.job.id).time], [undefined, ['c1a', 'c1b', 'c9z'], '13:00']);
  const later = await h.book(h.edit(h.job(open.job.id), { time: '14:00', endTime: '16:00' }));
  assert.deepEqual([later.autoCrew, later.job.assignedCrew, h.job(open.job.id).crewAutoAssigned], [undefined, ['c1a', 'c1b', 'c9z'], null]);
});

test('no free crew: the warning names the date; without a staffable crew all week no alternatives search runs', async () => {
  const f = fixture();
  for (const [id, crewId, members] of [['c3', 'crew_one', ['c1a', 'c1b']], ['c4', 'crew_two', ['c2a', 'c2b']]]) await mutateDispatch(f.store, owner, f.create({ time: '09:30', endTime: '17:00', assignedCrew: members, crewId }, { customerId: id }), NOW);
  const full = await f.auto(f.create());
  assert.equal(full.warnings.find(row => row.code === 'no_crew_available').message, 'No crew is free for this whole visit, so it was saved on 2026-10-19 without a crew (Sold: needs crew). A manager assigns the crew in Dispatch, or pick another time.');
  assert.ok(full.autoCrew.alternatives.length > 0);
  // The flag is on before any crew has members: the save is kept, and no openings snapshot is read.
  const g = fixture({ crews: DEFAULT_CREWS.map(row => crew(`seed_${row.code.replace('-', '')}`, row.name, [], { priority: row.priority, serviceDays: [...row.serviceDays], code: row.code })) });
  const reads = { roster: 0 }, roster = g.store.roster;
  g.store.roster = async () => { reads.roster++; return roster(); };
  const empty = await g.auto(g.create());
  assert.deepEqual([empty.autoCrew.status, empty.autoCrew.alternatives, g.job(empty.job.id).soldNeedsCrew.reason], ['unassigned', [], 'no_crew_free']);
  assert.equal(reads.roster, 1, 'only the save itself read the roster');
  // Crews that work some other day of that week are still searched.
  const h = fixture({ crews: [crew('crew_three', 'Crew 3', ['c3a'], { priority: 3, serviceDays: ['sat', 'sun'], code: 'crew-3' })] });
  const monday = await h.auto(h.create());
  assert.deepEqual([monday.autoCrew.status, monday.autoCrew.alternatives[0]], ['unassigned', { date: SAT, time: '09:30', endTime: '11:30', crewId: 'crew_three', crewLabel: 'Crew 3', priority: 3 }]);
});
