import test from 'node:test';
import assert from 'node:assert/strict';
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
const uploadAgreement = user => agreements.onRequestPost({ env, request: request('agreement-upload', user, pdfBody) });

function fixture(t, initialJob = { assignedCrew: ['John.Smith'], assignedTo: 'John.Smith', type: 'job' }) {
  const state = { job: initialJob, unavailable: false, calls: [], uploads: [] };
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
    if (url.pathname === '/drive/v3/files') return Response.json({ files: [{ id: 'synthetic-folder' }] });
    if (url.pathname === '/upload/drive/v3/files') { state.uploads.push(options.body); return Response.json({ id: 'synthetic-upload' }); }
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
