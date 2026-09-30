import { firestoreFetch } from './firebase-service-account.js';

// A successful list also works when the jobs collection is empty. The mask keeps
// customer, payment, and job details out of this diagnostic response entirely.
const JOBS = 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/jobs?pageSize=1&mask.fieldPaths=status';
const SAFE_HTTP = new Set([400, 401, 403, 404, 429, 500, 502, 503, 504]);
const answer = (state, status) => ({ state, ...(SAFE_HTTP.has(status) ? { httpStatus: status } : {}) });

function httpResult(status, tokenExchange = false) {
  if (status === 401 || tokenExchange && status === 400) return answer('authentication', status);
  if (status === 403) return answer('permission', status);
  if (status === 429) return answer('quota', status);
  if (status === 404 || status === 400) return answer('setup', status);
  return answer('unavailable', status);
}

function failure(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return answer('timeout');
  // firestoreFetch is the only caller here. Its OAuth failure has this fixed
  // message; parse the status only and never return the message or response body.
  const oauth = /^Firebase service authentication failed \((\d{3})\)$/.exec(String(error?.message || ''));
  if (oauth) return httpResult(Number(oauth[1]), true);
  if (/^Firebase service account (?:is |does not )/.test(String(error?.message || ''))) return answer('authentication');
  return answer('unavailable');
}

/** Bounded server-account Firestore read. This does not test writes, browser
 * security rules, encrypted vault data, or Firebase Authentication sign-out. */
export async function firebaseReadStatus(env, fetcher = firestoreFetch, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(answer('timeout')); }, timeoutMs);
  });
  const read = (async () => {
    try {
      const response = await fetcher(env, JOBS, { method: 'GET', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return httpResult(response.status);
      }
      const body = await response.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body) || 'error' in body || body.documents !== undefined && (!Array.isArray(body.documents) || body.documents.length > 1)) return answer('invalid_response');
      return answer('readable');
    } catch (error) { return failure(error); }
  })();
  try { return await Promise.race([read, deadline]); }
  finally { clearTimeout(timer); }
}
