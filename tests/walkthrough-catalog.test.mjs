// LANE catalog (2026-10-19, owner: "make sure the walkthrough has all of the items we sell and offer and it's integrated
// natively into crew hub and walkthrough"). The walkthrough's cleaning add-ons follow its own garage size, with truck
// loads too: the builder carries the one-car pressure wash over and the server accepts it when the walkthrough garage is
// one-car (composite-quote.js garageSize; the signed handoff prices it with the signed plan's own scope.garages).
// Synthetic data only (tests/helpers/estimator-fixture.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument } from './helpers/hub-dom.mjs';
import { servedPricing } from './helpers/walkthrough-pricing.mjs';
import { builderMenu, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { NOW, ON_ENV, builderState, client, estimator, fixture, menu, menuItem, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const pick = (name, quantity = 1) => ({ id: menuItem(name).id, quantity });
const signedLines = priced => priced.lineItems.map(line => ({ id: line.id, kind: line.kind, name: line.name, description: line.description, quantity: line.quantity, unitCents: line.unitCents, totalCents: line.totalCents }));
const signedQuote = priced => ({ composite_pricing: priced.compositePricing, line_items: signedLines(priced), catalog_version: priced.menuVersion, total: priced.totalCents / 100 });
const handoff = (n, quote, scope = {}) => {
  const plan = signedPlan(n, { quote, total: quote.total });
  plan.scope = { ...plan.scope, ...scope };
  return { actorId: owner.user, requestId: randomUUID(), customerId: `c${n}`, sourceWalkthroughId: `w${n}`, sourceRevision: `w${n}r`, plan };
};

test('the signed handoff prices a one-car pressure wash with a truck load by the signed plan\'s garage size', async () => {
  const state = builderState(), sel = selection({ removal: [pick('Full truck load'), pick('Pressure washing, one-car')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } });
  const priced = priceCompositeQuote(state, { ...sel, garageSize: '1' }, { complete: true });
  assert.deepEqual(priced.lineItems.map(line => line.id), ['removal-junk-full', 'service-egc-006', 'labor']);
  const f = fixture(), signed = await saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(priced), { garages: '1', finish: ['cleanout', 'pressure_wash'] }), NOW, { env: ON_ENV, compositeState: async () => state });
  const job = f.job(signed.job.id);
  assert.equal(job.total, priced.totalCents / 100);
  assert.equal(job.compositeQuote.compositePricing.garageSize, '1', 'the signed selection keeps the garage it was priced for');
  // The page's size never decides: a two-car plan, or one without a known size, refuses the one-car wash with no base.
  for (const garages of ['2', 'garage']) {
    await assert.rejects(saveWalkthroughHandoff(fixture().store, owner, handoff(1, signedQuote(priced), { garages }), NOW, { env: ON_ENV, compositeState: async () => state }),
      error => error.code === 'quote_draft_composite_invalid_selection' && /one-car garage only/.test(error.message), garages);
  }
  // A selection that names no garage is priced exactly as before (no base: no pressure wash).
  const plainSel = priceCompositeQuote(state, selection({ removal: [pick('Full truck load')], shelving: [], storage: [], labor: null }), { complete: true });
  const g = fixture(), plainSigned = await saveWalkthroughHandoff(g.store, owner, handoff(2, signedQuote(plainSel), { garages: '1' }), NOW, { env: ON_ENV, compositeState: async () => state });
  assert.equal(Object.hasOwn(g.job(plainSigned.job.id).compositeQuote.compositePricing, 'garageSize'), false);
});

test('a re-saved builder quote that only adds or changes the walkthrough garage size is not a material revision', async () => {
  const state = builderState(), f = fixture(), options = { env: ON_ENV, compositeState: async () => state };
  const first = priceCompositeQuote(state, selection({ labor: { manHours: 6, fullness: 'medium' } }), { complete: true });
  const input = (pricing, lines, extra = {}) => ({ requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', ...extra,
    draft: { client: client(1), title: 'Garage reset', scope: 'Reset.', line_items: lines, valid_until: '2026-10-30', catalog_version: first.menuVersion, crew_size: 2, estimated_duration_min: 180, composite_pricing: pricing } });
  const saved = await saveQuoteDraft(f.store, estimator, input(first.compositePricing, first.lineItems), NOW, options);
  const row = f.rows.get(`jobs/${saved.job.id}`);
  Object.assign(row.estimate, { status: 'sent', sentRevision: 1, sentAt: NOW });
  row.customerApproval = { status: 'approved', approvedAt: NOW, amount: first.totalCents / 100 };
  // The same selection from an updated page names the walkthrough garage: same lines, same total.
  const again = priceCompositeQuote(state, { ...selection({ labor: { manHours: 6, fullness: 'medium' } }), garageSize: '2' }, { complete: true });
  assert.deepEqual(again.lineItems, first.lineItems);
  await saveQuoteDraft(f.store, estimator, input(again.compositePricing, again.lineItems, { jobId: row.id, expectedRevision: f.job(saved.job.id).revision }), NOW, options);
  const after = f.job(saved.job.id);
  assert.deepEqual([after.estimate.revision, after.estimate.status, after.customerApproval.status], [1, 'sent', 'approved']);
  assert.equal(after.quoteDraft.compositePricing.garageSize, '2', 'the garage size is still saved');
});

// ---- The walkthrough's Scope and Finish with the builder menu (crew/gameplan-catalog.js) ----
const catalogSource = readFileSync(new URL('../crew/gameplan-catalog.js', import.meta.url), 'utf8');
const quoteSource = readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8');
const gameplanHtml = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
const pageLine = prefix => gameplanHtml.split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
const servedMenu = (approvals = {}) => ({ ok: true, authority: 'employee_hub', enabled: true, ...builderMenu(builderState(approvals)) });
const plainOf = value => JSON.parse(JSON.stringify(value));

function catalogPage({ builder = true, reply = () => ({ status: 200, body: servedMenu() }), S = {} } = {}) {
  const document = createDocument(), calls = { render: 0, save: 0, invalidate: 0, vehicles: 0, fetch: [] };
  const host = document.createElement('section'); host.setAttribute('id', 'finish-goods'); document.body.append(host);
  const context = { document, Node: document.Node, Intl, AbortController, setTimeout, clearTimeout, URLSearchParams, Date, console, navigator: { onLine: true }, addEventListener() {}, removeEventListener() {},
    S: { finish: ['cleanout'], shelfType: 'metal', shelfQty: 0, toteQty: 0, ...S }, walkthroughReady: true,
    render: () => { calls.render++; }, save: () => { calls.save++; }, invalidateAcceptance: () => { calls.invalidate++; }, mountCustomerVehicles: () => { calls.vehicles++; },
    EGCWalkthroughPricing: { quoteBuilder: () => builder },
    EGCHubAuth: { fetch: async url => { calls.fetch.push(url); const answer = reply(url); if (answer instanceof Error) throw answer; return { ok: answer.status < 300, status: answer.status, json: async () => structuredClone(answer.body) }; } } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(quoteSource, context);
  vm.runInContext(catalogSource, context);
  const button = name => host.querySelectorAll('button').find(node => node.getAttribute('aria-label') === name || node.textContent === name);
  return { context, calls, host, button, C: context.EGCGameplanCatalog, text: () => host.textContent };
}

test('with the builder on, Scope and Finish price items from the builder menu with their chips, never the walkthrough tables', async () => {
  const { C, calls } = catalogPage();
  assert.equal(C.active(), true);
  assert.match(C.loadsNote(), /Loading the quote builder prices/, 'before the menu answers');
  await C.load(); await C.load();
  assert.deepEqual(calls.fetch, ['/api/quote-draft?view=builder'], 'read once');
  const loads = C.loadsNote();
  for (const [name, price, chip] of [['Full truck load', '$750.00', 'Approved'], ['Three-quarter load', '$562.50', 'Draft price'], ['Half load', '$375.00', 'Draft price'], ['Quarter load', '$187.50', 'Draft price']]) {
    assert.match(loads, new RegExp(`<li><span>${name}</span> <span class="gp-price">\\${price} <span class="qb-chip[^"]*"[^>]*>${chip}</span></span></li>`), name);
  }
  assert.doesNotMatch(loads, /\$950/);
  assert.match(C.label('special', 'Mattress'), /^Mattress <span class="gp-price">\+\$70\.00 <span class="qb-chip" title="Draft price \$70\.00, not yet approved by the owner\.">Draft price<\/span><\/span>$/);
  assert.match(C.label('special', 'Hot tub / spa'), /\+\$600\.00/);
  assert.match(C.label('access', 'Stairs'), /\+\$190\.00/);
  assert.equal(C.label('access', 'Narrow gate / alley'), 'Narrow gate / alley', 'a note-only access choice has no price');
  assert.match(C.label('hazard', 'Pest waste'), /\+\$300\.00/);
  assert.equal(C.label('hazard', 'Mold / moisture'), 'Mold / moisture');
  assert.equal(C.label('special', '<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.match(C.finishTag('deep_clean', '1'), /\+\$190\.00/);
  assert.match(C.finishTag('deep_clean', '2'), /\+\$330\.00/);
  assert.match(C.finishTag('pressure_wash'), /\+\$600\.00/);
  assert.match(C.finishTag('mouse_trapping'), /\+\$375\.00 <span class="qb-chip"/);
  // An owner approval shows as Approved.
  const approved = catalogPage({ reply: () => ({ status: 200, body: servedMenu({ 'egc-012': 37500 }) }) });
  await approved.C.load();
  assert.match(approved.C.finishTag('mouse_trapping'), /qb-chip qb-ok"[^>]*>Approved</);
});

test('builder prices that cannot load say why with a retry; a Hub with the builder off keeps the walkthrough labels', async () => {
  const outage = catalogPage({ reply: () => ({ status: 503, body: { ok: false, code: 'quote_draft_unavailable', error: 'Synthetic outage.' } }) });
  await outage.C.load();
  assert.match(outage.C.loadsNote(), /Synthetic outage\. <button type="button" class="small-btn gp-retry" onclick="EGCGameplanCatalog\.load\(true\)">Retry builder prices<\/button>/);
  assert.equal(outage.C.label('special', 'Mattress'), 'Mattress', 'no price, never a legacy one');
  outage.C.mountGoods();
  assert.match(outage.text(), /Synthetic outage\.Retry builder prices/);
  const offline = catalogPage({ reply: () => new TypeError('Failed to fetch') });
  offline.context.navigator.onLine = false;
  await offline.C.load();
  assert.match(offline.C.loadsNote(), /The quote builder prices load when you are connected\./);
  const dropped = catalogPage({ reply: () => new TypeError('Failed to fetch') });
  await dropped.C.load();
  assert.match(dropped.C.loadsNote(), /could not load\. Check the connection and retry\./);
  const off = catalogPage({ reply: () => ({ status: 400, body: { ok: false, code: 'quote_draft_invalid_request', error: 'The quote lookup is invalid.' } }) });
  await off.C.load();
  assert.equal(off.C.active(), false, 'the Hub answered the builder is off');
  const flagOff = catalogPage({ builder: false });
  await flagOff.C.load();
  assert.deepEqual([flagOff.C.active(), flagOff.calls.fetch], [false, []]);
});

test('Finish picks shelving, totes and storage from the builder products into the walkthrough, with search, group and quantity', async () => {
  const page = catalogPage(), { C, context, host, button, calls } = page;
  await C.load();
  C.mountGoods();
  assert.match(page.text(), /No shelving, totes or storage yet\./);
  assert.equal(host.querySelectorAll('a').length, 0, 'no retailer link');
  // Nothing searched or grouped yet: no list of product photos (Finish stays a few phone screens long, the vehicles to
  // park in reach), a Browse all instead (integration review, 2026-10-21).
  const adds = () => host.querySelectorAll('button').filter(node => /^Add /.test(node.getAttribute('aria-label') || ''));
  const total = menu.products.filter(item => ['shelving', 'storage'].includes(item.section)).length;
  assert.equal(adds().length, 0);
  assert.match(page.text(), /Search or choose a group to see the products\./);
  button(`Browse all ${total} products`).click();
  assert.equal(adds().length, 12, 'one page of products');
  const shelf = menuItem('HDX plastic shelving, 36×72×24');
  button(`Add ${shelf.name}`).click();
  assert.deepEqual(JSON.parse(JSON.stringify(context.S.builderGoods)), { shelving: [{ id: shelf.id, quantity: 1, group: 'shelving', name: shelf.name, installPersonMinutes: 60 }], storage: [], by: 'finish' });
  assert.deepEqual([calls.invalidate, calls.save], [1, 1], 'a pick clears an earlier signature and saves the walkthrough');
  assert.equal(calls.vehicles, 1, 'the parking fit check below redraws with the pick (integration review, 2026-10-21)');
  assert.match(page.text(), /In this quote \(1\)/);
  button(`One more: ${shelf.name}`).click();
  assert.equal(context.S.builderGoods.shelving[0].quantity, 2);
  // The group filter and the search narrow the products offered.
  host.querySelector('select').dispatchEvent({ type: 'change', target: { value: 'bins-totes' } });
  const offered = () => host.querySelectorAll('button').filter(node => /^Add /.test(node.getAttribute('aria-label') || '')).map(node => node.getAttribute('aria-label').slice(4));
  const totes = menu.products.filter(item => item.group === 'bins-totes').map(item => item.name);
  assert.ok(offered().length > 0 && offered().every(name => totes.includes(name)), 'bins and totes only');
  host.querySelector('input').dispatchEvent({ type: 'input', target: { value: 'four-pack' } });
  assert.ok(offered().length > 0 && offered().every(name => /four-pack/i.test(name)));
  const tote = menu.products.find(item => item.name === offered()[0]);
  button(`Add ${tote.name}`).click();
  assert.deepEqual(JSON.parse(JSON.stringify(C.selection())), { shelving: [{ id: shelf.id, quantity: 2 }], storage: [{ id: tote.id, quantity: 1 }] }, 'what the builder opens with');
  button(`One fewer: ${tote.name}`).click();
  assert.deepEqual(plainOf(context.S.builderGoods.storage), []);
  // The builder wrote the same picks back: the walkthrough holds them and the builder keeps its own from then on.
  const before = calls.invalidate;
  C.fromBuilder({ shelving: [{ id: shelf.id, quantity: 2, group: 'shelving' }], storage: [] });
  assert.deepEqual(plainOf([context.S.builderGoods.by, C.selection(), calls.invalidate]), ['builder', null, before]);
  C.fromBuilder({ shelving: [{ id: shelf.id, quantity: 4, group: 'shelving' }], storage: [] });
  assert.equal(calls.invalidate, before + 1, 'a change in the builder clears an earlier signature');
  // A new walkthrough starts the product search and group over (resetUi, from the page's resetForWalkthrough), as the
  // vehicle search does: one customer's totes search never shows on the next customer's Finish.
  C.mountGoods();
  host.querySelector('input').dispatchEvent({ type: 'input', target: { value: 'tote' } });
  assert.ok(adds().length > 0);
  C.resetUi(); C.mountGoods();
  assert.equal(adds().length, 0, 'no search, no group: nothing listed');
  assert.ok(button(`Browse all ${total - 1} products`), 'the chosen shelving is not offered again');
  // Choosing "All shelving and storage" in the group list browses everything.
  host.querySelector('select').dispatchEvent({ type: 'change', target: { value: '' } });
  assert.equal(adds().length, 12);
});

test('Finish shows the built quote\'s goods when the walkthrough has no picks, and clears counts recorded before', async () => {
  const shelf = menuItem('HDX plastic shelving, 36×72×24');
  const page = catalogPage({ S: { finish: ['cleanout', 'shelving', 'totes'], shelfQty: 3, toteQty: 4, builderQuote: { compositePricing: { shelving: [{ id: shelf.id, quantity: 2 }], storage: [] } } } });
  await page.C.load();
  page.C.mountGoods();
  assert.match(page.text(), /In this quote \(1\)/);
  assert.equal(page.host.querySelectorAll('output').find(node => node.parentNode.getAttribute('aria-label') === `${shelf.name} quantity`).textContent, '2');
  assert.equal(page.C.selection(), null, 'nothing to push into the builder until Finish changes it');
  assert.match(page.text(), /Recorded earlier on this walkthrough: 3 metal shelving units; 4 labeled totes\./);
  page.button('Clear note').click();
  assert.deepEqual(plainOf([page.context.S.finish, page.context.S.shelfQty, page.context.S.toteQty]), [['cleanout'], 0, 0]);
});

// The gameplan's own lines: the signature gate, the bring list and the job time read the Finish picks.
function gameplanLines(state = {}) {
  const context = vm.createContext({ PRICING: servedPricing(), window: { EGCWalkthroughPricing: { quoteBuilder: () => true } }, validateStep: () => [], PHOTO_COUNT: 3 });
  vm.runInContext(pageLine('const freshState='), context);
  context.S = Object.assign(vm.runInContext('freshState()', context), { name: 'Synthetic Customer', garageSize: '2', fill: 'medium', loads: '1', crewSize: '2', approved: true, acceptanceAt: '2026-10-19T15:00:00.000Z', signature: 'data:image/png;base64,AA==' }, state);
  for (const prefix of ['function quoteBuilderOn(', 'function builderJunkOnly(', 'function recommend(', 'function estimatedJobMinutes(', 'function buildJobInstructions(', 'function readyToSend(']) vm.runInContext(pageLine(prefix), context);
  return context;
}
const builtQuote = (goods = {}) => ({ compositePricing: { steps: ['removal', 'shelving', 'storage'], removal: [{ id: 'egc-003', quantity: 1 }], shelving: [], storage: [], labor: { manHours: 6 }, ...goods }, totalCents: 129300,
  lineItems: [{ id: 'removal-base', kind: 'service', name: 'Two-car garage base', description: '', quantity: 1, unitCents: 97500, totalCents: 97500 }, { id: 'labor', kind: 'labor', name: 'Labor', description: '', quantity: 1, unitCents: 31800, totalCents: 31800 }] });

test('the walkthrough is not signed while its Finish picks differ from the built quote; the bring list and job time follow the picks', () => {
  const shelf = menuItem('HDX plastic shelving, 36×72×24'), tote = menuItem('HDX 27-gal totes, four-pack');
  const page = gameplanLines({ builderQuote: builtQuote() });
  assert.equal(page.builderSignGate(), '', 'no picks: the built quote is signed as before');
  const plain = page.buildJobInstructions({}), minutes = page.estimatedJobMinutes();
  page.S.builderGoods = { shelving: [{ id: shelf.id, quantity: 2, group: 'shelving', installPersonMinutes: 60 }], storage: [{ id: tote.id, quantity: 1, group: 'bins-totes', installPersonMinutes: 32 }, { id: 'hd-x', quantity: 1, group: 'overhead' }], by: 'finish' };
  assert.equal(page.builderSignGate(), 'goods');
  assert.match(page.builderGateText('goods'), /changed since this quote was built\. Tap Edit the quote: the builder opens with the Finish picks/);
  assert.ok(page.readyToSend().includes('the quote saved again with the shelving and storage chosen on Finish (Edit the quote)'));
  // The same picks in the quote, in any order: signed.
  page.S.builderQuote = builtQuote({ shelving: [{ id: shelf.id, quantity: 2 }], storage: [{ id: 'hd-x', quantity: 1 }, { id: tote.id, quantity: 1 }] });
  assert.equal(page.builderSignGate(), '');
  const bring = page.buildJobInstructions({}).bringList;
  assert.deepEqual(plainOf(bring.filter(item => !plain.bringList.includes(item))), ['Drill / driver', 'Stud finder', 'Level', 'Lag screws and anchors', 'Step ladder', 'Label maker']);
  // Two shelving units (2 x 60) and the totes (32) person-minutes over the calibrated crew of 2: 76 more minutes, rounded up.
  assert.equal(page.estimatedJobMinutes(), Math.ceil((minutes + 76) / 30) * 30);
  page.S.builderGoods = { shelving: [], storage: [{ id: tote.id, quantity: 1, group: 'bins-totes' }], by: 'builder' };
  assert.equal(page.estimatedJobMinutes(), minutes, 'a pick with no install time adds none');
  assert.deepEqual(plainOf(page.buildJobInstructions({}).bringList.filter(item => !plain.bringList.includes(item))), ['Label maker']);
  // With the builder off nothing changes.
  page.window.EGCWalkthroughPricing.quoteBuilder = () => false;
  assert.equal(page.builderSignGate(), '');
});

// Integration review (2026-10-21): the notes lane's storage-line rule and the catalog lane's group rules made one bring
// list ask for a "Ladder" and a "Step ladder", and for the wall-mounting kit for totes. One rule now: the Finish groups.
test('the bring list names one ladder and no install kit for totes: the Finish groups decide over the quote\'s storage line', () => {
  const storageLine = { id: 'storage-goods', kind: 'product', name: 'Extra storage', description: 'Synthetic storage × 1' };
  const quoteWith = goods => { const quote = builtQuote(goods); return { ...quote, lineItems: [...quote.lineItems, storageLine] }; };
  const plain = plainOf(gameplanLines().buildJobInstructions({}).bringList);
  const extras = state => plainOf(gameplanLines(state).buildJobInstructions({}).bringList).filter(item => !plain.includes(item));
  const rack = menu.products.find(item => item.group === 'overhead'), hooks = menu.products.find(item => item.group === 'hooks-racks'), tote = menuItem('HDX 27-gal totes, four-pack');
  const goods = (...rows) => ({ shelving: [], storage: rows.map(item => ({ id: item.id, quantity: 1, group: item.group })), by: 'builder' });
  const kit = ['Drill / driver', 'Stud finder', 'Level', 'Lag screws and anchors'];
  assert.deepEqual(extras({ builderQuote: quoteWith({ storage: [{ id: rack.id, quantity: 1 }] }), builderGoods: goods(rack) }), [...kit, 'Step ladder'], 'an overhead rack: the kit and one ladder');
  assert.deepEqual(extras({ builderQuote: quoteWith({ storage: [{ id: tote.id, quantity: 1 }] }), builderGoods: goods(tote) }), ['Label maker'], 'totes only: a label maker');
  assert.deepEqual(extras({ builderQuote: quoteWith({ storage: [{ id: hooks.id, quantity: 1 }] }), builderGoods: goods(hooks) }), [...kit, 'Step ladder'], 'wall hooks: the ladder the owner listed for racks, hooks and cabinets');
  assert.deepEqual(extras({ builderGoods: { ...goods(rack), by: 'finish' } }), [...kit, 'Step ladder'], 'picked on Finish, before any quote');
  // A quote with no Finish groups to go by (none picked): its storage line brings the storage tools, with the same ladder.
  assert.deepEqual(extras({ builderQuote: quoteWith({}) }), ['Step ladder', 'Drill / driver', 'Stud finder', 'Lag screws and anchors']);
  assert.deepEqual(extras({ builderQuote: quoteWith({}), builderGoods: { shelving: [], storage: [{ id: 'hd-gone', quantity: 1 }], by: 'builder' } }), ['Step ladder', 'Drill / driver', 'Stud finder', 'Lag screws and anchors'], 'a product the menu no longer lists');
  for (const state of [{ builderQuote: quoteWith({}) }, { builderGoods: goods(rack, tote, hooks) }]) assert.equal(gameplanLines(state).buildJobInstructions({}).bringList.includes('Ladder'), false);
});

// ---- Review findings (LANE catalog review, 2026-10-19) ----
test('a truck-load quote with a deep clean signed for another garage size is refused before anything is saved', async () => {
  // The quote was built and saved on a two-car walkthrough; the plan the homeowner signs now records three cars.
  const state = builderState(), sel = selection({ removal: [pick('Full truck load', 2), pick('Deep cleaning, two-car')], shelving: [], storage: [], labor: { manHours: null, fullness: 'medium' } });
  const priced = priceCompositeQuote(state, { ...sel, garageSize: '2' }, { complete: true });
  const f = fixture(), before = new Map([...f.rows].map(([key, row]) => [key, JSON.stringify(row)]));
  await assert.rejects(saveWalkthroughHandoff(f.store, owner, handoff(1, signedQuote(priced), { garages: '3', finish: ['cleanout', 'deep_clean'] }), NOW, { env: ON_ENV, compositeState: async () => state }),
    error => error.code === 'quote_draft_composite_invalid_selection' && error.status === 400 && /deep clean must match the walkthrough's garage size/.test(error.message));
  assert.deepEqual([...f.rows.keys()].sort(), [...before.keys()].sort(), 'no job or receipt was written, so the page may release the request');
  for (const [key, row] of f.rows) assert.equal(JSON.stringify(row), before.get(key), key);
  // Signed on the garage it was built for, it saves.
  const g = fixture(), saved = await saveWalkthroughHandoff(g.store, owner, handoff(1, signedQuote(priced), { garages: '2', finish: ['cleanout', 'deep_clean'] }), NOW, { env: ON_ENV, compositeState: async () => state });
  assert.equal(g.job(saved.job.id).total, priced.totalCents / 100);
});

test('Review is not signed while the quote was built for another garage size, and names the Finish picks before the quote is built', () => {
  const shelf = menuItem('HDX plastic shelving, 36×72×24');
  const page = gameplanLines({ builderQuote: builtQuote({ garageSize: '2' }) });
  assert.equal(page.builderSignGate(), '', 'built for the walkthrough garage: signed');
  page.S.garageSize = '3';
  assert.equal(page.builderSignGate(), 'size');
  assert.equal(page.builderGateText('size'), 'The garage size changed since this quote was built: it was priced for a 2-car garage, and the walkthrough now records a 3-car garage. Tap Edit the quote: the builder sizes the deep clean and pressure wash to this garage. Check the cleaning base, review the quote and save it again; the homeowner then signs that quote.');
  assert.ok(page.readyToSend().includes('the quote saved again for this garage size (Edit the quote)'));
  page.S.garageSize = 'other';
  assert.match(page.builderGateText('size'), /now records a larger garage\./);
  page.S.garageSize = '2';
  assert.equal(page.builderSignGate(), '');
  // A quote saved before the builder named the garage (no garageSize) is signed as before.
  page.S.builderQuote = builtQuote();
  page.S.garageSize = '3';
  assert.equal(page.builderSignGate(), '');
  // The Review summary names the products picked on Finish (the quote is not built yet).
  page.S.builderGoods = { shelving: [{ id: shelf.id, quantity: 2, group: 'shelving', name: shelf.name }], storage: [{ id: 'hd-x', quantity: 1 }], by: 'finish' };
  assert.deepEqual(plainOf(page.builderGoodsText()), [`${shelf.name} × 2`, 'hd-x × 1']);
  page.S.builderGoods = { shelving: [{ id: shelf.id, quantity: 0, name: shelf.name }], storage: [], by: 'finish' };
  assert.deepEqual(plainOf(page.builderGoodsText()), []);
});

test('only a saved builder quote writes its goods back, so a signature survives looking around in the builder', async () => {
  const shelf = menuItem('HDX plastic shelving, 36×72×24');
  const page = catalogPage({ S: { builderGoods: { shelving: [{ id: shelf.id, quantity: 1, group: 'shelving' }], storage: [], by: 'builder' } } });
  await page.C.load();
  const renders = page.calls.render;
  // The saved quote holds the same goods: nothing changes, no signature is cleared and nothing re-renders.
  page.C.fromBuilder({ shelving: [{ id: shelf.id, quantity: 1, group: 'shelving' }], storage: [] });
  assert.deepEqual([page.calls.invalidate, page.calls.render], [0, renders]);
  // Different goods saved: the walkthrough follows them and re-renders whichever step is showing (Review, behind the builder).
  page.context.index = 5;
  page.C.fromBuilder({ shelving: [{ id: shelf.id, quantity: 2, group: 'shelving' }], storage: [] });
  assert.deepEqual([page.calls.invalidate, page.calls.render, page.context.S.builderGoods.shelving[0].quantity], [1, renders + 1, 2]);
  // The handoff passes only the Finish picks to the builder (by: 'finish'), and the builder writes back only on a save.
  const handoffSource = readFileSync(new URL('../crew/gameplan-handoff.js', import.meta.url), 'utf8');
  assert.match(handoffSource, /goods:\(\)=>root\.EGCGameplanCatalog\?root\.EGCGameplanCatalog\.selection\(\):null,onGoods:goods=>root\.EGCGameplanCatalog\?\.fromBuilder\(goods\)/);
  assert.equal((quoteSource.match(/writeGoods\(\)/g) || []).length, 1, 'one call: after the save');
  assert.match(quoteSource, /S\.sel = validSelection\(selectionOfPricing\(result\.job\.compositePricing, result\.job\.breakdown, S\.menu\), S\.menu\); keep\(\); writeGoods\(\);/);
});

test('with the menu unavailable Finish keeps the walkthrough shelving and tote cards; once loaded it offers the products', async () => {
  let down = true;
  const page = catalogPage({ reply: () => down ? new TypeError('Failed to fetch') : { status: 200, body: servedMenu() } });
  assert.equal(page.C.unavailable(), false, 'not before a load failed');
  await page.C.load();
  assert.equal(page.C.unavailable(), true);
  page.C.mountGoods();
  assert.match(page.text(), /Until the prices load, record shelving and totes with Add shelving and Add labeled totes above\./);
  // A retry in flight keeps the cards until the menu arrives.
  down = false;
  const retry = page.C.load(true);
  assert.equal(page.C.unavailable(), true);
  await retry;
  assert.equal(page.C.unavailable(), false);
  page.C.mountGoods();
  assert.doesNotMatch(page.text(), /Until the prices load/);
  // The Finish template shows the cards (and their counts) exactly while the builder prices are unavailable, never the
  // dead mounting panel with the builder on.
  const finish = pageLine("()=>{const gc=builderPrices()?EGCGameplanCatalog:null,legacy=!gc||gc.unavailable?.()===true;return title('Finish'");
  assert.match(finish, /\$\{legacy\?`<button type="button" class="service \$\{S\.finish\.includes\('shelving'\)/);
  assert.match(finish, /\$\{legacy&&S\.finish\.includes\('shelving'\)\?/);
  assert.match(finish, /\$\{legacy&&S\.finish\.includes\('totes'\)\?/);
  assert.match(finish, /\$\{gc\?'<section class="panel" id="finish-goods"[^']*><\/section>':'<section class="panel" id="mounting-options"><\/section>'\}/);
  assert.match(gameplanHtml, /<script src="\/crew\/gameplan-catalog\.js\?v=20261021field4" defer><\/script>/, 'the changed picker has a new cache key (integration review)');
});

test('the menu arriving re-renders only Scope and Finish, keeping the field in focus', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const page = catalogPage({ reply: () => ({ status: 200, body: servedMenu() }) });
  const fetch = page.context.EGCHubAuth.fetch;
  page.context.EGCHubAuth.fetch = async url => { await held; return fetch(url); };
  page.context.index = 0;
  const loading = page.C.load();
  release(); await loading;
  assert.equal(page.calls.render, 0, 'Customer is not re-rendered: the contact search keeps its text and focus');
  // On Scope the page re-renders, and the field that had focus gets it back with its caret.
  const field = page.context.document.createElement('input'); field.setAttribute('id', 'f-loads'); page.context.document.body.append(field);
  const focused = [];
  page.context.document.activeElement = field;
  // Each render replaces the field (as the page's innerHTML does), and the new one starts without focus.
  page.context.render = () => {
    page.calls.render++;
    const doc = page.context.document, fresh = doc.createElement('input');
    fresh.setAttribute('id', 'f-loads'); fresh.selectionStart = 1; fresh.selectionEnd = 2;
    fresh.focus = () => { focused.push('f-loads'); doc.activeElement = fresh; }; fresh.setSelectionRange = (...range) => focused.push(range.join('-'));
    doc.getElementById('f-loads')?.remove(); doc.body.append(fresh); doc.activeElement = doc.body;
  };
  field.selectionStart = 1; field.selectionEnd = 2;
  page.context.index = 2;
  await page.C.load(true);
  assert.equal(page.calls.render, 2, 'loading, then loaded');
  assert.deepEqual(focused, ['f-loads', '1-2', 'f-loads', '1-2']);
});
