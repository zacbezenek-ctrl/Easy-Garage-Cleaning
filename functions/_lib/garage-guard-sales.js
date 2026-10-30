/**
 * GUARD-SELL: staff Garage Guard sales (crew/guard-sell.js through /api/garage-guard-sell).
 *
 * A staff member picks a plan on their device; the server opens the same Stripe subscription Checkout as the public
 * page (garage-guard-checkout.js) with who sold it in the session and subscription metadata, and hands back a short
 * signed link (/api/garage-guard-link) that the device shows as a QR code. The customer pays on their own phone. When
 * the session completes, the Stripe webhook keeps the seller on the membership record (garage-guard-membership.js,
 * soldBy) so the owner can see who sold each membership. No commission rule exists for Garage Guard: the sale is
 * recorded for later and pays nothing.
 *
 * Texting the link to the customer is a customer send: only with EGC_GUARD_SALES_TEXT_ENABLED exactly "true" (off by
 * default), once per checkout session, to the job's linked HighLevel contact (customer-messaging.js, the same DND and
 * consent checks as the job thread). Registered as hub.guard_sale_link_text in automation-registry-data.js.
 */
import { staffKey } from './estimator-attribution.js';
import { GARAGE_GUARD_STRIPE_VERSION, garageGuardPlan, garageGuardStripeKey } from './garage-guard-checkout.js';

// Where the sale started: the crew post-job playbook, the estimator walkthrough after signing, the door-to-door app,
// or the Hub.
export const GUARD_SALE_CHANNELS = Object.freeze(['postjob', 'walkthrough', 'knock', 'hub']);
export const guardSalesTextEnabled = env => env?.EGC_GUARD_SALES_TEXT_ENABLED === 'true';

export const CHECKOUT_SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]{8,200}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export const guardRecordId = value => typeof value === 'string' && RECORD_ID.test(value) ? value : '';
export const guardRequestId = value => typeof value === 'string' && REQUEST_ID.test(value) ? value : '';
export const guardSessionId = value => typeof value === 'string' && CHECKOUT_SESSION_ID.test(value) ? value : '';
export const guardChannel = value => GUARD_SALE_CHANNELS.includes(value) ? value : '';
const line = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
export function guardEmail(value) {
  const email = line(value, 254).toLowerCase();
  return EMAIL.test(email) ? email : '';
}
// Stripe's custom field default is at most 255 characters.
export const guardAddress = value => line(value, 255);

/** The attribution a staff sale carries in its Stripe metadata (session and subscription). */
export function guardSaleMetadata({ seller, channel, jobId = '', customerId = '', requestId = '' }) {
  return {
    sold_by: staffKey(seller),
    sales_channel: guardChannel(channel),
    ...(guardRecordId(jobId) ? { sale_job_id: jobId } : {}),
    ...(guardRecordId(customerId) ? { sale_customer_id: customerId } : {}),
    ...(guardRequestId(requestId) ? { sale_request_id: requestId } : {}),
  };
}

/** {staffKey, channel, jobId, customerId} from Stripe metadata a staff sale wrote, or null for any other session. */
export function guardSaleFromMetadata(metadata) {
  const data = metadata && typeof metadata === 'object' ? metadata : {};
  const seller = staffKey(data.sold_by), channel = guardChannel(data.sales_channel);
  if (!seller || !channel) return null;
  return { staffKey: seller, channel, jobId: guardRecordId(data.sale_job_id), customerId: guardRecordId(data.sale_customer_id) };
}

const encoder = new TextEncoder();
const base64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The link signature: 128 bits of HMAC-SHA256 over the session id under the Hub's signing secret, so the public link
// route only ever asks Stripe about sessions this server opened. '' while HUB_SESSION_SECRET is unset.
export async function guardLinkSignature(env, sessionId) {
  const secret = typeof env?.HUB_SESSION_SECRET === 'string' ? env.HUB_SESSION_SECRET : '';
  if (!secret || !guardSessionId(sessionId)) return '';
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`egc-guard-link-v1\n${sessionId}`)));
  return base64Url(mac.slice(0, 16));
}

export async function guardLinkValid(env, sessionId, signature) {
  const expected = await guardLinkSignature(env, sessionId);
  if (!expected || typeof signature !== 'string' || signature.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return diff === 0;
}

/** The short link the device shows as a QR code and copies: origin is the request's own. '' without a secret. */
export async function guardSaleLink(env, origin, sessionId) {
  const signature = await guardLinkSignature(env, sessionId);
  return signature ? `${origin}/api/garage-guard-link?s=${sessionId}&k=${signature}` : '';
}

/** The plan's yearly price for people: "$800" or "$2,500" (whole dollars), from integer cents. */
export function guardPlanPrice(amountCents) {
  const dollars = Math.floor(amountCents / 100), cents = amountCents % 100;
  return `$${dollars.toLocaleString('en-US')}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`;
}

// The one text the tool can send (registered with this exact text in automation-registry-data.js).
export const GUARD_SALE_TEXT_TEMPLATE = 'Easy Garage Cleaning: here is your [PLAN] sign-up link ([PRICE] a year, paid securely through Stripe): [LINK] Questions? Reply here.';
export function guardSaleText(planKey, link) {
  const plan = garageGuardPlan(planKey);
  if (!plan || !link) return '';
  return GUARD_SALE_TEXT_TEMPLATE.replace('[PLAN]', plan.name).replace('[PRICE]', guardPlanPrice(plan.amount)).replace('[LINK]', link);
}

/**
 * The Checkout session as Stripe holds it now. Throws {code, status} errors: guard_sales_stripe_unconfigured (503),
 * guard_sales_stripe_unavailable (503, Stripe did not answer or answered with something else),
 * guard_sales_session_missing (404).
 */
export async function readGuardCheckout(env, sessionId, { fetcher = (...args) => fetch(...args) } = {}) {
  const secret = garageGuardStripeKey(env), id = guardSessionId(sessionId);
  const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
  if (!secret) throw fail('guard_sales_stripe_unconfigured', 'Stripe is not set up for Garage Guard yet.', 503);
  if (!id) throw fail('guard_sales_session_missing', 'That sign-up was not found.', 404);
  let response;
  try {
    response = await fetcher(`https://api.stripe.com/v1/checkout/sessions/${id}`, {
      method: 'GET', headers: { Authorization: 'Bearer ' + secret, 'Stripe-Version': GARAGE_GUARD_STRIPE_VERSION }, signal: AbortSignal.timeout(15000),
    });
  } catch { throw fail('guard_sales_stripe_unavailable', 'Stripe did not answer. Try again in a moment.', 503); }
  const session = await response.json().catch(() => null);
  if (response.status === 404) throw fail('guard_sales_session_missing', 'That sign-up was not found.', 404);
  if (!response.ok || session?.id !== id) throw fail('guard_sales_stripe_unavailable', 'Stripe did not answer. Try again in a moment.', 503);
  return session;
}

/** What the device may know about a sale: open, complete or expired, and whether the customer is now a member. */
export function guardCheckoutState(session) {
  const status = ['open', 'complete', 'expired'].includes(session?.status) ? session.status : 'open';
  return {
    status,
    member: status === 'complete' && ['paid', 'no_payment_required'].includes(session?.payment_status),
    plan: garageGuardPlan(session?.metadata?.plan) ? session.metadata.plan : '',
  };
}
