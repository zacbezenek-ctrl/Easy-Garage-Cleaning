// Fixture server for tests/browser/test_job_actuals_ui.py: the repo's static files, a page that mounts the Job actuals
// screen on its own, and the REAL /api/job-actuals handler (functions/api/job-actuals.js) over synthetic completed jobs,
// timecards and an in-memory settings store. The clock is fixed; POST /__control {who:'owner'|'manager'} switches the
// signed-in viewer; {reset:true} saves only synthetic pay settings ($10.00 per man-hour, 1% workers' comp, never a real
// wage), and {reset:true, blank:true} clears every setting. The REAL /api/owner-economics runs over the same store, so
// the Owner targets card shows the Cost settings crew wage. Prints {"port":N} first.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobActualsHandlers } from '../../functions/api/job-actuals.js';
import { ownerEconomicsHandlers } from '../../functions/api/owner-economics.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true, owner: true, displayName: 'Synthetic Owner' };
const MANAGER = { user: 'tylerg', role: 'manager', businessAccess: true, owner: false, displayName: 'Synthetic Manager' };
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Job actuals harness</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-job-actuals.css">
<style>body{margin:0;background:#f1f0ec}main{padding:16px}</style></head>
<body><main id="host"></main><script src="/employee-ui-kit.js"></script><script src="/employee-job-actuals.js"></script>
<script>sessionStorage.setItem('egc_u','zacb');EGCJobActuals.mount(document.getElementById('host'),{identity:'zacb'});</script></body></html>`;

const line = (id, kind, quantity, unitCents, extra = {}) => ({ id, kind, name: id, quantity, unitCents, totalCents: quantity * unitCents, optional: false, selected: true, taxable: false, ...extra });
const goods = (retail, sell) => line('shelving-goods', 'product', 1, sell, { split: { productCents: retail, markupCents: sell - retail, laborCents: 0, laborMinutes: 0, disposalCents: 0 } });
const job = (id, date, customer, amount, lineItems, extra = {}) => ({ id, type: 'job', date, customer, status: 'completed', completedAt: `${date}T22:00:00.000Z`, estimate: { status: 'accepted', amount, lineItems }, serviceType: 'Garage transformation', ...extra });
const JOBS = [
  // Billed 8 man-hours, worked 18 on timecards (the owner's benchmark), two full loads and a partial, shelving.
  job('job-two-car', '2026-10-18', 'Synthetic Two-Car Garage With A Long Family Name', 4214, [line('removal-base', 'service', 1, 150000), line('removal-junk-full', 'service', 2, 75000), line('removal-junk-partial', 'service', 1, 40000), goods(30000, 39000), line('labor', 'labor', 1, 42400)], { jobInstructions: { laborManHours: 8 }, sourceWalkthroughId: 'walk-setter' }),
  // No timecards: the crew lead confirmed 2 people × 3.5 hours and 1 load at Complete.
  job('job-one-car', '2026-10-02', 'Synthetic One-Car Reset', 1384, [line('removal-base', 'service', 1, 100000), line('labor', 'labor', 1, 38400)], { jobInstructions: { laborManHours: 7.25 }, sourceWalkthroughId: 'walk-direct', fieldExecution: { completion: { crewOnSite: { people: 2, hours: 3.5 }, truckLoads: 1 } } }),
  // Junk-only, $750 per truck, no Labor line; a door sale would not matter, junk earns 0.
  job('job-junk', '2026-09-05', 'Synthetic Junk Haul', 1500, [line('removal-junk-full', 'service', 2, 75000)], { serviceType: 'Junk removal', sourceWalkthroughId: 'walk-junk' }),
  // A job that lost money: billed 4, worked 30.
  job('job-overrun', '2026-08-01', 'Synthetic Overrun', 250, [line('removal-base', 'service', 1, 3800), line('labor', 'labor', 1, 21200)], { jobInstructions: { laborManHours: 4 } }),
];
const at = (date, time) => `${date}T${time}:00-06:00`;
const card = (id, jobId, date, from, to) => ({ id, employee: 'Crew.One', employeeName: 'Crew One', payType: 'hourly', hourlyRate: 31, clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [],
  jobTracking: { version: 1, coverageStartedAt: at(date, from), partialHistory: false, segments: [{ id: `${id}-w`, kind: 'work', jobId, startedAt: at(date, from), endedAt: at(date, to), actorId: 'Crew.One' }] } });
const TIMECARDS = [card('c1', 'job-two-car', '2026-10-18', '06:00', '15:00'), { ...card('c2', 'job-two-car', '2026-10-18', '06:00', '15:00'), employee: 'Crew.Two', employeeName: 'Crew Two' },
  // A third crew member on the two-car job never clocked out: an open shift, so its timecards are incomplete.
  { ...card('c5', 'job-two-car', '2026-10-18', '06:00', '15:00'), employee: 'Crew.Three', employeeName: 'Crew Three', clockOutAt: null, status: 'open', approvalStatus: 'pending' },
  card('c3', 'job-overrun', '2026-08-01', '05:00', '20:00'), { ...card('c4', 'job-overrun', '2026-08-01', '05:00', '20:00'), employee: 'Crew.Two', employeeName: 'Crew Two' }];

const state = { who: 'owner', docs: new Map(), tick: 0 };
const store = { async read(collection, id) { const row = state.docs.get(`${collection}/${id}`); return row ? structuredClone(row) : null; },
  async commit(writes) {
    for (const write of writes) { const current = state.docs.get(`${write.collection}/${write.id}`); if (write.revision ? current?.revision !== write.revision : current) throw Object.assign(new Error('stale'), { code: write.collection === 'ownerEconomicsSettings' ? 'owner_economics_revision_conflict' : 'job_actuals_revision_conflict', status: 409 }); }
    for (const write of writes) state.docs.set(`${write.collection}/${write.id}`, { ...(state.docs.get(`${write.collection}/${write.id}`) || {}), ...structuredClone(write.patch), revision: `rev-${++state.tick}` });
  } };
const handlers = jobActualsHandlers({
  session: async () => state.who === 'owner' ? OWNER : MANAGER, now: () => new Date('2026-10-21T18:00:00.000Z'), timecards: async () => TIMECARDS, settingsStore: () => store,
  dispatch: () => ({ datedJobs: async (start, end) => JOBS.filter(row => row.date >= start && row.date <= end) }),
  knock: () => ({ getMany: async (_collection, ids) => new Map(ids.filter(id => id === 'walk-setter').map(id => [id, { walkthroughId: id }])), query: async () => [] }),
});

const ownerHandlers = ownerEconomicsHandlers({ session: async () => state.who === 'owner' ? OWNER : MANAGER, store: () => store, jobActuals: () => store, now: () => new Date('2026-10-21T18:00:00.000Z') });

async function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = request.method === 'POST' ? await new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => resolve(text)); }) : undefined;
  if (url.pathname === '/__control') {
    const input = JSON.parse(body || '{}');
    if (input.who) state.who = input.who;
    // "Another session" saves settings: the stored record changes under a new revision.
    if (input.otherSave) { const key = 'jobActualsSettings/current'; state.docs.set(key, { ...(state.docs.get(key) || { schemaVersion: 1 }), ...input.otherSave, revision: `rev-${++state.tick}` }); }
    if (input.otherOwnerSave) { const key = 'ownerEconomicsSettings/current'; state.docs.set(key, { ...(state.docs.get(key) || { schemaVersion: 1 }), ...input.otherOwnerSave, revision: `rev-${++state.tick}` }); }
    if (input.reset) { state.docs.clear(); if (!input.blank) state.docs.set('jobActualsSettings/current', { schemaVersion: 1, wageCentsPerManHour: 1000, workersCompBp: 100, revision: 'rev-pay' }); }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return;
  }
  if (url.pathname === '/api/job-actuals' || url.pathname === '/api/owner-economics') {
    const route = url.pathname === '/api/job-actuals' ? handlers : ownerHandlers;
    const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
    const req = new Request(`http://${request.headers.host}${url.pathname}${url.search}`, { method: request.method, headers, body });
    const answer = await (request.method === 'POST' ? route.post : route.get)({ request: req, env: {} });
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
