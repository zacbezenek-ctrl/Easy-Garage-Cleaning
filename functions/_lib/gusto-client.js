import { readGustoRecord, writeGustoRecord } from './gusto-store.js';
import { employeeVaultReadOnly, employeeVaultSecret } from './employee-vault-key.js';
import { firebaseServiceAccountConfigured } from './firebase-service-account.js';

const VERSION = '2026-06-15';
const TOKEN_KEY = 'oauth-tokens';
const UUID = '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
const uuidPattern = new RegExp(`^${UUID}$`);
const HOSTS = { demo: 'https://api.gusto-demo.com', production: 'https://api.gusto.com' };
const failure = (code, message, status = 503) => Object.assign(new Error(message), { code, status, publicMessage: message });
const reconnect = () => failure('GUSTO_RECONNECT_REQUIRED', 'Reconnect Gusto before syncing hours.');
const busy = () => failure('GUSTO_BUSY', 'Gusto is connecting. Try again shortly.', 409);

export function gustoConfiguration(env = {}) {
  const environment = ['demo', 'production'].includes(env.GUSTO_ENVIRONMENT) ? env.GUSTO_ENVIRONMENT : null;
  const companyUuid = uuidPattern.test(String(env.GUSTO_COMPANY_UUID || '')) ? env.GUSTO_COMPANY_UUID.toLowerCase() : null;
  let reason = '';
  if (!environment) reason = 'Gusto sync is not configured. Choose an explicit demo or production environment.';
  else if (environment === 'production' && env.GUSTO_PRODUCTION_APPROVED !== 'true') reason = 'Gusto production API approval is required before enabling sync.';
  else if (!companyUuid || !String(env.GUSTO_CLIENT_ID || '').trim() || !String(env.GUSTO_CLIENT_SECRET || '').trim()) reason = 'Gusto API credentials and the company UUID must be configured.';
  else {
    let redirect;
    try { redirect = new URL(env.GUSTO_REDIRECT_URI); } catch {}
    const productionRedirect = env.GUSTO_REDIRECT_URI === 'https://easygaragecleaning.com/api/gusto-auth';
    const localRedirect = environment === 'demo' && redirect && ['http:', 'https:'].includes(redirect.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) && redirect.pathname === '/api/gusto-auth' && !redirect.search && !redirect.hash && !redirect.username && !redirect.password && redirect.href === env.GUSTO_REDIRECT_URI;
    if (!productionRedirect && !localRedirect) reason = 'Configure the exact approved Gusto redirect address.';
    else if (!employeeVaultSecret(env) || employeeVaultReadOnly(env) || !firebaseServiceAccountConfigured(env)) reason = 'Gusto secure storage configuration needs attention.';
  }
  return { configured: !reason, environment, companyUuid, reason };
}
function requireConfiguration(env) {
  const config = gustoConfiguration(env);
  if (!config.configured) throw failure('GUSTO_NOT_CONFIGURED', config.reason);
  return config;
}
function base(env) { return HOSTS[requireConfiguration(env).environment]; }

export async function gustoStatus(env) {
  const config = gustoConfiguration(env);
  if (!config.configured) return { ...config, connected: false, message: config.reason };
  try {
    const record = await readGustoRecord(env, TOKEN_KEY);
    const state = record.data?.state;
    const connected = state === 'connected' && Boolean(record.data?.accessToken && record.data?.refreshToken);
    const message = connected ? (config.environment === 'demo' ? 'Connected to Gusto demo. No live payroll is affected.' : 'Connected to Gusto. Approved EGC hours can be sent for payroll review.') : state === 'refreshing' && record.data.leaseExpiresAt > Date.now() ? 'Gusto is connecting. Try again shortly.' : state ? 'Reconnect Gusto before syncing hours.' : 'Connect the EGC Gusto account to sync approved hours.';
    return { ...config, connected, reconnectRequired: Boolean(state && !connected && !(state === 'refreshing' && record.data.leaseExpiresAt > Date.now())), message };
  } catch { return { ...config, connected: false, message: 'Saved Gusto settings are unavailable. Check secure storage before reconnecting.' }; }
}

export function gustoAuthorizationUrl(env, state) {
  const url = new URL('/oauth/authorize', base(env));
  url.search = new URLSearchParams({ client_id: env.GUSTO_CLIENT_ID, redirect_uri: env.GUSTO_REDIRECT_URI, response_type: 'code', state });
  return url.href;
}
async function tokenExchange(env, grant) {
  let response;
  try {
    response = await fetch(`${base(env)}/oauth/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', 'X-Gusto-API-Version': VERSION }, body: JSON.stringify({ client_id: env.GUSTO_CLIENT_ID, client_secret: env.GUSTO_CLIENT_SECRET, redirect_uri: env.GUSTO_REDIRECT_URI, ...grant }) });
  } catch { throw reconnect(); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) < 60) throw reconnect();
  return { state: 'connected', accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Math.min(Number(data.expires_in), 86400) * 1000, connectedAt: new Date().toISOString() };
}
async function markReconnect(env, record) {
  try { await writeGustoRecord(env, TOKEN_KEY, { state: 'reconnect-required', changedAt: new Date().toISOString() }, record); } catch {}
}
export async function connectGustoAuthorization(env, code, expectedRecord) {
  const config = requireConfiguration(env);
  const expected = expectedRecord === undefined ? await readGustoRecord(env, TOKEN_KEY) : expectedRecord;
  const tokens = await tokenExchange(env, { grant_type: 'authorization_code', code });
  let response, info;
  try {
    response = await fetch(`${base(env)}/v1/token_info`, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${tokens.accessToken}`, 'X-Gusto-API-Version': VERSION } });
    info = await response.json();
  } catch { throw reconnect(); }
  if (!response.ok || info?.resource?.type !== 'Company' || String(info.resource.uuid || '').toLowerCase() !== config.companyUuid || info?.resource_owner?.type !== 'CompanyAdmin') throw failure('GUSTO_COMPANY_MISMATCH', 'The connected Gusto account must belong to the configured EGC company.', 403);
  await writeGustoRecord(env, TOKEN_KEY, tokens, expected);
  return { connected: true };
}

async function accessRecord(env) {
  requireConfiguration(env);
  let record = await readGustoRecord(env, TOKEN_KEY);
  if (!record.data) throw failure('GUSTO_NOT_CONNECTED', 'Connect Gusto before syncing hours.');
  if (record.data.state === 'refreshing') {
    if (record.data.leaseExpiresAt > Date.now()) throw busy();
    await markReconnect(env, record);
    throw reconnect();
  }
  if (record.data.state !== 'connected' || !record.data.accessToken || !record.data.refreshToken) throw reconnect();
  if (record.data.expiresAt > Date.now() + 60000) return record;
  try {
    record = await writeGustoRecord(env, TOKEN_KEY, { ...record.data, state: 'refreshing', leaseId: crypto.randomUUID(), leaseExpiresAt: Date.now() + 60000 }, record);
  } catch (error) {
    if (error.code === 'GUSTO_WRITE_CONFLICT') throw busy();
    throw error;
  }
  // The durable lease is never reused after timeout. Refresh tokens are single-use.
  try {
    const tokens = await tokenExchange(env, { grant_type: 'refresh_token', refresh_token: record.data.refreshToken });
    return await writeGustoRecord(env, TOKEN_KEY, { ...tokens, connectedAt: record.data.connectedAt }, record);
  } catch {
    await markReconnect(env, record);
    throw reconnect();
  }
}

function requestUrl(env, path, method) {
  const config = requireConfiguration(env);
  if (typeof path !== 'string' || !path.startsWith('/v1/') || /[\\#\s]/.test(path)) throw failure('GUSTO_PATH_FORBIDDEN', 'Unsupported Gusto request.', 400);
  const url = new URL(path, HOSTS[config.environment]);
  const companyBase = `/v1/companies/${config.companyUuid}`;
  const collection = url.pathname === `${companyBase}/time_tracking/time_sheets`;
  const single = new RegExp(`^/v1/time_tracking/time_sheets/${UUID}$`).test(url.pathname);
  const readable = url.pathname === `${companyBase}/employees` || new RegExp(`^/v1/employees/${UUID}/jobs$`).test(url.pathname);
  if (url.origin !== HOSTS[config.environment] || !(method === 'GET' && (readable || collection || single) || method === 'POST' && collection || method === 'PUT' && single)) throw failure('GUSTO_PATH_FORBIDDEN', 'Unsupported Gusto request.', 400);
  const allowedQuery = new Set(['page', 'per', 'limit', 'starting_after_uuid', 'start_date', 'end_date', 'entity_uuids', 'entity_type', 'status', 'sort_by', 'sort_order', 'before', 'after', 'include', 'terminated']);
  for (const [name, value] of url.searchParams) if (!allowedQuery.has(name) || value.length > 2000) throw failure('GUSTO_PATH_FORBIDDEN', 'Unsupported Gusto query.', 400);
  return url;
}
async function requestResult(env, path, { method = 'GET', body } = {}) {
  method = String(method).toUpperCase();
  const url = requestUrl(env, path, method);
  const record = await accessRecord(env);
  let response;
  try {
    response = await fetch(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${record.data.accessToken}`, 'X-Gusto-API-Version': VERSION, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw failure(method === 'GET' ? 'GUSTO_API_ERROR' : 'GUSTO_REQUEST_UNCERTAIN', method === 'GET' ? 'Gusto is unavailable. Try again shortly.' : 'Gusto did not confirm the update. Check the sync result before trying again.', 502); }
  if (response.status === 401) { await markReconnect(env, record); throw reconnect(); }
  if (!response.ok) throw failure(method !== 'GET' && response.status >= 500 ? 'GUSTO_REQUEST_UNCERTAIN' : 'GUSTO_API_ERROR', response.status === 403 ? 'Gusto access does not include the required permissions.' : response.status === 429 ? 'Gusto is busy. Try again shortly.' : method !== 'GET' && response.status >= 500 ? 'Gusto did not confirm the update. Check the sync result before trying again.' : 'Gusto could not complete the request. Review the selected employees and hours.', response.status >= 400 && response.status < 500 ? response.status : 502);
  const data = await response.json().catch(() => null);
  if (data === null || typeof data !== 'object') throw failure(method === 'GET' ? 'GUSTO_API_ERROR' : 'GUSTO_REQUEST_UNCERTAIN', 'Gusto returned an unrecognized response. Check the sync result before trying again.', 502);
  return { data, headers: response.headers };
}
export async function gustoRequest(env, path, options = {}) { return (await requestResult(env, path, options)).data; }

export async function gustoList(env, path) {
  const url = requestUrl(env, path, 'GET');
  const result = [], seen = new Set();
  for (let page = 1; page <= 100; page += 1) {
    url.searchParams.set('page', String(page));
    url.searchParams.set('per', '100');
    const { data, headers } = await requestResult(env, `${url.pathname}${url.search}`);
    if (!Array.isArray(data) || data.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw failure('GUSTO_API_ERROR', 'Gusto returned an unrecognized list. No sync was started.', 502);
    for (const item of data) {
      if (item.uuid) { if (seen.has(item.uuid)) throw failure('GUSTO_API_ERROR', 'Gusto returned inconsistent pages. Try again shortly.', 502); seen.add(item.uuid); }
      result.push(item);
    }
    const pagesText = headers.get('X-Total-Pages');
    if (pagesText !== null && (!/^\d+$/.test(pagesText) || Number(pagesText) > 100)) throw failure('GUSTO_API_ERROR', 'The Gusto list exceeds the supported sync size.', 502);
    if (pagesText !== null ? page >= Number(pagesText) : data.length < 100) return result;
  }
  throw failure('GUSTO_API_ERROR', 'The Gusto list exceeds the supported sync size.', 502);
}
