// Firestore REST access for the canvassing (knock_*) collections. Clients never touch these
// collections directly (firestore.rules denies them); every read and write goes through the
// /api/knock-* handlers, which authorize the Hub session first.
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields, encodeFirestoreValue } from './firestore-job.js';
import { commitFailure } from './firestore-errors.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;

export const KNOCK_COLLECTIONS = Object.freeze([
  'knock_settings', 'knock_reps', 'knock_neighborhoods', 'knock_houses', 'knock_assignments', 'knock_shifts',
  'knock_events', 'knock_sales', 'knock_days', 'knock_training', 'knock_payouts', 'knock_imports', 'knock_receipts',
]);

const COLLECTION = new Set(KNOCK_COLLECTIONS);
const DOC_ID = /^[A-Za-z0-9_.-]{1,150}$/;

export function knockFailure(message, status = 400, code = 'knock_invalid', details) {
  return Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
}

const unavailable = () => knockFailure('Canvassing storage is unavailable. Your entries are kept on this phone; retry when connected.', 503, 'knock_storage_unavailable');

export function safeDocId(id) {
  const value = String(id ?? '');
  if (!DOC_ID.test(value) || value === '.' || value === '..' || /^__.*__$/.test(value)) throw knockFailure('Invalid record id.', 400, 'knock_invalid_id');
  return value;
}

function docName(collection, id) {
  if (!COLLECTION.has(collection)) throw knockFailure('Unknown canvassing collection.', 500, 'knock_invalid_collection');
  return `${ROOT}/${collection}/${safeDocId(id)}`;
}

function decode(document) {
  if (!document?.name || !document.fields) return null;
  const parts = document.name.split('/');
  return { ...decodeFirestoreFields(document.fields), id: parts.pop(), __updateTime: document.updateTime || '' };
}

const strip = data => Object.fromEntries(Object.entries(data || {}).filter(([key, value]) => key !== 'id' && key !== '__updateTime' && value !== undefined));

/* Write builders. create: only if absent. set: replace whole document. patch: named fields only,
   guarded by updateTime when given, else by the document existing. upsert: named fields, no guard. */
export const write = {
  create: (collection, id, data) => ({ update: { name: docName(collection, id), fields: encodeFirestoreFields(strip(data)) }, currentDocument: { exists: false } }),
  set: (collection, id, data) => ({ update: { name: docName(collection, id), fields: encodeFirestoreFields(strip(data)) } }),
  patch: (collection, id, data, updateTime = '') => {
    const fields = strip(data);
    return {
      update: { name: docName(collection, id), fields: encodeFirestoreFields(fields) },
      updateMask: { fieldPaths: Object.keys(fields) },
      currentDocument: updateTime ? { updateTime } : { exists: true },
    };
  },
  upsert: (collection, id, data) => {
    const fields = strip(data);
    return { update: { name: docName(collection, id), fields: encodeFirestoreFields(fields) }, updateMask: { fieldPaths: Object.keys(fields) } };
  },
};

const OPS = { '==': 'EQUAL', '>=': 'GREATER_THAN_OR_EQUAL', '>': 'GREATER_THAN', '<=': 'LESS_THAN_OR_EQUAL', '<': 'LESS_THAN', in: 'IN', 'array-contains': 'ARRAY_CONTAINS' };

function whereClause(filters) {
  const list = (filters || []).map(([fieldPath, op, value]) => {
    if (op === '==' && value === null) return { unaryFilter: { field: { fieldPath }, op: 'IS_NULL' } };
    if (!OPS[op]) throw knockFailure('Unsupported query.', 500, 'knock_invalid_query');
    return { fieldFilter: { field: { fieldPath }, op: OPS[op], value: encodeFirestoreValue(value) } };
  });
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : { compositeFilter: { op: 'AND', filters: list } };
}

export function createKnockStore(env, fetcher = firestoreFetch) {
  const send = async (url, options) => { try { return await fetcher(env, url, options); } catch { throw unavailable(); } };
  const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function get(collection, id) {
    const response = await send(`${BASE}/${collection}/${encodeURIComponent(safeDocId(id))}`);
    if (response.status === 404) return null;
    if (!response.ok) throw unavailable();
    return decode(await response.json().catch(() => null));
  }

  async function getMany(collection, ids) {
    const unique = [...new Set(ids.map(safeDocId))];
    const found = new Map();
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const response = await send(`${BASE}:batchGet`, post({ documents: chunk.map(id => docName(collection, id)) }));
      if (!response.ok) throw unavailable();
      const rows = await response.json().catch(() => null);
      if (!Array.isArray(rows)) throw unavailable();
      for (const row of rows) {
        const doc = decode(row?.found);
        if (doc) found.set(doc.id, doc);
      }
    }
    return found;
  }

  /* where: [[field, op, value], ...]; orderBy: [[field, 'ASCENDING'|'DESCENDING']]. Pages through
     every match (page size 300) unless a limit is given. */
  async function query(collection, { where = [], orderBy = [], limit = 0, select = null } = {}) {
    if (!COLLECTION.has(collection)) throw knockFailure('Unknown canvassing collection.', 500, 'knock_invalid_collection');
    const order = [...orderBy.map(([fieldPath, direction = 'ASCENDING']) => ({ field: { fieldPath }, direction })), { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }];
    const results = [];
    let cursor = null;
    const pageSize = limit ? Math.min(limit, 300) : 300;
    for (;;) {
      const structuredQuery = {
        from: [{ collectionId: collection }],
        ...(where.length ? { where: whereClause(where) } : {}),
        orderBy: order,
        limit: pageSize,
        ...(select ? { select: { fields: [...select, '__name__'].map(fieldPath => ({ fieldPath })) } } : {}),
        ...(cursor ? { startAt: { values: cursor, before: false } } : {}),
      };
      const response = await send(`${BASE}:runQuery`, post({ structuredQuery }));
      if (!response.ok) {
        const detail = JSON.stringify(await response.json().catch(() => ({})));
        if (response.status === 400 && /FAILED_PRECONDITION|index/i.test(detail)) throw knockFailure('Canvassing storage is waiting for an index. Ask the owner to deploy firestore.indexes.json.', 503, 'knock_index_required');
        throw unavailable();
      }
      const rows = await response.json().catch(() => null);
      if (!Array.isArray(rows)) throw unavailable();
      const docs = rows.filter(row => row?.document).map(row => row.document);
      for (const document of docs) {
        const item = decode(document) || (document.name ? { id: document.name.split('/').pop(), __updateTime: document.updateTime || '' } : null);
        if (item) results.push(item);
      }
      if (limit && results.length >= limit) return results.slice(0, limit);
      if (docs.length < pageSize) return results;
      const last = docs[docs.length - 1];
      const lastFields = last.fields || {};
      cursor = [...orderBy.map(([fieldPath]) => lastFields[fieldPath] || { nullValue: null }), { referenceValue: last.name }];
    }
  }

  async function list(collection) {
    return query(collection);
  }

  // Applies writes atomically (chunks of 450 are separate commits; callers keep related writes small).
  async function commit(writes) {
    const all = writes.filter(Boolean);
    for (let i = 0; i < all.length; i += 450) {
      const response = await send(`${BASE}:commit`, post({ writes: all.slice(i, i + 450) }));
      if (!response.ok) {
        const kind = await commitFailure(response);
        if (kind === 'exists') throw knockFailure('That record already exists.', 409, 'knock_exists');
        if (kind === 'stale') throw knockFailure('That record changed while saving. Retry.', 409, 'knock_conflict');
        if (kind === 'rejected') throw knockFailure('Canvassing storage refused the change.', 400, 'knock_rejected');
        throw unavailable();
      }
    }
  }

  return { get, getMany, query, list, commit };
}
