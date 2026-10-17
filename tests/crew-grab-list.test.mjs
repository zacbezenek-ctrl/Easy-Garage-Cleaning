import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

// WP14c: the crew job page's Materials card opens with Grab before you go for structured materials (EGC_JOB_MATERIALS);
// a job with only {id,name,quantity} materials renders exactly as before.
const source = readFileSync(new URL('../crew/job.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../crew/job.html', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../crew/sw.js', import.meta.url), 'utf8');
const lineOf = prefix => { const found = source.split(/\r?\n/).find(row => row.startsWith(prefix)); assert.ok(found, prefix); return found; };
function page() {
  const context = vm.createContext({});
  vm.runInContext([lineOf('  const esc = '), lineOf('  const label = '), source.slice(source.indexOf('  // The Materials card:'), source.indexOf('  function renderJob() {'))].join('\n') + '\nthis.api = { materialsCard, equipmentText, grabList };', context);
  return context.api;
}
// The card before WP14c, verbatim from crew/job.js renderJob.
const label = value => String(value || '').replaceAll('_', ' ');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const before = (j, disabled) => j.materials.length ? `<section class="card"><h2>Materials</h2>${j.materials.map(item => `<div class="material"><div><strong>${esc(item.name)}</strong>${item.quantity != null ? `<br><small>Quantity: ${esc(item.quantity)}</small>` : ''}${item.queued ? '<small class="queued-tag">Waiting to sync</small>' : ''}</div><select aria-label="${esc(item.name)} state" data-material="${esc(item.id)}" ${!j.canEdit || disabled ? 'disabled' : ''}>${['required', 'loaded', 'used', 'missing'].map(state => `<option value="${state}" ${state === item.state ? 'selected' : ''}>${label(state)}</option>`).join('')}</select></div>`).join('')}</section>` : '';

const legacy = { canEdit: true, requiredEquipment: ['Drill'], materials: [{ id: 'm1', name: 'Rope <thick>', quantity: 2, state: 'loaded' }, { id: 'material-1', name: 'Legacy tarp', quantity: null, state: 'required', queued: true }] };
const structured = () => ({ canEdit: true, requiredEquipment: ['Hand truck / dolly', 'Contractor bags', 'Confirm propane tank removed before loading'], materials: [
  { id: 'kit-hand-truck-dolly', name: 'Hand truck / dolly', quantity: 1, source: 'stock', category: 'equipment', state: 'loaded' },
  { id: 'kit-contractor-bags', name: 'Contractor bags', quantity: 1, source: 'stock', category: 'consumable', note: 'Two boxes', state: 'required' },
  { id: 'quote-shelving', name: 'Metal shelving unit', quantity: 4, unit: 'unit', unitsPerPack: 2, packs: 2, source: 'buy', purchaseState: 'purchased', category: 'shelving', state: 'used' },
  { id: 'quote-totes', name: 'Storage tote', quantity: 6, source: 'buy', purchaseState: 'ordered', category: 'storage', state: 'required' },
  { id: 'quote-hooks', name: 'Utility hooks', quantity: 3, source: 'buy', purchaseState: 'to_buy', category: 'storage', state: 'required' },
  { id: 'material-0-tarp', name: 'Tarp', quantity: 1, state: 'required' },
] });

test('a job whose materials carry no buy/stock source renders the Materials card exactly as before', () => {
  const api = page();
  for (const disabled of [false, true]) for (const canEdit of [true, false]) {
    const job = { ...legacy, canEdit };
    assert.equal(api.materialsCard(job, disabled), before(job, disabled), `disabled=${disabled} canEdit=${canEdit}`);
  }
  assert.equal(api.materialsCard({ ...legacy, materials: [] }, false), '');
  assert.equal(api.equipmentText(legacy), 'Drill');
  assert.equal(api.equipmentText({ materials: [], requiredEquipment: [] }), 'No equipment list recorded');
});

test('Grab before you go lists stock and bought items to tick Loaded, shows what the office is still buying, and keeps On site states', () => {
  const api = page(), job = structured(), markup = api.materialsCard(job, false);
  assert.match(markup, /^<section class="card" id="materials-card"><div class="section-heading"><h2>Grab before you go<\/h2><span class="badge">2\/3 loaded<\/span><\/div>/);
  const grab = markup.slice(0, markup.indexOf('<h3>Still being bought</h3>'));
  assert.deepEqual([...grab.matchAll(/data-grab="([^"]+)"/g)].map(match => match[1]), ['kit-hand-truck-dolly', 'kit-contractor-bags', 'quote-shelving'], 'stock items and the purchased shelving; never an item still to buy');
  assert.match(grab, /data-grab="kit-hand-truck-dolly" checked ><span class="check-label">Hand truck \/ dolly<small>Qty 1 · From stock<\/small>/);
  assert.match(grab, /data-grab="kit-contractor-bags"  ><span class="check-label">Contractor bags<small>Qty 1 · From stock · consumable<\/small><small>Two boxes<\/small>/);
  assert.match(grab, /data-grab="quote-shelving" checked disabled><span class="check-label">Metal shelving unit<small>Qty 4 unit · 2 packs of 2 · Bought by the office<\/small><small>Used on site<\/small>/, 'a used item stays ticked and is changed under On site');
  const buying = markup.slice(markup.indexOf('<h3>Still being bought</h3>'), markup.indexOf('<h3>On site</h3>'));
  assert.match(buying, /<li><strong>Storage tote<\/strong> <small>Qty 6 · Ordered<\/small><\/li><li><strong>Utility hooks<\/strong> <small>Qty 3 · Not bought yet<\/small><\/li>/);
  assert.equal(buying.includes('data-grab'), false);
  const onSite = markup.slice(markup.indexOf('<h3>On site</h3>'));
  assert.deepEqual([...onSite.matchAll(/data-material="([^"]+)"/g)].map(match => match[1]), job.materials.map(item => item.id), 'every material keeps its required/loaded/used/missing control');
  assert.doesNotMatch(markup, /\$|productUrl|https?:/);
  const locked = api.materialsCard(job, true);
  assert.equal([...locked.matchAll(/data-grab="[^"]+"[^>]*disabled/g)].length, 3, 'a locked page (busy, day locked or no edit) disables every tick');
  job.materials.forEach(item => { if (item.source) item.state = 'loaded'; });
  assert.match(api.materialsCard(job, false), /<span class="badge done">5\/5 loaded<\/span>/, 'buy items the crew loaded count as in hand');
  assert.equal(api.equipmentText(structured()), 'Confirm propane tank removed before loading', 'equipment the grab list shows is not repeated');
  assert.equal(api.equipmentText({ ...structured(), requiredEquipment: ['Hand truck / dolly'] }), 'Listed under Grab before you go');
  // The crew brought buy items the office has not marked bought: they are in hand, ticked, not still being bought.
  const broughtAnyway = structured();
  broughtAnyway.materials[4].state = 'loaded'; broughtAnyway.materials[3].state = 'used';
  const brought = api.materialsCard(broughtAnyway, false);
  assert.deepEqual([...brought.slice(0, brought.indexOf('<h3>')).matchAll(/data-grab="([^"]+)"/g)].map(match => match[1]), ['kit-hand-truck-dolly', 'kit-contractor-bags', 'quote-shelving', 'quote-totes', 'quote-hooks']);
  assert.match(brought, /data-grab="quote-hooks" checked ><span class="check-label">Utility hooks<small>Qty 3 · Bought by the office<\/small>/);
  assert.match(brought, /<span class="badge">4\/5 loaded<\/span>/, 'the contractor bags are still to load');
  assert.equal(brought.includes('Still being bought'), false, 'nothing is listed as still being bought');
  const nothingYet = { canEdit: true, requiredEquipment: [], materials: [{ id: 'quote-hooks', name: 'Utility hooks', quantity: 3, source: 'buy', purchaseState: 'to_buy', state: 'required' }] };
  assert.match(api.materialsCard(nothingYet, false), /<span class="badge">0\/0 loaded<\/span><\/div><p>Tick each item[^<]*<\/p><p class="empty">Nothing to grab yet\.<\/p><h3>Still being bought<\/h3>/);
});

test('a grab tick saves the Loaded material state through the existing material action and outbox', () => {
  assert.match(source, /else if \(target\.dataset\.grab\) \{ const loaded = target\.checked; target\.checked = !loaded; await submitAction\(\{ action: 'material', materialId: target\.dataset\.grab, state: loaded \? 'loaded' : 'required' \}\); \}/);
  assert.match(source, /\$\{materialsCard\(j, disabled\)\}/);
  assert.match(source, /\.\.\.\(document\.getElementById\('materials-card'\) \? \[\['materials-card', 'Grab list'\]\] : \[\]\)/, 'the job sections nav links the grab list only when it is shown');
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, URL, Error, TypeError, Map, Set, encodeURIComponent });
  context.self = context; vm.runInContext(readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8'), context);
  const view = JSON.parse(JSON.stringify(context.EGCFieldOutbox.projectJob({ id: 'job-1', checklist: [], allowedStatuses: [], materials: structured().materials }, [{ kind: 'field', jobId: 'job-1', state: 'queued', payload: { action: 'material', materialId: 'kit-contractor-bags', state: 'loaded' } }])));
  assert.deepEqual(view.materials[1], { id: 'kit-contractor-bags', name: 'Contractor bags', quantity: 1, source: 'stock', category: 'consumable', note: 'Two boxes', state: 'loaded', queued: true });
  assert.match(page().materialsCard({ ...view, canEdit: true }, false), /data-grab="kit-contractor-bags" checked ><span class="check-label">Contractor bags<small>[^<]*<\/small><small>Two boxes<\/small><small class="queued-tag">Saved on this phone · waiting to sync<\/small>/);
});

test('the job page, its styles and the crew shell cache move to the grab list build together', () => {
  assert.match(html, /\/crew\/job\.js\?v=20261017grablist/);
  assert.match(html, /\/crew\/job\.css\?v=20261017grablist/);
  assert.match(worker, /const VERSION = '20261017boardbridge';/);
  assert.match(worker, /'\/crew\/job\.js\?v=20261017grablist'/);
  assert.match(worker, /'\/crew\/job\.css\?v=20261017grablist'/);
  assert.match(readFileSync(new URL('../crew/job.css', import.meta.url), 'utf8'), /#materials-card \.buying\{/);
});
