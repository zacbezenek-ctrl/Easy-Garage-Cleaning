import {getHubSession,hasBusinessAccess,listHubUserProfiles} from '../_lib/hub-session.js';
import {operationsEnabled,operationsAuthMode,operationsApiOrigin,signPortalServiceEnvelope} from '../_lib/operations-service-auth.js';
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export function sameOrigin(request) {
  if(request.headers.get('Sec-Fetch-Site')==='cross-site')return false;
  return request.headers.get('Origin')===new URL(request.url).origin;
}
async function sessionFor(request,env) {
  const session=await getHubSession(request,env);
  return session&&hasBusinessAccess(session)?session:null;
}
export async function onRequestGet({request,env}) {
  try {
    const session=await sessionFor(request,env);
    if(!session)return reply(403,{error:'business_session_required'});
    return reply(200,{ok:true,enabled:operationsEnabled(env),authMode:operationsAuthMode(env),actor:{id:session.user,role:session.role,kind:'human',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'},
      owners:listHubUserProfiles(env).filter(hasBusinessAccess).map(p=>({id:p.user,name:p.displayName,role:p.role})),timeZone:'America/Denver'});
  }catch{return reply(503,{error:'operations_identity_unavailable'});}
}
export async function onRequestPost({request,env}) {
  if(!sameOrigin(request))return reply(403,{error:'same_origin_required'});
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))return reply(415,{error:'json_required'});
  try {
    const session=await sessionFor(request,env);
    if(!session)return reply(403,{error:'business_session_required'});
    if(!operationsEnabled(env))return reply(503,{error:'operations_not_enabled'});
    const origin=operationsApiOrigin(env);
    const text=await request.text();if(text.length>120000)return reply(413,{error:'request_too_large'});
    let input;try{input=JSON.parse(text)}catch{return reply(400,{error:'invalid_json'});}
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input?.requestId||'')||!input.body||typeof input.body!=='object')return reply(400,{error:'invalid_request'});
    // Ignore client-provided identity/role fields. The authenticated Hub session is the only principal.
    const actor={id:session.user,role:session.role,kind:'human',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'};
    const envelope=await signPortalServiceEnvelope(env,{path:'/operations/rpc',actor,request:{requestId:input.requestId,body:input.body}});
    const upstream=await fetch(new URL('/operations/rpc',origin),{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(20000)});
    if(upstream.status>=300&&upstream.status<400)return reply(502,{error:'operations_invalid_upstream'});
    if(!upstream.headers.get('Content-Type')?.includes('application/json'))return reply(502,{error:'operations_invalid_upstream'});
    return reply(upstream.status,await upstream.json());
  }catch{return reply(503,{error:'operations_unavailable',retryable:true,message:'The outcome may be unknown. Retry the same request ID; do not create a new copy.'});}
}
