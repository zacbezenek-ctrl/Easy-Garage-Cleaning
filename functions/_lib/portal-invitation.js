import { createCustomerPortalAccessToken, customerPortalConfigured } from './customer-portal.js';
import { customerPortalLinkAccount } from './customer-portal-revocation.js';
import { firebaseServiceAccountConfigured, firestoreFetch } from './firebase-service-account.js';
import { readJob, patchJob, decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { pricesPendingApproval } from './quote-model.js';
// message-policies.js imports businessAccountJob from this module. The cycle is
// safe because neither module uses the other's bindings while it loads.
import { closedJob, quietHoursDecision } from './message-policies.js';
import { MESSAGING_SETTINGS, MESSAGING_SETTINGS_ID, PORTAL_LINK_ON_AT, PORTAL_LINK_TOGGLES, normalizeMessagingSettings } from './messaging-settings.js';
import { maskRecipient } from './ghl-messenger.js';
import { moneyTotalsMode, servedMoneyTotals } from './money-core.js';
import { customerPaymentNeedsReview } from './customer-payments.js';
import { denverToday } from './dispatch-time.js';

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
     messaging_settings/automation portalLinkQuoteReady is true (off by default), and only while the quote is unexpired.
     It asks for the deposit only when one is still due.
   - 'job_done': when the crew completes the job, only while portalLinkJobDone is true (off by default); a fresh link.
     Not for a completion with an open crew follow-up, nor more than JOB_DONE_FRESH_HOURS after the completion. It names
     a remaining balance only when the portal shows one and no payment waits for the office's review.
   Turning a switch off ends the texts of that kind still waiting (status 'off'); a text requested before the switch was
   last turned on is never sent. Every customer-facing word of these messages is here. */
export const APPROVED = 'approved';
export const PORTAL_LINK_KINDS = Object.freeze(['quote_ready', 'job_done']);
const LINK_DAYS = 30;
// The accepted-quote invitation is not sent while a delivered quote-ready link still has this many days to run.
export const QUOTE_READY_COVER_MIN_DAYS_LEFT = 3;
// A quote-ready send still claimed ('sending') this long after its attempt is treated as possibly delivered.
const SENDING_SETTLED_MS = 2 * 60000;
// The job-done text goes out only this long after the completion (a long quiet-hours or pause hold ends it).
export const JOB_DONE_FRESH_HOURS = 48;
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
  // No deposit due (already paid, none required, a payment waiting for review, or the figures cannot be read).
  quote_ready_no_deposit: Object.freeze({
    sms: (first, url) => `${opening(first)} Easy Garage Cleaning quote is ready. You can review it and approve it in your private project portal: ${url}`,
    subject: 'Your Easy Garage Cleaning quote is ready',
    html: url => `<p>Your Easy Garage Cleaning quote is ready. You can review it and approve it in your private project portal.</p>${button(url)}`,
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
  return { quote_ready: { deposit: show(PORTAL_MESSAGES.quote_ready), no_deposit: show(PORTAL_MESSAGES.quote_ready_no_deposit) }, job_done: { balance: show(PORTAL_MESSAGES.job_done_balance), paid: show(PORTAL_MESSAGES.job_done_paid) } };
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

// quote_ready: a quote sent for review (estimate status 'sent'), not approved yet and not expired on the Denver date of
// `at` (the portal marks a quote past its validUntil expired and refuses its approval: customer-portal.js estimateState).
const quoteExpired = (job, at) => { const validUntil = String(job.estimate?.validUntil || ''); return Boolean(validUntil) && validUntil < denverToday(at); };
export function quoteReadyForReview(job = {}, at = new Date()) {
  return job.type === 'job' && !pricesPendingApproval(job) && !closedJob(job) &&
    String(job.estimate?.status || '').toLowerCase() === 'sent' && !['accepted', 'approved'].includes(String(job.customerApproval?.status || '').toLowerCase()) &&
    Number(job.estimate?.amountCents || 0) > 0 && !quoteExpired(job, at);
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

// The crew completed the job with a follow-up still open (field-execution.js complete with hasIssues: missing materials,
// damage, a return visit): "your job is done" is not true yet. A later completion without one sends it.
const followUpOpen = job => job.fieldExecution?.completion?.hasIssues === true || String(job.fieldExecution?.attention?.status || '').toLowerCase() === 'open';
const completedTime = job => [job.completedAt, job.fieldExecution?.completion?.completedAt].map(value => Date.parse(value || '')).find(Number.isFinite);

// Why this kind of message does not apply to the job at `at`, or null.
function ineligible(kind, job, at = new Date()) {
  if (kind === APPROVED) return null;
  if (pricesPendingApproval(job)) return { status: 'not_eligible', reason: 'prices_pending_approval' };
  if (kind === 'quote_ready') {
    if (job.type === 'job' && closedJob(job)) return { status: 'not_eligible', reason: 'job_closed' };
    if (['accepted', 'approved'].includes(String(job.estimate?.status || '').toLowerCase())) return { status: 'not_eligible', reason: 'quote_already_approved' };
    if (String(job.estimate?.status || '').toLowerCase() === 'sent' && quoteExpired(job, at)) return { status: 'not_eligible', reason: 'quote_expired' };
    return quoteReadyForReview(job, at) ? null : { status: 'not_eligible', reason: 'quote_not_sent' };
  }
  if ([job.status, job.pipelineStatus].some(value => STOPPED.has(String(value || '').toLowerCase()))) return { status: 'not_eligible', reason: 'job_closed' };
  if (!jobDone(job)) return { status: 'not_eligible', reason: 'job_not_done' };
  if (followUpOpen(job)) return { status: 'not_eligible', reason: 'follow_up_open' };
  const done = completedTime(job);
  if (!Number.isFinite(done) || at.getTime() - done > JOB_DONE_FRESH_HOURS * 3600000) return { status: 'not_eligible', reason: 'job_done_too_long_ago' };
  return null;
}
const eligibleNow = (kind, job, at) => kind === APPROVED ? quoteApproved(job) : !ineligible(kind, job, at);

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

// A quote-ready link the customer was (or may have been) sent and that still works for QUOTE_READY_COVER_MIN_DAYS_LEFT
// more days: the accepted-quote invitation is not sent again (the portal itself shows the approval). An unconfirmed
// send ('uncertain', or 'sending' for longer than SENDING_SETTLED_MS) counts as sent, because an ambiguous send is never
// followed by a second text automatically; one still in flight answers {wait: true}. Unread ledger: throws.
async function quoteReadyCover(env, jobId, at) {
  const { state } = await readState(env, jobId, 'quote_ready');
  if (!['submitted', 'uncertain', 'sending'].includes(state.status)) return null;
  const attempted = Date.parse(state.attemptedAt || '');
  if (state.status === 'sending' && (!Number.isFinite(attempted) || at.getTime() - attempted < SENDING_SETTLED_MS)) return { wait: true };
  const sentAt = state.completedAt || state.attemptedAt || '', time = Date.parse(sentAt);
  if (!Number.isFinite(time) || time + (LINK_DAYS - QUOTE_READY_COVER_MIN_DAYS_LEFT) * 86400000 <= at.getTime()) return null;
  return { kind: 'quote_ready', sentAt, channel: state.channel || '', ...(state.status === 'submitted' ? {} : { unconfirmed: true }) };
}

// What the customer reads for this kind of message, from the money the portal shows (MONEY_UNIFIED_TOTALS:
// money-core servedMoneyTotals in moneyTotalsMode(env)). A payment waiting for the office's review (a crew cash or check
// receipt: customer-payments.js customerPaymentNeedsReview) is not in those figures yet, so its customer is never told
// that a deposit or a balance is due. Unreadable figures: the wording that names no money.
function messageFor(kind, job, env) {
  if (kind === APPROVED) return { variant: kind, ...PORTAL_MESSAGES[kind] };
  const review = customerPaymentNeedsReview(job), totals = review ? null : servedMoneyTotals(job, moneyTotalsMode(env), { surface: 'portal_link' });
  const due = value => Number.isSafeInteger(value) && value > 0;
  if (kind === 'quote_ready') return due(totals?.depositDueCents) ? { variant: 'deposit_due', ...PORTAL_MESSAGES.quote_ready } : { variant: review ? 'payment_in_review' : 'no_deposit_due', ...PORTAL_MESSAGES.quote_ready_no_deposit };
  return due(totals?.balanceCents) ? { variant: 'balance_due', ...PORTAL_MESSAGES.job_done_balance } : { variant: review ? 'payment_in_review' : 'paid', ...PORTAL_MESSAGES.job_done_paid };
}

// PORTAL-LINKS: a portal link text whose switch is off, or one requested before the switch was last turned on, is
// closed on its ledger ('off', reason owner_switch_off) so automatic retries stop and the Hub says why. A link that was
// never requested records nothing. A final state (sent, unconfirmed, not eligible, suppressed) is left as it is.
const FINAL = new Set([...terminal, 'not_eligible', 'off', 'suppressed', 'contact_mismatch']);
async function closeSwitchedOff(env, jobId, kind, clock, prior = null) {
  const off = { kind, status: 'off', reason: 'owner_switch_off' };
  let ledger = prior;
  if (!ledger) { try { ledger = await readState(env, jobId, kind); } catch { return off; } }
  if (!ledger.state.status || FINAL.has(ledger.state.status)) return off;
  const state = { ...ledger.state, ...off, checkedAt: clock().toISOString() };
  try { await writeState(env, jobId, state, ledger.updateTime, kind); await mirrorState(env, jobId, state, kind); return state; }
  catch { return { kind, status: 'busy', jobId }; }
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
 * the accepted-quote invitation. Off unless the owner's switch for the kind is on: {status:'off', reason:
 * 'owner_switch_off'}, recorded only to end an earlier wait (closeSwitchedOff); a wait requested before the switch was
 * last turned on (messaging_settings portalLink…OnAt) ends the same way. A kind that does not apply to the job (yet)
 * answers {status:'not_eligible', reason} and is recorded only to end an earlier wait. */
export function sendPortalLink(env, jobId, kind, options = {}) {
  if (!PORTAL_LINK_KINDS.includes(kind)) return Promise.resolve({ status: 'needs_kind' });
  return deliver(env, jobId, kind, options);
}

async function deliver(env, jobId, kind, { requireRequested = false, automatic = false, settings = null, now: clock = () => new Date() } = {}) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(jobId || ''))) return { status: 'needs_job' };
  if (!firebaseServiceAccountConfigured(env)) return { status: 'not_configured', reason: 'secure_storage' };
  const link = kind !== APPROVED, tag = link ? { kind } : {};
  // A portal link text is the owner's choice: off (the default) sends nothing, and ends a wait recorded while it was on.
  let current = settings;
  if (link) {
    if (!current) {
      try { current = await readMessagingSettingsRecord(env); }
      catch (error) { return error?.code === 'messaging_settings_invalid' ? { kind, status: 'off', reason: 'messaging_settings_invalid' } : { kind, status: 'storage_unavailable' }; }
    }
    if (current[PORTAL_LINK_TOGGLES[kind]] !== true) return closeSwitchedOff(env, jobId, kind, clock);
  }
  let job;
  try { job = await readJob(env, jobId); } catch { return { ...tag, status: 'storage_unavailable' }; }
  if (!job) return { ...tag, status: 'needs_job' };
  if (link) {
    const gate = ineligible(kind, job, clock());
    if (gate) {
      // An earlier wait that no longer applies (the quote was approved, the job cancelled) is ended, so retries stop.
      // A finished job held back for its open crew follow-up is recorded too, so the office sees why no text went.
      let prior;
      try { prior = await readState(env, jobId, kind); } catch { return { kind, ...gate }; }
      const record = !prior.state.status && gate.reason === 'follow_up_open';
      if (!record && (!prior.state.status || terminal.has(prior.state.status) || prior.state.status === 'not_eligible')) return { kind, ...gate };
      const checkedAt = clock().toISOString();
      const state = { ...(record ? { jobId, requestedAt: checkedAt, attempts: 0 } : prior.state), kind, status: gate.status, reason: gate.reason, checkedAt };
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
  // Waiting since before the owner last turned the switch on (it was off in between): never sent.
  if (link && previous.status && !FINAL.has(previous.status) && Date.parse(previous.requestedAt || '') < Date.parse(current[PORTAL_LINK_ON_AT[kind]] || '')) return closeSwitchedOff(env, jobId, kind, clock, ledger);
  const now = clock().toISOString();
  // A portal link text that ended unsent (not eligible, switched off, suppressed) starts a new request when asked again.
  const restart = link && FINAL.has(previous.status), requestedAt = restart ? now : previous.requestedAt || now, attempts = restart ? 0 : Number(previous.attempts || 0);
  const base = { ...tag, jobId, requestedAt, attemptedAt: now, attempts: attempts + 1 };
  const waiting = { ...tag, jobId, requestedAt, attempts, ...(previous.attemptedAt ? { attemptedAt: previous.attemptedAt } : {}) };
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
    // A quote-ready text still in flight: decide once it settles (the next automatic retry), nothing recorded.
    if (cover?.wait) return { status: 'busy', reason: 'quote_ready_in_flight', jobId };
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
  if (!latestJob || !eligibleNow(kind, latestJob, clock()) || latestJob.notify === false || phone(latestJob.phone) !== phone(job.phone) || email(latestJob.email) !== email(job.email) || latestJob.highlevelContactId !== job.highlevelContactId) return { ...tag, status: 'busy', jobId };
  // The link carries the account's current version and root, so a later staff
  // revocation (or re-parenting) also ends this invitation. An unverifiable
  // account never sends.
  let account, linkVersion;
  try { ({ account, linkVersion } = await customerPortalLinkAccount(id => readJob(env, id), latestJob)); } catch { return { ...tag, status: 'storage_unavailable' }; }
  const token = await createCustomerPortalAccessToken(env, jobId, clock().getTime(), linkVersion, account.id);
  const url = `${PORTAL}?access=${encodeURIComponent(token)}`;
  const firstName = String(job.customer || '').trim().split(/\s+/)[0].replace(/[<>]/g, '').slice(0, 50);
  const text = messageFor(kind, latestJob, env), message = text.sms(firstName, url);
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
  // PORTAL-LINKS: so does a portal link text that stopped applying meanwhile (the quote was approved or expired), and
  // a quote-ready text that started meanwhile for the accepted-quote invitation (covered, or retried once it settles).
  let halt;
  try {
    const latest = await readJob(env, jobId);
    halt = !latest ? { status: 'needs_job' } : pricesPendingApproval(latest) ? { status: link ? 'not_eligible' : 'not_approved', reason: 'prices_pending_approval' } : businessAccountJob(latest) ? { status: 'suppressed', reason: 'business_account_job' }
      : latest.notify === false ? { status: 'suppressed', reason: 'job_notifications_off' } : link ? ineligible(kind, latest, clock()) : null;
    if (!halt && !link) {
      const cover = await quoteReadyCover(env, jobId, clock());
      if (cover?.wait) { const state = { ...waiting, status: 'deferred', reason: 'quote_ready_in_flight', deferredAt: clock().toISOString() }; return await settle(state) ? state : claimed; }
      if (cover) { const state = { ...waiting, status: 'covered', reason: 'quote_ready_link_delivered', coveredBy: cover, checkedAt: clock().toISOString() }; return await settle(state) ? state : claimed; }
    }
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
