// Fixture server for tests/browser/test_quote_builder_labor_ui.py: the repo's static files, a page that opens the
// walkthrough's guided quote builder (crew/quote-draft.js) for a synthetic walkthrough, and the REAL /api/quote-draft and
// /api/walkthrough-handoff handlers with EGC_QUOTE_BUILDER_ENABLED over the estimator fixture's in-memory store
// (tests/helpers/estimator-fixture.mjs) and the builder's pricing state (the shipped pricing menu without the owner's
// approvals in code of 2026-10-30, so draft prices still show, and the shipped settings; no owner Hub approvals: the $53.00 default labor rate, the owner's decision of 2026-10-19). The signed-in viewer is the synthetic estimator. GET /__state returns the
// saved quote jobs. Prints {"port":N} first. Nothing reaches the network. LANE catalog review: the real walkthrough
// (crew/gameplan.html) runs against it too, with the real /api/pricing-config and /api/customer-resolve, the estimator's
// /api/hub-auth profile and a Firebase session stub; any other /api/ path answers 503.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteDraftHandlers } from '../../functions/api/quote-draft.js';
import { handoffHandlers } from '../../functions/api/walkthrough-handoff.js';
import { pricingConfigHandlers } from '../../functions/api/pricing-config.js';
import { customerResolveHandler } from '../../functions/api/customer-resolve.js';
import { ON_ENV, builderState, client, estimator, fixture } from '../helpers/estimator-fixture.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
// The walkthrough payload as crew/gameplan.html payload() builds it: one truck load and a mattress in a medium-full
// garage, junk only (no Labor line, D-JUNK); with a shelving unit the server estimates 2 x 60 + 60 = 180 person-minutes
// (3 man-hours) whatever the crew: the truck load and the mattress add none and, with no cleaning base, neither does the
// fullness. /builder-harness?plan=junk is a junk-removal-only walkthrough (Everything goes, no finish options), on which a
// junk-only quote is sent; ?plan=zones records crew sorting on two truck loads, on which it never is (D-JUNK). The page
// hands the builder the walkthrough's Finish picks from window.GOODS (crew/gameplan-catalog.js selection()) and keeps
// what the builder writes back in window.MIRRORED.
const PLAN = { client: client(1), quote: { title: 'EGC Garage Service', estimated_duration_min: 240, line_items: [] },
  scope: { garages: '2', loads: '1', fullness: 'medium', sort_method: '', special_items: ['Mattress'], access: [], finish: ['cleanout', 'shelving'], hazards: [], finish_details: { shelf_type: 'metal', shelf_qty: 2, tote_qty: 0 } }, raw: {}, logistics: { crew_size: 2 } };
const PLANS = { default: PLAN, junk: { ...PLAN, scope: { ...PLAN.scope, sort_method: 'remove_all', finish: ['cleanout'], finish_details: { ...PLAN.scope.finish_details, shelf_qty: 0 } } },
  zones: { ...PLAN, scope: { ...PLAN.scope, loads: '2', sort_method: 'zones', special_items: [], finish: ['cleanout'], finish_details: { ...PLAN.scope.finish_details, shelf_qty: 0 } } } };
const HARNESS = PLAN => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quote builder harness</title>
<link rel="stylesheet" href="/crew/crew-brand.css"><link rel="stylesheet" href="/crew/quote-draft.css"><style>body{margin:0;background:#f1f0ec;font-family:system-ui,sans-serif}main{padding:16px}</style></head>
<body><main><button id="open" type="button" style="min-height:48px">Send options for review</button></main>
<script>window.EGCWalkthroughPricing={quoteBuilder:()=>true};</script><script src="/crew/quote-draft.js"></script>
<script>const PLAN=${JSON.stringify(PLAN)};document.getElementById('open').addEventListener('click',()=>EGCQuoteDraft.open({storage:sessionStorage,fetch:(...a)=>fetch(...a),actor:async()=>'sales.person',uuid:()=>crypto.randomUUID(),
plan:()=>structuredClone(PLAN),source:()=>'w1',savedJobId:()=>window.savedJobId||'',draftId:()=>'draft-1',accept:r=>{window.savedJobId=r.job.id},
goods:()=>window.GOODS||null,onGoods:g=>{window.MIRRORED=g}}));</script></body></html>`;

const f = fixture(ON_ENV), state = builderState();
const session = async () => estimator, now = () => new Date('2026-10-17T15:00:00.000Z');
const quotes = quoteDraftHandlers({ session, storage: () => f.store, now, compositeState: async () => state, stripe: () => null, delivery: () => ({ deliver: async () => ({ status: 'not_requested' }) }) });
const handoff = handoffHandlers({ session, storage: () => f.store, now, compositeState: async () => state });
const pricing = pricingConfigHandlers({ session }), resolve = customerResolveHandler({ session, storage: () => f.store, verifyContact: async id => ({ ok: true, id }) });
const PROFILE = { ok: true, user: estimator.user, displayName: estimator.displayName, role: estimator.role, businessAccess: false, owner: false, capabilities: ['quotes.author'] };

async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); }
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/__state') {
      const jobs = [...f.rows.entries()].filter(([key, row]) => key.startsWith('jobs/') && row.quoteDraft).map(([, row]) => ({ id: row.id, estimate: row.estimate, quoteDraft: { compositePricing: row.quoteDraft.compositePricing, breakdown: row.quoteDraft.breakdown } }));
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jobs })); return;
    }
    if (url.pathname === '/api/hub-auth' || url.pathname === '/api/firebase-session') { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(url.pathname === '/api/hub-auth' ? PROFILE : { ok: true, token: 'synthetic' })); return; }
    const handler = url.pathname === '/api/quote-draft' ? quotes : url.pathname === '/api/walkthrough-handoff' ? handoff : url.pathname === '/api/pricing-config' ? pricing : url.pathname === '/api/customer-resolve' ? { get: resolve, post: resolve } : null;
    if (handler) {
      const raw = request.method === 'POST' ? await body(request) : null;
      const headers = new Headers(); for (const name of ['content-type', 'content-length', 'origin', 'referer', 'sec-fetch-site']) if (request.headers[name]) headers.set(name, request.headers[name]);
      const req = new Request(url.href, { method: request.method, headers, body: raw ?? undefined });
      const answer = request.method === 'POST' ? await handler.post({ request: req, env: ON_ENV }) : await handler.get({ request: req, env: ON_ENV });
      response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(Buffer.from(await answer.arrayBuffer())); return;
    }
    if (url.pathname.startsWith('/api/')) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: 'Synthetic service unavailable' })); return; }
    if (url.pathname === '/builder-harness') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(HARNESS(PLANS[url.searchParams.get('plan') || 'default'])); return; }
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (request.method !== 'GET' || !file.startsWith(ROOT) || relative(ROOT, file).split(sep).some(part => part.startsWith('.')) || !TYPES[extname(file)]) { response.writeHead(404); response.end(); return; }
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)], 'Cache-Control': 'no-store' }); response.end(data);
  } catch (failure) {
    if (!response.headersSent) response.writeHead(failure?.code === 'ENOENT' ? 404 : 500);
    response.end(String(failure?.message || ''));
  }
});
server.listen(0, '127.0.0.1', () => { process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'); });
process.stdin.on('end', () => server.close(() => process.exit(0)));
process.stdin.resume();
