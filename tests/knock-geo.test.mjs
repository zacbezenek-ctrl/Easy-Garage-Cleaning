import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bboxCenter, distanceMeters, milesLabel, nearestSuggestion, neighborhoodCenter, neighborhoodsByDistance, nextOnStreet, pointsSummary, territoryState,
} from '../crew/knock-doors.js';

// Synthetic Fort Collins points only.
const HERE = { lat: 40.5555, lng: -105.0365 };

test('distanceMeters is a great-circle distance in meters', () => {
  assert.equal(distanceMeters(HERE, HERE), 0);
  // One thousandth of a degree of latitude is about 111 m everywhere.
  assert.ok(Math.abs(distanceMeters(HERE, { lat: HERE.lat + 0.001, lng: HERE.lng }) - 111.2) < 0.5);
  // A degree of longitude shrinks with latitude (cos 40.56 deg is about 0.76).
  const east = distanceMeters(HERE, { lat: HERE.lat, lng: HERE.lng + 0.01 });
  assert.ok(east > 840 && east < 850, `${east}`);
  assert.equal(Math.round(distanceMeters({ lat: 40.5853, lng: -105.0844 }, { lat: 40.4975, lng: -105.0158 })), Math.round(distanceMeters({ lat: 40.4975, lng: -105.0158 }, { lat: 40.5853, lng: -105.0844 })), 'symmetric');
});

test('a neighborhood is placed by its center, else the middle of its bbox, else the mean of its houses', () => {
  assert.deepEqual(bboxCenter([40.5, -105.1, 40.6, -105.0]), { lat: 40.55, lng: -105.05 });
  assert.equal(bboxCenter([40.5, -105.1, 40.6]), null);
  assert.equal(bboxCenter(null), null);
  const houses = [{ n: 'a', lat: 40.5, lng: -105 }, { n: 'a', lat: 40.6, lng: -105.2 }, { n: 'b', lat: 1, lng: 1 }, { n: 'a', lat: null, lng: -105 }];
  assert.deepEqual(neighborhoodCenter({ id: 'a', center: { lat: 40.1, lng: -105.1 }, bbox: [40.5, -105.1, 40.6, -105.0] }, houses), { lat: 40.1, lng: -105.1 });
  assert.deepEqual(neighborhoodCenter({ id: 'a', center: null, bbox: [40.5, -105.1, 40.6, -105.0] }, houses), { lat: 40.55, lng: -105.05 });
  assert.deepEqual(neighborhoodCenter({ id: 'a' }, houses), { lat: 40.55, lng: -105.1 }, 'mean of its own placed houses');
  assert.deepEqual(neighborhoodCenter({ id: 'a', neighborhoodId: 'x' }, [{ neighborhoodId: 'a', lat: 40, lng: -105 }]), { lat: 40, lng: -105 }, 'server house records use neighborhoodId');
  assert.equal(neighborhoodCenter({ id: 'c' }, houses), null, 'no houses, no place');
  assert.equal(neighborhoodCenter({ id: 'a', center: { lat: 0, lng: 0 } }), null, 'a zero point is not a place');
  const summary = pointsSummary(houses.filter(h => h.n === 'a'));
  assert.deepEqual(summary, { center: { lat: 40.55, lng: -105.1 }, bbox: [40.5, -105.2, 40.6, -105], count: 2 });
  assert.equal(pointsSummary([]), null);
});

test('neighborhoodsByDistance sorts nearest first, keeps unplaced rows last and falls back to name order without GPS', () => {
  const list = [
    { id: 'far', name: 'Far Hills', center: { lat: 40.4975, lng: -105.0158 } },
    { id: 'none', name: 'Aardvark Acres' },
    { id: 'near', name: 'Near Ranch', bbox: [40.555, -105.037, 40.556, -105.036] },
    { id: 'mid', name: 'Middle Park', center: { lat: 40.5212, lng: -105.0611 } },
    { id: 'houses', name: 'House Mean', center: null },
  ];
  const houses = [{ n: 'houses', lat: 40.53, lng: -105.04 }, { n: 'houses', lat: 40.54, lng: -105.04 }];
  const sorted = neighborhoodsByDistance(HERE, list, { houses });
  assert.deepEqual(sorted.map(n => n.id), ['near', 'houses', 'mid', 'far', 'none']);
  assert.ok(sorted[0].meters < 100, `${sorted[0].meters}`);
  assert.equal(sorted.at(-1).meters, null);
  assert.deepEqual(sorted[1].center, { lat: 40.535, lng: -105.04 });
  assert.ok(sorted.every((n, i) => i === 0 || sorted[i - 1].meters == null || n.meters == null || sorted[i - 1].meters <= n.meters));
  assert.deepEqual(neighborhoodsByDistance(null, list).map(n => n.id), ['none', 'far', 'houses', 'mid', 'near'], 'no GPS: name order');
  assert.ok(neighborhoodsByDistance(null, list).every(n => n.meters === null));
  assert.deepEqual(neighborhoodsByDistance(HERE, []), []);
  assert.equal(list[0].meters, undefined, 'the input rows are not changed');
});

test('miles read as about how far, and "here" up close', () => {
  assert.equal(milesLabel(50), 'here');
  assert.equal(milesLabel(1609.344 * 0.42), '0.4 mi');
  assert.equal(milesLabel(1609.344 * 2.66), '2.7 mi');
  assert.equal(milesLabel(1609.344 * 12.4), '12 mi');
  assert.equal(milesLabel(null), '');
});

test('nearest suggestion: never-knocked houses first, then go-backs, then rested ones, by distance', () => {
  const entry = (id, status, dLat) => ({ house: { id, lat: HERE.lat + dLat, lng: HERE.lng }, status: { status } });
  const entries = [entry('far-new', 'new', 0.01), entry('near-back', 'go_back', 0.0001), entry('near-new', 'new', 0.002), entry('done', 'done', 0)];
  assert.equal(nearestSuggestion(entries, HERE).house.id, 'near-new');
  assert.equal(nearestSuggestion(entries.filter(e => e.status.status !== 'new'), HERE).house.id, 'near-back');
  assert.equal(nearestSuggestion([entry('rest', 'rested', 0.003), entry('done', 'done', 0)], HERE).house.id, 'rest');
  assert.equal(nearestSuggestion(entries, null), null, 'no GPS, no nearest');
  assert.equal(nearestSuggestion([entry('done', 'done', 0)], HERE), null);
  assert.ok(Math.abs(nearestSuggestion(entries, HERE).meters - 222.4) < 1);
});

test('next on street walks the same side, then crosses back', () => {
  const house = (number, knockable = true) => ({ house: { id: `h-${number}`, street: 'BLUE LEAF DR', number: String(number) }, status: { knockable } });
  const entries = [house(2900), house(2902), house(2904, false), house(2906), house(2901), house(2903)];
  assert.equal(nextOnStreet(entries, entries[0].house).house.number, '2902');
  assert.equal(nextOnStreet(entries, entries[1].house, '2900').house.number, '2906', 'skips a house that cannot be knocked');
  assert.equal(nextOnStreet(entries, entries[3].house, '2902').house.number, '2903', 'end of the side: cross over and walk back');
});

test('territoryState says why there is nothing to knock, most basic cause first', () => {
  const rep = { status: 'active' };
  const open = { id: 'er', name: 'English Ranch', locked: false, importedCount: 48 };
  const placed = { id: 'h1', n: 'er', lat: 40.55, lng: -105.03 };
  assert.equal(territoryState({ rep: { status: 'pending' }, neighborhoods: [open], houses: [placed] }), 'pending');
  assert.equal(territoryState({ rep: null }), 'pending');
  assert.equal(territoryState({ rep: { status: 'inactive' } }), 'inactive');
  assert.equal(territoryState({ rep, neighborhoods: [] }), 'none');
  assert.equal(territoryState({ rep, neighborhoods: [{ ...open, locked: true }], houses: [placed] }), 'locked');
  assert.equal(territoryState({ rep, neighborhoods: [{ ...open, importedCount: 0 }], houses: [] }), 'empty');
  assert.equal(territoryState({ rep, neighborhoods: [open], houses: [] }), 'not_loaded');
  assert.equal(territoryState({ rep, neighborhoods: [open], houses: [{ ...placed, n: 'elsewhere' }] }), 'not_loaded', 'houses of another area do not count');
  assert.equal(territoryState({ rep, neighborhoods: [open], houses: [{ id: 'h2', n: 'er', lat: null, lng: null }] }), 'unmapped');
  assert.equal(territoryState({ rep, neighborhoods: [open, { ...open, id: 'x', locked: true }], houses: new Map([['h1', placed]]).values() }), 'ok');
});
