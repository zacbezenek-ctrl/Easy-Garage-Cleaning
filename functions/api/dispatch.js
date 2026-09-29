import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { dispatchOverview, mutateDispatch } from '../_lib/dispatch-service.js';
import { bookerAuthorize, mutateBooking, requireScheduleAccess } from '../_lib/dispatch-booking.js';
import { travelEstimator } from '../_lib/dispatch-travel.js';
import { dispatchFunnelOptions } from '../_lib/dispatch-funnel.js';
import { crewRosterPhotoStore } from '../_lib/crew-public-profile.js';

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' } });
}

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function errorResponse(error) {
  if (error?.code?.startsWith('dispatch_')) return reply(error.status || 503, {ok:false,code:error.code,error:error.message,...(error.details ? {details:error.details} : {})});
  if (error?.code?.startsWith('EMPLOYEE_ACCOUNT') || error?.code === 'HUB_AUTH_CONFIGURATION') return reply(503,{ok:false,code:'dispatch_roster_unavailable',error:'The active employee roster could not be verified. Ask the Hub administrator to check employee account access before assigning work.'});
  return reply(503,{ok:false,code:'dispatch_unavailable',error:'Dispatch could not complete this request. Keep your changes and retry.'});
}

// A booker sees when an employee is away, never the time-off note (a manager's to read).
const AWAY_FIELDS = ['id','revision','type','recordType','employee','employeeId','date','endDate','time','endTime','allDay','status','startAt','endAt','timeZone'];
const away = row => Object.fromEntries(AWAY_FIELDS.filter(key => row?.[key] !== undefined).map(key => [key, row[key]]));

// Dependency injection permits full request/permission tests without changing
// production environment flags, cookies, Firestore credentials or the clock.
// Reads take the Date; mutations take its ISO string (dispatch-contract.js).
// A schedule.book holder (EGC_STAFF_ROLE_ACCESS, dispatch-booking.js) reads the
// board and saves only what mutateBooking allows; everyone else needs dispatch.write.
export function dispatchHandlers({ session = getHubSession, storage = dispatchStorage, travel = travelEstimator, now = () => new Date() } = {}) {
  return {
    async get({request,env}) {
      try {
        const actor = await session(request,env), access = requireScheduleAccess(actor,env);
        const params = Object.fromEntries(new URL(request.url).searchParams.entries());
        const store = storage(env), photos = crewRosterPhotoStore(store), overview = await dispatchOverview(photos.store,actor,params,now(),{travel:travel({env,store,now}),...(access.booker ? {authorize:bookerAuthorize(env)} : {})});
        // Approved crew headshots (P4-07), read alongside the job scans; an unreadable profile store leaves the roster unchanged.
        return reply(200,{...overview,...(Array.isArray(overview.roster) ? {roster:await photos.attach(overview.roster)} : {}),...(access.booker && Array.isArray(overview.availability) ? {availability:overview.availability.map(away)} : {}),viewer:{id:actor.user},funnel:dispatchFunnelOptions()});
      } catch(error) { return errorResponse(error); }
    },
    async post({request,env}) {
      if (!sameOrigin(request)) return reply(403,{ok:false,code:'dispatch_origin_forbidden',error:'Open dispatch in the Employee Hub to save changes.'});
      try {
        const actor = await session(request,env), access = requireScheduleAccess(actor,env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415,{ok:false,code:'dispatch_json_required',error:'Dispatch changes must be submitted as JSON.'});
        if (Number(request.headers.get('Content-Length')) > 64000) return reply(413,{ok:false,code:'dispatch_request_too_large',error:'The dispatch request is too large.'});
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 64000) return reply(413,{ok:false,code:'dispatch_request_too_large',error:'The dispatch request is too large.'});
        let input; try { input = JSON.parse(raw); } catch { return reply(400,{ok:false,code:'dispatch_json_invalid',error:'The dispatch request was incomplete. Refresh the form and try again.'}); }
        const store = storage(env);
        // Saves read cached drive times only: no provider call or cache write
        // runs between the day locks and the schedule commit.
        const options = {travel:travel({env,store,now,googleLimit:0,cacheWrites:false})};
        return reply(200,access.booker ? await mutateBooking(store,actor,input,now().toISOString(),options,env) : await mutateDispatch(store,actor,input,now().toISOString(),options));
      } catch(error) { return errorResponse(error); }
    },
  };
}

const handlers = dispatchHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
