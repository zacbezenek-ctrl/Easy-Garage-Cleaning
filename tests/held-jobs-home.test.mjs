// The Hub home's "Booked jobs waiting for prices" widget (employee-held-jobs.js) against the real POST /api/held-jobs
// handler: opening the Command center after a pricing-menu change releases the held jobs the menu now approves, with no
// owner action; the owner's Release held jobs button releases on demand; nothing shows while nothing is held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument } from './helpers/hub-dom.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const SOURCE = read('../employee-held-jobs.js'), KIT = read('../employee-ui-kit.js');
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true }, MANAGER = { user: 'tylerg', role: 'manager', businessAccess: true };

// The API's answers (tests/held-jobs.test.mjs drives the real handler and release): sweep() and release() give
// {released, held}.
function widget({ who, sweep, release }) {
  const document = createDocument(), posts = [];
  async function hubFetch(url, init = {}) {
    const body = JSON.parse(init.body);
    posts.push(body.action);
    assert.deepEqual([url, init.method, init.headers['Content-Type']], ['/api/held-jobs', 'POST', 'application/json']);
    return Response.json({ ok: true, enabled: true, ran: true, menuVersion: 'm2', more: false, ...(body.action === 'sweep' ? sweep() : release()) });
  }
  const context = { console, Intl, URL, Promise, AbortController, crypto, setTimeout, clearTimeout, queueMicrotask, document, Node: document.Node, addEventListener() {}, removeEventListener() {} };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(KIT, context, { filename: 'employee-ui-kit.js' });
  vm.runInContext(SOURCE, context, { filename: 'employee-held-jobs.js' });
  const host = document.createElement('section');
  document.body.append(host);
  const capabilities = who.role === 'owner' ? ['crew', 'business', 'owner'] : ['crew', 'business'];
  const mount = () => context.EGCHeldJobsHome.mount(host, { identity: who.user, hubFetch, capabilities, home: 'today', widget: 'held_jobs' });
  const button = label => host.querySelectorAll('button').find(node => node.textContent === label);
  return { host, posts, mount, button, unmount: () => context.EGCHeldJobsHome.unmount() };
}

test('a manager opening the Command center after the deploy releases the held half-load job; the widget says so, with no button', async () => {
  const ui = widget({ who: MANAGER, sweep: () => ({ released: ['job-half'], held: 2 }) });
  await ui.mount();
  assert.deepEqual(ui.posts, ['sweep']);
  assert.match(ui.host.textContent, /1 booked job was released after the price menu changed: the customer gets its estimate and deposit request\./);
  assert.match(ui.host.textContent, /2 booked jobs still wait for prices/);
  assert.equal(ui.button('Release held jobs (2)'), undefined, 'only the owner releases on demand');
});

test('the owner presses Release held jobs; with nothing held the widget shows nothing', async () => {
  let held = 1;
  const ui = widget({ who: OWNER, sweep: () => ({ released: [], held }), release: () => { held = 0; return { released: ['job-1'], held: 0 }; } });
  await ui.mount();
  assert.match(ui.host.textContent, /1 booked job still waits for prices/);
  ui.button('Release held jobs (1)').click();
  for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ui.posts, ['sweep', 'release']);
  assert.match(ui.host.textContent, /1 booked job was released/);
  assert.equal(ui.button('Release held jobs (1)'), undefined);
  ui.unmount();
  const quiet = widget({ who: OWNER, sweep: () => ({ released: [], held: 0 }) });
  await quiet.mount();
  assert.equal(quiet.host.children.length, 0, 'nothing held, nothing shown');
});

test('the widget keeps the + on a capped count and tells apart jobs signed above the approved price and jobs that could not be released', async () => {
  const ui = widget({ who: OWNER, sweep: () => ({ released: [], held: 1000, more: true, signedAbove: 2, stuck: 1 }) });
  await ui.mount();
  assert.match(ui.host.textContent, /997\+ booked jobs still wait for prices/);
  assert.match(ui.host.textContent, /2 booked jobs were signed above the price the owner approved, so they are not released: rebuild the quote and have the customer sign it again\./);
  assert.match(ui.host.textContent, /1 booked job couldn't be released automatically after three tries: press Release held jobs to try again\./);
  assert.ok(ui.button('Release held jobs (1000+)'));
});
