import type {McpServer} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {GhlClient,asRecord,asString} from "@egc/ghl";
import {callOperations} from "./operations.js";
import {oauthSecurityMetadata,READ_SCOPE,WRITE_SCOPE} from "./oauth.js";
const result=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}],structuredContent:{result:value}});
type Json=Record<string,unknown>;
type ProjectLinkDeps={providerContact?:(providerId:string)=>Promise<Json>};
const object=(value:unknown):Json=>value&&typeof value==="object"&&!Array.isArray(value)?value as Json:{};
function sanitizeProviderContact(payload:Json,expectedId:string){
 const row=Object.keys(asRecord(payload.contact)).length?asRecord(payload.contact):payload;
 const id=asString(row.id);
 if(id!==expectedId)throw new Error("project_provider_contact_identity_mismatch");
 const locationId=asString(row.locationId);
 return {id,...(locationId?{locationId}:{}),...(asString(row.name)?{name:asString(row.name)!}:{}),...(asString(row.firstName)?{firstName:asString(row.firstName)!}:{}),...(asString(row.lastName)?{lastName:asString(row.lastName)!}:{}),...(asString(row.phone)?{phone:asString(row.phone)!}:{}),...(asString(row.email)?{email:asString(row.email)!}:{}),...(asString(row.address1)?{address1:asString(row.address1)!}:{})};
}
async function projectLinkPreview(portalJobId:string,providerContact:(providerId:string)=>Promise<Json>){
 const detail=await callOperations({command:"portal.job",jobId:portalJobId});
 if(detail.error)return {ok:false,error:String(detail.error),portalJobId};
 const job=object(detail.job);
 if(job.id!==portalJobId)return {ok:false,error:"project_portal_identity_mismatch",portalJobId};
 const revision=asString(job.revision),providerContactId=asString(job.highlevelContactId);
 if(!revision)return {ok:false,error:"project_revision_unavailable",portalJobId};
 if(!providerContactId)return {ok:false,error:"project_provider_contact_identity_missing",portalJobId,expectedRevision:revision};
 let verified;
 try{verified=sanitizeProviderContact(await providerContact(providerContactId),providerContactId);}catch(error){return {ok:false,error:error instanceof Error?error.message:"project_provider_contact_unavailable",portalJobId,expectedRevision:revision,providerContactId};}
 return {ok:true,authority:"employee_hub",portalJobId,expectedRevision:revision,providerContactId,providerContactVerified:true,existingCustomerId:asString(job.customerId),existingProjectId:asString(job.projectId),kind:asString(job.kind)??asString(job.type),startAt:asString(job.startAt),endAt:asString(job.endAt),address:asString(job.address),correctionRequired:!asString(job.customerId)||!asString(job.projectId),providerContact:verified};
}
export function registerPortalRecordTools(server:McpServer,deps:ProjectLinkDeps={}){
 const read={annotations:{readOnlyHint:true,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE])};
 const write={annotations:{readOnlyHint:false,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE,WRITE_SCOPE])};
 const exact={requestId:z.string().uuid(),portalJobId:z.string().min(1).max(180),expectedRevision:z.string().min(1)};
 const providerContact=deps.providerContact??(async(providerId:string)=>object(await GhlClient.fromEnv().getContact(providerId)));
 server.registerTool("egc.preview_link_project",{description:"Read the exact Hub job/walkthrough revision and verify its provider contact identity before any native customer/project correction. Never matches by name and never writes.",inputSchema:z.object({portalJobId:z.string().min(1).max(180)}).strict(),...read},async input=>result(await projectLinkPreview(input.portalJobId,providerContact)));
 server.registerTool("egc.add_job_note",{description:"Append an explicitly authorized note to the exact authoritative Employee Hub job or walkthrough. Previous notes remain stored; supersedes may identify an earlier note correction. Requires the current Hub revision and stable request ID, verified by read-back. Does not send customer messages.",inputSchema:z.object({...exact,body:z.string().trim().min(1).max(10000),supersedes:z.string().uuid().optional()}),...write},async input=>result(await callOperations({command:"portal.note.add",...input},input.requestId)));
 server.registerTool("egc.update_job_operations",{description:"Update operational instructions or record dispatched, in-progress or completed state for the exact Hub record. Requires explicit user authorization, current revision and reason. Completion requires the actual occurrence timestamp and evidence; never infers a new sale, payment, customer acceptance or scope agreement.",inputSchema:z.object({...exact,changes:z.object({operationalScope:z.string().max(20000).optional(),status:z.enum(["dispatched","in_progress","completed"]).optional()}).strict(),reason:z.string().min(3).max(2000),occurredAt:z.string().datetime({offset:true}).optional(),completionEvidence:z.string().min(10).max(5000).optional()}),...write},async input=>result(await callOperations({command:"portal.job.edit",...input},input.requestId)));
 server.registerTool("egc.link_project",{description:"Establish a stable authoritative project for the exact Hub job/walkthrough. If its native customer link is missing, verifies the exact saved provider contact and uses the revision-bound Hub customer-link adoption path before ensuring the project. Never matches by name or latest job; ambiguous or stale identities fail for review.",inputSchema:z.object(exact),...write},async input=>{
  const direct=await callOperations({command:"portal.project.ensure",...input},input.requestId);
  const error=typeof direct.error==="string"?direct.error:null;
  if(!["project_customer_id_required","record_customer_link_missing"].includes(error??""))return result(direct);
  const preview=await projectLinkPreview(input.portalJobId,providerContact);
  if(!preview.ok)return result(preview);
  if(preview.expectedRevision!==input.expectedRevision)return result({ok:false,error:"record_revision_conflict",expectedRevision:input.expectedRevision,currentRevision:preview.expectedRevision});
  const linked=await callOperations({command:"schedule.link_customer",portalVisitId:input.portalJobId,expectedRevision:input.expectedRevision,providerContact:preview.providerContact as Json},input.requestId);
  if(linked.error)return result(linked);
  const linkedVisit=object(linked.visit),nextRevision=asString(linkedVisit.revision);
  if(linkedVisit.portalVisitId!==input.portalJobId||!nextRevision||!asString(linkedVisit.portalCustomerId)||!asString(linkedVisit.portalProjectId))return result({ok:false,error:"project_link_readback_mismatch"});
  const ensured=await callOperations({command:"portal.project.ensure",requestId:input.requestId,portalJobId:input.portalJobId,expectedRevision:nextRevision},input.requestId);
  return result({...ensured,customerLinkRecovered:true,providerContactId:preview.providerContactId,originalRevision:input.expectedRevision});
 });
}
