// READ-BUDGET: writeOne saves a sealed vault record and its family's revision mark (employee-vault.js vaultSnapshot) in
// one :commit. Older inline Firestore fakes model that save only as a document PATCH. commitAsPatch(handler) wraps
// such a fake: a writeOne-shaped commit (one record update, optional currentDocument, plus the revision write) is
// replayed through the fake's own PATCH handling with the same precondition as query parameters, the mark is recorded
// in `marks` (a property of the returned function), and the reply is the commit answer Firestore gives. Anything else
// passes through unchanged. Synthetic data only.
const REVISION = '/documents/employee_vault_revisions/current';

export function commitAsPatch(handler) {
  const marks = [];
  const wrapped = async (input, options = {}) => {
    const url = new URL(String(input));
    if ((options.method || 'GET').toUpperCase() !== 'POST' || !url.pathname.endsWith(':commit')) return handler(input, options);
    const writes = JSON.parse(options.body).writes || [];
    const [record, mark] = writes;
    if (writes.length !== 2 || !mark?.update?.name.endsWith(REVISION) || !record?.update?.name.includes('/documents/jobs/')) return handler(input, options);
    const target = new URL(`/v1/${record.update.name}`, url.origin);
    for (const [key, value] of url.searchParams) target.searchParams.append(key, value);
    if (record.currentDocument?.exists === false) target.searchParams.set('currentDocument.exists', 'false');
    if (record.currentDocument?.updateTime) target.searchParams.set('currentDocument.updateTime', record.currentDocument.updateTime);
    const response = await handler(target.toString(), { ...options, method: 'PATCH', body: JSON.stringify({ fields: record.update.fields }) });
    if (!response.ok) return response;
    const saved = await response.clone().json().catch(() => ({}));
    marks.push(mark);
    const updateTime = saved?.updateTime || '2026-09-22T12:00:00.000000Z';
    return Response.json({ writeResults: [{ updateTime }, { updateTime }], commitTime: updateTime });
  };
  wrapped.marks = marks;
  return wrapped;
}
