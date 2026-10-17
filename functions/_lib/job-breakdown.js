import { stripCrewMoney } from './crew-money.js';
import { materialCategory } from './job-materials.js';

/** The human job breakdown a signed walkthrough saves on its job (job.jobBreakdown, EGC_JOB_MATERIALS): the sold scope
 * in the quote builder's order, removal, then shelving, then storage, then cleaning. Pure. It is written for the crew,
 * the office and the HighLevel note: no price, cost or customer contact detail, and every line passes stripCrewMoney.
 *   {version, sections:[{id, title, items:[string]}], summary}
 * summary is one "Title: item; item" line per section that has items. */
export const JOB_BREAKDOWN_VERSION = '2026-10-breakdown-v1';
export const JOB_BREAKDOWN_SECTIONS = Object.freeze([['removal', 'Removal'], ['shelving', 'Shelving'], ['storage', 'Storage'], ['cleaning', 'Cleaning']]);

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max = 300) => typeof value === 'string' ? stripCrewMoney(value.replace(/\s+/g, ' ').trim()).slice(0, max) : '';
const list = value => (Array.isArray(value) ? value : []).map(item => clean(item, 120)).filter(Boolean);
const count = (quantity, name) => quantity === 1 ? name : `${quantity} × ${name}`;
const included = line => plain(line) && (line.group ? line.selected === true : !line.optional || line.selected === true);
const FINISH = { deep_clean: 'Deep clean', pressure_wash: 'One-car garage pressure wash', mouse_trapping: 'Non-toxic mouse trapping' };
// The gameplan's own service lines already described by the scope (cleanout, access and special-handling fees).
const SCOPE_LINES = /^(?:cleanout|adjustment|access-|special-|pest-waste|deep-clean|pressure-wash|mouse-trapping)/;

export function jobBreakdown(plan) {
  const scope = plain(plan?.scope) ? plan.scope : {}, details = plain(scope.finish_details) ? scope.finish_details : {};
  const lines = plan?.quote?.itemized && Array.isArray(plan.quote.estimate_line_items) ? plan.quote.estimate_line_items.filter(included) : [];
  const sections = Object.fromEntries(JOB_BREAKDOWN_SECTIONS.map(([id]) => [id, []]));
  const add = (id, value) => { const item = clean(value); if (item && !sections[id].includes(item) && sections[id].length < 20) sections[id].push(item); };

  const loads = Number(scope.loads), size = clean(String(scope.garages ?? ''), 20), fullness = clean(scope.fullness, 40);
  if (loads > 0 || size || fullness) add('removal', [loads > 0 ? `About ${loads} truckload${loads === 1 ? '' : 's'}` : '', size ? `${size}-car garage` : '', fullness ? `${fullness} full` : ''].filter(Boolean).join(' · '));
  const special = list(scope.special_items), hazards = list(scope.hazards).filter(item => item !== 'No visible hazards'), access = list(scope.access);
  if (special.length) add('removal', `Special handling: ${special.join(', ')}`);
  for (const [key, label] of [['remove_items', 'Remove / donate'], ['keep_items', 'Keep'], ['exclusions', 'Do not move'], ['sort_method', 'Sort']]) { const value = clean(scope[key]); if (value) add('removal', `${label}: ${value}`); }
  if (hazards.length) add('removal', `Hazards: ${hazards.join(', ')}`);
  if (access.length) add('removal', `Access: ${access.join(', ')}`);

  for (const line of lines) {
    const name = clean(line.name, 160), quantity = typeof line.quantity === 'number' && line.quantity > 0 ? line.quantity : 1;
    if (!name) continue;
    const section = materialCategory(line);
    if (line.kind === 'product' && ['shelving', 'storage'].includes(section)) add(section, `${count(quantity, name)}${line.customerSupplied === true ? ' (customer supplied)' : ''}`);
    else if (line.kind === 'product') add('storage', count(quantity, name));
    else if (!SCOPE_LINES.test(String(line.id || '')) && ['cleaning', 'removal', 'shelving', 'storage'].includes(section)) add(section, count(quantity, name));
  }
  const finish = Array.isArray(scope.finish) ? scope.finish : [];
  if (!sections.shelving.length && finish.includes('shelving') && Number.isInteger(details.shelf_qty) && details.shelf_qty > 0) add('shelving', `${details.shelf_qty} ${['metal', 'wood', 'plastic'].includes(details.shelf_type) ? `${details.shelf_type} ` : ''}shelving unit${details.shelf_qty === 1 ? '' : 's'}`);
  if (!sections.storage.length && finish.includes('totes') && Number.isInteger(details.tote_qty) && details.tote_qty > 0) add('storage', `${details.tote_qty} storage tote${details.tote_qty === 1 ? '' : 's'}`);
  for (const id of Object.keys(FINISH)) if (finish.includes(id)) add('cleaning', FINISH[id]);
  if (plain(scope.hazard_details?.pest_waste) || hazards.includes('Pest waste')) add('cleaning', 'Pest-waste cleanup');

  const out = JOB_BREAKDOWN_SECTIONS.map(([id, title]) => ({ id, title, items: sections[id] }));
  return { version: JOB_BREAKDOWN_VERSION, sections: out, summary: breakdownLines({ sections: out }).join('\n').slice(0, 2000) };
}

/** "Title: item; item" per section with items (the crew brief's Job breakdown block and the HighLevel note). */
export function breakdownLines(breakdown) {
  return (Array.isArray(breakdown?.sections) ? breakdown.sections : []).filter(section => plain(section) && Array.isArray(section.items) && section.items.length)
    .map(section => clean(`${section.title}: ${section.items.join('; ')}`, 1000));
}
