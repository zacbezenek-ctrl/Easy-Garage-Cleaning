// Canvassing smoke test in a real browser (Playwright Chromium, phone-sized):
// a rep signs in, starts a shift, logs five doors with no signal (reloading the app offline in the
// middle), reconnects, and the admin view shows those doors. Real /api/knock-* handlers and the
// real page; Firestore is the in-memory REST fake, or the emulator when FIRESTORE_EMULATOR_HOST is set.
//   node tests/knock.browser.mjs
//   EGC_KNOCK_EMULATOR=1 node scripts/emulator-exec.mjs --project demo-egc-knock "node tests/knock.browser.mjs"
// FIELD_PLAYWRIGHT_MODULE may point at playwright/index.mjs; PLAYWRIGHT_CHROMIUM_EXECUTABLE at a browser.
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PASSWORD, previewSeed, startPreview } from './knock-dev-server.mjs';

// Tuesday 2026-10-06, 11:00 am in Fort Collins: inside the knocking window (sunset 6:34 pm).
const T0 = Date.parse('2026-10-06T17:00:00.000Z');
const startedAt = Date.now();
const clock = () => new Date(T0 + (Date.now() - startedAt));

const playwrightModule = process.env.FIELD_PLAYWRIGHT_MODULE || fileURLToPath(new URL('../node_modules/playwright/index.mjs', import.meta.url));
const { chromium } = await import(pathToFileURL(playwrightModule).href);

async function startServer() {
  if (process.env.EGC_KNOCK_EMULATOR === '1' && process.env.FIRESTORE_EMULATOR_HOST) {
    const { startEmulatorHarness } = await import('./helpers/emulator-harness.mjs');
    const hub = await startEmulatorHarness({
      projectId: process.env.GCLOUD_PROJECT || 'demo-egc-knock', password: PASSWORD, now: clock,
      users: [['ZacB', 'Zac', 'owner'], ['Rep.One', 'Rep One', 'sales'], ['Rep.Two', 'Rep Two', 'sales'], ['Lead.One', 'Lead One', 'sales']],
    });
    await hub.seed(db => Promise.all(Object.entries(previewSeed()).map(([path, data]) => db.doc(path).set(data))));
    const knocks = async () => {
      let count = 0;
      await hub.seed(async db => { count = (await db.collection('knock_events').where('type', '==', 'knock').get()).size; });
      return count;
    };
    return { ...hub, knocks, mode: 'emulator' };
  }
  const preview = await startPreview({ now: clock });
  const knocks = async () => [...preview.fake.documents.keys()].filter(path => path.startsWith('knock_events/') && preview.fake.get(path).type === 'knock').length;
  return { ...preview, knocks, mode: 'memory' };
}

async function signIn(page, base, user) {
  await page.goto(`${base}/crew/knock.html`);
  await page.getByLabel('Username', { exact: true }).fill(user);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const syncPill = page => page.locator('#knock-sync');
const address = page => page.locator('.house-card .address');

async function logDoor(page, outcome, finish = null) {
  const before = await address(page).textContent();
  await page.getByRole('button', { name: outcome, exact: true }).click();
  if (finish) await finish();
  await page.waitForFunction(previous => document.querySelector('.house-card .address')?.textContent !== previous, before);
  return before;
}

const server = await startServer();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Denver', serviceWorkers: 'allow' };
const errors = [];
try {
  const repContext = await browser.newContext(phone);
  await repContext.clock.install({ time: T0 });
  const page = await repContext.newPage();
  page.on('pageerror', error => errors.push(String(error)));

  // 1. Sign in as a rep and start a shift (with signal).
  await signIn(page, server.base, 'Rep.One');
  await page.getByRole('button', { name: 'Start shift', exact: true }).click();
  await page.getByRole('button', { name: 'No answer', exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById('knock-sync')?.textContent === 'Synced');
  // The crew service worker takes over the page so it can reload with no signal.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByRole('button', { name: 'No answer', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'the crew service worker controls the knock page');

  // 2. Lose signal and log five doors.
  await repContext.setOffline(true);
  const logged = [];
  logged.push(await logDoor(page, 'No answer'));
  logged.push(await logDoor(page, 'Not interested'));
  await page.reload();
  await page.getByRole('button', { name: 'Come back', exact: true }).waitFor();
  assert.match(await syncPill(page).textContent(), /2 to sync/, 'the first two doors survived an offline reload');
  logged.push(await logDoor(page, 'Come back', () => page.getByRole('button', { name: 'No set time', exact: true }).click()));
  logged.push(await logDoor(page, 'Look', async () => {
    await page.getByLabel('Quoted price').fill('1500');
    await page.getByRole('button', { name: 'Save look', exact: true }).click();
  }));
  logged.push(await logDoor(page, 'No answer'));
  await page.waitForFunction(() => /5 to sync/.test(document.getElementById('knock-sync')?.textContent || ''));
  assert.equal(await server.knocks(), 0, 'nothing reached the server while offline');
  assert.equal(new Set(logged).size, 5, 'five different houses');

  // 3. Signal returns: the phone syncs on its own.
  await repContext.setOffline(false);
  await page.waitForFunction(() => document.getElementById('knock-sync')?.textContent === 'Synced', null, { timeout: 30000 });
  assert.equal(await server.knocks(), 5, 'all five doors reached the server');

  // 4. The admin sees them: coverage counts five knocked houses with the rep there now.
  const adminContext = await browser.newContext({ ...phone, serviceWorkers: 'block' });
  await adminContext.clock.install({ time: T0 + (Date.now() - startedAt) });
  const admin = await adminContext.newPage();
  admin.on('pageerror', error => errors.push(String(error)));
  await signIn(admin, server.base, 'ZacB');
  await admin.waitForFunction(() => document.querySelector('#knock-tabs a[href="#admin"]'));
  await admin.goto(`${server.base}/crew/knock.html#admin?s=coverage`);
  const row = admin.locator('table.data tbody tr', { hasText: 'English Ranch' }).first();
  await row.waitFor();
  const cells = await row.locator('td').allTextContents();
  assert.equal(cells[1], '5/48', `coverage shows the five doors (${cells.join(' | ')})`);
  assert.equal(cells[6], 'Rep One', 'the rep shows as here now');
  await admin.goto(`${server.base}/crew/knock.html#admin?s=scoreboard&range=today`);
  await admin.getByText('Team total').waitFor();
  const doors = await admin.locator('.stats .stat', { hasText: 'Doors' }).locator('b').textContent();
  assert.equal(doors, '5', 'the scoreboard counts the five doors today');

  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(server.serverErrors, [], 'no server errors');
  console.log(`knock browser smoke test passed (${server.mode} Firestore): 5 offline doors synced and visible to the admin.`);
} finally {
  await browser.close();
  await server.close();
}
