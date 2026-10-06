// Sale hand-offs: the job, the deposit link and the customer text. Each runs through an adapter:
//   job     manual  - an admin creates the job (Hub dispatch or Jobber) and records it here
//   deposit manual  - an admin marks the deposit collected
//           stripe  - a Stripe Checkout link for the deposit (repo's Stripe helpers); its status is
//                     read back from Stripe, so no webhook change is needed
//   text    manual  - an admin texts the customer from Quo and records it here
//           quo     - one text through Quo's API, at most once per sale, never in bulk
// The repo's Jobber integration is read-only (client and request lookup), so job creation stays
// manual. Credentials come only from the server environment; nothing is invented.
import { knockFailure, write } from './knock-store.js';
import { stripeRequest, stripeSecretKey } from './customer-payments.js';
import { formatClock, zonedDate, zonedInstant } from '../../crew/knock-time.js';

const QUO_DEFAULT_FROM = '+19709991818';
const SITE = 'https://easygaragecleaning.com';

export function quoKey(env = {}) {
  return String(env.QUO_API_KEY || env.QUO || '').trim();
}

export function integrationStatus(env, settings) {
  return {
    job: { mode: 'manual', available: ['manual'] },
    deposit: { mode: settings.integrations.deposit, available: ['manual', ...(stripeSecretKey(env) ? ['stripe'] : [])] },
    text: { mode: settings.integrations.text, available: ['manual', ...(quoKey(env) ? ['quo'] : [])] },
  };
}

const money = value => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: Number(value) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const longDate = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

/* The one customer text: booking, deposit link (when there is one) and the right to cancel. */
export function customerMessage(sale) {
  const first = String(sale.customer?.name || '').trim().split(/\s+/)[0] || 'there';
  const parts = [
    `Hi ${first}, thanks for booking Easy Garage Cleaning: ${sale.package}, ${money(sale.ticket)}, on ${longDate(sale.jobDate)}.`,
    sale.handoff?.deposit?.url ? `Your ${money(sale.depositAmount)} deposit: ${sale.handoff.deposit.url}` : `Your deposit is ${money(sale.depositAmount)}.`,
    `You can cancel for a full refund until midnight ${longDate(sale.cancelDeadlineDate)}. Questions? Reply here.`,
  ];
  return parts.join(' ');
}

/* ---- deposit through Stripe ---- */

export async function startStripeDeposit(env, sale, { request = stripeRequest } = {}) {
  const secret = stripeSecretKey(env);
  if (!secret) throw knockFailure('Stripe is not set up on the server. Use the manual deposit.', 409, 'knock_stripe_unavailable');
  const cents = Math.round(Number(sale.depositAmount) * 100);
  if (!(cents >= 50)) throw knockFailure('The deposit amount is too small for card payment.', 400, 'knock_invalid_amount');
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(cents),
    'line_items[0][price_data][product_data][name]': `Easy Garage Cleaning deposit: ${sale.package}`,
    'line_items[0][price_data][product_data][description]': `20% deposit on a ${money(sale.ticket)} garage service. Fully refundable until midnight ${sale.cancelDeadlineDate}.`,
    customer_email: sale.customer?.email || '',
    client_reference_id: sale.id,
    'metadata[kind]': 'egc_knock_deposit',
    'metadata[sale_id]': sale.id,
    'payment_intent_data[metadata][kind]': 'egc_knock_deposit',
    'payment_intent_data[metadata][sale_id]': sale.id,
    success_url: `${SITE}/thank-you?deposit=received`,
    cancel_url: `${SITE}/`,
  });
  // Stripe's idempotency key makes a repeated tap return the same session, never a second one.
  const session = await request(secret, 'checkout/sessions', { method: 'POST', body, headers: { 'Idempotency-Key': `egc-knock-deposit-${sale.id}` } });
  if (!session?.id || !session?.url) throw knockFailure('Stripe did not return a checkout link. Try again.', 502, 'knock_stripe_failed');
  return { sessionId: session.id, url: session.url, amount: cents / 100 };
}

export async function refreshStripeDeposit(env, sale, { request = stripeRequest } = {}) {
  const secret = stripeSecretKey(env);
  const sessionId = sale.handoff?.deposit?.sessionId;
  if (!secret || !sessionId) throw knockFailure('There is no Stripe deposit link to check.', 409, 'knock_stripe_unavailable');
  const session = await request(secret, `checkout/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
  const paid = session?.status === 'complete' && session?.payment_status === 'paid' && session?.metadata?.sale_id === sale.id &&
    session?.client_reference_id === sale.id && Number(session?.amount_total) === Math.round(Number(sale.depositAmount) * 100);
  return { paid, amount: Number(session?.amount_total || 0) / 100, status: session?.status || '', paymentStatus: session?.payment_status || '' };
}

/* ---- text through Quo ---- */

export async function sendQuoText(env, to, content, { fetcher = (...args) => fetch(...args) } = {}) {
  const key = quoKey(env);
  if (!key) throw knockFailure('Quo is not set up on the server. Text the customer from Quo and mark it sent.', 409, 'knock_quo_unavailable');
  const base = String(env.QUO_API_BASE || 'https://api.openphone.com/v1').replace(/\/$/, '');
  let response;
  try {
    response = await fetcher(`${base}/messages`, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: String(env.QUO_FROM || QUO_DEFAULT_FROM), to: [to], content }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { outcome: 'uncertain', error: 'Quo did not answer. Check the Quo app before sending anything again.' };
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return { outcome: 'sent', messageId: String(data?.data?.id || '') };
  if (response.status >= 400 && response.status < 500) return { outcome: 'rejected', error: `Quo refused the text (${response.status}).` };
  return { outcome: 'uncertain', error: `Quo answered ${response.status}. Check the Quo app before sending anything again.` };
}

/* ---- the admin action ---- */

/* kind: 'job' | 'deposit' | 'text'; op: 'mark' (manual), 'start' (deposit link), 'refresh' (deposit),
   'send' (text). Returns the updated sale. */
export async function saleHandoff(store, admin, body, nowIso, env, deps = {}) {
  try {
    return await runHandoff(store, admin, body, nowIso, env, deps);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('knock_')) throw error;
    // The repo's Stripe helper throws its own errors; report them in canvassing terms.
    throw knockFailure('Stripe could not be reached or refused the request. Try again, or use the manual deposit.', 502, 'knock_stripe_failed');
  }
}

async function runHandoff(store, admin, { saleId, kind, op, ref = '', amount }, nowIso, env, deps) {
  const sale = await store.get('knock_sales', String(saleId || ''));
  if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
  if (sale.status === 'cancelled' && !(kind === 'deposit' && op === 'refresh')) throw knockFailure('That sale is cancelled.', 409, 'knock_sale_cancelled');
  const handoff = structuredClone(sale.handoff || {});
  const by = admin.user;
  const save = async () => {
    await store.commit([write.patch('knock_sales', sale.id, { handoff, updatedAt: nowIso }, sale.__updateTime)]);
    return { sale: { ...sale, handoff, updatedAt: nowIso } };
  };

  if (kind === 'job' && op === 'mark') {
    handoff.job = { ...handoff.job, mode: 'manual', status: 'created', ref: String(ref || '').slice(0, 200), at: nowIso, by };
    return save();
  }
  if (kind === 'deposit' && op === 'mark') {
    const value = amount == null || amount === '' ? Number(sale.depositAmount) : Number(amount);
    if (!Number.isFinite(value) || value <= 0) throw knockFailure('Enter the deposit amount collected.', 400, 'knock_invalid_amount');
    handoff.deposit = { ...handoff.deposit, status: 'collected', collectedAt: nowIso, collectedAmount: Math.round(value * 100) / 100, by, verifiedBy: 'admin' };
    return save();
  }
  if (kind === 'deposit' && op === 'start') {
    if (handoff.deposit?.status === 'collected') throw knockFailure('The deposit is already collected.', 409, 'knock_deposit_collected');
    const link = await startStripeDeposit(env, { ...sale, id: sale.id }, deps);
    handoff.deposit = { ...handoff.deposit, mode: 'stripe', status: 'link_ready', url: link.url, sessionId: link.sessionId, amount: link.amount, by };
    return save();
  }
  if (kind === 'deposit' && op === 'refresh') {
    const check = await refreshStripeDeposit(env, sale, deps);
    if (check.paid) handoff.deposit = { ...handoff.deposit, status: 'collected', collectedAt: handoff.deposit?.collectedAt || nowIso, collectedAmount: check.amount, verifiedBy: 'stripe' };
    else handoff.deposit = { ...handoff.deposit, lastCheckedAt: nowIso, stripeStatus: `${check.status}/${check.paymentStatus}` };
    return save();
  }
  if (kind === 'text' && op === 'mark') {
    handoff.text = { ...handoff.text, mode: 'manual', status: 'sent', sentAt: nowIso, by };
    return save();
  }
  if (kind === 'text' && op === 'send') {
    if (!sale.textConsent) throw knockFailure('The customer did not agree to a text.', 409, 'knock_text_no_consent');
    // One customer, one message: a receipt is claimed before Quo is called, so a second tap,
    // a retry or a second admin can never send it twice. Only a definite refusal frees it.
    const receiptId = `text_${sale.id}`;
    const receipt = await store.get('knock_receipts', receiptId);
    if (receipt && receipt.outcome !== 'rejected') throw knockFailure(receipt.outcome === 'sent' ? 'This customer was already texted.' : 'A text may already have gone out. Check the Quo app, then mark it sent.', 409, 'knock_text_already');
    const message = customerMessage({ ...sale, handoff });
    await store.commit([receipt
      ? write.patch('knock_receipts', receiptId, { outcome: 'sending', attempts: Number(receipt.attempts || 0) + 1, updatedAt: nowIso }, receipt.__updateTime)
      : write.create('knock_receipts', receiptId, { kind: 'sale_text', saleId: sale.id, outcome: 'sending', attempts: 1, createdAt: nowIso, updatedAt: nowIso, by })]);
    const result = await sendQuoText(env, sale.customer.phone, message, deps);
    await store.commit([write.patch('knock_receipts', receiptId, { outcome: result.outcome, messageId: result.messageId || '', error: result.error || '', updatedAt: nowIso })]);
    handoff.text = { ...handoff.text, mode: 'quo', status: result.outcome === 'sent' ? 'sent' : result.outcome, sentAt: result.outcome === 'sent' ? nowIso : null, messageId: result.messageId || '', error: result.error || '', by };
    const saved = await save();
    if (result.outcome !== 'sent') throw knockFailure(result.error, result.outcome === 'rejected' ? 400 : 502, `knock_text_${result.outcome}`, { sale: saved.sale });
    return saved;
  }
  throw knockFailure('Unknown hand-off.', 400, 'knock_unknown_action');
}

export function refundSummary(sale, now = Date.now()) {
  const cancelEndsAt = Date.parse(sale.cancelEndsAt);
  if (now < cancelEndsAt) return `Deposit fully refundable until midnight ${longDate(sale.cancelDeadlineDate)} (right to cancel).`;
  const start = zonedInstant(sale.jobDate, sale.jobStartTime || '08:00');
  const hours = Number(sale.refundCutoffHours || 24);
  const cutoff = start - hours * 3600000;
  return now < cutoff ? `Deposit refundable until ${formatClock(cutoff)} ${longDate(zonedDate(cutoff))} (${hours} hours before the job).` : `Deposit not refundable: inside ${hours} hours of the job.`;
}
