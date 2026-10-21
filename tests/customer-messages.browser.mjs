// PORTAL-INBOX: the Hub's Customer messages screen, home widget and nav badge in real Chromium at 1280 and 390 px.
// The real module, kit and stylesheet are served beside a minimal rail, and /api/customer-messages is the real handler
// over an in-memory store with a signed-in business session. No external network.
// Run: FIELD_PLAYWRIGHT_MODULE=<playwright>/index.mjs [PLAYWRIGHT_CHROMIUM_EXECUTABLE=...] [CM_SCREENSHOTS=<dir>] node tests/customer-messages.browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { customerMessageAlertId, newCustomerMessageAlert } from '../functions/_lib/customer-message-alerts.js';
import { customerMessageHandlers } from '../functions/api/customer-messages.js';

const NOW = '2026-10-21T15:00:00.000Z';
const ago = minutes => new Date(Date.parse(NOW) - minutes * 60000).toISOString();
const seed = async () => {
  const rows = [
    [{ customer: 'Dana Customer', type: 'job', serviceType: 'Garage cleanout', date: '2026-10-24', highlevelContactId: 'c1' }, 'job-1', 'customer-a', 'The side door code is 4521. Please park on the street, the driveway is being sealed.', 'Dana Customer', 3],
    [{ customer: 'Robin Walker', type: 'walkthrough', date: '2026-10-22', highlevelContactId: '' }, 'walk-2', 'customer-b', 'Can we move the walkthrough to Thursday afternoon? ' + 'x'.repeat(80), 'Robin Walker', 40],
    [{ customer: 'Lee Park', type: 'job', serviceType: 'Garage reorganization', date: '2026-10-30', highlevelContactId: 'c3' }, 'job-3', 'customer-c', 'My spouse Sam will be home instead of me.', 'Sam Park', 300],
  ];
  const docs = new Map();
  for (const [job, jobId, messageId, body, authorName, minutes] of rows) {
    const id = await customerMessageAlertId(jobId, messageId), alert = newCustomerMessageAlert(job, jobId, { id: messageId, body, authorName, createdAt: ago(minutes) }, ago(minutes));
    docs.set(id, { id, ...alert, revision: 'r0' });
  }
  // Dana's entry holds three messages (one entry per job, PORTAL-INBOX).
  const dana = [...docs.values()][0];
  Object.assign(dana, { messageCount: 3, messages: [{ id: 'customer-a0', authorName: 'Dana Customer', body: 'Hi!', createdAt: ago(9) }, { id: 'customer-a1', authorName: 'Dana Customer', body: 'Quick question about parking.', createdAt: ago(6) }, ...dana.messages] });
  return docs;
};
const docs = await seed(), seeded = new Map([...docs].map(([id, row]) => [id, structuredClone(row)]));
let n = 0;
const store = {
  async read(id) { const row = docs.get(id); return row ? structuredClone(row) : null; },
  async open() { const rows = [...docs.values()].filter(row => row.status === 'open').map(row => structuredClone(row)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return { rows, complete: true }; },
  async write(id, patch, revision = '') { const row = docs.get(id); if (!row || revision && row.revision !== revision) return null; docs.set(id, { ...row, ...structuredClone(patch), revision: `r${++n}` }); return docs.get(id).revision; },
};
const api = customerMessageHandlers({ session: async () => ({ user: 'tylerg', displayName: 'Tyler G', role: 'manager', businessAccess: true }), storage: () => store, now: () => new Date(NOW) });
const posts = [];
// A list GET can be held after it has read the list: its (now stale) answer goes out only when the test releases it.
let holdNextGet = false, heldReady = null, releaseHeld = null;

const FIXTURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Customer messages fixture</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-customer-messages.css">
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f1f0ec}.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.ops-nav{background:#0c1829;padding:12px}.ops-nav button{width:100%;border:0;background:transparent;color:#bcc6d4;display:flex;align-items:center;gap:12px;padding:12px 11px;font:650 15px/1 system-ui}
main{display:grid;gap:16px;padding:16px;min-width:0}@media(max-width:680px){.shell{grid-template-columns:1fr}.ops-nav{display:flex}}</style></head>
<body><div class="shell"><nav class="ops-nav"><button type="button" data-ops-tab="customer_messages"><span>Customer messages</span></button></nav>
<main><div id="home"></div><div id="screen"></div></main></div>
<script>sessionStorage.setItem('egc_capabilities',JSON.stringify(['customer.send']));window.toasts=[];</script>
<script src="/employee-customer-messages.js"></script>
<script>const ctx={capabilities:['crew','customer_contact'],toast:(m,e)=>toasts.push([m,!!e]),go:v=>{window.went=v;}};
window.EGCCustomerMessagesHome.mount(document.getElementById('home'),ctx);window.EGCCustomerMessages.mount(document.getElementById('screen'),ctx);</script></body></html>`;

const server = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url, 'http://127.0.0.1');
  if (url.pathname === '/api/customer-messages') {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (incoming.method === 'POST') posts.push(JSON.parse(body));
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, { method: incoming.method, headers: incoming.headers, ...(incoming.method === 'POST' ? { body } : {}) });
    const response = await (incoming.method === 'POST' ? api.post : api.get)({ request, env: {} });
    const text = await response.text();
    if (incoming.method === 'GET' && holdNextGet) {
      holdNextGet = false;
      await new Promise(resolve => { releaseHeld = resolve; heldReady?.(); });
    }
    outgoing.writeHead(response.status, { 'Content-Type': 'application/json' });
    return outgoing.end(text);
  }
  if (url.pathname === '/fixture.html') { outgoing.writeHead(200, { 'Content-Type': 'text/html' }); return outgoing.end(FIXTURE); }
  const file = { '/employee-ui-kit.css': 'text/css', '/employee-customer-messages.css': 'text/css', '/employee-customer-messages.js': 'text/javascript' }[url.pathname];
  if (!file) { outgoing.writeHead(404); return outgoing.end(); }
  outgoing.writeHead(200, { 'Content-Type': file });
  outgoing.end(readFileSync(new URL('..' + url.pathname, import.meta.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import(pathToFileURL(process.env.FIELD_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const shots = process.env.CM_SCREENSHOTS || '';
if (shots) await mkdir(shots, { recursive: true });
try {
  for (const width of [1280, 390]) {
    for (const [id, row] of seeded) docs.set(id, structuredClone(row));
    posts.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.clock.setFixedTime(new Date(NOW));
    await page.goto(`${origin}/fixture.html`);
    const screen = page.locator('#screen .egc-customer-messages'), home = page.locator('#home .egc-customer-messages');
    await screen.locator('.cm-item').first().waitFor();
    assert.equal(await page.locator('[data-ops-tab="customer_messages"] .cm-nav-badge').textContent(), '3', `${width}: the nav badge counts open messages`);
    assert.equal(await page.locator('[data-ops-tab="customer_messages"] .cm-nav-badge').getAttribute('aria-label'), '3 customer conversations waiting');
    assert.equal(await screen.locator('[data-cm-count]').textContent(), '3');
    assert.equal(await home.locator('.cm-item').count(), 3, `${width}: the home widget lists them too`);
    const items = screen.locator('.cm-item');
    assert.equal(await items.count(), 3);
    assert.deepEqual(await items.locator('.cm-who').evaluateAll(nodes => nodes.map(node => node.firstChild.textContent)), ['Dana Customer', 'Robin Walker', 'Sam Park for Lee Park'], 'newest first; a collaborator is named for the customer');
    assert.equal(await items.nth(0).locator('.cm-many').textContent(), '3 messages', `${width}: one entry counts the job's messages`);
    assert.deepEqual(await items.nth(0).locator('.cm-body').allTextContents(), ['Dana Customer: Hi!', 'Dana Customer: Quick question about parking.', 'Dana Customer: The side door code is 4521. Please park on the street, the driveway is being sealed.']);
    assert.equal(await items.nth(1).locator('.cm-many').count(), 0, 'a single message has no count');
    assert.match(await items.nth(0).locator('.cm-when').textContent(), /^3 min ago · Oct 21/);
    assert.equal(await items.nth(0).locator('a', { hasText: 'Open job' }).getAttribute('href'), '/crew/job.html?jobId=job-1');
    assert.equal(await items.nth(1).locator('a', { hasText: 'Open job' }).getAttribute('href'), '/crew/gameplan.html?walkthroughId=walk-2');
    assert.equal(await items.locator('.cm-task').count(), 0, 'the Hub list is the alert; no HighLevel task status is shown');
    // Layout: no sideways scroll, nothing wider than the viewport, and full-width 48 px touch targets on a phone.
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}: no horizontal page scroll`);
    for (const box of await items.locator('.cm-body').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().right))) assert.ok(box <= width, `${width}: message text stays inside the viewport`);
    const handled = items.nth(0).locator('[data-cm-handled]'), rect = await handled.boundingBox();
    assert.ok(rect.height >= 48, `${width}: Mark handled is a 48 px target`);
    if (width === 390) assert.ok(rect.width > 300, '390: buttons are full width on a phone');
    if (shots) await page.screenshot({ path: join(shots, `customer-messages-${width}.png`), fullPage: true });

    // Dana writes again after the office loaded the list: Mark handled on the row they saw (3 messages) is refused,
    // the row stays, and the list reloads with the new message before it can be handled.
    const danaId = [...seeded.keys()][0], dana = docs.get(danaId);
    Object.assign(dana, { messageCount: 4, body: 'Actually please cancel, my dog is sick', lastMessageAt: NOW, messages: [...dana.messages, { id: 'customer-a3', authorName: 'Dana Customer', body: 'Actually please cancel, my dog is sick', createdAt: NOW }], revision: 'r-appended' });
    await handled.click();
    await page.waitForFunction(() => document.querySelector('#screen .cm-item .cm-many')?.textContent === '4 messages');
    assert.equal(await items.count(), 3, `${width}: the row was not dropped`);
    assert.equal(docs.get(danaId).status, 'open');
    assert.deepEqual(posts.map(body => [body.action, body.seenCount]), [['mark_handled', 3]]);
    assert.match(await items.nth(0).locator('.cm-body').last().textContent(), /please cancel, my dog is sick/);
    assert.deepEqual(await page.evaluate(() => window.toasts), [['A new message arrived. Read it before marking this handled.', true]]);
    await page.evaluate(() => { window.toasts.length = 0; });
    await items.nth(0).locator('[data-cm-handled]').click();
    await page.waitForFunction(() => document.querySelectorAll('#screen .cm-item').length === 2);
    assert.deepEqual(posts.map(body => [body.action, body.seenCount]), [['mark_handled', 3], ['mark_handled', 4]]);
    assert.equal(docs.get(danaId).handledBy, 'Tyler G');
    assert.equal(await page.locator('[data-ops-tab="customer_messages"] .cm-nav-badge').textContent(), '2', `${width}: the badge drops when one is handled`);
    assert.equal(await home.locator('.cm-item').count(), 2, `${width}: the widget follows the same list`);
    assert.deepEqual(await page.evaluate(() => window.toasts), [['Marked handled', false]]);
    for (let left = 2; left > 0; left -= 1) {
      await screen.locator('[data-cm-handled]').first().click();
      await page.waitForFunction(count => document.querySelectorAll('#screen .cm-item').length === count, left - 1);
    }
    assert.equal(await page.locator('.cm-nav-badge').count(), 0, `${width}: no badge with nothing waiting`);
    assert.match(await screen.textContent(), /No customer messages are waiting\./);
    if (shots) await page.screenshot({ path: join(shots, `customer-messages-${width}-empty.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();

    // A list GET that read before Mark handled lands after it: its stale answer is dropped, in both outcomes.
    for (const [id, row] of seeded) docs.set(id, structuredClone(row));
    posts.length = 0;
    const racer = await browser.newPage({ viewport: { width, height: 900 } });
    await racer.clock.setFixedTime(new Date(NOW));
    await racer.goto(`${origin}/fixture.html`);
    const rows = racer.locator('#screen .cm-item');
    await rows.first().waitFor();
    const holdPoll = async () => {
      const ready = new Promise(resolve => { heldReady = resolve; });
      holdNextGet = true;
      await racer.evaluate(() => { void window.EGCCustomerMessages.refresh(); });
      await ready; // the poll has read the list and waits to answer
    };
    // Success: Robin's row is handled while a poll that still lists it is in flight; the row never comes back.
    await holdPoll();
    await rows.nth(1).locator('[data-cm-handled]').click();
    await racer.waitForFunction(() => document.querySelectorAll('#screen .cm-item').length === 2);
    releaseHeld();
    await racer.waitForTimeout(300);
    assert.deepEqual(await rows.locator('.cm-who').evaluateAll(nodes => nodes.map(node => node.firstChild.textContent)), ['Dana Customer', 'Sam Park for Lee Park'], `${width}: the stale poll does not bring the handled row back`);
    assert.equal(await racer.locator('.cm-nav-badge').textContent(), '2');
    assert.equal(await racer.locator('#home .cm-item').count(), 2);
    // Refused: Dana writes again while a stale poll is in flight; one reload shows the new count and the next click works.
    await holdPoll();
    const danaAgain = docs.get([...seeded.keys()][0]);
    Object.assign(danaAgain, { messageCount: 4, body: 'Actually please cancel', lastMessageAt: NOW, messages: [...danaAgain.messages, { id: 'customer-a3', authorName: 'Dana Customer', body: 'Actually please cancel', createdAt: NOW }], revision: 'r-appended' });
    await rows.nth(0).locator('[data-cm-handled]').click();
    await racer.waitForFunction(() => document.querySelector('#screen .cm-item .cm-many')?.textContent === '4 messages');
    releaseHeld();
    await racer.waitForTimeout(300);
    assert.equal(await rows.nth(0).locator('.cm-many').textContent(), '4 messages', `${width}: the stale poll does not redraw the old count`);
    await rows.nth(0).locator('[data-cm-handled]').click();
    await racer.waitForFunction(() => document.querySelectorAll('#screen .cm-item').length === 1);
    assert.deepEqual(posts.map(body => body.seenCount), [1, 3, 4], `${width}: one refused click, then one that works`);
    await racer.close();
    console.log(`ok ${width}px: badge, list, links, Mark handled, empty state and stale list reads`);
  }
} finally {
  await browser.close();
  server.close();
}
