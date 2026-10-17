import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOpenings, projectCrewOpenings } from '../functions/_lib/dispatch-openings.js';
import { dispatchOpeningsHandlers } from '../functions/api/dispatch-openings.js';
import { jobStartProblem } from '../functions/_lib/job-start-policy.js';

// WP3 crew-mode openings (owner decisions D4/D5, 2026-10-17). Synthetic data only.
// 2026-10-19 is a Monday, 2026-10-24 a Saturday; both after the 9:30 policy date.
const manager = { user: 'zacb', role: 'owner', businessAccess: true }, now = new Date('2026-10-17T15:00:00Z');
const sales = { user: 'Sales.Account', displayName: 'Synthetic Sales', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['sales'] };
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const crew = (id, name, memberIds, extra = {}) => ({ id, recordType: 'crew', name, memberIds, leadId: memberIds[0], status: 'active', ...extra });
function fixture(rules = null) {
  const data = {
    jobs: [], guard: { revision: 'r1' }, locks: {}, rules,
    resources: [crew('crew_two', 'Crew 2', ['c2a', 'c2b'], { priority: 2, serviceDays: WEEKDAYS, code: 'crew-2' }), crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS, code: 'crew-1' }),
      crew('crew_three', 'Crew 3', ['c3a'], { priority: 3, serviceDays: ['sat', 'sun'], code: 'crew-3' }), crew('crew_off', 'Crew Off', ['c9a'], { priority: 1, status: 'inactive' }), crew('crew_new', 'Crew New', [], { priority: 4 })],
    roster: ['c1a', 'c1b', 'c2a', 'c2b', 'c3a', 'c9a'].map(id => ({ id, name: `Synthetic ${id}`, role: 'crew', staffRoles: ['crew'] })),
  };
  const read = async (collection, id) => structuredClone(collection === 'dispatchState' ? data.guard : collection === 'dispatchSettings' ? (data.rules ? { id, revision: 's1', ...data.rules } : null) : data.locks[id] || null);
  const store = { jobs: async () => structuredClone(data.jobs), resources: async () => structuredClone(data.resources), roster: async () => structuredClone(data.roster), read, commit: () => { throw new Error('Openings never write.'); } };
  const check = (query = {}, options = {}) => dispatchOpenings(store, manager, { startDate: '2026-10-19', endDate: '2026-10-20', durationMinutes: '120', travelBufferMinutes: '0', crews: 'auto', ...query }, now, options);
  const job = (id, changes = {}) => ({ id, type: 'job', status: 'scheduled', date: '2026-10-19', time: '09:30', endTime: '17:00', assignedCrew: ['c1a', 'c1b'], crewId: 'crew_one', ...changes });
  return { data, store, check, job };
}
const slots = result => result.candidates.map(row => [row.date, row.time, row.crewName]);

test('crew mode: Crew 1 booked Monday, so the first Monday opening is Crew 2 at 9:30; results go by date, then priority', async () => {
  const f = fixture();
  const open = await f.check();
  assert.deepEqual(slots(open), [['2026-10-19', '09:30', 'Crew 1'], ['2026-10-19', '09:30', 'Crew 2']], 'Crew 1 before Crew 2 (priority, not storage order); job openings from 9:30');
  assert.deepEqual(open.candidates.map(row => [row.crewId, row.crewCode, row.priority, row.weekend, row.endTime]), [['crew_one', 'crew-1', 1, false, '11:30'], ['crew_two', 'crew-2', 2, false, '11:30']]);
  assert.deepEqual([open.constraints.mode, open.constraints.crews, open.constraints.searchedCrewIds], ['crews', 'auto', ['crew_one', 'crew_two', 'crew_three']]);
  f.data.jobs = [f.job('busy')];
  const busy = await f.check();
  assert.deepEqual(slots(busy), [['2026-10-19', '09:30', 'Crew 2']]);
  assert.deepEqual(busy.byDate, [{ date: '2026-10-19', crews: [
    { crewId: 'crew_one', crewName: 'Crew 1', crewCode: 'crew-1', priority: 1, weekend: false, open: false, count: 0, first: null },
    { crewId: 'crew_two', crewName: 'Crew 2', crewCode: 'crew-2', priority: 2, weekend: false, open: true, count: 1, first: { time: '09:30', endDate: '2026-10-19', endTime: '11:30' } }] }], 'Crew 1 full, Crew 2 open 9:30');
  assert.deepEqual(projectCrewOpenings(busy), [{ date: '2026-10-19', time: '09:30', endTime: '11:30', crewId: 'crew_two', crewLabel: 'Crew 2', priority: 2 }]);
});

test('crew mode: Saturday offers only the weekend crew; inactive and empty crews are skipped with warnings', async () => {
  const f = fixture();
  const weekend = await f.check({ startDate: '2026-10-24', endDate: '2026-10-25' });
  assert.deepEqual(slots(weekend), [['2026-10-24', '09:30', 'Crew 3']]);
  assert.equal(weekend.candidates[0].weekend, true);
  assert.deepEqual(weekend.warnings.filter(row => row.crewId).map(row => [row.code, row.crewId]), [['crew_inactive', 'crew_off'], ['crew_not_staffable', 'crew_new']], 'in pick order');
  const named = await f.check({ crews: undefined, crewIds: 'crew_off,crew_two' });
  assert.deepEqual(named.constraints.searchedCrewIds, ['crew_two']); assert.ok(named.warnings.some(row => row.code === 'crew_inactive' && row.crewId === 'crew_off'));
  await assert.rejects(f.check({ crews: undefined, crewIds: 'crew_gone' }), error => error.code === 'dispatch_crew_inactive');
  for (const query of [{ crews: 'all' }, { crewIds: 'crew_one' }, { employeeIds: 'c1a' }, { requiredSkills: 'shelving' }, { crews: undefined, crewIds: 'crew_one,crew_one' }, { crews: undefined, crewIds: '' }, { kind: 'estimate' }])
    await assert.rejects(f.check(query), error => error.code === 'dispatch_openings_invalid' && error.status === 400, JSON.stringify(query));
  f.data.resources = f.data.resources.filter(row => row.id === 'crew_off');
  const none = await f.check();
  assert.deepEqual(none.candidates, []); assert.ok(none.warnings.some(row => row.code === 'no_active_crews'));
});

test('crew mode: three crews over 14 days are not truncated, and every candidate is a whole job inside the 9:00-5:00 day', async () => {
  const f = fixture();
  const result = await f.check({ startDate: '2026-10-19', endDate: '2026-11-02', durationMinutes: '60' });
  assert.equal(result.truncated, false); assert.equal(result.total, result.candidates.length);
  assert.equal(result.candidates.length, 10 * 2 + 4, 'two weekday crews on 10 weekdays, the weekend crew on 4 weekend days');
  assert.equal(result.byDate.length, 14);
  assert.deepEqual([result.constraints.workdayStart, result.constraints.workdayEnd], ['09:00', '17:00'], 'D5 default job day');
  for (const row of result.candidates) {
    assert.ok(row.time >= '09:30' && row.endTime <= '17:00', JSON.stringify(row));
    assert.equal(jobStartProblem(null, { type: 'job', date: row.date, time: row.time }), null, 'no suggested job start is one the save rejects');
  }
  const dates = result.candidates.map(row => row.date);
  assert.deepEqual(dates, [...dates].sort(), 'by date first');
});

test('kind: job openings start at 9:30 from the policy date; walkthroughs keep 9:00; older dates are unchanged', async () => {
  const f = fixture();
  const employees = { crews: undefined, employeeIds: 'c3a', startDate: '2026-10-19', endDate: '2026-10-20' };
  assert.equal((await f.check(employees)).candidates[0].time, '09:30', 'kind defaults to job');
  assert.equal((await f.check({ ...employees, kind: 'cleanout' })).candidates[0].time, '09:30');
  const walk = await f.check({ ...employees, kind: 'walkthrough' });
  assert.deepEqual([walk.candidates[0].time, walk.constraints.kind], ['09:00', 'walkthrough']);
  assert.equal((await f.check({ ...employees, workdayStart: '08:00' })).candidates[0].time, '09:30', 'an early workday never offers an early job start');
  assert.equal((await f.check({ ...employees, workdayStart: '10:00' })).candidates[0].time, '10:00', 'a later workday start wins');
  const before = await dispatchOpenings(f.store, manager, { startDate: '2026-10-13', endDate: '2026-10-14', employeeIds: 'c3a', durationMinutes: '60', travelBufferMinutes: '0', workdayStart: '08:00' }, new Date('2026-10-01T12:00:00Z'));
  assert.equal(before.candidates[0].time, '08:00', 'before the policy date nothing is clamped');
  const late = await f.check({ ...employees, workdayStart: '15:00', durationMinutes: '120' });
  assert.deepEqual(late.candidates.map(row => [row.time, row.endTime]), [['15:00', '17:00']], 'never ends after the workday');
  assert.deepEqual((await f.check({ ...employees, workdayStart: '15:30', durationMinutes: '120' })).candidates, []);
});

test('a booker never gets the roster, and in crew mode no employee ids; a dispatcher still does', async () => {
  const f = fixture();
  const booker = await f.check({}, { booker: true });
  assert.equal(Object.hasOwn(booker, 'roster'), false);
  assert.ok(booker.candidates.length > 0 && booker.candidates.every(row => !Object.hasOwn(row, 'employeeIds')));
  assert.equal(Object.hasOwn(booker.constraints, 'searchedEmployeeIds'), false);
  assert.ok(!JSON.stringify(booker).includes('c1a'), 'no member id anywhere in a booker answer');
  const dispatcher = await f.check();
  assert.ok(Array.isArray(dispatcher.roster)); assert.deepEqual(dispatcher.candidates[0].employeeIds, ['c1a', 'c1b']);
  const people = await f.check({ crews: undefined, employeeIds: 'c1a' }, { booker: true });
  assert.equal(Object.hasOwn(people, 'roster'), false); assert.deepEqual(people.candidates[0].employeeIds, ['c1a'], 'outside crew mode a booker keeps the employees they chose');
  // Daily limits in crew mode name the crew, not its people.
  const g = fixture({ maxJobsPerEmployeePerDay: 1 });
  g.data.jobs = [g.job('one', { time: '09:30', endTime: '10:30' })];
  const limited = await g.check({}, { booker: true });
  assert.deepEqual(limited.warnings.filter(row => row.code === 'employee_daily_capacity').map(row => [row.crewId, row.employeeId, row.employeeIds]), [['crew_one', undefined, undefined]]);
});

test('fails closed: a caller whose own authorize admits a non-dispatcher gets no roster or employee ids without passing booker', async () => {
  const f = fixture(), rep = { user: 'synthetic.rep', displayName: 'Synthetic Rep', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['sales'] };
  const admit = () => {};
  for (const query of [{}, { crews: undefined, employeeIds: 'c1a' }]) {
    const answer = await dispatchOpenings(f.store, rep, { startDate: '2026-10-19', endDate: '2026-10-20', durationMinutes: '120', travelBufferMinutes: '0', crews: 'auto', ...query }, now, { authorize: admit });
    assert.equal(Object.hasOwn(answer, 'roster'), false, 'no roster for a rep-facing caller that forgot booker:true');
    assert.ok(answer.candidates.length > 0);
    if (query.employeeIds === undefined) {
      assert.ok(answer.candidates.every(row => !Object.hasOwn(row, 'employeeIds')) && !Object.hasOwn(answer.constraints, 'searchedEmployeeIds'));
      assert.ok(!JSON.stringify(answer).includes('c1a'), 'no member id anywhere');
    }
  }
  // A dispatcher asking for the booker view gets it too.
  assert.equal(Object.hasOwn(await f.check({}, { booker: true }), 'roster'), false);
});

test('the HTTP API gives a Sales booker crew openings without the roster', async () => {
  const f = fixture();
  const handler = actor => dispatchOpeningsHandlers({ session: async () => actor, storage: () => f.store, now: () => now });
  const url = 'https://egc.test/api/dispatch-openings?' + new URLSearchParams({ startDate: '2026-10-19', endDate: '2026-10-21', durationMinutes: '120', crews: 'auto' });
  const answer = await handler(sales).get({ request: new Request(url), env: { EGC_STAFF_ROLE_ACCESS: 'true' } });
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.roster, undefined); assert.equal(body.constraints.mode, 'crews');
  assert.ok(body.candidates.every(row => row.employeeIds === undefined && typeof row.crewName === 'string'));
  const owner = await (await handler(manager).get({ request: new Request(url), env: {} })).json();
  assert.ok(Array.isArray(owner.roster));
  assert.equal((await handler(sales).get({ request: new Request(url), env: {} })).status, 403, 'flag off: a booker is refused as before');
});
