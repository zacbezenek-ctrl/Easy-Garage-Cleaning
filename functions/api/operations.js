import {getHubSession,hasBusinessAccess,listHubUserProfiles} from '../_lib/hub-session.js';
import {operationsEnabled,operationsAuthMode,operationsApiOrigin,signPortalServiceEnvelope} from '../_lib/operations-service-auth.js';
import {operationsMembers,operationsStaffMembersEnabled} from '../_lib/operations-staff.js';
import {can,capabilityRoleSet,staffRoleAccessEnabled} from '../_lib/staff-roles.js';
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export function sameOrigin(request) {
  if(request.headers.get('Sec-Fetch-Site')==='cross-site')return false;
  return request.headers.get('Origin')===new URL(request.url).origin;
}
// EGC_STAFF_ROLE_ACCESS: followups.own holders (a stored manager, sales, phone) reach the Action Center, and the
// platform sees the role their owner-set roles give: owner, manager, or sales (its own-tasks-only role) for sales and
// phone. Off: business access and the session role, as before.
async function sessionFor(request,env) {
  const session=await getHubSession(request,env);
  if(!staffRoleAccessEnabled(env))return session&&hasBusinessAccess(session)?session:null;
  return session&&can(session,'followups.own',env)?session:null;
}
function actorRole(session,env) {
  const roles=staffRoleAccessEnabled(env)?capabilityRoleSet(session,env):null;
  if(!roles)return session.role;
  return roles.includes('owner')?'owner':roles.includes('manager')?'manager':'sales';
}
// With EGC_OPERATIONS_STAFF_MEMBERS the assignable sales and phone staff (businessAccess:false) join the owners.
// When that staff roster cannot be read or is ambiguous, the business users stay assignable and
// staffOwners:{available:false,code} says so, so the Action Center still loads.
export async function actionCenterOwners(env,members=operationsMembers) {
  const business=()=>listHubUserProfiles(env).filter(hasBusinessAccess).map(p=>({id:p.user,name:p.displayName,role:p.role}));
  if(!operationsStaffMembersEnabled(env))return{owners:business()};
  try{return{owners:(await members(env)).map(({id,name,role,businessAccess})=>businessAccess===false?{id,name,role,businessAccess}:{id,name,role}),staffOwners:{available:true}};}
  catch(e){return{owners:business(),staffOwners:{available:false,code:e?.message==='portal_members_ambiguous'?'portal_members_ambiguous':'portal_source_unavailable'}};}
}
export async function onRequestGet({request,env}) {
  try {
    const session=await sessionFor(request,env);
    if(!session)return reply(403,{error:'business_session_required'});
    const {owners,staffOwners}=await actionCenterOwners(env);
    return reply(200,{ok:true,enabled:operationsEnabled(env),authMode:operationsAuthMode(env),actor:{id:session.user,role:actorRole(session,env),kind:'human',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'},
      owners,...(staffOwners?{staffOwners}:{}),timeZone:'America/Denver'});
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
    const actor={id:session.user,role:actorRole(session,env),kind:'human',workspace:env.EGC_OPERATIONS_WORKSPACE||'egc'};
    const envelope=await signPortalServiceEnvelope(env,{path:'/operations/rpc',actor,request:{requestId:input.requestId,body:input.body}});
    const upstream=await fetch(new URL('/operations/rpc',origin),{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(20000)});
    if(upstream.status>=300&&upstream.status<400)return reply(502,{error:'operations_invalid_upstream'});
    if(!upstream.headers.get('Content-Type')?.includes('application/json'))return reply(502,{error:'operations_invalid_upstream'});
    return reply(upstream.status,await upstream.json());
  }catch{return reply(503,{error:'operations_unavailable',retryable:true,message:'The outcome may be unknown. Retry the same request ID; do not create a new copy.'});}
}
