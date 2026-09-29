import { addTags, ghl, highLevelConfig } from './highlevel-tags.js';
import { operationsEnabled } from './operations-service-auth.js';
import { syncNativeNote } from './operations-note-sync.js';

// The money commit records each source in fieldPaymentSyncPendingIds. This
// helper may run after the HTTP response was lost, a webhook, or a manager's
// retry. The provider note uses the verified source as its stable key.
const SUBMISSIONS = 'fieldPaymentSubmissions';
const CARDS = 'fieldPaymentCardSessions';
const pendingId = (kind, sourceId) => `${kind}:${sourceId}`;
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const digits = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const email = value => String(value || '').trim().toLowerCase();
const money = cents => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function verifiedSource(job, kind, sourceId, row, claim) {
  if (!Array.isArray(job.fieldPaymentSyncPendingIds) || !job.fieldPaymentSyncPendingIds.includes(pendingId(kind, sourceId))) return null;
  if (kind === 'card') {
    const item = job.payment?.verified === true && Array.isArray(job.payment?.stripeSessions)
      ? job.payment.stripeSessions.find(entry => entry?.sessionId === sourceId && entry.fieldExact === true) : null;
    const amountCents = Math.round(Number(item?.amount) * 100);
    if (!item || !Number.isSafeInteger(amountCents) || amountCents < 1 || claim?.jobId !== job.id || claim.sessionId !== sourceId || claim.status !== 'settled' || claim.amountCents !== amountCents) return null;
    return { amountCents: claim.amountCents, method: 'card', reference: sourceId, at: item.verifiedAt || '' };
  }
  if (kind === 'receipt' && row?.jobId === job.id && row.id === sourceId && row.status === 'accepted' && row.reviewRequestId &&
      job.payment?.verified === true && Array.isArray(job.paymentLedger) &&
      job.paymentLedger.some(entry => entry?.id === `offline:${row.reviewRequestId}` && entry.amountCents === row.amountCents && entry.verified === true)) {
    return { amountCents: row.amountCents, method: row.method, reference: row.reference, at: row.reviewedAt || '' };
  }
  return null;
}

async function status(store, jobId, kind, sourceId, state, noteId = '') {
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await store.read('jobs', jobId);
    if (!job) return false;
    const key = pendingId(kind, sourceId), ids = Array.isArray(job.fieldPaymentSyncPendingIds) ? job.fieldPaymentSyncPendingIds : [];
    if (!ids.includes(key)) return state === 'synced';
    const patch = { fieldPaymentSyncPendingIds: state === 'synced' ? ids.filter(id => id !== key) : ids };
    if (kind === 'card' && job.paymentSyncPayload?.sessionId === sourceId) Object.assign(patch, { paymentSyncStatus: state, paymentSyncError: state === 'error' ? 'HighLevel handoff needs a manager retry.' : '', ...(noteId ? { paymentSyncNoteId: noteId } : {}) });
    const writes = [{ collection: 'jobs', id: jobId, revision: job.revision, patch }];
    if (kind === 'receipt') {
      const row = await store.read(SUBMISSIONS, sourceId);
      if (!row || row.jobId !== jobId || row.status !== 'accepted') return false;
      writes.push({ collection: SUBMISSIONS, id: sourceId, revision: row.revision, patch: { crmSyncStatus: state, crmSyncError: state === 'error' ? 'HighLevel handoff needs a manager retry.' : '', ...(noteId ? { crmNoteId: noteId } : {}) } });
    }
    try { await store.commit(writes); return true; }
    catch { /* A concurrent money or review write is re-read before retry. */ }
  }
  return false;
}

export async function syncFieldPayment(env, store, jobId, kind, sourceId) {
  const job = await store.read('jobs', jobId), row = kind === 'receipt' ? await store.read(SUBMISSIONS, sourceId) : null;
  const claim = kind === 'card' ? await store.read(CARDS, sourceId) : null;
  const source = job && verifiedSource(job, kind, sourceId, row, claim);
  if (!source) {
    if (kind === 'receipt' && row?.jobId === jobId && row.crmSyncStatus === 'synced') return { synced: true, alreadyApplied: true };
    if (kind === 'card' && job?.paymentSyncPayload?.sessionId === sourceId && job.paymentSyncStatus === 'synced') return { synced: true, alreadyApplied: true };
    throw fail('FIELD_PAY_CRM_SOURCE_UNVERIFIED', 'Only a verified field payment can be sent to HighLevel.');
  }
  try {
    const c = highLevelConfig(env);
    if (!c.token || !c.locationId) throw fail('FIELD_PAY_CRM_UNAVAILABLE', 'HighLevel is not configured for payment handoffs.');
    const contactId = String(job.highlevelContactId || '').trim();
    if (!contactId || !email(job.email) && !digits(job.phone)) throw fail('FIELD_PAY_CRM_CONTACT_REQUIRED', 'Link the verified HighLevel customer before retrying this handoff.');
    const result = await ghl(c, `/contacts/${encodeURIComponent(contactId)}`), contact = result.contact || {};
    const phoneMatch = digits(job.phone) && digits(job.phone) === digits(contact.phone), emailMatch = email(job.email) && email(job.email) === email(contact.email);
    const explicitConflict = email(job.email) && email(contact.email) && !emailMatch || digits(job.phone) && digits(contact.phone) && !phoneMatch;
    if (contact.id !== contactId || contact.locationId !== c.locationId || explicitConflict || !phoneMatch && !emailMatch) throw fail('FIELD_PAY_CRM_CONTACT_CONFLICT', 'The linked HighLevel customer needs manager review.');
    const noteBody = `${kind === 'card' ? 'Stripe card payment verified' : 'Crew cash/check receipt approved'}: ${money(source.amountCents)}. Method: ${source.method}. Reference: ${source.reference}. Job: ${jobId}.`;
    const key = `field-payment:${kind}:${sourceId}`;
    if (!operationsEnabled(env)) throw fail('FIELD_PAY_CRM_BRIDGE_REQUIRED', 'The operations note bridge is needed for safe payment handoff retry.');
    const noteId = (await syncNativeNote(env, { user: 'field-payment-service' }, { portalJobId: jobId, requestId: key, contactId, scope: 'lifecycle_payment-received', title: 'EGC Lifecycle — payment-received', body: noteBody })).note.id;
    if (!noteId) throw fail('FIELD_PAY_CRM_NOTE_UNVERIFIED', 'HighLevel did not confirm the payment note.');
    await addTags(c, contactId, ['egc-payment-received']);
    if (!await status(store, jobId, kind, sourceId, 'synced', noteId)) throw fail('FIELD_PAY_CRM_STATUS_PENDING', 'The HighLevel payment handoff needs a manager retry.');
    return { synced: true, noteId };
  } catch (error) {
    await status(store, jobId, kind, sourceId, 'error').catch(() => false);
    return { synced: false, code: error.code || 'FIELD_PAY_CRM_RETRY_REQUIRED' };
  }
}
