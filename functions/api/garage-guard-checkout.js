/**
 * Garage Guard — Stripe Checkout relay (Cloudflare Pages Function)
 * POST /api/garage-guard-checkout   body: { plan: "lite" | "guard" | "black" }
 * GET  /api/garage-guard-checkout   → config probe (booleans only)
 *
 * Security model (why this is safe to expose):
 *  - The browser only ever sends a plan KEY. Every price, product name, and
 *    billing interval is defined server-side below (or by STRIPE_PRICE_* env
 *    vars) — a tampered request can never set its own amount.
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
 *                                amounts below — checkout works either way.
 */

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
const MAX_BODY = 4 * 1024;
const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';

// Server-side source of truth for the Garage Guard tiers. Amounts are cents.
// Mirrors the crew Post-Job Playbook pitch (crew/postjob.html): open at Black,
// step down to Guard, Lite is the save.
const PLANS = {
  lite: {
    name: 'Guard Lite',
    amount: 45000,
    priceEnv: 'STRIPE_PRICE_GUARD_LITE',
    description: 'Garage Guard membership — 2 maintenance visits a year: sweep, re-tidy, and a small junk haul each visit.',
  },
  guard: {
    name: 'Garage Guard',
    amount: 80000,
    priceEnv: 'STRIPE_PRICE_GUARD',
    description: 'Garage Guard membership — 4 quarterly visits a year, up to 5 cubic yards hauled each visit. Unused visits convert to $100 EGC gift cards.',
  },
  black: {
    name: 'Guard Black',
    amount: 250000,
    priceEnv: 'STRIPE_PRICE_GUARD_BLACK',
    description: 'Garage Guard Black — monthly whole-property visits, free monthly single-item pickup, annual deep clean, front-of-line scheduling. Limited to 5 memberships.',
  },
};

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

// Tolerant env read: exact name first, then any dashboard var whose name
// normalizes (case/underscores/whitespace ignored) to the name or an alias —
// so STRIPE_SECRET_KEY, Stripe_Secret, and "stripe secret" all resolve.
function envVar(env, name, aliases = []) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (env && typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  const accepted = new Set([norm(name), ...aliases.map(norm)]);
  for (const k of Object.keys(env || {})) {
    if (accepted.has(norm(k)) && typeof env[k] === 'string' && env[k].trim()) return env[k].trim();
  }
  return '';
}

// Resolve the Stripe secret key under its common misnamings, and reject
// values that are clearly the wrong key type (pk_ = publishable, safe to
// expose but useless server-side) so misconfig fails loud at the probe.
function stripeKey(env) {
  const key = envVar(env, 'STRIPE_SECRET_KEY', ['STRIPE_SECRET', 'STRIPE_KEY']);
  return /^(sk|rk)_/.test(key) ? key : '';
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

  const plan = PLANS[String(body.plan || '')];
  if (!plan) return json(400, { ok: false, error: 'Unknown plan' });

  const secretKey = stripeKey(env);
  if (!secretKey) return json(503, { ok: false, error: 'Payments not configured' });

  // Same-origin redirect targets only — the client cannot supply URLs.
  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('success_url', origin + '/garage-guard.html?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  params.set('cancel_url', origin + '/garage-guard.html?checkout=cancelled#plans');
  params.set('line_items[0][quantity]', '1');

  const priceId = envVar(env, plan.priceEnv);
  if (priceId) {
    params.set('line_items[0][price]', priceId);
  } else {
    params.set('line_items[0][price_data][currency]', 'usd');
    params.set('line_items[0][price_data][unit_amount]', String(plan.amount));
    params.set('line_items[0][price_data][recurring][interval]', 'year');
    params.set('line_items[0][price_data][product_data][name]', plan.name);
    params.set('line_items[0][price_data][product_data][description]', plan.description);
  }

  // We need a callable member with a garage we can find.
  params.set('phone_number_collection[enabled]', 'true');
  params.set('billing_address_collection', 'auto');
  params.set('custom_fields[0][key]', 'service_address');
  params.set('custom_fields[0][label][type]', 'custom');
  params.set('custom_fields[0][label][custom]', 'Garage address (street + city)');
  params.set('custom_fields[0][type]', 'text');
  params.set('allow_promotion_codes', 'true');
  params.set('metadata[plan]', String(body.plan));
  params.set('subscription_data[metadata][plan]', String(body.plan));

  let resp;
  try {
    resp = await fetch(STRIPE_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body: params.toString(),
    });
  } catch {
    return json(502, { ok: false, error: 'Stripe unreachable' });
  }

  let session;
  try { session = await resp.json(); }
  catch { return json(502, { ok: false, error: 'Bad Stripe response' }); }

  if (!resp.ok || !session.url) {
    // Never relay Stripe's raw error to the browser — it can name key types,
    // price IDs, and account details.
    return json(502, { ok: false, error: 'Could not start checkout' });
  }

  return json(200, { ok: true, url: session.url });
}

export async function onRequestGet({ env }) {
  return json(200, {
    ok: true,
    configured: !!stripeKey(env),
    plans: Object.keys(PLANS),
  });
}
