import { firebaseServiceAccountConfigured, firestoreFetch } from './firebase-service-account.js';
import { dispatchStorage } from './dispatch-storage.js';
import { employeeVaultReadOnly, employeeVaultSecret } from './employee-vault-key.js';
import { listHubUserProfiles } from './hub-session.js';
import { EMPLOYEE_HUB_COLLECTIONS, commitVaultDocuments, readCollectionRecords, sealedFields, vaultDigest } from './employee-vault.js';
import { auditWrite } from './hub-audit.js';
import { employeeAccountRecords, sealedAccountFields } from './employee-accounts.js';
import { namedStaffRole } from './staff-invitation-service.js';
import { STAFF_ROLES } from './staff-roles.js';
import { LEGACY_EFFECTIVE_FROM, appendHistory, legacyPayType, personKey } from './staff-directory.js';

// Employee vault migrations: a pure, idempotent transform per record family. Every
// record is read and decrypted before anything is written, so one unreadable record
// aborts the run with no writes. Each change is re-sealed with a fresh IV under the
// same AAD (document id) and written with its currentDocument.updateTime, so a
// concurrent edit is counted as a conflict and never overwritten. The migration id
// is recorded in payload.migrations[], a history entry is appended and an owner-only
// SEC-02 audit entry (keyed by the opaque document id) joins the same commit.
export const VAULT_MIGRATION_FAMILIES = Object.freeze(['accounts', ...EMPLOYEE_HUB_COLLECTIONS, 'timeLocks']);
export const VAULT_MIGRATION_RECEIPTS = 'employeeVaultMigrations';
// Fields no migration may change. Gusto's content hash and review fingerprint are
// computed from the timecard fields listed here (gusto-timecards.js approvedTimecard).
export const PROTECTED_FIELDS = Object.freeze({
  accounts: ['username', 'usernameKey', 'passwordHash', 'passwordSalt', 'status', 'sessionVersion', 'invitation', 'email', 'role', 'businessAccess', 'hourlyRate', 'payType', 'appliedAt', 'reviewedAt', 'reviewedBy', 'updatedAt'],
  profiles: ['id', 'username', 'hourlyRate', 'payType', 'role', 'status', 'updatedAt'],
  timeEntries: ['id', 'employee', 'employeeName', 'clockInAt', 'clockOutAt', 'breaks', 'approvalStatus', 'approvedAt', 'approvedBy', 'status', 'hourlyRate', 'hours', 'grossEstimate', 'bonus', 'tips', 'jobId', 'jobTracking', 'workDate', 'updatedAt'],
  timeLocks: ['id', 'entryId', 'updatedAt'],
});
const RESERVED = ['migrations', 'history'];
const ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const fail = (code, message, status = 400, details) => Object.assign(new Error(message), { code: 'employee_vault_migration_' + code, status, ...(details ? { details } : {}) });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const protectedFields = family => PROTECTED_FIELDS[family] || ['id', 'updatedAt'];

export const VAULT_MIGRATIONS = Object.freeze(Object.fromEntries([
  {
    id: 'staff-profile-pay-roles-v1', family: 'profiles', scope: 'pay',
    description: 'Backfill the staff directory pay schedule (payRates) from hourlyRate/payType and staffRoles from role. Configured Hub users are skipped: their pay and roles stay in the Hub configuration.',
    transform(profile, { now, id, configuredUsers }) {
      if (configuredUsers.has(personKey(profile.username))) return null;
      const patch = {}, rate = Number(profile.hourlyRate);
      if (profile.payRates === undefined && profile.hourlyRate !== undefined && profile.hourlyRate !== null && Number.isFinite(rate) && rate >= 0) {
        const hourlyRate = Math.round(rate * 100) / 100;
        patch.payRates = [{ effectiveFrom: LEGACY_EFFECTIVE_FROM, hourlyRate, payType: legacyPayType(profile.payType), overtimeMultiplier: 1.5, setBy: `migration:${id}`, setAt: now, source: 'legacy_hourly_rate' }];
        patch.payRateMirror = { hourlyRate, effectiveFrom: LEGACY_EFFECTIVE_FROM, at: now };
      }
      if (profile.staffRoles === undefined) patch.staffRoles = [STAFF_ROLES.includes(profile.role) ? profile.role : 'crew'];
      return Object.keys(patch).length ? patch : null;
    },
  },
  {
    id: 'employee-account-staff-roles-v1', family: 'accounts', scope: 'roles',
    description: 'Record the current employee-account role (namedStaffRole) as staffRoles without revoking sessions.',
    transform(account) { return account.staffRoles === undefined ? { staffRoles: [namedStaffRole(account)] } : null; },
  },
].map(migration => [migration.id, Object.freeze(migration)])));

const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key] ?? null]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIT_ACTOR = /^[a-z0-9][a-z0-9_.@:+-]{0,119}$/;

export async function runVaultMigration({ store, migration, dryRun = true, now = new Date().toISOString(), actor, requestId = null }) {
  if (!record(migration) || !ID.test(migration.id || '') || !VAULT_MIGRATION_FAMILIES.includes(migration.family) || typeof migration.transform !== 'function') throw fail('unknown', 'Choose a registered employee vault migration.');
  if (typeof actor !== 'string' || !AUDIT_ACTOR.test(actor.trim().toLowerCase())) throw fail('actor_required', 'A signed-in owner must run employee vault migrations.', 401);
  if (requestId !== null && (typeof requestId !== 'string' || !UUID.test(requestId))) throw fail('invalid_request', 'The migration needs a valid request id.');
  if (store.readOnly()) throw fail('read_only', 'Employee setup is being verified. Existing records are preserved and cannot be migrated yet.', 503);
  const records = await store.list(migration.family), locked = protectedFields(migration.family), plan = [], items = [];
  const context = { now, actor, id: migration.id, configuredUsers: new Set(store.configuredUsers()) };
  const report = { migrationId: migration.id, family: migration.family, dryRun: dryRun !== false, scanned: records.length, alreadyApplied: 0, unchanged: 0, eligible: 0, migrated: 0, conflicts: 0, failed: 0, stoppedEarly: false };
  for (const row of records) {
    if (!record(row?.data) || typeof row.updateTime !== 'string' || !row.updateTime || typeof row.documentId !== 'string' || !row.documentId) throw fail('unreadable', 'An employee record could not be verified. Nothing was migrated.', 503);
    const data = row.data;
    if (Array.isArray(data.migrations) && data.migrations.includes(migration.id)) { report.alreadyApplied++; items.push({ id: row.id, outcome: 'already_applied' }); continue; }
    const patch = migration.transform(JSON.parse(JSON.stringify(data)), context);
    if (patch === null || patch === undefined) { report.unchanged++; items.push({ id: row.id, outcome: 'unchanged' }); continue; }
    const keys = record(patch) ? Object.keys(patch) : [];
    if (!keys.length || keys.some(key => locked.includes(key) || RESERVED.includes(key))) throw fail('protected_field', `Migration ${migration.id} tried to change a protected field. Nothing was migrated.`, 500, { recordId: row.id });
    const next = { ...data, ...patch, migrations: [...(Array.isArray(data.migrations) ? data.migrations : []), migration.id],
      history: appendHistory(data.history, { action: `migration:${migration.id}`, scope: migration.scope || 'migration', actor, at: now, reason: migration.description || '', changes: { before: pick(data, keys), after: pick(patch, keys) } }) };
    if (locked.some(key => JSON.stringify(next[key]) !== JSON.stringify(data[key]))) throw fail('protected_field', `Migration ${migration.id} tried to change a protected field. Nothing was migrated.`, 500, { recordId: row.id });
    // Vault payloads are sealed; the plaintext audit entry names the changed keys, never their values.
    const audit = auditWrite({ actor: { id: actor.trim().toLowerCase(), kind: 'human', role: 'owner' }, via: 'hub', action: 'employee_vault.migrate', entity: { collection: `vault_${migration.family}`, id: row.documentId },
      before: Object.fromEntries(keys.map(key => [key, data[key] === undefined ? null : '[sealed:before]'])), after: Object.fromEntries(keys.map(key => [key, '[sealed:after]'])),
      requestId, reason: `${migration.id}: ${migration.description || 'employee vault migration'}`, visibility: 'owner', now });
    plan.push({ row, next, audit });
  }
  report.eligible = plan.length;
  if (report.dryRun) return { ...report, items: [...items, ...plan.map(({ row }) => ({ id: row.id, outcome: 'eligible' }))].slice(0, 500) };
  for (const { row, next, audit } of plan) {
    try { await store.write(migration.family, row, next, now, audit); report.migrated++; items.push({ id: row.id, outcome: 'migrated' }); }
    catch (error) {
      if (error?.code === 'employee_vault_migration_conflict') { report.conflicts++; items.push({ id: row.id, outcome: 'conflict' }); continue; }
      report.failed++; report.stoppedEarly = true; items.push({ id: row.id, outcome: 'unknown' });
      break;
    }
  }
  return { ...report, items: items.slice(0, 500) };
}

export function vaultMigrationStorage(env, fetcher = firestoreFetch) {
  const documents = dispatchStorage(env, fetcher);
  const unavailable = () => fail('storage_unavailable', 'Employee vault migration storage is unavailable. Nothing further was changed; retry later.', 503);
  return {
    configured: () => Boolean(employeeVaultSecret(env)) && firebaseServiceAccountConfigured(env),
    readOnly: () => employeeVaultReadOnly(env),
    configuredUsers: () => listHubUserProfiles(env).map(profile => personKey(profile.user)),
    async list(family) {
      if (family === 'accounts') return (await employeeAccountRecords(env)).map(row => ({ id: row.account.username, documentId: row.documentId, updateTime: row.updateTime, data: row.account }));
      return (await readCollectionRecords(env, family)).map(row => ({ id: row.data.id, ...row }));
    },
    async write(family, row, next, now, audit) {
      let patch;
      if (family === 'accounts') {
        const sealed = await sealedAccountFields(env, next);
        if (sealed.documentId !== row.documentId) throw fail('protected_field', 'A migrated account changed its identity. Nothing was written.', 500);
        patch = sealed.fields;
      } else patch = await sealedFields(env, family, row.documentId, next, next.updatedAt || now);
      const writes = [{ collection: family === 'timeLocks' ? 'employee_time_locks' : 'jobs', id: row.documentId, revision: row.updateTime, patch }];
      if (audit) writes.push({ collection: audit.collection, id: audit.id, patch: audit.patch });
      try { await commitVaultDocuments(env, writes, fetcher); }
      catch (error) {
        if (error?.code === 'EMPLOYEE_HUB_WRITE_CONFLICT') throw fail('conflict', 'This record changed during the migration; it was left unchanged.', 409);
        throw fail('outcome_unknown', 'The migration write could not be verified. Run the migration again; applied records are skipped.', 503);
      }
    },
    async readReceipt(id) {
      try { return await documents.read(VAULT_MIGRATION_RECEIPTS, id); } catch { throw unavailable(); }
    },
    async saveReceipt(id, revision, data) {
      try { return (await commitVaultDocuments(env, [{ collection: VAULT_MIGRATION_RECEIPTS, id, revision: revision || undefined, patch: data }], fetcher)).writeResults[0].updateTime; }
      catch (error) { throw error?.code === 'EMPLOYEE_HUB_WRITE_CONFLICT' ? fail('receipt_conflict', 'This migration request is already recorded. Refresh the migration status.', 409) : unavailable(); }
    },
    fingerprint: text => vaultDigest(env, 'employee-vault-migration:receipt-v1', text),
  };
}
