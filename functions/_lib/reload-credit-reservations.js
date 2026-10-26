// Review-only reload credit primitive. No route calls this until the owner has
// confirmed package mappings and the reservation/cancellation policy.
// The caller supplies server-read grants and commits these writes together with
// the canonical scheduling write. Never accept grants or policy from a browser.
import { customerMoneyTotals, paymentLedger, refundsRecorded } from './money-core.js';
import { estimateTotals, included, pricesPendingApproval } from './quote-model.js';

const COLLECTION = 'reload_credit_accounts';
const RECEIPTS = 'reload_credit_operations';
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const TERMINAL = new Set(['released', 'consumed', 'forfeited']);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code: `reload_credit_${code}`, status });
const validId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const integer = value => Number.isSafeInteger(value) && value > 0;
// Firestore map fields need not come back in insertion order.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const countUsed = grant => grant.reservations.filter(row => row.status === 'reserved' || row.status === 'consumed' || row.status === 'forfeited').length;

function identity(actor, account) {
  if (!actor || actor.accountId !== account.id || actor.customerId !== account.customerId || actor.businessAccountId || account.businessAccountId || actor.permissions?.rebook !== true) {
    throw fail('forbidden', 'This account cannot reserve these visits.', 403);
  }
}
function policyVersion(policy) {
  if (policy?.confirmed !== true || !validId(policy.version) || !['explicit', 'none'].includes(policy.reservationExpiry) || !['release', 'forfeit', 'review'].includes(policy.cancellation) || !['release', 'forfeit', 'review'].includes(policy.expiration)) {
    throw fail('policy_required', 'The reload booking rules need owner confirmation.');
  }
  return policy.version;
}
function policySnapshot(policy) {
  return { version: policyVersion(policy), reservationExpiry: policy.reservationExpiry, cancellation: policy.cancellation, expiration: policy.expiration };
}

/** Map an explicitly reviewed purchase line to an entitlement candidate. This
 * does not write or mint credits. The adapter must enforce uniqueness of
 * purchaseJobId + purchaseLineId when inserting the candidate. No product name,
 * marketing copy, current price, or client-submitted quantity creates credits.
 * Partial-payment eligibility is deliberately unavailable until a rule exists. */
export function mappedReloadGrant(purchase, mapping, policy, now) {
  const version = policyVersion(policy);
  if (!Number.isFinite(time(now)) || !purchase || !validId(purchase.id) || !validId(purchase.customerId) || purchase.businessAccountId || !purchase.revision) throw fail('purchase_invalid', 'A canonical residential purchase is required.');
  if (mapping?.confirmed !== true || mapping.purchaseJobId !== purchase.id || !validId(mapping.id) || !validId(mapping.lineId) || !integer(mapping.units) || mapping.units > 1000 || (mapping.expiresAt !== null && (!Number.isFinite(time(mapping.expiresAt)) || time(mapping.expiresAt) <= time(now)))) throw fail('mapping_required', 'Confirm the purchased line, visit count and expiration rule.');
  if (!['accepted', 'approved'].includes(purchase.estimate?.status) || pricesPendingApproval(purchase) || ['cancelled', 'canceled', 'lost', 'superseded'].includes(purchase.pipelineStatus || purchase.status)) throw fail('purchase_unapproved', 'The purchase is not approved for reload credits.');
  const lines = purchase.estimate?.lineItems;
  const matching = Array.isArray(lines) ? lines.filter(line => line.id === mapping.lineId) : [];
  if (matching.length !== 1 || !included(matching[0]) || matching[0].kind === 'discount' || matching[0].kind === 'tip' || !Number.isSafeInteger(matching[0].totalCents) || matching[0].totalCents <= 0) throw fail('mapping_required', 'The mapped purchase line is not a selected paid service.');
  const totals = customerMoneyTotals(purchase, { unified: true }), ledger = paymentLedger(purchase);
  const quote = estimateTotals(lines);
  if (!quote.complete || quote.totalCents !== totals.quoteCents) throw fail('purchase_unapproved', 'The saved purchase lines need reconciliation.');
  if (!ledger.complete || totals.totalCents === null || totals.totalCents <= 0 || totals.balanceCents !== 0 || purchase.payment?.verified !== true || purchase.fieldPaymentPendingId || refundsRecorded(purchase)) throw fail('payment_review', 'Verify the full purchase and any refunds before granting reload credits.');
  return { id: mapping.id, purchaseJobId: purchase.id, purchaseLineId: mapping.lineId, units: mapping.units, policyVersion: version, policy: policySnapshot(policy), paymentState: 'verified', expiresAt: mapping.expiresAt, reservations: [] };
}
function validated(account) {
  if (!account || !validId(account.id) || !validId(account.customerId) || !Array.isArray(account.grants) || account.grants.length > 100) throw fail('unavailable', 'Reload credits could not be verified.');
  const ids = new Set(), jobs = new Set(), reservations = new Set(), purchases = new Set();
  for (const grant of account.grants) {
    if (!validId(grant?.id) || ids.has(grant.id) || !validId(grant.purchaseJobId) || !validId(grant.purchaseLineId) || !integer(grant.units) || grant.units > 1000 || !validId(grant.policyVersion) || !['verified', 'review', 'refunded'].includes(grant.paymentState) || !Array.isArray(grant.reservations) || grant.reservations.length > 1000 || (grant.expiresAt !== null && !Number.isFinite(time(grant.expiresAt)))) throw fail('unavailable', 'Reload credits could not be verified.');
    if (!grant.policy || !same(grant.policy, policySnapshot({ ...grant.policy, confirmed: true })) || grant.policy.version !== grant.policyVersion) throw fail('unavailable', 'The saved reload rules need review.');
    const purchaseKey = `${grant.purchaseJobId}/${grant.purchaseLineId}`;
    if (purchases.has(purchaseKey)) throw fail('unavailable', 'A purchase line has duplicate reload credits.');
    purchases.add(purchaseKey); ids.add(grant.id);
    for (const row of grant.reservations) {
      if (!validId(row?.id) || !validId(row.jobId) || jobs.has(row.jobId) || reservations.has(row.id) || !['reserved', ...TERMINAL].includes(row.status) || !Number.isFinite(time(row.reservedAt)) || !validId(row.policyVersion) || (row.expiresAt !== null && !Number.isFinite(time(row.expiresAt)))) throw fail('unavailable', 'Reload reservations need review.');
      jobs.add(row.jobId); reservations.add(row.id);
    }
    if (countUsed(grant) > grant.units) throw fail('unavailable', 'Reload credits need reconciliation.');
  }
  return account;
}

/** Available is only a view; expired holds still occupy capacity until an
 * explicit release is committed. A refund/review hold never creates credits. */
export function reloadCreditAvailability(account, actor, now) {
  validated(account); identity(actor, account);
  if (!Number.isFinite(time(now))) throw fail('clock_invalid', 'A verified time is required.', 400);
  return account.grants.map(grant => ({ id: grant.id, available: grant.paymentState === 'verified' && (grant.expiresAt === null || time(grant.expiresAt) > time(now)) ? grant.units - countUsed(grant) : 0,
    needsReview: grant.paymentState !== 'verified', expiresAt: grant.expiresAt }));
}

/** Prepare a CAS transaction, including a durable operation receipt. Caller
 * must atomically commit all writes, plus booking/cancellation if applicable;
 * on a conflict, re-read and re-plan. No provider or customer sends occur. */
export async function planReloadCreditOperation(store, { actor, accountId, requestId, action, grantId, reservationId, jobId, expiresAt = null, policy, now, cancellationConfirmed = false, completionConfirmed = false }) {
  if (![accountId, requestId, grantId, reservationId, jobId].every(validId) || !['reserve', 'complete', 'cancel', 'expire'].includes(action) || !Number.isFinite(time(now))) throw fail('invalid', 'The reload request is invalid.', 400);
  const account = validated(await store.read(COLLECTION, accountId));
  if (account.id !== accountId) throw fail('unavailable', 'Reload account identity needs review.');
  identity(actor, account);
  const version = policyVersion(policy);
  const snapshot = policySnapshot(policy);
  const payload = { accountId, action, grantId, reservationId, jobId, expiresAt, policy: snapshot, cancellationConfirmed, completionConfirmed };
  const receipt = await store.read(RECEIPTS, requestId);
  if (receipt) {
    if (receipt.customerId !== actor.customerId || !same(receipt.payload, payload)) throw fail('idempotency_conflict', 'This request was already used for another operation.');
    return { result: { ...receipt.result, duplicate: true }, writes: [] };
  }
  const next = structuredClone(account), grant = next.grants.find(row => row.id === grantId);
  if (!grant) throw fail('not_found', 'This reload credit is unavailable.', 404);
  if (grant.policyVersion !== version || !same(grant.policy, snapshot)) throw fail('policy_changed', 'The saved reload rules need review.');
  let row = grant.reservations.find(item => item.id === reservationId);
  if (row && row.jobId !== jobId) throw fail('reservation_conflict', 'The reservation belongs to another visit.');
  let unchanged = false;
  if (action === 'reserve') {
    // Even semantic retries need current, verified payment entitlement.
    if (grant.paymentState !== 'verified') throw fail('payment_review', 'The purchased package needs payment review.');
    if (grant.expiresAt !== null && time(grant.expiresAt) <= time(now)) throw fail('expired', 'The purchased package has expired.');
    if (row) {
      if (row.status !== 'reserved' || row.expiresAt !== expiresAt) throw fail('reservation_conflict', 'This reservation has already changed.');
      if (row.expiresAt !== null && time(row.expiresAt) <= time(now)) throw fail('expired', 'This reservation has expired.');
      unchanged = true;
    } else {
      if (next.grants.some(g => g.reservations.some(r => r.jobId === jobId))) throw fail('visit_conflict', 'This visit already has a reload reservation.');
      if (countUsed(grant) >= grant.units) throw fail('exhausted', 'No purchased visits remain.');
      if (policy.reservationExpiry === 'explicit' ? !Number.isFinite(time(expiresAt)) || time(expiresAt) <= time(now) || (grant.expiresAt !== null && time(expiresAt) > time(grant.expiresAt)) : expiresAt !== null) throw fail('expiry_required', 'Use the confirmed reservation expiry rule.', 400);
      if (grant.reservations.length >= 1000) throw fail('unavailable', 'Reload reservations need review.');
      row = { id: reservationId, jobId, status: 'reserved', reservedAt: now, expiresAt, policyVersion: version };
      grant.reservations.push(row);
    }
  } else {
    if (!row) throw fail('not_found', 'This reservation is unavailable.', 404);
    const disposition = action === 'expire' ? policy.expiration : policy.cancellation;
    const desired = action === 'complete' ? 'consumed' : disposition === 'release' ? 'released' : disposition === 'forfeit' ? 'forfeited' : 'review';
    if (row.status === desired && desired !== 'review') unchanged = true;
    else {
      if (TERMINAL.has(row.status)) throw fail('reservation_conflict', 'This reservation has already finished.');
      if (action === 'complete') {
        if (!completionConfirmed) throw fail('completion_required', 'Verify canonical visit completion before consuming a credit.');
        if (grant.paymentState !== 'verified') throw fail('payment_review', 'The purchased package needs payment review.');
        if (grant.expiresAt !== null && time(grant.expiresAt) <= time(now)) throw fail('expired', 'The purchased package has expired.');
        if (row.expiresAt !== null && time(row.expiresAt) <= time(now)) throw fail('expired', 'This reservation has expired.');
      } else if (!cancellationConfirmed) throw fail('cancellation_required', 'Cancel the canonical visit atomically before releasing its reservation.');
      if (action === 'expire' && (row.expiresAt === null || time(row.expiresAt) > time(now))) throw fail('not_expired', 'This reservation has not expired.');
      if (desired === 'review') throw fail('cancellation_review', 'An authorized reviewer must decide this cancellation.');
      // A refund/dispute may affect past consumption. Never automatically
      // release or forfeit a credit whose funding is under review.
      if (grant.paymentState !== 'verified') throw fail('payment_review', 'The purchased package needs payment review.');
      row.status = desired; row.finishedAt = now;
    }
  }
  const result = { accountId, grantId, reservationId, jobId, status: row.status, unchanged };
  if (!account.revision) throw fail('unavailable', 'Reload credit revision is unavailable.');
  return { result, writes: [
    ...(unchanged ? [{ collection: COLLECTION, id: accountId, revision: account.revision, verify: true }] : [{ collection: COLLECTION, id: accountId, revision: account.revision, patch: { grants: next.grants, updatedAt: now } }]),
    { collection: RECEIPTS, id: requestId, exists: false, data: { customerId: actor.customerId, payload, result, createdAt: now } },
  ] };
}
