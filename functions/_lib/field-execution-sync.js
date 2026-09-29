import { operationsEnabled } from './operations-service-auth.js';
import { syncNativeNote } from './operations-note-sync.js';
import { ensureHighLevelCheckin } from './highlevel-checkin.js';
import { fieldFailure, fieldFingerprint, fieldId, fieldRequestId, fieldStage, fieldText } from './field-execution.js';
import { createFieldStore } from './field-execution-store.js';

const messages = {
  FIELD_COMPLETION_SYNC_UNAVAILABLE: 'Work is complete. The internal CRM bridge is not configured; operations can retry after it is connected.',
  FIELD_COMPLETION_CONTACT_REQUIRED: 'Work is complete. Link this job to its existing CRM customer before retrying the completion note.',
  FIELD_COMPLETION_CONTACT_CHANGED: 'The linked CRM customer changed after completion. Operations must review the job link before retrying.',
  provider_note_pending: 'Work is complete. The internal CRM note is queued and awaiting verification. Retry checks the existing request.',
  provider_note_requires_review: 'Work is complete. The internal CRM note needs operations review before it can be verified.',
  post_job_followup_owner_unresolved: 'Work is complete. The CRM note was received, but the follow-up owner needs configuration.',
  post_job_followup_unavailable: 'Work is complete. The CRM note was received, but the existing internal follow-up could not be verified.',
  HIGHLEVEL_CHECKIN_UNAVAILABLE: 'Work is complete. The CRM note was received, but the HighLevel 6-month check-in task could not be confirmed. Retry checks HighLevel before adding it.',
  HIGHLEVEL_CHECKIN_IN_PROGRESS: 'Work is complete. Another attempt is creating the HighLevel 6-month check-in task. Refresh in a minute before retrying.',
  FIELD_COMPLETION_CHECKIN_NOT_CONFIGURED: 'Work is complete. The CRM note was received, but HighLevel is not configured for the Hub (HIGHLEVEL_API_KEY and HIGHLEVEL_LOCATION_ID on Cloudflare Pages), so the 6-month check-in task was not created. Retry after it is configured.',
  FIELD_COMPLETION_CHECKIN_INVALID: 'Work is complete. The CRM note was received, but the linked CRM contact or completion time cannot be used for the HighLevel 6-month check-in. Operations must review the job before retrying.',
  HIGHLEVEL_CHECKIN_KEPT: 'Work is complete. The internal CRM note is verified, and the HighLevel 6-month check-in task from an earlier attempt stays the check-in. Operations should cancel the duplicate platform check-in task in the Action Center.',
  FIELD_COMPLETION_CHECKIN_REJECTED: 'Work is complete. The CRM note was received, but HighLevel refused the 6-month check-in task. Check the HighLevel key\'s contact access and the linked contact, then retry.',
};
// Outcomes a retry cannot fix until someone changes the setup or the job.
const CHECKIN_BLOCKED = { not_configured: 'FIELD_COMPLETION_CHECKIN_NOT_CONFIGURED', invalid: 'FIELD_COMPLETION_CHECKIN_INVALID', failed: 'FIELD_COMPLETION_CHECKIN_REJECTED' };
// One attempt at a time creates the HighLevel check-in. Its two HighLevel
// calls time out after 15 seconds each, so an older claim was abandoned.
const CHECKIN_LEASE_MS = 120000;

// Revision-checked claim on the job, so the background sync after 'complete'
// and a manager's retry never both read an empty task list and both POST.
async function claimCheckin(store, jobId, requestId, attemptId, now) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = await store.readJob(jobId), sync = latest?.fieldCompletionSync, at = now();
    if (!latest || sync?.requestId !== requestId || latest.completionEvidence?.requestId !== requestId) throw fieldFailure('The completion record changed during synchronization. Operations must review it.', 409, 'FIELD_COMPLETION_SYNC_INVALID');
    if (sync.status === 'synced') return { synced: sync };
    const held = sync.checkin;
    if (held?.status === 'creating' && held.attemptId !== attemptId && at.getTime() - Date.parse(held.at) < CHECKIN_LEASE_MS) return { holder: held.attemptId };
    try { await store.commit(latest, { fieldCompletionSync: { ...sync, checkin: { status: 'creating', attemptId, at: at.toISOString() } } }, null); return {}; }
    catch (error) { if (error.code !== 'FIELD_REVISION_CONFLICT' || attempt === 3) throw error; }
  }
}

/** Durable completion intent is written in the same transaction as closeout.
 * This secondary integration can fail without losing or reopening field work.
 * All retries share the original provider request and snapshot; no SMS runs. */
export async function syncFieldCompletion(env, jobId, options = {}) {
  const store = options.store || createFieldStore(env), now = options.now || (() => new Date());
  if (!fieldId(jobId)) throw fieldFailure('Choose a valid completed job.');
  const job = await store.readJob(jobId), original = job?.fieldCompletionSync;
  if (!job || job.type !== 'job' || job.recordType || !original || !fieldRequestId(original.requestId) || job.completionEvidence?.kind !== 'verified_field_execution' || job.completionEvidence.requestId !== original.requestId || job.completedAt !== job.fieldExecution?.completion?.completedAt || !['completed', 'paid', 'invoiced', 'review_requested'].includes(fieldStage(job))) throw fieldFailure('This job does not have a verified field completion to synchronize.', 409, 'FIELD_COMPLETION_SYNC_INVALID');
  if (original.status === 'synced') return original;
  const actor = options.actor || { user: original.requestedBy, displayName: original.requestedByName }, eventId = options.eventId || crypto.randomUUID();
  const fingerprint = options.fingerprint || await fieldFingerprint(actor.user, { action: 'completion_sync', jobId, requestId: eventId, completionRequestId: original.requestId });
  const prior = await store.readEvent(jobId, eventId);
  if (prior) { if (prior.fingerprint !== fingerprint) throw fieldFailure('This action ID was used for a different request.', 409, 'FIELD_IDEMPOTENCY_CONFLICT'); return original; }
  const attemptedAt = now().toISOString(); let outcome, checkin = null, holder = '';
  const contactId = original.providerContactId || fieldText(job.highlevelContactId, 200);
  try {
    if (!operationsEnabled(env)) throw Object.assign(new Error('CRM bridge is unavailable'), { code: 'FIELD_COMPLETION_SYNC_UNAVAILABLE' });
    if (!contactId) throw Object.assign(new Error('CRM contact is missing'), { code: 'FIELD_COMPLETION_CONTACT_REQUIRED' });
    if (original.providerContactId && original.providerContactId !== job.highlevelContactId) throw Object.assign(new Error('CRM contact changed'), { code: 'FIELD_COMPLETION_CONTACT_CHANGED' });
    const result = await (options.syncNote || syncNativeNote)(env, actor, { portalJobId: jobId, requestId: `field-completion:${original.requestId}`, contactId, scope: 'post_job', title: original.title, body: original.body });
    // HighLevel owns the 6-month check-in unless the platform reports its own (opt-in) task. An earlier attempt
    // may already have written the HighLevel task (a POST whose response was lost before the platform task was
    // switched on), so then HighLevel is read, never written, before the platform task is accepted.
    const platformTaskId = result.followupTaskId || null;
    if (!platformTaskId || original.checkin?.attemptId) {
      const claim = await claimCheckin(store, jobId, original.requestId, eventId, now);
      if (claim.synced) return claim.synced;
      if (claim.holder) { holder = claim.holder; throw Object.assign(new Error('HighLevel check-in is being created'), { code: 'HIGHLEVEL_CHECKIN_IN_PROGRESS', operationId: result.outboxId }); }
      const found = await (options.checkin || ensureHighLevelCheckin)(env, { contactId, completedAt: job.completedAt, ...(platformTaskId ? { readOnly: true } : {}) });
      checkin = { status: fieldText(found?.status, 40) || 'uncertain', attemptId: eventId, at: now().toISOString(), ...(found?.taskId ? { taskId: fieldText(found.taskId, 200) } : {}), ...(Number.isInteger(found?.httpStatus) ? { httpStatus: found.httpStatus } : {}) };
      if (!(platformTaskId ? ['exists', 'absent'] : ['created', 'exists']).includes(checkin.status)) throw Object.assign(new Error('HighLevel check-in task is unconfirmed'), { code: CHECKIN_BLOCKED[checkin.status] || 'HIGHLEVEL_CHECKIN_UNAVAILABLE', operationId: result.outboxId });
    }
    // Both exist: the HighLevel task stays the check-in and the platform task is reported for operations to cancel.
    const duplicate = Boolean(platformTaskId && checkin?.taskId);
    outcome = { status: 'synced', message: duplicate ? messages.HIGHLEVEL_CHECKIN_KEPT : 'The internal CRM completion note and existing follow-up are verified.', noteId: result.note.id, outboxId: result.outboxId, followupTaskId: duplicate ? null : platformTaskId, ...(checkin?.taskId ? { checkinTaskId: checkin.taskId } : {}), ...(duplicate ? { duplicateFollowupTaskId: fieldText(platformTaskId, 200) } : {}), syncedAt: now().toISOString(), errorCode: '' };
  } catch (error) {
    const code = fieldText(error.code, 120) || 'FIELD_COMPLETION_SYNC_FAILED';
    outcome = { status: code === 'HIGHLEVEL_CHECKIN_IN_PROGRESS' ? 'pending' : code.startsWith('FIELD_COMPLETION_') ? 'blocked' : 'error', message: messages[code] || 'Work is complete. The internal CRM note or follow-up could not be verified. Operations can retry the same request safely.', errorCode: code, ...(error.operationId ? { outboxId: fieldText(error.operationId, 200) } : {}) };
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = await store.readJob(jobId);
    if (!latest || latest.fieldCompletionSync?.requestId !== original.requestId || latest.completionEvidence?.requestId !== original.requestId) throw fieldFailure('The completion record changed during synchronization. Operations must review it.', 409, 'FIELD_COMPLETION_SYNC_INVALID');
    if (latest.fieldCompletionSync.status === 'synced') return latest.fieldCompletionSync;
    const held = latest.fieldCompletionSync.checkin, ours = held?.status === 'creating' && held.attemptId === eventId;
    // A deferred attempt writes nothing once the holder has released its claim: the holder's result stands.
    if (holder && !(held?.status === 'creating' && held.attemptId === holder)) return latest.fieldCompletionSync;
    // Release this attempt's claim with its result; a claim that never reached a result is left for the next attempt to read back.
    const saved = { ...latest.fieldCompletionSync, ...outcome, ...(checkin ? { checkin } : ours ? { checkin: { ...held, status: 'uncertain' } } : {}), providerContactId: contactId, attemptedAt, attempts: Number(latest.fieldCompletionSync.attempts || 0) + 1 };
    const event = { id: eventId, action: 'completion_sync', state: 'applied', visibility: 'management', actorId: actor.user, actorName: actor.displayName || actor.user, createdAt: now().toISOString(), summary: saved.status === 'synced' ? 'Internal CRM completion verified' : 'Completion integration needs attention', body: saved.message, fingerprint, completionRequestId: original.requestId };
    try { await store.commit(latest, { fieldCompletionSync: saved, updatedAt: event.createdAt }, event); return saved; }
    catch (error) {
      const receipt = await store.readEvent(jobId, eventId).catch(() => null);
      if (receipt?.fingerprint === fingerprint) return (await store.readJob(jobId)).fieldCompletionSync;
      if (error.code !== 'FIELD_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
}
