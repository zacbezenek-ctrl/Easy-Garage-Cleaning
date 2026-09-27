import { getHubSession } from '../_lib/hub-session.js';
import { hubAuditStorage, listAudit, requireAuditReader } from '../_lib/hub-audit.js';

const KEYS = new Set(['entity', 'actor', 'startDate', 'endDate', 'cursor', 'limit']);
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });

// Reads are for the Hub page only: no cross-site or sibling-site fetches.
function sameOrigin(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

export function hubAuditHandlers({ session = getHubSession, storage = hubAuditStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'hub_audit_origin_forbidden', error: 'Open the audit log from the Employee Hub.' });
      try {
        const actor = await session(request, env); requireAuditReader(actor);
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (new Set(keys).size !== keys.length || keys.some(key => !KEYS.has(key))) return reply(400, { ok: false, code: 'hub_audit_query_invalid', error: 'Use only the supported audit filters, each at most once.' });
        const page = await listAudit(storage(env), Object.fromEntries(params), actor);
        return reply(200, { ok: true, authority: 'employee_hub', ...page, asOf: now().toISOString() });
      } catch (error) {
        if (error?.code?.startsWith('hub_audit_')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
        return reply(503, { ok: false, code: 'hub_audit_unavailable', error: 'The audit log could not be loaded. Retry.' });
      }
    },
    async readOnly() {
      return reply(405, { ok: false, code: 'hub_audit_read_only', error: 'The audit log is read-only.' }, { Allow: 'GET' });
    },
  };
}

const handlers = hubAuditHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.readOnly;
export const onRequestPut = handlers.readOnly;
export const onRequestPatch = handlers.readOnly;
export const onRequestDelete = handlers.readOnly;
