/**
 * EGC → Quo (formerly OpenPhone) SMS sender — Cloudflare Pages Function
 * POST /api/quo-send   { to: "+1...", message: "..." }
 *
 * Sends a text straight through the Quo API instead of routing via Zapier.
 * Quo kept OpenPhone's REST API, so the default host is api.openphone.com.
 *
 * Env (Cloudflare Pages → Settings → Environment variables):
 *   QUO_API_KEY  (required) — Quo workspace API key. Sent as the Authorization
 *                header value verbatim (OpenPhone-style: NOT "Bearer <key>").
 *   QUO_FROM     (optional) — the EGC Quo number to send from. Default +19709991818.
 *   QUO_API_BASE (optional) — default https://api.openphone.com/v1. Override if Quo
 *                moves the host (e.g. https://api.quo.com/v1) or auth changes.
 */

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
function hostOf(v) { try { return new URL(v).host; } catch { return ''; } }
function originAllowed(request) {
  const o = request.headers.get('Origin'), r = request.headers.get('Referer');
  if (!o && !r) return true;
  return ALLOWED_HOST_RE.test(hostOf(o) || hostOf(r));
}
// US phone → E.164 so Quo accepts it no matter how the crew typed it.
function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length > 10) return '+' + d;
  return '';
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}
export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}

export async function onRequestPost({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });

  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });
  if (!env.QUO_API_KEY) return json(501, { ok: false, error: 'Quo not configured — set QUO_API_KEY' });

  let body;
  try { body = JSON.parse(await request.text()); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const to = normPhone(body.to);
  const message = String(body.message || '').slice(0, 1500);
  if (!to || !message) return json(400, { ok: false, error: 'to and message are required' });

  const base = (env.QUO_API_BASE || 'https://api.openphone.com/v1').replace(/\/$/, '');
  const from = env.QUO_FROM || '+19709991818';

  try {
    const r = await fetch(base + '/messages', {
      method: 'POST',
      headers: { Authorization: env.QUO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], content: message }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = JSON.stringify(data).slice(0, 300);
      return json(502, { ok: false, error: 'Quo rejected the message', status: r.status, detail });
    }
    return json(200, { ok: true, id: (data && data.data && data.data.id) || '' });
  } catch (e) {
    return json(502, { ok: false, error: 'Quo unreachable' });
  }
}
