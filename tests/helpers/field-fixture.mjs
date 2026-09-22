import assert from 'node:assert/strict';
import { encodeFirestoreFields, decodeFirestoreFields } from '../../functions/_lib/firestore-job.js';

export function storage(t) {
  const documents = new Map(), drive = new Map(), calls = { commits: 0, uploads: 0, generated: 0, queries: [] }; let revision = 0;
  const document = (path, data) => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(data), updateTime: `2026-09-22T00:00:00.${String(++revision).padStart(9, '0')}Z` });
  const put = (path, data) => documents.set(path, document(path, data));
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'test-token' });
    if (url.hostname === 'www.googleapis.com') {
      if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: [`file-${++calls.generated}`] });
      if (url.pathname.startsWith('/upload/')) {
        calls.uploads++;
        const body = new TextDecoder().decode(options.body), metadata = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n--')[0]);
        const marker = Buffer.from(`Content-Type: ${metadata.mimeType}\r\n\r\n`), raw = Buffer.from(options.body);
        const start = raw.indexOf(marker) + marker.length, tail = Buffer.byteLength(`\r\n--${options.headers['Content-Type'].split('boundary=')[1]}--\r\n`);
        const image = raw.subarray(start, raw.length - tail);
        drive.set(metadata.id, { ...metadata, size: image.length, trashed: false, image }); return Response.json({ id: metadata.id });
      }
      const id = url.pathname.split('/').pop();
      if (url.searchParams.get('alt') === 'media') return drive.has(id) ? new Response(drive.get(id).image, { headers: { 'Content-Type': drive.get(id).mimeType } }) : new Response('', { status: 404 });
      return drive.has(id) ? Response.json(drive.get(id)) : Response.json({}, { status: 404 });
    }
    assert.equal(url.hostname, 'firestore.googleapis.com');
    const path = decodeURIComponent(url.pathname.split('/documents')[1] || '').replace(/^\//, '');
    if (path.endsWith(':runQuery') || path === ':runQuery') {
      const spec = JSON.parse(options.body).structuredQuery, collection = spec.from[0].collectionId; calls.queries.push(spec);
      const parent = path.replace(/:runQuery$/, '').replace(/\/$/, ''), prefix = `${parent ? `${parent}/` : ''}${collection}/`;
      let rows = [...documents.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).map(([, doc]) => doc);
      if (spec.where?.fieldFilter) { const f = spec.where.fieldFilter; rows = rows.filter(doc => { const v = decodeFirestoreFields(doc.fields)[f.field.fieldPath], expected = f.value.stringValue; return f.op === 'EQUAL' ? v === expected : v >= expected; }); }
      if (spec.orderBy) rows.sort((a, b) => { const x = decodeFirestoreFields(a.fields), y = decodeFirestoreFields(b.fields); return String(y.createdAt).localeCompare(String(x.createdAt)) || b.name.localeCompare(a.name); });
      if (spec.startAt) { const [at, id] = spec.startAt.values; rows = rows.filter(doc => { const row = decodeFirestoreFields(doc.fields); return row.createdAt < at.stringValue || row.createdAt === at.stringValue && doc.name < id.referenceValue; }); }
      return Response.json(rows.slice(0, spec.limit || rows.length).map(document => ({ document })));
    }
    if (path === ':commit') {
      const writes = JSON.parse(options.body).writes;
      for (const write of writes) {
        const key = write.update.name.split('/documents/')[1], existing = documents.get(key);
        if (write.currentDocument?.exists === false && existing || write.currentDocument?.updateTime && existing?.updateTime !== write.currentDocument.updateTime) return Response.json({}, { status: 412 });
      }
      for (const write of writes) {
        const key = write.update.name.split('/documents/')[1], old = decodeFirestoreFields(documents.get(key)?.fields || {}), patch = decodeFirestoreFields(write.update.fields);
        put(key, write.updateMask ? { ...old, ...patch } : patch);
      }
      calls.commits++; return Response.json({ commitTime: '2026-09-22T00:00:00Z' });
    }
    assert.equal(method, 'GET'); return documents.has(path) ? Response.json(documents.get(path)) : Response.json({}, { status: 404 });
  });
  return { put, documents, drive, calls, get: path => decodeFirestoreFields(documents.get(path)?.fields || {}), revision: id => documents.get(`jobs/${id}`)?.updateTime };
}
