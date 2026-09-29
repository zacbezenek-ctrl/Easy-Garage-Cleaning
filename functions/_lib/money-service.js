import { requireDispatcher } from './dispatch-service.js';
import { auditWrite } from './hub-audit.js';
import { denverToday, validDate } from './dispatch-time.js';
import { MAX_TOTAL_CENTS, customerLineItem, customerMoneyTotals, depositCents, estimateTotals, invoiceFromEstimate, invoiceLineItems, invoiceNumber, invoiceStatus, moneyCents, normalizeLineItems, paymentEntry } from './money-core.js';
import { estimateChanged, estimateFingerprint, legacyLineItems } from './quote-model.js';
import { ledgerPatch, reconcileLedger } from './money-ledger.js';
import { customerPaymentNeedsReview } from './customer-payments.js';
import { billedChangeOrders, voidChangeOrder } from './change-orders.js';
import { hubRecordEligibility } from './funnel-definitions.js';
import { JOB_LABOR_COSTS, laborCostVisible, laborOnJob, laborRecordPatch, legacyJobLabor, legacyLaborMove, validLaborCents } from './job-labor-private.js';

/**
 * M3 server-authoritative money mutations for one job:
 *   mutateMoney(store, actor, input, now)
 * store: {read(collection,id), commit(writes)} (moneyStorage or a fake).
 * Every change is ONE commit: the job (updateTime precondition from
 * input.expectedRevision), any invoice-number reservation, a create-only
 * moneyOperations/{requestId} receipt (sha256 of {actor,input}) and a
 * create-only hub_audit entry with the money before/after (direct costs only
 * in the owner-only costs.save entry). Labor dollars never go on the job, which
 * every business user can read: costs.save keeps them in the server-only
 * jobLaborCosts record (JOB-COST-PRIVACY, job-labor-private.js), only a viewer
 * who sees labor dollars (actor.laborCostVisible) enters or reads them, and a
 * readable copy an older save left on the job moves there. With
 * EGC_STAFF_PAY_OWNER_ONLY=false (actor.laborOnJob) the job keeps its costs map
 * as before, labor included, and the record mirrors it. The customer payment mirror is written
 * after that commit on a best-effort basis, as the legacy tool did. A replay returns
 * the saved result; the same requestId with another payload is
 * money_idempotency_conflict. Nothing here sends anything to a customer:
 * estimate.mark_sent only records that a person sent the estimate, and
 * change_order.void stops billing a change the customer approved in the portal.
 * All math and record shapes come from money-core/quote-model (integer cents).
 */
export const MONEY_ACTIONS = Object.freeze(['estimate.save', 'estimate.record_approval', 'estimate.mark_sent', 'deposit.record_offline', 'payment.record_offline', 'invoice.issue', 'invoice.void', 'change_order.void', 'costs.save']);
export const OFFLINE_METHODS = Object.freeze(['cash', 'check', 'card_terminal', 'bank_transfer', 'other']);
export const SENT_CHANNELS = Object.freeze(['email', 'text', 'in_person', 'phone', 'other']);
export const COST_KEYS = Object.freeze(['labor', 'disposal', 'materials', 'fuel', 'processing', 'other']);
const OTHER_COST_KEYS = COST_KEYS.filter(key => key !== 'labor');
// The customer portal lists at most 12 lines and shows every saved line as a
// charge, so estimates saved here are required, positive lines only.
export const MAX_ESTIMATE_LINES = 12;
export const MONEY_RECEIPTS = 'moneyOperations';
export const INVOICE_NUMBERS = 'moneyInvoiceNumbers';
const ESTIMATE_KINDS = new Set(['service', 'product', 'labor', 'disposal', 'fee']);
const COMMON = ['action', 'requestId', 'jobId', 'expectedRevision', 'actorId'];
const FIELDS = {
  'estimate.save': ['lineItems', 'scope', 'depositCents', 'validUntil'], 'estimate.record_approval': ['approvedBy'], 'estimate.mark_sent': ['channel', 'note'],
  'deposit.record_offline': ['amountCents', 'method', 'reference', 'receivedAt'], 'payment.record_offline': ['amountCents', 'method', 'reference', 'receivedAt'],
  'invoice.issue': ['dueDate', 'customerReference'], 'invoice.void': ['reason'], 'change_order.void': ['changeOrderId', 'reason'], 'costs.save': ['costs', 'expectedLaborRevision'],
};
const FINAL = new Set(['money_idempotency_conflict', 'money_changed_since_operation', 'money_actor_changed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOTAL_KEYS = ['quoteCents', 'approvedChangeCents', 'totalCents', 'paidCents', 'tipCents', 'appliedCents', 'balanceCents', 'overpaidCents', 'depositRequiredCents', 'depositPaidCents', 'depositDueCents', 'dueNowCents', 'purpose', 'complete', 'issues'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const fail = (reason, message, status = 400, details) => Object.assign(new Error(message), { code: `money_${reason}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const stage = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const approved = value => ['accepted', 'approved'].includes(String(value || '').toLowerCase());
const closed = job => ['cancelled', 'canceled', 'noshow', 'no_show', 'no-show'].includes(stage(job));
const given = value => value !== undefined && value !== null;
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const usd = cents => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const pick = (value, keys) => plain(value) ? Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;
const str = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : null;

export const moneyApiEnabled = env => env?.MONEY_API_ENABLED === 'true';
/**
 * Jobs whose money the Hub manages: customer work, never walkthroughs, blocks
 * or private records (the FUN-01 shared eligibility). Test and internal jobs
 * stay manageable; funnel and revenue metrics exclude them separately.
 */
export const moneyJob = job => Boolean(job) && safeId(job.id) && hubRecordEligibility(job).exclusion !== 'private_record' && !['walkthrough', 'blocked', 'availability'].includes(job.type);
/**
 * Recorded money that is not verified: the portal and crew payments already
 * wait on it (customerPaymentNeedsReview), and so must new Hub money, which
 * would otherwise mark it verified. Unverified card sessions count even when
 * no paid total was saved.
 */
export const paymentNeedsVerification = job => customerPaymentNeedsReview(job) || job?.payment?.verified !== true && Array.isArray(job?.payment?.stripeSessions) && job.payment.stripeSessions.length > 0;

export function requireMoneyManager(session) {
  try { requireDispatcher(session); }
  catch (error) {
    if (error.status === 401) throw fail('sign_in_required', 'Sign in to the Employee Hub to manage job money.', 401);
    throw fail('forbidden', 'Only an operations manager or owner can manage job money.', 403);
  }
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

function validate(input, actor) {
  if (!plain(input) || !MONEY_ACTIONS.includes(input.action) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('request_invalid', 'Use a supported money action with a unique request ID.');
  const unknown = Object.keys(input).filter(key => !COMMON.includes(key) && !FIELDS[input.action].includes(key));
  if (unknown.length) throw fail('request_invalid', 'This request contains unsupported fields. Refresh the form and try again.', 400, { fields: unknown.slice(0, 10) });
  if (!safeId(input.jobId)) throw fail('request_invalid', 'Choose a valid job.');
  if (typeof input.expectedRevision !== 'string' || !input.expectedRevision || input.expectedRevision.length > 100) throw fail('request_invalid', 'Refresh the job before changing its money.');
  if (input.expectedLaborRevision !== undefined && input.expectedLaborRevision !== null && (typeof input.expectedLaborRevision !== 'string' || !input.expectedLaborRevision || input.expectedLaborRevision.length > 100)) throw fail('request_invalid', 'Refresh the job\'s labor cost before changing it.');
  if (input.actorId !== undefined && String(input.actorId).trim().toLowerCase() !== String(actor.user).trim().toLowerCase()) throw fail('actor_changed', 'The signed-in employee changed. Sign in as the original employee to finish this request, or discard it.', 403);
}

// The saved estimate as the fingerprint sees it. Legacy lines that read back
// cleanly compare in canonical form, so re-saving an unchanged estimate from
// the editor is not a material change; lines needing repair compare raw.
function comparable(job, totals) {
  const current = plain(job.estimate) ? job.estimate : {}, record = legacyLineItems(job, { record: 'estimate', surface: 'invoice', totalCents: totals.quoteCents });
  const clean = record.source === 'record' ? estimateTotals(current.lineItems).complete : !record.issues.length;
  return { lineItems: clean ? record.lineItems : current.lineItems, amount: current.amount ?? (totals.quoteCents === null ? null : totals.quoteCents / 100), depositRequired: totals.depositRequiredCents === null ? current.depositRequired ?? null : totals.depositRequiredCents / 100, scope: current.scope ?? '' };
}

// A line re-saved from the editor keeps its internal catalog link, duration and
// customer-supplied flag while its kind is unchanged, and its cost split while
// its unit price is unchanged too. The editor never shows them, and dispatch
// durations depend on them.
function carryInternal(job, items) {
  const saved = Array.isArray(job.estimate?.lineItems) && job.estimate.lineItems.length ? new Map(normalizeLineItems(job.estimate.lineItems).lineItems.map(line => [line.id, line])) : new Map();
  return items.map(raw => {
    const prior = plain(raw) && typeof raw.id === 'string' ? saved.get(raw.id) : null;
    if (!prior || raw.kind !== prior.kind) return raw;
    const extra = {}, keys = raw.unitCents === prior.unitCents ? ['split', 'catalog', 'durationMinutes'] : ['catalog', 'durationMinutes'];
    for (const key of keys) if (raw[key] === undefined && prior[key] !== null) extra[key] = prior[key];
    if (raw.customerSupplied === undefined && prior.customerSupplied) extra.customerSupplied = true;
    return { ...raw, ...extra };
  });
}

async function saveEstimate({ job, input, actor, now, today }) {
  if (closed(job)) throw fail('job_closed', 'A cancelled job cannot take a new estimate.', 409);
  if (!Array.isArray(input.lineItems) || !input.lineItems.length) throw fail('invalid_line_items', 'Add at least one priced line item.');
  if (input.lineItems.length > MAX_ESTIMATE_LINES) throw fail('too_many_lines', `An estimate can hold up to ${MAX_ESTIMATE_LINES} lines so the customer portal shows every line.`);
  let lines;
  try { ({ lineItems: lines } = normalizeLineItems(carryInternal(job, input.lineItems), { strict: true })); }
  catch (error) { throw fail('invalid_line_items', error.message || 'A line item is invalid.', 400, { code: error.code || 'quote_invalid_line_item', ...(plain(error.details) ? error.details : {}) }); }
  if (lines.some(line => !ESTIMATE_KINDS.has(line.kind))) throw fail('line_kind_unsupported', 'Discount and tip lines are not supported here yet. Adjust the line prices instead.');
  if (lines.some(line => line.optional || line.group)) throw fail('options_unsupported', 'Optional and package choices are not supported here yet. Every line is included in the total.');
  const totals = estimateTotals(lines), totalCents = totals.totalCents;
  if (!totals.complete || !Number.isSafeInteger(totalCents) || totalCents <= 0) throw fail('invalid_line_items', 'The estimate total must be more than $0.00.');
  const deposit = given(input.depositCents) ? whole(input.depositCents, 'The deposit', 0, totalCents) : depositCents(totalCents, 50);
  const scope = text(input.scope, 'The customer-facing scope', 1600, { required: true, multiline: true });
  if (!validDate(input.validUntil) || input.validUntil < today) throw fail('invalid_valid_until', 'Choose an estimate expiry date of today or later.');
  const current = plain(job.estimate) ? job.estimate : {}, before = customerMoneyTotals(job), approval = plain(job.customerApproval) ? job.customerApproval : null;
  const next = { ...current, number: invoiceNumber(job.id, 'estimate', current.number), amount: totalCents / 100, amountCents: totalCents, scope, lineItems: lines, depositRequired: deposit / 100, depositRequiredCents: deposit, validUntil: input.validUntil, termsVersion: current.termsVersion || job.termsVersion || '2026-09', createdAt: current.createdAt || now, updatedAt: now, updatedBy: actor.user, source: 'egc_hub' };
  const existed = Boolean(current.number || given(current.amount) || approval?.status || given(job.invoice?.amount));
  const material = existed && estimateChanged(comparable(job, before), next), wasApproved = approved(current.status) || approved(approval?.status);
  next.revision = (Number.isSafeInteger(current.revision) && current.revision > 0 ? current.revision : 0) + (material || !current.number ? 1 : 0);
  next.status = material ? 'draft' : current.status || 'draft';
  const deposits = plain(job.deposit) ? job.deposit : {}, depositPaid = moneyCents(deposits.paidAmount) ?? 0, warnings = [];
  const patch = { estimate: next, total: totalCents / 100, priceQuoted: totalCents / 100, deposit: { ...deposits, amount: deposit / 100, status: depositPaid >= deposit ? 'paid' : depositPaid > 0 ? 'partial' : 'required' } };
  if (material && approval?.status && approval.status !== 'superseded' || material && wasApproved) {
    patch.customerApproval = { ...(approval || {}), status: 'superseded', supersededAt: now, supersededBy: actor.user, reason: 'estimate_revised' };
    patch.quoteStatus = 'draft';
    Object.assign(next, { acceptedAt: null, acceptedBy: null, acceptanceMethod: null });
    warnings.push({ code: 'approval_superseded', message: 'The customer decision no longer matches this estimate. Record or request a fresh approval.' });
  }
  const invoice = plain(job.invoice) ? job.invoice : null;
  if (material && invoice && given(invoice.amount) && !['void', 'superseded'].includes(invoice.status)) {
    patch.invoice = { ...invoice, status: 'superseded', supersededAt: now, supersededReason: 'estimate_revised' };
    warnings.push({ code: 'invoice_superseded', message: 'The issued invoice was superseded. Issue a new invoice for the revised estimate.' });
  }
  if (before.appliedCents !== null && before.appliedCents > totalCents + (before.approvedChangeCents || 0)) warnings.push({ code: 'payments_exceed_total', message: 'Recorded payments are more than the revised total. The payments were kept; review them.' });
  return { patch, warnings, reason: material ? 'estimate_revised' : null };
}

function priced(job, label) {
  const estimate = plain(job.estimate) ? job.estimate : null, totals = customerMoneyTotals(job);
  if (closed(job)) throw fail('job_closed', `A cancelled job cannot ${label}.`, 409);
  if (!Number.isSafeInteger(totals.quoteCents) || totals.quoteCents <= 0) throw fail('estimate_missing', `Save a priced estimate before you ${label}.`, 409);
  if (approved(estimate?.status) || approved(job.customerApproval?.status)) throw fail('already_approved', 'This estimate is already approved. Save a revision first if the customer is approving a change.', 409);
  return { estimate: estimate || {}, totals };
}

function recordApproval({ job, input, actor, now, today }) {
  const { estimate, totals } = priced(job, 'record an approval');
  if (validDate(estimate.validUntil) && estimate.validUntil < today) throw fail('estimate_expired', 'This estimate has expired. Save it with a new expiry date before recording approval.', 409);
  const approvedBy = text(input.approvedBy, 'The name of the person who approved', 120, { required: true, min: 2 });
  const next = { ...estimate, number: invoiceNumber(job.id, 'estimate', estimate.number), status: 'accepted', amount: totals.quoteCents / 100, acceptedAt: now, acceptedBy: approvedBy, acceptanceMethod: 'employee_recorded', termsVersion: estimate.termsVersion || job.termsVersion || '2026-09', updatedAt: now };
  return { patch: {
    estimate: next, quoteStatus: 'approved',
    customerApproval: { status: 'approved', approvedAt: now, approvedBy, amount: totals.quoteCents / 100, source: 'employee_recorded', recordedBy: actor.user, estimateRevision: Number.isSafeInteger(next.revision) ? next.revision : null, estimateFingerprint: estimateFingerprint(next) },
    // Today's approval flow queues the existing portal invitation; nothing is sent here.
    customerPortalInvitationRequestedAt: job.customerPortalInvitationRequestedAt || now,
  }, warnings: [], reason: `Approved by ${approvedBy}` };
}

function markSent({ job, input, actor, now }) {
  const { estimate } = priced(job, 'mark it sent');
  if (!SENT_CHANNELS.includes(input.channel)) throw fail('invalid_channel', `Choose how the estimate was sent: ${SENT_CHANNELS.join(', ')}.`);
  const note = text(input.note, 'The note', 500);
  return { patch: { estimate: { ...estimate, status: 'sent', sentAt: now, sentBy: actor.user, sentChannel: input.channel, sentRevision: Number.isSafeInteger(estimate.revision) ? estimate.revision : null, sentNote: note, updatedAt: now } }, warnings: [], reason: note || null };
}

/** moneyInvoiceNumbers document id for an invoice number. */
export const invoiceNumberId = number => `n_${number.toUpperCase().replace(/[^A-Z0-9_-]/g, '_').slice(0, 150)}`;
// Invoice numbers are INV-{last 6 of the job id} unless the job already has
// one. moneyInvoiceNumbers/{number} is created in the same commit, so two jobs
// can never be issued the same new number; the second gets a -2 suffix.
async function reserveNumber(store, job, now) {
  const existing = typeof job.invoice?.number === 'string' ? job.invoice.number.trim() : '', base = invoiceNumber(job.id, 'invoice', existing);
  for (let attempt = 1; attempt <= 25; attempt++) {
    const number = attempt === 1 ? base : `${base}-${attempt}`, row = await store.read(INVOICE_NUMBERS, invoiceNumberId(number));
    if (row?.jobId === job.id) return { number, writes: [], warnings: [] };
    if (!row) return { number, writes: [{ collection: INVOICE_NUMBERS, id: invoiceNumberId(number), patch: { number, jobId: job.id, reservedAt: now } }], warnings: [] };
    // A number the customer may already hold is kept; the duplicate is reported.
    if (existing) return { number: existing, writes: [], warnings: [{ code: 'invoice_number_duplicate', message: `Invoice number ${existing} is also used by another job. It was kept; review the duplicate.` }] };
  }
  throw fail('invoice_number_unavailable', 'A unique invoice number could not be reserved. Retry.', 503);
}

const recordOffline = kind => async ({ store, job, input, actor, now }) => {
  const amount = whole(input.amountCents, 'The amount received', 1, MAX_TOTAL_CENTS);
  if (!OFFLINE_METHODS.includes(input.method)) throw fail('invalid_payment_method', `Choose how the money was received: ${OFFLINE_METHODS.join(', ')}.`);
  const reference = text(input.reference, 'A receipt, check or transaction reference', 160, { required: true, min: 2 });
  const receivedAt = input.receivedAt === undefined ? now : instant(input.receivedAt);
  if (!receivedAt || Date.parse(receivedAt) > Date.parse(now) + 300000) throw fail('invalid_received_at', 'The time received must be a valid time that is not in the future.');
  const payment = plain(job.payment) ? job.payment : {};
  // Recording more money must never verify an earlier unverified entry.
  if (paymentNeedsVerification(job)) throw fail('payment_needs_review', 'An earlier payment on this job is recorded but not verified, so no more money can be recorded yet. The owner confirms it against the check, bank or Stripe record and marks it verified on the job (the payment ledger backfill lists these jobs under needsVerification).', 409);
  const totals = customerMoneyTotals(job);
  if ([totals.totalCents, totals.paidCents, totals.appliedCents, totals.balanceCents].includes(null)) throw fail('total_unknown', 'The quote and recorded payments must be readable before more money is recorded. Review this job.', 409, { issues: totals.issues });
  if (amount > totals.balanceCents) throw fail('amount_exceeds_balance', `The amount cannot be more than the ${usd(totals.balanceCents)} balance.`, 409, { balanceCents: totals.balanceCents });
  const paidCents = totals.paidCents + amount, appliedCents = totals.appliedCents + amount, balanceCents = totals.balanceCents - amount, deposit = kind === 'deposit';
  const nextPayment = { ...payment, amount: paidCents / 100, lastAmount: amount / 100, lastReceivedAt: receivedAt, method: deposit ? 'deposit' : input.method, reference, verified: true, recordedBy: actor.user };
  const entry = { ...paymentEntry({ id: `offline:${input.requestId.toLowerCase()}`, kind: deposit ? 'deposit' : 'offline', amountCents: amount, method: input.method, processorRef: reference, at: receivedAt, by: actor.user }), processor: '', verified: true, source: 'hub_offline' };
  const ledger = reconcileLedger({ ...job, payment: nextPayment }, [entry]), patch = { payment: nextPayment, ...ledgerPatch(ledger, now) }, warnings = [], writes = [], mirrors = [];
  if (!ledger.complete) warnings.push({ code: 'ledger_needs_review', message: 'The payment was recorded. Older payment records on this job need review before the ledger reconciles.', details: { issues: ledger.issues } });
  if (deposit) {
    const deposits = plain(job.deposit) ? job.deposit : {}, required = totals.depositRequiredCents, depositPaid = (moneyCents(deposits.paidAmount) ?? 0) + amount;
    if (required === null) throw fail('total_unknown', 'The deposit terms must be readable before a deposit is recorded. Review this job.', 409, { issues: totals.issues });
    patch.deposit = { ...deposits, amount: required / 100, paidAmount: depositPaid / 100, status: depositPaid >= required ? 'paid' : 'partial', receivedAt, reference, method: input.method, verified: true };
    if (amount > totals.depositDueCents) warnings.push({ code: 'deposit_exceeds_due', message: `More than the ${usd(totals.depositDueCents)} deposit due was recorded as a deposit.` });
  } else {
    const invoice = plain(job.invoice) ? job.invoice : {};
    if (['void', 'superseded'].includes(invoice.status)) warnings.push({ code: 'invoice_not_active', message: 'The payment was recorded. The job has no active invoice; issue one to show the new balance.' });
    else {
      const numbered = await reserveNumber(store, job, now);
      writes.push(...numbered.writes); warnings.push(...numbered.warnings);
      patch.invoice = { ...invoice, number: numbered.number, status: balanceCents === 0 ? 'paid' : 'partial', amount: totals.totalCents / 100, amountCents: totals.totalCents, paid: appliedCents / 100, paidCents: appliedCents, balance: balanceCents / 100, balanceCents, updatedAt: now };
      // A display mirror, as the legacy tool's set-merge was: it never holds the job commit back.
      if (safeId(job.customerId)) mirrors.push({ collection: 'customers', id: job.customerId, exists: true, patch: { latestJobId: job.id, lastPaymentStatus: patch.invoice.status, lastPaymentBalance: balanceCents / 100, paymentUpdatedAt: now, updatedAt: now } });
    }
    // A prepaid job stays on the schedule; only finished work closes as paid.
    if (balanceCents === 0 && (['completed', 'invoiced'].includes(stage(job)) || job.completedAt)) Object.assign(patch, { status: 'paid', pipelineStatus: 'paid' });
  }
  return { patch, writes, mirrors, warnings, reason: `${usd(amount)} ${input.method} ${reference}` };
};

const ISSUE_MESSAGES = { money_line_items_mismatch: 'The saved lines did not add up to the quote, so the invoice shows one line for the quoted amount.', money_line_items_incomplete: 'Some saved lines could not be read, so the invoice shows one line for the quoted amount.' };
async function issueInvoice({ store, job, input, actor, now, today }) {
  if (closed(job)) throw fail('job_closed', 'A cancelled job cannot be invoiced.', 409);
  if (!validDate(input.dueDate) || input.dueDate < today) throw fail('invalid_due_date', 'Choose a payment due date of today or later.');
  const customerReference = input.customerReference === undefined ? undefined : text(input.customerReference, 'The customer reference', 120);
  const previous = plain(job.invoice) ? job.invoice : {}, numbered = await reserveNumber(store, job, now);
  const { invoice, issues } = invoiceFromEstimate({ ...job, invoice: { ...previous, number: numbered.number } }, { now, dueDate: input.dueDate, customerReference });
  const fresh = invoice.issuedAt === instant(now), warnings = [...numbered.warnings, ...issues.map(code => ({ code: code.replace(/^money_/, ''), message: ISSUE_MESSAGES[code] || 'Review the job money before sending this invoice.' }))];
  if (!approved(job.estimate?.status) && !approved(job.customerApproval?.status)) warnings.push({ code: 'estimate_not_approved', message: 'The estimate has no recorded customer approval.' });
  const patch = { invoice: { ...invoice, issuedBy: fresh ? actor.user : previous.issuedBy || actor.user, updatedBy: actor.user } };
  if (stage(job) === 'completed') patch.status = 'invoiced';
  return { patch, writes: numbered.writes, warnings };
}

function voidInvoice({ job, input, actor, now }) {
  const invoice = plain(job.invoice) ? job.invoice : null;
  if (!invoice || !(invoice.status || invoice.issuedAt || given(invoice.amount))) throw fail('invoice_missing', 'There is no issued invoice to void.', 409);
  if (['void', 'superseded'].includes(invoice.status)) throw fail('invoice_not_active', 'This invoice is already void or superseded.', 409);
  const reason = text(input.reason, 'A reason for voiding', 500, { required: true, min: 3 }), totals = customerMoneyTotals(job);
  const patch = { invoice: { ...invoice, status: 'void', voidedAt: now, voidedBy: actor.user, voidReason: reason, updatedAt: now } };
  if (job.status === 'invoiced') patch.status = 'completed';
  if (job.pipelineStatus === 'invoiced') patch.pipelineStatus = 'completed';
  return { patch, warnings: totals.appliedCents > 0 ? [{ code: 'payments_kept', message: 'Recorded payments stay on the job. Issue a new invoice to apply them.' }] : [], reason };
}

// A billed change-order line (change-orders.js) that was priced or approved
// by mistake: the line and its decision stay as evidence, marked void, and an
// issued invoice that still matches the job's money drops to the new total in
// the same commit. Money already paid for it stays recorded (refund it apart).
function voidChange({ job, input, actor, now }) {
  if (typeof input.changeOrderId !== 'string' || !/^change-[A-Za-z0-9_-]{1,60}$/.test(input.changeOrderId)) throw fail('request_invalid', 'Choose an approved change to void.');
  const reason = text(input.reason, 'A reason for voiding', 500, { required: true, min: 3 });
  const planned = voidChangeOrder(job, input.changeOrderId, { reason, by: actor.user, now });
  if (!planned) throw fail('change_order_missing', 'This change is no longer billed on the job. Refresh the job money.', 409);
  const before = customerMoneyTotals(job), after = customerMoneyTotals({ ...job, ...planned.patch }), patch = { ...planned.patch }, warnings = [];
  const invoice = plain(job.invoice) ? job.invoice : null, status = String(invoice?.status || '').toLowerCase();
  if (invoice && given(invoice.amount) && !['draft', 'void', 'superseded'].includes(status)) {
    if (before.totalCents !== null && moneyCents(invoice.amount) === before.totalCents && after.totalCents !== null && after.appliedCents !== null) {
      const balanceCents = Math.max(0, after.totalCents - after.appliedCents), next = { ...invoice, amount: after.totalCents / 100, balance: balanceCents / 100, updatedAt: now };
      // The invoice's paid figure is brought to the recorded payments the balance was computed from (it goes stale when a payment is recorded after the invoice):
      // money-core's applied payments (tips excluded), the figure a portal approval raises the invoice with (raisedInvoice), and only when money-core can read them.
      if (given(invoice.paid)) next.paid = after.appliedCents / 100;
      if (Number.isSafeInteger(invoice.paidCents)) next.paidCents = after.appliedCents;
      if (Number.isSafeInteger(invoice.amountCents)) next.amountCents = after.totalCents;
      if (Number.isSafeInteger(invoice.balanceCents)) next.balanceCents = balanceCents;
      if (Number.isSafeInteger(invoice.approvedChangeCents)) next.approvedChangeCents = after.approvedChangeCents;
      if (Array.isArray(invoice.lineItems)) {
        next.lineItems = invoice.lineItems.filter(item => item?.id !== planned.line.id);
        if (next.lineItems.length === invoice.lineItems.length) warnings.push({ code: 'invoice_lines_stale', message: 'The invoice total was lowered, but its lines did not list this change. Issue the invoice again to refresh its lines.' });
      }
      if (balanceCents === 0 && ['issued', 'partial', 'overdue'].includes(status)) next.status = job.payment?.verified === true ? 'paid' : 'pending_verification';
      patch.invoice = next;
    } else warnings.push({ code: 'invoice_not_updated', message: 'The issued invoice did not match this job\'s money, so it was left as it was. Issue the invoice again to show the new total.' });
  }
  if (after.overpaidCents > 0) warnings.push({ code: 'payments_exceed_total', message: `Recorded payments are ${usd(after.overpaidCents)} more than the new total. The payments were kept; refund the difference and review them.` });
  return { patch, warnings, reason: `${usd(planned.line.totalCents)} ${planned.line.name}: ${reason}` };
}

// Labor dollars are owner-only (JOB-COST-PRIVACY): a viewer who does not see them saves the other five costs, and
// any laborCents or expectedLaborRevision from them is refused by its presence alone, never compared with the saved
// figure. Their save moves an older labor copy off the job into the private record, except a copy that needs the
// owner's review (unreadable, or copies that disagree) or is only blank: that one stays on the job as it was.
// A viewer who sees labor dollars saves labor to the private record. expectedLaborRevision is the record revision
// /api/job-labor-costs gave (null: no record); a record saved meanwhile from another screen is a
// money_labor_revision_conflict, never silently overwritten. Once a record exists the owner-only mode requires it for
// a figure that differs from the saved one (money_labor_revision_required); resending the saved figure needs none,
// since it cannot overwrite a newer one.
// With EGC_STAFF_PAY_OWNER_ONLY=false (actor.laborOnJob) the job keeps today's costs map, labor included, every labor
// save also changes the job revision, and the record gets the same figure.
async function saveCosts({ store, job, input, actor, now }) {
  const visible = laborCostVisible(actor), onJob = visible && laborOnJob(actor), costs = input.costs, keys = (visible ? COST_KEYS : OTHER_COST_KEYS).map(key => `${key}Cents`);
  if (!visible && (plain(costs) && Object.hasOwn(costs, 'laborCents') || Object.hasOwn(input, 'expectedLaborRevision'))) throw fail('labor_owner_only', 'Only the owner enters labor cost. Save the other direct costs; the saved labor figure stays as it is.', 403);
  if (!plain(costs) || Object.keys(costs).length !== keys.length || keys.some(key => !Object.hasOwn(costs, key))) throw fail('invalid_costs', visible ? 'Enter every direct cost: labor, disposal, materials, fuel, processing and other.' : 'Enter every direct cost except labor: disposal, materials, fuel, processing and other.');
  const saved = { recordedAt: now, recordedBy: actor.user, source: 'egc_hub' };
  for (const key of onJob ? COST_KEYS : OTHER_COST_KEYS) { const cents = whole(costs[`${key}Cents`], `The ${key} cost`, 0, MAX_TOTAL_CENTS); saved[key] = cents / 100; saved[`${key}Cents`] = cents; }
  const labor = visible ? whole(costs.laborCents, 'The labor cost', 0, MAX_TOTAL_CENTS) : null;
  const record = await store.read(JOB_LABOR_COSTS, job.id), legacy = legacyJobLabor(job), before = record ? record.laborCents : legacy.state === 'value' ? legacy.cents : null;
  if (visible && Object.hasOwn(input, 'expectedLaborRevision') && (record?.revision ?? null) !== input.expectedLaborRevision) throw fail('labor_revision_conflict', 'The labor cost changed after you opened it. Refresh and review the latest figure before saving.', 409);
  if (visible && !Object.hasOwn(input, 'expectedLaborRevision') && record && !onJob && labor !== record.laborCents) throw fail('labor_revision_required', 'This job has a saved labor cost. Send expectedLaborRevision (from /api/job-labor-costs) with the figure you saw to change it.', 409);
  const recordWrite = () => ({ collection: JOB_LABOR_COSTS, id: job.id, ...(record ? { revision: record.revision } : {}), patch: laborRecordPatch(job.id, labor, { recordedAt: now, recordedBy: actor.user, source: 'egc_hub', requestId: input.requestId }) });
  // Labor cost reveals pay, so its audit snapshot is owner-only.
  const plan = (patchCosts, remove, writes, after) => ({ patch: { costs: patchCosts }, remove, writes, warnings: [], visibility: 'owner', labor: { before: before ?? null, after: after ?? null } });
  if (onJob) return plan(saved, [], [recordWrite()], labor);
  // The job's costs map is replaced without labor, so only the older top-level copy needs removing.
  if (visible) return plan(saved, legacy.fields.filter(path => !path.startsWith('costs.')), [recordWrite()], labor);
  const move = legacyLaborMove(job, record, now);
  if (move.keep) {
    // Kept exactly as it was: the replaced costs map carries the copy over, and laborCost is not touched.
    for (const key of ['labor', 'laborCents']) if (plain(job.costs) && job.costs[key] !== undefined) saved[key] = job.costs[key];
    return plan(saved, [], [], before);
  }
  return plan(saved, move.remove.filter(path => !path.startsWith('costs.')), move.writes, record ? record.laborCents : move.writes.length ? move.writes[0].patch.laborCents : before);
}

const PLANS = { 'estimate.save': saveEstimate, 'estimate.record_approval': recordApproval, 'estimate.mark_sent': markSent, 'deposit.record_offline': recordOffline('deposit'), 'payment.record_offline': recordOffline('payment'), 'invoice.issue': issueInvoice, 'invoice.void': voidInvoice, 'change_order.void': voidChange, 'costs.save': saveCosts };

/**
 * Money fields for the audit trail: no signatures, notes or contact details.
 * Direct costs (labor cost reveals pay) are included only with `costs`, which
 * only the owner-only costs.save entry passes, with the labor figure it read
 * from the private record as `laborCents`.
 */
export function moneySnapshot(job, { costs = false, laborCents } = {}) {
  const estimate = pick(job.estimate, ['number', 'status', 'revision', 'amount', 'depositRequired', 'validUntil', 'scope', 'sentAt', 'sentChannel', 'acceptedAt', 'acceptedBy', 'acceptanceMethod']);
  if (estimate && Array.isArray(job.estimate.lineItems)) estimate.lines = job.estimate.lineItems.slice(0, 20).map(line => pick(line, ['id', 'name', 'quantity', 'amount']));
  return { status: job.status ?? null, pipelineStatus: job.pipelineStatus ?? null, quoteStatus: job.quoteStatus ?? null, total: job.total ?? null, estimate,
    customerApproval: pick(job.customerApproval, ['status', 'approvedAt', 'approvedBy', 'amount', 'source', 'supersededAt', 'reason']), deposit: pick(job.deposit, ['amount', 'paidAmount', 'status', 'reference', 'method', 'verified']),
    payment: pick(job.payment, ['amount', 'lastAmount', 'lastReceivedAt', 'method', 'reference', 'verified', 'recordedBy']), invoice: pick(job.invoice, ['number', 'status', 'amount', 'paid', 'balance', 'dueDate', 'issuedAt', 'voidedAt', 'voidReason', 'supersededAt']),
    ...(Array.isArray(job.changeOrders) ? { approvedChangeTotal: job.approvedChangeTotal ?? null, changeOrders: job.changeOrders.slice(0, 50).map(line => pick(line, ['id', 'decisionId', 'totalCents', 'approvedAt', 'status', 'voidedAt', 'voidReason'])) } : {}),
    ...(costs ? { costs: snapshotCosts(job, laborCents) } : {}), paymentLedger: Array.isArray(job.paymentLedger) ? job.paymentLedger.slice(0, 50).map(row => pick(row, ['id', 'kind', 'amountCents', 'method', 'at'])) : null };
}

function snapshotCosts(job, laborCents) {
  const costs = pick(job.costs, [...COST_KEYS, 'recordedAt', 'recordedBy']);
  return laborCents === undefined ? costs : { ...costs, labor: laborCents === null ? null : laborCents / 100 };
}

// The lines and total invoice.issue would save right now (the same
// invoiceLineItems call invoiceFromEstimate makes), so the Hub previews exactly
// what gets issued, change orders and the one-line fallback included.
function invoicePreview(job, totals) {
  if (!Number.isSafeInteger(totals.totalCents) || totals.totalCents <= 0) return null;
  try {
    const { lineItems, issues } = invoiceLineItems(job, totals);
    return { lineItems: lineItems.map(line => ({ id: str(line.id), name: str(line.name, 160) || '', quantity: line.quantity, totalCents: line.totalCents })), totalCents: totals.totalCents, notices: issues.map(code => ISSUE_MESSAGES[code]).filter(Boolean) };
  } catch { return null; }
}

const projectEntry = row => ({ id: row.id, kind: row.kind, amountCents: row.amountCents, method: row.method, processorRef: row.processorRef || '', at: row.at, by: row.by, verified: row.verified, source: row.source });

/**
 * The costs a viewer gets (JOB-COST-PRIVACY): labor from the private record, else the job's legacy copy; for a
 * viewer who does not see labor dollars laborCents is null (never 0) with laborCostHidden:true. No costs stay null.
 */
function costsProjection(job, laborRecord, laborHidden) {
  const costs = plain(job.costs) ? job.costs : null, record = !laborHidden && plain(laborRecord) ? laborRecord : null;
  if (!costs && !record) return null;
  const figure = key => !costs ? null : Number.isSafeInteger(costs[`${key}Cents`]) ? costs[`${key}Cents`] : moneyCents(costs[key]);
  const labor = laborHidden ? null : record ? (validLaborCents(record.laborCents) ? record.laborCents : null) : figure('labor');
  return { ...Object.fromEntries(COST_KEYS.map(key => [`${key}Cents`, key === 'labor' ? labor : figure(key)])), recordedAt: str(costs ? costs.recordedAt : record.recordedAt, 40), recordedBy: str(costs ? costs.recordedBy : record.recordedBy, 120), ...(laborHidden ? { laborCostHidden: true } : {}) };
}

/** What moneyProjection needs to show this viewer's labor: the private record is read only for a viewer who sees labor dollars. */
export async function moneyLaborView(store, actor, jobId) {
  return laborCostVisible(actor) ? { laborRecord: await store.read(JOB_LABOR_COSTS, jobId) } : { laborHidden: true };
}

/** Business-manager DTO for one job's money (integer cents; an allowlist, never the raw job). */
export function moneyProjection(job, now, { laborRecord = null, laborHidden = false } = {}) {
  const totals = customerMoneyTotals(job), estimate = plain(job.estimate) ? job.estimate : null, invoice = plain(job.invoice) ? job.invoice : null;
  const lines = legacyLineItems(job, { record: 'estimate', surface: 'invoice', totalCents: totals.quoteCents }), ledger = reconcileLedger(job);
  return {
    id: job.id, revision: job.revision, customerId: str(job.customerId), customer: str(job.customer), serviceType: str(job.serviceType), date: str(job.date, 10), status: stage(job) || null, notify: job.notify !== false,
    totals: pick(totals, TOTAL_KEYS),
    estimate: estimate ? { number: str(estimate.number), status: str(estimate.status) || 'draft', revision: Number.isSafeInteger(estimate.revision) ? estimate.revision : null, scope: str(estimate.scope, 1600) || '', validUntil: validDate(estimate.validUntil) ? estimate.validUntil : null,
      termsVersion: str(estimate.termsVersion), sentAt: str(estimate.sentAt, 40), sentChannel: str(estimate.sentChannel, 20), acceptedAt: str(estimate.acceptedAt, 40), acceptedBy: str(estimate.acceptedBy, 120), fingerprint: estimateFingerprint(estimate) } : null,
    lineItems: lines.lineItems.map(line => ({ ...customerLineItem(line), customerSupplied: line.customerSupplied === true, grouped: Boolean(line.group) })), linesComplete: !lines.issues.length,
    approval: pick(job.customerApproval, ['status', 'approvedAt', 'approvedBy', 'source', 'supersededAt', 'reason', 'estimateRevision']),
    invoice: { status: invoiceStatus(job, now), savedStatus: str(invoice?.status), number: str(invoice?.number), amountCents: Number.isSafeInteger(invoice?.amountCents) ? invoice.amountCents : moneyCents(invoice?.amount), dueDate: validDate(invoice?.dueDate) ? invoice.dueDate : null,
      issuedAt: str(invoice?.issuedAt, 40), customerReference: str(invoice?.customerReference, 120), voidedAt: str(invoice?.voidedAt, 40), voidReason: str(invoice?.voidReason, 500) },
    invoicePreview: invoicePreview(job, totals),
    // Changes the customer approved in the portal that are billed on top of the quote (a manager can void one).
    changeOrders: billedChangeOrders(job).map(line => ({ id: line.id, name: str(line.name, 160) || '', totalCents: line.totalCents, approvedAt: str(line.approvedAt, 40), approvedBy: str(line.approvedBy, 120), backfilled: line.backfilled === true })),
    payments: ledger.entries.map(projectEntry), ledger: { stored: ledger.stored, complete: ledger.complete, legacyCents: ledger.legacyCents, unreconciledCents: ledger.unreconciledCents, issues: ledger.issues },
    costs: costsProjection(job, laborRecord, laborHidden),
  };
}

const result = async (store, actor, input, job, warnings, replayed, now) => ({ ok: true, authority: 'employee_hub', requestId: input.requestId, action: input.action, replayed, job: moneyProjection(job, now, await moneyLaborView(store, actor, job.id)), warnings });

// True when a new invoice number this plan reserves is now held by another job.
async function numberTaken(store, writes, job) {
  for (const write of writes) if (write.collection === INVOICE_NUMBERS) { const row = await store.read(INVOICE_NUMBERS, write.id).catch(() => null); if (row && row.jobId !== job.id) return true; }
  return false;
}

async function execute(store, actor, input, now, fingerprint, receiptId, via, retried = false) {
  const job = await store.read('jobs', input.jobId);
  if (!moneyJob(job)) throw fail('job_not_found', 'This job is not available for money changes.', 404);
  if (typeof job.revision !== 'string' || !job.revision) throw fail('storage_incomplete', 'The job has no verifiable revision. Retry.', 503);
  if (job.revision !== input.expectedRevision) throw fail('revision_conflict', 'This job changed after you opened it. Refresh and review the latest money details.', 409);
  const plan = await PLANS[input.action]({ store, job, input, actor, now, today: denverToday(new Date(now)) });
  const patch = { ...plan.patch, moneyRequestId: input.requestId, moneyUpdatedAt: now, updatedAt: now }, warnings = plan.warnings || [], owner = plan.visibility === 'owner';
  const audit = auditWrite({ actor: { id: actor.user, kind: 'human', role: actor.role }, via, action: `money.${input.action}`, entity: { collection: 'jobs', id: job.id }, before: moneySnapshot(job, { costs: owner, laborCents: plan.labor?.before }), after: moneySnapshot({ ...job, ...patch }, { costs: owner, laborCents: plan.labor?.after }), requestId: input.requestId, reason: plan.reason ?? null, visibility: owner ? 'owner' : 'business', now });
  try {
    await store.commit([
      { collection: 'jobs', id: job.id, revision: job.revision, patch, ...(plan.remove?.length ? { remove: plan.remove } : {}) },
      ...(plan.writes || []),
      { collection: MONEY_RECEIPTS, id: receiptId, patch: { fingerprint, actorId: actor.user, action: input.action, jobId: job.id, requestId: input.requestId, via, auditId: audit.id, warnings, createdAt: now } },
      audit,
    ]);
  } catch (error) {
    // Another job claimed the new invoice number after it was read; the job
    // itself may be unchanged, so plan once more (the revision check still applies).
    if (error.code === 'money_revision_conflict' && await numberTaken(store, plan.writes || [], job)) {
      if (!retried) return execute(store, actor, input, now, fingerprint, receiptId, via, true);
      throw fail('invoice_number_unavailable', 'Another job took the same new invoice number while this was saving. Nothing was saved. Retry the same request.', 503);
    }
    throw error;
  }
  // Best effort: a failed customer mirror never undoes or repeats the saved money.
  if (plan.mirrors?.length) try { await store.commit(plan.mirrors); } catch { /* the job already holds the payment */ }
  const saved = await store.read('jobs', job.id);
  if (!saved) throw fail('outcome_unknown', 'The saved job could not be read back. Retry the same request.', 503);
  if (saved.moneyRequestId !== input.requestId) throw fail('changed_since_operation', 'The money change saved, but the job has changed again. Refresh to review it.', 409);
  return result(store, actor, input, saved, warnings, false, now);
}

export async function mutateMoney(store, actor, input, now = new Date().toISOString()) {
  requireMoneyManager(actor);
  validate(input, actor);
  const fingerprint = await digest({ actor: actor.user, input }), receiptId = input.requestId.toLowerCase(), via = actor.via === 'mcp' ? 'mcp' : 'hub';
  async function replay(replayed) {
    const receipt = await store.read(MONEY_RECEIPTS, receiptId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.actorId !== actor.user) throw fail('idempotency_conflict', 'This request ID was already used for a different money change. Refresh before saving.', 409);
    const job = await store.read('jobs', receipt.jobId);
    if (!job || job.moneyRequestId !== input.requestId) throw fail('changed_since_operation', 'That money change was saved, but the job has changed since. Refresh to see its current state.', 409);
    return result(store, actor, input, job, receipt.warnings || [], replayed, now);
  }
  const prior = await replay(true);
  if (prior) return prior;
  try { return await execute(store, actor, input, now, fingerprint, receiptId, via); }
  catch (error) {
    if (FINAL.has(error.code)) throw error;
    // A lost commit response (or a racing copy of this request) may have saved: the receipt is the proof.
    const recovered = await replay(false).catch(replayError => { if (FINAL.has(replayError.code)) throw replayError; return null; });
    if (recovered) return recovered;
    throw error;
  }
}
