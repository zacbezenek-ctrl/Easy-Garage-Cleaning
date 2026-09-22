const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const text = (value, limit = 180) => String(value || '').trim().slice(0, limit);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const timeFields = ['employee', 'clockInAt', 'clockOutAt', 'breaks', 'jobId', 'hourlyRate', 'bonus', 'tips'];
const auditFields = [...timeFields, 'status', 'approvalStatus', 'notes'];

export function timecardError(message, status = 400) {
  return Object.assign(new Error(message), { code: 'EMPLOYEE_TIMECARD_INVALID', status });
}

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

function withAudit(existing, next, session, now, action) {
  const changes = auditFields.filter(key => !equal(existing?.[key], next[key]));
  const history = Array.isArray(existing?.history) ? existing.history : [];
  return { ...next, workDate: timecardWorkDate(next.clockInAt), updatedAt: now, updatedBy: session.user,
    history: changes.length ? [...history, { action, actor: session.user, actorName: session.displayName || session.user, at: now,
      changes: Object.fromEntries(changes.map(key => [key, { before: existing?.[key] ?? null, after: next[key] ?? null }])) }] : history };
}

function changeBreak(existing, incoming, now) {
  if (!Array.isArray(incoming) || incoming.length > 100) throw timecardError('A valid break action is required.');
  const previous = Array.isArray(existing) ? existing : [];
  const last = previous.at(-1), proposed = incoming.at(-1);
  if (equal(previous, incoming)) return previous;
  if (!last?.endAt && last) {
    if (incoming.length !== previous.length || !equal(incoming.slice(0, -1), previous.slice(0, -1))) throw timecardError('Only the current break can be ended.');
    // The browser sends its capture time; the server owns both break timestamps.
    if (!proposed?.endAt) return previous;
    if (proposed.startAt !== last.startAt) throw timecardError('The break changed. Refresh your timecard before ending it.', 409);
    return [...previous.slice(0, -1), { ...last, endAt: now }];
  }
  if (incoming.length === previous.length + 1 && equal(incoming.slice(0, -1), previous) && proposed && !proposed.endAt) return [...previous, { startAt: now, endAt: '' }];
  if (last && incoming.length === previous.length && equal(incoming.slice(0, -1), previous.slice(0, -1)) && proposed.startAt === last.startAt && proposed.endAt) return previous;
  throw timecardError('Recorded breaks cannot be rewritten. Ask a manager for a time correction.', 403);
}

export function authorizeTimecard({ session, manager, id, incoming, existing, hourlyRate = 0, now = new Date().toISOString() }) {
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
    if (next.clockInAt && next.clockOutAt) {
      next.hours = timecardHours(next);
      next.grossEstimate = Math.round(next.hours * Math.max(0, Number(next.hourlyRate || 0)) * 100) / 100;
    }
    return withAudit(existing, next, session, now, existing ? 'manager_timecard_update' : 'manager_timecard_create');
  }
  if (!existing) {
    if (incoming.locationTracking !== true) throw timecardError('Shift location is required to clock in.');
    const point = location(incoming.lastLocation, now);
    return withAudit(null, { id, employee: session.user, employeeName: session.displayName, role: session.role,
      payType: session.payType, hourlyRate, clockInAt: now, clockOutAt: '', status: 'active', approvalStatus: 'open', approvedBy: '', approvedAt: '',
      jobId: text(incoming.jobId), jobLabel: text(incoming.jobLabel), locationTracking: true, locationConsentAt: now,
      locationStatus: 'tracking', lastLocation: point, locationTrail: [point], locationUpdatedAt: now, breaks: [], createdAt: now,
      recordedBy: session.user, recordingVersion: 1 }, session, now, 'clock_in');
  }
  if (text(existing.employee).toLowerCase() !== text(session.user).toLowerCase()) throw timecardError('This timecard belongs to another employee.', 403);
  if (!activeTimecard(existing) || ['approved', 'rejected', 'pending'].includes(existing.approvalStatus)) {
    // An uncertain clock-out response may be safely retried without reopening,
    // changing, or revoking the already submitted/approved card.
    const clockOutKeys = ['clockOutAt', 'status', 'approvalStatus', 'hours', 'grossEstimate', 'locationTracking', 'locationStatus', 'updatedAt'];
    if (existing.clockOutAt && incoming.clockOutAt && incoming.status === 'submitted' && Object.keys(incoming).every(key => clockOutKeys.includes(key))) return existing;
    throw timecardError('Only a manager can correct a submitted, approved, or rejected timecard.', 403);
  }
  const next = { ...existing };
  // Identity, pay, original clock-in and historical attribution cannot be
  // changed by a full-record browser retry or forged client fields.
  if (own(incoming, 'jobId')) { next.jobId = text(incoming.jobId); next.jobLabel = text(incoming.jobLabel); }
  if (own(incoming, 'notes')) next.notes = text(incoming.notes, 2000);
  if (own(incoming, 'breaks')) next.breaks = changeBreak(existing.breaks, incoming.breaks, now);
  if (incoming.lastLocation) {
    const point = location(incoming.lastLocation, now);
    next.lastLocation = point; next.locationTrail = [...(existing.locationTrail || []), point].slice(-120); next.locationUpdatedAt = now;
  }
  if (['tracking', 'unavailable'].includes(incoming.locationStatus)) next.locationStatus = incoming.locationStatus;
  if (own(incoming, 'locationError')) next.locationError = text(incoming.locationError, 120);
  if (incoming.clockOutAt || incoming.status === 'submitted') {
    if (!incoming.clockOutAt || incoming.status !== 'submitted') throw timecardError('A complete clock-out action is required.');
    next.clockOutAt = now; next.status = 'submitted'; next.approvalStatus = 'pending';
    next.breaks = (next.breaks || []).map(item => item.endAt ? item : { ...item, endAt: now });
    next.locationTracking = false; next.locationStatus = 'stopped';
    next.hours = timecardHours(next); next.grossEstimate = Math.round(next.hours * Math.max(0, Number(next.hourlyRate || 0)) * 100) / 100;
    return withAudit(existing, next, session, now, 'clock_out');
  }
  timecardHours(next, Date.parse(now));
  return withAudit(existing, next, session, now, own(incoming, 'breaks') ? 'break_update' : 'timecard_update');
}
