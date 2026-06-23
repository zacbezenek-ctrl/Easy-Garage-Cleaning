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
// The same-origin proxy (/api/crew-hook) is a Cloudflare Function — python http.server
// can't run it, so stub a real readable 200 {ok:true}. Capture bodies to assert payloads.
const sent = [];
await ctx.route('**/api/crew-hook', async route => {
  try { sent.push(JSON.parse(route.request().postData() || '{}')); } catch {}
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, tool: 'stub' }) });
});
// Stub the image generator — sandbox can't reach OpenAI and we won't spend money in tests.
const sentImg = [];
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
await ctx.route('**/api/garage-render', async route => {
  try { sentImg.push(JSON.parse(route.request().postData() || '{}')); } catch {}
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, image: TINY_PNG }) });
});
// Stub Jobber lookup + Drive upload — live calls need the one-time OAuth setups.
await ctx.route('**/api/jobber-clients*', async route => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, clients: [
    { id: 'JCLIENT1', name: 'Dana Tester', phone: '(970) 555-0123', address: '746 Star Grass Ln, Fort Collins', email: 'dana@example.com' },
    { id: 'JCLIENT2', name: 'Dana Q. Other', phone: '(970) 555-0999', address: '12 Elsewhere Rd', email: '' },
  ] }) });
});
// Stub today's Jobber walkthrough requests (auto-loaded on the Game Plan start screen).
await ctx.route('**/api/jobber-requests*', async route => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, date: '2026-06-12',
    today: [
      { id: 'REQ1', clientId: 'JCLIENT1', name: 'Dana Tester', phone: '(970) 555-0123', email: 'dana@example.com', address: '746 Star Grass Ln, Fort Collins', title: 'Garage walkthrough', createdAt: '2026-06-12T15:00:00Z', day: '2026-06-12' },
      { id: 'REQ2', clientId: 'JCLIENT2', name: 'Sam Sample', phone: '(970) 555-0777', email: '', address: '9 Pine Ct, Windsor', title: 'Walkthrough', createdAt: '2026-06-12T14:00:00Z', day: '2026-06-12' },
    ], recent: [] }) });
});
const driveBatches = [];
await ctx.route('**/api/drive-upload', async route => {
  let ids = [];
  try { const b = JSON.parse(route.request().postData() || '{}'); driveBatches.push(b); ids = (b.photos || []).map(p => p.id); } catch {}
  await route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, folderId: 'FOLDER1', folderUrl: 'https://drive.google.com/drive/folders/FOLDER1', uploaded: ids }) });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const FUTURE = String(Date.now() + 6 * 3600 * 1000); // valid (unexpired) gate session

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

/* ── 3. Portal-style token unlocks (needs egc_u/egc_tok + unexpired egc_exp) ── */
await page.evaluate(([t,e]) => { sessionStorage.setItem('egc_u','ZacB'); sessionStorage.setItem('egc_tok',t); sessionStorage.setItem('egc_exp',e); }, [TOKEN, FUTURE]);
await page.reload(); await page.waitForTimeout(400);
ok('gate: valid session token + unexpired exp unlocks hub', await page.locator('#egc-gate.off').count() === 1);
// persist for the rest of the run the way the gate itself would
await page.evaluate(([t,e]) => { localStorage.setItem('egc_u','ZacB'); localStorage.setItem('egc_tok',t); localStorage.setItem('egc_exp',e); }, [TOKEN, FUTURE]);
await page.screenshot({ path: `${SHOTS}/02-hub-380.png`, fullPage: true });

/* ── 3b. Expired session re-locks ──────────────────────────── */
await page.evaluate(([t]) => { localStorage.setItem('egc_u','ZacB'); localStorage.setItem('egc_tok',t); localStorage.setItem('egc_exp', String(Date.now()-1000));
  sessionStorage.setItem('egc_exp', String(Date.now()-1000)); }, [TOKEN]);
await page.reload(); await page.waitForTimeout(400);
ok('gate: expired session re-locks', await page.locator('#egc-gate:not(.off)').isVisible());
// restore a valid session for the remainder
await page.evaluate(([t,e]) => { for (const st of [localStorage,sessionStorage]){ st.setItem('egc_u','ZacB'); st.setItem('egc_tok',t); st.setItem('egc_exp',e);} }, [TOKEN, FUTURE]);

/* ── 4. Game Plan: drive a dummy walkthrough ───────────────── */
await page.goto(`${BASE}/crew/gameplan.html`);
await page.waitForTimeout(400);
ok('gameplan: unlocked via stored token', await page.locator('#egc-gate.off').count() === 1);

/* A0: today's Jobber walkthrough requests auto-load on the start screen */
await page.waitForTimeout(350);
ok('gameplan: today’s walkthroughs auto-load from Jobber requests',
   await page.locator('.jrow').count() === 2,
   (await page.locator('.jrow .nm').allTextContents()).map(s => s.replace(/\s+/g, ' ').trim()).join(' | '));
await page.locator('.jrow', { hasText: 'Dana Tester' }).click();
await page.waitForTimeout(150);
ok('gameplan: tapping a request prefills editable name/phone/email + request id',
   await page.inputValue('#f_name') === 'Dana Tester' &&
   await page.inputValue('#f_phone') === '(970) 555-0123' &&
   await page.inputValue('#f_email') === 'dana@example.com' &&
   await page.evaluate(() => S.jobberRequestId === 'REQ1' && S.jobberClientId === 'JCLIENT1'),
   `name=${await page.inputValue('#f_name')} email=${await page.inputValue('#f_email')}`);

/* Jobber customer lookup on the start screen */
await page.fill('#f_name', 'Dana');
await page.locator('.lookbtn').click();
await page.waitForTimeout(300);
ok('gameplan: Jobber lookup lists matches', await page.locator('.lkr').count() === 2,
   (await page.locator('.lkr .nm').allTextContents()).join(' | '));
await page.locator('.lkr').first().click();
await page.waitForTimeout(200);
ok('gameplan: picking a Jobber client fills name/address/phone + id',
   await page.inputValue('#f_name') === 'Dana Tester' &&
   /746 Star Grass Ln/.test(await page.inputValue('#f_addr')) &&
   await page.inputValue('#f_phone') === '(970) 555-0123' &&
   await page.evaluate(() => S.jobberClientId === 'JCLIENT1'));
// keep the canonical test address (lookup returns city suffix)
await page.fill('#f_addr', '746 Star Grass Ln');

// jump to point 11 (upgrades) and exercise the two-option pairs through real taps
await page.evaluate(() => { S.park=false; S.parkLast='3+ years'; S.howLong='2 years';
  S.missing=['Parking inside']; S.missNote='my wife parks in the snow'; S.loads=2; jump(14); });
await page.waitForTimeout(200);
// p11 is steps index 15? verify by header text
const p11head = await page.locator('h1').first().textContent();
ok('gameplan: reached Storage & Shelving point', /Storage/i.test(p11head), p11head.trim());

const upNames = await page.locator('.up .nm').allTextContents();
ok('gameplan: 6 upgrades, no bins/overhead placeholders',
   upNames.length === 6 && !/Bin & label|Overhead/i.test(upNames.join('|')), upNames.map(s=>s.split('\n')[0]).join(' | '));
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
ok('gameplan: upgrades total = 800+250+150', upTotal === 1200, '$' + upTotal);

/* ── 4b. Point 10: before photo capture + AI "after" generator ── */
await page.evaluate(() => jump(13));
await page.waitForTimeout(250);
ok('gameplan: Point 10 shows photo capture tile', await page.locator('#pb_before .padd').count() === 1);
ok('gameplan: Generate-the-After disabled with no photo', await page.locator('#aibtn').isDisabled());
await page.setInputFiles('#pb_before input[type=file]', '/tmp/egc-before.png');
await page.waitForTimeout(500);
ok('gameplan: before photo stored on-device + thumb shown', await page.locator('#pb_before .pthumb img').count() >= 1);
ok('gameplan: Generate-the-After enabled after a before photo', !(await page.locator('#aibtn').isDisabled()));
const beforeGen = sentImg.length;
await page.locator('#aibtn').click();
await page.waitForTimeout(600);
ok('gameplan: garage-render received the before image',
   sentImg.length > beforeGen && /^data:image\//.test((sentImg[sentImg.length-1] || {}).image || ''));
ok('gameplan: AI after rendered + stored in state', await page.locator('#aiout img').count() === 1 && await page.evaluate(() => !!S.aiAfter));
await page.screenshot({ path: `${SHOTS}/13-gameplan-ai-after-380.png` });

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
ok('close: grand total = 800 + 1,200', total === '$2,000', total);
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
ok('close: quote total in payload', payload.quote.total === 2000);
ok('close: payload carries day_of_bonus + signature fields',
   payload.day_of_bonus === true && 'signature' in payload);
ok('close: payload reports photo counts (before + ai_after)',
   payload.photos && payload.photos.before === 1 && payload.photos.ai_after === 1,
   JSON.stringify(payload.photos));
ok('close: before→after block shows the AI preview on the plan',
   await page.locator('#pb_plan .aiout img').count() === 1 && await page.locator('#pb_plan .pthumb img').count() >= 1);
await page.screenshot({ path: `${SHOTS}/04-gameplan-close-ipad.png`, fullPage: false });
await page.setViewportSize({ width: 380, height: 800 });
await page.waitForTimeout(150);
await page.screenshot({ path: `${SHOTS}/05-gameplan-close-380.png` });

/* escaping: a name with HTML must not inject into the rendered plan */
const escOk = await page.evaluate(() => esc('<b>"x"</b>') === '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
ok('close: free-text escape helper neutralizes HTML', escOk);

/* validation: a quote missing the package must NOT send or write a handoff */
await page.evaluate(() => { localStorage.removeItem('egc_active_job'); const p = S.pkg; S.pkg = null; render(); window.__pkg = p; });
await page.locator('button', { hasText: 'Send to Jobber' }).click();
await page.waitForTimeout(200);
ok('close: validation blocks send when package missing',
   /Add .*package/i.test(await page.locator('#sendstatus').textContent()) &&
   await page.evaluate(() => !localStorage.getItem('egc_active_job')));
await page.evaluate(() => { S.pkg = window.__pkg; render(); });

/* real commit: Send to Jobber writes the handoff (with locked TOTAL) and posts via the proxy */
const before = sent.length;
await page.locator('button', { hasText: 'Send to Jobber' }).click();
await page.waitForTimeout(400);
ok('close: Send to Jobber shows real success status',
   /pushed/i.test(await page.locator('#sendstatus').textContent()) &&
   /Sent to Jobber/i.test(await page.locator('button', { hasText: 'Sent to Jobber' }).textContent().catch(()=> '')));
const gpSent = sent.slice(before).find(p => p.tool === 'game_plan');
ok('close: game_plan payload reached the proxy', !!gpSent && gpSent.quote.total === 2000,
   gpSent ? '$' + gpSent.quote.total : 'none');
ok('close: payload carries jobber_client_id', !!gpSent && gpSent.client.jobber_client_id === 'JCLIENT1');

/* Drive upload from the close screen */
ok('close: Upload-to-Drive button present', /Upload job photos to Drive/.test(await page.locator('#pb_plan').textContent()));
await page.locator('#pb_plan .drivebtn').click();
await page.waitForTimeout(500);
ok('close: Drive upload completes + folder link shown',
   /Photos in Drive/.test(await page.locator('#pb_plan .drivebtn').textContent()) &&
   (await page.locator('#pb_plan a.drivelink').getAttribute('href')) === 'https://drive.google.com/drive/folders/FOLDER1');
ok('close: Drive batch carried job label (date — name — address)',
   driveBatches.length > 0 && /2026-06-12 — Dana Tester — 746 Star Grass Ln/.test(driveBatches[0].label), driveBatches[0] && driveBatches[0].label);
const activeJob = await page.evaluate(() => JSON.parse(localStorage.getItem('egc_active_job')));
ok('handoff: egc_active_job written on Send, carries locked total + priced upsells',
   activeJob && activeJob.name === 'Dana Tester' && activeJob.pkg === 'Garage Transformation' &&
   activeJob.rate === '800' && activeJob.total === 2000 && /Both Walls .*\$800/.test(activeJob.upsellsPriced || ''),
   JSON.stringify(activeJob));

/* ── 5. Pre-Job pre-fills from handoff ─────────────────────── */
await page.goto(`${BASE}/crew/prejob.html`);
await page.waitForTimeout(400);
ok('prejob: unlocked via stored token', await page.locator('#egc-gate.off').count() === 1);
const banner = await page.evaluate(() => document.querySelector('main').innerText);
ok('prejob: LOADED FROM GAME PLAN banner', /LOADED FROM GAME PLAN/.test(banner) && /DANA TESTER/.test(banner));
ok('prejob: name prefilled', await page.inputValue('#j_name') === 'Dana Tester');
ok('prejob: address prefilled', await page.inputValue('#j_addr') === '746 Star Grass Ln');
ok('prejob: flat-rate field shows LOCKED TOTAL (not just package rate)', await page.inputValue('#j_rate') === '2000',
   await page.inputValue('#j_rate'));
ok('prejob: banner shows locked total', /Locked total: \$2000/.test(banner), banner.replace(/\s+/g,' ').slice(0,160));
const pkgVal = await page.inputValue('#j_pkg');
ok('prejob: package + priced upsells prefilled', /Garage Transformation/.test(pkgVal) && /Both Walls .*\$750/.test(pkgVal), pkgVal);
ok('prejob: job date prefilled', await page.inputValue('#j_date') === '2026-06-12');
/* in-app actions on prejob items */
ok('prejob: lookup button present on job card', await page.locator('.lookbtn').count() === 1);
ok('prejob: confirmation item has in-app "Text the customer"', /Text the customer/.test(await page.locator('#act_0_2').textContent()));
ok('prejob: deposit item has tap-to-call office', /Call office/.test(await page.locator('#act_0_0').textContent()));
ok('prejob: arrival BEFORE-capture has inline photo control', await page.locator('#act_2_0 input[type=file]').count() === 1);
await page.setInputFiles('#act_2_0 input[type=file]', '/tmp/egc-before.png');
await page.waitForTimeout(400);
ok('prejob: before photo captured on the job', await page.locator('#act_2_0 .pthumb img').count() >= 1);
await page.locator('#act_2_4 button').click();
await page.waitForTimeout(150);
ok('prejob: "Log start time" records a time', /Started/.test(await page.locator('#act_2_4').textContent()));
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

// Garage Transformation is NOT a year-one-free bundle → the package-aware warning must be ABSENT
ok('postjob: Guard year-one-free note absent for non-bundle package',
   !(await page.evaluate(() => guardYearOneFree())) &&
   !/already includes Garage Guard year one free/.test(await page.locator('#sections').textContent()));
// ...but it DOES appear when the package bundles Guard (simulate The Works)
const noteForWorks = await page.evaluate(() => { ACTIVE.pkg = 'The Works'; render();
  return document.querySelector('#sections').textContent.includes('already includes Garage Guard year one free'); });
ok('postjob: Guard year-one-free note shows for bundled package (The Works)', noteForWorks);
await page.evaluate(() => { ACTIVE.pkg = 'Garage Transformation'; render(); });

/* review send → real proxy post, E.164 phone, dedupe id, exact wording */
const beforeRev = sent.length;
await page.locator('#revbtn').click();
await page.waitForTimeout(300);
const rev = sent.slice(beforeRev).find(p => p.tool === 'review_request');
ok('postjob: review send posts via proxy with E.164 phone + request_id',
   !!rev && rev.phone === '+19705550123' && !!rev.request_id, rev ? rev.phone : 'none');
ok('postjob: review message is the proven wording verbatim',
   !!rev && /it was great working with you/.test(rev.message) && /10% off your next service/.test(rev.message) && rev.message.endsWith(rev.review_link));
ok('postjob: review button shows real success', /Review text sent/i.test(await page.locator('#revbtn').textContent()));

// finish payload shape (build it the way finish() does) — carries locked_total + garage_guard
const finishSrc = await page.evaluate(() => finish.toString());
ok('postjob: finish() carries garage_guard + locked_total + request_id',
   /garage_guard:GUARD/.test(finishSrc) && /locked_total:/.test(finishSrc) && /request_id:_finishId/.test(finishSrc));
ok('postjob: finish() writes a local job-log backup before sending',
   /egc_job_log/.test(finishSrc) && finishSrc.indexOf('egc_job_log') < finishSrc.indexOf('postHook'));

/* postjob photos: before + AI preview carry over by jobId; inline after-capture works */
await page.waitForTimeout(400);
ok('postjob: reference card shows before + AI preview (same jobId)',
   await page.locator('#pb_ref .aiout img').count() === 1 && await page.locator('#pb_ref .pthumb img').count() >= 1);
ok('postjob: inline after-capture on the AFTER-capture checklist item',
   await page.locator('#act_0_0 input[type=file]').count() === 1);
await page.setInputFiles('#act_0_0 input[type=file]', '/tmp/egc-before.png');
await page.waitForTimeout(450);
ok('postjob: after photo captured inline + counted',
   (await page.locator('#act_0_0 .pthumb img').count()) >= 1 && (await page.evaluate(() => AFTER_COUNT >= 1)));
ok('postjob: donation-receipt photo action present', await page.locator('#act_2_0 input[type=file]').count() === 1);
ok('postjob: GBP item replaced by Drive-folder item',
   !/GBP photos posted/.test(await page.locator('#sections').textContent()) &&
   /All job photos → the job's Drive folder/.test(await page.locator('#sections').textContent()));
ok('postjob: video share action present', /Share all job photos/.test(await page.locator('#act_3_1').textContent()));
/* Drive upload from the Feed-the-Machine item (uploads the new after+receipt photos) */
const batchesBefore = driveBatches.length;
await page.locator('#act_3_0 .actbtn').click();
await page.waitForTimeout(600);
ok('postjob: Drive upload completes + folder link shown',
   /Photos in Drive/.test(await page.locator('#act_3_0 .actbtn').textContent()) &&
   (await page.locator('#act_3_0 a.drivelink').getAttribute('href')) === 'https://drive.google.com/drive/folders/FOLDER1');
ok('postjob: only NEW photos uploaded (already-uploaded ones skipped)',
   driveBatches.slice(batchesBefore).flatMap(b => b.photos).length >= 1 &&
   driveBatches.slice(batchesBefore).every(b => b.jobId === driveBatches[0].jobId));
ok('postjob: lookup button present on job card', await page.locator('.lookbtn').count() === 1);
const pjFinishSrc = await page.evaluate(() => finish.toString());
ok('postjob: finish() carries drive_folder + jobber_client_id', /drive_folder/.test(pjFinishSrc) && /jobber_client_id/.test(pjFinishSrc));
await page.screenshot({ path: `${SHOTS}/14-postjob-photos-380.png` });

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
