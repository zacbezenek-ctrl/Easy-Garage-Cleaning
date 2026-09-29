import {operationsMembers,operationsRoster} from '../_lib/operations-staff.js';
import {operationsEnabled,verifyApiServiceEnvelope} from '../_lib/operations-service-auth.js';
import {isHubCommand,runHubCommand} from '../_lib/operations-hub-commands.js';
import {portalCalendar,portalJob,portalEvidence} from '../_lib/operations-portal-records.js';
import {portalRevenue} from '../_lib/operations-financials.js';
import {mutatePortalRecord} from '../_lib/operations-job-records.js';
import {inboundResponsePolicy} from '../_lib/operations-rules.js';
import {followupPolicyEnabled,followupSettingsStorage,readFollowupPolicy} from '../_lib/operations-followup-policy.js';
import {schedulingStorage,resolveScheduledVisit,mutateScheduledVisit,bindScheduledProvider,linkScheduledCustomer} from '../_lib/operations-scheduling.js';
import {adoptionStorage,adoptScheduledVisit} from '../_lib/operations-adoption.js';
import {prepareBridgeCommand} from '../_lib/operations-command-policy.js';
import {runScheduleSyncCommand,scheduleSyncStorage} from '../_lib/schedule-sync-queue.js';
import {runRecurringHorizonCommand} from '../_lib/recurring-horizon-command.js';
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
// SEC-04: every legacy command this endpoint runs; each is authorized by its shared policy before dispatch.
export const PORTAL_COMMANDS=Object.freeze(['schedule.adopt','recurring.extend_horizon','portal.note.add','portal.job.edit','portal.project.ensure','schedule.link_customer','schedule.resolve','schedule.mutate','schedule.bind_provider','calendar','portal.members','portal.job','portal.evidence','portal.revenue','portal.rules','schedule.sync_due','schedule.sync_failed']);
export async function onRequestPost({request,env}) {
  if(!operationsEnabled(env))return reply(503,{error:'operations_not_enabled'});
  try {
    const content=await request.text();if(content.length>220000)return reply(413,{error:'request_too_large'});
    const c=await verifyApiServiceEnvelope(env,JSON.parse(content).envelope,'/api/operations-portal');
    if(c.actor.workspace!==(env.EGC_OPERATIONS_WORKSPACE||'egc'))return reply(403,{error:'workspace_forbidden'});
    const bridge=await prepareBridgeCommand(env,c.actor,c.request.body,{commands:PORTAL_COMMANDS,hub:true,unknown:'read_only_portal_command_required',claims:c}),command=bridge.command,now=bridge.now;
    if(isHubCommand(command))return reply(200,await runHubCommand(env,c.actor,command));
    if(['schedule.sync_due','schedule.sync_failed'].includes(command.command))return reply(200,await runScheduleSyncCommand(env,c.actor,command,{store:bridge.store(scheduleSyncStorage(env)),now:new Date(now)}));
    if(command.command==='schedule.adopt')return reply(200,await adoptScheduledVisit(bridge.store(adoptionStorage(env)),c.actor,command,now));
    // The scheduled horizon run (recurring-horizon-worker only, per the shared policy)
    // takes its clock from the signed envelope, never the Hub's wall clock. Its lib keeps
    // its own trail: dispatchOperations receipts under the plan's manager, the plan's
    // lastRun, and a money audit entry via 'cron' (with the money visibility rules) for
    // each price save, so the bridge audit wrapper is not stacked on top of it.
    if(command.command==='recurring.extend_horizon')return reply(200,await runRecurringHorizonCommand(env,c.actor,command,{now:new Date(c.iat*1000).toISOString(),runId:c.request.requestId}));
    if(['portal.note.add','portal.job.edit','portal.project.ensure'].includes(command.command))return reply(200,await mutatePortalRecord(bridge.store(schedulingStorage(env)),c.actor,command,now));
    if(command.command==='schedule.link_customer')return reply(200,await linkScheduledCustomer(bridge.store(schedulingStorage(env)),c.actor,command,now));
    if(command.command==='schedule.resolve')return reply(200,await resolveScheduledVisit(schedulingStorage(env),command.portalVisitId));
    if(command.command==='schedule.mutate')return reply(200,await mutateScheduledVisit(bridge.store(schedulingStorage(env)),c.actor,command,now,{via:bridge.via}));
    if(command.command==='schedule.bind_provider')return reply(200,await bindScheduledProvider(bridge.store(schedulingStorage(env)),c.actor,command,now));
    if(command.command==='calendar')return reply(200,await portalCalendar(env,command));
    if(command.command==='portal.members')return reply(200,{ok:true,authority:'employee_hub',members:await operationsMembers(env)});
    if(command.command==='portal.job')return reply(200,await portalJob(env,command.jobId));
    if(command.command==='portal.evidence')return reply(200,await portalEvidence(env,command));
    if(command.command==='portal.revenue')return reply(200,await portalRevenue(env,command));
    if(command.command==='portal.rules'){
      const roster=await operationsRoster(env),inbound=inboundResponsePolicy(env,roster.members.map(({id,role,staffRoles})=>staffRoles?{id,role,staffRoles}:{id,role}));
      if(!followupPolicyEnabled(env))return reply(200,{ok:true,...inbound});
      return reply(200,{ok:true,...inbound,followup:(await readFollowupPolicy(env,roster,followupSettingsStorage(env))).followup});
    }
    return reply(400,{error:'read_only_portal_command_required'});
  }catch(e){return reply(e.status||(e.message==='Unauthorized'?401:503),{error:e.status?e.message:e.message==='Unauthorized'?'unauthorized':'portal_source_unavailable'});}
}
export async function onRequestGet(){return reply(405,{error:'signed_post_required'});}
