import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { fieldFailure, fieldId, fieldRequestId } from './field-execution.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const decode = document => document?.fields ? { ...decodeFirestoreFields(document.fields), id: String(document.name || '').split('/').pop(), __updateTime: document.updateTime || '' } : null;

export function createFieldStore(env) {
  async function read(path) {
    const response = await firestoreFetch(env, `${BASE}/${path}`);
    if (response.status === 404) return null;
    if (!response.ok) throw fieldFailure('Job storage is unavailable. Retry when connected.', 503, 'FIELD_STORAGE_UNAVAILABLE');
    return decode(await response.json());
  }
  async function query(parent, structuredQuery) {
    const response = await firestoreFetch(env, `${BASE}${parent ? `/${parent}` : ''}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery }) });
    if (!response.ok) throw fieldFailure('Job storage is unavailable. Retry when connected.', 503, 'FIELD_STORAGE_UNAVAILABLE');
    return (await response.json()).map(row => decode(row.document)).filter(Boolean);
  }
  return {
    readJob: id => read(`jobs/${id}`),
    readEvent: (id, requestId) => read(`jobs/${id}/fieldEvents/${requestId}`),
    readResource: id => fieldId(id) ? read(`dispatchResources/${id}`) : null,
    async listDays(start, end) {
      const days = [], cursor = new Date(`${start}T12:00:00Z`);
      while (cursor.toISOString().slice(0, 10) <= end) { days.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
      const queries = days.map(day => ({ from: [{ collectionId: 'jobs' }], where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: day } } } }));
      // A separate single-field query keeps multi-day work visible without a
      // new composite index or a full scan of all historical jobs.
      queries.push({ from: [{ collectionId: 'jobs' }], where: { fieldFilter: { field: { fieldPath: 'endDate' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: start } } } });
      const rows = (await Promise.all(queries.map(querySpec => query('', querySpec)))).flat();
      return [...new Map(rows.map(job => [job.id, job])).values()].filter(job => job.type === 'job' && !job.recordType && fieldId(job.id) && job.date <= end && (job.endDate || job.date) >= start);
    },
    async events(id, cursor = '') {
      const spec = { from: [{ collectionId: 'fieldEvents' }], orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }, { field: { fieldPath: '__name__' }, direction: 'DESCENDING' }], limit: 51 };
      if (cursor) {
        const [at, eventId, extra] = cursor.split('~');
        if (extra || !fieldRequestId(eventId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at || '')) throw fieldFailure('The history cursor is invalid.');
        spec.startAt = { values: [{ stringValue: at }, { referenceValue: `${ROOT}/jobs/${id}/fieldEvents/${eventId}` }], before: false };
      }
      const rows = await query(`jobs/${id}`, spec), page = rows.slice(0, 50), last = page.at(-1);
      return { events: page, cursor: rows.length > 50 && last ? `${last.createdAt}~${last.id}` : null };
    },
    async commit(job, patch, event, previousEvent = null) {
      if (!job.__updateTime) throw fieldFailure('The job version is unavailable. Reload before making changes.', 409, 'FIELD_REVISION_REQUIRED');
      const response = await firestoreFetch(env, `${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: [
        { update: { name: `${ROOT}/jobs/${job.id}`, fields: encodeFirestoreFields(patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { updateTime: job.__updateTime } },
        { update: { name: `${ROOT}/jobs/${job.id}/fieldEvents/${event.id}`, fields: encodeFirestoreFields(event) }, currentDocument: previousEvent?.__updateTime ? { updateTime: previousEvent.__updateTime } : { exists: false } },
      ] }) });
      if (response.status === 409 || response.status === 412) throw fieldFailure('This job changed while you were working. Refresh to review the changes, then retry.', 409, 'FIELD_REVISION_CONFLICT');
      if (!response.ok) throw fieldFailure('The change could not be saved. Retry with the same action to check its result.', 503, 'FIELD_STORAGE_UNAVAILABLE');
    },
  };
}
