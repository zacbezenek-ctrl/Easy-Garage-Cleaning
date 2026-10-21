// Fixture server for tests/browser/test_open_quotes_ui.py: the repo's static files, a page that mounts the Open quotes
// screen on its own, and the REAL GET /api/open-quotes handler (functions/api/open-quotes.js) over synthetic sent
// quotes and signed-walkthrough receipts. The clock is fixed at 2026-10-21 noon in Denver. POST /__control
// {who:'owner'|'manager'|'estimator'|'crew'} switches the signed-in viewer. POST /api/customer-portal-link stands in for
// the real endpoint (which needs Firestore): it records the job_id it was asked for and answers a synthetic link;
// GET /__portal-requests lists them. One customer name is markup, to prove it renders as text. Prints {"port":N} first.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openQuotesHandlers } from '../../functions/api/open-quotes.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VIEWERS = {
  owner: { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' },
  manager: { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' },
  estimator: { user: 'Synthetic.Estimator', role: 'sales', businessAccess: false },
  crew: { user: 'Synthetic.Crew', role: 'crew', businessAccess: false },
};
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open quotes harness</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-open-quotes.css">
<style>body{margin:0;background:#f1f0ec}main{padding:16px}</style></head>
<body><main id="host"></main><script src="/employee-ui-kit.js"></script><script src="/employee-open-quotes.js"></script>
<script>EGCOpenQuotes.mount(document.getElementById('host'),{identity:'zacb'});</script></body></html>`;

const quote = (id, sentAt, customer, cents, { by = 'Synthetic.Estimator.One', status = 'sent', validUntil = '2026-12-01', ...extra } = {}) => ({ id, type: 'job', status: 'unscheduled', customer,
  estimate: { status, amountCents: cents, validUntil, sentAt }, quoteStatus: status, quoteDraft: { version: 1, createdBy: by, sentBy: by, sentAt }, sourceWalkthroughId: `walk_${id}`, ...extra });
const JOBS = [
  quote('q_expired', '2026-09-01T16:00:00.000Z', 'Synthetic Expired Garage', 90000, { validUntil: '2026-10-01' }),
  quote('q_cold', '2026-09-30T16:00:00.000Z', 'Synthetic Cold Garage With A Very Long Family Name That Wraps', 410000, { validUntil: '2026-10-30' }),
  quote('q_cooling', '2026-10-10T16:00:00.000Z', '<img src=x onerror="window.__xss=1">Synthetic Markup', 120000),
  quote('q_warm', '2026-10-15T16:00:00.000Z', 'Synthetic Warm Garage', 180000, { by: 'Synthetic.Estimator.Two', pricesPendingApproval: { status: 'pending', reason: 'draft_prices' } }),
  quote('q_fresh', '2026-10-20T16:00:00.000Z', 'Synthetic Fresh Garage', 250000),
  { ...quote('q_approved', '2026-10-01T16:00:00.000Z', 'Synthetic Approved Garage', 100000, { status: 'accepted' }), customerApproval: { status: 'approved', approvedAt: '2026-10-05T18:00:00.000Z' } },
];
const SIGNED = [{ actorId: 'Synthetic.Estimator.Two', jobId: 'sig_one', sourceWalkthroughId: 'walk_sig', createdAt: '2026-10-18T20:00:00.000Z' }];

const state = { who: 'owner', portal: [] };
const handlers = openQuotesHandlers({
  session: async () => VIEWERS[state.who], now: () => new Date('2026-10-21T18:00:00.000Z'), pricing: async () => null,
  dispatch: () => ({ sentQuoteJobs: async since => JOBS.filter(job => job.quoteDraft.sentAt >= since), handoffLedger: async ({ value }) => SIGNED.filter(row => row.createdAt >= value) }),
});
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };

async function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = request.method === 'POST' ? await new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => resolve(text)); }) : undefined;
  if (url.pathname === '/__control') { const input = JSON.parse(body || '{}'); if (input.who) state.who = input.who; if (input.reset) state.portal = []; return json(response, 200, { ok: true }); }
  if (url.pathname === '/__portal-requests') return json(response, 200, state.portal);
  if (url.pathname === '/api/customer-portal-link' && request.method === 'POST') {
    const input = JSON.parse(body || '{}'); state.portal.push(input);
    if (!VIEWERS[state.who].businessAccess) return json(response, 403, { ok: false, error: 'Business access required' });
    return json(response, 200, { ok: true, url: `http://${request.headers.host}/api/customer-portal-session?access=synthetic-${input.job_id}`, customer: 'Synthetic', expiresInDays: 30 });
  }
  if (url.pathname === '/api/open-quotes') {
    const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
    const answer = await handlers.get({ request: new Request(`http://${request.headers.host}${url.pathname}${url.search}`, { headers }), env: {} });
    response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(await answer.text()); return;
  }
  if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(HARNESS); return; }
  const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (relative(ROOT, file).startsWith('..') || relative(ROOT, file).split(sep).includes('node_modules')) { response.writeHead(404); response.end(); return; }
  try { const data = await readFile(file); response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); response.end(data); }
  catch { response.writeHead(404); response.end(); }
}

const server = http.createServer((request, response) => { serve(request, response).catch(() => { response.writeHead(500); response.end(); }); });
server.listen(0, '127.0.0.1', () => { process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'); });
process.stdin.on('end', () => server.close(() => process.exit(0)));
process.stdin.resume();
