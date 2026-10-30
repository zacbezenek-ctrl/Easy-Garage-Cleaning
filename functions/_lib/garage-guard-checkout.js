/**
 * Garage Guard Stripe Checkout: the plans and the one subscription session request shared by the public page
 * (functions/api/garage-guard-checkout.js) and the staff sales tool (functions/api/garage-guard-sell.js, GUARD-SELL).
 *
 * The browser only ever names a plan KEY. Every amount (integer cents), product name, description and billing
 * interval is defined here, or by the STRIPE_PRICE_GUARD* dashboard Price ids, so a tampered request can never set its
 * own amount. The descriptions promise only what the membership delivers: 2026-10-30 removed "Unused visits convert to
 * $100 EGC gift cards" (Guard) and "Limited to 5 memberships" (Black), which nothing enforced.
 */

export const STRIPE_CHECKOUT_API = 'https://api.stripe.com/v1/checkout/sessions';
export const GARAGE_GUARD_STRIPE_VERSION = '2024-06-20';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Server-side source of truth for the Garage Guard tiers. Amounts are cents, billed once a year. Mirrors the crew
// Post-Job Playbook pitch (crew/postjob.html): open at Black, step down to Guard, Lite is the save. includes is the
// plain list the staff sales tool shows (the same promises as description).
export const GARAGE_GUARD_CHECKOUT_PLANS = freeze({
  lite: {
    name: 'Guard Lite',
    amount: 45000,
    priceEnv: 'STRIPE_PRICE_GUARD_LITE',
    description: 'Garage Guard membership — 2 maintenance visits a year: sweep, re-tidy, and a small junk haul each visit.',
    includes: ['2 maintenance visits a year', 'Sweep and re-tidy each visit', 'A small junk haul each visit'],
  },
  guard: {
    name: 'Garage Guard',
    amount: 80000,
    priceEnv: 'STRIPE_PRICE_GUARD',
    description: 'Garage Guard membership — 4 quarterly visits a year, up to 5 cubic yards hauled each visit.',
    includes: ['4 quarterly visits a year', 'Up to 5 cubic yards hauled each visit'],
  },
  black: {
    name: 'Guard Black',
    amount: 250000,
    priceEnv: 'STRIPE_PRICE_GUARD_BLACK',
    description: 'Garage Guard Black — monthly whole-property visits, free monthly single-item pickup, annual deep clean, front-of-line scheduling.',
    includes: ['Monthly whole-property visits', 'Free monthly single-item pickup', 'Annual deep clean', 'Front-of-line scheduling'],
  },
});

export const garageGuardPlan = key => typeof key === 'string' && Object.hasOwn(GARAGE_GUARD_CHECKOUT_PLANS, key) ? GARAGE_GUARD_CHECKOUT_PLANS[key] : null;

// Tolerant env read: exact name first, then any dashboard var whose name normalizes (case/underscores/whitespace
// ignored) to the name or an alias — so STRIPE_SECRET_KEY, Stripe_Secret, and "stripe secret" all resolve.
export function envVar(env, name, aliases = []) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (env && typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  const accepted = new Set([norm(name), ...aliases.map(norm)]);
  for (const k of Object.keys(env || {})) {
    if (accepted.has(norm(k)) && typeof env[k] === 'string' && env[k].trim()) return env[k].trim();
  }
  return '';
}

// The Stripe secret key under its common misnamings; a value that is clearly the wrong key type (pk_ = publishable)
// is refused so misconfiguration fails loud at the probe.
export function garageGuardStripeKey(env) {
  const key = envVar(env, 'STRIPE_SECRET_KEY', ['STRIPE_SECRET', 'STRIPE_KEY']);
  return /^(sk|rk)_/.test(key) ? key : '';
}

/**
 * The form body of one Garage Guard subscription Checkout session. origin is the request's own origin: success and
 * cancel return to the public page there, never a URL a client supplied. The staff sales tool adds, after the public
 * fields (so the public request is unchanged), the customer's email and garage address as editable defaults and its
 * attribution metadata on the session and the subscription. null for an unknown plan.
 */
export function garageGuardCheckoutParams(planKey, { origin, env = {}, customerEmail = '', serviceAddress = '', metadata = {} } = {}) {
  const plan = garageGuardPlan(planKey);
  if (!plan) return null;
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
  params.set('metadata[plan]', planKey);
  params.set('subscription_data[metadata][plan]', planKey);

  // Staff sales only: defaults the customer sees (and the address field stays editable) on the Stripe page.
  if (customerEmail) params.set('customer_email', customerEmail);
  if (serviceAddress) params.set('custom_fields[0][text][default_value]', serviceAddress);
  for (const [key, value] of Object.entries(metadata)) {
    if (!value || key === 'plan') continue;
    params.set(`metadata[${key}]`, String(value));
    params.set(`subscription_data[metadata][${key}]`, String(value));
  }
  return params;
}

/**
 * POST the session to Stripe. Returns {ok:true, session} or {ok:false, status, error} with the public endpoint's own
 * messages; Stripe's raw error is never relayed (it can name key types, price ids and account details).
 * idempotencyKey makes a retried staff request answer the same session instead of opening another.
 */
export async function createGarageGuardSession(secretKey, params, { fetcher = (...args) => fetch(...args), idempotencyKey = '' } = {}) {
  let resp;
  try {
    resp = await fetcher(STRIPE_CHECKOUT_API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': GARAGE_GUARD_STRIPE_VERSION,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: params.toString(),
    });
  } catch {
    return { ok: false, status: 502, error: 'Stripe unreachable' };
  }

  let session;
  try { session = await resp.json(); }
  catch { return { ok: false, status: 502, error: 'Bad Stripe response' }; }

  if (!resp.ok || !session || !session.url) return { ok: false, status: 502, error: 'Could not start checkout' };
  return { ok: true, session };
}
