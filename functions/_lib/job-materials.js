import { hasCrewMoney } from './crew-money.js';

/** Structured job materials (WP14c): what the office buys for a sold job and what the crew grabs before leaving.
 * Pure: no storage, no clock, no env reads except jobMaterialsEnabled.
 *
 * A job.materials entry keeps the original Dispatch shape {id, name, quantity} and may carry, only when known:
 *   sku, unit, unitsPerPack, packs   what to buy (packs = whole packs for quantity when sold in packs of unitsPerPack)
 *   source                            'buy' (the office purchases it for this job) | 'stock' (taken from the yard)
 *   purchaseState                     'to_buy' | 'ordered' | 'purchased' | 'loaded' (buy items; the office sets it)
 *   productUrl, note, category, store, catalogItemId, purchaseUpdatedAt, purchaseUpdatedBy
 * quantity is the line's qty. No price, cost or margin is ever stored on a material: crew read this list.
 * A legacy {id, name, quantity} entry validates and normalizes byte-identically to the earlier Dispatch rule. */

// Exactly "true": a signed walkthrough saves structured materials, the bring list and the job breakdown, the office
// purchase list (/api/purchase-list) answers, and the crew job page shows the Grab before you go list. Unset: as before.
export const jobMaterialsEnabled = env => env?.EGC_JOB_MATERIALS === 'true';

export const MATERIAL_SOURCES = Object.freeze(['buy', 'stock']);
export const PURCHASE_STATES = Object.freeze(['to_buy', 'ordered', 'purchased', 'loaded']);
// The states the office records on the purchase list. Loaded is the crew's tick (fieldExecution.materialStates).
export const OFFICE_PURCHASE_STATES = Object.freeze(['to_buy', 'ordered', 'purchased']);
export const MATERIAL_CATEGORIES = Object.freeze(['shelving', 'storage', 'cleaning', 'removal', 'consumable', 'equipment', 'other']);
const OPTIONAL = ['sku', 'unit', 'unitsPerPack', 'packs', 'source', 'purchaseState', 'productUrl', 'note', 'category', 'store', 'catalogItemId', 'purchaseUpdatedAt', 'purchaseUpdatedBy'];
export const JOB_MATERIAL_KEYS = Object.freeze(['id', 'name', 'quantity', ...OPTIONAL]);
export const MATERIAL_LIMIT = 100;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(secure_|_egc_)/.test(id);
const defaultFail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const CONTROL = /[\u0000-\u001f\u007f]/;
const absent = value => value === undefined || value === null || value === '';

function optionalText(value, max, fail, label) {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) throw fail('dispatch_materials_invalid', `Material ${label} must be text of at most ${max} characters.`);
  return value.trim();
}
function optionalInteger(value, min, max, fail, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw fail('dispatch_materials_invalid', `Material ${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
export function productUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || CONTROL.test(value)) return '';
  try { const url = new URL(value.trim()); return ['https:', 'http:'].includes(url.protocol) && url.hostname ? url.href : ''; } catch { return ''; }
}

/** One material, validated like Dispatch saves it. A legacy {id,name,quantity} entry is checked and returned exactly as
 * before (same error codes and messages); the optional fields are checked only when present. */
export function normalizeJobMaterial(material, fail = defaultFail) {
  if (!plain(material) || Object.keys(material).some(key => !JOB_MATERIAL_KEYS.includes(key))) throw fail('dispatch_patch_not_allowed', 'This request contains unsupported fields. Refresh the dispatch form and try again.');
  if (!safeId(material.id) || typeof material.quantity !== 'number' || !Number.isFinite(material.quantity) || material.quantity <= 0 || material.quantity > 100000) throw fail('dispatch_materials_invalid', 'Each material needs a stable ID and a positive quantity.');
  if (typeof material.name !== 'string' || material.name.length > 200) throw fail('dispatch_invalid_field', 'Material name must be text of at most 200 characters.');
  const name = material.name.trim();
  if (!name) throw fail('dispatch_materials_invalid', 'Each material needs a name.');
  const output = { id: material.id, name, quantity: material.quantity };
  const set = (key, value) => { if (!absent(value)) output[key] = value; };
  if (!absent(material.sku)) set('sku', optionalText(material.sku, 80, fail, 'SKU'));
  if (!absent(material.unit)) set('unit', optionalText(material.unit, 40, fail, 'unit'));
  if (!absent(material.unitsPerPack)) set('unitsPerPack', optionalInteger(material.unitsPerPack, 1, 10000, fail, 'units per pack'));
  if (!absent(material.packs)) set('packs', optionalInteger(material.packs, 1, 100000, fail, 'pack count'));
  if (!absent(material.source)) { if (!MATERIAL_SOURCES.includes(material.source)) throw fail('dispatch_materials_invalid', 'Material source must be buy or stock.'); set('source', material.source); }
  if (!absent(material.purchaseState)) { if (!PURCHASE_STATES.includes(material.purchaseState)) throw fail('dispatch_materials_invalid', 'Material purchase state must be to_buy, ordered, purchased or loaded.'); set('purchaseState', material.purchaseState); }
  if (!absent(material.productUrl)) { const url = productUrl(material.productUrl); if (!url) throw fail('dispatch_materials_invalid', 'Material product link must be an http or https address of at most 500 characters.'); set('productUrl', url); }
  if (!absent(material.note)) set('note', optionalText(material.note, 500, fail, 'note'));
  if (!absent(material.category)) { if (!MATERIAL_CATEGORIES.includes(material.category)) throw fail('dispatch_materials_invalid', `Material category must be one of ${MATERIAL_CATEGORIES.join(', ')}.`); set('category', material.category); }
  if (!absent(material.store)) set('store', optionalText(material.store, 80, fail, 'store'));
  if (!absent(material.catalogItemId)) { if (!safeId(material.catalogItemId) || material.catalogItemId.length > 120) throw fail('dispatch_materials_invalid', 'Material catalog item must be a catalog id.'); set('catalogItemId', material.catalogItemId); }
  if (!absent(material.purchaseUpdatedAt)) { const at = optionalText(material.purchaseUpdatedAt, 40, fail, 'purchase time'); if (!Number.isFinite(Date.parse(at))) throw fail('dispatch_materials_invalid', 'Material purchase time must be a timestamp.'); set('purchaseUpdatedAt', at); }
  if (!absent(material.purchaseUpdatedBy)) set('purchaseUpdatedBy', optionalText(material.purchaseUpdatedBy, 120, fail, 'purchase actor'));
  return output;
}

/** The Dispatch materials rule (dispatch-service.js schedulePatch): at most 100 entries with unique ids. */
export function normalizeJobMaterials(list, fail = defaultFail) {
  if (!Array.isArray(list) || list.length > MATERIAL_LIMIT) throw fail('dispatch_materials_invalid', 'Enter at most 100 required materials.');
  const materials = list.map(material => normalizeJobMaterial(material, fail));
  if (new Set(materials.map(item => item.id)).size !== materials.length) throw fail('dispatch_materials_invalid', 'Material IDs must be unique.');
  return materials;
}
export function isJobMaterial(material) { try { normalizeJobMaterial(material); return true; } catch { return false; } }
export function validJobMaterials(list) { try { normalizeJobMaterials(list); return true; } catch { return false; } }

// Catalog product categories (functions/_lib/catalog.js PRODUCT_CATEGORIES) and the quote builder's sections.
const CATEGORY_MAP = Object.freeze({ shelving: 'shelving', storage: 'storage', overhead: 'storage', 'wall-systems': 'storage', 'small-items': 'storage', bikes: 'storage', 'cabinets-workbenches': 'storage',
  'sports-outdoor': 'storage', 'lawn-garden': 'storage', 'floors-lighting-extras': 'storage', cleaning: 'cleaning', services: 'other', removal: 'removal', consumable: 'consumable', consumables: 'consumable', equipment: 'equipment' });
const SHELVING = /\bshel(?:f|ves|ving)\b/i;
const STORAGE = /\b(?:totes?|bins?|racks?|hooks?|overhead|cabinets?|workbench(?:es)?|pegboards?|slatwall|wall system|tracks?|bike|storage|organizers?|hangers?|baskets?)\b/i;
const CLEANING = /\b(?:clean(?:ing|up)?|wash(?:ing)?|degrease|epoxy|sweep|trapping)\b/i;
const REMOVAL = /\b(?:removal|haul(?:ing)?|cleanout|disposal|dump|junk|special handling|carry|stairs)\b/i;

/** The job-breakdown section a quote line belongs to: its category when the quote builder set one, else its group/zone,
 * else its name. Products default to storage, services to removal. */
export function materialCategory(line = {}) {
  const raw = typeof line.category === 'string' ? line.category.trim().toLowerCase() : '';
  if (CATEGORY_MAP[raw]) return CATEGORY_MAP[raw];
  const zone = [line.group?.zone, line.group?.id, line.package].filter(value => typeof value === 'string').join(' ').toLowerCase();
  const name = `${typeof line.name === 'string' ? line.name : ''} ${zone}`;
  if (SHELVING.test(name)) return 'shelving';
  if (line.kind === 'product') return 'storage';
  if (CLEANING.test(name)) return 'cleaning';
  if (STORAGE.test(name)) return 'storage';
  if (REMOVAL.test(name) || ['service', 'fee'].includes(line.kind)) return 'removal';
  return 'other';
}

const STORES = [[/(^|\.)homedepot\.com$/, 'Home Depot'], [/(^|\.)lowes\.com$/, "Lowe's"], [/(^|\.)amazon\.com$/, 'Amazon'], [/(^|\.)costco\.com$/, 'Costco'], [/(^|\.)walmart\.com$/, 'Walmart'],
  [/(^|\.)target\.com$/, 'Target'], [/(^|\.)menards\.com$/, 'Menards'], [/(^|\.)acehardware\.com$/, 'Ace Hardware'], [/(^|\.)ikea\.com$/, 'IKEA'], [/(^|\.)containerstore\.com$/, 'The Container Store'], [/(^|\.)samsclub\.com$/, "Sam's Club"]];
export const NO_STORE = 'Store not set';
/** Where to buy it: the saved store, else the product link's retailer, else NO_STORE. */
export function materialStore(material = {}) {
  const named = typeof material.store === 'string' ? material.store.trim() : '';
  if (named) return named.slice(0, 80);
  const url = productUrl(material.productUrl);
  if (!url) return NO_STORE;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  return STORES.find(([pattern]) => pattern.test(host))?.[1] || host.slice(0, 80);
}

const text = (value, max) => typeof value === 'string' && !CONTROL.test(value) ? value.trim().slice(0, max) : '';
const included = line => plain(line) && (line.group ? line.selected === true : !line.optional || line.selected === true);
const packsFor = (quantity, unitsPerPack) => Number.isInteger(unitsPerPack) && unitsPerPack >= 1 ? Math.max(1, Math.ceil(quantity / unitsPerPack)) : null;

/** Materials for the sold product lines of a signed quote: id quote-<line id>, never a customer-supplied or declined
 * line. Shelving and storage products, and any line with a SKU, are bought for the job (source 'buy', 'to_buy');
 * a line the quote builder marked source 'stock', or a consumable/equipment line without a SKU, comes from stock. */
export function quoteLineMaterials(lineItems) {
  const out = [];
  for (const line of Array.isArray(lineItems) ? lineItems : []) {
    if (!included(line) || line.kind !== 'product' || line.customerSupplied === true || !safeId(`quote-${line.id}`) || typeof line.quantity !== 'number' || !(line.quantity > 0) || line.quantity > 100000) continue;
    const name = text(line.name, 200);
    if (!name) continue;
    const category = materialCategory(line), sku = text(line.sku, 80), unitsPerPack = Number.isInteger(line.unitsPerPack) && line.unitsPerPack >= 1 && line.unitsPerPack <= 10000 ? line.unitsPerPack : null;
    const source = MATERIAL_SOURCES.includes(line.source) ? line.source : ['shelving', 'storage'].includes(category) || sku ? 'buy' : ['consumable', 'equipment'].includes(category) ? 'stock' : 'buy';
    const url = productUrl(line.productUrl), store = text(line.store || line.retailer || line.vendor, 80), unit = text(line.unit, 40), itemId = line.catalog?.itemId;
    // A customer-facing description is kept only when it carries no price (crew read materials).
    const note = text(line.description, 500);
    const material = { id: `quote-${line.id}`, name, quantity: line.quantity, ...(sku ? { sku } : {}), ...(unit ? { unit } : {}),
      ...(unitsPerPack ? { unitsPerPack, packs: packsFor(line.quantity, unitsPerPack) } : {}), source, ...(source === 'buy' ? { purchaseState: 'to_buy' } : {}),
      ...(url ? { productUrl: url } : {}), ...(note && !hasCrewMoney(note) ? { note } : {}), category, ...(store ? { store } : {}), ...(safeId(itemId) && itemId.length <= 120 ? { catalogItemId: itemId } : {}) };
    if (isJobMaterial(material)) out.push(material);
  }
  return out;
}

/** The gameplan's bring list (plan.logistics.bring_list): up to 60 distinct non-empty strings of at most 200
 * characters. Anything else is refused (null) rather than partly read. */
export function bringList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 60 || value.some(item => typeof item !== 'string' || item.length > 200 || CONTROL.test(item))) return null;
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}
// Instructions and sold products already listed as buy materials ("4 metal shelving unit(s)", "6 totes") are not grabbed from stock.
const NOT_GRABBED = /^(?:confirm\b|extra crew member\b)|^\d+\s.*\b(?:shel(?:f|ving)|totes?)\b/i;
const CONSUMABLE = /\b(?:bags?|gloves?|traps?|degreaser|spray|disinfectant|coveralls?|respirators?|screws?|anchors?|towels?|sealable bins?|tape|zip ties?|labels?)\b/i;
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
/** Stock materials (id kit-<slug>, quantity 1) the crew grabs from the yard, from a validated bring list. */
export function bringListMaterials(list) {
  const out = [], ids = new Set();
  for (const name of Array.isArray(list) ? list : []) {
    if (NOT_GRABBED.test(name)) continue;
    let id = `kit-${slug(name)}`, n = 2;
    while (ids.has(id)) id = `kit-${slug(name).slice(0, 56)}-${n++}`;
    ids.add(id);
    out.push({ id, name: name.slice(0, 200), quantity: 1, source: 'stock', category: CONSUMABLE.test(name) ? 'consumable' : 'equipment' });
  }
  return out;
}

const derived = item => plain(item) && typeof item.id === 'string' && /^(?:quote|kit)-/.test(item.id);
/** The materials a signed handoff saves: the earlier list's own entries (added in Dispatch) kept as they are, then
 * the quote's buy/stock materials and the bring list's stock materials, regenerated. A quote material that is
 * still the same product (same name and SKU, quantity not raised) keeps the purchase state the office recorded.
 * Returns null when the result cannot be saved as Dispatch materials (the caller then leaves the list untouched). */
export function handoffJobMaterials({ previous, quoted = [], kit = [] }) {
  const list = Array.isArray(previous) ? previous : [], kept = list.filter(item => !derived(item)), before = new Map(list.filter(derived).map(item => [item.id, item]));
  const carry = item => {
    const old = before.get(item.id);
    if (item.source !== 'buy' || !plain(old) || old.source !== 'buy' || !PURCHASE_STATES.includes(old.purchaseState) || old.name !== item.name || (old.sku || '') !== (item.sku || '') || !(item.quantity <= old.quantity)) return item;
    return { ...item, purchaseState: old.purchaseState, ...(old.purchaseUpdatedAt ? { purchaseUpdatedAt: old.purchaseUpdatedAt } : {}), ...(old.purchaseUpdatedBy ? { purchaseUpdatedBy: old.purchaseUpdatedBy } : {}) };
  };
  const fresh = rows => rows.filter(item => !kept.some(row => plain(row) && row.id === item.id));
  const sold = fresh(quoted.map(carry)), grab = fresh(kit);
  // The bring list fills only the room the 100-material limit leaves after Dispatch's own entries and the sold products.
  const materials = [...kept, ...sold, ...grab.slice(0, Math.max(0, MATERIAL_LIMIT - kept.length - sold.length))];
  return validJobMaterials(materials) ? materials : null;
}

const EQUIPMENT_LIMIT = 100; // dispatch-service schedulePatch: at most 100 pieces of required equipment
/** The bring list a handoff saved in the crew brief (job.jobInstructions.bringList), read leniently: [] when none. */
export const savedBringList = instructions => plain(instructions) && Array.isArray(instructions.bringList) ? instructions.bringList.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
/** The job's required equipment after a signed handoff sends a bring list. Every entry the earlier bring list did not
 * put there (added in Dispatch, or carried from the walkthrough) is kept as it is; the earlier bring list's entries
 * are swapped for the new list's. Instructions and sold products ("Confirm ...", "Extra crew member", "4 metal
 * shelving unit(s)") stay in the crew brief's bring list only. Dispatch's own entries come first and the bring list
 * fills the room the 100-entry Dispatch limit leaves. Returns null when the list would not change. */
export function handoffEquipment({ current, earlier = [], bring = [] }) {
  const list = Array.isArray(current) ? current.filter(item => typeof item === 'string' && item.length <= 200).map(item => item.trim()).filter(Boolean) : [];
  const old = new Set((Array.isArray(earlier) ? earlier : []).filter(item => typeof item === 'string').map(item => item.trim()));
  const kept = [...new Set(list.filter(item => !old.has(item)))].slice(0, EQUIPMENT_LIMIT);
  const kit = [...new Set((Array.isArray(bring) ? bring : []).filter(item => typeof item === 'string' && !NOT_GRABBED.test(item)).map(item => item.trim()).filter(item => item && !kept.includes(item)))];
  const next = [...kept, ...kit.slice(0, EQUIPMENT_LIMIT - kept.length)];
  return JSON.stringify(next) === JSON.stringify(Array.isArray(current) ? current : []) ? null : next;
}

/** The purchase state the office sees: the crew's Loaded (or Used) tick on the job outranks the office's record. */
export function effectivePurchaseState(material, crewState) {
  if (['loaded', 'used'].includes(crewState)) return 'loaded';
  return PURCHASE_STATES.includes(material?.purchaseState) ? material.purchaseState : 'to_buy';
}

/** The crew-visible extras of a material (fieldMaterials): only those saved, so a legacy entry projects as before. */
export function crewMaterialFields(item) {
  if (!plain(item)) return {};
  const out = {};
  if (MATERIAL_SOURCES.includes(item.source)) out.source = item.source;
  if (item.source === 'buy') out.purchaseState = PURCHASE_STATES.includes(item.purchaseState) ? item.purchaseState : 'to_buy';
  const unit = text(item.unit, 40), note = text(item.note, 500);
  if (unit) out.unit = unit;
  if (MATERIAL_CATEGORIES.includes(item.category)) out.category = item.category;
  if (note && !hasCrewMoney(note)) out.note = note;
  for (const key of ['unitsPerPack', 'packs']) if (Number.isInteger(item[key]) && item[key] >= 1) out[key] = item[key];
  return out;
}

/** Changes the office purchase state of some buy materials on a job. Returns {materials, changed:[{id,name,from,to}]};
 * every other entry (including a legacy string row) is kept exactly. */
export function applyPurchaseState(job, materialIds, state, actor, now, fail = defaultFail) {
  if (!OFFICE_PURCHASE_STATES.includes(state)) throw fail('purchase_state_invalid', 'Choose to buy, ordered or purchased. The crew ticks Loaded on the job.');
  if (!Array.isArray(materialIds) || !materialIds.length || materialIds.length > MATERIAL_LIMIT || materialIds.some(id => !safeId(id)) || new Set(materialIds).size !== materialIds.length) throw fail('purchase_materials_invalid', 'Choose up to 100 different materials on this job.');
  const list = Array.isArray(job?.materials) ? job.materials : [], changed = [];
  for (const id of materialIds) {
    const item = list.find(row => plain(row) && row.id === id);
    if (!item || item.source !== 'buy' || !isJobMaterial(item)) throw fail('purchase_material_missing', 'A chosen material is no longer a buy item on this job. Refresh the purchase list.', 409);
  }
  const materials = list.map(row => {
    if (!plain(row) || !materialIds.includes(row.id)) return row;
    const from = effectivePurchaseState(row);
    changed.push({ id: row.id, name: row.name, from, to: state });
    return { ...row, purchaseState: state, purchaseUpdatedAt: now, purchaseUpdatedBy: String(actor || '').slice(0, 120) };
  });
  return { materials, changed };
}

const CLOSED = new Set(['cancelled', 'canceled', 'completed', 'paid', 'invoiced', 'closed', 'review_requested', 'noshow', 'no_show', 'no-show']);
/** A job the office still buys for: neither its pipeline status nor its status is cancelled, finished or a no-show. */
export const purchaseJobOpen = job => plain(job) && ![job.pipelineStatus, job.status].some(value => CLOSED.has(String(value || '').toLowerCase()));
const productKey = material => material.sku ? `sku:${material.sku.toLowerCase()}` : material.catalogItemId ? `item:${material.catalogItemId}` : `name:${material.name.toLowerCase()}|${(material.unit || '').toLowerCase()}`;
/** The office purchase list for upcoming jobs: buy materials grouped by store, then product, quantities summed across
 * jobs with each job's share, state and link. Cancelled and finished jobs are left out. No money is read or returned. */
export function purchaseList(jobs) {
  const stores = new Map(), seen = new Set();
  let jobCount = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!plain(job) || !safeId(job.id) || job.recordType || !['job', 'cleanout', 'reorg'].includes(job.type) || !purchaseJobOpen(job)) continue;
    const crew = plain(job.fieldExecution?.materialStates) ? job.fieldExecution.materialStates : {};
    let counted = false;
    for (const material of Array.isArray(job.materials) ? job.materials : []) {
      if (!plain(material) || material.source !== 'buy' || !isJobMaterial(material)) continue;
      const item = normalizeJobMaterial(material), state = effectivePurchaseState(item, crew[item.id]?.state), store = materialStore(item), key = productKey(item);
      if (!stores.has(store)) stores.set(store, new Map());
      const products = stores.get(store);
      if (!products.has(key)) products.set(key, { key, name: item.name, sku: item.sku || '', unit: item.unit || '', unitsPerPack: item.unitsPerPack || null, productUrl: item.productUrl || '', category: item.category || '', quantity: 0, byState: Object.fromEntries(PURCHASE_STATES.map(name => [name, 0])), jobs: [] });
      const row = products.get(key);
      row.quantity += item.quantity; row.byState[state] += item.quantity;
      if (!row.productUrl && item.productUrl) row.productUrl = item.productUrl;
      if (row.jobs.length && row.unitsPerPack !== (item.unitsPerPack || null)) row.unitsPerPack = null;
      row.jobs.push({ jobId: job.id, materialId: item.id, date: text(job.date, 10), time: text(job.time, 5), customer: text(job.customer, 200), title: text(job.title, 200), quantity: item.quantity, ...(item.packs ? { packs: item.packs } : {}), purchaseState: state, href: `/crew/job.html?jobId=${encodeURIComponent(job.id)}` });
      seen.add(`${job.id}/${item.id}`); counted = true;
    }
    if (counted) jobCount++;
  }
  const round = value => Math.round(value * 100) / 100;
  const list = [...stores].map(([store, products]) => ({ store, products: [...products.values()].map(row => {
    const open = round(row.byState.to_buy);
    return { ...row, quantity: round(row.quantity), byState: Object.fromEntries(Object.entries(row.byState).map(([name, value]) => [name, round(value)])), toBuy: open, packsToBuy: row.unitsPerPack && open > 0 ? Math.ceil(open / row.unitsPerPack) : null,
      jobs: row.jobs.sort((a, b) => `${a.date} ${a.time || '99:99'}`.localeCompare(`${b.date} ${b.time || '99:99'}`) || a.jobId.localeCompare(b.jobId)) };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)) }))
    .sort((a, b) => (a.store === NO_STORE) - (b.store === NO_STORE) || a.store.localeCompare(b.store));
  return { stores: list, lines: seen.size, jobs: jobCount };
}
