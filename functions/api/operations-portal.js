import {listHubUserProfiles,hasBusinessAccess} from '../_lib/hub-session.js';
import {operationsEnabled,verifyApiServiceEnvelope} from '../_lib/operations-service-auth.js';
import {portalCalendar,portalJob,portalEvidence} from '../_lib/operations-portal-records.js';
import {portalRevenue} from '../_lib/operations-financials.js';
import {mutatePortalRecord} from '../_lib/operations-job-records.js';
import {inboundResponsePolicy} from '../_lib/operations-rules.js';
import {schedulingStorage,resolveScheduledVisit,mutateScheduledVisit,bindScheduledProvider,linkScheduledCustomer} from '../_lib/operations-scheduling.js';
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function onRequestPost({request,env}) {
  if(!operationsEnabled(env))return reply(503,{error:'operations_not_enabled'});
  try {
    const content=await request.text();if(content.length>220000)return reply(413,{error:'request_too_large'});
    const c=await verifyApiServiceEnvelope(env,JSON.parse(content).envelope,'/api/operations-portal');
    if(c.actor.workspace!==(env.EGC_OPERATIONS_WORKSPACE||'egc'))return reply(403,{error:'workspace_forbidden'});
    const command=c.request.body;
    if(['portal.note.add','portal.job.edit','portal.project.ensure'].includes(command.command))return reply(200,await mutatePortalRecord(schedulingStorage(env),c.actor,command));
    if(command.command==='schedule.link_customer')return reply(200,await linkScheduledCustomer(schedulingStorage(env),c.actor,command));
    if(command.command==='schedule.resolve')return reply(200,await resolveScheduledVisit(schedulingStorage(env),command.portalVisitId));
    if(command.command==='schedule.mutate')return reply(200,await mutateScheduledVisit(schedulingStorage(env),c.actor,command));
    if(command.command==='schedule.bind_provider')return reply(200,await bindScheduledProvider(schedulingStorage(env),c.actor,command));
    if(command.command==='calendar')return reply(200,await portalCalendar(env,command));
    if(command.command==='portal.members')return reply(200,{ok:true,authority:'employee_hub',members:listHubUserProfiles(env).filter(hasBusinessAccess).map(p=>({id:p.user,name:p.displayName,role:p.role}))});
    if(command.command==='portal.job')return reply(200,await portalJob(env,command.jobId));
    if(command.command==='portal.evidence')return reply(200,await portalEvidence(env,command));
    if(command.command==='portal.revenue')return reply(200,await portalRevenue(env,command));
    if(command.command==='portal.rules')return reply(200,{ok:true,...inboundResponsePolicy(env,listHubUserProfiles(env).filter(hasBusinessAccess).map(p=>({id:p.user,role:p.role})))});
    return reply(400,{error:'read_only_portal_command_required'});
  }catch(e){return reply(e.status||(e.message==='Unauthorized'?401:503),{error:e.status?e.message:e.message==='Unauthorized'?'unauthorized':'portal_source_unavailable'});}
}
export async function onRequestGet(){return reply(405,{error:'signed_post_required'});}
