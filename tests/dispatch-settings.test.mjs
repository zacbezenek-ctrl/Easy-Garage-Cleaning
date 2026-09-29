import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DISPATCH_SETTINGS_DEFAULTS, dispatchRuleSettings, effectiveArrivalSettings, mutateDispatchSettings, normalizeDispatchSettings } from '../functions/_lib/dispatch-settings.js';
import { dispatchSettingsHandlers } from '../functions/api/dispatch-settings.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { existsSync } from 'node:fs';
import { hubPage } from './helpers/hub-dom.mjs';

const NOW = '2026-09-22T12:00:00.000Z', ORIGIN = 'https://easygaragecleaning.com';
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const manager = { user: 'tylerg', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const crew = { user: 'crew1', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false };

function fixture() {
  const rows = new Map([['customers/c1', { id: 'c1', name: 'Synthetic Customer', phone: '970-555-0101', address: '100 Synthetic Street', revision: 'c1r' }]]), commits = [];
  let revision = 0, lose = false, beforeCommit = null;
  const clone = value => structuredClone(value), all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'),
    roster: async () => [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Synthetic Crew', role: 'crew' }],
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      if (beforeCommit) { const hook = beforeCommit; beforeCommit = null; await hook(); }
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      commits.push(clone(writes));
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
      if (lose) { lose = false; throw Object.assign(new Error('Lost'), { code: 'dispatch_outcome_unknown', status: 503 }); }
    },
  };
  const handlers = (actor, extra = {}) => dispatchSettingsHandlers({ session: async () => actor, storage: () => store, now: () => new Date(NOW), ...extra });
  const post = (actor, body, headers = {}, env = {}) => handlers(actor).post({ env, request: new Request(`${ORIGIN}/api/dispatch-settings`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const get = (actor, query = '', env = {}) => handlers(actor).get({ env, request: new Request(`${ORIGIN}/api/dispatch-settings${query}`) });
  const update = (changes, extra = {}) => ({ action: 'settings.update', requestId: randomUUID(), expectedRevision: rows.get('dispatchSettings/current')?.revision || null, changes, ...extra });
  return { rows, store, commits, handlers, post, get, update, loseNext: () => { lose = true; }, beforeCommit: hook => { beforeCommit = hook; } };
}

test('missing or malformed settings read as today\'s behaviour, field by field, and are reported for repair', async () => {
  assert.deepEqual(normalizeDispatchSettings(null), { values: DISPATCH_SETTINGS_DEFAULTS, invalidFields: [], source: 'defaults', revision: null, updatedAt: null, updatedBy: null });
  assert.deepEqual(DISPATCH_SETTINGS_DEFAULTS, { defaultTravelBufferMinutes: 20, defaultArrivalWindowMinutes: null, workdayStart: '08:00', workdayEnd: '17:00', blockCrewShort: false, blockSkillMissing: false, blockTravelShort: false, blockOverCapacity: false, blockOutsideHours: false, maxJobsPerEmployeePerDay: null, maxHoursPerEmployeePerDay: null });
  const stored = normalizeDispatchSettings({ revision: 'r9', blockCrewShort: 'yes', maxJobsPerEmployeePerDay: 0, maxHoursPerEmployeePerDay: 7.3, workdayStart: '18:00', workdayEnd: '09:00', defaultTravelBufferMinutes: 45, blockSkillMissing: true, updatedBy: 'zacb' });
  assert.deepEqual(stored.invalidFields.sort(), ['blockCrewShort', 'maxHoursPerEmployeePerDay', 'maxJobsPerEmployeePerDay', 'workdayEnd', 'workdayStart']);
  assert.equal(stored.values.blockCrewShort, false, 'an unreadable block setting stays a warning');
  assert.equal(stored.values.blockSkillMissing, true); assert.equal(stored.values.defaultTravelBufferMinutes, 45);
  assert.deepEqual([stored.values.workdayStart, stored.values.workdayEnd], ['08:00', '17:00'], 'a reversed workday reads as the default');
  assert.equal(stored.source, 'firestore'); assert.equal(stored.revision, 'r9'); assert.ok(Object.isFrozen(stored.values));
  assert.equal(normalizeDispatchSettings({ maxHoursPerEmployeePerDay: 7.25, workdayEnd: '24:00' }).invalidFields.length, 0);
  assert.equal(await dispatchRuleSettings({}), DISPATCH_SETTINGS_DEFAULTS, 'stores without read() use the defaults');
  assert.deepEqual(effectiveArrivalSettings({ defaultArrivalWindowEnabled: true, defaultArrivalWindowMinutes: 60 }, { defaultArrivalWindowMinutes: null }), { defaultArrivalWindowEnabled: true, defaultArrivalWindowMinutes: 60 });
  assert.deepEqual(effectiveArrivalSettings({ defaultArrivalWindowEnabled: false, defaultArrivalWindowMinutes: 60 }, { defaultArrivalWindowMinutes: 120 }), { defaultArrivalWindowEnabled: false, defaultArrivalWindowMinutes: 120 }, 'the owner sets the length, never whether customers see a derived window');
  await assert.rejects(dispatchRuleSettings({ read: async () => { throw Object.assign(new Error('down'), { code: 'dispatch_storage_unavailable', status: 503 }); } }), error => error.code === 'dispatch_storage_unavailable', 'a failed read fails the request');
});

test('the settings API is owner-only for reading and writing', async () => {
  const f = fixture();
  for (const [actor, status, code] of [[null, 401, 'dispatch_sign_in_required'], [manager, 403, 'dispatch_settings_forbidden'], [crew, 403, 'dispatch_settings_forbidden'], [{ ...manager, user: 'zacb', businessAccess: false }, 403, 'dispatch_settings_forbidden']]) {
    const read = await f.get(actor);
    assert.equal(read.status, status); assert.equal((await read.json()).code, code);
    const write = await f.post(actor, f.update({ blockCrewShort: true }));
    assert.equal(write.status, status); assert.equal((await write.json()).code, code);
  }
  assert.equal(f.commits.length, 0);
  const response = await f.get(owner, '', { EGC_DISPATCH_TRAVEL_ESTIMATES: 'offline', EGC_DISPATCH_BLOCK_TRAVEL_SHORT: 'true', EGC_STAFF_DIRECTORY_ENABLED: 'true' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.json();
  assert.deepEqual(body.settings, { revision: null, source: 'defaults', values: DISPATCH_SETTINGS_DEFAULTS, invalidFields: [], updatedAt: null, updatedBy: null });
  assert.deepEqual(body.environment, { arrival: { enabled: false, minutes: 60 }, envArrivalMinutes: 60, travelEstimates: 'offline', envBlockTravelShort: true, staffDirectory: true });
  assert.ok(body.skills.some(skill => skill.id === 'truck_driving')); assert.equal(body.viewer.id, 'zacb');
  assert.equal((await f.get(owner, '?x=1')).status, 400);
  // With stored staff roles on, the owner capability still needs the configured owner.
  assert.equal((await f.get({ ...manager, staffRoles: ['owner', 'manager'] }, '', { EGC_STAFF_ROLE_PERMISSIONS: 'true' })).status, 403);
});

test('POST is same-origin JSON with a byte limit and a strict shape', async () => {
  const f = fixture(), body = f.update({ blockCrewShort: true });
  for (const [headers, status, code] of [[{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'dispatch_origin_forbidden'], [{ Origin: 'https://evil.example' }, 403, 'dispatch_origin_forbidden'], [{ Origin: 'null' }, 403, 'dispatch_origin_forbidden'], [{ 'Content-Type': 'text/plain' }, 415, 'dispatch_json_required'], [{ 'Content-Length': '9000' }, 413, 'dispatch_request_too_large']]) {
    const response = await f.post(owner, body, headers);
    assert.equal(response.status, status, JSON.stringify(headers)); assert.equal((await response.json()).code, code);
  }
  assert.equal((await f.post(owner, JSON.stringify({ ...body, reason: 'x'.repeat(9000) }))).status, 413);
  assert.equal((await (await f.post(owner, '{"action":')).json()).code, 'dispatch_json_invalid');
  const referer = await f.post(owner, f.update({ blockCrewShort: true }), { Origin: '', Referer: `${ORIGIN}/employee.html` });
  assert.equal(referer.status, 200, 'a same-origin Referer is accepted');
  const invalid = [
    [{ ...f.update({ blockCrewShort: true }), requestId: 'not-a-uuid' }, 'dispatch_request_invalid'],
    [{ ...f.update({ blockCrewShort: true }), action: 'settings.replace' }, 'dispatch_request_invalid'],
    [{ ...f.update({ blockCrewShort: true }), extra: true }, 'dispatch_patch_not_allowed'],
    [(({ expectedRevision, ...rest }) => rest)(f.update({ blockCrewShort: true })), 'dispatch_settings_invalid'],
    [f.update({}), 'dispatch_settings_invalid'],
    [f.update({ blockEverything: true }), 'dispatch_settings_invalid'],
    [f.update({ blockCrewShort: 'true' }), 'dispatch_settings_invalid'],
    [f.update({ defaultTravelBufferMinutes: 181 }), 'dispatch_settings_invalid'],
    [f.update({ defaultArrivalWindowMinutes: 10 }), 'dispatch_settings_invalid'],
    [f.update({ maxJobsPerEmployeePerDay: 1.5 }), 'dispatch_settings_invalid'],
    [f.update({ maxHoursPerEmployeePerDay: 0.5 }), 'dispatch_settings_invalid'],
    [f.update({ maxHoursPerEmployeePerDay: 8.1 }), 'dispatch_settings_invalid'],
    [f.update({ workdayStart: '8:00' }), 'dispatch_settings_invalid'],
    [f.update({ workdayStart: '17:00', workdayEnd: '08:00' }), 'dispatch_settings_invalid'],
    [f.update({ workdayStart: '24:00' }), 'dispatch_settings_invalid'],
    [f.update({ blockCrewShort: true }, { reason: 7 }), 'dispatch_settings_invalid'],
  ];
  for (const [input, code] of invalid) {
    const response = await f.post(owner, input);
    assert.equal(response.status, 400, JSON.stringify(input)); assert.equal((await response.json()).code, code, JSON.stringify(input));
  }
});

test('a save commits settings, the dispatch guard, a scoped receipt and an audit entry together, with revision checks', async () => {
  const f = fixture(); f.rows.set('dispatchState/revision', { id: 'revision', revision: 'guard-1' });
  const input = f.update({ blockSkillMissing: true, maxJobsPerEmployeePerDay: 4, maxHoursPerEmployeePerDay: 9.5, workdayEnd: '24:00', defaultArrivalWindowMinutes: 120 }, { reason: 'Synthetic peak season' });
  const response = await f.post(owner, input, {}, { EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED: 'true' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.replayed, false); assert.equal(body.requestId, input.requestId);
  assert.deepEqual(body.settings.values, { ...DISPATCH_SETTINGS_DEFAULTS, blockSkillMissing: true, maxJobsPerEmployeePerDay: 4, maxHoursPerEmployeePerDay: 9.5, workdayEnd: '24:00', defaultArrivalWindowMinutes: 120 });
  assert.equal(body.settings.source, 'firestore'); assert.equal(body.settings.updatedBy, 'zacb'); assert.equal(body.settings.updatedAt, NOW);
  assert.deepEqual(body.environment.arrival, { enabled: true, minutes: 120 });
  const [writes] = f.commits;
  assert.deepEqual(writes.map(write => write.collection), ['dispatchSettings', 'dispatchState', 'dispatchOperations', 'hub_audit']);
  assert.equal(writes[0].revision, undefined, 'the first save creates the document');
  assert.equal(writes[1].revision, 'guard-1', 'the save advances the same guard schedule writes read first');
  assert.equal(writes[2].id, input.requestId.toLowerCase());
  assert.deepEqual([writes[2].patch.scope, writes[2].patch.actorId, writes[2].patch.before], ['dispatch_settings', 'zacb', null]);
  assert.match(writes[2].patch.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual([writes[3].patch.action, writes[3].patch.entityKey, writes[3].patch.reason, writes[3].patch.requestId], ['dispatch_settings.update', 'dispatchSettings/current', 'Synthetic peak season', input.requestId.toLowerCase()]);
  assert.ok(writes[3].patch.changedKeys.includes('blockSkillMissing'));
  // Stale and missing revisions are conflicts; the current revision updates in place.
  const stale = await f.post(owner, { ...f.update({ blockCrewShort: true }), expectedRevision: null });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { ok: false, code: 'dispatch_settings_revision_conflict', error: 'The dispatch settings changed since you opened them. Reload and review the latest settings.', details: { currentRevision: body.settings.revision } });
  const second = await (await f.post(owner, f.update({ blockCrewShort: true, maxHoursPerEmployeePerDay: null }))).json();
  assert.equal(second.settings.values.blockCrewShort, true); assert.equal(second.settings.values.maxHoursPerEmployeePerDay, null); assert.equal(second.settings.values.blockSkillMissing, true, 'unchanged fields are kept');
  assert.equal(f.commits[1][0].revision, body.settings.revision);
  assert.deepEqual(f.commits[1][2].patch.before, body.settings.values);
});

test('replays return the saved result; a changed body or a later save is a conflict; a lost reply is recovered', async () => {
  const f = fixture(), input = f.update({ blockOutsideHours: true });
  const first = await (await f.post(owner, input)).json();
  const replay = await (await f.post(owner, input)).json();
  assert.equal(replay.replayed, true); assert.deepEqual(replay.settings, first.settings);
  assert.equal(f.commits.length, 1, 'a replay never writes');
  const changed = await f.post(owner, { ...input, changes: { blockOutsideHours: false } });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'dispatch_idempotency_conflict');
  assert.equal((await (await f.post({ ...owner }, { ...input })).json()).replayed, true);
  await f.post(owner, f.update({ blockCrewShort: true }));
  const later = await f.post(owner, input);
  assert.equal(later.status, 409); assert.equal((await later.json()).code, 'dispatch_changed_since_operation');
  // A dispatch receipt with the same id is not a settings receipt.
  const g = fixture(), reused = g.update({ blockCrewShort: true });
  g.rows.set(`dispatchOperations/${reused.requestId.toLowerCase()}`, { id: reused.requestId, scope: undefined, fingerprint: 'x' });
  assert.equal((await (await g.post(owner, reused)).json()).code, 'dispatch_idempotency_conflict');
  const h = fixture(), lost = h.update({ blockCrewShort: true });
  h.loseNext();
  const recovered = await (await h.post(owner, lost)).json();
  assert.equal(recovered.ok, true); assert.equal(recovered.settings.values.blockCrewShort, true);
  assert.equal(h.commits.length, 1);
  // A copy of the same request that commits first leaves this one to replay it.
  const k = fixture(), racing = k.update({ blockCrewShort: true });
  k.beforeCommit(() => mutateDispatchSettings(k.store, owner, racing, NOW));
  const raced = await (await k.post(owner, racing)).json();
  assert.equal(raced.ok, true); assert.equal(raced.settings.values.blockCrewShort, true); assert.equal(k.commits.length, 1, 'the receipt proves the other copy saved it');
});

test('saved settings change dispatch behaviour, and a settings save serializes with an in-flight schedule save', async () => {
  const f = fixture();
  await f.post(owner, f.update({ blockCrewShort: true, defaultTravelBufferMinutes: 45 }));
  const create = changes => ({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '09:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic scope', ...changes } });
  await assert.rejects(mutateDispatch(f.store, owner, create({ crewNeeded: 2 }), NOW), error => error.code === 'dispatch_conflict' && error.details.conflicts[0].code === 'crew_size_short');
  const saved = await mutateDispatch(f.store, owner, create({}), NOW);
  assert.equal(f.rows.get('jobs/' + saved.job.id).travelBufferMinutes, 45);
  // The schedule save read the guard before the settings changed, so its commit fails.
  f.beforeCommit(() => mutateDispatchSettings(f.store, owner, f.update({ blockCrewShort: false }), NOW));
  await assert.rejects(mutateDispatch(f.store, owner, create({ time: '11:00', endTime: '12:00' }), NOW), error => error.code === 'dispatch_revision_conflict');
  assert.equal(f.rows.get('dispatchSettings/current').blockCrewShort, false);
});

test('a schedule save that wins the shared guard is retried, never reported as a settings conflict', async () => {
  const f = fixture(); f.rows.set('dispatchState/revision', { id: 'revision', revision: 'guard-1' });
  const schedule = time => () => mutateDispatch(f.store, owner, { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time, endTime: time.replace(':00', ':30'), assignedCrew: ['crew1'], jobInstructions: 'Synthetic scope' } }, NOW);
  let guard = null;
  f.beforeCommit(async () => { await schedule('09:00')(); guard = f.rows.get('dispatchState/revision').revision; });
  const input = f.update({ blockCrewShort: true }), response = await f.post(owner, input);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.values.blockCrewShort, true); assert.equal(body.requestId, input.requestId);
  assert.equal(f.commits.length, 2, 'the schedule save, then the settings save re-read against the new guard');
  assert.notEqual(guard, 'guard-1'); assert.equal(f.commits[1][1].revision, guard);
  // Schedule saves that keep winning: nothing is saved, and the answer is a retry of the same request, not a reload.
  let races = 0;
  const race = async () => { await schedule(`1${races}:00`)(); if (++races < 2) f.beforeCommit(race); };
  f.beforeCommit(race);
  const busyInput = f.update({ blockOutsideHours: true }), busy = await f.post(owner, busyInput);
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { ok: false, code: 'dispatch_settings_busy', error: 'The schedule was being saved at the same moment, so the dispatch settings were not saved. Your changes are kept; retry the same save.' });
  assert.equal(races, 2); assert.equal(f.rows.get('dispatchSettings/current').blockOutsideHours, false);
  assert.equal(f.rows.get(`dispatchOperations/${busyInput.requestId.toLowerCase()}`), undefined, 'no receipt: the retry runs the save');
  const retried = await (await f.post(owner, busyInput)).json();
  assert.equal(retried.ok, true); assert.equal(retried.replayed, false); assert.equal(retried.settings.values.blockOutsideHours, true);
  // A settings save from another tab during the race is still the settings conflict.
  f.beforeCommit(() => mutateDispatchSettings(f.store, owner, f.update({ maxJobsPerEmployeePerDay: 5 }), NOW));
  const stale = await f.post(owner, f.update({ blockOverCapacity: true }));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'dispatch_settings_revision_conflict');
  assert.equal(f.rows.get('dispatchSettings/current').blockOverCapacity, false); assert.equal(f.rows.get('dispatchSettings/current').maxJobsPerEmployeePerDay, 5);
});

test('production storage reads dispatchSettings/current and a missing document means the defaults', async () => {
  const doc = fields => ({ name: 'projects/egcw-1ec83/databases/(default)/documents/dispatchSettings/current', updateTime: '2026-09-22T12:00:00.000001Z', fields: encodeFirestoreFields(fields) });
  const paths = [];
  let found = null;
  const store = dispatchStorage({}, async (env, url) => { paths.push(new URL(url).pathname); return found ? new Response(JSON.stringify(doc(found)), { status: 200 }) : new Response('{}', { status: 404 }); });
  assert.deepEqual(await dispatchRuleSettings(store), DISPATCH_SETTINGS_DEFAULTS);
  assert.ok(paths[0].endsWith('/documents/dispatchSettings/current'));
  found = { blockOverCapacity: true, maxJobsPerEmployeePerDay: 3 };
  assert.deepEqual(await dispatchRuleSettings(store), { ...DISPATCH_SETTINGS_DEFAULTS, blockOverCapacity: true, maxJobsPerEmployeePerDay: 3 });
  const failing = dispatchStorage({}, async () => new Response('{}', { status: 500 }));
  await assert.rejects(dispatchRuleSettings(failing), error => error.code === 'dispatch_storage_unavailable' && error.status === 503);
});

test('the settings editor is a registered owner-only Hub screen whose files ship with the Hub', () => {
  const owner = hubPage(), entry = owner.context.EGCHubScreens.get('dispatch_rules');
  assert.deepEqual({ group: entry.group, label: entry.label, capability: entry.capability, crewVisible: entry.crewVisible, module: entry.module, load: { ...entry.load } },
    { group: 'RUN THE BUSINESS', label: 'Dispatch rules', capability: 'owner', crewVisible: false, module: 'EGCDispatchSettings', load: { js: 'employee-dispatch-settings.js', css: 'employee-dispatch-settings.css', v: '20260929rules3' } });
  for (const file of [entry.load.js, entry.load.css]) assert.ok(existsSync(new URL('../' + file, import.meta.url)), file);
  assert.equal(owner.api.canView('dispatch_rules'), true);
  assert.equal(hubPage({ user: 'TylerG', role: 'manager' }).api.canView('dispatch_rules'), false, 'managers dispatch but do not set the rules');
  assert.equal(hubPage({ user: 'Synthetic.Crew', business: false, role: 'crew' }).api.canView('dispatch_rules'), false);
});
