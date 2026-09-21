import {createHash} from "node:crypto";
import {and,desc,eq,gte,inArray,isNull,or,sql} from "drizzle-orm";
import {getDb,schema} from "@egc/database";
type Db=ReturnType<typeof getDb>;
type Provider={sendMessage:(payload:any)=>Promise<Record<string,unknown>>;getMessage:(id:string)=>Promise<Record<string,unknown>>;getEmailMessage?:(id:string)=>Promise<Record<string,unknown>>};
const text=(v:unknown)=>typeof v==="string"?v:null;
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const bodyDigest=(body:string)=>createHash("sha256").update(body).digest("hex");
async function readProviderMessage(provider:Provider,id:string,payload:Record<string,unknown>):Promise<Record<string,unknown>>{
  const response=await provider.getMessage(id),message=record(response.message??response);
  if(payload.type==="SMS")return {...message,fromNumber:message.fromNumber??message.from,toNumber:message.toNumber??message.to};
  if(message.emailTo!==undefined)return message;
  const meta=record(record(message.meta).email),ids=meta.messageIds??record(meta.email).messageIds;
  if(!provider.getEmailMessage||!Array.isArray(ids)||ids.length!==1||typeof ids[0]!=="string")return message;
  const result=await provider.getEmailMessage(ids[0]),email=record(result.email??result);
  if(email.id!==ids[0]||email.threadId!==id||email.contactId!==message.contactId||email.conversationId!==message.conversationId||email.direction!==message.direction||email.body!==message.body||!Array.isArray(email.to)||email.to.length!==1)throw new Error("email_evidence_mismatch");
  return {...message,subject:email.subject,emailTo:email.to[0],emailFrom:email.from,status:email.status,dateAdded:email.dateAdded};
}
function channelMatches(message:Record<string,unknown>,expected:unknown) {
  const channel=String(message.messageType??message.type??"").toLowerCase();
  return expected==="SMS"?["sms","type_sms","2"].includes(channel):["email","type_email","3"].includes(channel);
}
function messageMatches(message:Record<string,unknown>,payload:Record<string,unknown>,id:string){
  if(!channelMatches(message,payload.type)||message.id!==id||message.contactId!==payload.contactId||message.body!==payload.message||message.direction!=="outbound")return false;
  // Explicit recipient/sender/subject constraints cannot be certified solely by
  // matching the contact and body. Missing provider evidence stays pending.
  return ["subject","emailFrom","emailTo","fromNumber","toNumber"].every(key=>payload[key]===null||payload[key]===undefined||message[key]===payload[key]);
}
const failedStatuses=new Set(["failed","undelivered","cancelled","canceled","bounced","rejected"]);
const acceptedStatuses=new Set(["queued","pending","scheduled","sent","delivered","read","opened","clicked"]);
async function pendingReceipt(db:Db,id:string,error:string){
  await db.update(schema.communicationExecutions).set({status:"unknown",lastError:error,updatedAt:new Date()}).where(and(eq(schema.communicationExecutions.id,id),inArray(schema.communicationExecutions.status,["in_flight","unknown"])));
  const [latest]=await db.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,id)).limit(1);
  return latest&&["accepted","failed"].includes(latest.status)?{ok:latest.status==="accepted",...latest.response,executionId:id,duplicatePrevented:true,verificationFresh:false}:null;
}
export async function executeCommunication(input:{requestId:string;actorId:string;contactId:string;payload:Record<string,unknown>;duplicateWindowMinutes?:number},provider:Provider,db:Db=getDb()) {
  const payload={type:input.payload.type,contactId:input.payload.contactId,message:input.payload.message,subject:input.payload.subject??null,emailFrom:input.payload.emailFrom??null,emailTo:input.payload.emailTo??null,fromNumber:input.payload.fromNumber??null,toNumber:input.payload.toNumber??null};
  const hash=createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const claim=await db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`message:${input.contactId}`},0))`);
    const [prior]=await tx.select().from(schema.communicationExecutions).where(and(eq(schema.communicationExecutions.actorId,input.actorId),eq(schema.communicationExecutions.requestId,input.requestId))).limit(1);
    if(prior){if(prior.payloadHash!==hash||prior.contactId!==input.contactId)throw new Error("message_request_conflict");return {row:prior,created:false};}
    const [duplicate]=await tx.select().from(schema.communicationExecutions).where(and(eq(schema.communicationExecutions.contactId,input.contactId),eq(schema.communicationExecutions.payloadHash,hash),or(inArray(schema.communicationExecutions.status,["in_flight","unknown"]),gte(schema.communicationExecutions.createdAt,new Date(Date.now()-(input.duplicateWindowMinutes??10)*60000))))).orderBy(desc(schema.communicationExecutions.createdAt)).limit(1);
    if(duplicate)return {row:duplicate,created:false};
    const [row]=await tx.insert(schema.communicationExecutions).values({requestId:input.requestId,actorId:input.actorId,contactId:input.contactId,channel:String(payload.type),payloadHash:hash,payload}).returning();
    if(!row)throw new Error("message_claim_failed");
    await tx.insert(schema.auditLogs).values({actor:input.actorId,action:"communication.authorized",entity:"communication_execution",entityId:row.id,newValue:{contactId:input.contactId,channel:payload.type,payloadHash:hash},source:"mcp"});
    return {row,created:true};
  });
  let messageId=claim.row.providerMessageId;
  if(claim.created) {
    try {
      const response=await provider.sendMessage(Object.fromEntries(Object.entries(payload).filter(([,v])=>v!==null)));
      messageId=text(response.messageId)??text(record(response.message).id);
      if(!messageId)throw new Error("message_ack_missing_id");
      // Record the provider ID before read-back. A crash after this write recovers by
      // that exact ID; a crash before it remains explicitly unknown, never resends.
      const [bound]=await db.update(schema.communicationExecutions).set({providerMessageId:messageId,updatedAt:new Date()}).where(and(eq(schema.communicationExecutions.id,claim.row.id),or(isNull(schema.communicationExecutions.providerMessageId),eq(schema.communicationExecutions.providerMessageId,messageId)))).returning({id:schema.communicationExecutions.id});
      if(!bound)throw new Error("message_provider_id_conflict");
    }catch {
      const verified=await pendingReceipt(db,claim.row.id,"provider_write_outcome_unknown");if(verified)return verified;
      return {ok:false,error:"message_outcome_unknown",executionId:claim.row.id,retryMode:"reconcile_only",requestId:input.requestId};
    }
  }
  if(!messageId)return {ok:false,error:"message_outcome_unknown",executionId:claim.row.id,retryMode:"reconcile_only",requestId:input.requestId};
  const readStartedAt=new Date();
  try {
    const message=await readProviderMessage(provider,messageId,payload);
    const status=text(message.status)?.toLowerCase()??"unknown";
    if(!messageMatches(message,payload,messageId)||!failedStatuses.has(status)&&!acceptedStatuses.has(status))throw new Error("message_readback_mismatch");
    const failed=failedStatuses.has(status);
    const occurred=Date.parse(String(message.dateAdded??""));
    const receipt={messageId,conversationId:text(message.conversationId),status,delivered:["delivered","read","opened","clicked"].includes(status),verifiedAt:new Date().toISOString(),matchEvidence:{version:1,channel:payload.type==="SMS"?"sms":"email",recipient:text(payload.type==="SMS"?message.toNumber:message.emailTo),subject:text(message.subject)??"",bodyHash:bodyDigest(String(message.body)),occurredAt:Number.isFinite(occurred)?new Date(occurred).toISOString():null,payloadHash:hash}};
    const effective=await db.transaction(async tx=>{
      const [latest]=await tx.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,claim.row.id)).for("update");
      if(!latest||latest.providerMessageId!==messageId)throw new Error("message_provider_id_conflict");
      if(latest.response&&latest.verifiedAt&&(latest.verifiedAt>readStartedAt||latest.response.delivered===true&&!receipt.delivered))return {ok:latest.status==="accepted",...latest.response,executionId:latest.id,duplicatePrevented:true,verificationFresh:false};
      await tx.update(schema.communicationExecutions).set({status:failed?"failed":"accepted",response:receipt,lastError:failed?"provider_delivery_failed":null,verifiedAt:new Date(),updatedAt:new Date()}).where(eq(schema.communicationExecutions.id,claim.row.id));
      await tx.insert(schema.auditLogs).values({actor:input.actorId,action:"communication.provider_verified",entity:"communication_execution",entityId:claim.row.id,newValue:receipt,source:"mcp"});
      return null;
    });
    if(effective)return effective;
    return {ok:!failed,...receipt,executionId:claim.row.id,duplicatePrevented:!claim.created,providerMessage:message};
  }catch {
    const verified=await pendingReceipt(db,claim.row.id,"provider_readback_unavailable");if(verified)return verified;
    return {ok:false,error:"message_verification_pending",executionId:claim.row.id,messageId,retryMode:"reconcile_only",requestId:input.requestId};
  }
}

export async function reconcileCommunication(executionId:string,providerMessageId:string|undefined,actorId:string,provider:Provider,db:Db=getDb()) {
  const [row]=await db.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,executionId)).limit(1);
  if(!row)return {ok:false,error:"communication_execution_not_found"};
  if(providerMessageId && row.providerMessageId && providerMessageId!==row.providerMessageId)return {ok:false,error:"provider_message_id_conflict"};
  if(providerMessageId&&!row.providerMessageId) {
    let message:Record<string,unknown>;
    try {message=await readProviderMessage(provider,providerMessageId,row.payload);}catch{return {ok:false,error:"provider_readback_unavailable"};}
    const at=Date.parse(String(message.dateAdded??""));
    if(!messageMatches(message,row.payload,providerMessageId)||!Number.isFinite(at)||at<row.createdAt.valueOf()-1000||at>row.createdAt.valueOf()+120000)return {ok:false,error:"message_reconciliation_evidence_mismatch"};
    await db.transaction(async tx=>{
      const [locked]=await tx.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,row.id)).for("update");
      if(!locked||locked.providerMessageId&&locked.providerMessageId!==providerMessageId)throw new Error("message_reconciliation_conflict");
      await tx.update(schema.communicationExecutions).set({providerMessageId,updatedAt:new Date()}).where(eq(schema.communicationExecutions.id,row.id));
      await tx.insert(schema.auditLogs).values({actor:actorId,action:"communication.reconciled_by_provider_id",entity:"communication_execution",entityId:row.id,newValue:{providerMessageId},source:"mcp"});
    });
  }
  return executeCommunication({requestId:row.requestId,actorId:row.actorId,contactId:row.contactId,payload:row.payload},provider,db);
}
