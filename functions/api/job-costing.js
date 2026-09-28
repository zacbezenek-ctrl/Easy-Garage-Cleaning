import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { employeeVaultSecret } from '../_lib/employee-vault-key.js';
import { overtimePolicy } from '../_lib/timesheet-week.js';
import { computeJobLaborCost, validateJobCostingRange } from '../_lib/job-labor-cost.js';
import { readEmployeeTimecards } from './employee-hub.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const PARAMS = new Set(['start', 'end', 'jobId', 'includeTravel']);

// Swappable reader so the vault extraction can replace it without changing costing.
export async function readJobCostingTimecards(env) {
  if (!employeeVaultSecret(env) || !firebaseServiceAccountConfigured(env)) throw fail('Employee Hub storage is not configured.', 'job_costing_storage_unconfigured', 503);
  return readEmployeeTimecards(env);
}

function query(url) {
  const values = {};
  for (const [key, value] of new URL(url).searchParams) {
    if (!PARAMS.has(key) || Object.hasOwn(values, key)) throw fail('Use start, an exclusive end, and optional jobId or includeTravel once each.', 'job_costing_query_invalid');
    values[key] = value;
  }
  if (!['0', '1', undefined].includes(values.includeTravel)) throw fail('Use includeTravel=0 or 1.', 'job_costing_query_invalid');
  return { start: values.start, end: values.end, jobId: values.jobId ?? '', includeTravel: values.includeTravel === '1' };
}

export function jobCostingHandlers({ session = getHubSession, read = readJobCostingTimecards, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env);
        if (!actor?.user) throw fail('Sign in to review job labor costs.', 'job_costing_sign_in_required', 401);
        if (!hasBusinessAccess(actor)) throw fail('Only operations managers can review job labor costs.', 'job_costing_forbidden', 403);
        const input = query(request.url), policy = overtimePolicy(env);
        validateJobCostingRange(input);
        const timecards = await read(env);
        if (!Array.isArray(timecards)) throw fail('Timecards could not be read as a complete list.', 'job_costing_records_invalid', 503);
        return reply(200, { ok: true, ...computeJobLaborCost({ ...input, timecards, policy, now: now().toISOString() }) });
      } catch (error) {
        if (typeof error?.code === 'string' && (error.code.startsWith('job_costing_') || error.code === 'timesheet_policy_invalid')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
        return reply(503, { ok: false, code: 'job_costing_unavailable', error: 'Job labor costs could not be read safely. Retry, or contact the Hub administrator.' });
      }
    },
  };
}
const handlers = jobCostingHandlers();
export const onRequestGet = handlers.get;
