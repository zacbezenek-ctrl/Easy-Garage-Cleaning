/** Crew performance (CREW-PERF): one row per person for the last 30 and 90 Denver days, from the records the Hub
 * already keeps. Hours and counts only; no pay, cost, price or customer contact reaches it.
 * - Hours on jobs: approved and pending job time from timecard job segments (computeJobLaborCost, hours only).
 * - Jobs worked: customer jobs the person logged job time on. Jobs led: completed jobs where they were the crew lead.
 * - On-time arrivals: of the jobs they logged work on, how many their first work segment started by their own arrival
 *   deadline. On a job split into assignment segments, that is the segment they are assigned to on the Denver day of
 *   their first work start; otherwise the job itself, and only on its start day (a later day of a multi-day job has
 *   no scheduled start). The deadline is the Hub's late rule (arrival-deadline.js): the end of the customer's arrival
 *   window on the job's first visit, else 15 minutes after the scheduled start. Jobs without a
 *   scheduled time, rejected timecards and jobs with no work segment are not counted either way.
 * - Billed vs actual: over the completed jobs they worked that have both billed man-hours (the Labor line) and actual
 *   man-hours (job actuals: timecards first, else the crew lead's count), the crew's actual hours against the billed
 *   ones. It is a crew figure shared by everyone on those jobs, not a measure of one person.
 * - Jobs led and issues: a job (or, on a split job, each segment) credits its crew lead, matched to the roster by id or
 *   by name. Issues are completed jobs they led that closed with "has issues"; follow-ups are their other jobs with an
 *   open crew follow-up, so one job never counts twice.
 * Not tracked anywhere yet, so not shown as zero: callbacks or redo visits, and customer reviews naming a crew member. */
import { scheduleInterval } from './dispatch-time.js';
import { jobSegments, segmented } from './dispatch-segments.js';
import { denverWorkDate } from './timesheet-week.js';
import { completedJob, workJob } from './job-actuals.js';
import { arrivalDeadline as visitDeadline, LATE_GRACE_MS } from './arrival-deadline.js';

export const CREW_PERFORMANCE_GRACE_MINUTES = LATE_GRACE_MS / 60000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = value => String(value || '').trim().toLowerCase();
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The instant a crew member is late after, for a job with a scheduled date and time, or null: the Hub's own late rule
 * (functions/_lib/arrival-deadline.js, the Today agenda's FIELD-FLAGS), run on the visit they were scheduled for. The
 * customer's arrival window applies on the job's own start day and time; another segment is late 15 minutes after its
 * start. */
export function arrivalDeadline(job, slot = job) {
  if (!plain(job) || !plain(slot) || !slot.date || !HHMM.test(String(slot.time || ''))) return null;
  return visitDeadline({ ...job, date: slot.date, time: slot.time, firstVisit: slot.date === job.date && slot.time === job.time });
}

/** What one person was scheduled for on a job, on the Denver day they first clocked in: {date, time, lead} or null.
 * On a split job it is their segment that day; otherwise the job, on its start day only. */
export function personSlot(job, person, firstStart) {
  if (!plain(job) || !Number.isFinite(firstStart)) return null;
  const day = denverWorkDate(new Date(firstStart).toISOString());
  if (segmented(job)) {
    const rows = jobSegments(job).filter(row => row.segmentId && row.date === day && row.assignedCrew.some(id => key(id) === person));
    const row = rows.sort((a, b) => String(a.time).localeCompare(String(b.time)))[0];
    return row ? { date: row.date, time: row.time, lead: row.crewLead } : null;
  }
  return job.date === day ? { date: job.date, time: job.time, lead: job.crewLead } : null;
}

/** Each person's first work segment start on each job: Map(person -> Map(jobId -> ms)). */
export function firstWorkStarts(timecards = []) {
  const out = new Map();
  for (const card of Array.isArray(timecards) ? timecards : []) {
    if (card?.approvalStatus === 'rejected') continue;
    const person = key(card?.employee), segments = card?.jobTracking?.segments;
    if (!person || !Array.isArray(segments)) continue;
    for (const segment of segments) {
      const at = Date.parse(segment?.startedAt || '');
      if (segment?.kind !== 'work' || !segment.jobId || !Number.isFinite(at)) continue;
      const jobs = out.get(person) || new Map();
      if (!jobs.has(segment.jobId) || at < jobs.get(segment.jobId)) jobs.set(segment.jobId, at);
      out.set(person, jobs);
    }
  }
  return out;
}

function blank(person, name) {
  return { employee: person, name, hours: 0, pendingHours: 0, jobsWorked: 0, jobsLed: 0, onTime: 0, arrivalsCounted: 0, billedManHours: 0, actualManHours: 0, comparedJobs: 0, issueJobs: 0, followUps: 0 };
}

/** rows for one window. jobs: dispatch job records; labor: computeJobLaborCost (laborCostHidden); actuals: job-actuals
 * rows by jobId; starts: firstWorkStarts(); roster: [{id,name}]; start/end: Denver dates, end exclusive. */
export function crewPerformanceWindow({ jobs = [], labor = { jobs: [] }, actuals = new Map(), starts = new Map(), roster = [], start, end }) {
  const listed = roster.filter(plain), names = new Map(listed.map(person => [key(person.id), String(person.name || person.id)]));
  // A crew lead saved as a display name is the same person as their roster id.
  const byName = new Map(listed.filter(person => person.name).map(person => [key(person.name), key(person.id)]));
  const who = value => { const id = key(value); return names.has(id) ? id : byName.get(id) || id; };
  const people = new Map(), row = (person, name) => { if (!people.has(person)) people.set(person, blank(person, names.get(person) || name || person)); return people.get(person); };
  const inWindow = job => workJob(job) && typeof job.date === 'string' && job.date >= start && job.date < end;
  const byId = new Map(jobs.filter(inWindow).map(job => [job.id, job]));
  for (const jobRow of labor?.jobs || []) {
    const job = byId.get(jobRow.jobId);
    if (!job) continue;
    const actual = actuals.get(job.id), compared = actual && completedJob(job) && typeof actual.billed?.manHours === 'number' && typeof actual.actual?.manHours === 'number';
    for (const person of jobRow.employees || []) {
      const id = key(person.employee), hours = Number(person.approvedHours) || 0, pending = Number(person.pendingHours) || 0;
      if (!id || hours + pending <= 0) continue;
      const entry = row(id, person.name);
      entry.hours += hours; entry.pendingHours += pending; entry.jobsWorked++;
      const arrived = starts.get(id)?.get(job.id), slot = personSlot(job, id, arrived), deadline = slot ? arrivalDeadline(job, slot) : null;
      if (deadline !== null) { entry.arrivalsCounted++; if (arrived <= deadline) entry.onTime++; }
      if (compared) { entry.comparedJobs++; entry.billedManHours += actual.billed.manHours; entry.actualManHours += actual.actual.manHours; }
    }
  }
  for (const job of byId.values()) {
    const leads = [...new Set((segmented(job) ? jobSegments(job).map(segment => segment.crewLead) : [job.crewLead]).map(who).filter(Boolean))];
    const issues = completedJob(job) && job.fieldExecution?.completion?.hasIssues === true;
    for (const lead of leads) {
      if (completedJob(job)) row(lead).jobsLed++;
      if (issues) row(lead).issueJobs++;
      else if (job.fieldExecution?.attention?.status === 'open') row(lead).followUps++;
    }
  }
  return [...people.values()].map(entry => ({
    ...entry, hours: round(entry.hours), pendingHours: round(entry.pendingHours), billedManHours: round(entry.billedManHours), actualManHours: round(entry.actualManHours),
    onTimePercent: entry.arrivalsCounted ? round(entry.onTime / entry.arrivalsCounted * 100, 1) : null,
    hoursVsBilledPercent: entry.comparedJobs && entry.billedManHours > 0 ? round((entry.actualManHours - entry.billedManHours) / entry.billedManHours * 100, 1) : null,
  })).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name) || a.employee.localeCompare(b.employee));
}
