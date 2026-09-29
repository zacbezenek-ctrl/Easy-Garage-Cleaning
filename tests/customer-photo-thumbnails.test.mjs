import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { createFieldPhotoClient, driveThumbnailUrl, FIELD_PHOTO_THUMBNAIL_MAX_BYTES } from '../functions/_lib/field-execution-photos.js';
import { createCustomerPortalPhotoHandlers } from '../functions/api/customer-portal-photo.js';

// The portal photo grid asks for size=thumb: Drive's small rendition of the same private file,
// after exactly the checks the full image gets, and the full image whenever no thumbnail comes back.
const NOW = '2026-09-22T18:00:00.000Z';
const ORIGIN = 'https://easygaragecleaning.com';
const env = { FIELD_CUSTOMER_PHOTOS_ENABLED: 'true', CUSTOMER_PORTAL_SECRET: 'synthetic-thumb-portal-secret', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', GOOGLE_REFRESH_TOKEN: 'synthetic-refresh' };
const ID = { before: '30000000-0000-4000-8000-000000000001', damage: '30000000-0000-4000-8000-000000000002' };
const FULL = new Uint8Array([255, 216, 255, 224, 1, 1, 1, 255, 217]), SMALL = new Uint8Array([255, 216, 255, 224, 2, 255, 217]);
const LINK = 'https://lh3.googleusercontent.com/drive-storage/synthetic-thumbnail=s220';
const photo = (id, category) => ({ id, fileId: `synthFile_${id.slice(-4)}`, category, caption: 'Synthetic caption', actorId: 'Crew.One', actorName: 'Synthetic Crew', createdAt: '2026-09-22T15:00:00.000Z', verified: true, mime: 'image/jpeg', bytes: FULL.length });
const job = { id: 'job-thumb', type: 'job', customer: 'Synthetic Customer', status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-22T17:00:00.000Z', assignedCrew: ['Crew.One'], fieldExecution: { photos: [photo(ID.before, 'before'), photo(ID.damage, 'damage')] } };

function fakeDrive({ thumbnailLink = LINK, thumbnail = async () => new Response(SMALL, { headers: { 'Content-Type': 'image/jpeg' } }) } = {}) {
  const calls = [];
  const client = {
    metadata: async fileId => { calls.push(['metadata', fileId]); const item = job.fieldExecution.photos.find(entry => entry.fileId === fileId); return { id: fileId, trashed: false, appProperties: { egcJobId: job.id, egcFieldRequestId: item.id }, ...(thumbnailLink ? { thumbnailLink } : {}) }; },
    image: async fileId => { calls.push(['image', fileId]); return new Response(FULL, { headers: { 'Content-Type': 'image/jpeg' } }); },
    thumbnail: async link => { calls.push(['thumbnail', link]); return thumbnail(link); },
  };
  return { calls, photos: async () => client };
}

async function get(search, drive, testEnv = env) {
  const cookie = `egc_customer_portal=${await createCustomerPortalSessionToken(env, job.id, Date.parse(NOW), { linkVersion: 0 })}`;
  const handlers = createCustomerPortalPhotoHandlers({ now: () => new Date(NOW), read: async (_env, id) => (id === job.id ? structuredClone(job) : null), photos: drive.photos });
  return handlers.onRequestGet({ env: testEnv, request: new Request(`${ORIGIN}/api/customer-portal-photo${search}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } }) });
}
const bytes = async response => new Uint8Array(await response.arrayBuffer());

test('size=thumb streams Drive’s small rendition with the full image’s private headers', async () => {
  const drive = fakeDrive(), response = await get(`?photoId=${ID.before}&size=thumb`, drive);
  assert.equal(response.status, 200);
  assert.deepEqual(await bytes(response), SMALL);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.deepEqual(drive.calls.map(([name]) => name), ['metadata', 'thumbnail'], 'the full image is never downloaded for a tile');
  assert.equal(drive.calls[1][1], LINK);
  // Parameter order does not matter; the viewer's plain request never asks for a thumbnail.
  assert.deepEqual(await bytes(await get(`?size=thumb&photoId=${ID.before}`, fakeDrive())), SMALL);
  const full = fakeDrive(), plain = await get(`?photoId=${ID.before}`, full);
  assert.deepEqual(await bytes(plain), FULL);
  assert.deepEqual(full.calls.map(([name]) => name), ['metadata', 'image']);
});

test('without a usable thumbnail the grid gets the full image, as before', async () => {
  for (const drive of [fakeDrive({ thumbnailLink: '' }), fakeDrive({ thumbnail: async () => null })]) {
    const response = await get(`?photoId=${ID.before}&size=thumb`, drive);
    assert.equal(response.status, 200);
    assert.deepEqual(await bytes(response), FULL);
    assert.equal(drive.calls.at(-1)[0], 'image');
  }
});

test('thumbnails keep every access check: flag, visibility and parameters', async () => {
  const hidden = fakeDrive(), unshared = await get(`?photoId=${ID.damage}&size=thumb`, hidden);
  assert.equal(unshared.status, 404, 'an unshared damage photo has no thumbnail either');
  assert.deepEqual(hidden.calls, []);
  const off = fakeDrive();
  assert.equal((await get(`?photoId=${ID.before}&size=thumb`, off, { ...env, FIELD_CUSTOMER_PHOTOS_ENABLED: 'false' })).status, 404);
  assert.deepEqual(off.calls, []);
  for (const search of [`?photoId=${ID.before}&size=full`, `?photoId=${ID.before}&size=thumb&size=thumb`, `?photoId=${ID.before}&size=`, `?size=thumb`, `?photoId=${ID.before}&size=thumb&jobId=job-b`]) {
    const drive = fakeDrive(), response = await get(search, drive);
    assert.equal(response.status, 400, search);
    assert.equal((await response.json()).code, 'CUSTOMER_PORTAL_PHOTO_INVALID');
    assert.deepEqual(drive.calls, [], search);
  }
});

test('only an https googleusercontent.com thumbnail link is fetched, resized for the phone grid', () => {
  assert.equal(driveThumbnailUrl(LINK), 'https://lh3.googleusercontent.com/drive-storage/synthetic-thumbnail=s640');
  assert.equal(driveThumbnailUrl(LINK, 400), 'https://lh3.googleusercontent.com/drive-storage/synthetic-thumbnail=s400');
  assert.equal(driveThumbnailUrl('https://lh3.googleusercontent.com/synthetic?sz=1'), 'https://lh3.googleusercontent.com/synthetic?sz=1', 'an unfamiliar shape is fetched as given');
  for (const link of ['http://lh3.googleusercontent.com/x=s220', 'https://googleusercontent.com.attacker.example/x=s220', 'https://attacker.example/lh3.googleusercontent.com=s220',
    'https://lh3.googleusercontent.com:8443/x=s220', 'https://user@lh3.googleusercontent.com/x=s220', 'https://drive.google.com/thumbnail?id=x', 'javascript:alert(1)', '', null, undefined, 42]) {
    assert.equal(driveThumbnailUrl(link), null, String(link));
  }
});

test('the Drive client fetches the thumbnail with the file credentials and returns null on any problem', async t => {
  const seen = [];
  let reply = () => new Response(SMALL, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(SMALL.length) } });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', expires_in: 3599 });
    seen.push({ url: url.href, authorization: options.headers?.Authorization, redirect: options.redirect });
    return reply(url);
  });
  const client = await createFieldPhotoClient(env, { now: () => Date.parse(NOW), tokens: {} });
  const thumb = await client.thumbnail(LINK);
  assert.deepEqual(await bytes(thumb), SMALL);
  assert.equal(thumb.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(seen, [{ url: 'https://lh3.googleusercontent.com/drive-storage/synthetic-thumbnail=s640', authorization: 'Bearer synthetic-access', redirect: 'error' }]);
  const refusals = [
    () => new Response('', { status: 404 }),
    () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(SMALL, { headers: { 'Content-Type': 'image/svg+xml' } }),
    () => new Response(SMALL, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(FIELD_PHOTO_THUMBNAIL_MAX_BYTES + 1) } }),
    () => { throw new TypeError('redirect mode is set to error'); },
  ];
  for (const refusal of refusals) { reply = refusal; assert.equal(await client.thumbnail(LINK), null); }
  const before = seen.length;
  assert.equal(await client.thumbnail('https://attacker.example/x=s220'), null);
  assert.equal(seen.length, before, 'a foreign link is never requested');
});

test('a 401 from the thumbnail host keeps the shared Drive token; a Drive API 401 still drops it', async t => {
  let exchanges = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).hostname === 'oauth2.googleapis.com') { exchanges++; return Response.json({ access_token: `synthetic-access-${exchanges}`, expires_in: 3599 }); }
    return new Response('', { status: 401 });
  });
  const tokens = {}, now = () => Date.parse(NOW), client = await createFieldPhotoClient(env, { now, tokens });
  for (let tile = 0; tile < 3; tile++) assert.equal(await client.thumbnail(LINK), null);
  assert.equal(tokens.current?.token, 'synthetic-access-1', 'rejected thumbnails leave the token for every other tile');
  await createFieldPhotoClient(env, { now, tokens });
  assert.equal(exchanges, 1, 'the next tile reuses it without a refresh-token exchange');
  await assert.rejects(client.metadata('synthFile_0001'), { code: 'FIELD_PHOTO_VERIFY_FAILED' });
  assert.equal(tokens.current, null, 'a Drive API 401 still drops a revoked token');
});

test('the thumbnail byte cap holds for a body without a Content-Length', async t => {
  const chunk = new Uint8Array(256 * 1024);
  chunk.set(SMALL);
  let total = 0, pulled = 0, cancelled = false;
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', expires_in: 3599 });
    let sent = 0;
    const body = new ReadableStream({ pull(controller) { if (sent === total) return controller.close(); sent++; pulled++; controller.enqueue(chunk.slice()); }, cancel() { cancelled = true; } });
    return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } });
  });
  const client = await createFieldPhotoClient(env, { now: () => Date.parse(NOW), tokens: {} });
  total = FIELD_PHOTO_THUMBNAIL_MAX_BYTES / chunk.length;
  const exact = await client.thumbnail(LINK);
  assert.equal(exact.headers.get('Content-Type'), 'image/jpeg');
  assert.equal((await bytes(exact)).length, FIELD_PHOTO_THUMBNAIL_MAX_BYTES, 'exactly the cap is served');
  total = 64;
  pulled = 0;
  // A primitive comparison: a Response still holding the 16 MB stream would stall the failure report.
  assert.ok(await client.thumbnail(LINK) === null, 'a 16 MB chunked body falls back to the full image');
  assert.equal(cancelled, true);
  assert.ok(pulled <= total / 10, `reading stopped at the cap (${pulled} chunks pulled)`);
});

test('a stalled thumbnail falls back to the full image, and a returned one no longer depends on Drive', async t => {
  const timers = [];
  t.mock.method(AbortSignal, 'timeout', ms => { const controller = new AbortController(); timers.push({ ms, controller }); return controller.signal; });
  let stall = true;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    if (new URL(input).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', expires_in: 3599 });
    // Like a real fetch, the request's signal errors the body mid-stream.
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(SMALL.slice(0, 4));
      if (!stall) { controller.enqueue(SMALL.slice(4)); controller.close(); }
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason));
    } });
    return new Response(body, { headers: { 'Content-Type': 'image/jpeg' } });
  });
  const client = await createFieldPhotoClient(env, { now: () => Date.parse(NOW), tokens: {} });
  const timeout = () => timers.at(-1).controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  const pending = client.thumbnail(LINK);
  assert.equal(timers.at(-1).ms, 10000);
  await new Promise(resolve => setImmediate(resolve));
  timeout();
  assert.ok(await pending === null, 'half a thumbnail is never served');
  stall = false;
  const thumb = await client.thumbnail(LINK);
  timeout();
  assert.deepEqual(await bytes(thumb), SMALL, 'a slow viewer still gets the whole thumbnail after the Drive timeout');
});
