// Run with FIELD_PLAYWRIGHT_MODULE pointing to an installed Playwright module (optional
// PLAYWRIGHT_CHROMIUM_EXECUTABLE; screenshots go to FIELD_QA_OUTPUT or test-results/field-qa).
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
import * as employee from '../functions/api/employee-hub.js';

const modulePath = process.env.FIELD_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error('Set FIELD_PLAYWRIGHT_MODULE to the Playwright index.mjs path.');
const playwright = await import(pathToFileURL(modulePath).href), engine = process.env.FIELD_BROWSER_ENGINE || 'chromium';
const root = fileURLToPath(new URL('../', import.meta.url));
const password = 'Synthetic browser test only!';
const users = Object.fromEntries(await Promise.all(['ZacB', 'Crew.One', 'Crew-One'].map(async user => [user, { passwordHash: await hashHubCredential(user, password), role: user === 'ZacB' ? 'owner' : 'crew', displayName: user === 'Crew.One' ? 'Crew One' : user }])));
const env = { HUB_SESSION_SECRET: 'field-browser-synthetic', EMPLOYEE_HUB_DATA_SECRET: 'field-browser-synthetic-vault', FIREBASE_API_KEY: 'firebase-test-field-browser', HUB_AUTH_USERS_JSON: JSON.stringify(users), GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test' };
const originalFetch = globalThis.fetch;
const store = storage({ mock: { method(object, key, implementation) { object[key] = implementation; } } });
const background = [];
let base = '';
// Simulates a dropped connection for the page and its service worker alike.
let serverDown = false;
// Commits one matching request, then cuts its reply mid-body: a lost response.
// (Playwright's route.fetch()+abort() now reports "Route is already handled!".)
let loseReply = null;
// Refuses photo uploads only, like a signal too weak to send a photo.
let photoUploadsDown = false;
// Holds photo uploads until released, like a weak signal that stalls a large POST.
let photoStall = null;
// The action of every job POST, in the order the server received them.
const posted = [];
const date = field.fieldToday();
const job = { id: 'browser-job', type: 'job', date, time: '08:00', endTime: '11:00', customer: 'Synthetic Garage', phone: '9705550100', address: '123 Test Street, Fort Collins, CO', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', status: 'scheduled', pipelineStatus: 'scheduled', jobInstructions: { operationalScope: 'Clean the garage, preserve the green cabinet and install the rack.', accessNotes: 'Customer will open the side gate.' }, requiredEquipment: ['Gloves', 'Pressure washer'], materials: [{ id: 'rack', name: 'Wall rack', quantity: 1 }] };
store.put('jobs/browser-job', job);
store.put('jobs/browser-next', { ...job, id: 'browser-next', customer: 'Synthetic Next Job', time: '13:00', endTime: '16:00' });
const server = createServer(async (incoming, outgoing) => {
  if (serverDown) { incoming.socket.destroy(); return; }
  try {
    const url = new URL(incoming.url, base);
    if (photoUploadsDown && url.pathname === '/api/field-jobs' && incoming.method === 'POST') { incoming.socket.destroy(); return; }
    if (url.pathname.startsWith('/api/')) {
      const parts = []; for await (const part of incoming) parts.push(part);
      const bytes = Buffer.concat(parts), request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(bytes.length ? { body: bytes } : {}) });
      if (url.pathname === '/api/field-jobs' && incoming.method === 'POST') {
        const action = (() => { try { return JSON.parse(bytes.toString()).action; } catch { return ''; } })(), stall = photoStall;
        posted.push(action);
        if (stall && action === 'photo') await stall;
      }
      const route = url.pathname === '/api/field-jobs' ? field : url.pathname === '/api/employee-hub' ? employee : auth;
      const response = await route[{ POST: 'onRequestPost', DELETE: 'onRequestDelete' }[incoming.method] || 'onRequestGet']({ request, env, waitUntil: promise => background.push(promise) });
      if (loseReply?.(url, incoming.method, bytes.toString())) { loseReply = null; outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '4096' }); outgoing.write('{"ok":'); setTimeout(() => incoming.socket.destroy(), 50); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const filename = resolve(root, `.${url.pathname}`);
    if (!filename.startsWith(resolve(root, 'crew') + '\\') && !filename.startsWith(resolve(root, 'crew') + '/')) { outgoing.writeHead(404); outgoing.end(); return; }
    const data = await readFile(filename); outgoing.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' })[extname(filename)] || 'application/octet-stream' }); outgoing.end(data);
  } catch (error) { outgoing.writeHead(500); outgoing.end(String(error.message)); }
});
await new Promise(resolve => server.listen(0, 'localhost', resolve)); base = `http://localhost:${server.address().port}`;
const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.FIELD_BROWSER_CHANNEL ? { channel: process.env.FIELD_BROWSER_CHANNEL } : {}), ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles' });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
const artifactDir = process.env.FIELD_QA_OUTPUT || resolve(root, 'test-results/field-qa'); await mkdir(artifactDir, { recursive: true });
const settled = async () => { await page.waitForFunction(() => !document.querySelector('.pending-action')); await page.waitForTimeout(75); };
try {
  await page.goto(`${base}/crew/job.html`);
  await page.getByLabel('Username', { exact: true }).fill('Crew.One'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic Garage', exact: true }).waitFor();
  assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'mobile Today must not overflow');
  await page.screenshot({ path: resolve(artifactDir, 'today-mobile.png'), fullPage: true });
  await page.getByRole('heading', { name: 'Synthetic Garage', exact: true }).click();
  await page.getByText('You are not clocked in.', { exact: false }).waitFor();
  const clockedIn = await page.evaluate(async () => (await fetch('/api/employee-hub', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collection: 'timeEntries', id: 'browser-personal-shift', data: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } } }) })).json());
  assert.equal(clockedIn.ok, true);
  await page.getByRole('button', { name: 'Refresh my shift', exact: true }).click();
  await page.getByRole('button', { name: 'Start my travel time here', exact: true }).click();
  await page.getByRole('button', { name: 'Recording travel here', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Mark en route', exact: true }).click(); await settled();
  await page.getByRole('button', { name: 'Mark arrived', exact: true }).click(); await settled();
  await page.getByRole('button', { name: 'Start work', exact: true }).click(); await settled();
  await page.getByRole('alert').filter({ hasText: 'Complete arrival preparation' }).waitFor();
  const checks = page.locator('input[data-check]');
  for (let index = 0; index < await checks.count(); index++) { await checks.nth(index).check(); await settled(); }
  await page.locator('[data-material="rack"]').selectOption('loaded'); await settled();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN5sAAAAASUVORK5CYII=', 'base64');
  // A chosen photo goes through the outbox at once. Its reply is lost after the
  // server saved it; the replay with the same photo ID must not save it twice.
  loseReply = (url, method, body) => url.pathname === '/api/field-jobs' && method === 'POST' && JSON.parse(body).action === 'photo';
  await page.getByLabel('Choose photos from library').setInputFiles([{ name: 'before.png', mimeType: 'image/png', buffer: png }]);
  for (let wait = 0; loseReply && wait < 200; wait++) await page.waitForTimeout(50);
  assert.equal(loseReply, null, 'the photo was saved before its reply was lost');
  await page.reload();
  await page.getByText('1 verified', { exact: true }).waitFor(); await settled();
  assert.equal(await page.locator('#photo-queue li').count(), 0, 'the confirmed photo left the waiting list');
  assert.equal(store.get('jobs/browser-job').fieldExecution.photos.length, 1, 'a lost photo reply never saves the photo twice');
  assert.equal(store.calls.uploads, 1, 'the photo reached Drive once');
  await page.getByRole('button', { name: 'Start work', exact: true }).click(); await settled();
  const timingJob = store.get('jobs/browser-job'), timingClock = timingJob.fieldExecution.jobTime;
  timingClock.trackingStartedAt = new Date(Date.now() - 120000).toISOString();
  timingClock.current.startedAt = new Date(Date.now() - 90000).toISOString();
  store.put('jobs/browser-job', timingJob);
  await page.reload();
  await page.locator('#job-time [data-time="work"]').getByText('1 min', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pause work', exact: true }).click();
  await page.getByLabel('Reason for paused', { exact: true }).fill('Customer is reviewing items to keep.');
  await page.getByRole('button', { name: 'Save paused', exact: true }).click(); await settled();
  await page.waitForFunction(() => parseInt(document.querySelector('#job-time [data-time="paused"]')?.textContent || '0', 10) >= 1);
  assert.equal(await page.locator('#job-time [data-time="work"]').textContent(), '1 min');
  assert.equal(store.get('jobs/browser-job').fieldExecution.jobTime.current.kind, 'paused');
  await page.getByRole('button', { name: 'Resume work', exact: true }).click(); await settled();
  assert.equal(store.get('jobs/browser-job').fieldExecution.jobTime.current.kind, 'work');
  loseReply = (url, method, body) => url.pathname === '/api/employee-hub' && method === 'POST' && Boolean(JSON.parse(body).data?.jobAction);
  // The switch whose reply was lost waits on the phone only until the service worker's Background Sync replays it,
  // about 0.1 s later, too briefly for polling locators to be sure to see it. The page is watched from before the tap
  // for the moment it shows the switch awaiting confirmation in the outbox card and in the time card at once.
  await page.evaluate(() => {
    const shown = () => [...document.querySelectorAll('#outbox-card h2')].some(heading => heading.textContent.trim() === 'Action awaiting confirmation') && [...document.querySelectorAll('#employee-job-time strong')].some(label => label.textContent.trim() === 'Time awaiting confirmation');
    const observer = new MutationObserver(() => { if (shown()) { observer.disconnect(); window.egcLostSwitchShown = true; } });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole('button', { name: 'Start my work time here', exact: true }).click();
  await page.waitForFunction(() => window.egcLostSwitchShown === true);
  assert.equal(loseReply, null, 'the job-time switch was committed before its reply was lost');
  await page.reload();
  await page.getByRole('button', { name: 'Recording work here', exact: true }).waitFor();
  assert.equal(await page.locator('#manager-job-labor').count(), 0);
  assert.equal(await page.evaluate(async () => (await fetch('/api/employee-hub?view=job-labor&jobId=browser-job')).status), 403);
  const personalShift = await page.evaluate(async () => (await (await fetch('/api/employee-hub')).json()).collections.timeEntries.find(entry => entry.id === 'browser-personal-shift'));
  assert.equal(personalShift.jobTracking.segments.length, 3, 'lost response must not duplicate employee segments');
  await page.getByLabel('Add a note', { exact: true }).fill('Customer confirmed the green cabinet is staying.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click(); await settled();
  await page.getByText('Customer confirmed the green cabinet is staying.', { exact: true }).waitFor();
  await page.getByLabel('Photo category').selectOption('after');
  // A weak signal stalls the first upload. The job page stays usable: a check
  // can change and a photo waiting behind the upload is discarded at once;
  // only the photo being sent cannot be discarded. All of it syncs once, in order.
  let releasePhotos; photoStall = new Promise(resolve => { releasePhotos = resolve; });
  const postedBefore = posted.length;
  await page.getByLabel('Choose photos from library').setInputFiles([{ name: 'after.png', mimeType: 'image/png', buffer: png }, { name: 'after-two.png', mimeType: 'image/png', buffer: png }, { name: 'after-extra.png', mimeType: 'image/png', buffer: png }]);
  await page.getByRole('heading', { name: '3 photos waiting to upload', exact: true }).waitFor();
  await page.locator('#photo-queue li').first().getByText('Uploading and verifying…', { exact: false }).waitFor();
  const controls = () => page.evaluate(() => ({ checks: [...document.querySelectorAll('input[data-check]')].filter(input => input.disabled).length, status: [...document.querySelectorAll('[data-action="status"]')].map(button => button.disabled), note: document.querySelector('#note-form button[type=submit]').disabled, discard: [...document.querySelectorAll('#photo-queue [data-action="photo-discard"]')].map(button => button.disabled) }));
  assert.deepEqual(await controls(), { checks: 0, status: [false, false, false], note: false, discard: [true, false, false] }, 'a stalled photo upload does not lock the job page');
  assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'the uploading queue fits a phone');
  await page.screenshot({ path: resolve(artifactDir, 'photo-uploading-mobile.png'), fullPage: true });
  await page.locator('#photo-queue li').nth(2).getByRole('button', { name: 'Discard photo', exact: true }).click();
  await page.getByRole('heading', { name: '2 photos waiting to upload', exact: true }).waitFor();
  await page.getByText('Photo discarded. It was not saved to the job.', { exact: true }).waitFor();
  const lastCheckId = await page.locator('input[data-check]').last().getAttribute('data-check'), lastCheck = () => page.locator(`input[data-check="${lastCheckId}"]`);
  await lastCheck().click(); await page.locator(`input[data-check="${lastCheckId}"]:not(:checked)`).waitFor();
  await lastCheck().click(); await page.locator(`input[data-check="${lastCheckId}"]:checked`).waitFor();
  for (let wait = 0; wait < 100 && (await page.evaluate(async () => (await window.EGCFieldOutbox.create().items('Crew.One')).filter(item => item.payload.action === 'checklist').length)) < 2; wait++) await page.waitForTimeout(50);
  assert.deepEqual(await controls(), { checks: 0, status: [false, false, false], note: false, discard: [true, false] }, 'the page stays usable while the photo is still stalled');
  assert.deepEqual(posted.slice(postedBefore), ['photo'], 'only the stalled photo has been sent');
  photoStall = null; releasePhotos();
  await page.getByText('3 verified', { exact: true }).waitFor(); await settled();
  assert.deepEqual(posted.slice(postedBefore), ['photo', 'photo', 'checklist', 'checklist'], 'the check changes follow the photos and the discarded photo is never sent');
  assert.equal(store.get('jobs/browser-job').fieldExecution.checks[lastCheckId].completed, true);
  assert.deepEqual(store.get('jobs/browser-job').fieldExecution.photos.map(photo => photo.category), ['before', 'after', 'after']);
  await page.getByLabel('Completion notes', { exact: true }).fill('Garage cleaned, rack installed, and customer walkthrough completed.');
  await page.getByLabel('Does anything need follow-up?').selectOption('no');
  await page.getByRole('button', { name: 'Review & complete job', exact: true }).click(); await settled();
  await page.getByText('Completed by Crew One.', { exact: true }).waitFor();
  await page.reload(); await page.getByText('Completed by Crew One.', { exact: true }).waitFor();
  assert.equal(store.get('jobs/browser-job').status, 'completed');
  assert.equal(store.get('jobs/browser-job').fieldExecution.photos.length, 3);
  assert.equal(store.get('jobs/browser-next').status, 'scheduled');
  await page.getByRole('button', { name: 'End my job time', exact: true }).click();
  await page.getByText('General shift time', { exact: true }).waitFor();
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
  store.put('jobs/browser-interruption', { ...job, id: 'browser-interruption', customer: 'Synthetic Interruption Job' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/crew/job.html?jobId=browser-interruption`);
  await page.getByRole('heading', { name: 'Synthetic Interruption Job', exact: true }).waitFor();
  // Offline outbox: queue three checks, a note and a photo, reload with no
  // connection (shell from the service worker), reconnect, and every action
  // applies once, in order.
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
  serverDown = true; await context.setOffline(true);
  await page.setViewportSize({ width: 375, height: 812 });
  const offlineChecks = page.locator('input[data-check]'), checkIds = [];
  for (let index = 0; index < 3; index++) {
    checkIds.push(await offlineChecks.nth(index).getAttribute('data-check'));
    await offlineChecks.nth(index).click();
    await page.getByRole('heading', { name: `${index + 1} action${index ? 's' : ''} saved on this phone`, exact: true }).waitFor();
  }
  await page.getByLabel('Add a note', { exact: true }).fill('Offline note survives refresh and syncs once.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByRole('heading', { name: '4 actions saved on this phone', exact: true }).waitFor();
  await page.getByLabel('Photo category').selectOption('progress');
  await page.getByLabel('Caption (optional)', { exact: true }).fill('Synthetic offline progress photo');
  await page.getByLabel('Take a photo').setInputFiles([{ name: 'offline-progress.png', mimeType: 'image/png', buffer: png }]);
  await page.getByRole('heading', { name: '5 actions saved on this phone', exact: true }).waitFor();
  await page.getByRole('heading', { name: '1 photo waiting to upload', exact: true }).waitFor();
  await page.locator('#photo-queue').getByText('Saved on this phone · uploads when you reconnect', { exact: false }).waitFor();
  await page.getByText('1 waiting to upload', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Caption (optional)', { exact: true }).inputValue(), '', 'the caption went with the queued photo');
  const [offlinePhoto] = (await page.evaluate(async () => (await window.EGCFieldOutbox.create().items('Crew.One')).filter(item => item.payload.action === 'photo'))).map(item => ({ requestId: item.requestId, jobId: item.jobId, category: item.payload.category, caption: item.payload.caption, image: item.payload.dataUrl.slice(0, 23) }));
  assert.deepEqual({ ...offlinePhoto, requestId: typeof offlinePhoto.requestId }, { requestId: 'string', jobId: 'browser-interruption', category: 'progress', caption: 'Synthetic offline progress photo', image: 'data:image/jpeg;base64,' }, 'the resized photo is kept in the per-user IndexedDB outbox');
  await page.getByRole('button', { name: 'Start break', exact: true }).click();
  await page.getByRole('heading', { name: '6 actions saved on this phone', exact: true }).waitFor();
  await page.getByRole('button', { name: 'End break', exact: true }).waitFor();
  assert.match(await page.locator('#connection').textContent(), /6 saved actions are on this phone/);
  await page.reload();
  await page.getByRole('heading', { name: 'Synthetic Interruption Job', exact: true }).waitFor();
  await page.getByRole('heading', { name: '6 actions saved on this phone', exact: true }).waitFor();
  await page.getByRole('button', { name: 'End break', exact: true }).waitFor();
  assert.equal(await page.locator('input[data-check]:checked').count(), 3, 'queued checks stay visible after an offline reload');
  assert.equal(await page.getByLabel('Add a note', { exact: true }).inputValue(), '', 'the queued note is held by the outbox, not left as a draft');
  await page.getByRole('heading', { name: '1 photo waiting to upload', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#photo-queue img')?.naturalWidth > 0);
  assert.equal(await page.locator('#photo-queue img').getAttribute('alt'), 'progress photo saved on this phone', 'the pending thumbnail survives an offline reload');
  assert.ok((await page.getByRole('button', { name: 'Discard photo', exact: true }).boundingBox()).height >= 44, 'the discard control is a full tap target');
  assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'offline outbox must fit a phone');
  await page.screenshot({ path: resolve(artifactDir, 'offline-outbox-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const beforeSync = store.calls.commits, uploadsBefore = store.calls.uploads;
  serverDown = false; await context.setOffline(false);
  await page.getByText('Offline note survives refresh and syncs once.', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.pending-action') && !document.querySelector('#outbox-card li') && !document.querySelector('#photo-queue li')); await settled();
  const synced = store.get('jobs/browser-interruption');
  assert.deepEqual(checkIds.map(id => synced.fieldExecution.checks[id]?.completed), [true, true, true]);
  assert.deepEqual(synced.fieldExecution.photos.map(photo => [photo.id, photo.category, photo.caption, photo.actorId]), [[offlinePhoto.requestId, 'progress', 'Synthetic offline progress photo', 'Crew.One']], 'the offline photo is saved once under the ID it was queued with');
  await page.getByText('1 verified', { exact: true }).waitFor();
  const offlineEvents = [...store.documents.keys()].filter(key => key.startsWith('jobs/browser-interruption/fieldEvents/')).map(key => store.get(key));
  assert.equal(offlineEvents.filter(event => event.action === 'note' && event.body === 'Offline note survives refresh and syncs once.').length, 1, 'the offline note applies exactly once');
  assert.equal(offlineEvents.filter(event => event.action === 'checklist').length, 3, 'each offline check applies exactly once');
  const photoEvents = offlineEvents.filter(event => event.action === 'photo'), noteEvent = offlineEvents.find(event => event.action === 'note');
  assert.equal(photoEvents.length, 1); assert.equal(photoEvents[0].state, 'applied');
  assert.ok(photoEvents[0].createdAt > noteEvent.createdAt, 'the photo replays after the note queued before it');
  assert.equal(store.calls.uploads - uploadsBefore, 1, 'the offline photo reached Drive once');
  assert.equal(store.calls.commits - beforeSync, 7, 'four job actions, the photo (pending receipt, then verified) and one break produce seven commits');
  // Weak signal: the server is unreachable while the phone still reports a
  // connection, so no 'online' event follows. Returning to the page resyncs.
  serverDown = true; await page.reload();
  await page.getByText('Offline: showing the last copy of this job confirmed in this tab.', { exact: false }).waitFor();
  await page.getByLabel('Add a note', { exact: true }).fill('Weak signal note syncs without an online event.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByRole('heading', { name: '1 action saved on this phone', exact: true }).waitFor();
  serverDown = false;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.getByText('Weak signal note syncs without an online event.', { exact: true }).waitFor(); await settled();
  assert.equal([...store.documents.keys()].filter(key => key.startsWith('jobs/browser-interruption/fieldEvents/')).map(key => store.get(key)).filter(event => event.body === 'Weak signal note syncs without an online event.').length, 1);
  const onBreak = await page.evaluate(async () => (await (await fetch('/api/employee-hub?view=own-job-time')).json()).entry);
  assert.equal(onBreak.id, 'browser-personal-shift'); assert.equal(onBreak.onBreak, true); assert.equal(onBreak.breaks.length, 1, 'the offline break was recorded once');
  await page.getByRole('button', { name: 'End break', exact: true }).click();
  await page.getByRole('button', { name: 'Start break', exact: true }).waitFor(); await settled();
  // EGC_OFFLINE_CLOCK_ENABLED is off here: a time action saved on the phone
  // ten minutes ago is refused for review, never recorded at the sync time.
  await page.evaluate(() => window.EGCFieldOutbox.create().enqueue({ requestId: crypto.randomUUID(), kind: 'clock', user: 'Crew.One', jobId: 'browser-interruption', payload: { op: 'break_start', entryId: 'browser-personal-shift', deviceCapturedAt: new Date(Date.now() - 10 * 60000).toISOString() } }));
  await page.reload();
  await page.getByRole('heading', { name: 'Saved action needs review', exact: true }).waitFor();
  await page.locator('.outbox-error').getByText('Offline clock times are not enabled. Record it again now or ask a manager for a time correction.', { exact: true }).waitFor();
  assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'the refused time action fits a phone');
  await page.screenshot({ path: resolve(artifactDir, 'stale-clock-refused-mobile.png'), fullPage: true });
  assert.equal(await page.getByRole('button', { name: 'Start break', exact: true }).isDisabled(), true, 'more time waits until the refused action is reviewed');
  await page.getByRole('button', { name: 'Discard this action', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.outbox-error') && document.querySelector('[data-action="break-start"]')?.disabled === false);
  const afterStale = await page.evaluate(async () => (await (await fetch('/api/employee-hub?view=own-job-time')).json()).entry);
  assert.equal(afterStale.onBreak, false); assert.equal(afterStale.breaks.length, 1, 'the stale offline break was never recorded');
  await page.getByRole('button', { name: 'Clock out', exact: true }).click();
  await page.getByText('You are not clocked in.', { exact: false }).waitFor(); await settled();
  const submitted = await page.evaluate(async () => (await (await fetch('/api/employee-hub')).json()).collections.timeEntries.find(entry => entry.id === 'browser-personal-shift'));
  assert.equal(submitted.status, 'submitted'); assert.equal(submitted.approvalStatus, 'pending'); assert.ok(submitted.breaks[0].endAt <= submitted.clockOutAt);
  await context.grantPermissions(['geolocation'], { origin: base }); await context.setGeolocation({ latitude: 40.58, longitude: -105.08, accuracy: 8 });
  await page.getByRole('button', { name: 'Clock in', exact: true }).click();
  await page.getByRole('button', { name: 'Start break', exact: true }).waitFor(); await settled();
  const reopened = await page.evaluate(async () => (await (await fetch('/api/employee-hub?view=own-job-time')).json()).entry);
  assert.match(reopened.id, /^time-crew\.one-/); assert.equal(reopened.deviceTime, false, 'a fresh device time records server time while EGC_OFFLINE_CLOCK_ENABLED is off');
  const reopenedCard = await page.evaluate(async id => (await (await fetch('/api/employee-hub')).json()).collections.timeEntries.find(entry => entry.id === id), reopened.id);
  // Owner decision CLOCK-IN ONLY (CREW-TIME): the crew app reads one position at clock-in and nothing tracks it after, so
  // the card keeps that one fix under the crew app's job_page_single_fix status, with tracking off and no trail.
  assert.equal(reopenedCard.locationTracking, false, 'clock-in only: nothing keeps sharing location during the shift');
  assert.equal(reopenedCard.locationStatus, 'job_page_single_fix', 'the crew app clock-in records its single fix');
  assert.deepEqual([reopenedCard.lastLocation?.lat, reopenedCard.lastLocation?.lng, reopenedCard.lastLocation?.accuracy], [40.58, -105.08, 8], 'the one clock-in position is stored');
  assert.equal(reopenedCard.locationTrail, undefined, 'a clock-in-only shift keeps no location trail');
  assert.equal(await page.locator('#outbox-card .pending-action').count(), 0);
  const cachedUrls = await page.evaluate(async () => { const urls = []; for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(request.url); return urls; });
  assert.ok(cachedUrls.some(url => new URL(url).pathname === '/crew/job.html'), 'the job shell is cached for offline reloads');
  assert.equal(cachedUrls.some(url => new URL(url).pathname.startsWith('/api/')), false, 'the service worker never caches API responses');
  loseReply = (url, method, body) => url.pathname === '/api/field-jobs' && method === 'POST' && JSON.parse(body).action === 'note';
  await page.getByLabel('Add a note', { exact: true }).fill('This note committed before the response disappeared.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByRole('heading', { name: 'Action awaiting confirmation', exact: true }).waitFor();
  assert.equal(loseReply, null, 'the note was committed before its reply was lost');
  await page.reload();
  await page.getByText('This note committed before the response disappeared.', { exact: true }).waitFor(); await settled();
  assert.equal(await page.getByText('This note committed before the response disappeared.', { exact: true }).count(), 1);
  await page.getByLabel('Add a note', { exact: true }).fill('Reviewed the latest scope before this note.');
  store.put('jobs/browser-interruption', { ...store.get('jobs/browser-interruption'), operationalScope: { text: 'New authoritative scope from dispatch.' } });
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.getByRole('heading', { name: 'Saved action needs review', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh and retry', exact: true }).click(); await settled();
  await page.getByText('New authoritative scope from dispatch.', { exact: true }).waitFor();
  await page.getByLabel('Add a note', { exact: true }).fill('Unsaved note retained through an expired session.');
  await context.clearCookies(); await page.getByRole('button', { name: 'Refresh job', exact: true }).click();
  await page.getByRole('heading', { name: 'Your workday starts here', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Synthetic Interruption Job', exact: true }).count(), 0);
  await page.getByLabel('Username', { exact: true }).fill('Crew.One'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic Interruption Job', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Add a note', { exact: true }).inputValue(), 'Unsaved note retained through an expired session.');
  await page.screenshot({ path: resolve(artifactDir, 'recovered-mobile.png'), fullPage: true });
  await context.clearCookies(); await page.reload();
  await page.getByLabel('Username', { exact: true }).fill('Crew-One'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'We could not open this work', exact: true }).waitFor();
  assert.equal(await page.getByText('Unsaved note retained through an expired session.', { exact: true }).count(), 0);
  const managerContext = await browser.newContext({ viewport: { width: 390, height: 844 } }), managerPage = await managerContext.newPage();
  await managerPage.goto(`${base}/crew/job.html?jobId=browser-interruption`);
  await managerPage.getByLabel('Username', { exact: true }).fill('ZacB'); await managerPage.getByLabel('Password', { exact: true }).fill(password); await managerPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await managerPage.getByText('Manager: configure this job’s checklist', { exact: true }).click();
  await managerPage.getByLabel('Job checklist', { exact: true }).fill('departure | required | Confirm the pressure washer is loaded\narrival | required | Confirm scope and protect belongings\nwork | required | Perform garage service\nfinish | required | Customer walkthrough and cleanup');
  await managerPage.getByRole('button', { name: 'Save checklist', exact: true }).click();
  await managerPage.getByText('Confirm the pressure washer is loaded', { exact: true }).waitFor();
  await managerPage.getByLabel('Add a note', { exact: true }).fill('Private manager-only pricing discussion.');
  await managerPage.getByText('Management only', { exact: true }).click();
  await managerPage.reload();
  assert.equal(await managerPage.locator('#note-private').isChecked(), true, 'a private draft must stay private through refresh');
  await managerPage.getByRole('button', { name: 'Save note', exact: true }).click();
  await managerPage.getByText('Private manager-only pricing discussion.', { exact: true }).waitFor();
  await managerPage.goto(`${base}/crew/job.html?jobId=browser-job`);
  await managerPage.locator('#manager-job-labor').getByRole('heading', { name: 'Crew One', exact: true }).waitFor();
  await managerPage.locator('#manager-job-labor').getByText('Work awaiting approval', { exact: true }).waitFor();
  assert.equal(await managerPage.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'manager labor cards must fit a phone');
  await managerPage.getByRole('button', { name: 'Refresh employee time', exact: true }).click();
  await managerPage.locator('#manager-job-labor').getByRole('heading', { name: 'Crew One', exact: true }).waitFor();
  await managerPage.getByLabel('Add a note', { exact: true }).fill('Customer needs the replacement hardware delivered.');
  await managerPage.getByText('Flag an issue needing operations follow-up', { exact: true }).click();
  await managerPage.getByRole('button', { name: 'Save note', exact: true }).click();
  await managerPage.getByRole('heading', { name: 'Operations follow-up needed', exact: true }).waitFor();
  await managerPage.getByLabel('Resolution & follow-up', { exact: true }).fill('Replacement hardware was delivered and the customer confirmed receipt.');
  await managerPage.getByRole('button', { name: 'Resolve issue', exact: true }).click();
  await managerPage.locator('#job-issue').getByRole('heading', { name: 'Issue resolved', exact: true }).waitFor();
  await managerPage.reload();
  await managerPage.locator('#job-issue').getByText('Replacement hardware was delivered and the customer confirmed receipt.', { exact: true }).waitFor();
  assert.equal(store.get('jobs/browser-job').fieldExecution.attention.status, 'resolved');
  assert.equal(store.get('jobs/browser-job').fieldExecution.attention.reason, 'Customer needs the replacement hardware delivered.');
  await managerPage.getByRole('button', { name: 'Retry internal handoff', exact: true }).click();
  await managerPage.getByText('Internal completion handoff: blocked', { exact: true }).waitFor();
  assert.equal(store.get('jobs/browser-job').status, 'completed');
  await managerContext.close();
  // A phone that refuses IndexedDB keeps a photo only in the page, and says so
  // rather than claiming it is saved on the phone.
  const noStorage = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
  await noStorage.addInitScript(() => { IDBFactory.prototype.open = () => { throw new DOMException('Storage refused', 'SecurityError'); }; });
  const memoryPhone = await noStorage.newPage(); memoryPhone.on('pageerror', error => errors.push(error.message)); memoryPhone.on('dialog', dialog => dialog.accept());
  photoUploadsDown = true;
  await memoryPhone.goto(`${base}/crew/job.html?jobId=browser-next`);
  await memoryPhone.getByLabel('Username', { exact: true }).fill('Crew.One'); await memoryPhone.getByLabel('Password', { exact: true }).fill(password); await memoryPhone.getByRole('button', { name: 'Sign in', exact: true }).click();
  await memoryPhone.getByRole('heading', { name: 'Synthetic Next Job', exact: true }).waitFor();
  await memoryPhone.getByLabel('Choose photos from library').setInputFiles([{ name: 'memory-only.png', mimeType: 'image/png', buffer: png }]);
  await memoryPhone.locator('#photo-queue').getByText('Only on this page · keep it open until it uploads', { exact: false }).waitFor();
  await memoryPhone.locator('#photo-queue').getByText('so these are only on this page. Keep it open until they upload', { exact: false }).waitFor();
  assert.equal(await memoryPhone.locator('#photo-queue').getByText('Saved on this phone', { exact: false }).count(), 0, 'a photo kept only in the page is never described as saved on the phone');
  assert.equal(await memoryPhone.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'the page-only photo notice fits a phone');
  await memoryPhone.screenshot({ path: resolve(artifactDir, 'photo-page-only-mobile.png'), fullPage: true });
  await noStorage.close(); photoUploadsDown = false;
  // A shared phone: after a sign-out, the offline copy of a job is never shown
  // and nothing can be queued, whether the sign-out was in another tab, in a
  // tab open on the job, or in this same tab.
  const shared = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles' });
  const phone = await shared.newPage(); phone.on('pageerror', error => errors.push(error.message)); phone.on('dialog', dialog => dialog.accept());
  const nextJob = `${base}/crew/job.html?jobId=browser-next`;
  const openNextJob = async () => { await phone.goto(nextJob); await phone.getByLabel('Username', { exact: true }).fill('Crew.One'); await phone.getByLabel('Password', { exact: true }).fill(password); await phone.getByRole('button', { name: 'Sign in', exact: true }).click(); await phone.getByRole('heading', { name: 'Synthetic Next Job', exact: true }).waitFor(); };
  const signOutIn = async (target, options = { explicit: true }) => { await target.goto(`${base}/crew/offline.html`); await target.addScriptTag({ url: '/crew/hub-auth.js?v=20260904c' }); await target.evaluate(options => window.EGCHubAuth.signOut(options), options); };
  const waitingPhotos = target => target.evaluate(() => new Promise(resolve => { const open = indexedDB.open('egc-field-outbox'); open.onsuccess = () => { const db = open.result, rows = db.transaction('actions').objectStore('actions').getAll(); rows.onsuccess = () => { db.close(); resolve(rows.result.filter(row => row.payload?.action === 'photo').length); }; }; }));
  const offlineReopen = async shot => {
    serverDown = true; await shared.setOffline(true);
    await phone.goto(nextJob);
    await phone.getByText('Sign in when you reconnect to open your work.', { exact: true }).waitFor();
    if (shot) { await phone.screenshot({ path: resolve(artifactDir, shot), fullPage: true }); assert.equal(await phone.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true, 'the signed-out offline notice fits a phone'); }
    const shown = await phone.locator('body').innerText();
    for (const text of ['Synthetic Next Job', '123 Test Street', '9705550100', 'Clean the garage', 'side gate']) assert.equal(shown.includes(text), false, `${text} is not shown after sign-out`);
    assert.equal(await phone.locator('input[data-check], select[data-material], #note-form, [data-action="status"], [data-action="clock-in"], [data-action="break-start"], [data-action="clock-out"]').count(), 0, 'nothing can be queued after sign-out');
    assert.deepEqual(await phone.evaluate(() => Object.keys(sessionStorage).filter(name => name.startsWith('egc-field:'))), [], 'the stale copies are removed');
    assert.equal(await phone.evaluate(async () => (await window.EGCFieldOutbox.create().items('Crew.One')).length), 0);
    serverDown = false; await shared.setOffline(false);
    await phone.getByRole('heading', { name: 'Your workday starts here', exact: true }).waitFor();
    assert.equal(await phone.locator('#connection').isHidden(), true, 'reconnecting to a signed-out session clears the offline notice');
  };
  await openNextJob();
  await phone.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
  // A photo the signal was too weak to upload waits on the phone, then a
  // sign-out in another tab deletes it: it is never uploaded later.
  photoUploadsDown = true;
  await phone.getByLabel('Choose photos from library').setInputFiles([{ name: 'shared-phone.png', mimeType: 'image/png', buffer: png }]);
  await phone.getByRole('heading', { name: '1 photo waiting to upload', exact: true }).waitFor();
  await phone.locator('#photo-queue').getByText('Not confirmed yet', { exact: false }).waitFor();
  assert.equal((await phone.evaluate(async () => (await window.EGCFieldOutbox.create().items('Crew.One')).filter(item => item.payload.action === 'photo').length)), 1);
  await phone.goto(`${base}/crew/offline.html`);
  assert.equal(await phone.evaluate(() => Boolean(sessionStorage.getItem('egc-field:Crew.One:browser-next:snapshot'))), true, 'this tab kept an offline copy of the job');
  const otherTab = await shared.newPage();
  // A session that ends without the person choosing to sign out keeps the photo.
  await signOutIn(otherTab, {}); await otherTab.waitForTimeout(250);
  assert.equal(await waitingPhotos(otherTab), 1, 'an ended session keeps a waiting photo for the next sign-in');
  await signOutIn(otherTab);
  for (let wait = 0; wait < 100 && await waitingPhotos(otherTab); wait++) await otherTab.waitForTimeout(50);
  assert.equal(await waitingPhotos(otherTab), 0, 'choosing to sign out deletes the waiting photo');
  await otherTab.close(); photoUploadsDown = false;
  assert.equal(await phone.evaluate(() => Boolean(sessionStorage.getItem('egc-field:Crew.One:browser-next:snapshot'))), true, 'another tab cannot clear this tab’s session copy');
  await offlineReopen();
  await openNextJob();
  const liveTab = await shared.newPage(); await signOutIn(liveTab); await liveTab.close();
  await phone.getByText('You signed out. Sign in again to open your work.', { exact: true }).waitFor();
  assert.equal(await phone.getByRole('heading', { name: 'Synthetic Next Job', exact: true }).count(), 0, 'an open job page closes when the phone signs out elsewhere');
  await offlineReopen();
  await openNextJob();
  await signOutIn(phone);
  assert.deepEqual(await phone.evaluate(() => Object.keys(sessionStorage).filter(name => name.startsWith('egc-field:'))), [], 'signing out in this tab removes its copies');
  await offlineReopen('signed-out-offline-mobile.png');
  assert.equal(store.get('jobs/browser-next').fieldExecution?.photos?.length || 0, 0, 'the photo deleted at sign-out was never uploaded');
  await shared.close(); await Promise.all(background);
  assert.deepEqual(errors, [], 'no browser JavaScript errors after recovery');
  console.log(JSON.stringify({ ok: true, browser: browser.version(), viewport: '390x844 touch, Pacific device timezone with Mountain job dates', checks: ['login', 'personal day', 'navigate job', 'en route', 'arrived', 'start validation', 'checklists', 'materials', 'live elapsed work', 'pause and resume segment timing', 'employee work and travel segments', 'employee lost response retry', 'end employee job time after completion', 'photo lost reply saved once', 'multiple photos queued and uploaded', 'stalled photo upload leaves checks, status, notes and later discards usable', 'page-only photo labelled when IndexedDB is refused', 'notes', 'completion', 'server refresh persistence', 'next job preserved', 'private photo viewer', 'reassignment revokes detail', 'mobile overflow', 'desktop render', 'offline outbox reload via service worker', 'offline checks and note applied once', 'offline photo queued with pending thumbnail, reloaded and uploaded once in order', 'waiting photo kept when the session ends, deleted at a chosen sign-out and never uploaded', 'offline break synced once', 'weak-signal resync without an online event', 'stale offline clock action refused while the flag is off', 'crew clock in, break and clock out', 'no offline job after sign-out (other tab, open tab, same tab)', 'service worker never caches API', 'lost response idempotency', 'stale job review', 'auth expiry', 'draft isolation between accounts', 'manager employee labor totals', 'crew denied manager labor', 'manager checklist configuration', 'manager private note', 'audited issue resolution after completion', 'durable failed CRM handoff', 'no browser errors'], artifacts: artifactDir }));
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch; }
