/** Per-visit price on a recurring plan. A plan may carry pricePerVisitCents and
 * the M3 estimate lineItems behind it (integer cents, the canonical quote line
 * model). Generated visits get that price only through money-service
 * estimate.save (recurring-plan-service.js), never by a direct money write.
 * Pure: no storage and no clock. */
import { MAX_ESTIMATE_LINES } from './money-service.js';
import { MAX_TOTAL_CENTS, estimateTotals, normalizeLineItems } from './money-core.js';
import { addDays } from './dispatch-time.js';

export const RECURRING_PRICE_VALID_DAYS = 30;
const KINDS = new Set(['service','product','labor','disposal','fee']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: `recurring_${code}`, status });
const clip = (value, max) => String(value ?? '').slice(0, max);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
const lineName = serviceName => `${clip(String(serviceName || '').trim() || 'Garage service', 130)} (recurring visit)`;

/** Validates the price half of a plan. Returns undefined when neither field is
 * present (no change), {pricePerVisitCents:null,lineItems:null} to clear, or
 * the normalized price. A single price becomes one service line. */
export function normalizePlanPrice(input, { serviceName } = {}) {
  if (!object(input) || !('pricePerVisitCents' in input) && !('lineItems' in input)) return undefined;
  const price = input.pricePerVisitCents ?? null, items = input.lineItems ?? null;
  if (price === null && items === null) return { pricePerVisitCents: null, lineItems: null };
  if (price !== null && (!Number.isSafeInteger(price) || price < 1 || price > MAX_TOTAL_CENTS)) throw fail('price_invalid', 'Enter a price per visit in whole cents, more than $0.00.');
  if (items !== null && (!Array.isArray(items) || !items.length || items.length > MAX_ESTIMATE_LINES)) throw fail('price_invalid', `A visit price needs 1 to ${MAX_ESTIMATE_LINES} line items.`);
  let lineItems;
  try { ({ lineItems } = normalizeLineItems(items ?? [{ id: 'recurring-visit', kind: 'service', name: lineName(serviceName), description: '', quantity: 1, unitCents: price }], { strict: true })); }
  catch (error) { throw fail('price_invalid', error.message || 'A price line is invalid.'); }
  if (lineItems.some(line => !KINDS.has(line.kind) || line.optional || line.group)) throw fail('price_invalid', 'Visit prices use required service, product, labor, disposal or fee lines only.');
  const totals = estimateTotals(lineItems);
  if (!totals.complete || !Number.isSafeInteger(totals.totalCents) || totals.totalCents <= 0) throw fail('price_invalid', 'The price per visit must be more than $0.00.');
  if (price !== null && price !== totals.totalCents) throw fail('price_mismatch', 'The price per visit must equal the total of its line items.');
  return { pricePerVisitCents: totals.totalCents, lineItems };
}

export const planPriced = plan => Array.isArray(plan?.lineItems) && plan.lineItems.length > 0 && Number.isSafeInteger(plan.pricePerVisitCents);

/** Stable 16-hex key of the plan's current lines; null when the plan has no price. */
export async function priceKey(plan) {
  if (!planPriced(plan)) return null;
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(plan.lineItems))))].map(byte => byte.toString(16).padStart(2,'0')).join('');
  return hex.slice(0, 16);
}

/** Money already on a visit that the plan did not put there (a manager's own
 * estimate, an approval, an invoice or a payment) is never replaced. */
export function visitPriceBlocker(job, previousRequestId = null) {
  const estimate = object(job?.estimate) ? job.estimate : null, invoice = object(job?.invoice) ? job.invoice : null;
  const paid = [job?.payment?.amount, job?.deposit?.paidAmount].some(value => Number(value) > 0) || Array.isArray(job?.paymentLedger) && job.paymentLedger.length > 0;
  const approved = ['accepted','approved'].includes(String(estimate?.status || '').toLowerCase()) || ['accepted','approved'].includes(String(job?.customerApproval?.status || '').toLowerCase());
  if (paid || approved || invoice && (invoice.status || invoice.issuedAt || invoice.amount != null) && !['void','superseded'].includes(invoice.status)) return 'price_locked';
  const priced = Boolean(estimate && (estimate.number || estimate.amount != null || Array.isArray(estimate.lineItems) && estimate.lineItems.length));
  if (priced && !(previousRequestId && job.moneyRequestId === previousRequestId)) return 'price_changed_in_hub';
  return null;
}

/** The exact estimate.save input for one visit (the requestId is supplied by the caller). */
export function visitEstimateInput(plan, job, { requestId, date, today, serviceName, cadence }) {
  const from = date >= today ? date : today;
  return { action: 'estimate.save', requestId, jobId: job.id, expectedRevision: job.revision, lineItems: plan.lineItems, depositCents: 0, validUntil: addDays(from, RECURRING_PRICE_VALID_DAYS),
    scope: clip(`${String(serviceName || '').trim() || 'Garage service'} — recurring visit${cadence ? ` (${cadence})` : ''}.`, 1600) };
}
