import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PROTECTED_FIELDS, VAULT_MIGRATIONS, VAULT_MIGRATION_FAMILIES, runVaultMigration, vaultMigrationStorage } from '../functions/_lib/employee-vault-migrate.js';
import { commitVaultDocuments, opaqueId, readCollectionRecords, readOne, sealedFields, vaultDigest, writeOne } from '../functions/_lib/employee-vault.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { employeeAccountRecords, employeeInvitationStore, listEmployeeApplications, sealedAccountFields } from '../functions/_lib/employee-accounts.js';
import { getHubSession } from '../functions/_lib/hub-session.js';
import { approvedTimecard } from '../functions/_lib/gusto-timecards.js';
import { LEGACY_EFFECTIVE_FROM, profileHourlyRate } from '../functions/_lib/staff-directory.js';
import { vaultMigrationHandlers } from '../functions/api/employee-vault-migrate.js';
import { vaultFirestore, staffEnv, cookieFor, seedAccount, login, jsonRequest } from './helpers/vault-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z';
const env = staffEnv();
const PROFILES = VAULT_MIGRATIONS['staff-profile-pay-roles-v1'], ACCOUNTS = VAULT_MIGRATIONS['employee-account-staff-roles-v1'];
const approved = { employee: 'Crew.Account', employeeName: 'Synthetic Crew', clockInAt: '2026-09-21T14:00:00.000Z', clockOutAt: '2026-09-21T22:00:00.000Z', breaks: [{ startAt: '2026-09-21T18:00:00.000Z', endAt: '2026-09-21T18:30:00.000Z' }],
  status: 'submitted', approvalStatus: 'approved', approvedAt: '2026-09-21T23:00:00.000Z', approvedBy: 'zacb', hourlyRate: 21, hours: 7.5, grossEstimate: 157.5, workDate: '2026-09-21', history: [{ action: 'clock_in', actor: 'Crew.Account', at: '2026-09-21T14:00:00.000Z' }] };
const gustoFingerprint = raw => createHash('sha256').update(JSON.stringify(approvedTimecard(raw).source)).digest('hex');

async function seed() {
  await seedAccount(env, 'Crew.Account');
  await seedAccount(env, 'Sales.Account', { sales: true });
  await writeOne(env, 'profiles', 'crew.account', { username: 'Crew.Account', role: 'crew', payType: 'hourly', hourlyRate: 21, onboardingCompletedAt: '2026-09-01T00:00:00.000Z', futureField: [1] }, { data: null }, NOW);
  // Configured Hub users (ZacB here) keep pay and roles in the Hub configuration, so the backfill skips them.
  await writeOne(env, 'profiles', 'zacb', { username: 'ZacB', role: 'owner', payType: 'owner', hourlyRate: 0 }, { data: null }, NOW);
  await writeOne(env, 'profiles', 'odd.pay', { username: 'Odd.Pay', role: 'crew', payType: 'commission', hourlyRate: 18 }, { data: null }, NOW);
  await writeOne(env, 'profiles', 'no.rate', { username: 'No.Rate', role: 'crew', staffRoles: ['crew'] }, { data: null }, NOW);
  await writeOne(env, 'timeEntries', 'approved-shift', approved, { data: null }, NOW);
}
const run = (options = {}) => runVaultMigration({ store: vaultMigrationStorage(env), migration: PROFILES, now: NOW, actor: 'ZacB', ...options });
const profiles = async () => Object.fromEntries((await readCollectionRecords(env, 'profiles')).map(row => [row.data.id, row]));

test('a dry run (the default) decrypts and reports every record but writes nothing', async t => {
  const fire = vaultFirestore(t); await seed();
  const before = fire.snapshot(), writes = fire.writes().length;
  const report = await run();
  assert.equal(report.dryRun, true);
  assert.deepEqual({ scanned: report.scanned, eligible: report.eligible, unchanged: report.unchanged, alreadyApplied: report.alreadyApplied, migrated: report.migrated }, { scanned: 4, eligible: 2, unchanged: 2, alreadyApplied: 0, migrated: 0 });
  assert.deepEqual(report.items.map(item => `${item.id}:${item.outcome}`).sort(), ['crew.account:eligible', 'no.rate:unchanged', 'odd.pay:eligible', 'zacb:unchanged']);
  assert.equal(fire.writes().length, writes); assert.equal(fire.snapshot(), before);
});

test('an applied migration re-seals each record under the same id with history, and a second run is a no-op', async t => {
  const fire = vaultFirestore(t); await seed();
  const before = await profiles(), ivBefore = fire.documents.get(`jobs/${before['crew.account'].documentId}`).fields.sealedIv.stringValue;
  const report = await run({ dryRun: false });
  assert.deepEqual({ eligible: report.eligible, migrated: report.migrated, conflicts: report.conflicts, failed: report.failed }, { eligible: 2, migrated: 2, conflicts: 0, failed: 0 });
  const after = await profiles();
  const crew = after['crew.account'];
  assert.equal(crew.documentId, before['crew.account'].documentId, 'same vault document (AAD) id');
  const stored = fire.documents.get(`jobs/${crew.documentId}`);
  assert.notEqual(stored.fields.sealedIv.stringValue, ivBefore, 'fresh IV');
  assert.equal(stored.fields.vaultId.stringValue, crew.documentId); assert.equal(stored.fields.schemaVersion.integerValue, '2');
  assert.deepEqual(crew.data.payRates, [{ effectiveFrom: LEGACY_EFFECTIVE_FROM, hourlyRate: 21, payType: 'hourly', overtimeMultiplier: 1.5, setBy: 'migration:staff-profile-pay-roles-v1', setAt: NOW, source: 'legacy_hourly_rate' }]);
  assert.deepEqual(crew.data.staffRoles, ['crew']); assert.deepEqual(crew.data.migrations, ['staff-profile-pay-roles-v1']);
  assert.deepEqual(crew.data.history.at(-1), { action: 'migration:staff-profile-pay-roles-v1', scope: 'pay', actor: 'ZacB', at: NOW, reason: PROFILES.description,
    changes: { before: { payRates: null, payRateMirror: null, staffRoles: null }, after: { payRates: crew.data.payRates, payRateMirror: crew.data.payRateMirror, staffRoles: ['crew'] } } });
  for (const field of ['hourlyRate', 'payType', 'onboardingCompletedAt', 'futureField', 'updatedAt', 'username']) assert.deepEqual(crew.data[field], before['crew.account'].data[field], field);
  assert.equal(profileHourlyRate(crew.data, NOW), profileHourlyRate(before['crew.account'].data, NOW), 'the effective rate is unchanged');
  assert.equal(after['odd.pay'].data.payRates[0].payType, 'commission', 'the legacy payType is kept as it was');
  assert.deepEqual(after['odd.pay'].data.staffRoles, ['crew']);
  assert.equal(after.zacb.updateTime, before.zacb.updateTime, 'a configured Hub user is skipped');
  assert.deepEqual([after.zacb.data.payRates, after.zacb.data.staffRoles, after.zacb.data.migrations], [undefined, undefined, undefined]);
  assert.equal(after['no.rate'].updateTime, before['no.rate'].updateTime, 'a record with nothing to backfill is untouched');
  // Each migrated record is its own commit: the sealed record under its observed
  // updateTime plus a create-only, owner-only SEC-02 audit entry keyed by the opaque id.
  assert.equal(fire.commits.length, 2);
  for (const [record, audit, ...extra] of fire.commits) {
    assert.equal(extra.length, 0);
    const id = Object.keys(before).find(key => record.update.name.endsWith(`/jobs/${before[key].documentId}`));
    assert.deepEqual(record.currentDocument, { updateTime: before[id].updateTime });
    assert.match(audit.update.name, /\/documents\/hub_audit\/[0-9a-f]{40}$/); assert.deepEqual(audit.currentDocument, { exists: false });
    const entry = decodeFirestoreFields(audit.update.fields);
    assert.deepEqual({ action: entry.action, via: entry.via, actor: entry.actor, entity: entry.entity, visibility: entry.visibility, at: entry.at, requestId: entry.requestId },
      { action: 'employee_vault.migrate', via: 'hub', actor: { id: 'zacb', kind: 'human', role: 'owner' }, entity: { collection: 'vault_profiles', id: before[id].documentId }, visibility: 'owner', at: NOW, requestId: null });
    assert.match(entry.reason, /^staff-profile-pay-roles-v1: /);
    assert.deepEqual(entry.changedKeys, ['payRateMirror', 'payRates', 'staffRoles']);
    assert.deepEqual(JSON.parse(entry.before), { payRates: null, payRateMirror: null, staffRoles: null });
    assert.deepEqual(JSON.parse(entry.after), { payRates: '[sealed:after]', payRateMirror: '[sealed:after]', staffRoles: '[sealed:after]' });
    assert.doesNotMatch(entry.before + entry.after, /hourly|21|crew|owner|2000-01-01/, 'sealed values never reach the plaintext audit log');
    assert.equal(JSON.stringify([entry.entity, entry.before, entry.after]).includes(id), false, 'the audit entry names the opaque vault id, not the employee');
  }
  const writes = fire.writes().length;
  const second = await run({ dryRun: false });
  assert.deepEqual({ alreadyApplied: second.alreadyApplied, unchanged: second.unchanged, eligible: second.eligible, migrated: second.migrated }, { alreadyApplied: 2, unchanged: 2, eligible: 0, migrated: 0 });
  assert.equal(fire.writes().length, writes);
});

test('a concurrent edit is counted as a conflict and never clobbered', async t => {
  const fire = vaultFirestore(t); await seed();
  fire.hooks.beforeCommit = async () => {
    const current = await readOne(env, 'profiles', 'crew.account');
    await writeOne(env, 'profiles', 'crew.account', { ...current.data, phone: 'Synthetic concurrent edit' }, current, NOW);
  };
  const report = await run({ dryRun: false });
  assert.equal(report.conflicts + report.migrated, 2); assert.equal(report.conflicts, 1);
  const crew = (await readOne(env, 'profiles', 'crew.account')).data;
  assert.equal(crew.phone, 'Synthetic concurrent edit'); assert.equal(crew.migrations, undefined);
  const retry = await run({ dryRun: false });
  assert.equal(retry.migrated, 1); assert.equal(retry.alreadyApplied, 1);
  assert.equal((await readOne(env, 'profiles', 'crew.account')).data.phone, 'Synthetic concurrent edit');
});

test('read-only recovery and corrupt records abort before any write', async t => {
  const fire = vaultFirestore(t); await seed();
  const readOnly = { ...env, EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HUB_SESSION_SECRET' }, requests = fire.requests.length;
  await assert.rejects(runVaultMigration({ store: vaultMigrationStorage(readOnly), migration: PROFILES, dryRun: false, now: NOW, actor: 'ZacB' }), error => error.code === 'employee_vault_migration_read_only' && error.status === 503);
  assert.equal(fire.requests.length, requests, 'read-only refuses before reading');
  const corruptId = await opaqueId(env, 'profiles', 'corrupt.one'), good = [...fire.documents.values()].find(doc => doc.fields.employeeHubType?.stringValue === 'profiles');
  fire.documents.set(`jobs/${corruptId}`, { name: good.name.replace(/[^/]+$/, corruptId), updateTime: '2026-09-22T12:00:00.999999Z', fields: { ...good.fields, vaultId: { stringValue: corruptId }, sealedPayload: { stringValue: good.fields.sealedPayload.stringValue.slice(0, -4) + 'AAAA' } } });
  const writes = fire.writes().length;
  await assert.rejects(run({ dryRun: false }), error => error.code === 'EMPLOYEE_HUB_STORAGE_UNREADABLE');
  assert.equal(fire.writes().length, writes);
  assert.equal((await readOne(env, 'profiles', 'crew.account')).data.migrations, undefined);
});

test('protected fields cannot be changed and Gusto fingerprints of migrated approved timecards are unchanged', async t => {
  const fire = vaultFirestore(t); await seed();
  const original = (await readOne(env, 'timeEntries', 'approved-shift')).data, fingerprint = gustoFingerprint(original);
  const annotate = { id: 'synthetic-timecard-note-v1', family: 'timeEntries', description: 'Synthetic annotation', transform: entry => entry.reviewNote ? null : { reviewNote: 'synthetic' } };
  const report = await runVaultMigration({ store: vaultMigrationStorage(env), migration: annotate, dryRun: false, now: NOW, actor: 'ZacB' });
  assert.equal(report.migrated, 1);
  const migrated = (await readOne(env, 'timeEntries', 'approved-shift')).data;
  assert.equal(gustoFingerprint(migrated), fingerprint);
  for (const field of PROTECTED_FIELDS.timeEntries) assert.deepEqual(migrated[field], original[field], field);
  assert.equal(migrated.history.length, 2); assert.equal(migrated.history[0].action, 'clock_in'); assert.equal(migrated.history[1].action, 'migration:synthetic-timecard-note-v1');
  const writes = fire.writes().length;
  for (const transform of [() => ({ approvedAt: NOW }), () => ({ breaks: [] }), () => ({ migrations: [] }), () => ({ history: [] }), () => ({}), () => 'x']) {
    await assert.rejects(runVaultMigration({ store: vaultMigrationStorage(env), migration: { id: 'synthetic-bad-v1', family: 'timeEntries', transform }, dryRun: false, now: NOW, actor: 'ZacB' }), error => error.code === 'employee_vault_migration_protected_field');
  }
  await assert.rejects(runVaultMigration({ store: vaultMigrationStorage(env), migration: { id: 'x', family: 'timeEntries', transform: () => null }, now: NOW, actor: 'ZacB' }), error => error.code === 'employee_vault_migration_unknown');
  await assert.rejects(runVaultMigration({ store: vaultMigrationStorage(env), migration: { id: 'synthetic-v1', family: 'customers', transform: () => null }, now: NOW, actor: 'ZacB' }), error => error.code === 'employee_vault_migration_unknown');
  assert.equal(fire.writes().length, writes);
  assert.ok(VAULT_MIGRATION_FAMILIES.includes('timeLocks'));
  const lockId = await opaqueId(env, 'timeLocks', 'crew.account'), lockFields = await sealedFields(env, 'timeLocks', lockId, { id: 'crew.account', entryId: 'approved-shift', updatedAt: NOW }, NOW);
  fire.documents.set(`employee_time_locks/${lockId}`, { name: `projects/egcw-1ec83/databases/(default)/documents/employee_time_locks/${lockId}`, fields: encodeFirestoreFields(lockFields), updateTime: '2026-09-22T12:00:00.500000Z' });
  const noteLock = { id: 'synthetic-lock-v1', family: 'timeLocks', transform: () => ({ note: 'x' }) };
  const dryLocks = await runVaultMigration({ store: vaultMigrationStorage(env), migration: noteLock, now: NOW, actor: 'ZacB' });
  assert.deepEqual({ scanned: dryLocks.scanned, eligible: dryLocks.eligible }, { scanned: 1, eligible: 1 });
  assert.equal(fire.requests.at(-1).body.structuredQuery.from[0].collectionId, 'employee_time_locks');
  await assert.rejects(runVaultMigration({ store: vaultMigrationStorage(env), migration: { ...noteLock, transform: () => ({ entryId: '' }) }, dryRun: false, now: NOW, actor: 'ZacB' }), error => error.code === 'employee_vault_migration_protected_field');
  assert.equal(fire.writes().length, writes);
  assert.equal((await runVaultMigration({ store: vaultMigrationStorage(env), migration: noteLock, dryRun: false, now: NOW, actor: 'ZacB' })).migrated, 1);
  assert.deepEqual((await readOne(env, 'timeLocks', 'crew.account')).data.migrations, ['synthetic-lock-v1']);
  assert.equal((await readOne(env, 'timeLocks', 'crew.account')).data.entryId, 'approved-shift');
});

test('the account backfill records the current role without revoking sessions or touching credentials', async t => {
  vaultFirestore(t); await seed();
  const { cookie } = await login(env, 'Sales.Account');
  const before = await employeeInvitationStore(env).read('Sales.Account');
  const report = await runVaultMigration({ store: vaultMigrationStorage(env), migration: ACCOUNTS, dryRun: false, now: NOW, actor: 'ZacB' });
  assert.equal(report.migrated, 2);
  const after = await employeeInvitationStore(env).read('Sales.Account');
  assert.deepEqual(after.account.staffRoles, ['sales']);
  assert.deepEqual((await employeeInvitationStore(env).read('Crew.Account')).account.staffRoles, ['crew']);
  for (const field of PROTECTED_FIELDS.accounts) assert.deepEqual(after.account[field], before.account[field], field);
  assert.ok(await getHubSession(new Request('https://easygaragecleaning.com/', { headers: { Cookie: cookie } }), env), 'existing sessions stay valid');
  assert.deepEqual((await login(env, 'Sales.Account')).profile.staffRoles, ['sales']);
  assert.equal((await runVaultMigration({ store: vaultMigrationStorage(env), migration: ACCOUNTS, dryRun: false, now: NOW, actor: 'ZacB' })).alreadyApplied, 2);
});

test('HTTP: owner-only, same-origin, dry-run by default, and applied runs replay by requestId', async t => {
  const fire = vaultFirestore(t); await seed();
  const handlers = vaultMigrationHandlers({ now: () => new Date(NOW) }), owner = await cookieFor(env, 'ZacB');
  const post = (body, cookie = owner, headers) => handlers.post({ env, request: jsonRequest('/api/employee-vault-migrate', body, cookie, headers) });
  const body = { requestId: crypto.randomUUID(), migrationId: 'staff-profile-pay-roles-v1' };
  for (const user of ['TylerG', 'AlexK', 'Crew.Static']) assert.equal((await post(body, await cookieFor(env, user))).status, 403, user);
  assert.equal((await post(body, '')).status, 401);
  assert.equal((await post(body, owner, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post(body, owner, { 'Content-Type': 'text/plain' })).status, 415);
  for (const invalid of [{ ...body, dryRun: 'false' }, { ...body, requestId: 'x' }, { ...body, migrationId: 'missing' }, { ...body, migrationId: '__proto__' }, { ...body, extra: true }]) assert.equal((await post(invalid)).status, 400, JSON.stringify(invalid));
  const listed = await (await handlers.get({ env, request: jsonRequest('/api/employee-vault-migrate', undefined, owner) })).json();
  assert.deepEqual(listed.migrations.map(item => item.id), ['staff-profile-pay-roles-v1', 'employee-account-staff-roles-v1']);
  const writes = fire.writes().length;
  const dry = await (await post(body)).json();
  assert.equal(dry.report.dryRun, true); assert.equal(dry.report.eligible, 2); assert.equal(fire.writes().length, writes, 'a dry run writes nothing, not even a receipt');
  const apply = { ...body, dryRun: false };
  const applied = await (await post(apply)).json();
  assert.equal(applied.report.migrated, 2); assert.equal(applied.receiptRecorded, true);
  const receipt = [...fire.documents].find(([key]) => key.startsWith('employeeVaultMigrations/'));
  assert.equal(receipt[1].fields.status.stringValue, 'completed');
  assert.match(receipt[1].fields.fingerprint.stringValue, /^[0-9a-f]{64}$/);
  const commits = fire.commits.length;
  const replay = await (await post(apply)).json();
  assert.equal(replay.replayed, true); assert.deepEqual(replay.report, applied.report); assert.equal(fire.commits.length, commits);
  const conflict = await post({ ...apply, migrationId: 'employee-account-staff-roles-v1' });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'employee_vault_migration_idempotency_conflict');
  const readOnly = await handlers.post({ env: { ...env, EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HUB_SESSION_SECRET' }, request: jsonRequest('/api/employee-vault-migrate', { ...apply, requestId: crypto.randomUUID() }, owner) });
  assert.equal(readOnly.status, 503); assert.equal((await readOnly.json()).code, 'employee_vault_migration_read_only');
});

test('HTTP: a failed applied run is recorded and can be retried with the same requestId', async t => {
  const fire = vaultFirestore(t); await seed();
  const handlers = vaultMigrationHandlers({ now: () => new Date(NOW) }), owner = await cookieFor(env, 'ZacB');
  const good = [...fire.documents.values()].find(doc => doc.fields.employeeHubType?.stringValue === 'profiles'), corruptId = await opaqueId(env, 'profiles', 'corrupt.one');
  fire.documents.set(`jobs/${corruptId}`, { name: good.name.replace(/[^/]+$/, corruptId), updateTime: '2026-09-22T12:00:00.999999Z', fields: { ...good.fields, vaultId: { stringValue: corruptId } } });
  const body = { requestId: crypto.randomUUID(), migrationId: 'staff-profile-pay-roles-v1', dryRun: false };
  const failed = await handlers.post({ env, request: jsonRequest('/api/employee-vault-migrate', body, owner) });
  assert.equal(failed.status, 503); assert.equal((await failed.json()).code, 'employee_vault_migration_unreadable');
  const receipt = () => [...fire.documents].find(([key]) => key.startsWith('employeeVaultMigrations/'))[1].fields;
  assert.equal(receipt().status.stringValue, 'failed'); assert.equal(receipt().errorCode.stringValue, 'EMPLOYEE_HUB_STORAGE_UNREADABLE');
  fire.documents.delete(`jobs/${corruptId}`);
  const retried = await (await handlers.post({ env, request: jsonRequest('/api/employee-vault-migrate', body, owner) })).json();
  assert.equal(retried.report.migrated, 2); assert.equal(receipt().status.stringValue, 'completed');
});

test('vault helpers: record reads keep revisions and fail closed, sealed fields match the stored shape, digests are keyed', async t => {
  const fire = vaultFirestore(t); await seed();
  const [row] = (await readCollectionRecords(env, 'profiles')).filter(item => item.data.id === 'crew.account');
  const stored = fire.documents.get(`jobs/${row.documentId}`);
  assert.equal(row.updateTime, stored.updateTime);
  const fields = await sealedFields(env, 'profiles', row.documentId, row.data, NOW);
  assert.deepEqual(Object.keys(encodeFirestoreFields(fields)).sort(), Object.keys(stored.fields).sort());
  assert.deepEqual(encodeFirestoreFields(fields).schemaVersion, { integerValue: '2' });
  assert.equal(fields.vaultId, row.documentId); assert.equal(fields.recordType, 'employee_hub_v2');
  await assert.rejects(sealedFields(env, 'customers', row.documentId, row.data, NOW), TypeError);
  await assert.rejects(sealedFields({ ...env, EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HUB_SESSION_SECRET' }, 'profiles', row.documentId, row.data, NOW), error => error.code === 'EMPLOYEE_HUB_RECOVERY_READ_ONLY');
  fire.documents.set(`jobs/${row.documentId}`, { ...stored, updateTime: '' });
  await assert.rejects(readCollectionRecords(env, 'profiles'), error => error.code === 'EMPLOYEE_HUB_STORAGE_UNREADABLE');
  fire.documents.set(`jobs/${row.documentId}`, stored);
  await assert.rejects(readCollectionRecords(env, 'accounts'), TypeError);
  const accounts = await employeeAccountRecords(env);
  assert.deepEqual(accounts.map(item => item.account.username).sort(), ['Crew.Account', 'Sales.Account']);
  assert.ok(accounts.every(item => item.updateTime && item.account.passwordHash), 'server-side records are complete');
  const sealed = await sealedAccountFields(env, accounts[0].account);
  assert.equal(sealed.documentId, accounts[0].documentId); assert.equal(sealed.fields.schemaVersion, 1); assert.equal(sealed.fields.accountStatus, 'approved');
  await assert.rejects(sealedAccountFields({ ...env, EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HUB_SESSION_SECRET' }, accounts[0].account), error => error.code === 'EMPLOYEE_ACCOUNT_RECOVERY_READ_ONLY');
  const digest = await vaultDigest(env, 'purpose-a', 'payload');
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(digest, await vaultDigest(env, 'purpose-b', 'payload'));
  assert.notEqual(digest, await vaultDigest({ ...env, EMPLOYEE_HUB_DATA_SECRET: 'another-synthetic-secret' }, 'purpose-a', 'payload'));
  assert.notEqual(digest, createHash('sha256').update('payload').digest('hex'));
  await assert.rejects(vaultDigest({}, 'purpose-a', 'payload'), error => error.code === 'EMPLOYEE_HUB_NOT_CONFIGURED');
  const listed = (await listEmployeeApplications(env)).map(item => [item.username, item.role, item.passwordHash, item.invitation]);
  assert.deepEqual(listed.sort(), [['Crew.Account', 'crew', undefined, undefined], ['Sales.Account', 'sales', undefined, undefined]]);
  await seedAccount(env, 'Forged.Sales', { extra: { role: 'sales' } });
  assert.equal((await listEmployeeApplications(env)).find(item => item.username === 'Forged.Sales').role, 'crew', 'a stored sales role needs the owner invitation');
});

test('vault commits map Firestore precondition answers to conflicts and anything unverifiable to an unknown outcome', async () => {
  const calls = [], reply = (status, body) => async (_env, url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); if (status instanceof Error) throw status; return Response.json(body, { status }); };
  const writes = [{ collection: 'jobs', id: 'secure_a', revision: '2026-09-22T12:00:00.000001Z', patch: { sealedPayload: 'x', schemaVersion: 2 } }, { collection: 'hub_audit', id: 'ffff', patch: { v: 1, actor: { id: 'zacb' } } }];
  const ok = await commitVaultDocuments(env, writes, reply(200, { writeResults: [{ updateTime: 't1' }, { updateTime: 't1' }] }));
  assert.equal(ok.writeResults.length, 2);
  assert.equal(calls[0].url, 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents:commit');
  assert.deepEqual(calls[0].body.writes.map(write => [write.update.name, write.updateMask.fieldPaths, write.currentDocument]), [
    ['projects/egcw-1ec83/databases/(default)/documents/jobs/secure_a', ['sealedPayload', 'schemaVersion'], { updateTime: '2026-09-22T12:00:00.000001Z' }],
    ['projects/egcw-1ec83/databases/(default)/documents/hub_audit/ffff', ['v', 'actor'], { exists: false }]]);
  assert.deepEqual(calls[0].body.writes[0].update.fields.schemaVersion, { integerValue: '2' });
  // Real Firestore answers a stale updateTime with 400 FAILED_PRECONDITION (a revision conflict, as in the shared firestore-errors classifier).
  for (const [status, code] of [[400, 'FAILED_PRECONDITION'], [409, 'ALREADY_EXISTS'], [409, 'ABORTED'], [404, 'NOT_FOUND'], [412, 'UNKNOWN']]) {
    await assert.rejects(commitVaultDocuments(env, writes, reply(status, { error: { code: status, status: code } })), error => error.code === 'EMPLOYEE_HUB_WRITE_CONFLICT' && error.status === 409, `${status} ${code}`);
  }
  for (const fetcher of [reply(400, { error: { status: 'INVALID_ARGUMENT' } }), reply(503, { error: { status: 'UNAVAILABLE' } }), reply(new TypeError('Synthetic network loss')), reply(200, { writeResults: [{ updateTime: 't' }] }), reply(200, { writeResults: [{ updateTime: 't' }, {}] }), reply(200, 'not-json')]) {
    await assert.rejects(commitVaultDocuments(env, writes, fetcher), error => error.code === 'EMPLOYEE_HUB_OUTCOME_UNKNOWN' && error.status === 503);
  }
  await assert.rejects(commitVaultDocuments(env, [], reply(200, {})), TypeError);
  await assert.rejects(commitVaultDocuments(env, [{ collection: 'jobs', id: '', patch: {} }], reply(200, {})), TypeError);
});

test('an unverifiable migration write stops the run early and a rerun picks up where it stopped', async t => {
  const fire = vaultFirestore(t); await seed();
  fire.hooks.commitStatus = 503;
  const report = await run({ dryRun: false });
  assert.deepEqual({ migrated: report.migrated, failed: report.failed, conflicts: report.conflicts, stoppedEarly: report.stoppedEarly }, { migrated: 0, failed: 1, conflicts: 0, stoppedEarly: true });
  assert.equal(fire.commits.length, 0, 'nothing further was written after the unknown outcome');
  assert.equal(report.items.filter(item => item.outcome === 'unknown').length, 1);
  const retry = await run({ dryRun: false, requestId: crypto.randomUUID() });
  assert.equal(retry.migrated, 2); assert.equal(fire.commits.length, 2);
  await assert.rejects(run({ requestId: 'not-a-uuid' }), error => error.code === 'employee_vault_migration_invalid_request');
  await assert.rejects(run({ actor: 'Zac B!' }), error => error.code === 'employee_vault_migration_actor_required' && error.status === 401);
});
