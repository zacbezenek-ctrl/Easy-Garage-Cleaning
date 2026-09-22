import { operationsEnabled } from './operations-service-auth.js';
import { syncNativeNote } from './operations-note-sync.js';
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
};

/** Durable completion intent is written in the same transaction as closeout.
 * This secondary integration can fail without losing or reopening field work.
 * All retries share the original provider request and snapshot; no SMS runs. */
export async function syncFieldCompletion(env, jobId, options = {}) {
  const store = options.store || createFieldStore(env);
  if (!fieldId(jobId)) throw fieldFailure('Choose a valid completed job.');
  const job = await store.readJob(jobId), original = job?.fieldCompletionSync;
  if (!job || job.type !== 'job' || job.recordType || !original || !fieldRequestId(original.requestId) || job.completionEvidence?.kind !== 'verified_field_execution' || job.completionEvidence.requestId !== original.requestId || job.completedAt !== job.fieldExecution?.completion?.completedAt || !['completed', 'paid', 'invoiced', 'review_requested'].includes(fieldStage(job))) throw fieldFailure('This job does not have a verified field completion to synchronize.', 409, 'FIELD_COMPLETION_SYNC_INVALID');
  if (original.status === 'synced') return original;
  const actor = options.actor || { user: original.requestedBy, displayName: original.requestedByName }, eventId = options.eventId || crypto.randomUUID();
  const fingerprint = options.fingerprint || await fieldFingerprint(actor.user, { action: 'completion_sync', jobId, requestId: eventId, completionRequestId: original.requestId });
  const prior = await store.readEvent(jobId, eventId);
  if (prior) { if (prior.fingerprint !== fingerprint) throw fieldFailure('This action ID was used for a different request.', 409, 'FIELD_IDEMPOTENCY_CONFLICT'); return original; }
  const attemptedAt = new Date().toISOString(); let outcome;
  const contactId = original.providerContactId || fieldText(job.highlevelContactId, 200);
  try {
    if (!operationsEnabled(env)) throw Object.assign(new Error('CRM bridge is unavailable'), { code: 'FIELD_COMPLETION_SYNC_UNAVAILABLE' });
    if (!contactId) throw Object.assign(new Error('CRM contact is missing'), { code: 'FIELD_COMPLETION_CONTACT_REQUIRED' });
    if (original.providerContactId && original.providerContactId !== job.highlevelContactId) throw Object.assign(new Error('CRM contact changed'), { code: 'FIELD_COMPLETION_CONTACT_CHANGED' });
    const result = await (options.syncNote || syncNativeNote)(env, actor, { portalJobId: jobId, requestId: `field-completion:${original.requestId}`, contactId, scope: 'post_job', title: original.title, body: original.body });
    outcome = { status: 'synced', message: 'The internal CRM completion note and existing follow-up are verified.', noteId: result.note.id, outboxId: result.outboxId, followupTaskId: result.followupTaskId || null, syncedAt: new Date().toISOString(), errorCode: '' };
  } catch (error) {
    const code = fieldText(error.code, 120) || 'FIELD_COMPLETION_SYNC_FAILED';
    outcome = { status: code.startsWith('FIELD_COMPLETION_') ? 'blocked' : 'error', message: messages[code] || 'Work is complete. The internal CRM note or follow-up could not be verified. Operations can retry the same request safely.', errorCode: code, ...(error.operationId ? { outboxId: fieldText(error.operationId, 200) } : {}) };
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = await store.readJob(jobId);
    if (!latest || latest.fieldCompletionSync?.requestId !== original.requestId || latest.completionEvidence?.requestId !== original.requestId) throw fieldFailure('The completion record changed during synchronization. Operations must review it.', 409, 'FIELD_COMPLETION_SYNC_INVALID');
    if (latest.fieldCompletionSync.status === 'synced') return latest.fieldCompletionSync;
    const saved = { ...latest.fieldCompletionSync, ...outcome, providerContactId: contactId, attemptedAt, attempts: Number(latest.fieldCompletionSync.attempts || 0) + 1 };
    const event = { id: eventId, action: 'completion_sync', state: 'applied', visibility: 'management', actorId: actor.user, actorName: actor.displayName || actor.user, createdAt: new Date().toISOString(), summary: saved.status === 'synced' ? 'Internal CRM completion verified' : 'Completion integration needs attention', body: saved.message, fingerprint, completionRequestId: original.requestId };
    try { await store.commit(latest, { fieldCompletionSync: saved, updatedAt: event.createdAt }, event); return saved; }
    catch (error) {
      const receipt = await store.readEvent(jobId, eventId).catch(() => null);
      if (receipt?.fingerprint === fingerprint) return (await store.readJob(jobId)).fieldCompletionSync;
      if (error.code !== 'FIELD_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
}
