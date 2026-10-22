// The owner's bulk "approve these draft prices" path in the Hub catalog screen (employee-catalog.js, Menu prices),
// run in a vm DOM against the REAL /api/quote-draft (builder menu) and /api/catalog (menu.approve) handlers over an
// in-memory Firestore REST emulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage } from './helpers/hub-dom.mjs';
import { catalogHandlers } from '../functions/api/catalog.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { HELD_RELEASE_MARKER, heldJobsHandlers } from '../functions/api/held-jobs.js';
import { randomUUID } from 'node:crypto';
import { priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { builderState, fixture, menuItem, owner as fixtureOwner, selection, signedPlan, NOW as SIGNED_AT, ON_ENV } from './helpers/estimator-fixture.mjs';
import { catalogStorage, readCompositeState } from '../functions/_lib/catalog-store.js';
import { validatePricingSettings } from '../functions/_lib/catalog.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const SOURCE = read('../employee-catalog.js'), KIT = read('../employee-ui-kit.js');
const defaults = JSON.parse(read('../functions/_data/pricing-settings.defaults.json')), menu = JSON.parse(read('../functions/_data/pricing-menu.json'));
const ORIGIN = 'https://easygaragecleaning.com', ROOT = 'projects/egcw-1ec83/databases/(default)/documents/', NOW = '2026-10-17T18:00:00.000Z';
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const MANAGER = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const BUILDER = { EGC_QUOTE_BUILDER_ENABLED: 'true' };
const shelf = menu.products.find(item => item.id === 'hd-100006678'), mattress = menu.services.find(item => item.name === 'Mattress');

function firestore() {
  const docs = new Map(), posts = [];
  let tick = 0;
  const time = () => `2026-10-17T18:00:00.${String(++tick).padStart(6, '0')}Z`;
  const error = (status, code, message) => Response.json({ error: { code, status, ...(message ? { message } : {}) } }, { status: code });
  async function fetcher(_env, url, options = {}) {
    const path = decodeURIComponent(new URL(url).pathname.split('/documents')[1] || '');
    if (options.method === 'POST' && path === ':commit') {
      const { writes } = JSON.parse(options.body), keys = writes.map(write => write.update.name.slice(ROOT.length));
      for (const [index, write] of writes.entries()) {
        const current = docs.get(keys[index]);
        if (write.currentDocument?.exists === false && current) return error('ALREADY_EXISTS', 409);
        if (write.currentDocument?.updateTime && current?.updateTime !== write.currentDocument.updateTime) return error('FAILED_PRECONDITION', 400);
      }
      const at = time();
      for (const [index, write] of writes.entries()) {
        const fields = { ...(docs.get(keys[index])?.fields || {}) };
        for (const field of write.updateMask.fieldPaths) fields[field] = write.update.fields[field];
        docs.set(keys[index], { fields, updateTime: at });
      }
      return Response.json({ writeResults: writes.map(() => ({ updateTime: at })) });
    }
    const key = path.slice(1), doc = docs.get(key);
    return doc ? Response.json({ name: ROOT + key, fields: doc.fields, updateTime: doc.updateTime }) : error('NOT_FOUND', 404, `Document "${ROOT}${key}" not found.`);
  }
  return { docs, posts, sweeps: [], gets: [], fetcher, get: key => docs.has(key) ? decodeFirestoreFields(docs.get(key).fields) : null, put: (key, data) => docs.set(key, { fields: encodeFirestoreFields(data), updateTime: time() }) };
}

function screen({ who = OWNER, env = BUILDER, fs = firestore(), jobs = { heldJobIds: async () => [] } } = {}) {
  const document = createDocument(), session = storage({ egc_u: who.user });
  const catalog = catalogHandlers({ session: async () => who, storage: e => catalogStorage(e, fs.fetcher), now: () => new Date(NOW), cache: new Map() });
  const quotes = quoteDraftHandlers({ session: async () => who, storage: () => { throw new Error('the builder menu reads no jobs'); }, now: () => new Date(NOW), compositeState: e => readCompositeState(catalogStorage(e, fs.fetcher)) });
  // Opening the screen sweeps the held jobs (POST /api/held-jobs); jobs: the held jobs' storage (none held by default).
  const held = heldJobsHandlers({ session: async () => who, storage: e => catalogStorage(e, fs.fetcher), held: () => jobs, now: () => new Date(NOW) });
  async function hubFetch(url, init = {}) {
    const method = init.method || 'GET', request = new Request(ORIGIN + url, { method, headers: { ...(init.headers || {}), Origin: ORIGIN }, body: init.body });
    if (url === '/api/held-jobs') { fs.sweeps.push(JSON.parse(init.body)); return held.post({ request, env }); }
    const handler = url.startsWith('/api/quote-draft') ? quotes : catalog;
    if (method === 'POST') fs.posts.push(JSON.parse(init.body)); else fs.gets.push(url);
    return method === 'POST' ? handler.post({ request, env }) : handler.get({ request, env });
  }
  const context = { console, Intl, URL, Promise, AbortController, crypto, setTimeout, clearTimeout, queueMicrotask, document, Node: document.Node, sessionStorage: session, location: { href: ORIGIN + '/employee.html' }, addEventListener() {}, removeEventListener() {} };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(KIT, context, { filename: 'employee-ui-kit.js' });
  vm.runInContext(SOURCE, context, { filename: 'employee-catalog.js' });
  const host = document.createElement('main');
  document.body.append(host);
  context.EGCCatalog.mount(host, { identity: who.user, hubFetch, now: () => Date.parse(NOW) });
  const root = () => host.querySelector('.egc-catalog');
  const settle = async (check, what) => { for (let round = 0; round < 1400; round++) { if (check()) return; await new Promise(resolve => round < 400 ? setImmediate(resolve) : setTimeout(resolve, 5)); } assert.fail(`timed out waiting for ${what}`); };
  const button = label => { const found = document.body.querySelectorAll('button').filter(node => node.textContent === label); assert.ok(found.length, `no button "${label}"`); return found[0]; };
  const row = id => root().querySelector(`tr[data-item="${id}"]`);
  return { document, root, fs, settle, button, row, M: context.EGCCatalog.model };
}
const off = node => node.disabled === true || node.hasAttribute('disabled');

test('the owner ticks draft menu prices, sets a service amount, reviews and approves them in one audited request', async () => {
  const ui = screen();
  await ui.settle(() => ui.root()?.textContent.includes('pricing-menu prices are drafts'), 'the menu prices');
  assert.match(ui.root().textContent, /Catalog pricing is turned off/, 'the menu approval works while catalog quotes stay off');
  assert.match(ui.root().textContent, /Approved in the pricing menu itself: Quarter load \$250\.00, Half load \$500\.00, Three-quarter load \$750\.00, Full truck load \$1,000\.00/);
  assert.match(ui.row(shelf.id).textContent, /Public retail \$89\.00 × 1\.3/, 'the owner sees the cost basis');
  const tick = id => { const box = ui.row(id).querySelector('input[type="checkbox"]'); box.checked = true; box.dispatchEvent({ type: 'change', target: box }); };
  tick(mattress.id); tick(shelf.id);
  const amount = ui.row(mattress.id).querySelector('input.cat-menu-amount');
  assert.equal(amount.value, '70.00', 'a service starts at its draft amount');
  amount.value = '80.00'; amount.dispatchEvent({ type: 'input', target: amount });
  assert.equal(ui.row(shelf.id).querySelector('input.cat-menu-amount'), null, 'a product is approved only at cost × goods markup');
  ui.button('Review 2 changes').click();
  const dialog = ui.document.body.querySelector('dialog');
  assert.match(dialog.textContent, /MattressDraft \$70\.00Approved \$80\.00/);
  ui.button('Save approvals').click();
  await ui.settle(() => ui.root().textContent.includes('Approved 2 and revoked 0 pricing-menu prices'), 'the approval');
  const saved = ui.fs.get('pricingMenuApprovals/current');
  assert.deepEqual([saved.approvals[mattress.id].unitCents, saved.approvals[shelf.id].unitCents, saved.updatedBy], [8000, 11570, 'zacb']);
  const post = ui.fs.posts.at(-1);
  assert.deepEqual([post.action, post.expectedRevision, post.menuVersion, post.settingsVersion], ['menu.approve', null, menu.menuVersion, defaults.settingsVersion]);
  assert.ok([...ui.fs.docs.keys()].some(key => key.startsWith('hub_audit/')) && [...ui.fs.docs.keys()].some(key => key.startsWith('catalogOperations/')), 'the catalog receipt and audit trail');
  await ui.settle(() => ui.root().textContent.includes('Approved by you (2)'), 'the reloaded approvals');
  assert.match(ui.row(mattress.id).textContent, /Mattress\$80\.00/, 'the approved amount is the price now');
});

test('a manager sees the draft prices and reasons but cannot approve them', async () => {
  const ui = screen({ who: MANAGER });
  await ui.settle(() => ui.root()?.textContent.includes('pricing-menu prices are drafts'), 'the menu prices');
  assert.match(ui.root().textContent, /Only the owner can approve pricing-menu prices\./);
  assert.ok(off(ui.row(shelf.id).querySelector('input[type="checkbox"]')));
});

test('with the builder flag off the catalog screen shows no menu prices and never asks for them', async () => {
  for (const env of [{}, { CATALOG_QUOTES_ENABLED: 'true' }]) {
    const ui = screen({ env });
    await ui.settle(() => ui.root()?.textContent.includes(env.CATALOG_QUOTES_ENABLED ? 'Items' : 'Catalog pricing is turned off'), 'the screen');
    for (let round = 0; round < 50; round++) await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(ui.root().textContent, /pricing-menu/);
    assert.deepEqual(ui.fs.gets.filter(url => url.startsWith('/api/quote-draft')), [], 'no builder request: the catalog overview says the builder is off');
  }
});

test('cleaning bases are priced by the owner, Tick all leaves them out, and one request holds at most 100 changes', async () => {
  const ui = screen();
  await ui.settle(() => ui.root()?.textContent.includes('pricing-menu prices are drafts'), 'the menu prices');
  assert.match(ui.root().textContent, /historical full-service base, which already included hauling/);
  assert.match(ui.root().textContent, /A quote with other storage goods \(overhead racks, cabinets, hooks, track systems and the like\) is sent once the estimator sets its man-hours by hand to include installing them, or once you tick this\./);
  const base = menu.services.find(item => item.name === 'Two-car garage base');
  const tick = id => { const box = ui.row(id).querySelector('input[type="checkbox"]'); box.checked = !box.checked; box.dispatchEvent({ type: 'change', target: box }); };
  tick(base.id);
  const amount = ui.row(base.id).querySelector('input.cat-menu-amount');
  assert.deepEqual([amount.value, amount.getAttribute('placeholder')], ['', 'Cleaning-only amount'], 'the owner types the cleaning-only amount');
  ui.button('Review 1 change').click();
  assert.match(ui.row(base.id).textContent, /Enter the approved amount as dollars/);
  tick(base.id);
  const ticks = () => ui.root().querySelectorAll('tbody input[type="checkbox"]').filter(box => box.checked && /^Approve /.test(box.getAttribute('aria-label'))).length;
  ui.document.body.querySelectorAll('button').filter(node => node.textContent === 'Tick all in this step')[0].click();
  assert.ok(menu.services.filter(item => item.group === 'cleaning-base').every(item => !ui.row(item.id).querySelector('input[type="checkbox"]').checked), 'Tick all leaves the cleaning bases unticked');
  const removal = ticks();
  ui.document.body.querySelectorAll('button').filter(node => node.textContent === 'Tick all in this step').at(-1).click();
  assert.equal(ticks(), 100, `the storage step fills the request up to 100 (${removal} removal prices were ticked first)`);
  assert.ok(!off(ui.button('Review 100 changes')));
  tick(menu.products.filter(item => item.section === 'storage').find(item => !ui.row(item.id).querySelector('input[type="checkbox"]').checked).id);
  assert.match(ui.root().textContent, /Approve or revoke at most 100 prices at a time: untick 1/);
  assert.ok(off(ui.button('Review 101 changes')));
});

test('the goods markup setting is edited, validated and reviewed like every pricing setting', () => {
  const { M } = screen({ env: {} });
  const form = M.settingsForm(defaults, 'owner-markup');
  assert.equal(form.goodsMarkup, '1.3');
  const changed = M.parseSettings({ ...form, goodsMarkup: '1.45' }, defaults);
  assert.deepEqual(JSON.parse(JSON.stringify(changed.errors)), {});
  assert.equal(changed.settings.goodsMarkup, 1.45);
  assert.doesNotThrow(() => validatePricingSettings(changed.settings));
  assert.deepEqual(JSON.parse(JSON.stringify(M.settingsChanges(defaults, changed.settings))).find(row => row.label === 'Goods markup (pricing menu)'), { label: 'Goods markup (pricing menu)', before: 'cost × 1.3', after: 'cost × 1.45' });
  for (const text of ['0.99', '5.01', '1.23456', 'x']) assert.ok(M.parseSettings({ ...form, goodsMarkup: text }, defaults).errors.goodsMarkup, text);
  // The shipped settings (and any saved before the setting existed) keep no field until the owner changes it.
  assert.equal(Object.hasOwn(defaults, 'goodsMarkup'), false);
  assert.equal(Object.hasOwn(M.parseSettings(M.settingsForm(defaults, 'owner-older'), defaults).settings, 'goodsMarkup'), false);
  // The installation confirmation works the same way.
  assert.equal(form.goodsInstallationIncluded, false);
  assert.equal(Object.hasOwn(M.parseSettings(form, defaults).settings, 'goodsInstallationIncluded'), false);
  const included = M.parseSettings({ ...form, goodsInstallationIncluded: true }, defaults).settings;
  assert.equal(included.goodsInstallationIncluded, true);
  assert.doesNotThrow(() => validatePricingSettings(included));
  assert.deepEqual(JSON.parse(JSON.stringify(M.settingsChanges(defaults, included))).find(row => row.label.startsWith('Installation included')), { label: 'Installation included in goods prices (pricing menu)', before: 'No', after: 'Yes' });
  assert.equal(M.parseSettings(M.settingsForm(included, 'owner-again'), included).settings.goodsInstallationIncluded, true, 'once saved it is kept');
});

test('the goods markup field and the Menu prices tab appear in the catalog screen only when the builder is on', async () => {
  const on = screen({ env: { ...BUILDER, CATALOG_QUOTES_ENABLED: 'true' } });
  await on.settle(() => on.root()?.querySelector('.cat-tabs')?.textContent.includes('Menu prices'), 'the Menu prices tab');
  assert.match(on.root().textContent, /Goods markup \(pricing-menu multiplier\)/);
  assert.match(on.root().textContent, /Shelving and storage installation is included in the goods price/);
  const off = screen({ env: { CATALOG_QUOTES_ENABLED: 'true' } });
  await off.settle(() => off.root()?.querySelector('.cat-tabs'), 'the catalog tabs');
  for (let round = 0; round < 50; round++) await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(off.root().textContent, /Goods markup|Menu prices|installation is included/);
});

// Regression (tests/e2e-estimator-crew-day.test.mjs): with only the builder flag on there is no Pricing tab, so the
// installation question is answered here, on Menu prices, and saved with the menu approvals (menu.approve).
test('catalog pricing off: the owner answers the installation question on Menu prices, reviews it and can take it back', async () => {
  const ui = screen();
  await ui.settle(() => ui.root()?.textContent.includes('pricing-menu prices are drafts'), 'the menu prices');
  assert.match(ui.root().textContent, /Catalog pricing is turned off/);
  assert.match(ui.root().textContent, /Builder quotes bill installation through the Labor line, but the labor estimate has install times only for shelving units and totes\./);
  assert.match(ui.root().textContent, /Builder quotes saved or signed before the Labor line existed wait for this answer too\. Tick it only if installation is included in the goods price\./);
  const box = () => ui.root().querySelector('#cat-menu-installation');
  assert.equal(box().checked, false);
  box().checked = true; box().dispatchEvent({ type: 'change', target: box() });
  ui.button('Review 1 change').click();
  const dialog = ui.document.body.querySelector('dialog');
  assert.match(dialog.textContent, /Answer the installation question/);
  assert.match(dialog.textContent, /Shelving and storage installationNot confirmedIncluded in the goods price/);
  ui.button('Save approvals').click();
  await ui.settle(() => ui.root().textContent.includes('Shelving and storage installation is now confirmed as included in the goods price: builder quotes no longer wait for install time the labor estimate leaves out, nor do older quotes saved before the Labor line.'), 'the saved answer');
  const post = ui.fs.posts.at(-1);
  assert.deepEqual([post.action, post.approve, post.revoke, post.goodsInstallationIncluded], ['menu.approve', [], [], true]);
  assert.equal(ui.fs.get('pricingMenuApprovals/current').goodsInstallationIncluded, true);
  await ui.settle(() => ui.root().textContent.includes('You confirmed that shelving and storage installation is included in the goods price'), 'the reloaded answer');
  assert.doesNotMatch(ui.root().textContent, /is sent once the estimator sets its man-hours by hand/);
  assert.equal(box().checked, true);
  // Unticked and saved, goods quotes wait again.
  box().checked = false; box().dispatchEvent({ type: 'change', target: box() });
  ui.button('Review 1 change').click();
  assert.match(ui.document.body.querySelector('dialog').textContent, /Shelving and storage installationIncluded in the goods priceNot confirmed/);
  ui.button('Save approvals').click();
  await ui.settle(() => ui.root().textContent.includes('Installation is no longer confirmed'), 'the withdrawn answer');
  assert.equal(ui.fs.get('pricingMenuApprovals/current').goodsInstallationIncluded, false);
  // A manager sees the question but cannot answer it.
  const manager = screen({ who: MANAGER });
  await manager.settle(() => manager.root()?.querySelector('#cat-menu-installation'), 'the question');
  assert.ok(off(manager.root().querySelector('#cat-menu-installation')));
});

// D12: the labor rate every builder quote's Labor line charges per man-hour, set by the owner on Menu prices.
test('the owner sees the $53.00 labor rate on Menu prices, changes it, reviews it and saves it in one audited request', async () => {
  const ui = screen();
  await ui.settle(() => ui.root()?.textContent.includes('Labor: $53.00 per man-hour'), 'the labor rate');
  assert.match(ui.root().textContent, /Every builder quote with garage work has a Labor line: the estimated man-hours × this rate, on top of the menu prices\. A junk-only quote \(truck loads, with their special items and access charges\) has none: the truck-load price covers the crew's time\./);
  assert.match(ui.root().textContent, /pre-fills the man-hours from its own time estimate of the garage work .*never loading, hauling or disposal\), the same for any crew size/);
  assert.match(ui.root().textContent, /Customers see one amount, "Labor", never the man-hours or the rate\./);
  assert.match(ui.root().textContent, /Shelving and storage installation is billed through this line\. Your decision of 2026-10-19 \(\$53\.00 per man-hour\)\. The rate is approved/);
  const field = () => ui.root().querySelector('#cat-menu-labor-rate');
  assert.equal(field().value, '53.00');
  // A rate that is not dollars and cents is refused in the screen; nothing is sent.
  field().value = '40.555'; field().dispatchEvent({ type: 'input', target: field() }); field().dispatchEvent({ type: 'change', target: field() });
  const posts = ui.fs.posts.length;
  ui.button('Review 1 change').click();
  assert.match(ui.root().textContent, /Enter the labor rate per man-hour as dollars, from \$1\.00 to \$1,000\.00, like 53\.00\./);
  assert.equal(ui.fs.posts.length, posts);
  field().value = '45.00'; field().dispatchEvent({ type: 'input', target: field() }); field().dispatchEvent({ type: 'change', target: field() });
  assert.match(ui.root().textContent, /Review the change below to save it/);
  ui.button('Review 1 change').click();
  const dialog = ui.document.body.querySelector('dialog');
  assert.match(dialog.textContent, /Change the labor rate/);
  assert.match(dialog.textContent, /Labor rate per man-hour\$53\.00\$45\.00/);
  ui.button('Save approvals').click();
  await ui.settle(() => ui.root().textContent.includes('The labor rate is now $45.00 per man-hour'), 'the saved rate');
  assert.match(ui.root().textContent, /saved quotes at the old rate are saved again before they are sent, and jobs the customer already signed keep the rate they signed\./, 'a held signed job is never stranded by the new rate');
  const post = ui.fs.posts.at(-1);
  assert.deepEqual([post.action, post.approve, post.revoke, post.laborRatePerManHourCents, 'goodsInstallationIncluded' in post], ['menu.approve', [], [], 4500, false]);
  assert.equal(ui.fs.get('pricingMenuApprovals/current').laborRatePerManHourCents, 4500);
  assert.ok([...ui.fs.docs.keys()].some(key => key.startsWith('hub_audit/')), 'audited like every approval');
  await ui.settle(() => ui.root().textContent.includes('Labor: $45.00 per man-hour'), 'the reloaded rate');
  assert.match(ui.root().textContent, /You set this rate\./);
  // A manager sees the rate but cannot change it.
  const manager = screen({ who: MANAGER, fs: ui.fs });
  await manager.settle(() => manager.root()?.querySelector('#cat-menu-labor-rate'), 'the rate');
  assert.ok(off(manager.root().querySelector('#cat-menu-labor-rate')));
});

// A job held for a price the owner has not approved stays held through the sweep; once the owner approves it (here: the
// job's draft price approved since, outside this screen), the owner's Release held jobs button releases it on demand.
test('Menu prices shows the booked jobs waiting for prices, and the owner releases them with Release held jobs', async () => {
  const state = builderState();
  const priced = priceCompositeQuote(state, selection({ removal: [{ id: menuItem('Full truck load').id, quantity: 1 }, { id: mattress.id, quantity: 1 }], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } }), { complete: true });
  const quote = { composite_pricing: priced.compositePricing, line_items: priced.lineItems.map(({ id, kind, name, description, quantity, unitCents, totalCents }) => ({ id, kind, name, description, quantity, unitCents, totalCents })), catalog_version: priced.menuVersion, total: priced.totalCents / 100 };
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, fixtureOwner, { actorId: fixtureOwner.user, requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan: signedPlan(1, { quote, total: quote.total }) }, SIGNED_AT, { env: ON_ENV, compositeState: async () => state });
  const jobs = { ...f.store, heldJobIds: async () => [...f.rows.values()].filter(row => row.pricesPendingApproval?.status === 'pending').map(row => row.id) };
  const fs = firestore();
  // This menu version was swept already: opening the screen only counts the held jobs.
  fs.put(`pricingMenuApprovals/${HELD_RELEASE_MARKER}`, { menuVersion: menu.menuVersion });
  const ui = screen({ fs, jobs });
  await ui.settle(() => ui.root()?.textContent.includes('Booked jobs waiting for prices'), 'the held jobs');
  assert.match(ui.root().textContent, /1 booked job still waits for prices/);
  assert.deepEqual(fs.sweeps, [{ action: 'sweep' }]);
  // The mattress price is approved at the amount signed: the button releases the job.
  fs.put('pricingMenuApprovals/current', { approvals: builderState({ [mattress.id]: 7000 }).approvals.items, updatedBy: 'zacb' });
  ui.button('Release held jobs (1)').click();
  await ui.settle(() => ui.root().textContent.includes('1 booked job was released'), 'the release');
  assert.deepEqual([fs.sweeps.at(-1), f.job(signed.job.id).pricesPendingApproval, f.job(signed.job.id).pricesRelease.source], [{ action: 'release' }, null, 'held.release']);
  assert.equal(ui.root().textContent.includes('Release held jobs'), false, 'nothing left to release');
  // A manager sees the count but has no button.
  const manager = screen({ who: MANAGER, fs, jobs: { heldJobIds: async () => ['held-1'] } });
  await manager.settle(() => manager.root()?.textContent.includes('Booked jobs waiting for prices'), 'the manager view');
  assert.equal(manager.root().textContent.includes('Release held jobs'), false);
});

// A capped count (more than 1,000 held jobs) keeps its +, on the card and on the button.
test('Menu prices keeps the + on a capped held-jobs count', async () => {
  const fs = firestore();
  fs.put(`pricingMenuApprovals/${HELD_RELEASE_MARKER}`, { menuVersion: menu.menuVersion });
  const page = after => { const start = after ? Number(after.slice(5)) + 1 : 0; return Array.from({ length: 100 }, (_, i) => `held-${String(start + i).padStart(5, '0')}`); };
  const ui = screen({ fs, jobs: { heldJobIds: async (limit, after = '') => page(after).slice(0, limit) } });
  await ui.settle(() => ui.root()?.textContent.includes('Booked jobs waiting for prices'), 'the held jobs');
  assert.match(ui.root().textContent, /1000\+ booked jobs still wait for prices/);
  assert.ok(ui.button('Release held jobs (1000+)'));
});
