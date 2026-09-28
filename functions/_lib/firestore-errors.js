// Firestore REST write failures, classified once for every store. Real
// Firestore (and its emulator) answers a stale or vanished
// currentDocument.updateTime with HTTP 400 FAILED_PRECONDITION, not 409/412,
// and a create-only (exists:false) collision with 409 ALREADY_EXISTS.
//   exists    409 ALREADY_EXISTS: a create-only write found the document.
//   stale     412, 400 FAILED_PRECONDITION, or any other 409 (ABORTED
//             transaction contention): the data moved and nothing was applied.
//   rejected  any other 4xx (INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED):
//             refused as sent. Never a revision conflict.
//   unknown   5xx, no status, or a 400 whose error status cannot be read.
// Stores keep their own error codes; only this classification is shared.

function parsed(body) {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch { return null; }
}

/** The Google error status ('FAILED_PRECONDITION', ...) from {error} or a one-row [{error}] stream, else ''. */
export function firestoreErrorStatus(body) {
  const value = parsed(body), error = (Array.isArray(value) ? value[0] : value)?.error;
  return error && typeof error === 'object' && typeof error.status === 'string' ? error.status : '';
}

export function classifyCommitFailure(status, body) {
  if (!Number.isInteger(status) || status < 400 || status > 499) return 'unknown';
  const code = firestoreErrorStatus(body);
  if (status === 409) return code === 'ALREADY_EXISTS' ? 'exists' : 'stale';
  if (status === 412) return 'stale';
  if (status === 400) return code === 'FAILED_PRECONDITION' ? 'stale' : code ? 'rejected' : 'unknown';
  return 'rejected';
}

/** Classifies a failed fetch Response, reading its body once. */
export async function commitFailure(response) {
  let body = null;
  try { body = await response.text(); } catch { /* An unreadable body leaves only the status. */ }
  return classifyCommitFailure(response?.status, body);
}

/** True when nothing was applied because the stored document differs from the precondition. */
export const commitConflict = kind => kind === 'stale' || kind === 'exists';
