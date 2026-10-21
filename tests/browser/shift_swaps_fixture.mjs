// Fixture server for tests/browser/test_shift_swaps_ui.py: the repo's static files, a page that mounts the Swap a shift
// (My day) and Shift swaps to approve (Command center) widgets on their own, and the REAL /api/shift-swaps
// (functions/api/shift-swaps.js), whose approval runs the real dispatch save, over an in-memory store with one synthetic
// job. The clock is fixed. POST /__control {who:'crew1'|'crew3'|'manager'} switches the viewer; GET /__job shows the
// job's crew. Prints {"port":N} first.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mutateDispatch } from '../../functions/_lib/dispatch-service.js';
import { shiftSwapHandlers } from '../../functions/api/shift-swaps.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOW = '2026-09-22T12:00:00.000Z';
const ROSTER = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'tylerg', name: 'Synthetic Manager', role: 'manager' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }, { id: 'crew3', name: 'Crew Three', role: 'crew' }];
const PEOPLE = { manager: { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true }, crew1: { user: 'crew1', displayName: 'Crew One', role: 'crew' }, crew3: { user: 'crew3', displayName: 'Crew Three', role: 'crew' } };
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shift swaps harness</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-shift-swaps.css">
<style>body{margin:0;background:#f1f0ec}main{padding:16px;display:grid;gap:16px}</style></head>
<body><main><div id="home"></div><div id="review"></div></main><script src="/employee-shift-swaps.js"></script>
<script>const ctx={toast:text=>{document.body.dataset.toast=text;}};EGCShiftSwapsHome.mount(document.getElementById('home'),ctx);EGCShiftSwapsReview.mount(document.getElementById('review'),ctx);</script></body></html>`;

const rows = new Map([['customers/c1', { id: 'c1', name: 'Synthetic Customer', revision: 'c1r' }]]);
let revision = 0;
const clone = value => structuredClone(value), all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
const store = {
  crewNotificationsEnabled: true, segmentsEnabled: false,
  jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(ROSTER), recurringPlans: async () => all('recurringPlans'),
  datedJobs: async (start, end) => all('jobs').filter(row => row.date >= start && row.date <= end),
  shiftSwaps: async spec => all('shiftSwaps').filter(row => spec.op === 'IN' ? spec.value.includes(row[spec.field]) : row[spec.field] === spec.value),
  read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
  readMany: async (collection, ids) => ids.map(id => rows.get(`${collection}/${id}`)).filter(Boolean).map(clone),
  commit: async writes => {
    for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
    for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
  },
};
const created = await mutateDispatch(store, { user: 'ZacB', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' }, { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job',
  changes: { date: '2026-09-23', time: '08:00', endTime: '12:00', assignedCrew: ['crew1', 'crew2'], crewLead: 'crew1', jobInstructions: 'Synthetic scope', serviceType: 'Garage cleanout' } }, NOW);
const jobId = created.job.id;
const state = { who: 'crew1' };
const handlers = shiftSwapHandlers({ session: async () => PEOPLE[state.who], dispatch: () => store, travel: () => ({}), now: () => new Date(NOW) });

async function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = request.method === 'POST' ? await new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => resolve(text)); }) : undefined;
  if (url.pathname === '/__control') { Object.assign(state, JSON.parse(body || '{}')); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return; }
  if (url.pathname === '/__job') { const job = rows.get(`jobs/${jobId}`); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ assignedCrew: job.assignedCrew, crewLead: job.crewLead })); return; }
  if (url.pathname === '/api/shift-swaps') {
    const init = { method: request.method, headers: { 'Content-Type': request.headers['content-type'] || '', Origin: request.headers.origin || '' }, ...(body !== undefined ? { body } : {}) };
    const answer = await (request.method === 'POST' ? handlers.post : handlers.get)({ request: new Request(`http://${request.headers.host}${url.pathname}`, init), env: {} });
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
