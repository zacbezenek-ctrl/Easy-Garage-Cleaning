/**
 * Stripe webhook receiver — Garage Guard memberships (Cloudflare Pages Function)
 * POST /api/stripe-webhook
 *
 * Tells the team (via the Zapier hook → team SMS, same rail as website leads)
 * when a membership starts, renews-fails, or cancels, so the first visit gets
 * scheduled and lapsed members get a call.
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
 *      Events: checkout.session.completed, invoice.payment_failed,
 *              customer.subscription.deleted
 *   2. Copy the endpoint's signing secret (whsec_...) into Cloudflare Pages
 *      env var STRIPE_WEBHOOK_SECRET.
 *   3. Optional: GARAGE_GUARD_HOOK_URL — Zapier Catch Hook for the team
 *      alert. Without it, events are verified and acknowledged but not
 *      forwarded (Stripe Dashboard remains the record).
 */

const MAX_BODY = 256 * 1024;
const TOLERANCE_SECONDS = 300;

const HANDLED = new Set([
  'checkout.session.completed',
  'invoice.payment_failed',
  'customer.subscription.deleted',
]);

function envVar(env, name) {
  if (env && env[name]) return env[name];
  for (const k of Object.keys(env || {})) {
    if (k.trim() === name && env[k]) return env[k];
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

async function verifySignature(rawBody, header, secret) {
  const tMatch = /(?:^|,)t=(\d+)/.exec(header || '');
  const sigs = [...(header || '').matchAll(/(?:^|,)v1=([0-9a-f]{64})/g)].map((m) => m[1]);
  if (!tMatch || sigs.length === 0) return false;

  const timestamp = parseInt(tMatch[1], 10);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + '.' + rawBody));
  const expected = hexOf(mac);
  return sigs.some((sig) => timingSafeEqual(sig, expected));
}

// Flatten only the fields the team alert needs — never the raw event.
function summarize(event) {
  const obj = (event.data && event.data.object) || {};
  const base = {
    source: 'stripe-webhook',
    event_type: event.type,
    livemode: !!event.livemode,
    event_id: String(event.id || ''),
  };
  if (event.type === 'checkout.session.completed') {
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

export async function onRequestPost({ request, env }) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  const secret = envVar(env, 'STRIPE_WEBHOOK_SECRET');
  if (!secret) return json(503, { ok: false, error: 'Webhook not configured' });

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

  const signature = request.headers.get('Stripe-Signature');
  const valid = await verifySignature(rawBody, signature, secret).catch(() => false);
  if (!valid) return json(400, { ok: false, error: 'Invalid signature' });

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  if (!HANDLED.has(event.type)) return json(200, { ok: true, received: true, ignored: true });

  const hook = envVar(env, 'GARAGE_GUARD_HOOK_URL');
  if (hook) {
    // Best-effort forward; a Zapier hiccup must not make Stripe retry-storm us.
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(summarize(event)),
      });
    } catch { /* acknowledged below regardless */ }
  }

  return json(200, { ok: true, received: true });
}
