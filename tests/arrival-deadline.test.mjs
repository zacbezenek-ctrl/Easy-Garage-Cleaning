import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { storage, FixedDate } from './helpers/hub-dom.mjs';
import { flags, arrivalDeadline, enRouteDeadline, startAt, denverDate } from '../functions/_lib/arrival-deadline.js';
import { projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { JOB_FIELDS } from '../functions/_lib/dispatch-storage.js';

// FIELD-FLAGS: every instant here is fixed; nothing reads the real clock.
const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const at = iso => Date.parse(iso);
const job = (fields = {}) => ({ id: 'synthetic-flag-job', type: 'job', date: '2026-09-22', time: '09:00', endTime: '12:00', status: 'scheduled', ...fields });
const kinds = list => list.map(flag => flag.kind);

test('the arrival deadline is the window end, or the start plus 15 minutes without a valid window', () => {
  // 2026-09-22 is daylight time: 09:00 in Denver is 15:00 UTC.
  assert.equal(startAt(job()), at('2026-09-22T15:00:00Z'));
  assert.equal(arrivalDeadline(job()), at('2026-09-22T15:15:00Z'));
  assert.equal(enRouteDeadline(job()), at('2026-09-22T14:30:00Z'));
  assert.equal(arrivalDeadline(job({ arrivalWindowStart: '09:00', arrivalWindowEnd: '10:00' })), at('2026-09-22T16:00:00Z'));
  // Half a window, a reversed window or a malformed end falls back to start + 15.
  for (const window of [{ arrivalWindowEnd: '10:00' }, { arrivalWindowStart: '10:00', arrivalWindowEnd: '09:00' }, { arrivalWindowStart: '09:00', arrivalWindowEnd: '25:00' }, { arrivalWindow: '9:00 AM – 10:00 AM' }])
    assert.equal(arrivalDeadline(job(window)), at('2026-09-22T15:15:00Z'), JSON.stringify(window));
  assert.equal(arrivalDeadline(job({ time: '' })), null);
  assert.equal(startAt(job({ date: '2026-02-30' })), null);
});

test('deadlines follow Denver across both DST changes', () => {
  // Spring forward (2026-03-08) and fall back (2026-11-01): 09:00 is MDT (UTC-6) on the first, MST (UTC-7) on the second.
  assert.equal(startAt(job({ date: '2026-03-07' })), at('2026-03-07T16:00:00Z'));
  assert.equal(startAt(job({ date: '2026-03-08' })), at('2026-03-08T15:00:00Z'));
  assert.equal(startAt(job({ date: '2026-10-31' })), at('2026-10-31T15:00:00Z'));
  assert.equal(startAt(job({ date: '2026-11-01' })), at('2026-11-01T16:00:00Z'));
  assert.equal(arrivalDeadline(job({ date: '2026-11-01', arrivalWindowStart: '08:00', arrivalWindowEnd: '10:00' })), at('2026-11-01T17:00:00Z'));
  // The day itself is Denver's: 05:30 UTC on 1 November is still 31 October in Denver.
  assert.equal(denverDate(at('2026-11-01T05:30:00Z')), '2026-10-31');
  const fallBack = job({ date: '2026-11-01' });
  assert.deepEqual(kinds(flags(fallBack, { now: at('2026-11-01T16:10:00Z') })), ['not_en_route'], '09:10 MST is inside the grace period, so not late yet');
  assert.deepEqual(kinds(flags(fallBack, { now: at('2026-11-01T16:15:00Z') })), ['late']);
});

test('not en route from 30 minutes before the start, late at the deadline, and nothing before', () => {
  const row = job({ arrivalWindowStart: '09:00', arrivalWindowEnd: '10:00' });
  assert.deepEqual(flags(row, { now: at('2026-09-22T14:29:00Z') }), []);
  assert.deepEqual(kinds(flags(row, { now: at('2026-09-22T14:30:00Z') })), ['not_en_route']);
  assert.deepEqual(kinds(flags(row, { now: at('2026-09-22T15:59:00Z') })), ['not_en_route'], 'inside the window it is not late yet');
  const late = flags(row, { now: at('2026-09-22T16:00:00Z') });
  assert.deepEqual(kinds(late), ['late'], 'late replaces not en route');
  assert.equal(late[0].tone, 'red');
  // Dispatched clears not en route but not late.
  const rolling = { ...row, dispatchedAt: '2026-09-22T14:40:00Z' };
  assert.deepEqual(flags(rolling, { now: at('2026-09-22T15:00:00Z') }), []);
  assert.deepEqual(kinds(flags(rolling, { now: at('2026-09-22T16:01:00Z') })), ['late']);
  assert.deepEqual(flags({ ...row, fieldExecution: { activity: 'dispatched' } }, { now: at('2026-09-22T15:00:00Z') }), []);
});

test('a job already arrived or started, or cancelled or finished, is never flagged late', () => {
  const now = at('2026-09-22T17:00:00Z');
  for (const fields of [{ arrivedAt: '2026-09-22T15:20:00Z' }, { startedAt: '2026-09-22T15:30:00Z' }, { status: 'in_progress' }, { fieldExecution: { activity: 'arrived' } },
    { status: 'completed' }, { completedAt: '2026-09-22T16:00:00Z' }, { status: 'cancelled' }, { cancelledAt: '2026-09-22T12:00:00Z' }, { pipelineStatus: 'no_show' }])
    assert.ok(!kinds(flags(job(fields), { now })).some(kind => kind === 'late' || kind === 'not_en_route'), JSON.stringify(fields));
  for (const fields of [{ status: 'completed' }, { status: 'cancelled' }])
    assert.deepEqual(flags(job(fields), { now, crew: ['crew-a'], timeEntries: [] }), [], 'a closed job asks nobody to clock in');
});

test('only today\'s Denver-dated crew jobs are flagged; walkthroughs, blocked time and other days are not', () => {
  const now = at('2026-09-22T17:00:00Z');
  assert.deepEqual(kinds(flags(job(), { now })), ['late']);
  assert.deepEqual(flags(job({ date: '2026-09-21' }), { now }), []);
  assert.deepEqual(flags(job({ date: '2026-09-23' }), { now }), []);
  assert.deepEqual(flags(job({ type: 'walkthrough' }), { now }), []);
  assert.deepEqual(flags(job({ type: 'blocked' }), { now }), []);
  assert.deepEqual(flags(job({ time: undefined }), { now }), [], 'a row without a time has no deadline');
  assert.deepEqual(flags(null, { now }), []);
  assert.deepEqual(flags(job(), { now: 'not a date' }), []);
});

test('a scheduled crew member with no clock-in today is flagged once the start passes; unknown entries skip the check', () => {
  const crew = ['crew-a', 'crew-b'], row = job({ arrivedAt: '2026-09-22T14:55:00Z' });
  const entries = [
    { employee: 'Crew-A', clockInAt: '2026-09-22T14:45:00Z', status: 'active' },
    { employee: 'crew-b', clockInAt: '2026-09-21T14:45:00Z', status: 'submitted' },
    { employee: 'crew-b', clockInAt: '2026-09-22T14:50:00Z', approvalStatus: 'rejected' },
  ];
  assert.deepEqual(flags(row, { now: at('2026-09-22T14:59:00Z'), crew, timeEntries: entries }), [], 'before the start nobody is late to clock in');
  const missing = flags(row, { now: at('2026-09-22T15:00:00Z'), crew, timeEntries: entries });
  assert.deepEqual(kinds(missing), ['not_clocked_in']);
  assert.deepEqual(missing[0].members, ['crew-b']);
  assert.equal(missing[0].tone, 'amber');
  assert.deepEqual(flags(row, { now: at('2026-09-22T15:30:00Z'), crew, timeEntries: [...entries, { employeeName: 'Crew B', clockInAt: '2026-09-22T15:20:00Z' }] }), [], 'a later clock-in clears the flag');
  assert.deepEqual(flags(row, { now: at('2026-09-22T15:30:00Z'), crew, timeEntries: null }), []);
  assert.deepEqual(flags(row, { now: at('2026-09-22T15:30:00Z'), crew: [], timeEntries: [] }), []);
  // A clock-in that has not happened yet (a future-dated row) does not count.
  assert.deepEqual(flags(row, { now: at('2026-09-22T15:00:00Z'), crew: ['crew-a'], timeEntries: [{ employee: 'crew-a', clockInAt: '2026-09-22T16:00:00Z' }] })[0].members, ['crew-a']);
});

test('the Hub runs the same rule file as a classic script', () => {
  const context = { Intl, Date };
  context.window = context; vm.createContext(context);
  vm.runInContext(source('employee-arrival-deadline.js'), context, { filename: 'employee-arrival-deadline.js' });
  const now = at('2026-09-22T16:00:00Z'), row = job({ arrivalWindowStart: '09:00', arrivalWindowEnd: '10:00' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.EGCArrivalDeadline.flags(row, { now }))), flags(row, { now }));
  assert.ok(Object.isFrozen(context.window.EGCArrivalDeadline));
  assert.match(source('employee.html'), /<script src="employee-arrival-deadline\.js\?v=[^"]+"><\/script>\s*<script src="employee-suite\.js/);
});

test('the dispatch read and DTO carry dispatchedAt, arrivedAt and startedAt', () => {
  for (const field of ['dispatchedAt', 'arrivedAt', 'startedAt']) assert.ok(JOB_FIELDS.includes(field), field);
  const dto = projectDispatchJob(job({ dispatchedAt: '2026-09-22T14:40:00Z', arrivedAt: '2026-09-22T15:05:00Z', startedAt: '2026-09-22T15:20:00Z', dispatchedBy: 'crew-a' }), [], '2026-09-22T16:00:00Z');
  assert.equal(dto.dispatchedAt, '2026-09-22T14:40:00Z');
  assert.equal(dto.arrivedAt, '2026-09-22T15:05:00Z');
  assert.equal(dto.startedAt, '2026-09-22T15:20:00Z');
  assert.equal(dto.dispatchedBy, undefined, 'only the timestamps are added');
  assert.equal('arrivedAt' in projectDispatchJob(job(), [], '2026-09-22T16:00:00Z'), false);
});

function hub({ timeEntries = [], peopleLoaded = true, rule = true } = {}) {
  const context = { Date: FixedDate, Intl, URLSearchParams, console, sessionStorage: storage({ egc_u: 'ZacB', egc_business_access: 'true', egc_owner: 'true', egc_role: 'owner' }), localStorage: storage(), navigator: {}, location: { search: '' }, jobsCache: [],
    managerScheduleState: { loaded: true, loading: false, error: '', fromCache: false, pending: false }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, addEventListener() {},
    document: { readyState: 'loading', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} } };
  context.window = context; vm.createContext(context);
  if (rule) vm.runInContext(source('employee-arrival-deadline.js'), context);
  vm.runInContext(source('employee-suite.js').replace(/\}\)\(\);\s*$/, 'globalThis.api={agenda,attention,S};})();'), context);
  Object.assign(context.api.S.peopleState, { loaded: peopleLoaded, error: '' });
  context.api.S.people.timeEntries = timeEntries;
  return context;
}

test('the Today agenda shows red and amber chips and Needs attention counts the flagged jobs', () => {
  // The Hub's fixed clock is 2026-09-22 12:00 in Denver.
  const p = hub({ timeEntries: [{ employee: 'crew-a', clockInAt: '2026-09-22T14:00:00Z', status: 'active' }] });
  p.jobsCache = [
    job({ id: 'late-job', customer: 'Synthetic Late', time: '10:00', assignedCrew: ['crew-a', 'crew-b'] }),
    job({ id: 'soon-job', customer: 'Synthetic Soon', time: '12:20', endTime: '14:00', assignedCrew: ['crew-a'] }),
    job({ id: 'on-site', customer: 'Synthetic On Site', time: '10:00', arrivedAt: '2026-09-22T16:05:00Z', assignedCrew: ['crew-a'] }),
    job({ id: 'done-job', customer: 'Synthetic Done', time: '08:00', status: 'completed', completedAt: '2026-09-22T17:00:00Z', assignedCrew: ['crew-b'] }),
    job({ id: 'walk', type: 'walkthrough', customer: 'Synthetic Walk', time: '09:00' }),
  ];
  const html = p.api.agenda(), row = id => html.split('<article>').find(part => part.includes(id)) || '';
  assert.match(row('Synthetic Late'), /<li class="red">Late · due 10:15 AM<\/li>/);
  assert.match(row('Synthetic Late'), /<li class="amber">Not clocked in: crew-b<\/li>/);
  assert.match(row('Synthetic Soon'), /<li class="amber">Not en route<\/li>/);
  for (const quiet of ['Synthetic On Site', 'Synthetic Done', 'Synthetic Walk']) assert.doesNotMatch(row(quiet), /ops-field-flags/, quiet);
  const attention = p.api.attention();
  assert.match(attention, /2 jobs flagged today/);
  assert.match(attention, /1 late · 1 not en route · 1 crew member not clocked in\./);
  assert.match(attention, /opsGo\('today'\)/);
  // Tomorrow's list never shows today's flags.
  p.opsAgendaDay(1);
  assert.doesNotMatch(p.api.agenda(), /ops-field-flags/);
  p.opsAgendaDay(0);
  assert.equal(p.api.agenda().match(/ops-field-flags/g).length, 2);
});

test('the agenda stays usable when the time entries or the rule file are missing', () => {
  const late = job({ id: 'late-job', customer: 'Synthetic Late', time: '10:00', assignedCrew: ['crew-b'] });
  const unloaded = hub({ peopleLoaded: false });
  unloaded.jobsCache = [late];
  const html = unloaded.api.agenda();
  assert.match(html, /Late · due 10:15 AM/);
  assert.doesNotMatch(html, /Not clocked in/, 'unknown time entries never claim nobody clocked in');
  const failed = hub(); failed.api.S.peopleState.error = 'Synthetic read failure'; failed.jobsCache = [late];
  assert.doesNotMatch(failed.api.agenda(), /Not clocked in/);
  const bare = hub({ rule: false });
  bare.jobsCache = [late];
  assert.match(bare.api.agenda(), /Synthetic Late/);
  assert.doesNotMatch(bare.api.agenda(), /ops-field-flags/);
  assert.doesNotMatch(bare.api.attention(), /flagged/);
  // An unverified schedule shows no flags at all.
  const pending = hub(); pending.jobsCache = [late]; pending.managerScheduleState = { loaded: false, loading: true };
  assert.doesNotMatch(pending.api.attention(), /flagged/);
});
