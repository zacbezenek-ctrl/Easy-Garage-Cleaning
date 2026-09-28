import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from './helpers/vm-realm.mjs';
import { sourceFiles } from './source-files.mjs';
import { PRICING_PARTS, WALKTHROUGH_PRICING_VERSION, businessRateCard, ownerEconomics, phoneQuotePricing, pricingConfig, pricingFingerprint, walkthroughPricing, walkthroughServiceItems } from '../functions/_lib/pricing-config.js';
import { WALKTHROUGH_SERVICE_ITEMS } from '../functions/_data/walkthrough-services.js';
import { pricingConfigHandlers } from '../functions/api/pricing-config.js';
import { accountView } from '../functions/_lib/business-hub-core.js';
import { renderWalkthroughServices, walkthroughServiceSlice } from '../scripts/generate-walkthrough-services.mjs';
import { bundleProblems } from '../scripts/check-functions-bundle.mjs';
import { garageCatalog, servedPricing } from './helpers/walkthrough-pricing.mjs';

// The oracle: crew/gameplan.html recommend() and estimatedJobMinutes() and employee.html
// calcQuote() exactly as they shipped before PRICE-SCRUB, with their built-in tables. The
// page now prices with the tables /api/pricing-config serves; every result must be identical.
const LEGACY_RECOMMEND = "function recommend(itemized=false){const size={1:450,2:650,3:850,other:1100}[S.garageSize]||650,fill={light:.75,medium:1,full:1.35,packed:1.7}[S.fill]||1;let n=size*fill;const stated=Number(S.loads||0)*1000;if(stated)n=Math.max(n,stated);const lines=[],line=(id,kind,name,unit,quantity=1)=>{const cents=Math.round(unit*100),count=Number(quantity);if(cents&&count>0)lines.push({id,kind,name,description:'',quantity:count,unitCents:cents,totalCents:Math.round(cents*count)});return unit*quantity};n+=S.special.reduce((a,x)=>a+line('special-'+String(x).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),'fee','Special handling: '+x,{'Mattress':45,'Refrigerator / freezer':60,'Tires':50,'Paint / chemicals':45,'Electronics':25,'Appliances':40,'Piano / safe':150,'Very heavy items':100}[x]||0),0);if(S.access.includes('Long carry'))n+=line('access-long-carry','fee','Long-carry access',75);if(S.access.includes('Stairs'))n+=line('access-stairs','fee','Stairs access',125);if(S.finish?.includes('pressure_wash')&&S.garageSize==='1')n+=line('pressure-wash','service','One-car garage pressure wash',400);if(S.finish.includes('deep_clean'))n+=line('deep-clean','service','Deep clean',({1:125,2:220,3:320,other:420}[S.garageSize]||220));if(S.finish.includes('shelving'))n+=line('shelving','product',({metal:'Metal',wood:'Wood',plastic:'Plastic'}[S.shelfType]||'Metal')+' shelving unit',({metal:499,wood:449,plastic:349}[S.shelfType]||499),S.shelfQty);if(S.finish.includes('totes'))n+=line('totes','product','Storage tote',21.5,S.toteQty);const core=Math.max(450,Math.round(n/25)*25),base=Math.round(core*100)-lines.reduce((a,x)=>a+x.totalCents,0);if(S.hazards?.includes('Pest waste'))line('pest-waste','service','Pest-waste cleanup',200);if(S.finish?.includes('mouse_trapping'))line('mouse-trapping','service','Non-toxic mouse trapping',250);lines.unshift({id:'cleanout',kind:'service',name:'Garage cleanout and reset',description:Number(S.loads)>0?`Sorting, hauling and disposal for about ${S.loads} truckload${Number(S.loads)===1?'':'s'}`:'Sorting, hauling and disposal',quantity:1,unitCents:base,totalCents:base});return itemized?lines:core+(S.hazards?.includes('Pest waste')?200:0)+(S.finish?.includes('mouse_trapping')?250:0)}";
const LEGACY_MINUTES = "function estimatedJobMinutes(){const loads=Math.max(.5,Number(S.loads||1));let minutes=60+loads*90+({light:0,medium:30,full:60,packed:120}[S.fill]||30);minutes+=(Array.isArray(S.special)?S.special.length:0)*15;if(S.access.includes('Long carry'))minutes+=30;if(S.access.includes('Stairs'))minutes+=30;if(S.finish?.includes('pressure_wash')&&S.garageSize==='1')minutes+=60;if(S.finish.includes('deep_clean'))minutes+=({1:60,2:90,3:120,other:150}[S.garageSize]||90);if(S.finish.includes('shelving'))minutes+=Number(S.shelfQty||0)*30;if(S.finish.includes('totes'))minutes+=Number(S.toteQty||0)*4;minutes*=2/Math.max(1,Number(S.crewSize||2));return Math.min(540,Math.max(120,Math.ceil(minutes/30)*30))}";
const LEGACY_PHONE = "const CFG = { FREE_MILES: 25, PRICE_PER_MILE: 1 };\nconst SPECIALS = [\n  { id:'fridge',     name:'Refrigerator',   price:60, icon:'' },\n  { id:'washer',     name:'Washer / Dryer', price:50, icon:'' },\n  { id:'appliance',  name:'Other Appliance',price:40, icon:'' },\n  { id:'mattress',   name:'Mattress',       price:45, icon:'' },\n  { id:'tire',       name:'Tire',           price:50, icon:'' },\n  { id:'electronics',name:'Electronics',    price:25, icon:'' },\n  { id:'paint',      name:'Paint / Hazmat', price:45, icon:'' },\n];\nfunction calcQuote() {\n  let total = 150, lines = ['Base service fee  $150'];\n\n  // Cubic yards \u2014 $25/yd\n  const cy = oc.quote.cubicYards || 0;\n  if (cy > 0) { total += cy * 35; lines.push(`Cubic yards (${cy} yd\u00b3)  +$${cy*35}`); }\n\n  // Special items\n  SPECIALS.forEach(item => {\n    const qty = oc.quote.specials[item.id] || 0;\n    if (qty > 0) { total += item.price * qty; lines.push(`${item.icon} ${item.name} \u00d7${qty}  +$${item.price*qty}`); }\n  });\n\n  // Floors \u2014 $20/floor\n  const fl = oc.quote.floors || 0;\n  if (fl > 0) { total += fl * 20; lines.push(`Floors to climb (${fl})  +$${fl*20}`); }\n\n  // Distance \u2014 $1/mile beyond free radius\n  const dm = oc.quote.distanceMiles || 0;\n  const billableMiles = Math.max(0, dm - CFG.FREE_MILES);\n  if (billableMiles > 0) { total += billableMiles * CFG.PRICE_PER_MILE; lines.push(`Distance (${dm} mi, ${billableMiles} mi over)  +$${billableMiles}`); }\n\n  const low  = Math.round(total / 5) * 5;\n  const high = Math.round(low * 1.18 / 5) * 5;\n  return { low, high, lines };\n}";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const gameplan = read('crew/gameplan.html'), employee = read('employee.html');
const line = prefix => gameplan.split(/\r?\n/).find(row => row.startsWith(prefix)) || assert.fail(prefix);
const plain = value => JSON.parse(JSON.stringify(value));
function walkthrough(source) {
  const context = vm.createContext({ PRICING: servedPricing() });
  vm.runInContext(line('const freshState='), context);
  vm.runInContext(source, context);
  return state => { context.S = Object.assign(vm.runInContext('freshState()', context), { garageSize: '1', fill: 'medium', loads: '1', crewSize: '2' }, state); return { total: context.recommend(), lines: plain(context.recommend(true)), minutes: context.estimatedJobMinutes() }; };
}
const current = walkthrough([line('function recommend('), line('function estimatedJobMinutes(')].join('\n')), legacy = walkthrough([LEGACY_RECOMMEND, LEGACY_MINUTES].join('\n'));

// tests/walkthrough-pricing.test.mjs and tests/walkthrough-handoff-items.test.mjs fixtures.
const FIXTURES = [
  ...['0.5', '1', '1.5', '2'].map(loads => ({ loads })), { loads: '', fill: 'light' }, { garageSize: '2', fill: 'packed' },
  { finish: ['cleanout', 'pressure_wash'] }, { finish: ['cleanout', 'deep_clean'] }, { finish: ['cleanout', 'deep_clean', 'pressure_wash'] },
  { garageSize: '2', loads: '1.5', finish: ['cleanout', 'deep_clean', 'shelving', 'totes'], shelfQty: 1, toteQty: 4 }, { finish: ['cleanout', 'pressure_wash', 'shelving'], shelfQty: 2 },
  { garageSize: '2', finish: ['cleanout', 'pressure_wash'] }, { hazards: ['Mold / moisture', 'Sharp material'] }, { hazards: ['Pest waste', 'Mold / moisture'] }, { hazards: ['Pest waste', 'Pest waste'] },
  { fill: 'light', loads: '0.25' }, { fill: 'light', loads: '0.25', hazards: ['Pest waste'] }, { fill: 'light', loads: '0.25', finish: ['cleanout', 'mouse_trapping'] },
  { fill: 'light', loads: '0.25', hazards: ['Pest waste'], finish: ['cleanout', 'mouse_trapping'] }, ...['1', '2', '3', 'other'].map(garageSize => ({ garageSize })),
  ...['1', '2', '3', 'other'].map(garageSize => ({ garageSize, finish: ['cleanout', 'mouse_trapping'] })), { hazards: ['Pest waste'], finish: ['cleanout', 'pressure_wash', 'mouse_trapping'] },
  { special: ['Refrigerator / freezer', 'Tires', 'Paint / chemicals', 'Electronics', 'Appliances', 'Very heavy items'], access: ['Stairs'] },
  { fill: 'full', loads: '', special: ['Mattress', 'Piano / safe', 'Unlisted item'], access: ['Long carry', 'Stairs'], finish: ['cleanout', 'totes'], toteQty: 3, shelfType: 'plastic' },
  { fill: 'light', loads: '0.25', finish: ['cleanout', 'totes'], toteQty: 5 }, { garageSize: 'other', fill: 'packed', finish: ['cleanout', 'shelving'], shelfType: 'wood', shelfQty: 3 },
  { garageSize: 'unknown', fill: 'unknown', shelfType: 'unknown', finish: ['cleanout', 'deep_clean', 'shelving'], shelfQty: 1, crewSize: '' },
];

test('walkthrough totals, itemized lines and job minutes are identical to the pre-change page for every pricing fixture', () => {
  for (const fixture of FIXTURES) assert.deepEqual(current(fixture), legacy(fixture), JSON.stringify(fixture));
});

test('walkthrough totals, lines and minutes are identical across every size, fill, load, finish, hazard, access and crew combination', () => {
  const finishes = [[], ['deep_clean'], ['pressure_wash'], ['shelving'], ['totes'], ['mouse_trapping'], ['deep_clean', 'pressure_wash', 'shelving', 'totes', 'mouse_trapping']];
  let compared = 0;
  for (const garageSize of ['1', '2', '3', 'other']) for (const fill of ['', 'light', 'medium', 'full', 'packed']) for (const loads of ['', '0.25', '0.5', '1', '1.5', '2.5', '4'])
    for (const finish of finishes) for (const hazards of [[], ['Pest waste']]) for (const access of [[], ['Long carry'], ['Long carry', 'Stairs']]) for (const special of [[], ['Mattress', 'Tires']]) for (const crewSize of ['1', '2', '3']) {
      const state = { garageSize, fill, loads, finish: ['cleanout', ...finish], hazards, access, special, crewSize, shelfType: ['metal', 'wood', 'plastic'][compared % 3], shelfQty: compared % 4, toteQty: compared % 7 };
      const a = current(state), b = legacy(state);
      if (a.total !== b.total || a.minutes !== b.minutes || JSON.stringify(a.lines) !== JSON.stringify(b.lines)) assert.fail(`differs for ${JSON.stringify(state)}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      compared++;
    }
  assert.equal(compared, 4 * 5 * 7 * 7 * 2 * 3 * 2 * 3);
});

function phone(source, table) {
  const context = vm.createContext({ PHONE_QUOTE: table, oc: { quote: {} } });
  vm.runInContext(source, context);
  return quote => { context.oc.quote = { specials: {}, cubicYards: 0, floors: 0, distanceMiles: 0, ...quote }; const result = plain(context.calcQuote()); return { low: result.low, high: result.high, lines: result.lines.map(text => text.trim()) }; };
}
const phoneSource = employee.slice(employee.indexOf('let PHONE_QUOTE = null'), employee.indexOf('async function loadPhoneQuote(')) + employee.slice(employee.indexOf('function calcQuote() {'), employee.indexOf('function updateQDisplay() {'));
const phoneNow = phone(phoneSource.replace('let PHONE_QUOTE = null, ', 'let '), phoneQuotePricing()), phoneThen = phone(LEGACY_PHONE, null);

test('phone-quote ranges and breakdown lines are identical to the pre-change calculator', () => {
  const specials = [{}, { fridge: 1 }, { washer: 2, tire: 4 }, { appliance: 1, mattress: 1, electronics: 3, paint: 2 }, { fridge: 1, washer: 1, appliance: 1, mattress: 1, tire: 1, electronics: 1, paint: 1 }];
  let compared = 0;
  for (const cubicYards of [0, 1, 3, 7, 12, 20]) for (const set of specials) for (const floors of [0, 1, 3]) for (const distanceMiles of [0, 10, 25, 26, 40, 97]) {
    const quote = { cubicYards, specials: set, floors, distanceMiles };
    assert.deepEqual(phoneNow(quote), phoneThen(quote), JSON.stringify(quote));
    compared++;
  }
  assert.equal(compared, 6 * 5 * 3 * 6);
  assert.deepEqual(phoneNow({}), { low: 150, high: 175, lines: ['Base service fee  $150'] });
});

test('without a loaded phone-quote table the calculator reports unavailable instead of a built-in price', () => {
  const context = vm.createContext({ oc: { quote: { specials: {}, cubicYards: 4 } } });
  vm.runInContext(phoneSource, context);
  assert.deepEqual(plain(context.calcQuote()), { low: null, high: null, lines: [], available: false });
});

test('the legacy walkthrough services are read from the garage catalog, not duplicated', () => {
  const catalog = garageCatalog(), tables = walkthroughPricing(catalog), item = id => catalog.items.find(entry => entry.id === id);
  const services = { 'svc-pressure-wash-1car': tables.services.pressure_wash, 'svc-labeled-tote': tables.services.totes, 'svc-mouse-trapping': tables.services.mouse_trapping, 'svc-pest-waste': tables.hazards['Pest waste'],
    ...Object.fromEntries(['1', '2', '3', 'other'].map(size => [{ 1: 'svc-deep-clean-1car', 2: 'svc-deep-clean-2car', 3: 'svc-deep-clean-3car', other: 'svc-deep-clean-large' }[size], tables.services.deep_clean.bySize[size]])),
    ...Object.fromEntries(['metal', 'wood', 'plastic'].map(type => [`svc-shelving-unit-${type}`, tables.services.shelving.byType[type]])) };
  for (const [id, entry] of Object.entries(services)) assert.deepEqual(plain(entry), { amount: item(id).fixedPriceCents / 100, minutes: item(id).legacy.jobMinutes, itemId: id }, id);
  // A price or minute change made in the catalog is what the walkthrough then charges.
  const changed = structuredClone(catalog), deep = changed.items.find(entry => entry.id === 'svc-deep-clean-2car');
  Object.assign(deep, { fixedPriceCents: 23500 }); Object.assign(deep.legacy, { amountDollars: 235, jobMinutes: 95 });
  assert.deepEqual(plain(walkthroughPricing(changed).services.deep_clean.bySize['2']), { amount: 235, minutes: 95, itemId: 'svc-deep-clean-2car' });
});

test('a catalog whose legacy services no longer fit the walkthrough model fails closed', () => {
  const broken = mutate => { const catalog = garageCatalog(); mutate(catalog, id => catalog.items.find(entry => entry.id === id)); return () => walkthroughPricing(catalog); };
  const mismatch = { code: 'pricing_config_catalog_mismatch', status: 503 };
  assert.throws(broken((c, item) => { item('svc-pest-waste').legacy.appliedBeforeRounding = true; }), mismatch);
  assert.throws(broken((c, item) => { item('svc-pressure-wash-1car').legacy.garageSizes = ['1', '2']; }), mismatch);
  assert.throws(broken(c => { c.items = c.items.filter(entry => entry.id !== 'svc-deep-clean-3car'); }), mismatch);
  assert.throws(broken((c, item) => { item('svc-labeled-tote').availability = 'hidden'; }), mismatch);
  assert.throws(broken((c, item) => { item('svc-shelving-unit-wood').legacy.shelfType = 'metal'; }), mismatch);
  assert.throws(broken(c => { c.items.push({ ...structuredClone(c.items.find(entry => entry.id === 'svc-mouse-trapping')), id: 'svc-mouse-trapping-copy' }); }), mismatch);
  // Only the legacy items reach the Worker, so it re-checks the catalog's rules for them.
  assert.throws(broken((c, item) => { item('svc-labeled-tote').legacy.amountDollars = 25; }), mismatch);
  assert.throws(broken((c, item) => { item('svc-labeled-tote').fixedPriceCents = 21.5; item('svc-labeled-tote').legacy.amountDollars = 0.215; }), mismatch);
  assert.throws(broken((c, item) => { item('svc-deep-clean-1car').legacy.jobMinutes = -30; }), mismatch);
  assert.throws(broken((c, item) => { item('svc-deep-clean-1car').legacy.garageSizes = ['4']; }), mismatch);
  assert.throws(broken((c, item) => { item('svc-pest-waste').availability = 'retired'; }), mismatch);
  assert.throws(broken((c, item) => { item('svc-pest-waste').legacy.appliedBeforeRounding = 'no'; }), mismatch);
  assert.throws(broken(c => { c.items.push(structuredClone(c.items.find(entry => entry.id === 'svc-deep-clean-2car'))); }), mismatch);
  assert.throws(broken(c => { c.items.push({ id: '', kind: 'service', legacy: {} }); }), mismatch);
});

test('the walkthrough tables are pinned to their version label: a price or minute change must bump WALKTHROUGH_PRICING_VERSION', () => {
  const { version, ...tables } = walkthroughPricing(garageCatalog());
  assert.equal(version, WALKTHROUGH_PRICING_VERSION);
  assert.deepEqual([version, pricingFingerprint(tables)], ['2026-09-pest200-traps250', '79f5010f3963696798a8eb9af88d8db3e2653c44f03c2b5f46c97a969c3debce'], 'bump the version (drafts re-price) and update this pin together');
});

const OWNER = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const MANAGER = { user: 'tylerg', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const CREW = { user: 'crew.one', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false };
const request = (query = '') => new Request(`https://easygaragecleaning.com/api/pricing-config${query}`, { headers: { Origin: 'https://easygaragecleaning.com' } });
async function get(actor, query, { env = {}, catalog } = {}) {
  const response = await pricingConfigHandlers({ session: async () => actor, ...(catalog ? { catalog } : {}) }).get({ request: request(query), env });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  return { status: response.status, body: await response.json() };
}

test('/api/pricing-config: quoting staff get the price tables, only the owner gets the labor baseline and targets, crew get nothing', async () => {
  const owner = await get(OWNER), manager = await get(MANAGER);
  assert.equal(owner.status, 200); assert.equal(manager.status, 200);
  assert.deepEqual(Object.keys(owner.body.parts).sort(), ['owner', 'phone', 'walkthrough']);
  assert.deepEqual(Object.keys(manager.body.parts).sort(), ['phone', 'walkthrough']);
  assert.deepEqual(owner.body.parts.walkthrough, servedPricing(), 'the served tables are the ones the page tests price with');
  assert.deepEqual(owner.body.parts.owner, plain(ownerEconomics()));
  assert.deepEqual(manager.body.parts.phone, plain(phoneQuotePricing()));
  assert.doesNotMatch(JSON.stringify(manager.body), /laborCostPerCrewHour|wages|targets|averageTicket/);
  for (const query of ['', '?parts=walkthrough', '?parts=phone', '?parts=owner']) {
    const crew = await get(CREW, query);
    assert.equal(crew.status, 403, query);
    assert.deepEqual(Object.keys(crew.body).sort(), ['code', 'error', 'ok']);
    assert.equal(crew.body.code, 'pricing_config_forbidden');
  }
  assert.equal((await get(MANAGER, '?parts=owner')).status, 403, 'a manager cannot ask for the owner part');
  assert.equal((await get(MANAGER, '?parts=walkthrough,owner')).status, 403);
  assert.deepEqual(Object.keys((await get(OWNER, '?parts=owner')).body.parts), ['owner']);
  assert.equal((await get(null)).status, 401);
});

test('/api/pricing-config follows the staff-role capabilities when they are on', async () => {
  const env = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
  const sales = await get({ ...CREW, user: 'sales.one', staffRoles: ['sales'] }, '?parts=walkthrough', { env });
  assert.equal(sales.status, 200); assert.ok(sales.body.parts.walkthrough);
  assert.equal((await get({ ...CREW, user: 'lead.one', staffRoles: ['crew_lead'] }, '', { env })).status, 403);
  assert.equal((await get({ ...MANAGER, staffRoles: ['crew'] }, '', { env })).status, 403, 'stored roles decide once the capabilities are on');
  assert.equal((await get({ ...OWNER, staffRoles: ['owner'] }, '?parts=owner', { env })).status, 200);
});

test('/api/pricing-config responses carry a content version that changes only with the served tables', async () => {
  const first = await get(MANAGER, '?parts=walkthrough'), again = await get(MANAGER, '?parts=walkthrough'), both = await get(MANAGER);
  assert.match(first.body.version, /^pc_[0-9a-f]{16}$/);
  assert.equal(first.body.version, again.body.version);
  assert.notEqual(first.body.version, both.body.version);
  const changed = garageCatalog(); Object.assign(changed.items.find(entry => entry.id === 'svc-labeled-tote'), { fixedPriceCents: 2200 }).legacy.amountDollars = 22;
  const repriced = await get(MANAGER, '?parts=walkthrough', { catalog: async () => changed });
  assert.notEqual(repriced.body.version, first.body.version);
  assert.equal(repriced.body.parts.walkthrough.services.totes.amount, 22);
  assert.deepEqual(await pricingConfig(['phone']), await pricingConfig(['phone']));
  assert.deepEqual(PRICING_PARTS, ['walkthrough', 'phone', 'owner']);
});

test('/api/pricing-config rejects odd queries and never leaks a storage failure', async () => {
  for (const query of ['?parts=', '?parts=walkthrough,prices', '?part=walkthrough', '?parts=phone&parts=owner', '?parts=phone&x=1']) {
    const result = await get(OWNER, query);
    assert.equal(result.status, 400, query);
    assert.match(result.body.code, /^pricing_config_invalid_/);
  }
  const failed = await get(OWNER, '?parts=walkthrough', { catalog: async () => { throw new Error('Synthetic private storage detail'); } });
  assert.deepEqual([failed.status, failed.body.code], [503, 'pricing_config_unavailable']);
  assert.doesNotMatch(JSON.stringify(failed.body), /Synthetic private storage detail/);
  const mismatch = garageCatalog(); mismatch.items = mismatch.items.filter(entry => entry.id !== 'svc-pest-waste');
  assert.equal((await get(OWNER, '?parts=walkthrough', { catalog: async () => mismatch })).status, 503);
  assert.equal((await get(OWNER, '?parts=phone,owner', { catalog: async () => { throw new Error('unused'); } })).status, 200, 'parts that need no catalog still load');
});

test('the Worker prices from a generated plain module that is exactly the catalog\'s legacy service items', async () => {
  const catalog = garageCatalog();
  assert.equal(read('functions/_data/walkthrough-services.js'), renderWalkthroughServices(catalog), 'run node scripts/generate-walkthrough-services.mjs --write');
  assert.deepEqual(plain(WALKTHROUGH_SERVICE_ITEMS), walkthroughServiceSlice(catalog));
  assert.deepEqual(WALKTHROUGH_SERVICE_ITEMS.map(item => item.id), catalog.items.filter(item => item.kind === 'service' && item.legacy).map(item => item.id));
  assert.deepEqual(walkthroughPricing(walkthroughServiceItems()), walkthroughPricing(catalog), 'the module prices exactly like the full catalog');
  assert.deepEqual((await get(MANAGER, '?parts=walkthrough')).body.parts.walkthrough, servedPricing());
  assert.equal(Object.isFrozen(walkthroughServiceItems().items[0].legacy), true);
  // A legacy price change in the catalog makes the module stale (the test above fails until it is regenerated) ...
  const repriced = garageCatalog(); Object.assign(repriced.items.find(item => item.id === 'svc-labeled-tote'), { fixedPriceCents: 2200 }).legacy.amountDollars = 22;
  assert.notEqual(renderWalkthroughServices(repriced), renderWalkthroughServices(catalog));
  assert.match(renderWalkthroughServices(repriced), /"id":"svc-labeled-tote","kind":"service","availability":"active","fixedPriceCents":2200,/);
  // ... while product edits never touch it, and an invalid catalog is never generated.
  const product = garageCatalog(), shelf = product.items.find(item => item.kind === 'product'); shelf.retailPriceHighCents += 100;
  assert.equal(renderWalkthroughServices(product), renderWalkthroughServices(catalog));
  const invalid = garageCatalog(); invalid.items.find(item => item.id === 'svc-labeled-tote').legacy.amountDollars = 25;
  assert.throws(() => renderWalkthroughServices(invalid), { code: 'catalog_invalid' });
});

// Wrangler 3 (esbuild 0.17) cannot bundle JSON import attributes: it leaves a runtime import()
// the Worker cannot resolve. Every function must import plain modules only.
test('no Pages Function imports JSON or depends on import attributes, so every Wrangler bundles it', () => {
  const root = fileURLToPath(new URL('../functions', import.meta.url));
  const files = sourceFiles(root).map(entry => join(entry.parentPath, entry.name)).filter(path => /\.[cm]?js$/.test(path));
  assert.ok(files.length > 50);
  const offenders = files.flatMap(path => {
    const source = readFileSync(path, 'utf8'), name = relative(root, path).split(sep).join('/');
    return [/\bimport\s*\(\s*['"`][^'"`]*\.json['"`]/, /^\s*import\b[^;]*from\s*['"`][^'"`]*\.json['"`]/m, /\b(?:with|assert)\s*[:{]\s*\{?\s*type\s*:\s*['"`]json['"`]/].filter(pattern => pattern.test(source)).map(pattern => `${name}: ${pattern}`);
  });
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(read('functions/_lib/pricing-config.js'), /['"`][^'"`\n]*garage-catalog\.json['"`]/, 'the Worker never loads the full catalog');
});

test('the bundle check flags a runtime import, an unsupported-import build warning and missing walkthrough services', () => {
  const services = WALKTHROUGH_SERVICE_ITEMS.map(item => JSON.stringify(item)).join(',\n');
  const bundled = `var walkthrough_services_exports = {};\nvar WALKTHROUGH_SERVICE_ITEMS = [${services}];\nconst guard = await Promise.resolve().then(() => (init_customer_portal(), customer_portal_exports));`;
  assert.deepEqual(bundleProblems(bundled, '\u001b[33m▲ [WARNING] Unrecognized target environment "ES2023" [tsconfig.json]\u001b[0m\n✨ Compiled Worker successfully'), []);
  const wrangler3 = `${bundled}\n  catalogLoad ||= import("../_data/garage-catalog.json").then((module) => validateCatalog(module.default));`;
  const log = '\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m \u001b[1mThis "import()" was not recognized because this property was not called "assert"\u001b[0m [unsupported-dynamic-import]';
  const problems = bundleProblems(wrangler3, log);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /runtime import\("\.\.\/_data\/garage-catalog\.json"\) was left in the bundle/);
  assert.match(problems[1], /^build log: .*\[unsupported-dynamic-import\]$/);
  const missing = bundleProblems(bundled.replace('svc-pest-waste', 'svc-other'));
  assert.deepEqual(missing, ['walkthrough service svc-pest-waste is missing from the bundle']);
  assert.deepEqual(bundleProblems('  '), ['the bundle is empty']);
  assert.equal(bundleProblems(bundled, '✘ [ERROR] Build failed with 1 error').length, 1);
});

test('the business hub rate card comes from the signed-in account response', () => {
  const account = { id: 'a'.repeat(32), company: 'Synthetic Co', billingEmail: 'billing@example.invalid', status: 'active', members: [], requests: [], messages: [], projects: [], properties: [] };
  const member = { id: 'b'.repeat(32), name: 'Synthetic Admin', role: 'admin', status: 'active' };
  for (const view of [accountView(account, member, []), accountView(account, member, [], { staff: true, manager: true })]) {
    assert.deepEqual(view.rates.cards.map(card => [card.value, card.title]), [['10%', 'Partner service savings'], ['15%', 'Coordinated properties']]);
    assert.equal(view.rates.terms.length, 2);
    assert.match(view.rates.terms[0], /^Discounts do not stack\./);
  }
  const card = businessRateCard(account); card.cards[0].value = 'changed';
  assert.equal(businessRateCard(account).cards[0].value, '10%', 'each response gets its own copy');
  assert.equal(businessRateCard(null), null);
});
