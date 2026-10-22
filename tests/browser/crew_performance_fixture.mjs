// Fixture server for tests/browser/test_crew_performance_ui.py: the repo's static files, a page that mounts the Crew
// performance screen on its own, and the REAL GET /api/crew-performance (functions/api/crew-performance.js) over synthetic
// jobs and timecards. The clock is fixed. POST /__control {who:'owner'|'crew', timecards:'ok'|'down', api:'ok'|'down'} switches the viewer,
// whether timecards can be read and whether the whole endpoint answers 503. Prints {"port":N} first.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crewPerformanceHandlers } from '../../functions/api/crew-performance.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true, owner: true, displayName: 'Synthetic Owner' };
const CREW = { user: 'crew.one', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Crew performance harness</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-crew-performance.css">
<style>body{margin:0;background:#f1f0ec}main{padding:16px}</style></head>
<body><main id="host"></main><script src="/employee-ui-kit.js"></script><script src="/employee-crew-performance.js"></script>
<script>EGCCrewPerformance.mount(document.getElementById('host'),{identity:'zacb'});</script></body></html>`;
const line = (id, kind, quantity, unitCents) => ({ id, kind, name: id, quantity, unitCents, totalCents: quantity * unitCents, optional: false, selected: true, taxable: false });
const job = (id, date, extra = {}) => ({ id, type: 'job', date, time: '08:00', arrivalWindowStart: '08:00', arrivalWindowEnd: '09:00', customer: 'Synthetic Garage', status: 'completed', completedAt: `${date}T22:00:00.000Z`, crewLead: 'Crew.One',
  estimate: { status: 'accepted', amount: 1500, lineItems: [line('removal-base', 'service', 1, 100000), line('labor', 'labor', 1, 50000)] }, jobInstructions: { laborManHours: 8 }, serviceType: 'Garage transformation', ...extra });
const JOBS = [job('job-recent', '2026-10-18'), job('job-issue', '2026-10-05', { fieldExecution: { completion: { hasIssues: true } } }), job('job-older', '2026-08-20', { crewLead: 'Crew.Two' })];
const at = (date, time) => `${date}T${time}:00-06:00`;
const card = (id, employee, jobId, date, from, to) => ({ id, employee, employeeName: employee, payType: 'hourly', hourlyRate: 31, clockInAt: at(date, from), clockOutAt: at(date, to), status: 'submitted', approvalStatus: 'approved', breaks: [],
  jobTracking: { version: 1, coverageStartedAt: at(date, from), partialHistory: false, segments: [{ id: `${id}-w`, kind: 'work', jobId, startedAt: at(date, from), endedAt: at(date, to), actorId: employee }] } });
const TIMECARDS = [card('a', 'Crew.One', 'job-recent', '2026-10-18', '08:30', '14:30'), card('b', 'Crew.Two', 'job-recent', '2026-10-18', '09:40', '14:30'),
  card('c', 'Crew.One', 'job-issue', '2026-10-05', '08:10', '12:10'), card('d', 'Crew.Two', 'job-older', '2026-08-20', '07:55', '15:55')];
const ROSTER = [{ id: 'crew.one', name: 'Synthetic Crew One' }, { id: 'crew.two', name: 'Synthetic Crew Two With A Long Family Name' }];
const state = { who: 'owner', timecards: 'ok', api: 'ok' };
const handlers = crewPerformanceHandlers({ session: async () => state.who === 'owner' ? OWNER : CREW, now: () => new Date('2026-10-21T18:00:00.000Z'),
  timecards: async () => { if (state.timecards !== 'ok') throw new Error('down'); return TIMECARDS; },
  dispatch: () => ({ datedJobs: async (start, end) => JOBS.filter(row => row.date >= start && row.date <= end), roster: async () => ROSTER }) });

async function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = request.method === 'POST' ? await new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => resolve(text)); }) : undefined;
  if (url.pathname === '/__control') { Object.assign(state, JSON.parse(body || '{}')); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return; }
  if (url.pathname === '/api/crew-performance' && state.api !== 'ok') { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"ok":false,"code":"crew_performance_unavailable","error":"Crew performance could not be loaded. Retry in a moment."}'); return; }
  if (url.pathname === '/api/crew-performance') {
    const answer = await handlers.get({ request: new Request(`http://${request.headers.host}${url.pathname}${url.search}`), env: {} });
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
