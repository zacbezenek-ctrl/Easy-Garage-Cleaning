import { NO_CLOCK_IN_FIX, applyEmployeeJobAction, finishEmployeeJobTime, initializeJobTracking, jobActionSatisfied } from './employee-job-time.js';
import { can, capabilityMode } from './staff-roles.js';
import { canSetPay, payChangeRefused } from './pay-visibility.js';

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

// Clock-in only (owner decision, 2026-09-29): one position is taken as the shift starts and nothing updates it after
// (no watch, no trail). The crew app's clock-in says so with job_page_single_fix (its older 'unavailable' meant the same
// one fix) and the Hub's with hub_single_fix. Trails saved before this stay on their cards, readable.
// EGC_CLOCK_IN_WITHOUT_FIX: exactly "true" lets a phone that found no position (after its lower-accuracy retry) clock in
// without one, flagged locationReview 'location_unavailable_at_clock_in' for a manager. Unset: a position is required.
export const clockInWithoutFix = env => String(env?.EGC_CLOCK_IN_WITHOUT_FIX || '').trim().toLowerCase() === 'true';
const SINGLE_FIX = ['job_page_single_fix', 'hub_single_fix'];
const noFix = incoming => incoming.locationStatus === NO_CLOCK_IN_FIX && incoming.lastLocation == null;
const noFixRefused = () => timecardError('This phone could not find its location. Move near a window or outside, then clock in again.');
// Location a shift records: its clock-in position (and the trail older shifts kept), and the last location status.
const locationFields = ['lastLocation', 'locationTrail', 'locationUpdatedAt', 'locationError'];
// Whether a save changes a shift's location record: a new position, trail or location error, or a status other than
// the 'stopped' that every clock-out (and its replay) sends.
const locationUpdate = (existing, incoming) => locationFields.some(key => own(incoming, key) && !equal(incoming[key], existing[key]))
  || own(incoming, 'locationStatus') && incoming.locationStatus !== 'stopped' && incoming.locationStatus !== existing.locationStatus;
// On a closed shift, location turned back on counts too.
const lateLocation = (existing, incoming) => locationUpdate(existing, incoming) || incoming.locationTracking === true && existing.locationTracking !== true;
// An open shift's location is its clock-in position: a later position fix, error or status (an older Hub tab's watch) is refused.
const clockInOnly = () => Object.assign(timecardError('Location is taken once at clock-in, so this shift’s location is not updated.', 409), { code: 'EMPLOYEE_TIMECARD_LOCATION_CLOCK_IN_ONLY' });

function clockInLocation(incoming, at, now, env) {
  if (incoming.locationTracking !== true) throw timecardError('Shift location is required to clock in.');
  if (noFix(incoming)) {
    if (!clockInWithoutFix(env)) throw noFixRefused();
    return { locationTracking: false, locationConsentAt: at, locationStatus: NO_CLOCK_IN_FIX, locationReview: NO_CLOCK_IN_FIX, locationUpdatedAt: now };
  }
  const point = location(incoming.lastLocation, at), source = ['job_page_single_fix', 'unavailable'].includes(incoming.locationStatus) ? 'job_page_single_fix' : 'hub_single_fix';
  return { locationTracking: false, locationConsentAt: at, locationStatus: source, lastLocation: point, locationUpdatedAt: now };
}

// A manager's clock-in is kept as the Hub sent it, with its one position and no trail or tracking. Their own shift starts
// its job segments on general time at its clock-in, as an employee's does, so its time is never "No job segments".
function managerClockIn(next, env, session) {
  const { locationTrail, ...entry } = next, tracking = sameEmployee(entry, session) ? { jobTracking: initializeJobTracking(entry.id, session, entry.clockInAt) } : {};
  if (noFix(entry)) {
    if (!clockInWithoutFix(env)) throw noFixRefused();
    return { ...entry, locationTracking: false, locationReview: NO_CLOCK_IN_FIX, ...tracking };
  }
  return { ...entry, locationTracking: false, locationStatus: SINGLE_FIX.includes(entry.locationStatus) ? entry.locationStatus : 'hub_single_fix', ...tracking };
}

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

function withAudit(existing, next, session, now, action, extra = null) {
  const changes = auditFields.filter(key => !equal(existing?.[key], next[key]));
  const history = Array.isArray(existing?.history) ? existing.history : [];
  return { ...next, workDate: timecardWorkDate(next.clockInAt), updatedAt: now, updatedBy: session.user,
    history: changes.length || extra ? [...history, { action, actor: session.user, actorName: session.displayName || session.user, at: now, ...(extra || {}),
      changes: Object.fromEntries(changes.map(key => [key, { before: existing?.[key] ?? null, after: next[key] ?? null }])) }] : history };
}

// EGC_TIMECARD_CORRECTIONS: exactly "true" lets whoever approves time (time.approve: the owner and managers) correct a
// timecard from Time approvals (clock-in, clock-out, breaks, job, and the rate with pay.manage) or close a shift someone
// forgot to clock out of, with a reason. Unset: a save carrying `correction` is refused (403) and every other timecard
// save works as before.
export const timecardCorrectionsEnabled = env => String(env?.EGC_TIMECARD_CORRECTIONS || '').trim().toLowerCase() === 'true';
// An open shift older than this shows under Needs attention (Command center and Time approvals) with the switch on.
export const OPEN_SHIFT_ATTENTION_HOURS = 14;
const MAX_CORRECTED_SHIFT = 24 * 3600000, MAX_BREAKS = 20;
const CORRECTION_KEYS = { correct: ['correction', 'clockInAt', 'clockOutAt', 'breaks', 'jobId', 'hourlyRate'], close: ['correction', 'clockOutAt'] };
const correctionError = (message, status = 400, code = 'EMPLOYEE_TIMECARD_INVALID') => Object.assign(timecardError(message, status), { code });
const iso = ms => new Date(ms).toISOString();
const validJobId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(?:_egc_|secure_)/.test(value);
export const correctionJobId = value => validJobId(value) ? value : '';

function correctedInstant(value, label) {
  const at = instant(value);
  if (!Number.isFinite(at)) throw correctionError(`Enter a valid ${label}.`);
  return at;
}

// The corrected breaks, in order and inside the shift. A break the card already had is kept as stored, and one whose end
// or kind changed keeps its start's request ID.
function correctedBreaks(value, existing, start, end) {
  if (!Array.isArray(value) || value.length > MAX_BREAKS) throw correctionError(`Send the shift's breaks as a list of at most ${MAX_BREAKS}.`);
  const stored = Array.isArray(existing) ? existing : [];
  let previous = start;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['startAt', 'endAt', 'kind'].includes(key))) throw correctionError('Each break needs a start and an end.');
    const from = correctedInstant(item.startAt, 'break start'), to = correctedInstant(item.endAt, 'break end');
    if (to <= from) throw correctionError('Each break must end after it starts.');
    if (from < previous || to > end) throw correctionError('Breaks must be inside the shift, in order and not overlapping.');
    if (![undefined, '', 'rest', 'meal'].includes(item.kind)) throw correctionError('A break is a paid rest break or an unpaid meal break.');
    previous = to;
    const same = stored.find(row => instant(row?.startAt) === from);
    if (same && instant(same.endAt) === to && (same.kind || '') === (item.kind || '')) return same;
    return { ...(uuid(same?.startRequestId) ? { startRequestId: same.startRequestId } : {}), startAt: same ? same.startAt : iso(from), endAt: iso(to), ...(item.kind ? { kind: item.kind } : {}) };
  });
}
const kept = (stored, at) => instant(stored) === at ? stored : iso(at);

// Job segments are clipped to the corrected shift: a segment outside it is dropped, one crossing its ends is trimmed, and
// a segment still running ends at the new clock-out. Every changed segment is listed for the audit entry.
function clipJobTracking(entry, start, end, session, now) {
  const tracking = entry.jobTracking;
  if (!tracking || tracking.version !== 1 || !Array.isArray(tracking.segments)) return { jobTracking: tracking, changes: [] };
  const changes = [], segments = [];
  for (const segment of tracking.segments) {
    const from = instant(segment?.startedAt), to = segment?.endedAt ? instant(segment.endedAt) : end;
    if (!segment || typeof segment !== 'object' || !Number.isFinite(from) || !Number.isFinite(to)) { segments.push(segment); continue; }
    const before = { startedAt: segment.startedAt, endedAt: segment.endedAt || '' }, clippedFrom = Math.max(from, start), clippedTo = Math.min(to, end);
    if (clippedTo <= clippedFrom) { changes.push({ id: segment.id, kind: segment.kind, jobId: segment.jobId || '', before, after: null }); continue; }
    const startedAt = clippedFrom === from ? segment.startedAt : iso(clippedFrom), endedAt = segment.endedAt && clippedTo === to ? segment.endedAt : iso(clippedTo);
    if (startedAt === segment.startedAt && endedAt === segment.endedAt) { segments.push(segment); continue; }
    segments.push({ ...segment, startedAt, endedAt, ...(segment.endedAt ? {} : { endedBy: session.user, endReason: 'manager_close' }), correctedAt: now, correctedBy: session.user });
    changes.push({ id: segment.id, kind: segment.kind, jobId: segment.jobId || '', before, after: { startedAt, endedAt } });
  }
  return { jobTracking: changes.length ? { ...tracking, segments } : tracking, changes };
}

/** A manager's correction (kind 'correct') or close of a forgotten open shift (kind 'close'). It needs a reason, is
 * saved against the card as the manager saw it (expectedUpdatedAt), recomputes hours, returns the card to pending,
 * clips its job segments to the corrected shift and is recorded in the card's history with the reason. A retry with the
 * same request ID after the correction landed changes nothing. */
export function correctTimecard({ session, manager, existing, incoming, now, env = {}, jobLabel = null }) {
  if (!manager || !can(session, 'time.approve', env)) throw correctionError('Only a manager or the owner can correct a timecard.', 403);
  if (!timecardCorrectionsEnabled(env)) throw correctionError('Timecard corrections are switched off.', 403, 'EMPLOYEE_TIMECARD_CORRECTIONS_OFF');
  if (!existing) throw correctionError('This timecard could not be found. Refresh Time approvals.', 404);
  const meta = incoming.correction;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).some(key => !['requestId', 'kind', 'reason', 'expectedUpdatedAt'].includes(key)) || !uuid(meta.requestId) || !Object.hasOwn(CORRECTION_KEYS, meta.kind) || typeof meta.expectedUpdatedAt !== 'string') throw correctionError('Send a correction with its kind, a unique request ID and the timecard version you corrected.');
  const kind = meta.kind, requestId = meta.requestId.toLowerCase(), reason = text(meta.reason, 500);
  if (reason.length < 3) throw correctionError('Give a reason for this correction. It is kept in the timecard history.');
  if (Object.keys(incoming).some(key => !CORRECTION_KEYS[kind].includes(key))) throw correctionError(kind === 'close' ? 'Closing a shift sets only its clock-out time.' : 'A correction sets clock-in, clock-out, breaks, job and rate only.');
  // A rate is refused from anyone who may not set pay before any replay is compared, so no answer depends on pay they
  // cannot see. The rate is a plain amount with at most two decimals, sent as a number or a string.
  const rateSent = own(incoming, 'hourlyRate');
  if (rateSent && !canSetPay(session, env)) throw payChangeRefused();
  const rate = rateSent ? typeof incoming.hourlyRate === 'number' ? incoming.hourlyRate : typeof incoming.hourlyRate === 'string' && /^\s*\d+(?:\.\d{1,2})?\s*$/.test(incoming.hourlyRate) ? Number(incoming.hourlyRate) : NaN : existing.hourlyRate;
  if (rateSent && !(Number.isFinite(rate) && rate >= 0 && rate <= 1000 && Math.round(rate * 100) / 100 === rate)) throw correctionError('Enter an hourly rate from 0 to 1000, such as 22 or 22.50.');
  // What was asked, from the request alone: a retry of a correction that already landed is recognised before the card's
  // present state (closed, or changed since) is checked, and answers with the saved card. The rate sent is part of it and
  // stays in the history like the rate change itself, which a reader without pay access never gets (payHidden).
  const end = correctedInstant(incoming.clockOutAt, 'clock-out time'), asked = kind === 'close' ? null : correctedInstant(incoming.clockInAt, 'clock-in time');
  if (kind === 'correct' && (!Array.isArray(incoming.breaks) || incoming.breaks.length > MAX_BREAKS)) throw correctionError(`Send the shift's breaks as a list of at most ${MAX_BREAKS}.`);
  const request = kind === 'close' ? { kind, clockOutAt: iso(end) } : { kind, clockInAt: iso(asked), clockOutAt: iso(end),
    breaks: incoming.breaks.map(item => ({ startAt: iso(correctedInstant(item?.startAt, 'break start')), endAt: iso(correctedInstant(item?.endAt, 'break end')), ...(item?.kind ? { kind: item.kind } : {}) })), ...(own(incoming, 'jobId') ? { jobId: incoming.jobId } : {}), ...(rateSent ? { hourlyRate: rate } : {}) };
  // A request ID is the manager's own: the same ID from anyone else is a conflict whatever it carries.
  const history = Array.isArray(existing.history) ? existing.history : [], earlier = history.find(item => item?.correctionRequestId === requestId);
  if (earlier) {
    if (text(earlier.actor).toLowerCase() === text(session.user).toLowerCase() && earlier.reason === reason && equal(earlier.request, request)) return existing;
    throw correctionError('This correction request was already saved with different values. Refresh, then correct the timecard again.', 409, 'EMPLOYEE_TIMECARD_IDEMPOTENCY_CONFLICT');
  }
  if (String(existing.updatedAt || '') !== meta.expectedUpdatedAt) throw correctionError('This timecard changed since you opened it. Refresh, then correct it again.', 409, 'EMPLOYEE_TIMECARD_CHANGED');
  const open = activeTimecard(existing) || !existing.clockOutAt;
  if (kind === 'close' && !open) throw correctionError('This shift is already closed. Use Correct time to change its clock-out.', 409);
  const start = kind === 'close' ? instant(existing.clockInAt) : asked, server = instant(now);
  if (!Number.isFinite(start)) throw correctionError('This shift’s clock-in time cannot be read. Use Correct time to set it.', 409);
  if (end <= start) throw correctionError('The clock-out time must be after the clock-in time.');
  if (end - start > MAX_CORRECTED_SHIFT) throw correctionError('A corrected shift can be at most 24 hours long.');
  if (end > server + DEVICE_SKEW) throw correctionError('The clock-out time cannot be in the future.');
  let breaks;
  if (kind === 'close') {
    breaks = (Array.isArray(existing.breaks) ? existing.breaks : []).map(item => item?.endAt ? item : { ...item, endAt: iso(end) });
    if (breaks.some(item => !(instant(item?.startAt) < end) || !(instant(item?.endAt) <= end))) throw correctionError('A break was recorded after that time. Pick a later clock-out, or use Correct time to fix the breaks.', 409);
  } else breaks = correctedBreaks(incoming.breaks, existing.breaks, start, end);
  const jobId = own(incoming, 'jobId') ? incoming.jobId : existing.jobId || '', jobChanged = own(incoming, 'jobId') && text(jobId) !== text(existing.jobId);
  if (typeof jobId !== 'string' || jobId && !validJobId(jobId)) throw correctionError('Choose a job from the schedule for this timecard.');
  if (jobChanged && jobId && typeof jobLabel !== 'string') throw correctionError('Choose a job from the schedule for this timecard.', 404);
  let next = { ...existing, clockInAt: kept(existing.clockInAt, start), clockOutAt: kept(existing.clockOutAt, end), breaks, jobId, ...(jobChanged ? { jobLabel: jobId ? text(jobLabel) : '' } : {}),
    ...(rateSent ? { hourlyRate: Math.round(rate * 100) / 100 } : {}), status: 'submitted', approvalStatus: 'pending', approvedAt: '', approvedBy: '' };
  if (open) Object.assign(next, { locationTracking: false, locationStatus: 'stopped' });
  const clipped = clipJobTracking(next, start, end, session, now);
  if (clipped.changes.length) next.jobTracking = clipped.jobTracking;
  const changed = clipped.changes.length || ['clockInAt', 'clockOutAt', 'jobId', 'hourlyRate'].some(key => !equal(existing[key] ?? '', next[key] ?? '')) || !equal(existing.breaks || [], breaks);
  if (!changed) throw correctionError('Nothing changed. Change a time, break, job or rate before saving the correction.');
  next.hours = timecardHours(next);
  if (next.hours <= 0) throw correctionError('A corrected shift needs work time outside its breaks.');
  next.grossEstimate = Math.round(next.hours * Math.max(0, Number(next.hourlyRate || 0)) * 100) / 100;
  next = { ...next, correctedAt: now, correctedBy: session.user, correctionReason: reason };
  return withAudit(existing, next, session, now, kind === 'close' ? 'manager_shift_close' : 'manager_time_correction',
    { reason, correctionRequestId: requestId, request, ...(clipped.changes.length ? { segments: clipped.changes } : {}) });
}

// A Hub action queued on the device (queued) is built on the device's own copy, which has no server request IDs yet, so
// its earlier breaks are compared by their times; the rows kept are always the server's. Every other save compares the
// earlier rows whole, as before.
const breakTimes = rows => rows.map(item => ({ startAt: item?.startAt, endAt: item?.endAt }));

function changeBreak(existing, incoming, stamp, queued = false) {
  if (!Array.isArray(incoming) || incoming.length > 100) throw timecardError('A valid break action is required.');
  const previous = Array.isArray(existing) ? existing : [], earlier = queued ? breakTimes : rows => rows;
  const last = previous.at(-1), proposed = incoming.at(-1), request = uuid(proposed?.requestId) ? proposed.requestId.toLowerCase() : '';
  if (equal(previous, incoming)) return previous;
  // A queued crew break keeps its request ID, so a replay after the break was
  // changed elsewhere is a no-op instead of a second break.
  if (request && previous.some(item => item?.startRequestId === request || item?.endRequestId === request)) return previous;
  if (!last?.endAt && last) {
    if (incoming.length !== previous.length || !equal(earlier(incoming.slice(0, -1)), earlier(previous.slice(0, -1)))) throw timecardError('Only the current break can be ended.');
    // The browser sends its capture time; the server owns both break timestamps.
    if (!proposed?.endAt) return previous;
    if (proposed.startAt !== last.startAt) throw timecardError('The break changed. Refresh your timecard before ending it.', 409);
    return [...previous.slice(0, -1), { ...last, endAt: stamp(), ...(request ? { endRequestId: request } : {}) }];
  }
  if (incoming.length === previous.length + 1 && equal(earlier(incoming.slice(0, -1)), earlier(previous)) && proposed && !proposed.endAt) return [...previous, { startAt: stamp(), endAt: '', ...(request ? { startRequestId: request } : {}) }];
  if (last && incoming.length === previous.length && equal(earlier(incoming.slice(0, -1)), earlier(previous.slice(0, -1))) && proposed.startAt === last.startAt && proposed.endAt) return previous;
  throw timecardError('Recorded breaks cannot be rewritten. Ask a manager for a time correction.', 403);
}

// The Hub's own clock actions, as its offline queue keeps them (employee-offline-queue.js describe()): a clock-in (an
// open shift with its start time, sharing location), a clock-out (only the clock-out fields; the crew app adds its
// capture time) and a break started or ended (the breaks, with the new one's request ID).
const CLOCK_OUT_KEYS = ['clockOutAt', 'status', 'approvalStatus', 'hours', 'grossEstimate', 'locationTracking', 'locationStatus', 'updatedAt', 'deviceCapturedAt'];
const clockInSave = incoming => incoming.status === 'active' && !incoming.clockOutAt && typeof incoming.clockInAt === 'string' && incoming.locationTracking === true;
const clockOutSave = incoming => Boolean(incoming.clockOutAt) && incoming.status === 'submitted' && Object.keys(incoming).every(key => CLOCK_OUT_KEYS.includes(key));
const breakSave = incoming => Array.isArray(incoming.breaks) && Object.keys(incoming).every(key => ['breaks', 'updatedAt', 'deviceCapturedAt'].includes(key));
const sameEmployee = (entry, session) => text(entry?.employee).toLowerCase() === text(session?.user).toLowerCase();

// A manager's own queued break (queuedClock): the time the Hub showed for it is kept, as for every manager save, and it
// is recorded as an employee's is, once (a replay is a no-op by its request ID) and only on an open shift. On a closed
// one it is refused unless it is already there.
function managerBreak(existing, incoming, now) {
  const previous = Array.isArray(existing.breaks) ? existing.breaks : [], proposed = incoming.at(-1);
  if (!activeTimecard(existing)) {
    const request = uuid(proposed?.requestId) ? proposed.requestId.toLowerCase() : '';
    if (request && previous.some(item => item?.startRequestId === request || item?.endRequestId === request) || equal(breakTimes(previous), breakTimes(incoming))) return previous;
    throw timecardError('This shift is closed, so this break was not recorded. Correct the timecard’s breaks instead.', 409);
  }
  const shown = instant(proposed?.endAt || proposed?.startAt);
  return changeBreak(previous, incoming, () => Number.isFinite(shown) ? new Date(shown).toISOString() : now, true);
}

// A manager's own clock action kept on a device (queued: the offline queue's request ID is in the body) is sent again,
// with the same body, until an answer arrives, so like an employee's it is applied once. Its replay after a lost reply
// never reopens, un-approves or rewrites a card changed since, here or on another device: a clock-in replayed onto its
// timecard, or a clock-out onto a closed one, changes nothing, and a break goes through managerBreak. Returns the
// existing card for a no-op, the save to apply otherwise (a break as the server's rows). The manager's first clock-in
// and a clock-out of an open shift are saved as before, as are direct saves (administrative corrections and reopening a
// shift, and every save with HUB_OFFLINE_ENABLED off).
function queuedClock(existing, incoming, now) {
  if (clockInSave(incoming)) return existing;
  if (clockOutSave(incoming)) return existing.clockOutAt ? existing : incoming;
  if (!breakSave(incoming)) return incoming;
  const breaks = managerBreak(existing, incoming.breaks, now);
  return equal(breaks, existing.breaks ?? []) ? existing : { breaks };
}

export function authorizeTimecard({ session, manager, id, incoming, existing, hourlyRate = 0, now = new Date().toISOString(), env = {}, queued = false, jobLabel = null }) {
  const device = offlineClockEnabled(env);
  // jobTime is what /api/employee-hub derives for display on each read; a save never stores it.
  if (own(incoming, 'jobTime')) { const { jobTime, ...rest } = incoming; incoming = rest; }
  if (own(incoming, 'correction')) return correctTimecard({ session, manager, existing, incoming, now, env, jobLabel });
  if (incoming.jobAction) {
    if (Object.keys(incoming).some(key => key !== 'jobAction')) throw timecardError('Send job-time changes separately from other timecard edits.');
    const action = incoming.jobAction, segments = Array.isArray(existing?.jobTracking?.segments) ? existing.jobTracking.segments : [];
    const captured = action && typeof action === 'object' && own(action, 'deviceCapturedAt');
    // A replayed receipt stays an exact no-op even after later events move the device-time floor, as does a switch to
    // where the shift already is.
    if (!device || !captured || !existing || text(existing.employee).toLowerCase() !== text(session.user).toLowerCase() || segments.some(segment => segment?.id === action.requestId) || jobActionSatisfied(existing, action)) {
      const next = applyEmployeeJobAction(existing, action, session, now);
      if (!device && captured && next !== existing) serverClockTime(action.deviceCapturedAt, now);
      return next;
    }
    const at = deviceClockTime(action.deviceCapturedAt, now, existing);
    return deviceStamp({ ...applyEmployeeJobAction(existing, action, session, at), updatedAt: now }, 'job_time', action.deviceCapturedAt, at, now);
  }
  if (own(incoming, 'jobTracking') && !equal(incoming.jobTracking, existing?.jobTracking)) throw timecardError('Job time segments are server records and cannot be replaced.', 403);
  if (manager) {
    if (queued && existing && sameEmployee(existing, session)) {
      const save = queuedClock(existing, incoming, now);
      if (save === existing) return existing;
      incoming = save;
    } else if (existing && sameEmployee(existing, session) && activeTimecard(existing) && clockInSave(incoming)) return existing;
    let next = { ...(existing || {}), ...incoming, id };
    // A new timecard names its employee, so a location update for a shift the server does not have (a queued clock-in
    // not yet replayed, discarded or refused) never creates an employee-less record out of it. Administrative imports
    // and corrections that name the employee are created as before.
    if (!existing && !text(next.employee)) throw timecardError('A new timecard needs an employee.');
    // Another employee's timecard (any save to it, a new card naming them, or one's own card moved to them) is saved only
    // by whoever approves time, as a correction is: time.approve. With EGC_STAFF_ROLE_PERMISSIONS off (legacy mode) that is
    // every business user, which is what manager already is, so nothing changes; with it on, a business user whose stored
    // roles lack it (sales, phone) is refused. The viewer's own card is saved as before.
    if ((existing && !sameEmployee(existing, session) || !sameEmployee(next, session)) && capabilityMode(session, env) !== 'legacy' && !can(session, 'time.approve', env)) throw timecardError('Only a manager or the owner can change another employee’s timecard.', 403);
    if (!existing && clockInSave(incoming)) next = managerClockIn(next, env, session);
    // A shift's location record is final once it starts, for a manager too (an employee's save is refused below): a
    // position fix, error or status sent for an open shift, or for a shift being reopened, is refused, and a closed shift
    // keeps its clock-out location status (a Hub tab whose location watch outlived the shift). A save that repeats the
    // stored values is unaffected, and reopening a shift never turns location tracking back on.
    if (existing && (activeTimecard(existing) || activeTimecard(next)) && locationUpdate(existing, incoming)) throw clockInOnly();
    if (existing && !activeTimecard(existing) && !activeTimecard(next) && lateLocation(existing, incoming)) throw timecardError('This shift is closed, so its location is no longer updated.', 409);
    if (existing && incoming.locationTracking === true) next.locationTracking = existing.locationTracking === true;
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
    const at = stamp(null), place = clockInLocation(incoming, at, now, env);
    const entry = { id, employee: session.user, employeeName: session.displayName, role: session.role,
      payType: session.payType, hourlyRate, clockInAt: at, clockOutAt: '', status: 'active', approvalStatus: 'open', approvedBy: '', approvedAt: '',
      jobId: text(incoming.jobId), jobLabel: text(incoming.jobLabel), ...place,
      jobTracking: initializeJobTracking(id, session, at), breaks: [], createdAt: now,
      recordedBy: session.user, recordingVersion: 1 };
    return withAudit(null, flagged ? deviceStamp(entry, 'clock_in', deviceValue, at, now) : entry, session, now, 'clock_in');
  }
  if (text(existing.employee).toLowerCase() !== text(session.user).toLowerCase()) throw timecardError('This timecard belongs to another employee.', 403);
  if (!activeTimecard(existing) || ['approved', 'rejected', 'pending'].includes(existing.approvalStatus)) {
    // An uncertain clock-out response may be safely retried without reopening,
    // changing, or revoking the already submitted/approved card.
    if (existing.clockOutAt && clockOutSave(incoming)) return existing;
    throw timecardError('Only a manager can correct a submitted, approved, or rejected timecard.', 403);
  }
  // A clock-in sent again after a lost reply answers with the open card it created.
  if (incoming.locationTracking === true) return existing;
  if (locationUpdate(existing, incoming)) throw clockInOnly();
  const next = { ...existing };
  // Identity, pay, original clock-in and historical attribution cannot be
  // changed by a full-record browser retry or forged client fields.
  if (own(incoming, 'jobId') && text(incoming.jobId) !== text(existing.jobId)) throw timecardError('Use Start job time or Switch job time so earlier shift hours keep their original job.', 409);
  if (own(incoming, 'notes')) next.notes = text(incoming.notes, 2000);
  let breakAt = '';
  if (own(incoming, 'breaks')) next.breaks = changeBreak(existing.breaks, incoming.breaks, () => (breakAt = stamp(existing)), queued);
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
