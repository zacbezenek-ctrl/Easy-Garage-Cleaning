import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { readEmployeeTimecards } from './employee-hub.js';
import { gustoConfiguration, gustoStatus, gustoRequest, gustoList } from '../_lib/gusto-client.js';
import { readGustoRecord, writeGustoRecord } from '../_lib/gusto-store.js';
import { createGustoTimecardService, gustoTimecardError } from '../_lib/gusto-timecards.js';

function reply(status, body) { return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  try { return new URL(request.headers.get('Origin')).origin === new URL(request.url).origin; } catch { return false; }
}
async function boundedJson(request) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) throw gustoTimecardError('Send a JSON request.', 415);
  if (Number(request.headers.get('Content-Length') || 0) > 16384) throw gustoTimecardError('The request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw gustoTimecardError('A request body is required.');
  let size = 0; const chunks = [];
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw gustoTimecardError('The request is too large.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw gustoTimecardError('The request must contain valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw gustoTimecardError('A JSON object is required.');
  return value;
}
const service = createGustoTimecardService({ readTimecards: readEmployeeTimecards, readRecord: readGustoRecord, writeRecord: writeGustoRecord, configuration: gustoConfiguration, status: gustoStatus, request: gustoRequest, list: gustoList });

export function createGustoSyncHandlers({ timecards = service, session = getHubSession } = {}) {
  async function authorize(request, env) {
    const user = await session(request, env);
    if (!user) throw gustoTimecardError('Sign in to the Employee Hub.', 401);
    if (String(user.user || '').trim().toLowerCase() !== 'zacb' || user.role !== 'owner' || !hasBusinessAccess(user)) throw gustoTimecardError('Only the EGC owner can manage the Gusto payroll connection.', 403);
  }
  function failed(error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
    return reply(status, { ok: false, error: error?.publicMessage || 'Gusto is unavailable. Review the connection and try again.' });
  }
  return {
    async onRequestGet({ request, env }) {
      try {
        await authorize(request, env);
        const url = new URL(request.url), view = url.searchParams.get('view') || 'preview';
        if (view === 'roster') return reply(200, { ok: true, employees: await timecards.roster(env) });
        if (view !== 'preview') throw gustoTimecardError('Unknown Gusto view.');
        return reply(200, { ok: true, ...await timecards.preview(env, url.searchParams.get('start'), url.searchParams.get('end')) });
      } catch (error) { return failed(error); }
    },
    async onRequestPost({ request, env }) {
      try {
        await authorize(request, env);
        if (!sameOrigin(request)) throw gustoTimecardError('Use the Gusto controls from this Employee Hub.', 403);
        const input = await boundedJson(request);
        if (input.action === 'map') return reply(200, { ok: true, ...await timecards.mapEmployee(env, input) });
        if (input.action === 'classify') return reply(200, { ok: true, ...await timecards.classify(env, input) });
        if (input.action === 'sync') return reply(200, { ok: true, ...await timecards.sync(env, input) });
        throw gustoTimecardError('Unknown Gusto action.');
      } catch (error) { return failed(error); }
    },
  };
}
export const { onRequestGet, onRequestPost } = createGustoSyncHandlers();
