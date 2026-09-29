import { messagingFlags } from './approved-send.js';
import { MESSAGE_SENDS, ledgerId } from './message-send-store.js';
import { createGhlMessenger, normalizeEmail, normalizePhone } from './ghl-messenger.js';
import { messageDigest } from './message-templates.js';

/**
 * The existing HighLevel "estimate ready" automation (the egc-estimate-ready
 * contact tag the Hub estimate save has always added), fired for ONE sent quote
 * revision after a person confirmed the send (quote-draft.js). It follows the
 * approved-send core: EGC_MESSAGING_ENABLED / EGC_MESSAGING_DRY_RUN apply, the
 * recipient is resolved only from the saved job and verified by the approved-send
 * messenger (contact id, location, phone or email, DND), and a deterministic
 * message_sends ledger is claimed ('sending', compare-and-set) before the
 * provider call. 2xx is submitted, other 4xx (not 408) failed and may be retried
 * by the same send request, and timeouts, 5xx or no answer are uncertain and are
 * never sent again. The job keeps a display copy (estimateReady plus the
 * communication log the Customer messages board reads). The HighLevel call is
 * made only when the send was confirmed in 'automation' mode (estimateReady.mode):
 * a send confirmed as a dry run stays a dry run after the flags change.
 * HighLevel's tag-added trigger does not fire again for a contact that already
 * has the tag (an earlier revision, an earlier send or the Hub estimate save),
 * so the tag is removed and then added again. A 2xx only proves the tag was
 * applied, never that the workflow ran, so the job's log says 'tag_applied'
 * (and records tagReset when the removal was not confirmed).
 */
export const ESTIMATE_READY_TAG = 'egc-estimate-ready';
export const ESTIMATE_READY_KIND = 'estimate_ready';
const HELD = new Set(['submitted', 'uncertain', 'sending']);
const MAX_ATTEMPTS = 3;
// What a send confirmed in another delivery mode reports instead of a live call.
const CONFIRMED = { dry_run: 'dry_run', off: 'messaging_disabled', suppressed: 'suppressed' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digits = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

export const estimateReadySendKey = job => `${ESTIMATE_READY_KIND}:${job.id}:${job.estimate?.number || ''}:r${job.estimate?.revision ?? ''}`;

export function createEstimateReadyDelivery({ store, env = {}, clock = () => new Date(), messenger = createGhlMessenger({ env, clock }) } = {}) {
  const at = () => { const value = clock(); return (value instanceof Date ? value : new Date(value)).toISOString(); };
  // Only the exact sent revision whose send this request recorded may notify the customer.
  async function sentJob(jobId, requestId) {
    const job = await store.read('jobs', jobId);
    return job && plain(job.estimate) && job.estimate.status === 'sent' && job.estimate.sentRequestId === requestId && job.estimate.sentRevision === job.estimate.revision && job.estimateReady?.requestId === requestId ? job : null;
  }
  async function mirror(jobId, requestId, state) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const job = await store.read('jobs', jobId);
        if (!job || job.estimateReady?.requestId !== requestId) return 'skipped';
        const when = state.at || at(), key = `communication:${job.id}:estimate-ready:quote-r${job.estimateReady.revision ?? ''}`;
        const patch = { estimateReady: { ...job.estimateReady, status: state.status, reason: state.reason || '', attempts: state.attempts ?? job.estimateReady.attempts ?? 0, ...(state.recipient ? { recipient: state.recipient } : {}), ...(state.tagReset ? { tagReset: state.tagReset } : {}), at: when } };
        // Dry runs and a messaging switch that is off never reached the customer,
        // so the Customer messages board is left alone for them.
        if (!['dry_run', 'messaging_disabled', 'superseded'].includes(state.status)) {
          const logged = state.status === 'submitted' ? 'tag_applied' : state.status === 'suppressed' ? 'suppressed' : 'needs_attention';
          const entry = { id: key, event: 'estimate-ready', label: 'Estimate ready', status: logged, source: 'manager', attemptedAt: when, trigger: state.status === 'submitted' ? ESTIMATE_READY_TAG : '' };
          Object.assign(patch, { communicationLog: [...(Array.isArray(job.communicationLog) ? job.communicationLog : []).filter(item => item?.id !== key), entry].slice(-40), communicationLastEvent: 'estimate-ready', communicationLastStatus: logged, communicationLastAt: when });
        }
        await store.commit([{ collection: 'jobs', id: job.id, revision: job.revision, patch }]);
        return 'saved';
      } catch { /* Display copy only. Never repeat the provider call. */ }
    }
    return 'failed';
  }
  async function finish(jobId, requestId, state) {
    await mirror(jobId, requestId, state);
    return { status: state.status, ...(state.reason ? { reason: state.reason } : {}), attempts: state.attempts ?? 0, ...(state.recipient ? { recipient: state.recipient } : {}), ...(state.tagReset ? { tagReset: state.tagReset } : {}) };
  }

  async function deliver(jobId, { requestId, actorId = '', actorRole = '', mode } = {}) {
    const flags = messagingFlags(env), job = await sentJob(jobId, requestId);
    if (!job) return { status: 'superseded', reason: 'quote_changed' };
    const confirmed = job.estimateReady.mode;
    if (mode !== undefined && mode !== confirmed) return { status: 'changed', reason: 'delivery_mode_changed' };
    if (job.notify === false) return finish(jobId, requestId, { status: 'suppressed', reason: 'job_notifications_off' });
    if (!flags.enabled) return finish(jobId, requestId, { status: 'messaging_disabled', reason: 'messaging_disabled' });
    if (!flags.dryRun && confirmed !== 'automation') return finish(jobId, requestId, { status: CONFIRMED[confirmed] || 'needs_review', reason: CONFIRMED[confirmed] ? 'confirmed_without_automation' : 'delivery_mode_unknown' });
    const sendKey = estimateReadySendKey(job), id = await ledgerId(sendKey), existing = await store.read(MESSAGE_SENDS, id);
    if (existing && HELD.has(existing.status)) return { status: existing.status === 'submitted' ? 'already_sent' : existing.status, attempts: existing.attempts || 0, alreadyRecorded: true };
    if (existing?.status === 'dry_run' && flags.dryRun) return { status: 'dry_run', attempts: existing.attempts || 0, alreadyRecorded: true };
    if (existing?.status === 'failed' && Number(existing.attempts || 0) >= MAX_ATTEMPTS) return finish(jobId, requestId, { status: 'attempts_exhausted', attempts: existing.attempts });
    const channel = normalizePhone(job.phone) ? 'SMS' : 'Email';
    // A dry run creates no CRM contact; a real send upserts from saved data only.
    const recipient = await messenger.resolveRecipient({ contactId: job.highlevelContactId || '', phone: job.phone || '', email: job.email || '', name: job.customer || '', preferred: channel, upsert: !flags.dryRun });
    if (recipient.status !== 'ready') return finish(jobId, requestId, { status: recipient.status || 'needs_contact', reason: recipient.reason || '', recipient: recipient.masked || '' });
    if (!flags.dryRun && !recipient.contactId) return finish(jobId, requestId, { status: 'needs_contact', reason: 'contact_unverified', recipient: recipient.masked || '' });
    // Re-check after the provider lookup: the sent revision, contact and
    // notification preference must be exactly what the person confirmed.
    const fresh = await sentJob(jobId, requestId);
    if (!fresh || fresh.notify === false || digits(fresh.phone) !== digits(job.phone) || normalizeEmail(fresh.email) !== normalizeEmail(job.email) || (fresh.highlevelContactId || '') !== (job.highlevelContactId || '')) return { status: 'changed', reason: 'quote_changed' };
    const when = at(), attemptId = crypto.randomUUID(), attempts = Number(existing?.attempts || 0) + (flags.dryRun ? 0 : 1);
    const claim = {
      sendKey, kind: ESTIMATE_READY_KIND, audience: 'customer', targetType: 'job', targetId: job.id, approval: 'preview_confirm', source: 'hub',
      actorId: String(actorId).toLowerCase(), actorRole: String(actorRole || ''), templateKind: '', templateVersion: null, templateHash: '', humanAuthored: false,
      channel: 'HighLevel automation', recipient: recipient.masked || '', recipientHash: await messageDigest(`${recipient.channel}:${recipient.toNumber || recipient.emailTo || ''}`), contactId: recipient.contactId || '',
      subject: '', body: `HighLevel estimate-ready automation (${ESTIMATE_READY_TAG}) for ${job.estimate.number} revision ${job.estimate.revision}`, bodyHash: '', attachments: [], requestId,
      status: flags.dryRun ? 'dry_run' : 'sending', attemptId, attempts, idempotencyKey: `egc-estimate-ready-${id.slice(0, 40)}-${attempts}`,
      createdAt: existing?.createdAt || when, attemptedAt: when, completedAt: flags.dryRun ? when : '', messageId: '', conversationId: '', httpStatus: null, reason: '',
      history: [...(Array.isArray(existing?.history) ? existing.history : []), { attempt: attempts, status: flags.dryRun ? 'dry_run' : 'sending', at: when, actorId: String(actorId).toLowerCase(), requestId }].slice(-10),
    };
    try { await store.commit([{ collection: MESSAGE_SENDS, id, ...(existing ? { revision: existing.revision } : {}), patch: claim }]); }
    catch (error) {
      // A lost commit response may still have claimed the send for this call.
      const latest = await store.read(MESSAGE_SENDS, id).catch(() => null);
      if (latest?.attemptId !== attemptId) {
        if (latest) return { status: latest.status === 'submitted' ? 'already_sent' : latest.status, attempts: latest.attempts || 0, alreadyRecorded: true };
        throw error;
      }
    }
    if (flags.dryRun) return finish(jobId, requestId, { status: 'dry_run', attempts, recipient: claim.recipient, at: when });
    // Clear the tag first so HighLevel's tag-added trigger can run again. Removing
    // a tag sends nothing; an unconfirmed removal is recorded, not retried.
    const reset = typeof messenger.removeTags === 'function' ? await messenger.removeTags({ contactId: recipient.contactId, tags: [ESTIMATE_READY_TAG], idempotencyKey: `${claim.idempotencyKey}-reset` }).catch(() => null) : null;
    const tagReset = typeof messenger.removeTags !== 'function' ? '' : reset?.status === 'submitted' ? 'removed' : 'unconfirmed';
    const answer = await messenger.addTags({ contactId: recipient.contactId, tags: [ESTIMATE_READY_TAG], idempotencyKey: claim.idempotencyKey }).catch(() => null);
    const result = ['submitted', 'failed', 'uncertain'].includes(answer?.status) ? answer : { status: 'uncertain', reason: 'no_provider_response' }, completedAt = at();
    const state = { ...claim, status: result.status, httpStatus: result.httpStatus ?? null, reason: result.reason || '', ...(tagReset ? { tagReset } : {}), completedAt, history: [...claim.history.slice(0, -1), { ...claim.history.at(-1), status: result.status, completedAt }] };
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
      try {
        const latest = await store.read(MESSAGE_SENDS, id);
        if (latest?.attemptId !== attemptId) break;
        await store.commit([{ collection: MESSAGE_SENDS, id, revision: latest.revision, patch: state }]);
        saved = true;
      } catch { /* Retry the ledger write; never repeat the provider call. */ }
    }
    // An unsaved outcome leaves the claim in 'sending', which is never resent.
    const status = saved || result.status === 'submitted' ? result.status : 'uncertain';
    return finish(jobId, requestId, { status, reason: saved ? state.reason : 'delivery_status_not_saved', attempts, recipient: claim.recipient, at: completedAt, ...(tagReset ? { tagReset } : {}) });
  }
  return { deliver };
}
