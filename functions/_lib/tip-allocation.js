import { paymentLedger } from './money-core.js';
import { employeeJobTime } from './employee-job-time.js';
import { denverToday, validDate } from './dispatch-time.js';
import { timecardPayState } from './timesheet-week.js';
import { assignmentKey, jobCrewNames } from './job-assignment.js';

/**
 * Customer card tips per job, split among the crew who worked it in proportion
 * to each person's recorded job work minutes (explicit job-time segments, never
 * a legacy shift.jobId guess; paid rest breaks stay on the job, as in job
 * costing). Tips are chosen by the America/Denver date they were received
 * (start inclusive, end exclusive), and each job's tips are split over all of
 * that job's work time, whatever day it was worked. Cents are split with the
 * largest-remainder method, so every job's shares add up to its tips exactly.
 * A job is split only when every timecard that names it (its shift job or any
 * segment) placed its time on explicit segments: a shift that never started
 * job time on the job, or has time no segment covers (a legacy or
 * manager-entered card, or tracking that began mid-shift), may hold work on it
 * that minutes cannot see. Everyone the job names as its crew (assignedCrew or
 * assignedTo, and each assignmentSegments[].assignedCrew) must also have a
 * timecard with job work on it, matched by username: a crew member whose card
 * names another job (clock-in picks the day's first job) or no job, and who
 * never tapped Start job time, has worked it without the minutes showing. Such a
 * job is flagged untracked_job_time, lists who is missing in
 * crewWithoutJobTime, and its tips are held unassigned, never split among only
 * the tracked crew. A tip whose card charge Stripe shows refunded (a payment
 * review on that charge, from refundReviews) is never split either: while the
 * owner has not settled the refund in Review queues the job is flagged
 * tip_refund_open and blocks the tip CSV; once the owner recorded the refund
 * (resolution 'refunded') the job still lists the tip until it is corrected by
 * hand, so it is flagged tip_refunded and its tip is held unassigned, exported
 * only when acknowledged and paid by hand only if it is still owed.
 * Pure: no I/O, and `now` (an ISO instant) is required.
 */
export const TIP_ALLOCATION_MAX_DAYS = 92;
export const TIP_ALLOCATION_REASONS = Object.freeze(['tips_unknown', 'no_job_time', 'untracked_job_time', 'needs_review', 'open_shifts', 'pending_timecards', 'tip_refund_open', 'tip_refunded']);
// Tips on a job with no recorded work time, or with crew time that was never tracked to it, cannot be split by the
// Hub: they are listed unassigned (nothing is split) and a manager may export the rest and pay those by hand. A
// manager cannot add job-time segments to a finished shift, so waiting could never clear them. A tip on a charge whose
// refund the owner already recorded (tip_refunded) is held the same way: the Hub has no action that removes a tip from
// the job, so it is exported unassigned, never split, and paid by hand only if it is still owed. Every other reason
// (an open refund review included) must be fixed first.
export const TIP_ALLOCATION_ACKNOWLEDGEABLE = Object.freeze(['no_job_time', 'untracked_job_time', 'tip_refunded']);
// Job fields the allocation reads beyond the money mask (MONEY_JOB_FIELDS): who the job was assigned to.
export const TIP_ALLOCATION_JOB_FIELDS = Object.freeze(['assignedCrew', 'assignedTo', 'assignmentSegments']);
// Job time held back from the split: the card's work would round to no minutes.
const HALF_MINUTE = 30000;
const MINUTE = 60000;
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const personKey = value => String(value || '').trim().toLowerCase();
const tippableJob = job => Boolean(job) && typeof job.id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(job.id) && !/^(?:_egc_|secure_)/.test(job.id) && !job.recordType;
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const receivedDate = at => at ? denverToday(new Date(at)) : null;
const MAX_LISTED_CREW = 20;

/** Everyone the job names as crew, as saved: the job-level crew and each assignment segment's crew, once per username.
 * An empty assignedCrew list falls back to the legacy assignedTo names, as the Hub schedule shows them (employee-suite
 * crewNames), since an assignedTo-only change can leave assignedCrew as []. */
function assignedCrew(job) {
  const segments = Array.isArray(job?.assignmentSegments) ? job.assignmentSegments : [];
  const listed = Array.isArray(job?.assignedCrew) && job.assignedCrew.length ? job : { assignedTo: job?.assignedTo };
  const names = [...jobCrewNames(listed), ...segments.flatMap(segment => Array.isArray(segment?.assignedCrew) ? jobCrewNames({ assignedCrew: segment.assignedCrew }) : [])];
  const seen = new Set();
  return names.filter(name => { const key = assignmentKey(name); return key && !seen.has(key) && Boolean(seen.add(key)); });
}

/** Raw tip rows as saved (payment.tips[], and any card row marked as a tip), whether or not money-core could total them. */
function savedTipRows(job) {
  const payment = job?.payment && typeof job.payment === 'object' && !Array.isArray(job.payment) ? job.payment : {};
  return [...(Array.isArray(payment.tips) ? payment.tips : []), ...(Array.isArray(payment.stripeSessions) ? payment.stripeSessions.filter(row => row?.purpose === 'tip') : [])];
}

/** Like job costing, `start` is inclusive and `end` is exclusive: start=2026-09-21&end=2026-09-28 is one week. */
export function validateTipAllocationRange({ start, end }) {
  const days = validDate(start) && validDate(end) ? (Date.parse(end) - Date.parse(start)) / 86400000 : NaN;
  if (!(days >= 1 && days <= TIP_ALLOCATION_MAX_DAYS)) throw fail(`Choose a start date and a later, exclusive end date at most ${TIP_ALLOCATION_MAX_DAYS} days apart.`, 'tip_allocation_range_invalid');
}

/** Whole cents split by integer weight; leftover cents go to the largest remainders, then the larger weight, then the key. */
export function splitCents(cents, rows) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!Number.isSafeInteger(cents) || cents <= 0 || !(total > 0)) return rows.map(row => ({ ...row, cents: 0 }));
  const shares = rows.map(row => { const part = cents * row.weight, rest = part % total; return { ...row, cents: (part - rest) / total, rest }; });
  let left = cents - shares.reduce((sum, row) => sum + row.cents, 0);
  for (const row of [...shares].sort((a, b) => b.rest - a.rest || b.weight - a.weight || a.key.localeCompare(b.key))) { if (!left) break; row.cents++; left--; }
  return shares.map(({ rest, ...row }) => row);
}

/** Which refund flag a job's payment reviews put on its tips: 'tip_refund_open' while a refund Stripe shows on one of
 * its tipped charges waits for the owner, else 'tip_refunded' once the owner recorded one, else ''. Only reviews that
 * name a tipped charge whose tip the job lists count. */
function refundFlag(job, reviews) {
  if (!Array.isArray(reviews) || !reviews.length) return '';
  const sessions = new Set(savedTipRows(job).map(row => row?.sessionId).filter(id => typeof id === 'string' && id));
  const relevant = reviews.filter(review => Number.isSafeInteger(review?.tipCents) && review.tipCents > 0 && sessions.has(review.sessionId));
  if (relevant.some(review => review.status === 'open' && review.reason === 'payment_refunded')) return 'tip_refund_open';
  return relevant.some(review => review.status !== 'open' && review.resolution === 'refunded') ? 'tip_refunded' : '';
}

/** refundReviews (optional): Map of jobId to that job's payment_reviews rows ({sessionId, status, reason, resolution,
 * tipCents}); GET /api/tip-allocation always passes it for the tipped jobs. */
export function computeTipAllocation({ jobs, timecards, start, end, now, refundReviews = null } = {}) {
  validateTipAllocationRange({ start, end });
  const asOf = instant(now);
  if (!asOf) throw fail('Pass the current time in; tip allocation never reads the clock.', 'tip_allocation_now_required', 500);
  if (!Array.isArray(jobs) || !Array.isArray(timecards)) throw fail('Jobs and timecards could not be read as complete lists.', 'tip_allocation_records_invalid', 503);
  const inRange = date => Boolean(date) && date >= start && date < end, tipped = new Map();
  for (const job of jobs) {
    if (!tippableJob(job)) continue;
    const ledger = paymentLedger(job), tips = ledger.entries.filter(entry => entry.kind === 'tip');
    const received = tips.filter(entry => entry.at && entry.amountCents !== null && inRange(receivedDate(entry.at)));
    // A tip whose amount or date cannot be read might belong to this range. When money-core cannot total the job's
    // tips at all (tips on an unverified payment, copies that disagree, an unreadable list), those rows are not in the
    // entries, so each saved row is checked by the date it was received: one received in this range, or with no
    // readable date, makes the range's tips unknown whatever the job's service date. With no rows to check, the
    // service date is the only clue.
    const receivedHere = row => { const at = instant(row?.verifiedAt); return !at || inRange(receivedDate(at)); };
    const unknown = tips.some(entry => (entry.amountCents === null || !entry.at) && (!entry.at || inRange(receivedDate(entry.at))))
      || ledger.tipCents === null && (!validDate(job.date) || inRange(job.date) || savedTipRows(job).some(receivedHere));
    if (!received.length && !unknown) continue;
    const refund = refundFlag(job, refundReviews instanceof Map ? refundReviews.get(job.id) : null);
    tipped.set(job.id, { job, tips: received, reasons: new Set([...(unknown ? ['tips_unknown'] : []), ...(refund ? [refund] : [])]), people: new Map() });
  }
  // Per tipped job, the usernames with job work on it (or whose unfinished card on it is already reported).
  const accounted = new Map([...tipped.keys()].map(id => [id, new Set()]));
  for (const card of timecards) {
    const state = timecardPayState(card);
    if (state === 'rejected') continue;
    const segments = Array.isArray(card?.jobTracking?.segments) ? card.jobTracking.segments : [];
    const referenced = [...new Set([card?.jobId, ...segments.map(segment => segment?.jobId)])].filter(id => tipped.has(id));
    if (!referenced.length) continue;
    const key = personKey(card.employee);
    const note = reason => { for (const id of referenced) { tipped.get(id).reasons.add(reason); if (key) accounted.get(id).add(key); } };
    // An open shift's job time is not final yet, so it is left out and reported.
    if (state === 'open') { note('open_shifts'); continue; }
    const summary = typeof card.id !== 'string' || !card.id || !key ? { needsReview: true } : employeeJobTime({ ...card, breaks: Array.isArray(card.breaks) ? card.breaks.filter(item => item?.kind !== 'rest') : card.breaks }, asOf);
    if (summary.needsReview) { note('needs_review'); continue; }
    if (state === 'pending') note('pending_timecards');
    // Time no segment places (no job tracking, tracking begun mid-shift, or a gap) may be work on any job the card
    // names, and a named job the card never started work on may have been worked without tapping Start job time.
    const untracked = summary.partialHistory === true || summary.recorded !== true || summary.untrackedMs > 0;
    const worked = new Map(summary.jobs.map(time => [time.jobId, time.workMs]));
    for (const id of referenced) if (untracked || !(worked.get(id) >= HALF_MINUTE)) tipped.get(id).reasons.add('untracked_job_time');
    for (const time of summary.jobs) {
      const row = tipped.get(time.jobId);
      if (!row || !(time.workMs > 0)) continue;
      if (time.workMs >= HALF_MINUTE) accounted.get(time.jobId).add(key);
      const person = row.people.get(key) || { employee: key, name: String(card.employeeName || card.employee).trim().slice(0, 180), workMs: 0 };
      person.workMs += time.workMs; row.people.set(key, person);
    }
  }
  const byEmployee = new Map(), found = new Set();
  const rows = [...tipped.values()].map(({ job, tips, reasons, people }) => {
    const tipCents = tips.reduce((sum, entry) => sum + entry.amountCents, 0);
    // Assigned crew are matched by username only: a crew saved only as display names (a legacy assignedTo) cannot be
    // matched to timecards, so it is held for the manager rather than guessed.
    const working = accounted.get(job.id), missing = assignedCrew(job).filter(name => !working.has(assignmentKey(name)));
    if (missing.length) reasons.add('untracked_job_time');
    const workers = [...people.values()].map(person => ({ key: person.employee, name: person.name, weight: Math.round(person.workMs / MINUTE) })).filter(person => person.weight > 0);
    const workMinutes = workers.reduce((sum, person) => sum + person.weight, 0);
    if (tipCents > 0 && !workMinutes) reasons.add('no_job_time');
    // With untracked crew time the split would pay only the tracked crew, and a refunded charge's tip may not be owed at
    // all: every share is held at 0 and the whole tip stays unallocated, while the tracked minutes are still listed for
    // the manager who pays it by hand.
    const held = ['untracked_job_time', 'tip_refund_open', 'tip_refunded'].some(reason => reasons.has(reason));
    const employees = splitCents(held ? 0 : tipCents, workers).map(share => ({ employee: share.key, name: share.name, minutes: share.weight, tipCents: share.cents })).sort((a, b) => b.minutes - a.minutes || a.employee.localeCompare(b.employee));
    const allocatedCents = employees.reduce((sum, share) => sum + share.tipCents, 0);
    if (!held) for (const share of employees) {
      const total = byEmployee.get(share.employee) || { employee: share.employee, name: share.name, minutes: 0, tipCents: 0, jobs: 0 };
      total.minutes += share.minutes; total.tipCents += share.tipCents; total.jobs++; byEmployee.set(share.employee, total);
    }
    const flags = TIP_ALLOCATION_REASONS.filter(reason => reasons.has(reason));
    flags.forEach(reason => found.add(reason));
    return { jobId: job.id, customer: String(job.customer || '').slice(0, 180), serviceDate: validDate(job.date) ? job.date : '', tipCents,
      tips: tips.map(entry => ({ id: entry.id, amountCents: entry.amountCents, receivedAt: entry.at, receivedDate: receivedDate(entry.at), processorRef: entry.processorRef })),
      workMinutes, employees, allocatedCents, unallocatedCents: tipCents - allocatedCents, reasons: flags,
      crewWithoutJobTime: missing.slice(0, MAX_LISTED_CREW).map(name => String(name).trim().slice(0, 180)) };
  }).sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.jobId.localeCompare(b.jobId));
  const employees = [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name) || a.employee.localeCompare(b.employee));
  const sum = key => rows.reduce((total, row) => total + row[key], 0), reasons = TIP_ALLOCATION_REASONS.filter(reason => found.has(reason));
  return { start, end, endExclusive: true, timeZone: 'America/Denver', asOf, split: 'job_work_minutes', source: 'explicit_employee_job_segments',
    jobs: rows, employees, totals: { jobs: rows.length, tipCents: sum('tipCents'), allocatedCents: sum('allocatedCents'), unallocatedCents: sum('unallocatedCents') },
    coverage: { complete: !reasons.length, asOf, reasons } };
}
