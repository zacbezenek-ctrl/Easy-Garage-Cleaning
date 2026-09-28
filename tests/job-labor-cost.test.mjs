process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { computeJobLaborCost } from '../functions/_lib/job-labor-cost.js';
import { authorizeTimecard } from '../functions/_lib/employee-timecards.js';
import { applyEmployeeJobAction } from '../functions/_lib/employee-job-time.js';
import { jobCostingHandlers } from '../functions/api/job-costing.js';

const NOW = '2026-10-05T18:00:00.000Z';
const at = (date, time) => `${date}T${time}:00-06:00`;
const WEEK = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
// parts: [kind, jobId, start HH:MM]; each segment runs until the next part or clock-out.
function tracked(id, date, from, to, parts, extra = {}) {
  const segments = parts.map(([kind, jobId, start], index) => ({ id: `${id}-segment-${index}`, kind, jobId, jobLabel: jobId ? `Garage ${jobId}` : '', startedAt: at(date, start), endedAt: at(date, parts[index + 1]?.[2] ?? to), actorId: 'Crew.One', endReason: 'job_switch' }));
  return { id, employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 20, clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [],
    jobTracking: { version: 1, coverageStartedAt: at(date, from), partialHistory: false, segments }, ...extra };
}
const cost = (timecards, options = {}) => computeJobLaborCost({ timecards, start: '2026-09-21', end: '2026-09-28', now: NOW, ...options });
const byJob = result => Object.fromEntries(result.jobs.map(row => [row.jobId, row]));

test('job labor uses explicit work segments at the snapshotted rate, with travel only when requested', () => {
  const cards = [tracked('shift', '2026-09-21', '08:00', '16:00', [['travel', 'job-a', '08:00'], ['work', 'job-a', '09:00'], ['work', 'job-b', '13:00']], { hourlyRate: 25 })];
  const plain = byJob(cost(cards));
  assert.deepEqual(plain['job-a'].approved, { workHours: 4, travelHours: 1, laborHours: 4, straightCost: 100, overtimePremium: 0, cost: 100 });
  assert.deepEqual(plain['job-b'].approved, { workHours: 3, travelHours: 0, laborHours: 3, straightCost: 75, overtimePremium: 0, cost: 75 });
  assert.deepEqual([plain['job-a'].jobLabel, plain['job-a'].approvedTimecards, plain['job-a'].employees], ['Garage job-a', 1, [{ employee: 'crew.one', name: 'Crew One', approvedHours: 4, pendingHours: 0, approvedCost: 100, projectedCost: 100 }]]);
  const travel = cost(cards, { includeTravel: true });
  assert.deepEqual([byJob(travel)['job-a'].approved.laborHours, byJob(travel)['job-a'].approved.cost, travel.includeTravel], [5, 125, true]);
  assert.deepEqual(travel.totals.approved, { workHours: 7, travelHours: 1, laborHours: 8, straightCost: 200, overtimePremium: 0, cost: 200 });
  assert.equal(travel.source, 'explicit_employee_job_segments');
});

test('the weekly overtime premium is allocated to jobs in proportion to their hours, even outside the queried range', () => {
  const cards = WEEK.map((date, index) => tracked(`d${index}`, date, '06:00', '16:00', [['work', index < 3 ? 'job-a' : 'job-b', '06:00']]));
  const result = cost(cards), jobs = byJob(result);
  assert.deepEqual(jobs['job-a'].approved, { workHours: 30, travelHours: 0, laborHours: 30, straightCost: 600, overtimePremium: 60, cost: 660 });
  assert.deepEqual(jobs['job-b'].approved, { workHours: 20, travelHours: 0, laborHours: 20, straightCost: 400, overtimePremium: 40, cost: 440 });
  assert.equal(result.totals.approved.overtimePremium, 100);
  assert.deepEqual(result.jobs.map(row => row.jobId), ['job-a', 'job-b']);
  const partial = cost(cards, { start: '2026-09-24', end: '2026-09-26' });
  assert.deepEqual(partial.jobs.map(row => [row.jobId, row.approved.cost]), [['job-b', 440]]);
  assert.equal(byJob(cost(cards, { policy: 'federal' }))['job-b'].approved.overtimePremium, 40);
  const daily = cost([tracked('long', '2026-09-21', '06:00', '20:00', [['work', 'job-a', '06:00'], ['work', 'job-b', '13:00']])]);
  assert.deepEqual(daily.jobs.map(row => [row.jobId, row.approved.straightCost, row.approved.overtimePremium]), [['job-a', 140, 10], ['job-b', 140, 10]]);
  assert.equal(cost([tracked('long', '2026-09-21', '06:00', '20:00', [['work', 'job-a', '06:00']])], { policy: 'federal' }).totals.approved.overtimePremium, 0);
});

test('approved cost counts approved timecards only while pending is the change if pending timecards are approved', () => {
  const cards = WEEK.map((date, index) => tracked(`d${index}`, date, '06:00', '16:00', [['work', index < 3 ? 'job-a' : 'job-b', '06:00']], index < 3 ? {} : { approvalStatus: 'pending' }));
  const result = cost(cards), jobs = byJob(result);
  assert.deepEqual([jobs['job-a'].approved.cost, jobs['job-a'].pending.cost, jobs['job-a'].projected.cost], [600, 60, 660]);
  assert.deepEqual(jobs['job-a'].pending, { workHours: 0, travelHours: 0, laborHours: 0, straightCost: 0, overtimePremium: 60, cost: 60 });
  assert.deepEqual(jobs['job-b'].pending, { workHours: 20, travelHours: 0, laborHours: 20, straightCost: 400, overtimePremium: 40, cost: 440 });
  assert.deepEqual([jobs['job-b'].approvedTimecards, jobs['job-b'].pendingTimecards, jobs['job-b'].approved.cost], [0, 2, 0]);
  assert.deepEqual([result.totals.approved.cost, result.totals.pending.cost, result.totals.projected.cost], [600, 500, 1100]);
  assert.deepEqual(result.coverage, { complete: false, asOf: NOW, reasons: ['pending_timecards'] });
});

test('coverage stays incomplete while any employee-week behind a job is unsettled, even on other jobs or days outside the range', () => {
  const cards = WEEK.map((date, index) => tracked(`d${index}`, date, '06:00', '16:00', [['work', index < 3 ? 'job-a' : 'job-b', '06:00']], index < 3 ? {} : { approvalStatus: 'pending' }));
  // (a) job filter: the pending time is on job-b, but approving it moves overtime premium onto job-a.
  const filtered = cost(cards, { jobId: 'job-a' });
  assert.deepEqual([filtered.totals.approved.cost, filtered.totals.pending.cost, filtered.coverage.complete, filtered.coverage.reasons], [600, 60, false, ['pending_timecards']]);
  // (b) a Monday-Wednesday range with pending Thursday-Friday time in the same week.
  const range = cost(cards, { end: '2026-09-24' });
  assert.deepEqual([range.totals.approved.cost, range.totals.pending.cost, range.coverage.reasons], [600, 60, ['pending_timecards']]);
  // (c) mid-week: later hours this week can still move the weekly premium onto earlier jobs.
  const approvedOnly = cards.slice(0, 3);
  assert.deepEqual(cost(approvedOnly, { now: '2026-09-24T18:00:00.000Z' }).coverage.reasons, ['week_in_progress']);
  assert.deepEqual(cost(approvedOnly, { end: '2026-09-24', now: '2026-09-24T18:00:00.000Z' }).coverage.reasons, ['week_in_progress']);
  assert.equal(cost(approvedOnly, { end: '2026-09-24', now: '2026-09-28T07:00:00.000Z' }).coverage.complete, true, 'Denver Monday morning: the week has ended');
  // Settled time with no overtime still counts as unsettled when it is pending, open or needs review for that employee.
  const base = cards.slice(0, 2), other = (extra, id = 'other') => tracked(id, '2026-09-23', '06:00', '16:00', [['work', 'job-b', '06:00']], extra);
  assert.deepEqual(cost([...base, other({ approvalStatus: 'pending' })], { jobId: 'job-a' }).coverage.reasons, ['pending_timecards']);
  assert.deepEqual(cost([...base, { ...other(), clockOutAt: '', status: 'active', approvalStatus: 'open' }], { jobId: 'job-a' }).coverage.reasons, ['open_shifts']);
  assert.deepEqual(cost([...base, other({ breaks: [{ startAt: at('2026-09-23', '09:00'), endAt: '' }] })], { jobId: 'job-a' }).coverage.reasons, ['needs_review']);
  assert.deepEqual(cost([...base, other({ hourlyRate: 0 })], { jobId: 'job-a' }).coverage.reasons, ['missing_rate']);
  // Another employee's unsettled time never touches this job's cost.
  assert.equal(cost([...base, other({ approvalStatus: 'pending', employee: 'Crew.Two' })], { jobId: 'job-a' }).coverage.complete, true);
  // Unapproved Sunday time that can extend Monday's consecutive-hours run, and records with no readable date.
  const monday = tracked('monday', '2026-09-28', '00:00', '08:00', [['work', 'job-a', '00:00']]);
  const sunday = tracked('sunday', '2026-09-27', '18:00', '23:50', [['work', 'job-a', '18:00']], { approvalStatus: 'pending' });
  const nextWeek = { start: '2026-09-28', end: '2026-10-05', now: '2026-10-06T18:00:00.000Z' };
  assert.deepEqual(cost([sunday, monday], nextWeek).coverage.reasons, ['pending_timecards', 'adjacent_unapproved_time']);
  assert.deepEqual(cost([{ ...sunday, clockOutAt: '', status: 'active', approvalStatus: 'open' }, monday], nextWeek).coverage.reasons, ['adjacent_unapproved_time']);
  const lost = { ...other({}, 'lost'), clockInAt: 'unknown', clockOutAt: 'unknown' };
  assert.deepEqual(cost([...base, lost], { jobId: 'job-a' }).coverage.reasons, ['unattributed_records']);
  assert.equal(cost([...base, { ...lost, employee: 'Crew.Two' }], { jobId: 'job-a' }).coverage.complete, true);
});

test('unreviewable, open, legacy and rejected shifts are counted but never costed', () => {
  const cards = [
    tracked('valid', '2026-09-21', '08:00', '10:00', [['work', 'job-a', '08:00']]),
    tracked('bad-version', '2026-09-22', '08:00', '10:00', [['work', 'job-a', '08:00']], { jobTracking: { version: 2, segments: [{ jobId: 'job-a' }] } }),
    tracked('overlap-1', '2026-09-23', '08:00', '12:00', [['work', 'job-a', '08:00']]), tracked('overlap-2', '2026-09-23', '11:00', '13:00', [['work', 'job-a', '11:00']]),
    { ...tracked('open', '2026-09-24', '08:00', '10:00', [['work', 'job-a', '08:00']]), clockOutAt: '', status: 'active', approvalStatus: 'open' },
    { id: 'legacy', employee: 'Crew.One', hourlyRate: 20, clockInAt: at('2026-09-25', '08:00'), clockOutAt: at('2026-09-25', '12:00'), approvalStatus: 'approved', status: 'submitted', jobId: 'job-a', breaks: [] },
    tracked('rejected', '2026-09-26', '08:00', '12:00', [['work', 'job-a', '08:00']], { approvalStatus: 'rejected' }),
    tracked('old', '2026-09-14', '08:00', '12:00', [['work', 'job-a', '08:00']]),
  ];
  const result = cost(cards), row = byJob(result)['job-a'];
  assert.deepEqual([row.approved.cost, row.approvedTimecards, row.needsReviewCount, row.openShifts, row.legacyAssociationOnlyCount], [40, 1, 3, 1, 1]);
  assert.equal(result.jobs.length, 1, 'the September 14 shift is outside the range');
  assert.deepEqual([result.needsReviewCount, result.openShifts, result.legacyAssociationOnlyCount], [3, 1, 1]);
  assert.deepEqual(result.coverage.reasons, ['needs_review', 'open_shifts']);
});

test('a job filter returns that job only, and job IDs and ranges are validated', () => {
  const cards = [tracked('shift', '2026-09-21', '08:00', '12:00', [['work', 'job-a', '08:00'], ['work', 'job-b', '10:00']])];
  assert.deepEqual(cost(cards, { jobId: 'job-b' }).jobs.map(row => [row.jobId, row.approved.cost]), [['job-b', 40]]);
  const empty = cost(cards, { jobId: 'job-z' });
  assert.deepEqual([empty.jobs.length, empty.jobs[0].jobId, empty.jobs[0].projected.cost, empty.coverage.complete], [1, 'job-z', 0, true]);
  for (const jobId of ['_egc_schedule_lock_2026-09-21', 'secure_abc', 'bad/id', 'x'.repeat(181)]) assert.throws(() => cost(cards, { jobId }), { code: 'job_costing_job_invalid', status: 400 });
  for (const [start, end] of [['2026-09-22', '2026-09-21'], ['2026-09-21', '2026-09-21'], ['2026-01-01', '2026-04-04'], ['2026-02-30', '2026-03-01'], [undefined, '2026-09-21'], ['2026-09-21', '2026-09-28T00:00']]) assert.throws(() => cost(cards, { start, end }), { code: 'job_costing_range_invalid' });
  assert.deepEqual([cost(cards, { start: '2026-01-01', end: '2026-04-03' }).jobs.length, cost(cards, { start: '2026-01-01', end: '2026-04-03' }).endExclusive], [0, true]);
  // The end date is exclusive, like dispatch ranges: a Monday shift is outside a range ending that Monday.
  assert.deepEqual([cost(cards, { start: '2026-09-14', end: '2026-09-21' }).jobs.length, cost(cards, { start: '2026-09-21', end: '2026-09-22' }).jobs.length], [0, 2]);
  assert.throws(() => cost(null), { code: 'job_costing_records_invalid' });
  assert.throws(() => cost(cards, { policy: 'texas' }), { code: 'timesheet_policy_invalid' });
});

test('paid rest breaks stay on the interrupted job while meal breaks are unpaid; missing rates are flagged', () => {
  const breaks = [{ startAt: at('2026-09-21', '10:00'), endAt: at('2026-09-21', '10:10'), kind: 'rest' }, { startAt: at('2026-09-21', '11:00'), endAt: at('2026-09-21', '11:30'), kind: 'meal' }];
  const rest = byJob(cost([tracked('rest', '2026-09-21', '08:00', '12:00', [['work', 'job-a', '08:00']], { breaks })]))['job-a'];
  assert.deepEqual([rest.approved.workHours, rest.approved.cost], [3.5, 70]);
  const legacy = byJob(cost([tracked('legacy', '2026-09-21', '08:00', '12:00', [['work', 'job-a', '08:00']], { breaks: breaks.map(({ kind, ...item }) => item) })]))['job-a'];
  assert.deepEqual([legacy.approved.workHours, legacy.approved.cost], [3.333, 66.67]);
  const unratedResult = cost([tracked('unrated', '2026-09-21', '08:00', '12:00', [['work', 'job-a', '08:00']], { hourlyRate: undefined })]), unrated = byJob(unratedResult)['job-a'];
  assert.deepEqual([unrated.approved.cost, unrated.missingRateCount, unratedResult.coverage.reasons], [0, 1, ['missing_rate']]);
  assert.equal(byJob(cost([tracked('typed', '2026-09-21', '08:00', '12:00', [['work', 'job-a', '08:00']], { hourlyRate: '25' })]))['job-a'].approved.cost, 100);
});

test('timecards recorded through the real clock-in, job switch, clock-out and approval flow are costed', () => {
  const crew = { user: 'Crew.One', displayName: 'Crew One', role: 'crew', payType: 'hourly' }, boss = { user: 'ZacB', displayName: 'Zac', role: 'owner' };
  let card = authorizeTimecard({ session: crew, manager: false, id: 'real', incoming: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } }, hourlyRate: 25, now: '2026-09-21T14:00:00.000Z' });
  card = applyEmployeeJobAction(card, { requestId: randomUUID(), kind: 'work', jobId: 'job-a', expectedSegmentId: card.jobTracking.segments[0].id }, crew, '2026-09-21T14:30:00.000Z');
  card = authorizeTimecard({ session: crew, manager: false, id: 'real', existing: card, incoming: { clockOutAt: 'browser', status: 'submitted' }, now: '2026-09-21T18:30:00.000Z' });
  assert.deepEqual(byJob(cost([card]))['job-a'].pending, { workHours: 4, travelHours: 0, laborHours: 4, straightCost: 100, overtimePremium: 0, cost: 100 });
  card = authorizeTimecard({ session: boss, manager: true, id: 'real', existing: card, incoming: { approvalStatus: 'approved' }, now: '2026-09-22T14:00:00.000Z' });
  const approved = cost([card]);
  assert.deepEqual([byJob(approved)['job-a'].approved.cost, approved.coverage.complete], [100, true]);
});

test('a quarter of job costing over two years of five-person history reads each timecard a bounded number of times', () => {
  const cards = [], base = Date.parse('2024-10-01T14:00:00Z'), iso = time => new Date(time).toISOString();
  for (let index = 0; index < 730; index++) for (let person = 0; person < 5; person++) {
    if ((index + person) % 7 >= 5) continue;
    const start = base + index * 86400000, end = start + 9 * 3600000, jobId = `job-${index % 40}`;
    cards.push({ id: `c${index}-${person}`, employee: `crew.${person}`, hourlyRate: 20 + person, clockInAt: iso(start), clockOutAt: iso(end), approvalStatus: 'approved', status: 'submitted', breaks: [],
      jobTracking: { version: 1, partialHistory: false, segments: [{ id: `s${index}-${person}-0`, kind: 'travel', jobId, startedAt: iso(start), endedAt: iso(start + 3600000) }, { id: `s${index}-${person}-1`, kind: 'work', jobId, startedAt: iso(start + 3600000), endedAt: iso(end) }] } });
  }
  // Count clock-in reads instead of timing: re-parsing the whole history for each of the 14 touched weeks would read
  // every card dozens of times, while one pass per computation reads it a small constant number of times.
  let reads = 0;
  const counted = cards.map(card => new Proxy(card, { get: (target, key) => { if (key === 'clockInAt') reads++; return target[key]; } }));
  const result = computeJobLaborCost({ timecards: counted, start: '2026-06-01', end: '2026-09-01', now: NOW });
  assert.ok(reads <= counted.length * 8, `read clock-in ${reads} times for ${counted.length} timecards`);
  assert.deepEqual([result.jobs.length, result.totals.approved.workHours, result.totals.approved.straightCost, result.coverage.complete], [40, 2632, 57920, true]);
});

test('walkthrough visit segments are acquisition labor: left out of job rows and totals and reported apart', () => {
  const parts = [['work', 'walk-1', '08:00'], ['work', 'job-a', '10:00']];
  const card = tracked('shift', '2026-09-21', '08:00', '16:00', parts, { hourlyRate: 25 });
  card.jobTracking.segments[0].visitKind = 'walkthrough';
  const result = cost([card]);
  assert.deepEqual(result.jobs.map(row => row.jobId), ['job-a']);
  assert.deepEqual(result.totals.approved, { workHours: 6, travelHours: 0, laborHours: 6, straightCost: 150, overtimePremium: 0, cost: 150 });
  assert.equal(result.walkthroughLabor.costedAs, 'acquisition');
  assert.deepEqual(result.walkthroughLabor.visits.map(row => [row.jobId, row.approved.cost, row.approvedTimecards]), [['walk-1', 50, 1]]);
  assert.deepEqual(result.walkthroughLabor.totals.approved, { workHours: 2, travelHours: 0, laborHours: 2, straightCost: 50, overtimePremium: 0, cost: 50 });
  assert.equal(result.coverage.complete, true);
  // Asking for the walkthrough itself returns it only as acquisition labor.
  const one = cost([card], { jobId: 'walk-1' });
  assert.deepEqual([one.jobs.length, one.walkthroughLabor.visits.map(row => row.jobId), one.totals.approved.cost], [0, ['walk-1'], 0]);
  // Unmarked segments (every P1-03 job segment) are costed exactly as before.
  const unmarked = cost([tracked('shift', '2026-09-21', '08:00', '16:00', parts, { hourlyRate: 25 })]);
  assert.deepEqual([unmarked.jobs.length, unmarked.walkthroughLabor.visits.length, unmarked.totals.approved.cost, unmarked.walkthroughLabor.totals.approved.cost], [2, 0, 200, 0]);
});

const manager = { user: 'ZacB', role: 'owner', businessAccess: true };
const handler = (options = {}) => jobCostingHandlers({ session: async () => manager, read: async () => [tracked('shift', '2026-09-21', '08:00', '12:00', [['work', 'job-a', '08:00']])], now: () => new Date(NOW), ...options }).get;
const request = query => new Request(`https://easygaragecleaning.com/api/job-costing${query}`);

test('job costing API is manager-only, validates before reading, and fails closed', async () => {
  let reads = 0;
  const read = async () => { reads++; return []; };
  const expect = async (response, status, code) => { assert.equal(response.status, status); const body = await response.json(); assert.deepEqual([body.ok, body.code], [false, code]); assert.equal(response.headers.get('Cache-Control'), 'no-store'); };
  await expect(await handler({ session: async () => null, read })({ request: request('?start=2026-09-21&end=2026-09-27'), env: {} }), 401, 'job_costing_sign_in_required');
  await expect(await handler({ session: async () => ({ user: 'Crew.One', role: 'crew' }), read })({ request: request('?start=2026-09-21&end=2026-09-27'), env: {} }), 403, 'job_costing_forbidden');
  for (const query of ['?start=2026-09-21&end=2026-09-28&foo=1', '?start=2026-09-21&start=2026-09-22&end=2026-09-28', '?start=2026-09-21&end=2026-09-28&includeTravel=true']) await expect(await handler({ read })({ request: request(query), env: {} }), 400, 'job_costing_query_invalid');
  await expect(await handler({ read })({ request: request('?start=2026-09-21'), env: {} }), 400, 'job_costing_range_invalid');
  await expect(await handler({ read })({ request: request('?start=2026-09-21&end=2026-09-21'), env: {} }), 400, 'job_costing_range_invalid');
  await expect(await handler({ read })({ request: request('?start=2026-09-21&end=2026-09-28&jobId=secure_x'), env: {} }), 400, 'job_costing_job_invalid');
  await expect(await handler({ read })({ request: request('?start=2026-09-21&end=2026-09-28'), env: { EGC_OVERTIME_POLICY: 'weekly' } }), 503, 'timesheet_policy_invalid');
  assert.equal(reads, 0);
  const leak = await handler({ read: async () => { throw new Error('private firestore detail'); } })({ request: request('?start=2026-09-21&end=2026-09-28'), env: {} });
  assert.equal(leak.status, 503); assert.equal(JSON.stringify(await leak.json()).includes('private'), false);
  await expect(await handler({ read: async () => ({}) })({ request: request('?start=2026-09-21&end=2026-09-28'), env: {} }), 503, 'job_costing_records_invalid');
  await expect(await jobCostingHandlers({ session: async () => manager, now: () => new Date(NOW) }).get({ request: request('?start=2026-09-21&end=2026-09-28'), env: {} }), 503, 'job_costing_storage_unconfigured');
});

test('job costing API returns labor cost per job for the range', async () => {
  const response = await handler()({ request: request('?start=2026-09-21&end=2026-09-28&jobId=job-a&includeTravel=1'), env: { EGC_OVERTIME_POLICY: 'federal' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const body = await response.json();
  assert.deepEqual([body.ok, body.policy.name, body.start, body.end, body.endExclusive, body.jobId, body.includeTravel, body.asOf, body.jobs[0].approved.cost, body.coverage.complete], [true, 'federal', '2026-09-21', '2026-09-28', true, 'job-a', true, NOW, 80, true]);
  const monday = await (await handler()({ request: request('?start=2026-09-14&end=2026-09-21'), env: {} })).json();
  assert.deepEqual([monday.ok, monday.jobs.length], [true, 0], 'the end date is exclusive');
});
