/**
 * Garage Guard — subscription management (Cloudflare Pages Function)
 *
 * GET  /api/garage-guard-portal
 *   → { ok, portal_login_url } — the Stripe-hosted Customer Portal login
 *     link for returning members. Stripe verifies the member itself by
 *     emailing a one-time code, so we never build (or get wrong) our own
 *     auth. Configure it once: Stripe Dashboard → Settings → Billing →
 *     Customer portal → "Launch customer portal with a link".
 *
 * POST /api/garage-guard-portal
 *   body: { session_id: "cs_...", mode: "status" | "portal" }
 *   - "status": verifies a just-completed Checkout session and returns its
 *     paid state + plan, so the success banner never claims a payment that
 *     didn't happen.
 *   - "portal": exchanges that session for a short-lived Stripe Billing
 *     Portal URL so the new member can immediately manage billing.
 *
 * Security model:
 *  - The Checkout session id is a high-entropy secret Stripe hands only to
 *    the paying browser via the success redirect — treating it as a bearer
 *    token for the customer who just paid is Stripe's documented pattern.
 *    It is format-checked here and everything else comes from Stripe's API,
 *    never from the client.
 *  - No customer lookup by email exists on purpose: an email→portal endpoint
 *    would let anyone who knows a member's email open their billing. The
 *    Stripe login link (email one-time code) covers returning members safely.
 *  - Only the member's own email (masked) and plan ever leave this function.
 *
 * Config (Cloudflare Pages → Variables and Secrets):
 *   STRIPE_SECRET_KEY        — required (shared with garage-guard-checkout.js)
 *   STRIPE_PORTAL_LOGIN_URL  — recommended. https://billing.stripe.com/p/login/...
 */

const ALLOWED_HOST_RE = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;
const MAX_BODY = 4 * 1024;
const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]{10,120}$/;

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

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

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return '';
  return s[0] + '•••' + s.slice(at);
}

async function stripe(secretKey, path, params) {
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + secretKey,
      'Stripe-Version': '2024-06-20',
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? params.toString() : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data };
}

export async function onRequestGet({ env }) {
  // Only surface the login link if it actually points at Stripe billing —
  // a mispasted env var must not become a redirect to who-knows-where.
  let portalLoginUrl = envVar(env, 'STRIPE_PORTAL_LOGIN_URL', ['STRIPE_PORTAL_LINK', 'STRIPE_PORTAL_URL', 'STRIPE_PORTAL_LOGIN_LINK']).trim();
  if (!/^https:\/\/billing\.stripe\.com\//.test(portalLoginUrl)) portalLoginUrl = '';
  return json(200, {
    ok: true,
    configured: !!stripeKey(env),
    portal_login_url: portalLoginUrl,
  });
}

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

  let body;
  try { body = JSON.parse(raw); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const sessionId = String(body.session_id || '');
  if (!SESSION_ID_RE.test(sessionId)) return json(400, { ok: false, error: 'Invalid session id' });
  const mode = body.mode === 'portal' ? 'portal' : 'status';

  const secretKey = stripeKey(env);
  if (!secretKey) return json(503, { ok: false, error: 'Payments not configured' });

  let session;
  try {
    const res = await stripe(secretKey, 'checkout/sessions/' + encodeURIComponent(sessionId));
    if (!res.ok) return json(404, { ok: false, error: 'Session not found' });
    session = res.data;
  } catch {
    return json(502, { ok: false, error: 'Stripe unreachable' });
  }

  const paid = session.status === 'complete' && session.payment_status !== 'unpaid';

  if (mode === 'status') {
    return json(200, {
      ok: true,
      paid,
      plan: (session.metadata && session.metadata.plan) || '',
      email: maskEmail(session.customer_details && session.customer_details.email),
    });
  }

  // mode === 'portal'
  if (!paid || !session.customer) return json(409, { ok: false, error: 'Session not completed' });

  const origin = new URL(request.url).origin;
  const params = new URLSearchParams();
  params.set('customer', String(session.customer));
  params.set('return_url', origin + '/garage-guard.html');

  try {
    const res = await stripe(secretKey, 'billing_portal/sessions', params);
    if (!res.ok || !res.data.url) return json(502, { ok: false, error: 'Could not open billing portal' });
    return json(200, { ok: true, url: res.data.url });
  } catch {
    return json(502, { ok: false, error: 'Stripe unreachable' });
  }
}
