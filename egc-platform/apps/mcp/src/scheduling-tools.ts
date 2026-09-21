import type {McpServer} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {commandSchema,type Command} from "@egc/operations";
import {callOperations,operationsEnabled} from "./operations.js";
import {oauthSecurityMetadata,READ_SCOPE,WRITE_SCOPE} from "./oauth.js";
import {AppointmentOperationError,appointmentStatus} from "./appointment-reliability.js";
type Json=Record<string,unknown>;
const record=(v:unknown):Json=>v&&typeof v==="object"&&!Array.isArray(v)?v as Json:{};
const result=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value,null,2)}],structuredContent:{result:value}});
export async function readHubVisit(portalVisitId:string):Promise<Json>{
  const response:Json=await callOperations({command:"schedule.resolve",portalVisitId});
  if(response.error||response.authority!=="employee_hub")throw new AppointmentOperationError(typeof response.error==="string"?response.error:"schedule_authority_unavailable");
  const visit=record(response.visit);
  if(visit.portalVisitId!==portalVisitId||!visit.portalCustomerId||!visit.revision)throw new AppointmentOperationError("schedule_identity_unverified");
  return visit;
}
export function assertHubSchedule(visit:Json,expected:Json,providerId?:string){
  if(!visit.highlevelContactId||expected.contactId!==visit.highlevelContactId)throw new AppointmentOperationError("schedule_contact_link_conflict");
  if(providerId&&visit.highlevelAppointmentId!==providerId)throw new AppointmentOperationError("schedule_provider_link_conflict");
  if(Date.parse(String(expected.startTime))!==Date.parse(String(visit.startTime))||Date.parse(String(expected.endTime))!==Date.parse(String(visit.endTimeInstant)))throw new AppointmentOperationError("schedule_provider_time_conflict");
  const canonicalStatus=visit.status==="cancelled"?"cancelled":["completed","paid","invoiced","closed"].includes(String(visit.status))?"showed":"confirmed";
  const requested=appointmentStatus(expected.appointmentStatus);
  if(requested!==canonicalStatus)throw new AppointmentOperationError("schedule_provider_status_conflict");
  if(expected.title!==undefined&&expected.title!==visit.title)throw new AppointmentOperationError("schedule_provider_title_conflict");
  if(expected.address!==undefined&&expected.address!==visit.address)throw new AppointmentOperationError("schedule_provider_address_conflict");
}
export async function bindHubProvider(portalVisitId:string,operationId:string,event:Json){
  const visit=await readHubVisit(portalVisitId);
  const response=await callOperations({command:"schedule.bind_provider",portalVisitId,operationId,expectedRevision:String(visit.revision),event},operationId);
  if(response.error)throw new AppointmentOperationError(String(response.error),operationId);
  return response;
}
export function registerSchedulingTools(server:McpServer,sync:(visit:Json,input:{requestId:string;runAutomations:boolean})=>Promise<Json>){
  const write={annotations:{readOnlyHint:false,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE,WRITE_SCOPE])};
  const read={annotations:{readOnlyHint:true,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE])};
  server.registerTool("egc.visit_get",{description:"Read one exact authoritative Employee Hub visit, its saved customer and provider links, schedule revision and separate provider sync state.",inputSchema:z.object({portalVisitId:z.string().min(1).max(180)}),...read},async({portalVisitId})=>result(await callOperations({command:"schedule.resolve",portalVisitId})));
  server.registerTool("egc.schedule_visit",{description:"Create, reschedule or cancel an authoritative Employee Hub visit with revision checks, shared schedule locks and durable request replay, then synchronize its exact GHL appointment safely. Requires an existing exact Hub customer ID. Always reuse requestId and the original payload after a timeout. A failed provider sync leaves the Hub schedule saved and reports the pending state; no replacement is created blindly.",
    inputSchema:z.object({requestId:z.string().uuid(),mode:z.enum(["create","update","cancel"]),portalVisitId:z.string().min(1).max(180).optional(),portalCustomerId:z.string().min(1).max(180),sourceWalkthroughId:z.string().min(1).max(180).optional(),expectedRevision:z.string().min(1).optional(),kind:z.enum(["walkthrough","job"]).optional(),changes:z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),time:z.string().regex(/^\d{2}:\d{2}$/).optional(),endTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),title:z.string().min(1).max(500).optional(),assignedTo:z.string().min(1).max(200).optional(),address:z.string().max(1000).optional()}).strict(),runAutomations:z.boolean().default(false)}),...write
  },async({runAutomations,...input})=>{
    if(!operationsEnabled())return result({error:"operations_not_enabled"});
    const command=commandSchema.parse({command:"schedule.mutate",...input}) as Command;
    const saved:Json=await callOperations(command,input.requestId);
    if(saved.error||saved.authority!=="employee_hub")return result(saved);
    try{return result({...saved,provider:await sync(record(saved.visit),{requestId:input.requestId,runAutomations})});}
    catch(error){return result({...saved,provider:{ok:false,syncStatus:"pending",error:error instanceof AppointmentOperationError?error.code:"schedule_provider_sync_unavailable",operationId:error instanceof AppointmentOperationError?error.operationId:null},instruction:"The Hub visit is saved. Retry the same schedule request, or reconcile the returned operation; do not create another visit."});}
  });
}
