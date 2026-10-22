/** Crew performance (CREW-PERF, functions/_lib/crew-performance.js): one row per person for the last 30 and 90 Denver
 * days. Business accounts (the owner and managers) read; nobody writes. Hours and counts only: no pay, cost, price or
 * customer contact. Hub > Crew performance (employee-crew-performance.js) shows it.
 * GET /api/crew-performance => {ok, window:{start,end,shortStart,today}, last30:[rows], last90:[rows],
 *   sources:{timecards:'ok'|'unavailable'}, laborCoverage, asOf}.
 * Errors: {ok:false, code, error}; 400, 401, 403, 503 retry. */
import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { denverWorkDate, overtimePolicy } from '../_lib/timesheet-week.js';
import { addDays } from '../_lib/dispatch-time.js';
import { computeJobLaborCost } from '../_lib/job-labor-cost.js';
import { buildJobActuals, jobActualsWindow } from '../_lib/job-actuals.js';
import { requireJobActualsViewer } from '../_lib/job-actuals-settings.js';
import { crewPerformanceWindow, firstWorkStarts } from '../_lib/crew-performance.js';
import { JOB_ACTUALS_FIELDS } from './job-actuals.js';
import { readJobCostingTimecards } from './job-costing.js';

export const CREW_PERFORMANCE_FIELDS = Object.freeze([...new Set([...JOB_ACTUALS_FIELDS, 'time', 'endDate', 'crewLead', 'arrivalWindowStart', 'arrivalWindowEnd', 'arrivalWindow', 'assignmentSegments', 'fieldExecution.completion.hasIssues', 'fieldExecution.attention.status'])]);
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
function errorResponse(error) {
  const code = /^job_actuals_(sign_in_required|forbidden)$/.test(error?.code || '') ? error.code.replace(/^job_actuals_/, 'crew_performance_') : null;
  if (code) return reply(error.status, { ok: false, code, error: code.endsWith('sign_in_required') ? 'Sign in to review crew performance.' : 'Only business accounts can review crew performance.' });
  return reply(503, { ok: false, code: 'crew_performance_unavailable', error: 'Crew performance could not be loaded. Retry in a moment.' });
}

export function crewPerformanceHandlers({ session = getHubSession, dispatch = dispatchStorage, timecards = readJobCostingTimecards, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env).catch(() => null); requireJobActualsViewer(actor);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'crew_performance_request_invalid', error: 'Crew performance takes no query options.' });
        const at = now(), asOf = at.toISOString(), window = jobActualsWindow(denverWorkDate(asOf)), store = dispatch(env);
        const [jobs, roster] = await Promise.all([store.datedJobs(window.start, addDays(window.end, -1), [...CREW_PERFORMANCE_FIELDS]), store.roster()]);
        let cards = [], labor = { jobs: [] }, source = 'ok';
        try {
          cards = await timecards(env);
          labor = computeJobLaborCost({ timecards: cards, policy: overtimePolicy(env), start: window.start, end: window.end, laborCostHidden: true, now: asOf });
        } catch { source = 'unavailable'; cards = []; labor = { jobs: [] }; }
        const actuals = new Map(buildJobActuals({ jobs, labor, settings: {}, timecardsAvailable: source === 'ok', today: window.today, asOf }).rows.map(row => [row.jobId, row]));
        const starts = firstWorkStarts(cards), base = { jobs, labor, actuals, starts, roster, end: window.end };
        return reply(200, { ok: true, authority: 'employee_hub', asOf, window, last30: crewPerformanceWindow({ ...base, start: window.shortStart }), last90: crewPerformanceWindow({ ...base, start: window.start }),
          sources: { timecards: source }, laborCoverage: labor?.coverage ? { complete: labor.coverage.complete, reasons: labor.coverage.reasons } : null });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = crewPerformanceHandlers();
export const onRequestGet = handlers.get;
