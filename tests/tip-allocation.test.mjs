process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIP_ALLOCATION_JOB_FIELDS, computeTipAllocation, splitCents } from '../functions/_lib/tip-allocation.js';
import { MONEY_JOB_FIELDS, moneyStorage } from '../functions/_lib/money-storage.js';
import { customerTipsCsv, customerTipsCsvFilename } from '../functions/_lib/payroll-export.js';
import { tipAllocationHandlers } from '../functions/api/tip-allocation.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { paymentReviewsForJobs } from '../functions/_lib/customer-payments.js';

const NOW = '2026-10-05T18:00:00.000Z';
const at = (date, time) => `${date}T${time}:00-06:00`;
// parts: [kind, jobId, start HH:MM]; each segment runs until the next part or clock-out.
function tracked(id, employee, date, from, to, parts, extra = {}) {
  const segments = parts.map(([kind, jobId, start], index) => ({ id: `${id}-segment-${index}`, kind, jobId, jobLabel: '', startedAt: at(date, start), endedAt: at(date, parts[index + 1]?.[2] ?? to), actorId: employee, endReason: 'job_switch' }));
  return { id, employee, employeeName: `Synthetic ${employee}`, payType: 'hourly', hourlyRate: 20, clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [],
    jobTracking: { version: 1, coverageStartedAt: at(date, from), partialHistory: false, segments }, ...extra };
}
const tip = (session, cents, verifiedAt) => ({ sessionId: `cs_test_${session}`, paymentIntentId: `pi_${session}`, amountCents: cents, amount: cents / 100, source: 'customer_portal', recordedBy: 'stripe', verifiedAt });
const job = (id, tips, extra = {}) => ({ id, type: 'job', customer: `Synthetic ${id}`, date: '2026-09-23', total: 1000, status: 'completed',
  payment: { amount: 1000, verified: true, stripeSessions: [{ sessionId: `cs_test_${id}_pay`, paymentIntentId: `pi_${id}_pay`, amount: 1000, verifiedAt: '2026-09-23T22:00:00.000Z' }], tips }, ...extra });
const allocate = (jobs, timecards, range = {}) => computeTipAllocation({ jobs, timecards, start: '2026-09-21', end: '2026-09-28', now: NOW, ...range });
const byJob = result => Object.fromEntries(result.jobs.map(row => [row.jobId, row]));

test('a job tip is split by each crew member’s job work minutes, travel and other jobs excluded', () => {
  const jobs = [job('job-a', [tip('a1', 12000, '2026-09-23T22:00:00.000Z')])];
  const cards = [
    tracked('lead', 'crew.lead', '2026-09-23', '07:00', '13:00', [['travel', 'job-a', '07:00'], ['work', 'job-a', '08:00'], ['work', 'job-other', '12:00']]),
    tracked('helper', 'crew.helper', '2026-09-23', '08:00', '12:00', [['work', 'job-a', '08:00'], ['general', '', '10:00']]),
  ];
  const result = allocate(jobs, cards), row = byJob(result)['job-a'];
  assert.deepEqual(row.employees, [{ employee: 'crew.lead', name: 'Synthetic crew.lead', minutes: 240, tipCents: 8000 }, { employee: 'crew.helper', name: 'Synthetic crew.helper', minutes: 120, tipCents: 4000 }]);
  assert.deepEqual([row.tipCents, row.workMinutes, row.allocatedCents, row.unallocatedCents, row.reasons], [12000, 360, 12000, 0, []]);
  assert.deepEqual(row.tips, [{ id: 'tip:cs_test_a1', amountCents: 12000, receivedAt: '2026-09-23T22:00:00.000Z', receivedDate: '2026-09-23', processorRef: 'pi_a1' }]);
  assert.deepEqual(result.employees.map(person => [person.employee, person.tipCents, person.minutes, person.jobs]), [['crew.helper', 4000, 120, 1], ['crew.lead', 8000, 240, 1]]);
  assert.deepEqual([result.totals, result.coverage], [{ jobs: 1, tipCents: 12000, allocatedCents: 12000, unallocatedCents: 0 }, { complete: true, asOf: NOW, reasons: [] }]);
  assert.deepEqual([result.split, result.source, result.endExclusive], ['job_work_minutes', 'explicit_employee_job_segments', true]);
});

test('cents split exactly: leftover cents go to the largest remainders, then the longer time, then the username', () => {
  assert.deepEqual(splitCents(1000, [{ key: 'c', weight: 60 }, { key: 'a', weight: 60 }, { key: 'b', weight: 60 }]).map(row => row.cents), [333, 334, 333]);
  assert.deepEqual(splitCents(101, [{ key: 'z', weight: 90 }, { key: 'y', weight: 10 }]).map(row => row.cents), [91, 10]);
  assert.deepEqual(splitCents(0, [{ key: 'a', weight: 1 }]).map(row => row.cents), [0]);
  for (const cents of [1, 7, 9999, 123457]) {
    const shares = splitCents(cents, [{ key: 'a', weight: 17 }, { key: 'b', weight: 29 }, { key: 'c', weight: 3 }]);
    assert.equal(shares.reduce((sum, row) => sum + row.cents, 0), cents, `${cents} is never gained or lost`);
  }
});

test('tips are picked by their Denver receipt date, and a job’s tips cover all of its work time', () => {
  // 2026-09-28T05:30Z is still 11:30 PM on Sept 27 in Denver (and Sept 28 in Tokyo, where this test runs).
  const jobs = [job('job-a', [tip('late', 5000, '2026-09-28T05:30:00.000Z'), tip('next', 7000, '2026-09-28T06:30:00.000Z'), tip('before', 900, '2026-09-20T12:00:00.000Z')])];
  const cards = [tracked('early', 'crew.one', '2026-09-18', '08:00', '09:00', [['work', 'job-a', '08:00']])];
  const row = byJob(allocate(jobs, cards))['job-a'];
  assert.deepEqual([row.tipCents, row.tips.map(item => item.receivedDate)], [5000, ['2026-09-27']]);
  assert.deepEqual(row.employees, [{ employee: 'crew.one', name: 'Synthetic crew.one', minutes: 60, tipCents: 5000 }], 'work from an earlier week still earns the job’s tip');
  assert.equal(byJob(allocate(jobs, cards, { start: '2026-09-28', end: '2026-10-05' }))['job-a'].tipCents, 7000);
  assert.deepEqual(allocate([job('job-b', [])], cards).jobs, [], 'a job without tips is not listed');
});

test('unfinished or unreadable time is reported, never guessed', () => {
  const jobs = [job('job-a', [tip('a', 3000, '2026-09-23T22:00:00.000Z')]), job('job-b', [tip('b', 2000, '2026-09-24T22:00:00.000Z')]), job('job-c', [tip('c', 1000, '2026-09-24T22:00:00.000Z')])];
  const cards = [
    tracked('approved', 'crew.one', '2026-09-23', '08:00', '10:00', [['work', 'job-a', '08:00']]),
    tracked('pending', 'crew.two', '2026-09-23', '08:00', '09:00', [['work', 'job-a', '08:00']], { approvalStatus: 'pending' }),
    tracked('open', 'crew.three', '2026-09-24', '08:00', '09:00', [['work', 'job-b', '08:00']], { clockOutAt: '', status: 'active' }),
    tracked('rejected', 'crew.four', '2026-09-24', '08:00', '12:00', [['work', 'job-b', '08:00']], { approvalStatus: 'rejected' }),
    tracked('broken', 'crew.five', '2026-09-24', '08:00', '09:00', [['work', 'job-c', '08:00']], { breaks: 'not a list' }),
  ];
  const result = allocate(jobs, cards), rows = byJob(result);
  assert.deepEqual(rows['job-a'].employees.map(share => [share.employee, share.minutes, share.tipCents]), [['crew.one', 120, 2000], ['crew.two', 60, 1000]]);
  assert.deepEqual(rows['job-a'].reasons, ['pending_timecards']);
  assert.deepEqual([rows['job-b'].reasons, rows['job-b'].employees, rows['job-b'].unallocatedCents], [['no_job_time', 'open_shifts'], [], 2000], 'a rejected shift earns nothing and an open one waits');
  assert.deepEqual([rows['job-c'].reasons, rows['job-c'].unallocatedCents], [['no_job_time', 'needs_review'], 1000]);
  assert.deepEqual(result.coverage.reasons, ['no_job_time', 'needs_review', 'open_shifts', 'pending_timecards']);
  assert.deepEqual(result.totals, { jobs: 3, tipCents: 6000, allocatedCents: 3000, unallocatedCents: 3000 });
  const unknown = byJob(allocate([job('job-d', [{ ...tip('d', 5000, '2026-09-23T22:00:00.000Z'), amount: 49 }])], cards))['job-d'];
  assert.deepEqual([unknown.tipCents, unknown.reasons], [0, ['tips_unknown']], 'a tip whose cents and dollars disagree is flagged, not paid');
  // Tips on a payment record that is no longer verified are unknown, never silently dropped as zero.
  const unverified = job('job-e', [tip('e', 5000, '2026-09-23T22:00:00.000Z')]); unverified.payment.verified = false;
  const flagged = allocate([unverified], cards);
  assert.deepEqual([byJob(flagged)['job-e']?.reasons, flagged.coverage.complete], [['tips_unknown'], false]);
});

test('crew time on a tipped job that was never tracked to it holds the tip instead of splitting it among the tracked crew', () => {
  const jobs = [job('job-1', [tip('t1', 9000, '2026-09-23T22:00:00.000Z')])];
  const alice = tracked('alice', 'crew.alice', '2026-09-23', '07:00', '12:00', [['general', '', '07:00'], ['work', 'job-1', '08:00']], { jobId: 'job-1' });
  // Bob's card names the job but has no job tracking (a legacy or manager-entered timecard).
  const { jobTracking: _none, ...bob } = tracked('bob', 'crew.bob', '2026-09-23', '08:00', '12:00', [['general', '', '08:00']], { jobId: 'job-1' });
  // Cara clocked in on the job but never tapped Start job time: only the clock-in general segment.
  const cara = tracked('cara', 'crew.cara', '2026-09-23', '08:00', '12:00', [['general', '', '08:00']], { jobId: 'job-1' });
  const alone = allocate(jobs, [alice]);
  assert.deepEqual([byJob(alone)['job-1'].employees, alone.coverage], [[{ employee: 'crew.alice', name: 'Synthetic crew.alice', minutes: 240, tipCents: 9000 }], { complete: true, asOf: NOW, reasons: [] }], 'general time beside tracked work is not untracked');
  const result = allocate(jobs, [alice, bob, cara]), row = byJob(result)['job-1'];
  assert.deepEqual(row.reasons, ['untracked_job_time']);
  assert.deepEqual(row.employees, [{ employee: 'crew.alice', name: 'Synthetic crew.alice', minutes: 240, tipCents: 0 }], 'the tracked minutes are listed, but nobody is paid a share of a split that leaves crew out');
  assert.deepEqual([row.tipCents, row.workMinutes, row.allocatedCents, row.unallocatedCents], [9000, 240, 0, 9000]);
  assert.deepEqual([result.employees, result.totals, result.coverage], [[], { jobs: 1, tipCents: 9000, allocatedCents: 0, unallocatedCents: 9000 }, { complete: false, asOf: NOW, reasons: ['untracked_job_time'] }]);
  for (const [name, card] of [['no job tracking', bob], ['a general-only shift', cara]]) assert.deepEqual(byJob(allocate(jobs, [alice, card]))['job-1'].reasons, ['untracked_job_time'], name);
  // Tracking that began mid-shift (partial history) leaves earlier time unplaced; so does a gap between segments.
  const midShift = tracked('dan', 'crew.dan', '2026-09-23', '07:00', '12:00', [['work', 'job-1', '09:00']]); midShift.jobTracking.partialHistory = true; midShift.jobTracking.coverageStartedAt = at('2026-09-23', '09:00');
  const gap = tracked('eve', 'crew.eve', '2026-09-23', '08:00', '12:00', [['work', 'job-1', '08:00'], ['work', 'job-other', '10:00']]); gap.jobTracking.segments[0].endedAt = at('2026-09-23', '09:00');
  const travelOnly = tracked('finn', 'crew.finn', '2026-09-23', '08:00', '09:00', [['travel', 'job-1', '08:00']]);
  for (const [name, card] of [['tracking began mid-shift', midShift], ['a gap between segments', gap], ['only travel to the job', travelOnly]]) {
    const held = byJob(allocate(jobs, [alice, card]))['job-1'];
    assert.deepEqual([held.reasons, held.allocatedCents, held.unallocatedCents], [['untracked_job_time'], 0, 9000], name);
  }
  // A rejected card earns nothing and holds nothing; another job's untracked shift does not hold this job.
  assert.deepEqual(allocate(jobs, [alice, { ...bob, approvalStatus: 'rejected' }, { ...cara, jobId: 'job-other' }]).coverage.reasons, []);
  // With nobody's time tracked the job is both unworked and untracked, and still unallocated.
  assert.deepEqual(byJob(allocate(jobs, [bob]))['job-1'].reasons, ['no_job_time', 'untracked_job_time']);
});

test('allocation needs complete lists, a valid range and an injected clock', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2031-01-01T00:00:00.000Z') });
  assert.throws(() => computeTipAllocation({ jobs: [], timecards: [], start: '2026-09-21', end: '2026-09-28' }), error => error.code === 'tip_allocation_now_required');
  assert.throws(() => allocate([], [], { end: '2026-09-21' }), error => error.code === 'tip_allocation_range_invalid');
  assert.throws(() => allocate([], [], { end: '2027-09-21' }), error => error.code === 'tip_allocation_range_invalid');
  assert.throws(() => allocate(null, []), error => error.code === 'tip_allocation_records_invalid' && error.status === 503);
  assert.equal(allocate([], []).asOf, NOW, 'the mocked 2031 wall clock is never read');
});

test('the payroll tip CSV lists one row per share and names tips that must be paid by hand', () => {
  const jobs = [job('job-a', [tip('a', 10001, '2026-09-23T22:00:00.000Z')], { customer: '=HYPERLINK("x")' }), job('job-b', [tip('b', 2500, '2026-09-24T22:00:00.000Z')])];
  const cards = [tracked('one', 'crew.one', '2026-09-23', '08:00', '09:00', [['work', 'job-a', '08:00']]), tracked('two', 'crew.two', '2026-09-23', '09:00', '10:00', [['work', 'job-a', '09:00']])];
  const allocation = allocate(jobs, cards), csv = customerTipsCsv(allocation), rows = csv.trimEnd().split('\r\n');
  assert.equal(customerTipsCsvFilename(allocation), 'egc-customer-tips-2026-09-21-to-2026-09-27.csv');
  assert.equal(rows[0], '"Employee name","Employee username","Tips received from","Tips received through","Job ID","Customer","Service date","Job work minutes","Employee work minutes","Job card tips","Employee tip share","Review flags"');
  assert.deepEqual(rows.slice(1), [
    `"Synthetic crew.one","crew.one","2026-09-21","2026-09-27","job-a","'=HYPERLINK(""x"")","2026-09-23","120","60","100.01","50.01",""`,
    `"Synthetic crew.two","crew.two","2026-09-21","2026-09-27","job-a","'=HYPERLINK(""x"")","2026-09-23","120","60","100.01","50.00",""`,
    '"Unassigned - pay by hand","","2026-09-21","2026-09-27","job-b","Synthetic job-b","2026-09-23","0","0","25.00","25.00","no_job_time"',
  ]);
  assert.ok(csv.endsWith('\r\n'));
});

// reviews: each job's payment_reviews rows (by job id), as GET /api/tip-allocation reads them for the tipped jobs.
function api(t, { jobs = [], timecards = [], actor = { user: 'zacb', role: 'owner', businessAccess: true }, env = {}, reviews = {}, readReviews = null } = {}) {
  const calls = { jobs: 0, timecards: 0, jobFields: [], reviews: [] };
  const handlers = tipAllocationHandlers({ session: async () => actor, storage: () => ({ jobs: async fields => { calls.jobs++; calls.jobFields.push(fields); return structuredClone(jobs); } }), readTimecards: async () => { calls.timecards++; return structuredClone(timecards); },
    readReviews: readReviews || (async (_env, ids) => { calls.reviews.push(ids); return new Map(ids.map(id => [id, structuredClone(reviews[id] || [])])); }), now: () => new Date(NOW) });
  const get = (query, headers = {}) => handlers.get({ env, request: new Request(`https://easygaragecleaning.com/api/tip-allocation?${query}`, { headers }) });
  return { get, calls };
}

test('GET /api/tip-allocation is a manager-only, same-site payroll read', async t => {
  for (const [actor, status, code] of [[null, 401, 'tip_allocation_sign_in_required'], [{ user: 'crew1', role: 'crew', businessAccess: false }, 403, 'tip_allocation_forbidden']]) {
    const response = await api(t, { actor }).get('start=2026-09-21&end=2026-09-28');
    assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  const f = api(t, { jobs: [job('job-a', [tip('a', 3000, '2026-09-23T22:00:00.000Z')])], timecards: [tracked('one', 'crew.one', '2026-09-23', '08:00', '09:00', [['work', 'job-a', '08:00']])] });
  assert.equal((await f.get('start=2026-09-21&end=2026-09-28', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.get('start=2026-09-21&end=2026-09-28', { Origin: 'https://evil.example.invalid' })).status, 403);
  for (const query of ['start=2026-09-21&end=2026-09-28&start=2026-09-20', 'start=2026-09-21&end=2026-09-28&jobId=job-a', 'start=2026-09-21&end=2026-09-28&format=xml', 'start=2026-09-21&end=2026-09-28&acknowledge=no_job_time', 'start=2026-09-21&end=2026-09-28&format=csv&acknowledge=needs_review']) {
    const response = await f.get(query); assert.equal(response.status, 400, query); assert.equal((await response.json()).code, 'tip_allocation_query_invalid', query);
  }
  assert.equal((await (await f.get('start=2026-09-28&end=2026-09-21')).json()).code, 'tip_allocation_range_invalid');
  const response = await f.get('start=2026-09-21&end=2026-09-28', { 'Sec-Fetch-Site': 'same-origin' }), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual([body.ok, body.authority, body.asOf, body.totals.allocatedCents, body.employees[0].employee], [true, 'employee_hub', NOW, 3000, 'crew.one']);
  const csv = await f.get('start=2026-09-21&end=2026-09-28&format=csv');
  assert.equal(csv.status, 200); assert.match(csv.headers.get('Content-Type'), /^text\/csv/); assert.match(csv.headers.get('Content-Disposition'), /egc-customer-tips-2026-09-21-to-2026-09-27\.csv/);
  assert.match(await csv.text(), /"Synthetic crew\.one","crew\.one",.*"30\.00",""/);
});

test('the tip CSV waits for final time, and only unassigned tips can be acknowledged', async t => {
  const jobs = [job('job-a', [tip('a', 3000, '2026-09-23T22:00:00.000Z')]), job('job-b', [tip('b', 2000, '2026-09-24T22:00:00.000Z')])];
  const pending = api(t, { jobs, timecards: [tracked('one', 'crew.one', '2026-09-23', '08:00', '09:00', [['work', 'job-a', '08:00']], { approvalStatus: 'pending' })] });
  const blocked = await pending.get('start=2026-09-21&end=2026-09-28&format=csv'), body = await blocked.json();
  assert.equal(blocked.status, 409); assert.equal(body.code, 'tip_allocation_incomplete');
  assert.deepEqual([body.details.blocking, body.details.acknowledgeable, body.details.jobs], [['no_job_time', 'pending_timecards'], ['no_job_time'], [{ jobId: 'job-a', reasons: ['pending_timecards'] }, { jobId: 'job-b', reasons: ['no_job_time'] }]]);
  assert.equal((await pending.get('start=2026-09-21&end=2026-09-28&format=csv&acknowledge=no_job_time')).status, 409, 'pending time cannot be acknowledged away');
  const approved = api(t, { jobs, timecards: [tracked('one', 'crew.one', '2026-09-23', '08:00', '09:00', [['work', 'job-a', '08:00']])] });
  const needs = await approved.get('start=2026-09-21&end=2026-09-28&format=csv');
  assert.equal(needs.status, 409); assert.match((await needs.json()).error, /acknowledge=no_job_time/);
  const exported = await approved.get('start=2026-09-21&end=2026-09-28&format=csv&acknowledge=no_job_time'), text = await exported.text();
  assert.equal(exported.status, 200); assert.match(text, /"Unassigned - pay by hand","",.*"job-b",.*"20\.00","no_job_time"/);
});

test('untracked crew time blocks the tip CSV until a manager acknowledges it, and then no share is paid automatically', async t => {
  const jobs = [job('job-1', [tip('t1', 9000, '2026-09-23T22:00:00.000Z')])];
  const alice = tracked('alice', 'crew.alice', '2026-09-23', '07:00', '12:00', [['general', '', '07:00'], ['work', 'job-1', '08:00']], { jobId: 'job-1' });
  const cara = tracked('cara', 'crew.cara', '2026-09-23', '08:00', '12:00', [['general', '', '08:00']], { jobId: 'job-1' });
  const f = api(t, { jobs, timecards: [alice, cara] });
  const blocked = await f.get('start=2026-09-21&end=2026-09-28&format=csv'), body = await blocked.json();
  assert.deepEqual([blocked.status, body.code, body.details.blocking, body.details.acknowledgeable, body.details.jobs], [409, 'tip_allocation_incomplete', ['untracked_job_time'], ['untracked_job_time'], [{ jobId: 'job-1', reasons: ['untracked_job_time'] }]]);
  assert.match(body.error, /not tracked to the job.*acknowledge=untracked_job_time/);
  const exported = await f.get('start=2026-09-21&end=2026-09-28&format=csv&acknowledge=untracked_job_time'), rows = (await exported.text()).trimEnd().split('\r\n');
  assert.equal(exported.status, 200);
  assert.deepEqual(rows.slice(1), [
    '"Synthetic crew.alice","crew.alice","2026-09-21","2026-09-27","job-1","Synthetic job-1","2026-09-23","240","240","90.00","0.00","untracked_job_time"',
    '"Unassigned - pay by hand","","2026-09-21","2026-09-27","job-1","Synthetic job-1","2026-09-23","240","0","90.00","90.00","untracked_job_time"',
  ]);
});

test('storage failures are a retryable 503, never an empty tip list', async t => {
  const handlers = tipAllocationHandlers({ session: async () => ({ user: 'zacb', role: 'owner', businessAccess: true }), storage: () => ({ jobs: async () => { throw Object.assign(new Error('Firestore down: secret detail'), { code: 'money_storage_unavailable', status: 503 }); } }), readTimecards: async () => [], now: () => new Date(NOW) });
  const response = await handlers.get({ env: {}, request: new Request('https://easygaragecleaning.com/api/tip-allocation?start=2026-09-21&end=2026-09-28') }), body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.code, 'tip_allocation_unavailable'); assert.doesNotMatch(body.error, /secret detail/);
  const partial = tipAllocationHandlers({ session: async () => ({ user: 'zacb', role: 'owner', businessAccess: true }), storage: () => ({ jobs: async () => [] }), readTimecards: async () => ({ partial: true }), now: () => new Date(NOW) });
  assert.equal((await (await partial.get({ env: {}, request: new Request('https://easygaragecleaning.com/api/tip-allocation?start=2026-09-21&end=2026-09-28') })).json()).code, 'tip_allocation_records_invalid');
});

// Two jobs a day: clock-in names the day's first job as the shift job, so a crew member assigned to a later tipped job
// may never name it at all. The job's own crew list is checked, not only the cards that name the job.
test('an assigned crew member with no job time on the tipped job holds its tips, whatever job their card names', () => {
  const crewJob = (crew = {}) => job('job-1', [tip('t1', 9000, '2026-09-23T22:00:00.000Z')], { assignedCrew: ['alice', 'dan'], ...crew });
  const alice = tracked('alice', 'alice', '2026-09-23', '12:00', '16:00', [['general', '', '12:00'], ['work', 'job-1', '12:05']], { jobId: 'job-1' });
  const danMorning = tracked('dan', 'dan', '2026-09-23', '08:00', '16:00', [['general', '', '08:00']], { jobId: 'job-0' });
  const danNoJob = tracked('dan', 'dan', '2026-09-23', '08:00', '16:00', [['general', '', '08:00']], { jobId: '' });
  for (const [name, dan] of [['a card naming his morning job', danMorning], ['a card naming no job', danNoJob]]) {
    const result = allocate([crewJob()], [alice, dan]), row = byJob(result)['job-1'];
    assert.deepEqual([row.reasons, row.crewWithoutJobTime, row.allocatedCents, row.unallocatedCents], [['untracked_job_time'], ['dan'], 0, 9000], name);
    assert.deepEqual(row.employees, [{ employee: 'alice', name: 'Synthetic alice', minutes: 235, tipCents: 0 }], `${name}: Alice's minutes are listed but she is not paid Dan's share`);
    assert.deepEqual([result.employees, result.coverage.complete, result.coverage.reasons], [[], false, ['untracked_job_time']], name);
  }
  // Dan tapped Start job time on job-1 after his morning job: both are on the job, and the tip is split.
  const danBoth = tracked('dan', 'dan', '2026-09-23', '08:00', '16:00', [['work', 'job-0', '08:00'], ['work', 'job-1', '12:00']], { jobId: 'job-0' });
  const split = byJob(allocate([crewJob()], [alice, danBoth]))['job-1'];
  assert.deepEqual([split.reasons, split.crewWithoutJobTime, split.employees.map(share => [share.employee, share.minutes, share.tipCents])], [[], [], [['dan', 240, 4547], ['alice', 235, 4453]]]);
  // A legacy assignedTo list, mixed-case usernames and account objects are matched by username.
  for (const crew of [{ assignedCrew: undefined, assignedTo: 'alice + dan' }, { assignedCrew: ['Alice', ' DAN '] }, { assignedCrew: [{ username: 'alice', name: 'Alice A' }, { username: 'dan', name: 'Dan D' }] }]) {
    assert.deepEqual(byJob(allocate([crewJob(crew)], [alice, danMorning]))['job-1'].reasons, ['untracked_job_time'], JSON.stringify(crew));
    assert.deepEqual(byJob(allocate([crewJob(crew)], [alice, danBoth]))['job-1'].reasons, [], JSON.stringify(crew));
  }
  // A segment's crew counts too (P1-DS-08 assignmentSegments on the merged tree).
  const segmented = crewJob({ assignedCrew: ['alice', 'dan'], assignmentSegments: [{ id: 'seg-1', assignedCrew: ['alice'] }, { id: 'seg-2', assignedCrew: ['erin'] }] });
  assert.deepEqual(byJob(allocate([segmented], [alice, danBoth]))['job-1'].crewWithoutJobTime, ['erin']);
  // Only a rejected card, or under 30 seconds of work, is no job time; an open shift on the job is reported as open.
  assert.deepEqual(byJob(allocate([crewJob()], [alice, { ...danBoth, approvalStatus: 'rejected' }]))['job-1'].crewWithoutJobTime, ['dan']);
  const blip = tracked('dan', 'dan', '2026-09-23', '08:00', '16:00', [['work', 'job-0', '08:00'], ['work', 'job-1', '12:00'], ['work', 'job-0', '12:00']], { jobId: 'job-0' });
  blip.jobTracking.segments[1].endedAt = '2026-09-23T12:00:20-06:00'; blip.jobTracking.segments[2].startedAt = '2026-09-23T12:00:20-06:00';
  assert.deepEqual(byJob(allocate([crewJob()], [alice, blip]))['job-1'].crewWithoutJobTime, ['dan']);
  const open = byJob(allocate([crewJob()], [alice, { ...danBoth, clockOutAt: '', status: 'active' }]))['job-1'];
  assert.deepEqual([open.reasons, open.crewWithoutJobTime], [['open_shifts'], []]);
  // A job with no saved crew is checked by its cards alone, as before.
  assert.deepEqual(byJob(allocate([job('job-1', [tip('t1', 9000, '2026-09-23T22:00:00.000Z')])], [alice, danMorning]))['job-1'].reasons, []);
});

test('the real GET /api/tip-allocation reads the assigned crew and refuses to export a split that leaves one out', async t => {
  const jobs = [job('job-1', [tip('t1', 9000, '2026-09-23T22:00:00.000Z')], { assignedCrew: ['alice', 'dan'] })];
  const alice = tracked('alice', 'alice', '2026-09-23', '12:00', '16:00', [['general', '', '12:00'], ['work', 'job-1', '12:05']], { jobId: 'job-1' });
  for (const shiftJob of ['job-0', '']) {
    const dan = tracked('dan', 'dan', '2026-09-23', '08:00', '16:00', [['general', '', '08:00']], { jobId: shiftJob });
    const f = api(t, { jobs, timecards: [alice, dan] });
    const response = await f.get('start=2026-09-21&end=2026-09-28'), body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual([body.jobs[0].reasons, body.jobs[0].crewWithoutJobTime, body.coverage.complete, body.totals.allocatedCents], [['untracked_job_time'], ['dan'], false, 0], shiftJob || 'no shift job');
    assert.deepEqual(f.calls.jobFields, [['assignedCrew', 'assignedTo', 'assignmentSegments']], 'the handler asks storage for the crew fields');
    const csv = await f.get('start=2026-09-21&end=2026-09-28&format=csv'), refused = await csv.json();
    assert.deepEqual([csv.status, refused.code, refused.details.blocking], [409, 'tip_allocation_incomplete', ['untracked_job_time']]);
    const rows = (await (await f.get('start=2026-09-21&end=2026-09-28&format=csv&acknowledge=untracked_job_time')).text()).trimEnd().split('\r\n').slice(1);
    assert.deepEqual(rows.map(row => row.split('","').slice(10).join('","')), ['0.00","untracked_job_time"', '90.00","untracked_job_time"'], 'Alice is paid nothing automatically and the $90 is unassigned');
  }
});

test('moneyStorage reads the money mask, plus any fields a caller names, and nothing else', async () => {
  const masks = [];
  const store = moneyStorage({}, async (_env, url) => { masks.push(new URL(url).searchParams.getAll('mask.fieldPaths')); return Response.json({}); });
  assert.deepEqual(await store.jobs(), []);
  assert.deepEqual(await store.jobs([...TIP_ALLOCATION_JOB_FIELDS, 'status']), []);
  assert.deepEqual(masks, [[...MONEY_JOB_FIELDS], [...MONEY_JOB_FIELDS, 'assignedCrew', 'assignedTo', 'assignmentSegments']]);
});

// A tip is picked by the date it was received. When money-core cannot total a job's tips, the saved rows' dates decide.
test('a tip total that cannot be read is flagged in the week the tip was received, not the service week', () => {
  const early = (tips, payment = {}) => { const row = job('job-s', tips, { date: '2026-09-15' }); Object.assign(row.payment, payment); return row; };
  const card = tracked('one', 'crew.one', '2026-09-15', '08:00', '10:00', [['work', 'job-s', '08:00']]);
  const unverified = allocate([early([tip('late', 5000, '2026-09-23T22:00:00.000Z')], { verified: false })], [card]);
  assert.deepEqual([unverified.jobs.map(row => [row.jobId, row.reasons, row.tipCents]), unverified.coverage.complete], [[['job-s', ['tips_unknown'], 0]], false], 'an unverified payment’s tip is not dropped from the week it arrived');
  const disagree = allocate([early([tip('same', 5000, '2026-09-23T22:00:00.000Z'), tip('same', 7000, '2026-09-23T22:00:00.000Z')])], [card]);
  assert.deepEqual([disagree.jobs[0].reasons, disagree.jobs[0].tipCents, disagree.coverage.complete], [['tips_unknown'], 5000, false], 'copies that disagree are flagged, never exported as the first copy');
  const undated = allocate([early([{ ...tip('undated', 5000, 'not a date') }], { verified: false })], [card]);
  assert.deepEqual(undated.jobs.map(row => row.reasons), [['tips_unknown']], 'a row with no readable date might be this week’s');
  // Rows received in another week leave this week complete.
  const elsewhere = early([tip('before', 5000, '2026-09-16T22:00:00.000Z')], { verified: false });
  assert.deepEqual([allocate([elsewhere], [card]).jobs, allocate([elsewhere], [card]).coverage.complete], [[], true]);
  assert.deepEqual(allocate([elsewhere], [card], { start: '2026-09-14', end: '2026-09-21' }).jobs.map(row => row.reasons), [['tips_unknown']]);
});

test('the tip CSV refuses a week whose tip total cannot be read, even for a job serviced in an earlier week', async t => {
  const row = job('job-s', [tip('same', 5000, '2026-09-23T22:00:00.000Z'), tip('same', 7000, '2026-09-23T22:00:00.000Z')], { date: '2026-09-15' });
  const f = api(t, { jobs: [row], timecards: [tracked('one', 'crew.one', '2026-09-15', '08:00', '10:00', [['work', 'job-s', '08:00']])] });
  const csv = await f.get('start=2026-09-21&end=2026-09-28&format=csv'), body = await csv.json();
  assert.deepEqual([csv.status, body.code, body.details.blocking, body.details.acknowledgeable], [409, 'tip_allocation_incomplete', ['tips_unknown'], []]);
});

test('GET /api/tip-allocation?config=tips says whether tips are on without reading any job or timecard', async t => {
  for (const [env, enabled] of [[{ CUSTOMER_TIPS_ENABLED: 'true' }, true], [{}, false], [{ CUSTOMER_TIPS_ENABLED: 'yes' }, false]]) {
    const f = api(t, { env }), response = await f.get('config=tips');
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: true, authority: 'employee_hub', tips: { enabled } });
    assert.deepEqual([f.calls.jobs, f.calls.timecards], [0, 0], 'a cheap probe: no full-collection read');
  }
  for (const query of ['config=other', 'config=tips&start=2026-09-21&end=2026-09-28', 'config=tips&config=tips']) {
    const response = await api(t).get(query); assert.equal(response.status, 400, query); assert.equal((await response.json()).code, 'tip_allocation_query_invalid', query);
  }
  for (const [actor, status] of [[null, 401], [{ user: 'crew1', role: 'crew', businessAccess: false }, 403]]) assert.equal((await api(t, { actor, env: { CUSTOMER_TIPS_ENABLED: 'true' } }).get('config=tips')).status, status);
  assert.equal((await api(t).get('config=tips', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

// The Hub schedule shows the legacy assignedTo names when assignedCrew is an empty list (employee-suite crewNames), and an
// assignedTo-only change can leave assignedCrew as []: the tip allocation reads the crew the same way.
test('an empty assignedCrew list falls back to the assignedTo names, through the real handler and money mask', async () => {
  const saved = job('job-1', [tip('t1', 9000, '2026-09-23T22:00:00.000Z')], { assignedCrew: [], assignedTo: 'alice + dan', internalNotes: 'never read' });
  const alice = tracked('alice', 'alice', '2026-09-23', '12:00', '16:00', [['general', '', '12:00'], ['work', 'job-1', '12:05']], { jobId: 'job-1' });
  const danMorning = tracked('dan', 'dan', '2026-09-23', '08:00', '16:00', [['general', '', '08:00']], { jobId: 'job-0' });
  const danBoth = tracked('dan', 'dan', '2026-09-23', '08:00', '16:00', [['work', 'job-0', '08:00'], ['work', 'job-1', '12:00']], { jobId: 'job-0' });
  const row = byJob(allocate([saved], [alice, danMorning]))['job-1'];
  assert.deepEqual([row.reasons, row.crewWithoutJobTime, row.allocatedCents, row.unallocatedCents], [['untracked_job_time'], ['dan'], 0, 9000]);
  assert.deepEqual(byJob(allocate([saved], [alice, danBoth]))['job-1'].reasons, [], 'with both crew on the job the tip is split');
  // A non-empty assignedCrew still wins over assignedTo, as before.
  assert.deepEqual(byJob(allocate([{ ...saved, assignedCrew: ['alice'] }], [alice, danMorning]))['job-1'].crewWithoutJobTime, []);
  // The real GET handler over the real moneyStorage: Firestore returns only the masked fields.
  const masks = [];
  const fetcher = async (_env, url) => {
    // The tipped job's payment reviews (none): one filtered query, read through the real helper.
    if (new URL(url).pathname.endsWith(':runQuery')) return Response.json([{ readTime: '2026-09-23T22:00:00.000000Z' }]);
    const fields = new URL(url).searchParams.getAll('mask.fieldPaths'); masks.push(fields);
    const masked = Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'id' && fields.includes(key)));
    return Response.json({ documents: [{ name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-1', fields: encodeFirestoreFields(masked), updateTime: '2026-09-23T22:00:00.000000Z' }] });
  };
  for (const [dan, reasons, missing, allocated] of [[danMorning, ['untracked_job_time'], ['dan'], 0], [danBoth, [], [], 9000]]) {
    const handlers = tipAllocationHandlers({ session: async () => ({ user: 'zacb', role: 'owner', businessAccess: true }), storage: env => moneyStorage(env, fetcher), readTimecards: async () => structuredClone([alice, dan]), readReviews: (env, ids) => paymentReviewsForJobs(env, ids, fetcher), now: () => new Date(NOW) });
    const response = await handlers.get({ env: {}, request: new Request('https://easygaragecleaning.com/api/tip-allocation?start=2026-09-21&end=2026-09-28') }), body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual([body.jobs[0].reasons, body.jobs[0].crewWithoutJobTime, body.totals.allocatedCents, body.coverage.complete], [reasons, missing, allocated, !reasons.length]);
    if (reasons.length) {
      const csv = await handlers.get({ env: {}, request: new Request('https://easygaragecleaning.com/api/tip-allocation?start=2026-09-21&end=2026-09-28&format=csv') });
      assert.deepEqual([csv.status, (await csv.json()).code], [409, 'tip_allocation_incomplete'], 'Alice is never paid Dan\'s share automatically');
    }
  }
  assert.ok(masks.every(fields => fields.includes('assignedTo') && fields.includes('assignedCrew') && !fields.includes('internalNotes')));
});


// A tipped charge already on its job that Stripe later shows refunded gets a payment_refunded review (REVIEWS-UI's
// follow-up, carrying tipCents); the job itself is unchanged, so the tip allocation reads those reviews.
test('a tip on a charge Stripe shows refunded is never split: an open refund blocks the CSV, a recorded one is exported only unassigned', async t => {
  const jobs = [job('job-a', [tip('a', 3000, '2026-09-23T22:00:00.000Z')]), job('job-b', [tip('b', 2000, '2026-09-24T22:00:00.000Z')])];
  const timecards = [tracked('one', 'crew.one', '2026-09-23', '08:00', '10:00', [['work', 'job-a', '08:00'], ['work', 'job-b', '09:00']])];
  const refund = (session, extra = {}) => ({ sessionId: `cs_test_${session}`, jobId: `job-${session}`, reason: 'payment_refunded', status: 'open', tipCents: 3000, ...extra });
  // Pure: an open refund review on the tipped charge holds its whole tip unassigned and flags it.
  const held = byJob(computeTipAllocation({ jobs, timecards, start: '2026-09-21', end: '2026-09-28', now: NOW, refundReviews: new Map([['job-a', [refund('a')]]]) }));
  assert.deepEqual([held['job-a'].reasons, held['job-a'].allocatedCents, held['job-a'].unallocatedCents, held['job-b'].reasons, held['job-b'].allocatedCents], [['tip_refund_open'], 0, 3000, [], 2000]);
  // Reviews that do not name a tip the job lists, have no tip, or were closed as reconciled change nothing.
  for (const review of [refund('a', { sessionId: 'cs_test_other' }), refund('a', { tipCents: undefined }), refund('a', { tipCents: 0 }), refund('a', { status: 'resolved', resolution: 'reconciled' }), refund('a', { reason: 'payment_exceeds_balance' })]) {
    const row = byJob(computeTipAllocation({ jobs, timecards, start: '2026-09-21', end: '2026-09-28', now: NOW, refundReviews: new Map([['job-a', [review]]]) }))['job-a'];
    assert.deepEqual([row.reasons, row.allocatedCents], [[], 3000], JSON.stringify(review));
  }
  // Through the handler: the reviews are read for the tipped jobs only, once per request.
  const open = api(t, { jobs, timecards, reviews: { 'job-a': [refund('a')] } });
  const view = await (await open.get('start=2026-09-21&end=2026-09-28')).json();
  assert.deepEqual([view.coverage.reasons, view.totals.allocatedCents, view.totals.unallocatedCents, open.calls.reviews], [['tip_refund_open'], 2000, 3000, [['job-a', 'job-b']]]);
  const refused = await open.get('start=2026-09-21&end=2026-09-28&format=csv'), body = await refused.json();
  assert.deepEqual([refused.status, body.code, body.details.blocking, body.details.acknowledgeable], [409, 'tip_allocation_incomplete', ['tip_refund_open'], []]);
  assert.match(body.error, /Review queues/);
  assert.equal((await open.get('start=2026-09-21&end=2026-09-28&format=csv&acknowledge=tip_refunded')).status, 409, 'an open refund cannot be acknowledged away');
  // The owner recorded the refund, but the job still lists the tip: exported only as unassigned, after acknowledging it.
  const recorded = api(t, { jobs, timecards, reviews: { 'job-a': [refund('a', { status: 'resolved', resolution: 'refunded' })] } });
  const blocked = await (await recorded.get('start=2026-09-21&end=2026-09-28&format=csv')).json();
  assert.deepEqual([blocked.details.blocking, blocked.details.acknowledgeable], [['tip_refunded'], ['tip_refunded']]);
  assert.match(blocked.error, /recorded as refunded.*acknowledge=tip_refunded/);
  const rows = (await (await recorded.get('start=2026-09-21&end=2026-09-28&format=csv&acknowledge=tip_refunded')).text()).trimEnd().split('\r\n').slice(1);
  assert.deepEqual(rows.map(row => row.split('","').slice(4, 5).concat(row.split('","').slice(10)).join('|')), ['job-a|0.00|tip_refunded"', 'job-a|30.00|tip_refunded"', 'job-b|20.00|"'], 'the refunded tip is paid to no one automatically');
  // An unreadable review list fails closed: no allocation, no CSV.
  const unknown = api(t, { jobs, timecards, readReviews: async () => { throw Object.assign(new Error('Firestore down'), { code: 'payment_review_unavailable', status: 503 }); } });
  const failed = await unknown.get('start=2026-09-21&end=2026-09-28');
  assert.deepEqual([failed.status, (await failed.json()).code], [503, 'tip_allocation_unavailable']);
  // A week without tips reads no reviews at all.
  const quiet = api(t, { jobs: [job('job-c', [])], timecards });
  assert.equal((await quiet.get('start=2026-09-21&end=2026-09-28')).status, 200); assert.deepEqual(quiet.calls.reviews, []);
});

test('the payment reviews behind the tip allocation are read one job per query and fail closed', async () => {
  const seen = [];
  const rows = jobId => jobId === 'job-2' ? [{ document: { name: 'projects/egcw-1ec83/databases/(default)/documents/payment_reviews/cs_test_b', fields: encodeFirestoreFields({ sessionId: 'cs_test_b', jobId: 'job-2', status: 'open', reason: 'payment_refunded', tipCents: 500 }), updateTime: '2026-09-23T22:00:00.000000Z' } }] : [{ readTime: '2026-09-23T22:00:00.000000Z' }];
  const fetcher = async (_env, url, init) => { const query = JSON.parse(init.body).structuredQuery; seen.push(query.where.fieldFilter.value.stringValue); return Response.json(rows(query.where.fieldFilter.value.stringValue)); };
  const found = await paymentReviewsForJobs({}, ['job-1', 'job-2', 'job-1'], fetcher);
  assert.deepEqual([[...found.keys()], found.get('job-1'), found.get('job-2').map(row => [row.sessionId, row.tipCents])], [['job-1', 'job-2'], [], [['cs_test_b', 500]]]);
  assert.deepEqual(seen, ['job-1', 'job-2']);
  for (const broken of [async () => Response.json({}, { status: 503 }), async () => { throw new TypeError('offline'); }, async () => Response.json({ not: 'a list' }), async (_env, url, init) => Response.json(rows('job-2').map(row => ({ document: { ...row.document, fields: encodeFirestoreFields({ jobId: 'job-9' }) } })))]) {
    await assert.rejects(paymentReviewsForJobs({}, ['job-2'], broken), error => error.code === 'payment_review_unavailable' && error.status === 503);
  }
});
