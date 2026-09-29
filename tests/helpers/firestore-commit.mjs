import assert from 'node:assert/strict';
import { decodeFirestoreFields } from '../../functions/_lib/firestore-job.js';

// Emulates a Firestore documents:commit body over a test fake's documents.
// Like the real commit it is all or nothing: every precondition (updateTime,
// exists) is checked before any write is applied, and an updateMask merges the
// named fields into the stored document. read(path) returns {data, updateTime}
// or null; write(path, data, write) stores the merged document. Returns the
// paths written, or {stale} naming the first failed precondition.
export function applyFirestoreCommit(body, { read, write }) {
  const writes = body.writes.map(item => ({ item, path: decodeURIComponent(item.update.name.split('/documents/')[1] || '') }));
  assert.equal(new Set(writes.map(entry => entry.path)).size, writes.length, 'a commit never writes one document twice');
  for (const { item, path } of writes) {
    const current = read(path), precondition = item.currentDocument || {};
    if (precondition.exists === false ? current : precondition.exists === true ? !current : precondition.updateTime !== undefined && current?.updateTime !== precondition.updateTime) return { stale: path };
  }
  for (const { item, path } of writes) {
    const patch = decodeFirestoreFields(item.update.fields || {}), mask = item.updateMask?.fieldPaths;
    write(path, mask ? { ...(read(path)?.data || {}), ...Object.fromEntries(mask.map(key => [key, patch[key]])) } : patch, { mask: mask || Object.keys(patch), precondition: item.currentDocument || {} });
  }
  return { paths: writes.map(entry => entry.path) };
}
