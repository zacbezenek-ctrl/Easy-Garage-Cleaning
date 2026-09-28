import { sha256 } from '@noble/hashes/sha2.js';
import { customerPaymentNeedsReview, payable as checkoutPayable } from './customer-payments.js';
import { denverToday, validDate } from './dispatch-time.js';
import { customerMoneyTotals, invoiceLineItems, invoiceNumber, invoiceStatus, paymentLedger } from './money-core.js';
import { customerLineItem, estimateTotals, included, legacyLineItems, singleLineItem } from './quote-model.js';

/**
 * Server-rendered, branded customer money documents (estimate, invoice,
 * receipt). Pure: no I/O and no clock; `now` (an ISO instant) is required.
 *
 * Every figure comes from money-core: customerMoneyTotals for the totals,
 * invoiceLineItems for invoice/receipt lines (selected lines plus approved
 * change orders) and paymentLedger for payments. Lines are customerLineItem
 * projections, so cost splits, markup, catalog references and durations never
 * reach a customer. Estimates list every quoted line and mark optional lines
 * and options with their selection; lines that are not selected are shown but
 * never counted. Tips are listed on receipts as a separate, non-revenue line.
 *
 * The HTML has no scripts. Its one inline stylesheet is allowed by hash in
 * MONEY_DOCUMENT_CSP, so the page renders under `default-src 'none'`. It is
 * mobile-first (375px without horizontal scroll) and prints to PDF.
 */

export const MONEY_DOCUMENT_KINDS = Object.freeze(['estimate', 'invoice', 'receipt']);
export const MONEY_DOCUMENT_LOGO = '/images/brand/egc-logo-horizontal-primary.png';
const TIME_ZONE = 'America/Denver';
const DEFAULT_TERMS_VERSION = '2026-09';
const COMPANY = { name: 'Easy Garage Cleaning LLC', place: 'Fort Collins, Colorado', phone: '(970) 999-1818', phoneHref: 'tel:+19709991818', email: 'contact@easygaragecleaning.com' };
const TITLES = { estimate: 'Estimate', invoice: 'Invoice', receipt: 'Receipt' };
const TERMS = {
  estimate: 'This flat-rate estimate covers only the scope shown. Any material scope change requires customer approval before additional work or charges. The deposit shown is due upfront, with the remaining balance due on completion. Scheduling remains subject to crew availability.',
  invoice: 'Payment is due by the date shown. Please use the private customer portal for secure card payment or reference the invoice number with another agreed payment method.',
  receipt: 'Thank you for choosing Easy Garage Cleaning. This receipt lists the payments recorded for your project. Card payments are processed by Stripe; Easy Garage Cleaning never stores your card number. Tips go to your crew and are not part of the service total.',
};
const ESTIMATE_STATUS = { approved: 'Approved', expired: 'Expired', superseded: 'Superseded', revised: 'Revised · awaiting approval', draft: 'Draft', sent: 'Sent', ready: 'Ready for approval', pending: 'Awaiting approval', declined: 'Declined' };
const INVOICE_STATUS = { not_issued: 'Not issued', draft: 'Draft', void: 'Void', superseded: 'Superseded', paid: 'Paid', pending_verification: 'Payment pending verification', overdue: 'Overdue', partial: 'Partially paid', issued: 'Issued' };
const PORTAL_INVOICE = new Set(['issued', 'partial', 'overdue', 'paid', 'pending_verification']);
const PAYMENT_KIND = { deposit: 'Deposit', balance: 'Payment', offline: 'Payment', tip: 'Tip for your crew', refund: 'Refund' };
const PAYMENT_METHOD = { card: 'Card', gift_credit: 'Service credit', check: 'Check', cash: 'Cash', deposit: 'Recorded payment', mixed_with_gift_credit: 'Payment and service credit', ach: 'Bank transfer', zelle: 'Zelle', venmo: 'Venmo' };
const SERVICE_TYPES = { job: 'Garage service', cleanout: 'Garage cleanout', reorg: 'Garage reorganization' };
const PAY_NOTE = {
  customer: 'Opens your private Easy Garage Cleaning customer portal. Card details are entered on Stripe’s secure checkout.',
  staff: 'Pay securely from the private portal link Easy Garage Cleaning sent you. Card details are entered on Stripe’s secure checkout.',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const JOB_ID = /^[A-Za-z0-9_-]{1,180}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: `money_document_${code}`, status });
const clean = (value, max = 180) => String(value ?? '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const lower = value => String(value || '').trim().toLowerCase();
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const known = (...values) => values.every(value => Number.isSafeInteger(value));
const human = value => { const text = clean(value, 40).replace(/[^A-Za-z0-9 _-]/g, '').replace(/[_-]+/g, ' ').trim(); return text ? text[0].toUpperCase() + text.slice(1) : ''; };

export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** US dollars from integer cents, built without locale data so output never varies by runtime. */
export function usd(cents) {
  if (!Number.isSafeInteger(cents)) return '—';
  const abs = Math.abs(cents);
  return `${cents < 0 ? '−' : ''}$${String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
}

const dayLabel = date => { if (!validDate(date)) return ''; const [year, month, day] = date.split('-').map(Number); return `${MONTHS[month - 1]} ${day}, ${year}`; };
const denverParts = at => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
const instantDay = value => { const at = instant(value); if (!at) return ''; const parts = denverParts(at); return dayLabel(`${parts.year}-${parts.month}-${parts.day}`); };
function instantStamp(value) {
  const at = instant(value);
  if (!at) return '';
  const parts = denverParts(at), hour = Number(parts.hour);
  return `${dayLabel(`${parts.year}-${parts.month}-${parts.day}`)}, ${hour % 12 || 12}:${parts.minute} ${hour < 12 ? 'AM' : 'PM'} Mountain Time`;
}

// A pay link is a same-site path or an https URL; anything else is dropped.
function safePayUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  if (/^\/(?!\/)[A-Za-z0-9/_.#?=&-]*$/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}

/** MONEY_DOCUMENT_ENABLED === 'true' turns on the route, the portal links and the Hub print hand-off. */
export const moneyDocumentEnabled = env => String(env?.MONEY_DOCUMENT_ENABLED ?? '').trim() === 'true';

function approvalOf(job) {
  const approval = plain(job.customerApproval) ? job.customerApproval : {}, estimate = plain(job.estimate) ? job.estimate : {};
  const approved = lower(approval.status) !== 'superseded' && ['accepted', 'approved'].includes(lower(approval.status || estimate.status || job.quoteStatus));
  return { approved, by: clean(approval.approvedBy || estimate.acceptedBy, 120), at: instant(approval.approvedAt || estimate.acceptedAt), portal: approval.source === 'customer_portal' };
}

// A superseded approval belongs to an earlier revision (the Hub and the
// walkthrough hand-off write it when the estimate changes): the estimate shown
// is the new revision, which is never approved and waits for a new approval.
function estimateState(job, today) {
  const approval = lower(job.customerApproval?.status), raw = approval && approval !== 'superseded' ? approval : lower(job.estimate?.status || job.quoteStatus || 'draft');
  if (approval !== 'superseded' && ['accepted', 'approved'].includes(raw)) return 'approved';
  if (validDate(job.estimate?.validUntil) && job.estimate.validUntil < today) return 'expired';
  if (approval === 'superseded') return 'revised';
  return /^[a-z_]{1,30}$/.test(raw) ? raw : 'draft';
}

// Estimate lines as the customer agreed to them, read like invoiceLineItems:
// saved lines only when complete and adding up to the quote, else one honest line.
function estimateLines(job, totals, issues) {
  const record = legacyLineItems(job, { record: 'estimate', surface: 'document', totalCents: totals.quoteCents });
  const check = estimateTotals(record.source === 'record' ? job.estimate.lineItems : record.lineItems);
  let lines = record.lineItems.filter(line => line.kind !== 'tip');
  if (!check.complete || check.totalCents !== totals.quoteCents) {
    issues.push(check.complete ? 'money_line_items_mismatch' : 'money_line_items_incomplete');
    lines = [singleLineItem(job, { surface: 'document', totalCents: totals.quoteCents })];
  }
  return lines.map(line => ({ ...customerLineItem(line), included: included(line), choice: line.group ? 'option' : line.optional ? 'add-on' : '' }));
}

function lineTag(line) {
  if (!line.choice) return '';
  if (!line.included) return line.choice === 'option' ? 'Option · not selected · not in total' : 'Optional add-on · not selected · not in total';
  return line.choice === 'option' ? 'Selected option' : 'Optional add-on · selected';
}

// Receipts list every payment, tips included; an invoice lists what was paid toward the service.
function payments(job, { tips }) {
  const ledger = paymentLedger(job), rows = ledger.entries.filter(entry => Number.isSafeInteger(entry.amountCents) && (tips || entry.kind !== 'tip')).map(entry => ({
    date: instantDay(entry.at), label: [PAYMENT_KIND[entry.kind] || 'Payment', entry.processor === 'stripe' ? 'Card (Stripe)' : PAYMENT_METHOD[entry.method] || human(entry.method)].filter(Boolean).join(' · '),
    amountCents: entry.kind === 'refund' ? -entry.amountCents : entry.amountCents, receiptUrl: /^https:\/\/pay\.stripe\.com\/receipts\//.test(entry.receiptUrl || '') ? entry.receiptUrl : '',
  }));
  // Older jobs keep one running paid total; the part no single receipt explains is still shown.
  if (ledger.unreconciledCents > 0) rows.push({ date: '', label: 'Earlier recorded payments', amountCents: ledger.unreconciledCents, receiptUrl: '' });
  const reconciled = ledger.unreconciledCents !== null && ledger.unreconciledCents >= 0 && ledger.entries.every(entry => Number.isSafeInteger(entry.amountCents));
  return { rows, reconciled, latest: ledger.entries.map(entry => entry.at).filter(Boolean).at(-1) || instant(job.payment?.lastReceivedAt) };
}

// What the portal checkout would charge right now, in cents (payable() in
// customer-payments.js, still on the legacy money state), or null if it refuses.
function checkoutCents(job) {
  try { return Math.round(checkoutPayable(job).dueNow * 100); } catch { return null; }
}

/**
 * Which documents a customer may open for this job: an estimate once a quote
 * exists, an invoice once issued (not draft, void or superseded) and a receipt
 * once a payment is recorded. Unknown money makes no document available.
 */
export function moneyDocumentKinds(job, now) {
  const at = instant(now);
  if (!at) throw fail('now_required', 'Pass the current time in; documents never read the clock.', 500);
  if (!plain(job)) return [];
  const totals = customerMoneyTotals(job);
  if (!known(totals.quoteCents, totals.totalCents, totals.appliedCents, totals.balanceCents) || totals.totalCents <= 0) return [];
  return MONEY_DOCUMENT_KINDS.filter(kind => kind === 'estimate' || kind === 'invoice' && PORTAL_INVOICE.has(invoiceStatus(job, at)) || kind === 'receipt' && totals.paidCents > 0);
}

/** Customer portal links (session-scoped: no job id and never a token). Empty while the flag is off. */
export function moneyDocumentLinks(job, { enabled = false, now } = {}) {
  if (!enabled) return [];
  return moneyDocumentKinds(job, now).map(kind => ({ kind, label: `View ${kind}`, url: `/api/money-document?kind=${kind}` }));
}

/**
 * Everything a document shows, in integer cents. `payUrl` (optional) is where
 * "Pay now" leads; it is shown only while money is due, the estimate is
 * approved (or the job is closing), no recorded payment awaits review and the
 * portal checkout would charge exactly the amount on the button (at least
 * $0.50). `contact:false` leaves out the customer's phone and email
 * (collaborators). `audience:'staff'` words the pay note for a Hub copy that is
 * printed or handed on, which cannot carry the customer's portal session.
 */
export function moneyDocumentModel(job, { kind, now, payUrl = null, contact = true, audience = 'customer' } = {}) {
  if (!MONEY_DOCUMENT_KINDS.includes(kind)) throw fail('invalid_kind', 'Choose an estimate, invoice or receipt.');
  const at = instant(now);
  if (!at) throw fail('now_required', 'Pass the current time in; documents never read the clock.', 500);
  if (!plain(job) || typeof job.id !== 'string' || !JOB_ID.test(job.id) || /^(secure_|_egc_)/.test(job.id) || job.recordType) throw fail('not_found', 'That job is not available.', 404);
  const totals = customerMoneyTotals(job), issues = [...totals.issues];
  if (!known(totals.quoteCents, totals.totalCents, totals.appliedCents, totals.balanceCents)) throw fail('total_unknown', 'The amounts on this job need review by Easy Garage Cleaning before a document can be produced.', 409);
  if (totals.totalCents <= 0) throw fail('empty', 'There is nothing to show on this document yet.', 409);
  if (kind === 'receipt' && !(totals.paidCents > 0)) throw fail('unavailable', 'No payment has been recorded for this job yet.', 409);
  const estimate = plain(job.estimate) ? job.estimate : {}, invoice = plain(job.invoice) ? job.invoice : {};
  const today = denverToday(new Date(at)), approval = approvalOf(job);
  let lines, status, statusLabel, number, dates;
  if (kind === 'estimate') {
    lines = estimateLines(job, totals, issues);
    status = estimateState(job, today); statusLabel = ESTIMATE_STATUS[status] || human(status) || 'Draft';
    number = invoiceNumber(job.id, 'estimate', clean(estimate.number, 80));
    dates = [['Prepared', instantDay(estimate.createdAt || estimate.updatedAt) || instantDay(at)], ['Valid through', dayLabel(estimate.validUntil) || 'Not specified']];
    if (Number.isSafeInteger(estimate.revision) && estimate.revision > 0) dates.push(['Revision', String(estimate.revision)]);
  } else {
    const projected = invoiceLineItems(job, totals);
    issues.push(...projected.issues);
    lines = projected.lineItems.map(line => ({ ...line, included: true, choice: '' }));
    number = invoiceNumber(job.id, 'invoice', clean(invoice.number, 80));
    if (kind === 'invoice') {
      status = invoiceStatus(job, at); statusLabel = INVOICE_STATUS[status] || 'Issued';
      dates = [['Issued', instantDay(invoice.issuedAt) || 'Not issued yet'], ['Payment due', dayLabel(invoice.dueDate) || 'Not specified']];
      if (clean(invoice.customerReference, 120)) dates.push(['Your reference', clean(invoice.customerReference, 120)]);
    }
  }
  const ledger = kind === 'estimate' ? { rows: [], reconciled: true, latest: null } : payments(job, { tips: kind === 'receipt' });
  const needsReview = customerPaymentNeedsReview(job);
  if (kind === 'receipt') {
    status = needsReview ? 'pending_verification' : totals.balanceCents > 0 ? 'partial' : 'paid';
    statusLabel = { partial: 'Partial payment', pending_verification: 'Payment pending verification', paid: 'Paid in full' }[status];
    // Dated by the latest recorded payment, so reopening a receipt never redates it.
    dates = [['Receipt date', instantDay(ledger.latest) || instantDay(at)]];
  }
  const rows = [];
  if (kind === 'receipt') {
    rows.push({ label: 'Service total', cents: totals.totalCents }, { label: 'Paid toward service', cents: totals.appliedCents });
    if (totals.tipCents > 0) rows.push({ label: 'Tips for your crew (not part of the service total)', cents: totals.tipCents, tip: true }, { label: 'Total paid', cents: totals.paidCents });
  } else {
    if (kind === 'estimate' && totals.approvedChangeCents > 0) rows.push({ label: 'Estimate', cents: totals.quoteCents }, { label: 'Approved changes', cents: totals.approvedChangeCents });
    rows.push({ label: 'Total', cents: totals.totalCents });
    if (kind === 'estimate') rows.push({ label: totals.depositRequiredCents === 0 ? 'No deposit required' : 'Deposit due upfront', cents: totals.depositRequiredCents });
    rows.push({ label: 'Payments received', cents: totals.appliedCents });
  }
  if (totals.overpaidCents > 0) rows.push({ label: 'Overpayment on file', cents: totals.overpaidCents });
  rows.push({ label: kind === 'receipt' ? 'Balance remaining' : 'Balance due', cents: totals.balanceCents, due: true });
  const url = safePayUrl(payUrl), cancelled = [job.status, job.pipelineStatus].some(value => ['cancelled', 'canceled', 'superseded', 'lost'].includes(lower(value)));
  const closed = kind === 'invoice' && ['void', 'superseded'].includes(status) || kind === 'estimate' && ['expired', 'superseded'].includes(status);
  const due = Number.isSafeInteger(totals.dueNowCents) && totals.dueNowCents > 0, deposit = totals.purpose === 'deposit';
  const offer = url && due && !needsReview && !cancelled && !closed && (approval.approved || !deposit);
  // The checkout still charges the legacy amount (no approved changes, tips
  // counted as paid): the button appears only when it charges this figure.
  const charge = offer ? checkoutCents(job) : null;
  const pay = offer && charge !== null && charge >= 50 && charge === totals.dueNowCents ? { url, amountCents: totals.dueNowCents, label: `Pay ${usd(totals.dueNowCents)} ${deposit ? 'deposit' : 'balance'} securely` } : null;
  let payNote = '';
  if (pay) payNote = audience === 'staff' ? PAY_NOTE.staff : PAY_NOTE.customer;
  else if (url && due && needsReview) payNote = 'A recorded payment is awaiting verification by our team. Please wait before paying again.';
  else if (offer || url && due && kind === 'estimate' && !closed && !cancelled) {
    payNote = charge === null && !approval.approved ? `Approve ${kind === 'estimate' ? 'this' : 'your'} estimate in your customer portal to pay ${deposit ? 'the deposit ' : ''}online.`
      : `Online card payment is not available for this balance. Please call or text Easy Garage Cleaning at ${COMPANY.phone} to pay it.`;
  }
  const notice = kind === 'invoice' && status === 'void' ? 'This invoice is void. Contact Easy Garage Cleaning for your current invoice.'
    : status === 'superseded' ? `This ${kind} was replaced by an updated version. Contact Easy Garage Cleaning for the current one.`
    : kind === 'invoice' && ['not_issued', 'draft'].includes(status) ? 'Draft: this invoice has not been issued yet.' : '';
  const scope = kind === 'estimate' ? clean(estimate.scope, 1600) : '';
  const service = clean(job.serviceType, 120) || SERVICE_TYPES[job.type] || 'Garage service';
  return {
    kind, title: TITLES[kind], number, status, statusLabel, notice, generatedAt: at, generatedLabel: instantStamp(at), dates,
    customer: { name: clean(job.customer, 120) || 'Customer', address: clean(job.address, 240), phone: contact ? clean(job.phone, 40) : '', email: contact ? clean(job.email, 180) : '' },
    service, scope: scope && !lines.some(line => line.description === scope) ? scope : '',
    lines, rows, payments: ledger.rows, paymentsReconciled: ledger.reconciled,
    approval: (kind === 'estimate' || kind === 'invoice') && approval.approved ? `Estimate approved${approval.by ? ` by ${approval.by}` : ''}${approval.at ? ` on ${instantDay(approval.at)}` : ''}${approval.portal ? ' in the customer portal' : ''}` : '',
    termsVersion: clean((kind === 'estimate' ? estimate.termsVersion : invoice.termsVersion || estimate.termsVersion) || DEFAULT_TERMS_VERSION, 40), terms: TERMS[kind],
    pay, payNote, totals, issues: [...new Set(issues)],
  };
}

const STYLE = '@page{margin:.5in}*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:#eef2f6;color:#0b223d;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}a{color:#b8360b}.doc{width:100%;max-width:820px;margin:0 auto;padding:20px 16px 28px;background:#fff}.top{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:14px 24px;padding-bottom:18px;border-bottom:4px solid #ff5315}.logo{display:block;width:200px;max-width:100%;height:auto}.kind h1{margin:0;font-size:26px;line-height:1.1;letter-spacing:.04em;text-transform:uppercase}.kind p{margin:4px 0 0;color:#526071;overflow-wrap:anywhere}.status{display:inline-block;margin-top:8px;padding:4px 10px;border-radius:99px;background:#fff2ec;color:#a4330c;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}.status.good{background:#e8f6ee;color:#116c41}.notice{margin:16px 0 0;padding:12px 14px;border-radius:10px;background:#fdecea;color:#8a2416;font-weight:700}.meta{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;margin:22px 0}.label,dt{font-size:11px;font-weight:800;letter-spacing:.1em;color:#b8360b;text-transform:uppercase}.party strong,.party span{display:block;overflow-wrap:anywhere}.party span{color:#526071}.dates{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:0}.dates div{min-width:0;padding:10px 12px;border-radius:8px;background:#f3f5f7}.dates dd{margin:2px 0 0;font-weight:700;overflow-wrap:anywhere}.scope{margin:0 0 18px;white-space:pre-line;color:#344256;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed}caption{padding:0 0 8px;text-align:left}th{padding:10px 8px;background:#0b223d;color:#fff;font-size:11px;letter-spacing:.08em;text-align:left;text-transform:uppercase}th:last-child,td:last-child{width:38%;text-align:right}td{padding:12px 8px;border-bottom:1px solid #d9dfe6;vertical-align:top;overflow-wrap:anywhere}td strong{display:block}td small{display:block;margin-top:3px;color:#667085}.tag{display:inline-block;margin-top:5px;padding:2px 8px;border-radius:6px;background:#eef3f7;color:#344256;font-size:12px;font-weight:700}tr.excluded td{color:#7a8594}tr.excluded .amount{text-decoration:line-through}.totals{width:100%;max-width:380px;margin:18px 0 0 auto}.totals div{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid #e4e7eb}.totals span{min-width:0;overflow-wrap:anywhere}.totals strong{white-space:nowrap}.totals .tip{color:#526071}.totals .due{border-top:3px solid #0b223d;border-bottom:0;padding-top:12px;font-size:19px;font-weight:800}h2{margin:28px 0 10px;font-size:15px;letter-spacing:.08em;text-transform:uppercase}.muted{color:#667085;font-size:13px}.approval{margin:18px 0 0;color:#116c41;font-weight:700}.pay{display:flex;align-items:center;justify-content:center;min-height:48px;margin:22px 0 0;padding:12px 18px;border-radius:10px;background:#ff5315;color:#fff;font-weight:800;text-align:center;text-decoration:none}.pay-note{margin:8px 0 0;color:#526071;font-size:13px}.terms{margin-top:28px;padding:16px;border-radius:8px;background:#f6f3ee;color:#526071;font-size:13px}.terms b{display:block;margin-bottom:5px;color:#0b223d}.terms p{margin:0}.foot{display:grid;gap:4px;margin-top:28px;padding-top:14px;border-top:1px solid #d9dfe6;color:#667085;font-size:12px}.foot a,.link{display:inline-block;min-height:44px;line-height:44px}.hint{margin:14px 0 0;color:#667085;font-size:12px}@media(min-width:681px){body{padding:24px 0}.doc{padding:40px 44px;border-radius:14px;box-shadow:0 18px 50px rgba(7,26,49,.09)}.logo{width:255px}.kind{text-align:right}.kind h1{font-size:32px}.meta{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:30px}.pay{display:inline-flex;min-width:280px}.foot{grid-template-columns:repeat(3,auto);justify-content:space-between}th,td{padding-left:12px;padding-right:12px}th:last-child,td:last-child{width:160px}}@media print{body{padding:0;background:#fff;font-size:13px}.doc{max-width:none;padding:0;box-shadow:none}.hint{display:none}.pay{display:inline-flex;min-height:0;padding:8px 14px}a{color:#0b223d}tr{break-inside:avoid}}';
const base64 = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
export const MONEY_DOCUMENT_STYLE_HASH = `sha256-${base64(sha256(new TextEncoder().encode(STYLE)))}`;
/** No scripts, no network beyond same-origin images, no framing, no forms. */
export const MONEY_DOCUMENT_CSP = `default-src 'none'; img-src 'self'; style-src '${MONEY_DOCUMENT_STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function moneyDocumentHeaders() {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': MONEY_DOCUMENT_CSP, 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' };
}

// email_off keeps Cloudflare email obfuscation from rewriting addresses into
// links whose decoder script this CSP (rightly) blocks.
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><!--email_off--><main class="doc">${body}</main><!--/email_off--></body></html>`;
const logo = `<img class="logo" src="${MONEY_DOCUMENT_LOGO}" alt="Easy Garage Cleaning" width="255" height="48">`;
const foot = generated => `<footer class="foot"><span>${esc(COMPANY.name)} · ${esc(COMPANY.place)}</span><span><a href="${COMPANY.phoneHref}">${esc(COMPANY.phone)}</a> · ${esc(COMPANY.email)}</span>${generated ? `<span>Generated ${esc(generated)}</span>` : ''}</footer>`;

function lineRow(line) {
  const quantity = line.quantity !== 1 && Number.isSafeInteger(line.unitCents) ? `<small>${esc(line.quantity)} × ${esc(usd(line.unitCents))}</small>` : '';
  const tag = lineTag(line);
  return `<tr${line.included ? '' : ' class="excluded"'}><td><strong>${esc(line.name)}</strong>${line.description ? `<small>${esc(line.description)}</small>` : ''}${quantity}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</td><td class="amount">${esc(usd(line.totalCents))}</td></tr>`;
}

/** The complete HTML document; every saved value is escaped. See moneyDocumentModel for options. */
export function renderMoneyDocument(job, options = {}) {
  const doc = moneyDocumentModel(job, options);
  const good = ['approved', 'paid'].includes(doc.status);
  const party = [doc.customer.address, [doc.customer.phone, doc.customer.email].filter(Boolean).join(' · ')].filter(Boolean).map(text => `<span>${esc(text)}</span>`).join('');
  const body = [
    `<header class="top">${logo}<div class="kind"><h1>${esc(doc.title)}</h1><p>${esc(doc.number)} · ${esc(doc.service)}</p><span class="status${good ? ' good' : ''}">${esc(doc.statusLabel)}</span></div></header>`,
    doc.notice ? `<p class="notice" role="note">${esc(doc.notice)}</p>` : '',
    `<section class="meta"><div class="party"><div class="label">Prepared for</div><strong>${esc(doc.customer.name)}</strong>${party}</div><dl class="dates">${doc.dates.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section>`,
    doc.scope ? `<p class="scope">${esc(doc.scope)}</p>` : '',
    `<table><caption class="label">${doc.kind === 'estimate' ? 'Quoted services' : 'Services'}</caption><thead><tr><th scope="col">Description</th><th scope="col">Amount</th></tr></thead><tbody>${doc.lines.map(lineRow).join('')}</tbody></table>`,
    `<div class="totals">${doc.rows.map(row => `<div${row.due ? ' class="due"' : row.tip ? ' class="tip"' : ''}><span>${esc(row.label)}</span><strong>${esc(usd(row.cents))}</strong></div>`).join('')}</div>`,
    doc.approval ? `<p class="approval">✓ ${esc(doc.approval)}</p>` : '',
    doc.payments.length ? `<h2>Payments</h2><table><thead><tr><th scope="col">Payment</th><th scope="col">Amount</th></tr></thead><tbody>${doc.payments.map(row => `<tr><td><strong>${esc(row.label)}</strong>${row.date ? `<small>${esc(row.date)}</small>` : ''}${row.receiptUrl ? `<a class="link" href="${esc(row.receiptUrl)}" rel="noopener noreferrer">Stripe receipt</a>` : ''}</td><td>${esc(usd(row.amountCents))}</td></tr>`).join('')}</tbody></table>${doc.paymentsReconciled ? '' : '<p class="muted">Some payment details are still being reconciled by our team. The totals above are from our records.</p>'}` : '',
    doc.pay ? `<a class="pay" href="${esc(doc.pay.url)}">${esc(doc.pay.label)}</a>` : '',
    doc.payNote ? `<p class="pay-note">${esc(doc.payNote)}</p>` : '',
    `<section class="terms"><b>${esc(`${doc.kind === 'estimate' ? 'Estimate terms' : doc.kind === 'invoice' ? 'Payment terms' : 'Receipt'} · version ${doc.termsVersion}`)}</b><p>${esc(doc.terms)}</p></section>`,
    foot(doc.generatedLabel),
    '<p class="hint">To save a PDF, use your browser’s Print or Share menu.</p>',
  ].join('');
  return page(`${doc.title} ${doc.number} · Easy Garage Cleaning`, body);
}

/** A branded error page under the same CSP, for document links opened in a browser tab. */
export function renderMoneyDocumentError(message) {
  return page('Document unavailable · Easy Garage Cleaning', `<header class="top">${logo}</header><h2>We couldn’t open this document</h2><p>${esc(message)}</p><p class="muted">Questions? Call or text <a href="${COMPANY.phoneHref}">${esc(COMPANY.phone)}</a>.</p>${foot('')}`);
}
