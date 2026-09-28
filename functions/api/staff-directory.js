import { getHubSession } from '../_lib/hub-session.js';
import { createStaffDirectoryService, staffDirectoryEnabled } from '../_lib/staff-directory.js';
import { staffDirectoryStorage } from '../_lib/staff-directory-storage.js';

const LIMIT = 16 * 1024;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
function errorResponse(error) {
  if (error?.code?.startsWith('staff_directory_')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  if (/^EMPLOYEE_(HUB|ACCOUNT)_/.test(error?.code || '')) return reply(503, { ok: false, code: 'staff_directory_storage_unreadable', error: 'Employee records could not be read safely. Nothing was changed; ask the owner to check the Hub setup.' });
  return reply(503, { ok: false, code: 'staff_directory_unavailable', error: 'The staff directory could not be verified. Keep your request and retry the same change.' });
}
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
const disabled = () => reply(503, { ok: false, code: 'staff_directory_not_enabled', error: 'The staff directory is not enabled yet.' });

export function staffDirectoryHandlers({ session = getHubSession, storage = staffDirectoryStorage, now = () => new Date() } = {}) {
  function service(env) {
    const store = storage(env);
    if (!store.configured()) throw Object.assign(new Error('Employee Hub storage is not configured.'), { code: 'staff_directory_not_configured', status: 503 });
    return createStaffDirectoryService({ store, env, now });
  }
  return {
    async get({ request, env }) {
      if (!staffDirectoryEnabled(env)) return disabled();
      try {
        const actor = await session(request, env);
        if (!actor?.user) return reply(401, { ok: false, code: 'staff_directory_sign_in_required', error: 'Sign in to view the staff directory.' });
        const params = new URL(request.url).searchParams, keys = [...params.keys()];
        if (keys.some(key => key !== 'username') || new Set(keys).size !== keys.length) return reply(400, { ok: false, code: 'staff_directory_invalid_query', error: 'Only one username filter is supported.' });
        return reply(200, await service(env).list(actor, params.has('username') ? { username: params.get('username') } : {}));
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'staff_directory_origin_forbidden', error: 'Open the staff directory in the Employee Hub to save changes.' });
      if (!staffDirectoryEnabled(env)) return disabled();
      try {
        const actor = await session(request, env);
        if (!actor?.user) return reply(401, { ok: false, code: 'staff_directory_sign_in_required', error: 'Sign in to change the staff directory.' });
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'staff_directory_json_required', error: 'Staff directory changes must use JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'staff_directory_request_too_large', error: 'The staff directory request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'staff_directory_request_too_large', error: 'The staff directory request is too large.' });
        let body; try { body = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'staff_directory_json_invalid', error: 'The staff directory request was incomplete. Retry from the form.' }); }
        return reply(200, await service(env).mutate(actor, body));
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = staffDirectoryHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
