import {describe,it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {schema} from "@egc/database";
import {OperationsError,OperationsService,type Actor} from "@egc/operations";
import {actionSendHook,createActionSender,taskSendRequestId,type ActionSendDependencies} from "./action-send.js";
import {stableUuid} from "./recording-contracts.js";
const NOW=new Date("2026-10-01T15:00:00.000Z");
const owner:Actor={id:"synthetic-owner",role:"owner",kind:"human",workspace:"egc"};
const integration:Actor={id:"synthetic-grant",role:"integration",kind:"integration",workspace:"egc"};
const taskId="00000000-0000-4000-8000-0000000000aa",contactId="00000000-0000-4000-8000-0000000000bb",approvalId="00000000-0000-4000-8000-0000000000cc",executionId="00000000-0000-4000-8000-0000000000dd";
const links=[{kind:"portal_quote",url:"https://easygaragecleaning.com/portal/quote/synthetic-1",label:"Your quote",refId:null},{kind:"payment_link",url:"https://pay.example.com/synthetic-deposit",label:"Pay the deposit",refId:"job-1"}];
const draft={channel:"sms",recipient:"+15555550100",subject:"",body:"Synthetic approved message",sendWindowStart:"2026-10-01T14:00:00.000Z",sendWindowEnd:"2026-10-02T02:00:00.000Z",attachments:links};
const command=(extra={})=>({command:"task.send" as const,taskId,revision:1,previewHash:"a".repeat(64),confirm:true as const,...extra});
const savedContact={id:contactId,provider:"ghl",providerId:"synthetic-provider-id"};
// Minimal read-only store for the live recipient preflight (contacts and leads only).
function fakeDb(lead:Record<string,unknown>={dnd:false},mirror=false){
 const limit=(table:unknown)=>async()=>table===schema.contacts?[savedContact]:table===schema.leads?[lead]:table===schema.messages&&mirror?[{id:"synthetic-mirror"}]:[];
 return {select:()=>({from:(table:unknown)=>({where:()=>({limit:limit(table)})})})} as unknown as ReturnType<NonNullable<ActionSendDependencies["db"]>>;
}
function harness(options:{approved?:Record<string,unknown>;live?:Record<string,unknown>;lead?:Record<string,unknown>;prior?:Record<string,unknown>;execute?:Record<string,unknown>;approveError?:OperationsError;mirror?:boolean}={}) {
 const provider={locationId:"synthetic-location",getContact:vi.fn(async()=>({contact:{id:"synthetic-provider-id",locationId:"synthetic-location",phone:"+15555550100",...options.live}})),sendMessage:vi.fn(async()=>({messageId:"synthetic-message"})),getMessage:vi.fn(async()=>({}))};
 const service={
  approveForSend:vi.fn(async()=>{if(options.approveError)throw options.approveError;return {ok:true,task:{id:taskId,contactId,revision:1,draftPayload:draft},approval:{id:approvalId},approvedRevision:1,edited:false,...options.approved};}),
  sendReadiness:vi.fn(async()=>({})),recordExecutionStarted:vi.fn(async()=>{}),execute:vi.fn(async()=>({ok:true,task:{status:"completed"}}))
 };
 const execute=vi.fn(async(..._args:unknown[])=>options.execute??{ok:true,messageId:"synthetic-message",conversationId:"synthetic-conversation",status:"delivered",delivered:true,verifiedAt:NOW.toISOString(),executionId,duplicatePrevented:false,providerMessage:{id:"synthetic-message",dateAdded:NOW.toISOString()}});
 const reconcile=vi.fn(async()=>({ok:true,messageId:"synthetic-message",status:"sent",delivered:false,executionId,duplicatePrevented:true}));
 const persist=vi.fn(async()=>{}),prior=vi.fn(async()=>options.prior as never);
 const now=vi.fn(()=>NOW);
 const send=createActionSender({service:()=>service as unknown as ReturnType<ActionSendDependencies["service"]>,provider:()=>provider,db:()=>fakeDb(options.lead,options.mirror),now,communication:{execute:execute as never,reconcile:reconcile as never,persist,prior}});
 return {send,provider,service,execute,reconcile,persist,prior,now};
}
describe("one-tap send flag and wiring",()=>{
 const creds={GHL_PRIVATE_INTEGRATION_TOKEN:"synthetic-token-not-real",GHL_LOCATION_ID:"synthetic-location"};
 it("is off unless exactly true and HighLevel is configured",()=>{
  const service=()=>({}) as never;
  for(const env of [{},creds,{...creds,EGC_OPERATIONS_ACTION_SEND_ENABLED:"false"},{...creds,EGC_OPERATIONS_ACTION_SEND_ENABLED:"TRUE"},{...creds,EGC_OPERATIONS_ACTION_SEND_ENABLED:"1"},{EGC_OPERATIONS_ACTION_SEND_ENABLED:"true"},{EGC_OPERATIONS_ACTION_SEND_ENABLED:"true",GHL_LOCATION_ID:"x"}])expect(actionSendHook(env,service)).toBeUndefined();
  expect(typeof actionSendHook({...creds,EGC_OPERATIONS_ACTION_SEND_ENABLED:"true"},service)).toBe("function");
 });
 it("derives one stable provider request per approved revision",()=>{expect(taskSendRequestId(taskId,1)).toBe(stableUuid(`task-send:${taskId}:1`));expect(taskSendRequestId(taskId,1)).toBe(taskSendRequestId(taskId,1));expect(taskSendRequestId(taskId,2)).not.toBe(taskSendRequestId(taskId,1));expect(taskSendRequestId(taskId,1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);});
});
describe("task.send authorization before any database or provider access",()=>{
 const unreachable=new Proxy({},{get:()=>{throw new Error("database must not be touched");}}) as never;
 it("refuses integrations and crew, and answers disabled without a hook",async()=>{
  const hook=vi.fn(async()=>({ok:true}));const service=new OperationsService(unreachable,{workspace:"egc",sendTaskMessage:hook});
  await expect(service.execute(integration,command(),randomUUID())).rejects.toMatchObject({code:"human_send_confirmation_required",status:403});
  await expect(service.execute({...owner,role:"crew"},command(),randomUUID())).rejects.toMatchObject({code:"role_forbidden",status:403});
  for(const body of [command({confirm:false}),command({previewHash:"stale"}),{...command(),confirm:undefined},command({draft:{...draft,recipient:"555"}})])await expect(service.execute(owner,body,randomUUID())).rejects.toMatchObject({code:"invalid_command",status:400});
  await expect(service.execute(owner,command(),"not-a-uuid")).rejects.toMatchObject({code:"request_id_required"});
  expect(hook).not.toHaveBeenCalled();
  await expect(new OperationsService(unreachable,{workspace:"egc"}).execute(owner,command(),randomUUID())).rejects.toMatchObject({code:"action_send_disabled",status:503});
  const requestId=randomUUID();await service.execute({...owner,id:"synthetic-sales",role:"sales"},command(),requestId);expect(hook).toHaveBeenCalledWith({...owner,id:"synthetic-sales",role:"sales"},command(),requestId);
 });
});
describe("one-tap send orchestration",()=>{
 it("sends exactly the approved draft, with its attachment URLs in order, under the stable request ID",async()=>{
  const h=harness(),requestId=randomUUID(),r=await h.send(owner,command(),requestId);
  expect(h.service.approveForSend).toHaveBeenCalledWith(owner,command(),requestId);expect(h.service.sendReadiness).toHaveBeenCalledWith(owner,taskId,1,approvalId);
  expect(h.execute).toHaveBeenCalledTimes(1);const [input,provider,,options]=h.execute.mock.calls[0] as unknown as [Record<string,unknown>,unknown,unknown,{now:()=>Date;source:string}];
  expect(input).toEqual({requestId:taskSendRequestId(taskId,1),actorId:owner.id,contactId,payload:{type:"SMS",contactId:"synthetic-provider-id",message:draft.body,toNumber:draft.recipient,attachments:links.map(l=>l.url)}});
  expect(provider).toBe(h.provider);expect(options.source).toBe("operations");expect(options.now()).toBe(NOW);
  expect(h.service.recordExecutionStarted).toHaveBeenCalledWith(owner,taskId,1,expect.objectContaining({executionId,requestId:taskSendRequestId(taskId,1),approvalId,attachmentCount:2}));
  expect(h.persist).toHaveBeenCalledTimes(1);expect(h.service.execute).toHaveBeenCalledWith(owner,{command:"task.complete_from_message",taskId,revision:1,executionId},stableUuid(`task-send-complete:${taskId}:${executionId}`));
  expect(r).toMatchObject({ok:true,sent:true,delivered:true,executionId,approvedRevision:1,mirrored:true,completion:{ok:true,status:"completed"}});expect(JSON.stringify(r)).not.toContain("providerMessage");
 });
 it("re-checks readiness after the live preflight, immediately before the provider call",async()=>{
  const h=harness();await h.send(owner,command(),randomUUID());
  const preflight=h.provider.getContact.mock.invocationCallOrder[0]!,ready=h.service.sendReadiness.mock.invocationCallOrder[0]!,sent=h.execute.mock.invocationCallOrder[0]!;
  expect(preflight).toBeLessThan(ready);expect(ready).toBeLessThan(sent);
  // A reply, rejection or edit that lands during the preflight is caught with nothing sent.
  const late=harness();late.service.sendReadiness.mockRejectedValueOnce(new OperationsError("send_approval_not_current",409));
  await expect(late.send(owner,command(),randomUUID())).rejects.toMatchObject({code:"send_approval_not_current",status:409});
  expect(late.provider.getContact).toHaveBeenCalledTimes(1);expect(late.execute).not.toHaveBeenCalled();expect(late.provider.sendMessage).not.toHaveBeenCalled();expect(late.service.recordExecutionStarted).not.toHaveBeenCalled();
 });
 it("an email sends the approved subject and recipient, and an edited draft uses its new revision",async()=>{
  const email={...draft,channel:"email",recipient:"synthetic@example.invalid",subject:"Synthetic subject",attachments:[]};
  const h=harness({approved:{task:{id:taskId,contactId,revision:2,draftPayload:email},approvedRevision:2,edited:true},live:{email:"Synthetic@Example.invalid"}});
  const r=await h.send(owner,command({draft:email}),randomUUID());
  expect(h.execute.mock.calls[0]?.[0]).toEqual({requestId:taskSendRequestId(taskId,2),actorId:owner.id,contactId,payload:{type:"Email",contactId:"synthetic-provider-id",message:draft.body,emailTo:"synthetic@example.invalid",subject:"Synthetic subject"}});
  expect(r).toMatchObject({approvedRevision:2,edited:true});
 });
 it("stale revisions and previews stop before any provider call",async()=>{
  for(const code of ["task_revision_conflict","approval_preview_changed","draft_window_expired","task_not_owned"]){const h=harness({approveError:new OperationsError(code,409)});await expect(h.send(owner,command(),randomUUID())).rejects.toMatchObject({code});expect(h.provider.getContact).not.toHaveBeenCalled();expect(h.provider.sendMessage).not.toHaveBeenCalled();expect(h.execute).not.toHaveBeenCalled();expect(h.prior).not.toHaveBeenCalled();}
 });
 it("a do-not-contact or mismatched customer is refused with nothing sent",async()=>{
  for(const [options,code] of [[{lead:{dnd:true}},"contact_do_not_contact"],[{live:{dnd:true}},"contact_do_not_contact"],[{live:{dndSettings:{SMS:{status:"active"}}}},"contact_do_not_contact"],[{live:{phone:"+15555550199"}},"verified_contact_phone_required"],[{live:{id:"another-contact"}},"message_contact_identity_mismatch"],[{live:{locationId:"another-location"}},"message_contact_identity_mismatch"]] as const){
   const h=harness(options as never);await expect(h.send(owner,command(),randomUUID())).rejects.toMatchObject({code,status:409,details:{sent:false}});expect(h.execute).not.toHaveBeenCalled();expect(h.provider.sendMessage).not.toHaveBeenCalled();expect(h.service.recordExecutionStarted).not.toHaveBeenCalled();
  }
  const h=harness({live:{}});h.provider.getContact.mockRejectedValueOnce(new Error("timeout"));await expect(h.send(owner,command(),randomUUID())).rejects.toMatchObject({code:"contact_preflight_unavailable",status:503});expect(h.execute).not.toHaveBeenCalled();
 });
 it("an unknown provider outcome is a retryable 503 that never resends",async()=>{
  const h=harness({execute:{ok:false,error:"message_outcome_unknown",executionId,retryMode:"reconcile_only"}});
  await expect(h.send(owner,command(),randomUUID())).rejects.toMatchObject({code:"message_outcome_unknown",status:503,details:{executionId,retryMode:"reconcile_only",retryable:true,sent:"unknown"}});
  expect(h.service.recordExecutionStarted).toHaveBeenCalledTimes(1);expect(h.persist).not.toHaveBeenCalled();expect(h.service.execute).not.toHaveBeenCalled();
 });
 it("an existing execution for the approved revision is only reconciled",async()=>{
  const h=harness({prior:{id:executionId,payload:{type:"SMS",contactId:"synthetic-provider-id",message:draft.body,toNumber:draft.recipient}}});
  const r=await h.send(owner,command(),randomUUID());
  expect(h.prior).toHaveBeenCalledWith(expect.anything(),contactId,taskSendRequestId(taskId,1));expect(h.reconcile).toHaveBeenCalledWith(executionId,undefined,owner.id,h.provider,expect.anything(),expect.objectContaining({source:"operations"}));
  expect(h.execute).not.toHaveBeenCalled();expect(h.service.sendReadiness).not.toHaveBeenCalled();expect(h.provider.getContact).not.toHaveBeenCalled();
  expect(r).toMatchObject({ok:true,sent:true,delivered:false,duplicatePrevented:true,completion:null});
 });
 it("pending verification and failed delivery are reported without completion",async()=>{
  const pending=harness({execute:{ok:false,error:"message_verification_pending",executionId,messageId:"synthetic-message"}});expect(await pending.send(owner,command(),randomUUID())).toMatchObject({ok:true,sent:true,verification:"pending",delivered:false,completion:null});expect(pending.service.execute).not.toHaveBeenCalled();
  const failed=harness({execute:{ok:false,status:"undelivered",executionId,messageId:"synthetic-message",delivered:false}});await expect(failed.send(owner,command(),randomUUID())).rejects.toMatchObject({code:"message_delivery_failed",status:409});expect(failed.service.execute).not.toHaveBeenCalled();
  const stale=harness({execute:{ok:true,status:"delivered",delivered:true,executionId,verificationFresh:false}});expect(await stale.send(owner,command(),randomUUID())).toMatchObject({delivered:true,verificationFresh:false,completion:null});expect(stale.service.execute).not.toHaveBeenCalled();
 });
 it("a message already mirrored locally is not rewritten on a later read-back",async()=>{const h=harness({mirror:true});expect(await h.send(owner,command(),randomUUID())).toMatchObject({delivered:true,mirrored:true,completion:{ok:true}});expect(h.persist).not.toHaveBeenCalled();});
 it("a mirror or completion failure never turns a verified send into an error",async()=>{
  const h=harness();h.persist.mockRejectedValueOnce(new Error("Lead not found"));h.service.execute.mockRejectedValueOnce(new OperationsError("message_approval_context_changed_or_expired",409));
  expect(await h.send(owner,command(),randomUUID())).toMatchObject({ok:true,sent:true,delivered:true,mirrored:false,completion:{ok:false,error:"message_approval_context_changed_or_expired"}});
 });
});
