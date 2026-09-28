import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedSendService } from '../functions/_lib/approved-send.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { SENDING_STALE_MS, messageReconcileStorage, reconcileMessageSend, sendInFlight, unsettledMessageSends } from '../functions/_lib/message-reconcile.js';
import { messageSendHandlers } from '../functions/api/message-sends.js';
import { env, owner, manager, crew, job, memoryStore, fakeGhl, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';

const origin = 'https://easygaragecleaning.com';
const at = ms => new Date(Date.parse(NOW) + ms).toISOString();
const code = (expected, status) => error => { assert.equal(error.code, expected); if (status) assert.equal(error.status, status); return true; };
const onMyWay = { kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 20 } };

// The list, late-answer and name lookups the Firestore store runs as runQuery/batchGet, over the memory store.
function reconcileStore(store) {
  const ledgers = async () => { const rows = []; for (const path of store.rows.keys()) if (path.startsWith('message_sends/')) rows.push(await store.read('message_sends', path.split('/')[1])); return rows; };
  return {
    ...store,
    async unsettled() { return { rows: (await ledgers()).filter(row => ['uncertain', 'sending'].includes(row.status)), complete: true }; },
    async lateResults(since) { return { rows: (await ledgers()).filter(row => typeof row.lateResult?.at === 'string' && row.lateResult.at >= since), complete: true }; },
    async names(collection, ids) { return new Map((await Promise.all(ids.map(id => store.read(collection, id)))).filter(Boolean).map(row => [row.id, row.customer || row.name])); },
  };
}

// An approved on-my-way text whose HighLevel outcome was ambiguous (5xx): the ledger holds it as 'uncertain'.
async function uncertainSend() {
  const store = memoryStore({ 'jobs/job-1': job() });
  const state = await readTemplate(store, 'on_my_way');
  await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind: 'on_my_way', expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
  const ghl = fakeGhl({ sendStatus: 503 }), time = clock(NOW);
  const service = createApprovedSendService({ store, messenger: createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time }), clock: time, env });
  const send = async () => { const preview = await service.preview(owner, onMyWay); assert.equal(preview.status, 'ready'); return service.send(owner, { ...onMyWay, requestId: uuid(), confirmToken: preview.confirmToken }); };
  assert.equal((await send()).status, 'uncertain');
  const [key] = [...store.rows.keys()].filter(key => key.startsWith('message_sends/')), ledgerId = key.split('/')[1];
  const reconcile = reconcileStore(store);
  return { store, reconcile, ghl, time, service, send, ledgerId, ledger: () => store.get(key), row: () => store.get('jobs/job-1') };
}
const input = async (f, extra = {}) => ({ action: 'reconcile', requestId: uuid(), ledgerId: f.ledgerId, expectedRevision: (await f.store.read('message_sends', f.ledgerId)).revision, outcome: 'delivered', note: 'Seen delivered in the HighLevel conversation', ...extra });

test('owners and managers see unsettled sends with who they were for; crew never do', async () => {
  const f = await uncertainSend();
  const list = await unsettledMessageSends(f.reconcile, manager, at(60000));
  assert.deepEqual(list.counts, { unsettled: 1, inFlight: 0 });
  const [send] = list.sends;
  assert.deepEqual([send.id, send.kind, send.label, send.status, send.inFlight, send.channel, send.recipient, send.targetType, send.targetId, send.targetName, send.attempts, send.actorId], [f.ledgerId, 'on_my_way', 'On my way', 'uncertain', false, 'SMS', '(•••) •••-0123', 'job', 'job-1', 'Synthetic Customer', 1, 'zacb']);
  assert.match(send.excerpt, /^Hi Synthetic, this is Casey/);
  assert.equal(send.revision, (await f.store.read('message_sends', f.ledgerId)).revision);
  assert.deepEqual(list.coverage, { complete: true, asOf: at(60000) });
  assert.doesNotMatch(JSON.stringify(list), /\+19705550123|contact-1|idempotencyKey|egc-msg-/, 'no raw phone, contact id or provider keys leave the server');
  await assert.rejects(unsettledMessageSends(f.reconcile, crew, NOW), code('dispatch_forbidden', 403));
  await assert.rejects(unsettledMessageSends(f.reconcile, null, NOW), code('dispatch_sign_in_required', 401));
});

test('marking a send delivered settles it once, audits it in the same commit, clears the Command Center flag and never resends', async () => {
  const f = await uncertainSend();
  assert.deepEqual([f.row().communicationLastStatus, f.row().communicationLog.at(-1).status], ['needs_attention', 'uncertain']);
  const body = await input(f), commitsBefore = f.store.commits.length;
  const result = await reconcileMessageSend(f.reconcile, manager, body, at(60000));
  assert.deepEqual([result.send.status, result.send.reason, result.replayed, result.mirror], ['submitted', 'reconciled_delivered', false, 'saved']);
  assert.deepEqual(result.send.reconciled, { outcome: 'delivered', by: 'tylerg', at: at(60000), note: 'Seen delivered in the HighLevel conversation' });
  const ledger = f.ledger();
  assert.deepEqual([ledger.status, ledger.attempts, ledger.attemptId, ledger.reconciled.previousStatus, ledger.reconciled.requestId], ['submitted', 1, `reconcile-${body.requestId}`, 'uncertain', body.requestId], 'a late result from the original delivery can no longer claim the record');
  assert.deepEqual(ledger.history.at(-1), { attempt: 1, status: 'submitted', at: at(60000), actorId: 'tylerg', requestId: body.requestId, reconciled: true });
  const commit = f.store.commits[commitsBefore];
  assert.deepEqual(commit.map(write => write.collection), ['message_sends', 'message_operations', 'hub_audit'], 'ledger, receipt and audit in one commit');
  assert.equal(commit[0].revision, body.expectedRevision);
  assert.deepEqual([commit[1].patch.scope, commit[1].patch.actorId, commit[1].patch.ledgerId], ['message_reconcile', 'tylerg', f.ledgerId]);
  assert.deepEqual([commit[2].patch.action, commit[2].patch.reason, commit[2].patch.visibility], ['message.reconcile', 'Seen delivered in the HighLevel conversation', 'business']);
  assert.deepEqual([f.row().communicationLastStatus, f.row().communicationLog.at(-1).status], ['submitted', 'submitted'], 'the job display copy and attention flag follow');
  // The ledger now says sent: a new preview is held as already sent and nothing reaches HighLevel again.
  f.ghl.state.sendStatus = 200;
  assert.equal((await f.service.preview(owner, onMyWay)).status, 'already_sent');
  assert.equal(f.ghl.sends().length, 1);
  const replay = await reconcileMessageSend(f.reconcile, manager, body, at(120000));
  assert.equal(replay.replayed, true); assert.equal(f.store.commits.length, commitsBefore + 2, 'a replay adds no commit (the mirror was the only other one)');
  await assert.rejects(reconcileMessageSend(f.reconcile, manager, { ...body, outcome: 'not_delivered' }, NOW), code('messaging_idempotency_conflict', 409));
  await assert.rejects(reconcileMessageSend(f.reconcile, owner, body, NOW), code('messaging_idempotency_conflict', 409));
  await assert.rejects(reconcileMessageSend(f.reconcile, manager, await input(f), NOW), code('messaging_reconcile_not_needed', 409));
});

test('marking a send not delivered allows one new, separately confirmed send; the reconcile itself sends nothing', async () => {
  const f = await uncertainSend();
  const result = await reconcileMessageSend(f.reconcile, owner, await input(f, { outcome: 'not_delivered', note: 'No message in the HighLevel thread' }), at(60000));
  assert.deepEqual([result.send.status, result.send.reason], ['failed', 'reconciled_not_delivered']);
  assert.equal(f.ghl.sends().length, 1, 'nothing was sent by reconciling');
  assert.equal(f.row().communicationLastStatus, 'needs_attention', 'the job still needs the message');
  assert.equal(f.row().communicationLog.at(-1).status, 'failed');
  f.ghl.state.sendStatus = 200;
  const retried = await f.send();
  assert.deepEqual([retried.status, retried.attempts], ['submitted', 2]);
  assert.equal(f.ghl.sends().length, 2);
  assert.deepEqual((await unsettledMessageSends(f.reconcile, owner, NOW)).sends, []);
});

test('"not delivered, do not send again" uses the ledger\'s own attempt limit, so neither a person nor the automation resends it', async () => {
  const f = await uncertainSend();
  await assert.rejects(reconcileMessageSend(f.reconcile, owner, await input(f, { resend: false }), at(60000)), code('messaging_request_invalid', 400), 'a delivered message has nothing to stop');
  await assert.rejects(reconcileMessageSend(f.reconcile, owner, await input(f, { outcome: 'not_delivered', resend: 'no' }), at(60000)), code('messaging_request_invalid', 400));
  const result = await reconcileMessageSend(f.reconcile, owner, await input(f, { outcome: 'not_delivered', resend: false, note: 'No message in HighLevel; the visit moved' }), at(60000));
  assert.deepEqual([result.send.status, result.send.attempts, result.send.maxAttempts, result.send.resendable, result.send.reconciled.resend], ['failed', 3, 3, false, false]);
  assert.deepEqual([f.ledger().attempts, f.ledger().reconciled.resend, f.ledger().history.at(-1).attempt], [3, false, 3]);
  assert.equal(f.row().communicationLog.at(-1).attempt, 3, 'the job copy the scheduler reads shows the attempts are used up');
  const [audit] = f.store.commits.at(-2).filter(write => write.collection === 'hub_audit');
  assert.deepEqual(JSON.parse(audit.patch.after), { status: 'failed', reason: 'reconciled_not_delivered', attempts: 3, outcome: 'not_delivered', resend: false });
  f.ghl.state.sendStatus = 200;
  assert.equal((await f.service.preview(owner, onMyWay)).status, 'attempts_exhausted');
  assert.equal(f.ghl.sends().length, 1, 'nothing reaches HighLevel again');
});

test('the list says when the owner\'s automation may send a message again, so the screen can say so', async () => {
  const f = await uncertainSend();
  let [send] = (await unsettledMessageSends(f.reconcile, manager, at(60000))).sends;
  assert.deepEqual([send.approval, send.source, send.automationMayResend, send.maxAttempts], ['template+human_trigger', 'hub', false, 3], 'on-my-way texts are only ever sent by a person');
  f.store.edit(`message_sends/${f.ledgerId}`, { approval: 'owner_automation', source: 'cron', actorId: 'automation' });
  [send] = (await unsettledMessageSends(f.reconcile, manager, at(60000))).sends;
  assert.deepEqual([send.approval, send.source, send.automationMayResend], ['owner_automation', 'cron', true]);
  // A reminder a person sent shares its ledger with the automation's run for the same reminder.
  f.store.edit(`message_sends/${f.ledgerId}`, { kind: 'day_before_reminder', approval: 'preview_confirm', source: 'hub', actorId: 'zacb' });
  [send] = (await unsettledMessageSends(f.reconcile, manager, at(60000))).sends;
  assert.deepEqual([send.approval, send.automationMayResend], ['preview_confirm', true]);
  const result = await reconcileMessageSend(f.reconcile, manager, await input(f, { outcome: 'not_delivered', note: 'Checked HighLevel: not delivered' }), at(60000));
  assert.deepEqual([result.send.automationMayResend, result.send.resendable, result.send.reconciled.resend, f.ledger().attempts], [true, true, true, 1], 'by default the automation may try again within its attempts');
});

test('a sending claim with no readable attempt time falls back to its last write, and is reconcilable once that is stale', () => {
  const now = at(0), row = extra => ({ status: 'sending', ...extra });
  assert.equal(sendInFlight(row({ attemptedAt: at(-60000) }), now), true);
  assert.equal(sendInFlight(row({ attemptedAt: 'garbage', revision: at(-60000) }), now), true, 'the Firestore updateTime of the claim');
  assert.equal(sendInFlight(row({ revision: at(-60000).replace(/\.\d{3}Z$/, '.000001Z') }), now), true, 'Firestore microsecond update times parse');
  assert.equal(sendInFlight(row({ attemptedAt: '', revision: at(-SENDING_STALE_MS) }), now), false);
  assert.equal(sendInFlight(row({ attemptedAt: null, revision: 'rev-7' }), now), false, 'no readable time is stale, never stuck in flight forever');
  assert.equal(sendInFlight({ status: 'uncertain' }, now), false);
});

test('HighLevel answering after a reconcile is kept beside the person\'s outcome, never mirrored to the job, and an accepted message is never sent again', async () => {
  const store = memoryStore({ 'jobs/job-1': job() });
  const state = await readTemplate(store, 'on_my_way');
  await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind: 'on_my_way', expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
  const ghl = fakeGhl({ sendStatus: 200 }), time = clock(NOW), real = createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time });
  // HighLevel holds the request until the test releases it.
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), inFlight = new Promise(resolve => { entered = resolve; });
  const service = createApprovedSendService({ store, messenger: { ...real, async send(args) { entered(); await gate; return real.send(args); } }, clock: time, env });
  const preview = await service.preview(owner, onMyWay);
  const pending = service.send(owner, { ...onMyWay, requestId: uuid(), confirmToken: preview.confirmToken });
  await inFlight;
  const key = [...store.rows.keys()].find(path => path.startsWith('message_sends/')), ledgerId = key.split('/')[1], claim = await store.read('message_sends', ledgerId);
  assert.equal(claim.status, 'sending');
  // Eleven minutes on, the claim is stale: a manager finds nothing in HighLevel and marks it not delivered (a resend stays allowed).
  const reconcile = reconcileStore(store);
  const result = await reconcileMessageSend(reconcile, manager, { action: 'reconcile', requestId: uuid(), ledgerId, expectedRevision: claim.revision, outcome: 'not_delivered', note: 'Nothing in the HighLevel thread' }, at(11 * 60000));
  assert.deepEqual([result.send.status, result.send.resendable, result.mirror], ['failed', true, 'skipped']);
  assert.equal(store.get(key).reconciled.attemptId, claim.attemptId, 'the reconcile names the delivery it settled');
  const jobBefore = store.get('jobs/job-1');
  // Then HighLevel accepts the original request.
  time.set(at(12 * 60000)); release();
  const late = await pending;
  assert.deepEqual([late.status, late.reason, late.messageId, late.ledgerSaved, late.lateResultSaved, late.mirror, late.reconciled.outcome], ['submitted', 'reconciled_before_result', 'message-1', false, true, 'skipped', 'not_delivered']);
  const ledger = store.get(key);
  assert.deepEqual([ledger.status, ledger.reason, ledger.attemptId], ['failed', 'reconciled_not_delivered', `reconcile-${ledger.reconciled.requestId}`], 'the person\'s outcome stays');
  assert.deepEqual(ledger.lateResult, { status: 'submitted', messageId: 'message-1', conversationId: 'conversation-1', httpStatus: null, reason: '', attempt: 1, attemptId: claim.attemptId, at: at(12 * 60000) });
  assert.deepEqual(store.get('jobs/job-1'), jobBefore, 'the job display copy is left as the reconcile set it');
  // The message reached HighLevel, so it is never sent again, by a person or the automation.
  const again = await service.preview(owner, onMyWay);
  assert.deepEqual([again.status, again.reason, again.confirmToken], ['already_sent', 'late_result_submitted', undefined]);
  const status = await service.status(owner, onMyWay);
  assert.deepEqual([status.status, status.canRetry, status.lateResult], ['failed', false, { status: 'submitted', messageId: 'message-1', at: at(12 * 60000) }]);
  assert.equal(ghl.sends().length, 1);
  // Review queues show HighLevel's answer beside the reconcile for a week.
  const list = await unsettledMessageSends(reconcile, owner, at(13 * 60000));
  assert.deepEqual(list.sends, []);
  assert.equal(list.lateResults.length, 1);
  const [row] = list.lateResults;
  assert.deepEqual([row.id, row.status, row.resendable, row.targetName, row.reconciled.outcome, row.reconciled.by], [ledgerId, 'failed', false, 'Synthetic Customer', 'not_delivered', 'tylerg']);
  assert.deepEqual(row.lateResult, { status: 'submitted', messageId: 'message-1', httpStatus: null, reason: '', at: at(12 * 60000) });
  assert.deepEqual((await unsettledMessageSends(reconcile, owner, at(8 * 86400000))).lateResults, [], 'older than a week drops off the list');
});

test('a late answer is never kept for a ledger another delivery has claimed since', async () => {
  const store = memoryStore({ 'jobs/job-1': job() });
  const state = await readTemplate(store, 'on_my_way');
  await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind: 'on_my_way', expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
  const ghl = fakeGhl({ sendStatus: 200 }), time = clock(NOW), real = createGhlMessenger({ env, fetcher: ghl.fetcher, clock: time });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), inFlight = new Promise(resolve => { entered = resolve; });
  const service = createApprovedSendService({ store, messenger: { ...real, async send(args) { entered(); await gate; return real.send(args); } }, clock: time, env });
  const pending = service.send(owner, { ...onMyWay, requestId: uuid(), confirmToken: (await service.preview(owner, onMyWay)).confirmToken });
  await inFlight;
  const key = [...store.rows.keys()].find(path => path.startsWith('message_sends/'));
  // Something other than a reconcile of this delivery took the record (a later attempt's claim).
  store.edit(key, { attemptId: 'another-delivery', status: 'sending' });
  release();
  const out = await pending;
  assert.deepEqual([out.status, out.reason, out.ledgerSaved], ['submitted', 'delivery_status_not_saved', false]);
  assert.equal(store.get(key).lateResult, undefined);
  assert.equal(store.get(key).attemptId, 'another-delivery');
});

test('a sending record without attemptedAt can be reconciled', async () => {
  const f = await uncertainSend();
  f.store.edit(`message_sends/${f.ledgerId}`, { status: 'sending', attemptedAt: '' });
  const [listed] = (await unsettledMessageSends(f.reconcile, manager, at(60000))).sends;
  assert.equal(listed.inFlight, false);
  const done = await reconcileMessageSend(f.reconcile, manager, await input(f, { outcome: 'not_delivered', note: 'Checked HighLevel: nothing sent' }), at(60000));
  assert.equal(done.send.status, 'failed');
});

test('a send still in flight cannot be reconciled until it is stale; stale revisions and bad input are refused', async () => {
  const f = await uncertainSend();
  f.store.edit(`message_sends/${f.ledgerId}`, { status: 'sending', attemptedAt: NOW, completedAt: '' });
  const listed = await unsettledMessageSends(f.reconcile, manager, at(5 * 60000));
  assert.deepEqual([listed.sends[0].status, listed.sends[0].inFlight, listed.counts.inFlight], ['sending', true, 1]);
  await assert.rejects(reconcileMessageSend(f.reconcile, manager, await input(f), at(SENDING_STALE_MS - 1000)), code('messaging_reconcile_in_flight', 409));
  assert.equal((await unsettledMessageSends(f.reconcile, manager, at(SENDING_STALE_MS))).sends[0].inFlight, false);
  await assert.rejects(reconcileMessageSend(f.reconcile, manager, await input(f, { expectedRevision: 'rev-stale' }), at(SENDING_STALE_MS)), code('messaging_revision_conflict', 409));
  for (const bad of [{ outcome: 'maybe' }, { note: 'no' }, { note: 'x'.repeat(501) }, { note: undefined }, { ledgerId: 'not-a-ledger' }, { requestId: 'nope' }, { action: 'send' }, { body: 'resend this' }]) {
    await assert.rejects(reconcileMessageSend(f.reconcile, manager, { ...await input(f), ...bad }, at(SENDING_STALE_MS)), code('messaging_request_invalid', 400), JSON.stringify(bad));
  }
  await assert.rejects(reconcileMessageSend(f.reconcile, manager, await input(f, { actorId: 'zacb' }), at(SENDING_STALE_MS)), code('messaging_actor_changed', 403));
  await assert.rejects(reconcileMessageSend(f.reconcile, manager, await input(f, { ledgerId: 'a'.repeat(64) }), at(SENDING_STALE_MS)), code('messaging_send_not_found', 404));
  await assert.rejects(reconcileMessageSend(f.reconcile, crew, await input(f), at(SENDING_STALE_MS)), code('dispatch_forbidden', 403));
  const done = await reconcileMessageSend(f.reconcile, manager, await input(f, { outcome: 'not_delivered', note: 'Checked HighLevel: nothing sent' }), at(SENDING_STALE_MS));
  assert.deepEqual([done.send.status, f.ledger().reconciled.previousStatus], ['failed', 'sending']);
});

test('a lost commit response is recovered from the receipt without a second write', async () => {
  const f = await uncertainSend(), body = await input(f);
  f.store.hooks.loseResponse.add('message_operations');
  const result = await reconcileMessageSend(f.reconcile, manager, body, at(60000));
  f.store.hooks.loseResponse.clear();
  assert.deepEqual([result.send.status, result.replayed], ['submitted', false]);
  assert.equal(f.store.commits.filter(commit => commit.some(write => write.collection === 'message_operations' && write.patch.scope === 'message_reconcile')).length, 1);
});

test('over HTTP: dispatcher only, same-origin JSON, and errors never leak storage details', async () => {
  const f = await uncertainSend();
  let actor = manager;
  const handlers = messageSendHandlers({ session: async () => actor, storage: () => f.reconcile, now: () => new Date(at(60000)) });
  const get = (query = '') => handlers.get({ env: {}, request: new Request(`${origin}/api/message-sends${query}`) });
  const post = async (body, headers = {}) => handlers.post({ env: {}, request: new Request(`${origin}/api/message-sends`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  actor = null; assert.equal((await get()).status, 401);
  actor = crew; assert.equal((await get()).status, 403); assert.equal((await post(await input(f))).status, 403);
  actor = manager;
  assert.equal((await get('?status=all')).status, 400);
  const list = await get();
  assert.equal(list.status, 200); assert.equal(list.headers.get('Cache-Control'), 'no-store'); assert.equal((await list.json()).sends.length, 1);
  assert.equal((await post(await input(f), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(await input(f), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{"action"')).status, 400);
  assert.equal((await post({ ...await input(f), note: 'x'.repeat(9000) })).status, 413);
  const saved = await post(await input(f));
  assert.equal(saved.status, 200); assert.equal((await saved.json()).send.status, 'submitted');
  const broken = messageSendHandlers({ session: async () => manager, storage: () => ({ unsettled: async () => { throw new Error('raw provider text synthetic-secret'); } }), now: () => new Date(NOW) });
  const failed = await broken.get({ env: {}, request: new Request(`${origin}/api/message-sends`) }), failedBody = await failed.json();
  assert.deepEqual([failed.status, failedBody.code], [503, 'messaging_unavailable']); assert.doesNotMatch(JSON.stringify(failedBody), /synthetic-secret/);
});

test('the Firestore store lists by status with one query, reads only name fields, fails closed and reports stale revisions as conflicts', async () => {
  const ROOT = 'projects/egcw-1ec83/databases/(default)/documents', calls = [];
  const ledger = id => ({ name: `${ROOT}/message_sends/${id}`, updateTime: '2026-09-22T00:00:00.000001Z', fields: encodeFirestoreFields({ status: 'uncertain', kind: 'on_my_way', targetType: 'job', targetId: 'job-1', attemptedAt: NOW }) });
  let rows = [{ document: ledger('a'.repeat(64)) }, { readTime: NOW }], commitStatus = 400;
  const fetcher = async (_env, url, init = {}) => {
    const parsed = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    assert.equal(parsed.hostname, 'firestore.googleapis.com');
    calls.push({ path: parsed.pathname, body });
    if (parsed.pathname.endsWith(':runQuery')) return Response.json(rows);
    if (parsed.pathname.endsWith(':batchGet')) return Response.json(body.documents.map(name => ({ found: { name, updateTime: '2026-09-22T00:00:00.000002Z', fields: encodeFirestoreFields({ customer: 'Synthetic Customer' }) } })));
    if (parsed.pathname.endsWith(':commit')) return Response.json({ error: { code: commitStatus, status: commitStatus === 400 ? 'FAILED_PRECONDITION' : 'INTERNAL' } }, { status: commitStatus });
    return Response.json({}, { status: 404 });
  };
  const store = messageReconcileStorage({ FIREBASE_API_KEY: 'firebase-test-message-reconcile' }, fetcher);
  const list = await unsettledMessageSends(store, owner, NOW);
  assert.deepEqual([list.sends.length, list.sends[0].targetName, list.coverage.complete], [1, 'Synthetic Customer', true]);
  const query = calls[0].body.structuredQuery;
  assert.deepEqual(query.where.fieldFilter, { field: { fieldPath: 'status' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'uncertain' }, { stringValue: 'sending' }] } } });
  assert.deepEqual(calls[1].body.mask, { fieldPaths: ['customer'] }, 'job bodies (signatures, notes) are never read for a name');
  // Late answers from the last week come from one range query on lateResult.at, newest first; rows without one are never shown.
  const late = calls[2].body.structuredQuery;
  assert.deepEqual(late.where.fieldFilter, { field: { fieldPath: 'lateResult.at' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2026-09-15T18:00:00.000Z' } });
  assert.deepEqual([late.orderBy, late.limit], [[{ field: { fieldPath: 'lateResult.at' }, direction: 'DESCENDING' }], 51]);
  assert.deepEqual([list.lateResults, list.lateResultCoverage], [[], { complete: true, since: '2026-09-15T18:00:00.000Z', days: 7 }]);
  rows = Array.from({ length: 201 }, (_, index) => ({ document: ledger(index.toString(16).padStart(64, '0')) }));
  const capped = await unsettledMessageSends(store, owner, NOW);
  assert.deepEqual([capped.sends.length, capped.coverage.complete], [200, false], 'more than the cap is reported incomplete');
  rows = { not: 'a list' };
  await assert.rejects(unsettledMessageSends(store, owner, NOW), code('messaging_storage_incomplete', 503));
  await assert.rejects(store.commit([{ collection: 'message_sends', id: 'a'.repeat(64), revision: 'stale', patch: { status: 'failed' } }]), code('messaging_revision_conflict', 409), 'Firestore 400 FAILED_PRECONDITION is a conflict');
  commitStatus = 500;
  await assert.rejects(store.commit([{ collection: 'message_sends', id: 'a'.repeat(64), revision: 'stale', patch: { status: 'failed' } }]), code('messaging_outcome_unknown', 503));
  const offline = messageReconcileStorage({}, async () => { throw new TypeError('offline'); });
  await assert.rejects(unsettledMessageSends(offline, owner, NOW), code('messaging_storage_unavailable', 503));
});
