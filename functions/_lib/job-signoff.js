/** Supervisor sign-off on completed jobs (SIGNOFF, owner decision 2026-10-21, #201).
 * After the crew completes a job, a manager or the owner looks at it (the live job page: photos, checklist, notes) and
 * signs it off, or flags it with a reason. It never gates anything: invoicing, the deposit and balance requests and the
 * customer's receipt are unchanged, and nothing here is read by those paths.
 * - Who: business accounts with dispatch.write (the owner and managers). Nobody signs off or flags a job they worked
 *   on (assigned, lead, on a segment, or completed it), except the owner, as with timecards (NO-SELF-APPROVAL).
 * - Stored on the job as supervisorSignoff {status:'signed'|'flagged', by, byName, at, reason, requestId} and an
 *   append-only supervisorSignoffHistory (last 20). Crew views are allowlisted projections and never read either field.
 * - A flag also opens the job's crew follow-up (fieldExecution.attention, visibility crew) for the crew lead, unless one
 *   is already open; it then shows on the crew job page and in Crew performance like any open follow-up. A flagged job
 *   can be signed off later; a signed job is final.
 * - The list is completed jobs dated in the last SIGNOFF_WINDOW_DAYS Denver days, one masked date-range read
 *   (docs/READ-BUDGET.md). A job is overdue once SIGNOFF_STALE_HOURS have passed since it was completed unsigned.
 * Hours and names only: no price, payment or customer contact. */
import { can } from './staff-roles.js';
import { hasBusinessAccess, isHubOwner } from './hub-session.js';
import { assignmentKey } from './job-assignment.js';

export const SIGNOFF_WINDOW_DAYS = 14;
export const SIGNOFF_STALE_HOURS = 48;
export const SIGNOFF_HISTORY_LIMIT = 20;
export const SIGNOFF_FIELDS = Object.freeze(['date', 'endDate', 'time', 'type', 'recordType', 'status', 'pipelineStatus', 'customer', 'serviceType', 'title', 'crewLead', 'assignedCrew', 'assignmentSegments',
  'completedAt', 'completedBy', 'fieldExecution.completion.completedAt', 'fieldExecution.completion.actorId', 'fieldExecution.completion.hasIssues', 'fieldExecution.attention.status', 'supervisorSignoff']);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const key = value => assignmentKey(value) || String(value || '').trim().toLowerCase();
const firstName = value => String(value || '').trim().split(/\s+/)[0] || 'Customer';

/** Only the owner and managers sign off (401 signed out, 403 anyone else). */
export function requireSignoffManager(session, env) {
  if (!session) throw fail('job_signoff_sign_in_required', 'Sign in to review completed jobs.', 401);
  if (!hasBusinessAccess(session) || !can(session, 'dispatch.write', env)) throw fail('job_signoff_forbidden', 'Only managers and the owner sign off completed jobs.', 403);
}

export const completedJob = job => record(job) && job.type !== 'walkthrough' && job.type !== 'blocked' && !job.recordType && [job.status, job.pipelineStatus].includes('completed');

/** Everyone who worked the job: assigned, lead, on any segment, or the one who completed it. */
export function jobWorkers(job) {
  const people = new Set();
  const add = value => { const id = key(value); if (id) people.add(id); };
  for (const person of Array.isArray(job?.assignedCrew) ? job.assignedCrew : []) add(person);
  add(job?.crewLead); add(job?.completedBy); add(job?.fieldExecution?.completion?.actorId);
  for (const segment of Array.isArray(job?.assignmentSegments) ? job.assignmentSegments : []) {
    if (!record(segment)) continue;
    for (const person of Array.isArray(segment.assignedCrew) ? segment.assignedCrew : []) add(person);
    add(segment.crewLead);
  }
  return people;
}
export const workedJob = (job, session) => jobWorkers(job).has(key(session?.user));

function completedAt(job) {
  const at = job?.fieldExecution?.completion?.completedAt || job?.completedAt;
  return Number.isFinite(Date.parse(at || '')) ? new Date(Date.parse(at)).toISOString() : null;
}
const signoff = job => record(job?.supervisorSignoff) && ['signed', 'flagged'].includes(job.supervisorSignoff.status) ? job.supervisorSignoff : null;

/** One row of the sign-off list for this viewer. */
export function signoffRow(job, session, now) {
  const done = completedAt(job), state = signoff(job), hours = done ? Math.max(0, (Date.parse(now) - Date.parse(done)) / 3600000) : null;
  return {
    jobId: String(job.id), date: String(job.date || ''), time: String(job.time || ''), customer: firstName(job.customer), service: String(job.serviceType || job.title || 'Job'),
    lead: String(job.crewLead || ''), completedAt: done, hoursSinceCompleted: hours === null ? null : Math.round(hours * 10) / 10,
    hasIssues: job.fieldExecution?.completion?.hasIssues === true, openFollowUp: job.fieldExecution?.attention?.status === 'open',
    signoff: state ? { status: state.status, by: String(state.by || ''), byName: String(state.byName || state.by || ''), at: String(state.at || ''), reason: String(state.reason || '') } : null,
    overdue: !state && hours !== null && hours >= SIGNOFF_STALE_HOURS,
    ownJob: workedJob(job, session) && !isHubOwner(session),
  };
}

/** The list: completed jobs not yet signed off (flagged ones stay until signed), oldest completion first. */
export function signoffList(jobs, session, now) {
  const rows = (Array.isArray(jobs) ? jobs : []).filter(job => completedJob(job) && signoff(job)?.status !== 'signed').map(job => signoffRow(job, session, now));
  rows.sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')) || a.jobId.localeCompare(b.jobId));
  return { rows, needed: rows.filter(row => !row.signoff).length, overdue: rows.filter(row => row.overdue).length, flagged: rows.filter(row => row.signoff?.status === 'flagged').length };
}

/** The job patch for a sign-off or a flag, or {replayed:true} for a request already applied.
 * input: {action:'sign_off'|'flag', requestId (UUID), reason (flag: 3–1,000 characters; sign-off: optional note)}. */
export function signoffCommand(job, session, input, now) {
  if (!record(input) || !['sign_off', 'flag'].includes(input.action)) throw fail('job_signoff_request_invalid', 'Choose Sign off or Flag.');
  if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) throw fail('job_signoff_request_invalid', 'This request needs a new request ID. Refresh and try again.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (input.action === 'flag' && (reason.length < 3 || reason.length > 1000)) throw fail('job_signoff_reason_required', 'Say what needs fixing (3 to 1,000 characters).');
  if (reason.length > 1000) throw fail('job_signoff_request_invalid', 'Keep the note to 1,000 characters.');
  const current = signoff(job), history = Array.isArray(job?.supervisorSignoffHistory) ? job.supervisorSignoffHistory.filter(record) : [];
  if (current?.requestId === input.requestId || history.some(entry => entry.requestId === input.requestId)) return { replayed: true };
  if (!completedJob(job)) throw fail('job_signoff_not_completed', 'Only a completed job can be signed off.', 409);
  if (workedJob(job, session) && !isHubOwner(session)) throw fail('job_signoff_self', 'You worked this job, so another manager or the owner signs it off.', 403);
  if (current?.status === 'signed') throw fail('job_signoff_already_signed', `This job was already signed off by ${current.byName || current.by || 'a manager'}.`, 409);
  if (current?.status === 'flagged' && input.action === 'flag') throw fail('job_signoff_already_flagged', 'This job is already flagged. Sign it off once the follow-up is done.', 409);
  const actorName = String(session.displayName || session.user);
  const entry = { status: input.action === 'flag' ? 'flagged' : 'signed', by: session.user, byName: actorName, at: now, reason, requestId: input.requestId };
  const patch = { supervisorSignoff: entry, supervisorSignoffHistory: [...history, entry].slice(-SIGNOFF_HISTORY_LIMIT) };
  if (input.action === 'flag' && job.fieldExecution?.attention?.status !== 'open') {
    const state = record(job.fieldExecution) ? job.fieldExecution : {};
    patch.fieldExecution = { ...state, attention: { at: now, actorId: session.user, actorName, requestId: input.requestId, visibility: 'crew', reason: `Supervisor flag: ${reason}`, status: 'open' } };
  }
  return { patch, signoff: entry };
}
