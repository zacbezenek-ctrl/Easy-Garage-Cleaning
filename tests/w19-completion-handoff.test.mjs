import test from 'node:test';
import assert from 'node:assert/strict';
import { W19_COMPLETIONS, W19_HANDOFFS, W19_SUBMISSIONS, consumeW19Handoff, prepareW19Handoff, readW19Handoff, w19Balance, w19CompletionProof, w19Configuration } from '../functions/_lib/w19-completion-handoff.js';
import { W19_FORM_ID } from '../functions/_lib/w19-form-submissions.js';
import { fieldCompletionHandoffHandlers } from '../functions/api/field-completion-handoff.js';
import { w19CompletionGateHandlers } from '../functions/api/w19-completion-gate.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { W19_FORM_NAME, W19_FORM_URL, W19_NATIVE_FIELDS } from '../functions/_lib/w19-native-form.js';

const NOW = '2026-10-16T00:30:00.000Z', COMPLETED = '2026-10-16T00:00:00.000Z';
const COMPLETE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PHOTO_IDS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const LEAD = { user: 'lead.one', displayName: 'Synthetic Lead', role: 'crew_lead' };
const env = () => ({ HUB_SESSION_SECRET: 'synthetic-w19-purpose-secret-0123456789abcdef', EGC_W19_COMPLETION_HANDOFF: 'true', EGC_W19_COMPLETION_WORKFLOW_READY: 'true',
  HIGHLEVEL_API_KEY: 'synthetic-provider-token', HIGHLEVEL_LOCATION_ID: 'location-1',
  EGC_W19_COMPLETION_FORM_URL: `https://api.leadconnectorhq.com/widget/form/${W19_FORM_ID}`,
  EGC_W19_COMPLETION_QUERY_KEYS_JSON: JSON.stringify({ jobId: 'verified_job_key', reference: 'verified_ref_key', contactId: 'verified_contact_key' }),
  EGC_W19_COMPLETION_RECEIPT_FIELDS_JSON: JSON.stringify({ jobId: 'verifiedJobField', reference: 'verifiedRefField' }),
  HUB_AUTH_USERS_JSON: JSON.stringify({ 'lead.one': { passwordHash: 'synthetic', displayName: 'Synthetic Lead', role: 'crew_lead' }, 'crew.two': { passwordHash: 'synthetic', role: 'crew' } }) });
function job(overrides = {}) {
  return { id: 'job-a', type: 'job', date: '2026-10-15', time: '09:30', assignedCrew: ['lead.one', 'crew.two'], crewLead: 'lead.one',
    highlevelContactId: 'contact-a', status: 'completed', pipelineStatus: 'completed', completedAt: COMPLETED,
    fieldExecution: { checklistTemplate: [{ id: 'finish', stage: 'finish', label: 'Clean up', required: true }], checks: { finish: { completed: true, at: COMPLETED, actorId: 'crew.two' } },
      photos: PHOTO_IDS.map((id, index) => ({ id, fileId: `verified-${index}`, verified: true, category: index ? 'after' : 'before' })),
      completion: { completedAt: COMPLETED, actorId: 'crew.two', actorName: 'Synthetic Crew', notes: 'Verified cleanup and agreed work completed.', hasIssues: false, issueNotes: '', evidencePhotoIds: PHOTO_IDS } },
    completionEvidence: { kind: 'verified_field_execution', requestId: COMPLETE_ID, actorId: 'crew.two', recordedAt: COMPLETED, photoIds: PHOTO_IDS },
    estimate: { amount: 1000, depositRequired: 250, status: 'approved', revision: 1 }, customerApproval: { status: 'approved', amount: 1000, approvedAt: '2026-10-14T16:00:00.000Z', estimateRevision: 1 },
    payment: { verified: true, amount: 250, stripeSessions: [{ sessionId: 'cs_test_confirmed', purpose: 'deposit', amount: 250, verifiedAt: COMPLETED }] },
    invoice: { status: 'not_issued' }, commission: { status: 'not_earned', amount: 0 }, ...overrides };
}
const event = () => ({ id: COMPLETE_ID, action: 'complete', state: 'applied', actorId: 'crew.two', createdAt: COMPLETED, toStatus: 'completed', body: 'Verified cleanup and agreed work completed.', fingerprint: 'a'.repeat(64) });
function memory(initial = job()) {
  const rows = new Map(); let sequence = 0, failAfter = false, beforeCommit;
  const put = (collection, id, data) => rows.set(`${collection}/${id}`, { ...structuredClone(data), id, revision: `r${++sequence}` });
  put('jobs', initial.id, initial); put(`jobs/${initial.id}/fieldEvents`, COMPLETE_ID, event());
  return { rows, put, get: (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    failNextAfterCommit() { failAfter = true; }, before(fn) { beforeCommit = fn; },
    async read(collection, id) { return this.get(collection, id); },
    async commit(writes) {
      if (beforeCommit) { const hook = beforeCommit; beforeCommit = null; await hook(writes); }
      for (const write of writes) {
        const current = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? current?.revision !== write.revision : Boolean(current)) throw Object.assign(new Error('synthetic stale revision'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes.filter(write => !write.verify)) put(write.collection, write.id, { ...rows.get(`${write.collection}/${write.id}`), ...write.patch });
      if (failAfter) { failAfter = false; throw Object.assign(new Error('synthetic lost response'), { code: 'dispatch_outcome_unknown', status: 503 }); }
    } };
}
const input = store => ({ action: 'prepare', jobId: 'job-a', requestId: crypto.randomUUID(), expectedRevision: store.get('jobs', 'job-a').revision, expectedUser: LEAD.user });
async function prepare(store, settings = env(), actor = LEAD, extra = {}) { return prepareW19Handoff(settings, store, await store.read('jobs', 'job-a'), actor, { ...input(store), ...extra }, NOW); }
const reference = store => [...store.rows.entries()].find(([key]) => key.startsWith(`${W19_HANDOFFS}/`))[1].reference;
const receipt = (record, id = 'submission-a') => ({ reference: record.reference, submissionId: id, jobId: record.jobId, contactId: record.contactId, locationId: record.locationId, formId: W19_FORM_ID, createdAt: NOW });
async function consume(store, { settings = env(), id = 'submission-a', reader, now = NOW, ...options } = {}) {
  const ref = reference(store), row = await store.read(W19_HANDOFFS, ref);
  return consumeW19Handoff(settings, store, { reference: ref, contactId: row.contactId, ...(id ? { submissionId: id } : {}) }, now, { submission: reader || (async () => receipt(row, id || 'submission-a')), ...options });
}

test('setup is fail closed and accepts only the pinned provider form with exact supplied mappings', () => {
  assert.deepEqual(w19Configuration(env()).missing, []);
  for (const value of ['', 'https://evil.example/widget/form/' + W19_FORM_ID, 'https://api.leadconnectorhq.com.evil.example/widget/form/' + W19_FORM_ID,
    `https://api.leadconnectorhq.com/widget/form/${W19_FORM_ID}?contact=private`, `https://api.leadconnectorhq.com/widget/form/${W19_FORM_ID}#ref`, 'http://api.leadconnectorhq.com/widget/form/' + W19_FORM_ID]) {
    assert.ok(w19Configuration({ ...env(), EGC_W19_COMPLETION_FORM_URL: value }).missing.length);
  }
  for (const value of ['', '{}', '{"jobId":"same","reference":"same","contactId":"same"}', '{"jobId":"x","reference":"y","contactId":"z","extra":"no"}']) assert.ok(w19Configuration({ ...env(), EGC_W19_COMPLETION_QUERY_KEYS_JSON: value }).missing.length);
  assert.ok(w19Configuration({ ...env(), EGC_W19_COMPLETION_WORKFLOW_READY: 'false' }).missing.length);
});

test('verified native field mappings are available by default; absent contact association still blocks launch', () => {
  const settings = env(); delete settings.EGC_W19_COMPLETION_QUERY_KEYS_JSON; delete settings.EGC_W19_COMPLETION_RECEIPT_FIELDS_JSON;
  const config = w19Configuration(settings);
  assert.equal(W19_FORM_NAME, 'EGC Job Completion Confirmation');
  assert.deepEqual(config.fieldIds, { jobId: 'pKArVLKFAIEzNPMPJ7EL', reference: 'WypOwqgzXpVP0we0Jf35' });
  assert.equal(config.queryKeys, null); assert.ok(config.missing.some(item => /prefill/.test(item)));
  const knownContact = w19Configuration({ ...settings, EGC_W19_COMPLETION_CONTACT_QUERY_KEY: 'fixture_verified_contact_key' });
  assert.equal(knownContact.queryKeys.jobId, 'egc_completion_job_id'); assert.equal(knownContact.queryKeys.reference, 'egc_completion_reference');
  assert.equal(Object.keys(W19_NATIVE_FIELDS).length, 7);
  delete settings.EGC_W19_COMPLETION_FORM_URL;
  assert.equal(w19Configuration(settings).formUrl, W19_FORM_URL);
});

test('proof derives actual Denver completion date and preserves original actor separately from confirming lead', async () => {
  const store = memory(), proof = await w19CompletionProof(await store.read('jobs', 'job-a'), await store.read('jobs/job-a/fieldEvents', COMPLETE_ID));
  assert.equal(proof.completedDate, '2026-10-15'); assert.equal(proof.completionActorId, 'crew.two');
  const view = await prepare(store);
  assert.equal(view.status, 'prepared'); assert.equal(view.completedDate, '2026-10-15');
  const record = await store.read(W19_HANDOFFS, reference(store));
  assert.equal(record.completionActorId, 'crew.two'); assert.equal(record.confirmingLeadId, LEAD.user);
  const url = new URL(view.launchUrl);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['verified_contact_key', 'verified_job_key', 'verified_ref_key']);
  assert.equal(url.searchParams.get('verified_contact_key'), 'contact-a');
  assert.doesNotMatch(view.launchUrl, /notes|payment|75000|Synthetic/);
});

test('missing form inputs, unassigned named lead, ordinary crew and unassigned managers cannot prepare', async () => {
  const store = memory();
  for (const actor of [{ user: 'crew.two', role: 'crew' }, { user: 'owner', role: 'owner', businessAccess: true }]) await assert.rejects(prepare(store, env(), actor), { code: 'W19_LEAD_REQUIRED' });
  const unassigned = memory(job({ assignedCrew: ['crew.two'] }));
  await assert.rejects(prepare(unassigned), { code: 'W19_LEAD_REQUIRED' });
  await assert.rejects(prepare(store, { ...env(), EGC_W19_COMPLETION_RECEIPT_FIELDS_JSON: '' }), { code: 'W19_SETUP_REQUIRED' });
  assert.equal([...store.rows.keys()].some(key => key.startsWith(W19_HANDOFFS)), false);
});

test('unverified completion, checklist, original photos or receipt cannot mint an intent', async () => {
  for (const mutate of [row => { row.status = row.pipelineStatus = 'in_progress'; }, row => { row.completionEvidence.kind = 'legacy'; }, row => { row.fieldExecution.checks.finish.completed = false; },
    row => { row.fieldExecution.photos[1].verified = false; }, row => { row.fieldExecution.completion.hasIssues = true; }, row => { row.completedAt = NOW; }]) {
    const value = job(); mutate(value); await assert.rejects(prepare(memory(value)), { code: 'W19_COMPLETION_UNVERIFIED' });
  }
  const store = memory(); store.put('jobs/job-a/fieldEvents', COMPLETE_ID, { ...event(), state: 'pending' });
  await assert.rejects(prepare(store), { code: 'W19_COMPLETION_UNVERIFIED' });
});

test('repeated clicks, stale retry and secret rotation reuse one root-independent business intent', async () => {
  const store = memory(), staleInput = input(store), first = await prepare(store);
  const again = await prepare(store, env(), LEAD, staleInput);
  assert.equal(again.launchUrl, first.launchUrl); assert.equal(again.alreadyPrepared, true);
  const rotated = { ...env(), HUB_SESSION_SECRET: 'synthetic-rotated-root-0123456789abcdef012345' };
  assert.equal((await prepare(store, rotated)).launchUrl, first.launchUrl);
  assert.equal([...store.rows.keys()].filter(key => key.startsWith(W19_HANDOFFS)).length, 1);
  assert.equal([...store.rows.keys()].filter(key => key.startsWith(W19_COMPLETIONS)).length, 1);
  assert.equal((await consume(store, { settings: rotated })).proceed, true);
  assert.equal((await consume(store)).proceed, false);
});

test('lost local prepare response recovers the same intent; stale first preparation cannot write', async () => {
  const store = memory(); store.failNextAfterCommit();
  assert.equal((await prepare(store)).alreadyPrepared, true);
  const stale = memory(); await assert.rejects(prepare(stale, env(), LEAD, { expectedRevision: 'stale' }), { code: 'W19_REVISION_CONFLICT' });
});

test('only one provider submission releases W19, with trusted date, notes and remaining balance', async () => {
  const store = memory(), original = job(); await prepare(store);
  const result = await consume(store);
  assert.equal(result.proceed, true); assert.equal(result.completedDate, '2026-10-15');
  assert.equal(result.verifiedWorkNotes, original.fieldExecution.completion.notes);
  assert.equal(result.opportunityId, null);
  assert.deepEqual((await store.read(W19_HANDOFFS, reference(store))).completionSnapshot.verifiedWorkNotes, original.fieldExecution.completion.notes);
  assert.deepEqual(result.balance, { approvedTotalCents: 100000, confirmedAppliedCents: 25000, balanceDueCents: 75000, currency: 'USD' });
  assert.match(result.taskMarker, /^egc-w19:w19_/);
  assert.equal((await consume(store)).proceed, false);
  assert.equal((await consume(store, { id: 'submission-b' })).proceed, false);
  const saved = await store.read('jobs', 'job-a');
  for (const key of ['status', 'pipelineStatus', 'payment', 'invoice', 'commission', 'estimate', 'customerApproval']) assert.deepEqual(saved[key], original[key], key);
  assert.equal([...store.rows.keys()].filter(key => key.startsWith(W19_SUBMISSIONS)).length, 1);
});

test('reference-only reconciliation still requires exact workflow contact and real provider receipt evidence', async () => {
  const store = memory(); await prepare(store); const row = await store.read(W19_HANDOFFS, reference(store));
  await assert.rejects(consumeW19Handoff(env(), store, { reference: row.reference, contactId: 'wrong-contact' }, NOW), { code: 'W19_CONTACT_MISMATCH' });
  await assert.rejects(consumeW19Handoff(env(), store, { reference: row.reference }, NOW), { code: 'W19_REQUEST_INVALID' });
  const result = await consume(store, { id: null, reader: async (_, hint) => { assert.equal(hint.submissionId, undefined); assert.equal(hint.contactId, row.contactId); return receipt(row); } });
  assert.equal(result.proceed, true);
});

test('concurrent submissions cannot release duplicate tasks and a lost claim response never releases again', async () => {
  const store = memory(); await prepare(store);
  const results = await Promise.all([consume(store), consume(store, { id: 'submission-b' })]);
  assert.equal(results.filter(row => row.proceed).length, 1);
  const lost = memory(); await prepare(lost); lost.failNextAfterCommit();
  assert.deepEqual(await consume(lost), { ok: true, proceed: false, status: 'released_unconfirmed', reason: 'claim_response_unconfirmed' });
  assert.equal((await consume(lost)).proceed, false);
  assert.equal((await lost.read(W19_HANDOFFS, reference(lost))).taskStatus, 'unknown');
});

test('opportunity routing verifies only the exact saved job opportunity and never chooses the contact\'s newest deal', async () => {
  const store = memory(job({ highlevelOpportunityId: 'opportunity-a' })); await prepare(store); let lookups = 0;
  const result = await consume(store, { opportunity: async (_, bound) => { lookups++; assert.deepEqual(bound, { opportunityId: 'opportunity-a', contactId: 'contact-a', locationId: 'location-1' }); return { id: bound.opportunityId, contactId: bound.contactId, locationId: bound.locationId }; } });
  assert.equal(lookups, 1); assert.deepEqual(result.opportunity, { status: 'verified', canUpdate: true, id: 'opportunity-a' });
  const missing = memory(); await prepare(missing);
  assert.deepEqual((await consume(missing, { opportunity: () => assert.fail('No search for a guessed opportunity') })).opportunity, { status: 'missing', canUpdate: false, id: null });
  const mismatch = memory(job({ highlevelOpportunityId: 'opportunity-a' })); await prepare(mismatch);
  await assert.rejects(consume(mismatch, { opportunity: async () => ({ id: 'opportunity-a', contactId: 'wrong-contact', locationId: 'location-1' }) }), { code: 'W19_OPPORTUNITY_REVIEW_REQUIRED' });
  assert.equal((await mismatch.read(W19_HANDOFFS, reference(mismatch))).state, 'prepared');
  const changed = memory(job({ highlevelOpportunityId: 'opportunity-a' })); await prepare(changed);
  const saved = await changed.read('jobs', 'job-a'); changed.put('jobs', 'job-a', { ...saved, highlevelOpportunityId: 'opportunity-b' });
  await assert.rejects(consume(changed), { code: 'W19_HANDOFF_STALE' });
});

test('provider read failures are visible and recoverable without consuming or resubmitting the form', async () => {
  const store = memory(); await prepare(store); let reads = 0;
  const reader = async () => { reads++; throw Object.assign(new Error('safe provider error'), { code: 'w19-provider-unavailable', status: 503 }); };
  await assert.rejects(consume(store, { reader }), { code: 'w19-provider-unavailable' });
  assert.equal(reads, 1);
  const row = await store.read(W19_HANDOFFS, reference(store));
  assert.equal(row.state, 'prepared'); assert.equal(row.lastCheckCode, 'w19-provider-unavailable');
  const view = await readW19Handoff(env(), store, await store.read('jobs', 'job-a'), LEAD, NOW);
  assert.match(view.message, /do not submit the form again/);
  assert.equal((await consume(store)).proceed, true);
});

test('cancelled, removed, reassigned, changed-contact, changed-evidence and revoked-lead confirmations fail closed', async () => {
  for (const mutate of [row => { row.status = 'cancelled'; }, row => { row.highlevelContactId = 'other-contact'; }, row => { row.assignedCrew = ['crew.two']; },
    row => { row.crewLead = 'crew.two'; }, row => { row.fieldExecution.completion.notes = 'A changed and unverified closeout'; }]) {
    const store = memory(); await prepare(store); const value = await store.read('jobs', 'job-a'); mutate(value); store.put('jobs', 'job-a', value);
    await assert.rejects(consume(store));
    assert.equal((await store.read(W19_HANDOFFS, reference(store))).state, 'prepared');
  }
  const removed = memory(); await prepare(removed); removed.rows.delete('jobs/job-a'); await assert.rejects(consume(removed), { code: 'W19_COMPLETION_UNVERIFIED' });
  const revoked = memory(); await prepare(revoked);
  await assert.rejects(consume(revoked, { settings: { ...env(), HUB_AUTH_USERS_JSON: '{}' } }), { code: 'W19_LEAD_CHANGED' });
  const changedLocation = memory(); await prepare(changedLocation);
  await assert.rejects(consume(changedLocation, { settings: { ...env(), HIGHLEVEL_LOCATION_ID: 'other-location' } }), { code: 'W19_HANDOFF_STALE' });
});

test('a canonical change during provider verification or just before commit cannot release W19', async () => {
  const store = memory(); await prepare(store); const record = await store.read(W19_HANDOFFS, reference(store));
  await assert.rejects(consume(store, { reader: async () => { const value = await store.read('jobs', 'job-a'); store.put('jobs', 'job-a', { ...value, pipelineStatus: 'cancelled' }); return receipt(record); } }), { code: 'W19_COMPLETION_UNVERIFIED' });
  const race = memory(); await prepare(race);
  race.before(() => { const value = race.get('jobs', 'job-a'); race.put('jobs', 'job-a', { ...value, highlevelContactId: 'changed' }); });
  await assert.rejects(consume(race), { code: 'dispatch_revision_conflict' });
  assert.equal((await race.read(W19_HANDOFFS, reference(race))).state, 'prepared');
});

test('harmless CRM sync metadata and extra photos preserve the proof, but expiry never refreshes itself', async () => {
  const store = memory(); await prepare(store); const value = await store.read('jobs', 'job-a');
  value.fieldCompletionSync = { attempts: 8, status: 'synced' };
  value.fieldExecution.photos.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fileId: 'extra', verified: true, category: 'progress' });
  store.put('jobs', 'job-a', value);
  assert.equal((await prepare(store)).canLaunch, true);
  const later = '2026-10-24T00:30:00.000Z';
  assert.equal((await readW19Handoff(env(), store, await store.read('jobs', 'job-a'), LEAD, later)).status, 'expired');
  await assert.rejects(consume(store, { now: later }), { code: 'W19_REFERENCE_EXPIRED' });
  const row = await store.read(W19_HANDOFFS, reference(store));
  await assert.rejects(consume(store, { clock: () => row.expiresAt }), { code: 'W19_REFERENCE_EXPIRED' });
});

test('money needs current approval and fully reconciled verified job receipts; the form cannot supply money', () => {
  for (const change of [{ customerApproval: { status: 'superseded' } }, { customerApproval: { status: 'approved', estimateRevision: 9 } },
    { customerApproval: { status: 'approved', amount: 500, approvedAt: COMPLETED } }, { customerApproval: { status: 'approved', amount: 1000 } },
    { payment: { amount: 250, verified: false } }, { payment: { amount: 250, verified: true } }, { refunds: [{ amount: 1 }] }]) assert.throws(() => w19Balance(job(change)), { code: 'W19_MONEY_REVIEW_REQUIRED' });
  assert.deepEqual(w19Balance(job({ payment: {} })), { approvedTotalCents: 100000, confirmedAppliedCents: 0, balanceDueCents: 100000, currency: 'USD' });
});

const request = (path, body, headers = {}) => new Request(`https://hub.example${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://hub.example', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
test('HTTP endpoints enforce origin, fresh account, assignment, bounded strict inputs and off switches', async () => {
  const store = memory(), settings = env(); let actor = LEAD;
  const handlers = fieldCompletionHandoffHandlers({ session: async () => actor, storage: () => store, configured: () => true, now: () => new Date(NOW) });
  const get = req => handlers.get({ request: req, env: settings });
  const post = (body, headers) => handlers.post({ request: request('/api/field-completion-handoff', body, headers), env: settings });
  assert.equal((await get(request('/api/field-completion-handoff?jobId=job-a'))).status, 200);
  actor = { user: 'crew.two', role: 'crew' }; assert.equal((await get(request('/api/field-completion-handoff?jobId=job-a'))).status, 403);
  actor = null; assert.equal((await post(input(store))).status, 401); actor = LEAD;
  assert.equal((await post(input(store), { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await post({ ...input(store), expectedUser: 'crew.two' })).status, 401);
  assert.equal((await post({ ...input(store), paymentCollected: true })).status, 400);
  assert.equal((await post('x'.repeat(4097))).status, 413);
  assert.equal((await get(request('/api/field-completion-handoff?jobId=job-a&jobId=job-b'))).status, 400);
  const off = await handlers.get({ request: request('/api/field-completion-handoff?jobId=job-a'), env: { ...settings, EGC_W19_COMPLETION_HANDOFF: 'false' } });
  assert.equal(off.status, 404);
  const prepared = await post(input(store)); assert.equal(prepared.status, 200); assert.equal(prepared.headers.get('Cache-Control'), 'private, no-store');
  const gate = w19CompletionGateHandlers({ storage: () => store, configured: () => true, now: () => new Date(NOW), submission: async (_, data) => receipt(data) });
  const response = await gate.post({ request: request('/api/w19-completion-gate', { reference: reference(store), contactId: 'contact-a', submissionId: 'submission-a', paid: true }), env: settings });
  assert.equal(response.status, 400); assert.equal((await response.json()).proceed, false);
  const accepted = await gate.post({ request: request('/api/w19-completion-gate', { reference: reference(store), contactId: 'contact-a', submissionId: 'submission-a' }), env: settings });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).proceed, true);
});

test('production Firestore adapter atomically fences the nested completion event and create-only business/submission claims', async t => {
  const documents = new Map(), transactions = new Map(), calls = []; let version = 0;
  const root = 'projects/egcw-1ec83/databases/(default)/documents';
  function put(path, value) { documents.set(path, { name: `${root}/${path}`, fields: encodeFirestoreFields(value), updateTime: `2026-10-16T00:30:00.${String(++version).padStart(9, '0')}Z` }); }
  put('jobs/job-a', job()); put(`jobs/job-a/fieldEvents/${COMPLETE_ID}`, event());
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input); assert.equal(url.hostname, 'firestore.googleapis.com', 'Tests cannot reach a provider or live job service');
    assert.equal(url.searchParams.get('key'), 'firebase-test-w19');
    const path = decodeURIComponent(url.pathname.split('/documents')[1] || '').replace(/^\//, ''), method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ path, method, body });
    if (path === ':beginTransaction') { const transaction = `synthetic-transaction-${transactions.size}`; transactions.set(transaction, new Map()); return Response.json({ transaction }); }
    if (path === ':batchGet') {
      const reads = transactions.get(body.transaction); assert.ok(reads);
      return Response.json(body.documents.map(name => { const key = name.split('/documents/')[1], doc = documents.get(key); reads.set(key, doc?.updateTime); return doc ? { found: { ...doc, fields: {} } } : { missing: name }; }));
    }
    if (path === ':rollback') return Response.json({});
    if (path === ':commit') {
      const reads = transactions.get(body.transaction); assert.ok(reads, 'Canonical completion proof must be transaction-fenced');
      for (const [key, revision] of reads) if (documents.get(key)?.updateTime !== revision) return Response.json({}, { status: 409 });
      for (const write of body.writes) {
        const key = write.update.name.split('/documents/')[1], current = documents.get(key);
        if (write.currentDocument.exists === false ? Boolean(current) : current?.updateTime !== write.currentDocument.updateTime) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
        if (key === 'jobs/job-a') assert.deepEqual(write.updateMask.fieldPaths, ['w19CompletionHandoff']);
      }
      for (const write of body.writes) {
        const key = write.update.name.split('/documents/')[1]; put(key, { ...decodeFirestoreFields(documents.get(key)?.fields || {}), ...decodeFirestoreFields(write.update.fields) });
      }
      return Response.json({ commitTime: NOW });
    }
    assert.equal(method, 'GET'); return documents.has(path) ? Response.json(documents.get(path)) : Response.json({}, { status: 404 });
  });
  const settings = { ...env(), FIREBASE_API_KEY: 'firebase-test-w19' }, store = dispatchStorage(settings), initial = await store.read('jobs', 'job-a');
  const prepared = await prepareW19Handoff(settings, store, initial, LEAD, { action: 'prepare', requestId: crypto.randomUUID(), expectedRevision: initial.revision }, NOW);
  const ref = new URL(prepared.launchUrl).searchParams.get('verified_ref_key'), record = await store.read(W19_HANDOFFS, ref);
  const released = await consumeW19Handoff(settings, store, { reference: ref, contactId: 'contact-a', submissionId: 'submission-a' }, NOW, { submission: async () => receipt(record) });
  assert.equal(released.proceed, true);
  const again = await consumeW19Handoff(settings, store, { reference: ref, contactId: 'contact-a', submissionId: 'submission-b' }, NOW, { submission: async () => assert.fail('Already released gates must not query again') });
  assert.equal(again.proceed, false);
  assert.equal(calls.filter(call => call.path === ':commit').length, 2);
  assert.ok(calls.filter(call => call.path === ':batchGet').every(call => call.body.documents.length === 1 && call.body.documents[0].endsWith(`/jobs/job-a/fieldEvents/${COMPLETE_ID}`)));
  const commits = calls.filter(call => call.path === ':commit');
  assert.deepEqual(commits.map(call => call.body.writes.filter(write => write.currentDocument.exists === false).length), [2, 1]);
  const saved = await store.read('jobs', 'job-a');
  assert.deepEqual(saved.payment, job().payment); assert.deepEqual(saved.invoice, job().invoice); assert.deepEqual(saved.commission, job().commission);
});
