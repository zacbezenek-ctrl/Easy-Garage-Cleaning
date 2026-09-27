import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesHandlers } from '../functions/api/messages.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { env, owner, manager, crew, otherCrew, job, memoryStore, fakeGhl, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
async function fixture({ kinds = ['on_my_way', 'invoice_send'], jobs = { 'job-1': job(), 'job-2': job({ phone: '' }), 'job-3': job({ notify: false }) }, settings = {} } = {}) {
  const rows = Object.fromEntries(Object.entries(jobs).map(([id, value]) => [`jobs/${id}`, value]));
  const store = memoryStore(rows), ghl = fakeGhl(), time = clock();
  for (const kind of kinds) {
    const state = await readTemplate(store, kind);
    await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind, expectedVersion: 1, version: 1, hash: state.versions[0].hash }, NOW);
  }
  const state = { viewer: owner };
  const handlers = messagesHandlers({
    session: async () => state.viewer ? { ...state.viewer } : null, storage: () => store,
    messenger: settings => createGhlMessenger({ env: settings, fetcher: ghl.fetcher, clock: time }), now: time,
    links: () => ({ payLink: async () => 'https://easygaragecleaning.com/pay/synthetic' }),
  });
  const post = async (body, { headers = {}, raw } = {}) => {
    const response = await handlers.post({ request: new Request(`${ORIGIN}/api/messages`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) }), env: { ...env, ...settings } });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { store, ghl, time, state, post, as: viewer => { state.viewer = viewer; } };
}
const onMyWay = (extra = {}) => ({ action: 'preview', requestId: uuid(), kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 15 }, ...extra });

test('cross-site, foreign-origin, unauthenticated and malformed requests are rejected before any work', async () => {
  const f = await fixture();
  for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example.invalid' }, { Origin: 'null' }, { Origin: '', Referer: 'https://easygaragecleaning.com.evil.example/x' }]) {
    const response = await f.post(onMyWay(), { headers });
    assert.deepEqual([response.status, response.body.code], [403, 'messaging_origin_forbidden'], JSON.stringify(headers));
  }
  f.as(null);
  assert.deepEqual(await f.post(onMyWay()).then(r => [r.status, r.body.code]), [401, 'messaging_sign_in_required']);
  f.as(owner);
  assert.deepEqual(await f.post(onMyWay(), { headers: { 'Content-Type': 'text/plain' } }).then(r => [r.status, r.body.code]), [415, 'messaging_json_required']);
  assert.deepEqual(await f.post(null, { raw: JSON.stringify({ ...onMyWay(), padding: 'x'.repeat(64001) }) }).then(r => [r.status, r.body.code]), [413, 'messaging_request_too_large']);
  assert.deepEqual(await f.post(null, { raw: '{"action":' }).then(r => [r.status, r.body.code]), [400, 'messaging_json_invalid']);
  for (const body of [{ ...onMyWay(), requestId: 'not-a-uuid' }, { ...onMyWay(), action: 'delete' }, [], { ...onMyWay(), items: [] }]) {
    assert.deepEqual(await f.post(body).then(r => [r.status, r.body.code]), [400, 'messaging_request_invalid']);
  }
  assert.equal(f.ghl.calls.length, 0);
  const response = await f.post(onMyWay());
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('crew cannot preview or send invoices, and unassigned crew cannot send on-my-way', async () => {
  const f = await fixture();
  f.as(crew);
  for (const action of ['preview', 'send']) {
    const response = await f.post({ action, requestId: uuid(), kind: 'invoice_send', jobId: 'job-1', confirmToken: 'x.y' });
    assert.deepEqual([response.status, response.body.code], [403, 'messaging_forbidden'], action);
  }
  f.as(otherCrew);
  assert.deepEqual(await f.post(onMyWay()).then(r => [r.status, r.body.code]), [403, 'messaging_forbidden']);
  f.as(crew);
  const preview = await f.post(onMyWay());
  assert.equal(preview.status, 200); assert.equal(preview.body.status, 'ready');
  f.as(otherCrew);
  const stolen = await f.post({ ...onMyWay(), action: 'send', confirmToken: preview.body.confirmToken });
  assert.deepEqual([stolen.status, stolen.body.code], [403, 'messaging_forbidden']);
  f.as(manager);
  const borrowed = await f.post({ ...onMyWay(), action: 'send', confirmToken: preview.body.confirmToken });
  assert.deepEqual([borrowed.status, borrowed.body.code], [403, 'messaging_confirmation_invalid'], 'a token is bound to the person who previewed it');
  assert.equal(f.ghl.sends().length, 0);
});

test('replaying a send with the same request ID returns the same result without another send', async () => {
  const f = await fixture();
  f.as(crew);
  const preview = await f.post(onMyWay());
  const send = { ...onMyWay(), action: 'send', requestId: uuid(), confirmToken: preview.body.confirmToken };
  const first = await f.post(send);
  assert.equal(first.status, 200); assert.equal(first.body.status, 'submitted'); assert.equal(first.body.requestId, send.requestId);
  const replay = await f.post(send);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  const { replayed, ...same } = replay.body;
  assert.deepEqual(same, first.body);
  assert.equal(f.ghl.sends().length, 1);
  const conflict = await f.post({ ...send, overrides: { etaMinutes: 25 } });
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'messaging_idempotency_conflict']);
  f.as(manager);
  assert.deepEqual(await f.post(send).then(r => [r.status, r.body.code]), [409, 'messaging_idempotency_conflict'], 'another person cannot replay a receipt');
  const receipt = f.store.get(`message_operations/${send.requestId}`);
  assert.equal(receipt.actorId, 'crew1'); assert.equal(receipt.createdAt, NOW); assert.equal(JSON.stringify(receipt).includes('confirmToken'), false);
  f.as(owner);
  const status = await f.post({ action: 'status', requestId: uuid(), kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 15 } });
  assert.deepEqual([status.body.status, status.body.actorId, status.body.approval], ['submitted', 'crew1', 'template+human_trigger']);
});

test('batches are manager-only, capped at 10 and report partial failures per item', async () => {
  const f = await fixture({ settings: { EGC_MESSAGING_SUBREQUEST_BUDGET: '900' } });
  f.as(crew);
  assert.deepEqual(await f.post({ action: 'batch_preview', requestId: uuid(), items: [{ kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 10 } }] }).then(r => [r.status, r.body.code]), [403, 'messaging_forbidden']);
  f.as(manager);
  assert.deepEqual(await f.post({ action: 'batch_preview', requestId: uuid(), items: Array.from({ length: 11 }, () => ({ kind: 'invoice_send', jobId: 'job-1' })) }).then(r => [r.status, r.body.code]), [400, 'messaging_batch_too_large']);
  assert.deepEqual(await f.post({ action: 'batch_preview', requestId: uuid(), items: [] }).then(r => [r.status, r.body.code]), [400, 'messaging_batch_invalid']);
  assert.deepEqual(await f.post({ action: 'batch_preview', requestId: uuid(), kind: 'invoice_send', items: [{ kind: 'invoice_send', jobId: 'job-1' }] }).then(r => [r.status, r.body.code]), [400, 'messaging_batch_invalid']);
  assert.deepEqual(await f.post({ action: 'batch_preview', requestId: uuid(), items: [{ kind: 'invoice_send', jobId: 'job-1', phone: '9705550000' }] }).then(r => [r.status, r.body.code]), [400, 'messaging_batch_invalid'], 'a browser-supplied destination is never accepted');
  const items = [{ kind: 'invoice_send', jobId: 'job-1' }, { kind: 'invoice_send', jobId: 'job-2' }, { kind: 'invoice_send', jobId: 'job-3' }, { kind: 'invoice_send', jobId: 'missing' }, { kind: 'review_request', jobId: 'job-1' }];
  const previews = await f.post({ action: 'batch_preview', requestId: uuid(), items });
  assert.equal(previews.status, 200);
  assert.deepEqual(previews.body.results.map(row => [row.index, row.ok, row.status || row.code]), [[0, true, 'ready'], [1, true, 'ready'], [2, true, 'suppressed'], [3, false, 'messaging_target_not_found'], [4, false, 'messaging_not_eligible']]);
  assert.deepEqual(previews.body.summary, { total: 5, failed: 2, notAttempted: 0 });
  const sendItems = [{ ...items[0], confirmToken: previews.body.results[0].confirmToken }, { ...items[1], confirmToken: previews.body.results[1].confirmToken }, { ...items[0] }];
  const batch = { action: 'batch_send', requestId: uuid(), items: sendItems };
  const sent = await f.post(batch);
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body.results.map(row => [row.index, row.ok, row.status || row.code]), [[0, true, 'submitted'], [1, true, 'submitted'], [2, false, 'messaging_confirmation_required']]);
  assert.equal(f.ghl.sends().length, 2);
  assert.equal(f.ghl.sends()[1].body.type, 'Email', 'email-only customers get the email template');
  const replay = await f.post(batch);
  assert.equal(replay.body.replayed, true); assert.deepEqual(replay.body.results, sent.body.results);
  assert.equal(f.ghl.sends().length, 2);
});

test('unexpected storage failures return a generic retry-safe error without internals', async () => {
  const handlers = messagesHandlers({ session: async () => owner, storage: () => ({ read: async () => { throw new Error('private stack detail'); }, commit: async () => { throw new Error('x'); } }), messenger: () => ({}), now: clock() });
  const response = await handlers.post({ request: new Request(`${ORIGIN}/api/messages`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(onMyWay()) }), env });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'messaging_unavailable'); assert.doesNotMatch(JSON.stringify(body), /private stack detail/);
  assert.equal((await handlers.get()).status, 405);
});

test('messaging stays off by default: previews work but sends are refused', async () => {
  const f = await fixture();
  const handlers = messagesHandlers({ session: async () => owner, storage: () => f.store, messenger: settings => createGhlMessenger({ env: settings, fetcher: f.ghl.fetcher, clock: f.time }), now: f.time });
  const call = async body => { const response = await handlers.post({ request: new Request(`${ORIGIN}/api/messages`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: { ...env, EGC_MESSAGING_ENABLED: undefined } }); return { status: response.status, body: await response.json() }; };
  const preview = await call(onMyWay());
  assert.equal(preview.body.status, 'ready'); assert.deepEqual(preview.body.delivery, { enabled: false, dryRun: false });
  const sent = await call({ ...onMyWay(), action: 'send', confirmToken: preview.body.confirmToken });
  assert.deepEqual([sent.status, sent.body.code], [409, 'messaging_disabled']);
  assert.equal(f.ghl.sends().length, 0);
});

test('batch sends stop before a subrequest budget runs out and never strand a claim', async () => {
  const items = ['job-1', 'job-2', 'job-1'].map(jobId => ({ kind: 'invoice_send', jobId }));
  // The default fits the Free plan's 50; values outside 30-9500 fall back to it.
  for (const [settings, attempted] of [[{}, 2], [{ EGC_MESSAGING_SUBREQUEST_BUDGET: '30' }, 1], [{ EGC_MESSAGING_SUBREQUEST_BUDGET: '12' }, 2], [{ EGC_MESSAGING_SUBREQUEST_BUDGET: '900' }, 3]]) {
    const f = await fixture({ settings });
    f.as(manager);
    const previews = await f.post({ action: 'batch_preview', requestId: uuid(), items: items.slice(0, 2) });
    const tokens = previews.body.results.map(row => row.confirmToken);
    assert.equal(previews.body.summary.notAttempted, 0, 'previews are cheaper than sends');
    const batch = { action: 'batch_send', requestId: uuid(), items: items.map((item, index) => ({ ...item, confirmToken: index < 2 ? tokens[index] : 'x.y' })) };
    const sent = await f.post(batch);
    const skipped = sent.body.results.filter(row => row.code === 'messaging_not_attempted').map(row => row.index);
    assert.deepEqual(skipped, [0, 1, 2].slice(attempted), JSON.stringify(settings));
    assert.equal(sent.body.summary.notAttempted, skipped.length);
    const ledgers = [...f.store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, value]) => value.status);
    assert.ok(ledgers.every(status => status === 'submitted'), 'no ledger is left in sending');
    assert.equal(f.ghl.sends().length, Math.min(attempted, 2));
    assert.deepEqual((await f.post(batch)).body.results, sent.body.results, 'a replay reports the same items as not attempted');
  }
});

test('status accepts the send key returned by a send', async () => {
  const f = await fixture();
  f.as(manager);
  const preview = await f.post({ action: 'preview', requestId: uuid(), kind: 'invoice_send', jobId: 'job-1' });
  const sent = await f.post({ action: 'send', requestId: uuid(), kind: 'invoice_send', jobId: 'job-1', confirmToken: preview.body.confirmToken });
  assert.equal(sent.body.status, 'submitted');
  f.store.edit('jobs/job-1', { invoice: { ...job().invoice, status: 'void' } });
  const status = await f.post({ action: 'status', requestId: uuid(), kind: 'invoice_send', jobId: 'job-1', sendKey: sent.body.sendKey });
  assert.deepEqual([status.status, status.body.status, status.body.sendKey], [200, 'submitted', sent.body.sendKey]);
  assert.deepEqual(await f.post({ action: 'preview', requestId: uuid(), kind: 'invoice_send', jobId: 'job-1', sendKey: sent.body.sendKey }).then(r => [r.status, r.body.code]), [400, 'messaging_request_invalid'], 'only status takes a send key');
});
