// One commit write applied to an in-memory document the way functions/_lib/money-storage.js sends it to Firestore:
// the patch's top-level keys, or the write's `mask` field paths ('costs.labor' sets only that key of costs), take the
// patch's value (a path missing from the patch is deleted), and each `remove` path is deleted. The caller handles
// `delete: true` writes, preconditions, ids and revisions.
const clone = value => value === undefined ? undefined : structuredClone(value);

function setPath(row, path, patch) {
  const [head, key] = path.split('.');
  if (!key) { if (patch[head] === undefined) delete row[head]; else row[head] = clone(patch[head]); return; }
  const value = patch[head] && typeof patch[head] === 'object' ? patch[head][key] : undefined;
  if (value === undefined) { if (row[head] && typeof row[head] === 'object') { row[head] = { ...row[head] }; delete row[head][key]; } return; }
  row[head] = { ...(row[head] && typeof row[head] === 'object' ? row[head] : {}), [key]: clone(value) };
}

export function applyWrite(old, write) {
  const row = structuredClone(old || {});
  for (const path of write.mask || Object.keys(write.patch || {})) setPath(row, path, write.patch || {});
  for (const path of write.remove || []) setPath(row, path, {});
  return row;
}
