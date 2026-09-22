const fail = (message, status = 400) => Object.assign(new Error(message), { code: 'EMPLOYEE_JOB_TIME_INVALID', status });
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const jobId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(?:_egc_|secure_)/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const segments = entry => Array.isArray(entry?.jobTracking?.segments) ? entry.jobTracking.segments : [];
export const activeJobSegment = entry => segments(entry).find(segment => segment && !segment.endedAt) || null;

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
  if ((current?.id || '') !== action.expectedSegmentId) throw fail('Your active job changed. Refresh your shift before switching work.', 409);
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
  if (entry.jobTracking && (entry.jobTracking.version !== 1 || !Array.isArray(entry.jobTracking.segments))) return { ...result, needsReview: true };
  if (entry.breaks !== undefined && !Array.isArray(entry.breaks)) return { ...result, needsReview: true };
  if (!Number.isFinite(shiftStart) || !Number.isFinite(shiftEnd) || shiftEnd < shiftStart || shiftEnd - shiftStart > 31 * 86400000) return { ...result, needsReview: true };
  const breaks = []; let previousBreak = shiftStart;
  for (const item of entry.breaks || []) {
    const start = instant(item?.startAt), end = instant(item?.endAt || entry.clockOutAt || now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start < previousBreak || start < shiftStart || end > shiftEnd) return { ...result, needsReview: true };
    breaks.push({ start, end }); previousBreak = end;
  }
  const net = (start, end) => Math.max(0, end - start - breaks.reduce((total, pause) => total + Math.max(0, Math.min(end, pause.end) - Math.max(start, pause.start)), 0));
  const totalShiftMs = net(shiftStart, shiftEnd);
  if (!result.recorded) return { ...result, untrackedMs: totalShiftMs, partialHistory: true };
  const jobs = new Map(), used = new Set(); let previousEnd = shiftStart;
  for (let index = 0; index < rows.length; index++) {
    const segment = rows[index], rawStart = instant(segment?.startedAt), rawEnd = instant(segment?.endedAt || entry.clockOutAt || now);
    if (!segment || !['general', 'work', 'travel'].includes(segment.kind) || used.has(segment.id) || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart < previousEnd || rawEnd < rawStart || !segment.endedAt && index !== rows.length - 1 || segment.kind !== 'general' && !jobId(segment.jobId)) return { ...result, jobs: [], generalMs: 0, totalRecordedMs: 0, untrackedMs: totalShiftMs, needsReview: true };
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
  const current = activeJobSegment(entry);
  return { id: entry.id, employee: entry.employee, clockInAt: entry.clockInAt, onBreak: Boolean(entry.breaks?.some(item => !item.endAt)), currentSegmentId: current?.id || '', current: current ? { id: current.id, kind: current.kind, jobId: current.jobId, jobLabel: current.jobLabel, startedAt: current.startedAt } : null, summary: employeeJobTime(entry, now) };
}
