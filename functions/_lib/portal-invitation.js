import { createCustomerPortalAccessToken, customerPortalConfigured } from './customer-portal.js';
import { customerPortalLinkAccount } from './customer-portal-revocation.js';
import { firebaseServiceAccountConfigured, firestoreFetch } from './firebase-service-account.js';
import { readJob, patchJob, decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';

const API = 'https://services.leadconnectorhq.com';
const PORTAL = 'https://easygaragecleaning.com/api/customer-portal-session';
const terminal = new Set(['submitted', 'sending', 'uncertain']);
const phone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits.length >= 11 && digits.length <= 15 ? `+${digits}` : '';
};
const email = value => String(value || '').trim().toLowerCase();

const stateUrl = jobId => `https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/portal_invitations/${encodeURIComponent(jobId)}`;

async function readState(env, jobId) {
  const response = await firestoreFetch(env, stateUrl(jobId));
  if (response.status === 404) return { state: {}, updateTime: '' };
  if (!response.ok) throw new Error('Invitation storage unavailable');
  const document = await response.json();
  if (!document.updateTime) throw new Error('Invitation version unavailable');
  return { state: decodeFirestoreFields(document.fields), updateTime: document.updateTime };
}

async function writeState(env, jobId, state, updateTime) {
  const url = new URL(stateUrl(jobId));
  url.searchParams.set(updateTime ? 'currentDocument.updateTime' : 'currentDocument.exists', updateTime || 'false');
  const response = await firestoreFetch(env, url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFirestoreFields(state) }) });
  if (!response.ok) throw new Error('Invitation storage changed');
}

async function mirrorState(env, jobId, state) {
  // Display-only copy. Job edits can never change the authoritative ledger.
  try {
    const job = await readJob(env, jobId);
    if (job?.__updateTime) await patchJob(env, jobId, { customerPortalInvitation: state }, job.__updateTime);
  } catch { /* Delivery remains recorded in the server-only ledger. */ }
}

// A company project is shared through its business account's delegated,
// role-checked access. A homeowner owner-level link would bypass those roles,
// so a linked job (any non-empty marker, even a malformed one) never gets one.
// Unlinking clears the marker to '', which restores homeowner delivery.
export function businessAccountJob(job) {
  const value = job?.businessAccountId;
  return typeof value === 'string' ? value.trim() !== '' : value != null && value !== false;
}

export function quoteApproved(job = {}) {
  return job.type === 'job' && ![job.status, job.pipelineStatus].some(value => ['cancelled', 'superseded'].includes(String(value || '').toLowerCase())) &&
    ['accepted', 'approved'].includes(String(job.estimate?.status || '').toLowerCase()) &&
    Number(job.estimate?.amount || job.total || job.priceQuoted || 0) > 0;
}

function config(env) {
  return { token: env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || '', locationId: env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID || '' };
}

async function requestHighLevel(c, path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${c.token}`, Version: 'v3', Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  return { response, data: await response.json().catch(() => ({})) };
}

// Resolve only from the saved customer's details. An incoming request cannot
// choose the destination of a bearer link, even if it supplies a contact ID.
async function recipient(c, job) {
  let id = String(job.highlevelContactId || '');
  if (!id) {
    const { response, data } = await requestHighLevel(c, '/contacts/upsert', { method: 'POST', body: JSON.stringify({
      locationId: c.locationId, name: job.customer || '', phone: phone(job.phone) || undefined,
      email: email(job.email) || undefined, source: 'EGC accepted quote',
    }) });
    if (!response.ok) return { status: 'needs_contact' };
    id = String(data.contact?.id || '');
  }
  if (!id) return { status: 'needs_contact' };
  const { response, data } = await requestHighLevel(c, `/contacts/${encodeURIComponent(id)}`);
  if (!response.ok || !data.contact) return { status: 'needs_contact' };
  const contact = data.contact, useSms = Boolean(phone(job.phone));
  const matches = useSms ? phone(contact.phone) === phone(job.phone) : email(contact.email) === email(job.email);
  if (contact.id !== id || contact.locationId !== c.locationId || !matches) return { status: 'contact_mismatch' };
  const channel = useSms ? 'SMS' : 'Email';
  const dnd = contact.dndSettings?.[channel]?.status;
  if (contact.dnd === true || (dnd && String(dnd).toLowerCase() !== 'inactive')) return { status: 'suppressed', reason: 'contact_dnd' };
  return { id, channel };
}

// One invitation per job, not per browser timestamp or save. A compare-and-set
// claim prevents concurrent sends. Ambiguous provider responses never auto-retry.
// Store delivery metadata only: staff-readable job records must not hold tokens.
export async function sendAcceptedQuotePortal(env, jobId, { requireRequested = false, now: clock = () => new Date() } = {}) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(jobId || ''))) return { status: 'needs_job' };
  if (!firebaseServiceAccountConfigured(env)) return { status: 'not_configured', reason: 'secure_storage' };
  let job;
  try { job = await readJob(env, jobId); } catch { return { status: 'storage_unavailable' }; }
  if (!job) return { status: 'needs_job' };
  if (!quoteApproved(job)) return { status: 'not_approved' };
  if (requireRequested && !job.customerPortalInvitationRequestedAt) return { status: 'not_requested' };
  let ledger;
  try { ledger = await readState(env, jobId); } catch { return { status: 'storage_unavailable' }; }
  const previous = ledger.state;
  if (terminal.has(previous.status)) { await mirrorState(env, jobId, previous); return previous; }
  const now = clock().toISOString();
  const base = { jobId, requestedAt: previous.requestedAt || now, attemptedAt: now, attempts: Number(previous.attempts || 0) + 1 };
  const save = async value => {
    const state = { ...base, ...value };
    try {
      await writeState(env, jobId, state, ledger.updateTime);
      await mirrorState(env, jobId, state);
      return state;
    } catch { return { status: 'busy', jobId }; }
  };
  if (!job.__updateTime) return { status: 'storage_unavailable' };
  if (businessAccountJob(job)) return save({ status: 'suppressed', reason: 'business_account_job' });
  if (job.notify === false) return save({ status: 'suppressed', reason: 'job_notifications_off' });
  const c = config(env);
  if (!customerPortalConfigured(env) || !c.token || !c.locationId) return save({ status: 'not_configured', reason: 'portal_or_highlevel' });
  if (!phone(job.phone) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email(job.email))) return save({ status: 'needs_contact', reason: 'no_phone_or_email' });
  let to;
  try { to = await recipient(c, job); } catch { return save({ status: 'needs_contact' }); }
  if (!to.id) return save(to);
  // Do not send if an ordinary job edit changed the approval, contact, or
  // notification preference while HighLevel was being checked.
  let current;
  try { current = await readJob(env, jobId); } catch { return { status: 'storage_unavailable' }; }
  if (current && businessAccountJob(current)) return save({ status: 'suppressed', reason: 'business_account_job' });
  if (!current || !quoteApproved(current) || current.notify === false || phone(current.phone) !== phone(job.phone) || email(current.email) !== email(job.email) || current.highlevelContactId !== job.highlevelContactId) return { status: 'busy', jobId };
  // The link carries the account's current version and root, so a later staff
  // revocation (or re-parenting) also ends this invitation. An unverifiable
  // account never sends.
  let account, linkVersion;
  try { ({ account, linkVersion } = await customerPortalLinkAccount(id => readJob(env, id), current)); } catch { return { status: 'storage_unavailable' }; }
  const token = await createCustomerPortalAccessToken(env, jobId, clock().getTime(), linkVersion, account.id);
  const url = `${PORTAL}?access=${encodeURIComponent(token)}`;
  const firstName = String(job.customer || '').trim().split(/\s+/)[0].replace(/[<>]/g, '').slice(0, 50);
  const message = `${firstName ? `Hi ${firstName}, your` : 'Your'} quote is approved. Here is your private Easy Garage Cleaning project portal for job details, messages, and payments: ${url}`;
  const attemptId = crypto.randomUUID();
  const claimed = await save({ status: 'sending', channel: to.channel, attemptId });
  if (claimed.status !== 'sending') return claimed;
  // Only this claim may settle the ledger. Re-read it each time because the
  // scheduling sync may have updated other job fields meanwhile.
  const settle = async state => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const latest = await readState(env, jobId);
        if (latest.state.attemptId !== attemptId) break;
        await writeState(env, jobId, state, latest.updateTime);
        await mirrorState(env, jobId, state);
        return true;
      } catch { /* Retry metadata persistence; never repeat the external send. */ }
    }
    return false;
  };
  // A business link or opt-out saved after the last check (link_project does
  // not consult this ledger) still wins: release the claim before HighLevel is
  // called. A job that cannot be re-read never sends.
  let halt;
  try {
    const latest = await readJob(env, jobId);
    halt = !latest ? { status: 'needs_job' } : businessAccountJob(latest) ? { status: 'suppressed', reason: 'business_account_job' }
      : latest.notify === false ? { status: 'suppressed', reason: 'job_notifications_off' } : null;
  } catch { halt = { status: 'storage_unavailable' }; }
  if (halt) { const state = { ...base, ...halt }; return await settle(state) ? state : claimed; }
  let result;
  try {
    const { response, data } = await requestHighLevel(c, '/conversations/messages', { method: 'POST', body: JSON.stringify({
      type: to.channel, contactId: to.id, message, status: 'pending',
      ...(to.channel === 'Email'
        ? { emailTo: email(job.email), subject: 'Your Easy Garage Cleaning project portal', html: `<p>Your quote is approved. You can view job details, messages, and payments in your private project portal.</p><p><a href="${url}">Open your Easy Garage Cleaning project portal</a></p>` }
        : { toNumber: phone(job.phone) }),
    }) });
    const messageId = String(data.messageId || '');
    result = response.ok && messageId
      ? { status: 'submitted', messageId, conversationId: String(data.conversationId || '') }
      : { status: response.status >= 400 && response.status < 500 && response.status !== 408 ? 'failed' : 'uncertain' };
  } catch { result = { status: 'uncertain' }; }
  const state = { ...claimed, ...result, completedAt: clock().toISOString() };
  if (await settle(state)) return state;
  return { ...state, status: 'uncertain', reason: 'delivery_status_not_saved' };
}
