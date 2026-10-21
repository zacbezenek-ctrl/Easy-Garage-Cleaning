// Crew staffing (crew-ops): roster health from the crews and roster, the next 14 days' unstaffed jobs, the "Staff waiting
// jobs" preview, GET /api/crew-staffing (business access plus dispatch.write; configured and employee accounts; a bounded
// read) and the dispatch save that staffs a waiting job (schedule.update autoCrew:true without a move). Synthetic data
// only; every clock is injected. 2026-10-21 is a Wednesday; 2026-10-25 and 2026-11-01 are Sundays.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { STAFFING_DAYS, crewStaffing, previewSummary, rosterHealth, staffingPreview, staffingWindow, unstaffedJobs } from '../functions/_lib/crew-staffing.js';
import { CREW_STAFFING_FIELDS, crewStaffingHandlers, requireCrewStaffingViewer } from '../functions/api/crew-staffing.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { mutateBooking } from '../functions/_lib/dispatch-booking.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { readMeter } from './helpers/read-meter.mjs';
import { staffSessions } from './helpers/auth-roles-harness.mjs';
import { ORIGIN } from './helpers/vault-fixture.mjs';

// NOW is noon in Denver; EARLY is 7:00 am the same Wednesday, before any of the day's visits start.
const NOW = new Date('2026-10-21T18:00:00.000Z'), EARLY = new Date('2026-10-21T13:00:00.000Z'), TODAY = '2026-10-21', WED = '2026-10-21', THU = '2026-10-22', FRI = '2026-10-23', SAT = '2026-10-24', SUN = '2026-10-25';
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const crew = (id, name, memberIds, extra = {}) => ({ id, recordType: 'crew', name, memberIds, leadId: memberIds[0] || null, status: 'active', revision: `${id}r`, ...extra });
const person = (id, extra = {}) => ({ id, name: `Synthetic ${id}`, role: 'crew', ...extra });
const hours = days => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(day => [day, days.includes(day) ? [{ start: '07:00', end: '17:00' }] : []]));
const ROSTER = [person('zacb', { role: 'owner' }), person('c1a'), person('c1b'), person('c2a'), person('c2b', { weeklyAvailability: hours(['mon', 'tue', 'wed', 'thu']) }), person('c3a')];
const CREWS = [
  crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS }),
  crew('crew_two', 'Crew 2', ['c2a', 'c2b'], { priority: 2, serviceDays: WEEKDAYS, leadId: null }),
  crew('crew_three', 'Crew 3', ['c3a'], { priority: 3, serviceDays: ['sat'] }),
  crew('crew_empty', 'Crew 4', [], { priority: 4 }),
  crew('crew_gone', 'Crew 5', ['c1a', 'left.company'], { priority: 5, serviceDays: WEEKDAYS }),
  crew('crew_off', 'Old crew', [], { status: 'inactive' }),
];
const job = (id, date, extra = {}) => ({ id, revision: `${id}r`, type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customer: `Synthetic ${id}`, title: 'Synthetic garage reset', date, endDate: date, time: '09:00', endTime: '12:00', assignedCrew: [], crewNeeded: 1, ...extra });

test('roster health: empty crews, missing leads, inactive members, availability clashes and days no crew covers', () => {
  const health = rosterHealth({ crews: CREWS, roster: ROSTER, today: TODAY });
  const codes = health.map(row => `${row.code}:${row.crewId || row.day}${row.employeeId ? ':' + row.employeeId : ''}`);
  assert.deepEqual(codes, ['crew_no_lead:crew_two', 'availability_clash:crew_two:c2b', 'crew_no_members:crew_empty', 'crew_member_inactive:crew_gone:left.company', 'uncovered_day:sun'],
    'crews in pick order; the inactive crew is left alone; Saturday is covered by Crew 3, Sunday by nobody');
  const clash = health.find(row => row.code === 'availability_clash');
  assert.deepEqual(clash.days, ['fri']);
  assert.match(clash.message, /Synthetic c2b has no working hours on Friday, but Crew 2 works that day/);
  assert.deepEqual(health.find(row => row.code === 'uncovered_day').dates, ['2026-10-25', '2026-11-01'], 'both Sundays in the 14 days');
  assert.match(health.find(row => row.code === 'crew_member_inactive').message, /not an active employee/);
  // A lead who is not a member is a missing lead too.
  assert.equal(rosterHealth({ crews: [crew('x', 'Crew X', ['c1a'], { leadId: 'c2a' })], roster: ROSTER, today: TODAY }).some(row => row.code === 'crew_no_lead'), true);
  // No hours recorded (staff directory off) is never a clash.
  assert.equal(rosterHealth({ crews: [crew('x', 'Crew X', ['c1a'])], roster: ROSTER.map(({ weeklyAvailability, ...rest }) => rest), today: TODAY }).some(row => row.code === 'availability_clash'), false);
});

test('roster health with no crew that can work says so once instead of listing every day', () => {
  for (const crews of [[], [crew('e', 'Crew 1', [])], [crew('g', 'Crew 1', ['left.company'])]]) {
    const health = rosterHealth({ crews, roster: ROSTER, today: TODAY });
    assert.equal(health.filter(row => row.code === 'no_staffable_crew').length, 1, JSON.stringify(crews));
    assert.equal(health.some(row => row.code === 'uncovered_day'), false);
  }
  assert.match(rosterHealth({ crews: [], roster: ROSTER, today: TODAY })[0].message, /no active crews/);
  // A healthy roster has no problems.
  assert.deepEqual(rosterHealth({ crews: [crew('a', 'Crew 1', ['c1a', 'c1b']), crew('b', 'Crew 2', ['c3a'])], roster: ROSTER, today: TODAY }), []);
});

test('unstaffed jobs: the next 14 days, no crew or short, oldest first; done, other kinds and other dates are left out', () => {
  assert.equal(STAFFING_DAYS, 14);
  assert.deepEqual(staffingWindow(TODAY), { startDate: TODAY, endDate: '2026-11-03' });
  const jobs = [
    job('late', '2026-11-03'), job('past', '2026-10-20'), job('beyond', '2026-11-04'),
    job('short', FRI, { assignedCrew: ['c1a'], crewNeeded: 2 }), job('staffed', THU, { assignedCrew: ['c1a', 'c1b'], crewId: 'crew_one' }),
    job('legacy', THU, { assignedCrew: undefined, assignedTo: 'Synthetic c1a' }), job('first', WED, { time: '13:00', endTime: '15:00' }), job('earlier', WED),
    job('done', WED, { status: 'completed', pipelineStatus: 'completed' }), job('cancelled', WED, { status: 'cancelled', pipelineStatus: 'cancelled' }),
    job('walk', WED, { type: 'walkthrough' }), job('block', WED, { type: 'blocked' }), { ...job('lock', WED), recordType: 'schedule_lock' },
    job('crewonly', SAT, { crewId: 'crew_three' }),
    job('split', THU, { assignmentSegments: [{ id: 'seg-a', date: THU, time: '09:00', endTime: '12:00', assignedCrew: ['c1a'] }, { id: 'seg-b', date: FRI, time: '09:00', endTime: '12:00', assignedCrew: [] }] }),
  ];
  const rows = unstaffedJobs(jobs, { today: TODAY, now: NOW.toISOString(), roster: ROSTER });
  assert.deepEqual(rows.map(row => [row.jobId, row.status, row.assigned, row.needed, row.canAutoStaff]), [
    ['earlier', 'no_crew', 0, 1, false], ['first', 'no_crew', 0, 1, true], ['split', 'no_crew', 0, 1, false], ['short', 'short', 1, 2, false], ['crewonly', 'no_crew', 0, 1, false], ['late', 'no_crew', 0, 1, true]],
    'at noon the 9:00 visit has started, so it is listed but never staffed automatically; the 1:00 pm one can be');
  assert.equal(rows.find(row => row.jobId === 'earlier').started, true);
  assert.equal(unstaffedJobs(jobs, { today: TODAY }).some(row => row.canAutoStaff), false, 'without a clock nothing counts as not started');
  assert.equal(rows.some(row => /cents|amount|price|total|phone|address/i.test(Object.keys(row).join())), false, 'no money or contact fields');
});

test('a multi-day job that started before today, and a split job, are judged by their days in the 14 days', () => {
  const jobs = [
    job('spans', '2026-10-19', { endDate: THU, time: '10:00', endTime: '15:00' }), job('ended', '2026-10-18', { endDate: '2026-10-20', time: '10:00', endTime: '15:00' }),
    job('split', '2026-10-19', { endDate: FRI, assignmentSegments: [{ id: 'seg-old', date: '2026-10-19', time: '10:00', endTime: '12:00', assignedCrew: [] }, { id: 'seg-new', date: FRI, time: '10:00', endTime: '12:00', assignedCrew: ['c1a'] }] }),
    job('legacy', THU, { assignedCrew: undefined, assignedTo: 'Synthetic c1a' }),
  ];
  const rows = unstaffedJobs(jobs, { today: TODAY, now: NOW.toISOString(), roster: ROSTER });
  assert.deepEqual(rows.map(row => [row.jobId, row.date, row.startDate, row.started, row.canAutoStaff]), [['spans', TODAY, '2026-10-19', true, false]],
    'the running job shows on today, never staffed after the fact; the ended one is not in the window; the split job is staffed on its window day; a legacy name counts');
});

test('people who left do not staff a job: a departed sole assignee is no crew, a departed second person leaves it short', () => {
  const jobs = [job('gone', THU, { assignedCrew: ['left.company'] }), job('half', THU, { assignedCrew: ['c1a', 'left.company'], crewNeeded: 2 }), job('ok', FRI, { assignedCrew: ['c1a', 'c1b'], crewNeeded: 2 }),
    job('untimed', FRI, { time: '', endTime: '' })];
  const rows = unstaffedJobs(jobs, { today: TODAY, now: NOW.toISOString(), roster: ROSTER });
  assert.deepEqual(rows.map(row => [row.jobId, row.status, row.assigned, row.needed, row.inactive, row.canAutoStaff]), [
    ['gone', 'no_crew', 0, 1, ['left.company'], false], ['half', 'short', 1, 2, ['left.company'], false], ['untimed', 'no_crew', 0, 1, [], false]],
    'listed with who left; never staffed automatically while anyone is on the job (the server staffs only an empty job)');
  assert.equal(rows.find(row => row.jobId === 'untimed').needsTime, true, 'a dated visit with no time is listed as needing one');
  const report = crewStaffing({ crews: CREWS, roster: ROSTER, jobs, today: TODAY, asOf: NOW.toISOString() });
  assert.equal(report.counts.unstaffed, 3, 'the Command center line counts them, so it never says crews are set');
});

test('the preview counts people on legacy display-name assignments as busy', () => {
  const crews = [crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS }), crew('crew_two', 'Crew 2', ['c2a'], { priority: 2, serviceDays: WEEKDAYS })];
  const jobs = [job('legacy', THU, { assignedCrew: undefined, assignedTo: 'Synthetic c1b', time: '10:00', endTime: '11:00' }), job('waiting', THU)];
  const waiting = unstaffedJobs(jobs, { today: TODAY, now: NOW.toISOString(), roster: ROSTER });
  assert.deepEqual(staffingPreview({ waiting, jobs, crews, roster: ROSTER }).map(row => row.crewId), ['crew_two'], 'c1b is on the legacy job by name, so Crew 1 is busy');
});

test('the preview picks the first free eligible crew, counts earlier picks, and says why a job cannot be staffed', () => {
  const jobs = [job('a', WED), job('b', WED), job('c', WED), job('d', SUN), job('busy', WED, { assignedCrew: ['c3a'] }),
    job('e', THU, { time: '08:00', endTime: '10:00' })];
  const roster = [...ROSTER, person('c2b')], crews = [crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS }), crew('crew_two', 'Crew 2', ['c2a', 'c2b'], { priority: 2, serviceDays: WEEKDAYS })];
  const availability = [{ recordType: 'availability', employeeId: 'c1b', date: THU, endDate: THU, allDay: true, status: 'approved' }];
  const waiting = unstaffedJobs(jobs, { today: TODAY, now: EARLY.toISOString(), roster }), plan = staffingPreview({ waiting, jobs, crews, roster, availability });
  assert.deepEqual(plan.map(row => [row.jobId, row.crewId || row.reason]), [['a', 'crew_one'], ['b', 'crew_two'], ['c', 'busy'], ['e', 'crew_two'], ['d', 'no_crew_works']],
    'a takes Crew 1, b the next free crew, c finds both busy; Thursday Crew 1 is out (c1b off); Sunday nobody works');
  assert.equal(previewSummary(plan), "Crew 1 → 1 job, Crew 2 → 2 jobs; 2 can't be staffed: every crew that works Wednesday is busy then; no staffable crew works Sundays");
  assert.equal(previewSummary([]), 'No job can be staffed');
  const report = crewStaffing({ crews, roster, jobs, availability, today: TODAY, asOf: EARLY.toISOString() });
  assert.deepEqual(report.counts, { problems: report.health.length, unstaffed: 5, canAutoStaff: 5, staffable: 3 });
  assert.match(report.previewSummary, /^Crew 1 → 1 job/);
  const off = crewStaffing({ crews, roster, jobs, availability, today: TODAY, asOf: EARLY.toISOString(), autoAssign: false });
  assert.deepEqual([off.autoAssign, off.preview, off.counts.staffable, off.unstaffed.length], [false, [], 0, 5], 'auto-assign off: the jobs are listed, nothing is offered');
});

// A store the API reads: crews and time off from dispatchResources, the roster, and the 14 dated days.
function apiStore({ jobs = [], crews = CREWS, roster = ROSTER, spanning = undefined } = {}) {
  const calls = [];
  return { calls, store: () => ({ resources: async () => { calls.push('resources'); return structuredClone(crews); }, roster: async () => { calls.push('roster'); return structuredClone(roster); },
    ...(spanning ? { spanningJobs: async (start, fields) => { calls.push({ spanning: start, fields }); if (spanning === 'missing') throw Object.assign(new Error('index'), { code: 'dispatch_index_required' }); return structuredClone(jobs).filter(row => row.date < start && (row.endDate || row.date) >= start); } } : {}),
    datedJobs: async (start, end, fields) => { calls.push({ start, end, fields }); return structuredClone(jobs).filter(row => row.date >= start && row.date <= end); },
    jobs: async () => { throw new Error('a full jobs scan is never read'); } }) };
}
const AUTO = { EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' };
const get = (handlers, path = '/api/crew-staffing', env = AUTO) => handlers.get({ request: new Request(`${ORIGIN}${path}`), env });

test('GET /api/crew-staffing: owner and managers who dispatch; crew, sales and bookers get nothing', async () => {
  for (const [actor, status] of [[owner, 200], [{ user: 'tylerg', role: 'manager', businessAccess: true }, 200], [{ user: 'Synthetic.Crew', role: 'crew', businessAccess: false }, 403],
    [{ user: 'Sales.Account', role: 'crew', businessAccess: false, staffRoles: ['sales'] }, 403], [{ user: 'Forged', role: 'manager', businessAccess: true }, 403], [null, 401]]) {
    const { calls, store } = apiStore({ jobs: [job('a', WED)] });
    const response = await get(crewStaffingHandlers({ session: async () => actor, storage: store, now: () => NOW }));
    assert.equal(response.status, status, JSON.stringify(actor));
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    if (status !== 200) assert.deepEqual(calls, [], 'nothing is read for a refused viewer');
  }
  assert.throws(() => requireCrewStaffingViewer({ user: 'zacb', businessAccess: true, role: 'crew' }, {}), { code: 'crew_staffing_forbidden' }, 'business access without dispatch.write');
  const { store } = apiStore();
  assert.equal((await get(crewStaffingHandlers({ session: async () => owner, storage: store, now: () => NOW }), '/api/crew-staffing?days=60')).status, 400);
  const down = crewStaffingHandlers({ session: async () => owner, now: () => NOW, storage: () => ({ resources: async () => [], roster: async () => [], datedJobs: async () => { throw new Error('projects/secret down'); } }) });
  assert.deepEqual(await (await get(down)).json(), { ok: false, code: 'crew_staffing_unavailable', error: 'Crew staffing could not be loaded. Retry in a moment.' });
});

test('GET /api/crew-staffing reads the 14 dated days masked, never money, and answers health, unstaffed and the preview', async () => {
  const { calls, store } = apiStore({ jobs: [job('a', WED), job('d', SUN), job('beyond', '2026-11-04'), { ...job('off', THU, { type: 'availability' }), employee: 'c1a', allDay: true }] });
  const body = await (await get(crewStaffingHandlers({ session: async () => owner, storage: store, now: () => EARLY }))).json();
  assert.deepEqual(calls.find(call => call.start), { start: TODAY, end: '2026-11-03', fields: [...CREW_STAFFING_FIELDS] });
  assert.equal(body.autoAssign, true);
  assert.ok(!CREW_STAFFING_FIELDS.some(field => /estimate|price|total|amount|deposit|invoice|payment|phone|email|address|notes/i.test(field)), 'no money or contact fields are read');
  assert.deepEqual(body.unstaffed.map(row => row.jobId), ['a', 'd']);
  assert.deepEqual(body.preview.map(row => [row.jobId, row.crewId || row.reason]), [['a', 'crew_one'], ['d', 'no_crew_works']]);
  assert.equal(body.health.some(row => row.code === 'uncovered_day' && row.day === 'sun'), true);
  assert.doesNotMatch(JSON.stringify(body), /\$|cents/i);
});

test('GET /api/crew-staffing reads the jobs running into the 14 days, with the crew schedule\'s lookback until the index exists', async () => {
  const jobs = [job('spans', '2026-10-19', { endDate: THU, time: '10:00', endTime: '15:00' }), job('a', THU), job('old', '2026-10-10')];
  for (const spanning of ['ok', 'missing']) {
    const { calls, store } = apiStore({ jobs, spanning });
    const body = await (await get(crewStaffingHandlers({ session: async () => owner, storage: store, now: () => NOW }))).json();
    assert.deepEqual(body.unstaffed.map(row => [row.jobId, row.canAutoStaff]), [['spans', false], ['a', true]], spanning);
    if (spanning === 'missing') assert.ok(calls.some(call => call.start === '2026-09-19' && call.end === '2026-10-20'), 'the 32 days before today, as /api/crew-schedule reads');
    else assert.ok(!calls.some(call => call.start && call.start < TODAY), 'with the index, never a lookback');
  }
  const { store } = apiStore({ jobs });
  const off = await (await get(crewStaffingHandlers({ session: async () => owner, storage: store, now: () => NOW }), '/api/crew-staffing', {})).json();
  assert.deepEqual([off.autoAssign, off.preview, off.unstaffed.length], [false, [], 2], 'auto-assign off: listed, nothing offered');
});

test('READ-BUDGET: through the real storage, one bounded jobs.date range query and the crews; never a jobs list scan', async () => {
  const seed = { 'dispatchResources/crew_one': crew('crew_one', 'Crew 1', ['zacb'], { priority: 1 }) };
  for (let index = 0; index < 120; index++) seed[`jobs/old_${String(index).padStart(3, '0')}`] = job(`old_${index}`, '2026-06-01');
  for (const row of [job('a', WED), job('b', '2026-11-03'), job('c', '2026-11-04')]) seed[`jobs/${row.id}`] = row;
  const fs = firestoreRest(seed), meter = readMeter(fs);
  const handlers = crewStaffingHandlers({ session: async () => owner, now: () => NOW, storage: env => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => [person('zacb', { role: 'owner' })] }) });
  const measured = await meter.measure(async () => (await get(handlers)).json());
  assert.equal(measured.result.ok, true);
  assert.deepEqual(measured.result.unstaffed.map(row => row.jobId), ['a', 'b']);
  assert.equal(measured.byKey['query:jobs:date+date'], 2, 'only the two jobs dated in the 14 days');
  assert.equal(measured.byKey['query:jobs:endDate+date'], 1, 'one indexed query for jobs running into the window (none here)');
  assert.equal(Object.keys(measured.byKey).some(key => key.startsWith('list:jobs')), false, 'no jobs list scan');
  const [query] = fs.queries('jobs').map(call => call.body.structuredQuery);
  assert.deepEqual(query.where.compositeFilter.filters.map(item => [item.fieldFilter.field.fieldPath, item.fieldFilter.op, item.fieldFilter.value.stringValue]), [['date', 'GREATER_THAN_OR_EQUAL', TODAY], ['date', 'LESS_THAN_OR_EQUAL', '2026-11-03']]);
});

test('real sessions: a configured owner, a configured manager and an employee-account manager read it; crew and sales do not', async t => {
  const { env: base, cookies } = await staffSessions(t), env = { ...base, EGC_STAFF_ROLE_ACCESS: 'true' };
  const handlers = crewStaffingHandlers({ storage: apiStore().store, now: () => NOW });
  const read = async (user, useEnv = env) => (await handlers.get({ request: new Request(`${ORIGIN}/api/crew-staffing`, { headers: { Cookie: cookies[user] } }), env: useEnv })).status;
  for (const user of ['ZacB', 'TylerG', 'Config.Manager', 'Mgr.Account']) assert.equal(await read(user), 200, user);
  for (const user of ['Crew.Static', 'Sales.Account', 'Phone.Account', 'Config.Phone', 'Lead.Account', 'Crew.Account', 'Owner.Claim']) assert.equal(await read(user), 403, user);
  assert.equal(await read('Mgr.Account', base), 403, 'an employee-account manager needs EGC_STAFF_ROLE_ACCESS, as for dispatch');
});

// The dispatch store the save path writes: compare-and-set revisions, the whole commit or nothing.
function dispatchStore({ crews } = {}) {
  const rows = new Map([...['c1', 'c2', 'c3', 'c4'].map(id => [`customers/${id}`, { id, name: `Synthetic Customer ${id}`, phone: '9705550100', address: `${id} Fixture Lane`, revision: `${id}r` }]),
    ...(crews || [crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS }), crew('crew_two', 'Crew 2', ['c2a', 'c2b'], { priority: 2, serviceDays: WEEKDAYS })]).map(row => [`dispatchResources/${row.id}`, row])]);
  let revision = 0;
  const clone = value => structuredClone(value), all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const store = { jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => ['zacb', 'c1a', 'c1b', 'c2a', 'c2b'].map(id => person(id)),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    } };
  const save = (input, options = { autoCrew: 'opt_in' }) => mutateDispatch(store, owner, input, NOW.toISOString(), options);
  let customers = 0;
  const waiting = async (date, extra = {}) => (await save({ action: 'schedule.create', requestId: randomUUID(), customerId: `c${(customers++ % 4) + 1}`, kind: 'job', autoCrew: false, changes: { date, time: '10:00', endTime: '12:00', jobInstructions: 'Synthetic garage reset', ...extra } })).job;
  const staff = row => ({ action: 'schedule.update', requestId: randomUUID(), jobId: row.id, expectedRevision: rows.get(`jobs/${row.id}`).revision, changes: {}, autoCrew: true });
  return { rows, store, save, waiting, staff, job: id => rows.get(`jobs/${id}`), receipts: () => all('dispatchOperations') };
}

test('staff waiting jobs: an unstaffed dated job gets the first free crew without moving, once per request id, with its audit row', async () => {
  const f = await dispatchStore(), first = await f.waiting(THU), second = await f.waiting(THU);
  assert.deepEqual([f.job(first.id).assignedCrew, f.job(second.id).assignedCrew], [[], []], 'both saved waiting');
  const input = f.staff(first), staffed = await f.save(input);
  assert.deepEqual([staffed.autoCrew.status, staffed.autoCrew.mode, staffed.autoCrew.crewId], ['assigned', 'staff', 'crew_one']);
  assert.deepEqual([f.job(first.id).date, f.job(first.id).time, f.job(first.id).endTime], [THU, '10:00', '12:00'], 'the visit did not move');
  assert.deepEqual([f.job(first.id).assignedCrew, f.job(first.id).crewLead, f.job(first.id).crewAutoAssigned.mode], [['c1a', 'c1b'], 'c1a', 'staff']);
  const receipt = f.receipts().find(row => row.requestId === input.requestId);
  assert.equal(receipt.action, 'schedule.update');
  assert.equal(receipt.actorId, 'zacb');
  assert.deepEqual(receipt.before.assignedCrew, []);
  assert.deepEqual(receipt.after.assignedCrew, ['c1a', 'c1b'], 'the receipt is the audit row: before and after crew');
  const revision = f.job(first.id).revision, replay = await f.save(input);
  assert.equal(replay.replayed, true, 'the same request id replays');
  assert.equal(f.job(first.id).revision, revision, 'a replay writes nothing');
  // The second job at the same time takes the next free crew (partial batches are fine: each job is its own save).
  assert.equal((await f.save(f.staff(second))).autoCrew.crewId, 'crew_two');
});

test('a staffing pick is held to the owner\'s blocking rules like a booking: over-capacity Crew 1 is skipped for Crew 2', async () => {
  const f = await dispatchStore();
  f.rows.set('dispatchSettings/current', { id: 'current', revision: 'sr1', maxJobsPerEmployeePerDay: 1, blockOverCapacity: true });
  await f.waiting(THU, { time: '14:00', endTime: '15:00', assignedCrew: ['c1a', 'c1b'], crewId: 'crew_one' });
  const waiting = await f.waiting(THU);
  const staffed = await f.save(f.staff(waiting));
  assert.equal(staffed.autoCrew.crewId, 'crew_two', 'Crew 1 already has its one job that day, so the pick passes it over');
  assert.deepEqual(f.job(waiting.id).assignedCrew, ['c2a', 'c2b']);
  const g = await dispatchStore({ crews: [crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS })] });
  g.rows.set('dispatchSettings/current', { id: 'current', revision: 'sr1', maxJobsPerEmployeePerDay: 1, blockOverCapacity: true });
  await g.waiting(THU, { time: '14:00', endTime: '15:00', assignedCrew: ['c1a', 'c1b'], crewId: 'crew_one' });
  const only = await g.waiting(THU);
  await assert.rejects(g.save(g.staff(only)), error => error.code === 'dispatch_no_crew_free' && error.details.reason === 'rule' && error.details.codes.includes('employee_daily_capacity') && /employee_daily_capacity/.test(error.message),
    'with the only crew over its limit nothing is saved, and the refusal names the blocking rule');
  assert.deepEqual(g.job(only.id).assignedCrew, []);
});

test('staff waiting jobs that no crew can take: nothing is written and the reason says why', async () => {
  const f = await dispatchStore(), sunday = await f.waiting(SUN), before = structuredClone(f.job(sunday.id)), receipts = f.receipts().length;
  await assert.rejects(f.save(f.staff(sunday)), error => error.code === 'dispatch_no_crew_free' && error.status === 409 && error.details.reason === 'no_crew_works' && /No active crew/.test(error.message));
  assert.deepEqual(f.job(sunday.id), before, 'the job is unchanged');
  assert.equal(f.receipts().length, receipts, 'no receipt');
  // Busy: both weekday crews already on Thursday 10-12.
  const g = await dispatchStore(), a = await g.waiting(THU), b = await g.waiting(THU), c = await g.waiting(THU);
  await g.save(g.staff(a)); await g.save(g.staff(b));
  await assert.rejects(g.save(g.staff(c)), error => error.code === 'dispatch_no_crew_free' && error.details.reason === 'busy' && /busy/.test(error.message));
  assert.deepEqual(g.job(c.id).assignedCrew, []);
});

test('a visit that has started or ended is never staffed after the fact, and nothing is written', async () => {
  const f = await dispatchStore(), today = await f.waiting(WED, { time: '10:00', endTime: '11:00' }), later = await f.waiting(WED, { time: '13:00', endTime: '15:00' });
  const before = structuredClone(f.job(today.id));
  await assert.rejects(f.save(f.staff(today)), error => error.code === 'dispatch_visit_started' && error.status === 409 && error.details.reason === 'started', 'noon: the 10:00 visit has started');
  assert.deepEqual(f.job(today.id), before);
  assert.equal((await f.save(f.staff(later))).autoCrew.crewId, 'crew_one', 'the 1:00 pm visit can still be staffed');
});

test('the Dispatch form\'s "assign the first free crew" on an unmoved job that also edits the visit saves as before, without a pick', async () => {
  const f = await dispatchStore(), sunday = await f.waiting(SUN);
  const edited = await f.save({ ...f.staff(sunday), changes: { notes: 'Synthetic gate code changed' } });
  assert.equal(edited.autoCrew, undefined, 'no staffing pick, so no refusal');
  assert.deepEqual([f.job(sunday.id).notes, f.job(sunday.id).assignedCrew], ['Synthetic gate code changed', []], 'the edit is saved and the job stays waiting');
});

test('staffing never replaces people, never runs for bookers or with auto-assign off, and a hand-staffed job is left alone', async () => {
  const f = await dispatchStore(), hand = await f.waiting(THU, { assignedCrew: ['c2a'] });
  const kept = await f.save(f.staff(hand));
  assert.equal(kept.autoCrew, undefined, 'a job with people on it is not re-picked');
  assert.deepEqual(f.job(hand.id).assignedCrew, ['c2a']);
  const waiting = await f.waiting(FRI);
  await assert.rejects(f.save(f.staff(waiting), {}), { code: 'dispatch_patch_not_allowed' }, 'without EGC_DISPATCH_CREW_AUTO_ASSIGN autoCrew is not accepted');
  const booked = await mutateDispatch(f.store, owner, f.staff(waiting), NOW.toISOString(), { autoCrew: true });
  assert.equal(booked.autoCrew, undefined, 'the always-on booking mode never staffs an unmoved job');
  const sales = { user: 'Sales.Account', displayName: 'Synthetic Sales', role: 'crew', businessAccess: false, source: 'employee-account', staffRoles: ['sales'] };
  // A Sales or Phone booker's save (dispatch-booking.js, the always-on mode) may move a visit but never staffs one in place.
  try { await mutateBooking(f.store, sales, f.staff(waiting), NOW.toISOString(), {}, { EGC_STAFF_ROLE_ACCESS: 'true', EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' }); } catch (error) { assert.ok(error.status >= 400 && error.status < 500, error.code); }
  assert.deepEqual(f.job(waiting.id).assignedCrew, [], 'a booker never staffs a waiting job');
});

test('through POST /api/dispatch: a dispatcher staffs a waiting job; the HighLevel mirror hook runs for the saved job as for any save', async () => {
  const f = await dispatchStore(), waiting = await f.waiting(THU), mirrored = [];
  const handlers = dispatchHandlers({ session: async () => owner, storage: () => f.store, now: () => NOW, ghlTags: () => {}, ghlMirror: async (_ctx, jobId) => { mirrored.push(jobId); return false; } });
  const response = await handlers.post({ request: new Request(`${ORIGIN}/api/dispatch`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(f.staff(waiting)) }), env: { EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.autoCrew.crewName, 'Crew 1');
  assert.deepEqual(mirrored, [waiting.id]);
  const sunday = await f.waiting(SUN);
  const refused = await handlers.post({ request: new Request(`${ORIGIN}/api/dispatch`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(f.staff(sunday)) }), env: { EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' } });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'dispatch_no_crew_free');
});
