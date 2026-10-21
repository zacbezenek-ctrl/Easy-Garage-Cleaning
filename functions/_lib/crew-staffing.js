/** Crew staffing (crew-ops, owner priority 2026-10-21): what keeps crews from being where they need to be. Pure: no
 * reads, no clock; functions/api/crew-staffing.js reads and passes everything in.
 *
 * Roster health, from the crews and roster GET /api/dispatch already reads:
 *   crew_no_members        an active crew with nobody on it
 *   crew_no_lead           an active crew with members but no lead, or a lead who is not one of its members
 *   crew_member_inactive   an active crew member who is not on the active roster (deactivated, removed or unknown)
 *   availability_clash     a member whose recorded weekly hours (staff directory) have no hours on a day the crew works
 *   no_staffable_crew      no crew can take any work: none is active with every member on the roster
 *   uncovered_day          a weekday in the next STAFFING_DAYS days that no staffable crew works, with its dates
 * Staffable and covering use dispatch-crew-assign.js staffableCrew and eligibleCrews, the rules the server's own crew
 * pick uses, so this list never drifts from what auto-assign does. An inactive crew is left alone: it is off on purpose.
 *
 * Unstaffed jobs: dated jobs, cleanouts and reorgs in the same window that are not cancelled or done, with no crew
 * (no_crew) or fewer people than their crew size (short), oldest date first. canAutoStaff says the server can try a crew
 * for it (dispatch-service.js autoCrewPlan 'staff': one job-level schedule, nobody on it). Segmented jobs are judged by
 * each of their segments. No money: rows carry the customer's name, the date and the crew counts only.
 *
 * Staffing preview: for each job the server can try, the first eligible crew (in pick order) whose members are free for
 * the whole visit, counting earlier picks in the same batch, or why none is: no crew works that day, or every crew that
 * does is busy. A preview only: the save re-checks every rule (conflicts, capacity, availability, blocking settings). */
import { AUTO_CREW_TYPES, CREW_DAYS, autoCrewJob, crewJobDates, crewServiceDays, eligibleCrews, sortCrews, staffableCrew } from './dispatch-crew-assign.js';
import { jobCrewNames, assignmentKey } from './job-assignment.js';
import { crewNeededOf, weekdayOf } from './dispatch-rules.js';
import { jobSegments, segmented } from './dispatch-segments.js';
import { addDays, availabilityInterval, overlaps, scheduleInterval, validDate } from './dispatch-time.js';

export const STAFFING_DAYS = 14;
export const DAY_NAMES = Object.freeze({ mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' });
const DONE = new Set(['cancelled', 'canceled', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'noshow', 'no_show', 'no-show']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = crew => String(crew?.name || 'A crew').slice(0, 100);
const personName = (roster, id) => roster.find(person => person.id === id)?.name || id;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Oct 25' for '2026-10-25' (a Denver calendar date, no clock). */
export const shortDate = date => validDate(date) ? `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}` : String(date);

/** The window for a Denver day: STAFFING_DAYS dates from today, end inclusive. */
export const staffingWindow = today => ({ startDate: today, endDate: addDays(today, STAFFING_DAYS - 1) });
export const windowDates = today => Array.from({ length: STAFFING_DAYS }, (_, index) => addDays(today, index));

/** Roster health problems, in a fixed order: crew problems by crew pick order, then the days no crew covers. */
export function rosterHealth({ crews = [], roster = [], today }) {
  const people = Array.isArray(roster) ? roster : [], problems = [];
  const active = sortCrews((Array.isArray(crews) ? crews : []).filter(row => row?.recordType === 'crew' && row.status === 'active'));
  for (const crew of active) {
    const memberIds = Array.isArray(crew.memberIds) ? crew.memberIds.filter(id => typeof id === 'string') : [];
    const base = { crewId: crew.id, crewName: label(crew) };
    if (!memberIds.length) { problems.push({ code: 'crew_no_members', ...base, message: `${label(crew)} has no members, so it is never assigned work.` }); continue; }
    const missing = memberIds.filter(id => !people.some(person => person.id === id));
    for (const id of missing) problems.push({ code: 'crew_member_inactive', ...base, employeeId: id, message: `${label(crew)} lists ${id}, who is not an active employee, so the crew is skipped for every job until they are removed or reactivated.` });
    if (!crew.leadId || !memberIds.includes(crew.leadId)) problems.push({ code: 'crew_no_lead', ...base, message: crew.leadId ? `${label(crew)}'s lead is not one of its members. Choose a lead from the crew.` : `${label(crew)} has no crew lead. Choose one so the crew knows who runs the job.` });
    for (const id of memberIds.filter(id => !missing.includes(id))) {
      const week = people.find(person => person.id === id)?.weeklyAvailability;
      if (!plain(week)) continue;
      const off = crewServiceDays(crew).filter(day => !Array.isArray(week[day]) || !week[day].length);
      if (off.length) problems.push({ code: 'availability_clash', ...base, employeeId: id, days: off, message: `${personName(people, id)} has no working hours on ${off.map(day => DAY_NAMES[day]).join(', ')}, but ${label(crew)} works ${off.length === 1 ? 'that day' : 'those days'}.` });
    }
  }
  const dates = validDate(today) ? windowDates(today) : [];
  if (!active.some(crew => staffableCrew(crew, people))) {
    problems.push({ code: 'no_staffable_crew', message: active.length ? 'No crew can take work: every active crew is empty or lists someone who is not an active employee. Every booking saves as "Sold: needs crew".' : 'There are no active crews, so every booking saves as "Sold: needs crew". Create the crews and add their members.' });
    return problems;
  }
  const uncovered = new Map();
  for (const date of dates) if (!eligibleCrews(crews, [date], people).length) { const day = weekdayOf(date); if (!uncovered.has(day)) uncovered.set(day, []); uncovered.get(day).push(date); }
  for (const day of CREW_DAYS.filter(day => uncovered.has(day))) problems.push({ code: 'uncovered_day', day, dates: uncovered.get(day), message: `No staffable crew works ${DAY_NAMES[day]}s, so jobs on ${uncovered.get(day).map(shortDate).join(' and ')} cannot be staffed automatically.` });
  return problems;
}

const liveJob = job => plain(job) && typeof job.id === 'string' && !job.recordType && AUTO_CREW_TYPES.includes(job.type) && !DONE.has(String(job.pipelineStatus || job.status || '').toLowerCase());
const memberCount = row => jobCrewNames(row).length;

/** Dated jobs in the window with no crew or short of their crew size, oldest date (then time, then id) first. */
export function unstaffedJobs(jobs = [], { today }) {
  const { startDate, endDate } = staffingWindow(today), out = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!liveJob(job) || !validDate(job.date) || job.date < startDate || job.date > endDate) continue;
    const rows = segmented(job) ? jobSegments(job).filter(Boolean) : [job], needed = crewNeededOf(job);
    const counts = rows.map(memberCount), fewest = counts.length ? Math.min(...counts) : 0;
    if (fewest >= needed) continue;
    out.push({ jobId: job.id, date: job.date, time: job.time || '', endTime: job.endTime || '', endDate: job.endDate || job.date, customer: String(job.customer || '').slice(0, 180), title: String(job.title || '').slice(0, 200),
      type: job.type, crewId: job.crewId || null, assigned: fewest, needed, status: fewest === 0 ? 'no_crew' : 'short', segmented: segmented(job), revision: job.revision || null,
      canAutoStaff: autoCrewJob(job) && fewest === 0 && !job.crewId });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.jobId.localeCompare(b.jobId));
}

/** Who is busy when: every active dated job's people with its interval, plus time off. */
function busyRows(jobs, availability) {
  const rows = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!plain(job) || job.recordType || DONE.has(String(job.pipelineStatus || job.status || '').toLowerCase())) continue;
    for (const row of jobSegments(job).filter(Boolean)) { const interval = scheduleInterval(row); if (interval) rows.push({ jobId: job.id, interval, people: jobCrewNames(row).map(assignmentKey) }); }
  }
  for (const row of Array.isArray(availability) ? availability : []) {
    if (!plain(row) || row.status === 'cancelled') continue;
    const interval = availabilityInterval(row), person = assignmentKey(row.employeeId || row.employee);
    if (interval && person) rows.push({ jobId: null, interval, people: [person] });
  }
  return rows;
}

/** The batch a "Staff waiting jobs" run would make: [{jobId, date, crewId, crewName} | {jobId, date, reason, message}]. */
export function staffingPreview({ waiting = [], jobs = [], crews = [], roster = [], availability = [] }) {
  const busy = busyRows(jobs, availability), plan = [];
  const byId = new Map((Array.isArray(jobs) ? jobs : []).map(job => [job.id, job]));
  for (const row of waiting.filter(item => item.canAutoStaff)) {
    const job = byId.get(row.jobId), interval = job && scheduleInterval(job);
    if (!job || !interval) continue;
    const eligible = eligibleCrews(crews, crewJobDates(job), roster);
    const free = eligible.find(crew => !busy.some(entry => entry.jobId !== job.id && overlaps(entry.interval, interval) && crew.memberIds.some(id => entry.people.includes(assignmentKey(id)))));
    if (free) {
      plan.push({ jobId: job.id, date: job.date, crewId: free.id, crewName: label(free) });
      busy.push({ jobId: job.id, interval, people: free.memberIds.map(assignmentKey) });
    } else {
      const days = [...new Set(crewJobDates(job).map(date => DAY_NAMES[weekdayOf(date)]))];
      plan.push(eligible.length ? { jobId: job.id, date: job.date, reason: 'busy', message: `every crew that works ${days.join(' and ')} is busy then` }
        : { jobId: job.id, date: job.date, reason: 'no_crew_works', message: `no staffable crew works ${days.map(day => day + 's').join(' or ')}` });
    }
  }
  return plan;
}

/** "Crew 2 → 3 jobs; 1 can't be staffed: no crew works Sundays". */
export function previewSummary(plan) {
  const counts = new Map();
  for (const row of plan.filter(item => item.crewId)) counts.set(row.crewName, (counts.get(row.crewName) || 0) + 1);
  const staffed = [...counts].map(([name, count]) => `${name} → ${count} job${count === 1 ? '' : 's'}`);
  const failed = plan.filter(item => !item.crewId), reasons = [...new Set(failed.map(item => item.message))];
  return [staffed.join(', ') || 'No job can be staffed', failed.length ? `${failed.length} can't be staffed: ${reasons.join('; ')}` : ''].filter(Boolean).join('; ');
}

/** The whole report. */
export function crewStaffing({ crews = [], roster = [], jobs = [], availability = [], today, asOf }) {
  const health = rosterHealth({ crews, roster, today }), waiting = unstaffedJobs(jobs, { today });
  const preview = staffingPreview({ waiting, jobs, crews, roster, availability });
  return { ok: true, asOf, today, window: staffingWindow(today), health, unstaffed: waiting, preview, previewSummary: preview.length ? previewSummary(preview) : '',
    counts: { problems: health.length, unstaffed: waiting.length, canAutoStaff: waiting.filter(row => row.canAutoStaff).length } };
}
