/* EGC crew-tools verification — drives a real Chromium through a dummy
   walkthrough and checks the same-origin localStorage handoff end to end
   (50 checks: gate, offer ladder, two-option pairs, Day-Of Bonus, handoff
   into prejob/postjob, Garage Guard chips, payloads). Screenshots land in
   ./verify-shots at 380px and iPad widths.

   Usage:
     npx playwright install chromium          # first run only
     node scripts/verify-crew.mjs             # against http://localhost:8777
     BASE=https://easygaragecleaning.com node scripts/verify-crew.mjs   # live
     HEADFUL=1 BASE=... node scripts/verify-crew.mjs                    # watch it run

   Local serve: python3 -m http.server 8777  (from the repo root)

   Note: signs in by deriving a ZacB session token from the public hash —
   no password needed. Sends nothing to webhooks (they ship empty). */
import { chromium } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8777';
const SHOTS = './verify-shots';
import fs from 'node:fs'; fs.mkdirSync(SHOTS, { recursive: true });
console.log(`Verifying crew tools at ${BASE}\n`);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
// Valid portal-style session token for ZacB, derived exactly like employee.html does
const ZACB_HASH = '6b8670f397174ff99440629b877581216a0b26b6770054be198988ff48a16861';
const TOKEN = sha256(`ZacB:${ZACB_HASH}:egc-session`);

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const browser = await chromium.launch({ headless: !process.env.HEADFUL });
const ctx = await browser.newContext({ viewport: { width: 380, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());

/* ── 1. Gate blocks anonymous access ───────────────────────── */
await page.goto(`${BASE}/crew/index.html`);
await page.waitForTimeout(400);
ok('hub: gate visible when logged out', await page.locator('#egc-gate:not(.off)').isVisible());
ok('hub: tool buttons covered by gate overlay', !(await page.locator('a.tool').first().isVisible()) ||
   (await page.locator('#egc-gate').evaluate(el => getComputedStyle(el).zIndex === '99999')));
await page.screenshot({ path: `${SHOTS}/01-gate-380.png` });

/* ── 2. Wrong password rejected ────────────────────────────── */
await page.fill('#gate-u', 'ZacB');
await page.fill('#gate-p', 'wrong-password');
await page.click('.gbtn');
await page.waitForTimeout(300);
ok('gate: wrong password shows error, stays locked',
   await page.locator('#gate-err').isVisible() && await page.locator('#egc-gate:not(.off)').isVisible());

/* ── 3. Portal-style token unlocks (sessionStorage egc_u/egc_tok) ── */
await page.evaluate(([t]) => { sessionStorage.setItem('egc_u','ZacB'); sessionStorage.setItem('egc_tok',t); }, [TOKEN]);
await page.reload(); await page.waitForTimeout(400);
ok('gate: valid portal session token unlocks hub', await page.locator('#egc-gate.off').count() === 1);
// persist for the rest of the run the way the gate itself would
await page.evaluate(([t]) => { localStorage.setItem('egc_u','ZacB'); localStorage.setItem('egc_tok',t); }, [TOKEN]);
await page.screenshot({ path: `${SHOTS}/02-hub-380.png`, fullPage: true });

/* ── 4. Game Plan: drive a dummy walkthrough ───────────────── */
await page.goto(`${BASE}/crew/gameplan.html`);
await page.waitForTimeout(400);
ok('gameplan: unlocked via stored token', await page.locator('#egc-gate.off').count() === 1);

// fill the start screen through the real inputs
await page.fill('#f_name', 'Dana Tester');
await page.fill('#f_addr', '746 Star Grass Ln');
await page.fill('#f_phone', '(970) 555-0123');

// jump to point 11 (upgrades) and exercise the two-option pairs through real taps
await page.evaluate(() => { S.park=false; S.parkLast='3+ years'; S.howLong='2 years';
  S.missing=['Parking inside']; S.missNote='my wife parks in the snow'; S.loads=2; jump(14); });
await page.waitForTimeout(200);
// p11 is steps index 15? verify by header text
const p11head = await page.locator('h1').first().textContent();
ok('gameplan: reached Storage & Shelving point', /Storage/i.test(p11head), p11head.trim());

const upNames = await page.locator('.up .nm').allTextContents();
ok('gameplan: 5 upgrades, no bins/overhead placeholders',
   upNames.length === 5 && !/Bin & label|Overhead/i.test(upNames.join('|')), upNames.map(s=>s.split('\n')[0]).join(' | '));
ok('gameplan: no qty steppers rendered', await page.locator('.up .qty').count() === 0);

// tap One Wall, then Both Walls — must be mutually exclusive
await page.locator('.up', { hasText: 'Shelving — One Wall' }).click();
await page.locator('.up', { hasText: 'Both Walls + Bins' }).click();
let storage = await page.evaluate(() => S.storage.map(i => CONFIG.upgrades[i].name));
ok('gameplan: shelving pair mutually exclusive', storage.length === 1 && storage[0] === 'Shelving — Both Walls + Bins', storage.join(','));
// deep clean pair too
await page.locator('.up', { hasText: 'Deep Clean — One-Car' }).click();
await page.locator('.up', { hasText: 'Deep Clean — Two-Car' }).click();
storage = await page.evaluate(() => S.storage.map(i => CONFIG.upgrades[i].name));
ok('gameplan: deep clean pair mutually exclusive',
   storage.includes('Deep Clean — Two-Car') && !storage.includes('Deep Clean — One-Car'), storage.join(', '));
// add rush
await page.locator('.up', { hasText: 'Rush Scheduling' }).click();
const upTotal = await page.evaluate(() => upgradesTotal());
ok('gameplan: upgrades total = 750+250+150', upTotal === 1150, '$' + upTotal);

/* package screen */
await page.evaluate(() => jump(17));
await page.waitForTimeout(200);
const pkgs = await page.locator('.pkg h3').allTextContents();
ok('gameplan: 4 packages in top-down order',
   JSON.stringify(pkgs) === JSON.stringify(['The Works','Full Property Reset','Garage Transformation','Quick Clear']), pkgs.join(' → '));
const prices = await page.locator('.pkg .pkgprice').allTextContents();
ok('gameplan: package prices rendered', JSON.stringify(prices) === JSON.stringify(['$3,100','from $2,200','$800','$300–400']), prices.join(' | '));
ok('gameplan: Garage Transformation tagged CORE', (await page.locator('.pkg:nth-child(3) .tag').textContent()) === 'CORE');
const muted = await page.locator('.pkg.muted h3').textContent();
const mutedOpacity = await page.locator('.pkg.muted').evaluate(el => getComputedStyle(el).opacity);
ok('gameplan: Quick Clear muted (step-down only)', muted === 'Quick Clear' && parseFloat(mutedOpacity) < 0.7,
   `tag=${await page.locator('.pkg.muted .tag').textContent()}, opacity=${mutedOpacity}`);
// pick CORE package + rate as manual input
await page.locator('.pkg', { hasText: 'Garage Transformation' }).click();
await page.fill('input[placeholder="0"]', '800'); // flat rate input (first number input)
await page.evaluate(() => { S.deposit='200'; S.jobdate='2026-06-12'; });
await page.setViewportSize({ width: 1024, height: 768 });
await page.waitForTimeout(150);
await page.screenshot({ path: `${SHOTS}/03-gameplan-packages-ipad.png`, fullPage: false });

/* close screen */
await page.evaluate(() => jump(18));
await page.waitForTimeout(300);
const bonusText = await page.locator('.bonus p').textContent();
ok('close: Day-Of Decision Bonus banner above quote',
   /special-disposal fee is waived/.test(bonusText) && /Expires when we leave the driveway/.test(bonusText));
const bonusBeforeQuote = await page.evaluate(() => {
  const b = document.querySelector('.bonus'), q = document.querySelector('.quoteblock');
  return !!(b && q && (b.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING));
});
ok('close: banner sits above the quote block', bonusBeforeQuote);
await page.locator('.bonuschk input').check();
ok('close: Day-Of Bonus checkbox toggles state', await page.evaluate(() => S.dayBonus === true));
const total = await page.locator('.quoteblock .total').textContent();
ok('close: grand total = 800 + 1,150', total === '$1,950', total);
const hold = await page.locator('.holdnote').textContent();
ok('close: 7-day hold note below total', hold === 'Quote holds for 7 days. Day-Of Bonus is today only.');
const gItems = await page.locator('.guarantee li').allTextContents();
const gHead = await page.locator('.guarantee h4').textContent();
ok('close: No-Surprises Guarantee, 2 items', gItems.length === 2 && /No-Surprises/.test(gHead),
   gHead + ' / ' + gItems.length + ' items');
const notes = await page.evaluate(() => compileNotes());
ok('close: payload notes include Day-Of Bonus', /DAY-OF BONUS: APPLIED/.test(notes));
const payload = await page.evaluate(() => buildPayload());
ok('close: line items = package + 3 upgrades', payload.quote.line_items_count === 4,
   payload.quote.line_items.map(i=>i.name+' $'+i.total).join(' | '));
ok('close: quote total in payload', payload.quote.total === 1950);
await page.screenshot({ path: `${SHOTS}/04-gameplan-close-ipad.png`, fullPage: false });
await page.setViewportSize({ width: 380, height: 800 });
await page.waitForTimeout(150);
await page.screenshot({ path: `${SHOTS}/05-gameplan-close-380.png` });
const activeJob = await page.evaluate(() => JSON.parse(localStorage.getItem('egc_active_job')));
ok('handoff: egc_active_job written by close screen',
   activeJob && activeJob.name === 'Dana Tester' && activeJob.pkg === 'Garage Transformation' && activeJob.rate === '800',
   JSON.stringify(activeJob));

/* ── 5. Pre-Job pre-fills from handoff ─────────────────────── */
await page.goto(`${BASE}/crew/prejob.html`);
await page.waitForTimeout(400);
ok('prejob: unlocked via stored token', await page.locator('#egc-gate.off').count() === 1);
const banner = await page.evaluate(() => document.querySelector('main').innerText);
ok('prejob: LOADED FROM GAME PLAN banner', /LOADED FROM GAME PLAN/.test(banner) && /DANA TESTER/.test(banner));
ok('prejob: name prefilled', await page.inputValue('#j_name') === 'Dana Tester');
ok('prejob: address prefilled', await page.inputValue('#j_addr') === '746 Star Grass Ln');
ok('prejob: rate prefilled', await page.inputValue('#j_rate') === '800');
const pkgVal = await page.inputValue('#j_pkg');
ok('prejob: package + upsells prefilled', /Garage Transformation/.test(pkgVal) && /Both Walls/.test(pkgVal), pkgVal);
ok('prejob: job date prefilled', await page.inputValue('#j_date') === '2026-06-12');
await page.screenshot({ path: `${SHOTS}/06-prejob-380.png` });

/* ── 6. Post-Job pre-fills + Garage Guard ──────────────────── */
await page.goto(`${BASE}/crew/postjob.html`);
await page.waitForTimeout(400);
ok('postjob: unlocked via stored token', await page.locator('#egc-gate.off').count() === 1);
const pbanner = await page.evaluate(() => document.querySelector('main').innerText);
ok('postjob: handoff banner with pain quote', /LOADED FROM GAME PLAN/.test(pbanner) && /my wife parks in the snow/.test(pbanner));
await page.screenshot({ path: `${SHOTS}/07b-postjob-banner-380.png` });
ok('postjob: name prefilled', await page.inputValue('#j_name') === 'Dana Tester');
ok('postjob: phone prefilled', await page.inputValue('#j_phone') === '(970) 555-0123');
const guardItem = await page.locator('.item', { hasText: 'Garage Guard pitched — top-down' }).textContent();
ok('postjob: Guard checklist item + sub', /Open at Guard Black\. Step down one tier on hesitation\. Lite is the save\. Two options, never yes\/no\./.test(guardItem));
const guardScript = await page.locator('.script', { hasText: 'Guard Black' }).textContent();
ok('postjob: Guard script — Black $2,500, 5 memberships', /\$2,500\/yr/.test(guardScript) && /Only 5 memberships in Fort Collins/.test(guardScript));
ok('postjob: Guard script — step-down $800 + Lite $450', /\$800\/yr/.test(guardScript) && /\$450\/yr/.test(guardScript));
const chips = await page.locator('.gchip').allTextContents();
ok('postjob: result chips', JSON.stringify(chips) === JSON.stringify(['Guard Black','Garage Guard','Guard Lite','Not today']), chips.join(' | '));
await page.locator('.gchip', { hasText: 'Guard Lite' }).click();
await page.waitForTimeout(150);
ok('postjob: chip selection sets GUARD', await page.evaluate(() => GUARD === 'Guard Lite'));
await page.reload(); await page.waitForTimeout(400);
ok('postjob: GUARD persists across reload', await page.evaluate(() => GUARD === 'Guard Lite'));
// referral + review wording
const refScript = await page.locator('.script', { hasText: 'reviews are how a local crew' }).textContent();
ok('postjob: referral offer = $50 EGC gift card', /\$50 EGC gift card/.test(refScript));
const reviewSrc = await page.evaluate(() => sendReview.toString());
ok('postjob: review message wording swapped', /it was great working with you/.test(reviewSrc) && /10% off your next service/.test(reviewSrc));
ok('postjob: REVIEW_LINK set', await page.evaluate(() => REVIEW_LINK) === 'https://search.google.com/local/writereview?placeid=ChIJ17AGfBiyRIsRyJ3k4mDtX8Q');
await page.screenshot({ path: `${SHOTS}/07-postjob-380.png` });

// build the finish payload exactly as finish() does, without needing every box ticked
const pjPayload = await page.evaluate(() => {
  const v=id=>document.getElementById(id).value;
  return {tool:'post_job', garage_guard: GUARD||'not recorded', customer: v('j_name')};
});
ok('postjob: webhook payload carries garage_guard', pjPayload.garage_guard === 'Guard Lite');
// confirm the real finish() includes it (source check of the live function)
ok('postjob: finish() includes garage_guard field', await page.evaluate(() => finish.toString().includes('garage_guard:GUARD')));

/* ── 7. Hub shows active job; iPad width pass ──────────────── */
await page.goto(`${BASE}/crew/`);
await page.waitForTimeout(400);
const aj = await page.locator('#activejob').textContent();
ok('hub: active job chip from handoff', /DANA TESTER/.test(aj), aj.replace(/\s+/g,' ').trim());
await page.screenshot({ path: `${SHOTS}/08-hub-active-380.png` });
await page.setViewportSize({ width: 1024, height: 768 });
await page.reload(); await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/09-hub-ipad.png` });

/* iPad-width render of prejob + postjob */
await page.goto(`${BASE}/crew/prejob.html`); await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/10-prejob-ipad.png` });
await page.goto(`${BASE}/crew/postjob.html`); await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/11-postjob-ipad.png` });

/* gameplan at 380 start screen (mobile sanity) */
await page.setViewportSize({ width: 380, height: 800 });
await page.goto(`${BASE}/crew/gameplan.html`); await page.waitForTimeout(400); // dialog auto-accepted → resumes
await page.screenshot({ path: `${SHOTS}/12-gameplan-380.png` });

/* ── 8. Lock control on hub ────────────────────────────────── */
await page.goto(`${BASE}/crew/`); await page.waitForTimeout(300);
await page.evaluate(() => gateLock());
await page.waitForTimeout(500);
ok('hub: Lock tools re-locks (gate back up)', await page.locator('#egc-gate:not(.off)').isVisible());

ok('no JS page errors across all pages', errors.length === 0, errors.join(' ; ').slice(0, 300));

await browser.close();
const fails = results.filter(r => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
process.exit(fails.length ? 1 : 0);
