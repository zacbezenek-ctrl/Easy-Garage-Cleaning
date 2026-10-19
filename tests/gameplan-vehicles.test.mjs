import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from './helpers/vm-realm.mjs';
import { servedPricing } from './helpers/walkthrough-pricing.mjs';
import { BOUNDS, BODIES, SHORT_CARS, readSources, renderVehicleCatalog, vehicleCatalogData, vehicleId } from '../tools/build-vehicle-catalog.mjs';
import { handoffInstructions, normalizeHandoffPlan, saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { walkthroughCrewBrief } from '../functions/_lib/walkthrough-crew-brief.js';
import { normalizeUnsignedCapture } from '../functions/_lib/unsigned-walkthrough-capture.js';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';
import { staffGatedPath } from '../staff-paths.js';

// Vehicles to park after the job (crew/gameplan-vehicles.js and its generated catalog crew/gameplan-vehicles-data.js):
// the catalog, the length parser, the search, the fit check, the walkthrough's payload and briefs, and the server.
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const NOW = '2026-09-22T18:00:00.000Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Owner' };

// The browser modules in a realm of their own, as the page loads them (window is the realm).
function browser({ data = true } = {}) {
  const context = vm.createContext({});
  context.window = context;
  if (data) vm.runInContext(read('crew/gameplan-vehicles-data.js'), context);
  vm.runInContext(read('crew/gameplan-vehicles.js'), context);
  return context;
}
const page = browser(), V = page.EGCGameplanVehicles, D = page.EGCGameplanVehicleData;
const pick = (query, config = '') => {
  const found = V.search(D, query, { limit: 200 }), rows = found.groups.flatMap(group => group.rows), row = rows.find(item => item.config.includes(config));
  assert.ok(row, `${query} ${config}`);
  return V.fromRow(D, row.index, row.year ?? found.year);
};

test('the browser catalog is generated from the committed sources and is current, small and staff-only', () => {
  const sources = readSources(), text = read('crew/gameplan-vehicles-data.js');
  assert.equal(text, renderVehicleCatalog(sources), 'run node tools/build-vehicle-catalog.mjs --write');
  assert.ok(Buffer.byteLength(text) < 250 * 1024, `${Math.round(Buffer.byteLength(text) / 1024)} KB`);
  assert.equal(D.rows.length, sources.catalog.rows.length);
  assert.doesNotMatch(text, /https?:|backbone|vehicles-v1/i, 'source URLs and research names stay in tools/');
  // The loader asks for this exact version, so a regenerated catalog is a new URL.
  assert.equal(V.DATA_URL, `/crew/gameplan-vehicles-data.js?v=${D.VERSION}`);
  assert.match(D.VERSION, /^2026-10-19\.[0-9a-f]{8}$/);
  // Static, gated with the walkthrough (/crew/gameplan*), never part of the Pages Functions bundle.
  for (const path of ['/crew/gameplan-vehicles-data.js', '/crew/gameplan-vehicles.js', '/crew/gameplan-vehicles.css']) assert.equal(staffGatedPath(path), true, path);
  for (const name of fs.readdirSync(new URL('../functions', import.meta.url), { recursive: true }).filter(name => /\.m?js$/.test(name))) assert.doesNotMatch(read(`functions/${name}`), /(?:from|import)\s*\(?\s*['"][^'"]*(?:gameplan-vehicles|vehicle-catalog)/, `functions/${name}`);
  // The page loads the module, its stylesheet and the cache keys of everything changed with it.
  const html = read('crew/gameplan.html');
  for (const asset of ['/crew/gameplan-vehicles.js?v=20261019vehicles', '/crew/gameplan-vehicles.css?v=20261019vehicles', '/crew/quote-draft.js?v=20261019vehicles']) assert.ok(html.includes(asset), asset);
  assert.equal(html.includes('gameplan-vehicles-data.js'), false, 'the catalog loads only when Finish opens');
});

test('every catalog row is within the sanity bounds, ids are unique and every size class exists', () => {
  const { catalog } = readSources(), ids = new Set();
  catalog.rows.forEach((row, i) => {
    assert.equal(V.rowId(D, i), row.id, 'the browser derives the same id');
    assert.equal(D.ids[i] ?? vehicleId(row.make, row.model, row.year_from, row.year_to, row.config), row.id, 'the generator\'s id');
    assert.ok(!ids.has(row.id), `duplicate ${row.id}`); ids.add(row.id);
    const [, , from, to, , body, , length, width, height, mirrors] = D.rows[i];
    assert.ok(from >= 1950 && to <= 2030 && from <= to, row.id);
    assert.ok(BODIES[body], row.id);
    assert.ok(length <= BOUNDS.length[1] && (length >= BOUNDS.length[0] || SHORT_CARS.includes(row.id) && length >= 100), `${row.id} length ${length}`);
    assert.ok(width >= BOUNDS.width[0] && width <= BOUNDS.width[1], `${row.id} width ${width}`);
    assert.ok(height >= BOUNDS.height[0] && height <= BOUNDS.height[1], `${row.id} height ${height}`);
    assert.ok(mirrors === 0 || mirrors > width && mirrors <= 110, `${row.id} mirrors ${mirrors}`);
    // Every row has a size class, so its mirror allowance comes from the catalog.
    assert.ok(D.classes.some(cls => cls.key === V.classOf(BODIES[body], length, width)), row.id);
  });
  assert.equal(ids.size, 2371);
  assert.deepEqual(plain(D.classes.map(cls => cls.key)), ['compact_car', 'midsize_car', 'fullsize_car', 'small_suv', 'midsize_suv', 'fullsize_suv', 'extended_fullsize_suv', 'minivan', 'compact_pickup', 'midsize_pickup_crew',
    'fullsize_pickup_crew_short', 'fullsize_pickup_crew_long_hd', 'fullsize_van', 'motorcycle']);
  for (const cls of D.classes) assert.ok(Math.abs(cls.width + cls.mirrorAllowance - cls.widthMirrors) < 0.2 && cls.length > 0 && cls.height > 0, cls.key);
  assert.deepEqual([...D.classes.find(cls => cls.key === 'midsize_car').examples], ['Toyota Camry', 'Honda Accord', 'Nissan Altima']);
  // The generator refuses a row outside the bounds or a duplicate id.
  const bad = structuredClone(readSources());
  bad.catalog.rows[0].width_in = 120;
  assert.throws(() => vehicleCatalogData(bad), /width 120 in is outside/);
  const twice = structuredClone(readSources());
  twice.catalog.rows.push(twice.catalog.rows[0]);
  assert.throws(() => vehicleCatalogData(twice), /duplicate id/);
});

test('lengths are read in feet and inches or inches, and say what was understood', () => {
  const inches = text => V.parseLength(text)?.inches;
  for (const [text, expected] of [['20\' 4"', 244], ['20\'4"', 244], ['20 ft 4', 244], ['20 ft 4 in', 244], ['20ft4in', 244], ['20 feet 4 inches', 244], ['20’ 4”', 244], ['20\'-4"', 244],
    ['244', 244], ['244 in', 244], ['244"', 244], ['20.3 ft', 243.6], ['20.3\'', 243.6], ['16\'', 192], ['7 ft', 84], ['6\' 8 1/2"', 80.5], ['96 1/2"', 96.5], ['20 4', 244], ['20', 240], ['8', 96]]) assert.equal(inches(text), expected, text);
  assert.equal(V.parseLength(''), null);
  assert.equal(V.parseLength('  '), null);
  assert.deepEqual(plain(V.parseLength('20\' 4"')), { inches: 244, assumedFeet: false, text: '= 244 in (20 ft 4 in)' });
  assert.deepEqual(plain(V.parseLength('20')), { inches: 240, assumedFeet: true, text: 'Read as 20 ft = 240 in' });
  for (const text of ['twenty', '20 m', '-5', '5\' 4\' 3', 'abc 20']) assert.match(V.parseLength(text).error, /^Not understood/, text);
  assert.match(V.parseLength('2440', V.LIMITS.depth).error, /looks wrong here/);
  assert.match(V.parseLength('40', V.LIMITS.doorHeight).error, /looks wrong here/);
  // A bare number is feet only where that size makes sense: a 30 in wide motorcycle is not 30 ft.
  assert.deepEqual(plain(V.parseLength('30', V.LIMITS.vehicleWidth)), { inches: 30, assumedFeet: false, text: '= 30 in (2 ft 6 in)' });
  assert.equal(V.parseLength('7', V.LIMITS.doorHeight).inches, 84);
  // Measurements are what the estimator typed; only the readable ones reach the garage and the payload.
  assert.deepEqual(plain(V.measuredGarage({ width: '20\' 4"', depth: 'abc', ceiling: '9 ft' })), { width_in: 244, ceiling_in: 108 });
  assert.equal(V.measuredGarage({}), null);
  assert.equal(V.measuredGarage(undefined), null);
});

test('typical garage sizes stand in for anything not measured, marked typical', () => {
  assert.deepEqual(plain(V.garageFrom('1')), { size: '1', width: { in: 144, typical: true }, depth: { in: 264, typical: true }, doors: [{ in: 108, typical: true }], doorHeight: { in: 84, typical: true }, ceiling: { in: 96, typical: true } });
  assert.deepEqual(plain(V.garageFrom('2').doors), [{ in: 192, typical: true }]);
  assert.deepEqual(plain(V.garageFrom('3')).doors.map(d => d.in), [192, 108]);
  assert.deepEqual([V.garageFrom('other').width.in, V.garageFrom('other').depth.in], [432, 288]);
  assert.equal(V.garageFrom('nonsense').size, '2');
  const measured = V.garageFrom('2', { depth: '20 ft', doorWidth: '9\'' });
  assert.deepEqual(plain([measured.depth, measured.doors, measured.width]), [{ in: 240, typical: false }, [{ in: 108, typical: false }], { in: 240, typical: true }]);
});

test('search: make, model and year in any order, tolerant of case, hyphens and short names', () => {
  const titles = query => plain(V.search(D, query).groups.map(group => group.title));
  const first = query => { const found = V.search(D, query), group = found.groups[0]; return `${group.title} ${group.rows[0].years} ${group.rows[0].config}`; };
  assert.equal(first('2018 f150 crew'), 'Ford F-150 2015–2020 SuperCrew, 5.5 ft bed');
  const found = V.search(D, '2018 f150 crew');
  assert.equal(found.year, 2018);
  assert.ok(found.groups.flatMap(group => group.rows).every(row => /SuperCrew/.test(row.config) && row.dims.endsWith(' in (approx ±2 in)')));
  // F-150 = F150 = f 150 = F-150 in any case; the plain model before its variants (Raptor, Lightning).
  for (const query of ['F-150', 'f150', 'f 150', 'FORD F150']) assert.deepEqual(titles(query).slice(0, 2), ['Ford F-150', 'Ford F-150'], query);
  assert.equal(V.search(D, 'F-150').total, V.search(D, 'f150').total);
  // Newest first, grouped by generation.
  const camry = V.search(D, 'camry');
  assert.equal(camry.groups[0].title, 'Toyota Camry');
  assert.match(camry.groups[0].generation, /9th gen/);
  assert.ok(camry.groups.every((group, i, all) => !i || group.to <= all[i - 1].to || group.title !== all[i - 1].title));
  // A two-digit year.
  assert.equal(first('67 mustang'), 'Ford Mustang 1967–1968 Coupe / fastback / convertible');
  assert.equal(V.search(D, '67 mustang').groups[0].rows[0].year, 1967);
  assert.ok(V.search(D, '15 f150').groups.flatMap(group => group.rows).every(row => row.years === '2015–2020'));
  assert.equal(titles('toyota 86')[0], 'Toyota 86 / GR86');
  // Short names find their make.
  assert.ok(titles('chevy silverado 1500').every(title => title.startsWith('Chevrolet Silverado')));
  assert.ok(titles('vw jetta').length && titles('vw jetta').every(title => title.startsWith('Volkswagen')));
  assert.ok(titles('benz s-class').some(title => title.startsWith('Mercedes-Benz S')));
  assert.ok(titles('dodge ram 2015').includes('Ram 1500'));
  assert.deepEqual([...new Set(titles('rav 4'))], ['Toyota RAV4']);
  assert.deepEqual([...new Set(titles('cx-5'))], ['Mazda CX-5', 'Mazda CX-50'], 'the CX-5 first');
  assert.deepEqual(plain(V.search(D, 'zzzz')), { year: null, groups: [], total: 0, more: 0 });
  assert.deepEqual(plain(V.search(D, '   ')), { year: null, groups: [], total: 0, more: 0 });
  assert.ok(V.search(D, 'ford', { limit: 30 }).more > 0);
  // Low confidence and "measure" notes say "measure to be sure".
  const wagon = V.search(D, 'camry wagon 1994').groups[0].rows[0];
  assert.equal(wagon.measure, true);
});

test('a picked vehicle carries its size, mirrors, source and confidence', () => {
  const f150 = pick('2019 f150 supercrew', 'SuperCrew, 5.5 ft bed');
  assert.deepEqual(plain(f150), { label: '2019 Ford F-150 SuperCrew, 5.5 ft bed', short: 'F-150', source: 'catalog', id: 'ford-f-150-2015-2020-supercrew-5-5-ft-bed', length_in: 231.9, width_in: 79.9, height_in: 75.6,
    width_mirrors_in: 89.4, mirrors: 'estimated', confidence: 'high', measure: false, note: '4x4 about 77 in tall.' });
  assert.equal(pick('f150', 'SuperCrew, 5.5 ft bed').label, 'Ford F-150 SuperCrew, 5.5 ft bed (2021–2026)', 'no year typed: the model years');
  const transit = pick('ford transit 2020', 'low roof');
  assert.deepEqual([transit.width_mirrors_in, transit.mirrors], [97.4, 'listed']);
  const dually = pick('ram 3500 drw 2015');
  assert.deepEqual([dually.width_in, dually.width_mirrors_in, dually.confidence, dually.measure], [96, 105.5, 'low', true]);
  const suv = V.fromClass(D.classes.find(cls => cls.key === 'midsize_suv'));
  assert.deepEqual(plain(suv), { label: 'Midsize SUV, typical size', short: 'midsize suv', source: 'typical', id: 'midsize_suv', length_in: 196.9, width_in: 77.9, height_in: 70.2, width_mirrors_in: 86.9, mirrors: 'estimated', confidence: 'typical', measure: false, note: '' });
  const boat = V.fromMeasure({ name: 'Boat', length: '19\' 6"', width: '8 ft', height: '72', basis: 'mirrors' });
  assert.deepEqual([boat.source, boat.length_in, boat.width_in, boat.width_mirrors_in, boat.mirrors, boat.confidence], ['measured', 234, 96, 96, 'measured', 'measured']);
  assert.equal(V.fromMeasure({ length: '15 ft', width: '6 ft', height: '5 ft', basis: 'truck' }).width_mirrors_in, 84);
  assert.equal(V.fromMeasure({ length: '15 ft', width: '6 ft', height: '5 ft' }).width_mirrors_in, 81);
  assert.equal(V.fromMeasure({ length: '15 ft', width: '', height: '5 ft' }), null);
  // A saved draft that was edited by hand is cleaned or dropped.
  assert.equal(V.cleanVehicle({ source: 'catalog', length_in: 'x', width_in: 70, height_in: 55 }), null);
  assert.equal(V.cleanVehicle({ source: 'nope', length_in: 180, width_in: 70, height_in: 55 }), null);
  assert.equal(V.cleanVehicle({ source: 'measured', length_in: 180, width_in: 70, height_in: 55, label: '' }).width_mirrors_in, 79);
});

const vehicle = (length, width, height, mirrors = width + 9, short = 'vehicle') => ({ source: 'measured', label: short, short, length_in: length, width_in: width, height_in: height, width_mirrors_in: mirrors });
const statusOf = (fit, key) => fit.checks.find(check => check.key === key)?.status;

test('fit check: depth needs the longest vehicle and a walkway', () => {
  const truck = pick('2019 f150 supercrew', 'SuperCrew, 5.5 ft bed');
  // A 232 in crew cab in a 240 in deep garage: 268 in comfortable, 256 in tight, so it won't fit.
  const short = V.fitCheck(V.garageFrom('2', { depth: '240' }), [truck]);
  assert.equal(statusOf(short, 'depth'), 'wont_fit');
  assert.equal(short.overall, 'wont_fit');
  assert.equal(short.checks[0].text, 'Depth: 232 in F-150 + 36 in walkway needs 268 in; garage is 240 in (measured) — won’t fit (even a 24 in walkway needs 256 in).');
  // The typical 2-car (264 in) is tight, and says it is typical.
  const typical = V.fitCheck(V.garageFrom('2'), [truck]);
  assert.equal(typical.checks[0].text, 'Depth: 232 in F-150 + 36 in walkway needs 268 in; garage is 264 in (typical) — tight (32 in to walk in front), measure it.');
  assert.deepEqual([typical.overall, typical.typical, typical.checks[0].typical], ['tight', true, true]);
  assert.equal(statusOf(V.fitCheck(V.garageFrom('2', { depth: '22 ft 4' }), [truck]), 'depth'), 'fits');
  // Shelving on the back wall takes 24 in of depth, and the sentence says so.
  const shelved = V.fitCheck(V.garageFrom('2', { depth: '24 ft' }), [truck], { shelving: 'back' });
  assert.equal(shelved.checks[0].text, 'Depth: 232 in F-150 + 36 in walkway needs 268 in; garage is 288 in (measured) less 24 in of shelving on the back wall = 264 in — tight (32 in to walk in front).');
});

test('fit check: width needs every vehicle across its mirrors, 30 in between and at each side', () => {
  const two = [vehicle(190, 72, 58, 81), vehicle(185, 70, 56, 79)];
  // 160 in of mirrors + 3 × 30 in = 250 in comfortable; 3 × 18 in = 214 in tight.
  assert.equal(statusOf(V.fitCheck(V.garageFrom('2', { width: '250' }), two), 'width'), 'fits');
  assert.equal(statusOf(V.fitCheck(V.garageFrom('2', { width: '240' }), two), 'width'), 'tight');
  assert.equal(statusOf(V.fitCheck(V.garageFrom('2', { width: '213' }), two), 'width'), 'wont_fit');
  assert.equal(V.fitCheck(V.garageFrom('2', { width: '240' }), two).checks[1].text, 'Width: 81 + 79 in across the mirrors + 30 in between and at each side needs 250 in; garage is 240 in (measured) — tight (18 in gaps need 214 in).');
  // Shelving on a side wall (the default when the quote has shelving) takes 24 in of width.
  const sided = V.fitCheck(V.garageFrom('2', { width: '250' }), two, { shelving: 'side' });
  assert.deepEqual([statusOf(sided, 'width'), sided.shelving], ['tight', 'side']);
  assert.match(sided.checks[1].text, /less 24 in of shelving on a side wall = 226 in/);
  // Without a listed mirror width, the size class's allowance, else 9 in (car) or 12 in (truck or van).
  assert.equal(V.cleanVehicle({ source: 'measured', length_in: 200, width_in: 80, height_in: 75, truck: true }).width_mirrors_in, 92);
});

test('fit check: the door must clear each vehicle across its mirrors and its roof', () => {
  // A dually (96 in body, 105.5 in across the mirrors) in a 9 ft (108 in) door: needs 117.5 in, so it won't fit with
  // the mirrors out, and the sentence says to fold them.
  const dually = pick('ram 3500 drw 2015');
  const fit = V.fitCheck(V.garageFrom('1'), [dually]), door = fit.checks.find(check => check.key === 'door_width');
  assert.equal(door.status, 'wont_fit');
  assert.equal(door.text, 'Door width: 3500 DRW is 106 in across the mirrors; the door is 108 in (typical) — won’t fit with the mirrors out (96 in body: fold the mirrors), measure it.');
  // The 16 ft door of a 2-car takes it.
  assert.equal(statusOf(V.fitCheck(V.garageFrom('2'), [dually]), 'door_width'), 'fits');
  // 12 in to spare fits, 4 in is tight, less won't fit.
  for (const [door, expected] of [['108', 'fits'], ['100', 'tight'], ['99', 'wont_fit']]) assert.equal(statusOf(V.fitCheck(V.garageFrom('1', { doorWidth: door }), [vehicle(190, 86, 60, 96)]), 'door_width'), expected, door);
  // A 3-car's widest door counts.
  assert.match(V.fitCheck(V.garageFrom('3'), [dually]).checks.find(check => check.key === 'door_width').text, /the widest door is 192 in \(typical\)/);
  // Height: 2 in under the door fits, under the door is tight, taller won't fit.
  for (const [height, expected] of [[82, 'fits'], [83, 'tight'], [84, 'tight'], [85, 'wont_fit']]) assert.equal(statusOf(V.fitCheck(V.garageFrom('2'), [vehicle(220, 80, height)]), 'door_height'), expected, String(height));
  const van = pick('ram promaster 2020', 'high roof');
  assert.equal(V.fitCheck(V.garageFrom('2'), [van]).checks.find(check => check.key === 'door_height').text, 'Door height: ProMaster is 101 in tall; the door opening is 84 in (typical) — won’t fit (17 in too tall), measure it.');
});

test('fit check: overhead racks hang no lower than the tallest vehicle plus 4 in', () => {
  const truck = vehicle(232, 80, 76, 89, 'F-150');
  // Only when racks are planned (the quote has overhead storage or the estimator ticks "Overhead racks planned").
  assert.equal(statusOf(V.fitCheck(V.garageFrom('2'), [truck]), 'racks'), undefined);
  const typical = V.fitCheck(V.garageFrom('2'), [truck], { racks: true }), racks = typical.checks.find(check => check.key === 'racks');
  assert.equal(typical.rackBottom, 80);
  assert.equal(racks.status, 'tight');
  assert.equal(racks.text, 'Overhead racks: F-150 is 76 in tall, so racks hang no lower than 80 in; the ceiling is 96 in (typical), which leaves 16 in — tight (most racks need 22 in, the shortest 15 in), measure it.');
  assert.equal(statusOf(V.fitCheck(V.garageFrom('2', { ceiling: '10 ft' }), [truck], { racks: true }), 'racks'), 'fits');
  assert.equal(statusOf(V.fitCheck(V.garageFrom('2', { ceiling: '90' }), [truck], { racks: true }), 'racks'), 'wont_fit');
  // The overall result is the worst check, and the tallest vehicle sets the rack height.
  const mixed = V.fitCheck(V.garageFrom('2', { ceiling: '9 ft' }), [vehicle(180, 72, 57), truck], { racks: true });
  assert.deepEqual([mixed.rackBottom, statusOf(mixed, 'racks'), mixed.overall], [80, 'fits', 'tight']);
  assert.equal(V.fitCheck(V.garageFrom('2'), []), null);
});

test('parking: nothing without vehicles; the PARKING text names the vehicles, what is tight and the rack limit', () => {
  assert.equal(V.parking({}), null);
  assert.equal(V.parking({ vehicles: [], size: '2', measure: {} }), null);
  assert.equal(V.parking({ vehicles: [{ source: 'catalog' }], size: '2' }), null, 'an unusable vehicle is no vehicle');
  assert.deepEqual(plain(V.parking({ vehicles: [], size: '2', measure: { depth: '20 ft' } })), { scope: { garage_measurements: { depth_in: 240 } } });
  const f150 = pick('2019 f150 supercrew', 'SuperCrew, 5.5 ft bed'), crv = pick('2020 cr-v');
  const info = V.parking({ vehicles: [f150, crv], size: '2', measure: { width: '20 ft', depth: '22 ft' }, racks: false, quote: { overhead: true } });
  assert.equal(info.text, '2019 Ford F-150 SuperCrew, 5.5 ft bed (232×80×76 in) + 2020 Honda CR-V (181×73×67 in). Garage 240×264 in, door 192×84 in, ceiling 96 in (measured: width, depth; the rest typical). '
    + 'Depth tight (needs 268 in, has 264 in); Width tight (needs 261 in, has 240 in); Overhead racks tight (16 in under the ceiling). Keep overhead racks ≥ 80 in off the floor. Typical garage sizes there: measure before promising the fit.');
  assert.equal(info.summary, '2 vehicles · Tight — width needs 261 in, has 240 in');
  assert.deepEqual(Object.keys(info.scope), ['customer_vehicles', 'garage_measurements', 'parking_plan']);
  assert.deepEqual(plain(info.scope.customer_vehicles[0]), { label: '2019 Ford F-150 SuperCrew, 5.5 ft bed', source: 'catalog', length_in: 231.9, width_in: 79.9, height_in: 75.6, width_mirrors_in: 89.4, confidence: 'high' });
  assert.deepEqual(plain(info.scope.garage_measurements), { width_in: 240, depth_in: 264 });
  // Everything fits: the tightest dimension still shows, and the rack limit is there without racks.
  const roomy = V.parking({ vehicles: [crv], size: '2', measure: { depth: '24 ft' } });
  assert.equal(roomy.text, '2020 Honda CR-V (181×73×67 in). Garage 240×288 in, door 192×84 in (measured: depth; the rest typical). Everything fits; tightest is door height (18 in to spare). Hang nothing lower than 71 in over the parked vehicles.');
  assert.equal(roomy.summary, '1 vehicle · Fits; tightest: door height, 18 in to spare');
  // Shelving in the quote is counted on a side wall unless the estimator picks the back wall; the rest of the list is capped.
  assert.match(V.parking({ vehicles: [crv], size: '2', quote: { shelving: true } }).text, /Shelving counted 24 in deep on the side wall\./);
  assert.match(V.parking({ vehicles: [crv], size: '2', quote: { shelving: true }, shelfWall: 'back' }).text, /on the back wall\./);
  assert.doesNotMatch(V.parking({ vehicles: [crv], size: '2', shelfWall: 'back' }).text, /Shelving/, 'no shelving in the quote');
  const long = Array.from({ length: 6 }, (_, i) => ({ ...vehicle(200, 75, 60), label: `${'Very long custom name '.repeat(6)}${i}` }));
  const capped = V.parking({ vehicles: long, size: 'other' });
  assert.equal(capped.vehicles.length, 4, 'four vehicles at most');
  assert.ok(capped.text.length <= 1000, String(capped.text.length));
  const huge = capped.vehicles.map(v => ({ ...v, label: 'L'.repeat(400) })), cut = V.planText(V.garageFrom('other'), huge, V.fitCheck(V.garageFrom('other'), huge), {});
  assert.ok(cut.length === 1000 && cut.endsWith('…'), String(cut.length));
  assert.match(V.parking({ vehicles: [pick('ram 3500 drw 2015')], size: '1' }).text, /Measure to be sure: 3500 DRW\./);
});

// crew/gameplan.html's own functions, as tests/crew-scope-prices.test.mjs runs them, with or without the vehicles module.
const html = read('crew/gameplan.html');
const line = prefix => { const found = html.split(/\r?\n/).find(row => row.startsWith(prefix)); assert.ok(found, prefix); return found; };
class PageDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return Date.parse(NOW); }
}
function gameplan(overrides = {}, { vehicles = true } = {}) {
  const context = vm.createContext({ Date: PageDate, PRICING: servedPricing(), save() {}, render() {}, invalidateAcceptance() {}, validateStep: () => [], PHOTO_COUNT: 3, uid: () => 'synthetic-job', normPhone: value => value });
  context.window = context;
  if (vehicles) { vm.runInContext(read('crew/gameplan-vehicles-data.js'), context); vm.runInContext(read('crew/gameplan-vehicles.js'), context); }
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  Object.assign(context.S, { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1', whyNow: 'Moving soon', outcome: 'Park two cars',
    garageSize: '2', fill: 'medium', loads: '1', hazards: ['Pest waste'], finish: ['cleanout', 'shelving'], shelfQty: 2, keepNotes: 'Blue bicycle', jobDate: '2026-09-24', startTime: '08:00', endTime: '13:00',
    crewSize: '1', assignedTo: 'Crew One', notes: 'Dog in the yard', signature: 'data:image/png;base64,iVBORw0KGgo=', approved: true, acceptanceAt: '2026-09-22T17:45:00.000Z', acceptanceBy: 'Synthetic Customer' }, overrides);
  for (const prefix of ['function recommend(', 'function estimatedJobMinutes(', 'function durationText(', 'function parkingInfo(', 'function parkingQuote(', 'function buildJobInstructions(', 'function signedLines(', 'function buildInternalNotes(', 'function buildCrewBrief(', 'function buildClientChecklists(', 'function payload(']) vm.runInContext(line(prefix), context);
  return context;
}
const snapshot = h => { const sent = plain(h.payload()); delete sent.sent_at; delete sent.idempotency_key; return sent; };

test('a walkthrough without vehicles sends exactly what it sent before', () => {
  const without = gameplan({}, { vehicles: false }), withModule = gameplan();
  assert.deepEqual(snapshot(withModule), snapshot(without));
  assert.equal('parkingPlan' in withModule.buildJobInstructions({}), false);
  assert.doesNotMatch(withModule.payload().crew_brief, /PARKING/);
  assert.equal(withModule.parkingInfo(), null);
  // An emptied list (the page deletes the key) and the rack choice left behind change nothing either.
  assert.deepEqual(snapshot(gameplan({ customerVehicles: [] })).scope, snapshot(without).scope);
});

test('with vehicles the payload, the instructions, both briefs and the post-job check carry the parking plan', () => {
  const f150 = plain(pick('2019 f150 supercrew', 'SuperCrew, 5.5 ft bed')), suv = plain(V.fromClass(D.classes.find(cls => cls.key === 'midsize_suv')));
  const h = gameplan({ customerVehicles: [f150, suv], garageMeasure: { depth: '20 ft' }, parkingShelfWall: 'back' }), sent = h.payload(), plan = sent.scope.parking_plan;
  assert.deepEqual(plain(sent.scope.customer_vehicles).map(v => [v.label, v.source]), [['2019 Ford F-150 SuperCrew, 5.5 ft bed', 'catalog'], ['Midsize SUV, typical size', 'typical']]);
  assert.deepEqual(plain(sent.scope.garage_measurements), { depth_in: 240 });
  assert.match(plan, /Depth won’t fit \(needs 268 in, has 216 in\)/, 'shelving on the back wall');
  assert.match(plan, /Shelving counted 24 in deep on the back wall\./);
  assert.equal(h.buildJobInstructions({}).parkingPlan, plan);
  for (const brief of [sent.internal_notes, sent.crew_brief]) {
    const lines = brief.split('\n'), at = lines.findIndex(row => row.startsWith('PARKING: '));
    assert.equal(lines[at - 1].split(':')[0], 'MATERIALS');
    assert.equal(lines[at], `PARKING: ${plan}`);
    assert.ok(lines.some(row => row.startsWith('INTERNAL CUSTOMER NOTES: Dog in the yard')), 'the customer notes still fit');
    assert.ok(brief.length <= 4900);
  }
  assert.doesNotMatch(sent.crew_brief, /\$\s?\d/);
  const check = sent.client_checklists.postJob.find(row => row.id === 'parking');
  assert.deepEqual(plain(check), { id: 'parking', label: 'Check the customer can park as planned', detail: plan, critical: false });
  // The briefs keep their 4,900-character cap with the PARKING line in it.
  const long = gameplan({ customerVehicles: [f150, suv], notes: 'N'.repeat(4000) }).payload();
  assert.equal(long.internal_notes.length, 4900);
  assert.ok(long.internal_notes.includes('\nPARKING: '));
  // Overhead storage in a builder quote counts as racks planned.
  const builder = gameplan({ customerVehicles: [f150], builderQuote: { compositePricing: { steps: ['removal', 'shelving', 'storage'] }, totalCents: 150000, lineItems: [{ id: 'storage-goods', kind: 'product', name: 'Extra storage', description: 'FLEXIMOUNTS Lift Series 48 in. W x 48 in. D Ceiling Mounted Overhead Garage Storage Rack × 2' }] } });
  assert.deepEqual(plain(builder.parkingQuote()), { overhead: true, shelving: true });
  assert.match(builder.payload().scope.parking_plan, /Keep overhead racks ≥ 80 in off the floor\./);
});

test('the server keeps the parking plan for the crew: handoff instructions, the crew brief and the unsigned capture', async () => {
  const f150 = plain(pick('2019 f150 supercrew', 'SuperCrew, 5.5 ft bed'));
  const sent = { ...plain(gameplan({ customerVehicles: [f150], garageMeasure: { depth: '22 ft 6' } }).payload()), terms_accepted: true }, plan = sent.scope.parking_plan;
  // The signed handoff accepts the nested scope fields and stores them.
  const normalized = normalizeHandoffPlan(sent, NOW);
  assert.deepEqual(normalized.scope.customer_vehicles, sent.scope.customer_vehicles);
  assert.deepEqual(normalized.scope.garage_measurements, { depth_in: 270 });
  assert.equal(handoffInstructions(normalized).parkingPlan, plan);
  assert.equal('parkingPlan' in handoffInstructions(normalizeHandoffPlan({ ...plain(gameplan().payload()), terms_accepted: true }, NOW)), false);
  assert.equal(handoffInstructions({ ...normalized, scope: { ...normalized.scope, parking_plan: `  ${'P'.repeat(1200)}` } }).parkingPlan.length, 1000);
  assert.equal('parkingPlan' in handoffInstructions({ ...normalized, scope: { ...normalized.scope, parking_plan: '   ' } }), false);
  // The crew job page's labelled blocks (walkthroughBrief) show it.
  assert.deepEqual(walkthroughCrewBrief({ parkingPlan: plan }), [{ label: 'Parking after the job', text: plan }]);
  // The real signed save, then the crew's view of the job.
  const store = hubStore(), saved = await saveWalkthroughHandoff(store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan: sent }, NOW);
  const job = store.rows.get(`jobs/${saved.job.id}`);
  assert.equal(job.jobInstructions.parkingPlan, plan);
  assert.deepEqual(job.scope.customer_vehicles[0].label, '2019 Ford F-150 SuperCrew, 5.5 ft bed');
  assert.ok(job.operationalScope.text.includes(`\nPARKING: ${plan}\n`));
  assert.deepEqual(crewJobProjection(job).walkthroughBrief.find(row => row.label === 'Parking after the job'), { label: 'Parking after the job', text: plan });
  // "Send options for review": the unsigned capture accepts it (1,000 characters at most) and still refuses unknown fields.
  assert.deepEqual(normalizeUnsignedCapture({ parkingPlan: `  ${plan}  ` }), { parkingPlan: plan });
  assert.deepEqual(normalizeUnsignedCapture({ parkingPlan: 'P'.repeat(1000) }), { parkingPlan: 'P'.repeat(1000) });
  for (const bad of [{ parkingPlan: 'P'.repeat(1001) }, { parkingPlan: 42 }, { parkingPlan: ['x'] }, { customerVehicles: [] }]) assert.throws(() => normalizeUnsignedCapture(bad), error => error.code === 'quote_draft_invalid_capture', JSON.stringify(bad).slice(0, 60));
  // The page's quote-draft client sends it only when the walkthrough has one.
  const drafts = vm.createContext({ window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, Date });
  vm.runInContext(read('crew/quote-draft.js'), drafts);
  const { draftFromWalkthrough } = drafts.window.EGCQuoteDraft;
  assert.equal(draftFromWalkthrough(sent, '2026-10-06').walkthrough_capture.parkingPlan, plan);
  assert.equal('parkingPlan' in draftFromWalkthrough(plain(gameplan().payload()), '2026-10-06').walkthrough_capture, false);
});

// In-memory dispatch store (the tests/crew-scope-prices.test.mjs fixture shape).
function hubStore() {
  const rows = new Map([
    ['customers/c1', { id: 'c1', revision: 'c1r', name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'provider1' }],
    ['jobs/w1', { id: 'w1', revision: 'w1r', type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', highlevelContactId: 'provider1', date: '2026-09-22', time: '11:00', endTime: '12:00', projectId: 'p1' }],
    ['projects/p1', { id: 'p1', revision: 'p1r', customerId: 'c1', sourceRecordId: 'w1', sourceWalkthroughId: 'w1' }],
  ]);
  let n = 0;
  return { rows,
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    jobs: async () => [...rows].filter(([key]) => key.startsWith('jobs/')).map(([, value]) => structuredClone(value)),
    resources: async () => [], roster: async () => [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew.one', name: 'Crew One', role: 'crew' }],
    async commit(writes) {
      for (const write of writes) {
        const old = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` });
    } };
}

test('the page keeps the vehicles in its saved draft and labels every source', () => {
  // The draft is the walkthrough's own localStorage copy of S; the module reads it back and drops what it cannot use.
  const saved = JSON.parse(JSON.stringify({ S: { customerVehicles: [plain(pick('camry 2019')), { source: 'measured', label: 'Trailer', length_in: 200, width_in: 80, height_in: 70, width_mirrors_in: 80 }, { junk: true }] } }));
  const info = V.parking({ vehicles: saved.S.customerVehicles, size: '2' });
  assert.deepEqual(info.vehicles.map(v => [v.source, V.SOURCES[v.source]]), [['catalog', 'Catalog'], ['measured', 'Measured']]);
  const withoutData = browser({ data: false }).EGCGameplanVehicles;
  assert.equal(withoutData.parking({ vehicles: saved.S.customerVehicles, size: '2' }).text, info.text, 'the fit check needs no catalog');
});
