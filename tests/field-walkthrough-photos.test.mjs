// WALKTHROUGH-PHOTOS (#301): the estimator who recorded a job's in-person signature attaches the walkthrough reference
// photos they took (crew/gameplan-handoff.js photos) without being on the crew or a manager, and reaches nothing else of
// the job. Synthetic people and jobs only; Drive and Firestore are the in-memory fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { fieldJobsHandlers } from '../functions/api/field-jobs.js';
import { storage } from './helpers/field-fixture.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
const USERS = {
  ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Owner' },
  'Crew.One': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' },
  // A crew member the owner gave the Sales role in the Staff directory, and another estimator.
  'Sales.One': { passwordHash: 'test', role: 'crew', displayName: 'Estimator One', staffRoles: ['crew', 'sales'] },
  'Sales.Two': { passwordHash: 'test', role: 'crew', displayName: 'Estimator Two', staffRoles: ['crew', 'sales'] },
};
// EGC_STAFF_ROLE_PERMISSIONS is a launch default (functions/_lib/launch-defaults.js); handlers called directly see only this env.
const env = { HUB_SESSION_SECRET: 'field-walkthrough-photo-secret', FIREBASE_API_KEY: 'firebase-test-walkthrough-photos', HUB_AUTH_USERS_JSON: JSON.stringify(USERS),
  GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test', EGC_STAFF_ROLE_PERMISSIONS: 'true' };
const cookies = new Map(await Promise.all(Object.keys(USERS).map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const NOW = new Date('2026-09-22T15:00:00.000Z');
const picture = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]).toString('base64')}`;
const uuid = () => crypto.randomUUID();

// The job a walkthrough signature saved: Crew One staffed, the estimator recorded the homeowner's signature.
const signedJob = (acceptance = {}) => ({ id: 'job-1', type: 'job', customer: 'Synthetic Customer', address: '1 Synthetic Way', phone: '9705550100', date: '2026-09-22', time: '08:00', endTime: '11:00',
  assignedCrew: ['Crew.One'], crewLead: 'Crew.One', status: 'scheduled', pipelineStatus: 'scheduled', total: 1500, internalNotes: 'Synthetic management note', sourceWalkthroughId: 'walk-1',
  acceptance: { acceptedAt: '2026-09-21T17:00:00.000Z', acceptedBy: 'Synthetic Customer', method: 'in_person_signature', signatureCaptured: true, recordedBy: 'Sales.One', recordedAt: '2026-09-21T17:00:01.000Z', ...acceptance } });

function api(t, job, { handlerEnv = env, now = NOW } = {}) {
  const store = storage(t), route = fieldJobsHandlers({ now: () => now });
  store.put('jobs/job-1', job);
  const request = (user, body, search = '') => new Request(`${ORIGIN}/api/field-jobs${search}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookies.get(user), Origin: ORIGIN, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const call = async (user, body, search = '') => { const response = await (body ? route.post : route.get)({ env: handlerEnv, request: request(user, body, search) }); return { status: response.status, body: await response.json().catch(() => null) }; };
  // The body crew/gameplan-handoff.js photos() sends for each walkthrough photo.
  const photo = (user, extra = {}) => ({ action: 'photo', jobId: 'job-1', requestId: uuid(), expectedRevision: store.revision('job-1'), expectedUser: user, category: 'walkthrough', caption: 'Walkthrough reference — confirm conditions on arrival.', dataUrl: picture, ...extra });
  return { store, call, photo };
}

test('the estimator who recorded the signature reads only the photo view and attaches walkthrough photos once', async t => {
  const { store, call, photo } = api(t, signedJob());
  const read = await call('Sales.One', null, '?jobId=job-1');
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body, { ok: true, job: { id: 'job-1', expectedRevision: store.revision('job-1'), photos: [] }, photosAvailable: true, timezone: 'America/Denver' });
  const body = photo('Sales.One'), saved = await call('Sales.One', body);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.job.photos, [{ id: body.requestId, category: 'walkthrough' }], 'the upload check in crew/gameplan-handoff.js finds its photo');
  assert.equal(JSON.stringify(saved.body).includes('Synthetic'), false, 'no customer, crew or management detail in the answer');
  const job = store.get('jobs/job-1');
  assert.deepEqual(job.fieldExecution.photos.map(row => [row.id, row.category, row.actorId, row.verified]), [[body.requestId, 'walkthrough', 'Sales.One', true]]);
  assert.equal(job.photoSyncStatus, 'verified_in_job');
  assert.equal(store.calls.uploads, 1);
  const replay = await call('Sales.One', body);
  assert.deepEqual([replay.status, replay.body.alreadyApplied, replay.body.job.photos.length, store.calls.uploads], [200, true, 1, 1], 'a retried upload is the same photo');
  // The crew on the job sees it with their job.
  const crew = await call('Crew.One', null, '?jobId=job-1');
  assert.deepEqual(crew.body.job.photos.map(row => [row.id, row.category]), [[body.requestId, 'walkthrough']]);
});

test('the signer reaches nothing else of the job: other photos, notes, images and the timer stay with the crew', async t => {
  const { store, call, photo } = api(t, signedJob());
  for (const extra of [{ category: 'before' }, { category: 'after' }, { category: 'storage', bin: 'A1', items: 'Synthetic bin' }]) {
    const refused = await call('Sales.One', photo('Sales.One', extra));
    assert.deepEqual([refused.status, refused.body.code], [403, 'FIELD_JOB_NOT_ASSIGNED'], extra.category);
  }
  const note = await call('Sales.One', { action: 'note', jobId: 'job-1', requestId: uuid(), expectedRevision: store.revision('job-1'), body: 'Synthetic note' });
  assert.deepEqual([note.status, note.body.code], [403, 'FIELD_JOB_NOT_ASSIGNED']);
  const saved = await call('Sales.One', photo('Sales.One'));
  assert.equal(saved.status, 200);
  for (const search of [`?jobId=job-1&photoId=${saved.body.job.photos[0].id}`, '?jobId=job-1&view=timer']) assert.equal((await call('Sales.One', null, search)).status, 403, search);
  assert.equal(store.calls.uploads, 1);
});

test('nobody else gains it: another estimator, the crew, a signer without the Sales role, or a quote approved online', async t => {
  const { store, call, photo } = api(t, signedJob());
  const other = await call('Sales.Two', photo('Sales.Two'));
  assert.deepEqual([other.status, other.body.code], [403, 'FIELD_JOB_NOT_ASSIGNED']);
  assert.equal((await call('Sales.Two', null, '?jobId=job-1')).status, 403);
  const crew = await call('Crew.One', photo('Crew.One'));
  assert.deepEqual([crew.status, crew.body.code], [403, 'FIELD_REFERENCE_PHOTO_MANAGER_REQUIRED'], 'the crew on the job still cannot add walkthrough photos');
  assert.equal(store.calls.uploads, 0);
  assert.equal((await call('ZacB', photo('ZacB'))).status, 200, 'a manager still can');

  // Staff role permissions off: a crew account's stored Sales role grants nothing, so it no longer runs walkthroughs.
  const legacy = api(t, signedJob(), { handlerEnv: { ...env, EGC_STAFF_ROLE_PERMISSIONS: 'false' } });
  assert.equal((await legacy.call('Sales.One', legacy.photo('Sales.One'))).status, 403);
  assert.equal((await legacy.call('Sales.One', null, '?jobId=job-1')).status, 403);
  // The signature is the estimator's only when they recorded it in person.
  const online = api(t, signedJob({ method: 'portal_approval' }));
  assert.equal((await online.call('Sales.One', online.photo('Sales.One'))).status, 403);
  // A revision another estimator signed moves the right to them.
  const revised = api(t, signedJob({ recordedBy: 'Sales.Two', firstRecordedBy: 'Sales.One' }));
  assert.equal((await revised.call('Sales.One', revised.photo('Sales.One'))).status, 403);
  assert.equal((await revised.call('Sales.Two', revised.photo('Sales.Two'))).status, 200);
});

// The multi-day rule (requireWorkday) wants the uploader on the job's crew that day, which the signer never is.
test('with multi-day visits on, a walkthrough photo is no day\'s work: the signer attaches it the day before the job', async t => {
  const { store, call, photo } = api(t, signedJob(), { handlerEnv: { ...env, FIELD_MULTIDAY_VISITS: 'true' }, now: new Date('2026-09-21T18:00:00.000Z') });
  const saved = await call('Sales.One', photo('Sales.One'));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(store.get('jobs/job-1').fieldExecution.photos.length, 1);
  const before = await call('Sales.One', photo('Sales.One', { category: 'before' }));
  assert.deepEqual([before.status, before.body.code], [403, 'FIELD_JOB_NOT_ASSIGNED'], 'work photos stay with the crew');
});

test('a cancelled job takes no walkthrough photo, even from its signer', async t => {
  const { store, call, photo } = api(t, { ...signedJob(), status: 'cancelled', pipelineStatus: 'cancelled' });
  const refused = await call('Sales.One', photo('Sales.One'));
  assert.deepEqual([refused.status, refused.body.code], [409, 'FIELD_JOB_CLOSED']);
  assert.equal(store.calls.uploads, 0);
});
