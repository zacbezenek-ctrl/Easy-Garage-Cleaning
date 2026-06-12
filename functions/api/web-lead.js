/**
 * EGC Website Lead relay — Cloudflare Pages Function
 * POST /api/web-lead
 *
 * The quote forms POST natively to Web3Forms (the email leg). fb-capture.js
 * mirrors the same submission here, and this function forwards it to the
 * Zapier Catch Hook for "EGC Website Lead → Instant Text" (SMS alert +
 * Meta CAPI Lead). Same pattern as crew-hook.js: the hook URL stays
 * server-side so page source never leaks it.
 *
 * Config (Cloudflare Pages dashboard → Settings → Environment variables):
 *   WEBSITE_LEAD_HOOK_URL — Zapier Catch Hook URL of the Website Lead Zap.
 *   No hardcoded fallback on purpose: this repo is public, so a baked-in
 *   hook would be burned on day one. Until the env var is set this relay
 *   answers 503 and the form keeps working through Web3Forms alone.
 *
 * Field names (name/phone/items/source/subject) match the trigger's stored
 * sample. They're sent BOTH as query params (so querystring.* references
 * resolve) and as a flat JSON body (so root-level references resolve).
 */

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
const MAX_BODY = 32 * 1024;
const FIELDS = ['name', 'phone', 'items', 'source', 'subject', 'fbc', 'fbp', 'fbclid', 'landing_url', 'referrer', 'page_url'];

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  // Same-origin native fetch sometimes omits both — payload validation below
  // is the real filter, this just rejects obvious off-origin abuse.
  if (!origin && !referer) return true;
  return ALLOWED_HOST_RE.test(hostOf(origin) || hostOf(referer));
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost({ request, env }) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });

  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

  let body;
  try { body = JSON.parse(raw); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  // Honeypot tripped — answer success so bots learn nothing, forward nothing.
  if (body.botcheck) return json(200, { ok: true });

  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name || phone.replace(/\D/g, '').length < 7) {
    return json(400, { ok: false, error: 'name and phone required' });
  }

  const hook = env.WEBSITE_LEAD_HOOK_URL;
  if (!hook) return json(503, { ok: false, error: 'Relay not configured' });

  const params = new URLSearchParams();
  const flat = {};
  for (const k of FIELDS) {
    const v = String(body[k] || '').trim();
    flat[k] = v;
    if (v) params.set(k, v);
  }

  try {
    const resp = await fetch(hook + (hook.includes('?') ? '&' : '?') + params.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flat),
    });
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      return json(502, { ok: false, error: 'Upstream rejected', status: resp.status, detail });
    }
    return json(200, { ok: true });
  } catch {
    return json(502, { ok: false, error: 'Upstream unreachable' });
  }
}

// Reject GET so the route can't be probed from a browser address bar.
export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}
