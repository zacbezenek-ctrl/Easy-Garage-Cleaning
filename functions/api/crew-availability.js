import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { crewAvailabilityOverview, mutateCrewAvailability } from '../_lib/crew-availability.js';

const reply = (status, body) => Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function errorResponse(error) {
  if (error?.code?.startsWith('crew_availability_') || error?.code?.startsWith('dispatch_')) return reply(error.status || 503,{ok:false,code:error.code,error:error.message,...(error.details ? {details:error.details} : {})});
  return reply(503,{ok:false,code:'crew_availability_unavailable',error:'Availability could not be verified. Keep your request and retry.'});
}
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
export function crewAvailabilityHandlers({session=getHubSession,storage=dispatchStorage}={}) {
  return {
    async get({request,env}) {
      try { return reply(200,await crewAvailabilityOverview(storage(env),await session(request,env),Object.fromEntries(new URL(request.url).searchParams))); }
      catch(error) { return errorResponse(error); }
    },
    async post({request,env}) {
      if (!sameOrigin(request)) return reply(403,{ok:false,code:'crew_availability_origin_forbidden',error:'Open availability in the Employee Hub to save changes.'});
      try {
        const actor = await session(request,env);
        if (!actor?.user) return reply(401,{ok:false,code:'crew_availability_sign_in_required',error:'Sign in to manage your availability.'});
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415,{ok:false,code:'crew_availability_json_required',error:'Availability changes must use JSON.'});
        if (Number(request.headers.get('Content-Length')) > 8192) return reply(413,{ok:false,code:'crew_availability_request_too_large',error:'The availability request is too large.'});
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 8192) return reply(413,{ok:false,code:'crew_availability_request_too_large',error:'The availability request is too large.'});
        let body; try { body=JSON.parse(raw); } catch { return reply(400,{ok:false,code:'crew_availability_json_invalid',error:'The availability request was incomplete. Retry from the form.'}); }
        return reply(200,await mutateCrewAvailability(storage(env),actor,body));
      } catch(error) { return errorResponse(error); }
    },
  };
}
const handlers = crewAvailabilityHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
