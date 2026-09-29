const fail = (message, status = 400) => Object.assign(new Error(message), { code: 'EMPLOYEE_JOB_TIME_INVALID', status });
const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const date = value.slice(0, 10), calendar = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== date || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) return NaN;
  return Date.parse(value);
};
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const jobId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(?:_egc_|secure_)/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const segments = entry => Array.isArray(entry?.jobTracking?.segments) ? entry.jobTracking.segments : [];
export const activeJobSegment = entry => segments(entry).find(segment => segment && !segment.endedAt) || null;

// EGC_JOB_STATUS_MOVES_TIME: exactly "true" lets the job status a crew member sets move their own shift time (crew/job.js,
// crew/field-outbox.js statusTime) and lets the job's lead move clocked-in crew-mates onto work (applyCrewJobMove).
// Unset: job time moves only when the crew member taps it, as before.
export const jobStatusMovesTime = env => String(env?.EGC_JOB_STATUS_MOVES_TIME || '').trim().toLowerCase() === 'true';
// Clock-in only: a clock-in whose phone found no position (EGC_CLOCK_IN_WITHOUT_FIX) keeps this flag for a manager.
export const NO_CLOCK_IN_FIX = 'location_unavailable_at_clock_in';
// 'shared': the one position taken at clock-in. 'tracked': a shift an older build kept tracking (a trail, or still
// 'tracking'), whose lastLocation is the last watched position rather than the clock-in one.
const clockInLocation = entry => entry?.locationReview === NO_CLOCK_IN_FIX || entry?.locationStatus === NO_CLOCK_IN_FIX ? 'missing' : !entry?.lastLocation ? ''
  : Array.isArray(entry.locationTrail) && entry.locationTrail.length > 1 || entry.locationStatus === 'tracking' ? 'tracked' : 'shared';

/** A switch sent from an older view of the shift (a status-driven move worked out before a lead's crew move reached this
 * phone, say) to the kind and job already running changes nothing, rather than being refused as a changed job. */
export function jobActionSatisfied(entry, action) {
  const current = activeJobSegment(entry);
  return Boolean(current) && current.id !== action?.expectedSegmentId && current.kind === action?.kind && current.jobId === action?.jobId;
}

export function initializeJobTracking(id, session, now) {
  return { version: 1, coverageStartedAt: now, partialHistory: false, segments: [{ id: `clock-in:${id}`, kind: 'general', jobId: '', jobLabel: '', startedAt: now, endedAt: '', actorId: session.user }] };
}

export function applyEmployeeJobAction(entry, action, session, now) {
  if (!entry || !same(entry.employee, session.user)) throw fail('Job time can only be changed on your own active shift.', 403);
  if (!action || !uuid(action.requestId) || !['work', 'travel', 'general'].includes(action.kind) || typeof action.expectedSegmentId !== 'string' || action.expectedSegmentId.length > 250 || (action.kind === 'general' ? action.jobId !== '' : !jobId(action.jobId))) throw fail('Choose a job-time action, a unique request ID, and the current segment.');
  const rows = segments(entry), receipt = rows.find(segment => segment?.id === action.requestId);
  if (receipt) {
    if (receipt.kind !== action.kind || receipt.jobId !== action.jobId || !same(receipt.actorId, session.user)) throw fail('This job-time request ID was already used for different work.', 409);
    return entry;
  }
  if (entry.status !== 'active' || entry.clockOutAt || ['approved', 'pending', 'rejected'].includes(entry.approvalStatus)) throw fail('Clock in before starting or switching job time.', 409);
  if (entry.jobTracking && (entry.jobTracking.version !== 1 || !Array.isArray(entry.jobTracking.segments))) throw fail('Your saved job-time record needs manager review before it can change.', 409);
  if (entry.jobTracking && employeeJobTime(entry, now).needsReview) throw fail('Your saved job-time record needs manager review before it can change.', 409);
  const current = activeJobSegment(entry);
  if ((current?.id || '') !== action.expectedSegmentId) {
    if (jobActionSatisfied(entry, action)) return entry;
    throw fail('Your active job changed. Refresh your shift before switching work.', 409);
  }
  if (rows.length >= 200) throw fail('This shift has reached its job segment limit. Contact operations before adding more segments.', 409);
  const at = instant(now), start = instant(entry.clockInAt);
  if (!Number.isFinite(at) || !Number.isFinite(start) || at < start || current && at < instant(current.startedAt)) throw fail('The shift timing needs manager review.', 409);
  const nextRows = rows.map(segment => segment.endedAt ? segment : { ...segment, endedAt: now, endedBy: session.user, endReason: 'job_switch' });
  nextRows.push({ id: action.requestId, kind: action.kind, jobId: action.jobId, jobLabel: '', startedAt: now, endedAt: '', actorId: session.user });
  const history = [...(Array.isArray(entry.history) ? entry.history : []), { action: 'job_time_switch', actor: session.user, actorName: session.displayName || session.user, at: now, requestId: action.requestId, fromSegmentId: current?.id || null, toSegmentId: action.requestId, jobId: action.jobId, kind: action.kind }];
  return { ...entry, jobTracking: { ...(entry.jobTracking || { version: 1, coverageStartedAt: now, partialHistory: true }), segments: nextRows }, history, updatedAt: now, updatedBy: session.user };
}

export function finishEmployeeJobTime(entry, session, now) {
  if (!activeJobSegment(entry)) return entry;
  return { ...entry, jobTracking: { ...entry.jobTracking, segments: segments(entry).map(segment => !segment || segment.endedAt ? segment : { ...segment, endedAt: now, endedBy: session.user, endReason: 'clock_out' }) } };
}

/** Net job time is an intersection with the actual shift, minus its recorded
 * breaks. A job change never relabels previous segments. Old shift.jobId values
 * are not treated as proof that every paid minute belonged to that job. */
export function employeeJobTime(entry, now = new Date().toISOString()) {
  const shiftStart = instant(entry.clockInAt), shiftEnd = instant(entry.clockOutAt || now), rows = segments(entry);
  const result = { recorded: entry.jobTracking?.version === 1, partialHistory: entry.jobTracking?.partialHistory === true, needsReview: false, asOf: now, jobs: [], generalMs: 0, untrackedMs: 0, totalRecordedMs: 0 };
  if (entry.jobTracking && (entry.jobTracking.version !== 1 || !Array.isArray(entry.jobTracking.segments) || rows.length > 200)) return { ...result, needsReview: true };
  if (entry.breaks !== undefined && !Array.isArray(entry.breaks)) return { ...result, needsReview: true };
  if (!Number.isFinite(shiftStart) || !Number.isFinite(shiftEnd) || shiftEnd < shiftStart || shiftEnd - shiftStart > 31 * 86400000) return { ...result, needsReview: true };
  const breaks = []; let previousBreak = shiftStart;
  for (const item of entry.breaks || []) {
    const start = instant(item?.startAt), end = instant(item?.endAt || entry.clockOutAt || now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start < previousBreak || start < shiftStart || end > shiftEnd || entry.clockOutAt && !item?.endAt) return { ...result, needsReview: true };
    breaks.push({ start, end }); previousBreak = end;
  }
  const net = (start, end) => Math.max(0, end - start - breaks.reduce((total, pause) => total + Math.max(0, Math.min(end, pause.end) - Math.max(start, pause.start)), 0));
  const totalShiftMs = net(shiftStart, shiftEnd);
  if (!result.recorded) return { ...result, untrackedMs: totalShiftMs, partialHistory: true };
  const jobs = new Map(), used = new Set(); let previousEnd = shiftStart;
  for (let index = 0; index < rows.length; index++) {
    const segment = rows[index], rawStart = instant(segment?.startedAt), rawEnd = instant(segment?.endedAt || entry.clockOutAt || now);
    if (!segment || typeof segment.id !== 'string' || !segment.id || segment.id.length > 250 || !['general', 'work', 'travel'].includes(segment.kind) || used.has(segment.id) || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < previousEnd || rawEnd < rawStart || !segment.endedAt && (index !== rows.length - 1 || entry.clockOutAt) || segment.kind !== 'general' && !jobId(segment.jobId)) return { ...result, jobs: [], generalMs: 0, totalRecordedMs: 0, untrackedMs: totalShiftMs, needsReview: true };
    used.add(segment.id); previousEnd = rawEnd;
    if (rawStart < shiftStart || rawEnd > shiftEnd) result.needsReview = true;
    const start = Math.max(rawStart, shiftStart), end = Math.min(rawEnd, shiftEnd), duration = end >= start ? net(start, end) : 0;
    if (segment.kind === 'general') result.generalMs += duration;
    else {
      const row = jobs.get(segment.jobId) || { jobId: segment.jobId, jobLabel: String(segment.jobLabel || '').slice(0, 180), workMs: 0, travelMs: 0 };
      row[segment.kind === 'work' ? 'workMs' : 'travelMs'] += duration; jobs.set(segment.jobId, row);
    }
    result.totalRecordedMs += duration;
  }
  result.jobs = [...jobs.values()]; result.untrackedMs = Math.max(0, totalShiftMs - result.totalRecordedMs);
  return result;
}

export function ownJobTimeProjection(entry, now = new Date().toISOString()) {
  if (!entry) return null;
  const summary = employeeJobTime(entry, now), current = summary.needsReview ? null : activeJobSegment(entry);
  // Breaks are returned exactly as stored so an offline break replay can extend them unchanged.
  return { id: entry.id, employee: entry.employee, clockInAt: entry.clockInAt, onBreak: Array.isArray(entry.breaks) && entry.breaks.some(item => item && !item.endAt), breaks: Array.isArray(entry.breaks) ? entry.breaks : [], deviceTime: entry.deviceTime === true, clockInLocation: clockInLocation(entry), currentSegmentId: current?.id || '', current: current ? { id: current.id, kind: current.kind, jobId: current.jobId, jobLabel: current.jobLabel, startedAt: current.startedAt } : null, summary };
}

/** What the Hub shows for a timecard's time (/api/employee-hub adds it to every timecard it returns): the segment running
 * now and, per job, net work and travel, plus general company time and shift time without job segments. Derived on each
 * read and never stored. */
export function jobTimeView(entry, now = new Date().toISOString()) {
  const own = ownJobTimeProjection(entry, now), summary = own.summary;
  return { current: own.current, jobs: summary.jobs, generalMs: summary.generalMs, untrackedMs: summary.untrackedMs, recorded: summary.recorded, partialHistory: summary.partialHistory, needsReview: summary.needsReview, clockInLocation: own.clockInLocation };
}

const crewSegmentId = requestId => `crew:${String(requestId || '').toLowerCase()}`;
const DENVER_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
const denverDay = ms => DENVER_DAY.format(new Date(ms));
/** Whether a lead's "move my crew-mates to work" moves this crew-mate's card: only an open shift clocked in today (Denver),
 * not on approved time off today (onPto, from the crew-mate's requests), not on break, on general time or travelling to
 * this same job. A card left open from an earlier day (a forgotten clock-out) is 'stale_shift': its owner may not be
 * here at all. 'moved' when the card already has that move. */
export function crewJobMoveState(entry, jobId, requestId, now, { onPto = false } = {}) {
  if (segments(entry).some(segment => segment?.id === crewSegmentId(requestId))) return 'moved';
  if (!entry || entry.status !== 'active' || entry.clockOutAt || ['approved', 'pending', 'rejected'].includes(entry.approvalStatus)) return 'not_clocked_in';
  const start = instant(entry.clockInAt), at = instant(now);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return 'needs_review';
  if (denverDay(start) !== denverDay(at)) return 'stale_shift';
  if (onPto) return 'on_pto';
  if (entry.jobTracking && (entry.jobTracking.version !== 1 || !Array.isArray(entry.jobTracking.segments) || employeeJobTime(entry, now).needsReview || segments(entry).length >= 200)) return 'needs_review';
  if (Array.isArray(entry.breaks) && entry.breaks.some(item => item && !item.endAt)) return 'on_break';
  const current = activeJobSegment(entry);
  if (current?.kind === 'work' && current.jobId === jobId) return 'already_working';
  if (current && current.kind !== 'general' && !(current.kind === 'travel' && current.jobId === jobId)) return 'on_another_job';
  return 'move';
}

/** The lead's move of one crew-mate onto work on the job (EGC_JOB_STATUS_MOVES_TIME), under a segment ID derived from the
 * lead's request ID so a replay changes nothing. Earlier segments keep their job. */
export function applyCrewJobMove(entry, action, lead, now, options = {}) {
  const id = crewSegmentId(action?.requestId);
  if (segments(entry).some(segment => segment?.id === id)) return entry;
  if (!uuid(action?.requestId) || action.kind !== 'work' || !jobId(action.jobId)) throw fail('Choose a job and a unique request ID to move crew-mates to work.');
  const state = crewJobMoveState(entry, action.jobId, action.requestId, now, options);
  if (state !== 'move') throw fail('This crew-mate’s time cannot move to this job now.', 409);
  const rows = segments(entry), current = activeJobSegment(entry), at = instant(now), start = instant(entry.clockInAt);
  if (!Number.isFinite(at) || !Number.isFinite(start) || at < start || current && at < instant(current.startedAt)) throw fail('The shift timing needs manager review.', 409);
  const nextRows = rows.map(segment => segment.endedAt ? segment : { ...segment, endedAt: now, endedBy: lead.user, endReason: 'crew_move' });
  nextRows.push({ id, kind: 'work', jobId: action.jobId, jobLabel: '', startedAt: now, endedAt: '', actorId: lead.user });
  const history = [...(Array.isArray(entry.history) ? entry.history : []), { action: 'job_time_crew_move', actor: lead.user, actorName: lead.displayName || lead.user, at: now, requestId: action.requestId, fromSegmentId: current?.id || null, toSegmentId: id, jobId: action.jobId, kind: 'work' }];
  return { ...entry, jobTracking: { ...(entry.jobTracking || { version: 1, coverageStartedAt: now, partialHistory: true }), segments: nextRows }, history, updatedAt: now, updatedBy: lead.user };
}
