import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchOpenings } from '../functions/_lib/dispatch-openings.js';
import { dispatchOpeningsHandlers } from '../functions/api/dispatch-openings.js';

const manager = { user: 'zacb', role: 'owner', businessAccess: true }, now = new Date('2026-09-22T12:00:00Z');
// 2026-09-23 is a Wednesday.
const query = { startDate: '2026-09-23', endDate: '2026-09-24', durationMinutes: '60', travelBufferMinutes: '0' };
const hours = wed => ({ mon: [], tue: [], wed, thu: [], fri: [], sat: [], sun: [] });
function fixture(rules = null) {
  const data = {
    jobs: [], resources: [], guard: { revision: 'r1' }, locks: {}, rules,
    roster: [
      { id: 'crew1', name: 'Synthetic Crew One', role: 'crew', skills: [{ id: 'shelving', level: 'trainee' }, { id: 'truck_driving', level: 'proficient' }], weeklyAvailability: hours([{ start: '10:00', end: '12:00' }, { start: '13:00', end: '15:00' }]) },
      { id: 'crew2', name: 'Synthetic Crew Two', role: 'crew', skills: [{ id: 'shelving', level: 'lead' }], weeklyAvailability: hours([{ start: '08:00', end: '17:00' }]) },
      { id: 'crew3', name: 'Synthetic Crew Three', role: 'crew', skills: [{ id: 'shelving', level: 'proficient' }, { id: 'truck_driving', level: 'lead' }] },
    ],
  };
  const read = async (collection, id) => structuredClone(collection === 'dispatchState' ? data.guard : collection === 'dispatchSettings' ? (data.rules ? { id, revision: 's1', ...data.rules } : null) : data.locks[id] || null);
  const store = { jobs: async () => structuredClone(data.jobs), resources: async () => structuredClone(data.resources), roster: async () => structuredClone(data.roster), read, commit: () => { throw new Error('Openings never write.'); } };
  const check = (changes = {}) => dispatchOpenings(store, manager, Object.fromEntries(Object.entries({ ...query, ...changes }).filter(([, value]) => value !== undefined)), now);
  const job = (id, changes = {}) => ({ id, type: 'job', status: 'scheduled', date: '2026-09-23', time: '09:00', endTime: '10:00', assignedCrew: ['crew1'], ...changes });
  return { data, store, check, job };
}
const slots = result => result.candidates.map(row => [row.time, row.endTime, row.employeeIds.join('+')]);

test('recorded weekly working hours limit the gaps and confirm working availability', async () => {
  const f = fixture();
  const result = await f.check({ employeeIds: 'crew1' });
  assert.deepEqual(slots(result), [['10:00', '11:00', 'crew1'], ['13:00', '14:00', 'crew1']]);
  assert.deepEqual(result.candidates.map(row => row.gapMinutes), [120, 120]);
  assert.equal(result.constraints.workingAvailabilityConfirmed, true); assert.equal(result.constraints.mode, 'together');
  assert.deepEqual(result.warnings.map(row => row.code), ['working_hours_applied']);
  const pair = await f.check({ employeeIds: 'crew1,crew2', durationMinutes: '120' });
  assert.deepEqual(slots(pair), [['10:00', '12:00', 'crew1+crew2'], ['13:00', '15:00', 'crew1+crew2']], 'a crew fits only inside every member\'s hours');
  const mixed = await f.check({ employeeIds: 'crew1,crew3' });
  assert.deepEqual(slots(mixed), [['10:00', '11:00', 'crew1+crew3'], ['13:00', '14:00', 'crew1+crew3']], 'recorded hours still apply to the members who have them');
  assert.equal(mixed.constraints.workingAvailabilityConfirmed, false);
  assert.ok(mixed.warnings.some(row => row.code === 'working_availability_unconfirmed'));
  const unknown = await f.check({ employeeIds: 'crew3' });
  assert.deepEqual(unknown.candidates.map(row => row.gapMinutes), [540], 'no recorded hours keeps today\'s full workday');
  f.data.jobs = [f.job('busy', { time: '10:00', endTime: '11:00' })];
  assert.deepEqual(slots(await f.check({ employeeIds: 'crew1' })), [['11:00', '12:00', 'crew1'], ['13:00', '14:00', 'crew1']], 'work and hours combine');
  f.data.jobs = [];
  f.data.roster[0].weeklyAvailability = hours([]);
  const off = await f.check({ employeeIds: 'crew1' });
  assert.deepEqual(off.candidates, [], 'a day without working hours has no openings');
});

test('a working-hours boundary that is not a single Mountain time closes that workday', async () => {
  const f = fixture();
  f.data.roster[2].weeklyAvailability = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [{ start: '02:30', end: '06:00' }] };
  const result = await dispatchOpenings(f.store, manager, { startDate: '2026-03-08', endDate: '2026-03-09', employeeIds: 'crew3', durationMinutes: '60', travelBufferMinutes: '0', workdayStart: '00:00', workdayEnd: '08:00' }, new Date('2026-01-01T12:00:00Z'));
  assert.deepEqual(result.candidates, []);
  const normal = await dispatchOpenings(f.store, manager, { startDate: '2026-03-15', endDate: '2026-03-16', employeeIds: 'crew3', durationMinutes: '60', travelBufferMinutes: '0', workdayStart: '00:00', workdayEnd: '08:00' }, new Date('2026-01-01T12:00:00Z'));
  assert.deepEqual(normal.candidates.map(row => [row.time, row.gapMinutes]), [['02:30', 210]]);
});

test('required skills: a named crew is warned (or blocked), and without names each qualified employee is searched', async () => {
  const f = fixture();
  const warned = await f.check({ employeeIds: 'crew1', requiredSkills: 'shelving' });
  assert.equal(warned.candidates.length, 2);
  assert.deepEqual(warned.warnings.find(row => row.code === 'skill_missing'), { code: 'skill_missing', missingSkills: ['shelving'], message: 'No selected employee is qualified for Shelving install.' });
  assert.equal((await f.check({ employeeIds: 'crew1,crew2', requiredSkills: 'shelving' })).warnings.some(row => row.code === 'skill_missing'), false);
  f.data.rules = { blockSkillMissing: true };
  const blocked = await f.check({ employeeIds: 'crew1', requiredSkills: 'shelving' });
  assert.deepEqual(blocked.candidates, []); assert.equal(blocked.warnings.find(row => row.code === 'skill_missing').blocking, true);
  const any = await f.check({ requiredSkills: 'shelving', durationMinutes: '240' });
  assert.equal(any.constraints.mode, 'any_qualified'); assert.deepEqual(any.constraints.searchedEmployeeIds, ['crew2', 'crew3'], 'a trainee is not qualified');
  assert.deepEqual(slots(any), [['08:00', '12:00', 'crew2'], ['08:00', '12:00', 'crew3']], 'each qualified employee on their own, earliest first');
  assert.equal(any.constraints.workingAvailabilityConfirmed, false, 'crew3 has no recorded hours');
  const both = await f.check({ requiredSkills: 'shelving,truck_driving', employeeIds: '' });
  assert.deepEqual(both.constraints.searchedEmployeeIds, ['crew3']);
  const none = await f.check({ requiredSkills: 'overhead_storage' });
  assert.deepEqual(none.candidates, []); assert.ok(none.warnings.some(row => row.code === 'no_qualified_employees'));
  for (const changes of [{ requiredSkills: 'forklift' }, { requiredSkills: 'shelving,shelving' }, { requiredSkills: 'Shelving' }, { employeeIds: undefined }, { employeeIds: '', requiredSkills: '' }]) await assert.rejects(f.check({ employeeIds: undefined, ...changes }), error => ['dispatch_openings_invalid', 'dispatch_openings_employees_required'].includes(error.code) && error.status === 400, JSON.stringify(changes));
});

test('owner decision F19: an office-only owner or manager is never proposed by an any-qualified search, but can be chosen by name', async () => {
  const f = fixture();
  f.data.roster.push(
    { id: 'zacb', name: 'Synthetic Owner', role: 'owner', fieldWork: false, skills: [{ id: 'shelving', level: 'lead' }, { id: 'overhead_storage', level: 'lead' }], weeklyAvailability: hours([{ start: '08:00', end: '17:00' }]) },
    { id: 'field.manager', name: 'Synthetic Field Manager', role: 'manager', staffRoles: ['manager', 'crew'], skills: [{ id: 'shelving', level: 'proficient' }], weeklyAvailability: hours([{ start: '08:00', end: '17:00' }]) });
  const any = await f.check({ requiredSkills: 'shelving' });
  assert.deepEqual(any.constraints.searchedEmployeeIds, ['crew2', 'crew3', 'field.manager'], 'a manager who takes field work is searched; the office-only owner is not');
  assert.ok(any.candidates.every(row => !row.employeeIds.includes('zacb')));
  const onlyOffice = await f.check({ requiredSkills: 'overhead_storage' });
  assert.deepEqual(onlyOffice.candidates, []);
  assert.match(onlyOffice.warnings.find(row => row.code === 'no_qualified_employees').message, /The owner and managers who hold them are searched only when they take field work\.$/);
  const named = await f.check({ employeeIds: 'zacb', requiredSkills: 'shelving' });
  assert.equal(named.constraints.mode, 'together'); assert.ok(named.candidates.length > 0 && named.candidates.every(row => row.employeeIds.join() === 'zacb'), 'a dispatcher may still name them');
});

test('the owner workday and travel buffer are the openings defaults; explicit query values win', async () => {
  const f = fixture({ workdayStart: '09:00', workdayEnd: '11:00', defaultTravelBufferMinutes: 30 });
  f.data.jobs = [f.job('early', { assignedCrew: ['crew3'], time: '08:00', endTime: '09:00' })];
  const defaults = await f.check({ employeeIds: 'crew3', travelBufferMinutes: undefined });
  assert.deepEqual([defaults.constraints.workdayStart, defaults.constraints.workdayEnd, defaults.constraints.travelBufferMinutes], ['09:00', '11:00', 30]);
  assert.deepEqual(slots(defaults), [['09:30', '10:30', 'crew3']]);
  const explicit = await f.check({ employeeIds: 'crew3', workdayStart: '08:00', workdayEnd: '17:00' });
  assert.deepEqual(explicit.candidates.map(row => row.time), ['09:00']);
  await assert.rejects(f.check({ employeeIds: 'crew3', workdayStart: '12:00' }), error => error.code === 'dispatch_openings_invalid', 'a start after the owner workday end is rejected');
  const legacy = await fixture().check({ employeeIds: 'crew3', travelBufferMinutes: undefined });
  assert.deepEqual([legacy.constraints.workdayStart, legacy.constraints.workdayEnd, legacy.constraints.travelBufferMinutes], ['08:00', '17:00', 20]);
  // The dispatch dialog leaves out an unchanged 24:00 end (shown as 23:59), so a job ending at midnight is found.
  const late = fixture({ workdayStart: '23:00', workdayEnd: '24:00' }), midnight = await late.check({ employeeIds: 'crew3' });
  assert.deepEqual(midnight.candidates.map(row => [row.time, row.endDate, row.endTime]), [['23:00', '2026-09-24', '00:00']]);
  assert.equal((await late.check({ employeeIds: 'crew3', workdayEnd: '23:59' })).candidates.length, 0, 'a 23:59 end loses the last minute');
});

test('daily limits warn on openings and skip the date only when the owner blocks them', async () => {
  const f = fixture({ maxJobsPerEmployeePerDay: 1 });
  f.data.jobs = [f.job('booked', { assignedCrew: ['crew3'], time: '08:00', endTime: '09:00' }), f.job('other-day', { assignedCrew: ['crew3'], date: '2026-09-24', endDate: '2026-09-24' })];
  const warned = await f.check({ employeeIds: 'crew3', endDate: '2026-09-25' });
  assert.deepEqual(warned.warnings.filter(row => row.code === 'employee_daily_capacity').map(row => [row.employeeId, row.date, row.blocking]), [['crew3', '2026-09-23', undefined], ['crew3', '2026-09-24', undefined]]);
  assert.ok(warned.candidates.length > 0);
  f.data.rules = { maxJobsPerEmployeePerDay: 2, maxHoursPerEmployeePerDay: 2, blockOverCapacity: true };
  const blocked = await f.check({ employeeIds: 'crew3', endDate: '2026-09-25', durationMinutes: '90' });
  assert.deepEqual([...new Set(blocked.candidates.map(row => row.date))], [], 'one hour booked plus 90 minutes passes the two hour limit on both dates');
  const fits = await f.check({ employeeIds: 'crew3', endDate: '2026-09-25', durationMinutes: '60' });
  assert.deepEqual([...new Set(fits.candidates.map(row => row.date))], ['2026-09-23', '2026-09-24']);
  f.data.jobs.push(f.job('cancelled', { assignedCrew: ['crew3'], time: '12:00', endTime: '13:00', status: 'cancelled' }));
  assert.equal((await f.check({ employeeIds: 'crew3', durationMinutes: '60' })).candidates.length > 0, true, 'cancelled work does not count');
});

test('the HTTP API accepts requiredSkills without employees and still refuses duplicate filters', async () => {
  const f = fixture();
  const handler = dispatchOpeningsHandlers({ session: async () => manager, storage: () => f.store, now: () => now });
  const response = await handler.get({ request: new Request('https://egc.test/api/dispatch-openings?' + new URLSearchParams({ ...query, requiredSkills: 'shelving' })), env: {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.constraints.requiredSkills, ['shelving']); assert.deepEqual(body.constraints.employeeIds, []);
  assert.ok(body.candidates.every(row => Array.isArray(row.employeeIds) && row.employeeIds.length === 1));
  assert.equal((await handler.get({ request: new Request('https://egc.test/api/dispatch-openings?requiredSkills=shelving&requiredSkills=truck_driving'), env: {} })).status, 400);
});
