import { firestoreFetch } from './firebase-service-account.js';
import { dispatchStorage } from './dispatch-storage.js';
import { validDate } from './dispatch-time.js';
import { localInstant } from './operations-portal-records.js';
import { hasBusinessAccess } from './hub-session.js';
import { can, capabilityMode } from './staff-roles.js';
import { assignmentKey, createJobAssignmentAccess } from './job-assignment.js';
import { employeeVaultReadOnly, employeeVaultSecret } from './employee-vault-key.js';
import { commitVaultDocuments, readCollectionRecords, readOne, sealedFields } from './employee-vault.js';
import { activeTimecard, authorizeTimecard } from './employee-timecards.js';
import { activeJobSegment, ownJobTimeProjection } from './employee-job-time.js';
import { canonicalJson, funnelHubId, funnelReasonCodes, funnelVocabulary, sha256Hex } from './funnel-definitions.js';
import { funnelEventWrite } from './funnel-events.js';

// FUN-05: the walkthrough visit record. Start, Finish and No-show on a
// walkthrough job write walkthroughVisit / walkthroughOutcome /
// walkthroughCompletedAt, the rep's open-walkthrough lock, a request receipt,
// the funnel events and the rep's timecard segment on the visit id in ONE
// Firestore commit. The lock blocks the rep's next Start until the open visit
// has an outcome. The job status, schedule and field-jobs views are untouched.
// A no-show or rescheduled outcome covers only its occurrence: once Dispatch
// moves the visit, the next Start or No-show records a new occurrence and keeps
// the earlier one in walkthroughOccurrences.

export const WALKTHROUGH_VISIT_OPERATIONS = 'walkthroughVisitOperations';
export const WALKTHROUGH_VISIT_LOCKS = 'walkthroughVisitLocks';
// Exactly "true" accepts Start/Finish/No-show writes; the read stays available and reports the flag.
export const walkthroughVisitEnabled = env => env?.EGC_WALKTHROUGH_VISIT_ENABLED === 'true';

const ACTIONS = ['start', 'finish', 'no_show'];
const INPUT_KEYS = ['action', 'visitId', 'requestId', 'expectedRevision', 'outcome', 'reasonCode', 'recordingStatus', 'deviceAt', 'skipTimecard', 'actorId'];
// Outcomes that carry a reason code, and from which list.
const OUTCOME_REASONS = { not_interested: 'lost', customer_no_show: 'noShow', rescheduled: 'reschedule' };
const START_CLOSED = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'no-show', 'completed', 'closed']);
// Outcomes a rebooked occurrence can follow, and how many earlier occurrences a visit keeps.
const REBOOKABLE = new Set(['customer_no_show', 'rescheduled']), OCCURRENCES = 20;
const START_FIELDS = ['startedAt', 'startedBy', 'startRequestId', 'clockSource', 'recordingStatus', 'repTime', 'occurrence'];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/, PROVIDER_ID = /^[A-Za-z0-9_-]{1,120}$/;
const fail = (code, message, status = 409, details) => Object.assign(new Error(message), { code: `walkthrough_visit_${code}`, status, ...(details ? { details } : {}) });
const invalid = message => fail('invalid', message, 400);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(?:secure_|_egc_)/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const instant = value => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));
const text = (value, max = 180) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const state = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const started = visit => plain(visit?.walkthroughVisit) && instant(visit.walkthroughVisit.startedAt);
const outcomeOf = visit => plain(visit?.walkthroughOutcome) ? visit.walkthroughOutcome : null;
const lockId = rep => `rep_${sha256Hex(`walkthrough-rep:${rep}`).slice(0, 40)}`;
const omit = (value, keys) => plain(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) : {};

// The occurrence a visit is on: its Denver wall start and, once FUN-02 counts placements,
// its scheduleOccurrence. `number` never goes down across a visit's occurrences.
function occurrenceOf(visit, previous = 0) {
  const date = validDate(visit.date) ? visit.date : null, time = typeof visit.time === 'string' && /^\d\d:\d\d$/.test(visit.time) ? visit.time : null;
  const counter = Number.isInteger(visit.scheduleOccurrence) && visit.scheduleOccurrence >= 1 && visit.scheduleOccurrence <= 1000 ? visit.scheduleOccurrence : null;
  return { number: Math.min(1000, Math.max(counter ?? 1, previous + 1)), date, time, startAt: date && time ? localInstant(date, time) : null, scheduleOccurrence: counter };
}
// Dispatch moved the visit to another start (or FUN-02 counted a new placement) since that occurrence.
function moved(snapshot, visit) {
  if (!plain(snapshot)) return false;
  const current = occurrenceOf(visit);
  return Boolean(current.startAt) && (current.startAt !== snapshot.startAt || current.scheduleOccurrence !== null && Number.isInteger(snapshot.scheduleOccurrence) && current.scheduleOccurrence !== snapshot.scheduleOccurrence);
}
const rebooked = visit => { const outcome = outcomeOf(visit); return Boolean(outcome && REBOOKABLE.has(outcome.outcome) && moved(outcome.occurrence, visit)); };
const occurrenceView = value => plain(value) ? { number: Number.isInteger(value.number) ? value.number : null, date: text(value.date, 10) || null, time: text(value.time, 5) || null, startAt: typeof value.startAt === 'string' && value.startAt ? value.startAt : null } : null;

/** Owner, manager and sales reps record walkthroughs: with stored staff roles the P1-08
 * quotes.author capability (owner, manager, sales); otherwise the dispatch-level owner or
 * manager (business access) or the signed sales role. */
export function walkthroughPerformer(session, env = {}) {
  if (!plain(session) || typeof session.user !== 'string' || !session.user.trim()) return false;
  if (capabilityMode(session, env) === 'staff_roles') return can(session, 'quotes.author', env);
  return hasBusinessAccess(session) && ['owner', 'manager'].includes(session.role) || session.role === 'sales';
}

function normalize(input) {
  if (!plain(input)) throw invalid('Send one walkthrough action.');
  for (const name of Object.keys(input)) if (!INPUT_KEYS.includes(name)) throw invalid(`The walkthrough request has an unsupported field ${name}.`);
  const { action } = input;
  if (!ACTIONS.includes(action)) throw invalid('Choose start, finish or no_show.');
  if (!safeId(input.visitId)) throw invalid('Choose a valid walkthrough visit.');
  if (!uuid(input.requestId)) throw invalid('Each walkthrough action needs a unique request ID.');
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 64) throw invalid('Refresh the walkthrough before recording this action.');
  if (input.deviceAt !== undefined && !instant(input.deviceAt)) throw invalid('The device time must be an ISO instant.');
  if (input.skipTimecard !== undefined && typeof input.skipTimecard !== 'boolean') throw invalid('skipTimecard must be true or false.');
  if (input.actorId !== undefined && (typeof input.actorId !== 'string' || !input.actorId.trim() || input.actorId.length > 120)) throw invalid('The saved employee identity is invalid.');
  const recordingStatus = input.recordingStatus ?? null;
  if (recordingStatus !== null && !funnelVocabulary('recordingStatuses').includes(recordingStatus)) throw invalid('Recording status must be recorded, declined or failed_device.');
  let outcome = null, reasonCode = null;
  if (action === 'start') {
    if (input.outcome !== undefined || input.reasonCode !== undefined) throw invalid('Start does not take an outcome.');
  } else {
    outcome = action === 'no_show' ? input.outcome ?? 'customer_no_show' : input.outcome;
    if (action === 'no_show' && outcome !== 'customer_no_show') throw invalid('A no-show records the customer_no_show outcome.');
    if (!funnelReasonCodes('walkthroughOutcome').includes(outcome)) throw invalid('Choose the walkthrough outcome.');
    const list = OUTCOME_REASONS[outcome];
    if (list) {
      if (!funnelReasonCodes(list).includes(input.reasonCode)) throw invalid('Choose the reason for this outcome.');
      reasonCode = input.reasonCode;
    } else if (input.reasonCode !== undefined && input.reasonCode !== null) throw invalid('This outcome does not take a reason.');
    if (action === 'finish' && outcome !== 'customer_no_show' && recordingStatus === null) throw invalid('Say whether the walkthrough was recorded, declined or failed on the device.');
  }
  return { action, visitId: input.visitId, requestId: input.requestId.toLowerCase(), expectedRevision: input.expectedRevision, outcome, reasonCode, recordingStatus,
    deviceAt: input.deviceAt ?? null, skipTimecard: input.skipTimecard === true, actorId: input.actorId === undefined ? null : assignmentKey(input.actorId) };
}

/** The allowlisted walkthrough view: schedule identity and the visit record, never money,
 * signatures, notes or provider ids. `rebookPending` means the outcome shown belongs to an
 * earlier occurrence and the next Start or No-show records the rebooked one. */
export function walkthroughVisitProjection(visit) {
  if (!visit) return null;
  const record = started(visit) ? visit.walkthroughVisit : null, outcome = outcomeOf(visit);
  const repTime = value => plain(value) ? { status: text(value.status, 40), segmentId: typeof value.segmentId === 'string' ? value.segmentId : null } : null;
  return {
    id: visit.id, revision: visit.revision, type: 'walkthrough', customerId: text(visit.customerId), customer: text(visit.customer, 200), address: text(visit.address, 500),
    date: text(visit.date, 10), time: text(visit.time, 5), endTime: text(visit.endTime, 5), status: state(visit) || 'scheduled', projectId: text(visit.projectId),
    walkthroughVisit: record ? { startedAt: record.startedAt, startedBy: text(record.startedBy, 120), clockSource: text(record.clockSource, 40), recordingStatus: record.recordingStatus ?? null, repTime: repTime(record.repTime), occurrence: occurrenceView(record.occurrence) } : null,
    walkthroughOutcome: outcome ? { outcome: text(outcome.outcome, 40), reasonCode: outcome.reasonCode ?? null, finishedAt: text(outcome.finishedAt, 40), performedBy: text(outcome.performedBy, 120), recordingStatus: outcome.recordingStatus ?? null, clockSource: text(outcome.clockSource, 40), repTime: repTime(outcome.repTime), occurrence: occurrenceView(outcome.occurrence) } : null,
    walkthroughCompletedAt: typeof visit.walkthroughCompletedAt === 'string' && visit.walkthroughCompletedAt ? visit.walkthroughCompletedAt : null,
    rebookPending: rebooked(visit), previousOccurrences: Array.isArray(visit.walkthroughOccurrences) ? visit.walkthroughOccurrences.length : 0,
  };
}

// The walkthrough's funnel entities; a malformed legacy link is left out rather than failing the rep's tap.
function entities(visit) {
  const hub = ['projectId', 'customerId', 'businessAccountId'].filter(name => funnelHubId(visit[name]));
  const provider = ['highlevelContactId', 'highlevelOpportunityId'].filter(name => typeof visit[name] === 'string' && PROVIDER_ID.test(visit[name]));
  return { walkthroughId: visit.id, ...Object.fromEntries([...hub, ...provider].map(name => [name, visit[name]])) };
}

// One job-time switch on the rep's own active shift, through the P1-03 timecard rules
// (the same receipt, stale-segment and offline device-time checks as the Hub clock).
// The walkthrough segment is marked visitKind 'walkthrough': job costing keeps its labor
// out of job cost (acquisition cost, docs/FUNNEL-METRICS.md §6.1).
async function shiftSwitch(store, session, shift, action, visit, deviceAt, now) {
  let next;
  try {
    next = authorizeTimecard({ session, manager: false, id: shift.entry.id, existing: shift.entry, now, env: store.env || {},
      incoming: { jobAction: { ...action, ...(deviceAt ? { deviceCapturedAt: deviceAt } : {}) } } });
  } catch (error) {
    if (/^EMPLOYEE_/.test(error?.code || '')) throw fail('time_invalid', `${error.message} You can also record this walkthrough without changing your timecard.`, 409, { timecard: true, ...(error.code === 'EMPLOYEE_TIMECARD_DEVICE_TIME' ? { deviceTime: true } : {}) });
    throw error;
  }
  if (next === shift.entry) return null;
  const label = `Walkthrough: ${text(visit.customer) || visit.id}`.slice(0, 180);
  const segments = next.jobTracking.segments.map(segment => segment?.id === action.requestId && segment.jobId ? { ...segment, jobLabel: label, visitKind: 'walkthrough' } : segment);
  next = { ...next, jobTracking: { ...next.jobTracking, segments } };
  return { collection: 'jobs', id: shift.documentId, revision: shift.revision, patch: await store.sealShift(shift.documentId, next, now) };
}

/**
 * Records one walkthrough visit action for a signed-in owner, manager or sales rep:
 * {action: start | finish | no_show, visitId, requestId, expectedRevision, outcome?,
 *  reasonCode?, recordingStatus?, deviceAt?, skipTimecard?, actorId?}.
 * Start opens the rep's work segment on the visit id (409 clock_in_required without an
 * active shift unless skipTimecard). The starter's Finish or No-show always closes it, at
 * the server time when the timecard refuses the device time; skipTimecard leaves it open
 * (left_open, for a manager) only when the timecard cannot be written. Replays of a
 * requestId return the saved result; everything else is one commit with revision
 * preconditions.
 */
export async function recordWalkthroughVisit(store, session, input, now = new Date().toISOString()) {
  if (!session) throw fail('sign_in_required', 'Sign in to the Employee Hub to record walkthroughs.', 401);
  const request = normalize(input), actor = assignmentKey(session.user), roles = store.env || {};
  if (request.actorId !== null && request.actorId !== actor) throw fail('actor_changed', 'The signed-in employee changed. Sign in as the employee who recorded this walkthrough to send it.', 403);
  if (!walkthroughPerformer(session, roles)) throw fail('forbidden', 'Only sales reps, managers and the owner can record walkthrough visits.', 403);
  const manager = can(session, 'dispatch.write', roles), receiptId = request.requestId;
  const fingerprint = sha256Hex(canonicalJson({ actor, input: request }));
  const result = (visit, receipt, replayed) => ({ ok: true, authority: 'employee_hub', requestId: receiptId, action: receipt.action, replayed, visit: walkthroughVisitProjection(visit), repTime: receipt.repTime || null });
  async function replay() {
    const receipt = await store.read(WALKTHROUGH_VISIT_OPERATIONS, receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor) throw fail('idempotency_conflict', 'This request ID was already used for a different walkthrough action. Refresh before recording again.');
    const saved = await store.read('jobs', receipt.visitId);
    const marker = receipt.action === 'start' ? saved?.walkthroughVisit?.startRequestId : saved?.walkthroughOutcome?.requestId;
    if (!saved || marker !== receiptId) throw fail('changed_since_operation', 'The earlier save succeeded, but this walkthrough has since changed. Refresh it.');
    return result(saved, receipt, true);
  }
  const prior = await replay(); if (prior) return prior;

  const visit = await store.read('jobs', request.visitId);
  if (!visit || visit.type !== 'walkthrough' || visit.recordType || !safeId(visit.id)) throw fail('not_found', 'This walkthrough visit could not be found. Refresh your schedule.', 404);
  if (typeof visit.revision !== 'string' || !visit.revision) throw fail('storage_unavailable', 'The walkthrough has no verifiable revision. Retry.', 503);
  // A no-show or rescheduled outcome on a visit Dispatch has since moved belongs to an earlier
  // occurrence: this action records the rebooked one and keeps the earlier one in the history.
  const previous = rebooked(visit) ? { record: started(visit) ? visit.walkthroughVisit : null, outcome: outcomeOf(visit) } : null;
  const record = !previous && started(visit) ? visit.walkthroughVisit : null, outcome = previous ? null : outcomeOf(visit), startedBy = record ? assignmentKey(record.startedBy) : '';
  if (!manager && !(startedBy ? startedBy === actor : await store.assigned(session, visit))) throw fail('not_assigned', 'This walkthrough is not assigned to you. Ask a manager to assign it before recording it.', 403);
  if (request.expectedRevision !== visit.revision) throw fail('revision_conflict', 'This walkthrough changed. Refresh it and review before recording.');

  const writes = [], role = typeof session.role === 'string' && session.role ? session.role : null;
  const scheduledDate = validDate(visit.date) ? visit.date : null;
  const event = async (type, data, startedAt = null, clock = null) => {
    try {
      return await funnelEventWrite(null, now, {
        type, idempotencyKey: { kind: 'requestId', value: receiptId }, ...entities(visit), actor: { id: actor, kind: 'human', role }, via: 'hub',
        source: { collection: WALKTHROUGH_VISIT_OPERATIONS, id: receiptId }, data, eligibility: { hub: visit },
        ...(clock || (request.deviceAt ? { deviceAt: request.deviceAt, deviceBounds: { ...(startedAt ? { startedAt } : {}), ...(scheduledDate ? { scheduledDate } : {}) } } : {})),
      });
    } catch (error) {
      // The visit or account cannot produce a valid funnel event, so the same request can never succeed.
      if (/^funnel_event_/.test(error?.code || '')) throw fail('invalid', 'This walkthrough action cannot be recorded for this visit or account. Nothing was saved; ask a manager to check the visit.', 400, { cause: error.code });
      throw error;
    }
  };
  const priorNumber = !previous ? 0 : Number.isInteger(previous.outcome.occurrence?.number) ? previous.outcome.occurrence.number : 1;
  const base = omit(visit.walkthroughVisit, START_FIELDS);
  let repTime, patch;
  if (request.action === 'start') {
    if (outcome) throw fail('closed', REBOOKABLE.has(outcome.outcome) ? 'This walkthrough already has an outcome. Move it to its new date in Dispatch before starting the rebooked visit.' : 'This walkthrough is already closed. Refresh your schedule.');
    if (record) throw fail('already_started', 'This walkthrough was already started. Refresh it to finish it.');
    if (visit.walkthroughCompletedAt || START_CLOSED.has(state(visit))) throw fail('closed', 'This walkthrough is already closed. Refresh your schedule.');
    const lock = await store.read(WALKTHROUGH_VISIT_LOCKS, lockId(actor));
    if (lock?.openVisitId && lock.openVisitId !== visit.id) {
      const open = await store.read('jobs', lock.openVisitId);
      if (open && open.type === 'walkthrough' && !open.recordType && started(open) && !outcomeOf(open)) throw fail('outcome_required', 'Record the outcome of your open walkthrough before starting another.', 409, { visitId: open.id, startedAt: open.walkthroughVisit.startedAt, customer: text(open.customer, 200) });
    }
    if (request.skipTimecard) repTime = { status: 'skipped', segmentId: null };
    else {
      const shift = await store.activeShift(session);
      if (!shift) throw fail('clock_in_required', 'Clock in before starting this walkthrough so its time is recorded, or start it without a timecard.', 409, { clockInRequired: true, timecard: true });
      const current = activeJobSegment(shift.entry), write = await shiftSwitch(store, session, shift, { requestId: receiptId, kind: 'work', jobId: visit.id, expectedSegmentId: current?.id || '' }, visit, request.deviceAt, now);
      if (write) writes.push(write);
      repTime = { status: 'segment_opened', segmentId: receiptId };
    }
    const opening = await event('walkthrough.started', request.recordingStatus ? { recordingStatus: request.recordingStatus } : {});
    writes.push(opening);
    patch = { walkthroughVisit: { ...base, startedAt: opening.patch.occurredAt, startedBy: actor, startRequestId: receiptId, clockSource: opening.patch.clockSource, recordingStatus: request.recordingStatus, repTime, occurrence: occurrenceOf(visit, priorNumber) }, updatedAt: now };
    writes.push({ collection: WALKTHROUGH_VISIT_LOCKS, id: lockId(actor), ...(lock ? { revision: lock.revision } : {}), patch: { rep: actor, openVisitId: visit.id, openedAt: opening.patch.occurredAt, requestId: receiptId, updatedAt: now } });
  } else {
    if (outcome) throw fail('closed', REBOOKABLE.has(outcome.outcome) ? 'This walkthrough already has an outcome. Move it to its new date in Dispatch before recording the rebooked visit.' : 'This walkthrough already has an outcome. Refresh it.');
    if (request.action === 'finish' && !record) throw fail('not_started', 'Start this walkthrough before finishing it, or record a no-show.');
    if (!record && (visit.walkthroughCompletedAt || START_CLOSED.has(state(visit)))) throw fail('closed', 'This walkthrough is already closed. Refresh your schedule.');
    const segmentId = typeof record?.repTime?.segmentId === 'string' ? record.repTime.segmentId : null;
    if (!record) repTime = { status: 'not_started', segmentId: null };
    else if (startedBy !== actor) repTime = { status: 'other_performer', segmentId };
    else if (record.repTime?.status !== 'segment_opened') repTime = { status: 'not_opened', segmentId: null };
    else {
      try {
        const shift = await store.activeShift(session), current = shift && activeJobSegment(shift.entry);
        if (!current || current.jobId !== visit.id) repTime = { status: 'already_ended', segmentId };
        else {
          const action = { requestId: receiptId, kind: 'general', jobId: '', expectedSegmentId: current.id };
          let write, status = 'segment_closed';
          try { write = await shiftSwitch(store, session, shift, action, visit, request.deviceAt, now); }
          catch (error) {
            if (error?.details?.deviceTime !== true) throw error;
            // The timecard keeps the P1-03 rule (no stale offline times): the segment closes now, the outcome keeps its C17 time.
            write = await shiftSwitch(store, session, shift, action, visit, null, now); status = 'segment_closed_server_time';
          }
          if (write) writes.push(write);
          repTime = { status, segmentId };
        }
      } catch (error) {
        // Only a timecard that cannot be written stays open, and only on the rep's explicit say-so; a manager closes it.
        if (!request.skipTimecard || !/^walkthrough_visit_time_(?:unavailable|invalid)$/.test(error?.code || '')) throw error;
        repTime = { status: 'left_open', segmentId };
      }
    }
    const noShow = request.outcome === 'customer_no_show', startedAt = record?.startedAt || null;
    const occurrence = plain(record?.occurrence) ? record.occurrence : occurrenceOf(visit, priorNumber);
    const type = noShow ? 'walkthrough.no_show' : 'walkthrough.completed';
    const data = noShow ? { reasonCode: request.reasonCode, occurrence: occurrence.number } : { outcome: request.outcome, ...(request.recordingStatus ? { recordingStatus: request.recordingStatus } : {}), ...(request.outcome === 'not_interested' ? { reasonCode: request.reasonCode } : {}) };
    let clock = null, closing = await event(type, data, startedAt);
    // An outcome is never dated before its Start: an earlier device time is attested at startedAt.
    if (startedAt && Date.parse(closing.patch.occurredAt) < Date.parse(startedAt)) {
      clock = { clockSource: 'attested', occurredAt: new Date(Date.parse(startedAt)).toISOString() };
      closing = await event(type, data, startedAt, clock);
    }
    writes.push(closing);
    if (request.outcome === 'not_interested') writes.push(await event('deal.lost', { reasonCode: request.reasonCode, outcome: 'not_interested' }, startedAt, clock));
    const finishedAt = closing.patch.occurredAt;
    // Only a visit that took place is completed; a no-show or reschedule waits for its rebooked occurrence.
    patch = { walkthroughOutcome: { outcome: request.outcome, reasonCode: request.reasonCode, finishedAt, performedBy: actor, recordingStatus: request.recordingStatus, requestId: receiptId, clockSource: closing.patch.clockSource, deviceAt: request.deviceAt, occurrence, repTime },
      ...(REBOOKABLE.has(request.outcome) ? {} : { walkthroughCompletedAt: finishedAt }), ...(previous?.record ? { walkthroughVisit: Object.keys(base).length ? base : null } : {}), updatedAt: now };
    if (startedBy) {
      const lock = await store.read(WALKTHROUGH_VISIT_LOCKS, lockId(startedBy));
      if (lock?.openVisitId === visit.id) writes.push({ collection: WALKTHROUGH_VISIT_LOCKS, id: lockId(startedBy), revision: lock.revision, patch: { rep: startedBy, openVisitId: '', openedAt: '', requestId: receiptId, updatedAt: now } });
    }
  }
  if (previous) {
    const history = Array.isArray(visit.walkthroughOccurrences) ? visit.walkthroughOccurrences : [];
    const startRecord = previous.record ? Object.fromEntries(START_FIELDS.filter(key => Object.hasOwn(previous.record, key)).map(key => [key, previous.record[key]])) : null;
    patch.walkthroughOccurrences = [...history, { occurrence: previous.outcome.occurrence, walkthroughVisit: startRecord, walkthroughOutcome: previous.outcome, archivedAt: now, archivedBy: actor, archivedRequestId: receiptId }].slice(-OCCURRENCES);
    if (request.action === 'start') patch.walkthroughOutcome = null;
  }
  writes.unshift({ collection: 'jobs', id: visit.id, revision: visit.revision, patch });
  writes.push({ collection: WALKTHROUGH_VISIT_OPERATIONS, id: receiptId, patch: { requestId: receiptId, action: request.action, visitId: visit.id, actorId: actor, fingerprint, repTime, createdAt: now } });
  try { await store.commit(writes); }
  catch (error) { const recovered = await replay().catch(() => null); if (recovered) return recovered; throw error; }
  const saved = await replay();
  if (!saved) throw fail('outcome_unknown', 'The walkthrough save could not be read back. Retry the same request; do not tap again.', 503);
  return { ...saved, replayed: false };
}

/** What the recorder needs before a tap: the visit, the viewer's open walkthrough (the
 * one blocking their next Start) and whether they are clocked in. */
export async function walkthroughVisitState(store, session, query = {}, now = new Date().toISOString()) {
  if (!session) throw fail('sign_in_required', 'Sign in to the Employee Hub to record walkthroughs.', 401);
  const roles = store.env || {}, actor = assignmentKey(session.user);
  if (!walkthroughPerformer(session, roles)) throw fail('forbidden', 'Only sales reps, managers and the owner can record walkthrough visits.', 403);
  if (!plain(query) || Object.keys(query).some(key => key !== 'visitId') || query.visitId !== undefined && !safeId(query.visitId)) throw invalid('Choose a valid walkthrough visit.');
  const manager = can(session, 'dispatch.write', roles);
  let visit = null;
  if (query.visitId) {
    visit = await store.read('jobs', query.visitId);
    if (!visit || visit.type !== 'walkthrough' || visit.recordType) throw fail('not_found', 'This walkthrough visit could not be found. Refresh your schedule.', 404);
    const startedBy = started(visit) ? assignmentKey(visit.walkthroughVisit.startedBy) : '';
    if (!manager && startedBy !== actor && !await store.assigned(session, visit)) throw fail('not_assigned', 'This walkthrough is not assigned to you.', 403);
  }
  const lock = await store.read(WALKTHROUGH_VISIT_LOCKS, lockId(actor));
  const open = lock?.openVisitId ? await store.read('jobs', lock.openVisitId) : null;
  let shift;
  try {
    const active = await store.activeShift(session), view = active ? ownJobTimeProjection(active.entry, now) : null;
    shift = { available: true, clockedIn: Boolean(active), onBreak: Boolean(view?.onBreak), needsReview: Boolean(view?.summary.needsReview), current: view?.current ? { kind: view.current.kind, jobId: view.current.jobId, startedAt: view.current.startedAt } : null };
  } catch (error) { shift = { available: false, code: /^walkthrough_visit_/.test(error?.code || '') ? error.code : 'walkthrough_visit_time_unavailable' }; }
  return { ok: true, authority: 'employee_hub', asOf: now, viewer: { id: actor, manager }, visit: walkthroughVisitProjection(visit),
    openVisit: open && open.type === 'walkthrough' && !open.recordType && started(open) && !outcomeOf(open) ? walkthroughVisitProjection(open) : null, shift };
}

export function walkthroughVisitStorage(env, fetcher = firestoreFetch) {
  const dispatch = dispatchStorage(env, fetcher);
  const unavailable = () => fail('time_unavailable', 'Your timecard could not be read safely. Record this walkthrough without changing your timecard, or ask a manager.', 503, { timecard: true });
  return {
    // The deployment settings the staff-role capability and timecard rules read.
    env,
    async read(collection, id) {
      try { return await dispatch.read(collection, id); }
      catch { throw fail('storage_unavailable', 'Walkthrough records could not be loaded. Retry.', 503); }
    },
    assigned: (session, job) => createJobAssignmentAccess(env, session).assigned(job),
    // The rep's own active shift, found as the Hub clock finds it: the per-employee time
    // lock, else a scan of the vault timecards. Two active shifts need a manager.
    async activeShift(session) {
      if (!employeeVaultSecret(env) || employeeVaultReadOnly(env)) throw fail('time_unavailable', 'Employee time records cannot be changed right now. Record this walkthrough without changing your timecard, or ask a manager.', 503, { timecard: true });
      const user = assignmentKey(session.user), found = row => row?.data && activeTimecard(row.data) && assignmentKey(row.data.employee) === user;
      try {
        const lock = await readOne(env, 'timeLocks', user);
        let shift = lock.data?.entryId ? await readOne(env, 'timeEntries', lock.data.entryId) : null;
        if (!found(shift)) {
          const candidates = (await readCollectionRecords(env, 'timeEntries')).filter(found);
          if (candidates.length > 1) throw fail('time_invalid', 'More than one active shift needs manager review before walkthrough time can be recorded.', 409, { timecard: true });
          shift = candidates[0] || null;
        }
        if (!shift) return null;
        if (!shift.updateTime) throw unavailable();
        return { entry: shift.data, documentId: shift.documentId, revision: shift.updateTime };
      } catch (error) { throw /^walkthrough_visit_/.test(error?.code || '') ? error : unavailable(); }
    },
    async sealShift(documentId, data, updatedAt) {
      try { return await sealedFields(env, 'timeEntries', documentId, data, updatedAt); }
      catch { throw unavailable(); }
    },
    // Firestore reports a stale updateTime as 400 FAILED_PRECONDITION and an existing
    // create as 409 ALREADY_EXISTS: both are conflicts and nothing was written. A commit
    // refused as 400 INVALID_ARGUMENT wrote nothing and would be refused again; only a
    // lost or unreadable reply is an unknown outcome.
    async commit(writes) {
      let refused = false;
      const observed = async (...args) => {
        const response = await fetcher(...args);
        if (response?.status === 400) refused = (await response.clone().json().catch(() => null))?.error?.status === 'INVALID_ARGUMENT';
        return response;
      };
      try { return await commitVaultDocuments(env, writes, observed); }
      catch (error) {
        if (error?.code === 'EMPLOYEE_HUB_WRITE_CONFLICT') throw fail('revision_conflict', 'This walkthrough or your timecard changed while saving. Refresh and review it before retrying.');
        if (refused) throw fail('invalid', 'The walkthrough record was refused as invalid and nothing was saved. Refresh it; if this repeats, ask a manager.', 400, { cause: 'storage_rejected' });
        throw fail('outcome_unknown', 'The walkthrough save could not be verified. Retry the same request to check whether it saved; do not tap again.', 503);
      }
    },
  };
}
