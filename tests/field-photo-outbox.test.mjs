import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';
import { fieldFingerprint } from '../functions/_lib/field-execution.js';

// Field photos ride the same per-user IndexedDB outbox as checklist, note and
// status actions: queued with the request ID the server's photo receipt is
// keyed on, replayed in order, shown as pending thumbnails and deleted at sign-out.
const source = readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-22T15:00:00.000Z');
const plain = value => JSON.parse(JSON.stringify(value));
const fail = (message, status, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN5sAAAAASUVORK5CYII=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
let counter = 0;
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

function load({ indexedDB = fakeIndexedDB(), locks, fetch, AbortSignal } = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, URL, Error, TypeError, Map, Set, encodeURIComponent, indexedDB, ...(fetch ? { fetch } : {}), ...(AbortSignal ? { AbortSignal } : {}), ...(locks ? { navigator: { locks } } : {}) });
  context.self = context;
  vm.runInContext(source, context);
  return { api: context.EGCFieldOutbox, indexedDB };
}
function outbox(options = {}) {
  const loaded = load(options), clock = { at: NOW };
  return { ...loaded, clock, box: loaded.api.create({ now: () => new Date(clock.at++) }) };
}
function field(user, jobId, action, extra = {}, seen = 'seen-1') {
  const requestId = id();
  return { requestId, kind: 'field', user, jobId, payload: { action, ...extra, jobId, requestId, expectedRevision: seen, expectedUser: user } };
}
const photo = (user, jobId, category = 'before', extra = {}) => field(user, jobId, 'photo', { category, caption: `Synthetic ${category} caption`, dataUrl: PNG, ...extra });

function transport(script = {}) {
  const calls = []; let revision = 0;
  const step = async (name, value, run) => {
    calls.push([name, plain(value ?? null)]);
    await new Promise(resolve => setTimeout(resolve, 1));
    const outcome = run ? await run(value, calls) : undefined;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return {
    calls,
    sent: kind => calls.filter(([name]) => name === kind).map(([, value]) => value),
    session: () => step('session', null, script.session).then(value => value || { ok: true, user: 'Crew.One' }),
    revision: jobId => step('revision', jobId, script.revision).then(value => value || `server-rev-${++revision}`),
    field: input => step('field', input, script.field).then(value => value || { ok: true, alreadyApplied: false, job: { id: input.jobId } }),
    shift: () => step('shift', null, script.shift).then(value => value || { ok: true, user: 'Crew.One', entry: null }),
    employee: body => step('employee', body, script.employee).then(value => value || { ok: true }),
  };
}

test('photos replay in order with the job’s other actions, keep their request IDs and always confirm the current job version', async () => {
  const { box } = outbox();
  const before = photo('Crew.One', 'job-a', 'before'), start = field('Crew.One', 'job-a', 'status', { status: 'in_progress' }), after = photo('Crew.One', 'job-a', 'after', { dataUrl: JPEG }), check = field('Crew.One', 'job-a', 'checklist', { itemId: 'finish-sweep', completed: true });
  const { direct } = await box.enqueue(before); assert.equal(direct, true);
  for (const item of [start, after, check]) await box.enqueue(item);
  const wire = transport(), started = [], applied = [];
  const result = await box.flush({ user: 'Crew.One', transport: wire, direct: before.requestId, onStart: item => started.push(item.requestId), onApplied: item => applied.push(item.requestId) });
  assert.deepEqual(wire.sent('field').map(input => input.requestId), [before, start, after, check].map(item => item.requestId), 'a before photo uploads ahead of the start it unlocks');
  assert.deepEqual(plain(wire.calls.slice(0, 2).map(([name]) => name)), ['revision', 'field'], 'even a watched first attempt confirms the version: a photo only adds evidence');
  assert.deepEqual(started, applied); assert.equal(result.applied.length, 4); assert.equal(result.remaining, 0);
  const [sentBefore] = wire.sent('field');
  assert.deepEqual({ ...sentBefore, expectedRevision: 'seen-1' }, before.payload, 'the upload body is exactly what was queued apart from the refreshed version');
  assert.equal(sentBefore.expectedRevision, 'server-rev-1');
  assert.equal(await fieldFingerprint('Crew.One', sentBefore), await fieldFingerprint('Crew.One', before.payload), 'the server receipt matches every replay of the same photo');
  assert.equal((await box.items('Crew.One')).length, 0);
});

test('a lost upload stays queued with its ID and the replay is recognised by the server receipt', async () => {
  const { box } = outbox(), item = photo('Crew.One', 'job-a', 'after');
  await box.enqueue(item);
  const offline = transport({ field: () => fail('The server did not confirm this action.', 0, 'OUTBOX_NETWORK') });
  const first = await box.flush({ user: 'Crew.One', transport: offline });
  assert.equal(first.stopped.reason, 'network');
  const [waiting] = plain(await box.items('Crew.One'));
  assert.equal(waiting.state, 'queued'); assert.equal(waiting.attempts, 1); assert.equal(waiting.payload.dataUrl, PNG, 'the photo itself stays on the phone');
  const back = transport({ field: () => ({ ok: true, alreadyApplied: true, job: { id: 'job-a' } }) });
  const second = await box.flush({ user: 'Crew.One', transport: back });
  assert.deepEqual(back.sent('field').map(input => input.requestId), [item.requestId]);
  assert.equal(second.applied[0].data.alreadyApplied, true); assert.equal(second.remaining, 0);
});

test('a refused photo waits with its thumbnail for Retry or Discard, even on a watched first attempt', async () => {
  const { box } = outbox(), bad = photo('Crew.One', 'job-a', 'damage'), behind = field('Crew.One', 'job-a', 'note', { body: 'Waits behind the refused photo', issue: false, visibility: 'crew' });
  await box.enqueue(bad); await box.enqueue(behind);
  for (const error of [fail('Choose a JPG, PNG or WebP photo.', 400, ''), fail('This job is not currently assigned to your account.', 403, 'FIELD_JOB_NOT_ASSIGNED'), fail('This job already has 100 field photos.', 409, 'FIELD_PHOTO_LIMIT')]) {
    const wire = transport({ field: input => input.requestId === bad.requestId ? error : undefined });
    const result = await box.flush({ user: 'Crew.One', transport: wire, direct: bad.requestId, retry: [bad.requestId] });
    assert.equal(result.stopped.reason, 'rejected'); assert.equal(result.stopped.discarded, undefined, `${error.status} never drops the photo`);
    const rows = plain(await box.items('Crew.One'));
    assert.deepEqual(rows.map(row => row.requestId), [bad.requestId, behind.requestId]);
    assert.equal(rows[0].state, 'error'); assert.equal(rows[0].error.message, error.message); assert.equal(rows[0].payload.dataUrl, PNG);
    assert.equal(wire.sent('field').length, 1, 'later actions for the job wait behind it');
  }
  const idle = transport();
  await box.flush({ user: 'Crew.One', transport: idle });
  assert.equal(idle.sent('field').length, 0, 'an automatic replay never re-sends a refused photo');
  const retried = transport();
  const result = await box.flush({ user: 'Crew.One', transport: retried, retry: [bad.requestId] });
  assert.deepEqual(retried.sent('field').map(input => input.requestId), [bad.requestId, behind.requestId]);
  assert.equal(retried.sent('field')[0].dataUrl, PNG); assert.equal(result.remaining, 0);
});

test('a job changed between a photo’s version check and its upload is retried at once, and a job that keeps changing waits for review', async () => {
  const { box } = outbox(), item = photo('Crew.One', 'job-a', 'progress'), next = field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true });
  await box.enqueue(item); await box.enqueue(next);
  let conflicts = 1;
  const wire = transport({ field: input => input.requestId === item.requestId && conflicts-- > 0 ? fail('This job changed.', 409, 'FIELD_REVISION_CONFLICT') : undefined });
  const result = await box.flush({ user: 'Crew.One', transport: wire });
  assert.deepEqual(plain(wire.calls.map(([name]) => name)), ['revision', 'field', 'revision', 'field', 'revision', 'field']);
  assert.deepEqual(wire.sent('field').map(input => [input.requestId, input.expectedRevision]), [[item.requestId, 'server-rev-1'], [item.requestId, 'server-rev-2'], [next.requestId, 'server-rev-3']]);
  assert.equal(result.stopped, null); assert.equal(result.applied.length, 2);
  const busy = photo('Crew.One', 'job-a', 'after'); await box.enqueue(busy);
  const always = transport({ field: () => fail('This job changed.', 409, 'FIELD_REVISION_CONFLICT') });
  const stuck = await box.flush({ user: 'Crew.One', transport: always });
  assert.equal(always.sent('field').length, 5, 'bounded like any repeating server failure');
  assert.equal(stuck.stopped.reason, 'rejected');
  const [row] = plain(await box.items('Crew.One'));
  assert.equal(row.state, 'error'); assert.match(row.error.message, /^The server could not confirm this after 5 tries\./);
  // Retry (the page's Retry photo, or a retry saved while another upload runs) starts the run of re-sends again.
  const retried = transport({ field: () => fail('This job changed.', 409, 'FIELD_REVISION_CONFLICT') });
  assert.equal((await box.flush({ user: 'Crew.One', transport: retried, retry: [busy.requestId] })).stopped.reason, 'rejected');
  assert.equal(retried.sent('field').length, 5, 'a retried photo again gets five re-sends, not one');
  await box.retry(busy.requestId);
  assert.equal(plain(await box.items('Crew.One'))[0].serverFailures, 0);
  const saved = transport({ field: input => conflicts++ < 3 ? fail('This job changed.', 409, 'FIELD_REVISION_CONFLICT') : undefined });
  conflicts = 0;
  assert.equal((await box.flush({ user: 'Crew.One', transport: saved })).applied.length, 1, 'a busy job still takes the retried photo within its re-sends');
  assert.equal(saved.sent('field').length, 4);
  const note = field('Crew.One', 'job-a', 'note', { body: 'Stale view', issue: false, visibility: 'crew' });
  await box.enqueue(note);
  await box.flush({ user: 'Crew.One', transport: transport({ field: () => fail('This job changed.', 409, 'FIELD_REVISION_CONFLICT') }) });
  assert.equal(plain(await box.items('Crew.One'))[0].state, 'error', 'other actions still stop on a revision conflict for review');
});

test('a photo upload gets two minutes before it counts as a lost connection; other actions keep thirty seconds', async () => {
  const replies = [];
  const fetch = async (url, init) => { replies.push([url, init]); return Response.json({ ok: true, job: { id: 'job-a' } }); };
  const { api } = load({ fetch, AbortSignal: { timeout: ms => ({ timeoutMs: ms }) } });
  const wire = api.httpTransport();
  await wire.field(photo('Crew.One', 'job-a').payload);
  await wire.field(field('Crew.One', 'job-a', 'note', { body: 'Synthetic', issue: false, visibility: 'crew' }).payload);
  await wire.employee({ collection: 'timeEntries', id: 'time-1', data: {} });
  assert.deepEqual(replies.map(([, init]) => init.signal.timeoutMs), [120000, 30000, 30000]);
  assert.equal(JSON.parse(replies[0][1].body).dataUrl, PNG);
});

test('only a well-formed photo is queued', async () => {
  const { box } = outbox();
  for (const payload of [{ dataUrl: 'data:text/plain;base64,SGVsbG8=' }, { dataUrl: `data:image/png;base64,${'A'.repeat(8 * 1024 * 1024)}` }, { dataUrl: 'https://example.invalid/photo.jpg' }, { dataUrl: `${PNG}<script>` }, { category: '' }, { category: 7 }, { caption: null }]) {
    await assert.rejects(box.enqueue(photo('Crew.One', 'job-a', 'before', payload)), error => error.code === 'OUTBOX_INVALID', JSON.stringify(payload).slice(0, 80));
  }
  for (const dataUrl of [PNG, JPEG, 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4IAoAAAAwAQCdASoBAAEAAQA0JaQAA3AA/vuUAAA=']) await box.enqueue(photo('Crew.One', 'job-a', 'after', { dataUrl, caption: '' }));
  assert.equal((await box.items('Crew.One')).length, 3);
  assert.deepEqual([...load().api.QUEUEABLE].sort(), ['checklist', 'material', 'note', 'photo', 'status']);
});

test('a full phone is reported as full and the outbox keeps using IndexedDB', async () => {
  const indexedDB = fakeIndexedDB(), { box } = outbox({ indexedDB }), kept = field('Crew.One', 'job-a', 'note', { body: 'Queued before the phone filled up', issue: false, visibility: 'crew' });
  await box.enqueue(kept);
  indexedDB.fillNextWrite();
  await assert.rejects(box.enqueue(photo('Crew.One', 'job-a', 'after')), error => error.code === 'OUTBOX_FULL' && /out of storage/.test(error.message));
  assert.equal(box.persistent, true, 'a full device is not a reason to fall back to page memory');
  assert.deepEqual(plain((await box.items('Crew.One')).map(row => row.requestId)), [kept.requestId], 'earlier saved work is still shown');
  const later = photo('Crew.One', 'job-a', 'after'); await box.enqueue(later);
  assert.deepEqual(indexedDB.rows('egc-field-outbox', 'actions').map(row => row.requestId), [kept.requestId, later.requestId]);
});

test('on a full phone a job or time action is still kept in page memory and sent, as before photos were queued', async () => {
  const indexedDB = fakeIndexedDB(), { box } = outbox({ indexedDB }), waiting = photo('Crew.One', 'job-a', 'before'), check = field('Crew.One', 'job-a', 'checklist', { itemId: 'arrival-walk', completed: true }), clockOut = { requestId: id(), kind: 'clock', user: 'Crew.One', jobId: 'job-a', payload: { op: 'clock_out', entryId: 'time-crew.one-1', deviceCapturedAt: '2026-09-22T23:00:00.000Z' } };
  await box.enqueue(waiting);
  indexedDB.fillNextWrite();
  const { direct } = await box.enqueue(check);
  assert.equal(direct, false, 'it still waits behind the photo queued before it');
  assert.equal(box.persistent, false, 'the page warns before it is closed while the action is only in memory');
  indexedDB.fillNextWrite();
  await box.enqueue(clockOut);
  assert.deepEqual(plain((await box.items('Crew.One')).map(row => row.requestId)), [waiting.requestId, check.requestId, clockOut.requestId], 'saved work in IndexedDB and in memory replays in one order');
  assert.deepEqual(indexedDB.rows('egc-field-outbox', 'actions').map(row => row.requestId), [waiting.requestId], 'the photo stays in IndexedDB');
  indexedDB.fillNextWrite();
  await assert.rejects(box.enqueue(photo('Crew.One', 'job-a', 'after')), error => error.code === 'OUTBOX_FULL', 'a new photo is still refused, never kept only in memory');
  const wire = transport({ field: input => input.requestId === check.requestId && !wire.failed ? (wire.failed = true, fail('No connection', 0, 'OUTBOX_NETWORK')) : undefined, shift: () => ({ ok: true, user: 'Crew.One', entry: { id: 'time-crew.one-1', breaks: [] } }) });
  const first = await box.flush({ user: 'Crew.One', transport: wire });
  assert.equal(first.stopped.reason, 'network');
  assert.equal(plain(await box.items('Crew.One')).find(row => row.requestId === check.requestId).attempts, 1, 'a failed send updates the copy in memory');
  const second = await box.flush({ user: 'Crew.One', transport: wire });
  assert.deepEqual(plain(second.applied.map(({ item }) => item.requestId)), [check.requestId, clockOut.requestId]);
  assert.equal(second.remaining, 0); assert.equal(box.persistent, true, 'once they are confirmed the page no longer depends on memory');
  assert.deepEqual(wire.sent('field').map(input => input.requestId), [waiting.requestId, check.requestId, check.requestId]);
  assert.equal(wire.sent('employee').length, 1);
});

test('discarding a waiting photo waits for a running upload and never reports an uploaded photo as discarded', async () => {
  const names = [];
  const locks = { request: async (name, task) => { names.push(name); return task(); } };
  const { box, indexedDB } = outbox({ locks }), uploading = photo('Crew.One', 'job-a', 'after'), waiting = photo('Crew.One', 'job-a', 'damage');
  await box.enqueue(uploading); await box.enqueue(waiting);
  let release, started; const gate = new Promise(resolve => { release = resolve; }), sending = new Promise(resolve => { started = resolve; });
  const wire = transport({ field: async input => { if (input.requestId === uploading.requestId) { started(); await gate; } } });
  const flush = box.flush({ user: 'Crew.One', transport: wire });
  // The replay has read the queue and is uploading the photo, held open until release().
  await sending;
  let settled = false;
  const withdrawn = box.withdraw(uploading.requestId).then(value => { settled = true; return value; });
  // All the discard could do without waiting for the upload has run by now.
  await indexedDB.idle();
  assert.equal(settled, false, 'the discard waits while the photo is uploading');
  release(); await flush;
  assert.equal(await withdrawn, false, 'the photo was saved to the job, so it is not reported as discarded');
  assert.deepEqual(wire.sent('field').map(input => input.requestId), [uploading.requestId, waiting.requestId]);
  const later = photo('Crew.One', 'job-a', 'before'); await box.enqueue(later);
  assert.equal(await box.withdraw(later.requestId), true);
  assert.equal((await box.items('Crew.One')).length, 0);
  assert.equal(await box.withdraw(later.requestId), false);
  assert.deepEqual(names, ['egc-field-outbox', 'egc-field-outbox', 'egc-field-outbox', 'egc-field-outbox'], 'discards share the replay lock with the service worker');
});

test('while a photo uploads, a photo waiting behind it is discarded at once and never sent', async () => {
  const names = [];
  const locks = { request: async (name, task) => { names.push(name); return task(); } };
  const { box, indexedDB } = outbox({ locks }), uploading = photo('Crew.One', 'job-a', 'before'), behind = photo('Crew.One', 'job-a', 'progress'), note = field('Crew.One', 'job-a', 'note', { body: 'Sent after the photos', issue: false, visibility: 'crew' });
  for (const item of [uploading, behind, note]) await box.enqueue(item);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const wire = transport({ field: async input => { if (input.requestId === uploading.requestId) await gate; } });
  const flush = box.flush({ user: 'Crew.One', transport: wire });
  while (!wire.sent('field').length) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(await box.withdraw(behind.requestId), true, 'the discard does not wait for the upload in progress');
  let settled = false; const sending = box.withdraw(uploading.requestId).then(value => { settled = true; return value; });
  await indexedDB.idle();
  assert.equal(settled, false, 'the photo being sent still waits for its upload');
  release(); await flush;
  assert.equal(await sending, false, 'it was saved to the job, so it is not reported as discarded');
  assert.deepEqual(wire.sent('field').map(input => input.requestId), [uploading.requestId, note.requestId]);
  assert.deepEqual(names, ['egc-field-outbox', 'egc-field-outbox'], 'only the discard of the photo being sent queued behind the lock');
  assert.equal((await box.items('Crew.One')).length, 0);
});

test('a photo discarded after the replay read it, just before it was sent, is still never sent', async () => {
  const { api } = load(), rows = api.memoryStore(); let hold = null;
  const store = { persistent: false, put: rows.put, restore: rows.restore, remove: rows.remove, all: async () => { const found = await rows.all(), wait = hold; hold = null; if (wait) await wait; return found; } };
  const box = api.create({ store, now: () => new Date(NOW) }), first = photo('Crew.One', 'job-a', 'before'), second = photo('Crew.One', 'job-a', 'after'), note = field('Crew.One', 'job-a', 'note', { body: 'Still sent', issue: false, visibility: 'crew' });
  for (const item of [first, second, note]) await box.enqueue(item);
  let release, unhold; const gate = new Promise(resolve => { release = resolve; }), read = new Promise(resolve => { unhold = resolve; });
  const wire = transport({ field: async input => { if (input.requestId === first.requestId) await gate; } });
  const flush = box.flush({ user: 'Crew.One', transport: wire });
  while (!wire.sent('field').length) await new Promise(resolve => setTimeout(resolve, 1));
  // The replay's next read already holds the second photo when the discard lands.
  hold = read; release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(hold, null, 'the replay is reading the queue');
  assert.equal(await box.withdraw(second.requestId), true);
  unhold(); await flush;
  assert.deepEqual(wire.sent('field').map(input => input.requestId), [first.requestId, note.requestId]);
});

test('a photo deleted at sign-out in another tab while it uploads is never written back, however the upload ends', async () => {
  const outcomes = [['a sign-in prompt', fail('Sign in again.', 401, 'FIELD_AUTH_REQUIRED'), 'auth'], ['a lost connection', fail('No connection', 0, 'OUTBOX_NETWORK'), 'network'], ['a refusal', fail('Choose a JPG, PNG or WebP photo.', 400, ''), null], ['a job that changed', fail('This job changed.', 409, 'FIELD_REVISION_CONFLICT'), null], ['a server error', fail('Job storage is unavailable.', 503, 'FIELD_STORAGE_UNAVAILABLE'), 'transient']];
  for (const [label, error, reason] of outcomes) {
    const indexedDB = fakeIndexedDB(), { box } = outbox({ indexedDB }), otherTab = outbox({ indexedDB }).box, item = photo('Crew.One', 'job-a', 'before');
    await box.enqueue(item);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const wire = transport({ field: async () => { await gate; return error; } });
    const flush = box.flush({ user: 'Crew.One', transport: wire });
    while (!wire.sent('field').length) await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual(plain(await otherTab.purgePhotos(Date.parse(NOW) + 60000)), [item.requestId]);
    release();
    const result = await flush;
    assert.equal(result.stopped?.reason ?? null, reason, label);
    assert.deepEqual(indexedDB.rows('egc-field-outbox', 'actions'), [], `${label} does not bring the deleted photo back`);
    assert.equal(wire.sent('field').length, 1, `${label}: sent once, never again`);
  }
});

test('photos queued before a sign-out are deleted, never uploaded; other saved work and later photos stay', async () => {
  const { box, clock } = outbox();
  const early = photo('Crew.One', 'job-a', 'before'), otherUser = photo('Crew.Two', 'job-b', 'before'), note = field('Crew.One', 'job-a', 'note', { body: 'Kept through a sign-out', issue: false, visibility: 'crew' });
  await box.enqueue(early); await box.enqueue(otherUser); await box.enqueue(note);
  const signedOutAt = clock.at++;
  const later = photo('Crew.One', 'job-a', 'after'); await box.enqueue(later);
  assert.deepEqual(plain(await box.purgePhotos(signedOutAt)), [early.requestId, otherUser.requestId]);
  assert.deepEqual(plain((await box.items('Crew.One')).map(row => row.requestId)), [note.requestId, later.requestId]);
  assert.deepEqual(plain(await box.purgePhotos(0)), [], 'nothing is deleted when the phone never signed out');
  assert.deepEqual(plain(await box.purgePhotos()), [later.requestId]);
  const wire = transport();
  await box.flush({ user: 'Crew.One', transport: wire });
  assert.deepEqual(wire.sent('field').map(input => input.requestId), [note.requestId]);
});

test('drafts from the retired photo queue move into the outbox under the ID they were uploaded with', async () => {
  const indexedDB = fakeIndexedDB(), { box, api } = outbox({ indexedDB });
  const drafts = api.idbStore(indexedDB, { name: 'egc-field-photo-drafts', store: 'photos', key: 'id' });
  const mine = { id: id(), user: 'Crew.One', jobId: 'job-a', category: 'before', caption: 'Synthetic north wall', dataUrl: PNG, state: 'ready', persisted: true, error: 'The server did not confirm this action.' };
  const mineElsewhere = { id: id(), user: 'crew.one', jobId: 'job-b', category: 'after', caption: '', dataUrl: JPEG, state: 'ready', persisted: true };
  const theirs = { id: id(), user: 'Crew.Two', jobId: 'job-a', category: 'before', caption: 'Synthetic other account', dataUrl: PNG };
  const broken = { id: id(), user: 'Crew.One', jobId: 'job-a', category: 'before', caption: '', dataUrl: 'data:text/plain;base64,SGVsbG8=' };
  for (const row of [mine, mineElsewhere, theirs, broken]) await drafts.put(row);
  assert.deepEqual(plain(await box.adoptPhotoDrafts('Crew.One', indexedDB)), [mine.id, mineElsewhere.id]);
  const queued = plain(await box.items('Crew.One'));
  assert.deepEqual(queued.map(row => [row.requestId, row.jobId, row.state, row.attempts]), [[mine.id, 'job-a', 'queued', 1], [mineElsewhere.id, 'job-b', 'queued', 1]]);
  assert.deepEqual(queued[0].payload, { jobId: 'job-a', requestId: mine.id, expectedRevision: '', expectedUser: 'Crew.One', action: 'photo', category: 'before', caption: 'Synthetic north wall', dataUrl: PNG });
  // The former queue uploaded exactly these fields, so a draft whose reply was lost matches its receipt.
  const formerUpload = { jobId: mine.jobId, requestId: mine.id, expectedRevision: 'rev-then', expectedUser: mine.user, action: 'photo', category: mine.category, caption: mine.caption, dataUrl: mine.dataUrl };
  assert.equal(await fieldFingerprint('Crew.One', queued[0].payload), await fieldFingerprint('Crew.One', formerUpload));
  assert.deepEqual(indexedDB.rows('egc-field-photo-drafts', 'photos').map(row => row.id).sort(), [theirs.id, broken.id].sort(), 'another account’s drafts and unusable rows are left alone');
  assert.deepEqual(indexedDB.stats.deleted, [], 'the old store stays while it still holds drafts');
  assert.deepEqual(plain(await box.adoptPhotoDrafts('Crew.One', indexedDB)), [], 'a draft moves once');
  const wire = transport();
  await box.flush({ user: 'Crew.One', transport: wire });
  assert.deepEqual(wire.sent('field').map(input => [input.requestId, input.expectedRevision]), [[mine.id, 'server-rev-1'], [mineElsewhere.id, 'server-rev-2']]);
  assert.deepEqual(plain(await box.adoptPhotoDrafts('Crew.Two', indexedDB)), [theirs.id]);
  await drafts.remove(broken.id);
  assert.deepEqual(plain(await box.adoptPhotoDrafts('Crew.Two', indexedDB)), []);
  assert.deepEqual(indexedDB.stats.deleted, ['egc-field-photo-drafts'], 'the emptied old store is removed');
  const fresh = fakeIndexedDB(), none = outbox({ indexedDB: fresh });
  assert.deepEqual(plain(await none.box.adoptPhotoDrafts('Crew.One', fresh)), []);
  assert.equal(fresh.stored.has('egc-field-photo-drafts'), false, 'a phone that never had the old store does not get one');
  assert.deepEqual(plain(await none.box.adoptPhotoDrafts('', fresh)), []);
});

test('waiting photos are projected onto the job with their thumbnails, refused ones flagged, without touching confirmed evidence', () => {
  const { api } = load();
  const job = { id: 'job-a', status: 'in_progress', fieldStatus: 'in_progress', allowedStatuses: [], checklist: [{ id: 'one', completed: false }], materials: [], photos: [{ id: 'verified-1', category: 'before' }] };
  const row = (item, state = 'queued', extra = {}) => ({ ...item, queuedAt: '2026-09-22T15:00:00.000Z', attempts: 0, state, ...extra });
  const waiting = photo('Crew.One', 'job-a', 'after'), refused = photo('Crew.One', 'job-a', 'damage', { caption: 'Synthetic dent' }), elsewhere = photo('Crew.One', 'job-b', 'after');
  const view = plain(api.projectJob(job, [row(waiting), row(refused, 'error', { attempts: 2, error: { message: 'This job already has 100 field photos.', code: 'FIELD_PHOTO_LIMIT' } }), row(elsewhere), row(field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true }))]));
  assert.deepEqual(view.photoQueue, [
    { requestId: waiting.requestId, category: 'after', caption: 'Synthetic after caption', dataUrl: PNG, queuedAt: '2026-09-22T15:00:00.000Z', attempts: 0, state: 'queued', error: null },
    { requestId: refused.requestId, category: 'damage', caption: 'Synthetic dent', dataUrl: PNG, queuedAt: '2026-09-22T15:00:00.000Z', attempts: 2, state: 'error', error: { message: 'This job already has 100 field photos.', code: 'FIELD_PHOTO_LIMIT' } },
  ]);
  assert.deepEqual(view.photos, job.photos, 'a waiting photo is never shown as verified');
  assert.equal(view.checklist[0].completed, true);
  assert.equal(api.isPhoto(waiting), true); assert.equal(api.isPhoto(field('Crew.One', 'job-a', 'note', {})), false);
});
