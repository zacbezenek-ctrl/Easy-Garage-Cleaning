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
import { readJob } from '../_lib/firestore-job.js';

// Hosts allowed to POST here. Referer/Origin is spoofable via curl, so this is
// a casual-abuse filter, not real auth — pair with Cloudflare Access for that.
const ALLOWED_HOST_RE = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;

const ALLOWED_TOOLS = new Set(['game_plan', 'review_request', 'post_job', 'plan_text']);
const MAX_BODY = 256 * 1024; // 256 KB — generous for a signature dataURL, caps abuse

function hostOf(value) {
  try { return new URL(value).host; } catch { return ''; }
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  // If neither header is present we can't vet it — allow (native fetch sometimes
  // omits Origin same-origin), the payload validation below is the real filter.
  if (!origin && !referer) return true;
  const h = hostOf(origin) || hostOf(referer);
  return ALLOWED_HOST_RE.test(h);
}

const personKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function assignedToJob(job, session) {
  const identities = [session.user, session.displayName].map(personKey).filter(Boolean);
  const crew = [
    ...(Array.isArray(job.assignedCrew) ? job.assignedCrew : []),
    ...String(job.assignedTo || '').split(/\s*(?:,|\+|&|\band\b)\s*/i),
  ].map(value => personKey(typeof value === 'string' ? value : value?.name || value?.id || '')).filter(Boolean);
  return crew.some(name => identities.some(identity => name === identity ||
    (Math.min(name.length, identity.length) >= 3 && (name.startsWith(identity) || identity.startsWith(name)))));
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
  const session = await getHubSession(request, env);
  if (!session) return json(401, { ok: false, error: 'Sign in to the EGC Hub' });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Payload too large' });

  let body;
  try { body = JSON.parse(raw); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const tool = String(body.tool || '');
  if (!ALLOWED_TOOLS.has(tool)) return json(400, { ok: false, error: 'Unknown tool' });

  if (!hasBusinessAccess(session)) {
    if (!['review_request', 'post_job'].includes(tool)) {
      return json(403, { ok: false, error: 'Business access required' });
    }
    const jobId = String(body.job_id || '');
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(jobId)) return json(400, { ok: false, error: 'A valid assigned job is required' });
    const job = await readJob(env, jobId).catch(() => null);
    if (!job || !assignedToJob(job, session)) return json(403, { ok: false, error: 'This job is not assigned to you' });
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
