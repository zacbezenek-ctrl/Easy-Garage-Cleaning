import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const source = readFileSync(new URL('../crew/field-outbox.js', import.meta.url), 'utf8');
const NOW = '2026-09-22T15:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const fail = (message, status, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
let counter = 0;
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

function load({ indexedDB = fakeIndexedDB(), locks, fetch } = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, URL, Error, TypeError, Map, Set, encodeURIComponent, indexedDB, ...(fetch ? { fetch } : {}), ...(locks ? { navigator: { locks } } : {}) });
  context.self = context;
  vm.runInContext(source, context);
  return { api: context.EGCFieldOutbox, indexedDB };
}
function outbox(options = {}) {
  const loaded = load(options), clock = { at: Date.parse(NOW) };
  return { ...loaded, box: loaded.api.create({ now: () => new Date(clock.at++) }) };
}
function field(user, jobId, action, extra = {}, seen = 'seen-1') {
  const requestId = id();
  return { requestId, kind: 'field', user, jobId, payload: { action, ...extra, jobId, requestId, expectedRevision: seen, expectedUser: user } };
}
const clock = (user, op, extra = {}) => { const requestId = id(); return { requestId, kind: 'clock', user, jobId: 'job-a', payload: { op, entryId: 'time-crew.one-1', deviceCapturedAt: '2026-09-22T14:30:00.000Z', ...extra, ...(op === 'job_time' ? { jobAction: { requestId, expectedSegmentId: 'clock-in:time-crew.one-1', jobId: 'job-a', kind: 'work', ...extra.jobAction } } : {}) } }; };

function transport(script = {}) {
  const calls = []; let revision = 0, active = 0, overlap = false;
  const step = async (name, value, run) => {
    active++; if (active > 1) overlap = true; calls.push([name, plain(value ?? null)]);
    try { await new Promise(resolve => setTimeout(resolve, 2)); const outcome = run ? await run(value, calls) : undefined; if (outcome instanceof Error) throw outcome; return outcome; } finally { active--; }
  };
  return {
    calls, get overlap() { return overlap; },
    sent: kind => calls.filter(([name]) => name === kind).map(([, value]) => value),
    session: () => step('session', null, script.session).then(value => value || { ok: true, user: 'Crew.One' }),
    revision: jobId => step('revision', jobId, script.revision).then(value => value || `server-rev-${++revision}`),
    field: input => step('field', input, script.field).then(value => value || { ok: true, alreadyApplied: false, job: { id: input.jobId } }),
    shift: () => step('shift', null, script.shift).then(value => value || { ok: true, user: 'Crew.One', entry: null }),
    employee: body => step('employee', body, script.employee).then(value => value || { ok: true, record: { id: body.id } }),
  };
}

test('queued field actions replay one at a time, in order, each with a freshly confirmed job revision', async () => {
  const { box } = outbox(), queued = [field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true }), field('Crew.One', 'job-a', 'checklist', { itemId: 'two', completed: true }), field('Crew.One', 'job-a', 'checklist', { itemId: 'three', completed: true }), field('Crew.One', 'job-a', 'note', { body: 'Synthetic offline note', issue: false, visibility: 'crew' }), field('Crew.One', 'job-a', 'status', { status: 'dispatched' })];
  for (const item of queued) await box.enqueue(item);
  const wire = transport(), applied = [];
  const result = await box.flush({ user: 'Crew.One', transport: wire, onApplied: item => applied.push(item.requestId) });
  assert.deepEqual(plain(wire.calls.map(([name]) => name)), ['revision', 'field', 'revision', 'field', 'revision', 'field', 'revision', 'field', 'revision', 'field']);
  assert.deepEqual(wire.sent('field').map(input => input.requestId), queued.map(item => item.requestId), 'request IDs replay unchanged and in queue order');
  assert.deepEqual(wire.sent('field').map(input => input.expectedRevision), ['server-rev-1', 'server-rev-2', 'server-rev-3', 'server-rev-4', 'server-rev-5']);
  assert.ok(wire.sent('field').every(input => input.expectedUser === 'Crew.One'));
  assert.equal(wire.overlap, false, 'no two requests are in flight at once');
  assert.deepEqual(applied, queued.map(item => item.requestId));
  assert.equal(result.applied.length, 5); assert.equal(result.stopped, null); assert.equal(result.remaining, 0);
  assert.equal((await box.items('Crew.One')).length, 0);
});

test('a first attempt the crew member is watching keeps the job version they saw', async () => {
  const { box } = outbox(), item = field('Crew.One', 'job-a', 'note', { body: 'Seen version only', issue: false, visibility: 'crew' }, 'seen-7');
  const { direct } = await box.enqueue(item); assert.equal(direct, true);
  const wire = transport();
  await box.flush({ user: 'Crew.One', transport: wire, direct: item.requestId });
  assert.deepEqual(plain(wire.calls.map(([name]) => name)), ['field']);
  assert.equal(wire.sent('field')[0].expectedRevision, 'seen-7');
  const second = field('Crew.One', 'job-a', 'note', { body: 'Behind another', issue: false, visibility: 'crew' });
  await box.enqueue(field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true }));
  assert.equal((await box.enqueue(second)).direct, false, 'an action queued behind another is a replay, not a direct attempt');
});

test('another account’s queued actions are never replayed, shown or removed', async () => {
  const { box } = outbox(), mine = field('Crew.Two', 'job-a', 'checklist', { itemId: 'one', completed: true }), theirs = field('Crew.One', 'job-a', 'note', { body: 'Crew One private note', issue: false, visibility: 'crew' });
  await box.enqueue(theirs); await box.enqueue(mine); await box.enqueue(clock('Crew.One', 'break_start'));
  const wire = transport({ shift: () => ({ ok: true, user: 'Crew.Two', entry: null }) });
  const result = await box.flush({ user: 'CREW.TWO', transport: wire });
  assert.deepEqual(wire.sent('field').map(input => input.requestId), [mine.requestId]);
  assert.equal(wire.sent('employee').length, 0); assert.equal(wire.sent('shift').length, 0);
  assert.equal(result.remaining, 0);
  assert.deepEqual(plain((await box.items('crew.two')).map(item => item.requestId)), []);
  assert.equal((await box.items('Crew.One')).length, 2, 'the other account’s actions stay on the device untouched');
  assert.deepEqual(await box.flush({ user: '', transport: wire }).then(plain), { applied: [], stopped: null, remaining: 0 });
});

for (const [label, error, reason] of [
  ['signed-out session (401)', fail('Sign in to the Employee Hub to open your jobs.', 401, 'FIELD_AUTH_REQUIRED'), 'auth'],
  ['job no longer assigned (403)', fail('This job is not currently assigned to your account.', 403, 'FIELD_JOB_NOT_ASSIGNED'), 'rejected'],
  ['job removed (404)', fail('This job is unavailable.', 404, 'FIELD_JOB_NOT_FOUND'), 'rejected'],
  ['start requirements missing', fail('Complete arrival preparation before starting work.', 409, 'FIELD_START_INCOMPLETE', { missing: ['Upload a before photo.'] }), 'rejected'],
  ['completion requirements missing', fail('Finish the required closeout items.', 409, 'FIELD_COMPLETION_INCOMPLETE', { missing: ['Upload at least one after photo.'] }), 'rejected'],
  ['status no longer available', fail('This status is no longer available.', 409, 'FIELD_STATUS_CONFLICT'), 'rejected'],
  ['job closed', fail('This job is closed.', 409, 'FIELD_JOB_CLOSED'), 'rejected'],
  ['request ID reused for other data', fail('This action ID was already used for different information.', 409, 'FIELD_IDEMPOTENCY_CONFLICT'), 'rejected'],
  ['job changed during replay (409 revision)', fail('This job changed. Refresh to review the latest assignment.', 409, 'FIELD_REVISION_CONFLICT'), 'rejected'],
]) {
  test(`replay stops and surfaces ${label} without sending later actions`, async () => {
    const { box } = outbox(), items = [field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true }), field('Crew.One', 'job-a', 'status', { status: 'in_progress' }), field('Crew.One', 'job-a', 'note', { body: 'After the failure', issue: false, visibility: 'crew' })];
    for (const item of items) await box.enqueue(item);
    const wire = transport({ field: input => input.requestId === items[1].requestId ? error : undefined });
    const result = await box.flush({ user: 'Crew.One', transport: wire });
    assert.equal(result.applied.length, 1); assert.equal(result.stopped.reason, reason); assert.equal(result.stopped.item.requestId, items[1].requestId);
    assert.deepEqual(wire.sent('field').map(input => input.requestId), [items[0].requestId, items[1].requestId], 'the action behind the failure is not sent');
    const left = plain(await box.items('Crew.One'));
    assert.deepEqual(left.map(item => item.requestId), [items[1].requestId, items[2].requestId], 'nothing is dropped silently');
    if (reason === 'auth') assert.equal(left[0].state, 'queued');
    else { assert.equal(left[0].state, 'error'); assert.equal(left[0].error.code, error.code); assert.equal(left[0].error.message, error.message); assert.deepEqual(left[0].error.missing, error.missing || []); }
    const again = transport();
    await box.flush({ user: 'Crew.One', transport: again });
    if (reason === 'auth') assert.equal(again.sent('field').length, 2, 'after signing in again the same actions replay');
    else assert.equal(again.sent('field').length, 0, 'an automatic replay never retries or skips past a refused action');
  });
}

test('a lost connection keeps the action queued with its request ID, and later replay is idempotent', async () => {
  const { box } = outbox(), items = [field('Crew.One', 'job-a', 'note', { body: 'Lost reply', issue: false, visibility: 'crew' }), field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true })];
  for (const item of items) await box.enqueue(item);
  const offline = transport({ field: () => fail('The server did not confirm this action.', 0, 'OUTBOX_NETWORK') });
  const first = await box.flush({ user: 'Crew.One', transport: offline, direct: items[0].requestId });
  assert.equal(first.stopped.reason, 'network'); assert.equal(offline.sent('field').length, 1);
  const stored = plain(await box.items('Crew.One'));
  assert.equal(stored[0].state, 'queued'); assert.equal(stored[0].attempts, 1); assert.equal(stored[0].lastError.code, 'OUTBOX_NETWORK');
  const back = transport({ field: input => ({ ok: true, alreadyApplied: input.requestId === items[0].requestId, job: { id: 'job-a' } }) });
  const second = await box.flush({ user: 'Crew.One', transport: back, direct: items[0].requestId });
  assert.deepEqual(back.sent('field').map(input => input.requestId), items.map(item => item.requestId));
  assert.equal(back.sent('field')[0].expectedRevision, 'server-rev-1', 'after one attempt the replay refreshes the job version');
  assert.equal(second.applied[0].data.alreadyApplied, true); assert.equal(second.remaining, 0);
  for (const [status, code] of [[503, 'FIELD_STORAGE_UNAVAILABLE'], [409, 'FIELD_ACTION_PENDING'], [502, '']]) {
    const item = field('Crew.One', 'job-a', 'checklist', { itemId: 'two', completed: true }); await box.enqueue(item);
    const busy = await box.flush({ user: 'Crew.One', transport: transport({ field: () => fail('Retry shortly', status, code) }) });
    assert.equal(busy.stopped.reason, 'transient'); assert.equal(plain(await box.items('Crew.One'))[0].state, 'queued');
    await box.remove(item.requestId);
  }
});

test('a revision conflict on replay is surfaced and only an explicit retry re-sends the same action', async () => {
  const { box } = outbox(), item = field('Crew.One', 'job-a', 'note', { body: 'Needs review', issue: false, visibility: 'crew' });
  await box.enqueue(item);
  await box.flush({ user: 'Crew.One', transport: transport({ field: () => fail('This job changed. Refresh to review the latest details.', 409, 'FIELD_REVISION_CONFLICT') }) });
  const retry = transport();
  await box.flush({ user: 'Crew.One', transport: retry });
  assert.equal(retry.sent('field').length, 0, 'never overwritten or silently re-sent');
  assert.equal(plain(await box.items('Crew.One'))[0].state, 'error');
  const result = await box.flush({ user: 'Crew.One', transport: retry, retry: [item.requestId] });
  assert.deepEqual(plain(retry.calls.map(([name]) => name)), ['revision', 'field']);
  assert.equal(retry.sent('field')[0].requestId, item.requestId); assert.equal(retry.sent('field')[0].body, 'Needs review');
  assert.equal(result.applied.length, 1); assert.equal(result.remaining, 0);
});

test('a watched first attempt drops definitive refusals like the old retry card, but keeps revision conflicts', async () => {
  const { box } = outbox(), start = field('Crew.One', 'job-a', 'status', { status: 'in_progress' });
  await box.enqueue(start);
  const refused = await box.flush({ user: 'Crew.One', direct: start.requestId, transport: transport({ field: () => fail('Complete arrival preparation before starting work.', 409, 'FIELD_START_INCOMPLETE', { missing: ['Upload a before photo.'] }) }) });
  assert.equal(refused.stopped.discarded, true); assert.deepEqual(plain(refused.stopped.error.missing), ['Upload a before photo.']);
  assert.equal((await box.items('Crew.One')).length, 0);
  const stale = field('Crew.One', 'job-a', 'note', { body: 'Stale view', issue: false, visibility: 'crew' });
  await box.enqueue(stale);
  const conflict = await box.flush({ user: 'Crew.One', direct: stale.requestId, transport: transport({ field: () => fail('This job changed.', 409, 'FIELD_REVISION_CONFLICT') }) });
  assert.equal(conflict.stopped.discarded, undefined);
  assert.equal(plain(await box.items('Crew.One'))[0].state, 'error');
});

test('a refused action blocks only its own job or shift lane on later replays', async () => {
  const { box } = outbox(), a = field('Crew.One', 'job-a', 'status', { status: 'in_progress' }), aNext = field('Crew.One', 'job-a', 'note', { body: 'Waits behind A', issue: false, visibility: 'crew' }), b = field('Crew.One', 'job-b', 'checklist', { itemId: 'one', completed: true }), time = clock('Crew.One', 'job_time');
  for (const item of [a, aNext, b, time]) await box.enqueue(item);
  const first = transport({ field: input => input.requestId === a.requestId ? fail('Start requirements missing', 409, 'FIELD_START_INCOMPLETE') : undefined });
  await box.flush({ user: 'Crew.One', transport: first });
  assert.equal(first.sent('field').length, 1, 'the refusal stops that replay at once');
  const second = transport();
  await box.flush({ user: 'Crew.One', transport: second });
  assert.deepEqual(second.sent('field').map(input => input.requestId), [b.requestId]);
  assert.equal(second.sent('employee').length, 1);
  assert.deepEqual(plain((await box.items('Crew.One')).map(item => item.requestId)), [a.requestId, aNext.requestId]);
});

test('the former single sessionStorage retries migrate into the outbox for the same account and job', async () => {
  const { box } = outbox(), store = new Map(), storage = { getItem: key => store.get(key) ?? null, removeItem: key => store.delete(key), setItem: (key, value) => store.set(key, String(value)) };
  const pending = { action: 'note', body: 'Draft from the old retry card', issue: false, visibility: 'crew', jobId: 'job-a', requestId: id(), expectedRevision: 'old-rev', expectedUser: 'Crew.One' };
  const shiftRequest = id();
  store.set('egc-field:Crew.One:job-a:pending', JSON.stringify(pending));
  store.set('egc-field:Crew.One:job-a:shiftAction', JSON.stringify({ collection: 'timeEntries', id: 'shift-9', data: { jobAction: { requestId: shiftRequest, expectedSegmentId: 'segment-1', jobId: 'job-a', kind: 'travel' } } }));
  store.set('egc-field:Crew.Two:job-a:pending', JSON.stringify({ ...pending, requestId: id(), expectedUser: 'Crew.Two' }));
  assert.deepEqual(plain(await box.migrate(storage, 'Crew.One', 'job-a')), [pending.requestId, shiftRequest]);
  assert.equal(store.has('egc-field:Crew.One:job-a:pending'), false); assert.equal(store.has('egc-field:Crew.One:job-a:shiftAction'), false);
  assert.equal(store.has('egc-field:Crew.Two:job-a:pending'), true, 'another account’s draft is untouched');
  assert.deepEqual(plain(await box.migrate(storage, 'Crew.One', 'job-a')), []);
  const wire = transport();
  await box.flush({ user: 'Crew.One', transport: wire, direct: pending.requestId });
  assert.equal(wire.sent('field')[0].requestId, pending.requestId);
  assert.equal(wire.sent('field')[0].expectedRevision, 'server-rev-1', 'a migrated retry refreshes the job version like Refresh and retry');
  assert.deepEqual(wire.sent('employee')[0], { collection: 'timeEntries', id: 'shift-9', data: { jobAction: { requestId: shiftRequest, expectedSegmentId: 'segment-1', jobId: 'job-a', kind: 'travel' } } }, 'no device time is invented for a migrated switch');
});

test('time-clock replays keep request IDs, send device capture times and build breaks from the current shift', async () => {
  const { box } = outbox(), clockIn = clock('Crew.One', 'clock_in', { lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } }), work = clock('Crew.One', 'job_time'), breakStart = clock('Crew.One', 'break_start', { deviceCapturedAt: '2026-09-22T14:40:00.000Z' }), breakEnd = clock('Crew.One', 'break_end', { deviceCapturedAt: '2026-09-22T14:50:00.000Z' }), clockOut = clock('Crew.One', 'clock_out', { deviceCapturedAt: '2026-09-22T14:55:00.000Z' });
  for (const item of [clockIn, work, breakStart, breakEnd, clockOut]) await box.enqueue(item);
  let shift = { id: 'time-crew.one-1', onBreak: false, breaks: [{ startAt: '2026-09-22T14:00:00.000Z', endAt: '2026-09-22T14:05:00.000Z' }] };
  const wire = transport({ shift: () => ({ ok: true, user: 'crew.one', entry: shift }), employee: body => { if (body.data.breaks) shift = { ...shift, breaks: body.data.breaks, onBreak: body.data.breaks.some(row => !row.endAt) }; } });
  const result = await box.flush({ user: 'Crew.One', transport: wire });
  assert.equal(result.applied.length, 5);
  const [inBody, workBody, startBody, endBody, outBody] = wire.sent('employee');
  assert.deepEqual(inBody, { collection: 'timeEntries', id: 'time-crew.one-1', data: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 }, locationStatus: 'unavailable', deviceCapturedAt: '2026-09-22T14:30:00.000Z' } }, 'Today’s work does not keep sharing location, so it does not claim to');
  assert.deepEqual(workBody.data, { jobAction: { requestId: work.requestId, expectedSegmentId: 'clock-in:time-crew.one-1', jobId: 'job-a', kind: 'work', deviceCapturedAt: '2026-09-22T14:30:00.000Z' } });
  assert.deepEqual(startBody.data.breaks, [{ startAt: '2026-09-22T14:00:00.000Z', endAt: '2026-09-22T14:05:00.000Z' }, { startAt: '2026-09-22T14:40:00.000Z', endAt: '', requestId: breakStart.requestId }], 'stored breaks are extended exactly as saved, with the action’s request ID');
  assert.deepEqual(endBody.data.breaks.at(-1), { startAt: '2026-09-22T14:40:00.000Z', endAt: '2026-09-22T14:50:00.000Z', requestId: breakEnd.requestId });
  assert.deepEqual(outBody.data, { clockOutAt: '2026-09-22T14:55:00.000Z', status: 'submitted', deviceCapturedAt: '2026-09-22T14:55:00.000Z' });
  assert.equal(wire.sent('session').length, 1, 'clock-in re-checks the signed-in account');
  assert.equal(wire.overlap, false);
});

test('time-clock replays are idempotent against the saved shift and refuse a changed account or shift', async () => {
  const { box } = outbox(), onBreak = { id: 'time-crew.one-1', onBreak: true, breaks: [{ startAt: '2026-09-22T14:40:00.000Z', endAt: '' }] };
  const start = clock('Crew.One', 'break_start'); await box.enqueue(start);
  let wire = transport({ shift: () => ({ ok: true, user: 'Crew.One', entry: onBreak }) });
  assert.equal((await box.flush({ user: 'Crew.One', transport: wire })).applied[0].data.alreadyApplied, true);
  assert.equal(wire.sent('employee').length, 0, 'an already-open break is not sent again');
  for (const op of ['break_end', 'clock_out']) {
    await box.enqueue(clock('Crew.One', op)); wire = transport({ shift: () => ({ ok: true, user: 'Crew.One', entry: null }) });
    assert.equal((await box.flush({ user: 'Crew.One', transport: wire })).applied[0].data.alreadyApplied, true, `${op} is already satisfied once the shift closed`);
    assert.equal(wire.sent('employee').length, 0);
  }
  await box.enqueue(clock('Crew.One', 'break_start'));
  const changed = await box.flush({ user: 'Crew.One', transport: transport({ shift: () => ({ ok: true, user: 'Crew.One', entry: { ...onBreak, id: 'another-shift', onBreak: false } }) }) });
  assert.equal(changed.stopped.error.code, 'OUTBOX_SHIFT_CHANGED'); assert.equal(changed.stopped.reason, 'rejected');
  const other = outbox().box; await other.enqueue(clock('Crew.One', 'clock_in', { lastLocation: { lat: 40, lng: -105, accuracy: 1 } }));
  const swapped = transport({ session: () => ({ ok: true, user: 'Crew.Two' }) });
  const refused = await other.flush({ user: 'Crew.One', transport: swapped });
  assert.equal(refused.stopped.error.code, 'FIELD_ACCOUNT_CHANGED'); assert.equal(swapped.sent('employee').length, 0, 'a clock-in never lands on another signed-in account');
});

test('break replays are matched by request ID, so a break changed elsewhere after a lost reply is not repeated', async () => {
  const { box } = outbox(), start = clock('Crew.One', 'break_start'), end = clock('Crew.One', 'break_end');
  await box.enqueue(start); await box.enqueue(end);
  // The start was saved (reply lost) and then ended in the Hub; the end was saved and a newer break is open.
  const shift = { id: 'time-crew.one-1', onBreak: true, breaks: [{ startAt: '2026-09-22T14:40:00.000Z', endAt: '2026-09-22T14:45:00.000Z', startRequestId: start.requestId, endRequestId: end.requestId }, { startAt: '2026-09-22T14:55:00.000Z', endAt: '' }] };
  const wire = transport({ shift: () => ({ ok: true, user: 'Crew.One', entry: shift }) });
  const result = await box.flush({ user: 'Crew.One', transport: wire });
  assert.deepEqual(plain(result.applied.map(row => row.data)), [{ ok: true, alreadyApplied: true }, { ok: true, alreadyApplied: true }]);
  assert.equal(wire.sent('employee').length, 0, 'neither a second break nor the end of the newer break is sent');
  assert.equal(result.remaining, 0);
});

test('a server error that repeats five times waits for review instead of holding every lane', async () => {
  const { box } = outbox(), stuck = field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true }), behind = field('Crew.One', 'job-a', 'note', { body: 'Waits behind the stuck check', issue: false, visibility: 'crew' }), other = field('Crew.One', 'job-b', 'checklist', { itemId: 'two', completed: true }), time = clock('Crew.One', 'job_time');
  for (const item of [stuck, behind, other, time]) await box.enqueue(item);
  const broken = () => transport({ field: input => input.requestId === stuck.requestId ? fail('Job storage is unavailable. Retry shortly.', 503, 'FIELD_STORAGE_UNAVAILABLE') : undefined });
  for (let attempt = 1; attempt < 5; attempt++) {
    const wire = broken(), result = await box.flush({ user: 'Crew.One', transport: wire });
    assert.equal(result.stopped.reason, 'transient'); assert.equal(wire.sent('field').length, 1, 'a transient failure still stops the replay');
    const [row] = plain(await box.items('Crew.One'));
    assert.equal(row.state, 'queued'); assert.equal(row.serverFailures, attempt); assert.equal(row.lastError.code, 'FIELD_STORAGE_UNAVAILABLE');
  }
  const fifth = await box.flush({ user: 'Crew.One', transport: broken() });
  assert.equal(fifth.stopped.reason, 'rejected'); assert.equal(fifth.stopped.item.state, 'error');
  const [row] = plain(await box.items('Crew.One'));
  assert.equal(row.state, 'error'); assert.equal(row.serverFailures, 5); assert.equal(row.error.code, 'FIELD_STORAGE_UNAVAILABLE'); assert.equal(row.error.status, 503);
  assert.match(row.error.message, /^The server could not confirm this after 5 tries\. Job storage is unavailable\./);
  const next = broken(), after = await box.flush({ user: 'Crew.One', transport: next });
  assert.deepEqual(next.sent('field').map(input => input.requestId), [other.requestId], 'other jobs sync; the stuck job’s later actions wait for Retry or Discard');
  assert.equal(next.sent('employee').length, 1, 'a queued clock action is no longer held behind it');
  assert.deepEqual(plain((await box.items('Crew.One')).map(item => item.requestId)), [stuck.requestId, behind.requestId]); assert.equal(after.remaining, 2);
  await box.remove(stuck.requestId); await box.remove(behind.requestId);
  const lost = field('Crew.One', 'job-a', 'note', { body: 'No signal', issue: false, visibility: 'crew' }); await box.enqueue(lost);
  for (let attempt = 0; attempt < 8; attempt++) assert.equal((await box.flush({ user: 'Crew.One', transport: transport({ field: () => fail('No connection', 0, 'OUTBOX_NETWORK') }) })).stopped.reason, 'network');
  const [waiting] = plain(await box.items('Crew.One'));
  assert.equal(waiting.state, 'queued', 'lost connections never exhaust an action'); assert.equal(waiting.serverFailures, 0); assert.equal(waiting.attempts, 8);
  await box.flush({ user: 'Crew.One', transport: transport({ field: () => fail('Sign in', 401, 'FIELD_AUTH_REQUIRED') }) });
  assert.equal(plain(await box.items('Crew.One'))[0].serverFailures, 0, 'a sign-in prompt is not a server failure');
});

test('a removal that could not reach IndexedDB is retried, so a confirmed action never replays after reload', async () => {
  const indexedDB = fakeIndexedDB(), first = outbox({ indexedDB }), item = field('Crew.One', 'job-a', 'note', { body: 'Confirmed once', issue: false, visibility: 'crew' });
  await first.box.enqueue(item);
  // The device refuses the next IndexedDB open, which is the removal after the server confirmed the note.
  const wire = transport({ field: () => { indexedDB.failNextOpen(); } });
  const result = await first.box.flush({ user: 'Crew.One', transport: wire });
  assert.equal(result.applied.length, 1); assert.equal(first.box.persistent, false, 'the page falls back to memory');
  assert.deepEqual(indexedDB.rows('egc-field-outbox', 'actions'), [], 'the device copy is removed once IndexedDB answers again');
  const reloaded = outbox({ indexedDB }), replay = transport();
  assert.equal((await reloaded.box.flush({ user: 'Crew.One', transport: replay })).applied.length, 0);
  assert.equal(replay.sent('field').length, 0);
});

test('queued work is overlaid on the last confirmed job and shift without showing refused actions as done', async () => {
  const { api } = load();
  const job = { id: 'job-a', status: 'scheduled', fieldStatus: 'scheduled', allowedStatuses: ['dispatched'], checklist: [{ id: 'one', completed: false }, { id: 'two', completed: true }], materials: [{ id: 'rack', state: 'required' }] };
  const row = (payload, state = 'queued') => ({ kind: 'field', jobId: 'job-a', state, payload });
  const view = plain(api.projectJob(job, [row({ action: 'checklist', itemId: 'one', completed: true }), row({ action: 'checklist', itemId: 'two', completed: false }), row({ action: 'material', materialId: 'rack', state: 'loaded' }), row({ action: 'status', status: 'dispatched' }), row({ action: 'status', status: 'arrived' }), row({ action: 'status', status: 'in_progress' }, 'error'), { kind: 'field', jobId: 'job-b', state: 'queued', payload: { action: 'checklist', itemId: 'one', completed: false } }]));
  assert.deepEqual(view.checklist, [{ id: 'one', completed: true, queued: true }, { id: 'two', completed: false, queued: true }]);
  assert.deepEqual(view.materials, [{ id: 'rack', state: 'loaded', queued: true }]);
  assert.equal(view.status, 'arrived'); assert.equal(view.fieldStatus, 'arrived'); assert.deepEqual(view.allowedStatuses, ['in_progress', 'waiting']); assert.equal(view.statusQueued, true);
  assert.equal(job.checklist[0].completed, false, 'the confirmed job is not mutated');
  const paused = plain(api.projectJob({ ...job, status: 'in_progress', fieldStatus: 'in_progress', allowedStatuses: ['paused', 'waiting', 'delayed', 'in_progress'] }, [row({ action: 'status', status: 'paused', reason: 'Customer call' })]));
  assert.equal(paused.status, 'in_progress'); assert.equal(paused.fieldStatus, 'paused');
  const items = [clock('Crew.One', 'clock_in'), clock('Crew.One', 'job_time', { jobAction: { kind: 'travel' } }), clock('Crew.One', 'break_start')];
  const shift = plain(api.projectShift(null, items.map(item => ({ ...item, state: 'queued' }))));
  assert.equal(shift.id, 'time-crew.one-1'); assert.equal(shift.onBreak, true); assert.equal(shift.current.kind, 'travel'); assert.equal(shift.currentSegmentId, items[1].requestId);
  assert.equal(api.projectShift(shift, [{ ...clock('Crew.One', 'clock_out'), state: 'queued' }]), null);
  assert.equal(api.projectShift(null, [{ ...clock('Crew.One', 'clock_in'), state: 'error' }]), null, 'a refused clock-in does not show as clocked in');
});

test('the outbox persists in IndexedDB egc-field-outbox across page loads and falls back to page memory', async () => {
  const indexedDB = fakeIndexedDB(), first = outbox({ indexedDB }), item = field('Crew.One', 'job-a', 'note', { body: 'Survives reload', issue: false, visibility: 'crew' });
  await first.box.enqueue(item);
  assert.equal(first.box.persistent, true);
  const [stored] = indexedDB.rows('egc-field-outbox', 'actions');
  assert.equal(stored.requestId, item.requestId); assert.equal(stored.user, 'Crew.One'); assert.equal(stored.jobId, 'job-a'); assert.equal(stored.queuedAt, NOW); assert.deepEqual(stored.payload, item.payload);
  const reloaded = outbox({ indexedDB });
  assert.deepEqual(plain((await reloaded.box.items('Crew.One')).map(row => row.requestId)), [item.requestId]);
  assert.equal(indexedDB.stats.closes, indexedDB.stats.opens, 'every device-store connection is closed after its transaction');
  const refused = fakeIndexedDB(); refused.failNextOpen();
  const fallback = outbox({ indexedDB: refused });
  await fallback.box.enqueue(field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true }));
  assert.equal(fallback.box.persistent, false); assert.equal((await fallback.box.items('Crew.One')).length, 1);
  const none = outbox({ indexedDB: null });
  await none.box.enqueue(field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true }));
  assert.equal(none.box.persistent, false);
});

test('enqueue validates identity and IDs, and a repeated request ID is never queued twice', async () => {
  const { box } = outbox(), item = field('Crew.One', 'job-a', 'note', { body: 'Once', issue: false, visibility: 'crew' });
  assert.equal((await box.enqueue(item)).direct, true);
  const again = await box.enqueue({ ...item, payload: { ...item.payload, body: 'Changed' } });
  assert.equal(again.direct, false); assert.equal(again.item.payload.body, 'Once');
  for (const bad of [{ ...item, requestId: 'not-a-uuid' }, { ...item, user: '' }, { ...item, kind: 'photo' }, { ...field('Crew.One', 'job-a', 'note'), jobId: 'job-b' }, { ...item, requestId: id() }, (() => { const other = field('Crew.One', 'job-a', 'note'); other.payload.expectedUser = 'Crew.Two'; return other; })(), { ...clock('Crew.One', 'clock_in'), payload: { op: 'delete_shift', entryId: 'x' } }]) {
    await assert.rejects(box.enqueue(bad), error => error.code === 'OUTBOX_INVALID');
  }
  assert.equal((await box.items('Crew.One')).length, 1);
});

test('flushes are serialized through Web Locks shared with the service worker', async () => {
  const names = []; let holders = 0, overlap = false;
  const locks = { request: async (name, task) => { names.push(name); holders++; if (holders > 1) overlap = true; try { return await task(); } finally { holders--; } } };
  const { box } = outbox({ locks });
  await box.enqueue(field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true }));
  const wire = transport();
  const [first, second] = await Promise.all([box.flush({ user: 'Crew.One', transport: wire }), box.flush({ user: 'Crew.One', transport: wire })]);
  assert.equal(first.applied.length + second.applied.length, 1, 'concurrent triggers never send the same action twice');
  assert.deepEqual(names, ['egc-field-outbox', 'egc-field-outbox']); assert.equal(overlap, false);
});

test('the HTTP transport separates lost connections and cut-off replies from server refusals', async () => {
  const replies = [];
  const fetch = async (url, init) => { replies.push([url, init]); const next = fetch.queue.shift(); if (next instanceof Error) throw next; return next; };
  fetch.queue = [];
  const { api } = load({ fetch });
  const wire = api.httpTransport();
  fetch.queue.push(new TypeError('Failed to fetch'));
  await assert.rejects(wire.field({ jobId: 'job-a' }), error => error.status === 0 && error.code === 'OUTBOX_NETWORK');
  fetch.queue.push(new Response('{"ok":', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(wire.employee({ collection: 'timeEntries' }), error => error.status === 0 && api.classify(error) === 'network');
  fetch.queue.push(Response.json({ ok: false, code: 'FIELD_START_INCOMPLETE', error: 'Complete arrival preparation.', missing: ['Upload a before photo.'] }, { status: 409 }));
  await assert.rejects(wire.field({ jobId: 'job-a' }), error => error.status === 409 && error.code === 'FIELD_START_INCOMPLETE' && error.missing[0] === 'Upload a before photo.' && api.classify(error) === 'rejected');
  fetch.queue.push(new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(wire.shift(), error => api.classify(error) === 'transient');
  fetch.queue.push(Response.json({ ok: true, jobTime: {}, expectedRevision: 'rev-9' }));
  assert.equal(await wire.revision('job a/1'), 'rev-9');
  fetch.queue.push(Response.json({ ok: true, jobTime: {} }));
  await assert.rejects(wire.revision('job-a'), error => error.status === 503);
  assert.deepEqual(replies.map(([url]) => url), ['/api/field-jobs', '/api/employee-hub', '/api/field-jobs', '/api/employee-hub?view=own-job-time', '/api/field-jobs?jobId=job%20a%2F1&view=timer', '/api/field-jobs?jobId=job-a&view=timer']);
  assert.equal(replies[0][1].method, 'POST'); assert.equal(replies[0][1].credentials, 'same-origin'); assert.equal(replies[0][1].cache, 'no-store'); assert.equal(replies[0][1].headers['Content-Type'], 'application/json');
});

test('Background Sync replays only the account signed in now and reports a missing session as auth', async () => {
  const { box, api } = outbox(), mine = field('Crew.One', 'job-a', 'checklist', { itemId: 'one', completed: true });
  await box.enqueue(mine); await box.enqueue(field('Crew.Two', 'job-a', 'checklist', { itemId: 'two', completed: true }));
  const wire = transport();
  const result = await api.replaySignedIn(box, wire);
  assert.deepEqual(wire.sent('field').map(input => input.requestId), [mine.requestId]);
  assert.equal(result.applied.length, 1);
  const signedOut = await api.replaySignedIn(box, transport({ session: () => fail('Sign in required', 401) }));
  assert.equal(signedOut.stopped.reason, 'auth');
  assert.equal((await box.items('Crew.Two')).length, 1);
});
