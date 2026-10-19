/**
 * Vehicle size catalog for the walkthrough's "Vehicles to park after the job" (crew/gameplan.html, Finish step).
 * tools/vehicle-catalog/catalog.json (US cars, SUVs, pickups and vans since the 1960s, length / width / height in
 * inches, about ±2 in) and tools/vehicle-catalog/size-classes.json (the typical size of each vehicle type, for a vehicle
 * not in the catalog) are the sources; this writes the compact browser module crew/gameplan-vehicles-data.js that the
 * walkthrough loads the first time the section opens. Staff-only: /crew/gameplan* is gated (staff-paths.js) and the
 * module is a static asset, never part of the Pages Functions bundle. tests/gameplan-vehicles.test.mjs fails when the
 * module no longer matches the sources.
 *   node tools/build-vehicle-catalog.mjs            report; exit 1 when the module is stale
 *   node tools/build-vehicle-catalog.mjs --write    regenerate the module from the sources
 *
 * The module keeps only what the walkthrough shows: make (an index into `makes`), model, model years, generation and
 * note (indexes into their own lists), body, configuration, length, width, height, width across the mirrors (0 when the
 * source has none), confidence and the note (browserNote). Source URLs stay here. A row's id is not stored: it is the slug of make, model,
 * years and configuration (vehicleId), which every source id is today; a source id that is not goes in `ids`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CATALOG = fileURLToPath(new URL('./vehicle-catalog/catalog.json', import.meta.url));
export const CLASSES = fileURLToPath(new URL('./vehicle-catalog/size-classes.json', import.meta.url));
export const MODULE = fileURLToPath(new URL('../crew/gameplan-vehicles-data.js', import.meta.url));
export const readSources = () => ({ catalog: JSON.parse(readFileSync(CATALOG, 'utf8')), classes: JSON.parse(readFileSync(CLASSES, 'utf8')) });

export const BODIES = Object.freeze(['car', 'suv', 'pickup', 'wagon', 'minivan', 'van']);
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const COLUMNS = Object.freeze(['make', 'model', 'yearFrom', 'yearTo', 'generation', 'body', 'config', 'length', 'width', 'height', 'widthMirrors', 'confidence', 'note']);
// Sanity bounds in inches. Three microcars are shorter than any other row; their length was checked by hand.
export const BOUNDS = Object.freeze({ length: [120, 280], width: [54, 96], height: [40, 110] });
export const SHORT_CARS = Object.freeze(['scion-iq-2012-2015-3-door-hatchback', 'smart-fortwo-2008-2015-2-seat-coupe-cabrio', 'smart-fortwo-2016-2019-2-seat-coupe-cabrio']);

/** The id a row gets from its make, model, model years and configuration (the browser module's own vehicleId). */
export const vehicleId = (make, model, from, to, config) => `${make} ${model} ${from} ${to} ${config}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const inches = value => Math.round(value * 10) / 10;
// The research notes as the walkthrough shows them: a few name the research sources ("the backbone", "vehicles-v1", a
// URL) while explaining a conflict; that part goes (a parenthesis, else its clause or sentence), the advice stays.
const SOURCE_TALK = /backbone|vehicles-v1|https?:/i;
export function browserNote(note) {
  const text = note.replace(/\s*\([^()]*\)/g, part => SOURCE_TALK.test(part) ? '' : part);
  if (!SOURCE_TALK.test(text)) return text;
  const kept = text.split(/(?<=\.)\s+/).map(sentence => sentence.replace(/\.$/, '').split(/;\s*/).filter(clause => !SOURCE_TALK.test(clause)).join('; ')).filter(Boolean);
  const out = kept.map(sentence => `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`).join(' ');
  // "Measure" advice decides the walkthrough's "measure to be sure": cleaning never drops it.
  if (/measure/i.test(note) && !/measure/i.test(out)) throw new Error(`note lost its measure advice: ${note}`);
  return out;
}
function checkRow(row, at) {
  const fail = why => { throw new Error(`${at} (${row?.id}): ${why}`); };
  for (const key of ['id', 'make', 'model', 'generation', 'config', 'note']) if (typeof row[key] !== 'string') fail(`${key} must be text`);
  if (!row.id || !row.make || !row.model) fail('id, make and model are required');
  if (!Number.isInteger(row.year_from) || !Number.isInteger(row.year_to) || row.year_from < 1950 || row.year_to > 2030 || row.year_from > row.year_to) fail('model years');
  if (!BODIES.includes(row.body)) fail(`unknown body ${row.body}`);
  if (!CONFIDENCE.includes(row.confidence)) fail(`unknown confidence ${row.confidence}`);
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const value = row[`${key}_in`];
    if (typeof value !== 'number' || !Number.isFinite(value) || value > max || value < (key === 'length' && SHORT_CARS.includes(row.id) ? 100 : min)) fail(`${key} ${value} in is outside ${min}-${max} in`);
  }
  const mirrors = row.width_mirrors_in;
  if (mirrors !== null && (typeof mirrors !== 'number' || !(mirrors > row.width_in) || mirrors > 110)) fail(`width across the mirrors ${mirrors} in`);
}
function checkClass(item, at) {
  const fail = why => { throw new Error(`${at} (${item?.key}): ${why}`); };
  if (typeof item.key !== 'string' || !/^[a-z_]+$/.test(item.key) || typeof item.name !== 'string' || !item.name) fail('key and name');
  for (const key of ['length_in', 'width_in', 'height_in', 'mirror_allowance_in', 'width_mirrors_in']) if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0 || item[key] > 300) fail(key);
  if (Math.abs(item.width_in + item.mirror_allowance_in - item.width_mirrors_in) > 0.11) fail('width across the mirrors is not width + mirror allowance');
}

/** The module's data: the catalog rows as arrays of COLUMNS, the size classes, and a version that changes with the data. */
export function vehicleCatalogData({ catalog, classes }) {
  if (!Array.isArray(catalog?.rows) || !catalog.rows.length) throw new Error('catalog.json has no rows.');
  if (!Array.isArray(classes?.classes) || !classes.classes.length) throw new Error('size-classes.json has no classes.');
  const seen = new Set();
  catalog.rows.forEach((row, index) => { checkRow(row, `catalog row ${index}`); if (seen.has(row.id)) throw new Error(`catalog row ${index}: duplicate id ${row.id}`); seen.add(row.id); });
  classes.classes.forEach((item, index) => checkClass(item, `size class ${index}`));
  const byFrequency = values => [...values.reduce((counts, value) => counts.set(value, (counts.get(value) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([value]) => value);
  const makes = [...new Set(catalog.rows.map(row => row.make))].sort((a, b) => a.localeCompare(b, 'en'));
  const generations = byFrequency(catalog.rows.map(row => row.generation)), notes = byFrequency(catalog.rows.map(row => browserNote(row.note)));
  const index = list => new Map(list.map((value, i) => [value, i]));
  const makeAt = index(makes), generationAt = index(generations), noteAt = index(notes), names = new Map(catalog.rows.map(row => [row.id, `${row.make} ${row.model}`]));
  const ids = {};
  const rows = catalog.rows.map((row, i) => {
    if (vehicleId(row.make, row.model, row.year_from, row.year_to, row.config) !== row.id) ids[i] = row.id;
    return [makeAt.get(row.make), row.model, row.year_from, row.year_to, generationAt.get(row.generation), BODIES.indexOf(row.body), row.config,
      inches(row.length_in), inches(row.width_in), inches(row.height_in), row.width_mirrors_in === null ? 0 : inches(row.width_mirrors_in), CONFIDENCE.indexOf(row.confidence), noteAt.get(browserNote(row.note))];
  });
  const sizeClasses = classes.classes.map(item => ({ key: item.key, name: item.name, length: inches(item.length_in), width: inches(item.width_in), height: inches(item.height_in),
    mirrorAllowance: inches(item.mirror_allowance_in), widthMirrors: inches(item.width_mirrors_in),
    examples: [...new Set((item.representatives || []).map(rep => names.get(rep.id)).filter(Boolean))].slice(0, 3) }));
  const body = { units: catalog.units || 'in', accuracy: catalog.accuracy || 'approx ±2 in', makes, bodies: BODIES, confidence: CONFIDENCE, generations, notes, columns: COLUMNS, rows, ids, classes: sizeClasses };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 8);
  return { VERSION: `${String(catalog.generated || 'undated').slice(0, 10)}.${hash}`, ...body };
}

export function renderVehicleCatalog(sources) {
  const data = vehicleCatalogData(sources), { rows, ...rest } = data;
  const head = Object.entries(rest).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`);
  return ['// Generated from tools/vehicle-catalog/catalog.json and size-classes.json by tools/build-vehicle-catalog.mjs.',
    '// Do not edit: change the sources, then run `node tools/build-vehicle-catalog.mjs --write`.',
    '// Vehicle sizes in inches (about ±2 in) for the walkthrough\'s parking fit check (crew/gameplan-vehicles.js).',
    '// rows: one array per vehicle in `columns` order; make, generation, body, confidence and note are indexes into their',
    '// lists; widthMirrors 0 means the source has no width across the mirrors. A row\'s id is vehicleId(make, model, years,',
    '// config) unless `ids` names it.',
    'window.EGCGameplanVehicleData = {', ...head, '  rows: [', ...rows.map(row => `    ${JSON.stringify(row)},`), '  ],', '};', ''].join('\n');
}

function main() {
  const write = process.argv.includes('--write'), text = renderVehicleCatalog(readSources()), current = existsSync(MODULE) && readFileSync(MODULE, 'utf8') === text;
  if (write && !current) writeFileSync(MODULE, text);
  const size = `${Math.round(Buffer.byteLength(text) / 1024)} KB`;
  console.log(write ? (current ? `crew/gameplan-vehicles-data.js is already current (${size})` : `wrote crew/gameplan-vehicles-data.js (${size})`) : current ? `crew/gameplan-vehicles-data.js matches the sources (${size})` : '  ✗ crew/gameplan-vehicles-data.js is stale; run node tools/build-vehicle-catalog.mjs --write');
  if (!write && !current) process.exitCode = 1;
}
const entry = () => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (entry()) main();
