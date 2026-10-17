// WP14c Purchase list screen (employee-purchase-list.js) on the real UI kit in a vm with a small DOM: the bounded
// request it makes, the per-store product rows with their jobs, the manager marks (one request per job) and errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage, FixedDate, hubPage } from './helpers/hub-dom.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const job = (jobId, date, time, customer, quantity, purchaseState) => ({ jobId, materialId: 'quote-shelving', date, time, customer, title: '', quantity, purchaseState, href: `/crew/job.html?jobId=${jobId}` });
const LIST = () => ({ ok: true, authority: 'employee_hub', start: '2026-09-22', end: '2026-10-05', generatedAt: '2026-09-22T18:00:00.000Z', lines: 4, jobs: 3, stores: [
  { store: 'Home Depot', products: [
    { key: 'sku:hd-100', name: 'Metal shelving unit', sku: 'HD-100', unit: 'unit', unitsPerPack: 2, productUrl: 'https://www.homedepot.com/p/100', category: 'shelving', quantity: 6, byState: { to_buy: 3, ordered: 2, purchased: 0, loaded: 1 }, toBuy: 3, packsToBuy: 2,
      jobs: [job('job-c', '2026-09-24', '09:30', 'Customer C', 1, 'loaded'), job('job-a', '2026-09-24', '13:00', 'Customer A', 2, 'ordered'), job('job-b', '2026-09-25', '09:30', 'Customer B', 3, 'to_buy')] },
    { key: 'name:wall anchors|', name: 'Wall anchors', sku: '', unit: '', unitsPerPack: null, productUrl: '', category: 'consumable', quantity: 20, byState: { to_buy: 0, ordered: 0, purchased: 20, loaded: 0 }, toBuy: 0, packsToBuy: null,
      jobs: [{ ...job('job-a', '2026-09-24', '13:00', 'Customer A', 20, 'purchased'), materialId: 'quote-anchors' }] }] }] });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
const flush = async (rounds = 60) => { for (let index = 0; index < rounds; index++) await Promise.resolve(); };

function screen({ list = () => reply(LIST()), write = () => reply({ ok: true, alreadyApplied: false, jobId: 'x', changed: [] }) } = {}) {
  const document = createDocument(), calls = [];
  const hubFetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', body });
    if ((init.method || 'GET') === 'GET') return list(url);
    const answer = await write(body);
    return answer.status === 200 ? reply({ ok: true, alreadyApplied: false, jobId: body.jobId, changed: [] }) : answer;
  };
  const context = { console, URL, URLSearchParams, Intl, Promise, Map, Set, Error, JSON, Object, Array, Math, AbortController, crypto, structuredClone, Date: FixedDate, Node: document.Node, document,
    sessionStorage: storage({ egc_u: 'AlexK' }), setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, location: { href: 'https://easygaragecleaning.com/employee' } };
  context.window = context;
  vm.createContext(context);
  for (const file of ['employee-ui-kit.js', 'employee-purchase-list.js']) vm.runInContext(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), context, { filename: file });
  const host = document.createElement('main');
  document.body.append(host);
  const mounted = context.EGCPurchaseList.mount(host, Object.freeze({ identity: 'AlexK', role: 'manager', capabilities: ['crew', 'business'], hubFetch, toast() {}, askAction: async () => null, go() {}, screen: 'purchase_list' }));
  const root = () => host.querySelector('.egc-purchase'), text = () => root()?.textContent || '';
  const button = (label, scope = root()) => { const found = scope.querySelectorAll('button').find(node => node.textContent === label); assert.ok(found, 'button ' + label); return found; };
  return { calls, root, text, button, mounted, module: context.EGCPurchaseList };
}

test('the screen asks for today and the next 13 days and lists what to buy by store, product and job', async () => {
  const ui = screen();
  await ui.mounted; await flush();
  assert.deepEqual(ui.calls.map(call => [call.method, call.url]), [['GET', '/api/purchase-list?start=2026-09-22&end=2026-10-05']]);
  assert.equal(ui.root().querySelector('.pl-store h3').textContent, 'Home Depot');
  const rows = ui.root().querySelectorAll('.pl-product');
  assert.equal(rows.length, 1, 'a fully bought product is hidden until Show bought items');
  assert.match(rows[0].textContent, /Metal shelving unit/);
  assert.match(rows[0].textContent, /SKU HD-100 · unit · packs of 2/);
  assert.equal(rows[0].querySelector('.pl-big').textContent, '3');
  assert.match(rows[0].textContent, /to buy · 2 packs/);
  assert.match(rows[0].textContent, /To buy 3 · Ordered 2 · Purchased 0 · Loaded 1/);
  assert.equal(rows[0].querySelector('.pl-product-text a').getAttribute('href'), 'https://www.homedepot.com/p/100');
  assert.deepEqual(rows[0].querySelectorAll('.pl-job a').map(link => [link.getAttribute('href'), link.textContent]), [
    ['/crew/job.html?jobId=job-c', 'Thu, Sep 24 · 9:30 AM · Customer C'], ['/crew/job.html?jobId=job-a', 'Thu, Sep 24 · 1:00 PM · Customer A'], ['/crew/job.html?jobId=job-b', 'Fri, Sep 25 · 9:30 AM · Customer B']]);
  assert.match(ui.text(), /4 buy lines on 3 jobs/);
  assert.doesNotMatch(ui.text(), /\$/);
  ui.button('Show bought items').click();
  assert.equal(ui.root().querySelectorAll('.pl-product').length, 2);
  assert.equal(ui.module.canLeave(), true);
});

test('Mark all purchased sends one request per job for the lines still to buy or ordered, then reloads', async () => {
  const ui = screen();
  await ui.mounted; await flush();
  ui.button('Mark all purchased (2)').click();
  await flush(120);
  const posts = ui.calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.map(call => [call.url, call.body.jobId, call.body.materialIds, call.body.state]), [['/api/purchase-list', 'job-a', ['quote-shelving'], 'purchased'], ['/api/purchase-list', 'job-b', ['quote-shelving'], 'purchased']]);
  for (const post of posts) assert.match(post.body.requestId, UUID);
  assert.notEqual(posts[0].body.requestId, posts[1].body.requestId);
  assert.equal(ui.calls.at(-1).method, 'GET', 'the list is read again after the marks');
  assert.match(ui.root().querySelector('.hub-notice.success').textContent, /Metal shelving unit marked purchased on 2 jobs\./);
  ui.button('Mark all ordered (1)').click();
  await flush(120);
  assert.deepEqual(ui.calls.filter(call => call.method === 'POST').slice(2).map(call => [call.body.jobId, call.body.state]), [['job-b', 'ordered']]);
});

test('a refused mark stops, says why and still refreshes; a switched-off list explains itself', async () => {
  let posts = 0;
  const ui = screen({ write: () => ++posts === 1 ? reply({ ok: false, code: 'purchase_material_missing', error: 'A chosen material is no longer a buy item on this job.' }, 409) : reply({}) });
  await ui.mounted; await flush();
  ui.button('Mark all purchased (2)').click();
  await flush(120);
  assert.equal(posts, 1, 'the next job is not sent after a refusal');
  assert.match(ui.root().querySelector('.hub-notice.error').textContent, /A material changed on its job/);
  assert.equal(ui.calls.at(-1).method, 'GET');
  const off = screen({ list: () => reply({ ok: false, code: 'purchase_list_disabled', error: 'The purchase list is not switched on for this Hub.' }, 404) });
  await off.mounted; await flush();
  assert.match(off.text(), /The purchase list is unavailable/);
  assert.match(off.text(), /not switched on for this Hub yet/);
});

test('the Hub lists Purchase list under RUN THE BUSINESS for business viewers only', async () => {
  for (const [who, visible] of [[{}, true], [{ user: 'AlexK', business: true, role: 'manager' }, true], [{ user: 'Synthetic.Crew', business: false, role: 'crew' }, false]]) {
    const page = hubPage(who), entry = page.context.EGCHubScreens.get('purchase_list');
    assert.deepEqual({ group: entry.group, label: entry.label, capability: entry.capability, module: entry.module, js: entry.load.js, css: entry.load.css }, { group: 'RUN THE BUSINESS', label: 'Purchase list', capability: 'business', module: 'EGCPurchaseList', js: 'employee-purchase-list.js', css: 'employee-purchase-list.css' });
    assert.equal(page.api.canView('purchase_list'), visible, JSON.stringify(who));
  }
});
