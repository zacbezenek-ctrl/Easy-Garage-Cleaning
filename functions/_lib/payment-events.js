import { funnelEventWrite } from './funnel-events.js';
import { funnelDefinitions, funnelHubId, hubRecordEligibility } from './funnel-definitions.js';
import { denverDate } from './funnel-calendar.js';
import { validDate } from './dispatch-time.js';
import { customerMoneyTotals, moneyCents, paymentLedger } from './money-core.js';

/**
 * FUN-33: payment events and paid-in-full on the ledger. Every writer that
 * changes a job's money adds these funnel events to the SAME commit as the job
 * change (funnel-events.js funnelEventWrite):
 *   payment.received        one per recorded payment (Stripe checkout or M3 offline),
 *                           with the payment kind, the funnel method, cash:false
 *                           for gift-credit redemptions (applied, never cash) and,
 *                           when a card charge carries a crew tip, tipCents apart
 *                           from amountCents (the service money only);
 *   job.paid_in_full        the ledger balance reached 0 at the job's current
 *                           estimate revision (bound to it: estimateRevision);
 *   job.balance_reopened    a paid-in-full balance opened again (a revision, a
 *                           change order, a refund or a re-sign), with the reason.
 * The job keeps the latest crossing as paidInFullAt/paidInFullRevision (null
 * again once reopened, with balanceReopenedAt/balanceReopenedReason). A
 * revision that keeps the job paid is no crossing (no event): it only moves
 * paidInFullRevision to the revision the job is now paid in full at, while the
 * job.paid_in_full event keeps the revision of its crossing. Both
 * states come only from ledger balance math in integer cents
 * (money-core customerMoneyTotals); job `status` stays a UI field and is never
 * read here. Absent fields mean "computed on read" (paidInFullState).
 * A payment keeps its own time (the Stripe charge, an attested time received);
 * a crossing is never dated before the facts it depends on (crossingClock).
 * Everything is off unless FUNNEL_PAYMENT_EVENTS_ENABLED and MONEY_API_ENABLED
 * are both exactly 'true': with the money API off, the Hub's browser finance
 * tools write deposits and payments straight to the job with no event, so the
 * payment events could never be complete.
 */
export const funnelPaymentEventsEnabled = env => env?.FUNNEL_PAYMENT_EVENTS_ENABLED === 'true' && env?.MONEY_API_ENABLED === 'true';

const METHODS = { card: 'card', stripe: 'card', card_terminal: 'card', ach: 'ach', bank_transfer: 'ach', cash: 'cash', check: 'check', gift_credit: 'gift_credit' };
const PURPOSES = ['deposit', 'balance', 'tip'];
const MINUTE = 60000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The funnel payment method (vocabularies.paymentMethods) for a recorded or offline method. */
export const funnelPaymentMethod = method => typeof method === 'string' && Object.hasOwn(METHODS, method) ? METHODS[method] : 'other';
/** Gift-credit redemptions are applied to the balance but are never cash collected. */
export const cashPayment = method => funnelPaymentMethod(method) !== 'gift_credit';

/**
 * The FUN-33 payment kind rule. An explicit deposit/balance/tip purpose is
 * kept. A payment without one (crew card links carry none) counts as a
 * deposit when it was made before the service date (Denver calendar days) and
 * is no more than the deposit amount still due on the job as read (the deposit
 * term less the money already applied, exactly what the portal would charge
 * as the deposit), otherwise as a balance, and is flagged (inferred: true)
 * either way. A second pre-service payment after the deposit is covered is a
 * balance, so deposits never sum past the deposit term. `amountCents` is the
 * service money only; a charge that carries a crew tip (`tipCents`) is always a
 * balance, because a tip rides only on a balance payment, never on a deposit.
 */
export function paymentKind(job, { purpose, amountCents, occurredAt, tipCents = 0 }) {
  if (PURPOSES.includes(purpose)) return { kind: purpose, inferred: false };
  const due = customerMoneyTotals(job).depositDueCents, date = validDate(job?.date) ? job.date : null;
  const before = Boolean(date && occurredAt) && denverDate(occurredAt) < date, tipped = Number.isSafeInteger(tipCents) && tipCents > 0;
  return { kind: !tipped && before && Number.isSafeInteger(due) && due > 0 && amountCents <= due ? 'deposit' : 'balance', inferred: true };
}

/**
 * Paid-in-full from ledger balance math: paid is true when a positive total's
 * balance is 0 and the recorded money is verified, false while a balance is
 * open, and null when the balance cannot be computed (unknown is never "paid").
 * Refunds recorded on the job that the ledger does not net yet
 * (money_refunds_unreconciled) leave the balance unknown until FUN-17 nets them.
 */
export function paidInFullState(job) {
  const totals = customerMoneyTotals(job), revision = job?.estimate?.revision;
  const netted = !paymentLedger(job).issues.includes('money_refunds_unreconciled');
  const known = netted && [totals.totalCents, totals.paidCents, totals.appliedCents, totals.balanceCents].every(Number.isSafeInteger) && totals.totalCents > 0;
  // Staff-recorded money nobody verified does not pay a job off (customerPaymentNeedsReview's rule).
  const payment = plain(job?.payment) ? job.payment : {}, deposit = plain(job?.deposit) ? job.deposit : {};
  const verified = payment.verified === true || (payment.amount === undefined || payment.amount === null) && deposit.verified === true && (moneyCents(deposit.paidAmount) ?? -1) >= totals.paidCents;
  return {
    paid: !known ? null : totals.balanceCents > 0 ? false : verified ? true : null,
    totalCents: known ? totals.totalCents : null, balanceCents: known ? totals.balanceCents : null,
    estimateRevision: Number.isSafeInteger(revision) && revision >= 0 && revision <= 100000 ? revision : null,
  };
}

/**
 * The paid-in-full crossing between the job as read and the job as it will be
 * saved: 'job.paid_in_full', 'job.balance_reopened' or null. When the earlier
 * balance cannot be computed, the stored paidInFullAt stands in for it.
 */
export function paidInFullChange(before, after) {
  const was = paidInFullState(before), next = paidInFullState(after);
  const wasPaid = was.paid ?? (typeof before?.paidInFullAt === 'string' && before.paidInFullAt !== '');
  if (next.paid === true && !wasPaid) return { type: 'job.paid_in_full', state: next };
  if (next.paid === false && wasPaid) return { type: 'job.balance_reopened', state: next };
  return null;
}

/**
 * The provider clock for a Stripe Checkout payment: the charge's `created`
 * (the PaymentIntent's when Stripe gave no charge). A time outside the funnel
 * range, or none, falls back to the server clock ({}), so a payment is never
 * refused over its timestamp.
 */
export function stripeChargeClock(checkout, now) {
  const intent = plain(checkout?.payment_intent) ? checkout.payment_intent : {}, charge = plain(intent.latest_charge) ? intent.latest_charge : {};
  const seconds = Number.isSafeInteger(charge.created) ? charge.created : intent.created;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return {};
  const at = new Date(seconds * 1000).toISOString(), integrity = funnelDefinitions().eventIntegrity;
  return at >= new Date(integrity.earliestOccurredAt).toISOString() && Date.parse(at) <= Date.parse(now) + integrity.maxFutureMinutes * MINUTE ? { clockSource: 'provider', occurredAt: at } : {};
}

/**
 * The funnel method of a Stripe Checkout payment, from the expanded charge's
 * payment_method_details.type: card and Link are card, us_bank_account is ach,
 * anything else is other. Only a charge Stripe did not expand falls back to card.
 */
export function stripePaymentMethod(checkout) {
  const intent = plain(checkout?.payment_intent) ? checkout.payment_intent : {}, charge = intent.latest_charge;
  if (!plain(charge)) return 'card';
  const type = plain(charge.payment_method_details) ? charge.payment_method_details.type : null;
  return type === 'card' || type === 'link' ? 'card' : type === 'us_bank_account' ? 'ach' : 'other';
}

/** A time a money writer may record as a funnel occurredAt (never before eventIntegrity.earliestOccurredAt). */
export const funnelTimeAccepted = at => typeof at === 'string' && Date.parse(at) >= Date.parse(funnelDefinitions().eventIntegrity.earliestOccurredAt);

const instantMs = value => typeof value === 'string' && value !== '' ? Date.parse(value) : NaN;

/**
 * The clock for a paid-in-full crossing. The payment keeps its own time, but
 * the crossing is a fact about the job as it stands now: the balance can only
 * reach 0 (or open again) at the total and estimate revision it is bound to,
 * after the reopen or crossing it follows. So
 * the write's clock ({} is the server clock) is used only when it is no earlier
 * than every one of those; otherwise the crossing takes the server clock. The
 * floor is the latest of:
 *   before.balanceReopenedAt and before.paidInFullAt (the last crossing);
 *   the last estimate write as read (estimate.updatedAt, else createdAt, and
 *   acceptance.recordedAt for a walkthrough replacement revision), which is
 *   never earlier than the save of the current revision;
 *   before.moneyUpdatedAt, the last M3 money write (a change_order.void, an
 *   estimate, an approval, an invoice or a payment recorded through
 *   /api/money; conservative: any of them dates a backdated crossing at the
 *   save that records it);
 *   every change-order time that moved the total: changeOrders[].approvedAt
 *   and voidedAt, and an approved customerDecisions[] answer (respondedAt) or
 *   its changeOrderVoidedAt, so a total is never paid off before the void or
 *   approval that set it;
 *   now, when this write itself saves a new estimate revision.
 * A backdated check or a late Stripe webhook (an ACH charge that settles days
 * after charge.created) after a reopen, a revision or a change-order void is
 * therefore dated when it was recorded, never before the total it pays off.
 */
export function crossingClock(before, after, clock = {}, now) {
  if (!clock.occurredAt) return {};
  const estimate = job => plain(job?.estimate) ? job.estimate : {}, revisionOf = job => estimate(job).revision ?? null, rows = value => Array.isArray(value) ? value.filter(plain) : [];
  const changeTimes = [...rows(before?.changeOrders).flatMap(line => [line.approvedAt, line.voidedAt]), ...rows(before?.customerDecisions).filter(item => item.status === 'approved').flatMap(item => [item.respondedAt, item.changeOrderVoidedAt])];
  const floor = [before?.balanceReopenedAt, before?.paidInFullAt, estimate(before).updatedAt, estimate(before).createdAt, plain(before?.acceptance) ? before.acceptance.recordedAt : null,
    before?.moneyUpdatedAt, ...changeTimes, revisionOf(after) !== revisionOf(before) ? now : null]
    .map(instantMs).filter(Number.isFinite).reduce((latest, at) => Math.max(latest, at), -Infinity);
  return instantMs(clock.occurredAt) >= floor ? clock : {};
}

/**
 * The funnel events and paid-in-full fields for one money write, to add to
 * the SAME commit as the job change. `before` is the job as read (with its
 * id), `after` the job as it will be saved. `payment` ({amountCents, kind,
 * kindInferred, method, tipCents?}) adds payment.received: amountCents is the
 * service money and a crew tip on the same charge is tipCents, one event per
 * charge. The paid-in-full crossing is computed from the two jobs. Every event
 * carries the write's idempotency key, actor, via and source; payment.received
 * takes the write's clock ({} server, or {clockSource, occurredAt}) and the
 * crossing takes crossingClock(). A reopening needs `reason`
 * (reasonCodes.balanceReopened). Stripe payments pass
 * `stripe` ({sessionId, livemode}) for eligibility. Private records and ids
 * that cannot carry events get nothing. A recorded crossing that stays paid
 * across a revision gets only its paidInFullRevision moved. Returns {patch, writes}.
 */
export async function moneyEventWrites({ before, after, now, idempotencyKey, actor, via, source, clock = {}, payment = null, reason = null, stripe }) {
  if (!plain(after) || !funnelHubId(after.id) || hubRecordEligibility(after).exclusion === 'private_record') return { patch: {}, writes: [] };
  const common = {
    jobId: after.id, ...Object.fromEntries(['projectId', 'customerId'].filter(key => funnelHubId(after[key])).map(key => [key, after[key]])),
    ...(typeof after.highlevelContactId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(after.highlevelContactId) ? { highlevelContactId: after.highlevelContactId } : {}),
    idempotencyKey, actor, via, source, eligibility: { hub: after, ...(stripe ? { stripe } : {}) },
  };
  const writes = [], patch = {}, state = paidInFullState(after);
  if (payment) writes.push(await funnelEventWrite(null, now, { type: 'payment.received', ...common, ...clock, data: {
    amountCents: payment.amountCents, kind: payment.kind, method: funnelPaymentMethod(payment.method), cash: cashPayment(payment.method), estimateRevision: state.estimateRevision, kindInferred: payment.kindInferred === true ? true : null,
    tipCents: Number.isSafeInteger(payment.tipCents) && payment.tipCents > 0 ? payment.tipCents : null,
  } }));
  const change = paidInFullChange(before, after);
  if (change) {
    const paid = change.type === 'job.paid_in_full';
    const event = await funnelEventWrite(null, now, { type: change.type, ...common, ...crossingClock(before, after, clock, now), data: paid ? { amountCents: state.totalCents, estimateRevision: state.estimateRevision } : { amountCents: state.balanceCents, estimateRevision: state.estimateRevision, reasonCode: reason } });
    writes.push(event);
    Object.assign(patch, paid ? { paidInFullAt: event.patch.occurredAt, paidInFullRevision: state.estimateRevision } : { paidInFullAt: null, paidInFullRevision: null, balanceReopenedAt: event.patch.occurredAt, balanceReopenedReason: reason });
  } else if (state.paid === true && typeof after.paidInFullAt === 'string' && after.paidInFullAt !== '' && after.paidInFullRevision !== state.estimateRevision) patch.paidInFullRevision = state.estimateRevision;
  return { patch, writes };
}
