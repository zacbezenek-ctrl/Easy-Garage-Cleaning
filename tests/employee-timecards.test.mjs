import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTimecard, timecardHours, timecardWorkDate } from '../functions/_lib/employee-timecards.js';
import { createHubCredentialHash, createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { onRequestGet, onRequestPost } from '../functions/api/employee-hub.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { activeJobSegment } from '../functions/_lib/employee-job-time.js';

const crew = { user: 'Crew.One', displayName: 'Crew One', role: 'crew', payType: 'hourly' };
const manager = { user: 'ZacB', displayName: 'Manager', role: 'owner' };
const start = '2026-09-22T14:00:00.000Z';
const point = { lat: 40.58, lng: -105.08, accuracy: 5 };
const create = (incoming = {}) => authorizeTimecard({ session: crew, manager: false, id: 'shift', incoming: { locationTracking: true, lastLocation: point, ...incoming }, hourlyRate: 25, now: start });
const update = (existing, incoming, now = '2026-09-22T18:00:00.000Z') => authorizeTimecard({ session: crew, manager: false, id: existing.id, existing, incoming, now });
const administer = (existing, incoming) => authorizeTimecard({ session: manager, manager: true, id: existing.id, existing, incoming, now: '2026-09-22T19:00:00.000Z' });

test('crew clock-in ignores forged employee, pay, approval, timestamps, break history and totals', () => {
  const entry = create({ employee: 'ZacB', hourlyRate: 999, clockInAt: '2020-01-01T00:00:00Z', clockOutAt: start,
    approvalStatus: 'approved', approvedBy: 'ZacB', breaks: [{ startAt: start }], bonus: 500, tips: 100, hours: 99, history: [{ actor: 'Owner' }] });
  assert.equal(entry.employee, crew.user); assert.equal(entry.hourlyRate, 25); assert.equal(entry.clockInAt, start);
  assert.equal(entry.clockOutAt, ''); assert.equal(entry.approvalStatus, 'open'); assert.equal(entry.approvedBy, '');
  assert.deepEqual(entry.breaks, []); assert.equal(entry.bonus, undefined); assert.equal(entry.hours, undefined);
  assert.equal(entry.history.length, 1); assert.equal(entry.history[0].actor, crew.user); assert.equal(entry.workDate, '2026-09-22');
});

test('invalid, out-of-range and coerced locations cannot clock in', () => {
  for (const lastLocation of [null, {}, { lat: '40', lng: -105 }, { lat: 100, lng: -105 }, { lat: 40, lng: -190 }, { lat: NaN, lng: 0 }]) {
    assert.throws(() => create({ lastLocation }), /valid shift location/);
  }
});

test('breaks and clock-out use server instants, automatically end an open break, and compute net hours', () => {
  let entry = update(create(), { breaks: [{ startAt: '2001-01-01T00:00:00Z', endAt: '' }] }, '2026-09-22T16:00:00.000Z');
  assert.equal(entry.breaks[0].startAt, '2026-09-22T16:00:00.000Z');
  entry = update(entry, { breaks: [{ ...entry.breaks[0], endAt: '2030-01-01T00:00:00Z' }] }, '2026-09-22T16:30:00.000Z');
  assert.equal(entry.breaks[0].endAt, '2026-09-22T16:30:00.000Z');
  entry = update(entry, { breaks: [...entry.breaks, { startAt: '2020-01-01T00:00:00Z', endAt: '' }] }, '2026-09-22T17:45:00.000Z');
  const closed = update(entry, { clockOutAt: '2040-01-01T00:00:00Z', status: 'submitted', hours: 999, grossEstimate: 99999 });
  assert.equal(closed.clockOutAt, '2026-09-22T18:00:00.000Z'); assert.equal(closed.breaks.at(-1).endAt, closed.clockOutAt);
  assert.equal(closed.hours, 3.25); assert.equal(closed.grossEstimate, 81.25); assert.equal(closed.approvalStatus, 'pending');
  assert.equal(closed.locationTracking, false); assert.equal(closed.history.at(-1).action, 'clock_out');
  assert.equal(timecardHours(closed), 3.25);
});

test('crew cannot rewrite completed breaks or pay during an active shift', () => {
  const existing = { ...create(), breaks: [{ startAt: '2026-09-22T15:00:00Z', endAt: '2026-09-22T15:30:00Z' }] };
  assert.throws(() => update(existing, { breaks: [] }), /cannot be rewritten/);
  assert.throws(() => update(existing, { breaks: [{ startAt: start, endAt: start }] }), /cannot be rewritten/);
  const next = update(existing, { clockInAt: '2025-01-01T00:00:00Z', hourlyRate: 999, employee: 'ZacB', approvalStatus: 'approved', approvedBy: 'ZacB' });
  assert.equal(next.clockInAt, start); assert.equal(next.employee, crew.user); assert.equal(next.hourlyRate, 25); assert.equal(next.approvalStatus, 'open');
});

test('submitted and approved timecards reject crew edits while exact clock-out retry preserves the record', () => {
  const payload = { clockOutAt: '2026-09-22T18:00:00.000Z', status: 'submitted', hours: 4, approvalStatus: 'pending' };
  const submitted = update(create(), payload);
  for (const existing of [submitted, administer(submitted, { approvalStatus: 'approved', approvedBy: 'spoof' }), { ...submitted, approvalStatus: 'rejected' }]) {
    for (const incoming of [{ clockInAt: start }, { clockOutAt: '2027-01-01T00:00:00Z' }, { breaks: [] }, { hourlyRate: 100 }, { status: 'active' }, { jobId: 'another-job' }]) {
      assert.throws(() => update(existing, incoming), /Only a manager/);
    }
    assert.strictEqual(update(existing, payload), existing);
  }
  assert.throws(() => update({ ...create(), employee: 'Crew.Two' }, {}), /another employee/);
});

test('manager corrections clear prior approval, preserve attribution, recompute totals and permit explicit reviewed approval', () => {
  const approved = administer(update(create(), { clockOutAt: 'browser-time', status: 'submitted' }), { approvalStatus: 'approved', approvedBy: 'forged', history: [] });
  assert.equal(approved.approvedBy, manager.user); assert.equal(approved.history.length, 3);
  const corrected = administer(approved, { clockOutAt: '2026-09-22T17:00:00Z', hours: 500, history: [] });
  assert.equal(corrected.approvalStatus, 'pending'); assert.equal(corrected.approvedBy, ''); assert.equal(corrected.hours, 3);
  assert.equal(corrected.history.length, 4); assert.equal(corrected.history.at(-1).actor, manager.user);
  const reviewed = administer(approved, { clockOutAt: '2026-09-22T17:00:00Z', approvalStatus: 'approved' });
  assert.equal(reviewed.approvalStatus, 'approved'); assert.equal(reviewed.hours, 3);
  assert.throws(() => administer(create(), { approvalStatus: 'approved' }), /Only completed/);
  assert.throws(() => administer(approved, { clockOutAt: '2026-09-22T13:00:00Z' }), /invalid shift/);
});

test('Denver work dates and elapsed hours survive midnight, DST transitions and foreign browser zones', () => {
  assert.equal(timecardWorkDate('2026-09-28T05:30:00Z'), '2026-09-27');
  assert.equal(timecardWorkDate('2026-09-28T06:00:00Z'), '2026-09-28');
  assert.equal(timecardWorkDate('2026-03-08T06:59:00Z'), '2026-03-07');
  assert.equal(timecardWorkDate('invalid'), '');
  assert.equal(timecardWorkDate('2026-02-30T18:00:00Z'), '');
  assert.equal(timecardWorkDate('2026-09-22T24:00:00Z'), '');
  assert.equal(timecardHours({ clockInAt: '2026-03-08T01:30:00-07:00', clockOutAt: '2026-03-08T03:30:00-06:00', breaks: [] }), 1);
  assert.equal(timecardHours({ clockInAt: '2026-11-01T00:30:00-06:00', clockOutAt: '2026-11-01T02:30:00-07:00', breaks: [] }), 3);
});

const hash = await createHubCredentialHash('Synthetic timecard test password 904!');
const env = { HUB_SESSION_SECRET: 'timecard-tests-session', EMPLOYEE_HUB_DATA_SECRET: 'timecard-tests-vault', FIREBASE_API_KEY: 'firebase-test-timecards',
  HUB_AUTH_USERS_JSON: JSON.stringify({ 'Crew.One': { passwordHash: hash, displayName: crew.displayName, role: 'crew', hourlyRate: 25 }, ZacB: { passwordHash: hash, displayName: 'Manager', role: 'owner' } }) };
const cookies = Object.fromEntries(await Promise.all(['Crew.One', 'ZacB'].map(async user => [user, (await createHubSessionCookie(env, user)).split(';')[0]])));
const endpoint = 'https://easygaragecleaning.com/api/employee-hub';
const post = (id, data, user = 'Crew.One') => onRequestPost({ env, request: new Request(endpoint, { method: 'POST', headers: { Cookie: cookies[user], Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ collection: 'timeEntries', id, data }) }) });
const get = (user = 'Crew.One') => onRequestGet({ env, request: new Request(endpoint, { headers: { Cookie: cookies[user] } }) });
const clockIn = extra => ({ locationTracking: true, lastLocation: point, status: 'active', ...extra });

function storage(t) {
  const documents = new Map(), writes = []; let revision = 0, lostReply = false, barrierCount = 0, barrierResolve, commitHook;
  let barrier;
  const nameOf = (collection, id) => `projects/egcw-1ec83/databases/(default)/documents/${collection}/${id}`;
  const nextVersion = () => `2026-09-22T01:00:00.${String(++revision).padStart(9, '0')}Z`;
  const matches = (current, condition) => condition?.exists === false ? !current : !condition?.updateTime || current?.updateTime === condition.updateTime;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), body = options.body ? JSON.parse(options.body) : null;
    if (url.pathname.endsWith('/documents:runQuery')) return Response.json([...documents.values()].filter(doc => doc.name.includes('/documents/jobs/') && doc.fields.recordType?.stringValue === body.structuredQuery.where.fieldFilter.value.stringValue).map(document => ({ document })));
    if (url.pathname.endsWith('/documents:commit')) {
      if (commitHook) { const hook = commitHook; commitHook = null; hook(); }
      if (barrierCount) { barrierCount--; if (!barrierCount) barrierResolve(); await barrier; }
      if (body.writes.some(write => !matches(documents.get(write.update.name), write.currentDocument))) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
      const updateTime = nextVersion();
      for (const write of body.writes) { const existing = documents.get(write.update.name); documents.set(write.update.name, { ...write.update, ...(write.updateMask ? { fields: { ...(existing?.fields || {}), ...write.update.fields } } : {}), updateTime }); writes.push(write); }
      if (lostReply) { lostReply = false; throw new Error('Synthetic connection lost after atomic commit'); }
      return Response.json({ writeResults: body.writes.map(() => ({ updateTime })) });
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/v1\//, ''));
    if (options.method === 'PATCH') {
      const condition = url.searchParams.get('currentDocument.exists') === 'false' ? { exists: false } : { updateTime: url.searchParams.get('currentDocument.updateTime') || undefined };
      if (!matches(documents.get(name), condition)) return Response.json({}, { status: 412 });
      const document = { name, ...body, updateTime: nextVersion() }; documents.set(name, document); writes.push(document);
    }
    return documents.has(name) ? Response.json(documents.get(name)) : Response.json({}, { status: 404 });
  });
  return { documents, writes, loseCommitReply: () => { lostReply = true; }, beforeCommit: fn => { commitHook = fn; }, barrier: count => { barrierCount = count; barrier = new Promise(resolve => { barrierResolve = resolve; }); },
    job: (id, data) => documents.set(nameOf('jobs', id), { name: nameOf('jobs', id), fields: encodeFirestoreFields(data), updateTime: nextVersion() }) };
}

test('concurrent different clock-in IDs atomically produce one active shift and a private encrypted lock', async t => {
  const store = storage(t); store.barrier(2);
  const responses = await Promise.all([post('first-clock', clockIn()), post('second-clock', clockIn())]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const visible = await (await get()).json(); assert.equal(visible.collections.timeEntries.length, 1);
  assert.equal(visible.collections.timeEntries[0].status, 'active'); assert.equal(visible.collections.timeLocks, undefined);
  const lock = [...store.documents].find(([name]) => name.includes('/employee_time_locks/'));
  assert.ok(lock); assert.equal(JSON.stringify(lock).includes('Crew.One'), false); assert.ok(lock[1].fields.sealedPayload);
});

test('clock-out releases its guard and a lost successful reply can be retried without reopening or duplication', async t => {
  const store = storage(t);
  const first = await post('clock', clockIn()); assert.equal(first.status, 200); const started = (await first.json()).record;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(started.clockInAt) + 3600000 });
  store.loseCommitReply(); const input = { clockOutAt: new Date().toISOString(), status: 'submitted', hours: 999 };
  assert.equal((await post('clock', input)).status, 502);
  const retried = await post('clock', input); assert.equal(retried.status, 200); const closed = (await retried.json()).record;
  assert.equal(closed.hours, 1); assert.equal(closed.status, 'submitted'); assert.equal(closed.history.filter(e => e.action === 'clock_out').length, 1);
  assert.equal((await post('next-clock', clockIn())).status, 200);
  const rows = (await (await get()).json()).collections.timeEntries; assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.status === 'active').length, 1);
});

test('lost clock-in response preserves the original capture when retried with the same ID', async t => {
  const store = storage(t); store.loseCommitReply();
  const request = clockIn({ clockInAt: '2020-01-01T00:00:00Z', breaks: [] });
  assert.equal((await post('clock', request)).status, 502);
  const existing = (await (await get()).json()).collections.timeEntries[0];
  const retry = await post('clock', request); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).record.clockInAt, existing.clockInAt);
  assert.equal((await (await get()).json()).collections.timeEntries.length, 1);
});

test('existing active legacy cards block a new shift before the guard was introduced', async t => {
  storage(t);
  assert.equal((await post('legacy-active', { employee: crew.user, status: 'active', clockInAt: new Date().toISOString() }, 'ZacB')).status, 200);
  assert.equal((await post('new-clock', clockIn())).status, 409);
});

test('job labor association is checked on the server and unknown, unassigned jobs cannot create time', async t => {
  const store = storage(t);
  store.job('assigned', { type: 'job', assignedCrew: [{ username: crew.user }], customer: 'Assigned customer' });
  store.job('other', { type: 'job', assignedCrew: [{ username: 'Other' }], customer: 'Private customer' });
  assert.equal((await post('unknown', clockIn({ jobId: 'unknown' }))).status, 403);
  assert.equal((await post('unassigned', clockIn({ jobId: 'other' }))).status, 403);
  const response = await post('valid', clockIn({ jobId: 'assigned', jobLabel: 'Forged label' })); assert.equal(response.status, 200);
  assert.equal((await response.json()).record.jobLabel, 'Assigned customer');
});

test('approved crew edits fail without a storage write and manager correction atomically revokes approval', async t => {
  const store = storage(t), base = new Date(Date.now() - 7200000).toISOString(), end = new Date(Date.now() - 3600000).toISOString();
  assert.equal((await post('approved', { employee: crew.user, employeeName: crew.displayName, hourlyRate: 25, clockInAt: base, clockOutAt: end, status: 'submitted', approvalStatus: 'approved', breaks: [] }, 'ZacB')).status, 200);
  const before = store.writes.length;
  assert.equal((await post('approved', { clockInAt: new Date(Date.now() - 14400000).toISOString() })).status, 403);
  assert.equal(store.writes.length, before);
  const corrected = await post('approved', { clockOutAt: new Date().toISOString() }, 'ZacB'); assert.equal(corrected.status, 200);
  const card = (await corrected.json()).record; assert.equal(card.approvalStatus, 'pending'); assert.equal(card.hours, 2); assert.equal(card.history.at(-1).actor, 'ZacB');
});

const view = (query, user = 'Crew.One') => onRequestGet({ env, request: new Request(`${endpoint}?${query}`, { headers: { Cookie: cookies[user] } }) });
test('employee job switches are assigned, server-timestamped, break-aware and safely retry after a lost response', async t => {
  const store = storage(t); store.job('job-a', { type: 'job', status: 'scheduled', assignedCrew: [crew.user], customer: 'Real job A', total: 900 }); store.job('job-b', { type: 'job', status: 'scheduled', assignedCrew: [crew.user], customer: 'Real job B' });
  const first = (await (await post('job-clock', clockIn())).json()).record;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(first.clockInAt) + 30 * 60000 });
  const request = { jobAction: { requestId: crypto.randomUUID(), expectedSegmentId: activeJobSegment(first).id, jobId: 'job-a', kind: 'work', startedAt: '2000-01-01T00:00:00Z', jobLabel: 'Spoofed' } };
  store.loseCommitReply(); assert.equal((await post('job-clock', request)).status, 502);
  t.mock.timers.tick(10 * 60000);
  const retried = (await (await post('job-clock', request)).json()).record;
  assert.equal(retried.jobTracking.segments.length, 2);
  assert.equal(activeJobSegment(retried).startedAt, new Date(Date.parse(first.clockInAt) + 30 * 60000).toISOString());
  assert.equal(activeJobSegment(retried).jobLabel, 'Real job A');
  assert.equal(store.documents.get('projects/egcw-1ec83/databases/(default)/documents/jobs/job-a').fields.total.integerValue, '900', 'assignment fence preserves the canonical job');
  await post('job-clock', { breaks: [{ startAt: 'client-time' }] });
  t.mock.timers.tick(20 * 60000);
  const switchJob = { jobAction: { requestId: crypto.randomUUID(), expectedSegmentId: activeJobSegment(retried).id, jobId: 'job-b', kind: 'travel' } };
  assert.equal((await post('job-clock', switchJob)).status, 200);
  const current = (await (await get()).json()).collections.timeEntries[0];
  assert.equal((await post('job-clock', { breaks: [{ ...current.breaks[0], endAt: 'client-time' }] })).status, 200);
  t.mock.timers.tick(15 * 60000);
  const own = await (await view('view=own-job-time')).json();
  assert.equal(own.entry.current.jobId, 'job-b'); assert.equal(own.entry.summary.jobs[0].workMs, 10 * 60000); assert.equal(own.entry.summary.jobs[1].travelMs, 15 * 60000);
  assert.equal(JSON.stringify(own).includes('hourlyRate'), false);
  const labor = await (await view('view=job-labor&jobId=job-a', 'ZacB')).json();
  assert.equal(labor.employees[0].workMs, 10 * 60000); assert.equal(labor.employees[0].pendingWorkMs, 10 * 60000);
  assert.equal((await view('view=job-labor&jobId=job-a')).status, 403);
  assert.equal((await post('job-clock', { clockOutAt: 'client-time', status: 'submitted' })).status, 200);
  assert.equal((await (await view('view=own-job-time')).json()).entry, null);
  assert.equal((await post('job-clock', request)).status, 200, 'same request stays a safe replay after clock-out');
  assert.equal((await post('job-clock', { approvalStatus: 'approved' }, 'ZacB')).status, 200);
  const approved = await (await view('view=job-labor&jobId=job-a', 'ZacB')).json();
  assert.equal(approved.employees[0].approvedWorkMs, 10 * 60000); assert.equal(approved.employees[0].pendingWorkMs, 0);
  assert.equal((await post('job-clock', { approvalStatus: 'rejected' }, 'ZacB')).status, 200);
  const rejected = await (await view('view=job-labor&jobId=job-a', 'ZacB')).json();
  assert.equal(rejected.employees[0].rejectedWorkMs, 10 * 60000); assert.equal(rejected.employees[0].pendingWorkMs, 0);
  const older = { employee: crew.user, employeeName: crew.displayName, jobId: 'job-a', status: 'submitted', clockInAt: new Date(Date.now() - 7200000).toISOString(), clockOutAt: new Date(Date.now() - 3600000).toISOString(), breaks: [], hourlyRate: 25, approvalStatus: 'approved' };
  assert.equal((await post('historical-association', older, 'ZacB')).status, 200);
  const withLegacy = await (await view('view=job-labor&jobId=job-a', 'ZacB')).json();
  assert.equal(withLegacy.legacyAssociationOnlyCount, 1);
  assert.equal(withLegacy.employees[0].workMs, 10 * 60000, 'legacy whole-shift associations must not inflate recorded job labor');
  assert.equal(JSON.stringify(withLegacy).includes('hourlyRate'), false);
});

test('job segments deny unknown/unassigned/closed work and fence a concurrent crew reassignment', async t => {
  const store = storage(t), first = (await (await post('guard-clock', clockIn())).json()).record;
  store.job('other', { type: 'job', status: 'scheduled', assignedCrew: ['Other'] });
  store.job('closed', { type: 'job', status: 'completed', assignedCrew: [crew.user] });
  store.job('race', { type: 'job', status: 'scheduled', assignedCrew: [crew.user] });
  const command = jobId => ({ jobAction: { requestId: crypto.randomUUID(), expectedSegmentId: activeJobSegment(first).id, jobId, kind: 'work' } });
  for (const id of ['unknown', 'other', 'closed']) assert.equal((await post('guard-clock', command(id))).status, 403);
  store.beforeCommit(() => store.job('race', { type: 'job', status: 'scheduled', assignedCrew: ['Other'] }));
  assert.equal((await post('guard-clock', command('race'))).status, 409);
  const own = await (await view('view=own-job-time')).json();
  assert.equal(own.entry.current.kind, 'general');
  assert.equal(own.entry.summary.jobs.length, 0);
});
