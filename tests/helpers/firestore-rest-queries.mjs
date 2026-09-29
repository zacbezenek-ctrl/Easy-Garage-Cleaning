// Firestore REST fake for windowed dispatch reads: document GET, masked list
// scans with page tokens, :runQuery (field EQUAL/GREATER_THAN_OR_EQUAL/IN/
// ARRAY_CONTAINS, unary IS_NULL, orderBy with the implicit __name__ tiebreak,
// startAt cursors, select, limit), :runAggregationQuery (count; a requested
// readTime is recorded, not replayed), masked :batchGet, :commit with
// exists/updateTime preconditions and a no-op transaction. Like Firestore, a range filter only matches
// values of the operand's type and a missing field never matches. Every call
// is recorded; other hosts are refused.
import { decodeFirestoreFields, encodeFirestoreFields } from '../../functions/_lib/firestore-job.js';

export const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const decode = value => decodeFirestoreFields({ value }).value;
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function firestoreRest(seed = {}) {
  const documents = new Map(), calls = [];
  let clock = 0;
  const stamp = () => `2026-09-22T10:00:00.${String(++clock).padStart(6, '0')}Z`;
  const put = (path, data) => { documents.set(path, { name: `${ROOT}/${path}`, fields: encodeFirestoreFields(data), updateTime: stamp() }); return documents.get(path); };
  for (const [path, data] of Object.entries(seed)) put(path, data);
  const row = document => decodeFirestoreFields(document.fields || {});
  const collection = id => [...documents].filter(([path]) => path.startsWith(id + '/') && !path.slice(id.length + 1).includes('/')).map(([, document]) => document).sort(byName);
  const project = (document, paths) => paths?.length ? { ...document, fields: Object.fromEntries(Object.entries(document.fields || {}).filter(([key]) => paths.some(path => path.split('.')[0] === key))) } : document;
  function filter(where, document) {
    if (where.unaryFilter) { if (where.unaryFilter.op !== 'IS_NULL') throw new Error('Unsupported unary filter'); return row(document)[where.unaryFilter.field.fieldPath] === null; }
    if (where.compositeFilter) return where.compositeFilter.filters.every(item => filter(item, document));
    const { field, op, value } = where.fieldFilter, found = row(document)[field.fieldPath], expected = decode(value);
    if (found === undefined) return false;
    if (op === 'EQUAL') return kind(found) === kind(expected) && found === expected;
    if (op === 'GREATER_THAN_OR_EQUAL') return kind(found) === kind(expected) && found >= expected;
    if (op === 'IN') return expected.some(item => kind(item) === kind(found) && item === found);
    if (op === 'ARRAY_CONTAINS') return Array.isArray(found) && found.includes(expected);
    throw new Error('Unsupported field filter ' + op);
  }
  const key = (document, path) => path === '__name__' ? document.name : row(document)[path];
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function runQuery(query) {
    const orderBy = query.orderBy || [], range = query.where?.fieldFilter?.op === 'GREATER_THAN_OR_EQUAL' ? query.where.fieldFilter.field.fieldPath : null;
    if (range && orderBy[0]?.field.fieldPath !== range) return json({ error: { status: 'INVALID_ARGUMENT', message: 'The first orderBy must be the inequality field.' } }, 400);
    const paths = [...orderBy.map(item => item.field.fieldPath).filter(path => path !== '__name__'), '__name__'];
    let rows = collection(query.from[0].collectionId).filter(document => !query.where || filter(query.where, document))
      .sort((a, b) => { for (const path of paths) { const order = compare(key(a, path), key(b, path)); if (order) return order; } return 0; });
    if (query.startAt) {
      const values = query.startAt.values.map(value => value.referenceValue ?? decode(value));
      rows = rows.filter(document => { for (const [index, path] of paths.entries()) { const order = compare(key(document, path), values[index]); if (order) return order > 0; } return query.startAt.before !== false; });
    }
    rows = rows.slice(0, query.limit || undefined).map(document => project(document, query.select?.fields.map(field => field.fieldPath)));
    return json(rows.length ? rows.map(document => ({ document, readTime: '2026-09-22T10:00:00Z' })) : [{ readTime: '2026-09-22T10:00:00Z' }]);
  }
  function aggregate({ structuredQuery: query, aggregations }) {
    const rows = collection(query.from[0].collectionId).filter(document => !query.where || filter(query.where, document));
    // Only count is faked: Firestore restricts multi-field aggregations to documents holding every field.
    if (aggregations.some(item => !item.count)) throw new Error('Only count aggregations are faked');
    const fields = Object.fromEntries(aggregations.map(item => [item.alias, { integerValue: String(rows.length) }]));
    return json([{ result: { aggregateFields: fields }, readTime: '2026-09-22T10:00:00Z' }]);
  }
  function commit({ writes = [] }) {
    for (const write of writes) {
      const current = documents.get(write.update.name.split('/documents/')[1]);
      if (write.currentDocument?.exists === false && current) return json({ error: { status: 'ALREADY_EXISTS' } }, 409);
      if (write.currentDocument?.updateTime && current?.updateTime !== write.currentDocument.updateTime) return json({ error: { status: 'FAILED_PRECONDITION' } }, 400);
    }
    for (const write of writes) {
      const path = write.update.name.split('/documents/')[1], patch = decodeFirestoreFields(write.update.fields || {});
      put(path, { ...(documents.has(path) ? row(documents.get(path)) : {}), ...Object.fromEntries((write.updateMask?.fieldPaths || Object.keys(patch)).map(field => [field, patch[field]])) });
    }
    return json({ commitTime: '2026-09-22T10:00:00Z', writeResults: writes.map(() => ({})) });
  }
  async function fetcher(_env, input, options = {}) {
    const url = new URL(String(input)), marker = `/v1/${ROOT}`, method = (options.method || 'GET').toUpperCase();
    if (url.hostname !== 'firestore.googleapis.com' || !url.pathname.startsWith(marker)) throw new Error('Refused non-Firestore request: ' + url.hostname);
    const path = decodeURIComponent(url.pathname.slice(marker.length)).replace(/^\//, ''), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path, body, query: url.search });
    if (method === 'POST' && path === ':runQuery') return runQuery(body.structuredQuery);
    if (method === 'POST' && path === ':runAggregationQuery') return aggregate(body.structuredAggregationQuery);
    if (method === 'POST' && path === ':batchGet') return json(body.documents.map(name => { const document = documents.get(name.split('/documents/')[1]); return document ? { found: project(document, body.mask?.fieldPaths) } : { missing: name }; }));
    if (method === 'POST' && path === ':commit') return commit(body);
    // Lineage verification opens a transaction; this single-writer fake needs no isolation.
    if (method === 'POST' && path === ':beginTransaction') return json({ transaction: 'synthetic-transaction' });
    if (method === 'POST' && path === ':rollback') return json({});
    if (method !== 'GET') throw new Error(`Unsupported ${method} ${path}`);
    const parts = path.split('/');
    if (parts.length % 2 === 0) return documents.has(path) ? json(project(documents.get(path), url.searchParams.getAll('mask.fieldPaths'))) : json({ error: { status: 'NOT_FOUND' } }, 404);
    const all = collection(path), size = Number(url.searchParams.get('pageSize')) || 300, start = Number(url.searchParams.get('pageToken') || 0);
    const page = all.slice(start, start + size).map(document => project(document, url.searchParams.getAll('mask.fieldPaths')));
    return json({ ...(page.length ? { documents: page } : {}), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
  }
  return { documents, calls, put, fetcher, get: path => documents.has(path) ? { ...row(documents.get(path)), revision: documents.get(path).updateTime } : null,
    scans: collectionId => calls.filter(call => call.method === 'GET' && call.path === collectionId),
    queries: collectionId => calls.filter(call => call.path === ':runQuery' && call.body.structuredQuery.from[0].collectionId === collectionId) };
}
