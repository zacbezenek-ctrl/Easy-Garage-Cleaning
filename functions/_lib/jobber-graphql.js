/** Read-only Jobber GraphQL client shared by the JOB-CUT import
 * (scripts/jobber-import.mjs) and the FUN-32 coexistence guard
 * (functions/_lib/jobber-guard.js). It uses the same refresh-token grant as
 * functions/api/jobber-clients.js; keep Refresh Token Rotation OFF in the
 * Jobber app so a local run never orphans the deployed token; a grant that
 * returns a different refresh token (rotation on) stops the run before any
 * query. Pages back off on Jobber's rate limits. Only queries are sent (never a
 * mutation), and provider bodies and tokens never reach an error message. */
export const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
export const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql';
export const DEFAULT_JOBBER_GRAPHQL_VERSION = '2025-04-16';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Mints an access token and returns {query(document, variables), pages(document, field, variables)}.
 * Errors are Object.assign(new Error(message), {code: codePrefix + 'graphql_<reason>'}); `task`
 * names the work in messages ('export', 'check'), `alternative` is appended to the
 * set-up and reachability messages, and `scopes` lists the read access the app needs. */
export async function jobberGraphql(env, { fetcher = fetch, sleep = pause, version = DEFAULT_JOBBER_GRAPHQL_VERSION, maxPages = 2000, codePrefix = 'jobber_', task = 'export', alternative = '', scopes = 'clients, jobs, visits and invoices' } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code: `${codePrefix}graphql_${code}` });
  if (!env?.JOBBER_CLIENT_ID || !env.JOBBER_CLIENT_SECRET || !env.JOBBER_REFRESH_TOKEN) throw fail('not_configured', `Set JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET and JOBBER_REFRESH_TOKEN to read Jobber directly${alternative}.`);
  let response;
  try { response = await fetcher(JOBBER_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.JOBBER_REFRESH_TOKEN, client_id: env.JOBBER_CLIENT_ID, client_secret: env.JOBBER_CLIENT_SECRET }), signal: AbortSignal.timeout(20000) }); }
  catch { throw fail('unavailable', `Jobber could not be reached. Retry${alternative}.`); }
  const grant = await response.json().catch(() => ({}));
  if (!response.ok || typeof grant.access_token !== 'string' || !grant.access_token) throw fail('auth_failed', `Jobber did not accept the refresh token (HTTP ${response.status}). Re-authorize the Jobber app with read access to ${scopes}.`);
  if (typeof grant.refresh_token === 'string' && grant.refresh_token && grant.refresh_token !== env.JOBBER_REFRESH_TOKEN) throw fail('rotation_on', 'Jobber issued a new refresh token, so Refresh Token Rotation is on for the Jobber app and the deployed JOBBER_REFRESH_TOKEN may have stopped working. Turn rotation off in the Jobber Developer Center, re-authorize through /api/jobber-auth and update JOBBER_REFRESH_TOKEN in Cloudflare Pages and this shell. Nothing was read or written.');
  async function query(document, variables, attempt = 0) {
    if (typeof document !== 'string' || !/^\s*query\b/.test(document)) throw fail('failed', 'Only Jobber read queries are allowed. Nothing was written.');
    let reply;
    try { reply = await fetcher(JOBBER_GRAPHQL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${grant.access_token}`, 'X-JOBBER-GRAPHQL-VERSION': version }, body: JSON.stringify({ query: document, variables }), signal: AbortSignal.timeout(30000) }); }
    catch { throw fail('unavailable', `Jobber stopped responding during the ${task}. Nothing was written; retry.`); }
    const body = await reply.json().catch(() => null), throttled = reply.status === 429 || body?.errors?.some(error => error?.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 6) {
      const status = body?.extensions?.cost?.throttleStatus, needed = Number(body?.extensions?.cost?.requestedQueryCost) - Number(status?.currentlyAvailable), rate = Number(status?.restoreRate);
      await sleep(Number.isFinite(needed) && rate > 0 ? Math.min(60000, Math.max(1000, Math.ceil(needed / rate) * 1000)) : 5000);
      return query(document, variables, attempt + 1);
    }
    if (!reply.ok || !body || body.errors || !plain(body.data)) throw fail('failed', `Jobber rejected a query during the ${task} (HTTP ${reply.status}). Check the app's scopes and JOBBER_GRAPHQL_VERSION; nothing was written.`);
    return body.data;
  }
  async function pages(document, field, variables = {}) {
    const nodes = []; let after = null, count = 0;
    do {
      const connection = (await query(document, { ...variables, after }))[field];
      if (!plain(connection) || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') throw fail('incomplete', 'Jobber returned an incomplete page. Nothing was written; retry.');
      nodes.push(...connection.nodes);
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      if (connection.pageInfo.hasNextPage && (typeof after !== 'string' || !after) || ++count > maxPages) throw fail('incomplete', 'Jobber pagination did not finish. Nothing was written; retry.');
    } while (after);
    return nodes;
  }
  return { query, pages };
}
