import test from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOWUP_DUE, followupDueAt, followupPolicy, followupRoles, followupSettingsStorage } from '../functions/_lib/operations-followup-policy.js';
import { operationsRoster } from '../functions/_lib/operations-staff.js';
import { inboundResponsePolicy } from '../functions/_lib/operations-rules.js';
import { signOperationsEnvelope } from '../functions/_lib/operations-envelope.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { followupSettingsHandlers } from '../functions/api/operations-followup-settings.js';
import { onRequestPost as portal } from '../functions/api/operations-portal.js';
import { actionCenterOwners, onRequestGet as operationsGet } from '../functions/api/operations.js';
import { vaultFirestore, staffEnv, seedAccount, cookieFor, jsonRequest, ROOT, ORIGIN } from './helpers/vault-fixture.mjs';
import { FixedDate, createDocument, hubPage, storage } from './helpers/hub-dom.mjs';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const NOW = '2026-09-22T18:00:00.000Z';
const key = 'isolated-webcrypto-test-key-01234567890123456789';
const env = staffEnv();
const STAFF = { EGC_OPERATIONS_STAFF_MEMBERS: 'true' };
const window = { startHour: 8, endHour: 19, timeZone: 'America/Denver' };
const members = [
  { id: 'ZacB', role: 'owner' }, { id: 'TylerG', role: 'manager', staffRoles: ['manager', 'sales'] }, { id: 'AlexK', role: 'crew_lead' },
  { id: 'Zoe.Synthetic', role: 'sales', staffRoles: ['sales'], businessAccess: false }, { id: 'Phone.Person', role: 'phone', staffRoles: ['phone'], businessAccess: false },
  { id: 'Crew.Static', active: true }, { id: 'Former.Sales', active: false },
];
const policy = (config = {}, settings = null, roster = members) => followupPolicy(config, roster, settings).followup;
const handlers = followupSettingsHandlers({ now: () => new Date(NOW) });
const SETTINGS = 'operations_settings/followups';
const saved = fire => fire.documents.has(SETTINGS) ? { ...decodeFirestoreFields(fire.documents.get(SETTINGS).fields), revision: fire.documents.get(SETTINGS).updateTime } : null;
const audits = fire => [...fire.documents].filter(([id]) => id.startsWith('hub_audit/')).map(([id, doc]) => ({ id, ...decodeFirestoreFields(doc.fields) }));
const input = (extra = {}) => ({ requestId: crypto.randomUUID(), expectedRevision: '', ownerId: 'Zoe.Synthetic', dueMinutes: 240, sendWindow: { startHour: 8, endHour: 19 }, ...extra });
async function call(method, body, { user = 'ZacB', extraEnv = STAFF, headers = {} } = {}) {
  const runEnv = { ...env, ...extraEnv }, cookie = user ? await cookieFor(runEnv, user) : '';
  const request = jsonRequest('/api/operations-followup-settings', method === 'GET' ? undefined : body, cookie, headers);
  const response = await handlers[method === 'GET' ? 'get' : 'post']({ request, env: runEnv });
  return { status: response.status, body: await response.json() };
}
async function seedStaff() {
  await seedAccount(env, 'Zoe.Synthetic', { sales: true, extra: { hourlyRate: 47.25, bankAccountNumber: 'synthetic-canary-account', notes: 'synthetic-canary-note' } });
  await seedAccount(env, 'Phone.Person', { extra: { staffRoles: ['phone'] } });
  await seedAccount(env, 'Former.Sales', { status: 'rejected', extra: { staffRoles: ['sales'] } });
  await seedAccount(env, 'Crew.Account');
}
const writeSettings = (fire, fields) => fire.documents.set(SETTINGS, { name: `${ROOT}/${SETTINGS}`, fields: encodeFirestoreFields(fields), updateTime: '2026-09-21T12:00:00.000001Z' });
async function rpc(extraEnv, body) {
  const claims = { v: 1, iss: 'portal', aud: 'egc-portal', iat: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(), actor: { id: 'inbound-response-reconciler', role: 'integration', kind: 'integration', workspace: 'egc' }, request: { requestId: crypto.randomUUID(), body } };
  const request = new Request('https://portal.test/api/operations-portal', { method: 'POST', body: JSON.stringify({ envelope: await signOperationsEnvelope(claims, key) }) });
  const response = await portal({ request, env: { ...env, EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: key, ...extraEnv } });
  return { status: response.status, text: await response.text() };
}

test('the settings owner wins over the env owner and role, and the env fallback applies only when settings name no owner', () => {
  const both = { EGC_OPERATIONS_FOLLOWUP_OWNER_ID: 'Phone.Person', EGC_OPERATIONS_FOLLOWUP_ROLE: 'manager' };
  assert.deepEqual(policy(both, { ownerId: 'Zoe.Synthetic' }), { enabled: true, ownerId: 'Zoe.Synthetic', ownerRole: 'sales', ownerSource: 'settings', dueMinutes: 240, dueSource: 'default', sendWindow: window, blockedReason: null });
  assert.deepEqual([policy(both, { ownerId: null }).ownerId, policy(both, { ownerId: null }).ownerSource, policy(both).ownerRole], ['Phone.Person', 'env', 'phone']);
  assert.equal(policy({ EGC_OPERATIONS_FOLLOWUP_OWNER_ID: ' phone.person ' }).ownerId, 'Phone.Person', 'ids match case-insensitively and resolve to the canonical member id');
  assert.equal(policy({}, { ownerId: 'zoe.synthetic' }).ownerId, 'Zoe.Synthetic');
  assert.deepEqual([policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: ' Phone ' }).ownerId, policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }).ownerSource, policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }).ownerRole], ['Phone.Person', 'env', 'phone']);
  assert.equal(policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'manager' }).ownerId, 'TylerG');
  assert.deepEqual(policy({ EGC_OPERATIONS_FOLLOWUP_OWNER_ID: 'TylerG' }), { enabled: true, ownerId: 'TylerG', ownerRole: 'manager', ownerSource: 'env', dueMinutes: 240, dueSource: 'default', sendWindow: window, blockedReason: null });
  assert.deepEqual(policy({}, { ownerId: 'ZacB', dueMinutes: 30, sendWindow: { startHour: 9, endHour: 17, timeZone: 'America/Denver' } }), { enabled: true, ownerId: 'ZacB', ownerRole: 'owner', ownerSource: 'settings', dueMinutes: 30, dueSource: 'settings', sendWindow: { startHour: 9, endHour: 17, timeZone: 'America/Denver' }, blockedReason: null });
  assert.equal(followupPolicy({}, members, null).authority, 'employee_hub');
});

test('an unknown, inactive, ineligible or ambiguous owner blocks with an explicit reason and never falls through to another source', () => {
  const fallback = { EGC_OPERATIONS_FOLLOWUP_OWNER_ID: 'Phone.Person', EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' };
  const expectBlocked = (result, reason, ownerSource) => assert.deepEqual([result.enabled, result.ownerId, result.ownerRole, result.ownerSource, result.blockedReason], [false, null, null, ownerSource, reason], reason);
  expectBlocked(policy(fallback, { ownerId: 'Nobody.Here' }), 'followup_owner_unknown', 'settings');
  expectBlocked(policy(fallback, { ownerId: 'Former.Sales' }), 'followup_owner_inactive', 'settings');
  expectBlocked(policy(fallback, { ownerId: 'Crew.Static' }), 'followup_owner_ineligible', 'settings');
  expectBlocked(policy(fallback, { ownerId: 'AlexK' }), 'followup_owner_ineligible', 'settings');
  expectBlocked(policy({ EGC_OPERATIONS_FOLLOWUP_OWNER_ID: 'former.sales' }), 'followup_owner_inactive', 'env');
  expectBlocked(policy({ EGC_OPERATIONS_FOLLOWUP_OWNER_ID: 'Nobody.Here', EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }), 'followup_owner_unknown', 'env');
  expectBlocked(policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'sales' }), 'followup_owner_ambiguous', 'env');
  expectBlocked(policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }, null, members.filter(member => member.id !== 'Phone.Person')), 'followup_owner_unresolved', 'env');
  for (const role of ['crew', 'crew_lead', 'integration', 'constructor', '__proto__']) expectBlocked(policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: role }), 'followup_role_invalid', 'env');
  expectBlocked(policy({}), 'followup_owner_unresolved', 'unresolved');
  expectBlocked(policy({ EGC_OPERATIONS_FOLLOWUP_OWNER_ID: '   ' }, { ownerId: null }), 'followup_owner_unresolved', 'unresolved');
  expectBlocked(policy({}, { ownerId: 'Zoe.Synthetic' }, [...members, { id: 'zoe.synthetic', active: false }]), 'followup_owner_ambiguous', 'settings');
  assert.deepEqual(followupRoles({ id: 'x', role: 'constructor', staffRoles: ['__proto__', 'toString', 'phone'] }), ['phone'], 'prototype keys are never roles');
  assert.deepEqual(followupRoles({ id: 'x', role: 'sales', active: false }), []);
});

test('invalid due minutes, send windows or settings block the policy; an unreadable settings record never falls back to env', () => {
  const owner = { ownerId: 'Zoe.Synthetic' };
  for (const dueMinutes of [0, 14, 10081, 30.5, '240', -60, true]) {
    const result = policy({}, { ...owner, dueMinutes });
    assert.deepEqual([result.enabled, result.dueMinutes, result.dueSource, result.blockedReason, result.ownerId], [false, null, 'settings', 'followup_due_rule_invalid', 'Zoe.Synthetic'], String(dueMinutes));
  }
  for (const dueMinutes of [FOLLOWUP_DUE.min, FOLLOWUP_DUE.max]) assert.equal(policy({}, { ...owner, dueMinutes }).enabled, true);
  for (const sendWindow of [{ startHour: 7, endHour: 19 }, { startHour: 8, endHour: 22 }, { startHour: 12, endHour: 12 }, { startHour: 15, endHour: 9 }, { startHour: 8.5, endHour: 19 }, { startHour: 8, endHour: 19, timeZone: 'UTC' }, { startHour: 8, endHour: 19, days: 'all' }, 'daytime', []]) {
    const result = policy({}, { ...owner, sendWindow });
    assert.deepEqual([result.enabled, result.sendWindow, result.blockedReason], [false, null, 'followup_send_window_invalid'], JSON.stringify(sendWindow));
  }
  assert.deepEqual(policy({}, { ...owner, sendWindow: { startHour: 8, endHour: 21 } }).sendWindow, { startHour: 8, endHour: 21, timeZone: 'America/Denver' });
  const env_ = { EGC_OPERATIONS_FOLLOWUP_OWNER_ID: 'Phone.Person' };
  for (const settings of [undefined, 'corrupt', ['ownerId'], 7]) assert.deepEqual(followupPolicy(env_, members, settings).followup, { enabled: false, ownerId: null, ownerRole: null, ownerSource: 'unresolved', dueMinutes: null, dueSource: null, sendWindow: null, blockedReason: 'followup_settings_unavailable' });
  for (const ownerId of [7, '', ' ', 'x'.repeat(81), { id: 'Zoe.Synthetic' }]) assert.deepEqual([policy(env_, { ownerId }).blockedReason, policy(env_, { ownerId }).ownerId], ['followup_settings_invalid', null], JSON.stringify(ownerId));
});

// Shared with egc-platform/apps/api/src/inbound-actions.test.ts: [from, due] in UTC across both 2026-27 DST changes.
const VECTORS = [['2026-09-22T15:00:00.000Z', '2026-09-22T19:00:00.000Z'], ['2026-09-22T23:30:00.000Z', '2026-09-23T14:00:00.000Z'], ['2026-09-22T08:00:00.000Z', '2026-09-22T14:00:00.000Z'], ['2026-09-22T10:00:00.000Z', '2026-09-22T14:00:00.000Z'], ['2026-09-22T21:00:00.000Z', '2026-09-23T14:00:00.000Z'], ['2026-10-31T23:00:00.000Z', '2026-11-01T15:00:00.000Z'], ['2027-03-13T23:00:00.000Z', '2027-03-14T14:00:00.000Z'], ['2026-11-01T05:00:00.000Z', '2026-11-01T15:00:00.000Z']];
test('the due time is dueMinutes later, moved to the next Denver send-window opening, and only for an enabled policy', () => {
  const enabled = policy({}, { ownerId: 'Zoe.Synthetic' });
  for (const [from, due] of VECTORS) {
    assert.equal(followupDueAt(enabled, from), due, from);
    assert.equal(followupDueAt(enabled, new Date(from)), due, 'Date input');
  }
  assert.equal(followupDueAt(enabled, '2026-09-22T09:00:00-06:00'), '2026-09-22T19:00:00.000Z', 'offset input is an instant');
  const quick = policy({}, { ownerId: 'Zoe.Synthetic', dueMinutes: 15, sendWindow: { startHour: 9, endHour: 17 } });
  assert.equal(followupDueAt(quick, '2026-09-22T16:30:00.000Z'), '2026-09-22T16:45:00.000Z');
  assert.equal(followupDueAt(quick, '2026-09-22T22:50:00.000Z'), '2026-09-23T15:00:00.000Z', '16:50 + 15 min is 17:05 Denver, after the window');
  for (const from of ['2026-09-22', 'not a time', '', null, new Date(Number.NaN)]) assert.equal(followupDueAt(enabled, from), null);
  assert.equal(followupDueAt(policy({}), VECTORS[0][0]), null, 'a blocked policy has no due time');
  assert.equal(followupDueAt({ ...enabled, dueMinutes: 5 }, VECTORS[0][0]), null);
});

test('owner-only settings writes: same-origin, owner session, audit in the same commit, replay and idempotency', async t => {
  const fire = vaultFirestore(t); await seedStaff();
  const first = await call('GET');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.revision, first.body.settings, first.body.canEdit, first.body.policyEnabled, first.body.staffMembers], ['', null, true, false, true]);
  assert.deepEqual(first.body.followup, { enabled: false, ownerId: null, ownerRole: null, ownerSource: 'unresolved', dueMinutes: 240, dueSource: 'default', sendWindow: window, blockedReason: 'followup_owner_unresolved' });
  assert.deepEqual(first.body.candidates, [{ id: 'ZacB', name: 'Synthetic Owner', role: 'owner', businessAccess: true }, { id: 'TylerG', name: 'Synthetic Manager', role: 'manager', businessAccess: true },
    { id: 'Zoe.Synthetic', name: 'Synthetic Zoe.Synthetic', role: 'sales', businessAccess: false }, { id: 'Phone.Person', name: 'Synthetic Phone.Person', role: 'phone', businessAccess: false }], 'AlexK (crew_lead) and crew or rejected accounts are not candidates');
  for (const secret of ['47.25', 'hourlyRate', 'canary', 'example.invalid', '9705550142', 'password', 'sealed']) assert.equal(JSON.stringify(first.body).includes(secret), false, secret);

  const body = input({ ownerId: 'zoe.synthetic', reason: 'Zoe takes walkthrough follow-ups' });
  const commits = fire.commits.length, created = await call('POST', body);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(fire.commits.length, commits + 1);
  const doc = saved(fire);
  assert.deepEqual({ ...doc, fingerprint: typeof doc.fingerprint }, { ownerId: 'Zoe.Synthetic', dueMinutes: 240, sendWindow: window, updatedBy: 'zacb', updatedAt: NOW, requestId: body.requestId, fingerprint: 'string', version: 1, revision: doc.revision });
  assert.equal(fire.commits.at(-1)[0].currentDocument.exists, false, 'the first save is create-only');
  assert.deepEqual([created.body.revision, created.body.requestId, created.body.followup.ownerId, created.body.followup.ownerSource, created.body.settings.updatedBy], [doc.revision, body.requestId, 'Zoe.Synthetic', 'settings', 'zacb']);
  const [entry] = audits(fire);
  assert.equal(fire.commits.at(-1)[1].update.name, `${ROOT}/${entry.id}`, 'the audit entry joins the settings commit');
  assert.deepEqual([entry.action, entry.actor.id, entry.actor.role, entry.via, entry.entityKey, entry.requestId, entry.reason, entry.visibility, JSON.parse(entry.before ?? 'null'), JSON.parse(entry.after)],
    ['operations_settings.followups.update', 'zacb', 'owner', 'hub', 'operations_settings/followups', body.requestId, 'Zoe takes walkthrough follow-ups', 'business', null, { ownerId: 'Zoe.Synthetic', dueMinutes: 240, sendWindow: window }]);

  const replay = await call('POST', body);
  assert.deepEqual([replay.status, replay.body.replayed, fire.commits.length, audits(fire).length], [200, true, commits + 1, 1], 'the same request replays without a second write or audit entry');
  const conflict = await call('POST', { ...body, dueMinutes: 60 });
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'followup_settings_idempotency_conflict']);

  const update = input({ expectedRevision: doc.revision, ownerId: null, dueMinutes: 90, sendWindow: { startHour: 9, endHour: 18, timeZone: 'America/Denver' } });
  const changed = await call('POST', update, { extraEnv: { ...STAFF, EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.followup, { enabled: true, ownerId: 'Phone.Person', ownerRole: 'phone', ownerSource: 'env', dueMinutes: 90, dueSource: 'settings', sendWindow: { startHour: 9, endHour: 18, timeZone: 'America/Denver' }, blockedReason: null });
  assert.equal(fire.commits.at(-1)[0].currentDocument.updateTime, doc.revision, 'updates carry the updateTime precondition');
  assert.deepEqual(JSON.parse(audits(fire).find(item => item.requestId === update.requestId).before), { ownerId: 'Zoe.Synthetic', dueMinutes: 240, sendWindow: window });
  const same = await call('POST', { ...update, requestId: crypto.randomUUID(), expectedRevision: saved(fire).revision });
  assert.deepEqual([same.status, same.body.unchanged, audits(fire).length], [200, true, 2], 'an identical save writes nothing');
});

test('non-owners, other sites and malformed requests are refused before any settings write', async t => {
  const fire = vaultFirestore(t); await seedStaff();
  const writes = () => fire.writes().length;
  const before = writes();
  for (const [user, status, code] of [['TylerG', 403, 'followup_settings_forbidden'], ['AlexK', 403, 'followup_settings_forbidden'], ['Crew.Static', 403, 'followup_settings_forbidden'], ['', 401, 'followup_settings_sign_in_required']]) {
    const result = await call('POST', input(), { user });
    assert.deepEqual([result.status, result.body.code], [status, code], user);
  }
  assert.deepEqual([(await call('GET', undefined, { user: 'TylerG' })).status, (await call('GET', undefined, { user: 'TylerG' })).body.canEdit], [200, false], 'managers can read the policy');
  assert.equal((await call('GET', undefined, { user: 'Crew.Static' })).status, 403);
  assert.equal((await call('GET', undefined, { user: '' })).status, 401);
  for (const headers of [{ Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null' }]) {
    const result = await call('POST', input(), { headers });
    assert.deepEqual([result.status, result.body.code], [403, 'followup_settings_origin_forbidden'], JSON.stringify(headers));
  }
  const requests = fire.requests.length;
  assert.equal((await call('POST', input(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('POST', JSON.stringify(input({ reason: 'x'.repeat(5000) })))).status, 413);
  assert.equal((await call('POST', '{"requestId":')).body.code, 'followup_settings_json_invalid');
  assert.equal(fire.requests.length, requests, 'refused before reading storage');
  for (const bad of [{ extra: true }, { requestId: 'not-a-uuid' }, { expectedRevision: null }, { ownerId: 7 }, { ownerId: '' }, { dueMinutes: 5 }, { dueMinutes: 10081 }, { dueMinutes: '240' }, { sendWindow: { startHour: 7, endHour: 19 } }, { sendWindow: { startHour: 8, endHour: 22 } }, { sendWindow: { startHour: 8, endHour: 19, timeZone: 'UTC' } }, { reason: 7 }]) {
    const result = await call('POST', input(bad));
    assert.deepEqual([result.status, result.body.code], [400, 'followup_settings_invalid'], JSON.stringify(bad));
  }
  for (const ownerId of ['Nobody.Here', 'Crew.Static', 'Crew.Account', 'Former.Sales', 'AlexK']) {
    const result = await call('POST', input({ ownerId }));
    assert.deepEqual([result.status, result.body.code], [409, 'followup_settings_owner_ineligible'], ownerId);
  }
  const noStaff = await call('POST', input(), { extraEnv: {} });
  assert.deepEqual([noStaff.status, noStaff.body.code], [409, 'followup_settings_owner_ineligible'], 'employee accounts are assignable only with EGC_OPERATIONS_STAFF_MEMBERS');
  assert.equal(writes(), before);
  assert.equal(fire.documents.has(SETTINGS), false);
});

test('a stale expectedRevision or updateTime is a 409 conflict; lost and failed replies recover through the same request', async t => {
  const fire = vaultFirestore(t); await seedStaff();
  const created = await call('POST', input());
  const revision = created.body.revision;
  const stale = await call('POST', input({ expectedRevision: '2026-01-01T00:00:00.000000Z', dueMinutes: 60 }));
  assert.deepEqual([stale.status, stale.body.code, stale.body.details], [409, 'followup_settings_revision_conflict', { currentRevision: revision }]);
  const create = await call('POST', input({ expectedRevision: '', dueMinutes: 60 }));
  assert.deepEqual([create.status, create.body.code], [409, 'followup_settings_revision_conflict'], 'a second create is a conflict');

  // Another save lands between the read and the commit: Firestore refuses the stale updateTime (400 FAILED_PRECONDITION).
  fire.hooks.beforeCommit = () => { const doc = fire.documents.get(SETTINGS); fire.documents.set(SETTINGS, { ...doc, updateTime: '2026-09-22T12:59:59.000001Z' }); };
  const racing = await call('POST', input({ expectedRevision: revision, dueMinutes: 60 }));
  assert.deepEqual([racing.status, racing.body.code], [409, 'followup_settings_revision_conflict']);
  assert.equal(saved(fire).dueMinutes, 240, 'nothing partial was applied');
  const latest = saved(fire).revision, auditCount = audits(fire).length;

  fire.hooks.loseCommitReply = true;
  const lost = input({ expectedRevision: latest, dueMinutes: 120 });
  const recovered = await call('POST', lost);
  assert.deepEqual([recovered.status, recovered.body.followup.dueMinutes, recovered.body.requestId], [200, 120, lost.requestId], 'a lost reply is recovered from the saved request id');
  assert.equal(audits(fire).length, auditCount + 1);

  fire.hooks.commitStatus = 503;
  const failed = input({ expectedRevision: saved(fire).revision, dueMinutes: 180 });
  const unknown = await call('POST', failed);
  assert.deepEqual([unknown.status, unknown.body.code], [503, 'followup_settings_outcome_unknown']);
  const retried = await call('POST', failed);
  assert.deepEqual([retried.status, retried.body.followup.dueMinutes, audits(fire).length], [200, 180, auditCount + 2], 'the retry with the same request id applies once');
});

test('the settings storage maps Firestore precondition failures to revision conflicts and everything else to outcome unknown', async () => {
  const answer = (status, body) => followupSettingsStorage({}, async () => Response.json(body, { status })).commit([{ collection: 'operations_settings', id: 'followups', revision: 'r1', patch: { dueMinutes: 60 } }]);
  for (const [status, body] of [[400, { error: { status: 'FAILED_PRECONDITION' } }], [409, { error: { status: 'ALREADY_EXISTS' } }], [412, {}]]) await assert.rejects(answer(status, body), error => error.code === 'followup_settings_revision_conflict' && error.status === 409, String(status));
  for (const [status, body] of [[400, { error: { status: 'INVALID_ARGUMENT' } }], [500, {}], [503, { error: { status: 'UNAVAILABLE' } }]]) await assert.rejects(answer(status, body), error => error.code === 'followup_settings_outcome_unknown' && error.status === 503, String(status));
  await assert.rejects(followupSettingsStorage({}, async () => { throw new TypeError('synthetic network'); }).commit([]), error => error.code === 'followup_settings_outcome_unknown');
  await assert.rejects(followupSettingsStorage({}, async () => Response.json({}, { status: 503 })).read(), error => error.code === 'followup_settings_storage_unavailable');
  let sent;
  await followupSettingsStorage({}, async (_env, url, options) => { sent = { url, body: JSON.parse(options.body) }; return Response.json({ writeResults: [{ updateTime: 'r2' }] }); }).commit([{ collection: 'operations_settings', id: 'followups', patch: { ownerId: null } }]);
  assert.match(sent.url, /documents:commit$/);
  assert.deepEqual(sent.body.writes[0], { update: { name: `${ROOT}/operations_settings/followups`, fields: { ownerId: { nullValue: null } } }, updateMask: { fieldPaths: ['ownerId'] }, currentDocument: { exists: false } });
});

test('portal.rules keeps the inbound policy unchanged and adds the follow-up policy only with EGC_OPERATIONS_FOLLOWUP_POLICY_ENABLED', async t => {
  const fire = vaultFirestore(t); await seedStaff();
  writeSettings(fire, { ownerId: 'Zoe.Synthetic', dueMinutes: 120, sendWindow: window, updatedBy: 'zacb', updatedAt: NOW });
  const inboundOnly = async extra => { const roster = await operationsRoster({ ...env, ...extra }); return { ok: true, ...inboundResponsePolicy({ ...env, ...extra }, roster.members.map(({ id, role, staffRoles }) => staffRoles ? { id, role, staffRoles } : { id, role })) }; };
  for (const extra of [{}, STAFF, { ...STAFF, EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }, { EGC_OPERATIONS_FOLLOWUP_POLICY_ENABLED: 'TRUE' }]) {
    const reads = fire.requests.filter(request => request.url.pathname.includes('/operations_settings/')).length;
    const off = await rpc(extra, { command: 'portal.rules' });
    assert.equal(off.text, JSON.stringify(await inboundOnly(extra)), JSON.stringify(extra));
    assert.equal(fire.requests.filter(request => request.url.pathname.includes('/operations_settings/')).length, reads, 'the flag-off path never reads the settings');
  }
  const on = { ...STAFF, EGC_OPERATIONS_FOLLOWUP_POLICY_ENABLED: 'true', EGC_OPERATIONS_FOLLOWUP_OWNER_ID: 'Phone.Person' };
  const rules = await rpc(on, { command: 'portal.rules' }), body = JSON.parse(rules.text);
  assert.equal(rules.status, 200);
  assert.deepEqual(Object.keys(body), ['ok', 'authority', 'version', 'inboundResponse', 'followup']);
  assert.deepEqual({ ...body, followup: undefined }, { ...(await inboundOnly(on)), followup: undefined }, 'the inbound reply rule is byte-for-byte what it was');
  assert.deepEqual(body.followup, { enabled: true, ownerId: 'Zoe.Synthetic', ownerRole: 'sales', ownerSource: 'settings', dueMinutes: 120, dueSource: 'settings', sendWindow: window, blockedReason: null });

  writeSettings(fire, { ownerId: 'Former.Sales', dueMinutes: 120, sendWindow: window });
  assert.deepEqual(JSON.parse((await rpc(on, { command: 'portal.rules' })).text).followup, { enabled: false, ownerId: null, ownerRole: null, ownerSource: 'settings', dueMinutes: 120, dueSource: 'settings', sendWindow: window, blockedReason: 'followup_owner_inactive' });
  writeSettings(fire, { ownerId: 'Zoe.Synthetic', dueMinutes: 120, sendWindow: window });
  assert.equal(JSON.parse((await rpc({ ...on, EGC_OPERATIONS_STAFF_MEMBERS: 'false' }, { command: 'portal.rules' })).text).followup.blockedReason, 'followup_owner_unknown', 'without staff members the account is not assignable');
  fire.documents.delete(SETTINGS);
  assert.equal(JSON.parse((await rpc(on, { command: 'portal.rules' })).text).followup.ownerId, 'Phone.Person', 'no settings record: the env owner');

  // A settings record without a verifiable identity cannot be read; only the follow-up policy is blocked.
  fire.documents.set(SETTINGS, { name: `${ROOT}/operations_settings/other`, fields: encodeFirestoreFields({ ownerId: 'Zoe.Synthetic' }), updateTime: '2026-09-21T12:00:00.000001Z' });
  const unreadable = JSON.parse((await rpc(on, { command: 'portal.rules' })).text);
  assert.equal(unreadable.followup.blockedReason, 'followup_settings_unavailable');
  assert.deepEqual(unreadable.inboundResponse, (await inboundOnly(on)).inboundResponse);
});

test('portal.members and the Action Center owners include active sales and phone staff tagged businessAccess:false, never pay or sealed fields', async t => {
  vaultFirestore(t); await seedStaff();
  const members = await rpc(STAFF, { command: 'portal.members' });
  const listed = JSON.parse(members.text).members;
  assert.deepEqual(listed.find(member => member.id === 'Zoe.Synthetic'), { id: 'Zoe.Synthetic', name: 'Synthetic Zoe.Synthetic', role: 'sales', staffRoles: ['sales'], businessAccess: false });
  assert.deepEqual(listed.filter(member => member.businessAccess === false).map(member => member.id), ['Zoe.Synthetic', 'Phone.Person']);
  assert.ok(listed.filter(member => member.businessAccess !== false).every(member => ['ZacB', 'TylerG', 'AlexK'].includes(member.id) && !('businessAccess' in member)), 'business members keep their shape');
  const roster = await operationsRoster({ ...env, ...STAFF });
  assert.deepEqual(roster.others, [{ id: 'Crew.Static', active: true }, { id: 'Former.Sales', active: false }, { id: 'Crew.Account', active: true }], 'known identities that cannot take work keep only id and status');

  const request = new Request(`${ORIGIN}/api/operations`, { headers: { Cookie: await cookieFor({ ...env, ...STAFF }, 'TylerG') } });
  const owners = (await (await operationsGet({ request, env: { ...env, ...STAFF } })).json()).owners;
  assert.deepEqual(owners, [{ id: 'ZacB', name: 'Synthetic Owner', role: 'owner' }, { id: 'TylerG', name: 'Synthetic Manager', role: 'manager' }, { id: 'AlexK', name: 'Synthetic Business Lead', role: 'crew_lead' },
    { id: 'Zoe.Synthetic', name: 'Synthetic Zoe.Synthetic', role: 'sales', businessAccess: false }, { id: 'Phone.Person', name: 'Synthetic Phone.Person', role: 'phone', businessAccess: false }]);
  const legacy = (await (await operationsGet({ request: new Request(`${ORIGIN}/api/operations`, { headers: { Cookie: await cookieFor(env, 'TylerG') } }), env })).json()).owners;
  assert.deepEqual(legacy, owners.slice(0, 3), 'without the flag the owners stay the business users');
  for (const text of [members.text, JSON.stringify(owners), JSON.stringify(roster)]) {
    for (const secret of ['47.25', 'hourlyRate', 'payType', 'canary', 'example.invalid', '9705550142', 'password', 'sealed', 'sessionVersion', 'invitation']) assert.equal(text.includes(secret), false, secret);
  }
});

test('the follow-up owner screen is a registered SYSTEM screen that only the owner can open', () => {
  const owner = hubPage(), entry = owner.context.EGCHubScreens.get('followup_settings');
  assert.deepEqual({ group: entry.group, label: entry.label, capability: entry.capability, crewVisible: entry.crewVisible, module: entry.module, load: { ...entry.load } },
    { group: 'SYSTEM', label: 'Follow-up owner', capability: 'owner', crewVisible: false, module: 'EGCFollowupSettings', load: { js: 'employee-followup-settings.js', css: 'employee-followup-settings.css', v: entry.load.v } });
  for (const file of [entry.load.js, entry.load.css]) assert.ok(existsSync(new URL('../' + file, import.meta.url)), file);
  assert.equal(owner.api.canView('followup_settings'), true);
  for (const who of [{ user: 'AlexK', business: true, role: 'manager' }, { user: 'ZacB', business: false, role: 'owner', owner: true }, { user: 'Synthetic.Crew', business: false, role: 'crew' }]) assert.equal(hubPage(who).api.canView('followup_settings'), false, JSON.stringify(who));
});

// A configured phone user whose only obstacle is EGC_OPERATIONS_STAFF_MEMBERS being off.
const PHONE_USER = { 'Pat.Phone': { passwordHash: 'unused-synthetic-phone-hash', role: 'crew', displayName: 'Synthetic Pat Phone', staffRoles: ['phone'] } };

test('with staff members off, a configured sales or phone user is reported as staff-disabled, not ineligible', async t => {
  const fire = vaultFirestore(t); await seedStaff();
  const phoneEnv = staffEnv({}, PHONE_USER), before = fire.requests.length;
  const roster = await operationsRoster(phoneEnv);
  assert.equal(fire.requests.length, before, 'with the flag off no employee account is read');
  assert.deepEqual(roster.others, [{ id: 'Crew.Static', active: true }, { id: 'Pat.Phone', active: true, staffOnly: true }]);
  assert.deepEqual(roster.members.map(member => member.id), ['ZacB', 'TylerG', 'AlexK'], 'the member list is unchanged');
  assert.deepEqual((await operationsRoster({ ...phoneEnv, ...STAFF })).members.find(member => member.id === 'Pat.Phone'), { id: 'Pat.Phone', name: 'Synthetic Pat Phone', role: 'phone', staffRoles: ['phone'], businessAccess: false }, 'the flag makes the same user a member');
  const all = [...roster.members, ...roster.others];
  assert.deepEqual([policy({}, { ownerId: 'pat.phone' }, all).blockedReason, policy({}, { ownerId: 'pat.phone' }, all).ownerSource], ['followup_owner_staff_disabled', 'settings']);
  assert.equal(policy({ EGC_OPERATIONS_FOLLOWUP_OWNER_ID: 'Pat.Phone' }, null, all).blockedReason, 'followup_owner_staff_disabled');
  assert.equal(policy({}, { ownerId: 'Crew.Static' }, all).blockedReason, 'followup_owner_ineligible', 'a crew user without sales or phone is still ineligible');
  assert.equal(policy({}, { ownerId: 'Pat.Phone' }, [...all.filter(member => member.id !== 'Pat.Phone'), { id: 'Pat.Phone', active: false }]).blockedReason, 'followup_owner_inactive');

  const handlers = followupSettingsHandlers({ now: () => new Date(NOW) }), cookie = await cookieFor(phoneEnv, 'ZacB');
  const post = await handlers.post({ request: jsonRequest('/api/operations-followup-settings', input({ ownerId: 'pat.phone' }), cookie), env: phoneEnv });
  assert.deepEqual([post.status, (await post.json()).code], [409, 'followup_settings_owner_staff_disabled']);
  assert.equal(fire.documents.has(SETTINGS), false);
  writeSettings(fire, { ownerId: 'Pat.Phone', dueMinutes: 120, sendWindow: window });
  const read = await (await handlers.get({ request: jsonRequest('/api/operations-followup-settings', undefined, cookie), env: phoneEnv })).json();
  assert.deepEqual([read.staffMembers, read.followup.enabled, read.followup.blockedReason, read.candidates.some(candidate => candidate.id === 'Pat.Phone')], [false, false, 'followup_owner_staff_disabled', false]);
  const on = JSON.parse((await rpc({ ...STAFF, EGC_OPERATIONS_FOLLOWUP_POLICY_ENABLED: 'true', HUB_AUTH_USERS_JSON: phoneEnv.HUB_AUTH_USERS_JSON }, { command: 'portal.rules' })).text);
  assert.deepEqual([on.followup.enabled, on.followup.ownerId, on.followup.ownerRole], [true, 'Pat.Phone', 'phone'], 'turning the flag on resolves the same owner');
});

test('the Action Center identity load keeps the business owners when the staff roster cannot be read or is ambiguous', async t => {
  const business = [{ id: 'ZacB', name: 'Synthetic Owner', role: 'owner' }, { id: 'TylerG', name: 'Synthetic Manager', role: 'manager' }, { id: 'AlexK', name: 'Synthetic Business Lead', role: 'crew_lead' }];
  const staffEnvOn = { ...env, ...STAFF };
  assert.deepEqual(await actionCenterOwners(env, async () => { throw new Error('the flag-off path never reads staff'); }), { owners: business });
  for (const [error, code] of [[Object.assign(new Error('portal_source_unavailable'), { status: 503 }), 'portal_source_unavailable'], [Object.assign(new Error('portal_members_ambiguous'), { status: 409 }), 'portal_members_ambiguous'], [new TypeError('synthetic private detail'), 'portal_source_unavailable']]) {
    const result = await actionCenterOwners(staffEnvOn, async () => { throw error; });
    assert.deepEqual(result, { owners: business, staffOwners: { available: false, code } }, code);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }

  // The real endpoint: every Firestore read fails, so the encrypted employee accounts cannot be listed.
  t.mock.method(globalThis, 'fetch', async input => { assert.equal(new URL(input).hostname, 'firestore.googleapis.com'); return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 }); });
  const request = new Request(`${ORIGIN}/api/operations`, { headers: { Cookie: await cookieFor(staffEnvOn, 'TylerG') } });
  const response = await operationsGet({ request, env: staffEnvOn }), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual([body.ok, body.actor.id, body.owners, body.staffOwners], [true, 'TylerG', business, { available: false, code: 'portal_source_unavailable' }]);
  assert.ok(globalThis.fetch.mock.calls.length > 0, 'the staff roster was attempted');
});

test('the Action Center identity load reports ambiguous staff identities and a readable roster explicitly', async t => {
  vaultFirestore(t); await seedStaff();
  const staffEnvOn = { ...env, ...STAFF }, cookie = await cookieFor(staffEnvOn, 'TylerG');
  const load = async () => (await operationsGet({ request: new Request(`${ORIGIN}/api/operations`, { headers: { Cookie: cookie } }), env: staffEnvOn })).json();
  const ok = await load();
  assert.deepEqual([ok.staffOwners, ok.owners.filter(owner => owner.businessAccess === false).map(owner => owner.id)], [{ available: true }, ['Zoe.Synthetic', 'Phone.Person']]);
  assert.equal('staffOwners' in (await (await operationsGet({ request: new Request(`${ORIGIN}/api/operations`, { headers: { Cookie: await cookieFor(env, 'TylerG') } }), env })).json()), false, 'the flag-off shape is unchanged');
  await seedAccount(env, 'tylerg', { extra: { staffRoles: ['sales'] } });
  const ambiguous = await load();
  assert.deepEqual([ambiguous.ok, ambiguous.owners.map(owner => owner.id), ambiguous.staffOwners], [true, ['ZacB', 'TylerG', 'AlexK'], { available: false, code: 'portal_members_ambiguous' }]);
});

test('the Action Center still loads its queue and names why staff owners are missing', async () => {
  const source = readFileSync(new URL('../employee-operations.js', import.meta.url), 'utf8');
  async function mount(staffOwners) {
    const document = createDocument(), host = document.createElement('main'), commands = [];
    document.body.append(host);
    const identity = { ok: true, enabled: true, actor: { id: 'TylerG', role: 'manager', kind: 'human' }, owners: [{ id: 'ZacB', name: 'Synthetic Owner', role: 'owner' }, { id: 'TylerG', name: 'Synthetic Manager', role: 'manager' }], ...(staffOwners ? { staffOwners } : {}), timeZone: 'America/Denver' };
    const fetch = async (url, init = {}) => {
      if (!init.method) return Response.json(identity);
      commands.push(JSON.parse(init.body).body.command);
      return Response.json({ ok: true, items: [], total: 0, nextOffset: null, coverage: { registeredTasks: 'complete' } });
    };
    const context = { document, Node: document.Node, fetch, AbortController, crypto, Intl, URL, console, Date: FixedDate, setTimeout, clearTimeout, sessionStorage: storage(), localStorage: storage(), addEventListener() {} };
    context.window = context;
    vm.runInNewContext(source, context, { filename: 'employee-operations.js' });
    await context.EGCActionCenter.mount(host);
    const root = host.querySelector('#egc-action-center'), kids = root.children, toolbar = kids.findIndex(kid => kid.classList.contains('ac-toolbar'));
    return { commands, notice: kids[toolbar + 1]?.classList.contains('warning') ? kids[toolbar + 1].textContent : null, owners: host.querySelector('[data-ac-owner]').querySelectorAll('option').map(option => option.value), content: host.querySelector('[data-ac-content]').textContent };
  }
  const unread = await mount({ available: false, code: 'portal_source_unavailable' });
  assert.match(unread.notice, /Sales and phone staff could not be loaded, so only business users can be assigned/);
  assert.ok(unread.commands.length && unread.commands.every(command => command === 'queue'), 'the queue and its counts still load');
  assert.deepEqual(unread.owners, ['', 'ZacB', 'TylerG'], 'the business owners stay assignable');
  assert.match(unread.content, /No registered actions in this view/);
  assert.match((await mount({ available: false, code: 'portal_members_ambiguous' })).notice, /differ only by letter case/);
  for (const staffOwners of [undefined, { available: true }]) assert.equal((await mount(staffOwners)).notice, null, JSON.stringify(staffOwners));
});
