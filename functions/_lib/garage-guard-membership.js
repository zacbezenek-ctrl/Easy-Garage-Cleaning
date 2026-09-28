import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { resolveDispatchLineage } from './dispatch-lineage.js';
import { matchCustomerIdentity } from './customer-resolution.js';
import { denverToday } from './dispatch-time.js';

/**
 * Garage Guard memberships from verified Stripe events.
 *
 * memberships/{subscriptionId} is the server-only Hub record. stripe_events/{eventId}
 * is written in the same commit, so a replayed or concurrent delivery is a no-op.
 * A member is linked to a Hub customer only by one exact, consistent phone/email
 * match with one verified account root; everything else opens
 * membership_reviews/{subscriptionId} and nothing is mirrored. The account job
 * receives only the display fields the portal and Hub already read (garageGuard).
 */

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
// resolveDispatchLineage verifies at most 150 prior visits; one more row proves there are too many.
const JOB_LIMIT = 151;
const RETRYABLE = new Set(['dispatch_revision_conflict', 'dispatch_outcome_unknown']);
// A 'sending' alert this old is not in flight any more (the send itself times out after 15 s).
export const ALERT_STALE_MS = 10 * 60 * 1000;
// Visits included per membership year; matches the garage-guard-checkout.js plans.
export const GARAGE_GUARD_PLANS = Object.freeze({ lite: 2, guard: 4, black: 12 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const planKey = value => typeof value === 'string' && Object.hasOwn(GARAGE_GUARD_PLANS, value) ? value : '';
const instant = seconds => Number.isInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : '';
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code: 'garage_guard_' + code, status });
function stripeId(value, prefix) {
  const id = plain(value) ? value.id : value;
  return typeof id === 'string' && id.startsWith(prefix + '_') && /^[a-z]+_[A-Za-z0-9_]{1,200}$/.test(id) ? id : '';
}

export function garageGuardMembershipSyncEnabled(env = {}) {
  return /^(?:true|1)$/i.test(String(env.GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED || '').trim());
}

// Pre-2025 API versions put the subscription on the invoice; newer ones under
// parent.subscription_details. Subscription line items carry its metadata too.
function invoiceSubscription(invoice) {
  const parent = plain(invoice.parent?.subscription_details) ? invoice.parent.subscription_details : {};
  const lines = (Array.isArray(invoice.lines?.data) ? invoice.lines.data : []).filter(line => plain(line) && (line.type === 'subscription' || line.parent?.type === 'subscription_item_details' || line.subscription));
  const ends = lines.map(line => line.period?.end).filter(Number.isInteger);
  return {
    id: stripeId(invoice.subscription, 'sub') || stripeId(parent.subscription, 'sub'),
    plan: planKey(invoice.subscription_details?.metadata?.plan) || planKey(parent.metadata?.plan) || lines.map(line => planKey(line.metadata?.plan)).find(Boolean) || '',
    periodEnd: ends.length ? instant(Math.max(...ends)) : '',
  };
}

const noIdentity = { customerEmail: '', phone: '', customerName: '', serviceAddress: '' };

/** Garage Guard facts from a signature-verified Stripe event, or null when the
 * event is not a Garage Guard membership event. */
export function garageGuardEvent(event) {
  const object = plain(event?.data?.object) ? event.data.object : null, eventId = stripeId(event?.id, 'evt');
  if (!object || !eventId) return null;
  const base = { eventId, type: event.type, created: Number.isInteger(event.created) ? event.created : 0, livemode: event.livemode === true, stripeCustomerId: stripeId(object.customer, 'cus') };
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const plan = planKey(object.metadata?.plan), subscriptionId = stripeId(object.subscription, 'sub');
    if (object.mode !== 'subscription' || !plan || !subscriptionId) return null;
    const details = plain(object.customer_details) ? object.customer_details : {};
    const address = (Array.isArray(object.custom_fields) ? object.custom_fields : []).find(field => field?.key === 'service_address');
    return { ...base, action: 'checkout', subscriptionId, plan, paid: ['paid', 'no_payment_required'].includes(object.payment_status),
      identity: { customerEmail: text(details.email || object.customer_email, 254).toLowerCase(), phone: text(details.phone, 40), customerName: text(details.name, 200), serviceAddress: text(address?.text?.value, 1000) } };
  }
  if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
    // Only invoices whose subscription carries a Garage Guard plan are memberships.
    const subscription = invoiceSubscription(object);
    if (!subscription.id || !subscription.plan) return null;
    return { ...base, action: event.type === 'invoice.paid' ? 'paid' : 'payment_failed', subscriptionId: subscription.id, plan: subscription.plan, periodEnd: subscription.periodEnd, billingReason: text(object.billing_reason, 60),
      identity: { ...noIdentity, customerEmail: text(object.customer_email, 254).toLowerCase(), phone: text(object.customer_phone, 40), customerName: text(object.customer_name, 200) } };
  }
  if (event.type === 'customer.subscription.deleted') {
    const subscriptionId = stripeId(object.id, 'sub');
    // A deletion without plan metadata counts only for a membership already on file.
    return subscriptionId ? { ...base, action: 'cancelled', subscriptionId, plan: planKey(object.metadata?.plan), cancelledAt: instant(object.ended_at) || instant(object.canceled_at), identity: noIdentity } : null;
  }
  return null;
}

function nextMembership(current, input, now) {
  const { id: _id, revision: _revision, ...saved } = current || {};
  const plan = input.plan || saved.plan, visitsIncluded = GARAGE_GUARD_PLANS[plan];
  const membership = current ? { ...saved } : { subscriptionId: input.subscriptionId, status: '', customerEmail: '', phone: '', customerName: '', serviceAddress: '', stripeCustomerId: '', currentPeriodEnd: '', visitsRemaining: null, livemode: input.livemode, link: { status: 'unlinked' }, statusEventCreated: 0, createdAt: now };
  // The checkout collects the garage address, so its contact details win; other events only fill gaps.
  for (const [key, value] of Object.entries(input.identity)) if (value && (input.action === 'checkout' || !membership[key])) membership[key] = value;
  if (input.stripeCustomerId && !membership.stripeCustomerId) membership.stripeCustomerId = input.stripeCustomerId;
  Object.assign(membership, { plan, visitsIncluded });
  const previousStatus = membership.status, status = { checkout: input.paid ? 'active' : 'pending', paid: 'active', payment_failed: 'past_due', cancelled: 'cancelled' }[input.action];
  // Cancellation is terminal. Otherwise an older event delivered late cannot
  // overwrite a newer status, and an unpaid checkout never demotes a member.
  if (previousStatus !== 'cancelled' && (status === 'cancelled' || input.created >= Number(membership.statusEventCreated || 0)) && !(status === 'pending' && previousStatus)) {
    membership.status = status;
    membership.statusEventCreated = Math.max(input.created, Number(membership.statusEventCreated || 0));
  }
  if (membership.status === 'cancelled' && !membership.cancelledAt) membership.cancelledAt = input.cancelledAt || now;
  let reset = false;
  if (!current && input.action === 'checkout') membership.visitsRemaining = visitsIncluded;
  // A paid invoice that starts a new billing period restores the included visits.
  if (input.action === 'paid' && input.periodEnd && (!membership.currentPeriodEnd || input.periodEnd > membership.currentPeriodEnd)) {
    membership.currentPeriodEnd = input.periodEnd;
    if (['subscription_create', 'subscription_cycle'].includes(input.billingReason)) { membership.visitsRemaining = visitsIncluded; reset = true; }
  }
  return { membership, reset, previousStatus };
}

const review = (reason, candidates = [], fences = []) => ({ link: { status: 'needs_review', reason }, review: { reason, candidates }, fences });

// Every decision drawn from the customer snapshot and the account lineage is
// fenced in the membership commit, as resolveCustomer and dispatch do: the
// identity revision is read BEFORE the snapshot, and each observed job revision
// is verified. A customer created or re-identified, or a visit re-rooted, in
// between makes the commit conflict, and the event is retried from fresh reads.
function identityFence(guard, eventId, now) {
  const id = { collection: 'customerIdentityState', id: 'revision' };
  // No customer has been resolved through the Hub yet: creating the guard
  // (exists:false) serializes with the first resolveCustomer instead.
  return guard?.revision ? { ...id, revision: guard.revision, verify: true } : { ...id, patch: { updatedAt: now, lastStripeEventId: eventId } };
}

async function resolveAccount(store, membership, eventId, now) {
  const guard = await store.read('customerIdentityState', 'revision');
  const match = matchCustomerIdentity(await store.customers(), { phone: membership.phone, email: membership.customerEmail });
  if (match.status === 'no_identity') return { link: { status: 'unlinked' } };
  const fences = [identityFence(guard, eventId, now)];
  if (match.status !== 'matched') return review({ none: 'no_customer_match', ambiguous: 'ambiguous_customer', conflict: 'contact_conflict' }[match.status], match.candidates, fences);
  return membershipAccount(store, membership, match.customer.id, match.method, fences, now);
}

/**
 * The account root one customer's membership would link to, with every read it
 * depends on fenced (lineage checks are pushed onto `fences`). Returns
 * {link, job, fences} or a review {link, review, fences} when the account
 * cannot take the membership. Used by the webhook's exact match and by a
 * manager choosing a customer in the review queue (method 'manager').
 */
export async function membershipAccount(store, membership, customerId, method, fences, now) {
  const jobs = await store.customerJobs(customerId, JOB_LIMIT);
  if (jobs.length >= JOB_LIMIT) return review('too_many_jobs', [customerId], fences);
  let lineage;
  try { lineage = await resolveDispatchLineage(store, { customerId, jobs }); }
  catch (error) {
    if (!String(error.code || '').startsWith('dispatch_lineage_')) throw error;
    return review(error.code === 'dispatch_lineage_selection_required' ? 'multiple_account_roots' : 'account_link_invalid', [customerId], fences);
  }
  if (!lineage.metadata?.rootJobId) return review('no_account_job', [customerId], fences);
  fences.push(...lineage.checks);
  const job = await store.read('jobs', lineage.metadata.rootJobId), observed = lineage.checks.find(check => check.id === job?.id);
  // The mirror writes the root at this revision, so it must be the one lineage verified.
  if (!job?.revision || (observed && observed.revision !== job.revision)) throw fail('account_changed', 'The customer account changed during linking. Retry the event.', 409);
  if (plain(job.garageGuard) && job.garageGuard.membershipId && job.garageGuard.membershipId !== membership.subscriptionId) return review('account_has_other_membership', [customerId], fences);
  return { link: { status: 'linked', customerId, accountJobId: job.id, method, linkedAt: now }, job, fences };
}

async function linkedAccount(store, membership) {
  const { customerId, accountJobId } = membership.link, job = await store.read('jobs', accountJobId);
  const owner = job?.customerAccountOwnerJobId, carried = plain(job?.garageGuard) ? job.garageGuard.membershipId : '';
  if (!job?.revision || job.customerId !== customerId || (owner && owner !== job.id) || (carried && carried !== membership.subscriptionId)) return review('account_link_changed', [customerId]);
  return { link: membership.link, job };
}

// Display copy only; the membership record stays authoritative. Visits are
// written when this event restores them or on the first mirror, so a manager's
// used-visit count survives (including Hub edits that rewrite garageGuard).
export function mirrorPatch(job, membership, reset, now) {
  if (!['active', 'past_due', 'cancelled'].includes(membership.status)) return null;
  const current = plain(job.garageGuard) ? job.garageGuard : {}, carries = current.membershipId === membership.subscriptionId || Boolean(membership.link.mirroredAt);
  const garageGuard = { ...current, plan: membership.plan, status: membership.status, visitsIncluded: membership.visitsIncluded, membershipId: membership.subscriptionId, source: 'stripe', updatedAt: now, updatedBy: 'stripe_webhook' };
  if (membership.currentPeriodEnd) garageGuard.renewalDate = denverToday(new Date(membership.currentPeriodEnd));
  if ((reset || !carries) && Number.isInteger(membership.visitsRemaining)) garageGuard.visitsRemaining = membership.visitsRemaining;
  return { garageGuard, updatedAt: now };
}

/** Apply one Garage Guard event exactly once. Returns {status:'applied'|'duplicate'|'ignored', link, alertPending};
 * a duplicate also reports its receipt's alertStatus so an unsettled 'sending' alert can be resolved. */
export async function applyGarageGuardEvent(store, input, { now = new Date().toISOString(), alerts = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const receipt = await store.read('stripe_events', input.eventId);
    if (receipt) return { status: 'duplicate', membershipId: receipt.subscriptionId || input.subscriptionId, link: receipt.link || '', alertPending: receipt.alert?.status === 'pending', alertStatus: receipt.alert?.status || '' };
    const current = await store.read('memberships', input.subscriptionId);
    if (!current && !input.plan) return { status: 'ignored' };
    const { membership, reset, previousStatus } = nextMembership(current, input, now);
    const saved = plain(membership.link) ? membership.link : { status: 'unlinked' };
    // A link needing review, or one a manager dismissed, stays with the manager; automation never re-guesses it.
    let account;
    try { account = saved.status === 'linked' ? await linkedAccount(store, membership) : ['needs_review', 'dismissed'].includes(saved.status) ? { link: saved } : await resolveAccount(store, membership, input.eventId, now); }
    catch (error) { if (error.code === 'garage_guard_account_changed' && attempt < 2) continue; throw error; }
    const writes = [];
    if (account.review) {
      const existing = await store.read('membership_reviews', input.subscriptionId);
      writes.push({ collection: 'membership_reviews', id: input.subscriptionId, ...(existing ? { revision: existing.revision } : {}), patch: {
        subscriptionId: input.subscriptionId, status: 'open', reason: account.review.reason, candidateCustomerIds: account.review.candidates, plan: membership.plan,
        customerEmail: membership.customerEmail, phone: membership.phone, customerName: membership.customerName, serviceAddress: membership.serviceAddress,
        eventId: input.eventId, ...(existing ? {} : { createdAt: now }), updatedAt: now } });
      account.link = { ...account.link, flaggedAt: now };
    }
    membership.link = account.link;
    const mirror = account.job && account.link.status === 'linked' ? mirrorPatch(account.job, membership, reset, now) : null;
    if (mirror) { writes.push({ collection: 'jobs', id: account.job.id, revision: account.job.revision, patch: mirror }); membership.link = { ...membership.link, mirroredAt: now }; }
    const welcome = input.action === 'checkout' && membership.status === 'active' && !membership.welcomeAlertEventId;
    if (welcome) membership.welcomeAlertEventId = input.eventId;
    const alertWanted = welcome || (input.action === 'payment_failed' && membership.status === 'past_due') || (input.action === 'cancelled' && previousStatus !== 'cancelled');
    writes.push({ collection: 'memberships', id: input.subscriptionId, ...(current ? { revision: current.revision } : {}), patch: { ...membership, lastEventId: input.eventId, lastEventType: input.type, updatedAt: now } });
    writes.push({ collection: 'stripe_events', id: input.eventId, patch: { eventId: input.eventId, type: input.type, created: input.created, livemode: input.livemode, subscriptionId: input.subscriptionId, link: membership.link.status, processedAt: now, alert: { status: alertWanted ? (alerts ? 'pending' : 'not_configured') : 'none' } } });
    // A document this commit already writes at its observed revision is fenced by that write.
    const targets = new Set(writes.map(write => `${write.collection}/${write.id}`));
    for (const fence of account.fences || []) if (!targets.has(`${fence.collection}/${fence.id}`)) { targets.add(`${fence.collection}/${fence.id}`); writes.push(fence); }
    try { await store.commit(writes); }
    // dispatchStorage reports a stale revision as dispatch_revision_conflict and a
    // lost response as dispatch_outcome_unknown. The commit is atomic, so the next
    // pass re-reads the receipt for both: present means applied, absent means safe to retry.
    catch (error) { if (RETRYABLE.has(error.code) && attempt < 2) continue; throw error; }
    return { status: 'applied', membershipId: input.subscriptionId, link: membership.link.status, reason: membership.link.reason || '', mirrored: Boolean(mirror), alertPending: alerts && alertWanted };
  }
}

/**
 * Claim a pending team alert before sending, under a random attemptId. Returns
 * true only when the 'sending' claim is provably this attempt's, false when no
 * alert is pending or another delivery owns it. When the claim's outcome cannot
 * be confirmed and the alert is still pending, it throws a retryable
 * garage_guard_alert_unconfirmed (503) so Stripe redelivers and the claim is
 * tried again; a claimed alert is never sent twice.
 */
export async function claimGarageGuardAlert(store, eventId, now = new Date().toISOString(), attemptId = crypto.randomUUID()) {
  const receipt = await store.read('stripe_events', eventId);
  if (receipt?.alert?.status !== 'pending') return false;
  try { await store.commit([{ collection: 'stripe_events', id: eventId, revision: receipt.revision, patch: { alert: { ...receipt.alert, status: 'sending', attemptId, claimedAt: now } } }]); return true; }
  catch (error) {
    if (!RETRYABLE.has(error.code)) throw error;
    // A stale claim (another delivery moved the receipt) or a lost response: the receipt tells whose claim stands.
    const alert = (await store.read('stripe_events', eventId))?.alert;
    if (alert?.status === 'sending' && alert.attemptId === attemptId) return true;
    if (alert?.status === 'pending') throw fail('alert_unconfirmed', 'The team alert could not be claimed. Retry the event.');
    return false;
  }
}

/** Record the send result for this attempt's claim. Re-reads between tries and never repeats the send. */
export async function settleGarageGuardAlert(store, eventId, status, now = new Date().toISOString(), attemptId = '') {
  for (let attempt = 0; ; attempt++) {
    const receipt = await store.read('stripe_events', eventId), alert = receipt?.alert;
    const ours = !attemptId || alert?.attemptId === attemptId;
    if (alert?.status !== 'sending' || !ours) return ours && alert?.status === status;
    try { await store.commit([{ collection: 'stripe_events', id: eventId, revision: receipt.revision, patch: { alert: { ...alert, status, settledAt: now } } }]); return true; }
    catch (error) { if (!RETRYABLE.has(error.code) || attempt >= 2) throw error; }
  }
}

/**
 * A redelivered event whose alert is still 'sending' was claimed by a delivery
 * that never saved its result. Within ALERT_STALE_MS it may still be in flight
 * (false: let Stripe come back later). After that it is recorded 'uncertain'
 * explicitly and never resent (true). Returns true when nothing is left open.
 */
export async function expireGarageGuardAlert(store, eventId, now = new Date().toISOString()) {
  const receipt = await store.read('stripe_events', eventId), alert = receipt?.alert;
  if (alert?.status !== 'sending') return true;
  const claimed = Date.parse(alert.claimedAt || '');
  if (Number.isFinite(claimed) && Date.parse(now) - claimed < ALERT_STALE_MS) return false;
  await store.commit([{ collection: 'stripe_events', id: eventId, revision: receipt.revision, patch: { alert: { ...alert, status: 'uncertain', reason: 'unsettled_claim', settledAt: now } } }]);
  return true;
}

export function membershipStorage(env, fetcher = firestoreFetch) {
  const store = dispatchStorage(env, fetcher);
  return {
    read: store.read, commit: store.commit, customers: store.customers,
    async customerJobs(customerId, limit = JOB_LIMIT) {
      let response;
      try {
        response = await fetcher(env, `https://firestore.googleapis.com/v1/${ROOT}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: 'jobs' }], where: { fieldFilter: { field: { fieldPath: 'customerId' }, op: 'EQUAL', value: { stringValue: customerId } } }, limit,
        } }) });
      } catch { throw fail('storage_unavailable', 'Customer jobs could not be loaded. Retry the event.'); }
      if (!response.ok) throw fail('storage_unavailable', 'Customer jobs could not be loaded. Retry the event.');
      const rows = await response.json().catch(() => null);
      if (!Array.isArray(rows)) throw fail('storage_incomplete', 'Customer jobs returned an incomplete response. Retry the event.');
      return rows.filter(row => row?.document).map(({ document }) => {
        const id = String(document.name || '').split('/documents/jobs/')[1] || '';
        if (!id || id.includes('/') || typeof document.updateTime !== 'string' || !document.updateTime) throw fail('storage_incomplete', 'A customer job had no verifiable identity. Retry the event.');
        return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
      });
    },
  };
}
