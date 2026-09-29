import { denverToday, validDate } from './dispatch-time.js';
import { customerMoneyTotals, invoiceStatus, moneyCents } from './money-core.js';
import { reconcileLedger } from './money-ledger.js';
import { moneyJob } from './money-service.js';
import { cashPayment } from './payment-events.js';

/**
 * Manager lists and CSV exports of invoices and payment-ledger entries from
 * one complete masked jobs scan (store.jobs()). Dates are America/Denver
 * calendar days with an exclusive endDate; money is integer cents. A partial
 * scan throws, so a list is never presented as complete when it is not.
 */
export const MONEY_VIEWS = Object.freeze(['invoices', 'payments']);
export const INVOICE_FILTER_STATUSES = Object.freeze(['draft', 'issued', 'partial', 'paid', 'pending_verification', 'overdue', 'void', 'superseded']);
export const MONEY_QUERY_KEYS = Object.freeze(['view', 'status', 'startDate', 'endDate', 'customerId', 'offset', 'limit', 'format']);
const MAX_LIMIT = 200;
const fail = (reason, message, status = 400) => Object.assign(new Error(message), { code: `money_${reason}`, status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const denverDate = at => at ? denverToday(new Date(at)) : null;
const newestFirst = (a, b) => (a.at === null) - (b.at === null) || String(b.at).localeCompare(String(a.at)) || a.key.localeCompare(b.key);

function invoiceRow(job, now) {
  const invoice = plain(job.invoice) ? job.invoice : null;
  if (!invoice || !(invoice.status || invoice.issuedAt || invoice.amount !== undefined && invoice.amount !== null)) return null;
  const totals = customerMoneyTotals(job), issuedAt = instant(invoice.issuedAt), active = !['void', 'superseded'].includes(invoice.status);
  return { key: job.id, at: issuedAt, jobId: job.id, customerId: str(job.customerId), customer: str(job.customer), serviceDate: str(job.date, 10), number: str(invoice.number, 80), status: invoiceStatus(job, now), savedStatus: str(invoice.status, 40),
    amountCents: Number.isSafeInteger(invoice.amountCents) ? invoice.amountCents : moneyCents(invoice.amount), paidCents: active ? totals.appliedCents : moneyCents(invoice.paid), balanceCents: active ? totals.balanceCents : moneyCents(invoice.balance),
    dueDate: validDate(invoice.dueDate) ? invoice.dueDate : '', issuedAt, issuedDate: denverDate(issuedAt), customerReference: str(invoice.customerReference, 120) };
}

// With FUN-33 payment events on (store.paymentEvents), each row also says whether it is non-cash credit
// (a gift-credit redemption: applied to the balance, never collected as money).
function paymentRows(job, events) {
  const ledger = reconcileLedger(job);
  return ledger.entries.map(entry => ({ key: `${job.id}/${entry.id}`, at: entry.at, jobId: job.id, customerId: str(job.customerId), customer: str(job.customer), entryId: entry.id, kind: entry.kind, method: entry.method, ...(events ? { nonCashCredit: !cashPayment(entry.method) } : {}), amountCents: entry.amountCents,
    processorRef: entry.processorRef, receivedAt: entry.at, receivedDate: denverDate(entry.at), recordedBy: entry.by, verified: entry.verified, source: entry.source, ledgerComplete: ledger.complete }));
}

/** Filters, sorts (newest first) and pages one view. `rows` holds every match for CSV. */
export async function listMoney(store, query = {}, now) {
  const invalid = message => fail('query_invalid', message);
  const view = query.view === undefined || query.view === '' ? 'invoices' : query.view;
  if (!MONEY_VIEWS.includes(view)) throw invalid('Choose the invoices or payments view.');
  const status = query.status || '';
  if (status && (view !== 'invoices' || !INVOICE_FILTER_STATUSES.includes(status))) throw invalid(`Filter invoices by one of: ${INVOICE_FILTER_STATUSES.join(', ')}.`);
  const startDate = query.startDate || '', endDate = query.endDate || '';
  if (startDate && !validDate(startDate) || endDate && !validDate(endDate)) throw invalid('Dates must be YYYY-MM-DD. The end date is exclusive.');
  if (startDate && endDate && endDate <= startDate) throw invalid('The end date must be after the start date. The end date is exclusive.');
  const customerId = query.customerId || '';
  if (customerId && (!/^[A-Za-z0-9_-]{1,180}$/.test(customerId) || /^(secure_|_egc_)/.test(customerId))) throw invalid('Filter by a valid customer ID.');
  const number = (value, fallback, min, max, label) => { if (value === undefined || value === '') return fallback; const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw invalid(label); return n; };
  const offset = number(query.offset, 0, 0, 100000, 'The offset must be a whole number from 0.'), limit = number(query.limit, 50, 1, MAX_LIMIT, `Choose between 1 and ${MAX_LIMIT} rows per page.`);
  if (query.format !== undefined && !['json', 'csv'].includes(query.format)) throw invalid('Choose json or csv.');
  const jobs = await store.jobs();
  if (!Array.isArray(jobs)) throw fail('storage_incomplete', 'The complete job money records could not be loaded. Retry.', 503);
  const inRange = date => (!startDate || date && date >= startDate) && (!endDate || date && date < endDate), rows = [];
  for (const job of jobs) {
    if (!moneyJob(job) || customerId && job.customerId !== customerId) continue;
    if (view === 'invoices') { const row = invoiceRow(job, now); if (row && (!status || row.status === status) && inRange(row.issuedDate)) rows.push(row); }
    else for (const row of paymentRows(job, store.paymentEvents === true)) if (inRange(row.receivedDate)) rows.push(row);
  }
  rows.sort(newestFirst);
  const clean = rows.map(({ key, at, ...row }) => row);
  return { view, items: clean.slice(offset, offset + limit), total: clean.length, offset, limit, nextOffset: offset + limit < clean.length ? offset + limit : null, asOf: now, coverage: { complete: true, asOf: now }, filters: { status: status || null, startDate: startDate || null, endDate: endDate || null, customerId: customerId || null }, rows: clean };
}

/** Spreadsheet-safe cell: formula-leading text gets a quote prefix; every cell is quoted. */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}
const dollars = cents => Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : '';
const COLUMNS = {
  invoices: [['Invoice number', row => row.number], ['Status', row => row.status], ['Customer', row => row.customer], ['Customer ID', row => row.customerId], ['Job ID', row => row.jobId], ['Service date', row => row.serviceDate], ['Issued (Denver)', row => row.issuedDate], ['Due date', row => row.dueDate], ['Amount', row => dollars(row.amountCents)], ['Paid', row => dollars(row.paidCents)], ['Balance', row => dollars(row.balanceCents)], ['Customer reference', row => row.customerReference]],
  payments: [['Received (Denver)', row => row.receivedDate], ['Received at (UTC)', row => row.receivedAt], ['Customer', row => row.customer], ['Customer ID', row => row.customerId], ['Job ID', row => row.jobId], ['Kind', row => row.kind], ['Method', row => row.method], ['Amount', row => dollars(row.amountCents)], ['Reference', row => row.processorRef], ['Recorded by', row => row.recordedBy], ['Verified', row => row.verified ? 'yes' : 'no'], ['Source', row => row.source], ['Entry ID', row => row.entryId]],
};
// "Non-cash credit" is yes only for gift-credit redemptions; card, ACH, check and cash rows are no.
const NON_CASH_CREDIT = ['Non-cash credit', row => row.nonCashCredit ? 'yes' : 'no'];
/** `paymentEvents` (FUN-33) appends the Non-cash credit column to the payments view; unset, the CSV is exactly as before. */
export function moneyCsv(view, rows, { paymentEvents = false } = {}) {
  const columns = view === 'payments' && paymentEvents === true ? [...COLUMNS.payments, NON_CASH_CREDIT] : COLUMNS[view] || COLUMNS.invoices;
  return [columns.map(([label]) => csvCell(label)).join(','), ...rows.map(row => columns.map(([, get]) => csvCell(get(row))).join(','))].join('\r\n') + '\r\n';
}
