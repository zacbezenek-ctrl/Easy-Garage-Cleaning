// Multi-day visits end to end (FIELD_MULTIDAY_VISITS=true): real field-jobs and auth handlers, the real crew page,
// synthetic Firestore only. Run with FIELD_PLAYWRIGHT_MODULE pointing to Playwright's index.mjs (optional
// PLAYWRIGHT_CHROMIUM_EXECUTABLE; screenshots go to FIELD_QA_OUTPUT or test-results/field-multiday).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname } from 'node:path';
import { hashHubCredential } from '../functions/_lib/hub-session.js';
import { fieldChecklist } from '../functions/_lib/field-execution.js';
import { addDays } from '../functions/_lib/dispatch-time.js';
import { storage } from './helpers/field-fixture.mjs';
import * as field from '../functions/api/field-jobs.js';
import * as auth from '../functions/api/hub-auth.js';
import * as employee from '../functions/api/employee-hub.js';

// Both clocks are pinned, never the real one: the handlers' new Date() and the phone start at 10:00 on
// Tuesday 2026-09-22 in Denver and advance normally; travel() moves both forward together.
const RealDate = Date, began = RealDate.now(); let pinned = Date.parse('2026-09-22T16:00:00.000Z');
const clock = () => pinned + RealDate.now() - began;
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [clock()])); } static now() { return clock(); } };
const modulePath = process.env.FIELD_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set FIELD_PLAYWRIGHT_MODULE to the Playwright index.mjs path.');
const playwright = await import(pathToFileURL(modulePath).href);
const root = fileURLToPath(new URL('../', import.meta.url)), password = 'Synthetic multi-day browser test only!';
const users = Object.fromEntries(await Promise.all(['Crew.One', 'Crew.Two'].map(async user => [user, { passwordHash: await hashHubCredential(user, password), role: 'crew', displayName: user.replace('.', ' ') }])));
const env = { HUB_SESSION_SECRET: 'field-multiday-browser-synthetic', EMPLOYEE_HUB_DATA_SECRET: 'field-multiday-browser-synthetic-vault', FIREBASE_API_KEY: 'firebase-test-field-multiday', HUB_AUTH_USERS_JSON: JSON.stringify(users), FIELD_MULTIDAY_VISITS: 'true' };
const originalFetch = globalThis.fetch, store = storage({ mock: { method(object, key, implementation) { object[key] = implementation; } } });
const today = '2026-09-22', tomorrow = addDays(today, 1), last = addDays(today, 2);
assert.equal(field.fieldToday(), today, 'the server clock is pinned');
const base = { type: 'job', time: '08:00', endTime: '17:00', date: today, endDate: last, phone: '9705550100', address: '1 Synthetic Way, Fort Collins, CO', status: 'scheduled', pipelineStatus: 'scheduled', jobInstructions: { operationalScope: 'Synthetic three-day cleanout.' } };
const three = { ...base, id: 'multi', customer: 'Synthetic Three-Day Garage', status: 'arrived', pipelineStatus: 'arrived', startedAt: null, assignedCrew: ['Crew.One'], crewLead: 'Crew.One' };
three.fieldExecution = { checks: Object.fromEntries(fieldChecklist(three).map(item => [item.id, { completed: true, actorId: 'Crew.One' }])), photos: [{ id: crypto.randomUUID(), fileId: 'file-before', category: 'before', verified: true }] };
store.put('jobs/multi', three);
const part = (id, date, crew) => ({ id, date, time: '08:00', endDate: date, endTime: '17:00', assignedCrew: [crew], crewLead: null, crewId: null, vehicleId: null, notes: '' });
const late = { ...three, id: 'late', customer: 'Synthetic Late-Sync Garage' };
store.put('jobs/late', late);
store.put('jobs/split', { ...base, id: 'split', customer: 'Synthetic Split Garage', assignedCrew: ['crew.one', 'crew.two'], assignmentSegments: [part('a', today, 'crew.one'), part('b', tomorrow, 'crew.two'), part('c', last, 'crew.one')] });
let url = '';
const server = createServer(async (incoming, outgoing) => {
  try {
    const target = new URL(incoming.url, url);
    if (target.pathname.startsWith('/api/')) {
      const parts = []; for await (const chunk of incoming) parts.push(chunk);
      const bytes = Buffer.concat(parts), request = new Request(target, { method: incoming.method, headers: incoming.headers, ...(bytes.length ? { body: bytes } : {}) });
      const handler = target.pathname === '/api/field-jobs' ? field : target.pathname === '/api/employee-hub' ? employee : auth;
      const response = await handler[incoming.method === 'POST' ? 'onRequestPost' : 'onRequestGet']({ request, env, waitUntil: () => {} });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const filename = resolve(root, `.${target.pathname}`);
    if (!filename.startsWith(resolve(root, 'crew') + '/')) { outgoing.writeHead(404); outgoing.end(); return; }
    outgoing.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' })[extname(filename)] || 'application/octet-stream' }); outgoing.end(await readFile(filename));
  } catch (error) { outgoing.writeHead(500); outgoing.end(String(error.message)); }
});
await new Promise(done => server.listen(0, 'localhost', done)); url = `http://localhost:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const artifacts = process.env.FIELD_QA_OUTPUT || resolve(root, 'test-results/field-multiday'); await mkdir(artifacts, { recursive: true });
const errors = [];
async function travel(page, iso) { pinned = Date.parse(iso) - (RealDate.now() - began); if (page) await page.clock.setSystemTime(Date.now()); }
async function login(page, user) { await page.getByLabel('Username', { exact: true }).fill(user); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); }
async function signIn(user, jobId) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' }), page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); page.setDefaultTimeout(20000);
  await page.clock.install({ time: Date.now() });
  await page.goto(`${url}/crew/job.html?jobId=${jobId}`);
  await login(page, user);
  return { context, page };
}
const fits = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
// The crew page shows a saved action at once (from the outbox, marked "Waiting to sync") and sends it right after;
// wait until the server holds it and the phone has nothing left to send before reading the store or going offline.
async function confirmed(page, id, check) {
  for (let tries = 0; tries < 400 && !check(store.get(`jobs/${id}`)); tries++) await new Promise(done => setTimeout(done, 25));
  assert.ok(check(store.get(`jobs/${id}`)), `the server confirmed the ${id} action`);
  await page.waitForFunction(() => !document.querySelector('.badge.queued'));
}
try {
  const { context, page } = await signIn('Crew.One', 'multi');
  await page.getByRole('heading', { name: 'Synthetic Three-Day Garage', exact: true }).waitFor();
  const card = page.locator('#visit-card');
  await card.getByRole('heading', { name: 'Visits', exact: true }).waitFor();
  assert.equal(await card.locator('.visit-days li').count(), 3, 'one row per scheduled Denver day');
  assert.match(await page.locator('#complete-card').innerText(), /Completion opens on the final day/);
  assert.equal(await page.getByRole('button', { name: 'Review & complete job', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Start work', exact: true }).click();
  await page.getByRole('button', { name: 'Pause work', exact: true }).waitFor();
  await card.getByLabel('What was done today and what remains').fill('Synthetic day one: north wall cleared, shelving remains.');
  await card.getByRole('button', { name: 'End today’s visit', exact: true }).click();
  await card.locator('.visit-days li.today').getByText('Day ended', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start today’s work', exact: true }).waitFor();
  await confirmed(page, 'multi', job => job.fieldExecution?.visits?.[today]?.status === 'ended');
  assert.equal(await page.getByRole('button', { name: 'Pause work', exact: true }).count(), 0);
  assert.equal(await card.locator('#end-day-form').count(), 0);
  const saved = store.get('jobs/multi');
  assert.deepEqual([saved.fieldExecution.visits[today].status, saved.fieldExecution.visits[today].notes, saved.fieldExecution.jobTime.current], ['ended', 'Synthetic day one: north wall cleared, shelving remains.', null]);
  assert.equal(await fits(page), true, 'the visits card fits a 375px phone');
  await page.screenshot({ path: resolve(artifacts, 'multiday-day-ended-mobile.png'), fullPage: true });
  await page.reload(); await card.locator('.visit-days li.today').getByText('Synthetic day one: north wall cleared, shelving remains.', { exact: true }).waitFor();
  const early = await page.evaluate(async revision => (await fetch('/api/field-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: 'multi', requestId: crypto.randomUUID(), expectedRevision: revision, action: 'complete', notes: 'Synthetic attempt before the final day.', hasIssues: false }) })).json(), store.revision('multi'));
  assert.equal(early.code, 'FIELD_COMPLETION_NOT_FINAL_DAY');
  await context.close();
  const second = await signIn('Crew.Two', 'split');
  await second.page.getByRole('heading', { name: 'Synthetic Split Garage', exact: true }).waitFor();
  await second.page.locator('#visit-card').getByText('You are not scheduled on this job today', { exact: false }).waitFor();
  assert.equal(await second.page.locator('[data-action="status"]').first().isDisabled(), true);
  const refused = await second.page.evaluate(async revision => { const response = await fetch('/api/field-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: 'split', requestId: crypto.randomUUID(), expectedRevision: revision, action: 'note', body: 'Synthetic day-two crew note on day one.' }) }); return [response.status, (await response.json()).code]; }, store.revision('split'));
  assert.deepEqual(refused, [403, 'FIELD_JOB_NOT_ASSIGNED_TODAY']);
  const listed = await second.page.evaluate(async days => Promise.all(days.map(async date => (await (await fetch(`/api/field-jobs?date=${date}`)).json()).jobs.map(job => job.id))), [today, tomorrow]);
  assert.deepEqual(listed, [[], ['split']], 'the day-two crew sees the job only on day two');
  assert.equal(await fits(second.page), true);
  await second.page.screenshot({ path: resolve(artifacts, 'multiday-not-today-mobile.png'), fullPage: true });
  await second.context.close();
  // An iPhone without Background Sync: the end of day is saved offline at 17:00 and the page is next opened at
  // 07:30 the following day, after the session expired. It must close day one, not day two, and flag the clock.
  await travel(null, `${today}T22:40:00.000Z`);
  const third = await signIn('Crew.One', 'late'), lateCard = third.page.locator('#visit-card');
  await third.page.getByRole('heading', { name: 'Synthetic Late-Sync Garage', exact: true }).waitFor();
  await third.page.getByRole('button', { name: 'Start work', exact: true }).click();
  await third.page.getByRole('button', { name: 'Pause work', exact: true }).waitFor();
  await confirmed(third.page, 'late', job => job.fieldExecution?.visits?.[today]?.status === 'in_progress');
  await third.context.setOffline(true);
  await travel(third.page, `${today}T23:00:00.000Z`);
  await lateCard.getByLabel('What was done today and what remains').fill('Synthetic day one saved offline: shelving remains.');
  await lateCard.getByRole('button', { name: 'End today’s visit', exact: true }).click();
  await lateCard.locator('.visit-days li.today').getByText('Saved on this phone · waiting to sync', { exact: true }).waitFor();
  await travel(third.page, `${tomorrow}T13:30:00.000Z`);
  await third.context.setOffline(false);
  await third.page.getByLabel('Username', { exact: true }).waitFor(); await login(third.page, 'Crew.One');
  await lateCard.locator('.visit-days li').first().getByText('(saved offline, synced after midnight)', { exact: false }).waitFor();
  const synced = store.get('jobs/late').fieldExecution;
  assert.deepEqual(Object.keys(synced.visits), [today], 'day two is untouched');
  assert.deepEqual([synced.visits[today].status, synced.visits[today].endedLate, synced.visits[today].notes, synced.jobTime.current, synced.jobTime.needsReview], ['ended', true, 'Synthetic day one saved offline: shelving remains.', null, true]);
  assert.match(await lateCard.locator('.visit-days li.today').innerText(), /Not started/);
  assert.equal(await third.page.locator('#outbox-card li').count(), 0, 'nothing is left on the phone');
  assert.equal(await fits(third.page), true);
  await third.page.screenshot({ path: resolve(artifacts, 'multiday-late-sync-mobile.png'), fullPage: true });
  await third.context.close();
  assert.deepEqual(errors, [], 'no browser JavaScript errors');
  console.log(JSON.stringify({ ok: true, browser: browser.version(), checks: ['visits card', 'completion waits for the final day', 'end_day stops the job clock', 'no pause after the day ended', 'visit survives reload', 'server refuses early crew completion', 'split crew day lock (UI and 403)', 'split day listing', 'offline end of day synced after midnight closes day one', 'mobile overflow'], artifacts }));
} finally { await browser.close(); await new Promise(done => server.close(done)); globalThis.fetch = originalFetch; globalThis.Date = RealDate; }
