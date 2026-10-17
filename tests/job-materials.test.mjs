import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyPurchaseState, bringList, bringListMaterials, crewMaterialFields, effectivePurchaseState, handoffJobMaterials, jobMaterialsEnabled, materialCategory, materialStore, NO_STORE,
  normalizeJobMaterial, normalizeJobMaterials, purchaseList, quoteLineMaterials } from '../functions/_lib/job-materials.js';
import { breakdownLines, jobBreakdown } from '../functions/_lib/job-breakdown.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { fieldMaterials } from '../functions/_lib/field-execution.js';

// The Dispatch materials rule before WP14c (dispatch-service.js schedulePatch), verbatim, as the legacy reference.
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(secure_|_egc_)/.test(id);
function text(value, label, max = 4000) { if (typeof value !== 'string' || value.length > max) throw fail('dispatch_invalid_field', `${label} must be text of at most ${max} characters.`); return value.trim(); }
function onlyKeys(value, keys) { if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('dispatch_patch_not_allowed', 'This request contains unsupported fields. Refresh the dispatch form and try again.'); }
function legacyRule(list) {
  if (!Array.isArray(list) || list.length > 100) throw fail('dispatch_materials_invalid', 'Enter at most 100 required materials.');
  const materials = list.map(material => {
    onlyKeys(material, ['id', 'name', 'quantity']);
    if (!safeId(material.id) || typeof material.quantity !== 'number' || !Number.isFinite(material.quantity) || material.quantity <= 0 || material.quantity > 100000) throw fail('dispatch_materials_invalid', 'Each material needs a stable ID and a positive quantity.');
    const name = text(material.name, 'Material name', 200);
    if (!name) throw fail('dispatch_materials_invalid', 'Each material needs a name.');
    return { id: material.id, name, quantity: material.quantity };
  });
  if (new Set(materials.map(item => item.id)).size !== materials.length) throw fail('dispatch_materials_invalid', 'Material IDs must be unique.');
  return materials;
}
const outcome = run => { try { return { value: JSON.stringify(run()) }; } catch (error) { return { code: error.code, message: error.message, status: error.status }; } };

test('legacy {id,name,quantity} materials validate and normalize exactly as the earlier Dispatch rule', () => {
  const cases = [
    [], [{ id: 'shelf', name: ' Shelf ', quantity: 2 }], [{ id: 'a', name: 'A', quantity: 0.5 }, { id: 'b', name: 'B', quantity: 100000 }],
    'not a list', [...Array(101)].map((_, i) => ({ id: `m${i}`, name: 'Bag', quantity: 1 })), [...Array(100)].map((_, i) => ({ id: `m${i}`, name: 'Bag', quantity: 1 })),
    ['Legacy tarp'], [null], [{ id: 'a', name: 'A', quantity: 1, extra: true }], [{ id: 'a', name: 'A', quantity: 1, qty: 2 }], [{ id: 'secure_a', name: 'A', quantity: 1 }], [{ id: 'a b', name: 'A', quantity: 1 }],
    [{ id: 'a', name: 'A', quantity: 0 }], [{ id: 'a', name: 'A', quantity: -1 }], [{ id: 'a', name: 'A', quantity: 100001 }], [{ id: 'a', name: 'A', quantity: '2' }], [{ id: 'a', name: 'A', quantity: Infinity }],
    [{ id: 'a', name: 7, quantity: 1 }], [{ id: 'a', name: 'x'.repeat(201), quantity: 1 }], [{ id: 'a', name: '   ', quantity: 1 }], [{ id: 'a', quantity: 1 }],
    [{ id: 'a', name: 'A', quantity: 1 }, { id: 'a', name: 'B', quantity: 2 }],
  ];
  for (const input of cases) assert.deepEqual(outcome(() => normalizeJobMaterials(input, fail)), outcome(() => legacyRule(input)), JSON.stringify(input).slice(0, 80));
  assert.deepEqual(Object.keys(normalizeJobMaterial({ quantity: 1, name: 'A', id: 'a' })), ['id', 'name', 'quantity'], 'a legacy entry keeps the legacy key order');
});

test('structured fields are normalized and validated; anything else is still refused', () => {
  const full = { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 10, sku: ' 1001-234 ', unit: 'unit', unitsPerPack: 4, packs: 3, source: 'buy', purchaseState: 'ordered', productUrl: 'https://www.homedepot.com/p/1001', note: 'Assembled', category: 'shelving', store: 'Home Depot', catalogItemId: 'shelf-metal', purchaseUpdatedAt: '2026-10-17T16:00:00.000Z', purchaseUpdatedBy: 'zacb' };
  assert.deepEqual(normalizeJobMaterial(full), { ...full, sku: '1001-234' });
  assert.deepEqual(normalizeJobMaterial({ id: 'a', name: 'A', quantity: 1, sku: '', note: null, source: 'stock' }), { id: 'a', name: 'A', quantity: 1, source: 'stock' }, 'blank optional fields are left out');
  for (const [key, value] of [['source', 'borrow'], ['purchaseState', 'lost'], ['unitsPerPack', 0], ['unitsPerPack', 1.5], ['packs', 0], ['productUrl', 'javascript:alert(1)'], ['productUrl', 'ftp://x.example/a'], ['category', 'tools'], ['sku', 'x'.repeat(81)], ['note', 'a\u0000b'], ['catalogItemId', 'bad id'], ['purchaseUpdatedAt', 'yesterday'], ['store', 5]]) {
    assert.throws(() => normalizeJobMaterial({ id: 'a', name: 'A', quantity: 1, [key]: value }), error => error.code === 'dispatch_materials_invalid' && error.status === 400, `${key}=${value}`);
  }
  assert.throws(() => normalizeJobMaterial({ id: 'a', name: 'A', quantity: 1, unitCostCents: 1200 }), error => error.code === 'dispatch_patch_not_allowed', 'a cost never rides on a material');
  assert.equal(jobMaterialsEnabled({ EGC_JOB_MATERIALS: 'true' }), true);
  for (const value of [undefined, '', 'TRUE', '1', 'yes', true]) assert.equal(jobMaterialsEnabled({ EGC_JOB_MATERIALS: value }), false, String(value));
});

test('Dispatch saves structured materials and the Hub editor round trip keeps them; a bad state is refused', async () => {
  const rows = new Map([['customers/c1', { id: 'c1', name: 'Test Customer', phone: '+1 (970) 555-0100', address: '100 Test Street', revision: 'c1r' }]]);
  let revision = 0;
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => structuredClone(value));
  const store = { jobs: async () => all('jobs'), resources: async () => [], customers: async () => all('customers'), roster: async () => [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }],
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => { for (const write of writes) { const key = `${write.collection}/${write.id}`, old = rows.get(key); if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` }); } };
  const owner = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true }, NOW = '2026-09-22T12:00:00.000Z';
  const materials = [{ id: 'quote-shelving', name: 'Metal shelving unit', quantity: 2, source: 'buy', purchaseState: 'to_buy', category: 'shelving', productUrl: 'https://www.homedepot.com/p/1' }, { id: 'kit-dolly', name: 'Hand truck / dolly', quantity: 1, source: 'stock', category: 'equipment' }, { id: 'material-0-tarp', name: 'Tarp', quantity: 1 }];
  const created = await mutateDispatch(store, owner, { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Clean garage', materials } }, NOW);
  assert.deepEqual(rows.get(`jobs/${created.job.id}`).materials, materials);
  assert.deepEqual(created.job.materials, materials, 'the Dispatch DTO carries the structured fields to the editor');
  // The Hub editor sends each existing material back as it received it.
  const job = rows.get(`jobs/${created.job.id}`);
  await mutateDispatch(store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: job.id, expectedRevision: job.revision, changes: { materials: created.job.materials, title: 'Garage reset' } }, NOW);
  assert.deepEqual(rows.get(`jobs/${job.id}`).materials, materials);
  const latest = rows.get(`jobs/${job.id}`);
  await assert.rejects(mutateDispatch(store, owner, { action: 'schedule.update', requestId: randomUUID(), jobId: latest.id, expectedRevision: latest.revision, changes: { materials: [{ ...materials[0], purchaseState: 'lost' }] } }, NOW), error => error.code === 'dispatch_materials_invalid' && error.status === 400);
});

const line = (id, kind, name, quantity, extra = {}) => ({ id, kind, name, description: '', quantity, unitCents: 1000, totalCents: 1000 * quantity, optional: false, selected: true, group: null, ...extra });
test('sold shelving and storage products, and SKU lines, are bought; stock lines come from the yard; declined and customer-supplied lines are skipped', () => {
  const lines = [
    line('cleanout', 'service', 'Garage cleanout and reset', 1), line('shelving', 'product', 'Metal shelving unit', 4, { productUrl: 'https://www.homedepot.com/p/shelf/100', sku: 'HD-100', unitsPerPack: 1 }),
    line('totes', 'product', 'Storage tote', 10, { unitsPerPack: 4, catalog: { itemId: 'tote-27g', version: 3 }, description: 'Clear 27 gal ($12.98 each)' }), line('hooks', 'product', 'Utility hooks', 6, { category: 'wall-systems', store: "Lowe's", unit: 'hook' }),
    line('gloves', 'product', 'Work gloves', 2, { category: 'consumable' }), line('anchors', 'product', 'Wall anchors', 20, { category: 'consumable', sku: 'AN-20' }),
    line('own-rack', 'product', 'Customer rack', 1, { customerSupplied: true }), line('bins', 'product', 'Extra bins', 3, { optional: true, selected: false }), line('install', 'service', 'Shelving install', 1),
  ];
  assert.deepEqual(quoteLineMaterials(lines), [
    { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 4, sku: 'HD-100', unitsPerPack: 1, packs: 4, source: 'buy', purchaseState: 'to_buy', productUrl: 'https://www.homedepot.com/p/shelf/100', category: 'shelving' },
    { id: 'quote-totes', name: 'Storage tote', quantity: 10, unitsPerPack: 4, packs: 3, source: 'buy', purchaseState: 'to_buy', category: 'storage', catalogItemId: 'tote-27g' },
    { id: 'quote-hooks', name: 'Utility hooks', quantity: 6, unit: 'hook', source: 'buy', purchaseState: 'to_buy', category: 'storage', store: "Lowe's" },
    { id: 'quote-gloves', name: 'Work gloves', quantity: 2, source: 'stock', category: 'consumable' },
    { id: 'quote-anchors', name: 'Wall anchors', quantity: 20, sku: 'AN-20', source: 'buy', purchaseState: 'to_buy', category: 'consumable' },
  ], 'a priced description is never copied to the crew-visible note');
  assert.deepEqual(quoteLineMaterials(undefined), []);
  assert.deepEqual([materialCategory({ name: 'Wood shelving unit', kind: 'product' }), materialCategory({ name: 'Bike hook', kind: 'product' }), materialCategory({ name: 'Deep clean', kind: 'service' }), materialCategory({ name: 'Special handling: Piano', kind: 'fee' }), materialCategory({ category: 'overhead' })],
    ['shelving', 'storage', 'cleaning', 'removal', 'storage']);
  assert.deepEqual([materialStore({ productUrl: 'https://www.lowes.com/pd/1' }), materialStore({ store: 'Costco', productUrl: 'https://www.lowes.com/pd/1' }), materialStore({ productUrl: 'https://shop.example.com/a' }), materialStore({})],
    ["Lowe's", 'Costco', 'shop.example.com', NO_STORE]);
});

test('the bring list is validated and becomes kit stock materials without instructions or the sold products', () => {
  assert.deepEqual(bringList(undefined), []);
  for (const bad of ['Dolly', [1], ['x'.repeat(201)], [...Array(61)].map((_, i) => `Item ${i}`), ['a\u0007b']]) assert.equal(bringList(bad), null, JSON.stringify(bad).slice(0, 40));
  const list = bringList([' Hand truck / dolly ', 'Contractor bags', 'Hand truck / dolly', '4 metal shelving unit(s)', '6 totes', 'Confirm propane tank removed before loading', 'Extra crew member', 'Drill / driver', 'Drill driver', 'Lag screws and anchors', '']);
  assert.deepEqual(list, ['Hand truck / dolly', 'Contractor bags', '4 metal shelving unit(s)', '6 totes', 'Confirm propane tank removed before loading', 'Extra crew member', 'Drill / driver', 'Drill driver', 'Lag screws and anchors']);
  assert.deepEqual(bringListMaterials(list), [
    { id: 'kit-hand-truck-dolly', name: 'Hand truck / dolly', quantity: 1, source: 'stock', category: 'equipment' },
    { id: 'kit-contractor-bags', name: 'Contractor bags', quantity: 1, source: 'stock', category: 'consumable' },
    { id: 'kit-drill-driver', name: 'Drill / driver', quantity: 1, source: 'stock', category: 'equipment' },
    { id: 'kit-drill-driver-2', name: 'Drill driver', quantity: 1, source: 'stock', category: 'equipment' },
    { id: 'kit-lag-screws-and-anchors', name: 'Lag screws and anchors', quantity: 1, source: 'stock', category: 'consumable' },
  ]);
});

test('a signed revision keeps Dispatch entries and the purchase recorded for an unchanged product', () => {
  const previous = [
    { id: 'material-0-tarp', name: 'Tarp', quantity: 2, source: 'stock' },
    { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 4, source: 'buy', purchaseState: 'purchased', purchaseUpdatedAt: '2026-10-16T16:00:00.000Z', purchaseUpdatedBy: 'zacb', category: 'shelving' },
    { id: 'quote-totes', name: 'Storage tote', quantity: 2, source: 'buy', purchaseState: 'ordered', category: 'storage' },
    { id: 'quote-removed', name: 'Bike hook', quantity: 1, source: 'buy', purchaseState: 'purchased' },
    { id: 'kit-old', name: 'Old kit item', quantity: 1, source: 'stock' },
  ];
  const quoted = [{ id: 'quote-shelving', name: 'Metal shelving unit', quantity: 3, source: 'buy', purchaseState: 'to_buy', category: 'shelving' }, { id: 'quote-totes', name: 'Storage tote', quantity: 3, source: 'buy', purchaseState: 'to_buy', category: 'storage' }];
  const kit = bringListMaterials(['Hand truck / dolly']);
  assert.deepEqual(handoffJobMaterials({ previous, quoted, kit }), [
    previous[0],
    { ...quoted[0], purchaseState: 'purchased', purchaseUpdatedAt: '2026-10-16T16:00:00.000Z', purchaseUpdatedBy: 'zacb' },
    quoted[1],
    kit[0],
  ], 'more totes than were ordered go back to To buy; removed products and the old kit are dropped');
  const crowded = [...Array(97)].map((_, i) => ({ id: `material-${i}`, name: `Item ${i}`, quantity: 1 }));
  const result = handoffJobMaterials({ previous: crowded, quoted, kit: bringListMaterials(['Dolly', 'Broom', 'Shovel', 'Rake']) });
  assert.equal(result.length, 100); assert.deepEqual(result.slice(97).map(item => item.id), ['quote-shelving', 'quote-totes', 'kit-dolly'], 'the bring list only fills the room left');
  assert.equal(handoffJobMaterials({ previous: ['Legacy tarp'], quoted, kit }), null, 'a list Dispatch cannot validate is left to the caller');
});

test('the purchase list sums buy quantities across jobs by store and product, follows the crew Loaded tick and skips closed jobs and stock', () => {
  const shelf = (id, quantity, extra = {}) => ({ id, name: 'Metal shelving unit', quantity, sku: 'HD-100', unitsPerPack: 2, source: 'buy', purchaseState: 'to_buy', productUrl: 'https://www.homedepot.com/p/100', category: 'shelving', ...extra });
  const jobs = [
    { id: 'job-b', type: 'job', date: '2026-10-21', time: '09:30', status: 'scheduled', customer: 'Customer B', materials: [shelf('quote-shelving', 3), { id: 'kit-dolly', name: 'Dolly', quantity: 1, source: 'stock' }, 'Legacy tarp'], fieldExecution: { materialStates: {} } },
    { id: 'job-a', type: 'job', date: '2026-10-20', time: '13:00', status: 'scheduled', customer: 'Customer A', materials: [shelf('quote-shelving', 2, { purchaseState: 'ordered' }), { id: 'quote-hooks', name: 'Utility hooks', quantity: 6, source: 'buy', purchaseState: 'purchased', store: "Lowe's" }] },
    { id: 'job-c', type: 'cleanout', date: '2026-10-20', time: '09:30', status: 'scheduled', customer: 'Customer C', materials: [shelf('quote-shelving', 1, { purchaseState: 'purchased' }), { id: 'quote-misc', name: 'Mystery part', quantity: 1, source: 'buy' }], fieldExecution: { materialStates: { 'quote-shelving': { state: 'loaded' } } } },
    { id: 'job-x', type: 'job', date: '2026-10-20', status: 'cancelled', customer: 'Cancelled', materials: [shelf('quote-shelving', 9)] },
    { id: 'walk-1', type: 'walkthrough', date: '2026-10-20', materials: [shelf('quote-shelving', 9)] },
    { id: 'job-legacy', type: 'job', date: '2026-10-22', status: 'scheduled', materials: [{ id: 'quote-shelving', name: 'Metal shelving unit', quantity: 5 }] },
  ];
  const list = purchaseList(jobs);
  assert.deepEqual([list.lines, list.jobs], [5, 3]);
  assert.deepEqual(list.stores.map(store => store.store), ['Home Depot', "Lowe's", NO_STORE]);
  const [hd] = list.stores[0].products;
  assert.deepEqual({ ...hd, jobs: undefined }, { key: 'sku:hd-100', name: 'Metal shelving unit', sku: 'HD-100', unit: '', unitsPerPack: 2, productUrl: 'https://www.homedepot.com/p/100', category: 'shelving', quantity: 6, byState: { to_buy: 3, ordered: 2, purchased: 0, loaded: 1 }, toBuy: 3, packsToBuy: 2, jobs: undefined });
  assert.deepEqual(hd.jobs.map(job => [job.jobId, job.date, job.quantity, job.purchaseState, job.href]), [
    ['job-c', '2026-10-20', 1, 'loaded', '/crew/job.html?jobId=job-c'], ['job-a', '2026-10-20', 2, 'ordered', '/crew/job.html?jobId=job-a'], ['job-b', '2026-10-21', 3, 'to_buy', '/crew/job.html?jobId=job-b']]);
  assert.equal(JSON.stringify(list).includes('Cents'), false);
  assert.equal(effectivePurchaseState({ purchaseState: 'ordered' }, 'used'), 'loaded');
  assert.equal(effectivePurchaseState({}, 'required'), 'to_buy');
});

test('a purchase state change touches only the chosen buy materials and refuses anything else', () => {
  const job = { materials: ['Legacy tarp', { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 2, source: 'buy', purchaseState: 'to_buy' }, { id: 'kit-dolly', name: 'Dolly', quantity: 1, source: 'stock' }] };
  const { materials, changed } = applyPurchaseState(job, ['quote-shelving'], 'purchased', 'zacb', '2026-10-17T16:00:00.000Z');
  assert.deepEqual(materials, ['Legacy tarp', { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 2, source: 'buy', purchaseState: 'purchased', purchaseUpdatedAt: '2026-10-17T16:00:00.000Z', purchaseUpdatedBy: 'zacb' }, job.materials[2]]);
  assert.deepEqual(changed, [{ id: 'quote-shelving', name: 'Metal shelving unit', from: 'to_buy', to: 'purchased' }]);
  for (const [ids, state, code] of [[['kit-dolly'], 'purchased', 'purchase_material_missing'], [['missing'], 'ordered', 'purchase_material_missing'], [['quote-shelving'], 'lost', 'purchase_state_invalid'], [[], 'ordered', 'purchase_materials_invalid'], [['quote-shelving', 'quote-shelving'], 'ordered', 'purchase_materials_invalid']]) {
    assert.throws(() => applyPurchaseState(job, ids, state, 'zacb', '2026-10-17T16:00:00.000Z'), error => error.code === code, `${ids} ${state}`);
  }
});

test('the crew projection adds source and purchase state to a structured material and leaves a legacy one exactly as before', () => {
  const job = { materials: [{ id: 'm1', name: 'Rope', quantity: 1 }, 'Legacy tarp', { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 4, unit: 'unit', unitsPerPack: 2, packs: 2, source: 'buy', purchaseState: 'purchased', productUrl: 'https://www.homedepot.com/p/1', sku: 'HD-1', store: 'Home Depot', note: 'Was $129 each', category: 'shelving' }, { id: 'kit-bags', name: 'Contractor bags', quantity: 1, source: 'stock', category: 'consumable', note: 'Two boxes' }],
    fieldExecution: { materialStates: { 'kit-bags': { state: 'loaded', at: '2026-10-17T15:00:00.000Z', actorName: 'Crew One' } } } };
  assert.deepEqual(fieldMaterials(job), [
    { id: 'm1', name: 'Rope', quantity: 1, state: 'required', updatedAt: null, updatedBy: null },
    { id: 'material-1', name: 'Legacy tarp', quantity: null, state: 'required', updatedAt: null, updatedBy: null },
    { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 4, source: 'buy', purchaseState: 'purchased', unit: 'unit', category: 'shelving', unitsPerPack: 2, packs: 2, state: 'required', updatedAt: null, updatedBy: null },
    { id: 'kit-bags', name: 'Contractor bags', quantity: 1, source: 'stock', category: 'consumable', note: 'Two boxes', state: 'loaded', updatedAt: '2026-10-17T15:00:00.000Z', updatedBy: 'Crew One' },
  ], 'no price note, product link, SKU or store reaches the crew');
  assert.deepEqual(crewMaterialFields({ id: 'a', name: 'A', quantity: 1 }), {});
  assert.deepEqual(crewMaterialFields({ source: 'buy' }), { source: 'buy', purchaseState: 'to_buy' });
});

test('the job breakdown lists removal, then shelving, storage and cleaning, without money', () => {
  const plan = { scope: { loads: '2', garages: '2', fullness: 'Heavy', sort_method: 'Keep / donate / dump', keep_items: 'Tools', remove_items: 'Old couch', exclusions: 'Freezer', hazards: ['Pest waste', 'No visible hazards'], special_items: ['Mattress', '2× Couch / sofa / loveseat'], access: ['Stairs'], finish: ['shelving', 'totes', 'deep_clean', 'mouse_trapping'], finish_details: { shelf_type: 'metal', shelf_qty: 4, tote_qty: 6 }, hazard_details: { pest_waste: { amount: 200 } } },
    quote: { itemized: true, estimate_line_items: [line('cleanout', 'service', 'Garage cleanout and reset', 1), line('special-mattress', 'fee', 'Special handling: Mattress ($75)', 1), line('shelving', 'product', 'Metal shelving unit', 4), line('totes', 'product', 'Storage tote', 6),
      line('epoxy', 'service', 'Epoxy floor coating ($900)', 1, { category: 'cleaning' }), line('rack', 'product', 'Bike rack', 1, { customerSupplied: true }), line('declined', 'product', 'Overhead rack', 1, { optional: true, selected: false }), line('deep-clean', 'service', 'Deep clean', 1)] } };
  const breakdown = jobBreakdown(plan);
  assert.deepEqual(breakdown.sections, [
    { id: 'removal', title: 'Removal', items: ['About 2 truckloads · 2-car garage · Heavy full', 'Special handling: Mattress, 2× Couch / sofa / loveseat', 'Remove / donate: Old couch', 'Keep: Tools', 'Do not move: Freezer', 'Sort: Keep / donate / dump', 'Hazards: Pest waste', 'Access: Stairs'] },
    { id: 'shelving', title: 'Shelving', items: ['4 × Metal shelving unit'] },
    { id: 'storage', title: 'Storage', items: ['6 × Storage tote', 'Bike rack (customer supplied)'] },
    { id: 'cleaning', title: 'Cleaning', items: ['Epoxy floor coating', 'Deep clean', 'Non-toxic mouse trapping', 'Pest-waste cleanup'] },
  ]);
  assert.equal(breakdown.version, '2026-10-breakdown-v1');
  assert.equal(breakdown.summary, breakdownLines(breakdown).join('\n'));
  assert.match(breakdown.summary, /^Removal: About 2 truckloads.*\nShelving: 4 × Metal shelving unit\nStorage: 6 × Storage tote; Bike rack \(customer supplied\)\nCleaning: Epoxy floor coating; Deep clean; Non-toxic mouse trapping; Pest-waste cleanup$/s);
  assert.doesNotMatch(JSON.stringify(breakdown), /\$|900|75\b|200/);
  const legacy = jobBreakdown({ scope: { finish: ['shelving', 'totes', 'pressure_wash'], finish_details: { shelf_type: 'wood', shelf_qty: 1, tote_qty: 3 } }, quote: {} });
  assert.deepEqual(legacy.sections.map(section => section.items), [[], ['1 wood shelving unit'], ['3 storage totes'], ['One-car garage pressure wash']], 'a plan without line items still reads its finish details');
  assert.deepEqual(breakdownLines(legacy), ['Shelving: 1 wood shelving unit', 'Storage: 3 storage totes', 'Cleaning: One-car garage pressure wash']);
});
