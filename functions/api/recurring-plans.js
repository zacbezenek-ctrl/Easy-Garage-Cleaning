/** Recurring plans API. Session cookie, same-origin JSON, manager/owner only.
 * EGC_RECURRING_PLANS_ENABLED=true enables create/update/resume/extend; when it
 * is unset every existing plan can still be listed, paused or ended, and a saved
 * request still replays by its requestId so a lost response can be verified.
 * GET /api/recurring-plans?view=status => {ok,enabled}
 * GET /api/recurring-plans[?planId=id] => {ok,enabled,timeZone,plans:[Plan],roster,crews,vehicles,coverage}
 *   Plan occurrences/upcoming/attention are reconciled with the Dispatch jobs: state is scheduled,
 *   conflict, template, existing, not_generated, updating (following an applyToBooked edit), or cancelled|missing|moved|rescheduled|completed|
 *   off_pattern|covered when the job changed in Dispatch (recorded = the stored state, movedTo = its
 *   current date). attention lists future dates that are unscheduled, cancelled, removed or no
 *   longer on the series; a cancelled date clears once it is added to skipDates.
 * POST {action:'create',requestId,plan:{templateJobId,cadence,startDate?,time?,endTime?,spanDays?,
 *   endsOn?,count?,skipDates?,horizonDays?,notifyCustomer?:boolean,assignment?:{assignedCrew,crewLead,
 *   crewId,vehicleId,crewNeeded?,travelBufferMinutes?}}}  omitted schedule/crew fields come from the
 *   template job. Generated visits carry notify=notifyCustomer (default false: no customer reminders).
 *   Optional price: pricePerVisitCents (integer cents) and/or lineItems (1-12 required M3 estimate lines
 *   that must total it); null clears. Each generated visit then gets that estimate through money-service
 *   estimate.save (no deposit, valid 30 days after the visit, nothing sent), never replacing money a
 *   manager set on the visit or an approved, invoiced or paid visit. Prices are saved only while
 *   MONEY_API_ENABLED=true; until then visits are booked, their price waits (priced status 'waiting',
 *   reason money_api_disabled) and a save that sets a price warns price_waits_for_money_api.
 * POST {action:'update',requestId,planId,expectedRevision,plan:{...same fields except templateJobId},applyToBooked?:boolean}
 *   applyToBooked:true also moves booked visits the plan generated that have not started and still sit at
 *   their original slot (same date: new time/crew; a dropped date: the nearest new series date) and
 *   re-prices them; the changes run in the following extend calls (occurrence state 'updating') and are
 *   reported as warnings booked_visits_updating / booked_visits_kept; a later edit replaces changes that
 *   have not run yet (booked_visits_update_cancelled).
 * POST {action:'pause'|'resume'|'end',requestId,planId,expectedRevision}
 * POST {action:'extend',requestId,planId,expectedRevision,limit?:1..20}
 *   => {ok,plan,created:[DispatchJob],conflicts:[{date,jobId,code,message}],updated:[{date,jobId,from}],
 *       priced:[{date,jobId,status:'applied'|'skipped'|'failed'|'waiting',reason?}],blocked,complete,retryable}
 *   Call again with a NEW requestId and the returned plan.revision while complete is false, nothing
 *   is blocked and the last call made progress (created, updated or priced visits, or retryable:true;
 *   a call may only move or re-price booked visits). Every returned result (retryable:true included) is
 *   final for its requestId and replays unchanged; only a 503 (outcome unknown) is retried with the same
 *   requestId and body. A date whose slot is still held by a cancelled or moved booking is saved
 *   unscheduled (code recurring_slot_taken).
 * Other saves => {ok,requestId,plan,warnings,replayed?}. Keep the same requestId and body when retrying.
 * Plan cadence rules are documented in functions/_lib/recurring-plans.js. Updates, pauses and ends
 * never move or cancel visits already on the schedule; the response warns when that matters, and an
 * update names each booked visit the new series no longer includes (generated_visits_off_pattern,
 * visits:[{date,jobId}]).
 * Errors: {ok:false,code,error,details?}; 400 validation, 401, 403, 404 missing/disabled,
 * 409 revision/state/idempotency, 413, 415, 503 retry the same request. */
import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { moneyApiEnabled } from '../_lib/money-service.js';
import { mutateRecurringPlan, recurringPlansEnabled, recurringPlansOverview } from '../_lib/recurring-plan-service.js';

const LIMIT = 16000;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' } });
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function errorResponse(error) {
  if (/^(recurring_|dispatch_)/.test(error?.code || '')) return reply(error.status || 503, { ok:false, code:error.code, error:error.message, ...(error.details ? { details:error.details } : {}) });
  if (error?.code?.startsWith('EMPLOYEE_ACCOUNT') || error?.code === 'HUB_AUTH_CONFIGURATION') return reply(503, { ok:false, code:'recurring_roster_unavailable', error:'The active employee roster could not be verified. Retry before changing recurring work.' });
  return reply(503, { ok:false, code:'recurring_unavailable', error:'Recurring plans could not complete this request. Keep your changes and retry the same request.' });
}

export function recurringPlanHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const actor = await session(request, env); requireDispatcher(actor);
        const params = new URL(request.url).searchParams;
        if (new Set(params.keys()).size !== [...params.keys()].length) return reply(400, { ok:false, code:'recurring_request_invalid', error:'Each recurring plan filter can only be supplied once.' });
        return reply(200, { ...await recurringPlansOverview(storage(env), actor, Object.fromEntries(params), now(), { enabled: recurringPlansEnabled(env) }), viewer: { id: actor.user } });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok:false, code:'recurring_origin_forbidden', error:'Open recurring plans in the Employee Hub to save changes.' });
      try {
        const actor = await session(request, env); requireDispatcher(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok:false, code:'recurring_json_required', error:'Recurring plan changes must be submitted as JSON.' });
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413, { ok:false, code:'recurring_request_too_large', error:'The recurring plan request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413, { ok:false, code:'recurring_request_too_large', error:'The recurring plan request is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok:false, code:'recurring_json_invalid', error:'The recurring plan request was incomplete. Refresh the form and try again.' }); }
        return reply(200, await mutateRecurringPlan(storage(env), actor, input, now().toISOString(), { enabled: recurringPlansEnabled(env), pricing: moneyApiEnabled(env) }));
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = recurringPlanHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
