import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { customerPhotoJobComplete, customerPhotoPolicy, customerPhotoProjection, customerPhotoState, customerPhotosEnabled, customerPortalPhoto, customerVisiblePhotos, photoSharingCommand, photoSharingView } from '../functions/_lib/customer-photo-visibility.js';
import { fieldJobProjection, fieldPhotos } from '../functions/_lib/field-execution.js';
import { createFieldPhotoClient } from '../functions/_lib/field-execution-photos.js';
import { createFieldStore } from '../functions/_lib/field-execution-store.js';
import { fieldPhotoSharingHandlers } from '../functions/api/field-photo-sharing.js';
import * as fieldJobs from '../functions/api/field-jobs.js';
import { createCustomerPortalHandlers } from '../functions/api/customer-portal.js';
import { createCustomerPortalPhotoHandlers } from '../functions/api/customer-portal-photo.js';
import { storage } from './helpers/field-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z';
const ORIGIN = 'https://easygaragecleaning.com';
const JPEG = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]);
const env = {
  FIELD_CUSTOMER_PHOTOS_ENABLED: 'true', CUSTOMER_PORTAL_SECRET: 'synthetic-photo-portal-secret', HUB_SESSION_SECRET: 'synthetic-photo-hub-secret', FIREBASE_API_KEY: 'firebase-test-customer-photos',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', GOOGLE_REFRESH_TOKEN: 'synthetic-refresh',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic', role: 'owner', displayName: 'Synthetic Owner' }, AlexK: { passwordHash: 'synthetic', role: 'manager', displayName: 'Synthetic Manager' }, TylerG: { passwordHash: 'synthetic', role: 'crew_lead', displayName: 'Synthetic Lead' }, 'Crew.One': { passwordHash: 'synthetic', role: 'crew', displayName: 'Synthetic Crew' } }),
};
const off = { ...env, FIELD_CUSTOMER_PHOTOS_ENABLED: 'false' };
const ID = {
  before: '10000000-0000-4000-8000-000000000001', after: '10000000-0000-4000-8000-000000000002', damage: '10000000-0000-4000-8000-000000000003',
  progress: '10000000-0000-4000-8000-000000000004', walkthrough: '10000000-0000-4000-8000-000000000005', receipt: '10000000-0000-4000-8000-000000000006',
  unverified: '10000000-0000-4000-8000-000000000007', hidden: '10000000-0000-4000-8000-000000000008', other: '20000000-0000-4000-8000-000000000001',
};
const fileOf = id => `canaryFile_${id.replaceAll('-', '')}`;
const photo = (id, category, extra = {}) => ({ id, fileId: fileOf(id), category, caption: `Synthetic crew caption ${category}`, actorId: 'Crew.One', actorName: 'Synthetic Crew', createdAt: '2026-09-22T15:00:00.000Z', verified: true, mime: 'image/jpeg', bytes: JPEG.length, ...extra });
const gallery = () => [photo(ID.after, 'after', { createdAt: '2026-09-22T16:30:00.000Z' }), photo(ID.before, 'before'), photo(ID.damage, 'damage'), photo(ID.progress, 'progress'), photo(ID.walkthrough, 'walkthrough'), photo(ID.receipt, 'receipt'), photo(ID.unverified, 'before', { verified: false }), photo(ID.hidden, 'after', { customerHidden: { at: '2026-09-22T17:00:00.000Z', actorId: 'ZacB', actorName: 'Synthetic Owner' } })];
const job = (extra = {}) => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-a', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-22T17:00:00.000Z', assignedCrew: ['Crew.One'], fieldExecution: { photos: gallery(), checks: { 'arrival-scope': { completed: true } } }, ...extra });
const otherJob = () => job({ customer: 'Synthetic Other Customer', customerId: 'customer-b', fieldExecution: { photos: [photo(ID.other, 'before')] } });

// field-fixture storage with one fetch mock: hooks can wrap Firestore/Drive
// responses and every request host is recorded.
function fixture(t, jobs = { 'job-a': job(), 'job-b': otherJob() }) {
  let hook = null;
  const requests = [];
  const store = storage({ mock: { method: (object, name, implementation) => t.mock.method(object, name, (input, options = {}) => { requests.push(new URL(input).hostname); return hook ? hook(input, options, implementation) : implementation(input, options); }) } });
  for (const [id, value] of Object.entries(jobs)) {
    store.put(`jobs/${id}`, value);
    for (const item of value.fieldExecution?.photos || []) store.drive.set(item.fileId, { id: item.fileId, mimeType: 'image/jpeg', size: JPEG.length, trashed: false, appProperties: { egcJobId: id, egcFieldRequestId: item.id }, image: JPEG });
  }
  return Object.assign(store, { requests, intercept: fn => { hook = fn; } });
}

const portalCookie = async (jobId = 'job-a', claims = {}, at = Date.parse(NOW)) => `egc_customer_portal=${await createCustomerPortalSessionToken(env, jobId, at, { ...(claims.actorId ? {} : { linkVersion: 0 }), ...claims })}`;
const portal = createCustomerPortalHandlers({ now: () => new Date(NOW) });
const photos = createCustomerPortalPhotoHandlers({ now: () => new Date(NOW) });
async function portalView(cookie, testEnv = env) {
  const response = await portal.onRequestGet({ env: testEnv, request: new Request(`${ORIGIN}/api/customer-portal`, { headers: { Origin: ORIGIN, Cookie: cookie } }) });
  return { status: response.status, body: await response.json() };
}
const photoRequest = (cookie, search, headers = {}) => new Request(`${ORIGIN}/api/customer-portal-photo${search}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', ...headers } });
const photoGet = (cookie, photoId, { testEnv = env, handlers = photos, headers } = {}) => handlers.onRequestGet({ env: testEnv, request: photoRequest(cookie, `?photoId=${photoId}`, headers) });

const hubCookies = new Map(await Promise.all(['ZacB', 'AlexK', 'TylerG', 'Crew.One'].map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const sharing = fieldPhotoSharingHandlers({ now: () => new Date(NOW) });
const shareRequest = (user, body, headers = {}) => new Request(`${ORIGIN}/api/field-photo-sharing`, { method: 'POST', headers: { Cookie: hubCookies.get(user) || '', Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function share(store, user, input, { handlers = sharing, testEnv = env, headers } = {}) {
  const response = await handlers.post({ env: testEnv, request: shareRequest(user, { jobId: 'job-a', requestId: crypto.randomUUID(), expectedRevision: store.revision('job-a'), ...input }, headers) });
  return { status: response.status, body: await response.json() };
}
async function sharingView(user, jobId = 'job-a', testEnv = env) {
  const response = await sharing.get({ env: testEnv, request: new Request(`${ORIGIN}/api/field-photo-sharing?jobId=${jobId}`, { headers: { Cookie: hubCookies.get(user) || '' } }) });
  return { status: response.status, body: await response.json() };
}
const storedPhoto = (store, id, jobId = 'job-a') => store.get(`jobs/${jobId}`).fieldExecution.photos.find(item => item.id === id);
const noDrive = text => { for (const secret of ['canaryFile', 'googleapis', 'drive.google', 'Synthetic crew caption']) assert.equal(text.includes(secret), false, `${secret} leaked`); };

test('only verified before and after photos on a completed job are customer-visible by default', () => {
  const working = job({ status: 'in_progress', pipelineStatus: 'in_progress', completedAt: '' });
  assert.deepEqual(customerVisiblePhotos(working), []);
  assert.deepEqual(customerVisiblePhotos(job()).map(item => item.id), [ID.before, ID.after]);
  const reason = (value, id) => customerPhotoState(value, fieldPhotos(value).find(item => item.id === id)).reason;
  assert.equal(reason(working, ID.before), 'awaiting_completion');
  for (const id of [ID.damage, ID.progress, ID.walkthrough, ID.receipt]) assert.equal(reason(job(), id), 'not_shared');
  assert.equal(reason(job(), ID.hidden), 'hidden');
  const broken = job({ fieldExecution: { photos: [photo(ID.before, 'before', { fileId: '' }), photo('not-a-uuid', 'after'), photo(ID.after, 'after', { verified: 'true' })] } });
  assert.deepEqual(customerVisiblePhotos(broken), [], 'unverified or malformed photos never reach the customer');
  assert.equal(customerPortalPhoto(job(), ID.unverified), null);
  assert.equal(customerPortalPhoto(job(), '../canaryFile'), null);
});

test('sensitive categories need a confirmed manager share and a hide always wins', () => {
  const stamp = { at: '2026-09-22T17:30:00.000Z', actorId: 'ZacB', actorName: 'Synthetic Owner', requestId: ID.other };
  const visible = (value, id = ID.damage) => customerVisiblePhotos(value).some(item => item.id === id);
  const withPhoto = (item, extra = {}) => job({ fieldExecution: { photos: [item] }, ...extra });
  assert.equal(visible(withPhoto(photo(ID.damage, 'damage', { customerVisible: stamp }))), false, 'an unconfirmed share (for example a direct staff edit) is ignored');
  assert.equal(visible(withPhoto(photo(ID.damage, 'damage', { customerVisible: true }))), false);
  assert.equal(visible(withPhoto(photo(ID.damage, 'damage', { customerVisible: { ...stamp, confirmed: true } }))), true);
  assert.equal(visible(withPhoto(photo(ID.damage, 'damage', { customerVisible: { ...stamp, confirmed: true }, customerHidden: stamp }))), false);
  assert.equal(visible(withPhoto(photo(ID.before, 'before', { customerHidden: true })), ID.before), false, 'any hide marker fails closed');
  const early = { status: 'in_progress', pipelineStatus: 'in_progress', completedAt: '' };
  assert.equal(visible(withPhoto(photo(ID.before, 'before', { customerVisible: stamp }), early), ID.before), true, 'a manager may share a before photo before completion');
  assert.equal(visible(withPhoto(photo(ID.before, 'before', { customerVisible: { ...stamp, actorId: '' } }), early), ID.before), false);
  assert.equal(visible(withPhoto(photo(ID.before, 'before', { customerVisible: { ...stamp, at: 'yesterday' } }), early), ID.before), false);
});

test('photo completion follows the portal progress steps', async t => {
  const statuses = [{ status: 'scheduled' }, { status: 'in_progress', startedAt: NOW }, { status: 'completed' }, { status: 'paid' }, { status: 'review_requested' }, { status: 'closed' }, { status: 'invoiced' }, { status: 'invoiced', completedAt: NOW }, { status: 'invoiced', postJobChecklist: { completedAt: NOW } }, { status: 'cancelled' }, { status: 'arrived' }];
  const jobs = Object.fromEntries(statuses.map((extra, index) => [`job-${index}`, job({ pipelineStatus: undefined, completedAt: undefined, ...extra })]));
  fixture(t, jobs);
  for (const [index, extra] of statuses.entries()) {
    const view = await portalView(await portalCookie(`job-${index}`));
    assert.equal(view.status, 200);
    assert.equal(customerPhotoJobComplete(jobs[`job-${index}`]), ['completed', 'paid'].includes(view.body.appointment.status), JSON.stringify(extra));
    assert.equal(view.body.beforeAfter.length > 0, customerPhotoJobComplete(jobs[`job-${index}`]));
  }
});

test('the portal DTO gains beforeAfter only behind the flag, with opaque ids and no Drive data', async t => {
  fixture(t);
  const cookie = await portalCookie();
  const disabled = await portalView(cookie, off);
  assert.equal(disabled.status, 200);
  assert.equal(Object.hasOwn(disabled.body, 'beforeAfter'), false, 'flag off keeps today’s DTO shape');
  assert.equal(customerPhotosEnabled({}), false); assert.equal(customerPhotosEnabled({ FIELD_CUSTOMER_PHOTOS_ENABLED: 'TRUE' }), false);
  const enabled = await portalView(cookie);
  assert.deepEqual(enabled.body.beforeAfter, [
    { photoId: ID.before, category: 'before', addedAt: '2026-09-22T15:00:00.000Z', label: 'Before photo' },
    { photoId: ID.after, category: 'after', addedAt: '2026-09-22T16:30:00.000Z', label: 'After photo' },
  ]);
  noDrive(JSON.stringify(enabled.body));
  assert.deepEqual(customerPhotoProjection(job()), enabled.body.beforeAfter);
});

test('the photo route streams only this session’s visible photos', async t => {
  const store = fixture(t), cookieA = await portalCookie('job-a'), cookieB = await portalCookie('job-b');
  const response = await photoGet(cookieA, ID.before);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), JPEG);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  noDrive(JSON.stringify([...response.headers]));
  const miss = await (await photoGet(cookieA, ID.other)).json();
  assert.deepEqual(miss, { ok: false, code: 'CUSTOMER_PORTAL_PHOTO_NOT_FOUND', error: 'This photo is not available.' }, 'customer A cannot read customer B’s photo');
  assert.equal((await photoGet(cookieB, ID.other)).status, 200);
  for (const id of [ID.damage, ID.progress, ID.walkthrough, ID.receipt, ID.unverified, ID.hidden, '10000000-0000-4000-8000-00000000abcd', fileOf(ID.before)]) {
    const blocked = await photoGet(cookieA, id);
    assert.equal(blocked.status, 404, id);
    const text = await blocked.text();
    assert.equal(text, JSON.stringify(miss), 'every miss looks the same');
    noDrive(text);
  }
  store.put('jobs/job-a', job({ status: 'in_progress', pipelineStatus: 'in_progress', completedAt: '' }));
  assert.equal((await photoGet(cookieA, ID.before)).status, 404, 'unshared before photos wait for completion');
});

test('the photo route fails closed: flag off, bad parameters, cross-site, stale or revoked sessions', async t => {
  const store = fixture(t), cookie = await portalCookie();
  const before = store.requests.length, disabled = await photoGet(cookie, ID.before, { testEnv: off });
  assert.equal(disabled.status, 404);
  assert.equal(store.requests.length, before, 'flag off reads nothing');
  for (const search of ['', `?photoId=${ID.before}&photoId=${ID.after}`, `?photoId=${ID.before}&jobId=job-b`, `?jobId=job-a`]) assert.equal((await photos.onRequestGet({ env, request: photoRequest(cookie, search) })).status, 400, search);
  assert.equal((await photoGet(cookie, ID.before, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await photoGet(cookie, ID.before, { headers: { Origin: 'https://synthetic-attacker.example' } })).status, 403);
  assert.equal((await photoGet('', ID.before)).status, 401);
  assert.equal((await photoGet(await portalCookie('job-a', {}, Date.parse(NOW) - 8 * 24 * 60 * 60 * 1000), ID.before)).status, 401, 'expired session');
  store.put('jobs/job-a', job({ customerPortalLinkVersion: 1 }));
  const revoked = await photoGet(cookie, ID.before);
  assert.equal(revoked.status, 403);
  assert.equal((await revoked.json()).code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
  assert.equal((await photoGet(await portalCookie('job-a', { linkVersion: 1 }), ID.before)).status, 200);
});

test('collaborators follow their saved view permission on the DTO and the photo route', async t => {
  const people = [{ id: 'person-1', name: 'Synthetic Helper', email: 'helper@example.invalid', status: 'active', permissions: { view: true, decide: false, pay: false, rebook: false } }, { id: 'person-2', name: 'Synthetic Former', email: 'former@example.invalid', status: 'removed', permissions: { view: true } }, { id: 'person-3', name: 'Synthetic Viewless', email: 'viewless@example.invalid', status: 'active', permissions: { view: false } }];
  fixture(t, { 'job-a': job({ customerCollaborators: people }) });
  const helper = await portalCookie('job-a', { actorId: 'person-1', permissions: { view: true } });
  assert.equal((await portalView(helper)).body.beforeAfter.length, 2);
  assert.equal((await photoGet(helper, ID.after)).status, 200);
  for (const actorId of ['person-2', 'person-3']) {
    const cookie = await portalCookie('job-a', { actorId, permissions: { view: true } });
    assert.equal((await portalView(cookie)).status, 403);
    const response = await photoGet(cookie, ID.after);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
  }
});

test('business viewers follow their verified project grant', async t => {
  fixture(t);
  const calls = [], cookie = await portalCookie('job-a', { actorId: 'biz_account1_member1_3', permissions: { view: true } });
  const granted = createCustomerPortalPhotoHandlers({ now: () => new Date(NOW), businessRead: async (_env, actorId, project) => { calls.push([actorId, project.id]); return { name: 'Synthetic Company', permissions: { view: true, decide: false, pay: false, rebook: false } }; } });
  assert.equal((await photoGet(cookie, ID.before, { handlers: granted })).status, 200);
  assert.deepEqual(calls, [['biz_account1_member1_3', 'job-a']]);
  assert.equal((await photoGet(cookie, ID.damage, { handlers: granted })).status, 404);
  const removed = createCustomerPortalPhotoHandlers({ now: () => new Date(NOW), businessRead: async () => { throw Object.assign(new Error('internal'), { status: 403, publicMessage: 'Business access is invalid.' }); } });
  const denied = await photoGet(cookie, ID.before, { handlers: removed });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'CUSTOMER_PORTAL_BUSINESS_ACCESS');
  const viewless = createCustomerPortalPhotoHandlers({ now: () => new Date(NOW), businessRead: async () => ({ name: 'Synthetic Company', permissions: { view: false, decide: false, pay: false, rebook: false } }) });
  const blocked = await photoGet(cookie, ID.before, { handlers: viewless });
  assert.equal(blocked.status, 403, 'a saved grant without view never streams photos');
  assert.equal((await blocked.json()).code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
});

test('Drive must confirm the file is this job’s upload and serve an allowed image type', async t => {
  const store = fixture(t), cookie = await portalCookie();
  store.drive.get(fileOf(ID.before)).appProperties.egcJobId = 'job-b';
  assert.equal((await photoGet(cookie, ID.before)).status, 404, 'a job document pointing at another job’s file is refused');
  store.drive.get(fileOf(ID.after)).trashed = true;
  assert.equal((await photoGet(cookie, ID.after)).status, 404);
  store.drive.get(fileOf(ID.before)).appProperties = { egcJobId: 'job-a', egcFieldRequestId: ID.after };
  assert.equal((await photoGet(cookie, ID.before)).status, 404);
  const client = type => async () => ({ metadata: async fileId => ({ id: fileId, trashed: false, appProperties: { egcJobId: 'job-a', egcFieldRequestId: ID.after } }), image: async () => new Response(JPEG, { headers: { 'Content-Type': type } }) });
  const webp = await photoGet(cookie, ID.after, { handlers: createCustomerPortalPhotoHandlers({ now: () => new Date(NOW), photos: client('image/webp') }) });
  assert.equal(webp.status, 200); assert.equal(webp.headers.get('Content-Type'), 'image/webp');
  // Field uploads are JPEG, PNG or WebP only, so nothing else is ever streamed.
  for (const type of ['image/heic', 'image/svg+xml', 'text/html', '']) {
    const response = await photoGet(cookie, ID.after, { handlers: createCustomerPortalPhotoHandlers({ now: () => new Date(NOW), photos: client(type) }) });
    assert.equal(response.status, 503, type);
    assert.equal((await response.json()).code, 'CUSTOMER_PORTAL_PHOTO_UNAVAILABLE');
  }
  const failing = createCustomerPortalPhotoHandlers({ now: () => new Date(NOW), photos: async () => { throw new Error('Synthetic Drive failure https://www.googleapis.com/drive/v3/files/canaryFile_0002'); } });
  const failed = await photoGet(cookie, ID.after, { handlers: failing });
  assert.equal(failed.status, 503);
  noDrive(await failed.text());
});

test('the real Drive client refuses a HEIC file, so the portal never streams one', async t => {
  const store = fixture(t), cookie = await portalCookie();
  store.drive.get(fileOf(ID.before)).mimeType = 'image/heic';
  const response = await photoGet(cookie, ID.before);
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CUSTOMER_PORTAL_PHOTO_UNAVAILABLE');
  assert.equal((await photoGet(cookie, ID.after)).status, 200);
});

test('the Drive token is exchanged once per isolate until it nears expiry, and a 401 drops it', async t => {
  const store = fixture(t), cookie = await portalCookie(), bearer = [];
  let exchanges = 0, lifetime = 3599, unauthorized = false, clock = Date.parse(NOW);
  store.intercept(async (input, options, next) => {
    const url = new URL(input);
    if (url.hostname === 'oauth2.googleapis.com') { exchanges++; return Response.json({ access_token: `synthetic-access-${exchanges}`, ...(lifetime ? { expires_in: lifetime } : {}) }); }
    if (url.hostname === 'www.googleapis.com') { bearer.push(options.headers.Authorization); if (unauthorized) { unauthorized = false; return Response.json({}, { status: 401 }); } }
    return next(input, options);
  });
  const tokens = {}, handlers = createCustomerPortalPhotoHandlers({ now: () => new Date(NOW), photos: testEnv => createFieldPhotoClient(testEnv, { now: () => clock, tokens }) });
  const view = async (id = ID.before, testEnv = env) => (await photoGet(cookie, id, { handlers, testEnv })).status;
  for (let round = 0; round < 3; round++) for (const id of [ID.before, ID.after]) assert.equal(await view(id), 200);
  assert.equal(exchanges, 1, 'six thumbnails share one token exchange');
  assert.deepEqual(new Set(bearer), new Set(['Bearer synthetic-access-1']));
  clock += 3599000 - 60001; assert.equal(await view(), 200); assert.equal(exchanges, 1);
  clock += 1; assert.equal(await view(), 200); assert.equal(exchanges, 2, 'a token within a minute of expiry is replaced');
  assert.equal(await view(ID.before, { ...env, GOOGLE_REFRESH_TOKEN: 'synthetic-refresh-other' }), 200);
  assert.equal(exchanges, 3, 'another credential never reuses the cached token');
  assert.equal(await view(), 200); assert.equal(exchanges, 4);
  unauthorized = true; assert.equal(await view(), 503, 'a rejected token fails this request');
  assert.equal(await view(), 200); assert.equal(exchanges, 5, 'and is not reused');
  lifetime = 0; tokens.current = null;
  assert.equal(await view(), 200); assert.equal(await view(), 200); assert.equal(exchanges, 7, 'a token without a stated lifetime is not kept');
  assert.equal(JSON.stringify(tokens).includes('synthetic-refresh'), false, 'the cache holds a digest, never the refresh token');
});

test('FIELD_CUSTOMER_PHOTOS_SINCE limits automatic photos to ones added from that Denver day; shares still work', async t => {
  assert.deepEqual(customerPhotoPolicy({}), { autoFrom: '' });
  assert.deepEqual(customerPhotoPolicy({ FIELD_CUSTOMER_PHOTOS_SINCE: ' 2026-09-23 ' }), { autoFrom: '2026-09-23T06:00:00.000Z' });
  for (const bad of ['2026-02-30', 'yesterday', '09/23/2026', '2026-09-23T00:00']) assert.deepEqual(customerPhotoPolicy({ FIELD_CUSTOMER_PHOTOS_SINCE: bad }), { autoFrom: null }, bad);
  const late = '10000000-0000-4000-8000-000000000009', edge = '10000000-0000-4000-8000-00000000000a';
  const photos = [...gallery(), photo(late, 'after', { createdAt: '2026-09-23T05:59:59.000Z' }), photo(edge, 'after', { createdAt: '2026-09-23T06:00:00.000Z' })];
  const store = fixture(t, { 'job-a': job({ fieldExecution: { photos } }) }), cookie = await portalCookie();
  const since = { ...env, FIELD_CUSTOMER_PHOTOS_SINCE: '2026-09-23' }, broken = { ...env, FIELD_CUSTOMER_PHOTOS_SINCE: 'soon' };
  assert.deepEqual((await portalView(cookie)).body.beforeAfter.map(item => item.photoId), [ID.before, ID.after, late, edge], 'unset keeps every completed job’s photos');
  assert.deepEqual((await portalView(cookie, since)).body.beforeAfter.map(item => item.photoId), [edge], '11:59 PM Denver on Sep 22 is before the cutoff');
  assert.equal((await photoGet(cookie, ID.before, { testEnv: since })).status, 404);
  assert.equal((await photoGet(cookie, edge, { testEnv: since })).status, 200);
  assert.deepEqual((await portalView(cookie, broken)).body.beforeAfter, [], 'an unreadable cutoff fails closed');
  const reasons = (await sharingView('ZacB', 'job-a', since)).body.photos.filter(item => !item.sensitive).map(item => [item.photoId, item.reason]);
  assert.deepEqual(reasons, [[ID.before, 'before_cutoff'], [ID.hidden, 'hidden'], [ID.after, 'before_cutoff'], [late, 'before_cutoff'], [edge, 'completed']]);
  assert.equal((await share(store, 'ZacB', { photoId: ID.before, customerVisible: true }, { testEnv: since })).status, 200);
  assert.deepEqual((await portalView(cookie, since)).body.beforeAfter.map(item => item.photoId), [ID.before, edge], 'a manager share shows an older photo');
  assert.deepEqual((await portalView(cookie, broken)).body.beforeAfter.map(item => item.photoId), [ID.before]);
});

test('Hub sign-out clears photo-sharing retries that crew/job.html left in the tab', async () => {
  const page = readFileSync(new URL('../employee.html', import.meta.url), 'utf8');
  const source = page.slice(page.indexOf('let me = null;'), page.indexOf('async function sendBookingConfirmation'));
  const store = entries => { const map = new Map(entries); return { map, get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; };
  const session = store([['egc.photo-sharing.pending.v1.zacb.job-a', '{}'], ['egc_u', 'zacb'], ['egc.photo-sharing.pending.v1.alexk.job-b', '{}'], ['egc-field:zacb:job-a:note', 'Synthetic draft']]);
  const element = () => ({ value: '', textContent: '', style: {}, disabled: false, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {} });
  const elements = new Map(), events = [], context = {
    console, URLSearchParams, Date, Intl, Promise, Set, Map, Error, Event, sessionStorage: session, localStorage: store([]), navigator: {}, location: { pathname: '/employee', search: '' },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, dispatchEvent: event => events.push([event.type, [...session.map.keys()]]),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), firebase: { auth: () => ({ signOut: async () => {} }) },
    _dataGeneration: 0, _dataUnsubscribers: [], _listenersStarted: false, _leadsTimer: null, jobsCache: [], custsCache: [], leadsCache: [], blockedDays: new Set(), blockedSlots: new Set(),
    document: { readyState: 'loading', activeElement: null, body: element(), addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
  };
  context.window = context;
  vm.runInNewContext(`${source}\nglobalThis.ui = { doLogout };`, context);
  await context.ui.doLogout();
  assert.deepEqual(events, [['egc:signout', ['egc-field:zacb:job-a:note']]], 'retries are gone before sign-out listeners run');
});

test('only owners and managers manage customer photos; crew and crew leads get 403', async t => {
  const store = fixture(t, { 'job-a': job({ status: 'in_progress', pipelineStatus: 'in_progress', completedAt: '' }) });
  for (const user of ['AlexK', 'ZacB', 'Crew.One']) {
    const disabled = await share(store, user, { photoId: ID.before, customerVisible: true }, { testEnv: off });
    assert.equal(disabled.status, 404); assert.equal(disabled.body.code, 'FIELD_CUSTOMER_PHOTOS_DISABLED');
    assert.equal((await sharingView(user, 'job-a', off)).status, 404);
  }
  assert.equal((await share(store, 'nobody', { photoId: ID.before, customerVisible: true })).status, 401);
  for (const user of ['Crew.One', 'TylerG']) {
    const denied = await share(store, user, { photoId: ID.before, customerVisible: true });
    assert.equal(denied.status, 403, user); assert.equal(denied.body.code, 'FIELD_PHOTO_SHARING_FORBIDDEN');
    assert.equal((await sharingView(user)).status, 403);
  }
  assert.equal(store.calls.commits, 0);
  const view = await sharingView('AlexK');
  assert.equal(view.status, 200);
  assert.equal(view.body.viewer, 'AlexK'); assert.equal(view.body.jobComplete, false); assert.equal(view.body.expectedRevision, store.revision('job-a'));
  assert.deepEqual(view.body.photos.map(item => [item.photoId, item.visible, item.reason]), [[ID.before, false, 'awaiting_completion'], [ID.progress, false, 'not_shared'], [ID.hidden, false, 'hidden'], [ID.after, false, 'awaiting_completion'], [ID.damage, false, 'not_shared'], [ID.walkthrough, false, 'not_shared'], [ID.receipt, false, 'not_shared']]);
  noDrive(JSON.stringify(view.body));
  const manager = await share(store, 'AlexK', { photoId: ID.before, customerVisible: true });
  assert.equal(manager.status, 200); assert.equal(manager.body.alreadyApplied, false);
  assert.equal((await share(store, 'ZacB', { photoId: ID.before, customerVisible: false })).status, 200);
  assert.equal(store.calls.commits, 2);
});

test('sharing stamps one photo and writes a management-only receipt in the same commit', async t => {
  const store = fixture(t, { 'job-a': job({ status: 'in_progress', pipelineStatus: 'in_progress', completedAt: '' }) });
  const untouched = structuredClone(store.get('jobs/job-a').fieldExecution.photos.filter(item => item.id !== ID.before));
  const requestId = crypto.randomUUID(), response = await share(store, 'AlexK', { photoId: ID.before, customerVisible: true, requestId });
  assert.equal(response.status, 200);
  assert.deepEqual(storedPhoto(store, ID.before).customerVisible, { at: NOW, actorId: 'AlexK', actorName: 'Synthetic Manager', requestId });
  assert.deepEqual(store.get('jobs/job-a').fieldExecution.photos.filter(item => item.id !== ID.before), untouched);
  assert.deepEqual(store.get('jobs/job-a').fieldExecution.checks, { 'arrival-scope': { completed: true } }, 'other field state is preserved');
  const receipt = store.get(`jobs/job-a/fieldEvents/${requestId}`);
  assert.equal(receipt.action, 'photo_visibility'); assert.equal(receipt.visibility, 'management'); assert.equal(receipt.state, 'applied');
  assert.equal(receipt.photoId, ID.before); assert.equal(receipt.customerVisible, true); assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(store.calls.commits, 1);
  assert.deepEqual(response.body.photos.find(item => item.photoId === ID.before), { photoId: ID.before, category: 'before', sensitive: false, visible: true, state: 'shared', reason: 'shared', sharedAt: NOW, sharedBy: 'Synthetic Manager', hiddenAt: '', hiddenBy: '' });
  assert.deepEqual((await portalView(await portalCookie())).body.beforeAfter.map(item => item.photoId), [ID.before], 'shared early; the after photo waits for completion');

  store.put('jobs/job-a', { ...store.get('jobs/job-a'), status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-22T17:45:00.000Z' });
  const hide = await share(store, 'ZacB', { photoId: ID.after, customerVisible: false });
  assert.equal(hide.status, 200);
  assert.equal(storedPhoto(store, ID.after).customerHidden.actorId, 'ZacB');
  assert.equal(Object.hasOwn(storedPhoto(store, ID.after), 'customerVisible'), false);
  assert.deepEqual((await portalView(await portalCookie())).body.beforeAfter.map(item => item.photoId), [ID.before]);
  assert.equal((await share(store, 'ZacB', { photoId: ID.after, customerVisible: true })).status, 200, 'a hidden standard photo can be shared again');
  assert.equal(Object.hasOwn(storedPhoto(store, ID.after), 'customerHidden'), false);

  const crew = await (await fieldJobs.onRequestGet({ env, request: new Request(`${ORIGIN}/api/field-jobs?jobId=job-a`, { headers: { Cookie: hubCookies.get('Crew.One') } }) })).json();
  assert.equal(crew.job.history.some(item => item.action === 'photo_visibility'), false, 'crew never see the sharing receipts');
  assert.doesNotMatch(JSON.stringify(crew), /customerVisible|customerHidden/);
  const manager = await (await fieldJobs.onRequestGet({ env, request: new Request(`${ORIGIN}/api/field-jobs?jobId=job-a`, { headers: { Cookie: hubCookies.get('ZacB') } }) })).json();
  assert.deepEqual(manager.job.history.filter(item => item.action === 'photo_visibility').map(item => item.summary).sort(), ['After photo hidden from the customer', 'After photo shared with the customer', 'Before photo shared with the customer']);
});

test('the crew projection does not change when photos are shared or hidden', () => {
  const plain = job(), stamp = { at: NOW, actorId: 'ZacB', actorName: 'Synthetic Owner', requestId: ID.other };
  const marked = structuredClone(plain);
  marked.fieldExecution.photos = marked.fieldExecution.photos.map(item => item.category === 'damage' ? { ...item, customerVisible: { ...stamp, confirmed: true } } : item.category === 'before' ? { ...item, customerHidden: stamp } : item);
  for (const manager of [false, true]) assert.deepEqual(fieldJobProjection(marked, [], { manager, now: NOW }), fieldJobProjection(plain, [], { manager, now: NOW }));
});

test('damage, progress and walkthrough photos need an explicit confirmation to share', async t => {
  const store = fixture(t);
  for (const id of [ID.damage, ID.progress, ID.walkthrough, ID.receipt]) {
    const refused = await share(store, 'ZacB', { photoId: id, customerVisible: true });
    assert.equal(refused.status, 409, id); assert.equal(refused.body.code, 'FIELD_PHOTO_SHARE_CONFIRMATION_REQUIRED');
    assert.equal((await share(store, 'ZacB', { photoId: id, customerVisible: true, confirm: false })).status, 409);
  }
  assert.equal((await share(store, 'ZacB', { photoId: ID.damage, customerVisible: true, confirm: 'yes' })).status, 400);
  assert.equal(store.calls.commits, 0);
  const shared = await share(store, 'ZacB', { photoId: ID.damage, customerVisible: true, confirm: true });
  assert.equal(shared.status, 200);
  assert.equal(storedPhoto(store, ID.damage).customerVisible.confirmed, true);
  const view = await portalView(await portalCookie());
  assert.deepEqual(view.body.beforeAfter.map(item => [item.photoId, item.category, item.label]), [[ID.before, 'before', 'Before photo'], [ID.after, 'after', 'After photo'], [ID.damage, 'damage', 'Damage photo']]);
  assert.equal((await photoGet(await portalCookie(), ID.damage)).status, 200);
  assert.equal((await share(store, 'ZacB', { photoId: ID.damage, customerVisible: false })).status, 200, 'hiding never needs a confirmation');
  assert.equal((await photoGet(await portalCookie(), ID.damage)).status, 404);
  assert.equal(store.calls.commits, 2);
});

test('replays are idempotent and a reused request ID with different details conflicts', async t => {
  const store = fixture(t), requestId = crypto.randomUUID(), expectedRevision = store.revision('job-a');
  const input = { photoId: ID.after, customerVisible: false, requestId, expectedRevision };
  assert.equal((await share(store, 'AlexK', input)).body.alreadyApplied, false);
  const replay = await share(store, 'AlexK', input);
  assert.equal(replay.status, 200); assert.equal(replay.body.alreadyApplied, true);
  assert.equal(replay.body.expectedRevision, store.revision('job-a'));
  assert.equal(store.calls.commits, 1, 'a replay never writes twice');
  const changed = await share(store, 'AlexK', { ...input, customerVisible: true });
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'FIELD_IDEMPOTENCY_CONFLICT');
  const otherActor = await share(store, 'ZacB', input);
  assert.equal(otherActor.status, 409, 'the receipt fingerprint binds the actor');
  store.put(`jobs/job-a/fieldEvents/${ID.before}`, { id: ID.before, action: 'photo', state: 'applied', visibility: 'crew', actorId: 'Crew.One', fingerprint: 'f'.repeat(64), fileId: fileOf(ID.before), photoId: ID.before });
  const photoReceipt = await share(store, 'AlexK', { photoId: ID.before, customerVisible: false, requestId: ID.before });
  assert.equal(photoReceipt.status, 409, 'an upload receipt id cannot be reused'); assert.equal(photoReceipt.body.code, 'FIELD_IDEMPOTENCY_CONFLICT');
  assert.equal(store.calls.commits, 1);
});

test('stale revisions conflict, including Firestore’s 400 FAILED_PRECONDITION on commit', async t => {
  const store = fixture(t), stale = store.revision('job-a');
  store.put('jobs/job-a', { ...store.get('jobs/job-a'), customerMemory: { accessInstructions: 'Synthetic side door' } });
  const conflict = await share(store, 'AlexK', { photoId: ID.after, customerVisible: false, expectedRevision: stale });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'FIELD_REVISION_CONFLICT');
  assert.equal(store.calls.commits, 0);
  // Another writer lands between this request's read and its commit.
  const racing = fieldPhotoSharingHandlers({ now: () => new Date(NOW), storage: testEnv => { const real = createFieldStore(testEnv); return { ...real, async readJob(id) { const found = await real.readJob(id); store.put(`jobs/${id}`, { ...store.get(`jobs/${id}`), updatedAt: NOW }); return found; } }; } });
  for (const firestore400 of [false, true]) {
    store.intercept(firestore400 ? async (input, options, next) => { const response = await next(input, options); return response.status === 412 ? Response.json({ error: { code: 400, message: 'the stored version does not match the required base version', status: 'FAILED_PRECONDITION' } }, { status: 400 }) : response; } : null);
    const requestId = crypto.randomUUID(), raced = await share(store, 'AlexK', { photoId: ID.after, customerVisible: false, requestId }, { handlers: racing });
    assert.equal(raced.status, 409, `firestore400=${firestore400}`); assert.equal(raced.body.code, 'FIELD_REVISION_CONFLICT');
    assert.equal(store.get(`jobs/job-a/fieldEvents/${requestId}`).action, undefined, 'no receipt without the job change');
    assert.equal(Object.hasOwn(storedPhoto(store, ID.after), 'customerHidden'), false);
  }
  assert.equal(store.calls.commits, 0);
});

test('a lost commit response is recovered from the receipt, never assumed', async t => {
  const store = fixture(t);
  store.intercept(async (input, options, next) => { const response = await next(input, options); return new URL(input).pathname.endsWith(':commit') ? new Response('upstream reset', { status: 503 }) : response; });
  const requestId = crypto.randomUUID(), recovered = await share(store, 'AlexK', { photoId: ID.after, customerVisible: false, requestId });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.alreadyApplied, true);
  assert.equal(storedPhoto(store, ID.after).customerHidden.requestId, requestId);
  store.intercept(async (input, options, next) => new URL(input).pathname.endsWith(':commit') ? new Response('upstream reset', { status: 503 }) : next(input, options));
  const lost = await share(store, 'AlexK', { photoId: ID.before, customerVisible: false });
  assert.equal(lost.status, 503); assert.equal(lost.body.code, 'FIELD_STORAGE_UNAVAILABLE');
  assert.equal(Object.hasOwn(storedPhoto(store, ID.before), 'customerHidden'), false);
});

test('the field store maps only FAILED_PRECONDITION 400s to revision conflicts', async t => {
  let answer;
  t.mock.method(globalThis, 'fetch', async input => { assert.equal(new URL(input).hostname, 'firestore.googleapis.com'); return answer(); });
  const store = createFieldStore(env), commit = () => store.commit({ id: 'job-a', __updateTime: '2026-09-22T00:00:00.000001Z' }, { updatedAt: NOW }, { id: ID.other, action: 'note' });
  for (const body of [{ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'stale' } }, [{ error: { code: 400, status: 'FAILED_PRECONDITION' } }]]) {
    answer = () => Response.json(body, { status: 400 });
    await assert.rejects(commit, { code: 'FIELD_REVISION_CONFLICT', status: 409 });
  }
  for (const response of [() => Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, { status: 400 }), () => new Response('not json', { status: 400 }), () => new Response('', { status: 500 })]) {
    answer = response;
    await assert.rejects(commit, { code: 'FIELD_STORAGE_UNAVAILABLE', status: 503 });
  }
  answer = () => Response.json({}, { status: 409 }); await assert.rejects(commit, { code: 'FIELD_REVISION_CONFLICT' });
});

test('share requests are same-origin JSON within the size limit and name one saved photo', async t => {
  const store = fixture(t, { 'job-a': job(), 'job-private': job({ recordType: 'employee_hub_v2' }) });
  const base = () => ({ jobId: 'job-a', photoId: ID.after, customerVisible: false, requestId: crypto.randomUUID(), expectedRevision: store.revision('job-a') });
  const post = async (body, headers = {}, user = 'ZacB') => { const response = await sharing.post({ env, request: shareRequest(user, body, headers) }); return { status: response.status, code: (await response.json()).code }; };
  assert.deepEqual(await post(base(), { 'Sec-Fetch-Site': 'cross-site' }), { status: 403, code: 'FIELD_ORIGIN_FORBIDDEN' });
  assert.deepEqual(await post(base(), { Origin: 'https://synthetic-attacker.example' }), { status: 403, code: 'FIELD_ORIGIN_FORBIDDEN' });
  assert.equal((await post(base(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ ...base(), padding: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post('{"jobId":')).status, 400);
  assert.equal((await post({ ...base(), actorId: 'ZacB' })).status, 400, 'unknown keys are rejected');
  assert.equal((await post({ ...base(), requestId: 'not-a-uuid' })).status, 400);
  assert.equal((await post({ ...base(), customerVisible: 'false' })).status, 400);
  assert.deepEqual(await post({ ...base(), expectedUser: 'Crew.One' }), { status: 401, code: 'FIELD_ACCOUNT_CHANGED' });
  assert.deepEqual(await post({ ...base(), photoId: ID.unverified }), { status: 404, code: 'FIELD_PHOTO_NOT_FOUND' });
  assert.deepEqual(await post({ ...base(), photoId: ID.other }), { status: 404, code: 'FIELD_PHOTO_NOT_FOUND' }, 'another job’s photo is not part of this job');
  assert.deepEqual(await post({ ...base(), jobId: 'job-private' }), { status: 404, code: 'FIELD_JOB_NOT_FOUND' });
  assert.deepEqual(await post({ ...base(), jobId: '_egc_schedule_lock_2026-09-22' }), { status: 400, code: 'FIELD_REQUEST_INVALID' });
  assert.equal(store.calls.commits, 0);
  assert.equal((await post({ ...base(), expectedUser: 'zacb' })).status, 200, 'expectedUser matches case-insensitively');
  const response = await sharing.get({ env, request: new Request(`${ORIGIN}/api/field-photo-sharing?jobId=job-a&jobId=job-b`, { headers: { Cookie: hubCookies.get('ZacB') } }) });
  assert.equal(response.status, 400);
});

test('photoSharingCommand is pure and keeps every other photo byte-for-byte', () => {
  const source = job(), before = structuredClone(source), actor = { user: 'ZacB', displayName: 'Synthetic Owner' };
  const { patch, event } = photoSharingCommand(source, actor, { photoId: ID.walkthrough, customerVisible: true, confirm: true, requestId: ID.other }, NOW);
  assert.deepEqual(source, before, 'the input job is not mutated');
  assert.deepEqual(Object.keys(patch).sort(), ['fieldExecution', 'updatedAt']);
  assert.deepEqual(patch.fieldExecution.photos.find(item => item.id === ID.walkthrough).customerVisible, { at: NOW, actorId: 'ZacB', actorName: 'Synthetic Owner', requestId: ID.other, confirmed: true });
  assert.deepEqual(patch.fieldExecution.photos.filter(item => item.id !== ID.walkthrough), before.fieldExecution.photos.filter(item => item.id !== ID.walkthrough));
  assert.deepEqual(event, { id: ID.other, action: 'photo_visibility', actorId: 'ZacB', actorName: 'Synthetic Owner', createdAt: NOW, state: 'applied', visibility: 'management', photoId: ID.walkthrough, customerVisible: true, summary: 'Walkthrough photo shared with the customer', body: '' });
  assert.throws(() => photoSharingCommand(source, actor, { photoId: ID.unverified, customerVisible: true, requestId: ID.other }, NOW), { code: 'FIELD_PHOTO_NOT_FOUND' });
  assert.equal(photoSharingView(source).photos.some(item => Object.hasOwn(item, 'fileId')), false);
});

test('portal gallery helpers accept only opaque ids and show Denver dates', () => {
  const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8'), lines = html.split(/\r?\n/);
  const pick = prefix => { const line = lines.find(item => item.startsWith(prefix)); assert.ok(line, prefix); return line; };
  const context = {};
  vm.runInNewContext([pick('function photoDateLabel('), pick('function galleryItems('), pick('function galleryPhotoUrl(')].join('\n'), context);
  assert.equal(context.photoDateLabel('2026-09-23T03:30:00.000Z'), 'Sep 22, 2026', 'late-evening Denver photos keep their Denver date');
  assert.equal(context.photoDateLabel(''), '');
  const items = context.galleryItems({ beforeAfter: [{ photoId: ID.before, category: 'before' }, { photoId: 'canaryFile_0001' }, { photoId: '../../api/field-jobs' }, null, { photoId: 7 }] });
  assert.deepEqual(Array.from(items, item => item.photoId), [ID.before]);
  assert.equal(context.galleryItems({}).length, 0);
  assert.equal(context.galleryPhotoUrl({ photoId: ID.before }), `/api/customer-portal-photo?photoId=${ID.before}`);
  // Security invariant: gallery DOM is built with textContent/createElement only.
  for (const prefix of ['function renderGallery(', 'function galleryThumb(', 'function openGalleryPhoto(']) assert.doesNotMatch(pick(prefix), /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(html, /<input id="photo-camera" type="file" accept="image\/jpeg,image\/png,image\/webp" capture="environment">/);
  assert.match(html, /<input id="photo-input" type="file" accept="image\/jpeg,image\/png,image\/webp" multiple>/, 'library uploads stay available');
});
