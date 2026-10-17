import { getHubSession, listHubUserProfiles } from '../_lib/hub-session.js';
import { employeeAccountsConfigured, listEmployeeApplications } from '../_lib/employee-accounts.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { createJobAssignmentAccess, assignmentKey } from '../_lib/job-assignment.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { addDays } from '../_lib/dispatch-time.js';
import { CREW_SCHEDULE_FIELDS, CREW_SCHEDULE_LOOKBACK_DAYS, canViewAllSchedules, crewSchedule, crewScheduleEnabled, scheduleWindow } from '../_lib/crew-schedule.js';

// CREW-SCHEDULE (WP6): GET /api/crew-schedule, the crew app's schedule by crew (functions/_lib/crew-schedule.js has the
// contract). Read only: there is no POST. Every signed-in staff member reads their own crews; scope=all needs
// schedule.view. Errors: 404 crew_schedule_disabled (EGC_CREW_SCHEDULE=false, before any read), 401
// crew_schedule_sign_in_required, 400 crew_schedule_range_invalid|crew_schedule_scope_invalid, 403 crew_schedule_forbidden,
// 503 crew_schedule_storage_unavailable (never a partial schedule).
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });

// Display names for the leads the schedule shows. Configured users cost no read; the encrypted employee accounts are
// read only when a lead is not one of them, and a failed lookup shows the username rather than hiding the schedule.
export async function leadNames(env, usernames) {
  if (!usernames?.size) return {};
  const names = {};
  for (const profile of listHubUserProfiles(env)) names[assignmentKey(profile.user)] = String(profile.displayName || profile.user);
  if ([...usernames].some(id => !names[id]) && employeeAccountsConfigured(env)) {
    for (const profile of await listEmployeeApplications(env).catch(() => [])) if (profile.status === 'approved') names[assignmentKey(profile.username || profile.user)] = String(profile.displayName || profile.username || '');
  }
  return Object.fromEntries([...usernames].filter(id => names[id]).map(id => [id, names[id].slice(0, 120)]));
}

export function crewScheduleHandlers({ session = getHubSession, storage = dispatchStorage, names = leadNames, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!crewScheduleEnabled(env)) return reply(404, { ok: false, code: 'crew_schedule_disabled', error: 'The crew schedule is turned off. Ask your manager for this week’s schedule.' });
      const actor = await session(request, env);
      if (!actor) return reply(401, { ok: false, code: 'crew_schedule_sign_in_required', error: 'Sign in to see your crew schedule.' });
      let window;
      try { window = scheduleWindow(new URL(request.url).searchParams, now()); }
      catch (error) { return reply(error.status || 400, { ok: false, code: error.code, error: error.message }); }
      if (window.scope === 'all' && !canViewAllSchedules(actor, env)) return reply(403, { ok: false, code: 'crew_schedule_forbidden', error: 'Every crew’s schedule needs the Team lead or Manager role. Ask the owner.' });
      if (!firebaseServiceAccountConfigured(env)) return reply(503, { ok: false, code: 'crew_schedule_storage_unavailable', error: 'Secure data access is not configured.' });
      try {
        const store = storage(env);
        const [crews, jobs] = await Promise.all([store.crewResources(), store.datedJobs(addDays(window.from, -CREW_SCHEDULE_LOOKBACK_DAYS), window.to, [...CREW_SCHEDULE_FIELDS])]);
        const body = await crewSchedule({ session: actor, env, crews, jobs, access: createJobAssignmentAccess(env, actor), names: ids => names(env, ids), ...window, now: now() });
        return reply(200, body);
      } catch {
        return reply(503, { ok: false, code: 'crew_schedule_storage_unavailable', error: 'The crew schedule could not be loaded. Retry when connected.' });
      }
    },
  };
}

const handlers = crewScheduleHandlers();
export const onRequestGet = handlers.get;
