import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { fieldChecklist, fieldCommand } from '../functions/_lib/field-execution.js';
import { storage } from './helpers/field-fixture.mjs';
import { onRequestPost, onRequestGet } from '../functions/api/field-jobs.js';
import { fieldCompletionTagWrites, fieldCompletionTagsEnabled, drainGhlTagOutbox, retryGhlTags, ghlTagStuck, GHL_TAG_OUTBOX } from '../functions/_lib/ghl-tag-outbox.js';

const now = '2026-10-15T18:00:00.000Z';
const env = { EGC_GHL_TAG_OUTBOX: 'true', EGC_GHL_FIELD_COMPLETION_TAG: 'true', HIGHLEVEL_API_KEY: 'synthetic', HIGHLEVEL_LOCATION_ID: 'location-1', HUB_SESSION_SECRET: 'test-crew-completion', FIREBASE_API_KEY: 'firebase-test-completion', FIELD_LEAD_ONLY_COMPLETE: 'true', HUB_AUTH_USERS_JSON: JSON.stringify({ lead: { passwordHash: 'test', role: 'crew' }, helper: { passwordHash: 'test', role: 'crew' }, other: { passwordHash: 'test', role: 'crew' }, owner: { passwordHash: 'test', role: 'owner' } }) };
const actor = { user: 'lead', displayName: 'Lead' };
function ready() {
  const job = { id: 'job-1', type: 'job', status: 'in_progress', pipelineStatus: 'in_progress', date: '2026-10-15', time: '09:30', endTime: '12:00', highlevelContactId: 'contact-1', assignedCrew: ['lead', 'helper'], crewLead: 'lead', payment: { status: 'unpaid', amount: 0 }, invoice: { status: 'unpaid' }, commission: { status: 'unearned' }, acceptance: { status: 'pending' } };
  job.fieldExecution = { checks: Object.fromEntries(fieldChecklist(job).map(item => [item.id, { completed: true, actorId: 'lead' }])), photos: ['before', 'after'].map(category => ({ id: crypto.randomUUID(), fileId: `test-${category}`, category, verified: true })) };
  return job;
}
const close = job => { const requestId = crypto.randomUUID(); return { requestId, ...fieldCommand(job, actor, { action: 'complete', requestId, notes: 'All agreed work has been completed.', hasIssues: false }, now) }; };

test('assigned lead completion atomically queues one canonical tag intent; duplicate and unauthorized writes cannot add one', async t => {
  const memory = storage(t), job = ready(); memory.put('jobs/job-1', job);
  const cookies = Object.fromEntries(await Promise.all(['lead', 'helper', 'other', 'owner'].map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
  const input = { action: 'complete', jobId: job.id, requestId: crypto.randomUUID(), expectedRevision: memory.revision(job.id), notes: 'All agreed work has been completed.', hasIssues: false };
  const request = (user, body = input) => new Request('https://easygaragecleaning.com/api/field-jobs', { method: 'POST', headers: { Cookie: cookies[user] || '', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const user of ['', 'other', 'helper']) assert.equal((await onRequestPost({ env, request: request(user) })).status, user ? 403 : 401);
  assert.equal([...memory.documents.keys()].some(key => key.startsWith(GHL_TAG_OUTBOX)), false);
  const missing = structuredClone(job); missing.fieldExecution.photos = []; memory.put('jobs/job-1', missing);
  assert.equal((await onRequestPost({ env, request: request('lead', { ...input, expectedRevision: memory.revision(job.id) }) })).status, 409);
  memory.put('jobs/job-1', job); input.expectedRevision = memory.revision(job.id);
  assert.equal((await onRequestPost({ env, request: request('lead') })).status, 200);
  const replay = await onRequestPost({ env, request: request('lead') });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).alreadyApplied, true);
  const saved = memory.get('jobs/job-1'), rows = [...memory.documents.keys()].filter(key => key.startsWith(GHL_TAG_OUTBOX + '/'));
  assert.equal(rows.length, 1); assert.equal(saved.completionEvidence.requestId, input.requestId);
  assert.deepEqual(memory.get(rows[0]).addTags, ['egc-job-complete']);
  for (const key of ['payment', 'invoice', 'commission', 'acceptance']) assert.deepEqual(saved[key], job[key]);
  const detail = await onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/field-jobs?jobId=job-1', { headers: { Cookie: cookies.lead } }) });
  const body = await detail.json(); assert.equal(body.job.completionTags.status, 'pending');
  assert.equal(JSON.stringify(body).includes('contact-1'), false);
});

async function fixture() {
  const job = ready(), result = close(job), intent = await fieldCompletionTagWrites({ job, patch: result.patch, requestId: result.requestId, now });
  const rows = new Map([['jobs/job-1', { ...job, ...result.patch, fieldCompletionTagEntry: intent.pointer }], [`${GHL_TAG_OUTBOX}/${intent.write.id}`, { ...intent.write.patch, revision: 'r0' }]]);
  let revision = 0, tags = [], postMode = 'ok', readMode = 'ok', failFinal = false;
  const calls = [];
  const store = {
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision !== old?.revision) throw Object.assign(Error('conflict'), { status: 409 }); }
      if (failFinal && writes.some(write => write.patch.status === 'done')) { failFinal = false; throw Error('lost storage response'); }
      for (const write of writes) { const key = `${write.collection}/${write.id}`; rows.set(key, { ...rows.get(key), ...structuredClone(write.patch), revision: `r${++revision}` }); }
    },
    due: async () => ({ rows: [...rows.values()].filter(row => row.status === 'pending'), truncated: false }),
    parked: async () => ({ rows: [...rows.values()].filter(row => row.status === 'parked'), truncated: false }),
  };
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname, method = init.method || 'GET'; calls.push({ path, method, body: init.body && JSON.parse(init.body) });
    assert.ok(path.startsWith('/contacts/contact-1')); assert.ok(['GET', 'POST'].includes(method));
    if (method === 'GET') {
      if (readMode === 'fail') throw Error('unavailable');
      return Response.json({ contact: { id: 'contact-1', locationId: readMode === 'wrong' ? 'other' : 'location-1', tags } });
    }
    assert.equal(path, '/contacts/contact-1/tags');
    assert.deepEqual(JSON.parse(init.body), { tags: ['egc-job-complete'] });
    if (postMode === '429') return Response.json({}, { status: 429 });
    if (postMode !== 'lost-absent') tags = ['egc-job-complete'];
    if (postMode.startsWith('lost')) throw Error('lost response');
    return Response.json({ tags });
  };
  const drain = (at = now, config = env, options = {}) => drainGhlTagOutbox(store, { env: config, now: at, fetcher, ...options });
  const retry = async () => retryGhlTags(store, { user: 'zacb', role: 'owner', businessAccess: true }, { action: 'retry', jobId: job.id, requestId: crypto.randomUUID() }, '2026-10-15T18:10:00.000Z', env);
  return { rows, calls, store, drain, retry, entry: () => rows.get(`${GHL_TAG_OUTBOX}/${intent.write.id}`), job: rows.get('jobs/job-1'), post: value => postMode = value, read: value => readMode = value, tags: value => tags = value, failFinal: () => failFinal = true };
}

test('completion tag needs both explicit flags and verified field evidence', async () => {
  assert.equal(fieldCompletionTagsEnabled({ EGC_GHL_TAG_OUTBOX: 'true' }), false);
  assert.equal(fieldCompletionTagsEnabled(env), true);
  assert.equal(await fieldCompletionTagWrites({ job: ready(), patch: { status: 'completed' }, requestId: crypto.randomUUID(), now }), null);
  const f = await fixture(); await f.drain(now, { ...env, EGC_GHL_FIELD_COMPLETION_TAG: '' });
  assert.equal(f.calls.length, 0); assert.equal(f.entry().status, 'parked');
});

test('known refusal backs off and recovers once; only the completion tag is written', async () => {
  const f = await fixture(); f.post('429');
  assert.equal((await f.drain()).retrying, 1); assert.equal(f.entry().steps.completionTag, undefined);
  f.post('ok'); assert.equal((await f.drain('2026-10-15T18:02:00.000Z')).done, 1);
  assert.equal((await f.drain('2026-10-15T19:00:00.000Z')).attempted, 0);
  assert.equal(f.entry().steps.completionTag, 'verified');
  for (const key of ['payment', 'invoice', 'commission', 'acceptance']) assert.deepEqual(f.job[key], ready()[key]);
});

test('lost receipt reconciles by read only, with no duplicate POST or financial side effects', async () => {
  const f = await fixture(); f.post('lost-present'); await f.drain();
  assert.equal(f.entry().status, 'parked'); assert.equal(f.entry().lastError, 'ghl_tag_completion_receipt_unknown');
  await f.retry(); assert.equal((await f.drain('2026-10-15T18:10:00.000Z')).done, 1);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('unknown receipt with absent tag stays parked even after manager retry; no blind resend', async () => {
  const f = await fixture(); f.post('lost-absent'); await f.drain(); await f.retry();
  await f.drain('2026-10-15T18:10:00.000Z');
  assert.equal(f.entry().status, 'parked'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('lost final storage write recovers durable sending state through readback', async () => {
  const f = await fixture(); f.failFinal(); assert.equal((await f.drain()).busy, 1);
  assert.equal(f.entry().steps.completionTag, 'sending');
  assert.equal((await f.drain('2026-10-15T18:06:00.000Z')).done, 1);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('changed contact, cancelled work and unverified reads never write a completion tag', async () => {
  const changed = await fixture(); changed.job.highlevelContactId = 'contact-2'; await changed.drain();
  assert.equal(changed.entry().status, 'parked'); assert.equal(changed.calls.length, 0);
  const cancelled = await fixture(); cancelled.job.pipelineStatus = 'cancelled'; await cancelled.drain();
  assert.equal(cancelled.entry().skipped, 'superseded'); assert.equal(cancelled.calls.length, 0);
  const wrong = await fixture(); wrong.read('wrong'); await wrong.drain();
  assert.equal(wrong.calls.some(call => call.method === 'POST'), false);
});

test('a preexisting tag from a prior job is not proof of this completion', async () => {
  const f = await fixture(); f.tags(['egc-job-complete']); await f.drain();
  assert.equal(f.entry().status, 'parked'); assert.equal(f.entry().lastError, 'ghl_tag_completion_preexisting');
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('Command center projected reads keep failed completion visible instead of discarding it as superseded', async () => {
  const f = await fixture(); f.post('lost-absent'); await f.drain();
  f.store.readMany = async (collection, ids, fields) => Promise.all(ids.map(async id => {
    const source = await f.store.read(collection, id), projected = { id };
    for (const path of fields) {
      const keys = path.split('.'); let value = source;
      for (const key of keys) value = value?.[key];
      if (value === undefined) continue;
      let target = projected; for (const key of keys.slice(0, -1)) target = target[key] ||= {};
      target[keys.at(-1)] = value;
    }
    return projected;
  }));
  const status = await ghlTagStuck(f.store, '2026-10-15T18:30:00.000Z');
  assert.equal(status.parked, 1); assert.equal(status.visits, 1); assert.equal(f.entry().status, 'parked');
});

async function secondCompletion(f) {
  const job = { ...ready(), id: 'job-2' }, result = close(job);
  const intent = await fieldCompletionTagWrites({ job, patch: result.patch, requestId: result.requestId, now });
  f.rows.set('jobs/job-2', { ...job, ...result.patch });
  f.rows.set(GHL_TAG_OUTBOX + '/' + intent.write.id, { ...intent.write.patch, revision: 'second' });
  return intent.write.id;
}
test('concurrent completions for one contact cannot duplicate the tag transition', async () => {
  const f = await fixture(), first = f.entry().id, second = await secondCompletion(f);
  await Promise.all([f.drain(now, env, { ids: [first] }), f.drain(now, env, { ids: [second] })]);
  await f.drain('2026-10-15T18:10:00.000Z');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  const completions = [...f.rows.values()].filter(row => row.kind === 'field_completion');
  assert.equal(completions.filter(row => row.status === 'done').length, 1);
  assert.equal(completions.filter(row => row.status === 'parked').length, 1);
});
test('another job cannot take over an uncertain contact receipt even if the tag is present', async () => {
  const f = await fixture(); f.post('lost-present'); await f.drain();
  const second = await secondCompletion(f); await f.drain(now, env, { ids: [second] });
  const row = f.rows.get(GHL_TAG_OUTBOX + '/' + second);
  assert.equal(row.status, 'parked'); assert.equal(row.lastError, 'ghl_tag_completion_contact_busy');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
