import type {McpServer} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type {Actor} from "@egc/operations";
import {oauthSecurityMetadata,READ_SCOPE,WRITE_SCOPE} from "../oauth.js";
import {operationsPrincipal,type Principal} from "../operations.js";
import {error,isRecord,result,settle,type ToolResult} from "./result.js";

export const TOOL_CLASSES=["read","write","destructive","send","money"] as const;
export type ToolClass=typeof TOOL_CLASSES[number];
// Irreversible or customer-facing effects run only after a side-effect-free preview and an explicit confirmation.
export const TWO_STEP_CLASSES:ReadonlySet<ToolClass>=new Set(["destructive","send","money"]);
const TOOL_NAME=/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const SAMPLE_UUID="00000000-0000-4000-8000-000000000000";
export const requestIdField=z.string().uuid().describe("Logical request identifier. Reuse exactly this ID with the identical payload on retry.");
export const confirmTokenField=z.string().min(16).max(4096).optional().describe("Omit to receive a preview; nothing is sent or changed. Supply only the token returned for this exact request after the owner explicitly approves it.");

export type ToolContext={actor:Actor;now:()=>Date};
export type ToolSpec<I extends z.ZodObject<any,any>>={
  name:string;class:ToolClass;description:string;ownerOnly?:boolean;input:I;output?:z.ZodType;
  preview?(input:z.output<I>,ctx:ToolContext):unknown;
  handler(input:z.output<I>,ctx:ToolContext):unknown;
};
export type ToolPolicy={class:ToolClass;readOnly:boolean;scope:string;scopes:string[];requiresRequestId:boolean;twoStep:boolean;ownerOnly:boolean};
export type ToolDef<I extends z.ZodObject<any,any>=z.ZodObject<any,any>>=Readonly<ToolSpec<I>&{policy:ToolPolicy;annotations:{readOnlyHint:boolean;destructiveHint:boolean;openWorldHint:boolean}}>;

const invalid=(name:unknown,reason:string)=>new Error(`invalid_tool_definition:${String(name)}:${reason}`);
const accepts=(schema:unknown,value:unknown)=>schema instanceof z.ZodType&&schema.safeParse(value).success;

/** Derives scope, annotations, request-ID and two-step requirements from the tool class so metadata and enforcement cannot drift. */
export function defineTool<I extends z.ZodObject<any,any>>(spec:ToolSpec<I>):ToolDef<I>{
  const {name,input}=spec;
  if(typeof name!=="string"||!TOOL_NAME.test(name))throw invalid(name,"name_must_be_domain_verb");
  if(!TOOL_CLASSES.includes(spec.class))throw invalid(name,"unknown_class");
  if(typeof spec.description!=="string"||!spec.description.trim())throw invalid(name,"description_required");
  if(!(input instanceof z.ZodObject))throw invalid(name,"input_must_be_object");
  if((input._zod.def.catchall as z.ZodType|undefined)?._zod.def.type!=="never")throw invalid(name,"input_must_be_strict");
  if(spec.output!==undefined&&!(spec.output instanceof z.ZodType))throw invalid(name,"output_must_be_schema");
  if(typeof spec.handler!=="function")throw invalid(name,"handler_required");
  const readOnly=spec.class==="read",twoStep=TWO_STEP_CLASSES.has(spec.class),shape=input.shape as Record<string,unknown>;
  if(!readOnly&&!(accepts(shape.requestId,SAMPLE_UUID)&&!accepts(shape.requestId,undefined)&&!accepts(shape.requestId,"not-a-uuid")))throw invalid(name,"write_requires_request_id");
  if(twoStep&&!(accepts(shape.confirmToken,undefined)&&typeof spec.preview==="function"))throw invalid(name,"two_step_requires_confirm_path");
  if(!twoStep&&(shape.confirmToken!==undefined||spec.preview!==undefined))throw invalid(name,"confirm_path_requires_two_step_class");
  const scopes=readOnly?[READ_SCOPE]:[READ_SCOPE,WRITE_SCOPE];
  return Object.freeze({...spec,
    policy:Object.freeze({class:spec.class,readOnly,scope:readOnly?READ_SCOPE:WRITE_SCOPE,scopes,requiresRequestId:!readOnly,twoStep,ownerOnly:spec.ownerOnly===true}),
    annotations:Object.freeze({readOnlyHint:readOnly,destructiveHint:twoStep,openWorldHint:spec.class==="send"||spec.class==="money"})});
}

/** Pluggable second step. Until a verifier is installed every confirmation is refused, so two-step tools can only preview. */
export type ConfirmGate={
  issue(request:{tool:string;input:Record<string,unknown>;actor:Actor;preview:unknown;now:Date}):Promise<{token:string;expiresAt:string}|null>|{token:string;expiresAt:string}|null;
  verify(request:{tool:string;input:Record<string,unknown>;actor:Actor;token:string;now:Date}):Promise<boolean>|boolean;
};
export const confirmationUnavailable:ConfirmGate={issue:()=>null,verify:()=>false};
export type RegisterOptions={confirm?:ConfirmGate;now?:()=>Date;reserved?:Iterable<string>};
const confirmationEnvelope=z.object({requiresConfirmation:z.literal(true),executed:z.literal(false),tool:z.string(),requestId:z.string(),preview:z.unknown(),confirmToken:z.string().optional(),expiresAt:z.string().optional(),confirmation:z.literal("unavailable").optional(),instruction:z.string()});
// A Hub-approved grant is the owner's only when its delegate role is owner. A shared-login grant
// (mcp-oauth-grant:) is the owner's interactive login; the static service bearer is not the owner.
export const isOwnerGrant=(actor:Principal)=>actor.delegate?actor.delegate.role==="owner"&&actor.id.startsWith(`mcp:${actor.delegate.user}:`):actor.id.startsWith("mcp-oauth-grant:");

export async function invokeTool(def:ToolDef,raw:unknown,options:RegisterOptions={}):Promise<ToolResult>{
  const actor=operationsPrincipal.getStore();
  if(!actor)return error("verified_principal_required");
  if(def.policy.ownerOnly&&!isOwnerGrant(actor))return error("owner_grant_required",{instruction:"Connect with the owner's Employee Hub login to use this tool."});
  const ctx:ToolContext={actor,now:options.now??(()=>new Date())},args=isRecord(raw)?raw:{};
  const {confirmToken,...request}=args,requestId=String(request.requestId);
  let executing=false;
  const execute=async(input:Record<string,unknown>)=>{executing=true;return checked(def,await def.handler(input,ctx),requestId);};
  try{
    if(!def.policy.twoStep)return await execute(args);
    const gate=options.confirm??confirmationUnavailable;
    if(confirmToken===undefined){
      const preview=await def.preview!(request,ctx);
      if(isRecord(preview)&&typeof preview.error==="string")return error(preview.error,preview);
      const issued=await gate.issue({tool:def.name,input:request,actor,preview,now:ctx.now()});
      return result({requiresConfirmation:true,executed:false,tool:def.name,requestId,preview,...(issued
        ?{confirmToken:issued.token,expiresAt:issued.expiresAt,instruction:"Nothing was sent or changed. Show this preview to the owner and call again with the identical arguments plus confirmToken only after they explicitly approve it."}
        :{confirmation:"unavailable" as const,instruction:UNCONFIRMABLE})});
    }
    if(gate===confirmationUnavailable)return error("two_step_confirmation_unavailable",{requestId,instruction:UNCONFIRMABLE});
    if(await gate.verify({tool:def.name,input:request,actor,token:String(confirmToken),now:ctx.now()})!==true)return error("confirmation_invalid_or_expired",{requestId,instruction:"Nothing was sent or changed. Request a fresh preview with the same requestId and arguments."});
    return await execute(request);
  }catch{return executing&&!def.policy.readOnly?outcomeUnknown(def,requestId):error("tool_operation_failed",{tool:def.name});}
}
const UNCONFIRMABLE="Nothing was sent or changed. Two-step confirmation is not enabled on this server, so this tool can only preview. Tell the user it has not been done.";
// A write handler may have committed before it threw or returned malformed output; only a replay of the same request is safe.
const outcomeUnknown=(def:ToolDef,requestId:string)=>error("tool_outcome_unknown",{tool:def.name,requestId,retryMode:"same_request_id",instruction:"Retry with the identical requestId and arguments; do not create a new request."});
function checked(def:ToolDef,value:unknown,requestId:string){
  const settled=settle(value);
  if(!settled.isError&&def.output&&!def.output.safeParse(value).success)return def.policy.readOnly?error("tool_output_invalid",{tool:def.name}):outcomeUnknown(def,requestId);
  return settled;
}

export function registerTools(server:McpServer,defs:readonly ToolDef[],options:RegisterOptions={}){
  const names=new Set<string>(),reserved=new Set(options.reserved??[]);
  for(const def of defs){if(names.has(def.name)||reserved.has(def.name))throw invalid(def.name,"duplicate_name");names.add(def.name);}
  for(const def of defs){
    const output=def.output&&z.object({result:def.policy.twoStep?z.union([def.output,confirmationEnvelope]):def.output});
    server.registerTool(def.name,{description:def.description,inputSchema:def.input,...(output?{outputSchema:output}:{}),annotations:{...def.annotations},...oauthSecurityMetadata(def.policy.scopes)},
      (args:unknown)=>invokeTool(def,args,options));
  }
  return [...names];
}
