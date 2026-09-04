/**
 * EGC Jobber customer lookup — Cloudflare Pages Function
 * GET /api/jobber-clients?q=<search>
 *
 * Lets the crew tools search Jobber clients by name/phone/address and
 * pre-fill the job card. Read-only (read_clients scope).
 *
 * Env vars: JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN
 * (minted once via /api/jobber-auth — see that file for the setup steps).
 *
 * Response: { ok:true, clients:[{id,name,phone,address,email}] }
 */

import { getHubSession } from '../_lib/hub-session.js';

const TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const GQL_URL = 'https://api.getjobber.com/api/graphql';
const GQL_VERSION = '2023-11-15'; // bump if Jobber retires this version

const ALLOWED_HOST_RE = /(^|\.)easygaragecleaning\.com$|(\.pages\.dev)$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
function hostOf(v) { try { return new URL(v).host; } catch { return ''; } }
function originAllowed(request) {
  const o = request.headers.get('Origin'), r = request.headers.get('Referer');
  if (!o && !r) return true;
  return ALLOWED_HOST_RE.test(hostOf(o) || hostOf(r));
}

// Access tokens last ~60 min; cache per isolate so bursts of lookups don't re-mint.
let cached = { token: null, exp: 0 };
async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.JOBBER_REFRESH_TOKEN,
      client_id: env.JOBBER_CLIENT_ID,
      client_secret: env.JOBBER_CLIENT_SECRET,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error('jobber token refresh failed: ' + resp.status);
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in || 3600) * 1000) };
  return cached.token;
}

const QUERY = `query EgcClientSearch($q: String!) {
  clients(searchTerm: $q, first: 8) {
    nodes {
      id
      name
      firstName
      lastName
      phones { number primary }
      emails { address primary }
      billingAddress { street city province postalCode }
    }
  }
}`;

export async function onRequestGet({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });

  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });
  if (!await getHubSession(request, env)) return json(401, { ok: false, error: 'Sign in to the EGC Hub' });
  if (!env.JOBBER_CLIENT_ID || !env.JOBBER_CLIENT_SECRET || !env.JOBBER_REFRESH_TOKEN) {
    return json(501, { ok: false, error: 'Jobber lookup not configured — run /api/jobber-auth setup' });
  }

  const q = String(new URL(request.url).searchParams.get('q') || '').trim().slice(0, 80);
  if (q.length < 2) return json(400, { ok: false, error: 'Search needs at least 2 characters' });

  try {
    const token = await accessToken(env);
    const resp = await fetch(GQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-JOBBER-GRAPHQL-VERSION': GQL_VERSION,
      },
      body: JSON.stringify({ query: QUERY, variables: { q } }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.errors) {
      const detail = JSON.stringify(data.errors || data).slice(0, 300);
      return json(502, { ok: false, error: 'Jobber query failed', detail });
    }
    const nodes = (data.data && data.data.clients && data.data.clients.nodes) || [];
    const clients = nodes.map(n => {
      const phone = (n.phones || []).find(p => p.primary) || (n.phones || [])[0] || {};
      const email = (n.emails || []).find(e => e.primary) || (n.emails || [])[0] || {};
      const a = n.billingAddress || {};
      return {
        id: n.id,
        name: n.name || [n.firstName, n.lastName].filter(Boolean).join(' '),
        phone: phone.number || '',
        email: email.address || '',
        address: [a.street, a.city].filter(Boolean).join(', '),
      };
    });
    return json(200, { ok: true, clients });
  } catch (e) {
    return json(502, { ok: false, error: 'Jobber unreachable' });
  }
}
