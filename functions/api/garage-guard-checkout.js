/**
 * Garage Guard — Stripe Checkout relay (Cloudflare Pages Function)
 * POST /api/garage-guard-checkout   body: { plan: "lite" | "guard" | "black" }
 * GET  /api/garage-guard-checkout   → config probe (booleans only)
 *
 * Security model (why this is safe to expose):
 *  - The browser only ever sends a plan KEY. Every price, product name, and
 *    billing interval is defined server-side in functions/_lib/garage-guard-checkout.js
 *    (or by STRIPE_PRICE_* env vars) — a tampered request can never set its own amount.
 *  - STRIPE_SECRET_KEY lives only in Cloudflare env vars. It is never sent to
 *    the client and never logged.
 *  - Card details are entered on Stripe-hosted Checkout (PCI SAQ-A). Card
 *    numbers never touch this site, this function, or our logs.
 *  - success/cancel URLs are built from the request's own origin after the
 *    same origin allowlist web-lead.js uses, so checkout can't be pointed at
 *    a look-alike domain.
 *
 * Config (Cloudflare Pages → Settings → Variables and Secrets, Production):
 *   STRIPE_SECRET_KEY          — required. sk_live_... (or sk_test_ to test).
 *   STRIPE_PRICE_GUARD_LITE    — optional Stripe Price IDs (price_...). When
 *   STRIPE_PRICE_GUARD           set, Checkout uses your dashboard Prices so
 *   STRIPE_PRICE_GUARD_BLACK     reporting groups under one Product. When
 *                                unset, the session falls back to the inline
 *                                amounts in the shared plans — checkout works either way.
 */

import { createGarageGuardSession, garageGuardCheckoutParams, garageGuardPlan, garageGuardStripeKey, GARAGE_GUARD_CHECKOUT_PLANS } from '../_lib/garage-guard-checkout.js';

const ALLOWED_HOST_RE = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const MAX_BODY = 4 * 1024;

// The plans (amounts in cents, names, descriptions) and the session request live in
// functions/_lib/garage-guard-checkout.js, shared with the staff sales tool (/api/garage-guard-sell).

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  if (!origin && !referer) return true;
  return ALLOWED_HOST_RE.test(hostOf(origin) || hostOf(referer));
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

  let body;
  try { body = JSON.parse(raw); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const planKey = String(body?.plan || '');
  if (!garageGuardPlan(planKey)) return json(400, { ok: false, error: 'Unknown plan' });

  const secretKey = garageGuardStripeKey(env);
  if (!secretKey) return json(503, { ok: false, error: 'Payments not configured' });

  // Same-origin redirect targets only — the client cannot supply URLs.
  const params = garageGuardCheckoutParams(planKey, { origin: new URL(request.url).origin, env });
  const created = await createGarageGuardSession(secretKey, params);
  if (!created.ok) return json(created.status, { ok: false, error: created.error });
  return json(200, { ok: true, url: created.session.url });
}

export async function onRequestGet({ env }) {
  return json(200, {
    ok: true,
    configured: !!garageGuardStripeKey(env),
    plans: Object.keys(GARAGE_GUARD_CHECKOUT_PLANS),
  });
}
