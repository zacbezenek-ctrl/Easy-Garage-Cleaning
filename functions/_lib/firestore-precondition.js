/**
 * Firestore answers a commit whose currentDocument.updateTime is stale with
 * 400 FAILED_PRECONDITION. dispatchStorage reads any 400 as a lost response
 * (outcome unknown), so stores built on it wrap their fetcher with this one:
 * a stale revision on :commit is reported as the 409 conflict it is, and a
 * retry is never asked to "verify" a write that provably did not apply.
 */
export function preconditionFetcher(fetcher) {
  return async (env, url, init) => {
    const response = await fetcher(env, url, init);
    if (response?.status !== 400 || !/:commit$/.test(new URL(String(url)).pathname)) return response;
    const detail = await (typeof response.clone === 'function' ? response.clone() : response).json().catch(() => null);
    return detail?.error?.status === 'FAILED_PRECONDITION' ? new Response(JSON.stringify(detail), { status: 409, headers: { 'Content-Type': 'application/json' } }) : response;
  };
}
