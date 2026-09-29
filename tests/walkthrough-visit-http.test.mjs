import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { opaqueId, open } from '../functions/_lib/employee-vault.js';
import { activeJobSegment, employeeJobTime } from '../functions/_lib/employee-job-time.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { walkthroughVisitHandlers } from '../functions/api/walkthrough-visit.js';
import { walkthroughVisitStorage } from '../functions/_lib/walkthrough-visit.js';
import * as employeeHub from '../functions/api/employee-hub.js';
import * as fieldJobs from '../functions/api/field-jobs.js';
import { storage as fieldStorage } from './helpers/field-fixture.mjs';
import { ROOT, vaultFirestore, staffEnv, cookieFor, seedAccount, login, jsonRequest } from './helpers/vault-fixture.mjs';

// Synthetic data only; every clock is injected (the Employee Hub clock-in runs on mocked Date).
const CLOCK_IN = '2026-09-22T14:00:00.000Z', NOW = '2026-09-22T15:00:00.000Z', FINISH = '2026-09-22T16:00:00.000Z';
const env = staffEnv({ EGC_WALKTHROUGH_VISIT_ENABLED: 'true' });
const PATH = '/api/walkthrough-visit';
const walkthrough = { type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', date: '2026-09-22', time: '09:00', endTime: '10:00', assignedCrew: ['sales.rep'], projectId: 'project_w1', estimate: { amount: 1437 } };

async function setup(t, { clockIn = true } = {}) {
  const fire = vaultFirestore(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(CLOCK_IN) });
  fire.documents.set('jobs/w1', { name: `${ROOT}/jobs/w1`, fields: encodeFirestoreFields(walkthrough), updateTime: '2026-09-22T11:00:00.000000Z' });
  await seedAccount(env, 'Sales.Rep', { sales: true });
  const { cookie, profile } = await login(env, 'Sales.Rep');
  assert.equal(profile.role, 'sales');
  const shift = async () => {
    const response = await employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id: 'shift-sales-rep', data: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } } }, cookie) });
    assert.equal(response.status, 200, await response.clone().text());
  };
  if (clockIn) await shift();
  t.mock.timers.setTime(Date.parse(NOW));
  let current = NOW;
  const handlers = walkthroughVisitHandlers({ now: () => new Date(current) });
  const call = async (body, { user = cookie, headers = {}, environment = env } = {}) => {
    const query = typeof body === 'string' && body.startsWith('?');
    const response = await (query ? handlers.get : handlers.post)({ env: environment, request: jsonRequest(query ? `${PATH}${body}` : PATH, query ? undefined : body, user, headers) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const timecard = async () => {
    const documentId = await opaqueId(env, 'timeEntries', 'shift-sales-rep'), doc = fire.documents.get(`jobs/${documentId}`);
    return { documentId, entry: await open(env, documentId, doc.fields.sealedIv.stringValue, doc.fields.sealedPayload.stringValue) };
  };
  const plain = key => fire.documents.has(key) ? decodeFirestoreFields(fire.documents.get(key).fields) : null;
  const keys = prefix => [...fire.documents.keys()].filter(key => key.startsWith(prefix));
  return { fire, cookie, call, shift, timecard, plain, keys, at: iso => { current = iso; t.mock.timers.setTime(Date.parse(iso)); }, revision: () => fire.documents.get('jobs/w1').updateTime };
}

test('HTTP: Start and Finish commit the visit, the rep\'s sealed timecard, the events, the lock and the receipt in one Firestore commit each', async t => {
  const s = await setup(t);
  const state = await s.call('?visitId=w1');
  assert.equal(state.status, 200, JSON.stringify(state.body)); assert.equal(state.body.enabled, true); assert.equal(state.body.shift.clockedIn, true); assert.equal(state.body.visit.revision, s.revision());
  assert.equal(state.headers.get('Cache-Control'), 'no-store'); assert.equal(state.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(JSON.stringify(state.body).includes('1437'), false);
  const commitsBefore = s.fire.commits.length, startId = crypto.randomUUID();
  const started = await s.call({ action: 'start', visitId: 'w1', requestId: startId, expectedRevision: state.body.visit.revision, recordingStatus: 'recorded', actorId: 'Sales.Rep' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.visit.walkthroughVisit.startedAt, NOW); assert.equal(started.body.visit.revision, s.revision());
  assert.equal(s.fire.commits.length, commitsBefore + 1);
  const { documentId } = await s.timecard(), writes = s.fire.commits.at(-1);
  const names = writes.map(write => write.update.name.split('/documents/')[1]);
  assert.deepEqual(names.map(name => name.startsWith('jobs/secure_') ? 'timecard' : name.split('/')[0] === 'jobs' ? name : name.split('/')[0]).sort(), ['funnelEvents', 'jobs/w1', 'timecard', 'walkthroughVisitLocks', 'walkthroughVisitOperations']);
  assert.equal(names.find(name => name.startsWith('jobs/secure_')), `jobs/${documentId}`);
  for (const write of writes) {
    const name = write.update.name.split('/documents/')[1];
    if (name === 'jobs/w1') assert.deepEqual(write.currentDocument, { updateTime: state.body.visit.revision });
    else if (name.startsWith('jobs/secure_')) assert.ok(write.currentDocument.updateTime);
    else assert.deepEqual(write.currentDocument, { exists: false }, name);
  }
  // The sealed timecard now has a work segment on the walkthrough, and the Hub clock sees it.
  let { entry } = await s.timecard();
  assert.deepEqual([activeJobSegment(entry).id, activeJobSegment(entry).kind, activeJobSegment(entry).jobId], [startId, 'work', 'w1']);
  const own = await employeeHub.onRequestGet({ env, request: jsonRequest('/api/employee-hub?view=own-job-time', undefined, s.cookie) });
  assert.equal((await own.json()).entry.current.jobId, 'w1');
  const [event] = s.keys('funnelEvents/').map(s.plain);
  assert.equal(event.type, 'walkthrough.started'); assert.equal(event.walkthroughId, 'w1'); assert.equal(event.occurredAt, NOW); assert.equal(event.actor.id, 'sales.rep');
  assert.equal(s.plain(`walkthroughVisitOperations/${startId}`).action, 'start');
  assert.equal(s.plain(s.keys('walkthroughVisitLocks/')[0]).openVisitId, 'w1');
  // Replaying the identical request changes nothing.
  const replay = await s.call({ action: 'start', visitId: 'w1', requestId: startId, expectedRevision: state.body.visit.revision, recordingStatus: 'recorded', actorId: 'Sales.Rep' });
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(s.fire.commits.length, commitsBefore + 1);

  s.at(FINISH);
  const finished = await s.call({ action: 'finish', visitId: 'w1', requestId: crypto.randomUUID(), expectedRevision: started.body.visit.revision, outcome: 'not_interested', reasonCode: 'price', recordingStatus: 'declined' });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  const visit = s.plain('jobs/w1');
  assert.equal(visit.walkthroughOutcome.outcome, 'not_interested'); assert.equal(visit.walkthroughOutcome.finishedAt, FINISH); assert.equal(visit.walkthroughCompletedAt, FINISH);
  assert.equal(visit.walkthroughOutcome.repTime.status, 'segment_closed'); assert.equal(visit.status, 'scheduled'); assert.equal(visit.estimate.amount, 1437);
  assert.deepEqual(s.keys('funnelEvents/').map(key => s.plain(key).type).sort(), ['deal.lost', 'walkthrough.completed', 'walkthrough.started']);
  ({ entry } = await s.timecard());
  assert.equal(activeJobSegment(entry).kind, 'general');
  assert.deepEqual(employeeJobTime(entry, FINISH).jobs.map(row => [row.jobId, row.workMs]), [['w1', 3600000]]);
  assert.equal(s.plain(s.keys('walkthroughVisitLocks/')[0]).openVisitId, '');
});

test('HTTP: Start without a shift prompts clock-in; after clocking in the same request succeeds', async t => {
  const s = await setup(t, { clockIn: false });
  const body = { action: 'start', visitId: 'w1', requestId: crypto.randomUUID(), expectedRevision: s.revision(), recordingStatus: 'recorded' };
  const prompt = await s.call(body);
  assert.equal(prompt.status, 409); assert.equal(prompt.body.code, 'walkthrough_visit_clock_in_required'); assert.equal(prompt.body.details.clockInRequired, true);
  assert.equal(s.keys('funnelEvents/').length, 0);
  assert.equal((await s.call('?visitId=w1')).body.shift.clockedIn, false);
  await s.shift();
  const started = await s.call(body);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await s.timecard()).entry.jobTracking.segments.at(-1).jobId, 'w1');
});

test('HTTP: a visit or timecard changed at commit time is a 409 (Firestore 400 FAILED_PRECONDITION) and saves nothing; a lost reply and an unverified commit recover on the same request', async t => {
  const s = await setup(t);
  const body = () => ({ action: 'start', visitId: 'w1', requestId: crypto.randomUUID(), expectedRevision: s.revision(), recordingStatus: 'recorded' });
  s.fire.hooks.beforeCommit = async () => { const doc = s.fire.documents.get('jobs/w1'); s.fire.documents.set('jobs/w1', { ...doc, updateTime: '2026-09-22T15:00:00.999999Z' }); };
  const conflict = await s.call(body());
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'walkthrough_visit_revision_conflict');
  assert.equal(s.plain('jobs/w1').walkthroughVisit, undefined); assert.equal(s.keys('funnelEvents/').length, 0); assert.equal(s.keys('walkthroughVisitOperations/').length, 0);
  assert.equal(activeJobSegment((await s.timecard()).entry).kind, 'general');
  const { documentId } = await s.timecard();
  s.fire.hooks.beforeCommit = async () => { const doc = s.fire.documents.get(`jobs/${documentId}`); s.fire.documents.set(`jobs/${documentId}`, { ...doc, updateTime: '2026-09-22T15:00:01.000000Z' }); };
  const stale = await s.call(body());
  assert.equal(stale.status, 409); assert.equal(s.plain('jobs/w1').walkthroughVisit, undefined);
  s.fire.hooks.commitStatus = 500;
  const unknown = body(), first = await s.call(unknown);
  assert.equal(first.status, 503); assert.equal(first.body.code, 'walkthrough_visit_outcome_unknown');
  const retried = await s.call(unknown);
  assert.equal(retried.status, 200); assert.equal(retried.body.replayed, false);
  const commits = s.fire.commits.length;
  s.fire.hooks.loseCommitReply = true;
  const finish = { action: 'finish', visitId: 'w1', requestId: crypto.randomUUID(), expectedRevision: s.revision(), outcome: 'quote_to_follow', recordingStatus: 'recorded' };
  const recovered = await s.call(finish);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body)); assert.equal(recovered.body.replayed, true);
  assert.equal(s.fire.commits.length, commits + 1);
  assert.equal((await s.call(finish)).body.replayed, true); assert.equal(s.fire.commits.length, commits + 1);
});

test('HTTP: a Finish replayed late closes the sealed segment at the server time and keeps the device time on the outcome', async t => {
  const s = await setup(t);
  const started = await s.call({ action: 'start', visitId: 'w1', requestId: crypto.randomUUID(), expectedRevision: s.revision(), recordingStatus: 'recorded' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  s.at('2026-09-22T15:40:00.000Z');
  // The FUN-06 recorder queued this Finish at 15:30; EGC_OFFLINE_CLOCK_ENABLED is off.
  const late = await s.call({ action: 'finish', visitId: 'w1', requestId: crypto.randomUUID(), expectedRevision: started.body.visit.revision, outcome: 'quote_to_follow', recordingStatus: 'recorded', deviceAt: '2026-09-22T15:30:00.000Z', skipTimecard: true });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.deepEqual([late.body.repTime.status, late.body.visit.walkthroughOutcome.finishedAt, late.body.visit.walkthroughOutcome.clockSource], ['segment_closed_server_time', '2026-09-22T15:30:00.000Z', 'device_validated']);
  const { entry } = await s.timecard(), segment = entry.jobTracking.segments.find(row => row.jobId === 'w1');
  assert.deepEqual([segment.visitKind, segment.endedAt, activeJobSegment(entry).kind], ['walkthrough', '2026-09-22T15:40:00.000Z', 'general']);
  assert.deepEqual(employeeJobTime(entry, '2026-09-22T20:00:00.000Z').jobs.map(row => [row.jobId, row.workMs]), [['w1', 40 * 60000]]);
});

test('HTTP: deterministic refusals are 400 walkthrough_visit_invalid; only an unreadable commit reply is an unknown outcome', async () => {
  const writes = [{ collection: 'jobs', id: 'w1', revision: '2026-09-22T11:00:00.000000Z', patch: { updatedAt: NOW } }];
  const answering = (status, body) => walkthroughVisitStorage(env, async () => Response.json(body, { status }));
  const outcome = async (storage, code, status) => assert.rejects(storage.commit(writes), error => error.code === code && error.status === status);
  await outcome(answering(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'synthetic invalid value' } }), 'walkthrough_visit_invalid', 400);
  await outcome(answering(400, { error: { code: 400, status: 'FAILED_PRECONDITION' } }), 'walkthrough_visit_revision_conflict', 409);
  await outcome(answering(409, { error: { code: 409, status: 'ALREADY_EXISTS' } }), 'walkthrough_visit_revision_conflict', 409);
  await outcome(answering(500, { error: { status: 'INTERNAL' } }), 'walkthrough_visit_outcome_unknown', 503);
  await outcome(answering(400, 'not a Firestore error'), 'walkthrough_visit_outcome_unknown', 503);
  await outcome(walkthroughVisitStorage(env, async () => { throw new TypeError('synthetic lost reply'); }), 'walkthrough_visit_outcome_unknown', 503);
  // A funnel event the visit or account cannot produce is refused before anything is written, and never as retryable.
  const visit = { ...walkthrough, id: 'w1', revision: 'r1' };
  let commits = 0;
  const store = { env: {}, read: async (collection, id) => collection === 'jobs' && id === 'w1' ? structuredClone(visit) : null, assigned: async () => true, activeShift: async () => null, commit: async () => { commits++; } };
  const post = async (actor, storage = () => store) => {
    const response = await walkthroughVisitHandlers({ session: async () => actor, storage, now: () => new Date(NOW) }).post({ env, request: jsonRequest(PATH, { action: 'start', visitId: 'w1', requestId: crypto.randomUUID(), expectedRevision: 'r1', skipTimecard: true }) });
    return { status: response.status, body: await response.json() };
  };
  const refused = await post({ user: 'Sales Rep', role: 'sales' });
  assert.deepEqual([refused.status, refused.body.code, refused.body.details], [400, 'walkthrough_visit_invalid', { cause: 'funnel_event_invalid' }]);
  assert.equal(commits, 0);
  const raw = await post({ user: 'Sales.Rep', role: 'sales' }, () => ({ ...store, read: async () => { throw Object.assign(new Error('synthetic private detail'), { code: 'funnel_event_private_record', status: 503 }); } }));
  assert.deepEqual([raw.status, raw.body.code], [400, 'walkthrough_visit_invalid']); assert.equal(JSON.stringify(raw.body).includes('synthetic private detail'), false);
  const unknown = await post({ user: 'Sales.Rep', role: 'sales' }, () => ({ ...store, read: async () => { throw new Error('synthetic private detail'); } }));
  assert.deepEqual([unknown.status, unknown.body.code], [503, 'walkthrough_visit_unavailable']); assert.equal(JSON.stringify(unknown.body).includes('synthetic private detail'), false);
});

test('HTTP: switched off by default for writes, same-origin JSON only, bounded, signed-in performers only', async t => {
  const s = await setup(t);
  const body = { action: 'start', visitId: 'w1', requestId: crypto.randomUUID(), expectedRevision: s.revision(), recordingStatus: 'recorded' };
  const off = staffEnv();
  const disabled = await s.call(body, { environment: off });
  assert.equal(disabled.status, 503); assert.equal(disabled.body.code, 'walkthrough_visit_disabled');
  const requestsBefore = s.fire.requests.length;
  const read = await s.call('?visitId=w1', { environment: off });
  assert.equal(read.status, 200); assert.equal(read.body.enabled, false);
  // FUN-06: the gameplan asks on every open, so switched off the GET reads nothing beyond the sign-in check (its own
  // account record): no visit, lock or timecard vault read. Switched on, the same GET reads them.
  assert.deepEqual(read.body, { ok: true, enabled: false });
  const beyondSignIn = from => s.fire.requests.slice(from).map(request => decodeURIComponent(request.url.pathname)).filter(path => !/\/documents\/jobs\/secure_account_[\w-]+$/.test(path));
  assert.deepEqual(beyondSignIn(requestsBefore), []);
  const onBefore = s.fire.requests.length;
  assert.equal((await s.call('?visitId=w1')).body.enabled, true);
  assert.ok(beyondSignIn(onBefore).length > 0, 'switched on, the visit and timecard are read');
  const checks = [
    [{ headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403, 'walkthrough_visit_origin_forbidden'],
    [{ headers: { Origin: 'https://attacker.invalid' } }, 403, 'walkthrough_visit_origin_forbidden'],
    [{ user: '' }, 401, 'walkthrough_visit_sign_in_required'],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415, 'walkthrough_visit_json_required'],
    [{ user: await cookieFor(env, 'Crew.Static') }, 403, 'walkthrough_visit_forbidden'],
    [{ user: await cookieFor(env, 'AlexK') }, 403, 'walkthrough_visit_forbidden'],
  ];
  for (const [options, status, code] of checks) {
    const response = await s.call(body, options);
    assert.equal(response.status, status, code); assert.equal(response.body.code, code);
  }
  assert.equal((await s.call('x'.repeat(9000))).status, 413);
  assert.equal((await s.call('{not json')).body.code, 'walkthrough_visit_json_invalid');
  for (const query of ['?jobId=w1', '?visitId=w1&visitId=w2']) assert.equal((await s.call(query)).status, 400);
  assert.equal((await s.call('?visitId=w1', { user: '' })).status, 401);
  assert.equal(s.keys('funnelEvents/').length, 0); assert.equal(s.plain('jobs/w1').walkthroughVisit, undefined);
  // The owner can record a walkthrough they perform even when it is assigned to someone else.
  const owner = await s.call({ ...body, skipTimecard: true }, { user: await cookieFor(env, 'ZacB') });
  assert.equal(owner.status, 200, JSON.stringify(owner.body)); assert.equal(owner.body.visit.walkthroughVisit.startedBy, 'zacb');
});

test('walkthroughs stay excluded from field-jobs, even with an open visit record', async t => {
  const store = fieldStorage(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const fieldEnv = { HUB_SESSION_SECRET: 'synthetic-walkthrough-field-secret', FIREBASE_API_KEY: 'firebase-test-walkthrough-field', HUB_AUTH_USERS_JSON: JSON.stringify({ 'Sales.Rep': { passwordHash: 'unused', role: 'sales', displayName: 'Synthetic Sales Rep' } }) };
  store.put('jobs/w1', { ...walkthrough, walkthroughVisit: { startedAt: NOW, startedBy: 'sales.rep', repTime: { status: 'segment_opened', segmentId: 's1' } } });
  store.put('jobs/job-1', { type: 'job', customer: 'Synthetic Job Customer', address: '1 Job Lane', date: '2026-09-22', time: '11:00', endTime: '13:00', assignedCrew: ['sales.rep'], status: 'scheduled', pipelineStatus: 'scheduled' });
  const cookie = (await createHubSessionCookie(fieldEnv, 'Sales.Rep')).split(';')[0];
  const get = search => fieldJobs.onRequestGet({ env: fieldEnv, request: new Request(`https://easygaragecleaning.com/api/field-jobs${search}`, { headers: { Cookie: cookie } }) });
  const list = await get('?date=2026-09-22');
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).jobs.map(job => job.id), ['job-1']);
  const detail = await get('?jobId=w1');
  assert.equal(detail.status, 404); assert.equal((await detail.json()).code, 'FIELD_JOB_NOT_FOUND');
});

test('walkthrough visit receipts and rep locks are server-only in the Firestore rules', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  for (const collection of ['walkthroughVisitOperations', 'walkthroughVisitLocks']) assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`), collection);
});
