import { localInstant } from './operations-portal-records.js';

const KINDS = ['work', 'paused', 'waiting', 'delayed', 'travel', 'arrival'];
const terminal = job => ['completed', 'invoiced', 'paid', 'review_requested', 'cancelled', 'canceled'].includes(job.pipelineStatus || job.status);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const kindFor = activity => ({ in_progress: 'work', paused: 'paused', waiting: 'waiting', delayed: 'delayed', dispatched: 'travel', arrived: 'arrival' })[activity] || null;
const emptyTotals = () => Object.fromEntries(KINDS.map(kind => [kind, 0]));
function readClock(value) {
  if (!value || value.version !== 1 || !Number.isFinite(instant(value.trackingStartedAt))) return null;
  if (KINDS.some(kind => !Number.isSafeInteger(value.totalsMs?.[kind]) || value.totalsMs[kind] < 0)) return null;
  if (value.current && (!KINDS.includes(value.current.kind) || !Number.isFinite(instant(value.current.startedAt)) || instant(value.current.startedAt) < instant(value.trackingStartedAt))) return null;
  return value;
}

/** Called only alongside the existing optimistic, idempotent field mutation.
 * Completed segments are accumulated in the job; their exact endpoints are
 * also retained in that mutation's immutable field event. No employee/payroll
 * timecard is created or changed by this job-level operational clock. */
export function advanceFieldTime(job, nextActivity, actor, requestId, now = new Date().toISOString()) {
  const raw = job.fieldExecution?.jobTime, prior = readClock(raw), nextKind = kindFor(nextActivity), at = instant(now);
  if (!Number.isFinite(at)) throw new Error('field_time_server_timestamp_invalid');
  if (raw && !prior) return { clock: null, segment: { warning: 'Existing job timer requires review; its stored record was preserved.' } };
  if (!prior && !nextKind) return { clock: null, segment: null };
  if (prior?.current?.kind === nextKind) return { clock: prior, segment: null };
  const clock = prior ? { ...prior, totalsMs: { ...prior.totalsMs } } : { version: 1, trackingStartedAt: now, partialHistory: Boolean(job.startedAt || ['arrived', 'in_progress', 'dispatched'].includes(job.pipelineStatus || job.status)), totalsMs: emptyTotals() };
  let segment = null;
  if (clock.current) {
    const elapsed = at - instant(clock.current.startedAt);
    if (elapsed < 0 || !Number.isSafeInteger(clock.totalsMs[clock.current.kind] + elapsed)) {
      clock.needsReview = true;
      segment = { ...clock.current, endedAt: now, durationMs: null, warning: 'Clock order or accumulated duration requires review.' };
    } else {
      clock.totalsMs[clock.current.kind] += elapsed;
      segment = { ...clock.current, endedAt: now, durationMs: elapsed };
      if (elapsed > 24 * 3600000) clock.needsReview = true;
    }
  }
  clock.current = nextKind ? { kind: nextKind, startedAt: now, actorId: actor.user || actor.id, requestId } : null;
  clock.updatedAt = now;
  if (nextKind === 'work' && !clock.firstWorkAt) clock.firstWorkAt = now;
  if (nextKind) delete clock.stoppedAt;
  else clock.stoppedAt = now;
  return { clock, segment };
}

function scheduledDuration(job) {
  // Wall dates are authoritative in the existing scheduler. Ambiguous or
  // nonexistent Mountain times stay unknown instead of inventing a duration.
  const hasWallTime = job.date || job.time || job.endTime;
  const start = hasWallTime ? localInstant(job.date, job.time) : job.startAt;
  const end = hasWallTime ? localInstant(job.endDate || job.date, job.endTime) : job.endAt;
  const duration = instant(end) - instant(start);
  return Number.isFinite(duration) && duration > 0 && duration <= 31 * 86400000 ? duration : null;
}

export function fieldJobTime(job, now = new Date().toISOString()) {
  const raw = job.fieldExecution?.jobTime, clock = readClock(raw), asOf = new Date(now).toISOString(), at = instant(asOf), estimatedMs = scheduledDuration(job);
  if (!clock) return { recorded: false, estimatedMs, asOf, needsReview: Boolean(raw), partialHistory: Boolean(job.startedAt || job.completedAt), runningKind: null, message: raw ? 'The stored job timer needs manager review.' : 'Job time will be recorded from the next field status action. Earlier work is not reconstructed.' };
  const totals = { ...clock.totalsMs }; let runningKind = null, needsReview = clock.needsReview === true;
  if (clock.current) {
    const canonical = job.pipelineStatus || job.status;
    const activity = job.fieldExecution?.activity;
    const currentActivity = kindFor(activity) && (activity === canonical || ['paused', 'waiting', 'delayed'].includes(activity) && ['in_progress', 'arrived', 'dispatched'].includes(canonical)) ? activity : canonical;
    const stop = terminal(job) ? instant(job.cancelledAt || job.completedAt || clock.stoppedAt) : at;
    if (terminal(job) || kindFor(currentActivity) !== clock.current.kind) needsReview = true;
    const elapsed = stop - instant(clock.current.startedAt);
    if (Number.isFinite(elapsed) && elapsed >= 0 && Number.isSafeInteger(totals[clock.current.kind] + elapsed) && (terminal(job) || kindFor(currentActivity) === clock.current.kind)) {
      totals[clock.current.kind] += elapsed;
      if (!terminal(job) && kindFor(currentActivity) === clock.current.kind) runningKind = clock.current.kind;
      if (elapsed > 24 * 3600000) needsReview = true;
    } else needsReview = true;
  }
  return { recorded: true, estimatedMs, asOf, trackingStartedAt: clock.trackingStartedAt, firstWorkAt: clock.firstWorkAt || null, stoppedAt: clock.stoppedAt || null, partialHistory: clock.partialHistory === true, needsReview, runningKind,
    workMs: totals.work, pausedMs: totals.paused, waitingMs: totals.waiting, delayedMs: totals.delayed, travelMs: totals.travel, arrivalMs: totals.arrival,
    totalRecordedMs: Object.values(totals).reduce((sum, duration) => sum + duration, 0), workVarianceMs: estimatedMs == null ? null : totals.work - estimatedMs };
}
