import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { crewNotificationHandlers } from '../functions/api/crew-notifications.js';
import { CREW_NOTIFICATIONS, CREW_NOTIFICATION_PREFS, crewNotificationWrites } from '../functions/_lib/crew-notifications.js';
import { FEED_LIMIT } from '../functions/_lib/crew-notification-delivery.js';
import { memoryStore } from './helpers/messaging-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z', DAY = '2026-09-24', ORIGIN = 'https://easygaragecleaning.com', URL_PATH = `${ORIGIN}/api/crew-notifications`;
const ENV = Object.freeze({ EGC_CREW_NOTIFICATIONS_ENABLED: 'true' });
const ROSTER = [{ id: 'crew1', name: 'Casey Crew', role: 'crew' }, { id: 'crew2', name: 'Riley Other', role: 'crew' }];
const SESSIONS = { crew1: { user: 'Crew1', role: 'crew', businessAccess: false, displayName: 'Casey Crew' }, crew2: { user: 'crew2', role: 'crew', businessAccess: false }, manager: { user: 'zacb', role: 'owner', businessAccess: true } };
const ACCOUNTS = { crew1: { username: 'crew1', status: 'approved', phone: '(970) 555-0155' }, crew2: { username: 'crew2', status: 'approved', phone: '' } };
const work = (overrides = {}) => ({ type: 'job', date: DAY, endDate: DAY, time: '09:00', endTime: '12:00', status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['crew1'],
  customer: 'Synthetic Canary Customer', phone: '(970) 555-0199', address: '999 Canary Lane', total: 8765.43, serviceType: 'Garage cleanout', ...overrides });

async function setup({ env = ENV, lyingQuery = false } = {}) {
  const store = memoryStore(), queries = [], batches = [];
  let who = 'crew1', clockNow = NOW;
  const all = collection => Promise.all([...store.rows.keys()].filter(key => key.startsWith(`${collection}/`)).map(key => store.read(collection, key.slice(collection.length + 1))));
  store.query = async (filters, limit = 200, collection = CREW_NOTIFICATIONS) => {
    queries.push({ filters, limit, collection });
    const rows = await all(collection);
    return (lyingQuery ? rows : rows.filter(row => filters.every(([field, value]) => row[field] === value))).slice(0, limit);
  };
  store.attention = async (today, limit) => { queries.push({ attention: today, limit }); return (await all(CREW_NOTIFICATIONS)).filter(row => typeof row.attentionUntil === 'string' && row.attentionUntil >= today).sort((a, b) => a.attentionUntil.localeCompare(b.attentionUntil)).slice(0, limit); };
  const read = store.read;
  store.readMany = async (collection, ids) => { batches.push({ collection, ids }); return (await Promise.all(ids.map(id => read(collection, id)))).filter(Boolean); };
  store.roster = async () => [...ROSTER, { id: 'zacb', name: 'Zac Owner', role: 'owner' }];
  const queue = async (before, after, { jobId = 'job-1', at = clockNow } = {}) => {
    const writes = await crewNotificationWrites({ jobId, requestId: randomUUID(), action: 'schedule.update', actorId: 'zacb', type: 'job', before, after, roster: ROSTER, now: at });
    await store.commit(writes);
    return writes.map(write => write.id);
  };
  const handlers = crewNotificationHandlers({ session: async () => SESSIONS[who] || null, storage: () => store, now: () => new Date(clockNow),
    readAccount: () => async username => { if (username === 'broken') throw new Error('vault offline'); return ACCOUNTS[username] ? { account: ACCOUNTS[username] } : null; } });
  const call = async (method, body, headers = {}, query = '') => {
    const init = { method, headers: { Origin: ORIGIN, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers } };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const response = await (method === 'GET' ? handlers.get : handlers.post)({ request: new Request(URL_PATH + query, init), env });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const mark = (id, fields) => store.edit(`${CREW_NOTIFICATIONS}/${id}`, fields);
  return { store, queries, batches, queue, call, mark, as: user => { who = user; }, at: iso => { clockNow = iso; } };
}

test('the feed needs a signed-in employee and the flag', async () => {
  const f = await setup();
  f.as('nobody');
  assert.deepEqual([(await f.call('GET')).status, (await f.call('GET')).body.code], [401, 'crew_notifications_sign_in_required']);
  const off = await setup({ env: {} });
  const result = await off.call('GET');
  assert.deepEqual([result.status, result.body.code], [503, 'crew_notifications_not_enabled']);
  assert.equal(off.queries.length, 0);
  assert.equal((await off.call('POST', { action: 'acknowledge', requestId: randomUUID(), ids: [`crew_${'a'.repeat(40)}`] })).body.code, 'crew_notifications_not_enabled');
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('each employee reads only their own open notices, newest first, with schedule facts only', async () => {
  for (const lyingQuery of [false, true]) {
    const f = await setup({ lyingQuery });
    const [older] = await f.queue(null, work());
    f.at('2026-09-22T18:05:00.000Z');
    const [newer] = await f.queue(work(), work({ time: '13:00', endTime: '15:00' }));
    const [seen] = await f.queue(null, work({ assignedCrew: ['crew1'] }), { jobId: 'job-2' });
    f.store.edit(`${CREW_NOTIFICATIONS}/${seen}`, { acknowledged: true });
    const [others] = await f.queue(null, work({ assignedCrew: ['crew2'] }), { jobId: 'job-3' });
    const { status, body } = await f.call('GET');
    assert.equal(status, 200);
    assert.deepEqual(body.notices.map(row => row.id), [newer, older], lyingQuery ? 'even a query that ignored its filter cannot leak another employee\'s notice' : 'own open notices only');
    assert.ok(!JSON.stringify(body).includes(others));
    assert.deepEqual(Object.keys(body.notices[0]).sort(), ['acknowledged', 'createdAt', 'delivery', 'heardSlots', 'id', 'intent', 'jobId', 'jobType', 'lostSlots', 'previousSlots', 'serviceType', 'slot', 'slots']);
    assert.equal(body.notices[0].heardSlots, null, 'a notice that stood for no older change has no heard baseline of its own');
    assert.deepEqual([body.notices[0].intent, body.notices[0].slot.time, body.notices[0].previousSlots[0].time, body.notices[0].delivery], ['time_changed', '13:00', '09:00', 'queued']);
    assert.deepEqual([body.viewer, body.timeZone, body.coverage], [{ id: 'crew1' }, 'America/Denver', { complete: true, asOf: '2026-09-22T18:05:00.000Z' }]);
    assert.deepEqual(body.preferences, { sms: false, revision: '', updatedAt: '', phone: '(•••) •••-0155', phoneStatus: 'on_file' });
    for (const value of ['Canary', '555-0199', '8765', 'dedupeKey', 'attempts', 'actorId', 'dispatchRequestId']) assert.ok(!JSON.stringify(body).includes(value), `no ${value} in the feed`);
    if (!lyingQuery) assert.deepEqual(f.queries.at(-1), { filters: [['employeeId', 'crew1'], ['acknowledged', false]], limit: FEED_LIMIT + 1, collection: CREW_NOTIFICATIONS });
  }
});

test('a long backlog is reported as incomplete instead of shown as the whole list', async () => {
  const f = await setup();
  for (let index = 0; index < FEED_LIMIT + 1; index += 1) await f.queue(null, work(), { jobId: `job-${index}` });
  const { body } = await f.call('GET');
  assert.equal(body.notices.length, FEED_LIMIT);
  assert.equal(body.coverage.complete, false);
});

test('employees acknowledge only their own notices, and a replay changes nothing', async () => {
  const f = await setup(), [mine] = await f.queue(null, work()), [theirs] = await f.queue(null, work({ assignedCrew: ['crew2'] }), { jobId: 'job-2' });
  const request = { action: 'acknowledge', requestId: randomUUID(), ids: [mine] };
  const denied = await f.call('POST', { ...request, requestId: randomUUID(), ids: [mine, theirs] });
  assert.deepEqual([denied.status, denied.body.code], [404, 'crew_notifications_not_found']);
  assert.equal(f.store.get(`${CREW_NOTIFICATIONS}/${mine}`).acknowledged, false, 'a mixed request changes nothing');
  assert.equal(f.store.get(`${CREW_NOTIFICATIONS}/${theirs}`).acknowledged, false);
  const reads = f.batches.length, direct = [];
  const plainRead = f.store.read;
  f.store.read = async (collection, id) => { if (collection === CREW_NOTIFICATIONS) direct.push(id); return plainRead(collection, id); };
  const done = await f.call('POST', request);
  f.store.read = plainRead;
  assert.deepEqual([done.status, done.body.acknowledged, done.body.alreadyApplied], [200, [mine], false]);
  assert.deepEqual([f.batches.length - reads, direct.length], [1, 0], 'one batch read, never one read per notice');
  assert.deepEqual([f.store.get(`${CREW_NOTIFICATIONS}/${mine}`).acknowledged, f.store.get(`${CREW_NOTIFICATIONS}/${mine}`).acknowledgedAt, f.store.get(`${CREW_NOTIFICATIONS}/${mine}`).acknowledgedRequestId], [true, NOW, request.requestId.toLowerCase()]);
  assert.equal((await f.call('POST', request)).body.alreadyApplied, true);
  assert.equal((await f.call('GET')).body.notices.length, 0);
  f.as('crew2');
  assert.equal((await f.call('POST', { ...request, requestId: randomUUID() })).status, 404, 'someone else\'s notice looks missing');
  for (const bad of [{ ids: [] }, { ids: ['job-1'] }, { ids: [mine, mine] }, { ids: Array.from({ length: 51 }, (_, index) => `crew_${String(index).padStart(40, '0')}`) }, { requestId: 'not-a-uuid' }, { employeeId: 'crew1' }]) {
    const result = await f.call('POST', { action: 'acknowledge', requestId: randomUUID(), ids: [theirs], ...bad });
    assert.deepEqual([result.status, result.body.code], [400, 'crew_notifications_request_invalid'], JSON.stringify(bad));
  }
});

test('the text opt-in is per employee, revisioned and idempotent', async () => {
  const f = await setup(), requestId = randomUUID();
  const on = await f.call('POST', { action: 'set_preferences', requestId, sms: true, expectedRevision: '' });
  assert.equal(on.status, 200);
  assert.deepEqual([on.body.preferences.sms, on.body.preferences.phone, on.body.preferences.phoneStatus, on.body.preferences.updatedAt], [true, '(•••) •••-0155', 'on_file', NOW]);
  const saved = f.store.get(`${CREW_NOTIFICATION_PREFS}/crew1`);
  assert.deepEqual([saved.employeeId, saved.sms, saved.history], ['crew1', true, [{ sms: true, at: NOW, requestId }]]);
  assert.equal((await f.call('POST', { action: 'set_preferences', requestId, sms: true, expectedRevision: '' })).body.replayed, true);
  const reused = await f.call('POST', { action: 'set_preferences', requestId, sms: false, expectedRevision: '' });
  assert.deepEqual([reused.status, reused.body.code], [409, 'crew_notifications_idempotency_conflict']);
  const stale = await f.call('POST', { action: 'set_preferences', requestId: randomUUID(), sms: false, expectedRevision: 'stale' });
  assert.deepEqual([stale.status, stale.body.code], [409, 'crew_notifications_revision_conflict']);
  const unchanged = await f.call('POST', { action: 'set_preferences', requestId: randomUUID(), sms: true, expectedRevision: on.body.preferences.revision });
  assert.equal(unchanged.body.unchanged, true);
  const off = await f.call('POST', { action: 'set_preferences', requestId: randomUUID(), sms: false, expectedRevision: on.body.preferences.revision });
  assert.equal(off.body.preferences.sms, false);
  assert.equal(f.store.get(`${CREW_NOTIFICATION_PREFS}/crew1`).history.length, 2);
  f.as('crew2');
  const other = await f.call('GET');
  assert.deepEqual([other.body.preferences.sms, other.body.preferences.phoneStatus, other.body.preferences.phone], [false, 'missing', '']);
  assert.equal(f.store.get(`${CREW_NOTIFICATION_PREFS}/crew2`), null, 'reading never creates a preference');
  for (const bad of [{ sms: 'yes' }, { expectedRevision: 5 }, { employeeId: 'crew1' }, { requestId: 'x' }]) {
    const result = await f.call('POST', { action: 'set_preferences', requestId: randomUUID(), sms: true, expectedRevision: '', ...bad });
    assert.deepEqual([result.status, result.body.code], [400, 'crew_notifications_request_invalid'], JSON.stringify(bad));
  }
  assert.equal(f.store.get(`${CREW_NOTIFICATION_PREFS}/crew2`), null, 'nobody can change another employee\'s opt-in');
});

test('writes are same-origin JSON with bounded bodies, and unknown failures stay generic', async () => {
  const f = await setup(), body = { action: 'set_preferences', requestId: randomUUID(), sms: true, expectedRevision: '' };
  assert.equal((await f.call('POST', body, { 'Sec-Fetch-Site': 'cross-site' })).body.code, 'crew_notifications_origin_forbidden');
  assert.equal((await f.call('POST', body, { Origin: 'https://evil.example.invalid' })).status, 403);
  assert.equal((await f.call('POST', body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.call('POST', JSON.stringify({ ...body, padding: 'x'.repeat(9000) }))).status, 413);
  assert.equal((await f.call('POST', '{not json')).body.code, 'crew_notifications_json_invalid');
  assert.equal((await f.call('POST', { action: 'send_text', requestId: randomUUID() })).body.code, 'crew_notifications_request_invalid');
  assert.equal(f.store.get(`${CREW_NOTIFICATION_PREFS}/crew1`), null);
  const response = await crewNotificationHandlers({ session: async () => SESSIONS.crew1, storage: () => ({ query: async () => { throw new Error('secret provider detail'); }, read: async () => null }), now: () => new Date(NOW) })
    .get({ request: new Request(URL_PATH), env: ENV });
  const failed = await response.json();
  assert.deepEqual([response.status, failed.code], [503, 'crew_notifications_unavailable']);
  assert.ok(!JSON.stringify(failed).includes('secret provider detail'));
  const noOrigin = await crewNotificationHandlers({ session: async () => SESSIONS.crew1, storage: () => f.store, now: () => new Date(NOW), readAccount: () => async () => null })
    .post({ request: new Request(URL_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: ENV });
  assert.equal(noOrigin.status, 200, 'a missing Origin is allowed because the SameSite=Strict session is still required');
});

test('a partial removal shows only the lost day, with the days still worked', async () => {
  const f = await setup();
  const split = crewB => work({ date: '2026-09-23', endDate: DAY, assignedCrew: [...new Set(['crew1', ...crewB])], assignmentSegments: [
    { id: 'a', date: '2026-09-23', time: '09:00', endTime: '12:00', assignedCrew: ['crew1'] }, { id: 'b', date: DAY, time: '09:00', endTime: '12:00', assignedCrew: crewB }] });
  await f.queue(split(['crew1']), split(['crew2']));
  const [row] = (await f.call('GET')).body.notices;
  assert.deepEqual([row.intent, row.lostSlots.map(slot => slot.date), row.slots.map(slot => slot.date), row.previousSlots.length], ['unassigned', [DAY], ['2026-09-23'], 2]);
  // Rows queued before lostSlots existed still show what the removal took.
  const legacy = f.store.get(`${CREW_NOTIFICATIONS}/${row.id}`); delete legacy.lostSlots; f.store.set(`${CREW_NOTIFICATIONS}/${row.id}`, legacy);
  assert.equal((await f.call('GET')).body.notices[0].lostSlots.length, 2);
});

test('dispatchers see who can be texted and the notices that were not; crew cannot', async () => {
  const f = await setup();
  const [needs] = await f.queue(null, work());
  const [passed] = await f.queue(null, work({ date: '2026-09-21', endDate: '2026-09-21' }), { jobId: 'job-2', at: '2026-09-20T18:00:00.000Z' });
  const [sent] = await f.queue(null, work({ assignedCrew: ['crew2'] }), { jobId: 'job-3' });
  const [unsure] = await f.queue(null, work({ assignedCrew: ['crew2'] }), { jobId: 'job-4' });
  f.mark(needs, { status: 'needs_contact', lastStatus: 'needs_contact', lastReason: 'staff_contact_not_linked', attentionUntil: DAY });
  f.mark(passed, { status: 'needs_contact', lastReason: 'no_phone', attentionUntil: '2026-09-21' });
  f.mark(sent, { status: 'sent', attentionUntil: '' });
  f.mark(unsure, { status: 'uncertain', lastReason: 'no_provider_response', attentionUntil: DAY });
  f.store.set(`${CREW_NOTIFICATION_PREFS}/crew1`, { employeeId: 'crew1', sms: true, smsUpdatedAt: NOW, staffContactId: 'staff-1' });
  const denied = await f.call('GET', undefined, {}, '?view=team');
  assert.deepEqual([denied.status, denied.body.code], [403, 'crew_notifications_forbidden']);
  f.as('manager');
  const { status, body } = await f.call('GET', undefined, {}, '?view=team');
  assert.equal(status, 200);
  assert.deepEqual(body.team.map(row => [row.id, row.sms, row.staffContactId]), [['crew1', true, 'staff-1'], ['crew2', false, ''], ['zacb', false, '']]);
  assert.deepEqual(body.attention.map(row => [row.id, row.employeeId, row.employeeName, row.status, row.reason, row.canRetry]).sort(), [[needs, 'crew1', 'Casey Crew', 'needs_contact', 'staff_contact_not_linked', true], [unsure, 'crew2', 'Riley Other', 'uncertain', 'no_provider_response', false]].sort());
  assert.equal(body.coverage.complete, true);
  for (const value of ['Canary', '555-0199', '555-0155', '8765']) assert.ok(!JSON.stringify(body).includes(value), `no ${value} in the dispatcher view`);
  assert.equal(f.queries.at(-1).attention, '2026-09-22', 'only notices for work still ahead');
  for (const query of ['?view=all', '?view=team&view=team', '?other=1']) assert.equal((await f.call('GET', undefined, {}, query)).status, 400, query);
});

test('a dispatcher links a HighLevel staff contact per crew member, revisioned and idempotent', async () => {
  const f = await setup(), requestId = randomUUID(), link = { action: 'link_staff_contact', requestId, employeeId: 'crew2', contactId: 'staff-2', expectedRevision: '' };
  assert.equal((await f.call('POST', link)).status, 403, 'crew cannot link contacts');
  f.as('manager');
  const done = await f.call('POST', link);
  assert.deepEqual([done.status, done.body.member.id, done.body.member.staffContactId], [200, 'crew2', 'staff-2']);
  const saved = f.store.get(`${CREW_NOTIFICATION_PREFS}/crew2`);
  assert.deepEqual([saved.staffContactId, saved.staffContactLinkedBy, saved.staffContactLinkedAt, saved.staffContactHistory.length, saved.sms], ['staff-2', 'zacb', NOW, 1, undefined]);
  assert.equal((await f.call('POST', link)).body.replayed, true);
  assert.equal((await f.call('POST', { ...link, contactId: 'staff-9' })).body.code, 'crew_notifications_idempotency_conflict');
  assert.equal((await f.call('POST', { ...link, requestId: randomUUID() })).body.code, 'crew_notifications_revision_conflict');
  const unlink = await f.call('POST', { ...link, requestId: randomUUID(), contactId: '', expectedRevision: done.body.member.revision });
  assert.equal(unlink.body.member.staffContactId, '');
  assert.equal((await f.call('POST', { ...link, requestId: randomUUID(), employeeId: 'ghost' })).status, 404);
  for (const bad of [{ contactId: 'has space' }, { contactId: 5 }, { employeeId: 'Crew2' }, { expectedRevision: 1 }, { sms: true }]) {
    const result = await f.call('POST', { ...link, requestId: randomUUID(), ...bad });
    assert.deepEqual([result.status, result.body.code], [400, 'crew_notifications_request_invalid'], JSON.stringify(bad));
  }
  f.as('crew2');
  const own = await f.call('GET');
  const opted = await f.call('POST', { action: 'set_preferences', requestId: randomUUID(), sms: true, expectedRevision: own.body.preferences.revision });
  assert.equal(opted.body.preferences.sms, true, 'the employee still controls their own opt-in');
  assert.equal(f.store.get(`${CREW_NOTIFICATION_PREFS}/crew2`).staffContactId, '', 'and cannot see or change the link');
  assert.ok(!('staffContactId' in own.body.preferences));
});

test('a dispatcher can queue a notice that was not texted again; unconfirmed or passed ones cannot be', async () => {
  const f = await setup();
  const [needs] = await f.queue(null, work()), [unsure] = await f.queue(null, work(), { jobId: 'job-2' }), [passed] = await f.queue(null, work({ date: '2026-09-21', endDate: '2026-09-21' }), { jobId: 'job-3', at: '2026-09-20T18:00:00.000Z' });
  const [exhausted] = await f.queue(null, work(), { jobId: 'job-4' });
  f.mark(needs, { status: 'needs_contact', attempts: 1, lastReason: 'staff_contact_not_linked', attentionUntil: DAY });
  f.mark(unsure, { status: 'uncertain', attentionUntil: DAY });
  f.mark(passed, { status: 'failed', attentionUntil: '2026-09-21' });
  f.mark(exhausted, { status: 'failed', lastStatus: 'attempts_exhausted', attentionUntil: DAY });
  const request = { action: 'retry', requestId: randomUUID(), ids: [needs] };
  assert.equal((await f.call('POST', request)).status, 403);
  f.as('manager');
  const done = await f.call('POST', request);
  assert.deepEqual([done.status, done.body.retried, done.body.alreadyApplied], [200, [needs], false]);
  const row = f.store.get(`${CREW_NOTIFICATIONS}/${needs}`);
  assert.deepEqual([row.status, row.attempts, row.attentionUntil, row.lastStatus, row.retriedBy], ['pending', 0, '', 'retry_requested', 'zacb']);
  assert.equal((await f.call('POST', request)).body.alreadyApplied, true);
  for (const id of [unsure, passed, exhausted]) {
    const result = await f.call('POST', { action: 'retry', requestId: randomUUID(), ids: [id] });
    assert.deepEqual([result.status, result.body.code], [409, 'crew_notifications_not_retryable']);
  }
  assert.equal((await f.call('POST', { action: 'retry', requestId: randomUUID(), ids: [`crew_${'9'.repeat(40)}`] })).status, 404);
});

test('a notice a newer one for the same job and employee replaced is closed, not queued again', async () => {
  const f = await setup();
  const [old] = await f.queue(null, work(), { at: '2026-09-22T17:00:00.000Z' }), [newer] = await f.queue(work(), work({ time: '10:00' }), { at: '2026-09-22T17:10:00.000Z' });
  const [latest] = await f.queue(work({ time: '10:00' }), work({ time: '11:00' }), { at: '2026-09-22T17:20:00.000Z' });
  f.mark(old, { status: 'needs_contact', attempts: 1, lastReason: 'staff_contact_not_linked', attentionUntil: DAY });
  f.mark(newer, { status: 'needs_contact', attempts: 1, lastReason: 'staff_contact_not_linked', attentionUntil: DAY });
  f.mark(latest, { status: 'sent', attempts: 1, deliveredAt: NOW });
  f.as('manager');
  const team = (await f.call('GET', undefined, {}, '?view=team')).body;
  assert.deepEqual(team.attention.map(row => [row.id, row.canRetry]).sort(), [[old, false], [newer, true]].sort(), 'only the newest unsent notice offers Send again');
  const request = { action: 'retry', requestId: randomUUID(), ids: [newer] };
  const done = await f.call('POST', request);
  assert.deepEqual([done.status, done.body.retried, done.body.superseded, done.body.alreadyApplied], [200, [], [newer], false], 'a text already went out for the newest change');
  const row = f.store.get(`${CREW_NOTIFICATIONS}/${newer}`);
  assert.deepEqual([row.status, row.lastReason, row.attentionUntil, row.retriedBy], ['superseded', 'newer_notice', '', 'zacb']);
  const replay = await f.call('POST', request);
  assert.deepEqual([replay.body.superseded, replay.body.alreadyApplied], [[newer], true]);
  assert.ok(f.queries.some(query => JSON.stringify(query.filters) === JSON.stringify([['jobId', 'job-1'], ['employeeId', 'crew1']])), 'an equality query on the job and employee');
  f.mark(latest, { status: 'needs_contact', attentionUntil: DAY });
  const again = await f.call('POST', { action: 'retry', requestId: randomUUID(), ids: [latest] });
  assert.deepEqual([again.body.retried, again.body.superseded, f.store.get(`${CREW_NOTIFICATIONS}/${latest}`).status], [[latest], [], 'pending'], 'the newest one is queued again');
});
