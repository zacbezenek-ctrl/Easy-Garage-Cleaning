// Crew performance (CREW-PERF): per-person hours, jobs worked and led, on-time arrivals, crew hours against the billed
// Labor line and issues, from timecard job segments and job records. Hours and counts only. Synthetic people and jobs.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { arrivalDeadline, crewPerformanceWindow, firstWorkStarts } from '../functions/_lib/crew-performance.js';
import { crewPerformanceHandlers, CREW_PERFORMANCE_FIELDS } from '../functions/api/crew-performance.js';

const OWNER = { user: 'ZacB', role: 'owner', businessAccess: true, owner: true };
const MANAGER = { user: 'AlexK', role: 'manager', businessAccess: true, owner: false };
const CREW = { user: 'Synthetic.Crew', role: 'crew', businessAccess: false };
const line = (id, kind, quantity, unitCents) => ({ id, kind, name: id, quantity, unitCents, totalCents: quantity * unitCents, optional: false, selected: true, taxable: false });
// A completed job sold with 8 man-hours of Labor, scheduled 08:00 Denver with an 08:00–09:00 arrival window.
const job = (id, extra = {}) => ({ id, type: 'job', date: '2026-10-10', time: '08:00', arrivalWindowEnd: '09:00', customer: 'Synthetic Garage', status: 'completed', completedAt: '2026-10-10T22:00:00.000Z', crewLead: 'Crew.One',
  estimate: { status: 'accepted', amount: 1500, lineItems: [line('removal-base', 'service', 1, 100000), line('labor', 'labor', 1, 50000)] }, jobInstructions: { laborManHours: 8 }, serviceType: 'Garage transformation', ...extra });
const at = time => `2026-10-10T${time}:00-06:00`;
const card = (id, employee, jobId, from, to, extra = {}) => ({ id, employee, employeeName: employee, payType: 'hourly', hourlyRate: 31, clockInAt: at(from), clockOutAt: at(to), status: 'submitted', approvalStatus: 'approved', breaks: [],
  jobTracking: { version: 1, coverageStartedAt: at(from), partialHistory: false, segments: [{ id: `${id}-w`, kind: 'work', jobId, startedAt: at(from), endedAt: at(to), actorId: employee }] }, ...extra });
const ROSTER = [{ id: 'crew.one', name: 'Synthetic Crew One' }, { id: 'crew.two', name: 'Synthetic Crew Two' }];

test('the arrival deadline is the window end, or the start time plus 15 minutes, in Denver time', () => {
  assert.equal(new Date(arrivalDeadline(job('w'))).toISOString(), '2026-10-10T15:00:00.000Z', '09:00 MDT');
  assert.equal(new Date(arrivalDeadline(job('n', { arrivalWindowEnd: null }))).toISOString(), '2026-10-10T14:15:00.000Z', '08:00 MDT + 15 minutes');
  assert.equal(new Date(arrivalDeadline(job('b', { arrivalWindowEnd: '07:00' }))).toISOString(), '2026-10-10T14:15:00.000Z', 'a window ending before the start is ignored');
  for (const bad of [job('t', { time: '' }), job('d', { date: '' }), null]) assert.equal(arrivalDeadline(bad), null);
});

test('first work starts are per person and per job, earliest first, and ignore travel and broken segments', () => {
  const travel = { ...card('t', 'Crew.One', 'job-a', '06:00', '07:00') }; travel.jobTracking.segments[0].kind = 'travel';
  const starts = firstWorkStarts([card('late', 'Crew.One', 'job-a', '10:00', '12:00'), card('early', 'crew.one', 'job-a', '08:30', '09:30'), travel, { employee: 'Crew.Two', jobTracking: { segments: [{ kind: 'work', jobId: 'job-a', startedAt: 'soon' }] } }]);
  assert.deepEqual([...starts.keys()], ['crew.one']);
  assert.equal(new Date(starts.get('crew.one').get('job-a')).toISOString(), '2026-10-10T14:30:00.000Z');
});

test('one row per person: hours, jobs worked and led, on-time arrivals, crew hours vs billed and issues', () => {
  const jobs = [job('on-time'), job('late', { fieldExecution: { completion: { hasIssues: true } } }), job('open', { status: 'scheduled', completedAt: null, crewLead: 'Crew.Two', fieldExecution: { attention: { status: 'open' } } }), job('old', { date: '2026-08-01' })];
  const labor = { jobs: [
    { jobId: 'on-time', employees: [{ employee: 'crew.one', name: 'Crew One', approvedHours: 5, pendingHours: 0 }, { employee: 'crew.two', name: 'Crew Two', approvedHours: 5, pendingHours: 0 }] },
    { jobId: 'late', employees: [{ employee: 'crew.one', name: 'Crew One', approvedHours: 4, pendingHours: 1 }] },
    { jobId: 'open', employees: [{ employee: 'crew.two', name: 'Crew Two', approvedHours: 0, pendingHours: 2 }] },
    { jobId: 'old', employees: [{ employee: 'crew.one', name: 'Crew One', approvedHours: 9, pendingHours: 0 }] }] };
  const actuals = new Map([['on-time', { billed: { manHours: 8 }, actual: { manHours: 10 } }], ['late', { billed: { manHours: 8 }, actual: { manHours: 5 } }]]);
  const starts = firstWorkStarts([card('a', 'Crew.One', 'on-time', '08:40', '13:40'), card('b', 'Crew.Two', 'on-time', '09:20', '14:20'), card('c', 'Crew.One', 'late', '09:30', '14:30')]);
  const rows = crewPerformanceWindow({ jobs, labor, actuals, starts, roster: ROSTER, start: '2026-10-01', end: '2026-10-22' });
  const by = Object.fromEntries(rows.map(row => [row.employee, row]));
  assert.deepEqual(rows.map(row => row.employee), ['crew.one', 'crew.two'], 'most hours first; the job outside the window is left out');
  assert.deepEqual([by['crew.one'].name, by['crew.one'].hours, by['crew.one'].pendingHours, by['crew.one'].jobsWorked, by['crew.one'].jobsLed], ['Synthetic Crew One', 9, 1, 2, 2]);
  assert.deepEqual([by['crew.one'].onTime, by['crew.one'].arrivalsCounted, by['crew.one'].onTimePercent], [1, 2, 50]);
  // Crew hours vs billed: (10 + 5) actual against (8 + 8) billed on two completed jobs is 6.25% under, shown to one decimal.
  assert.deepEqual([by['crew.one'].comparedJobs, by['crew.one'].billedManHours, by['crew.one'].actualManHours, by['crew.one'].hoursVsBilledPercent], [2, 16, 15, -6.2]);
  assert.deepEqual([by['crew.one'].issueJobs, by['crew.one'].followUps], [1, 0]);
  // Crew Two arrived after the window on one job; the open job is not compared, but its follow-up counts against its lead.
  assert.deepEqual([by['crew.two'].hours, by['crew.two'].pendingHours, by['crew.two'].jobsWorked, by['crew.two'].jobsLed, by['crew.two'].onTimePercent, by['crew.two'].comparedJobs, by['crew.two'].hoursVsBilledPercent, by['crew.two'].followUps], [5, 2, 2, 0, 0, 1, 25, 1]);
  assert.doesNotMatch(JSON.stringify(rows), /Cents|cost|rate|price|amount/i, 'hours and counts only');
});

test('no arrival data is "not counted", never late or on time', () => {
  const rows = crewPerformanceWindow({ jobs: [job('x', { time: '' })], labor: { jobs: [{ jobId: 'x', employees: [{ employee: 'crew.one', name: 'Crew One', approvedHours: 3, pendingHours: 0 }] }] }, start: '2026-10-01', end: '2026-10-22' });
  assert.deepEqual([rows[0].arrivalsCounted, rows[0].onTimePercent, rows[0].hoursVsBilledPercent], [0, null, null]);
});

function api({ actor = OWNER, timecards = async () => [card('a', 'Crew.One', 'job-a', '08:30', '12:30')], jobs = [job('job-a', { date: '2026-10-18' })] } = {}) {
  const calls = [];
  const handlers = crewPerformanceHandlers({ session: async () => actor, now: () => new Date('2026-10-21T18:00:00.000Z'), timecards,
    dispatch: () => ({ datedJobs: async (start, end, fields) => { calls.push({ start, end, fields }); return jobs; }, roster: async () => ROSTER }) });
  return { handlers, calls };
}
const get = (handlers, path = '/api/crew-performance') => handlers.get({ request: new Request(`https://easygaragecleaning.com${path}`), env: {} });

test('GET /api/crew-performance: business accounts read 30- and 90-day rows with no pay; crew and visitors are refused', async () => {
  for (const [actor, status, code] of [[null, 401, 'crew_performance_sign_in_required'], [CREW, 403, 'crew_performance_forbidden']]) {
    const response = await get(api({ actor }).handlers);
    assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  assert.equal((await get(api().handlers, '/api/crew-performance?days=7')).status, 400);
  const { handlers, calls } = api({ actor: MANAGER }), response = await get(handlers), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual([calls[0].start, calls[0].end], ['2026-07-24', '2026-10-21']);
  assert.ok(['time', 'crewLead', 'arrivalWindowEnd', 'fieldExecution.completion.hasIssues'].every(field => CREW_PERFORMANCE_FIELDS.includes(field)));
  assert.deepEqual(body.window, { start: '2026-07-24', end: '2026-10-22', shortStart: '2026-09-22', today: '2026-10-21' });
  const [row] = body.last30;
  assert.deepEqual([row.employee, row.name, row.hours, row.jobsWorked, row.jobsLed, row.onTime, row.arrivalsCounted], ['crew.one', 'Synthetic Crew One', 4, 1, 1, 1, 1]);
  assert.deepEqual(body.last90.map(r => r.employee), ['crew.one']);
  assert.deepEqual(body.sources, { timecards: 'ok' });
  assert.doesNotMatch(JSON.stringify(body), /hourlyRate|"31"|cost|Cents|amount/i, 'no pay or money');
});

test('GET keeps jobs led when timecards cannot be read, and says so', async () => {
  const body = await (await get(api({ timecards: async () => { throw new Error('vault down'); } }).handlers)).json();
  assert.deepEqual(body.sources, { timecards: 'unavailable' });
  assert.deepEqual(body.last30.map(row => [row.employee, row.jobsLed, row.hours]), [['crew.one', 1, 0]]);
});
