import { requireDispatcher } from './dispatch-service.js';
import { dispatchStorage } from './dispatch-storage.js';
import { verifiedAccountRoot } from './dispatch-lineage.js';
import { addDays, denverToday } from './dispatch-time.js';
import { firestoreFetch } from './firebase-service-account.js';
import { auditWrite } from './hub-audit.js';
import { OWNER_USERNAME } from './business-users.js';
import { isHubOwner } from './hub-session.js';
import { funnelEventWrite } from './funnel-events.js';
import { funnelHubId } from './funnel-definitions.js';
import { moneyCents } from './operations-financials.js';
import { MAX_TOTAL_CENTS } from './quote-model.js';

/**
 * FUN-36: server-authoritative customer credits, gift-card sales, customer
 * decision prompts and rebooking follow-ups (the last lifecycle writers the
 * Hub browser still owned):
 *   mutateLifecycle(store, actor, input, now, {courtesyOwnerLimitCents, prepaidOwnerLimitCents})
 * store: {read(collection,id), commit(writes)} (lifecycleStorage or a fake).
 * Each change is ONE commit: the changed job (updateTime precondition from
 * input.expectedRevision), verify-only fences on every account-lineage hop it
 * read, the gift-card sale record (gift_card.sell), a create-only
 * lifecycleOperations/{requestId} receipt (sha256 of {actor,input}), a
 * create-only hub_audit entry and the funnel events. A replay returns the
 * saved result; the same requestId with another payload is
 * lifecycle_idempotency_conflict.
 *   credit.issue       a wallet credit on the customer's account root job, with
 *                      a class (gift_purchase | garage_guard | referral |
 *                      courtesy). Event credit.issued. A gift_purchase credit
 *                      (a card sold before the Hub: a liability with no cash
 *                      recorded here) is owner-only and claims its reference
 *                      like a sale; a manager's garage_guard credit needs an
 *                      active, Stripe-backed Garage Guard membership with
 *                      unused visits (guardView).
 *   gift_card.sell     the cash received (giftCardSales, gift_card.sold, dated
 *                      when received and attested) plus the liability: a
 *                      gift_purchase wallet card (credit.issued). A
 *                      create-only giftCardSaleRefs/{sha256(normalized
 *                      reference)} claim (the method is kept as data) refuses
 *                      the same payment entered twice, under any method or as
 *                      a pre-Hub card. A manager's sale paid 'other' needs
 *                      the owner.
 * Owner limits bind a manager's running total per customer account, not each
 * credit: every card a non-owner issued in the last MANAGER_LIMIT_DAYS Denver
 * days in the same group (courtesy + referral against the courtesy limit;
 * garage_guard + gift-card sales against the prepaid limit) plus the new
 * amount. The wallet is on the account document written under its updateTime
 * precondition, so two racing credits cannot both pass. Until FUN-27 denies
 * browser SDK writes to giftWallet, customerDecisions, rebookingRequests and
 * garageGuard, these limits bind only this server path.
 *   decision.prompt    a pending customer decision stamped with the server
 *                      clock (change_order.proposed).
 *   rebook.mark_contacted  a pending portal rebooking request marked
 *                      contacted (rebook.contacted).
 * Nothing here sends anything to a customer, and no job money field (estimate,
 * payment, deposit, invoice, approvedChangeTotal, status) is ever written:
 * a gift-card sale is not job revenue, and a credit is spent only by the
 * customer portal's apply_gift_credit.
 */
export const LIFECYCLE_ACTIONS = Object.freeze(['credit.issue', 'gift_card.sell', 'decision.prompt', 'rebook.mark_contacted']);
export const ISSUED_CREDIT_CLASSES = Object.freeze(['garage_guard', 'referral', 'courtesy', 'gift_purchase']);
export const SALE_METHODS = Object.freeze(['cash', 'check', 'card_terminal', 'stripe_link', 'bank_transfer', 'other']);
export const LIFECYCLE_RECEIPTS = 'lifecycleOperations';
export const GIFT_CARD_SALES = 'giftCardSales';
export const GIFT_CARD_SALE_REFS = 'giftCardSaleRefs';
// The customer portal lists at most 20 credits and 20 decisions; the browser
// tools used to drop the oldest, which could erase a live balance or an
// approved change order, so a full list is refused instead (there is no Hub
// archive for used credits or answered decisions yet).
export const MAX_WALLET_CARDS = 20;
export const MAX_DECISIONS = 20;
export const MAX_TIME_DELTA_MINUTES = 4320;
export const DEFAULT_COURTESY_OWNER_LIMIT_CENTS = 10000;
export const DEFAULT_PREPAID_OWNER_LIMIT_CENTS = 100000;
export const MANAGER_LIMIT_DAYS = 30;
// Courtesy and referral credits are contra revenue (a discount the business
// gives away) and share the courtesy limit; Garage Guard credits and gift-card
// sales are payment-class (prepaid) value and share the prepaid limit.
const LIMIT_GROUP = { courtesy: 'contra', referral: 'contra', garage_guard: 'prepaid', gift_purchase: 'prepaid' };
const LIMIT_TEXT = {
  contra: { what: 'Courtesy and referral credits', counts: 'courtesy or referral credit a manager gave', ask: 'issue this credit' },
  garage_guard: { what: 'Garage Guard credits', counts: 'Garage Guard credit or gift-card sale a manager recorded for', ask: 'issue this credit' },
  sale: { what: 'Gift-card sales', counts: 'Garage Guard credit or gift-card sale a manager recorded for', ask: 'record this sale' },
};
// The Garage Guard plans the customer portal shows (customer-portal.js).
const GUARD_PLANS = new Set(['lite', 'guard', 'black']);
// The subscription id the Garage Guard Stripe sync mirrors onto garageGuard.membershipId (garage-guard-membership.js).
const STRIPE_SUBSCRIPTION = /^sub_[A-Za-z0-9_]{1,200}$/;
const CLASS_SOURCE = { gift_purchase: 'Gift card', garage_guard: 'Garage Guard credit', referral: 'Referral reward', courtesy: 'Courtesy credit' };
// gift_card.sold uses the shared funnel payment-method vocabulary.
const EVENT_METHOD = { cash: 'cash', check: 'check', card_terminal: 'card', stripe_link: 'card', bank_transfer: 'ach', other: 'other' };
const METHOD_LABEL = { cash: 'cash', check: 'check', card_terminal: 'card terminal', stripe_link: 'Stripe payment link', bank_transfer: 'bank transfer', other: 'other' };
const COMMON = ['action', 'requestId', 'jobId', 'expectedRevision', 'actorId'];
const FIELDS = {
  'credit.issue': ['accountId', 'amountCents', 'creditClass', 'label', 'reason', 'reference'],
  'gift_card.sell': ['accountId', 'amountCents', 'label', 'method', 'reference', 'receivedAt'],
  'decision.prompt': ['title', 'details', 'priceDeltaCents', 'timeDeltaMinutes', 'photoUrl'],
  'rebook.mark_contacted': ['rebookingRequestId', 'note'],
};
const WALLET = new Set(['credit.issue', 'gift_card.sell']);
const OPERATIONAL = ['job', 'cleanout', 'reorg', 'walkthrough'], SERVICE = ['job', 'cleanout', 'reorg'];
const FINAL = new Set(['lifecycle_idempotency_conflict', 'lifecycle_actor_changed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, ITEM_ID = /^[A-Za-z0-9_-]{1,120}$/, PROVIDER_ID = /^[A-Za-z0-9_-]{1,120}$/;
const PHOTO = /^https:\/\/(?:drive|docs)\.google\.com\/[^\s<>"']{1,480}$/i;
const SALE_BACKDATE_MS = 366 * 86400000, FUTURE_MS = 300000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const given = value => value !== undefined && value !== null;
const fail = (reason, message, status = 400, details) => Object.assign(new Error(message), { code: `lifecycle_${reason}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const stage = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const closed = job => ['cancelled', 'canceled', 'noshow', 'no_show', 'no-show'].includes(stage(job));
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const usd = cents => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const denverDay = value => { const at = Date.parse(value); return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium' }) : 'an earlier date'; };
const str = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : null;
const customerRecord = row => plain(row) && funnelHubId(row.id) && !row.recordType && OPERATIONAL.includes(row.type);

export const lifecycleApiEnabled = env => env?.CUSTOMER_LIFECYCLE_API_ENABLED === 'true';
function ownerLimit(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim();
  return /^\d{1,9}$/.test(value) && Number(value) <= MAX_TOTAL_CENTS ? Number(value) : 0;
}
/** Courtesy and referral credits above this many cents need the owner. Unset: $100.00; an unreadable value makes every one owner-only. */
export const courtesyOwnerLimitCents = env => ownerLimit(env?.COURTESY_CREDIT_OWNER_LIMIT_CENTS, DEFAULT_COURTESY_OWNER_LIMIT_CENTS);
/** Garage Guard credits and gift-card sales above this many cents need the owner. Unset: $1,000.00; an unreadable value makes every one owner-only. */
export const prepaidOwnerLimitCents = env => ownerLimit(env?.PREPAID_CREDIT_OWNER_LIMIT_CENTS, DEFAULT_PREPAID_OWNER_LIMIT_CENTS);
export const lifecycleLimits = env => ({ courtesyOwnerLimitCents: courtesyOwnerLimitCents(env), prepaidOwnerLimitCents: prepaidOwnerLimitCents(env) });
export const lifecycleOwner = session => isHubOwner(session) && session.role === 'owner';

export function requireLifecycleManager(session, env) {
  try { requireDispatcher(session, env); }
  catch (error) {
    if (error.status === 401) throw fail('sign_in_required', 'Sign in to the Employee Hub to manage customer credits and requests.', 401);
    throw fail('forbidden', 'Only an operations manager or owner can manage customer credits and requests.', 403);
  }
}

/**
 * Store over dispatchStorage (rows carry revision = updateTime; commit applies
 * every write or none; verify:true writes are transaction fences). Codes map
 * to lifecycle_*: a stale precondition is lifecycle_revision_conflict (409),
 * a lost or unexplained response lifecycle_outcome_unknown (503; retry the
 * same requestId, whose receipt is the proof).
 */
export function lifecycleStorage(env, fetcher = firestoreFetch) {
  const base = dispatchStorage(env, fetcher);
  async function mapped(work, message) {
    try { return await work(); }
    catch (error) {
      if (error?.code === 'dispatch_revision_conflict') throw fail('revision_conflict', 'This customer record changed while you were saving. Load the latest details and review them.', 409);
      if (error?.code === 'dispatch_outcome_unknown') throw fail('outcome_unknown', 'The save could not be verified. Retry the same request to safely check whether it saved.', 503);
      throw fail(error?.code === 'dispatch_storage_incomplete' ? 'storage_incomplete' : 'storage_unavailable', message, 503);
    }
  }
  return {
    read: (collection, id) => mapped(() => base.read(collection, id), 'The customer record could not be loaded. Retry.'),
    commit: writes => mapped(() => base.commit(writes), 'The customer record could not be saved. Retry the same request.'),
  };
}

function text(value, label, max, { required = false, min = required ? 1 : 0, multiline = false } = {}) {
  if (!given(value)) value = '';
  if (typeof value !== 'string') throw fail('invalid_field', `${label} must be text.`);
  const cleaned = (multiline ? value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : value.replace(/[\r\n\t]+/g, ' ')).trim();
  if (cleaned.length > max) throw fail('invalid_field', `${label} must be at most ${max} characters.`);
  if (cleaned.length < min) throw fail('invalid_field', required ? `${label} is required.` : `${label} is too short.`);
  return cleaned;
}
function whole(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('invalid_amount', `${label} must be whole cents from ${usd(min)} to ${usd(max)}.`);
  return value;
}
// A list the browser tools kept on the job. Missing is empty; anything else unreadable is never overwritten.
function list(job, field, label) {
  const value = job[field];
  if (!given(value)) return [];
  if (!Array.isArray(value)) throw fail('record_invalid', `The saved ${label} on this job cannot be read, so nothing was changed. Review the job.`, 409);
  return value;
}
function walletOf(account) {
  const wallet = account.giftWallet;
  if (!given(wallet)) return { wallet: {}, cards: [] };
  if (!plain(wallet) || given(wallet.cards) && !Array.isArray(wallet.cards)) throw fail('record_invalid', 'The saved customer credits cannot be read, so nothing was changed. Review the account.', 409);
  return { wallet, cards: wallet.cards || [] };
}

function validate(input, actor) {
  if (!plain(input) || !LIFECYCLE_ACTIONS.includes(input.action) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'Use a supported customer action with a unique request ID.');
  const unknown = Object.keys(input).filter(key => !COMMON.includes(key) && !FIELDS[input.action].includes(key));
  if (unknown.length) throw fail('request_invalid', 'This request contains unsupported fields. Refresh the form and try again.', 400, { fields: unknown.slice(0, 10) });
  if (!funnelHubId(input.jobId)) throw fail('request_invalid', 'Choose a valid job.');
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 100) throw fail('request_invalid', 'Refresh the customer before changing it.');
  if (WALLET.has(input.action) && !funnelHubId(input.accountId)) throw fail('request_invalid', 'Refresh the customer account before changing its credits.');
  if (input.actorId !== undefined && String(input.actorId).trim().toLowerCase() !== String(actor.user).trim().toLowerCase()) throw fail('actor_changed', 'The signed-in employee changed. Sign in as the original employee to finish this request, or discard it.', 403);
}

/**
 * The job and the customer account root that holds the wallet (the portal's
 * customerAccountOwnerJobId chain, verified hop by hop against the same
 * customerId), plus a verify-only fence for every other record read. A broken
 * account link leaves account null with accountError: only credit changes
 * need the account, so decisions and rebooking still work on the job itself.
 */
export async function lifecycleContext(store, jobId) {
  const job = await store.read('jobs', jobId);
  if (!customerRecord(job) || job.id !== jobId) throw fail('job_not_found', 'This job is not available for customer credits or requests.', 404);
  if (typeof job.revision !== 'string' || !job.revision) throw fail('storage_incomplete', 'The job has no verifiable revision. Retry.', 503);
  const reads = new Map([[job.id, job]]);
  // The portal's test: an empty or missing link means this job is the account.
  let account = job, accountError = null;
  const ownerId = job.customerAccountOwnerJobId || job.id;
  if (ownerId !== job.id) {
    try { account = await verifiedAccountRoot(async id => { if (!reads.has(id)) reads.set(id, await store.read('jobs', id)); return reads.get(id); }, ownerId, job.customerId); }
    catch (error) {
      if (!/^dispatch_lineage_/.test(error.code || '')) throw error;
      account = null;
      accountError = error.code === 'dispatch_lineage_missing' ? fail('account_unavailable', 'The customer account that holds this customer\'s credits could not be loaded. Retry, or review the account link.', 503)
        : fail('account_invalid', 'This job\'s customer account link needs review before its credits can change.', 409);
    }
  }
  if (account && (typeof account.revision !== 'string' || !account.revision)) throw fail('storage_incomplete', 'The customer account has no verifiable revision. Retry.', 503);
  const fences = account ? [...reads.values()].filter(row => row.id !== account.id).map(row => ({ collection: 'jobs', id: row.id, revision: row.revision, verify: true })) : [];
  return { job, account, accountError, fences };
}

const creditId = (prefix, requestId) => `${prefix}-${requestId.toLowerCase()}`;
// issuedByOwner marks the cards that do not count toward a manager's running total.
function newCard({ input, actor, now, job, cls, amount, label, extra }) {
  return { id: creditId(cls === 'gift_purchase' && extra.saleId ? 'giftcard' : 'credit', input.requestId), label, source: CLASS_SOURCE[cls], creditClass: cls, issuedAmount: amount / 100, issuedAmountCents: amount, remainingAmount: amount / 100,
    issuedAt: now, issuedBy: actor.user, issuedByOwner: lifecycleOwner(actor), requestId: input.requestId, sourceJobId: job.id, ...extra };
}
function walletPatch(account, card, now) {
  const { wallet, cards } = walletOf(account);
  if (cards.length >= MAX_WALLET_CARDS) throw fail('wallet_full', `This customer already has ${MAX_WALLET_CARDS} credits, the most the portal can show, so nothing was added. The Hub cannot archive used credits yet: ask the owner to have the developer archive this customer's fully used credits in the database, then try again.`, 409);
  return { giftWallet: { ...wallet, cards: [...cards, card], updatedAt: now } };
}

// A card's issuedBy names someone other than the owner (the flag-off browser tool writes the Hub username, or 'manager').
const issuedByNonOwner = card => typeof card.issuedBy === 'string' && card.issuedBy.trim() !== '' && card.issuedBy.trim().toLowerCase() !== OWNER_USERNAME;

/**
 * What non-owners issued to this account in the last MANAGER_LIMIT_DAYS
 * Denver days (today included), per limit group, in cents. A classed card
 * counts unless it is marked issuedByOwner; one with an unreadable issue time
 * counts. A card with no class (written by the flag-off browser tool, or
 * before FUN-36) counts in the contra group when its issuedBy names a
 * non-owner and its issuedAt is readable and inside the window, so turning
 * the API on does not start the managers' totals at $0. A counted card with
 * an unreadable amount makes its group null (unknown, never 0).
 */
export function managerIssued(cards, now) {
  const since = addDays(denverToday(new Date(now)), 1 - MANAGER_LIMIT_DAYS), totals = { contra: 0, prepaid: 0 };
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!plain(card) || card.issuedByOwner === true) continue;
    const at = instant(card.issuedAt), classed = Object.hasOwn(LIMIT_GROUP, card.creditClass);
    if (!classed && !(at && issuedByNonOwner(card))) continue;
    const group = classed ? LIMIT_GROUP[card.creditClass] : 'contra';
    if (totals[group] === null) continue;
    if (at && denverToday(new Date(at)) < since) continue;
    const amount = Number.isSafeInteger(card.issuedAmountCents) && card.issuedAmountCents >= 0 ? card.issuedAmountCents : cents(card.issuedAmount);
    totals[group] = amount === null ? null : totals[group] + amount;
  }
  return { contraCents: totals.contra, prepaidCents: totals.prepaid, since, windowDays: MANAGER_LIMIT_DAYS };
}

/**
 * The Garage Guard membership as the customer portal reads it: the account
 * root's garageGuard, else the job's own legacy `membership`
 * (customer-portal-access.js puts the account's garageGuard on the job, then
 * customer-portal.js reads garageGuard || membership). `eligible` is when a
 * manager may turn an unused visit into credit: a membership the Stripe sync
 * mirrored (source 'stripe' with its sub_ subscription id in membershipId),
 * status exactly 'active' (not paused, past_due, pending or cancelled in any
 * spelling) and a whole number of visits remaining above 0. The Hub's
 * "Garage Guard status" editor rewrites garageGuard without source or
 * membershipId, so a membership typed there never qualifies.
 */
export function guardView(account, job = account) {
  const raw = account?.garageGuard || job?.membership, guard = plain(raw) ? raw : {};
  const plan = GUARD_PLANS.has(guard.plan) ? guard.plan : null, status = str(guard.status, 20);
  const visitsRemaining = typeof guard.visitsRemaining === 'number' && Number.isFinite(guard.visitsRemaining) && guard.visitsRemaining >= 0 ? guard.visitsRemaining : null;
  const stripe = guard.source === 'stripe' && typeof guard.membershipId === 'string' && STRIPE_SUBSCRIPTION.test(guard.membershipId);
  return { plan, status, visitsRemaining, stripe, eligible: Boolean(plan) && stripe && status === 'active' && Number.isInteger(visitsRemaining) && visitsRemaining > 0 };
}

// A non-owner's running total in the credit's group, plus this amount, must stay within the owner limit.
function managerLimit({ limit, account, actor, now, limits }) {
  if (!limit || lifecycleOwner(actor)) return;
  const group = LIMIT_GROUP[limit.cls], ceiling = group === 'contra' ? limits.courtesy : limits.prepaid;
  const issued = managerIssued(walletOf(account).cards, now)[group === 'contra' ? 'contraCents' : 'prepaidCents'];
  if (issued !== null && issued + limit.amount <= ceiling) return;
  const words = LIMIT_TEXT[group === 'contra' ? 'contra' : limit.kind === 'sale' ? 'sale' : 'garage_guard'];
  throw fail('owner_required', `${words.what} over ${usd(ceiling)} need the owner. That limit counts every ${words.counts} this customer in the last ${MANAGER_LIMIT_DAYS} days: ${issued === null ? 'the earlier ones could not be totalled' : `${usd(issued)} so far`}. Ask the owner to ${words.ask}.`, 403,
    { limitCents: ceiling, managerIssuedCents: issued, windowDays: MANAGER_LIMIT_DAYS });
}

function issueCredit({ input, actor, now, job, account }) {
  const amount = whole(input.amountCents, 'The credit amount', 1, MAX_TOTAL_CENTS), cls = input.creditClass;
  if (!ISSUED_CREDIT_CLASSES.includes(cls)) throw fail('invalid_credit_class', `Choose a credit type: ${ISSUED_CREDIT_CLASSES.join(', ')}.`);
  const label = text(input.label ?? 'EGC service credit', 'The customer-facing label', 120, { required: true, min: 2 });
  const reason = text(input.reason, 'The reason for this credit', 300, { required: true, min: 3 });
  const reference = text(input.reference, 'The original gift-card sale reference', 160, cls === 'gift_purchase' ? { required: true, min: 2 } : {});
  // Payment-class credit without cash: only the owner records a card sold before the Hub; new sales use gift_card.sell.
  if (cls === 'gift_purchase' && !lifecycleOwner(actor)) throw fail('owner_required', 'Only the owner can add a gift card sold before the Hub. Record a new sale with Sell a gift card.', 403);
  // Garage Guard credit is payment-class (not contra revenue), so a manager may only turn a paying member's unused visit into it.
  if (cls === 'garage_guard' && !lifecycleOwner(actor) && !guardView(account, job).eligible) {
    throw fail('owner_required', 'This customer\'s account has no active Garage Guard membership recorded from Stripe (lite, guard or black) with unused visits, so only the owner can issue a Garage Guard credit. A membership set with the Hub\'s Garage Guard status button does not count. Choose the credit type that fits, or ask the owner.', 403, { reason: 'garage_guard_membership' });
  }
  const card = newCard({ input, actor, now, job, cls, amount, label, extra: { reason, ...(reference ? { reference } : {}) } });
  return { target: account, patch: walletPatch(account, card, now), card, result: { cardId: card.id, accountId: account.id, amountCents: amount, creditClass: cls },
    // A card sold before the Hub claims its reference like a sale, so it is added once and never on top of a sale.
    ...(cls === 'gift_purchase' ? { claim: { reference, saleId: null, cardId: card.id, method: 'pre_hub', amountCents: amount, receivedAt: null, accountJobId: account.id, recordedAt: now, recordedBy: actor.user, requestId: input.requestId } } : {}),
    limit: { cls, amount, kind: 'credit' }, events: [{ type: 'credit.issued', data: { amountCents: amount, creditClass: cls } }], reason: `${usd(amount)} ${cls} credit: ${reason}`, snapshot: 'credits' };
}

function sellGiftCard({ input, actor, now, job, account, via }) {
  const amount = whole(input.amountCents, 'The gift-card amount', 1, MAX_TOTAL_CENTS);
  if (!SALE_METHODS.includes(input.method)) throw fail('invalid_payment_method', `Choose how the gift card was paid for: ${SALE_METHODS.join(', ')}.`);
  // 'Other' carries no payment evidence a later reconciliation can match, so only the owner records it.
  if (input.method === 'other' && !lifecycleOwner(actor)) throw fail('owner_required', 'A gift-card sale paid some other way needs the owner. Choose how it was paid (cash, check, card terminal, Stripe payment link or bank transfer), or ask the owner to record it.', 403, { reason: 'sale_method_other' });
  const reference = text(input.reference, 'A receipt, check or transaction reference', 160, { required: true, min: 2 });
  const label = text(input.label ?? 'EGC gift card', 'The customer-facing label', 120, { required: true, min: 2 });
  const receivedAt = input.receivedAt === undefined ? now : instant(input.receivedAt);
  if (!receivedAt || Date.parse(receivedAt) > Date.parse(now) + FUTURE_MS || Date.parse(receivedAt) < Date.parse(now) - SALE_BACKDATE_MS) throw fail('invalid_received_at', 'The time received must be a valid time within the last year and not in the future.');
  const saleId = input.requestId.toLowerCase(), card = newCard({ input, actor, now, job, cls: 'gift_purchase', amount, label, extra: { saleId, reference } });
  const sale = { saleId, cardId: card.id, accountJobId: account.id, sourceJobId: job.id, customerId: str(job.customerId, 180), amountCents: amount, method: input.method, reference, receivedAt, label, creditClass: 'gift_purchase',
    status: 'recorded', recordedAt: now, recordedBy: actor.user, via, requestId: input.requestId };
  return { target: account, patch: walletPatch(account, card, now), writes: [{ collection: GIFT_CARD_SALES, id: saleId, patch: sale }], result: { cardId: card.id, saleId, accountId: account.id, amountCents: amount, creditClass: 'gift_purchase', method: input.method, receivedAt },
    claim: { reference, saleId, cardId: card.id, method: input.method, amountCents: amount, receivedAt, accountJobId: account.id, recordedAt: now, recordedBy: actor.user, requestId: input.requestId }, limit: { cls: 'gift_purchase', amount, kind: 'sale' },
    events: [{ type: 'gift_card.sold', data: { amountCents: amount, method: EVENT_METHOD[input.method] }, clockSource: 'attested', occurredAt: receivedAt, source: { collection: GIFT_CARD_SALES, id: saleId } }, { type: 'credit.issued', data: { amountCents: amount, creditClass: 'gift_purchase' } }],
    reason: `${usd(amount)} gift card, ${input.method} ${reference}`, snapshot: 'credits', sale };
}

// A gift card's payment reference is claimed once: keyed by the normalized
// reference alone (compared without case, spaces or punctuation; the method
// is kept as data), so the same payment entered again under another request
// ID, under another method, or again as a card sold before the Hub is
// refused. A different payment with a colliding reference is told to make its
// reference more specific.
const referenceKey = reference => digest(reference.normalize('NFKC').toLowerCase().replace(/[\s#.,:;/_-]+/g, '') || reference.toLowerCase());
const shortId = value => String(value || 'unknown').replace(/^(?:credit|giftcard)-/, '').slice(0, 8);
async function claimReference(store, claim) {
  const id = await referenceKey(claim.reference), existing = await store.read(GIFT_CARD_SALE_REFS, id);
  if (existing) {
    const saleId = str(existing.saleId, 180), cardId = str(existing.cardId, 180), method = str(existing.method, 20);
    const earlier = method === 'pre_hub' ? `A gift card sold before the Hub was already added with this reference (card ${shortId(cardId)}, added ${denverDay(existing.recordedAt)})`
      : `${method === 'other' ? 'An' : 'A'} ${METHOD_LABEL[method] || 'recorded'} gift-card sale with this reference was already recorded (sale ${shortId(saleId)}, received ${denverDay(existing.receivedAt)})`;
    throw fail('sale_duplicate', `${earlier}, so nothing was recorded again. If this is a different ${claim.saleId ? 'payment' : 'card'}, make the reference more specific, for example add the payer's name or the date.`, 409,
      { saleId: saleId || null, cardId: cardId || null, method, receivedAt: str(existing.receivedAt, 40), amountCents: Number.isSafeInteger(existing.amountCents) ? existing.amountCents : null });
  }
  const { reference, ...data } = claim;
  return { id, write: { collection: GIFT_CARD_SALE_REFS, id, patch: data } };
}

function promptDecision({ input, actor, now, job }) {
  if (!SERVICE.includes(job.type)) throw fail('job_not_supported', 'Customer decisions are for customer jobs, not walkthroughs.', 409);
  if (closed(job)) throw fail('job_closed', 'A cancelled job cannot ask the customer for a decision.', 409);
  const title = text(input.title, 'The decision needed', 180, { required: true, min: 3 });
  const details = text(input.details, 'What the crew found', 1200, { required: true, min: 3, multiline: true });
  const priceDeltaCents = whole(input.priceDeltaCents ?? 0, 'The additional price', 0, MAX_TOTAL_CENTS);
  const minutes = input.timeDeltaMinutes ?? 0;
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > MAX_TIME_DELTA_MINUTES) throw fail('invalid_field', `The additional time must be whole minutes from 0 to ${MAX_TIME_DELTA_MINUTES}.`);
  const photoUrl = text(input.photoUrl, 'The photo link', 500);
  if (photoUrl && !PHOTO.test(photoUrl)) throw fail('invalid_field', 'The photo link must be a Google Drive or Google Docs https link.');
  const decisions = list(job, 'customerDecisions', 'customer decisions');
  if (decisions.length >= MAX_DECISIONS) throw fail('decision_limit', `This job already has ${MAX_DECISIONS} customer decisions, the most the portal can show, so nothing was saved. The Hub cannot archive answered decisions yet: ask the owner to have the developer archive this job's answered decisions in the database, then try again.`, 409);
  const decision = { id: creditId('decision', input.requestId), title, details, priceDelta: priceDeltaCents / 100, priceDeltaCents, timeDeltaMinutes: minutes, photoUrl, status: 'pending', promptedAt: now, promptedBy: actor.user, requestId: input.requestId, source: 'egc_hub' };
  return { target: job, patch: { customerDecisions: [...decisions, decision], customerDecisionUpdatedAt: now }, result: { decisionId: decision.id, priceDeltaCents, timeDeltaMinutes: minutes },
    events: [{ type: 'change_order.proposed', data: { amountCents: priceDeltaCents } }], reason: title, snapshot: 'decisions' };
}

function markContacted({ input, actor, now, job }) {
  if (typeof input.rebookingRequestId !== 'string' || !ITEM_ID.test(input.rebookingRequestId)) throw fail('request_invalid', 'Choose the rebooking request to mark contacted.');
  const requests = list(job, 'rebookingRequests', 'rebooking requests'), current = requests.find(item => plain(item) && item.id === input.rebookingRequestId);
  if (!current) throw fail('rebooking_not_found', 'That rebooking request is no longer on this job. Refresh to see the latest requests.', 404);
  if (current.status !== 'pending') throw fail('rebooking_not_pending', 'That rebooking request was already handled. Refresh to see the latest requests.', 409);
  const note = text(input.note, 'The confirmation or scheduling note', 400, { required: true, min: 2 });
  const updated = requests.map(item => item === current ? { ...item, status: 'contacted', reviewedAt: now, reviewedBy: actor.user, reviewNote: note, contactedAt: now, contactedRequestId: input.requestId } : item);
  return { target: job, patch: { rebookingRequests: updated, rebookingStatus: updated.some(item => plain(item) && item.status === 'pending') ? 'pending' : 'contacted', rebookingUpdatedAt: now },
    result: { rebookingRequestId: current.id }, events: [{ type: 'rebook.contacted', data: {} }], reason: note, snapshot: 'rebooking' };
}

const PLANS = { 'credit.issue': issueCredit, 'gift_card.sell': sellGiftCard, 'decision.prompt': promptDecision, 'rebook.mark_contacted': markContacted };

const cents = value => { const found = moneyCents(value); return found === null || found > MAX_TOTAL_CENTS ? null : found; };
const cardView = card => ({ id: str(card.id, 180), label: str(card.label, 120) || 'EGC service credit', creditClass: ISSUED_CREDIT_CLASSES.includes(card.creditClass) ? card.creditClass : 'unknown',
  issuedCents: Number.isSafeInteger(card.issuedAmountCents) ? card.issuedAmountCents : cents(card.issuedAmount), remainingCents: cents(card.remainingAmount), issuedAt: str(card.issuedAt, 40), issuedBy: str(card.issuedBy, 120), saleId: str(card.saleId, 180) });
const decisionView = item => ({ id: str(item.id, 180), title: str(item.title, 180) || '', status: str(item.status, 20) || 'pending', priceDeltaCents: Number.isSafeInteger(item.priceDeltaCents) ? item.priceDeltaCents : cents(item.priceDelta ?? 0),
  timeDeltaMinutes: Number.isSafeInteger(item.timeDeltaMinutes) ? item.timeDeltaMinutes : null, promptedAt: str(item.promptedAt, 40), respondedAt: str(item.respondedAt, 40) });
const rebookView = item => ({ id: str(item.id, 120), kind: ['repeat', 'touch_up', 'garage_guard'].includes(item.kind) ? item.kind : 'repeat', timing: str(item.timing, 20), preferredDate: str(item.preferredDate, 10), preferredCrew: item.preferredCrew === true,
  notes: str(item.notes, 600) || '', status: str(item.status, 20) || 'pending', requestedAt: str(item.requestedAt, 40), reviewedAt: str(item.reviewedAt, 40), reviewNote: str(item.reviewNote, 400) });
const safeList = (value, view, max) => Array.isArray(value) ? value.filter(plain).slice(-max).map(view) : [];

/** Audit snapshots hold only the credit and request fields the manager view shows; a credit's reason is the entry's reason. */
function snapshot(kind, row) {
  if (kind === 'credits') return { credits: safeList(row.giftWallet?.cards, cardView, 50) };
  if (kind === 'decisions') return { decisions: safeList(row.customerDecisions, decisionView, 50) };
  return { rebooking: safeList(row.rebookingRequests, item => { const view = rebookView(item); return { id: view.id, kind: view.kind, status: view.status, requestedAt: view.requestedAt, reviewedAt: view.reviewedAt }; }, 20) };
}

/**
 * Business-manager DTO: an allowlist of the job's pending customer requests
 * and the account's credits (integer cents; unknown is null), with the
 * account's Garage Guard eligibility and, given the clock, what managers
 * issued to it in the owner-limit window.
 */
export function lifecycleProjection({ job, account, accountError = null }, now = null) {
  const cards = Array.isArray(account?.giftWallet?.cards) ? account.giftWallet.cards.filter(plain) : [], credits = cards.map(cardView);
  const readable = !account || !given(account.giftWallet) || plain(account.giftWallet) && (!given(account.giftWallet.cards) || Array.isArray(account.giftWallet.cards));
  const available = readable ? credits.reduce((sum, card) => sum === null || card.remainingCents === null ? null : sum + card.remainingCents, 0) : null;
  const guard = account ? guardView(account, job) : null;
  return {
    job: { id: job.id, revision: job.revision, customer: str(job.customer, 160), customerId: str(job.customerId, 180), type: str(job.type, 20), status: stage(job) || null, decisionsAllowed: SERVICE.includes(job.type) && !closed(job),
      decisions: safeList(job.customerDecisions, decisionView, MAX_DECISIONS), decisionCount: Array.isArray(job.customerDecisions) ? job.customerDecisions.length : 0, rebooking: safeList(job.rebookingRequests, rebookView, 10) },
    account: account ? { id: account.id, revision: account.revision, sameAsJob: account.id === job.id, customer: str(account.customer, 160), readable, credits: credits.slice(0, MAX_WALLET_CARDS), cardCount: cards.length, availableCents: available, full: cards.length >= MAX_WALLET_CARDS,
      garageGuard: { plan: guard.plan, visitsRemaining: guard.visitsRemaining, eligible: guard.eligible }, managerIssued: readable && now ? managerIssued(cards, now) : null } : null,
    accountIssue: accountError ? { code: accountError.code, error: accountError.message } : null,
  };
}

/** GET view for one job: the projection plus what this viewer may do. `now` is a Date (the owner-limit window). */
export async function readLifecycle(store, actor, jobId, { courtesyOwnerLimitCents: courtesy = DEFAULT_COURTESY_OWNER_LIMIT_CENTS, prepaidOwnerLimitCents: prepaid = DEFAULT_PREPAID_OWNER_LIMIT_CENTS } = {}, now = new Date()) {
  requireLifecycleManager(actor);
  if (!funnelHubId(jobId)) throw fail('query_invalid', 'Choose a valid job.');
  return { viewer: { id: actor.user, owner: lifecycleOwner(actor) }, limits: { courtesyOwnerLimitCents: courtesy, prepaidOwnerLimitCents: prepaid, maxCredits: MAX_WALLET_CARDS, maxDecisions: MAX_DECISIONS, maxTimeDeltaMinutes: MAX_TIME_DELTA_MINUTES, managerLimitDays: MANAGER_LIMIT_DAYS },
    ...lifecycleProjection(await lifecycleContext(store, jobId), now.toISOString()) };
}

function eventIds(job) {
  return { jobId: job.id, ...(funnelHubId(job.projectId) ? { projectId: job.projectId } : {}), ...(funnelHubId(job.customerId) ? { customerId: job.customerId } : {}),
    ...(typeof job.highlevelContactId === 'string' && PROVIDER_ID.test(job.highlevelContactId) ? { highlevelContactId: job.highlevelContactId } : {}) };
}

async function contextView(store, jobId, now) {
  try { return lifecycleProjection(await lifecycleContext(store, jobId), now); } catch { return null; }
}
const result = async (store, input, saved, replayed, now) => ({ ok: true, authority: 'employee_hub', requestId: input.requestId, action: input.action, replayed, result: saved, context: await contextView(store, input.jobId, now) });

async function execute(store, actor, input, now, fingerprint, receiptId, via, limits) {
  const { job, account, accountError, fences } = await lifecycleContext(store, input.jobId);
  if (WALLET.has(input.action) && !account) throw accountError;
  if (WALLET.has(input.action) && input.accountId !== account.id) throw fail('revision_conflict', 'This customer\'s account changed after you opened it. Load the latest details and review them.', 409);
  const plan = PLANS[input.action]({ input, actor, now, job, account, via }), target = plan.target;
  if (target.revision !== input.expectedRevision) throw fail('revision_conflict', 'This customer record changed after you opened it. Load the latest details and review them.', 409);
  // A sale or a pre-Hub card claims its reference in the same commit (and keeps the claim's id);
  // an already recorded payment is reported as such before any owner limit.
  const claim = plan.claim ? await claimReference(store, plan.claim) : null;
  if (claim) (plan.sale || plan.card).referenceKey = claim.id;
  managerLimit({ limit: plan.limit, account, actor, now, limits });
  const patch = { ...plan.patch, updatedAt: now };
  const audit = auditWrite({ actor: { id: actor.user, kind: 'human', role: actor.role }, via, action: `lifecycle.${input.action}`, entity: { collection: 'jobs', id: target.id }, before: snapshot(plan.snapshot, target), after: { ...snapshot(plan.snapshot, { ...target, ...patch }), ...(plan.sale ? { sale: { saleId: plan.sale.saleId, amountCents: plan.sale.amountCents, method: plan.sale.method, reference: plan.sale.reference, receivedAt: plan.sale.receivedAt } } : {}) }, requestId: input.requestId, reason: plan.reason ?? null, visibility: 'business', now });
  const events = [];
  for (const event of plan.events) {
    const { type, data, source = { collection: LIFECYCLE_RECEIPTS, id: receiptId }, ...clock } = event;
    events.push(await funnelEventWrite(null, now, { type, idempotencyKey: { kind: 'requestId', value: input.requestId }, ...eventIds(job), actor: { id: actor.user, kind: 'human', role: actor.role }, via, source, data, ...clock, eligibility: { hub: job } }));
  }
  const saved = { ...plan.result, targetId: target.id };
  await store.commit([
    ...(WALLET.has(input.action) ? fences : []),
    { collection: 'jobs', id: target.id, revision: target.revision, patch },
    ...(plan.writes || []),
    ...(claim ? [claim.write] : []),
    { collection: LIFECYCLE_RECEIPTS, id: receiptId, patch: { fingerprint, actorId: actor.user, action: input.action, jobId: job.id, accountId: account?.id ?? null, targetId: target.id, requestId: input.requestId, via, auditId: audit.id, eventIds: events.map(event => event.id), result: saved, createdAt: now } },
    audit,
    ...events,
  ]);
  return result(store, input, saved, false, now);
}

export async function mutateLifecycle(store, actor, input, now = new Date().toISOString(), { courtesyOwnerLimitCents: courtesy = DEFAULT_COURTESY_OWNER_LIMIT_CENTS, prepaidOwnerLimitCents: prepaid = DEFAULT_PREPAID_OWNER_LIMIT_CENTS } = {}) {
  requireLifecycleManager(actor);
  validate(input, actor);
  const fingerprint = await digest({ actor: actor.user, input }), receiptId = input.requestId.toLowerCase(), via = actor.via === 'mcp' ? 'mcp' : 'hub';
  async function replay(replayed) {
    const receipt = await store.read(LIFECYCLE_RECEIPTS, receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor.user) throw fail('idempotency_conflict', 'This request ID was already used for a different customer change. Refresh before saving.', 409);
    return result(store, input, plain(receipt.result) ? receipt.result : {}, replayed, now);
  }
  const prior = await replay(true);
  if (prior) return prior;
  try { return await execute(store, actor, input, now, fingerprint, receiptId, via, { courtesy, prepaid }); }
  catch (error) {
    if (FINAL.has(error.code)) throw error;
    // A lost commit response (or a racing copy of this request) may have saved: the receipt is the proof.
    const recovered = await replay(false).catch(replayError => { if (FINAL.has(replayError.code)) throw replayError; return null; });
    if (recovered) return recovered;
    throw error;
  }
}
