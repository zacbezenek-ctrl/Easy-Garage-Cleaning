/** Crew performance (CREW-PERF): one row per person for the last 30 and 90 Denver days, from the records the Hub
 * already keeps. Hours and counts only; no pay, cost, price or customer contact reaches it.
 * - Hours on jobs: approved and pending job time from timecard job segments (computeJobLaborCost, hours only).
 * - Jobs worked: customer jobs the person logged job time on. Jobs led: completed jobs where they were the crew lead.
 * - On-time arrivals: of the jobs they logged work on, how many their first work segment started by the arrival
 *   window's end (or within 15 minutes of the scheduled start when the job has no window). Jobs without a scheduled
 *   time, or with no work segment, are not counted either way.
 * - Billed vs actual: over the completed jobs they worked that have both billed man-hours (the Labor line) and actual
 *   man-hours (job actuals: timecards first, else the crew lead's count), the crew's actual hours against the billed
 *   ones. It is a crew figure shared by everyone on those jobs, not a measure of one person.
 * - Issues flagged: completed jobs they led that closed with "has issues", and jobs with an open crew follow-up.
 * Not tracked anywhere yet, so not shown as zero: callbacks or redo visits, and customer reviews naming a crew member. */
import { scheduleInterval } from './dispatch-time.js';
import { completedJob, workJob } from './job-actuals.js';

export const CREW_PERFORMANCE_GRACE_MINUTES = 15;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = value => String(value || '').trim().toLowerCase();
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The instant a crew member is late after, for a job with a scheduled date and time, or null. */
export function arrivalDeadline(job) {
  if (!plain(job) || !job.date || !HHMM.test(String(job.time || ''))) return null;
  const window = HHMM.test(String(job.arrivalWindowEnd || '')) && String(job.arrivalWindowEnd) >= String(job.time) ? String(job.arrivalWindowEnd) : null;
  const at = scheduleInterval({ date: job.date, time: window || job.time, endDate: job.date, endTime: '23:59' });
  if (!at) return null;
  return at.start + (window ? 0 : CREW_PERFORMANCE_GRACE_MINUTES * 60000);
}

/** Each person's first work segment start on each job: Map(person -> Map(jobId -> ms)). */
export function firstWorkStarts(timecards = []) {
  const out = new Map();
  for (const card of Array.isArray(timecards) ? timecards : []) {
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
  const names = new Map(roster.filter(plain).map(person => [key(person.id), String(person.name || person.id)]));
  const people = new Map(), row = (person, name) => { if (!people.has(person)) people.set(person, blank(person, names.get(person) || name || person)); return people.get(person); };
  const inWindow = job => workJob(job) && typeof job.date === 'string' && job.date >= start && job.date < end;
  const byId = new Map(jobs.filter(inWindow).map(job => [job.id, job]));
  for (const jobRow of labor?.jobs || []) {
    const job = byId.get(jobRow.jobId);
    if (!job) continue;
    const actual = actuals.get(job.id), compared = actual && completedJob(job) && typeof actual.billed?.manHours === 'number' && typeof actual.actual?.manHours === 'number';
    const deadline = arrivalDeadline(job);
    for (const person of jobRow.employees || []) {
      const id = key(person.employee), hours = Number(person.approvedHours) || 0, pending = Number(person.pendingHours) || 0;
      if (!id || hours + pending <= 0) continue;
      const entry = row(id, person.name);
      entry.hours += hours; entry.pendingHours += pending; entry.jobsWorked++;
      const arrived = starts.get(id)?.get(job.id);
      if (deadline !== null && Number.isFinite(arrived)) { entry.arrivalsCounted++; if (arrived <= deadline) entry.onTime++; }
      if (compared) { entry.comparedJobs++; entry.billedManHours += actual.billed.manHours; entry.actualManHours += actual.actual.manHours; }
    }
  }
  for (const job of byId.values()) {
    const lead = key(job.crewLead);
    if (lead && completedJob(job)) {
      const entry = row(lead);
      entry.jobsLed++;
      if (job.fieldExecution?.completion?.hasIssues === true) entry.issueJobs++;
    }
    if (lead && job.fieldExecution?.attention?.status === 'open') row(lead).followUps++;
  }
  return [...people.values()].map(entry => ({
    ...entry, hours: round(entry.hours), pendingHours: round(entry.pendingHours), billedManHours: round(entry.billedManHours), actualManHours: round(entry.actualManHours),
    onTimePercent: entry.arrivalsCounted ? round(entry.onTime / entry.arrivalsCounted * 100, 1) : null,
    hoursVsBilledPercent: entry.comparedJobs && entry.billedManHours > 0 ? round((entry.actualManHours - entry.billedManHours) / entry.billedManHours * 100, 1) : null,
  })).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name) || a.employee.localeCompare(b.employee));
}
