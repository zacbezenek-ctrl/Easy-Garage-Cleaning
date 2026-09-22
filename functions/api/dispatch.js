import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { dispatchOverview, mutateDispatch, requireDispatcher } from '../_lib/dispatch-service.js';

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

// Dependency injection permits full request/permission tests without changing
// production environment flags, cookies, or Firestore credentials.
export function dispatchHandlers({ session = getHubSession, storage = dispatchStorage } = {}) {
  return {
    async get({request,env}) {
      try {
        const actor = await session(request,env); requireDispatcher(actor);
        const params = Object.fromEntries(new URL(request.url).searchParams.entries());
        return reply(200,await dispatchOverview(storage(env),actor,params));
      } catch(error) { return errorResponse(error); }
    },
    async post({request,env}) {
      if (!sameOrigin(request)) return reply(403,{ok:false,code:'dispatch_origin_forbidden',error:'Open dispatch in the Employee Hub to save changes.'});
      try {
        const actor = await session(request,env); requireDispatcher(actor);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415,{ok:false,code:'dispatch_json_required',error:'Dispatch changes must be submitted as JSON.'});
        if (Number(request.headers.get('Content-Length')) > 64000) return reply(413,{ok:false,code:'dispatch_request_too_large',error:'The dispatch request is too large.'});
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 64000) return reply(413,{ok:false,code:'dispatch_request_too_large',error:'The dispatch request is too large.'});
        let input; try { input = JSON.parse(raw); } catch { return reply(400,{ok:false,code:'dispatch_json_invalid',error:'The dispatch request was incomplete. Refresh the form and try again.'}); }
        return reply(200,await mutateDispatch(storage(env),actor,input));
      } catch(error) { return errorResponse(error); }
    },
  };
}

const handlers = dispatchHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
