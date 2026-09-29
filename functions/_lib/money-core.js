import { moneyCents, uniqueReceipts } from './operations-financials.js';
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { MAX_TOTAL_CENTS, customerLineItem, depositCents as quoteDepositCents, estimateFingerprint, estimateTotals, included, legacyLineItems, normalizeLineItems, quotedAmountCents, singleLineItem } from './quote-model.js';
import { billedChangeOrders, changeOrderSaved } from './change-orders.js';

/**
 * Canonical money shapes built on quote-model. Pure: no I/O; `now` is injected.
 *
 * customerMoneyTotals(job) (alias moneyStateCents) is a superset of
 * customerMoneyState/customerDepositState in customer-payments.js, in integer
 * cents: it also counts customer-approved change orders (approvedChangeTotal)
 * and keeps tips out of revenue and balance. For well-formed saved money it
 * returns exactly the legacy figures x100. Where the legacy helper coerces bad
 * money to 0, this returns null plus an issue (moneyCents semantics).
 *
 * paymentLedger(job)/paymentEntries(job) unify today's payment evidence
 * (verified Stripe sessions, the latest staff-recorded receipt and gift-credit
 * redemptions) into {id, kind, amountCents, method, processorRef, receiptUrl,
 * at, by} entries and report how much of the recorded paid total they explain.
 * Stripe receipts are merged by session AND payment intent with
 * operations-financials uniqueReceipts, exactly as the revenue report does.
 *
 * Reads never throw on saved data: money that is missing, not dollars and
 * cents, or above MAX_TOTAL_CENTS ($1,000,000) is null plus an issue. Functions
 * that do throw use money_* codes; time is always passed in (`now` is
 * required) and nothing here reads the clock. The re-exported quote-model
 * helpers normalizeLineItems/estimateTotals keep their quote_* codes.
 */

export { moneyCents, normalizeLineItems, estimateTotals, quotedAmountCents, customerLineItem, MAX_TOTAL_CENTS };
export const PAYMENT_KINDS = Object.freeze(['deposit', 'balance', 'tip', 'refund', 'offline']);
const ENTRY_FIELDS = ['id', 'kind', 'amountCents', 'method', 'processor', 'processorRef', 'receiptUrl', 'at', 'by', 'verified', 'source'];
const MAX_ENTRY_CENTS = MAX_TOTAL_CENTS;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: `money_${code}`, status });
// Saved money as whole cents, or null when unknown or above the $1,000,000 cap.
const readCents = value => { const cents = moneyCents(value); return cents === null || cents > MAX_TOTAL_CENTS ? null : cents; };
const requireNow = now => { if (now === undefined) throw fail('now_required', 'Pass the current time in; money logic never reads the clock.', 500); return now; };
const clean = (value, max = 180) => String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const receipt = value => /^https:\/\/pay\.stripe\.com\/receipts\//.test(value || '') ? value : '';
const lineId = value => clean(value, 60).replace(/[^A-Za-z0-9_-]/g, '');
const pipeline = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();

/** quote-model depositCents with money_* codes (money_invalid_amount, money_invalid_deposit_percent). */
export function depositCents(totalCents, pct = 50) {
  try { return quoteDepositCents(totalCents, pct); }
  catch (error) { throw fail(String(error.code || 'quote_invalid_amount').replace(/^quote_/, ''), error.message); }
}

/** Deterministic document number: an existing number wins, else EST-/INV-{last 6 of job id}. */
export function invoiceNumber(jobId, kind = 'invoice', existing = '') {
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  return `${kind === 'estimate' ? 'EST' : 'INV'}-${String(jobId || '').slice(-6).toUpperCase()}`;
}

// Approved decisions that no saved change-order line covers (change-orders.js):
// a billed line counts instead of its decision, and a voided one covers its
// decision too, so a change a manager voided is never counted again even when
// a stale write drops the decision's changeOrderVoidedAt.
const unbilledApprovals = job => {
  const saved = Array.isArray(job?.changeOrders) ? job.changeOrders : [];
  return (Array.isArray(job?.customerDecisions) ? job.customerDecisions : []).filter(item => plain(item) && item.status === 'approved' && !item.changeOrderVoidedAt && !changeOrderSaved(saved, item.id));
};

/**
 * Approved change orders in cents: the saved approvedChangeTotal, else the
 * billed change-order lines plus the approved decisions no line covers. A
 * saved total that differs from that derived figure is still used but flagged
 * money_change_order_conflict, even when nothing is derived: a legacy total
 * whose decision a stale Hub write turned back into a question (the portal
 * asks it again and does not bill it) is reported for review, never billed
 * silently.
 */
export function approvedChangeCents(job, issues = []) {
  const decisions = unbilledApprovals(job), lines = billedChangeOrders(job);
  let derived = 0;
  for (const cents of [...lines.map(line => line.totalCents), ...decisions.map(item => item.priceDelta === undefined || item.priceDelta === null || item.priceDelta === '' ? 0 : readCents(item.priceDelta))]) {
    derived = derived === null || cents === null || derived + cents > MAX_TOTAL_CENTS ? null : derived + cents;
  }
  const stored = job?.approvedChangeTotal;
  if (stored === undefined || stored === null) {
    if (derived === null) issues.push('money_change_order_invalid');
    return derived;
  }
  const cents = readCents(stored);
  if (cents === null) { issues.push('money_change_order_invalid'); return null; }
  if (derived !== null && derived !== cents) issues.push('money_change_order_conflict');
  return cents;
}

/** Unified payment evidence for one job plus a reconciliation against the recorded paid total. */
export function paymentLedger(job) {
  const payment = plain(job?.payment) ? job.payment : {}, entries = [], issues = [], byId = new Map(), stripeRefs = new Set();
  const push = entry => {
    const known = byId.get(entry.id);
    if (known) { if (known.amountCents !== entry.amountCents) issues.push('money_payment_conflict'); return; }
    byId.set(entry.id, entry); entries.push(entry);
    if (entry.amountCents === null) issues.push('money_payment_amount_unknown');
  };
  const sessions = Array.isArray(payment.stripeSessions) ? payment.stripeSessions : [];
  if (sessions.length && payment.verified !== true) issues.push('money_payment_not_verified');
  // Card receipts count only while the payment record is verified, as in
  // recordCustomerStripePayment and financialFacts.
  const cards = [];
  if (payment.verified === true) for (const item of sessions) {
    const row = plain(item) ? item : { sessionId: String(item || '') };
    const sessionId = /^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(row.sessionId || '') ? row.sessionId : '';
    const intentId = /^pi_[A-Za-z0-9_]+$/.test(row.paymentIntentId || '') ? row.paymentIntentId : '';
    if (!sessionId && !intentId) { issues.push('money_payment_receipt_unknown'); continue; }
    [sessionId, intentId].filter(Boolean).forEach(ref => stripeRefs.add(ref));
    const entry = { id: `stripe:${sessionId || intentId}`, kind: ['deposit', 'balance', 'tip'].includes(row.purpose) ? row.purpose : 'balance', amountCents: readCents(row.amount), method: 'card', processor: 'stripe', processorRef: intentId || sessionId, receiptUrl: '', at: instant(row.verifiedAt), by: clean(row.recordedBy, 120) || 'stripe', verified: true, source: 'stripe_session' };
    // uniqueReceipts merges rows that share a session OR an intent id and
    // compares amountCents and `at`; the purpose rides along in `at`, so rows
    // for one payment that disagree on it are a conflict as well.
    cards.push({ sessionId: sessionId || null, paymentIntentId: intentId || null, amountCents: entry.amountCents, at: `${entry.at}|${entry.kind}`, entry });
  }
  const { unique, conflicts } = uniqueReceipts(cards);
  for (const card of unique) push(card.entry);
  if (conflicts.length) issues.push('money_payment_conflict');
  // The job keeps one receipt link: the most recent card payment's.
  const latest = cards.at(-1), owner = latest && unique.find(card => latest.sessionId && card.sessionId === latest.sessionId || latest.paymentIntentId && card.paymentIntentId === latest.paymentIntentId);
  if (owner) owner.entry.receiptUrl = receipt(payment.receiptUrl);
  // Only the most recent staff-recorded receipt survives on the job today.
  const method = String(payment.method || '').toLowerCase(), reference = clean(payment.reference);
  if (payment.recordedBy && reference && !stripeRefs.has(reference) && !/stripe|gift_credit/.test(method) && payment.lastAmount !== undefined && payment.lastAmount !== null) {
    const at = instant(payment.lastReceivedAt);
    push({ id: `staff:${at || 'undated'}:${reference}`, kind: method === 'deposit' ? 'deposit' : 'offline', amountCents: readCents(payment.lastAmount), method: method || 'unspecified', processor: '', processorRef: reference, receiptUrl: '', at, by: clean(payment.recordedBy, 120), verified: payment.verified === true, source: 'staff_receipt' });
  }
  const credit = payment.giftCreditApplied === undefined || payment.giftCreditApplied === null ? 0 : readCents(payment.giftCreditApplied);
  let itemized = 0;
  for (const item of Array.isArray(job?.giftWallet?.redemptions) ? job.giftWallet.redemptions : []) {
    if (!plain(item) || item.jobId !== job.id) continue;
    const cents = readCents(item.amount);
    push({ id: `gift:${clean(item.id || item.requestId, 120)}`, kind: 'balance', amountCents: cents, method: 'gift_credit', processor: '', processorRef: clean(item.cardId, 120), receiptUrl: '', at: instant(item.appliedAt), by: 'customer', verified: true, source: 'gift_credit' });
    itemized += cents || 0;
  }
  // Redemptions usually live on the account's root job; the applied total is on this job.
  if (credit === null) issues.push('money_gift_credit_invalid');
  else if (credit > itemized) push({ id: `gift:${clean(job?.id, 120) || 'job'}:applied`, kind: 'balance', amountCents: credit - itemized, method: 'gift_credit', processor: '', processorRef: '', receiptUrl: '', at: null, by: 'customer', verified: true, source: 'gift_credit_total' });
  else if (credit < itemized) issues.push('money_gift_credit_conflict');
  if (job?.refunds || payment.refunds || moneyCents(payment.refundedAmount) > 0) issues.push('money_refunds_unreconciled');
  entries.sort((a, b) => (a.at === null) - (b.at === null) || String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  const sum = rows => rows.reduce((total, row) => total === null || row.amountCents === null ? null : total + (row.kind === 'refund' ? -row.amountCents : row.amountCents), 0);
  const paidRaw = payment.amount ?? job?.invoice?.paid ?? job?.invoice?.amountPaid ?? job?.deposit?.paidAmount;
  const paidCents = paidRaw === undefined || paidRaw === null ? 0 : readCents(paidRaw);
  if (paidCents === null) issues.push('money_paid_invalid');
  // A conflicting receipt group is left out of the entries, so neither the
  // reconciliation nor (when any card row is a tip) the tip total is known.
  const ledgerCents = sum(entries), unreconciledCents = paidCents === null || ledgerCents === null || conflicts.length ? null : paidCents - ledgerCents;
  const tipCents = conflicts.length && cards.some(card => card.entry.kind === 'tip') ? null : sum(entries.filter(row => row.kind === 'tip'));
  const found = [...new Set(issues)];
  return { entries, ledgerCents, tipCents, paidCents, unreconciledCents, conflicts, complete: unreconciledCents === 0 && found.length === 0, issues: found };
}

export const paymentEntries = job => paymentLedger(job).entries;

/** Strict normalizer for a new ledger entry; throws money_* codes. */
export function paymentEntry(raw) {
  if (!plain(raw) || Object.keys(raw).some(key => !ENTRY_FIELDS.includes(key))) throw fail('invalid_payment_entry', 'The payment entry has unsupported fields.');
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_:.-]{1,200}$/.test(raw.id)) throw fail('invalid_payment_entry', 'The payment entry needs a stable id.');
  if (!PAYMENT_KINDS.includes(raw.kind)) throw fail('invalid_payment_kind', `Payment kind must be one of ${PAYMENT_KINDS.join(', ')}.`);
  if (!Number.isSafeInteger(raw.amountCents) || raw.amountCents <= 0 || raw.amountCents > MAX_ENTRY_CENTS) throw fail('invalid_amount', 'Payment amounts are positive whole cents.');
  if (typeof raw.method !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(raw.method)) throw fail('invalid_payment_method', 'The payment method is invalid.');
  if (raw.processorRef !== undefined && (typeof raw.processorRef !== 'string' || raw.processorRef.length > 180 || /[\r\n\t]/.test(raw.processorRef))) throw fail('invalid_payment_entry', 'The processor reference is invalid.');
  if (raw.receiptUrl !== undefined && raw.receiptUrl !== '' && !receipt(raw.receiptUrl)) throw fail('invalid_receipt_url', 'Receipts must be Stripe receipt links.');
  const at = instant(raw.at);
  if (!at) throw fail('invalid_time', 'The payment time must be an ISO instant.');
  const by = clean(raw.by, 120);
  if (!by || by !== raw.by) throw fail('invalid_actor', 'The payment needs the person or system that recorded it.');
  return { id: raw.id, kind: raw.kind, amountCents: raw.amountCents, method: raw.method, processorRef: raw.processorRef || '', receiptUrl: raw.receiptUrl || '', at, by };
}

/**
 * Integer-cent money state for a job. quoteCents follows the legacy quoted
 * amount chain; totalCents adds approved change orders. The deposit term is on
 * the base quote exactly as customerDepositState computes it (saved
 * depositRequired or deposit.amount, else 50% rounded half-up). Tips paid
 * through the ledger are excluded from what counts toward the balance. Never
 * throws: out-of-range money (above $1,000,000) is null plus an issue.
 */
export function customerMoneyTotals(job) {
  const issues = [], quoteCents = quotedAmountCents(job);
  if (quoteCents === null) issues.push([job?.estimate?.amount, job?.total, job?.priceQuoted, job?.lockedTotal, job?.rate, job?.customerApproval?.amount].some(value => value !== undefined && value !== null) ? 'money_quote_invalid' : 'money_quote_missing');
  const changeCents = approvedChangeCents(job, issues), ledger = paymentLedger(job);
  const { paidCents, tipCents } = ledger;
  if (paidCents === null) issues.push('money_paid_invalid');
  if (tipCents === null) issues.push('money_tips_unknown');
  const totalCents = quoteCents === null || changeCents === null ? null : quoteCents + changeCents;
  const appliedCents = paidCents === null || tipCents === null ? null : Math.max(0, paidCents - tipCents);
  const known = (...values) => values.every(value => value !== null);
  const balanceCents = known(totalCents, appliedCents) ? Math.max(0, totalCents - appliedCents) : null;
  const saved = job?.estimate?.depositRequired ?? job?.deposit?.amount;
  const savedCents = saved === undefined || saved === null ? undefined : readCents(saved);
  if (savedCents === null) issues.push('money_deposit_invalid');
  // quoteCents is capped at MAX_TOTAL_CENTS, so the 50% default cannot throw.
  const depositRequiredCents = quoteCents === null || savedCents === null ? null : Math.min(quoteCents, savedCents === undefined ? quoteDepositCents(quoteCents, 50) : savedCents);
  const depositPaidCents = known(depositRequiredCents, appliedCents) ? Math.min(depositRequiredCents, appliedCents) : null;
  const depositDueCents = known(depositRequiredCents, appliedCents) ? Math.max(0, depositRequiredCents - appliedCents) : null;
  const finalWalkthroughDone = (Array.isArray(job?.postJobProgress?.standardItems) ? job.postJobProgress.standardItems : []).some(item => item?.key === '0_1' && item.completed === true);
  const closing = ['completed', 'paid'].includes(pipeline(job)) || Boolean(job?.completedAt || job?.postJobChecklist?.completedAt || finalWalkthroughDone);
  const dueNowCents = closing ? balanceCents : depositDueCents;
  return {
    quoteCents, approvedChangeCents: changeCents, totalCents, revenueCents: totalCents,
    paidCents, tipCents, appliedCents, balanceCents, overpaidCents: known(totalCents, appliedCents) ? Math.max(0, appliedCents - totalCents) : null,
    depositRequiredCents, depositPaidCents, depositDueCents, dueNowCents, purpose: closing ? 'balance' : 'deposit',
    remainderCents: known(balanceCents, dueNowCents) ? Math.max(0, balanceCents - dueNowCents) : null,
    complete: issues.length === 0, issues: [...new Set(issues)],
  };
}

export const moneyStateCents = customerMoneyTotals;

/**
 * Estimate money over selected lines only: line totals, approved changes on
 * top, and the deposit on the line total (a saved deposit term wins, capped at
 * the total; otherwise depositPct, 50% by default, rounded to the cent).
 * Invalid options throw money_* codes. The lines are read leniently, so an
 * unknown or out-of-range line total (see estimateTotals) gives null money,
 * never an exception.
 */
export function estimateMoney(lineItems, { approvedChangeCents: changeCents = 0, depositPct = 50, depositRequiredCents = null } = {}) {
  const whole = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOTAL_CENTS;
  if (!whole(changeCents)) throw fail('invalid_amount', 'Approved changes must be whole, non-negative cents up to $1,000,000.');
  if (depositRequiredCents !== null && !whole(depositRequiredCents)) throw fail('invalid_amount', 'The deposit must be whole, non-negative cents up to $1,000,000.');
  depositCents(0, depositPct); // validates the percent: money_invalid_deposit_percent
  const totals = estimateTotals(lineItems), total = totals.totalCents;
  return { ...totals, approvedChangeCents: changeCents, contractCents: total === null ? null : total + changeCents, depositCents: total === null ? null : depositRequiredCents === null ? depositCents(total, depositPct) : Math.min(total, depositRequiredCents) };
}

// The billed change-order lines as saved, then approvals no line covers.
function changeOrderLines(job, cents) {
  if (!cents) return [];
  const decisions = unbilledApprovals(job).filter(item => readCents(item.priceDelta) > 0);
  const lines = [
    ...billedChangeOrders(job).map(line => ({ id: line.id, kind: 'fee', name: clean(line.name, 160) || 'Approved change', description: clean(line.description, 600), quantity: 1, totalCents: line.totalCents })),
    ...decisions.map((item, index) => ({ id: `change-${lineId(item.id) || index + 1}`, kind: 'fee', name: `Approved change: ${clean(item.title, 140) || 'Additional work'}`, description: clean(item.details, 600), quantity: 1, totalCents: readCents(item.priceDelta) })),
  ];
  const itemized = lines.reduce((sum, line) => sum + line.totalCents, 0) === cents && new Set(lines.map(line => line.id)).size === lines.length;
  return normalizeLineItems(itemized ? lines : [{ id: 'change-orders', kind: 'fee', name: 'Approved changes', description: '', quantity: 1, totalCents: cents }]).lineItems;
}

/**
 * Customer-facing invoice lines: included estimate lines plus approved change
 * orders, each projected through customerLineItem (no split, markup, catalog or
 * duration). Saved lines are used only when they are complete (no repair that
 * could change what is charged) and add up to the quoted amount; otherwise one
 * honest line named like the Hub invoice (serviceType || 'Garage
 * transformation') carries the quote.
 */
export function invoiceLineItems(job, totals = customerMoneyTotals(job)) {
  const issues = [], record = legacyLineItems(job, { record: 'estimate', surface: 'invoice', totalCents: totals.quoteCents });
  let lines = record.lineItems.filter(line => included(line) && line.kind !== 'tip');
  const check = estimateTotals(record.source === 'record' ? job.estimate.lineItems : record.lineItems);
  if (!check.complete || check.totalCents !== totals.quoteCents) {
    issues.push(check.complete ? 'money_line_items_mismatch' : 'money_line_items_incomplete');
    lines = [singleLineItem(job, { surface: 'invoice', totalCents: totals.quoteCents })];
  }
  const changes = changeOrderLines(job, totals.approvedChangeCents).map(line => lines.some(item => item.id === line.id) ? { ...line, id: `${line.id}-change` } : line);
  return { lineItems: [...lines, ...changes].map(customerLineItem), issues };
}

/**
 * Builds the invoice record for a job from its saved estimate (no write, no
 * send) and returns {invoice, issues}. Mirrors the Hub "Issue invoice" action:
 * number INV-{last6} unless one exists, due in `dueDays` Denver calendar days,
 * status paid/pending_verification when nothing is owed, else issued. A void or
 * superseded invoice is reissued fresh under the same number. Throws
 * money_total_unknown when the quote or paid total cannot be read. `now` (an
 * ISO instant) is required: omitting it throws money_now_required.
 */
export function invoiceFromEstimate(job, { now, dueDays = 7, dueDate, customerReference } = {}) {
  if (!plain(job) || typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(job.id) || /^(secure_|_egc_)/.test(job.id)) throw fail('invalid_job', 'Choose a valid job before issuing an invoice.');
  const issuedAt = instant(requireNow(now));
  if (!issuedAt) throw fail('invalid_time', 'The invoice time must be an ISO instant.');
  if (!Number.isSafeInteger(dueDays) || dueDays < 0 || dueDays > 365) throw fail('invalid_due_date', 'Payment terms must be 0 to 365 days.');
  const due = dueDate === undefined ? addDays(denverToday(new Date(issuedAt)), dueDays) : dueDate;
  if (!validDate(due)) throw fail('invalid_due_date', 'Choose a valid payment due date.');
  const totals = customerMoneyTotals(job);
  if (totals.totalCents === null || totals.appliedCents === null || totals.balanceCents === null) throw fail('total_unknown', 'The quote and payments must be known before an invoice is issued.', 409);
  if (totals.totalCents <= 0) throw fail('invoice_empty', 'There is nothing to invoice for this job.', 409);
  const previous = plain(job.invoice) ? job.invoice : {}, reissue = ['void', 'superseded'].includes(previous.status);
  const base = reissue ? {} : previous, { lineItems, issues } = invoiceLineItems(job, totals);
  const invoice = {
    ...base,
    number: invoiceNumber(job.id, 'invoice', previous.number),
    status: totals.balanceCents === 0 ? (job.payment?.verified === true ? 'paid' : 'pending_verification') : 'issued',
    amount: totals.totalCents / 100, amountCents: totals.totalCents, quoteCents: totals.quoteCents, approvedChangeCents: totals.approvedChangeCents,
    paid: totals.appliedCents / 100, paidCents: totals.appliedCents, balance: totals.balanceCents / 100, balanceCents: totals.balanceCents,
    dueDate: due, customerReference: clean(customerReference ?? base.customerReference, 120), lineItems,
    termsVersion: job.estimate?.termsVersion || base.termsVersion || '2026-09',
    estimateRevision: Number.isSafeInteger(job.estimate?.revision) ? job.estimate.revision : null, estimateFingerprint: estimateFingerprint(job.estimate || {}),
    issuedAt: base.issuedAt || issuedAt, updatedAt: issuedAt, source: 'egc_hub',
  };
  return { invoice, issues: [...new Set([...totals.issues, ...issues])] };
}

/**
 * Effective invoice status for display: not_issued, draft, void, superseded,
 * paid, pending_verification, overdue (Denver date past dueDate), partial or
 * issued. `now` is a required ISO instant (money_now_required when omitted).
 * Never throws on saved job data.
 */
export function invoiceStatus(job, now) {
  const invoice = plain(job?.invoice) ? job.invoice : null, at = instant(requireNow(now));
  if (!at) throw fail('invalid_time', 'The status time must be an ISO instant.');
  if (!invoice || !invoice.status && !invoice.issuedAt && (invoice.amount === undefined || invoice.amount === null)) return 'not_issued';
  const base = String(invoice.status || 'issued').toLowerCase();
  if (['void', 'superseded', 'draft'].includes(base)) return base;
  const totals = customerMoneyTotals(job);
  if (totals.balanceCents === 0 && totals.totalCents > 0) return job.payment?.verified === true ? 'paid' : 'pending_verification';
  if (validDate(invoice.dueDate) && invoice.dueDate < denverToday(new Date(at))) return 'overdue';
  return totals.appliedCents > 0 ? 'partial' : 'issued';
}
