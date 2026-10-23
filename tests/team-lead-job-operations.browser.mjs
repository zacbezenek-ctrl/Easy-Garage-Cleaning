// Real Chromium + HTTP handlers; all job/customer/storage data is synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { fieldChecklist } from '../functions/_lib/field-execution.js';
import { jobOperationsHandlers } from '../functions/api/job-operations.js';
import * as field from '../functions/api/field-jobs.js';
import { memoryStore } from './helpers/auth-roles-harness.mjs';
import { storage } from './helpers/field-fixture.mjs';

if (!process.env.FIELD_PLAYWRIGHT_MODULE) throw new Error('Set FIELD_PLAYWRIGHT_MODULE.');
const { chromium } = await import(pathToFileURL(process.env.FIELD_PLAYWRIGHT_MODULE).href);
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { EGC_TEAM_LEAD_JOB_OPERATIONS: 'true', EGC_STAFF_ROLE_ACCESS: 'false', EGC_STAFF_ROLE_PERMISSIONS: 'false', HUB_SESSION_SECRET: 'synthetic-browser-job-operations-secret', FIREBASE_API_KEY: 'firebase-test-job-operations-browser', HUB_AUTH_USERS_JSON: JSON.stringify({
  'Team.Lead': { role: 'crew', staffRoles: ['team_lead'], displayName: 'Synthetic Team Lead', passwordHash: 'unused' },
  'Crew.One': { role: 'crew', displayName: 'Synthetic Crew', passwordHash: 'unused' },
}) };
const jobs = memoryStore(), commands = [], originalFetch = globalThis.fetch;
const fieldStore = storage({ mock: { method(object, key, implementation) { object[key] = implementation; } } });
const complete = { id: 'job-complete', revision: 'completion-r1', type: 'job', status: 'in_progress', pipelineStatus: 'in_progress', customer: 'Synthetic Completion', customerId: 'c1', date: '2026-09-24', endDate: '2026-09-24', time: '08:00', endTime: '10:00', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', total: 98765 };
complete.fieldExecution = { checks: Object.fromEntries(fieldChecklist(complete).map(item => [item.id, { completed: true }])), photos: ['before', 'after'].map(category => ({ id: crypto.randomUUID(), fileId: category, category, verified: true })) };
jobs.rows.set('jobs/job-complete', complete); fieldStore.put('jobs/job-complete', complete);
const operations = jobOperationsHandlers({ storage: () => jobs, now: () => new Date('2026-09-22T18:00:00Z') });
let base, loseSave = true;
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, base), parts = [];
    for await (const part of incoming) parts.push(part);
    const body = Buffer.concat(parts);
    if (url.pathname.startsWith('/api/')) {
      const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(body.length ? { body } : {}) });
      const isWrite = incoming.method === 'POST';
      if (isWrite) commands.push({ path: url.pathname, body: body.toString() });
      const response = url.pathname === '/api/job-operations'
        ? await operations[isWrite ? 'post' : 'get']({ request, env })
        : await field[isWrite ? 'onRequestPost' : 'onRequestGet']({ request, env });
      if (url.pathname === '/api/field-jobs' && isWrite && response.ok) jobs.rows.set('jobs/job-complete', { ...complete, ...fieldStore.get('jobs/job-complete'), revision: 'completion-r2' });
      if (loseSave && isWrite && response.ok && url.pathname === '/api/job-operations') {
        // Send headers and an incomplete body so Chromium cannot transparently
        // retry the transport before the page exercises its explicit retry UI.
        loseSave = false; outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '4096' });
        outgoing.write('{"ok":'); setTimeout(() => incoming.socket.destroy(), 50); return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const pathname = url.pathname === '/crew/job-operations' ? '/crew/job-operations.html' : url.pathname;
    const filename = resolve(root, `.${pathname}`);
    if (!filename.startsWith(resolve(root, 'crew') + '/') && !filename.startsWith(resolve(root, 'crew') + '\\')) { outgoing.writeHead(404); outgoing.end(); return; }
    const data = await readFile(filename);
    outgoing.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[extname(filename)] || 'application/octet-stream' }); outgoing.end(data);
  } catch (error) { outgoing.writeHead(500); outgoing.end(error.message); }
});
await new Promise(resolve => server.listen(0, 'localhost', resolve)); base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const [name, value] = (await createHubSessionCookie(env, 'Team.Lead')).split(';')[0].split('=');
await context.addCookies([{ name, value, url: base }]);
const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`${base}/crew/job-operations`);
  await page.getByRole('button', { name: 'Create job', exact: true }).click();
  await page.getByLabel('Find customer by name or phone', { exact: true }).fill('Synthetic');
  await page.getByRole('button', { name: 'Find customer', exact: true }).click();
  await page.getByLabel('Customer', { exact: true }).selectOption('c1');
  await page.getByLabel('Prior job at this property (when applicable)', { exact: true }).selectOption('job-crewed');
  await page.getByLabel('Job title', { exact: true }).fill('Browser acceptance job');
  await page.getByLabel('Work instructions', { exact: true }).fill('Preserve shelving and clear the floor.');
  await page.getByLabel('Start date', { exact: true }).fill('2026-09-26');
  await page.getByLabel('End date', { exact: true }).fill('2026-09-26');
  await page.getByLabel('Start time', { exact: true }).fill('09:00');
  await page.getByLabel('End time', { exact: true }).fill('11:00');
  await page.getByLabel('Assigned people (select everyone working this job)', { exact: true }).selectOption(['crew.one']);
  await page.getByLabel('Crew lead', { exact: true }).selectOption('crew.one');
  await page.getByRole('button', { name: 'Save job', exact: true }).click();
  await page.getByRole('button', { name: 'Check / retry save', exact: true }).click();
  await page.getByRole('button', { name: 'Create job', exact: true }).waitFor();
  assert.equal(commands[0].body, commands[1].body, 'lost-response retry keeps the exact command');
  const created = [...jobs.rows.values()].filter(row => row.title === 'Browser acceptance job');
  assert.equal(created.length, 1);
  await page.getByRole('button', { name: /Synthetic Customer.*2026-09-26/ }).click();
  await page.getByLabel('Assigned people (select everyone working this job)', { exact: true }).selectOption(['zacb']);
  await page.getByLabel('Crew lead', { exact: true }).selectOption('zacb');
  await page.getByLabel('Start date', { exact: true }).fill('2026-09-27');
  await page.getByLabel('End date', { exact: true }).fill('2026-09-27');
  await page.getByRole('button', { name: 'Save job', exact: true }).click();
  await page.getByRole('button', { name: /Synthetic Customer.*2026-09-27/ }).click();
  assert.deepEqual(jobs.rows.get(`jobs/${created[0].id}`).assignedCrew, ['zacb']);
  await page.getByLabel('Cancellation reason', { exact: true }).fill('Synthetic cancellation request');
  await page.getByRole('button', { name: 'Cancel job', exact: true }).click();
  await page.getByRole('button', { name: 'Create job', exact: true }).waitFor();
  assert.equal(jobs.rows.get(`jobs/${created[0].id}`).status, 'cancelled');
  await page.getByRole('button', { name: /Synthetic Completion/ }).click();
  await page.getByRole('button', { name: 'Complete job', exact: true }).click();
  await page.getByLabel('Work completed', { exact: true }).fill('Synthetic cleanout complete with all required evidence.');
  await page.getByRole('button', { name: 'Complete job', exact: true }).click();
  await page.getByRole('button', { name: 'Create job', exact: true }).waitFor();
  assert.equal(fieldStore.get('jobs/job-complete').status, 'completed');
  assert.equal(fieldStore.get('jobs/job-complete').total, 98765, 'completion changes no price');
  assert.equal(fieldStore.get('jobs/job-complete').supervisorSignoff, undefined);
  assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true);
  assert.equal((await context.request.get(`${base}/api/job-operations?view=job&jobId=job-complete`)).status(), 200);
  assert.equal((await context.request.post(`${base}/api/job-operations`, { data: { action: 'schedule.restore', requestId: crypto.randomUUID(), expectedUser: 'Team.Lead', jobId: created[0].id, changes: {} } })).status(), 403);
  env.EGC_TEAM_LEAD_JOB_OPERATIONS = 'false';
  assert.equal((await context.request.get(`${base}/api/job-operations`)).status(), 403);
  const output = resolve(root, 'test-results/job-operations'); await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'team-lead-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Team Lead real-browser create, retry, assign, schedule, cancel, complete and flag/permission checks passed.');
} catch (error) {
  console.error(await page.locator('body').innerText());
  throw error;
} finally {
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
}
