import {and,asc,eq} from "drizzle-orm";
import {getDb,schema} from "@egc/database";
import {GhlClient,asDate} from "@egc/ghl";
import {executeCommunication,assertSmsDraftSender,validSmsFromNumbers,OperationsError,persistOutboundMessage,preflightRecipient,reconcileCommunication,taskSendRequestId,type Actor,type Command,type CommunicationProvider,type OperationsConfiguration,type OperationsService} from "@egc/operations";
import {stableUuid} from "./recording-contracts.js";

type Db=ReturnType<typeof getDb>;
type SendCommand=Extract<Command,{command:"task.send"}>;
type Json=Record<string,unknown>;
export type ActionSendProvider=CommunicationProvider&{getContact:(id:string)=>Promise<Json>;locationId:string};
type Execution=typeof schema.communicationExecutions.$inferSelect;
export interface ActionSendDependencies {
  service:()=>Pick<OperationsService,"approveForSend"|"sendReadiness"|"recordExecutionStarted"|"execute">;
  provider:()=>ActionSendProvider;
  smsFromNumbers?:readonly string[];
  db?:()=>Db;
  now?:()=>Date;
  log?:(event:{code:string;taskId:string;executionId:string|null})=>void;
  // Store seams for unit tests; production uses the shared communication execution.
  communication?:Partial<{prior:typeof priorTaskSendExecution;execute:typeof executeCommunication;reconcile:typeof reconcileCommunication;preflight:typeof preflightRecipient;persist:typeof persistOutboundMessage}>;
}
const record=(v:unknown):Json=>v&&typeof v==="object"&&!Array.isArray(v)?v as Json:{};
export function actionSmsFromNumbers(env:NodeJS.ProcessEnv):string[]{
  const raw=env.EGC_OPERATIONS_SMS_FROM_NUMBERS;
  return raw?validSmsFromNumbers(raw.split(",").map(value=>value.trim())):[];
}
export const actionSendEnabled=(env:NodeJS.ProcessEnv)=>env.EGC_OPERATIONS_ACTION_SEND_ENABLED==="true";
// One provider request per approved revision; approveForSend reads the same claim.
export {taskSendRequestId};
export async function priorTaskSendExecution(db:Db,contactId:string,requestId:string):Promise<Execution|undefined> {
  const [row]=await db.select().from(schema.communicationExecutions).where(and(eq(schema.communicationExecutions.contactId,contactId),eq(schema.communicationExecutions.requestId,requestId))).orderBy(asc(schema.communicationExecutions.createdAt)).limit(1);
  return row;
}
const knownExecutionFailure=/^(?:message_request_conflict|message_attachments_invalid)$/;

/** Action Center one-tap send. Transaction 1 (approveForSend) records the confirming
 * person's approval; the recipient is verified live (DND, exact phone/email, contact
 * identity), the approved revision is re-checked, and the exact approved draft, with its
 * attachment URLs in order, is executed once. Unknown outcomes are reconcile-only.
 */
export function createActionSender(deps:ActionSendDependencies) {
  const clock=deps.now??(()=>new Date()),db=()=>deps.db?.()??getDb();
  const c={prior:priorTaskSendExecution,execute:executeCommunication,reconcile:reconcileCommunication,preflight:preflightRecipient,persist:persistOutboundMessage,...deps.communication};
  return async function sendTaskMessage(actor:Actor,command:SendCommand,requestId:string):Promise<Json> {
    const service=deps.service();
    const approved=await service.approveForSend(actor,command,requestId);
    const task=record(approved.task),approval=record(approved.approval),draft=record(task.draftPayload),revision=approved.approvedRevision;
    if(typeof task.id!=="string"||typeof task.contactId!=="string"||typeof approval.id!=="string"||typeof revision!=="number"||task.id!==command.taskId)throw new OperationsError("send_approval_unverified",503);
    const taskId=task.id,contactId=task.contactId,approvalId=approval.id,sendRequestId=taskSendRequestId(taskId,revision);
    const options={now:clock,source:"operations"},provider=deps.provider();
    const prior=await c.prior(db(),contactId,sendRequestId);
    let payload:Json,result:Json;
    if(prior) {
      // Retry, duplicate tap or another confirmer of the same revision: read back only.
      payload=prior.payload;
      if(draft.channel==="sms"&&(payload.fromNumber??null)!==(draft.fromNumber??null))throw new OperationsError("message_sender_execution_mismatch",409,{sent:"unknown",retryMode:"reconcile_only"});
      result=await c.reconcile(prior.id,undefined,actor.id,provider,db(),options);
    } else {
      assertSmsDraftSender(draft,deps.smsFromNumbers);
      const channel=draft.channel==="email"?"Email":"SMS",recipient=String(draft.recipient??"");
      const verified=await c.preflight({contactId,channel,...(channel==="SMS"?{toNumber:recipient}:{emailTo:recipient})},()=>provider,db());
      if(!verified.ok)throw new OperationsError(verified.error,verified.error==="contact_preflight_unavailable"?503:409,{sent:false});
      const live=record(verified.live);
      if(verified.contact.provider!=="ghl"||live.id!==verified.contact.providerId||live.locationId&&live.locationId!==provider.locationId)throw new OperationsError("message_contact_identity_mismatch",409,{sent:false});
      const attachments=(Array.isArray(draft.attachments)?draft.attachments:[]).map(item=>record(item).url);
      if(attachments.some(url=>typeof url!=="string"||!url))throw new OperationsError("message_attachments_invalid",409,{sent:false});
      // The guard compares toNumber/emailTo with the approved recipient, so send exactly it.
      payload={type:channel,contactId:verified.contact.providerId,message:String(draft.body??""),...(channel==="SMS"?{toNumber:recipient,fromNumber:draft.fromNumber}:{emailTo:recipient,subject:String(draft.subject??"")}),...(attachments.length?{attachments}:{})};
      // The last check before the provider, with no network call in between: a reply, a
      // rejection or an edit that landed during the live preflight stops the send here.
      await service.sendReadiness(actor,taskId,revision,approvalId);
      try{result=await c.execute({requestId:sendRequestId,actorId:actor.id,contactId,payload},provider,db(),{...options,beforeClaim:tx=>service.sendReadiness(actor,taskId,revision,approvalId,tx)});}
      catch(error){const code=error instanceof Error?error.message:"";if(knownExecutionFailure.test(code))throw new OperationsError(code,409,{sent:false});throw error;}
    }
    const executionId=typeof result.executionId==="string"?result.executionId:null;
    if(executionId)await service.recordExecutionStarted(actor,taskId,revision,{executionId,requestId:sendRequestId,approvalId,channel:String(payload.type),attachmentCount:Array.isArray(payload.attachments)?payload.attachments.length:0});
    const base={taskId,approvedRevision:revision,approvalId,executionId,edited:approved.edited===true};
    if(result.error==="message_outcome_unknown")throw new OperationsError("message_outcome_unknown",503,{...base,sent:"unknown",retryMode:"reconcile_only",retryable:true});
    if(result.error==="message_verification_pending")return {ok:true,sent:true,delivered:false,verification:"pending",messageId:result.messageId??null,retryMode:"reconcile_only",...base,mirrored:false,completion:null};
    if(typeof result.error==="string")throw new OperationsError("message_execution_unavailable",503,{...base,sent:"unknown",retryMode:"reconcile_only",retryable:true});
    if(result.ok!==true)throw new OperationsError("message_delivery_failed",409,{...base,sent:true,status:typeof result.status==="string"?result.status:null});
    let mirrored=false;
    const message=record(result.providerMessage);
    if(result.providerMessage&&typeof result.messageId==="string"&&typeof result.conversationId==="string") {
      // Mirror once: re-writing it on every read-back would keep changing the conversation
      // context (and invalidating other drafts' approvals) without new customer activity.
      const [existing]=await db().select({id:schema.messages.id}).from(schema.messages).where(eq(schema.messages.providerId,result.messageId)).limit(1);
      if(existing)mirrored=true;
      else try{await c.persist({contactId,contactProviderId:String(payload.contactId),locationId:provider.locationId,channel:payload.type==="Email"?"Email":"SMS",body:String(payload.message),providerMessageId:result.messageId,conversationProviderId:result.conversationId,providerPayload:message,occurredAt:asDate(message.dateAdded)??clock()},db(),clock);mirrored=true;}
      catch{deps.log?.({code:"action_send_mirror_pending",taskId,executionId});}
    }
    const fresh=result.verificationFresh!==false;
    let completion:Json|null=null;
    if(result.delivered===true&&fresh&&executionId) {
      try{const done=await service.execute(actor,{command:"task.complete_from_message",taskId,revision,executionId},stableUuid(`task-send-complete:${taskId}:${executionId}`));completion={ok:true,status:record(done.task).status??null};}
      catch(error){completion={ok:false,error:error instanceof OperationsError?error.code:"task_completion_unavailable"};}
    }
    return {ok:true,sent:true,delivered:result.delivered===true,status:typeof result.status==="string"?result.status:null,messageId:typeof result.messageId==="string"?result.messageId:null,verifiedAt:typeof result.verifiedAt==="string"?result.verifiedAt:null,verificationFresh:fresh,duplicatePrevented:result.duplicatePrevented===true,...base,mirrored,completion};
  };
}
/** The OperationsService hook, or undefined while one-tap sending is off (the default) or
 * the HighLevel credentials it needs are missing. */
export function actionSendHook(env:NodeJS.ProcessEnv,service:ActionSendDependencies["service"],options:Pick<ActionSendDependencies,"log"|"now">={}):OperationsConfiguration["sendTaskMessage"] {
  if(!actionSendEnabled(env))return undefined;
  const token=env.GHL_PRIVATE_INTEGRATION_TOKEN,locationId=env.GHL_LOCATION_ID;
  if(!token||!locationId)return undefined;
  return createActionSender({service,smsFromNumbers:actionSmsFromNumbers(env),provider:()=>new GhlClient(token,locationId),...options});
}
