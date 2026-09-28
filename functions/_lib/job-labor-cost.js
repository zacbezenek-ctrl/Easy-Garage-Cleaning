import { employeeJobTime } from './employee-job-time.js';
import { addDays, validDate } from './dispatch-time.js';
import { COVERAGE_REASONS, computeTimesheetWeeks, denverWorkDate, payRate, resolveOvertimePolicy, timecardPayState, timesheetWeekStart } from './timesheet-week.js';

const HOUR = 3600000;
export const JOB_COSTING_MAX_DAYS = 92;
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const personKey = value => String(value || '').trim().toLowerCase();
const hours = ms => Math.round(ms / HOUR * 1000) / 1000;
const cents = value => Math.round(value * 100) / 100;
export const costableJobId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(?:_egc_|secure_)/.test(value);
const zero = () => ({ workMs: 0, travelMs: 0, laborMs: 0, straight: 0, premium: 0 });
const add = (target, values) => { for (const key of Object.keys(target)) target[key] += values[key] || 0; };
const minus = (left, right) => Object.fromEntries(Object.keys(left).map(key => [key, left[key] - right[key]]));
const bucket = value => {
  const straightCost = cents(value.straight), overtimePremium = cents(value.premium);
  return { workHours: hours(value.workMs), travelHours: hours(value.travelMs), laborHours: hours(value.laborMs), straightCost, overtimePremium, cost: cents(straightCost + overtimePremium) };
};

/** Like dispatch ranges, `start` is inclusive and `end` is exclusive: start=2026-09-21&end=2026-09-28 is one week. */
export function validateJobCostingRange({ start, end, jobId = '' }) {
  const days = validDate(start) && validDate(end) ? (Date.parse(end) - Date.parse(start)) / 86400000 : NaN;
  if (!(days >= 1 && days <= JOB_COSTING_MAX_DAYS)) throw fail(`Choose a start date and a later, exclusive end date at most ${JOB_COSTING_MAX_DAYS} days apart.`, 'job_costing_range_invalid');
  if (jobId !== '' && !costableJobId(jobId)) throw fail('Choose a valid job.', 'job_costing_job_invalid');
}

/** Labor cost per job from explicit employee job-time segments (never legacy shift.jobId guesses). Straight time
 * uses each timecard's snapshotted hourlyRate; the employee-week overtime premium from computeTimesheetWeeks is
 * allocated in proportion to the hours spent on each job. `approved` uses approved timecards only, `projected`
 * also includes pending ones, and `pending` is the change in cost if the pending timecards are approved as-is.
 * Approved cost is final only while coverage.complete: approving more time in the same employee-week moves overtime
 * premium onto it. Timecard bonus and tips themselves are not costed to a job (the bonus still raises the regular
 * rate behind the premium). */
export function computeJobLaborCost({ timecards = [], policy = 'colorado', start, end, jobId = '', includeTravel = false, now = new Date().toISOString() } = {}) {
  validateJobCostingRange({ start, end, jobId });
  if (!Array.isArray(timecards)) throw fail('Timecards could not be read as a complete list.', 'job_costing_records_invalid', 503);
  const rules = resolveOvertimePolicy(policy), jobs = new Map(), selected = [], touched = new Map();
  for (const card of timecards) {
    const state = timecardPayState(card), workDate = denverWorkDate(card?.clockInAt);
    if (state !== 'rejected' && workDate && workDate >= start && workDate < end) selected.push({ card, state, weekStart: timesheetWeekStart(workDate) });
  }
  // Overtime needs each touched employee-week in full, including days outside the requested range.
  const weekStarts = [...new Set(selected.filter(item => item.state !== 'open').map(item => item.weekStart))];
  const weeks = includePending => computeTimesheetWeeks({ timecards, pto: [], policy: rules, weekStarts, now, includePending });
  const shares = results => new Map([...results].map(([weekStart, week]) => [weekStart, {
    review: new Set(week.needsReview.map(item => item.id)), premiumPerHour: new Map(week.employees.map(row => [row.employee, row.workedHours ? row.overtimePremium / row.workedHours : 0])) }]));
  const approvedResults = weeks(false), approvedWeeks = shares(approvedResults), projectedWeeks = shares(weeks(true));
  const job = (id, label = '') => {
    if (!jobs.has(id)) jobs.set(id, { jobId: id, jobLabel: '', approved: zero(), projected: zero(), employees: new Map(), approvedTimecards: new Set(), pendingTimecards: new Set(), openShifts: 0, needsReviewCount: 0, legacyAssociationOnlyCount: 0, missingRateCount: 0 });
    const row = jobs.get(id);
    if (!row.jobLabel && label) row.jobLabel = String(label).slice(0, 180);
    return row;
  };
  if (jobId) job(jobId);
  const wanted = id => costableJobId(id) && (!jobId || id === jobId);
  for (const { card, state, weekStart } of selected) {
    const segments = Array.isArray(card.jobTracking?.segments) ? card.jobTracking.segments : [];
    const referenced = [...new Set([card.jobId, ...segments.map(segment => segment?.jobId)])].filter(wanted);
    if (referenced.length) { if (!touched.has(weekStart)) touched.set(weekStart, new Set()); touched.get(weekStart).add(personKey(card.employee)); }
    if (state === 'open') { for (const id of referenced) job(id).openShifts++; continue; }
    const week = { approved: approvedWeeks.get(weekStart), projected: projectedWeeks.get(weekStart) };
    // Paid rest breaks stay on the job they interrupted; meal and legacy breaks are unpaid.
    const summary = typeof card.id !== 'string' || !card.id || !personKey(card.employee) || week.projected.review.has(card.id) ? { needsReview: true } : employeeJobTime({ ...card, breaks: Array.isArray(card.breaks) ? card.breaks.filter(item => item?.kind !== 'rest') : card.breaks }, now);
    if (summary.needsReview) { for (const id of referenced) job(id).needsReviewCount++; continue; }
    if (wanted(card.jobId) && (!summary.recorded || summary.partialHistory)) job(card.jobId).legacyAssociationOnlyCount++;
    const key = personKey(card.employee), hourly = payRate(card.hourlyRate);
    for (const time of summary.jobs) {
      if (!wanted(time.jobId)) continue;
      const row = job(time.jobId, time.jobLabel), laborMs = time.workMs + (includeTravel ? time.travelMs : 0), laborHours = laborMs / HOUR;
      const base = { workMs: time.workMs, travelMs: time.travelMs, laborMs, straight: laborHours * hourly };
      const projected = { ...base, premium: laborHours * (week.projected.premiumPerHour.get(key) || 0) };
      const approved = state === 'approved' ? { ...base, premium: laborHours * (week.approved.premiumPerHour.get(key) || 0) } : zero();
      add(row.projected, projected); add(row.approved, approved);
      const person = row.employees.get(key) || { employee: key, name: String(card.employeeName || card.employee).slice(0, 180), approved: zero(), projected: zero() };
      add(person.projected, projected); add(person.approved, approved); row.employees.set(key, person);
      row[state === 'approved' ? 'approvedTimecards' : 'pendingTimecards'].add(card.id);
      if (!hourly) row.missingRateCount++;
    }
  }
  const rows = [...jobs.values()].map(row => ({
    jobId: row.jobId, jobLabel: row.jobLabel, approved: bucket(row.approved), pending: bucket(minus(row.projected, row.approved)), projected: bucket(row.projected),
    employees: [...row.employees.values()].map(person => ({ employee: person.employee, name: person.name, approvedHours: hours(person.approved.laborMs), pendingHours: hours(person.projected.laborMs - person.approved.laborMs),
      approvedCost: cents(cents(person.approved.straight) + cents(person.approved.premium)), projectedCost: cents(cents(person.projected.straight) + cents(person.projected.premium)) })).sort((a, b) => a.name.localeCompare(b.name) || a.employee.localeCompare(b.employee)),
    approvedTimecards: row.approvedTimecards.size, pendingTimecards: row.pendingTimecards.size, openShifts: row.openShifts, needsReviewCount: row.needsReviewCount, legacyAssociationOnlyCount: row.legacyAssociationOnlyCount, missingRateCount: row.missingRateCount,
  })).sort((a, b) => b.projected.cost - a.projected.cost || a.jobId.localeCompare(b.jobId));
  const total = key => { const sum = zero(); for (const row of jobs.values()) add(sum, key === 'pending' ? minus(row.projected, row.approved) : row[key]); return bucket(sum); };
  const count = key => rows.reduce((sum, row) => sum + row[key], 0), totals = { approved: total('approved'), pending: total('pending'), projected: total('projected') }, found = new Set();
  // Approved cost is complete only when every employee-week whose overtime it shares is finished and settled, even
  // where the unsettled time is on another job or on days outside the range.
  const today = denverWorkDate(now);
  if (!today || today <= addDays(timesheetWeekStart(addDays(end, -1)), 6)) found.add('week_in_progress');
  for (const [weekStart, people] of touched) {
    const week = approvedResults.get(weekStart), mine = item => !item.employee || people.has(item.employee);
    if (!week) continue;
    if (week.needsReview.some(mine)) found.add('needs_review');
    if (week.unattributed.some(mine)) found.add('unattributed_records');
    for (const row of week.employees.filter(row => people.has(row.employee))) {
      if (row.pendingExcludedTimecards) found.add('pending_timecards');
      if (row.openShifts) found.add('open_shifts');
      for (const flag of row.flags) found.add(flag);
    }
  }
  if (count('needsReviewCount')) found.add('needs_review');
  if (count('openShifts')) found.add('open_shifts');
  if (count('pendingTimecards') || Object.values(totals.pending).some(Boolean)) found.add('pending_timecards');
  if (count('missingRateCount')) found.add('missing_rate');
  const reasons = COVERAGE_REASONS.filter(reason => found.has(reason));
  return { policy: { ...rules }, start, end, endExclusive: true, jobId, includeTravel: includeTravel === true, asOf: now,
    source: 'explicit_employee_job_segments', jobs: rows, totals,
    needsReviewCount: count('needsReviewCount'), openShifts: count('openShifts'), legacyAssociationOnlyCount: count('legacyAssociationOnlyCount'), coverage: { complete: !reasons.length, asOf: now, reasons } };
}
