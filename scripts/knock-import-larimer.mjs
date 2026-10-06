#!/usr/bin/env node
// Imports every house address for canvassing neighborhoods from Larimer County's public GIS:
// https://maps1.larimer.org/arcgis/rest/services/MapServices/Parcels/MapServer
//   layer 1 (Subdivisions: SUBNUM, SUBNAME) selects a neighborhood's subdivision polygons;
//   layer 0 (Site Address: FULLADDRESS, ADDRESSNUM, ...) gives the address points inside them.
// Only street, house number, unit, latitude and longitude are stored. Owner names and mailing
// addresses (layer 3, Tax Parcels) are never read: this script refuses any other layer.
//
// Usage:
//   node scripts/knock-import-larimer.mjs --neighborhood kechter-farm            # fetch and print counts only
//   node scripts/knock-import-larimer.mjs --all --out knock-houses.json          # write a JSON seed file
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 node scripts/knock-import-larimer.mjs --neighborhood kechter-farm --emulator demo-egc-knock
//   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node scripts/knock-import-larimer.mjs --all --production --yes-write-production
// Options: --neighborhood <id> (repeatable), --all, --delay-ms 400, --out <file>, --emulator <demo-project>,
//          --production (needs FIREBASE_SERVICE_ACCOUNT_JSON and --yes-write-production).
import { writeFileSync } from 'node:fs';
import { NEIGHBORHOOD_SEED, neighborhoodId, seedNeighborhoodDocs } from '../functions/_lib/knock-seed.js';
import { createKnockStore, write } from '../functions/_lib/knock-store.js';
import { firestoreFetch } from '../functions/_lib/firebase-service-account.js';
import { addressKey, houseIdFor, parseAddress } from '../crew/knock-doors.js';

export const SERVICE = 'https://maps1.larimer.org/arcgis/rest/services/MapServices/Parcels/MapServer';
const ALLOWED_LAYERS = new Set([0, 1]);
const REQUIRED = { 0: ['OBJECTID', 'FULLADDRESS', 'ADDRESSNUM'], 1: ['OBJECTID', 'SUBNUM', 'SUBNAME'] };
const PAGE = 1000;
const MUNICIPALITY = { 'fort-collins': 'FORT COLLINS', windsor: 'WINDSOR', timnath: 'TIMNATH' };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createGisClient({ fetcher = globalThis.fetch, delayMs = 400, retries = 3, log = () => {} } = {}) {
  let last = 0;
  async function call(layer, path, params) {
    if (!ALLOWED_LAYERS.has(layer)) throw new Error(`Refusing layer ${layer}: only layers 0 (site addresses) and 1 (subdivisions) may be read.`);
    for (let attempt = 1; ; attempt += 1) {
      const wait = last + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        const response = await fetcher(`${SERVICE}/${layer}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'EGC canvassing import (easygaragecleaning.com)' },
          body: new URLSearchParams({ f: 'json', ...params }),
        });
        if (!response.ok) throw Object.assign(new Error(`GIS HTTP ${response.status}`), { retry: response.status >= 500 || response.status === 429 });
        const data = await response.json();
        if (data.error) throw Object.assign(new Error(`GIS error ${data.error.code}: ${data.error.message}`), { retry: data.error.code >= 500 });
        return data;
      } catch (error) {
        if (attempt >= retries || error.retry === false) throw error;
        log(`  retrying after ${error.message}`);
        await sleep(delayMs * 2 ** attempt);
      }
    }
  }
  return {
    // Check the field names first (?f=json), so a renamed field fails loudly instead of importing blanks.
    async verifyLayers() {
      const found = {};
      for (const layer of [0, 1]) {
        const meta = await call(layer, '', {});
        const names = new Set((meta.fields || []).map(f => f.name));
        const missing = REQUIRED[layer].filter(name => !names.has(name));
        if (missing.length) throw new Error(`Layer ${layer} (${meta.name}) is missing ${missing.join(', ')}. Fields are: ${[...names].join(', ')}`);
        found[layer] = { name: meta.name, maxRecordCount: meta.maxRecordCount, wkid: meta.extent?.spatialReference?.latestWkid || meta.extent?.spatialReference?.wkid, fields: [...names], pagination: meta.advancedQueryCapabilities?.supportsPagination };
      }
      return found;
    },
    // Every subdivision polygon matching the neighborhood's county key, paged past the record limit.
    async polygons(where) {
      const features = [];
      let spatialReference = null;
      for (let offset = 0; ; offset += PAGE) {
        const page = await call(1, '/query', { where, outFields: 'OBJECTID,SUBNUM,SUBNAME,MUNICIPALITY', returnGeometry: 'true', orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE) });
        spatialReference ||= page.spatialReference;
        features.push(...(page.features || []));
        if (!page.exceededTransferLimit || !(page.features || []).length) break;
      }
      return { features, spatialReference };
    },
    // Address points inside one polygon (lon/lat), paged past the record limit.
    async addressPoints(polygon, spatialReference) {
      const points = [];
      const geometry = JSON.stringify({ rings: polygon.geometry.rings, spatialReference });
      for (let offset = 0; ; offset += PAGE) {
        const page = await call(0, '/query', {
          geometry, geometryType: 'esriGeometryPolygon', spatialRel: 'esriSpatialRelIntersects', inSR: String(spatialReference.latestWkid || spatialReference.wkid),
          where: '1=1', outFields: 'OBJECTID,FULLADDRESS,ADDRESSNUM,IS_INCORPORATED_NAME', returnGeometry: 'true', outSR: '4326',
          orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE),
        });
        points.push(...(page.features || []));
        if (!page.exceededTransferLimit || !(page.features || []).length) break;
      }
      return points;
    },
  };
}

/* Turn GIS points into house documents for one neighborhood. Points shared by several polygons are
   kept once; several points at one street address are units of a multi-unit building. */
export function buildHouses(nbhd, points, nowIso) {
  const byObject = new Map();
  for (const point of points) byObject.set(point.attributes.OBJECTID, point);
  const expectedTown = MUNICIPALITY[nbhd.cityKey] || '';
  const houses = new Map();
  const skipped = [];
  const towns = {};
  const sameAddress = new Map();
  for (const point of byObject.values()) {
    const { FULLADDRESS: full, ADDRESSNUM: number, IS_INCORPORATED_NAME: town } = point.attributes;
    const parsed = parseAddress(full);
    if (!parsed || !Number.isFinite(point.geometry?.x) || !Number.isFinite(point.geometry?.y)) { skipped.push(full || '(blank)'); continue; }
    if (number && /^\d+$/.test(String(number).trim()) && String(number).trim() !== parsed.number) parsed.number = String(number).trim();
    const id = houseIdFor(parsed);
    const townKey = town || 'UNINCORPORATED';
    towns[townKey] = (towns[townKey] || 0) + 1;
    const base = `${parsed.number} ${parsed.street}`;
    sameAddress.set(base, (sameAddress.get(base) || 0) + 1);
    if (houses.has(id)) continue;
    houses.set(id, {
      id, neighborhoodId: nbhd.id, street: parsed.street, number: parsed.number, unit: parsed.unit || '',
      hasUnit: Boolean(parsed.unit), lat: Math.round(point.geometry.y * 1e6) / 1e6, lng: Math.round(point.geometry.x * 1e6) / 1e6,
      // An address outside the neighborhood's town follows other rules until an admin reviews it.
      jurisdictionHold: Boolean(expectedTown && town !== expectedTown),
      importedAt: nowIso, updatedAt: nowIso,
    });
  }
  for (const house of houses.values()) {
    if (sameAddress.get(`${house.number} ${house.street}`) > 1) house.hasUnit = true;
  }
  const list = [...houses.values()].sort((a, b) => a.street.localeCompare(b.street) || Number(a.number) - Number(b.number) || a.unit.localeCompare(b.unit));
  return {
    houses: list, skipped, towns,
    units: list.filter(h => h.hasUnit).length,
    held: list.filter(h => h.jurisdictionHold).length,
  };
}

export async function importNeighborhood(gis, nbhd, { log = () => {}, nowIso = new Date().toISOString() } = {}) {
  const { features, spatialReference } = await gis.polygons(nbhd.countyWhere);
  if (!features.length) throw new Error(`${nbhd.name}: no subdivision polygons match ${nbhd.countyWhere}`);
  log(`  ${features.length} subdivision polygon${features.length === 1 ? '' : 's'}: ${[...new Set(features.map(f => f.attributes.SUBNAME))].slice(0, 6).join('; ')}${features.length > 6 ? '; ...' : ''}`);
  const points = [];
  for (const polygon of features) points.push(...await gis.addressPoints(polygon, spatialReference));
  const result = buildHouses(nbhd, points, nowIso);
  const lats = result.houses.map(h => h.lat), lngs = result.houses.map(h => h.lng);
  const center = result.houses.length ? { lat: Math.round(lats.reduce((a, b) => a + b, 0) / lats.length * 1e6) / 1e6, lng: Math.round(lngs.reduce((a, b) => a + b, 0) / lngs.length * 1e6) / 1e6 } : null;
  const bbox = result.houses.length ? [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)] : null;
  return { ...result, polygons: features.length, points: points.length, center, bbox };
}

/* Store houses without wiping outcomes: static address fields are upserted by field mask, so a
   re-import never touches summary, noKnock or excluded. */
export async function storeNeighborhood(store, nbhd, imported, nowIso) {
  const writes = imported.houses.map(({ id, ...house }) => write.upsert('knock_houses', id, house));
  writes.push(write.upsert('knock_neighborhoods', nbhd.id, {
    ...Object.fromEntries(Object.entries(nbhd).filter(([key]) => !['id', '__updateTime', 'importedCount', 'unitCount', 'importedAt', 'updatedAt'].includes(key))),
    importedCount: imported.houses.length, unitCount: imported.units, jurisdictionHoldCount: imported.held,
    importedAt: nowIso, center: imported.center, bbox: imported.bbox, updatedAt: nowIso,
  }));
  for (let i = 0; i < writes.length; i += 400) await store.commit(writes.slice(i, i + 400));
}

function emulatorStore(project) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host || '')) throw new Error('--emulator needs FIRESTORE_EMULATOR_HOST set to a loopback emulator.');
  if (!/^demo-[a-z0-9-]+$/.test(project || '')) throw new Error('--emulator needs a demo-* project id.');
  return createKnockStore({}, (_env, url, init = {}) => fetch(String(url).replace('https://firestore.googleapis.com', `http://${host}`).replaceAll('projects/egcw-1ec83/', `projects/${project}/`), {
    ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer owner' },
    ...(typeof init.body === 'string' ? { body: init.body.replaceAll('projects/egcw-1ec83/', `projects/${project}/`) } : {}),
  }));
}

function parseArgs(argv) {
  const args = { neighborhoods: [], all: false, delayMs: 400, out: '', emulator: '', production: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--neighborhood') args.neighborhoods.push(argv[++i]);
    else if (arg === '--all') args.all = true;
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--emulator') args.emulator = argv[++i];
    else if (arg === '--production') args.production = true;
    else if (arg === '--yes-write-production') args.yes = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();
  const seeds = seedNeighborhoodDocs(nowIso);
  const chosen = args.all ? seeds : seeds.filter(n => args.neighborhoods.includes(n.id) || args.neighborhoods.includes(n.name));
  if (!chosen.length) throw new Error(`Pick --all or --neighborhood <id>. Ids: ${NEIGHBORHOOD_SEED.map(n => neighborhoodId(n.name)).join(', ')}`);
  if (args.production && !args.yes) throw new Error('Writing production Firestore needs --yes-write-production as well. Nothing was written.');
  let store = null;
  if (args.emulator) store = emulatorStore(args.emulator);
  if (args.production) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error('--production needs FIREBASE_SERVICE_ACCOUNT_JSON.');
    store = createKnockStore({ FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON }, firestoreFetch);
  }
  const gis = createGisClient({ delayMs: args.delayMs, log: console.log });
  const layers = await gis.verifyLayers();
  console.log(`Larimer GIS fields checked: layer 0 "${layers[0].name}" [${layers[0].fields.join(', ')}]; layer 1 "${layers[1].name}" [${layers[1].fields.join(', ')}]; record limit ${layers[0].maxRecordCount}, paging ${layers[0].pagination ? 'on' : 'off'}.`);
  const seedOut = {};
  const rows = [];
  for (const nbhd of chosen) {
    console.log(`${nbhd.name} (${nbhd.countyWhere})`);
    const imported = await importNeighborhood(gis, nbhd, { log: console.log, nowIso });
    let readBack = null;
    if (store) {
      await storeNeighborhood(store, nbhd, imported, nowIso);
      readBack = (await store.query('knock_houses', { where: [['neighborhoodId', '==', nbhd.id]], select: ['neighborhoodId'] })).length;
    }
    for (const house of imported.houses) { const { id, ...doc } = house; seedOut[`knock_houses/${id}`] = doc; }
    seedOut[`knock_neighborhoods/${nbhd.id}`] = { ...nbhd, importedCount: imported.houses.length, unitCount: imported.units, jurisdictionHoldCount: imported.held, center: imported.center, bbox: imported.bbox, importedAt: nowIso };
    const diff = imported.houses.length - nbhd.plattedCount;
    const towns = Object.entries(imported.towns).map(([town, n]) => `${town} ${n}`).join(', ');
    console.log(`  ${nbhd.name}: ${imported.houses.length} houses imported vs ${nbhd.plattedCount} platted lots expected (${diff >= 0 ? '+' : ''}${diff}); ${imported.units} with unit numbers; ${imported.held} outside ${MUNICIPALITY[nbhd.cityKey] || nbhd.cityKey}; towns: ${towns}${imported.skipped.length ? `; ${imported.skipped.length} unreadable skipped` : ''}${store ? `; ${readBack} stored (read back)` : ''}`);
    rows.push({ name: nbhd.name, imported: imported.houses.length, expected: nbhd.plattedCount, units: imported.units, held: imported.held });
  }
  console.log('\nNeighborhood                 Imported  Expected  Diff  Units  Other town');
  for (const row of rows) console.log(`${row.name.padEnd(28)} ${String(row.imported).padStart(8)} ${String(row.expected).padStart(9)} ${String(row.imported - row.expected).padStart(5)} ${String(row.units).padStart(6)} ${String(row.held).padStart(11)}`);
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(seedOut, null, 1));
    console.log(`\nWrote ${Object.keys(seedOut).length} documents to ${args.out}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
