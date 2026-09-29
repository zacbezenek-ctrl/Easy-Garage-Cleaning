import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { moneyCents } from './operations-financials.js';
import { MAX_TOTAL_CENTS, estimateFingerprint } from './quote-model.js';

/**
 * P2-11 change orders. Pure: no I/O and no clock (`now` is passed in).
 *
 * A crew decision (jobs.customerDecisions[], sent from the Hub) that the
 * customer approves in the portal bills its price on top of the approved
 * estimate. The approval appends one change-order line to jobs.changeOrders:
 * {id:'change-<decisionId>', kind:'fee', source:'customer_decision',
 * decisionId, name, description, quantity:1, unitCents, totalCents, amount}
 * plus the approval evidence (approvedAt, approvedBy, requestId, actorId and
 * the estimate revision and fingerprint it was approved against). The decision
 * itself records the answer and links the line (changeOrderId). The signed
 * estimate, its revision and its approval are never touched, so the deposit
 * term and a paid deposit stay exactly as they were; the change is due with
 * the balance.
 *
 * Only approvals recorded while CHANGE_ORDER_BILLING_ENABLED and
 * MONEY_API_ENABLED are both "true" add a line, and only while the job is
 * open and the crew is still on it, within DECISION_APPROVAL_DAYS of the
 * question: a closed job (CLOSED_STAGES), a finished one (completed,
 * invoiced, paid, review requested or closed, or completedAt is set) or an
 * older question is refused (CUSTOMER_PORTAL_JOB_CLOSED or
 * CUSTOMER_PORTAL_DECISION_EXPIRED). customerMoneyState (portal, Stripe
 * checkout and recording, crew card links, reminders, business hub) bills
 * exactly the saved lines, once per decision, WHATEVER THE FLAG SAYS: turning
 * the flag off stops new lines, never the lines already saved. The rollback
 * for a saved line is the Hub money action change_order.void: the line stays
 * as evidence marked void and is no longer billed. A decision approved
 * without a line keeps today's unbilled behaviour
 * (scripts/backfill-change-orders.mjs can add the missing lines).
 * approvedChangeTotal (what money-core reads) is every billed line plus the
 * shown price of approvals that no saved line covers, in whole cents: a
 * decision whose line was voided is never counted again, even when a stale
 * write drops the decision's own void marker.
 *
 * A pending decision that already has a saved line was answered before (a
 * stale Hub write can turn an answer back into a question): the portal shows
 * the approval the line records and refuses any new answer
 * (CUSTOMER_PORTAL_DECISION_AMBIGUOUS), so a billed change can never be
 * declined while it stays on the balance.
 */

export const CHANGE_ORDER_KIND = 'fee';
export const CHANGE_ORDER_SOURCE = 'customer_decision';
export const MAX_CHANGE_ORDERS = 50;
/** Job stages that end the job without the work (the backfill and the portal share them). */
export const CLOSED_STAGES = Object.freeze(['cancelled', 'canceled', 'superseded', 'lost', 'declined', 'noshow', 'no_show', 'no-show']);
const FINISHED = ['completed', 'invoiced', 'paid', 'review_requested', 'closed'];
/** A priced crew question can be approved for billing for this many days after it was sent (promptedAt). */
export const DECISION_APPROVAL_DAYS = 14;
const DAY_MS = 86400000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max) => String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const fail = (reason, message, status = 409) => Object.assign(new Error(message), { code: `CUSTOMER_PORTAL_${reason}`, status });
const stages = job => [job?.status, job?.pipelineStatus].map(value => String(value || '').toLowerCase());
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
// The portal's lenient reader: the price a decision card shows (never negative).
const shown = value => {
  const parsed = typeof value === 'number' ? value : Number(String(value || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

// Billing also needs the Hub money API, whose change_order.void is how a
// manager stops billing a change. (The legacy Hub finance board still reads
// only the quote until an invoice is issued; see the unit's owner checklist.)
export const changeOrderBillingEnabled = env => env?.CHANGE_ORDER_BILLING_ENABLED === 'true' && env?.MONEY_API_ENABLED === 'true';

/** The crew has finished the job: a change approved now is for work that was not done. */
export const jobFinished = job => stages(job).some(value => FINISHED.includes(value)) || Boolean(job?.completedAt || job?.postJobChecklist?.completedAt);

/** The job ended without the work (cancelled, lost, declined, a no-show or superseded). */
export const jobClosed = job => stages(job).some(value => CLOSED_STAGES.includes(value));

/**
 * Why a priced question can no longer be approved for billing at `now`:
 * 'closed' (the job ended), 'finished' (the crew finished it), 'expired' (it
 * was sent more than DECISION_APPROVAL_DAYS ago; a question without a readable
 * promptedAt has no age limit), or '' when it can.
 */
export function approvalClosed(job, decision, now) {
  if (jobClosed(job)) return 'closed';
  if (jobFinished(job)) return 'finished';
  const asked = instant(decision?.promptedAt), at = instant(now);
  return asked !== null && at !== null && at - asked > DECISION_APPROVAL_DAYS * DAY_MS ? 'expired' : '';
}

/** A decision's price in whole cents: 0 when none was set, null when it is not dollars and cents or is above $1,000,000. */
export function decisionDeltaCents(decision) {
  const value = decision?.priceDelta;
  if (value === undefined || value === null || value === '') return 0;
  const cents = moneyCents(value);
  return cents === null || cents > MAX_TOTAL_CENTS ? null : cents;
}

/** Line id of a decision's change order, as money-core's invoiceLineItems names it (line ids are at most 80 characters). */
export const changeOrderLineId = decisionId => `change-${clean(decisionId, 60).replace(/[^A-Za-z0-9_-]/g, '')}`;

export const changeOrderVoided = line => plain(line) && (line.status === 'void' || Boolean(line.voidedAt));

/** Any saved change-order line (billed, voided or malformed) names this decision, by its decision id or by its line id. */
export function changeOrderSaved(changeOrders, decisionId) {
  if (typeof decisionId !== 'string' || !decisionId) return false;
  const lineId = changeOrderLineId(decisionId);
  return (Array.isArray(changeOrders) ? changeOrders : []).some(line => plain(line) && (line.decisionId === decisionId || line.id === lineId));
}

/** A saved, unvoided change-order line, or null when it does not describe exactly one customer decision's whole-cent price. */
export function changeOrderLine(line) {
  if (!plain(line) || changeOrderVoided(line) || line.kind !== CHANGE_ORDER_KIND || line.source !== CHANGE_ORDER_SOURCE || typeof line.decisionId !== 'string' || !line.decisionId || line.id !== changeOrderLineId(line.decisionId)) return null;
  return Number.isSafeInteger(line.totalCents) && line.totalCents > 0 && line.totalCents <= MAX_TOTAL_CENTS ? line : null;
}

/** The billed change-order lines on a job, once per decision: a repeated line is never billed twice. */
export function billedChangeOrders(job) {
  const seen = new Set(), lines = [];
  for (const raw of Array.isArray(job?.changeOrders) ? job.changeOrders : []) {
    const line = changeOrderLine(raw);
    if (!line || seen.has(line.decisionId) || seen.has(line.id)) continue;
    seen.add(line.decisionId); seen.add(line.id); lines.push(line);
  }
  return lines;
}

export const billedChangeCents = job => billedChangeOrders(job).reduce((sum, line) => sum + line.totalCents, 0);

/**
 * approvedChangeTotal in dollars: every billed line (`lines`), plus the shown
 * price of approved decisions that no saved line covers (`saved`: every saved
 * line, voided ones included), in whole cents. A voided change is never
 * counted, even when the decision lost its changeOrderVoidedAt.
 */
export function approvedChangeTotal(decisions, lines = [], saved = lines) {
  const billed = new Set(lines.map(line => line.decisionId));
  const unbilled = (Array.isArray(decisions) ? decisions : []).filter(item => plain(item) && item.status === 'approved' && !item.changeOrderVoidedAt && !billed.has(item.id) && !changeOrderSaved(saved, item.id));
  return (unbilled.reduce((sum, item) => sum + Math.round(shown(item.priceDelta) * 100), 0) + lines.reduce((sum, line) => sum + line.totalCents, 0)) / 100;
}

/** sha256 of what one portal answer said, bound to its request id: {actorId, decisionId, response, respondedBy, note, priceDeltaCents}. */
export const decisionFingerprint = (input, actorId = '') => bytesToHex(sha256(new TextEncoder().encode(canonical({
  actorId: actorId || '', decisionId: input.decisionId, response: input.response, respondedBy: input.respondedBy, note: input.note || '', priceDeltaCents: Number.isSafeInteger(input.priceDeltaCents) ? input.priceDeltaCents : null,
}))));

/**
 * An issued invoice (not draft, void or superseded) raised by exactly the
 * approved change in the same write, listing it as its own line. What is
 * still owed is the raised amount less what was paid, never below zero: an
 * overpaid invoice absorbs the change. What was paid is paidCents, money-core's
 * applied payments (customerMoneyTotals(job).appliedCents: the recorded paid
 * total less tips, the figure change_order.void and invoice.issue save), or
 * null when money-core cannot read it. The invoice's own paid figure is used
 * only when paidCents is not known, because it goes stale (an offline deposit
 * recorded after the invoice was issued never updates it). The raised invoice
 * records the paid figure it used; when neither is readable, paid is left as
 * it was (unreadable money never becomes a valid 0, so money-core still flags
 * money_paid_invalid) and a saved balance rises by exactly the change. A paid
 * invoice that now has a balance reopens as partial or issued; an issued,
 * partial or overdue one that the payments now cover is paid (`verified`: the
 * job's payment is verified) or pending_verification, as change_order.void
 * sets it; one awaiting verification keeps its status.
 */
export function raisedInvoice(invoice, line, now, paidCents, verified = false) {
  const status = String(invoice?.status || '').toLowerCase(), amount = plain(invoice) ? moneyCents(invoice.amount) : null;
  if (amount === null || ['draft', 'void', 'superseded'].includes(status)) return null;
  const paid = Number.isSafeInteger(paidCents) && paidCents >= 0 ? paidCents : moneyCents(invoice.paid);
  const raised = amount + line.totalCents, owed = paid === null ? null : Math.max(0, raised - paid);
  // Without a readable paid figure the change adds exactly its price to what is owed.
  const balance = saved => owed ?? saved + line.totalCents, next = { ...invoice, amount: raised / 100, updatedAt: now };
  if (paid !== null) next.paid = paid / 100;
  if (moneyCents(invoice.balance) !== null) next.balance = balance(moneyCents(invoice.balance)) / 100;
  if (paid !== null && (Number.isSafeInteger(invoice.paidCents) || Number.isSafeInteger(invoice.amountCents))) next.paidCents = paid;
  if (Number.isSafeInteger(invoice.amountCents)) next.amountCents = invoice.amountCents + line.totalCents;
  if (Number.isSafeInteger(invoice.balanceCents)) next.balanceCents = balance(invoice.balanceCents);
  if (Number.isSafeInteger(invoice.approvedChangeCents)) next.approvedChangeCents = invoice.approvedChangeCents + line.totalCents;
  if (status === 'paid' && (owed === null || owed > 0)) next.status = paid === 0 ? 'issued' : 'partial';
  if (owed === 0 && ['issued', 'partial', 'overdue'].includes(status)) next.status = verified ? 'paid' : 'pending_verification';
  if (Array.isArray(invoice.lineItems) && !invoice.lineItems.some(item => item?.id === line.id)) next.lineItems = [...invoice.lineItems, { id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: 1, unitCents: line.totalCents, totalCents: line.totalCents, amount: line.amount }];
  return next;
}

/** The customer-facing line for one decision's approved price, without its evidence. */
export function changeOrderDraft(decision, cents) {
  return {
    id: changeOrderLineId(decision.id), kind: CHANGE_ORDER_KIND, source: CHANGE_ORDER_SOURCE, decisionId: decision.id,
    name: `Approved change: ${clean(decision.title, 140) || 'Additional work'}`, description: clean(decision.details, 600),
    quantity: 1, unitCents: cents, totalCents: cents, amount: cents / 100,
  };
}

/**
 * Plans the portal answer to one decision: {decision, patch, replayed,
 * billedCents}. patch is null for a replay of the answer already saved. A
 * request id answers one decision once: the same id with a different answer
 * (another viewer, response, name, note or price) is
 * CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT. A pending decision that already has
 * a saved change-order line (billing on or off) cannot be answered at all:
 * it was answered before and a stale write reverted it, so declining it would
 * leave a charge the customer declined (CUSTOMER_PORTAL_DECISION_AMBIGUOUS).
 * With `billing`, approving a priced decision on an open, unfinished job
 * within DECISION_APPROVAL_DAYS of the question requires the price the page
 * showed (priceDeltaCents) and appends its change-order line, raising an
 * issued invoice by the same amount in the same patch (paidCents is
 * money-core's customerMoneyTotals(job).appliedCents, null when unreadable;
 * see raisedInvoice). Throws CUSTOMER_PORTAL_* errors.
 * input: {decisionId, response:'approved'|'declined', respondedBy, note, requestId, priceDeltaCents}.
 */
export function respondToDecision(job, input, { billing = false, now, actorId = '', paidCents } = {}) {
  if (typeof now !== 'string' || !now) throw fail('STORAGE_UNAVAILABLE', 'Your answer could not be saved. Please try again shortly.', 503);
  const decisions = Array.isArray(job?.customerDecisions) ? job.customerDecisions : [], lines = billedChangeOrders(job), saved = Array.isArray(job?.changeOrders) ? job.changeOrders : [];
  const matches = decisions.filter(item => plain(item) && item.id === input.decisionId), current = matches[0];
  if (!current) throw fail('DECISION_NOT_FOUND', 'This decision is no longer available', 404);
  const fingerprint = input.requestId ? decisionFingerprint(input, actorId) : '', conflict = () => fail('IDEMPOTENCY_CONFLICT', 'This answer was already sent with different details. Refresh the page to see the saved answer.');
  if (input.requestId && decisions.some(item => plain(item) && item.id !== input.decisionId && item.responseRequestId === input.requestId)) throw conflict();
  const billedCents = id => lines.find(line => line.decisionId === id)?.totalCents || 0;
  if (current.status !== 'pending') {
    const replay = { decision: current, patch: null, replayed: true, billedCents: current.status === 'approved' ? billedCents(current.id) : 0 };
    if (input.requestId && current.responseRequestId === input.requestId) {
      if (current.status !== input.response || current.responseFingerprint && current.responseFingerprint !== fingerprint) throw conflict();
      return replay;
    }
    // An older page without a request id matches on the same answer by the same name.
    if (!input.requestId && !current.responseRequestId && current.status === input.response && clean(current.responseBy, 120).toLowerCase() === clean(input.respondedBy, 120).toLowerCase()) return replay;
    throw fail('DECISION_ANSWERED', 'This decision has already been answered');
  }
  // A saved line for a pending decision means it was answered before (a stale
  // Hub write turned the answer back into a question). Neither answer is safe:
  // approving would bill it twice, declining would keep billing a declined change.
  if (changeOrderSaved(saved, current.id)) throw fail('DECISION_AMBIGUOUS', 'This decision needs a quick review by our team before it can be answered. Please call or text us.');
  let line = null;
  if (billing && input.response === 'approved') {
    if (matches.length > 1) throw fail('DECISION_AMBIGUOUS', 'This decision needs a quick review by our team before it can be approved. Please call or text us.');
    const cents = decisionDeltaCents(current);
    if (cents === null || cents > 0 && billedChangeCents(job) + cents > MAX_TOTAL_CENTS) throw fail('DECISION_PRICE_INVALID', 'This change needs an updated price from our team before it can be approved. Please call or text us.');
    if (cents > 0) {
      const closed = approvalClosed(job, current, now);
      if (closed === 'closed') throw fail('JOB_CLOSED', 'This job is closed, so the change cannot be added. Please call or text us.');
      if (closed === 'finished') throw fail('JOB_CLOSED', 'The crew has finished this job, so this change can no longer be added here. Please call or text us about it.');
      if (closed === 'expired') throw fail('DECISION_EXPIRED', `This question was sent more than ${DECISION_APPROVAL_DAYS} days ago, so the change can no longer be approved here. Please call or text us about it.`);
      // The customer approves exactly the price the page showed.
      if (input.priceDeltaCents !== cents) throw fail('DECISION_CHANGED', 'This change was updated after the page loaded. Refresh and review the current price before approving.');
      if (saved.length >= MAX_CHANGE_ORDERS) throw fail('DECISION_AMBIGUOUS', 'This decision needs a quick review by our team before it can be approved. Please call or text us.');
      const revision = Number(job.estimate?.revision || 1);
      line = {
        ...changeOrderDraft(current, cents), approvedAt: now, approvedBy: input.respondedBy,
        ...(input.requestId ? { requestId: input.requestId } : {}), ...(actorId ? { actorId } : {}),
        estimateRevision: Number.isSafeInteger(revision) && revision >= 1 ? revision : 1, estimateFingerprint: estimateFingerprint(plain(job.estimate) ? job.estimate : {}),
      };
    }
  }
  const answer = item => ({
    ...item, status: input.response, respondedAt: now, responseBy: input.respondedBy, responseNote: input.note, responseSource: 'customer_portal',
    ...(input.requestId ? { responseRequestId: input.requestId, responseFingerprint: fingerprint } : {}), ...(actorId ? { responseActorId: actorId } : {}), ...(line ? { changeOrderId: line.id } : {}),
  });
  const decision = answer(current), updated = decisions.map(item => item === current ? decision : plain(item) && item.id === input.decisionId ? answer(item) : item);
  const billed = line ? [...lines, line] : lines, kept = line ? [...saved, line] : saved;
  const patch = { customerDecisions: updated, approvedChangeTotal: approvedChangeTotal(updated, billed, kept), customerDecisionUpdatedAt: now, updatedAt: now };
  if (line) {
    patch.changeOrders = kept;
    const invoice = raisedInvoice(job.invoice, line, now, paidCents, job.payment?.verified === true);
    if (invoice) patch.invoice = invoice;
  }
  return { decision, patch, replayed: false, billedCents: line?.totalCents || 0 };
}

/**
 * Voids one billed change-order line (the Hub money action
 * change_order.void): every copy of the line stays as evidence marked void
 * (voidedAt, voidedBy, voidReason) and is no longer billed, and its decision
 * (still approved by the customer) records changeOrderVoidedAt. Neither
 * approvedChangeTotal nor money-core counts it again: the voided line itself
 * covers the decision, so a stale write that drops changeOrderVoidedAt
 * cannot bring the change back. Returns {line, patch} with
 * changeOrders, customerDecisions and approvedChangeTotal, or null when the
 * job bills no such line. The invoice is the caller's (money-service).
 */
export function voidChangeOrder(job, lineId, { reason, by, now }) {
  const line = billedChangeOrders(job).find(item => item.id === lineId);
  if (!line) return null;
  const changeOrders = job.changeOrders.map(item => plain(item) && !changeOrderVoided(item) && (item.id === line.id || item.decisionId === line.decisionId) ? { ...item, status: 'void', voidedAt: now, voidedBy: by, voidReason: reason } : item);
  const customerDecisions = (Array.isArray(job.customerDecisions) ? job.customerDecisions : []).map(item => plain(item) && item.id === line.decisionId ? { ...item, changeOrderVoidedAt: now, changeOrderVoidedBy: by } : item);
  return { line, patch: { changeOrders, customerDecisions, approvedChangeTotal: approvedChangeTotal(customerDecisions, billedChangeOrders({ changeOrders }), changeOrders) } };
}
