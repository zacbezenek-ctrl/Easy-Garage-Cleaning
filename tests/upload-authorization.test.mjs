import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import * as photos from '../functions/api/drive-upload.js';
import * as agreements from '../functions/api/agreement-upload.js';

const users = {
  ZacB: { passwordHash: 'synthetic-hash', displayName: 'Synthetic Owner', role: 'owner' },
  TylerG: { passwordHash: 'synthetic-hash', displayName: 'Synthetic Manager', role: 'manager' },
  AlexK: { passwordHash: 'synthetic-hash', displayName: 'Synthetic Sales', role: 'sales' },
  'John.Smith': { passwordHash: 'synthetic-hash', displayName: 'Synthetic Crew', role: 'crew' },
  'John-Smith': { passwordHash: 'synthetic-hash', displayName: 'Other Crew', role: 'crew' },
  JohnSmith2: { passwordHash: 'synthetic-hash', displayName: 'Another Crew', role: 'crew' },
};
const env = {
  HUB_SESSION_SECRET: 'synthetic-upload-session-secret', HUB_AUTH_USERS_JSON: JSON.stringify(users),
  FIREBASE_API_KEY: 'firebase-test-upload-access', GOOGLE_CLIENT_ID: 'synthetic-client',
  GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', GOOGLE_REFRESH_TOKEN: 'synthetic-refresh',
};
const cookies = new Map(await Promise.all(Object.keys(users).map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const photoBody = { jobId: 'job-1', photos: [{ id: 'photo-1', tag: 'before', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSsoAAAAASUVORK5CYII=' }] };
const pdfBody = { jobId: 'unsaved-walkthrough', filename: 'Synthetic agreement.pdf', dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n' + 'synthetic pdf test data\n'.repeat(40)).toString('base64') };
const request = (route, user, body) => new Request('https://easygaragecleaning.com/api/' + route, {
  method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookies.get(user) || '', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const uploadPhoto = (user, body = photoBody, config = env) => photos.onRequestPost({ env: config, request: request('drive-upload', user, body) });
const uploadAgreement = (user, body = pdfBody) => agreements.onRequestPost({ env, request: request('agreement-upload', user, body) });
const jobKey = jobId => createHash('sha256').update(jobId).digest('hex').slice(0, 32);
const utf8 = text => Buffer.byteLength(text, 'utf8');

// Drive emulation: folders carry appProperties, list queries match on
// `appProperties has { key=… and value=… }` plus `'<id>' in parents`, and like
// Drive every property (key + value, UTF-8) is capped at 124 bytes.
function driveFolders(state) {
  const invalid = properties => Object.entries(properties || {}).some(([key, value]) => utf8(key) + utf8(value) > 124);
  const unquote = value => value.replace(/\\(.)/g, '$1');
  return {
    list(query) {
      const property = /appProperties has \{ key='((?:\\.|[^'])*)' and value='((?:\\.|[^'])*)' \}/.exec(query), parent = /'((?:\\.|[^'])*)' in parents/.exec(query);
      if (!property) throw new Error('Synthetic Drive only answers appProperties lookups');
      const [key, value] = [unquote(property[1]), unquote(property[2])];
      const found = state.folders.filter(folder => folder.appProperties?.[key] === value && (!parent || folder.parents.includes(unquote(parent[1]))));
      return Response.json({ files: found.slice(0, 1).map(folder => ({ id: folder.id, name: folder.name })) });
    },
    create(meta) {
      if (invalid(meta.appProperties)) return Response.json({ error: { code: 400, message: 'The limit for property key and value size is 124 bytes' } }, { status: 400 });
      const folder = { id: `synthetic-created-${state.folders.length}`, name: meta.name, parents: meta.parents || [], appProperties: meta.appProperties || {} };
      state.folders.push(folder);
      return Response.json({ id: folder.id });
    },
    upload(body) {
      const text = new TextDecoder().decode(body), meta = JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4, text.indexOf('\r\n--')));
      if (invalid(meta.appProperties)) return Response.json({ error: { code: 400 } }, { status: 400 });
      state.uploads.push(body); state.uploadMeta.push(meta);
      return Response.json({ id: 'synthetic-upload' });
    },
  };
}

function fixture(t, initialJob = { assignedCrew: ['John.Smith'], assignedTo: 'John.Smith', type: 'job' }, folders = [{ id: 'synthetic-folder', name: 'EGC Job Photos', parents: [], appProperties: { egcRoot: '1' } }]) {
  const state = { job: initialJob, unavailable: false, calls: [], uploads: [], uploadMeta: [], folders: structuredClone(folders) };
  const drive = driveFolders(state);
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    state.calls.push(url);
    if (url.hostname === 'firestore.googleapis.com') {
      if (url.pathname.endsWith('/documents:runQuery')) return Response.json([]);
      if (state.unavailable) return Response.json({}, { status: 503 });
      if (!state.job) return Response.json({}, { status: 404 });
      return Response.json({ name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-1', fields: encodeFirestoreFields(state.job) });
    }
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-access', expires_in: 3600 });
    if (url.pathname === '/drive/v3/files') return options.method === 'POST' ? drive.create(JSON.parse(options.body)) : drive.list(url.searchParams.get('q'));
    if (url.pathname === '/upload/drive/v3/files') return drive.upload(options.body);
    throw new Error('Unexpected synthetic request');
  });
  return state;
}

test('crew photo uploads require the exact assigned account before contacting Drive', async t => {
  const state = fixture(t);
  for (const user of ['John-Smith', 'JohnSmith2']) {
    assert.equal((await uploadPhoto(user)).status, 403, user);
  }
  assert.equal(state.calls.some(url => url.hostname !== 'firestore.googleapis.com'), false);
  const accepted = await uploadPhoto('John.Smith');
  assert.equal(accepted.status, 200);
  assert.equal(state.uploads.length, 1);
  assert.deepEqual((await accepted.json()).uploaded, ['photo-1']);
});

test('missing jobs and unavailable assignment storage never create crew photo folders', async t => {
  const state = fixture(t, null);
  assert.equal((await uploadPhoto('John.Smith')).status, 403);
  state.unavailable = true;
  assert.equal((await uploadPhoto('John.Smith')).status, 503);
  assert.equal(state.calls.some(url => url.hostname !== 'firestore.googleapis.com'), false);
  assert.equal(state.uploads.length, 0);
});

test('unique saved legacy crew names remain usable but duplicate names cannot authorize uploads', async t => {
  const state = fixture(t, { assignedCrew: ['Synthetic Crew'], type: 'job' });
  assert.equal((await uploadPhoto('John.Smith')).status, 200);
  const duplicate = { ...env, HUB_AUTH_USERS_JSON: JSON.stringify({ ...users, SomeoneElse: { passwordHash: 'synthetic-hash', displayName: 'Synthetic Crew', role: 'crew' } }) };
  assert.equal((await uploadPhoto('John.Smith', photoBody, duplicate)).status, 403);
  assert.equal(state.uploads.length, 1);
});

test('business users can save walkthrough photos before there is a saved job', async t => {
  const state = fixture(t, null);
  for (const user of ['ZacB', 'TylerG', 'AlexK']) {
    assert.equal((await uploadPhoto(user, { ...photoBody, jobId: 'unsaved-walkthrough' })).status, 200, user);
  }
  assert.equal(state.calls.some(url => url.hostname === 'firestore.googleapis.com'), false);
  assert.equal(state.uploads.length, 3);
});

test('signed customer agreements are restricted to business walkthrough users', async t => {
  const state = fixture(t, null);
  assert.equal((await uploadAgreement('')).status, 401);
  assert.equal((await uploadAgreement('John.Smith')).status, 403);
  assert.equal(state.calls.length, 0, 'denied agreements never contact Google');
  for (const user of ['ZacB', 'TylerG', 'AlexK']) assert.equal((await uploadAgreement(user)).status, 200, user);
  assert.equal(state.uploads.length, 3);
});

const driveQueries = state => state.calls.filter(url => url.pathname === '/drive/v3/files' && url.searchParams.has('q')).map(url => url.searchParams.get('q'));

test('photo job ids are validated in full and never truncated onto another job', async t => {
  const state = fixture(t);
  for (const jobId of ['../job-1', '..\\job-1', 'job\\1', "job'1", 'job-1/../../x', '_egc_schedule_lock_2026-09-22', 'secure_vault', 'x'.repeat(181)]) {
    for (const user of ['ZacB', 'John.Smith']) {
      const response = await uploadPhoto(user, { ...photoBody, jobId });
      assert.equal(response.status, 400, `${user}: ${jobId}`);
      assert.equal((await response.json()).error, 'A valid jobId is required');
    }
  }
  assert.equal(state.calls.length, 0, 'invalid ids never reach Firestore or Drive');
  const longId = 'j'.repeat(120) + '-' + 'k'.repeat(59);
  assert.equal(longId.length, 180);
  const crew = await uploadPhoto('John.Smith', { ...photoBody, jobId: longId });
  assert.equal(crew.status, 200);
  const firestore = state.calls.filter(url => url.hostname === 'firestore.googleapis.com' && !url.pathname.endsWith(':runQuery'));
  assert.deepEqual(firestore.map(url => decodeURIComponent(url.pathname.split('/').pop())), [longId], 'the assignment check reads the exact job');
  assert.equal(driveQueries(state).some(query => query.includes(`key='egcJobId'`)), false, 'a 180-character id cannot be a Drive property, so it is never looked up as one');
  assert.ok(driveQueries(state).some(query => query.includes(`key='egcJobKey' and value='${jobKey(longId)}'`)), 'the Drive folder lookup uses the digest of the exact job id');
  assert.deepEqual(state.folders.at(-1).appProperties, { egcJobKey: jobKey(longId) });
  assert.equal((await uploadPhoto('ZacB', { ...photoBody, jobId: ` ${longId} ` })).status, 200, 'surrounding whitespace is still trimmed');
  assert.equal(state.uploads.length, 2);
  assert.equal(state.folders.length, 2, 'the second upload reuses the job folder');
});

test('job folders fit Drive property limits, keep legacy folders and are never duplicated', async t => {
  const legacyId = 'legacy-job-7', legacy = { id: 'synthetic-legacy-folder', name: 'Old job', parents: ['synthetic-folder'], appProperties: { egcJobId: legacyId } };
  const state = fixture(t, null, [{ id: 'synthetic-folder', name: 'EGC Job Photos', parents: [], appProperties: { egcRoot: '1' } }, legacy]);
  const upload = async jobId => {
    const response = await uploadPhoto('ZacB', { ...photoBody, jobId });
    assert.equal(response.status, 200, jobId);
    return (await response.json()).folderId;
  };
  assert.equal(await upload(legacyId), 'synthetic-legacy-folder', 'a folder stamped before job keys existed is still found');
  assert.equal(state.folders.length, 2, 'no duplicate folder for a legacy job');

  const fits = 'f'.repeat(116), tooLong = 'g'.repeat(117);
  assert.equal(utf8('egcJobId') + fits.length, 124);
  const fitsFolder = await upload(fits);
  assert.deepEqual(state.folders.at(-1).appProperties, { egcJobKey: jobKey(fits), egcJobId: fits }, 'ids that fit keep the legacy property too');
  const longFolder = await upload(tooLong);
  assert.deepEqual(state.folders.at(-1).appProperties, { egcJobKey: jobKey(tooLong) }, 'one byte over the limit stamps only the key');
  const maxId = 'h'.repeat(180), maxFolder = await upload(maxId);
  assert.equal(state.folders.length, 5);
  for (const [jobId, folderId] of [[fits, fitsFolder], [tooLong, longFolder], [maxId, maxFolder], [legacyId, 'synthetic-legacy-folder']]) {
    assert.equal(await upload(jobId), folderId, `repeat uploads for ${jobId.length}-character ids reuse one folder`);
  }
  assert.equal(state.folders.length, 5, 'no duplicate folders');
  assert.equal(new Set(state.folders.map(folder => folder.appProperties.egcJobKey).filter(Boolean)).size, 3);
  for (const folder of state.folders) for (const [key, value] of Object.entries(folder.appProperties)) assert.ok(utf8(key) + utf8(value) <= 124, key);
});

test('customer agreements validate the full job id and stamp Drive-sized job properties', async t => {
  const state = fixture(t, null);
  for (const jobId of ['../job-1', 'job\\1', "job'1", '_egc_schedule_lock_2026-09-22', 'secure_vault', 'x'.repeat(181), 'j'.repeat(61) + '/x']) {
    const response = await uploadAgreement('ZacB', { ...pdfBody, jobId });
    assert.equal(response.status, 400, jobId);
    assert.equal((await response.json()).error, 'A valid jobId is required');
  }
  assert.equal(state.calls.length, 0, 'invalid agreement ids never reach Google');
  const longId = 'a'.repeat(60) + 'b'.repeat(120), sibling = 'a'.repeat(60) + 'c'.repeat(120);
  for (const jobId of [longId, sibling, 'unsaved-walkthrough']) assert.equal((await uploadAgreement('ZacB', { ...pdfBody, jobId })).status, 200, jobId);
  assert.deepEqual(state.uploadMeta.map(meta => meta.appProperties), [
    { egcJobKey: jobKey(longId) },
    { egcJobKey: jobKey(sibling) },
    { egcJobKey: jobKey('unsaved-walkthrough'), egcJobId: 'unsaved-walkthrough' },
  ], 'ids that share their first 60 characters stay distinct');
  const broken = await uploadAgreement('ZacB', { ...pdfBody, dataUrl: 'data:application/pdf;base64,%%%not-base64' });
  assert.equal(broken.status, 400, 'undecodable PDFs are a validation error, not a crash');
});

test('Drive folder queries escape backslashes and quotes', async t => {
  assert.equal(photos.driveQueryString(String.raw`a\'b`), String.raw`'a\\\'b'`);
  assert.equal(photos.driveQueryString(String.raw`trailing\\`), String.raw`'trailing\\\\'`);
  const state = fixture(t);
  assert.equal((await uploadPhoto('ZacB', { ...photoBody, jobId: 'unsaved-walkthrough' })).status, 200);
  const [root, job, keyed] = driveQueries(state);
  assert.equal(root, "mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='egcRoot' and value='1' }");
  assert.equal(job, "mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='egcJobId' and value='unsaved-walkthrough' } and 'synthetic-folder' in parents");
  assert.equal(keyed, `mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='egcJobKey' and value='${jobKey('unsaved-walkthrough')}' } and 'synthetic-folder' in parents`);
});

test('photo uploads grant no cross-origin access', async t => {
  const state = fixture(t);
  const foreign = await photos.onRequestOptions({ request: new Request('https://easygaragecleaning.com/api/drive-upload', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }) });
  assert.equal(foreign.status, 403);
  const own = await photos.onRequestOptions({ request: new Request('https://easygaragecleaning.com/api/drive-upload', { method: 'OPTIONS', headers: { Origin: 'https://easygaragecleaning.com' } }) });
  assert.equal(own.status, 204);
  assert.equal(own.headers.get('Access-Control-Allow-Origin'), null);
  const crossSite = await photos.onRequestPost({ env, request: new Request('https://easygaragecleaning.com/api/drive-upload', { method: 'POST', headers: { Cookie: cookies.get('ZacB'), 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify(photoBody) }) });
  assert.equal(crossSite.status, 403);
  for (const other of ['https://attacker.example', 'https://www.easygaragecleaning.com', 'https://easy-garage-cleaning.pages.dev', 'http://localhost:8788']) {
    const response = await photos.onRequestPost({ env, request: new Request('https://easygaragecleaning.com/api/drive-upload', { method: 'POST', headers: { Origin: other, Cookie: cookies.get('ZacB'), 'Content-Type': 'application/json' }, body: JSON.stringify(photoBody) }) });
    assert.equal(response.status, 403, other);
    assert.equal((await response.json()).code, 'DRIVE_UPLOAD_ORIGIN_FORBIDDEN');
  }
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', '']) {
    const response = await photos.onRequestPost({ env, request: new Request('https://easygaragecleaning.com/api/drive-upload', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', Cookie: cookies.get('ZacB'), 'Content-Type': type }, body: JSON.stringify(photoBody) }) });
    assert.equal(response.status, 415, type || 'missing');
    assert.equal((await response.json()).code, 'DRIVE_UPLOAD_JSON_REQUIRED');
  }
  assert.equal(state.calls.length, 0, 'refused requests never reach Firestore or Google');
  const accepted = await uploadPhoto('ZacB');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(state.uploads.length, 1);
});

test('agreement uploads grant no cross-origin access and require same-origin JSON', async t => {
  const state = fixture(t, null);
  const agreementRequest = headers => new Request('https://easygaragecleaning.com/api/agreement-upload', { method: 'POST', headers: { Cookie: cookies.get('ZacB'), ...headers }, body: JSON.stringify(pdfBody) });
  const foreign = await agreements.onRequestOptions({ request: new Request('https://easygaragecleaning.com/api/agreement-upload', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }) });
  assert.equal(foreign.status, 403);
  const own = await agreements.onRequestOptions({ request: new Request('https://easygaragecleaning.com/api/agreement-upload', { method: 'OPTIONS', headers: { Origin: 'https://easygaragecleaning.com' } }) });
  assert.equal(own.status, 204);
  assert.equal(own.headers.get('Access-Control-Allow-Origin'), null);
  for (const headers of [{ Origin: 'https://www.easygaragecleaning.com', 'Content-Type': 'application/json' }, { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, { Referer: 'https://attacker.example/x', 'Content-Type': 'application/json' }]) {
    assert.equal((await agreements.onRequestPost({ env, request: agreementRequest(headers) })).status, 403, JSON.stringify(headers));
  }
  const plain = await agreements.onRequestPost({ env, request: agreementRequest({ Origin: 'https://easygaragecleaning.com', 'Content-Type': 'text/plain' }) });
  assert.equal(plain.status, 415);
  assert.equal(state.calls.length, 0);
  const accepted = await uploadAgreement('ZacB');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(accepted.headers.get('X-Content-Type-Options'), 'nosniff');
});
