import { weekdayOf } from './dispatch-rules.js';
import { validDate, scheduleInterval } from './dispatch-time.js';
import { segmented, segmentDays } from './dispatch-segments.js';

/** Crew registry v2 and server crew auto-assign (owner decisions D2-D4, 2026-10-17).
 * A crew record (dispatchResources, recordType 'crew') may carry priority (whole
 * number 1..99, lower is asked first), serviceDays (the weekdays it works, a subset
 * of mon..sun) and code (a stable handle such as 'crew-1'). A legacy crew has none
 * of them and reads as priority 99 on every day, so it keeps working unchanged.
 * A crew is eligible for a dated job when it is active, has at least one member,
 * every member is on the active roster and it serves every Denver date the job
 * occupies. Eligible crews are tried by priority, then name (then id): the first
 * crew whose every member is free for the whole requested window takes the job.
 * Weekend means Saturday and Sunday; work never spills between weekday and weekend
 * crews unless a crew's serviceDays say so. The server picks inside the dispatch
 * guard (dispatch-service.js executeDispatch, options.autoCrew; the operations
 * scheduler and adoption under their own day locks); openings and browsers only
 * suggest. Pure: no reads, no clock. */
export const CREW_DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const WEEKEND_DAYS = Object.freeze(['sat', 'sun']);
export const CREW_PRIORITY_DEFAULT = 99;
/** Visit types a crew is auto-assigned to; walkthroughs belong to estimators. */
export const AUTO_CREW_TYPES = Object.freeze(['job', 'cleanout', 'reorg']);
const CODE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;
const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** What the owner/manager action crew.seed_defaults creates when no crew holds the code yet; members are added afterwards. */
export const DEFAULT_CREWS = Object.freeze([
  Object.freeze({ code: 'crew-1', name: 'Crew 1', priority: 1, serviceDays: WEEKDAYS }),
  Object.freeze({ code: 'crew-2', name: 'Crew 2', priority: 2, serviceDays: WEEKDAYS }),
  Object.freeze({ code: 'crew-3', name: 'Crew 3', priority: 3, serviceDays: WEEKEND_DAYS }),
]);

/** Exactly "true" (EGC_DISPATCH_CREW_AUTO_ASSIGN) lets the server staff a dated job with the
 * first free eligible crew. Anything else: saves, receipts and responses are as before. */
export const crewAutoAssignEnabled = env => env?.EGC_DISPATCH_CREW_AUTO_ASSIGN === 'true';

export const crewPriority = crew => Number.isInteger(crew?.priority) && crew.priority >= 1 && crew.priority <= 99 ? crew.priority : CREW_PRIORITY_DEFAULT;
/** The days a crew works in week order; a crew without a readable list works every day. */
export function crewServiceDays(crew) {
  const days = Array.isArray(crew?.serviceDays) ? CREW_DAYS.filter(day => crew.serviceDays.includes(day)) : [];
  return days.length ? days : [...CREW_DAYS];
}
export const crewCode = crew => typeof crew?.code === 'string' && CODE.test(crew.code) ? crew.code : null;
/** A crew that works only Saturday and/or Sunday. */
export const weekendCrew = crew => crewServiceDays(crew).every(day => WEEKEND_DAYS.includes(day));

/** crew.save input checks: the canonical value, or null when invalid. */
export function serviceDaysInput(value) {
  if (!Array.isArray(value) || !value.length || value.length > CREW_DAYS.length || value.some(day => !CREW_DAYS.includes(day)) || new Set(value).size !== value.length) return null;
  return CREW_DAYS.filter(day => value.includes(day));
}
export const crewCodeInput = value => typeof value === 'string' && CODE.test(value) ? value : null;

export const compareCrews = (a, b) => crewPriority(a) - crewPriority(b) || String(a?.name || '').localeCompare(String(b?.name || '')) || String(a?.id || '').localeCompare(String(b?.id || ''));
export const sortCrews = crews => [...(Array.isArray(crews) ? crews : [])].sort(compareCrews);

/** True when the crew works every one of these Denver dates. */
export function crewServes(crew, dates) {
  const list = Array.isArray(dates) ? dates : [dates], days = crewServiceDays(crew);
  return list.length > 0 && list.every(date => validDate(date) && days.includes(weekdayOf(date)));
}

/** An active crew with members, all of them on the active roster (when a roster is given). */
export function staffableCrew(crew, roster = null) {
  return crew?.recordType === 'crew' && crew.status === 'active' && Array.isArray(crew.memberIds) && crew.memberIds.length > 0
    && crew.memberIds.every(id => typeof id === 'string' && (!roster || roster.some(person => person.id === id)));
}

/** Active crews with members that work every date, in pick order. With a roster, a crew
 * whose members are not all active is left out (its snapshot could not be saved). */
export function eligibleCrews(resources, dates, roster = null) {
  const list = Array.isArray(dates) ? dates : [dates];
  if (!list.length || list.some(date => !validDate(date))) return [];
  return sortCrews((Array.isArray(resources) ? resources : []).filter(row => staffableCrew(row, roster) && crewServes(row, list)));
}

/** The first crew `fits` accepts (crews already in pick order), else null. */
export function pickCrew(crews, fits) {
  for (const crew of Array.isArray(crews) ? crews : []) if (fits(crew)) return crew;
  return null;
}

/** Pick order with an optional preferred crew (a booker's eligible choice, or the crew an
 * auto-assigned job already has) tried first; the preferred crew must itself be eligible. */
export function crewPickOrder(crews, preferredId = null) {
  const list = Array.isArray(crews) ? crews : [], preferred = preferredId ? list.find(crew => crew.id === preferredId) : null;
  return preferred ? [preferred, ...list.filter(crew => crew !== preferred)] : [...list];
}

/** A visit the server may staff: an operational job/cleanout/reorg on one
 * job-level schedule (never split segments) with valid Denver times. */
export const autoCrewJob = job => AUTO_CREW_TYPES.includes(job?.type) && !job.recordType && !segmented(job) && Boolean(scheduleInterval(job));
/** The Denver dates the visit occupies. */
export const crewJobDates = job => segmentDays(job);

/** The job fields a crew assignment sets: the crew's membership snapshot and lead.
 * `members` (dispatch-service.js) canonicalises ids against the roster when given. */
export function crewAssignment(crew, members = ids => [...ids]) {
  const assignedCrew = members(crew.memberIds);
  return { crewId: crew.id, assignedCrew, assignedTo: assignedCrew.join(', '), crewLead: crew.leadId && assignedCrew.includes(crew.leadId) ? crew.leadId : null };
}
/** No crew: what an auto-assigned job that lost its crew is saved with. */
export const NO_CREW = Object.freeze({ crewId: null, assignedCrew: [], assignedTo: '', crewLead: null });

/** The record saved on the job (crewAutoAssigned) and in its receipt. */
export function crewAutoRecord(crew, { at, by, mode = 'pick' } = {}) {
  return { crewId: crew.id, crewName: String(crew.name || '').slice(0, 100), crewCode: crewCode(crew), priority: crewPriority(crew), mode, at: at || null, by: by || null };
}
/** True when the job's crew is the one the server assigned (not a manager's hand pick). */
export const autoAssignedCrew = job => isObject(job?.crewAutoAssigned) && typeof job.crewAutoAssigned.crewId === 'string' && job.crewAutoAssigned.crewId === job.crewId;

/** Rep-safe projection of crew-mode openings (dispatch-openings.js candidates) for Knock,
 * the estimator gameplan and other non-dispatcher screens: no roster, no employee ids, no
 * customer data. => [{date,time,endTime,crewId,crewLabel,priority}] in the result's order. */
export function projectCrewOpenings(result, limit = Infinity) {
  const rows = Array.isArray(result?.candidates) ? result.candidates : Array.isArray(result) ? result : [];
  return rows.filter(row => isObject(row) && typeof row.crewId === 'string' && validDate(row.date) && typeof row.time === 'string' && typeof row.endTime === 'string')
    .slice(0, Number.isInteger(limit) && limit >= 0 ? limit : undefined)
    .map(row => ({ date: row.date, time: row.time, endTime: row.endTime, crewId: row.crewId, crewLabel: String(row.crewName || '').slice(0, 100) || 'Crew', priority: Number.isInteger(row.priority) ? row.priority : CREW_PRIORITY_DEFAULT }));
}
