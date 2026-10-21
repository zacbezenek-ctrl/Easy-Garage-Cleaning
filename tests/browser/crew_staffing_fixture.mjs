// Fixture server for tests/browser/test_crew_staffing_ui.py: the repo's static files, a page that mounts the Crew staffing
// panel (as Dispatch > Crews & vehicles does) and the Command center line, and the REAL GET /api/crew-staffing and
// POST /api/dispatch handlers over one in-memory store of synthetic crews and jobs. The clock is fixed at 2026-10-21
// noon in Denver (a Wednesday). POST /__control {who:'owner'|'crew'} switches the viewer; {reset:true} restores the seed.
// GET /__jobs lists the saved jobs' crews. One customer name is markup, to prove it renders as text. Prints {"port":N}.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crewStaffingHandlers } from '../../functions/api/crew-staffing.js';
import { dispatchHandlers } from '../../functions/api/dispatch.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOW = new Date('2026-10-21T18:00:00.000Z');
const VIEWERS = { owner: { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true }, crew: { user: 'Synthetic.Crew', role: 'crew', businessAccess: false } };
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Crew staffing harness</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-crew-staffing.css">
<style>body{margin:0;background:#f1f0ec;font-family:system-ui,sans-serif}main{padding:16px;display:grid;gap:16px}</style></head>
<body><main><div id="home"></div><div id="dispatch"></div></main><script src="/employee-crew-staffing.js"></script>
<script>
window.__went=[];
async function save(body){const response=await fetch('/api/dispatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await response.json();if(!response.ok||!data.ok)throw Object.assign(new Error(data.error||'failed'),{status:response.status,code:data.code});return data;}
EGCCrewStaffing.mount(document.getElementById('home'),{go:name=>window.__went.push(name)});
document.getElementById('dispatch').append(EGCCrewStaffing.panel({save,onApplied:()=>{window.__applied=true;}}));
</script></body></html>`;

const crew = (id, name, memberIds, extra = {}) => ({ id, recordType: 'crew', name, memberIds, leadId: memberIds[0] || null, status: 'active', revision: `${id}r`, ...extra });
const job = (id, date, customer, extra = {}) => ({ id, revision: `${id}r`, type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customerId: `cust_${id}`, customer, title: 'Synthetic garage reset', address: `${id} Fixture Lane`,
  date, endDate: date, time: '10:00', endTime: '12:00', assignedCrew: [], assignedTo: '', crewNeeded: 1, jobInstructions: 'Synthetic scope', scheduleSource: 'egc_hub', ...extra });
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
function seed() {
  const rows = new Map();
  for (const row of [crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS }), crew('crew_two', 'Crew 2', ['c2a'], { priority: 2, serviceDays: WEEKDAYS, leadId: null }), crew('crew_empty', 'Crew 3', [], { priority: 3, serviceDays: ['sat', 'sun'] })]) rows.set(`dispatchResources/${row.id}`, row);
  for (const row of [job('thu_a', '2026-10-22', 'Synthetic Thursday Garage'), job('thu_b', '2026-10-22', '<img src=x onerror="window.__xss=1">Synthetic Markup'), job('sun', '2026-10-25', 'Synthetic Sunday Garage With A Long Family Name'),
    job('staffed', '2026-10-23', 'Synthetic Staffed', { assignedCrew: ['c1a', 'c1b'], assignedTo: 'c1a, c1b', crewId: 'crew_one' })]) { rows.set(`jobs/${row.id}`, row); rows.set(`customers/${row.customerId}`, { id: row.customerId, name: row.customer, phone: '9705550100', address: row.address, revision: `${row.customerId}r` }); }
  return rows;
}
const state = { who: 'owner', rows: seed(), revision: 0 };
const clone = value => structuredClone(value), all = collection => [...state.rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
const store = {
  jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'),
  roster: async () => ['zacb', 'c1a', 'c1b', 'c2a'].map(id => ({ id, name: `Synthetic ${id}`, role: id === 'zacb' ? 'owner' : 'crew' })),
  datedJobs: async (start, end) => all('jobs').filter(row => typeof row.date === 'string' && row.date >= start && row.date <= end),
  read: async (collection, id) => clone(state.rows.get(`${collection}/${id}`) || null),
  commit: async writes => {
    for (const write of writes) { const old = state.rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
    for (const write of writes) state.rows.set(`${write.collection}/${write.id}`, { ...state.rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++state.revision}` });
  },
};
const ENV = { EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' };
const staffing = crewStaffingHandlers({ session: async () => VIEWERS[state.who], storage: () => store, now: () => NOW });
const dispatch = dispatchHandlers({ session: async () => VIEWERS[state.who], storage: () => store, now: () => NOW, ghlTags: () => {}, ghlMirror: async () => false });
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };

async function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = request.method === 'POST' ? await new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => resolve(text)); }) : undefined;
  if (url.pathname === '/__control') { const input = JSON.parse(body || '{}'); if (input.who) state.who = input.who; if (input.reset) { state.rows = seed(); state.revision = 0; } return json(response, 200, { ok: true }); }
  if (url.pathname === '/__jobs') return json(response, 200, Object.fromEntries(all('jobs').filter(row => !row.recordType).map(row => [row.id, { assignedCrew: row.assignedCrew, crewId: row.crewId || null, date: row.date, time: row.time }])));
  if (url.pathname === '/api/crew-staffing' || url.pathname === '/api/dispatch') {
    const headers = new Headers(); for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
    const req = new Request(`http://${request.headers.host}${url.pathname}${url.search}`, { method: request.method, headers, body });
    const answer = url.pathname === '/api/crew-staffing' ? await staffing.get({ request: req, env: ENV }) : await (request.method === 'POST' ? dispatch.post : dispatch.get)({ request: req, env: ENV, waitUntil: () => {} });
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
