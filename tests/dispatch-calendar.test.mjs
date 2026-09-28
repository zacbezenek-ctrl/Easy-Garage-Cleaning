import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { dispatchOverview, mutateDispatch } from '../functions/_lib/dispatch-service.js';

const NOW = '2026-09-22T18:00:00.000Z', DAY = '2026-09-22';
const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
// A realm with a fixed clock: nothing here reads the real time.
function realm() {
  const Fixed = class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } };
  const window = { addEventListener() {} };
  const context = vm.createContext({ window, Date: Fixed, Intl, console });
  return { window, run: name => vm.runInContext(source(name), context, { filename: name }) };
}
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
// Results are copied out of the realm so strict deep-equality compares plain host values.
function calendar() { const { window, run } = realm(); run('employee-dispatch-calendar.js'); return Object.fromEntries(Object.entries(window.EGCDispatchCalendar).map(([name, value]) => [name, typeof value === 'function' ? (...args) => plain(value(...args)) : value])); }
const cal = calendar();

const roster = [{ id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }, { id: 'lead1', name: 'Lead One', role: 'crew_lead' }];
const crews = [{ id: 'north', name: 'North Crew', memberIds: ['crew1', 'lead1'], leadId: 'lead1', status: 'active' }, { id: 'south', name: 'South Crew', memberIds: ['crew2'], leadId: 'crew2', status: 'active' }, { id: 'old', name: 'Old Crew', memberIds: ['crew2'], leadId: null, status: 'inactive' }];
const job = (changes = {}) => ({ id: 'j1', revision: 'r1', type: 'job', customer: 'Synthetic One', address: '1 Synthetic Way', date: DAY, time: '08:00', endDate: DAY, endTime: '10:00', status: 'scheduled', assignedCrew: ['crew1', 'lead1'], crewLead: 'lead1', crewId: 'north', vehicleId: null, travelBufferMinutes: 20, ...changes });
const segment = (id, date, time, endTime, assignedCrew, crewLead = null, extra = {}) => ({ id, date, time, endDate: date, endTime, startAt: `${date}T${time}:00-06:00`, endAt: `${date}T${endTime}:00-06:00`, assignedCrew, crewLead, crewId: null, vehicleId: null, notes: '', ...extra });
const split = () => job({ id: 'split', revision: 'rs', customer: 'Synthetic Split', endDate: '2026-09-24', endTime: '12:00', assignedCrew: ['crew1', 'crew2'], crewLead: 'crew1', crewId: null,
  assignmentSegments: [segment('s1', DAY, '08:00', '17:00', ['crew1'], 'crew1'), segment('s2', DAY, '11:00', '15:00', ['crew2']), segment('s3', '2026-09-24', '08:00', '12:00', ['crew2'])] });
const lane = (model, id) => model.lanes.find(entry => entry.id === id);

test('month grids are whole Sunday-first weeks of 28 to 42 days inside the 93-day read cap', () => {
  assert.deepEqual(plain(cal.monthGrid('2026-09-22')), plain(cal.monthGrid('2026-09-01')));
  const september = cal.monthGrid('2026-09-22');
  assert.equal(september.month, '2026-09'); assert.equal(september.startDate, '2026-08-30'); assert.equal(september.endDate, '2026-10-04'); assert.equal(september.days.length, 35);
  assert.equal(september.days.at(-1), '2026-10-03');
  const february = cal.monthGrid('2026-02-10');
  assert.deepEqual([february.startDate, february.endDate, february.days.length], ['2026-02-01', '2026-03-01', 28]);
  const august = cal.monthGrid('2026-08-31');
  assert.deepEqual([august.startDate, august.endDate, august.days.length], ['2026-07-26', '2026-09-06', 42]);
  for (let year = 2026; year <= 2030; year++) for (let month = 1; month <= 12; month++) {
    const first = `${year}-${String(month).padStart(2, '0')}-01`, grid = cal.monthGrid(first);
    assert.ok([28, 35, 42].includes(grid.days.length), first);
    assert.equal(new Date(grid.startDate + 'T12:00:00Z').getUTCDay(), 0, first);
    assert.equal(grid.days.length, (Date.parse(grid.endDate) - Date.parse(grid.startDate)) / 86400000);
    assert.equal(grid.days.filter(day => day.startsWith(first.slice(0, 7))).length, new Date(Date.UTC(year, month, 0)).getUTCDate());
  }
});

test('month steps land on the first of the month across year ends', () => {
  assert.equal(cal.addMonths('2026-12-15', 1), '2027-01-01');
  assert.equal(cal.addMonths('2026-01-31', -1), '2025-12-01');
  assert.equal(cal.addMonths('2026-03-31', -1), '2026-02-01');
  assert.equal(cal.addMonths('2026-09-22', 0), '2026-09-01');
});

test('day windows use Denver wall clock, span midnight and release a day ending at 00:00', () => {
  assert.deepEqual(plain(cal.dayWindow(job(), DAY)), { start: 480, end: 600, startsToday: true, endsToday: true });
  assert.equal(cal.dayWindow(job(), '2026-09-23'), null);
  const overnight = job({ time: '22:00', endDate: '2026-09-23', endTime: '02:00' });
  assert.deepEqual(plain(cal.dayWindow(overnight, DAY)), { start: 1320, end: 1440, startsToday: true, endsToday: false });
  assert.deepEqual(plain(cal.dayWindow(overnight, '2026-09-23')), { start: 0, end: 120, startsToday: false, endsToday: true });
  assert.equal(cal.dayWindow(job({ time: '20:00', endDate: '2026-09-23', endTime: '00:00' }), '2026-09-23'), null);
  assert.equal(cal.dayWindow(job({ time: '10:00', endTime: '09:00' }), DAY), null);
  assert.equal(cal.dayWindow(job({ time: '8am' }), DAY), null);
  assert.equal(cal.dayWindow(job({ date: '', time: '', endDate: '', endTime: '' }), DAY), null);
});

test('dated work with unusable saved times is reported for review, never silently dropped', () => {
  const jobs = [job(), job({ id: 'bad', endTime: '07:00' }), job({ id: 'text', time: 'morning' }), job({ id: 'later', date: '2026-09-25', endDate: '2026-09-25', endTime: '07:00' }),
    job({ id: 'open', date: '', time: '', endDate: '', endTime: '' }), { id: 'b1', type: 'blocked', date: DAY, time: '17:00', endDate: DAY, endTime: '09:00' },
    job({ id: 'seg', assignmentSegments: [segment('a', DAY, '08:00', '09:00', ['crew1']), segment('b', DAY, '10:00', '09:00', ['crew1'])] })];
  assert.deepEqual(cal.untimed(jobs, DAY).map(row => row.id), ['bad', 'text', 'seg']);
  assert.deepEqual(cal.untimed(jobs, '2026-08-30', '2026-10-03').map(row => row.id), ['bad', 'text', 'later', 'seg']);
});

test('rows are one per assignment segment, otherwise the job itself', () => {
  const rows = cal.rowsOf(split());
  assert.deepEqual(rows.map(row => [row.segmentId, row.date, row.time, row.endTime, [...row.assignedCrew]]), [['s1', DAY, '08:00', '17:00', ['crew1']], ['s2', DAY, '11:00', '15:00', ['crew2']], ['s3', '2026-09-24', '08:00', '12:00', ['crew2']]]);
  assert.ok(rows.every(row => row.job.id === 'split'));
  const [single] = cal.rowsOf(job());
  assert.equal(single.segmentId, null); assert.deepEqual([...single.assignedCrew], ['crew1', 'lead1']);
});

test('employee lanes place each segment on its own crew, stack overlaps and shade unavailable and blocked time', () => {
  const data = { roster, crews, availability: [{ id: 'a1', employeeId: 'crew2', date: DAY, endDate: DAY, allDay: true, reason: 'Synthetic leave', status: 'active' }, { id: 'a2', employeeId: 'lead1', date: DAY, allDay: false, time: '15:00', endTime: '16:00', status: 'cancelled' }], warnings: [] };
  const jobs = [job(), job({ id: 'j2', customer: 'Synthetic Open', time: '13:00', endTime: '15:00', assignedCrew: [], crewLead: null, crewId: null }), split(),
    { id: 'b1', type: 'blocked', title: 'Synthetic training', date: DAY, time: '17:00', endDate: DAY, endTime: '18:00', status: 'scheduled', assignedCrew: [] },
    job({ id: 'j9', customer: 'Synthetic Former', time: '18:00', endTime: '19:00', assignedCrew: ['gone.person'], crewLead: null, crewId: null })];
  const model = cal.laneModel(data, jobs, DAY);
  assert.deepEqual(model.lanes.map(entry => entry.id), ['unassigned', 'employee:crew1', 'employee:crew2', 'employee:lead1', 'employee:gone.person']);
  assert.equal(lane(model, 'employee:gone.person').label, 'gone.person · not on the active roster');
  assert.deepEqual(model.lanes.map(entry => Boolean(entry.drop)), [false, true, true, true, false], 'only roster employees take drops');
  assert.deepEqual(lane(model, 'unassigned').items.map(item => item.key), ['j2']);
  const one = lane(model, 'employee:crew1');
  assert.deepEqual(one.items.map(item => [item.key, item.track, item.start, item.end]), [['j1', 0, 480, 600], ['split~s1', 1, 480, 1020]]);
  assert.equal(one.tracks, 2); assert.equal(one.minutes, 660);
  assert.deepEqual(lane(model, 'employee:crew2').items.map(item => item.key), ['split~s2']);
  assert.deepEqual(lane(model, 'employee:crew2').shades.map(shade => [shade.kind, shade.start, shade.end, shade.label]), [['unavailable', 0, 1440, 'Unavailable all day · Synthetic leave'], ['blocked', 1020, 1080, 'Company time block · Synthetic training']]);
  assert.deepEqual(lane(model, 'employee:lead1').shades.map(shade => shade.kind), ['blocked'], 'cancelled time off is not shaded');
  assert.deepEqual(lane(model, 'unassigned').shades, []);
  assert.deepEqual(cal.laneModel(data, jobs, '2026-09-24').lanes.map(entry => [entry.id, entry.items.map(item => item.key)]).filter(([, keys]) => keys.length), [['employee:crew2', ['split~s3']]]);
  const filtered = cal.laneModel(data, jobs.filter(row => row.assignedCrew.includes('crew2')), DAY, { employee: 'crew2' });
  assert.deepEqual(filtered.lanes.map(entry => entry.id), ['employee:crew2']);
});

test('crew lanes group work by saved crew, keep individual assignments apart and name who is unavailable', () => {
  const data = { roster, crews, availability: [{ id: 'a1', employeeId: 'lead1', date: DAY, allDay: false, time: '09:00', endTime: '11:30', reason: '', status: 'active' }], warnings: [] };
  const jobs = [job(), job({ id: 'j2', time: '13:00', endTime: '15:00', assignedCrew: [], crewLead: null, crewId: null }), split(), job({ id: 'j3', time: '16:00', endTime: '17:00', assignedCrew: ['crew2'], crewLead: 'crew2', crewId: 'old' })];
  const model = cal.laneModel(data, jobs, DAY, { mode: 'crew' });
  assert.deepEqual(model.lanes.map(entry => [entry.id, entry.label, entry.items.map(item => item.key)]), [
    ['unassigned', 'Unassigned', ['j2']], ['crew:north', 'North Crew', ['j1']], ['crew:south', 'South Crew', []], ['crew:old', 'Old Crew · inactive', ['j3']], ['individual', 'Individual assignments', ['split~s1', 'split~s2']]]);
  assert.deepEqual(lane(model, 'crew:north').shades.map(shade => [shade.start, shade.end, shade.label]), [[540, 690, 'Lead One unavailable']]);
  assert.deepEqual(model.lanes.map(entry => Boolean(entry.drop)), [false, true, true, false, false], 'only active crews take drops');
});

test('travel gaps compare consecutive stops with the larger buffer or the server drive estimate', () => {
  const data = { roster, crews, availability: [], warnings: [{ code: 'travel_buffer_short', jobId: 'j5', otherJobId: 'j4', requiredMinutes: 45 }] };
  const jobs = [job({ assignedCrew: ['crew1'], crewLead: 'crew1', crewId: null }), job({ id: 'j4', address: '2 Other Rd', time: '10:10', endTime: '11:00', assignedCrew: ['crew1'], crewLead: 'crew1', crewId: null }),
    job({ id: 'j5', address: '3 Far Rd', time: '11:30', endTime: '12:30', assignedCrew: ['crew1'], crewLead: 'crew1', crewId: null, travelBufferMinutes: 10 }),
    job({ id: 'j6', address: '3 FAR  rd', time: '12:35', endTime: '13:00', assignedCrew: ['crew1'], crewLead: 'crew1', crewId: null }),
    job({ id: 'j7', address: '9 Late Rd', time: '12:50', endTime: '16:00', assignedCrew: ['crew1'], crewLead: 'crew1', crewId: null }),
    job({ id: 'j8', address: '10 End Rd', time: '17:00', endTime: '18:00', assignedCrew: ['crew1'], crewLead: 'crew1', crewId: null, travelBufferMinutes: 0 })];
  const gaps = cal.laneModel(data, jobs, DAY).lanes.find(entry => entry.id === 'employee:crew1').gaps;
  assert.deepEqual(gaps.map(gap => [gap.from, gap.to, gap.minutes, gap.required, gap.status]), [
    ['j1', 'j4', 10, 20, 'short'], ['j4', 'j5', 30, 45, 'short'], ['j5', 'j6', 5, 20, 'same_property'], ['j7', 'j8', 60, 20, 'ok']]);
  const segmented = cal.laneModel({ roster, crews, availability: [], warnings: [] }, [job({ id: 'sx', assignedCrew: ['crew1'], crewLead: null, crewId: null, assignmentSegments: [segment('a', DAY, '08:00', '09:00', ['crew1']), segment('b', DAY, '09:05', '10:00', ['crew1'])] })], DAY);
  assert.deepEqual(lane(segmented, 'employee:crew1').gaps, [], 'segments of one job are not travel legs');
});

test('conflict hints come from the loaded overview: busy, travel, time off, company blocks and other segments', () => {
  const data = { roster, crews, warnings: [],
    jobs: [job(), job({ id: 'j2', customer: 'Synthetic Busy', time: '12:00', endTime: '14:00', assignedCrew: ['crew2'], crewLead: 'crew2', crewId: null }),
      job({ id: 'j3', customer: 'Synthetic Before', address: '5 Near Rd', time: '11:00', endTime: '12:50', assignedCrew: ['lead1'], crewLead: 'lead1', crewId: null }),
      job({ id: 'jc', customer: 'Synthetic Cancelled', time: '13:00', endTime: '14:00', status: 'cancelled', assignedCrew: ['crew1'], crewLead: 'crew1', crewId: null }),
      { id: 'b1', type: 'blocked', title: 'Synthetic meeting', date: DAY, time: '14:30', endDate: DAY, endTime: '15:30', status: 'scheduled', assignedCrew: [] }, split()],
    availability: [{ id: 'a1', employeeId: 'crew1', date: DAY, allDay: true, reason: 'Synthetic leave', status: 'active' }] };
  const target = cal.rowsOf(job({ id: 'jt', customer: 'Synthetic Target', address: '8 Target Rd', time: '13:00', endTime: '15:00', assignedCrew: [], crewLead: null, crewId: null }))[0];
  const messages = ids => cal.hints(data, target, ids).map(hint => [hint.kind, hint.message]);
  assert.deepEqual(messages(['crew2']).sort(), [['blocked', 'Company time block 2:30 PM – 3:30 PM · Synthetic meeting'], ['busy', 'Busy 11:00 AM – 3:00 PM · Synthetic Split'], ['busy', 'Busy 12:00 PM – 2:00 PM · Synthetic Busy']]);
  assert.deepEqual(messages(['lead1']).filter(([kind]) => kind !== 'blocked'), [['travel', 'Only 10 min after Synthetic Before (travel buffer 20 min)']]);
  const crew1 = messages(['crew1']);
  assert.ok(crew1.some(([kind, text]) => kind === 'unavailable' && text === 'Unavailable all day · Synthetic leave'));
  assert.ok(!crew1.some(([, text]) => text.includes('Cancelled')), 'cancelled work never blocks');
  assert.deepEqual(messages(['crew1', 'crew2']).filter(([kind]) => kind === 'unavailable'), [['unavailable', 'Crew One: Unavailable all day · Synthetic leave']]);
  const own = cal.rowsOf(data.jobs[0])[0];
  assert.ok(!cal.hints(data, own, ['crew1', 'lead1']).some(hint => hint.jobId === 'j1'), 'a job never conflicts with itself');
  const s2 = cal.rowsOf(split())[1];
  assert.ok(cal.hints(data, s2, ['crew1']).some(hint => hint.message === 'Busy 8:00 AM – 5:00 PM · another segment of this job'));
});

test('lane handoffs swap the source employee, move the lead role with them, or bring a saved crew', () => {
  const data = { roster, crews };
  const item = (lane, row = job()) => ({ row: cal.rowsOf(row)[0], job: row, lane });
  const employee = id => ({ id: 'employee:' + id, kind: 'employee', employeeId: id });
  const crew = id => ({ id: 'crew:' + id, kind: 'crew', crew: crews.find(entry => entry.id === id) });
  assert.deepEqual(plain(cal.crewChange(data, item('employee:crew1'), employee('crew2'))), { assignedCrew: ['crew2', 'lead1'], crewLead: 'lead1', crewId: null });
  assert.deepEqual(plain(cal.crewChange(data, item('employee:lead1'), employee('crew2'))), { assignedCrew: ['crew1', 'crew2'], crewLead: 'crew2', crewId: null });
  assert.deepEqual(plain(cal.crewChange(data, item('unassigned', job({ assignedCrew: [], crewLead: null, crewId: null })), employee('crew2'))), { assignedCrew: ['crew2'], crewLead: 'crew2', crewId: null });
  assert.deepEqual(plain(cal.crewChange(data, item('crew:north'), employee('crew2'))), { assignedCrew: ['crew2'], crewLead: 'crew2', crewId: null });
  assert.equal(cal.crewChange(data, item('employee:crew1'), employee('lead1')).error, 'Lead One already works this job. Move it within that row to change its time.');
  assert.deepEqual(plain(cal.crewChange(data, item('crew:north'), crew('south'))), { assignedCrew: ['crew2'], crewLead: 'crew2', crewId: 'south' });
  assert.equal(cal.crewChange(data, item('individual'), crew('north')), null, 'the same saved crew is no change');
  assert.equal(cal.crewChange(data, item('employee:crew1'), employee('crew1')), null);
  assert.equal(cal.crewChange(data, item('employee:crew1'), { id: 'unassigned', kind: 'unassigned' }).error, 'Drop the job on an employee or crew row.');
});

test('moves keep the duration in wall-clock time and shift a custom arrival window with the start', () => {
  const data = { roster, crews };
  const move = (row, target, where) => cal.moveChanges(data, { row: cal.rowsOf(row)[0], job: row, lane: 'employee:crew1' }, target, where);
  const same = { id: 'employee:crew1', kind: 'employee', employeeId: 'crew1' };
  assert.deepEqual(plain(move(job(), same, { date: DAY, start: 600 }).changes), { date: DAY, time: '10:00', endDate: DAY, endTime: '12:00' });
  assert.deepEqual(plain(move(job({ time: '20:00', endTime: '23:00' }), same, { date: DAY, start: 1380 }).changes), { date: DAY, time: '23:00', endDate: '2026-09-23', endTime: '02:00' });
  assert.deepEqual(plain(move(job({ endDate: '2026-09-24', endTime: '12:00' }), same, { date: '2026-09-25', start: 540 }).changes), { date: '2026-09-25', time: '09:00', endDate: '2026-09-27', endTime: '13:00' });
  assert.equal(move(job(), same, { date: DAY, start: 480 }).error, 'Nothing changed.');
  assert.equal(move(job(), same).error, 'Nothing changed.');
  assert.match(move(job({ endTime: '07:00' }), same, { date: DAY, start: 600 }).error, /valid start and end times/);
  const windowed = job({ arrivalWindowStart: '07:30', arrivalWindowEnd: '09:00' });
  assert.deepEqual(plain(move(windowed, same, { date: DAY, start: 600 }).changes), { date: DAY, time: '10:00', endDate: DAY, endTime: '12:00', arrivalWindowStart: '09:30', arrivalWindowEnd: '11:00' });
  const late = move(windowed, same, { date: DAY, start: 1380 });
  assert.equal(late.arrivalCleared, true); assert.equal(late.changes.arrivalWindowStart, null); assert.equal(late.changes.arrivalWindowEnd, null);
  assert.equal('arrivalWindowStart' in move(windowed, same, { date: '2026-09-23', start: 480 }).changes, false, 'a date-only move keeps the window');
  assert.equal('arrivalWindowStart' in move(windowed, { id: 'employee:crew2', kind: 'employee', employeeId: 'crew2' }).changes, false);
});

test('a segment move rewrites only that segment and sends only the segment contract fields', () => {
  const data = { roster, crews };
  const row = split(), s2 = cal.rowsOf(row)[1];
  const result = cal.moveChanges(data, { row: s2, job: row, lane: 'employee:crew2' }, { id: 'crew:north', kind: 'crew', crew: crews[0] }, { date: DAY, start: 600 });
  assert.deepEqual(Object.keys(result.changes), ['assignmentSegments']);
  assert.deepEqual(plain(result.changes.assignmentSegments), [
    { id: 's1', date: DAY, time: '08:00', endDate: DAY, endTime: '17:00', assignedCrew: ['crew1'], crewLead: 'crew1', vehicleId: null, notes: '' },
    { id: 's2', date: DAY, time: '10:00', endDate: DAY, endTime: '14:00', assignedCrew: ['crew1', 'lead1'], crewLead: 'lead1', crewId: 'north', vehicleId: null, notes: '' },
    { id: 's3', date: '2026-09-24', time: '08:00', endDate: '2026-09-24', endTime: '12:00', assignedCrew: ['crew2'], crewLead: null, vehicleId: null, notes: '' }]);
});

// The client's payloads against the real dispatch service and an in-memory revisioned store.
function store({ segments = false } = {}) {
  const rows = new Map(), put = (collection, row) => rows.set(`${collection}/${row.id}`, { ...structuredClone(row), revision: row.revision || randomUUID() });
  let serial = 0;
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => structuredClone(value));
  put('customers', { id: 'c1', name: 'Synthetic Customer', address: '1 Synthetic Way' });
  for (const crew of crews) put('dispatchResources', { ...crew, recordType: 'crew' });
  return { rows, put, segmentsEnabled: segments,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => structuredClone(roster),
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'one write per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `rev-${++serial}` });
    } };
}
const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
const seed = changes => ({ customerId: 'c1', customer: 'Synthetic Customer', scheduleSource: 'egc_hub', syncStatus: 'not_needed', jobInstructions: 'Synthetic scope', ...job(changes) });
async function overview(fixture) { return dispatchOverview(fixture, manager, { startDate: DAY, endDate: '2026-09-23', includeUnscheduled: 'true' }, new Date(NOW)); }
const body = (item, result) => ({ action: 'schedule.update', requestId: randomUUID(), jobId: item.job.id, expectedRevision: item.job.revision, changes: result.changes });

test('a lane drag body is accepted by the dispatch service and a stale replay is refused', async () => {
  const fixture = store(); fixture.put('jobs', seed({ revision: 'seed-1' })); fixture.put('jobs', seed({ id: 'j2', revision: 'seed-2', time: '13:00', endTime: '15:00', assignedCrew: [], crewLead: null, crewId: null }));
  const data = await overview(fixture), model = cal.laneModel(data, data.jobs, DAY);
  const item = lane(model, 'employee:crew1').items[0], target = lane(model, 'employee:crew2');
  const request = body(item, cal.moveChanges(data, item, target, { date: DAY, start: 600 }));
  assert.equal(request.expectedRevision, 'seed-1');
  const saved = await mutateDispatch(fixture, manager, request, NOW);
  assert.deepEqual([saved.job.date, saved.job.time, saved.job.endTime, saved.job.assignedCrew, saved.job.crewLead, saved.job.crewId], [DAY, '10:00', '12:00', ['crew2', 'lead1'], 'lead1', null]);
  const replay = await mutateDispatch(fixture, manager, request, NOW);
  assert.equal(replay.replayed, true);
  await assert.rejects(mutateDispatch(fixture, manager, { ...request, requestId: randomUUID() }, NOW), { code: 'dispatch_revision_conflict' });
  const fresh = await overview(fixture), crewModel = cal.laneModel(fresh, fresh.jobs, DAY, { mode: 'crew' });
  const open = lane(crewModel, 'unassigned').items[0], assigned = await mutateDispatch(fixture, manager, body(open, cal.moveChanges(fresh, open, lane(crewModel, 'crew:south'))), NOW);
  assert.deepEqual([assigned.job.time, assigned.job.assignedCrew, assigned.job.crewLead, assigned.job.crewId], ['13:00', ['crew2'], 'crew2', 'south']);
});

test('a busy hint matches the conflict the dispatch service enforces', async () => {
  const fixture = store(); fixture.put('jobs', seed({ revision: 'seed-1' })); fixture.put('jobs', seed({ id: 'j2', revision: 'seed-2', customer: 'Synthetic Busy', time: '09:00', endTime: '11:00', assignedCrew: ['crew2'], crewLead: 'crew2', crewId: null }));
  const data = await overview(fixture), model = cal.laneModel(data, data.jobs, DAY), item = lane(model, 'employee:crew1').items[0];
  assert.deepEqual(cal.hints(data, item.row, ['crew2']).map(hint => hint.kind), ['busy']);
  await assert.rejects(mutateDispatch(fixture, manager, body(item, cal.moveChanges(data, item, lane(model, 'employee:crew2'))), NOW), error => error.code === 'dispatch_conflict' && error.status === 409);
});

test('a segment drag body passes the segment contract with the flag on', async () => {
  const fixture = store({ segments: true });
  const row = split(); fixture.put('jobs', { ...seed(), ...row, revision: 'split-1', assignmentSegments: row.assignmentSegments.map(({ startAt, endAt, ...rest }) => rest) });
  const data = await overview(fixture), model = cal.laneModel(data, data.jobs, DAY), item = lane(model, 'employee:crew2').items[0];
  assert.equal(item.key, 'split~s2');
  const saved = await mutateDispatch(fixture, manager, body(item, cal.moveChanges(data, item, lane(model, 'employee:lead1'), { date: DAY, start: 600 })), NOW);
  assert.deepEqual(saved.job.assignmentSegments.map(s => [s.id, s.time, s.endTime, s.assignedCrew]), [['s1', '08:00', '17:00', ['crew1']], ['s2', '10:00', '14:00', ['lead1']], ['s3', '08:00', '12:00', ['crew2']]]);
  assert.deepEqual(saved.job.assignedCrew.sort(), ['crew1', 'crew2', 'lead1']);
});

test('dispatch exposes registerView and its internals; the calendar registers month and lanes once', () => {
  const { window, run } = realm();
  run('employee-dispatch.js');
  const dispatch = window.EGCDispatch;
  assert.equal(typeof dispatch.internals.save, 'function'); assert.equal(typeof dispatch.internals.openJob, 'function'); assert.equal(typeof dispatch.internals.api, 'function'); assert.equal(dispatch.internals.person('crew1'), 'crew1');
  assert.ok(Object.isFrozen(dispatch.internals));
  const view = { label: 'Synthetic', range: date => ({ startDate: date, endDate: date }), render() {} };
  for (const name of ['day', 'week', 'crew', 'jobs', 'Bad', 'x', '__proto__']) assert.throws(() => dispatch.registerView(name, view), /invalid or already registered/, name);
  assert.throws(() => dispatch.registerView('noview', { label: 'No render', range: view.range }), /invalid/);
  run('employee-dispatch-calendar.js');
  assert.throws(() => dispatch.registerView('month', view), /already registered/);
  assert.throws(() => dispatch.registerView('lanes', view), /already registered/);
  dispatch.registerView('synthetic', view);
  dispatch.internals.show('month', '2026-09-22');
  assert.deepEqual([dispatch.internals.state().view, dispatch.internals.state().date], ['month', '2026-09-22']);
});
