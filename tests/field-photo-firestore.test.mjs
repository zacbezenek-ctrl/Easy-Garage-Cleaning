import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { createFieldPhotoClient, fieldPhotosConfigured, verifyFieldPhotoMetadata } from '../functions/_lib/field-execution-photos.js';
import { FIRESTORE_PHOTO_CHUNK_BYTES, FIRESTORE_PHOTO_PREFIX, createFirestorePhotoClient, firestorePhotoFileId, firestorePhotosEnabled } from '../functions/_lib/field-photo-firestore.js';
import { createCustomerPortalHandlers } from '../functions/api/customer-portal.js';
import { createCustomerPortalPhotoHandlers } from '../functions/api/customer-portal-photo.js';
import * as fieldRoute from '../functions/api/field-jobs.js';
import { firestoreMemory } from './helpers/firestore-memory.mjs';
import { storage } from './helpers/field-fixture.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
const NOW = '2026-10-28T18:00:00.000Z';
const DRIVE = { GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', GOOGLE_REFRESH_TOKEN: 'synthetic-refresh' };
const STORED = { EGC_FIELD_PHOTOS_FIRESTORE: 'true', FIREBASE_API_KEY: 'firebase-test-photo-store' };
const JOB = 'job-1', REQUEST = '40000000-0000-4000-8000-000000000001';

// A JPEG of `size` bytes with a deterministic body, so a reassembled image can be compared byte for byte.
function jpeg(size) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) % 251;
  bytes.set([255, 216, 255, 224]);
  return { bytes, mime: 'image/jpeg', extension: 'jpg' };
}
const memoryClient = (memory, options = {}) => createFirestorePhotoClient(STORED, { fetcher: (_env, url, init) => memory.fetch(url, init), now: () => new Date(NOW), ...options });

test('a photo larger than one chunk is saved in one commit and read back byte for byte', async () => {
  const memory = firestoreMemory(), client = memoryClient(memory), picture = jpeg(FIRESTORE_PHOTO_CHUNK_BYTES * 2 + 1234);
  const fileId = await client.allocate();
  assert.ok(firestorePhotoFileId(fileId) && fileId.startsWith(FIRESTORE_PHOTO_PREFIX));
  assert.match(fileId, /^[A-Za-z0-9_-]{1,200}$/, 'the id passes the file id check every stored field photo must meet');
  assert.equal(await client.metadata(fileId), null, 'nothing exists before the upload');
  await client.upload(fileId, JOB, REQUEST, picture, 'storage');
  assert.equal(memory.commits.length, 1, 'chunks and metadata are written together');
  assert.equal(memory.commits[0].length, 4, 'three chunks, then the metadata');
  assert.equal(memory.commits[0].at(-1).update.name.endsWith(`/fieldPhotoFiles/${fileId}`), true, 'the metadata is the last write');
  for (const index of [0, 1, 2]) assert.ok(memory.get(`fieldPhotoFiles/${fileId}/chunks/${index}`).data.length <= 800000, `chunk ${index} stays under the Firestore value limit`);
  const metadata = await client.metadata(fileId);
  assert.deepEqual(metadata.appProperties, { egcJobId: JOB, egcFieldRequestId: REQUEST });
  assert.doesNotThrow(() => verifyFieldPhotoMetadata(metadata, { jobId: JOB, requestId: REQUEST, picture }), 'the callers\' verification accepts it unchanged');
  assert.throws(() => verifyFieldPhotoMetadata(metadata, { jobId: 'job-2', requestId: REQUEST, picture }), 'another job never matches');
  const image = await client.image(fileId);
  assert.equal(image.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(image.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(image.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), picture.bytes);
  assert.equal(await client.thumbnail('https://lh3.googleusercontent.com/x=s220'), null, 'no thumbnails: callers serve the full image');
});

test('a retried upload rewrites the same photo instead of keeping a second copy', async () => {
  const memory = firestoreMemory(), client = memoryClient(memory), picture = jpeg(5000), fileId = await client.allocate();
  await client.upload(fileId, JOB, REQUEST, picture, 'before');
  await client.upload(fileId, JOB, REQUEST, picture, 'before');
  assert.equal([...memory.documents.keys()].filter(key => key.startsWith('fieldPhotoFiles/')).length, 2, 'one metadata document and one chunk');
  assert.deepEqual(new Uint8Array(await (await client.image(fileId)).arrayBuffer()), picture.bytes);
});

test('reads fail closed on a missing chunk, a wrong size or an id from another store', async () => {
  const memory = firestoreMemory(), client = memoryClient(memory), fileId = await client.allocate();
  await client.upload(fileId, JOB, REQUEST, jpeg(FIRESTORE_PHOTO_CHUNK_BYTES + 10), 'after');
  memory.documents.delete(`fieldPhotoFiles/${fileId}/chunks/1`);
  await assert.rejects(client.image(fileId), error => error.code === 'FIELD_PHOTO_READ_FAILED');
  const resized = await client.allocate();
  await client.upload(resized, JOB, REQUEST, jpeg(100), 'after');
  memory.put(`fieldPhotoFiles/${resized}`, { ...memory.get(`fieldPhotoFiles/${resized}`), size: 99 });
  await assert.rejects(client.image(resized), error => error.code === 'FIELD_PHOTO_READ_FAILED');
  const before = memory.commits.length;
  assert.equal(await client.metadata('file-1'), null, 'a Drive id is never looked up here');
  await assert.rejects(client.image('canaryFile_0001'), error => error.code === 'FIELD_PHOTO_READ_FAILED');
  await assert.rejects(client.upload('file-1', JOB, REQUEST, jpeg(100), 'after'), error => error.code === 'FIELD_PHOTO_UPLOAD_FAILED');
  assert.equal(memory.commits.length, before);
});

test('storage outages surface as the field upload and verify errors the crew app already retries', async () => {
  const down = createFirestorePhotoClient(STORED, { fetcher: async () => new Response('{}', { status: 503 }) });
  const fileId = await down.allocate();
  await assert.rejects(down.upload(fileId, JOB, REQUEST, jpeg(100), 'after'), error => error.code === 'FIELD_PHOTO_UPLOAD_FAILED' && error.status === 503);
  await assert.rejects(down.metadata(fileId), error => error.code === 'FIELD_PHOTO_VERIFY_FAILED' && error.status === 503);
  const offline = createFirestorePhotoClient(STORED, { fetcher: async () => { throw new Error('network down'); } });
  await assert.rejects(offline.metadata(fileId), error => error.code === 'FIELD_PHOTO_VERIFY_FAILED');
});

test('photo storage counts as connected with Drive or with the Firestore switch and a service account', () => {
  assert.equal(fieldPhotosConfigured({}), false);
  assert.equal(fieldPhotosConfigured(DRIVE), true);
  assert.equal(fieldPhotosConfigured(STORED), true);
  assert.equal(firestorePhotosEnabled({ EGC_FIELD_PHOTOS_FIRESTORE: 'true' }), false, 'the switch alone is not enough without Firestore credentials');
  assert.equal(fieldPhotosConfigured({ ...STORED, EGC_FIELD_PHOTOS_FIRESTORE: 'false' }), false, 'Cloudflare "false" turns it off');
  assert.equal(fieldPhotosConfigured({ ...STORED, EGC_FIELD_PHOTOS_FIRESTORE: 'TRUE' }), false, 'only exactly "true" counts');
});

test('with Drive connected, new photos go to Drive and Firestore photos are still read from Firestore', async t => {
  const memory = firestoreMemory(), hosts = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input); hosts.push(url.hostname);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
    if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: ['driveFile_0001'] });
    if (url.pathname.endsWith('/driveFile_0001')) return Response.json({ id: 'driveFile_0001', size: '100', mimeType: 'image/jpeg', appProperties: { egcJobId: JOB, egcFieldRequestId: REQUEST } });
    throw new Error(`unexpected request ${url.href}`);
  });
  const firestore = () => memoryClient(memory), picture = jpeg(2000);
  const saved = await memoryClient(memory).allocate();
  await memoryClient(memory).upload(saved, JOB, REQUEST, picture, 'storage');
  const both = await createFieldPhotoClient({ ...DRIVE, ...STORED }, { firestore, tokens: { current: null } });
  assert.deepEqual(new Uint8Array(await (await both.image(saved)).arrayBuffer()), picture.bytes);
  assert.equal((await both.metadata(saved)).appProperties.egcJobId, JOB);
  assert.deepEqual(hosts, [], 'reading a Firestore photo never contacts Google, so a broken Drive token cannot hide it');
  assert.equal(await both.allocate(), 'driveFile_0001', 'new uploads go to Drive');
  assert.equal((await both.metadata('driveFile_0001')).size, '100');
  assert.ok(hosts.includes('oauth2.googleapis.com') && hosts.includes('www.googleapis.com'));
  const onlyFirestore = await createFieldPhotoClient(STORED, { firestore });
  assert.ok(firestorePhotoFileId(await onlyFirestore.allocate()), 'without Drive, new uploads go to Firestore');
  await assert.rejects(createFieldPhotoClient({}), error => error.code === 'FIELD_PHOTO_STORAGE_UNAVAILABLE');
});

test('without Drive, a crew storage-bin photo reaches the customer storage map through Firestore', async t => {
  const env = {
    ...STORED, FIELD_CUSTOMER_PHOTOS_ENABLED: 'true', HUB_SESSION_SECRET: 'synthetic-photo-store-hub', CUSTOMER_PORTAL_SECRET: 'synthetic-photo-store-portal',
    HUB_AUTH_USERS_JSON: JSON.stringify({ 'Crew.One': { passwordHash: 'synthetic', role: 'crew', displayName: 'Synthetic Crew' } }),
  };
  const store = storage(t), cookie = (await createHubSessionCookie(env, 'Crew.One')).split(';')[0];
  store.put(`jobs/${JOB}`, { id: JOB, type: 'job', customer: 'Synthetic Customer', customerId: 'customer-s', address: '1 Synthetic Way', date: '2026-09-22', time: '08:00', endTime: '11:00', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', status: 'scheduled', pipelineStatus: 'scheduled', total: 1500 });
  const picture = jpeg(FIRESTORE_PHOTO_CHUNK_BYTES + 5000), dataUrl = `data:image/jpeg;base64,${Buffer.from(picture.bytes).toString('base64')}`;
  const crew = (method, body, search = '') => new Request(`${ORIGIN}/api/field-jobs${search}`, { method, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const upload = await fieldRoute.onRequestPost({ env, request: crew('POST', { jobId: JOB, requestId: REQUEST, expectedRevision: store.revision(JOB), action: 'photo', category: 'storage', caption: 'Internal crew caption', bin: 'A1', items: 'Holiday lights, wreath', dataUrl }) });
  assert.equal(upload.status, 200, await upload.clone().text());
  assert.equal(store.calls.generated + store.calls.uploads, 0, 'Google Drive is never contacted');
  const [saved] = store.get(`jobs/${JOB}`).fieldExecution.photos;
  assert.equal(saved.verified, true);
  assert.ok(firestorePhotoFileId(saved.fileId));
  assert.ok(store.documents.has(`fieldPhotoFiles/${saved.fileId}/chunks/1`), 'the photo spans two chunks');
  const crewImage = await fieldRoute.onRequestGet({ env, request: crew('GET', null, `?jobId=${JOB}&photoId=${REQUEST}`) });
  assert.equal(crewImage.status, 200);
  assert.deepEqual(new Uint8Array(await crewImage.arrayBuffer()), picture.bytes);

  store.put(`jobs/${JOB}`, { ...store.get(`jobs/${JOB}`), status: 'completed', pipelineStatus: 'completed', completedAt: '2026-10-28T17:00:00.000Z' });
  const portalCookie = `egc_customer_portal=${await createCustomerPortalSessionToken(env, JOB, Date.parse(NOW), { linkVersion: 0 })}`;
  const view = await createCustomerPortalHandlers({ now: () => new Date(NOW) }).onRequestGet({ env, request: new Request(`${ORIGIN}/api/customer-portal`, { headers: { Origin: ORIGIN, Cookie: portalCookie } }) });
  assert.equal(view.status, 200, await view.clone().text());
  const text = JSON.stringify(await view.json());
  assert.ok(text.includes('"bin":"A1"') && text.includes('Holiday lights, wreath'), 'the storage map lists the bin and what is in it');
  assert.equal(text.includes(saved.fileId) || text.includes('Internal crew caption'), false, 'no storage id or crew caption reaches the customer');
  const image = await createCustomerPortalPhotoHandlers({ now: () => new Date(NOW) }).onRequestGet({ env, request: new Request(`${ORIGIN}/api/customer-portal-photo?photoId=${REQUEST}&size=thumb`, { headers: { Cookie: portalCookie, 'Sec-Fetch-Site': 'same-origin' } }) });
  assert.equal(image.status, 200);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), picture.bytes, 'the grid tile is the full image');
});
