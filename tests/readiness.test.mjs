// READINESS: tomorrow's crew readiness on the Hub home (employee-readiness.js). Its rules run over a GET /api/dispatch
// answer: the board's own warnings, plus the checks Dispatch does not warn about (no truck, no lead, no access notes).
// Synthetic jobs and names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
function widget() {
  const context = { addEventListener() {}, Intl, Date, console };
  context.window = context;
  vm.runInContext(read('employee-readiness.js'), vm.createContext(context));
  return context.EGCReadiness;
}
const plain = value => JSON.parse(JSON.stringify(value));
const DATE = '2026-10-22';
const job = (id, extra = {}) => ({ id, type: 'job', status: 'scheduled', date: DATE, time: '09:00', customer: 'Synthetic Customer Family', serviceType: 'Garage cleanout', assignedCrew: ['crew.one', 'crew.two'], crewLead: 'crew.one', vehicleId: 'truck-1', crewNeeded: 2, accessInstructions: 'Side gate code on file', ...extra });
const board = (jobs, warnings = []) => ({ ok: true, jobs, warnings, roster: [{ id: 'crew.one', name: 'Crew One' }, { id: 'crew.two', name: 'Crew Two' }], vehicles: [{ id: 'truck-1', name: 'Truck A', status: 'available' }] });

test('a fully staffed job with a lead, a truck and access notes is ready', () => {
  const report = plain(widget().readinessReport(board([job('ready')]), DATE));
  assert.deepEqual([report.ready, report.blocked, report.check], [1, 0, 0]);
  assert.deepEqual(report.jobs[0], { id: 'ready', time: '09:00', customer: 'Synthetic', service: 'Garage cleanout', crew: ['Crew One', 'Crew Two'], needed: 2, lead: 'Crew One', trucks: ['Truck A'], blocking: [], check: [], state: 'ready' });
});

test('board warnings block or flag a job, and the readiness-only checks catch no truck, no lead and no access notes', () => {
  const jobs = [job('short', { assignedCrew: ['crew.one'], crewLead: null, time: '08:00' }), job('off', { time: '10:00' }), job('bare', { vehicleId: '', crewLead: null, accessInstructions: '', time: '11:00' }), job('nobody', { assignedCrew: [], crewLead: null, time: '12:00' })];
  const warnings = [{ jobId: 'short', code: 'crew_size_short' }, { jobId: 'off', code: 'employee_unavailable' }, { jobId: 'off', code: 'employee_unavailable' }, { jobId: 'nobody', code: 'unassigned' }, { jobId: 'bare', code: 'travel_buffer_short' }];
  const report = plain(widget().readinessReport(board(jobs, warnings), DATE)), by = Object.fromEntries(report.jobs.map(row => [row.id, row]));
  assert.deepEqual(report.jobs.map(row => row.id), ['short', 'off', 'bare', 'nobody'], 'in time order');
  assert.deepEqual([by.short.state, by.short.blocking, by.short.lead], ['blocked', ['Fewer crew than needed'], 'Crew One'], 'a one-person crew is its own lead');
  assert.deepEqual(by.off.blocking, ['Someone assigned is off or unavailable'], 'a repeated warning is listed once');
  assert.deepEqual([by.bare.state, by.bare.check], ['check', ['Tight drive between jobs', 'No truck assigned', 'No crew lead chosen', 'No access or gate notes']]);
  assert.deepEqual([by.nobody.state, by.nobody.blocking, by.nobody.check], ['blocked', ['No crew assigned'], []], 'no truck is not nagged before anyone is assigned');
  assert.deepEqual([report.ready, report.blocked, report.check], [0, 3, 1]);
});

test('review fixes: a blocking Dispatch rule blocks, any unknown warning still shows, and "no truck" needs a truck to give', () => {
  const jobs = [job('rule', { time: '08:00' }), job('hours', { time: '09:00' }), job('odd', { time: '10:00' }), job('office', { time: '11:00' }), job('notruck', { vehicleId: '', time: '12:00' })];
  const warnings = [{ jobId: 'rule', code: 'skill_missing', blocking: true }, { jobId: 'hours', code: 'outside_working_hours' }, { jobId: 'odd', code: 'brand_new_rule' }, { jobId: 'office', code: 'provider_sync_pending' }];
  const by = Object.fromEntries(plain(widget().readinessReport(board(jobs, warnings), DATE)).jobs.map(row => [row.id, row]));
  assert.deepEqual([by.rule.state, by.rule.blocking], ['blocked', ['Crew is missing a needed skill']], 'blocking:true blocks whatever the code');
  assert.deepEqual([by.hours.state, by.hours.check], ['check', ['Outside someone\'s working hours']]);
  assert.deepEqual([by.odd.state, by.odd.check], ['check', ['Dispatch shows a warning for this job']], 'an unknown warning is never dropped');
  assert.equal(by.office.state, 'ready', 'an office-only HighLevel sync note does not hold the crew');
  assert.deepEqual(by.notruck.check, ['No truck assigned']);
  const noFleet = plain(widget().readinessReport({ ...board([job('x', { vehicleId: '' })]), vehicles: [{ id: 'truck-1', name: 'Truck A', status: 'out_of_service' }] }, DATE)).jobs[0];
  assert.deepEqual([noFleet.state, noFleet.check], ['ready', []], 'with no available truck on the board, a job can still be ready');
  // A split job is judged by tomorrow's segment only.
  const split = job('split', { date: '2026-10-21', endDate: DATE, assignedCrew: [], assignmentSegments: [{ date: '2026-10-21', assignedCrew: ['crew.one'], vehicleId: '' }, { date: DATE, assignedCrew: ['crew.one', 'crew.two'], crewLead: 'crew.two', vehicleId: 'truck-1' }] });
  const row = plain(widget().readinessReport(board([split]), DATE)).jobs[0];
  assert.deepEqual([row.crew, row.lead, row.trucks, row.state], [['Crew One', 'Crew Two'], 'Crew Two', ['Truck A'], 'ready']);
});

test('only tomorrow\'s open customer jobs count: walkthroughs, blocks, done or cancelled work and other days are left out', () => {
  const jobs = [job('walk', { type: 'walkthrough' }), job('block', { type: 'blocked' }), job('done', { status: 'completed' }), job('cancelled', { status: 'cancelled' }), job('later', { date: '2026-10-23' }), job('multi', { date: '2026-10-21', endDate: DATE })];
  assert.deepEqual(plain(widget().readinessReport(board(jobs), DATE)).jobs.map(row => row.id), ['multi'], 'a multi-day job still on site tomorrow counts');
});

test('a malformed board is unverified, never "all ready"', () => {
  for (const bad of [null, { ok: true, jobs: [] }, { ...board([]), warnings: null }]) assert.throws(() => widget().readinessReport(bad, DATE), error => error.code === 'readiness_unverified');
});

test('every board warning the widget reads is one Dispatch really raises', () => {
  const source = read('employee-readiness.js'), service = read('functions/_lib/dispatch-service.js') + read('functions/_lib/dispatch-rules.js');
  const codes = [...source.matchAll(/(?:^|[{,])([a-z_]+):'[A-Z][^']+'/gm)].map(match => match[1]).filter(code => code.includes('_') || ['unassigned'].includes(code));
  assert.ok(codes.length >= 12, codes.join(','));
  for (const code of codes) assert.match(service, new RegExp(`'${code}'`), code);
});

test('the widget is registered for the business homes and loads its own files', () => {
  const registry = read('employee-hub-screens.js');
  assert.match(registry, /\{id:'crew_readiness',label:'Tomorrow readiness',homes:\['today','my_day'\],capability:'business',module:'EGCReadiness',load:\{js:'employee-readiness\.js',css:'employee-readiness\.css',v:'20261021ready1'\}\}/);
  assert.doesNotMatch(read('employee-readiness.js'), /phone|price|amount|deposit|total/i, 'no customer contact or money is read or shown');
});
