/** Crew staffing (office): roster health, the dated jobs of the next 14 Denver days that have no crew or are short of
 * one, and what "Staff waiting jobs" would do. Rules: functions/_lib/crew-staffing.js. Hub > Dispatch > Crews & vehicles
 * and the Command center line (employee-crew-staffing.js) show it. Read only: staffing a job is the existing
 * POST /api/dispatch schedule.update with autoCrew:true, one job at a time, which re-checks every dispatch rule.
 * Session cookie: business access and dispatch.write (an owner or manager, configured Hub account or employee account);
 * crew, sales and phone bookers are refused before anything is read. No money is read or returned.
 * GET /api/crew-staffing => {ok, today, window:{startDate,endDate}, health:[{code,message,...}], unstaffed:[...],
 *   preview:[{jobId,date,crewId,crewName}|{jobId,date,reason,message}], previewSummary, counts}.
 * READ-BUDGET: the crews and roster GET /api/dispatch reads (dispatchResources, the employee roster), one bounded
 * range query on jobs.date for the 14 days (dispatch-storage.js datedJobs) and the multi-day jobs that started before
 * today and run into them (spanningJobs, the jobs(endDate, date) index; until it is deployed, the CREW_SCHEDULE_LOOKBACK_DAYS
 * before today, as the crew schedule does), all masked; never a jobs scan. Loaded when the Crews & vehicles panel or the
 * Command center opens; never polled. autoAssign says EGC_DISPATCH_CREW_AUTO_ASSIGN is on: without it nothing is staffed.
 * Errors: {ok:false, code, error}; 400, 401, 403, 503 retry. */
import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { canDispatch } from '../_lib/dispatch-permissions.js';
import { addDays, denverToday } from '../_lib/dispatch-time.js';
import { crewAutoAssignEnabled } from '../_lib/dispatch-crew-assign.js';
import { CREW_SCHEDULE_LOOKBACK_DAYS } from '../_lib/crew-schedule.js';
import { crewStaffing, staffingWindow } from '../_lib/crew-staffing.js';

// What the report reads of a jobs row: its schedule, crew and status, the customer's name and nothing about money.
export const CREW_STAFFING_FIELDS = Object.freeze(['type', 'recordType', 'status', 'pipelineStatus', 'customer', 'title', 'date', 'time', 'endDate', 'endTime',
  'assignedCrew', 'assignedTo', 'crewId', 'crewLead', 'crewNeeded', 'requiredCrewSize', 'assignmentSegments', 'employee', 'employeeId', 'allDay']);
/** The window's rows: those starting in it, and the multi-day ones that started before it and run into it. */
export async function staffingJobs(store, { startDate, endDate }) {
  const fields = [...CREW_STAFFING_FIELDS], days = store.datedJobs(startDate, endDate, fields);
  days.catch(() => {});
  if (typeof store.spanningJobs === 'function') {
    try { return [...await store.spanningJobs(startDate, fields), ...await days]; }
    catch (error) { if (error?.code !== 'dispatch_index_required') throw error; }
  }
  return [...await store.datedJobs(addDays(startDate, -CREW_SCHEDULE_LOOKBACK_DAYS), addDays(startDate, -1), fields), ...await days];
}
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

export function requireCrewStaffingViewer(session, env) {
  if (!session?.user) throw fail('crew_staffing_sign_in_required', 'Sign in to review crew staffing.', 401);
  if (!hasBusinessAccess(session) || !canDispatch(session, env)) throw fail('crew_staffing_forbidden', 'Only an owner or a manager who runs dispatch can review crew staffing.', 403);
}

export function crewStaffingHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        requireCrewStaffingViewer(await session(request, env), env);
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'crew_staffing_request_invalid', error: 'Crew staffing takes no query options.' });
        const at = now(), today = denverToday(at), { startDate, endDate } = staffingWindow(today), store = storage(env);
        const [resources, roster, jobs] = await Promise.all([store.resources(), store.roster(), staffingJobs(store, { startDate, endDate })]);
        const availability = [...resources.filter(row => row?.recordType === 'availability'), ...jobs.filter(row => row?.type === 'availability' || row?.recordType === 'crew_availability').map(row => ({ ...row, employeeId: row.employeeId || row.employee }))];
        return reply(200, crewStaffing({ crews: resources.filter(row => row?.recordType === 'crew'), roster, jobs, availability, today, asOf: at.toISOString(), autoAssign: crewAutoAssignEnabled(env) }));
      } catch (error) {
        if (/^crew_staffing_/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message });
        if (error?.code?.startsWith('EMPLOYEE_ACCOUNT') || error?.code === 'HUB_AUTH_CONFIGURATION' || error?.code === 'dispatch_roster_ambiguous') return reply(503, { ok: false, code: 'crew_staffing_roster_unavailable', error: 'The active employee roster could not be verified. Retry, or ask the Hub administrator to check employee accounts.' });
        return reply(503, { ok: false, code: 'crew_staffing_unavailable', error: 'Crew staffing could not be loaded. Retry in a moment.' });
      }
    },
  };
}

const handlers = crewStaffingHandlers();
export const onRequestGet = handlers.get;
