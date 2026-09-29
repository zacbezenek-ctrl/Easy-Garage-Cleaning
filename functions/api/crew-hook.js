/**
 * EGC Crew Tools webhook proxy — Cloudflare Pages Function
 * POST /api/crew-hook
 *
 * Why this exists:
 *  - Keeps the Zapier Catch Hook URL OUT of public page source. Function code
 *    is never served to the browser, so View Source on /crew/* no longer leaks it.
 *  - Returns a real, same-origin (readable) status to the crew tools, so the
 *    iPad can honestly show "sent" vs "FAILED" instead of always-green no-cors.
 *  - Lets us validate payloads and reject off-origin abuse before anything
 *    reaches Zapier (the review path can text arbitrary numbers, so the hook
 *    must not be an open relay).
 *
 * Config (Cloudflare Pages dashboard → Settings → Environment variables):
 *   CREW_WEBHOOK_URL — the Zapier Catch Hook URL. The Zap on the other end
 *   branches by `tool`:  game_plan → Create Job in Jobber (maps the flattened
 *   li1..li4 line items),  review_request / plan_text → Quo send,  post_job →
 *   post-job updates. This lives in the server-side function (never served to
 *   the browser). If the repo is public and you want the URL private, set
 *   CREW_WEBHOOK_URL as a Cloudflare secret instead and leave the fallback unused.
 */

import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { jobberGuardSwitches } from '../_lib/jobber-guard.js';

const ALLOWED_TOOLS = new Set(['game_plan', 'review_request', 'post_job', 'plan_text']);
const MAX_BODY = 256 * 1024; // 256 KB — generous for a signature dataURL, caps abuse

// Same pattern as functions/api/field-jobs.js: a present Origin/Referer must be
// this exact origin. Absent headers are allowed (some same-origin fetches omit
// Origin) because the business session cookie is SameSite=Strict.
const mutationOriginAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
};
const jsonRequest = request => request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json';

// Same-origin crew pages never need CORS; a foreign preflight gets no grant.
export async function onRequestOptions({ request }) {
  if (!mutationOriginAllowed(request)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// The second argument only lets tests inject the clock and definitions.
export async function onRequestPost({ request, env }, { now = () => new Date(), definitions } = {}) {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });

  if (!mutationOriginAllowed(request)) return json(403, { ok: false, code: 'CREW_HOOK_ORIGIN_FORBIDDEN', error: 'Forbidden origin' });
  if (!jsonRequest(request)) return json(415, { ok: false, code: 'CREW_HOOK_JSON_REQUIRED', error: 'Workflow triggers must be sent as JSON.' });
  const session = await getHubSession(request, env);
  if (!session) return json(401, { ok: false, error: 'Sign in to the EGC Hub' });
  if (!hasBusinessAccess(session)) return json(403, { ok: false, error: 'Business access is required for external workflow triggers. Complete assigned work from the field job.' });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

  let body;
  try { body = JSON.parse(raw); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, error: 'Invalid JSON' });

  const tool = String(body.tool || '');
  if (!ALLOWED_TOOLS.has(tool)) return json(400, { ok: false, error: 'Unknown tool' });

  // FUN-32 booking guard: from the Jobber cutover day on, a signed game plan is
  // saved in the Hub only and never reaches the Zap branch that creates a Jobber
  // job. Off unless EGC_JOBBER_GUARD_BOOKING is exactly 'true'.
  if (tool === 'game_plan' && env.EGC_JOBBER_GUARD_BOOKING === 'true') {
    let switches;
    try { switches = jobberGuardSwitches(env, now(), definitions); }
    catch { return json(503, { ok: false, code: 'CREW_HOOK_JOBBER_GUARD_UNAVAILABLE', error: 'The Jobber cutover could not be checked, so nothing was sent to Jobber. Retry.' }); }
    if (switches.booking) return json(409, { ok: false, code: 'CREW_HOOK_JOBBER_RETIRED', error: `Jobber was retired on ${switches.cutoverDate}. The signed game plan is kept in the EGC Hub; nothing was sent to Jobber.` });
  }

  // The review path actually sends an SMS downstream — never forward one
  // without both a destination and a message.
  if (tool === 'review_request' && (!/^\+?[1-9]\d{9,14}$/.test(String(body.phone || '').replace(/[^\d+]/g, '')) || !String(body.message || '').trim() || String(body.message).length > 800)) {
    return json(400, { ok: false, error: 'review_request requires phone and message' });
  }

  const hook = env.CREW_WEBHOOK_URL;
  if (!hook) return json(501, { ok: false, error: 'CREW_WEBHOOK_URL is not configured' });

  try {
    const resp = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });
    if (!resp.ok) {
      return json(502, { ok: false, error: 'Upstream rejected', status: resp.status });
    }
    return json(200, { ok: true, tool });
  } catch (e) {
    return json(502, { ok: false, error: 'Upstream unreachable' });
  }
}

// Reject GET so the route can't be probed from a browser address bar.
// (POST and OPTIONS are handled above; other methods 405 automatically.)
export async function onRequestGet() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}
