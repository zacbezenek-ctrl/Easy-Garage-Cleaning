import { isDeepStrictEqual } from 'node:util';
import { decodeFirestoreFields, decodeFirestoreValue, encodeFirestoreFields } from '../../functions/_lib/firestore-job.js';

// One in-memory Firestore behind the REST API, for end-to-end tests that run the Hub's real handlers with their real
// storage modules (dispatchStorage, the employee vault, the field store, the purchase list, the catalog, the staff
// directory) over a single shared set of documents. It answers what those modules send: document GET (with
// mask.fieldPaths) and PATCH (currentDocument.* and updateMask.fieldPaths query preconditions), collection scans,
// :runQuery (field, composite AND and unary filters; select masks; orderBy with the implicit __name__ order; startAt and
// endAt cursors; offset and limit; subcollection parents), :runAggregationQuery counts, :batchGet with masks,
// :beginTransaction / :rollback, and an atomic :commit with updateMask merges (dotted paths), deletes and per-write
// preconditions answered as real Firestore answers them (a stale updateTime or a missing document is 400
// FAILED_PRECONDITION, a create over an existing document is 409 ALREADY_EXISTS). Masks and orders are honoured, so a
// module that reads a field it did not ask for sees it missing here as it would in production.
// Every other host fails the request: nothing in a test built on this can reach HighLevel, Google or any live service.
export const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const FIRESTORE = 'firestore.googleapis.com';
const pathValue = (fields, path) => {
  let value = { mapValue: { fields } };
  for (const part of path.split('.')) {
    if (!value?.mapValue?.fields || !(part in value.mapValue.fields)) return undefined;
    value = value.mapValue.fields[part];
  }
  return value;
};
const kind = value => value === undefined ? 'missing' : Object.keys(value)[0];
const comparable = encoded => {
  const type = kind(encoded);
  if (type === 'integerValue' || type === 'doubleValue') return { rank: 2, value: Number(Object.values(encoded)[0]) };
  if (type === 'stringValue') return { rank: 4, value: encoded.stringValue };
  if (type === 'timestampValue') return { rank: 3, value: encoded.timestampValue };
  if (type === 'booleanValue') return { rank: 1, value: encoded.booleanValue ? 1 : 0 };
  if (type === 'nullValue') return { rank: 0, value: 0 };
  if (type === 'referenceValue') return { rank: 5, value: encoded.referenceValue };
  return { rank: 6, value: JSON.stringify(encoded) };
};
const compare = (a, b) => {
  const x = comparable(a), y = comparable(b);
  if (x.rank !== y.rank) return x.rank - y.rank;
  return x.value < y.value ? -1 : x.value > y.value ? 1 : 0;
};
const sameType = (a, b) => comparable(a).rank === comparable(b).rank;
const equal = (a, b) => a !== undefined && isDeepStrictEqual(decodeFirestoreValue(a), decodeFirestoreValue(b)) && sameType(a, b);

function matches(document, where) {
  if (!where) return true;
  if (where.compositeFilter) {
    const { op, filters } = where.compositeFilter;
    if (op === 'AND') return filters.every(filter => matches(document, filter));
    if (op === 'OR') return filters.some(filter => matches(document, filter));
    throw new Error(`Unsupported composite filter ${op}`);
  }
  if (where.unaryFilter) {
    const value = pathValue(document.fields, where.unaryFilter.field.fieldPath);
    if (where.unaryFilter.op === 'IS_NULL') return kind(value) === 'nullValue';
    if (where.unaryFilter.op === 'IS_NOT_NULL') return value !== undefined && kind(value) !== 'nullValue';
    throw new Error(`Unsupported unary filter ${where.unaryFilter.op}`);
  }
  const { field, op, value: expected } = where.fieldFilter || {};
  const actual = field.fieldPath === '__name__' ? { referenceValue: document.name } : pathValue(document.fields, field.fieldPath);
  switch (op) {
    case 'EQUAL': return equal(actual, expected);
    case 'NOT_EQUAL': return actual !== undefined && !equal(actual, expected);
    case 'LESS_THAN': return actual !== undefined && sameType(actual, expected) && compare(actual, expected) < 0;
    case 'LESS_THAN_OR_EQUAL': return actual !== undefined && sameType(actual, expected) && compare(actual, expected) <= 0;
    case 'GREATER_THAN': return actual !== undefined && sameType(actual, expected) && compare(actual, expected) > 0;
    case 'GREATER_THAN_OR_EQUAL': return actual !== undefined && sameType(actual, expected) && compare(actual, expected) >= 0;
    case 'ARRAY_CONTAINS': return kind(actual) === 'arrayValue' && (actual.arrayValue.values || []).some(item => equal(item, expected));
    case 'ARRAY_CONTAINS_ANY': return kind(actual) === 'arrayValue' && (actual.arrayValue.values || []).some(item => (expected.arrayValue.values || []).some(option => equal(item, option)));
    case 'IN': return (expected.arrayValue.values || []).some(option => equal(actual, option));
    case 'NOT_IN': return actual !== undefined && !(expected.arrayValue.values || []).some(option => equal(actual, option));
    default: throw new Error(`Unsupported field filter ${op}`);
  }
}
const inequalityFields = where => !where ? [] : where.compositeFilter ? where.compositeFilter.filters.flatMap(inequalityFields)
  : where.fieldFilter && !['EQUAL', 'ARRAY_CONTAINS', 'ARRAY_CONTAINS_ANY', 'IN'].includes(where.fieldFilter.op) ? [where.fieldFilter.field.fieldPath] : [];

// A field mask over encoded fields: dotted paths keep only that nested value.
function masked(fields, paths) {
  if (!paths) return structuredClone(fields);
  const out = {};
  for (const path of paths) {
    if (path === '__name__') continue;
    const value = pathValue(fields, path);
    if (value === undefined) continue;
    const parts = path.split('.');
    let target = out;
    for (const part of parts.slice(0, -1)) target = (target[part] ||= { mapValue: { fields: {} } }).mapValue.fields;
    target[parts.at(-1)] = structuredClone(value);
  }
  return out;
}
function setPath(fields, path, value) {
  const parts = path.split('.');
  let target = fields;
  for (const part of parts.slice(0, -1)) {
    if (kind(target[part]) !== 'mapValue') target[part] = { mapValue: { fields: {} } };
    target = target[part].mapValue.fields ||= {};
  }
  if (value === undefined) delete target[parts.at(-1)];
  else target[parts.at(-1)] = structuredClone(value);
}

export function crewDayFirestore(t) {
  const documents = new Map(), requests = [], commits = [], refused = [];
  let tick = 0, transactions = 0;
  const stamp = () => `2026-10-17T00:00:00.${String(++tick).padStart(9, '0')}Z`;
  const keyOf = name => decodeURIComponent(String(name).split('/documents/')[1] || '');
  const nameOf = key => `${ROOT}/${key}`;
  const view = (key, paths) => { const doc = documents.get(key); return { name: nameOf(key), fields: masked(doc.fields, paths), createTime: doc.createTime, updateTime: doc.updateTime }; };
  const error = (code, status, message = 'synthetic Firestore refusal') => Response.json({ error: { code, status, message } }, { status: code });
  const precondition = (key, condition) => {
    if (!condition) return null;
    const current = documents.get(key);
    if (condition.exists === false && current) return error(409, 'ALREADY_EXISTS');
    if (condition.exists === true && !current) return error(404, 'NOT_FOUND');
    if (condition.updateTime && current?.updateTime !== condition.updateTime) return error(400, 'FAILED_PRECONDITION');
    return null;
  };
  function query(parent, structuredQuery) {
    const { from: [source], where, select, orderBy = [], startAt, endAt, offset = 0, limit } = structuredQuery;
    const prefix = `${parent ? `${parent}/` : ''}${source.collectionId}/`;
    let rows = [...documents.keys()].filter(key => source.allDescendants ? key.split('/').at(-2) === source.collectionId && key.startsWith(parent ? `${parent}/` : '') : key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
      .map(key => ({ key, name: nameOf(key), fields: documents.get(key).fields })).filter(document => matches(document, where));
    const order = [...orderBy];
    for (const field of inequalityFields(where)) if (!order.some(item => item.field.fieldPath === field)) order.push({ field: { fieldPath: field }, direction: 'ASCENDING' });
    if (!order.some(item => item.field.fieldPath === '__name__')) order.push({ field: { fieldPath: '__name__' }, direction: order.at(-1)?.direction || 'ASCENDING' });
    const valueFor = (row, path) => path === '__name__' ? { referenceValue: row.name } : pathValue(row.fields, path);
    // Firestore leaves out every document that lacks an ordered field.
    rows = rows.filter(row => order.every(item => valueFor(row, item.field.fieldPath) !== undefined));
    const cmp = (a, b) => { for (const item of order) { const d = compare(valueFor(a, item.field.fieldPath), valueFor(b, item.field.fieldPath)) * (item.direction === 'DESCENDING' ? -1 : 1); if (d) return d; } return 0; };
    rows.sort(cmp);
    const cursor = (row, at) => { for (const [index, value] of at.values.entries()) { const item = order[index], d = compare(valueFor(row, item.field.fieldPath), value) * (item.direction === 'DESCENDING' ? -1 : 1); if (d) return d; } return 0; };
    if (startAt) rows = rows.filter(row => { const d = cursor(row, startAt); return startAt.before ? d >= 0 : d > 0; });
    if (endAt) rows = rows.filter(row => { const d = cursor(row, endAt); return endAt.before ? d < 0 : d <= 0; });
    rows = rows.slice(offset, limit === undefined ? undefined : offset + limit);
    const paths = select ? (select.fields || []).map(field => field.fieldPath) : null;
    return rows.map(row => view(row.key, paths));
  }
  function apply(writes) {
    const keys = writes.map(write => keyOf(write.update?.name || write.delete));
    if (new Set(keys).size !== keys.length) return error(400, 'INVALID_ARGUMENT', 'A commit cannot write one document twice.');
    for (const [index, write] of writes.entries()) {
      if (write.transform || write.updateTransforms) throw new Error('Field transforms are not faked');
      const refusal = precondition(keys[index], write.currentDocument);
      if (refusal) return refusal;
    }
    const updateTime = stamp();
    for (const [index, write] of writes.entries()) {
      const key = keys[index], existing = documents.get(key);
      if (write.delete) { documents.delete(key); continue; }
      let fields;
      if (write.updateMask) {
        fields = structuredClone(existing?.fields || {});
        for (const path of write.updateMask.fieldPaths || []) setPath(fields, path, pathValue(write.update.fields || {}, path));
      } else fields = structuredClone(write.update.fields || {});
      documents.set(key, { fields, createTime: existing?.createTime || updateTime, updateTime });
    }
    commits.push(writes.map((write, index) => ({ key: keys[index], delete: Boolean(write.delete), fields: write.update ? decodeFirestoreFields(write.update.fields || {}) : null, mask: write.updateMask?.fieldPaths || null })));
    return Response.json({ writeResults: writes.map(() => ({ updateTime })), commitTime: updateTime });
  }
  async function serve(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.hostname !== FIRESTORE) { refused.push(`${method} ${url.origin}${url.pathname}`); throw new Error(`Unexpected network request to ${url.hostname}: only the in-memory Firestore answers in this test`); }
    const marker = `/v1/${ROOT}`;
    if (!url.pathname.startsWith(marker)) throw new Error(`Unexpected Firestore path ${url.pathname}`);
    const rest = url.pathname.slice(marker.length), body = init.body ? JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) : null;
    const colon = rest.lastIndexOf(':'), action = colon >= 0 && !rest.slice(colon).includes('/') ? rest.slice(colon + 1) : '', path = decodeURIComponent((action ? rest.slice(0, colon) : rest).replace(/^\//, '').replace(/\/$/, ''));
    requests.push({ method, action, path, body, at: Date.now() });
    if (method === 'POST' && action === 'runQuery') { const rows = query(path, body.structuredQuery), readTime = stamp(); return Response.json(rows.length ? rows.map(document => ({ document, readTime })) : [{ readTime }]); }
    if (method === 'POST' && action === 'runAggregationQuery') {
      const { structuredQuery, aggregations } = body.structuredAggregationQuery, count = query(path, { ...structuredQuery, select: undefined }).length;
      return Response.json([{ result: { aggregateFields: Object.fromEntries(aggregations.map(item => [item.alias, { integerValue: String(item.count?.upTo ? Math.min(count, Number(item.count.upTo)) : count) }])) }, readTime: stamp() }]);
    }
    if (method === 'POST' && action === 'batchGet') {
      const paths = body.mask?.fieldPaths || null, readTime = stamp();
      return Response.json(body.documents.map(name => documents.has(keyOf(name)) ? { found: view(keyOf(name), paths), readTime } : { missing: name, readTime }));
    }
    if (method === 'POST' && action === 'beginTransaction') return Response.json({ transaction: Buffer.from(`synthetic-transaction-${++transactions}`).toString('base64') });
    if (method === 'POST' && action === 'rollback') return Response.json({});
    if (method === 'POST' && action === 'commit') return apply(body.writes || []);
    if (action) throw new Error(`Unexpected Firestore action ${method} :${action}`);
    const segments = path.split('/');
    if (method === 'GET' && segments.length % 2 === 1) {
      const paths = url.searchParams.getAll('mask.fieldPaths');
      const keys = [...documents.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).sort();
      return Response.json(keys.length ? { documents: keys.map(key => view(key, paths.length ? paths : null)) } : {});
    }
    if (method === 'GET') {
      // Real Firestore names the missing document in its message (catalog-store.js documentMissing reads it).
      if (!documents.has(path)) return error(404, 'NOT_FOUND', `Document "${nameOf(path)}" not found.`);
      const paths = url.searchParams.getAll('mask.fieldPaths');
      return Response.json(view(path, paths.length ? paths : null));
    }
    if (method === 'PATCH') {
      const condition = url.searchParams.get('currentDocument.exists') !== null ? { exists: url.searchParams.get('currentDocument.exists') === 'true' } : url.searchParams.get('currentDocument.updateTime') ? { updateTime: url.searchParams.get('currentDocument.updateTime') } : null;
      const mask = url.searchParams.getAll('updateMask.fieldPaths');
      const response = apply([{ update: { name: nameOf(path), fields: body.fields || {} }, ...(mask.length ? { updateMask: { fieldPaths: mask } } : {}), ...(condition ? { currentDocument: condition } : {}) }]);
      if (!response.ok) return response;
      return Response.json(view(path, null));
    }
    if (method === 'DELETE') return apply([{ delete: nameOf(path) }]);
    throw new Error(`Unexpected Firestore request ${method} ${url.pathname}`);
  }
  t.mock.method(globalThis, 'fetch', serve);
  return {
    documents, requests, commits, refused, fetch: serve,
    /** Seed a document (plain values) as an import or an earlier session left it. */
    put(key, data) { const updateTime = stamp(); documents.set(key, { fields: encodeFirestoreFields(data), createTime: updateTime, updateTime }); return updateTime; },
    /** The stored document as plain values, with its id and updateTime, or null. */
    get(key) { const doc = documents.get(key); return doc ? { ...decodeFirestoreFields(doc.fields), id: key.split('/').pop(), updateTime: doc.updateTime } : null; },
    list(collection) { return [...documents.keys()].filter(key => key.startsWith(`${collection}/`) && !key.slice(collection.length + 1).includes('/')).sort().map(key => this.get(key)); },
    /** Requests made since the mark, for read-budget checks. */
    mark: () => requests.length,
    since: mark => requests.slice(mark),
  };
}
