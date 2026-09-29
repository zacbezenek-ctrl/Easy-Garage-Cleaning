import { assignmentKey } from './job-assignment.js';
import { segmented, jobSegments, segmentDays } from './dispatch-segments.js';
import { addDays, denverToday, occupiedDays, validDate } from './dispatch-time.js';
import { advanceFieldTime, fieldJobTime } from './field-execution-time.js';
import { fieldCommand, fieldFailure, fieldStage, fieldText } from './field-execution.js';

/** Multi-day visits (FIELD-MULTIDAY). With FIELD_MULTIDAY_VISITS=true a job
 * keeps one visit per Denver day in the optional map
 * fieldExecution.visits[YYYY-MM-DD] = {status, startedAt, startedBy, endedAt,
 * endedBy, endedByName, notes, requestId, endedLate?, reopenedAt?, reopenedBy?,
 * closures?}. The first field status action of a day starts that day's visit,
 * 'end_day' closes it with notes and stops the job clock, and 'complete' closes
 * the final day. 'end_day' names the Denver day it ends (visitDate, from the
 * snapshot the page showed; today when absent), so an end of day saved offline
 * that syncs after midnight closes the day it was written for, never the new
 * day. A multi-day job completes only on its final scheduled day unless a
 * manager gives a reason. A job without the map simply has no recorded visits:
 * nothing is backfilled and older readers ignore it. Off, the field workflow
 * behaves exactly as before. */
export const VISIT_STATUSES = Object.freeze(['in_progress', 'ended', 'completed']);
export const VISIT_LIMIT = 62, CLOSURE_LIMIT = 3;
const ACTIVE = ['dispatched', 'arrived', 'in_progress'], CLOSED = ['completed', 'invoiced', 'paid', 'review_requested', 'cancelled'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const visitsOf = job => record(job.fieldExecution?.visits) ? job.fieldExecution.visits : {};
const readable = visit => record(visit) && VISIT_STATUSES.includes(visit.status) ? visit : null;
const instantText = value => typeof value === 'string' && value.length <= 40 ? value : null;
const closuresOf = visit => Array.isArray(visit?.closures) ? visit.closures.filter(record).slice(-CLOSURE_LIMIT) : [];
// Reopening or completing a visit that already ended keeps that end of day in
// a short list (the full notes also stay in the job history) instead of
// overwriting it or leaving it on the reopened visit.
function archived(visit) {
  if (!visit?.endedAt) return visit;
  const { endedAt, endedBy, endedByName, notes, requestId, endedLate, ...rest } = visit;
  return { ...rest, closures: [...closuresOf(visit), { endedAt, endedBy: endedBy ?? null, endedByName: endedByName ?? null, notes: fieldText(notes, 1000), requestId: requestId ?? null }].slice(-CLOSURE_LIMIT) };
}

export const fieldVisitsEnabled = env => env?.FIELD_MULTIDAY_VISITS === 'true';

/** Denver days the job is scheduled on: the union of its segments' days for a
 * split job, the job's own days otherwise. A job whose times cannot be read
 * falls back to its wall dates (at most 31 days). */
export function fieldJobDays(job) {
  const days = segmentDays(job);
  if (days.length || !validDate(job?.date)) return days;
  const end = validDate(job.endDate) && job.endDate > job.date ? job.endDate : job.date, dates = [];
  for (let day = job.date; day && day <= end && dates.length < 31; day = addDays(day, 1)) dates.push(day);
  return dates;
}

// A crew viewer of a split job has their own segments' days; a malformed
// segment list (the hull row) counts as job-level for everyone on the job.
function viewerDays(job, viewer) {
  if (!segmented(job)) return fieldJobDays(job);
  const key = assignmentKey(viewer);
  return [...new Set(jobSegments(job).filter(row => !row.segmentId || key && row.assignedCrew.some(id => assignmentKey(id) === key)).flatMap(row => occupiedDays(row)))].sort();
}

/** Whether the signed-in employee works this job on a Denver day. A split job
 * uses that day's segments (the shape dispatch saves in assignmentSegments),
 * matched on the exact username like the crew segment view. A job without
 * per-day assignments falls back to its job-level crew on every day, so
 * legacy work is never locked by the calendar. The job-level assignment that
 * authorizes reading the job is always required too. */
export async function assignedOn(job, date, access) {
  if (!job || !validDate(date) || !access || !await access.assigned(job)) return false;
  if (!segmented(job)) return true;
  return jobSegments(job).some(row => (!row.segmentId || row.assignedCrew.some(id => access.exactly(id))) && occupiedDays(row).includes(date));
}

/** Day listings: the job appears when the employee works it on any listed day. */
export async function assignedDuring(job, start, end, access) {
  for (let day = start; validDate(day) && day <= end; day = addDays(day, 1)) if (await assignedOn(job, day, access)) return true;
  return false;
}

// A job clock segment still running from an earlier Denver day means a day was
// never ended, or its end reached the server after midnight: the overnight
// time is counted, so the clock is flagged for manager review. Only multi-day
// jobs are checked, except for a late end of day, which is always flagged.
function reviewOvernight(job, result, today, now, late = false) {
  const current = job.fieldExecution?.jobTime?.current, clock = result.patch.fieldExecution?.jobTime;
  if (!current || !record(clock) || !fieldJobTime(job, now).recorded || denverToday(new Date(current.startedAt)) >= today || !late && fieldJobDays(job).length < 2) return result;
  result.patch.fieldExecution = { ...result.patch.fieldExecution, jobTime: { ...clock, needsReview: true } };
  result.event.timeSegment = { ...result.event.timeSegment, warning: late ? 'This end of day was saved before Denver midnight and synced after it; the time up to the sync needs review.' : 'The job clock ran past Denver midnight without an end of day; the overnight time needs review.' };
  return result;
}

/** fieldCommand plus per-day visits. The caller has already confirmed that a
 * crew actor works the job today, or for 'end_day' on the visit day it names
 * (assignedOn). */
export function fieldVisitCommand(job, actor, input, now = new Date().toISOString()) {
  const today = denverToday(new Date(now)), state = job.fieldExecution || {}, visits = visitsOf(job), visit = readable(visits[today]);
  const actorId = actor.user, actorName = actor.displayName || actor.user, room = date => Boolean(readable(visits[date])) || Object.keys(visits).length < VISIT_LIMIT, stage = fieldStage(job);
  if (input.action === 'end_day') {
    const date = input.visitDate === undefined ? today : input.visitDate, late = date !== today;
    if (!validDate(date) || date > today) throw fieldFailure('Choose the visit day you are ending. Refresh the job and retry.');
    if (CLOSED.includes(stage)) throw fieldFailure('This job is closed. Its execution record cannot be changed.', 409, 'FIELD_JOB_CLOSED');
    if (!ACTIVE.includes(stage)) throw fieldFailure('Mark this job en route or arrived before ending the day.', 409, 'FIELD_VISIT_NOT_STARTED');
    // An end of day saved offline can reach the server after midnight; it is
    // accepted for the previous day only. Older days need operations.
    if (date < addDays(today, -1)) throw fieldFailure(`This end of day was saved for ${date} and can no longer be recorded from a phone. Send its notes to operations.`, 409, 'FIELD_VISIT_DAY_CHANGED');
    const target = readable(visits[date]);
    if (target && target.status !== 'in_progress') throw fieldFailure(late ? `The ${date} visit has already ended.` : 'Today’s visit has already ended. Start today’s work again to reopen it.', 409, 'FIELD_VISIT_ENDED');
    if (typeof input.notes !== 'string' || input.notes.trim().length < 10 || input.notes.length > 4000) throw fieldFailure('Describe today’s work and what remains in 10–4,000 characters.');
    if (!room(date)) throw fieldFailure(`This job already has ${VISIT_LIMIT} recorded visit days. Ask operations to review its schedule.`, 409, 'FIELD_VISIT_LIMIT');
    // A late end of day stops the clock (and ends the job's day) only while
    // today's visit has not started; once it has, the clock is today's work.
    const notes = input.notes.trim(), stop = !late || !visit, time = stop ? advanceFieldTime(job, null, actor, input.requestId, now) : { clock: null, segment: null };
    const ended = { ...(target || { startedAt: null, startedBy: null }), status: 'ended', endedAt: now, endedBy: actorId, endedByName: actorName, notes, requestId: input.requestId, ...(late ? { endedLate: true } : {}) };
    const fieldExecution = { ...state, ...(stop ? { activity: 'day_ended', activityAt: now, activityBy: actorId, activityReason: fieldText(notes, 1000) } : {}), visits: { ...visits, [date]: ended }, ...(time.clock ? { jobTime: time.clock } : {}) };
    const event = { id: input.requestId, action: 'end_day', actorId, actorName, createdAt: now, state: 'applied', visibility: 'crew', summary: late ? `Day ended (${date}, synced late)` : 'Day ended', body: notes, visitDate: date, ...(time.segment ? { timeSegment: time.segment } : {}) };
    return reviewOvernight(job, { patch: { fieldExecution, updatedAt: now, fieldLastActionAt: now }, event }, today, now, late && stop);
  }
  let early = null;
  if (input.action === 'complete') {
    const days = fieldJobDays(job), finalDay = days.at(-1);
    if (days.length > 1 && today < finalDay) {
      if (!actor.manager) throw fieldFailure(`This job is scheduled through ${finalDay}. End today’s visit instead; completion opens on the final day.`, 409, 'FIELD_COMPLETION_NOT_FINAL_DAY');
      if (typeof input.earlyCompletionReason !== 'string' || input.earlyCompletionReason.trim().length < 10 || input.earlyCompletionReason.length > 1000) throw fieldFailure('Give a reason of 10–1,000 characters for completing before the final scheduled day.', 400, 'FIELD_EARLY_COMPLETION_REASON_REQUIRED');
      early = { reason: input.earlyCompletionReason.trim(), finalDay, approvedBy: actorId, approvedByName: actorName, at: now };
    }
  }
  const result = fieldCommand(job, actor, input, now), base = result.patch.fieldExecution || state;
  if (input.action === 'status') {
    const next = !visit ? room(today) && { status: 'in_progress', startedAt: now, startedBy: actorId } : visit.status === 'ended' ? { ...archived(visit), status: 'in_progress', reopenedAt: now, reopenedBy: actorId } : null;
    if (next) { result.patch.fieldExecution = { ...base, visits: { ...visits, [today]: next } }; result.event.visitDate = today; }
  } else if (input.action === 'complete') {
    const completed = { ...(archived(visit) || { startedAt: null, startedBy: null }), status: 'completed', endedAt: now, endedBy: actorId, endedByName: actorName, notes: base.completion.notes, requestId: input.requestId };
    result.patch.fieldExecution = { ...base, visits: { ...visits, [today]: completed }, ...(early ? { completion: { ...base.completion, earlyCompletion: early } } : {}) };
    result.event.visitDate = today;
    if (early) {
      result.event.summary = `${result.event.summary} before the final scheduled day`; result.event.earlyCompletionReason = early.reason;
      result.patch.fieldCompletionSync = { ...result.patch.fieldCompletionSync, body: `${result.patch.fieldCompletionSync.body}\nCompleted before the final scheduled day (${early.finalDay}) by ${actorName}: ${early.reason}` };
    }
  }
  return ['status', 'complete'].includes(input.action) ? reviewOvernight(job, result, today, now) : result;
}

/** The visits block of the crew job DTO (an allowlist). Crew on a split job
 * see the days of their own segments plus any day with a recorded visit. */
export function fieldVisitProjection(job, { today, manager = false, viewer = '', assignedToday = false } = {}) {
  const stage = fieldStage(job), days = fieldJobDays(job), finalDay = days.at(-1) || '', multiDay = days.length > 1, visits = visitsOf(job);
  const scheduled = manager ? days : viewerDays(job, viewer), working = manager || assignedToday === true;
  const dates = [...new Set([...scheduled, ...Object.keys(visits).filter(date => validDate(date) && readable(visits[date]))])].sort().slice(-VISIT_LIMIT);
  const entries = dates.map(date => {
    const visit = readable(visits[date]);
    return { date, scheduled: scheduled.includes(date), status: visit?.status || 'not_started', startedAt: instantText(visit?.startedAt), endedAt: instantText(visit?.endedAt), endedBy: fieldText(visit?.endedByName || visit?.endedBy, 200), notes: fieldText(visit?.notes, 4000),
      endedLate: visit?.endedLate === true, reopenedAt: instantText(visit?.reopenedAt), earlierEnds: closuresOf(visit).map(end => ({ endedAt: instantText(end.endedAt), endedBy: fieldText(end.endedByName || end.endedBy, 200), notes: fieldText(end.notes, 1000) })) };
  });
  const beforeFinal = multiDay && today < finalDay, todayVisit = readable(visits[today]);
  return { today, finalDay, multiDay, assignedToday: working, days: entries,
    canEndDay: working && ACTIVE.includes(stage) && todayVisit?.status !== 'ended' && (Boolean(todayVisit) || Object.keys(visits).length < VISIT_LIMIT),
    completionOpen: !beforeFinal, earlyCompletionReasonRequired: beforeFinal && manager };
}
