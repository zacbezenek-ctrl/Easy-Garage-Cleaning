import { assignmentKey } from './job-assignment.js';
import { scheduleInterval, occupiedDays, overlaps } from './dispatch-time.js';
import { scheduleDayEntry } from './dispatch-conflicts.js';

/** Assignment segments (P1-DS-08): the optional job field
 * assignmentSegments:[{id,date,time,endDate,endTime,assignedCrew,crewLead,crewId,vehicleId,notes}]
 * splits one job into per-crew and per-day work windows. The job's own
 * date/time/endDate/endTime is their hull and its assignedCrew their union, so
 * older readers and crew access keep working unchanged. A job without segments
 * is exactly one implicit segment: the job itself. Nothing is backfilled.
 * EGC_DISPATCH_SEGMENTS gates writes only; saved segments are always honoured.
 * dispatch-conflicts.js imports from this module and this module only calls
 * scheduleDayEntry at run time, so the import cycle is evaluation-safe. */
export const SEGMENT_LIMIT = 31;
export const SEGMENT_KEYS = Object.freeze(['id','date','time','endDate','endTime','assignedCrew','crewLead','crewId','vehicleId','notes']);
/** Job-level fields derived from segments; a save cannot also set them. */
export const SEGMENT_HULL_KEYS = Object.freeze(['date','time','endDate','endTime','assignedCrew','crewLead','crewId','vehicleId']);
// Job IDs are at most 180 characters, so `${jobId}~${segmentId}` stays within
// the 200-character lock-entry limit that operations-adoption validates.
const SEGMENT_ID = /^[A-Za-z0-9_-]{1,19}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(secure_|_egc_)/.test(id);
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });

export function segmentsEnabled(env) { return String(env?.EGC_DISPATCH_SEGMENTS ?? '').trim().toLowerCase() === 'true'; }
export function segmented(job) { return Array.isArray(job?.assignmentSegments) && job.assignmentSegments.length > 0; }
export function segmentLockId(jobId, segmentId) { return `${jobId}~${segmentId}`; }
/** Job IDs never contain '~', so a lock entry belongs to the job before it. */
export function lockEntryOwner(entry) { return String(entry?.id ?? '').split('~')[0]; }
export function ownsLockEntry(entry, jobId) { return lockEntryOwner(entry) === jobId; }

/** Schedule rows for conflict checks. A legacy job returns [job] (the same
 * object). Each segment row keeps the job's identity (id, type, status,
 * address, buffers) with the segment's window, crew and vehicle. A malformed
 * saved segment cannot prove free capacity, so it yields the hull and union. */
export function jobSegments(job) {
  if (!segmented(job)) return [job];
  const rows = job.assignmentSegments.map(segment => {
    if (!isObject(segment) || typeof segment.id !== 'string' || !SEGMENT_ID.test(segment.id) || !Array.isArray(segment.assignedCrew) || segment.assignedCrew.some(value => typeof value !== 'string')) return null;
    const row = { ...job, assignmentSegments: null, segmentId: segment.id,
      date: segment.date || '', time: segment.time || '', endDate: segment.endDate || segment.date || '', endTime: segment.endTime || '',
      assignedCrew: [...segment.assignedCrew], assignedTo: segment.assignedCrew.join(', '), crewLead: segment.crewLead || null,
      crewId: segment.crewId || null, vehicleId: segment.vehicleId || null, segmentNotes: typeof segment.notes === 'string' ? segment.notes : '' };
    const interval = scheduleInterval(row);
    return { ...row, startAt: interval?.startAt || null, endAt: interval?.endAt || null };
  });
  return rows.some(row => !row) || new Set(rows.map(row => row.segmentId)).size !== rows.length ? [{ ...job, assignmentSegments: null, segmentId: null }] : rows;
}

/** A saved list that fails validation is honoured as the hull and union; the
 * editor must then clear it together with job-level times and crew. */
export function segmentsInvalid(job) { return segmented(job) && !jobSegments(job)[0].segmentId; }

/** Denver days that hold capacity: the union of each segment's days, so a split
 * job reserves nothing on a day between its segments. */
export function segmentDays(job) {
  if (!segmented(job)) return occupiedDays(job);
  return [...new Set(jobSegments(job).flatMap(row => occupiedDays(row)))].sort();
}

/** Day-lock entries for one date. A legacy job keeps its single entry keyed by
 * the job ID; each segment on the date gets `${jobId}~${segmentId}`. */
export function segmentLockEntries(job, date, roster = [], now = new Date().toISOString()) {
  if (!segmented(job)) return [scheduleDayEntry(job, date, roster, now)];
  return jobSegments(job).filter(row => occupiedDays(row).includes(date)).map(row => row.segmentId ? { ...scheduleDayEntry(row, date, roster, now), id: segmentLockId(job.id, row.segmentId), jobId: job.id, segmentId: row.segmentId } : scheduleDayEntry(row, date, roster, now));
}

/** Allowlisted segment fields for DTOs; never spreads a stored segment. */
export function projectSegments(job) {
  if (!segmented(job)) return [];
  return jobSegments(job).filter(row => row.segmentId).map(row => ({ id: row.segmentId, date: row.date, time: row.time, endDate: row.endDate, endTime: row.endTime,
    startAt: row.startAt, endAt: row.endAt, assignedCrew: row.assignedCrew, crewLead: row.crewLead, crewId: row.crewId, vehicleId: row.vehicleId, notes: row.segmentNotes }));
}

function text(value, label, max) {
  if (typeof value !== 'string' || value.length > max) throw fail('dispatch_segments_invalid', `Segment ${label} must be text of at most ${max} characters.`);
  return value.trim();
}
function crewMembers(values, roster, label) {
  if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string')) throw fail('dispatch_crew_invalid', `${label}: choose up to 20 active employees.`);
  const resolved = values.map(value => roster.find(person => person.id === assignmentKey(value))?.id || null);
  if (resolved.some(value => !value)) throw fail('dispatch_employee_inactive', `${label}: an assigned employee is no longer active or could not be verified. Refresh the employee list.`);
  if (new Set(resolved).size !== resolved.length) throw fail('dispatch_crew_duplicate', `${label}: each employee can only be assigned once.`);
  return resolved;
}

/** The hull is the earliest segment start and latest end; crew is the union
 * in segment order; the lead is the earliest segment's lead; a crew or vehicle
 * label is kept only when every segment shares it. */
export function segmentHull(segments) {
  const timed = segments.map(segment => ({ segment, interval: scheduleInterval(segment) }));
  const first = timed.reduce((a, b) => b.interval.start < a.interval.start ? b : a), last = timed.reduce((a, b) => b.interval.end > a.interval.end ? b : a);
  const assignedCrew = [...new Set(segments.flatMap(segment => segment.assignedCrew))];
  const common = key => segments.every(segment => segment[key] && segment[key] === segments[0][key]) ? segments[0][key] : null;
  return { date: first.segment.date, time: first.segment.time, endDate: last.segment.endDate, endTime: last.segment.endTime, assignedCrew, assignedTo: assignedCrew.join(', '),
    crewLead: segments.find(segment => segment.crewLead)?.crewLead || null, crewId: common('crewId'), vehicleId: common('vehicleId') };
}

/** Validates a complete replacement list. [] clears the segments (returns
 * null). Segments of one job may run in parallel only with different people
 * and vehicles; the same employee or vehicle twice at once is a 409 conflict. */
export function validateSegments(value, { roster = [], resources = [] } = {}) {
  if (!Array.isArray(value) || value.length > SEGMENT_LIMIT) throw fail('dispatch_segments_invalid', `A job can have at most ${SEGMENT_LIMIT} assignment segments.`);
  if (!value.length) return null;
  const ids = new Set();
  const segments = value.map((segment, index) => {
    const label = `Segment ${index + 1}`;
    if (!isObject(segment) || Object.keys(segment).some(key => !SEGMENT_KEYS.includes(key))) throw fail('dispatch_segments_invalid', `${label} contains unsupported fields. Refresh the dispatch form and try again.`);
    if (typeof segment.id !== 'string' || !SEGMENT_ID.test(segment.id) || ids.has(segment.id)) throw fail('dispatch_segments_invalid', `${label} needs a unique ID of 1-19 letters, numbers, dashes or underscores.`);
    ids.add(segment.id);
    const date = text(segment.date, 'date', 10), time = text(segment.time, 'start time', 10), endTime = text(segment.endTime, 'end time', 10);
    const endDate = segment.endDate === undefined || segment.endDate === '' ? date : text(segment.endDate, 'end date', 10);
    if (!scheduleInterval({ date, time, endDate, endTime })) throw fail('dispatch_time_invalid', `${label} needs valid Denver start and end times within 31 days. Missing or repeated DST hours cannot be scheduled.`, 400, { segmentId: segment.id });
    let crew = null;
    if (segment.crewId !== undefined && segment.crewId !== null && segment.crewId !== '') {
      crew = safeId(segment.crewId) ? resources.find(row => row.recordType === 'crew' && row.id === segment.crewId && row.status === 'active') : null;
      if (!crew) throw fail('dispatch_crew_inactive', `${label}: choose an active crew.`);
    }
    const assignedCrew = 'assignedCrew' in segment ? crewMembers(segment.assignedCrew, roster, label) : crew ? crewMembers(crew.memberIds || [], roster, label) : [];
    const leadInput = 'crewLead' in segment ? segment.crewLead : crew?.leadId || null;
    const crewLead = leadInput ? roster.find(person => person.id === assignmentKey(leadInput))?.id || null : null;
    if (leadInput && !crewLead) throw fail('dispatch_employee_inactive', `${label}: choose an active employee as crew lead.`);
    if (crewLead && !assignedCrew.includes(crewLead)) throw fail('dispatch_lead_not_assigned', `${label}: the crew lead must be one of its assigned employees.`);
    const vehicleId = segment.vehicleId === undefined || segment.vehicleId === null || segment.vehicleId === '' ? null : segment.vehicleId;
    if (vehicleId !== null && (!safeId(vehicleId) || !resources.some(row => row.recordType === 'vehicle' && row.id === vehicleId && row.status === 'available'))) throw fail('dispatch_vehicle_unavailable', `${label}: this vehicle is unavailable. Choose an available vehicle or remove it.`);
    const notes = segment.notes === undefined || segment.notes === null ? '' : text(segment.notes, 'notes', 2000);
    return { id: segment.id, date, time, endDate, endTime, assignedCrew, crewLead, crewId: crew?.id || null, vehicleId, notes };
  });
  segments.sort((a, b) => scheduleInterval(a).start - scheduleInterval(b).start || scheduleInterval(a).end - scheduleInterval(b).end || a.id.localeCompare(b.id));
  const conflicts = [];
  segments.forEach((left, index) => {
    for (const right of segments.slice(index + 1)) {
      if (!overlaps(scheduleInterval(left), scheduleInterval(right))) continue;
      const employeeIds = left.assignedCrew.filter(id => right.assignedCrew.includes(id)), vehicle = left.vehicleId && left.vehicleId === right.vehicleId;
      if (employeeIds.length || vehicle) conflicts.push({ code: 'segment_overlap', segmentId: left.id, otherSegmentId: right.id, employeeIds, vehicleId: vehicle ? left.vehicleId : null, message: 'Two segments of this job overlap with the same employee or vehicle.' });
    }
  });
  if (conflicts.length) throw fail('dispatch_conflict', 'Two segments of this job use the same employee or vehicle at the same time. Change a segment time, crew, or vehicle.', 409, { conflicts });
  const hull = segmentHull(segments);
  if (!scheduleInterval(hull)) throw fail('dispatch_segments_span_invalid', 'All segments of one job must fall within 31 days.');
  return { segments, hull };
}
