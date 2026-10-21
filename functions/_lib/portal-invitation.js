import { createCustomerPortalAccessToken, customerPortalConfigured } from './customer-portal.js';
import { customerPortalLinkAccount } from './customer-portal-revocation.js';
import { firebaseServiceAccountConfigured, firestoreFetch } from './firebase-service-account.js';
import { readJob, patchJob, decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { pricesPendingApproval } from './quote-model.js';
// message-policies.js imports businessAccountJob from this module. The cycle is
// safe because neither module uses the other's bindings while it loads.
import { closedJob, quietHoursDecision } from './message-policies.js';
import { MESSAGING_SETTINGS, MESSAGING_SETTINGS_ID, PORTAL_LINK_TOGGLES, normalizeMessagingSettings } from './messaging-settings.js';
import { maskRecipient } from './ghl-messenger.js';
import { customerMoneyTotals } from './money-core.js';

const API = 'https://services.leadconnectorhq.com';
const PORTAL = 'https://easygaragecleaning.com/api/customer-portal-session';
const terminal = new Set(['submitted', 'sending', 'uncertain']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const phone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits.length >= 11 && digits.length <= 15 ? `+${digits}` : '';
};
const email = value => String(value || '').trim().toLowerCase();

/* PORTAL-LINKS: three kinds of portal link message share this one delivery path (HighLevel SMS, else email; one per
   job per kind; DND, notifications-off, business-account, closed-job and held-price skips; Denver quiet hours and the
   owner's messaging pause for automatic sends).
   - 'approved': the accepted-quote invitation, sent as before.
   - 'quote_ready': when an estimator sends a quote for review, only while the owner's switch
     messaging_settings/automation portalLinkQuoteReady is true (off by default).
   - 'job_done': when the crew completes the job, only while portalLinkJobDone is true (off by default); a fresh link.
   Every customer-facing word of these messages is here. */
export const APPROVED = 'approved';
export const PORTAL_LINK_KINDS = Object.freeze(['quote_ready', 'job_done']);
const LINK_DAYS = 30;
// The accepted-quote invitation is not sent while a delivered quote-ready link still has this many days to run.
export const QUOTE_READY_COVER_MIN_DAYS_LEFT = 3;
const opening = first => first ? `Hi ${first}, your` : 'Your';
const button = url => `<p><a href="${url}">Open your Easy Garage Cleaning project portal</a></p>`;
export const PORTAL_MESSAGES = Object.freeze({
  approved: Object.freeze({
    sms: (first, url) => `${opening(first)} quote is approved. Here is your private Easy Garage Cleaning project portal for job details, messages, and payments: ${url}`,
    subject: 'Your Easy Garage Cleaning project portal',
    html: url => `<p>Your quote is approved. You can view job details, messages, and payments in your private project portal.</p>${button(url)}`,
  }),
  quote_ready: Object.freeze({
    sms: (first, url) => `${opening(first)} Easy Garage Cleaning quote is ready. You can review it, approve it and pay the deposit in your private project portal: ${url}`,
    subject: 'Your Easy Garage Cleaning quote is ready',
    html: url => `<p>Your Easy Garage Cleaning quote is ready. You can review it, approve it and pay the deposit in your private project portal.</p>${button(url)}`,
  }),
  job_done_balance: Object.freeze({
    sms: (first, url) => `${opening(first)} Easy Garage Cleaning job is done — thank you! Your remaining balance, receipts and photos are in your private project portal: ${url}`,
    subject: 'Your Easy Garage Cleaning job is done',
    html: url => `<p>Your Easy Garage Cleaning job is done — thank you! Your remaining balance, receipts and photos are in your private project portal.</p>${button(url)}`,
  }),
  job_done_paid: Object.freeze({
    sms: (first, url) => `${opening(first)} Easy Garage Cleaning job is done — thank you! Your receipts and job details are in your private project portal: ${url}`,
    subject: 'Your Easy Garage Cleaning job is done',
    html: url => `<p>Your Easy Garage Cleaning job is done — thank you! Your receipts and job details are in your private project portal.</p>${button(url)}`,
  }),
});
/** The texts as the Hub shows them next to the owner's switches: {first} and {portal link} stand for the customer's
 * first name and the private link. */
export function portalLinkPreviews() {
  const show = message => message.sms('{first}', '{portal link}');
  return { quote_ready: show(PORTAL_MESSAGES.quote_ready), job_done: { balance: show(PORTAL_MESSAGES.job_done_balance), paid: show(PORTAL_MESSAGES.job_done_paid) } };
}

// The accepted-quote invitation keeps its ledger in portal_invitations/{jobId}. The owner-switched portal link texts
// (PORTAL_LINK_KINDS) each keep their own, once per job per kind, in portal_link_sends/{kind}~{jobId} (server-only).
const DOCUMENTS = 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const ledgerUrl = (jobId, kind) => kind === APPROVED ? `${DOCUMENTS}/portal_invitations/${encodeURIComponent(jobId)}` : `${DOCUMENTS}/portal_link_sends/${encodeURIComponent(`${kind}~${jobId}`)}`;
const settingsUrl = `${DOCUMENTS}/${MESSAGING_SETTINGS}/${MESSAGING_SETTINGS_ID}`;

async function readState(env, jobId, kind = APPROVED) {
  const response = await firestoreFetch(env, ledgerUrl(jobId, kind));
  if (response.status === 404) return { state: {}, updateTime: '' };
  if (!response.ok) throw new Error('Invitation storage unavailable');
  const document = await response.json();
  if (!document.updateTime) throw new Error('Invitation version unavailable');
  return { state: decodeFirestoreFields(document.fields), updateTime: document.updateTime };
}

async function writeState(env, jobId, state, updateTime, kind = APPROVED) {
  const url = new URL(ledgerUrl(jobId, kind));
  url.searchParams.set(updateTime ? 'currentDocument.updateTime' : 'currentDocument.exists', updateTime || 'false');
  const response = await firestoreFetch(env, url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFirestoreFields(state) }) });
  if (!response.ok) throw new Error('Invitation storage changed');
}

// The job's display copy: customerPortalInvitation for the accepted-quote invitation, portalLinks.<kind> for the
// others (kind, status, channel, masked recipient and times; never the link).
async function mirrorState(env, jobId, state, kind = APPROVED) {
  // Display-only copy. Job edits can never change the authoritative ledger.
  try {
    const job = await readJob(env, jobId);
    if (job?.__updateTime) await patchJob(env, jobId, kind === APPROVED ? { customerPortalInvitation: state } : { portalLinks: { ...(plain(job.portalLinks) ? job.portalLinks : {}), [kind]: state } }, job.__updateTime);
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

// A signed job held for the owner's price approval (pricesPendingApproval) is not an approved quote to share yet,
// and a closed job (cancelled, no-show, completed, invoiced, paid, closed or superseded: message-policies.js
// closedJob) is never told its quote is approved.
export function quoteApproved(job = {}) {
  return job.type === 'job' && !pricesPendingApproval(job) && !closedJob(job) &&
    ['accepted', 'approved'].includes(String(job.estimate?.status || '').toLowerCase()) &&
    Number(job.estimate?.amount || job.total || job.priceQuoted || 0) > 0;
}

// quote_ready: a quote sent for review (estimate status 'sent') and not approved yet.
export function quoteReadyForReview(job = {}) {
  return job.type === 'job' && !pricesPendingApproval(job) && !closedJob(job) &&
    String(job.estimate?.status || '').toLowerCase() === 'sent' && !['accepted', 'approved'].includes(String(job.customerApproval?.status || '').toLowerCase()) &&
    Number(job.estimate?.amountCents || 0) > 0;
}

// job_done: the crew completed the job (field completion, or a later money stage). Cancelled, no-show and superseded
// jobs never get it.
const STOPPED = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'no-show', 'superseded']);
const DONE = new Set(['completed', 'invoiced', 'paid', 'review_requested', 'closed']);
export function jobDone(job = {}) {
  const stages = [job.status, job.pipelineStatus].map(value => String(value || '').toLowerCase());
  return ['job', 'cleanout', 'reorg'].includes(job.type) && !job.recordType && !stages.some(stage => STOPPED.has(stage)) &&
    (stages.some(stage => DONE.has(stage)) || Number.isFinite(Date.parse(job.completedAt || '')));
}

// Why this kind of message does not apply to the job right now, or null.
function ineligible(kind, job) {
  if (kind === APPROVED) return null;
  if (pricesPendingApproval(job)) return { status: 'not_eligible', reason: 'prices_pending_approval' };
  if (kind === 'quote_ready') {
    if (job.type === 'job' && closedJob(job)) return { status: 'not_eligible', reason: 'job_closed' };
    return quoteReadyForReview(job) ? null : { status: 'not_eligible', reason: ['accepted', 'approved'].includes(String(job.estimate?.status || '').toLowerCase()) ? 'quote_already_approved' : 'quote_not_sent' };
  }
  if ([job.status, job.pipelineStatus].some(value => STOPPED.has(String(value || '').toLowerCase()))) return { status: 'not_eligible', reason: 'job_closed' };
  return jobDone(job) ? null : { status: 'not_eligible', reason: 'job_not_done' };
}
const eligibleNow = (kind, job) => kind === APPROVED ? quoteApproved(job) : !ineligible(kind, job);

// The owner's messaging_settings record, read the way the scheduler reads it. An
// invalid record throws messaging_settings_invalid (fail closed).
async function readMessagingSettingsRecord(env) {
  const response = await firestoreFetch(env, settingsUrl);
  if (response.status === 404) return normalizeMessagingSettings(null);
  if (!response.ok) throw new Error('Messaging settings unavailable');
  const document = await response.json();
  return normalizeMessagingSettings(document?.fields ? decodeFirestoreFields(document.fields) : {});
}

// Automatic sends (the HighLevel approval and handoff sync, the Hub's page-load
// retry and the scheduler) follow the same rules as every other automatic
// customer message: Denver quiet hours (message-policies.js QUIET_HOURS, 08:00-20:00)
// and the owner's messaging pause. A held invitation waits; it is not dropped.
async function automaticHold(env, at, settings) {
  const quiet = quietHoursDecision(at);
  if (!quiet.allowed) return { reason: 'quiet_hours', notBefore: quiet.notBefore };
  let current = settings;
  if (!current) {
    try { current = await readMessagingSettingsRecord(env); }
    catch (error) { if (error?.code === 'messaging_settings_invalid') return { reason: 'messaging_settings_invalid' }; throw error; }
  }
  return current.paused === true ? { reason: 'messaging_paused' } : null;
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

// A quote-ready link the customer was sent and that still works for QUOTE_READY_COVER_MIN_DAYS_LEFT more days: the
// accepted-quote invitation is not sent again (the portal itself shows the approval). Unread ledger: throws.
async function quoteReadyCover(env, jobId, at) {
  const { state } = await readState(env, jobId, 'quote_ready');
  const sentAt = Date.parse(state.completedAt || '');
  if (state.status !== 'submitted' || !Number.isFinite(sentAt)) return null;
  return sentAt + (LINK_DAYS - QUOTE_READY_COVER_MIN_DAYS_LEFT) * 86400000 > at.getTime() ? { kind: 'quote_ready', sentAt: state.completedAt, channel: state.channel || '' } : null;
}

// What the customer reads for this kind of message. job_done names the remaining balance only when one is due.
function messageFor(kind, job) {
  if (kind !== 'job_done') return { variant: kind, ...PORTAL_MESSAGES[kind] };
  const balance = customerMoneyTotals(job).balanceCents;
  return Number.isSafeInteger(balance) && balance > 0 ? { variant: 'balance_due', ...PORTAL_MESSAGES.job_done_balance } : { variant: 'paid', ...PORTAL_MESSAGES.job_done_paid };
}

// One invitation per job, not per browser timestamp or save. A compare-and-set
// claim prevents concurrent sends. Ambiguous provider responses never auto-retry.
// Store delivery metadata only: staff-readable job records must not hold tokens.
// automatic: every caller except a manager's own Retry click passes true. Outside
// 08:00-20:00 Denver time, or while the owner has paused automatic messages, it
// records 'deferred' (reason quiet_hours with notBefore, messaging_paused or
// messaging_settings_invalid) without spending an attempt, and the next Hub retry
// or scheduler run sends it. settings: the scheduler's already-read messaging settings.
// PORTAL-LINKS: while a quote-ready link the customer was sent still works, the invitation records 'covered' (reason
// quote_ready_link_delivered) instead of sending; an automatic caller leaves a covered invitation as it is.
export function sendAcceptedQuotePortal(env, jobId, options = {}) {
  return deliver(env, jobId, APPROVED, options);
}

/** PORTAL-LINKS: the owner-switched portal link texts ('quote_ready', 'job_done'), through the same delivery path as
 * the accepted-quote invitation. Off (nothing read beyond the switch, nothing recorded) unless the owner's switch for
 * the kind is on: {status:'off', reason:'owner_switch_off'}. A kind that does not apply to the job (yet) answers
 * {status:'not_eligible', reason} and is recorded only to end an earlier wait. */
export function sendPortalLink(env, jobId, kind, options = {}) {
  if (!PORTAL_LINK_KINDS.includes(kind)) return Promise.resolve({ status: 'needs_kind' });
  return deliver(env, jobId, kind, options);
}

async function deliver(env, jobId, kind, { requireRequested = false, automatic = false, settings = null, now: clock = () => new Date() } = {}) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(jobId || ''))) return { status: 'needs_job' };
  if (!firebaseServiceAccountConfigured(env)) return { status: 'not_configured', reason: 'secure_storage' };
  const link = kind !== APPROVED, tag = link ? { kind } : {};
  // A portal link text is the owner's choice: off (the default) sends nothing and records nothing.
  let current = settings;
  if (link) {
    if (!current) {
      try { current = await readMessagingSettingsRecord(env); }
      catch (error) { return error?.code === 'messaging_settings_invalid' ? { kind, status: 'off', reason: 'messaging_settings_invalid' } : { kind, status: 'storage_unavailable' }; }
    }
    if (current[PORTAL_LINK_TOGGLES[kind]] !== true) return { kind, status: 'off', reason: 'owner_switch_off' };
  }
  let job;
  try { job = await readJob(env, jobId); } catch { return { ...tag, status: 'storage_unavailable' }; }
  if (!job) return { ...tag, status: 'needs_job' };
  if (link) {
    const gate = ineligible(kind, job);
    if (gate) {
      // An earlier wait that no longer applies (the quote was approved, the job cancelled) is ended, so retries stop.
      let prior;
      try { prior = await readState(env, jobId, kind); } catch { return { kind, ...gate }; }
      if (!prior.state.status || terminal.has(prior.state.status) || prior.state.status === 'not_eligible') return { kind, ...gate };
      const state = { ...prior.state, kind, status: gate.status, reason: gate.reason, checkedAt: clock().toISOString() };
      try { await writeState(env, jobId, state, prior.updateTime, kind); await mirrorState(env, jobId, state, kind); return state; }
      catch { return { kind, status: 'busy', jobId }; }
    }
  } else {
    // EGC_QUOTE_BUILDER_ENABLED: every sender (the handoff's request, the Hub's retry, the cron) waits for the owner's
    // price approval; nothing is recorded, so the release's own request sends it later.
    if (pricesPendingApproval(job)) return { status: 'not_approved', reason: 'prices_pending_approval' };
    if (job.type === 'job' && closedJob(job)) return { status: 'not_approved', reason: 'job_closed' };
    if (!quoteApproved(job)) return { status: 'not_approved' };
    if (requireRequested && !job.customerPortalInvitationRequestedAt) return { status: 'not_requested' };
  }
  let ledger;
  try { ledger = await readState(env, jobId, kind); } catch { return { ...tag, status: 'storage_unavailable' }; }
  const previous = ledger.state;
  if (terminal.has(previous.status)) { await mirrorState(env, jobId, previous, kind); return previous; }
  if (!link && previous.status === 'covered' && automatic) return previous;
  const now = clock().toISOString();
  const base = { ...tag, jobId, requestedAt: previous.requestedAt || now, attemptedAt: now, attempts: Number(previous.attempts || 0) + 1 };
  const waiting = { ...tag, jobId, requestedAt: base.requestedAt, attempts: Number(previous.attempts || 0), ...(previous.attemptedAt ? { attemptedAt: previous.attemptedAt } : {}) };
  const save = async (value, from = base) => {
    const state = { ...from, ...value };
    try {
      await writeState(env, jobId, state, ledger.updateTime, kind);
      await mirrorState(env, jobId, state, kind);
      return state;
    } catch { return { ...tag, status: 'busy', jobId }; }
  };
  if (!job.__updateTime) return { ...tag, status: 'storage_unavailable' };
  if (!link) {
    let cover;
    try { cover = await quoteReadyCover(env, jobId, clock()); } catch { return { status: 'storage_unavailable' }; }
    if (cover) return save({ status: 'covered', reason: 'quote_ready_link_delivered', coveredBy: cover, checkedAt: now }, waiting);
  }
  if (businessAccountJob(job)) return save({ status: 'suppressed', reason: 'business_account_job' });
  if (job.notify === false) return save({ status: 'suppressed', reason: 'job_notifications_off' });
  const c = config(env);
  if (!customerPortalConfigured(env) || !c.token || !c.locationId) return save({ status: 'not_configured', reason: 'portal_or_highlevel' });
  if (!phone(job.phone) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email(job.email))) return save({ status: 'needs_contact', reason: 'no_phone_or_email' });
  if (automatic) {
    let hold;
    try { hold = await automaticHold(env, clock(), current); } catch { return { ...tag, status: 'storage_unavailable' }; }
    if (hold) {
      // Unchanged since the last check: nothing to write.
      if (previous.status === 'deferred' && previous.reason === hold.reason && (previous.notBefore || '') === (hold.notBefore || '')) return previous;
      return save({ status: 'deferred', ...hold, deferredAt: now }, waiting);
    }
  }
  let to;
  try { to = await recipient(c, job); } catch { return save({ status: 'needs_contact' }); }
  if (!to.id) return save(to);
  // Do not send if an ordinary job edit changed the approval, contact, or
  // notification preference while HighLevel was being checked.
  let latestJob;
  try { latestJob = await readJob(env, jobId); } catch { return { ...tag, status: 'storage_unavailable' }; }
  if (latestJob && businessAccountJob(latestJob)) return save({ status: 'suppressed', reason: 'business_account_job' });
  if (!latestJob || !eligibleNow(kind, latestJob) || latestJob.notify === false || phone(latestJob.phone) !== phone(job.phone) || email(latestJob.email) !== email(job.email) || latestJob.highlevelContactId !== job.highlevelContactId) return { ...tag, status: 'busy', jobId };
  // The link carries the account's current version and root, so a later staff
  // revocation (or re-parenting) also ends this invitation. An unverifiable
  // account never sends.
  let account, linkVersion;
  try { ({ account, linkVersion } = await customerPortalLinkAccount(id => readJob(env, id), latestJob)); } catch { return { ...tag, status: 'storage_unavailable' }; }
  const token = await createCustomerPortalAccessToken(env, jobId, clock().getTime(), linkVersion, account.id);
  const url = `${PORTAL}?access=${encodeURIComponent(token)}`;
  const firstName = String(job.customer || '').trim().split(/\s+/)[0].replace(/[<>]/g, '').slice(0, 50);
  const text = messageFor(kind, latestJob), message = text.sms(firstName, url);
  const attemptId = crypto.randomUUID();
  const masked = maskRecipient(to.channel, to.channel === 'SMS' ? phone(job.phone) : email(job.email));
  // Every kind records where it went (masked) on the job's display copy; never the full number, email or link.
  const claimed = await save({ status: 'sending', channel: to.channel, attemptId, recipient: masked, ...(link ? { variant: text.variant } : {}) });
  if (claimed.status !== 'sending') return claimed;
  // Only this claim may settle the ledger. Re-read it each time because the
  // scheduling sync may have updated other job fields meanwhile.
  const settle = async state => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const latest = await readState(env, jobId, kind);
        if (latest.state.attemptId !== attemptId) break;
        await writeState(env, jobId, state, latest.updateTime, kind);
        await mirrorState(env, jobId, state, kind);
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
    halt = !latest ? { status: 'needs_job' } : pricesPendingApproval(latest) ? { status: link ? 'not_eligible' : 'not_approved', reason: 'prices_pending_approval' } : businessAccountJob(latest) ? { status: 'suppressed', reason: 'business_account_job' }
      : latest.notify === false ? { status: 'suppressed', reason: 'job_notifications_off' } : null;
  } catch { halt = { status: 'storage_unavailable' }; }
  if (halt) { const state = { ...base, ...halt }; return await settle(state) ? state : claimed; }
  let result;
  try {
    const { response, data } = await requestHighLevel(c, '/conversations/messages', { method: 'POST', body: JSON.stringify({
      type: to.channel, contactId: to.id, message, status: 'pending',
      ...(to.channel === 'Email'
        ? { emailTo: email(job.email), subject: text.subject, html: text.html(url) }
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
