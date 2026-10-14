import { sha256 } from '@noble/hashes/sha2.js';
import { requireQuoteAuthor } from './quote-permissions.js';
import { syncNativeNote } from './operations-note-sync.js';
import { operationsEnabled } from './operations-service-auth.js';
import { stripCrewMoneyDeep } from './crew-money.js';

const LABELS = { customerGoal: 'Goal', whyNow: 'Why now', sortMethod: 'Sorting', keepItems: 'Keep', removeItems: 'Remove', donateItems: 'Donate', exclusions: 'Excluded', hazards: 'Hazards', hazardPlan: 'Hazard plan', damageNotes: 'Existing damage', access: 'Access', accessNotes: 'Access notes', truckPlacement: 'Truck placement', measurements: 'Measurements', equipment: 'Equipment', customerQuestions: 'Customer questions', specialItems: 'Special items', finish: 'Finish', crewSize: 'Estimated crew size', estimatedJobMinutes: 'Estimated on-site minutes', operationalScope: 'Crew instructions' };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(?:secure_|_egc_)/.test(value);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code: `quote_draft_capture_${code}`, status });
const fingerprint = text => [...sha256(new TextEncoder().encode(text))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const walkthroughCaptureSyncEnabled = env => env?.EGC_WALKTHROUGH_CAPTURE_SYNC === 'true' && env?.EGC_MESSAGING_DRY_RUN === 'false' && operationsEnabled(env);

/** Stored atomically with the draft, never sent during save. Only approved
 * operational fields become a frozen internal-note intent. */
export function prepareWalkthroughCaptureSync(job, now) {
  const instructions = stripCrewMoneyDeep(job.jobInstructions || {});
  const lines = Object.entries(LABELS).flatMap(([key, label]) => {
    const value = instructions[key];
    const text = Array.isArray(value) ? value.filter(item => typeof item === 'string').join('; ') : typeof value === 'string' ? value.trim() : ['crewSize','estimatedJobMinutes'].includes(key)&&Number.isInteger(value)?String(value):'';
    return text ? [`${label}: ${text}`] : [];
  });
  const body = [`Unsigned staff walkthrough capture`, `Hub job: ${job.id}`, 'This note does not record customer acceptance, a confirmed schedule or payment.', ...lines].join('\n');
  const key = `walkthrough-capture:${job.id}:${fingerprint(JSON.stringify([job.customerId || '', job.highlevelContactId || '', body])).slice(0, 32)}`;
  if (job.walkthroughCaptureSync?.key === key && job.walkthroughCaptureSync?.body === (body.length > 20000 ? '' : body)) return job.walkthroughCaptureSync;
  return { version: 1, key, status: body.length > 20000 ? 'needs_review' : 'pending', code: body.length > 20000 ? 'capture_too_large' : '',
    body: body.length > 20000 ? '' : body, attempts: 0, createdAt: now, updatedAt: now };
}

export function walkthroughCaptureSyncView(job) {
  const state = job?.walkthroughCaptureSync;
  if (state?.version !== 1 || typeof state.key !== 'string') return null;
  return { key: state.key, status: state.status, code: state.code || '', attempts: state.attempts || 0, updatedAt: state.updatedAt };
}

/** The existing platform outbox owns the provider write and reconciles unknown
 * outcomes by its operation marker. This layer only reports/fences Hub state. */
export async function syncWalkthroughCapture(store, actor, input, now, { env = {}, note = syncNativeNote } = {}) {
  requireQuoteAuthor(actor, env);
  if (!input || Object.keys(input).some(key => !['jobId', 'syncKey', 'actorId'].includes(key)) || !safeId(input.jobId) || typeof input.syncKey !== 'string') throw fail('invalid_request', 'Choose the saved walkthrough capture.', 400);
  if (input.actorId !== undefined && String(input.actorId).toLowerCase() !== String(actor.user).toLowerCase()) throw fail('actor_changed', 'The signed-in employee changed. Reopen the saved quote.', 403);
  let job = await store.read('jobs', input.jobId);
  if (!job?.quoteDraft || !['job', 'cleanout', 'reorg'].includes(job.type) || !job.revision || job.walkthroughCaptureSync?.key !== input.syncKey) throw fail('changed', 'This capture changed. Reload the saved quote before retrying.');
  const state = job.walkthroughCaptureSync;
  const derived = prepareWalkthroughCaptureSync(job, now);
  if (state.version !== 1 || derived.key !== state.key || derived.body !== state.body) throw fail('changed', 'The saved capture or contact link changed. Save the walkthrough again before syncing.');
  if (state.status === 'synced') return { enabled: walkthroughCaptureSyncEnabled(env), state: walkthroughCaptureSyncView(job) };
  if (!walkthroughCaptureSyncEnabled(env)) return { enabled: false, state: walkthroughCaptureSyncView(job) };
  if (state.status === 'needs_review') return { enabled: true, state: walkthroughCaptureSyncView(job) };
  const customer = safeId(job.customerId) ? await store.read('customers', job.customerId) : null;
  const contactId = job.highlevelContactId;
  const linked = safeId(contactId) && customer?.highlevelContactId === contactId;
  const pending = state.status === 'syncing' && Date.parse(now) - Date.parse(state.updatedAt) < 600000;
  if (pending) return { enabled: true, state: walkthroughCaptureSyncView(job) };
  const attempt = (state.attempts || 0) + 1;
  const started = { ...state, status: linked ? 'syncing' : 'needs_link', code: linked ? '' : 'contact_link_required', attempts: attempt, updatedAt: now };
  try { await store.commit([{ collection: 'jobs', id: job.id, revision: job.revision, patch: { walkthroughCaptureSync: started } }]); }
  catch { throw fail('changed', 'This capture changed while starting sync. Reload and retry.'); }
  if (!linked) return { enabled: true, state: walkthroughCaptureSyncView({ ...job, walkthroughCaptureSync: started }) };
  let result;
  try {
    const receipt = await note(env, actor, { portalJobId: job.id, requestId: state.key, contactId, scope: 'unsigned_walkthrough', title: 'EGC Unsigned Walkthrough', body: state.body });
    if (!receipt?.note?.id || receipt.providerSync !== 'verified') throw new Error('unverified');
    result = { status: 'synced', code: '', noteId: receipt.note.id, outboxId: receipt.outboxId || '' };
  } catch (error) {
    const pending = ['provider_note_pending', 'provider_note_outcome_unknown', 'provider_note_response_unverified'].includes(error.code);
    result = { status: pending ? 'pending' : 'error', code: pending ? 'provider_confirmation_pending' : 'provider_sync_failed' };
  }
  // A reply for an older capture/attempt cannot erase a newer saved intent.
  job = await store.read('jobs', input.jobId);
  if (job?.walkthroughCaptureSync?.key === state.key && job.walkthroughCaptureSync.attempts === attempt) {
    try { await store.commit([{ collection: 'jobs', id: job.id, revision: job.revision, patch: { walkthroughCaptureSync: { ...started, ...result, updatedAt: now } } }]); } catch { /* exact intent remains retryable through the native outbox */ }
  }
  const latest = await store.read('jobs', input.jobId);
  return { enabled: true, state: walkthroughCaptureSyncView(latest) };
}
