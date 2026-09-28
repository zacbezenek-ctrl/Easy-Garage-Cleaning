import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStaffDirectoryService, effectivePayRate, profileHourlyRate, normalizeWeeklyAvailability, storedPayRates, legacyPersonKeys, legacyPayLocked, legacyProfileInput, legacyProfileView, mirrorLegacyPay, DIRECTORY_PROFILE_FIELDS, LEGACY_EFFECTIVE_FROM, WEEK_DAYS } from '../functions/_lib/staff-directory.js';
import { SKILL_CATALOG, storedSkills } from '../functions/_lib/staff-skills.js';
import { namedStaffRole } from '../functions/_lib/staff-invitation-service.js';
import { listAudit } from '../functions/_lib/hub-audit.js';
import { listHubUserProfiles } from '../functions/_lib/hub-session.js';
import { opaqueId, open, readCollectionRecords, writeOne } from '../functions/_lib/employee-vault.js';
import { employeeInvitationStore } from '../functions/_lib/employee-accounts.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { staffDirectoryHandlers } from '../functions/api/staff-directory.js';
import * as employeeHub from '../functions/api/employee-hub.js';
import { vaultFirestore, staffEnv, cookieFor, seedAccount, login, jsonRequest } from './helpers/vault-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z';
const clock = (iso = NOW) => () => new Date(iso);
const env = staffEnv();
const people = Object.fromEntries(listHubUserProfiles(env).map(profile => [profile.user, profile]));
const employee = (user, extra = {}) => ({ user, displayName: `Synthetic ${user}`, role: 'crew', payType: 'hourly', hourlyRate: 21, businessAccess: false, source: 'employee-account', ...extra });
const account = (username, extra = {}) => ({ username, displayName: `Synthetic ${username}`, status: 'approved', role: 'crew', payType: 'hourly', hourlyRate: 21, businessAccess: false, passwordHash: 'synthetic-hash', passwordSalt: 'synthetic-salt', sessionVersion: `v-${username}`, ...extra });
const week = { mon: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }], wed: [{ start: '09:00', end: '24:00' }] };

// In-memory store with the storage contract's precondition semantics: every profile
// and account carries a revision, commits compare them and receipts are create-only.
function memory({ accounts = [], profiles = [] } = {}) {
  let revision = 0;
  const next = () => `rev-${String(++revision).padStart(4, '0')}`;
  const rows = new Map(profiles.map(data => [data.id, { documentId: `doc_${data.id}`, updateTime: next(), data: structuredClone(data) }]));
  const accountRows = new Map(accounts.map(data => [data.username.toLowerCase(), { account: structuredClone(data), version: next() }]));
  const receipts = new Map(), commits = [], hooks = { beforeCommit: null, lose: false };
  const conflict = () => Object.assign(new Error('changed'), { code: 'staff_directory_revision_conflict', status: 409 });
  const store = {
    rows, accountRows, receipts, commits, hooks, readOnlyFlag: false,
    configured: () => true,
    readOnly: () => store.readOnlyFlag,
    async staff() {
      return { configured: listHubUserProfiles(env), accounts: [...accountRows.values()].map(({ account: { passwordHash, passwordSalt, invitation, ...safe } }) => ({ ...structuredClone(safe), role: namedStaffRole({ ...safe, invitation }) })) };
    },
    async profiles() { return [...rows.values()].map(row => structuredClone(row)); },
    async readAccount(username) { const row = accountRows.get(username.toLowerCase()); return row ? structuredClone(row) : null; },
    async readReceipt(id) { return structuredClone(receipts.get(id) ?? null); },
    async fingerprint(text) { return createHash('sha256').update(text).digest('hex'); },
    async commit(plan) {
      if (hooks.beforeCommit) { const hook = hooks.beforeCommit; hooks.beforeCommit = null; await hook(); }
      const current = rows.get(plan.profile.id);
      if ((current?.updateTime || '') !== (plan.profile.revision || '')) throw conflict();
      if (plan.account && accountRows.get(plan.account.account.username.toLowerCase())?.version !== plan.account.version) throw conflict();
      if (receipts.has(plan.receipt.id)) throw conflict();
      const updateTime = next();
      rows.set(plan.profile.id, { documentId: current?.documentId || `doc_${plan.profile.id}`, updateTime, data: structuredClone(plan.profile.data) });
      if (plan.account) accountRows.set(plan.account.account.username.toLowerCase(), { account: structuredClone(plan.account.account), version: updateTime });
      receipts.set(plan.receipt.id, { ...structuredClone(plan.receipt.data), id: plan.receipt.id, revision: updateTime });
      commits.push(structuredClone(plan));
      if (hooks.lose) { hooks.lose = false; throw Object.assign(new Error('lost'), { code: 'staff_directory_outcome_unknown', status: 503 }); }
      return { profileRevision: updateTime };
    },
  };
  return store;
}
const service = (store, iso = NOW, extraEnv = {}) => createStaffDirectoryService({ store, env: { ...env, ...extraEnv }, now: clock(iso) });
const change = (username, revision, fields) => ({ requestId: crypto.randomUUID(), username, expectedRevision: revision, ...fields });
const rejects = (promise, code, status) => assert.rejects(promise, error => error.code === code && error.status === status);
const personOf = (result, username) => result.people.find(person => person.username === username);

test('crew see only their own record and cannot read others\' pay or change roles, pay or skills', async () => {
  const store = memory({ accounts: [account('Crew.One'), account('Crew.Two', { hourlyRate: 24 })], profiles: [{ id: 'crew.two', username: 'Crew.Two', hourlyRate: 24 }] });
  const crew = employee('Crew.One'), directory = service(store);
  const own = await directory.list(crew);
  assert.deepEqual(own.people.map(person => person.username), ['Crew.One']);
  assert.equal(own.people[0].pay.current.hourlyRate, 21, 'crew see their own rate');
  await rejects(directory.list(crew, { username: 'Crew.Two' }), 'staff_directory_forbidden', 403);
  const revision = store.rows.get('crew.two').updateTime;
  for (const input of [{ action: 'set_roles', staffRoles: ['manager'] }, { action: 'set_pay', effectiveFrom: '2026-10-01', hourlyRate: 99 }, { action: 'set_skills', skills: [] }, { action: 'set_availability', weeklyAvailability: week }]) {
    await rejects(directory.mutate(crew, change('Crew.Two', revision, input)), 'staff_directory_forbidden', 403);
  }
  // A manager without pay.manage sees the roster but no pay and no pay history.
  const managerView = await directory.list(people.TylerG);
  assert.deepEqual(managerView.people.map(person => person.username).sort(), ['AlexK', 'Crew.One', 'Crew.Static', 'Crew.Two', 'TylerG', 'ZacB']);
  assert.ok(managerView.people.filter(person => person.username !== 'TylerG').every(person => person.pay === undefined));
  assert.ok(personOf(managerView, 'TylerG').pay, 'a manager sees their own pay');
  await rejects(directory.mutate(people.TylerG, change('Crew.Two', revision, { action: 'set_pay', effectiveFrom: '2026-10-01', hourlyRate: 25 })), 'staff_directory_forbidden', 403);
  const ownerView = await directory.list(people.ZacB);
  assert.equal(personOf(ownerView, 'Crew.Two').pay.current.hourlyRate, 24);
  assert.equal(store.commits.length, 0);
  await rejects(directory.list(null), 'staff_directory_sign_in_required', 401);
});

test('manager edits append audited history with actor, injected time, reason and before/after', async () => {
  const store = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'crew.one', username: 'Crew.One', hourlyRate: 21, skills: [{ id: 'cleanout', level: 'trainee', verifiedBy: 'ZacB', verifiedAt: '2026-01-02T00:00:00.000Z' }] }] });
  const directory = service(store, '2026-09-23T15:30:00.000Z');
  let revision = store.rows.get('crew.one').updateTime;
  const skills = await directory.mutate(people.TylerG, change('Crew.One', revision, { action: 'set_skills', reason: 'Synthetic shadow shift', skills: [{ id: 'cleanout', level: 'trainee' }, { id: 'pressure_wash', level: 'proficient' }] }));
  assert.equal(skills.ok, true);
  assert.deepEqual(skills.person.skills, [
    { id: 'cleanout', level: 'trainee', verifiedBy: 'ZacB', verifiedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'pressure_wash', level: 'proficient', verifiedBy: 'TylerG', verifiedAt: '2026-09-23T15:30:00.000Z' },
  ]);
  const entry = store.rows.get('crew.one').data.history.at(-1);
  assert.equal(entry.action, 'set_skills'); assert.equal(entry.actor, 'TylerG'); assert.equal(entry.at, '2026-09-23T15:30:00.000Z'); assert.equal(entry.reason, 'Synthetic shadow shift');
  assert.deepEqual(entry.changes.before.skills.map(skill => skill.id), ['cleanout']);
  assert.deepEqual(entry.changes.after.skills.map(skill => skill.id), ['cleanout', 'pressure_wash']);
  revision = skills.person.revision;
  const availability = await directory.mutate(people.TylerG, change('Crew.One', revision, { action: 'set_availability', weeklyAvailability: week }));
  assert.deepEqual(availability.person.weeklyAvailability, { mon: week.mon, tue: [], wed: week.wed, thu: [], fri: [], sat: [], sun: [] });
  const history = store.rows.get('crew.one').data.history;
  assert.deepEqual(history.map(item => item.action), ['set_skills', 'set_availability']);
  assert.equal(history[1].changes.before.weeklyAvailability, null);
  assert.equal(availability.person.history.length, 2);
  const unchanged = await directory.mutate(people.TylerG, change('Crew.One', availability.person.revision, { action: 'set_availability', weeklyAvailability: week }));
  assert.equal(unchanged.unchanged, true); assert.equal(store.commits.length, 2, 'an identical change writes nothing');
});

test('crew can set only their own weekly availability, and invalid windows are refused', async () => {
  const store = memory({ accounts: [account('Crew.One'), account('Crew.Two')] }), directory = service(store), crew = employee('Crew.One');
  const saved = await directory.mutate(crew, change('Crew.One', '', { action: 'set_availability', weeklyAvailability: { fri: [{ start: '07:00', end: '15:30' }] } }));
  assert.deepEqual(saved.person.weeklyAvailability.fri, [{ start: '07:00', end: '15:30' }]);
  assert.equal(store.rows.get('crew.one').data.username, 'Crew.One');
  await rejects(directory.mutate(crew, change('Crew.Two', '', { action: 'set_availability', weeklyAvailability: {} })), 'staff_directory_forbidden', 403);
  for (const weeklyAvailability of [{ funday: [] }, { mon: [{ start: '09:00', end: '08:00' }] }, { mon: [{ start: '08:00', end: '12:00' }, { start: '11:00', end: '13:00' }] }, { mon: [{ start: '8:00', end: '12:00' }] },
    { mon: [{ start: '08:00', end: '12:00', note: 'x' }] }, { mon: Array.from({ length: 5 }, (_, i) => ({ start: `0${i}:00`, end: `0${i}:30` })) }, [], null]) {
    await rejects(directory.mutate(crew, change('Crew.One', saved.person.revision, { action: 'set_availability', weeklyAvailability })), 'staff_directory_invalid_availability', 400);
  }
  assert.deepEqual(Object.keys(normalizeWeeklyAvailability({})), WEEK_DAYS);
});

test('effective-dated pay resolves by Denver calendar date and mirrors hourlyRate for older readers', async () => {
  const store = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'crew.one', username: 'Crew.One', hourlyRate: 21, payType: 'hourly', onboardingCompletedAt: '2026-09-01T00:00:00.000Z' }] });
  const directory = service(store, NOW);
  const saved = await directory.mutate(people.ZacB, change('Crew.One', store.rows.get('crew.one').updateTime, { action: 'set_pay', effectiveFrom: '2026-10-01', hourlyRate: 23.5, reason: 'Synthetic review' }));
  const profile = store.rows.get('crew.one').data;
  assert.deepEqual(profile.payRates.map(({ effectiveFrom, hourlyRate, source }) => ({ effectiveFrom, hourlyRate, source })), [
    { effectiveFrom: LEGACY_EFFECTIVE_FROM, hourlyRate: 21, source: 'legacy_hourly_rate' }, { effectiveFrom: '2026-10-01', hourlyRate: 23.5, source: undefined }]);
  assert.equal(profile.hourlyRate, 21, 'the mirror is today\'s rate, not the future one');
  assert.equal(profile.payRates[1].setBy, 'ZacB'); assert.equal(profile.payRates[1].setAt, NOW); assert.equal(profile.payRates[1].overtimeMultiplier, 1.5);
  assert.deepEqual(saved.person.pay.upcoming.map(rate => rate.effectiveFrom), ['2026-10-01']);
  assert.equal(profile.history.at(-1).scope, 'pay');
  // 05:30Z on Oct 1 is still Sep 30 in Denver; 06:30Z is Oct 1.
  assert.equal(profileHourlyRate(profile, '2026-10-01T05:30:00.000Z'), 21);
  assert.equal(profileHourlyRate(profile, '2026-10-01T06:30:00.000Z'), 23.5);
  assert.equal(effectivePayRate(profile, '2026-10-01').source, 'pay_rates');
  const later = service(store, '2026-10-02T18:00:00.000Z');
  assert.equal(personOf(await later.list(people.ZacB), 'Crew.One').pay.current.hourlyRate, 23.5);
  assert.equal(personOf(await later.list(people.TylerG), 'Crew.One').history.some(item => item.scope === 'pay'), false, 'pay history is hidden without pay.manage');
  await rejects(directory.mutate(people.ZacB, change('Crew.One', saved.person.revision, { action: 'set_pay', effectiveFrom: '2026-09-21', hourlyRate: 30 })), 'staff_directory_invalid_pay', 400);
  for (const hourlyRate of [-1, 23.555, '24', 501, Number.NaN]) await rejects(directory.mutate(people.ZacB, change('Crew.One', saved.person.revision, { action: 'set_pay', effectiveFrom: '2026-10-05', hourlyRate })), 'staff_directory_invalid_pay', 400);
  await rejects(directory.mutate(people.ZacB, change('Crew.One', saved.person.revision, { action: 'set_pay', effectiveFrom: '2026-10-05', hourlyRate: 24, payType: 'commission' })), 'staff_directory_invalid_pay', 400);
  await rejects(directory.mutate(people.ZacB, change('ZacB', '', { action: 'set_pay', effectiveFrom: '2026-10-05', hourlyRate: 24 })), 'staff_directory_configured_account', 409);
  assert.equal(profile.onboardingCompletedAt, '2026-09-01T00:00:00.000Z');
});

test('a legacy profile-form rate edit wins over the schedule, is reported as drift and is kept when pay is next set', async () => {
  const base = { id: 'crew.one', username: 'Crew.One', hourlyRate: 21, payRates: [{ effectiveFrom: LEGACY_EFFECTIVE_FROM, hourlyRate: 21, payType: 'hourly', overtimeMultiplier: 1.5, setBy: 'x', setAt: NOW }, { effectiveFrom: '2026-10-01', hourlyRate: 23, payType: 'hourly', overtimeMultiplier: 1.5, setBy: 'x', setAt: NOW }], payRateMirror: { hourlyRate: 21, effectiveFrom: LEGACY_EFFECTIVE_FROM, at: NOW } };
  assert.equal(effectivePayRate(base, '2026-10-05').hourlyRate, 23, 'the stale mirror is still a produced rate');
  assert.equal(effectivePayRate({ ...base, hourlyRate: 23 }, '2026-10-05').hourlyRate, 23, 'a self-save that stored the new rate is consistent');
  const edited = { ...base, hourlyRate: 26 };
  assert.deepEqual(effectivePayRate(edited, '2026-10-05'), { hourlyRate: 26, payType: 'hourly', overtimeMultiplier: null, effectiveFrom: null, source: 'legacy_profile_edit', drift: true });
  assert.equal(effectivePayRate({ ...base, payRates: [{ effectiveFrom: 'bad' }] }, '2026-10-05').hourlyRate, 21, 'a malformed schedule falls back to the legacy rate');
  assert.equal(storedPayRates([base.payRates[0], base.payRates[0]]), null);
  const store = memory({ accounts: [account('Crew.One')], profiles: [edited] }), directory = service(store, '2026-10-05T18:00:00.000Z');
  const view = personOf(await directory.list(people.ZacB), 'Crew.One');
  assert.equal(view.pay.needsReview, true); assert.equal(view.pay.current.hourlyRate, 26);
  await directory.mutate(people.ZacB, change('Crew.One', view.revision, { action: 'set_pay', effectiveFrom: '2026-11-01', hourlyRate: 27 }));
  const rates = store.rows.get('crew.one').data.payRates;
  assert.deepEqual(rates.map(rate => [rate.effectiveFrom, rate.hourlyRate]), [[LEGACY_EFFECTIVE_FROM, 21], ['2026-10-01', 23], ['2026-10-05', 26], ['2026-11-01', 27]]);
  assert.equal(rates[2].source, 'legacy_profile_edit');
  assert.equal(profileHourlyRate(store.rows.get('crew.one').data, '2026-10-06T18:00:00.000Z'), 26);
});

test('the same requestId replays the saved result, a different payload is a 409 and a later change is reported', async () => {
  const store = memory({ accounts: [account('Crew.One')] }), directory = service(store);
  const input = change('Crew.One', '', { action: 'set_skills', skills: [{ id: 'shelving', level: 'lead' }] });
  const first = await directory.mutate(people.TylerG, input);
  const replay = await directory.mutate(people.TylerG, structuredClone(input));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.person, first.person); assert.equal(store.commits.length, 1);
  await rejects(directory.mutate(people.TylerG, { ...input, skills: [{ id: 'shelving', level: 'trainee' }] }), 'staff_directory_idempotency_conflict', 409);
  await rejects(directory.mutate(people.AlexK, input), 'staff_directory_idempotency_conflict', 409);
  await directory.mutate(people.TylerG, change('Crew.One', first.person.revision, { action: 'set_skills', skills: [] }));
  await rejects(directory.mutate(people.TylerG, input), 'staff_directory_changed_since_operation', 409);
  const receipt = [...store.receipts.values()][0];
  assert.deepEqual(Object.keys(receipt).sort(), ['action', 'actor', 'createdAt', 'fingerprint', 'id', 'kind', 'revision', 'target']);
});

test('stale revisions and racing writers get 409; a lost commit reply is recovered from the receipt', async () => {
  const store = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'crew.one', username: 'Crew.One', hourlyRate: 21 }] }), directory = service(store);
  const revision = store.rows.get('crew.one').updateTime;
  await assert.rejects(directory.mutate(people.TylerG, change('Crew.One', 'rev-stale', { action: 'set_skills', skills: [] })), error => error.code === 'staff_directory_revision_conflict' && error.details.currentRevision === revision);
  store.hooks.beforeCommit = () => { const row = store.rows.get('crew.one'); store.rows.set('crew.one', { ...row, updateTime: 'rev-concurrent', data: { ...row.data, phone: 'Synthetic concurrent edit' } }); };
  await rejects(directory.mutate(people.TylerG, change('Crew.One', revision, { action: 'set_skills', skills: [{ id: 'first_aid', level: 'proficient' }] })), 'staff_directory_revision_conflict', 409);
  assert.equal(store.rows.get('crew.one').data.phone, 'Synthetic concurrent edit', 'the concurrent edit is never clobbered');
  store.hooks.lose = true;
  const input = change('Crew.One', 'rev-concurrent', { action: 'set_skills', skills: [{ id: 'first_aid', level: 'proficient' }] });
  const recovered = await directory.mutate(people.TylerG, input);
  assert.equal(recovered.replayed, true); assert.deepEqual(recovered.person.skills.map(skill => skill.id), ['first_aid']);
  assert.equal((await directory.mutate(people.TylerG, input)).replayed, true);
  assert.equal(store.commits.length, 1);
});

test('read-only recovery mode refuses every change with 503 before touching storage', async () => {
  const store = memory({ accounts: [account('Crew.One')] }), directory = service(store);
  store.readOnlyFlag = true;
  store.readReceipt = async () => { throw new Error('storage must not be read'); };
  await rejects(directory.mutate(people.TylerG, change('Crew.One', '', { action: 'set_skills', skills: [] })), 'staff_directory_recovery_read_only', 503);
  assert.equal(store.commits.length, 0);
  assert.equal((await directory.list(people.TylerG)).ok, true, 'reads still work');
});

test('existing profile fields (onboarding, readiness, unknown) survive every directory change', async () => {
  const saved = { id: 'crew.one', username: 'Crew.One', displayName: 'Synthetic Crew', hourlyRate: 21, onboardingCompletedAt: '2026-09-01T00:00:00.000Z', onboardingAcknowledgements: ['timekeeping', 'safety'],
    emergencyContactPhone: '9705550100', shadowShiftCompletedAt: '2026-09-10T00:00:00.000Z', readyForSoloAt: '2026-09-12T00:00:00.000Z', futureField: { nested: [1, 2] }, lastSeenAt: '2026-09-21T00:00:00.000Z' };
  const store = memory({ accounts: [account('Crew.One')], profiles: [saved] }), directory = service(store);
  let revision = store.rows.get('crew.one').updateTime;
  for (const [actor, input] of [[people.TylerG, { action: 'set_skills', skills: [{ id: 'cleanout', level: 'lead' }] }], [people.TylerG, { action: 'set_availability', weeklyAvailability: week }],
    [people.ZacB, { action: 'set_pay', effectiveFrom: '2026-10-01', hourlyRate: 22 }], [people.ZacB, { action: 'set_roles', staffRoles: ['crew_lead', 'crew'] }]]) {
    revision = (await directory.mutate(actor, change('Crew.One', revision, input))).person.revision;
  }
  const data = store.rows.get('crew.one').data;
  for (const [field, value] of Object.entries(saved)) assert.deepEqual(data[field], value, field);
  assert.deepEqual(data.staffRoles, ['crew_lead', 'crew']);
  assert.deepEqual(store.accountRows.get('crew.one').account.staffRoles, ['crew_lead', 'crew']);
  assert.equal(store.accountRows.get('crew.one').account.passwordHash, 'synthetic-hash');
  assert.deepEqual(data.history.map(entry => entry.action), ['set_skills', 'set_availability', 'set_pay', 'set_roles']);
});

test('role changes are limited to approved employee accounts and known non-owner roles', async () => {
  const store = memory({ accounts: [account('Crew.One'), account('Pending.One', { status: 'pending' })] }), directory = service(store);
  await rejects(directory.mutate(people.ZacB, change('TylerG', '', { action: 'set_roles', staffRoles: ['crew'] })), 'staff_directory_configured_account', 409);
  await rejects(directory.mutate(people.ZacB, change('Pending.One', '', { action: 'set_roles', staffRoles: ['crew'] })), 'staff_directory_not_found', 404);
  for (const staffRoles of [[], ['crew', 'crew'], 'crew', ['Crew'], [null]]) await rejects(directory.mutate(people.ZacB, change('Crew.One', '', { action: 'set_roles', staffRoles })), 'staff_directory_invalid_roles', 400);
  await rejects(directory.mutate(people.ZacB, change('Crew.One', '', { action: 'set_roles', staffRoles: ['owner'] })), 'staff_directory_owner_role_reserved', 403);
  const unchanged = await directory.mutate(people.ZacB, change('Crew.One', '', { action: 'set_roles', staffRoles: ['crew'] }));
  assert.equal(unchanged.unchanged, true, 'the derived default role is not a change');
  for (const input of [{ action: 'delete' }, { action: 'set_roles', staffRoles: ['crew'], role: 'owner' }, { action: 'set_roles', requestId: 'not-a-uuid' }, { action: 'set_roles', expectedRevision: 3 }, { action: 'set_skills', skills: [], reason: 'x'.repeat(501) }]) {
    await rejects(directory.mutate(people.ZacB, { ...change('Crew.One', '', {}), ...input }), 'staff_directory_invalid_request', 400);
  }
  for (const skills of [[{ id: 'juggling', level: 'lead' }], [{ id: 'cleanout', level: 'master' }], [{ id: 'cleanout', level: 'lead', verifiedBy: 'forged' }], [{ id: 'cleanout', level: 'lead' }, { id: 'cleanout', level: 'trainee' }]]) {
    await rejects(directory.mutate(people.TylerG, change('Crew.One', '', { action: 'set_skills', skills })), 'staff_directory_invalid_skills', 400);
  }
  assert.equal(store.commits.length, 0);
});

test('profiles under legacy ids are updated in place; an unrecognized id or duplicate identity fails closed', async () => {
  assert.deepEqual(legacyPersonKeys('Crew.One'), ['crew-one', 'crewone']);
  const legacy = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'crew-one', username: 'Crew.One', hourlyRate: 20 }] });
  const saved = await service(legacy).mutate(people.TylerG, change('Crew.One', legacy.rows.get('crew-one').updateTime, { action: 'set_skills', skills: [{ id: 'dump_runs', level: 'trainee' }] }));
  assert.equal(saved.ok, true); assert.deepEqual([...legacy.rows.keys()], ['crew-one']);
  const odd = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'crew_one_old', username: 'Crew.One', hourlyRate: 20 }] });
  const view = personOf(await service(odd).list(people.TylerG), 'Crew.One');
  assert.equal(view.profileNeedsReview, true); assert.equal(view.revision, '');
  await rejects(service(odd).mutate(people.TylerG, change('Crew.One', '', { action: 'set_skills', skills: [] })), 'staff_directory_profile_ambiguous', 409);
  const duplicate = memory({ accounts: [account('crew.static')] });
  await rejects(service(duplicate).list(people.TylerG), 'staff_directory_roster_ambiguous', 409);
  assert.deepEqual(storedSkills([{ id: 'retired_skill', level: 'lead' }, { id: 'cleanout', level: 'bad' }]), [{ id: 'retired_skill', level: 'lead', verifiedBy: '', verifiedAt: '', retired: true }]);
  assert.ok(SKILL_CATALOG.every(skill => /^[a-z_]+$/.test(skill.id)));
});

test('every change commits a SEC-02 audit entry with it; pay entries are owner-only and never carry amounts', async () => {
  const store = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'crew.one', username: 'Crew.One', hourlyRate: 21 }] }), directory = service(store);
  const skillsInput = change('Crew.One', store.rows.get('crew.one').updateTime, { action: 'set_skills', reason: 'Synthetic sign-off', skills: [{ id: 'cleanout', level: 'lead' }] });
  const { person } = await directory.mutate(people.TylerG, skillsInput);
  const payInput = change('Crew.One', person.revision, { action: 'set_pay', effectiveFrom: '2026-10-01', hourlyRate: 24.75 });
  await directory.mutate(people.ZacB, payInput);
  const [skills, pay] = store.commits.map(plan => plan.audit);
  assert.equal(skills.collection, 'hub_audit'); assert.match(skills.id, /^[0-9a-f]{40}$/);
  assert.deepEqual({ action: skills.patch.action, via: skills.patch.via, visibility: skills.patch.visibility, actor: skills.patch.actor, entity: skills.patch.entity, reason: skills.patch.reason, at: skills.patch.at, requestId: skills.patch.requestId },
    { action: 'staff_directory.set_skills', via: 'hub', visibility: 'business', actor: { id: 'tylerg', kind: 'human', role: 'manager' }, entity: { collection: 'staff', id: 'crew.one' }, reason: 'Synthetic sign-off', at: NOW, requestId: skillsInput.requestId.toLowerCase() });
  assert.deepEqual(JSON.parse(skills.patch.before), { skills: [] }); assert.deepEqual(JSON.parse(skills.patch.after).skills.map(skill => skill.id), ['cleanout']); assert.deepEqual(skills.patch.changedKeys, ['skills']);
  assert.deepEqual({ action: pay.patch.action, visibility: pay.patch.visibility, before: pay.patch.before, requestId: pay.patch.requestId }, { action: 'staff_directory.set_pay', visibility: 'owner', before: null, requestId: payInput.requestId.toLowerCase() });
  assert.deepEqual(JSON.parse(pay.patch.after), { effectiveFrom: '2026-10-01', payType: 'hourly', overtimeMultiplier: 1.5, currentRateChanged: false });
  assert.doesNotMatch(JSON.stringify(pay), /24\.75|hourlyRate/, 'amounts stay in the sealed profile history');
  assert.equal(store.rows.get('crew.one').data.history.at(-1).changes.after.entry.hourlyRate, 24.75, 'the sealed history keeps the amount');
  // The audit reader withholds owner-only entries from managers.
  const rows = store.commits.map(plan => ({ ...plan.audit.patch, id: plan.audit.id })).sort((a, b) => a.id.localeCompare(b.id));
  const entry = async reader => (await listAudit({ auditPage: async () => rows }, {}, reader)).entries.find(item => item.action === 'staff_directory.set_pay');
  assert.deepEqual([(await entry(people.TylerG)).withheld, (await entry(people.TylerG)).after], [true, null]);
  assert.equal((await entry(people.ZacB)).after.effectiveFrom, '2026-10-01');
});

const decrypt = async (fire, collection, id) => {
  const documentId = await opaqueId(env, collection, id), doc = fire.documents.get(`jobs/${documentId}`);
  return { doc, data: doc ? await open(env, documentId, doc.fields.sealedIv.stringValue, doc.fields.sealedPayload.stringValue) : null };
};

test('HTTP: disabled by default, same-origin JSON only, bounded bodies and 401 without a session', async t => {
  const fire = vaultFirestore(t), handlers = staffDirectoryHandlers({ now: clock() }), enabled = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' };
  const owner = await cookieFor(env, 'ZacB');
  for (const response of [await handlers.get({ env, request: jsonRequest('/api/staff-directory', undefined, owner) }), await handlers.post({ env, request: jsonRequest('/api/staff-directory', {}, owner) })]) {
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'staff_directory_not_enabled');
  }
  assert.equal((await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', {}, owner, { Origin: 'https://attacker.invalid' }) })).status, 403);
  assert.equal((await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', {}, owner, { 'Sec-Fetch-Site': 'cross-site' }) })).status, 403);
  assert.equal((await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', {}, owner, { 'Content-Type': 'text/plain' }) })).status, 415);
  assert.equal((await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', 'x'.repeat(17000), owner) })).status, 413);
  assert.equal((await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', '{', owner) })).status, 400);
  assert.equal((await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', {}) })).status, 401);
  assert.equal((await handlers.get({ env: enabled, request: jsonRequest('/api/staff-directory?username=a&username=b', undefined, owner) })).status, 400);
  assert.equal((await handlers.get({ env: enabled, request: jsonRequest('/api/staff-directory?team=all', undefined, owner) })).status, 400);
  const response = await handlers.get({ env: enabled, request: jsonRequest('/api/staff-directory', undefined, owner) });
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await response.json()).coverage.complete, true);
  assert.equal(fire.writes().length, 0);
  // One unreadable profile fails the whole read closed; no partial roster is returned.
  const documentId = await opaqueId(env, 'profiles', 'crew.static');
  fire.documents.set(`jobs/${documentId}`, { name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${documentId}`, updateTime: '2026-09-22T12:00:00.000001Z', fields: {
    recordType: { stringValue: 'employee_hub_v2' }, employeeHubType: { stringValue: 'profiles' }, sealedPayload: { stringValue: 'AAAA' }, sealedIv: { stringValue: 'AAAAAAAAAAAAAAAA' }, schemaVersion: { integerValue: '2' }, updatedAt: { stringValue: NOW }, vaultId: { stringValue: documentId } } });
  const unreadable = await handlers.get({ env: enabled, request: jsonRequest('/api/staff-directory', undefined, owner) });
  assert.equal(unreadable.status, 503);
  const failure = await unreadable.json();
  assert.equal(failure.code, 'staff_directory_storage_unreadable'); assert.equal(failure.people, undefined);
  assert.equal(JSON.stringify(failure).includes('AAAA'), false);
});

test('HTTP: sealed profile, receipt and SEC-02 audit entry commit atomically; neither carries pay and replays are idempotent', async t => {
  const fire = vaultFirestore(t), enabled = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' }, handlers = staffDirectoryHandlers({ now: clock() });
  await seedAccount(env, 'Crew.Account');
  await writeOne(env, 'profiles', 'crew.account', { username: 'Crew.Account', hourlyRate: 21, onboardingCompletedAt: '2026-09-01T00:00:00.000Z' }, { data: null }, NOW);
  const owner = await cookieFor(env, 'ZacB');
  const list = await (await handlers.get({ env: enabled, request: jsonRequest('/api/staff-directory?username=crew.account', undefined, owner) })).json();
  const person = list.people[0];
  assert.equal(person.pay.current.hourlyRate, 21); assert.ok(person.revision);
  const body = { action: 'set_pay', requestId: crypto.randomUUID(), username: 'Crew.Account', expectedRevision: person.revision, effectiveFrom: '2026-09-22', hourlyRate: 27.25 };
  const response = await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', body, owner) });
  const saved = await response.json();
  assert.equal(response.status, 200, JSON.stringify(saved));
  assert.equal(saved.person.pay.current.hourlyRate, 27.25);
  assert.equal(fire.commits.length, 1);
  const [profileWrite, receiptWrite, auditWrite, ...extra] = fire.commits[0];
  assert.equal(extra.length, 0);
  assert.deepEqual(profileWrite.currentDocument, { updateTime: person.revision });
  assert.deepEqual(receiptWrite.currentDocument, { exists: false });
  assert.match(auditWrite.update.name, /\/documents\/hub_audit\/[0-9a-f]{40}$/); assert.deepEqual(auditWrite.currentDocument, { exists: false });
  const audit = decodeFirestoreFields(auditWrite.update.fields);
  assert.deepEqual({ action: audit.action, actor: audit.actor, via: audit.via, entity: audit.entity, requestId: audit.requestId, visibility: audit.visibility, at: audit.at },
    { action: 'staff_directory.set_pay', actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', entity: { collection: 'staff', id: 'crew.account' }, requestId: body.requestId.toLowerCase(), visibility: 'owner', at: NOW });
  assert.equal(audit.before, null);
  assert.deepEqual(JSON.parse(audit.after), { effectiveFrom: '2026-09-22', payType: 'hourly', overtimeMultiplier: 1.5, currentRateChanged: true }, 'the plaintext audit entry has the schedule shape, not the amount');
  assert.match(receiptWrite.update.name, /\/documents\/staffDirectoryOperations\/[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(receiptWrite), /27\.25|27,25|hourly/, 'the receipt never contains pay');
  assert.match(receiptWrite.update.fields.fingerprint.stringValue, /^[0-9a-f]{64}$/);
  const { data } = await decrypt(fire, 'profiles', 'crew.account');
  assert.equal(data.hourlyRate, 27.25, 'hourlyRate mirrors the rate effective today');
  assert.equal(data.onboardingCompletedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(data.directoryRequestId, body.requestId.toLowerCase());
  assert.equal(JSON.stringify([...fire.documents.values()]).includes('27.25'), false, 'pay is sealed at rest');
  const replay = await (await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', body, owner) })).json();
  assert.equal(replay.replayed, true); assert.equal(fire.commits.length, 1);
  assert.equal([...fire.documents.keys()].filter(key => key.startsWith('hub_audit/')).length, 1, 'a replay adds no second audit entry');
  const conflict = await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', { ...body, hourlyRate: 28 }, owner) });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'staff_directory_idempotency_conflict');
  const stale = await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', { ...body, requestId: crypto.randomUUID(), hourlyRate: 28 }, owner) });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'staff_directory_revision_conflict');
  // Another writer changes the profile between the directory read and the commit.
  const fresh = (await (await handlers.get({ env: enabled, request: jsonRequest('/api/staff-directory?username=Crew.Account', undefined, owner) })).json()).people[0];
  fire.hooks.beforeCommit = async () => { const current = (await readCollectionRecords(env, 'profiles'))[0]; await writeOne(env, 'profiles', 'crew.account', { ...current.data, phone: 'Synthetic concurrent edit' }, current, NOW); };
  const raced = await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', { action: 'set_skills', requestId: crypto.randomUUID(), username: 'Crew.Account', expectedRevision: fresh.revision, skills: [{ id: 'cleanout', level: 'lead' }] }, await cookieFor(env, 'TylerG')) });
  assert.equal(raced.status, 409); assert.equal((await raced.json()).code, 'staff_directory_revision_conflict');
  assert.equal((await decrypt(fire, 'profiles', 'crew.account')).data.phone, 'Synthetic concurrent edit');
  assert.equal(fire.commits.length, 1);
});

test('HTTP: read-only vault recovery returns 503 and writes nothing', async t => {
  const fire = vaultFirestore(t), handlers = staffDirectoryHandlers({ now: clock() });
  await seedAccount(env, 'Crew.Account');
  const readOnly = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true', EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HUB_SESSION_SECRET', EMPLOYEE_HUB_DATA_SECRET: env.EMPLOYEE_HUB_DATA_SECRET };
  const before = fire.writes().length;
  const response = await handlers.post({ env: readOnly, request: jsonRequest('/api/staff-directory', { action: 'set_skills', requestId: crypto.randomUUID(), username: 'Crew.Account', expectedRevision: '', skills: [] }, await cookieFor(env, 'TylerG')) });
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'staff_directory_recovery_read_only');
  assert.equal(fire.writes().length, before);
});

test('HTTP: clock-in snapshots the directory rate only once it is effective on the Denver calendar', async t => {
  const fire = vaultFirestore(t), enabled = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' };
  // 04:00Z on Oct 1 is 10 PM Sep 30 in Denver; the whole flow runs on the mocked clock.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T04:00:00.000Z') });
  await seedAccount(env, 'Crew.Account');
  const { cookie } = await login(env, 'Crew.Account');
  const handlers = staffDirectoryHandlers({ now: () => new Date() });
  const saved = await handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', { action: 'set_pay', requestId: crypto.randomUUID(), username: 'Crew.Account', expectedRevision: '', effectiveFrom: '2026-10-01', hourlyRate: 26 }, await cookieFor(env, 'ZacB')) });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await decrypt(fire, 'profiles', 'crew.account')).data.hourlyRate, 21, 'the mirror is the account rate in effect today');
  const clockIn = async id => {
    const response = await employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id, data: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 }, hourlyRate: 999 } }, cookie) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).record;
  };
  t.mock.timers.setTime(Date.parse('2026-10-01T05:30:00.000Z'));
  const september = await clockIn('shift-sep-30');
  assert.equal(september.hourlyRate, 21, '11:30 PM Sep 30 in Denver');
  const closed = await employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id: 'shift-sep-30', data: { clockOutAt: 'now', status: 'submitted' } }, cookie) });
  assert.equal(closed.status, 200, await closed.clone().text());
  t.mock.timers.setTime(Date.parse('2026-10-01T14:00:00.000Z'));
  const october = await clockIn('shift-oct-1');
  assert.equal(october.hourlyRate, 26, '8 AM Oct 1 in Denver');
});

test('HTTP: a lost commit reply is recovered from the receipt; an unverified save is 503 and the same request then applies once', async t => {
  const fire = vaultFirestore(t), enabled = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' }, handlers = staffDirectoryHandlers({ now: clock() });
  await seedAccount(env, 'Crew.Account');
  const manager = await cookieFor(env, 'TylerG'), post = body => handlers.post({ env: enabled, request: jsonRequest('/api/staff-directory', body, manager) });
  const audits = () => [...fire.documents.keys()].filter(key => key.startsWith('hub_audit/')).length;
  const body = { action: 'set_availability', requestId: crypto.randomUUID(), username: 'Crew.Account', expectedRevision: '', weeklyAvailability: week };
  fire.hooks.loseCommitReply = true;
  const first = await post(body);
  assert.equal(first.status, 200, await first.clone().text());
  const saved = await first.json();
  assert.equal(saved.replayed, true, 'the applied commit is recognized from its receipt'); assert.deepEqual(saved.person.weeklyAvailability.mon, week.mon);
  assert.equal((await (await post(body)).json()).replayed, true);
  assert.deepEqual([fire.commits.length, audits()], [1, 1]);
  fire.hooks.commitStatus = 503;
  const next = { ...body, requestId: crypto.randomUUID(), expectedRevision: saved.person.revision, weeklyAvailability: { sat: [{ start: '08:00', end: '12:00' }] } };
  const unknown = await post(next);
  assert.equal(unknown.status, 503); assert.equal((await unknown.json()).code, 'staff_directory_outcome_unknown');
  const retried = await post(next);
  assert.equal(retried.status, 200, await retried.clone().text());
  const applied = await retried.json();
  assert.equal(applied.replayed, undefined); assert.deepEqual(applied.person.weeklyAvailability.sat, next.weeklyAvailability.sat);
  assert.deepEqual([fire.commits.length, audits()], [2, 2]);
});

test('legacy /api/employee-hub never returns the pay schedule or audit trail, and its manager saves cannot rewrite directory fields', async t => {
  const fire = vaultFirestore(t), enabled = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' }, directory = staffDirectoryHandlers({ now: clock() });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  await seedAccount(env, 'Crew.Account');
  const owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG'), { cookie: crew } = await login(env, 'Crew.Account');
  const change = async (body, cookie) => { const response = await directory.post({ env: enabled, request: jsonRequest('/api/staff-directory', body, cookie) }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).person; };
  let person = await change({ action: 'set_pay', requestId: crypto.randomUUID(), username: 'Crew.Account', expectedRevision: '', effectiveFrom: '2026-10-01', hourlyRate: 26, reason: 'Synthetic raise' }, owner);
  person = await change({ action: 'set_skills', requestId: crypto.randomUUID(), username: 'Crew.Account', expectedRevision: person.revision, skills: [{ id: 'cleanout', level: 'lead' }] }, manager);
  const stored = (await decrypt(fire, 'profiles', 'crew.account')).data;
  assert.equal(stored.payRates.length, 2); assert.equal(stored.history.length, 2);
  const hubProfile = async cookie => {
    const response = await employeeHub.onRequestGet({ env, request: jsonRequest('/api/employee-hub', undefined, cookie) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).collections.profiles.find(profile => profile.username === 'Crew.Account');
  };
  for (const cookie of [owner, manager, crew]) {
    const profile = await hubProfile(cookie);
    for (const hidden of ['history', 'payRates', 'payRateMirror']) assert.equal(profile[hidden], undefined, hidden);
    // PRICE-SCRUB: another employee's pay goes to the owner only (EGC_STAFF_PAY_OWNER_ONLY default).
    assert.equal(profile.hourlyRate, cookie === manager ? undefined : 21, 'today\'s rate is still shown where it always was, to the owner and the employee'); assert.deepEqual(profile.skills.map(skill => skill.id), ['cleanout']);
  }
  // The legacy profile form still edits today's fields; directory-owned fields are ignored.
  // Manager pay edits are the legacy rule, EGC_STAFF_PAY_OWNER_ONLY=false (PRICE-SCRUB).
  const forged = { username: 'Crew.Account', jobTitle: 'Synthetic lead', hourlyRate: 22, payRates: [], payRateMirror: null, history: [], staffRoles: ['manager'], skills: [], skillCatalogVersion: 'x', weeklyAvailability: {}, migrations: ['forged'], directoryRequestId: 'forged', directoryUpdatedBy: 'forged' };
  const response = await employeeHub.onRequestPost({ env: { ...env, EGC_STAFF_PAY_OWNER_ONLY: 'false' }, request: jsonRequest('/api/employee-hub', { collection: 'profiles', id: 'crew.account', data: forged }, manager) });
  assert.equal(response.status, 200, await response.clone().text());
  const { record } = await response.json();
  for (const hidden of ['history', 'payRates', 'payRateMirror']) assert.equal(record[hidden], undefined, hidden);
  const after = (await decrypt(fire, 'profiles', 'crew.account')).data;
  for (const field of DIRECTORY_PROFILE_FIELDS) assert.deepEqual(after[field], stored[field], field);
  assert.equal(after.jobTitle, 'Synthetic lead'); assert.equal(after.hourlyRate, 22);
  assert.deepEqual(effectivePayRate(after, '2026-09-22'), { hourlyRate: 22, payType: 'hourly', overtimeMultiplier: null, effectiveFrom: null, source: 'legacy_profile_edit', drift: true }, 'the legacy edit wins and is flagged for owner review');
  const view = (await (await directory.get({ env: enabled, request: jsonRequest('/api/staff-directory?username=Crew.Account', undefined, owner) })).json()).people[0];
  assert.equal(view.pay.needsReview, true); assert.equal(view.history.length, 2);
});

test('skill and availability audit entries carry ids, levels and window counts only; the sealed history keeps the detail', async () => {
  const store = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'crew.one', username: 'Crew.One', hourlyRate: 21, weeklyAvailability: { mon: [{ start: '07:15', end: '11:45' }], fri: [{ start: '06:30', end: '14:10' }] } }] });
  const directory = service(store, '2026-09-23T15:30:00.000Z');
  const skills = await directory.mutate(people.TylerG, change('Crew.One', store.rows.get('crew.one').updateTime, { action: 'set_skills', skills: [{ id: 'cleanout', level: 'lead' }, { id: 'first_aid', level: 'trainee' }] }));
  await directory.mutate(people.TylerG, change('Crew.One', skills.person.revision, { action: 'set_availability', weeklyAvailability: { mon: [{ start: '08:05', end: '12:35' }], wed: week.wed } }));
  const [skillsAudit, availabilityAudit] = store.commits.map(plan => plan.audit.patch);
  assert.deepEqual(JSON.parse(skillsAudit.after), { skills: [{ id: 'cleanout', level: 'lead' }, { id: 'first_aid', level: 'trainee' }] });
  assert.doesNotMatch(skillsAudit.before + skillsAudit.after, /verified|TylerG|2026-09-23/i, 'no verifier or verification time in plaintext');
  assert.deepEqual(skillsAudit.changedKeys, ['skills']);
  assert.deepEqual(JSON.parse(availabilityAudit.before), { weeklyAvailability: { windowsPerDay: { mon: 1, tue: 0, wed: 0, thu: 0, fri: 1, sat: 0, sun: 0 } } });
  assert.deepEqual(JSON.parse(availabilityAudit.after), { weeklyAvailability: { windowsPerDay: { mon: 1, tue: 0, wed: 1, thu: 0, fri: 0, sat: 0, sun: 0 }, changedDays: ['mon', 'wed', 'fri'] } });
  assert.deepEqual(availabilityAudit.changedKeys, ['weeklyAvailability']);
  assert.doesNotMatch(JSON.stringify(availabilityAudit), /07:15|11:45|06:30|14:10|08:05|12:35|09:00|24:00/, 'no window times in plaintext');
  const history = store.rows.get('crew.one').data.history;
  assert.equal(history[0].changes.after.skills[0].verifiedBy, 'TylerG');
  assert.deepEqual(history[1].changes.before.weeklyAvailability.fri, [{ start: '06:30', end: '14:10' }]);
  assert.deepEqual(history[1].changes.after.weeklyAvailability.mon, [{ start: '08:05', end: '12:35' }]);
  const fresh = memory({ accounts: [account('Crew.One')] });
  await service(fresh).mutate(people.TylerG, change('Crew.One', '', { action: 'set_availability', weeklyAvailability: { sat: [{ start: '09:00', end: '13:00' }] } }));
  assert.deepEqual([JSON.parse(fresh.commits[0].audit.patch.before), JSON.parse(fresh.commits[0].audit.patch.after).weeklyAvailability.changedDays], [{ weeklyAvailability: null }, ['sat']]);
});

test('configured Hub users\' pay is never flagged for directory review, since set_pay cannot change it', async () => {
  const rates = [{ effectiveFrom: LEGACY_EFFECTIVE_FROM, hourlyRate: 30, payType: 'hourly', overtimeMultiplier: 1.5, setBy: 'x', setAt: NOW }];
  const drifted = { hourlyRate: 32, payRates: rates, payRateMirror: { hourlyRate: 30, effectiveFrom: LEGACY_EFFECTIVE_FROM, at: NOW } };
  const store = memory({ accounts: [account('Crew.One')], profiles: [{ id: 'tylerg', username: 'TylerG', ...drifted }, { id: 'crew.one', username: 'Crew.One', ...drifted }] });
  const view = await service(store).list(people.ZacB);
  assert.equal(personOf(view, 'TylerG').pay.current.drift, true); assert.equal(personOf(view, 'TylerG').pay.needsReview, false);
  assert.equal(personOf(view, 'Crew.One').pay.needsReview, true);
});

test('legacy pay helpers: stripping, the effective-rate view and the moving mirror', () => {
  const env = staffEnv(), enabled = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' };
  assert.deepEqual(legacyProfileInput({ jobTitle: 'x', hourlyRate: 9, payType: 'salary', payRates: [] }), { jobTitle: 'x', hourlyRate: 9, payType: 'salary' });
  assert.deepEqual(legacyProfileInput({ jobTitle: 'x', hourlyRate: 9, payType: 'salary', payRates: [] }, { stripPay: true }), { jobTitle: 'x' });
  assert.deepEqual([legacyPayLocked(people.TylerG, env), legacyPayLocked(people.TylerG, enabled), legacyPayLocked(people.ZacB, enabled), legacyPayLocked(employee('Crew.One'), enabled)], [false, true, false, true]);
  const profile = { id: 'crew.one', username: 'Crew.One', hourlyRate: 21, payRates: [{ effectiveFrom: LEGACY_EFFECTIVE_FROM, hourlyRate: 21, payType: 'hourly', overtimeMultiplier: 1.5, setBy: 'x', setAt: NOW }, { effectiveFrom: '2026-10-01', hourlyRate: 26, payType: 'hourly', overtimeMultiplier: 1.5, setBy: 'x', setAt: NOW }], payRateMirror: { hourlyRate: 21, effectiveFrom: LEGACY_EFFECTIVE_FROM, at: NOW }, history: [] };
  // 05:30Z on Oct 1 is still Sep 30 in Denver.
  assert.deepEqual(legacyProfileView(profile, '2026-10-01T05:30:00.000Z'), { id: 'crew.one', username: 'Crew.One', hourlyRate: 21 });
  assert.deepEqual(legacyProfileView(profile, '2026-10-01T06:30:00.000Z'), { id: 'crew.one', username: 'Crew.One', hourlyRate: 26 });
  assert.equal(legacyProfileView({ ...profile, hourlyRate: 24 }, '2026-10-05T18:00:00.000Z').hourlyRate, 24, 'a legacy edit (drift) is shown as it is used');
  assert.deepEqual(legacyProfileView({ id: 'a', hourlyRate: 19 }, NOW), { id: 'a', hourlyRate: 19 });
  const at = '2026-10-05T18:00:00.000Z', saved = mirrorLegacyPay(profile, { ...profile, lastSeenAt: at }, at);
  assert.equal(saved.hourlyRate, 26); assert.deepEqual(saved.payRateMirror, { hourlyRate: 26, effectiveFrom: '2026-10-01', at });
  assert.equal(effectivePayRate(saved, '2026-10-05').drift, false);
  assert.equal(mirrorLegacyPay(saved, { ...saved }, '2026-10-06T18:00:00.000Z').payRateMirror.at, at, 'an unmoved mirror keeps its time');
  const reverted = mirrorLegacyPay(saved, { ...saved, hourlyRate: 21 }, '2026-10-06T18:00:00.000Z', true);
  assert.deepEqual(effectivePayRate(reverted, '2026-10-06'), { hourlyRate: 21, payType: 'hourly', overtimeMultiplier: null, effectiveFrom: null, source: 'legacy_profile_edit', drift: true }, 'setting an older scheduled rate back is drift');
  const unscheduled = { id: 'a', hourlyRate: 19 }, next = { ...unscheduled, hourlyRate: 20 };
  assert.equal(mirrorLegacyPay(unscheduled, next, at), next, 'a profile without a pay schedule is written exactly as before');
  assert.equal(mirrorLegacyPay(null, next, at), next);
});

test('HTTP: once a scheduled raise takes effect, legacy readers show it, a crew self-save mirrors it and reverting it is drift', async t => {
  const fire = vaultFirestore(t), enabled = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  await seedAccount(env, 'Crew.Account');
  let owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG'), { cookie: crew } = await login(env, 'Crew.Account');
  const directory = staffDirectoryHandlers({ now: () => new Date() });
  const raise = await directory.post({ env: enabled, request: jsonRequest('/api/staff-directory', { action: 'set_pay', requestId: crypto.randomUUID(), username: 'Crew.Account', expectedRevision: '', effectiveFrom: '2026-10-01', hourlyRate: 26 }, owner) });
  assert.equal(raise.status, 200, await raise.clone().text());
  const hubRate = async cookie => (await (await employeeHub.onRequestGet({ env, request: jsonRequest('/api/employee-hub', undefined, cookie) })).json()).collections.profiles.find(profile => profile.username === 'Crew.Account').hourlyRate;
  // PRICE-SCRUB: the owner and the employee read another employee's pay; a manager reads hours only.
  assert.deepEqual([await hubRate(owner), await hubRate(crew), await hubRate(manager)], [21, 21, undefined], 'before the effective date');
  t.mock.timers.setTime(Date.parse('2026-10-05T18:00:00.000Z'));
  // Hub sessions last 12 hours, so everyone signs in again on Oct 5.
  owner = await cookieFor(env, 'ZacB'); manager = await cookieFor(env, 'TylerG'); ({ cookie: crew } = await login(env, 'Crew.Account'));
  assert.equal((await decrypt(fire, 'profiles', 'crew.account')).data.hourlyRate, 21, 'the stored mirror is still the old rate');
  assert.deepEqual([await hubRate(owner), await hubRate(crew)], [26, 26], 'legacy readers see the rate in effect today');
  const selfSave = await employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'profiles', id: 'crew.account', data: { hourlyRate: 99 } }, crew) });
  assert.equal(selfSave.status, 200, await selfSave.clone().text());
  assert.equal((await selfSave.json()).record.hourlyRate, 26);
  const mirrored = (await decrypt(fire, 'profiles', 'crew.account')).data;
  assert.equal(mirrored.hourlyRate, 26); assert.deepEqual(mirrored.payRateMirror, { hourlyRate: 26, effectiveFrom: '2026-10-01', at: '2026-10-05T18:00:00.000Z' });
  // The owner deliberately sets the old rate back through the legacy profile form.
  const revert = await employeeHub.onRequestPost({ env: enabled, request: jsonRequest('/api/employee-hub', { collection: 'profiles', id: 'crew.account', data: { username: 'Crew.Account', hourlyRate: 21 } }, owner) });
  assert.equal(revert.status, 200, await revert.clone().text());
  const reverted = (await decrypt(fire, 'profiles', 'crew.account')).data;
  assert.deepEqual(effectivePayRate(reverted, '2026-10-05'), { hourlyRate: 21, payType: 'hourly', overtimeMultiplier: null, effectiveFrom: null, source: 'legacy_profile_edit', drift: true });
  assert.equal(await hubRate(owner), 21, 'legacy readers and timecards agree on the edited rate');
  const view = (await (await directory.get({ env: enabled, request: jsonRequest('/api/staff-directory?username=Crew.Account', undefined, owner) })).json()).people[0];
  assert.equal(view.pay.needsReview, true); assert.equal(view.pay.current.hourlyRate, 21);
  const clockIn = await employeeHub.onRequestPost({ env, request: jsonRequest('/api/employee-hub', { collection: 'timeEntries', id: 'shift-oct-5', data: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08, accuracy: 5 } } }, crew) });
  assert.equal((await clockIn.json()).record.hourlyRate, 21);
});

test('HTTP: with the directory on, only the owner changes pay through the legacy profile form; off, managers still can when EGC_STAFF_PAY_OWNER_ONLY=false', async t => {
  const fire = vaultFirestore(t), enabled = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  await seedAccount(env, 'Crew.Account');
  await writeOne(env, 'profiles', 'crew.account', { username: 'Crew.Account', payType: 'hourly', hourlyRate: 21 }, { data: null }, NOW);
  await writeOne(env, 'profiles', 'tylerg', { username: 'TylerG', displayName: 'Synthetic Manager', payType: 'hourly', hourlyRate: 28 }, { data: null }, NOW);
  const owner = await cookieFor(env, 'ZacB'), manager = await cookieFor(env, 'TylerG'), lead = await cookieFor(env, 'AlexK');
  const save = async (hubEnv, cookie, id, data) => {
    const response = await employeeHub.onRequestPost({ env: hubEnv, request: jsonRequest('/api/employee-hub', { collection: 'profiles', id, data }, cookie) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await decrypt(fire, 'profiles', id)).data;
  };
  for (const cookie of [manager, lead]) {
    const kept = await save(enabled, cookie, 'crew.account', { username: 'Crew.Account', jobTitle: 'Synthetic lead', hourlyRate: 99, payType: 'salary' });
    assert.deepEqual([kept.hourlyRate, kept.payType, kept.jobTitle], [21, 'hourly', 'Synthetic lead'], 'a manager\'s pay fields are dropped');
  }
  // ensureOwnProfile: a manager's own profile keeps mirroring the Hub configuration, whatever the form sent.
  const own = await save(enabled, manager, 'tylerg', { username: 'TylerG', displayName: 'Synthetic Manager', hourlyRate: 99, payType: 'salary', lastSeenAt: NOW });
  assert.deepEqual([own.hourlyRate, own.payType], [30, 'hourly']);
  assert.equal((await save(enabled, owner, 'crew.account', { username: 'Crew.Account', hourlyRate: 23 })).hourlyRate, 23, 'the owner keeps today\'s legacy edit');
  // PRICE-SCRUB: by default only the owner sets another employee's pay; the legacy rule is EGC_STAFF_PAY_OWNER_ONLY=false.
  assert.equal((await save(env, manager, 'crew.account', { username: 'Crew.Account', hourlyRate: 25, payType: 'salary' })).hourlyRate, 23, 'a manager\'s pay fields are dropped by default');
  assert.equal((await save({ ...env, EGC_STAFF_PAY_OWNER_ONLY: 'false' }, manager, 'crew.account', { username: 'Crew.Account', hourlyRate: 24, payType: 'salary' })).hourlyRate, 24, 'with the directory off and pay open to managers, managers edit pay as before');
  assert.equal((await save(env, manager, 'tylerg', { username: 'TylerG', hourlyRate: 31 })).hourlyRate, 31);
});
