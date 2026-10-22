/** Supervisor sign-off on completed jobs (SIGNOFF, owner decision 2026-10-21, #201).
 * After the crew completes a job, a manager or the owner looks at it (the live job page: photos, checklist, notes) and
 * signs it off, or marks it Needs follow-up with a reason. It never gates anything: invoicing, the deposit and balance
 * requests and the customer's receipt are unchanged, and nothing here is read by those paths.
 * - Who: business accounts with dispatch.write (the configured owner and managers; a stored Manager once
 *   EGC_STAFF_ROLE_ACCESS is on). Nobody signs off a job they worked on, except the owner (NO-SELF-APPROVAL): assigned
 *   in any form (assignedCrew or assignedTo, a username, a unique display name or an {username} entry), crew lead, on a
 *   segment, or doing field work on it (completed it, started or ended a day, ticked a checklist item, approved an early
 *   completion, set its field status).
 * - Work done: completed, paid, invoiced, closed or review requested, with a completion time. A job paid on the spot
 *   stays on the list. The list is jobs completed in the last SIGNOFF_WINDOW_DAYS days (by completion time, not job
 *   date) plus every job still needing follow-up whatever its age, and it counts the older unsigned ones up to
 *   SIGNOFF_LOOKBACK_DAYS so nothing ages out silently. Two bounded queries (docs/READ-BUDGET.md).
 * - Stored on the job as supervisorSignoff {status:'signed'|'flagged', by, byName, at, reason, requestId, action} and an
 *   append-only supervisorSignoffHistory (last 20); firestore.rules keeps both server-only. Crew views are allowlisted
 *   projections and never read them.
 * - Needs follow-up opens the job's crew follow-up (fieldExecution.attention, visibility crew) for the crew lead, with
 *   money removed from the reason (stripCrewMoney). When one is already open the reason is added to it; a resolved one
 *   is kept in fieldExecution.attentionHistory first. Signing the job off later closes a follow-up the flag opened. A
 *   signed job is final.
 * Names and times only: no price, payment or customer contact. */
import { can } from './staff-roles.js';
import { hasBusinessAccess, isHubOwner } from './hub-session.js';
import { assignmentKey, jobCrewNames } from './job-assignment.js';
import { stripCrewMoney } from './crew-money.js';

export const SIGNOFF_WINDOW_DAYS = 14;
export const SIGNOFF_LOOKBACK_DAYS = 60;
export const SIGNOFF_STALE_HOURS = 48;
export const SIGNOFF_HISTORY_LIMIT = 20;
export const WORK_DONE = Object.freeze(['completed', 'paid', 'invoiced', 'closed', 'review_requested']);
export const SIGNOFF_FIELDS = Object.freeze(['date', 'endDate', 'time', 'type', 'recordType', 'status', 'pipelineStatus', 'customer', 'serviceType', 'title', 'crewLead', 'assignedCrew', 'assignedTo', 'assignmentSegments',
  'completedAt', 'completedBy', 'completionEvidence.actorId', 'fieldExecution.completion.completedAt', 'fieldExecution.completion.actorId', 'fieldExecution.completion.hasIssues', 'fieldExecution.completion.earlyCompletion',
  'fieldExecution.activityBy', 'fieldExecution.visits', 'fieldExecution.checks', 'fieldExecution.attention.status', 'supervisorSignoff']);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const nameOf = value => typeof value === 'string' ? value.trim() : String(value?.username || value?.user || value?.id || value?.name || '').trim();
const key = value => assignmentKey(nameOf(value));

/** Only the owner and managers sign off (401 signed out, 403 anyone else). */
export function requireSignoffManager(session, env) {
  if (!session) throw fail('job_signoff_sign_in_required', 'Sign in to review completed jobs.', 401);
  if (!hasBusinessAccess(session) || !can(session, 'dispatch.write', env)) throw fail('job_signoff_forbidden', 'Only managers and the owner sign off completed jobs.', 403);
}

function completedAt(job) {
  const at = job?.fieldExecution?.completion?.completedAt || job?.completedAt;
  return Number.isFinite(Date.parse(at || '')) ? new Date(Date.parse(at)).toISOString() : null;
}
const stage = job => String(job?.pipelineStatus || job?.status || '');
/** A customer job whose work is done: a done status and a completion time. */
export const completedJob = job => record(job) && job.type !== 'walkthrough' && job.type !== 'blocked' && !job.recordType && (WORK_DONE.includes(stage(job)) || WORK_DONE.includes(String(job.status || ''))) && Boolean(completedAt(job));

/** The viewer's identities as access.identities() gives them (username, and a display name that is theirs alone). */
export function workerMatcher(session, identities = [session?.user]) {
  const username = assignmentKey(session?.user), names = new Set(identities.map(value => assignmentKey(value)).filter(Boolean));
  // Assignments may be names or {username} entries; an explicit account identifier is authoritative over its label.
  const loose = value => { const id = key(value); if (!id || !username) return false; if (id === username) return true; if (record(value) && (value.username || value.user || value.id)) return false; return names.has(id); };
  // Segments and field-work records store usernames, matched exactly.
  const exact = value => Boolean(username) && key(value) === username;
  return { loose, exact };
}

// Field work in the job's audit log (jobs/{id}/fieldEvents, server-only, so no SDK edit to the job hides it): moving the
// job through its stages, checklist items, materials, completing it, and job photos. Office actions on the same log (notes,
// resolving an issue, the checklist setup, customer photo sharing, purchase marks, completion sync, the signed
// walkthrough's reference photos) are supervision, not field work.
const FIELD_WORK = new Set(['status', 'checklist', 'material', 'complete', 'photo']);
export const fieldWorkEvent = event => record(event) && event.state === 'applied' && FIELD_WORK.has(event.action) && !(event.action === 'photo' && event.category === 'walkthrough');
/** Whether these audit-log entries show this viewer did field work on the job. */
export const workedByEvents = (events, matcher) => (Array.isArray(events) ? events : []).some(event => fieldWorkEvent(event) && matcher.exact(event.actorId));

/** Whether this viewer worked the job (see the module comment). */
export function workedJob(job, matcher) {
  const assigned = [...jobCrewNames(job), ...(Array.isArray(job?.assignedCrew) && job.assignedTo ? jobCrewNames({ assignedTo: job.assignedTo }) : [])];
  if (assigned.some(matcher.loose) || matcher.loose(job?.crewLead)) return true;
  const fe = record(job?.fieldExecution) ? job.fieldExecution : {};
  const exact = [job?.completedBy, job?.completionEvidence?.actorId, fe.completion?.actorId, fe.completion?.earlyCompletion?.approvedBy, fe.activityBy, job?.dispatchedBy, job?.arrivedBy, job?.startedBy,
    ...(Array.isArray(fe.photos) ? fe.photos.filter(photo => record(photo) && photo.category !== 'walkthrough').map(photo => photo.actorId) : [])];
  for (const segment of Array.isArray(job?.assignmentSegments) ? job.assignmentSegments.filter(record) : []) exact.push(segment.crewLead, ...(Array.isArray(segment.assignedCrew) ? segment.assignedCrew : []));
  for (const visit of Object.values(record(fe.visits) ? fe.visits : {}).filter(record)) exact.push(visit.startedBy, visit.endedBy, visit.reopenedBy, ...(Array.isArray(visit.closures) ? visit.closures.map(row => row?.endedBy) : []));
  for (const check of Object.values(record(fe.checks) ? fe.checks : {}).filter(record)) exact.push(check.actorId);
  return exact.some(matcher.exact);
}
const signoff = job => record(job?.supervisorSignoff) && ['signed', 'flagged'].includes(job.supervisorSignoff.status) ? job.supervisorSignoff : null;
// "Synthetic Johnson Family" -> "Synthetic J." (no full name or contact on the card).
const customerLabel = value => { const parts = String(value || '').trim().split(/\s+/).filter(Boolean); return parts.length ? parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0] : 'Customer'; };

/** One row of the sign-off list for this viewer. names: Map(id -> display name). */
export function signoffRow(job, session, matcher, now, names = new Map()) {
  const done = completedAt(job), state = signoff(job), hours = done ? Math.max(0, (Date.parse(now) - Date.parse(done)) / 3600000) : null;
  const lead = nameOf(job.crewLead);
  return {
    jobId: String(job.id), date: String(job.date || ''), time: String(job.time || ''), customer: customerLabel(job.customer), service: String(job.serviceType || job.title || 'Job'),
    lead: lead ? names.get(assignmentKey(lead)) || lead : '', completedAt: done, hoursSinceCompleted: hours === null ? null : Math.round(hours * 10) / 10,
    hasIssues: job.fieldExecution?.completion?.hasIssues === true, openFollowUp: job.fieldExecution?.attention?.status === 'open',
    signoff: state ? { status: state.status, by: String(state.by || ''), byName: String(state.byName || state.by || ''), at: String(state.at || ''), reason: String(state.reason || '') } : null,
    overdue: !state && hours !== null && hours >= SIGNOFF_STALE_HOURS,
    ownJob: workedJob(job, matcher) && !isHubOwner(session),
  };
}

/** The list: done jobs completed since windowStart that are not signed off, every job needing follow-up, and a count of
 * older unsigned ones (completed before windowStart, not needing follow-up), oldest completion first. */
export function signoffList(jobs, session, now, { matcher = workerMatcher(session), names = new Map(), windowStart } = {}) {
  const start = windowStart || new Date(Date.parse(now) - SIGNOFF_WINDOW_DAYS * 86400000).toISOString();
  const seen = new Set(), rows = [];
  let older = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!record(job) || seen.has(job.id) || !completedJob(job)) continue;
    seen.add(job.id);
    const state = signoff(job)?.status;
    if (state === 'signed') continue;
    if (state !== 'flagged' && completedAt(job) < start) { older++; continue; }
    rows.push(signoffRow(job, session, matcher, now, names));
  }
  rows.sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')) || a.jobId.localeCompare(b.jobId));
  return { rows, needed: rows.filter(row => !row.signoff).length, overdue: rows.filter(row => row.overdue).length, flagged: rows.filter(row => row.signoff?.status === 'flagged').length, olderUnsigned: older };
}

/** The job patch for a sign-off or a Needs follow-up, or {replayed:true} for a request already applied.
 * input: {action:'sign_off'|'flag', requestId (UUID), reason (flag: 3–1,000 characters; sign-off: optional note),
 * expected:'none'|'flagged' (what the card showed; a job that changed since answers 409)}. */
// fieldWork: workedByEvents over the job's audit log, read by the caller at save time.
export function signoffCommand(job, session, input, now, matcher = workerMatcher(session), { fieldWork = false } = {}) {
  if (!record(input) || !['sign_off', 'flag'].includes(input.action)) throw fail('job_signoff_request_invalid', 'Choose Sign off or Needs follow-up.');
  if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) throw fail('job_signoff_request_invalid', 'This request needs a new request ID. Refresh and try again.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (input.action === 'flag' && (reason.length < 3 || reason.length > 1000)) throw fail('job_signoff_reason_required', 'Say what needs fixing (3 to 1,000 characters).');
  if (reason.length > 1000) throw fail('job_signoff_request_invalid', 'Keep the note to 1,000 characters.');
  const current = signoff(job), history = Array.isArray(job?.supervisorSignoffHistory) ? job.supervisorSignoffHistory.filter(record) : [];
  const prior = [current, ...history].find(entry => entry?.requestId === input.requestId);
  if (prior) {
    if ((prior.action || (prior.status === 'flagged' ? 'flag' : 'sign_off')) !== input.action) throw fail('job_signoff_request_invalid', 'This request ID was already used for something else. Refresh and try again.', 409);
    return { replayed: true };
  }
  if (!completedJob(job)) throw fail('job_signoff_not_completed', 'Only a completed job can be signed off.', 409);
  if ((fieldWork || workedJob(job, matcher)) && !isHubOwner(session)) throw fail('job_signoff_self', 'You worked this job, so another manager or the owner signs it off.', 403);
  if (current?.status === 'signed') throw fail('job_signoff_already_signed', `This job was already signed off by ${current.byName || current.by || 'a manager'}.`, 409);
  if (input.expected !== undefined && input.expected !== (current?.status || 'none')) throw fail('job_signoff_changed', 'Someone else updated this job\'s sign-off. Refresh to see it.', 409);
  if (current?.status === 'flagged' && input.action === 'flag') throw fail('job_signoff_already_flagged', 'This job already needs follow-up. Sign it off once the follow-up is done.', 409);
  const actorName = String(session.displayName || session.user);
  const entry = { status: input.action === 'flag' ? 'flagged' : 'signed', action: input.action, by: session.user, byName: actorName, at: now, reason, requestId: input.requestId };
  const patch = { supervisorSignoff: entry, supervisorSignoffHistory: [...history, entry].slice(-SIGNOFF_HISTORY_LIMIT) };
  const state = record(job.fieldExecution) ? job.fieldExecution : {}, attention = record(state.attention) ? state.attention : null;
  let followUp = null;
  if (input.action === 'flag') {
    const crewReason = stripCrewMoney(`Supervisor follow-up: ${reason}`);
    if (attention?.status === 'open') {
      // The crew lead's open follow-up gets the supervisor's reason added, so it is never silently dropped.
      patch.fieldExecution = { ...state, attention: { ...attention, reason: `${String(attention.reason || '').trim()}\n${crewReason}`.trim(), supervisorFlagRequestId: input.requestId } };
      followUp = 'added';
    } else {
      const past = Array.isArray(state.attentionHistory) ? state.attentionHistory : [];
      patch.fieldExecution = { ...state, ...(attention ? { attentionHistory: [...past, attention].slice(-20) } : {}),
        attention: { at: now, actorId: session.user, actorName, requestId: input.requestId, visibility: 'crew', reason: crewReason, status: 'open', supervisorFlag: true } };
      followUp = 'opened';
    }
  } else if (attention?.status === 'open' && attention.supervisorFlag === true) {
    // Signing off closes the follow-up the flag opened; a crew-reported one stays for the crew lead to resolve.
    patch.fieldExecution = { ...state, attention: { ...attention, status: 'resolved', resolution: `Signed off by ${actorName}.`, resolvedAt: now, resolvedBy: session.user, resolvedByName: actorName, resolutionRequestId: input.requestId } };
    followUp = 'closed';
  }
  return { patch, signoff: entry, followUp };
}

/** The crew lead's open supervisor follow-ups (My day): jobs needing follow-up that this viewer leads. */
export function leadFollowUps(jobs, matcher) {
  return (Array.isArray(jobs) ? jobs : []).filter(job => record(job) && signoff(job)?.status === 'flagged' && job.fieldExecution?.attention?.status === 'open'
    && (matcher.loose(job.crewLead) || (Array.isArray(job.assignmentSegments) ? job.assignmentSegments : []).some(segment => matcher.exact(segment?.crewLead))))
    .map(job => ({ jobId: String(job.id), date: String(job.date || ''), service: String(job.serviceType || job.title || 'Job'), reason: stripCrewMoney(String(job.supervisorSignoff.reason || '')), by: String(job.supervisorSignoff.byName || job.supervisorSignoff.by || ''), at: String(job.supervisorSignoff.at || '') }))
    .sort((a, b) => b.at.localeCompare(a.at));
}
