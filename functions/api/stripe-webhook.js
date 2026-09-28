/**
 * Stripe webhook receiver — customer payments and Garage Guard memberships
 * POST /api/stripe-webhook
 *
 * Records customer-portal and crew card payments on the Hub job (the Stripe
 * session ID makes every delivery idempotent) and tells the team (via the
 * Zapier hook → team SMS, same rail as website leads) when a membership
 * starts, renews-fails, or cancels, so the first visit gets scheduled and
 * lapsed members get a call.
 *
 * The webhook payload carries only the PaymentIntent ID, so before recording a
 * customer-portal or crew payment the session is read again from Stripe with
 * its charge expanded (STRIPE_SECRET_KEY); a Stripe error or a missing key is a
 * 503, so Stripe retries. A confirmed charge the job cannot take (a crew charge
 * above the balance or while an unverified receipt is on the job, or any charge
 * Stripe shows refunded) is held in payment_reviews/{sessionId} for a person
 * (GET /api/stripe-reviews) and acknowledged; the job is unchanged. A charge
 * that already has an open review is never settled by a webhook.
 *
 * With GARAGE_GUARD_MEMBERSHIP_SYNC_ENABLED=true, membership events are also
 * recorded once per event.id (stripe_events) in memberships/{subscriptionId},
 * linked to the Hub customer only by an exact match (otherwise a
 * membership_reviews item), mirrored onto the account job's garageGuard, and
 * the team alert is claimed durably so a replay never re-sends it. With the
 * flag off the Zapier relay payloads are exactly the pre-M2 ones.
 *
 * Security model:
 *  - Every request must carry a valid Stripe-Signature header. The HMAC is
 *    recomputed here with WebCrypto over the RAW body and compared in
 *    constant time; the timestamp must be within 5 minutes (replay window).
 *    Anything that fails gets a 400 and is never forwarded.
 *  - The event payload we forward is rebuilt from named fields — the raw
 *    body is never passed through to Zapier.
 *
 * Setup:
 *   1. Stripe Dashboard → Developers → Webhooks → Add endpoint:
 *        https://easygaragecleaning.com/api/stripe-webhook
 *      Events: checkout.session.completed, checkout.session.async_payment_succeeded,
 *              invoice.paid, invoice.payment_failed, customer.subscription.deleted
 *   2. Copy the endpoint's signing secret (whsec_...) into Cloudflare Pages
 *      env var STRIPE_WEBHOOK_SECRET.
 *   3. Optional: GARAGE_GUARD_HOOK_URL — Zapier Catch Hook for the team
 *      alert. Without it, events are verified and acknowledged but not
 *      forwarded (Stripe Dashboard remains the record).
 */

import { CHECKOUT_KINDS, readStripeCheckout, recordCrewStripePayment, recordCustomerStripePayment } from '../_lib/customer-payments.js';
import { applyGarageGuardEvent, claimGarageGuardAlert, expireGarageGuardAlert, garageGuardEvent, garageGuardMembershipSyncEnabled, membershipStorage, settleGarageGuardAlert } from '../_lib/garage-guard-membership.js';

const MAX_BODY = 256 * 1024;
const TOLERANCE_SECONDS = 300;

const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.deleted',
]);

// Tolerant env read: exact name first, then any dashboard var whose name
// normalizes (case/underscores/whitespace ignored) to the name or an alias.
function envVar(env, name, aliases = []) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (env && typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  const accepted = new Set([norm(name), ...aliases.map(norm)]);
  for (const k of Object.keys(env || {})) {
    if (accepted.has(norm(k)) && typeof env[k] === 'string' && env[k].trim()) return env[k].trim();
  }
  return '';
}

function hexOf(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(rawBody, header, secret, nowMs) {
  const tMatch = /(?:^|,)t=(\d+)/.exec(header || '');
  const sigs = [...(header || '').matchAll(/(?:^|,)v1=([0-9a-f]{64})/g)].map((m) => m[1]);
  if (!tMatch || sigs.length === 0) return false;

  const timestamp = parseInt(tMatch[1], 10);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > TOLERANCE_SECONDS) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + '.' + rawBody));
  const expected = hexOf(mac);
  return sigs.some((sig) => timingSafeEqual(sig, expected));
}

// Flatten only the fields the team alert needs — never the raw event. With
// membership sync off this is exactly the pre-M2 relay payload. Only the
// membership path (which alerts once per membership) announces an async-paid
// checkout as a new member and adds the Hub link state.
function summarize(event, { membership = false, hubLink = '' } = {}) {
  const obj = (event.data && event.data.object) || {};
  const base = {
    source: 'stripe-webhook',
    event_type: event.type,
    livemode: !!event.livemode,
    event_id: String(event.id || ''),
    ...(membership && hubLink ? { hub_customer: hubLink } : {}),
  };
  if (event.type === 'checkout.session.completed' || (membership && event.type === 'checkout.session.async_payment_succeeded')) {
    const details = obj.customer_details || {};
    const addressField = (obj.custom_fields || []).find((f) => f.key === 'service_address');
    return {
      ...base,
      alert: 'New Garage Guard member — schedule their first visit',
      plan: (obj.metadata && obj.metadata.plan) || '',
      customer_name: String(details.name || ''),
      customer_email: String(details.email || ''),
      customer_phone: String(details.phone || ''),
      service_address: String((addressField && addressField.text && addressField.text.value) || ''),
      amount_total: obj.amount_total != null ? (obj.amount_total / 100).toFixed(2) : '',
    };
  }
  if (event.type === 'invoice.payment_failed') {
    return {
      ...base,
      alert: 'Garage Guard renewal payment FAILED — reach out before it lapses',
      customer_email: String(obj.customer_email || ''),
      customer_name: String(obj.customer_name || ''),
      amount_due: obj.amount_due != null ? (obj.amount_due / 100).toFixed(2) : '',
    };
  }
  if (event.type === 'customer.subscription.deleted') {
    return {
      ...base,
      alert: 'Garage Guard membership cancelled',
      plan: (obj.metadata && obj.metadata.plan) || '',
      customer: String(obj.customer || ''),
    };
  }
  return base;
}

const HOOK_TIMEOUT_MS = 15000;
// Zapier accepted it (2xx), refused it (4xx other than 408), or the outcome is
// unknown (408, 5xx, a timeout or a lost response). Nothing is ever resent.
export function hookDelivery(response) {
  if (response?.ok) return 'sent';
  return response && response.status >= 400 && response.status < 500 && response.status !== 408 ? 'failed' : 'uncertain';
}

export function stripeWebhookHandlers({ storage = membershipStorage, now = () => new Date(), send = (url, init) => fetch(url, init), readCheckout = readStripeCheckout } = {}) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  const forward = (hook, body) => send(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });

  // Returns true once the event's alert is sent, refused, recorded uncertain,
  // or owned by another delivery; false while a claimed send may be in flight.
  async function alertTeam(store, event, input, outcome, hook) {
    if (outcome.alertStatus === 'sending') return expireGarageGuardAlert(store, input.eventId, now().toISOString());
    if (!outcome.alertPending) return true;
    const attemptId = crypto.randomUUID();
    // At most once per event: the claim is durable before the send.
    if (!await claimGarageGuardAlert(store, input.eventId, now().toISOString(), attemptId)) return true;
    let delivery = 'uncertain';
    try { delivery = hookDelivery(await forward(hook, summarize(event, { membership: true, hubLink: outcome.link }))); }
    catch { /* A timeout or lost response stays uncertain. */ }
    await settleGarageGuardAlert(store, input.eventId, delivery, now().toISOString(), attemptId);
    return true;
  }

  async function post({ request, env }) {
    const at = now(), stamp = at.toISOString();
    const secret = envVar(env, 'STRIPE_WEBHOOK_SECRET', ['STRIPE_WEBHOOK', 'STRIPE_WEBHOOK_KEY', 'STRIPE_SIGNING_SECRET']);
    if (!secret) return json(503, { ok: false, error: 'Webhook not configured' });

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

    const signature = request.headers.get('Stripe-Signature');
    const valid = await verifySignature(rawBody, signature, secret, at.getTime()).catch(() => false);
    if (!valid) return json(400, { ok: false, error: 'Invalid signature' });

    let event;
    try { event = JSON.parse(rawBody); }
    catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

    if (!HANDLED.has(event.type)) return json(200, { ok: true, received: true, ignored: true });

    const checkout = event.data?.object || {};
    if (event.type.startsWith('checkout.session.')) {
      if (checkout.metadata?.kind === CHECKOUT_KINDS.portal) {
        if (checkout.payment_status !== 'paid') return json(200, { ok: true, received: true, processing: true });
        try {
          // The charge (and any refund on it) is read from Stripe, never taken from the payload.
          const current = await readCheckout(env, checkout.id);
          const payment = await recordCustomerStripePayment(env, current, '', stamp, { recordedBy: 'stripe_webhook', settleHeld: false });
          return json(200, { ok: true, received: true, recorded: true, duplicate: payment.duplicate });
        } catch (error) {
          // A charge held in payment_reviews (Stripe shows it refunded) is durable and the job is unchanged.
          if (error.reviewRecorded) return json(200, { ok: true, received: true, recorded: false, reviewRequired: true, reason: error.code });
          // Stripe must retry a verified payment until its durable job record succeeds.
          return json(503, { ok: false, error: 'Payment recording needs retry' });
        }
      }
      if (checkout.metadata?.kind === CHECKOUT_KINDS.crew) {
        if (checkout.payment_status !== 'paid') return json(200, { ok: true, received: true, processing: true });
        try {
          const current = await readCheckout(env, checkout.id);
          const payment = await recordCrewStripePayment(env, current, { recordedBy: 'stripe_webhook', settleHeld: false, now: stamp });
          return json(200, { ok: true, received: true, recorded: true, duplicate: payment.duplicate });
        } catch (error) {
          // A confirmed charge the job cannot take is durably held in
          // payment_reviews for a manager, and the job is unchanged, so Stripe
          // can stop retrying this session.
          if (error.reviewRecorded) return json(200, { ok: true, received: true, recorded: false, reviewRequired: true, reason: error.code });
          // A session that fails verification (kind, currency, binding) was not
          // created by the Hub; it stays a failing delivery in Stripe.
          if (error.code === 'payment_unverified') return json(409, { ok: false, error: 'Payment needs manager review' });
          // Stripe retries until storage recovers.
          return json(503, { ok: false, error: 'Payment recording needs retry' });
        }
      }
      // One-time job payments must never be announced as new memberships.
      if (checkout.mode !== 'subscription') return json(200, { ok: true, received: true, ignored: true });
    }

    const hook = envVar(env, 'GARAGE_GUARD_HOOK_URL');
    if (!garageGuardMembershipSyncEnabled(env)) {
      if (event.type === 'invoice.paid') return json(200, { ok: true, received: true, ignored: true });
      if (hook) {
        // Best-effort forward; a Zapier hiccup must not make Stripe retry-storm us.
        try { await forward(hook, summarize(event)); }
        catch { /* acknowledged below regardless */ }
      }
      return json(200, { ok: true, received: true });
    }

    const input = garageGuardEvent(event);
    if (!input) return json(200, { ok: true, received: true, ignored: true });
    const store = storage(env);
    let outcome;
    try { outcome = await applyGarageGuardEvent(store, input, { now: stamp, alerts: Boolean(hook) }); }
    catch { return json(503, { ok: false, error: 'Membership recording needs retry' }); }
    if (outcome.status === 'ignored') return json(200, { ok: true, received: true, ignored: true });
    if (hook) {
      // The membership is recorded. An alert that is still pending, or claimed
      // but unsettled, makes Stripe redeliver instead of being acknowledged:
      // the redelivery is a duplicate that retries the claim (or, once stale,
      // records the claim 'uncertain') and never sends a claimed alert twice.
      let settled = false;
      try { settled = await alertTeam(store, event, input, outcome, hook); } catch { /* retried by Stripe */ }
      if (!settled) return json(503, { ok: false, error: 'Membership alert needs retry', membership: outcome.link || '' });
    }
    return json(200, { ok: true, received: true, duplicate: outcome.status === 'duplicate', membership: outcome.link || '' });
  }

  return { post };
}

const handlers = stripeWebhookHandlers();
export const onRequestPost = handlers.post;
