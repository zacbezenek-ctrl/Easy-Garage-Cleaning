// Fixture server for tests/browser/test_job_signoff_ui.py: the repo's static files, a page that mounts the Needs
// sign-off widget on its own, and the REAL /api/job-signoff (functions/api/job-signoff.js) over the Firestore REST fake
// with synthetic completed jobs. The clock is fixed. POST /__control {who:'manager'|'crew'} switches the viewer (crew.one leads every job); /lead mounts the crew lead's
// My day follow-ups card.
// Prints {"port":N} first.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firestoreRest } from '../helpers/firestore-rest-queries.mjs';
import { dispatchStorage } from '../../functions/_lib/dispatch-storage.js';
import { jobSignoffHandlers } from '../../functions/api/job-signoff.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANAGER = { user: 'TylerG', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const CREW = { user: 'crew.one', role: 'crew', businessAccess: false, displayName: 'Synthetic Crew' };
// The crew lead's My day card (EGCSupervisorFollowUps) on its own page.
const LEAD_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lead follow-ups harness</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-job-signoff.css"></head>
<body><main id="host" style="padding:16px"></main><script src="/employee-job-signoff.js"></script>
<script>EGCSupervisorFollowUps.mount(document.getElementById('host'),{});</script></body></html>`;
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-off harness</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-job-signoff.css">
<style>body{margin:0;background:#f1f0ec}main{padding:16px}</style></head>
<body><main id="host"></main><script src="/employee-job-signoff.js"></script>
<script>EGCJobSignoff.mount(document.getElementById('host'),{toast:text=>{document.body.dataset.toast=text;}});</script></body></html>`;
const done = at => ({ completedAt: at, fieldExecution: { activity: 'completed', completion: { completedAt: at, actorId: 'crew.one', hasIssues: false } } });
const job = (id, extra) => ({ id, type: 'job', status: 'completed', pipelineStatus: 'completed', date: '2026-10-19', time: '09:00', customer: 'Synthetic Johnson Family', serviceType: 'Garage cleanout',
  assignedCrew: ['crew.one'], crewLead: 'crew.one', estimate: { amount: 1500 }, ...done('2026-10-20T20:00:00.000Z'), ...extra });
const fs = firestoreRest({
  'jobs/old': job('old', { customer: 'Synthetic Older Garage', ...done('2026-10-19T12:00:00.000Z') }),
  'jobs/fresh': job('fresh', { customer: 'Synthetic Fresh Garage' }),
  'jobs/mine': job('mine', { customer: 'Synthetic Mine Garage', assignedCrew: ['crew.one', 'tylerg'], ...done('2026-10-21T08:00:00.000Z') }),
});
const state = { who: 'manager' };
const handlers = jobSignoffHandlers({ session: async () => state.who === 'manager' ? MANAGER : CREW, dispatch: env => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => [{ id: 'crew.one', name: 'Synthetic Crew One' }] }), now: () => new Date('2026-10-21T18:00:00.000Z') });

async function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = request.method === 'POST' ? await new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => resolve(text)); }) : undefined;
  if (url.pathname === '/__control') { Object.assign(state, JSON.parse(body || '{}')); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return; }
  if (url.pathname === '/api/job-signoff') {
    const init = { method: request.method, headers: { 'Content-Type': request.headers['content-type'] || '', Origin: request.headers.origin || '' }, ...(body !== undefined ? { body } : {}) };
    const answer = await (request.method === 'POST' ? handlers.post : handlers.get)({ request: new Request(`http://${request.headers.host}${url.pathname}${url.search}`, init), env: {} });
    response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(await answer.text()); return;
  }
  if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(HARNESS); return; }
  if (url.pathname === '/lead') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(LEAD_PAGE); return; }
  const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (relative(ROOT, file).startsWith('..') || relative(ROOT, file).split(sep).includes('node_modules')) { response.writeHead(404); response.end(); return; }
  try { const data = await readFile(file); response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); response.end(data); }
  catch { response.writeHead(404); response.end(); }
}
const server = http.createServer((request, response) => { serve(request, response).catch(() => { response.writeHead(500); response.end(); }); });
server.listen(0, '127.0.0.1', () => { process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'); });
process.stdin.on('end', () => server.close(() => process.exit(0)));
process.stdin.resume();
