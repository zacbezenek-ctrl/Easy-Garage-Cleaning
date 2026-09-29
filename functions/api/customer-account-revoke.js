import { getHubSession } from '../_lib/hub-session.js';
import { customerAccountStorage, revokeCustomerAccountSessions } from '../_lib/customer-account-access.js';

// POST {requestId, customerId, expectedRevision}: an owner or manager signs a
// customer out of every device: every Client Login session and unused sign-in
// link (portalSessionVersion bump) and every homeowner portal session and link
// of the customer's projects (customerPortalLinkVersion bump on each account
// root, resolved as the portal resolves it), in one audited commit. A project
// whose owner chain needs review is counted in needsReview, and the answer
// then says portalLinksComplete:false.
const LIMIT=4096;
const reply=(status,data)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const failure=problem=>problem.code?.startsWith('CUSTOMER_ACCOUNT_REVOKE_')?reply(problem.status||503,{ok:false,code:problem.code,error:problem.message}):reply(503,{ok:false,code:'CUSTOMER_ACCOUNT_REVOKE_UNAVAILABLE',error:'Customer sessions could not be changed. Retry the same request shortly.'});
function sameOrigin(request) {
  if(request.headers.get('Sec-Fetch-Site')==='cross-site')return false;
  const source=request.headers.get('Origin')||request.headers.get('Referer');
  try {return !source||new URL(source).origin===new URL(request.url).origin;} catch {return false;}
}

export function customerAccountRevokeHandlers({session=getHubSession,storage=env=>customerAccountStorage(env),now=()=>new Date()}={}) {
  return {
    async post({request,env}) {
      if(!sameOrigin(request))return reply(403,{ok:false,code:'CUSTOMER_ACCOUNT_REVOKE_ORIGIN_FORBIDDEN',error:'Open the EGC Hub before signing a customer out.'});
      try {
        const actor=await session(request,env);
        if(!actor)return reply(401,{ok:false,code:'CUSTOMER_ACCOUNT_REVOKE_SIGN_IN_REQUIRED',error:'Sign in to the EGC Hub.'});
        if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415,{ok:false,code:'CUSTOMER_ACCOUNT_REVOKE_JSON_REQUIRED',error:'Send the request as JSON.'});
        if(Number(request.headers.get('Content-Length'))>LIMIT)return reply(413,{ok:false,code:'CUSTOMER_ACCOUNT_REVOKE_TOO_LARGE',error:'The request is too large.'});
        const raw=await request.text();
        if(new TextEncoder().encode(raw).byteLength>LIMIT)return reply(413,{ok:false,code:'CUSTOMER_ACCOUNT_REVOKE_TOO_LARGE',error:'The request is too large.'});
        let input;try {input=JSON.parse(raw);} catch {return reply(400,{ok:false,code:'CUSTOMER_ACCOUNT_REVOKE_JSON_INVALID',error:'The request was incomplete.'});}
        return reply(200,await revokeCustomerAccountSessions(storage(env),actor,input,now().toISOString()));
      } catch(problem) {return failure(problem);}
    },
  };
}

const handlers=customerAccountRevokeHandlers();
export const onRequestPost=handlers.post;
