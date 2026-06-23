/**
 * EGC Jobber "today's walkthrough requests" — Cloudflare Pages Function
 * GET /api/jobber-requests                  → today's requests (America/Denver)
 * GET /api/jobber-requests?date=YYYY-MM-DD   → that day's requests
 *
 * Walkthroughs are booked in Jobber as Requests. The crew opens the Game Plan
 * on-site and taps their customer from the day's list; the details below then
 * pre-fill and stay fully editable. Read-only (read_requests / read_clients).
 *
 * Env vars: JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REFRESH_TOKEN
 * (minted once via /api/jobber-auth — see that file for the setup steps).
 *
 * Response: { ok:true, date, today:[item], recent:[item] }
 *   item = { id, clientId, name, phone, email, address, title, createdAt, day }
 */

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

// Access tokens last ~60 min; cache per isolate so repeat opens don't re-mint.
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

// YYYY-MM-DD for a Date in EGC's local zone (Fort Collins). en-CA => ISO-style.
const TZ = 'America/Denver';
function localDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Same proven client fields as /api/jobber-clients, just reached via requests → client.
const NODE_FIELDS = `
      id
      title
      createdAt
      client {
        id
        name
        firstName
        lastName
        phones { number primary }
        emails { address primary }
        billingAddress { street city province postalCode }
      }`;
// Try newest-first; if Jobber rejects the sort arg we transparently retry without it.
const SORTED_QUERY = `query EgcRequests($first: Int!) {
  requests(first: $first, sort: { key: CREATED_AT, direction: DESCENDING }) { nodes { ${NODE_FIELDS} } }
}`;
const PLAIN_QUERY = `query EgcRequests($first: Int!) {
  requests(first: $first) { nodes { ${NODE_FIELDS} } }
}`;

async function runQuery(token, query) {
  const resp = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-JOBBER-GRAPHQL-VERSION': GQL_VERSION,
    },
    body: JSON.stringify({ query, variables: { first: 100 } }),
  });
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
}

export async function onRequestGet({ request, env }) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });

  if (!originAllowed(request)) return json(403, { ok: false, error: 'Forbidden origin' });
  if (!env.JOBBER_CLIENT_ID || !env.JOBBER_CLIENT_SECRET || !env.JOBBER_REFRESH_TOKEN) {
    return json(501, { ok: false, error: 'Jobber lookup not configured — run /api/jobber-auth setup' });
  }

  const dParam = String(new URL(request.url).searchParams.get('date') || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dParam) ? dParam : localDay(new Date());

  try {
    const token = await accessToken(env);
    let { resp, data } = await runQuery(token, SORTED_QUERY);
    if (data.errors) ({ resp, data } = await runQuery(token, PLAIN_QUERY)); // sort arg unsupported → retry plain
    if (!resp.ok || data.errors) {
      const detail = JSON.stringify(data.errors || data).slice(0, 300);
      return json(502, { ok: false, error: 'Jobber query failed', detail });
    }
    const nodes = (data.data && data.data.requests && data.data.requests.nodes) || [];
    const items = nodes.map(n => {
      const c = n.client || {};
      const phone = (c.phones || []).find(p => p.primary) || (c.phones || [])[0] || {};
      const email = (c.emails || []).find(e => e.primary) || (c.emails || [])[0] || {};
      const a = c.billingAddress || {};
      return {
        id: n.id || '',
        clientId: c.id || '',
        name: c.name || [c.firstName, c.lastName].filter(Boolean).join(' '),
        phone: phone.number || '',
        email: email.address || '',
        address: [a.street, a.city].filter(Boolean).join(', '),
        title: n.title || '',
        createdAt: n.createdAt || '',
        day: n.createdAt ? localDay(new Date(n.createdAt)) : '',
      };
    }).filter(it => it.name || it.address || it.phone);
    // Newest first regardless of what order the API returned.
    items.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    const today = items.filter(it => it.day === date);
    const recent = items.slice(0, 25);
    return json(200, { ok: true, date, today, recent });
  } catch (e) {
    return json(502, { ok: false, error: 'Jobber unreachable' });
  }
}
