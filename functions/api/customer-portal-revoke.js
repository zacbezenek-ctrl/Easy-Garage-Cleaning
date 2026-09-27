import { getHubSession } from '../_lib/hub-session.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { customerPortalLinkStatus, revokeCustomerPortalLinks } from '../_lib/customer-portal-revocation.js';

const LIMIT=4096;
const reply=(status,data)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const failure=problem=>problem.code?.startsWith('CUSTOMER_PORTAL_REVOKE_')?reply(problem.status||503,{ok:false,code:problem.code,error:problem.message}):reply(503,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_UNAVAILABLE',error:'Portal links could not be checked. Retry shortly.'});
function sameOrigin(request) {
  if(request.headers.get('Sec-Fetch-Site')==='cross-site')return false;
  const source=request.headers.get('Origin')||request.headers.get('Referer');
  try {return !source||new URL(source).origin===new URL(request.url).origin;} catch {return false;}
}
const forbidden=()=>reply(403,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_ORIGIN_FORBIDDEN',error:'Open the EGC Hub before changing customer portal links.'});

export function customerPortalRevokeHandlers({session=getHubSession,storage=dispatchStorage,now=()=>new Date()}={}) {
  return {
    async get({request,env}) {
      if(!sameOrigin(request))return forbidden();
      try {
        const actor=await session(request,env);
        if(!actor)return reply(401,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_SIGN_IN_REQUIRED',error:'Sign in to the EGC Hub.'});
        const params=new URL(request.url).searchParams,keys=[...params.keys()];
        if(keys.length!==1||keys[0]!=='jobId')return reply(400,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_INVALID_REQUEST',error:'Choose one job.'});
        return reply(200,await customerPortalLinkStatus(storage(env),actor,params.get('jobId')));
      } catch(problem) {return failure(problem);}
    },
    async post({request,env}) {
      if(!sameOrigin(request))return forbidden();
      try {
        const actor=await session(request,env);
        if(!actor)return reply(401,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_SIGN_IN_REQUIRED',error:'Sign in to the EGC Hub.'});
        if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_JSON_REQUIRED',error:'Send the revocation as JSON.'});
        if(Number(request.headers.get('Content-Length'))>LIMIT)return reply(413,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_TOO_LARGE',error:'The revocation request is too large.'});
        const raw=await request.text();
        if(new TextEncoder().encode(raw).byteLength>LIMIT)return reply(413,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_TOO_LARGE',error:'The revocation request is too large.'});
        let input;try {input=JSON.parse(raw);} catch {return reply(400,{ok:false,code:'CUSTOMER_PORTAL_REVOKE_JSON_INVALID',error:'The revocation request was incomplete.'});}
        return reply(200,await revokeCustomerPortalLinks(storage(env),actor,input,{now:now().toISOString()}));
      } catch(problem) {return failure(problem);}
    },
  };
}

const handlers=customerPortalRevokeHandlers();
export const onRequestGet=handlers.get;
export const onRequestPost=handlers.post;
