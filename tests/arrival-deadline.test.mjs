import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { storage, FixedDate } from './helpers/hub-dom.mjs';
import { flags, visitRow, arrivalDeadline, enRouteDeadline, startAt, denverDate } from '../functions/_lib/arrival-deadline.js';
import { projectDispatchJob } from '../functions/_lib/dispatch-service.js';
import { formatArrivalWindow } from '../functions/_lib/dispatch-arrival.js';
import { fieldChecklist, fieldCommand, fieldJobProjection } from '../functions/_lib/field-execution.js';
import { fieldVisitCommand } from '../functions/_lib/field-execution-visits.js';

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
  for (const window of [{ arrivalWindowEnd: '10:00' }, { arrivalWindowStart: '10:00', arrivalWindowEnd: '09:00' }, { arrivalWindowStart: '09:00', arrivalWindowEnd: '25:00' }])
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
  assert.deepEqual(flags({ ...row, pipelineStatus: 'dispatched', status: 'dispatched' }, { now: at('2026-09-22T15:00:00Z') }), []);
});

test('a job already arrived or started, or cancelled or finished, is never flagged late', () => {
  const now = at('2026-09-22T17:00:00Z');
  for (const fields of [{ arrivedAt: '2026-09-22T15:20:00Z' }, { startedAt: '2026-09-22T15:30:00Z' }, { status: 'in_progress' }, { pipelineStatus: 'arrived' }, { fieldExecution: { activity: 'in_progress', activityAt: '2026-09-22T15:10:00Z' } },
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

test('the dispatch DTO does not add the field timestamps (no reader; they would reach bookers)', () => {
  const dto = projectDispatchJob(job({ dispatchedAt: '2026-09-22T14:40:00Z', arrivedAt: '2026-09-22T15:05:00Z', startedAt: '2026-09-22T15:20:00Z' }), [], '2026-09-22T16:00:00Z');
  for (const field of ['dispatchedAt', 'arrivedAt', 'startedAt']) assert.equal(field in dto, false, field);
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

// Review of #194 — finding 2: dispatch's default arrival window saves arrivalWindowStart/End null and only the label.
test('the default-window label dispatch saves is the deadline, read only in formatArrivalWindow\'s exact form', () => {
  const label = formatArrivalWindow('11:30', '12:30');
  assert.equal(label, '11:30 AM – 12:30 PM');
  const row = job({ time: '11:30', endTime: '14:00', arrivalWindowStart: null, arrivalWindowEnd: null, arrivalWindow: label });
  assert.equal(arrivalDeadline(row), at('2026-09-22T18:30:00Z'), '12:30 MDT');
  assert.deepEqual(kinds(flags(row, { now: at('2026-09-22T18:00:00Z') })), ['not_en_route'], 'inside the promised window it is not late');
  assert.deepEqual(kinds(flags(row, { now: at('2026-09-22T18:30:00Z') })), ['late']);
  // Any other form, a label ending before the start, or a label on a later visit falls back to start + 15.
  for (const arrivalWindow of ['11:30 AM - 12:30 PM', '11:30AM – 12:30PM', '13:30 AM – 12:30 PM', '11:30 AM – 11:00 AM', 'Morning'])
    assert.equal(arrivalDeadline(job({ time: '11:30', arrivalWindow })), at('2026-09-22T17:45:00Z'), arrivalWindow);
  assert.equal(arrivalDeadline({ ...row, firstVisit: false }), at('2026-09-22T17:45:00Z'));
  // Saved ends win over the label.
  assert.equal(arrivalDeadline({ ...row, arrivalWindowStart: '11:30', arrivalWindowEnd: '13:00' }), at('2026-09-22T19:00:00Z'));
});

// Finding 4: a restored visit keeps its old field timestamps and activity; they never count for today.
test('a restored or rebooked visit never inherits an earlier arrival, dispatch or stale activity', () => {
  const now = at('2026-09-22T17:00:00Z');
  const stale = { dispatchedAt: '2026-09-15T14:40:00Z', arrivedAt: '2026-09-15T15:05:00Z', startedAt: '2026-09-15T15:20:00Z', fieldExecution: { activity: 'in_progress' } };
  assert.deepEqual(kinds(flags(job(stale), { now })), ['late'], 'timestamps from another day do not count');
  const restored = { ...stale, dispatchedAt: '2026-09-22T14:00:00Z', arrivedAt: '2026-09-22T14:10:00Z', restoredAt: '2026-09-22T14:30:00Z', cancelledAt: null };
  assert.deepEqual(kinds(flags(job(restored), { now })), ['late'], 'today\'s timestamps before the restore do not count');
  assert.deepEqual(flags(job({ ...restored, arrivedAt: '2026-09-22T15:10:00Z' }), { now }), [], 'an arrival after the restore does');
  assert.deepEqual(kinds(flags(job({ fieldExecution: { activity: 'arrived' } }), { now })), ['late'], 'an activity the status does not back is ignored');
});

// Finding 3: a split job is flagged per segment, with that segment's date, time and crew.
test('split jobs are flagged per segment with its own time and crew; tomorrow\'s segment and its crew are not', () => {
  const split = job({ time: '08:00', endTime: '17:00', endDate: '2026-09-23', assignedCrew: ['crew-a', 'crew-b', 'crew-c'], assignmentSegments: [
    { id: 'seg-1', date: '2026-09-22', time: '08:00', endTime: '11:00', assignedCrew: ['crew-a'] },
    { id: 'seg-2', date: '2026-09-22', time: '13:00', endTime: '17:00', assignedCrew: ['crew-b'] },
    { id: 'seg-3', date: '2026-09-23', time: '08:00', endTime: '12:00', assignedCrew: ['crew-c'] }] });
  const noon = at('2026-09-22T18:00:00Z'), entries = [];
  const [one, two, three] = split.assignmentSegments.map(segment => visitRow(split, segment));
  assert.deepEqual([one.firstVisit, two.firstVisit, three.firstVisit, two.time, two.assignedCrew], [true, false, false, '13:00', ['crew-b']]);
  assert.deepEqual(flags(one, { now: noon, crew: one.assignedCrew, timeEntries: entries }).map(f => [f.kind, f.members]), [['late', undefined], ['not_clocked_in', ['crew-a']]]);
  assert.deepEqual(flags(two, { now: noon, crew: two.assignedCrew, timeEntries: entries }), [], 'the 13:00 crew is not due yet');
  assert.deepEqual(kinds(flags(two, { now: at('2026-09-22T19:15:00Z'), crew: two.assignedCrew, timeEntries: entries })), ['late', 'not_clocked_in'], '13:15, the 13:00 visit\'s deadline');
  assert.deepEqual(flags(three, { now: noon, crew: three.assignedCrew, timeEntries: entries }), [], 'tomorrow\'s crew is not flagged today');
  // The first visit's status does not carry to the 13:00 visit, and a first-visit arrival does not cover it either.
  const started = { ...split, pipelineStatus: 'in_progress', status: 'in_progress', arrivedAt: '2026-09-22T14:05:00Z' };
  assert.deepEqual(flags(visitRow(started, started.assignmentSegments[0]), { now: noon }), []);
  assert.deepEqual(kinds(flags(visitRow(started, started.assignmentSegments[1]), { now: at('2026-09-22T19:30:00Z') })), [], 'a same-day arrival covers a later visit that day');
  // A day-2 segment today on a job whose hull started yesterday is flagged.
  const dayTwo = job({ date: '2026-09-21', time: '08:00', endDate: '2026-09-22', assignmentSegments: [{ id: 'd1', date: '2026-09-21', time: '08:00', endTime: '12:00', assignedCrew: ['crew-a'] }, { id: 'd2', date: '2026-09-22', time: '09:00', endTime: '12:00', assignedCrew: ['crew-a'] }] });
  assert.deepEqual(kinds(flags(visitRow(dayTwo, dayTwo.assignmentSegments[1]), { now: noon })), ['late']);
  // A multi-day job still "in progress" from yesterday needs today's start to count as arrived on day 2.
  const carried = { ...dayTwo, pipelineStatus: 'in_progress', status: 'in_progress', startedAt: '2026-09-21T14:30:00Z' };
  assert.deepEqual(kinds(flags(visitRow(carried, carried.assignmentSegments[1]), { now: noon })), ['late']);
  assert.deepEqual(flags(visitRow({ ...carried, fieldExecution: { activity: 'in_progress', activityAt: '2026-09-22T15:05:00Z' } }, carried.assignmentSegments[1]), { now: noon }), [], 'today\'s Working tap counts');
});

// Finding 1: the whole timecard history is indexed once per array, so a render stays fast on a phone.
test('thousands of historical time entries cost one indexing pass, not one date format per entry per member', () => {
  const history = [];
  for (let i = 0; i < 5000; i++) history.push({ id: `old-${i}`, employee: `crew-${i % 40}`, clockInAt: new Date(at('2024-01-01T15:00:00Z') + i * 3 * 3600000).toISOString(), clockOutAt: null, status: 'submitted' });
  history.push({ id: 'today', employee: 'crew-1', clockInAt: '2026-09-22T13:50:00Z', status: 'active' });
  const rows = Array.from({ length: 12 }, (_, n) => job({ id: `job-${n}`, time: '08:00' }));
  const crew = ['crew-1', 'crew-2', 'crew-3', 'Crew Four'], now = at('2026-09-22T18:00:00Z');
  const started = performance.now();
  for (let render = 0; render < 5; render++) for (const row of rows) flags(row, { now, crew, timeEntries: history });
  const elapsed = performance.now() - started;
  assert.deepEqual(flags(rows[0], { now, crew, timeEntries: history })[1].members, ['crew-2', 'crew-3', 'Crew Four']);
  assert.ok(elapsed < 400, `5 renders of 12 rows × 4 crew over 5,001 entries took ${Math.round(elapsed)} ms`);
  // A new array (the next poll) is indexed again, so a fresh clock-in shows up.
  const next = [...history, { id: 'late-in', employee: 'crew-2', clockInAt: '2026-09-22T17:00:00Z' }];
  assert.deepEqual(flags(rows[0], { now, crew, timeEntries: next })[1].members, ['crew-3', 'Crew Four']);
});

test('the agenda flags each segment of a split job on its own row and Needs attention counts each person once', () => {
  // The Hub's fixed clock is 2026-09-22 12:00 in Denver; nobody has clocked in.
  const p = hub({ timeEntries: [] });
  p.jobsCache = [
    job({ id: 'split-job', customer: 'Synthetic Split', time: '08:00', endTime: '17:00', endDate: '2026-09-23', assignedCrew: ['crew-a', 'crew-b'], assignmentSegments: [
      { id: 'seg-1', date: '2026-09-22', time: '08:00', endTime: '10:00', assignedCrew: ['crew-a'] },
      { id: 'seg-2', date: '2026-09-22', time: '10:30', endTime: '13:00', assignedCrew: ['crew-a'] },
      { id: 'seg-3', date: '2026-09-22', time: '15:00', endTime: '17:00', assignedCrew: ['crew-b'] },
      { id: 'seg-4', date: '2026-09-23', time: '08:00', endTime: '12:00', assignedCrew: ['crew-c'] }] }),
    job({ id: 'day-two', customer: 'Synthetic Day Two', date: '2026-09-21', time: '08:00', endDate: '2026-09-22', status: 'in_progress', pipelineStatus: 'in_progress', startedAt: '2026-09-21T14:30:00Z', assignmentSegments: [
      { id: 'd1', date: '2026-09-21', time: '08:00', endTime: '12:00', assignedCrew: ['crew-d'] }, { id: 'd2', date: '2026-09-22', time: '09:00', endTime: '12:00', assignedCrew: ['crew-d'] }] }),
    job({ id: 'promised', customer: 'Synthetic Promise', time: '11:30', endTime: '14:00', arrivalWindowStart: null, arrivalWindowEnd: null, arrivalWindow: '11:30 AM – 12:30 PM', assignedCrew: ['crew-a'] }),
  ];
  const html = p.api.agenda(), articles = html.split('<article>').slice(1);
  const at = time => articles.find(part => part.startsWith(`<time>${time}`)) || '';
  assert.match(at('8:00 AM'), /<li class="red">Late · due 8:15 AM<\/li><li class="amber">Not clocked in: crew-a<\/li>/);
  assert.match(at('10:30 AM'), /Late · due 10:45 AM/);
  assert.doesNotMatch(at('3:00 PM'), /ops-field-flags/, 'the 15:00 crew is not due yet');
  assert.match(at('9:00 AM'), /Synthetic Day Two/); assert.match(at('9:00 AM'), /Late · due 9:15 AM/);
  assert.match(at('11:30 AM'), /<li class="amber">Not en route<\/li>/, 'inside the 11:30–12:30 promise it is not late');
  assert.doesNotMatch(html, /crew-c/, 'tomorrow\'s crew is nowhere on today\'s flags');
  const attention = p.api.attention();
  assert.match(attention, /3 jobs flagged today/);
  assert.match(attention, /2 late · 1 not en route · 2 crew members not clocked in\./, 'crew-a is late to three visits but counted once');
});

// Review of #194, round 2: the flags read what the real crew commands write. A split job over two days, crew.one on both.
const denver = (date, time) => new Date(`${date}T${time}:00.000-06:00`).toISOString();
const segment = (id, date) => ({ id, date, time: '08:00', endDate: date, endTime: '17:00', assignedCrew: ['crew.one'], crewLead: null, crewId: null, vehicleId: null, notes: '' });
function twoDay() {
  const row = { id: 'synthetic-two-day', type: 'job', customer: 'Synthetic Two Day', date: '2026-09-22', time: '08:00', endDate: '2026-09-23', endTime: '17:00', assignedCrew: ['crew.one'], crewLead: 'crew.one',
    status: 'scheduled', pipelineStatus: 'scheduled', assignmentSegments: [segment('a', '2026-09-22'), segment('b', '2026-09-23')] };
  row.fieldExecution = { checks: Object.fromEntries(fieldChecklist(row).map(item => [item.id, { completed: true, actorId: 'crew.one' }])), photos: ['before', 'after'].map((category, n) => ({ id: `00000000-0000-4000-8000-00000000000${n + 1}`, fileId: `file-${category}`, category, verified: true })) };
  return row;
}
const tapper = { user: 'crew.one', displayName: 'Crew One', manager: false };
let taps = 0;
const tap = (command, row, status, now) => ({ ...row, ...command(row, tapper, { action: 'status', status, requestId: `00000000-0000-4000-8000-${String(++taps).padStart(12, '0')}`, ...(['paused', 'waiting', 'delayed'].includes(status) ? { reason: 'Synthetic traffic' } : {}) }, now).patch });

test('day 2 of a split job: a Working tap from in progress (FIELD_MULTIDAY_VISITS off) clears the flags; no tap is Late', () => {
  let row = tap(fieldCommand, twoDay(), 'dispatched', denver('2026-09-22', '07:40'));
  row = tap(fieldCommand, row, 'arrived', denver('2026-09-22', '07:58'));
  row = tap(fieldCommand, row, 'in_progress', denver('2026-09-22', '08:05'));
  const dayTwo = current => visitRow(current, current.assignmentSegments[1]);
  // Day 2 before any tap: no en-route action exists from in progress, so only Late can show, at 08:15.
  assert.deepEqual(flags(dayTwo(row), { now: at(denver('2026-09-23', '07:45')) }), [], 'no Not en route the crew cannot clear');
  assert.deepEqual(kinds(flags(dayTwo(row), { now: at(denver('2026-09-23', '08:15')) })), ['late']);
  const working = tap(fieldCommand, row, 'in_progress', denver('2026-09-23', '08:02'));
  assert.equal(working.startedAt, denver('2026-09-22', '08:05'), 'the job-level start stays on day 1');
  assert.equal(working.fieldExecution.visits, undefined, 'no visit record with the switch off');
  for (const time of ['08:15', '11:00', '16:30']) assert.deepEqual(flags(dayTwo(working), { now: at(denver('2026-09-23', time)) }), [], time);
});

test('FIELD_MULTIDAY_VISITS on: the day\'s first tap writes a visit record, but En route is still Late at the deadline; Working clears it', () => {
  const dispatched = tap(fieldVisitCommand, twoDay(), 'dispatched', denver('2026-09-22', '07:40'));
  assert.ok(dispatched.fieldExecution.visits['2026-09-22'].startedAt, 'the visit record exists after only En route');
  const first = visitRow(dispatched, dispatched.assignmentSegments[0]);
  assert.deepEqual(flags(first, { now: at(denver('2026-09-22', '08:10')) }), [], 'en route, inside the grace period');
  assert.deepEqual(kinds(flags(first, { now: at(denver('2026-09-22', '08:15')) })), ['late'], 'en route but never arrived is Late');
  // A crew whose first tap of a day is En route at 08:40 on day 2 is Late at 08:15 already and stays Late.
  let row = tap(fieldVisitCommand, dispatched, 'arrived', denver('2026-09-22', '07:58'));
  row = tap(fieldVisitCommand, row, 'in_progress', denver('2026-09-22', '08:05'));
  const late = tap(fieldVisitCommand, row, 'delayed', denver('2026-09-23', '08:40'));
  assert.ok(late.fieldExecution.visits['2026-09-23'].startedAt);
  assert.deepEqual(kinds(flags(visitRow(late, late.assignmentSegments[1]), { now: at(denver('2026-09-23', '09:15')) })), ['late']);
  const working = tap(fieldVisitCommand, late, 'in_progress', denver('2026-09-23', '09:20'));
  assert.deepEqual(flags(visitRow(working, working.assignmentSegments[1]), { now: at(denver('2026-09-23', '09:30')) }), []);
});

// Review of #194, round 3: the crew can only tap what crew/job.js shows. statusButtons() is read from the page itself and
// fed the server projection, so a sequence only uses buttons a crew member actually sees.
const pageButtons = (() => {
  const line = read => read.split(/\r?\n/).find(row => row.trim().startsWith('function statusButtons('));
  const context = {}; vm.createContext(context);
  vm.runInContext(`${line(source('crew/job.js')).trim()}\nglobalThis.statusButtons = statusButtons;`, context);
  return (row, now, viewer = 'crew.one') => { const view = fieldJobProjection(row, [], { now, viewer }); return [...context.statusButtons({ ...view, statusQueued: false })]; };
})();
// The crew job page's projection for the crew member on both days (#219: Start today's work is for today's crew).
const project = (row, now, viewer = 'crew.one') => fieldJobProjection(row, [], { now, viewer });
const press = (command, row, status, now) => { assert.ok(pageButtons(row, at(now)).includes(status), `the page offers ${status} at ${now}`); return tap(command, row, status, now); };

for (const [name, command] of [['FIELD_MULTIDAY_VISITS off', fieldCommand], ['FIELD_MULTIDAY_VISITS on, End day skipped', fieldVisitCommand]]) {
  test(`day 2 of a split job left in Working overnight (${name}): the page offers Start today's work, and tapping it clears Late`, () => {
    let row = press(command, twoDay(), 'dispatched', denver('2026-09-22', '07:40'));
    row = press(command, row, 'arrived', denver('2026-09-22', '07:58'));
    row = press(command, row, 'in_progress', denver('2026-09-22', '08:05'));
    assert.ok(!pageButtons(row, at(denver('2026-09-22', '12:00'))).includes('in_progress'), 'the same day, Working is not offered again');
    // Day 2: the job is still in Working; the page offers it as Start today's work.
    const morning = at(denver('2026-09-23', '07:55'));
    assert.deepEqual(pageButtons(row, morning), ['paused', 'waiting', 'delayed', 'in_progress']);
    assert.equal(project(row, morning).startTodayOffered, true);
    assert.deepEqual(kinds(flags(visitRow(row, row.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:15')) })), ['late'], 'no tap yet: Late');
    const started = press(command, row, 'in_progress', denver('2026-09-23', '08:02'));
    assert.equal(project(started, at(denver('2026-09-23', '09:00'))).startTodayOffered, false, 'offered once a day');
    for (const time of ['08:15', '12:00', '16:30']) assert.deepEqual(flags(visitRow(started, started.assignmentSegments[1]), { now: at(denver('2026-09-23', time)) }), [], time);
  });
}

test('an End day saved offline and synced after midnight is not the next day\'s arrival', () => {
  let row = tap(fieldVisitCommand, twoDay(), 'dispatched', denver('2026-09-22', '07:40'));
  row = tap(fieldVisitCommand, row, 'arrived', denver('2026-09-22', '07:58'));
  row = tap(fieldVisitCommand, row, 'in_progress', denver('2026-09-22', '08:05'));
  const late = { ...row, ...fieldVisitCommand(row, tapper, { action: 'end_day', requestId: '00000000-0000-4000-8000-0000000000e1', visitDate: '2026-09-22', notes: 'Synthetic day one notes, synced late.' }, denver('2026-09-23', '00:30')).patch };
  assert.equal(late.fieldExecution.activity, 'day_ended');
  assert.equal(late.fieldExecution.activityAt, denver('2026-09-23', '00:30'), 'the late sync carries day 2\'s time');
  assert.deepEqual(kinds(flags(visitRow(late, late.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:15')) })), ['late'], 'an absent crew is still Late on day 2');
  // An End day for today's own visit, after working it, keeps today quiet.
  let today = tap(fieldVisitCommand, late, 'in_progress', denver('2026-09-23', '08:05'));
  today = { ...today, ...fieldVisitCommand(today, tapper, { action: 'end_day', requestId: '00000000-0000-4000-8000-0000000000e2', notes: 'Synthetic day two notes, done for today.' }, denver('2026-09-23', '15:00')).patch };
  assert.deepEqual(flags(visitRow(today, today.assignmentSegments[1]), { now: at(denver('2026-09-23', '16:00')) }), []);
});

// #219 (review of #194): the phone's tap time, stricter arrival evidence, and Start today's work for today's crew only.
const tapAt = (command, row, status, tappedAt, now, actor = tapper) => ({ ...row, ...command(row, actor, { action: 'status', status, requestId: `00000000-0000-4000-8000-${String(++taps).padStart(12, '0')}`, tappedAt, ...(['paused', 'waiting', 'delayed'].includes(status) ? { reason: 'Synthetic traffic' } : {}) }, now).patch });
const working = command => {
  let row = tap(command, twoDay(), 'dispatched', denver('2026-09-22', '07:40'));
  row = tap(command, row, 'arrived', denver('2026-09-22', '07:58'));
  return tap(command, row, 'in_progress', denver('2026-09-22', '08:05'));
};

test('the server keeps the phone\'s tap time, within the 48 hours before its own time and never after it', () => {
  // A job with no stored tap time yet (saved before this change), so only the clamp applies here.
  const fresh = () => { const row = working(fieldCommand); return { ...row, fieldExecution: { ...row.fieldExecution, activityTappedAt: undefined } }; };
  const now = denver('2026-09-23', '09:00'), saved = tappedAt => tapAt(fieldCommand, fresh(), 'paused', tappedAt, now).fieldExecution;
  assert.equal(saved(denver('2026-09-23', '08:40')).activityTappedAt, denver('2026-09-23', '08:40'));
  assert.equal(saved(denver('2026-09-23', '08:40')).activityAt, now, 'when it reached the server is kept too');
  assert.equal(saved(denver('2026-09-23', '09:30')).activityTappedAt, now, 'a phone clock ahead of the server is the server\'s time');
  assert.equal(saved(denver('2026-09-20', '09:00')).activityTappedAt, denver('2026-09-21', '09:00'), 'older than 48 hours is held at 48 hours');
  for (const value of [undefined, 'yesterday', 42]) assert.equal(saved(value).activityTappedAt, now, `${value}: the server's time`);
  // End day carries it too.
  const ended = fieldVisitCommand(working(fieldVisitCommand), tapper, { action: 'end_day', requestId: '00000000-0000-4000-8000-0000000000f1', tappedAt: denver('2026-09-22', '16:30'), notes: 'Synthetic day one notes, done for today.' }, denver('2026-09-22', '16:35')).patch.fieldExecution;
  assert.deepEqual([ended.activity, ended.activityTappedAt], ['day_ended', denver('2026-09-22', '16:30')]);
});

for (const [name, command] of [['FIELD_MULTIDAY_VISITS off', fieldCommand], ['FIELD_MULTIDAY_VISITS on', fieldVisitCommand]]) {
  test(`a day-1 tap queued offline and synced on day 2 is not day 2's arrival (${name})`, () => {
    const synced = tapAt(command, working(command), 'paused', denver('2026-09-22', '16:00'), denver('2026-09-23', '07:30'));
    assert.equal(synced.fieldExecution.activityAt, denver('2026-09-23', '07:30'), 'it reached the server on day 2');
    assert.deepEqual(kinds(flags(visitRow(synced, synced.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:15')) })), ['late'], 'no false green on day 2');
    // An on-site tap saved offline at 07:58 on day 2: Late until it syncs, then clear.
    const offline = tapAt(command, synced, 'in_progress', denver('2026-09-23', '07:58'), denver('2026-09-23', '09:00'));
    assert.deepEqual(flags(visitRow(offline, offline.assignmentSegments[1]), { now: at(denver('2026-09-23', '09:05')) }), [], 'once synced, the arrival counts');
  });
}

test('an End day counts as arrival only for a visit started that day; a Pause before a later visit\'s start is not arrival, a Waiting is', () => {
  // Day 2's End day with no tap first: the visit record has no start, so the crew is still Late.
  const row = working(fieldVisitCommand);
  const ended = { ...row, ...fieldVisitCommand(row, tapper, { action: 'end_day', requestId: '00000000-0000-4000-8000-0000000000f2', notes: 'Synthetic day two notes, never started.' }, denver('2026-09-23', '07:50')).patch };
  assert.equal(ended.fieldExecution.visits['2026-09-23'].startedAt, null);
  assert.deepEqual(kinds(flags(visitRow(ended, ended.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:15')) })), ['late']);
  // A Pause tapped at 07:30 on day 2, before the 08:00 start, is not day 2's arrival; one after the start is.
  for (const command of [fieldCommand, fieldVisitCommand]) {
    const early = tap(command, working(command), 'paused', denver('2026-09-23', '07:30'));
    assert.deepEqual(kinds(flags(visitRow(early, early.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:15')) })), ['late'], 'pre-start Pause');
    const after = tap(command, working(command), 'waiting', denver('2026-09-23', '08:05'));
    assert.deepEqual(flags(visitRow(after, after.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:15')) }), [], 'Waiting after the start');
    // Crew on site at 07:45 for the 08:00 start, waiting on the customer: arrived, never Late.
    const waiting = tap(command, working(command), 'waiting', denver('2026-09-23', '07:45'));
    for (const time of ['08:15', '08:40']) assert.deepEqual(flags(visitRow(waiting, waiting.assignmentSegments[1]), { now: at(denver('2026-09-23', time)) }), [], `Waiting before the start, ${time}`);
  }
});

test('a job\'s status from an earlier day is not today\'s arrival when the job is moved to today', () => {
  const job = (patch = {}) => ({ id: 'synthetic-moved', type: 'job', customer: 'Synthetic Moved', date: '2026-09-23', time: '08:00', endTime: '12:00', assignedCrew: ['crew.one'], ...patch });
  const now = at(denver('2026-09-23', '08:15'));
  // Left in progress on the 22nd and moved to the 23rd: Late.
  assert.deepEqual(kinds(flags(job({ status: 'in_progress', startedAt: denver('2026-09-22', '08:05'), arrivedAt: denver('2026-09-22', '07:58') }), { now })), ['late']);
  assert.deepEqual(kinds(flags(job({ status: 'in_progress', fieldExecution: { activity: 'in_progress', activityAt: denver('2026-09-22', '08:05') } }), { now })), ['late'], 'an earlier tap alone');
  // Dispatched on the 22nd: not en route on the 23rd.
  assert.deepEqual(kinds(flags(job({ status: 'dispatched', dispatchedAt: denver('2026-09-22', '15:00') }), { now: at(denver('2026-09-23', '07:35')) })), ['not_en_route']);
  // Recorded today, or a status with nothing dated (set by hand), still counts; a restore after the earlier work clears it.
  assert.deepEqual(flags(job({ status: 'in_progress', startedAt: denver('2026-09-23', '08:05') }), { now }), []);
  assert.deepEqual(flags(job({ status: 'in_progress' }), { now }), []);
  assert.deepEqual(flags(job({ status: 'arrived', arrivedAt: denver('2026-09-22', '07:58'), restoredAt: denver('2026-09-22', '18:00') }), { now }), []);
});

test('Start today\'s work is offered only to someone who works the job today', () => {
  // Worked on day 1 by crew.one and left in Working; day 2's segment is crew.two's.
  const base = working(fieldCommand), row = { ...base, assignmentSegments: [base.assignmentSegments[0], { ...base.assignmentSegments[1], assignedCrew: ['crew.two'] }] };
  const morning = at(denver('2026-09-23', '07:55'));
  assert.equal(project(row, morning, 'crew.two').startTodayOffered, true, 'day 2\'s crew');
  assert.equal(project(row, morning, 'crew.one').startTodayOffered, false, 'day 1\'s crew, off on day 2');
  assert.equal(fieldJobProjection(row, [], { now: morning, manager: true }).startTodayOffered, true, 'a manager, for a job worked today');
  // A one-day job left in Working is not offered the next day: nobody works it then.
  const single = { ...working(fieldCommand), assignmentSegments: null, endDate: '2026-09-22', endTime: '17:00' };
  assert.equal(project(single, at(denver('2026-09-22', '15:00'))).startTodayOffered, false, 'the same day');
  assert.equal(project(single, morning).startTodayOffered, false, 'the next day');
});

// Review of #224: two phones. A tap made before another person's stored one is stale: it goes into the history but
// replaces neither the activity, its time nor the job clock, so a second phone's queued day-1 tap synced on day 2
// cannot change day 2's flags (main shows no flag in these cases either). One phone replays its own taps in order, so
// a person's own later tap is never stale, however slow their phone's clock.
const otherPhone = { user: 'crew.two', displayName: 'Crew Two', manager: false };
for (const [name, command] of [['FIELD_MULTIDAY_VISITS off', fieldCommand], ['FIELD_MULTIDAY_VISITS on', fieldVisitCommand]]) {
  test(`another person's older tap replaces neither the activity, its time nor the job clock (${name})`, () => {
    for (const startAt of ['07:50', '08:02']) {
      // crew.one taps Start today's work (before or after the 08:00 start); crew.two's queued day-1 Pause syncs at 08:30.
      const started = tapAt(command, working(command), 'in_progress', denver('2026-09-23', startAt), denver('2026-09-23', startAt));
      const replayed = tapAt(command, started, 'paused', denver('2026-09-22', '16:00'), denver('2026-09-23', '08:30'), otherPhone);
      assert.deepEqual([replayed.fieldExecution.activity, replayed.fieldExecution.activityTappedAt], ['in_progress', denver('2026-09-23', startAt)], startAt);
      assert.deepEqual(replayed.fieldExecution.jobTime, started.fieldExecution.jobTime, 'the job clock keeps running work');
      assert.deepEqual(flags(visitRow(replayed, replayed.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:40')) }), [], `Start at ${startAt}`);
    }
    // Delayed at 07:30 on day 2 (not an arrival), then crew.two's queued day-1 Waiting: not today's arrival.
    const delayed = tapAt(command, working(command), 'delayed', denver('2026-09-23', '07:30'), denver('2026-09-23', '07:30'));
    const waiting = tapAt(command, delayed, 'waiting', denver('2026-09-22', '15:00'), denver('2026-09-23', '07:40'), otherPhone);
    assert.deepEqual([waiting.fieldExecution.activity, waiting.fieldExecution.activityTappedAt], ['delayed', denver('2026-09-23', '07:30')]);
    assert.deepEqual(kinds(flags(visitRow(waiting, waiting.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:15')) })), ['late'], 'still Late');
    // A stale End day from crew.two neither replaces today's Start nor stops the clock.
    if (command === fieldVisitCommand) {
      const started = tapAt(command, working(command), 'in_progress', denver('2026-09-23', '08:02'), denver('2026-09-23', '08:02'));
      const ended = fieldVisitCommand(started, otherPhone, { action: 'end_day', requestId: '00000000-0000-4000-8000-0000000000f3', tappedAt: denver('2026-09-23', '07:00'), notes: 'Synthetic day two notes, an old queued end.' }, denver('2026-09-23', '15:00')).patch.fieldExecution;
      assert.deepEqual([ended.activity, ended.activityTappedAt], ['in_progress', denver('2026-09-23', '08:02')]);
      assert.deepEqual(ended.jobTime, started.fieldExecution.jobTime, 'the job clock keeps running work');
    }
  });

  test(`a person's own later tap counts even when their phone's clock runs slow (${name})`, () => {
    // crew.one taps Start online at 09:00 (server time); their Pause made offline at a real 09:02, with the phone 5
    // minutes slow (08:57), syncs at 09:03. It is their own next tap, so it is recorded and the clock pauses.
    const started = tapAt(command, working(command), 'in_progress', undefined, denver('2026-09-23', '09:00'));
    const paused = tapAt(command, started, 'paused', denver('2026-09-23', '08:57'), denver('2026-09-23', '09:03'));
    assert.deepEqual([paused.fieldExecution.activity, paused.fieldExecution.activityTappedAt], ['paused', denver('2026-09-23', '08:57')]);
    assert.notDeepEqual(paused.fieldExecution.jobTime, started.fieldExecution.jobTime, 'the clock moved to the pause');
  });
}

// Review of #224: an Arrived or Start made on day 1 and synced on day 2 is day 1's. Its arrival, dispatch and first
// start are stamped with the tap's own time, and it neither opens nor reopens day 2's visit, so day 2 is still Late.
for (const [name, command] of [['FIELD_MULTIDAY_VISITS off', fieldCommand], ['FIELD_MULTIDAY_VISITS on', fieldVisitCommand]]) {
  test(`an En route, Arrived or Start made on day 1 and synced on day 2 is day 1's (${name})`, () => {
    let row = tapAt(command, twoDay(), 'dispatched', denver('2026-09-22', '07:40'), denver('2026-09-23', '07:30'));
    row = tapAt(command, row, 'arrived', denver('2026-09-22', '07:58'), denver('2026-09-23', '07:31'));
    row = tapAt(command, row, 'in_progress', denver('2026-09-22', '08:05'), denver('2026-09-23', '07:32'));
    assert.deepEqual([row.dispatchedAt, row.arrivedAt, row.startedAt], [denver('2026-09-22', '07:40'), denver('2026-09-22', '07:58'), denver('2026-09-22', '08:05')]);
    assert.equal(row.fieldExecution.activityAt, denver('2026-09-23', '07:32'), 'when it reached the server is kept');
    assert.equal(row.fieldExecution.visits?.['2026-09-23'], undefined, 'day 2\'s visit is not opened');
    assert.deepEqual(kinds(flags(visitRow(row, row.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:15')) })), ['late'], 'day 2 is still Late');
    // Day 2's own Start today's work clears it.
    const today = tapAt(command, row, 'in_progress', denver('2026-09-23', '08:20'), denver('2026-09-23', '08:20'));
    assert.deepEqual(flags(visitRow(today, today.assignmentSegments[1]), { now: at(denver('2026-09-23', '08:30')) }), []);
    if (command === fieldVisitCommand) assert.equal(today.fieldExecution.visits['2026-09-23'].startedAt, denver('2026-09-23', '08:20'));
    // A tap made today is stamped with the server's time, as before.
    const sameDay = tapAt(command, twoDay(), 'dispatched', denver('2026-09-22', '07:39'), denver('2026-09-22', '07:40'));
    assert.equal(sameDay.dispatchedAt, denver('2026-09-22', '07:40'));
  });
}
