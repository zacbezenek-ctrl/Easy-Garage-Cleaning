import {listHubUserProfiles,hasBusinessAccess} from '../_lib/hub-session.js';
import {verifyOperationsEnvelope} from '../_lib/operations-envelope.js';
import {portalCalendar,portalJob} from '../_lib/operations-portal-records.js';
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function onRequestPost({request,env}) {
  if(env.EGC_OPERATIONS_ENABLED!=='true')return reply(503,{error:'operations_not_enabled'});
  try {
    const content=await request.text();if(content.length>220000)return reply(413,{error:'request_too_large'});
    const c=await verifyOperationsEnvelope(JSON.parse(content).envelope,env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET,'egc-portal');
    if(c.actor.workspace!==(env.EGC_OPERATIONS_WORKSPACE||'egc'))return reply(403,{error:'workspace_forbidden'});
    const command=c.request.body;
    if(command.command==='calendar')return reply(200,await portalCalendar(env,command));
    if(command.command==='portal.members')return reply(200,{ok:true,authority:'employee_hub',members:listHubUserProfiles(env).filter(hasBusinessAccess).map(p=>({id:p.user,name:p.displayName,role:p.role}))});
    if(command.command==='portal.job')return reply(200,await portalJob(env,command.jobId));
    return reply(400,{error:'read_only_portal_command_required'});
  }catch(e){return reply(e.status||(e.message==='Unauthorized'?401:503),{error:e.status?e.message:e.message==='Unauthorized'?'unauthorized':'portal_source_unavailable'});}
}
export async function onRequestGet(){return reply(405,{error:'signed_post_required'});}
