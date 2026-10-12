import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { CUSTOMER_PHOTO_STANDARD, customerPhotoProjection, customerPhotoSensitive, customerVisiblePhotos, storageBin, storageItems } from '../functions/_lib/customer-photo-visibility.js';
import { fieldJobProjection } from '../functions/_lib/field-execution.js';
import { createCustomerPortalHandlers } from '../functions/api/customer-portal.js';
import { storage } from './helpers/field-fixture.mjs';

const NOW = '2026-10-12T18:00:00.000Z';
const ORIGIN = 'https://easygaragecleaning.com';
const env = {
  FIELD_CUSTOMER_PHOTOS_ENABLED: 'true', CUSTOMER_PORTAL_SECRET: 'synthetic-storage-portal-secret', HUB_SESSION_SECRET: 'synthetic-storage-hub-secret', FIREBASE_API_KEY: 'firebase-test-storage-map',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', GOOGLE_REFRESH_TOKEN: 'synthetic-refresh',
};
const ID = {
  before: '30000000-0000-4000-8000-000000000001', binA1: '30000000-0000-4000-8000-000000000002', binA1b: '30000000-0000-4000-8000-000000000003',
  binB2: '30000000-0000-4000-8000-000000000004', noBin: '30000000-0000-4000-8000-000000000005', hidden: '30000000-0000-4000-8000-000000000006',
};
const photo = (id, category, extra = {}) => ({ id, fileId: `file_${id.replaceAll('-', '')}`, category, caption: 'Internal crew caption', actorId: 'Crew.One', actorName: 'Synthetic Crew', createdAt: '2026-10-10T15:00:00.000Z', verified: true, mime: 'image/jpeg', bytes: 14, ...extra });
const photos = () => [
  photo(ID.before, 'before'),
  photo(ID.binB2, 'storage', { bin: 'B2', items: 'Camping gear, tent, lantern' }),
  photo(ID.binA1, 'storage', { bin: 'A1', items: 'Holiday lights, wreath' }),
  photo(ID.binA1b, 'storage', { bin: 'A1', items: 'Holiday lights, wreath' }),
  photo(ID.noBin, 'storage', { bin: '', items: 'No label' }),
  photo(ID.hidden, 'storage', { bin: 'C3', items: 'Hidden bin', customerHidden: { at: '2026-10-10T16:00:00.000Z', actorId: 'ZacB' } }),
];
const job = (extra = {}) => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-s', address: '1 Synthetic Way', serviceType: 'Garage Organization', total: 1800, status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-25T22:00:00.000Z', assignedCrew: ['Crew.One'], fieldExecution: { photos: photos() }, ...extra });

test('bin labels and item lists are cleaned to what a crew writes on a bin', () => {
  assert.equal(storageBin(' a1 '), 'a1');
  assert.equal(storageBin('Shelf 2 – B3'), 'Shelf 2 – B3');
  assert.equal(storageBin('  A   1 '), 'A 1', 'runs of spaces collapse');
  for (const bad of ['', '   ', '-A1', '<script>', 'A'.repeat(25), null, undefined, 42 && {}]) assert.equal(storageBin(bad), '', `${String(bad)} is rejected`);
  assert.equal(storageItems('  lights\u0007, cords  '), 'lights, cords');
  assert.equal(storageItems('x'.repeat(900)).length, 500);
});

test('storage is a customer-facing category that follows the before/after rule', () => {
  assert.ok(CUSTOMER_PHOTO_STANDARD.includes('storage'));
  assert.equal(customerPhotoSensitive({ category: 'storage' }), false);
  const working = job({ status: 'in_progress', pipelineStatus: 'in_progress', completedAt: '' });
  assert.deepEqual(customerVisiblePhotos(working), [], 'nothing shows before the job is complete');
  const visible = customerVisiblePhotos(job()).map(item => item.id);
  assert.ok(visible.includes(ID.binA1) && visible.includes(ID.binB2));
  assert.equal(visible.includes(ID.hidden), false, 'a manager hide still wins');
});

test('the portal projection carries bin and items, never the internal caption, and drops unlabeled storage photos', () => {
  const rows = customerPhotoProjection(job());
  const storageRows = rows.filter(row => row.category === 'storage');
  assert.deepEqual(storageRows.map(row => row.photoId).sort(), [ID.binA1, ID.binA1b, ID.binB2].sort());
  assert.deepEqual(storageRows.find(row => row.photoId === ID.binA1), { photoId: ID.binA1, category: 'storage', addedAt: '2026-10-10T15:00:00.000Z', label: 'Bin A1', bin: 'A1', items: 'Holiday lights, wreath' });
  assert.equal(JSON.stringify(rows).includes('Internal crew caption'), false, 'captions stay internal');
  const before = rows.find(row => row.photoId === ID.before);
  assert.equal(Object.hasOwn(before, 'bin'), false, 'other categories keep their existing shape');
});

test('crews see the bin label and items on their own job view', () => {
  const view = fieldJobProjection(job(), [], {});
  const row = view.photos.find(item => item.id === ID.binB2);
  assert.equal(row.bin, 'B2');
  assert.equal(row.items, 'Camping gear, tent, lantern');
  assert.equal(Object.hasOwn(view.photos.find(item => item.id === ID.before), 'bin'), false);
});

test('the customer portal DTO includes the storage rows behind the photo flag', async t => {
  const store = storage({ mock: { method: (object, name, implementation) => t.mock.method(object, name, implementation) } });
  store.put('jobs/job-s', job());
  const cookie = `egc_customer_portal=${await createCustomerPortalSessionToken(env, 'job-s', Date.parse(NOW), { linkVersion: 0 })}`;
  const portal = createCustomerPortalHandlers({ now: () => new Date(NOW) });
  const response = await portal.onRequestGet({ env, request: new Request(`${ORIGIN}/api/customer-portal`, { headers: { Origin: ORIGIN, Cookie: cookie } }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  const bins = body.beforeAfter.filter(row => row.category === 'storage').map(row => row.bin).sort();
  assert.deepEqual(bins, ['A1', 'A1', 'B2']);
  const off = await portal.onRequestGet({ env: { ...env, FIELD_CUSTOMER_PHOTOS_ENABLED: 'false' }, request: new Request(`${ORIGIN}/api/customer-portal`, { headers: { Origin: ORIGIN, Cookie: cookie } }) });
  assert.equal(Object.hasOwn(await off.json(), 'beforeAfter'), false);
});

test('the portal page renders storage separately from the before/after gallery', () => {
  const page = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
  assert.match(page, /id="storage-card"/);
  assert.match(page, /item\.category!=='storage'/, 'storage photos are excluded from the before/after gallery');
  assert.match(page, /renderGallery\(data\);renderStorage\(data\);/);
});

test('the crew upload accepts storage photos only with a bin label', () => {
  const source = readFileSync(new URL('../functions/api/field-jobs.js', import.meta.url), 'utf8');
  assert.match(source, /'walkthrough', 'storage'\]\.includes\(input\.category\)/);
  assert.match(source, /Storage photos need the bin label/);
  const crew = readFileSync(new URL('../crew/job.js', import.meta.url), 'utf8');
  assert.match(crew, /'damage', 'storage'\]/);
  assert.match(crew, /id="photo-bin"/);
});
