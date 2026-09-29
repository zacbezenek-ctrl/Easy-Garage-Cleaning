import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { CREW_PHOTO_LINK_SECONDS, CREW_PROFILES, CREW_PROFILE_OPERATIONS, crewPhotoLink, crewPhotoOwner, crewProfileStorage, crewRosterPhotoStore, customerCrew, customerCrewProjection, publicCrewProfile, readCrewPublicProfiles, resolveCustomerCrewPhoto } from '../functions/_lib/crew-public-profile.js';
import { crewPublicProfileHandlers } from '../functions/api/crew-public-profile.js';
import { createCustomerCrewPhotoHandlers } from '../functions/api/customer-crew-photo.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { staffGatedPath } from '../staff-paths.js';
import { NOW, env as portalEnv, portalCookie, portalHandlers, portalScript, portalView } from './helpers/portal-fixture.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
const env = { ...portalEnv, HUB_SESSION_SECRET: 'synthetic-crew-profile-hub-session-secret-0001', CREW_PUBLIC_PROFILES_ENABLED: 'true' };
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const dataUrl = (bytes = JPEG, mime = 'image/jpeg') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const uuid = () => crypto.randomUUID();
// Changes one character in the middle of a signature, so the value stays canonical base64url.
const flip = (value, at) => value.slice(0, at) + (value[at] === 'A' ? 'B' : 'A') + value.slice(at + 1);
const PHOTO_ONE = '5b1f2a4c-8d3e-4f60-9a71-0c2d3e4f5a61', PHOTO_THREE = '6c2a3b5d-9e4f-4a71-8b82-1d3e4f5a6b72';
const crew = { user: 'Crew.One', displayName: 'Dana Canarylast', role: 'crew', businessAccess: false };
const crewTwo = { user: 'crew.two', displayName: 'Riley Synthetic', role: 'crew', businessAccess: false };
const manager = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const sales = { user: 'AlexK', displayName: 'Synthetic Sales', role: 'sales', businessAccess: true };
const ROSTER = [{ id: 'crew.one', name: 'Dana Canarylast', role: 'crew' }, { id: 'crew.two', name: 'Riley Synthetic', role: 'crew' }, { id: 'tylerg', name: 'Synthetic Manager', role: 'manager' }];
const approvedPhoto = (requestId, fileId) => ({ fileId, requestId, mime: 'image/jpeg', bytes: JPEG.length, sha256: 'synthetic', uploadedAt: '2026-09-20T15:00:00.000Z', uploadedBy: 'crew.one', approvedAt: '2026-09-20T16:00:00.000Z', approvedBy: 'tylerg' });
// Stored junk proves the customer DTO is an allowlist: none of these may ever reach a customer.
const CANARIES = ['Canarylast', '9705550199', 'hourlyRate', 'synthetic-drive-canary', 'crew.one', 'crew.two', 'crew.three', 'tylerg'];
const profiles = () => ({
  [`${CREW_PROFILES}/crew.one`]: { username: 'crew.one', firstName: 'Dana', lastName: 'Canarylast', phone: '9705550199', hourlyRate: 31, active: true, photo: approvedPhoto(PHOTO_ONE, 'synthetic-drive-canary-1'), pendingPhoto: null, pendingUpload: null },
  [`${CREW_PROFILES}/crew.two`]: { username: 'crew.two', firstName: 'Riley', active: true, photo: null, pendingPhoto: null, pendingUpload: null },
  [`${CREW_PROFILES}/crew.three`]: { username: 'crew.three', firstName: 'Hidden', active: false, photo: approvedPhoto(PHOTO_THREE, 'synthetic-drive-canary-3') },
});
const JOB = { type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 800, status: 'dispatched', pipelineStatus: 'dispatched', assignedCrew: ['crew.one', 'crew.two'], crewLead: 'crew.two', fieldExecution: { activity: 'dispatched', activityAt: '2026-09-22T15:42:00.000Z' } };
const reader = jobs => async (_env, id) => jobs[id] ? { ...structuredClone(jobs[id]), id, __updateTime: `rev-${id}` } : null;

// Firestore REST emulation behind the injected fetcher: document GET, paginated collection lists, batchGet and
// :commit with updateMask and exists/updateTime preconditions (412 on mismatch), one target per commit write.
function firestore(seed = {}, { pageSize } = {}) {
  const docs = new Map(), calls = { commits: [], reads: [] };
  let clock = 0, failNext = '', brokenList = false;
  const put = (path, data) => docs.set(path, { data: structuredClone(data), updateTime: `2026-09-22T12:00:00.${String(++clock).padStart(6, '0')}Z` });
  for (const [path, data] of Object.entries(seed)) put(path, data);
  const body = path => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(docs.get(path).data), updateTime: docs.get(path).updateTime });
  const apply = writes => {
    for (const write of writes) {
      const key = write.update.name.split('/documents/')[1], patch = decodeFirestoreFields(write.update.fields), next = { ...(docs.get(key)?.data || {}) };
      for (const field of write.updateMask.fieldPaths) next[field] = patch[field];
      put(key, next);
    }
  };
  async function fetcher(_env, input, options = {}) {
    const url = new URL(String(input)), path = decodeURIComponent(url.pathname.split('/documents')[1] || '').replace(/^\//, '');
    if (path === ':batchGet') {
      const names = JSON.parse(options.body).documents;
      return Response.json(names.map(name => { const key = name.split('/documents/')[1]; calls.reads.push(key); return docs.has(key) ? { found: body(key) } : { missing: name }; }));
    }
    if (path === ':commit') {
      const writes = JSON.parse(options.body).writes, targets = writes.map(write => write.update.name.split('/documents/')[1]);
      assert.equal(new Set(targets).size, targets.length, 'one write per document in a commit');
      if (failNext === 'error') { failNext = ''; return Response.json({}, { status: 500 }); }
      for (const write of writes) {
        const existing = docs.get(write.update.name.split('/documents/')[1]);
        if (write.currentDocument?.exists === false ? existing : write.currentDocument?.updateTime !== existing?.updateTime) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 412 });
      }
      calls.commits.push(targets); apply(writes);
      if (failNext === 'lost') { failNext = ''; throw new Error('synthetic lost response'); }
      return Response.json({ writeResults: targets.map(key => ({ updateTime: docs.get(key).updateTime })) });
    }
    assert.equal(options.method || 'GET', 'GET', `unexpected Firestore ${options.method} ${path}`);
    if (!path.includes('/')) {
      calls.reads.push(`list:${path}`);
      if (brokenList) return Response.json({ documents: 'synthetic-malformed' });
      const size = pageSize || Number(url.searchParams.get('pageSize')), start = Number(url.searchParams.get('pageToken') || 0);
      const keys = [...docs.keys()].filter(key => key.startsWith(`${path}/`)).sort(), page = keys.slice(start, start + size);
      return Response.json({ ...(page.length ? { documents: page.map(body) } : {}), ...(start + size < keys.length ? { nextPageToken: String(start + size) } : {}) });
    }
    calls.reads.push(path);
    return docs.has(path) ? Response.json(body(path)) : Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
  }
  return { docs, calls, put, fetcher, get: path => structuredClone(docs.get(path)?.data ?? null), revision: path => docs.get(path)?.updateTime || '', failNextCommit: mode => { failNext = mode; }, breakList: () => { brokenList = true; }, storage: target => ({ ...crewProfileStorage(target, fetcher), roster: async () => structuredClone(ROSTER) }) };
}

// A private-Drive stand-in with the field photo client's surface (allocate, metadata, upload, image).
function drive(files = {}) {
  const saved = new Map(Object.entries(files)), calls = { allocate: 0, upload: 0, metadata: 0, image: 0 };
  let next = 0, failUploads = 0;
  const client = {
    async allocate() { calls.allocate++; return `synthetic-drive-canary-new-${++next}`; },
    async metadata(id) { calls.metadata++; const file = saved.get(id); return file ? { id, size: String(file.bytes.length), mimeType: file.mime, appProperties: file.appProperties, trashed: false } : null; },
    async upload(id, jobId, requestId, picture) {
      calls.upload++;
      if (failUploads) { failUploads--; throw Object.assign(new Error('The photo upload did not finish. Retry this photo to verify or complete it.'), { status: 503, code: 'FIELD_PHOTO_UPLOAD_FAILED' }); }
      saved.set(id, { bytes: picture.bytes, mime: picture.mime, appProperties: { egcJobId: jobId, egcFieldRequestId: requestId } });
    },
    async image(id) { calls.image++; const file = saved.get(id); return new Response(file.bytes, { headers: { 'Content-Type': file.mime } }); },
  };
  return { saved, calls, client, photos: async () => client, failUploads: count => { failUploads = count; } };
}
const headshot = (key, requestId, bytes = JPEG) => ({ bytes, mime: 'image/jpeg', appProperties: { egcJobId: crewPhotoOwner(key), egcFieldRequestId: requestId } });

function noNetwork(t) { t.mock.method(globalThis, 'fetch', async input => assert.fail(`unexpected network request to ${input}`)); }
const staffApi = (fs, files, who, at = NOW) => crewPublicProfileHandlers({ session: async () => who, storage: fs.storage, photos: files.photos, now: () => new Date(at) });
async function post(handlers, body, headers = {}, raw) {
  const response = await handlers.post({ env, request: new Request(`${ORIGIN}/api/crew-public-profile`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const get = (handlers, search = '', headers = {}) => handlers.get({ env, request: new Request(`${ORIGIN}/api/crew-public-profile${search}`, { headers: { Origin: ORIGIN, ...headers } }) });
const change = (fs, action, username, extra = {}) => ({ action, requestId: uuid(), username, expectedRevision: fs.revision(`${CREW_PROFILES}/${username}`), ...extra });
const customerProxy = (fs, files, jobs, at = NOW) => createCustomerCrewPhotoHandlers({ now: () => new Date(at), read: reader(jobs), storage: fs.storage, photos: files.photos });
async function photoRequest(handlers, url, cookie, headers = {}) {
  return handlers.onRequestGet({ env, request: new Request(`${ORIGIN}${url}`, { headers: { Cookie: cookie, Referer: `${ORIGIN}/customer-portal`, ...headers } }) });
}

test('the customer allowlist is an active profile with one valid first name and only an approved photo', () => {
  assert.equal(publicCrewProfile({ firstName: 'Dana', active: false }), null, 'an inactive profile is hidden');
  assert.equal(publicCrewProfile({ firstName: 'Dana Canarylast', active: true }), null, 'a stored surname never reaches customers');
  assert.equal(publicCrewProfile({ firstName: '', active: true }), null);
  assert.equal(publicCrewProfile({ firstName: 'Dana', active: 'true' }), null);
  assert.deepEqual(publicCrewProfile({ firstName: ' Mary-Ann ', active: true, lastName: 'Canarylast', phone: '9705550199' }), { firstName: 'Mary-Ann', photo: null });
  const unapproved = { fileId: 'synthetic-drive-canary-9', requestId: PHOTO_ONE, uploadedAt: NOW };
  assert.equal(publicCrewProfile({ firstName: 'Dana', active: true, photo: unapproved }).photo, null, 'a photo without an approval is not a customer photo');
  assert.equal(publicCrewProfile({ firstName: 'Dana', active: true, pendingPhoto: approvedPhoto(PHOTO_ONE, 'x') }).photo, null, 'a pending photo is never shown');
  assert.equal(publicCrewProfile({ firstName: 'Dana', active: true, photo: approvedPhoto(PHOTO_ONE, 'synthetic-drive-canary-1') }).photo.fileId, 'synthetic-drive-canary-1');
});

const savedProfiles = () => new Map(Object.entries(profiles()).map(([path, row]) => [path.split('/')[1], row]));

test('the portal crew projection shows first names of assigned, active crew with the lead first and an on-the-way note', () => {
  const saved = savedProfiles(), at = new Date(NOW);
  const result = customerCrewProjection(JOB, saved, new Map([['crew.one', '/api/customer-crew-photo?u=signed']]), at);
  assert.deepEqual(result, { crew: [{ firstName: 'Riley', photoUrl: '', lead: true }, { firstName: 'Dana', photoUrl: '/api/customer-crew-photo?u=signed', lead: false }], onTheWay: { at: '2026-09-22T15:42:00.000Z', leadFirstName: 'Riley' } });
  for (const canary of CANARIES) assert.doesNotMatch(JSON.stringify(result), new RegExp(canary.replace('.', '\\.')), canary);
  assert.equal(customerCrewProjection({ ...JOB, assignedCrew: ['crew.one', 'crew.three'] }, saved, new Map(), at).crew.length, 1, 'an inactive assigned profile is hidden');
  assert.equal(customerCrewProjection({ ...JOB, status: 'arrived', pipelineStatus: 'arrived', fieldExecution: { activity: 'arrived' } }, saved, new Map(), at).onTheWay, null);
  assert.equal(customerCrewProjection({ ...JOB, fieldExecution: { activity: 'delayed', activityAt: NOW } }, saved, new Map(), at).onTheWay, null, 'only an en-route activity is "on the way"');
  // Deliberately changed with the freshness rule: without a readable departure time the job's service date must be today.
  assert.deepEqual(customerCrewProjection({ ...JOB, date: '2026-09-22', crewLead: null, fieldExecution: { activity: 'dispatched', activityAt: 'not-a-time' } }, saved, new Map(), at).onTheWay, { at: '', leadFirstName: '' });
  assert.equal(customerCrewProjection({ ...JOB, crewLead: null, fieldExecution: { activity: 'dispatched', activityAt: 'not-a-time' } }, saved, new Map(), at).onTheWay, null, 'no departure time and no service date cannot prove the crew is on the way now');
  assert.deepEqual(customerCrewProjection({ ...JOB, assignedCrew: [{ username: 'crew.one', name: 'Dana Canarylast' }], crewLead: { username: 'crew.one' } }, saved, new Map(), at).crew, [{ firstName: 'Dana', photoUrl: '', lead: true }]);
});

test('"on the way" is a same-day note: a stale, other-day, future-stamped or clockless read drops it', () => {
  const saved = savedProfiles(), note = (changes, at) => customerCrewProjection({ ...JOB, ...changes }, saved, new Map(), at === undefined ? undefined : new Date(at)).onTheWay;
  const left = departed => ({ fieldExecution: { activity: 'dispatched', activityAt: departed } });
  // JOB left at 15:42Z, 9:42 AM in Denver on 2026-09-22.
  assert.deepEqual(note({ date: '2026-09-22' }, '2026-09-23T03:41:00.000Z'), { at: '2026-09-22T15:42:00.000Z', leadFirstName: 'Riley' }, '9:41 PM the same Denver day, just under 12 hours later');
  assert.equal(note({}, '2026-09-23T03:43:00.000Z'), null, 'more than 12 hours after the departure');
  assert.equal(note({ date: '2026-09-22', ...left('2026-09-23T05:30:00.000Z') }, '2026-09-23T06:30:00.000Z'), null, 'past Denver midnight the service day is over, even an hour after leaving');
  assert.equal(note({ date: '2026-09-22', ...left('2026-09-22T05:30:00.000Z') }, '2026-09-22T14:00:00.000Z'), null, 'a departure stamped the evening before the service date is not today’s trip');
  assert.equal(note({ date: '2026-09-21', ...left('') }, NOW), null, 'a job left dispatched since yesterday, with no departure time');
  assert.equal(note({}, '2026-09-22T15:30:00.000Z'), null, 'a departure more than five minutes in the future is not trusted');
  assert.equal(note({}, '2026-09-22T15:40:00.000Z')?.at, '2026-09-22T15:42:00.000Z', 'small clock skew is tolerated');
  assert.equal(note(left('2026-13-01T15:42:00.000Z'), NOW), null, 'an impossible instant is no departure time');
  assert.equal(note({ date: '2026-09-22' }, 'not-a-date'), null, 'an unreadable read time fails closed');
  assert.equal(note({ date: '2026-09-22' }), null, 'the read time must be injected');
});

test('signed crew photo links use the injected clock, stay stable within the hour and refuse expired, tampered, replaced or unassigned links', async t => {
  noNetwork(t);
  const fs = firestore(profiles()), read = (collection, id) => fs.storage(env).read(collection, id);
  const photo = fs.get(`${CREW_PROFILES}/crew.one`).photo, job = { ...JOB, id: 'job-1' };
  const url = await crewPhotoLink(env, 'job-1', 'crew.one', photo, new Date(NOW));
  assert.equal(await crewPhotoLink(env, 'job-1', 'crew.one', photo, new Date('2026-09-22T18:59:59.000Z')), url, 'the portal refresh keeps one URL per hour');
  assert.notEqual(await crewPhotoLink(env, 'job-1', 'crew.one', photo, new Date('2026-09-22T19:00:00.000Z')), url);
  assert.match(url, /^\/api\/customer-crew-photo\?u=[A-Za-z0-9_-]{22}&exp=\d{10}&sig=[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(url, /crew\.one|synthetic-drive/);
  const params = Object.fromEntries(new URL(url, ORIGIN).searchParams), exp = Number(params.exp), now = Date.parse(NOW) / 1000;
  assert.ok(exp > now + 3600 && exp <= now + CREW_PHOTO_LINK_SECONDS, `expires 1–2 h after the read (${exp - now}s)`);
  const resolve = (overrides = {}, at = NOW, target = job) => resolveCustomerCrewPhoto(env, target, { ...params, ...overrides }, { read, now: new Date(at) });
  assert.deepEqual(await resolve(), { status: 'ok', key: 'crew.one', photo });
  assert.equal((await resolve({}, new Date(exp * 1000).toISOString())).status, 'invalid', 'expired');
  assert.equal((await resolve({ sig: flip(params.sig, 20) })).status, 'invalid', 'tampered signature');
  assert.equal((await resolve({ exp: String(exp + 3600) })).status, 'invalid', 'a later expiry is not signed');
  assert.equal((await resolve({ exp: String(now + 5 * 3600) })).status, 'invalid', 'a far-future expiry is refused outright');
  assert.equal((await resolve({ u: 'A'.repeat(22) })).status, 'missing', 'an unknown crew reference');
  assert.equal((await resolve({}, NOW, { ...job, id: 'job-2' })).status, 'missing', "another job's session cannot use this link");
  assert.equal((await resolve({}, NOW, { ...job, assignedCrew: ['crew.two'] })).status, 'missing', 'crew removed from the job');
  fs.put(`${CREW_PROFILES}/crew.one`, { ...fs.get(`${CREW_PROFILES}/crew.one`), photo: approvedPhoto(uuid(), 'synthetic-drive-canary-2') });
  assert.equal((await resolve()).status, 'invalid', 'a replaced photo invalidates older links at once');
  fs.put(`${CREW_PROFILES}/crew.one`, { ...fs.get(`${CREW_PROFILES}/crew.one`), photo: null, pendingPhoto: photo });
  assert.equal((await resolve()).status, 'missing', 'an unapproved photo is not linkable');
  assert.equal(await crewPhotoLink(env, 'job-1', 'crew.one', photo, new Date(NOW)).then(() => 'signed'), 'signed');
  await assert.rejects(crewPhotoLink({ ...env, HUB_SESSION_SECRET: 'short' }, 'job-1', 'crew.one', photo, new Date(NOW)), { code: 'purpose_key_unavailable' });
});

test('the portal DTO gains crew and onTheWay only behind the flag, never exposes names beyond first names, and survives a profile outage', async t => {
  noNetwork(t);
  const fs = firestore(profiles()), jobs = { 'job-1': JOB }, cookie = await portalCookie('job-1');
  const crewProfiles = (target, keys) => readCrewPublicProfiles(target, keys, { storage: fs.storage });
  const view = async (testEnv, deps = {}) => portalView(portalHandlers(NOW, { read: reader(jobs), crewProfiles, ...deps }), cookie, testEnv);
  const off = await view({ ...env, CREW_PUBLIC_PROFILES_ENABLED: '' });
  assert.equal(off.status, 200);
  assert.equal(Object.hasOwn(off.body, 'crew') || Object.hasOwn(off.body, 'onTheWay'), false, 'without the flag the DTO keeps its current shape');
  assert.deepEqual(fs.calls.reads, [], 'without the flag the portal reads no crew profile at all');
  const reads = fs.calls.reads.length;
  const on = await view(env);
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.crew.map(({ firstName, lead }) => ({ firstName, lead })), [{ firstName: 'Riley', lead: true }, { firstName: 'Dana', lead: false }]);
  assert.equal(on.body.crew[0].photoUrl, '', 'no approved photo, no link');
  assert.match(on.body.crew[1].photoUrl, /^\/api\/customer-crew-photo\?u=[A-Za-z0-9_-]{22}&exp=\d{10}&sig=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(on.body.onTheWay, { at: '2026-09-22T15:42:00.000Z', leadFirstName: 'Riley' });
  for (const canary of CANARIES) assert.doesNotMatch(JSON.stringify(on.body), new RegExp(canary.replace('.', '\\.')), `${canary} must never reach the portal`);
  assert.deepEqual(fs.calls.reads.slice(reads).sort(), [`${CREW_PROFILES}/crew.one`, `${CREW_PROFILES}/crew.two`], 'only the assigned crew are read, in one batch');
  const outage = await view(env, { crewProfiles: async () => { throw Object.assign(new Error('down'), { code: 'crew_profile_storage_unavailable' }); } });
  assert.equal(outage.status, 200, 'a profile outage never blocks the project');
  assert.deepEqual(outage.body.crew, []);
  assert.deepEqual(outage.body.onTheWay, { at: '2026-09-22T15:42:00.000Z', leadFirstName: '' });
  const other = await portalView(portalHandlers(NOW, { read: reader({ 'job-2': { ...JOB, assignedCrew: ['crew.three'], crewLead: 'crew.three' } }), crewProfiles }), await portalCookie('job-2'), env);
  assert.deepEqual(other.body.crew, [], 'an inactive profile is hidden from its own job too');
});

test('the customer photo proxy streams only an assigned, active, approved photo to that job’s own session, with no-store headers', async t => {
  noNetwork(t);
  const fs = firestore(profiles()), files = drive({ 'synthetic-drive-canary-1': headshot('crew.one', PHOTO_ONE), 'synthetic-drive-canary-3': headshot('crew.three', PHOTO_THREE) });
  const jobs = { 'job-1': JOB, 'job-2': { ...JOB, assignedCrew: ['crew.three'], crewLead: null } };
  const cookie = await portalCookie('job-1'), otherCookie = await portalCookie('job-2');
  const { crew: [, dana] } = await customerCrew(env, { ...JOB, id: 'job-1' }, { profiles: (target, keys) => readCrewPublicProfiles(target, keys, { storage: fs.storage }), now: new Date(NOW) });
  const proxy = customerProxy(fs, files, jobs);
  const response = await photoRequest(proxy, dana.photoUrl, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), JPEG);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  const images = files.calls.image;
  const refused = async (url, who, status, code) => { const result = await photoRequest(proxy, url, who); assert.equal(result.status, status, url); assert.equal(result.headers.get('Cache-Control'), 'no-store'); const body = await result.json(); if (code) assert.equal(body.code, code); assert.doesNotMatch(JSON.stringify(body), /synthetic-drive|crew\.one/); };
  await refused(dana.photoUrl, otherCookie, 404, 'CUSTOMER_PORTAL_CREW_PHOTO_NOT_FOUND');
  await refused(dana.photoUrl, '', 401, 'CUSTOMER_PORTAL_AUTH_REQUIRED');
  const tampered = flip(dana.photoUrl, dana.photoUrl.length - 20);
  await refused(tampered, cookie, 403, 'CUSTOMER_PORTAL_CREW_PHOTO_LINK_INVALID');
  await refused(`${dana.photoUrl}&extra=1`, cookie, 400, 'CUSTOMER_PORTAL_CREW_PHOTO_INVALID');
  await refused(dana.photoUrl.replace(/u=[^&]+/, 'u=' + 'B'.repeat(22)), cookie, 404);
  const later = customerProxy(fs, files, jobs, new Date(Date.parse(NOW) + 3 * 3600000).toISOString());
  const expired = await photoRequest(later, dana.photoUrl, await portalCookie('job-1', {}, Date.parse(NOW) + 3 * 3600000));
  assert.equal(expired.status, 403, 'an expired link is refused even with a valid session');
  const unassigned = customerProxy(fs, files, { 'job-1': { ...JOB, assignedCrew: ['crew.two'] } });
  assert.equal((await photoRequest(unassigned, dana.photoUrl, cookie)).status, 404, 'crew removed from the job');
  assert.equal(files.calls.image, images, 'no refused request reached Drive');
  const hidden = firestore({ ...profiles(), [`${CREW_PROFILES}/crew.one`]: { ...profiles()[`${CREW_PROFILES}/crew.one`], active: false } });
  assert.equal((await photoRequest(customerProxy(hidden, files, jobs), dana.photoUrl, cookie)).status, 404, 'an inactive profile is hidden');
  files.saved.set('synthetic-drive-canary-1', { ...headshot('crew.one', PHOTO_ONE), appProperties: { egcJobId: 'job-1', egcFieldRequestId: PHOTO_ONE } });
  assert.equal((await photoRequest(proxy, dana.photoUrl, cookie)).status, 404, 'a file that is not this profile’s own upload is never served');
  assert.equal((await photoRequest(proxy, dana.photoUrl, cookie, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const disabled = await createCustomerCrewPhotoHandlers({ now: () => new Date(NOW), read: reader(jobs), storage: fs.storage, photos: files.photos }).onRequestGet({ env: { ...env, CREW_PUBLIC_PROFILES_ENABLED: 'false' }, request: new Request(`${ORIGIN}${dana.photoUrl}`, { headers: { Cookie: cookie } }) });
  assert.equal(disabled.status, 404);
});

test('an employee uploads their own headshot as a pending photo that only a manager can approve; replays never upload twice', async t => {
  noNetwork(t);
  const fs = firestore(), files = drive(), own = staffApi(fs, files, crew);
  const upload = change(fs, 'upload_photo', 'crew.one', { dataUrl: dataUrl() });
  const first = await post(own, upload);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(first.body.profile.pendingPhoto.requestId, upload.requestId);
  assert.equal(first.body.profile.photo, null);
  assert.equal(first.body.profile.customerVisible, false);
  assert.equal(first.body.profile.firstName, 'Dana', 'a self-created profile suggests the first word of the display name only');
  assert.equal(files.calls.allocate, 1); assert.equal(files.calls.upload, 1);
  const saved = fs.get(`${CREW_PROFILES}/crew.one`);
  assert.equal(saved.active, false); assert.equal(saved.pendingUpload, null); assert.equal(saved.pendingPhoto.fileId, 'synthetic-drive-canary-new-1');
  assert.deepEqual(files.saved.get('synthetic-drive-canary-new-1').appProperties, { egcJobId: '_egc_crew_profile_crew.one', egcFieldRequestId: upload.requestId });
  assert.doesNotMatch(JSON.stringify(first.body), /synthetic-drive|fileId/, 'no Drive id leaves the server');
  const [claim] = fs.calls.commits;
  assert.deepEqual(claim.map(path => path.split('/')[0]).sort(), [CREW_PROFILES, 'hub_audit'], 'the Drive claim that creates the profile is audited in the same commit');
  const started = fs.get(claim.find(path => path.startsWith('hub_audit/')));
  assert.equal(started.action, 'crew_profile.upload_started'); assert.equal(started.before, null); assert.equal(started.requestId, upload.requestId);
  assert.deepEqual(JSON.parse(started.after), { firstName: 'Dana', active: false, photo: 'none', pendingPhoto: false, uploadInProgress: true });
  assert.doesNotMatch(JSON.stringify(started), /synthetic-drive|fileId/, 'the claim audit never stores the Drive id');
  const commits = fs.calls.commits.length;
  const again = await post(own, upload);
  assert.equal(again.status, 200); assert.equal(again.body.replayed, true);
  assert.equal(fs.calls.commits.length, commits, 'a replay writes nothing'); assert.equal(files.calls.upload, 1); assert.equal(files.calls.allocate, 1);
  assert.equal((await post(own, { ...upload, dataUrl: dataUrl(PNG, 'image/png') })).body.code, 'crew_profile_idempotency_conflict');
  const last = fs.calls.commits.at(-1);
  assert.deepEqual(last.map(path => path.split('/')[0]).sort(), [CREW_PROFILES, CREW_PROFILE_OPERATIONS, 'hub_audit'].sort(), 'profile, receipt and audit commit together');
  const audit = fs.get(last.find(path => path.startsWith('hub_audit/')));
  assert.equal(audit.action, 'crew_profile.upload_photo'); assert.equal(audit.actor.id, 'crew.one');
  assert.doesNotMatch(JSON.stringify(audit), /synthetic-drive|fileId/, 'the audit trail never stores Drive ids');
  const selfApprove = await post(own, change(fs, 'approve_photo', 'crew.one', { photoRequestId: upload.requestId }));
  assert.equal(selfApprove.status, 403); assert.equal(selfApprove.body.code, 'crew_profile_forbidden');
  assert.equal((await post(own, change(fs, 'set_profile', 'crew.one', { firstName: 'Dana', active: true }))).status, 403, 'crew cannot make themselves customer-visible');
  assert.equal((await post(own, change(fs, 'upload_photo', 'crew.two', { dataUrl: dataUrl() }))).status, 403, 'crew cannot upload for someone else');
  assert.equal((await post(staffApi(fs, files, sales), change(fs, 'approve_photo', 'crew.one', { photoRequestId: upload.requestId }))).status, 403, 'business access without a dispatcher role cannot approve');
  const boss = staffApi(fs, files, manager);
  const forTwo = change(fs, 'upload_photo', 'crew.two', { dataUrl: dataUrl(PNG, 'image/png') });
  const managed = await post(boss, forTwo);
  assert.equal(managed.status, 200, JSON.stringify(managed.body));
  assert.equal(managed.body.profile.pendingPhoto.requestId, forTwo.requestId, 'a manager can upload a headshot for another employee');
  assert.equal(managed.body.profile.photo, null); assert.equal(managed.body.profile.firstName, '', 'a manager upload never guesses another person’s customer name');
  const twoPhoto = fs.get(`${CREW_PROFILES}/crew.two`).pendingPhoto;
  assert.deepEqual(files.saved.get(twoPhoto.fileId).appProperties, { egcJobId: '_egc_crew_profile_crew.two', egcFieldRequestId: forTwo.requestId });
  assert.equal(twoPhoto.uploadedBy, 'tylerg');
  assert.deepEqual(fs.calls.commits.slice(-2).map(paths => fs.get(paths.find(path => path.startsWith('hub_audit/'))).actor.id), ['tylerg', 'tylerg']);
  assert.equal((await post(boss, change(fs, 'approve_photo', 'crew.one', { photoRequestId: uuid() }))).body.code, 'crew_profile_photo_changed', 'a manager approves exactly the photo reviewed');
  const approve = await post(boss, change(fs, 'approve_photo', 'crew.one', { photoRequestId: upload.requestId }));
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal(approve.body.profile.photo.approvedBy, 'tylerg'); assert.equal(approve.body.profile.pendingPhoto, null);
  assert.equal(approve.body.profile.customerVisible, false, 'approval alone does not show a profile');
  assert.equal((await post(boss, change(fs, 'set_profile', 'crew.one', { firstName: 'Dana Canarylast', active: true }))).body.code, 'crew_profile_first_name_invalid');
  assert.equal((await post(boss, change(fs, 'set_profile', 'crew.one', { firstName: '', active: true }))).body.code, 'crew_profile_first_name_required');
  const stale = { ...change(fs, 'set_profile', 'crew.one', { firstName: 'Dana', active: true }), expectedRevision: '2026-09-22T12:00:00.000001Z' };
  const conflict = await post(boss, stale);
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'crew_profile_revision_conflict'); assert.equal(conflict.body.details.currentRevision, fs.revision(`${CREW_PROFILES}/crew.one`));
  const shown = await post(boss, change(fs, 'set_profile', 'crew.one', { firstName: 'Dana', active: true }));
  assert.equal(shown.body.profile.customerVisible, true);
  assert.deepEqual(publicCrewProfile(fs.get(`${CREW_PROFILES}/crew.one`)).firstName, 'Dana');
  const removed = await post(own, change(fs, 'remove_photo', 'crew.one'));
  assert.equal(removed.status, 200); assert.equal(removed.body.profile.photo, null);
  assert.equal((await post(own, change(fs, 'remove_photo', 'crew.one'))).body.code, 'crew_profile_nothing_to_remove');
});

test('a lost Drive or Firestore answer resumes the same upload with the same Drive file and never duplicates it', async t => {
  noNetwork(t);
  const fs = firestore(), files = drive(), own = staffApi(fs, files, crew);
  const upload = change(fs, 'upload_photo', 'crew.one', { dataUrl: dataUrl() });
  files.failUploads(1);
  const failed = await post(own, upload);
  assert.equal(failed.status, 503); assert.equal(failed.body.code, 'crew_profile_photo_storage_unavailable');
  assert.equal(fs.get(`${CREW_PROFILES}/crew.one`).pendingUpload.requestId, upload.requestId, 'the Drive claim is saved before any bytes are sent');
  assert.equal(files.calls.allocate, 1);
  fs.failNextCommit('lost');
  const recovered = await post(own, upload);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.replayed, false, 'the committed receipt proves the lost save');
  assert.equal(files.calls.allocate, 1, 'the retry reuses the saved Drive file id'); assert.equal(files.calls.upload, 2);
  assert.equal(fs.get(`${CREW_PROFILES}/crew.one`).pendingPhoto.fileId, 'synthetic-drive-canary-new-1');
  const newer = change(fs, 'upload_photo', 'crew.one', { dataUrl: dataUrl(PNG, 'image/png') });
  const oldRevision = newer.expectedRevision;
  await post(own, { ...change(fs, 'remove_photo', 'crew.one') });
  const late = await post(own, { ...newer, expectedRevision: oldRevision });
  assert.equal(late.body.code, 'crew_profile_revision_conflict', 'an upload started before a removal cannot resurrect the photo');
  assert.equal((await post(own, { ...upload, dataUrl: dataUrl(PNG, 'image/png') })).body.code, 'crew_profile_idempotency_conflict', 'the same upload ID with another photo');
  assert.equal((await post(own, { ...upload, dataUrl: 'data:image/gif;base64,R0lGODlh' })).body.code, 'crew_profile_photo_invalid', 'unsupported images are refused before anything is read or written');
  const invalid = await post(own, change(fs, 'upload_photo', 'crew.one', { dataUrl: 'data:image/jpeg;base64,AAAAAAAAAAAAAAAA' }));
  assert.equal(invalid.status, 400); assert.equal(invalid.body.code, 'crew_profile_photo_invalid');
});

test('staff GETs: own profile for crew, the roster for managers, pending photos only for the owner or a manager, never a Drive id', async t => {
  noNetwork(t);
  const seed = profiles(); seed[`${CREW_PROFILES}/crew.two`].pendingPhoto = { fileId: 'synthetic-drive-canary-2', requestId: PHOTO_THREE, mime: 'image/jpeg', bytes: JPEG.length, uploadedAt: NOW, uploadedBy: 'crew.two' };
  const fs = firestore(seed), files = drive({ 'synthetic-drive-canary-1': headshot('crew.one', PHOTO_ONE), 'synthetic-drive-canary-2': headshot('crew.two', PHOTO_THREE) });
  const mine = await (await get(staffApi(fs, files, crewTwo))).json();
  assert.deepEqual(mine.viewer, { username: 'crew.two', manager: false });
  assert.deepEqual(mine.profiles.map(row => row.username), ['crew.two']);
  assert.equal(mine.profiles[0].pendingPhoto.url, `/api/crew-public-profile?photo=crew.two&state=pending&v=${PHOTO_THREE}`);
  const roster = await (await get(staffApi(fs, files, manager))).json();
  // Deliberately extended: stored profiles of people no longer on the roster are listed too, marked onRoster:false.
  assert.deepEqual(roster.profiles.map(row => [row.username, row.onRoster]), [['crew.one', true], ['crew.two', true], ['tylerg', true], ['crew.three', false]]);
  assert.equal(mine.profiles[0].onRoster, null, 'an employee’s own view never reads or reveals the roster');
  assert.equal(roster.customerProfilesEnabled, true);
  assert.equal(roster.profiles.find(row => row.username === 'crew.one').displayName, 'Dana Canarylast', 'staff see the roster name; customers never do');
  for (const body of [mine, roster]) assert.doesNotMatch(JSON.stringify(body), /synthetic-drive|fileId|hourlyRate|9705550199/);
  assert.equal((await get(staffApi(fs, files, crew), '?username=crew.two')).status, 403);
  assert.equal((await (await get(staffApi(fs, files, manager), '?username=crew.two')).json()).profile.pendingPhoto.requestId, PHOTO_THREE);
  const approved = await get(staffApi(fs, files, crewTwo), `?photo=crew.one&v=${PHOTO_ONE}`);
  assert.equal(approved.status, 200, 'approved photos are visible to any signed-in staff (dispatch avatars)');
  assert.equal(approved.headers.get('Cache-Control'), 'private, no-store'); assert.equal(approved.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.deepEqual(new Uint8Array(await approved.arrayBuffer()), JPEG);
  assert.equal((await get(staffApi(fs, files, crew), '?photo=crew.two&state=pending')).status, 403, 'another crew member’s pending photo');
  assert.equal((await get(staffApi(fs, files, crewTwo), '?photo=crew.two&state=pending')).status, 200);
  assert.equal((await get(staffApi(fs, files, manager), '?photo=crew.two&state=pending')).status, 200);
  assert.equal((await get(staffApi(fs, files, crew), '?photo=crew.two')).status, 404, 'no approved photo yet');
  assert.equal((await get(staffApi(fs, files, crew), '?photo=crew.one&photo=crew.two')).status, 400);
  assert.equal((await get(staffApi(fs, files, null))).status, 401);
  assert.equal((await get(staffApi(fs, files, crew), '', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  files.saved.set('synthetic-drive-canary-1', { ...headshot('crew.one', PHOTO_ONE), appProperties: { egcJobId: 'job-1', egcFieldRequestId: PHOTO_ONE } });
  assert.equal((await get(staffApi(fs, files, crew), '?photo=crew.one')).status, 404, 'a field photo id stored on a profile is never served');
});

test('a manager still sees someone who left the roster, can hide them and clear their photo, and cannot show them again', async t => {
  noNetwork(t);
  const seed = profiles(), PENDING = uuid();
  seed[`${CREW_PROFILES}/crew.three`] = { ...seed[`${CREW_PROFILES}/crew.three`], active: true, pendingPhoto: { fileId: 'synthetic-drive-canary-4', requestId: PENDING, mime: 'image/jpeg', bytes: JPEG.length, uploadedAt: NOW, uploadedBy: 'crew.three' } };
  seed[`${CREW_PROFILES}/Not-A-Username`] = { username: 'Not-A-Username', firstName: 'Stray', active: true };
  const fs = firestore(seed, { pageSize: 2 }), files = drive(), boss = staffApi(fs, files, manager);
  const overview = await (await get(boss)).json();
  assert.equal(fs.calls.reads.filter(read => read === `list:${CREW_PROFILES}`).length, 2, 'every page of stored profiles is read');
  const departed = overview.profiles.find(row => row.username === 'crew.three');
  assert.deepEqual({ onRoster: departed.onRoster, customerVisible: departed.customerVisible, displayName: departed.displayName, photo: Boolean(departed.photo), pending: departed.pendingPhoto.requestId }, { onRoster: false, customerVisible: true, displayName: '', photo: true, pending: PENDING });
  assert.deepEqual(overview.profiles.map(row => row.username), ['crew.one', 'crew.two', 'tylerg', 'crew.three'], 'a stored id that is not a username is never listed');
  assert.doesNotMatch(JSON.stringify(overview), /synthetic-drive|fileId/);
  const refused = async (body, what) => { const result = await post(boss, body); assert.equal(result.status, 409, what); assert.equal(result.body.code, 'crew_profile_not_on_roster', what); };
  const commits = fs.calls.commits.length;
  await refused(change(fs, 'set_profile', 'crew.three', { firstName: 'Hidden', active: true }), 'showing them to customers');
  await refused(change(fs, 'approve_photo', 'crew.three', { photoRequestId: PENDING }), 'approving their photo');
  assert.equal(fs.calls.commits.length, commits, 'a refused change writes nothing');
  const hidden = await post(boss, change(fs, 'set_profile', 'crew.three', { firstName: 'Hidden', active: false }));
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body)); assert.equal(hidden.body.profile.customerVisible, false);
  const cleared = await post(boss, change(fs, 'remove_photo', 'crew.three'));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body)); assert.equal(cleared.body.profile.photo, null); assert.equal(cleared.body.profile.pendingPhoto, null);
  assert.equal(publicCrewProfile(fs.get(`${CREW_PROFILES}/crew.three`)), null, 'nothing of theirs reaches a customer any more');
  const after = (await (await get(boss)).json()).profiles.find(row => row.username === 'crew.three');
  assert.deepEqual([after.onRoster, after.active, after.photo, after.pendingPhoto], [false, false, null, null]);
  fs.breakList();
  const broken = await get(boss);
  assert.equal(broken.status, 503, 'an unreadable profile listing never shows a partial roster');
  assert.equal((await broken.json()).code, 'crew_profile_storage_unavailable');
  const mine = await (await get(staffApi(fs, files, crewTwo))).json();
  assert.deepEqual(mine.profiles.map(row => row.username), ['crew.two'], 'an employee’s own view does not list profiles at all');
  const outage = crewPublicProfileHandlers({ session: async () => manager, storage: target => ({ ...fs.storage(target), roster: async () => { throw Object.assign(new Error('down'), { code: 'crew_profile_roster_unavailable', status: 503 }); } }), photos: files.photos, now: () => new Date(NOW) });
  const unverified = await post(outage, change(fs, 'set_profile', 'crew.one', { firstName: 'Dana', active: true }));
  assert.equal(unverified.status, 503, 'showing a profile fails closed when the roster cannot be read'); assert.equal(unverified.body.code, 'crew_profile_roster_unavailable');
});

test('POST boundaries: same origin, JSON only, size caps, whitelisted fields and a signed-in session', async t => {
  noNetwork(t);
  const fs = firestore(), files = drive(), own = staffApi(fs, files, crew);
  assert.equal((await post(own, change(fs, 'remove_photo', 'crew.one'), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(own, change(fs, 'remove_photo', 'crew.one'), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(own, null, { 'Content-Length': String(10 * 1024 * 1024) }, '{}')).status, 413);
  assert.equal((await post(own, null, {}, '{not json')).body.code, 'crew_profile_json_invalid');
  assert.equal((await post(own, { ...change(fs, 'remove_photo', 'crew.one'), role: 'owner' })).body.code, 'crew_profile_request_invalid');
  assert.equal((await post(own, { ...change(fs, 'remove_photo', 'crew.one'), requestId: 'not-a-uuid' })).body.code, 'crew_profile_request_invalid');
  assert.equal((await post(own, change(fs, '__proto__', 'crew.one'))).body.code, 'crew_profile_action_invalid');
  assert.equal((await post(own, change(fs, 'remove_photo', '../crew.two'))).body.code, 'crew_profile_username_invalid');
  assert.equal((await post(staffApi(fs, files, null), change(fs, 'remove_photo', 'crew.one'))).status, 401);
  assert.equal(fs.calls.commits.length, 0);
});

test('dispatch roster rows gain approved staff photo links read alongside the job scan, and a profile outage leaves the roster as it was', async t => {
  noNetwork(t);
  const fs = firestore(profiles()), events = [];
  const readMany = async (collection, ids) => { events.push(`profiles ${collection} ${ids.join(',')}`); return fs.storage(env).readMany(ids.filter(() => collection === CREW_PROFILES)); };
  // The job scan resolves on a later turn of the event loop than the roster, like a real multi-page scan.
  const board = (extra = {}) => ({ jobs: async () => { await new Promise(resolve => setImmediate(resolve)); events.push('jobs scanned'); return []; }, resources: async () => [], roster: async () => structuredClone(ROSTER), settings: async () => ({}), readMany, ...extra });
  const dispatch = (store, search = '?startDate=2026-09-22&endDate=2026-09-29') => dispatchHandlers({ session: async () => manager, storage: () => store, travel: () => ({ enabled: false }), now: () => new Date(NOW) }).get({ env, request: new Request(`${ORIGIN}/api/dispatch${search}`) }).then(response => response.json());
  const body = await dispatch(board());
  assert.equal(body.ok, true);
  assert.deepEqual(events, [`profiles ${CREW_PROFILES} crew.one,crew.two,tylerg`, 'jobs scanned'], 'the one profile batchGet starts with the roster, before the job scan finishes');
  assert.equal(body.roster.find(person => person.id === 'crew.one').photoUrl, `/api/crew-public-profile?photo=crew.one&v=${PHOTO_ONE}`);
  assert.equal(Object.hasOwn(body.roster.find(person => person.id === 'crew.two'), 'photoUrl'), false, 'no approved photo, no link');
  assert.doesNotMatch(JSON.stringify(body), /synthetic-drive|fileId/);
  const outage = await dispatch(board({ readMany: async () => { throw new Error('down'); } }));
  assert.equal(outage.ok, true); assert.deepEqual(outage.roster, ROSTER, 'an unreadable profile store leaves the roster unchanged');
  events.length = 0;
  const customers = await dispatch(board({ customers: async () => [] }), '?view=customers&q=synthetic');
  assert.equal(customers.ok, true); assert.deepEqual(events, [], 'views without a roster read no profiles');
  const wrapped = crewRosterPhotoStore({ roster: async () => ROSTER });
  assert.deepEqual(await wrapped.attach(await wrapped.store.roster()), ROSTER, 'a store without batch reads is left alone');
});

test('crew profile records are server-only, the crew photo page is staff-gated and its UI builds DOM without innerHTML', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of [CREW_PROFILES, CREW_PROFILE_OPERATIONS]) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`), collection);
  for (const path of ['/crew/profile-photo', '/crew/profile-photo.html', '/crew/profile-photo.js', '/crew/profile-photo.css']) assert.equal(staffGatedPath(path), true, path);
  const page = readFileSync(new URL('../crew/profile-photo.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML|outerHTML/, 'security invariant: the crew photo page renders with textContent only');
  assert.match(readFileSync(new URL('../crew/profile-photo.html', import.meta.url), 'utf8'), /<meta name="robots" content="noindex,nofollow">/);
});

test('portal crew helpers accept only signed links and show the departure time on the Denver clock', () => {
  const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8'), context = {};
  vm.runInNewContext(portalScript(html, ['function crewPhotoUrl(', 'function crewItems(', 'function onTheWayText(']), context);
  const signed = `/api/customer-crew-photo?u=${'a'.repeat(22)}&exp=1790000000&sig=${'b'.repeat(43)}`;
  assert.equal(context.crewPhotoUrl({ photoUrl: signed }), signed);
  for (const photoUrl of ['https://drive.google.com/file/d/synthetic', '/api/crew-public-profile?photo=crew.one', `${signed}&x=1`, 'javascript:alert(1)', 7]) assert.equal(context.crewPhotoUrl({ photoUrl }), '', String(photoUrl));
  assert.deepEqual(Array.from(context.crewItems({ crew: [{ firstName: 'Riley', lead: true, photoUrl: '' }, { firstName: '', lead: false }, { firstName: 'Dana' }, null, { firstName: 'x'.repeat(41), lead: false }] }), item => item.firstName), ['Riley']);
  assert.equal(context.crewItems({}).length, 0);
  assert.equal(context.onTheWayText({ onTheWay: { at: '2026-09-23T03:05:00.000Z', leadFirstName: 'Riley' } }), 'Riley and your crew are on the way — they left at 9:05 PM.', 'late evening in Denver, not UTC');
  assert.equal(context.onTheWayText({ onTheWay: { at: '', leadFirstName: '' } }), 'Your crew is on the way.');
  assert.equal(context.onTheWayText({ onTheWay: null }), '');
  for (const prefix of ['function renderCrew(', 'function crewMember(']) assert.doesNotMatch(html.split('\n').find(line => line.startsWith(prefix)), /innerHTML|insertAdjacentHTML|outerHTML/, prefix);
});
