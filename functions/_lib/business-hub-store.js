import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { commitConflict, commitFailure } from './firestore-errors.js';
import { fail, isId, parseBusinessActor, activeMember, rights } from './business-hub-core.js';
import { requireScopedLinkedJob } from './business-hub-scope.js';
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const DB = `https://firestore.googleapis.com/v1/${ROOT}`;
// Each collection accepts only its own id shape; private job records (_egc_, secure_) are never addressable here.
const RESERVED = /^(_egc_|secure_)/;
const safe = pattern => id => pattern.test(id) && !RESERVED.test(id);
const COLLECTIONS = Object.freeze({
  business_accounts: id => /^[a-f0-9]{32}$/.test(id), business_sessions: id => /^[a-f0-9]{64}$/.test(id), business_audit: id => /^[a-f0-9]{32}$/.test(id), business_operations: id => /^[a-f0-9]{32,64}$/.test(id),
  // SEC-B server-only Hub audit rows (40 hex) and confirmation receipts (sha256 hex) join business commits.
  hub_audit: id => /^[a-f0-9]{32,64}$/.test(id), confirm_tokens: id => /^[a-f0-9]{32,64}$/.test(id),
  jobs: safe(/^[A-Za-z0-9_-]{1,120}$/), customers: safe(/^[A-Za-z0-9_-]{1,180}$/), projects: safe(/^[A-Za-z0-9_-]{1,180}$/), customerIdentityState: id => id === 'revision',
});
// Staff account lists read only the fields the list shows (plus ownerStaff for access), not full 750KB workspaces.
export const LIST_FIELDS = Object.freeze(['company', 'status', 'ownerStaff', 'updatedAt', 'properties', 'requests']);
function path(collection, id) {
  if (!Object.hasOwn(COLLECTIONS, collection) || typeof id !== 'string' || !COLLECTIONS[collection](id)) throw fail(400, 'Invalid record identifier.');
  return `${collection}/${id}`;
}
function decode(doc) { return { ...decodeFirestoreFields(doc.fields || {}), id: doc.name.split('/').pop(), _version: doc.updateTime }; }
export function createBusinessStore(env, fetcher = firestoreFetch) {
  return {
    async read(collection, id) {
      const response = await fetcher(env, `${DB}/${path(collection, id)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw fail(503, 'Business records are temporarily unavailable. Please retry.');
      return decode(await response.json());
    },
    async commit(changes) {
      const writes = changes.map(({ collection, id, data, version, patch = false }) => {
        const fields = { ...data }; delete fields._version;
        return { update: { name: `${ROOT}/${path(collection, id)}`, fields: encodeFirestoreFields(fields) },
          currentDocument: version ? { updateTime: version } : { exists: false },
          ...(patch ? { updateMask: { fieldPaths: Object.keys(fields) } } : {}) };
      });
      const response = await fetcher(env, `${DB}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
      // Only a precondition failure is a 409; a 400 INVALID_ARGUMENT is not a conflict.
      if (!response.ok) throw fail(commitConflict(await commitFailure(response)) ? 409 : 503, 'The record changed or could not be saved. Refresh and retry; no partial update was applied.');
    },
    async list(profile, cursor = '') {
      if (profile.businessAccess === true) {
        const url = new URL(`${DB}/business_accounts`); url.searchParams.set('pageSize', '50');
        for (const field of LIST_FIELDS) url.searchParams.append('mask.fieldPaths', field);
        if (cursor) url.searchParams.set('pageToken', cursor);
        const response = await fetcher(env, url);
        if (!response.ok) throw fail(503, 'Business accounts could not be loaded.');
        const data = await response.json(); return { accounts: (data.documents || []).map(decode), next: data.nextPageToken || '' };
      }
      const response = await fetcher(env, `${DB}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
        select: { fields: LIST_FIELDS.map(fieldPath => ({ fieldPath })) }, from: [{ collectionId: 'business_accounts' }], where: { fieldFilter: { field: { fieldPath: 'ownerStaff' }, op: 'EQUAL', value: { stringValue: profile.user } } }, limit: 51,
      } }) });
      if (!response.ok) throw fail(503, 'Your business accounts could not be loaded.');
      const rows = (await response.json()).filter(row => row.document).map(row => decode(row.document));
      return { accounts: rows.slice(0, 50), next: '', limited: rows.length > 50 };
    },
    async jobs(ids) {
      if (!ids.length) return new Map();
      const response = await fetcher(env, `${DB}:batchGet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: ids.map(id => `${ROOT}/${path('jobs', id)}`) }) });
      if (!response.ok) throw fail(503, 'Linked projects could not be checked. Please retry; balances are not assumed to be zero.');
      const rows = await response.json();
      if (!Array.isArray(rows)) throw fail(503, 'Linked projects could not be checked.');
      return new Map(rows.filter(row => row.found).map(row => { const value = decode(row.found); return [value.id, value]; }));
    },
  };
}
/* Every delegated project request rechecks the account, member, exact project grant and the member's property access. */
export async function readBusinessProjectViewer(env, actorId, job, { store = createBusinessStore(env) } = {}) {
  const claims = parseBusinessActor(actorId);
  if (!isId(claims.accountId)) throw fail(403, 'Business access is invalid.');
  const account = await store.read('business_accounts', claims.accountId);
  const member = activeMember(account, claims.memberId, claims.version);
  requireScopedLinkedJob(account, member, job.id, job);
  const p = rights(member);
  return { name: member.name, permissions: { view: true, decide: p.decide === true, pay: p.pay === true, rebook: p.request === true } };
}
