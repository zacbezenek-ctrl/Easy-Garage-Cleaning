/* Commission, pay periods and payroll rows for canvassing reps.
   Each sale keeps the terms it was booked under. Current terms (knock-completed-v4, owner decision 2026-10-30) earn
   when the job is completed and paid in full, and take a refunded or cancelled share back on the next pay period's
   statement; knock-collected-v3 sales earn on full collection; older signed terms retain their original timing.
   The accelerator applies to the part of a rep's collected revenue above the monthly threshold,
   counted in the order payments were collected (calendar month in the company time zone). */
import { addDays, validDate, zonedDate } from './knock-time.js';
import { PACKAGES } from './knock-settings.js';

const money = value => Math.round(Number(value || 0) * 100) / 100;
const ms = value => (typeof value === 'number' ? value : Date.parse(value));
const TERM_FIELDS = ['rate', 'acceleratorEnabled', 'acceleratorThreshold', 'acceleratorRate', 'leadOverrideEnabled', 'leadOverrideRate'];

// Owner-set channel percentages (2026-10-17) of the full garage job including goods: a
// direct D2D close 25%; a D2D-set walkthrough 13% to the setter plus 7% to the estimator
// (20% total); a direct walkthrough 7% to the estimator. Junk earns nothing and channels
// never stack. Whole percents keep allocation arithmetic exact (knock-allocations.js).
export const CHANNEL_PERCENTS = Object.freeze({ directSale: 25, setter: 13, estimator: 7 });
// A walkthrough-setting or estimator share is paid through the statement of the pay period it is earned in when its
// source (the setter record, or the signed handoff of a direct walkthrough sale) is at most this many days older than
// that period's start; the statement reads no older sources (functions/_lib/estimator-commission.js), so an older one
// is held for review wherever it shows (periodStatement, the estimator's own view).
export const CHANNEL_LOOKBACK_DAYS = 365;
// Owner decision 2026-10-30: a quote saved from a walkthrough and approved (online, or as the office recorded it) within
// this many days of the walkthrough pays exactly as if it had been signed there; approved later, it pays no commission.
export const ONLINE_APPROVAL_DAYS = 30;

const percentText = rate => `${Math.round(Number(rate) * 1000) / 10}%`;
// The only base rate the door-to-door contracts can approve (knock-admin.js approveCompensation).
const CONTRACT_RATE = 0.25;
// The door-to-door contract the owner approves now (DOOR_CONTRACT, owner decision 2026-10-30: earned at job completion,
// refunds and cancellations after that taken back), and the one before it, which approvals and sales already made keep.
export const DOOR_CONTRACT_V3 = 'knock-collected-v3', DOOR_CONTRACT = 'knock-completed-v4';
const COLLECTED_CONTRACTS = [DOOR_CONTRACT_V3, DOOR_CONTRACT];

/* The one statement of the current direct-sale earning rule that reps read, on the Help
   sheet and on My money. Unapproved terms are never presented as a pay promise, and a
   saved rate the contract cannot approve is never shown as the planned rate. */
export function commissionRuleText(commission) {
  const rate = commission?.rate ?? CONTRACT_RATE;
  const share = rate === CONTRACT_RATE ? `${percentText(rate)} of each eligible garage sale` : 'Commission on each eligible garage sale at the approved rate';
  // The approved contract's rule (knock-collected-v3 approvals keep theirs); before an approval, the current contract's.
  const rule = commission?.verified === true && commission.contract !== DOOR_CONTRACT
    ? `${share}, earned once the customer has paid the full price (a deposit alone does not count), with payouts every two weeks. A final payment that comes up short, a refund or a cancellation is held for review.`
    : `${share}, earned on the day the job is completed once the customer has paid the full price (a deposit alone does not count), with payouts every two weeks. A final payment that comes up short is held for review; a refund or cancellation after that takes its share back (all of it when cancelled) on the next pay period's statement.`;
  if (commission?.verified !== true) return `Not approved yet: nothing is earned or payable until the owner approves the terms, and the saved rate is not a pay promise. Planned once approved: ${rule}`;
  return `${rule} Sales booked under older terms keep their own rules.`;
}

export const SETTER_RULE_TEXT = `${CHANNEL_PERCENTS.setter}% to you when a walkthrough you set closes (signed there, or its quote approved within ${ONLINE_APPROVAL_DAYS} days) and the job is done and paid in full; the estimator gets ${CHANNEL_PERCENTS.estimator}% (${CHANNEL_PERCENTS.setter + CHANNEL_PERCENTS.estimator}% total). Booking or a no-show earns nothing, and amounts stay on hold until finance confirms the recipients, base and pay cycle. It is never added to the ${CHANNEL_PERCENTS.directSale}% direct-sale rate.`;

/* The appointment-setter and estimator terms the owner approves as one contract (knock-admin.js approveSetterTerms):
   fixed values, never settings. A walkthrough a door-to-door rep set pays 13% to the rep and 7% to its estimator, a
   walkthrough an estimator sells directly 7%, of the job's whole collected price including goods, rounded to the
   nearest cent, paid every two weeks with the door-to-door commission, whose approval it needs. Junk removal earns
   nothing and channels never stack.
   knock-setter-v2 (SETTER_CONTRACT, owner decision 2026-10-30), the terms approved from now on: a share is earned on the
   day the job is completed once it is paid in full (or at the approval, or the office's later record, when later); a
   quote saved from the walkthrough and approved within ONLINE_APPROVAL_DAYS of it pays exactly as if signed there (its
   estimator is the one who did the walkthrough), and one approved later pays nothing; a short or excess payment is held
   for review; a refund or cancellation after a share was earned takes back the refunded part of it (all of it when
   cancelled) on the next pay period's statement, never more than was earned.
   knock-setter-v1 (SETTER_CONTRACT_V1, D6b, 2026-10-17), which an approval made before keeps until the owner approves
   v2, and whose shares earned before that approval keep their time: earned once the job is closed and paid in full;
   only a signed walkthrough handoff pays; a refund or cancellation is held for review. Under both a signed walkthrough
   handoff for a garage transformation is garage work and its signer is the estimator, unless the office recorded
   otherwise. */
export const SETTER_CONTRACT_V1 = 'knock-setter-v1', SETTER_CONTRACT = 'knock-setter-v2';
export const SETTER_TERMS_V1 = Object.freeze({ setterPercent: CHANNEL_PERCENTS.setter, estimatorPercent: CHANNEL_PERCENTS.estimator, directEstimatorPercent: CHANNEL_PERCENTS.estimator,
  calculationBase: 'collected_job_total_including_goods', earnedOn: 'closed_and_paid_in_full', rounding: 'nearest_cent', payoutCadence: 'biweekly',
  serviceScope: 'garage_only_signed_handoff_or_office', estimatorAttribution: 'office_recorded_else_handoff_signer',
  partialCollections: 'review_required', refunds: 'review_required', stacking: false });
export const SETTER_TERMS = Object.freeze({ setterPercent: CHANNEL_PERCENTS.setter, estimatorPercent: CHANNEL_PERCENTS.estimator, directEstimatorPercent: CHANNEL_PERCENTS.estimator,
  calculationBase: 'collected_job_total_including_goods', earnedOn: 'job_completed_and_paid_in_full', rounding: 'nearest_cent', payoutCadence: 'biweekly',
  serviceScope: 'garage_only_signed_or_approved_quote_or_office', estimatorAttribution: 'office_recorded_else_handoff_signer_else_walkthrough_estimator',
  approvedQuotes: `walkthrough_quote_approved_within_${ONLINE_APPROVAL_DAYS}_days`, partialCollections: 'review_required', refunds: 'clawback_next_period', stacking: false });
const SETTER_TERMS_BY_CONTRACT = { [SETTER_CONTRACT_V1]: SETTER_TERMS_V1, [SETTER_CONTRACT]: SETTER_TERMS };

// Exactly the fixed terms of that contract (the current one by default).
export function validSetterTerms(terms, contract = SETTER_CONTRACT) {
  const want = SETTER_TERMS_BY_CONTRACT[contract];
  return Boolean(want && terms) && typeof terms === 'object' && !Array.isArray(terms) && Object.keys(terms).length === Object.keys(want).length &&
    Object.entries(want).every(([key, value]) => Object.hasOwn(terms, key) && terms[key] === value);
}

// The setter rule a rep reads on My money, once the owner approved the setter terms (setter: {verified, contract}).
export function setterRuleText(setter) {
  if (setter?.verified !== true) return SETTER_RULE_TEXT;
  if (setter.contract === SETTER_CONTRACT_V1) return `${CHANNEL_PERCENTS.setter}% to you when a walkthrough you set closes and the customer pays the whole price, goods included; the estimator gets ${CHANNEL_PERCENTS.estimator}% (${CHANNEL_PERCENTS.setter + CHANNEL_PERCENTS.estimator}% total). It is earned once the job is paid in full, rounded to the cent and paid every two weeks. Booking, a no-show or junk removal earns nothing, and a short payment, refund or cancellation is held for review. It is never added to the ${CHANNEL_PERCENTS.directSale}% direct-sale rate.`;
  return `${CHANNEL_PERCENTS.setter}% to you when a walkthrough you set is sold (signed there, or its quote approved within ${ONLINE_APPROVAL_DAYS} days of it) and the customer pays the whole price, goods included; the estimator gets ${CHANNEL_PERCENTS.estimator}% (${CHANNEL_PERCENTS.setter + CHANNEL_PERCENTS.estimator}% total). It is earned on the day the job is completed once it is paid in full, rounded to the cent and paid every two weeks. Booking, a no-show, junk removal or a quote approved later earns nothing; a short payment is held for review, and a refund or cancellation after it was earned takes its share back on the next pay period's statement. It is never added to the ${CHANNEL_PERCENTS.directSale}% direct-sale rate.`;
}

// The only collection policies and scope the door-to-door contracts accept: knock-completed-v4 (DOOR_CONTRACT) from now
// on, knock-collected-v3 for the approvals and sales made under it. The owner's approval screen shows these exact
// values; they are not adjustable settings.
export const COLLECTED_V3_POLICY = Object.freeze({ earnedOn: 'customer_collection', payoutCadence: 'biweekly',
  calculationBase: 'eligible_collected_amount', attribution: 'recorded_rep', partialCollections: 'review_required', refunds: 'review_required' });
export const COMPLETED_V4_POLICY = Object.freeze({ earnedOn: 'job_completion', payoutCadence: 'biweekly',
  calculationBase: 'eligible_collected_amount', attribution: 'recorded_rep', partialCollections: 'review_required', refunds: 'clawback_next_period' });
export const D2D_GARAGE_SCOPE = Object.freeze({ service: 'garage_only', channel: 'door_to_door', estimatorStacking: false });
const DOOR_POLICIES = { [DOOR_CONTRACT_V3]: COLLECTED_V3_POLICY, [DOOR_CONTRACT]: COMPLETED_V4_POLICY };

// The policy of that contract (knock-collected-v3 by default), value for value.
export function validCollectionPolicy(policy, contract = DOOR_CONTRACT_V3) {
  const want = DOOR_POLICIES[contract];
  return Boolean(want) && Object.entries(want).every(([key, value]) => policy?.[key] === value);
}

// Package names alone do not prove which part of a job is garage work. Finance
// must explicitly classify whole-ticket garage packages; mixed/unknown work is held.
export function validCommissionScope(scope) {
  const garage = scope?.garageOnlyPackages, junk = scope?.junkRemovalPackages;
  return scope?.service === 'garage_only' && scope.channel === 'door_to_door' && scope.estimatorStacking === false &&
    Array.isArray(garage) && garage.length > 0 && Array.isArray(junk) &&
    [...garage, ...junk].every(name => PACKAGES.includes(name)) &&
    new Set([...garage, ...junk]).size === garage.length + junk.length;
}

export function commissionEligibility(sale) {
  const terms = sale?.commissionTerms;
  if (terms?.contract === 'knock-v1') return 'legacy';
  if (!['knock-garage-v2', ...COLLECTED_CONTRACTS].includes(terms?.contract) || !validCommissionScope(terms.scope) || terms.package !== sale.package) return 'unverified';
  return terms.scope.junkRemovalPackages.includes(sale.package) ? 'excluded'
    : terms.scope.garageOnlyPackages.includes(sale.package) ? 'garage' : 'unverified';
}

// Created only by the server when booking under an evidenced contract. Current
// settings must never replace the terms captured on an older sale.
export function snapshotCommissionTerms(commission, soldAt, packageName) {
  // The contract the owner approved (knock-access.js loadSettings); an approval that names none is knock-collected-v3.
  const contract = COLLECTED_CONTRACTS.includes(commission?.contract) ? commission.contract : DOOR_CONTRACT_V3;
  if (commission?.verified !== true || commission.rate !== 0.25 || !PACKAGES.includes(packageName) || !Number.isFinite(ms(commission.approvedAt)) || !validCommissionScope(commission.scope) || !validCollectionPolicy(commission.collectionPolicy, contract)) return null;
  // A delayed offline sale cannot silently inherit a policy approved later.
  if (soldAt != null && (!Number.isFinite(ms(soldAt)) || ms(soldAt) < ms(commission.approvedAt))) return null;
  return { contract, approvedAt: commission.approvedAt, package: packageName,
    scope: structuredClone(commission.scope), collectionPolicy: structuredClone(commission.collectionPolicy),
    policy: Object.fromEntries(TERM_FIELDS.map(key => [key, commission[key]])) };
}

function saleTerms(sale, commission) {
  const terms = sale?.commissionTerms;
  if (terms != null) {
    const p = terms.policy;
    if (!['knock-v1', 'knock-garage-v2', ...COLLECTED_CONTRACTS].includes(terms.contract) || !Number.isFinite(ms(terms.approvedAt)) ||
      !Number.isFinite(ms(sale.soldAt)) || ms(sale.soldAt) < ms(terms.approvedAt) ||
      !['rate', 'acceleratorRate', 'leadOverrideRate'].every(key => typeof p?.[key] === 'number' && p[key] >= 0 && p[key] <= 1) ||
      !['acceleratorEnabled', 'leadOverrideEnabled'].every(key => typeof p?.[key] === 'boolean') ||
      !Number.isFinite(p?.acceleratorThreshold) || p.acceleratorThreshold <= 0) return null;
    if (COLLECTED_CONTRACTS.includes(terms.contract) && !validCollectionPolicy(terms.collectionPolicy, terms.contract)) return null;
    if (terms.contract !== 'knock-v1') {
      if (p.rate !== 0.25) return null;
      const eligibility = commissionEligibility(sale);
      if (eligibility === 'unverified') return null;
      if (eligibility === 'excluded') return { ...p, rate: 0, acceleratorEnabled: false, leadOverrideEnabled: false };
    }
    return p;
  }
  // Arithmetic-only callers can exercise the legacy calculator. Server reports
  // always supply verified true/false and never use this fallback for history.
  return commission?.verified === undefined ? commission : null;
}

export function collectedAmount(sale) {
  return customerCollection(sale).gross ?? 0;
}

// The final collection snapshot includes any deposit; never add them together.
// These are recorded receipts, not a bank reconciliation or a payment to a rep.
export function customerCollection(sale) {
  const amount = value => value !== null && value !== undefined && value !== '' &&
    Number.isFinite(Number(value)) && Number(value) >= 0 ? money(value) : null;
  const final = amount(sale?.collectedAmount);
  const deposit = sale?.handoff?.deposit;
  const gross = final ?? (deposit?.status === 'collected' && ['admin', 'stripe'].includes(deposit.verifiedBy)
    ? amount(deposit.collectedAmount) : null);
  const refunded = sale?.refundedAmount == null ? 0 : amount(sale.refundedAmount);
  const at = final !== null ? sale?.paidAt : deposit?.collectedAt;
  return { gross, refunded, net: gross !== null && refunded !== null && refunded <= gross ? money(gross - refunded) : null,
    at: Number.isFinite(ms(at)) ? at : null, source: final !== null ? 'admin_recorded_snapshot' : gross !== null ? `${deposit.verifiedBy}_deposit` : 'missing',
    settlement: 'not_reconciled' };
}

function collectionEvents(sale) {
  const history = sale.collectionHistory;
  if (!Array.isArray(history) || !history.length) {
    const { gross, at } = customerCollection(sale);
    return gross !== null && at ? [{ amount: gross, at }] : [];
  }
  const first = history[0];
  return [
    ...(first?.previousTotal > 0 && first?.previousAt ? [{ amount: first.previousTotal, at: first.previousAt }] : []),
    ...history.map(event => ({ amount: money(event?.total - event?.previousTotal), at: event?.at })),
  ].filter(event => Number.isFinite(event.amount) && event.amount >= 0 && Number.isFinite(ms(event.at)));
}

/* Receipts below the ticket with evidence that the closing collection happened: a 'paid'
   status, or a receipt recorded at or after the job's completion. A finished job whose only
   receipts predate completion (usually the sale-day deposit) is awaiting its balance, not
   short. A finished job with no usable completion or receipt time is held, not assumed. */
function shortFinalCollection(sale, payment) {
  if (!(money(payment.gross) < money(sale?.ticket))) return false;
  if (sale.status === 'paid') return true;
  const completed = ms(sale.completedAt);
  if (!Number.isFinite(completed)) return sale.status === 'completed';
  return !payment.at || ms(payment.at) >= completed;
}

/* knock-completed-v4: when the job was completed and paid in full (the later of the two), by the sale's own evidence,
   or null. The commission is earned then, unless something holds it (commissionIssues). */
function completedPaidAt(sale) {
  const payment = customerCollection(sale), done = ms(sale?.completedAt);
  return payment.gross > 0 && money(payment.gross) === money(sale.ticket) && payment.at && Number.isFinite(done) ? Math.max(ms(payment.at), done) : null;
}
/* knock-completed-v4: a refund and a cancellation dated after the sale was completed and paid in full, the ones its
   commission is taken back for (saleClawbacks) instead of being held: {refund: {amount, at}, cancellation: {at}}. A
   refund above what was collected, or one before, holds the sale for review as under earlier terms. */
function clawbackEvents(sale) {
  const earned = sale?.commissionTerms?.contract === DOOR_CONTRACT ? completedPaidAt(sale) : null;
  if (earned === null) return {};
  const payment = customerCollection(sale), after = value => datable(value) && ms(value) > earned;
  return { refund: payment.refunded > 0 && payment.refunded <= payment.gross && after(sale.refundedAt) ? { amount: payment.refunded, at: ms(sale.refundedAt) } : null,
    cancellation: sale.status === 'cancelled' && after(sale.cancelledAt) ? { at: ms(sale.cancelledAt) } : null };
}

export function commissionIssues(sale, commission) {
  const payment = customerCollection(sale), issues = [];
  const contract = sale?.commissionTerms?.contract, collectedTerms = COLLECTED_CONTRACTS.includes(contract), clawed = clawbackEvents(sale);
  if (['knock-garage-v2', ...COLLECTED_CONTRACTS].includes(contract) && commissionEligibility(sale) === 'unverified') issues.push('commission_scope_unverified');
  if ((sale?.commissionTerms != null || commission?.verified === true) && !saleTerms(sale, commission)) issues.push('commission_terms_missing_or_invalid');
  if (sale?.status === 'paid') {
    if (!collectedTerms && (!sale.completedAt || !Number.isFinite(ms(sale.completedAt)))) issues.push('completion_unverified');
    if (!sale.paidAt || !Number.isFinite(ms(sale.paidAt)) || payment.gross === null) issues.push('collection_unverified');
    if (payment.gross !== null && money(payment.gross) !== money(sale.ticket)) issues.push('partial_or_excess_collection');
    if (!collectedTerms && !Number.isFinite(ms(sale.cancelEndsAt))) issues.push('cancellation_deadline_missing');
  }
  if (collectedTerms && payment.gross > 0) {
    if (!payment.at) issues.push('collection_unverified');
    // Collected terms earn only at full collection, so receipts below the ticket are not
    // earned yet: the sale-day deposit, a running total, or a finished job still awaiting
    // its balance. Only an overpayment or a short final collection needs the unapproved
    // partial-collection policy (see shortFinalCollection).
    if (money(payment.gross) > money(sale.ticket) || shortFinalCollection(sale, payment)) issues.push('partial_collection_policy_unconfigured');
  }
  if (payment.refunded === null || payment.refunded > 0 && !clawed.refund) issues.push('refund_review');
  if (sale?.collectionHistory != null) {
    const history = sale.collectionHistory;
    if (!Array.isArray(history) || history.some((event, i) => !Number.isFinite(event?.total) || !Number.isFinite(event?.previousTotal) ||
      event.total < event.previousTotal || !Number.isFinite(ms(event.at)) ||
      (i > 0 && event.previousTotal !== history[i - 1].total)) ||
      (history.length && history.at(-1).total !== payment.gross)) issues.push('collection_history_invalid');
  }
  const wasCancelled = sale?.status === 'cancelled' || sale?.statusHistory?.some(event => event?.status === 'cancelled');
  if (wasCancelled && (payment.gross > 0 || sale.completedAt) && !clawed.cancellation) issues.push('cancellation_review');
  // knock-completed-v4 earns at completion: a job reopened after it was completed is held, never silently un-earned.
  if (contract === DOOR_CONTRACT && !sale.completedAt && sale.statusHistory?.some(event => ['completed', 'paid'].includes(event?.status))) issues.push('completion_review');
  return issues;
}

const unique = rows => [...new Map(rows.map((row, i) => [row.id || `row-${i}`, row])).values()];

// The instant commission becomes earned, or null if it is not (yet) earned.
export function earnedAt(sale) {
  if (commissionEligibility(sale) === 'excluded' || commissionIssues(sale).length) return null;
  if (sale?.commissionTerms?.contract === DOOR_CONTRACT) return completedPaidAt(sale);
  if (sale?.commissionTerms?.contract === 'knock-collected-v3') {
    const payment = customerCollection(sale);
    return payment.gross > 0 && money(payment.gross) === money(sale.ticket) && payment.at ? ms(payment.at) : null;
  }
  if (sale?.status !== 'paid') return null;
  const times = [ms(sale.paidAt), ms(sale.completedAt), ms(sale.cancelEndsAt)];
  return times.every(Number.isFinite) ? Math.max(...times) : null;
}

export function isEarned(sale, now = Date.now()) {
  const at = earnedAt(sale);
  return at != null && now >= at;
}

/* Commission on `amount` of collected revenue when `running` was already collected this month:
   the base rate up to the accelerator threshold, the accelerator rate above it. */
export function tieredCommission(running, amount, commission) {
  const rate = Number(commission?.rate ?? 0.25);
  if (commission?.acceleratorEnabled === false) return { base: money(amount * rate), accelerator: 0 };
  const threshold = Number(commission?.acceleratorThreshold ?? 8000);
  const below = Math.max(0, Math.min(amount, threshold - running));
  return { base: money(below * rate), accelerator: money((amount - below) * Number(commission?.acceleratorRate ?? 0.3)) };
}

/* Commission per earned sale. Returns [{ saleId, repKey, month, collected, base, accelerator, total, earnedAt }]. */
export function saleCommissions(sales, commission, { now = Date.now(), timeZone = 'America/Denver' } = {}) {
  if (commission?.verified === false) return [];
  const groups = new Map();
  for (const sale of unique(sales || [])) {
    if (!isEarned(sale, now) || !saleTerms(sale, commission) || commissionEligibility(sale) === 'excluded') continue;
    const month = zonedDate(ms(sale.paidAt), timeZone).slice(0, 7);
    const key = `${sale.repKey}|${month}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sale);
  }
  const rows = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (ms(a.paidAt) - ms(b.paidAt)) || String(a.id).localeCompare(String(b.id)));
    let running = 0;
    for (const sale of group) {
      const collected = collectedAmount(sale);
      const { base, accelerator } = tieredCommission(running, collected, saleTerms(sale, commission));
      running += collected;
      rows.push({
        saleId: sale.id, repKey: sale.repKey, month: zonedDate(ms(sale.paidAt), timeZone).slice(0, 7),
        collected: money(collected), base, accelerator, total: money(base + accelerator), earnedAt: earnedAt(sale),
      });
    }
  }
  return rows;
}

// Commission on one rep's collected revenue for a whole calendar month.
export function monthlyCommission(collected, commission) {
  const { base, accelerator } = tieredCommission(0, Number(collected || 0), commission);
  return money(base + accelerator);
}

/* Lead override: a share of each team member's collected revenue, paid to the lead recorded on
   the sale when it was booked. The lead's own sales earn ordinary commission, not an override. */
export function leadOverrides(sales, commission, { now = Date.now() } = {}) {
  if (commission?.verified === false) return [];
  return unique(sales || [])
    .filter(sale => sale.leadKey && sale.leadKey !== sale.repKey && isEarned(sale, now) && saleTerms(sale, commission)?.leadOverrideEnabled)
    .map(sale => ({ saleId: sale.id, leadKey: sale.leadKey, repKey: sale.repKey, amount: money(collectedAmount(sale) * saleTerms(sale, commission).leadOverrideRate), earnedAt: earnedAt(sale) }));
}

/* knock-completed-v4 (owner decision 2026-10-30): a refund or a cancellation after a sale's commission was earned takes
   that share back: the refunded part of what was collected (all of it when cancelled), rounded half up to the cent and
   never more than was earned, from the rep and from the lead's override alike. Each is a negative line the statement
   counts in the pay period after the refund or cancellation (periodStatement):
   [{ saleId, repKey, role: 'rep'|'lead', amount (negative), at (ms), reason: 'refund'|'cancellation' }]. */
export function saleClawbacks(sales, commission, { now = Date.now(), timeZone = 'America/Denver' } = {}) {
  if (commission?.verified === false) return [];
  const all = unique(sales || []), list = all.filter(sale => sale?.commissionTerms?.contract === DOOR_CONTRACT);
  if (!list.length) return [];
  // Each sale's commission as the statement earned it (the monthly accelerator counts every sale of the rep's month).
  const earned = new Map(saleCommissions(all, commission, { now, timeZone }).map(row => [row.saleId, row.total]));
  const overrides = new Map(leadOverrides(all, commission, { now }).map(row => [row.saleId, row.amount]));
  const lines = [];
  for (const sale of list) {
    if (!earned.has(sale.id)) continue;
    const { refund, cancellation } = clawbackEvents(sale), grossCents = Math.round(customerCollection(sale).gross * 100);
    const events = [refund && { ...refund, reason: 'refund' }, cancellation && { ...cancellation, reason: 'cancellation' }].filter(event => event && event.at <= now).sort((a, b) => a.at - b.at);
    for (const [role, repKey, total] of [['rep', sale.repKey, earned.get(sale.id)], ...(overrides.has(sale.id) ? [['lead', sale.leadKey, overrides.get(sale.id)]] : [])]) {
      const cents = Math.round(total * 100);
      let taken = 0;
      for (const event of events) {
        const want = event.reason === 'cancellation' ? cents : Math.floor((2 * cents * Math.round(event.amount * 100) + grossCents) / (2 * grossCents));
        const amount = Math.min(cents, want) - taken;
        if (amount > 0) { lines.push({ saleId: sale.id, repKey, role, amount: -amount / 100, at: event.at, reason: event.reason }); taken += amount; }
      }
    }
  }
  return lines;
}

// Commission a booked sale would pay at the base rate (for "pending").
export const projectedCommission = (sale, commission) => commission?.verified === false || !saleTerms(sale, commission) ? null : sale?.status === 'cancelled' ? 0 : money(Number(sale?.ticket || 0) * Number(saleTerms(sale, commission).rate));

/* ---- Pay periods ---- */

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

function lastDayOfMonth(date) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// The pay period containing a date: { key, start, end } (inclusive dates).
function calculatePayPeriod(date, payroll) {
  if (!validDate(date)) return null;
  const period = payroll?.period || 'biweekly';
  if (period === 'monthly') {
    const start = date.slice(0, 8) + '01';
    return { key: `${start}_${lastDayOfMonth(date)}`, start, end: lastDayOfMonth(date) };
  }
  if (period === 'semimonthly') {
    const day = Number(date.slice(8, 10));
    const start = date.slice(0, 8) + (day <= 15 ? '01' : '16');
    const end = day <= 15 ? date.slice(0, 8) + '15' : lastDayOfMonth(date);
    return { key: `${start}_${end}`, start, end };
  }
  const length = period === 'weekly' ? 7 : 14;
  const anchor = validDate(payroll?.anchorDate) ? payroll.anchorDate : '2026-10-05';
  const offset = Math.floor(daysBetween(anchor, date) / length) * length;
  const start = addDays(anchor, offset);
  const end = addDays(start, length - 1);
  return { key: `${start}_${end}`, start, end };
}

export function payPeriodFor(date, payroll) {
  const period = calculatePayPeriod(date, payroll);
  return period && payroll?.anchorVerified === false ? { ...period, configured: false } : period;
}

export function previousPayPeriod(period, payroll) {
  return payPeriodFor(addDays(period.start, -1), payroll);
}

const inPeriod = (date, period) => Boolean(date && period && date >= period.start && date <= period.end);
const datable = value => value != null && value !== '' && Number.isFinite(ms(value));

// Calendar dates on which a sale changed: sold, each receipt, the deposit, completion,
// payment, refund, cancellation and every status change. Older signed terms also earn at
// the cancellation deadline, so that date counts for them.
function activityDates(sale, timeZone) {
  const history = list => (Array.isArray(list) ? list : []);
  const deadline = COLLECTED_CONTRACTS.includes(sale.commissionTerms?.contract) ? null : sale.cancelEndsAt;
  const instants = [sale.soldAt, sale.paidAt, sale.completedAt, sale.refundedAt, sale.cancelledAt, deadline, sale.handoff?.deposit?.collectedAt,
    ...collectionEvents(sale).map(event => event.at), ...history(sale.collectionHistory).flatMap(event => [event?.at, event?.previousAt]),
    ...history(sale.statusHistory).map(event => event?.at)];
  const dates = instants.filter(datable).map(value => zonedDate(ms(value), timeZone));
  if (validDate(sale.saleDate)) dates.push(sale.saleDate);
  return [...new Set(dates.filter(Boolean))];
}

/* A refund or cancellation under review with no usable date. Refund fields arrive from
   outside Knock, so the adjustment it may need could land in any period, the current one
   included; it holds them all until finance dates it. */
function undatedAdjustment(sale, issues) {
  if (issues.includes('refund_review') && !datable(sale.refundedAt)) return true;
  const history = Array.isArray(sale.statusHistory) ? sale.statusHistory : [];
  return issues.includes('cancellation_review') && !datable(sale.cancelledAt) && !history.some(event => event?.status === 'cancelled' && datable(event.at));
}

/* Whether a sale's unresolved review reasons hold this period's totals. They do when the
   sale changed inside the period, or when it (or its refund or cancellation) cannot be dated.
   With a monthly accelerator, a receipt also shifts the tier of the rep's later receipts that
   month, so it holds every period from that receipt to the end of its calendar month. Another
   period's unrelated problem never blanks a period whose own sales are complete. */
function reviewScope(sale, issues, period, timeZone, tiered) {
  const dates = activityDates(sale, timeZone);
  const direct = !dates.length || undatedAdjustment(sale, issues) || dates.some(date => inPeriod(date, period));
  if (direct || !tiered) return { rep: direct, lead: direct };
  const receipts = [sale.paidAt, ...collectionEvents(sale).map(event => event.at)].filter(datable).map(value => zonedDate(ms(value), timeZone)).filter(Boolean);
  return { rep: receipts.some(date => period.end >= date && period.start <= lastDayOfMonth(date)), lead: false };
}

/* Per rep for one pay period:
   booked   - revenue of sales sold in the period that are not cancelled
   pending  - base-rate commission on those sales that is not earned yet
   earned   - commission (incl. accelerator) that became earned in the period
   override - lead override that became earned in the period
   paid     - payouts recorded against the period
   Review reasons come only from sales that touch the period (see reviewScope).
   channels - only once the owner approved the setter terms (SETTER_TERMS): the appointment-setter and estimator shares
              earned so far, [{repKey, role:'setter'|'estimator'|'direct_rep', amount, earnedAt (ms), name?, share?, sourceAt?}].
              Each adds to its recipient's earned commission in the period it was earned, and every row then also has
              setterCommission and estimatorCommission (and doorWalkthroughCommission once any 'direct_rep' share, a
              walkthrough a rep ran themselves at the door, REP-WALKTHROUGH, is among them). A share whose sourceAt (ms, or null when unknown) is more than
              CHANNEL_LOOKBACK_DAYS before the period's start is not counted and holds its recipient
              (statement_lookback_exceeded). channelReview: reasons that hold every row (the shares could not all be
              read). channelHolds: [{repKey, reasons, dates?, from?, all?}] hold one recipient's row in the periods
              holding one of dates, every period ending on or after from, or every period (all).
              A payout recorded with channelItems (knock-reports.js addPayout: the shares it paid, by share =
              jobId:role) holds its recipient's row (channel_share_changed) when one of them is no longer earned in
              that period by that recipient at that amount, and holds any row where a share it paid is earned again
              (another period or recipient): a share that changed after it was paid needs finance, never a silent
              move or a second payment. Recorded payments above the period's earnings hold the row too
              (payout_exceeds_earned). A channel item with kind 'clawback' (estimator-commission.js channelLedger: a
              share taken back for a refund or cancellation after it was earned, a negative amount already placed in
              the pay period after it) subtracts like any share.
              Without channels the statement is exactly what it was.
   clawback - once any share is taken back (a channel clawback, or a knock-completed-v4 sale's, saleClawbacks, counted
              in the pay period after its refund or cancellation): the negative total in this period, with each line in
              clawbacks [{ref, role, reason, amount, eventDate}]. A period whose clawbacks leave it below zero is held
              (clawback_exceeds_earned): finance settles the rest. */
export function periodStatement({ sales = [], payouts = [], training = [], reps = [], settings, period, now = Date.now(), timeZone = 'America/Denver', channels = null, channelReview = [], channelHolds = [] }) {
  sales = unique(sales);
  payouts = unique(payouts);
  const commission = settings?.commission || {};
  const trainingRate = Number(settings?.payroll?.trainingHourlyRate ?? 15.16);
  const commissions = saleCommissions(sales, commission, { now, timeZone });
  const overrides = leadOverrides(sales, commission, { now });
  const clawbacks = saleClawbacks(sales, commission, { now, timeZone }), previous = previousPayPeriod(period, settings?.payroll);
  // Reps with any receipt counted under an enabled monthly accelerator.
  const tieredReps = new Set(sales.filter(sale => saleTerms(sale, commission) && saleTerms(sale, commission).acceleratorEnabled !== false).map(sale => sale.repKey));
  const byRep = new Map(), withChannels = Array.isArray(channels), doorWalks = withChannels && channels.some(item => item?.role === 'direct_rep');
  const withClawback = clawbacks.length > 0 || withChannels && channels.some(item => item?.kind === 'clawback');
  const row = (repKey, name = '') => {
    if (!byRep.has(repKey)) {
      const rep = reps.find(r => r.repKey === repKey);
      byRep.set(repKey, {
        repKey, name: rep?.displayName || name || repKey, salesBooked: 0, booked: 0, pending: 0,
        earned: 0, accelerator: 0, override: 0, paid: 0, trainingMinutes: 0, trainingPay: 0,
        projectedCommission: 0, customerCollectedRevenue: 0, customerRefundedRevenue: 0,
        collectionUnknownCount: 0, reviewReasons: [], ...(withChannels ? { setterCommission: 0, estimatorCommission: 0 } : {}), ...(doorWalks ? { doorWalkthroughCommission: 0 } : {}),
        ...(withClawback ? { clawback: 0, clawbacks: [] } : {}),
      });
    }
    return byRep.get(repKey);
  };
  for (const rep of reps) if (rep.status === 'active') row(rep.repKey);
  for (const sale of sales) {
    const r = row(sale.repKey), payment = customerCollection(sale);
    const issues = commissionIssues(sale, commission);
    // Unresolved adjustments may affect prior payouts or monthly tiers: held, never a guessed clawback (only a
    // knock-completed-v4 share is taken back, by its own rule: saleClawbacks).
    const lead = sale.leadKey && sale.leadKey !== sale.repKey ? row(sale.leadKey) : null;
    if (issues.length) {
      const scope = reviewScope(sale, issues, period, timeZone, tieredReps.has(sale.repKey));
      if (scope.rep) r.reviewReasons.push(...issues);
      if (scope.lead && lead) lead.reviewReasons.push(...issues);
    }
    for (const event of collectionEvents(sale)) {
      if (inPeriod(zonedDate(ms(event.at), timeZone), period)) r.customerCollectedRevenue = money(r.customerCollectedRevenue + event.amount);
    }
    if (payment.refunded > 0 && sale.refundedAt && inPeriod(zonedDate(ms(sale.refundedAt), timeZone), period)) {
      r.customerRefundedRevenue = money(r.customerRefundedRevenue + payment.refunded);
    }
    const soldDate = sale.saleDate || zonedDate(ms(sale.soldAt), timeZone);
    if (inPeriod(soldDate, period) && (payment.gross === null || !payment.at)) r.collectionUnknownCount += 1;
    if (!inPeriod(soldDate, period) || sale.status === 'cancelled') continue;
    r.salesBooked += 1;
    r.booked = money(r.booked + Number(sale.ticket || 0));
    r.projectedCommission = money(r.projectedCommission + (projectedCommission(sale, commission) || 0));
    if (!isEarned(sale, now)) r.pending = money(r.pending + projectedCommission(sale, commission));
  }
  for (const item of commissions) {
    if (!inPeriod(zonedDate(item.earnedAt, timeZone), period)) continue;
    const r = row(item.repKey);
    r.earned = money(r.earned + item.total);
    r.accelerator = money(r.accelerator + item.accelerator);
  }
  for (const item of overrides) {
    if (!inPeriod(zonedDate(item.earnedAt, timeZone), period)) continue;
    const r = row(item.leadKey);
    r.override = money(r.override + item.amount);
  }
  // knock-completed-v4: a share taken back for a refund or cancellation counts in the pay period after it.
  for (const line of clawbacks) {
    if (!previous || !inPeriod(zonedDate(line.at, timeZone), previous)) continue;
    const r = row(line.repKey);
    if (line.role === 'lead') r.override = money(r.override + line.amount); else r.earned = money(r.earned + line.amount);
    r.clawback = money(r.clawback + line.amount);
    r.clawbacks.push({ ref: `sale:${line.saleId}`, role: line.role, reason: line.reason, amount: line.amount, eventDate: zonedDate(line.at, timeZone) });
  }
  const windowStart = Date.parse(addDays(period.start, -CHANNEL_LOOKBACK_DAYS)), counted = [];
  for (const item of withChannels ? channels : []) {
    if (!Number.isFinite(item?.earnedAt) || !Number.isFinite(item.amount) || !inPeriod(zonedDate(item.earnedAt, timeZone), period)) continue;
    const r = row(item.repKey, item.name), key = item.role === 'setter' ? 'setterCommission' : item.role === 'direct_rep' ? 'doorWalkthroughCommission' : 'estimatorCommission';
    if (item.sourceAt !== undefined && !(item.sourceAt >= windowStart)) { r.reviewReasons.push('statement_lookback_exceeded'); continue; }
    counted.push(item);
    r[key] = money(r[key] + item.amount);
    r.earned = money(r.earned + item.amount);
    if (item.kind === 'clawback') {
      r.clawback = money(r.clawback + item.amount);
      r.clawbacks.push({ ref: item.ref ?? null, role: item.role, reason: item.reason ?? null, amount: item.amount, eventDate: item.eventDate ?? null });
    }
  }
  for (const hold of withChannels ? channelHolds : []) {
    const dated = (Array.isArray(hold?.dates) ? hold.dates : []).some(at => datable(at) && inPeriod(zonedDate(ms(at), timeZone), period));
    if (hold?.repKey && (hold.all === true || dated || datable(hold.from) && zonedDate(ms(hold.from), timeZone) <= period.end)) row(hold.repKey).reviewReasons.push(...(hold.reasons || []));
  }
  if (withChannels) {
    const cents = value => Math.round(Number(value) * 100), paid = payouts.flatMap(payout => (Array.isArray(payout.channelItems) ? payout.channelItems : []).map(item => ({ ...item, repKey: payout.repKey, periodKey: payout.periodKey })));
    for (const item of paid) {
      // Paid in this period and no longer earned here by its recipient at that amount.
      if (item.periodKey === period.key && !counted.some(live => live.repKey === item.repKey && live.share === item.share && cents(live.amount) === item.amountCents)) row(item.repKey).reviewReasons.push('channel_share_changed');
    }
    // Earned here, and already paid with another period or to another recipient.
    for (const live of counted) if (live.share && paid.some(item => item.share === live.share && (item.periodKey !== period.key || item.repKey !== live.repKey))) row(live.repKey).reviewReasons.push('channel_share_changed');
  }
  for (const payout of payouts) {
    if (payout.periodKey !== period.key) continue;
    const r = row(payout.repKey);
    r.paid = money(r.paid + Number(payout.amount || 0));
  }
  for (const log of training) {
    if (!inPeriod(log.date, period)) continue;
    const r = row(log.repKey);
    r.trainingMinutes += Number(log.minutes || 0);
  }
  for (const r of byRep.values()) {
    r.trainingPay = money(r.trainingMinutes / 60 * trainingRate);
    r.balance = money(r.earned + r.override - r.paid);
    r.commissionPaid = r.paid;
    r.commissionPaymentEvidence = 'admin_recorded_unreconciled';
    r.commissionSettled = null;
    // With the approved shares, payments recorded above what the period earned (a share that left a paid period) are
    // finance's to settle, never a silent zero.
    if (withChannels && r.balance < 0 && r.earned + r.override >= 0) r.reviewReasons.push('payout_exceeds_earned');
    // Shares taken back above what the period earned: finance settles the rest, never a silent zero or a debt.
    if (r.earned + r.override < 0) r.reviewReasons.push('clawback_exceeds_earned');
    r.reviewReasons = [...new Set([...r.reviewReasons, ...(withChannels ? channelReview : [])])];
    r.compensationState = commission.verified === false ? 'unconfigured' : r.reviewReasons.length ? 'review_required' : 'configured';
    if (commission.verified === false) {
      r.pending = r.projectedCommission = r.earned = r.accelerator = r.override = r.balance = null;
      r.trainingPay = null;
    } else if (r.reviewReasons.length) {
      // A refund does not prove historical earnings should be clawed back.
      // Keep the total unknown until finance supplies the adjustment decision.
      r.earned = r.accelerator = r.override = r.balance = null;
      if (r.reviewReasons.includes('commission_terms_missing_or_invalid')) r.projectedCommission = r.pending = null;
    }
    if (withChannels && r.earned === null) { r.setterCommission = r.estimatorCommission = null; if (doorWalks) r.doorWalkthroughCommission = null; }
    if (withClawback && r.earned === null) r.clawback = null;
    r.earnedCommission = r.earned === null ? null : money(r.earned + r.override);
    r.payableCommission = r.compensationState === 'configured' ? Math.max(0, r.balance) : null;
  }
  return [...byRep.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---- CSV ---- */

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Neutralize spreadsheet formulas in free text.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header, rows) {
  return [header, ...rows].map(cols => cols.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function commissionCsv(statement, period) {
  // A statement with the approved setter and estimator shares (periodStatement channels) adds their two columns, and one
  // with a share taken back (clawback) its own.
  const channels = statement.some(r => Object.hasOwn(r, 'setterCommission')), doorWalks = statement.some(r => Object.hasOwn(r, 'doorWalkthroughCommission')), clawed = statement.some(r => Object.hasOwn(r, 'clawback'));
  return toCsv(
    ['period_start', 'period_end', 'rep', 'username', 'sales_booked', 'booked_revenue', 'pending_commission', 'earned_commission', 'accelerator_included', 'lead_override', 'rep_payments_recorded', 'calculated_balance', 'projected_commission', 'customer_collected_revenue', 'customer_refunded_revenue', 'payable_commission', 'compensation_state', 'review_reasons', 'collection_unknown_count', 'rep_payment_evidence', 'settled_commission',
      ...(channels ? ['setter_commission_included', 'estimator_commission_included'] : []), ...(doorWalks ? ['door_walkthrough_commission_included'] : []), ...(clawed ? ['commission_clawback_included'] : [])],
    statement.map(r => [period.start, period.end, r.name, r.repKey, r.salesBooked, ...[r.booked, r.pending, r.earned, r.accelerator, r.override, r.commissionPaid, r.balance, r.projectedCommission, r.customerCollectedRevenue, r.customerRefundedRevenue, r.payableCommission].map(v => v == null ? '' : v.toFixed(2)), r.compensationState, r.reviewReasons.join(';'), r.collectionUnknownCount, r.commissionPaymentEvidence, r.commissionSettled == null ? '' : r.commissionSettled.toFixed(2),
      ...(channels ? [r.setterCommission, r.estimatorCommission].map(v => v == null ? '' : v.toFixed(2)) : []), ...(doorWalks ? [r.doorWalkthroughCommission == null ? '' : r.doorWalkthroughCommission.toFixed(2)] : []),
      ...(clawed ? [r.clawback == null ? '' : r.clawback.toFixed(2)] : [])]),
  );
}

export function trainingCsv(training, reps, period, hourlyRate) {
  const rows = training
    .filter(log => inPeriod(log.date, period))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.repKey).localeCompare(String(b.repKey)))
    .map(log => {
      const rep = reps.find(r => r.repKey === log.repKey);
      const hours = Number(log.minutes || 0) / 60;
      return [log.date, rep?.displayName || log.repKey, log.repKey, log.minutes, hours.toFixed(2), hourlyRate == null ? '' : Number(hourlyRate).toFixed(2), hourlyRate == null ? '' : money(hours * hourlyRate).toFixed(2), log.note || ''];
    });
  return toCsv(['date', 'rep', 'username', 'minutes', 'hours', 'hourly_rate', 'pay', 'note'], rows);
}
