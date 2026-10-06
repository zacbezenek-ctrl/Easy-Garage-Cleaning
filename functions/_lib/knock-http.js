// Shared request/response handling for the /api/knock-* handlers.
import { knockFailure } from './knock-store.js';

export const reply = (status, body, headers = {}) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});

export function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

export async function readJson(request, limit = 16384) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw knockFailure('Canvassing changes must use JSON.', 415, 'knock_json_required');
  if (Number(request.headers.get('Content-Length')) > limit) throw knockFailure('That request is too large. Sync in smaller batches.', 413, 'knock_request_too_large');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > limit) throw knockFailure('That request is too large. Sync in smaller batches.', 413, 'knock_request_too_large');
  let body;
  try { body = JSON.parse(raw); } catch { throw knockFailure('The request was incomplete. Retry.', 400, 'knock_json_invalid'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw knockFailure('The request was incomplete. Retry.', 400, 'knock_json_invalid');
  return body;
}

export function errorResponse(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('knock_')) {
    return reply(error.status || 400, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  }
  return reply(503, { ok: false, code: 'knock_unavailable', error: 'Canvassing is unavailable right now. Your entries are kept on this phone; retry shortly.' });
}

export function csvResponse(filename, text) {
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export const signInRequired = () => knockFailure('Sign in to use canvassing.', 401, 'knock_sign_in_required');
export const forbiddenOrigin = () => knockFailure('Open canvassing from the crew app.', 403, 'knock_origin_forbidden');
