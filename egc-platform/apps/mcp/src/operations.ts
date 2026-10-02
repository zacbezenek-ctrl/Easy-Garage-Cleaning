import {AsyncLocalStorage} from "node:async_hooks";
import {randomUUID} from "node:crypto";
import type {McpServer} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {signRequest,createTaskSchema,patchTaskSchema,WRITE_COMMANDS,type Actor,type Command,type Delegate} from "@egc/operations";
import {DIRECT_SENDS_PAUSED,oauthSecurityMetadata,READ_SCOPE,WRITE_SCOPE} from "./oauth.js";
import {getCustomerTimeline} from '@egc/customer-state';
import {isRecord,safeDetails} from './tools/result.js';

// A Hub-approved grant acts as the integration mcp:<hub user>:<grant id> on behalf of delegate {user, role}.
export type Principal=Actor&{delegate?:Pick<Delegate,"user"|"role">};
// Only middleware after successful token verification may establish this context.
// OAuth grant IDs persist across refresh. Raw token values never leave the auth layer.
export const operationsPrincipal=new AsyncLocalStorage<Principal>();
// The Hub-signed grant stays beside the principal, never inside it, so tool results and logs cannot echo it.
const delegateAssertions=new WeakMap<Principal,string>();
export function runAsPrincipal<T>(principal:Principal,assertion:string|undefined,run:()=>T):T{
  if(principal.delegate&&assertion)delegateAssertions.set(principal,assertion);
  return operationsPrincipal.run(principal,run);
}
/** The exact four-field actor every signed contract accepts. */
export const bridgeActor=(principal:Principal):Actor=>({id:principal.id,kind:principal.kind,role:principal.role,workspace:principal.workspace});
/** The delegate forwarded in the envelope so the API can verify the Hub's signature and refuse non-manager writes. */
export function bridgeDelegate(principal:Principal):Delegate|null|undefined{
  if(!principal.delegate)return undefined;
  const assertion=delegateAssertions.get(principal);
  return assertion?{user:principal.delegate.user,role:principal.delegate.role,assertion}:null;
}
export const operationsEnabled=()=>process.env.EGC_OPERATIONS_ENABLED==="true";
export const OPERATIONS_WRITE_TOOLS=new Set(["actions.propose","actions.edit","actions.snooze","actions.complete","actions.complete_from_message","actions.cancel","actions.reconcile_inbound","egc.generate_brief"]);
export const LEGACY_MUTATIONS_DISABLED=new Set(["tasks.create","tasks.update","tasks.complete","appointments.delete","jobs.create","jobs.update","jobs.add_note","walkthroughs.create_draft","walkthroughs.update_draft","walkthroughs.approve"]);
// One-step customer sends. Paused in operations mode unless the operator explicitly re-enables them.
export const DIRECT_SEND_TOOLS=new Set(["conversations.send_message","send_sms","egc.send_followup"]);
export const directSendsEnabled=()=>process.env.EGC_MCP_DIRECT_SENDS_ENABLED==="true";
export const directSendsBlocked=()=>operationsEnabled()&&!directSendsEnabled();
// GHL-ALIGN: HighLevel owns follow-ups. Review tasks for unanswered customer texts are opt-in: exactly "true" on this
// service and on egc-api (which runs the reconciler and refuses the same way).
export const inboundTasksEnabled=()=>process.env.EGC_OPERATIONS_INBOUND_TASKS_ENABLED==="true";
export const INBOUND_TASKS_DISABLED=Object.freeze({ok:false,disabled:true,error:"inbound_tasks_disabled",message:"disabled: follow-ups live in HighLevel",created:0,instruction:"Nothing was created. Unanswered customer texts stay in HighLevel conversations; follow up there."});
export const LEGACY_MUTATION_DISABLED={error:"legacy_mutation_disabled_in_operations_mode",instruction:"Use canonical actions for internal work, egc.add_job_note for exact Hub notes, recording review for managed walkthroughs, and durable scheduling tools. Legacy parallel job/draft writes and destructive booking deletion remain disabled."};
export const DIRECT_SEND_DISABLED={error:"direct_send_disabled_in_operations_mode",sent:false,instruction:`Nothing was sent. ${DIRECT_SENDS_PAUSED} Tell the user the message has not been sent.`};
export function blockedToolCall(toolName:string){
  if(!operationsEnabled())return null;
  if(LEGACY_MUTATIONS_DISABLED.has(toolName))return LEGACY_MUTATION_DISABLED;
  return DIRECT_SEND_TOOLS.has(toolName)&&!directSendsEnabled()?DIRECT_SEND_DISABLED:null;
}
const result=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value,null,2)}],structuredContent:{result:value},...(isRecord(value)&&typeof value.error==='string'?{isError:true as const}:{})});
// The API refuses a Hub-approved grant whose stored approval no longer verifies (the Hub key was rotated, or it was altered).
export const DELEGATE_RECONNECT="This connection's Employee Hub approval is no longer valid, for example because the Hub signing key changed. Nothing was done. Ask the user to disconnect and reconnect the EGC connector and approve again in the Employee Hub; retrying will not help.";
export async function callOperations(command:Command,requestId:string=randomUUID(),fetcher:typeof fetch=fetch) {
  const principal=operationsPrincipal.getStore();
  if(!operationsEnabled())return {error:"operations_not_enabled",authority:"none",coverage:"unknown"};
  if(!principal)return {error:"verified_principal_required"};
  const delegate=bridgeDelegate(principal);
  if(delegate===null)return {error:"verified_principal_required"};
  const origin=process.env.EGC_OPERATIONS_API_ORIGIN,key=process.env.EGC_OPERATIONS_MCP_SIGNING_SECRET;
  if(!origin||!key||key.length<32)return {error:"operations_bridge_not_configured"};
  const readOnly=!WRITE_COMMANDS.has(command.command);
  const unavailable=(error:string,httpStatus?:number)=>({ok:false,error,requestId,...(httpStatus===undefined?{}:{httpStatus}),retryable:httpStatus===undefined||httpStatus===429||httpStatus>=500,
    ...(readOnly?{coverage:{complete:false,reason:error},instruction:"The source could not be read. This is not evidence of no records. Retry the same read after the source recovers."}:
      {retryMode:"same_request_id",instruction:"The write outcome is unknown. Retry exactly the same command and requestId. Do not create a fresh copy."})});
  try {
    const url=new URL(origin);
    if(url.protocol!=="https:"||url.pathname!=="/"||url.username||url.password||url.search||url.hash)return {error:"operations_bridge_not_configured"};
    const envelope=signRequest({v:1,iss:"mcp",aud:"egc-operations",iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor:bridgeActor(principal),...(delegate?{delegate}:{}),request:{requestId,body:command}},key);
    const response=await fetcher(new URL("/operations/rpc",url),{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify({envelope}),signal:AbortSignal.timeout(20000)});
    let body:unknown;
    try{body=await response.json();}catch{body=undefined;}
    const errorCode=isRecord(body)&&typeof body.error==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(body.error)?body.error:undefined;
    // An HTTP failure cannot become an empty successful calendar, even if a
    // proxy returns an inconsistent success body. Never echo raw edge errors.
    if(!response.ok&&(!errorCode||!isRecord(body)||body.ok===true))return unavailable(readOnly?(response.status===429?'operations_rate_limited':'operations_upstream_unavailable'):'operations_outcome_unknown',response.status);
    if(!isRecord(body))return unavailable(readOnly?'operations_response_invalid':'operations_outcome_unknown',response.status);
    if(errorCode)return {...safeDetails(body),error:errorCode,httpStatus:response.status,requestId,...(response.status===429||response.status>=500?{retryable:true,...(readOnly?{coverage:{complete:false,reason:errorCode}}:{retryMode:'same_request_id'})}:{}),...(errorCode==="delegate_invalid"?{instruction:DELEGATE_RECONNECT}:{})};
    if(body.error!==undefined||body.ok===false)return unavailable(readOnly?'operations_response_invalid':'operations_outcome_unknown',response.status);
    return {...body,httpStatus:response.status,requestId};
  }catch{return unavailable("operations_outcome_unknown");}
}
export function registerOperationsTools(server:McpServer,options:{includeAuthorityOverrides?:boolean}={}) {
  const read={annotations:{readOnlyHint:true,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE])};
  const write={annotations:{readOnlyHint:false,destructiveHint:false},...oauthSecurityMetadata([READ_SCOPE,WRITE_SCOPE])};
  const page={offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(200).default(50)};
  const revision={taskId:z.string().uuid(),revision:z.number().int().positive(),requestId:z.string().uuid().describe("Logical request identifier. Reuse exactly this ID with the identical payload on retry.")};
  server.registerTool("egc.operations_status",{description:"Read actual unified-operations capabilities and coverage. Does not enable features or send anything.",inputSchema:z.object({}),...read},async()=>result(await callOperations({command:"status"})));
  server.registerTool("actions.reconcile_inbound",{description:"Off by default because follow-ups live in HighLevel: returns disabled and creates nothing unless the owner set EGC_OPERATIONS_INBOUND_TASKS_ENABLED. When enabled, creates missing canonical review actions for unanswered customer messages using the verified Hub owner and response-time rule, including booked customers. Default starts at durable activation; an explicit lookbackDays reconciles older history. Does not send messages or approve drafts.",inputSchema:z.object({requestId:z.string().uuid(),lookbackDays:z.number().int().min(1).max(90).optional(),limit:z.number().int().min(1).max(200).default(50)}),...write},async({requestId,...args})=>result(operationsEnabled()&&!inboundTasksEnabled()?INBOUND_TASKS_DISABLED:await callOperations({command:"inbound.reconcile",...args},requestId)));
  server.registerTool("egc.calendar",{description:"Read the authoritative Employee Hub/Firestore schedule, NOT GHL appointments. Inclusive local startDate, exclusive endDate, America/Denver. Includes exact portal IDs, source revisions, pagination, and coverage. Errors never fall back to another calendar.",inputSchema:z.object({startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),...page}),...read},async args=>result(await callOperations({command:"calendar",...args,timeZone:"America/Denver"})));
  if(options.includeAuthorityOverrides!==false)server.registerTool("egc.job_brief",{description:"Read one exact Employee Hub job/visit by its portal ID, not a PostgreSQL UUID or the customer's latest job. Returns explicit scope approval evidence; absence is unknown. Business roles only.",inputSchema:z.object({jobId:z.string().min(1).max(180)}),...read},async args=>result(await callOperations({command:"portal.job",...args})));
  server.registerTool("egc.operations_owners",{description:"Read the current authoritative Hub business-user IDs before assigning canonical actions. Does not expose payroll or credential fields.",inputSchema:z.object({}),...read},async()=>result(await callOperations({command:"portal.members"})));
  server.registerTool("actions.queue",{description:"Read canonical EGC task records across all lead ages and booking stages, including completed task history. Counts cover registered tasks, not unimported commitments. Pagination is a live page; use a stored brief for fixed membership.",inputSchema:z.object({view:z.enum(["all","due","overdue","approvals","blocked","waiting","ownerless","completed"]).default("due"),dueBefore:z.string().datetime({offset:true}),owner:z.string().optional(),...page}),...read},async args=>result(await callOperations({command:"queue",...args})));
  server.registerTool("actions.review",{description:"Read current action revision, exact draft preview hash, stored approvals and audit history. Does not approve or send. Human draft approvals currently occur in the signed-in Hub; MCP tokens are identified integration grants, not assumed human identities.",inputSchema:z.object({taskId:z.string().uuid()}),...read},async args=>result(await callOperations({command:"task.get",...args})));
  server.registerTool("actions.propose",{description:"Persist a canonical task/proposal with verified owner, deadline, completion condition and optional exact portal linkage. Creates draft work only; does not send, book, approve, or collect money. Reuse requestId on retry.",inputSchema:z.object({requestId:z.string().uuid(),task:createTaskSchema}),...write},async({requestId,task})=>result(await callOperations({command:"task.create",task},requestId)));
  server.registerTool("actions.edit",{description:"Edit a canonical action at its exact displayed revision. Stale revisions fail; changing approved content invalidates approval. No external send.",inputSchema:z.object({...revision,changes:patchTaskSchema}),...write},async({requestId,...args})=>result(await callOperations({command:"task.edit",...args},requestId)));
  server.registerTool("actions.snooze",{description:"Move the next due/review time on the same canonical action with a recorded reason. Requires current revision and stable requestId.",inputSchema:z.object({...revision,until:z.string().datetime({offset:true}),reason:z.string().min(3).max(1000)}),...write},async({requestId,...args})=>result(await callOperations({command:"task.snooze",...args},requestId)));
  server.registerTool("actions.complete",{description:"Complete an internal action with an explicit recorded outcome and current revision. Cannot certify message delivery or payment collection; those require provider evidence and are blocked.",inputSchema:z.object({...revision,outcome:z.string().min(3).max(5000)}),...write},async({requestId,...args})=>result(await callOperations({command:"task.complete",...args},requestId)));
  server.registerTool("actions.cancel",{description:"Cancel the named canonical action with a reason and exact revision, preserving history. Does not cancel a customer booking.",inputSchema:z.object({...revision,reason:z.string().min(3).max(2000)}),...write},async({requestId,...args})=>result(await callOperations({command:"task.cancel",...args},requestId)));
  server.registerTool("egc.daily_brief",{description:"Read a previously saved brief, its immutable task membership and separate current-change indicators. No brief creation, approval, send, or scheduling side effect.",inputSchema:z.object({briefId:z.string().uuid().optional(),...page}),...read},async({briefId,...args})=>result(await callOperations(briefId?{command:"brief.get",briefId,...args}:{command:"brief.latest",...args})));
  server.registerTool("egc.generate_brief",{description:"Explicitly save an immutable canonical-task brief snapshot with coverage warnings. This internal write sends no notification, changes no task, and creates no recurring schedule. Use egc.daily_brief to read it.",inputSchema:z.object({requestId:z.string().uuid(),dueBefore:z.string().datetime({offset:true}),timeZone:z.string().default("America/Denver")}),...write},async({requestId,...args})=>result(await callOperations({command:"brief.create",...args},requestId)));
  if(options.includeAuthorityOverrides!==false)server.registerTool("egc.customer_history",{description:"Read a paginated customer timeline of messages, calls, visits, recordings, actions and notes with canonical sales evidence and durable user-confirmed outcomes. An exact contactId also reads all exactly linked Employee Hub records, including scope, original dates, quote, completion and verified payment evidence, bounded to 100 native records with explicit completeness and truncation. An exact portalJobId resolves its customer; explicit customer and job links must agree. Missing financial evidence or an unavailable native source remains unknown. Canonical evidence is persisted, with last-reconciled freshness; this read never reconciles.",inputSchema:z.object({contactId:z.string().uuid().optional(),portalJobId:z.string().min(1).max(180).optional(),...page}).refine(value=>Boolean(value.contactId||value.portalJobId),{message:"An exact contactId or portalJobId is required"}),...read},async args=>{const history=await callOperations({command:"history",...args});return result({...history,...(args.contactId?{canonical:await getCustomerTimeline({contactId:args.contactId,refresh:false})}:{})});});
}
