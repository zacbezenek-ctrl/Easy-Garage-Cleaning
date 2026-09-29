import { MONEY_RECEIPTS, moneyJob, mutateMoney, paymentNeedsVerification, requireMoneyManager } from './money-service.js';
import { customerMoneyTotals, invoiceStatus } from './money-core.js';
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { businessAccountJob } from './portal-invitation.js';
import { hubRecordEligibility } from './funnel-definitions.js';
import { jobberGuardBillingError, jobberGuardHoldView, jobberGuardHolds, jobberGuardSwitches, readJobberGuardState } from './jobber-guard.js';

/**
 * M6 batch invoicing over the M3 money service:
 *   listInvoiceBatch(store, actor, now)      one masked jobs scan (store.jobs())
 *   issueInvoiceBatch(store, actor, input, now, {left})
 * Each selected job is issued through mutateMoney invoice.issue with its own
 * request ID derived (RFC 4122 v5) from the batch request ID and the job ID,
 * so a replayed batch replays each job's receipt instead of issuing again, and
 * one job's conflict or failure never blocks the others. The batch itself has
 * a create-only moneyOperations receipt (sha256 of {actor, dueDate, items}),
 * so the same batch ID with another payload is refused. Nothing here sends a
 * message or writes to HighLevel: the Hub's Invoicing screen starts each issued
 * invoice's HighLevel lifecycle trigger (egc-invoice-issued) through the same
 * suite helper as the standard finance save, and HighLevel sends the invoice.
 * The FUN-32 billing hold (EGC_JOBBER_GUARD_BILLING) refuses a held job here
 * exactly as /api/money refuses its invoice.issue. As there, a saved request
 * replays first: a batch whose receipt matches skips the due-date check (its
 * due date may have passed since Denver midnight) and reads the hold only for
 * a job it has not issued yet, so a lost answer always gets its invoices back.
 */
export const BATCH_MAX_ITEMS = 25;
// Store calls one job may use: 7 normally, 13 when another job takes the new
// invoice number mid-save and invoice.issue re-plans (then gives up) once.
export const BATCH_ITEM_COST = 13;
export const BATCH_RECEIPT_KIND = 'invoice.batch';
// A fixed namespace for v5 request IDs of batch invoice items.
const NAMESPACE = 'd2b6f0c4-6a1e-4b5e-9c3d-7f1a2e9b4c60';
const BATCH_KEYS = ['action', 'requestId', 'dueDate', 'items'];
const ITEM_KEYS = ['jobId', 'expectedRevision'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOSED = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'no-show', 'superseded', 'lost']);
// Invoice states that may be (re)issued; every other state is an active invoice.
const ISSUABLE = new Set(['not_issued', 'void', 'superseded', 'draft']);
const OPEN = new Set(['issued', 'partial', 'overdue']);
export const BATCH_REASONS = Object.freeze({
  job_not_found: 'This job is no longer available.',
  not_customer_job: 'This record is not a customer job.',
  test_job: 'Test jobs are never invoiced.',
  job_closed: 'Cancelled jobs are never invoiced.',
  already_invoiced: 'This job already has an active invoice.',
  not_completed: 'The job is not completed yet.',
  money_needs_review: 'The quote or payments on this job need review before it can be invoiced.',
  payment_needs_review: 'A recorded payment on this job is waiting for verification.',
  nothing_due: 'Nothing is owed on this job.',
});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const fail = (reason, message, status = 400, details) => Object.assign(new Error(message), { code: `money_${reason}`, status, ...(details ? { details } : {}) });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))));
const stage = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const str = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const approved = value => ['accepted', 'approved'].includes(String(value || '').toLowerCase());
const reason = why => ({ eligible: false, reason: why });
// Test records are whatever the shared funnel definitions flag as test (FUN-01).
const testJob = job => hubRecordEligibility(job).isTest;

/** RFC 4122 version 5 UUID of `${batchRequestId}:${jobId}` in the EGC batch namespace. */
export async function batchItemRequestId(batchRequestId, jobId) {
  const space = Uint8Array.from(NAMESPACE.replace(/-/g, '').match(/../g), pair => parseInt(pair, 16));
  const name = new TextEncoder().encode(`${String(batchRequestId).toLowerCase()}:${jobId}`), data = new Uint8Array(space.length + name.length);
  data.set(space); data.set(name, space.length);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', data)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const text = hex(bytes);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/**
 * Whether a job can be invoiced now: a customer job (not a test, cancelled or
 * private record) whose work is completed or closing, whose money is readable
 * and verified, with a balance and no active invoice. `now` is an ISO instant.
 */
export function invoiceEligibility(job, now) {
  if (!job) return reason('job_not_found');
  if (!moneyJob(job)) return reason('not_customer_job');
  if (testJob(job)) return reason('test_job');
  if (CLOSED.has(stage(job))) return reason('job_closed');
  const status = invoiceStatus(job, now), totals = customerMoneyTotals(job);
  if (!ISSUABLE.has(status)) return { ...reason('already_invoiced'), status, totals };
  if (totals.purpose !== 'balance') return { ...reason('not_completed'), status, totals };
  if ([totals.totalCents, totals.appliedCents, totals.balanceCents].includes(null)) return { ...reason('money_needs_review'), status, totals };
  if (paymentNeedsVerification(job)) return { ...reason('payment_needs_review'), status, totals };
  if (!(totals.balanceCents > 0)) return { ...reason('nothing_due'), status, totals };
  return { eligible: true, status, totals };
}

const invoiceView = job => {
  const invoice = plain(job?.invoice) ? job.invoice : {};
  return { number: str(invoice.number, 80), savedStatus: str(invoice.status, 40), dueDate: validDate(invoice.dueDate) ? invoice.dueDate : '', issuedAt: str(invoice.issuedAt, 40) };
};

/**
 * Manager lists for the batch screen: jobs ready to invoice, closing jobs that
 * need review, and issued invoices still owed (read-only). `automaticReminders`
 * is the job's customerAutomationEnabled (the suite's Enable auto): without it
 * the Hub never adds the egc-invoice-overdue tag, and invoice.issue does not
 * turn it on (an open owner decision), so the screen says so on each row.
 */
export async function listInvoiceBatch(store, actor, now = new Date().toISOString()) {
  requireMoneyManager(actor);
  const jobs = await store.jobs();
  if (!Array.isArray(jobs)) throw fail('storage_incomplete', 'The complete job money records could not be loaded. Retry.', 503);
  const candidates = [], review = [], open = [];
  for (const job of jobs) {
    if (!moneyJob(job) || testJob(job) || CLOSED.has(stage(job))) continue;
    const check = invoiceEligibility(job, now), base = { jobId: job.id, revision: job.revision, customerId: str(job.customerId), customer: str(job.customer, 120), serviceDate: str(job.date, 10), status: stage(job) || null, businessAccount: businessAccountJob(job), notify: job.notify !== false, automaticReminders: job.customerAutomationEnabled === true };
    if (check.eligible) candidates.push({ ...base, totalCents: check.totals.totalCents, paidCents: check.totals.appliedCents, balanceCents: check.totals.balanceCents, invoiceStatus: check.status, estimateApproved: approved(job.estimate?.status) || approved(job.customerApproval?.status) });
    else if (['money_needs_review', 'payment_needs_review'].includes(check.reason)) review.push({ ...base, reason: check.reason, message: BATCH_REASONS[check.reason] });
    else if (check.reason === 'already_invoiced' && OPEN.has(check.status) && check.totals.balanceCents > 0 && !paymentNeedsVerification(job)) {
      open.push({ ...base, invoice: invoiceView(job), invoiceStatus: check.status, balanceCents: check.totals.balanceCents });
    }
  }
  const byDate = (a, b) => String(a.serviceDate).localeCompare(String(b.serviceDate)) || a.customer.localeCompare(b.customer) || a.jobId.localeCompare(b.jobId);
  candidates.sort(byDate); review.sort(byDate);
  open.sort((a, b) => String(a.invoice.dueDate).localeCompare(String(b.invoice.dueDate)) || byDate(a, b));
  return { ok: true, authority: 'employee_hub', asOf: now, coverage: { complete: true, asOf: now }, today: denverToday(new Date(now)), defaultDueDate: addDays(denverToday(new Date(now)), 7), limits: { maxItems: BATCH_MAX_ITEMS }, candidates, review, open };
}

const pastDue = () => fail('invalid_due_date', 'Choose a payment due date of today or later.');
// The batch's shape. Whether its due date is still today or later is checked
// only for a new batch (issueInvoiceBatch): a saved one replays as it was.
function validate(input) {
  if (!plain(input) || Object.keys(input).some(key => !BATCH_KEYS.includes(key))) throw fail('batch_invalid', 'This batch contains unsupported fields. Refresh and try again.');
  if (input.action !== 'issue' || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) throw fail('batch_invalid', 'Use the issue action with a unique request ID.');
  if (!validDate(input.dueDate)) throw pastDue();
  if (!Array.isArray(input.items) || !input.items.length) throw fail('batch_invalid', 'Choose at least one job to invoice.');
  if (input.items.length > BATCH_MAX_ITEMS) throw fail('batch_too_large', `Issue at most ${BATCH_MAX_ITEMS} invoices at a time.`);
  const seen = new Set();
  for (const item of input.items) {
    if (!plain(item) || Object.keys(item).some(key => !ITEM_KEYS.includes(key)) || !safeId(item.jobId) || typeof item.expectedRevision !== 'string' || !item.expectedRevision || item.expectedRevision.length > 100) throw fail('batch_invalid', 'Each job needs its ID and the revision you reviewed.');
    if (seen.has(item.jobId)) throw fail('batch_invalid', 'A job can appear only once in a batch.');
    seen.add(item.jobId);
  }
}

/** The batch's saved receipt, read before anything else: `saved` is true for a replay of this same batch; another payload under its ID is refused. */
async function batchReceipt(store, actor, input) {
  const id = input.requestId.toLowerCase(), fingerprint = await digest({ actor: actor.user, dueDate: input.dueDate, items: input.items });
  const check = saved => {
    if (!saved) return false;
    if (saved.kind !== BATCH_RECEIPT_KIND || saved.fingerprint !== fingerprint || saved.actorId !== actor.user) throw fail('idempotency_conflict', 'This batch ID was already used for a different batch. Refresh before issuing.', 409);
    return true;
  };
  return { id, fingerprint, check, saved: check(await store.read(MONEY_RECEIPTS, id)) };
}

/** Writes a new batch's create-only receipt; false when this call wrote it, true when a racing or lost copy already had. */
async function claimBatch(store, actor, input, now, { id, fingerprint, check }) {
  const receipt = { kind: BATCH_RECEIPT_KIND, action: 'invoice.batch_issue', requestId: input.requestId, fingerprint, actorId: actor.user, dueDate: input.dueDate, jobIds: input.items.map(item => item.jobId), createdAt: now };
  try { await store.commit([{ collection: MONEY_RECEIPTS, id, patch: receipt }]); return false; }
  catch (error) {
    // A racing or lost copy of this batch may have written it: its receipt is the proof.
    if (check(await store.read(MONEY_RECEIPTS, id).catch(() => null))) return true;
    throw error;
  }
}

const moneyError = error => /^money_[a-z_]+$/.test(error?.code || '')
  ? { code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) }
  : { code: 'money_unavailable', error: 'This invoice could not be verified. Retry the same batch; it will not issue a second invoice.' };

async function issueOne(store, actor, batch, item, now, hold) {
  const requestId = await batchItemRequestId(batch.requestId, item.jobId), row = { jobId: item.jobId, requestId };
  let receipt = null;
  try {
    receipt = await store.read(MONEY_RECEIPTS, requestId.toLowerCase());
    // A replayed item goes straight to its receipt; a new one is re-checked
    // against the saved job, never the list the manager loaded.
    if (!receipt) {
      const job = await store.read('jobs', item.jobId), check = invoiceEligibility(job, now);
      if (!check.eligible) return { ...row, ok: false, code: 'money_batch_not_eligible', error: BATCH_REASONS[check.reason], details: { reason: check.reason } };
      // FUN-32: the billing hold refuses this job's invoice.issue, as /api/money does.
      const billing = await hold(), held = billing ? jobberGuardHolds(billing, 'billing', { customerId: job.customerId, jobId: job.id }) : [];
      if (held.length) return { ...row, ok: false, code: 'money_jobber_billing_hold', error: jobberGuardBillingError(held), details: { checkedAt: billing.checkedAt, findings: held.slice(0, 10).map(jobberGuardHoldView) } };
    }
    const result = await mutateMoney(store, actor, { action: 'invoice.issue', requestId, jobId: item.jobId, expectedRevision: item.expectedRevision, dueDate: batch.dueDate }, now);
    const invoice = result.job.invoice;
    return { ...row, ok: true, status: 'issued', replayed: result.replayed, revision: result.job.revision, customer: result.job.customer, invoice: { number: invoice.number, status: invoice.status, amountCents: invoice.amountCents, dueDate: invoice.dueDate, issuedAt: invoice.issuedAt }, balanceCents: result.job.totals.balanceCents, warnings: result.warnings };
  } catch (error) {
    // The invoice was issued by this batch; the job has changed since.
    if (error?.code === 'money_changed_since_operation') return { ...row, ok: true, status: 'issued', replayed: Boolean(receipt), changedSince: true, warnings: [{ code: 'changed_since', message: 'This invoice was issued; the job has changed since. Refresh to review it.' }] };
    return { ...row, ok: false, ...moneyError(error) };
  }
}

/**
 * The FUN-32 billing hold for one batch: the saved Jobber guard check while
 * EGC_JOBBER_GUARD_BILLING holds invoice.issue (switch on and the cutover day
 * reached), read once; null when nothing can hold (switch off, cutover not
 * reached, or no check saved for the deployed cutover day), as
 * jobberGuardInvoiceHolds decides for /api/money. An unreadable check throws,
 * so nothing is issued (fail closed).
 */
export async function batchBillingHold(store, env, now, { definitions } = {}) {
  const switches = jobberGuardSwitches(env, now, definitions);
  if (!switches.billing) return null;
  const state = await readJobberGuardState(store);
  return state && state.cutoverDate === switches.cutoverDate ? state : null;
}

/**
 * Issues invoices for the selected jobs, in order, one money request each.
 * `left` reports the remaining storage budget (Cloudflare subrequests); a job
 * is only started when a whole issue fits, otherwise it is reported as not
 * attempted and can be sent again in a new batch. `billing` loads the FUN-32
 * billing hold (batchBillingHold): for a new batch before anything is written
 * (an unreadable check refuses the whole batch); for a replay only when a job
 * it has not issued yet needs it (an unreadable check then fails only those
 * jobs, and the invoices the batch already issued still come back).
 */
export async function issueInvoiceBatch(store, actor, input, now = new Date().toISOString(), { left = () => Infinity, billing = async () => null } = {}) {
  requireMoneyManager(actor);
  validate(input);
  const receipt = await batchReceipt(store, actor, input);
  if (!receipt.saved && input.dueDate < denverToday(new Date(now))) throw pastDue();
  let loading = null;
  const hold = () => (loading ||= Promise.resolve().then(() => billing()));
  if (!receipt.saved) await hold();
  const replayed = receipt.saved || await claimBatch(store, actor, input, now, receipt), results = [];
  for (const item of input.items) {
    // A replay that has not read the hold yet keeps one more store call for it.
    if (left() < BATCH_ITEM_COST + (loading ? 0 : 1)) { results.push({ jobId: item.jobId, ok: false, code: 'money_batch_not_attempted', error: 'This job was not attempted in this batch. Issue it again in a new batch.' }); continue; }
    results.push(await issueOne(store, actor, input, item, now, hold));
  }
  const count = test => results.filter(test).length;
  return {
    ok: true, authority: 'employee_hub', requestId: input.requestId, action: 'issue', replayed, dueDate: input.dueDate, results,
    summary: { total: results.length, issued: count(row => row.ok), replayed: count(row => row.ok && row.replayed), failed: count(row => !row.ok && row.code !== 'money_batch_not_attempted'), notAttempted: count(row => row.code === 'money_batch_not_attempted') },
  };
}
