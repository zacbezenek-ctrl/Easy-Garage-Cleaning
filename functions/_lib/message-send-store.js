import { firestoreFetch } from './firebase-service-account.js';
import { dispatchStorage } from './dispatch-storage.js';
import { messageDigest } from './message-templates.js';

// Server-only collections. firestore.rules denies every browser read/write.
export const MESSAGE_SENDS = 'message_sends';
export const MESSAGE_TEMPLATES = 'message_templates';
export const MESSAGE_OPERATIONS = 'message_operations';

const failure = (code, message, status) => Object.assign(new Error(message), { code, status });
function messagingError(error) {
  const code = String(error?.code || '');
  if (code === 'dispatch_revision_conflict') return failure('messaging_revision_conflict', 'This messaging record changed at the same time. Refresh and review before trying again.', 409);
  if (code === 'dispatch_outcome_unknown') return failure('messaging_outcome_unknown', 'The save response was lost. Retry the same request to safely verify its outcome.', 503);
  if (code.startsWith('dispatch_storage_')) return failure('messaging_storage_unavailable', 'Messaging records could not be verified. Retry the same request.', 503);
  if (code.startsWith('dispatch_')) return failure('messaging_roster_unavailable', 'The employee roster could not be verified. Retry the same request.', 503);
  return error;
}

// Reuses the dispatch Firestore adapter (revision = updateTime, create-only or
// exact-revision commits) and only renames its errors for this subsystem.
export function messagingStorage(env, fetcher = firestoreFetch) {
  const base = dispatchStorage(env, fetcher);
  const wrap = method => async (...args) => { try { return await method(...args); } catch (error) { throw messagingError(error); } };
  return { read: wrap(base.read), commit: wrap(base.commit), roster: wrap(base.roster) };
}

export const ledgerId = sendKey => messageDigest(`egc-message-send:${sendKey}`);

export async function readReceipt(store, requestId) {
  return store.read(MESSAGE_OPERATIONS, requestId.toLowerCase());
}

// Receipts are written after the send path finished. A lost receipt is safe:
// the send ledger still refuses to deliver the same logical message twice.
export async function saveReceipt(store, requestId, receipt) {
  try { await store.commit([{ collection: MESSAGE_OPERATIONS, id: requestId.toLowerCase(), patch: receipt }]); return true; }
  catch { return false; }
}
