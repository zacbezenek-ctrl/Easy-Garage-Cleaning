import { getHubSession, hasBusinessAccess, listHubUserProfiles } from '../_lib/hub-session.js';
import { OWNER_USERNAME } from '../_lib/business-users.js';
import { firebaseServiceAccountConfigured, firestoreFetch } from '../_lib/firebase-service-account.js';
import { employeeVaultSecret, employeeVaultReadOnly } from '../_lib/employee-vault-key.js';
import { EMPLOYEE_HUB_COLLECTIONS, expectedDocument, firestoreDoc, readAll, readCollection, readOne, seal, unreadableStorage, writeOne } from '../_lib/employee-vault.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { listEmployeeApplications, normalizeEmployeeUsername } from '../_lib/employee-accounts.js';
import { activeTimecard, authorizeTimecard, clockInWithoutFix, correctionJobId, timecardCorrectionsEnabled, timecardError } from '../_lib/employee-timecards.js';
import { activeJobSegment, applyCrewJobMove, crewJobMoveState, employeeJobTime, jobStatusMovesTime, jobTimeView, ownJobTimeProjection } from '../_lib/employee-job-time.js';
import { fieldJobLead } from '../_lib/field-permissions.js';
import { assignedOn, fieldVisitsEnabled } from '../_lib/field-execution-visits.js';
import { denverToday } from '../_lib/dispatch-time.js';
import { ptoOffOn } from '../_lib/pto-pay.js';
import { legacyManagerProfile, legacyProfileView, mirrorLegacyPay, profileHourlyRate } from '../_lib/staff-directory.js';
import { assertNoOthersPay, assertPayUnchanged, canSetPay, payHidden, payOwnerField, seesOthersPay, visiblePay, withoutPayWrites } from '../_lib/pay-visibility.js';
import { can, staffPasswordResetEnabled } from '../_lib/staff-roles.js';

const PROJECT_ID = 'egcw-1ec83';
const COLLECTIONS = EMPLOYEE_HUB_COLLECTIONS;
const TRAINING_VERSION = '2026-09-employee-os-v1';
const TRAINING_CHECKS = new Map([['welcome', { answer: 1 }], ['safety', { answer: 2, supervisor: true }], ['property', { answer: 1 }], ['truck', { answer: 1, supervisor: true }], ['proof', { answer: 1 }], ['closeout', { answer: 0 }]]);
const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// A Hub action kept on the device (employee-offline-queue.js, HUB_OFFLINE_ENABLED) carries its request ID in the body;
// the Hub's direct saves and the crew app's never do, so only queued sends get the replay allowances below.
const QUEUED_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A new timecard's ID is data, never markup or script: the manager boards carry it in an escaped data attribute, and older
// screens put record IDs inside inline handlers. The Hub sends time-<letters and digits>-<base36 time>; the crew app sends
// time-<signed-in username>-<base36 time> from the raw username, and a configured one (HUB_AUTH_USERS_JSON,
// HUB_AUTH_ADDITIONAL_USERS_JSON) may hold '@', '+' or a space. So only what can end an HTML attribute or a JS string is
// refused: quotes, backslash, backtick, < > &, and control characters or whitespace other than a plain space. A space
// is kept because the older server took any ID up to 180 characters, so a crew clock-in queued on a phone before this
// build replays under its same ID. Timecards saved earlier under any other ID stay readable and savable.
const UNSAFE_TIMECARD_ID = /['"\\`<>&\p{Cc}]|[^\S ]/u;
const newTimecardId = id => id.length > 0 && id.length <= 180 && !UNSAFE_TIMECARD_ID.test(id);

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

function vaultSecret(env) {
  return employeeVaultSecret(env);
}

function decodeValue(field) {
  if (!field) return undefined;
  if ('stringValue' in field) return field.stringValue;
  if ('integerValue' in field) return Number(field.integerValue);
  if ('doubleValue' in field) return Number(field.doubleValue);
  if ('booleanValue' in field) return Boolean(field.booleanValue);
  if ('timestampValue' in field) return field.timestampValue;
  if ('nullValue' in field) return null;
  if ('arrayValue' in field) return (field.arrayValue?.values || []).map(decodeValue);
  if ('mapValue' in field) return Object.fromEntries(Object.entries(field.mapValue?.fields || {}).map(([key, value]) => [key, decodeValue(value)]));
  return undefined;
}

async function readJob(env, id) {
  const safeId = String(id || '').trim();
  if (!safeId || safeId.length > 180) return null;
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(safeId)}`;
  const response = await firestoreFetch(env, url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Job access check failed (${response.status})`);
  const document = await response.json();
  return { ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])), id: safeId, __updateTime: document.updateTime || '' };
}

// Server integrations read authoritative approved timecards through the same vault.
export async function readEmployeeTimecards(env) {
  return readCollection(env, 'timeEntries');
}

// Payroll reads timecards and time-off requests through the per-family vault reads
// (readCollection: one query per family, whole-vault fallback when the index is
// missing or EGC_EMPLOYEE_VAULT_QUERY=legacy). Returns {name: records[]} for each name.
export async function readEmployeeHubRecords(env, names) {
  const records = Object.fromEntries(names.map(name => [name, []]));
  for (const name of Object.keys(records)) records[name] = await readCollection(env, name);
  return records;
}

async function writeTimecard(env, session, id, data, target) {
  if (data === target.data) return data;
  let assignedJobGuard = null;
  const segment = activeJobSegment(data), previousSegment = activeJobSegment(target.data);
  if (segment?.jobId && segment.id !== previousSegment?.id) {
    const job = await readJob(env, segment.jobId);
    if (!job || job.type !== 'job' || job.recordType || ['completed', 'invoiced', 'paid', 'review_requested', 'cancelled', 'canceled'].includes(job.pipelineStatus || job.status) || !await createJobAssignmentAccess(env, session).assigned(job)) throw timecardError('New job time is limited to your currently assigned active jobs.', 403);
    if (!job.__updateTime) throw unreadableStorage();
    segment.jobLabel = String(job.customer || job.serviceType || 'Assigned job').slice(0, 180);
    assignedJobGuard = { update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/jobs/${job.id}`, fields: { type: { stringValue: 'job' } } }, updateMask: { fieldPaths: ['type'] }, currentDocument: { updateTime: job.__updateTime } };
  }
  if (!manager(session) && data.jobId && data.jobId !== target.data?.jobId) {
    const job = await readJob(env, data.jobId);
    if (!job || !await createJobAssignmentAccess(env, session).assigned(job)) throw timecardError('This job time is limited to your assigned jobs.', 403);
    data.jobLabel = String(job.customer || job.serviceType || 'Assigned job').slice(0, 180);
  }
  if (!activeTimecard(data) && !activeTimecard(target.data)) return writeOne(env, 'timeEntries', id, data, target);
  const employee = personKey(data.employee);
  if (!employee) throw timecardError('An employee is required for an active timecard.');
  const lock = await readOne(env, 'timeLocks', employee);
  if (activeTimecard(data)) {
    if (lock.data?.entryId && lock.data.entryId !== id) {
      const held = await readOne(env, 'timeEntries', lock.data.entryId);
      if (activeTimecard(held.data)) throw timecardError('You already have an active shift. Refresh and clock out before starting another.', 409);
    }
    // Backfill the per-employee guard without ignoring shifts saved before it
    // existed. The guard version serializes concurrent attempts with new IDs.
    if (!activeTimecard(target.data)) {
      const other = (await readEmployeeTimecards(env)).find(entry => entry.id !== id && same(entry.employee, employee) && activeTimecard(entry));
      if (other) throw timecardError('You already have an active shift. Refresh and clock out before starting another.', 409);
    }
  }
  const updatedAt = new Date().toISOString(), documentId = target.documentId;
  const encrypted = await seal(env, documentId, data);
  const writes = [{ update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/jobs/${documentId}`, ...firestoreDoc('timeEntries', documentId, encrypted, updatedAt) }, currentDocument: expectedDocument(target) }];
  if (assignedJobGuard) writes.push(assignedJobGuard);
  // Closing one legacy duplicate must not release another shift's guard.
  if (activeTimecard(data) || !lock.data?.entryId || lock.data.entryId === id) {
    const lockData = { id: employee, entryId: activeTimecard(data) ? id : '', updatedAt, updatedBy: session.user };
    const sealedLock = await seal(env, lock.documentId, lockData);
    writes.push({ update: { name: `projects/${PROJECT_ID}/databases/(default)/documents/employee_time_locks/${lock.documentId}`, ...firestoreDoc('timeLocks', lock.documentId, sealedLock, updatedAt) }, currentDocument: expectedDocument(lock) });
  }
  const response = await firestoreFetch(env, `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    if ([409, 412].includes(response.status) || ['FAILED_PRECONDITION', 'ABORTED', 'ALREADY_EXISTS', 'NOT_FOUND'].includes(failure.error?.status)) {
      throw Object.assign(new Error('Your timecard changed while saving. Refresh and retry.'), { code: 'EMPLOYEE_HUB_WRITE_CONFLICT' });
    }
    throw new Error(`Timecard storage could not confirm the save (${response.status}). Refresh before retrying.`);
  }
  return data;
}

const manager = session => hasBusinessAccess(session);
const withJobTime = (entry, now) => isRecord(entry) ? { ...entry, jobTime: jobTimeView(entry, now) } : entry;
const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
const personKey = value => String(value || '').trim().toLowerCase();
const legacyPersonKeys = value => [...new Set([
  personKey(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee',
  personKey(value).replace(/[^a-z0-9]/g, ''),
])].filter(key => key && key !== personKey(value));

async function readEmployeeProfile(env, username) {
  for (const id of [personKey(username), ...legacyPersonKeys(username)]) {
    const current = await readOne(env, 'profiles', id);
    if (current.data && same(current.data.username, username)) return current;
  }
  return { data: null };
}

async function jobMember(session, job, access) {
  if (manager(session)) return true;
  return access.assigned(job);
}

const CLOSED_JOB = ['completed', 'invoiced', 'paid', 'review_requested', 'cancelled', 'canceled'];
// EGC_JOB_STATUS_MOVES_TIME: the job's crew lead (or a manager) moves the job's assigned crew-mates who are clocked in on
// general time, or travelling to this job, onto work on it (crew/job.js asks the lead first). Each card keeps the move
// under the lead's request ID, so a replay changes nothing, and each is saved as that crew-mate's own job time (their
// assignment, their shift lock). With FIELD_MULTIDAY_VISITS a split job moves (and is moved by) only crew on today's Denver
// crew, as every field write is. A crew-mate on break, still clocked in from an earlier day (stale_shift) or on approved
// time off today (on_pto) is never moved. A crew-mate whose card cannot take the move is listed as skipped, so one card
// never holds the rest.
// Every crew-mate's state is worked out first. A replay whose crew-mates are all moved already (or skipped) is answered as
// it stands, however long it waited on the phone. Only a move still to make is held to an open job and to the server's
// time: one the lead's phone kept for more than 2 minutes is refused rather than moving people now for a tap made
// earlier, and the refusal names who the first attempt already moved (details.moved, alreadyApplied). Within the 2
// minutes a retry of a partly applied move finishes the rest.
async function moveCrewJobTime(env, session, action) {
  if (!jobStatusMovesTime(env)) throw timecardError('Moving crew-mates’ time is switched off.', 403);
  if (!isRecord(action) || !QUEUED_REQUEST.test(String(action.requestId ?? '')) || action.kind !== 'work' || typeof action.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(action.jobId) || /^(?:_egc_|secure_)/.test(action.jobId)) throw timecardError('Choose a job and a unique request ID to move crew-mates to work.');
  const now = new Date().toISOString(), captured = Date.parse(action.deviceCapturedAt ?? '');
  const job = await readJob(env, action.jobId);
  if (!job || job.type !== 'job' || job.recordType) throw timecardError('This job could not be found.', 404);
  const leadAccess = createJobAssignmentAccess(env, session), today = denverToday(new Date(now)), visits = fieldVisitsEnabled(env);
  if (!manager(session) && !await fieldJobLead({ session, job, access: leadAccess })) throw timecardError('Only this job’s crew lead or a manager can move crew-mates’ time.', 403);
  if (!manager(session) && visits && !await assignedOn(job, today, leadAccess)) throw timecardError('You are not scheduled on this job today, so you cannot move crew-mates’ time to it.', 403);
  const moved = [], skipped = [], pending = [];
  // Approved time off is read once, only when a crew-mate is clocked in on this job.
  let requests = null;
  const onPto = async employee => (requests ??= await readCollection(env, 'requests')).some(request => same(request?.employee, employee) && ptoOffOn(request, today));
  for (const entry of (await readEmployeeTimecards(env)).filter(row => activeTimecard(row) && !same(row.employee, session.user))) {
    const mate = { user: entry.employee, displayName: entry.employeeName || entry.employee }, who = { employee: entry.employee, name: String(entry.employeeName || entry.employee).slice(0, 120) }, access = createJobAssignmentAccess(env, mate);
    if (!await access.assigned(job)) continue;
    const target = await readOne(env, 'timeEntries', entry.id), options = { onPto: await onPto(entry.employee) }, state = crewJobMoveState(target.data, action.jobId, action.requestId, now, options);
    if (state === 'moved') { moved.push({ ...who, alreadyApplied: true }); continue; }
    if (state === 'move' && visits && !await assignedOn(job, today, access)) { skipped.push({ ...who, reason: 'not_scheduled_today' }); continue; }
    if (state !== 'move') { skipped.push({ ...who, reason: state }); continue; }
    pending.push({ entry, target, mate, who, options });
  }
  if (pending.length) {
    // Nobody is moved; the answer says who an earlier attempt of this same move already moved.
    const refuse = (message, code) => Object.assign(timecardError(message, 409), { code, crewMove: { jobId: action.jobId, moved, skipped, notMoved: pending.map(row => row.who) } });
    const names = rows => rows.map(row => row.name).join(', ');
    if (CLOSED_JOB.includes(job.pipelineStatus || job.status)) throw refuse(`This job is closed, so crew time cannot move to it.${moved.length ? ` Already moved to work here: ${names(moved)}.` : ''}`, 'EMPLOYEE_TIMECARD_INVALID');
    if (Number.isFinite(captured) && captured < Date.parse(now) - 120000) throw refuse(moved.length ? `This crew move waited on the phone too long to finish. Already moved to work here: ${names(moved)}. Not moved: ${names(pending.map(row => row.who))}. Ask them to start their own work time, or a manager to correct it.` : 'This crew move waited on the phone too long to apply now. Ask your crew-mates to start their own work time, or a manager to correct it.', 'EMPLOYEE_TIMECARD_DEVICE_TIME');
  }
  for (const { entry, target, mate, who, options } of pending) {
    try { await writeTimecard(env, mate, entry.id, applyCrewJobMove(target.data, action, session, now, options), target); moved.push({ ...who, alreadyApplied: false }); }
    catch (error) {
      // Storage failures stop the request (the lead's phone retries it, and a crew-mate already moved is not moved twice);
      // a refusal of this one card (a second open shift, timing that needs review) skips it.
      if (error.code !== 'EMPLOYEE_HUB_WRITE_CONFLICT' && !(error.status >= 400 && error.status < 500)) throw error;
      skipped.push({ ...who, reason: error.code === 'EMPLOYEE_HUB_WRITE_CONFLICT' ? 'changed' : error.status === 403 ? 'not_assigned' : 'needs_review' });
    }
  }
  return { ok: true, jobId: action.jobId, moved, skipped };
}

function visibleTo(session, collection, data) {
  if (manager(session) || ['announcements', 'teamMessages'].includes(collection)) return true;
  if (collection === 'jobMessages') return false;
  if (collection === 'messageReads') return same(data?.employee, session.user);
  const field = collection === 'profiles' ? 'username' : ['incidents', 'equipment'].includes(collection) ? 'reportedBy' : 'employee';
  return same(data?.[field], session.user);
}

function configuredProfiles(env) {
  return listHubUserProfiles(env).map(profile => ({
    id: personKey(profile.user),
    username: profile.user,
    displayName: profile.displayName,
    role: profile.role,
    payType: profile.payType,
    hourlyRate: profile.hourlyRate,
    status: 'active',
  }));
}

// The rate in effect today (Denver) from the staff directory's pay schedule, else the profile rate.
async function employeeRate(env, session, now) {
  const profile = await readEmployeeProfile(env, session.user);
  return profileHourlyRate(profile.data, now) ?? Math.max(0, Number(session.hourlyRate || 0));
}

// EGC_STAFF_PAY_OWNER_ONLY (default on): pay on profiles, timecards and time-off requests is the owner's (pay.manage).
// A save counts as the caller's own only when both the stored owner and the owner after the save are the caller.
// - Another employee's record: any pay field is refused (403 pay_owner_only) whatever its value, and a stored timecard
//   or time-off request never moves to another employee. The stored pay is never read for this, so a guess cannot be
//   confirmed.
// - Your own record: a pay change is refused; unchanged pay a form sends back (the ensureOwnProfile echo of the Hub
//   configuration, your own timecard) is accepted and then dropped, so the stored pay stays exactly as it was. Your own
//   new timecard snapshots the server rate, as a crew clock-in does.
// Approving time off still sets paid hours (hours, not a rate). Crew profile and timecard saves take pay only from the
// server (authorizeMutation ignores what they send); their time-off requests are checked here.
async function payGuard(env, session, collection, incoming, existing, now) {
  const field = payOwnerField(collection);
  if (!field || canSetPay(session, env) || (!manager(session) && collection !== 'requests')) return incoming;
  // grossEstimate is derived from the hours and the stored rate; the timecard rules recompute it.
  const input = collection === 'timeEntries' ? Object.fromEntries(Object.entries(incoming).filter(([key]) => key !== 'grossEstimate')) : incoming;
  const stored = existing ? existing[field] : undefined;
  // A crew member's request is saved as their own (and one already stored is refused later).
  const after = !manager(session) ? (existing ? stored : session.user) : Object.hasOwn(input, field) ? input[field] : stored;
  if (!((!existing || same(stored, session.user)) && same(after, session.user))) {
    assertNoOthersPay(session, env, collection, input, { moved: Boolean(existing) && !same(after, stored) });
    return input;
  }
  if (collection === 'timeEntries' && !existing) {
    const { payType, hourlyRate, ...own } = input;
    assertPayUnchanged(session, env, own, null);
    return { ...withoutPayWrites(own), payType: session.payType, hourlyRate: await employeeRate(env, session, now) };
  }
  // Your profile is compared with the pay the team board shows for it and the Hub configuration's pay (what
  // ensureOwnProfile sends and the save mirrors); a timecard or request with what is stored.
  assertPayUnchanged(session, env, input, ...(collection === 'profiles' ? [legacyProfileView(existing, now), session] : [existing]));
  return withoutPayWrites(input);
}

// A manager's timecard correction (EGC_TIMECARD_CORRECTIONS) that moves the card to another job labels it from that job,
// which must be a scheduled job; the timecard rules refuse the correction when there is none.
async function correctionJobLabel(env, session, incoming, existing) {
  const jobId = isRecord(incoming.correction) && manager(session) && can(session, 'time.approve', env) && timecardCorrectionsEnabled(env) ? correctionJobId(incoming.jobId) : '';
  if (!jobId || jobId === existing?.jobId) return null;
  const job = await readJob(env, jobId);
  return job && job.type === 'job' && !job.recordType ? String(job.customer || job.serviceType || 'Assigned job').slice(0, 180) : null;
}

async function authorizeMutation(env, session, collection, id, incoming, existing, queued = false) {
  const now = new Date().toISOString();
  incoming = await payGuard(env, session, collection, incoming, existing, now);
  if (collection === 'timeEntries') return authorizeTimecard({ session, manager: manager(session), id, incoming, existing,
    hourlyRate: existing?.hourlyRate ?? await employeeRate(env, session, now), now, env, queued, jobLabel: await correctionJobLabel(env, session, incoming, existing) });
  if (manager(session) && !(collection === 'training' && incoming.moduleId)) return collection === 'profiles' ? legacyManagerProfile({ env, session, existing, incoming, id, now }) : { ...(existing || {}), ...incoming, id };

  if (collection === 'profiles') {
    if (id !== personKey(session.user)) throw new Error('You can only update your own employee profile');
    if (existing && !same(existing.username, session.user)) throw new Error('This profile belongs to another employee; ask the owner to resolve the legacy profile ID conflict');
    const text = (value, limit) => String(value || '').trim().slice(0, limit);
    const requiredAcknowledgements = ['timekeeping', 'location_policy', 'safety', 'customer_care', 'hub_basics'];
    if (incoming.onboardingCompletedAt && !requiredAcknowledgements.every(value => incoming.onboardingAcknowledgements?.includes(value))) throw new Error('All onboarding acknowledgements are required');
    const completedAt = Date.parse(existing?.onboardingCompletedAt || '');
    const incomingAt = Date.parse(incoming.onboardingCompletedAt || incoming.onboardingDraftAt || '');
    // A request captured before a completed submission cannot restore stale contact details.
    const staleOnboarding = Number.isFinite(completedAt) &&
      Boolean(incoming.onboardingCompletedAt || incoming.onboardingDraftAt) &&
      (!Number.isFinite(incomingAt) || incomingAt <= completedAt);
    const onboarding = staleOnboarding ? {} : incoming.onboardingCompletedAt ? {
      preferredName: text(incoming.preferredName, 80),
      phone: text(incoming.phone, 40),
      emergencyContactName: text(incoming.emergencyContactName, 100),
      emergencyContactPhone: text(incoming.emergencyContactPhone, 40),
      onboardingVersion: '2026-09-location-v2',
      onboardingAcknowledgements: requiredAcknowledgements,
      onboardingDraftAcknowledgements: [],
      onboardingDraftAt: '',
      onboardingCompletedAt: text(incoming.onboardingCompletedAt, 40),
    } : incoming.onboardingDraftAt ? {
      preferredName: text(incoming.preferredName, 80),
      phone: text(incoming.phone, 40),
      emergencyContactName: text(incoming.emergencyContactName, 100),
      emergencyContactPhone: text(incoming.emergencyContactPhone, 40),
      onboardingDraftAcknowledgements: Array.isArray(incoming.onboardingDraftAcknowledgements)
        ? incoming.onboardingDraftAcknowledgements.filter(value => ['timekeeping', 'locationPolicy', 'safety', 'customerCare', 'hubBasics'].includes(value))
        : [],
      onboardingDraftAt: text(incoming.onboardingDraftAt, 40),
    } : incoming.locationVerifiedAt ? {
      locationVerifiedAt: text(incoming.locationVerifiedAt, 40),
      locationVerificationAccuracy: Math.max(0, Math.min(10000, Number(incoming.locationVerificationAccuracy || 0))),
    } : {};
    return mirrorLegacyPay(existing, {
      ...(existing || {}), ...onboarding, id, username: session.user, displayName: session.displayName,
      role: session.role, payType: session.payType, hourlyRate: await employeeRate(env, session, now),
      status: 'active', lastSeenAt: now,
    }, now);
  }

  if (collection === 'announcements') {
    if (!existing) throw new Error('Announcement not found');
    return { ...existing, readBy: [...new Set([...(existing.readBy || []), session.user])], updatedAt: now };
  }

  // A device-queued send keeps its message ID, so the sender's own identical message is the one already saved. Direct
  // saves (and the Hub with HUB_OFFLINE_ENABLED off) are refused as before.
  if (queued && existing && ['teamMessages', 'jobMessages'].includes(collection) && same(existing.sender, session.user) && existing.body === String(incoming.body || '').trim().slice(0, 1200) && String(existing.jobId || '') === String(incoming.jobId || '').trim()) return existing;
  if (existing && !visibleTo(session, collection, existing)) throw new Error('This record belongs to another employee');

  if (collection === 'training') {
    const moduleId = String(incoming.moduleId || '');
    const module = TRAINING_CHECKS.get(moduleId);
    if (!module || Number(incoming.answer) !== module.answer) throw new Error('The training knowledge check was not passed');
    const current = existing?.version === TRAINING_VERSION ? existing : {};
    const completed = Array.isArray(current.completed) ? current.completed : [];
    const pending = Array.isArray(current.pendingSignoffs) ? current.pendingSignoffs : [];
    const passed = [...new Set([...(Array.isArray(current.passedModules) ? current.passedModules : completed), moduleId])];
    const nextCompleted = module.supervisor ? completed : [...new Set([...completed, moduleId])];
    const nextPending = module.supervisor ? [...new Set([...pending, moduleId])] : pending.filter(value => value !== moduleId);
    return { ...current, id, employee: session.user, version: TRAINING_VERSION, passedModules: passed,
      pendingSignoffs: nextPending, completed: nextCompleted, completedCount: nextCompleted.length,
      totalCount: TRAINING_CHECKS.size, lastKnowledgeCheckAt: now, updatedAt: now,
      ...(nextCompleted.length === TRAINING_CHECKS.size ? { completedAt: now } : {}) };
  }

  if (collection === 'teamMessages') {
    if (existing) throw new Error('Only a manager can change an existing team message');
    const body = String(incoming.body || '').trim().slice(0, 1200);
    if (!body) throw new Error('Message text is required');
    return { id, body, sender: session.user, senderName: session.displayName, createdAt: now, updatedAt: now, status: 'active' };
  }

  if (collection === 'jobMessages') {
    if (existing) throw new Error('Only a manager can change an existing job message');
    const jobId = String(incoming.jobId || '').trim();
    const job = await readJob(env, jobId);
    if (!job || !await jobMember(session, job, createJobAssignmentAccess(env, session))) throw new Error('This job room is limited to assigned crew');
    const body = String(incoming.body || '').trim().slice(0, 1200);
    if (!body) throw new Error('Message text is required');
    return { id, jobId, body, sender: session.user, senderName: session.displayName, createdAt: now, updatedAt: now, status: 'active' };
  }

  if (collection === 'messageReads') {
    const channel = String(incoming.channel || '').trim().slice(0, 180);
    if (!channel) throw new Error('Message channel is required');
    return { ...(existing || {}), id, employee: session.user, channel, lastReadAt: now, updatedAt: now };
  }

  if (['incidents', 'equipment'].includes(collection)) {
    if (existing) throw new Error('Only a manager can change a submitted safety record');
    return { ...incoming, id, reportedBy: session.user, status: 'open', resolvedBy: '', resolvedAt: '' };
  }

  throw new Error('Unsupported employee record');
}

export async function onRequestGet({ request, env }) {
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  const includeAccounts = new URL(request.url).searchParams.get('include') === 'accounts';
  // STAFF-ACCESS: with EGC_STAFF_PASSWORD_RESET on, a manager the owner lets approve accounts (accounts.approve) reads them too.
  if (includeAccounts && (!manager(session) || normalizeEmployeeUsername(session.user) !== OWNER_USERNAME) && !(staffPasswordResetEnabled(env) && manager(session) && can(session, 'accounts.approve', env))) {
    return reply(403, { ok: false, error: 'Only Zac can approve employee accounts' });
  }
  if (!vaultSecret(env) || !firebaseServiceAccountConfigured(env)) return reply(503, { ok: false, error: 'Employee Hub storage is not configured' });
  try {
    const params = new URL(request.url).searchParams;
    if (params.get('view') === 'own-job-time') {
      const lock = await readOne(env, 'timeLocks', personKey(session.user));
      let active = lock.data?.entryId ? (await readOne(env, 'timeEntries', lock.data.entryId)).data : null;
      if (!activeTimecard(active) || !same(active.employee, session.user)) {
        const candidates = (await readEmployeeTimecards(env)).filter(entry => same(entry.employee, session.user) && activeTimecard(entry));
        if (candidates.length > 1) return reply(409, { ok: false, error: 'More than one active shift needs manager review before job time can be started.' });
        active = candidates[0] || null;
      }
      return reply(200, { ok: true, user: session.user, entry: ownJobTimeProjection(active), clockInWithoutFix: clockInWithoutFix(env) });
    }
    if (params.get('view') === 'job-labor') {
      if (!manager(session)) return reply(403, { ok: false, error: 'Only operations managers can view employee time for a job.' });
      const jobId = params.get('jobId') || '';
      if (!/^[A-Za-z0-9_-]{1,180}$/.test(jobId) || /^(?:_egc_|secure_)/.test(jobId)) return reply(400, { ok: false, error: 'Choose a valid job.' });
      const job = await readJob(env, jobId);
      if (!job || job.type !== 'job' || job.recordType) return reply(404, { ok: false, error: 'This operational job could not be found.' });
      const entries = await readEmployeeTimecards(env), employees = new Map(); let legacyAssociationOnlyCount = 0, needsReviewCount = 0;
      const now = new Date().toISOString();
      for (const entry of entries) {
        const summary = employeeJobTime(entry, now), time = summary.jobs.find(item => item.jobId === jobId);
        if (same(entry.jobId, jobId) && (!summary.recorded || summary.partialHistory)) legacyAssociationOnlyCount++;
        if (summary.needsReview && (time || same(entry.jobId, jobId) || Array.isArray(entry.jobTracking?.segments) && entry.jobTracking.segments.some(item => item?.jobId === jobId))) { needsReviewCount++; continue; }
        if (!time) continue;
        const key = personKey(entry.employee), employee = employees.get(key) || { employee: entry.employee, name: entry.employeeName || entry.employee, workMs: 0, travelMs: 0, approvedWorkMs: 0, pendingWorkMs: 0, rejectedWorkMs: 0, entryCount: 0 };
        employee.workMs += time.workMs; employee.travelMs += time.travelMs; employee.entryCount++;
        employee[entry.approvalStatus === 'approved' ? 'approvedWorkMs' : entry.approvalStatus === 'rejected' ? 'rejectedWorkMs' : 'pendingWorkMs'] += time.workMs;
        employees.set(key, employee);
      }
      return reply(200, { ok: true, jobId, asOf: now, employees: [...employees.values()], legacyAssociationOnlyCount, needsReviewCount, source: 'explicit_employee_job_segments' });
    }
    // Chat's 15-second refresh reads only message families. Authorization below is
    // identical to the full view, including current job-assignment checks.
    const messagesOnly = params.get('view') === 'messages';
    const names = messagesOnly ? ['teamMessages', 'jobMessages', 'messageReads'] : [...COLLECTIONS];
    // A missing index or legacy-query setting needs only one shared fallback scan.
    let fallbackRows;
    const fallback = () => fallbackRows ??= readAll(env);
    const rows = messagesOnly
      ? (await Promise.all(names.map(async collection => (await readCollection(env, collection, { fallback })).map(data => ({ collection, data }))))).flat()
      : await readAll(env);
    const viewedAt = new Date().toISOString();
    const collections = Object.fromEntries(names.map(name => [name, []]));
    const jobAccess = new Map();
    const assignments = createJobAssignmentAccess(env, session);
    for (const row of rows) {
      if (row.collection !== 'jobMessages') {
        if (visibleTo(session, row.collection, row.data)) collections[row.collection].push(row.data);
        continue;
      }
      const jobId = String(row.data?.jobId || '');
      if (!jobAccess.has(jobId)) jobAccess.set(jobId, manager(session) || await readJob(env, jobId).then(job => jobMember(session, job, assignments)));
      if (jobAccess.get(jobId)) collections.jobMessages.push(row.data);
    }
    if (messagesOnly) return reply(200, { ok: true, collections });
    // Approval establishes team membership before the employee creates a profile.
    // Project only roster fields; application credentials and review data stay private.
    const accounts = manager(session) ? await listEmployeeApplications(env) : [];
    const accountsByUsername = new Map(accounts.map(account => [personKey(account.username), account]));
    const profiles = configuredProfiles(env).filter(profile => visibleTo(session, 'profiles', profile));
    const profileKeys = new Set(profiles.map(profile => personKey(profile.username)));
    for (const account of accounts) {
      const key = personKey(account.username);
      if (account.status !== 'approved' || profileKeys.has(key)) continue;
      profiles.push({
        id: key, username: account.username, displayName: account.displayName || account.username,
        role: 'crew', payType: account.payType || 'hourly',
        hourlyRate: Math.max(0, Number(account.hourlyRate || 0)), status: 'active',
      });
      profileKeys.add(key);
    }
    const storedProfiles = new Map();
    for (const profile of collections.profiles) {
      const key = personKey(profile.username);
      const previous = storedProfiles.get(key);
      if (!previous || profile.id === key || previous.id !== key) storedProfiles.set(key, profile);
    }
    collections.profiles = [
      ...profiles.map(profile => ({ ...profile, ...(storedProfiles.get(personKey(profile.username)) || {}) })),
      ...[...storedProfiles.values()].filter(profile => !profileKeys.has(personKey(profile.username))),
    ].map(profile => {
      const account = accountsByUsername.get(personKey(profile.username));
      return account ? {
        ...profile, accountStatus: account.status,
        status: account.status === 'approved' ? profile.status : 'inactive',
        awaitingFirstSignIn: account.status === 'approved' && !profile.lastSeenAt && !profile.onboardingCompletedAt,
      } : profile;
    }).map(profile => legacyProfileView(profile, viewedAt));
    // Other employees' pay goes to the owner only (EGC_STAFF_PAY_OWNER_ONLY); hours stay visible to managers.
    for (const name of ['profiles', 'timeEntries', 'requests']) collections[name] = collections[name].map(row => visiblePay(session, env, name, row));
    // Each timecard's job time (current segment, per-job work and travel, general time) for the Hub's labels.
    collections.timeEntries = collections.timeEntries.map(row => withJobTime(row, viewedAt));
    return reply(200, { ok: true, collections, payVisibility: seesOthersPay(session, env) ? 'all' : 'own', clockInWithoutFix: clockInWithoutFix(env), timecardCorrections: manager(session) && can(session, 'time.approve', env) && timecardCorrectionsEnabled(env), ...(includeAccounts ? { accounts: seesOthersPay(session, env) ? accounts : accounts.map(account => payHidden('accounts', account)) } : {}) });
  } catch (error) {
    return reply(502, { ok: false, ...(error.code ? { code: error.code } : {}), error: String(error.message || 'Employee Hub storage failed') });
  }
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  if (employeeVaultReadOnly(env)) return reply(503, { ok: false, code: 'EMPLOYEE_HUB_RECOVERY_READ_ONLY', error: 'Employee setup is being verified. Existing records are preserved and cannot be changed yet.' });
  if (!vaultSecret(env) || !firebaseServiceAccountConfigured(env)) return reply(503, { ok: false, error: 'Employee Hub storage is not configured' });
  const raw = await request.text();
  if (raw.length > 128 * 1024) return reply(413, { ok: false, error: 'Request is too large' });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  if (!isRecord(body)) return reply(400, { ok: false, error: 'Invalid employee record' });
  // A device-queued Hub action names the account that saved it and is never saved for another one (409, not a 401 that signs out).
  if (body.expectedUser !== undefined && !same(body.expectedUser, session.user)) return reply(409, { ok: false, code: 'EMPLOYEE_HUB_ACCOUNT_CHANGED', error: 'This action was saved on this device by another account. Sign in as that employee to send it.' });
  if (typeof body.collection !== 'string' || typeof body.id !== 'string') return reply(400, { ok: false, error: 'Invalid employee record' });
  const collection = String(body.collection || '');
  const id = String(body.id || '').trim();
  if (!COLLECTIONS.has(collection) || !id || id.length > 180) return reply(400, { ok: false, error: 'Invalid employee record' });
  // Requests change only through /api/employee-pto: field whitelist, decision history and availability locks.
  if (collection === 'requests') return reply(403, { ok: false, code: 'EMPLOYEE_HUB_REQUEST_WORKFLOW_REQUIRED', error: 'Requests are sent and reviewed through the request workflow. Refresh the Hub and try again.' });
  if (body.data !== undefined && !isRecord(body.data)) return reply(400, { ok: false, error: 'Invalid employee record data' });
  let incoming;
  try {
    const serialized = JSON.stringify(body.data || {});
    if (serialized.length > 120000) return reply(413, { ok: false, error: 'Employee record is too large' });
    incoming = JSON.parse(serialized);
  } catch { return reply(400, { ok: false, error: 'Invalid employee record data' }); }
  try {
    if (collection === 'timeEntries' && isRecord(incoming.crewJobAction)) {
      try { return reply(200, await moveCrewJobTime(env, session, incoming.crewJobAction)); }
      catch (error) { if (error.crewMove) return reply(error.status, { ok: false, code: error.code, error: error.message, details: error.crewMove }); throw error; }
    }
    const attempts = collection === 'profiles' ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // Keep the target version separate from any legacy data used to seed it.
      const target = await readOne(env, collection, id);
      let current = target;
      if (collection === 'profiles') {
        const username = manager(session) ? String(incoming.username || current.data?.username || '') : session.user;
        if (current.data && username && !same(current.data.username, username)) {
          throw new Error('This profile belongs to another employee; ask the owner to resolve the legacy profile ID conflict');
        }
        if (!current.data && username && id === personKey(username)) {
          const legacy = await readEmployeeProfile(env, username);
          if (legacy.data) current = legacy;
        }
      }
      // A different vault key changes IDs; a 404 alone cannot prove this is new.
      if (!current.data) await readAll(env);
      if (collection === 'timeEntries' && !current.data && !newTimecardId(id)) return reply(400, { ok: false, code: 'EMPLOYEE_TIMECARD_ID_INVALID', error: 'Invalid employee record' });
      const data = await authorizeMutation(env, session, collection, id, incoming, current.data, QUEUED_REQUEST.test(String(body.requestId ?? '')));
      try {
        if (collection === 'timeEntries') return reply(200, { ok: true, record: withJobTime(visiblePay(session, env, collection, await writeTimecard(env, session, id, data, target)), new Date().toISOString()) });
        const saved = data === current.data && ['teamMessages', 'jobMessages'].includes(collection) ? data : await writeOne(env, collection, id, data, collection === 'profiles' ? target : null);
        return reply(200, { ok: true, record: visiblePay(session, env, collection, collection === 'profiles' ? legacyProfileView(saved, new Date().toISOString()) : saved) });
      } catch (error) {
        if (error.code !== 'EMPLOYEE_HUB_WRITE_CONFLICT' || attempt + 1 === attempts) throw error;
      }
    }
  } catch (error) {
    const message = String(error.message || 'Employee record could not be saved');
    const forbidden = /only|belongs|limited|own/i.test(message);
    const invalid = /required|not passed|invalid/i.test(message);
    return reply(error.code === 'EMPLOYEE_HUB_WRITE_CONFLICT' ? 409 : error.status || (forbidden ? 403 : invalid ? 400 : 502), { ok: false, ...(error.code ? { code: error.code } : {}), error: message });
  }
}

export async function onRequestOptions({ request }) {
  if (!allowed(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  } });
}
