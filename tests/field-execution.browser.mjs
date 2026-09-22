// Run with FIELD_PLAYWRIGHT_MODULE pointing to an installed Playwright module.
// Uses real HTTP handlers and browser UI, with synthetic Firestore/Drive only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname } from 'node:path';
import { hashHubCredential } from '../functions/_lib/hub-session.js';
import { storage } from './helpers/field-fixture.mjs';
import * as field from '../functions/api/field-jobs.js';
import * as auth from '../functions/api/hub-auth.js';

const modulePath = process.env.FIELD_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set FIELD_PLAYWRIGHT_MODULE to the Playwright index.mjs path.');
const { chromium } = await import(pathToFileURL(modulePath).href);
const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'Synthetic browser test only!';
const users = Object.fromEntries(await Promise.all(['ZacB', 'Crew.One', 'Crew-One'].map(async user => [user, { passwordHash: await hashHubCredential(user, password), role: user === 'ZacB' ? 'owner' : 'crew', displayName: user === 'Crew.One' ? 'Crew One' : user }])));
const env = { HUB_SESSION_SECRET: 'field-browser-synthetic', FIREBASE_API_KEY: 'firebase-test-field-browser', HUB_AUTH_USERS_JSON: JSON.stringify(users), GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test' };
const originalFetch = globalThis.fetch;
const store = storage({ mock: { method(object, key, implementation) { object[key] = implementation; } } });
const date = field.fieldToday();
const job = { id: 'browser-job', type: 'job', date, time: '08:00', endTime: '11:00', customer: 'Synthetic Garage', phone: '9705550100', address: '123 Test Street, Fort Collins, CO', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', status: 'scheduled', pipelineStatus: 'scheduled', jobInstructions: { operationalScope: 'Clean the garage, preserve the green cabinet and install the rack.', accessNotes: 'Customer will open the side gate.' }, requiredEquipment: ['Gloves', 'Pressure washer'], materials: [{ id: 'rack', name: 'Wall rack', quantity: 1 }] };
store.put('jobs/browser-job', job);
store.put('jobs/browser-next', { ...job, id: 'browser-next', customer: 'Synthetic Next Job', time: '13:00', endTime: '16:00' });
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, 'http://localhost:8793');
    if (url.pathname.startsWith('/api/')) {
      const parts = []; for await (const part of incoming) parts.push(part);
      const bytes = Buffer.concat(parts), request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(bytes.length ? { body: bytes } : {}) });
      const route = url.pathname === '/api/field-jobs' ? field : auth;
      const response = await route[incoming.method === 'POST' ? 'onRequestPost' : 'onRequestGet']({ request, env });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const filename = resolve(root, `.${url.pathname}`);
    if (!filename.startsWith(resolve(root, 'crew') + '\\') && !filename.startsWith(resolve(root, 'crew') + '/')) { outgoing.writeHead(404); outgoing.end(); return; }
    const data = await readFile(filename); outgoing.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[extname(filename)] || 'application/octet-stream' }); outgoing.end(data);
  } catch (error) { outgoing.writeHead(500); outgoing.end(String(error.message)); }
});
await new Promise(resolve => server.listen(8793, 'localhost', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.FIELD_BROWSER_CHANNEL ? { channel: process.env.FIELD_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles' });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const artifactDir = process.env.FIELD_QA_OUTPUT || resolve(root, '../field-qa'); await mkdir(artifactDir, { recursive: true });
const settled = async () => { await page.waitForFunction(() => !document.querySelector('.pending-action')); await page.waitForTimeout(75); };
try {
  await page.goto('http://localhost:8793/crew/job.html');
  await page.getByLabel('Username', { exact: true }).fill('Crew.One'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic Garage', exact: true }).waitFor();
  assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'mobile Today must not overflow');
  await page.screenshot({ path: resolve(artifactDir, 'today-mobile.png'), fullPage: true });
  await page.getByRole('heading', { name: 'Synthetic Garage', exact: true }).click();
  await page.getByRole('button', { name: 'Mark en route', exact: true }).click(); await settled();
  await page.getByRole('button', { name: 'Mark arrived', exact: true }).click(); await settled();
  await page.getByRole('button', { name: 'Start work', exact: true }).click(); await settled();
  await page.getByRole('alert').filter({ hasText: 'Complete arrival preparation' }).waitFor();
  const checks = page.locator('input[data-check]');
  for (let index = 0; index < await checks.count(); index++) { await checks.nth(index).check(); await settled(); }
  await page.locator('[data-material="rack"]').selectOption('loaded'); await settled();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN5sAAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('Choose photos from library').setInputFiles([{ name: 'before.png', mimeType: 'image/png', buffer: png }]);
  await page.getByRole('button', { name: 'Upload photo', exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: 'Upload photo', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Upload photo', exact: true }).click();
  await page.getByText('1 verified', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start work', exact: true }).click(); await settled();
  await page.getByLabel('Add a note', { exact: true }).fill('Customer confirmed the green cabinet is staying.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click(); await settled();
  await page.getByText('Customer confirmed the green cabinet is staying.', { exact: true }).waitFor();
  await page.getByLabel('Photo category').selectOption('after');
  await page.getByLabel('Choose photos from library').setInputFiles([{ name: 'after.png', mimeType: 'image/png', buffer: png }, { name: 'after-two.png', mimeType: 'image/png', buffer: png }]);
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length >= 3);
  await page.getByRole('button', { name: 'Upload all ready photos', exact: true }).click();
  await page.getByText('3 verified', { exact: true }).waitFor();
  await page.getByLabel('Completion notes', { exact: true }).fill('Garage cleaned, rack installed, and customer walkthrough completed.');
  await page.getByLabel('Does anything need follow-up?').selectOption('no');
  await page.getByRole('button', { name: 'Review & complete job', exact: true }).click(); await settled();
  await page.getByText('Completed by Crew One.', { exact: true }).waitFor();
  await page.reload(); await page.getByText('Completed by Crew One.', { exact: true }).waitFor();
  assert.equal(store.get('jobs/browser-job').status, 'completed');
  assert.equal(store.get('jobs/browser-job').fieldExecution.photos.length, 3);
  assert.equal(store.get('jobs/browser-next').status, 'scheduled');
  assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'mobile job detail must not overflow');
  assert.deepEqual(errors, [], 'no browser JavaScript errors');
  await page.screenshot({ path: resolve(artifactDir, 'completed-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1365, height: 950 }); await page.screenshot({ path: resolve(artifactDir, 'completed-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'before photo' }).first().click().catch(async () => { await page.locator('.photo-tile').first().click(); });
  await page.locator('#photo-viewer[open] img').waitFor();
  await page.waitForFunction(() => document.querySelector('#photo-viewer img').naturalWidth > 0);
  await page.getByRole('button', { name: 'Close photo' }).click();
  store.put('jobs/browser-job', { ...store.get('jobs/browser-job'), assignedCrew: ['Crew-One'] });
  await page.reload(); await page.getByRole('heading', { name: 'We could not open this work' }).waitFor();
  assert.equal(await page.getByText('This job is not currently assigned', { exact: false }).count() > 0, true);
  console.log(JSON.stringify({ ok: true, browser: browser.version(), viewport: '390x844 touch, Pacific device timezone with Mountain job dates', checks: ['login', 'personal day', 'navigate job', 'en route', 'arrived', 'start validation', 'checklists', 'materials', 'library upload', 'draft refresh persistence', 'multiple photos', 'notes', 'completion', 'server refresh persistence', 'next job preserved', 'private photo viewer', 'reassignment revokes detail', 'mobile overflow', 'desktop render', 'no browser errors'], artifacts: artifactDir }));
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch; }
