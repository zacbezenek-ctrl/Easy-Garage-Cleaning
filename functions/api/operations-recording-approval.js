import {verifyOperationsEnvelope} from '../_lib/operations-envelope.js';
import {resolveRecordingIdentity,applyRecordingApproval} from '../_lib/operations-recording-approval.js';
const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function onRequestPost({request,env}){
  if(env.EGC_OPERATIONS_ENABLED!=='true')return reply(503,{error:'operations_not_enabled'});
  try{const text=await request.text();if(text.length>220000)return reply(413,{error:'request_too_large'});
    const c=await verifyOperationsEnvelope(JSON.parse(text).envelope,env.EGC_OPERATIONS_PORTAL_SIGNING_SECRET,'egc-portal');
    if(c.actor.workspace!==(env.EGC_OPERATIONS_WORKSPACE||'egc'))return reply(403,{error:'workspace_forbidden'});
    const command=c.request.body;
    if(command.command==='recording.resolve')return reply(200,{ok:true,identity:await resolveRecordingIdentity(env,command.portalJobId)});
    if(command.command==='recording.apply')return reply(200,await applyRecordingApproval(env,command,c.actor));
    return reply(400,{error:'unsupported_recording_command'});
  }catch(e){return reply(e.status||(e.message==='Unauthorized'?401:503),{error:e.status?e.message:e.message==='Unauthorized'?'unauthorized':'recording_source_unavailable'});}
}
