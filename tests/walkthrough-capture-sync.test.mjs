import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWalkthroughCaptureSync, syncWalkthroughCapture, walkthroughCaptureSyncView } from '../functions/_lib/walkthrough-capture-sync.js';
import { quoteDraftHandlers } from '../functions/api/quote-draft.js';
import { syncNativeNote } from '../functions/_lib/operations-note-sync.js';
import { verifyOperationsEnvelope } from '../functions/_lib/operations-envelope.js';
const NOW = '2026-10-14T17:00:00Z';
const owner = { user: 'zacb', role: 'owner', businessAccess: true };
const ENV = { EGC_WALKTHROUGH_CAPTURE_SYNC: 'true', EGC_MESSAGING_DRY_RUN: 'false', EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy', EGC_OPERATIONS_API_ORIGIN: 'https://fixture.invalid', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: 'synthetic-capture-key-012345678901234567890' };
function fixture() {
  let job = { id: 'job-1', revision: 'r0', type: 'job', customerId: 'customer-1', highlevelContactId: 'contact-1', quoteDraft: { version: 1 },
    jobInstructions: { keepItems: 'Albums', removeItems: 'Couch', hazards: ['Pest waste (+$200)'], accessNotes: 'Side gate', operationalScope: 'Keep 2 albums ($99)' }, internalNotes: 'Private margin $500' };
  job.walkthroughCaptureSync = prepareWalkthroughCaptureSync(job, NOW);
  let customer = { id: 'customer-1', highlevelContactId: 'contact-1' }, revision = 0;
  const writes = [], calls = [];
  const store = { read: async (collection, id) => structuredClone(collection === 'jobs' && id === job.id ? job : collection === 'customers' ? customer : null),
    commit: async rows => { for (const row of rows) { assert.equal(row.revision, job.revision); writes.push(structuredClone(row)); job = { ...job, ...structuredClone(row.patch), revision: 'r' + ++revision }; } } };
  const note = async (...args) => { calls.push(structuredClone(args)); return { note: { id: 'note-1' }, providerSync: 'verified', outboxId: 'outbox-1' }; };
  return { store, writes, calls, note, job: () => job, setJob: row => { job = row; }, customer: value => { customer = value; }, input: () => ({ jobId: job.id, syncKey: job.walkthroughCaptureSync.key }) };
}
test('saved note intent is stable, bounded, money-stripped and excludes manager/approval fields', () => {
  const f = fixture(), intent = f.job().walkthroughCaptureSync;
  assert.match(intent.body, /Keep: Albums/); assert.match(intent.body, /Side gate/); assert.match(intent.body, /Keep 2 albums/);
  assert.doesNotMatch(intent.body, /\$|Private margin|signature|deposit/);
  assert.deepEqual(prepareWalkthroughCaptureSync(f.job(), 'later'), intent);
  assert.equal(walkthroughCaptureSyncView(f.job()).body, undefined);
  const tooLong = prepareWalkthroughCaptureSync({ ...f.job(), jobInstructions: { keepItems: 'x'.repeat(21000) } }, NOW);
  assert.equal(tooLong.status, 'needs_review'); assert.equal(tooLong.body, '');
});
test('default-off and dry-run never touch provider or mutate pending state', async () => {
  for (const env of [{}, { ...ENV, EGC_MESSAGING_DRY_RUN: 'true' }, { ...ENV, EGC_OPERATIONS_ENABLED: 'false' }]) {
    const f = fixture(); const result = await syncWalkthroughCapture(f.store, owner, f.input(), NOW, { env, note: f.note });
    assert.equal(result.enabled, false); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
  }
});
test('verified canonical link and shared outbox adapter sync once and report only verified receipt', async () => {
  const f = fixture();
  const note = async (env, actor, input) => syncNativeNote(env, actor, input, async (url, options) => {
    const envelope = await verifyOperationsEnvelope(JSON.parse(options.body).envelope, ENV.EGC_OPERATIONS_PORTAL_SIGNING_SECRET, 'egc-operations');
    f.calls.push(envelope.request.body);
    assert.equal(envelope.actor.id, 'hub-note:zacb');
    assert.deepEqual([envelope.request.body.portalJobId, envelope.request.body.providerContactId, envelope.request.body.scope], ['job-1', 'contact-1', 'unsigned_walkthrough']);
    return Response.json({ ok: true, authority: 'employee_hub', portalJobId: 'job-1', providerSync: 'verified', noteId: 'note-1', outboxId: 'outbox-1' });
  });
  const result = await syncWalkthroughCapture(f.store, owner, f.input(), NOW, { env: ENV, note });
  assert.equal(result.state.status, 'synced');
  await syncWalkthroughCapture(f.store, owner, f.input(), NOW, { env: ENV, note });
  assert.equal(f.calls.length, 1);
});
test('unknown outcome stays pending and retries the exact durable note identity and body', async () => {
  const f = fixture(); let count = 0;
  const note = async (...args) => { f.calls.push(structuredClone(args)); if (!count++) throw Object.assign(new Error('private provider detail'), { code: 'provider_note_outcome_unknown' }); return { note: { id: 'note-1' }, providerSync: 'verified' }; };
  assert.equal((await syncWalkthroughCapture(f.store, owner, f.input(), NOW, { env: ENV, note })).state.status, 'pending');
  assert.equal((await syncWalkthroughCapture(f.store, owner, f.input(), NOW, { env: ENV, note })).state.status, 'synced');
  assert.deepEqual(f.calls[0][2], f.calls[1][2]);
  assert.doesNotMatch(JSON.stringify(walkthroughCaptureSyncView(f.job())), /private provider/);
});
test('missing/conflicting contact needs linking; provider errors remain visible without private detail', async () => {
  const f = fixture(); f.customer({ highlevelContactId: 'wrong-contact' });
  assert.equal((await syncWalkthroughCapture(f.store, owner, f.input(), NOW, { env: ENV, note: f.note })).state.status, 'needs_link');
  assert.equal(f.calls.length, 0);
  f.customer({ highlevelContactId: 'contact-1' });
  const failed = await syncWalkthroughCapture(f.store, owner, f.input(), NOW, { env: ENV, note: async () => { throw new Error('credential secret'); } });
  assert.equal(failed.state.status, 'error'); assert.equal(failed.state.code, 'provider_sync_failed');
});
test('old provider completion cannot overwrite a newer saved capture', async () => {
  const f = fixture(), original = f.input();
  const result = await syncWalkthroughCapture(f.store, owner, original, NOW, { env: ENV, note: async () => {
    const latest = { ...f.job(), jobInstructions: { keepItems: 'New instructions' }, revision: 'newer' };
    latest.walkthroughCaptureSync = prepareWalkthroughCaptureSync(latest, NOW); f.setJob(latest);
    return { note: { id: 'old-note' }, providerSync: 'verified' };
  } });
  assert.equal(result.state.status, 'pending'); assert.notEqual(result.state.key, original.syncKey);
  assert.equal(f.job().walkthroughCaptureSync.noteId, undefined);
});
test('anonymous/crew and caller-supplied destination/content are refused before provider writes', async () => {
  const f = fixture();
  for (const actor of [null, { user: 'crew', role: 'crew' }]) await assert.rejects(syncWalkthroughCapture(f.store, actor, f.input(), NOW, { env: ENV, note: f.note }), error => [401, 403].includes(error.status));
  await assert.rejects(syncWalkthroughCapture(f.store, owner, { ...f.input(), contactId: 'wrong', body: 'forged' }, NOW, { env: ENV, note: f.note }), error => error.status === 400);
  await assert.rejects(syncWalkthroughCapture(f.store, owner, { ...f.input(), actorId: 'other-employee' }, NOW, { env: ENV, note: f.note }), error => error.status === 403);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
test('changed contact linkage or a tampered frozen body must be saved again, never sent under an old identity', async () => {
  for (const change of [job => { job.highlevelContactId = 'other-contact'; }, job => { job.walkthroughCaptureSync.body = 'forged staff or payment content'; }]) {
    const f = fixture(), input = f.input(); change(f.job());
    await assert.rejects(syncWalkthroughCapture(f.store, owner, input, NOW, { env: ENV, note: f.note }), error => error.code === 'quote_draft_capture_changed');
    assert.equal(f.calls.length, 0);
  }
});
test('authenticated endpoint reads only saved IDs and returns safe status, not the internal body', async () => {
  const f = fixture(), handler = quoteDraftHandlers({ session: async () => owner, storage: () => f.store, now: () => new Date(NOW), captureNote: f.note });
  const request = new Request('https://easygaragecleaning.com/api/quote-draft', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync_capture', ...f.input() }) });
  const response = await handler.post({ request, env: ENV }), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.job.captureSync.status, 'synced');
  assert.doesNotMatch(JSON.stringify(body), /Albums|Side gate|internalNotes/);
});
