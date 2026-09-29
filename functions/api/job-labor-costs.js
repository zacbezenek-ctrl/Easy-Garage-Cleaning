import { getHubSession } from '../_lib/hub-session.js';
import { moneyStorage } from '../_lib/money-storage.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { laborCostViewer, listJobLabor, saveJobLabor } from '../_lib/job-labor-private.js';

const LIMIT = 4096;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// Reads also refuse sibling sites; writes refuse cross-site requests. A missing Origin is allowed only because the
// SameSite=Strict session cookie is required.
function sameOrigin(request, read = false) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site' || read && site && !['same-origin', 'none'].includes(site)) return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true;
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function failure(error) {
  if (/^job_labor_[a-z_]+$/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
  return reply(503, { ok: false, code: 'job_labor_unavailable', error: 'Job labor cost could not be verified. Keep this request and retry it unchanged; do not create another.' });
}

function requireManager(actor, env) {
  try { requireDispatcher(actor, env); }
  catch (error) {
    if (error.status === 401) throw Object.assign(new Error('Sign in to the Employee Hub to open job labor cost.'), { code: 'job_labor_sign_in_required', status: 401 });
    throw Object.assign(new Error('Only an operations manager or owner can open job labor cost.'), { code: 'job_labor_forbidden', status: 403 });
  }
}

/**
 * JOB-COST-PRIVACY: the owner-entered labor dollars for jobs, kept off the job documents every manager can read.
 * GET lists every job's labor record for a viewer who sees labor dollars (the owner; every manager with
 * EGC_STAFF_PAY_OWNER_ONLY=false) and answers laborCostHidden:true with no figures to any other manager, so the
 * finance board shows "Labor $ hidden". Any other account (a crew lead or sales account with business access) is
 * refused with 403 job_labor_forbidden whatever the flag says; the Hub shows that as "Labor $ hidden" too. POST {requestId, jobId, laborCents, expectedRevision} saves one job's figure:
 * whole cents, or null when the owner leaves labor blank (unknown). With the flag off the figure is also written onto
 * the job as costs.labor, as the Hub dialog did before. Neither depends on MONEY_API_ENABLED: the cost dialog saves here.
 */
export function jobLaborCostsHandlers({ session = getHubSession, storage = moneyStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!sameOrigin(request, true)) return reply(403, { ok: false, code: 'job_labor_origin_forbidden', error: 'Open job finances in the Employee Hub.' });
      try {
        const actor = laborCostViewer(await session(request, env), env); requireManager(actor, env);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'job_labor_query_invalid', error: 'Job labor costs take no filters.' });
        const asOf = now().toISOString();
        if (!actor.laborCostVisible) return reply(200, { ok: true, authority: 'employee_hub', laborCostHidden: true, jobs: null, asOf });
        return reply(200, { ok: true, authority: 'employee_hub', laborCostHidden: false, jobs: await listJobLabor(storage(env), actor), complete: true, asOf });
      } catch (error) { return failure(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'job_labor_origin_forbidden', error: 'Open job finances in the Employee Hub to save labor cost.' });
      try {
        const actor = laborCostViewer(await session(request, env), env); requireManager(actor, env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'job_labor_json_required', error: 'Labor cost changes must be sent as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok: false, code: 'job_labor_request_too_large', error: 'The labor cost request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok: false, code: 'job_labor_request_too_large', error: 'The labor cost request is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'job_labor_json_invalid', error: 'The labor cost request was incomplete. Refresh the form and try again.' }); }
        return reply(200, await saveJobLabor(storage(env), actor, input, now().toISOString()));
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = jobLaborCostsHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
