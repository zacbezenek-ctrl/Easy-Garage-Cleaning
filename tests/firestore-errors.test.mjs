import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { classifyCommitFailure, commitConflict, commitFailure, firestoreErrorStatus } from '../functions/_lib/firestore-errors.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { schedulingStorage } from '../functions/_lib/operations-scheduling.js';
import { createBusinessStore } from '../functions/_lib/business-hub-store.js';
import { patchJob, patchJobsAtomic } from '../functions/_lib/firestore-job.js';
import { readGustoRecord, writeGustoRecord } from '../functions/_lib/gusto-store.js';
import { employeeInvitationStore } from '../functions/_lib/employee-accounts.js';
import { createFieldExpenseStore } from '../functions/_lib/field-expenses.js';
import { applyRecordingApproval } from '../functions/_lib/operations-recording-approval.js';
import { consumePortalServiceNonce } from '../functions/_lib/operations-service-auth.js';
import { SERVICE_ORIGINS } from '../egc-platform/services/operations/src/service-auth.ts';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { quoSendHandlers } from '../functions/api/quo-send.js';

// Real Firestore (confirmed on the emulator in tests/firestore-emulator.test.mjs)
// answers a stale currentDocument.updateTime with this exact shape.
const googleError = (status, code) => Response.json({ error: { code: status, message: 'Synthetic Firestore detail', status: code } }, { status });
const STALE = () => googleError(400, 'FAILED_PRECONDITION');
const INVALID = () => googleError(400, 'INVALID_ARGUMENT');
const EXISTS = () => googleError(409, 'ALREADY_EXISTS');
const NOW = '2026-09-22T12:00:00.000Z';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';

test('the classifier separates precondition conflicts from rejected and unknown outcomes', () => {
  const cases = [
    [400, { error: { status: 'FAILED_PRECONDITION' } }, 'stale'],
    [400, JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION' } }), 'stale'],
    [400, [{ error: { status: 'FAILED_PRECONDITION' } }], 'stale'],
    [412, null, 'stale'], [412, { error: { status: 'FAILED_PRECONDITION' } }, 'stale'],
    [409, { error: { status: 'ALREADY_EXISTS' } }, 'exists'],
    [409, { error: { status: 'ABORTED' } }, 'stale'], [409, '', 'stale'], [409, 'not json', 'stale'],
    [400, { error: { status: 'INVALID_ARGUMENT' } }, 'rejected'], [400, '{"error":{"status":"INVALID_ARGUMENT"}}', 'rejected'],
    [404, { error: { status: 'NOT_FOUND' } }, 'rejected'], [403, { error: { status: 'PERMISSION_DENIED' } }, 'rejected'], [429, null, 'rejected'],
    [400, null, 'unknown'], [400, '<html>Bad gateway page</html>', 'unknown'], [400, {}, 'unknown'], [400, { error: 'FAILED_PRECONDITION' }, 'unknown'],
    [500, { error: { status: 'FAILED_PRECONDITION' } }, 'unknown'], [503, null, 'unknown'], [0, null, 'unknown'], [undefined, null, 'unknown'], [200, null, 'unknown'],
  ];
  for (const [status, body, expected] of cases) assert.equal(classifyCommitFailure(status, body), expected, `${status} ${JSON.stringify(body)}`);
  assert.deepEqual(['stale', 'exists', 'rejected', 'unknown', undefined].map(commitConflict), [true, true, false, false, false]);
  assert.equal(firestoreErrorStatus('{"error":{"status":"ABORTED"}}'), 'ABORTED');
  assert.equal(firestoreErrorStatus({ error: { status: 7 } }), '');
});

test('commitFailure reads a Response once and tolerates bodies it cannot read', async () => {
  assert.equal(await commitFailure(STALE()), 'stale');
  assert.equal(await commitFailure(INVALID()), 'rejected');
  assert.equal(await commitFailure(EXISTS()), 'exists');
  assert.equal(await commitFailure(new Response('upstream unavailable', { status: 503 })), 'unknown');
  const used = STALE(); await used.text();
  assert.equal(await commitFailure(used), 'unknown', 'A consumed 400 body cannot prove a precondition failure.');
  assert.equal(await commitFailure({ ok: false, status: 412 }), 'stale');
  assert.equal(await commitFailure({ ok: false, status: 400, text: async () => { throw new Error('stream reset'); } }), 'unknown');
});

test('dispatchStorage reports a stale 400 as dispatch_revision_conflict and a 400 INVALID_ARGUMENT as an unknown outcome', async () => {
  const write = [{ collection: 'jobs', id: 'job-1', revision: '2026-09-22T12:00:00.000001Z', patch: { date: '2026-09-23' } }];
  await assert.rejects(dispatchStorage({}, async () => STALE()).commit(write), error => error.code === 'dispatch_revision_conflict' && error.status === 409);
  await assert.rejects(dispatchStorage({}, async () => EXISTS()).commit([{ collection: 'dispatchOperations', id: 'receipt', patch: { actorId: 'zacb' } }]), error => error.code === 'dispatch_revision_conflict' && error.status === 409);
  await assert.rejects(dispatchStorage({}, async () => INVALID()).commit(write), error => error.code === 'dispatch_outcome_unknown' && error.status === 503);
  await assert.rejects(dispatchStorage({}, async () => new Response('<html>proxy</html>', { status: 400 })).commit(write), error => error.code === 'dispatch_outcome_unknown');
  await assert.rejects(dispatchStorage({}, async () => googleError(404, 'NOT_FOUND')).commit(write), error => error.code === 'dispatch_outcome_unknown');
});

test('a lineage-verified dispatch commit that turns stale rolls back and reports a revision conflict', async () => {
  const calls = [], source = { name: `${ROOT}/jobs/root`, updateTime: 'root-revision', fields: {} };
  const store = dispatchStorage({}, async (_env, url) => {
    const target = String(url); calls.push(target.split(':').pop());
    if (target.endsWith(':beginTransaction')) return Response.json({ transaction: 'synthetic-transaction' });
    if (target.endsWith(':batchGet')) return Response.json([{ found: source }]);
    if (target.endsWith(':rollback')) return Response.json({});
    return STALE();
  });
  await assert.rejects(store.commit([{ collection: 'jobs', id: 'root', revision: 'root-revision', verify: true }, { collection: 'jobs', id: 'new-job', patch: { customerId: 'c1' } }]), error => error.code === 'dispatch_revision_conflict');
  assert.deepEqual(calls, ['beginTransaction', 'batchGet', 'commit', 'rollback']);
});

test('stores built on dispatchStorage inherit the conflict mapping', async () => {
  const { messagingStorage } = await import('../functions/_lib/message-send-store.js');
  const { membershipStorage } = await import('../functions/_lib/garage-guard-membership.js');
  const write = [{ collection: 'message_sends', id: 'ledger', revision: 'r1', patch: { status: 'sending' } }];
  await assert.rejects(messagingStorage({}, async () => STALE()).commit(write), error => error.code === 'messaging_revision_conflict' && error.status === 409);
  await assert.rejects(messagingStorage({}, async () => INVALID()).commit(write), error => error.code === 'messaging_outcome_unknown' && error.status === 503);
  const membership = [{ collection: 'memberships', id: 'sub_synthetic', revision: 'r1', patch: { status: 'active' } }];
  await assert.rejects(membershipStorage({}, async () => STALE()).commit(membership), error => error.code === 'dispatch_revision_conflict' && error.status === 409);
  await assert.rejects(membershipStorage({}, async () => INVALID()).commit(membership), error => error.code === 'dispatch_outcome_unknown' && error.status === 503);
});

test('schedulingStorage reports a stale 400 as schedule_revision_conflict and keeps its outcome-unknown code otherwise', async () => {
  const write = [{ collection: 'jobs', id: 'visit-1', revision: 'r1', patch: { date: '2026-09-23' } }];
  await assert.rejects(schedulingStorage({}, async () => STALE()).commit(write), error => error.message === 'schedule_revision_conflict' && error.status === 409);
  await assert.rejects(schedulingStorage({}, async () => EXISTS()).commit(write), error => error.message === 'schedule_revision_conflict');
  await assert.rejects(schedulingStorage({}, async () => INVALID()).commit(write), error => error.message === 'schedule_commit_outcome_unknown' && error.status === 409);
  await assert.rejects(schedulingStorage({}, async () => googleError(503, 'UNAVAILABLE')).commit(write), error => error.message === 'schedule_commit_outcome_unknown' && error.status === 503);
});

test('the business hub store answers 409 only for precondition failures', async () => {
  const change = [{ collection: 'business_accounts', id: 'a'.repeat(32), version: 'v1', data: { status: 'active' } }];
  const message = 'The record changed or could not be saved. Refresh and retry; no partial update was applied.';
  for (const [reply, status] of [[STALE, 409], [EXISTS, 409], [() => new Response('', { status: 412 }), 409], [INVALID, 503], [() => googleError(503, 'UNAVAILABLE'), 503]]) {
    await assert.rejects(createBusinessStore({}, async () => reply()).commit(change), error => error.status === status && error.publicMessage === message, String(status));
  }
});

test('patchJob and patchJobsAtomic attach the shared classification and keep their messages', async t => {
  const env = { FIREBASE_API_KEY: 'firebase-test-p04' };
  let reply = STALE;
  t.mock.method(globalThis, 'fetch', async input => { assert.equal(new URL(input).hostname, 'firestore.googleapis.com'); return reply(); });
  await assert.rejects(patchJob(env, 'job-1', { status: 'cancelled' }, 'r1'), error => error.message === 'Job storage write failed (400)' && error.storageStatus === 400 && error.storageFailure === 'stale');
  reply = INVALID;
  await assert.rejects(patchJob(env, 'job-1', { status: 'cancelled' }, 'r1'), error => error.storageStatus === 400 && error.storageFailure === 'rejected');
  reply = () => googleError(503, 'UNAVAILABLE');
  await assert.rejects(patchJob(env, 'job-1', { status: 'cancelled' }, 'r1'), error => error.storageFailure === 'unknown');
  reply = STALE;
  await assert.rejects(patchJobsAtomic(env, [{ jobId: 'job-1', patch: { status: 'x' }, updateTime: 'r1' }]), error => error.message === 'Job storage transaction failed (400)' && error.storageFailure === 'stale');
  reply = INVALID;
  await assert.rejects(patchJobsAtomic(env, [{ jobId: 'job-1', patch: { status: 'x' }, updateTime: 'r1' }]), error => error.storageFailure === 'rejected');
});

// Gusto already classified by the Google error status; this pins that the shared classifier keeps that behaviour.
test('Gusto settings writes still report a stale 400 as GUSTO_WRITE_CONFLICT and a bad request as a storage error', async t => {
  const env = { GUSTO_ENVIRONMENT: 'demo', GUSTO_COMPANY_UUID: '11111111-1111-4111-8111-111111111111', FIREBASE_API_KEY: 'firebase-test-p04', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-p04-gusto-vault-secret' };
  const docs = new Map(); let next = null, revision = 0;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), id = url.pathname.split('/').pop();
    assert.ok(url.pathname.includes('/documents/gusto_integrations/'));
    if ((options.method || 'GET') === 'GET') return docs.has(id) ? Response.json(docs.get(id)) : Response.json({}, { status: 404 });
    if (next) { const reply = next; next = null; return reply(); }
    docs.set(id, { ...JSON.parse(options.body), updateTime: `2026-09-22T12:00:00.${String(++revision).padStart(6, '0')}Z` });
    return Response.json(docs.get(id));
  });
  const saved = await writeGustoRecord(env, 'p04-settings', { mode: 'initial' }, null);
  next = STALE;
  await assert.rejects(writeGustoRecord(env, 'p04-settings', { mode: 'raced' }, saved.version), { code: 'GUSTO_WRITE_CONFLICT', status: 409 });
  next = INVALID;
  await assert.rejects(writeGustoRecord(env, 'p04-settings', { mode: 'bad' }, saved.version), { code: 'GUSTO_STORAGE_ERROR', status: 503 });
  next = EXISTS;
  await assert.rejects(writeGustoRecord(env, 'p04-other', { mode: 'twice' }, null), { code: 'GUSTO_WRITE_CONFLICT', status: 409 });
  assert.deepEqual((await readGustoRecord(env, 'p04-settings')).data, { mode: 'initial' });
});

test('employee invitation create-only and activation writes map a stale 400 to their conflicts and a bad request to storage', async t => {
  const env = { FIREBASE_API_KEY: 'firebase-test-p04', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-p04-employee-vault-secret' };
  let reply = EXISTS;
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => { const url = new URL(input); seen.push([options.method, url.searchParams.get('currentDocument.exists'), url.searchParams.get('currentDocument.updateTime')]); return reply(); });
  const store = employeeInvitationStore(env), account = { username: 'synthetic.sales', status: 'approved', displayName: 'Synthetic Sales' };
  await assert.rejects(store.create(account), error => error.message === 'That username is already registered');
  reply = STALE;
  await assert.rejects(store.create(account), error => error.message === 'That username is already registered');
  reply = INVALID;
  await assert.rejects(store.create(account), error => error.code === 'EMPLOYEE_ACCOUNT_STORAGE_UNAVAILABLE');
  reply = STALE;
  await assert.rejects(store.save(account, '2026-09-22T12:00:00.000001Z'), error => error.status === 409 && /already used or the account changed/.test(error.publicMessage));
  reply = INVALID;
  await assert.rejects(store.save(account, '2026-09-22T12:00:00.000001Z'), error => error.code === 'EMPLOYEE_ACCOUNT_STORAGE_UNAVAILABLE');
  assert.deepEqual(seen, [['PATCH', 'false', null], ['PATCH', 'false', null], ['PATCH', 'false', null], ['PATCH', null, '2026-09-22T12:00:00.000001Z'], ['PATCH', null, '2026-09-22T12:00:00.000001Z']]);
});

test('field cost writes map a stale 400 to their revision conflict, including inside the job-fenced transaction', async () => {
  const expense = { id: 'expense-1', __updateTime: 'expense-revision' }, patch = { amountCents: 1200 };
  const direct = reply => createFieldExpenseStore({}, async () => reply());
  await assert.rejects(direct(STALE).update('job-1', expense, patch), { code: 'FIELD_EXPENSE_REVISION_CONFLICT', status: 409 });
  await assert.rejects(direct(INVALID).update('job-1', expense, patch), { code: 'FIELD_STORAGE_UNAVAILABLE', status: 503 });
  await assert.rejects(direct(EXISTS).create('job-1', { id: 'expense-2', amountCents: 500 }), { code: 'FIELD_EXPENSE_CONFLICT', status: 409 });
  const calls = [];
  const fenced = createFieldExpenseStore({}, async (_env, url) => {
    const target = String(url); calls.push(target.split(':').pop());
    if (target.endsWith(':beginTransaction')) return Response.json({ transaction: 'synthetic-transaction' });
    if (target.endsWith(':batchGet')) return Response.json([{ found: { name: `${ROOT}/jobs/job-1`, updateTime: 'job-revision' } }]);
    if (target.endsWith(':rollback')) return Response.json({});
    return STALE();
  });
  await assert.rejects(fenced.update('job-1', expense, patch, { jobRevision: 'job-revision' }), { code: 'FIELD_EXPENSE_REVISION_CONFLICT' });
  assert.deepEqual(calls, ['beginTransaction', 'batchGet', 'commit', 'rollback']);
});

test('recording approval maps a stale 400 to recording_source_revision_conflict unless an identical approval already applied, and a bad request to an unknown outcome', async () => {
  const command = { recordingId: randomUUID(), requestId: randomUUID(), fingerprint: 'a'.repeat(64), portalJobId: 'visit-1', expectedRevision: 'visit-revision', portalVisitId: 'visit-1', portalCustomerId: 'customer-1', portalProjectId: null, extraction: { summary: 'Synthetic scope' } };
  const actor = { id: 'zacb', kind: 'human', role: 'owner' };
  // receipts: what each successive read of operation_recording_approvals/<recordingId> answers.
  const fetcher = (reply, receipts = []) => async (_env, url) => {
    const target = String(url);
    if (target.endsWith(':commit')) return reply();
    if (target.endsWith(`/operation_recording_approvals/${command.recordingId}`)) return (receipts.shift() || (() => Response.json({}, { status: 404 })))();
    if (target.endsWith('/jobs/visit-1')) return Response.json({ name: `${ROOT}/jobs/visit-1`, updateTime: 'visit-revision', fields: encodeFirestoreFields({ type: 'walkthrough', customerId: 'customer-1' }) });
    if (target.endsWith('/customers/customer-1')) return Response.json({ name: `${ROOT}/customers/customer-1`, updateTime: 'customer-revision', fields: {} });
    throw new Error(`Unexpected ${target}`);
  };
  const missing = () => Response.json({}, { status: 404 });
  const receipt = fields => () => Response.json({ name: `${ROOT}/operation_recording_approvals/${command.recordingId}`, updateTime: 'receipt-revision', fields: encodeFirestoreFields({ recordingId: command.recordingId, portalJobId: 'visit-1', fingerprint: command.fingerprint, appliedAt: NOW, ...fields }) });
  await assert.rejects(applyRecordingApproval({}, command, actor, fetcher(STALE)), error => error.message === 'recording_source_revision_conflict' && error.status === 409);
  await assert.rejects(applyRecordingApproval({}, command, actor, fetcher(INVALID)), error => error.message === 'recording_approval_outcome_unknown' && error.status === 503);
  // An overlapping identical request (a Railway retry while the first Hub call still runs) commits first:
  // our job updateTime is stale, but the approval did apply, so this is the same success as a replay.
  assert.deepEqual(await applyRecordingApproval({}, command, actor, fetcher(STALE, [missing, receipt({})])), { ok: true, alreadyApplied: true, recordingId: command.recordingId, appliedAt: NOW });
  await assert.rejects(applyRecordingApproval({}, command, actor, fetcher(STALE, [missing, receipt({ fingerprint: 'b'.repeat(64) })])), error => error.message === 'recording_approval_conflict' && error.status === 409);
  await assert.rejects(applyRecordingApproval({}, command, actor, fetcher(STALE, [missing, receipt({ portalJobId: 'job-2' })])), error => error.message === 'recording_approval_conflict');
  await assert.rejects(applyRecordingApproval({}, command, actor, fetcher(STALE, [missing, () => googleError(503, 'UNAVAILABLE')])), error => error.message === 'recording_approval_outcome_unknown' && error.status === 503, 'An unreadable receipt after a stale commit is not proof that nothing applied.');
});

test('a service nonce collision is a replay, but a rejected nonce write is a store failure', async () => {
  const nonce = '00000000-0000-4000-8000-00000000000a', expiresAt = Date.parse(NOW) / 1000 + 60;
  assert.equal(await consumePortalServiceNonce({}, SERVICE_ORIGINS.api, nonce, expiresAt, async () => EXISTS()), false);
  assert.equal(await consumePortalServiceNonce({}, SERVICE_ORIGINS.api, nonce, expiresAt, async () => STALE()), false);
  await assert.rejects(consumePortalServiceNonce({}, SERVICE_ORIGINS.api, nonce, expiresAt, async () => INVALID()), /service_replay_store_unavailable/);
});

test('Quo receipts: a stale claim re-reads the winner, and a 400 INVALID_ARGUMENT is never treated as a lost race', async t => {
  const env = { HUB_SESSION_SECRET: 'synthetic-p04-session-secret', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-hash', displayName: 'Synthetic Owner', role: 'owner' } }), FIREBASE_API_KEY: 'firebase-test-p04', QUO_API_KEY: 'synthetic-quo-key' };
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0], origin = 'https://easygaragecleaning.com';
  const docs = new Map(), quo = [], receiptReads = [];
  let revision = 0, onClaim = null;
  const save = (path, data) => { docs.set(path, { name: `${ROOT}/${path}`, fields: encodeFirestoreFields(data), updateTime: `2026-09-22T12:00:00.${String(++revision).padStart(6, '0')}Z` }); return docs.get(path); };
  save('jobs/job-1', { type: 'job', customer: 'Dana Synthetic', phone: '(970) 555-0100', address: '1 Synthetic Way' });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'api.openphone.com') { quo.push(options.body); return Response.json({ data: { id: `synthetic-message-${quo.length}` } }); }
    assert.equal(url.hostname, 'firestore.googleapis.com');
    const path = decodeURIComponent(url.pathname.split('/documents/')[1]);
    if (method === 'GET' && path.startsWith('messageReceipts/')) receiptReads.push(path);
    if (method === 'GET') return docs.has(path) ? Response.json(docs.get(path)) : Response.json({}, { status: 404 });
    if (onClaim && path.startsWith('messageReceipts/')) { const reply = onClaim; onClaim = null; return reply(path); }
    const mask = url.searchParams.getAll('updateMask.fieldPaths'), incoming = decodeFirestoreFields(JSON.parse(options.body).fields);
    return Response.json(save(path, mask.length ? { ...decodeFirestoreFields(docs.get(path)?.fields || {}), ...incoming } : incoming));
  });
  const post = key => quoSendHandlers({ now: () => new Date(NOW) }).post({ env, request: new Request(`${origin}/api/quo-send`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ job_id: 'job-1', message: 'Synthetic update for Dana.', idempotency_key: key }) }) });
  onClaim = () => INVALID();
  const refused = await post('p04-invalid-key');
  assert.equal(refused.status, 503); assert.equal((await refused.json()).code, 'QUO_SEND_STORAGE_UNAVAILABLE');
  assert.equal(quo.length, 0, 'An unconfirmed claim never texts the customer.');
  assert.equal(receiptReads.length, 1, 'A rejected claim is a storage failure, not a lost race whose winner must be re-read.');
  const first = await post('p04-raced-key');
  assert.equal(first.status, 200); assert.equal(quo.length, 1);
  const [receiptPath] = [...docs.keys()].filter(path => path.startsWith('messageReceipts/') && decodeFirestoreFields(docs.get(path).fields).idempotencyKey === 'p04-raced-key');
  save(receiptPath, { ...decodeFirestoreFields(docs.get(receiptPath).fields), status: 'rejected' });
  // Another request wins the retry claim between our read and write: our updateTime is now stale.
  onClaim = path => { save(path, { ...decodeFirestoreFields(docs.get(path).fields), status: 'sent', messageId: 'synthetic-winner' }); return STALE(); };
  const raced = await post('p04-raced-key');
  assert.equal(raced.status, 200); assert.deepEqual(await raced.json(), { ok: true, id: 'synthetic-winner', replayed: true });
  assert.equal(quo.length, 1, 'The losing claim does not send a second text.');
});
