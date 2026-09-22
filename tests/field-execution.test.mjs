import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { storage } from './helpers/field-fixture.mjs';
import { fieldChecklist, fieldCommand, fieldCompletionMissing, fieldFingerprint, fieldJobProjection } from '../functions/_lib/field-execution.js';
import { decodeFieldPhoto } from '../functions/_lib/field-execution-photos.js';
import { createFieldStore } from '../functions/_lib/field-execution-store.js';
import { syncFieldCompletion } from '../functions/_lib/field-execution-sync.js';
import * as route from '../functions/api/field-jobs.js';

const env = { HUB_SESSION_SECRET: 'field-test-session-secret', FIREBASE_API_KEY: 'firebase-test-field', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Owner' }, 'Crew.One': { passwordHash: 'test', role: 'crew', displayName: 'Crew One' }, 'Crew-One': { passwordHash: 'test', role: 'crew', displayName: 'Crew Other' } }), GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test' };
const cookies = new Map(await Promise.all(['ZacB', 'Crew.One', 'Crew-One'].map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const req = (user = 'Crew.One', data, search = '') => new Request(`https://easygaragecleaning.com/api/field-jobs${search}`, { method: data ? 'POST' : 'GET', headers: { Cookie: cookies.get(user) || '', Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
const actor = { user: 'Crew.One', displayName: 'Crew One', manager: false };
const baseline = () => ({ id: 'job-1', type: 'job', customer: 'Test Customer', address: '123 Test Street', phone: '9705550100', date: '2026-09-22', time: '08:00', endTime: '11:00', assignedCrew: ['Crew.One'], crewLead: 'Crew.One', vehicleId: 'truck-1', status: 'scheduled', pipelineStatus: 'scheduled', total: 1500, internalNotes: 'Sensitive management note', highlevelContactId: 'private-link', payment: { amount: 100, reference: 'secret-payment' }, jobInstructions: { operationalScope: 'Clean out garage', hazards: ['Oil on floor'] } });
const uuid = () => crypto.randomUUID();
const picture = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]).toString('base64')}`;

async function post(store, data, user = 'Crew.One') { return route.onRequestPost({ env, request: req(user, { jobId: 'job-1', requestId: uuid(), expectedRevision: store.revision('job-1'), ...data }) }); }

test('field detail is an allowlist: no money, provider linkage, credentials or private notes', () => {
  const j = baseline(); j.fieldExecution = { photos: [{ id: uuid(), fileId: 'file-1', verified: true, category: 'after' }] };
  const projected = fieldJobProjection(j, [{ id: uuid(), state: 'applied', action: 'note', visibility: 'management', body: 'Private salary discussion' }]);
  const text = JSON.stringify(projected);
  for (const secret of ['1500', 'Sensitive management', 'private-link', 'secret-payment', 'file-1', 'Private salary']) assert.equal(text.includes(secret), false, secret);
  assert.equal(projected.scope, 'Clean out garage'); assert.deepEqual(projected.assignedCrew, ['Crew.One']); assert.equal(projected.vehicleId, 'truck-1');
  assert.equal(fieldJobProjection({ ...j, jobInstructions: 'Dispatch-created scope' }).scope, 'Dispatch-created scope');
  assert.equal(fieldJobProjection({ ...j, jobInstructions: 'Previous scope', operationalScope: { text: 'Canonical scope' } }).scope, 'Canonical scope');
  assert.equal(fieldJobProjection({ ...j, operationalScope: { text: '' } }).scope, '', 'cleared canonical scope must not resurrect older instructions');
});

test('authentication and exact assigned identity are enforced before reads, writes and photos', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline());
  assert.equal((await route.onRequestGet({ env, request: req('nobody', undefined, '?jobId=job-1') })).status, 401);
  assert.equal((await route.onRequestGet({ env, request: req('Crew-One', undefined, '?jobId=job-1') })).status, 403);
  for (const action of ['note', 'complete', 'photo', 'configure_checklist']) assert.equal((await post(store, { action, body: 'Note', dataUrl: picture, category: 'before', caption: '' }, 'Crew-One')).status, 403);
  assert.equal((await route.onRequestGet({ env, request: req('ZacB', undefined, '?jobId=job-1') })).status, 200);
  assert.equal(store.calls.commits, 0); assert.equal(store.calls.uploads, 0);
});

test('legacy lists and malformed checklist entries do not hide the workday or merge separate requirements', async t => {
  const store = storage(t), job = baseline();
  job.jobInstructions = {};
  job.scope = { keep_items: ['Family photographs', null, 'Workbench'], keep_remove: ['Old boxes'], exclusions: ['Attached shelving'] };
  job.fieldExecution = { checklistTemplate: [null, 13, {}, { id: 'same', stage: 'arrival', label: 'First requirement', required: true }, { id: 'same', stage: 'invalid', label: 'Second requirement', required: true }], checks: { same: { completed: true } } };
  job.clientChecklists = { preJob: [null, false, {}, 'Customer request', { id: '__proto__', label: 'Protect piano' }], postJob: [{ id: 'duplicate', label: 'Inspect west wall' }, { id: 'duplicate', label: 'Inspect east wall' }] };
  store.put('jobs/job-1', job);
  const response = await route.onRequestGet({ env, request: req('Crew.One', undefined, '?jobId=job-1') });
  assert.equal(response.status, 200);
  const { job: projected } = await response.json();
  assert.equal(projected.keepItems, 'Family photographs\nWorkbench');
  assert.equal(projected.removeItems, 'Old boxes');
  assert.equal(projected.exclusions, 'Attached shelving');
  assert.equal(projected.checklist.length, 6);
  assert.equal(new Set(projected.checklist.map(item => item.id)).size, 6);
  assert.equal(projected.checklist.find(item => item.label === 'First requirement').completed, true);
  assert.equal(projected.checklist.find(item => item.label === 'Second requirement').completed, false);
  assert.ok(projected.completionMissing.some(item => item.includes('Second requirement')));
  assert.ok(!projected.checklist.some(item => item.id.includes('__proto__')));
  job.fieldExecution.checklistTemplate = [null, {}, false];
  assert.equal(fieldChecklist(job).filter(item => item.id.startsWith('departure-')).length, 2, 'unusable imported template retains standard safety checks');
});

test('managers resolve issues on completed jobs with a permanent report, resolution and exactly-once receipt', async t => {
  const store = storage(t); store.put('jobs/job-1', { ...baseline(), status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-22T15:00:00Z' });
  const reportId = uuid();
  assert.equal((await post(store, { action: 'note', requestId: reportId, body: 'A shelf needs a replacement bracket.', issue: true, visibility: 'crew' })).status, 200);
  const resolve = { action: 'resolve_issue', issueId: reportId, resolution: 'The replacement bracket was installed and the customer confirmed it.' };
  assert.equal((await post(store, resolve)).status, 403);
  assert.equal((await post(store, { ...resolve, resolution: 'Done' }, 'ZacB')).status, 400);
  assert.equal((await post(store, { ...resolve, issueId: 'older-issue' }, 'ZacB')).status, 409);
  const requestId = uuid(), response = await post(store, { ...resolve, requestId }, 'ZacB');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.job.attention.status, 'resolved');
  assert.equal(data.job.attention.reason, 'A shelf needs a replacement bracket.');
  assert.equal(data.job.attention.resolvedBy, 'Owner');
  assert.equal(data.job.status, 'completed');
  assert.equal(data.job.completedAt, '2026-09-22T15:00:00Z');
  assert.equal(store.get('jobs/job-1').payment.amount, 100);
  assert.equal((await (await post(store, { ...resolve, requestId }, 'ZacB')).json()).alreadyApplied, true);
  const crew = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, '?jobId=job-1') })).json();
  assert.equal(crew.job.attention.canResolve, false);
  assert.equal(crew.job.history.filter(item => item.action === 'resolve_issue').length, 1);
  assert.equal(crew.job.history.some(item => item.id === reportId), true);
});

test('private and unclassified issues and their resolutions remain management-only', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline());
  const issueId = uuid();
  await post(store, { action: 'note', requestId: issueId, body: 'Private financial follow-up required.', issue: true, visibility: 'management' }, 'ZacB');
  await post(store, { action: 'resolve_issue', issueId, resolution: 'Private financial adjustment was verified.' }, 'ZacB');
  const crew = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, '?jobId=job-1') })).json();
  assert.equal(crew.job.attention, null);
  assert.equal(JSON.stringify(crew).includes('financial'), false);
  const legacy = { ...baseline(), fieldExecution: { attention: { reason: 'Unclassified prior issue', status: 'open', at: '2026-09-22T14:00:00Z', actorId: 'ZacB' } } };
  assert.equal(fieldJobProjection(legacy).attention, null);
  assert.equal(fieldJobProjection(legacy, [], { manager: true }).attention.canResolve, true);
});

test('today uses Mountain calendar days through UTC midnight and daylight saving transitions', () => {
  assert.equal(route.fieldToday(new Date('2026-09-22T05:59:59Z')), '2026-09-21');
  assert.equal(route.fieldToday(new Date('2026-09-22T06:00:00Z')), '2026-09-22');
  assert.equal(route.fieldToday(new Date('2026-11-01T07:30:00Z')), '2026-11-01');
  assert.equal(route.fieldToday(new Date('2026-11-01T08:30:00Z')), '2026-11-01');
  assert.equal(route.fieldToday(new Date('2026-03-08T08:59:00Z')), '2026-03-08');
});

test('personal day includes multi-day assigned work, sorts it, and excludes other crew and secure records', async t => {
  const store = storage(t);
  store.put('jobs/job-1', baseline());
  store.put('jobs/multiday', { ...baseline(), id: 'multiday', date: '2026-09-21', endDate: '2026-09-23' });
  store.put('jobs/other', { ...baseline(), assignedCrew: ['Crew-One'] });
  store.put('jobs/private', { ...baseline(), recordType: 'employee_account_v1' });
  store.put('jobs/cancelled', { ...baseline(), status: 'cancelled', pipelineStatus: 'cancelled' });
  store.put('jobs/previous', { ...baseline(), date: '2026-09-20' });
  store.put('dispatchResources/truck-1', { recordType: 'vehicle', name: 'Box truck', notes: 'Sensitive staff note' });
  const data = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, '?date=2026-09-22&status=active') })).json();
  assert.deepEqual(data.jobs.map(job => job.id), ['multiday', 'job-1']);
  assert.equal(data.jobs[0].vehicleName, 'Box truck'); assert.equal(data.jobs[0].crewMembers[0].name, 'Crew One');
  assert.equal(JSON.stringify(data).includes('Sensitive'), false);
  assert.equal((await route.onRequestGet({ env, request: req('Crew.One', undefined, '?date=2026-02-30') })).status, 400);
  assert.equal(store.calls.queries.some(query => query.where?.fieldFilter?.field.fieldPath === 'endDate'), true);
});

test('notes are persisted atomically with actor and replay safely without duplicating', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline());
  const input = { action: 'note', body: 'Keep the green cabinet.', requestId: uuid() };
  let response = await post(store, input); assert.equal(response.status, 200);
  let data = await response.json(); assert.equal(data.job.history[0].body, input.body); assert.equal(data.job.history[0].actorId, actor.user);
  response = await post(store, input); data = await response.json(); assert.equal(data.alreadyApplied, true); assert.equal(data.job.history.length, 1); assert.equal(store.calls.commits, 1);
  assert.equal((await post(store, { ...input, body: 'Changed content' })).status, 409);
  assert.equal((await post(store, { action: 'note', body: 'Private', visibility: 'management' })).status, 403);
  assert.equal((await post(store, { action: 'note', body: 'Owner-only review', visibility: 'management' }, 'ZacB')).status, 200);
  data = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, '?jobId=job-1') })).json(); assert.equal(JSON.stringify(data).includes('Owner-only review'), false);
});

test('stale writes, cross-site mutations, and reassigned retries are rejected', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline());
  const old = store.revision('job-1');
  assert.equal((await post(store, { action: 'note', body: 'First note' })).status, 200);
  assert.equal((await post(store, { action: 'note', body: 'Stale note', expectedRevision: old })).status, 409);
  const r = req('Crew.One', { action: 'note', jobId: 'job-1', requestId: uuid(), expectedRevision: store.revision('job-1'), body: 'Forged' }); r.headers.set('Origin', 'https://attacker.example');
  assert.equal((await route.onRequestPost({ env, request: r })).status, 403);
  assert.equal((await post(store, { action: 'note', body: 'Old account draft', expectedUser: 'Crew-One' })).status, 401);
  const id = uuid(); assert.equal((await post(store, { action: 'note', body: 'Before reassignment', requestId: id })).status, 200);
  store.put('jobs/job-1', { ...store.get('jobs/job-1'), assignedCrew: ['Crew-One'] });
  assert.equal((await post(store, { action: 'note', body: 'Before reassignment', requestId: id })).status, 403);
});

test('field statuses enforce arrival preparation and retain canonical lifecycle for pauses and delays', () => {
  let job = baseline();
  assert.throws(() => fieldCommand(job, actor, { action: 'status', status: 'completed' }), /status is no longer/);
  job = { ...job, ...fieldCommand(job, actor, { action: 'status', status: 'dispatched' }).patch };
  job = { ...job, ...fieldCommand(job, actor, { action: 'status', status: 'arrived' }).patch };
  assert.throws(() => fieldCommand(job, actor, { action: 'status', status: 'in_progress' }), error => error.code === 'FIELD_START_INCOMPLETE' && error.missing.some(item => item.includes('photo')));
  for (const item of fieldChecklist(job).filter(item => ['departure', 'arrival'].includes(item.stage))) job = { ...job, ...fieldCommand(job, actor, { action: 'checklist', itemId: item.id, completed: true }).patch };
  job.fieldExecution.photos = [{ id: uuid(), fileId: 'file-1', verified: true, category: 'before' }];
  job = { ...job, ...fieldCommand(job, actor, { action: 'status', status: 'in_progress' }).patch };
  const firstStart = job.startedAt;
  job = { ...job, ...fieldCommand(job, actor, { action: 'status', status: 'paused', reason: 'Waiting for customer' }).patch };
  assert.equal(job.pipelineStatus, 'in_progress'); assert.equal(job.fieldExecution.activity, 'paused');
  job = { ...job, ...fieldCommand(job, actor, { action: 'status', status: 'in_progress' }).patch };
  assert.equal(job.startedAt, firstStart);
  assert.equal(fieldJobProjection({ ...job, status: 'cancelled', pipelineStatus: 'cancelled' }).fieldStatus, 'cancelled');
  assert.equal(fieldJobProjection({ ...job, status: 'scheduled', pipelineStatus: 'scheduled' }).fieldStatus, 'scheduled');
});

test('checklist customization is manager-only, preserves unchanged checks and clears changed evidence', () => {
  const job = baseline();
  job.fieldExecution = { checks: { 'departure-address': { completed: true, actorId: 'Crew.One' } } };
  const items = fieldChecklist(job).map(({ id, stage, label, detail, required }) => ({ id, stage, label, detail, required }));
  assert.throws(() => fieldCommand(job, actor, { action: 'configure_checklist', items }), error => error.status === 403);
  const result = fieldCommand(job, { ...actor, manager: true }, { action: 'configure_checklist', items });
  assert.equal(result.patch.fieldExecution.checks['departure-address'].completed, true);
  items[0].label = 'A different departure requirement';
  assert.equal(fieldCommand(job, { ...actor, manager: true }, { action: 'configure_checklist', items }).patch.fieldExecution.checks['departure-address'], undefined);
});

test('photo upload is private, associated to the job, verified and idempotent after refresh', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline());
  const id = uuid(), input = { action: 'photo', requestId: id, category: 'before', caption: 'Before work', dataUrl: picture };
  let response = await post(store, input); assert.equal(response.status, 200, await response.clone().text());
  let data = await response.json(); assert.equal(data.job.photos.length, 1); assert.equal(data.job.photos[0].id, id); assert.equal(JSON.stringify(data).includes('file-1'), false);
  response = await post(store, input); assert.equal(response.status, 200); data = await response.json(); assert.equal(data.alreadyApplied, true); assert.equal(store.calls.uploads, 1); assert.equal(store.calls.generated, 1);
  response = await route.onRequestGet({ env, request: req('Crew.One', undefined, `?jobId=job-1&photoId=${id}`) }); assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  store.put('jobs/job-1', { ...store.get('jobs/job-1'), assignedCrew: ['Crew-One'] });
  response = await route.onRequestGet({ env, request: req('Crew.One', undefined, `?jobId=job-1&photoId=${id}`) }); assert.equal(response.status, 403);
});

test('photo parser rejects spoofed types, SVG and malformed input', () => {
  assert.equal(decodeFieldPhoto(picture).bytes.length, 14);
  for (const value of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,SGVsbG8gd29ybGQ=', 'https://example.com/photo.jpg', picture.replace('image/jpeg', 'image/png')]) assert.throws(() => decodeFieldPhoto(value));
});

test('a complete EGC field day persists checks, photos, notes, completion and history without changing payments', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline());
  for (const status of ['dispatched', 'arrived']) assert.equal((await post(store, { action: 'status', status })).status, 200);
  let result = await (await post(store, { action: 'complete', notes: 'Cleaned the garage.', hasIssues: false })).json(); assert.equal(result.ok, false); assert.equal(result.missing.some(item => item.includes('after photo')), true);
  assert.equal((await post(store, { action: 'photo', category: 'before', caption: '', dataUrl: picture })).status, 200);
  for (const item of fieldChecklist(store.get('jobs/job-1'))) assert.equal((await post(store, { action: 'checklist', itemId: item.id, completed: true })).status, 200);
  assert.equal((await post(store, { action: 'status', status: 'in_progress' })).status, 200);
  assert.equal((await post(store, { action: 'note', body: 'Customer asked us to keep the red toolbox.' })).status, 200);
  assert.equal((await post(store, { action: 'photo', category: 'after', caption: 'Garage finished', dataUrl: picture })).status, 200);
  assert.equal((await post(store, { action: 'complete', notes: 'Garage cleaned, debris removed, and customer walkthrough complete.', hasIssues: true, issueNotes: '' })).status, 409);
  const completeId = uuid(), complete = { action: 'complete', requestId: completeId, notes: 'Garage cleaned, debris removed, and customer walkthrough complete.', hasIssues: false };
  result = await (await post(store, complete)).json(); assert.equal(result.ok, true); assert.equal(result.job.status, 'completed'); assert.equal(result.job.completion.completedBy, 'Crew One');
  assert.equal(store.get('jobs/job-1').payment.amount, 100); assert.equal(store.get('jobs/job-1').total, 1500);
  assert.equal((await (await post(store, complete)).json()).alreadyApplied, true);
  assert.equal((await post(store, { action: 'checklist', itemId: 'departure-address', completed: false })).status, 409);
  assert.equal((await post(store, { action: 'note', body: 'Post-completion follow-up note.' })).status, 200);
  const refreshed = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, '?jobId=job-1') })).json();
  assert.equal(refreshed.job.photos.length, 2); assert.equal(refreshed.job.checklist.every(item => item.completed), true); assert.ok(refreshed.job.history.some(event => event.action === 'complete'));
});

test('completion rejects missing materials without documented follow-up and ignores fake legacy photo counts', () => {
  const job = { ...baseline(), status: 'in_progress', pipelineStatus: 'in_progress', photoCount: 100, afterPhotoCount: 100, materials: [{ id: 'rack', name: 'Rack', quantity: 2 }], fieldExecution: { materialStates: { rack: { state: 'missing' } } } };
  const missing = fieldCompletionMissing(job, { notes: 'Completed agreed work.', hasIssues: false });
  assert.ok(missing.some(item => item.includes('before photo'))); assert.ok(missing.some(item => item.includes('after photo'))); assert.ok(missing.some(item => item.includes('Rack')));
});

test('fingerprints survive revision refresh but reject payload or actor changes', async () => {
  const a = { action: 'note', expectedRevision: 'one', body: 'Note' };
  assert.equal(await fieldFingerprint('crew', a), await fieldFingerprint('crew', { ...a, expectedRevision: 'two' }));
  assert.notEqual(await fieldFingerprint('crew', a), await fieldFingerprint('other', a));
  assert.notEqual(await fieldFingerprint('crew', a), await fieldFingerprint('crew', { ...a, body: 'Different' }));
});

test('a Drive verification outage retains a resumable receipt without claiming an uploaded photo', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline());
  const provider = globalThis.fetch; let interrupt = true;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (interrupt && url.hostname === 'www.googleapis.com' && url.pathname.endsWith('/file-1') && store.calls.uploads === 1) return Response.json({}, { status: 503 });
    return provider(input, options);
  });
  const id = uuid(), input = { action: 'photo', requestId: id, category: 'before', caption: 'Before', dataUrl: picture };
  let response = await post(store, input); assert.equal(response.status, 503);
  assert.equal(store.get('jobs/job-1').fieldExecution?.photos?.length || 0, 0);
  assert.equal(store.get(`jobs/job-1/fieldEvents/${id}`).state, 'pending');
  interrupt = false; response = await post(store, input); assert.equal(response.status, 200);
  assert.equal(store.get('jobs/job-1').fieldExecution.photos.length, 1); assert.equal(store.calls.uploads, 1); assert.equal(store.calls.generated, 1);
});

test('a lost commit response is recovered from the exact receipt without duplicating notes', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline()); const provider = globalThis.fetch;
  let interrupt = true;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const response = await provider(input, options);
    if (interrupt && new URL(input).pathname.endsWith('/documents:commit')) { interrupt = false; return Response.json({}, { status: 503 }); }
    return response;
  });
  const result = await (await post(store, { action: 'note', body: 'Receipt survived the interrupted response.' })).json();
  assert.equal(result.ok, true); assert.equal(result.alreadyApplied, true); assert.equal(result.job.history.length, 1); assert.equal(store.calls.commits, 1);
});

test('concurrent checklist updates during photo upload are retained when its commit retries', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline()); const provider = globalThis.fetch;
  let race = true;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    if (race && new URL(input).pathname.endsWith('/documents:commit')) {
      const event = decodeEvent(options.body);
      if (event.action === 'photo' && event.state === 'applied') {
        race = false; const job = store.get('jobs/job-1');
        store.put('jobs/job-1', { ...job, fieldExecution: { ...(job.fieldExecution || {}), checks: { 'departure-address': { completed: true, actorId: 'Crew.One', actorName: 'Crew One' } } } });
      }
    }
    return provider(input, options);
  });
  const response = await post(store, { action: 'photo', category: 'before', caption: '', dataUrl: picture });
  assert.equal(response.status, 200); assert.equal(store.get('jobs/job-1').fieldExecution.checks['departure-address'].completed, true); assert.equal(store.get('jobs/job-1').fieldExecution.photos.length, 1);
});

function decodeEvent(body) {
  const fields = JSON.parse(body).writes[1].update.fields;
  return { action: fields.action?.stringValue, state: fields.state?.stringValue };
}

test('assignment is checked again after photo bytes upload and before evidence is attached', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline()); const provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const response = await provider(input, options);
    if (new URL(input).pathname.startsWith('/upload/')) store.put('jobs/job-1', { ...store.get('jobs/job-1'), assignedCrew: ['Crew-One'] });
    return response;
  });
  assert.equal((await post(store, { action: 'photo', category: 'before', caption: '', dataUrl: picture })).status, 403);
  assert.equal(store.get('jobs/job-1').fieldExecution?.photos?.length || 0, 0);
});

test('document identity and revision fields cannot be forged by stored job data', async t => {
  const store = storage(t); store.put('jobs/job-1', { ...baseline(), id: 'job-other', __updateTime: 'forged' });
  const result = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, '?jobId=job-1') })).json();
  assert.equal(result.job.id, 'job-1'); assert.equal(result.job.expectedRevision, store.revision('job-1'));
  assert.equal((await post(store, { action: 'note', body: 'Safe record identity.' })).status, 200);
});

test('history pagination retains older records with equal timestamps and does not duplicate boundaries', async t => {
  const store = storage(t); store.put('jobs/job-1', baseline());
  const ids = [];
  for (let index = 0; index < 65; index++) { const id = uuid(); ids.push(id); store.put(`jobs/job-1/fieldEvents/${id}`, { id, action: 'note', state: 'applied', visibility: 'crew', body: `Note ${index}`, actorId: 'Crew.One', createdAt: '2026-09-22T14:00:00.000Z' }); }
  const first = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, '?jobId=job-1') })).json(); assert.equal(first.job.history.length, 50); assert.ok(first.historyCursor);
  const second = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, `?jobId=job-1&historyCursor=${encodeURIComponent(first.historyCursor)}`) })).json(); assert.equal(second.job.history.length, 15); assert.equal(second.historyCursor, null);
  assert.deepEqual([...first.job.history, ...second.job.history].map(event => event.id).sort(), ids.sort());
});

function readyJob() {
  const job = { ...baseline(), status: 'in_progress', pipelineStatus: 'in_progress', startedAt: '2026-09-22T14:00:00.000Z' };
  job.fieldExecution = { checks: Object.fromEntries(fieldChecklist(job).map(item => [item.id, { completed: true, actorId: actor.user }])), photos: ['before', 'after'].map(category => ({ id: uuid(), fileId: `file-${category}`, category, verified: true })) };
  return job;
}

function completedJob() { const job = readyJob(); return { ...job, ...fieldCommand(job, actor, { action: 'complete', requestId: uuid(), notes: 'The agreed garage services and walkthrough are complete.', hasIssues: false }).patch }; }
const enabledEnv = { ...env, EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy' };

test('completion stays saved when the provider is unconfigured and the pending handoff is durable', async t => {
  const store = storage(t); store.put('jobs/job-1', readyJob());
  const background = [];
  const response = await route.onRequestPost({ env, request: req('Crew.One', { action: 'complete', jobId: 'job-1', requestId: uuid(), expectedRevision: store.revision('job-1'), notes: 'Completed work and customer walkthrough.', hasIssues: false }), waitUntil: promise => background.push(promise) });
  assert.equal(response.status, 200); assert.equal(store.get('jobs/job-1').status, 'completed');
  await Promise.all(background); const job = store.get('jobs/job-1');
  assert.equal(job.fieldCompletionSync.status, 'blocked'); assert.equal(job.fieldCompletionSync.errorCode, 'FIELD_COMPLETION_SYNC_UNAVAILABLE'); assert.equal(job.payment.amount, 100);
  assert.equal((await post(store, { action: 'retry_completion_sync' })).status, 403);
  const manager = await (await route.onRequestGet({ env, request: req('ZacB', undefined, '?jobId=job-1') })).json(); assert.equal(manager.job.completionSync.canRetry, true);
});

test('completion handoff retries share one provider note intent and preserve completion attribution', async t => {
  const store = storage(t); const job = completedJob(); store.put('jobs/job-1', job); const calls = [];
  const syncNote = async (_env, who, payload) => { calls.push({ who, payload }); if (calls.length === 1) throw Object.assign(new Error('Provider is reconciling'), { code: 'provider_note_pending', operationId: 'outbox-stable' }); return { note: { id: 'note-verified' }, outboxId: 'outbox-stable', followupTaskId: 'followup-stable' }; };
  let result = await syncFieldCompletion(enabledEnv, 'job-1', { syncNote }); assert.equal(result.status, 'error'); assert.equal(result.outboxId, 'outbox-stable');
  result = await syncFieldCompletion(enabledEnv, 'job-1', { syncNote, actor: { user: 'ZacB', displayName: 'Owner' } }); assert.equal(result.status, 'synced'); assert.equal(result.attempts, 2);
  assert.equal(calls[0].payload.requestId, calls[1].payload.requestId); assert.equal(calls[0].payload.body, calls[1].payload.body); assert.equal(calls[0].payload.scope, 'post_job'); assert.match(calls[0].payload.body, /Crew One \(Crew.One\)/);
  assert.equal(store.get('jobs/job-1').completedBy, 'Crew.One');
  await syncFieldCompletion(enabledEnv, 'job-1', { syncNote }); assert.equal(calls.length, 2, 'verified handoffs do not call the provider again');
  const crew = await (await route.onRequestGet({ env, request: req('Crew.One', undefined, '?jobId=job-1') })).json(); assert.equal(crew.job.history.some(event => event.action === 'completion_sync'), false); assert.equal(JSON.stringify(crew).includes('note-verified'), false);
});

test('completion handoff metadata retries preserve concurrent changes and cannot overwrite later successful sync', async t => {
  const fixture = storage(t); fixture.put('jobs/job-1', completedJob());
  const store = createFieldStore(env), originalCommit = store.commit; let race = true, noteCalls = 0;
  store.commit = async (job, patch, event) => {
    if (race) { race = false; fixture.put('jobs/job-1', { ...fixture.get('jobs/job-1'), customerInstructions: 'Changed during handoff' }); }
    return originalCommit(job, patch, event);
  };
  await syncFieldCompletion(enabledEnv, 'job-1', { store, syncNote: async () => { noteCalls++; return { note: { id: 'note' }, outboxId: 'outbox', followupTaskId: 'followup' }; } });
  assert.equal(noteCalls, 1); assert.equal(fixture.get('jobs/job-1').customerInstructions, 'Changed during handoff'); assert.equal(fixture.get('jobs/job-1').fieldCompletionSync.status, 'synced');
});

test('changed customer links block completion handoff instead of sending notes to the wrong person', async t => {
  const store = storage(t); const job = completedJob(); store.put('jobs/job-1', { ...job, highlevelContactId: 'different-contact' }); let called = false;
  const result = await syncFieldCompletion(enabledEnv, 'job-1', { syncNote: async () => { called = true; } });
  assert.equal(result.status, 'blocked'); assert.equal(result.errorCode, 'FIELD_COMPLETION_CONTACT_CHANGED'); assert.equal(called, false);
});
