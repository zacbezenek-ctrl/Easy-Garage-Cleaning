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
const address = page => page.locator('.house .house__addr');

async function logDoor(page, outcome, finish = null) {
  const before = await address(page).textContent();
  await page.getByRole('button', { name: outcome, exact: true }).click();
  if (finish) await finish();
  await page.waitForFunction(previous => document.querySelector('.house .house__addr')?.textContent !== previous, before);
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
  assert.match(await syncPill(page).textContent(), /2 waiting/, 'the first two doors survived an offline reload');
  logged.push(await logDoor(page, 'Come back', async () => {
    await page.getByRole('button', { name: 'Tomorrow', exact: false }).click();
    await page.getByLabel('Note').fill('Ask for the owner');
    await page.getByRole('button', { name: 'Save come-back', exact: true }).click();
  }));
  logged.push(await logDoor(page, 'Look', async () => {
    await page.getByLabel('Quoted price').fill('1500');
    await page.getByRole('button', { name: 'Save look', exact: true }).click();
  }));
  logged.push(await logDoor(page, 'No answer'));
  await page.waitForFunction(() => /5 waiting/.test(document.getElementById('knock-sync')?.textContent || ''));
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
  const meter = admin.locator('.meter', { hasText: 'English Ranch' }).first();
  await meter.waitFor();
  const coverageText = await meter.textContent();
  assert.match(coverageText, /5 \/ 48/, `coverage shows the five doors (${coverageText})`);
  const knockingNow = await admin.locator('section.card', { hasText: 'Knocking right now' }).textContent();
  assert.match(knockingNow, /Rep One/, 'the rep shows as knocking right now');
  await admin.goto(`${server.base}/crew/knock.html#admin?s=scoreboard&range=today`);
  await admin.getByText('Team total').waitFor();
  const doors = await admin.locator('.stat', { has: admin.locator('.stat__label', { hasText: /^Doors$/ }) }).first().locator('.stat__value').textContent();
  assert.equal(doors, '5', 'the scoreboard counts the five doors today');
  await admin.getByText('D2D benchmarks are unconfigured.', { exact: false }).waitFor();
  assert.equal(await admin.getByRole('heading', { name: 'Go / Fix / Stop', exact: true }).count(), 0, 'unapproved D2D benchmarks never produce a verdict');

  // 5. Money remains a distinct, fail-closed view at narrow phone/tablet widths.
  await page.goto(`${server.base}/crew/knock.html#money`);
  await page.getByText('Projected commission', { exact: true }).waitFor();
  for (const label of ['Earned commission', 'Customer collected', 'Payable commission', 'Commission paid (recorded)']) {
    await page.getByText(label, { exact: true }).waitFor();
  }
  assert.match(await page.locator('#knock-main').textContent(), /Compensation is unconfigured/);
  assert.match(await page.locator('#knock-main').textContent(), /settlement unverified/);
  assert.match(await page.locator('#knock-main').textContent(), /no junk-removal commission/);
  assert.match(await page.locator('#knock-main').textContent(), /Payroll anchor unconfigured/);
  assert.match(await page.locator('#knock-main').textContent(), /payouts every two weeks/);
  await page.getByRole('heading', { name: 'Walkthrough setting — 13%', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Book a walkthrough in the Hub', exact: true }).getAttribute('href'), '/employee.html?view=walkthroughs');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `money screen fits ${width}px`);
  }
  assert.equal(await page.locator('#knock-tabs a[href="#admin"]').count(), 0, 'rep has no admin tab');
  await admin.goto(`${server.base}/crew/knock.html#admin?s=money`);
  await admin.getByText('Rep payments recorded', { exact: true }).waitFor();
  assert.match(await admin.locator('#knock-main').textContent(), /Compensation unconfigured/);

  // An admin's record of a past payment is not payroll/bank settlement.
  const recorded = await admin.evaluate(async () => {
    const report = await (await fetch('/api/knock-admin?view=money')).json();
    return (await fetch('/api/knock-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'payout.add', requestId: crypto.randomUUID(), repKey: 'rep.one',
        periodKey: report.period.key, amount: 77, note: 'Synthetic recorded payment only' }) })).json();
  });
  assert.equal(recorded.ok, true);
  await page.reload();
  const payment = page.locator('.stat').filter({ has: page.getByText('Commission paid (recorded)', { exact: true }) });
  await payment.getByText('$77.00', { exact: true }).waitFor();
  assert.match(await payment.textContent(), /admin recorded; settlement unverified/);
  await admin.goto(`${server.base}/crew/knock.html#admin?s=setters`);
  await admin.getByRole('heading', { name: 'Record walkthrough setter', exact: true }).waitFor();
  assert.match(await admin.locator('#knock-main').textContent(), /booking or no-show earns nothing/);

  // 6. Help states the same earning rule as My money, and only the owner approves the terms.
  await page.goto(`${server.base}/crew/knock.html#money`);
  await page.getByText('How commission works', { exact: true }).waitFor();
  const moneyText = await page.locator('#knock-main').textContent();
  await page.goto(`${server.base}/crew/knock.html#more`);
  await page.getByRole('button', { name: /Help & the rules/ }).click();
  const help = page.locator('dialog.sheet[aria-label="Help & the rules"]');
  await help.getByText('Walkthrough you set', { exact: true }).waitFor();
  const helpText = await help.textContent();
  const rule = /Not approved yet: nothing is earned or payable until the owner approves the terms[^]*?held for review\./.exec(helpText)?.[0];
  assert.ok(rule && moneyText.includes(rule), 'Help and My money state one commission rule');
  assert.match(helpText, /a deposit alone does not count/);
  assert.doesNotMatch(helpText, /cancellation deadline/);
  assert.match(helpText, /13% to you when a walkthrough you set closes/);
  await help.getByRole('button', { name: 'Close', exact: true }).click();
  await admin.goto(`${server.base}/crew/knock.html#admin?s=settings`);
  await admin.getByRole('heading', { name: 'Approve commission terms', exact: true }).waitFor();
  await admin.getByText('Commission terms are not approved').waitFor();
  await admin.getByText('Save the settings first').waitFor();
  await admin.getByRole('button', { name: 'Save settings', exact: true }).first().click();
  await admin.getByText('Settings saved', { exact: false }).waitFor();
  await admin.goto(`${server.base}/crew/knock.html#admin?s=coverage`);
  await admin.goto(`${server.base}/crew/knock.html#admin?s=settings`);
  const approveButton = admin.getByRole('button', { name: 'Approve commission terms', exact: true });
  await approveButton.waitFor();
  await admin.getByRole('group', { name: 'How Garage Transformation is paid' }).getByRole('button', { name: 'Garage only', exact: true }).click();
  await admin.getByLabel('Approval reference', { exact: true }).fill('synthetic-browser-approval');
  await admin.getByLabel(/The two-week pay cycle starts/).check();
  await approveButton.click();
  const confirm = admin.locator('dialog.sheet[aria-label="Approve these commission terms?"]');
  assert.match(await confirm.textContent(), /Garage only: Garage Transformation\. Held for review: The Works, Full Property Reset, Quick Clear\./);
  await confirm.getByRole('button', { name: 'Approve terms', exact: true }).click();
  await admin.locator('.banner', { hasText: 'Commission terms approved' }).waitFor();
  assert.match(await admin.locator('#knock-main').textContent(), /reference synthetic-browser-approval/);

  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(server.serverErrors, [], 'no server errors');
  console.log(`knock browser smoke test passed (${server.mode} Firestore): 5 offline doors synced and visible to the admin.`);
} finally {
  await browser.close();
  await server.close();
}
