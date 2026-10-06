import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE, buildHouses, createGisClient, importNeighborhood, storeNeighborhood } from '../scripts/knock-import-larimer.mjs';
import { seedNeighborhoodDocs } from '../functions/_lib/knock-seed.js';
import { knockWorld } from './helpers/knock-fixture.mjs';

const NOW = '2026-10-06T16:00:00.000Z';
const kechter = seedNeighborhoodDocs(NOW).find(n => n.id === 'kechter-farm');
const point = (id, address, x, y, town = 'FORT COLLINS', number) => ({ attributes: { OBJECTID: id, FULLADDRESS: address, ADDRESSNUM: number ?? address.split(' ')[0], IS_INCORPORATED_NAME: town }, geometry: { x, y } });

const FIELDS = {
  0: ['OBJECTID', 'FULLADDRESS', 'ADDRESSNUM', 'CITY', 'ZIPCODE', 'RUNDATE', 'SHAPE', 'IS_INCORPORATED', 'IS_INCORPORATED_NAME'],
  1: ['OBJECTID', 'SUBNUM', 'SUBNAME', 'SUBMJRNAME', 'RECEPTNUM', 'MUNICIPALITY', 'RUNDATE', 'SHAPE'],
};

// A scripted GIS: layer metadata, two pages of polygons, two pages of points for the first polygon.
function fakeGis({ fields = FIELDS } = {}) {
  const requests = [];
  const fetcher = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body));
    requests.push({ url, params });
    const layer = Number(url.slice(SERVICE.length + 1).split('/')[0]);
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (!url.endsWith('/query')) return json({ name: layer ? 'Subdivisions' : 'Site Address', maxRecordCount: 1000, fields: fields[layer].map(name => ({ name })), advancedQueryCapabilities: { supportsPagination: true }, extent: { spatialReference: { wkid: 2876, latestWkid: 2876 } } });
    const offset = Number(params.resultOffset || 0);
    if (layer === 1) {
      return json(offset === 0
        ? { spatialReference: { wkid: 2876, latestWkid: 2876 }, exceededTransferLimit: true, features: [{ attributes: { OBJECTID: 1, SUBNAME: 'KECHTER FARM PLD 1ST' }, geometry: { rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] }
        : { spatialReference: { wkid: 2876, latestWkid: 2876 }, features: [{ attributes: { OBJECTID: 2, SUBNAME: 'KECHTER FARM 3RD' }, geometry: { rings: [[[2, 2], [3, 2], [3, 3], [2, 2]]] } }] });
    }
    const first = params.geometry.includes('[0,0]');
    if (first && offset === 0) return json({ exceededTransferLimit: true, features: [point(10, '6115 SPEARMINT CT', -105.0222, 40.5026), point(11, '6121 SPEARMINT CT', -105.0224, 40.5026)] });
    if (first) return json({ features: [point(12, '6127 SPEARMINT CT', -105.0226, 40.5026)] });
    return json({ features: [point(12, '6127 SPEARMINT CT', -105.0226, 40.5026), point(13, '3737 LANDINGS DR BLDG H', -105.03, 40.51)] });
  };
  return { fetcher, requests };
}

test('the import checks field names, pages past the record limit and only ever reads layers 0 and 1', async () => {
  const { fetcher, requests } = fakeGis();
  const gis = createGisClient({ fetcher, delayMs: 0 });
  const layers = await gis.verifyLayers();
  assert.equal(layers[0].name, 'Site Address');
  const imported = await importNeighborhood(gis, kechter, { nowIso: NOW });
  assert.deepEqual(imported.houses.map(h => `${h.number} ${h.street}${h.unit ? ` #${h.unit}` : ''}`), ['3737 LANDINGS DR #H', '6115 SPEARMINT CT', '6121 SPEARMINT CT', '6127 SPEARMINT CT']);
  assert.equal(imported.polygons, 2);
  assert.equal(imported.units, 1);
  assert.deepEqual(requests.filter(r => r.url.endsWith('/1/query')).map(r => r.params.resultOffset), ['0', '1000'], 'polygon pages');
  assert.deepEqual(requests.filter(r => r.url.endsWith('/0/query')).map(r => r.params.resultOffset), ['0', '1000', '0'], 'address pages per polygon');
  for (const { url, params } of requests) {
    assert.match(url, /\/MapServer\/[01](?:\/query)?$/, 'only layers 0 and 1');
    if (params.outFields) assert.doesNotMatch(params.outFields, /OWNER|MAIL|NAME1|ADDR_1/i, 'no owner or mailing fields are requested');
  }
  assert.ok(requests.some(r => r.params.where === kechter.countyWhere), 'the neighborhood county key selects the polygons');
});

test('a renamed field fails loudly instead of importing blanks', async () => {
  const { fetcher } = fakeGis({ fields: { ...FIELDS, 0: FIELDS[0].filter(name => name !== 'FULLADDRESS') } });
  await assert.rejects(createGisClient({ fetcher, delayMs: 0 }).verifyLayers(), /Layer 0 \(Site Address\) is missing FULLADDRESS/);
});

test('houses store street, number, unit and position only; units and other towns are flagged', () => {
  const { houses, units, held, towns, skipped } = buildHouses(kechter, [
    point(1, '6115 SPEARMINT CT', -105.022204, 40.502636),
    point(1, '6115 SPEARMINT CT', -105.022204, 40.502636),
    point(2, '200 MAIN ST', -105.1, 40.6), point(3, '200 MAIN ST', -105.1, 40.6),
    point(4, '9 COUNTY RD', -105.2, 40.7, null),
    point(5, '', -105.2, 40.7),
  ], NOW);
  assert.deepEqual(houses.map(h => Object.keys(h).sort()), Array(3).fill(['hasUnit', 'id', 'importedAt', 'jurisdictionHold', 'lat', 'lng', 'neighborhoodId', 'number', 'street', 'unit', 'updatedAt']));
  assert.equal(houses.find(h => h.street === 'MAIN ST').hasUnit, true, 'two points at one address are units of one building');
  assert.equal(houses.find(h => h.street === 'COUNTY RD').jurisdictionHold, true, 'an unincorporated address waits for admin review');
  assert.deepEqual([units, held, skipped.length], [1, 1, 1]);
  assert.deepEqual(towns, { 'FORT COLLINS': 3, UNINCORPORATED: 1 });
  assert.deepEqual(houses.find(h => h.street === 'SPEARMINT CT'), { id: 'h-6115-spearmint-ct', neighborhoodId: 'kechter-farm', street: 'SPEARMINT CT', number: '6115', unit: '', hasUnit: false, lat: 40.502636, lng: -105.022204, jurisdictionHold: false, importedAt: NOW, updatedAt: NOW });
});

test('a re-import updates addresses without wiping outcomes, exclusions or no-knock flags', async () => {
  const { fake, storage } = knockWorld({
    'knock_houses/h-6115-spearmint-ct': { neighborhoodId: 'kechter-farm', street: 'SPEARMINT CT', number: '6115', lat: 1, lng: 1, excluded: true, noKnock: { source: 'city' }, summary: { lastOutcome: 'look' } },
  });
  const store = storage({ FIREBASE_API_KEY: 'firebase-test-knock' });
  const { houses, units, held } = buildHouses(kechter, [point(1, '6115 SPEARMINT CT', -105.022204, 40.502636), point(2, '6121 SPEARMINT CT', -105.0224, 40.5026)], NOW);
  await storeNeighborhood(store, kechter, { houses, units, held, center: { lat: 40.5, lng: -105 }, bbox: [1, 2, 3, 4] }, NOW);
  const kept = fake.get('knock_houses/h-6115-spearmint-ct');
  assert.deepEqual([kept.lat, kept.excluded, kept.noKnock.source, kept.summary.lastOutcome], [40.502636, true, 'city', 'look']);
  assert.equal(fake.get('knock_houses/h-6121-spearmint-ct').number, '6121');
  const nbhd = fake.get('knock_neighborhoods/kechter-farm');
  assert.deepEqual([nbhd.importedCount, nbhd.plattedCount, nbhd.tier, nbhd.status], [2, 416, 'Premium', 'open']);
});
