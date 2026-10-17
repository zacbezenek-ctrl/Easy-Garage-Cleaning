import { firebaseServiceAccountConfigured, firestoreFetch } from './firebase-service-account.js';
import { dispatchStorage } from './dispatch-storage.js';
import { employeeVaultReadOnly, employeeVaultSecret } from './employee-vault-key.js';
import { commitVaultDocuments, opaqueId, readCollectionRecords, sealedFields, vaultDigest } from './employee-vault.js';
import { employeeAccountsConfigured, employeeInvitationStore, listEmployeeApplications, sealedAccountFields } from './employee-accounts.js';
import { listHubUserProfiles } from './hub-session.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { CREW_PROFILES, approvedCrewPhoto, crewProfileKey, staffCrewPhotoUrl } from './crew-public-profile.js';

// Server-only receipts (default-deny Firestore rules). They hold a keyed digest of
// the request, never pay, skills or account data.
export const STAFF_DIRECTORY_RECEIPTS = 'staffDirectoryOperations';
const BASE = 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
// The team directory's crew names: only the crew records of dispatchResources (recordType 'crew', a handful of documents)
// and only the fields it shows, never the whole resources collection.
const CREW_FIELDS = ['recordType', 'name', 'memberIds', 'leadId', 'status', 'priority'], CREW_LIMIT = 200;
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code: 'staff_directory_' + code, status });

// The profile, the account (role changes), the receipt and the SEC-02 audit entry
// commit together, each with its own precondition: currentDocument.updateTime, or
// exists:false for a create (the receipt and audit entry are always creates).
export function staffDirectoryStorage(env, fetcher = firestoreFetch) {
  const documents = dispatchStorage(env, fetcher);
  return {
    configured: () => Boolean(employeeVaultSecret(env)) && firebaseServiceAccountConfigured(env),
    readOnly: () => employeeVaultReadOnly(env),
    async staff() {
      return { configured: listHubUserProfiles(env), accounts: employeeAccountsConfigured(env) ? await listEmployeeApplications(env) : [] };
    },
    profiles: () => readCollectionRecords(env, 'profiles'),
    async crews() {
      const response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: 'dispatchResources' }], where: { fieldFilter: { field: { fieldPath: 'recordType' }, op: 'EQUAL', value: { stringValue: 'crew' } } },
        select: { fields: CREW_FIELDS.map(fieldPath => ({ fieldPath })) }, limit: CREW_LIMIT } }) });
      const rows = response.ok ? await response.json().catch(() => null) : null;
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || row.error)) throw fail('storage_unavailable', 'Crews could not be loaded.');
      return rows.filter(row => row.document?.fields).map(row => ({ ...decodeFirestoreFields(row.document.fields), id: String(row.document.name || '').split('/').pop() }))
        .filter(crew => crew.id && crew.recordType === 'crew');
    },
    // Approved headshots (crew_public_profiles, the staff-only photo link dispatch shows), keyed by username.
    async photoUrls(keys) {
      const ids = [...new Set(keys.map(crewProfileKey).filter(Boolean))];
      const rows = ids.length ? await documents.readMany(CREW_PROFILES, ids) : [];
      return new Map(rows.map(row => [row.id, approvedCrewPhoto(row)]).filter(([, photo]) => photo).map(([id, photo]) => [id, staffCrewPhotoUrl(id, photo)]));
    },
    readAccount: username => employeeInvitationStore(env).read(username),
    async readReceipt(id) {
      try { return await documents.read(STAFF_DIRECTORY_RECEIPTS, id); }
      catch { throw fail('storage_unavailable', 'The staff directory could not verify this request. Keep it and retry.'); }
    },
    fingerprint: text => vaultDigest(env, 'staff-directory:receipt-v1', text),
    async commit({ profile, account, receipt, audit, now }) {
      const documentId = profile.documentId || await opaqueId(env, 'profiles', profile.id);
      const writes = [{ collection: 'jobs', id: documentId, revision: profile.revision || undefined, patch: await sealedFields(env, 'profiles', documentId, profile.data, now) }];
      if (account) {
        const sealed = await sealedAccountFields(env, account.account);
        writes.push({ collection: 'jobs', id: sealed.documentId, revision: account.version, patch: sealed.fields });
      }
      writes.push({ collection: STAFF_DIRECTORY_RECEIPTS, id: receipt.id, patch: receipt.data });
      if (audit) writes.push({ collection: audit.collection, id: audit.id, patch: audit.patch });
      let result;
      try { result = await commitVaultDocuments(env, writes, fetcher); }
      catch (error) {
        if (error?.code === 'EMPLOYEE_HUB_WRITE_CONFLICT') throw fail('revision_conflict', 'This staff record changed while saving. Refresh and review the latest before saving.', 409);
        throw fail('outcome_unknown', 'The save could not be verified. Retry the same request to safely check whether it saved.');
      }
      return { profileRevision: result.writeResults[0].updateTime };
    },
  };
}
