import test from 'node:test';
import assert from 'node:assert/strict';
import vm from './helpers/vm-realm.mjs';
import { readFileSync } from 'node:fs';
import { builderMenu, priceCompositeQuote } from '../functions/_lib/composite-quote.js';
import { walkthroughPricing, walkthroughServiceItems } from '../functions/_lib/pricing-config.js';
import { PICKUP_MINIMUM_CENTS } from '../functions/_lib/pickup-minimum.js';

// The walkthrough's guided builder in crew/quote-draft.js (removal, then shelving, then extra storage). The page holds
// only the selection; prices come from GET /api/quote-draft?view=builder and every step is priced by the server.
const source = readFileSync(new URL('../crew/quote-draft.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, Date });
vm.runInContext(source, context);
const { createClient, builder: B } = context.window.EGCQuoteDraft;
const plain = value => JSON.parse(JSON.stringify(value));
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const menuDoc = readJson('../functions/_data/pricing-menu.json'), settings = readJson('../functions/_data/pricing-settings.defaults.json');
const state = { menu: menuDoc, settings, walkthrough: walkthroughPricing(walkthroughServiceItems()), approvals: { items: {}, revision: null } };
// What the server sends a sales login.
const menu = plain({ ok: true, enabled: true, ...builderMenu(state, { internal: false }) });
const byName = name => menu.services.find(item => item.name === name) || menu.products.find(item => item.name === name);
const shelf = menu.products.find(item => item.id === 'hd-100006678');

// The walkthrough payload as crew/gameplan.html payload() builds it (the parts the builder reads).
const plan = () => ({ client: { name: 'Synthetic Customer', phone: '+19705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'contact-1' },
  quote: { title: 'EGC Garage Service — 100 Fixture Lane', estimated_duration_min: 240, line_items: [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 90000, totalCents: 90000 }] },
  scope: { garages: '2', loads: '1.5', fullness: 'Full', special_items: ['Mattress', 'Couch / sofa / loveseat'], access: ['Stairs', 'Narrow gate / alley'], finish: ['cleanout', 'deep_clean', 'pressure_wash', 'mouse_trapping'], hazards: ['Pest waste'], keep_items: 'Albums' },
  raw: { specialQty: { Mattress: 2 } }, logistics: { crew_size: 2 }, signature: 'data:image/png;base64,UNUSED', discovery: { success: 'Park car' } });

test('the walkthrough capture pre-fills the removal step: loads, special items, access and cleaning add-ons; a base only without loads', () => {
  const sel = plain(B.selectionFromWalkthrough(plan(), menu));
  const names = removal => Object.fromEntries(Object.entries(removal).map(([id, qty]) => [menu.services.find(item => item.id === id).name, qty]));
  const named = names(sel.removal);
  // The draft base is the walkthrough's old full-service price (hauling included): with truck loads it is not pre-selected.
  assert.deepEqual(named, { 'Full truck load': 1, 'Half load': 1, Mattress: 2, 'Sofa / loveseat': 1, Stairs: 1, 'Deep cleaning, two-car': 1, 'Mouse trapping': 1, 'Pest-waste cleanup': 1 });
  assert.equal(named['Pressure washing, one-car'], undefined, 'a pressure wash is offered for a one-car garage only');
  const cleaningOnly = names(B.selectionFromWalkthrough({ scope: { garages: '1', loads: '0', finish: ['deep_clean', 'pressure_wash'] } }, menu).removal);
  assert.deepEqual(plain(cleaningOnly), { 'One-car garage base': 1, 'Pressure washing, one-car': 1, 'Deep cleaning, one-car': 1 }, 'a cleaning-only walkthrough gets its garage base');
  // The pressure wash and the deep clean follow the walkthrough's garage size, with truck loads (no base) too.
  const hauledPlan = { scope: { garages: '1', loads: '1', finish: ['pressure_wash', 'deep_clean'] } }, hauledSel = B.selectionFromWalkthrough(hauledPlan, menu);
  assert.deepEqual(plain(names(hauledSel.removal)), { 'Full truck load': 1, 'Deep cleaning, one-car': 1, 'Pressure washing, one-car': 1 }, 'a one-car walkthrough with a truck load keeps its pressure wash');
  assert.equal(B.garageOf(hauledPlan), '1');
  const hauledStep = plain(B.builderDescriptor(menu, hauledSel, 'removal', null, B.garageOf(hauledPlan)));
  assert.equal(hauledStep.garageSize, '1', 'every step names the walkthrough garage');
  assert.ok(priceCompositeQuote(state, hauledStep), 'the server accepts the one-car wash with a truck load');
  assert.throws(() => priceCompositeQuote(state, { ...hauledStep, garageSize: undefined }), /one-car garage only/, 'without the walkthrough size the server refuses it, as before');
  assert.deepEqual(plain(names(B.selectionFromWalkthrough({ scope: { garages: '2', loads: '1', finish: ['pressure_wash'] } }, menu).removal)), { 'Full truck load': 1 }, 'never for a two-car garage');
  assert.equal(Object.hasOwn(plain(B.builderDescriptor(menu, hauledSel, 'removal')), 'garageSize'), false, 'no size known, none sent');
  for (const [garages, size] of [['other', 'other'], [' 3 ', '3'], [2, '2'], ['4', null], ['', null], [undefined, null]]) assert.equal(B.garageOf({ scope: { garages } }), size, String(garages));
  assert.ok(priceCompositeQuote(state, plain(B.builderDescriptor(menu, B.selectionFromWalkthrough(plan(), menu), 'removal'))), 'the server accepts the pre-filled step');
  assert.deepEqual([sel.shelving, sel.storage], [[], []], 'shelving and storage are always chosen in the builder');
  const loads = value => Object.keys(B.selectionFromWalkthrough({ scope: { loads: value } }, menu).removal).map(id => [menu.services.find(item => item.id === id).name, B.selectionFromWalkthrough({ scope: { loads: value } }, menu).removal[id]]);
  assert.deepEqual(plain(loads('0.25')), [['Quarter load', 1]]);
  assert.deepEqual(plain(loads('2.9')), [['Full truck load', 3]], 'a near-full partial rounds up to a truck');
  assert.deepEqual(plain(loads('')), []);
  assert.deepEqual(plain(B.selectionFromWalkthrough({}, menu)), { removal: {}, shelving: [], storage: [], labor: { manHours: null, adjusted: false } }, 'the labor starts from the estimate');
});

test('the builder sends only finished steps, in order, with ids and quantities; the server accepts what it sends', () => {
  const sel = B.selectionFromWalkthrough(plan(), menu);
  sel.shelving.push({ id: shelf.id, quantity: 2 });
  const removalOnly = plain(B.builderDescriptor(menu, sel, 'removal'));
  assert.deepEqual([removalOnly.steps, removalOnly.shelving, removalOnly.storage], [['removal'], [], []], 'a later step is never sent before it is finished');
  assert.ok(removalOnly.removal.every(entry => Object.keys(entry).join() === 'id,quantity'));
  assert.equal('labor' in removalOnly, false, 'a step preview carries no labor');
  // The whole quote carries the labor once the estimator entered the crew (owner decision 2026-10-30: people x hours on
  // site for the whole crew): before that it is priced without a Labor line, and a save is refused for it. The crew, its
  // man-hours (which the server works out again), set by hand, and the walkthrough's garage fullness ('Full') are sent;
  // never a rate or a total.
  const fullness = B.fullnessOf(plan());
  assert.equal(fullness, 'full');
  assert.deepEqual([B.fullnessOf({ scope: { fullness: 'Stuffed' } }), B.fullnessOf({})], [null, null]);
  const unpriced = plain(B.builderDescriptor(menu, sel, 'storage', fullness));
  assert.equal('labor' in unpriced, false, 'no crew entered yet: no labor, and no time estimate in its place');
  assert.equal(priceCompositeQuote(state, unpriced).labor, null, 'the review prices it without a Labor line');
  assert.throws(() => priceCompositeQuote(state, unpriced, { complete: true }), { code: 'quote_draft_composite_labor_required' }, 'a save needs the Labor line');
  assert.equal(plain(B.runningTotals(menu, sel, fullness)).laborHours, null, 'the running total waits for the crew too');
  sel.labor = { manHours: 6.75, adjusted: true, people: 3, hours: 2.25 };
  const all = plain(B.builderDescriptor(menu, sel, 'storage', fullness));
  assert.deepEqual(all.steps, ['removal', 'shelving', 'storage']);
  assert.deepEqual([all.menuVersion, all.settingsVersion], [menu.menuVersion, menu.settingsVersion]);
  assert.deepEqual(all.labor, { manHours: 6.75, adjusted: true, fullness: 'full', people: 3, hours: 2.25 });
  assert.doesNotMatch(JSON.stringify(all), /rateCents|totalCents|unitCents|crewSize|onSiteMinutes/, 'no price and no time estimate of any kind leaves the browser');
  // 3 people x 2.25 hours on site = 6.75 man-hours x $53.00 = $357.75, kept with the crew on the saved selection.
  const priced = priceCompositeQuote(state, all, { complete: true });
  assert.deepEqual(priced.compositePricing.labor, { manHours: 6.75, adjusted: true, fullness: 'full', people: 3, hours: 2.25 }, 'the selection keeps the crew');
  assert.deepEqual([priced.labor.manHours, priced.labor.people, priced.labor.hours, priced.labor.totalCents, priced.labor.adjusted], [6.75, 3, 2.25, 35775, true]);
  assert.deepEqual([priced.breakdown.labor.people, priced.breakdown.labor.hours], [3, 2.25], 'and so does the breakdown, for the office and dispatch');
  // The server works the man-hours out itself: a browser number that is not people x hours, a seventh person, hours that
  // are not quarter hours or a crew over 200 man-hours are refused.
  for (const labor of [{ ...all.labor, manHours: 7 }, { ...all.labor, people: 7, manHours: 15.75 }, { ...all.labor, hours: 2.1, manHours: null }, { ...all.labor, people: 6, hours: 40, manHours: null }, { ...all.labor, people: 2, hours: undefined }, { ...all.labor, adjusted: false }]) {
    assert.throws(() => priceCompositeQuote(state, { ...all, labor }, { complete: true }), { code: 'quote_draft_composite_invalid_labor' }, JSON.stringify(labor));
  }
  const totals = plain(B.runningTotals(menu, sel, fullness));
  assert.deepEqual([totals.labor, totals.laborHours, totals.junkOnly], [35775, 6.75, false], 'the running total prices the crew as the server does');
  assert.deepEqual([totals.removal + totals.shelving + totals.storage + totals.labor, totals.total], [priced.totalCents, priced.totalCents], 'the running total matches the server price');
  assert.equal(totals.shelving, 23140);
  assert.equal(totals.drafts, Object.keys(sel.removal).length + 1 - 2, 'every selected price but the approved full truck and half load (2026-10-21) is a draft');
});

test('a saved selection is checked against the current menu: unknown items, wrong steps and bad quantities are dropped', () => {
  const kept = plain(B.validSelection({ removal: { [byName('Mattress').id]: 3, 'egc-999': 1, [byName('Stairs').id]: 0 }, shelving: [{ id: shelf.id, quantity: 2 }, { id: shelf.id, quantity: 5 }, { id: menu.products.find(item => item.section === 'storage').id, quantity: 1 }], storage: [{ id: 'hd-1', quantity: 1 }] }, menu));
  assert.deepEqual(kept, { removal: { [byName('Mattress').id]: 3 }, shelving: [{ id: shelf.id, quantity: 2 }], storage: [], labor: { manHours: null, adjusted: false } });
  assert.deepEqual(plain(B.validSelection(null, menu)), { removal: {}, shelving: [], storage: [], labor: { manHours: null, adjusted: false } });
  // The man-hours are kept when they are 0.5 to 200 quarter hours; anything else goes back to the estimate.
  for (const [value, expected] of [[6.25, 6.25], [0.5, 0.5], [200, 200], [0.25, null], [200.25, null], [6.1, null], ['6', null], [null, null]]) {
    assert.deepEqual(plain(B.validSelection({ labor: { manHours: value } }, menu).labor), { manHours: expected, adjusted: false }, String(value));
  }
  // "Set by hand" goes with a number only.
  assert.deepEqual(plain(B.validSelection({ labor: { manHours: 6, adjusted: true } }, menu).labor), { manHours: 6, adjusted: true });
  assert.deepEqual(plain(B.validSelection({ labor: { manHours: null, adjusted: true } }, menu).labor), { manHours: null, adjusted: false });
});

test('the saved draft carries the server-priced lines and selection, the walkthrough capture and no signature or raw state', () => {
  const sel = B.selectionFromWalkthrough(plan(), menu);
  sel.storage.push({ id: menu.products.find(item => item.group === 'overhead').id, quantity: 1 });
  sel.labor = { manHours: 5, adjusted: true, people: 2, hours: 2.5 };
  const priced = plain(priceCompositeQuote(state, plain(B.builderDescriptor(menu, sel, 'storage', B.fullnessOf(plan()))), { complete: true }));
  const { storedLineItems, ...preview } = priced;
  const draft = plain(B.compositeDraft(plan(), preview, '2026-10-31'));
  assert.deepEqual(draft.line_items, preview.lineItems);
  assert.deepEqual(draft.composite_pricing, preview.compositePricing);
  assert.equal(draft.catalog_version, menu.menuVersion);
  assert.deepEqual([draft.client.name, draft.valid_until, draft.crew_size, draft.estimated_duration_min], ['Synthetic Customer', '2026-10-31', 2, 240]);
  // The estimator's crew, 2 people x 2.5 hours on site, is 5 man-hours, set by hand. The customer's scope and line say
  // "Labor", never the man-hours (D-LABOR-TEXT); the selection keeps them, and the crew, for the staff.
  assert.match(draft.scope, /^Removal \/ cleanout: Full truck load; Half load; Mattress × 2;.*\. Extra storage: .+\. Labor\.$/);
  assert.deepEqual([draft.line_items.at(-1).id, draft.line_items.at(-1).name, draft.line_items.at(-1).description, draft.composite_pricing.labor.manHours], ['labor', 'Labor', 'Includes installing the shelving and storage.', 5]);
  assert.deepEqual([draft.composite_pricing.labor.people, draft.composite_pricing.labor.hours, draft.composite_pricing.labor.adjusted], [2, 2.5, true]);
  assert.equal(priced.approval.blocked.some(row => row.id === 'goods-installation'), false, 'a crew set by hand covers installing the rack');
  assert.deepEqual(draft.walkthrough_capture.keepItems, 'Albums');
  assert.doesNotMatch(JSON.stringify(draft), /signature|"raw"|split|retailPerPackCents/);
});

test('the client loads the builder menu and step prices read-only, keeps the selection per walkthrough and clears it on sign-out', async () => {
  const calls = [], records = new Map();
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, String(value)), removeItem: key => records.delete(key), get length() { return records.size; }, key: index => [...records.keys()][index] ?? null };
  const client = createClient({ actor: async () => 'sales.person', storage, source: () => 'walk-1', fetch: async (url, options = {}) => { calls.push({ url, body: options.body ? JSON.parse(options.body) : null, method: options.method || 'GET' }); return { ok: true, status: 200, json: async () => ({ ok: true, url }) }; } });
  await client.builder();
  const descriptor = plain(B.builderDescriptor(menu, B.selectionFromWalkthrough(plan(), menu), 'removal'));
  await client.compositePreview(descriptor);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [['GET', '/api/quote-draft?view=builder'], ['POST', '/api/quote-draft']]);
  assert.deepEqual(calls[1].body, { action: 'composite_preview', compositePricing: descriptor });
  await client.builderState({ selection: { removal: { 'egc-026': 2 }, shelving: [], storage: [] } });
  assert.deepEqual(plain(await client.builderState()), { selection: { removal: { 'egc-026': 2 }, shelving: [], storage: [] } });
  assert.ok(records.has('egc-quote-builder-v1:sales.person:walk-1'));
  client.clear();
  assert.equal(records.size, 0, 'sign-out clears the builder selection with the frozen requests');
  // A refused request keeps the server's reasons for the dialog to show.
  const refusing = createClient({ actor: async () => 'sales.person', storage, source: () => '', fetch: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'quote_draft_composite_prices_unapproved', error: 'This quote has 1 draft price the owner has not approved: Mattress.', details: { unapproved: [{ id: 'egc-027', name: 'Mattress', reason: 'Mattress: draft price $70.00, not yet approved by the owner.' }] } }) }) });
  await assert.rejects(refusing.compositePreview(descriptor), error => error.code === 'quote_draft_composite_prices_unapproved' && error.details.unapproved[0].name === 'Mattress');
});

test('a saved quote\'s selection reopens in the builder shape, checked against the current menu', () => {
  const sel = B.selectionFromWalkthrough(plan(), menu);
  sel.shelving.push({ id: shelf.id, quantity: 2 });
  const pricing = plain(B.builderDescriptor(menu, sel, 'storage'));
  assert.deepEqual(plain(B.validSelection(B.selectionOfPricing(pricing), menu)), plain(sel));
  assert.deepEqual(plain(B.selectionOfPricing({ removal: [null, { id: 'egc-026', quantity: 2 }], shelving: 'x' })), { removal: { 'egc-026': 2 }, shelving: [], storage: [], labor: { manHours: null, adjusted: false } });
  // A saved draft keeps the estimator's man-hours: reopening it does not go back to the estimate.
  const saved = priceCompositeQuote(state, { ...pricing, labor: { manHours: 9.5, adjusted: true, fullness: 'full' } }, { complete: true }).compositePricing;
  assert.deepEqual(plain(B.validSelection(B.selectionOfPricing(plain(saved)), menu).labor), { manHours: 9.5, adjusted: true });
  assert.deepEqual(plain(B.builderDescriptor(menu, B.selectionOfPricing(plain(saved)), 'storage', 'full').labor), { manHours: 9.5, adjusted: true, fullness: 'full' });
  // flow-7: a pre-filled quote reopens at the man-hours it was saved with, not adjusted, on any device: a later estimate
  // never silently replaces them.
  const prefilled = priceCompositeQuote(state, { ...pricing, labor: { manHours: null, fullness: 'medium' } }, { complete: true }).compositePricing;
  assert.deepEqual(plain(B.selectionOfPricing(plain(prefilled)).labor), { manHours: prefilled.labor.manHours, adjusted: false });
  assert.deepEqual(plain(B.builderDescriptor(menu, B.selectionOfPricing(plain(prefilled)), 'storage', 'packed').labor), { manHours: prefilled.labor.manHours, adjusted: false, fullness: 'packed' });
});

// D-JUNK and D-LABOR-TEXT (owner, 2026-10-18) in the builder page: a junk-only selection sends no labor and runs no Labor
// line; a quote saved under the morning's Labor rules reopens on the new estimate unless its man-hours were set by hand.
test('a junk-only selection sends no labor and its running total is the trucks alone; a quote saved under the earlier Labor rules reopens on the new estimate', () => {
  const truck = byName('Full truck load'), junk = { removal: { [truck.id]: 2, [byName('Mattress').id]: 1, [byName('Stairs').id]: 1 }, shelving: [], storage: [], labor: { manHours: 6, adjusted: true } };
  assert.deepEqual(menu.labor.haulingGroups, ['junk', 'special', 'access']);
  assert.equal(B.junkOnly(menu, junk), true);
  const descriptor = plain(B.builderDescriptor(menu, junk, 'storage', 'packed'));
  assert.equal('labor' in descriptor, false, 'a junk-only quote carries no labor, even man-hours once set by hand');
  const priced = priceCompositeQuote(state, descriptor, { complete: true });
  assert.deepEqual([priced.junkOnly, priced.labor, priced.totalCents], [true, null, 2 * 100000 + 7000 + 19000]);
  const totals = plain(B.runningTotals(menu, junk, 'packed'));
  assert.deepEqual([totals.junkOnly, totals.labor, totals.laborHours, totals.total], [true, 0, null, priced.totalCents], 'the running total matches the server: no Labor line');
  // Garage work brings the Labor line back: a cleaning add-on, a base, shelving or storage.
  for (const extra of [{ removal: { ...junk.removal, [byName('Mouse trapping').id]: 1 } }, { removal: { ...junk.removal, [byName('Two-car garage base').id]: 1 } }, { shelving: [{ id: shelf.id, quantity: 1 }] }]) {
    const sel = { ...junk, ...extra };
    assert.equal(B.junkOnly(menu, sel), false, JSON.stringify(extra));
    assert.deepEqual(plain(B.builderDescriptor(menu, sel, 'storage', 'packed').labor), { manHours: 6, adjusted: true, fullness: 'packed' });
  }
  assert.equal(B.junkOnly(menu, { removal: {}, shelving: [], storage: [] }), false, 'an empty selection is not a quote');
  // A saved quote whose Labor line has no version was priced by the morning's rules (truck-load time in its estimate):
  // its pre-filled man-hours follow the new estimate; man-hours the estimator set by hand stay.
  const sel = B.selectionFromWalkthrough(plan(), menu);
  sel.shelving.push({ id: shelf.id, quantity: 2 });
  const pricing = { ...plain(B.builderDescriptor(menu, sel, 'storage')), labor: { manHours: 16, adjusted: false, fullness: 'full' } };
  const morning = { labor: { manHours: 16, prefilledManHours: 16, adjusted: false } }, today = { labor: { version: 2, manHours: 16, prefilledManHours: 7, adjusted: false } };
  assert.deepEqual(plain(B.selectionOfPricing(pricing, morning, menu).labor), { manHours: null, adjusted: false }, 'the earlier estimate is dropped');
  assert.deepEqual(plain(B.selectionOfPricing(pricing, today, menu).labor), { manHours: 16, adjusted: false }, 'today\'s kept man-hours stay (flow-7)');
  assert.deepEqual(plain(B.selectionOfPricing({ ...pricing, labor: { ...pricing.labor, adjusted: true } }, { labor: { ...morning.labor, adjusted: true } }, menu).labor), { manHours: 16, adjusted: true }, 'set by hand: kept');
  assert.deepEqual(plain(B.selectionOfPricing(pricing).labor), { manHours: 16, adjusted: false }, 'no saved breakdown: as saved');
});

test('the builder shows why a price blocks sending, has no way around it, and the walkthrough quote stays when the builder is off', () => {
  assert.match(source, /cannot be sent until the owner approves/);
  assert.match(source, /Sending is blocked until the owner approves \$\{S\.held\.length === 1 \? 'this price'/);
  assert.doesNotMatch(source, /walkthrough’s own itemized quote instead/, 'while the builder is on there is no switch to the walkthrough-priced quote');
  assert.match(source, /\[400, 404\]\.includes\(failure\.status\) : menu\?\.enabled !== true\) \{ S\.mode = 'legacy'/, 'a Hub that answers the builder is off gets the walkthrough quote');
  assert.match(source, /EGCWalkthroughPricing\?\.quoteBuilder\?\.\(\) === true/, 'the builder is asked for only when the Hub said it is on');
  assert.doesNotMatch(source, /retailPerPackCents|goodsMarkup/, 'the page never handles a cost basis');
});

// ---- How the walkthrough page learns the builder is on, without a request of its own (crew/walkthrough-pricing.js) ----
const pricingSource = readFileSync(new URL('../crew/walkthrough-pricing.js', import.meta.url), 'utf8');
function pricingPage() {
  const values = new Map(), local = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const listeners = {}, page = { localStorage: local, Date, AbortController, setTimeout: () => 1, clearTimeout() {}, addEventListener: (name, listener) => { (listeners[name] ||= []).push(listener); } };
  page.window = page;
  vm.runInContext(pricingSource, vm.createContext(page));
  return { api: page.EGCWalkthroughPricing, values, fire: name => (listeners[name] || []).forEach(listener => listener()) };
}
const servedTables = extra => ({ ok: true, status: 200, json: async () => ({ ok: true, authority: 'employee_hub', version: 'pc_1111111111111111', parts: { walkthrough: plain(walkthroughPricing(walkthroughServiceItems())) }, ...extra }) });

test('the walkthrough price answer tells the page whether the builder is on; the device keeps it for offline opens', async () => {
  const { api, values, fire } = pricingPage();
  assert.equal(api.quoteBuilder(), false);
  await api.load('sales.person', { fetcher: async () => servedTables() });
  assert.equal(api.quoteBuilder(), false, 'flag off: the answer carries no builder field');
  assert.doesNotMatch([...values.values()].join(), /quoteBuilder/, 'and the saved copy is unchanged');
  await api.load('sales.person', { fetcher: async () => servedTables({ quoteBuilder: true }) });
  assert.equal(api.quoteBuilder(), true);
  await api.load('sales.person', { fetcher: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(api.quoteBuilder(), true, 'offline: the saved copy remembers the last answer');
  await api.load('sales.person', { fetcher: async () => servedTables() });
  assert.equal(api.quoteBuilder(), false, 'turned off again at the next answer');
  await api.load('sales.person', { fetcher: async () => servedTables({ quoteBuilder: true }) });
  fire('egc:signout');
  assert.equal(api.quoteBuilder(), false, 'sign-out forgets it with the prices');
});

// The $250 minimum to come out (owner decisions 2026-10-21 for pickups and 2026-10-30 for every quote, pickup-minimum.js):
// the server adds a "Minimum to come out" line to any quote below $250 in all, its Labor line included, unless the
// estimator asks for the truck-nearby waiver. The running total the estimator and homeowner watch while choosing shows
// the same total the server's preview does; the server still adds and prices the line.
test('the running total of any quote under $250 includes the Minimum to come out line the server adds, and drops it when the truck-nearby waiver is asked for', () => {
  const crew = (people, hours) => ({ labor: { manHours: people * hours, adjusted: true, people, hours } });
  const sel = (removal, extra = {}) => ({ removal: Object.fromEntries(removal.map(([name, qty]) => [byName(name).id, qty])), shelving: [], storage: [], labor: { manHours: null, adjusted: false }, ...extra });
  const nearby = { nearbyTruck: { reason: 'Synthetic job 12 on the same street' } };
  for (const [label, selection, minimum] of [
    ['one mattress and one person for an hour', sel([['Mattress', 1]], crew(1, 1)), true],
    ['one mattress before the crew is entered', sel([['Mattress', 1]]), true],
    ['one mattress, truck already nearby', sel([['Mattress', 1]], { ...crew(1, 1), ...nearby }), false],
    ['stairs and two people for an hour: over $250', sel([['Stairs', 1]], crew(2, 1)), false],
    ['a quarter load: junk only, at $250', sel([['Quarter load', 1]]), false],
    ['one shelving unit installed in half an hour: garage work under $250', sel([], { shelving: [{ id: shelf.id, quantity: 1 }], ...crew(1, 0.5) }), true],
    ['a mattress with a garage base: well over $250', sel([['Two-car garage base', 1], ['Mattress', 1]], crew(2, 3)), false],
  ]) {
    const priced = priceCompositeQuote(state, plain(B.builderDescriptor(menu, selection, 'storage', 'medium')));
    const totals = plain(B.runningTotals(menu, selection, 'medium'));
    assert.equal(totals.total, priced.totalCents, `${label}: the running total is the server's total`);
    assert.equal(totals.pickup, priced.pickup.minimumCents, `${label}: the minimum line`);
    assert.equal(totals.pickup > 0, minimum, label);
    if (minimum) assert.equal(totals.total, PICKUP_MINIMUM_CENTS, `${label}: raised to the minimum`);
  }
});
