/** Shift-swap requests (SHIFT-SWAP, owner decision 2026-10-21, #202): a crew member asks a named coworker to take their
 * place on an assigned job, the coworker accepts, and then a manager or the owner approves. Only the approval changes
 * the job, and it goes through dispatch's own schedule.update (mutateDispatch), so the conflict, capacity, working-hours
 * and skill rules and the crew notifications apply exactly as for any reassignment.
 * - Record: shiftSwaps/{id} {id, jobId, from, fromName, to, toName, status, reason, jobDate, jobTime, jobStartAt,
 *   jobSchedule:{date, time, endDate, endTime}, service, createdAt, updatedAt, decidedBy, decidedAt, dispatchRequestId,
 *   history:[{action, by, at, note}]}.
 *   status: requested -> accepted -> approving -> approved; or declined (coworker), denied (manager), cancelled
 *   (requester), expired (the job started first, was rescheduled, or changed so the swap no longer fits).
 * - The schedule is snapshotted at the request and again at the accept; the accept and the approval compare it with
 *   the live job, so nobody is held to a time they did not agree to. A rescheduled job expires the swap.
 * - Approval first saves 'approving' with its dispatch request ID (revision-guarded), so a cancel, decline or denial
 *   racing it loses; a dispatch refusal puts it back to accepted, and a retry finishes from the dispatch receipt.
 * - One open request per job and requester: shiftSwapLocks/{swapLockId(jobId, from)} {jobId, from, swapId} is written in
 *   the same commit as the request, create-only or under its revision, and a held lock blocks a second request.
 * - Who: the requester is assigned to the job; the coworker is another active employee who is not on it. Approval
 *   needs dispatch.write (owner or manager), and nobody approves a swap they are part of, except the owner.
 * - Jobs: customer jobs with a date and time that have not started; split jobs (assignment segments) are changed by a
 *   manager in Dispatch instead. A swap of the crew lead hands the lead to the coworker.
 * - Every step is a revision-guarded write with the swap's history; the approval's dispatch request ID is derived from
 *   the swap, so a retried approval replays the same dispatch save instead of making a second one.
 * Names, dates and times only: no price, pay or customer contact. Nothing is sent to customers or HighLevel here. */
import { scheduleInterval } from './dispatch-time.js';
import { segmented } from './dispatch-segments.js';
import { assignmentKey } from './job-assignment.js';
import { hasBusinessAccess, isHubOwner } from './hub-session.js';
import { canDispatch } from './dispatch-permissions.js';

export const SWAP_OPEN = Object.freeze(['requested', 'accepted', 'approving']);
// The open states that close on their own when the job starts; 'approving' may already have moved the job.
export const SWAP_EXPIRES = Object.freeze(['requested', 'accepted']);
export const SWAP_FIELDS = Object.freeze(['id', 'jobId', 'from', 'fromName', 'to', 'toName', 'status', 'reason', 'jobDate', 'jobTime', 'jobStartAt', 'jobSchedule', 'service', 'createdAt', 'updatedAt', 'decidedBy', 'decidedAt', 'dispatchRequestId', 'history']);
export const SWAP_JOB_FIELDS = Object.freeze(['date', 'time', 'endDate', 'endTime', 'type', 'recordType', 'status', 'pipelineStatus', 'serviceType', 'title', 'assignedCrew', 'crewLead', 'assignmentSegments', 'fieldExecution.activity']);
export const SWAP_WINDOW_DAYS = 14;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,180}$/;
const TERMINAL = new Set(['completed', 'cancelled', 'canceled', 'no_show', 'archived']);
// Field stages once the crew is on the way (field-execution.js): the job has started for a swap.
const STARTED = new Set(['dispatched', 'arrived', 'in_progress', 'paused', 'waiting', 'delayed', 'day_ended', 'completed']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const key = value => assignmentKey(value);
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

export const swapManager = (session, env) => Boolean(session) && hasBusinessAccess(session) && canDispatch(session, env);
export function requireSwapSession(session) { if (!session || !key(session.user)) throw fail('shift_swap_sign_in_required', 'Sign in to ask for a shift swap.', 401); }

/** When the job starts (ms), or null when it has no usable date and time. */
export function jobStart(job) {
  const at = scheduleInterval({ date: job?.date, time: job?.time, endDate: job?.endDate || job?.date, endTime: job?.endTime || '23:59' });
  return at ? at.start : null;
}
/** The job's schedule as a swap records it, to tell later whether the job was rescheduled. */
export const swapSchedule = job => ({ date: String(job?.date || ''), time: String(job?.time || ''), endDate: String(job?.endDate || job?.date || ''), endTime: String(job?.endTime || '') });
export const RESCHEDULED = 'The job was rescheduled; ask again.';
/** Why the live job no longer matches the schedule this swap agreed to ('' when it does). Old records without a
 * snapshot fall back to the stored date and time. */
export function swapRescheduled(swap, job) {
  const live = swapSchedule(job), saved = record(swap?.jobSchedule) ? swap.jobSchedule : { date: swap?.jobDate, time: swap?.jobTime };
  return Object.keys(saved).some(field => String(saved[field] || '') !== live[field]) ? RESCHEDULED : '';
}
const crewOf = job => (Array.isArray(job?.assignedCrew) ? job.assignedCrew : []).map(key).filter(Boolean);

/** Why this job cannot be swapped now ('' when it can). */
export function swapBlocker(job, nowMs) {
  if (!record(job) || job.type !== 'job' || job.recordType) return 'Only customer jobs can be swapped.';
  if (TERMINAL.has(String(job.status || '').toLowerCase()) || TERMINAL.has(String(job.pipelineStatus || '').toLowerCase())) return 'This job is finished or cancelled.';
  if (segmented(job)) return 'This job is split between crews, so a manager changes it in Dispatch.';
  const start = jobStart(job);
  if (start === null) return 'This job has no scheduled time yet.';
  if (start <= nowMs || [job.pipelineStatus, job.status, job.fieldExecution?.activity].some(value => STARTED.has(String(value || '').toLowerCase()))) return 'This job has already started.';
  return '';
}

/** The swap as a viewer sees it: the stored status, or expired once the job's start has passed. `job`, when given, is
 * the live job: its start counts instead of the stored one, and its date and time are shown. */
export function swapView(swap, nowMs, job = null) {
  const start = job ? jobStart(job) : Date.parse(swap?.jobStartAt || '');
  const status = SWAP_EXPIRES.includes(swap?.status) && Number.isFinite(start) && start <= nowMs ? 'expired' : swap?.status;
  if (job) swap = { ...swap, jobDate: job.date, jobTime: job.time };
  return { id: swap.id, jobId: swap.jobId, from: swap.from, fromName: swap.fromName || swap.from, to: swap.to, toName: swap.toName || swap.to, status, reason: swap.reason || '',
    jobDate: swap.jobDate || '', jobTime: swap.jobTime || '', service: swap.service || 'Job', createdAt: swap.createdAt || '', decidedBy: swap.decidedBy || '', decidedAt: swap.decidedAt || '' };
}

const entry = (action, session, now, note = '') => ({ action, by: session.user, at: now, ...(note ? { note } : {}) });
const step = (swap, status, session, now, action, extra = {}, note = '') => ({ ...swap, ...extra, status, updatedAt: now, history: [...(Array.isArray(swap.history) ? swap.history : []), entry(action, session, now, note)].slice(-30) });

/** A new request. roster: the active employees [{id, name}]. Returns the swap record to create. */
export function requestSwap({ job, session, input, roster, openSwaps = [], now }) {
  if (!record(input) || !ID.test(String(input.jobId || '')) || typeof input.to !== 'string') throw fail('shift_swap_request_invalid', 'Choose the job and the coworker who will take it.');
  if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) throw fail('shift_swap_request_invalid', 'This request needs a new request ID. Refresh and try again.');
  if (!job) throw fail('shift_swap_job_not_found', 'This job no longer exists.', 404);
  const me = key(session.user), to = key(input.to), crew = crewOf(job), nowMs = Date.parse(now);
  if (!crew.includes(me)) throw fail('shift_swap_not_assigned', 'You can only hand over a job you are assigned to.', 403);
  const blocker = swapBlocker(job, nowMs);
  if (blocker) throw fail('shift_swap_job_unavailable', blocker, 409);
  const people = new Map((Array.isArray(roster) ? roster : []).filter(record).map(person => [key(person.id), String(person.name || person.id)]));
  if (!to || to === me || !people.has(to)) throw fail('shift_swap_coworker_invalid', 'Choose an active coworker other than yourself.');
  if (crew.includes(to)) throw fail('shift_swap_coworker_assigned', `${people.get(to)} is already on this job.`, 409);
  const id = `swap_${input.requestId.toLowerCase().replace(/-/g, '')}`;
  // The same request seen again (a retry racing itself) is not a second request.
  if (openSwaps.some(swap => swap.id !== id && swap.jobId === job.id && key(swap.from) === me && SWAP_OPEN.includes(swapView(swap, nowMs).status))) throw fail('shift_swap_already_open', 'You already asked someone to take this job. Cancel that request first.', 409);
  const reason = text(input.reason, 500);
  return { id, jobId: job.id, from: me, fromName: people.get(me) || String(session.displayName || session.user), to, toName: people.get(to),
    status: 'requested', reason, jobDate: job.date, jobTime: job.time, jobStartAt: new Date(jobStart(job)).toISOString(), jobSchedule: swapSchedule(job), service: String(job.serviceType || job.title || 'Job'),
    createdAt: now, updatedAt: now, decidedBy: '', decidedAt: '', dispatchRequestId: '', history: [entry('requested', session, now, reason)] };
}

/** The coworker's answer, the requester's cancel, or a manager's denial: the swap record after it. */
export function answerSwap({ swap, session, env, action, note, now }) {
  const me = key(session.user), view = swapView(swap, Date.parse(now)), reason = text(note, 500);
  if (view.status === 'expired') return expireSwap(swap, now);
  if (swap.status === 'approving') throw fail('shift_swap_approving', 'A manager is approving this swap right now. Refresh in a moment.', 409);
  if (action === 'accept' || action === 'decline') {
    if (me !== key(swap.to)) throw fail('shift_swap_forbidden', 'Only the coworker who was asked can answer.', 403);
    if (swap.status !== 'requested') throw fail('shift_swap_state', 'This request was already answered.', 409);
    return step(swap, action === 'accept' ? 'accepted' : 'declined', session, now, action === 'accept' ? 'accepted' : 'declined', {}, reason);
  }
  if (action === 'cancel') {
    if (me !== key(swap.from)) throw fail('shift_swap_forbidden', 'Only the person who asked can cancel.', 403);
    if (!SWAP_OPEN.includes(swap.status)) throw fail('shift_swap_state', 'This request is already closed.', 409);
    return step(swap, 'cancelled', session, now, 'cancelled', {}, reason);
  }
  if (action === 'deny') {
    requireApprover(swap, session, env);
    if (!SWAP_OPEN.includes(swap.status)) throw fail('shift_swap_state', 'This request is already closed.', 409);
    return step(swap, 'denied', session, now, 'denied', { decidedBy: session.user, decidedAt: now }, reason);
  }
  throw fail('shift_swap_request_invalid', 'Choose Accept, Decline, Cancel, Approve or Deny.');
}

/** The swap closed because the job started, was rescheduled or no longer fits it. The server closes it, not a person. */
export const expireSwap = (swap, now, note = '') => step(swap, 'expired', { user: 'system' }, now, 'expired', {}, note);

export function requireApprover(swap, session, env) {
  if (!swapManager(session, env)) throw fail('shift_swap_forbidden', 'Only a manager or the owner approves shift swaps.', 403);
  const me = key(session.user);
  if ((me === key(swap.from) || me === key(swap.to)) && !isHubOwner(session)) throw fail('shift_swap_self', 'You are part of this swap, so another manager or the owner approves it.', 403);
}

/** The dispatch schedule.update an approval runs: the requester out, the coworker in, the lead handed over. */
export function swapDispatchChanges(job, swap) {
  const from = key(swap.from), to = key(swap.to), crew = crewOf(job);
  if (!crew.includes(from) || crew.includes(to)) return null;
  const assignedCrew = (Array.isArray(job.assignedCrew) ? job.assignedCrew : []).map(person => key(person) === from ? swap.to : person);
  return { assignedCrew, ...(key(job.crewLead) === from ? { crewLead: swap.to } : {}) };
}

const hex = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
/** The lock document for one job and requester: two requests for the same job race for it, and only one is written. */
export const swapLockId = async (jobId, from) => `lock_${(await hex(`shift-swap-lock:${jobId}|${key(from)}`)).slice(0, 32)}`;

/** A stable UUID for the approval's dispatch save, so a retry replays it. */
export async function swapDispatchRequestId(swapId) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`shift-swap-approval:${swapId}`))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
