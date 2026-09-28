import { applyEmployeeJobAction, finishEmployeeJobTime, initializeJobTracking } from './employee-job-time.js';

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const text = (value, limit = 180) => String(value || '').trim().slice(0, limit);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const timeFields = ['employee', 'clockInAt', 'clockOutAt', 'breaks', 'jobId', 'hourlyRate', 'bonus', 'tips'];
const auditFields = [...timeFields, 'status', 'approvalStatus', 'notes'];

export function timecardError(message, status = 400) {
  return Object.assign(new Error(message), { code: 'EMPLOYEE_TIMECARD_INVALID', status });
}

// Offline crew clock actions may carry the phone's capture time. It is used
// only when the owner enables EGC_OFFLINE_CLOCK_ENABLED and always flags review.
export const offlineClockEnabled = env => String(env?.EGC_OFFLINE_CLOCK_ENABLED || '').trim().toLowerCase() === 'true';
const DEVICE_MAX_AGE = 12 * 3600000, DEVICE_SKEW = 2 * 60000;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const deviceTimeError = message => Object.assign(timecardError(message, 409), { code: 'EMPLOYEE_TIMECARD_DEVICE_TIME' });

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const date = value.slice(0, 10), calendar = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== date || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) return NaN;
  return Date.parse(value);
}

export function timecardWorkDate(value) {
  if (!Number.isFinite(instant(value))) return '';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

export function timecardHours(entry, now = Date.now()) {
  const start = instant(entry.clockInAt), end = entry.clockOutAt ? instant(entry.clockOutAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 31 * 86400000) throw timecardError('Review this timecard’s invalid shift times.');
  if (entry.breaks !== undefined && !Array.isArray(entry.breaks)) throw timecardError('Review this timecard’s invalid breaks.');
  let previousEnd = start, breakTotal = 0;
  for (const item of entry.breaks || []) {
    const from = instant(item?.startAt), to = item?.endAt ? instant(item.endAt) : end;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < previousEnd || to < from || to > end) throw timecardError('Review overlapping or invalid breaks before saving this timecard.');
    if (entry.clockOutAt && !item.endAt) throw timecardError('End the open break before approving this timecard.');
    previousEnd = to; breakTotal += to - from;
  }
  return Math.round((end - start - breakTotal) / 3600000 * 1000) / 1000;
}

export const activeTimecard = entry => Boolean(entry && entry.status === 'active' && !entry.clockOutAt);

function location(value, now) {
  const lat = value?.lat, lng = value?.lng, accuracy = value?.accuracy;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw timecardError('A valid shift location is required.');
  return { lat, lng, accuracy: typeof accuracy === 'number' && Number.isFinite(accuracy) ? Math.max(0, Math.min(100000, accuracy)) : 0, capturedAt: now };
}

function lastClockEvent(entry) {
  const segments = Array.isArray(entry?.jobTracking?.segments) ? entry.jobTracking.segments : [], breaks = Array.isArray(entry?.breaks) ? entry.breaks : [];
  const times = [entry?.clockInAt, ...breaks.flatMap(item => [item?.startAt, item?.endAt]), ...segments.flatMap(item => [item?.startedAt, item?.endedAt])].map(instant).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

export function deviceClockTime(value, now, entry = null) {
  const at = instant(value), server = instant(now), floor = lastClockEvent(entry);
  if (!Number.isFinite(at) || !Number.isFinite(server)) throw timecardError('This offline clock action has an invalid device time.');
  if (at > server + DEVICE_SKEW) throw deviceTimeError('This phone’s clock is ahead of the server. Correct the phone time, then record the action again.');
  if (at < server - DEVICE_MAX_AGE) throw deviceTimeError('Offline clock actions older than 12 hours need a manager time correction.');
  if (at < floor) throw deviceTimeError('This offline clock action is earlier than your last recorded time. Ask a manager for a time correction.');
  return new Date(Math.max(Number.isFinite(floor) ? floor : -Infinity, Math.min(at, server))).toISOString();
}

// With the flag off the server time is recorded as before, but a device time
// that is already stale is refused rather than silently moved to the moment
// the phone reconnected.
export function serverClockTime(value, now) {
  const at = instant(value), server = instant(now);
  if (Number.isFinite(at) && Number.isFinite(server) && at < server - DEVICE_SKEW) throw deviceTimeError('Offline clock times are not enabled. Record it again now or ask a manager for a time correction.');
  return now;
}

function deviceStamp(entry, action, value, at, now) {
  const events = Array.isArray(entry.deviceTimeEvents) ? entry.deviceTimeEvents : [];
  return { ...entry, deviceTime: true, needsReview: true, ...(entry.clockOutAt ? { approvalStatus: 'pending' } : {}),
    deviceTimeEvents: [...events, { action, deviceCapturedAt: text(value, 40), recordedAt: at, receivedAt: now }].slice(-50) };
}

function withAudit(existing, next, session, now, action) {
  const changes = auditFields.filter(key => !equal(existing?.[key], next[key]));
  const history = Array.isArray(existing?.history) ? existing.history : [];
  return { ...next, workDate: timecardWorkDate(next.clockInAt), updatedAt: now, updatedBy: session.user,
    history: changes.length ? [...history, { action, actor: session.user, actorName: session.displayName || session.user, at: now,
      changes: Object.fromEntries(changes.map(key => [key, { before: existing?.[key] ?? null, after: next[key] ?? null }])) }] : history };
}

function changeBreak(existing, incoming, stamp) {
  if (!Array.isArray(incoming) || incoming.length > 100) throw timecardError('A valid break action is required.');
  const previous = Array.isArray(existing) ? existing : [];
  const last = previous.at(-1), proposed = incoming.at(-1), request = uuid(proposed?.requestId) ? proposed.requestId.toLowerCase() : '';
  if (equal(previous, incoming)) return previous;
  // A queued crew break keeps its request ID, so a replay after the break was
  // changed elsewhere is a no-op instead of a second break.
  if (request && previous.some(item => item?.startRequestId === request || item?.endRequestId === request)) return previous;
  if (!last?.endAt && last) {
    if (incoming.length !== previous.length || !equal(incoming.slice(0, -1), previous.slice(0, -1))) throw timecardError('Only the current break can be ended.');
    // The browser sends its capture time; the server owns both break timestamps.
    if (!proposed?.endAt) return previous;
    if (proposed.startAt !== last.startAt) throw timecardError('The break changed. Refresh your timecard before ending it.', 409);
    return [...previous.slice(0, -1), { ...last, endAt: stamp(), ...(request ? { endRequestId: request } : {}) }];
  }
  if (incoming.length === previous.length + 1 && equal(incoming.slice(0, -1), previous) && proposed && !proposed.endAt) return [...previous, { startAt: stamp(), endAt: '', ...(request ? { startRequestId: request } : {}) }];
  if (last && incoming.length === previous.length && equal(incoming.slice(0, -1), previous.slice(0, -1)) && proposed.startAt === last.startAt && proposed.endAt) return previous;
  throw timecardError('Recorded breaks cannot be rewritten. Ask a manager for a time correction.', 403);
}

export function authorizeTimecard({ session, manager, id, incoming, existing, hourlyRate = 0, now = new Date().toISOString(), env = {} }) {
  const device = offlineClockEnabled(env);
  if (incoming.jobAction) {
    if (Object.keys(incoming).some(key => key !== 'jobAction')) throw timecardError('Send job-time changes separately from other timecard edits.');
    const action = incoming.jobAction, segments = Array.isArray(existing?.jobTracking?.segments) ? existing.jobTracking.segments : [];
    const captured = action && typeof action === 'object' && own(action, 'deviceCapturedAt');
    // A replayed receipt stays an exact no-op even after later events move the device-time floor.
    if (!device || !captured || !existing || text(existing.employee).toLowerCase() !== text(session.user).toLowerCase() || segments.some(segment => segment?.id === action.requestId)) {
      const next = applyEmployeeJobAction(existing, action, session, now);
      if (!device && captured && next !== existing) serverClockTime(action.deviceCapturedAt, now);
      return next;
    }
    const at = deviceClockTime(action.deviceCapturedAt, now, existing);
    return deviceStamp({ ...applyEmployeeJobAction(existing, action, session, at), updatedAt: now }, 'job_time', action.deviceCapturedAt, at, now);
  }
  if (own(incoming, 'jobTracking') && !equal(incoming.jobTracking, existing?.jobTracking)) throw timecardError('Job time segments are server records and cannot be replaced.', 403);
  if (manager) {
    const next = { ...(existing || {}), ...incoming, id };
    // Existing administrative import/correction support is preserved. Every
    // actual approval must nevertheless refer to a completed valid shift.
    const changedTime = existing && timeFields.some(key => own(incoming, key) && !equal(existing[key], next[key]));
    if (activeTimecard(existing) && next.employee !== existing.employee) throw timecardError('Close the active shift before changing its employee.', 409);
    if (activeTimecard(next)) timecardHours(next, Date.parse(now));
    if (changedTime && existing.approvalStatus === 'approved' && incoming.approvalStatus !== 'approved') {
      next.approvalStatus = 'pending'; next.approvedAt = ''; next.approvedBy = '';
    }
    if (incoming.approvalStatus === 'approved') {
      if (!next.clockOutAt || activeTimecard(next)) throw timecardError('Only completed timecards can be approved.');
      if (timecardHours(next) <= 0) throw timecardError('Positive work hours are required before approval.');
      next.approvedAt = now; next.approvedBy = session.user;
    } else if (incoming.approvalStatus === 'rejected') { next.approvedAt = now; next.approvedBy = session.user; }
    // Device-captured times stay flagged until a manager explicitly reviews
    // them; an approval alone never records that review.
    if (incoming.deviceTimeReviewed === true && next.deviceTime && next.needsReview) { next.needsReview = false; next.deviceTimeReviewedAt = now; next.deviceTimeReviewedBy = session.user; }
    delete next.deviceTimeReviewed;
    if (next.clockInAt && next.clockOutAt) {
      next.hours = timecardHours(next);
      next.grossEstimate = Math.round(next.hours * Math.max(0, Number(next.hourlyRate || 0)) * 100) / 100;
    }
    const finalized = next.clockOutAt && !existing?.clockOutAt ? finishEmployeeJobTime(next, session, next.clockOutAt) : next;
    return withAudit(existing, finalized, session, now, existing ? 'manager_timecard_update' : 'manager_timecard_create');
  }
  // stamp() runs only when a new time is recorded, so lost-reply replays stay no-ops.
  const deviceValue = own(incoming, 'deviceCapturedAt') ? incoming.deviceCapturedAt : undefined, flagged = device && deviceValue !== undefined;
  const stamp = entry => deviceValue === undefined ? now : device ? deviceClockTime(deviceValue, now, entry) : serverClockTime(deviceValue, now);
  if (!existing) {
    if (incoming.locationTracking !== true) throw timecardError('Shift location is required to clock in.');
    const at = stamp(null), point = location(incoming.lastLocation, at);
    const entry = { id, employee: session.user, employeeName: session.displayName, role: session.role,
      payType: session.payType, hourlyRate, clockInAt: at, clockOutAt: '', status: 'active', approvalStatus: 'open', approvedBy: '', approvedAt: '',
      jobId: text(incoming.jobId), jobLabel: text(incoming.jobLabel), locationTracking: true, locationConsentAt: at,
      jobTracking: initializeJobTracking(id, session, at),
      // A clock-in from a page that does not keep sharing location says so.
      locationStatus: incoming.locationStatus === 'unavailable' ? 'unavailable' : 'tracking', lastLocation: point, locationTrail: [point], locationUpdatedAt: now, breaks: [], createdAt: now,
      recordedBy: session.user, recordingVersion: 1 };
    return withAudit(null, flagged ? deviceStamp(entry, 'clock_in', deviceValue, at, now) : entry, session, now, 'clock_in');
  }
  if (text(existing.employee).toLowerCase() !== text(session.user).toLowerCase()) throw timecardError('This timecard belongs to another employee.', 403);
  if (!activeTimecard(existing) || ['approved', 'rejected', 'pending'].includes(existing.approvalStatus)) {
    // An uncertain clock-out response may be safely retried without reopening,
    // changing, or revoking the already submitted/approved card.
    const clockOutKeys = ['clockOutAt', 'status', 'approvalStatus', 'hours', 'grossEstimate', 'locationTracking', 'locationStatus', 'updatedAt', 'deviceCapturedAt'];
    if (existing.clockOutAt && incoming.clockOutAt && incoming.status === 'submitted' && Object.keys(incoming).every(key => clockOutKeys.includes(key))) return existing;
    throw timecardError('Only a manager can correct a submitted, approved, or rejected timecard.', 403);
  }
  const next = { ...existing };
  // Identity, pay, original clock-in and historical attribution cannot be
  // changed by a full-record browser retry or forged client fields.
  if (own(incoming, 'jobId') && text(incoming.jobId) !== text(existing.jobId)) throw timecardError('Use Start job time or Switch job time so earlier shift hours keep their original job.', 409);
  if (own(incoming, 'notes')) next.notes = text(incoming.notes, 2000);
  let breakAt = '';
  if (own(incoming, 'breaks')) next.breaks = changeBreak(existing.breaks, incoming.breaks, () => (breakAt = stamp(existing)));
  if (incoming.lastLocation) {
    const point = location(incoming.lastLocation, now);
    next.lastLocation = point; next.locationTrail = [...(existing.locationTrail || []), point].slice(-120); next.locationUpdatedAt = now;
  }
  if (['tracking', 'unavailable'].includes(incoming.locationStatus)) next.locationStatus = incoming.locationStatus;
  if (own(incoming, 'locationError')) next.locationError = text(incoming.locationError, 120);
  if (incoming.clockOutAt || incoming.status === 'submitted') {
    if (!incoming.clockOutAt || incoming.status !== 'submitted') throw timecardError('A complete clock-out action is required.');
    const at = stamp(next);
    next.clockOutAt = at; next.status = 'submitted'; next.approvalStatus = 'pending';
    next.breaks = (next.breaks || []).map(item => item.endAt ? item : { ...item, endAt: at });
    next.locationTracking = false; next.locationStatus = 'stopped';
    next.hours = timecardHours(next); next.grossEstimate = Math.round(next.hours * Math.max(0, Number(next.hourlyRate || 0)) * 100) / 100;
    const closed = finishEmployeeJobTime(next, session, at);
    return withAudit(existing, flagged ? deviceStamp(closed, 'clock_out', deviceValue, at, now) : closed, session, now, 'clock_out');
  }
  timecardHours(next, Date.parse(now));
  return withAudit(existing, breakAt && flagged ? deviceStamp(next, 'break', deviceValue, breakAt, now) : next, session, now, own(incoming, 'breaks') ? 'break_update' : 'timecard_update');
}
