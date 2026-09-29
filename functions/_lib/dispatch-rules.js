import { addDays, scheduleInterval } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';
import { SKILL_CATALOG } from './staff-skills.js';
import { DISPATCH_SETTINGS_DEFAULTS } from './dispatch-settings.js';
import { segmented } from './dispatch-segments.js';

/** Dispatch rules (P1-DS-06). Pure evaluators over one job's schedule rows
 * (a legacy job, or each assignment segment), the dispatch roster (P1-08:
 * skills [{id,level}] and weeklyAvailability {mon..sun:[{start,end}]}|null)
 * and the owner settings (dispatch-settings.js). Each returns warnings
 * {code,jobId,message,...}; `blocking:true` is added only when the owner
 * setting turns that rule into a block AND the caller enforces it for this
 * change (conflictCheck then answers 409 dispatch_conflict). With the default
 * settings every rule is a warning and no daily limit applies.
 *   skill_missing           job.requiredSkills not held (proficient or lead)
 *                           by any assigned employee of a row; unverified:true
 *                           when an employee has no recorded skills. A job
 *                           offered for pickup (offeredForPickup) never blocks:
 *                           a qualified employee may claim the open seat.
 *   employee_daily_capacity more than maxJobsPerEmployeePerDay jobs, or more
 *                           than maxHoursPerEmployeePerDay scheduled hours, for
 *                           one employee on one Denver date (this job included).
 *   outside_working_hours   work outside an employee's recorded weekly hours;
 *                           employees without recorded hours are not checked.
 *   crew_size_short         fewer employees than crewNeeded; a job offered
 *                           for pickup (offeredForPickup) never blocks.
 * No rule reads the clock; Denver dates come from the saved wall-clock fields. */
export const QUALIFIED_SKILL_LEVELS = Object.freeze(['proficient', 'lead']);
export const RULE_BLOCK_SETTINGS = Object.freeze({ skill_missing: 'blockSkillMissing', employee_daily_capacity: 'blockOverCapacity', outside_working_hours: 'blockOutsideHours', crew_size_short: 'blockCrewShort' });
const WEEKDAYS = ['sun','mon','tue','wed','thu','fri','sat'];
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const SKILL_ID = /^[a-z0-9_]{1,40}$/;
const labels = new Map(SKILL_CATALOG.map(skill => [skill.id, skill.label]));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const minutes = value => value === '24:00' ? 1440 : /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? Number(value.slice(0,2)) * 60 + Number(value.slice(3)) : NaN;
const clock = minute => minute >= 1440 ? 'midnight' : `${Math.floor(minute / 60) % 12 || 12}:${String(minute % 60).padStart(2,'0')} ${minute < 720 ? 'AM' : 'PM'}`;
const round = value => Math.round(value * 100) / 100;
const skillLabel = id => labels.get(id) || id.replaceAll('_', ' ');
const nameOf = (roster, id) => roster.find(person => person.id === id)?.name || id;
export const weekdayOf = date => WEEKDAYS[new Date(Date.parse(date + 'T12:00:00Z')).getUTCDay()];

/** The saved list of required skill ids, deduplicated; anything else is ignored. */
export function requiredSkillsOf(job) {
  return Array.isArray(job?.requiredSkills) ? [...new Set(job.requiredSkills.filter(id => typeof id === 'string' && SKILL_ID.test(id)))] : [];
}

/** Validates a dispatch save's requiredSkills: current catalog ids, or ids the
 * job already carries (a retired skill can be kept, never newly added). */
export function validateRequiredSkills(value, current = []) {
  const kept = new Set(requiredSkillsOf({ requiredSkills: current }));
  if (!Array.isArray(value) || value.length > SKILL_CATALOG.length + kept.size || value.some(id => typeof id !== 'string' || !(labels.has(id) || kept.has(id)))) return null;
  return [...new Set(value)].sort();
}

/** null when the employee has no recorded skills (unknown), else id => level. */
export function skillLevels(person) {
  return Array.isArray(person?.skills) ? new Map(person.skills.filter(skill => isObject(skill) && typeof skill.id === 'string').map(skill => [skill.id, skill.level])) : null;
}
export const qualified = (person, skill) => QUALIFIED_SKILL_LEVELS.includes(skillLevels(person)?.get(skill));

/** Owner decision F19: a roster row marked fieldWork:false (an office-only owner or
 * manager, dispatch-storage.js officeOnly) is left out of 'any qualified' openings
 * and of the Hub's assignment pickers. Rows without the marker take field work. */
export const takesFieldWork = person => person?.fieldWork !== false;

/** Required skills no one in the crew holds at a qualified level. */
export function missingSkills(crewIds, roster, skills) {
  const people = crewIds.map(id => roster.find(person => person.id === id));
  return skills.filter(skill => !people.some(person => qualified(person, skill)));
}

/** Merged working windows of one employee on one Denver date, in minutes, or
 * null when no weekly hours are recorded for them. */
export function workingWindows(person, date) {
  const week = person?.weeklyAvailability;
  if (!isObject(week)) return null;
  const merged = [];
  for (const window of (Array.isArray(week[weekdayOf(date)]) ? week[weekdayOf(date)] : []).map(row => ({ start: minutes(row?.start), end: minutes(row?.end) })).filter(row => row.end > row.start).sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else merged.push(window);
  }
  return merged;
}

// Denver dates an interval occupies; an end at midnight releases that date (occupiedDays).
function datesOf(interval) {
  const dates = [];
  for (let date = interval.date; date <= interval.endDate && !(date === interval.endDate && interval.endTime === '00:00'); date = addDays(date, 1)) dates.push(date);
  return dates;
}
/** The part of a schedule row on each Denver date it occupies, in wall-clock minutes. */
export function dayPieces(row, interval = scheduleInterval(row)) {
  return interval ? datesOf(interval).map(date => ({ date, start: date === interval.date ? minutes(interval.time) : 0, end: date === interval.endDate ? minutes(interval.endTime) : 1440 })) : [];
}

// Midnight is never a DST boundary in Denver; bounds are memoized per date.
const bounds = new Map();
function dayBounds(date) {
  if (!bounds.has(date)) {
    if (bounds.size > 2000) bounds.clear();
    const start = localInstant(date, '00:00'), end = localInstant(addDays(date, 1), '00:00');
    bounds.set(date, start && end ? { start: Date.parse(start), end: Date.parse(end) } : null);
  }
  return bounds.get(date);
}
/** Elapsed scheduled minutes of an interval on each Denver date (DST days are 23 or 25 hours). */
export function minutesByDay(row, interval = scheduleInterval(row)) {
  const out = new Map();
  if (!interval) return out;
  for (const date of datesOf(interval)) {
    const bounds = dayBounds(date), used = bounds ? Math.min(interval.end, bounds.end) - Math.max(interval.start, bounds.start) : 0;
    if (used > 0) out.set(date, (out.get(date) || 0) + used / 60000);
  }
  return out;
}

/** Scheduled work per employee and Denver date: key `${employee}|${date}` =>
 * Map(jobId => minutes). Company blocks and rows without valid times are left out. */
export function capacityIndex(rows, crewOf, intervalOf = scheduleInterval) {
  const index = new Map();
  for (const row of rows) {
    if (row.type === 'blocked') continue;
    const interval = intervalOf(row);
    if (!interval) continue;
    for (const [date, used] of minutesByDay(row, interval)) for (const id of crewOf(row)) {
      const key = `${id}|${date}`;
      if (!index.has(key)) index.set(key, new Map());
      index.get(key).set(row.id, (index.get(key).get(row.id) || 0) + used);
    }
  }
  return index;
}

/** Whether `extra` more jobs and minutes on a date would exceed the limits. */
export function capacityExceeded(settings, jobCount, scheduledMinutes) {
  const jobs = settings?.maxJobsPerEmployeePerDay, hours = settings?.maxHoursPerEmployeePerDay;
  return Number.isInteger(jobs) && jobCount > jobs || typeof hours === 'number' && scheduledMinutes > hours * 60 + 1e-9;
}
export function capacityLimitText(settings) {
  const parts = [];
  if (Number.isInteger(settings?.maxJobsPerEmployeePerDay)) parts.push(`${settings.maxJobsPerEmployeePerDay} ${settings.maxJobsPerEmployeePerDay === 1 ? 'job' : 'jobs'}`);
  if (typeof settings?.maxHoursPerEmployeePerDay === 'number') parts.push(`${settings.maxHoursPerEmployeePerDay} hours`);
  return parts.join(' or ');
}

/** Crew a job needs: crewNeeded, else the legacy requiredCrewSize, else one. */
export const crewNeededOf = job => job?.crewNeeded || job?.requiredCrewSize || 1;
export const PICKUP_STATES = Object.freeze(['scheduled', 'confirmed', 'crew_assigned']);
/** Whether crew can really pick up a seat on this job: an operational job (not
 * a walkthrough or block) with shift pickup on, no assignment segments (pickup
 * edits the job-level crew), a pickup status, valid times and fewer than
 * crewNeededOf(job) employees. dispatch-service.js saves exactly this as
 * `openShift`, and only such a job is exempt from the crew_size_short and
 * skill_missing blocks. `interval` defaults to the job's own schedule interval. */
export function offeredForPickup(job, crewCount, interval) {
  return job?.type === 'job' && job.shiftPickupEnabled === true && !segmented(job) && crewCount < crewNeededOf(job)
    && PICKUP_STATES.includes(job.pipelineStatus || job.status || 'unscheduled') && Boolean(interval === undefined ? scheduleInterval(job) : interval);
}

export function crewSizeShort(job, crewCount, settings = DISPATCH_SETTINGS_DEFAULTS) {
  const needed = crewNeededOf(job);
  if (crewCount >= needed) return null;
  return { code: 'crew_size_short', jobId: job.id, message: `Requires ${needed} crew members; ${crewCount} assigned.`, ...(settings.blockCrewShort && !offeredForPickup(job, crewCount) ? { blocking: true } : {}) };
}

export function skillMissing(job, rows, { crew, roster, settings = DISPATCH_SETTINGS_DEFAULTS }) {
  const required = requiredSkillsOf(job), out = [];
  if (!required.length) return out;
  // Like crew_size_short and crew claims: a seat offered for pickup may still go
  // to a qualified claimer. A segmented job is never offered, so its rows block.
  const blocks = (row, ids) => settings.blockSkillMissing && !(!row.segmentId && offeredForPickup(job, ids.length));
  for (const row of rows) {
    const ids = crew(row);
    if (!ids.length) continue;
    const missing = missingSkills(ids, roster, required);
    if (!missing.length) continue;
    const unverified = ids.some(id => !skillLevels(roster.find(person => person.id === id)));
    out.push({ code: 'skill_missing', jobId: job.id, message: `${unverified ? 'Employee skills are not fully recorded. ' : ''}No assigned employee is qualified for ${missing.map(skillLabel).join(', ')}.`, missingSkills: missing, ...(unverified ? { unverified: true } : {}), ...(row.segmentId ? { segmentId: row.segmentId } : {}), ...(blocks(row, ids) ? { blocking: true } : {}) });
  }
  return out;
}

export function outsideWorkingHours(job, rows, { crew, interval = scheduleInterval, roster, settings = DISPATCH_SETTINGS_DEFAULTS }) {
  const out = [], seen = new Set();
  for (const row of rows) {
    const recorded = crew(row).filter(id => isObject(roster.find(person => person.id === id)?.weeklyAvailability));
    if (recorded.length) for (const piece of dayPieces(row, interval(row))) for (const id of recorded) {
    const windows = workingWindows(roster.find(person => person.id === id), piece.date);
    if (!windows || windows.some(window => window.start <= piece.start && piece.end <= window.end) || seen.has(`${id}|${piece.date}`)) continue;
    seen.add(`${id}|${piece.date}`);
    const day = DAY_NAMES[WEEKDAYS.indexOf(weekdayOf(piece.date))];
    out.push({ code: 'outside_working_hours', jobId: job.id, employeeId: id, date: piece.date, message: `${nameOf(roster, id)} ${windows.length ? 'is not scheduled to work' : 'does not work on'} ${day}${windows.length ? ` ${clock(piece.start)} – ${clock(piece.end)}` : 's'} (${piece.date}).`,
      ...(row.segmentId ? { segmentId: row.segmentId } : {}), ...(settings.blockOutsideHours ? { blocking: true } : {}) });
    }
  }
  return out;
}

/** `index` is capacityIndex() over every active row; this job's own saved rows
 * in it are replaced by `rows`, so an edit is counted once at its new times. */
export function employeeDailyCapacity(job, rows, { crew, interval = scheduleInterval, roster, settings = DISPATCH_SETTINGS_DEFAULTS, index }) {
  if (job.type === 'blocked' || !capacityLimitText(settings)) return [];
  const own = capacityIndex(rows, crew, interval), out = [];
  for (const [key, mine] of own) {
    const [id, date] = key.split('|'), others = [...(index?.get(key) || new Map())].filter(([jobId]) => jobId !== job.id);
    const jobCount = others.length + 1, scheduled = others.reduce((sum, [, used]) => sum + used, 0) + [...mine.values()].reduce((sum, used) => sum + used, 0);
    if (!capacityExceeded(settings, jobCount, scheduled)) continue;
    out.push({ code: 'employee_daily_capacity', jobId: job.id, employeeId: id, date, jobCount, scheduledHours: round(scheduled / 60), maxJobsPerEmployeePerDay: settings.maxJobsPerEmployeePerDay, maxHoursPerEmployeePerDay: settings.maxHoursPerEmployeePerDay,
      message: `${nameOf(roster, id)} would have ${jobCount} ${jobCount === 1 ? 'job' : 'jobs'} (${round(scheduled / 60)} hours) on ${date}; the daily limit is ${capacityLimitText(settings)}.`, ...(settings.blockOverCapacity ? { blocking: true } : {}) });
  }
  return out;
}

/** Every rule warning for one job except crew_size_short (built with the crew
 * count by the caller). `enforce(warning)` decides whether a blocking setting
 * applies to this change; a warning it rejects keeps no blocking flag. */
export const enforced = (warning, enforce = () => true) => warning?.blocking && !enforce(warning) ? (({ blocking, ...rest }) => rest)(warning) : warning;
export function ruleWarnings(job, rows, context) {
  return [...skillMissing(job, rows, context), ...employeeDailyCapacity(job, rows, context), ...outsideWorkingHours(job, rows, context)].map(warning => enforced(warning, context.enforce));
}
