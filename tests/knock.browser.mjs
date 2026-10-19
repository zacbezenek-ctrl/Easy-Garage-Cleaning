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
let bridge = null;
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
  // D2D: with no signal, More → Crew home reaches the crew offline page, which leads straight back to Knock (cached whole).
  // (setOffline does not reach the service worker's own requests here, so the crew home's request is failed by hand.)
  const crewHome = /\/crew\/$/, noSignal = route => route.abort('internetdisconnected');
  await repContext.route(crewHome, noSignal);
  await page.evaluate(() => { location.hash = '#more'; });
  await page.getByRole('link', { name: /^Crew home/ }).click();
  await page.getByRole('heading', { name: 'You are offline', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/crew/');
  await page.getByRole('link', { name: 'Open EGC Knock', exact: true }).click();
  await page.waitForURL(/\/crew\/knock(?:#|$)/);
  await page.waitForFunction(() => /5 waiting/.test(document.getElementById('knock-sync')?.textContent || ''));
  await repContext.unroute(crewHome, noSignal);

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
  // D2D (owner, 2026-10-19): My money never sends a rep out of Knock to the Hub (that link landed on Hub onboarding).
  assert.equal(await page.getByRole('link', { name: 'Book a walkthrough in the Hub', exact: true }).count(), 0, 'My money never sends a rep out to the Hub');
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
  // The screen is read in one step once the rule itself is on it: a background sync re-draws the screen (and loads it
  // again), so a heading seen a moment earlier does not mean the text read next is the loaded screen.
  await page.goto(`${server.base}/crew/knock.html#money`);
  const moneyText = await (await page.waitForFunction(() => {
    const text = document.querySelector('#knock-main')?.textContent || '';
    return /How commission works/.test(text) && /Not approved yet: nothing is earned[^]*?held for review\./.test(text) ? text : false;
  })).jsonValue();
  await page.goto(`${server.base}/crew/knock.html#more`);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole('button', { name: /Help & the rules/ }).click();
  const help = page.locator('dialog.sheet[aria-label="Help & the rules"]');
  await help.getByText('Walkthrough you set', { exact: true }).waitFor();
  const helpText = await help.textContent();
  // On a 320px phone the two long rules read as paragraphs under their labels, not a bold right-hand column.
  assert.deepEqual(await help.locator('.kv > p').evaluateAll(rules => rules.map(rule => [getComputedStyle(rule).textAlign, rule.getBoundingClientRect().width > 200])),
    [['start', true], ['start', true]]);
  const rule = /Not approved yet: nothing is earned or payable until the owner approves the terms[^]*?held for review\./.exec(helpText)?.[0];
  assert.ok(rule && moneyText.includes(rule), 'Help and My money state one commission rule');
  assert.match(helpText, /a deposit alone does not count/);
  assert.doesNotMatch(helpText, /cancellation deadline/);
  assert.match(helpText, /13% to you when a walkthrough you set closes/);
  await help.getByRole('button', { name: 'Close', exact: true }).click();
  // D2D: at the clean URL the installed app opens (/crew/knock), More links back to the crew home, and the EGC Knock
  // wordmark (the page's own, then the one drawn after a titled screen) goes Home without loading Knock again.
  await page.goto(`${server.base}/crew/knock#more`);
  assert.equal(await page.getByRole('link', { name: /^Crew home/ }).getAttribute('href'), '/crew/');
  await page.evaluate(() => { window.syntheticSameKnockPage = true; });
  for (const titled of [null, '#money']) {
    if (titled) {
      await page.evaluate(hash => { location.hash = hash; }, titled);
      await page.locator('#knock-top a.wordmark').waitFor({ state: 'detached' });
      await page.evaluate(() => { location.hash = '#more'; });
    }
    await page.locator('#knock-top a.wordmark').click();
    await page.waitForFunction(() => location.hash === '#home');
    assert.equal(await page.evaluate(() => window.syntheticSameKnockPage), true, `the wordmark never reloads Knock${titled ? ' (after a titled screen)' : ''}`);
    assert.equal(new URL(page.url()).pathname, '/crew/knock');
  }
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
  // A background sync finishing while the owner fills the form never rebuilds the admin screen under them.
  const synced = admin.evaluate(() => new Promise(resolve => {
    const pill = document.getElementById('knock-sync'), seen = new MutationObserver(() => { if (pill.textContent === 'Synced') { seen.disconnect(); resolve(); } });
    seen.observe(pill, { childList: true, characterData: true, subtree: true });
    dispatchEvent(new Event('online'));
  }));
  await synced;
  assert.equal(await admin.getByLabel('Approval reference', { exact: true }).inputValue(), 'synthetic-browser-approval', 'a sync keeps the typed reference');
  assert.equal(await admin.getByLabel(/The two-week pay cycle starts/).isChecked(), true, 'a sync keeps the confirmation');
  await approveButton.click();
  const confirm = admin.locator('dialog.sheet[aria-label="Approve these commission terms?"]');
  assert.match(await confirm.textContent(), /Garage only: Garage Transformation\. Held for review: The Works, Full Property Reset, Quick Clear\./);
  await confirm.getByRole('button', { name: 'Approve terms', exact: true }).click();
  await admin.locator('.banner', { hasText: 'Commission terms approved' }).waitFor();
  assert.match(await admin.locator('#knock-main').textContent(), /reference synthetic-browser-approval/);
  // On a 320px phone every package choice fits and the page does not scroll sideways.
  await admin.setViewportSize({ width: 320, height: 720 });
  const clipped = await admin.locator('[role="group"][aria-label$=" is paid"] .seg__btn')
    .evaluateAll(buttons => buttons.filter(button => button.scrollWidth > button.clientWidth + 1).map(button => button.textContent));
  assert.deepEqual(clipped, [], 'package choices are not clipped at 320px');
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll at 320px');
  // Correcting only the reference keeps the approval time, so unsynced sales keep their terms.
  const approvedLine = await admin.locator('.banner', { hasText: 'Commission terms approved' }).textContent();
  await admin.getByLabel('Approval reference', { exact: true }).fill('synthetic-browser-approval-b');
  await admin.getByLabel(/The two-week pay cycle starts/).check();
  await admin.getByRole('button', { name: 'Update approval', exact: true }).click();
  const update = admin.locator('dialog.sheet[aria-label="Update the approved terms?"]');
  assert.match(await update.textContent(), /Only the reference changes\. The approval time stays/);
  await update.getByRole('button', { name: 'Update approval', exact: true }).click();
  await admin.getByText('Approval reference updated', { exact: false }).waitFor();
  const updatedLine = await admin.locator('.banner', { hasText: 'reference synthetic-browser-approval-b' }).textContent();
  assert.equal(updatedLine.replace('synthetic-browser-approval-b', 'synthetic-browser-approval'), approvedLine, 'same approver and approval time');
  // D6b: with the door-to-door terms approved, the owner approves the walkthrough-setting and estimator terms in their
  // own card (fixed 13% + 7%, never edited); Admin > Estimators then lists the estimator's 7% as approved.
  await admin.getByLabel('Setter terms reference', { exact: true }).fill('synthetic-browser-d6b');
  await admin.getByRole('button', { name: 'Approve walkthrough-setting and estimator terms', exact: true }).click();
  const setterConfirm = admin.locator('dialog.sheet[aria-label="Approve these terms?"]');
  assert.match(await setterConfirm.textContent(), /13% to the rep and 7% to the estimator of a walkthrough set at the door, 7% to the estimator of a walkthrough sold directly/);
  await setterConfirm.getByRole('button', { name: 'Approve terms', exact: true }).click();
  await admin.locator('.banner', { hasText: 'Walkthrough-setting and estimator terms approved' }).waitFor();
  assert.match(await admin.locator('#knock-main').textContent(), /reference synthetic-browser-d6b/);
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll at 320px');
  await admin.goto(`${server.base}/crew/knock.html#admin?s=estimators`);
  await admin.locator('.banner', { hasText: 'Estimator terms approved' }).waitFor();

  // 7. Territory map and GPS: a newly approved rep with nothing yet sees why the map is empty, picks
  //    the nearest open neighborhood (sorted by the phone's GPS), its houses download and drive the
  //    knock screen and the map's "nearest", and releasing it frees it again. Tiles are stubbed.
  const approved = await admin.evaluate(async () => (await fetch('/api/knock-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rep.update', repKey: 'rep.two', changes: { status: 'active', permitListed: true } }) })).json());
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  // Standing on English Ranch (taken by other reps): Ridgewood Hills is about 2.7 mi away, Harvest Park farther.
  const geoContext = await browser.newContext({ ...phone, serviceWorkers: 'block', geolocation: { latitude: 40.5556, longitude: -105.0362, accuracy: 12 }, permissions: ['geolocation'] });
  await geoContext.clock.install({ time: T0 + (Date.now() - startedAt) });
  await geoContext.route(/tile\.openstreetmap\.org/, route => route.fulfill({ status: 200, contentType: 'image/png', body: tile }));
  const geo = await geoContext.newPage();
  geo.on('pageerror', error => errors.push(String(error)));
  await signIn(geo, server.base, 'Rep.Two');
  await geo.getByText('No neighborhood yet', { exact: true }).waitFor();
  await geo.goto(`${server.base}/crew/knock.html#map`);
  await geo.locator('.leaflet-container').waitFor();
  const overlay = geo.locator('.map__empty');
  await overlay.getByText('No neighborhood yet', { exact: true }).waitFor();
  assert.equal(await geo.locator('.map__banner').count(), 0, 'location is allowed: no location banner');
  await overlay.getByRole('link', { name: 'Choose an area' }).click();
  await geo.getByRole('button', { name: 'Claim Ridgewood Hills', exact: true }).waitFor();
  await geo.waitForFunction(() => /mi away/.test(document.querySelector('[data-area]')?.textContent || ''));
  assert.deepEqual(await geo.locator('[data-area]').evaluateAll(rows => rows.map(row => row.dataset.area)), ['ridgewood-hills', 'harvest-park'], 'nearest open neighborhood first');
  assert.match(await geo.locator('[data-area="ridgewood-hills"]').textContent(), /2\.\d mi away · 24 houses/);
  assert.match(await geo.locator('#knock-main').textContent(), /Not shown: 1 taken by other reps/);
  assert.equal(/Rep One|Lead One/.test(await geo.locator('#knock-main').textContent()), false, 'other reps are never named');
  await geo.getByRole('button', { name: 'Claim Ridgewood Hills', exact: true }).click();
  const mine = geo.locator('[data-area="ridgewood-hills"]', { hasText: 'You picked' });
  await mine.getByText('Working', { exact: true }).waitFor();
  await geo.waitForFunction(() => document.getElementById('knock-sync')?.textContent === 'Synced');
  assert.match(await mine.textContent(), /24 houses/, 'the claimed neighborhood\'s houses downloaded');
  await geo.goto(`${server.base}/crew/knock.html#map`);
  await geo.locator('.leaflet-container').waitFor();
  await geo.waitForFunction(() => /Knock nearest · \d+ (Synthetic Ridge Dr|Sample Hill Ct) · [\d.]+ km/.test(document.querySelector('.map__nearest')?.textContent || ''));
  assert.equal(await geo.locator('.map__empty').count(), 0, 'nothing to explain once houses are on the phone');
  await geo.goto(`${server.base}/crew/knock.html#knock`);
  await geo.getByRole('button', { name: 'Start shift', exact: true }).click();
  await geo.getByRole('button', { name: 'No answer', exact: true }).waitFor();
  assert.match(await address(geo).textContent(), /Synthetic Ridge Dr|Sample Hill Ct/, 'the working area drives the suggested house');
  await geo.waitForFunction(() => document.getElementById('knock-sync')?.textContent === 'Synced');
  await geo.goto(`${server.base}/crew/knock.html#areas`);
  await geo.locator('[data-area="ridgewood-hills"]').getByRole('button', { name: 'Release', exact: true }).click();
  await geo.locator('dialog.sheet').getByRole('button', { name: 'Release', exact: true }).click();
  await geo.getByRole('button', { name: 'Claim Ridgewood Hills', exact: true }).waitFor();
  assert.equal(await geo.locator('[data-area="ridgewood-hills"]', { hasText: 'You picked' }).count(), 0, 'released');

  // Location refused: Home and the map say so and how to fix it; the map still opens on the territory.
  const deniedContext = await browser.newContext({ ...phone, serviceWorkers: 'block' });
  await deniedContext.clock.install({ time: T0 + (Date.now() - startedAt) });
  await deniedContext.route(/tile\.openstreetmap\.org/, route => route.fulfill({ status: 200, contentType: 'image/png', body: tile }));
  await deniedContext.addInitScript(() => {
    navigator.geolocation.watchPosition = (_ok, fail) => { setTimeout(() => fail({ code: 1, message: 'User denied Geolocation' }), 20); return 7; };
    navigator.geolocation.clearWatch = () => {};
  });
  const denied = await deniedContext.newPage();
  denied.on('pageerror', error => errors.push(String(error)));
  await signIn(denied, server.base, 'Lead.One');
  await denied.locator('.banner', { hasText: 'Location is off for EGC Knock' }).getByRole('button', { name: 'Try again', exact: true }).waitFor();
  await denied.goto(`${server.base}/crew/knock.html#map`);
  await denied.locator('.map__banner .banner', { hasText: 'Allow location for this site' }).waitFor();
  await denied.locator('.leaflet-container').waitFor();
  await denied.waitForFunction(() => document.querySelector('.map__nearest')?.textContent === 'Location is off · open Knock');
  // Without GPS the map opens fitted to the territory's houses (street level), not on the town at zoom 13.
  await denied.waitForFunction(() => document.querySelector('.leaflet-tile[src]'));
  const zoom = await denied.evaluate(() => Math.max(...[...document.querySelectorAll('.leaflet-tile[src]')].map(img => Number(new URL(img.src).pathname.split('/')[1]))));
  assert.ok(zoom >= 16, `the map opens on the territory (zoom ${zoom})`);
  assert.ok(await denied.locator('.leaflet-overlay-pane canvas, .map-pin').count() > 0, 'the houses are drawn');
  for (const width of [320, 390]) {
    await geo.setViewportSize({ width, height: 844 });
    assert.equal(await geo.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Choose area fits ${width}px`);
  }

  // 7b. D2D: an owner's Start in-home walkthrough logs the look on the phone, then opens the walkthrough in this tab
  //     (an installed app keeps its sign-in there; a new tab in Safari has none) with the door's address.
  await adminContext.route(/\/crew\/gameplan/, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic walkthrough</title><p>Synthetic walkthrough</p>' }));
  const knocksBefore = await server.knocks();
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto(`${server.base}/crew/knock#knock`);
  await admin.getByRole('button', { name: 'Start shift', exact: true }).click();
  await admin.getByRole('button', { name: 'Look', exact: true }).click();
  const start = admin.getByRole('link', { name: 'Start in-home walkthrough', exact: true });
  assert.equal(await start.getAttribute('target'), null, 'no new tab');
  assert.match(await start.getAttribute('href'), /^\/crew\/gameplan\?address=[^&]+&source=knock&houseId=/);
  await admin.getByLabel('Quoted price').fill('900');
  await start.click();
  await admin.waitForURL(/\/crew\/gameplan\?address=[^&]+&source=knock&houseId=/);
  assert.equal(adminContext.pages().length, 1, 'the walkthrough opened in the same tab');
  // The look reached the server before Knock was left (not the next time Knock opens on this phone).
  assert.equal(await server.knocks(), knocksBefore + 1, 'the look was sent before the walkthrough opened');
  // A look Knock refuses (here: the sun set while the sheet was open) is never left silently: the owner is told, stays in
  // Knock, and can still open the walkthrough.
  await admin.goto(`${server.base}/crew/knock#knock`);
  await admin.getByRole('button', { name: 'Look', exact: true }).click();
  await admin.getByLabel('Quoted price').fill('700');
  await admin.clock.setSystemTime(T0 + (Date.now() - startedAt) + 9 * 60 * 60 * 1000);
  await admin.getByRole('link', { name: 'Start in-home walkthrough', exact: true }).click();
  const refused = admin.locator('#knock-toast');
  await refused.filter({ hasText: /^Look not saved/ }).waitFor();
  assert.equal(new URL(admin.url()).pathname, '/crew/knock', 'Knock stays open');
  assert.equal(await server.knocks(), knocksBefore + 1, 'nothing more was logged');
  await refused.getByRole('button', { name: 'Open walkthrough', exact: true }).click();
  await admin.waitForURL(/\/crew\/gameplan\?address=[^&]+&source=knock&houseId=/);

  // 8. KNOCK-BRIDGE (EGC_KNOCK_JOB_BRIDGE on, its own preview): a door sale picks a crew slot and is booked into the
  //    Hub with that crew; "Walkthrough set" books the estimator; both show on My sales. Rep-safe slots only.
  bridge = await startPreview({ now: clock, bridge: true });
  const bridgeContext = await browser.newContext({ ...phone, serviceWorkers: 'block' });
  await bridgeContext.clock.install({ time: T0 + (Date.now() - startedAt) });
  const rep = await bridgeContext.newPage();
  rep.on('pageerror', error => errors.push(String(error)));
  await signIn(rep, bridge.base, 'Rep.One');
  await rep.getByRole('button', { name: 'Start shift', exact: true }).click();
  await rep.getByRole('button', { name: 'Walkthrough set, Estimator visit', exact: true }).waitFor();
  assert.equal(await rep.locator('.outcomes .oc').count(), 7, 'seven outcomes with the bridge on');
  const soldAt = await address(rep).textContent();
  await rep.getByRole('button', { name: 'Sold', exact: true }).click();
  const form = rep.locator('dialog.fullscreen[aria-label="New sale"]');
  await form.getByLabel('Name', { exact: true }).fill('Pat Synthetic');
  await form.getByLabel('Phone', { exact: true }).fill('(970) 555-0142');
  await form.getByLabel('Email', { exact: true }).fill('pat.synthetic@example.com');
  await form.getByLabel('ZIP', { exact: true }).fill('80528');
  assert.equal(await form.getByLabel('Town', { exact: true }).inputValue(), 'Fort Collins', 'the town comes from the neighborhood');
  await form.getByRole('button', { name: 'Quick Clear', exact: true }).click();
  await form.getByLabel('Price', { exact: true }).fill('1200');
  const firstSlot = form.locator('[data-slot-picker="sale-slot"] .chips button').first();
  await firstSlot.waitFor();
  assert.match(await firstSlot.textContent(), /^\d{1,2}:\d{2} (am|pm) · Crew 1$/, 'a crew slot names the crew, nobody on it');
  const slotText = await form.locator('[data-slot-picker="sale-slot"]').textContent();
  assert.doesNotMatch(slotText, /Andy|Bo |crew\.a1|crew_one/);
  for (const width of [320, 390]) {
    await rep.setViewportSize({ width, height: 844 });
    assert.equal(await rep.evaluate(() => document.querySelector('dialog.fullscreen').scrollWidth <= innerWidth), true, `the sale form fits ${width}px`);
  }
  await firstSlot.click();
  for (const box of await form.locator('label.check input[type="checkbox"]').all()) if (!(await box.getAttribute('id'))) await box.check();
  await form.getByRole('button', { name: /^Save sale/ }).click();
  await rep.waitForFunction(() => document.getElementById('knock-sync')?.textContent === 'Synced', null, { timeout: 30000 });
  await rep.goto(`${bridge.base}/crew/knock.html#mysales`);
  const booked = rep.locator('[data-booking="booked"]');
  await booked.waitFor({ timeout: 30000 });
  assert.match(await booked.textContent(), /Booked: Crew 1, \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2} (am|pm)/);
  const jobs = () => [...bridge.fake.documents.keys()].filter(path => path.startsWith('jobs/') && !path.includes('_egc_')).map(path => bridge.fake.get(path));
  const [saleJob] = jobs().filter(job => job.type === 'job');
  assert.deepEqual([saleJob.crewId, saleJob.source, saleJob.ghlTags], ['crew_one', 'door_to_door', ['egc-d2d-sale']], 'the Hub job has Crew 1 and its D2D attribution');
  assert.match(saleJob.address, /, Fort Collins, CO 80528$/);

  // Walkthrough set at the next house: the estimator's first name only, booked on Alex's schedule.
  await rep.goto(`${bridge.base}/crew/knock.html#knock`);
  await rep.waitForFunction(previous => document.querySelector('.house .house__addr')?.textContent && document.querySelector('.house .house__addr').textContent !== previous, soldAt);
  await rep.getByRole('button', { name: 'Walkthrough set, Estimator visit', exact: true }).click();
  const walk = rep.locator('dialog.fullscreen[aria-label="Set a walkthrough"]');
  await walk.getByLabel('Name', { exact: true }).fill('Lee Synthetic');
  await walk.getByLabel('Phone', { exact: true }).fill('970-555-0143');
  const hour = walk.locator('[data-slot-picker="walk-slot"] .chips button').first();
  await hour.waitFor();
  assert.match(await hour.textContent(), /^\d{1,2}:\d{2} (am|pm) · Alex$/, 'the estimator by first name only');
  await hour.click();
  await walk.getByRole('button', { name: 'Set walkthrough', exact: true }).click();
  await rep.waitForFunction(() => document.getElementById('knock-sync')?.textContent === 'Synced', null, { timeout: 30000 });
  await rep.goto(`${bridge.base}/crew/knock.html#mysales`);
  await rep.getByRole('heading', { name: 'Walkthroughs you set', exact: true }).waitFor({ timeout: 30000 });
  await rep.locator('[data-booking="booked"]', { hasText: 'Walkthrough booked:' }).waitFor({ timeout: 30000 });
  const [visit] = jobs().filter(job => job.type === 'walkthrough');
  assert.deepEqual([visit.assignedCrew, visit.ghlTags], [['est.alex'], ['egc-d2d-walkthrough']]);
  assert.equal(bridge.fake.get(`knock_setters/${[...bridge.fake.documents.keys()].find(path => path.startsWith('jobs/') && bridge.fake.get(path).type === 'walkthrough').slice(5)}`).setterKey, 'rep.one');
  // D2D: with the bridge on, My money offers setting a walkthrough at the door, in Knock, instead of a Hub link.
  await rep.goto(`${bridge.base}/crew/knock#money`);
  await rep.evaluate(() => { window.syntheticSameKnockPage = true; });
  await rep.getByRole('button', { name: 'Set a walkthrough at the door', exact: true }).click();
  await rep.waitForFunction(() => location.hash === '#knock');
  assert.equal(await rep.evaluate(() => window.syntheticSameKnockPage), true, 'My money stays in Knock');
  // The office cancels the sale in Knock admin: the confirmation says its Hub job goes too, and it does.
  const officeContext = await browser.newContext({ ...phone, serviceWorkers: 'block' });
  await officeContext.clock.install({ time: T0 + (Date.now() - startedAt) });
  const office = await officeContext.newPage();
  office.on('pageerror', error => errors.push(String(error)));
  await signIn(office, bridge.base, 'ZacB');
  await office.getByRole('button', { name: 'Start shift', exact: true }).waitFor();
  await office.goto(`${bridge.base}/crew/knock.html#admin?s=sales&f=all`);
  await office.getByRole('button', { name: 'Cancel sale…', exact: true }).waitFor();
  // The Hub job id (one long word) wraps: the admin sale card does not push a phone's page sideways.
  assert.equal(await office.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll on the admin sale card at 390px');
  await office.getByRole('button', { name: 'Cancel sale…', exact: true }).click();
  const cancelSheet = office.locator('dialog.sheet[aria-label="Cancel this sale?"]');
  assert.match(await cancelSheet.textContent(), /Its Hub job \(Crew 1, [^)]+\) is cancelled too, so no crew goes\./);
  await cancelSheet.getByRole('button', { name: 'Cancel sale', exact: true }).click();
  await office.getByText('Its Hub job was cancelled too.', { exact: true }).waitFor();
  assert.equal(bridge.fake.get(`jobs/${saleJob.id}`).status, 'cancelled', 'no crew is sent to a customer who cancelled');
  assert.equal(await office.locator('[data-office-walkthroughs]').count(), 0, 'every door walkthrough is in the Hub');
  assert.deepEqual(bridge.serverErrors, [], 'no bridge server errors');

  // 9. D2D: signing out in Crew home signs Knock out on that phone too. With no signal afterwards, Knock never opens as the
  //    rep who left (their area, houses and shift); it asks for signal, as on a phone that never signed in.
  const leaverContext = await browser.newContext({ ...phone, serviceWorkers: 'block' });
  await leaverContext.clock.install({ time: T0 + (Date.now() - startedAt) });
  const leaver = await leaverContext.newPage();
  leaver.on('pageerror', error => errors.push(String(error)));
  await signIn(leaver, server.base, 'Rep.One');
  await leaver.locator('#knock-tabs').waitFor({ state: 'visible' });
  await leaver.waitForFunction(() => JSON.parse(localStorage.getItem('egc-knock:viewer') || 'null')?.user === 'Rep.One');
  await leaver.goto(`${server.base}/crew/`);
  await leaver.waitForFunction(() => window.EGCHubAuth);
  await leaver.evaluate(() => window.EGCHubAuth.signOut({ explicit: true }));
  assert.equal(await leaver.evaluate(async () => (await fetch('/api/hub-auth', { cache: 'no-store' })).status), 401, 'the session ended');
  await leaverContext.route(/\/api\//, route => route.abort('internetdisconnected'));
  await leaver.goto(`${server.base}/crew/knock`);
  await leaver.getByText('No signal yet', { exact: true }).waitFor();
  const leftText = await leaver.locator('#knock-main').textContent();
  assert.equal(await leaver.getByRole('button', { name: 'Start shift', exact: true }).count(), 0, 'no shift controls for the rep who left');
  assert.doesNotMatch(leftText, /English Ranch|Rep One/, 'none of their territory');
  await leaverContext.close();

  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(server.serverErrors, [], 'no server errors');
  console.log(`knock browser smoke test passed (${server.mode} Firestore): 5 offline doors synced and visible to the admin; GPS map, Choose area claim and release work; a door sale and a door walkthrough were booked into the Hub.`);
} finally {
  await browser.close();
  if (bridge) await bridge.close();
  await server.close();
}
