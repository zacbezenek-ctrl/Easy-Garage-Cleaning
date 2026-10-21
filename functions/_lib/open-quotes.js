/** Open quotes (office report, read only): every estimator quote that is out with the customer and not yet approved or
 * signed, how long it has waited, and each estimator's close rate. Nothing here writes, sends or reaches HighLevel.
 *
 * Source of truth: an estimator quote is a jobs row with a quoteDraft (quote-draft.js saveQuoteDraft, the walkthrough
 * quote and the guided quote builder alike). sendQuoteDraft stamps quoteDraft.sentAt / sentBy on every send, and a later
 * in-person signature (walkthrough-handoff.js) or portal approval leaves quoteDraft as it is, so quoteDraft.sentAt is the
 * one field every sent estimator quote keeps, closed or not. It is read with one range query (openQuotesWindow).
 *
 * Open: estimate.status 'sent' (the current revision is with the customer; a revision after a send is back to 'draft'
 *   and is not open until it is sent again), no approved or accepted decision, not declined, the job not cancelled or
 *   closed. Age is in Denver calendar days from the latest send. Buckets: 0-2, 3-7, 8-14, 15+ days, and expired (the
 *   valid-until date has passed, whatever the age). A quote's valid-until is at most 90 days after it was saved, so every
 *   quote sent before the OPEN_QUOTES_DAYS window has expired and the board leaves it out.
 * Draft prices waiting for the owner: the job is held for the owner's price approval (pricesPendingApproval), or its
 *   builder breakdown no longer passes the owner's current menu (composite-quote.js compositeApproval); null when the
 *   owner's menu could not be read.
 * Close rate per estimator, last 30 and 90 days, by the day a quote was sent: sent counts every estimator quote sent in the
 *   window (open, expired, revised or lost too) plus every walkthrough the estimator had signed on site (the
 *   walkthroughHandoffs receipts, walkthrough-handoff.js), which is sent and closed the same day (0 days). Closed counts
 *   the approved or signed ones. Days to close is the Denver days from the latest send to the approval or signature. A
 *   job counts once: a sent quote later signed in person is a sent quote that closed on the signature day. The estimator
 *   is the quote's author (quoteDraft.createdBy), else its sender; for an on-site signature, the employee who recorded it.
 * Money is integer cents. Customer names are plain text here; the screen renders them as text nodes, never as HTML. */
import { addDays, denverToday, validDate } from './dispatch-time.js';
import { pricesPendingApproval } from './quote-model.js';
import { compositeApproval } from './composite-quote.js';

export const OPEN_QUOTES_DAYS = 120;
export const CLOSE_RATE_WINDOWS = Object.freeze({ last30: 30, last90: 90 });
// The signed-handoff receipt fields this report reads (who signed which job when, and whether it was signed before).
export const OPEN_QUOTE_RECEIPT_FIELDS = Object.freeze(['kind', 'actorId', 'jobId', 'sourceWalkthroughId', 'createdAt', 'priorEstimate.status', 'priorAcceptance.acceptedAt']);
export const BUCKETS = Object.freeze([
  { id: 'fresh', label: '0–2 days', min: 0, max: 2 },
  { id: 'warm', label: '3–7 days', min: 3, max: 7 },
  { id: 'cooling', label: '8–14 days', min: 8, max: 14 },
  { id: 'cold', label: '15+ days', min: 15, max: Infinity },
  { id: 'expired', label: 'Expired' },
]);
// The fields this report reads from a quote job: no contact details, signatures, lines or notes.
export const OPEN_QUOTE_FIELDS = Object.freeze(['type', 'recordType', 'status', 'pipelineStatus', 'customer', 'sourceWalkthroughId', 'quoteStatus',
  'estimate.status', 'estimate.amountCents', 'estimate.amount', 'estimate.validUntil', 'estimate.acceptedAt', 'estimate.sentAt',
  'customerApproval.status', 'customerApproval.approvedAt', 'pricesPendingApproval.status',
  'quoteDraft.sentAt', 'quoteDraft.sentBy', 'quoteDraft.createdBy', 'quoteDraft.savedBy', 'quoteDraft.breakdown']);
const ID = /^[A-Za-z0-9_-]{1,180}$/;
const WORK = new Set(['job', 'cleanout', 'reorg']);
const CLOSED = new Set(['cancelled', 'canceled', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'noshow', 'no_show', 'no-show']);
const LOST = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'no-show']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = value => String(value || '').toLowerCase();
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const dayOf = iso => denverToday(new Date(iso));
/** Whole calendar days from date a to date b (YYYY-MM-DD), b on or after a gives 0 or more. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** The report window for a Denver day: the open-quote and close-rate floors (inclusive) and the ISO time the query reads from. */
export function openQuotesWindow(today) {
  const start = addDays(today, -(OPEN_QUOTES_DAYS - 1));
  // A Denver day starts at 06:00 or 07:00 UTC, so reading from the UTC midnight before it and filtering by the Denver
  // send day never misses a quote sent on the first day.
  const since = `${start}T00:00:00.000Z`;
  return { today, start, since, last30: addDays(today, -(CLOSE_RATE_WINDOWS.last30 - 1)), last90: addDays(today, -(CLOSE_RATE_WINDOWS.last90 - 1)) };
}

/** Whether a job's quote has a customer decision that closes it: approved or accepted, and not superseded. */
export function quoteClosed(job) {
  const approval = lower(job?.customerApproval?.status);
  if (approval === 'superseded') return ['accepted', 'approved'].includes(lower(job?.estimate?.status));
  return ['accepted', 'approved'].includes(approval) || ['accepted', 'approved'].includes(lower(job?.estimate?.status));
}
/** When the quote closed (ISO), or null. */
export const closedAt = job => quoteClosed(job) ? isoTime(job?.customerApproval?.approvedAt) || isoTime(job?.estimate?.acceptedAt) : null;
export const estimatorOf = job => String(job?.quoteDraft?.createdBy || job?.quoteDraft?.sentBy || job?.quoteDraft?.savedBy || '').trim().slice(0, 120) || null;
/** The quote total in integer cents, or null. */
export function quoteTotalCents(job) {
  const estimate = plain(job?.estimate) ? job.estimate : {};
  if (Number.isSafeInteger(estimate.amountCents) && estimate.amountCents >= 0) return estimate.amountCents;
  return typeof estimate.amount === 'number' && Number.isFinite(estimate.amount) && estimate.amount >= 0 ? Math.round(estimate.amount * 100) : null;
}
const quoteJob = job => plain(job) && ID.test(String(job.id || '')) && !job.recordType && WORK.has(job.type) && plain(job.quoteDraft) && isoTime(job.quoteDraft.sentAt);

/** Whether a quote job is open on the board. */
export function openQuote(job) {
  if (!quoteJob(job) || lower(job.estimate?.status) !== 'sent' || quoteClosed(job)) return false;
  if (['declined', 'rejected'].includes(lower(job.customerApproval?.status))) return false;
  return !CLOSED.has(lower(job.pipelineStatus)) && !CLOSED.has(lower(job.status));
}

/** Whether the quote has prices the owner has not approved: true / false, or null when the owner's menu is unknown. */
export function draftPricesWaiting(job, compositeState) {
  if (pricesPendingApproval(job)) return true;
  const breakdown = job?.quoteDraft?.breakdown;
  if (!plain(breakdown) || breakdown.source !== 'composite') return false;
  if (!compositeState) return null;
  try { return !compositeApproval(breakdown, compositeState).ready; } catch { return null; }
}

export const bucketOf = (ageDays, expired) => expired ? 'expired' : BUCKETS.find(bucket => bucket.id !== 'expired' && ageDays >= bucket.min && ageDays <= bucket.max)?.id || 'cold';

/** One open quote's row. */
export function openQuoteRow(job, { today, compositeState = null } = {}) {
  const sentAt = job.quoteDraft.sentAt, sentDay = dayOf(sentAt), validUntil = validDate(job.estimate?.validUntil) ? job.estimate.validUntil : null;
  const ageDays = Math.max(0, daysBetween(sentDay, today)), expired = validUntil !== null && validUntil < today;
  return {
    jobId: job.id, customer: String(job.customer || '').slice(0, 180), estimator: estimatorOf(job), totalCents: quoteTotalCents(job),
    sentAt, sentDay, ageDays, validUntil, expired, daysLeft: validUntil === null || expired ? null : daysBetween(today, validUntil),
    bucket: bucketOf(ageDays, expired), draftPricesWaiting: draftPricesWaiting(job, compositeState),
    walkthroughId: ID.test(String(job.sourceWalkthroughId || '')) ? job.sourceWalkthroughId : null,
  };
}

/** Bucket counts and known totals over rows, in BUCKETS order. */
export function summarizeBuckets(rows) {
  return BUCKETS.map(({ id, label }) => {
    const inside = rows.filter(row => row.bucket === id);
    return { id, label, count: inside.length, totalCents: inside.reduce((sum, row) => sum + (row.totalCents ?? 0), 0), unpricedCount: inside.filter(row => row.totalCents === null).length };
  });
}

/** The close-rate events: one per job, {jobId, estimator, sentDay, closed, closeDays, source:'sent'|'signed_on_site'}.
 * signed is [{jobId, actorId, createdAt, priorEstimate:{status}, priorAcceptance:{acceptedAt}}] from the signed-handoff receipts. */
/** Whether a signed-handoff receipt re-signed a job that was already signed or approved (its priorEstimate and
 * priorAcceptance, walkthrough-handoff.js). */
export const resigned = row => ['accepted', 'approved'].includes(lower(row?.priorEstimate?.status)) || plain(row?.priorAcceptance) && Object.keys(row.priorAcceptance).length > 0;
export function closeEvents(jobs, signed = []) {
  const events = new Map();
  for (const job of jobs) {
    if (!quoteJob(job)) continue;
    const sentDay = dayOf(job.quoteDraft.sentAt), closeTime = closedAt(job), closeDay = closeTime ? dayOf(closeTime) : null;
    events.set(job.id, { jobId: job.id, estimator: estimatorOf(job), sentDay, closed: Boolean(closeDay), closeDays: closeDay ? Math.max(0, daysBetween(sentDay, closeDay)) : null, source: 'sent', lost: !closeDay && (LOST.has(lower(job.status)) || LOST.has(lower(job.pipelineStatus))) });
  }
  // The earliest signature per job: a revision signed again is the same close. A receipt whose job already had an
  // accepted estimate or a recorded acceptance is a re-signature (the first can predate the receipts read), never a close.
  const firstSigned = new Map();
  for (const row of signed) {
    if (!plain(row) || row.kind !== undefined || !ID.test(String(row.jobId || '')) || !isoTime(row.createdAt) || resigned(row)) continue;
    if (!firstSigned.has(row.jobId) || row.createdAt < firstSigned.get(row.jobId).createdAt) firstSigned.set(row.jobId, row);
  }
  for (const [jobId, row] of firstSigned) {
    const day = dayOf(row.createdAt), sent = events.get(jobId);
    if (sent) {
      // A sent quote the customer then signed in person: closed on the signature day if nothing earlier closed it.
      if (!sent.closed && day >= sent.sentDay) Object.assign(sent, { closed: true, closeDays: daysBetween(sent.sentDay, day), lost: false });
      continue;
    }
    events.set(jobId, { jobId, estimator: String(row.actorId || '').trim().slice(0, 120) || null, sentDay: day, closed: true, closeDays: 0, source: 'signed_on_site', lost: false });
  }
  return [...events.values()];
}

const rate = (closed, sent) => sent ? Math.round(closed * 1000 / sent) / 10 : null;
const average = values => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) * 10 / values.length) / 10 : null;
/** Per-estimator close rates for events sent on or after `from` (YYYY-MM-DD), plus everyone's total. */
export function closeRates(events, from, today) {
  const inside = events.filter(event => event.sentDay >= from && event.sentDay <= today), by = new Map();
  for (const event of inside) {
    const key = event.estimator || '';
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(event);
  }
  const line = (estimator, list) => {
    const closed = list.filter(event => event.closed), sentQuotes = list.filter(event => event.source === 'sent');
    const closedSent = closed.filter(event => event.source === 'sent');
    return { estimator, sent: list.length, closed: closed.length, closePercent: rate(closed.length, list.length),
      sentQuotes: sentQuotes.length, sentQuotesClosed: closedSent.length, signedOnSite: list.length - sentQuotes.length,
      open: list.filter(event => !event.closed && !event.lost).length, lost: list.filter(event => event.lost).length,
      averageDaysToClose: average(closed.map(event => event.closeDays)), averageDaysToCloseSent: average(closedSent.map(event => event.closeDays)) };
  };
  const estimators = [...by].map(([key, list]) => line(key || null, list)).sort((a, b) => b.sent - a.sent || String(a.estimator ?? '~').localeCompare(String(b.estimator ?? '~')));
  return { from, estimators, total: line(null, inside) };
}

/** The report for a Denver day: open quotes oldest first, their buckets, and the 30- and 90-day close rates. */
export function buildOpenQuotes({ jobs = [], signed = [], compositeState = null, pricesReadable = true, today, asOf = new Date().toISOString() }) {
  const window = openQuotesWindow(today);
  const inWindow = jobs.filter(job => quoteJob(job) && dayOf(job.quoteDraft.sentAt) >= window.start && dayOf(job.quoteDraft.sentAt) <= today);
  const rows = inWindow.filter(openQuote).map(job => openQuoteRow(job, { today, compositeState: pricesReadable ? compositeState : null }))
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.jobId.localeCompare(b.jobId));
  const events = closeEvents(inWindow, signed);
  return {
    ok: true, authority: 'employee_hub', asOf, window, buckets: summarizeBuckets(rows), rows,
    totals: { count: rows.length, totalCents: rows.reduce((sum, row) => sum + (row.totalCents ?? 0), 0), unpricedCount: rows.filter(row => row.totalCents === null).length },
    closeRates: { last30: closeRates(events, window.last30, today), last90: closeRates(events, window.last90, today) },
  };
}
