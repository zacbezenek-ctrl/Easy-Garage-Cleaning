import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { mutatePto, ptoOverview, ptoVault } from '../_lib/employee-pto.js';
import { canDispatch } from '../_lib/dispatch-permissions.js';

const LIMIT = 8192;
const reply = (status, body) => Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function errorResponse(error) {
  if (/^(pto_|crew_availability_|dispatch_)/.test(error?.code || '')) return reply(error.status || 503,{ok:false,code:error.code,error:error.message,...(error.details ? {details:error.details} : {})});
  if (error?.code === 'EMPLOYEE_HUB_STORAGE_UNREADABLE') return reply(503,{ok:false,code:'pto_storage_unreadable',error:'Employee records could not be read safely. Please contact the Hub administrator.'});
  return reply(503,{ok:false,code:'pto_unavailable',error:'The request could not be verified. Keep it and retry the same request; do not create another.'});
}
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}
function query(url) {
  const params = new URL(url).searchParams, names = [...params.keys()];
  if (new Set(names).size !== names.length) throw Object.assign(new Error('Each filter can be sent only once.'),{code:'pto_invalid_request',status:400});
  return Object.fromEntries(params);
}
export function employeePtoHandlers({session=getHubSession,storage=dispatchStorage,vault=ptoVault,now=()=>new Date()}={}) {
  return {
    async get({request,env}) {
      try {
        const actor = await session(request,env);
        if (!actor?.user) return reply(401,{ok:false,code:'pto_sign_in_required',error:'Sign in to view requests.'});
        // Staff-role permissions (env) decide whether this viewer sees everyone's requests, as for approvals.
        return reply(200,await ptoOverview(storage(env),vault(env),actor,query(request.url),now(),{env}));
      } catch(error) { return errorResponse(error); }
    },
    async post({request,env}) {
      if (!sameOrigin(request)) return reply(403,{ok:false,code:'pto_origin_forbidden',error:'Open requests in the Employee Hub to save changes.'});
      try {
        const actor = await session(request,env);
        if (!actor?.user) return reply(401,{ok:false,code:'pto_sign_in_required',error:'Sign in to manage requests.'});
        // Staff-role permissions (env) decide whether this viewer may approve, deny or end requests.
        canDispatch(actor,env);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415,{ok:false,code:'pto_json_required',error:'Request changes must use JSON.'});
        if (Number(request.headers.get('Content-Length')) > LIMIT) return reply(413,{ok:false,code:'pto_request_too_large',error:'The request is too large.'});
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return reply(413,{ok:false,code:'pto_request_too_large',error:'The request is too large.'});
        let body; try { body = JSON.parse(raw); } catch { return reply(400,{ok:false,code:'pto_json_invalid',error:'The request was incomplete. Retry from the form.'}); }
        const records = vault(env);
        if (records.readOnly) return reply(503,{ok:false,code:'pto_recovery_read_only',error:'Employee setup is being verified. Existing records are preserved and cannot be changed yet.'});
        return reply(200,await mutatePto(storage(env),records,actor,body,now().toISOString()));
      } catch(error) { return errorResponse(error); }
    },
  };
}
const handlers = employeePtoHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
