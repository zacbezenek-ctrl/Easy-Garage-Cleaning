import {operationsEnabled,verifyApiServiceEnvelope} from '../_lib/operations-service-auth.js';
import {resolveRecordingIdentity,applyRecordingApproval,currentRecordingProfile} from '../_lib/operations-recording-approval.js';
import {prepareBridgeCommand} from '../_lib/operations-command-policy.js';
const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
// SEC-04: every command this endpoint runs; each is authorized by its shared policy before dispatch.
export const RECORDING_COMMANDS=Object.freeze(['recording.resolve','recording.apply']);
export async function onRequestPost({request,env}){
  if(!operationsEnabled(env))return reply(503,{error:'operations_not_enabled'});
  try{const text=await request.text();if(text.length>220000)return reply(413,{error:'request_too_large'});
    let input;try{input=JSON.parse(text);}catch{return reply(400,{error:'invalid_json'});}
    const c=await verifyApiServiceEnvelope(env,input?.envelope,'/api/operations-recording-approval');
    if(c.actor.workspace!==(env.EGC_OPERATIONS_WORKSPACE||'egc'))return reply(403,{error:'workspace_forbidden'});
    const bridge=await prepareBridgeCommand(env,c.actor,c.request.body,{commands:RECORDING_COMMANDS,unknown:'unsupported_recording_command',claims:c}),command=bridge.command;
    // The API may relay an issuer-verified MCP read principal. Human access uses
    // today's Hub profile, not the role written into an older service envelope.
    const profile=c.actor.kind==='human'?await currentRecordingProfile(env,c.actor):null;
    if(command.command==='recording.resolve')return reply(200,{ok:true,identity:await resolveRecordingIdentity(env,command.portalJobId,undefined,profile)});
    if(command.command==='recording.apply')return reply(200,await applyRecordingApproval(env,command,c.actor,undefined,{now:bridge.now,audit:bridge.audit,via:bridge.via}));
    return reply(400,{error:'unsupported_recording_command'});
  }catch(e){return reply(e.status||(e.message==='Unauthorized'?401:503),{error:e.status?e.message:e.message==='Unauthorized'?'unauthorized':'recording_source_unavailable'});}
}
